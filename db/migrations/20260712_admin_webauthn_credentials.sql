-- Passkeys / WebAuthn credentials for admin login (additional to the password).
-- Existing deployments run this once; fresh installs get it from schema.sql.
-- The Node app also creates this table idempotently on boot (webauthn.ts), so
-- applying this migration by hand is optional.

CREATE TABLE IF NOT EXISTS admin.webauthn_credentials (
    credential_id  TEXT PRIMARY KEY,
    username       TEXT NOT NULL,
    public_key     BYTEA NOT NULL,
    counter        BIGINT NOT NULL DEFAULT 0,
    transports     TEXT[],
    label          TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_admin_webauthn_credentials_user
    ON admin.webauthn_credentials (username);
