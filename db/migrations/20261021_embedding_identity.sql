-- Embedding identity (2026-10): the system-wide embedding fingerprint (probe
-- vectors of the adopted model, single row id = 1) and per-endpoint fingerprint
-- check results. Used by node-server/src/admin/embeddingIdentity.ts, which also
-- creates these tables at runtime (CREATE TABLE IF NOT EXISTS, same DDL) as a
-- safety net. Idempotent; apply by hand on existing DBs (after
-- 20261016_llm_providers_and_routes.sql — admin.llm_providers must exist).

BEGIN;

-- System embedding identity: probe vectors of the adopted model (single row).
CREATE TABLE IF NOT EXISTS admin.embedding_identity (
    id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    version INTEGER NOT NULL DEFAULT 1,
    state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'switching')),
    model TEXT NOT NULL,
    provider TEXT NOT NULL,
    account_name TEXT NOT NULL DEFAULT '',
    dimensions INTEGER NOT NULL,
    probe_texts JSONB NOT NULL,
    probe_vectors JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by TEXT NOT NULL DEFAULT ''
);

-- Per (provider account, model, dimensions) fingerprint check against the identity.
CREATE TABLE IF NOT EXISTS admin.embedding_fingerprints (
    account_id BIGINT NOT NULL REFERENCES admin.llm_providers (id) ON DELETE CASCADE,
    model TEXT NOT NULL,
    dimensions INTEGER NOT NULL,
    identity_version INTEGER NOT NULL,
    ok BOOLEAN NOT NULL,
    min_similarity DOUBLE PRECISION,
    mean_similarity DOUBLE PRECISION,
    message TEXT NOT NULL DEFAULT '',
    checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (account_id, model, dimensions)
);

COMMIT;
