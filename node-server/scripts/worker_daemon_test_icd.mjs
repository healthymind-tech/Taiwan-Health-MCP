/**
 * ICD worker-DAEMON test (W2b).
 *
 * Exercises the real Node admin-worker loop end-to-end (claim → run → heartbeat →
 * terminal bookkeeping), not just a direct executeAdminJob call. To avoid racing
 * the live Python worker (which runs in the `taiwanHealthMcp_admin_worker`
 * container and is owned by another user), this harness:
 *   1. `docker stop`s the Python worker container,
 *   2. spawns `dist/admin/adminWorker.js` on the host,
 *   3. enqueues a real `queued` icd_import job (reusing a baseline job's manifest),
 *   4. polls until the job reaches a terminal status,
 *   5. verifies icd.* fingerprints, then kills the daemon and `docker start`s the
 *      Python worker container again (always, even on failure).
 *
 * Env (DATABASE_URL / REDIS_URL / MINIO_* / ...) comes from the caller's
 * environment (export from the live node server process /proc/<pid>/environ).
 *
 * Usage (from node-server/):  node scripts/worker_daemon_test_icd.mjs <baseline-job-id>
 */

import pg from "pg";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";

const BASELINE_JOB_ID = process.argv[2];
const CONTAINER = "taiwanHealthMcp_admin_worker";
if (!BASELINE_JOB_ID) {
  console.error("usage: node scripts/worker_daemon_test_icd.mjs <baseline-job-id>");
  process.exit(2);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fingerprint(table) {
  const cols = table.endsWith("diagnoses") ? "code, name_en, name_zh, category" : "code, name_en, name_zh";
  const res = await client.query(`SELECT ${cols} FROM ${table} ORDER BY code`);
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
function docker(action) {
  const r = spawnSync("docker", [action, CONTAINER], { encoding: "utf8" });
  console.log(`docker ${action} ${CONTAINER}: ${r.status === 0 ? "ok" : "FAILED"} ${(r.stderr || "").trim()}`);
  return r.status === 0;
}

const baseDx = await fingerprint("icd.diagnoses");
const basePx = await fingerprint("icd.procedures");
console.log("pre-state icd.diagnoses:", baseDx, "icd.procedures:", basePx);

const baseJob = (
  await client.query("SELECT job_options_json, module_key, job_type FROM admin.import_jobs WHERE job_id=$1", [BASELINE_JOB_ID])
).rows[0];
if (!baseJob) throw new Error(`baseline job ${BASELINE_JOB_ID} not found`);

let daemon = null;
let daemonLog = "";
try {
  // 1. Stop the Python worker so only the Node daemon can claim.
  if (!docker("stop")) throw new Error("could not stop Python worker container");

  // 2. Spawn the Node worker daemon on the host.
  console.log("\nspawning Node worker daemon (dist/admin/adminWorker.js) ...");
  daemon = spawn("node", ["dist/admin/adminWorker.js"], { env: process.env, cwd: process.cwd() });
  daemon.stdout.on("data", (d) => { daemonLog += d; });
  daemon.stderr.on("data", (d) => { daemonLog += d; });

  // Wait for the daemon to register a fresh heartbeat (proof of startup).
  let booted = false;
  for (let i = 0; i < 40; i += 1) {
    await sleep(1000);
    const hb = await client.query(
      "SELECT worker_name, last_heartbeat_at FROM admin.worker_heartbeats WHERE last_heartbeat_at > NOW() - INTERVAL '20 seconds' ORDER BY last_heartbeat_at DESC",
    );
    if (hb.rows.length > 0) {
      console.log("daemon heartbeat:", JSON.stringify(hb.rows));
      booted = true;
      break;
    }
    if (daemon.exitCode !== null) throw new Error(`daemon exited early (code ${daemon.exitCode})`);
  }
  if (!booted) throw new Error("daemon never emitted a heartbeat");

  // 3. Enqueue a real queued icd_import job.
  const enqId = crypto.randomUUID();
  await client.query(
    `INSERT INTO admin.import_jobs
       (job_id, job_type, module_key, requested_by, status, control_state,
        progress_current, progress_total, job_options_json, created_at, updated_at)
     VALUES ($1,$2,$3,'daemon-test','queued','idle',0,5,$4,NOW(),NOW())`,
    [enqId, baseJob.job_type, baseJob.module_key, baseJob.job_options_json],
  );
  console.log("\nenqueued queued icd_import job:", enqId);

  // 4. Poll until terminal.
  const TERMINAL = new Set(["success", "partial_success", "retryable_failed", "permanent_failed", "failed", "stopped"]);
  let final = null;
  const t0 = Date.now();
  for (let i = 0; i < 240; i += 1) {
    await sleep(2000);
    const r = await client.query(
      "SELECT status, worker_name, current_step, progress_current, last_error_message FROM admin.import_jobs WHERE job_id=$1",
      [enqId],
    );
    const row = r.rows[0];
    if (i % 5 === 0) console.log(`  [t+${((Date.now() - t0) / 1000).toFixed(0)}s] status=${row.status} step=${row.current_step} progress=${row.progress_current} worker=${row.worker_name ?? "-"}`);
    if (TERMINAL.has(row.status)) { final = row; break; }
    if (daemon.exitCode !== null) throw new Error(`daemon died mid-job (code ${daemon.exitCode})`);
  }
  if (!final) throw new Error("job did not reach a terminal status within the timeout");

  console.log("\n── DAEMON JOB RESULT ──");
  console.log("status:", final.status, "worker:", final.worker_name, "step:", final.current_step);
  if (final.last_error_message) console.log("error:", final.last_error_message);
  const steps = await stepSeq(enqId);
  console.log("steps:", steps.join("  |  "));
  const afterDx = await fingerprint("icd.diagnoses");
  const afterPx = await fingerprint("icd.procedures");
  console.log("post icd.diagnoses:", afterDx, "icd.procedures:", afterPx);

  const ok =
    final.status === "success" &&
    afterDx.md5 === baseDx.md5 && afterDx.rows === baseDx.rows &&
    afterPx.md5 === basePx.md5 && afterPx.rows === basePx.rows;
  console.log("\n── VERDICT ──");
  console.log("daemon claimed + ran icd_import to success :", final.status === "success" ? "PASS" : "FAIL");
  console.log("icd.diagnoses fingerprint unchanged        :", afterDx.md5 === baseDx.md5 ? "PASS" : "FAIL");
  console.log("icd.procedures fingerprint unchanged       :", afterPx.md5 === basePx.md5 ? "PASS" : "FAIL");
  process.exitCode = ok ? 0 : 1;
} catch (e) {
  console.log("\nHARNESS ERROR:", e?.message ?? e);
  process.exitCode = 1;
} finally {
  if (daemon && daemon.exitCode === null) {
    daemon.kill("SIGTERM");
    await sleep(1500);
    if (daemon.exitCode === null) daemon.kill("SIGKILL");
  }
  if (daemonLog) {
    console.log("\n── daemon log (tail) ──");
    console.log(daemonLog.split("\n").slice(-25).join("\n"));
  }
  // Always restore the Python worker container.
  docker("start");
  await client.end();
}
