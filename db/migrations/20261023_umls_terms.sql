-- UMLS synonym store (2026-10-23) for the IG concept search — optional, needs a UMLS
-- licence. Idempotent; apply by hand after 20261022_ig_concept_search.sql, then upload the
-- UMLS file in admin → IG 套件庫 → 術語搜尋索引 and run umls_import.

BEGIN;

-- Optional UMLS Metathesaurus synonym store for the IG concept search (requires a UMLS
-- licence). Loaded by the umls_import job (source role ig/umls_metathesaurus): English
-- strings of SRL-0 vocabularies + SNOMEDCT_US, concepts with >= 2 distinct strings.
-- Used only to steer matching (query expansion, index-time CUI linking); UMLS strings are
-- never returned by a tool.
CREATE TABLE IF NOT EXISTS fhir.umls_terms (
    cui   TEXT NOT NULL,
    norm  TEXT NOT NULL,          -- conceptSearch/text.ts umlsNorm(str)
    str   TEXT NOT NULL,
    sab   TEXT NOT NULL,
    tty   TEXT NOT NULL,
    abbr  BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (cui, norm)
);
CREATE INDEX IF NOT EXISTS idx_fhir_umls_terms_norm ON fhir.umls_terms (norm);

CREATE TABLE IF NOT EXISTS fhir.umls_release (
    id          SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    release     TEXT NOT NULL,
    sabs        JSONB NOT NULL DEFAULT '[]'::jsonb,
    terms       INTEGER NOT NULL DEFAULT 0,
    concepts    INTEGER NOT NULL DEFAULT 0,
    source_file TEXT,
    loaded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;
