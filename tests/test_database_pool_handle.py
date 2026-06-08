"""Tests for the connection-pool lifecycle: the reset-safe handle plus the
self-healing build/swap/dispose machinery in ``database.py``.

These guard the "Services pool is closed" class of failure:
 - a long-lived holder must follow a reset_pool() swap (never strand on the old
   pool), and
 - a missing/closed pool must rebuild itself instead of wedging forever.

No real database is used — ``asyncpg.create_pool`` is monkeypatched with a fake
pool so the lifecycle logic is exercised in isolation.
"""

import asyncio

import pytest

import database


# ── fakes ───────────────────────────────────────────────────────────────────
class _FakeConn:
    def __init__(self, pool: "_FakePool") -> None:
        self._pool = pool

    async def fetchval(self, query: str, *args):
        if self._pool.is_closing():
            raise RuntimeError("pool is closed")
        # Stand in for SELECT pg_is_in_recovery() and any other fetchval.
        return False if "recovery" in query else f"{self._pool.tag}:{query}"


class _FakeAcquire:
    def __init__(self, pool: "_FakePool") -> None:
        self._pool = pool

    async def __aenter__(self) -> _FakeConn:
        if self._pool.is_closing():
            raise RuntimeError("pool is closed")
        return _FakeConn(self._pool)

    async def __aexit__(self, *exc) -> bool:
        return False


class _FakePool:
    def __init__(self, tag: str) -> None:
        self.tag = tag
        self._closing = False
        self.closed = False

    def is_closing(self) -> bool:
        return self._closing

    async def close(self) -> None:
        self.closed = True
        self._closing = True

    def terminate(self) -> None:
        self.closed = True
        self._closing = True

    def acquire(self):
        return _FakeAcquire(self)

    async def fetchval(self, query: str, *args):
        if self.is_closing():
            raise RuntimeError("pool is closed")
        return f"{self.tag}:{query}"

    def get_size(self) -> int:
        return 7 if self.tag == "p0" else 9


@pytest.fixture
def fake_create(monkeypatch):
    """Monkeypatch asyncpg.create_pool to hand out sequential fake pools and
    record how many times it was called."""
    state = {"n": 0, "fail": False}

    async def _create_pool(dsn, **kwargs):
        if state["fail"]:
            raise OSError("connection refused")
        pool = _FakePool(f"p{state['n']}")
        state["n"] += 1
        return pool

    monkeypatch.setattr(database.asyncpg, "create_pool", _create_pool)
    return state


@pytest.fixture(autouse=True)
def _isolate_pool_state():
    """Save/restore module globals and give each test a fresh lock bound to its
    own event loop."""
    saved = (database._pool, database._dsn, dict(database._pool_kwargs))
    database._pool = None
    database._dsn = "postgresql://fake/db"
    database._pool_kwargs = {}
    database._pool_lock = asyncio.Lock()
    yield
    database._pool, database._dsn, database._pool_kwargs = (
        saved[0],
        saved[1],
        saved[2],
    )


async def _drain_disposals():
    """Let background _dispose_pool tasks run to completion."""
    for _ in range(3):
        await asyncio.sleep(0)
    if database._disposals:
        await asyncio.gather(*list(database._disposals), return_exceptions=True)


# ── handle: reset-safe delegation ────────────────────────────────────────────
async def test_handle_forwards_to_current_pool():
    database._pool = _FakePool("p0")
    handle = database.pool_handle()
    assert await handle.fetchval("SELECT 1") == "p0:SELECT 1"
    assert handle.get_size() == 7


async def test_handle_follows_pool_swap():
    """The same captured handle must follow a swap (the core property)."""
    database._pool = _FakePool("p0")
    handle = database.pool_handle()  # captured once, like a service at startup
    assert handle.get_size() == 7

    database._pool = _FakePool("p9tag")  # simulate reset_pool() replacing it
    database._pool.tag = "p9"
    assert handle.get_size() == 9
    assert await handle.fetchval("q") == "p9:q"


async def test_handle_getattr_is_transparent():
    """Arbitrary pool attributes (not an allowlist) delegate to the live pool."""
    database._pool = _FakePool("p0")
    handle = database.pool_handle()
    assert handle.is_closing() is False
    async with handle.acquire() as conn:
        assert await conn.fetchval("x") == "p0:x"


async def test_handle_raises_when_pool_absent():
    database._pool = None
    handle = database.pool_handle()
    with pytest.raises(RuntimeError, match="not initialized"):
        handle.get_size()


# ── ensure_pool: self-heal ───────────────────────────────────────────────────
async def test_ensure_pool_builds_when_none(fake_create):
    database._pool = None
    pool = await database.ensure_pool()
    assert pool is database._pool
    assert fake_create["n"] == 1


async def test_ensure_pool_rebuilds_when_closing_and_disposes_old(fake_create):
    old = _FakePool("old")
    old._closing = True
    database._pool = old
    new = await database.ensure_pool()
    assert new is not old
    assert database._pool is new
    await _drain_disposals()
    assert old.closed is True  # the dead pool was retired in the background


async def test_ensure_pool_noop_when_healthy(fake_create):
    healthy = _FakePool("p0")
    database._pool = healthy
    same = await database.ensure_pool()
    assert same is healthy
    assert fake_create["n"] == 0  # no rebuild


async def test_ensure_pool_raises_without_dsn(fake_create):
    database._pool = None
    database._dsn = None
    with pytest.raises(RuntimeError, match="not initialized"):
        await database.ensure_pool()


# ── init_pool: rebuilds a closed pool, reuses a healthy one ──────────────────
async def test_init_pool_returns_existing_when_healthy(fake_create):
    healthy = _FakePool("p0")
    database._pool = healthy
    got = await database.init_pool("postgresql://fake/db")
    assert got is healthy
    assert fake_create["n"] == 0


async def test_init_pool_rebuilds_when_closed(fake_create):
    dead = _FakePool("dead")
    dead._closing = True
    database._pool = dead
    got = await database.init_pool("postgresql://fake/db")
    assert got is not dead
    assert fake_create["n"] == 1


# ── reset_pool: force swap with no None window ───────────────────────────────
async def test_reset_pool_force_rebuilds_and_keeps_pool_live(fake_create):
    healthy = _FakePool("p0")
    database._pool = healthy
    new = await database.reset_pool()
    assert new is not healthy
    assert database._pool is new          # published…
    assert database._pool is not None     # …and never None during the swap
    await _drain_disposals()
    assert healthy.closed is True


# ── healthcheck: self-heals, never raises ────────────────────────────────────
async def test_healthcheck_self_heals_missing_pool(fake_create):
    database._pool = None
    result = await database.healthcheck()
    assert result["ok"] is True
    assert result["in_recovery"] is False
    assert database._pool is not None


async def test_healthcheck_reports_down_when_build_fails(fake_create):
    database._pool = None
    fake_create["fail"] = True  # DB unreachable → create_pool raises
    result = await database.healthcheck()
    assert result["ok"] is False
    assert result["error"]


# ── close_pool then recover ──────────────────────────────────────────────────
async def test_close_pool_then_ensure_rebuilds(fake_create):
    pool = _FakePool("p0")
    database._pool = pool
    await database.close_pool()
    assert database._pool is None
    assert pool.closed is True
    # A stray close must not wedge the process: the next ensure rebuilds.
    rebuilt = await database.ensure_pool()
    assert rebuilt is not None
    assert fake_create["n"] == 1
