-- Per-profile Analysis LM call stats, aggregated into hour-aligned buckets.
--
-- Every completed callAnalysisLlm attempt against a profile is counted here:
-- successes, endpoint failures, and budget (finish_reason=length) failures are
-- kept distinct, because a budget failure means a looping / undersized model,
-- not a dead endpoint. Token usage and latency ride along so the admin UI can
-- show per-profile failure rate and token generation over the last 24h / 7d.
--
-- Rows are bounded at one per (profile_id, hour); stale buckets are pruned on
-- read. Applied idempotently at boot (ensureProfileStatsSchema); fresh installs
-- get it from db/schema.sql.

CREATE TABLE IF NOT EXISTS admin.llm_profile_stats (
    profile_id         BIGINT NOT NULL REFERENCES admin.llm_profiles (id) ON DELETE CASCADE,
    bucket             TIMESTAMPTZ NOT NULL,
    calls              BIGINT NOT NULL DEFAULT 0,
    failures           BIGINT NOT NULL DEFAULT 0,
    budget_failures    BIGINT NOT NULL DEFAULT 0,
    total_latency_ms   BIGINT NOT NULL DEFAULT 0,
    prompt_tokens      BIGINT NOT NULL DEFAULT 0,
    completion_tokens  BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (profile_id, bucket)
);
