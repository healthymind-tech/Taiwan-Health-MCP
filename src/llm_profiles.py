"""LLM profiles — several endpoints per role, with failover / weighted selection.

Python counterpart of ``node-server/src/admin/llmProfiles.ts``, read-only: the
admin console (Node) owns writes, the drug worker only needs to know which
endpoints to try and in what order.

A profile is one endpoint (provider + base URL + key + model) for a role
(``kind``: 'analysis' or 'embedding'), with ``enabled``, a failover ``priority``
and a load-balancing ``weight``. The strategy lives in the matching
``admin.app_settings`` group.

Callers walk ``candidate_order()`` and report what happened; a profile that keeps
failing is put in a short process-local cool-down so a dead endpoint stops
costing every call a timeout. It is never disabled behind the operator's back —
``enabled`` is theirs alone.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import json
import random
import time
from typing import Any

from database import PoolLike
from utils import log_warning

_ROW_COLS = (
    "id, kind, name, provider, base_url, api_key, model, enabled, priority, weight, params"
)


@dataclass
class LlmProfile:
    id: int
    kind: str
    name: str
    provider: str
    base_url: str
    api_key: str
    model: str
    enabled: bool
    priority: int
    weight: int
    params: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_row(cls, row: Any) -> "LlmProfile":
        params = row["params"]
        if isinstance(params, str):
            try:
                params = json.loads(params)
            except ValueError:
                params = {}
        return cls(
            id=int(row["id"]),
            kind=str(row["kind"]),
            name=str(row["name"]),
            provider=str(row["provider"]),
            base_url=str(row["base_url"] or ""),
            api_key=str(row["api_key"] or ""),
            model=str(row["model"] or ""),
            enabled=bool(row["enabled"]),
            priority=int(row["priority"]),
            weight=int(row["weight"]),
            params=params or {},
        )

    def temperature(self, default: float = 0.1) -> float:
        try:
            return float(self.params.get("temperature", default))
        except (TypeError, ValueError):
            return default

    def max_tokens(self, default: int = 4096) -> int:
        try:
            return int(self.params.get("max_tokens", default))
        except (TypeError, ValueError):
            return default


async def list_enabled(pool: PoolLike, kind: str) -> list[LlmProfile]:
    """Enabled profiles for a role, in failover order."""
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            f"SELECT {_ROW_COLS} FROM admin.llm_profiles "
            "WHERE kind = $1 AND enabled = TRUE ORDER BY priority, id",
            kind,
        )
    return [LlmProfile.from_row(r) for r in rows]


# ── Circuit breaker (process-local; a latency optimisation, not a source of truth)
_FAILURES_BEFORE_TRIP = 3
_COOLDOWN_SECONDS = 60.0
_breaker: dict[int, dict[str, float]] = {}


def report_success(profile_id: int) -> None:
    _breaker.pop(profile_id, None)


def report_failure(profile_id: int, error: str) -> None:
    state = _breaker.setdefault(profile_id, {"failures": 0.0, "open_until": 0.0})
    state["failures"] += 1
    if state["failures"] >= _FAILURES_BEFORE_TRIP:
        state["open_until"] = time.monotonic() + _COOLDOWN_SECONDS
        log_warning(
            "llm_profile_cooling_down",
            profile_id=profile_id,
            cooldown_seconds=_COOLDOWN_SECONDS,
            error=error,
        )


def _is_cooling_down(profile_id: int) -> bool:
    state = _breaker.get(profile_id)
    return state is not None and state["open_until"] > time.monotonic()


def reset_breakers() -> None:
    _breaker.clear()


def _weighted_pick(profiles: list[LlmProfile]) -> LlmProfile:
    """Weight 0 = only if everything else is down: still a fallback, never drawn."""
    total = sum(max(0, p.weight) for p in profiles)
    if total <= 0:
        return profiles[0]
    ticket = random.random() * total
    for p in profiles:
        ticket -= max(0, p.weight)
        if ticket < 0:
            return p
    return profiles[-1]


async def candidate_order(pool: PoolLike, kind: str, strategy: str) -> list[LlmProfile]:
    """The order this call should try endpoints in.

    ``failover``: strictly by priority. ``weighted``: one profile drawn by weight
    goes first and the rest follow as fallbacks — load is spread, but a call never
    fails just because the endpoint it drew happens to be down.

    Profiles in cool-down go to the back rather than being dropped: if everything
    is unhealthy we still try them all instead of failing outright.
    """
    enabled = [p for p in await list_enabled(pool, kind) if p.base_url and p.model]
    if not enabled:
        return []

    if strategy == "weighted":
        first = _weighted_pick(enabled)
        order = [first] + [p for p in enabled if p.id != first.id]
    else:
        order = enabled

    healthy = [p for p in order if not _is_cooling_down(p.id)]
    cooling = [p for p in order if _is_cooling_down(p.id)]
    return healthy + cooling
