/**
 * Embedding guidance: identity seeding when no identity row exists, detecting a
 * model change made by editing a profile, the switch pre-check, ALTERing vector
 * columns on a size change, and mapping endpoint failures to console codes.
 *
 * Reproduces the 2026-10 production incident with fakes: vectors stored by
 * Qwen3-Embedding-0.6B, no admin.embedding_identity row, the vLLM server
 * re-deployed with qwen3-embedding-4b (so the old model name 404s), an Ollama
 * endpoint still serving the 0.6B weights, and a profile edit to the 4B model.
 */

process.env.DATABASE_URL ??= "postgresql://qa:qa@127.0.0.1:1/qa";

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { initPool } from "../db.js";
import { ProviderHttpError } from "../providers/types.js";
import {
  assertSameEmbeddingModel,
  establishIdentity,
  estimateReindexMinutes,
  invalidateSwitchState,
  precheckSwitch,
  PROBE_TEXTS,
  switchEmbeddingModel,
} from "./embeddingIdentity.js";
import { classifyEmbedFailure, diagnoseEmbedFailure, dimsIssue, probeEmbedding } from "./embeddingDiagnosis.js";
import { classifyLlmMessage, errorFields } from "./llmErrorCodes.js";
import { CodedProfileError, type LlmProfile } from "./llmProfiles.js";

// ── fake embedding servers ──────────────────────────────────────────────────

/** Deterministic "model": the same family gives the same vector for a text, on any server. */
function familyVector(family: string, text: string, dims: number): number[] {
  const out: number[] = [];
  let seed = crypto.createHash("sha256").update(`${family}|${text}`).digest().readUInt32BE(0) || 1;
  for (let i = 0; i < dims; i += 1) {
    seed = (seed * 16807) % 2147483647;
    out.push((seed / 2147483647) * 2 - 1);
  }
  return out;
}

const servers = {
  /** vLLM: serves one model; `matryoshka` decides whether `dimensions` is accepted. */
  vllm: { up: true, model: "qwen3-embedding-4b", family: "qwen3-4b", native: 12, matryoshka: false },
  /** Ollama: still serves the old weights under its own tag. */
  ollama: { up: true, model: "qwen3-embedding:0.6b-q8_0", family: "qwen3-0.6b", native: 8 },
};
let calls: string[] = [];

const realFetch = globalThis.fetch;
function installServers(): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.startsWith("http://vllm.test")) {
      if (!servers.vllm.up) throw new TypeError("fetch failed");
      if (url.endsWith("/models")) return json(200, { object: "list", data: [{ id: servers.vllm.model, object: "model" }] });
      const body = JSON.parse(String(init?.body)) as { model: string; input: string[]; dimensions?: number };
      calls.push(`vllm:${body.model}${body.dimensions ? `@${body.dimensions}` : ""}`);
      if (body.model !== servers.vllm.model) {
        return json(404, { error: { message: `The model \`${body.model}\` does not exist.`, type: "NotFoundError", code: 404 } });
      }
      if (body.dimensions !== undefined && !servers.vllm.matryoshka) {
        return json(400, {
          error: { message: `Model '${body.model}' does not support Matryoshka embeddings; dimensions must be unset (received dimensions=${body.dimensions}).`, type: "BadRequestError", code: 400 },
        });
      }
      const dims = body.dimensions ?? servers.vllm.native;
      return json(200, { data: body.input.map((t, i) => ({ index: i, embedding: familyVector(servers.vllm.family, t, servers.vllm.native).slice(0, dims) })) });
    }
    if (url.startsWith("http://ollama.test")) {
      if (!servers.ollama.up) throw new TypeError("fetch failed");
      if (url.endsWith("/api/tags")) return json(200, { models: [{ name: servers.ollama.model }] });
      const body = JSON.parse(String(init?.body)) as { model: string; input: string[] };
      calls.push(`ollama:${body.model}`);
      if (body.model !== servers.ollama.model) return json(404, { error: `model "${body.model}" not found, try pulling it first` });
      return json(200, { embeddings: body.input.map((t) => familyVector(servers.ollama.family, t, servers.ollama.native)) });
    }
    throw new TypeError("fetch failed");
  }) as typeof fetch;
}

const leaf = (name: string, over: Partial<LlmProfile>): LlmProfile & { account_name?: string } => ({
  id: 0,
  kind: "embedding",
  name,
  provider: "openai_compatible",
  base_url: "http://vllm.test/v1",
  api_key: "",
  model: "",
  enabled: true,
  priority: 0,
  weight: 1,
  params: { dimensions: 8 },
  account_id: 4,
  ...over,
});
/** The production profile before the edit: vLLM 0.6B (now 404) + Ollama 0.6B. */
const vllmOld = leaf("vllm · Qwen3-Embedding-0.6B", { id: 2, model: "Qwen3-Embedding-0.6B" });
const ollamaOld = leaf("gpu server · qwen3-embedding:0.6b-q8_0", { id: 3, provider: "ollama", base_url: "http://ollama.test", model: "qwen3-embedding:0.6b-q8_0", account_id: 3 });
/** The edit the operator saved: same vLLM account, the new model name, dimensions 1024 → here 8. */
const vllmNew = leaf("vllm · qwen3-embedding-4b", { model: "qwen3-embedding-4b" });

// ── fake database ───────────────────────────────────────────────────────────

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
/** Texts the stored ICD vectors were made from (by the 0.6B family, 8 dims). */
const STORED = ["E11.21 第二型糖尿病伴有糖尿病腎病變 Type 2 diabetes mellitus with diabetic nephropathy", "I21.9 急性心肌梗塞 Acute myocardial infarction, unspecified"];
const db = {
  identity: null as Identity | null,
  vectors: 0,
  columnDims: 8,
  ops: [] as string[],
};
const sha = (t: string) => crypto.createHash("sha256").update(t, "utf8").digest("hex");
const pool = initPool();
const q = async (sql: string, params: unknown[] = []) => {
  const s = sql.trim();
  if (/^(CREATE TABLE|BEGIN|COMMIT|ROLLBACK)/.test(s)) return { rows: [] };
  if (/^SELECT version, state, model/.test(s)) return { rows: db.identity ? [structuredClone(db.identity)] : [] };
  if (/^SELECT state FROM admin\.embedding_identity/.test(s)) return { rows: db.identity ? [{ state: db.identity.state }] : [] };
  if (/^SELECT dimensions FROM admin\.embedding_identity/.test(s)) return { rows: db.identity ? [{ dimensions: db.identity.dimensions }] : [] };
  if (/^UPDATE admin\.embedding_identity SET state/.test(s)) {
    if (db.identity) db.identity.state = params[0] as Identity["state"];
    db.ops.push(`state:${String(params[0])}`);
    return { rows: db.identity ? [{ "?column?": 1 }] : [] };
  }
  if (/^INSERT INTO admin\.embedding_identity/.test(s)) {
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
  if (/^DELETE FROM admin\.embedding_identity/.test(s)) {
    db.ops.push("identity:deleted");
    db.identity = null;
    return { rows: [] };
  }
  if (/FROM admin\.embedding_fingerprints/.test(s)) return { rows: [] };
  if (/^INSERT INTO admin\.embedding_fingerprints/.test(s)) return { rows: [] };
  if (/FROM icd\.diagnosis_embeddings WHERE source_hash IS NOT NULL/.test(s)) {
    if (!db.vectors) return { rows: [] };
    return {
      rows: STORED.map((t) => {
        const [code, ...rest] = t.split(" ");
        const zh = rest[0];
        const en = rest.slice(1).join(" ");
        return { code, name_zh: zh, name_en: en, h: sha(t), v: `[${familyVector("qwen3-0.6b", t, 8).join(",")}]` };
      }),
    };
  }
  if (/WHERE source_hash IS NOT NULL/.test(s)) return { rows: [] };
  if (/SELECT EXISTS \(SELECT 1 FROM icd\.diagnosis_embeddings\)/.test(s)) return { rows: [{ x: db.vectors > 0 }] };
  if (/SELECT EXISTS/.test(s)) return { rows: [{ x: false }] };
  if (/^SELECT count\(\*\) AS n FROM icd\.diagnosis_embeddings/.test(s)) return { rows: [{ n: String(db.vectors) }] };
  if (/^SELECT count\(\*\)/.test(s)) return { rows: [{ n: "0" }] };
  if (/FROM pg_attribute/.test(s)) return { rows: params[0] === "icd" ? [{ atttypmod: db.columnDims }] : [] };
  if (/^ALTER TABLE icd\.diagnosis_embeddings ADD COLUMN embedding halfvec\((\d+)\)/.test(s)) {
    db.columnDims = Number(s.match(/halfvec\((\d+)\)/)![1]);
    db.ops.push(`alter:${db.columnDims}`);
    return { rows: [] };
  }
  if (/^SELECT to_regclass/.test(s)) return { rows: [{ t: null }] };
  if (/^TRUNCATE icd\.diagnosis_embeddings/.test(s)) {
    db.ops.push("truncate");
    db.vectors = 0;
    return { rows: [] };
  }
  if (/INSERT INTO admin\.import_jobs/.test(s)) {
    db.ops.push("reindex-queued");
    return { rows: [{ job_id: `job-${db.ops.length}`, job_type: String(params[2]), module_key: String(params[1]), status: "queued" }] };
  }
  if (/^SELECT job_id, job_type FROM admin\.import_jobs/.test(s)) return { rows: [] };
  return { rows: [] };
};
(pool as unknown as { query: unknown }).query = q;
(pool as unknown as { connect: unknown }).connect = async () => ({ query: q, release() {} });

beforeEach(() => {
  servers.vllm = { up: true, model: "qwen3-embedding-4b", family: "qwen3-4b", native: 12, matryoshka: false };
  servers.ollama = { up: true, model: "qwen3-embedding:0.6b-q8_0", family: "qwen3-0.6b", native: 8 };
  db.identity = null;
  db.vectors = 500;
  db.columnDims = 8;
  db.ops = [];
  calls = [];
  invalidateSwitchState();
  installServers();
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const noOthers = async () => [];

// ── identity seeding ────────────────────────────────────────────────────────

test("seeding: an unreachable (404) role member is skipped; the endpoint that reproduces the stored vectors is adopted", async () => {
  const id = await establishIdentity({ user: "qa", candidates: [vllmNew], roleLeaves: async () => [vllmOld, ollamaOld], otherLeaves: noOthers });
  assert.equal(id?.model, "qwen3-embedding:0.6b-q8_0");
  assert.equal(id?.dimensions, 8);
  assert.ok(calls.includes("vllm:Qwen3-Embedding-0.6B"), "the role's first member was tried first");
});

test("seeding: a reachable endpoint of another model is never adopted (stored vectors decide, not order)", async () => {
  // The vLLM server now serves the 4B under the *old* name: reachable, but not what made the vectors.
  servers.vllm.model = "Qwen3-Embedding-0.6B";
  servers.vllm.native = 8;
  const id = await establishIdentity({ user: "qa", candidates: [], roleLeaves: async () => [vllmOld, ollamaOld], otherLeaves: noOthers });
  assert.equal(id?.model, "qwen3-embedding:0.6b-q8_0");
});

test("seeding: nothing reproduces the vectors → structured embedding_identity_unresolved with every attempt", async () => {
  servers.ollama.up = false;
  await assert.rejects(
    establishIdentity({ user: "qa", candidates: [vllmNew], roleLeaves: async () => [vllmOld, ollamaOld], otherLeaves: noOthers }),
    (e: unknown) => {
      assert.ok(e instanceof CodedProfileError);
      assert.equal(e.code, "embedding_identity_unresolved");
      assert.equal(e.status, 409);
      const attempts = e.params.attempts as { name: string; code: string }[];
      assert.deepEqual(
        attempts.map((a) => a.code),
        ["embedding_model_not_found", "embedding_endpoint_unreachable", "embedding_dims_unsupported"],
      );
      assert.equal(e.params.requested_model, "qwen3-embedding-4b");
      assert.equal(e.params.vector_total, 500);
      return true;
    },
  );
  assert.equal(db.identity, null, "no identity is written from an endpoint that cannot be shown to have made the vectors");
});

test("seeding with no vectors: the first answering candidate becomes the identity; none answering defers without error", async () => {
  db.vectors = 0;
  servers.vllm.up = false;
  const id = await establishIdentity({ user: "qa", candidates: [vllmNew, ollamaOld], roleLeaves: async () => [], otherLeaves: noOthers });
  assert.equal(id?.model, "qwen3-embedding:0.6b-q8_0");
  db.identity = null;
  servers.ollama.up = false;
  assert.equal(await establishIdentity({ user: "qa", candidates: [vllmNew, ollamaOld], roleLeaves: async () => [], otherLeaves: noOthers }), null);
});

// ── the incident: editing the profile to another model ─────────────────────

test("incident: profile edit to qwen3-embedding-4b → identity seeded from Ollama, then embedding_model_change_requires_switch", async () => {
  await assert.rejects(
    assertSameEmbeddingModel([vllmNew], "qa", async () => [vllmOld, ollamaOld], new Set(), { otherLeaves: noOthers }),
    (e: unknown) => {
      assert.ok(e instanceof CodedProfileError, String(e));
      assert.equal(e.code, "embedding_model_change_requires_switch");
      assert.equal(e.status, 409);
      const p = e.params;
      assert.equal(p.current_model, "qwen3-embedding:0.6b-q8_0");
      assert.equal(p.current_dims, 8);
      assert.equal(p.requested_model, "qwen3-embedding-4b");
      assert.equal(p.requested_account_id, 4);
      assert.equal(p.requested_dims, 8);
      assert.equal(p.requested_returned_dims, 12, "the 4B returns its native size: dimensions is not sent");
      assert.equal(p.reason, "dims_returned");
      assert.equal((p.endpoint_issue as { code: string }).code, "embedding_dims_unsupported");
      assert.equal(p.vector_total, 500);
      assert.ok(Number(p.estimate_minutes_high) >= Number(p.estimate_minutes_low));
      assert.deepEqual(p.requested_params, { dimensions: 8 });
      return true;
    },
  );
  assert.equal(db.identity?.model, "qwen3-embedding:0.6b-q8_0", "the identity now exists for the next save");
});

test("a different model with the same size is a model change too (reason different_model, with similarity)", async () => {
  servers.vllm.native = 8;
  await assert.rejects(assertSameEmbeddingModel([vllmNew], "qa", async () => [ollamaOld], new Set(), { otherLeaves: noOthers }), (e: unknown) => {
    assert.ok(e instanceof CodedProfileError);
    assert.equal(e.code, "embedding_model_change_requires_switch");
    assert.equal(e.params.reason, "different_model");
    assert.equal(typeof e.params.similarity, "number");
    return true;
  });
});

test("adding a member whose model the server does not serve → embedding_endpoint_failed listing what it does serve", async () => {
  await assert.rejects(assertSameEmbeddingModel([vllmOld], "qa", async () => [ollamaOld], new Set(), { otherLeaves: noOthers }), (e: unknown) => {
    assert.ok(e instanceof CodedProfileError);
    assert.equal(e.code, "embedding_endpoint_failed");
    assert.equal(e.params.issue, "embedding_model_not_found");
    assert.deepEqual(e.params.available, ["qwen3-embedding-4b"]);
    assert.equal(e.params.base_url, "http://vllm.test/v1");
    return true;
  });
});

test("the same model through another server is accepted (fallback member)", async () => {
  const ollamaAgain = { ...ollamaOld, account_id: 30, name: "ollama-2 · qwen3-embedding:0.6b-q8_0" };
  await assertSameEmbeddingModel([ollamaAgain], "qa", async () => [ollamaOld], new Set(), { otherLeaves: noOthers });
});

// ── switch pre-check and switch ─────────────────────────────────────────────

test("pre-check: `dimensions` requested from a non-Matryoshka vLLM model is reported before anything is touched", async () => {
  const r = await precheckSwitch({ ...vllmNew, params: { dimensions: 8, send_dimensions: true } });
  assert.equal(r.ok, false);
  assert.equal(r.blocking?.code, "embedding_dims_unsupported");
  assert.equal(r.blocking?.params.returned, 12, "the server dropped the knob and answered with its native size");
  assert.equal(r.blocking?.params.send_dimensions, true);
  assert.equal(r.blocking?.params.self_hosted, true);
  assert.deepEqual(db.ops, []);
  assert.equal(db.vectors, 500);
});

test("pre-check: the native size passes and reports the column re-type; the same model is flagged as no switch needed", async () => {
  const ok = await precheckSwitch({ ...vllmNew, params: { dimensions: 12 } });
  assert.equal(ok.ok, true, JSON.stringify(ok.blocking));
  assert.equal(ok.returned_dims, 12);
  assert.equal(ok.column_dims, 8);
  assert.equal(ok.alter_columns, true);
  const same = await precheckSwitch(ollamaOld);
  assert.equal(same.blocking?.code, "embedding_switch_same_model");
  assert.equal(same.same_model, true);
});

test("pre-check: a model name the server does not serve lists the available ones", async () => {
  const r = await precheckSwitch(vllmOld);
  assert.equal(r.blocking?.code, "embedding_model_not_found");
  assert.deepEqual(r.blocking?.params.available, ["qwen3-embedding-4b"]);
});

test("switch in the production situation (no identity, vectors, old model gone): wipes, re-types columns 8 → 12, adopts, re-indexes", async () => {
  const r = await switchEmbeddingModel({ leaf: { ...vllmNew, params: { dimensions: 12 } }, user: "qa", bindNewProfile: async () => ({ id: 9, name: "Embedding（qwen3-embedding-4b）" }), settleMs: 0 });
  assert.deepEqual(
    db.ops.filter((o) => /^(truncate|alter|adopt|state)/.test(o)),
    ["adopt:qwen3-embedding-4b", "truncate", "alter:12", "state:active"],
  );
  assert.equal(db.columnDims, 12);
  assert.equal(db.identity?.dimensions, 12);
  assert.ok(r.steps.some((s) => s.key === "alter"));
  assert.equal(r.jobs.length, 1);
});

test("switch: configured size the model cannot produce → coded refusal before anything is shut", async () => {
  await assert.rejects(switchEmbeddingModel({ leaf: vllmNew, user: "qa", bindNewProfile: async () => ({ id: 1, name: "p" }), settleMs: 0 }), (e: unknown) => {
    assert.ok(e instanceof CodedProfileError);
    assert.equal(e.code, "embedding_dims_unsupported");
    assert.match(e.message, /12-dimension vectors but 8 were configured/);
    return true;
  });
  assert.deepEqual(db.ops, []);
});

// ── error mapping ───────────────────────────────────────────────────────────

test("classify: vLLM / Ollama model-not-found, dimensions rejection, auth, unreachable", () => {
  const vllm404 = new ProviderHttpError(404, JSON.stringify({ error: { message: "The model `Qwen3-Embedding-0.6B` does not exist.", type: "NotFoundError" } }), "http://vllm.test/v1/embeddings");
  assert.equal(classifyEmbedFailure(vllmOld, vllm404).code, "embedding_model_not_found");
  const ollama404 = new ProviderHttpError(404, JSON.stringify({ error: 'model "x" not found, try pulling it first' }), "http://ollama.test/api/embed");
  assert.equal(classifyEmbedFailure(ollamaOld, ollama404).code, "embedding_model_not_found");
  const dims400 = new ProviderHttpError(400, JSON.stringify({ error: { message: "Model 'm' does not support Matryoshka embeddings; dimensions must be unset" } }), "u");
  assert.equal(classifyEmbedFailure(vllmNew, dims400).code, "embedding_dims_unsupported");
  assert.equal(classifyEmbedFailure(vllmNew, new ProviderHttpError(401, "{}", "u")).code, "embedding_endpoint_auth");
  const pathOnly = classifyEmbedFailure(vllmNew, new ProviderHttpError(404, "<html>Not Found</html>", "u"));
  assert.equal(pathOnly.code, "embedding_endpoint_error");
  assert.equal(pathOnly.params.path_problem, true);
  const down = classifyEmbedFailure(vllmNew, new TypeError("fetch failed"));
  assert.equal(down.code, "embedding_endpoint_unreachable");
  assert.equal(down.params.base_url, "http://vllm.test/v1");
  assert.equal(classifyEmbedFailure(vllmNew, new Error("The operation was aborted due to timeout")).params.reason, "timeout");
});

test("diagnose: a missing model comes with the server's model list", async () => {
  const exc = new ProviderHttpError(404, JSON.stringify({ error: { message: "The model `Qwen3-Embedding-0.6B` does not exist." } }), "http://vllm.test/v1/embeddings");
  const d = await diagnoseEmbedFailure(vllmOld, exc);
  assert.deepEqual(d.params.available, ["qwen3-embedding-4b"]);
  assert.equal(d.params.listing_ok, true);
  assert.equal(d.params.account, "vllm");
});

test("dimsIssue: says whether `dimensions` was sent and whether the model can truncate", () => {
  assert.equal(dimsIssue(vllmNew, 8), null);
  const notSent = dimsIssue({ ...vllmNew, params: { dimensions: 1024 } }, 2560)!;
  assert.equal(notSent.params.send_dimensions, false);
  assert.equal(notSent.params.matryoshka, true);
  assert.equal(notSent.params.returned, 2560);
  const sent = dimsIssue({ ...vllmNew, params: { dimensions: 1024, send_dimensions: true } }, 2560)!;
  assert.equal(sent.params.send_dimensions, true);
  assert.equal(dimsIssue({ ...vllmNew, model: "bge-large-zh", params: { dimensions: 512 } }, 1024)!.params.matryoshka, false);
});

test("probeEmbedding: vLLM rejecting `dimensions` is caught as a size problem, not a silent success", async () => {
  const p = await probeEmbedding({ ...vllmNew, params: { dimensions: 8, send_dimensions: true } }, ["x"]);
  assert.equal(p.ok, false);
  assert.equal(p.returned_dims, 12);
  assert.equal(p.issue?.code, "embedding_dims_unsupported");
  assert.ok(calls.includes("vllm:qwen3-embedding-4b@8") && calls.includes("vllm:qwen3-embedding-4b"), calls.join(","));
});

test("errorFields: coded errors keep their code; raw transport errors still get one; 404-model detail is not a URL problem", () => {
  const coded = new CodedProfileError("x", "embedding_model_change_requires_switch", { a: 1 }, 409);
  assert.deepEqual(errorFields(coded), { code: "embedding_model_change_requires_switch", params: { a: 1 } });
  const raw = errorFields(new ProviderHttpError(404, JSON.stringify({ error: { message: "The model `Qwen3-Embedding-0.6B` does not exist." } }), "http://vllm.test/v1/embeddings"));
  assert.equal(raw.code, "endpoint_failed");
  assert.equal((raw.params as { reason: string }).reason, "model_not_found");
  assert.deepEqual(errorFields(new Error("something odd")), {});
  assert.equal(classifyLlmMessage("Embedding test failed: HTTP 404: The model `x` does not exist.")?.params.reason, "model_not_found");
});

test("re-index estimate scales with the vector count", () => {
  assert.deepEqual(estimateReindexMinutes(0), { low: 0, high: 0 });
  const e = estimateReindexMinutes(550_000);
  assert.ok(e.low >= 40 && e.high <= 140 && e.low < e.high, JSON.stringify(e));
  assert.equal(PROBE_TEXTS.length, 6);
});
