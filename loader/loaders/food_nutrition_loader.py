"""
Taiwan FDA food nutrition dataset loader.
"""

from __future__ import annotations

from datetime import datetime, timezone

import asyncpg
import httpx
from loaders.fda_common import fetch_json

API_SOURCES = {
    "nutrition": "https://data.fda.gov.tw/data/opendata/export/20/json",
    "ingredients": "https://data.fda.gov.tw/data/opendata/export/4/json",
}


async def load_food_nutrition(pool: asyncpg.Pool) -> None:
    """Fetch Taiwan FDA food nutrition data from the Open Data API and load into ``food_nutrition.*``.

    Args:
        pool: asyncpg connection pool.
    """
    print("Fetching Taiwan FDA food nutrition datasets ...")
    async with httpx.AsyncClient(timeout=60) as client:
        nutrition_data = await fetch_json(client, API_SOURCES["nutrition"])
        ingredients_data = await fetch_json(client, API_SOURCES["ingredients"])

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

    BATCH = 5000
    async with pool.acquire() as conn:
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

    print(
        f"  Food nutrition loaded: {len(measurement_rows)} measurements, "
        f"{len(ingredient_rows)} ingredients."
    )
