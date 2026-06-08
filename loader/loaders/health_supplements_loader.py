"""
Taiwan FDA health supplements dataset loader.
"""

from __future__ import annotations

from datetime import datetime, timezone

import asyncpg
import httpx
from loaders.fda_common import fetch_json

API_SOURCE = "https://data.fda.gov.tw/data/opendata/export/19/json"


async def load_health_supplements(pool: asyncpg.Pool) -> None:
    """Fetch Taiwan FDA health supplements data from the Open Data API and load into ``health_supplements.items``.

    Args:
        pool: asyncpg connection pool.
    """
    print("Fetching Taiwan FDA health supplements dataset ...")
    async with httpx.AsyncClient(timeout=60) as client:
        data = await fetch_json(client, API_SOURCE)

    rows = [
        (
            r.get("許可證字號", ""),
            r.get("中文品名", ""),
            r.get("申請商", ""),
            r.get("保健功效", ""),
            r.get("核可日期", ""),
            "",
            r.get("類別", ""),
        )
        for r in data
    ]

    BATCH = 2000
    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute("TRUNCATE health_supplements.items")
            for i in range(0, len(rows), BATCH):
                await conn.executemany(
                    """INSERT INTO health_supplements.items
                       (permit_no, name, applicant, benefit_claims, valid_from, valid_to, category)
                       VALUES ($1,$2,$3,$4,$5,$6,$7)""",
                    rows[i : i + BATCH],
                )
            await conn.execute(
                """INSERT INTO health_supplements.sync_meta (key, value, updated_at)
                   VALUES ('last_updated', $1, NOW())
                   ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=NOW()""",
                datetime.now(tz=timezone.utc).isoformat(),
            )

    print(f"  Health supplements loaded: {len(rows)} items.")
