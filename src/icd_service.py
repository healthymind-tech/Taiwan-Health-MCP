"""
ICD-10-CM / ICD-10-PCS Service.
Data is pre-loaded into PostgreSQL by the data-loader (see loader/).

ICD-10-CM diagnoses are loaded from icd10cm-table-index-2025.zip.
ICD-10-PCS procedures are loaded separately if icd10pcs_tables_<year>.zip
is available — the icd.procedures table exists but may be empty.
"""

import json

import asyncpg

from cache import cached
from embedding_service import EmbeddingService
from utils import log_error, log_info


class ICDService:
    def __init__(
        self, pool: asyncpg.Pool, embedding_svc: EmbeddingService | None = None
    ):
        self.pool = pool
        self._embedding_svc = embedding_svc
        self._pcs_available = False

    async def initialize(self) -> None:
        async with self.pool.acquire() as conn:
            diag_count = await conn.fetchval("SELECT COUNT(*) FROM icd.diagnoses")
            proc_count = await conn.fetchval("SELECT COUNT(*) FROM icd.procedures")

        self._pcs_available = proc_count > 0

        if diag_count == 0:
            log_error("ICD diagnoses table is empty — run data-loader (--icd) first")
        else:
            log_info("ICD Service ready", diagnoses=diag_count, procedures=proc_count)

    @cached(ttl=86400, prefix="icd.search")
    async def search_codes(
        self, keyword: str, type: str = "all", limit: int = 3
    ) -> str:
        """Search ICD-10-CM diagnoses and/or ICD-10-PCS procedures by keyword.

        Args:
            keyword: Free-text search term (Chinese or English) or code prefix.
            type: Scope — ``"diagnosis"``, ``"procedure"``, or ``"all"``.
            limit: Number of closest matches per type to return (default 3, max 10).

        Returns:
            JSON string with ``diagnoses`` and/or ``procedures`` lists.
        """
        limit = min(max(1, limit), 10)
        vec = await self._embedding_svc.embed(keyword) if self._embedding_svc else None
        vec_str = f"[{','.join(str(x) for x in vec)}]" if vec else None
        results: dict = {}

        async with self.pool.acquire() as conn:
            if type in ("diagnosis", "all"):
                if vec_str:
                    rows = await conn.fetch(
                        """WITH fts AS (
                               SELECT code,
                                      ROW_NUMBER() OVER (ORDER BY ts_rank_cd(
                                          to_tsvector('simple', code || ' ' || COALESCE(name_zh,'') || ' ' || COALESCE(name_en,'')),
                                          plainto_tsquery('simple', $1)) DESC) AS rank
                               FROM icd.diagnoses
                               WHERE to_tsvector('simple', code || ' ' || COALESCE(name_zh,'') || ' ' || COALESCE(name_en,''))
                                     @@ plainto_tsquery('simple', $1)
                                  OR code ILIKE $2
                               LIMIT 20
                           ),
                           vec AS (
                               SELECT code,
                                      ROW_NUMBER() OVER (ORDER BY embedding <=> $3::halfvec) AS rank
                               FROM icd.diagnosis_embeddings
                               ORDER BY embedding <=> $3::halfvec LIMIT 20
                           ),
                           rrf AS (
                               SELECT COALESCE(f.code, v.code) AS code,
                                      COALESCE(1.0/(60+f.rank), 0.0) + COALESCE(1.0/(60+v.rank), 0.0) AS score
                               FROM fts f FULL OUTER JOIN vec v ON f.code = v.code
                           )
                           SELECT d.code, d.name_zh, d.name_en
                           FROM rrf JOIN icd.diagnoses d ON d.code = rrf.code
                           ORDER BY rrf.score DESC LIMIT $4""",
                        keyword,
                        f"{keyword}%",
                        vec_str,
                        limit,
                    )
                else:
                    rows = await conn.fetch(
                        """SELECT code, name_zh, name_en
                           FROM icd.diagnoses
                           WHERE to_tsvector('simple', code || ' ' || COALESCE(name_zh,'') || ' ' || COALESCE(name_en,''))
                                 @@ plainto_tsquery('simple', $1)
                              OR code ILIKE $2
                           ORDER BY code LIMIT $3""",
                        keyword,
                        f"{keyword}%",
                        limit,
                    )
                results["diagnoses"] = [dict(r) for r in rows]

            if type in ("procedure", "all"):
                if self._pcs_available:
                    rows = await conn.fetch(
                        """SELECT code, name_zh, name_en
                           FROM icd.procedures
                           WHERE to_tsvector('simple', code || ' ' || COALESCE(name_zh,'') || ' ' || COALESCE(name_en,''))
                                 @@ plainto_tsquery('simple', $1)
                              OR code ILIKE $2
                           ORDER BY code LIMIT $3""",
                        keyword,
                        f"{keyword}%",
                        limit,
                    )
                    results["procedures"] = [dict(r) for r in rows]
                else:
                    results["procedures"] = []
                    results["procedures_note"] = (
                        "ICD-10-PCS data not loaded. "
                        "Add icd10pcs_tables_<year>.zip to fhir-code/icd10pcs/ and re-run data-loader."
                    )

        if (
            not results.get("diagnoses")
            and not results.get("procedures")
            and "procedures_note" not in results
        ):
            return json.dumps(
                {"error": f"No results found for '{keyword}'."}, ensure_ascii=False
            )

        return json.dumps(results, ensure_ascii=False)

    @cached(ttl=86400, prefix="icd.complications")
    async def infer_complications(self, code: str) -> str:
        """Infer potential complications or specifics for an ICD-10 code.

        Uses the code hierarchy — expands parent codes to child codes and,
        if the code is already specific, lists sibling codes in the same category.

        Args:
            code: An ICD-10-CM code (e.g. ``"E11"`` or ``"E11.9"``).

        Returns:
            JSON string with ``potential_complications_or_specifics`` or
            ``related_codes`` depending on whether sub-codes were found.
        """
        code = code.upper().strip()
        async with self.pool.acquire() as conn:
            children = await conn.fetch(
                "SELECT code, name_zh FROM icd.diagnoses WHERE code LIKE $1 AND code != $2 ORDER BY code LIMIT 15",
                f"{code}%",
                code,
            )
            if children:
                return json.dumps(
                    {
                        "base_code": code,
                        "potential_complications_or_specifics": [
                            dict(r) for r in children
                        ],
                    },
                    ensure_ascii=False,
                )

            category = code.split(".")[0] if "." in code else code[:3]
            siblings = await conn.fetch(
                "SELECT code, name_zh FROM icd.diagnoses WHERE category = $1 AND code != $2 LIMIT 10",
                category,
                code,
            )
            return json.dumps(
                {
                    "message": f"Code {code} is specific. Showing related codes in category {category}:",
                    "related_codes": [dict(r) for r in siblings],
                },
                ensure_ascii=False,
            )

    @cached(ttl=86400, prefix="icd.nearby")
    async def get_nearby_codes(self, code: str) -> str:
        """Return the two preceding and two following ICD-10-CM codes.

        Args:
            code: The target ICD-10-CM code.

        Returns:
            JSON string with ``target`` and a ``nearby_options`` list
            containing codes sorted in alphabetical order.
        """
        code = code.upper().strip()
        async with self.pool.acquire() as conn:
            prev_rows = await conn.fetch(
                "SELECT code, name_zh, 'prev' AS rel FROM icd.diagnoses WHERE code < $1 ORDER BY code DESC LIMIT 2",
                code,
            )
            next_rows = await conn.fetch(
                "SELECT code, name_zh, 'next' AS rel FROM icd.diagnoses WHERE code > $1 ORDER BY code ASC LIMIT 2",
                code,
            )
        neighbors = [dict(r) for r in prev_rows] + [dict(r) for r in next_rows]
        neighbors.sort(key=lambda r: r["code"])
        return json.dumps(
            {"target": code, "nearby_options": neighbors}, ensure_ascii=False
        )

    @cached(ttl=86400, prefix="icd.category")
    async def browse_category(
        self, category: str | None = None, limit: int = 50
    ) -> str:
        """List ICD-10-CM codes within a category, or enumerate all categories.

        Args:
            category: Three-character category prefix (e.g. ``"E11"``).
                Pass ``None`` to list all distinct categories with counts.
            limit: Maximum codes to return when browsing a specific category
                (capped at 200).

        Returns:
            JSON string. Without *category*: ``{"total_categories", "categories"}``.
            With *category*: ``{"category", "total", "codes"}``.
        """
        async with self.pool.acquire() as conn:
            if not category:
                rows = await conn.fetch("""SELECT category,
                              MIN(name_zh) FILTER (WHERE LENGTH(code)=3) AS category_name_zh,
                              MIN(name_en) FILTER (WHERE LENGTH(code)=3) AS category_name_en,
                              COUNT(*) AS code_count
                       FROM icd.diagnoses
                       GROUP BY category
                       ORDER BY category""")
                return json.dumps(
                    {
                        "total_categories": len(rows),
                        "categories": [dict(r) for r in rows],
                    },
                    ensure_ascii=False,
                )

            rows = await conn.fetch(
                """SELECT code, name_zh, name_en
                   FROM icd.diagnoses
                   WHERE category = $1
                   ORDER BY code
                   LIMIT $2""",
                category.upper(),
                min(limit, 200),
            )
        if not rows:
            return json.dumps(
                {
                    "error": f"找不到 category '{category}'。使用 category=null 可列出所有分類。"
                },
                ensure_ascii=False,
            )
        return json.dumps(
            {
                "category": category.upper(),
                "total": len(rows),
                "codes": [dict(r) for r in rows],
            },
            ensure_ascii=False,
        )

    @cached(ttl=86400, prefix="icd.conflict")
    async def get_conflict_info(self, diagnosis_code: str, procedure_code: str) -> str:
        """Fetch full details for both a diagnosis and a procedure code for conflict analysis.

        Provides structured data so an LLM can identify clinical contraindications
        (e.g. a male-specific procedure code paired with a female diagnosis).

        Args:
            diagnosis_code: An ICD-10-CM code.
            procedure_code: An ICD-10-PCS code.

        Returns:
            JSON string with ``diagnosis_info``, ``procedure_info``, and an
            ``instruction`` field prompting the caller to analyse conflicts.
        """
        try:
            async with self.pool.acquire() as conn:
                diag = await conn.fetchrow(
                    "SELECT * FROM icd.diagnoses WHERE code = $1", diagnosis_code
                )
                proc = None
                proc_note = None
                if self._pcs_available:
                    proc = await conn.fetchrow(
                        "SELECT * FROM icd.procedures WHERE code = $1", procedure_code
                    )
                else:
                    proc_note = (
                        "ICD-10-PCS data not loaded — procedure lookup unavailable."
                    )

            return json.dumps(
                {
                    "diagnosis_info": (
                        dict(diag) if diag else f"Diagnosis {diagnosis_code} not found"
                    ),
                    "procedure_info": (
                        dict(proc)
                        if proc
                        else (proc_note or f"Procedure {procedure_code} not found")
                    ),
                    "instruction": "Analyze the above for potential contraindications or medical conflicts.",
                },
                ensure_ascii=False,
            )
        except Exception as e:
            log_error("get_conflict_info error", error=str(e))
            return json.dumps(
                {
                    "error": str(e),
                    "diagnosis_code": diagnosis_code,
                    "procedure_code": procedure_code,
                },
                ensure_ascii=False,
            )
