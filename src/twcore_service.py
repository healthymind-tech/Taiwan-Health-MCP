"""
TWCore Service — Taiwan Core Implementation Guide CodeSystem lookup.
Data pre-loaded into PostgreSQL from package.tgz by data-loader.
Falls back to live TWCore API fetch if a CodeSystem is missing.
"""

import json
from typing import Dict, List, Optional, Tuple

import httpx

import fhir_ig
from cache import cached
from database import PoolLike
from utils import log_error, log_info

TWCORE_BASE_URL = "https://twcore.mohw.gov.tw/ig/twcore"
TWCORE_BACKUP_URL = "https://build.fhir.org/ig/cctwFHIRterm/MOHW_TWCoreIG_Build"
REQUEST_TIMEOUT = 15

# CodeSystem registry (metadata only — actual concepts stored in PostgreSQL)
CODESYSTEM_REGISTRY: List[Dict] = [
    # === 診斷分類 (diagnosis) ===
    {
        "id": "icd-10-cm-2023-tw",
        "name": "臺灣健保署ICD-10-CM 2023年版",
        "category": "diagnosis",
        "keywords": ["ICD-10-CM", "診斷", "2023"],
    },
    {
        "id": "icd-10-cm-2021-tw",
        "name": "臺灣健保署ICD-10-CM 2021年版",
        "category": "diagnosis",
        "keywords": ["ICD-10-CM", "診斷", "2021"],
    },
    {
        "id": "icd-10-pcs-2023-tw",
        "name": "臺灣健保署ICD-10-PCS 2023年版",
        "category": "diagnosis",
        "keywords": ["ICD-10-PCS", "處置", "procedure"],
    },
    # === 醫療機構/人員 (organization) ===
    {
        "id": "organization-identifier-tw",
        "name": "臺灣醫療機構識別碼",
        "category": "organization",
        "keywords": ["機構", "醫院", "診所"],
    },
    {
        "id": "practitioner-identifier-tw",
        "name": "臺灣醫事人員識別碼",
        "category": "organization",
        "keywords": ["醫師", "護理", "醫事人員"],
    },
    {
        "id": "department-nhia-tw",
        "name": "臺灣健保署就醫科別",
        "category": "organization",
        "keywords": ["科別", "門診", "科"],
    },
    {
        "id": "specialty-nhia-tw",
        "name": "臺灣健保署專科醫師代碼",
        "category": "organization",
        "keywords": ["專科", "specialty"],
    },
    # === 行政/人口統計 (administrative) ===
    {
        "id": "postal-code-tw",
        "name": "臺灣郵遞區號",
        "category": "administrative",
        "keywords": ["郵遞區號", "zip", "postal"],
    },
    {
        "id": "marital-status-tw",
        "name": "臺灣婚姻狀態",
        "category": "administrative",
        "keywords": ["婚姻", "marital"],
    },
    {
        "id": "occupation-dhpc-tw",
        "name": "臺灣職業代碼",
        "category": "administrative",
        "keywords": ["職業", "occupation"],
    },
]

CATEGORY_NAMES = {
    "diagnosis": "診斷分類",
    "organization": "醫療機構/人員",
    "administrative": "行政/人口統計",
    "technical": "系統/技術",
}


class TWCoreService:
    def __init__(self, pool: PoolLike):
        self.pool = pool

    async def initialize(self) -> None:
        count = await self.pool.fetchval("SELECT COUNT(*) FROM fhir.codesystems")
        if count == 0:
            log_error(
                "FHIR CodeSystems table empty — import a TWCore IG package first; live fetch will be used as fallback"
            )
        else:
            log_info(f"TWCore Service ready ({count} CodeSystems in DB)")

    # ------------------------------------------------------------------ #
    #  Package scoping                                                      #
    # ------------------------------------------------------------------ #

    async def _default_pkg(self) -> Optional[Tuple[str, str]]:
        """The ``(package_id, version)`` of the registry's default IG package,
        or ``None`` when no package is installed. All reads/writes below are
        scoped to this package so behaviour matches the former single-IG model.
        Phase 1 will let MCP tools target an explicit ``ig`` instead."""
        return await fhir_ig.resolve_default_package(self.pool)

    # ------------------------------------------------------------------ #
    #  Live fetch fallback                                                  #
    # ------------------------------------------------------------------ #

    async def _live_fetch(self, cs_id: str) -> Optional[dict]:
        urls = [
            f"{TWCORE_BASE_URL}/CodeSystem-{cs_id}.json",
            f"{TWCORE_BACKUP_URL}/CodeSystem-{cs_id}.json",
        ]
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
            for url in urls:
                try:
                    resp = await client.get(url)
                    if resp.status_code == 200:
                        data = resp.json()
                        if data.get("resourceType") == "CodeSystem":
                            await self._store_codesystem(cs_id, data)
                            return data
                except Exception as e:
                    log_error(f"Live fetch {url}: {e}")
        return None

    async def _store_codesystem(self, cs_id: str, data: dict) -> None:
        # A live-fetched CodeSystem is attached to the default IG package so it
        # augments that package's terminology. Without a default package there
        # is nowhere to anchor it (FK to fhir.ig_packages), so skip the cache.
        pkg = await self._default_pkg()
        if pkg is None:
            return
        package_id, package_version = pkg
        entry = next((e for e in CODESYSTEM_REGISTRY if e["id"] == cs_id), None)
        concepts = data.get("concept", [])
        async with self.pool.acquire() as conn:
            await conn.execute(
                """INSERT INTO fhir.codesystems
                       (package_id, package_version, cs_id, name, category, fetched_at, concept_count)
                   VALUES ($1,$2,$3,$4,$5,NOW(),$6)
                   ON CONFLICT (package_id, package_version, cs_id)
                       DO UPDATE SET fetched_at=NOW(), concept_count=$6""",
                package_id,
                package_version,
                cs_id,
                entry["name"] if entry else cs_id,
                entry["category"] if entry else "unknown",
                len(concepts),
            )
            await conn.execute(
                "DELETE FROM fhir.concepts WHERE package_id=$1 AND package_version=$2 AND cs_id=$3",
                package_id,
                package_version,
                cs_id,
            )
            await conn.executemany(
                "INSERT INTO fhir.concepts (package_id, package_version, cs_id, code, display) "
                "VALUES ($1,$2,$3,$4,$5)",
                [
                    (
                        package_id,
                        package_version,
                        cs_id,
                        c.get("code", ""),
                        c.get("display", ""),
                    )
                    for c in concepts
                ],
            )

    # ------------------------------------------------------------------ #
    #  Public methods                                                       #
    # ------------------------------------------------------------------ #

    @cached(ttl=3600, prefix="tc.list")
    async def list_codesystems(self, category: str = "all") -> str:
        """List the TWCore CodeSystems actually loaded in the database.

        Reports what is really in ``fhir.codesystems`` (including systems
        imported beyond the 10 well-known registry entries — e.g. HL7 THO or
        base-FHIR systems indexed alongside the IG), each with its live
        ``concept_count``. Category/display name come from the built-in registry
        when the cs_id is known; otherwise the value stored at import is used,
        falling back to ``"其他"``. If the table is empty (not yet imported),
        falls back to advertising the static registry so the tool is still
        useful.

        Args:
            category: Category filter — ``"medication"``, ``"diagnosis"``,
                ``"organization"``, ``"administrative"``, or ``"all"``.

        Returns:
            JSON string with ``total`` count, a ``source`` marker
            (``"database"`` | ``"registry"``), and a ``categories`` dict
            grouping CodeSystems by localised category name.
        """
        reg_by_id = {entry["id"]: entry for entry in CODESYSTEM_REGISTRY}
        pkg = await self._default_pkg()
        rows = []
        if pkg is not None:
            async with self.pool.acquire() as conn:
                rows = await conn.fetch(
                    "SELECT cs_id, name, category, concept_count FROM fhir.codesystems "
                    "WHERE package_id = $1 AND package_version = $2 ORDER BY cs_id",
                    pkg[0],
                    pkg[1],
                )

        groups: dict = {}
        total = 0
        for row in rows:
            reg = reg_by_id.get(row["cs_id"])
            cat_key = (reg["category"] if reg else None) or row["category"] or "unknown"
            if category != "all" and cat_key != category:
                continue
            cat_label = CATEGORY_NAMES.get(cat_key, cat_key or "其他")
            groups.setdefault(cat_label, []).append(
                {
                    "id": row["cs_id"],
                    "name": reg["name"] if reg else (row["name"] or row["cs_id"]),
                    "concept_count": row["concept_count"],
                    "json_url": f"{TWCORE_BASE_URL}/CodeSystem-{row['cs_id']}.json",
                }
            )
            total += 1

        if total == 0:
            # DB has no matching rows (not imported yet) — advertise the static
            # registry so the tool still lists the known TWCore systems.
            for entry in CODESYSTEM_REGISTRY:
                if category != "all" and entry["category"] != category:
                    continue
                cat_label = CATEGORY_NAMES.get(entry["category"], entry["category"])
                groups.setdefault(cat_label, []).append(
                    {
                        "id": entry["id"],
                        "name": entry["name"],
                        "json_url": f"{TWCORE_BASE_URL}/CodeSystem-{entry['id']}.json",
                    }
                )
                total += 1
            return json.dumps(
                {"total": total, "source": "registry", "categories": groups},
                ensure_ascii=False,
            )

        return json.dumps(
            {"total": total, "source": "database", "categories": groups},
            ensure_ascii=False,
        )

    @cached(ttl=3600, prefix="tc.search")
    async def search_code(
        self, keyword: str, codesystem_ids: List[str], limit: int = 30
    ) -> str:
        """Search for a code across one or more TWCore CodeSystems.

        If a CodeSystem is not yet cached in the DB, a live fetch is attempted
        automatically before the search.

        Args:
            keyword: Code value or display name fragment to search for.
            codesystem_ids: List of CodeSystem IDs to search (e.g.
                ``["medication-path-tw", "medication-frequency-nhi-tw"]``).
            limit: Maximum total results to return across all CodeSystems.

        Returns:
            JSON string with ``count`` and a ``results`` list, each item
            containing ``cs_id``, ``cs_name``, ``code``, and ``display``.
        """
        results = []
        pkg = await self._default_pkg()
        if pkg is None:
            return json.dumps(
                {"status": "not_found", "message": f"找不到符合 '{keyword}' 的代碼"},
                ensure_ascii=False,
            )
        pid, pver = pkg
        async with self.pool.acquire() as conn:
            for cs_id in codesystem_ids:
                # Ensure this CS is loaded
                exists = await conn.fetchval(
                    "SELECT 1 FROM fhir.codesystems "
                    "WHERE package_id = $1 AND package_version = $2 AND cs_id = $3",
                    pid,
                    pver,
                    cs_id,
                )
                if not exists:
                    await self._live_fetch(cs_id)

                rows = await conn.fetch(
                    """SELECT c.code, c.display, c.definition, cs.name
                       FROM fhir.concepts c
                       JOIN fhir.codesystems cs
                         ON c.package_id = cs.package_id
                        AND c.package_version = cs.package_version
                        AND c.cs_id = cs.cs_id
                       WHERE c.package_id = $1 AND c.package_version = $2 AND c.cs_id = $3
                         AND (to_tsvector('simple', COALESCE(c.code,'') || ' ' || COALESCE(c.display,''))
                              @@ plainto_tsquery('simple', $4)
                              OR c.code ILIKE $5)
                       LIMIT $6""",
                    pid,
                    pver,
                    cs_id,
                    keyword,
                    f"%{keyword}%",
                    limit - len(results),
                )
                results.extend(
                    [
                        {
                            "cs_id": cs_id,
                            "cs_name": r["name"],
                            "code": r["code"],
                            "display": r["display"],
                            "definition": r["definition"],
                        }
                        for r in rows
                    ]
                )
                if len(results) >= limit:
                    break

        if not results:
            return json.dumps(
                {"status": "not_found", "message": f"找不到符合 '{keyword}' 的代碼"},
                ensure_ascii=False,
            )
        return json.dumps(
            {"count": len(results), "results": results}, ensure_ascii=False
        )

    @cached(ttl=86400, prefix="tc.lookup")
    async def lookup_code(self, code: str, codesystem_id: str) -> str:
        """Exact lookup of a single code within a specific CodeSystem.

        Returns a FHIR ``Coding`` object if found. Performs a live fetch if
        the CodeSystem is not yet in the database.

        Args:
            code: The exact code value to look up (case-insensitive).
            codesystem_id: The TWCore CodeSystem ID
                (e.g. ``"medication-path-tw"``).

        Returns:
            JSON string. On success: ``{"status": "success", "fhir_coding": {...}}``.
            On not-found: ``{"status": "not_found", "message": ...}``.
        """
        pkg = await self._default_pkg()
        if pkg is None:
            return json.dumps(
                {
                    "status": "not_found",
                    "message": f"在 {codesystem_id} 中找不到代碼: {code}",
                },
                ensure_ascii=False,
            )
        pid, pver = pkg
        async with self.pool.acquire() as conn:
            exists = await conn.fetchval(
                "SELECT 1 FROM fhir.codesystems "
                "WHERE package_id = $1 AND package_version = $2 AND cs_id = $3",
                pid,
                pver,
                codesystem_id,
            )
            if not exists:
                await self._live_fetch(codesystem_id)

            row = await conn.fetchrow(
                """SELECT c.code, c.display, c.definition, cs.name
                   FROM fhir.concepts c
                   JOIN fhir.codesystems cs
                     ON c.package_id = cs.package_id
                    AND c.package_version = cs.package_version
                    AND c.cs_id = cs.cs_id
                   WHERE c.package_id = $1 AND c.package_version = $2
                     AND c.cs_id = $3 AND UPPER(c.code) = UPPER($4)""",
                pid,
                pver,
                codesystem_id,
                code,
            )

        if not row:
            return json.dumps(
                {
                    "status": "not_found",
                    "message": f"在 {codesystem_id} 中找不到代碼: {code}",
                },
                ensure_ascii=False,
            )

        entry = next((e for e in CODESYSTEM_REGISTRY if e["id"] == codesystem_id), None)
        return json.dumps(
            {
                "status": "success",
                "codesystem_id": codesystem_id,
                "codesystem_name": row["name"],
                "definition": row["definition"],
                "fhir_coding": {
                    "system": f"{TWCORE_BASE_URL}/CodeSystem-{codesystem_id}",
                    "code": row["code"],
                    "display": row["display"],
                },
            },
            ensure_ascii=False,
        )

    # ------------------------------------------------------------------ #
    #  IG artifacts (StructureDefinition / ValueSet / Profile / …)         #
    # ------------------------------------------------------------------ #

    # Summary columns surfaced for every artifact (raw_json excluded — it can be
    # very large and is only returned on explicit detail lookup with include_raw).
    _ARTIFACT_SUMMARY_COLS = """artifact_key, resource_type, artifact_id, canonical_url,
        name, title, status, kind, base_type, derivation, grouping_name,
        child_count, concept_count"""

    @cached(ttl=3600, prefix="tc.art.search")
    async def search_artifacts(
        self,
        resource_type: str | None = None,
        keyword: str | None = None,
        limit: int = 20,
    ) -> str:
        """List/search TWCore IG conformance artifacts (StructureDefinition,
        ValueSet, CodeSystem, Profile, etc.) stored in ``fhir.artifacts``.

        Args:
            resource_type: Optional FHIR resource type filter
                (e.g. ``"StructureDefinition"``, ``"ValueSet"``).
            keyword: Optional full-text term matched against artifact id,
                canonical URL, name, title, and description.
            limit: Max rows (default 20, cap 100).

        Returns:
            JSON string with ``count`` and an ``artifacts`` list of summary rows.
        """
        limit = min(max(1, limit), 100)
        pkg = await self._default_pkg()
        if pkg is None:
            return json.dumps(
                {
                    "count": 0,
                    "artifacts": [],
                    "message": "找不到符合的 IG artifacts（或尚未匯入 TWCore IG package）",
                },
                ensure_ascii=False,
            )
        params: list = [pkg[0], pkg[1]]
        clauses: list[str] = ["package_id = $1", "package_version = $2"]
        if resource_type:
            params.append(resource_type)
            clauses.append(f"resource_type = ${len(params)}")
        if keyword:
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
        where = "WHERE " + " AND ".join(clauses)
        params.append(limit)
        sql = f"""SELECT {self._ARTIFACT_SUMMARY_COLS}
                  FROM fhir.artifacts
                  {where}
                  ORDER BY resource_type, name
                  LIMIT ${len(params)}"""
        async with self.pool.acquire() as conn:
            rows = await conn.fetch(sql, *params)
        if not rows:
            return json.dumps(
                {
                    "count": 0,
                    "artifacts": [],
                    "message": "找不到符合的 IG artifacts（或尚未匯入 TWCore IG package）",
                },
                ensure_ascii=False,
            )
        return json.dumps(
            {"count": len(rows), "artifacts": [dict(r) for r in rows]},
            ensure_ascii=False,
            default=str,
        )

    @cached(ttl=3600, prefix="tc.art.detail")
    async def get_artifact(self, identifier: str, include_raw: bool = False) -> str:
        """Look up one IG artifact by artifact_id, canonical_url, or artifact_key.

        Args:
            identifier: artifact_id (e.g. ``"Patient-twcore"``), canonical URL,
                or internal artifact_key.
            include_raw: When true, also return the full ``raw_json`` FHIR
                resource (can be large for StructureDefinitions). When false,
                only ``raw_json_available`` (bool) is reported.

        Returns:
            JSON string with the artifact metadata, or a ``not_found`` status.
        """
        pkg = await self._default_pkg()
        if pkg is None:
            return json.dumps(
                {"status": "not_found", "message": f"找不到 IG artifact: {identifier}"},
                ensure_ascii=False,
            )
        async with self.pool.acquire() as conn:
            row = await conn.fetchrow(
                """SELECT * FROM fhir.artifacts
                   WHERE package_id = $2 AND package_version = $3
                     AND (artifact_id = $1 OR canonical_url = $1 OR artifact_key = $1)
                   ORDER BY (artifact_id = $1) DESC
                   LIMIT 1""",
                identifier,
                pkg[0],
                pkg[1],
            )
        if not row:
            return json.dumps(
                {"status": "not_found", "message": f"找不到 IG artifact: {identifier}"},
                ensure_ascii=False,
            )
        data = dict(row)
        raw = data.pop("raw_json", None)
        if include_raw:
            data["raw_json"] = json.loads(raw) if isinstance(raw, str) else raw
        else:
            data["raw_json_available"] = raw is not None
        data["status_lookup"] = "success"
        return json.dumps(data, ensure_ascii=False, default=str)
