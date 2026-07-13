/**
 * Embed-job test harness (W2b batch 4).
 *
 * Embeddings are non-deterministic (model output + halfvec quantization), so this
 * does NOT byte-compare against a Python baseline. Instead it verifies the embed
 * orchestration end-to-end against the live Ollama: insert a pre-claimed `running`
 * embed job, run executeAdminJob, and assert it reaches `success` with the
 * validate→embed→finalize step sequence. On an already-embedded module the
 * incremental loader is a near-instant no-op (0 changed), so the embedded count
 * stays put — the meaningful signal is "job completes + steps correct".
 *
 * Usage (from node-server/):  node scripts/worker_embed_test.mjs <job_type>
 *   e.g. guideline_embed | icd_embed | loinc_embed | snomed_embed | ...
 */

import pg from "pg";
import crypto from "node:crypto";

const JOB_TYPE = process.argv[2];
// job_type → (module_key, embedded-count query) for the before/after delta.
const EMB_COUNT = {
  icd_embed: ["icd", "SELECT count(*)::int n FROM icd.diagnosis_embeddings"],
  loinc_embed: ["loinc", "SELECT count(*)::int n FROM loinc.concept_embeddings"],
  health_supplements_embed: ["health_supplements", "SELECT count(*)::int n FROM health_supplements.item_embeddings"],
  food_nutrition_embed: ["food_nutrition", "SELECT (SELECT count(*) FROM food_nutrition.food_embeddings)+(SELECT count(*) FROM food_nutrition.ingredient_embeddings) n"],
  guideline_embed: ["guideline", "SELECT count(*)::int n FROM guideline.guideline_embeddings"],
  snomed_embed: ["snomed", "SELECT count(*)::int n FROM snomed.concept_embeddings"],
};
if (!JOB_TYPE || !EMB_COUNT[JOB_TYPE]) {
  console.error("usage: node scripts/worker_embed_test.mjs <" + Object.keys(EMB_COUNT).join("|") + ">");
  process.exit(2);
}
const [moduleKey, embQ] = EMB_COUNT[JOB_TYPE];

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const count = async () => Number((await client.query(embQ)).rows[0].n) || 0;

const before = await count();
console.log(`${JOB_TYPE}: embedded before = ${before}`);

const jobId = crypto.randomUUID();
const workerName = `embed-test-${moduleKey}`;
await client.query(
  `INSERT INTO admin.import_jobs
     (job_id, job_type, module_key, requested_by, status, control_state, progress_current, progress_total, created_at, updated_at, claimed_at, started_at)
   VALUES ($1,$2,$3,'embed-test','running','idle',0,0,NOW(),NOW(),NOW(),NOW())`,
  [jobId, JOB_TYPE, moduleKey],
);
console.log("inserted job", jobId);

const { initPool } = await import("../dist/db.js");
initPool();
try {
  const { initClient } = await import("../dist/cache.js");
  await initClient();
} catch (e) {
  console.log("redis init skipped:", e?.message ?? e);
}

const t0 = Date.now();
const { executeAdminJob, getJob } = await import("../dist/admin/adminJobs.js");
const job = await getJob(jobId);
let outcome = "ok";
try {
  await executeAdminJob({ workerName, job });
} catch (e) {
  outcome = `ERROR: ${e?.message ?? e}`;
}
console.log(`handler finished in ${((Date.now() - t0) / 1000).toFixed(1)}s, outcome: ${outcome}`);

const finalJob = await getJob(jobId);
const steps = (
  await client.query("SELECT step_key, status, checkpoint_json FROM admin.import_job_steps WHERE job_id=$1 ORDER BY job_step_id", [jobId])
).rows.map((r) => `${r.step_key}:${r.status}:${r.checkpoint_json?.phase ?? ""}`);
const after = await count();

console.log("\n── RESULT ──");
console.log("status:", finalJob?.status, "step:", finalJob?.current_step, "progress:", finalJob?.progress_current, "/", finalJob?.progress_total);
if (finalJob?.last_error_message) console.log("error:", finalJob.last_error_message);
console.log("steps:", steps.join("  |  "));
console.log(`embedded after = ${after} (delta ${after - before})`);

const ok = finalJob?.status === "success" &&
  JSON.stringify(steps.map((s) => s.split(":")[0])) === JSON.stringify(["validate", "embed", "finalize"]);
console.log("\nVERDICT:", ok ? "PASS (job success + validate→embed→finalize)" : "FAIL");

// Clean up the synthetic job.
await client.query("DELETE FROM admin.import_job_logs WHERE job_id=$1", [jobId]);
await client.query("DELETE FROM admin.import_job_steps WHERE job_id=$1", [jobId]);
await client.query("DELETE FROM admin.import_jobs WHERE job_id=$1", [jobId]);
await client.end();
process.exit(ok ? 0 : 1);
