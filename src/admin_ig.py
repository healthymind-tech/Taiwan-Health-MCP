"""
admin_ig.py — admin-console data layer for the Implementation Guides module.

The ``fhir.*`` schema already stores many IG packages side by side; this module
shapes that data for the admin UI's IG gallery and detail drawer, and performs
the small set of mutations the UI needs (set-default, remove). Dependency status
("complete" vs "N missing") is computed on the fly from each package's declared
``dependencies`` against the set of installed packages — no extra table.

Reuses :mod:`fhir_ig` (``list_packages`` / ``package_closure`` /
``_normalize_dependencies``) so the dependency-closure logic matches what the
terminology resolver uses at query time.
"""

from __future__ import annotations

import json
from typing import Any, Optional

import fhir_ig
from database import PoolLike


async def _installed_set(conn) -> set[tuple[str, str]]:
    rows = await conn.fetch("SELECT package_id, version FROM fhir.ig_packages")
    return {(r["package_id"], r["version"]) for r in rows}


async def _counts_by_package(conn, table: str) -> dict[tuple[str, str], int]:
    rows = await conn.fetch(
        f"SELECT package_id, package_version, COUNT(*) AS n "
        f"FROM {table} GROUP BY package_id, package_version"
    )
    return {(r["package_id"], r["package_version"]): int(r["n"]) for r in rows}


async def _closure_missing(
    pool: PoolLike, package_id: str, version: str, installed: set[tuple[str, str]]
) -> list[dict[str, str]]:
    """Transitive dependencies reachable from this IG that are not installed.

    ``package_closure`` walks installed packages' declared deps and still lists a
    referenced ``(id, ver)`` even when it is absent — so anything in the closure
    that is not installed (and is not the package itself) is a genuine gap.
    """
    closure = await fhir_ig.package_closure(pool, package_id, version)
    missing: list[dict[str, str]] = []
    for pid, pver in closure:
        if (pid, pver) == (package_id, version):
            continue
        if (pid, pver) not in installed:
            missing.append({"package_id": pid, "version": pver})
    return missing


async def list_igs(pool: PoolLike) -> list[dict[str, Any]]:
    """All installed IGs with counts and dependency status, default first."""
    packages = await fhir_ig.list_packages(pool)
    async with pool.acquire() as conn:
        installed = await _installed_set(conn)
        art_counts = await _counts_by_package(conn, "fhir.artifacts")
        cs_counts = await _counts_by_package(conn, "fhir.codesystems")
        concept_counts = await _counts_by_package(conn, "fhir.concepts")

    out: list[dict[str, Any]] = []
    for pkg in packages:
        pid = pkg["package_id"]
        pver = pkg["version"]
        missing = await _closure_missing(pool, pid, pver, installed)
        out.append(
            {
                "package_id": pid,
                "version": pver,
                "title": pkg.get("title") or pid,
                "canonical": pkg.get("canonical"),
                "fhir_version": pkg.get("fhir_version"),
                "status": pkg.get("status"),
                "is_default": bool(pkg.get("is_default")),
                "imported_at": pkg.get("imported_at"),
                "dependencies": pkg.get("dependencies") or {},
                "counts": {
                    "artifacts": art_counts.get((pid, pver), 0),
                    "codesystems": cs_counts.get((pid, pver), 0),
                    "concepts": concept_counts.get((pid, pver), 0),
                },
                "deps_total": len(pkg.get("dependencies") or {}),
                "deps_missing": missing,
            }
        )
    return out


async def _external_systems(
    conn, package_id: str, version: str, local_cs_ids: set[str]
) -> list[str]:
    """Distinct code systems referenced by this IG's ValueSets that are NOT one of
    its own CodeSystems — a best-effort "referenced terminologies" view."""
    rows = await conn.fetch(
        "SELECT raw_json FROM fhir.artifacts "
        "WHERE package_id = $1 AND package_version = $2 "
        "AND resource_type = 'ValueSet'",
        package_id,
        version,
    )
    systems: set[str] = set()
    for r in rows:
        raw = r["raw_json"]
        if isinstance(raw, str):
            try:
                raw = json.loads(raw)
            except Exception:
                continue
        if not isinstance(raw, dict):
            continue
        for inc in (raw.get("compose") or {}).get("include") or []:
            sys_url = inc.get("system")
            if not sys_url:
                continue
            tail = str(sys_url).rstrip("/").split("/")[-1]
            if tail in local_cs_ids:
                continue
            systems.add(str(sys_url))
    return sorted(systems)


async def get_ig_detail(
    pool: PoolLike, package_id: str, version: Optional[str]
) -> Optional[dict[str, Any]]:
    """Full detail for one IG: metadata, counts, dependency tree (installed/missing),
    defined CodeSystems, and externally-referenced systems. ``None`` if not found."""
    pkg = await fhir_ig.get_package(pool, package_id, version)
    if pkg is None:
        return None
    pid = pkg["package_id"]
    pver = pkg["version"]
    deps = pkg.get("dependencies") or {}

    async with pool.acquire() as conn:
        installed = await _installed_set(conn)
        art_counts = await _counts_by_package(conn, "fhir.artifacts")
        cs_counts = await _counts_by_package(conn, "fhir.codesystems")
        concept_counts = await _counts_by_package(conn, "fhir.concepts")
        cs_rows = await conn.fetch(
            "SELECT cs_id, name, COALESCE(concept_count, 0) AS concept_count "
            "FROM fhir.codesystems "
            "WHERE package_id = $1 AND package_version = $2 "
            "ORDER BY name NULLS LAST, cs_id",
            pid,
            pver,
        )
        local_cs_ids = {r["cs_id"] for r in cs_rows}
        external_systems = await _external_systems(conn, pid, pver, local_cs_ids)
        dependents = await _dependents(conn, pid, pver)

    # Direct dependency tree with installed/missing status.
    dependency_tree = [
        {
            "package_id": dep_id,
            "version": dep_ver,
            "installed": (dep_id, dep_ver) in installed,
        }
        for dep_id, dep_ver in deps.items()
    ]

    missing = await _closure_missing(pool, pid, pver, installed)

    return {
        "package_id": pid,
        "version": pver,
        "title": pkg.get("title") or pid,
        "canonical": pkg.get("canonical"),
        "fhir_version": pkg.get("fhir_version"),
        "status": pkg.get("status"),
        "is_default": bool(pkg.get("is_default")),
        "imported_at": pkg.get("imported_at"),
        "counts": {
            "artifacts": art_counts.get((pid, pver), 0),
            "codesystems": cs_counts.get((pid, pver), 0),
            "concepts": concept_counts.get((pid, pver), 0),
        },
        "dependencies": dependency_tree,
        "deps_missing": missing,
        "dependents": dependents,
        "codesystems": [
            {
                "cs_id": r["cs_id"],
                "name": r["name"] or r["cs_id"],
                "concept_count": int(r["concept_count"]),
            }
            for r in cs_rows
        ],
        "external_systems": external_systems,
    }


async def _dependents(conn, package_id: str, version: str) -> list[dict[str, str]]:
    """Installed IGs that declare a dependency on ``package_id@version``."""
    rows = await conn.fetch(
        "SELECT package_id, version, dependencies FROM fhir.ig_packages"
    )
    out: list[dict[str, str]] = []
    for r in rows:
        if (r["package_id"], r["version"]) == (package_id, version):
            continue
        deps = fhir_ig._normalize_dependencies(r["dependencies"])
        if deps.get(package_id) == version:
            out.append({"package_id": r["package_id"], "version": r["version"]})
    return out


async def set_default(pool: PoolLike, package_id: str, version: str) -> bool:
    """Make ``package_id@version`` the single default IG. Returns False if absent."""
    async with pool.acquire() as conn:
        exists = await conn.fetchval(
            "SELECT 1 FROM fhir.ig_packages WHERE package_id = $1 AND version = $2",
            package_id,
            version,
        )
        if not exists:
            return False
        async with conn.transaction():
            # Clear first so the partial unique index (one default) never conflicts.
            await conn.execute(
                "UPDATE fhir.ig_packages SET is_default = FALSE WHERE is_default"
            )
            await conn.execute(
                "UPDATE fhir.ig_packages SET is_default = TRUE "
                "WHERE package_id = $1 AND version = $2",
                package_id,
                version,
            )
    return True


async def remove_ig(
    pool: PoolLike,
    package_id: str,
    version: str,
    *,
    removed_by: str,
    minio_service: Any | None = None,
) -> dict[str, Any]:
    """Delete one IG package (cascades to its CodeSystems/concepts/artifacts).

    Returns a summary including any installed ``dependents`` (other IGs that
    declared a dependency on this one) so the UI can warn about a now-incomplete
    closure. Best-effort removes the archived tarball from MinIO.
    """
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT package_id, version, is_default FROM fhir.ig_packages "
            "WHERE package_id = $1 AND version = $2",
            package_id,
            version,
        )
        if row is None:
            return {"removed": False, "reason": "not_found"}
        dependents = await _dependents(conn, package_id, version)
        async with conn.transaction():
            await conn.execute(
                "DELETE FROM fhir.ig_packages WHERE package_id = $1 AND version = $2",
                package_id,
                version,
            )
            await conn.execute(
                """
                INSERT INTO admin.admin_audit_log
                    (admin_user, action, target_type, target_id, payload_json)
                VALUES ($1, 'remove_ig', 'ig_package', $2, $3::jsonb)
                """,
                removed_by,
                f"{package_id}@{version}",
                json.dumps({"dependents": dependents}, ensure_ascii=False),
            )
    if minio_service is not None and getattr(minio_service, "enabled", False):
        try:
            await minio_service.remove_object(
                f"ig-packages/{package_id}/{version}/package.tgz"
            )
        except Exception:
            pass
    return {
        "removed": True,
        "package_id": package_id,
        "version": version,
        "was_default": bool(row["is_default"]),
        "dependents": dependents,
    }
