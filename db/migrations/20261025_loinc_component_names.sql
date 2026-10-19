-- LOINC analyte synonyms for search (2026-10-25). Idempotent; apply by hand after
-- 20261024_loinc_common_rank.sql, then re-run the LOINC import (admin → 醫療術語 → LOINC)
-- so the table is filled from the release zip (Loinc.csv RELATEDNAMES2 + the zh-CN
-- linguistic variant; written after the promote). Until then search_loinc ranks without
-- the synonyms.

BEGIN;

-- Other names of a LOINC component (analyte): "Uric acid" / 尿酸 for Urate, "FSH" /
-- 卵泡刺激素 for Follitropin. Built by loincComponentNames.ts; name_key is the normalised
-- lookup key (lower case, NFKC, Traditional script) search matches query n-grams against.
CREATE TABLE IF NOT EXISTS loinc.component_names (
    component    TEXT NOT NULL,             -- loinc.concepts.component (English)
    name         TEXT NOT NULL,
    lang         TEXT NOT NULL,             -- en | zh
    name_key     TEXT NOT NULL,
    PRIMARY KEY (component, name_key)
);
CREATE INDEX IF NOT EXISTS idx_loinc_component_names_key ON loinc.component_names (name_key);

-- Family lookups (the most common terms of an analyte) by component.
CREATE INDEX IF NOT EXISTS idx_loinc_concepts_component ON loinc.concepts (component);


COMMIT;
