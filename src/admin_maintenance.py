"""
Per-module maintenance mode.

A module in maintenance mode is intentionally taken offline by an admin so its
data can be modified (wiped and re-imported). While a module is in maintenance:

  * Its MCP tools / endpoints return a "service under maintenance" response
    instead of querying (see ``_svc_maintenance`` in ``server.py``).
  * The admin Overview reports its service status as ``maintaining``.
  * Destructive admin actions (clear-and-reimport) are only permitted while it
    is ON.

State is stored in ``admin.app_settings`` (group_key ``maintenance``, one row per
module_key, value ``"true"``/``"false"``) so it survives restarts and is shared
across the app process and the worker. A short-TTL in-process cache mirrors the
settings module so both pick up a toggle within a few seconds without a restart.

ICD, LOINC, SNOMED, TWCore, and Drug currently support maintenance mode; the mechanism is
module-keyed so other modules can opt in later by extending
``MAINTENANCE_MODULES``.
"""

from __future__ import annotations

import json
import logging
import time
from typing import Iterable

from database import PoolLike

logger = logging.getLogger(__name__)

GROUP_KEY = "maintenance"

# Modules that currently expose a maintenance toggle. Extend as needed.
MAINTENANCE_MODULES: frozenset[str] = frozenset(
    {"drug", "icd", "loinc", "snomed", "ig", "rxnorm"}
)

# Short TTL so the app and worker observe toggles within a few seconds (mirrors
# admin_settings._CACHE_TTL_SECONDS).
_CACHE_TTL_SECONDS = 5.0
_cache: tuple[float, dict[str, bool]] | None = None


def bust_cache() -> None:
    global _cache
    _cache = None


def _coerce_bool(raw: object) -> bool:
    if isinstance(raw, bool):
        return raw
    return str(raw).strip().lower() in ("1", "true", "yes", "on")


async def _load_all(pool: PoolLike) -> dict[str, bool]:
    """Return {module_key: enabled} for every stored maintenance row, cached."""
    global _cache
    now = time.monotonic()
    if _cache is not None and (now - _cache[0]) < _CACHE_TTL_SECONDS:
        return _cache[1]
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT key, value FROM admin.app_settings WHERE group_key = $1",
            GROUP_KEY,
        )
    states = {r["key"]: _coerce_bool(r["value"]) for r in rows}
    _cache = (now, states)
    return states


async def is_enabled(pool: PoolLike, module_key: str) -> bool:
    """True if the given module is currently in maintenance mode."""
    states = await _load_all(pool)
    return states.get(module_key, False)


async def get_states(
    pool: PoolLike, module_keys: Iterable[str] | None = None
) -> dict[str, bool]:
    """Return {module_key: enabled} for the requested keys (defaults to every
    maintenance-capable module). Always includes a value for each requested key."""
    keys = list(module_keys) if module_keys is not None else sorted(MAINTENANCE_MODULES)
    states = await _load_all(pool)
    return {k: states.get(k, False) for k in keys}


async def set_enabled(
    pool: PoolLike, module_key: str, enabled: bool, *, updated_by: str
) -> bool:
    """Persist the maintenance flag for a module and return the new state.

    Raises ValueError if the module does not support maintenance mode.
    """
    if module_key not in MAINTENANCE_MODULES:
        raise ValueError(f"Module '{module_key}' does not support maintenance mode")
    value = "true" if enabled else "false"
    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute(
                """
                INSERT INTO admin.app_settings (group_key, key, value, updated_by, updated_at)
                VALUES ($1, $2, $3, $4, NOW())
                ON CONFLICT (group_key, key)
                DO UPDATE SET value = EXCLUDED.value,
                             updated_by = EXCLUDED.updated_by,
                             updated_at = NOW()
                """,
                GROUP_KEY,
                module_key,
                value,
                updated_by,
            )
            await conn.execute(
                """
                INSERT INTO admin.admin_audit_log
                    (admin_user, action, target_type, target_id, payload_json)
                VALUES ($1, 'set_maintenance', 'module', $2, $3::jsonb)
                """,
                updated_by,
                module_key,
                json.dumps({"enabled": enabled}, ensure_ascii=False),
            )
    bust_cache()
    logger.info(
        "maintenance mode for %s set to %s by %s", module_key, enabled, updated_by
    )
    return enabled
