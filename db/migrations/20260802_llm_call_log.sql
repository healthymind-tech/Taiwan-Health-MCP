-- Per-call Analysis LM audit log, keyed by drug license.
--
-- Keeps the actual prompt (system + user messages) and the model's reply for
-- every callAnalysisLlm attempt, so the admin Drug Explorer can show an operator
-- exactly what was sent (including the system prompt) and what came back — the
-- reply is usually JSON, which the UI renders with a JSON viewer. Recording is
-- observability: a write failure is logged and swallowed, never propagated.
--
-- Applied idempotently at boot (ensureLlmCallLogSchema); fresh installs get it
-- from db/schema.sql.

CREATE TABLE IF NOT EXISTS admin.llm_call_log (
    id                BIGSERIAL PRIMARY KEY,
    license_id        TEXT NOT NULL,
    attempt           INTEGER NOT NULL DEFAULT 1,
    profile_id        BIGINT REFERENCES admin.llm_profiles (id) ON DELETE SET NULL,
    profile_name      TEXT NOT NULL DEFAULT '',
    model             TEXT NOT NULL DEFAULT '',
    provider          TEXT NOT NULL DEFAULT '',
    status            TEXT NOT NULL CHECK (status IN ('ok', 'budget', 'failed')),
    prompt_messages   JSONB NOT NULL,
    response_content  TEXT NOT NULL DEFAULT '',
    error             TEXT NOT NULL DEFAULT '',
    prompt_tokens     BIGINT NOT NULL DEFAULT 0,
    completion_tokens BIGINT NOT NULL DEFAULT 0,
    latency_ms        BIGINT NOT NULL DEFAULT 0,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_llm_call_log_license_created
    ON admin.llm_call_log (license_id, created_at DESC);
