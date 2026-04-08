"""
Async PostgreSQL connection pool (asyncpg).
Call init_pool() once at server startup, then use get_pool() anywhere.

statement_cache_size=0 must be set when connecting through pgBouncer in
transaction mode, because pgBouncer does not support named prepared statements.
"""

from typing import Any, Optional

import asyncpg

_pool: Optional[asyncpg.Pool] = None


async def init_pool(
    dsn: str,
    min_size: int = 5,
    max_size: int = 20,
    **kwargs: Any,
) -> asyncpg.Pool:
    global _pool
    if _pool is not None:
        return _pool
    _pool = await asyncpg.create_pool(dsn, min_size=min_size, max_size=max_size, **kwargs)
    return _pool


async def close_pool() -> None:
    global _pool
    if _pool:
        await _pool.close()
        _pool = None


def get_pool() -> asyncpg.Pool:
    if _pool is None:
        raise RuntimeError("Database pool not initialized — call init_pool() first")
    return _pool
