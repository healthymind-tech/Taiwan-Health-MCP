"""
Redis cache layer.
Call init_client() at startup, then use @cached() decorator or get_client() directly.
"""

import functools
import hashlib
import json
from typing import Any, Callable, Optional

import redis.asyncio as redis

import metrics as _metrics

_client: Optional[redis.Redis] = None


async def init_client(url: str) -> redis.Redis:
    """Create (or return the existing) Redis client and verify connectivity.

    Idempotent — safe to call from multiple FastMCP session lifespans.

    Args:
        url: Redis connection URL (e.g. ``redis://localhost:6379/0``).

    Returns:
        The initialised ``redis.asyncio.Redis`` singleton.
    """
    global _client
    if _client is not None:
        return _client
    _client = redis.from_url(url, encoding="utf-8", decode_responses=True)
    await _client.ping()
    return _client


async def close_client() -> None:
    """Close the Redis connection and reset the singleton to ``None``."""
    global _client
    if _client:
        await _client.aclose()
        _client = None


def get_client() -> redis.Redis:
    """Return the active Redis client.

    Returns:
        The ``redis.asyncio.Redis`` singleton.

    Raises:
        RuntimeError: If ``init_client()`` has not been called yet.
    """
    if _client is None:
        raise RuntimeError("Redis client not initialized — call init_client() first")
    return _client


def cached(ttl: int = 3600, prefix: str = "") -> Callable:
    """
    Async cache decorator with Prometheus hit/miss tracking.

    Usage:
        @cached(ttl=300, prefix="icd")
        async def search_codes(keyword: str) -> str:
            ...
    """
    def decorator(func: Callable) -> Callable:
        @functools.wraps(func)
        async def wrapper(*args: Any, **kwargs: Any) -> Any:
            ns = prefix or func.__qualname__
            key_data = json.dumps({"a": args[1:], "k": kwargs}, sort_keys=True, default=str)
            digest = hashlib.sha256(key_data.encode()).hexdigest()[:16]
            cache_key = f"mcp:{ns}:{digest}"

            try:
                client = get_client()
                hit = await client.get(cache_key)
                if hit is not None:
                    _metrics.record_cache_op(ns, "hit")
                    return hit
                result = await func(*args, **kwargs)
                if result is not None:
                    await client.setex(
                        cache_key,
                        ttl,
                        result if isinstance(result, str) else json.dumps(result),
                    )
                _metrics.record_cache_op(ns, "miss")
                return result
            except Exception:
                # Cache failure must never break the actual query
                _metrics.record_cache_op(ns, "error")
                return await func(*args, **kwargs)

        return wrapper
    return decorator


async def warm_up(keys: list[tuple[str, Any, int]]) -> int:
    """
    Pre-warm the cache for a list of (cache_key, value, ttl) tuples.
    Returns the number of keys successfully written.
    Called from server lifespan after all services are ready.
    """
    if _client is None:
        return 0
    written = 0
    for key, value, ttl in keys:
        try:
            serialised = value if isinstance(value, str) else json.dumps(value)
            await _client.setex(key, ttl, serialised)
            written += 1
        except Exception:
            pass
    return written
