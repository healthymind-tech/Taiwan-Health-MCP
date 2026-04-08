"""
Shared fixtures for all Taiwan Health MCP tests.

Sets up DATABASE_URL before any server module import, and provides
autouse mocks for audit (DB pool), metrics, and Redis cache so that
tool-level tests never touch real infrastructure.
"""

import os
import sys
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# ── Environment setup (must happen before any src/ import) ───────────────────
os.environ.setdefault("DATABASE_URL", "postgresql://test:test@localhost:5432/test_taiwan_health")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))


# ── Autouse: mock DB pool so @audited never hits a real database ──────────────
@pytest.fixture(autouse=True)
def mock_db_pool():
    mock_conn = AsyncMock()
    mock_conn.execute = AsyncMock()
    mock_pool = MagicMock()
    mock_pool.acquire.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
    mock_pool.acquire.return_value.__aexit__ = AsyncMock(return_value=False)
    with patch("database._pool", mock_pool):
        yield mock_pool


# ── Autouse: mock Prometheus metrics ─────────────────────────────────────────
@pytest.fixture(autouse=True)
def mock_metrics():
    with patch("metrics.record_tool_call") as m:
        yield m


# ── Autouse: mock Redis client so @cached falls through cleanly ───────────────
@pytest.fixture(autouse=True)
def mock_redis():
    import cache as cache_mod
    mock = AsyncMock()
    mock.get = AsyncMock(return_value=None)   # always miss → execute function
    mock.setex = AsyncMock()
    original = cache_mod._client
    cache_mod._client = mock
    yield mock
    cache_mod._client = original
