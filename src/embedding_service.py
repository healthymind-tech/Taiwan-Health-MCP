"""
EmbeddingService — async Ollama client for text embeddings.

Provides vector embeddings for hybrid (BM25 + pgvector) search across food,
health food, and drug datasets. Falls back to None on any error so callers
can degrade gracefully to keyword-only search.

Config env vars:
  OLLAMA_BASE_URL        e.g. http://192.168.1.100:11434  (leave unset to disable)
  OLLAMA_EMBED_MODEL     default: qwen3-embedding:0.6b
  OLLAMA_EMBED_TIMEOUT   seconds, default: 30
  OLLAMA_EMBED_BATCH_SIZE  default: 32
"""

from __future__ import annotations

import os
from typing import Sequence

import httpx

from utils import log_info, log_warning

_BASE_URL: str = os.getenv("OLLAMA_BASE_URL", "").rstrip("/")
_MODEL: str = os.getenv("OLLAMA_EMBED_MODEL", "qwen3-embedding:0.6b")
_TIMEOUT: float = float(os.getenv("OLLAMA_EMBED_TIMEOUT", "30"))
BATCH_SIZE: int = int(os.getenv("OLLAMA_EMBED_BATCH_SIZE", "32"))


class EmbeddingService:
    """Async Ollama embedding client with automatic fallback to keyword-only search."""

    def __init__(self) -> None:
        self._available: bool = False

    async def initialize(self) -> None:
        if not _BASE_URL:
            log_warning("OLLAMA_BASE_URL not set — semantic search disabled, using keyword-only")
            return
        self._available = await self._ping()
        if self._available:
            log_info("EmbeddingService ready", model=_MODEL, base_url=_BASE_URL)
        else:
            log_warning("Ollama not reachable at startup — will retry on first query", base_url=_BASE_URL)

    async def _ping(self) -> bool:
        if not _BASE_URL:
            return False
        try:
            async with httpx.AsyncClient(timeout=3.0) as client:
                r = await client.get(f"{_BASE_URL}/api/version")
                return r.status_code == 200
        except Exception:
            return False

    @property
    def enabled(self) -> bool:
        return bool(_BASE_URL)

    async def embed(self, text: str) -> list[float] | None:
        """Embed a single text. Returns None if Ollama is unavailable."""
        results = await self.embed_batch([text])
        return results[0]

    async def embed_batch(self, texts: Sequence[str]) -> list[list[float] | None]:
        """Embed multiple texts in one Ollama call.

        Returns a list parallel to *texts*; each item is either a float list
        (success) or None (failure for that item).
        """
        if not _BASE_URL or not texts:
            return [None] * len(texts)
        try:
            async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
                resp = await client.post(
                    f"{_BASE_URL}/api/embed",
                    json={"model": _MODEL, "input": list(texts)},
                )
                resp.raise_for_status()
                embeddings: list = resp.json().get("embeddings", [])
            result: list[list[float] | None] = []
            for i in range(len(texts)):
                result.append(embeddings[i] if i < len(embeddings) else None)
            if not self._available:
                log_info("Ollama connection restored — semantic search re-enabled")
            self._available = True
            return result
        except Exception as exc:
            if self._available:
                log_warning("Ollama embedding failed — falling back to keyword search", error=str(exc))
            self._available = False
            return [None] * len(texts)
