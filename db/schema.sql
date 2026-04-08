-- Taiwan Health MCP - PostgreSQL Schema
-- Run automatically by postgres container on first init

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


-- ============================================================
-- DRUG (Taiwan FDA)
-- ============================================================
CREATE SCHEMA IF NOT EXISTS drug;

CREATE TABLE IF NOT EXISTS drug.licenses (
    license_id   TEXT PRIMARY KEY,
    name_zh      TEXT,
    name_en      TEXT,
    indication   TEXT,
    form         TEXT,
    package      TEXT,
    category     TEXT,
    manufacturer TEXT,
    valid_date   TEXT,
    usage        TEXT
);

CREATE TABLE IF NOT EXISTS drug.appearance (
    license_id  TEXT,
    shape       TEXT,
    color       TEXT,
    marking     TEXT,
    image_url   TEXT
);

CREATE TABLE IF NOT EXISTS drug.ingredients (
    license_id      TEXT,
    ingredient_name TEXT,
    ingredient_qty  TEXT,
    ingredient_unit TEXT
);

CREATE TABLE IF NOT EXISTS drug.atc (
    license_id  TEXT,
    atc_code    TEXT,
    atc_name    TEXT
);

CREATE TABLE IF NOT EXISTS drug.documents (
    license_id  TEXT,
    doc_type    TEXT,
    doc_url     TEXT
);

CREATE TABLE IF NOT EXISTS drug.sync_meta (
    key         TEXT PRIMARY KEY,
    value       TEXT,
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_drug_app_lid  ON drug.appearance (license_id);
CREATE INDEX IF NOT EXISTS idx_drug_ing_lid  ON drug.ingredients (license_id);
CREATE INDEX IF NOT EXISTS idx_drug_atc_lid  ON drug.atc (license_id);
CREATE INDEX IF NOT EXISTS idx_drug_atc_code ON drug.atc (atc_code);
CREATE INDEX IF NOT EXISTS idx_drug_lic_fts  ON drug.licenses
    USING GIN (to_tsvector('simple',
        COALESCE(name_zh,'') || ' ' || COALESCE(name_en,'') || ' ' || COALESCE(indication,'')));


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


-- ============================================================
-- RXNORM  (populated by data-loader in Phase 4)
-- ============================================================
CREATE SCHEMA IF NOT EXISTS rxnorm;

CREATE TABLE IF NOT EXISTS rxnorm.concepts (
    rxcui       TEXT PRIMARY KEY,
    name        TEXT,
    tty         TEXT,   -- term type: IN, PIN, MIN, BN, etc.
    suppress    TEXT
);

CREATE TABLE IF NOT EXISTS rxnorm.relationships (
    rxcui1      TEXT,
    rel         TEXT,   -- e.g. RO, RB, RN
    rxcui2      TEXT,
    rela        TEXT    -- e.g. has_ingredient, interacts_with
);

CREATE INDEX IF NOT EXISTS idx_rxn_rel_cui1 ON rxnorm.relationships (rxcui1);
CREATE INDEX IF NOT EXISTS idx_rxn_rel_cui2 ON rxnorm.relationships (rxcui2);
CREATE INDEX IF NOT EXISTS idx_rxn_rel_rela ON rxnorm.relationships (rela);
CREATE INDEX IF NOT EXISTS idx_rxnorm_fts   ON rxnorm.concepts
    USING GIN (to_tsvector('english', COALESCE(name,'')));
