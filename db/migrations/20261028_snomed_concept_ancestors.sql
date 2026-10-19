-- SNOMED CT is-a ancestor closure (2026-10-28) for search_snomed_concept's hierarchy_filter.
-- Idempotent; apply by hand. Filled here from the relationships already loaded (~30 s, ~80 MB
-- for the International edition — no re-import needed) and rebuilt by every later snomed_import
-- (loaders/snomed.ts SNOMED_ANCESTORS_REBUILD_SQL — keep the INSERT below in step with it).
--
-- One row per active concept: its proper ancestors over the active (inferred) is-a
-- relationships, sorted ('{}' for the root). The search tests a candidate's membership in a
-- hierarchy with one primary-key probe (ancestor_ids @> ARRAY[filter]) instead of expanding the
-- filter's descendants (tens of thousands of rows) on every call. Until it is filled the search
-- falls back to expanding the descendants (correct, slower).

BEGIN;

CREATE TABLE IF NOT EXISTS snomed.concept_ancestors (
    concept_id   BIGINT PRIMARY KEY,
    ancestor_ids BIGINT[] NOT NULL
);

SET LOCAL work_mem = '256MB';
SET LOCAL enable_nestloop = off;

INSERT INTO snomed.concept_ancestors (concept_id, ancestor_ids)
WITH RECURSIVE isa AS MATERIALIZED (
  SELECT source_id AS s, destination_id AS d FROM snomed.relationships
   WHERE type_id = 116680003 AND active = TRUE AND source_id <> destination_id
),
closure (s, d) AS (
  SELECT s, d FROM isa
  UNION
  SELECT c.s, i.d FROM closure c JOIN isa i ON i.s = c.d
)
SELECT k.concept_id, COALESCE(array_agg(c.d ORDER BY c.d) FILTER (WHERE c.d IS NOT NULL), '{}'::bigint[])
  FROM snomed.concepts k LEFT JOIN closure c ON c.s = k.concept_id
 WHERE NOT EXISTS (SELECT 1 FROM snomed.concept_ancestors)
 GROUP BY k.concept_id;

COMMIT;

ANALYZE snomed.concept_ancestors;
