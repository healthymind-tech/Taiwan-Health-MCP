/**
 * ICD worker-parity harness (W2b).
 *
 * Verifies the Node admin-worker `icd_import` staged-import handler against the
 * live Python baseline job, following the pattern in memory
 * [[project_worker_port_w2]]:
 *   - PY baseline: the most recent successful `icd_import` job (run by the live
 *     Python admin-worker) — we read its job_options + step sequence + the
 *     promoted icd.* table fingerprints.
 *   - ND: insert a pre-claimed `running` icd_import job reusing the SAME
 *     job_options (so the live Python worker ignores it — only claims queued),
 *     then call executeAdminJob directly and diff steps + table fingerprints.
 *
 * Env (DATABASE_URL / REDIS_URL / MINIO_* / ADMIN_SESSION_SECRET) is taken from
 * the caller's environment (export from the live node process /proc/<pid>/environ).
 * Requires the /etc/hosts `minio` bridge for host-side MinIO access.
 *
 * Usage (from node-server/):
 *   node scripts/worker_parity_icd.mjs <baseline-job-id>
 */

import pg from "pg";
import crypto from "node:crypto";

const BASELINE_JOB_ID = process.argv[2];
if (!BASELINE_JOB_ID) {
  console.error("usage: node scripts/worker_parity_icd.mjs <baseline-job-id>");
  process.exit(2);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

/** Stable md5 fingerprint of a table's natural-key-ordered content (excludes serial id). */
async function fingerprint(table) {
  const cols = table.endsWith("diagnoses")
    ? "code, name_en, name_zh, category"
    : "code, name_en, name_zh";
  const res = await client.query(`SELECT ${cols} FROM ${table} ORDER BY code`);
  const h = crypto.createHash("md5");
  for (const row of res.rows) h.update(JSON.stringify(Object.values(row)));
  return { rows: res.rowCount, md5: h.digest("hex") };
}

/** Normalize a step sequence to (step_key, status, checkpoint.phase) for diff. */
async function stepSeq(jobId) {
  const res = await client.query(
    "SELECT step_key, status, checkpoint_json FROM admin.import_job_steps WHERE job_id=$1 ORDER BY job_step_id",
    [jobId],
  );
  return res.rows.map((r) => `${r.step_key}:${r.status}:${r.checkpoint_json?.phase ?? ""}`);
}

// ── 1. Capture baseline (Python-produced) ──────────────────────────────────
const baseJob = (
  await client.query("SELECT job_options_json, module_key, job_type FROM admin.import_jobs WHERE job_id=$1", [BASELINE_JOB_ID])
).rows[0];
if (!baseJob) throw new Error(`baseline job ${BASELINE_JOB_ID} not found`);

const baseSteps = await stepSeq(BASELINE_JOB_ID);
const baseDx = await fingerprint("icd.diagnoses");
const basePx = await fingerprint("icd.procedures");
console.log("── BASELINE (Python) ──");
console.log("steps:", baseSteps.join("  |  "));
console.log("icd.diagnoses :", baseDx);
console.log("icd.procedures:", basePx);

// ── 2. Insert a pre-claimed running Node job (live worker ignores non-queued) ─
const nodeJobId = crypto.randomUUID();
const workerName = "parity-node-icd";
await client.query(
  `INSERT INTO admin.import_jobs
     (job_id, job_type, module_key, requested_by, status, control_state, progress_current, progress_total,
      job_options_json, worker_name, claimed_at, started_at, created_at, updated_at)
   VALUES ($1,$2,$3,'parity-harness','running','idle',0,5,$4,$5,NOW(),NOW(),NOW(),NOW())`,
  [nodeJobId, baseJob.job_type, baseJob.module_key, baseJob.job_options_json, workerName],
);
console.log("\n── NODE job inserted:", nodeJobId, "──");

// ── 3. Run the Node handler directly ───────────────────────────────────────
// The dist runtime modules use their own singleton pool/redis — initialize them
// (config reads DATABASE_URL/REDIS_URL from the env exported by the caller).
const { initPool } = await import("../dist/db.js");
initPool();
try {
  const { initClient } = await import("../dist/cache.js");
  await initClient();
} catch (e) {
  console.log("redis init skipped:", e?.message ?? e);
}

// MinIO must be initialized so withMaterializedSources can download bound sources
// (host-side access goes through the /etc/hosts `minio` → 127.0.0.1 bridge).
const minioService = await import("../dist/minioService.js");
await minioService.initialize();
console.log("minio enabled:", minioService.enabled(), "initError:", minioService.initError());

const t0 = Date.now();
const { executeAdminJob, getJob, logJobOutcome } = await import("../dist/admin/adminJobs.js");
const job = await getJob(nodeJobId);
let outcome = "success";
try {
  await executeAdminJob({ workerName, job });
} catch (e) {
  outcome = `ERROR: ${e?.message ?? e}`;
}
// Mirror the worker loop's terminal bookkeeping (append "Job completed" log).
try {
  await logJobOutcome({ jobId: nodeJobId, workerName });
} catch { /* non-fatal for parity */ }
console.log(`Node handler finished in ${((Date.now() - t0) / 1000).toFixed(1)}s, outcome: ${outcome}`);

// ── 4. Diff ────────────────────────────────────────────────────────────────
const nodeSteps = await stepSeq(nodeJobId);
const nodeDx = await fingerprint("icd.diagnoses");
const nodePx = await fingerprint("icd.procedures");
const finalNodeJob = await getJob(nodeJobId);

console.log("\n── NODE ──");
console.log("status:", finalNodeJob?.status, "progress:", finalNodeJob?.progress_current);
console.log("steps:", nodeSteps.join("  |  "));
console.log("icd.diagnoses :", nodeDx);
console.log("icd.procedures:", nodePx);

const stepsEqual = JSON.stringify(baseSteps) === JSON.stringify(nodeSteps);
const dxEqual = baseDx.md5 === nodeDx.md5 && baseDx.rows === nodeDx.rows;
const pxEqual = basePx.md5 === nodePx.md5 && basePx.rows === nodePx.rows;

console.log("\n── VERDICT ──");
console.log("steps sequence parity :", stepsEqual ? "PASS" : "FAIL");
console.log("icd.diagnoses parity  :", dxEqual ? "PASS" : "FAIL");
console.log("icd.procedures parity :", pxEqual ? "PASS" : "FAIL");
if (!stepsEqual) {
  console.log("  baseline:", baseSteps);
  console.log("  node    :", nodeSteps);
}

await client.end();
process.exit(stepsEqual && dxEqual && pxEqual && finalNodeJob?.status === "success" ? 0 : 1);
