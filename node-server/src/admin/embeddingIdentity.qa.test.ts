/**
 * QA: embedding identity — fingerprint comparison edge cases, and the order /
 * failure handling of switchEmbeddingModel against a fake pg pool (state kept in
 * memory, TRUNCATE recorded) with a stubbed embedding endpoint.
 */

process.env.DATABASE_URL ??= "postgresql://qa:qa@127.0.0.1:1/qa";

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { initPool } from "../db.js";
import { compareFingerprint, embeddingSwitching, invalidateSwitchState, MIN_SIMILARITY, PROBE_TEXTS, switchEmbeddingModel } from "./embeddingIdentity.js";
import type { LlmProfile } from "./llmProfiles.js";

// ── compareFingerprint ───────────────────────────────────────────────────────

const unit = (n: number, i: number) => Array.from({ length: n }, (_, k) => (k === i ? 1 : 0));
const anchor = PROBE_TEXTS.map((_, i) => unit(8, i));

test("fingerprint: identical vectors pass with min=max=mean=1", () => {
  const r = compareFingerprint(anchor, anchor);
  assert.equal(r.ok, true);
  assert.ok(Math.abs(r.min - 1) < 1e-12 && Math.abs(r.mean - 1) < 1e-12);
});

test("fingerprint: zero vector → cosine 0 → fail (no NaN)", () => {
  const r = compareFingerprint(anchor.map((v, i) => (i === 0 ? v.map(() => 0) : v)), anchor);
  assert.equal(r.ok, false);
  assert.equal(r.min, 0);
});

test("fingerprint: NaN component → that probe scores 0 (NaN norm is falsy) → fail", () => {
  const r = compareFingerprint(anchor.map((v, i) => (i === 2 ? [Number.NaN, ...v.slice(1)] : v)), anchor);
  assert.equal(r.ok, false);
  assert.equal(r.min, 0);
});

test("fingerprint: fewer / more probe vectors than the anchor → fail", () => {
  assert.equal(compareFingerprint(anchor.slice(0, 5), anchor).ok, false);
  assert.equal(compareFingerprint([...anchor, anchor[0]], anchor).ok, false);
});

test("fingerprint: per-vector length mismatch → that probe scores 0 → fail", () => {
  assert.equal(compareFingerprint(anchor.map((v, i) => (i === 1 ? v.slice(0, 4) : v)), anchor).ok, false);
});

test("fingerprint: scaled vectors (non-normalized provider) still pass — cosine is scale-invariant", () => {
  assert.equal(compareFingerprint(anchor.map((v) => v.map((x) => x * 37)), anchor).ok, true);
});

test("fingerprint: a negated model (cos = −1) fails; just under the threshold fails, at it passes", () => {
  assert.equal(compareFingerprint(anchor.map((v) => v.map((x) => -x)), anchor).ok, false);
  const at = (c: number) => anchor.map((_, i) => {
    const v = unit(8, i).map((x) => x * c);
    v[(i + 1) % 8] = Math.sqrt(1 - c * c);
    return v;
  });
  assert.equal(compareFingerprint(at(MIN_SIMILARITY - 1e-6), anchor).ok, false);
  assert.equal(compareFingerprint(at(MIN_SIMILARITY + 1e-9), anchor).ok, true);
});

test("fingerprint: an empty candidate against an empty anchor is not ok (no min=Infinity / mean=NaN)", () => {
  const r = compareFingerprint([], []);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.ok(Number.isFinite(r.min) && Number.isFinite(r.mean));
  assert.equal(compareFingerprint(anchor, []).ok, false);
});

// ── switchEmbeddingModel with a fake DB ─────────────────────────────────────

interface Identity {
  version: number;
  state: "active" | "switching";
  model: string;
  provider: string;
  account_name: string;
  dimensions: number;
  probe_vectors: number[][];
  created_at: Date;
  created_by: string;
}
const db = {
  identity: null as Identity | null,
  vectors: 100,
  ops: [] as string[],
  switchingSeenAtTruncate: null as boolean | null,
  boundModel: "old-model",
  failAdoptInsert: false,
};
const pool = initPool();
const q = async (sql: string, params: unknown[] = []) => {
  const s = sql.trim();
  if (/^CREATE TABLE/.test(s)) return { rows: [] };
  if (/FROM admin\.embedding_identity WHERE id = 1/.test(s) && /^SELECT version/.test(s)) return { rows: db.identity ? [structuredClone(db.identity)] : [] };
  if (/^SELECT state FROM admin\.embedding_identity/.test(s)) return { rows: db.identity ? [{ state: db.identity.state }] : [] };
  if (/^UPDATE admin\.embedding_identity SET state/.test(s)) {
    // The switch claims the role with a conditional update (… AND (state = 'active' OR $2) RETURNING 1).
    if (/RETURNING/.test(s) && db.identity && db.identity.state !== "active" && params[1] !== true) return { rows: [] };
    db.ops.push(`state:${String(params[0])}`);
    if (db.identity) db.identity.state = params[0] as Identity["state"];
    return { rows: db.identity ? [{ "?column?": 1 }] : [] };
  }
  if (/^INSERT INTO admin\.embedding_identity/.test(s)) {
    if (db.failAdoptInsert) throw new Error("deadlock detected");
    db.ops.push(`adopt:${String(params[1])}`);
    db.identity = {
      version: (db.identity?.version ?? 0) + 1,
      state: params[0] as Identity["state"],
      model: String(params[1]),
      provider: String(params[2]),
      account_name: String(params[3]),
      dimensions: Number(params[4]),
      probe_vectors: JSON.parse(String(params[6])) as number[][],
      created_at: new Date(),
      created_by: String(params[7]),
    };
    return { rows: [] };
  }
  if (/^UPDATE admin\.embedding_identity SET version/.test(s)) {
    db.ops.push(`restore:${String(params[1])}`);
    db.identity = {
      version: Number(params[0]),
      state: "active",
      model: String(params[1]),
      provider: String(params[2]),
      account_name: String(params[3]),
      dimensions: Number(params[4]),
      probe_vectors: JSON.parse(String(params[5])) as number[][],
      created_at: new Date(String(params[6])),
      created_by: String(params[7]),
    };
    return { rows: [] };
  }
  if (/^DELETE FROM admin\.embedding_identity/.test(s)) {
    db.ops.push("restore:none");
    db.identity = null;
    return { rows: [] };
  }
  if (/INSERT INTO admin\.import_jobs/.test(s)) {
    db.ops.push("reindex-queued");
    return { rows: [{ job_id: `job-${db.ops.length}`, job_type: String(params[2]), module_key: String(params[1]), status: "queued" }] };
  }
  if (/SELECT EXISTS \(SELECT 1 FROM icd\.diagnosis_embeddings\)/.test(s)) return { rows: [{ x: db.vectors > 0 }] };
  if (/SELECT EXISTS/.test(s)) return { rows: [{ x: false }] };
  if (/^SELECT count\(\*\) AS n FROM icd\.diagnosis_embeddings/.test(s)) return { rows: [{ n: String(db.vectors) }] };
  if (/^SELECT count\(\*\) AS n FROM admin\.import_jobs/.test(s)) return { rows: [{ n: "0" }] };
  if (/^SELECT count\(\*\)/.test(s)) return { rows: [{ n: "0" }] };
  if (/^SELECT job_id, job_type FROM admin\.import_jobs/.test(s)) return { rows: [] };
  if (/^TRUNCATE icd\.diagnosis_embeddings/.test(s)) {
    invalidateSwitchState();
    db.switchingSeenAtTruncate = await embeddingSwitching();
    db.ops.push("truncate");
    db.vectors = 0;
    return { rows: [] };
  }
  return { rows: [] };
};
(pool as unknown as { query: unknown }).query = q;
(pool as unknown as { connect: unknown }).connect = async () => ({ query: q, release() {} });

const realFetch = globalThis.fetch;
let embedCalls = 0;
let failEmbedCall = 0; // 1-based call index that fails (0 = never)
/** Stub embedding endpoint. Default: a *different* model (vectors unlike the anchor); `same` reproduces the anchor. */
function stubEmbed(dims = 8, same = false): void {
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    embedCalls += 1;
    if (embedCalls === failEmbedCall) return new Response("model unloaded", { status: 503 });
    const { input } = JSON.parse(String(init?.body)) as { input: string[] };
    return new Response(JSON.stringify({ data: input.map((_, i) => ({ index: i, embedding: unit(dims, same ? i : (i + 1) % dims) })) }), { status: 200 });
  }) as typeof fetch;
}

const newLeaf: LlmProfile & { account_name?: string } = {
  id: 0, kind: "embedding", name: "acc · new-model", provider: "openai_compatible", base_url: "http://emb.test/v1", api_key: "",
  model: "new-model", enabled: true, priority: 0, weight: 1, params: { dimensions: 8 }, account_id: 9,
};

beforeEach(() => {
  db.identity = { version: 1, state: "active", model: "old-model", provider: "openai_compatible", account_name: "acc", dimensions: 8, probe_vectors: anchor, created_at: new Date(), created_by: "x" };
  db.vectors = 100;
  db.ops = [];
  db.switchingSeenAtTruncate = null;
  db.boundModel = "old-model";
  db.failAdoptInsert = false;
  embedCalls = 0;
  failEmbedCall = 0;
  invalidateSwitchState();
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("switch: the new model is probed before anything is shut; probe failure changes nothing", async () => {
  stubEmbed();
  failEmbedCall = 1;
  await assert.rejects(switchEmbeddingModel({ leaf: newLeaf, user: "qa", bindNewProfile: async () => ({ id: 1, name: "p" }) }), /did not answer/);
  assert.deepEqual(db.ops, []);
  assert.equal(db.vectors, 100);
});

test("switch: wrong probe dimensions → refused before shut-down", async () => {
  stubEmbed(16);
  await assert.rejects(switchEmbeddingModel({ leaf: newLeaf, user: "qa", bindNewProfile: async () => ({ id: 1, name: "p" }) }), /16-dimension/);
  assert.deepEqual(db.ops, []);
});

const failingBind = async (): Promise<{ id: number; name: string }> => {
  throw new Error("profile name already exists");
};

test("switch: role is shut (state=switching) before the wipe", async () => {
  stubEmbed();
  await switchEmbeddingModel({ leaf: newLeaf, user: "qa", bindNewProfile: failingBind, settleMs: 0 }).catch(() => undefined);
  assert.deepEqual(db.ops.slice(0, 2), ["state:switching", "truncate"]);
  assert.equal(db.switchingSeenAtTruncate, true);
});

test("switch: the identity is adopted from the step-0 probe vectors (one embedding call in total)", async () => {
  stubEmbed();
  const r = await switchEmbeddingModel({ leaf: newLeaf, user: "qa", bindNewProfile: async () => ({ id: 1, name: "p" }), settleMs: 0 });
  assert.equal(embedCalls, 1);
  assert.equal(db.identity!.model, "new-model");
  assert.equal(db.identity!.state, "active");
  assert.deepEqual(db.ops.filter((o) => o.startsWith("adopt") || o === "truncate"), ["truncate", "adopt:new-model"]);
  assert.equal(r.jobs.length, 1);
});

test("with no identity row yet (legacy vectors), the role is still shut during the wipe", async () => {
  db.identity = null;
  stubEmbed();
  await switchEmbeddingModel({ leaf: newLeaf, user: "qa", bindNewProfile: failingBind, settleMs: 0 }).catch(() => undefined);
  assert.equal(db.switchingSeenAtTruncate, true, "embeddingSwitching() was false while the vectors were being wiped");
  assert.equal(db.identity, null, "the provisional identity is removed again when the bind fails");
  assert.ok(db.ops.includes("reindex-queued"), "the wiped vectors are queued for rebuild by the still-bound model");
});

test("adoption failing in the wipe transaction leaves a consistent state and queues the rebuild of lost vectors", async () => {
  stubEmbed();
  db.failAdoptInsert = true;
  await assert.rejects(switchEmbeddingModel({ leaf: newLeaf, user: "qa", bindNewProfile: async () => ({ id: 1, name: "p" }), settleMs: 0 }));
  assert.equal(db.identity!.state, "active");
  assert.equal(db.identity!.model, "old-model");
  // The fake does not model ROLLBACK, so the TRUNCATE "stuck": the rebuild must be queued.
  assert.ok(db.vectors > 0 || db.ops.includes("reindex-queued"), `vectors=${db.vectors}, identity=${db.identity!.model}, ops=${db.ops.join(" → ")}`);
});

test("bindNewProfile failing restores the previous identity, so identity and role binding name the same model", async () => {
  stubEmbed();
  await assert.rejects(switchEmbeddingModel({ leaf: newLeaf, user: "qa", bindNewProfile: failingBind, settleMs: 0 }));
  const roleModel = db.boundModel; // unchanged: bind failed
  assert.equal(db.identity!.model, roleModel, `identity=${db.identity!.model} v${db.identity!.version} state=${db.identity!.state}, role still serves ${roleModel}`);
  assert.equal(db.identity!.state, "active");
  assert.equal(db.identity!.version, 1, "previous identity version restored");
  assert.ok(db.ops.includes("reindex-queued"), `ops=${db.ops.join(" → ")}`);
});

test("switch: a model that reproduces the system's vectors is refused before anything is shut", async () => {
  stubEmbed(8, true);
  await assert.rejects(switchEmbeddingModel({ leaf: newLeaf, user: "qa", bindNewProfile: async () => ({ id: 1, name: "p" }), settleMs: 0 }), /no switch is needed/);
  assert.deepEqual(db.ops, []);
  assert.equal(db.vectors, 100);
});

test("switch: a second switch while one is claimed is refused (role already 'switching')", async () => {
  stubEmbed();
  // Another process claimed the switch after this one read the identity.
  const realQuery = (pool as unknown as { query: typeof q }).query;
  (pool as unknown as { query: typeof q }).query = async (sql: string, params: unknown[] = []) => {
    if (/^UPDATE admin\.embedding_identity SET state/.test(sql.trim()) && /RETURNING/.test(sql)) return { rows: [] };
    return realQuery(sql, params);
  };
  try {
    await assert.rejects(switchEmbeddingModel({ leaf: newLeaf, user: "qa", bindNewProfile: async () => ({ id: 1, name: "p" }), settleMs: 0 }), /already in progress/);
    assert.deepEqual(db.ops, []);
    assert.equal(db.vectors, 100);
  } finally {
    (pool as unknown as { query: typeof q }).query = realQuery;
  }
});

test("switch: two concurrent calls in one process — the second is refused at once", async () => {
  stubEmbed();
  const first = switchEmbeddingModel({ leaf: newLeaf, user: "qa", bindNewProfile: async () => ({ id: 1, name: "p" }), settleMs: 0 });
  await assert.rejects(switchEmbeddingModel({ leaf: newLeaf, user: "qa", bindNewProfile: async () => ({ id: 2, name: "q" }), settleMs: 0 }), /already in progress/);
  await first;
});
