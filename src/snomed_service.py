"""
SNOMED CT Service — search, hierarchy traversal, ICD-10 mapping.
Data pre-loaded into PostgreSQL from International RF2 release by data-loader.
All concepts are English-only (International edition).
"""

from typing import Any

import asyncpg

from cache import cached
from embedding_service import EmbeddingService
from utils import log_error, log_info

# SNOMED type constants
FSN_TYPE = 900000000000003001  # Fully Specified Name
SYNONYM_TYPE = 900000000000013009  # Synonym
IS_A_TYPE = 116680003  # Is-a relationship

# Well-known top-level hierarchy concept IDs
HIERARCHY_ROOTS = {
    138875005: "SNOMED CT Concept",
    404684003: "Clinical finding",
    71388002: "Procedure",
    123037004: "Body structure",
    410607006: "Organism",
    105590001: "Substance",
    123038009: "Specimen",
    48176007: "Social context",
    243796009: "Situation with explicit context",
    272379006: "Event",
    900000000000441003: "SNOMED CT Model Component",
    373873005: "Pharmaceutical / biologic product",
    254291000: "Staging and scales",
    370115009: "Special concept",
    308916002: "Environment or geographical location",
}


class SNOMEDService:
    def __init__(
        self, pool: asyncpg.Pool, embedding_svc: EmbeddingService | None = None
    ):
        self.pool = pool
        self._embedding_svc = embedding_svc

    async def initialize(self) -> None:
        count = await self.pool.fetchval("SELECT COUNT(*) FROM snomed.concepts")
        if count == 0:
            log_error("SNOMED CT table empty — run data-loader (--snomed) first")
        else:
            log_info(f"SNOMEDService ready — {count:,} concepts")

    # ── search ─────────────────────────────────────────────────────────────

    @cached(ttl=3600, prefix="snomed:search")
    async def search_concepts(
        self,
        query: str,
        limit: int = 3,
        hierarchy_filter: int | None = None,
    ) -> list[dict[str, Any]]:
        """Full-text + semantic search across SNOMED CT descriptions.

        Returns the top *limit* closest matching concepts ranked by hybrid
        BM25 + vector similarity (default 3, max 10). Results include
        synonyms so 'heart attack' surfaces 'Myocardial infarction'.
        """
        limit = min(max(1, limit), 10)
        vec = await self._embedding_svc.embed(query) if self._embedding_svc else None
        vec_str = f"[{','.join(str(x) for x in vec)}]" if vec else None

        async with self.pool.acquire() as conn:
            if hierarchy_filter:
                # Filter to descendants — vector search scoped via descendant join
                if vec_str:
                    rows = await conn.fetch(
                        """
                        WITH RECURSIVE descendants AS (
                            SELECT concept_id FROM snomed.concepts WHERE concept_id = $3
                            UNION ALL
                            SELECT r.source_id
                            FROM snomed.relationships r
                            JOIN descendants d ON r.destination_id = d.concept_id
                            WHERE r.type_id = $4 AND r.active = TRUE
                        ),
                        fts AS (
                            SELECT d.concept_id,
                                   ROW_NUMBER() OVER (ORDER BY
                                       ts_rank(to_tsvector('english', d.term),
                                               plainto_tsquery('english', $1)) DESC) AS rank
                            FROM snomed.descriptions d
                            JOIN descendants desc ON desc.concept_id = d.concept_id
                            WHERE d.active = TRUE
                              AND to_tsvector('english', d.term) @@ plainto_tsquery('english', $1)
                            LIMIT 20
                        ),
                        vec AS (
                            SELECT e.concept_id,
                                   ROW_NUMBER() OVER (ORDER BY e.embedding <=> $5::halfvec) AS rank
                            FROM snomed.concept_embeddings e
                            JOIN descendants desc ON desc.concept_id = e.concept_id
                            ORDER BY e.embedding <=> $5::halfvec LIMIT 20
                        ),
                        rrf AS (
                            SELECT COALESCE(f.concept_id, v.concept_id) AS concept_id,
                                   COALESCE(1.0/(60+f.rank), 0.0) + COALESCE(1.0/(60+v.rank), 0.0) AS score
                            FROM fts f FULL OUTER JOIN vec v ON f.concept_id = v.concept_id
                        )
                        SELECT d.concept_id, d.term AS preferred_term, d.type_id, c.active
                        FROM rrf
                        JOIN snomed.descriptions d ON d.concept_id = rrf.concept_id
                            AND d.active = TRUE
                        JOIN snomed.concepts c ON c.concept_id = rrf.concept_id
                        ORDER BY rrf.score DESC,
                                 CASE WHEN d.type_id = $6 THEN 0 ELSE 1 END
                        LIMIT $2
                        """,
                        query,
                        limit,
                        hierarchy_filter,
                        IS_A_TYPE,
                        vec_str,
                        FSN_TYPE,
                    )
                else:
                    rows = await conn.fetch(
                        """
                        WITH RECURSIVE descendants AS (
                            SELECT concept_id FROM snomed.concepts WHERE concept_id = $3
                            UNION ALL
                            SELECT r.source_id
                            FROM snomed.relationships r
                            JOIN descendants d ON r.destination_id = d.concept_id
                            WHERE r.type_id = $4 AND r.active = TRUE
                        )
                        SELECT d.concept_id, d.term AS preferred_term, d.type_id, c.active
                        FROM snomed.descriptions d
                        JOIN snomed.concepts c ON c.concept_id = d.concept_id
                        JOIN descendants desc ON desc.concept_id = d.concept_id
                        WHERE d.active = TRUE
                          AND to_tsvector('english', d.term) @@ plainto_tsquery('english', $1)
                        ORDER BY
                            CASE WHEN d.type_id = $5 THEN 0 ELSE 1 END,
                            ts_rank(to_tsvector('english', d.term), plainto_tsquery('english', $1)) DESC
                        LIMIT $2
                        """,
                        query,
                        limit,
                        hierarchy_filter,
                        IS_A_TYPE,
                        FSN_TYPE,
                    )
            else:
                if vec_str:
                    rows = await conn.fetch(
                        """
                        WITH fts AS (
                            SELECT d.concept_id,
                                   ROW_NUMBER() OVER (ORDER BY
                                       ts_rank(to_tsvector('english', d.term),
                                               plainto_tsquery('english', $1)) DESC) AS rank
                            FROM snomed.descriptions d
                            WHERE d.active = TRUE
                              AND to_tsvector('english', d.term) @@ plainto_tsquery('english', $1)
                            LIMIT 20
                        ),
                        vec AS (
                            SELECT concept_id,
                                   ROW_NUMBER() OVER (ORDER BY embedding <=> $3::halfvec) AS rank
                            FROM snomed.concept_embeddings
                            ORDER BY embedding <=> $3::halfvec LIMIT 20
                        ),
                        rrf AS (
                            SELECT COALESCE(f.concept_id, v.concept_id) AS concept_id,
                                   COALESCE(1.0/(60+f.rank), 0.0) + COALESCE(1.0/(60+v.rank), 0.0) AS score
                            FROM fts f FULL OUTER JOIN vec v ON f.concept_id = v.concept_id
                        )
                        SELECT d.concept_id, d.term AS preferred_term, d.type_id, c.active
                        FROM rrf
                        JOIN snomed.descriptions d ON d.concept_id = rrf.concept_id
                            AND d.active = TRUE
                        JOIN snomed.concepts c ON c.concept_id = rrf.concept_id
                        ORDER BY rrf.score DESC,
                                 CASE WHEN d.type_id = $4 THEN 0 ELSE 1 END
                        LIMIT $2
                        """,
                        query,
                        limit,
                        vec_str,
                        FSN_TYPE,
                    )
                else:
                    rows = await conn.fetch(
                        """
                        SELECT d.concept_id, d.term AS preferred_term, d.type_id, c.active
                        FROM snomed.descriptions d
                        JOIN snomed.concepts c ON c.concept_id = d.concept_id
                        WHERE d.active = TRUE
                          AND to_tsvector('english', d.term) @@ plainto_tsquery('english', $1)
                        ORDER BY
                            CASE WHEN d.type_id = $3 THEN 0 ELSE 1 END,
                            ts_rank(to_tsvector('english', d.term), plainto_tsquery('english', $1)) DESC
                        LIMIT $2
                        """,
                        query,
                        limit,
                        FSN_TYPE,
                    )

        # Deduplicate to one result per concept_id (prefer FSN)
        seen: dict[int, dict] = {}
        for row in rows:
            cid = row["concept_id"]
            if cid not in seen or row["type_id"] == FSN_TYPE:
                seen[cid] = {
                    "concept_id": cid,
                    "preferred_term": row["preferred_term"],
                    "term_type": "FSN" if row["type_id"] == FSN_TYPE else "Synonym",
                    "active": row["active"],
                }
        return list(seen.values())[:limit]

    # ── concept detail ──────────────────────────────────────────────────────

    @cached(ttl=7200, prefix="snomed:concept")
    async def get_concept(self, concept_id: int) -> dict[str, Any] | None:
        """Return full details for a single SNOMED concept."""
        async with self.pool.acquire() as conn:
            concept = await conn.fetchrow(
                "SELECT * FROM snomed.concepts WHERE concept_id = $1",
                concept_id,
            )
            if concept is None:
                return None

            descriptions = await conn.fetch(
                """SELECT term, type_id FROM snomed.descriptions
                   WHERE concept_id = $1 AND active = TRUE
                   ORDER BY CASE WHEN type_id = $2 THEN 0 ELSE 1 END""",
                concept_id,
                FSN_TYPE,
            )

            # Parents (direct IS-A destinations)
            parents = await conn.fetch(
                """SELECT r.destination_id AS parent_id, d.term AS parent_term
                   FROM snomed.relationships r
                   LEFT JOIN snomed.descriptions d ON d.concept_id = r.destination_id
                       AND d.type_id = $2 AND d.active = TRUE
                   WHERE r.source_id = $1 AND r.type_id = $3 AND r.active = TRUE
                   LIMIT 20""",
                concept_id,
                FSN_TYPE,
                IS_A_TYPE,
            )

            # ICD-10 mappings
            icd_maps = await conn.fetch(
                """SELECT map_target, map_rule, map_advice, map_priority, map_group
                   FROM snomed.icd10_map
                   WHERE referenced_component_id = $1 AND active = TRUE
                   ORDER BY map_group, map_priority""",
                concept_id,
            )

        fsn = next((r["term"] for r in descriptions if r["type_id"] == FSN_TYPE), None)
        synonyms = [r["term"] for r in descriptions if r["type_id"] == SYNONYM_TYPE]

        return {
            "concept_id": concept["concept_id"],
            "fsn": fsn,
            "synonyms": synonyms,
            "active": concept["active"],
            "parents": [
                {"concept_id": p["parent_id"], "fsn": p["parent_term"]} for p in parents
            ],
            "icd10_maps": [
                {
                    "icd10_code": m["map_target"],
                    "rule": m["map_rule"],
                    "advice": m["map_advice"],
                    "priority": m["map_priority"],
                    "group": m["map_group"],
                }
                for m in icd_maps
            ],
        }

    # ── hierarchy traversal ─────────────────────────────────────────────────

    @cached(ttl=7200, prefix="snomed:children")
    async def get_children(
        self, concept_id: int, limit: int = 50
    ) -> list[dict[str, Any]]:
        """Return direct children (concepts with IS-A relationship to this concept)."""
        async with self.pool.acquire() as conn:
            rows = await conn.fetch(
                """SELECT r.source_id AS child_id, d.term AS child_term
                   FROM snomed.relationships r
                   LEFT JOIN snomed.descriptions d ON d.concept_id = r.source_id
                       AND d.type_id = $2 AND d.active = TRUE
                   WHERE r.destination_id = $1 AND r.type_id = $3 AND r.active = TRUE
                   LIMIT $4""",
                concept_id,
                FSN_TYPE,
                IS_A_TYPE,
                limit,
            )
        return [{"concept_id": r["child_id"], "fsn": r["child_term"]} for r in rows]

    @cached(ttl=7200, prefix="snomed:ancestors")
    async def get_ancestors(
        self, concept_id: int, max_depth: int = 10
    ) -> list[dict[str, Any]]:
        """Return all ancestors via recursive IS-A traversal (breadth-first up to max_depth)."""
        async with self.pool.acquire() as conn:
            rows = await conn.fetch(
                """
                WITH RECURSIVE ancestors(concept_id, depth) AS (
                    SELECT destination_id, 1
                    FROM snomed.relationships
                    WHERE source_id = $1 AND type_id = $3 AND active = TRUE
                    UNION
                    SELECT r.destination_id, a.depth + 1
                    FROM snomed.relationships r
                    JOIN ancestors a ON r.source_id = a.concept_id
                    WHERE r.type_id = $3 AND r.active = TRUE AND a.depth < $2
                )
                SELECT DISTINCT a.concept_id, a.depth, d.term AS fsn
                FROM ancestors a
                LEFT JOIN snomed.descriptions d ON d.concept_id = a.concept_id
                    AND d.type_id = $4 AND d.active = TRUE
                ORDER BY a.depth, a.concept_id
                """,
                concept_id,
                max_depth,
                IS_A_TYPE,
                FSN_TYPE,
            )
        return [
            {"concept_id": r["concept_id"], "fsn": r["fsn"], "depth": r["depth"]}
            for r in rows
        ]

    # ── non-IS-A relationships ──────────────────────────────────────────────

    @cached(ttl=7200, prefix="snomed:rels")
    async def get_relationships(
        self,
        concept_id: int,
        relationship_type_id: int | None = None,
    ) -> list[dict[str, Any]]:
        """
        Return non-IS-A relationships for a concept.
        Optionally filter by a specific relationship type SNOMED concept ID.
        Each result includes the human-readable relationship type name.
        """
        async with self.pool.acquire() as conn:
            if relationship_type_id:
                rows = await conn.fetch(
                    """
                    SELECT r.type_id, r.destination_id,
                           dt.term AS relationship_type,
                           dd.term AS target_term
                    FROM snomed.relationships r
                    LEFT JOIN snomed.descriptions dt
                        ON dt.concept_id = r.type_id AND dt.type_id = $4 AND dt.active = TRUE
                    LEFT JOIN snomed.descriptions dd
                        ON dd.concept_id = r.destination_id AND dd.type_id = $4 AND dd.active = TRUE
                    WHERE r.source_id = $1 AND r.active = TRUE AND r.type_id = $2
                    ORDER BY r.type_id, r.destination_id
                    LIMIT 100
                    """,
                    concept_id,
                    relationship_type_id,
                    IS_A_TYPE,
                    FSN_TYPE,
                )
            else:
                rows = await conn.fetch(
                    """
                    SELECT r.type_id, r.destination_id,
                           dt.term AS relationship_type,
                           dd.term AS target_term
                    FROM snomed.relationships r
                    LEFT JOIN snomed.descriptions dt
                        ON dt.concept_id = r.type_id AND dt.type_id = $3 AND dt.active = TRUE
                    LEFT JOIN snomed.descriptions dd
                        ON dd.concept_id = r.destination_id AND dd.type_id = $3 AND dd.active = TRUE
                    WHERE r.source_id = $1 AND r.active = TRUE AND r.type_id != $2
                    ORDER BY r.type_id, r.destination_id
                    LIMIT 100
                    """,
                    concept_id,
                    IS_A_TYPE,
                    FSN_TYPE,
                )

        # Group by relationship type
        by_type: dict[str, list] = {}
        for r in rows:
            type_name = r["relationship_type"] or str(r["type_id"])
            by_type.setdefault(type_name, []).append(
                {
                    "concept_id": r["destination_id"],
                    "term": r["target_term"],
                }
            )

        return [
            {
                "relationship_type": k,
                "type_concept_id": next(
                    r["type_id"]
                    for r in rows
                    if (r["relationship_type"] or str(r["type_id"])) == k
                ),
                "targets": v,
            }
            for k, v in by_type.items()
        ]

    # ── ICD-10 ↔ SNOMED mapping ─────────────────────────────────────────────

    @cached(ttl=7200, prefix="snomed:icd2sct")
    async def map_icd_to_snomed(self, icd_code: str) -> list[dict[str, Any]]:
        """Find SNOMED concepts that map to the given ICD-10 code."""
        async with self.pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT m.referenced_component_id AS concept_id,
                       m.map_rule, m.map_advice, m.map_priority, m.map_group,
                       d.term AS fsn
                FROM snomed.icd10_map m
                LEFT JOIN snomed.descriptions d ON d.concept_id = m.referenced_component_id
                    AND d.type_id = $2 AND d.active = TRUE
                WHERE m.map_target = $1 AND m.active = TRUE
                ORDER BY m.map_group, m.map_priority
                """,
                icd_code.upper(),
                FSN_TYPE,
            )
        return [
            {
                "concept_id": r["concept_id"],
                "fsn": r["fsn"],
                "icd10_code": icd_code.upper(),
                "map_rule": r["map_rule"],
                "map_advice": r["map_advice"],
                "map_priority": r["map_priority"],
                "map_group": r["map_group"],
            }
            for r in rows
        ]

    @cached(ttl=7200, prefix="snomed:sct2icd")
    async def map_snomed_to_icd(self, concept_id: int) -> list[dict[str, Any]]:
        """Return all ICD-10 codes that a SNOMED concept maps to."""
        async with self.pool.acquire() as conn:
            rows = await conn.fetch(
                """SELECT map_target, map_rule, map_advice, map_priority, map_group
                   FROM snomed.icd10_map
                   WHERE referenced_component_id = $1 AND active = TRUE
                     AND map_target IS NOT NULL AND map_target <> ''
                   ORDER BY map_group, map_priority""",
                concept_id,
            )
        return [
            {
                "icd10_code": r["map_target"],
                "map_rule": r["map_rule"],
                "map_advice": r["map_advice"],
                "map_priority": r["map_priority"],
                "map_group": r["map_group"],
            }
            for r in rows
        ]
