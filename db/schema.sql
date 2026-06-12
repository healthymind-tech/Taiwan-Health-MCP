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
-- ADMIN CONTROL PLANE
-- ============================================================
CREATE SCHEMA IF NOT EXISTS admin;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS admin.uploaded_files (
    uploaded_file_id    UUID PRIMARY KEY,
    module_key         TEXT NOT NULL,
    source_role         TEXT NOT NULL,
    original_filename   TEXT NOT NULL,
    mime_type           TEXT,
    size_bytes          BIGINT,
    sha256              TEXT NOT NULL,
    bucket              TEXT,
    object_key          TEXT,
    minio_uri           TEXT,
    uploaded_by         TEXT NOT NULL,
    uploaded_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    validation_status   TEXT NOT NULL DEFAULT 'pending',
    validation_error    TEXT
);

CREATE TABLE IF NOT EXISTS admin.module_sources (
    module_source_id   UUID PRIMARY KEY,
    module_key         TEXT NOT NULL,
    source_role         TEXT NOT NULL,
    uploaded_file_id    UUID REFERENCES admin.uploaded_files (uploaded_file_id) ON DELETE CASCADE,
    is_active           BOOLEAN NOT NULL DEFAULT FALSE,
    activated_at        TIMESTAMPTZ,
    version_num         INT,
    notes               JSONB NOT NULL DEFAULT '{}'::jsonb
);
-- Idempotent migration: add version_num for existing installations
ALTER TABLE admin.module_sources ADD COLUMN IF NOT EXISTS version_num INT;

CREATE TABLE IF NOT EXISTS admin.import_jobs (
    job_id                    UUID PRIMARY KEY,
    module_key               TEXT NOT NULL,
    job_type                  TEXT NOT NULL,
    requested_by              TEXT NOT NULL,
    status                    TEXT NOT NULL DEFAULT 'queued',
    control_state             TEXT NOT NULL DEFAULT 'idle',
    source_module_source_id  UUID REFERENCES admin.module_sources (module_source_id) ON DELETE SET NULL,
    source_uploaded_file_id   UUID REFERENCES admin.uploaded_files (uploaded_file_id) ON DELETE SET NULL,
    parent_job_id             UUID REFERENCES admin.import_jobs (job_id) ON DELETE SET NULL,
    progress_current          INTEGER NOT NULL DEFAULT 0,
    progress_total            INTEGER NOT NULL DEFAULT 0,
    current_step              TEXT,
    worker_name               TEXT,
    claimed_at                TIMESTAMPTZ,
    started_at                TIMESTAMPTZ,
    finished_at               TIMESTAMPTZ,
    attempt_count             INTEGER NOT NULL DEFAULT 0,
    last_error_code           TEXT,
    last_error_message        TEXT,
    job_options_json          JSONB NOT NULL DEFAULT '{}'::jsonb,
    result_summary_json       JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin.import_job_steps (
    job_step_id          BIGSERIAL PRIMARY KEY,
    job_id               UUID NOT NULL REFERENCES admin.import_jobs (job_id) ON DELETE CASCADE,
    step_key             TEXT NOT NULL,
    status               TEXT NOT NULL,
    progress_current     INTEGER NOT NULL DEFAULT 0,
    progress_total       INTEGER NOT NULL DEFAULT 0,
    started_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at          TIMESTAMPTZ,
    checkpoint_json      JSONB NOT NULL DEFAULT '{}'::jsonb,
    last_error_message   TEXT,
    UNIQUE(job_id, step_key)
);

CREATE TABLE IF NOT EXISTS admin.import_job_logs (
    job_log_id        BIGSERIAL PRIMARY KEY,
    job_id            UUID NOT NULL REFERENCES admin.import_jobs (job_id) ON DELETE CASCADE,
    level             TEXT NOT NULL,
    message           TEXT NOT NULL,
    payload_json      JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin.job_control_requests (
    control_request_id   BIGSERIAL PRIMARY KEY,
    job_id               UUID NOT NULL REFERENCES admin.import_jobs (job_id) ON DELETE CASCADE,
    action               TEXT NOT NULL,
    requested_by         TEXT NOT NULL,
    requested_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    handled_at           TIMESTAMPTZ,
    result_status        TEXT,
    result_message       TEXT
);

CREATE TABLE IF NOT EXISTS admin.worker_heartbeats (
    worker_name          TEXT PRIMARY KEY,
    process_id           INTEGER NOT NULL,
    status               TEXT NOT NULL,
    current_job_id       UUID REFERENCES admin.import_jobs (job_id) ON DELETE SET NULL,
    details_json         JSONB NOT NULL DEFAULT '{}'::jsonb,
    last_heartbeat_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin.service_probes (
    service_key          TEXT PRIMARY KEY,
    status               TEXT NOT NULL,
    endpoint             TEXT,
    latency_ms           INTEGER,
    message              TEXT,
    details_json         JSONB NOT NULL DEFAULT '{}'::jsonb,
    checked_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin.service_probe_history (
    service_probe_history_id BIGSERIAL PRIMARY KEY,
    service_key              TEXT NOT NULL,
    status                   TEXT NOT NULL,
    endpoint                 TEXT,
    latency_ms               INTEGER,
    message                  TEXT,
    details_json             JSONB NOT NULL DEFAULT '{}'::jsonb,
    checked_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin.fhir_servers (
    fhir_server_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    server_key TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    display_name TEXT,
    environment TEXT,
    tags JSONB NOT NULL DEFAULT '[]'::jsonb,
    description TEXT,
    base_url TEXT NOT NULL,
    test_path TEXT,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    is_default BOOLEAN NOT NULL DEFAULT FALSE,
    auth_type TEXT NOT NULL DEFAULT 'none'
        CHECK (auth_type IN (
            'none', 'oauth2_client_credentials', 'oauth2_authorization_code'
        )),
    auth_profile TEXT NOT NULL DEFAULT 'none'
        CHECK (auth_profile IN ('none', 'iua', 'smart')),
    auth_server_url TEXT,
    metadata_url TEXT,
    authorization_endpoint TEXT,
    token_endpoint TEXT,
    use_metadata BOOLEAN NOT NULL DEFAULT TRUE,
    client_id TEXT,
    client_secret_ciphertext BYTEA,
    token_auth_method TEXT NOT NULL DEFAULT 'client_secret_basic'
        CHECK (token_auth_method IN (
            'client_secret_basic', 'client_secret_post',
            'client_secret_jwt', 'private_key_jwt'
        )),
    client_private_key_ciphertext BYTEA,
    jwt_signing_alg TEXT,
    jwt_kid TEXT,
    client_public_jwk_json TEXT,
    default_token_strategy TEXT,
    scope TEXT,
    resource TEXT,
    requested_token_type TEXT,
    metadata_headers_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    token_headers_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    resource_headers_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    verify_tls BOOLEAN NOT NULL DEFAULT TRUE,
    timeout_seconds INTEGER NOT NULL DEFAULT 30,
    allowed_resource_types JSONB NOT NULL DEFAULT '[]'::jsonb,
    allowed_operations JSONB NOT NULL DEFAULT '["metadata","read","search"]'::jsonb,
    last_probe_status TEXT,
    last_probe_at TIMESTAMPTZ,
    last_probe_error TEXT,
    capability_summary_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- OAuth2 Authorization Code (+ PKCE) token state, one row per server+admin user.
-- Holds both the ephemeral pending-authorization PKCE state (cleared on callback
-- success) and the active encrypted access/refresh tokens. Tokens are encrypted
-- with pgp_sym_encrypt under the same key as client_secret_ciphertext.
CREATE TABLE IF NOT EXISTS admin.fhir_server_oauth_tokens (
    fhir_server_oauth_token_id BIGSERIAL PRIMARY KEY,
    fhir_server_id UUID NOT NULL REFERENCES admin.fhir_servers (fhir_server_id)
        ON DELETE CASCADE,
    admin_user TEXT NOT NULL,
    -- Pending PKCE authorization state (cleared once the code is exchanged).
    state_nonce TEXT UNIQUE,
    code_verifier TEXT,
    redirect_uri TEXT,
    requested_scope TEXT,
    pending_created_at TIMESTAMPTZ,
    -- Active tokens (encrypted) populated after a successful code exchange.
    access_token_ciphertext BYTEA,
    refresh_token_ciphertext BYTEA,
    token_type TEXT,
    granted_scope TEXT,
    access_token_expires_at TIMESTAMPTZ,
    refresh_token_expires_at TIMESTAMPTZ,
    obtained_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (fhir_server_id, admin_user)
);

CREATE TABLE IF NOT EXISTS admin.fhir_server_probe_history (
    fhir_server_probe_history_id BIGSERIAL PRIMARY KEY,
    fhir_server_id UUID REFERENCES admin.fhir_servers (fhir_server_id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    endpoint TEXT,
    latency_ms INTEGER,
    message TEXT,
    details_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin.fhir_server_operation_logs (
    fhir_server_operation_log_id BIGSERIAL PRIMARY KEY,
    fhir_server_id UUID REFERENCES admin.fhir_servers (fhir_server_id) ON DELETE SET NULL,
    server_key TEXT,
    operation TEXT NOT NULL,
    resource_type TEXT,
    resource_id TEXT,
    status_code INTEGER,
    duration_ms INTEGER,
    success BOOLEAN NOT NULL DEFAULT FALSE,
    error_message TEXT,
    caller TEXT NOT NULL DEFAULT 'mcp',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin.admin_audit_log (
    admin_audit_id       BIGSERIAL PRIMARY KEY,
    admin_user           TEXT NOT NULL,
    action               TEXT NOT NULL,
    target_type          TEXT,
    target_id            TEXT,
    payload_json         JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- DB-backed application settings for external/integration systems (embedding,
-- analysis LM, OCR, MinIO, TFDA, worker tuning). Seeded once from .env on first
-- boot (when empty); afterwards managed via the admin Settings tab. The type,
-- default, secret-ness and UI metadata for each key live in the Python registry
-- (src/admin_settings.py SETTINGS_SCHEMA) — only the raw value is stored here.
CREATE TABLE IF NOT EXISTS admin.app_settings (
    group_key   TEXT NOT NULL,
    key         TEXT NOT NULL,
    value       TEXT,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by  TEXT,
    PRIMARY KEY (group_key, key)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_uploaded_files_dedupe
    ON admin.uploaded_files (module_key, source_role, sha256);
CREATE INDEX IF NOT EXISTS idx_admin_module_sources_lookup
    ON admin.module_sources (module_key, source_role, is_active);
-- Removed: drug_index_csv supports multiple active sources (multi-source import).
CREATE INDEX IF NOT EXISTS idx_admin_import_jobs_status_created
    ON admin.import_jobs (status, created_at);
CREATE INDEX IF NOT EXISTS idx_admin_import_jobs_module
    ON admin.import_jobs (module_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_import_job_logs_job
    ON admin.import_job_logs (job_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_control_requests_job
    ON admin.job_control_requests (job_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_worker_heartbeat_ts
    ON admin.worker_heartbeats (last_heartbeat_at);
CREATE INDEX IF NOT EXISTS idx_admin_service_probe_history_service_ts
    ON admin.service_probe_history (service_key, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_fhir_servers_enabled
    ON admin.fhir_servers (enabled, server_key);
CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_fhir_servers_single_default
    ON admin.fhir_servers (is_default)
    WHERE is_default = TRUE;
CREATE INDEX IF NOT EXISTS idx_admin_fhir_server_probe_history_server_ts
    ON admin.fhir_server_probe_history (fhir_server_id, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_fhir_server_operation_logs_server_ts
    ON admin.fhir_server_operation_logs (fhir_server_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_fhir_server_oauth_tokens_server
    ON admin.fhir_server_oauth_tokens (fhir_server_id);
CREATE INDEX IF NOT EXISTS idx_admin_fhir_server_oauth_tokens_pending
    ON admin.fhir_server_oauth_tokens (pending_created_at)
    WHERE state_nonce IS NOT NULL;

-- Per-module automatic import schedules managed by admin-worker.
CREATE TABLE IF NOT EXISTS admin.module_schedules (
    schedule_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    module_key      TEXT NOT NULL UNIQUE,
    source_role      TEXT,            -- NULL for api-sync modules (health_supplements, food_nutrition)
    fetch_url        TEXT,            -- NULL for api-sync modules
    frequency        TEXT NOT NULL,   -- 'daily' | 'weekly' | 'monthly'
    day_of_week      SMALLINT,        -- 0=Mon..6=Sun (weekly only)
    day_of_month     SMALLINT,        -- 1-28 (monthly only)
    hour_utc         SMALLINT NOT NULL DEFAULT 2,
    minute_utc       SMALLINT NOT NULL DEFAULT 0,
    is_enabled       BOOL NOT NULL DEFAULT TRUE,
    last_run_at      TIMESTAMPTZ,
    next_run_at      TIMESTAMPTZ,
    last_run_status  TEXT,            -- 'success' | 'failed' | NULL
    last_run_job_id  UUID REFERENCES admin.import_jobs (job_id) ON DELETE SET NULL,
    last_error       TEXT,
    created_by       TEXT NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE admin.module_schedules ADD COLUMN IF NOT EXISTS last_error TEXT;

CREATE INDEX IF NOT EXISTS idx_admin_module_schedules_enabled_next
    ON admin.module_schedules (is_enabled, next_run_at)
    WHERE is_enabled = TRUE;

-- Tracks when each module was last fully loaded so the embedding UI can detect
-- whether source data has changed since the last embedding run.
CREATE TABLE IF NOT EXISTS admin.module_load_log (
    module_key    TEXT PRIMARY KEY,  -- 'icd', 'loinc', 'snomed', 'guideline', 'health_supplements', 'food_nutrition'
    last_loaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    row_count      INTEGER
);

-- Tracks each module's last embedding run. last_run_at is set on EVERY run
-- (even one that re-embedded nothing), so incremental embedding cannot leave the
-- UI falsely showing "stale": stale = module_load_log.last_loaded_at > last_run_at.
-- changed_last_run = rows whose source text was new/changed and got (re)embedded.
CREATE TABLE IF NOT EXISTS admin.module_embed_log (
    module_key       TEXT PRIMARY KEY,  -- 'icd','loinc','snomed','guideline','health_supplements','food_nutrition'
    last_run_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    source_total     INTEGER,
    embedded         INTEGER,
    changed_last_run INTEGER,
    updated_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin.stage_icd_diagnoses (
    job_id        UUID NOT NULL REFERENCES admin.import_jobs (job_id) ON DELETE CASCADE,
    code          TEXT NOT NULL,
    name_en       TEXT,
    name_zh       TEXT,
    category      TEXT,
    PRIMARY KEY (job_id, code)
);

CREATE TABLE IF NOT EXISTS admin.stage_icd_procedures (
    job_id        UUID NOT NULL REFERENCES admin.import_jobs (job_id) ON DELETE CASCADE,
    code          TEXT NOT NULL,
    name_en       TEXT,
    name_zh       TEXT,
    PRIMARY KEY (job_id, code)
);

CREATE TABLE IF NOT EXISTS admin.stage_loinc_concepts (
    job_id               UUID NOT NULL REFERENCES admin.import_jobs (job_id) ON DELETE CASCADE,
    loinc_num            TEXT NOT NULL,
    component            TEXT,
    property             TEXT,
    time_aspect          TEXT,
    system               TEXT,
    scale_type           TEXT,
    method_type          TEXT,
    long_common_name     TEXT,
    shortname            TEXT,
    class                TEXT,
    classtype            SMALLINT,
    status               TEXT,
    consumer_name        TEXT,
    name_zh              TEXT,
    common_name_zh       TEXT,
    specimen_type        TEXT,
    unit                 TEXT,
    PRIMARY KEY (job_id, loinc_num)
);

CREATE TABLE IF NOT EXISTS admin.stage_loinc_reference_ranges (
    job_id           UUID NOT NULL REFERENCES admin.import_jobs (job_id) ON DELETE CASCADE,
    loinc_num        TEXT NOT NULL,
    age_min          INTEGER,
    age_max          INTEGER,
    gender           TEXT,
    range_low        NUMERIC,
    range_high       NUMERIC,
    unit             TEXT,
    interpretation   TEXT,
    UNIQUE (job_id, loinc_num, age_min, age_max, gender, unit, interpretation)
);

-- TWCore/FHIR staging tables (legacy "twcore" table names kept; they are
-- job-internal). package_id/package_version were added in Phase 0 because one
-- import job may stage several IG packages (the primary IG plus its bound
-- dependency packages), so the package identity is part of every staged key.
CREATE TABLE IF NOT EXISTS admin.stage_twcore_codesystems (
    job_id           UUID NOT NULL REFERENCES admin.import_jobs (job_id) ON DELETE CASCADE,
    package_id       TEXT NOT NULL,
    package_version  TEXT NOT NULL,
    cs_id            TEXT NOT NULL,
    name             TEXT,
    category         TEXT,
    concept_count    INTEGER,
    PRIMARY KEY (job_id, package_id, package_version, cs_id)
);

CREATE TABLE IF NOT EXISTS admin.stage_twcore_concepts (
    job_id           UUID NOT NULL REFERENCES admin.import_jobs (job_id) ON DELETE CASCADE,
    package_id       TEXT NOT NULL,
    package_version  TEXT NOT NULL,
    cs_id            TEXT NOT NULL,
    code             TEXT NOT NULL,
    display          TEXT,
    definition       TEXT,
    PRIMARY KEY (job_id, package_id, package_version, cs_id, code)
);

CREATE TABLE IF NOT EXISTS admin.stage_twcore_artifacts (
    job_id           UUID NOT NULL REFERENCES admin.import_jobs (job_id) ON DELETE CASCADE,
    package_id       TEXT NOT NULL,
    package_version  TEXT NOT NULL,
    artifact_key     TEXT NOT NULL,
    resource_type    TEXT NOT NULL,
    artifact_id      TEXT,
    canonical_url    TEXT,
    name             TEXT,
    title            TEXT,
    status           TEXT,
    kind             TEXT,
    base_type        TEXT,
    derivation       TEXT,
    grouping_id      TEXT,
    grouping_name    TEXT,
    description      TEXT,
    package_path     TEXT,
    child_count      INTEGER NOT NULL DEFAULT 0,
    concept_count    INTEGER NOT NULL DEFAULT 0,
    raw_json         JSONB,
    PRIMARY KEY (job_id, package_id, package_version, artifact_key)
);

CREATE TABLE IF NOT EXISTS admin.stage_snomed_concepts (
    job_id                  UUID NOT NULL REFERENCES admin.import_jobs (job_id) ON DELETE CASCADE,
    concept_id              BIGINT NOT NULL,
    effective_time          DATE,
    active                  BOOLEAN,
    module_id               BIGINT,
    definition_status_id    BIGINT,
    PRIMARY KEY (job_id, concept_id)
);

CREATE TABLE IF NOT EXISTS admin.stage_snomed_descriptions (
    job_id           UUID NOT NULL REFERENCES admin.import_jobs (job_id) ON DELETE CASCADE,
    description_id   BIGINT NOT NULL,
    concept_id       BIGINT,
    type_id          BIGINT,
    term             TEXT,
    active           BOOLEAN,
    language_code    TEXT,
    us_preferred     BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (job_id, description_id)
);

CREATE TABLE IF NOT EXISTS admin.stage_snomed_relationships (
    job_id                    UUID NOT NULL REFERENCES admin.import_jobs (job_id) ON DELETE CASCADE,
    relationship_id           BIGINT NOT NULL,
    source_id                 BIGINT,
    destination_id            BIGINT,
    type_id                   BIGINT,
    active                    BOOLEAN,
    characteristic_type_id    BIGINT,
    PRIMARY KEY (job_id, relationship_id)
);

CREATE TABLE IF NOT EXISTS admin.stage_snomed_icd10_map (
    job_id                    UUID NOT NULL REFERENCES admin.import_jobs (job_id) ON DELETE CASCADE,
    referenced_component_id   BIGINT NOT NULL,
    map_target                TEXT NOT NULL,
    map_rule                  TEXT,
    map_advice                TEXT,
    map_priority              SMALLINT,
    map_group                 SMALLINT,
    active                    BOOLEAN,
    UNIQUE (job_id, referenced_component_id, map_target, map_priority, map_group)
);

CREATE TABLE IF NOT EXISTS admin.stage_snomed_associations (
    job_id                    UUID NOT NULL REFERENCES admin.import_jobs (job_id) ON DELETE CASCADE,
    referenced_component_id   BIGINT NOT NULL,
    target_component_id       BIGINT NOT NULL,
    refset_id                 BIGINT NOT NULL,
    PRIMARY KEY (job_id, referenced_component_id, target_component_id, refset_id)
);

CREATE TABLE IF NOT EXISTS admin.stage_rxnorm_concepts (
    job_id      UUID NOT NULL REFERENCES admin.import_jobs (job_id) ON DELETE CASCADE,
    rxcui       BIGINT NOT NULL,
    name        TEXT NOT NULL,
    tty         TEXT NOT NULL,
    suppress    TEXT,
    PRIMARY KEY (job_id, rxcui)
);

CREATE INDEX IF NOT EXISTS idx_admin_stage_icd_diagnoses_job
    ON admin.stage_icd_diagnoses (job_id);
CREATE INDEX IF NOT EXISTS idx_admin_stage_icd_procedures_job
    ON admin.stage_icd_procedures (job_id);
CREATE INDEX IF NOT EXISTS idx_admin_stage_loinc_concepts_job
    ON admin.stage_loinc_concepts (job_id);
CREATE INDEX IF NOT EXISTS idx_admin_stage_loinc_ranges_job
    ON admin.stage_loinc_reference_ranges (job_id);
CREATE INDEX IF NOT EXISTS idx_admin_stage_twcore_codesystems_job
    ON admin.stage_twcore_codesystems (job_id);
CREATE INDEX IF NOT EXISTS idx_admin_stage_twcore_concepts_job
    ON admin.stage_twcore_concepts (job_id);
CREATE INDEX IF NOT EXISTS idx_admin_stage_twcore_artifacts_job
    ON admin.stage_twcore_artifacts (job_id);
CREATE INDEX IF NOT EXISTS idx_admin_stage_snomed_concepts_job
    ON admin.stage_snomed_concepts (job_id);
CREATE INDEX IF NOT EXISTS idx_admin_stage_snomed_descriptions_job
    ON admin.stage_snomed_descriptions (job_id);
CREATE INDEX IF NOT EXISTS idx_admin_stage_snomed_relationships_job
    ON admin.stage_snomed_relationships (job_id);
CREATE INDEX IF NOT EXISTS idx_admin_stage_snomed_map_job
    ON admin.stage_snomed_icd10_map (job_id);
CREATE INDEX IF NOT EXISTS idx_admin_stage_snomed_associations_job
    ON admin.stage_snomed_associations (job_id);
CREATE INDEX IF NOT EXISTS idx_admin_stage_rxnorm_concepts_job
    ON admin.stage_rxnorm_concepts (job_id);


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
    source_hash TEXT,  -- sha256 of the embedded text; lets the loader skip unchanged rows
    embedded_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_icd_diag_emb_hnsw ON icd.diagnosis_embeddings
    USING hnsw (embedding halfvec_cosine_ops);

-- ============================================================
-- DRUG (Taiwan FDA index-first domain, Phase 1)
-- ============================================================
CREATE SCHEMA IF NOT EXISTS drug;

CREATE TABLE IF NOT EXISTS drug.index_snapshots (
    snapshot_id      UUID PRIMARY KEY,
    source_filename  TEXT NOT NULL,
    source_sha256    TEXT NOT NULL,
    row_count        INTEGER NOT NULL,
    loaded_at        TIMESTAMPTZ NOT NULL,
    status           TEXT NOT NULL,
    notes            JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS drug.licenses (
    license_id                    TEXT PRIMARY KEY,
    snapshot_id                   UUID REFERENCES drug.index_snapshots (snapshot_id),
    row_hash                      TEXT NOT NULL,
    license_token                 TEXT NOT NULL,
    is_active                     BOOLEAN NOT NULL DEFAULT TRUE,
    is_listed                     BOOLEAN NOT NULL DEFAULT TRUE,
    cancellation_status           TEXT,
    cancellation_date             DATE,
    cancellation_reason           TEXT,
    valid_until                   DATE,
    issue_date                    DATE,
    last_changed_date             DATE,
    license_type                  TEXT,
    old_license_no                TEXT,
    customs_clearance_no          TEXT,
    chinese_name                  TEXT,
    english_name                  TEXT,
    drug_category                 TEXT,
    controlled_drug_level         TEXT,
    dosage_form                   TEXT,
    package                       TEXT,
    indications_text              TEXT,
    main_ingredient_summary       TEXT,
    applicant_name                TEXT,
    applicant_address             TEXT,
    applicant_tax_id              TEXT,
    manufacturer_name             TEXT,
    manufacturer_factory_address  TEXT,
    manufacturer_company_address  TEXT,
    manufacturer_country          TEXT,
    manufacturing_process         TEXT,
    usage_text_from_index         TEXT,
    barcode_text                  TEXT,
    raw_index_json                JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS drug.ingredients (
    ingredient_id  BIGSERIAL PRIMARY KEY,
    license_id     TEXT NOT NULL REFERENCES drug.licenses (license_id) ON DELETE CASCADE,
    name           TEXT,
    amount         TEXT,
    unit           TEXT,
    raw_text       TEXT,
    source         TEXT,
    sort_order     INTEGER,
    raw_json       JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS drug.atc (
    atc_id     BIGSERIAL PRIMARY KEY,
    license_id TEXT NOT NULL REFERENCES drug.licenses (license_id) ON DELETE CASCADE,
    code       TEXT,
    name       TEXT,
    source     TEXT,
    raw_json   JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS drug.electronic_inserts (
    license_id           TEXT PRIMARY KEY REFERENCES drug.licenses (license_id) ON DELETE CASCADE,
    source_url           TEXT,
    basic_info_json      JSONB NOT NULL DEFAULT '{}'::jsonb,
    manufacturers_json   JSONB NOT NULL DEFAULT '[]'::jsonb,
    sections_json        JSONB NOT NULL DEFAULT '{}'::jsonb,
    ingredients_json     JSONB NOT NULL DEFAULT '{}'::jsonb,
    atc_codes_json       JSONB NOT NULL DEFAULT '[]'::jsonb,
    label_pdfs_json      JSONB NOT NULL DEFAULT '[]'::jsonb,
    history_pdfs_json    JSONB NOT NULL DEFAULT '[]'::jsonb,
    public_pdfs_json     JSONB NOT NULL DEFAULT '[]'::jsonb,
    paper_pdfs_json      JSONB NOT NULL DEFAULT '[]'::jsonb,
    authorizations_json  JSONB NOT NULL DEFAULT '[]'::jsonb,
    raw_page_hash        TEXT,
    scraped_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    parse_status         TEXT NOT NULL DEFAULT 'success',
    last_error_message   TEXT
);

CREATE TABLE IF NOT EXISTS drug.appearance_records (
    appearance_id    UUID PRIMARY KEY,
    license_id       TEXT NOT NULL REFERENCES drug.licenses (license_id) ON DELETE CASCADE,
    shape_id         TEXT NOT NULL,
    appearance_no    TEXT,
    detail_url       TEXT,
    description      TEXT,
    color            TEXT,
    shape            TEXT,
    scoring          TEXT,
    symbol           TEXT,
    size             TEXT,
    imprint          TEXT,
    raw_json         JSONB NOT NULL DEFAULT '{}'::jsonb,
    scraped_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS drug.assets (
    asset_id                 UUID PRIMARY KEY,
    license_id               TEXT NOT NULL REFERENCES drug.licenses (license_id) ON DELETE CASCADE,
    appearance_id            UUID REFERENCES drug.appearance_records (appearance_id) ON DELETE CASCADE,
    asset_type               TEXT NOT NULL,
    asset_group              TEXT NOT NULL,
    source_page              TEXT NOT NULL,
    source_url               TEXT,
    source_filename          TEXT,
    normalized_filename      TEXT,
    upload_date              DATE,
    mime_type                TEXT,
    size_bytes               BIGINT,
    sha256                   TEXT,
    bucket                   TEXT,
    object_key               TEXT,
    minio_uri                TEXT,
    etag                     TEXT,
    version_id               TEXT,
    download_status          TEXT NOT NULL DEFAULT 'pending',
    storage_status           TEXT NOT NULL DEFAULT 'pending',
    is_latest_for_analysis   BOOLEAN NOT NULL DEFAULT FALSE,
    retry_count              INTEGER NOT NULL DEFAULT 0,
    last_error_code          TEXT,
    last_error_message       TEXT,
    last_attempt_at          TIMESTAMPTZ,
    downloaded_at            TIMESTAMPTZ,
    stored_at                TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS drug.insert_analysis (
    analysis_id            UUID PRIMARY KEY,
    license_id             TEXT NOT NULL REFERENCES drug.licenses (license_id) ON DELETE CASCADE,
    source_asset_id        UUID NOT NULL REFERENCES drug.assets (asset_id) ON DELETE CASCADE,
    ocr_asset_id           UUID REFERENCES drug.assets (asset_id) ON DELETE SET NULL,
    analysis_asset_id      UUID REFERENCES drug.assets (asset_id) ON DELETE SET NULL,
    primary_insert_source  TEXT NOT NULL DEFAULT 'pdf_insert',
    ocr_provider           TEXT,
    analysis_provider      TEXT,
    ocr_status             TEXT NOT NULL DEFAULT 'pending',
    analysis_status        TEXT NOT NULL DEFAULT 'pending',
    normalized_json        JSONB NOT NULL DEFAULT '{}'::jsonb,
    last_error_code        TEXT,
    last_error_message     TEXT,
    last_attempt_at        TIMESTAMPTZ,
    completed_at           TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS drug.normalized_records (
    license_id             TEXT PRIMARY KEY REFERENCES drug.licenses (license_id) ON DELETE CASCADE,
    normalized_json        JSONB NOT NULL,
    primary_insert_source  TEXT NOT NULL,
    quality_confidence     TEXT NOT NULL,
    missing_fields         JSONB NOT NULL DEFAULT '[]'::jsonb,
    conflict_fields        JSONB NOT NULL DEFAULT '[]'::jsonb,
    source_errors          JSONB NOT NULL DEFAULT '[]'::jsonb,
    normalized_at          TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS drug.import_runs (
    run_id         UUID PRIMARY KEY,
    run_type       TEXT NOT NULL,
    trigger_type   TEXT NOT NULL,
    status         TEXT NOT NULL,
    started_at     TIMESTAMPTZ NOT NULL,
    finished_at    TIMESTAMPTZ,
    summary_json   JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS drug.import_license_state (
    license_id                 TEXT PRIMARY KEY REFERENCES drug.licenses (license_id) ON DELETE CASCADE,
    current_run_id             UUID REFERENCES drug.import_runs (run_id),
    index_status               TEXT NOT NULL DEFAULT 'pending',
    electronic_insert_status   TEXT NOT NULL DEFAULT 'pending',
    insert_pdf_status          TEXT NOT NULL DEFAULT 'pending',
    label_pdf_status           TEXT NOT NULL DEFAULT 'pending',
    shape_status               TEXT NOT NULL DEFAULT 'pending',
    storage_status             TEXT NOT NULL DEFAULT 'pending',
    ocr_status                 TEXT NOT NULL DEFAULT 'pending',
    analysis_status            TEXT NOT NULL DEFAULT 'pending',
    normalize_status           TEXT NOT NULL DEFAULT 'pending',
    next_retry_at              TIMESTAMPTZ,
    retry_count                INTEGER NOT NULL DEFAULT 0,
    last_error_code            TEXT,
    last_error_message         TEXT,
    updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS drug.import_stage_events (
    event_id        BIGSERIAL PRIMARY KEY,
    run_id          UUID REFERENCES drug.import_runs (run_id) ON DELETE SET NULL,
    license_id      TEXT REFERENCES drug.licenses (license_id) ON DELETE CASCADE,
    stage           TEXT NOT NULL,
    from_status     TEXT,
    to_status       TEXT NOT NULL,
    error_code      TEXT,
    error_message   TEXT,
    payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS drug.enrichment_queue (
    queue_id             BIGSERIAL PRIMARY KEY,
    license_id           TEXT NOT NULL REFERENCES drug.licenses (license_id) ON DELETE CASCADE,
    reason               TEXT NOT NULL,
    priority             INTEGER NOT NULL DEFAULT 100,
    status               TEXT NOT NULL DEFAULT 'pending',
    available_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    claimed_at           TIMESTAMPTZ,
    claimed_by           TEXT,
    attempt_count        INTEGER NOT NULL DEFAULT 0,
    last_error_message   TEXT
);

CREATE INDEX IF NOT EXISTS idx_drug_license_token ON drug.licenses (license_token);
CREATE INDEX IF NOT EXISTS idx_drug_active_listed ON drug.licenses (is_listed, is_active);
CREATE INDEX IF NOT EXISTS idx_drug_snapshot ON drug.licenses (snapshot_id);
CREATE INDEX IF NOT EXISTS idx_drug_name_fts ON drug.licenses
    USING GIN (to_tsvector('simple',
        COALESCE(chinese_name,'') || ' ' ||
        COALESCE(english_name,'') || ' ' ||
        COALESCE(indications_text,'') || ' ' ||
        COALESCE(main_ingredient_summary,'')));
CREATE INDEX IF NOT EXISTS idx_drug_ingredient_license ON drug.ingredients (license_id);
CREATE INDEX IF NOT EXISTS idx_drug_ingredient_fts ON drug.ingredients
    USING GIN (to_tsvector('simple', COALESCE(name,'') || ' ' || COALESCE(raw_text,'')));
CREATE INDEX IF NOT EXISTS idx_drug_atc_code ON drug.atc (code);
CREATE INDEX IF NOT EXISTS idx_drug_einsert_scraped ON drug.electronic_inserts (scraped_at);
CREATE INDEX IF NOT EXISTS idx_drug_appearance_license ON drug.appearance_records (license_id);
CREATE INDEX IF NOT EXISTS idx_drug_asset_license_group ON drug.assets (license_id, asset_group);
CREATE INDEX IF NOT EXISTS idx_drug_asset_storage_status ON drug.assets (storage_status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_drug_insert_analysis_source
    ON drug.insert_analysis (source_asset_id);
CREATE INDEX IF NOT EXISTS idx_drug_insert_analysis_license
    ON drug.insert_analysis (license_id);
CREATE INDEX IF NOT EXISTS idx_drug_insert_analysis_status
    ON drug.insert_analysis (analysis_status, ocr_status);
CREATE INDEX IF NOT EXISTS idx_drug_state_retry ON drug.import_license_state (next_retry_at);
CREATE INDEX IF NOT EXISTS idx_drug_queue_status_available
    ON drug.enrichment_queue (status, available_at, priority DESC);
-- Prevent duplicate pending queue entries for the same license.
-- Multiple entries in other statuses (partial_success, success, etc.) are fine.
CREATE UNIQUE INDEX IF NOT EXISTS idx_drug_enrichment_queue_pending_unique
    ON drug.enrichment_queue (license_id)
    WHERE status = 'pending';

-- ============================================================
-- HEALTH FOOD (Taiwan FDA)
-- ============================================================
CREATE SCHEMA IF NOT EXISTS health_supplements;

CREATE TABLE IF NOT EXISTS health_supplements.items (
    permit_no       TEXT PRIMARY KEY,
    name            TEXT,
    applicant       TEXT,
    benefit_claims  TEXT,
    valid_from      TEXT,
    valid_to        TEXT,
    category        TEXT
);

CREATE TABLE IF NOT EXISTS health_supplements.sync_meta (
    key         TEXT PRIMARY KEY,
    value       TEXT,
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hs_fts ON health_supplements.items
    USING GIN (to_tsvector('simple',
        COALESCE(name,'') || ' ' || COALESCE(benefit_claims,'')));

-- Embedding table for hybrid search
CREATE TABLE IF NOT EXISTS health_supplements.item_embeddings (
    permit_no   TEXT PRIMARY KEY,
    embedding   halfvec(1024),
    source_hash TEXT,
    embedded_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_hs_emb_hnsw ON health_supplements.item_embeddings
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
-- To switch models, set OLLAMA_EMBED_DIMENSIONS to the new size and re-run
-- embeddings from the admin console (Modules → re-embed).
-- The loader will ALTER TABLE all embedding columns to the new dimension automatically.
CREATE TABLE IF NOT EXISTS food_nutrition.food_embeddings (
    sample_name  TEXT PRIMARY KEY,
    embedding    halfvec(1024),
    source_hash  TEXT,
    embedded_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_fn_emb_hnsw ON food_nutrition.food_embeddings
    USING hnsw (embedding halfvec_cosine_ops);

-- Embedding table for food_nutrition.ingredients
CREATE TABLE IF NOT EXISTS food_nutrition.ingredient_embeddings (
    id           INTEGER PRIMARY KEY,
    embedding    halfvec(1024),
    source_hash  TEXT,
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
    source_hash TEXT,
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
    source_hash TEXT,
    embedded_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_gl_emb_hnsw ON guideline.guideline_embeddings
    USING hnsw (embedding halfvec_cosine_ops);


-- ============================================================
-- TWCORE IG
-- ============================================================
-- Multi-IG FHIR storage (Phase 0). Replaces the former single-IG `twcore.*`
-- schema. Every artifact/codesystem/concept is scoped to an IG package so the
-- platform can hold many IG packages (TW Core, US Core, IPS, HL7 THO, base
-- FHIR, ...) without artifact_key / cs_id collisions. `fhir.ig_packages` is the
-- registry of installed packages.
CREATE SCHEMA IF NOT EXISTS fhir;

CREATE TABLE IF NOT EXISTS fhir.ig_packages (
    package_id      TEXT NOT NULL,
    version         TEXT NOT NULL,
    canonical       TEXT,
    fhir_version    TEXT,
    title           TEXT,
    status          TEXT,
    is_default      BOOLEAN NOT NULL DEFAULT FALSE,
    dependencies    JSONB,          -- {packageId: version, ...} from package.json
    imported_at     TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (package_id, version)
);

-- At most one package may be flagged the default.
CREATE UNIQUE INDEX IF NOT EXISTS idx_fhir_ig_packages_one_default
    ON fhir.ig_packages ((is_default)) WHERE is_default;

CREATE TABLE IF NOT EXISTS fhir.codesystems (
    package_id      TEXT NOT NULL,
    package_version TEXT NOT NULL,
    cs_id           TEXT NOT NULL,
    name            TEXT,
    category        TEXT,
    fetched_at      TIMESTAMPTZ,
    concept_count   INTEGER,
    PRIMARY KEY (package_id, package_version, cs_id),
    FOREIGN KEY (package_id, package_version)
        REFERENCES fhir.ig_packages (package_id, version) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS fhir.concepts (
    id              BIGSERIAL PRIMARY KEY,
    package_id      TEXT NOT NULL,
    package_version TEXT NOT NULL,
    cs_id           TEXT NOT NULL,
    code            TEXT NOT NULL,
    display         TEXT,
    definition      TEXT,
    FOREIGN KEY (package_id, package_version, cs_id)
        REFERENCES fhir.codesystems (package_id, package_version, cs_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS fhir.artifacts (
    package_id      TEXT NOT NULL,
    package_version TEXT NOT NULL,
    artifact_key    TEXT NOT NULL,
    resource_type   TEXT NOT NULL,
    artifact_id     TEXT,
    canonical_url   TEXT,
    name            TEXT,
    title           TEXT,
    status          TEXT,
    kind            TEXT,
    base_type       TEXT,
    derivation      TEXT,
    grouping_id     TEXT,
    grouping_name   TEXT,
    description     TEXT,
    package_path    TEXT,
    child_count     INTEGER NOT NULL DEFAULT 0,
    concept_count   INTEGER NOT NULL DEFAULT 0,
    raw_json        JSONB,
    imported_at     TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (package_id, package_version, artifact_key),
    FOREIGN KEY (package_id, package_version)
        REFERENCES fhir.ig_packages (package_id, version) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_fhir_concepts_cs
    ON fhir.concepts (package_id, package_version, cs_id);
CREATE INDEX IF NOT EXISTS idx_fhir_concepts_code ON fhir.concepts (code);
CREATE INDEX IF NOT EXISTS idx_fhir_concepts_fts  ON fhir.concepts
    USING GIN (to_tsvector('simple',
        COALESCE(code,'') || ' ' || COALESCE(display,'')));
CREATE INDEX IF NOT EXISTS idx_fhir_artifacts_resource_type
    ON fhir.artifacts (resource_type);
CREATE INDEX IF NOT EXISTS idx_fhir_artifacts_base_type
    ON fhir.artifacts (base_type);
CREATE INDEX IF NOT EXISTS idx_fhir_artifacts_grouping
    ON fhir.artifacts (grouping_id);
CREATE INDEX IF NOT EXISTS idx_fhir_artifacts_canonical
    ON fhir.artifacts (canonical_url);
CREATE INDEX IF NOT EXISTS idx_fhir_artifacts_fts
    ON fhir.artifacts
    USING GIN (to_tsvector('simple',
        COALESCE(artifact_id,'') || ' ' || COALESCE(canonical_url,'') || ' ' ||
        COALESCE(name,'') || ' ' || COALESCE(title,'') || ' ' ||
        COALESCE(description,'')));


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
    language_code   TEXT,
    -- TRUE when the US English Language refset marks this description as the
    -- Preferred term — used to display the official preferred name instead of
    -- the shortest synonym.
    us_preferred    BOOLEAN NOT NULL DEFAULT FALSE
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

-- Historical associations (REPLACED BY / SAME AS / POSSIBLY EQUIVALENT TO …).
-- referenced_component_id is an INACTIVE concept (deliberately not loaded into
-- snomed.concepts), so no FK here; target_component_id is its active successor.
-- Used to expand ValueSet filters whose anchor concept was retired upstream.
CREATE TABLE IF NOT EXISTS snomed.historical_associations (
    referenced_component_id BIGINT NOT NULL,
    target_component_id     BIGINT NOT NULL,
    refset_id               BIGINT NOT NULL,
    PRIMARY KEY (referenced_component_id, target_component_id, refset_id)
);
CREATE INDEX IF NOT EXISTS idx_snomed_hist_assoc_ref
    ON snomed.historical_associations (referenced_component_id);

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
    source_hash TEXT,
    embedded_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_snomed_emb_hnsw ON snomed.concept_embeddings
    USING hnsw (embedding halfvec_cosine_ops);


-- ============================================================
-- RxNorm (reference terminology — IG ValueSet expansion only)
-- ============================================================
-- Concept-only import: one row per RXCUI (SAB=RXNORM), keeping the preferred
-- atom. Used to expand IG ValueSet filters such as `TTY in (SCD,SBD,GPCK,BPCK)`
-- into real codes in the admin preview. No relationships/interactions are loaded.
CREATE SCHEMA IF NOT EXISTS rxnorm;

CREATE TABLE IF NOT EXISTS rxnorm.concepts (
    rxcui     BIGINT PRIMARY KEY,
    name      TEXT NOT NULL,   -- RXNCONSO STR (preferred atom)
    tty       TEXT NOT NULL,   -- term type: SCD/SBD/GPCK/BPCK/IN/BN/…
    suppress  TEXT             -- RXNCONSO SUPPRESS flag (N/O/Y/E)
);
CREATE INDEX IF NOT EXISTS idx_rxnorm_concepts_tty ON rxnorm.concepts (tty);
CREATE INDEX IF NOT EXISTS idx_rxnorm_concepts_name_fts ON rxnorm.concepts
    USING GIN (to_tsvector('english', COALESCE(name, '')));
