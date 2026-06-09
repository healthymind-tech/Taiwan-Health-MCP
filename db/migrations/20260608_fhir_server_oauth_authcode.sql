-- OAuth2 Authorization Code (+ PKCE) flow support for external FHIR servers.
-- Adds 'oauth2_authorization_code' to the auth_type CHECK, an
-- authorization_endpoint column, and a per-server token-state table holding the
-- ephemeral PKCE state plus the encrypted access/refresh tokens.
-- Idempotent: safe on a fresh database or one already migrated.

DO $$
DECLARE
    auth_type_chk TEXT;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'admin' AND table_name = 'fhir_servers'
    ) THEN
        RETURN;  -- table created elsewhere (schema.sql) already up to date
    END IF;

    -- Extend the auth_type CHECK. The original constraint is an unnamed inline
    -- CHECK; look it up and drop it, then add a named replacement.
    SELECT con.conname INTO auth_type_chk
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'admin'
      AND rel.relname = 'fhir_servers'
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%auth_type%'
    LIMIT 1;
    IF auth_type_chk IS NOT NULL THEN
        EXECUTE format(
            'ALTER TABLE admin.fhir_servers DROP CONSTRAINT %I', auth_type_chk
        );
    END IF;
    ALTER TABLE admin.fhir_servers
        ADD CONSTRAINT fhir_servers_auth_type_chk
        CHECK (auth_type IN (
            'none', 'oauth2_client_credentials', 'oauth2_authorization_code'
        ));

    -- Authorization Code authorize endpoint (auth-code only; nullable).
    ALTER TABLE admin.fhir_servers
        ADD COLUMN IF NOT EXISTS authorization_endpoint TEXT;

    -- Per-server OAuth token state (pending PKCE + active encrypted tokens).
    CREATE TABLE IF NOT EXISTS admin.fhir_server_oauth_tokens (
        fhir_server_oauth_token_id BIGSERIAL PRIMARY KEY,
        fhir_server_id UUID NOT NULL REFERENCES admin.fhir_servers (fhir_server_id)
            ON DELETE CASCADE,
        admin_user TEXT NOT NULL,
        state_nonce TEXT UNIQUE,
        code_verifier TEXT,
        redirect_uri TEXT,
        requested_scope TEXT,
        pending_created_at TIMESTAMPTZ,
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

    CREATE INDEX IF NOT EXISTS idx_admin_fhir_server_oauth_tokens_server
        ON admin.fhir_server_oauth_tokens (fhir_server_id);
    CREATE INDEX IF NOT EXISTS idx_admin_fhir_server_oauth_tokens_pending
        ON admin.fhir_server_oauth_tokens (pending_created_at)
        WHERE state_nonce IS NOT NULL;
END $$;
