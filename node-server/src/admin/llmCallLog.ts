/**
 * Per-call Analysis LM audit log, keyed by drug license.
 *
 * Unlike `llm_profile_stats` (aggregate counts), this keeps the actual prompt
 * (system + user messages) and the model's reply for every `callAnalysisLlm`
 * attempt, so the admin Drug Explorer can show an operator exactly what was sent
 * and what came back — including the raw JSON output. Recording is
 * observability, never correctness: a write failure is logged and swallowed so
 * it can never fail an LM call that already succeeded.
 *
 * Rows are intentionally small in schema and grow with real usage (one row per
 * attempt per license); no pruning yet — the explorer lists the newest first.
 */

import { query } from "../db.js";
import { logWarning } from "../logger.js";

export interface LlmCallAttemptRecord {
  licenseId: string;
  attempt: number;
  profileId: number;
  profileName: string;
  model: string;
  provider: string;
  status: "ok" | "budget" | "failed";
  promptMessages: Array<{ role: string; content: string }>;
  responseContent: string;
  error: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
}

/** Idempotent boot migration (fresh installs get the table from db/schema.sql). */
export async function ensureLlmCallLogSchema(): Promise<void> {
  await query(`CREATE TABLE IF NOT EXISTS admin.llm_call_log (
    id BIGSERIAL PRIMARY KEY,
    license_id TEXT NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 1,
    profile_id BIGINT REFERENCES admin.llm_profiles (id) ON DELETE SET NULL,
    profile_name TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    provider TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL CHECK (status IN ('ok', 'budget', 'failed')),
    prompt_messages JSONB NOT NULL,
    response_content TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    prompt_tokens BIGINT NOT NULL DEFAULT 0,
    completion_tokens BIGINT NOT NULL DEFAULT 0,
    latency_ms BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await query(
    `CREATE INDEX IF NOT EXISTS idx_llm_call_log_license_created
       ON admin.llm_call_log (license_id, created_at DESC)`,
  );
}

/** Store one LM attempt. Failure to record never propagates to the caller. */
export async function recordLlmCall(entry: LlmCallAttemptRecord): Promise<void> {
  try {
    await query(
      `INSERT INTO admin.llm_call_log
         (license_id, attempt, profile_id, profile_name, model, provider, status,
          prompt_messages, response_content, error, prompt_tokens, completion_tokens, latency_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13)`,
      [
        entry.licenseId,
        entry.attempt,
        entry.profileId,
        entry.profileName,
        entry.model,
        entry.provider,
        entry.status,
        JSON.stringify(entry.promptMessages),
        entry.responseContent,
        entry.error,
        entry.promptTokens,
        entry.completionTokens,
        entry.latencyMs,
      ],
    );
  } catch (err) {
    logWarning("llm_call_log_write_failed", {
      license_id: entry.licenseId,
      profile_id: entry.profileId,
      error: String(err),
    });
  }
}

interface CallLogSummaryRow {
  id: string | number;
  created_at: string | null;
  attempt: string | number;
  profile_name: string | null;
  model: string | null;
  provider: string | null;
  status: string | null;
  prompt_tokens: string | number | null;
  completion_tokens: string | number | null;
  latency_ms: string | number | null;
  response_content: string | null;
}

export interface LlmCallSummary {
  id: number;
  created_at: string | null;
  attempt: number;
  profileName: string;
  model: string;
  provider: string;
  status: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  /** True when the stored reply parses as JSON — the UI renders a JSON viewer. */
  isJson: boolean;
}

function summaryOf(row: CallLogSummaryRow): LlmCallSummary {
  const content = row.response_content ?? "";
  let isJson = false;
  if (content.trim()) {
    try {
      JSON.parse(content);
      isJson = true;
    } catch {
      /* not JSON — text view */
    }
  }
  return {
    id: Number(row.id),
    created_at: row.created_at,
    attempt: Number(row.attempt),
    profileName: row.profile_name ?? "",
    model: row.model ?? "",
    provider: row.provider ?? "",
    status: row.status ?? "ok",
    promptTokens: Number(row.prompt_tokens ?? 0),
    completionTokens: Number(row.completion_tokens ?? 0),
    latencyMs: Number(row.latency_ms ?? 0),
    isJson,
  };
}

/** Newest-first summaries for one license (no full message bodies). */
export async function listDrugLlmCalls(
  licenseId: string,
  limit = 100,
): Promise<LlmCallSummary[]> {
  const res = await query<CallLogSummaryRow>(
    `SELECT id, created_at::text, attempt, profile_name, model, provider, status,
            prompt_tokens, completion_tokens, latency_ms, response_content
       FROM admin.llm_call_log
      WHERE license_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT $2`,
    [licenseId, limit],
  );
  return res.rows.map(summaryOf);
}

export interface LlmCallDetail {
  id: number;
  licenseId: string;
  attempt: number;
  profileName: string;
  model: string;
  provider: string;
  status: string;
  promptMessages: Array<{ role: string; content: string }>;
  responseContent: string;
  error: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  createdAt: string | null;
}

interface CallLogRow extends CallLogSummaryRow {
  license_id: string;
  prompt_messages: unknown;
  error: string;
}

/** Full record for one call (system + user prompts, reply, error). */
export async function getDrugLlmCall(id: number): Promise<LlmCallDetail | null> {
  const res = await query<CallLogRow>(
    `SELECT id, license_id, created_at::text, attempt, profile_name, model, provider,
            status, prompt_messages, response_content, error,
            prompt_tokens, completion_tokens, latency_ms
       FROM admin.llm_call_log
      WHERE id = $1`,
    [id],
  );
  const row = res.rows[0];
  if (!row) return null;
  const messages = Array.isArray(row.prompt_messages)
    ? (row.prompt_messages as Array<{ role: string; content: string }>)
    : [];
  return {
    id: Number(row.id),
    licenseId: row.license_id,
    attempt: Number(row.attempt),
    profileName: row.profile_name ?? "",
    model: row.model ?? "",
    provider: row.provider ?? "",
    status: row.status ?? "ok",
    promptMessages: messages,
    responseContent: row.response_content ?? "",
    error: row.error ?? "",
    promptTokens: Number(row.prompt_tokens ?? 0),
    completionTokens: Number(row.completion_tokens ?? 0),
    latencyMs: Number(row.latency_ms ?? 0),
    createdAt: row.created_at,
  };
}
