"""Helpers for signalling degraded (keyword-only) hybrid search quality.

A hybrid (BM25 + embedding) search is *degraded to keyword-only* when the
semantic half cannot contribute, for either reason:
  1. the embedding provider returned nothing (``vec_str is None`` — provider
     offline / not configured), or
  2. the module's embeddings table is empty (data loaded but not embedded yet).

In both cases search still works via BM25/FTS, but semantic and cross-language
matching is off (e.g. "heart attack" → "Myocardial infarction" will not surface
purely from FTS). Search methods add a ``search_mode: "keyword_only"`` marker to
their JSON response ONLY in that degraded state, so the calling LLM knows the
results are literal keyword matches rather than semantically ranked. When the
hybrid path is fully working, no marker is added (response shape unchanged).
"""

from __future__ import annotations

import time

from database import PoolLike

# Short TTL: embeddings presence flips only when a (re)embed job runs, so a
# 60-second cache avoids an EXISTS query on every single search call.
_PRESENCE_TTL = 60.0
_presence_cache: dict[str, tuple[float, bool]] = {}

# Marker fields added to a search response when the semantic half was unavailable.
KEYWORD_ONLY_MODE = "keyword_only"
KEYWORD_ONLY_NOTE = (
    "Semantic ranking unavailable (embeddings not built yet or the embedding "
    "provider is offline); results are keyword/BM25 matches only, so "
    "cross-language and synonym matching may miss."
)


async def embeddings_present(
    pool: PoolLike, table: str, ttl: float = _PRESENCE_TTL
) -> bool:
    """Return whether *table* (a fully-qualified embeddings table) has any rows.

    ``table`` is always a hard-coded literal supplied by the caller, never user
    input, so direct interpolation is safe. Result is cached per table for
    *ttl* seconds. Fails closed (returns False) on any DB error.
    """
    now = time.monotonic()
    cached = _presence_cache.get(table)
    if cached is not None and now - cached[0] < ttl:
        return cached[1]
    present = False
    try:
        async with pool.acquire() as conn:
            present = bool(
                await conn.fetchval(f"SELECT EXISTS (SELECT 1 FROM {table})")
            )
    except Exception:
        present = False
    _presence_cache[table] = (now, present)
    return present


def is_keyword_only(vec_str: str | None, has_embeddings: bool) -> bool:
    """True when semantic ranking did not contribute to this query."""
    return vec_str is None or not has_embeddings


def annotate(payload: dict, vec_str: str | None, has_embeddings: bool) -> dict:
    """Add the keyword-only markers to *payload* in place when degraded."""
    if is_keyword_only(vec_str, has_embeddings):
        payload["search_mode"] = KEYWORD_ONLY_MODE
        payload["search_note"] = KEYWORD_ONLY_NOTE
    return payload
