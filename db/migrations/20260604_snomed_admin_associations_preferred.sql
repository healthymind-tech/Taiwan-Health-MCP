-- Bring the admin (web) SNOMED import to parity with the CLI loader.
--
-- The admin staged-import path (admin_jobs._run_snomed_import_job) previously
-- only staged concepts/descriptions/relationships/icd10_map, so importing
-- SNOMED from the Admin UI never populated snomed.historical_associations and
-- silently dropped the us_preferred flag. This migration adds the missing
-- staging structures so the web import matches loader.loaders.snomed_loader.

-- 1. Carry the US English "preferred term" flag through staging.
ALTER TABLE admin.stage_snomed_descriptions
    ADD COLUMN IF NOT EXISTS us_preferred BOOLEAN NOT NULL DEFAULT FALSE;

-- 2. Stage historical (retired concept → successor) associations.
CREATE TABLE IF NOT EXISTS admin.stage_snomed_associations (
    job_id                    UUID NOT NULL REFERENCES admin.import_jobs (job_id) ON DELETE CASCADE,
    referenced_component_id   BIGINT NOT NULL,
    target_component_id       BIGINT NOT NULL,
    refset_id                 BIGINT NOT NULL,
    PRIMARY KEY (job_id, referenced_component_id, target_component_id, refset_id)
);

CREATE INDEX IF NOT EXISTS idx_admin_stage_snomed_associations_job
    ON admin.stage_snomed_associations (job_id);

-- 3. Defensive: ensure the promote targets exist on older databases.
ALTER TABLE snomed.descriptions
    ADD COLUMN IF NOT EXISTS us_preferred BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS snomed.historical_associations (
    referenced_component_id   BIGINT NOT NULL,
    target_component_id       BIGINT NOT NULL,
    refset_id                 BIGINT NOT NULL,
    PRIMARY KEY (referenced_component_id, target_component_id, refset_id)
);

CREATE INDEX IF NOT EXISTS idx_snomed_hist_assoc_ref
    ON snomed.historical_associations (referenced_component_id);
