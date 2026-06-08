"""
Embedding Loader — generate pgvector embeddings for hybrid search.

Calls Ollama /api/embed in batches and upserts into:
  - food_nutrition.food_embeddings            (~2181 unique foods)
  - food_nutrition.ingredient_embeddings      (~1702 ingredients)
  - health_supplements.item_embeddings               (~555 items)
  - icd.diagnosis_embeddings                  (~73k ICD-10-CM codes)
  - loinc.concept_embeddings                  (~87k LOINC concepts)
  - guideline.guideline_embeddings            (~50 guidelines)
  - snomed.concept_embeddings                 (~360k concepts — slow, 1-2+ hours)

Incremental: each row's embedded text is hashed (source_hash column); a row is
(re)embedded only when it is new or its text changed since the last run, so a
re-embed of an unchanged module is near-instant instead of re-embedding every
row. Rows whose source was deleted are pruned. Each run records a per-module
marker in admin.module_embed_log. Run --embed after data loaders.

Config env vars:
  OLLAMA_BASE_URL, OLLAMA_EMBED_MODEL, OLLAMA_EMBED_DIMENSIONS,
  OLLAMA_EMBED_TIMEOUT, OLLAMA_EMBED_BATCH_SIZE
"""

from __future__ import annotations

import hashlib
import os
from typing import Any, Callable

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


_PROVIDER: str = "ollama"
_API_KEY: str = ""
_GOOGLE_BASE = "https://generativelanguage.googleapis.com"


def configure(values: dict) -> None:
    """Override embedding settings from a DB settings dict (admin_settings
    'embedding' group). The worker calls this at the start of each embed job so
    batch embedding uses the current DB-configured provider/endpoint/model
    without a restart. Embed jobs share a single resource so this never races."""
    global _BASE_URL, _MODEL, _DIMENSIONS, _TIMEOUT, _BATCH_SIZE, _PROVIDER, _API_KEY
    _PROVIDER = str(values.get("provider", "ollama") or "ollama").strip().lower()
    _BASE_URL = str(values.get("base_url", "") or "").rstrip("/")
    _API_KEY = str(values.get("api_key", "") or "")
    _MODEL = str(values.get("model", "") or "")
    _DIMENSIONS = int(values.get("dimensions", 1024) or 1024)
    _TIMEOUT = float(values.get("timeout", 30) or 30)
    _BATCH_SIZE = int(values.get("batch_size", 32) or 32)

# All (schema, table, column) triples that hold embedding vectors.
# Used by ensure_dimensions() to ALTER TABLE when OLLAMA_EMBED_DIMENSIONS changes.
_EMBEDDING_COLUMNS: list[tuple[str, str, str]] = [
    ("icd", "diagnosis_embeddings", "embedding"),
    ("health_supplements", "item_embeddings", "embedding"),
    ("food_nutrition", "food_embeddings", "embedding"),
    ("food_nutrition", "ingredient_embeddings", "embedding"),
    ("loinc", "concept_embeddings", "embedding"),
    ("guideline", "guideline_embeddings", "embedding"),
    ("snomed", "concept_embeddings", "embedding"),
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
                schema,
                table,
                col,
            )
            if row is None:
                print(f"  {schema}.{table} not found, skipping")
                continue

            current_dim = row["atttypmod"]
            if current_dim == _DIMENSIONS:
                print(f"  {schema}.{table}.{col}: already {_DIMENSIONS}d — OK")
                continue

            print(
                f"  {schema}.{table}.{col}: {current_dim}d → {_DIMENSIONS}d  (ALTER TABLE)"
            )
            fqt = f"{schema}.{table}"
            # DROP CASCADE removes any dependent HNSW index automatically
            await conn.execute(f"ALTER TABLE {fqt} DROP COLUMN IF EXISTS {col} CASCADE")
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
    """Provider readiness check (name kept for callers). For ollama, pings
    /api/version; for openai/google, confirms a base/key is present."""
    if _PROVIDER == "ollama":
        if not _BASE_URL:
            print("  Embedding base URL not set — skipping embedding generation")
            return False
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                r = await client.get(f"{_BASE_URL}/api/version")
                if r.status_code == 200:
                    print(f"  Ollama OK  url={_BASE_URL}  model={_MODEL}"
                          f"  dimensions={_DIMENSIONS}  batch_size={_BATCH_SIZE}")
                    return True
        except Exception:
            pass
        print(f"  [error] Ollama not reachable at {_BASE_URL} — skipping embedding")
        return False
    # openai / google: need a model and (api_key for openai/google)
    if not _MODEL or not _API_KEY:
        print(f"  [error] {_PROVIDER} embedding needs a model and API key — skipping")
        return False
    print(f"  {_PROVIDER} embedding  model={_MODEL}  dimensions={_DIMENSIONS}  batch_size={_BATCH_SIZE}")
    return True


async def _embed_batch(
    client: httpx.AsyncClient, texts: list[str]
) -> list[list[float] | None]:
    try:
        embeddings = await _provider_embed(client, texts)
        return [
            embeddings[i] if i < len(embeddings) else None for i in range(len(texts))
        ]
    except Exception as exc:
        print(f"  [warn] {_PROVIDER} batch failed: {exc}", flush=True)
        return [None] * len(texts)


async def _provider_embed(client: httpx.AsyncClient, texts: list[str]) -> list[list[float]]:
    """Embed a batch of texts via the configured provider. Returns a list of
    vectors parallel to *texts*. Raises on HTTP error."""
    if _PROVIDER == "openai":
        base = _BASE_URL if _BASE_URL.endswith("/embeddings") else f"{_BASE_URL}/embeddings"
        body: dict = {"model": _MODEL, "input": texts, "encoding_format": "float"}
        if _DIMENSIONS and _MODEL.startswith("text-embedding-3"):
            body["dimensions"] = _DIMENSIONS
        headers = {"Authorization": f"Bearer {_API_KEY}"} if _API_KEY else {}
        resp = await client.post(base, json=body, headers=headers)
        resp.raise_for_status()
        data = sorted(resp.json().get("data", []), key=lambda d: d.get("index", 0))
        return [d.get("embedding") for d in data]
    if _PROVIDER == "google":
        model_path = _MODEL if _MODEL.startswith("models/") else f"models/{_MODEL}"
        reqs = []
        for t in texts:
            req = {"model": model_path, "content": {"parts": [{"text": t}]}}
            if _DIMENSIONS:
                req["outputDimensionality"] = _DIMENSIONS
            reqs.append(req)
        url = f"{_GOOGLE_BASE}/v1beta/{model_path}:batchEmbedContents"
        resp = await client.post(url, json={"requests": reqs},
                                 headers={"x-goog-api-key": _API_KEY})
        resp.raise_for_status()
        return [e.get("values") for e in resp.json().get("embeddings", [])]
    # default: ollama
    resp = await client.post(f"{_BASE_URL}/api/embed", json={"model": _MODEL, "input": texts})
    resp.raise_for_status()
    return resp.json().get("embeddings", [])


async def _upsert(pool: asyncpg.Pool, sql: str, rows: list[tuple]) -> None:
    if not rows:
        return
    async with pool.acquire() as conn:
        await conn.executemany(sql, rows)


def _text_hash(text: str) -> str:
    """Stable content fingerprint of the exact text fed to the embedding model."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


async def _ensure_embed_infra(pool: asyncpg.Pool, table: str) -> None:
    """Idempotently make sure the incremental columns/log table exist, so the
    loader works against an older DB that predates schema.sql's source_hash /
    module_embed_log (no separate migration needed)."""
    async with pool.acquire() as conn:
        await conn.execute(
            f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS source_hash TEXT"
        )
        await conn.execute(
            """CREATE TABLE IF NOT EXISTS admin.module_embed_log (
                   module_key       TEXT PRIMARY KEY,
                   last_run_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                   source_total     INTEGER,
                   embedded         INTEGER,
                   changed_last_run INTEGER,
                   updated_at       TIMESTAMPTZ DEFAULT NOW()
               )"""
        )


async def _delete_orphans(
    pool: asyncpg.Pool, table: str, key_col: str, key_sql_type: str, keys: list
) -> int:
    """Delete embedding rows whose source key no longer exists. Uses a temp
    table + anti-join so it scales to SNOMED-sized key sets."""
    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute(
                f"CREATE TEMP TABLE _keep (k {key_sql_type} PRIMARY KEY) ON COMMIT DROP"
            )
            await conn.copy_records_to_table(
                "_keep", records=[(k,) for k in keys], columns=["k"]
            )
            res = await conn.execute(
                f"DELETE FROM {table} t "
                f"WHERE NOT EXISTS (SELECT 1 FROM _keep k WHERE k.k = t.{key_col})"
            )
    try:
        return int(res.split()[-1])
    except (ValueError, IndexError):
        return 0


async def _embed_table(
    pool: asyncpg.Pool,
    *,
    table: str,
    key_col: str,
    key_sql_type: str,
    rows: list,
    key_of: Callable[[Any], Any],
    text_of: Callable[[Any], str],
    desc: str,
) -> dict:
    """Incrementally embed one source→embedding table.

    Only rows whose embedded text is new or changed (by sha256 of the exact
    text) are sent to the model; orphaned embedding rows are pruned. The text is
    computed once and used for both the hash and the embedding, so they can
    never drift. Returns stats for the caller to record in module_embed_log.
    """
    await _ensure_embed_infra(pool, table)

    # An empty source means "not loaded yet" — never wipe existing embeddings.
    if not rows:
        async with pool.acquire() as conn:
            total_now = int(await conn.fetchval(f"SELECT COUNT(*) FROM {table}") or 0)
        return {"source_total": 0, "changed": 0, "embedded_total": total_now, "deleted": 0}

    # 1. Current keys + text + hash (text computed once).
    current = [(key_of(r), text_of(r)) for r in rows]
    current = [(k, t, _text_hash(t)) for (k, t) in current]
    keys = [c[0] for c in current]

    # 2. Existing hashes for this table.
    async with pool.acquire() as conn:
        existing_rows = await conn.fetch(f"SELECT {key_col}, source_hash FROM {table}")
    existing = {row[0]: row[1] for row in existing_rows}

    # 3. New or content-changed rows only.
    to_embed = [(k, t, h) for (k, t, h) in current if existing.get(k) != h]
    print(f"  {desc}: {len(rows)} source, {len(to_embed)} new/changed", flush=True)

    # 4-5. Embed just those, upserting the fresh hash alongside the vector.
    sql = (
        f"INSERT INTO {table} ({key_col}, embedding, source_hash) "
        f"VALUES ($1, $2::halfvec, $3) "
        f"ON CONFLICT ({key_col}) DO UPDATE "
        f"SET embedding=EXCLUDED.embedding, source_hash=EXCLUDED.source_hash, embedded_at=NOW()"
    )
    batches = [to_embed[i : i + _BATCH_SIZE] for i in range(0, len(to_embed), _BATCH_SIZE)]
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        for batch in _progress(batches, desc):
            vecs = await _embed_batch(client, [t for (_, t, _) in batch])
            out = [
                (batch[j][0], f"[{','.join(str(x) for x in vecs[j])}]", batch[j][2])
                for j in range(len(batch))
                if vecs[j] is not None
            ]
            await _upsert(pool, sql, out)

    # 6. Prune embeddings whose source row is gone.
    deleted = await _delete_orphans(pool, table, key_col, key_sql_type, keys)

    async with pool.acquire() as conn:
        total_now = int(await conn.fetchval(f"SELECT COUNT(*) FROM {table}") or 0)
    return {
        "source_total": len(rows),
        "changed": len(to_embed),
        "embedded_total": total_now,
        "deleted": deleted,
    }


async def _write_embed_log(
    pool: asyncpg.Pool, module_key: str, *, source_total: int, embedded: int, changed: int
) -> None:
    """Record that an embed run for `module_key` completed now. last_run_at is
    bumped on EVERY run (even a zero-change one) so the UI's stale check stays
    correct under incremental embedding."""
    async with pool.acquire() as conn:
        await conn.execute(
            """INSERT INTO admin.module_embed_log
                   (module_key, last_run_at, source_total, embedded, changed_last_run, updated_at)
               VALUES ($1, NOW(), $2, $3, $4, NOW())
               ON CONFLICT (module_key) DO UPDATE
               SET last_run_at=NOW(), source_total=EXCLUDED.source_total,
                   embedded=EXCLUDED.embedded, changed_last_run=EXCLUDED.changed_last_run,
                   updated_at=NOW()""",
            module_key,
            source_total,
            embedded,
            changed,
        )


async def embed_food_nutrition(pool: asyncpg.Pool) -> None:
    print("\n=== Embedding: food_nutrition ===")
    if not await _check_ollama():
        return

    async with pool.acquire() as conn:
        foods = await conn.fetch(
            """SELECT DISTINCT ON (sample_name) sample_name, common_name, english_name
               FROM food_nutrition.measurements ORDER BY sample_name"""
        )
        ings = await conn.fetch(
            "SELECT id, name_zh, name_en FROM food_nutrition.ingredients"
        )

    s_foods = await _embed_table(
        pool,
        table="food_nutrition.food_embeddings",
        key_col="sample_name",
        key_sql_type="TEXT",
        rows=foods,
        key_of=lambda r: r["sample_name"],
        text_of=lambda r: " ".join(
            filter(None, [r["sample_name"], r["common_name"], r["english_name"]])
        ),
        desc="Foods",
    )
    s_ings = await _embed_table(
        pool,
        table="food_nutrition.ingredient_embeddings",
        key_col="id",
        key_sql_type="INTEGER",
        rows=ings,
        key_of=lambda r: r["id"],
        text_of=lambda r: " ".join(filter(None, [r["name_zh"], r["name_en"]])),
        desc="Ingredients",
    )
    await _write_embed_log(
        pool,
        "food_nutrition",
        source_total=s_foods["source_total"] + s_ings["source_total"],
        embedded=s_foods["embedded_total"] + s_ings["embedded_total"],
        changed=s_foods["changed"] + s_ings["changed"],
    )
    print(
        f"  food_nutrition done: {s_foods['changed'] + s_ings['changed']} (re)embedded, "
        f"{s_foods['deleted'] + s_ings['deleted']} orphans pruned"
    )


async def embed_health_supplements(pool: asyncpg.Pool) -> None:
    print("\n=== Embedding: health_supplements ===")
    if not await _check_ollama():
        return

    async with pool.acquire() as conn:
        items = await conn.fetch(
            "SELECT permit_no, name, benefit_claims FROM health_supplements.items"
        )
    stats = await _embed_table(
        pool,
        table="health_supplements.item_embeddings",
        key_col="permit_no",
        key_sql_type="TEXT",
        rows=items,
        key_of=lambda r: r["permit_no"],
        text_of=lambda r: " ".join(filter(None, [r["name"], r["benefit_claims"]])),
        desc="Health supplements",
    )
    await _write_embed_log(
        pool,
        "health_supplements",
        source_total=stats["source_total"],
        embedded=stats["embedded_total"],
        changed=stats["changed"],
    )
    print(
        f"  Health supplements done: {stats['changed']} (re)embedded, "
        f"{stats['deleted']} orphans pruned, {stats['embedded_total']} total"
    )


async def embed_icd(pool: asyncpg.Pool) -> None:
    print("\n=== Embedding: icd.diagnoses (~73k codes) ===")
    if not await _check_ollama():
        return

    async with pool.acquire() as conn:
        rows = await conn.fetch("SELECT code, name_zh, name_en FROM icd.diagnoses")
    stats = await _embed_table(
        pool,
        table="icd.diagnosis_embeddings",
        key_col="code",
        key_sql_type="TEXT",
        rows=rows,
        key_of=lambda r: r["code"],
        text_of=lambda r: " ".join(filter(None, [r["code"], r["name_zh"], r["name_en"]])),
        desc="ICD diagnoses",
    )
    await _write_embed_log(
        pool,
        "icd",
        source_total=stats["source_total"],
        embedded=stats["embedded_total"],
        changed=stats["changed"],
    )
    print(
        f"  ICD done: {stats['changed']} (re)embedded, "
        f"{stats['deleted']} orphans pruned, {stats['embedded_total']} total"
    )


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

    def _loinc_text(r: Any) -> str:
        return " ".join(
            filter(
                None,
                [
                    r["long_common_name"],
                    r["shortname"],
                    r["name_zh"],
                    r["common_name_zh"],
                    r["component"],
                    r["specimen_type"],
                ],
            )
        )

    stats = await _embed_table(
        pool,
        table="loinc.concept_embeddings",
        key_col="loinc_num",
        key_sql_type="TEXT",
        rows=rows,
        key_of=lambda r: r["loinc_num"],
        text_of=_loinc_text,
        desc="LOINC",
    )
    await _write_embed_log(
        pool,
        "loinc",
        source_total=stats["source_total"],
        embedded=stats["embedded_total"],
        changed=stats["changed"],
    )
    print(
        f"  LOINC done: {stats['changed']} (re)embedded, "
        f"{stats['deleted']} orphans pruned, {stats['embedded_total']} total"
    )


async def embed_guideline(pool: asyncpg.Pool) -> None:
    print("\n=== Embedding: guideline.disease_guidelines ===")
    if not await _check_ollama():
        return

    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT id, disease_name_zh, disease_name_en, guideline_title, guideline_summary FROM guideline.disease_guidelines"
        )
    if not rows:
        print("  No guidelines found — run data-loader --guideline first")
        return

    def _guideline_text(r: Any) -> str:
        return " ".join(
            filter(
                None,
                [
                    r["disease_name_zh"],
                    r["disease_name_en"],
                    r["guideline_title"],
                    r["guideline_summary"],
                ],
            )
        )

    stats = await _embed_table(
        pool,
        table="guideline.guideline_embeddings",
        key_col="id",
        key_sql_type="INTEGER",
        rows=rows,
        key_of=lambda r: r["id"],
        text_of=_guideline_text,
        desc="Guidelines",
    )
    await _write_embed_log(
        pool,
        "guideline",
        source_total=stats["source_total"],
        embedded=stats["embedded_total"],
        changed=stats["changed"],
    )
    print(
        f"  Guidelines done: {stats['changed']} (re)embedded, "
        f"{stats['deleted']} orphans pruned, {stats['embedded_total']} total"
    )


async def embed_snomed(pool: asyncpg.Pool) -> None:
    print(
        "\n=== Embedding: snomed.concept_embeddings (~360k FSNs — expect 1-2+ hours) ==="
    )
    if not await _check_ollama():
        return

    # Embed one FSN per active concept
    async with pool.acquire() as conn:
        rows = await conn.fetch("""SELECT DISTINCT ON (concept_id) concept_id, term
               FROM snomed.descriptions
               WHERE active = TRUE AND type_id = 900000000000003001  -- FSN type
               ORDER BY concept_id""")
    stats = await _embed_table(
        pool,
        table="snomed.concept_embeddings",
        key_col="concept_id",
        key_sql_type="BIGINT",
        rows=rows,
        key_of=lambda r: r["concept_id"],
        text_of=lambda r: r["term"] or "",
        desc="SNOMED",
    )
    await _write_embed_log(
        pool,
        "snomed",
        source_total=stats["source_total"],
        embedded=stats["embedded_total"],
        changed=stats["changed"],
    )
    print(
        f"  SNOMED done: {stats['changed']} (re)embedded, "
        f"{stats['deleted']} orphans pruned, {stats['embedded_total']} total"
    )
