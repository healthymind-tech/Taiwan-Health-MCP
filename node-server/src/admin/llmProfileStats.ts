/**
 * Per-profile Analysis LM call stats, aggregated into hour-aligned buckets.
 *
 * Recording lives here rather than in `llmProfiles.ts` so the hot path stays one
 * upsert per completed call and the read side (admin API) has a single owner.
 * A budget failure (finish_reason=length) is counted separately from an endpoint
 * failure: it means a looping / undersized model, not a dead server, and feeding
 * it to the circuit breaker would take a working endpoint out of rotation.
 *
 * Stats are observability, never correctness: a write failure is logged and
 * swallowed so recording can never fail an LM call that already succeeded.
 * Rows are bounded at one per (profile_id, hour); stale buckets are pruned on read.
 */

import { query } from "../db.js";
import { logWarning } from "../logger.js";

export interface LlmCallUsage {
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
}

const BUCKET_MS = 3_600_000;

/** Idempotent boot migration (fresh installs get the table from db/schema.sql). */
export async function ensureProfileStatsSchema(): Promise<void> {
  await query(`CREATE TABLE IF NOT EXISTS admin.llm_profile_stats (
    profile_id BIGINT NOT NULL REFERENCES admin.llm_profiles (id) ON DELETE CASCADE,
    bucket TIMESTAMPTZ NOT NULL,
    calls BIGINT NOT NULL DEFAULT 0,
    failures BIGINT NOT NULL DEFAULT 0,
    budget_failures BIGINT NOT NULL DEFAULT 0,
    total_latency_ms BIGINT NOT NULL DEFAULT 0,
    prompt_tokens BIGINT NOT NULL DEFAULT 0,
    completion_tokens BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (profile_id, bucket)
  )`);
}

let recordingEnabled = true;
/** Unit tests switch this off so they never touch the database. */
export function setProfileStatsEnabled(enabled: boolean): void {
  recordingEnabled = enabled;
}

export interface ProfileCallResult {
  ok: boolean;
  budgetFailure: boolean;
  usage: LlmCallUsage | null;
}

/** Count one completed attempt against its profile's hour bucket. */
export async function recordProfileStats(profileId: number, result: ProfileCallResult): Promise<void> {
  if (!recordingEnabled) return;
  const bucket = new Date(Math.floor(Date.now() / BUCKET_MS) * BUCKET_MS);
  const usage = result.usage;
  try {
    await query(
      `INSERT INTO admin.llm_profile_stats
         (profile_id, bucket, calls, failures, budget_failures, total_latency_ms, prompt_tokens, completion_tokens)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (profile_id, bucket) DO UPDATE SET
         calls = admin.llm_profile_stats.calls + EXCLUDED.calls,
         failures = admin.llm_profile_stats.failures + EXCLUDED.failures,
         budget_failures = admin.llm_profile_stats.budget_failures + EXCLUDED.budget_failures,
         total_latency_ms = admin.llm_profile_stats.total_latency_ms + EXCLUDED.total_latency_ms,
         prompt_tokens = admin.llm_profile_stats.prompt_tokens + EXCLUDED.prompt_tokens,
         completion_tokens = admin.llm_profile_stats.completion_tokens + EXCLUDED.completion_tokens`,
      [
        profileId,
        bucket.toISOString(),
        1,
        result.ok ? 0 : 1,
        result.budgetFailure ? 1 : 0,
        usage?.latencyMs ?? 0,
        usage?.promptTokens ?? 0,
        usage?.completionTokens ?? 0,
      ],
    );
  } catch (err) {
    logWarning("llm_profile_stats_write_failed", { profile_id: profileId, error: String(err) });
  }
}

export interface ProfileStatsWindow {
  calls: number;
  failures: number;
  budgetFailures: number;
  avgLatencyMs: number | null;
  promptTokens: number;
  completionTokens: number;
}

export interface ProfileStats {
  window24h: ProfileStatsWindow;
  window7d: ProfileStatsWindow;
}

interface StatsRow {
  profile_id: string | number;
  c24: string | number | null;
  f24: string | number | null;
  b24: string | number | null;
  l24: string | number | null;
  p24: string | number | null;
  o24: string | number | null;
  c7: string | number | null;
  f7: string | number | null;
  b7: string | number | null;
  l7: string | number | null;
  p7: string | number | null;
  o7: string | number | null;
}

function windowOf(row: StatsRow, suffix: "24" | "7"): ProfileStatsWindow {
  const c = Number(row[`c${suffix}` as keyof StatsRow] ?? 0);
  const l = Number(row[`l${suffix}` as keyof StatsRow] ?? 0);
  return {
    calls: c,
    failures: Number(row[`f${suffix}` as keyof StatsRow] ?? 0),
    budgetFailures: Number(row[`b${suffix}` as keyof StatsRow] ?? 0),
    avgLatencyMs: c > 0 ? Math.round(l / c) : null,
    promptTokens: Number(row[`p${suffix}` as keyof StatsRow] ?? 0),
    completionTokens: Number(row[`o${suffix}` as keyof StatsRow] ?? 0),
  };
}

/** Aggregated per-profile stats for the last 24h and 7d; prunes stale buckets. */
export async function readProfileStats(): Promise<Map<number, ProfileStats>> {
  await query(`DELETE FROM admin.llm_profile_stats WHERE bucket < NOW() - interval '14 days'`);
  const res = await query<StatsRow>(
    `SELECT profile_id,
            SUM(calls) FILTER (WHERE bucket >= NOW() - interval '24 hours') AS c24,
            SUM(failures) FILTER (WHERE bucket >= NOW() - interval '24 hours') AS f24,
            SUM(budget_failures) FILTER (WHERE bucket >= NOW() - interval '24 hours') AS b24,
            SUM(total_latency_ms) FILTER (WHERE bucket >= NOW() - interval '24 hours') AS l24,
            SUM(prompt_tokens) FILTER (WHERE bucket >= NOW() - interval '24 hours') AS p24,
            SUM(completion_tokens) FILTER (WHERE bucket >= NOW() - interval '24 hours') AS o24,
            SUM(calls) FILTER (WHERE bucket >= NOW() - interval '7 days') AS c7,
            SUM(failures) FILTER (WHERE bucket >= NOW() - interval '7 days') AS f7,
            SUM(budget_failures) FILTER (WHERE bucket >= NOW() - interval '7 days') AS b7,
            SUM(total_latency_ms) FILTER (WHERE bucket >= NOW() - interval '7 days') AS l7,
            SUM(prompt_tokens) FILTER (WHERE bucket >= NOW() - interval '7 days') AS p7,
            SUM(completion_tokens) FILTER (WHERE bucket >= NOW() - interval '7 days') AS o7
       FROM admin.llm_profile_stats
      GROUP BY profile_id`,
  );
  const map = new Map<number, ProfileStats>();
  for (const row of res.rows) {
    map.set(Number(row.profile_id), {
      window24h: windowOf(row, "24"),
      window7d: windowOf(row, "7"),
    });
  }
  return map;
}
