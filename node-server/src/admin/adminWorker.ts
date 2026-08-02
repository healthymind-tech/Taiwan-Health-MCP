/**
 * Admin worker — resource-aware parallel job executor (W2a).
 *
 * Faithful port of `src/admin_worker.py`. The daemon claims queued jobs from
 * `admin.import_jobs`, runs them with a per-job heartbeat, honours
 * checkpoint-based pause/cancel via `admin.job_control_requests`, reclaims jobs
 * abandoned by dead workers, prunes job logs, fires due schedules, and refreshes
 * near-expiry OAuth2 tokens. Concurrency is bounded both per-resource (at most
 * one job per `db_write_<module>` / `ollama_embed` / `llm` slot) and globally by
 * `ADMIN_MAX_CONCURRENT_JOBS`.
 *
 * W2a wires the control plane + the `noop` smoke job end-to-end. The data-plane
 * loader handlers (`execute_admin_job`'s `_run_*_import_job` bodies) land in W2b;
 * until then `executeAdminJob` throws `W2bNotImplementedError` for loader types,
 * which the per-job runner turns into a `retryable_failed` outcome.
 */

import { config } from "../config.js";
import { configureLogLevel, logError, logInfo, logWarning } from "../logger.js";
import * as database from "../db.js";
import { initPool, getPool, closePool, query, withTransaction } from "../db.js";
import { monitor as dbHealthMonitor, isDbDownError } from "../dbHealth.js";
import { initClient } from "../cache.js";
import * as minioService from "../minioService.js";
import { initBroadcast } from "./adminWs.js";
import { getGroup, seedIfEmpty } from "./adminSettings.js";
import { ensureLlmCallLogSchema } from "./llmCallLog.js";
import { listDueSchedules, fireSchedule, type DueSchedule } from "./adminSchedule.js";
import { sweepExpiringTokens } from "./fhirOauthService.js";
import { fhirServerSecretKey } from "./adminFhirServers.js";
import {
  JOB_TYPE_RESOURCES,
  getExcludedJobTypes,
  adminWorkerName,
  adminHeartbeatIntervalSeconds,
  upsertWorkerHeartbeat,
  reclaimStaleJobs,
  claimNextJob,
  executeAdminJob,
  logJobOutcome,
  markJobStatus,
  appendJobLog,
  pruneJobLogs,
  setDefaultLogVerbose,
} from "./adminJobs.js";

const sleep = (seconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, Math.max(seconds, 0) * 1000));

/** Monotonic-ish clock in seconds, matching how the Python loop schedules timers. */
const loopTime = (): number => Date.now() / 1000;

// Backoff between iterations while the database is unavailable (Python: 3.0s).
const DB_DOWN_BACKOFF_SECONDS = 3.0;
// How often to proactively refresh near-expiry OAuth2 Authorization Code tokens.
const OAUTH_SWEEP_INTERVAL_SECONDS = 1800.0; // 30 minutes
// How often to scan for due schedules.
const SCHEDULE_SCAN_INTERVAL = Number.parseFloat(
  process.env.ADMIN_SCHEDULE_SCAN_INTERVAL_SECONDS ?? "60",
);

interface RunningJob {
  job: Record<string, unknown>;
  resources: Set<string>;
  promise: Promise<void>;
  done: boolean;
  error: unknown;
  hbTimer: NodeJS.Timeout | null;
}

/** Mirror `_is_db_outage`: flip the health gate on a real DB outage, else false. */
function isDbOutage(exc: unknown): boolean {
  if (isDbDownError(exc)) {
    dbHealthMonitor().reportFailure(exc);
    return true;
  }
  return false;
}

/** Faithful port of `_requeue_if_orphaned`. */
async function requeueIfOrphaned(jobId: string, workerName: string): Promise<void> {
  const res = await query<{ job_id: string; job_type: string }>(
    `UPDATE admin.import_jobs
        SET status = 'queued', control_state = 'resume_requested',
            current_step = 'reclaimed_after_interruption', updated_at = NOW()
      WHERE job_id = $1::uuid AND worker_name = $2 AND status = 'running'
      RETURNING job_id, job_type`,
    [jobId, workerName],
  );
  if (res.rows.length > 0) {
    logWarning("Requeued interrupted job to resume from checkpoint", {
      worker_name: workerName,
      job_id: jobId,
      job_type: res.rows[0].job_type,
    });
    await appendJobLog({
      jobId,
      level: "warn",
      message: "Job interrupted (likely DB outage) — requeued to resume from checkpoint",
      payload: { worker_name: workerName },
    });
  }
}

/** Faithful port of `_run_job_with_heartbeat` (per-job execution + heartbeat). */
async function runJobWithHeartbeat(opts: {
  workerName: string;
  processId: number;
  job: Record<string, unknown>;
  heartbeatInterval: number;
  setTimer: (t: NodeJS.Timeout | null) => void;
}): Promise<void> {
  const { workerName, processId, job, heartbeatInterval, setTimer } = opts;
  const jobId = String(job.job_id);
  const jobType = String(job.job_type);
  const jobDetails = {
    mode: "job",
    job_type: jobType,
    module_key: String(job.module_key ?? ""),
    minio_enabled: minioService.enabled(),
  };

  await upsertWorkerHeartbeat({
    workerName,
    processId,
    status: "running",
    currentJobId: jobId,
    details: jobDetails,
  });

  // Background heartbeat — keeps the worker "Fresh" during long jobs.
  const hbTimer = setInterval(() => {
    void upsertWorkerHeartbeat({
      workerName,
      processId,
      status: "running",
      currentJobId: jobId,
      details: jobDetails,
    }).catch(() => {
      /* non-fatal */
    });
  }, heartbeatInterval * 1000);
  setTimer(hbTimer);

  try {
    await executeAdminJob({ workerName, job });
    try {
      await logJobOutcome({ jobId, workerName });
    } catch {
      /* non-fatal */
    }
  } catch (exc) {
    if (isDbDownError(exc)) {
      // Database outage mid-job — not a job error. Leave it 'running'; its
      // heartbeat goes stale and reclaim_stale_jobs re-queues it to resume.
      dbHealthMonitor().reportFailure(exc);
      logWarning("Job interrupted by database outage — will resume after recovery", {
        worker_name: workerName,
        job_id: jobId,
        error: String((exc as Error).message),
      });
    } else {
      logError("Job execution raised unhandled exception", {
        worker_name: workerName,
        job_id: jobId,
        error: String((exc as Error).message),
      });
      try {
        await markJobStatus({
          jobId,
          status: "retryable_failed",
          currentStep: "worker_exception",
          controlState: "idle",
          lastErrorCode: "worker_exception",
          lastErrorMessage: String((exc as Error).message),
        });
        await appendJobLog({
          jobId,
          level: "error",
          message: "Worker execution failed",
          payload: { worker_name: workerName, error: String((exc as Error).message) },
        });
      } catch {
        /* non-fatal */
      }
    }
  } finally {
    clearInterval(hbTimer);
    setTimer(null);
    try {
      await upsertWorkerHeartbeat({
        workerName,
        processId,
        status: "running",
        details: { mode: "finishing", job_type: jobType, minio_enabled: minioService.enabled() },
      });
    } catch {
      /* non-fatal */
    }
  }
}

/** Faithful port of `_scan_and_fire_schedules`. */
async function scanAndFireSchedules(workerName: string): Promise<void> {
  const due = await listDueSchedules();
  if (due.length === 0) return;

  logInfo("Schedule scan: found due schedules", {
    worker_name: workerName,
    count: due.length,
    module_keys: due.map((s) => s.module_key),
  });

  for (const sched of due) {
    // Guard: skip if the previous run's job is still active.
    if (sched.last_run_job_id) {
      const prev = await query<{ status: string }>(
        `SELECT status FROM admin.import_jobs WHERE job_id = $1`,
        [sched.last_run_job_id],
      );
      const prevStatus = prev.rows[0]?.status;
      if (prevStatus && ["queued", "running", "paused"].includes(prevStatus)) {
        logInfo("Schedule skip: previous job still active", {
          worker_name: workerName,
          module_key: sched.module_key,
          prev_job_id: sched.last_run_job_id,
          prev_status: prevStatus,
        });
        continue;
      }
    }

    const result = await fireSchedule({ schedule: sched as DueSchedule, triggeredBy: "scheduler" });
    logInfo("Schedule fired", {
      worker_name: workerName,
      module_key: sched.module_key,
      status: result.status,
      job_id: result.job_id,
      error: result.error,
    });
  }
}

/** Faithful port of `_run_loop`. */
export async function runWorker(): Promise<void> {
  const cfg = config();
  configureLogLevel(cfg.logLevel);
  let workerName = adminWorkerName();
  const processId = process.pid;

  if (cfg.redisUrl) initBroadcast(cfg.redisUrl);

  try {
    initPool();
  } catch (err) {
    logError("Worker pool init failed", { error: String((err as Error).message) });
  }
  // This worker is a separate process from the server, so it runs its own DB
  // health monitor. It gates the loop while the DB is down and recycles the pool
  // on recovery — keeping the worker alive instead of crash-looping.
  dbHealthMonitor().start();

  try {
    await initClient();
  } catch (err) {
    logWarning("Worker Redis init failed — continuing", { error: String((err as Error).message) });
  }

  // Seed admin.app_settings from env/defaults on first boot (mirrors Python
  // admin_worker.seed_if_empty). Idempotent + fail-open; whichever of app/worker
  // boots first populates the table, so the worker's getGroup reads real values.
  try {
    await seedIfEmpty();
  } catch (err) {
    logWarning("Worker settings seed skipped", { error: String((err as Error).message) });
  }

  // `admin.llm_call_log` (per-call prompt → reply audit). The worker writes it
  // while running analysis jobs, so ensure it exists here too (idempotent).
  try {
    await ensureLlmCallLogSchema();
  } catch (err) {
    logWarning("Worker LLM call log schema skipped", { error: String((err as Error).message) });
  }

  const workerCfg = await getGroup("worker").catch(() => ({}) as Record<string, unknown>);
  const num = (v: unknown, d: number): number => {
    const n = Number(v);
    return Number.isFinite(n) && n ? n : d;
  };
  workerName = String((workerCfg as Record<string, unknown>).name || workerName);
  const heartbeatInterval = num((workerCfg as Record<string, unknown>).heartbeat_interval, 15);
  const pollInterval = num((workerCfg as Record<string, unknown>).poll_seconds, 3);
  const reclaimInterval = num((workerCfg as Record<string, unknown>).reclaim_interval, 60);
  const logRetentionDays = Math.trunc(num((workerCfg as Record<string, unknown>).log_retention_days, 30));
  const logMaxLinesPerJob = Math.trunc(num((workerCfg as Record<string, unknown>).log_max_lines_per_job, 2000));
  const logPruneInterval = num((workerCfg as Record<string, unknown>).log_prune_interval, 3600);
  setDefaultLogVerbose(
    ["1", "true", "yes", "on"].includes(
      String((workerCfg as Record<string, unknown>).log_verbose ?? "").toLowerCase(),
    ),
  );

  let maxConcurrentJobs = 4;
  {
    const raw = process.env.ADMIN_MAX_CONCURRENT_JOBS;
    if (raw !== undefined && raw !== "") {
      const parsed = Number.parseInt(raw, 10);
      maxConcurrentJobs = Number.isNaN(parsed) ? 4 : parsed;
    }
    if (maxConcurrentJobs < 0) maxConcurrentJobs = 0;
  }

  try {
    await minioService.initialize();
  } catch (err) {
    logWarning("Worker MinIO init failed — continuing", { error: String((err as Error).message) });
  }

  // On startup, reclaim any jobs left 'running' under this worker name — orphans
  // from a previous process that died without a clean shutdown.
  try {
    const orphaned = await query<{ job_id: string; job_type: string }>(
      `UPDATE admin.import_jobs
          SET status = 'queued', control_state = 'resume_requested',
              current_step = 'reclaimed_on_startup', updated_at = NOW()
        WHERE status = 'running' AND worker_name = $1
        RETURNING job_id, job_type`,
      [workerName],
    );
    for (const row of orphaned.rows) {
      await query(
        `INSERT INTO admin.import_job_logs (job_id, level, message, payload_json)
         VALUES ($1, 'warn', 'Job reclaimed on worker startup', $2::jsonb)`,
        [row.job_id, JSON.stringify({ worker_name: workerName, job_type: row.job_type })],
      );
    }
    if (orphaned.rows.length > 0) {
      logWarning("Reclaimed orphaned jobs on startup", {
        worker_name: workerName,
        count: orphaned.rows.length,
        job_ids: orphaned.rows.map((r) => String(r.job_id)),
      });
    }
  } catch (err) {
    logWarning("Startup orphan reclaim failed (non-fatal)", { error: String((err as Error).message) });
  }

  logInfo("Admin worker started (resource-aware parallel mode)", {
    worker_name: workerName,
    process_id: processId,
    poll_interval: pollInterval,
    heartbeat_interval: heartbeatInterval,
    resources: [...JOB_TYPE_RESOURCES.keys()].sort(),
  });

  const running = new Map<string, RunningJob>();
  let activeResources = new Set<string>();
  let nextIdleHeartbeat = 0;
  let nextReclaim = 0;
  let nextLogPrune = 0;
  let nextOauthSweep = 0;
  let nextScheduleScan = 0;

  let shuttingDown = false;
  const onSignal = (sig: string) => {
    logWarning(`Received ${sig}, shutting down`, { worker_name: workerName });
    shuttingDown = true;
  };
  process.on("SIGTERM", () => onSignal("SIGTERM"));
  process.on("SIGINT", () => onSignal("SIGINT"));

  try {
    while (!shuttingDown) {
      // ── 0. DB health gate ───────────────────────────────────────────────
      if (!dbHealthMonitor().isHealthy()) {
        await sleep(DB_DOWN_BACKOFF_SECONDS);
        continue;
      }
      const t = loopTime();

      // ── 1. Reap completed tasks ─────────────────────────────────────────
      const doneIds = [...running.entries()].filter(([, rj]) => rj.done).map(([id]) => id);
      for (const jid of doneIds) {
        const rj = running.get(jid)!;
        running.delete(jid);
        activeResources = new Set([...activeResources].filter((r) => !rj.resources.has(r)));
        if (rj.error) {
          logError("Job task raised unhandled exception", {
            worker_name: workerName,
            job_id: jid,
            error: String((rj.error as Error).message ?? rj.error),
          });
        }
        try {
          await requeueIfOrphaned(jid, workerName);
        } catch (rcErr) {
          logWarning("Reap reconcile failed (stale-reclaim will retry)", {
            worker_name: workerName,
            job_id: jid,
            error: String((rcErr as Error).message),
          });
        }
      }
      if (doneIds.length > 0) {
        logInfo("Reaped completed jobs", {
          worker_name: workerName,
          reaped: doneIds,
          active_resources: [...activeResources].sort(),
          running_count: running.size,
        });
      }

      // ── 2. Idle heartbeat (only when no jobs are running) ───────────────
      if (running.size === 0 && t >= nextIdleHeartbeat) {
        try {
          await upsertWorkerHeartbeat({
            workerName,
            processId,
            status: "idle",
            details: { mode: "polling", minio_enabled: minioService.enabled() },
          });
        } catch (exc) {
          if (isDbOutage(exc)) {
            logWarning("Worker paused — database unavailable", {
              worker_name: workerName,
              error: String((exc as Error).message),
            });
            await sleep(DB_DOWN_BACKOFF_SECONDS);
            continue;
          }
          logError("Idle heartbeat failed (non-fatal)", {
            worker_name: workerName,
            error: String((exc as Error).message),
          });
        }
        nextIdleHeartbeat = t + heartbeatInterval;
      }

      // ── 3. Reclaim stale jobs from dead workers ─────────────────────────
      if (t >= nextReclaim) {
        try {
          const reclaimed = await reclaimStaleJobs({ workerName });
          if (reclaimed) logInfo("Reclaimed stale jobs", { worker_name: workerName, count: reclaimed });
        } catch (exc) {
          if (isDbOutage(exc)) {
            await sleep(DB_DOWN_BACKOFF_SECONDS);
            continue;
          }
          throw exc;
        }
        nextReclaim = t + reclaimInterval;
      }

      // ── 3a. Proactive OAuth token renewal ───────────────────────────────
      if (t >= nextOauthSweep) {
        try {
          const refreshed = await sweepExpiringTokens(fhirServerSecretKey(cfg.adminSessionSecret));
          if (refreshed) logInfo("Refreshed expiring OAuth tokens", { worker_name: workerName, refreshed });
        } catch (exc) {
          if (isDbOutage(exc)) {
            await sleep(DB_DOWN_BACKOFF_SECONDS);
            continue;
          }
          logWarning("OAuth token sweep failed (non-fatal)", {
            worker_name: workerName,
            error: String((exc as Error).message),
          });
        }
        nextOauthSweep = t + OAUTH_SWEEP_INTERVAL_SECONDS;
      }

      // ── 3b. Prune old job logs ──────────────────────────────────────────
      if (t >= nextLogPrune) {
        try {
          const pruned = await pruneJobLogs({
            retentionDays: logRetentionDays,
            maxLinesPerJob: logMaxLinesPerJob,
          });
          if (pruned) logInfo("Pruned old job logs", { worker_name: workerName, deleted: pruned });
        } catch (exc) {
          if (isDbOutage(exc)) {
            await sleep(DB_DOWN_BACKOFF_SECONDS);
            continue;
          }
          logWarning("Job log prune failed (non-fatal)", { error: String((exc as Error).message) });
        }
        nextLogPrune = t + logPruneInterval;
      }

      // ── 4. Scan for due schedules and fire them ─────────────────────────
      if (t >= nextScheduleScan) {
        try {
          await scanAndFireSchedules(workerName);
        } catch (schErr) {
          logError("Schedule scan failed", {
            worker_name: workerName,
            error: String((schErr as Error).message),
          });
        }
        nextScheduleScan = t + SCHEDULE_SCAN_INTERVAL;
      }

      // ── 5. Try to claim an eligible job ─────────────────────────────────
      if (maxConcurrentJobs && running.size >= maxConcurrentJobs) {
        await sleep(pollInterval);
        continue;
      }
      const excluded = getExcludedJobTypes(activeResources);
      let job: Record<string, unknown> | null;
      try {
        job = await claimNextJob({ workerName, excludedJobTypes: excluded });
      } catch (exc) {
        if (isDbOutage(exc)) {
          await sleep(DB_DOWN_BACKOFF_SECONDS);
          continue;
        }
        throw exc;
      }

      if (job === null) {
        await sleep(pollInterval);
        continue;
      }

      // ── 5b. Launch the job as a concurrent task ─────────────────────────
      const jobId = String(job.job_id);
      const jobType = String(job.job_type);
      const jobResources = new Set(JOB_TYPE_RESOURCES.get(jobType) ?? []);
      activeResources = new Set([...activeResources, ...jobResources]);

      const rj: RunningJob = {
        job,
        resources: jobResources,
        done: false,
        error: null,
        hbTimer: null,
        promise: Promise.resolve(),
      };
      rj.promise = runJobWithHeartbeat({
        workerName,
        processId,
        job,
        heartbeatInterval,
        setTimer: (timer) => {
          rj.hbTimer = timer;
        },
      })
        .catch((err) => {
          rj.error = err;
        })
        .finally(() => {
          rj.done = true;
        });
      running.set(jobId, rj);

      logInfo("Job started", {
        worker_name: workerName,
        job_id: jobId,
        job_type: jobType,
        resources: [...jobResources].sort(),
        active_resources: [...activeResources].sort(),
        running_count: running.size,
      });
      nextIdleHeartbeat = t + heartbeatInterval;
      // Don't sleep — loop back immediately to try claiming another eligible job.
    }
  } finally {
    if (running.size > 0) {
      logWarning("Worker shutting down with active jobs — waiting", {
        worker_name: workerName,
        job_ids: [...running.keys()],
      });
      for (const rj of running.values()) if (rj.hbTimer) clearInterval(rj.hbTimer);
      await Promise.allSettled([...running.values()].map((rj) => rj.promise));
    }
    dbHealthMonitor().stop();
    await closePool().catch(() => {
      /* best effort */
    });
  }
}

// Entry point — run when executed directly (compose `admin-worker` service).
const invokedPath = process.argv[1] ?? "";
if (invokedPath.endsWith("adminWorker.js") || invokedPath.endsWith("adminWorker.ts")) {
  runWorker().catch((err) => {
    logError("Fatal worker error", { error: String((err as Error).message) });
    process.exit(1);
  });
}

// Keep the namespace/handle imports referenced for parity with the Python
// worker (`database.pool_handle()` / `close_pool()`); used by W2b loaders.
void database;
void getPool;
void withTransaction;
void adminHeartbeatIntervalSeconds;
