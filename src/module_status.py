"""
Module availability tracking for dynamic MCP tool registration.

Checks which modules are loaded in PostgreSQL and maintains a 5-minute cache.
Used by DynamicFastMCP in server.py to add/remove tools based on data availability.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta
from typing import Any, Callable

from mcp.types import ToolAnnotations

from database import PoolLike
from utils import log_info, log_warning

_READ_ONLY = ToolAnnotations(readOnlyHint=True)

CACHE_TTL = timedelta(minutes=5)

# Maps service key → list of readiness requirements.
# Each requirement is (schema.table to COUNT(*), minimum row count).
# A service is ready only when ALL requirements pass.
SERVICE_MODULES: dict[str, list[tuple[str, int]]] = {
    "icd": [("icd.diagnoses", 10_000)],
    "drug": [("drug.licenses", 1)],
    "health_supplements": [("health_supplements.items", 10)],
    "food_nutrition": [("food_nutrition.measurements", 10)],
    "lab": [("loinc.concepts", 1_000)],
    "guideline": [("guideline.disease_guidelines", 1)],
    "ig": [("fhir.ig_packages", 1)],
    "snomed": [("snomed.concepts", 100_000)],
}

# FHIR services have no own tables — they derive availability from their dependencies.
_FHIR_DEPS: dict[str, str] = {
    "fhir_condition": "icd",
    "fhir_medication": "drug",
}


class ModuleStatusManager:
    """Tracks module availability with a TTL cache and syncs MCP tool registration.

    Thread-safe: all mutations are guarded by an asyncio.Lock so concurrent
    ``tools/list`` calls cannot race during a refresh.
    """

    def __init__(self) -> None:
        self._status: dict[str, bool] = {}
        self._enabled: set[str] = set()
        self._last_checked: datetime | None = None
        self._lock = asyncio.Lock()

    def _is_stale(self) -> bool:
        return (
            self._last_checked is None
            or (datetime.now() - self._last_checked) > CACHE_TTL
        )

    async def _query_status(self, pool: PoolLike) -> dict[str, bool]:
        status: dict[str, bool] = {}
        async with pool.acquire() as conn:
            for key, requirements in SERVICE_MODULES.items():
                try:
                    ready = True
                    for table, threshold in requirements:
                        count = await conn.fetchval(f"SELECT COUNT(*) FROM {table}")
                        if (count or 0) < threshold:
                            ready = False
                            break
                    status[key] = ready
                except Exception:
                    status[key] = False
        for fhir_key, dep_key in _FHIR_DEPS.items():
            status[fhir_key] = status.get(dep_key, False)
        return status

    async def _sync_tools(
        self,
        new_status: dict[str, bool],
        service_tools: dict[str, list[tuple[Callable, str]]],
        mcp: Any,
    ) -> None:
        for key, tools in service_tools.items():
            is_available = new_status.get(key, False)
            was_enabled = key in self._enabled

            if is_available and not was_enabled:
                for fn, name in tools:
                    try:
                        mcp.add_tool(fn, name=name, annotations=_READ_ONLY)
                    except Exception as exc:
                        log_warning("add_tool failed", tool=name, error=str(exc))
                self._enabled.add(key)
                log_info("Module ready — tools enabled", service=key, tools=len(tools))

            elif not is_available and was_enabled:
                for _, name in tools:
                    try:
                        mcp.remove_tool(name)
                    except Exception as exc:
                        log_warning("remove_tool failed", tool=name, error=str(exc))
                self._enabled.discard(key)
                log_info(
                    "Module unavailable — tools disabled",
                    service=key,
                    tools=len(tools),
                )

    async def refresh_if_stale_and_sync(
        self,
        pool: PoolLike,
        service_tools: dict[str, list[tuple[Callable, str]]],
        mcp: Any,
        *,
        force: bool = False,
    ) -> None:
        """If the cache is stale, re-query the DB and update tool registration.

        Args:
            pool: Active asyncpg connection pool.
            service_tools: Mapping of service key → list of (fn, tool_name) pairs.
            mcp: The FastMCP instance to call add_tool/remove_tool on.
            force: Re-query even when the cache has not expired.
        """
        if not force and not self._is_stale():
            return
        async with self._lock:
            if not force and not self._is_stale():  # double-check after acquiring lock
                return
            new_status = await self._query_status(pool)
            await self._sync_tools(new_status, service_tools, mcp)
            self._status = new_status
            self._last_checked = datetime.now()

    def get_status(self) -> dict[str, bool]:
        """Return the current cached availability status without triggering a refresh."""
        return self._status.copy()
