"""
EmbeddingService — async Ollama client for text embeddings.

Provides vector embeddings for hybrid (BM25 + pgvector) search across food,
health supplements, and drug modules. Falls back to None on any error so callers
can degrade gracefully to keyword-only search.

Config env vars:
  OLLAMA_BASE_URL          e.g. http://192.168.1.100:11434  (leave unset to disable)
  OLLAMA_EMBED_MODEL       default: qwen3-embedding:0.6b
  OLLAMA_EMBED_DIMENSIONS  output vector size, default: 1024
  OLLAMA_EMBED_TIMEOUT     seconds, default: 30
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
DIMENSIONS: int = int(os.getenv("OLLAMA_EMBED_DIMENSIONS", "1024"))


def configure(values: dict) -> None:
    """Override the Ollama embedding settings from a DB settings dict
    (admin_settings 'embedding' group). Called at startup and on settings save
    so query-time semantic search picks up changes without a restart."""
    global _BASE_URL, _MODEL, _TIMEOUT, BATCH_SIZE, DIMENSIONS, _PROVIDER, _API_KEY
    _PROVIDER = str(values.get("provider", "ollama") or "ollama").strip().lower()
    _BASE_URL = str(values.get("base_url", "") or "").rstrip("/")
    _API_KEY = str(values.get("api_key", "") or "")
    _MODEL = str(values.get("model", "") or "")
    _TIMEOUT = float(values.get("timeout", 30) or 30)
    BATCH_SIZE = int(values.get("batch_size", 32) or 32)
    DIMENSIONS = int(values.get("dimensions", 1024) or 1024)


_PROVIDER: str = "ollama"
_API_KEY: str = ""
_GOOGLE_BASE = "https://generativelanguage.googleapis.com"


def _configured() -> bool:
    """Whether the embedding provider has enough config to attempt a call."""
    if _PROVIDER == "ollama":
        return bool(_BASE_URL)
    return bool(_MODEL and _API_KEY)


async def _provider_embed(client, texts: list[str]) -> list:
    """Embed a batch via the configured provider. Raises on HTTP error."""
    if _PROVIDER == "openai":
        base = (
            _BASE_URL
            if _BASE_URL.endswith("/embeddings")
            else f"{_BASE_URL}/embeddings"
        )
        body: dict = {"model": _MODEL, "input": texts, "encoding_format": "float"}
        if DIMENSIONS and _MODEL.startswith("text-embedding-3"):
            body["dimensions"] = DIMENSIONS
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
            if DIMENSIONS:
                req["outputDimensionality"] = DIMENSIONS
            reqs.append(req)
        resp = await client.post(
            f"{_GOOGLE_BASE}/v1beta/{model_path}:batchEmbedContents",
            json={"requests": reqs},
            headers={"x-goog-api-key": _API_KEY},
        )
        resp.raise_for_status()
        return [e.get("values") for e in resp.json().get("embeddings", [])]
    resp = await client.post(
        f"{_BASE_URL}/api/embed", json={"model": _MODEL, "input": texts}
    )
    resp.raise_for_status()
    return resp.json().get("embeddings", [])


class EmbeddingService:
    """Async Ollama embedding client with automatic fallback to keyword-only search."""

    def __init__(self) -> None:
        self._available: bool = False

    async def initialize(self) -> None:
        if not _configured():
            log_warning(
                "Embedding provider not configured — semantic search disabled, using keyword-only"
            )
            return
        self._available = await self._ping()
        if self._available:
            log_info(
                "EmbeddingService ready",
                provider=_PROVIDER,
                model=_MODEL,
                base_url=_BASE_URL,
            )
        else:
            log_warning(
                "Embedding provider not reachable at startup — will retry on first query",
                provider=_PROVIDER,
                base_url=_BASE_URL,
            )

    async def _ping(self) -> bool:
        if not _configured():
            return False
        try:
            if _PROVIDER == "ollama":
                async with httpx.AsyncClient(timeout=3.0) as client:
                    r = await client.get(f"{_BASE_URL}/api/version")
                    return r.status_code == 200
            # openai / google: a successful 1-item embed is the cheapest real check
            async with httpx.AsyncClient(timeout=8.0) as client:
                out = await _provider_embed(client, ["ping"])
                return bool(out and out[0])
        except Exception:
            return False

    @property
    def enabled(self) -> bool:
        return _configured()

    async def embed(self, text: str) -> list[float] | None:
        """Embed a single text string via Ollama.

        Args:
            text: The input text to embed.

        Returns:
            A float vector, or ``None`` if Ollama is unavailable.
        """
        results = await self.embed_batch([text])
        return results[0]

    async def embed_batch(self, texts: Sequence[str]) -> list[list[float] | None]:
        """Embed multiple texts in one Ollama call.

        Returns a list parallel to *texts*; each item is either a float list
        (success) or None (failure for that item).
        """
        if not _configured() or not texts:
            return [None] * len(texts)
        try:
            async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
                embeddings = await _provider_embed(client, list(texts))
            result: list[list[float] | None] = []
            for i in range(len(texts)):
                result.append(embeddings[i] if i < len(embeddings) else None)
            if not self._available:
                log_info("Embedding connection restored — semantic search re-enabled")
            self._available = True
            return result
        except Exception as exc:
            if self._available:
                log_warning(
                    "Embedding failed — falling back to keyword search",
                    error=str(exc),
                )
            self._available = False
            return [None] * len(texts)
