-- Replace the enable_iua boolean on admin.fhir_servers with a mutually
-- exclusive auth_profile enum {none, iua, smart}, adding SMART on FHIR
-- (Backend Services) as a sibling to IUA.
-- Idempotent: safe on a fresh database or one already migrated.

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'admin' AND table_name = 'fhir_servers'
    ) THEN
        RETURN;  -- table created elsewhere with auth_profile already present
    END IF;

    ALTER TABLE admin.fhir_servers
        ADD COLUMN IF NOT EXISTS auth_profile TEXT NOT NULL DEFAULT 'none';

    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'admin'
          AND table_name = 'fhir_servers'
          AND column_name = 'enable_iua'
    ) THEN
        UPDATE admin.fhir_servers
            SET auth_profile = 'iua'
            WHERE enable_iua = TRUE AND auth_profile = 'none';
        ALTER TABLE admin.fhir_servers DROP COLUMN enable_iua;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.constraint_column_usage
        WHERE table_schema = 'admin'
          AND table_name = 'fhir_servers'
          AND constraint_name = 'fhir_servers_auth_profile_chk'
    ) THEN
        ALTER TABLE admin.fhir_servers
            ADD CONSTRAINT fhir_servers_auth_profile_chk
            CHECK (auth_profile IN ('none', 'iua', 'smart'));
    END IF;

    -- Token-endpoint client authentication method, for SMART Backend Services
    -- (client_secret_jwt / private_key_jwt) in addition to the default Basic.
    ALTER TABLE admin.fhir_servers
        ADD COLUMN IF NOT EXISTS token_auth_method TEXT
            NOT NULL DEFAULT 'client_secret_basic';
    ALTER TABLE admin.fhir_servers
        ADD COLUMN IF NOT EXISTS client_private_key_ciphertext BYTEA;
    ALTER TABLE admin.fhir_servers
        ADD COLUMN IF NOT EXISTS jwt_signing_alg TEXT;
    ALTER TABLE admin.fhir_servers
        ADD COLUMN IF NOT EXISTS jwt_kid TEXT;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.constraint_column_usage
        WHERE table_schema = 'admin'
          AND table_name = 'fhir_servers'
          AND constraint_name = 'fhir_servers_token_auth_method_chk'
    ) THEN
        ALTER TABLE admin.fhir_servers
            ADD CONSTRAINT fhir_servers_token_auth_method_chk
            CHECK (token_auth_method IN (
                'client_secret_basic', 'client_secret_post',
                'client_secret_jwt', 'private_key_jwt'
            ));
    END IF;
END $$;
