"""
Async PostgreSQL connection pool (asyncpg).
Call init_pool() once at server startup, then use get_pool() anywhere.

statement_cache_size=0 must be set when connecting through pgBouncer in
transaction mode, because pgBouncer does not support named prepared statements.
"""

import asyncio
from typing import Any, Optional, Union

import asyncpg

_pool: Optional[asyncpg.Pool] = None
# Remember the args used to build the pool so it can be re-created after a
# database restart (recovery leaves the old pooled connections dead) or after
# the pool was closed for any reason.
_dsn: Optional[str] = None
_pool_kwargs: dict[str, Any] = {}

# Serializes every pool (re)build so concurrent callers (the health monitor's
# probe, a request handler, a recovery recycle) can never race to create two
# pools or tear one down mid-build.
_pool_lock = asyncio.Lock()

# Background pool-disposal tasks are tracked so they are not garbage-collected
# mid-flight (which asyncio warns about); each removes itself when done.
_disposals: "set[asyncio.Task[None]]" = set()

# How long to wait for in-flight connections to be released during a graceful
# close before falling back to an abrupt terminate().
_DISPOSE_TIMEOUT = 5.0


def _is_dead(pool: Optional[asyncpg.Pool]) -> bool:
    """True if there is no usable pool — absent, closing, or closed."""
    if pool is None:
        return True
    is_closing = getattr(pool, "is_closing", None)
    if callable(is_closing):
        try:
            return bool(is_closing())
        except Exception:
            return False
    return False


async def _dispose_pool(pool: asyncpg.Pool, timeout: float = _DISPOSE_TIMEOUT) -> None:
    """Retire an old pool gracefully, then forcibly if it does not drain in time.

    ``close()`` waits for checked-out connections to be released; because the
    pool has already been swapped out by the time this runs, no *new* work goes
    to it, so it normally drains immediately. A stuck connection is bounded by
    the timeout, after which ``terminate()`` closes everything abruptly.
    """
    try:
        await asyncio.wait_for(pool.close(), timeout=timeout)
    except Exception:
        try:
            pool.terminate()
        except Exception:
            pass


def _schedule_dispose(old: Optional[asyncpg.Pool], new: asyncpg.Pool) -> None:
    """Dispose of the superseded pool in the background (never blocks the swap)."""
    if old is None or old is new:
        return
    task = asyncio.create_task(_dispose_pool(old))
    _disposals.add(task)
    task.add_done_callback(_disposals.discard)


async def _build_and_swap() -> asyncpg.Pool:
    """Build a fresh pool, publish it, and retire the previous one in the
    background. Caller MUST hold ``_pool_lock``. The global ``_pool`` never
    becomes ``None`` during the swap, so handle holders never see a gap.
    """
    global _pool
    if _dsn is None:
        raise RuntimeError("Database pool not initialized — call init_pool() first")
    new = await asyncpg.create_pool(_dsn, **_pool_kwargs)
    old = _pool
    _pool = new
    _schedule_dispose(old, new)
    return new


async def init_pool(
    dsn: str,
    min_size: int = 5,
    max_size: int = 20,
    **kwargs: Any,
) -> asyncpg.Pool:
    """Create (or return the existing) asyncpg connection pool.

    Idempotent — safe to call from multiple FastMCP session lifespans. If a
    previous pool exists but has been closed, it is rebuilt rather than handed
    back dead.

    Args:
        dsn: PostgreSQL connection string (DSN or URL).
        min_size: Minimum number of connections kept open.
        max_size: Maximum number of connections in the pool.
        **kwargs: Extra arguments forwarded to ``asyncpg.create_pool``.

    Returns:
        The initialised ``asyncpg.Pool`` singleton.
    """
    global _pool, _dsn, _pool_kwargs
    async with _pool_lock:
        if not _is_dead(_pool):
            return _pool  # type: ignore[return-value]
        _dsn = dsn
        _pool_kwargs = {"min_size": min_size, "max_size": max_size, **kwargs}
        return await _build_and_swap()


async def ensure_pool() -> asyncpg.Pool:
    """Return a live pool, transparently rebuilding it if it is gone or closed.

    This is the self-healing entry point: even if the pool was fully closed
    (e.g. on a worker shutting down, or any future ``close_pool()``), the next
    call rebuilds it from the remembered DSN/params — so recovery never depends
    on a probe that can't succeed while the pool is closed.

    Raises:
        RuntimeError: if ``init_pool()`` was never called (no DSN remembered).
        Exception: propagates ``asyncpg.create_pool`` errors when the database
            is unreachable (the caller treats that as "still down").
    """
    if not _is_dead(_pool):
        return _pool  # type: ignore[return-value]
    async with _pool_lock:
        if not _is_dead(_pool):  # re-check after acquiring the lock
            return _pool  # type: ignore[return-value]
        return await _build_and_swap()


async def reset_pool() -> Optional[asyncpg.Pool]:
    """Force-recreate the pool, discarding now-stale connections.

    Used by the DB health monitor after a database restart/recovery: the old
    pooled connections are dead, so a fresh pool is built and published while
    the old one is drained in the background. Unlike :func:`ensure_pool` this
    rebuilds even when the current pool still looks open.
    """
    if _dsn is None:
        return None
    async with _pool_lock:
        return await _build_and_swap()


async def healthcheck(timeout: float = 2.0) -> dict[str, Any]:
    """Probe database liveness without ever raising.

    Returns a dict ``{ok, in_recovery, error}``. Self-heals a missing/closed
    pool first (so a closed pool can recover on its own), then runs a short,
    bounded query so a hung or unreachable database cannot block the caller.
    """
    try:
        pool = await ensure_pool()
    except Exception as exc:
        return {"ok": False, "in_recovery": False, "error": str(exc)[:300]}

    async def _query() -> bool:
        async with pool.acquire() as conn:
            return bool(await conn.fetchval("SELECT pg_is_in_recovery()"))

    try:
        in_recovery = await asyncio.wait_for(_query(), timeout=timeout)
        return {"ok": True, "in_recovery": in_recovery, "error": ""}
    except Exception as exc:
        return {"ok": False, "in_recovery": False, "error": str(exc)[:300]}


async def close_pool() -> None:
    """Close the connection pool and reset the singleton to ``None``.

    Intended for process shutdown. After this, the next ``ensure_pool()`` /
    ``get_pool()``-via-handle / ``init_pool()`` rebuilds from the remembered
    DSN, so a stray close cannot permanently wedge a still-running process.
    """
    global _pool
    async with _pool_lock:
        old, _pool = _pool, None
    if old is not None:
        await _dispose_pool(old)


def get_pool() -> asyncpg.Pool:
    """Return the active connection pool.

    Returns:
        The ``asyncpg.Pool`` singleton.

    Raises:
        RuntimeError: If ``init_pool()`` has not been called yet.

    Note:
        Returns the *raw* pool — correct for short-lived, per-request use that
        re-fetches each time. For any reference held across a possible
        ``reset_pool()`` (e.g. stored on a service), use :func:`pool_handle`.
    """
    if _pool is None:
        raise RuntimeError("Database pool not initialized — call init_pool() first")
    return _pool


class _PoolHandle:
    """A stable, reset-safe stand-in for the connection pool.

    Long-lived callers (the services, constructed once at startup; long-running
    worker jobs) capture this handle instead of the raw ``asyncpg.Pool``.
    ``reset_pool()`` / ``ensure_pool()`` may swap the underlying pool — e.g.
    when the DB health monitor recovers after a database restart it builds a
    fresh pool and retires the old one. A caller holding the *raw* old pool
    would then fail every query with "pool is closed" forever; a caller holding
    this handle resolves the *current* live pool on each operation and keeps
    working transparently.

    Every attribute access is delegated to the live pool, so the handle stays a
    complete, future-proof substitute for ``asyncpg.Pool`` — including
    ``acquire()`` (``async with``), the ``execute``/``fetch*`` shortcuts, and
    pool introspection (``get_size`` etc.) — with no method allowlist to keep in
    sync.
    """

    @staticmethod
    def _live() -> asyncpg.Pool:
        if _pool is None:
            raise RuntimeError("Database pool not initialized — call init_pool() first")
        return _pool

    def __getattr__(self, name: str) -> Any:
        # Only invoked for names not found on the instance/class, so internal
        # attributes are unaffected and there is no recursion via _live.
        return getattr(self._live(), name)

    def __repr__(self) -> str:
        state = "uninitialized" if _pool is None else f"-> {_pool!r}"
        return f"<reset-safe pool handle {state}>"


_pool_handle = _PoolHandle()


def pool_handle() -> "_PoolHandle":
    """Return the process-wide reset-safe pool handle.

    Prefer this over ``get_pool()`` for any reference that outlives a single
    request (e.g. a service stored on ``self``), so a ``reset_pool()`` swap does
    not strand the holder on a terminated pool. See :class:`_PoolHandle`.
    """
    return _pool_handle


# A pool-shaped dependency: either the raw asyncpg pool (short-lived,
# per-request use) or the reset-safe handle (long-lived holders). Both expose
# the same surface, so functions and services can accept either.
PoolLike = Union[asyncpg.Pool, _PoolHandle]
