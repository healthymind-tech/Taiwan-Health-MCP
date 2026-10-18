-- IG concept search (2026-10-22): concept term index over every installed IG
-- CodeSystem (+ supplements), content-addressed term vectors, mined thesaurus and
-- uploaded CodeSystem supplements. Idempotent; apply by hand on existing DBs, then
-- run the ig_concept_index job (admin console → IG → 概念搜尋索引) and ig_embed.

BEGIN;

-- IG concept-search index (fhir_normalize_code / search_medical_codes system=...).
-- Built from the CodeSystem resources in fhir.artifacts (nested concepts, every
-- designation language) plus CodeSystem supplements, by the ig_import job and the
-- ig_concept_index backfill job; embedded by the ig_embed job.
CREATE TABLE IF NOT EXISTS fhir.concept_index_cs (
    package_id      TEXT NOT NULL,
    package_version TEXT NOT NULL,
    cs_url          TEXT NOT NULL,
    cs_id           TEXT,
    cs_version      TEXT,
    title           TEXT,
    language        TEXT,
    concept_count   INTEGER NOT NULL DEFAULT 0,
    term_count      INTEGER NOT NULL DEFAULT 0,
    embed           BOOLEAN NOT NULL DEFAULT FALSE,
    supplements     JSONB NOT NULL DEFAULT '[]'::jsonb,
    signature       TEXT NOT NULL,
    built_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (package_id, package_version, cs_url),
    FOREIGN KEY (package_id, package_version)
        REFERENCES fhir.ig_packages (package_id, version) ON DELETE CASCADE
);

-- One row per concept: display + derived info (category, parents, links).
CREATE TABLE IF NOT EXISTS fhir.concept_index_concepts (
    package_id      TEXT NOT NULL,
    package_version TEXT NOT NULL,
    cs_url          TEXT NOT NULL,
    code            TEXT NOT NULL,
    display         TEXT,
    info            JSONB,
    PRIMARY KEY (package_id, package_version, cs_url, code),
    FOREIGN KEY (package_id, package_version, cs_url)
        REFERENCES fhir.concept_index_cs (package_id, package_version, cs_url) ON DELETE CASCADE
);

-- Searchable terms: display, designations (any language), supplement names, names
-- borrowed via property / ConceptMap links, string properties, short definitions.
-- text_hash = sha256(term) for terms that are embedded (key into concept_embeddings).
CREATE TABLE IF NOT EXISTS fhir.concept_index_terms (
    package_id      TEXT NOT NULL,
    package_version TEXT NOT NULL,
    cs_url          TEXT NOT NULL,
    code            TEXT NOT NULL,
    term            TEXT NOT NULL,
    lang            TEXT,
    kind            TEXT NOT NULL,
    source          TEXT,
    text_hash       TEXT,
    FOREIGN KEY (package_id, package_version, cs_url)
        REFERENCES fhir.concept_index_cs (package_id, package_version, cs_url) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_fhir_cit_cs
    ON fhir.concept_index_terms (package_id, package_version, cs_url);
CREATE INDEX IF NOT EXISTS idx_fhir_cit_hash
    ON fhir.concept_index_terms (text_hash) WHERE text_hash IS NOT NULL;

-- Content-addressed term vectors (same model/identity as every other *_embeddings
-- table). Searched by exact scan scoped to one CodeSystem — deliberately no HNSW index.
CREATE TABLE IF NOT EXISTS fhir.concept_embeddings (
    text_hash   TEXT PRIMARY KEY,
    embedding   halfvec(1024),
    source_hash TEXT,
    embedded_at TIMESTAMPTZ DEFAULT NOW()
);

-- Query-expansion thesaurus mined from SNOMED CT / LOINC (acronym -> expansion).
CREATE TABLE IF NOT EXISTS fhir.term_thesaurus (
    abbr      TEXT NOT NULL,
    expansion TEXT NOT NULL,
    source    TEXT NOT NULL,
    freq      INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (abbr, expansion)
);

-- CodeSystem supplements uploaded in the admin console (supplements shipped inside
-- IG packages stay in fhir.artifacts). Merged into the concept index of the
-- CodeSystem they supplement.
CREATE TABLE IF NOT EXISTS fhir.codesystem_supplements (
    url           TEXT NOT NULL,
    version       TEXT NOT NULL DEFAULT '',
    supplements   TEXT NOT NULL,
    name          TEXT,
    title         TEXT,
    concept_count INTEGER NOT NULL DEFAULT 0,
    raw_json      JSONB NOT NULL,
    uploaded_by   TEXT NOT NULL DEFAULT '',
    uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (url, version)
);

COMMIT;
