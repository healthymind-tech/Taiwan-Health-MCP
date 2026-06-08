-- RxNorm reference terminology (concept-only) for IG ValueSet expansion.
-- Adds the rxnorm schema + concepts table and the admin staging table.
-- Idempotent; safe to re-run.

-- Production table -----------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS rxnorm;

CREATE TABLE IF NOT EXISTS rxnorm.concepts (
    rxcui     BIGINT PRIMARY KEY,
    name      TEXT NOT NULL,
    tty       TEXT NOT NULL,
    suppress  TEXT
);
CREATE INDEX IF NOT EXISTS idx_rxnorm_concepts_tty ON rxnorm.concepts (tty);
CREATE INDEX IF NOT EXISTS idx_rxnorm_concepts_name_fts ON rxnorm.concepts
    USING GIN (to_tsvector('english', COALESCE(name, '')));

-- Admin staging table --------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin.stage_rxnorm_concepts (
    job_id      UUID NOT NULL REFERENCES admin.import_jobs (job_id) ON DELETE CASCADE,
    rxcui       BIGINT NOT NULL,
    name        TEXT NOT NULL,
    tty         TEXT NOT NULL,
    suppress    TEXT,
    PRIMARY KEY (job_id, rxcui)
);
CREATE INDEX IF NOT EXISTS idx_admin_stage_rxnorm_concepts_job
    ON admin.stage_rxnorm_concepts (job_id);
