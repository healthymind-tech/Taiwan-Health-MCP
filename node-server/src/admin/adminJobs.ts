/**
 * Admin import-jobs + worker-heartbeats helpers.
 *
 * This chunk ports the read path consumed by the admin REST surface; the job
 * claim / step / control-state machine (admin_worker) lands in the worker
 * chunk. Faithful port of the relevant pieces of `src/admin_jobs.py`
 * (`WorkerHeartbeat`, `is_heartbeat_stale`, `list_worker_heartbeats`,
 * `_iso`, `_parse_jsonb`, and the worker-tuning env getters).
 */

import type pg from "pg";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { query, withTransaction, getPool } from "../db.js";
import { broadcast } from "./adminWs.js";

/**
 * SQL expression that renders a `timestamptz` column the way asyncpg + Python
 * `datetime.isoformat()` does. asyncpg always decodes timestamptz to a
 * UTC-aware datetime, so the offset is always `+00:00` and microseconds are
 * preserved (6 digits, never trimmed). node-pg, by contrast, parses
 * timestamptz into a millisecond-precision JS `Date` (losing microseconds), so
 * we render the ISO string in Postgres instead and post-process in JS.
 *
 * Output: `YYYY-MM-DDTHH:MM:SS.US` (microseconds always present here); the JS
 * `pyIso` helper drops the fractional part when it is all zeros to match
 * Python's isoformat (which omits the fraction when microsecond == 0).
 */
export function tsIsoExpr(col: string): string {
  return `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')`;
}

/**
 * Space-separated variant matching Python `str(datetime)` (== `isoformat(sep=' ')`)
 * — used where the endpoint serializes a datetime via `json.dumps(default=str)`
 * rather than calling `.isoformat()`. Same microsecond/`+00:00` rules; feed the
 * result through `pyIso` for the trailing-zero trim + offset suffix.
 */
export function tsStrExpr(col: string): string {
  return `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US')`;
}

/** Convert the `tsIsoExpr` text to Python `datetime.isoformat()` exactly. */
export function pyIso(text: string | null | undefined): string {
  if (text === null || text === undefined) return "";
  // Python: microsecond == 0 → no fractional part at all.
  const base = text.endsWith(".000000") ? text.slice(0, -7) : text;
  return `${base}+00:00`;
}

/** Mirror Python `_iso`: datetime → isoformat string, else "" for null. */
export function iso(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/**
 * Mirror Python `_parse_jsonb`. node-pg already parses jsonb columns into JS
 * objects (unlike asyncpg which returns raw strings), so this normalizes both
 * shapes to a plain object.
 */
export function parseJsonb(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  if (typeof value === "string") {
    try {
      const result = JSON.parse(value);
      return result && typeof result === "object" && !Array.isArray(result)
        ? (result as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}

export function adminWorkerStaleAfterSeconds(): number {
  return Number.parseInt(process.env.ADMIN_WORKER_STALE_AFTER_SECONDS ?? "45", 10);
}

/** Mirror Python `is_heartbeat_stale`. */
export function isHeartbeatStale(
  lastHeartbeatAt: Date | null,
  opts: { now?: Date; staleAfterSeconds?: number } = {},
): boolean {
  if (lastHeartbeatAt === null) return true;
  const now = opts.now ?? new Date();
  const threshold = opts.staleAfterSeconds || adminWorkerStaleAfterSeconds();
  return (now.getTime() - lastHeartbeatAt.getTime()) / 1000 > threshold;
}

export interface WorkerHeartbeatDict {
  worker_name: string;
  process_id: number;
  status: string;
  current_job_id: string;
  last_heartbeat_at: string;
  stale: boolean;
  details: Record<string, unknown>;
}

interface WorkerRow {
  worker_name: string | null;
  process_id: number | string | null;
  status: string | null;
  current_job_id: string | null;
  details_json: unknown;
  // Date drives staleness; the text form (UTC, microsecond) drives display.
  last_heartbeat_at: Date | null;
  last_heartbeat_iso: string | null;
}

function workerFromRow(row: WorkerRow, now: Date, staleAfterSeconds: number): WorkerHeartbeatDict {
  const last = row.last_heartbeat_at ?? null;
  return {
    worker_name: row.worker_name || "",
    process_id: Number(row.process_id || 0),
    status: row.status || "",
    current_job_id: row.current_job_id ? String(row.current_job_id) : "",
    last_heartbeat_at: pyIso(row.last_heartbeat_iso),
    stale: isHeartbeatStale(last, { now, staleAfterSeconds }),
    details: parseJsonb(row.details_json),
  };
}

/** Faithful port of `list_worker_heartbeats`. */
export async function listWorkerHeartbeats(): Promise<WorkerHeartbeatDict[]> {
  const now = new Date();
  const res = await query<WorkerRow>(
    `SELECT worker_name, process_id, status, current_job_id, details_json, last_heartbeat_at,
            ${tsIsoExpr("last_heartbeat_at")} AS last_heartbeat_iso
       FROM admin.worker_heartbeats
       ORDER BY worker_name`,
  );
  const stale = adminWorkerStaleAfterSeconds();
  return res.rows.map((row) => workerFromRow(row, now, stale));
}

// ── Worker lifecycle write helpers (W1: claim / heartbeat / reclaim / step / log) ──

/** Faithful port of `upsert_worker_heartbeat` (+ `worker_heartbeat` broadcast). */
export async function upsertWorkerHeartbeat(opts: {
  workerName: string;
  processId: number;
  status: string;
  currentJobId?: string;
  details?: Record<string, unknown>;
}): Promise<void> {
  const details = opts.details ?? {};
  const res = await query<{ last_heartbeat_iso: string | null }>(
    `INSERT INTO admin.worker_heartbeats (
       worker_name, process_id, status, current_job_id, details_json, last_heartbeat_at
     )
     VALUES ($1, $2, $3, NULLIF($4, '')::uuid, $5::jsonb, NOW())
     ON CONFLICT (worker_name) DO UPDATE SET
       process_id = EXCLUDED.process_id,
       status = EXCLUDED.status,
       current_job_id = EXCLUDED.current_job_id,
       details_json = EXCLUDED.details_json,
       last_heartbeat_at = NOW()
     RETURNING ${tsIsoExpr("last_heartbeat_at")} AS last_heartbeat_iso`,
    [opts.workerName, opts.processId, opts.status, opts.currentJobId ?? "", JSON.stringify(details)],
  );
  const iso = res.rows[0]?.last_heartbeat_iso ?? null;
  void broadcast("worker_heartbeat", {
    worker_name: opts.workerName,
    status: opts.status,
    current_job_id: opts.currentJobId || null,
    last_heartbeat_at: iso ? pyIso(iso) : "",
  });
}

/** Faithful port of `reclaim_stale_jobs`. Returns the number of jobs re-queued. */
export async function reclaimStaleJobs(opts: { workerName: string; staleMultiplier?: number }): Promise<number> {
  const effectiveSeconds = adminWorkerStaleAfterSeconds() * (opts.staleMultiplier ?? 2.0);
  return withTransaction(async (client) => {
    const rows = (
      await client.query<{ job_id: string; worker_name: string | null; job_type: string | null }>(
        `SELECT j.job_id, j.worker_name, j.job_type
           FROM admin.import_jobs j
          WHERE j.status = 'running'
            AND (
              NOT EXISTS (SELECT 1 FROM admin.worker_heartbeats wh WHERE wh.worker_name = j.worker_name)
              OR EXISTS (SELECT 1 FROM admin.worker_heartbeats wh
                          WHERE wh.worker_name = j.worker_name
                            AND wh.last_heartbeat_at < NOW() - ($1 * INTERVAL '1 second'))
            )
          FOR UPDATE SKIP LOCKED`,
        [effectiveSeconds],
      )
    ).rows;
    if (rows.length === 0) return 0;
    const jobIds = rows.map((r) => r.job_id);
    await client.query(
      `UPDATE admin.import_jobs
          SET status = 'queued', control_state = 'resume_requested',
              current_step = 'reclaimed_stale', updated_at = NOW()
        WHERE job_id = ANY($1::uuid[])`,
      [jobIds],
    );
    for (const row of rows) {
      await client.query(
        `INSERT INTO admin.import_job_logs (job_id, level, message, payload_json)
         VALUES ($1, 'warn', 'Job reclaimed from stale worker', $2::jsonb)`,
        [
          row.job_id,
          JSON.stringify({
            original_worker: row.worker_name || "",
            reclaimed_by: opts.workerName,
            job_type: row.job_type || "",
            stale_threshold_seconds: effectiveSeconds,
          }),
        ],
      );
    }
    return jobIds.length;
  });
}

/** Faithful port of `claim_next_job` (FOR UPDATE SKIP LOCKED). Returns the claimed job dict or null. */
export async function claimNextJob(opts: {
  workerName: string;
  supportedJobTypes?: string[];
  excludedJobTypes?: ReadonlySet<string>;
}): Promise<Record<string, unknown> | null> {
  let supported = opts.supportedJobTypes ?? sortedAdminJobTypes();
  if (opts.excludedJobTypes) supported = supported.filter((jt) => !opts.excludedJobTypes!.has(jt));
  if (supported.length === 0) return null;
  return withTransaction(async (client) => {
    const res = await client.query<JobRow>(
      `WITH next_job AS (
         SELECT job_id FROM admin.import_jobs
          WHERE status = 'queued'
            AND control_state = ANY($1::text[])
            AND job_type = ANY($2::text[])
          ORDER BY created_at, job_id
          FOR UPDATE SKIP LOCKED
          LIMIT 1
       ),
       upd AS (
         UPDATE admin.import_jobs j
            SET status = 'running',
                control_state = 'idle',
                current_step = CASE WHEN j.progress_current > 0 THEN 'resumed' ELSE 'claimed' END,
                worker_name = $3,
                claimed_at = NOW(),
                started_at = COALESCE(j.started_at, NOW()),
                attempt_count = j.attempt_count + 1,
                updated_at = NOW()
           FROM next_job
          WHERE j.job_id = next_job.job_id
          RETURNING j.*
       )
       SELECT *, ${JOB_ISO_COLS} FROM upd`,
      [["idle", "resume_requested"], supported, opts.workerName],
    );
    if (res.rows.length === 0) return null;
    const row = res.rows[0];
    await client.query(
      `INSERT INTO admin.import_job_logs (job_id, level, message, payload_json)
       VALUES ($1, 'info', 'Job claimed by worker', $2::jsonb)`,
      [row.job_id, JSON.stringify({ worker_name: opts.workerName })],
    );
    return jobToDict(row);
  });
}

/** Faithful port of `record_job_step` (+ `job_step_updated` broadcast). */
export async function recordJobStep(opts: {
  jobId: string;
  stepKey: string;
  status: string;
  progressCurrent?: number;
  progressTotal?: number;
  checkpoint?: Record<string, unknown>;
  lastErrorMessage?: string;
}): Promise<void> {
  const checkpoint = opts.checkpoint ?? {};
  const res = await query<{ finished_iso: string | null }>(
    `INSERT INTO admin.import_job_steps (
       job_id, step_key, status, progress_current, progress_total,
       started_at, finished_at, checkpoint_json, last_error_message
     )
     VALUES (
       $1, $2, $3, $4, $5, NOW(),
       CASE WHEN $3 IN ('success','partial_success','retryable_failed','permanent_failed','paused','stopped','cancelled')
            THEN NOW() ELSE NULL END,
       $6::jsonb, NULLIF($7, '')
     )
     ON CONFLICT (job_id, step_key) DO UPDATE SET
       status = EXCLUDED.status,
       progress_current = EXCLUDED.progress_current,
       progress_total = EXCLUDED.progress_total,
       checkpoint_json = EXCLUDED.checkpoint_json,
       last_error_message = EXCLUDED.last_error_message,
       finished_at = EXCLUDED.finished_at
     RETURNING ${tsIsoExpr("finished_at")} AS finished_iso`,
    [opts.jobId, opts.stepKey, opts.status, opts.progressCurrent ?? 0, opts.progressTotal ?? 0, JSON.stringify(checkpoint), opts.lastErrorMessage ?? ""],
  );
  const finishedIso = res.rows[0]?.finished_iso ?? null;
  void broadcast("job_step_updated", {
    job_id: opts.jobId,
    step_key: opts.stepKey,
    status: opts.status,
    progress_current: opts.progressCurrent ?? 0,
    progress_total: opts.progressTotal ?? 0,
    finished_at: finishedIso ? pyIso(finishedIso) : null,
  });
}

/** Faithful port of `append_job_log` (+ `job_log_line` broadcast). */
export async function appendJobLog(opts: {
  jobId: string;
  level: string;
  message: string;
  payload?: Record<string, unknown>;
}): Promise<void> {
  const payload = opts.payload ?? {};
  const res = await query<{ created_iso: string | null }>(
    `INSERT INTO admin.import_job_logs (job_id, level, message, payload_json)
     VALUES ($1, $2, $3, $4::jsonb)
     RETURNING ${tsIsoExpr("created_at")} AS created_iso`,
    [opts.jobId, opts.level, opts.message, JSON.stringify(payload)],
  );
  const createdIso = res.rows[0]?.created_iso ?? null;
  void broadcast("job_log_line", {
    job_id: opts.jobId,
    level: opts.level,
    message: opts.message,
    payload,
    timestamp: createdIso ? pyIso(createdIso) : pyIso(null),
  });
}

// ── Import jobs read path (mirrors AdminJob / list_jobs / get_job / steps) ────

const FINAL_JOB_STATUSES = new Set([
  "success",
  "partial_success",
  "retryable_failed",
  "permanent_failed",
  "stopped",
  "cancelled",
]);

/** Faithful port of `available_job_actions`. */
export function availableJobActions(status: string, controlState: string): string[] {
  status = (status || "").trim();
  controlState = (controlState || "").trim();
  if (status === "queued") {
    return controlState === "idle" ? ["pause", "stop", "restart"] : [];
  }
  if (status === "running") {
    if (controlState === "idle" || controlState === "resume_requested") return ["pause", "stop", "restart"];
    return [];
  }
  if (status === "paused") return ["resume", "stop", "restart"];
  if (FINAL_JOB_STATUSES.has(status)) return ["restart"];
  return [];
}

interface JobRow {
  job_id: string;
  module_key: string | null;
  job_type: string | null;
  requested_by: string | null;
  status: string | null;
  control_state: string | null;
  progress_current: number | string | null;
  progress_total: number | string | null;
  current_step: string | null;
  worker_name: string | null;
  created_at_iso: string | null;
  started_at_iso: string | null;
  finished_at_iso: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  job_options_json: unknown;
  result_summary_json: unknown;
}

/** Mirror AdminJob.from_row + to_dict. */
function jobToDict(row: JobRow): Record<string, unknown> {
  const status = row.status || "";
  const controlState = row.control_state || "";
  return {
    job_id: String(row.job_id),
    module_key: row.module_key || "",
    job_type: row.job_type || "",
    requested_by: row.requested_by || "",
    status,
    control_state: controlState,
    progress_current: Number(row.progress_current || 0),
    progress_total: Number(row.progress_total || 0),
    current_step: row.current_step || "",
    worker_name: row.worker_name || "",
    created_at: row.created_at_iso === null ? "" : pyIso(row.created_at_iso),
    started_at: row.started_at_iso === null ? "" : pyIso(row.started_at_iso),
    finished_at: row.finished_at_iso === null ? "" : pyIso(row.finished_at_iso),
    last_error_code: row.last_error_code || "",
    last_error_message: row.last_error_message || "",
    job_options: parseJsonb(row.job_options_json),
    result_summary: parseJsonb(row.result_summary_json),
    available_actions: availableJobActions(status, controlState),
  };
}

const JOB_ISO_COLS = `${tsIsoExpr("created_at")} AS created_at_iso,
            ${tsIsoExpr("started_at")} AS started_at_iso,
            ${tsIsoExpr("finished_at")} AS finished_at_iso`;

/** Faithful port of `list_jobs`. */
export async function listJobs(limit = 50): Promise<Record<string, unknown>[]> {
  const res = await query<JobRow>(
    `SELECT *, ${JOB_ISO_COLS}
       FROM admin.import_jobs
       ORDER BY created_at DESC
       LIMIT $1`,
    [limit],
  );
  return res.rows.map(jobToDict);
}

/** Faithful port of `get_job`. */
export async function getJob(jobId: string): Promise<Record<string, unknown> | null> {
  const res = await query<JobRow>(
    `SELECT *, ${JOB_ISO_COLS}
       FROM admin.import_jobs
       WHERE job_id = $1`,
    [jobId],
  );
  if (res.rows.length === 0) return null;
  return jobToDict(res.rows[0]);
}

interface StepRow {
  job_step_id: number | string;
  job_id: string;
  step_key: string | null;
  status: string | null;
  progress_current: number | string | null;
  progress_total: number | string | null;
  started_at_iso: string | null;
  finished_at_iso: string | null;
  checkpoint_json: unknown;
  last_error_message: string | null;
}

interface LogRow {
  job_log_id: number | string;
  job_id: string;
  level: string | null;
  message: string | null;
  payload_json: unknown;
  created_at_iso: string | null;
}

/**
 * Faithful port of `list_job_logs`. Cursor-based: when `beforeId` is given only
 * rows with job_log_id < beforeId are returned; results are always ascending.
 */
export async function listJobLogs(
  jobId: string,
  opts: { limit?: number; beforeId?: number | null } = {},
): Promise<Record<string, unknown>[]> {
  const limit = opts.limit ?? 100;
  const beforeId = opts.beforeId ?? null;
  const isoCol = `${tsIsoExpr("created_at")} AS created_at_iso`;
  let res;
  if (beforeId !== null) {
    res = await query<LogRow>(
      `SELECT *, ${isoCol}
         FROM admin.import_job_logs
         WHERE job_id = $1 AND job_log_id < $2
         ORDER BY job_log_id DESC
         LIMIT $3`,
      [jobId, beforeId, limit],
    );
  } else {
    res = await query<LogRow>(
      `SELECT *, ${isoCol}
         FROM admin.import_job_logs
         WHERE job_id = $1
         ORDER BY job_log_id DESC
         LIMIT $2`,
      [jobId, limit],
    );
  }
  // Python returns reversed(rows) → ascending (chronological).
  return res.rows
    .slice()
    .reverse()
    .map((row) => ({
      job_log_id: Number(row.job_log_id),
      job_id: String(row.job_id),
      level: row.level || "",
      message: row.message || "",
      payload: parseJsonb(row.payload_json),
      created_at: row.created_at_iso === null ? "" : pyIso(row.created_at_iso),
    }));
}

/** Faithful port of `list_job_steps`. */
export async function listJobSteps(jobId: string): Promise<Record<string, unknown>[]> {
  const res = await query<StepRow>(
    `SELECT *, ${tsIsoExpr("started_at")} AS started_at_iso,
            ${tsIsoExpr("finished_at")} AS finished_at_iso
       FROM admin.import_job_steps
       WHERE job_id = $1
       ORDER BY job_step_id`,
    [jobId],
  );
  return res.rows.map((row) => ({
    job_step_id: Number(row.job_step_id),
    job_id: String(row.job_id),
    step_key: row.step_key || "",
    status: row.status || "",
    progress_current: Number(row.progress_current || 0),
    progress_total: Number(row.progress_total || 0),
    started_at: row.started_at_iso === null ? "" : pyIso(row.started_at_iso),
    finished_at: row.finished_at_iso === null ? "" : pyIso(row.finished_at_iso),
    checkpoint: parseJsonb(row.checkpoint_json),
    last_error_message: row.last_error_message || "",
  }));
}

/** Faithful port of `get_job_step_checkpoint`. Returns the step's checkpoint dict or {}. */
export async function getJobStepCheckpoint(jobId: string, stepKey: string): Promise<Record<string, unknown>> {
  const res = await query<{ checkpoint_json: unknown }>(
    `SELECT checkpoint_json FROM admin.import_job_steps WHERE job_id = $1 AND step_key = $2`,
    [jobId, stepKey],
  );
  if (res.rows.length === 0) return {};
  return parseJsonb(res.rows[0].checkpoint_json);
}

/**
 * Faithful port of `summarize_jobs`: job counts by status bucket.
 * `failed` = retryable_failed + permanent_failed. COUNT(*)::int → JS number.
 */
export async function summarizeJobs(): Promise<Record<string, number>> {
  const res = await query<{ status: string; count: number }>(
    `SELECT status, COUNT(*)::int AS count FROM admin.import_jobs GROUP BY status`,
  );
  const c = new Map<string, number>();
  for (const r of res.rows) c.set(r.status, Number(r.count));
  const g = (k: string): number => c.get(k) ?? 0;
  return {
    queued: g("queued"),
    running: g("running"),
    success: g("success"),
    failed: g("retryable_failed") + g("permanent_failed"),
    paused: g("paused"),
    stopped: g("stopped"),
  };
}

// ── Job create / control write path (mirrors admin_jobs.py) ───────────────────

/** Raised on job-create / control validation failures (Python ValueError → 400). */
export class JobValueError extends Error {}

const PHASE2_JOB_TYPES = ["noop"];
const SIMPLE_LOADER_JOB_TYPES = ["guideline_seed", "health_supplements_sync", "food_nutrition_sync"];
const HEAVY_LOADER_JOB_TYPES = ["icd_import", "loinc_import", "ig_import", "snomed_import", "rxnorm_import"];
const DRUG_JOB_TYPES = ["drug_index_import", "drug_enrichment", "drug_analysis"];
const EMBED_JOB_TYPES = ["icd_embed", "loinc_embed", "health_supplements_embed", "food_nutrition_embed", "guideline_embed", "snomed_embed"];

/** Faithful port of `ADMIN_JOB_TYPES`. */
export const ADMIN_JOB_TYPES: ReadonlySet<string> = new Set([
  ...PHASE2_JOB_TYPES,
  ...SIMPLE_LOADER_JOB_TYPES,
  ...HEAVY_LOADER_JOB_TYPES,
  ...DRUG_JOB_TYPES,
  ...EMBED_JOB_TYPES,
]);

/** `sorted(ADMIN_JOB_TYPES)` — lexicographic, matching Python's `sorted()`. */
export function sortedAdminJobTypes(): string[] {
  return [...ADMIN_JOB_TYPES].sort();
}

/** Faithful port of `CONTROL_ACTIONS`. */
export const CONTROL_ACTIONS = ["pause", "resume", "stop", "restart"] as const;

/** Faithful port of `JOB_TYPE_MODULE_KEYS`. */
const JOB_TYPE_MODULE_KEYS: Record<string, string> = {
  noop: "admin",
  guideline_seed: "guideline",
  health_supplements_sync: "health_supplements",
  food_nutrition_sync: "food_nutrition",
  icd_import: "icd",
  loinc_import: "loinc",
  ig_import: "ig",
  snomed_import: "snomed",
  rxnorm_import: "rxnorm",
  drug_index_import: "drug",
  drug_enrichment: "drug",
  drug_analysis: "drug",
  icd_embed: "icd",
  loinc_embed: "loinc",
  health_supplements_embed: "health_supplements",
  food_nutrition_embed: "food_nutrition",
  guideline_embed: "guideline",
  snomed_embed: "snomed",
};

interface HeavyJobSourceSpec {
  module_key: string;
  required_roles: string[];
  optional_roles: string[];
}

/** Faithful port of `HEAVY_JOB_SOURCE_SPECS` (note: ig_import deliberately absent). */
const HEAVY_JOB_SOURCE_SPECS: Record<string, HeavyJobSourceSpec> = {
  icd_import: { module_key: "icd", required_roles: ["icd10cm", "icd10pcs", "icd_zh_tw"], optional_roles: [] },
  loinc_import: { module_key: "loinc", required_roles: ["loinc", "loinc_taiwan_mapping", "loinc_reference_ranges"], optional_roles: [] },
  snomed_import: { module_key: "snomed", required_roles: ["snomed_ct"], optional_roles: [] },
  rxnorm_import: { module_key: "rxnorm", required_roles: ["rxnorm_full"], optional_roles: [] },
  drug_index_import: { module_key: "drug", required_roles: ["drug_index_csv"], optional_roles: [] },
};

function jobExpectedModule(jobType: string): string | undefined {
  return JOB_TYPE_MODULE_KEYS[(jobType || "").trim()];
}

interface SourceManifestRow {
  module_source_id: string;
  module_key: string;
  source_role: string;
  is_active: boolean;
  uploaded_file_id: string;
  original_filename: string | null;
  mime_type: string | null;
  size_bytes: number | string | null;
  sha256: string | null;
  bucket: string | null;
  object_key: string | null;
  minio_uri: string | null;
  uploaded_by: string | null;
  uploaded_at_iso: string | null;
}

const SOURCE_ROW_COLS = `
    ds.module_source_id::text AS module_source_id,
    ds.module_key,
    ds.source_role,
    ds.is_active,
    uf.uploaded_file_id::text AS uploaded_file_id,
    uf.original_filename,
    uf.mime_type,
    uf.size_bytes,
    uf.sha256,
    uf.bucket,
    uf.object_key,
    uf.minio_uri,
    uf.uploaded_by,
    ${tsIsoExpr("uf.uploaded_at")} AS uploaded_at_iso`;

/** Mirror `_fetch_module_source_row`. */
async function fetchModuleSourceRow(
  client: pg.PoolClient,
  opts: { moduleSourceId?: string; uploadedFileId?: string },
): Promise<SourceManifestRow | null> {
  const moduleSourceId = opts.moduleSourceId || "";
  const uploadedFileId = opts.uploadedFileId || "";
  if (moduleSourceId) {
    const r = await client.query<SourceManifestRow>(
      `SELECT ${SOURCE_ROW_COLS}
         FROM admin.module_sources ds
         JOIN admin.uploaded_files uf ON uf.uploaded_file_id = ds.uploaded_file_id
        WHERE ds.module_source_id = $1::uuid`,
      [moduleSourceId],
    );
    return r.rows[0] ?? null;
  }
  if (uploadedFileId) {
    const r = await client.query<SourceManifestRow>(
      `SELECT ${SOURCE_ROW_COLS}
         FROM admin.uploaded_files uf
         JOIN admin.module_sources ds ON ds.uploaded_file_id = uf.uploaded_file_id
        WHERE uf.uploaded_file_id = $1::uuid
        ORDER BY ds.is_active DESC, ds.activated_at DESC NULLS LAST
        LIMIT 1`,
      [uploadedFileId],
    );
    return r.rows[0] ?? null;
  }
  return null;
}

/** Mirror `_resolve_job_source_manifest`. */
async function resolveJobSourceManifest(
  client: pg.PoolClient,
  opts: { moduleKey: string; jobType: string; sourceModuleSourceId?: string; sourceUploadedFileId?: string },
): Promise<Record<string, unknown>> {
  const spec = HEAVY_JOB_SOURCE_SPECS[opts.jobType];
  if (opts.moduleKey !== spec.module_key) {
    throw new JobValueError(`Job type '${opts.jobType}' must use module_key '${spec.module_key}', got '${opts.moduleKey}'`);
  }

  const allRows = (
    await client.query<SourceManifestRow>(
      `SELECT ${SOURCE_ROW_COLS}
         FROM admin.module_sources ds
         JOIN admin.uploaded_files uf ON uf.uploaded_file_id = ds.uploaded_file_id
        WHERE ds.module_key = $1
        ORDER BY ds.source_role, uf.uploaded_at DESC NULLS LAST`,
      [opts.moduleKey],
    )
  ).rows;

  // Lazy import to mirror Python's in-function `from admin_sources import` and
  // avoid an eager circular module dependency.
  const { SOURCE_CATALOG } = await import("./adminSources.js");
  const multiSourceRoles = new Set<string>(
    SOURCE_CATALOG.filter((v) => v.multi_source && v.module_key === opts.moduleKey).map((v) => v.source_role),
  );

  const bindingsByRoleRaw = new Map<string, SourceManifestRow[]>();
  for (const row of allRows) {
    const role = String(row.source_role);
    if (!bindingsByRoleRaw.has(role)) bindingsByRoleRaw.set(role, []);
    bindingsByRoleRaw.get(role)!.push(row);
  }

  const bindingsByRole = new Map<string, SourceManifestRow | SourceManifestRow[]>();
  for (const [role, rows] of bindingsByRoleRaw) {
    if (multiSourceRoles.has(role)) {
      const active = rows.filter((r) => r.is_active);
      bindingsByRole.set(role, active.length > 0 ? active : rows);
    } else {
      bindingsByRole.set(role, rows[0]);
    }
  }

  const explicit = await fetchModuleSourceRow(client, {
    moduleSourceId: opts.sourceModuleSourceId,
    uploadedFileId: opts.sourceUploadedFileId,
  });
  if (explicit !== null) {
    if (explicit.module_key !== opts.moduleKey) {
      throw new JobValueError(`Selected source belongs to module '${explicit.module_key}', not '${opts.moduleKey}'`);
    }
    const role = String(explicit.source_role);
    bindingsByRole.set(role, explicit);
    multiSourceRoles.delete(role);
  }

  const missingRequired: string[] = [];
  for (const role of spec.required_roles) {
    const binding = bindingsByRole.get(role);
    if (binding === undefined) missingRequired.push(role);
    else if (multiSourceRoles.has(role) && Array.isArray(binding) && binding.length === 0) missingRequired.push(role);
  }
  if (missingRequired.length > 0) {
    throw new JobValueError(`Missing uploaded source(s) for ${opts.moduleKey}: ${missingRequired.join(", ")}`);
  }

  const rowToBinding = (row: SourceManifestRow): Record<string, unknown> => ({
    module_source_id: row.module_source_id,
    module_key: row.module_key,
    source_role: row.source_role,
    uploaded_file_id: row.uploaded_file_id,
    original_filename: row.original_filename,
    mime_type: row.mime_type || "",
    size_bytes: Number(row.size_bytes || 0),
    sha256: row.sha256 || "",
    bucket: row.bucket || "",
    object_key: row.object_key || "",
    minio_uri: row.minio_uri || "",
    uploaded_by: row.uploaded_by || "",
    uploaded_at: row.uploaded_at_iso === null ? "" : pyIso(row.uploaded_at_iso),
    is_active: Boolean(row.is_active),
  });

  const boundAt = new Date().toISOString().replace("Z", "+00:00");
  const rolesInOrder = [...spec.required_roles, ...spec.optional_roles];
  const bindings: Record<string, unknown> = {};
  for (const role of rolesInOrder) {
    const raw = bindingsByRole.get(role);
    if (raw === undefined) continue;
    if (multiSourceRoles.has(role) && Array.isArray(raw)) bindings[role] = raw.map(rowToBinding);
    else bindings[role] = rowToBinding(Array.isArray(raw) ? raw[0] : raw);
  }

  const primaryRole = explicit !== null ? String(explicit.source_role) : spec.required_roles[0];
  const primaryRaw = bindings[primaryRole];
  const primaryBinding = (Array.isArray(primaryRaw) ? primaryRaw[0] : primaryRaw) as Record<string, unknown>;
  return {
    module_key: opts.moduleKey,
    job_type: opts.jobType,
    bound_at: boundAt,
    required_roles: [...spec.required_roles],
    optional_roles: [...spec.optional_roles],
    primary_source_role: primaryRole,
    primary_module_source_id: primaryBinding.module_source_id,
    primary_uploaded_file_id: primaryBinding.uploaded_file_id,
    bindings,
  };
}

const JOB_INSERT_RETURNING = `SELECT *, ${JOB_ISO_COLS} FROM ins`;

/** Faithful port of `create_job`. */
export async function createJob(opts: {
  moduleKey: string;
  jobType: string;
  requestedBy: string;
  jobOptions?: Record<string, unknown>;
  sourceModuleSourceId?: string;
  sourceUploadedFileId?: string;
  parentJobId?: string;
}): Promise<Record<string, unknown>> {
  const jobType = (opts.jobType || "").trim();
  const moduleKey = (opts.moduleKey || "").trim();
  const expected = jobExpectedModule(jobType);
  if (expected === undefined) throw new JobValueError(`Unsupported admin job type: ${jobType}`);
  if (moduleKey !== expected) {
    throw new JobValueError(`Job type '${jobType}' must use module_key '${expected}', got '${moduleKey}'`);
  }

  const jobId = randomUUID();
  const options: Record<string, unknown> = { ...(opts.jobOptions ?? {}) };
  let smsId = opts.sourceModuleSourceId || "";
  let sufId = opts.sourceUploadedFileId || "";
  const parentJobId = opts.parentJobId || "";

  return withTransaction(async (client) => {
    if (HEAVY_JOB_SOURCE_SPECS[jobType]) {
      const manifest = await resolveJobSourceManifest(client, {
        moduleKey,
        jobType,
        sourceModuleSourceId: smsId,
        sourceUploadedFileId: sufId,
      });
      options.source_manifest = manifest;
      smsId = smsId || String(manifest.primary_module_source_id);
      sufId = sufId || String(manifest.primary_uploaded_file_id);
    }
    const res = await client.query<JobRow>(
      `WITH ins AS (
         INSERT INTO admin.import_jobs (
           job_id, module_key, job_type, requested_by,
           source_module_source_id, source_uploaded_file_id, parent_job_id,
           status, control_state, current_step, job_options_json, result_summary_json
         )
         VALUES (
           $1, $2, $3, $4,
           NULLIF($5, '')::uuid, NULLIF($6, '')::uuid, NULLIF($7, '')::uuid,
           'queued', 'idle', 'queued', $8::jsonb, '{}'::jsonb
         )
         RETURNING *
       )
       ${JOB_INSERT_RETURNING}`,
      [jobId, moduleKey, jobType, opts.requestedBy, smsId, sufId, parentJobId, JSON.stringify(options)],
    );
    if (res.rows.length === 0) throw new Error("Failed to create admin job");
    await client.query(
      `INSERT INTO admin.import_job_logs (job_id, level, message, payload_json)
       VALUES ($1, 'info', 'Job created', $2::jsonb)`,
      [jobId, JSON.stringify({ module_key: moduleKey, job_type: jobType, parent_job_id: parentJobId })],
    );
    return jobToDict(res.rows[0]);
  });
}

/** Mirror `_create_restart_job_locked`. */
async function createRestartJobLocked(
  client: pg.PoolClient,
  sourceRow: Record<string, unknown>,
  requestedBy: string,
): Promise<Record<string, unknown>> {
  const newJobId = randomUUID();
  const res = await client.query<JobRow>(
    `WITH ins AS (
       INSERT INTO admin.import_jobs (
         job_id, module_key, job_type, requested_by,
         status, control_state,
         source_module_source_id, source_uploaded_file_id, parent_job_id,
         current_step, job_options_json, result_summary_json
       )
       VALUES (
         $1, $2, $3, $4,
         'queued', 'idle',
         $5, $6, $7,
         'queued', $8::jsonb, '{}'::jsonb
       )
       RETURNING *
     )
     ${JOB_INSERT_RETURNING}`,
    [
      newJobId,
      sourceRow.module_key,
      sourceRow.job_type,
      requestedBy,
      sourceRow.source_module_source_id,
      sourceRow.source_uploaded_file_id,
      sourceRow.job_id,
      JSON.stringify(parseJsonb(sourceRow.job_options_json)),
    ],
  );
  if (res.rows.length === 0) throw new Error("Failed to create restart job");
  await client.query(
    `INSERT INTO admin.import_job_logs (job_id, level, message, payload_json)
     VALUES ($1, 'info', 'Job created by restart request', $2::jsonb)`,
    [newJobId, JSON.stringify({ parent_job_id: String(sourceRow.job_id), requested_by: requestedBy })],
  );
  return jobToDict(res.rows[0]);
}

/** Faithful port of `request_job_control`. */
export async function requestJobControl(opts: {
  jobId: string;
  action: string;
  requestedBy: string;
}): Promise<Record<string, unknown>> {
  const action = (opts.action || "").trim().toLowerCase();
  if (!(CONTROL_ACTIONS as readonly string[]).includes(action)) {
    throw new JobValueError(`Unsupported job control action: ${action}`);
  }
  const jobId = opts.jobId;
  const requestedBy = opts.requestedBy;
  // Mirror Python `uuid.UUID(job_id)` raising ValueError (→ 400) on a malformed
  // id, instead of letting Postgres reject it as a generic 500.
  if (!/^[0-9a-fA-F]{32}$/.test(jobId.replace(/-/g, ""))) {
    throw new JobValueError("badly formed hexadecimal UUID string");
  }

  return withTransaction(async (client) => {
    const sel = await client.query<JobRow & Record<string, unknown>>(
      `SELECT *, ${JOB_ISO_COLS} FROM admin.import_jobs WHERE job_id = $1 FOR UPDATE`,
      [jobId],
    );
    if (sel.rows.length === 0) throw new JobValueError("Job not found");
    const sourceRow = sel.rows[0];
    const job = jobToDict(sel.rows[0]);
    const allowed = availableJobActions(job.status as string, job.control_state as string);
    if (!allowed.includes(action)) {
      throw new JobValueError(
        `Action '${action}' is not allowed for job status=${job.status} control_state=${job.control_state}`,
      );
    }

    const controlRes = await client.query<{ control_request_id: number | string; requested_at_iso: string }>(
      `INSERT INTO admin.job_control_requests (job_id, action, requested_by)
       VALUES ($1, $2, $3)
       RETURNING control_request_id, ${tsIsoExpr("requested_at")} AS requested_at_iso`,
      [jobId, action, requestedBy],
    );
    if (controlRes.rows.length === 0) throw new Error("Failed to create job control request");
    const controlRequestId = Number(controlRes.rows[0].control_request_id);
    const requestedAtIso = controlRes.rows[0].requested_at_iso;

    let restartJob: Record<string, unknown> | null = null;
    let resultStatus = "accepted";
    let resultMessage = "Control request queued for worker checkpoint.";
    const status = job.status as string;

    if (action === "pause" && status === "queued") {
      await client.query(
        `UPDATE admin.import_jobs SET status = 'paused', control_state = 'paused',
            current_step = 'paused_before_claim', updated_at = NOW() WHERE job_id = $1`,
        [jobId],
      );
      resultStatus = "applied";
      resultMessage = "Queued job paused before worker claim.";
    } else if (action === "resume" && status === "paused") {
      await client.query(
        `UPDATE admin.import_jobs SET status = 'queued', control_state = 'resume_requested',
            current_step = 'resume_requested', updated_at = NOW() WHERE job_id = $1`,
        [jobId],
      );
      resultStatus = "applied";
      resultMessage = "Paused job re-queued for resume.";
    } else if (action === "stop" && (status === "queued" || status === "paused")) {
      await client.query(
        `UPDATE admin.import_jobs SET status = 'stopped', control_state = 'idle',
            current_step = 'stopped', finished_at = NOW(), updated_at = NOW() WHERE job_id = $1`,
        [jobId],
      );
      resultStatus = "applied";
      resultMessage = "Job stopped without worker execution.";
    } else if (action === "restart" && status !== "running") {
      restartJob = await createRestartJobLocked(client, sourceRow, requestedBy);
      if (status === "queued") {
        await client.query(
          `UPDATE admin.import_jobs SET status = 'stopped', control_state = 'idle',
              current_step = 'restarted', finished_at = NOW(), updated_at = NOW() WHERE job_id = $1`,
          [jobId],
        );
      }
      resultStatus = "applied";
      resultMessage = `Restart job created: ${String(restartJob.job_id)}`;
    } else if (action === "pause") {
      await client.query(
        `UPDATE admin.import_jobs SET control_state = 'pause_requested', updated_at = NOW() WHERE job_id = $1`,
        [jobId],
      );
    } else if (action === "stop") {
      await client.query(
        `UPDATE admin.import_jobs SET control_state = 'stop_requested', updated_at = NOW() WHERE job_id = $1`,
        [jobId],
      );
    } else if (action === "restart") {
      await client.query(
        `UPDATE admin.import_jobs SET control_state = 'restart_requested', updated_at = NOW() WHERE job_id = $1`,
        [jobId],
      );
    }

    await client.query(
      `UPDATE admin.job_control_requests
          SET handled_at = CASE WHEN $2 = 'applied' THEN NOW() ELSE handled_at END,
              result_status = $2, result_message = $3
        WHERE control_request_id = $1`,
      [controlRequestId, resultStatus, resultMessage],
    );
    await client.query(
      `INSERT INTO admin.import_job_logs (job_id, level, message, payload_json)
       VALUES ($1, 'info', $2, $3::jsonb)`,
      [
        jobId,
        `Control action requested: ${action}`,
        JSON.stringify({
          action,
          requested_by: requestedBy,
          result_status: resultStatus,
          result_message: resultMessage,
          restart_job_id: restartJob ? String(restartJob.job_id) : "",
        }),
      ],
    );
    const reload = await client.query<JobRow>(
      `SELECT *, ${JOB_ISO_COLS} FROM admin.import_jobs WHERE job_id = $1`,
      [jobId],
    );
    if (reload.rows.length === 0) throw new Error("Failed to reload updated admin job");
    return {
      job: jobToDict(reload.rows[0]),
      control_request: {
        control_request_id: controlRequestId,
        action,
        requested_by: requestedBy,
        requested_at: requestedAtIso === null ? "" : pyIso(requestedAtIso),
        result_status: resultStatus,
        result_message: resultMessage,
      },
      restart_job: restartJob,
    };
  });
}

// ════════════════════════════════════════════════════════════════════════════
// W2a — worker control plane
//
// Faithful ports of the admin_jobs.py worker-side primitives consumed by the
// admin-worker daemon (adminWorker.ts): resource-based concurrency, worker
// tuning getters, the job status/control state machine (mark_job_status /
// checkpoint_job_control), terminal outcome logging, per-job verbose logging,
// log pruning, the noop smoke job, drug-pipeline auto-chaining, and the
// execute_admin_job dispatcher. Data-plane loader bodies land in W2b.
// ════════════════════════════════════════════════════════════════════════════

const sleep = (seconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, Math.max(seconds, 0) * 1000));

// ── Resource-based concurrency (mirror JOB_RESOURCES / JOB_TYPE_RESOURCES) ────

/** Faithful port of `JOB_RESOURCES`: resource slot → job types holding it. */
export const JOB_RESOURCES: Record<string, ReadonlySet<string>> = {
  db_write_icd: new Set(["icd_import"]),
  db_write_loinc: new Set(["loinc_import"]),
  db_write_ig: new Set(["ig_import"]),
  db_write_snomed: new Set(["snomed_import"]),
  db_write_rxnorm: new Set(["rxnorm_import"]),
  db_write_guideline: new Set(["guideline_seed"]),
  db_write_health_supplements: new Set(["health_supplements_sync"]),
  db_write_food_nutrition: new Set(["food_nutrition_sync"]),
  // Drug Phase 1/2 write the same drug.* tables — serialised behind one slot.
  db_write_drug: new Set(["drug_index_import", "drug_enrichment"]),
  ollama_embed: new Set(EMBED_JOB_TYPES),
  llm: new Set(["drug_analysis"]),
};

/** Inverted index: job_type → set of resources it needs (mirror JOB_TYPE_RESOURCES). */
export const JOB_TYPE_RESOURCES: Map<string, Set<string>> = (() => {
  const out = new Map<string, Set<string>>();
  for (const [resource, types] of Object.entries(JOB_RESOURCES)) {
    for (const jt of types) {
      if (!out.has(jt)) out.set(jt, new Set());
      out.get(jt)!.add(resource);
    }
  }
  return out;
})();

/** Faithful port of `get_excluded_job_types`. */
export function getExcludedJobTypes(activeResources: ReadonlySet<string>): Set<string> {
  if (activeResources.size === 0) return new Set();
  const excluded = new Set<string>();
  for (const [jt, rs] of JOB_TYPE_RESOURCES) {
    for (const r of rs) {
      if (activeResources.has(r)) {
        excluded.add(jt);
        break;
      }
    }
  }
  return excluded;
}

// ── Worker tuning getters (mirror admin_jobs.py env getters) ──────────────────

export function adminWorkerName(): string {
  return (process.env.ADMIN_WORKER_NAME ?? "admin-worker").trim() || "admin-worker";
}
export function adminWorkerPollSeconds(): number {
  return Number.parseFloat(process.env.ADMIN_WORKER_POLL_SECONDS ?? "3");
}
export function adminHeartbeatIntervalSeconds(): number {
  return Number.parseInt(process.env.ADMIN_HEARTBEAT_INTERVAL_SECONDS ?? "15", 10);
}
export function adminNoopCheckpointDelaySeconds(): number {
  return Number.parseFloat(process.env.ADMIN_NOOP_CHECKPOINT_DELAY_SECONDS ?? "0.35");
}

// ── Status / control state machine ───────────────────────────────────────────

const TERMINAL_STATUSES = new Set([
  "success",
  "partial_success",
  "retryable_failed",
  "permanent_failed",
  "stopped",
  "cancelled",
]);

/** Faithful port of `_activate_manifest_sources`. Best-effort; never throws. */
async function activateManifestSources(manifest: Record<string, unknown>): Promise<void> {
  const { activateSource } = await import("./adminSources.js");
  const bindings = (manifest.bindings as Record<string, unknown>) || {};
  const seen = new Set<string>();
  for (const binding of Object.values(bindings)) {
    const items = Array.isArray(binding) ? binding : [binding];
    for (const b of items) {
      const rec = (b || {}) as Record<string, unknown>;
      const ufid = String(rec.uploaded_file_id ?? "").trim();
      if (!ufid || seen.has(ufid)) continue;
      seen.add(ufid);
      if (rec.is_active) continue; // already loaded — don't churn version/activated_at
      try {
        await activateSource(ufid, "import-job");
      } catch (exc) {
        // eslint-disable-next-line no-console
        console.warn(`Failed to activate source ${ufid} after import: ${String(exc)}`);
      }
    }
  }
}

export interface MarkJobStatusInput {
  jobId: string;
  status: string;
  currentStep: string;
  progressCurrent?: number | null;
  progressTotal?: number | null;
  controlState?: string | null;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  resultSummary?: Record<string, unknown>;
}

/** Faithful port of `mark_job_status` (+ `_activate_manifest_sources` + `job_status_changed` broadcast). */
export async function markJobStatus(opts: MarkJobStatusInput): Promise<void> {
  const resultSummary = opts.resultSummary ?? {};
  const res = await query<{
    job_type: string | null;
    module_key: string | null;
    progress_current: number | string | null;
    progress_total: number | string | null;
    updated_at_iso: string | null;
  }>(
    `UPDATE admin.import_jobs
        SET status = $2,
            current_step = $3,
            progress_current = COALESCE($4, progress_current),
            progress_total = COALESCE($5, progress_total),
            control_state = COALESCE($6, control_state),
            finished_at = CASE
                WHEN $2 IN ('success','partial_success','retryable_failed','permanent_failed','stopped','cancelled')
                THEN NOW() ELSE finished_at END,
            last_error_code = NULLIF($7, ''),
            last_error_message = NULLIF($8, ''),
            result_summary_json = CASE
                WHEN $9::jsonb = '{}'::jsonb THEN result_summary_json
                ELSE $9::jsonb END,
            updated_at = NOW()
      WHERE job_id = $1
      RETURNING job_type, module_key, progress_current, progress_total,
                ${tsIsoExpr("updated_at")} AS updated_at_iso`,
    [
      opts.jobId,
      opts.status,
      opts.currentStep,
      opts.progressCurrent ?? null,
      opts.progressTotal ?? null,
      opts.controlState ?? null,
      opts.lastErrorCode ?? "",
      opts.lastErrorMessage ?? "",
      JSON.stringify(resultSummary),
    ],
  );
  if (res.rows.length === 0) return;
  const row = res.rows[0];
  // On success, promote the imported file(s) to active (manifest carried in summary).
  const manifest = resultSummary.source_manifest as Record<string, unknown> | undefined;
  if (
    (opts.status === "success" || opts.status === "partial_success") &&
    manifest &&
    typeof manifest === "object" &&
    !Array.isArray(manifest) &&
    manifest.bindings
  ) {
    await activateManifestSources(manifest);
  }
  void broadcast("job_status_changed", {
    job_id: opts.jobId,
    job_type: row.job_type,
    module_key: row.module_key || "",
    status: opts.status,
    current_step: opts.currentStep,
    progress_current: Number(row.progress_current || 0),
    progress_total: Number(row.progress_total || 0),
    updated_at: row.updated_at_iso ? pyIso(row.updated_at_iso) : "",
  });
}

interface ControlResult {
  action: string;
  restart_job: Record<string, unknown> | null;
  message: string;
}

/** Faithful port of `checkpoint_job_control`. Applies a pending pause/stop/restart at a checkpoint. */
export async function checkpointJobControl(opts: {
  jobId: string;
  workerName: string;
}): Promise<ControlResult | null> {
  const { jobId, workerName } = opts;
  return withTransaction(async (client) => {
    const jobSel = await client.query<JobRow & Record<string, unknown>>(
      `SELECT * FROM admin.import_jobs WHERE job_id = $1 FOR UPDATE`,
      [jobId],
    );
    if (jobSel.rows.length === 0) return null;
    const jobRow = jobSel.rows[0];
    const controlState = String(jobRow.control_state || "").trim();
    if (!["pause_requested", "stop_requested", "restart_requested"].includes(controlState)) {
      return null;
    }

    const controlSel = await client.query<{
      control_request_id: number | string;
      action: string | null;
      requested_by: string | null;
    }>(
      `SELECT * FROM admin.job_control_requests
        WHERE job_id = $1 AND handled_at IS NULL
        ORDER BY requested_at DESC, control_request_id DESC
        LIMIT 1
        FOR UPDATE`,
      [jobId],
    );
    const controlRow = controlSel.rows[0] ?? null;
    const action = controlRow
      ? String(controlRow.action ?? "").trim().toLowerCase()
      : controlState.replace("_requested", "");
    let restartJob: Record<string, unknown> | null = null;
    let resultMessage = "";

    if (action === "pause") {
      await client.query(
        `UPDATE admin.import_jobs SET status = 'paused', control_state = 'paused',
            current_step = 'paused', updated_at = NOW() WHERE job_id = $1`,
        [jobId],
      );
      resultMessage = "Job paused at checkpoint boundary.";
    } else if (action === "stop") {
      await client.query(
        `UPDATE admin.import_jobs SET status = 'stopped', control_state = 'idle',
            current_step = 'stopped', finished_at = NOW(), updated_at = NOW() WHERE job_id = $1`,
        [jobId],
      );
      resultMessage = "Job stopped at checkpoint boundary.";
    } else if (action === "restart") {
      restartJob = await createRestartJobLocked(
        client,
        jobRow,
        controlRow ? controlRow.requested_by || workerName : workerName,
      );
      await client.query(
        `UPDATE admin.import_jobs SET status = 'stopped', control_state = 'idle',
            current_step = 'restarted', finished_at = NOW(), updated_at = NOW() WHERE job_id = $1`,
        [jobId],
      );
      resultMessage = `Restart job created: ${String(restartJob.job_id)}`;
    } else {
      return null;
    }

    if (controlRow) {
      await client.query(
        `UPDATE admin.job_control_requests
            SET handled_at = NOW(), result_status = 'applied', result_message = $2
          WHERE control_request_id = $1`,
        [Number(controlRow.control_request_id), resultMessage],
      );
    }
    await client.query(
      `INSERT INTO admin.import_job_logs (job_id, level, message, payload_json)
       VALUES ($1, 'info', $2, $3::jsonb)`,
      [
        jobId,
        `Worker applied control action: ${action}`,
        JSON.stringify({
          worker_name: workerName,
          action,
          restart_job_id: restartJob ? String(restartJob.job_id) : "",
        }),
      ],
    );
    return { action, restart_job: restartJob, message: resultMessage };
  });
}

/** Faithful port of `_apply_control_checkpoint`. Returns true if a control action was applied. */
export async function applyControlCheckpoint(opts: { jobId: string; workerName: string }): Promise<boolean> {
  return (await checkpointJobControl(opts)) !== null;
}

/** Faithful port of `_count_table_rows`. */
export async function countTableRows(tableName: string): Promise<number> {
  const res = await query<{ count: string }>(`SELECT COUNT(*) AS count FROM ${tableName}`);
  return Number(res.rows[0]?.count ?? 0);
}

// ── Terminal outcome logging ──────────────────────────────────────────────────

/** Faithful port of `_fmt` (thousands separator). */
function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

/** Faithful port of `_success_summary_message`. */
function successSummaryMessage(summary: Record<string, unknown>): string {
  const countLabels: Array<[string, string]> = [
    ["diagnosis_count", "diagnoses"],
    ["procedure_count", "procedures"],
    ["concept_count", "concepts"],
    ["description_count", "descriptions"],
    ["relationship_count", "relationships"],
    ["codesystem_count", "codesystems"],
    ["artifact_count", "artifacts"],
    ["loinc_count", "LOINC terms"],
    ["guideline_count", "guidelines"],
    ["drug_count", "drugs"],
    ["record_count", "records"],
    ["row_count", "rows"],
  ];
  const parts: string[] = [];
  for (const [key, label] of countLabels) {
    const v = summary[key];
    if (v) parts.push(`${fmt(Number(v))} ${label}`);
  }
  return parts.length > 0 ? `✓ Completed — ${parts.join(", ")}` : "✓ Completed";
}

/** Faithful port of `log_job_outcome`. */
export async function logJobOutcome(opts: { jobId: string; workerName: string }): Promise<void> {
  const job = await getJob(opts.jobId);
  if (!job) return;
  const status = job.status as string;
  if (status === "success") {
    const summary = (job.result_summary as Record<string, unknown>) || {};
    await appendJobLog({
      jobId: opts.jobId,
      level: "info",
      message: successSummaryMessage(summary),
      payload: { result_summary: summary },
    });
  } else if (status === "retryable_failed" || status === "permanent_failed" || status === "failed") {
    await appendJobLog({
      jobId: opts.jobId,
      level: "error",
      message: `✗ Failed: ${(job.last_error_message as string) || status}`,
      payload: { status, error_code: (job.last_error_code as string) || "" },
    });
  }
}

// ── Per-job verbose logging (mirror _LOG_VERBOSE ContextVar via AsyncLocalStorage) ──

const logVerboseStore = new AsyncLocalStorage<boolean>();
let defaultLogVerbose = false;

/** Faithful port of `set_default_log_verbose`. */
export function setDefaultLogVerbose(value: boolean): void {
  defaultLogVerbose = Boolean(value);
}

/** Faithful port of `_resolve_log_verbose`. */
export function resolveLogVerbose(job: Record<string, unknown>): boolean {
  const opts = parseJsonb(job.job_options);
  if ("log_verbose" in opts) return Boolean(opts.log_verbose);
  return defaultLogVerbose;
}

/** Faithful port of `job_debug_log` — only emits when verbose mode is active for this job. */
export async function jobDebugLog(opts: {
  jobId: string;
  message: string;
  payload?: Record<string, unknown>;
}): Promise<void> {
  if (!(logVerboseStore.getStore() ?? false)) return;
  await appendJobLog({ jobId: opts.jobId, level: "debug", message: opts.message, payload: opts.payload });
}

/** Faithful port of `prune_job_logs`. Returns total rows deleted. */
export async function pruneJobLogs(opts: {
  retentionDays?: number;
  maxLinesPerJob?: number;
} = {}): Promise<number> {
  const retentionDays = opts.retentionDays ?? 30;
  const maxLinesPerJob = opts.maxLinesPerJob ?? 2000;
  let deleted = 0;
  if (retentionDays > 0) {
    const r = await query(
      `DELETE FROM admin.import_job_logs
        WHERE created_at < NOW() - make_interval(days => $1::int)`,
      [retentionDays],
    );
    deleted += r.rowCount ?? 0;
  }
  if (maxLinesPerJob > 0) {
    const r = await query(
      `DELETE FROM admin.import_job_logs l
        USING (
          SELECT job_log_id,
                 row_number() OVER (PARTITION BY job_id ORDER BY created_at DESC, job_log_id DESC) AS rn
          FROM admin.import_job_logs
        ) ranked
        WHERE l.job_log_id = ranked.job_log_id
          AND ranked.rn > $1::int
          AND l.level <> 'error'`,
      [maxLinesPerJob],
    );
    deleted += r.rowCount ?? 0;
  }
  return deleted;
}

// ── Noop smoke job ────────────────────────────────────────────────────────────

/** Faithful port of `run_noop_job` — the control-plane smoke job with checkpoints. */
export async function runNoopJob(job: Record<string, unknown>): Promise<void> {
  const jobId = String(job.job_id);
  const total = 5;
  const startAt = Math.max(Number(job.progress_current || 0), 0);
  const delay = Math.max(adminNoopCheckpointDelaySeconds(), 0);

  await recordJobStep({
    jobId,
    stepKey: "noop",
    status: "running",
    progressCurrent: startAt,
    progressTotal: total,
    checkpoint: { phase: "started", resume_from: startAt },
  });
  await appendJobLog({
    jobId,
    level: "info",
    message: "Executing noop admin job",
    payload: { module_key: job.module_key, job_type: job.job_type, resume_from: startAt },
  });

  for (let index = startAt; index < total; index += 1) {
    const completed = index + 1;
    await markJobStatus({
      jobId,
      status: "running",
      currentStep: `noop_checkpoint_${completed}`,
      progressCurrent: index,
      progressTotal: total,
    });
    await appendJobLog({
      jobId,
      level: "info",
      message: "Noop checkpoint started",
      payload: { checkpoint: completed, total },
    });
    if (delay) await sleep(delay);
    await recordJobStep({
      jobId,
      stepKey: "noop",
      status: "running",
      progressCurrent: completed,
      progressTotal: total,
      checkpoint: { phase: "checkpoint", completed, total },
    });
    await markJobStatus({
      jobId,
      status: "running",
      currentStep: `noop_checkpoint_${completed}`,
      progressCurrent: completed,
      progressTotal: total,
    });
    const control = await checkpointJobControl({ jobId, workerName: String(job.worker_name || "") });
    if (control !== null) {
      const stepStatus = control.action === "pause" ? "paused" : "stopped";
      await recordJobStep({
        jobId,
        stepKey: "noop",
        status: stepStatus,
        progressCurrent: completed,
        progressTotal: total,
        checkpoint: { phase: stepStatus, completed, total, message: control.message },
      });
      return;
    }
  }

  await markJobStatus({
    jobId,
    status: "success",
    currentStep: "completed",
    progressCurrent: total,
    progressTotal: total,
    controlState: "idle",
    resultSummary: { mode: "noop", message: "Generic admin control-plane smoke job completed." },
  });
  await recordJobStep({
    jobId,
    stepKey: "noop",
    status: "success",
    progressCurrent: total,
    progressTotal: total,
    checkpoint: { phase: "completed", total },
  });
}

// ── Drug-pipeline auto-chaining ───────────────────────────────────────────────

/** Faithful port of `_maybe_auto_chain` — create the next drug-pipeline phase after success. */
export async function maybeAutoChain(opts: {
  completedJobType: string;
  parentJobId: string;
  workerName: string;
}): Promise<void> {
  const { completedJobType, parentJobId, workerName } = opts;
  const NEXT: Record<string, string> = {
    drug_index_import: "drug_enrichment",
    drug_enrichment: "drug_analysis",
  };
  const nextType = NEXT[completedJobType];
  if (!nextType) return;

  try {
    const { getDrugPipelineStatus } = await import("./adminDrug.js");
    const { getUnhealthyDependencies } = await import("./adminServices.js");
    const status = (await getDrugPipelineStatus()) as Record<string, Record<string, unknown>>;
    let hasWork: boolean;
    if (nextType === "drug_enrichment") {
      hasWork = Number((status.enrichment as Record<string, unknown>).queue_pending || 0) > 0;
    } else {
      hasWork = !(status.analysis as Record<string, unknown>).is_complete;
    }
    if (!hasWork) {
      await appendJobLog({
        jobId: parentJobId,
        level: "info",
        message: `Auto-chain: no pending work for ${nextType}, skipping.`,
      });
      return;
    }

    const unhealthy = await getUnhealthyDependencies(nextType);
    if (unhealthy.length > 0) {
      await appendJobLog({
        jobId: parentJobId,
        level: "warn",
        message: `Auto-chain: skipping ${nextType} — service(s) unhealthy: ${unhealthy.join(", ")}.`,
        payload: { unhealthy },
      });
      return;
    }

    const activeRes = await query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM admin.import_jobs
        WHERE job_type = $1 AND status IN ('queued','running','paused')`,
      [nextType],
    );
    if (Number(activeRes.rows[0]?.count ?? 0) > 0) {
      await appendJobLog({
        jobId: parentJobId,
        level: "info",
        message: `Auto-chain: ${nextType} already active, skipping duplicate.`,
      });
      return;
    }

    const nextJob = await createJob({
      moduleKey: "drug",
      jobType: nextType,
      requestedBy: `auto_chain:${workerName}`,
      parentJobId,
    });
    await appendJobLog({
      jobId: parentJobId,
      level: "info",
      message: `Auto-chain: created ${nextType} job.`,
      payload: { next_job_id: nextJob.job_id },
    });
  } catch (exc) {
    await appendJobLog({
      jobId: parentJobId,
      level: "warn",
      message: `Auto-chain: could not create ${nextType} (${String(exc)}).`,
    });
  }
}

// ════════════════════════════════════════════════════════════════════════════
// W2b — data-plane loader handlers
//
// Faithful ports of the `_run_*_import_job` functions in admin_jobs.py. Each
// wraps a Node loader with the step/progress/checkpoint/result_summary
// bookkeeping. Lightweight (no MinIO source materialisation, no staging) jobs
// land first; staging/promote and the drug shell-out follow.
// ════════════════════════════════════════════════════════════════════════════

/** Faithful port of `_run_guideline_seed_job`. */
export async function runGuidelineSeedJob(opts: {
  workerName: string;
  job: Record<string, unknown>;
}): Promise<void> {
  const { workerName, job } = opts;
  const jobId = String(job.job_id);
  const { seedGuidelines } = await import("../loaders/guideline.js");
  const total = 2;
  const startAt = Math.max(Number(job.progress_current || 0), 0);
  const beforeCount = await countTableRows("guideline.disease_guidelines");

  if (startAt < 1) {
    await appendJobLog({ jobId, level: "info", message: "Preparing guideline seed job", payload: { checkpoint: 1, total } });
    await recordJobStep({ jobId, stepKey: "prepare", status: "success", progressCurrent: 1, progressTotal: total, checkpoint: { phase: "prepared" } });
    await markJobStatus({ jobId, status: "running", currentStep: "prepared", progressCurrent: 1, progressTotal: total });
    if (await applyControlCheckpoint({ jobId, workerName })) return;
  }

  await appendJobLog({ jobId, level: "info", message: "Running guideline seed loader", payload: { resumed: startAt > 0 } });
  await recordJobStep({ jobId, stepKey: "seed", status: "running", progressCurrent: 1, progressTotal: total, checkpoint: { phase: "seeding" } });
  await markJobStatus({ jobId, status: "running", currentStep: "seeding", progressCurrent: 1, progressTotal: total });
  await seedGuidelines(getPool());
  const afterCount = await countTableRows("guideline.disease_guidelines");
  await recordJobStep({ jobId, stepKey: "seed", status: "success", progressCurrent: 2, progressTotal: total, checkpoint: { phase: "seeded", row_count: afterCount } });
  await markJobStatus({
    jobId,
    status: "success",
    currentStep: "completed",
    progressCurrent: 2,
    progressTotal: total,
    controlState: "idle",
    resultSummary: {
      job_type: "guideline_seed",
      row_count_before: beforeCount,
      row_count_after: afterCount,
      seeded: afterCount > beforeCount,
    },
  });
}

/** Faithful port of `_run_health_supplements_sync_job`. */
export async function runHealthSupplementsSyncJob(opts: {
  workerName: string;
  job: Record<string, unknown>;
}): Promise<void> {
  const { workerName, job } = opts;
  const jobId = String(job.job_id);
  const { loadHealthSupplements } = await import("../loaders/healthSupplements.js");
  const total = 3;
  const startAt = Math.max(Number(job.progress_current || 0), 0);
  let rowCount = 0;

  if (startAt < 1) {
    await appendJobLog({ jobId, level: "info", message: "Preparing health supplements sync job", payload: { checkpoint: 1, total } });
    await recordJobStep({ jobId, stepKey: "prepare", status: "success", progressCurrent: 1, progressTotal: total, checkpoint: { phase: "prepared" } });
    await markJobStatus({ jobId, status: "running", currentStep: "prepared", progressCurrent: 1, progressTotal: total });
    if (await applyControlCheckpoint({ jobId, workerName })) return;
  }

  if (startAt < 2) {
    await appendJobLog({ jobId, level: "info", message: "Syncing Taiwan FDA health supplements module", payload: { resumed: startAt > 0 } });
    await recordJobStep({ jobId, stepKey: "sync", status: "running", progressCurrent: 1, progressTotal: total, checkpoint: { phase: "syncing" } });
    await markJobStatus({ jobId, status: "running", currentStep: "syncing_health_supplements", progressCurrent: 1, progressTotal: total });
    await loadHealthSupplements(getPool());
    rowCount = await countTableRows("health_supplements.items");
    await recordJobStep({ jobId, stepKey: "sync", status: "success", progressCurrent: 2, progressTotal: total, checkpoint: { phase: "synced", row_count: rowCount } });
    await markJobStatus({ jobId, status: "running", currentStep: "finalizing_health_supplements", progressCurrent: 2, progressTotal: total });
    if (await applyControlCheckpoint({ jobId, workerName })) return;
  } else {
    rowCount = await countTableRows("health_supplements.items");
  }

  await recordJobStep({ jobId, stepKey: "finalize", status: "success", progressCurrent: 3, progressTotal: total, checkpoint: { phase: "completed", row_count: rowCount } });
  await markJobStatus({
    jobId,
    status: "success",
    currentStep: "completed",
    progressCurrent: 3,
    progressTotal: total,
    controlState: "idle",
    resultSummary: { job_type: "health_supplements_sync", row_count: rowCount },
  });
}

/** Faithful port of `_run_food_nutrition_sync_job`. */
export async function runFoodNutritionSyncJob(opts: {
  workerName: string;
  job: Record<string, unknown>;
}): Promise<void> {
  const { workerName, job } = opts;
  const jobId = String(job.job_id);
  const { loadFoodNutrition } = await import("../loaders/foodNutrition.js");
  const total = 3;
  const startAt = Math.max(Number(job.progress_current || 0), 0);
  let measurementCount = 0;
  let ingredientCount = 0;

  if (startAt < 1) {
    await appendJobLog({ jobId, level: "info", message: "Preparing food nutrition sync job", payload: { checkpoint: 1, total } });
    await recordJobStep({ jobId, stepKey: "prepare", status: "success", progressCurrent: 1, progressTotal: total, checkpoint: { phase: "prepared" } });
    await markJobStatus({ jobId, status: "running", currentStep: "prepared", progressCurrent: 1, progressTotal: total });
    if (await applyControlCheckpoint({ jobId, workerName })) return;
  }

  if (startAt < 2) {
    await appendJobLog({ jobId, level: "info", message: "Syncing Taiwan FDA food nutrition modules", payload: { resumed: startAt > 0 } });
    await recordJobStep({ jobId, stepKey: "sync", status: "running", progressCurrent: 1, progressTotal: total, checkpoint: { phase: "syncing" } });
    await markJobStatus({ jobId, status: "running", currentStep: "syncing_food_nutrition", progressCurrent: 1, progressTotal: total });
    await loadFoodNutrition(getPool());
    measurementCount = await countTableRows("food_nutrition.measurements");
    ingredientCount = await countTableRows("food_nutrition.ingredients");
    await recordJobStep({
      jobId,
      stepKey: "sync",
      status: "success",
      progressCurrent: 2,
      progressTotal: total,
      checkpoint: { phase: "synced", measurement_count: measurementCount, ingredient_count: ingredientCount },
    });
    await markJobStatus({ jobId, status: "running", currentStep: "finalizing_food_nutrition", progressCurrent: 2, progressTotal: total });
    if (await applyControlCheckpoint({ jobId, workerName })) return;
  } else {
    measurementCount = await countTableRows("food_nutrition.measurements");
    ingredientCount = await countTableRows("food_nutrition.ingredients");
  }

  await recordJobStep({
    jobId,
    stepKey: "finalize",
    status: "success",
    progressCurrent: 3,
    progressTotal: total,
    checkpoint: { phase: "completed", measurement_count: measurementCount, ingredient_count: ingredientCount },
  });
  await markJobStatus({
    jobId,
    status: "success",
    currentStep: "completed",
    progressCurrent: 3,
    progressTotal: total,
    controlState: "idle",
    resultSummary: { job_type: "food_nutrition_sync", measurement_count: measurementCount, ingredient_count: ingredientCount },
  });
}

/** Faithful port of `_run_icd_import_job` (staged import: validate → stage → promote). */
export async function runIcdImportJob(opts: {
  workerName: string;
  job: Record<string, unknown>;
}): Promise<void> {
  const { workerName, job } = opts;
  const jobId = String(job.job_id);
  const {
    parseIcd10cmStageRecords,
    parseIcd10pcsStageRecords,
    parseIcdBilingualNames,
  } = await import("../loaders/icd.js");
  const {
    withMaterializedSources,
    runValidateStep,
    stageRows,
    checkpointBeforePromote,
    optimizedPromote,
    clearStageRows,
  } = await import("./adminJobStaging.js");

  const manifest = parseJsonb(parseJsonb(job.job_options).source_manifest);
  const total = 5;
  let progress = Math.max(Number(job.progress_current || 0), 0);

  await appendJobLog({
    jobId,
    level: "info",
    message: "Starting ICD staged import",
    payload: { source_manifest: manifest },
  });

  await withMaterializedSources(manifest, async (paths) => {
    let cmZh = new Map<string, string>();
    let pcsZh = new Map<string, string>();
    const bilingualPath = paths.icd_zh_tw;

    if (progress < 1) {
      if (bilingualPath) ({ cmZh, pcsZh } = parseIcdBilingualNames(bilingualPath));
      await runValidateStep({
        jobId,
        stepKey: "validate_sources",
        currentStep: "validated_sources",
        checkpoint: {
          phase: "validated",
          source_roles: Object.keys(paths).sort(),
          has_bilingual_names: Boolean(bilingualPath),
          cm_chinese_name_count: cmZh.size,
          pcs_chinese_name_count: pcsZh.size,
        },
        jobProgressAfter: 1,
        jobProgressTotal: total,
      });
      progress = 1;
      if (await applyControlCheckpoint({ jobId, workerName })) return;
    } else if (bilingualPath) {
      ({ cmZh, pcsZh } = parseIcdBilingualNames(bilingualPath));
    }

    const diagnoses = parseIcd10cmStageRecords(paths.icd10cm, cmZh);
    const procedures =
      "icd10pcs" in paths ? parseIcd10pcsStageRecords(paths.icd10pcs, pcsZh) : [];

    if (progress < 2) {
      const interrupted = await stageRows({
        jobId,
        workerName,
        stepKey: "stage_diagnoses",
        runningStepName: "staging_diagnoses",
        rows: diagnoses,
        insertSql: `
          INSERT INTO admin.stage_icd_diagnoses (job_id, code, name_en, name_zh, category)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (job_id, code) DO UPDATE SET
            name_en = EXCLUDED.name_en,
            name_zh = EXCLUDED.name_zh,
            category = EXCLUDED.category
        `,
        batchSize: 5000,
        jobProgressBefore: 1,
        jobProgressAfter: 2,
        jobProgressTotal: total,
        checkpointLabel: "staging_diagnoses",
      });
      if (interrupted) return;
      progress = 2;
    }

    if (progress < 3) {
      const interrupted = await stageRows({
        jobId,
        workerName,
        stepKey: "stage_procedures",
        runningStepName: "staging_procedures",
        rows: procedures,
        insertSql: `
          INSERT INTO admin.stage_icd_procedures (job_id, code, name_en, name_zh)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (job_id, code) DO UPDATE SET
            name_en = EXCLUDED.name_en,
            name_zh = EXCLUDED.name_zh
        `,
        batchSize: 5000,
        jobProgressBefore: 2,
        jobProgressAfter: 3,
        jobProgressTotal: total,
        checkpointLabel: "staging_procedures",
      });
      if (interrupted) return;
      progress = 3;
    }

    if (progress < 4) {
      if (
        await checkpointBeforePromote({
          jobId,
          workerName,
          stepKey: "promote",
          jobProgressBefore: 3,
          jobProgressTotal: total,
        })
      ) {
        return;
      }
      await optimizedPromote({
        jobId,
        stepKey: "promote",
        indexTables: ["icd.diagnoses", "icd.procedures"],
        truncateSql: "TRUNCATE icd.diagnoses, icd.procedures",
        copies: [
          {
            sql: `
              INSERT INTO icd.diagnoses (code, name_en, name_zh, category)
              SELECT code, name_en, name_zh, category
              FROM admin.stage_icd_diagnoses
              WHERE job_id = $1::uuid
            `,
            args: [jobId],
            label: `diagnoses (${fmt(diagnoses.length)})`,
          },
          {
            sql: `
              INSERT INTO icd.procedures (code, name_en, name_zh)
              SELECT code, name_en, name_zh
              FROM admin.stage_icd_procedures
              WHERE job_id = $1::uuid
            `,
            args: [jobId],
            label: `procedures (${fmt(procedures.length)})`,
          },
        ],
        finalCheckpoint: {
          phase: "promoted",
          diagnosis_count: diagnoses.length,
          procedure_count: procedures.length,
        },
        promotedStepName: "promoted_icd",
        jobProgressAfter: 4,
        jobProgressTotal: total,
      });
      progress = 4;
    }

    await clearStageRows(jobId, ["admin.stage_icd_diagnoses", "admin.stage_icd_procedures"]);
    await recordJobStep({
      jobId,
      stepKey: "cleanup_staging",
      status: "success",
      progressCurrent: 1,
      progressTotal: 1,
      checkpoint: { phase: "cleaned" },
    });
    await markJobStatus({
      jobId,
      status: "success",
      currentStep: "completed",
      progressCurrent: 5,
      progressTotal: total,
      controlState: "idle",
      resultSummary: {
        job_type: "icd_import",
        source_manifest: manifest,
        diagnosis_count: diagnoses.length,
        procedure_count: procedures.length,
        cm_chinese_name_count: diagnoses.filter((row) => row[2]).length,
        pcs_chinese_name_count: procedures.filter((row) => row[2]).length,
      },
    });
  });
}

// ── Job dispatcher ────────────────────────────────────────────────────────────

/**
 * Raised by W2a loader branches that are not yet wired. W2b replaces these
 * throws with the real staging/promote handlers around the Node loaders.
 */
export class W2bNotImplementedError extends Error {}

/** Faithful port of `execute_admin_job`. Dispatches one claimed job to its handler. */
export async function executeAdminJob(opts: {
  workerName: string;
  job: Record<string, unknown>;
  // minioService deliberately omitted in W2a; W2b loader bodies take it.
}): Promise<void> {
  const { workerName, job } = opts;
  const jobId = String(job.job_id);
  const jobType = String(job.job_type);

  // Scope verbose logging to this job (its own async context).
  await logVerboseStore.run(resolveLogVerbose(job), async () => {
    // Dependency gate — fail fast if a required service is hard-down.
    const { getUnhealthyDependencies } = await import("./adminServices.js");
    const unhealthy = await getUnhealthyDependencies(jobType);
    if (unhealthy.length > 0) {
      await markJobStatus({
        jobId,
        status: "permanent_failed",
        currentStep: "dependency_check",
        controlState: "idle",
        lastErrorCode: "service_dependency_error",
        lastErrorMessage: `Required service(s) not healthy: ${unhealthy.join(", ")}. Run an active service probe from the Services tab, then retry.`,
      });
      await appendJobLog({
        jobId,
        level: "error",
        message: "Job blocked by unhealthy service dependency",
        payload: { unhealthy_services: unhealthy, job_type: jobType },
      });
      return;
    }

    if (jobType === "noop") {
      await runNoopJob(job);
      const finalJob = await getJob(jobId);
      if (finalJob && finalJob.status === "success") {
        await appendJobLog({
          jobId,
          level: "info",
          message: "Job completed successfully",
          payload: { worker_name: workerName },
        });
      }
      return;
    }
    if (jobType === "guideline_seed") {
      await runGuidelineSeedJob({ workerName, job });
      return;
    }
    if (jobType === "health_supplements_sync") {
      await runHealthSupplementsSyncJob({ workerName, job });
      return;
    }
    if (jobType === "food_nutrition_sync") {
      await runFoodNutritionSyncJob({ workerName, job });
      return;
    }
    if (jobType === "icd_import") {
      await runIcdImportJob({ workerName, job });
      return;
    }

    // ── W2b loader handlers (not yet wired) ──────────────────────────────────
    // The dispatcher structure mirrors execute_admin_job exactly so W2b only
    // needs to replace each throw with the real handler over the Node loaders
    // (drug stages shell out to Python loader/main.py).
    const W2B_JOB_TYPES = new Set([
      "loinc_import",
      "ig_import",
      "snomed_import",
      "rxnorm_import",
      "drug_index_import",
      "drug_enrichment",
      "drug_analysis",
      "icd_embed",
      "loinc_embed",
      "health_supplements_embed",
      "food_nutrition_embed",
      "guideline_embed",
      "snomed_embed",
    ]);
    if (W2B_JOB_TYPES.has(jobType)) {
      throw new W2bNotImplementedError(`W2b: loader handler for job type '${jobType}' not yet wired`);
    }

    // Unknown job type — mirror execute_admin_job's terminal unsupported path.
    await markJobStatus({
      jobId,
      status: "permanent_failed",
      currentStep: "unsupported",
      controlState: "idle",
      lastErrorCode: "unsupported_job_type",
      lastErrorMessage: `No admin adapter registered for job type '${jobType}'`,
    });
    await appendJobLog({
      jobId,
      level: "error",
      message: "Unsupported job type",
      payload: { worker_name: workerName, job_type: jobType },
    });
  });
}
