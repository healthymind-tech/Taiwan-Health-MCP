/**
 * Shared staging/promote machinery for heavy admin import jobs (W2b batch 2).
 *
 * Faithful port of the module-agnostic helpers in `src/admin_jobs.py`:
 * `_ProgressLogThrottle`, `_stage_rows`, `_run_validate_step`,
 * `_checkpoint_before_promote`, `_capture_secondary_indexes`,
 * `_optimized_promote`, `_clear_stage_rows`, and the `_materialize_bound_sources`
 * async-context-manager (rendered here as `withMaterializedSources`).
 *
 * The per-module `_run_*_import_job` handlers (icd/loinc/snomed/ig/rxnorm) wire
 * their parsers through `stageRows` → `optimizedPromote` using these primitives.
 */

import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type pg from "pg";
import { withTransaction, getPool } from "../db.js";
import * as minioService from "../minioService.js";
import { safeSourceFilename } from "./adminSources.js";
import {
  recordJobStep,
  markJobStatus,
  appendJobLog,
  jobDebugLog,
  checkpointJobControl,
  getJobStepCheckpoint,
} from "./adminJobs.js";

/** Mirror `_fmt` (thousands separator). */
function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * Mirror `_ProgressLogThrottle`: emit at most one progress line every `pctStep`
 * percent or `secs` seconds, whichever comes first.
 */
class ProgressLogThrottle {
  private lastPct = 0;
  private lastT = Date.now();
  constructor(private pctStep = 10, private secs = 5) {}
  should(current: number, total: number): boolean {
    if (total <= 0) return false;
    const pct = Math.trunc((current * 100) / total);
    const now = Date.now();
    if (pct >= this.lastPct + this.pctStep || (now - this.lastT) / 1000 >= this.secs) {
      this.lastPct = pct;
      this.lastT = now;
      return true;
    }
    return false;
  }
}

/** A staged row is the column tuple AFTER job_id (which stageRows prepends). */
export type StageRow = ReadonlyArray<unknown>;

export interface StageRowsInput {
  jobId: string;
  workerName: string;
  stepKey: string;
  runningStepName: string;
  rows: StageRow[];
  /** Single-row INSERT with $1=job_id, $2..=row columns (ON CONFLICT upsert). */
  insertSql: string;
  batchSize: number;
  jobProgressBefore: number;
  jobProgressAfter: number;
  jobProgressTotal: number;
  checkpointLabel: string;
}

/**
 * Faithful port of `_stage_rows`. Batches `rows` into the stage table via
 * `insertSql`, recording per-batch step progress and honouring checkpoint
 * pause/stop. Returns true if interrupted (caller must return early).
 */
export async function stageRows(opts: StageRowsInput): Promise<boolean> {
  const {
    jobId, workerName, stepKey, runningStepName, rows, insertSql, batchSize,
    jobProgressBefore, jobProgressAfter, jobProgressTotal, checkpointLabel,
  } = opts;

  const checkpoint = await getJobStepCheckpoint(jobId, stepKey);
  let completed = Number(checkpoint.completed ?? 0) || 0;
  completed = Math.max(0, Math.min(completed, rows.length));

  const label =
    (runningStepName.startsWith("staging_") ? runningStepName.slice("staging_".length) : runningStepName)
      .replace(/_/g, " ") || stepKey;
  const stageT0 = Date.now();
  const throttle = new ProgressLogThrottle();
  if (completed > 0) {
    await appendJobLog({ jobId, level: "info", message: `Resuming ${label}: ${fmt(completed)} / ${fmt(rows.length)} already staged` });
  } else {
    await appendJobLog({ jobId, level: "info", message: `Staging ${label}: ${fmt(rows.length)} rows` });
  }

  await recordJobStep({
    jobId, stepKey, status: "running",
    progressCurrent: completed, progressTotal: rows.length,
    checkpoint: { phase: checkpointLabel, completed, row_count: rows.length, batch_size: batchSize },
  });
  await markJobStatus({
    jobId, status: "running", currentStep: runningStepName,
    progressCurrent: jobProgressBefore, progressTotal: jobProgressTotal,
  });

  if (rows.length === 0) {
    await recordJobStep({
      jobId, stepKey, status: "success", progressCurrent: 0, progressTotal: 0,
      checkpoint: { phase: `${checkpointLabel}_completed`, completed: 0, row_count: 0 },
    });
    await markJobStatus({
      jobId, status: "running", currentStep: `${runningStepName}_completed`,
      progressCurrent: jobProgressAfter, progressTotal: jobProgressTotal,
    });
    return false;
  }

  for (let start = completed; start < rows.length; start += batchSize) {
    const end = Math.min(start + batchSize, rows.length);
    const batchT0 = Date.now();
    // Mirror asyncpg executemany: one parameterised insert per row, in a single
    // transaction per batch (atomic, and the stage-table result is identical).
    await withTransaction(async (client) => {
      for (let i = start; i < end; i += 1) {
        await client.query(insertSql, [jobId, ...rows[i]]);
      }
    });
    await jobDebugLog({
      jobId,
      message: `Batch ${fmt(start)}–${fmt(end)}: inserted ${fmt(end - start)} ${label} (${((Date.now() - batchT0) / 1000).toFixed(2)}s)`,
    });
    await recordJobStep({
      jobId, stepKey, status: "running",
      progressCurrent: end, progressTotal: rows.length,
      checkpoint: { phase: checkpointLabel, completed: end, row_count: rows.length, batch_size: batchSize },
    });
    if (throttle.should(end, rows.length)) {
      await appendJobLog({
        jobId, level: "info",
        message: `Staged ${fmt(end)} / ${fmt(rows.length)} ${label} (${Math.trunc((end * 100) / rows.length)}%)`,
      });
    }
    const control = await checkpointJobControl({ jobId, workerName });
    if (control !== null) {
      const stepStatus = control.action === "pause" ? "paused" : "stopped";
      await recordJobStep({
        jobId, stepKey, status: stepStatus,
        progressCurrent: end, progressTotal: rows.length,
        checkpoint: { phase: stepStatus, completed: end, row_count: rows.length, message: control.message },
      });
      return true;
    }
  }

  await recordJobStep({
    jobId, stepKey, status: "success",
    progressCurrent: rows.length, progressTotal: rows.length,
    checkpoint: { phase: `${checkpointLabel}_completed`, completed: rows.length, row_count: rows.length },
  });
  await appendJobLog({
    jobId, level: "info",
    message: `Staged ${fmt(rows.length)} ${label} in ${((Date.now() - stageT0) / 1000).toFixed(1)}s`,
  });
  await markJobStatus({
    jobId, status: "running", currentStep: `${runningStepName}_completed`,
    progressCurrent: jobProgressAfter, progressTotal: jobProgressTotal,
  });
  return false;
}

/** Faithful port of `_run_validate_step`. */
export async function runValidateStep(opts: {
  jobId: string;
  stepKey: string;
  currentStep: string;
  checkpoint: Record<string, unknown>;
  jobProgressAfter: number;
  jobProgressTotal: number;
}): Promise<void> {
  await recordJobStep({
    jobId: opts.jobId, stepKey: opts.stepKey, status: "success",
    progressCurrent: 1, progressTotal: 1, checkpoint: opts.checkpoint,
  });
  await markJobStatus({
    jobId: opts.jobId, status: "running", currentStep: opts.currentStep,
    progressCurrent: opts.jobProgressAfter, progressTotal: opts.jobProgressTotal,
  });
  const roles = (opts.checkpoint.source_roles as unknown[]) || [];
  await appendJobLog({
    jobId: opts.jobId, level: "info",
    message: roles.length ? `Validated sources: ${roles.map(String).join(", ")}` : "Validated sources",
    payload: opts.checkpoint,
  });
}

/** Faithful port of `_checkpoint_before_promote`. Returns true if interrupted. */
export async function checkpointBeforePromote(opts: {
  jobId: string;
  workerName: string;
  stepKey: string;
  jobProgressBefore: number;
  jobProgressTotal: number;
}): Promise<boolean> {
  const { jobId, workerName, stepKey, jobProgressBefore, jobProgressTotal } = opts;
  await recordJobStep({
    jobId, stepKey, status: "running", progressCurrent: 0, progressTotal: 1,
    checkpoint: { phase: "promote_ready" },
  });
  await markJobStatus({
    jobId, status: "running", currentStep: "promote_ready",
    progressCurrent: jobProgressBefore, progressTotal: jobProgressTotal,
  });
  await appendJobLog({ jobId, level: "info", message: "Promoting staged data → live tables" });
  const control = await checkpointJobControl({ jobId, workerName });
  if (control === null) return false;
  const stepStatus = control.action === "pause" ? "paused" : "stopped";
  await recordJobStep({
    jobId, stepKey, status: stepStatus, progressCurrent: 0, progressTotal: 1,
    checkpoint: { phase: "promote_blocked", message: control.message },
  });
  return true;
}

/** Faithful port of `_capture_secondary_indexes`. */
async function captureSecondaryIndexes(
  client: pg.PoolClient,
  table: string,
): Promise<Array<[string, string, string]>> {
  const dot = table.indexOf(".");
  const schema = table.slice(0, dot);
  const name = table.slice(dot + 1);
  const res = await client.query<{ index_name: string; index_def: string }>(
    `SELECT c.relname AS index_name, pg_get_indexdef(c.oid) AS index_def
       FROM pg_index idx
       JOIN pg_class c ON c.oid = idx.indexrelid
       JOIN pg_class t ON t.oid = idx.indrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = $1 AND t.relname = $2
        AND NOT idx.indisprimary AND NOT idx.indisunique
      ORDER BY c.relname`,
    [schema, name],
  );
  return res.rows.map((r) => [schema, r.index_name, r.index_def] as [string, string, string]);
}

export interface PromoteCopy {
  sql: string;
  args: unknown[];
  label: string;
}

/** Faithful port of `_optimized_promote` (drop-index → truncate → copy → rebuild, one txn). */
export async function optimizedPromote(opts: {
  jobId: string;
  stepKey: string;
  indexTables: string[];
  truncateSql: string;
  copies: PromoteCopy[];
  finalCheckpoint: Record<string, unknown>;
  promotedStepName: string;
  jobProgressAfter: number;
  jobProgressTotal: number;
  maintenanceWorkMem?: string;
}): Promise<void> {
  const {
    jobId, stepKey, indexTables, truncateSql, copies, finalCheckpoint,
    promotedStepName, jobProgressAfter, jobProgressTotal,
  } = opts;
  const maintenanceWorkMem = opts.maintenanceWorkMem ?? "128MB";
  const subTotal = 2 + copies.length + 1; // drop, truncate, N copies, rebuild

  const phase = async (done: number, label: string): Promise<void> => {
    await recordJobStep({
      jobId, stepKey, status: "running", progressCurrent: done, progressTotal: subTotal,
      checkpoint: { phase: label },
    });
    await appendJobLog({ jobId, level: "info", message: label });
  };

  await withTransaction(async (client) => {
    await client.query(`SET LOCAL maintenance_work_mem = '${maintenanceWorkMem}'`);
    const saved: Array<[string, string, string]> = [];
    for (const table of indexTables) saved.push(...(await captureSecondaryIndexes(client, table)));
    for (const [schema, indexName] of saved) {
      await client.query(`DROP INDEX IF EXISTS "${schema}"."${indexName}"`);
    }
    await phase(1, `Promote: dropped ${saved.length} secondary index(es)`);

    await client.query(truncateSql);
    await phase(2, "Promote: truncated live tables");

    let i = 0;
    for (const copy of copies) {
      i += 1;
      await client.query(copy.sql, copy.args);
      await phase(2 + i, `Promote: copied ${copy.label}`);
    }

    for (const [, , ddl] of saved) await client.query(ddl);
    await phase(subTotal, `Promote: rebuilt ${saved.length} index(es)`);
  });

  await recordJobStep({
    jobId, stepKey, status: "success", progressCurrent: subTotal, progressTotal: subTotal,
    checkpoint: finalCheckpoint,
  });
  await markJobStatus({
    jobId, status: "running", currentStep: promotedStepName,
    progressCurrent: jobProgressAfter, progressTotal: jobProgressTotal,
  });
}

/** Faithful port of `_clear_stage_rows`. */
export async function clearStageRows(jobId: string, tableNames: string[]): Promise<void> {
  const pool = getPool();
  for (const table of tableNames) {
    await pool.query(`DELETE FROM ${table} WHERE job_id = $1::uuid`, [jobId]);
  }
}

/**
 * Faithful port of the `_materialize_bound_sources` async context manager.
 * Downloads each manifest binding from MinIO into a temp dir and invokes `fn`
 * with role→local-path, cleaning the temp dir up afterwards. Multi-source roles
 * (list bindings) are concatenated with the header row stripped from all but the
 * first file — byte-for-byte matching the Python implementation.
 */
export async function withMaterializedSources<T>(
  manifest: Record<string, unknown>,
  fn: (paths: Record<string, string>) => Promise<T>,
): Promise<T> {
  if (!minioService.enabled()) {
    throw new Error("MinIO is required to materialize admin-managed source files");
  }
  const tmpdir = await fsp.mkdtemp(path.join(os.tmpdir(), "admin-job-sources-"));
  try {
    const localPaths: Record<string, string> = {};
    const bindings = (manifest.bindings as Record<string, unknown>) || {};
    for (const [role, binding] of Object.entries(bindings)) {
      if (Array.isArray(binding)) {
        // Multi-source: download all and concatenate, keeping only the first header.
        const allData: Buffer[] = [];
        for (let i = 0; i < binding.length; i += 1) {
          const b = binding[i] as Record<string, unknown>;
          const objectKey = String(b.object_key ?? "").trim();
          if (!objectKey) continue;
          let data = await minioService.downloadBytes(objectKey);
          if (i === 0) {
            if (data.length > 0 && data[data.length - 1] !== 0x0a) data = Buffer.concat([data, Buffer.from("\n")]);
            allData.push(data);
          } else {
            const nl = data.indexOf(0x0a);
            if (nl >= 0) {
              let remainder = data.subarray(nl + 1);
              if (remainder.length > 0 && remainder[remainder.length - 1] !== 0x0a) {
                remainder = Buffer.concat([remainder, Buffer.from("\n")]);
              }
              allData.push(remainder);
            } else {
              allData.push(data);
            }
          }
        }
        const combined = Buffer.concat(allData);
        const first = binding[0] as Record<string, unknown>;
        const filename = safeSourceFilename(String(first.original_filename ?? `${role}.csv`));
        const destination = path.join(tmpdir, `${role}-combined-${filename}`);
        await fsp.writeFile(destination, combined);
        localPaths[role] = destination;
      } else {
        const b = (binding || {}) as Record<string, unknown>;
        const objectKey = String(b.object_key ?? "").trim();
        const filename = safeSourceFilename(String(b.original_filename ?? "") || `${role}.bin`);
        if (!objectKey) throw new Error(`Source binding for role '${role}' is missing object_key`);
        const data = await minioService.downloadBytes(objectKey);
        const destination = path.join(tmpdir, `${role}-${filename}`);
        await fsp.writeFile(destination, data);
        localPaths[role] = destination;
      }
    }
    return await fn(localPaths);
  } finally {
    await fsp.rm(tmpdir, { recursive: true, force: true });
  }
}
