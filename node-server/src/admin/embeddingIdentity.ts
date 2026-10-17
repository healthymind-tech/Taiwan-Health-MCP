/**
 * The system's embedding identity ("fingerprint").
 *
 * Every vector in every *_embeddings table must come from the same model, or
 * semantic search silently compares apples with oranges. Model *names* cannot
 * decide that (the same weights are "qwen3-embedding:0.6b-q8_0" on Ollama and
 * "Qwen/Qwen3-Embedding-0.6B" on SiliconFlow), so the identity is behavioural:
 * a fixed set of probe texts is embedded once by the model the system uses and
 * the vectors are stored. Any other endpoint must reproduce them — per-probe
 * cosine ≥ MIN_SIMILARITY — before it may join an embedding profile.
 *
 * Calibrated on real endpoints (2026-10): the same model on two providers
 * (Ollama q8_0 vs SiliconFlow fp16) scored ≥ 0.9993 on every probe; a different
 * model with the same dimensions (Qwen3-Embedding-4B@1024) scored ≈ 0.00.
 *
 * Switching models when vectors already exist means re-indexing everything;
 * `switchEmbeddingModel` does it in a safe order: shut the embedding role off,
 * stop embed jobs, wipe vectors, adopt the new identity, re-queue every module.
 */

import { query, withTransaction } from "../db.js";
import { logInfo, logWarning } from "../logger.js";
import { getAdapter } from "../providers/registry.js";
import { createJob, requestJobControl } from "./adminJobs.js";
import { embeddingDimensions, ProfileValidationError, type LlmProfile } from "./llmProfiles.js";

/** Per-probe cosine an endpoint must reach to count as the same model. */
export const MIN_SIMILARITY = 0.95;

export const PROBE_TEXTS = [
  "第二型糖尿病伴有腎臟併發症",
  "Type 2 diabetes mellitus with kidney complications",
  "Hemoglobin A1c in blood by HPLC",
  "急性心肌梗塞",
  "Amoxicillin 500 mg oral capsule",
  "高血壓性心臟病",
];

/** Every vector table, and the job that rebuilds it. */
export const EMBEDDING_TABLES: { table: string; module: string; jobType: string; label: string }[] = [
  { table: "icd.diagnosis_embeddings", module: "icd", jobType: "icd_embed", label: "ICD-10" },
  { table: "loinc.concept_embeddings", module: "loinc", jobType: "loinc_embed", label: "LOINC" },
  { table: "snomed.concept_embeddings", module: "snomed", jobType: "snomed_embed", label: "SNOMED CT" },
  { table: "health_supplements.item_embeddings", module: "health_supplements", jobType: "health_supplements_embed", label: "健康食品" },
  { table: "food_nutrition.food_embeddings", module: "food_nutrition", jobType: "food_nutrition_embed", label: "食品營養（食品）" },
  { table: "food_nutrition.ingredient_embeddings", module: "food_nutrition", jobType: "food_nutrition_embed", label: "食品營養（成分）" },
];

export interface EmbeddingIdentity {
  version: number;
  state: "active" | "switching";
  model: string;
  provider: string;
  account_name: string;
  dimensions: number;
  probe_vectors: number[][];
  created_at: string;
  created_by: string;
}

let ensured = false;
async function ensureSchema(): Promise<void> {
  if (ensured) return;
  await query(`CREATE TABLE IF NOT EXISTS admin.embedding_identity (
    id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    version INTEGER NOT NULL DEFAULT 1,
    state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'switching')),
    model TEXT NOT NULL,
    provider TEXT NOT NULL,
    account_name TEXT NOT NULL DEFAULT '',
    dimensions INTEGER NOT NULL,
    probe_texts JSONB NOT NULL,
    probe_vectors JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by TEXT NOT NULL DEFAULT ''
  )`);
  await query(`CREATE TABLE IF NOT EXISTS admin.embedding_fingerprints (
    account_id BIGINT NOT NULL REFERENCES admin.llm_providers (id) ON DELETE CASCADE,
    model TEXT NOT NULL,
    dimensions INTEGER NOT NULL,
    identity_version INTEGER NOT NULL,
    ok BOOLEAN NOT NULL,
    min_similarity DOUBLE PRECISION,
    mean_similarity DOUBLE PRECISION,
    message TEXT NOT NULL DEFAULT '',
    checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (account_id, model, dimensions)
  )`);
  ensured = true;
}

export async function getIdentity(): Promise<EmbeddingIdentity | null> {
  await ensureSchema();
  const r = await query<Omit<EmbeddingIdentity, "created_at"> & { created_at: unknown }>(
    "SELECT version, state, model, provider, account_name, dimensions, probe_vectors, created_at, created_by FROM admin.embedding_identity WHERE id = 1",
  );
  const row = r.rows[0];
  if (!row) return null;
  const at = row.created_at;
  return { ...row, created_at: at instanceof Date ? at.toISOString() : String(at) };
}

/** Vector counts per table (exact; the tables are indexed on their keys). */
export async function vectorCounts(): Promise<{ table: string; label: string; module: string; count: number }[]> {
  const out = [];
  for (const t of EMBEDDING_TABLES) {
    const r = await query<{ n: string }>(`SELECT count(*) AS n FROM ${t.table}`).catch(() => ({ rows: [{ n: "0" }] }));
    out.push({ table: t.table, label: t.label, module: t.module, count: Number(r.rows[0]?.n ?? 0) });
  }
  return out;
}

export async function systemHasEmbeddings(): Promise<boolean> {
  for (const t of EMBEDDING_TABLES) {
    const r = await query<{ x: boolean }>(`SELECT EXISTS (SELECT 1 FROM ${t.table}) AS x`).catch(() => ({ rows: [{ x: false }] }));
    if (r.rows[0]?.x) return true;
  }
  return false;
}

/** Per-probe cosine of a candidate's vectors against the identity's. Pure. */
export function compareFingerprint(candidate: number[][], anchor: number[][]): { ok: boolean; min: number; max: number; mean: number } {
  // An empty probe set proves nothing: never let it validate a candidate.
  if (candidate.length === 0 || anchor.length === 0) return { ok: false, min: 0, max: 0, mean: 0 };
  const sims = candidate.map((v, i) => cosine(v, anchor[i] ?? []));
  const min = Math.min(...sims);
  return { ok: sims.length === anchor.length && min >= MIN_SIMILARITY, min, max: Math.max(...sims), mean: sims.reduce((s, x) => s + x, 0) / sims.length };
}

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Embed the probe texts through a leaf (account + model + knobs). */
async function embedProbes(leaf: LlmProfile): Promise<number[][]> {
  const adapter = getAdapter(leaf.provider, leaf.base_url);
  if (!adapter?.embed) throw new ProfileValidationError(`${leaf.provider} does not offer embeddings.`);
  const vecs = await adapter.embed(
    leaf,
    { texts: PROBE_TEXTS, inputType: "document", dimensions: embeddingDimensions(leaf) },
    { fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(90_000) }) },
  );
  if (vecs.length !== PROBE_TEXTS.length || vecs.some((v) => !v || v.length === 0)) {
    throw new ProfileValidationError("The endpoint did not return a vector for every probe text.");
  }
  return vecs as number[][];
}

export interface FingerprintResult {
  ok: boolean;
  /** No identity yet: this candidate would become it. */
  anchor_missing: boolean;
  min_similarity: number | null;
  mean_similarity: number | null;
  dimensions: number | null;
  message: string;
}

/**
 * Does this endpoint produce the system's vectors? Cached per (account, model,
 * dims, identity version) — a fresh identity invalidates every earlier verdict.
 */
export async function checkFingerprint(leaf: LlmProfile, opts: { fresh?: boolean } = {}): Promise<FingerprintResult> {
  await ensureSchema();
  const identity = await getIdentity();
  const dims = embeddingDimensions(leaf);
  if (!identity) {
    return { ok: true, anchor_missing: true, min_similarity: null, mean_similarity: null, dimensions: dims, message: "No embedding identity yet; this model would become the system's." };
  }
  if (dims !== identity.dimensions) {
    return {
      ok: false,
      anchor_missing: false,
      min_similarity: null,
      mean_similarity: null,
      dimensions: dims,
      message: `Configured dimensions ${dims} differ from the system's ${identity.dimensions}.`,
    };
  }
  if (!opts.fresh && leaf.account_id) {
    const cached = await query<{ ok: boolean; min_similarity: number | null; mean_similarity: number | null; message: string }>(
      "SELECT ok, min_similarity, mean_similarity, message FROM admin.embedding_fingerprints WHERE account_id = $1 AND model = $2 AND dimensions = $3 AND identity_version = $4",
      [leaf.account_id, leaf.model, dims, identity.version],
    );
    if (cached.rows[0]) return { ...cached.rows[0], anchor_missing: false, dimensions: dims };
  }
  const vecs = await embedProbes(leaf);
  if (vecs[0].length !== identity.dimensions) {
    return {
      ok: false,
      anchor_missing: false,
      min_similarity: null,
      mean_similarity: null,
      dimensions: vecs[0].length,
      message: `The endpoint returned ${vecs[0].length}-dimension vectors; the system uses ${identity.dimensions}.`,
    };
  }
  const { ok, min, max, mean } = compareFingerprint(vecs, identity.probe_vectors);
  const message = ok
    ? `Same model as the system (similarity ${min.toFixed(4)}–${max.toFixed(4)}).`
    : `Different model: similarity to the system's vectors is ${min.toFixed(3)} (needs ≥ ${MIN_SIMILARITY}).`;
  if (leaf.account_id) {
    await query(
      `INSERT INTO admin.embedding_fingerprints (account_id, model, dimensions, identity_version, ok, min_similarity, mean_similarity, message, checked_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
       ON CONFLICT (account_id, model, dimensions) DO UPDATE SET identity_version = EXCLUDED.identity_version, ok = EXCLUDED.ok,
         min_similarity = EXCLUDED.min_similarity, mean_similarity = EXCLUDED.mean_similarity, message = EXCLUDED.message, checked_at = NOW()`,
      [leaf.account_id, leaf.model, dims, identity.version, ok, min, mean, message],
    );
  }
  return { ok, anchor_missing: false, min_similarity: min, mean_similarity: mean, dimensions: dims, message };
}

type Queryable = { query: (sql: string, params?: unknown[]) => Promise<unknown> };

const UPSERT_IDENTITY_SQL = `INSERT INTO admin.embedding_identity (id, version, state, model, provider, account_name, dimensions, probe_texts, probe_vectors, created_at, created_by)
     VALUES (1, 1, $1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, NOW(), $8)
     ON CONFLICT (id) DO UPDATE SET version = admin.embedding_identity.version + 1, state = EXCLUDED.state, model = EXCLUDED.model,
       provider = EXCLUDED.provider, account_name = EXCLUDED.account_name, dimensions = EXCLUDED.dimensions,
       probe_texts = EXCLUDED.probe_texts, probe_vectors = EXCLUDED.probe_vectors, created_at = NOW(), created_by = EXCLUDED.created_by`;

/** Write the identity row from probe vectors already obtained (no network). */
async function writeIdentity(
  db: Queryable,
  leaf: LlmProfile & { account_name?: string },
  vecs: number[][],
  user: string,
  state: "active" | "switching",
): Promise<void> {
  await db.query(UPSERT_IDENTITY_SQL, [
    state,
    leaf.model,
    leaf.provider,
    leaf.account_name ?? leaf.name.split(" · ")[0] ?? "",
    vecs[0].length,
    JSON.stringify(PROBE_TEXTS),
    JSON.stringify(vecs),
    user,
  ]);
}

/** Record `leaf` as the system's embedding model (new identity version). */
export async function adoptIdentity(leaf: LlmProfile & { account_name?: string }, user: string, opts: { state?: "active" | "switching" } = {}): Promise<EmbeddingIdentity> {
  await ensureSchema();
  const vecs = await embedProbes(leaf);
  await writeIdentity({ query: (sql, params) => query(sql, params) }, leaf, vecs, user, opts.state ?? "active");
  logInfo("embedding_identity_adopted", { model: leaf.model, provider: leaf.provider, dimensions: vecs[0].length, by: user });
  return (await getIdentity())!;
}

/**
 * Put back an identity snapshot taken before a failed switch (or remove the row
 * when there was none), so identity and role binding agree again.
 */
async function restoreIdentity(before: EmbeddingIdentity | null): Promise<void> {
  if (!before) {
    await query("DELETE FROM admin.embedding_identity WHERE id = 1");
    return;
  }
  await query(
    `UPDATE admin.embedding_identity SET version = $1, state = 'active', model = $2, provider = $3, account_name = $4,
       dimensions = $5, probe_vectors = $6::jsonb, created_at = $7, created_by = $8 WHERE id = 1`,
    [before.version, before.model, before.provider, before.account_name, before.dimensions, JSON.stringify(before.probe_vectors), before.created_at, before.created_by],
  );
}

export async function setIdentityState(state: "active" | "switching"): Promise<void> {
  await ensureSchema();
  await query("UPDATE admin.embedding_identity SET state = $1 WHERE id = 1", [state]);
}

/** Is the embedding role shut for a model switch? (Checked on the hot path; cheap.) */
const SWITCH_FLAG_TTL_MS = 3000;
let stateCache: { at: number; switching: boolean } | null = null;
export async function embeddingSwitching(): Promise<boolean> {
  if (stateCache && Date.now() - stateCache.at < SWITCH_FLAG_TTL_MS) return stateCache.switching;
  try {
    await ensureSchema();
    const r = await query<{ state: string }>("SELECT state FROM admin.embedding_identity WHERE id = 1");
    stateCache = { at: Date.now(), switching: r.rows[0]?.state === "switching" };
  } catch {
    stateCache = { at: Date.now(), switching: false };
  }
  return stateCache.switching;
}
export function invalidateSwitchState(): void {
  stateCache = null;
  dimsCache = null;
}

/**
 * Vector size of the system's embedding identity (what the pgvector columns
 * hold), or null when there is no identity yet / the DB cannot say. Cached
 * like the switch flag: it is read on the embedding hot path.
 */
let dimsCache: { at: number; dims: number | null } | null = null;
export async function identityDimensions(): Promise<number | null> {
  if (dimsCache && Date.now() - dimsCache.at < SWITCH_FLAG_TTL_MS) return dimsCache.dims;
  try {
    await ensureSchema();
    const r = await query<{ dimensions: number | string }>("SELECT dimensions FROM admin.embedding_identity WHERE id = 1");
    const n = Number(r.rows[0]?.dimensions);
    dimsCache = { at: Date.now(), dims: Number.isInteger(n) && n > 0 ? n : null };
  } catch {
    dimsCache = { at: Date.now(), dims: null };
  }
  return dimsCache.dims;
}

/**
 * Validate every leaf an embedding profile can answer with. With no identity
 * yet: if vectors already exist they came from the role's current model, so
 * that becomes the identity first; otherwise the first leaf here does.
 */
export async function assertSameEmbeddingModel(
  leaves: (LlmProfile & { account_name?: string })[],
  user: string,
  currentRoleLeaves: () => Promise<(LlmProfile & { account_name?: string })[]>,
  /** `${account_id}:${model}` already in service: an outage must not block editing the profile. */
  grandfathered: Set<string> = new Set(),
): Promise<void> {
  if (leaves.length === 0) return;
  let identity = await getIdentity();
  if (!identity) {
    const has = await systemHasEmbeddings();
    const seed = has ? (await currentRoleLeaves())[0] : leaves[0];
    if (!seed) throw new ProfileValidationError("Vectors exist but no embedding model is bound to produce the system fingerprint; bind the original embedding profile first.");
    identity = await adoptIdentity(seed, user);
  }
  for (const leaf of leaves) {
    let r: FingerprintResult;
    try {
      r = await checkFingerprint(leaf);
    } catch (exc) {
      // Unreachable right now. A model already serving this role keeps its place
      // (it was accepted before); a new one must prove itself first.
      if (grandfathered.has(`${leaf.account_id}:${leaf.model}`)) {
        logWarning("embedding_fingerprint_unverified", { leaf: leaf.name, error: (exc as Error).message });
        continue;
      }
      throw new ProfileValidationError(`Could not verify '${leaf.name}' against the system embedding model: ${(exc as Error).message}`);
    }
    if (!r.ok) {
      throw new ProfileValidationError(
        `'${leaf.name}' is not the system's embedding model (${identity.model}, ${identity.dimensions} dims): ${r.message} ` +
          "Every embedding endpoint must produce the same vectors. To change models, use 'Switch embedding model', which re-indexes all vectors.",
      );
    }
  }
}

// ── switching models ─────────────────────────────────────────────────────────

const EMBED_JOB_TYPES = [...new Set(EMBEDDING_TABLES.map((t) => t.jobType))];

export interface SwitchStep {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
}

/**
 * Replace the system's embedding model. Order matters: nothing may write
 * old-model vectors after the wipe, so the role is shut first and embed jobs
 * are stopped before any table is touched.
 *
 * The wipe and the identity adoption commit together (the probe vectors from
 * step 0 are reused, so no network call sits between them). Binding the role
 * to the new model is a separate write; when it fails the previous identity is
 * restored, so identity and role binding always name the same model. Whenever
 * vectors were lost on the way, re-index jobs are queued for the model that
 * ends up serving the role.
 */
type SwitchOptions = {
  leaf: LlmProfile & { account_name?: string };
  user: string;
  bindNewProfile: (leaf: LlmProfile) => Promise<{ id: number; name: string }>;
  /** Wait for every process's cached switch flag to expire before queueing jobs (tests pass 0). */
  settleMs?: number;
};
type SwitchResult = { steps: SwitchStep[]; jobs: string[]; profile: { id: number; name: string } };

/** A switch is running in this process (the probe phase happens before the DB flag is set). */
let switchRunning = false;

export async function switchEmbeddingModel(opts: SwitchOptions): Promise<SwitchResult> {
  if (switchRunning) throw new ProfileValidationError("An embedding model switch is already in progress.");
  switchRunning = true;
  try {
    return await switchEmbeddingModelUnlocked(opts);
  } finally {
    switchRunning = false;
  }
}

async function switchEmbeddingModelUnlocked(opts: SwitchOptions): Promise<SwitchResult> {
  const { leaf, user } = opts;
  const settleMs = opts.settleMs ?? SWITCH_FLAG_TTL_MS + 1000;
  const steps: SwitchStep[] = [];
  const step = (key: string, label: string, detail: string) => steps.push({ key, label, ok: true, detail });

  // 0. The new model must answer before anything is shut.
  const probe = await embedProbes(leaf).catch((exc: Error) => {
    throw new ProfileValidationError(`The new model did not answer: ${exc.message}`);
  });
  if (probe[0].length !== embeddingDimensions(leaf)) {
    throw new ProfileValidationError(`The new model returned ${probe[0].length}-dimension vectors but ${embeddingDimensions(leaf)} were configured.`);
  }
  await ensureSchema();
  const before = await getIdentity();
  // Same vectors as today: switching would wipe and rebuild everything for nothing.
  if (before && probe[0].length === before.dimensions && compareFingerprint(probe, before.probe_vectors).ok) {
    throw new ProfileValidationError("This model already produces the system's vectors; no switch is needed — add it to the embedding profile instead.");
  }
  const hadEmbeddings = await systemHasEmbeddings();
  let counts: { table: string; label: string; module: string; count: number }[] = [];
  /** The new identity row is in place (committed) — failure must restore `before`. */
  let adopted = false;
  let bound = false;
  let reindexAttempted = false;

  // 1. Shut every embedding endpoint (search drops to keyword-only). With no
  //    identity row yet (legacy vectors) there is nothing to flag, so the new
  //    identity is written right away in the 'switching' state — that is what
  //    closes the role; a failure below removes it again.
  if (before) {
    // Claim the switch atomically: another process may be past its probe too.
    // (A row left 'switching' by a crash can still be recovered by a new switch.)
    const claimed = await query("UPDATE admin.embedding_identity SET state = $1 WHERE id = 1 AND (state = 'active' OR $2::boolean) RETURNING 1", [
      "switching",
      before.state === "switching",
    ]);
    if (!claimed.rows.length) throw new ProfileValidationError("An embedding model switch is already in progress.");
  } else {
    await writeIdentity({ query: (sql, params) => query(sql, params) }, leaf, probe, user, "switching");
    adopted = true;
  }
  invalidateSwitchState();
  step("shutdown", "關閉所有 Embedding 端點", "語意搜尋暫時改為關鍵字比對；新的向量工作不會啟動。");

  const queueReindex = async (modules: string[]): Promise<string[]> => {
    if (modules.length === 0) return [];
    // Queued only after the role is open and every process's cached "switching"
    // flag has expired — a worker claiming a job while it still sees the role
    // shut would fail it.
    if (settleMs > 0) await new Promise((resolve) => setTimeout(resolve, settleMs));
    const jobs: string[] = [];
    for (const t of EMBEDDING_TABLES.filter((x, i, a) => a.findIndex((y) => y.jobType === x.jobType) === i)) {
      if (!modules.includes(t.module)) continue;
      const job = await createJob({ moduleKey: t.module, jobType: t.jobType, requestedBy: user, jobOptions: { reason: "embedding_model_switch" } });
      jobs.push(String(job.job_id));
    }
    return jobs;
  };

  try {
    // 2. Stop embed jobs and wait for them to leave the running state.
    // Active jobs get a stop request (honoured at their next checkpoint); a job
    // waiting to auto-retry would otherwise come back after the switch, so it is
    // closed directly. Only jobs actually stopped are counted.
    const running = await query<{ job_id: string; job_type: string }>(
      "SELECT job_id, job_type FROM admin.import_jobs WHERE job_type = ANY($1::text[]) AND status IN ('queued', 'running', 'paused')",
      [EMBED_JOB_TYPES],
    );
    let stopped = 0;
    for (const j of running.rows) {
      try {
        await requestJobControl({ jobId: j.job_id, action: "stop", requestedBy: user });
        stopped += 1;
      } catch (exc) {
        logWarning("embedding_switch_stop_failed", { job_id: j.job_id, error: (exc as Error).message });
      }
    }
    const retrying = await query(
      `UPDATE admin.import_jobs SET status = 'cancelled', next_retry_at = NULL, finished_at = COALESCE(finished_at, NOW()), updated_at = NOW(),
              last_error_message = COALESCE(last_error_message, '') || ' [cancelled: embedding model switch]'
        WHERE job_type = ANY($1::text[]) AND status = 'retryable_failed' RETURNING job_id`,
      [EMBED_JOB_TYPES],
    );
    stopped += retrying.rows.length;
    const deadline = Date.now() + 120_000;
    for (;;) {
      const r = await query<{ n: string }>(
        "SELECT count(*) AS n FROM admin.import_jobs WHERE job_type = ANY($1::text[]) AND status = 'running'",
        [EMBED_JOB_TYPES],
      );
      if (Number(r.rows[0]?.n ?? 0) === 0) break;
      if (Date.now() > deadline) throw new Error("Embedding jobs did not stop within 2 minutes; try again when they have finished.");
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    step("stop_jobs", "停止向量工作", stopped ? `已停止 ${stopped} 個向量工作。` : "沒有進行中的向量工作。");

    // 3+4a. Wipe every vector table and adopt the new identity in one
    //       transaction, using the probe vectors from step 0 (no network here).
    counts = await vectorCounts();
    await withTransaction(async (client) => {
      for (const t of EMBEDDING_TABLES) await client.query(`TRUNCATE ${t.table}`);
      if (!adopted) await writeIdentity(client, leaf, probe, user, "switching");
    });
    adopted = true;
    logInfo("embedding_identity_adopted", { model: leaf.model, provider: leaf.provider, dimensions: probe[0].length, by: user });
    const wiped = counts.reduce((s, c) => s + c.count, 0);
    step("wipe", "清除舊向量", hadEmbeddings ? `刪除 ${wiped.toLocaleString()} 筆舊模型向量。` : "原本沒有向量。");

    // 4b. Point the role at the new model.
    const profile = await opts.bindNewProfile(leaf);
    bound = true;
    step("adopt", "設定新的系統 Embedding 模型", `${leaf.model}（${probe[0].length} 維），Embedding 角色改用「${profile.name}」。`);

    // 5. Open the role again — only new-model vectors exist from here on.
    await setIdentityState("active");
    invalidateSwitchState();
    step("reopen", "重新開放 Embedding", "語意搜尋改用新模型；重建期間結果會逐步完整。");

    // 6. Re-index every module that had vectors.
    reindexAttempted = true;
    const jobs = await queueReindex([...new Set(counts.filter((c) => c.count > 0).map((c) => c.module))]);
    step("reindex", "排入重建索引", jobs.length ? `已排入 ${jobs.length} 個模組的重建工作。` : "沒有需要重建的模組。");

    await query(
      `INSERT INTO admin.admin_audit_log (admin_user, action, target_type, target_id, payload_json) VALUES ($1, 'switch_embedding_model', 'embedding', 'system', $2::jsonb)`,
      [user, JSON.stringify({ from: before?.model ?? null, to: leaf.model, wiped, jobs })],
    );
    return { steps, jobs, profile };
  } catch (exc) {
    // Never leave the role shut by a half-done switch, and never leave the
    // identity naming a model the role is not bound to.
    if (bound) {
      // The new model serves the role; only reopening / queueing failed.
      await setIdentityState("active").catch(() => undefined);
    } else if (adopted) {
      await restoreIdentity(before).catch((e: Error) => logWarning("embedding_switch_restore_failed", { error: e.message }));
    } else if (before) {
      await setIdentityState("active").catch(() => undefined);
    }
    invalidateSwitchState();
    // Vectors lost on the way (the wipe committed) are rebuilt by whichever
    // model now serves the role, so search does not stay keyword-only forever.
    if (!reindexAttempted) {
      try {
        const now = await vectorCounts();
        const lost = counts.filter((c) => c.count > 0 && (now.find((n) => n.table === c.table)?.count ?? 0) === 0).map((c) => c.module);
        const jobs = await queueReindex([...new Set(lost)]);
        if (jobs.length) logWarning("embedding_switch_failed_reindex_queued", { jobs, error: (exc as Error).message });
      } catch (e) {
        logWarning("embedding_switch_reindex_failed", { error: (e as Error).message });
      }
    }
    throw exc;
  }
}

/**
 * Embedding profiles that cannot serve the system as they are: an endpoint
 * with other dimensions than the identity, or one whose recorded verdict under
 * the current identity is "different model" (typical after a model switch).
 * Endpoints never checked are not counted — unknown is not stale.
 */
export async function staleEmbeddingRoutes(routes: { id: number; kind: string }[]): Promise<Set<number>> {
  const out = new Set<number>();
  const identity = await getIdentity();
  if (!identity) return out;
  const bad = await query<{ account_id: string; model: string; dimensions: number }>(
    "SELECT account_id, model, dimensions FROM admin.embedding_fingerprints WHERE NOT ok AND identity_version = $1",
    [identity.version],
  );
  const badKeys = new Set(bad.rows.map((r) => `${r.account_id}:${r.model}:${r.dimensions}`));
  const { roleLeaves } = await import("./llmRouting.js");
  for (const r of routes) {
    if (r.kind !== "embedding") continue;
    const leaves = await roleLeaves("embedding", r.id);
    if (leaves.some((l) => embeddingDimensions(l) !== identity.dimensions || badKeys.has(`${l.account_id}:${l.model}:${embeddingDimensions(l)}`))) out.add(r.id);
  }
  return out;
}
