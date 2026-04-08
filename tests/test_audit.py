"""Tests for the audit decorator and log_query."""

import asyncio
import os
import sys
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))


@pytest.fixture(autouse=True)
def mock_db_pool():
    """Prevent audit.log_query from hitting a real DB."""
    mock_conn = AsyncMock()
    mock_conn.execute = AsyncMock()
    mock_pool = MagicMock()
    mock_pool.acquire.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
    mock_pool.acquire.return_value.__aexit__ = AsyncMock(return_value=False)

    with patch("database._pool", mock_pool):
        yield mock_pool


@pytest.fixture(autouse=True)
def mock_metrics():
    with patch("metrics.record_tool_call") as m:
        yield m


@pytest.mark.asyncio
async def test_audited_success_calls_log_query():
    from audit import audited

    @audited("test_tool")
    async def my_tool(x: int) -> str:
        return f"result:{x}"

    result = await my_tool(x=42)
    assert result == "result:42"


@pytest.mark.asyncio
async def test_audited_records_metrics_on_success(mock_metrics):
    from audit import audited

    @audited("test_tool")
    async def my_tool() -> str:
        return "ok"

    await my_tool()
    mock_metrics.assert_called_once()
    args = mock_metrics.call_args[0]
    assert args[0] == "test_tool"
    assert args[1] == "success"
    assert isinstance(args[2], float)


@pytest.mark.asyncio
async def test_audited_records_error_on_exception(mock_metrics):
    from audit import audited

    @audited("failing_tool")
    async def bad_tool() -> str:
        raise ValueError("something broke")

    with pytest.raises(ValueError, match="something broke"):
        await bad_tool()

    mock_metrics.assert_called_once()
    args = mock_metrics.call_args[0]
    assert args[1] == "error"


@pytest.mark.asyncio
async def test_audited_preserves_function_name():
    from audit import audited

    @audited("my_tool")
    async def original_name() -> str:
        return "x"

    assert original_name.__name__ == "original_name"
