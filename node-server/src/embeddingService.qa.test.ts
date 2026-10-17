/**
 * QA: EmbeddingService.embedBatch at runtime — short / null / wrong-size vector
 * replies, failover order, the model-switch gate, and DB-down behaviour.
 * Routing reads go to a fake pg pool; providers are a stubbed globalThis.fetch.
 */

process.env.DATABASE_URL ??= "postgresql://qa:qa@127.0.0.1:1/qa";

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { initPool } from "./db.js";
import { EmbeddingService, parseEmbeddingSettings } from "./embeddingService.js";
import { invalidateRoutingCache } from "./admin/llmRouting.js";
import { invalidateSwitchState } from "./admin/embeddingIdentity.js";
import { isCoolingDown, resetBreakers, type LlmProfile } from "./admin/llmProfiles.js";
import { resetAll } from "./rateLimiter.js";
import { openAiCompatEmbed } from "./providers/openaiCompat.js";

// ── fake DB: one embedding route [m1 on h1, m2 on h2] ────────────────────────
const state = { switching: false, dbDown: false };
const pool = initPool();
(pool as unknown as { query: unknown }).query = async (sql: string) => {
  if (state.dbDown) throw new Error("connect ECONNREFUSED 127.0.0.1:5432");
  if (/CREATE TABLE/.test(sql)) return { rows: [] };
  if (/SELECT state FROM admin\.embedding_identity/.test(sql)) return { rows: state.switching ? [{ state: "switching" }] : [{ state: "active" }] };
  if (/FROM admin\.llm_providers/.test(sql))
    return {
      rows: [1, 2].map((id) => ({
        id: String(id), name: `h${id}`, provider: "openai_compatible", base_url: `http://h${id}.test/v1`, auth_type: "none", api_key: "",
        enabled: true, params: {}, oauth: null, last_test: null, created_at: new Date(0), updated_at: new Date(0),
      })),
    };
  if (/FROM admin\.llm_routes/.test(sql)) return { rows: [{ id: "1", name: "emb", kind: "embedding", strategy: "fallback", description: "", updated_at: new Date(0) }] };
  if (/FROM admin\.llm_route_members/.test(sql))
    return {
      rows: [1, 2].map((n) => ({
        id: String(n), route_id: "1", member_type: "model", provider_id: String(n), model: "qwen3-embedding", child_route_id: null, weight: 1, enabled: true, params: { dimensions: 4 },
      })),
    };
  if (/FROM admin\.llm_role_routes/.test(sql)) return { rows: [{ role: "embedding", route_id: "1" }] };
  return { rows: [] };
};

const realFetch = globalThis.fetch;
type Reply = (texts: string[]) => Response;
const hosts: string[] = [];
function stub(byHost: Record<string, Reply>): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const host = new URL(String(input)).host;
    hosts.push(host);
    const body = JSON.parse(String(init?.body)) as { input: string[] };
    return byHost[host](body.input);
  }) as typeof fetch;
}
const vec = (seed: number, dims = 4) => Array.from({ length: dims }, (_, i) => seed + i / 10);
const okReply = (dims = 4): Reply => (texts) =>
  new Response(JSON.stringify({ data: texts.map((_, i) => ({ index: i, embedding: vec(i, dims) })) }), { status: 200 });

function leaf(id: number): LlmProfile {
  return { id, kind: "embedding", name: `h${id} · qwen3-embedding`, provider: "openai_compatible", base_url: `http://h${id}.test/v1`, api_key: "", model: "qwen3-embedding", enabled: true, priority: id, weight: 1, params: { dimensions: 4 } };
}
const svc = () => new EmbeddingService(parseEmbeddingSettings(new Map()), [leaf(1), leaf(2)]);

beforeEach(() => {
  state.switching = false;
  state.dbDown = false;
  hosts.length = 0;
  invalidateRoutingCache();
  invalidateSwitchState();
  resetBreakers();
  resetAll();
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("failover: h1 500 → h2 answers; h1 reported to the breaker", async () => {
  stub({ "h1.test": () => new Response("down", { status: 500 }), "h2.test": okReply() });
  const s = svc();
  const out = await s.embedBatch(["a", "b"]);
  assert.deepEqual(hosts, ["h1.test", "h2.test"]);
  assert.equal(out.length, 2);
  assert.ok(out.every((v) => v && v.length === 4));
  assert.equal(s.available, true);
});

test("all profiles fail → every item null, available=false (fail open)", async () => {
  stub({ "h1.test": () => new Response("x", { status: 500 }), "h2.test": () => new Response("y", { status: 502 }) });
  const s = svc();
  assert.deepEqual(await s.embedBatch(["a", "b"]), [null, null]);
  assert.equal(s.available, false);
});

test("three failing batches trip h1; next batch starts on h2", async () => {
  stub({ "h1.test": () => new Response("x", { status: 500 }), "h2.test": okReply() });
  const s = svc();
  for (let i = 0; i < 3; i += 1) await s.embedBatch(["a"]);
  assert.equal(isCoolingDown(1), true);
  hosts.length = 0;
  await s.embedBatch(["a"]);
  assert.deepEqual(hosts, ["h2.test"]);
});

test(
  "a provider that returns fewer vectors than texts should fail over (or be retried), not be reported as success",
  async () => {
    stub({
      "h1.test": (texts) => new Response(JSON.stringify({ data: texts.slice(0, 1).map((_, i) => ({ index: i, embedding: vec(i) })) }), { status: 200 }),
      "h2.test": okReply(),
    });
    const out = await svc().embedBatch(["a", "b", "c"]);
    assert.ok(out.every((v) => v !== null), `got ${out.map((v) => (v ? "vec" : "null")).join(",")}`);
  },
);

test(
  "dropped item in the middle must not shift later vectors onto the wrong text (index is honoured)",
  async () => {
    stub({
      "h1.test": (texts) =>
        new Response(JSON.stringify({ data: texts.map((_, i) => ({ index: i, embedding: vec(i * 100) })).filter((d) => d.index !== 1) }), { status: 200 }),
    });
    const out = await svc().embedBatch(["t0", "t1", "t2"]);
    assert.equal(out[1], null, `text 1 got vector ${JSON.stringify(out[1])} (that is text 2's)`);
    assert.deepEqual(out[2], vec(200));
  },
);

test(
  "openAiCompatEmbed with batchLimit — a short sub-batch shifts every later sub-batch",
  async () => {
    let call = 0;
    const ctx = {
      fetch: async (_url: string, init: RequestInit) => {
        call += 1;
        const { input } = JSON.parse(String(init.body)) as { input: string[] };
        const data = input.map((t, i) => ({ index: i, embedding: [Number(t)] }));
        return new Response(JSON.stringify({ data: call === 1 ? data.slice(0, 1) : data }), { status: 200 });
      },
    };
    const out = await openAiCompatEmbed(leaf(1), { texts: ["0", "1", "2", "3"], inputType: "document", dimensions: 1 }, ctx, {
      root: () => "http://x/v1",
      headers: () => ({}),
      embeddings: { batchLimit: 2 },
    });
    assert.deepEqual(out, [[0], null, [2], [3]], `got ${JSON.stringify(out)}`);
  },
);

test("null vectors in the reply stay null (no crash), other items kept", async () => {
  stub({
    "h1.test": () => new Response(JSON.stringify({ data: [{ index: 0, embedding: null }, { index: 1, embedding: vec(1) }] }), { status: 200 }),
  });
  const out = await svc().embedBatch(["a", "b"]);
  assert.equal(out[0], null);
  assert.deepEqual(out[1], vec(1));
});

test(
  "a vector of the wrong dimension (provider ignored `dimensions`) is rejected before it reaches pgvector",
  async () => {
    stub({ "h1.test": okReply(8), "h2.test": okReply(4) });
    const out = await svc().embedBatch(["a"]);
    assert.ok(out[0] === null || out[0].length === 4, `got ${out[0]?.length}-d vector, configured 4`);
  },
);

test(
  "while a model switch is in progress embedBatch must not call any endpoint",
  async () => {
    state.switching = true;
    stub({ "h1.test": okReply(), "h2.test": okReply() });
    const out = await svc().embedBatch(["a"]);
    assert.deepEqual(hosts, [], `called ${hosts.join(",")} during the switch`);
    assert.deepEqual(out, [null]);
  },
);

test(
  "DB unreachable while resolving candidates → embedBatch should fail open to nulls (keyword-only), not throw",
  async () => {
    state.dbDown = true;
    stub({ "h1.test": okReply(), "h2.test": okReply() });
    const out = await svc().embedBatch(["a"]).catch((e: Error) => `threw: ${e.message}`);
    assert.deepEqual(out, [null]);
  },
);

test("empty input / disabled service short-circuit without any call", async () => {
  stub({});
  assert.deepEqual(await svc().embedBatch([]), []);
  assert.deepEqual(await new EmbeddingService(parseEmbeddingSettings(new Map()), []).embedBatch(["a"]), [null]);
  assert.deepEqual(hosts, []);
});
