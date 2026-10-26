-- Index snomed.icd10_map by source concept: the record checks' code-grounding comparison
-- (node-server/src/grounding/snomedChinese.ts) and query_snomed_mapping look maps up by
-- referenced_component_id; without it each lookup scans the table (correct, only slower).
-- Optional, idempotent; survives the TRUNCATE of a SNOMED re-import.
CREATE INDEX IF NOT EXISTS idx_snomed_map_source ON snomed.icd10_map (referenced_component_id);
