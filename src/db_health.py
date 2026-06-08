"""Central database health monitor — the single source of truth for whether the
PostgreSQL backend is usable.

The monitor runs a lightweight background probe and exposes ``is_healthy()`` /
``snapshot()`` so every entry point (MCP tools, admin API, worker) can gate
operations while the database is down and surface a clear status to the UI.

Design (see plan):
- States: ``healthy`` / ``recovering`` / ``unreachable``.
- Fail-fast: callers that hit a DB connection error call ``report_failure`` to
  flip the gate immediately instead of waiting for the next probe.
- Debounced unlock: after an outage, require N consecutive OK probes plus a
  short grace window before resuming (avoids flapping during crash recovery).
- On recovery, recycle the connection pool so dead connections are replaced
  before traffic is allowed back in.
"""

from __future__ import annotations

import asyncio
import time
from datetime import datetime, timezone
from typing import Any

import database
from utils import log_error, log_info, log_warning

STATE_HEALTHY = "healthy"
STATE_RECOVERING = "recovering"
STATE_UNREACHABLE = "unreachable"

# Debounced unlock: this many consecutive healthy probes AND this grace window
# must both pass before the gate reopens.
_UNLOCK_CONSECUTIVE_OK = 2
_UNLOCK_GRACE_SECONDS = 3.0

_PROBE_INTERVAL_HEALTHY = 5.0
_PROBE_INTERVAL_DOWN = 2.0

# Substrings that indicate the database connection itself is gone (used by the
# fail-fast hook to distinguish infra failures from ordinary query errors).
_DB_DOWN_MARKERS = (
    "connection was closed",
    "connectiondoesnotexist",
    "the database system is in recovery",
    "is not yet accepting connections",
    "connection refused",
    "connection reset",
    "server closed the connection",
    "underlying connection is closed",
    "connection is closed",
    "cannot connect",
    "pool is closed",
    "too many connections",
    "the database system is starting up",
    "interfaceerror",
)


def _looks_like_db_down(message: str) -> bool:
    lowered = message.lower()
    return any(marker in lowered for marker in _DB_DOWN_MARKERS)


def is_db_down_error(exc: BaseException | str) -> bool:
    """Public helper: True when an exception/message looks like a DB outage
    (connection lost / refused / in recovery) rather than an ordinary error."""
    return _looks_like_db_down(str(exc))


class DbHealthMonitor:
    def __init__(self) -> None:
        # Optimistic at boot so nothing is blocked before the first probe; the
        # probe corrects this within seconds and report_failure flips it instantly.
        self._state = STATE_HEALTHY
        self._since = time.monotonic()
        self._since_wall = datetime.now(timezone.utc)
        self._last_ok_at: datetime | None = None
        self._last_error = ""
        self._consecutive_ok = 0
        self._first_ok_at: float | None = None
        self._task: asyncio.Task | None = None
        self._start_lock = asyncio.Lock()

    # ── public API ────────────────────────────────────────────────────────────
    def is_healthy(self) -> bool:
        return self._state == STATE_HEALTHY

    def snapshot(self) -> dict[str, Any]:
        return {
            "state": self._state,
            "healthy": self._state == STATE_HEALTHY,
            "since": self._since_wall.isoformat(),
            "for_seconds": round(time.monotonic() - self._since, 1),
            "last_ok_at": self._last_ok_at.isoformat() if self._last_ok_at else None,
            "last_error": self._last_error,
            "monitoring": bool(self._task and not self._task.done()),
        }

    def report_failure(self, exc: BaseException | str) -> None:
        """Flip the gate closed immediately when a real DB connection error is
        observed by a caller (fail-fast, no need to wait for the next probe)."""
        message = str(exc)
        if not _looks_like_db_down(message):
            return
        self._consecutive_ok = 0
        self._first_ok_at = None
        if self._state == STATE_HEALTHY:
            self._set_state(STATE_UNREACHABLE, message)

    async def start(self) -> None:
        """Start the background probe loop (idempotent)."""
        async with self._start_lock:
            if self._task and not self._task.done():
                return
            self._task = asyncio.create_task(self._loop())
            log_info("Database health monitor started")

    # ── internals ─────────────────────────────────────────────────────────────
    def _set_state(self, state: str, error: str = "") -> None:
        if state != self._state:
            self._state = state
            self._since = time.monotonic()
            self._since_wall = datetime.now(timezone.utc)
            if state == STATE_HEALTHY:
                log_info("Database recovered — operations resumed")
            else:
                log_warning(
                    "Database gated — operations paused", state=state, error=error
                )
        if error:
            self._last_error = error

    async def _probe_once(self) -> None:
        result = await database.healthcheck()
        ok = bool(result.get("ok"))
        in_recovery = bool(result.get("in_recovery"))
        error = str(result.get("error") or "")

        if ok and not in_recovery:
            self._last_ok_at = datetime.now(timezone.utc)
            if self._state == STATE_HEALTHY:
                return
            # Debounced unlock after an outage.
            self._consecutive_ok += 1
            if self._first_ok_at is None:
                self._first_ok_at = time.monotonic()
            grace_passed = time.monotonic() - self._first_ok_at >= _UNLOCK_GRACE_SECONDS
            if self._consecutive_ok >= _UNLOCK_CONSECUTIVE_OK and grace_passed:
                await self._recycle_pool()
                self._set_state(STATE_HEALTHY)
                self._consecutive_ok = 0
                self._first_ok_at = None
            return

        # Not healthy.
        self._consecutive_ok = 0
        self._first_ok_at = None
        if (
            in_recovery
            or "recovery" in error.lower()
            or "not yet accepting" in error.lower()
        ):
            self._set_state(STATE_RECOVERING, error or "database in recovery")
        else:
            self._set_state(STATE_UNREACHABLE, error or "database unreachable")

    async def _recycle_pool(self) -> None:
        try:
            await database.reset_pool()
        except Exception as exc:
            log_warning("Pool recycle after recovery failed", error=str(exc))

    async def _loop(self) -> None:
        while True:
            try:
                await self._probe_once()
            except Exception as exc:
                log_error(f"DB health probe error: {exc}")
            interval = (
                _PROBE_INTERVAL_HEALTHY
                if self._state == STATE_HEALTHY
                else _PROBE_INTERVAL_DOWN
            )
            await asyncio.sleep(interval)


_monitor = DbHealthMonitor()


def monitor() -> DbHealthMonitor:
    """Return the process-wide DB health monitor singleton."""
    return _monitor
