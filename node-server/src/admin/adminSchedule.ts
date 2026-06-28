/**
 * Module import-schedule read surface.
 *
 * Faithful port of the read path in `src/admin_schedule.py`: the module-set
 * constants (`URL_FETCH_MODULES`, `API_SYNC_MODULES`, `SCHEDULABLE_MODULES`),
 * the `ScheduleConfig.to_dict` shape, and `get_schedule`. Mutations
 * (`upsert_schedule` / delete / trigger / `compute_next_run`) belong to the
 * write chunk.
 *
 * Timestamps are serialized by the endpoint via `.isoformat()` (the
 * `ScheduleConfig.to_dict` strings come from `_iso`, which calls
 * `datetime.isoformat()`), so they go through `tsIsoExpr` + `pyIso` — the
 * `T`-separated, microsecond, `+00:00` form.
 */

import { query } from "../db.js";
import { tsIsoExpr, pyIso, createJob } from "./adminJobs.js";
import { createUploadedSource, ROLE_JOB_TYPE } from "./adminSources.js";
import * as minioService from "../minioService.js";

/** Faithful port of `_API_SYNC_JOB_TYPE` (api-sync module → sync job type). */
const API_SYNC_JOB_TYPE: Record<string, string> = {
  health_supplements: "health_supplements_sync",
  food_nutrition: "food_nutrition_sync",
};

/** Raised on schedule validation failures (mirrors Python ValueError → HTTP 400). */
export class ScheduleValueError extends Error {}

/** Modules where the schedule downloads from fetch_url then queues an import. */
export const URL_FETCH_MODULES: ReadonlySet<string> = new Set(["icd", "ig", "drug"]);

/** Modules where the schedule just creates a sync job (no file download). */
export const API_SYNC_MODULES: ReadonlySet<string> = new Set(["health_supplements", "food_nutrition"]);

/** All modules that accept a schedule. */
export const SCHEDULABLE_MODULES: ReadonlySet<string> = new Set([...URL_FETCH_MODULES, ...API_SYNC_MODULES]);

interface ScheduleRow {
  schedule_id: string;
  module_key: string;
  source_role: string | null;
  fetch_url: string | null;
  frequency: string;
  day_of_week: number | null;
  day_of_month: number | null;
  hour_utc: number | string;
  minute_utc: number | string;
  is_enabled: boolean;
  last_run_status: string | null;
  last_run_job_id: string | null;
  last_error: string | null;
  created_by: string;
  // Pre-rendered isoformat text (UTC, microsecond) or null.
  last_run_at_iso: string | null;
  next_run_at_iso: string | null;
  created_at_iso: string | null;
  updated_at_iso: string | null;
}

/** Mirror `_iso`: render the Postgres-side isoformat text, null stays null. */
function isoOrNull(text: string | null): string | null {
  return text === null || text === undefined ? null : pyIso(text);
}

/** Mirror `_row_to_config(...).to_dict()`. */
function rowToDict(row: ScheduleRow): Record<string, unknown> {
  return {
    schedule_id: String(row.schedule_id),
    module_key: row.module_key,
    source_role: row.source_role ?? null,
    fetch_url: row.fetch_url ?? null,
    frequency: row.frequency,
    day_of_week: row.day_of_week ?? null,
    day_of_month: row.day_of_month ?? null,
    hour_utc: Number(row.hour_utc),
    minute_utc: Number(row.minute_utc),
    is_enabled: Boolean(row.is_enabled),
    last_run_at: isoOrNull(row.last_run_at_iso),
    next_run_at: isoOrNull(row.next_run_at_iso),
    last_run_status: row.last_run_status ?? null,
    last_run_job_id: row.last_run_job_id ? String(row.last_run_job_id) : null,
    last_error: row.last_error ?? null,
    created_by: row.created_by,
    // Python: `_iso(...) or ""` — null/empty coerces to "".
    created_at: isoOrNull(row.created_at_iso) || "",
    updated_at: isoOrNull(row.updated_at_iso) || "",
  };
}

/** Faithful port of `get_schedule`. Returns the to_dict shape or null. */
export async function getSchedule(moduleKey: string): Promise<Record<string, unknown> | null> {
  const res = await query<ScheduleRow>(
    `SELECT *,
            ${tsIsoExpr("last_run_at")} AS last_run_at_iso,
            ${tsIsoExpr("next_run_at")} AS next_run_at_iso,
            ${tsIsoExpr("created_at")} AS created_at_iso,
            ${tsIsoExpr("updated_at")} AS updated_at_iso
       FROM admin.module_schedules
       WHERE module_key = $1`,
    [moduleKey],
  );
  if (res.rows.length === 0) return null;
  return rowToDict(res.rows[0]);
}

/**
 * Faithful port of `compute_next_run`: the next scheduled UTC `Date` strictly
 * after *now* (truncated to the minute). Throws `ScheduleValueError` on an
 * unknown frequency. All arithmetic is in UTC to mirror Python's tz-aware logic.
 */
export function computeNextRun(
  frequency: string,
  dayOfWeek: number | null,
  dayOfMonth: number | null,
  hourUtc: number,
  minuteUtc: number,
  now?: Date,
): Date {
  const base = now ?? new Date();
  // .replace(second=0, microsecond=0)
  const nowMin = new Date(
    Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), base.getUTCHours(), base.getUTCMinutes(), 0, 0),
  );
  const at = (ref: Date): Date =>
    new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate(), hourUtc, minuteUtc, 0, 0));
  const DAY = 86_400_000;

  if (frequency === "daily") {
    let c = at(nowMin);
    if (c <= nowMin) c = at(new Date(nowMin.getTime() + DAY));
    return c;
  }

  if (frequency === "weekly") {
    const dow = dayOfWeek !== null && dayOfWeek !== undefined ? dayOfWeek : 0;
    // Python weekday(): Mon=0..Sun=6. JS getUTCDay(): Sun=0..Sat=6.
    const todayDow = (nowMin.getUTCDay() + 6) % 7;
    const daysAhead = (((dow - todayDow) % 7) + 7) % 7;
    if (daysAhead === 0) {
      let c = at(nowMin);
      if (c <= nowMin) c = at(new Date(nowMin.getTime() + 7 * DAY));
      return c;
    }
    return at(new Date(nowMin.getTime() + daysAhead * DAY));
  }

  if (frequency === "monthly") {
    const targetDay = Math.max(1, Math.min(28, dayOfMonth !== null && dayOfMonth !== undefined ? dayOfMonth : 1));
    let c = at(new Date(Date.UTC(nowMin.getUTCFullYear(), nowMin.getUTCMonth(), targetDay)));
    if (c <= nowMin) {
      let year = nowMin.getUTCFullYear();
      let month = nowMin.getUTCMonth();
      if (month === 11) {
        year += 1;
        month = 0;
      } else {
        month += 1;
      }
      c = new Date(Date.UTC(year, month, targetDay, hourUtc, minuteUtc, 0, 0));
    }
    return c;
  }

  throw new ScheduleValueError(`Unknown frequency: ${JSON.stringify(frequency)}. Expected 'daily', 'weekly', or 'monthly'.`);
}

/**
 * Faithful port of `upsert_schedule`: insert/update one row keyed by module_key,
 * computing `next_run_at` automatically. Returns the `to_dict` shape.
 */
export async function upsertSchedule(opts: {
  moduleKey: string;
  sourceRole: string | null;
  fetchUrl: string | null;
  frequency: string;
  dayOfWeek: number | null;
  dayOfMonth: number | null;
  hourUtc: number;
  minuteUtc: number;
  isEnabled: boolean;
  createdBy: string;
}): Promise<Record<string, unknown>> {
  const now = new Date();
  const nextRun = computeNextRun(opts.frequency, opts.dayOfWeek, opts.dayOfMonth, opts.hourUtc, opts.minuteUtc, now);
  const res = await query<ScheduleRow>(
    `WITH up AS (
       INSERT INTO admin.module_schedules (
         schedule_id, module_key, source_role, fetch_url,
         frequency, day_of_week, day_of_month,
         hour_utc, minute_utc, is_enabled, next_run_at,
         created_by, created_at, updated_at
       )
       VALUES (
         gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
         $11, $12, $12
       )
       ON CONFLICT (module_key) DO UPDATE SET
         source_role  = EXCLUDED.source_role,
         fetch_url    = EXCLUDED.fetch_url,
         frequency    = EXCLUDED.frequency,
         day_of_week  = EXCLUDED.day_of_week,
         day_of_month = EXCLUDED.day_of_month,
         hour_utc     = EXCLUDED.hour_utc,
         minute_utc   = EXCLUDED.minute_utc,
         is_enabled   = EXCLUDED.is_enabled,
         next_run_at  = EXCLUDED.next_run_at,
         updated_at   = EXCLUDED.updated_at
       RETURNING *
     )
     SELECT *,
            ${tsIsoExpr("last_run_at")} AS last_run_at_iso,
            ${tsIsoExpr("next_run_at")} AS next_run_at_iso,
            ${tsIsoExpr("created_at")} AS created_at_iso,
            ${tsIsoExpr("updated_at")} AS updated_at_iso
       FROM up`,
    [
      opts.moduleKey,
      opts.sourceRole,
      opts.fetchUrl,
      opts.frequency,
      opts.dayOfWeek,
      opts.dayOfMonth,
      opts.hourUtc,
      opts.minuteUtc,
      opts.isEnabled,
      nextRun,
      opts.createdBy,
      now,
    ],
  );
  return rowToDict(res.rows[0]);
}

/** Faithful port of `delete_schedule`: returns true if a row was deleted. */
export async function deleteSchedule(moduleKey: string): Promise<boolean> {
  const res = await query("DELETE FROM admin.module_schedules WHERE module_key = $1", [moduleKey]);
  return (res.rowCount ?? 0) > 0;
}

/** The schedule shape `fireSchedule` consumes (a `getSchedule` to_dict result). */
export interface FireScheduleInput {
  schedule_id: string;
  module_key: string;
  source_role: string | null;
  fetch_url: string | null;
  frequency: string;
  day_of_week: number | null;
  day_of_month: number | null;
  hour_utc: number;
  minute_utc: number;
}

/**
 * Faithful port of `mark_schedule_run`: record the outcome of a schedule fire
 * and advance `next_run_at`.
 */
export async function markScheduleRun(opts: {
  scheduleId: string;
  jobId: string | null;
  status: string;
  error: string | null;
  frequency: string;
  dayOfWeek: number | null;
  dayOfMonth: number | null;
  hourUtc: number;
  minuteUtc: number;
}): Promise<void> {
  const now = new Date();
  const nextRun = computeNextRun(opts.frequency, opts.dayOfWeek, opts.dayOfMonth, opts.hourUtc, opts.minuteUtc, now);
  await query(
    `UPDATE admin.module_schedules
        SET last_run_at     = $2,
            last_run_status = $3,
            last_run_job_id = $4,
            last_error      = $5,
            next_run_at     = $6,
            updated_at      = $2
      WHERE schedule_id = $1`,
    [opts.scheduleId, now, opts.status, opts.jobId, opts.error, nextRun],
  );
}

/**
 * Faithful port of `_download_url`: download *url* and return `[data, filename]`.
 * Filename comes from `Content-Disposition` first, then the URL's last path
 * component. Throws on non-HTTPS (SSRF guard) or HTTP 4xx/5xx.
 */
export async function downloadUrl(url: string, timeoutSeconds = 300): Promise<[Buffer, string]> {
  if (!url.toLowerCase().startsWith("https://")) {
    throw new ScheduleValueError("Schedule fetch_url must use HTTPS to prevent SSRF");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
  let response: Response;
  try {
    response = await fetch(url, { redirect: "follow", signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} fetching ${url}`);
  }
  const data = Buffer.from(await response.arrayBuffer());

  let filename: string | null = null;
  const cd = response.headers.get("content-disposition") ?? "";
  if (cd.includes("filename=")) {
    for (const rawPart of cd.split(";")) {
      const part = rawPart.trim();
      if (part.toLowerCase().startsWith("filename=")) {
        filename = part.slice(9).trim().replace(/^["']|["']$/g, "");
        break;
      }
    }
  }
  if (!filename) {
    let pathPart: string;
    try {
      pathPart = new URL(url).pathname;
    } catch {
      pathPart = "";
    }
    filename = pathPart.replace(/\/+$/, "").split("/").pop() || "download";
  }
  return [data, filename];
}

/**
 * Faithful port of `fire_schedule`: execute the action described by *schedule*,
 * create the appropriate job, and record the run via `markScheduleRun`. Returns
 * `{job_id, status, error}`. For api-sync modules it queues the sync job
 * directly; for URL-fetch modules it downloads → uploads a new source → queues
 * the import job.
 */
export async function fireSchedule(opts: {
  schedule: FireScheduleInput;
  triggeredBy?: string;
}): Promise<{ job_id: string | null; status: string; error: string | null }> {
  const schedule = opts.schedule;
  const triggeredBy = opts.triggeredBy ?? "scheduler";
  let jobId: string | null = null;
  let status = "failed";
  let error: string | null = null;

  try {
    if (API_SYNC_MODULES.has(schedule.module_key)) {
      // API-sync: just queue the sync job.
      const jobType = API_SYNC_JOB_TYPE[schedule.module_key];
      const job = await createJob({
        moduleKey: schedule.module_key,
        jobType,
        requestedBy: triggeredBy,
        jobOptions: { source: "scheduler" },
      });
      jobId = String(job.job_id);
      status = "success";
    } else if (schedule.fetch_url) {
      // URL-fetch: download → upload → import.
      if (!minioService.enabled()) {
        throw new Error("MinIO is required for schedule URL-fetch but is not available");
      }
      const [data, filename] = await downloadUrl(schedule.fetch_url);
      const uploadResult = await createUploadedSource({
        moduleKey: schedule.module_key,
        sourceRole: schedule.source_role ?? "",
        originalFilename: filename,
        mimeType: "application/octet-stream",
        data,
        uploadedBy: triggeredBy,
        autoActivate: false,
      });

      const jobType = ROLE_JOB_TYPE.get(`${schedule.module_key}|${schedule.source_role ?? ""}`);
      if (!jobType) {
        throw new ScheduleValueError(
          `No job type found for role ('${schedule.module_key}', '${schedule.source_role ?? ""}'). ` +
            "Ensure source_role is valid in SOURCE_CATALOG.",
        );
      }
      const job = await createJob({
        moduleKey: schedule.module_key,
        jobType,
        requestedBy: triggeredBy,
        jobOptions: {
          source: "scheduler",
          triggered_by: triggeredBy,
          filename,
          is_duplicate: uploadResult.duplicate,
        },
      });
      jobId = String(job.job_id);
      status = "success";
    } else {
      error = `Schedule for '${schedule.module_key}' has no fetch_url and is not an api-sync module`;
    }
  } catch (exc) {
    error = String((exc as Error).message);
  }

  await markScheduleRun({
    scheduleId: schedule.schedule_id,
    jobId,
    status,
    error,
    frequency: schedule.frequency,
    dayOfWeek: schedule.day_of_week,
    dayOfMonth: schedule.day_of_month,
    hourUtc: schedule.hour_utc,
    minuteUtc: schedule.minute_utc,
  });

  return { job_id: jobId, status, error };
}
