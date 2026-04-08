"""
Drug Service — Taiwan FDA medication database.
Data is synced from FDA Open Data API and stored in PostgreSQL.
Sync runs on startup (if stale) and every Tuesday via APScheduler.

Sync strategy: fetch ALL endpoints first, then write everything in one
transaction so a failed network call never leaves the DB in a partial state.
"""

import asyncio
import json
import re
from datetime import datetime, timedelta, timezone

import asyncpg
import httpx
from apscheduler.schedulers.asyncio import AsyncIOScheduler

from cache import cached
from utils import log_error, log_info

API_SOURCES = {
    "master":      "https://data.fda.gov.tw/data/opendata/export/36/json",
    "appearance":  "https://data.fda.gov.tw/data/opendata/export/42/json",
    "ingredients": "https://data.fda.gov.tw/data/opendata/export/43/json",
    "atc":         "https://data.fda.gov.tw/data/opendata/export/41/json",
    "documents":   "https://data.fda.gov.tw/data/opendata/export/39/json",
}

STALE_AFTER_DAYS = 7


class DrugService:
    def __init__(self, pool: asyncpg.Pool):
        self.pool = pool
        self._scheduler = AsyncIOScheduler()
        self._sync_lock = asyncio.Lock()

    async def initialize(self) -> None:
        count = await self.pool.fetchval("SELECT COUNT(*) FROM drug.licenses")
        if count == 0:
            log_info("Drug DB empty — starting initial sync in background")
            asyncio.create_task(self._sync_all())
        else:
            last = await self._get_last_synced()
            if last is None or (datetime.now(tz=timezone.utc) - last).days >= STALE_AFTER_DAYS:
                log_info("Drug DB stale — starting background sync")
                asyncio.create_task(self._sync_all())
            else:
                log_info(f"Drug Service ready", licenses=count)

        if not self._scheduler.running:
            self._scheduler.add_job(self._sync_all, "cron", day_of_week="tue", hour=2, minute=0)
            self._scheduler.start()

    async def shutdown(self) -> None:
        self._scheduler.shutdown(wait=False)

    # ── sync helpers ────────────────────────────────────────────────────────

    async def _get_last_synced(self) -> datetime | None:
        row = await self.pool.fetchrow(
            "SELECT value FROM drug.sync_meta WHERE key = 'last_updated'"
        )
        if row:
            try:
                return datetime.fromisoformat(row["value"])
            except ValueError:
                pass
        return None

    async def _fetch_json(self, client: httpx.AsyncClient, url: str) -> list:
        resp = await client.get(url)
        resp.raise_for_status()
        ct = resp.headers.get("content-type", "")
        if "zip" in ct or url.endswith(".zip"):
            import io, zipfile
            zf = zipfile.ZipFile(io.BytesIO(resp.content))
            names = [n for n in zf.namelist() if n.endswith(".json")]
            return json.loads(zf.read(names[0])) if names else []
        return resp.json()

    async def _sync_all(self) -> None:
        if self._sync_lock.locked():
            log_info("Drug DB sync already in progress — skipping duplicate run")
            return
        async with self._sync_lock:
            await self._do_sync()

    async def _do_sync(self) -> None:
        log_info("Drug DB sync started — fetching all endpoints")
        try:
            # Step 1: fetch ALL data before touching the database
            async with httpx.AsyncClient(timeout=120) as client:
                master      = await self._fetch_json(client, API_SOURCES["master"])
                appearance  = await self._fetch_json(client, API_SOURCES["appearance"])
                ingredients = await self._fetch_json(client, API_SOURCES["ingredients"])
                atc         = await self._fetch_json(client, API_SOURCES["atc"])
                documents   = await self._fetch_json(client, API_SOURCES["documents"])

            log_info("Drug data fetched — writing to DB",
                     licenses=len(master), appearance=len(appearance),
                     ingredients=len(ingredients), atc=len(atc), documents=len(documents))

            # Step 2: write everything atomically
            async with self.pool.acquire() as conn:
                async with conn.transaction():
                    await conn.execute(
                        "TRUNCATE drug.documents, drug.atc, drug.ingredients, drug.appearance, drug.licenses"
                    )

                    BATCH = 2000
                    # Deduplicate by license_id — FDA source occasionally has duplicate rows
                    seen_ids: set[str] = set()
                    license_rows = []
                    for r in master:
                        lid = r.get("許可證字號", "")
                        if lid and lid not in seen_ids:
                            seen_ids.add(lid)
                            license_rows.append((
                                lid, r.get("中文品名",""), r.get("英文品名",""),
                                r.get("適應症",""), r.get("劑型",""), r.get("包裝",""),
                                r.get("藥品類別",""), r.get("申請商名稱",""), r.get("有效日期",""),
                                r.get("用法用量",""),
                            ))
                    for i in range(0, len(license_rows), BATCH):
                        await conn.executemany(
                            """INSERT INTO drug.licenses
                               (license_id,name_zh,name_en,indication,form,package,
                                category,manufacturer,valid_date,usage)
                               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)""",
                            license_rows[i:i+BATCH],
                        )

                    # Build set of valid license IDs to skip orphan rows
                    valid_ids = {r[0] for r in license_rows if r[0]}

                    app_rows = [
                        (r.get("許可證字號",""), r.get("形狀",""), r.get("顏色",""),
                         r.get("刻痕",""), r.get("外觀圖檔連結",""))
                        for r in appearance if r.get("許可證字號") in valid_ids
                    ]
                    for i in range(0, len(app_rows), BATCH):
                        await conn.executemany(
                            "INSERT INTO drug.appearance (license_id,shape,color,marking,image_url) VALUES ($1,$2,$3,$4,$5)",
                            app_rows[i:i+BATCH],
                        )

                    ing_rows = [
                        (r.get("許可證字號",""), r.get("成分名稱",""), r.get("含量",""), r.get("含量單位",""))
                        for r in ingredients if r.get("許可證字號") in valid_ids
                    ]
                    for i in range(0, len(ing_rows), BATCH):
                        await conn.executemany(
                            "INSERT INTO drug.ingredients (license_id,ingredient_name,ingredient_qty,ingredient_unit) VALUES ($1,$2,$3,$4)",
                            ing_rows[i:i+BATCH],
                        )

                    atc_rows = [
                        (r.get("許可證字號",""), r.get("代碼",""),
                         r.get("中文分類名稱","") or r.get("英文分類名稱",""))
                        for r in atc if r.get("許可證字號") in valid_ids
                    ]
                    for i in range(0, len(atc_rows), BATCH):
                        await conn.executemany(
                            "INSERT INTO drug.atc (license_id,atc_code,atc_name) VALUES ($1,$2,$3)",
                            atc_rows[i:i+BATCH],
                        )

                    doc_rows = [
                        (r.get("許可證字號",""), "insert", r.get("仿單圖檔連結",""))
                        for r in documents if r.get("許可證字號") in valid_ids
                    ]
                    for i in range(0, len(doc_rows), BATCH):
                        await conn.executemany(
                            "INSERT INTO drug.documents (license_id,doc_type,doc_url) VALUES ($1,$2,$3)",
                            doc_rows[i:i+BATCH],
                        )

                    await conn.execute(
                        """INSERT INTO drug.sync_meta (key, value, updated_at)
                           VALUES ('last_updated', $1, NOW())
                           ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=NOW()""",
                        datetime.now(tz=timezone.utc).isoformat(),
                    )

            log_info("Drug DB sync completed", licenses=len(license_rows))
        except Exception as e:
            log_error(f"Drug DB sync failed", error=str(e))

    # ── query methods ────────────────────────────────────────────────────────

    @cached(ttl=3600, prefix="drug.search")
    async def search_drug(self, keyword: str) -> str:
        async with self.pool.acquire() as conn:
            rows = await conn.fetch(
                """SELECT license_id, name_zh, name_en, indication, category
                   FROM drug.licenses
                   WHERE to_tsvector('simple',
                           COALESCE(name_zh,'') || ' ' || COALESCE(name_en,'') || ' ' || COALESCE(indication,''))
                         @@ plainto_tsquery('simple', $1)
                   LIMIT 8""",
                keyword,
            )
        if not rows:
            return json.dumps({"error": f"No results found for '{keyword}'.", "results": []}, ensure_ascii=False)
        return json.dumps({"results": [dict(r) for r in rows]}, ensure_ascii=False)

    @cached(ttl=3600, prefix="drug.details")
    async def _fuzzy_license_lookup(self, conn, license_id: str):
        """
        Resolve a license_id with three-tier fallback:
          1. Exact match
          2. ILIKE '%<input>%'  (handles wrong prefix like 衛署→衛部, or partial string)
          3. Digits-only extract → ILIKE '%<digits>%'  (handles bare numbers like '058498')
        Returns (record_or_None, candidates_list).
        candidates is non-empty only when multiple fuzzy hits are found and we cannot
        auto-resolve — caller should surface them to the user.
        """
        # 1. Exact
        lic = await conn.fetchrow(
            "SELECT * FROM drug.licenses WHERE license_id = $1", license_id
        )
        if lic:
            return lic, []

        # 2. ILIKE on full input (e.g. user typed '衛署藥製字第058498號')
        rows = await conn.fetch(
            "SELECT * FROM drug.licenses WHERE license_id ILIKE $1 LIMIT 6",
            f"%{license_id}%",
        )
        if len(rows) == 1:
            return rows[0], []
        if len(rows) > 1:
            return None, list(rows)

        # 3. Extract consecutive digits and retry
        digits = re.search(r"\d+", license_id)
        if digits:
            rows = await conn.fetch(
                "SELECT * FROM drug.licenses WHERE license_id ILIKE $1 LIMIT 6",
                f"%{digits.group()}%",
            )
            if len(rows) == 1:
                return rows[0], []
            if len(rows) > 1:
                return None, list(rows)

        return None, []

    async def get_drug_details_by_license(self, license_id: str) -> str:
        async with self.pool.acquire() as conn:
            lic, candidates = await self._fuzzy_license_lookup(conn, license_id)

            if candidates:
                return json.dumps(
                    {
                        "error": f"找不到精確匹配 '{license_id}'，找到多筆相似許可證，請確認後重新查詢。",
                        "candidates": [
                            {"license_id": r["license_id"], "name_zh": r["name_zh"], "name_en": r["name_en"]}
                            for r in candidates
                        ],
                    },
                    ensure_ascii=False,
                )

            if not lic:
                return json.dumps({"error": f"License ID not found: {license_id}"}, ensure_ascii=False)

            resolved_id = lic["license_id"]   # use the DB-resolved ID for all sub-queries
            ingredients = await conn.fetch(
                "SELECT ingredient_name, ingredient_qty, ingredient_unit FROM drug.ingredients WHERE license_id = $1",
                resolved_id,
            )
            app = await conn.fetchrow(
                "SELECT shape, color, marking, image_url FROM drug.appearance WHERE license_id = $1",
                resolved_id,
            )
            atc_rows = await conn.fetch(
                "SELECT atc_code, atc_name FROM drug.atc WHERE license_id = $1", resolved_id
            )
            doc = await conn.fetchrow(
                "SELECT doc_url FROM drug.documents WHERE license_id = $1 AND doc_type = 'insert'",
                resolved_id,
            )

        return json.dumps(
            {
                "license_id": lic["license_id"],
                "name_zh":    lic["name_zh"],
                "name_en":    lic["name_en"],
                "indication": lic["indication"],
                "usage":      lic["usage"],
                "form":       lic["form"],
                "package":    lic["package"],
                "category":   lic["category"],
                "manufacturer": lic["manufacturer"],
                "valid_date": lic["valid_date"],
                "ingredients": [dict(r) for r in ingredients],
                "appearance":  dict(app) if app else {},
                "atc":         [dict(r) for r in atc_rows],
                "insert_url":  doc["doc_url"] if doc else None,
            },
            ensure_ascii=False,
        )

    @cached(ttl=3600, prefix="drug.pill")
    async def identify_pill(self, features: str) -> str:
        keywords = features.split()
        if not keywords:
            return json.dumps({"error": "Please provide visual features (shape, color, marking)."}, ensure_ascii=False)

        conditions = " AND ".join(
            f"(shape ILIKE ${i*3+1} OR color ILIKE ${i*3+2} OR marking ILIKE ${i*3+3})"
            for i in range(len(keywords))
        )
        params = []
        for k in keywords:
            params.extend([f"%{k}%", f"%{k}%", f"%{k}%"])

        async with self.pool.acquire() as conn:
            rows = await conn.fetch(
                f"""SELECT l.name_zh, l.name_en, a.shape, a.color, a.marking, a.image_url, l.license_id
                    FROM drug.appearance a
                    JOIN drug.licenses l ON a.license_id = l.license_id
                    WHERE {conditions}
                    LIMIT 5""",
                *params,
            )
        if not rows:
            return json.dumps({"error": "No matching pills found based on description."}, ensure_ascii=False)
        return json.dumps(
            [{"name_zh": r["name_zh"], "name_en": r["name_en"],
              "shape": r["shape"], "color": r["color"], "marking": r["marking"],
              "image_url": r["image_url"], "license_id": r["license_id"]} for r in rows],
            ensure_ascii=False,
        )

    @cached(ttl=3600, prefix="drug.byatc")
    async def search_by_atc(self, query: str) -> str:
        """Search drugs by ATC code or therapeutic class name."""
        async with self.pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT DISTINCT l.license_id, l.name_zh, l.name_en, l.indication, l.category,
                       a.atc_code, a.atc_name
                FROM drug.atc a
                JOIN drug.licenses l ON l.license_id = a.license_id
                WHERE a.atc_code ILIKE $1
                   OR to_tsvector('simple', COALESCE(a.atc_name,'')) @@ plainto_tsquery('simple', $2)
                ORDER BY a.atc_code, l.name_zh
                LIMIT 20
                """,
                f"{query}%", query,
            )
        if not rows:
            return json.dumps(
                {"error": f"找不到與 ATC '{query}' 相關的藥品。", "results": []},
                ensure_ascii=False,
            )
        return json.dumps(
            {"query": query, "total": len(rows),
             "results": [dict(r) for r in rows]},
            ensure_ascii=False,
        )

    @cached(ttl=3600, prefix="drug.bying")
    async def search_by_ingredient(self, ingredient_name: str) -> str:
        """Search drugs containing a specific ingredient."""
        async with self.pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT DISTINCT l.license_id, l.name_zh, l.name_en, l.indication, l.form,
                       i.ingredient_name, i.ingredient_qty, i.ingredient_unit
                FROM drug.ingredients i
                JOIN drug.licenses l ON l.license_id = i.license_id
                WHERE i.ingredient_name ILIKE $1
                ORDER BY i.ingredient_name, l.name_zh
                LIMIT 20
                """,
                f"%{ingredient_name}%",
            )
        if not rows:
            return json.dumps(
                {"error": f"找不到含有 '{ingredient_name}' 成分的藥品。", "results": []},
                ensure_ascii=False,
            )
        return json.dumps(
            {"ingredient": ingredient_name, "total": len(rows),
             "results": [dict(r) for r in rows]},
            ensure_ascii=False,
        )
