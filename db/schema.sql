-- Taiwan Health MCP - PostgreSQL Schema
-- Run automatically by postgres container on first init

-- ============================================================
-- PGVECTOR EXTENSION (required for semantic / hybrid search)
-- ============================================================
CREATE EXTENSION IF NOT EXISTS vector;

-- ============================================================
-- AUDIT
-- ============================================================
CREATE SCHEMA IF NOT EXISTS audit;

CREATE TABLE IF NOT EXISTS audit.query_log (
    id          BIGSERIAL PRIMARY KEY,
    ts          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    tool_name   TEXT        NOT NULL,
    params_hash TEXT        NOT NULL,
    duration_ms INTEGER,
    status      TEXT        CHECK (status IN ('success', 'error')),
    error_msg   TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_ts   ON audit.query_log (ts);
CREATE INDEX IF NOT EXISTS idx_audit_tool ON audit.query_log (tool_name);


-- ============================================================
-- ICD-10
-- ============================================================
CREATE SCHEMA IF NOT EXISTS icd;

CREATE TABLE IF NOT EXISTS icd.diagnoses (
    code        TEXT PRIMARY KEY,
    name_en     TEXT,
    name_zh     TEXT,
    category    TEXT    -- first 3 chars of code
);

CREATE TABLE IF NOT EXISTS icd.procedures (
    code        TEXT PRIMARY KEY,
    name_en     TEXT,
    name_zh     TEXT
);

CREATE INDEX IF NOT EXISTS idx_icd_diag_category ON icd.diagnoses (category);
CREATE INDEX IF NOT EXISTS idx_icd_diag_fts ON icd.diagnoses
    USING GIN (to_tsvector('simple',
        COALESCE(code,'') || ' ' || COALESCE(name_zh,'') || ' ' || COALESCE(name_en,'')));
CREATE INDEX IF NOT EXISTS idx_icd_proc_fts ON icd.procedures
    USING GIN (to_tsvector('simple',
        COALESCE(code,'') || ' ' || COALESCE(name_zh,'') || ' ' || COALESCE(name_en,'')));

-- Embedding table for hybrid search (diagnoses only; PCS is rarely searched semantically)
CREATE TABLE IF NOT EXISTS icd.diagnosis_embeddings (
    code        TEXT PRIMARY KEY,
    embedding   halfvec(1024),
    embedded_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_icd_diag_emb_hnsw ON icd.diagnosis_embeddings
    USING hnsw (embedding halfvec_cosine_ops);

-- ============================================================
-- HEALTH FOOD (Taiwan FDA)
-- ============================================================
CREATE SCHEMA IF NOT EXISTS health_food;

CREATE TABLE IF NOT EXISTS health_food.items (
    permit_no       TEXT PRIMARY KEY,
    name            TEXT,
    applicant       TEXT,
    benefit_claims  TEXT,
    valid_from      TEXT,
    valid_to        TEXT,
    category        TEXT
);

CREATE TABLE IF NOT EXISTS health_food.sync_meta (
    key         TEXT PRIMARY KEY,
    value       TEXT,
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hf_fts ON health_food.items
    USING GIN (to_tsvector('simple',
        COALESCE(name,'') || ' ' || COALESCE(benefit_claims,'')));

-- Embedding table for hybrid search
CREATE TABLE IF NOT EXISTS health_food.item_embeddings (
    permit_no   TEXT PRIMARY KEY,
    embedding   halfvec(1024),
    embedded_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_hf_emb_hnsw ON health_food.item_embeddings
    USING hnsw (embedding halfvec_cosine_ops);


-- ============================================================
-- FOOD NUTRITION (Taiwan FDA)
-- ============================================================
CREATE SCHEMA IF NOT EXISTS food_nutrition;

-- Nutrition data is in long/narrow format: one row per food+nutrient measurement
CREATE TABLE IF NOT EXISTS food_nutrition.measurements (
    id              SERIAL PRIMARY KEY,
    food_category   TEXT,
    sample_name     TEXT,
    common_name     TEXT,
    english_name    TEXT,
    nutrient_item   TEXT,
    content_per_100g TEXT,
    content_unit    TEXT,
    nutrient_category TEXT
);

CREATE TABLE IF NOT EXISTS food_nutrition.ingredients (
    id              SERIAL PRIMARY KEY,
    name_zh         TEXT,
    name_en         TEXT,
    major_category  TEXT,
    sub_category    TEXT,
    note            TEXT
);

CREATE TABLE IF NOT EXISTS food_nutrition.sync_meta (
    key         TEXT PRIMARY KEY,
    value       TEXT,
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fn_sample ON food_nutrition.measurements (sample_name);
CREATE INDEX IF NOT EXISTS idx_fn_fts ON food_nutrition.measurements
    USING GIN (to_tsvector('simple',
        COALESCE(sample_name,'') || ' ' || COALESCE(common_name,'') || ' ' || COALESCE(english_name,'')));
CREATE INDEX IF NOT EXISTS idx_fn_ing_fts ON food_nutrition.ingredients
    USING GIN (to_tsvector('simple', COALESCE(name_zh,'') || ' ' || COALESCE(name_en,'')));

-- Embedding table for hybrid search (food-level, not measurement-level)
-- Default dimension 1024 matches OLLAMA_EMBED_DIMENSIONS=1024 (qwen3-embedding:0.6b).
-- To switch models, set OLLAMA_EMBED_DIMENSIONS to the new size and re-run:
--   docker compose run --rm data-loader --embed
-- The loader will ALTER TABLE all embedding columns to the new dimension automatically.
CREATE TABLE IF NOT EXISTS food_nutrition.food_embeddings (
    sample_name  TEXT PRIMARY KEY,
    embedding    halfvec(1024),
    embedded_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_fn_emb_hnsw ON food_nutrition.food_embeddings
    USING hnsw (embedding halfvec_cosine_ops);

-- Embedding table for food_nutrition.ingredients
CREATE TABLE IF NOT EXISTS food_nutrition.ingredient_embeddings (
    id           INTEGER PRIMARY KEY,
    embedding    halfvec(1024),
    embedded_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_fn_ing_emb_hnsw ON food_nutrition.ingredient_embeddings
    USING hnsw (embedding halfvec_cosine_ops);


-- ============================================================
-- LOINC
-- ============================================================
CREATE SCHEMA IF NOT EXISTS loinc;

CREATE TABLE IF NOT EXISTS loinc.concepts (
    loinc_num           TEXT PRIMARY KEY,
    component           TEXT,
    property            TEXT,
    time_aspect         TEXT,
    system              TEXT,
    scale_type          TEXT,
    method_type         TEXT,
    long_common_name    TEXT,
    shortname           TEXT,
    class               TEXT,
    classtype           SMALLINT,
    status              TEXT,
    consumer_name       TEXT,
    -- Taiwan-specific additions
    name_zh             TEXT,
    common_name_zh      TEXT,
    specimen_type       TEXT,
    unit                TEXT
);

CREATE TABLE IF NOT EXISTS loinc.reference_ranges (
    id              SERIAL PRIMARY KEY,
    loinc_num       TEXT REFERENCES loinc.concepts (loinc_num) ON DELETE CASCADE,
    age_min         INTEGER,
    age_max         INTEGER,
    gender          TEXT,
    range_low       NUMERIC,
    range_high      NUMERIC,
    unit            TEXT,
    interpretation  TEXT
);

CREATE INDEX IF NOT EXISTS idx_loinc_class     ON loinc.concepts (class);
CREATE INDEX IF NOT EXISTS idx_loinc_ref_num   ON loinc.reference_ranges (loinc_num);
CREATE INDEX IF NOT EXISTS idx_loinc_fts ON loinc.concepts
    USING GIN (to_tsvector('simple',
        COALESCE(loinc_num,'') || ' ' || COALESCE(long_common_name,'') || ' ' ||
        COALESCE(shortname,'') || ' ' || COALESCE(name_zh,'') || ' ' || COALESCE(common_name_zh,'')));

-- Embedding table for hybrid search
CREATE TABLE IF NOT EXISTS loinc.concept_embeddings (
    loinc_num   TEXT PRIMARY KEY,
    embedding   halfvec(1024),
    embedded_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_loinc_emb_hnsw ON loinc.concept_embeddings
    USING hnsw (embedding halfvec_cosine_ops);


-- ============================================================
-- CLINICAL GUIDELINE
-- ============================================================
CREATE SCHEMA IF NOT EXISTS guideline;

CREATE TABLE IF NOT EXISTS guideline.disease_guidelines (
    id                  SERIAL PRIMARY KEY,
    icd_code            TEXT NOT NULL,
    disease_name_zh     TEXT NOT NULL,
    disease_name_en     TEXT,
    guideline_title     TEXT NOT NULL,
    guideline_source    TEXT,
    publication_year    INTEGER,
    guideline_summary   TEXT
);

CREATE TABLE IF NOT EXISTS guideline.diagnostic_recommendations (
    id                  SERIAL PRIMARY KEY,
    guideline_id        INTEGER REFERENCES guideline.disease_guidelines (id) ON DELETE CASCADE,
    step_order          INTEGER,
    recommendation_type TEXT,
    description         TEXT,
    evidence_level      TEXT
);

CREATE TABLE IF NOT EXISTS guideline.medication_recommendations (
    id                  SERIAL PRIMARY KEY,
    guideline_id        INTEGER REFERENCES guideline.disease_guidelines (id) ON DELETE CASCADE,
    line_of_therapy     TEXT,
    medication_class    TEXT,
    medication_examples TEXT,
    dosage_guidance     TEXT,
    contraindications   TEXT,
    evidence_level      TEXT
);

CREATE TABLE IF NOT EXISTS guideline.test_recommendations (
    id              SERIAL PRIMARY KEY,
    guideline_id    INTEGER REFERENCES guideline.disease_guidelines (id) ON DELETE CASCADE,
    test_category   TEXT,
    test_name       TEXT,
    loinc_code      TEXT,
    frequency       TEXT,
    indication      TEXT,
    evidence_level  TEXT
);

CREATE TABLE IF NOT EXISTS guideline.treatment_goals (
    id                  SERIAL PRIMARY KEY,
    guideline_id        INTEGER REFERENCES guideline.disease_guidelines (id) ON DELETE CASCADE,
    goal_type           TEXT,
    target_parameter    TEXT,
    target_value        TEXT,
    timeframe           TEXT
);

CREATE INDEX IF NOT EXISTS idx_gl_icd_code    ON guideline.disease_guidelines (icd_code);
CREATE INDEX IF NOT EXISTS idx_gl_name_fts    ON guideline.disease_guidelines
    USING GIN (to_tsvector('simple', COALESCE(disease_name_zh,'') || ' ' || COALESCE(disease_name_en,'')));

-- Embedding table for hybrid search
CREATE TABLE IF NOT EXISTS guideline.guideline_embeddings (
    id          INTEGER PRIMARY KEY,
    embedding   halfvec(1024),
    embedded_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_gl_emb_hnsw ON guideline.guideline_embeddings
    USING hnsw (embedding halfvec_cosine_ops);


-- ============================================================
-- TWCORE IG
-- ============================================================
CREATE SCHEMA IF NOT EXISTS twcore;

CREATE TABLE IF NOT EXISTS twcore.codesystems (
    cs_id           TEXT PRIMARY KEY,
    name            TEXT,
    category        TEXT,
    fetched_at      TIMESTAMPTZ,
    concept_count   INTEGER
);

CREATE TABLE IF NOT EXISTS twcore.concepts (
    id          SERIAL PRIMARY KEY,
    cs_id       TEXT REFERENCES twcore.codesystems (cs_id) ON DELETE CASCADE,
    code        TEXT NOT NULL,
    display     TEXT,
    definition  TEXT
);

CREATE INDEX IF NOT EXISTS idx_tc_cs_id ON twcore.concepts (cs_id);
CREATE INDEX IF NOT EXISTS idx_tc_code  ON twcore.concepts (code);
CREATE INDEX IF NOT EXISTS idx_tc_fts   ON twcore.concepts
    USING GIN (to_tsvector('simple',
        COALESCE(code,'') || ' ' || COALESCE(display,'')));


-- ============================================================
-- SNOMED CT  (populated by data-loader in Phase 3)
-- ============================================================
CREATE SCHEMA IF NOT EXISTS snomed;

CREATE TABLE IF NOT EXISTS snomed.concepts (
    concept_id      BIGINT PRIMARY KEY,
    effective_time  DATE,
    active          BOOLEAN,
    module_id       BIGINT,
    definition_status_id BIGINT
);

CREATE TABLE IF NOT EXISTS snomed.descriptions (
    description_id  BIGINT PRIMARY KEY,
    concept_id      BIGINT REFERENCES snomed.concepts (concept_id),
    type_id         BIGINT,
    term            TEXT,
    active          BOOLEAN,
    language_code   TEXT
);

CREATE TABLE IF NOT EXISTS snomed.relationships (
    relationship_id     BIGINT PRIMARY KEY,
    source_id           BIGINT REFERENCES snomed.concepts (concept_id),
    destination_id      BIGINT REFERENCES snomed.concepts (concept_id),
    type_id             BIGINT,
    active              BOOLEAN,
    characteristic_type_id BIGINT
);

-- ICD-10 ↔ SNOMED extended map
CREATE TABLE IF NOT EXISTS snomed.icd10_map (
    id              SERIAL PRIMARY KEY,
    referenced_component_id BIGINT REFERENCES snomed.concepts (concept_id),
    map_target      TEXT,   -- ICD-10 code
    map_rule        TEXT,
    map_advice      TEXT,
    map_priority    SMALLINT,
    map_group       SMALLINT,
    active          BOOLEAN
);

CREATE INDEX IF NOT EXISTS idx_snomed_desc_concept ON snomed.descriptions (concept_id);
CREATE INDEX IF NOT EXISTS idx_snomed_desc_active  ON snomed.descriptions (active);
CREATE INDEX IF NOT EXISTS idx_snomed_rel_src      ON snomed.relationships (source_id);
CREATE INDEX IF NOT EXISTS idx_snomed_rel_dest     ON snomed.relationships (destination_id);
CREATE INDEX IF NOT EXISTS idx_snomed_rel_type     ON snomed.relationships (type_id);
CREATE INDEX IF NOT EXISTS idx_snomed_map_target   ON snomed.icd10_map (map_target);
CREATE INDEX IF NOT EXISTS idx_snomed_desc_fts     ON snomed.descriptions
    USING GIN (to_tsvector('english', COALESCE(term,'')));

-- Embedding table for hybrid search (one FSN embedding per concept)
-- Note: ~360K active concepts — embedding takes 1-2+ hours with Ollama CPU
CREATE TABLE IF NOT EXISTS snomed.concept_embeddings (
    concept_id  BIGINT PRIMARY KEY,
    embedding   halfvec(1024),
    embedded_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_snomed_emb_hnsw ON snomed.concept_embeddings
    USING hnsw (embedding halfvec_cosine_ops);
