"""Tests for the cache decorator."""

import os
import sys
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))


@pytest.fixture()
def mock_redis():
    """Return a mock Redis client installed into cache._client."""
    import cache as cache_mod
    mock = AsyncMock()
    mock.get = AsyncMock(return_value=None)   # default: cache miss
    mock.setex = AsyncMock()
    original = cache_mod._client
    cache_mod._client = mock
    yield mock
    cache_mod._client = original


@pytest.fixture(autouse=True)
def mock_metrics():
    with patch("metrics.record_cache_op") as m:
        yield m


@pytest.mark.asyncio
async def test_cache_miss_calls_function(mock_redis):
    from cache import cached

    call_count = 0

    @cached(ttl=60, prefix="test")
    async def expensive(x: int) -> str:
        nonlocal call_count
        call_count += 1
        return f"value:{x}"

    result = await expensive(x=1)
    assert result == "value:1"
    assert call_count == 1


@pytest.mark.asyncio
async def test_cache_hit_skips_function(mock_redis):
    from cache import cached

    mock_redis.get = AsyncMock(return_value="cached_value")
    call_count = 0

    @cached(ttl=60, prefix="test")
    async def expensive(x: int) -> str:
        nonlocal call_count
        call_count += 1
        return f"value:{x}"

    result = await expensive(x=1)
    assert result == "cached_value"
    assert call_count == 0


@pytest.mark.asyncio
async def test_cache_failure_falls_through(mock_redis):
    """If Redis raises, the function still executes."""
    from cache import cached

    mock_redis.get = AsyncMock(side_effect=ConnectionError("redis down"))

    @cached(ttl=60, prefix="test")
    async def expensive() -> str:
        return "fallback"

    result = await expensive()
    assert result == "fallback"


@pytest.mark.asyncio
async def test_cache_miss_records_metric(mock_redis, mock_metrics):
    from cache import cached

    @cached(ttl=60, prefix="myprefix")
    async def fn() -> str:
        return "x"

    await fn()
    mock_metrics.assert_called_once()
    args = mock_metrics.call_args[0]
    assert args[1] == "miss"


@pytest.mark.asyncio
async def test_cache_hit_records_metric(mock_redis, mock_metrics):
    from cache import cached

    mock_redis.get = AsyncMock(return_value="hit_value")

    @cached(ttl=60, prefix="myprefix")
    async def fn() -> str:
        return "x"

    await fn()
    args = mock_metrics.call_args[0]
    assert args[1] == "hit"
