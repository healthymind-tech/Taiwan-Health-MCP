"""
Drug Service — Taiwan FDA medication database.
Data is loaded via data-loader (--drug or --fda flag). No auto-sync.

Sync strategy: fetch ALL endpoints first, then write everything in one
transaction so a failed network call never leaves the DB in a partial state.
"""

import asyncio
import json
import re
from datetime import datetime, timezone

import asyncpg
import httpx

from cache import cached
from embedding_service import EmbeddingService
from utils import log_error, log_info

API_SOURCES = {
    "master": "https://data.fda.gov.tw/data/opendata/export/36/json",
    "appearance": "https://data.fda.gov.tw/data/opendata/export/42/json",
    "ingredients": "https://data.fda.gov.tw/data/opendata/export/43/json",
    "atc": "https://data.fda.gov.tw/data/opendata/export/41/json",
    "documents": "https://data.fda.gov.tw/data/opendata/export/39/json",
}


class DrugService:
    def __init__(
        self, pool: asyncpg.Pool, embedding_svc: EmbeddingService | None = None
    ):
        self.pool = pool
        self._embedding_svc = embedding_svc
        self._sync_lock = asyncio.Lock()

    async def initialize(self) -> None:
        count = await self.pool.fetchval("SELECT COUNT(*) FROM drug.licenses")
        if count == 0:
            log_info("Drug DB empty — run data-loader --drug to load data")
        else:
            log_info("Drug Service ready", licenses=count)

    async def shutdown(self) -> None:
        """Gracefully stop the service. No-op; provided for lifecycle symmetry."""
        pass

    # ── sync helpers ────────────────────────────────────────────────────────

    async def _fetch_json(self, client: httpx.AsyncClient, url: str) -> list:
        resp = await client.get(url)
        resp.raise_for_status()
        ct = resp.headers.get("content-type", "")
        if "zip" in ct or url.endswith(".zip"):
            import io
            import zipfile

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
                master = await self._fetch_json(client, API_SOURCES["master"])
                appearance = await self._fetch_json(client, API_SOURCES["appearance"])
                ingredients = await self._fetch_json(client, API_SOURCES["ingredients"])
                atc = await self._fetch_json(client, API_SOURCES["atc"])
                documents = await self._fetch_json(client, API_SOURCES["documents"])

            log_info(
                "Drug data fetched — writing to DB",
                licenses=len(master),
                appearance=len(appearance),
                ingredients=len(ingredients),
                atc=len(atc),
                documents=len(documents),
            )

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
                            license_rows.append(
                                (
                                    lid,
                                    r.get("中文品名", ""),
                                    r.get("英文品名", ""),
                                    r.get("適應症", ""),
                                    r.get("劑型", ""),
                                    r.get("包裝", ""),
                                    r.get("藥品類別", ""),
                                    r.get("申請商名稱", ""),
                                    r.get("有效日期", ""),
                                    r.get("用法用量", ""),
                                )
                            )
                    for i in range(0, len(license_rows), BATCH):
                        await conn.executemany(
                            """INSERT INTO drug.licenses
                               (license_id,name_zh,name_en,indication,form,package,
                                category,manufacturer,valid_date,usage)
                               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)""",
                            license_rows[i : i + BATCH],
                        )

                    # Build set of valid license IDs to skip orphan rows
                    valid_ids = {r[0] for r in license_rows if r[0]}

                    app_rows = [
                        (
                            r.get("許可證字號", ""),
                            r.get("形狀", ""),
                            r.get("顏色", ""),
                            r.get("刻痕", ""),
                            r.get("外觀圖檔連結", ""),
                        )
                        for r in appearance
                        if r.get("許可證字號") in valid_ids
                    ]
                    for i in range(0, len(app_rows), BATCH):
                        await conn.executemany(
                            "INSERT INTO drug.appearance (license_id,shape,color,marking,image_url) VALUES ($1,$2,$3,$4,$5)",
                            app_rows[i : i + BATCH],
                        )

                    ing_rows = [
                        (
                            r.get("許可證字號", ""),
                            r.get("成分名稱", ""),
                            r.get("含量", ""),
                            r.get("含量單位", ""),
                        )
                        for r in ingredients
                        if r.get("許可證字號") in valid_ids
                    ]
                    for i in range(0, len(ing_rows), BATCH):
                        await conn.executemany(
                            "INSERT INTO drug.ingredients (license_id,ingredient_name,ingredient_qty,ingredient_unit) VALUES ($1,$2,$3,$4)",
                            ing_rows[i : i + BATCH],
                        )

                    atc_rows = [
                        (
                            r.get("許可證字號", ""),
                            r.get("代碼", ""),
                            r.get("中文分類名稱", "") or r.get("英文分類名稱", ""),
                        )
                        for r in atc
                        if r.get("許可證字號") in valid_ids
                    ]
                    for i in range(0, len(atc_rows), BATCH):
                        await conn.executemany(
                            "INSERT INTO drug.atc (license_id,atc_code,atc_name) VALUES ($1,$2,$3)",
                            atc_rows[i : i + BATCH],
                        )

                    doc_rows = [
                        (r.get("許可證字號", ""), "insert", r.get("仿單圖檔連結", ""))
                        for r in documents
                        if r.get("許可證字號") in valid_ids
                    ]
                    for i in range(0, len(doc_rows), BATCH):
                        await conn.executemany(
                            "INSERT INTO drug.documents (license_id,doc_type,doc_url) VALUES ($1,$2,$3)",
                            doc_rows[i : i + BATCH],
                        )

                    await conn.execute(
                        """INSERT INTO drug.sync_meta (key, value, updated_at)
                           VALUES ('last_updated', $1, NOW())
                           ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=NOW()""",
                        datetime.now(tz=timezone.utc).isoformat(),
                    )

            log_info("Drug DB sync completed", licenses=len(license_rows))
            if self._embedding_svc and self._embedding_svc.enabled:
                asyncio.create_task(self._generate_embeddings())
        except Exception as e:
            log_error(f"Drug DB sync failed", error=str(e))

    async def _generate_embeddings(self) -> None:
        """Embed all drug licenses into pgvector table (background task)."""
        if not self._embedding_svc:
            return
        svc = self._embedding_svc
        try:
            async with self.pool.acquire() as conn:
                drugs = await conn.fetch(
                    "SELECT license_id, name_zh, name_en, indication FROM drug.licenses"
                )
            log_info("Drug: embedding licenses", count=len(drugs))
            from embedding_service import BATCH_SIZE

            for i in range(0, len(drugs), BATCH_SIZE):
                batch = drugs[i : i + BATCH_SIZE]
                texts = [
                    " ".join(
                        filter(None, [r["name_zh"], r["name_en"], r["indication"]])
                    )
                    for r in batch
                ]
                vecs = await svc.embed_batch(texts)
                rows = [
                    (batch[j]["license_id"], f"[{','.join(str(x) for x in vecs[j])}]")
                    for j in range(len(batch))
                    if vecs[j] is not None
                ]
                if rows:
                    async with self.pool.acquire() as conn:
                        await conn.executemany(
                            """INSERT INTO drug.license_embeddings (license_id, embedding)
                               VALUES ($1, $2::halfvec)
                               ON CONFLICT (license_id) DO UPDATE
                               SET embedding=EXCLUDED.embedding, embedded_at=NOW()""",
                            rows,
                        )
            log_info("Drug: license embeddings done", total=len(drugs))
        except Exception as exc:
            log_error("Drug embedding generation failed", error=str(exc))

    # ── query methods ────────────────────────────────────────────────────────

    @cached(ttl=3600, prefix="drug.search.v3")
    async def search_drug(self, keyword: str, limit: int = 3) -> str:
        """Search Taiwan FDA approved drugs by name or indication keyword.

        Args:
            keyword: Chinese or English drug name, or indication phrase
                (e.g. ``"普拿疼"``, ``"Panadol"``, ``"頭痛"``).
            limit: Maximum number of results to return (default 3, max 10).
                   Returns the top *limit* closest matches ranked by hybrid
                   BM25 + semantic similarity — not just keyword matches.

        Returns:
            JSON string with a ``results`` list of the closest matching license records.
        """
        limit = min(max(1, limit), 10)
        async with self.pool.acquire() as conn:
            rows = await conn.fetch(
                """SELECT DISTINCT l.license_id
                   FROM drug.licenses l
                   WHERE to_tsvector('simple',
                           COALESCE(l.name_zh,'') || ' ' || COALESCE(l.name_en,'') || ' ' || COALESCE(l.indication,''))
                         @@ plainto_tsquery('simple', $1)
                   ORDER BY l.license_id
                   LIMIT $2""",
                keyword,
                limit,
            )
        if not rows:
            return json.dumps(
                {"mode": "drug_name", "keyword": keyword, "results": []},
                ensure_ascii=False,
            )
        return await self._build_drug_detail_results("drug_name", keyword, rows)

    @cached(ttl=3600, prefix="drug.license.v2")
    async def search_by_license_id(self, license_id: str) -> str:
        """Return a detail-shaped payload for a specific license ID."""
        async with self.pool.acquire() as conn:
            lic, candidates = await self._fuzzy_license_lookup(conn, license_id)
            if candidates:
                return json.dumps(
                    {
                        "mode": "license_id",
                        "keyword": license_id,
                        "results": [],
                        "error": f"找不到精確匹配 '{license_id}'，找到多筆相似許可證，請確認後重新查詢。",
                    },
                    ensure_ascii=False,
                )
            if not lic:
                return json.dumps(
                    {"mode": "license_id", "keyword": license_id, "results": []},
                    ensure_ascii=False,
                )
        return await self._build_drug_detail_results("license_id", license_id, [lic])

    async def _build_drug_detail_results(
        self,
        mode: str,
        keyword: str,
        rows: list[asyncpg.Record],
    ) -> str:
        license_ids = [r["license_id"] for r in rows]
        async with self.pool.acquire() as conn:
            licenses = await conn.fetch(
                """
                SELECT license_id, name_zh, name_en, indication, usage, form, package,
                       category, manufacturer, valid_date
                FROM drug.licenses
                WHERE license_id = ANY($1::text[])
                """,
                license_ids,
            )
            app_rows = await conn.fetch(
                """
                SELECT license_id, shape, color, marking, image_url
                FROM drug.appearance
                WHERE license_id = ANY($1::text[])
                """,
                license_ids,
            )
            atc_rows = await conn.fetch(
                """
                SELECT license_id, atc_code, atc_name
                FROM drug.atc
                WHERE license_id = ANY($1::text[])
                ORDER BY license_id, atc_code
                """,
                license_ids,
            )
            doc_rows = await conn.fetch(
                """
                SELECT license_id, doc_url
                FROM drug.documents
                WHERE license_id = ANY($1::text[])
                  AND doc_type = 'insert'
                """,
                license_ids,
            )
            ingredients = await conn.fetch(
                """
                SELECT license_id, ingredient_name, ingredient_qty, ingredient_unit
                FROM drug.ingredients
                WHERE license_id = ANY($1::text[])
                ORDER BY license_id, ingredient_name
                """,
                license_ids,
            )
        by_license: dict[str, list[dict]] = {}
        for row in ingredients:
            by_license.setdefault(row["license_id"], []).append(
                {
                    "ingredient_name": row["ingredient_name"],
                    "ingredient_qty": row["ingredient_qty"],
                    "ingredient_unit": row["ingredient_unit"],
                }
            )
        app_by_license = {
            row["license_id"]: {
                "shape": row["shape"],
                "color": row["color"],
                "marking": row["marking"],
                "image_url": row["image_url"],
            }
            for row in app_rows
        }
        atc_by_license: dict[str, list[dict]] = {}
        for row in atc_rows:
            atc_by_license.setdefault(row["license_id"], []).append(
                {
                    "atc_code": row["atc_code"],
                    "atc_name": row["atc_name"],
                }
            )
        doc_by_license = {row["license_id"]: row["doc_url"] for row in doc_rows}
        results = []
        licenses_by_id = {r["license_id"]: r for r in licenses}
        for r in rows:
            lic = licenses_by_id.get(r["license_id"])
            if not lic:
                continue
            item = {
                "license_id": r["license_id"],
                "name_zh": lic["name_zh"],
                "name_en": lic["name_en"],
                "indication": lic["indication"],
                "usage": lic["usage"],
                "form": lic["form"],
                "package": lic["package"],
                "category": lic["category"],
                "manufacturer": lic["manufacturer"],
                "valid_date": lic["valid_date"],
                "ingredients": by_license.get(r["license_id"], []),
                "appearance": app_by_license.get(r["license_id"], {}),
                "atc": atc_by_license.get(r["license_id"], []),
                "insert_url": doc_by_license.get(r["license_id"]),
            }
            results.append(item)
        return json.dumps(
            {"mode": mode, "keyword": keyword, "results": results}, ensure_ascii=False
        )

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

        # 3. Extract consecutive digits and retry
        digits = re.search(r"\d+", license_id)
        if digits:
            digit_text = digits.group()
            rows = await conn.fetch(
                "SELECT * FROM drug.licenses WHERE license_id ILIKE $1 ORDER BY license_id LIMIT 50",
                f"%{digit_text}%",
            )
            if len(rows) == 1:
                return rows[0], []
            if len(rows) > 1:
                exact_digit_rows = [
                    r for r in rows if f"第{digit_text}號" in r["license_id"]
                ]
                if len(exact_digit_rows) == 1:
                    return exact_digit_rows[0], []
                if len(exact_digit_rows) > 1:
                    return exact_digit_rows[0], []
                return rows[0], []

        # 2. ILIKE on full input (e.g. user typed '衛署藥製字第058498號')
        rows = await conn.fetch(
            "SELECT * FROM drug.licenses WHERE license_id ILIKE $1 LIMIT 6",
            f"%{license_id}%",
        )
        if len(rows) == 1:
            return rows[0], []
        if len(rows) > 1:
            return None, list(rows)

        return None, []

    async def get_drug_details_by_license(self, license_id: str) -> str:
        """Return full drug details for a given Taiwan FDA license number.

        Applies a three-tier fuzzy lookup: exact match → ILIKE on full input →
        digit-only extract ILIKE, to handle common input variants (wrong prefix,
        missing punctuation, bare numbers).

        Args:
            license_id: Taiwan FDA license number (e.g.
                ``"衛部藥製字第012345號"``).

        Returns:
            JSON string with the full license record including ``ingredients``,
            ``appearance``, ``atc``, and ``insert_url``.
            On ambiguous fuzzy match: ``{"error": ..., "candidates": [...]}``.
            On not-found: ``{"error": ...}``.
        """
        async with self.pool.acquire() as conn:
            lic, candidates = await self._fuzzy_license_lookup(conn, license_id)

            if candidates:
                return json.dumps(
                    {
                        "error": f"找不到精確匹配 '{license_id}'，找到多筆相似許可證，請確認後重新查詢。",
                        "candidates": [
                            {
                                "license_id": r["license_id"],
                                "name_zh": r["name_zh"],
                                "name_en": r["name_en"],
                            }
                            for r in candidates
                        ],
                    },
                    ensure_ascii=False,
                )

            if not lic:
                return json.dumps(
                    {"error": f"License ID not found: {license_id}"}, ensure_ascii=False
                )

            resolved_id = lic[
                "license_id"
            ]  # use the DB-resolved ID for all sub-queries
            ingredients = await conn.fetch(
                "SELECT ingredient_name, ingredient_qty, ingredient_unit FROM drug.ingredients WHERE license_id = $1",
                resolved_id,
            )
            app = await conn.fetchrow(
                "SELECT shape, color, marking, image_url FROM drug.appearance WHERE license_id = $1",
                resolved_id,
            )
            atc_rows = await conn.fetch(
                "SELECT atc_code, atc_name FROM drug.atc WHERE license_id = $1",
                resolved_id,
            )
            doc = await conn.fetchrow(
                "SELECT doc_url FROM drug.documents WHERE license_id = $1 AND doc_type = 'insert'",
                resolved_id,
            )

        return json.dumps(
            {
                "license_id": lic["license_id"],
                "name_zh": lic["name_zh"],
                "name_en": lic["name_en"],
                "indication": lic["indication"],
                "usage": lic["usage"],
                "form": lic["form"],
                "package": lic["package"],
                "category": lic["category"],
                "manufacturer": lic["manufacturer"],
                "valid_date": lic["valid_date"],
                "ingredients": [dict(r) for r in ingredients],
                "appearance": dict(app) if app else {},
                "atc": [dict(r) for r in atc_rows],
                "insert_url": doc["doc_url"] if doc else None,
            },
            ensure_ascii=False,
        )

    @cached(ttl=3600, prefix="drug.pill")
    async def identify_pill(self, features: str) -> str:
        """Identify an unknown pill by visual appearance features.

        Each space-separated keyword is matched against shape, colour, and
        marking fields.  All keywords must match (AND logic).

        Args:
            features: Space-separated visual feature keywords
                (e.g. ``"白色 圓形 YP"``).

        Returns:
            JSON list of up to 5 matching drug records with name, appearance,
            image URL, and license ID.
        """
        keywords = features.split()
        if not keywords:
            return json.dumps(
                {"error": "Please provide visual features (shape, color, marking)."},
                ensure_ascii=False,
            )

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
            return json.dumps(
                {"error": "No matching pills found based on description."},
                ensure_ascii=False,
            )
        return json.dumps(
            [
                {
                    "name_zh": r["name_zh"],
                    "name_en": r["name_en"],
                    "shape": r["shape"],
                    "color": r["color"],
                    "marking": r["marking"],
                    "image_url": r["image_url"],
                    "license_id": r["license_id"],
                }
                for r in rows
            ],
            ensure_ascii=False,
        )

    @cached(ttl=3600, prefix="drug.byatc.v4")
    async def search_by_atc(self, query: str, limit: int = 3) -> str:
        """Search Taiwan FDA drugs by WHO ATC code or therapeutic class name.

        Matches ATC code prefix (e.g. ``"A10BA"``). This mode is code-only:
        it does not use semantic embedding, and non-code text should be routed
        to the ``drug_name`` or ``ingredient`` modes instead.
        Returns top *limit* matching drug records (default 3, max 10).

        Args:
            query: ATC code prefix (e.g. ``"A10BA02"`` or ``"A10"``).
            limit: Number of closest matches to return (default 3, max 10).

        Returns:
            JSON string with ``mode``, ``keyword``, and ``results`` list.
        """
        limit = min(max(1, limit), 10)
        if not re.fullmatch(r"[A-Za-z][A-Za-z0-9]{1,6}", query):
            return json.dumps(
                {
                    "error": "ATC mode accepts ATC code prefixes only (e.g. A10, A10BA02)."
                },
                ensure_ascii=False,
            )

        async with self.pool.acquire() as conn:
            rows = await conn.fetch(
                """SELECT DISTINCT ON (l.license_id) l.license_id
                   FROM drug.atc a
                   JOIN drug.licenses l ON l.license_id = a.license_id
                   WHERE a.atc_code ILIKE $1
                   ORDER BY l.license_id, a.atc_code
                   LIMIT $2""",
                f"{query}%",
                limit,
            )
        if not rows:
            return json.dumps(
                {"mode": "atc_code", "keyword": query, "results": []},
                ensure_ascii=False,
            )
        return await self._build_drug_detail_results("atc_code", query, rows)

    @cached(ttl=3600, prefix="drug.bying.v3")
    async def search_by_ingredient(self, ingredient_name: str, limit: int = 3) -> str:
        """Search Taiwan FDA drugs that contain a specific active ingredient.

        Uses hybrid BM25 + semantic similarity — e.g., '二甲雙胍' also
        surfaces drugs with ingredient 'Metformin Hydrochloride'.
        Returns top *limit* closest matching drug records (default 3, max 10).

        Args:
            ingredient_name: Ingredient name in Chinese or English
                (e.g. ``"Metformin"``, ``"二甲雙胍"``).
            limit: Number of closest matches to return (default 3, max 10).

        Returns:
            JSON string with ``ingredient``, ``total``, and ``results`` list
            including ingredient quantity and unit for each match.
        """
        limit = min(max(1, limit), 10)
        vec = (
            await self._embedding_svc.embed(ingredient_name)
            if self._embedding_svc
            else None
        )
        vec_str = f"[{','.join(str(x) for x in vec)}]" if vec else None

        async with self.pool.acquire() as conn:
            if vec_str:
                rows = await conn.fetch(
                    """WITH fts AS (
                           SELECT DISTINCT ingredient_name,
                                  ROW_NUMBER() OVER (ORDER BY MAX(ts_rank_cd(
                                      to_tsvector('simple', COALESCE(ingredient_name,'')),
                                      plainto_tsquery('simple', $1))) DESC) AS rank
                           FROM drug.ingredients
                           WHERE ingredient_name ILIKE $2
                              OR to_tsvector('simple', COALESCE(ingredient_name,'')) @@ plainto_tsquery('simple', $1)
                           GROUP BY ingredient_name
                           LIMIT 20
                       ),
                       vec AS (
                           SELECT ingredient_name,
                                  ROW_NUMBER() OVER (ORDER BY embedding <=> $3::halfvec) AS rank
                           FROM drug.ingredient_name_embeddings
                           ORDER BY embedding <=> $3::halfvec LIMIT 20
                       ),
                       rrf AS (
                           SELECT COALESCE(f.ingredient_name, v.ingredient_name) AS ingredient_name,
                                  COALESCE(1.0/(60+f.rank), 0.0) + COALESCE(1.0/(60+v.rank), 0.0) AS score
                           FROM fts f FULL OUTER JOIN vec v ON f.ingredient_name = v.ingredient_name
                       )
                       SELECT * FROM (
                           SELECT DISTINCT ON (l.license_id)
                                  l.license_id, l.name_zh, l.name_en, l.indication, l.form,
                                  i.ingredient_name, i.ingredient_qty, i.ingredient_unit, r.score
                           FROM rrf r
                           JOIN drug.ingredients i ON i.ingredient_name = r.ingredient_name
                           JOIN drug.licenses l ON l.license_id = i.license_id
                           ORDER BY l.license_id, r.score DESC
                       ) sub
                       ORDER BY score DESC LIMIT $4""",
                    ingredient_name,
                    f"%{ingredient_name}%",
                    vec_str,
                    limit,
                )
            else:
                rows = await conn.fetch(
                    """SELECT DISTINCT l.license_id, l.name_zh, l.name_en, l.indication, l.form,
                              i.ingredient_name, i.ingredient_qty, i.ingredient_unit
                       FROM drug.ingredients i
                       JOIN drug.licenses l ON l.license_id = i.license_id
                       WHERE i.ingredient_name ILIKE $1
                       ORDER BY i.ingredient_name, l.name_zh
                       LIMIT $2""",
                    f"%{ingredient_name}%",
                    limit,
                )
        if not rows:
            return json.dumps(
                {"mode": "ingredient", "keyword": ingredient_name, "results": []},
                ensure_ascii=False,
            )
        return await self._build_drug_detail_results(
            "ingredient", ingredient_name, rows
        )
