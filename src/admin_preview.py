"""
Admin module preview query handlers.

Each function handles one module's  GET /admin/api/modules/{key}/preview
request and returns a dict (later JSON-serialised by the HTTP handler).

All queries degrade gracefully when the module is empty (returns empty
results rather than errors) so the UI can show a helpful "no data loaded"
state without HTTP 500.
"""

from __future__ import annotations

import json
from typing import Any

import asyncpg

from database import PoolLike

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_SNOMED_ISA_TYPE_ID = 116680003  # IS-A relationship
_SNOMED_FSN_TYPE_ID = 900000000000003001  # Fully Specified Name
_SNOMED_SYNONYM_TYPE_ID = 900000000000013009  # Synonym / preferred term source
_SNOMED_ROOT_CONCEPT = 138875005  # SNOMED CT Concept (the root)
_SNOMED_PAGE_SIZE = 50

_LOINC_PAGE_SIZE = 20
_DRUG_PAGE_SIZE = 50
_HF_PAGE_SIZE = 30
_FN_PAGE_SIZE = 30

# LOINC ValueSet filter property -> loinc.concepts column (whitelist; used to
# expand `property = value` filter bindings against the locally loaded LOINC).
_LOINC_FILTER_COLUMNS = {
    "CLASS": "class",
    "CLASSTYPE": "classtype",
    "SCALE_TYP": "scale_type",
    "COMPONENT": "component",
    "SYSTEM": "system",
    "PROPERTY": "property",
    "METHOD_TYP": "method_type",
    "TIME_ASPCT": "time_aspect",
}

# SNOMED historical-association refsets, most-specific first. When a ValueSet
# filter anchors on a concept that was retired in the loaded SNOMED edition
# (common for FHIR R4 core ValueSets pinned to older SNOMED codes), we resolve
# it to its successor via these associations and expand from there.
_SNOMED_HIST_ASSOC = {
    900000000000527005: (1, "SAME AS"),
    900000000000526001: (2, "REPLACED BY"),
    1186924009: (3, "POSSIBLY REPLACED BY"),
    900000000000523009: (4, "POSSIBLY EQUIVALENT TO"),
    900000000000528000: (5, "WAS A"),
    900000000000530003: (6, "ALTERNATIVE"),
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _iso(val: Any) -> str | None:
    if val is None:
        return None
    if hasattr(val, "isoformat"):
        return val.isoformat()
    return str(val)


# ---------------------------------------------------------------------------
# ICD-10  (diagnoses tree + procedures search)
# ---------------------------------------------------------------------------


async def preview_icd(
    pool: PoolLike,
    *,
    node: str | None = None,
    q: str | None = None,
    table: str = "cm",  # 'cm' | 'pcs'
    category: str = "",
    code_prefix: str = "",
    code_from: str = "",
    code_to: str = "",
    zh_filter: str = "all",
    sort: str = "code",
    direction: str = "asc",
    page: int = 1,
    per_page: int = 50,
) -> dict[str, Any]:
    """ICD-10 preview.

    Modes
    -----
    ``?node=root``            : chapters (distinct categories)
    ``?node={3char}``         : leaf codes in that category
    ``?q={text}``             : full-text search across CM and PCS
    ``?table=pcs&q={text}``   : search PCS procedures only
    """
    async with pool.acquire() as conn:
        # ── Row-count check ──────────────────────────────────────────────
        total_cm = int(await conn.fetchval("SELECT COUNT(*) FROM icd.diagnoses") or 0)
        total_pcs = int(await conn.fetchval("SELECT COUNT(*) FROM icd.procedures") or 0)
        if total_cm == 0 and total_pcs == 0:
            return {
                "type": "empty",
                "message": "ICD-10 module not loaded. Run the import first.",
                "total_cm": 0,
                "total_pcs": 0,
            }

        table = "pcs" if table == "pcs" else "cm"
        category = (category or "").strip().upper()
        code_prefix = (code_prefix or "").strip().upper()
        code_from = (code_from or "").strip().upper()
        code_to = (code_to or "").strip().upper()
        zh_filter = (
            zh_filter if zh_filter in {"all", "with_zh", "missing_zh"} else "all"
        )
        direction = "desc" if direction == "desc" else "asc"
        sort_map = {
            "code": "code",
            "name_en": "name_en",
            "name_zh": "name_zh",
            "category": "category",
        }
        sort_col = sort_map.get(sort, "code")
        if table == "pcs" and sort_col == "category":
            sort_col = "code"
        page = max(1, int(page or 1))
        per_page = max(1, min(int(per_page or 50), 100))
        offset = (page - 1) * per_page

        # ── Tree mode: root ────────────────────────────────────────────────
        show_category_root = (
            table == "cm"
            and (node is None or node == "root")
            and not (q and q.strip())
            and not category
            and not code_prefix
            and not code_from
            and not code_to
            and zh_filter == "all"
            and sort_col == "code"
            and direction == "asc"
        )
        if show_category_root:
            # Each distinct category = one 3-char code group.
            # Return the category code, its name, and the leaf-code count.
            rows = await conn.fetch("""
                SELECT
                    d.category                     AS code,
                    p.name_en                      AS name_en,
                    COALESCE(p.name_zh, '')         AS name_zh,
                    COUNT(d.code)                  AS child_count
                FROM icd.diagnoses d
                LEFT JOIN icd.diagnoses p ON p.code = d.category
                WHERE d.code <> d.category          -- exclude the category code itself
                GROUP BY d.category, p.name_en, p.name_zh
                ORDER BY d.category
                """)
            nodes = [
                {
                    "code": r["code"],
                    "name_en": r["name_en"] or r["code"],
                    "name_zh": r["name_zh"] or "",
                    "child_count": int(r["child_count"]),
                    "is_leaf": False,
                }
                for r in rows
            ]
            return {
                "type": "tree_root",
                "total_cm": total_cm,
                "total_pcs": total_pcs,
                "nodes": nodes,
                "rows": nodes,
                "total": len(nodes),
                "page": 1,
                "per_page": len(nodes),
                "category_options": nodes,
            }

        # ── Tree mode: expand a 3-char category node ──────────────────────
        if node and node != "root":
            category = node.strip().upper()

        # ── Paginated browse/search/filter mode ───────────────────────────
        params: list[Any] = []
        conditions: list[str] = []
        query = (q or "").strip()
        if query:
            params.append(f"%{query}%")
            conditions.append(
                f"(code ILIKE ${len(params)} OR name_en ILIKE ${len(params)} "
                f"OR name_zh ILIKE ${len(params)})"
            )
        if code_prefix:
            params.append(f"{code_prefix}%")
            conditions.append(f"code ILIKE ${len(params)}")
        if code_from:
            params.append(code_from)
            conditions.append(f"code >= ${len(params)}")
        if code_to:
            params.append(code_to)
            conditions.append(f"code <= ${len(params)}")
        if zh_filter == "with_zh":
            conditions.append("NULLIF(BTRIM(name_zh), '') IS NOT NULL")
        elif zh_filter == "missing_zh":
            conditions.append("NULLIF(BTRIM(name_zh), '') IS NULL")
        if table == "cm" and category:
            params.append(category)
            conditions.append(f"category = ${len(params)}")

        source_table = "icd.procedures" if table == "pcs" else "icd.diagnoses"
        select_category = (
            "CAST(NULL AS TEXT) AS category" if table == "pcs" else "category"
        )
        where_sql = "WHERE " + " AND ".join(conditions) if conditions else ""
        order_sql = f"{sort_col} {direction.upper()} NULLS LAST, code ASC"

        total = int(
            await conn.fetchval(
                f"SELECT COUNT(*) FROM {source_table} {where_sql}",
                *params,
            )
            or 0
        )
        rows = await conn.fetch(
            f"""
            SELECT code, name_en, name_zh, {select_category}
            FROM {source_table}
            {where_sql}
            ORDER BY {order_sql}
            LIMIT ${len(params) + 1} OFFSET ${len(params) + 2}
            """,
            *params,
            per_page,
            offset,
        )
        result_rows = [
            {
                "code": r["code"],
                "name_en": r["name_en"] or "",
                "name_zh": r["name_zh"] or "",
                "category": r["category"] or "",
            }
            for r in rows
        ]
        category_rows = await conn.fetch("""
            SELECT
                d.category AS code,
                COALESCE(p.name_en, d.category) AS name_en,
                COALESCE(p.name_zh, '') AS name_zh,
                COUNT(d.code) AS child_count
            FROM icd.diagnoses d
            LEFT JOIN icd.diagnoses p ON p.code = d.category
            WHERE d.code <> d.category
            GROUP BY d.category, p.name_en, p.name_zh
            ORDER BY d.category
            """)
        category_options = [
            {
                "code": r["code"],
                "name_en": r["name_en"] or r["code"],
                "name_zh": r["name_zh"] or "",
                "child_count": int(r["child_count"]),
            }
            for r in category_rows
        ]
        return {
            "type": "search" if query else "browse",
            "table": table,
            "query": query,
            "category": category if table == "cm" else "",
            "code_prefix": code_prefix,
            "code_from": code_from,
            "code_to": code_to,
            "zh_filter": zh_filter,
            "sort": sort_col,
            "direction": direction,
            "rows": result_rows,
            "results": result_rows,
            "total": total,
            "page": page,
            "per_page": per_page,
            "total_cm": total_cm,
            "total_pcs": total_pcs,
            "category_options": category_options,
        }


# ---------------------------------------------------------------------------
# LOINC  (paginated table with class/status filters)
# ---------------------------------------------------------------------------


async def preview_loinc(
    pool: PoolLike,
    *,
    page: int = 1,
    q: str = "",
    class_: str = "",
    status: str = "ACTIVE",
    code_prefix: str = "",
    code_from: str = "",
    code_to: str = "",
    component: str = "",
    system: str = "",
    property_: str = "",
    scale_type: str = "",
    method_type: str = "",
    specimen_type: str = "",
    unit: str = "",
    zh_filter: str = "all",
    reference_filter: str = "all",
    sort: str = "loinc_num",
    direction: str = "asc",
    per_page: int = _LOINC_PAGE_SIZE,
) -> dict[str, Any]:
    """LOINC preview — paginated table with optional free-text and class filter."""
    async with pool.acquire() as conn:
        total_rows = int(
            await conn.fetchval("SELECT COUNT(*) FROM loinc.concepts") or 0
        )
        if total_rows == 0:
            return {
                "type": "empty",
                "message": "LOINC module not loaded. Run the import first.",
                "total": 0,
            }

        page = max(1, int(page or 1))
        per_page = max(1, min(int(per_page or _LOINC_PAGE_SIZE), 100))
        code_prefix = (code_prefix or "").strip().upper()
        code_from = (code_from or "").strip().upper()
        code_to = (code_to or "").strip().upper()
        component = (component or "").strip()
        system = (system or "").strip()
        property_ = (property_ or "").strip()
        scale_type = (scale_type or "").strip()
        method_type = (method_type or "").strip()
        specimen_type = (specimen_type or "").strip()
        unit = (unit or "").strip()
        zh_filter = (
            zh_filter if zh_filter in {"all", "with_zh", "missing_zh"} else "all"
        )
        reference_filter = (
            reference_filter
            if reference_filter in {"all", "with_reference", "missing_reference"}
            else "all"
        )
        direction = "desc" if direction == "desc" else "asc"
        sort_map = {
            "loinc_num": "c.loinc_num",
            "long_common_name": "c.long_common_name",
            "shortname": "c.shortname",
            "class": "c.class",
            "status": "c.status",
            "name_zh": "c.name_zh",
            "component": "c.component",
            "system": "c.system",
            "property": "c.property",
            "scale_type": "c.scale_type",
            "method_type": "c.method_type",
            "specimen_type": "c.specimen_type",
            "unit": "c.unit",
        }
        sort_col = sort_map.get(sort, "c.loinc_num")

        # Build WHERE
        conditions: list[str] = []
        params: list[Any] = []
        idx = 1

        if status and status != "ALL":
            conditions.append(f"c.status = ${idx}")
            params.append(status)
            idx += 1

        if class_ and class_ != "ALL":
            conditions.append(f"c.class = ${idx}")
            params.append(class_)
            idx += 1

        if q and q.strip():
            term = "%" + q.strip() + "%"
            conditions.append(
                f"(c.loinc_num ILIKE ${idx} OR c.long_common_name ILIKE ${idx} "
                f"OR c.shortname ILIKE ${idx} OR c.name_zh ILIKE ${idx} "
                f"OR c.common_name_zh ILIKE ${idx} OR c.component ILIKE ${idx} "
                f"OR c.system ILIKE ${idx} OR c.specimen_type ILIKE ${idx})"
            )
            params.append(term)
            idx += 1

        if code_prefix:
            conditions.append(f"c.loinc_num ILIKE ${idx}")
            params.append(f"{code_prefix}%")
            idx += 1
        if code_from:
            conditions.append(f"c.loinc_num >= ${idx}")
            params.append(code_from)
            idx += 1
        if code_to:
            conditions.append(f"c.loinc_num <= ${idx}")
            params.append(code_to)
            idx += 1
        for col, value in (
            ("component", component),
            ("system", system),
            ("property", property_),
            ("scale_type", scale_type),
            ("method_type", method_type),
            ("specimen_type", specimen_type),
            ("unit", unit),
        ):
            if value:
                conditions.append(f"c.{col} ILIKE ${idx}")
                params.append(f"%{value}%")
                idx += 1
        if zh_filter == "with_zh":
            conditions.append(
                "(NULLIF(BTRIM(c.name_zh), '') IS NOT NULL OR NULLIF(BTRIM(c.common_name_zh), '') IS NOT NULL)"
            )
        elif zh_filter == "missing_zh":
            conditions.append(
                "NULLIF(BTRIM(c.name_zh), '') IS NULL AND NULLIF(BTRIM(c.common_name_zh), '') IS NULL"
            )
        if reference_filter == "with_reference":
            conditions.append(
                "EXISTS (SELECT 1 FROM loinc.reference_ranges rr WHERE rr.loinc_num = c.loinc_num)"
            )
        elif reference_filter == "missing_reference":
            conditions.append(
                "NOT EXISTS (SELECT 1 FROM loinc.reference_ranges rr WHERE rr.loinc_num = c.loinc_num)"
            )

        where = ("WHERE " + " AND ".join(conditions)) if conditions else ""

        count_sql = f"SELECT COUNT(*) FROM loinc.concepts c {where}"
        total_filtered = int(await conn.fetchval(count_sql, *params) or 0)

        offset = (page - 1) * per_page
        rows = await conn.fetch(
            f"""
            SELECT
                c.loinc_num,
                c.long_common_name,
                c.shortname,
                c.class,
                c.status,
                c.name_zh,
                c.common_name_zh,
                c.classtype,
                c.component,
                c.property,
                c.time_aspect,
                c.system,
                c.scale_type,
                c.method_type,
                c.specimen_type,
                c.unit,
                c.consumer_name,
                EXISTS (
                    SELECT 1 FROM loinc.reference_ranges rr
                    WHERE rr.loinc_num = c.loinc_num
                ) AS has_reference_range
            FROM loinc.concepts c
            {where}
            ORDER BY {sort_col} {direction.upper()} NULLS LAST, c.loinc_num ASC
            LIMIT ${ idx } OFFSET ${ idx + 1 }
            """,
            *params,
            per_page,
            offset,
        )

        class_rows = await conn.fetch(
            "SELECT DISTINCT class FROM loinc.concepts WHERE class IS NOT NULL ORDER BY class"
        )
        system_rows = await conn.fetch(
            "SELECT DISTINCT system FROM loinc.concepts WHERE NULLIF(BTRIM(system), '') IS NOT NULL ORDER BY system LIMIT 300"
        )
        property_rows = await conn.fetch(
            "SELECT DISTINCT property FROM loinc.concepts WHERE NULLIF(BTRIM(property), '') IS NOT NULL ORDER BY property LIMIT 300"
        )
        scale_rows = await conn.fetch(
            "SELECT DISTINCT scale_type FROM loinc.concepts WHERE NULLIF(BTRIM(scale_type), '') IS NOT NULL ORDER BY scale_type LIMIT 300"
        )

        return {
            "type": "table",
            "total": total_filtered,
            "total_all": total_rows,
            "page": page,
            "per_page": per_page,
            "pages": max(1, (total_filtered + per_page - 1) // per_page),
            "classes": [r["class"] for r in class_rows],
            "status": status,
            "class": class_,
            "query": q.strip(),
            "code_prefix": code_prefix,
            "code_from": code_from,
            "code_to": code_to,
            "component": component,
            "system": system,
            "property": property_,
            "scale_type": scale_type,
            "method_type": method_type,
            "specimen_type": specimen_type,
            "unit": unit,
            "zh_filter": zh_filter,
            "reference_filter": reference_filter,
            "sort": sort_col.replace("c.", ""),
            "direction": direction,
            "systems": [r["system"] for r in system_rows],
            "properties": [r["property"] for r in property_rows],
            "scale_types": [r["scale_type"] for r in scale_rows],
            "rows": [
                {
                    "loinc_num": r["loinc_num"],
                    "long_common_name": r["long_common_name"] or "",
                    "shortname": r["shortname"] or "",
                    "class": r["class"] or "",
                    "status": r["status"] or "",
                    "name_zh": r["name_zh"] or "",
                    "common_name_zh": r["common_name_zh"] or "",
                    "component": r["component"] or "",
                    "property": r["property"] or "",
                    "time_aspect": r["time_aspect"] or "",
                    "system": r["system"] or "",
                    "scale_type": r["scale_type"] or "",
                    "method_type": r["method_type"] or "",
                    "specimen_type": r["specimen_type"] or "",
                    "unit": r["unit"] or "",
                    "consumer_name": r["consumer_name"] or "",
                    "classtype": r["classtype"],
                    "has_reference_range": bool(r["has_reference_range"]),
                }
                for r in rows
            ],
        }


# ---------------------------------------------------------------------------
# SNOMED CT  (top-level concepts + child tree + search)
# ---------------------------------------------------------------------------


async def preview_snomed(
    pool: PoolLike,
    *,
    node: str | None = None,
    q: str | None = None,
    semantic_tag: str = "",
    active: str = "active",
    language_code: str = "",
    map_filter: str = "all",
    sort: str = "concept_id",
    direction: str = "asc",
    page: int = 1,
    per_page: int = _SNOMED_PAGE_SIZE,
) -> dict[str, Any]:
    """SNOMED CT preview.

    Modes
    -----
    ``?node=root``            : direct children of 138875005 (top hierarchies)
    ``?node={concept_id}``    : direct IS-A children of that concept
    ``?q={text}``             : FSN description search
    """
    async with pool.acquire() as conn:
        total = int(
            await conn.fetchval(
                "SELECT COUNT(*) FROM snomed.concepts WHERE active=TRUE"
            )
            or 0
        )
        if total == 0:
            return {
                "type": "empty",
                "message": "SNOMED CT module not loaded. Run the import first.",
                "total": 0,
            }

        query = (q or "").strip()
        semantic_tag = (semantic_tag or "").strip()
        active = active if active in {"all", "active", "inactive"} else "active"
        language_code = (language_code or "").strip()
        map_filter = (
            map_filter if map_filter in {"all", "with_map", "missing_map"} else "all"
        )
        direction = "desc" if direction == "desc" else "asc"
        page = max(1, int(page or 1))
        per_page = max(1, min(int(per_page or _SNOMED_PAGE_SIZE), 100))
        offset = (page - 1) * per_page

        # ── Tree: root (direct children of the SNOMED root) ───────────────
        if node == "root":
            rows = await conn.fetch(
                """
                SELECT DISTINCT
                    r.source_id                                     AS concept_id,
                    d.term                                          AS fsn_term,
                    (SELECT COUNT(*)
                     FROM snomed.relationships r2
                     WHERE r2.destination_id = r.source_id
                       AND r2.type_id = $1
                       AND r2.active = TRUE)                        AS child_count
                FROM snomed.relationships r
                JOIN snomed.descriptions d
                    ON d.concept_id = r.source_id
                    AND d.type_id = $2
                    AND d.active = TRUE
                JOIN snomed.concepts c
                    ON c.concept_id = r.source_id AND c.active = TRUE
                WHERE r.type_id = $1
                  AND r.active = TRUE
                  AND r.destination_id = $3
                ORDER BY d.term
                """,
                _SNOMED_ISA_TYPE_ID,
                _SNOMED_FSN_TYPE_ID,
                _SNOMED_ROOT_CONCEPT,
            )
            return {
                "type": "tree_root",
                "total_active_concepts": total,
                "nodes": [
                    {
                        "concept_id": str(r["concept_id"]),
                        "fsn_term": r["fsn_term"],
                        "child_count": int(r["child_count"]),
                    }
                    for r in rows
                ],
            }

        # ── Tree: children of a specific concept ───────────────────────────
        if node:
            try:
                parent_id = int(node)
            except (ValueError, TypeError):
                return {"type": "error", "message": f"Invalid concept_id: {node!r}"}
        else:
            parent_id = None

        if parent_id is not None:
            # Get parent's FSN term
            parent_name_row = await conn.fetchrow(
                """
                SELECT term FROM snomed.descriptions
                WHERE concept_id = $1 AND type_id = $2 AND active = TRUE
                LIMIT 1
                """,
                parent_id,
                _SNOMED_FSN_TYPE_ID,
            )
            parent_term = parent_name_row["term"] if parent_name_row else str(parent_id)

            rows = await conn.fetch(
                """
                SELECT DISTINCT
                    r.source_id                                     AS concept_id,
                    d.term                                          AS fsn_term,
                    (SELECT COUNT(*)
                     FROM snomed.relationships r2
                     WHERE r2.destination_id = r.source_id
                       AND r2.type_id = $1
                       AND r2.active = TRUE)                        AS child_count
                FROM snomed.relationships r
                JOIN snomed.descriptions d
                    ON d.concept_id = r.source_id
                    AND d.type_id = $2
                    AND d.active = TRUE
                JOIN snomed.concepts c ON c.concept_id = r.source_id AND c.active = TRUE
                WHERE r.type_id = $1
                  AND r.active = TRUE
                  AND r.destination_id = $3
                ORDER BY d.term
                LIMIT 150
                """,
                _SNOMED_ISA_TYPE_ID,
                _SNOMED_FSN_TYPE_ID,
                parent_id,
            )
            return {
                "type": "tree_children",
                "parent_id": str(parent_id),
                "parent_term": parent_term,
                "nodes": [
                    {
                        "concept_id": str(r["concept_id"]),
                        "fsn_term": r["fsn_term"],
                        "child_count": int(r["child_count"]),
                    }
                    for r in rows
                ],
            }

        # ── Paginated browse/search/filter mode ───────────────────────────
        conditions: list[str] = ["fsn.type_id = $1", "fsn.active = TRUE"]
        params: list[Any] = [_SNOMED_FSN_TYPE_ID]
        idx = 2

        if active == "active":
            conditions.append("c.active = TRUE")
        elif active == "inactive":
            conditions.append("c.active = FALSE")

        if query:
            conditions.append(
                f"(c.concept_id::text ILIKE ${idx} OR fsn.term ILIKE ${idx} OR pref.term ILIKE ${idx})"
            )
            params.append(f"%{query}%")
            idx += 1
        if semantic_tag:
            conditions.append(
                f"LOWER(COALESCE(substring(fsn.term from '\\\\(([^()]*)\\\\)$'), '')) = LOWER(${idx})"
            )
            params.append(semantic_tag)
            idx += 1
        if language_code:
            conditions.append(f"fsn.language_code = ${idx}")
            params.append(language_code)
            idx += 1
        if map_filter == "with_map":
            conditions.append(
                "EXISTS (SELECT 1 FROM snomed.icd10_map m WHERE m.referenced_component_id = c.concept_id AND m.active = TRUE)"
            )
        elif map_filter == "missing_map":
            conditions.append(
                "NOT EXISTS (SELECT 1 FROM snomed.icd10_map m WHERE m.referenced_component_id = c.concept_id AND m.active = TRUE)"
            )

        sort_map = {
            "concept_id": "c.concept_id",
            "fsn_term": "fsn.term",
            "preferred_term": "pref.term",
            "semantic_tag": "semantic_tag",
            "effective_time": "c.effective_time",
            "child_count": "child_count",
            "icd10_map_count": "icd10_map_count",
        }
        sort_col = sort_map.get(sort, "c.concept_id")
        where = "WHERE " + " AND ".join(conditions)
        from_sql = f"""
            FROM snomed.concepts c
            JOIN snomed.descriptions fsn
              ON fsn.concept_id = c.concept_id
            LEFT JOIN LATERAL (
                SELECT term
                FROM snomed.descriptions s
                WHERE s.concept_id = c.concept_id
                  AND s.type_id = {_SNOMED_SYNONYM_TYPE_ID}
                  AND s.active = TRUE
                ORDER BY LENGTH(s.term), s.term
                LIMIT 1
            ) pref ON TRUE
            {where}
        """
        total_filtered = int(
            await conn.fetchval(f"SELECT COUNT(*) {from_sql}", *params) or 0
        )
        rows = await conn.fetch(
            f"""
            SELECT
                c.concept_id,
                c.effective_time,
                c.active,
                c.module_id,
                c.definition_status_id,
                fsn.term AS fsn_term,
                fsn.language_code,
                COALESCE(pref.term, '') AS preferred_term,
                COALESCE(substring(fsn.term from '\\(([^()]*)\\)$'), '') AS semantic_tag,
                (
                    SELECT COUNT(*)
                    FROM snomed.relationships r
                    WHERE r.destination_id = c.concept_id
                      AND r.type_id = {_SNOMED_ISA_TYPE_ID}
                      AND r.active = TRUE
                ) AS child_count,
                (
                    SELECT COUNT(*)
                    FROM snomed.icd10_map m
                    WHERE m.referenced_component_id = c.concept_id
                      AND m.active = TRUE
                ) AS icd10_map_count
            {from_sql}
            ORDER BY {sort_col} {direction.upper()} NULLS LAST, c.concept_id ASC
            LIMIT ${idx} OFFSET ${idx + 1}
            """,
            *params,
            per_page,
            offset,
        )
        tag_rows = await conn.fetch(
            """
            SELECT tag
            FROM (
                SELECT DISTINCT substring(term from '\\(([^()]*)\\)$') AS tag
                FROM snomed.descriptions
                WHERE active = TRUE AND type_id = $1
            ) t
            WHERE NULLIF(BTRIM(tag), '') IS NOT NULL
            ORDER BY tag
            LIMIT 300
            """,
            _SNOMED_FSN_TYPE_ID,
        )
        lang_rows = await conn.fetch("""
            SELECT DISTINCT language_code
            FROM snomed.descriptions
            WHERE NULLIF(BTRIM(language_code), '') IS NOT NULL
            ORDER BY language_code
            """)
        result_rows = [
            {
                "concept_id": str(r["concept_id"]),
                "preferred_term": r["preferred_term"] or "",
                "fsn_term": r["fsn_term"] or "",
                "semantic_tag": r["semantic_tag"] or "",
                "active": bool(r["active"]),
                "language_code": r["language_code"] or "",
                "effective_time": _iso(r["effective_time"]) or "",
                "module_id": str(r["module_id"] or ""),
                "definition_status_id": str(r["definition_status_id"] or ""),
                "child_count": int(r["child_count"] or 0),
                "icd10_map_count": int(r["icd10_map_count"] or 0),
            }
            for r in rows
        ]
        return {
            "type": "table",
            "total": total_filtered,
            "total_all": total,
            "page": page,
            "per_page": per_page,
            "pages": max(1, (total_filtered + per_page - 1) // per_page),
            "query": query,
            "semantic_tag": semantic_tag,
            "active": active,
            "language_code": language_code,
            "map_filter": map_filter,
            "sort": sort,
            "direction": direction,
            "semantic_tags": [r["tag"] for r in tag_rows],
            "language_codes": [r["language_code"] for r in lang_rows],
            "rows": result_rows,
            "results": result_rows,
        }


# ---------------------------------------------------------------------------
# TWCore IG  (FHIR IG tree: package groups → artifacts → resource detail)
# ---------------------------------------------------------------------------


async def preview_ig(
    pool: PoolLike,
    *,
    mode: str = "",
    node: str | None = None,
    artifact_key: str = "",
    value_set_url: str = "",
    field_q: str = "",
    cs_id: str | None = None,
    q: str | None = None,
    resource_type: str = "",
    grouping_id: str = "",
    base_type: str = "",
    element_source: str = "differential",
    sort: str = "title",
    direction: str = "asc",
    page: int = 1,
    per_page: int = 50,
) -> dict[str, Any]:
    """TWCore IG preview.

    ``mode=navigator``               → package-level IG groups
    ``mode=search&q={text}``         → artifact + StructureDefinition field search
    ``mode=artifact_tree``           → full artifact detail and element tree
    ``node=root``                    → package-level IG groups (legacy)
    ``node=group:{grouping_id}``     → artifacts in one IG group (legacy)
    ``node=artifact:{artifact_key}`` → resource metadata/detail (legacy)
    ``q={text}``                     → paginated artifact search (legacy)
    """

    def _json_value(value: Any) -> dict[str, Any]:
        if isinstance(value, dict):
            return value
        if isinstance(value, str) and value:
            try:
                parsed = json.loads(value)
                return parsed if isinstance(parsed, dict) else {}
            except Exception:
                return {}
        return {}

    def _artifact_summary(row: asyncpg.Record) -> dict[str, Any]:
        return {
            "artifact_key": row["artifact_key"],
            "resource_type": row["resource_type"],
            "artifact_id": row["artifact_id"] or "",
            "title": row["title"]
            or row["name"]
            or row["artifact_id"]
            or row["artifact_key"],
            "name": row["name"] or "",
            "status": row["status"] or "",
            "kind": row["kind"] or "",
            "base_type": row["base_type"] or "",
            "derivation": row["derivation"] or "",
            "grouping_id": row["grouping_id"] or "",
            "grouping_name": row["grouping_name"] or "",
            "description": row["description"] or "",
            "package_path": row["package_path"] or "",
            "child_count": int(row["child_count"] or 0),
            "concept_count": int(row["concept_count"] or 0),
        }

    def _strip_canonical_version(url: str) -> str:
        # FHIR canonical references can be version-pinned, e.g.
        # "http://hl7.org/fhir/ValueSet/administrative-gender|4.0.1". The stored
        # canonical_url has no version, so drop the "|<version>" suffix.
        return url.split("|", 1)[0] if url else url

    def _canonical_tail(url: str, resource_type: str) -> str:
        url = _strip_canonical_version(url)
        marker = f"/{resource_type}/"
        if marker in url:
            return url.rsplit(marker, 1)[1]
        return url.rstrip("/").rsplit("/", 1)[-1] if url else ""

    def _min_int(value: Any) -> int:
        try:
            return int(value)
        except (TypeError, ValueError):
            return 0

    def _first_constraint_value(element: dict[str, Any]) -> dict[str, str]:
        for key, value in element.items():
            if key.startswith("fixed") or key.startswith("pattern"):
                return {
                    "kind": key,
                    "value": json.dumps(value, ensure_ascii=False, default=str),
                }
        return {"kind": "", "value": ""}

    def _element_type_summary(element: dict[str, Any]) -> str:
        parts: list[str] = []
        for item in element.get("type") or []:
            code = str(item.get("code") or "")
            if not code:
                continue
            refs = [
                _canonical_tail(str(ref), "StructureDefinition")
                for ref in (item.get("targetProfile") or item.get("profile") or [])
                if ref
            ]
            parts.append(f"{code}({', '.join(refs)})" if refs else code)
        return ", ".join(parts)

    def _element_row(element: dict[str, Any], index: int) -> dict[str, Any]:
        binding = element.get("binding") or {}
        min_value = _min_int(element.get("min"))
        max_value = str(element.get("max") or "")
        fixed = _first_constraint_value(element)
        path = str(element.get("path") or "")
        element_id = str(element.get("id") or path or f"element-{index}")
        return {
            "id": element_id,
            "element_id": element_id,
            "path": path,
            "slice_name": str(element.get("sliceName") or ""),
            "label": path.rsplit(".", 1)[-1] if path else element_id,
            "depth": max(0, path.count(".")),
            "min": min_value,
            "max": max_value,
            "cardinality": f"{min_value}..{max_value}",
            "required": min_value >= 1 and max_value != "0",
            "optional": min_value == 0 and max_value != "0",
            "prohibited": max_value == "0",
            "must_support": bool(element.get("mustSupport") or False),
            "is_modifier": bool(element.get("isModifier") or False),
            "type": _element_type_summary(element),
            "binding": str(binding.get("valueSet") or ""),
            "binding_strength": str(binding.get("strength") or ""),
            "binding_description": str(binding.get("description") or ""),
            "short": str(element.get("short") or ""),
            "definition": str(element.get("definition") or ""),
            "comment": str(element.get("comment") or ""),
            "requirements": str(element.get("requirements") or ""),
            "fixed_kind": fixed["kind"],
            "fixed_value": fixed["value"],
            "constraints": [
                {
                    "key": str(item.get("key") or ""),
                    "severity": str(item.get("severity") or ""),
                    "human": str(item.get("human") or ""),
                    "expression": str(item.get("expression") or ""),
                }
                for item in element.get("constraint") or []
            ],
            "children": [],
        }

    def _structure_element_rows(data: dict[str, Any]) -> list[dict[str, Any]]:
        snapshot = (data.get("snapshot") or {}).get("element") or []
        differential = (data.get("differential") or {}).get("element") or []
        # Honour the caller's preferred source, falling back to the other when
        # the preferred one is absent (some profiles ship only one).
        if element_source == "snapshot":
            raw_elements, source = (
                (snapshot, "snapshot") if snapshot else (differential, "differential")
            )
        else:
            raw_elements, source = (
                (differential, "differential")
                if differential
                else (snapshot, "snapshot")
            )
        rows = [_element_row(element, i) for i, element in enumerate(raw_elements)]
        for row in rows:
            row["source"] = source
        return rows

    def _element_tree(elements: list[dict[str, Any]]) -> list[dict[str, Any]]:
        roots: list[dict[str, Any]] = []
        stack: list[dict[str, Any]] = []
        for item in elements:
            node_item = {**item, "children": []}
            depth = max(0, int(node_item.get("depth") or 0))
            if depth == 0 or not stack:
                roots.append(node_item)
                stack = [node_item]
                continue
            stack = stack[:depth]
            if not stack:
                roots.append(node_item)
                stack = [node_item]
                continue
            stack[-1].setdefault("children", []).append(node_item)
            stack.append(node_item)
        return roots

    def _element_matches(row: dict[str, Any], term: str) -> bool:
        if not term:
            return False
        haystack = " ".join(
            str(row.get(key) or "")
            for key in (
                "id",
                "path",
                "slice_name",
                "label",
                "type",
                "binding",
                "binding_strength",
                "binding_description",
                "short",
                "definition",
                "comment",
                "requirements",
            )
        ).lower()
        return term.lower() in haystack

    def _artifact_stats(elements: list[dict[str, Any]]) -> dict[str, int]:
        return {
            "elements": len(elements),
            "required": sum(1 for row in elements if row.get("required")),
            "must_support": sum(1 for row in elements if row.get("must_support")),
            "bindings": sum(1 for row in elements if row.get("binding")),
            "prohibited": sum(1 for row in elements if row.get("prohibited")),
        }

    def _profile_resource_name(row: asyncpg.Record) -> str:
        data = _json_value(row["raw_json"])
        raw_type = str(data.get("type") or row["base_type"] or "")
        if raw_type.startswith("http://") or raw_type.startswith("https://"):
            raw_type = _canonical_tail(raw_type, "StructureDefinition")
        return raw_type or row["base_type"] or "Other"

    def _resource_detail(data: dict[str, Any], resource_type: str) -> dict[str, Any]:
        if resource_type == "StructureDefinition":
            elements = _structure_element_rows(data)
            return {
                "url": data.get("url") or "",
                "version": data.get("version") or "",
                "base_definition": data.get("baseDefinition") or "",
                "type": data.get("type") or "",
                "kind": data.get("kind") or "",
                "derivation": data.get("derivation") or "",
                "elements": elements,
                "element_total": len(elements),
                "stats": _artifact_stats(elements),
            }
        if resource_type == "ValueSet":
            compose = data.get("compose") or {}
            return {
                "url": data.get("url") or "",
                "version": data.get("version") or "",
                "include": compose.get("include") or [],
                "exclude": compose.get("exclude") or [],
                "expansion_total": (data.get("expansion") or {}).get("total"),
            }
        if resource_type == "SearchParameter":
            return {
                "base": data.get("base") or [],
                "type": data.get("type") or "",
                "code": data.get("code") or "",
                "expression": data.get("expression") or "",
                "xpath": data.get("xpath") or "",
            }
        if resource_type == "ConceptMap":
            return {
                "source": data.get("sourceUri") or data.get("sourceCanonical") or "",
                "target": data.get("targetUri") or data.get("targetCanonical") or "",
                "group": data.get("group") or [],
            }
        if resource_type in {"CapabilityStatement", "OperationDefinition"}:
            return {
                "url": data.get("url") or "",
                "version": data.get("version") or "",
                "kind": data.get("kind") or "",
                "fhir_version": data.get("fhirVersion") or "",
                "rest": data.get("rest") or [],
                "parameter": data.get("parameter") or [],
            }
        return {
            "resource_type": resource_type,
            "id": data.get("id") or "",
            "url": data.get("url") or "",
            "meta": data.get("meta") or {},
        }

    def _property_value(prop: dict[str, Any]) -> str:
        for key, value in prop.items():
            if key.startswith("value") and value is not None:
                return str(value)
        return ""

    def _concept_property_map(concept: dict[str, Any]) -> dict[str, str]:
        result: dict[str, str] = {}
        for prop in concept.get("property") or []:
            code = str(prop.get("code") or "")
            if code:
                result[code] = _property_value(prop)
        return result

    def _concept_properties(concept: dict[str, Any]) -> str:
        properties = _concept_property_map(concept)
        return "; ".join(f"{key}={value}" for key, value in properties.items() if value)

    def _concept_designations(concept: dict[str, Any]) -> str:
        values = []
        for item in concept.get("designation") or []:
            value = str(item.get("value") or "")
            if not value:
                continue
            language = str(item.get("language") or "").strip()
            values.append(f"{language}: {value}" if language else value)
        return "; ".join(values)

    def _concept_matches_filters(
        concept: dict[str, Any], filters: list[dict[str, Any]]
    ) -> bool:
        if not filters:
            return True
        properties = _concept_property_map(concept)
        for filter_item in filters:
            prop = str(filter_item.get("property") or "")
            op = str(filter_item.get("op") or "")
            expected = str(filter_item.get("value") or "")
            actual = properties.get(prop, "")
            if op == "=" and actual != expected:
                return False
            if op == "!=" and actual == expected:
                return False
            if op not in {"=", "!="}:
                return False
        return True

    async def _load_codesystem_raw(
        conn: asyncpg.Connection,
        system: str,
    ) -> tuple[str, dict[str, Any]] | None:
        cs_id = _canonical_tail(system, "CodeSystem")
        row = await conn.fetchrow(
            """
            SELECT artifact_id, raw_json
            FROM fhir.artifacts
            WHERE resource_type = 'CodeSystem'
              AND (canonical_url = $1 OR artifact_id = $2)
            LIMIT 1
            """,
            _strip_canonical_version(system),
            cs_id,
        )
        if not row:
            return None
        data = _json_value(row["raw_json"])
        return row["artifact_id"] or cs_id, data

    async def _load_valueset_raw(
        conn: asyncpg.Connection,
        value_set_url: str,
    ) -> tuple[str, dict[str, Any]] | None:
        vs_id = _canonical_tail(value_set_url, "ValueSet")
        row = await conn.fetchrow(
            """
            SELECT artifact_id, raw_json
            FROM fhir.artifacts
            WHERE resource_type = 'ValueSet'
              AND (canonical_url = $1 OR artifact_id = $2)
            LIMIT 1
            """,
            _strip_canonical_version(value_set_url),
            vs_id,
        )
        if not row:
            return None
        return row["artifact_id"] or vs_id, _json_value(row["raw_json"])

    async def _external_display_map(
        conn: asyncpg.Connection,
        system: str,
        codes: list[str],
    ) -> dict[str, str]:
        if not codes:
            return {}
        try:
            if system == "http://snomed.info/sct":
                numeric_codes = [int(code) for code in codes if code.isdigit()]
                if not numeric_codes:
                    return {}
                rows = await conn.fetch(
                    """
                    SELECT DISTINCT ON (concept_id)
                           concept_id::text AS code, term
                    FROM snomed.descriptions
                    WHERE concept_id = ANY($1::bigint[])
                      AND active
                    ORDER BY concept_id,
                             CASE
                                 WHEN type_id = 900000000000013009 AND us_preferred THEN 0
                                 WHEN type_id = 900000000000013009 THEN 1
                                 ELSE 2
                             END,
                             language_code
                    """,
                    numeric_codes,
                )
                return {r["code"]: r["term"] or "" for r in rows}
            if system == "http://loinc.org":
                rows = await conn.fetch(
                    """
                    SELECT loinc_num AS code,
                           COALESCE(NULLIF(common_name_zh, ''), NULLIF(name_zh, ''),
                                    NULLIF(long_common_name, ''), NULLIF(shortname, ''),
                                    component) AS display
                    FROM loinc.concepts
                    WHERE loinc_num = ANY($1::text[])
                    """,
                    codes,
                )
                return {r["code"]: r["display"] or "" for r in rows}
            if system == "http://www.nlm.nih.gov/research/umls/rxnorm":
                numeric_codes = [int(code) for code in codes if code.isdigit()]
                if not numeric_codes:
                    return {}
                rows = await conn.fetch(
                    """
                    SELECT rxcui::text AS code, name
                    FROM rxnorm.concepts
                    WHERE rxcui = ANY($1::bigint[])
                    """,
                    numeric_codes,
                )
                return {r["code"]: r["name"] or "" for r in rows}
        except Exception:
            return {}
        return {}

    async def _valueset_allowed_rows(
        conn: asyncpg.Connection,
        data: dict[str, Any],
        *,
        visited: set[str] | None = None,
    ) -> list[dict[str, Any]]:
        visited = set(visited or set())
        value_set_id = str(data.get("id") or data.get("url") or "")
        if value_set_id in visited:
            return []
        visited.add(value_set_id)

        rows: list[dict[str, Any]] = []

        def add_row(
            *,
            row_type: str,
            system: str = "",
            code: str = "",
            display: str = "",
            definition: str = "",
            meaning: str = "",
            properties: str = "",
            source: str = "",
        ) -> None:
            rows.append(
                {
                    "row_type": row_type,
                    "system": system,
                    "code": code,
                    "display": display,
                    "definition": definition,
                    "meaning": meaning or definition or display,
                    "properties": properties,
                    "source": source,
                }
            )

        async def add_concepts_from_codesystem(
            *,
            system: str,
            cs_data: dict[str, Any],
            filters: list[dict[str, Any]] | None = None,
            source: str,
        ) -> None:
            for concept in cs_data.get("concept") or []:
                if not _concept_matches_filters(concept, filters or []):
                    continue
                add_row(
                    row_type="filtered concept" if filters else "concept",
                    system=system,
                    code=str(concept.get("code") or ""),
                    display=str(concept.get("display") or ""),
                    definition=str(concept.get("definition") or ""),
                    meaning=_concept_designations(concept),
                    properties=_concept_properties(concept),
                    source=source,
                )

        async def _snomed_descendants(
            root: int, include_self: bool, limit: int
        ) -> list:
            """Recursive IS-A descendants of *root* with a display term each."""
            return await conn.fetch(
                """
                WITH RECURSIVE descendants AS (
                    SELECT $1::bigint AS concept_id
                    UNION
                    SELECT r.source_id
                    FROM snomed.relationships r
                    JOIN descendants d ON r.destination_id = d.concept_id
                    WHERE r.type_id = 116680003 AND r.active = TRUE
                )
                SELECT d.concept_id::text AS code, ds.term AS display
                FROM descendants d
                JOIN LATERAL (
                    SELECT term FROM snomed.descriptions s
                    WHERE s.concept_id = d.concept_id AND s.active = TRUE
                    ORDER BY CASE
                                 WHEN s.type_id = 900000000000013009 AND s.us_preferred THEN 0
                                 WHEN s.type_id = 900000000000013009 THEN 1
                                 ELSE 2
                             END,
                             LENGTH(s.term)
                    LIMIT 1
                ) ds ON TRUE
                WHERE $2::boolean OR d.concept_id <> $1::bigint
                ORDER BY ds.term
                LIMIT $3
                """,
                root,
                include_self,
                limit,
            )

        async def _resolve_retired_anchor(root: int) -> tuple[list[int], str]:
            """If *root* was retired, return its best-tier successor concept ids
            (and the association label). Empty list if no usable association."""
            try:
                assoc = await conn.fetch(
                    """
                    SELECT target_component_id, refset_id
                    FROM snomed.historical_associations
                    WHERE referenced_component_id = $1
                    """,
                    root,
                )
            except Exception:
                return [], ""
            tiers = [
                (
                    _SNOMED_HIST_ASSOC[a["refset_id"]][0],
                    a["refset_id"],
                    a["target_component_id"],
                )
                for a in assoc
                if a["refset_id"] in _SNOMED_HIST_ASSOC
            ]
            if not tiers:
                return [], ""
            best_rank = min(t[0] for t in tiers)
            best_refset = next(t[1] for t in tiers if t[0] == best_rank)
            targets = list(dict.fromkeys(t[2] for t in tiers if t[1] == best_refset))
            return targets, _SNOMED_HIST_ASSOC[best_refset][1]

        async def add_snomed_filter_concepts(
            *, root_code: str, op: str, cap: int = 500
        ) -> int:
            """Expand a SNOMED ``is-a`` / ``descendent-of`` filter from the locally
            loaded SNOMED hierarchy. If the anchor concept was retired in this
            edition, resolve it to its successor(s) via historical associations
            and expand from there. Returns the number of concept rows added."""
            if not root_code.isdigit():
                return 0
            include_self = op == "is-a"
            root = int(root_code)
            try:
                fetched = await _snomed_descendants(root, include_self, cap + 1)
            except Exception:
                return 0

            substitution = ""
            if not fetched:
                # Anchor absent/retired locally → follow historical associations.
                targets, label = await _resolve_retired_anchor(root)
                if targets:
                    seen: set[str] = set()
                    merged: list = []
                    for target in targets:
                        try:
                            rows_t = await _snomed_descendants(
                                target, include_self, cap + 1
                            )
                        except Exception:
                            rows_t = []
                        for r in rows_t:
                            if r["code"] in seen:
                                continue
                            seen.add(r["code"])
                            merged.append(r)
                        if len(merged) > cap:
                            break
                    if merged:
                        fetched = merged[: cap + 1]
                        substitution = (
                            f"Anchor concept {root} is retired in the loaded SNOMED "
                            f"edition; expanded from its {label} successor(s): "
                            f"{', '.join(str(t) for t in targets)}."
                        )

            truncated = len(fetched) > cap
            if substitution:
                add_row(
                    row_type="filter rule",
                    system="http://snomed.info/sct",
                    display=substitution,
                    meaning=substitution,
                    source="snomed.history",
                )
            for r in fetched[:cap]:
                add_row(
                    row_type="concept",
                    system="http://snomed.info/sct",
                    code=r["code"],
                    display=r["display"] or "",
                    meaning=r["display"] or "",
                    source="snomed.filter",
                )
            if truncated:
                add_row(
                    row_type="filter rule",
                    system="http://snomed.info/sct",
                    display=f"Showing first {cap}; full set ({op} {root_code}) is larger.",
                    meaning="Truncated — expand in a SNOMED terminology server for the complete set.",
                    source="compose.include.filter",
                )
            return len(fetched[:cap])

        async def add_loinc_filter_concepts(
            *, prop: str, value: str, cap: int = 500
        ) -> int:
            """Expand a LOINC ``property = value`` filter from the locally loaded
            LOINC table. Returns the number of concept rows added."""
            column = _LOINC_FILTER_COLUMNS.get(prop.upper())
            if not column or not value:
                return 0
            try:
                # `column` is from a fixed whitelist; `value` is parameterised.
                fetched = await conn.fetch(
                    f"""
                    SELECT loinc_num AS code,
                           COALESCE(NULLIF(common_name_zh, ''), NULLIF(name_zh, ''),
                                    NULLIF(long_common_name, ''), NULLIF(shortname, ''),
                                    component) AS display
                    FROM loinc.concepts
                    WHERE CAST({column} AS TEXT) = $1
                    ORDER BY loinc_num
                    LIMIT $2
                    """,
                    value,
                    cap + 1,
                )
            except Exception:
                return 0
            truncated = len(fetched) > cap
            for r in fetched[:cap]:
                add_row(
                    row_type="concept",
                    system="http://loinc.org",
                    code=r["code"],
                    display=r["display"] or "",
                    meaning=r["display"] or "",
                    source="loinc.filter",
                )
            if truncated:
                add_row(
                    row_type="filter rule",
                    system="http://loinc.org",
                    display=f"Showing first {cap}; full set ({prop} = {value}) is larger.",
                    meaning="Truncated — expand in a LOINC terminology server for the complete set.",
                    source="compose.include.filter",
                )
            return len(fetched[:cap])

        async def add_rxnorm_filter_concepts(
            *, prop: str, op: str, value: str, cap: int = 500
        ) -> int:
            """Expand an RxNorm ``TTY = x`` / ``TTY in (x,y,…)`` filter from the
            locally loaded RxNorm table. Returns the number of concept rows added."""
            if prop.upper() != "TTY" or not value:
                return 0
            if op == "in":
                ttys = [v.strip() for v in value.split(",") if v.strip()]
            elif op == "=":
                ttys = [value.strip()]
            else:
                return 0
            if not ttys:
                return 0
            try:
                fetched = await conn.fetch(
                    """
                    SELECT rxcui::text AS code, name AS display
                    FROM rxnorm.concepts
                    WHERE tty = ANY($1::text[])
                    ORDER BY rxcui
                    LIMIT $2
                    """,
                    ttys,
                    cap + 1,
                )
            except Exception:
                return 0
            truncated = len(fetched) > cap
            for r in fetched[:cap]:
                add_row(
                    row_type="concept",
                    system="http://www.nlm.nih.gov/research/umls/rxnorm",
                    code=r["code"],
                    display=r["display"] or "",
                    meaning=r["display"] or "",
                    source="rxnorm.filter",
                )
            if truncated:
                add_row(
                    row_type="filter rule",
                    system="http://www.nlm.nih.gov/research/umls/rxnorm",
                    display=f"Showing first {cap}; full set ({prop} {op} {value}) is larger.",
                    meaning="Truncated — expand in an RxNorm terminology server for the complete set.",
                    source="compose.include.filter",
                )
            return len(fetched[:cap])

        expansion = (data.get("expansion") or {}).get("contains") or []
        for item in expansion:
            add_row(
                row_type="expansion",
                system=str(item.get("system") or ""),
                code=str(item.get("code") or ""),
                display=str(item.get("display") or ""),
                definition=str(item.get("definition") or ""),
                source="expansion.contains",
            )

        for include in (data.get("compose") or {}).get("include") or []:
            system = str(include.get("system") or "")
            filters = include.get("filter") or []
            concepts = include.get("concept") or []
            value_sets = include.get("valueSet") or []
            cs_loaded = await _load_codesystem_raw(conn, system) if system else None
            cs_data = cs_loaded[1] if cs_loaded else {}
            local_concepts = {
                str(concept.get("code") or ""): concept
                for concept in cs_data.get("concept") or []
            }

            for value_set_url in value_sets:
                ref = await _load_valueset_raw(conn, str(value_set_url))
                if ref:
                    ref_id, ref_data = ref
                    nested_rows = await _valueset_allowed_rows(
                        conn,
                        ref_data,
                        visited=visited | {value_set_id},
                    )
                    for nested in nested_rows:
                        nested["source"] = f"ValueSet/{ref_id}"
                    rows.extend(nested_rows)
                else:
                    add_row(
                        row_type="ValueSet reference",
                        code=_canonical_tail(str(value_set_url), "ValueSet"),
                        display=str(value_set_url),
                        meaning="Includes all codes from the referenced ValueSet.",
                        source="compose.include.valueSet",
                    )

            if concepts:
                display_map = await _external_display_map(
                    conn,
                    system,
                    [str(concept.get("code") or "") for concept in concepts],
                )
                for concept in concepts:
                    code = str(concept.get("code") or "")
                    local = local_concepts.get(code, {})
                    display = (
                        str(concept.get("display") or "")
                        or str(local.get("display") or "")
                        or display_map.get(code, "")
                    )
                    definition = str(
                        concept.get("definition") or local.get("definition") or ""
                    )
                    add_row(
                        row_type="explicit concept",
                        system=system,
                        code=code,
                        display=display,
                        definition=definition,
                        meaning=_concept_designations(local) or definition or display,
                        properties=_concept_properties(local),
                        source="compose.include.concept",
                    )
                continue

            if filters:
                if cs_loaded:
                    before = len(rows)
                    await add_concepts_from_codesystem(
                        system=system,
                        cs_data=cs_data,
                        filters=filters,
                        source="compose.include.filter",
                    )
                    if len(rows) > before:
                        continue
                for filter_item in filters:
                    prop = str(filter_item.get("property") or "")
                    op = str(filter_item.get("op") or "")
                    value = str(filter_item.get("value") or "")
                    # Try to expand the filter against a locally loaded terminology
                    # so the user sees real codes instead of just the rule.
                    expanded = 0
                    if (
                        system == "http://snomed.info/sct"
                        and prop == "concept"
                        and op in {"is-a", "descendent-of", "descendant-of"}
                    ):
                        expanded = await add_snomed_filter_concepts(
                            root_code=value, op=op
                        )
                    elif system == "http://loinc.org" and op == "=":
                        expanded = await add_loinc_filter_concepts(
                            prop=prop, value=value
                        )
                    elif (
                        system == "http://www.nlm.nih.gov/research/umls/rxnorm"
                        and op in {"in", "="}
                    ):
                        expanded = await add_rxnorm_filter_concepts(
                            prop=prop, op=op, value=value
                        )
                    if expanded:
                        continue
                    add_row(
                        row_type="filter rule",
                        system=system,
                        code=value,
                        display=f"{prop} {op} {value}".strip(),
                        meaning="The allowed values are produced by expanding this terminology filter.",
                        properties=f"{prop} {op} {value}".strip(),
                        source="compose.include.filter",
                    )
                continue

            if cs_loaded:
                await add_concepts_from_codesystem(
                    system=system,
                    cs_data=cs_data,
                    source="compose.include.system",
                )
            elif system:
                add_row(
                    row_type="system include",
                    system=system,
                    display=f"All codes from {system}",
                    meaning="This ValueSet includes the full external code system. Expansion requires that terminology source.",
                    source="compose.include.system",
                )

        for exclude in (data.get("compose") or {}).get("exclude") or []:
            system = str(exclude.get("system") or "")
            for concept in exclude.get("concept") or []:
                add_row(
                    row_type="excluded concept",
                    system=system,
                    code=str(concept.get("code") or ""),
                    display=str(concept.get("display") or ""),
                    meaning="This code is explicitly excluded from the ValueSet.",
                    source="compose.exclude.concept",
                )

        return rows

    async with pool.acquire() as conn:
        cs_count = int(
            await conn.fetchval("SELECT COUNT(*) FROM fhir.codesystems") or 0
        )
        artifact_count = int(
            await conn.fetchval("SELECT COUNT(*) FROM fhir.artifacts") or 0
        )
        if cs_count == 0 and artifact_count == 0:
            return {
                "type": "empty",
                "message": "TWCore IG module not loaded. Run the import first.",
            }

        page = max(1, int(page or 1))
        per_page = max(1, min(int(per_page or 50), 100))
        offset = (page - 1) * per_page
        direction = "desc" if direction == "desc" else "asc"
        element_source = "snapshot" if element_source == "snapshot" else "differential"
        sort_map = {
            "title": "COALESCE(NULLIF(title, ''), NULLIF(name, ''), artifact_id, artifact_key)",
            "resource_type": "resource_type",
            "base_type": "base_type",
            "child_count": "child_count",
            "status": "status",
        }
        sort_sql = sort_map.get(sort, sort_map["title"])

        group_rows = await conn.fetch("""
            SELECT grouping_id, COALESCE(NULLIF(grouping_name, ''), grouping_id) AS grouping_name,
                   COUNT(*) AS artifact_count,
                   COALESCE(SUM(child_count), 0) AS child_count
            FROM fhir.artifacts
            GROUP BY grouping_id, grouping_name
            ORDER BY
                CASE grouping_id
                  WHEN 'implementation-guide' THEN 0
                  WHEN 'profiles' THEN 1
                  WHEN 'extensions-datatypes' THEN 2
                  WHEN 'terminology' THEN 3
                  WHEN 'conformance' THEN 4
                  WHEN 'search-parameters' THEN 5
                  WHEN 'examples' THEN 6
                  ELSE 9
                END,
                grouping_name
            """)
        type_rows = await conn.fetch("""
            SELECT grouping_id, resource_type,
                   COUNT(*) AS artifact_count,
                   COALESCE(SUM(child_count), 0) AS child_count
            FROM fhir.artifacts
            GROUP BY grouping_id, resource_type
            ORDER BY grouping_id, resource_type
            """)
        children_by_group: dict[str, list[dict[str, Any]]] = {}
        for r in type_rows:
            group_id = r["grouping_id"] or ""
            resource_type_value = r["resource_type"] or ""
            children_by_group.setdefault(group_id, []).append(
                {
                    "node": f"group:{group_id}",
                    "grouping_id": group_id,
                    "resource_type": resource_type_value,
                    "label": resource_type_value,
                    "artifact_count": int(r["artifact_count"] or 0),
                    "child_count": int(r["child_count"] or 0),
                    "is_leaf": False,
                }
            )
        tree_nodes = [
            {
                "node": f"group:{r['grouping_id']}",
                "grouping_id": r["grouping_id"] or "",
                "label": r["grouping_name"] or r["grouping_id"] or "Ungrouped",
                "artifact_count": int(r["artifact_count"] or 0),
                "child_count": int(r["child_count"] or 0),
                "children": children_by_group.get(r["grouping_id"] or "", []),
                "is_leaf": False,
            }
            for r in group_rows
        ]
        resource_types = [
            r["resource_type"]
            for r in await conn.fetch(
                "SELECT DISTINCT resource_type FROM fhir.artifacts ORDER BY resource_type"
            )
        ]
        base_types = [r["base_type"] for r in await conn.fetch("""
                SELECT DISTINCT base_type FROM fhir.artifacts
                WHERE resource_type = 'StructureDefinition'
                  AND grouping_id = 'profiles'
                  AND COALESCE(base_type, '') <> ''
                ORDER BY base_type
                """)]
        profile_rows = await conn.fetch("""
            SELECT *
            FROM fhir.artifacts
            WHERE resource_type = 'StructureDefinition'
              AND grouping_id = 'profiles'
            ORDER BY
                COALESCE(NULLIF(base_type, ''), raw_json->>'type', artifact_id),
                COALESCE(NULLIF(title, ''), NULLIF(name, ''), artifact_id, artifact_key)
            """)
        profile_order = {
            name: i
            for i, name in enumerate(
                [
                    "Patient",
                    "Practitioner",
                    "PractitionerRole",
                    "Organization",
                    "Encounter",
                    "Condition",
                    "Observation",
                    "DiagnosticReport",
                    "Procedure",
                    "Medication",
                    "MedicationRequest",
                    "MedicationStatement",
                    "MedicationDispense",
                    "AllergyIntolerance",
                    "Immunization",
                    "CarePlan",
                    "CareTeam",
                    "Coverage",
                    "Device",
                    "DocumentReference",
                    "Composition",
                    "Bundle",
                    "Location",
                    "Specimen",
                    "ServiceRequest",
                    "Provenance",
                    "RelatedPerson",
                    "QuestionnaireResponse",
                    "ImagingStudy",
                    "Media",
                    "Goal",
                    "MessageHeader",
                ]
            )
        }
        profiles_by_resource: dict[str, dict[str, Any]] = {}
        for profile_row in profile_rows:
            resource_name = _profile_resource_name(profile_row)
            summary = {
                **_artifact_summary(profile_row),
                "node": f"artifact:{profile_row['artifact_key']}",
                "is_leaf": True,
                "profile_resource": resource_name,
            }
            bucket = profiles_by_resource.setdefault(
                resource_name,
                {
                    "node": f"resource:{resource_name}",
                    "resource_name": resource_name,
                    "label": resource_name,
                    "profile_count": 0,
                    "child_count": 0,
                    "profiles": [],
                },
            )
            bucket["profile_count"] += 1
            bucket["child_count"] += int(profile_row["child_count"] or 0)
            bucket["profiles"].append(summary)
        profile_tree = sorted(
            profiles_by_resource.values(),
            key=lambda item: (
                profile_order.get(item["resource_name"], 999),
                item["resource_name"],
            ),
        )
        profile_count = sum(int(item["profile_count"] or 0) for item in profile_tree)

        if artifact_count == 0:
            return {
                "type": "tree_root",
                "message": "TWCore CodeSystems are loaded, but the IG artifact index is missing. Re-import the TWCore package to enable the tree preview.",
                "nodes": [],
                "rows": [],
                "total": 0,
                "page": 1,
                "per_page": per_page,
                "counts": {
                    "codesystems": cs_count,
                    "artifacts": 0,
                    "profiles": 0,
                    "profile_resources": 0,
                },
                "profile_tree": [],
            }

        mode_value = (mode or "").strip().lower()
        query = (q or "").strip()
        selected_group = grouping_id.strip()
        selected_node = node or "root"
        if selected_node.startswith("group:"):
            selected_group = selected_node.split(":", 1)[1]

        async def _fetch_artifact(key: str) -> asyncpg.Record | None:
            return await conn.fetchrow(
                "SELECT * FROM fhir.artifacts WHERE artifact_key = $1",
                key,
            )

        async def _terminology_rows_for_artifact(
            row: asyncpg.Record,
            raw: dict[str, Any],
        ) -> tuple[list[dict[str, Any]], int]:
            if row["resource_type"] == "CodeSystem":
                total_rows = int(
                    await conn.fetchval(
                        "SELECT COUNT(*) FROM fhir.concepts WHERE cs_id = $1",
                        row["artifact_id"],
                    )
                    or 0
                )
                concept_rows = await conn.fetch(
                    """
                    SELECT code, display, definition
                    FROM fhir.concepts
                    WHERE cs_id = $1
                    ORDER BY code
                    LIMIT $2 OFFSET $3
                    """,
                    row["artifact_id"],
                    per_page,
                    offset,
                )
                return (
                    [
                        {
                            "code": r["code"] or "",
                            "display": r["display"] or "",
                            "definition": r["definition"] or "",
                        }
                        for r in concept_rows
                    ],
                    total_rows,
                )
            if row["resource_type"] == "ValueSet":
                value_rows = await _valueset_allowed_rows(conn, raw)
                return value_rows[offset : offset + per_page], len(value_rows)
            return [], 0

        async def _artifact_tree_response(key: str) -> dict[str, Any]:
            row = await _fetch_artifact(key)
            if not row:
                return {"type": "error", "message": f"Artifact '{key}' not found"}
            selected = _artifact_summary(row)
            raw = _json_value(row["raw_json"])
            detail = _resource_detail(raw, row["resource_type"])
            elements = detail.get("elements") or []
            terminology_rows, terminology_total = await _terminology_rows_for_artifact(
                row, raw
            )
            return {
                "type": "artifact_tree",
                "tree": tree_nodes,
                "navigator": tree_nodes,
                "profile_tree": profile_tree,
                "selected": selected,
                "artifact": selected,
                "detail": detail,
                "elements": elements,
                "element_tree": (
                    _element_tree(elements)
                    if row["resource_type"] == "StructureDefinition"
                    else []
                ),
                "stats": detail.get("stats") or {},
                "rows": terminology_rows,
                "total": (
                    len(elements)
                    if row["resource_type"] == "StructureDefinition"
                    else terminology_total
                ),
                "page": page,
                "per_page": per_page,
                "counts": {
                    "codesystems": cs_count,
                    "artifacts": artifact_count,
                    "profiles": profile_count,
                    "profile_resources": len(profile_tree),
                },
                "resource_types": resource_types,
                "base_types": base_types,
            }

        async def _valueset_response(url_or_key: str) -> dict[str, Any]:
            lookup = url_or_key.strip()
            artifact_row = None
            if lookup:
                artifact_row = await conn.fetchrow(
                    """
                    SELECT *
                    FROM fhir.artifacts
                    WHERE resource_type = 'ValueSet'
                      AND (
                        artifact_key = $1 OR canonical_url = $1 OR artifact_id = $2
                      )
                    LIMIT 1
                    """,
                    _strip_canonical_version(lookup),
                    _canonical_tail(lookup, "ValueSet"),
                )
            if not artifact_row:
                return {
                    "type": "valueset_detail",
                    "tree": tree_nodes,
                    "navigator": tree_nodes,
                    "profile_tree": profile_tree,
                    "selected": {
                        "resource_type": "ValueSet",
                        "artifact_id": _canonical_tail(lookup, "ValueSet"),
                        "title": _canonical_tail(lookup, "ValueSet") or lookup,
                        "canonical_url": lookup,
                    },
                    "detail": {"url": lookup},
                    "rows": (
                        [
                            {
                                "row_type": "external ValueSet",
                                "display": lookup,
                                "meaning": "This ValueSet is referenced by the profile but is not present in the imported TWCore package.",
                                "source": "binding.valueSet",
                            }
                        ]
                        if lookup
                        else []
                    ),
                    "total": 1 if lookup else 0,
                    "page": page,
                    "per_page": per_page,
                    "counts": {
                        "codesystems": cs_count,
                        "artifacts": artifact_count,
                        "profiles": profile_count,
                        "profile_resources": len(profile_tree),
                    },
                    "resource_types": resource_types,
                    "base_types": base_types,
                }
            selected = _artifact_summary(artifact_row)
            raw = _json_value(artifact_row["raw_json"])
            detail = _resource_detail(raw, "ValueSet")
            value_rows = await _valueset_allowed_rows(conn, raw)
            return {
                "type": "valueset_detail",
                "tree": tree_nodes,
                "navigator": tree_nodes,
                "profile_tree": profile_tree,
                "selected": selected,
                "artifact": selected,
                "detail": detail,
                "rows": value_rows[offset : offset + per_page],
                "total": len(value_rows),
                "page": page,
                "per_page": per_page,
                "counts": {
                    "codesystems": cs_count,
                    "artifacts": artifact_count,
                    "profiles": profile_count,
                    "profile_resources": len(profile_tree),
                },
                "resource_types": resource_types,
                "base_types": base_types,
            }

        if mode_value == "navigator":
            return {
                "type": "navigator",
                "tree": tree_nodes,
                "nodes": tree_nodes,
                "profile_tree": profile_tree,
                "rows": [],
                "total": len(tree_nodes),
                "page": 1,
                "per_page": per_page,
                "counts": {
                    "codesystems": cs_count,
                    "artifacts": artifact_count,
                    "profiles": profile_count,
                    "profile_resources": len(profile_tree),
                },
                "resource_types": resource_types,
                "base_types": base_types,
            }

        if mode_value == "artifact_tree":
            key = artifact_key.strip()
            if not key and selected_node.startswith("artifact:"):
                key = selected_node.split(":", 1)[1]
            if not key:
                return {
                    "type": "error",
                    "message": "Missing artifact_key for TWCore artifact tree.",
                }
            return await _artifact_tree_response(key)

        if mode_value == "valueset":
            lookup = value_set_url.strip() or artifact_key.strip()
            if not lookup and selected_node:
                lookup = selected_node.removeprefix("artifact:")
            return await _valueset_response(lookup)

        if mode_value == "search":
            term = query or field_q.strip()
            conditions: list[str] = []
            params: list[Any] = []
            if term:
                params.append(f"%{term}%")
                conditions.append(
                    f"(artifact_key ILIKE ${len(params)} OR artifact_id ILIKE ${len(params)} "
                    f"OR canonical_url ILIKE ${len(params)} OR name ILIKE ${len(params)} "
                    f"OR title ILIKE ${len(params)} OR description ILIKE ${len(params)})"
                )
            if selected_group:
                params.append(selected_group)
                conditions.append(f"grouping_id = ${len(params)}")
            if resource_type:
                params.append(resource_type)
                conditions.append(f"resource_type = ${len(params)}")
            if base_type:
                params.append(base_type)
                conditions.append(f"base_type = ${len(params)}")
            where = "WHERE " + " AND ".join(conditions) if conditions else ""
            total = int(
                await conn.fetchval(
                    f"SELECT COUNT(*) FROM fhir.artifacts {where}", *params
                )
                or 0
            )
            artifact_search_rows = await conn.fetch(
                f"""
                SELECT *
                FROM fhir.artifacts
                {where}
                ORDER BY {sort_sql} {direction}, artifact_key
                LIMIT ${len(params) + 1} OFFSET ${len(params) + 2}
                """,
                *params,
                per_page,
                offset,
            )
            structure_rows: list[asyncpg.Record] = []
            if not resource_type or resource_type == "StructureDefinition":
                structure_conditions = ["resource_type = 'StructureDefinition'"]
                structure_params: list[Any] = []
                if selected_group:
                    structure_params.append(selected_group)
                    structure_conditions.append(
                        f"grouping_id = ${len(structure_params)}"
                    )
                if base_type:
                    structure_params.append(base_type)
                    structure_conditions.append(f"base_type = ${len(structure_params)}")
                structure_where = "WHERE " + " AND ".join(structure_conditions)
                structure_rows = await conn.fetch(
                    f"""
                    SELECT *
                    FROM fhir.artifacts
                    {structure_where}
                    ORDER BY COALESCE(NULLIF(title, ''), NULLIF(name, ''), artifact_id, artifact_key)
                    """,
                    *structure_params,
                )
            field_results: list[dict[str, Any]] = []
            if term:
                for structure_row in structure_rows:
                    artifact = _artifact_summary(structure_row)
                    raw = _json_value(structure_row["raw_json"])
                    for element in _structure_element_rows(raw):
                        if not _element_matches(element, term):
                            continue
                        field_results.append(
                            {
                                **element,
                                "artifact_key": artifact["artifact_key"],
                                "artifact_id": artifact["artifact_id"],
                                "artifact_title": artifact["title"],
                                "base_type": artifact["base_type"],
                                "grouping_name": artifact["grouping_name"],
                                "node": f"artifact:{artifact['artifact_key']}",
                            }
                        )
            return {
                "type": "search",
                "tree": tree_nodes,
                "navigator": tree_nodes,
                "profile_tree": profile_tree,
                "rows": [
                    {
                        **_artifact_summary(r),
                        "node": f"artifact:{r['artifact_key']}",
                        "is_leaf": True,
                    }
                    for r in artifact_search_rows
                ],
                "field_results": field_results[:100],
                "field_results_total": len(field_results),
                "total": total,
                "page": page,
                "per_page": per_page,
                "counts": {
                    "codesystems": cs_count,
                    "artifacts": artifact_count,
                    "profiles": profile_count,
                    "profile_resources": len(profile_tree),
                },
                "resource_types": resource_types,
                "base_types": base_types,
            }

        # Backward-compatible CodeSystem detail.
        if cs_id and not selected_node.startswith("artifact:"):
            selected_node = f"artifact:CodeSystem/{cs_id}"

        if selected_node.startswith("artifact:"):
            artifact_key = selected_node.split(":", 1)[1]
            row = await conn.fetchrow(
                "SELECT * FROM fhir.artifacts WHERE artifact_key = $1",
                artifact_key,
            )
            if not row:
                return {
                    "type": "error",
                    "message": f"Artifact '{artifact_key}' not found",
                }
            selected = _artifact_summary(row)
            raw = _json_value(row["raw_json"])
            detail = _resource_detail(raw, row["resource_type"])
            rows: list[dict[str, Any]] = []
            total = 0
            if row["resource_type"] == "CodeSystem":
                total = int(
                    await conn.fetchval(
                        "SELECT COUNT(*) FROM fhir.concepts WHERE cs_id = $1",
                        row["artifact_id"],
                    )
                    or 0
                )
                concept_rows = await conn.fetch(
                    """
                    SELECT code, display, definition
                    FROM fhir.concepts
                    WHERE cs_id = $1
                    ORDER BY code
                    LIMIT $2 OFFSET $3
                    """,
                    row["artifact_id"],
                    per_page,
                    offset,
                )
                rows = [
                    {
                        "code": r["code"] or "",
                        "display": r["display"] or "",
                        "definition": r["definition"] or "",
                    }
                    for r in concept_rows
                ]
            elif row["resource_type"] == "ValueSet":
                value_rows = await _valueset_allowed_rows(conn, raw)
                total = len(value_rows)
                rows = value_rows[offset : offset + per_page]
            elif row["resource_type"] == "StructureDefinition":
                element_rows = detail.get("elements") or []
                total = len(element_rows)
                rows = element_rows[offset : offset + per_page]
            return {
                "type": "artifact_detail",
                "tree": tree_nodes,
                "navigator": tree_nodes,
                "profile_tree": profile_tree,
                "selected": selected,
                "detail": detail,
                "rows": rows,
                "total": total,
                "page": page,
                "per_page": per_page,
                "counts": {
                    "codesystems": cs_count,
                    "artifacts": artifact_count,
                    "profiles": profile_count,
                    "profile_resources": len(profile_tree),
                },
                "resource_types": resource_types,
                "base_types": base_types,
            }

        conditions: list[str] = []
        params: list[Any] = []
        if query:
            params.append(f"%{query}%")
            conditions.append(
                f"(artifact_key ILIKE ${len(params)} OR artifact_id ILIKE ${len(params)} "
                f"OR canonical_url ILIKE ${len(params)} OR name ILIKE ${len(params)} "
                f"OR title ILIKE ${len(params)} OR description ILIKE ${len(params)})"
            )
        if selected_group:
            params.append(selected_group)
            conditions.append(f"grouping_id = ${len(params)}")
        if resource_type:
            params.append(resource_type)
            conditions.append(f"resource_type = ${len(params)}")
        if base_type:
            params.append(base_type)
            conditions.append(f"base_type = ${len(params)}")
        where = "WHERE " + " AND ".join(conditions) if conditions else ""
        total = int(
            await conn.fetchval(f"SELECT COUNT(*) FROM fhir.artifacts {where}", *params)
            or 0
        )
        rows = await conn.fetch(
            f"""
            SELECT *
            FROM fhir.artifacts
            {where}
            ORDER BY {sort_sql} {direction}, artifact_key
            LIMIT ${len(params) + 1} OFFSET ${len(params) + 2}
            """,
            *params,
            per_page,
            offset,
        )
        artifact_rows = [
            {
                **_artifact_summary(r),
                "node": f"artifact:{r['artifact_key']}",
                "is_leaf": True,
            }
            for r in rows
        ]

        if query or selected_group or resource_type or base_type:
            return {
                "type": "artifact_list",
                "tree": tree_nodes,
                "navigator": tree_nodes,
                "profile_tree": profile_tree,
                "selected_group": selected_group,
                "rows": artifact_rows,
                "total": total,
                "page": page,
                "per_page": per_page,
                "counts": {
                    "codesystems": cs_count,
                    "artifacts": artifact_count,
                    "profiles": profile_count,
                    "profile_resources": len(profile_tree),
                },
                "resource_types": resource_types,
                "base_types": base_types,
            }

        return {
            "type": "tree_root",
            "tree": tree_nodes,
            "navigator": tree_nodes,
            "profile_tree": profile_tree,
            "nodes": tree_nodes,
            "rows": tree_nodes,
            "total": len(tree_nodes),
            "page": 1,
            "per_page": len(tree_nodes),
            "counts": {
                "codesystems": cs_count,
                "artifacts": artifact_count,
                "profiles": profile_count,
                "profile_resources": len(profile_tree),
            },
            "resource_types": resource_types,
            "base_types": base_types,
        }

        # ── Legacy modes below are intentionally unreachable for new clients. ──
        if q and q.strip():
            term = "%" + q.strip() + "%"
            rows = await conn.fetch(
                """
                SELECT c.cs_id, c.code, c.display, c.definition,
                       cs.name AS cs_name
                FROM fhir.concepts c
                JOIN fhir.codesystems cs
                  ON cs.package_id = c.package_id
                 AND cs.package_version = c.package_version
                 AND cs.cs_id = c.cs_id
                WHERE c.code ILIKE $1 OR c.display ILIKE $1
                ORDER BY c.cs_id, c.code
                LIMIT 80
                """,
                term,
            )
            return {
                "type": "search",
                "query": q.strip(),
                "results": [
                    {
                        "cs_id": r["cs_id"],
                        "cs_name": r["cs_name"] or r["cs_id"],
                        "code": r["code"] or "",
                        "display": r["display"] or "",
                        "definition": r["definition"] or "",
                    }
                    for r in rows
                ],
            }

        # ── Detail: concepts for one codesystem ───────────────────────────
        if cs_id:
            cs_row = await conn.fetchrow(
                "SELECT * FROM fhir.codesystems WHERE cs_id = $1 LIMIT 1", cs_id
            )
            if not cs_row:
                return {"type": "error", "message": f"CodeSystem '{cs_id}' not found"}
            rows = await conn.fetch(
                """
                SELECT code, display, definition
                FROM fhir.concepts WHERE cs_id = $1
                ORDER BY code
                """,
                cs_id,
            )
            return {
                "type": "concepts",
                "cs_id": cs_id,
                "cs_name": cs_row["name"] or cs_id,
                "cs_category": cs_row["category"] or "",
                "concept_count": len(rows),
                "concepts": [
                    {
                        "code": r["code"] or "",
                        "display": r["display"] or "",
                        "definition": r["definition"] or "",
                    }
                    for r in rows
                ],
            }

        # ── Master list: all codesystems ───────────────────────────────────
        rows = await conn.fetch("""
            SELECT cs_id, name, category, concept_count, fetched_at
            FROM fhir.codesystems
            ORDER BY category NULLS LAST, name
            """)
        return {
            "type": "codesystems",
            "codesystems": [
                {
                    "cs_id": r["cs_id"],
                    "name": r["name"] or r["cs_id"],
                    "category": r["category"] or "",
                    "concept_count": r["concept_count"] or 0,
                    "fetched_at": _iso(r["fetched_at"]),
                }
                for r in rows
            ],
        }


# ---------------------------------------------------------------------------
# Clinical Guidelines  (disease list + full guideline detail)
# ---------------------------------------------------------------------------


async def preview_guideline(
    pool: PoolLike,
    *,
    id_: int | None = None,
    q: str | None = None,
) -> dict[str, Any]:
    """Clinical guidelines preview.

    ``id_`` omitted → disease list
    ``id_={n}``     → full guideline with all recommendation tables
    ``q={text}``    → search disease names / titles
    """
    async with pool.acquire() as conn:
        total = int(
            await conn.fetchval("SELECT COUNT(*) FROM guideline.disease_guidelines")
            or 0
        )
        if total == 0:
            return {
                "type": "empty",
                "message": "Clinical Guidelines not loaded. Run the seed job first.",
                "total": 0,
            }

        # ── Search ─────────────────────────────────────────────────────────
        if q and q.strip():
            term = "%" + q.strip() + "%"
            rows = await conn.fetch(
                """
                SELECT id, icd_code, disease_name_zh, disease_name_en,
                       guideline_title, guideline_source, publication_year
                FROM guideline.disease_guidelines
                WHERE disease_name_zh ILIKE $1
                   OR disease_name_en ILIKE $1
                   OR icd_code ILIKE $1
                   OR guideline_title ILIKE $1
                ORDER BY icd_code
                LIMIT 30
                """,
                term,
            )
            return {
                "type": "search",
                "query": q.strip(),
                "results": [
                    {
                        "id": r["id"],
                        "icd_code": r["icd_code"],
                        "disease_name_zh": r["disease_name_zh"] or "",
                        "disease_name_en": r["disease_name_en"] or "",
                        "guideline_title": r["guideline_title"] or "",
                        "guideline_source": r["guideline_source"] or "",
                        "publication_year": r["publication_year"],
                    }
                    for r in rows
                ],
            }

        # ── Full guideline detail ──────────────────────────────────────────
        if id_ is not None:
            g = await conn.fetchrow(
                "SELECT * FROM guideline.disease_guidelines WHERE id = $1", id_
            )
            if not g:
                return {"type": "error", "message": f"Guideline id={id_} not found"}

            diag = await conn.fetch(
                """
                SELECT step_order, recommendation_type, description, evidence_level
                FROM guideline.diagnostic_recommendations WHERE guideline_id = $1 ORDER BY step_order
                """,
                id_,
            )
            meds = await conn.fetch(
                """
                SELECT line_of_therapy, medication_class, medication_examples,
                       dosage_guidance, contraindications, evidence_level
                FROM guideline.medication_recommendations WHERE guideline_id = $1 ORDER BY id
                """,
                id_,
            )
            tests = await conn.fetch(
                """
                SELECT test_category, test_name, loinc_code, frequency, indication, evidence_level
                FROM guideline.test_recommendations WHERE guideline_id = $1 ORDER BY id
                """,
                id_,
            )
            goals = await conn.fetch(
                """
                SELECT goal_type, target_parameter, target_value, timeframe
                FROM guideline.treatment_goals WHERE guideline_id = $1 ORDER BY id
                """,
                id_,
            )
            return {
                "type": "detail",
                "guideline": {
                    "id": g["id"],
                    "icd_code": g["icd_code"],
                    "disease_name_zh": g["disease_name_zh"] or "",
                    "disease_name_en": g["disease_name_en"] or "",
                    "guideline_title": g["guideline_title"] or "",
                    "guideline_source": g["guideline_source"] or "",
                    "publication_year": g["publication_year"],
                    "guideline_summary": g["guideline_summary"] or "",
                },
                "diagnostic_recommendations": [dict(r) for r in diag],
                "medication_recommendations": [dict(r) for r in meds],
                "test_recommendations": [dict(r) for r in tests],
                "treatment_goals": [dict(r) for r in goals],
            }

        # ── Disease list ───────────────────────────────────────────────────
        rows = await conn.fetch("""
            SELECT id, icd_code, disease_name_zh, disease_name_en,
                   guideline_title, guideline_source, publication_year
            FROM guideline.disease_guidelines
            ORDER BY icd_code
            """)
        return {
            "type": "list",
            "total": total,
            "diseases": [
                {
                    "id": r["id"],
                    "icd_code": r["icd_code"],
                    "disease_name_zh": r["disease_name_zh"] or "",
                    "disease_name_en": r["disease_name_en"] or "",
                    "guideline_title": r["guideline_title"] or "",
                    "guideline_source": r["guideline_source"] or "",
                    "publication_year": r["publication_year"],
                }
                for r in rows
            ],
        }


# ---------------------------------------------------------------------------
# Taiwan FDA Drug  (quality stats + paginated license list)
# ---------------------------------------------------------------------------


async def preview_drug(
    pool: PoolLike,
    *,
    page: int = 1,
    q: str = "",
    quality: str = "",
    per_page: int = _DRUG_PAGE_SIZE,
) -> dict[str, Any]:
    """Drug preview — quality stats + paginated license list.

    ``quality`` filter: 'index_only' | 'ei_partial' | 'ei_complete' | 'pdf_ocr'
    """
    async with pool.acquire() as conn:
        license_count = int(
            await conn.fetchval("SELECT COUNT(*) FROM drug.licenses") or 0
        )
        if license_count == 0:
            return {
                "type": "empty",
                "message": "Drug module not loaded. Run the drug index import first.",
                "total": 0,
            }

        # ── Quality stats ──────────────────────────────────────────────────
        quality_rows = await conn.fetch("""
            SELECT quality_confidence, COUNT(*) AS cnt
            FROM drug.normalized_records
            GROUP BY quality_confidence
            ORDER BY quality_confidence
            """)
        quality_stats = {r["quality_confidence"]: int(r["cnt"]) for r in quality_rows}

        # ── Paginated list ─────────────────────────────────────────────────
        conditions: list[str] = []
        params: list[Any] = []
        idx = 1

        if q and q.strip():
            term = "%" + q.strip() + "%"
            conditions.append(
                f"(l.license_id ILIKE ${idx} OR l.chinese_name ILIKE ${idx} "
                f"OR l.english_name ILIKE ${idx})"
            )
            params.append(term)
            idx += 1

        if quality and quality.strip():
            conditions.append(f"nr.quality_confidence = ${idx}")
            params.append(quality.strip())
            idx += 1

        where = ("WHERE " + " AND ".join(conditions)) if conditions else ""

        count_sql = f"""
            SELECT COUNT(*) FROM drug.licenses l
            LEFT JOIN drug.normalized_records nr ON nr.license_id = l.license_id
            {where}
        """
        total_filtered = int(await conn.fetchval(count_sql, *params) or 0)

        offset = (max(1, page) - 1) * per_page
        rows = await conn.fetch(
            f"""
            SELECT
                l.license_id,
                l.chinese_name,
                l.english_name,
                l.drug_category,
                l.is_active,
                COALESCE(nr.quality_confidence, 'index_only') AS quality_confidence,
                COALESCE(nr.primary_insert_source, 'index')   AS primary_insert_source
            FROM drug.licenses l
            LEFT JOIN drug.normalized_records nr ON nr.license_id = l.license_id
            {where}
            ORDER BY l.license_id
            LIMIT ${idx} OFFSET ${idx + 1}
            """,
            *params,
            per_page,
            offset,
        )

        return {
            "type": "drug",
            "stats": {
                "total_licenses": license_count,
                "quality": quality_stats,
            },
            "total": total_filtered,
            "page": page,
            "per_page": per_page,
            "pages": max(1, (total_filtered + per_page - 1) // per_page),
            "rows": [
                {
                    "license_id": r["license_id"],
                    "chinese_name": r["chinese_name"] or "",
                    "english_name": r["english_name"] or "",
                    "drug_category": r["drug_category"] or "",
                    "is_active": bool(r["is_active"]),
                    "quality_confidence": r["quality_confidence"] or "index_only",
                    "primary_insert_source": r["primary_insert_source"] or "index",
                }
                for r in rows
            ],
        }


# ---------------------------------------------------------------------------
# Taiwan FDA Health Supplements  (paginated permit list)
# ---------------------------------------------------------------------------


async def preview_health_supplements(
    pool: PoolLike,
    *,
    page: int = 1,
    q: str = "",
    per_page: int = _HF_PAGE_SIZE,
) -> dict[str, Any]:
    async with pool.acquire() as conn:
        total = int(
            await conn.fetchval("SELECT COUNT(*) FROM health_supplements.items") or 0
        )
        if total == 0:
            return {
                "type": "empty",
                "message": "Health Supplements module not loaded. Run a sync job first.",
                "total": 0,
            }

        last_sync = await conn.fetchval(
            "SELECT value FROM health_supplements.sync_meta WHERE key = 'last_updated'"
        )

        conditions: list[str] = []
        params: list[Any] = []
        if q and q.strip():
            term = "%" + q.strip() + "%"
            conditions.append(
                "(name ILIKE $1 OR applicant ILIKE $1 OR benefit_claims ILIKE $1 OR permit_no ILIKE $1)"
            )
            params.append(term)

        where = ("WHERE " + " AND ".join(conditions)) if conditions else ""
        total_filtered = int(
            await conn.fetchval(
                f"SELECT COUNT(*) FROM health_supplements.items {where}", *params
            )
            or 0
        )

        offset = (max(1, page) - 1) * per_page
        p_idx = len(params) + 1
        rows = await conn.fetch(
            f"""
            SELECT permit_no, name, applicant, benefit_claims, valid_from, valid_to, category
            FROM health_supplements.items {where}
            ORDER BY permit_no
            LIMIT ${p_idx} OFFSET ${p_idx + 1}
            """,
            *params,
            per_page,
            offset,
        )

        return {
            "type": "table",
            "total": total_filtered,
            "total_all": total,
            "last_sync": last_sync,
            "page": page,
            "per_page": per_page,
            "pages": max(1, (total_filtered + per_page - 1) // per_page),
            "rows": [
                {
                    "permit_no": r["permit_no"],
                    "name": r["name"] or "",
                    "applicant": r["applicant"] or "",
                    "benefit_claims": r["benefit_claims"] or "",
                    "valid_from": r["valid_from"] or "",
                    "valid_to": r["valid_to"] or "",
                    "category": r["category"] or "",
                }
                for r in rows
            ],
        }


# ---------------------------------------------------------------------------
# Taiwan FDA Food Nutrition  (foods + ingredients)
# ---------------------------------------------------------------------------


async def preview_food_nutrition(
    pool: PoolLike,
    *,
    mode: str = "foods",  # 'foods' | 'ingredients'
    page: int = 1,
    q: str = "",
    per_page: int = _FN_PAGE_SIZE,
) -> dict[str, Any]:
    async with pool.acquire() as conn:
        if mode == "ingredients":
            total = int(
                await conn.fetchval("SELECT COUNT(*) FROM food_nutrition.ingredients")
                or 0
            )
            if total == 0:
                return {
                    "type": "empty",
                    "message": "Food Nutrition ingredients not loaded.",
                    "total": 0,
                }

            conditions: list[str] = []
            params: list[Any] = []
            if q and q.strip():
                term = "%" + q.strip() + "%"
                conditions.append("(name_zh ILIKE $1 OR name_en ILIKE $1)")
                params.append(term)

            where = ("WHERE " + " AND ".join(conditions)) if conditions else ""
            total_filtered = int(
                await conn.fetchval(
                    f"SELECT COUNT(*) FROM food_nutrition.ingredients {where}", *params
                )
                or 0
            )

            offset = (max(1, page) - 1) * per_page
            p_idx = len(params) + 1
            rows = await conn.fetch(
                f"""
                SELECT id, name_zh, name_en, major_category, sub_category
                FROM food_nutrition.ingredients {where}
                ORDER BY id
                LIMIT ${p_idx} OFFSET ${p_idx+1}
                """,
                *params,
                per_page,
                offset,
            )
            return {
                "type": "ingredients",
                "total": total_filtered,
                "total_all": total,
                "page": page,
                "per_page": per_page,
                "pages": max(1, (total_filtered + per_page - 1) // per_page),
                "rows": [
                    {
                        "id": r["id"],
                        "name_zh": r["name_zh"] or "",
                        "name_en": r["name_en"] or "",
                        "major_category": r["major_category"] or "",
                        "sub_category": r["sub_category"] or "",
                    }
                    for r in rows
                ],
            }

        # ── Foods mode ─────────────────────────────────────────────────────
        # Food measurements are in wide-pivot form; we show distinct sample_names
        total = int(
            await conn.fetchval(
                "SELECT COUNT(DISTINCT sample_name) FROM food_nutrition.measurements"
            )
            or 0
        )
        if total == 0:
            return {
                "type": "empty",
                "message": "Food Nutrition measurements not loaded.",
                "total": 0,
            }

        last_sync = await conn.fetchval(
            "SELECT value FROM food_nutrition.sync_meta WHERE key = 'last_updated'"
        )

        conditions = []
        params = []
        if q and q.strip():
            term = "%" + q.strip() + "%"
            conditions.append(
                "(sample_name ILIKE $1 OR common_name ILIKE $1 OR english_name ILIKE $1)"
            )
            params.append(term)

        where = ("WHERE " + " AND ".join(conditions)) if conditions else ""
        total_filtered = int(
            await conn.fetchval(
                f"SELECT COUNT(DISTINCT sample_name) FROM food_nutrition.measurements {where}",
                *params,
            )
            or 0
        )

        offset = (max(1, page) - 1) * per_page
        p_idx = len(params) + 1
        rows = await conn.fetch(
            f"""
            SELECT DISTINCT ON (sample_name)
                sample_name, common_name, english_name, food_category,
                COUNT(*) OVER (PARTITION BY sample_name) AS nutrient_count
            FROM food_nutrition.measurements
            {where}
            ORDER BY sample_name
            LIMIT ${p_idx} OFFSET ${p_idx+1}
            """,
            *params,
            per_page,
            offset,
        )

        return {
            "type": "foods",
            "total": total_filtered,
            "total_all": total,
            "last_sync": last_sync,
            "page": page,
            "per_page": per_page,
            "pages": max(1, (total_filtered + per_page - 1) // per_page),
            "rows": [
                {
                    "sample_name": r["sample_name"] or "",
                    "common_name": r["common_name"] or "",
                    "english_name": r["english_name"] or "",
                    "food_category": r["food_category"] or "",
                    "nutrient_count": int(r["nutrient_count"] or 0),
                }
                for r in rows
            ],
        }


_RXNORM_PAGE_SIZE = 50


async def preview_rxnorm(
    pool: PoolLike,
    *,
    mode: str = "concepts",
    q: str = "",
    tty: str = "",
    page: int = 1,
    per_page: int = _RXNORM_PAGE_SIZE,
) -> dict[str, Any]:
    """RxNorm reference-terminology preview.

    Shows the concept table (one row per RXCUI) with a TTY distribution that
    doubles as a filter — the same TTY axis IG ValueSets filter on
    (e.g. ``TTY in (SCD,SBD,GPCK,BPCK)``). Searchable by name or RXCUI.
    """
    async with pool.acquire() as conn:
        total_all = int(
            await conn.fetchval("SELECT COUNT(*) FROM rxnorm.concepts") or 0
        )
        if total_all == 0:
            return {
                "type": "empty",
                "message": "RxNorm module not loaded. Upload the RxNorm Full Release ZIP and import first.",
                "total": 0,
            }

        # TTY distribution — the headline RxNorm facet, also used as a filter.
        tty_rows = await conn.fetch(
            "SELECT tty, COUNT(*) AS n FROM rxnorm.concepts GROUP BY tty ORDER BY n DESC, tty"
        )
        tty_facets = [{"tty": r["tty"], "count": int(r["n"])} for r in tty_rows]

        query = (q or "").strip()
        tty = (tty or "").strip()
        page = max(1, int(page or 1))
        per_page = max(1, min(int(per_page or _RXNORM_PAGE_SIZE), 200))

        conditions: list[str] = []
        params: list[Any] = []
        if query:
            if query.isdigit():
                params.append(query + "%")
                params.append("%" + query + "%")
                conditions.append(
                    f"(rxcui::text LIKE ${len(params) - 1} OR name ILIKE ${len(params)})"
                )
            else:
                params.append("%" + query + "%")
                conditions.append(f"name ILIKE ${len(params)}")
        if tty:
            params.append(tty)
            conditions.append(f"tty = ${len(params)}")

        where = ("WHERE " + " AND ".join(conditions)) if conditions else ""
        total_filtered = int(
            await conn.fetchval(
                f"SELECT COUNT(*) FROM rxnorm.concepts {where}", *params
            )
            or 0
        )

        offset = (page - 1) * per_page
        rows = await conn.fetch(
            f"""
            SELECT rxcui, name, tty, suppress
            FROM rxnorm.concepts
            {where}
            ORDER BY rxcui
            LIMIT ${len(params) + 1} OFFSET ${len(params) + 2}
            """,
            *params,
            per_page,
            offset,
        )

        return {
            "type": "concepts",
            "total": total_filtered,
            "total_all": total_all,
            "tty_facets": tty_facets,
            "tty_selected": tty,
            "query": query,
            "page": page,
            "per_page": per_page,
            "pages": max(1, (total_filtered + per_page - 1) // per_page),
            "rows": [
                {
                    "rxcui": str(r["rxcui"]),
                    "name": r["name"] or "",
                    "tty": r["tty"] or "",
                    "suppress": r["suppress"] or "",
                }
                for r in rows
            ],
        }


# ---------------------------------------------------------------------------
# Dispatcher
# ---------------------------------------------------------------------------

_PREVIEW_HANDLERS = {
    "icd": preview_icd,
    "loinc": preview_loinc,
    "snomed": preview_snomed,
    "ig": preview_ig,
    "guideline": preview_guideline,
    "drug": preview_drug,
    "health_supplements": preview_health_supplements,
    "food_nutrition": preview_food_nutrition,
    "rxnorm": preview_rxnorm,
}

PREVIEW_SUPPORTED_MODULES = frozenset(_PREVIEW_HANDLERS)


async def dispatch_preview(
    pool: PoolLike,
    module_key: str,
    params: dict[str, Any],
) -> dict[str, Any]:
    """Route a preview request to the appropriate handler."""
    handler = _PREVIEW_HANDLERS.get(module_key)
    if handler is None:
        return {
            "type": "error",
            "message": f"No preview handler for module '{module_key}'",
        }
    return await handler(pool, **params)
