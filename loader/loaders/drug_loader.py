"""
Taiwan FDA drug dataset loader.
"""

from __future__ import annotations

from datetime import datetime, timezone

import asyncpg
import httpx
from loaders.fda_common import fetch_json

API_SOURCES = {
    "master": "https://data.fda.gov.tw/data/opendata/export/36/json",
    "appearance": "https://data.fda.gov.tw/data/opendata/export/42/json",
    "ingredients": "https://data.fda.gov.tw/data/opendata/export/43/json",
    "atc": "https://data.fda.gov.tw/data/opendata/export/41/json",
    "documents": "https://data.fda.gov.tw/data/opendata/export/39/json",
}


async def load_drug(pool: asyncpg.Pool) -> None:
    """Fetch Taiwan FDA drug data from the Open Data API and load into ``drug.*`` tables.

    All five FDA endpoints are fetched first, then written atomically in a single
    transaction to prevent partial-state corruption.

    Args:
        pool: asyncpg connection pool.
    """
    print("Fetching Taiwan FDA drug datasets ...")
    async with httpx.AsyncClient(timeout=120) as client:
        master = await fetch_json(client, API_SOURCES["master"])
        appearance = await fetch_json(client, API_SOURCES["appearance"])
        ingredients = await fetch_json(client, API_SOURCES["ingredients"])
        atc = await fetch_json(client, API_SOURCES["atc"])
        documents = await fetch_json(client, API_SOURCES["documents"])

    print(
        "  fetched",
        f"licenses={len(master)}",
        f"appearance={len(appearance)}",
        f"ingredients={len(ingredients)}",
        f"atc={len(atc)}",
        f"documents={len(documents)}",
    )

    BATCH = 2000
    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute(
                "TRUNCATE drug.documents, drug.atc, drug.ingredients, drug.appearance, drug.licenses"
            )

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

    print(f"  Drug loaded: {len(license_rows)} licenses.")
