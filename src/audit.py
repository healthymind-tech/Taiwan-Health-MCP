"""
HIPAA-compliant audit logging + Prometheus metrics integration.
Logs tool_name, a SHA-256 hash of parameters (never raw values), duration, and status.
No PHI is ever written to the audit table.
"""

import hashlib
import json
import time
from functools import wraps
from typing import Any, Callable

import metrics as _metrics
from database import get_pool
from utils import log_error


async def log_query(
    tool_name: str,
    params_hash: str,
    duration_ms: int,
    status: str,
    error_msg: str | None = None,
) -> None:
    try:
        pool = get_pool()
        async with pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO audit.query_log (tool_name, params_hash, duration_ms, status, error_msg)
                VALUES ($1, $2, $3, $4, $5)
                """,
                tool_name,
                params_hash,
                duration_ms,
                status,
                error_msg,
            )
    except Exception as e:
        log_error(f"Audit log write failed: {e}")


def audited(tool_name: str) -> Callable:
    """
    Decorator that wraps an async MCP tool function with:
      - HIPAA audit logging (params SHA-256 hash, never raw values)
      - Prometheus metrics (request count + latency histogram)

    Usage:
        @mcp.tool()
        @audited("search_medical_codes")
        async def search_medical_codes(keyword: str) -> str:
            ...
    """
    def decorator(func: Callable) -> Callable:
        @wraps(func)
        async def wrapper(*args: Any, **kwargs: Any) -> Any:
            start = time.monotonic()
            params_hash = hashlib.sha256(
                json.dumps(kwargs, sort_keys=True, default=str).encode()
            ).hexdigest()[:16]
            try:
                result = await func(*args, **kwargs)
                duration_s = time.monotonic() - start
                duration_ms = int(duration_s * 1000)
                await log_query(tool_name, params_hash, duration_ms, "success")
                _metrics.record_tool_call(tool_name, "success", duration_s)
                return result
            except Exception as e:
                duration_s = time.monotonic() - start
                duration_ms = int(duration_s * 1000)
                await log_query(tool_name, params_hash, duration_ms, "error", str(e)[:500])
                _metrics.record_tool_call(tool_name, "error", duration_s)
                raise

        return wrapper
    return decorator
