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
    "nutrition": "https://data.fda.gov.tw/data/opendata/export/20/json",
    "ingredients": "https://data.fda.gov.tw/data/opendata/export/4/json",
}

# Common synonym → exact DB nutrient_item name
_NUTRIENT_ALIASES: dict[str, str] = {
    # Protein
    "蛋白質": "粗蛋白",
    "蛋白": "粗蛋白",
    "protein": "粗蛋白",
    # Fat
    "脂肪": "粗脂肪",
    "油脂": "粗脂肪",
    "fat": "粗脂肪",
    # Carbohydrate
    "碳水": "總碳水化合物",
    "碳水化合物": "總碳水化合物",
    "carbohydrate": "總碳水化合物",
    "carb": "總碳水化合物",
    # Fiber
    "纖維": "膳食纖維",
    "fiber": "膳食纖維",
    "fibre": "膳食纖維",
    # Calories
    "卡路里": "熱量",
    "calories": "熱量",
    "calorie": "熱量",
    "kcal": "熱量",
    # Vitamins (維他命 is Taiwanese, 維生素 is Mandarin)
    "維他命a": "維生素A",
    "vitamin a": "維生素A",
    "維他命b1": "維生素B1",
    "vitamin b1": "維生素B1",
    "硫胺素": "維生素B1",
    "維他命b2": "維生素B2",
    "vitamin b2": "維生素B2",
    "核黃素": "維生素B2",
    "維他命b6": "維生素B6",
    "vitamin b6": "維生素B6",
    "維他命b12": "維生素B12",
    "vitamin b12": "維生素B12",
    "維他命c": "維生素C",
    "vitamin c": "維生素C",
    "抗壞血酸": "維生素C",
    "維他命d": "維生素D",
    "vitamin d": "維生素D",
    "維他命e": "維生素E",
    "vitamin e": "維生素E",
    "維他命k": "維生素K",
    "vitamin k": "維生素K",
    # Minerals
    "sodium": "鈉",
    "na": "鈉",
    "calcium": "鈣",
    "ca": "鈣",
    "iron": "鐵",
    "fe": "鐵",
    "potassium": "鉀",
    "k": "鉀",
    "magnesium": "鎂",
    "mg": "鎂",
    "zinc": "鋅",
    "zn": "鋅",
    "phosphorus": "磷",
    "phosphate": "磷",
    # Cholesterol
    "膽固醇": "膽固醇",
    "cholesterol": "膽固醇",
    # Sugar
    "糖": "糖質",
    "sugar": "糖質",
    # Water
    "水": "水分",
    "water": "水分",
    # Ash
    "灰": "灰分",
}


class FoodNutritionService:
    def __init__(
        self, pool: asyncpg.Pool, embedding_svc: EmbeddingService | None = None
    ):
        self.pool = pool
        self._embedding_svc = embedding_svc
        self._sync_lock = asyncio.Lock()
        # In-memory cache for nutrient_item embeddings (104 items, built lazily)
        self._nutrient_embeddings: dict[str, list[float]] | None = None

    async def initialize(self) -> None:
        count = await self.pool.fetchval(
            "SELECT COUNT(*) FROM food_nutrition.measurements"
        )
        if count == 0:
            log_info(
                "Food nutrition DB empty — run data-loader --food-nutrition to load data"
            )
        else:
            log_info("Food Nutrition Service ready", measurements=count)

    async def shutdown(self) -> None:
        """Gracefully stop the service. No-op; provided for lifecycle symmetry."""
        pass

    async def _fetch_json(self, client: httpx.AsyncClient, url: str) -> list:
        resp = await client.get(url)
        resp.raise_for_status()
        ct = resp.headers.get("content-type", "")
        if "zip" in ct:
            import io
            import zipfile

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
                nutrition_data = await self._fetch_json(
                    client, API_SOURCES["nutrition"]
                )
                ingredients_data = await self._fetch_json(
                    client, API_SOURCES["ingredients"]
                )

            measurement_rows = [
                (
                    r.get("食品分類", ""),
                    r.get("樣品名稱", ""),
                    r.get("俗名", ""),
                    r.get("樣品英文名稱", ""),
                    r.get("分析項", ""),
                    str(r.get("每100克含量", "")),
                    r.get("含量單位", ""),
                    r.get("分析項分類", ""),
                )
                for r in nutrition_data
            ]
            ingredient_rows = [
                (
                    r.get("中文名稱", ""),
                    r.get("英文名稱", ""),
                    r.get("大分類", ""),
                    r.get("次分類", ""),
                    r.get("備註", ""),
                )
                for r in ingredients_data
            ]

            # Step 2: write atomically
            BATCH = 5000
            async with self.pool.acquire() as conn:
                async with conn.transaction():
                    await conn.execute(
                        "TRUNCATE food_nutrition.ingredients, food_nutrition.measurements"
                    )

                    for i in range(0, len(measurement_rows), BATCH):
                        await conn.executemany(
                            """INSERT INTO food_nutrition.measurements
                               (food_category, sample_name, common_name, english_name,
                                nutrient_item, content_per_100g, content_unit, nutrient_category)
                               VALUES ($1,$2,$3,$4,$5,$6,$7,$8)""",
                            measurement_rows[i : i + BATCH],
                        )

                    for i in range(0, len(ingredient_rows), BATCH):
                        await conn.executemany(
                            """INSERT INTO food_nutrition.ingredients
                               (name_zh, name_en, major_category, sub_category, note)
                               VALUES ($1,$2,$3,$4,$5)""",
                            ingredient_rows[i : i + BATCH],
                        )

                    await conn.execute(
                        """INSERT INTO food_nutrition.sync_meta (key, value, updated_at)
                           VALUES ('last_updated', $1, NOW())
                           ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=NOW()""",
                        datetime.now(tz=timezone.utc).isoformat(),
                    )
            log_info(
                "Food nutrition sync completed",
                measurements=len(measurement_rows),
                ingredients=len(ingredient_rows),
            )
            self._nutrient_embeddings = None  # invalidate in-memory nutrient cache
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
                batch = foods[i : i + BATCH_SIZE]
                texts = [
                    " ".join(
                        filter(
                            None,
                            [r["sample_name"], r["common_name"], r["english_name"]],
                        )
                    )
                    for r in batch
                ]
                vecs = await svc.embed_batch(texts)
                rows = [
                    (batch[j]["sample_name"], f"[{','.join(str(x) for x in vecs[j])}]")
                    for j in range(len(batch))
                    if vecs[j] is not None
                ]
                if rows:
                    async with self.pool.acquire() as conn:
                        await conn.executemany(
                            """INSERT INTO food_nutrition.food_embeddings (sample_name, embedding)
                               VALUES ($1, $2::halfvec)
                               ON CONFLICT (sample_name) DO UPDATE
                               SET embedding=EXCLUDED.embedding, embedded_at=NOW()""",
                            rows,
                        )
            log_info("Food nutrition: food embeddings done", total=len(foods))

            # Ingredient embeddings
            async with self.pool.acquire() as conn:
                ings = await conn.fetch(
                    "SELECT id, name_zh, name_en FROM food_nutrition.ingredients"
                )
            for i in range(0, len(ings), BATCH_SIZE):
                batch = ings[i : i + BATCH_SIZE]
                texts = [
                    " ".join(filter(None, [r["name_zh"], r["name_en"]])) for r in batch
                ]
                vecs = await svc.embed_batch(texts)
                rows = [
                    (batch[j]["id"], f"[{','.join(str(x) for x in vecs[j])}]")
                    for j in range(len(batch))
                    if vecs[j] is not None
                ]
                if rows:
                    async with self.pool.acquire() as conn:
                        await conn.executemany(
                            """INSERT INTO food_nutrition.ingredient_embeddings (id, embedding)
                               VALUES ($1, $2::halfvec)
                               ON CONFLICT (id) DO UPDATE
                               SET embedding=EXCLUDED.embedding, embedded_at=NOW()""",
                            rows,
                        )
            log_info("Food nutrition: ingredient embeddings done", total=len(ings))
        except Exception as exc:
            log_error("Food nutrition embedding generation failed", error=str(exc))

    # ── query methods ────────────────────────────────────────────────────────

    @cached(ttl=86400, prefix="fn.search")
    async def search_nutrition(
        self, food_name: str, nutrient: str | None = None, limit: int = 3
    ) -> str:
        limit = min(max(1, limit), 10)
        vec = (
            await self._embedding_svc.embed(food_name) if self._embedding_svc else None
        )
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
                                  ROW_NUMBER() OVER (ORDER BY embedding <=> $2::halfvec) AS rank
                           FROM food_nutrition.food_embeddings
                           ORDER BY embedding <=> $2::halfvec LIMIT 20
                       ),
                       rrf AS (
                           SELECT COALESCE(f.sample_name, v.sample_name) AS sample_name,
                                  COALESCE(1.0/(60+f.rank), 0.0) + COALESCE(1.0/(60+v.rank), 0.0) AS score
                           FROM fts f FULL OUTER JOIN vec v ON f.sample_name = v.sample_name
                       )
                       SELECT sample_name FROM rrf ORDER BY score DESC LIMIT $3""",
                    food_name,
                    vec_str,
                    limit,
                )
            else:
                matched = await conn.fetch(
                    """SELECT DISTINCT sample_name FROM food_nutrition.measurements
                       WHERE to_tsvector('simple',
                               COALESCE(sample_name,'') || ' ' || COALESCE(common_name,'') || ' ' || COALESCE(english_name,''))
                             @@ plainto_tsquery('simple', $1)
                       LIMIT $2""",
                    food_name,
                    limit,
                )

            if not matched:
                return json.dumps(
                    {"error": f"找不到 '{food_name}' 的營養資料。"}, ensure_ascii=False
                )

            names = [r["sample_name"] for r in matched]
            if nutrient:
                rows = await conn.fetch(
                    """SELECT sample_name, common_name, nutrient_item, content_per_100g, content_unit, food_category
                       FROM food_nutrition.measurements
                       WHERE sample_name = ANY($1) AND nutrient_item ILIKE $2""",
                    names,
                    f"%{nutrient}%",
                )
            else:
                rows = await conn.fetch(
                    """SELECT sample_name, common_name, nutrient_item, content_per_100g, content_unit, food_category
                       FROM food_nutrition.measurements
                       WHERE sample_name = ANY($1)""",
                    names,
                )

        if not rows:
            return json.dumps(
                {"error": f"找不到 '{food_name}' 的營養資料。"}, ensure_ascii=False
            )

        foods: dict[str, dict] = {}
        for r in rows:
            key = (
                f"{r['sample_name']} ({r['common_name']})"
                if r["common_name"]
                else r["sample_name"]
            )
            if key not in foods:
                foods[key] = {"category": r["food_category"], "nutrients": []}
            foods[key]["nutrients"].append(
                {
                    "item": r["nutrient_item"],
                    "value": r["content_per_100g"],
                    "unit": r["content_unit"],
                }
            )

        return json.dumps(
            [{"food": k, **v} for k, v in foods.items()], ensure_ascii=False
        )

    @cached(ttl=86400, prefix="fn.detail")
    async def get_detailed_nutrition(self, food_name: str) -> str:
        vec = (
            await self._embedding_svc.embed(food_name) if self._embedding_svc else None
        )
        vec_str = f"[{','.join(str(x) for x in vec)}]" if vec else None

        async with self.pool.acquire() as conn:
            # Step 1: resolve best-matching sample_names via hybrid RRF
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
                                  ROW_NUMBER() OVER (ORDER BY embedding <=> $2::halfvec) AS rank
                           FROM food_nutrition.food_embeddings
                           ORDER BY embedding <=> $2::halfvec LIMIT 20
                       ),
                       rrf AS (
                           SELECT COALESCE(f.sample_name, v.sample_name) AS sample_name,
                                  COALESCE(1.0/(60+f.rank), 0.0) + COALESCE(1.0/(60+v.rank), 0.0) AS score
                           FROM fts f FULL OUTER JOIN vec v ON f.sample_name = v.sample_name
                       )
                       SELECT sample_name FROM rrf ORDER BY score DESC LIMIT 3""",
                    food_name,
                    vec_str,
                )
            else:
                matched = await conn.fetch(
                    """SELECT DISTINCT sample_name FROM food_nutrition.measurements
                       WHERE to_tsvector('simple',
                               COALESCE(sample_name,'') || ' ' || COALESCE(common_name,'') || ' ' || COALESCE(english_name,''))
                             @@ plainto_tsquery('simple', $1)
                       LIMIT 3""",
                    food_name,
                )

            if not matched:
                return json.dumps(
                    {"error": f"找不到 '{food_name}' 的詳細營養資料。"},
                    ensure_ascii=False,
                )

            names = [r["sample_name"] for r in matched]

            # Step 2: fetch all nutrients for matched foods, grouped by category
            rows = await conn.fetch(
                """SELECT sample_name, common_name, food_category, nutrient_category,
                          nutrient_item, content_per_100g, content_unit
                   FROM food_nutrition.measurements
                   WHERE sample_name = ANY($1)
                   ORDER BY sample_name, nutrient_category, nutrient_item""",
                names,
            )

        if not rows:
            return json.dumps(
                {"error": f"找不到 '{food_name}' 的詳細營養資料。"}, ensure_ascii=False
            )

        # Group by sample_name, nutrients nested by category; preserve RRF rank order
        name_order = {name: i for i, name in enumerate(names)}
        foods: dict[str, dict] = {}
        for r in rows:
            key = r["sample_name"]
            if key not in foods:
                foods[key] = {
                    "sample_name": r["sample_name"],
                    "common_name": r["common_name"],
                    "food_category": r["food_category"],
                    "nutrients": {},
                }
            cat = r["nutrient_category"] or "其他"
            if cat not in foods[key]["nutrients"]:
                foods[key]["nutrients"][cat] = []
            foods[key]["nutrients"][cat].append(
                {
                    "item": r["nutrient_item"],
                    "value": (
                        r["content_per_100g"].strip() if r["content_per_100g"] else None
                    ),
                    "unit": r["content_unit"],
                }
            )

        ordered = sorted(
            foods.values(), key=lambda f: name_order.get(f["sample_name"], 999)
        )
        return json.dumps(ordered, ensure_ascii=False)

    @cached(ttl=86400, prefix="fn.ing")
    async def search_food_ingredient(self, keyword: str, limit: int = 3) -> str:
        limit = min(max(1, limit), 10)
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
                                  ROW_NUMBER() OVER (ORDER BY embedding <=> $2::halfvec) AS rank
                           FROM food_nutrition.ingredient_embeddings
                           ORDER BY embedding <=> $2::halfvec LIMIT 20
                       ),
                       rrf AS (
                           SELECT COALESCE(f.id, v.id) AS id,
                                  COALESCE(1.0/(60+f.rank), 0.0) + COALESCE(1.0/(60+v.rank), 0.0) AS score
                           FROM fts f FULL OUTER JOIN vec v ON f.id = v.id
                       )
                       SELECT i.name_zh, i.name_en, i.major_category, i.sub_category, i.note
                       FROM rrf JOIN food_nutrition.ingredients i ON i.id = rrf.id
                       ORDER BY rrf.score DESC LIMIT $3""",
                    keyword,
                    vec_str,
                    limit,
                )
            else:
                rows = await conn.fetch(
                    """SELECT name_zh, name_en, major_category, sub_category, note
                       FROM food_nutrition.ingredients
                       WHERE to_tsvector('simple', COALESCE(name_zh,'') || ' ' || COALESCE(name_en,''))
                             @@ plainto_tsquery('simple', $1)
                       LIMIT $2""",
                    keyword,
                    limit,
                )
        if not rows:
            return json.dumps(
                {"error": f"找不到與 '{keyword}' 相關的食品原料。"}, ensure_ascii=False
            )
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
            return json.dumps(
                {"error": f"找不到分類 '{category}' 的原料資料。"}, ensure_ascii=False
            )
        return json.dumps([dict(r) for r in rows], ensure_ascii=False)

    async def _find_nutrient_by_embedding(self, query: str) -> str | None:
        """Find the closest nutrient_item by cosine similarity (in-memory, 104 items)."""
        if not self._embedding_svc:
            return None

        # Build cache lazily
        if self._nutrient_embeddings is None:
            async with self.pool.acquire() as conn:
                items = await conn.fetch(
                    "SELECT DISTINCT nutrient_item FROM food_nutrition.measurements ORDER BY nutrient_item"
                )
            names = [r["nutrient_item"] for r in items]
            from embedding_service import BATCH_SIZE

            all_vecs: list[list[float] | None] = []
            for i in range(0, len(names), BATCH_SIZE):
                vecs = await self._embedding_svc.embed_batch(names[i : i + BATCH_SIZE])
                all_vecs.extend(vecs)
            self._nutrient_embeddings = {
                name: vec for name, vec in zip(names, all_vecs) if vec is not None
            }

        if not self._nutrient_embeddings:
            return None

        query_vec = await self._embedding_svc.embed(query)
        if not query_vec:
            return None

        # Cosine similarity (vectors are already unit-normalised by qwen3-embedding)
        import math

        def cosine(a: list[float], b: list[float]) -> float:
            dot = sum(x * y for x, y in zip(a, b))
            na = math.sqrt(sum(x * x for x in a))
            nb = math.sqrt(sum(x * x for x in b))
            return dot / (na * nb) if na and nb else 0.0

        best_name, best_score = max(
            (
                (name, cosine(query_vec, vec))
                for name, vec in self._nutrient_embeddings.items()
            ),
            key=lambda kv: kv[1],
        )
        # Threshold: the query must be clearly related to the matched nutrient.
        # 0.75 rejects vague/nonsense input (e.g. "維他命Z") while accepting
        # legitimate synonyms (e.g. "蛋白質" → "粗蛋白", "sodium" → "鈉").
        return best_name if best_score > 0.85 else None

    @cached(ttl=86400, prefix="fn.bynutrient")
    async def search_foods_by_nutrient(self, nutrient: str, limit: int = 20) -> str:
        """Find foods ranked by content of a specific nutrient (per 100g)."""
        nutrient_stripped = nutrient.strip()

        # Step 1: alias map — common synonyms (e.g. "蛋白質" → "粗蛋白", "維他命C" → "維生素C")
        matched_nutrient = _NUTRIENT_ALIASES.get(nutrient_stripped.lower())

        if not matched_nutrient:
            # Step 2: ILIKE partial match against DB nutrient_item names
            async with self.pool.acquire() as conn:
                nutrient_items = await conn.fetch(
                    """SELECT DISTINCT nutrient_item FROM food_nutrition.measurements
                       WHERE nutrient_item ILIKE $1 LIMIT 10""",
                    f"%{nutrient_stripped}%",
                )
            if nutrient_items:
                matched_nutrient = nutrient_items[0]["nutrient_item"]

        if not matched_nutrient:
            # Step 3: semantic embedding fallback (threshold ≥ 0.85 to reject nonsense queries)
            matched_nutrient = await self._find_nutrient_by_embedding(nutrient_stripped)

        if not matched_nutrient:
            return json.dumps(
                {
                    "error": f"找不到營養素 '{nutrient}'。請嘗試中文名稱，如：粗蛋白、粗脂肪、鈣、鐵、維生素C、熱量、鈉"
                },
                ensure_ascii=False,
            )

        async with self.pool.acquire() as conn:
            rows = await conn.fetch(
                """SELECT sample_name, common_name, food_category, nutrient_item,
                          content_per_100g, content_unit
                   FROM food_nutrition.measurements
                   WHERE nutrient_item = $1
                     AND TRIM(content_per_100g) ~ '^[0-9]+[.]?[0-9]*$'
                   ORDER BY CAST(TRIM(content_per_100g) AS FLOAT) DESC
                   LIMIT $2""",
                matched_nutrient,
                min(limit, 50),
            )

        return json.dumps(
            {
                "nutrient": matched_nutrient,
                "unit": rows[0]["content_unit"] if rows else "",
                "total": len(rows),
                "note": "數值為每 100 克含量",
                "foods": [
                    {
                        "name": r["sample_name"],
                        "common_name": r["common_name"],
                        "category": r["food_category"],
                        "content_per_100g": (
                            r["content_per_100g"].strip()
                            if r["content_per_100g"]
                            else None
                        ),
                        "unit": r["content_unit"],
                    }
                    for r in rows
                ],
            },
            ensure_ascii=False,
        )

    async def analyze_meal_nutrition(self, foods: list[str]) -> str:
        totals: dict[str, float] = {}
        components: dict[str, dict] = {}

        async with self.pool.acquire() as conn:
            for food in foods:
                rows = await conn.fetch(
                    """SELECT sample_name, common_name, food_category,
                              nutrient_category, nutrient_item, content_per_100g, content_unit
                       FROM food_nutrition.measurements
                       WHERE sample_name ILIKE $1 OR common_name ILIKE $1
                       ORDER BY nutrient_category, nutrient_item""",
                    f"%{food}%",
                )
                # Group nutrients by category (same pattern as get_detailed_nutrition)
                grouped: dict[str, list] = {}
                for r in rows:
                    cat = r["nutrient_category"] or "其他"
                    if cat not in grouped:
                        grouped[cat] = []
                    val_str = (
                        r["content_per_100g"].strip() if r["content_per_100g"] else None
                    )
                    grouped[cat].append(
                        {
                            "item": r["nutrient_item"],
                            "value": val_str,
                            "unit": r["content_unit"],
                        }
                    )
                    try:
                        totals[r["nutrient_item"]] = totals.get(
                            r["nutrient_item"], 0
                        ) + float(val_str)
                    except (ValueError, TypeError):
                        pass

                if rows:
                    components[food] = {
                        "matched": rows[0]["sample_name"],
                        "common_name": rows[0]["common_name"],
                        "food_category": rows[0]["food_category"],
                        "nutrients": grouped,
                    }
                else:
                    components[food] = {"error": f"找不到 '{food}' 的資料"}

        return json.dumps(
            {"meal_components": components, "combined_totals_per_100g_each": totals},
            ensure_ascii=False,
        )
