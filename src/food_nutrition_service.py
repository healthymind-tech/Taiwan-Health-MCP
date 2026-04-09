"""
Food Nutrition Service — Taiwan FDA food composition database.
Data is loaded via data-loader (--food-nutrition or --fda flag). No auto-sync.

Sync strategy: fetch both endpoints first, then write in one transaction.
"""

import asyncio
import json
from datetime import datetime, timezone

import asyncpg
import httpx

from cache import cached
from embedding_service import EmbeddingService
from utils import log_error, log_info

API_SOURCES = {
    "nutrition":   "https://data.fda.gov.tw/data/opendata/export/20/json",
    "ingredients": "https://data.fda.gov.tw/data/opendata/export/4/json",
}


class FoodNutritionService:
    def __init__(self, pool: asyncpg.Pool, embedding_svc: EmbeddingService | None = None):
        self.pool = pool
        self._embedding_svc = embedding_svc
        self._sync_lock = asyncio.Lock()

    async def initialize(self) -> None:
        count = await self.pool.fetchval("SELECT COUNT(*) FROM food_nutrition.measurements")
        if count == 0:
            log_info("Food nutrition DB empty — run data-loader --food-nutrition to load data")
        else:
            log_info("Food Nutrition Service ready", measurements=count)

    async def shutdown(self) -> None:
        pass

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
            if self._embedding_svc and self._embedding_svc.enabled:
                asyncio.create_task(self._generate_embeddings())
        except Exception as e:
            log_error("Food nutrition sync failed", error=str(e))

    async def _generate_embeddings(self) -> None:
        """Embed all unique foods and ingredients into pgvector tables (background task)."""
        if not self._embedding_svc:
            return
        svc = self._embedding_svc
        try:
            async with self.pool.acquire() as conn:
                foods = await conn.fetch(
                    """SELECT DISTINCT ON (sample_name) sample_name, common_name, english_name
                       FROM food_nutrition.measurements ORDER BY sample_name"""
                )
            log_info("Food nutrition: embedding foods", count=len(foods))
            from embedding_service import BATCH_SIZE
            for i in range(0, len(foods), BATCH_SIZE):
                batch = foods[i:i + BATCH_SIZE]
                texts = [
                    " ".join(filter(None, [r["sample_name"], r["common_name"], r["english_name"]]))
                    for r in batch
                ]
                vecs = await svc.embed_batch(texts)
                rows = [
                    (batch[j]["sample_name"], f"[{','.join(str(x) for x in vecs[j])}]")
                    for j in range(len(batch)) if vecs[j] is not None
                ]
                if rows:
                    async with self.pool.acquire() as conn:
                        await conn.executemany(
                            """INSERT INTO food_nutrition.food_embeddings (sample_name, embedding)
                               VALUES ($1, $2::vector)
                               ON CONFLICT (sample_name) DO UPDATE
                               SET embedding=EXCLUDED.embedding, embedded_at=NOW()""",
                            rows,
                        )
            log_info("Food nutrition: food embeddings done", total=len(foods))

            # Ingredient embeddings
            async with self.pool.acquire() as conn:
                ings = await conn.fetch("SELECT id, name_zh, name_en FROM food_nutrition.ingredients")
            for i in range(0, len(ings), BATCH_SIZE):
                batch = ings[i:i + BATCH_SIZE]
                texts = [
                    " ".join(filter(None, [r["name_zh"], r["name_en"]])) for r in batch
                ]
                vecs = await svc.embed_batch(texts)
                rows = [
                    (batch[j]["id"], f"[{','.join(str(x) for x in vecs[j])}]")
                    for j in range(len(batch)) if vecs[j] is not None
                ]
                if rows:
                    async with self.pool.acquire() as conn:
                        await conn.executemany(
                            """INSERT INTO food_nutrition.ingredient_embeddings (id, embedding)
                               VALUES ($1, $2::vector)
                               ON CONFLICT (id) DO UPDATE
                               SET embedding=EXCLUDED.embedding, embedded_at=NOW()""",
                            rows,
                        )
            log_info("Food nutrition: ingredient embeddings done", total=len(ings))
        except Exception as exc:
            log_error("Food nutrition embedding generation failed", error=str(exc))

    # ── query methods ────────────────────────────────────────────────────────

    @cached(ttl=86400, prefix="fn.search")
    async def search_nutrition(self, food_name: str, nutrient: str | None = None) -> str:
        vec = await self._embedding_svc.embed(food_name) if self._embedding_svc else None
        vec_str = f"[{','.join(str(x) for x in vec)}]" if vec else None

        async with self.pool.acquire() as conn:
            # Resolve the best-matching sample_names via hybrid RRF (or pure FTS fallback)
            if vec_str:
                matched = await conn.fetch(
                    """WITH fts AS (
                           SELECT DISTINCT m.sample_name,
                                  ROW_NUMBER() OVER (ORDER BY ts_rank_cd(
                                      to_tsvector('simple', COALESCE(m.sample_name,'') || ' ' ||
                                                            COALESCE(m.common_name,'') || ' ' ||
                                                            COALESCE(m.english_name,'')),
                                      plainto_tsquery('simple', $1)) DESC) AS rank
                           FROM food_nutrition.measurements m
                           WHERE to_tsvector('simple',
                                   COALESCE(m.sample_name,'') || ' ' ||
                                   COALESCE(m.common_name,'') || ' ' ||
                                   COALESCE(m.english_name,''))
                                 @@ plainto_tsquery('simple', $1)
                           LIMIT 20
                       ),
                       vec AS (
                           SELECT sample_name,
                                  ROW_NUMBER() OVER (ORDER BY embedding <=> $2::vector) AS rank
                           FROM food_nutrition.food_embeddings
                           ORDER BY embedding <=> $2::vector LIMIT 20
                       ),
                       rrf AS (
                           SELECT COALESCE(f.sample_name, v.sample_name) AS sample_name,
                                  COALESCE(1.0/(60+f.rank), 0.0) + COALESCE(1.0/(60+v.rank), 0.0) AS score
                           FROM fts f FULL OUTER JOIN vec v ON f.sample_name = v.sample_name
                       )
                       SELECT sample_name FROM rrf ORDER BY score DESC LIMIT 10""",
                    food_name, vec_str,
                )
            else:
                matched = await conn.fetch(
                    """SELECT DISTINCT sample_name FROM food_nutrition.measurements
                       WHERE to_tsvector('simple',
                               COALESCE(sample_name,'') || ' ' || COALESCE(common_name,'') || ' ' || COALESCE(english_name,''))
                             @@ plainto_tsquery('simple', $1)
                       LIMIT 10""",
                    food_name,
                )

            if not matched:
                return json.dumps({"error": f"找不到 '{food_name}' 的營養資料。"}, ensure_ascii=False)

            names = [r["sample_name"] for r in matched]
            if nutrient:
                rows = await conn.fetch(
                    """SELECT sample_name, common_name, nutrient_item, content_per_100g, content_unit, food_category
                       FROM food_nutrition.measurements
                       WHERE sample_name = ANY($1) AND nutrient_item ILIKE $2
                       LIMIT 20""",
                    names, f"%{nutrient}%",
                )
            else:
                rows = await conn.fetch(
                    """SELECT sample_name, common_name, nutrient_item, content_per_100g, content_unit, food_category
                       FROM food_nutrition.measurements
                       WHERE sample_name = ANY($1)
                       LIMIT 50""",
                    names,
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
        vec = await self._embedding_svc.embed(keyword) if self._embedding_svc else None
        vec_str = f"[{','.join(str(x) for x in vec)}]" if vec else None

        async with self.pool.acquire() as conn:
            if vec_str:
                rows = await conn.fetch(
                    """WITH fts AS (
                           SELECT i.id,
                                  ROW_NUMBER() OVER (ORDER BY ts_rank_cd(
                                      to_tsvector('simple', COALESCE(i.name_zh,'') || ' ' || COALESCE(i.name_en,'')),
                                      plainto_tsquery('simple', $1)) DESC) AS rank
                           FROM food_nutrition.ingredients i
                           WHERE to_tsvector('simple', COALESCE(i.name_zh,'') || ' ' || COALESCE(i.name_en,''))
                                 @@ plainto_tsquery('simple', $1)
                           LIMIT 20
                       ),
                       vec AS (
                           SELECT id,
                                  ROW_NUMBER() OVER (ORDER BY embedding <=> $2::vector) AS rank
                           FROM food_nutrition.ingredient_embeddings
                           ORDER BY embedding <=> $2::vector LIMIT 20
                       ),
                       rrf AS (
                           SELECT COALESCE(f.id, v.id) AS id,
                                  COALESCE(1.0/(60+f.rank), 0.0) + COALESCE(1.0/(60+v.rank), 0.0) AS score
                           FROM fts f FULL OUTER JOIN vec v ON f.id = v.id
                       )
                       SELECT i.name_zh, i.name_en, i.major_category, i.sub_category, i.note
                       FROM rrf JOIN food_nutrition.ingredients i ON i.id = rrf.id
                       ORDER BY rrf.score DESC LIMIT 20""",
                    keyword, vec_str,
                )
            else:
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
