"""
TWCore Service — Taiwan Core Implementation Guide CodeSystem lookup.
Data pre-loaded into PostgreSQL from package.tgz by data-loader.
Falls back to live TWCore API fetch if a CodeSystem is missing.
"""

import json
from typing import Dict, List, Optional, Tuple

import asyncpg
import httpx

from cache import cached
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
    def __init__(self, pool: asyncpg.Pool):
        self.pool = pool

    async def initialize(self) -> None:
        count = await self.pool.fetchval("SELECT COUNT(*) FROM twcore.codesystems")
        if count == 0:
            log_error(
                "TWCore table empty — run data-loader (package.tgz) first; live fetch will be used as fallback"
            )
        else:
            log_info(f"TWCore Service ready ({count} CodeSystems in DB)")

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
        entry = next((e for e in CODESYSTEM_REGISTRY if e["id"] == cs_id), None)
        concepts = data.get("concept", [])
        async with self.pool.acquire() as conn:
            await conn.execute(
                """INSERT INTO twcore.codesystems (cs_id, name, category, fetched_at, concept_count)
                   VALUES ($1,$2,$3,NOW(),$4)
                   ON CONFLICT (cs_id) DO UPDATE SET fetched_at=NOW(), concept_count=$4""",
                cs_id,
                entry["name"] if entry else cs_id,
                entry["category"] if entry else "unknown",
                len(concepts),
            )
            await conn.execute("DELETE FROM twcore.concepts WHERE cs_id = $1", cs_id)
            await conn.executemany(
                "INSERT INTO twcore.concepts (cs_id, code, display) VALUES ($1,$2,$3)",
                [(cs_id, c.get("code", ""), c.get("display", "")) for c in concepts],
            )

    # ------------------------------------------------------------------ #
    #  Public methods                                                       #
    # ------------------------------------------------------------------ #

    @cached(ttl=86400, prefix="tc.list")
    async def list_codesystems(self, category: str = "all") -> str:
        """List all registered TWCore CodeSystems, optionally filtered by category.

        Args:
            category: Category filter — ``"medication"``, ``"diagnosis"``,
                ``"organization"``, ``"administrative"``, or ``"all"``.

        Returns:
            JSON string with ``total`` count and a ``categories`` dict grouping
            CodeSystems by localised category name.
        """
        groups: dict = {}
        for entry in CODESYSTEM_REGISTRY:
            if category != "all" and entry["category"] != category:
                continue
            cat = CATEGORY_NAMES.get(entry["category"], entry["category"])
            groups.setdefault(cat, []).append(
                {
                    "id": entry["id"],
                    "name": entry["name"],
                    "json_url": f"{TWCORE_BASE_URL}/CodeSystem-{entry['id']}.json",
                }
            )
        return json.dumps(
            {"total": sum(len(v) for v in groups.values()), "categories": groups},
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
        async with self.pool.acquire() as conn:
            for cs_id in codesystem_ids:
                # Ensure this CS is loaded
                exists = await conn.fetchval(
                    "SELECT 1 FROM twcore.codesystems WHERE cs_id = $1", cs_id
                )
                if not exists:
                    await self._live_fetch(cs_id)

                rows = await conn.fetch(
                    """SELECT c.code, c.display, cs.name
                       FROM twcore.concepts c
                       JOIN twcore.codesystems cs ON c.cs_id = cs.cs_id
                       WHERE c.cs_id = $1
                         AND (to_tsvector('simple', COALESCE(c.code,'') || ' ' || COALESCE(c.display,''))
                              @@ plainto_tsquery('simple', $2)
                              OR c.code ILIKE $3)
                       LIMIT $4""",
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
        async with self.pool.acquire() as conn:
            exists = await conn.fetchval(
                "SELECT 1 FROM twcore.codesystems WHERE cs_id = $1", codesystem_id
            )
            if not exists:
                await self._live_fetch(codesystem_id)

            row = await conn.fetchrow(
                """SELECT c.code, c.display, cs.name
                   FROM twcore.concepts c
                   JOIN twcore.codesystems cs ON c.cs_id = cs.cs_id
                   WHERE c.cs_id = $1 AND UPPER(c.code) = UPPER($2)""",
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
                "fhir_coding": {
                    "system": f"{TWCORE_BASE_URL}/CodeSystem-{codesystem_id}",
                    "code": row["code"],
                    "display": row["display"],
                },
            },
            ensure_ascii=False,
        )
