"""
Food Nutrition Service — Taiwan FDA food composition database.
Syncs from FDA Open Data every Monday via APScheduler.

Sync strategy: fetch both endpoints first, then write in one transaction.
"""

import asyncio
import json
from datetime import datetime, timedelta, timezone

import asyncpg
import httpx
from apscheduler.schedulers.asyncio import AsyncIOScheduler

from cache import cached
from utils import log_error, log_info

API_SOURCES = {
    "nutrition":   "https://data.fda.gov.tw/data/opendata/export/20/json",
    "ingredients": "https://data.fda.gov.tw/data/opendata/export/4/json",
}

STALE_AFTER_DAYS = 7


class FoodNutritionService:
    def __init__(self, pool: asyncpg.Pool):
        self.pool = pool
        self._scheduler = AsyncIOScheduler()
        self._sync_lock = asyncio.Lock()

    async def initialize(self) -> None:
        count = await self.pool.fetchval("SELECT COUNT(*) FROM food_nutrition.measurements")
        if count == 0:
            log_info("Food nutrition DB empty — starting initial sync")
            asyncio.create_task(self._sync())
        else:
            last = await self._get_last_synced()
            if last is None or (datetime.now(tz=timezone.utc) - last).days >= STALE_AFTER_DAYS:
                log_info("Food nutrition DB stale — syncing")
                asyncio.create_task(self._sync())
            else:
                log_info("Food Nutrition Service ready", measurements=count)

        if not self._scheduler.running:
            self._scheduler.add_job(self._sync, "cron", day_of_week="mon", hour=3, minute=0)
            self._scheduler.start()

    async def shutdown(self) -> None:
        self._scheduler.shutdown(wait=False)

    async def _get_last_synced(self) -> datetime | None:
        row = await self.pool.fetchrow(
            "SELECT value FROM food_nutrition.sync_meta WHERE key = 'last_updated'"
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
        if "zip" in ct:
            import io, zipfile
            zf = zipfile.ZipFile(io.BytesIO(resp.content))
            names = [n for n in zf.namelist() if n.endswith(".json")]
            return json.loads(zf.read(names[0])) if names else []
        return resp.json()

    async def _sync(self) -> None:
        if self._sync_lock.locked():
            log_info("Food nutrition sync already in progress — skipping duplicate run")
            return
        async with self._sync_lock:
            await self._do_sync()

    async def _do_sync(self) -> None:
        log_info("Food nutrition sync started")
        try:
            # Step 1: fetch both endpoints
            async with httpx.AsyncClient(timeout=60) as client:
                nutrition_data   = await self._fetch_json(client, API_SOURCES["nutrition"])
                ingredients_data = await self._fetch_json(client, API_SOURCES["ingredients"])

            measurement_rows = [
                (r.get("食品分類",""), r.get("樣品名稱",""), r.get("俗名",""),
                 r.get("樣品英文名稱",""), r.get("分析項",""),
                 str(r.get("每100克含量","")), r.get("含量單位",""),
                 r.get("分析項分類",""))
                for r in nutrition_data
            ]
            ingredient_rows = [
                (r.get("中文名稱",""), r.get("英文名稱",""), r.get("大分類",""),
                 r.get("次分類",""), r.get("備註",""))
                for r in ingredients_data
            ]

            # Step 2: write atomically
            BATCH = 5000
            async with self.pool.acquire() as conn:
                async with conn.transaction():
                    await conn.execute("TRUNCATE food_nutrition.ingredients, food_nutrition.measurements")

                    for i in range(0, len(measurement_rows), BATCH):
                        await conn.executemany(
                            """INSERT INTO food_nutrition.measurements
                               (food_category, sample_name, common_name, english_name,
                                nutrient_item, content_per_100g, content_unit, nutrient_category)
                               VALUES ($1,$2,$3,$4,$5,$6,$7,$8)""",
                            measurement_rows[i:i+BATCH],
                        )

                    for i in range(0, len(ingredient_rows), BATCH):
                        await conn.executemany(
                            """INSERT INTO food_nutrition.ingredients
                               (name_zh, name_en, major_category, sub_category, note)
                               VALUES ($1,$2,$3,$4,$5)""",
                            ingredient_rows[i:i+BATCH],
                        )

                    await conn.execute(
                        """INSERT INTO food_nutrition.sync_meta (key, value, updated_at)
                           VALUES ('last_updated', $1, NOW())
                           ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=NOW()""",
                        datetime.now(tz=timezone.utc).isoformat(),
                    )
            log_info("Food nutrition sync completed",
                     measurements=len(measurement_rows), ingredients=len(ingredient_rows))
        except Exception as e:
            log_error("Food nutrition sync failed", error=str(e))

    # ── query methods ────────────────────────────────────────────────────────

    @cached(ttl=86400, prefix="fn.search")
    async def search_nutrition(self, food_name: str, nutrient: str | None = None) -> str:
        async with self.pool.acquire() as conn:
            if nutrient:
                rows = await conn.fetch(
                    """SELECT sample_name, common_name, nutrient_item, content_per_100g, content_unit, food_category
                       FROM food_nutrition.measurements
                       WHERE to_tsvector('simple', COALESCE(sample_name,'') || ' ' || COALESCE(common_name,''))
                             @@ plainto_tsquery('simple', $1)
                         AND nutrient_item ILIKE $2
                       LIMIT 20""",
                    food_name, f"%{nutrient}%",
                )
            else:
                rows = await conn.fetch(
                    """SELECT sample_name, common_name, nutrient_item, content_per_100g, content_unit, food_category
                       FROM food_nutrition.measurements
                       WHERE to_tsvector('simple',
                               COALESCE(sample_name,'') || ' ' || COALESCE(common_name,'') || ' ' || COALESCE(english_name,''))
                             @@ plainto_tsquery('simple', $1)
                       LIMIT 30""",
                    food_name,
                )

        if not rows:
            return json.dumps({"error": f"找不到 '{food_name}' 的營養資料。"}, ensure_ascii=False)

        foods: dict[str, dict] = {}
        for r in rows:
            key = f"{r['sample_name']} ({r['common_name']})" if r["common_name"] else r["sample_name"]
            if key not in foods:
                foods[key] = {"category": r["food_category"], "nutrients": []}
            foods[key]["nutrients"].append(
                {"item": r["nutrient_item"], "value": r["content_per_100g"], "unit": r["content_unit"]}
            )

        return json.dumps([{"food": k, **v} for k, v in foods.items()], ensure_ascii=False)

    @cached(ttl=86400, prefix="fn.detail")
    async def get_detailed_nutrition(self, food_name: str) -> str:
        async with self.pool.acquire() as conn:
            rows = await conn.fetch(
                """SELECT sample_name, common_name, food_category, nutrient_category,
                          nutrient_item, content_per_100g, content_unit
                   FROM food_nutrition.measurements
                   WHERE sample_name ILIKE $1 OR common_name ILIKE $1
                   ORDER BY nutrient_category, nutrient_item""",
                f"%{food_name}%",
            )
        if not rows:
            return json.dumps({"error": f"找不到 '{food_name}' 的詳細營養資料。"}, ensure_ascii=False)
        return json.dumps([dict(r) for r in rows], ensure_ascii=False)

    @cached(ttl=86400, prefix="fn.ing")
    async def search_food_ingredient(self, keyword: str) -> str:
        async with self.pool.acquire() as conn:
            rows = await conn.fetch(
                """SELECT name_zh, name_en, major_category, sub_category, note
                   FROM food_nutrition.ingredients
                   WHERE to_tsvector('simple', COALESCE(name_zh,'') || ' ' || COALESCE(name_en,''))
                         @@ plainto_tsquery('simple', $1)
                   LIMIT 20""",
                keyword,
            )
        if not rows:
            return json.dumps({"error": f"找不到與 '{keyword}' 相關的食品原料。"}, ensure_ascii=False)
        return json.dumps([dict(r) for r in rows], ensure_ascii=False)

    @cached(ttl=86400, prefix="fn.cat")
    async def get_ingredients_by_category(self, category: str) -> str:
        async with self.pool.acquire() as conn:
            rows = await conn.fetch(
                """SELECT name_zh, name_en, major_category, sub_category
                   FROM food_nutrition.ingredients
                   WHERE major_category ILIKE $1 OR sub_category ILIKE $1
                   LIMIT 50""",
                f"%{category}%",
            )
        if not rows:
            return json.dumps({"error": f"找不到分類 '{category}' 的原料資料。"}, ensure_ascii=False)
        return json.dumps([dict(r) for r in rows], ensure_ascii=False)

    @cached(ttl=86400, prefix="fn.bynutrient")
    async def search_foods_by_nutrient(self, nutrient: str, limit: int = 20) -> str:
        """Find foods ranked by content of a specific nutrient (per 100g)."""
        async with self.pool.acquire() as conn:
            # Find matching nutrient items first
            nutrient_items = await conn.fetch(
                """SELECT DISTINCT nutrient_item FROM food_nutrition.measurements
                   WHERE nutrient_item ILIKE $1 LIMIT 10""",
                f"%{nutrient}%",
            )
            if not nutrient_items:
                return json.dumps(
                    {"error": f"找不到營養素 '{nutrient}'。請嘗試中文名稱，如：蛋白質、鈣、鐵、維生素C"},
                    ensure_ascii=False,
                )

            matched_nutrient = nutrient_items[0]["nutrient_item"]
            rows = await conn.fetch(
                """SELECT sample_name, common_name, food_category, nutrient_item,
                          content_per_100g, content_unit
                   FROM food_nutrition.measurements
                   WHERE nutrient_item = $1
                     AND TRIM(content_per_100g) ~ '^[0-9]+[.]?[0-9]*$'
                   ORDER BY CAST(TRIM(content_per_100g) AS FLOAT) DESC
                   LIMIT $2""",
                matched_nutrient, min(limit, 50),
            )

        return json.dumps(
            {
                "nutrient": matched_nutrient,
                "unit": rows[0]["content_unit"] if rows else "",
                "total": len(rows),
                "note": "數值為每 100 克含量",
                "foods": [
                    {"name": r["sample_name"],
                     "common_name": r["common_name"],
                     "category": r["food_category"],
                     "content_per_100g": r["content_per_100g"],
                     "unit": r["content_unit"]}
                    for r in rows
                ],
            },
            ensure_ascii=False,
        )

    async def analyze_meal_nutrition(self, foods: list[str]) -> str:
        totals: dict[str, float] = {}
        details: dict[str, list] = {}

        async with self.pool.acquire() as conn:
            for food in foods:
                rows = await conn.fetch(
                    """SELECT nutrient_item, content_per_100g, content_unit
                       FROM food_nutrition.measurements
                       WHERE sample_name ILIKE $1 OR common_name ILIKE $1
                       LIMIT 20""",
                    f"%{food}%",
                )
                details[food] = [dict(r) for r in rows]
                for r in rows:
                    try:
                        val = float(r["content_per_100g"])
                        totals[r["nutrient_item"]] = totals.get(r["nutrient_item"], 0) + val
                    except (ValueError, TypeError):
                        pass

        return json.dumps(
            {"meal_components": details, "combined_totals_per_100g_each": totals},
            ensure_ascii=False,
        )
