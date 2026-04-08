"""
Prometheus metrics.
Exposes a /metrics HTTP endpoint on METRICS_PORT (default 9090).

Usage:
    from metrics import record_tool_call, record_cache_op, start_metrics_server

Metrics exposed:
    mcp_tool_requests_total{tool, status}          Counter
    mcp_tool_duration_seconds{tool}                Histogram
    mcp_cache_operations_total{prefix, result}     Counter
    mcp_db_pool_size                               Gauge
    mcp_db_pool_checked_out                        Gauge
"""

import asyncio
import os
import time
from typing import Callable, Any

from prometheus_client import (
    Counter,
    Gauge,
    Histogram,
    start_http_server as _prom_start_http_server,
    REGISTRY,
)

from utils import log_info, log_error

# ── metric definitions ───────────────────────────────────────────────────────

tool_requests = Counter(
    "mcp_tool_requests_total",
    "Total MCP tool invocations",
    ["tool", "status"],
)

tool_duration = Histogram(
    "mcp_tool_duration_seconds",
    "MCP tool execution latency",
    ["tool"],
    buckets=[0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0],
)

cache_ops = Counter(
    "mcp_cache_operations_total",
    "Redis cache hit/miss counts",
    ["prefix", "result"],   # result: hit | miss | error
)

db_pool_size = Gauge(
    "mcp_db_pool_size",
    "Total connections in the asyncpg pool",
)

db_pool_checked_out = Gauge(
    "mcp_db_pool_checked_out",
    "Connections currently checked out from the asyncpg pool",
)


# ── helpers called from other modules ────────────────────────────────────────

def record_tool_call(tool: str, status: str, duration_s: float) -> None:
    """Record one tool invocation. status: 'success' | 'error'"""
    tool_requests.labels(tool=tool, status=status).inc()
    tool_duration.labels(tool=tool).observe(duration_s)


def record_cache_op(prefix: str, result: str) -> None:
    """Record a cache operation. result: 'hit' | 'miss' | 'error'"""
    cache_ops.labels(prefix=prefix, result=result).inc()


def update_db_pool_stats(pool) -> None:
    """Update pool gauges from an asyncpg Pool object."""
    try:
        db_pool_size.set(pool.get_size())
        db_pool_checked_out.set(pool.get_size() - pool.get_idle_size())
    except Exception:
        pass


# ── periodic DB stats collection ────────────────────────────────────────────

async def _collect_db_stats_loop(get_pool_fn: Callable, interval: int = 15) -> None:
    while True:
        try:
            pool = get_pool_fn()
            update_db_pool_stats(pool)
        except Exception:
            pass
        await asyncio.sleep(interval)


# ── server startup ────────────────────────────────────────────────────────────

_metrics_server_started = False


def start_metrics_server(port: int | None = None) -> int:
    """
    Start the Prometheus HTTP server on *port* (default: METRICS_PORT env var, else 9090).
    Idempotent — safe to call from each FastMCP session lifespan.
    Returns the port actually used.
    """
    global _metrics_server_started
    port = port or int(os.getenv("METRICS_PORT", "9090"))
    if _metrics_server_started:
        return port
    try:
        _prom_start_http_server(port)
        _metrics_server_started = True
        log_info(f"Prometheus metrics server started on :{port}/metrics")
    except OSError as e:
        log_error(f"Could not start metrics server on :{port}: {e}")
    return port


async def start_db_stats_collector(get_pool_fn: Callable, interval: int = 15) -> asyncio.Task:
    """Launch background task that refreshes DB pool gauges every *interval* seconds."""
    return asyncio.create_task(_collect_db_stats_loop(get_pool_fn, interval))
