-- External FHIR Server registry for admin-managed MCP CRUD connections.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS admin;

CREATE TABLE IF NOT EXISTS admin.fhir_servers (
    fhir_server_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    server_key TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT,
    base_url TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    is_default BOOLEAN NOT NULL DEFAULT FALSE,
    auth_type TEXT NOT NULL DEFAULT 'none'
        CHECK (auth_type IN ('none', 'oauth2_client_credentials')),
    enable_iua BOOLEAN NOT NULL DEFAULT FALSE,
    auth_server_url TEXT,
    metadata_url TEXT,
    token_endpoint TEXT,
    use_metadata BOOLEAN NOT NULL DEFAULT TRUE,
    client_id TEXT,
    client_secret_ciphertext BYTEA,
    scope TEXT,
    resource TEXT,
    requested_token_type TEXT,
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

CREATE INDEX IF NOT EXISTS idx_admin_fhir_servers_enabled
    ON admin.fhir_servers (enabled, server_key);

CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_fhir_servers_single_default
    ON admin.fhir_servers (is_default)
    WHERE is_default = TRUE;

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

CREATE INDEX IF NOT EXISTS idx_admin_fhir_server_probe_history_server_ts
    ON admin.fhir_server_probe_history (fhir_server_id, checked_at DESC);

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

CREATE INDEX IF NOT EXISTS idx_admin_fhir_server_operation_logs_server_ts
    ON admin.fhir_server_operation_logs (fhir_server_id, created_at DESC);
