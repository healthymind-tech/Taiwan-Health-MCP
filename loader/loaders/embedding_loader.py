"""
Embedding Loader — generate pgvector embeddings for hybrid search.

Calls Ollama /api/embed in batches and upserts into:
  - food_nutrition.food_embeddings        (~2181 unique foods)
  - food_nutrition.ingredient_embeddings  (~1702 ingredients)
  - health_food.item_embeddings           (~555 items)
  - drug.license_embeddings               (~66k licenses)

Supports resuming: ON CONFLICT DO UPDATE means already-embedded rows
are refreshed without skipping. Run --embed after --fda or --all.

Config env vars:
  OLLAMA_BASE_URL, OLLAMA_EMBED_MODEL, OLLAMA_EMBED_TIMEOUT, OLLAMA_EMBED_BATCH_SIZE
"""

from __future__ import annotations

import os

import asyncpg
import httpx

try:
    from tqdm import tqdm as _tqdm
    HAS_TQDM = True
except ImportError:
    HAS_TQDM = False

_BASE_URL: str = os.getenv("OLLAMA_BASE_URL", "").rstrip("/")
_MODEL: str = os.getenv("OLLAMA_EMBED_MODEL", "qwen3-embedding:0.6b")
_TIMEOUT: float = float(os.getenv("OLLAMA_EMBED_TIMEOUT", "30"))
_BATCH_SIZE: int = int(os.getenv("OLLAMA_EMBED_BATCH_SIZE", "32"))


def _progress(batches: list, desc: str) -> object:
    """Wrap batches with tqdm if available, otherwise print milestones."""
    if HAS_TQDM:
        return _tqdm(batches, desc=desc, unit="batch")
    total = len(batches)
    milestone = max(1, total // 10)

    class _FallbackIter:
        def __iter__(self):
            for i, batch in enumerate(batches):
                if i == 0 or (i + 1) % milestone == 0 or i == total - 1:
                    print(f"  {desc}: batch {i+1}/{total}", flush=True)
                yield batch

    return _FallbackIter()


async def _check_ollama() -> bool:
    if not _BASE_URL:
        print("  OLLAMA_BASE_URL not set — skipping embedding generation")
        return False
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.get(f"{_BASE_URL}/api/version")
            if r.status_code == 200:
                print(f"  Ollama OK  url={_BASE_URL}  model={_MODEL}  batch_size={_BATCH_SIZE}")
                return True
    except Exception:
        pass
    print(f"  [error] Ollama not reachable at {_BASE_URL} — skipping embedding")
    return False


async def _embed_batch(client: httpx.AsyncClient, texts: list[str]) -> list[list[float] | None]:
    try:
        resp = await client.post(
            f"{_BASE_URL}/api/embed",
            json={"model": _MODEL, "input": texts},
        )
        resp.raise_for_status()
        embeddings = resp.json().get("embeddings", [])
        return [embeddings[i] if i < len(embeddings) else None for i in range(len(texts))]
    except Exception as exc:
        print(f"  [warn] Ollama batch failed: {exc}", flush=True)
        return [None] * len(texts)


async def _upsert(pool: asyncpg.Pool, sql: str, rows: list[tuple]) -> None:
    if not rows:
        return
    async with pool.acquire() as conn:
        await conn.executemany(sql, rows)


async def embed_food_nutrition(pool: asyncpg.Pool) -> None:
    print("\n=== Embedding: food_nutrition ===")
    if not await _check_ollama():
        return

    # ── Unique foods ──────────────────────────────────────────────────────────
    async with pool.acquire() as conn:
        foods = await conn.fetch(
            """SELECT DISTINCT ON (sample_name) sample_name, common_name, english_name
               FROM food_nutrition.measurements ORDER BY sample_name"""
        )
    print(f"  Foods: {len(foods)}")
    batches = [foods[i:i + _BATCH_SIZE] for i in range(0, len(foods), _BATCH_SIZE)]
    total_ok = 0
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        for batch in _progress(batches, "Foods"):
            texts = [
                " ".join(filter(None, [r["sample_name"], r["common_name"], r["english_name"]]))
                for r in batch
            ]
            vecs = await _embed_batch(client, texts)
            rows = [
                (batch[j]["sample_name"], f"[{','.join(str(x) for x in vecs[j])}]")
                for j in range(len(batch)) if vecs[j] is not None
            ]
            await _upsert(pool,
                """INSERT INTO food_nutrition.food_embeddings (sample_name, embedding)
                   VALUES ($1, $2::vector)
                   ON CONFLICT (sample_name) DO UPDATE
                   SET embedding=EXCLUDED.embedding, embedded_at=NOW()""",
                rows,
            )
            total_ok += len(rows)
    print(f"  Foods done: {total_ok}/{len(foods)} embedded")

    # ── Ingredients ───────────────────────────────────────────────────────────
    async with pool.acquire() as conn:
        ings = await conn.fetch("SELECT id, name_zh, name_en FROM food_nutrition.ingredients")
    print(f"  Ingredients: {len(ings)}")
    batches = [ings[i:i + _BATCH_SIZE] for i in range(0, len(ings), _BATCH_SIZE)]
    total_ok = 0
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        for batch in _progress(batches, "Ingredients"):
            texts = [" ".join(filter(None, [r["name_zh"], r["name_en"]])) for r in batch]
            vecs = await _embed_batch(client, texts)
            rows = [
                (batch[j]["id"], f"[{','.join(str(x) for x in vecs[j])}]")
                for j in range(len(batch)) if vecs[j] is not None
            ]
            await _upsert(pool,
                """INSERT INTO food_nutrition.ingredient_embeddings (id, embedding)
                   VALUES ($1, $2::vector)
                   ON CONFLICT (id) DO UPDATE
                   SET embedding=EXCLUDED.embedding, embedded_at=NOW()""",
                rows,
            )
            total_ok += len(rows)
    print(f"  Ingredients done: {total_ok}/{len(ings)} embedded")


async def embed_health_food(pool: asyncpg.Pool) -> None:
    print("\n=== Embedding: health_food ===")
    if not await _check_ollama():
        return

    async with pool.acquire() as conn:
        items = await conn.fetch("SELECT permit_no, name, benefit_claims FROM health_food.items")
    print(f"  Items: {len(items)}")
    batches = [items[i:i + _BATCH_SIZE] for i in range(0, len(items), _BATCH_SIZE)]
    total_ok = 0
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        for batch in _progress(batches, "Health foods"):
            texts = [" ".join(filter(None, [r["name"], r["benefit_claims"]])) for r in batch]
            vecs = await _embed_batch(client, texts)
            rows = [
                (batch[j]["permit_no"], f"[{','.join(str(x) for x in vecs[j])}]")
                for j in range(len(batch)) if vecs[j] is not None
            ]
            await _upsert(pool,
                """INSERT INTO health_food.item_embeddings (permit_no, embedding)
                   VALUES ($1, $2::vector)
                   ON CONFLICT (permit_no) DO UPDATE
                   SET embedding=EXCLUDED.embedding, embedded_at=NOW()""",
                rows,
            )
            total_ok += len(rows)
    print(f"  Health food done: {total_ok}/{len(items)} embedded")


async def embed_drug(pool: asyncpg.Pool) -> None:
    print("\n=== Embedding: drug (~66k licenses — may take 5-20 min depending on GPU) ===")
    if not await _check_ollama():
        return

    async with pool.acquire() as conn:
        drugs = await conn.fetch(
            "SELECT license_id, name_zh, name_en, indication FROM drug.licenses"
        )
    print(f"  Licenses: {len(drugs)}")
    batches = [drugs[i:i + _BATCH_SIZE] for i in range(0, len(drugs), _BATCH_SIZE)]
    total_ok = 0
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        for batch in _progress(batches, "Drugs"):
            texts = [
                " ".join(filter(None, [r["name_zh"], r["name_en"], r["indication"]]))
                for r in batch
            ]
            vecs = await _embed_batch(client, texts)
            rows = [
                (batch[j]["license_id"], f"[{','.join(str(x) for x in vecs[j])}]")
                for j in range(len(batch)) if vecs[j] is not None
            ]
            await _upsert(pool,
                """INSERT INTO drug.license_embeddings (license_id, embedding)
                   VALUES ($1, $2::vector)
                   ON CONFLICT (license_id) DO UPDATE
                   SET embedding=EXCLUDED.embedding, embedded_at=NOW()""",
                rows,
            )
            total_ok += len(rows)
    print(f"  Drug done: {total_ok}/{len(drugs)} embedded")
