-- Multiple LLM endpoints per role, with failover / weighted load balancing.
--
-- Replaces the single endpoint that used to live in admin.app_settings groups
-- `analysis` and `embedding`. Those groups keep only what is genuinely global
-- (the selection strategy, retry budget, timeout and batch size); the endpoint
-- itself, its key, its model and its per-model parameters now live here, one row
-- per profile.
--
-- kind:     which role the profile serves ('analysis' | 'embedding')
-- priority: failover order, lowest first
-- weight:   share of traffic under the weighted strategy (ignored by failover)
-- params:   role-specific knobs — analysis: {temperature, max_tokens};
--           embedding: {dimensions}

CREATE TABLE IF NOT EXISTS admin.llm_profiles (
    id          BIGSERIAL PRIMARY KEY,
    kind        TEXT NOT NULL CHECK (kind IN ('analysis', 'embedding')),
    name        TEXT NOT NULL,
    provider    TEXT NOT NULL,
    base_url    TEXT NOT NULL DEFAULT '',
    api_key     TEXT NOT NULL DEFAULT '',
    model       TEXT NOT NULL DEFAULT '',
    enabled     BOOLEAN NOT NULL DEFAULT TRUE,
    priority    INTEGER NOT NULL DEFAULT 100,
    weight      INTEGER NOT NULL DEFAULT 1 CHECK (weight >= 0),
    params      JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (kind, name)
);

CREATE INDEX IF NOT EXISTS idx_llm_profiles_kind_enabled
    ON admin.llm_profiles (kind, enabled, priority);

-- Carry an already-configured single endpoint over as the first profile, so an
-- existing install keeps working without the operator re-entering anything.
INSERT INTO admin.llm_profiles (kind, name, provider, base_url, api_key, model, enabled, priority, weight, params)
SELECT
    'analysis',
    'Default',
    COALESCE(MAX(value) FILTER (WHERE key = 'provider'), 'openai'),
    COALESCE(MAX(value) FILTER (WHERE key = 'base_url'), ''),
    COALESCE(MAX(value) FILTER (WHERE key = 'api_key'), ''),
    COALESCE(MAX(value) FILTER (WHERE key = 'model'), ''),
    TRUE,
    10,
    1,
    jsonb_build_object(
        'temperature', COALESCE(MAX(value) FILTER (WHERE key = 'temperature'), '0.1')::numeric,
        'max_tokens', COALESCE(MAX(value) FILTER (WHERE key = 'max_tokens'), '4096')::int
    )
FROM admin.app_settings
WHERE group_key = 'analysis'
HAVING COALESCE(MAX(value) FILTER (WHERE key = 'base_url'), '') <> ''
   AND COALESCE(MAX(value) FILTER (WHERE key = 'model'), '') <> ''
ON CONFLICT (kind, name) DO NOTHING;

INSERT INTO admin.llm_profiles (kind, name, provider, base_url, api_key, model, enabled, priority, weight, params)
SELECT
    'embedding',
    'Default',
    COALESCE(MAX(value) FILTER (WHERE key = 'provider'), 'ollama'),
    COALESCE(MAX(value) FILTER (WHERE key = 'base_url'), ''),
    COALESCE(MAX(value) FILTER (WHERE key = 'api_key'), ''),
    COALESCE(MAX(value) FILTER (WHERE key = 'model'), ''),
    TRUE,
    10,
    1,
    jsonb_build_object(
        'dimensions', COALESCE(NULLIF(MAX(value) FILTER (WHERE key = 'dimensions'), ''), '1024')::int
    )
FROM admin.app_settings
WHERE group_key = 'embedding'
HAVING COALESCE(MAX(value) FILTER (WHERE key = 'model'), '') <> ''
ON CONFLICT (kind, name) DO NOTHING;

-- The endpoint keys are now owned by admin.llm_profiles; leaving copies behind
-- in app_settings would be a second source of truth for the same thing (and a
-- second copy of every API key).
DELETE FROM admin.app_settings
WHERE (group_key = 'analysis' AND key IN ('provider', 'base_url', 'api_key', 'model', 'temperature', 'max_tokens', 'prompt_path'))
   OR (group_key = 'embedding' AND key IN ('provider', 'base_url', 'api_key', 'model', 'dimensions'))
   OR (group_key = 'ocr' AND key = 'prompt_path');
