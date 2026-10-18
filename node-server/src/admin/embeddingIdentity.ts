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
import { alterEmbeddingColumns, embeddingColumnDims, HNSW_MAX_DIMS } from "./embeddingColumns.js";
import { classifyEmbedFailure, diagnoseEmbedFailure, dimsIssue, leafContext, probeEmbedding, type EmbedIssue } from "./embeddingDiagnosis.js";
import { sampleStoredVectors, type StoredSample } from "./embeddingSamples.js";
import { CodedProfileError, embeddingDimensions, ProfileValidationError, type LlmProfile } from "./llmProfiles.js";

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
export const EMBEDDING_TABLES: { table: string; module: string; jobType: string; label: string; optional?: boolean }[] = [
  { table: "icd.diagnosis_embeddings", module: "icd", jobType: "icd_embed", label: "ICD-10" },
  { table: "loinc.concept_embeddings", module: "loinc", jobType: "loinc_embed", label: "LOINC" },
  { table: "snomed.concept_embeddings", module: "snomed", jobType: "snomed_embed", label: "SNOMED CT" },
  // optional: created by migration 20261022 — a database without it has nothing to wipe.
  { table: "fhir.concept_embeddings", module: "ig", jobType: "ig_embed", label: "FHIR IG CodeSystem 概念", optional: true },
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

// Safety net: the same DDL lives in db/schema.sql and
// db/migrations/20261021_embedding_identity.sql — keep the three in step.
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

// ── guidance: what the operator sees when a save would break the one-model rule ─

type Leaf = LlmProfile & { account_name?: string };

/** The shared pool in the minimal shape the sample / column helpers take. */
const DB = { query: <R,>(sql: string, params?: unknown[]) => query(sql, params) as unknown as Promise<{ rows: R[] }> };

/**
 * Re-index throughput assumed for the operator's time estimate (vectors per
 * second through a shared GPU with the default batch size / concurrency). Only
 * an estimate: production measured ~1–1.5 h for ~0.5 M vectors with a 0.6B model.
 */
export const REINDEX_VECTORS_PER_SECOND = 120;

export function estimateReindexMinutes(total: number): { low: number; high: number } {
  if (total <= 0) return { low: 0, high: 0 };
  const mid = total / REINDEX_VECTORS_PER_SECOND / 60;
  return { low: Math.max(1, Math.round(mid * 0.7)), high: Math.max(1, Math.round(mid * 1.5)) };
}

/** Identity + vector counts + re-index estimate: the "current state" block of every guidance dialog. */
async function systemSummary(identity: EmbeddingIdentity | null): Promise<Record<string, unknown>> {
  const counts = await vectorCounts();
  const total = counts.reduce((s, c) => s + c.count, 0);
  const est = estimateReindexMinutes(total);
  return {
    current_model: identity?.model ?? null,
    current_dims: identity?.dimensions ?? null,
    current_account: identity?.account_name || identity?.provider || null,
    vector_total: total,
    vector_counts: counts.filter((c) => c.count > 0).map((c) => ({ label: c.label, count: c.count })),
    estimate_minutes_low: est.low,
    estimate_minutes_high: est.high,
  };
}

/** What the switch dialog should be pre-filled with for this leaf (member knobs only). */
function requestedFields(leaf: Leaf, returned: number | null): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(leaf.params ?? {})) if (!["rpm", "tpm", "base_model"].includes(k)) params[k] = v;
  params.dimensions = embeddingDimensions(leaf);
  return {
    requested_name: leaf.name,
    requested_account_id: leaf.account_id ?? null,
    requested_account: leafContext(leaf).account,
    requested_model: leaf.model,
    requested_dims: embeddingDimensions(leaf),
    requested_returned_dims: returned,
    requested_params: params,
  };
}

/**
 * The save would put a different model (or vector size) next to the system's.
 * That is never done by editing a profile — only the guarded switch re-indexes
 * — so say so, with everything the dialog needs to offer the switch.
 */
async function modelChangeError(leaf: Leaf, identity: EmbeddingIdentity, r: FingerprintResult): Promise<CodedProfileError> {
  const configured = embeddingDimensions(leaf);
  const returned = r.message.startsWith("The endpoint returned") ? r.dimensions : configured;
  const reason = r.message.startsWith("Configured dimensions") ? "dims_config" : r.message.startsWith("The endpoint returned") ? "dims_returned" : "different_model";
  // Same model, only the size knob differs: not a model change, a typo to fix.
  if (reason === "dims_config" && leaf.model === identity.model) {
    return new CodedProfileError(
      `'${leaf.name}' is not the system's embedding model (${identity.model}, ${identity.dimensions} dims): ${r.message} Every embedding endpoint must produce the same vectors.`,
      "embedding_rejected_same_model_dims",
      { name: leaf.name, model: leaf.model, system_model: identity.model, system_dims: identity.dimensions, dims: configured, detail: r.message },
    );
  }
  const endpointIssue = returned !== null && returned !== configured ? dimsIssue(leaf, returned) : null;
  return new CodedProfileError(
    `'${leaf.name}' is not the system's embedding model (${identity.model}, ${identity.dimensions} dims): ${r.message} ` +
      "Every embedding endpoint must produce the same vectors. To change models, use 'Switch embedding model', which re-indexes all vectors.",
    "embedding_model_change_requires_switch",
    {
      ...(await systemSummary(identity)),
      ...requestedFields(leaf, returned),
      reason,
      similarity: r.min_similarity,
      min_similarity: MIN_SIMILARITY,
      endpoint_issue: endpointIssue,
      detail: r.message,
    },
    409,
  );
}

/** Re-embed stored texts with `leaf`: does it reproduce the stored vectors? */
async function verifyAgainstSamples(leaf: Leaf, samples: StoredSample[]): Promise<{ ok: boolean; similarity: number | null; issue: EmbedIssue | null; returned: number | null }> {
  const probe = await probeEmbedding(leaf, samples.map((s) => s.text), { timeoutMs: 60_000 });
  if (!probe.vectors) return { ok: false, similarity: null, issue: probe.issue, returned: probe.returned_dims };
  const cmp = compareFingerprint(probe.vectors, samples.map((s) => s.vector));
  return { ok: cmp.ok, similarity: cmp.min, issue: probe.issue, returned: probe.returned_dims };
}

const dedupeKey = (l: Leaf): string => `${l.account_id ?? l.base_url}:${l.model}:${embeddingDimensions(l)}`;

/** Every enabled embedding leaf of every embedding profile (the candidates for "who made these vectors"). */
async function allEmbeddingLeaves(): Promise<Leaf[]> {
  const { listRoutes, roleLeaves } = await import("./llmRouting.js");
  const out: Leaf[] = [];
  for (const r of await listRoutes("embedding")) out.push(...(await roleLeaves("embedding", r.id)).filter((l) => l.enabled));
  return out;
}

export interface SeedAttempt {
  name: string;
  model: string;
  account: string;
  ok: boolean;
  /** Why this one was not adopted: an endpoint issue code, or "different_model". */
  code: string | null;
  similarity: number | null;
  detail: string;
}

/**
 * No identity row yet. With vectors in the database, the identity must be the
 * model that made them: every candidate (the role's endpoints first, then every
 * other embedding endpoint, then the ones being saved) re-embeds a few stored
 * texts and the first that reproduces their vectors is adopted. An unreachable
 * endpoint is skipped, never adopted. With no vectors, the first candidate that
 * answers becomes the identity (nothing to protect yet), and when none answers
 * the save simply proceeds without one.
 *
 * Throws `embedding_identity_unresolved` (structured, with every attempt) when
 * vectors exist and no configured endpoint can be shown to have made them.
 */
export async function establishIdentity(opts: {
  user: string;
  /** The endpoints a save would add (tried last when vectors exist). */
  candidates: Leaf[];
  roleLeaves: () => Promise<Leaf[]>;
  otherLeaves?: () => Promise<Leaf[]>;
}): Promise<EmbeddingIdentity | null> {
  const attempts: SeedAttempt[] = [];
  const note = (leaf: Leaf, a: Omit<SeedAttempt, "name" | "model" | "account">) => attempts.push({ name: leaf.name, model: leaf.model, account: String(leafContext(leaf).account), ...a });

  if (!(await systemHasEmbeddings())) {
    for (const leaf of opts.candidates) {
      try {
        return await adoptIdentity(leaf, opts.user);
      } catch (exc) {
        const issue = classifyEmbedFailure(leaf, exc);
        note(leaf, { ok: false, code: issue.code, similarity: null, detail: String(issue.params.detail ?? "") });
      }
    }
    logWarning("embedding_identity_deferred", { reason: "no endpoint answered; no vectors to protect", attempts });
    return null;
  }

  const role = await opts.roleLeaves();
  const others = await (opts.otherLeaves ?? allEmbeddingLeaves)().catch(() => [] as Leaf[]);
  const seen = new Set<string>();
  const pool: { leaf: Leaf; fromRole: boolean }[] = [];
  for (const [list, fromRole] of [[role, true], [others, false], [opts.candidates, false]] as const) {
    for (const leaf of list) {
      const k = dedupeKey(leaf);
      if (seen.has(k)) continue;
      seen.add(k);
      pool.push({ leaf, fromRole });
    }
  }
  const samples = await sampleStoredVectors(DB).catch(() => [] as StoredSample[]);
  const storedDims = samples[0]?.vector.length ?? (await embeddingColumnDims(DB).catch(() => []))[0]?.dims ?? null;

  for (const { leaf, fromRole } of pool) {
    try {
      if (samples.length) {
        const v = await verifyAgainstSamples(leaf, samples);
        if (!v.ok) {
          note(leaf, {
            ok: false,
            code: v.issue?.code ?? "different_model",
            similarity: v.similarity,
            detail: v.issue ? String(v.issue.params.detail ?? "") : `Similarity to the stored vectors ${v.similarity?.toFixed(3) ?? "?"} (needs ≥ ${MIN_SIMILARITY}).`,
          });
          continue;
        }
      } else if (!fromRole) {
        // Without stored texts to compare, only the role's own endpoints are trusted (they made the vectors).
        note(leaf, { ok: false, code: "unverifiable", similarity: null, detail: "No stored text could be rebuilt to compare against; only the role's own endpoints are trusted." });
        continue;
      }
      const identity = await adoptIdentity(leaf, opts.user);
      if (storedDims && identity.dimensions !== storedDims) {
        // Reachable, but cannot be what made the stored vectors.
        await query("DELETE FROM admin.embedding_identity WHERE id = 1");
        invalidateSwitchState();
        note(leaf, { ok: false, code: "embedding_dims_unsupported", similarity: null, detail: `Returns ${identity.dimensions}-dimension vectors; the stored vectors have ${storedDims}.` });
        continue;
      }
      logInfo("embedding_identity_seeded", { model: leaf.model, account: leafContext(leaf).account, verified: samples.length > 0, tried: attempts.length + 1 });
      return identity;
    } catch (exc) {
      const issue = await diagnoseEmbedFailure(leaf, exc);
      note(leaf, { ok: false, code: issue.code, similarity: null, detail: String(issue.params.detail ?? "") });
    }
  }
  const first = opts.candidates[0];
  throw new CodedProfileError(
    "Vectors exist but no configured embedding endpoint reproduces them, so the system embedding model cannot be established. " +
      "Bring the original model back online, or use 'Switch embedding model' to re-index with a new one.",
    "embedding_identity_unresolved",
    {
      ...(await systemSummary(null)),
      ...(first ? requestedFields(first, null) : {}),
      stored_dims: storedDims,
      verified_by_samples: samples.length > 0,
      attempts,
      detail: attempts.map((a) => `${a.name}: ${a.code ?? "?"} — ${a.detail}`).join("\n"),
    },
    409,
  );
}

/**
 * Validate every leaf an embedding profile can answer with. With no identity
 * yet it is established first (see `establishIdentity`). Failures are coded
 * (`CodedProfileError`) so the console can explain them and offer the switch.
 */
export async function assertSameEmbeddingModel(
  leaves: Leaf[],
  user: string,
  currentRoleLeaves: () => Promise<Leaf[]>,
  /** `${account_id}:${model}` already in service: an outage must not block editing the profile. */
  grandfathered: Set<string> = new Set(),
  opts: { otherLeaves?: () => Promise<Leaf[]> } = {},
): Promise<void> {
  if (leaves.length === 0) return;
  let identity = await getIdentity();
  if (!identity) {
    identity = await establishIdentity({ user, candidates: leaves, roleLeaves: currentRoleLeaves, otherLeaves: opts.otherLeaves });
    // Nothing answered and nothing is stored: there is no model to protect yet.
    if (!identity) return;
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
      const issue = await diagnoseEmbedFailure(leaf, exc);
      throw new CodedProfileError(
        `Could not verify '${leaf.name}' against the system embedding model: ${(exc as Error).message}`,
        "embedding_endpoint_failed",
        { ...issue.params, issue: issue.code, system_model: identity.model, system_dims: identity.dimensions },
      );
    }
    if (!r.ok) throw await modelChangeError(leaf, identity, r);
  }
}

// ── switch pre-check and role health ────────────────────────────────────────

export interface SwitchPrecheck {
  /** Nothing blocks the switch (the caller still needs REINDEX when vectors exist). */
  ok: boolean;
  /** The first problem that blocks the switch, coded for the console. */
  blocking: EmbedIssue | null;
  warnings: EmbedIssue[];
  returned_dims: number | null;
  configured_dims: number;
  latency_ms: number | null;
  /** This endpoint already makes the system's vectors (a switch would only rebuild them). */
  same_model: boolean;
  similarity: number | null;
  identity: { model: string; dimensions: number; account: string } | null;
  /** Declared size of the vector columns today, and whether the switch re-types them. */
  column_dims: number | null;
  alter_columns: boolean;
  hnsw: boolean;
  summary: Record<string, unknown>;
}

/**
 * Everything the switch would find out before it shuts anything — run on its
 * own so the dialog can show problems (model missing, `dimensions` rejected,
 * native size differs, same model) before the operator types REINDEX.
 */
export async function precheckSwitch(leaf: Leaf): Promise<SwitchPrecheck> {
  await ensureSchema();
  const identity = await getIdentity();
  const summary = await systemSummary(identity);
  const columns = await embeddingColumnDims(DB).catch(() => []);
  const columnDims = columns[0]?.dims ?? null;
  const configured = embeddingDimensions(leaf);
  const probe = await probeEmbedding(leaf, PROBE_TEXTS);
  const warnings: EmbedIssue[] = [];
  let blocking: EmbedIssue | null = probe.issue;
  let same = false;
  let similarity: number | null = null;
  if (probe.vectors && !blocking) {
    if (identity && probe.returned_dims === identity.dimensions) {
      const cmp = compareFingerprint(probe.vectors, identity.probe_vectors);
      similarity = cmp.min;
      same = cmp.ok;
    } else if (!identity && Number(summary.vector_total) > 0) {
      // No identity row: compare with stored vectors directly.
      const samples = await sampleStoredVectors(DB).catch(() => [] as StoredSample[]);
      if (samples.length && samples[0].vector.length === probe.returned_dims) {
        const v = await verifyAgainstSamples(leaf, samples).catch(() => null);
        similarity = v?.similarity ?? null;
        same = Boolean(v?.ok);
      }
    }
    if (same) {
      blocking = {
        code: "embedding_switch_same_model",
        params: { ...leafContext(leaf), similarity, detail: "This model already produces the system's vectors; add it to the embedding profile instead." },
      };
    }
  }
  const finalDims = probe.returned_dims ?? configured;
  if (finalDims > HNSW_MAX_DIMS) warnings.push({ code: "embedding_dims_no_hnsw", params: { dims: finalDims, max: HNSW_MAX_DIMS } });
  return {
    ok: blocking === null,
    blocking,
    warnings,
    returned_dims: probe.returned_dims,
    configured_dims: configured,
    latency_ms: probe.latency_ms,
    same_model: same,
    similarity,
    identity: identity && { model: identity.model, dimensions: identity.dimensions, account: identity.account_name || identity.provider },
    column_dims: columnDims,
    alter_columns: columns.some((c) => c.dims !== finalDims),
    hnsw: finalDims <= HNSW_MAX_DIMS,
    summary,
  };
}

export interface MemberHealth {
  member_id: number;
  name: string;
  account: string;
  model: string;
  ok: boolean;
  latency_ms: number | null;
  returned_dims: number | null;
  issue: EmbedIssue | null;
}

const HEALTH_TTL_MS = 60_000;
let healthCache: { at: number; value: Promise<{ members: MemberHealth[]; degraded: boolean; down: boolean; answering: string | null; checked_at: string }> } | null = null;

/**
 * Probe each endpoint of the embedding role with one short text (cached for a
 * minute): which members fail and why, and which one is answering instead —
 * so an operator sees "member X: model not found, failing over to Y" before
 * touching the profile.
 */
export function embeddingRoleHealth(opts: { fresh?: boolean } = {}) {
  if (!opts.fresh && healthCache && Date.now() - healthCache.at < HEALTH_TTL_MS) return healthCache.value;
  const value = (async () => {
    const { roleLeaves } = await import("./llmRouting.js");
    const identityDims = await identityDimensions();
    const leaves = (await roleLeaves("embedding")).filter((l) => l.enabled && l.base_url && l.model);
    const members = await Promise.all(
      leaves.map(async (leaf): Promise<MemberHealth> => {
        const p = await probeEmbedding(leaf, ["health check"], { timeoutMs: 20_000, inputType: "query" });
        let issue = p.issue;
        if (!issue && identityDims && p.returned_dims !== null && p.returned_dims !== identityDims) {
          issue = { code: "embedding_dims_returned", params: { ...leafContext(leaf), dims: p.returned_dims, system_dims: identityDims } };
        }
        return { member_id: leaf.id, name: leaf.name, account: String(leafContext(leaf).account), model: leaf.model, ok: !issue, latency_ms: p.latency_ms, returned_dims: p.returned_dims, issue };
      }),
    );
    const answering = members.find((m) => m.ok)?.name ?? null;
    return { members, degraded: members.some((m) => !m.ok), down: members.length > 0 && !answering, answering, checked_at: new Date().toISOString() };
  })();
  healthCache = { at: Date.now(), value };
  value.catch(() => {
    healthCache = null;
  });
  return value;
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

  // 0. The new model must answer — with vectors of the configured size — before
  //    anything is shut. Failures carry the same codes as the pre-check.
  const checked = await probeEmbedding(leaf, PROBE_TEXTS);
  if (!checked.vectors || checked.issue) {
    const issue = checked.issue ?? { code: "embedding_no_vectors", params: leafContext(leaf) };
    const message =
      checked.returned_dims !== null && checked.returned_dims !== checked.configured_dims
        ? `The new model returned ${checked.returned_dims}-dimension vectors but ${checked.configured_dims} were configured.`
        : `The new model did not answer: ${String(issue.params.detail ?? issue.code)}`;
    throw new CodedProfileError(message, issue.code, { ...issue.params, stage: "switch" });
  }
  const probe = checked.vectors;
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
  let altered: { table: string; from: number; to: number }[] = [];

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
      for (const t of EMBEDDING_TABLES) {
        if (t.optional) {
          const exists = await client.query<{ t: string | null }>("SELECT to_regclass($1)::text AS t", [t.table]);
          if (!exists.rows[0]?.t) continue;
        }
        await client.query(`TRUNCATE ${t.table}`);
      }
      // The tables are empty now: re-type the vector columns to the new size
      // (e.g. 1024 → 2560) here, not lazily in the first embed job.
      altered = await alterEmbeddingColumns(client, probe[0].length);
      if (!adopted) await writeIdentity(client, leaf, probe, user, "switching");
    });
    adopted = true;
    logInfo("embedding_identity_adopted", { model: leaf.model, provider: leaf.provider, dimensions: probe[0].length, by: user });
    const wiped = counts.reduce((s, c) => s + c.count, 0);
    step("wipe", "清除舊向量", hadEmbeddings ? `刪除 ${wiped.toLocaleString()} 筆舊模型向量。` : "原本沒有向量。");
    if (altered.length) {
      const from = [...new Set(altered.map((a) => a.from))].join("/");
      step("alter", "調整向量欄位維度", `${altered.length} 個向量表的欄位由 ${from} 維改為 ${probe[0].length} 維。`);
    }

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
      [user, JSON.stringify({ from: before?.model ?? null, to: leaf.model, dims: probe[0].length, altered, wiped, jobs })],
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
