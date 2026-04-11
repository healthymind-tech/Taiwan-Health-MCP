"""
Embedding Loader — generate pgvector embeddings for hybrid search.

Calls Ollama /api/embed in batches and upserts into:
  - food_nutrition.food_embeddings            (~2181 unique foods)
  - food_nutrition.ingredient_embeddings      (~1702 ingredients)
  - health_food.item_embeddings               (~555 items)
  - drug.license_embeddings                   (~66k licenses)
  - drug.atc_embeddings                       (~10k ATC codes)
  - drug.ingredient_name_embeddings           (~50k+ unique ingredient names)
  - icd.diagnosis_embeddings                  (~73k ICD-10-CM codes)
  - loinc.concept_embeddings                  (~87k LOINC concepts)
  - guideline.guideline_embeddings            (~50 guidelines)
  - snomed.concept_embeddings                 (~360k concepts — slow, 1-2+ hours)

Supports resuming: ON CONFLICT DO UPDATE means already-embedded rows
are refreshed without skipping. Run --embed after data loaders.

Config env vars:
  OLLAMA_BASE_URL, OLLAMA_EMBED_MODEL, OLLAMA_EMBED_DIMENSIONS,
  OLLAMA_EMBED_TIMEOUT, OLLAMA_EMBED_BATCH_SIZE
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
_DIMENSIONS: int = int(os.getenv("OLLAMA_EMBED_DIMENSIONS", "1024"))
_TIMEOUT: float = float(os.getenv("OLLAMA_EMBED_TIMEOUT", "30"))
_BATCH_SIZE: int = int(os.getenv("OLLAMA_EMBED_BATCH_SIZE", "32"))

# All (schema, table, column) triples that hold embedding vectors.
# Used by ensure_dimensions() to ALTER TABLE when OLLAMA_EMBED_DIMENSIONS changes.
_EMBEDDING_COLUMNS: list[tuple[str, str, str]] = [
    ("icd",           "diagnosis_embeddings",       "embedding"),
    ("drug",          "atc_embeddings",              "embedding"),
    ("drug",          "ingredient_name_embeddings",  "embedding"),
    ("drug",          "license_embeddings",          "embedding"),
    ("health_food",   "item_embeddings",             "embedding"),
    ("food_nutrition","food_embeddings",             "embedding"),
    ("food_nutrition","ingredient_embeddings",       "embedding"),
    ("loinc",         "concept_embeddings",          "embedding"),
    ("guideline",     "guideline_embeddings",        "embedding"),
    ("snomed",        "concept_embeddings",          "embedding"),
]


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


_HNSW_MAX_DIMS = 4000  # pgvector halfvec HNSW limit


async def ensure_dimensions(pool: asyncpg.Pool) -> None:
    """ALTER all embedding halfvec columns to match OLLAMA_EMBED_DIMENSIONS.

    Safe to call when dimensions are already correct (no-op). Required when
    switching embedding models with a different output size.
    Each column is dropped and re-added (CASCADE drops associated HNSW index);
    the HNSW index is recreated when dimensions ≤ 4000 (halfvec limit).
    """
    print(f"\n=== Ensuring embedding dimensions = {_DIMENSIONS} ===")
    if _DIMENSIONS > _HNSW_MAX_DIMS:
        print(
            f"  [warn] {_DIMENSIONS}d > {_HNSW_MAX_DIMS} halfvec HNSW limit — "
            "index skipped, falling back to exact sequential scan"
        )
    async with pool.acquire() as conn:
        for schema, table, col in _EMBEDDING_COLUMNS:
            # Check current dimension stored in pg_attribute
            row = await conn.fetchrow(
                """SELECT atttypmod
                   FROM pg_attribute pa
                   JOIN pg_class pc ON pc.oid = pa.attrelid
                   JOIN pg_namespace pn ON pn.oid = pc.relnamespace
                   WHERE pn.nspname = $1 AND pc.relname = $2 AND pa.attname = $3
                     AND pa.attnum > 0 AND NOT pa.attisdropped""",
                schema, table, col,
            )
            if row is None:
                print(f"  {schema}.{table} not found, skipping")
                continue

            current_dim = row["atttypmod"]
            if current_dim == _DIMENSIONS:
                print(f"  {schema}.{table}.{col}: already {_DIMENSIONS}d — OK")
                continue

            print(f"  {schema}.{table}.{col}: {current_dim}d → {_DIMENSIONS}d  (ALTER TABLE)")
            fqt = f"{schema}.{table}"
            # DROP CASCADE removes any dependent HNSW index automatically
            await conn.execute(
                f"ALTER TABLE {fqt} DROP COLUMN IF EXISTS {col} CASCADE"
            )
            await conn.execute(
                f"ALTER TABLE {fqt} ADD COLUMN {col} halfvec({_DIMENSIONS})"
            )
            if _DIMENSIONS <= _HNSW_MAX_DIMS:
                idx = f"idx_{schema[:2]}_{table[:6]}_emb_hnsw"
                await conn.execute(
                    f"CREATE INDEX IF NOT EXISTS {idx} ON {fqt} "
                    f"USING hnsw ({col} halfvec_cosine_ops)"
                )
                print(f"    → HNSW index recreated: {idx}")
            else:
                print(f"    → HNSW index skipped ({_DIMENSIONS}d > {_HNSW_MAX_DIMS})")
    print("=== Dimensions check complete ===")


async def _check_ollama() -> bool:
    if not _BASE_URL:
        print("  OLLAMA_BASE_URL not set — skipping embedding generation")
        return False
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.get(f"{_BASE_URL}/api/version")
            if r.status_code == 200:
                print(
                    f"  Ollama OK  url={_BASE_URL}  model={_MODEL}"
                    f"  dimensions={_DIMENSIONS}  batch_size={_BATCH_SIZE}"
                )
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
                   VALUES ($1, $2::halfvec)
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
                   VALUES ($1, $2::halfvec)
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
                   VALUES ($1, $2::halfvec)
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

    # ── Licenses ─────────────────────────────────────────────────────────────
    async with pool.acquire() as conn:
        drugs = await conn.fetch(
            "SELECT license_id, name_zh, name_en, indication FROM drug.licenses"
        )
    print(f"  Licenses: {len(drugs)}")
    batches = [drugs[i:i + _BATCH_SIZE] for i in range(0, len(drugs), _BATCH_SIZE)]
    total_ok = 0
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        for batch in _progress(batches, "Drug licenses"):
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
                   VALUES ($1, $2::halfvec)
                   ON CONFLICT (license_id) DO UPDATE
                   SET embedding=EXCLUDED.embedding, embedded_at=NOW()""",
                rows,
            )
            total_ok += len(rows)
    print(f"  Drug licenses done: {total_ok}/{len(drugs)} embedded")

    # ── Distinct ATC codes ────────────────────────────────────────────────────
    async with pool.acquire() as conn:
        atc_rows = await conn.fetch(
            "SELECT DISTINCT ON (atc_code) atc_code, atc_name FROM drug.atc WHERE atc_name IS NOT NULL"
        )
    print(f"  ATC codes: {len(atc_rows)}")
    batches = [atc_rows[i:i + _BATCH_SIZE] for i in range(0, len(atc_rows), _BATCH_SIZE)]
    total_ok = 0
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        for batch in _progress(batches, "Drug ATC"):
            texts = [r["atc_name"] for r in batch]
            vecs = await _embed_batch(client, texts)
            rows = [
                (batch[j]["atc_code"], f"[{','.join(str(x) for x in vecs[j])}]")
                for j in range(len(batch)) if vecs[j] is not None
            ]
            await _upsert(pool,
                """INSERT INTO drug.atc_embeddings (atc_code, embedding)
                   VALUES ($1, $2::halfvec)
                   ON CONFLICT (atc_code) DO UPDATE
                   SET embedding=EXCLUDED.embedding, embedded_at=NOW()""",
                rows,
            )
            total_ok += len(rows)
    print(f"  Drug ATC done: {total_ok}/{len(atc_rows)} embedded")

    # ── Distinct ingredient names ─────────────────────────────────────────────
    async with pool.acquire() as conn:
        ing_rows = await conn.fetch(
            "SELECT DISTINCT ingredient_name FROM drug.ingredients WHERE ingredient_name IS NOT NULL AND ingredient_name <> ''"
        )
    print(f"  Ingredient names: {len(ing_rows)}")
    batches = [ing_rows[i:i + _BATCH_SIZE] for i in range(0, len(ing_rows), _BATCH_SIZE)]
    total_ok = 0
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        for batch in _progress(batches, "Drug ingredients"):
            texts = [r["ingredient_name"] for r in batch]
            vecs = await _embed_batch(client, texts)
            rows = [
                (batch[j]["ingredient_name"], f"[{','.join(str(x) for x in vecs[j])}]")
                for j in range(len(batch)) if vecs[j] is not None
            ]
            await _upsert(pool,
                """INSERT INTO drug.ingredient_name_embeddings (ingredient_name, embedding)
                   VALUES ($1, $2::halfvec)
                   ON CONFLICT (ingredient_name) DO UPDATE
                   SET embedding=EXCLUDED.embedding, embedded_at=NOW()""",
                rows,
            )
            total_ok += len(rows)
    print(f"  Drug ingredients done: {total_ok}/{len(ing_rows)} embedded")


async def embed_icd(pool: asyncpg.Pool) -> None:
    print("\n=== Embedding: icd.diagnoses (~73k codes) ===")
    if not await _check_ollama():
        return

    async with pool.acquire() as conn:
        rows = await conn.fetch("SELECT code, name_zh, name_en FROM icd.diagnoses")
    print(f"  Diagnoses: {len(rows)}")
    batches = [rows[i:i + _BATCH_SIZE] for i in range(0, len(rows), _BATCH_SIZE)]
    total_ok = 0
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        for batch in _progress(batches, "ICD diagnoses"):
            texts = [
                " ".join(filter(None, [r["code"], r["name_zh"], r["name_en"]]))
                for r in batch
            ]
            vecs = await _embed_batch(client, texts)
            rows_out = [
                (batch[j]["code"], f"[{','.join(str(x) for x in vecs[j])}]")
                for j in range(len(batch)) if vecs[j] is not None
            ]
            await _upsert(pool,
                """INSERT INTO icd.diagnosis_embeddings (code, embedding)
                   VALUES ($1, $2::halfvec)
                   ON CONFLICT (code) DO UPDATE
                   SET embedding=EXCLUDED.embedding, embedded_at=NOW()""",
                rows_out,
            )
            total_ok += len(rows_out)
    print(f"  ICD done: {total_ok}/{len(rows)} embedded")


async def embed_loinc(pool: asyncpg.Pool) -> None:
    print("\n=== Embedding: loinc.concepts (~87k concepts) ===")
    if not await _check_ollama():
        return

    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """SELECT loinc_num, long_common_name, shortname, name_zh, common_name_zh,
                      component, specimen_type
               FROM loinc.concepts"""
        )
    print(f"  LOINC concepts: {len(rows)}")
    batches = [rows[i:i + _BATCH_SIZE] for i in range(0, len(rows), _BATCH_SIZE)]
    total_ok = 0
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        for batch in _progress(batches, "LOINC"):
            texts = [
                " ".join(filter(None, [
                    r["long_common_name"], r["shortname"], r["name_zh"],
                    r["common_name_zh"], r["component"], r["specimen_type"],
                ]))
                for r in batch
            ]
            vecs = await _embed_batch(client, texts)
            rows_out = [
                (batch[j]["loinc_num"], f"[{','.join(str(x) for x in vecs[j])}]")
                for j in range(len(batch)) if vecs[j] is not None
            ]
            await _upsert(pool,
                """INSERT INTO loinc.concept_embeddings (loinc_num, embedding)
                   VALUES ($1, $2::halfvec)
                   ON CONFLICT (loinc_num) DO UPDATE
                   SET embedding=EXCLUDED.embedding, embedded_at=NOW()""",
                rows_out,
            )
            total_ok += len(rows_out)
    print(f"  LOINC done: {total_ok}/{len(rows)} embedded")


async def embed_guideline(pool: asyncpg.Pool) -> None:
    print("\n=== Embedding: guideline.disease_guidelines ===")
    if not await _check_ollama():
        return

    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT id, disease_name_zh, disease_name_en, guideline_title, guideline_summary FROM guideline.disease_guidelines"
        )
    print(f"  Guidelines: {len(rows)}")
    if not rows:
        print("  No guidelines found — run data-loader --guideline first")
        return
    batches = [rows[i:i + _BATCH_SIZE] for i in range(0, len(rows), _BATCH_SIZE)]
    total_ok = 0
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        for batch in _progress(batches, "Guidelines"):
            texts = [
                " ".join(filter(None, [
                    r["disease_name_zh"], r["disease_name_en"],
                    r["guideline_title"], r["guideline_summary"],
                ]))
                for r in batch
            ]
            vecs = await _embed_batch(client, texts)
            rows_out = [
                (batch[j]["id"], f"[{','.join(str(x) for x in vecs[j])}]")
                for j in range(len(batch)) if vecs[j] is not None
            ]
            await _upsert(pool,
                """INSERT INTO guideline.guideline_embeddings (id, embedding)
                   VALUES ($1, $2::halfvec)
                   ON CONFLICT (id) DO UPDATE
                   SET embedding=EXCLUDED.embedding, embedded_at=NOW()""",
                rows_out,
            )
            total_ok += len(rows_out)
    print(f"  Guidelines done: {total_ok}/{len(rows)} embedded")


async def embed_snomed(pool: asyncpg.Pool) -> None:
    print("\n=== Embedding: snomed.concept_embeddings (~360k FSNs — expect 1-2+ hours) ===")
    if not await _check_ollama():
        return

    # Embed one FSN per active concept
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """SELECT DISTINCT ON (concept_id) concept_id, term
               FROM snomed.descriptions
               WHERE active = TRUE AND type_id = 900000000000003001  -- FSN type
               ORDER BY concept_id"""
        )
    print(f"  SNOMED active concepts (FSN): {len(rows)}")
    batches = [rows[i:i + _BATCH_SIZE] for i in range(0, len(rows), _BATCH_SIZE)]
    total_ok = 0
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        for batch in _progress(batches, "SNOMED"):
            texts = [r["term"] for r in batch]
            vecs = await _embed_batch(client, texts)
            rows_out = [
                (batch[j]["concept_id"], f"[{','.join(str(x) for x in vecs[j])}]")
                for j in range(len(batch)) if vecs[j] is not None
            ]
            await _upsert(pool,
                """INSERT INTO snomed.concept_embeddings (concept_id, embedding)
                   VALUES ($1, $2::halfvec)
                   ON CONFLICT (concept_id) DO UPDATE
                   SET embedding=EXCLUDED.embedding, embedded_at=NOW()""",
                rows_out,
            )
            total_ok += len(rows_out)
    print(f"  SNOMED done: {total_ok}/{len(rows)} embedded")
