"""
FHIR IG Service (Phase 1) — discovery + StructureDefinition reading.

Generic, IG-scoped read layer over the multi-IG ``fhir.*`` store. Every public
method resolves a target package (default IG when none is given) via
``fhir_ig.resolve_package`` and returns the toolset's common envelope
``{ok, data, warnings, provenance, error?}``. No new data and no external service:
everything is served from ``fhir.artifacts.raw_json`` + the ``fhir_snapshot``
projector. Cross-IG canonical references resolve through ``fhir_ig.resolve_canonical``.
"""

from __future__ import annotations

import copy
import json
from typing import Any, Optional

import fhir_authoring
import fhir_ig
import fhir_reference
import fhir_snapshot
import fhir_terminology
import fhir_validator
from database import PoolLike
from utils import log_error, log_info

# Element paths (relative to the resource) skipped by the focused skeleton.
_SKELETON_SKIP = {
    "id",
    "meta",
    "text",
    "implicitRules",
    "language",
    "contained",
}

# StructureDefinition columns surfaced as an artifact summary (raw_json excluded).
_ARTIFACT_SUMMARY_COLS = """artifact_key, resource_type, artifact_id, canonical_url,
    name, title, status, kind, base_type, derivation, grouping_id, grouping_name,
    child_count, concept_count"""

_VALID_VIEWS = {"elements", "element", "slices", "choices", "binding", "examples"}
_PATH_REQUIRED_VIEWS = {"element", "slices", "choices", "binding"}


def _json_value(raw: Any) -> dict:
    if isinstance(raw, str):
        try:
            return json.loads(raw)
        except Exception:
            return {}
    return raw or {}


def _codings_of(node: Any, type_code: Optional[str]) -> list[tuple]:
    """Extract ``(system, code)`` pairs from a coded value node, by its element
    type (CodeableConcept / Coding / code primitive)."""
    if isinstance(node, str):
        return [(None, node)]
    if not isinstance(node, dict):
        return []
    if type_code == "Coding" or ("system" in node and "code" in node):
        return [(node.get("system"), node.get("code"))]
    codings = node.get("coding")
    if isinstance(codings, list):
        return [
            (c.get("system"), c.get("code")) for c in codings if isinstance(c, dict)
        ]
    return []


class FHIRIGService:
    def __init__(self, pool: PoolLike, embedding_svc: Any = None):
        self.pool = pool
        # Optional EmbeddingService for semantic normalize_code — fail-open: when
        # absent/offline, normalize degrades to ConceptMap + lexical matching.
        self.embedding_svc = embedding_svc

    async def initialize(self) -> None:
        count = await self.pool.fetchval("SELECT COUNT(*) FROM fhir.ig_packages")
        if count:
            log_info(f"FHIR IG Service ready ({count} IG package(s) registered)")
        else:
            log_error("FHIR IG registry empty — import an IG package first")

    # ------------------------------------------------------------------ #
    #  Envelope + resolution helpers                                       #
    # ------------------------------------------------------------------ #

    @staticmethod
    def _provenance(pkg: dict) -> dict:
        return {
            "packageId": pkg.get("package_id"),
            "version": pkg.get("version"),
            "fhirVersion": pkg.get("fhir_version"),
            "source": "ig",
        }

    def _ok(
        self, data: Any, pkg: Optional[dict], warnings: Optional[list] = None
    ) -> str:
        env = {
            "ok": True,
            "data": data,
            "warnings": warnings or [],
            "provenance": self._provenance(pkg) if pkg else None,
        }
        return json.dumps(env, ensure_ascii=False, default=str)

    def _err(self, code: str, message: str) -> str:
        return json.dumps(
            {
                "ok": False,
                "data": None,
                "warnings": [],
                "error": {"code": code, "message": message},
            },
            ensure_ascii=False,
        )

    async def _resolve(self, package_id: Optional[str], version: Optional[str]) -> dict:
        """Resolve the target package row (raises IGNotFoundError when absent)."""
        ig = {"packageId": package_id, "version": version} if package_id else None
        pid, ver = await fhir_ig.resolve_package(self.pool, ig)
        pkg = await fhir_ig.get_package(self.pool, pid, ver)
        if pkg is None:  # pragma: no cover - resolve_package already validated it
            raise fhir_ig.IGNotFoundError(f"IG package not found: {pid}#{ver}")
        # Dependency closure for cross-package concept/terminology lookups: a
        # base-FHIR/THO-bound ValueSet keeps its concepts in a dependency package.
        pkg["_closure"] = await fhir_ig.package_closure(
            self.pool, pkg["package_id"], pkg["version"]
        )
        return pkg

    async def _load_artifact(
        self, pid: str, ver: str, identifier: str
    ) -> Optional[dict]:
        row = await self.pool.fetchrow(
            f"""SELECT {_ARTIFACT_SUMMARY_COLS}, raw_json
                FROM fhir.artifacts
                WHERE package_id = $1 AND package_version = $2
                  AND (artifact_id = $3 OR canonical_url = $3 OR artifact_key = $3)
                ORDER BY (artifact_id = $3) DESC
                LIMIT 1""",
            pid,
            ver,
            identifier,
        )
        if row is not None:
            return dict(row)
        # Fall back to cross-IG canonical resolution through dependencies.
        resolved = await fhir_ig.resolve_canonical(self.pool, identifier, pid, ver)
        return resolved

    # ------------------------------------------------------------------ #
    #  A. IG discovery                                                     #
    # ------------------------------------------------------------------ #

    async def list_igs(self) -> str:
        packages = await fhir_ig.list_packages(self.pool)
        data = {
            "count": len(packages),
            "igs": [
                {
                    "packageId": p["package_id"],
                    "version": p["version"],
                    "title": p.get("title"),
                    "canonical": p.get("canonical"),
                    "fhirVersion": p.get("fhir_version"),
                    "status": p.get("status"),
                    "isDefault": bool(p.get("is_default")),
                    "dependencies": p.get("dependencies") or {},
                }
                for p in packages
            ],
        }
        return self._ok(data, None)

    async def get_ig(
        self, package_id: Optional[str] = None, version: Optional[str] = None
    ) -> str:
        try:
            pkg = await self._resolve(package_id, version)
        except fhir_ig.IGNotFoundError as e:
            return self._err("IG_NOT_FOUND", str(e))
        rows = await self.pool.fetch(
            "SELECT resource_type, COUNT(*) AS n FROM fhir.artifacts "
            "WHERE package_id = $1 AND package_version = $2 "
            "GROUP BY resource_type ORDER BY resource_type",
            pkg["package_id"],
            pkg["version"],
        )
        data = {
            "packageId": pkg["package_id"],
            "version": pkg["version"],
            "title": pkg.get("title"),
            "canonical": pkg.get("canonical"),
            "fhirVersion": pkg.get("fhir_version"),
            "status": pkg.get("status"),
            "isDefault": bool(pkg.get("is_default")),
            "dependencies": pkg.get("dependencies") or {},
            "artifactCounts": {r["resource_type"]: int(r["n"]) for r in rows},
        }
        return self._ok(data, pkg)

    async def list_artifacts(
        self,
        package_id: Optional[str] = None,
        version: Optional[str] = None,
        resource_type: Optional[str] = None,
        grouping_id: Optional[str] = None,
        limit: int = 50,
    ) -> str:
        try:
            pkg = await self._resolve(package_id, version)
        except fhir_ig.IGNotFoundError as e:
            return self._err("IG_NOT_FOUND", str(e))
        limit = min(max(1, limit), 200)
        params: list[Any] = [pkg["package_id"], pkg["version"]]
        clauses = ["package_id = $1", "package_version = $2"]
        if resource_type:
            params.append(resource_type)
            clauses.append(f"resource_type = ${len(params)}")
        if grouping_id:
            params.append(grouping_id)
            clauses.append(f"grouping_id = ${len(params)}")
        params.append(limit)
        rows = await self.pool.fetch(
            f"SELECT {_ARTIFACT_SUMMARY_COLS} FROM fhir.artifacts "
            f"WHERE {' AND '.join(clauses)} "
            f"ORDER BY resource_type, name LIMIT ${len(params)}",
            *params,
        )
        return self._ok({"count": len(rows), "artifacts": [dict(r) for r in rows]}, pkg)

    async def search_artifacts(
        self,
        keyword: str,
        package_id: Optional[str] = None,
        version: Optional[str] = None,
        resource_type: Optional[str] = None,
        limit: int = 20,
    ) -> str:
        try:
            pkg = await self._resolve(package_id, version)
        except fhir_ig.IGNotFoundError as e:
            return self._err("IG_NOT_FOUND", str(e))
        limit = min(max(1, limit), 100)
        params: list[Any] = [pkg["package_id"], pkg["version"]]
        clauses = ["package_id = $1", "package_version = $2"]
        if resource_type:
            params.append(resource_type)
            clauses.append(f"resource_type = ${len(params)}")
        params.append(keyword)
        kw_idx = len(params)
        params.append(f"%{keyword}%")
        like_idx = len(params)
        clauses.append(
            "(to_tsvector('simple', COALESCE(artifact_id,'') || ' ' || "
            "COALESCE(canonical_url,'') || ' ' || COALESCE(name,'') || ' ' || "
            "COALESCE(title,'') || ' ' || COALESCE(description,'')) "
            f"@@ plainto_tsquery('simple', ${kw_idx}) OR artifact_id ILIKE ${like_idx})"
        )
        params.append(limit)
        rows = await self.pool.fetch(
            f"SELECT {_ARTIFACT_SUMMARY_COLS} FROM fhir.artifacts "
            f"WHERE {' AND '.join(clauses)} "
            f"ORDER BY resource_type, name LIMIT ${len(params)}",
            *params,
        )
        return self._ok({"count": len(rows), "artifacts": [dict(r) for r in rows]}, pkg)

    # ------------------------------------------------------------------ #
    #  B. Profile selection                                                #
    # ------------------------------------------------------------------ #

    async def list_resource_profiles(
        self,
        package_id: Optional[str] = None,
        version: Optional[str] = None,
        base_type: Optional[str] = None,
    ) -> str:
        try:
            pkg = await self._resolve(package_id, version)
        except fhir_ig.IGNotFoundError as e:
            return self._err("IG_NOT_FOUND", str(e))
        params: list[Any] = [pkg["package_id"], pkg["version"]]
        clauses = [
            "package_id = $1",
            "package_version = $2",
            "resource_type = 'StructureDefinition'",
            "derivation = 'constraint'",
            "kind = 'resource'",
        ]
        if base_type:
            params.append(base_type)
            clauses.append(f"base_type = ${len(params)}")
        rows = await self.pool.fetch(
            f"""SELECT artifact_id, canonical_url, name, title, base_type, status
                FROM fhir.artifacts
                WHERE {' AND '.join(clauses)}
                ORDER BY base_type, COALESCE(NULLIF(title,''), name, artifact_id)""",
            *params,
        )
        by_type: dict[str, list[dict]] = {}
        for r in rows:
            by_type.setdefault(r["base_type"] or "", []).append(
                {
                    "profile": r["artifact_id"],
                    "canonical": r["canonical_url"],
                    "title": r["title"] or r["name"] or r["artifact_id"],
                    "status": r["status"],
                }
            )
        data = {
            "count": len(rows),
            "byResourceType": by_type,
        }
        return self._ok(data, pkg)

    async def rank_resource_profiles(
        self,
        keys: list[str],
        package_id: Optional[str] = None,
        version: Optional[str] = None,
        base_type: Optional[str] = None,
        limit: int = 5,
    ) -> str:
        """Heuristically rank candidate profiles by how many of the caller's
        input field keys match element paths in each profile's snapshot. This
        only **suggests** — the response always carries ``selectionRequired:true``
        and never auto-selects a profile."""
        try:
            pkg = await self._resolve(package_id, version)
        except fhir_ig.IGNotFoundError as e:
            return self._err("IG_NOT_FOUND", str(e))
        limit = min(max(1, limit), 20)
        params: list[Any] = [pkg["package_id"], pkg["version"]]
        clauses = [
            "package_id = $1",
            "package_version = $2",
            "resource_type = 'StructureDefinition'",
            "derivation = 'constraint'",
            "kind = 'resource'",
        ]
        if base_type:
            params.append(base_type)
            clauses.append(f"base_type = ${len(params)}")
        rows = await self.pool.fetch(
            f"""SELECT artifact_id, canonical_url, title, name, base_type, raw_json
                FROM fhir.artifacts WHERE {' AND '.join(clauses)}""",
            *params,
        )
        want = [k.strip().lower() for k in (keys or []) if k and k.strip()]
        scored: list[dict] = []
        for r in rows:
            sd = _json_value(r["raw_json"])
            paths = fhir_snapshot.element_paths(sd)
            tails = {p.split(".")[-1].lower().rstrip("[x]") for p in paths if p}
            matched = sorted({k for k in want if k in tails})
            scored.append(
                {
                    "profile": r["artifact_id"],
                    "canonical": r["canonical_url"],
                    "title": r["title"] or r["name"] or r["artifact_id"],
                    "baseType": r["base_type"],
                    "score": len(matched),
                    "matchedKeys": matched,
                }
            )
        scored.sort(key=lambda c: (-c["score"], c["profile"]))
        data = {
            "selectionRequired": True,
            "inputKeys": want,
            "candidates": scored[:limit],
        }
        return self._ok(data, pkg)

    async def get_profile(
        self,
        identifier: str,
        package_id: Optional[str] = None,
        version: Optional[str] = None,
    ) -> str:
        try:
            pkg = await self._resolve(package_id, version)
        except fhir_ig.IGNotFoundError as e:
            return self._err("IG_NOT_FOUND", str(e))
        row = await self._load_artifact(pkg["package_id"], pkg["version"], identifier)
        if row is None:
            return self._err("ARTIFACT_NOT_FOUND", f"profile not found: {identifier}")
        sd = _json_value(row.get("raw_json"))
        data = {
            "artifactId": row.get("artifact_id"),
            "canonical": row.get("canonical_url"),
            "name": row.get("name"),
            "title": row.get("title"),
            "status": row.get("status"),
            "kind": row.get("kind"),
            "baseType": row.get("base_type") or sd.get("type"),
            "derivation": row.get("derivation"),
            "baseDefinition": sd.get("baseDefinition"),
            "description": sd.get("description"),
            "elementCount": len((sd.get("snapshot") or {}).get("element") or []),
        }
        return self._ok(data, pkg)

    # ------------------------------------------------------------------ #
    #  C. StructureDefinition snapshot reader (consolidated views)         #
    # ------------------------------------------------------------------ #

    async def get_profile_elements(
        self,
        profile: str,
        package_id: Optional[str] = None,
        version: Optional[str] = None,
        view: str = "elements",
        path: Optional[str] = None,
        slice_name: Optional[str] = None,
        limit: int = 200,
    ) -> str:
        if view not in _VALID_VIEWS:
            return self._err(
                "INVALID_ARGUMENT",
                f"view must be one of {sorted(_VALID_VIEWS)}",
            )
        if view in _PATH_REQUIRED_VIEWS and not path:
            return self._err("INVALID_ARGUMENT", f"path is required for view={view}")
        try:
            pkg = await self._resolve(package_id, version)
        except fhir_ig.IGNotFoundError as e:
            return self._err("IG_NOT_FOUND", str(e))
        row = await self._load_artifact(pkg["package_id"], pkg["version"], profile)
        if row is None:
            return self._err("ARTIFACT_NOT_FOUND", f"profile not found: {profile}")
        sd = _json_value(row.get("raw_json"))

        if view == "examples":
            data = await self._profile_examples(pkg, row.get("canonical_url"))
            return self._ok(data, pkg)

        result: Any
        if view == "elements":
            elements = fhir_snapshot.project_elements(sd)
            result = {
                "profile": row.get("artifact_id"),
                "total": len(elements),
                "elements": elements[: min(max(1, limit), 1000)],
            }
        elif view == "element":
            result = fhir_snapshot.get_element(sd, path, slice_name)
        elif view == "slices":
            result = fhir_snapshot.get_slices(sd, path)
        elif view == "choices":
            result = fhir_snapshot.get_choices(sd, path)
        elif view == "binding":
            result = fhir_snapshot.get_binding(sd, path)
        else:  # pragma: no cover - guarded above
            result = None

        warnings = []
        if result is None:
            warnings.append(f"no {view} found at path '{path}'")
        return self._ok({"view": view, "result": result}, pkg, warnings)

    async def _profile_examples(self, pkg: dict, canonical: Optional[str]) -> dict:
        """Example instances whose ``meta.profile`` cites this profile's canonical."""
        if not canonical:
            return {"count": 0, "examples": []}
        rows = await self.pool.fetch(
            """SELECT artifact_id, resource_type, canonical_url, title, name
               FROM fhir.artifacts
               WHERE package_id = $1 AND package_version = $2
                 AND grouping_id = 'examples'
                 AND raw_json -> 'meta' -> 'profile' ? $3
               ORDER BY resource_type, artifact_id""",
            pkg["package_id"],
            pkg["version"],
            canonical,
        )
        return {
            "count": len(rows),
            "examples": [
                {
                    "artifactId": r["artifact_id"],
                    "resourceType": r["resource_type"],
                    "title": r["title"] or r["name"] or r["artifact_id"],
                }
                for r in rows
            ],
        }

    # ------------------------------------------------------------------ #
    #  D. Terminology                                                      #
    # ------------------------------------------------------------------ #

    async def _load_valueset(self, pkg: dict, identifier: str) -> Optional[dict]:
        row = await self._load_artifact(pkg["package_id"], pkg["version"], identifier)
        if row is None:
            return None
        if (row.get("resource_type") or "").lower() != "valueset" and not (
            _json_value(row.get("raw_json")).get("resourceType") == "ValueSet"
        ):
            return None
        return _json_value(row.get("raw_json"))

    async def get_valueset(
        self,
        identifier: str,
        package_id: Optional[str] = None,
        version: Optional[str] = None,
    ) -> str:
        try:
            pkg = await self._resolve(package_id, version)
        except fhir_ig.IGNotFoundError as e:
            return self._err("IG_NOT_FOUND", str(e))
        vs = await self._load_valueset(pkg, identifier)
        if vs is None:
            return self._err("VALUESET_NOT_FOUND", f"ValueSet not found: {identifier}")
        data = {
            "valueSetId": vs.get("id"),
            "canonical": vs.get("url"),
            "name": vs.get("name"),
            "title": vs.get("title"),
            "status": vs.get("status"),
            "description": vs.get("description"),
            "compose": vs.get("compose") or {},
        }
        return self._ok(data, pkg)

    async def expand_valueset(
        self,
        identifier: str,
        package_id: Optional[str] = None,
        version: Optional[str] = None,
        limit: int = fhir_terminology.DEFAULT_EXPAND_LIMIT,
    ) -> str:
        try:
            pkg = await self._resolve(package_id, version)
        except fhir_ig.IGNotFoundError as e:
            return self._err("IG_NOT_FOUND", str(e))
        vs = await self._load_valueset(pkg, identifier)
        if vs is None:
            return self._err("VALUESET_NOT_FOUND", f"ValueSet not found: {identifier}")
        limit = min(max(1, limit), 2000)
        exp = await fhir_terminology.expand_compose(
            self.pool, vs.get("compose") or {}, pkg, limit
        )
        data = {
            "valueSetId": vs.get("id"),
            "canonical": vs.get("url"),
            "total": exp["total"],
            "truncated": exp["truncated"],
            "unresolved": exp["unresolved"],
            "codings": exp["codings"],
        }
        return self._ok(data, pkg, exp["warnings"])

    async def lookup_code(
        self,
        system: str,
        code: str,
        package_id: Optional[str] = None,
        version: Optional[str] = None,
    ) -> str:
        try:
            pkg = await self._resolve(package_id, version)
        except fhir_ig.IGNotFoundError as e:
            return self._err("IG_NOT_FOUND", str(e))
        found = await fhir_terminology.lookup(self.pool, system, code, pkg)
        warnings = []
        if found is None:
            warnings.append(
                "code not found in locally held terminology — it may belong to an "
                "external system (TERMINOLOGY_SERVER_REQUIRED)"
            )
        data = {
            "system": system,
            "code": code,
            "found": found is not None,
            "display": found["display"] if found else None,
            "definition": found.get("definition") if found else None,
        }
        return self._ok(data, pkg, warnings)

    async def validate_code(
        self,
        system: str,
        code: str,
        value_set: str,
        package_id: Optional[str] = None,
        version: Optional[str] = None,
    ) -> str:
        try:
            pkg = await self._resolve(package_id, version)
        except fhir_ig.IGNotFoundError as e:
            return self._err("IG_NOT_FOUND", str(e))
        vs = await self._load_valueset(pkg, value_set)
        if vs is None:
            return self._err("VALUESET_NOT_FOUND", f"ValueSet not found: {value_set}")
        exp = await fhir_terminology.expand_compose(
            self.pool, vs.get("compose") or {}, pkg
        )
        member = any(
            c["system"] == system and c["code"] == code for c in exp["codings"]
        )
        # Honesty contract: if the bound system could not be fully expanded
        # (truncated, or this system is unresolved/TOO_BROAD), do not assert
        # invalid — report unverifiable with a warning.
        sys_unresolved = any(u.get("system") == system for u in exp["unresolved"])
        warnings = list(exp["warnings"])
        if member:
            result = "valid"
        elif exp["truncated"] or sys_unresolved:
            result = "unverifiable"
            warnings.append(
                "membership could not be confirmed locally (expansion truncated or "
                "system not held); confirm against a terminology server"
            )
        else:
            result = "invalid"
        data = {
            "system": system,
            "code": code,
            "valueSet": vs.get("url") or value_set,
            "result": result,
            "valid": member,
        }
        return self._ok(data, pkg, warnings)

    async def normalize_code(
        self,
        text: str,
        value_set: Optional[str] = None,
        system: Optional[str] = None,
        package_id: Optional[str] = None,
        version: Optional[str] = None,
        limit: int = 10,
    ) -> str:
        if not (value_set or system):
            return self._err(
                "INVALID_ARGUMENT", "provide a value_set or a target system"
            )
        try:
            pkg = await self._resolve(package_id, version)
        except fhir_ig.IGNotFoundError as e:
            return self._err("IG_NOT_FOUND", str(e))
        limit = min(max(1, limit), 50)

        targets, scope_ids, warnings = await self._normalize_targets(
            pkg, value_set, system
        )
        if not targets:
            return self._err(
                "VALUESET_NOT_FOUND" if value_set else "INVALID_ARGUMENT",
                "could not determine a target system to normalize against",
            )

        candidates: list[dict] = []
        seen: set[tuple] = set()

        def add(sys_: str, code: str, display, source: str, score: float):
            key = (sys_, code)
            if key in seen or not code:
                return
            seen.add(key)
            candidates.append(
                {
                    "system": sys_,
                    "code": code,
                    "display": display,
                    "source": source,
                    "score": round(score, 4),
                }
            )

        # (a) ConceptMap
        for sys_, code, display in await self._normalize_conceptmap(pkg, text, targets):
            add(sys_, code, display, "conceptmap", 1.0)
        # (b) lexical + (c) semantic, per target system
        for tgt in targets:
            for sys_, code, display in await self._normalize_lexical(
                pkg, tgt, text, scope_ids.get(tgt["system"]), limit
            ):
                add(sys_, code, display, "lexical", 0.6)
            for sys_, code, display, dist in await self._normalize_semantic(
                tgt, text, scope_ids.get(tgt["system"]), limit
            ):
                add(sys_, code, display, "semantic", max(0.0, 1.0 - dist))

        order = {"conceptmap": 0, "lexical": 1, "semantic": 2}
        candidates.sort(key=lambda c: (order.get(c["source"], 9), -c["score"]))
        if self.embedding_svc is None:
            warnings.append("semantic search unavailable (no embedding service)")
        data = {
            "text": text,
            "targets": [t["system"] for t in targets],
            "candidates": candidates[:limit],
            "note": "candidates are suggestions — confirm with fhir_validate_code",
        }
        return self._ok(data, pkg, warnings)

    async def _normalize_targets(self, pkg, value_set, system):
        """Resolve which systems to normalize against + any SNOMED descendant scope.
        Returns (targets, scope_ids_by_system, warnings)."""
        warnings: list[str] = []
        targets: list[dict] = []
        scope_ids: dict[str, list[int]] = {}
        seen: set[str] = set()

        def add_target(sys_: str):
            if not sys_ or sys_ in seen:
                return
            seen.add(sys_)
            targets.append(
                {"system": sys_, "kind": fhir_terminology.route_system(sys_)}
            )

        if system:
            add_target(system)
        if value_set:
            vs = await self._load_valueset(pkg, value_set)
            if vs is None:
                warnings.append(f"ValueSet not found: {value_set}")
            else:
                for inc in (vs.get("compose") or {}).get("include") or []:
                    sys_ = inc.get("system")
                    add_target(sys_)
                    for f in inc.get("filter") or []:
                        if sys_ == fhir_terminology.SNOMED_SYSTEM and f.get("op") in (
                            "is-a",
                            "descendent-of",
                        ):
                            ids = await fhir_terminology.snomed_descendants(
                                self.pool, f.get("value"), 5000
                            )
                            scope_ids.setdefault(sys_, []).extend(ids)
        return targets, scope_ids, warnings

    async def _normalize_conceptmap(self, pkg, text, targets):
        target_systems = {t["system"] for t in targets}
        pids, pvers = fhir_terminology._closure_arrays(pkg)
        rows = await self.pool.fetch(
            "SELECT a.raw_json FROM fhir.artifacts a "
            "JOIN unnest($1::text[], $2::text[]) AS dep(pid, pver) "
            "  ON a.package_id = dep.pid AND a.package_version = dep.pver "
            "WHERE a.resource_type = 'ConceptMap'",
            pids,
            pvers,
        )
        needle = (text or "").strip().lower()
        out: list[tuple] = []
        for r in rows:
            cm = _json_value(r["raw_json"])
            for group in cm.get("group") or []:
                if group.get("target") not in target_systems:
                    continue
                for el in group.get("element") or []:
                    src_disp = (el.get("display") or "").strip().lower()
                    src_code = (el.get("code") or "").strip().lower()
                    if needle and (
                        needle == src_disp or needle == src_code or needle in src_disp
                    ):
                        for tgt in el.get("target") or []:
                            out.append(
                                (group["target"], tgt.get("code"), tgt.get("display"))
                            )
        return out

    async def _normalize_lexical(self, pkg, target, text, scope_ids, limit):
        kind = target["kind"]
        sys_ = target["system"]
        like = f"%{(text or '').strip()}%"
        out: list[tuple] = []
        if kind == "snomed":
            if scope_ids:
                rows = await self.pool.fetch(
                    "SELECT DISTINCT ON (concept_id) concept_id, term FROM snomed.descriptions "
                    "WHERE active = TRUE AND term ILIKE $1 AND concept_id = ANY($2::bigint[]) "
                    "ORDER BY concept_id LIMIT $3",
                    like,
                    scope_ids,
                    limit,
                )
            else:
                rows = await self.pool.fetch(
                    "SELECT DISTINCT ON (concept_id) concept_id, term FROM snomed.descriptions "
                    "WHERE active = TRUE AND term ILIKE $1 ORDER BY concept_id LIMIT $2",
                    like,
                    limit,
                )
            out = [(sys_, str(r["concept_id"]), r["term"]) for r in rows]
        elif kind == "loinc":
            rows = await self.pool.fetch(
                "SELECT loinc_num, long_common_name FROM loinc.concepts "
                "WHERE long_common_name ILIKE $1 LIMIT $2",
                like,
                limit,
            )
            out = [(sys_, r["loinc_num"], r["long_common_name"]) for r in rows]
        elif kind in ("icd_dx", "icd_pcs"):
            table = "icd.diagnoses" if kind == "icd_dx" else "icd.procedures"
            rows = await self.pool.fetch(
                f"SELECT code, name_en, name_zh FROM {table} "
                f"WHERE name_en ILIKE $1 OR name_zh ILIKE $1 LIMIT $2",
                like,
                limit,
            )
            out = [(sys_, r["code"], r["name_en"] or r["name_zh"]) for r in rows]
        else:
            # ig OR heuristically-external systems whose CodeSystem we hold (e.g.
            # base-FHIR administrative-gender) — match against held concepts in
            # the dependency closure.
            pids, pvers = fhir_terminology._closure_arrays(pkg)
            rows = await self.pool.fetch(
                "SELECT c.code, c.display FROM fhir.concepts c "
                "JOIN unnest($1::text[], $2::text[]) AS dep(pid, pver) "
                "  ON c.package_id = dep.pid AND c.package_version = dep.pver "
                "WHERE c.cs_id = $3 AND (c.display ILIKE $4 OR c.code ILIKE $4) "
                "LIMIT $5",
                pids,
                pvers,
                fhir_terminology._canonical_tail(sys_),
                like,
                limit,
            )
            out = [(sys_, r["code"], r["display"]) for r in rows]
        return out

    async def _normalize_semantic(self, target, text, scope_ids, limit):
        if self.embedding_svc is None:
            return []
        kind = target["kind"]
        sys_ = target["system"]
        try:
            vec = await self.embedding_svc.embed(text)
        except Exception:
            vec = None
        if not vec:
            return []
        vec_str = f"[{','.join(str(x) for x in vec)}]"
        out: list[tuple] = []
        if kind == "snomed":
            if scope_ids:
                rows = await self.pool.fetch(
                    "SELECT e.concept_id, "
                    "(SELECT term FROM snomed.descriptions d WHERE d.concept_id = e.concept_id "
                    " AND d.active = TRUE ORDER BY d.us_preferred DESC NULLS LAST LIMIT 1) AS term, "
                    "e.embedding <=> $1::halfvec AS dist FROM snomed.concept_embeddings e "
                    "WHERE e.concept_id = ANY($2::bigint[]) ORDER BY dist LIMIT $3",
                    vec_str,
                    scope_ids,
                    limit,
                )
            else:
                rows = await self.pool.fetch(
                    "SELECT e.concept_id, "
                    "(SELECT term FROM snomed.descriptions d WHERE d.concept_id = e.concept_id "
                    " AND d.active = TRUE ORDER BY d.us_preferred DESC NULLS LAST LIMIT 1) AS term, "
                    "e.embedding <=> $1::halfvec AS dist FROM snomed.concept_embeddings e "
                    "ORDER BY dist LIMIT $2",
                    vec_str,
                    limit,
                )
            out = [
                (sys_, str(r["concept_id"]), r["term"], float(r["dist"])) for r in rows
            ]
        elif kind == "loinc":
            rows = await self.pool.fetch(
                "SELECT e.loinc_num, c.long_common_name, e.embedding <=> $1::halfvec AS dist "
                "FROM loinc.concept_embeddings e JOIN loinc.concepts c ON c.loinc_num = e.loinc_num "
                "ORDER BY dist LIMIT $2",
                vec_str,
                limit,
            )
            out = [
                (sys_, r["loinc_num"], r["long_common_name"], float(r["dist"]))
                for r in rows
            ]
        elif kind == "icd_dx":
            rows = await self.pool.fetch(
                "SELECT e.code, c.name_en, e.embedding <=> $1::halfvec AS dist "
                "FROM icd.diagnosis_embeddings e JOIN icd.diagnoses c ON c.code = e.code "
                "ORDER BY dist LIMIT $2",
                vec_str,
                limit,
            )
            out = [(sys_, r["code"], r["name_en"], float(r["dist"])) for r in rows]
        return out

    # ------------------------------------------------------------------ #
    #  G. Validation (in-process, source:"builtin")                        #
    # ------------------------------------------------------------------ #

    async def _resolve_profile_sd(
        self, pkg: dict, resource: dict, profile: Optional[str]
    ) -> tuple[Optional[dict], Optional[str]]:
        """Resolve the StructureDefinition to validate against: explicit ``profile``
        wins, else ``resource.meta.profile[0]``, else ``None`` (caller degrades)."""
        identifier = profile
        if not identifier:
            metas = (resource.get("meta") or {}).get("profile") or []
            if metas:
                identifier = str(metas[0]).split("|")[0]
        if not identifier:
            return None, None
        row = await self._load_artifact(pkg["package_id"], pkg["version"], identifier)
        if row is None:
            return None, identifier
        return _json_value(row.get("raw_json")), row.get("artifact_id") or identifier

    async def _binding_issues(self, pkg: dict, sd: dict, resource: dict) -> list[dict]:
        root = sd.get("type") or resource.get("resourceType") or ""
        issues: list[dict] = []
        for el in (sd.get("snapshot") or {}).get("element") or []:
            if fhir_snapshot.is_slice_member(el):
                continue
            binding = el.get("binding") or {}
            if binding.get("strength") != "required" or not binding.get("valueSet"):
                continue
            path = el.get("path") or ""
            rel = fhir_validator._rel_path(path, root)
            if not rel:
                continue
            nodes = fhir_validator._get_at_path(resource, rel)
            if not nodes:
                continue
            type_code = (el.get("type") or [{}])[0].get("code")
            vs = await self._load_valueset(pkg, str(binding["valueSet"]).split("|")[0])
            if vs is None:
                issues.append(
                    fhir_validator.issue(
                        "warning",
                        path,
                        "binding-unresolved",
                        f"required binding ValueSet not held locally: {binding['valueSet']}",
                    )
                )
                continue
            exp = await fhir_terminology.expand_compose(
                self.pool, vs.get("compose") or {}, pkg
            )
            members = {(c["system"], c["code"]) for c in exp["codings"]}
            codes_only = {c["code"] for c in exp["codings"]}
            unverifiable = exp["truncated"] or bool(exp["unresolved"])
            for node in nodes:
                for system, code in _codings_of(node, type_code):
                    if code is None:
                        continue
                    ok = (system, code) in members or (
                        system is None and code in codes_only
                    )
                    if ok:
                        continue
                    if unverifiable:
                        issues.append(
                            fhir_validator.issue(
                                "warning",
                                path,
                                "binding-unverifiable",
                                f"{path}: code {system}|{code} could not be confirmed "
                                f"(binding ValueSet not fully expandable locally)",
                            )
                        )
                    else:
                        issues.append(
                            fhir_validator.issue(
                                "error",
                                path,
                                "binding",
                                f"{path}: code {system}|{code} is not in the required binding",
                            )
                        )
        return issues

    async def _validate_core(
        self, pkg: dict, resource: dict, profile: Optional[str]
    ) -> dict:
        sd, profile_id = await self._resolve_profile_sd(pkg, resource, profile)
        if sd is None:
            return {
                "valid": True,
                "profile": profile_id,
                "source": fhir_validator.SOURCE,
                "issues": [
                    fhir_validator.issue(
                        "warning",
                        "",
                        "no-profile",
                        "no resolvable profile (meta.profile absent and base "
                        "StructureDefinition not held) — structure not validated",
                    )
                ],
            }
        issues = (
            fhir_validator.validate_structure(sd, resource)
            + fhir_validator.validate_slicing(sd, resource)
            + fhir_validator.evaluate_invariants(sd, resource)
            + await self._binding_issues(pkg, sd, resource)
        )
        return {
            "valid": fhir_validator.is_valid(issues),
            "profile": profile_id,
            "source": fhir_validator.SOURCE,
            "issues": issues,
        }

    async def validate_resource(
        self,
        resource: dict,
        profile: Optional[str] = None,
        package_id: Optional[str] = None,
        version: Optional[str] = None,
    ) -> str:
        if not isinstance(resource, dict) or not resource.get("resourceType"):
            return self._err("INVALID_ARGUMENT", "resource must include a resourceType")
        try:
            pkg = await self._resolve(package_id, version)
        except fhir_ig.IGNotFoundError as e:
            return self._err("IG_NOT_FOUND", str(e))
        data = await self._validate_core(pkg, resource, profile)
        return self._ok(data, pkg)

    async def validate_bundle(
        self,
        bundle: dict,
        package_id: Optional[str] = None,
        version: Optional[str] = None,
    ) -> str:
        if not isinstance(bundle, dict) or bundle.get("resourceType") != "Bundle":
            return self._err(
                "INVALID_ARGUMENT", "bundle must be a FHIR Bundle resource"
            )
        try:
            pkg = await self._resolve(package_id, version)
        except fhir_ig.IGNotFoundError as e:
            return self._err("IG_NOT_FOUND", str(e))
        bundle_entries = bundle.get("entry") or []
        full_urls = {e.get("fullUrl") for e in bundle_entries if e.get("fullUrl")}
        entry_results: list[dict] = []
        reference_issues: list[dict] = []
        all_valid = True
        for be in bundle_entries:
            resource = be.get("resource") or {}
            if not resource.get("resourceType"):
                continue
            core = await self._validate_core(pkg, resource, None)
            all_valid = all_valid and core["valid"]
            entry_results.append(
                {
                    "fullUrl": be.get("fullUrl"),
                    "resourceType": resource.get("resourceType"),
                    "valid": core["valid"],
                    "profile": core["profile"],
                    "issues": core["issues"],
                }
            )
            # internal reference integrity
            refs: list[str] = []
            fhir_reference._collect_references(resource, refs)
            contained_ids = {
                "#" + c.get("id", "")
                for c in resource.get("contained") or []
                if c.get("id")
            }
            for ref in refs:
                if ref.startswith("urn:uuid:"):
                    if ref not in full_urls:
                        reference_issues.append(
                            {
                                "resourceType": resource.get("resourceType"),
                                "reference": ref,
                            }
                        )
                elif ref.startswith("#"):
                    if ref not in contained_ids:
                        reference_issues.append(
                            {
                                "resourceType": resource.get("resourceType"),
                                "reference": ref,
                            }
                        )
                # literal "Type/id" references are accepted (external/literal)
        data = {
            "valid": all_valid and not reference_issues,
            "source": fhir_validator.SOURCE,
            "entries": entry_results,
            "referenceIssues": reference_issues,
        }
        warnings = []
        if reference_issues:
            warnings.append(
                f"{len(reference_issues)} internal reference(s) did not resolve within the bundle"
            )
        return self._ok(data, pkg, warnings)

    # ------------------------------------------------------------------ #
    #  E. Schema-guided fill (authoring)                                   #
    # ------------------------------------------------------------------ #

    @staticmethod
    def _skeleton_keep(el: dict, rel: str) -> bool:
        """Focused filter: keep only elements the LLM should fill."""
        top = rel.split(".")[0]
        if top in _SKELETON_SKIP:
            return False
        fixed, pattern = fhir_snapshot._fixed_pattern(el)
        has_pin = fixed is not None or pattern is not None
        required = isinstance(el.get("min"), int) and el["min"] >= 1
        bound = bool(el.get("binding"))
        must = bool(el.get("mustSupport"))
        direct = "." not in rel and top not in ("extension", "modifierExtension")
        return required or must or bound or has_pin or direct

    @staticmethod
    def _slice_options(sd: dict, path: str) -> list[dict]:
        """For a data-sliced element (value/pattern discriminator, not extension
        url-slicing), list its slices + the fixed/pattern fields finalize will pin —
        so the LLM can pick a slice via ``_slice``."""
        if path.endswith(".extension") or path.endswith(".modifierExtension"):
            return []
        els = (sd.get("snapshot") or {}).get("element") or []
        head = next(
            (
                e
                for e in els
                if e.get("path") == path
                and e.get("slicing")
                and not fhir_snapshot.is_slice_member(e)
            ),
            None,
        )
        if head is None:
            return []
        disc = head["slicing"].get("discriminator") or []
        if not disc or any(d.get("type") not in ("value", "pattern") for d in disc):
            return []
        out: list[dict] = []
        for sl in els:
            if sl.get("path") != path or not sl.get("sliceName"):
                continue
            name = sl["sliceName"]
            child_prefix = f"{path}:{name}."
            pinned: list[dict] = []
            for e in els:
                if not (e.get("id") or "").startswith(child_prefix):
                    continue
                fixed, pattern = fhir_snapshot._fixed_pattern(e)
                if fixed is None and pattern is None:
                    continue
                pin = fixed or pattern
                pinned.append(
                    {
                        "subPath": (e.get("id") or "")[len(child_prefix) :],
                        "field": pin["field"],
                        "value": pin["value"],
                    }
                )
            out.append(
                {
                    "sliceName": name,
                    "min": sl.get("min"),
                    "max": sl.get("max"),
                    "short": sl.get("short"),
                    "autoPinned": pinned,
                }
            )
        return out

    async def get_resource_skeleton(
        self,
        profile: str,
        package_id: Optional[str] = None,
        version: Optional[str] = None,
        candidate_limit: int = 20,
        include_examples: bool = True,
    ) -> str:
        try:
            pkg = await self._resolve(package_id, version)
        except fhir_ig.IGNotFoundError as e:
            return self._err("IG_NOT_FOUND", str(e))
        row = await self._load_artifact(pkg["package_id"], pkg["version"], profile)
        if row is None:
            return self._err("ARTIFACT_NOT_FOUND", f"profile not found: {profile}")
        sd = _json_value(row.get("raw_json"))
        root = sd.get("type") or ""
        prefix = root + "."
        candidate_limit = min(max(1, candidate_limit), 100)

        fields: list[dict] = []
        warnings: list[str] = []
        for el in (sd.get("snapshot") or {}).get("element") or []:
            if fhir_snapshot.is_slice_member(el):
                continue
            path = el.get("path") or ""
            if not path.startswith(prefix):
                continue
            rel = path[len(prefix) :]
            if not self._skeleton_keep(el, rel):
                continue
            proj = fhir_snapshot.project_element(el)
            max_card = el.get("max")
            field: dict[str, Any] = {
                "path": path,
                "jsonPath": rel,
                "required": isinstance(el.get("min"), int) and el["min"] >= 1,
                "array": max_card == "*"
                or (str(max_card).isdigit() and int(max_card) > 1),
                "types": proj["types"],
                "mustSupport": proj["mustSupport"],
                "short": proj["short"],
            }
            if rel.endswith("[x]"):
                field["choices"] = [
                    fhir_snapshot._choice_property(path, t.get("code") or "")
                    for t in el.get("type") or []
                ]
            if proj["fixed"] or proj["pattern"]:
                pin = proj["fixed"] or proj["pattern"]
                field["autoPinned"] = {
                    "field": pin["field"],
                    "value": pin["value"],
                    "note": "system fills this on finalize — do not set",
                }
            if proj["binding"] and proj["binding"].get("valueSet"):
                vs_url = str(proj["binding"]["valueSet"]).split("|")[0]
                binding_info = {
                    "strength": proj["binding"]["strength"],
                    "valueSet": vs_url,
                    "candidateCodes": None,
                }
                vs = await self._load_valueset(pkg, vs_url)
                if vs is not None:
                    exp = await fhir_terminology.expand_compose(
                        self.pool, vs.get("compose") or {}, pkg, candidate_limit
                    )
                    binding_info["candidateCodes"] = exp["codings"][:candidate_limit]
                    binding_info["candidatesTruncated"] = exp["truncated"]
                else:
                    binding_info["note"] = "binding ValueSet not held locally"
                field["binding"] = binding_info
            slice_opts = self._slice_options(sd, path)
            if slice_opts:
                field["slices"] = slice_opts
                field["sliceHint"] = (
                    'This element is sliced. On each entry set "_slice" to one of '
                    "the listed sliceName values (a semantic choice, e.g. which kind "
                    "of identifier); fhir_finalize_resource then pins that slice's "
                    "fixed system/type and removes the tag. Do not set those "
                    "autoPinned fields yourself."
                )
            fields.append(field)

        examples = (
            (await self._profile_examples(pkg, row.get("canonical_url")))["examples"]
            if include_examples
            else []
        )
        data = {
            "profile": row.get("artifact_id"),
            "canonical": row.get("canonical_url"),
            "resourceType": root,
            "instructions": (
                "Fill the semantic blanks below. Leave 'autoPinned' fields and "
                "meta.profile to fhir_finalize_resource. Use the candidateCodes for "
                "bound elements (confirm with fhir_validate_code). Then call "
                "fhir_finalize_resource with your draft."
            ),
            "fields": fields,
            "examples": examples,
        }
        return self._ok(data, pkg, warnings)

    async def _infer_systems(self, pkg: dict, sd: dict, resource: dict) -> list[str]:
        """Conservative single-system inference: for required/extensible coded
        elements, fill a coding's missing ``system`` only when the bound ValueSet
        expands to codings that all share exactly one system. Mutates ``resource``;
        returns warnings for the ambiguous cases."""
        root = sd.get("type") or resource.get("resourceType") or ""
        warnings: list[str] = []
        for el in (sd.get("snapshot") or {}).get("element") or []:
            if fhir_snapshot.is_slice_member(el):
                continue
            binding = el.get("binding") or {}
            if binding.get("strength") not in ("required", "extensible"):
                continue
            if not binding.get("valueSet"):
                continue
            path = el.get("path") or ""
            rel = fhir_validator._rel_path(path, root)
            if not rel:
                continue
            nodes = fhir_validator._get_at_path(resource, rel)
            target_codings = []
            for node in nodes:
                if isinstance(node, dict) and isinstance(node.get("coding"), list):
                    target_codings.extend(node["coding"])
                elif isinstance(node, dict) and "code" in node:
                    target_codings.append(node)
            need = [c for c in target_codings if c.get("code") and not c.get("system")]
            if not need:
                continue
            vs = await self._load_valueset(pkg, str(binding["valueSet"]).split("|")[0])
            if vs is None:
                continue
            exp = await fhir_terminology.expand_compose(
                self.pool, vs.get("compose") or {}, pkg
            )
            systems = {c["system"] for c in exp["codings"] if c.get("system")}
            if len(systems) == 1:
                only = next(iter(systems))
                for c in need:
                    c["system"] = only
            else:
                warnings.append(
                    f"{path}: could not infer a single system for the coding "
                    f"(binding spans {len(systems)} systems) — set it explicitly"
                )
        return warnings

    async def finalize_resource(
        self,
        profile: str,
        draft: dict,
        context_id: Optional[str] = None,
        key: Optional[str] = None,
        package_id: Optional[str] = None,
        version: Optional[str] = None,
    ) -> str:
        if not isinstance(draft, dict):
            return self._err("INVALID_ARGUMENT", "draft must be a resource object")
        try:
            pkg = await self._resolve(package_id, version)
        except fhir_ig.IGNotFoundError as e:
            return self._err("IG_NOT_FOUND", str(e))
        row = await self._load_artifact(pkg["package_id"], pkg["version"], profile)
        if row is None:
            return self._err("ARTIFACT_NOT_FOUND", f"profile not found: {profile}")
        sd = _json_value(row.get("raw_json"))
        canonical = sd.get("url") or row.get("canonical_url")

        resource = copy.deepcopy(draft)
        resource.setdefault("resourceType", sd.get("type"))
        warnings: list[str] = []

        # 1. mechanical pins
        fhir_authoring.ensure_meta_profile(resource, canonical)
        pinned = fhir_authoring.pin_fixed_pattern(sd, resource)
        # 1b. slice-mandated fixed/pattern for entries tagged with `_slice`
        pinned_slices = fhir_authoring.pin_slices(sd, resource)
        # 2. safe single-system inference
        warnings += await self._infer_systems(pkg, sd, resource)
        # 3. reference wiring
        reference = None
        if key:
            context_id, reference = fhir_reference.mint(context_id, str(key))
        if context_id:
            fhir_reference._rewrite_references(
                resource, fhir_reference.get_map(context_id)
            )
        # 4. validate (does NOT auto-loop)
        core = await self._validate_core(
            pkg, resource, row.get("artifact_id") or profile
        )

        data = {
            "resource": resource,
            "validation": core,
            "pinned": pinned,
            "pinnedSlices": pinned_slices,
            "contextId": context_id,
            "reference": reference,
        }
        if not core["valid"]:
            warnings.append(
                "validation found errors — fix the draft and call finalize again"
            )
        return self._ok(data, pkg, warnings)
