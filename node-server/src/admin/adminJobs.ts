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
import { query, withTransaction } from "../db.js";
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
