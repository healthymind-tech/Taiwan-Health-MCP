/**
 * Generic W2b worker-parity harness (supersedes worker_parity_icd.mjs).
 *
 * Verifies a Node admin-worker staged-import handler against a live Python
 * baseline job (pattern: memory [[project_worker_port_w2]]):
 *   - read the baseline job's step sequence + the promoted module-table md5,
 *   - insert a pre-claimed `running` job reusing the SAME job_options (so the
 *     live Python worker — which only claims `queued` — ignores it),
 *   - call executeAdminJob directly, then diff steps + table fingerprints.
 *
 * Env (DATABASE_URL / REDIS_URL / MINIO_* / ...) comes from the caller's
 * environment (export from the live node server process /proc/<pid>/environ).
 * Requires the /etc/hosts `minio` bridge.
 *
 * Usage (from node-server/):
 *   node scripts/worker_parity.mjs <module> <baseline-job-id>
 *   module ∈ { icd, loinc }
 */

import pg from "pg";
import crypto from "node:crypto";

// Per-module fingerprint tables (natural-key ordered; excludes serial id).
const MODULES = {
  icd: [
    { table: "icd.diagnoses", cols: "code, name_en, name_zh, category", order: "code" },
    { table: "icd.procedures", cols: "code, name_en, name_zh", order: "code" },
  ],
  loinc: [
    {
      table: "loinc.concepts",
      cols: "loinc_num, component, property, time_aspect, system, scale_type, method_type, long_common_name, shortname, class, classtype, status, consumer_name, name_zh, common_name_zh, specimen_type, unit",
      order: "loinc_num",
    },
    {
      table: "loinc.reference_ranges",
      cols: "loinc_num, age_min, age_max, gender, range_low, range_high, unit, interpretation",
      order: "loinc_num, age_min, age_max, gender, unit, interpretation",
    },
  ],
  snomed: [
    { table: "snomed.concepts", cols: "concept_id, effective_time, active, module_id, definition_status_id", order: "concept_id" },
    { table: "snomed.descriptions", cols: "description_id, concept_id, type_id, term, active, language_code, us_preferred", order: "description_id" },
    { table: "snomed.relationships", cols: "relationship_id, source_id, destination_id, type_id, active, characteristic_type_id", order: "relationship_id" },
    { table: "snomed.icd10_map", cols: "referenced_component_id, map_target, map_rule, map_advice, map_priority, map_group, active", order: "referenced_component_id, map_target, map_priority, map_group" },
    { table: "snomed.historical_associations", cols: "referenced_component_id, target_component_id, refset_id", order: "referenced_component_id, target_component_id, refset_id" },
  ],
};

const MODULE = process.argv[2];
const BASELINE_JOB_ID = process.argv[3];
if (!MODULE || !BASELINE_JOB_ID || !MODULES[MODULE]) {
  console.error("usage: node scripts/worker_parity.mjs <icd|loinc> <baseline-job-id>");
  process.exit(2);
}
const TABLES = MODULES[MODULE];

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

async function fingerprint(spec) {
  const res = await client.query(`SELECT ${spec.cols} FROM ${spec.table} ORDER BY ${spec.order}`);
  const h = crypto.createHash("md5");
  for (const row of res.rows) h.update(JSON.stringify(Object.values(row)));
  return { rows: res.rowCount, md5: h.digest("hex") };
}
async function stepSeq(jobId) {
  const res = await client.query(
    "SELECT step_key, status, checkpoint_json FROM admin.import_job_steps WHERE job_id=$1 ORDER BY job_step_id",
    [jobId],
  );
  return res.rows.map((r) => `${r.step_key}:${r.status}:${r.checkpoint_json?.phase ?? ""}`);
}
async function fingerprintAll() {
  const out = {};
  for (const spec of TABLES) out[spec.table] = await fingerprint(spec);
  return out;
}

const baseJob = (
  await client.query("SELECT job_options_json, module_key, job_type FROM admin.import_jobs WHERE job_id=$1", [BASELINE_JOB_ID])
).rows[0];
if (!baseJob) throw new Error(`baseline job ${BASELINE_JOB_ID} not found`);

const baseSteps = await stepSeq(BASELINE_JOB_ID);
const baseFp = await fingerprintAll();
console.log("── BASELINE (Python) ──");
console.log("steps:", baseSteps.join("  |  "));
for (const [t, fp] of Object.entries(baseFp)) console.log(t, fp);

const nodeJobId = crypto.randomUUID();
const workerName = `parity-node-${MODULE}`;
await client.query(
  `INSERT INTO admin.import_jobs
     (job_id, job_type, module_key, requested_by, status, control_state, progress_current, progress_total,
      job_options_json, worker_name, claimed_at, started_at, created_at, updated_at)
   VALUES ($1,$2,$3,'parity-harness','running','idle',0,5,$4,$5,NOW(),NOW(),NOW(),NOW())`,
  [nodeJobId, baseJob.job_type, baseJob.module_key, baseJob.job_options_json, workerName],
);
console.log("\n── NODE job inserted:", nodeJobId, "──");

const { initPool } = await import("../dist/db.js");
initPool();
try {
  const { initClient } = await import("../dist/cache.js");
  await initClient();
} catch (e) {
  console.log("redis init skipped:", e?.message ?? e);
}
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
try {
  await logJobOutcome({ jobId: nodeJobId, workerName });
} catch { /* non-fatal */ }
console.log(`Node handler finished in ${((Date.now() - t0) / 1000).toFixed(1)}s, outcome: ${outcome}`);

const nodeSteps = await stepSeq(nodeJobId);
const nodeFp = await fingerprintAll();
const finalNodeJob = await getJob(nodeJobId);

console.log("\n── NODE ──");
console.log("status:", finalNodeJob?.status, "progress:", finalNodeJob?.progress_current);
console.log("steps:", nodeSteps.join("  |  "));
for (const [t, fp] of Object.entries(nodeFp)) console.log(t, fp);

const stepsEqual = JSON.stringify(baseSteps) === JSON.stringify(nodeSteps);
let tablesEqual = true;
console.log("\n── VERDICT ──");
console.log("steps sequence parity :", stepsEqual ? "PASS" : "FAIL");
for (const spec of TABLES) {
  const ok = baseFp[spec.table].md5 === nodeFp[spec.table].md5 && baseFp[spec.table].rows === nodeFp[spec.table].rows;
  tablesEqual = tablesEqual && ok;
  console.log(`${spec.table} parity :`, ok ? "PASS" : "FAIL");
}
if (!stepsEqual) {
  console.log("  baseline:", baseSteps);
  console.log("  node    :", nodeSteps);
}

await client.end();
process.exit(stepsEqual && tablesEqual && finalNodeJob?.status === "success" ? 0 : 1);
