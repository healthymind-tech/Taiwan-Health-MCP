"""
Shared FDA Open Data fetch helpers for loader modules.
"""

from __future__ import annotations

import io
import json
import zipfile

import httpx


async def fetch_json(client: httpx.AsyncClient, url: str) -> list:
    resp = await client.get(url)
    resp.raise_for_status()
    ct = resp.headers.get("content-type", "")
    if "zip" in ct or url.endswith(".zip"):
        zf = zipfile.ZipFile(io.BytesIO(resp.content))
        names = [n for n in zf.namelist() if n.endswith(".json")]
        return json.loads(zf.read(names[0])) if names else []
    return resp.json()
