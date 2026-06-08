"""
FHIR terminology resolver (Phase 2) — tiered ValueSet expansion + code lookup.

DB helpers (take the asyncpg pool) with no envelope logic, so they are reusable by
the FHIRIGService terminology tools now and by the Phase 4 validator's
required-binding check later. The guiding rule is the honesty contract: when a
system cannot be resolved from data we hold (and no dependency package supplies
it), say so (``unresolved`` / ``found:null``) — never fabricate a display.

Tiers (assessment §3 Gap 3):
  1. inline ``compose.include.concept``
  2. local systems we hold: IG ``fhir.concepts``, ``snomed.*``, ``loinc.*``, ``icd.*``
     (incl. SNOMED ``is-a`` descendant execution)
  3. imported ValueSets (``include.valueSet``) — resolved + recursed (depth-guarded)
  4. otherwise → ``TOO_BROAD`` (whole large system) / external → ``unresolved``
"""

from __future__ import annotations

from typing import Any, Optional

SNOMED_SYSTEM = "http://snomed.info/sct"
LOINC_SYSTEM = "http://loinc.org"
SNOMED_IS_A = 116680003  # Is-a relationship type (mirrors snomed_service.IS_A_TYPE)

DEFAULT_EXPAND_LIMIT = 500
_MAX_IMPORT_DEPTH = 5


def _canonical_tail(url: Optional[str]) -> str:
    if not url:
        return ""
    return url.rstrip("/").split("/")[-1].split("|")[0]


def _closure_arrays(pkg: dict) -> tuple[list[str], list[str]]:
    """Parallel ``(package_ids, package_versions)`` arrays for the package's
    dependency closure — used to scope concept/ConceptMap queries across the
    target package *and* its dependencies (where base-FHIR/THO concepts live).
    Falls back to the single resolved package when no closure was attached."""
    closure = pkg.get("_closure") or [(pkg.get("package_id"), pkg.get("version"))]
    pids = [c[0] for c in closure]
    pvers = [c[1] for c in closure]
    return pids, pvers


def route_system(system: Optional[str], cs_id: Optional[str] = None) -> str:
    """Map a code ``system`` (and/or a CodeSystem id) to a local backing store:
    ``ig`` | ``snomed`` | ``loinc`` | ``icd_dx`` | ``icd_pcs`` | ``external``."""
    if system == SNOMED_SYSTEM:
        return "snomed"
    if system == LOINC_SYSTEM:
        return "loinc"
    tail = cs_id or _canonical_tail(system)
    if tail.startswith("icd-10-pcs") or tail.startswith("icd-9-pcs"):
        return "icd_pcs"
    if tail.startswith("icd-10-cm") or tail.startswith("icd-9-cm"):
        return "icd_dx"
    if cs_id or (system and "/CodeSystem/" in system):
        return "ig"
    return "external"


async def lookup(
    pool,
    system: Optional[str],
    code: str,
    pkg: dict,
    cs_id: Optional[str] = None,
) -> Optional[dict]:
    """Resolve a ``(system, code)`` to ``{display, definition}`` from local data,
    or ``None`` when it is not held (external system / unknown code)."""
    kind = route_system(system, cs_id)
    if kind == "snomed":
        if not str(code).isdigit():
            return None
        row = await pool.fetchrow(
            "SELECT term FROM snomed.descriptions "
            "WHERE concept_id = $1 AND active = TRUE "
            "ORDER BY us_preferred DESC NULLS LAST LIMIT 1",
            int(code),
        )
        return {"display": row["term"], "definition": None} if row else None
    if kind == "loinc":
        row = await pool.fetchrow(
            "SELECT long_common_name, shortname FROM loinc.concepts WHERE loinc_num = $1",
            code,
        )
        return (
            {"display": row["long_common_name"], "definition": row["shortname"]}
            if row
            else None
        )
    if kind in ("icd_dx", "icd_pcs"):
        table = "icd.diagnoses" if kind == "icd_dx" else "icd.procedures"
        row = await pool.fetchrow(
            f"SELECT name_en, name_zh FROM {table} WHERE code = $1", code
        )
        return (
            {"display": row["name_en"], "definition": row["name_zh"]} if row else None
        )
    # Default ("ig" or heuristically-"external"): the route_system heuristic only
    # flags ``…/CodeSystem/…`` URLs as ig, but base-FHIR CodeSystems use
    # ``http://hl7.org/fhir/<id>``. Resolve against concepts actually held in the
    # closure (returns None — never a guess — when not held).
    tail = cs_id or _canonical_tail(system)
    if not tail:
        return None
    pids, pvers = _closure_arrays(pkg)
    row = await pool.fetchrow(
        "SELECT c.display, c.definition FROM fhir.concepts c "
        "JOIN unnest($1::text[], $2::text[]) AS dep(pid, pver) "
        "  ON c.package_id = dep.pid AND c.package_version = dep.pver "
        "WHERE c.cs_id = $3 AND c.code = $4 LIMIT 1",
        pids,
        pvers,
        tail,
        code,
    )
    return {"display": row["display"], "definition": row["definition"]} if row else None


async def snomed_descendants(pool, code: str, limit: int) -> list[int]:
    """Concept ids that are ``is-a`` descendants of ``code`` (inclusive), capped."""
    if not str(code).isdigit():
        return []
    rows = await pool.fetch(
        """
        WITH RECURSIVE descendants AS (
            SELECT concept_id FROM snomed.concepts WHERE concept_id = $1
            UNION
            SELECT r.source_id
            FROM snomed.relationships r
            JOIN descendants d ON r.destination_id = d.concept_id
            WHERE r.type_id = $2 AND r.active = TRUE
        )
        SELECT concept_id FROM descendants LIMIT $3
        """,
        int(code),
        SNOMED_IS_A,
        limit,
    )
    return [r["concept_id"] for r in rows]


async def snomed_displays(pool, ids: list[int]) -> dict[int, str]:
    if not ids:
        return {}
    rows = await pool.fetch(
        """
        SELECT DISTINCT ON (concept_id) concept_id, term
        FROM snomed.descriptions
        WHERE concept_id = ANY($1::bigint[]) AND active = TRUE
        ORDER BY concept_id, us_preferred DESC NULLS LAST
        """,
        ids,
    )
    return {r["concept_id"]: r["term"] for r in rows}


async def _load_valueset_by_canonical(pool, url: str, pkg: dict) -> Optional[dict]:
    pids, pvers = _closure_arrays(pkg)
    row = await pool.fetchrow(
        "SELECT a.raw_json FROM fhir.artifacts a "
        "JOIN unnest($1::text[], $2::text[]) AS dep(pid, pver) "
        "  ON a.package_id = dep.pid AND a.package_version = dep.pver "
        "WHERE a.resource_type = 'ValueSet' "
        "AND (a.canonical_url = $3 OR a.artifact_id = $4) LIMIT 1",
        pids,
        pvers,
        url.split("|")[0],
        _canonical_tail(url),
    )
    if row is None:
        return None
    raw = row["raw_json"]
    if isinstance(raw, str):
        import json

        try:
            return json.loads(raw)
        except Exception:
            return None
    return raw


async def expand_compose(
    pool,
    compose: dict,
    pkg: dict,
    limit: int = DEFAULT_EXPAND_LIMIT,
    *,
    _depth: int = 0,
    _seen_vs: Optional[set] = None,
) -> dict:
    """Tiered expansion of a ValueSet ``compose`` block. Returns
    ``{codings, total, truncated, warnings, unresolved}``."""
    _seen_vs = _seen_vs or set()
    codings: list[dict] = []
    warnings: list[str] = []
    unresolved: list[dict] = []
    seen: set[tuple] = set()
    state = {"truncated": False}

    def add(system: Optional[str], code: str, display: Optional[str]) -> bool:
        key = (system, code)
        if key in seen:
            return True
        if len(codings) >= limit:
            state["truncated"] = True
            return False
        seen.add(key)
        codings.append({"system": system, "code": code, "display": display})
        return True

    for inc in (compose or {}).get("include") or []:
        system = inc.get("system")

        # (3) imported ValueSets
        for vs_url in inc.get("valueSet") or []:
            if _depth >= _MAX_IMPORT_DEPTH or vs_url in _seen_vs:
                warnings.append(f"valueSet import not expanded (depth/cycle): {vs_url}")
                continue
            sub_vs = await _load_valueset_by_canonical(pool, vs_url, pkg)
            if sub_vs is None:
                unresolved.append({"valueSet": vs_url, "reason": "VALUESET_NOT_FOUND"})
                continue
            sub = await expand_compose(
                pool,
                sub_vs.get("compose") or {},
                pkg,
                limit,
                _depth=_depth + 1,
                _seen_vs=_seen_vs | {vs_url},
            )
            warnings += sub["warnings"]
            unresolved += sub["unresolved"]
            state["truncated"] = state["truncated"] or sub["truncated"]
            for c in sub["codings"]:
                if not add(c["system"], c["code"], c.get("display")):
                    break

        # (1) inline concepts
        if inc.get("concept"):
            for c in inc["concept"]:
                display = c.get("display")
                if display is None and system:
                    look = await lookup(pool, system, c.get("code"), pkg)
                    display = look["display"] if look else None
                if not add(system, c.get("code"), display):
                    break
            continue

        # (2) filters
        if inc.get("filter"):
            for f in inc["filter"]:
                op = f.get("op")
                val = f.get("value")
                if system == SNOMED_SYSTEM and op in ("is-a", "descendent-of"):
                    # fetch one extra so the cap in add() can flag truncation
                    ids = await snomed_descendants(pool, val, limit + 1)
                    disp = await snomed_displays(pool, ids)
                    for cid in ids:
                        if not add(SNOMED_SYSTEM, str(cid), disp.get(cid)):
                            break
                elif op == "=":
                    look = await lookup(pool, system, val, pkg)
                    if look:
                        add(system, val, look["display"])
                    else:
                        unresolved.append(
                            {"system": system, "reason": "FILTER_EQ_UNRESOLVED"}
                        )
                else:
                    warnings.append(f"unsupported filter op '{op}' on {system}")
                    unresolved.append({"system": system, "reason": f"filter:{op}"})
            continue

        # (4) whole-system include — enumerate from concepts we hold (in the
        # dependency closure), for ig *and* heuristically-external systems whose
        # CodeSystem we actually store (e.g. base-FHIR administrative-gender).
        if system:
            rows = []
            if route_system(system) not in ("snomed", "loinc", "icd_dx", "icd_pcs"):
                pids, pvers = _closure_arrays(pkg)
                rows = await pool.fetch(
                    "SELECT c.code, c.display FROM fhir.concepts c "
                    "JOIN unnest($1::text[], $2::text[]) AS dep(pid, pver) "
                    "  ON c.package_id = dep.pid AND c.package_version = dep.pver "
                    "WHERE c.cs_id = $3 LIMIT $4",
                    pids,
                    pvers,
                    _canonical_tail(system),
                    limit + 1,
                )
            if rows:
                for r in rows:
                    if not add(system, r["code"], r["display"]):
                        break
            else:
                warnings.append(f"TOO_BROAD: whole-system not enumerated: {system}")
                unresolved.append({"system": system, "reason": "TOO_BROAD"})

    # excludes
    excl: set[tuple] = set()
    for exc in (compose or {}).get("exclude") or []:
        esys = exc.get("system")
        for c in exc.get("concept") or []:
            excl.add((esys, c.get("code")))
    if excl:
        codings = [c for c in codings if (c["system"], c["code"]) not in excl]

    return {
        "codings": codings,
        "total": len(codings),
        "truncated": state["truncated"],
        "warnings": warnings,
        "unresolved": unresolved,
    }
