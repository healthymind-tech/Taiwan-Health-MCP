"""
Health Food Service — Taiwan FDA approved health foods.
Syncs from FDA Open Data every Monday via APScheduler.

Sync strategy: fetch data first, then write in one transaction.
"""

import asyncio
import json
from datetime import datetime, timedelta, timezone

import asyncpg
import httpx
from apscheduler.schedulers.asyncio import AsyncIOScheduler

from cache import cached
from utils import log_error, log_info

API_SOURCE = "https://data.fda.gov.tw/data/opendata/export/19/json"

STALE_AFTER_DAYS = 7

DISEASE_BENEFIT_MAPPING = {
    "E11": ["調節血糖", "延緩血糖上升"],
    "E10": ["調節血糖", "延緩血糖上升"],
    "E78": ["調節血脂", "不易形成體脂肪"],
    "E66": ["不易形成體脂肪", "調節血脂"],
    "E79": ["調節尿酸"],
    "I10": ["調節血脂", "心血管保健"],
    "I25": ["調節血脂", "心血管保健"],
    "I21": ["調節血脂", "心血管保健"],
    "K70": ["護肝"], "K71": ["護肝"], "K72": ["護肝"],
    "K73": ["護肝"], "K74": ["護肝"], "K76": ["護肝"],
    "M80": ["骨質保健", "促進鈣吸收"],
    "M81": ["骨質保健", "促進鈣吸收"],
    "M15": ["關節保健"], "M17": ["關節保健"],
    "K59": ["胃腸功能改善", "促進腸道有益菌增生"],
    "K29": ["胃腸功能改善"], "K21": ["胃腸功能改善"],
    "D84": ["免疫調節"], "J06": ["免疫調節"],
    "H52": ["護眼保健", "調節視覺"], "H53": ["護眼保健"],
    "N40": ["促進泌尿道保健"], "N39": ["促進泌尿道保健"],
    "K02": ["牙齒保健", "促進釋放齒垢"], "K05": ["牙齒保健"],
    "L70": ["調節免疫", "皮膚保健"],
}


class HealthFoodService:
    def __init__(self, pool: asyncpg.Pool):
        self.pool = pool
        self._scheduler = AsyncIOScheduler()
        self._sync_lock = asyncio.Lock()

    async def initialize(self) -> None:
        count = await self.pool.fetchval("SELECT COUNT(*) FROM health_food.items")
        if count == 0:
            log_info("Health food DB empty — starting initial sync")
            asyncio.create_task(self._sync())
        else:
            last = await self._get_last_synced()
            if last is None or (datetime.now(tz=timezone.utc) - last).days >= STALE_AFTER_DAYS:
                log_info("Health food DB stale — starting background sync")
                asyncio.create_task(self._sync())
            else:
                log_info("Health Food Service ready", items=count)

        if not self._scheduler.running:
            self._scheduler.add_job(self._sync, "cron", day_of_week="mon", hour=2, minute=30)
            self._scheduler.start()

    async def shutdown(self) -> None:
        self._scheduler.shutdown(wait=False)

    async def _get_last_synced(self) -> datetime | None:
        row = await self.pool.fetchrow(
            "SELECT value FROM health_food.sync_meta WHERE key = 'last_updated'"
        )
        if row:
            try:
                return datetime.fromisoformat(row["value"])
            except ValueError:
                pass
        return None

    async def _sync(self) -> None:
        if self._sync_lock.locked():
            log_info("Health food sync already in progress — skipping duplicate run")
            return
        async with self._sync_lock:
            await self._do_sync()

    async def _do_sync(self) -> None:
        log_info("Health food sync started")
        try:
            # Step 1: fetch data
            async with httpx.AsyncClient(timeout=60) as client:
                resp = await client.get(API_SOURCE)
                resp.raise_for_status()
                ct = resp.headers.get("content-type", "")
                if "zip" in ct:
                    import io, zipfile
                    zf = zipfile.ZipFile(io.BytesIO(resp.content))
                    names = [n for n in zf.namelist() if n.endswith(".json")]
                    data = json.loads(zf.read(names[0])) if names else []
                else:
                    data = resp.json()

            # Step 2: write atomically
            rows = [
                (r.get("許可證字號",""), r.get("中文品名",""), r.get("申請商",""),
                 r.get("保健功效",""), r.get("核可日期",""), "",
                 r.get("類別",""))
                for r in data
            ]

            BATCH = 2000
            async with self.pool.acquire() as conn:
                async with conn.transaction():
                    await conn.execute("TRUNCATE health_food.items")
                    for i in range(0, len(rows), BATCH):
                        await conn.executemany(
                            """INSERT INTO health_food.items
                               (permit_no, name, applicant, benefit_claims, valid_from, valid_to, category)
                               VALUES ($1,$2,$3,$4,$5,$6,$7)""",
                            rows[i:i+BATCH],
                        )
                    await conn.execute(
                        """INSERT INTO health_food.sync_meta (key, value, updated_at)
                           VALUES ('last_updated', $1, NOW())
                           ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=NOW()""",
                        datetime.now(tz=timezone.utc).isoformat(),
                    )
            log_info("Health food sync completed", items=len(rows))
        except Exception as e:
            log_error("Health food sync failed", error=str(e))

    # ── query methods ────────────────────────────────────────────────────────

    @cached(ttl=3600, prefix="hf.search")
    async def search_health_food(self, keyword: str) -> str:
        async with self.pool.acquire() as conn:
            rows = await conn.fetch(
                """SELECT permit_no, name, category, benefit_claims, applicant, valid_from
                   FROM health_food.items
                   WHERE to_tsvector('simple', COALESCE(name,'') || ' ' || COALESCE(benefit_claims,''))
                         @@ plainto_tsquery('simple', $1)
                   LIMIT 10""",
                keyword,
            )
        if not rows:
            return json.dumps({"error": f"找不到與 '{keyword}' 相關的健康食品。", "results": []}, ensure_ascii=False)
        return json.dumps({"results": [dict(r) for r in rows]}, ensure_ascii=False)

    @cached(ttl=3600, prefix="hf.details")
    async def get_health_food_details(self, permit_no: str) -> str:
        async with self.pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT * FROM health_food.items WHERE permit_no = $1", permit_no
            )
        if not row:
            return json.dumps({"error": f"找不到許可證字號: {permit_no}"}, ensure_ascii=False)
        return json.dumps(dict(row), ensure_ascii=False)

    async def analyze_health_support_for_condition(
        self, diagnosis_keyword: str, icd_service=None
    ) -> str:
        icd_code = diagnosis_keyword.strip().upper().split(".")[0] if diagnosis_keyword else None
        recommended_benefits = DISEASE_BENEFIT_MAPPING.get(icd_code, [diagnosis_keyword])

        foods: list[dict] = []
        async with self.pool.acquire() as conn:
            for benefit in recommended_benefits:
                rows = await conn.fetch(
                    """SELECT permit_no, name, benefit_claims FROM health_food.items
                       WHERE to_tsvector('simple', COALESCE(benefit_claims,''))
                             @@ plainto_tsquery('simple', $1)
                       LIMIT 5""",
                    benefit,
                )
                foods.extend([dict(r) for r in rows])

        # Deduplicate by permit_no
        seen: set[str] = set()
        unique_foods = []
        for f in foods:
            if f["permit_no"] not in seen:
                seen.add(f["permit_no"])
                unique_foods.append(f)

        return json.dumps(
            {
                "icd_code": icd_code,
                "recommended_benefits": recommended_benefits,
                "health_foods": unique_foods,
                "disclaimer": "健康食品僅供輔助保健，不可取代醫療。使用前請諮詢醫師。",
            },
            ensure_ascii=False,
        )
