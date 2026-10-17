/**
 * Asia-hosted provider adapters against a fake fetch: URL shape, auth,
 * thinking switches, sampling suppression, embeddings and truncation.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { ADAPTERS, dashscope, minimax, moonshot, siliconflow, volcengine, withTransientRetry, zhipu } from "./asia.js";
import { fakeCtx, profile } from "./testUtil.js";
import type { CallContext } from "./types.js";

const chatOk = (content: string, extra: Record<string, unknown> = {}, finish = "stop") => ({
  choices: [{ message: { content, ...extra }, finish_reason: finish }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
});

const req = { messages: [{ role: "user", content: "Return JSON" }], maxTokens: 100, json: true };
const plainReq = { messages: [{ role: "user", content: "Extract the fields." }], maxTokens: 100, json: true };

test("asia: adapter order, ids, category and unique param keys", () => {
  assert.deepEqual(
    ADAPTERS.map((a) => a.spec.id),
    ["siliconflow", "dashscope", "moonshot", "zhipu", "volcengine", "minimax"],
  );
  for (const a of ADAPTERS) {
    assert.equal(a.spec.category, "asia");
    const keys = a.spec.params.map((x) => x.key);
    assert.equal(new Set(keys).size, keys.length, `${a.spec.id}: duplicate param keys`);
    for (const forbidden of ["max_tokens", "max_token_budget", "timeout_ms", "rpm", "tpm", "dimensions"]) {
      assert.ok(!keys.includes(forbidden), `${a.spec.id}: UI-owned key ${forbidden}`);
    }
    assert.equal(Boolean(a.embed), a.spec.roles.includes("embedding"), `${a.spec.id}: embed ↔ role`);
  }
});

// ── SiliconFlow ─────────────────────────────────────────────────────────────

test("siliconflow: default intl URL, bearer, enable_thinking/budget/top_k/min_p", async () => {
  const { ctx, calls } = fakeCtx([200, chatOk("{}", { reasoning_content: "abc" })]);
  const r = await siliconflow.chat!(
    profile("siliconflow", "Qwen/Qwen3-32B", { enable_thinking: "on", thinking_budget: 2048, top_k: 20, min_p: 0, temperature: 0.1 }),
    req,
    ctx,
  );
  assert.equal(calls[0].url, "https://api.siliconflow.com/v1/chat/completions");
  assert.equal(calls[0].headers.Authorization, "Bearer k");
  const b = calls[0].body!;
  assert.equal(b.enable_thinking, true);
  assert.equal(b.thinking_budget, 2048);
  assert.equal(b.top_k, 20);
  assert.equal(b.min_p, 0);
  assert.equal(b.temperature, 0.1);
  assert.equal(b.max_tokens, 100);
  assert.deepEqual(b.response_format, { type: "json_object" });
  assert.equal(r.reasoningChars, 3);
});

test("siliconflow: thinking off sends false and no budget; min_p only for Qwen3; effort only for DeepSeek-V4", async () => {
  const { ctx, calls } = fakeCtx([200, chatOk("{}")], [200, chatOk("{}")]);
  await siliconflow.chat!(
    profile("siliconflow", "deepseek-ai/DeepSeek-V4", { enable_thinking: "off", thinking_budget: 512, min_p: 0.05, reasoning_effort: "max" }),
    req,
    ctx,
  );
  const b = calls[0].body!;
  assert.equal(b.enable_thinking, false);
  assert.ok(!("thinking_budget" in b));
  assert.ok(!("min_p" in b));
  assert.ok(!("reasoning_effort" in b), "no effort when thinking is off");
  await siliconflow.chat!(profile("siliconflow", "deepseek-ai/DeepSeek-V4", { reasoning_effort: "max" }), req, ctx);
  assert.equal(calls[1].body!.reasoning_effort, "max");
  assert.ok(!("enable_thinking" in calls[1].body!));
});

test("siliconflow: legacy base URL ending in /embeddings works for chat and embed", async () => {
  const legacy = { base_url: "https://api.siliconflow.com/v1/embeddings" };
  const { ctx, calls } = fakeCtx([200, chatOk("{}")], [200, { data: [{ index: 0, embedding: [1] }] }]);
  await siliconflow.chat!(profile("siliconflow", "Qwen/Qwen3-32B", {}, legacy), req, ctx);
  await siliconflow.embed!(profile("siliconflow", "Qwen/Qwen3-Embedding-8B", {}, legacy), { texts: ["a"], inputType: "query", dimensions: 1024 }, ctx);
  assert.equal(calls[0].url, "https://api.siliconflow.com/v1/chat/completions");
  assert.equal(calls[1].url, "https://api.siliconflow.com/v1/embeddings");
  const cn = fakeCtx([200, chatOk("{}")]);
  await siliconflow.chat!(profile("siliconflow", "m", {}, { base_url: "https://api.siliconflow.cn/v1/chat/completions/" }), req, cn.ctx);
  assert.equal(cn.calls[0].url, "https://api.siliconflow.cn/v1/chat/completions");
});

test("siliconflow embeddings: dimensions only for Qwen3-Embedding, batches of 32", async () => {
  const batch = (n: number) => ({ data: Array.from({ length: n }, (_, i) => ({ index: i, embedding: [i] })) });
  const { ctx, calls } = fakeCtx([200, batch(32)], [200, batch(8)], [200, batch(1)]);
  const texts = Array.from({ length: 40 }, (_, i) => `t${i}`);
  const v = await siliconflow.embed!(profile("siliconflow", "Qwen/Qwen3-Embedding-8B"), { texts, inputType: "document", dimensions: 1024 }, ctx);
  assert.equal(calls.length, 2);
  assert.equal((calls[0].body!.input as string[]).length, 32);
  assert.equal((calls[1].body!.input as string[]).length, 8);
  assert.equal(calls[0].body!.dimensions, 1024);
  assert.equal(v.length, 40);
  await siliconflow.embed!(profile("siliconflow", "BAAI/bge-m3"), { texts: ["a"], inputType: "document", dimensions: 1024 }, ctx);
  assert.ok(!("dimensions" in calls[2].body!));
});

test("siliconflow embeddings: transient network failures are retried, HTTP errors are not", async () => {
  let n = 0;
  const flaky: CallContext = {
    fetch: async () => {
      n += 1;
      if (n <= 2) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
      return new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.5] }] }), { status: 200 });
    },
  };
  const v = await siliconflow.embed!(profile("siliconflow", "Qwen/Qwen3-Embedding-0.6B"), { texts: ["a"], inputType: "query", dimensions: 1024 }, flaky);
  assert.equal(n, 3);
  assert.deepEqual(v, [[0.5]]);

  let m = 0;
  const failing = withTransientRetry({ fetch: async () => { m += 1; throw new Error("boom"); } }, 3, 1);
  await assert.rejects(failing.fetch("u", {}), /boom/);
  assert.equal(m, 1, "non-transient errors are not retried");

  const { ctx, calls } = fakeCtx([503, { code: 50505, message: "overloaded" }]);
  await assert.rejects(siliconflow.embed!(profile("siliconflow", "Qwen/Qwen3-Embedding-0.6B"), { texts: ["a"], inputType: "query", dimensions: 1024 }, ctx));
  assert.equal(calls.length, 1);
});

test("siliconflow listModels: type/sub_type query per role", async () => {
  const { ctx, calls } = fakeCtx([200, { data: [{ id: "b" }, { id: "a" }] }], [200, { data: [{ id: "e" }] }]);
  assert.deepEqual(await siliconflow.listModels!(profile("siliconflow", ""), "analysis", ctx), ["a", "b"]);
  await siliconflow.listModels!(profile("siliconflow", ""), "embedding", ctx);
  assert.equal(calls[0].url, "https://api.siliconflow.com/v1/models?type=text&sub_type=chat");
  assert.equal(calls[1].url, "https://api.siliconflow.com/v1/models?type=text&sub_type=embedding");
});

// ── DashScope ───────────────────────────────────────────────────────────────

test("dashscope: compatible-mode root, json keyword injected, thinking fields, max_completion_tokens", async () => {
  const { ctx, calls } = fakeCtx([200, chatOk("{}")]);
  await dashscope.chat!(profile("dashscope", "qwen-plus", { enable_thinking: "off", thinking_budget: 1000 }), plainReq, ctx);
  assert.equal(calls[0].url, "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions");
  assert.equal(calls[0].headers.Authorization, "Bearer k");
  const b = calls[0].body!;
  const msgs = b.messages as { role: string; content: string }[];
  assert.ok(msgs.some((m) => /json/i.test(m.content)), "a message must mention json");
  assert.equal(b.enable_thinking, false);
  assert.ok(!("thinking_budget" in b), "no budget when thinking is off");
  assert.equal(b.max_completion_tokens, 100);
  assert.ok(!("max_tokens" in b));
});

test("dashscope: workspace host gets /compatible-mode/v1; budget not sent to kimi-k3", async () => {
  const { ctx, calls } = fakeCtx([200, chatOk("{}")], [200, chatOk("{}")]);
  await dashscope.chat!(
    profile("dashscope", "qwen3.7-plus", { enable_thinking: "on", thinking_budget: 4000 }, { base_url: "https://ws1.us-east-1.maas.aliyuncs.com" }),
    req,
    ctx,
  );
  assert.equal(calls[0].url, "https://ws1.us-east-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions");
  assert.equal(calls[0].body!.thinking_budget, 4000);
  await dashscope.chat!(profile("dashscope", "kimi-k3", { thinking_budget: 4000 }, { base_url: "https://dashscope.aliyuncs.com/api/v1" }), req, ctx);
  assert.equal(calls[1].url, "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions");
  assert.ok(!("thinking_budget" in calls[1].body!));
});

test("dashscope embeddings: text-embedding-v4 dimensions, batches of 10", async () => {
  const batch = (n: number) => ({ data: Array.from({ length: n }, (_, i) => ({ index: i, embedding: [i] })) });
  const { ctx, calls } = fakeCtx([200, batch(10)], [200, batch(2)]);
  const texts = Array.from({ length: 12 }, (_, i) => `t${i}`);
  const v = await dashscope.embed!(profile("dashscope", "text-embedding-v4"), { texts, inputType: "document", dimensions: 1024 }, ctx);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/embeddings");
  assert.equal(calls[0].body!.dimensions, 1024);
  assert.equal(v.length, 12);
});

test("dashscope listModels: native catalogue, filtered per role", async () => {
  const output = {
    output: {
      models: [
        { model: "qwen-plus", capabilities: ["TG"] },
        { model: "text-embedding-v4", capabilities: ["TE"] },
        { model: "wanx2.1-t2i", capabilities: ["IG"] },
      ],
    },
  };
  const { ctx, calls } = fakeCtx([200, output], [200, output]);
  assert.deepEqual(await dashscope.listModels!(profile("dashscope", ""), "analysis", ctx), ["qwen-plus"]);
  assert.deepEqual(await dashscope.listModels!(profile("dashscope", ""), "embedding", ctx), ["text-embedding-v4"]);
  assert.equal(calls[0].url, "https://dashscope-intl.aliyuncs.com/api/v1/models?page_no=1&page_size=100");
});

// ── Moonshot ────────────────────────────────────────────────────────────────

test("moonshot: fixed sampling never sent for current Kimi models; thinking for k2.6", async () => {
  const { ctx, calls } = fakeCtx([200, chatOk("{}")], [200, chatOk("{}")]);
  await moonshot.chat!(profile("moonshot", "kimi-k2.6", { thinking: "off", temperature: 0.2, top_p: 0.5, reasoning_effort: "low" }), req, ctx);
  assert.equal(calls[0].url, "https://api.moonshot.ai/v1/chat/completions");
  assert.equal(calls[0].headers.Authorization, "Bearer k");
  const b = calls[0].body!;
  assert.ok(!("temperature" in b));
  assert.ok(!("top_p" in b));
  assert.deepEqual(b.thinking, { type: "disabled" });
  assert.ok(!("reasoning_effort" in b), "effort is k3-only");
  assert.equal(b.max_completion_tokens, 100);
  await moonshot.chat!(profile("moonshot", "kimi-k3", { thinking: "off", reasoning_effort: "low", temperature: 0.2 }, { base_url: "https://api.moonshot.cn" }), req, ctx);
  assert.equal(calls[1].url, "https://api.moonshot.cn/v1/chat/completions");
  assert.equal(calls[1].body!.reasoning_effort, "low");
  assert.ok(!("thinking" in calls[1].body!), "k3 takes no thinking object");
  assert.ok(!("temperature" in calls[1].body!));
});

// ── Zhipu ───────────────────────────────────────────────────────────────────

test("zhipu: /v4 root kept, thinking object, effort for GLM-5.2+, max_tokens capped", async () => {
  const { ctx, calls } = fakeCtx([200, chatOk("{}")], [200, chatOk("{}")]);
  await zhipu.chat!(profile("zhipu", "glm-5.2", { thinking: "off", reasoning_effort: "low" }), { ...req, maxTokens: 500_000 }, ctx);
  assert.equal(calls[0].url, "https://api.z.ai/api/paas/v4/chat/completions");
  assert.equal(calls[0].headers.Authorization, "Bearer k");
  const b = calls[0].body!;
  assert.deepEqual(b.thinking, { type: "disabled" });
  assert.equal(b.reasoning_effort, "low");
  assert.equal(b.max_tokens, 131072);
  assert.deepEqual(b.response_format, { type: "json_object" });
  await zhipu.chat!(profile("zhipu", "glm-4.7", { reasoning_effort: "low" }, { base_url: "https://open.bigmodel.cn" }), req, ctx);
  assert.equal(calls[1].url, "https://open.bigmodel.cn/api/paas/v4/chat/completions");
  assert.ok(!("reasoning_effort" in calls[1].body!));
});

test("zhipu: model_context_window_exceeded counts as truncation", async () => {
  const { ctx } = fakeCtx([200, chatOk('{"a":', {}, "model_context_window_exceeded")]);
  const r = await zhipu.chat!(profile("zhipu", "glm-5.3"), req, ctx);
  assert.equal(r.truncated, true);
});

test("zhipu embeddings: embedding-3 dims, batches of 64; embedding-2 fixed", async () => {
  const batch = (n: number) => ({ data: Array.from({ length: n }, (_, i) => ({ index: i, embedding: [i] })) });
  const { ctx, calls } = fakeCtx([200, batch(64)], [200, batch(6)], [200, batch(1)]);
  const texts = Array.from({ length: 70 }, (_, i) => `t${i}`);
  await zhipu.embed!(profile("zhipu", "embedding-3", {}, { base_url: "https://open.bigmodel.cn/api/paas/v4" }), { texts, inputType: "document", dimensions: 1024 }, ctx);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://open.bigmodel.cn/api/paas/v4/embeddings");
  assert.equal(calls[0].body!.dimensions, 1024);
  await zhipu.embed!(profile("zhipu", "embedding-2"), { texts: ["a"], inputType: "document", dimensions: 1024 }, ctx);
  assert.ok(!("dimensions" in calls[2].body!));
});

// ── Volcengine ──────────────────────────────────────────────────────────────

test("volcengine: /api/v3 root, thinking type, one token field only, fixed sampling for seed-2.0", async () => {
  const { ctx, calls } = fakeCtx([200, chatOk("{}")], [200, chatOk("{}")]);
  await volcengine.chat!(
    profile("volcengine", "doubao-seed-2-0-pro-260215", { thinking: "disabled", reasoning_effort: "low", temperature: 0.3 }),
    req,
    ctx,
  );
  assert.equal(calls[0].url, "https://ark.cn-beijing.volces.com/api/v3/chat/completions");
  assert.equal(calls[0].headers.Authorization, "Bearer k");
  const b = calls[0].body!;
  assert.deepEqual(b.thinking, { type: "disabled" });
  assert.ok(!("reasoning_effort" in b), "effort never sent with thinking disabled");
  assert.ok(!("temperature" in b));
  assert.equal(b.max_tokens, 100);
  assert.ok(!("max_completion_tokens" in b));
  await volcengine.chat!(profile("volcengine", "ep-123", { thinking: "auto", reasoning_effort: "high", temperature: 0.3 }, { base_url: "https://ark.ap-southeast.bytepluses.com" }), req, ctx);
  assert.equal(calls[1].url, "https://ark.ap-southeast.bytepluses.com/api/v3/chat/completions");
  assert.deepEqual(calls[1].body!.thinking, { type: "auto" });
  assert.equal(calls[1].body!.reasoning_effort, "high");
  assert.equal(calls[1].body!.temperature, 0.3);
});

test("volcengine: a demand for max_completion_tokens swaps the field instead of sending both", async () => {
  const { ctx, calls } = fakeCtx([400, { error: { message: "please use max_completion_tokens for this model" } }], [200, chatOk("{}")]);
  await volcengine.chat!(profile("volcengine", "doubao-seed-x"), req, ctx);
  assert.equal(calls[1].body!.max_completion_tokens, 100);
  assert.ok(!("max_tokens" in calls[1].body!));
});

// ── MiniMax ─────────────────────────────────────────────────────────────────

test("minimax: no response_format, reasoning_split, thinking off only on M3, empty reply = truncated", async () => {
  const { ctx, calls } = fakeCtx([200, chatOk("", { reasoning_content: "thinking..." }, "length")], [200, chatOk("<think>x</think>{}")]);
  const r = await minimax.chat!(profile("minimax", "MiniMax-M3", { thinking: "off" }), req, ctx);
  assert.equal(calls[0].url, "https://api.minimax.io/v1/chat/completions");
  assert.equal(calls[0].headers.Authorization, "Bearer k");
  const b = calls[0].body!;
  assert.ok(!("response_format" in b));
  assert.equal(b.reasoning_split, true);
  assert.deepEqual(b.thinking, { type: "disabled" });
  assert.equal(b.max_completion_tokens, 100);
  assert.equal(r.truncated, true);
  const r2 = await minimax.chat!(profile("minimax", "MiniMax-M2.7", { thinking: "off" }, { base_url: "https://api.minimaxi.com/v1" }), req, ctx);
  assert.equal(calls[1].url, "https://api.minimaxi.com/v1/chat/completions");
  assert.ok(!("thinking" in calls[1].body!));
  assert.equal(r2.content, "{}");
  assert.equal(r2.truncated, false);
});
