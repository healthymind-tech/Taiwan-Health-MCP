-- Terminology completeness for the FHIR validator (2026-10, validator audit v4).
--
-- The in-process validator mirrors validator_cli 7.0.1 + tx.fhir.org. To judge
-- codes the way the terminology server does it needs content the loaders used to
-- drop:
--   * LOINC answer (LA), part (LP), answer-list (LL) and group (LG) codes from
--     the AccessoryFiles of the LOINC release, plus the loaded LOINC version;
--   * SNOMED CT inactive concepts and inactive / inactive-concept descriptions
--     (tx.fhir.org: an inactive concept is a warning, an unknown one an error,
--     and an inactive description is not a valid display), plus the edition;
--   * the first release date of every SNOMED CT concept / description (from the
--     RF2 Full files), so a newer local release can answer as the edition
--     tx.fhir.org serves (a component released after it is unknown there);
--   * WHO ICD-10 (http://hl7.org/fhir/sid/icd-10), an optional ICD source.
-- Each edition row is written in the same promote transaction as its tables.

BEGIN;

-- LOINC ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS loinc.other_codes (
    code         TEXT PRIMARY KEY,          -- LA… / LP… / LL… / LG…
    kind         TEXT NOT NULL,             -- answer | part | answer_list | group | parent_group
    display      TEXT,                      -- tx.fhir.org display (DisplayText / PartDisplayName / AnswerListName / Group)
    alt_display  TEXT,                      -- second accepted display (PartName), or NULL
    status       TEXT
);

CREATE TABLE IF NOT EXISTS loinc.editions (
    code_system       TEXT PRIMARY KEY,     -- 'loinc'
    version           TEXT NOT NULL,        -- '2.80' (max VersionLastChanged of Loinc.csv)
    term_count        INTEGER NOT NULL,
    other_code_count  INTEGER NOT NULL,
    loaded_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin.stage_loinc_other_codes (
    job_id       UUID NOT NULL REFERENCES admin.import_jobs (job_id) ON DELETE CASCADE,
    code         TEXT NOT NULL,
    kind         TEXT NOT NULL,
    display      TEXT,
    alt_display  TEXT,
    status       TEXT,
    PRIMARY KEY (job_id, code)
);
CREATE INDEX IF NOT EXISTS idx_admin_stage_loinc_other_codes_job
    ON admin.stage_loinc_other_codes (job_id);

-- SNOMED CT -----------------------------------------------------------------

-- Inactive concepts of the loaded snapshot (snomed.concepts stays active-only:
-- the search / hierarchy tools rely on that).
CREATE TABLE IF NOT EXISTS snomed.inactive_concepts (
    concept_id      BIGINT PRIMARY KEY,
    effective_time  DATE,                   -- inactivation date
    module_id       BIGINT,
    first_released  DATE
);

-- English FSN / synonym descriptions that snomed.descriptions does not hold:
-- every description of an inactive concept, and inactive descriptions of active
-- concepts. effective_time of an inactive row is its inactivation date.
CREATE TABLE IF NOT EXISTS snomed.inactive_descriptions (
    description_id  BIGINT PRIMARY KEY,
    concept_id      BIGINT NOT NULL,
    type_id         BIGINT,
    term            TEXT,
    active          BOOLEAN NOT NULL,
    effective_time  DATE,
    first_released  DATE
);
CREATE INDEX IF NOT EXISTS idx_snomed_inactive_desc_concept
    ON snomed.inactive_descriptions (concept_id);

-- First release date (earliest effectiveTime in the RF2 Full file); NULL when
-- the release zip had no Full files.
ALTER TABLE snomed.concepts     ADD COLUMN IF NOT EXISTS first_released DATE;
ALTER TABLE snomed.descriptions ADD COLUMN IF NOT EXISTS first_released DATE;
ALTER TABLE admin.stage_snomed_concepts     ADD COLUMN IF NOT EXISTS first_released DATE;
ALTER TABLE admin.stage_snomed_descriptions ADD COLUMN IF NOT EXISTS first_released DATE;

CREATE TABLE IF NOT EXISTS snomed.editions (
    code_system             TEXT PRIMARY KEY,   -- 'snomed'
    module_id               TEXT NOT NULL,      -- '900000000000207008' (International)
    version_date            DATE NOT NULL,      -- release date of the RF2 snapshot
    includes_inactive       BOOLEAN NOT NULL,
    concept_count           INTEGER NOT NULL,   -- active
    inactive_concept_count  INTEGER NOT NULL,
    loaded_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin.stage_snomed_inactive_concepts (
    job_id          UUID NOT NULL REFERENCES admin.import_jobs (job_id) ON DELETE CASCADE,
    concept_id      BIGINT NOT NULL,
    effective_time  DATE,
    module_id       BIGINT,
    first_released  DATE,
    PRIMARY KEY (job_id, concept_id)
);
CREATE INDEX IF NOT EXISTS idx_admin_stage_snomed_inactive_concepts_job
    ON admin.stage_snomed_inactive_concepts (job_id);

CREATE TABLE IF NOT EXISTS admin.stage_snomed_inactive_descriptions (
    job_id          UUID NOT NULL REFERENCES admin.import_jobs (job_id) ON DELETE CASCADE,
    description_id  BIGINT NOT NULL,
    concept_id      BIGINT NOT NULL,
    type_id         BIGINT,
    term            TEXT,
    active          BOOLEAN NOT NULL,
    effective_time  DATE,
    first_released  DATE,
    PRIMARY KEY (job_id, description_id)
);
CREATE INDEX IF NOT EXISTS idx_admin_stage_snomed_inactive_descriptions_job
    ON admin.stage_snomed_inactive_descriptions (job_id);

-- WHO ICD-10 ----------------------------------------------------------------

CREATE TABLE IF NOT EXISTS icd.icd10_who (
    code          TEXT PRIMARY KEY,         -- 'A09', 'A09.0', block 'A00-A09', chapter 'I'
    display       TEXT NOT NULL,
    kind          TEXT,                     -- chapter | block | category | NULL
    alt_displays  TEXT[] NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS admin.stage_icd10_who (
    job_id        UUID NOT NULL REFERENCES admin.import_jobs (job_id) ON DELETE CASCADE,
    code          TEXT NOT NULL,
    display       TEXT NOT NULL,
    kind          TEXT,
    alt_displays  TEXT[] NOT NULL DEFAULT '{}',
    PRIMARY KEY (job_id, code)
);
CREATE INDEX IF NOT EXISTS idx_admin_stage_icd10_who_job
    ON admin.stage_icd10_who (job_id);

COMMIT;
