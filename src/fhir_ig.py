"""
FHIR IG package registry helpers (Phase 0 — multi-IG foundation).

The platform stores many FHIR Implementation Guide (IG) packages side by side in
the ``fhir.*`` schema (``fhir.ig_packages`` registry + package-scoped
``fhir.artifacts`` / ``fhir.codesystems`` / ``fhir.concepts``). These helpers are
the single place that resolves *which* package a request targets and that walks a
package's declared dependencies when a canonical URL is not defined locally.

They are deliberately dependency-free (only the asyncpg pool) so they can be used
both by the repointed ``twcore`` readers today and by the future ``fhir_*`` MCP
tools (Phase 1+).
"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Optional, Tuple


class IGNotFoundError(Exception):
    """Raised when an IG package (or the default) cannot be resolved.

    Carries a machine-readable ``code`` matching the toolset error-code enum so
    callers can surface ``IG_NOT_FOUND`` in the common response envelope.
    """

    code = "IG_NOT_FOUND"


def _semver_key(version: str) -> tuple:
    """Best-effort semver sort key. Numeric components sort numerically; any
    non-numeric tail (pre-release, build) sorts after a purely numeric version
    of the same prefix. Tolerant of arbitrary strings (returns a comparable
    tuple regardless)."""
    parts: list[tuple[int, int, str]] = []
    for chunk in str(version or "").replace("-", ".").replace("+", ".").split("."):
        if chunk.isdigit():
            parts.append((1, int(chunk), ""))
        else:
            # non-numeric chunk: ranks below a numeric one at the same position
            parts.append((0, 0, chunk))
    return tuple(parts)


def _normalize_dependencies(deps: Any) -> Dict[str, str]:
    """Coerce a stored ``dependencies`` value (JSONB column may come back as a
    dict or a JSON string) into a ``{packageId: version}`` mapping."""
    if not deps:
        return {}
    if isinstance(deps, str):
        try:
            deps = json.loads(deps)
        except Exception:
            return {}
    if isinstance(deps, dict):
        return {str(k): str(v) for k, v in deps.items()}
    return {}


async def resolve_package(pool, ig: Optional[Dict[str, Any]] = None) -> Tuple[str, str]:
    """Resolve an IG selector to a concrete ``(package_id, version)``.

    Args:
        pool: asyncpg pool / connection.
        ig: ``None`` → the registry's default package (``is_default``), falling
            back to the most recently imported one. Otherwise a dict with
            ``packageId`` (required) and an optional ``version``; a missing
            version resolves to that package's default/highest semver.

    Raises:
        IGNotFoundError: when no matching package exists.
    """
    if ig:
        package_id = ig.get("packageId") or ig.get("package_id")
        version = ig.get("version")
        if not package_id:
            raise IGNotFoundError("ig.packageId is required")
        if version:
            row = await pool.fetchrow(
                "SELECT package_id, version FROM fhir.ig_packages "
                "WHERE package_id = $1 AND version = $2",
                package_id,
                version,
            )
            if row is None:
                raise IGNotFoundError(f"IG package not found: {package_id}#{version}")
            return row["package_id"], row["version"]
        rows = await pool.fetch(
            "SELECT version, is_default FROM fhir.ig_packages WHERE package_id = $1",
            package_id,
        )
        if not rows:
            raise IGNotFoundError(f"IG package not found: {package_id}")
        best = sorted(
            rows,
            key=lambda r: (bool(r["is_default"]), _semver_key(r["version"])),
            reverse=True,
        )[0]
        return package_id, best["version"]

    row = await pool.fetchrow(
        "SELECT package_id, version FROM fhir.ig_packages "
        "ORDER BY is_default DESC, imported_at DESC LIMIT 1"
    )
    if row is None:
        raise IGNotFoundError("no IG packages installed")
    return row["package_id"], row["version"]


async def resolve_default_package(pool) -> Optional[Tuple[str, str]]:
    """Like :func:`resolve_package` with no selector, but returns ``None``
    instead of raising when no package is installed — convenient for readers
    that degrade gracefully on an empty registry."""
    try:
        return await resolve_package(pool, None)
    except IGNotFoundError:
        return None


async def resolve_canonical(
    pool, url: str, package_id: str, package_version: str
) -> Optional[dict]:
    """Resolve a canonical URL to an artifact row, searching the target package
    first and then its declared ``dependencies`` transitively.

    Generalizes the old optional ``twcore_tho`` / ``twcore_fhir_core`` side-load:
    a profile in TW Core can reference base-FHIR or HL7 THO canonicals, which are
    resolved here against whichever dependency packages are imported. Returns
    ``None`` (never a guess) when unresolved.
    """
    seen: set[tuple[str, str]] = set()
    queue: list[tuple[str, str]] = [(package_id, package_version)]
    while queue:
        pid, pver = queue.pop(0)
        if (pid, pver) in seen:
            continue
        seen.add((pid, pver))
        row = await pool.fetchrow(
            "SELECT * FROM fhir.artifacts "
            "WHERE package_id = $1 AND package_version = $2 AND canonical_url = $3 "
            "LIMIT 1",
            pid,
            pver,
            url,
        )
        if row is not None:
            return dict(row)
        dep_row = await pool.fetchrow(
            "SELECT dependencies FROM fhir.ig_packages "
            "WHERE package_id = $1 AND version = $2",
            pid,
            pver,
        )
        if dep_row is not None:
            for dep_id, dep_ver in _normalize_dependencies(
                dep_row["dependencies"]
            ).items():
                if (dep_id, dep_ver) not in seen:
                    queue.append((dep_id, dep_ver))
    return None


async def package_closure(
    pool, package_id: str, package_version: str
) -> List[Tuple[str, str]]:
    """The target package plus its declared ``dependencies`` transitively, as an
    ordered ``[(package_id, version), …]`` list (target first, breadth-first).

    Concept/terminology lookups must search this closure — a profile bound to a
    base-FHIR / HL7 THO ValueSet keeps the *ValueSet* in the target package but
    the *CodeSystem concepts* in a dependency package (e.g. ``hl7.fhir.r4.core``).
    Scoping a concept query to the target package alone silently misses them.
    """
    seen: set[Tuple[str, str]] = set()
    ordered: List[Tuple[str, str]] = []
    queue: List[Tuple[str, str]] = [(package_id, package_version)]
    while queue:
        pid, pver = queue.pop(0)
        if (pid, pver) in seen:
            continue
        seen.add((pid, pver))
        ordered.append((pid, pver))
        dep_row = await pool.fetchrow(
            "SELECT dependencies FROM fhir.ig_packages "
            "WHERE package_id = $1 AND version = $2",
            pid,
            pver,
        )
        if dep_row is not None:
            for dep_id, dep_ver in _normalize_dependencies(
                dep_row["dependencies"]
            ).items():
                if (dep_id, dep_ver) not in seen:
                    queue.append((dep_id, dep_ver))
    return ordered


async def list_packages(pool) -> List[dict]:
    """All installed IG packages (registry rows), default first."""
    rows = await pool.fetch(
        "SELECT package_id, version, canonical, fhir_version, title, status, "
        "is_default, dependencies, imported_at "
        "FROM fhir.ig_packages "
        "ORDER BY is_default DESC, package_id, version"
    )
    out: list[dict] = []
    for row in rows:
        item = dict(row)
        item["dependencies"] = _normalize_dependencies(item.get("dependencies"))
        out.append(item)
    return out


async def get_package(
    pool, package_id: str, version: Optional[str] = None
) -> Optional[dict]:
    """One IG package registry row. ``version=None`` resolves to the package's
    default/highest. Returns ``None`` when not found."""
    try:
        package_id, version = await resolve_package(
            pool, {"packageId": package_id, "version": version}
        )
    except IGNotFoundError:
        return None
    row = await pool.fetchrow(
        "SELECT package_id, version, canonical, fhir_version, title, status, "
        "is_default, dependencies, imported_at "
        "FROM fhir.ig_packages WHERE package_id = $1 AND version = $2",
        package_id,
        version,
    )
    if row is None:
        return None
    item = dict(row)
    item["dependencies"] = _normalize_dependencies(item.get("dependencies"))
    return item
