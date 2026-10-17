/**
 * Mistral, Cohere, Voyage and Jina adapters against a fake fetch: exact
 * requests (URLs, headers, bodies, batching) and reply parsing.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { ADAPTERS, cohere, estimateTokens, jina, mistral, planBatches, voyage, voyageTokenCap } from "./cloudSpecialist.js";
import { getAdapter } from "./registry.js";
import { fakeCtx, profile } from "./testUtil.js";

const req = { messages: [{ role: "system", content: "Return JSON" }, { role: "user", content: "hi" }], maxTokens: 100, json: true };

const mistralOk = (content: unknown, finish = "stop") => ({
  choices: [{ message: { role: "assistant", content }, finish_reason: finish }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});

const embData = (...vecs: number[][]) => ({ data: vecs.map((embedding, index) => ({ index, embedding })) });

test("registry: the four adapters, in order, resolvable by id", () => {
  assert.deepEqual(
    ADAPTERS.map((a) => a.spec.id),
    ["mistral", "cohere", "voyage", "jina"],
  );
  for (const id of ["mistral", "cohere", "voyage", "jina"]) assert.equal(getAdapter(id)?.spec.id, id);
  assert.deepEqual(voyage.spec.roles, ["embedding"]);
  assert.deepEqual(jina.spec.roles, ["embedding"]);
  for (const a of ADAPTERS) {
    for (const k of a.spec.params.map((p) => p.key)) {
      assert.ok(!["max_tokens", "max_token_budget", "timeout_ms", "rpm", "tpm", "dimensions"].includes(k), `${a.spec.id}: UI-owned key ${k}`);
    }
  }
});

// --- Mistral -----------------------------------------------------------------

test("mistral: fixed URL, max_tokens, reasoning_effort, random_seed, json_object", async () => {
  const { ctx, calls } = fakeCtx([200, mistralOk('{"ok":true}')]);
  const r = await mistral.chat!(
    profile("mistral", "mistral-medium-3-5", { reasoning_effort: "none", random_seed: 7, temperature: 0.1 }),
    req,
    ctx,
  );
  assert.equal(calls[0].url, "https://api.mistral.ai/v1/chat/completions");
  assert.equal(calls[0].headers.Authorization, "Bearer k");
  const b = calls[0].body!;
  assert.equal(b.max_tokens, 100);
  assert.ok(!("max_completion_tokens" in b));
  assert.equal(b.reasoning_effort, "none");
  assert.equal(b.random_seed, 7);
  assert.ok(!("seed" in b));
  assert.equal(b.temperature, 0.1);
  assert.deepEqual(b.response_format, { type: "json_object" });
  assert.equal(r.content, '{"ok":true}');
  assert.equal(r.truncated, false);
  assert.equal(r.usage.promptTokens, 10);
  assert.equal(r.usage.reasoningTokens, null);
});

test("mistral: reasoning_effort not sent to non-reasoning models", async () => {
  const { ctx, calls } = fakeCtx([200, mistralOk("{}")]);
  await mistral.chat!(profile("mistral", "ministral-8b-latest", { reasoning_effort: "high" }), req, ctx);
  assert.ok(!("reasoning_effort" in calls[0].body!));
});

test("mistral: thinking/text chunk list parsed; thinking counted as reasoning", async () => {
  const content = [
    { type: "thinking", thinking: [{ type: "text", text: "let me think" }], closed: true },
    { type: "text", text: '{"a":1}' },
  ];
  const { ctx } = fakeCtx([200, mistralOk(content)]);
  const r = await mistral.chat!(profile("mistral", "mistral-small-latest", { reasoning_effort: "high" }), req, ctx);
  assert.equal(r.content, '{"a":1}');
  assert.equal(r.reasoningChars, "let me think".length);
});

test("mistral: length and model_length mean truncated", async () => {
  for (const finish of ["length", "model_length"]) {
    const { ctx } = fakeCtx([200, mistralOk('{"a":', finish)]);
    const r = await mistral.chat!(profile("mistral", "mistral-large-4-0"), req, ctx);
    assert.equal(r.truncated, true, finish);
    assert.equal(r.finishReason, finish);
  }
});

test("mistral: rejected random_seed (422 detail) is dropped and retried", async () => {
  const { ctx, calls } = fakeCtx(
    [422, { detail: [{ loc: ["body", "random_seed"], msg: "Extra inputs are not permitted", type: "extra_forbidden" }] }],
    [200, mistralOk("{}")],
  );
  const r = await mistral.chat!(profile("mistral", "mistral-large-4-0", { random_seed: 1 }), req, ctx);
  assert.equal(calls.length, 2);
  assert.ok(!("random_seed" in calls[1].body!));
  assert.deepEqual(r.droppedParams, ["random_seed"]);
});

test("mistral embeddings: no size knob for mistral-embed; output_dimension for codestral-embed", async () => {
  const { ctx, calls } = fakeCtx([200, embData([1], [2])], [200, embData([3])]);
  const v = await mistral.embed!(profile("mistral", "mistral-embed"), { texts: ["a", "b"], inputType: "query", dimensions: 1024 }, ctx);
  assert.equal(calls[0].url, "https://api.mistral.ai/v1/embeddings");
  assert.deepEqual(v, [[1], [2]]);
  assert.ok(!("output_dimension" in calls[0].body!));
  assert.ok(!("dimensions" in calls[0].body!));
  assert.ok(!("input_type" in calls[0].body!));
  await mistral.embed!(profile("mistral", "codestral-embed"), { texts: ["c"], inputType: "document", dimensions: 1024 }, ctx);
  assert.equal(calls[1].body!.output_dimension, 1024);
  assert.equal(calls[1].body!.output_dtype, "float");
});

test("mistral embeddings: split at 128 items", async () => {
  const texts = Array.from({ length: 130 }, (_, i) => `t${i}`);
  const { ctx, calls } = fakeCtx(
    [200, embData(...Array.from({ length: 128 }, () => [0]))],
    [200, embData([1], [1])],
  );
  const v = await mistral.embed!(profile("mistral", "mistral-embed"), { texts, inputType: "document", dimensions: 1024 }, ctx);
  assert.equal(calls.length, 2);
  assert.equal((calls[0].body!.input as string[]).length, 128);
  assert.equal((calls[1].body!.input as string[]).length, 2);
  assert.equal(v.length, 130);
});

test("mistral listModels: capabilities split chat vs embedding, deprecated dropped", async () => {
  const listing = {
    data: [
      { id: "mistral-large-4-0", capabilities: { completion_chat: true } },
      { id: "mistral-embed", capabilities: { completion_chat: false } },
      { id: "codestral-embed", capabilities: { completion_chat: false } },
      { id: "mistral-ocr-latest", capabilities: { completion_chat: false, ocr: true } },
      { id: "magistral-small-2509", capabilities: { completion_chat: true }, deprecation: "2026-07-31T00:00:00Z" },
    ],
  };
  const { ctx, calls } = fakeCtx([200, listing], [200, listing]);
  assert.deepEqual(await mistral.listModels!(profile("mistral", ""), "analysis", ctx), ["mistral-large-4-0"]);
  assert.deepEqual(await mistral.listModels!(profile("mistral", ""), "embedding", ctx), ["codestral-embed", "mistral-embed"]);
  assert.equal(calls[0].url, "https://api.mistral.ai/v1/models");
});

// --- Cohere ------------------------------------------------------------------

const cohereOk = (content: unknown, finish = "COMPLETE") => ({
  id: "x",
  finish_reason: finish,
  message: { role: "assistant", content },
  usage: { billed_units: { input_tokens: 9, output_tokens: 4 }, tokens: { input_tokens: 12, output_tokens: 6 } },
});

test("cohere: native /v2/chat body (p, k, json_object, thinking disabled)", async () => {
  const { ctx, calls } = fakeCtx([200, cohereOk([{ type: "text", text: '{"ok":1}' }])]);
  const r = await cohere.chat!(
    profile("cohere", "command-a-reasoning-08-2025", { temperature: 0.1, p: 0.9, k: 40, top_p: 0.5, thinking: "disabled" }),
    req,
    ctx,
  );
  assert.equal(calls[0].url, "https://api.cohere.com/v2/chat");
  assert.equal(calls[0].headers.Authorization, "Bearer k");
  const b = calls[0].body!;
  assert.deepEqual(b.messages, req.messages);
  assert.equal(b.max_tokens, 100);
  assert.equal(b.temperature, 0.1);
  assert.equal(b.p, 0.9);
  assert.equal(b.k, 40);
  assert.ok(!("top_p" in b));
  assert.deepEqual(b.response_format, { type: "json_object" });
  assert.deepEqual(b.thinking, { type: "disabled" });
  assert.equal(r.content, '{"ok":1}');
  assert.deepEqual(r.usage, { promptTokens: 12, completionTokens: 6, reasoningTokens: null });
});

test("cohere: thinking budget only on reasoning models; content array with thinking", async () => {
  const { ctx, calls } = fakeCtx(
    [200, cohereOk([{ type: "thinking", thinking: "step by step" }, { type: "text", text: "{}" }])],
    [200, cohereOk([{ type: "text", text: "{}" }])],
  );
  const r = await cohere.chat!(profile("cohere", "command-a-plus-05-2026", { thinking: "enabled", thinking_token_budget: 2000 }), req, ctx);
  assert.deepEqual(calls[0].body!.thinking, { type: "enabled", token_budget: 2000 });
  assert.equal(r.reasoningChars, "step by step".length);
  await cohere.chat!(profile("cohere", "command-a-03-2025", { thinking: "disabled" }), req, ctx);
  assert.ok(!("thinking" in calls[1].body!));
});

test("cohere: MAX_TOKENS means truncated; billed_units used when tokens absent", async () => {
  const reply = { finish_reason: "MAX_TOKENS", message: { content: [{ type: "text", text: '{"a":' }] }, usage: { billed_units: { input_tokens: 3, output_tokens: 100 } } };
  const { ctx } = fakeCtx([200, reply]);
  const r = await cohere.chat!(profile("cohere", "command-a-03-2025"), { ...req, json: false }, ctx);
  assert.equal(r.truncated, true);
  assert.equal(r.finishReason, "MAX_TOKENS");
  assert.equal(r.usage.completionTokens, 100);
});

test("cohere embed: input_type mapping, embeddings.float, output_dimension only on v4+", async () => {
  const { ctx, calls } = fakeCtx(
    [200, { embeddings: { float: [[1], [2]] } }],
    [200, { embeddings: { float: [[3]] } }],
    [200, { embeddings: { float: [[4]] } }],
  );
  const v = await cohere.embed!(profile("cohere", "embed-v4.0"), { texts: ["a", "b"], inputType: "query", dimensions: 1024 }, ctx);
  assert.equal(calls[0].url, "https://api.cohere.com/v2/embed");
  assert.deepEqual(calls[0].body, {
    model: "embed-v4.0",
    texts: ["a", "b"],
    input_type: "search_query",
    embedding_types: ["float"],
    output_dimension: 1024,
  });
  assert.deepEqual(v, [[1], [2]]);
  await cohere.embed!(profile("cohere", "embed-multilingual-v3.0"), { texts: ["c"], inputType: "document", dimensions: 1024 }, ctx);
  assert.equal(calls[1].body!.input_type, "search_document");
  assert.ok(!("output_dimension" in calls[1].body!));
  await cohere.embed!(profile("cohere", "embed-v5.0-pro"), { texts: ["d"], inputType: "document", dimensions: 512 }, ctx);
  assert.equal(calls[2].body!.output_dimension, 512);
});

test("cohere embed: batches of 96", async () => {
  const texts = Array.from({ length: 200 }, (_, i) => `t${i}`);
  const reply = (n: number) => [200, { embeddings: { float: Array.from({ length: n }, () => [0]) } }] as [number, unknown];
  const { ctx, calls } = fakeCtx(reply(96), reply(96), reply(8));
  const v = await cohere.embed!(profile("cohere", "embed-v4.0"), { texts, inputType: "document", dimensions: 1024 }, ctx);
  assert.deepEqual(
    calls.map((c) => (c.body!.texts as string[]).length),
    [96, 96, 8],
  );
  assert.equal(v.length, 200);
});

test("cohere listModels: endpoint filter, deprecated dropped, pagination", async () => {
  const { ctx, calls } = fakeCtx(
    [200, { models: [{ name: "embed-v4.0" }, { name: "embed-english-v2.0", is_deprecated: true }], next_page_token: "p2" }],
    [200, { models: [{ name: "embed-v5.0-pro" }] }],
  );
  const ids = await cohere.listModels!(profile("cohere", ""), "embedding", ctx);
  assert.deepEqual(ids, ["embed-v4.0", "embed-v5.0-pro"]);
  assert.equal(calls[0].url, "https://api.cohere.com/v1/models?endpoint=embed&page_size=1000");
  assert.equal(calls[1].url, "https://api.cohere.com/v1/models?endpoint=embed&page_size=1000&page_token=p2");
});

// --- Voyage ------------------------------------------------------------------

test("voyage: default URL, input_type, output_dimension on flexible models", async () => {
  const { ctx, calls } = fakeCtx([200, embData([1], [2])], [200, embData([3])]);
  const v = await voyage.embed!(profile("voyage", "voyage-4-large"), { texts: ["a", "b"], inputType: "document", dimensions: 1024 }, ctx);
  assert.equal(calls[0].url, "https://api.voyageai.com/v1/embeddings");
  assert.equal(calls[0].headers.Authorization, "Bearer k");
  assert.deepEqual(calls[0].body, {
    input: ["a", "b"],
    model: "voyage-4-large",
    input_type: "document",
    truncation: true,
    output_dimension: 1024,
    output_dtype: "float",
  });
  assert.deepEqual(v, [[1], [2]]);
  await voyage.embed!(
    profile("voyage", "voyage-multilingual-2", {}, { base_url: "https://eu.ai.mongodb.com/v1/" }),
    { texts: ["q"], inputType: "query", dimensions: 1024 },
    ctx,
  );
  assert.equal(calls[1].url, "https://eu.ai.mongodb.com/v1/embeddings");
  assert.equal(calls[1].body!.input_type, "query");
  assert.ok(!("output_dimension" in calls[1].body!));
});

test("voyage: batches split by item count and by per-model token cap", async () => {
  // 1001 tiny inputs → 1000 + 1.
  const many = Array.from({ length: 1001 }, () => "x");
  const r = (n: number) => [200, embData(...Array.from({ length: n }, () => [0]))] as [number, unknown];
  const a = fakeCtx(r(1000), r(1));
  const v = await voyage.embed!(profile("voyage", "voyage-4-lite"), { texts: many, inputType: "document", dimensions: 1024 }, a.ctx);
  assert.deepEqual(
    a.calls.map((c) => (c.body!.input as string[]).length),
    [1000, 1],
  );
  assert.equal(v.length, 1001);

  // voyage-4-large: 120K cap (×0.9 headroom). 30K-char ASCII ≈ 10K tokens → 10 per batch.
  assert.equal(voyageTokenCap("voyage-4-large"), 120_000);
  const big = Array.from({ length: 25 }, () => "a".repeat(30_000));
  const b = fakeCtx(r(10), r(10), r(5));
  await voyage.embed!(profile("voyage", "voyage-4-large"), { texts: big, inputType: "document", dimensions: 1024 }, b.ctx);
  assert.deepEqual(
    b.calls.map((c) => (c.body!.input as string[]).length),
    [10, 10, 5],
  );
});

test("token estimate counts CJK pessimistically; planBatches keeps order", () => {
  assert.equal(estimateTokens("abcdef"), 2);
  assert.equal(estimateTokens("藥品仿單"), 6);
  assert.deepEqual(planBatches(["a", "b", "c"], 2), [["a", "b"], ["c"]]);
  assert.deepEqual(planBatches(["aaa", "aaa", "aaa"], 10, 2), [["aaa", "aaa"], ["aaa"]]);
});

// --- Jina --------------------------------------------------------------------

test("jina: task, dimensions, embedding_type, truncate for v3/v4/v5", async () => {
  const { ctx, calls } = fakeCtx([200, embData([1])], [200, embData([2])], [200, embData([3])]);
  const v = await jina.embed!(profile("jina", "jina-embeddings-v5-text-small"), { texts: ["q"], inputType: "query", dimensions: 1024 }, ctx);
  assert.equal(calls[0].url, "https://api.jina.ai/v1/embeddings");
  assert.equal(calls[0].headers.Authorization, "Bearer k");
  assert.deepEqual(calls[0].body, {
    model: "jina-embeddings-v5-text-small",
    input: ["q"],
    embedding_type: "float",
    truncate: true,
    task: "retrieval.query",
    dimensions: 1024,
  });
  assert.deepEqual(v, [[1]]);
  await jina.embed!(profile("jina", "jina-embeddings-v3"), { texts: ["d"], inputType: "document", dimensions: 1024 }, ctx);
  assert.equal(calls[1].body!.task, "retrieval.passage");
  // Unknown family (e.g. CLIP): no task / dimensions sent.
  await jina.embed!(profile("jina", "jina-clip-v2"), { texts: ["d"], inputType: "document", dimensions: 1024 }, ctx);
  assert.ok(!("task" in calls[2].body!));
  assert.ok(!("dimensions" in calls[2].body!));
});

test("jina: batches split by item count", async () => {
  const texts = Array.from({ length: 300 }, () => "x");
  const r = (n: number) => [200, embData(...Array.from({ length: n }, () => [0]))] as [number, unknown];
  const { ctx, calls } = fakeCtx(r(256), r(44));
  const v = await jina.embed!(profile("jina", "jina-embeddings-v3"), { texts, inputType: "document", dimensions: 1024 }, ctx);
  assert.deepEqual(
    calls.map((c) => (c.body!.input as string[]).length),
    [256, 44],
  );
  assert.equal(v.length, 300);
});
