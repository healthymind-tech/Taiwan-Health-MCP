-- Provider accounts + composable profiles (2026-10).
--
-- Before: one admin.llm_profiles row = endpoint + key + model + knobs, and a
-- per-role strategy in app_settings.
-- After:
--   admin.llm_providers      — a named account of a provider type (several per
--                              type allowed): URL, credentials, account-wide limits.
--   admin.llm_routes         — a named profile: a strategy over members.
--   admin.llm_route_members  — one member = a model on a provider account (with
--                              its own knobs) OR another profile (nesting).
--   admin.llm_role_routes    — which profile each role (analysis / embedding) uses.
--
-- admin.llm_profiles is kept (renamed admin.llm_profiles_legacy) for rollback;
-- stats/log rows are re-keyed to the member that replaced each profile.

BEGIN;

CREATE TABLE IF NOT EXISTS admin.llm_providers (
    id          BIGSERIAL PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    provider    TEXT NOT NULL,                 -- registry id (providers/registry.ts)
    base_url    TEXT NOT NULL DEFAULT '',
    auth_type   TEXT NOT NULL DEFAULT 'api_key' CHECK (auth_type IN ('api_key', 'oauth', 'none')),
    api_key     TEXT NOT NULL DEFAULT '',
    oauth       JSONB NOT NULL DEFAULT '{}'::jsonb,   -- reserved: tokens for subscription logins
    enabled     BOOLEAN NOT NULL DEFAULT TRUE,
    params      JSONB NOT NULL DEFAULT '{}'::jsonb,   -- account-wide: rpm, tpm, base_model…
    last_test   JSONB,                                -- {ok, message, at, model_count}
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin.llm_routes (
    id          BIGSERIAL PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    kind        TEXT NOT NULL CHECK (kind IN ('analysis', 'embedding')),
    strategy    TEXT NOT NULL DEFAULT 'fallback'
                CHECK (strategy IN ('single', 'fallback', 'round_robin', 'load_balance')),
    description TEXT NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin.llm_route_members (
    id              BIGSERIAL PRIMARY KEY,
    route_id        BIGINT NOT NULL REFERENCES admin.llm_routes (id) ON DELETE CASCADE,
    position        INTEGER NOT NULL DEFAULT 0,
    member_type     TEXT NOT NULL CHECK (member_type IN ('model', 'route')),
    provider_id     BIGINT REFERENCES admin.llm_providers (id) ON DELETE RESTRICT,
    model           TEXT NOT NULL DEFAULT '',
    child_route_id  BIGINT REFERENCES admin.llm_routes (id) ON DELETE RESTRICT,
    weight          INTEGER NOT NULL DEFAULT 1 CHECK (weight >= 0),
    enabled         BOOLEAN NOT NULL DEFAULT TRUE,
    params          JSONB NOT NULL DEFAULT '{}'::jsonb,   -- model knobs (temperature, think, dimensions…)
    CHECK (
        (member_type = 'model' AND provider_id IS NOT NULL AND model <> '' AND child_route_id IS NULL)
     OR (member_type = 'route' AND child_route_id IS NOT NULL AND provider_id IS NULL)
    ),
    CHECK (child_route_id IS NULL OR child_route_id <> route_id)
);
CREATE INDEX IF NOT EXISTS idx_llm_route_members_route ON admin.llm_route_members (route_id, position);

CREATE TABLE IF NOT EXISTS admin.llm_role_routes (
    role        TEXT PRIMARY KEY CHECK (role IN ('analysis', 'embedding')),
    route_id    BIGINT REFERENCES admin.llm_routes (id) ON DELETE SET NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Data migration (only when the legacy table exists and nothing migrated yet) ──
DO $$
DECLARE
    r RECORD;
    prov_id BIGINT;
    top_id BIGINT;
    member_id BIGINT;
    strat TEXT;
    k TEXT;
    pos INTEGER;
BEGIN
    IF to_regclass('admin.llm_profiles') IS NULL OR EXISTS (SELECT 1 FROM admin.llm_routes) THEN
        RETURN;
    END IF;

    CREATE TEMP TABLE _profile_member (profile_id BIGINT PRIMARY KEY, member_id BIGINT) ON COMMIT DROP;

    FOREACH k IN ARRAY ARRAY['analysis', 'embedding'] LOOP
        IF NOT EXISTS (SELECT 1 FROM admin.llm_profiles WHERE kind = k) THEN
            CONTINUE;
        END IF;
        SELECT CASE WHEN value = 'weighted' THEN 'load_balance' ELSE 'fallback' END INTO strat
          FROM admin.app_settings WHERE group_key = k AND key = 'strategy';
        INSERT INTO admin.llm_routes (name, kind, strategy, description)
        VALUES (CASE k WHEN 'analysis' THEN '分析 LLM（預設）' ELSE 'Embedding（預設）' END,
                k, COALESCE(strat, 'fallback'), '由舊版端點設定自動轉換')
        RETURNING id INTO top_id;
        INSERT INTO admin.llm_role_routes (role, route_id) VALUES (k, top_id)
        ON CONFLICT (role) DO UPDATE SET route_id = EXCLUDED.route_id, updated_at = NOW();

        pos := 0;
        FOR r IN SELECT * FROM admin.llm_profiles WHERE kind = k ORDER BY priority, id LOOP
            -- One account per distinct (provider, url, key); named after the first profile using it.
            SELECT id INTO prov_id FROM admin.llm_providers
             WHERE provider = r.provider AND base_url = r.base_url AND api_key = r.api_key LIMIT 1;
            IF prov_id IS NULL THEN
                INSERT INTO admin.llm_providers (name, provider, base_url, auth_type, api_key, enabled, params)
                VALUES (
                    CASE WHEN EXISTS (SELECT 1 FROM admin.llm_providers WHERE name = r.name)
                         THEN r.name || '（' || k || '）' ELSE r.name END,
                    r.provider, r.base_url,
                    CASE WHEN r.api_key = '' THEN 'none' ELSE 'api_key' END,
                    r.api_key, TRUE,
                    jsonb_strip_nulls(jsonb_build_object('rpm', r.params->'rpm', 'tpm', r.params->'tpm'))
                )
                RETURNING id INTO prov_id;
            END IF;
            INSERT INTO admin.llm_route_members
                (route_id, position, member_type, provider_id, model, weight, enabled, params)
            VALUES (top_id, pos, 'model', prov_id, r.model, r.weight, r.enabled, r.params - 'rpm' - 'tpm')
            RETURNING id INTO member_id;
            INSERT INTO _profile_member VALUES (r.id, member_id);
            pos := pos + 1;
        END LOOP;
    END LOOP;

    -- Stats and call log were keyed by profile id; re-key them to the member.
    ALTER TABLE admin.llm_profile_stats DROP CONSTRAINT IF EXISTS llm_profile_stats_profile_id_fkey;
    ALTER TABLE admin.llm_call_log DROP CONSTRAINT IF EXISTS llm_call_log_profile_id_fkey;
    UPDATE admin.llm_profile_stats s SET profile_id = m.member_id FROM _profile_member m WHERE s.profile_id = m.profile_id;
    UPDATE admin.llm_call_log l SET profile_id = m.member_id FROM _profile_member m WHERE l.profile_id = m.profile_id;

    ALTER TABLE admin.llm_profiles RENAME TO llm_profiles_legacy;
END $$;

-- Fresh installs (no legacy table) still need the stats/log tables free of the old FK.
ALTER TABLE IF EXISTS admin.llm_profile_stats DROP CONSTRAINT IF EXISTS llm_profile_stats_profile_id_fkey;
ALTER TABLE IF EXISTS admin.llm_call_log DROP CONSTRAINT IF EXISTS llm_call_log_profile_id_fkey;

COMMIT;
