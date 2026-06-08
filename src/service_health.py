"""
Shared service health status definitions and helpers.

Each service reports one of three statuses:
  ok         — fully operational (data + embeddings + Ollama all healthy)
  degraded   — data present but semantic search unavailable; falls back to
               keyword-only (FTS).  Still serves requests.
  unavailable — no data; tool is removed from MCP by ModuleStatusManager.

The ``search_mode`` field tells clients which search algorithm was used so
that MCP tool responses can surface the information transparently.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal


@dataclass
class ServiceHealth:
    status: Literal["ok", "degraded", "unavailable"]
    reason: str = ""
    search_mode: Literal["semantic+keyword", "keyword_only", "n/a"] = "n/a"

    def as_dict(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "reason": self.reason,
            "search_mode": self.search_mode,
        }


# ── Helpers ──────────────────────────────────────────────────────────────────


async def check_embedding_health(
    pool: Any,
    embedding_svc: Any | None,
    *,
    embed_count_sql: str,
) -> ServiceHealth:
    """Return health for a service that uses pgvector embeddings + Ollama.

    Args:
        pool: asyncpg Pool.
        embedding_svc: EmbeddingService instance (or None if not initialised).
        embed_count_sql: SQL that returns the number of rows in the embedding
            table, e.g. ``"SELECT COUNT(*) FROM icd.diagnosis_embeddings"``.
    """
    ollama_ok = bool(
        embedding_svc
        and embedding_svc.enabled
        and getattr(embedding_svc, "_available", False)
    )

    try:
        async with pool.acquire() as conn:
            embed_count = int(await conn.fetchval(embed_count_sql) or 0)
        has_embeddings = embed_count > 0
    except Exception:
        has_embeddings = False

    if ollama_ok and has_embeddings:
        return ServiceHealth(status="ok", search_mode="semantic+keyword")
    elif not has_embeddings and not ollama_ok:
        return ServiceHealth(
            status="degraded",
            reason="Embeddings not generated; Ollama unreachable",
            search_mode="keyword_only",
        )
    elif not has_embeddings:
        return ServiceHealth(
            status="degraded",
            reason="Embeddings not generated — run Generate Embeddings",
            search_mode="keyword_only",
        )
    else:
        return ServiceHealth(
            status="degraded",
            reason="Ollama unreachable — semantic search temporarily disabled",
            search_mode="keyword_only",
        )
