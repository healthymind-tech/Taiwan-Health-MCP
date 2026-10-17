/**
 * Anthropic, Gemini and Bedrock adapters against a fake fetch: the exact
 * request each one sends and how replies (truncation, reasoning, refusals,
 * embeddings) are read.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { ADAPTERS, anthropic, bedrock, bedrockControlPlane, gemini } from "./cloudMajor.js";
import { ProviderReplyError } from "./types.js";
import { fakeCtx, profile } from "./testUtil.js";

const req = {
  messages: [
    { role: "system", content: "Extract fields." },
    { role: "system", content: "Reply in JSON." },
    { role: "user", content: "Insert text" },
  ],
  maxTokens: 8000,
  json: true,
};

const norm = (v: number[]) => Math.sqrt(v.reduce((s, x) => s + x * x, 0));

test("ADAPTERS: anthropic, gemini, bedrock in order", () => {
  assert.deepEqual(
    ADAPTERS.map((a) => a.spec.id),
    ["anthropic", "gemini", "bedrock"],
  );
  assert.deepEqual(anthropic.spec.roles, ["analysis"]);
  assert.equal(anthropic.embed, undefined);
  for (const a of ADAPTERS) {
    const keys = a.spec.params.map((p) => p.key);
    assert.equal(new Set(keys).size, keys.length, `${a.spec.id} param keys unique`);
    for (const owned of ["max_tokens", "max_token_budget", "timeout_ms", "rpm", "tpm", "dimensions"]) {
      assert.ok(!keys.includes(owned), `${a.spec.id} must not define ${owned}`);
    }
  }
});

// ── Anthropic ───────────────────────────────────────────────────────────────

const claudeOk = (text: string, extra: Record<string, unknown> = {}) => ({
  type: "message",
  content: [
    { type: "thinking", thinking: "let me see", signature: "s" },
    { type: "text", text },
  ],
  stop_reason: "end_turn",
  usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 5 },
  ...extra,
});

test("anthropic: URL, headers, top-level system, max_tokens, adaptive thinking + effort", async () => {
  const { ctx, calls } = fakeCtx([200, claudeOk('```json\n{"a":1}\n```')]);
  const r = await anthropic.chat!(profile("anthropic", "claude-sonnet-5-5", { thinking: "adaptive", effort: "low" }), req, ctx);
  assert.equal(calls[0].url, "https://api.anthropic.com/v1/messages");
  assert.equal(calls[0].headers["x-api-key"], "k");
  assert.equal(calls[0].headers["anthropic-version"], "2023-06-01");
  assert.ok(!("Authorization" in calls[0].headers), "never send both x-api-key and Bearer");
  assert.deepEqual(calls[0].body, {
    model: "claude-sonnet-5-5",
    max_tokens: 8000,
    system: "Extract fields.\n\nReply in JSON.",
    messages: [{ role: "user", content: "Insert text" }],
    thinking: { type: "adaptive" },
    output_config: { effort: "low" },
  });
  assert.equal(r.content, '{"a":1}');
  assert.equal(r.truncated, false);
  assert.equal(r.reasoningChars, "let me see".length);
  assert.deepEqual(r.usage, { promptTokens: 105, completionTokens: 40, reasoningTokens: null });
});

test("anthropic: nothing optional is sent when params are empty", async () => {
  const { ctx, calls } = fakeCtx([200, claudeOk("{}")]);
  await anthropic.chat!(profile("anthropic", "claude-opus-5-5"), { ...req, messages: [{ role: "user", content: "x" }] }, ctx);
  assert.deepEqual(calls[0].body, { model: "claude-opus-5-5", max_tokens: 8000, messages: [{ role: "user", content: "x" }] });
});

test("anthropic: legacy budget thinking (enabled, clamped below max_tokens)", async () => {
  const { ctx, calls } = fakeCtx([200, claudeOk("{}")], [200, claudeOk("{}")], [200, claudeOk("{}")]);
  await anthropic.chat!(profile("anthropic", "claude-haiku-4-5", { thinking: "enabled", thinking_budget: 2048 }), req, ctx);
  assert.deepEqual(calls[0].body!.thinking, { type: "enabled", budget_tokens: 2048 });
  // budget alone implies enabled; too-large budget is clamped below max_tokens
  await anthropic.chat!(profile("anthropic", "claude-haiku-4-5", { thinking_budget: 50_000 }), req, ctx);
  assert.deepEqual(calls[1].body!.thinking, { type: "enabled", budget_tokens: 7999 });
  await anthropic.chat!(profile("anthropic", "claude-sonnet-5", { thinking: "disabled" }), req, ctx);
  assert.deepEqual(calls[2].body!.thinking, { type: "disabled" });
});

test("anthropic: max_tokens / context window stop reasons are truncation", async () => {
  const { ctx } = fakeCtx(
    [200, claudeOk('{"a":', { stop_reason: "max_tokens" })],
    [200, claudeOk('{"a":', { stop_reason: "model_context_window_exceeded" })],
    [200, { type: "message", content: [{ type: "thinking", thinking: "long" }], stop_reason: "end_turn", usage: {} }],
  );
  const p = profile("anthropic", "claude-sonnet-5-5");
  assert.equal((await anthropic.chat!(p, req, ctx)).truncated, true);
  assert.equal((await anthropic.chat!(p, req, ctx)).truncated, true);
  const empty = await anthropic.chat!(p, req, ctx);
  assert.equal(empty.truncated, true, "empty answer after thinking = budget exhausted");
  assert.equal(empty.reasoningChars, 4);
});

test("anthropic: refusal stop_reason throws ProviderReplyError", async () => {
  const { ctx } = fakeCtx([200, claudeOk("", { stop_reason: "refusal", stop_details: { category: "bio" } })]);
  await assert.rejects(anthropic.chat!(profile("anthropic", "claude-sonnet-5-5"), req, ctx), (e: unknown) => {
    assert.ok(e instanceof ProviderReplyError);
    assert.match(String((e as Error).message), /refused.*bio/);
    return true;
  });
});

test("anthropic: a 400 naming temperature drops it and retries; effort errors drop output_config", async () => {
  const { ctx, calls } = fakeCtx(
    [400, { type: "error", error: { type: "invalid_request_error", message: "`temperature` is not supported for this model." } }],
    [400, { type: "error", error: { type: "invalid_request_error", message: "This model does not support the effort parameter." } }],
    [200, claudeOk("{}")],
  );
  const r = await anthropic.chat!(profile("anthropic", "claude-haiku-4-5", { temperature: 0.1, effort: "low" }), req, ctx);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].body!.temperature, 0.1);
  assert.ok(!("temperature" in calls[1].body!));
  assert.ok(!("output_config" in calls[2].body!));
  assert.deepEqual(r.droppedParams, ["temperature", "effort"]);
});

test("anthropic: rejected thinking.disabled is dropped, not effort", async () => {
  const { ctx, calls } = fakeCtx(
    [400, { type: "error", error: { message: "thinking.type 'disabled' is not supported at this effort level" } }],
    [200, claudeOk("{}")],
  );
  const r = await anthropic.chat!(profile("anthropic", "claude-opus-5-5", { thinking: "disabled", effort: "low" }), req, ctx);
  assert.ok(!("thinking" in calls[1].body!));
  assert.deepEqual(calls[1].body!.output_config, { effort: "low" });
  assert.deepEqual(r.droppedParams, ["thinking"]);
});

test("anthropic: listModels paginates with after_id; no embedding models", async () => {
  const { ctx, calls } = fakeCtx(
    [200, { data: [{ id: "claude-sonnet-5-5" }], has_more: true, last_id: "claude-sonnet-5-5" }],
    [200, { data: [{ id: "claude-haiku-5-5" }], has_more: false, last_id: "claude-haiku-5-5" }],
  );
  const ids = await anthropic.listModels!(profile("anthropic", ""), "analysis", ctx);
  assert.deepEqual(ids, ["claude-haiku-5-5", "claude-sonnet-5-5"]);
  assert.equal(calls[0].url, "https://api.anthropic.com/v1/models?limit=1000");
  assert.equal(calls[1].url, "https://api.anthropic.com/v1/models?limit=1000&after_id=claude-sonnet-5-5");
  assert.deepEqual(await anthropic.listModels!(profile("anthropic", ""), "embedding", ctx), []);
});

// ── Gemini ──────────────────────────────────────────────────────────────────

const geminiOk = (text: string, finishReason = "STOP") => ({
  candidates: [
    {
      content: { role: "model", parts: [{ text: "pondering", thought: true }, { text }] },
      finishReason,
    },
  ],
  usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 20, thoughtsTokenCount: 30 },
});

const GEM = "https://generativelanguage.googleapis.com";

test("gemini: generateContent URL, key header, systemInstruction, roles, JSON mime, thinkingLevel", async () => {
  const { ctx, calls } = fakeCtx([200, geminiOk('{"a":1}')]);
  const r = await gemini.chat!(
    profile(
      "gemini",
      "gemini-3.8-flash",
      { thinking_level: "low", thinking_budget: 1024, temperature: 0.2 },
      { base_url: GEM },
    ),
    { ...req, messages: [...req.messages, { role: "assistant", content: "ok" }, { role: "user", content: "again" }] },
    ctx,
  );
  assert.equal(calls[0].url, `${GEM}/v1beta/models/gemini-3.8-flash:generateContent`);
  assert.equal(calls[0].headers["x-goog-api-key"], "k");
  assert.deepEqual(calls[0].body, {
    systemInstruction: { parts: [{ text: "Extract fields.\n\nReply in JSON." }] },
    contents: [
      { role: "user", parts: [{ text: "Insert text" }] },
      { role: "model", parts: [{ text: "ok" }] },
      { role: "user", parts: [{ text: "again" }] },
    ],
    generationConfig: {
      maxOutputTokens: 8000,
      responseMimeType: "application/json",
      temperature: 0.2,
      thinkingConfig: { thinkingLevel: "low" },
    },
  });
  assert.equal(r.content, '{"a":1}', "thought parts are not content");
  assert.equal(r.reasoningChars, "pondering".length);
  assert.deepEqual(r.usage, { promptTokens: 50, completionTokens: 50, reasoningTokens: 30 });
  assert.equal(r.truncated, false);
});

test("gemini: 2.5 models get thinkingBudget only, never thinkingLevel", async () => {
  const { ctx, calls } = fakeCtx([200, geminiOk("{}")], [200, geminiOk("{}")]);
  await gemini.chat!(profile("gemini", "gemini-2.5-flash", { thinking_level: "high", thinking_budget: 0 }, { base_url: GEM }), req, ctx);
  assert.deepEqual((calls[0].body!.generationConfig as Record<string, unknown>).thinkingConfig, { thinkingBudget: 0 });
  // Gemini 4: budget alone is not sent (level-only family)
  await gemini.chat!(profile("gemini", "gemini-4-argon", { thinking_budget: 2048 }, { base_url: GEM }), req, ctx);
  assert.ok(!("thinkingConfig" in (calls[1].body!.generationConfig as Record<string, unknown>)));
});

test("gemini: default base URL when empty, models/ prefix stripped, Vertex express path", async () => {
  const { ctx, calls } = fakeCtx([200, geminiOk("{}")], [200, geminiOk("{}")]);
  await gemini.chat!(profile("gemini", "models/gemini-3.6-flash"), req, ctx);
  assert.equal(calls[0].url, `${GEM}/v1beta/models/gemini-3.6-flash:generateContent`);
  await gemini.chat!(profile("gemini", "gemini-3.6-flash", {}, { base_url: "https://aiplatform.googleapis.com/" }), req, ctx);
  assert.equal(calls[1].url, "https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-3.6-flash:generateContent");
});

test("gemini: MAX_TOKENS / CONTINUATION are truncation; SAFETY with no text throws", async () => {
  const { ctx } = fakeCtx(
    [200, geminiOk('{"a"', "MAX_TOKENS")],
    [200, geminiOk('{"a"', "CONTINUATION")],
    [200, { candidates: [{ content: { parts: [] }, finishReason: "SAFETY" }] }],
    [200, { promptFeedback: { blockReason: "PROHIBITED_CONTENT" } }],
  );
  const p = profile("gemini", "gemini-3.8-flash", {}, { base_url: GEM });
  assert.equal((await gemini.chat!(p, req, ctx)).truncated, true);
  assert.equal((await gemini.chat!(p, req, ctx)).truncated, true);
  await assert.rejects(gemini.chat!(p, req, ctx), ProviderReplyError);
  await assert.rejects(gemini.chat!(p, req, ctx), /PROHIBITED_CONTENT/);
});

test("gemini: a 400 naming a nested sampling / thinking knob drops it and retries", async () => {
  const { ctx, calls } = fakeCtx(
    [400, { error: { code: 400, message: "Invalid value at 'generation_config.top_k'", status: "INVALID_ARGUMENT" } }],
    [400, { error: { code: 400, message: "Thinking level is not supported for this model.", status: "INVALID_ARGUMENT" } }],
    [200, geminiOk("{}")],
  );
  const r = await gemini.chat!(
    profile("gemini", "gemini-3-flash-preview", { top_k: 40, thinking_level: "minimal" }, { base_url: GEM }),
    req,
    ctx,
  );
  assert.equal(calls.length, 3);
  assert.equal((calls[0].body!.generationConfig as Record<string, unknown>).topK, 40);
  const last = calls[2].body!.generationConfig as Record<string, unknown>;
  assert.ok(!("topK" in last));
  assert.ok(!("thinkingConfig" in last), "empty thinkingConfig is removed");
  assert.deepEqual(r.droppedParams, ["top_k", "thinking_level"]);
});

test("gemini embeddings (001): taskType per input type, outputDimensionality, L2-normalized, batches of 100", async () => {
  const texts = Array.from({ length: 150 }, (_, i) => `t${i}`);
  const vec = (n: number) => ({ embeddings: Array.from({ length: n }, () => ({ values: [3, 4] })) });
  const { ctx, calls } = fakeCtx([200, vec(100)], [200, vec(50)]);
  const out = await gemini.embed!(
    profile("gemini", "gemini-embedding-001", {}, { base_url: GEM }),
    { texts, inputType: "document", dimensions: 1024 },
    ctx,
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, `${GEM}/v1beta/models/gemini-embedding-001:batchEmbedContents`);
  const reqs = calls[0].body!.requests as Record<string, unknown>[];
  assert.equal(reqs.length, 100);
  assert.deepEqual(reqs[0], {
    model: "models/gemini-embedding-001",
    outputDimensionality: 1024,
    content: { parts: [{ text: "t0" }] },
    taskType: "RETRIEVAL_DOCUMENT",
  });
  assert.equal((calls[1].body!.requests as unknown[]).length, 50);
  assert.equal(out.length, 150);
  assert.deepEqual(out[0], [0.6, 0.8]);

  const q = fakeCtx([200, vec(1)]);
  await gemini.embed!(profile("gemini", "gemini-embedding-001", {}, { base_url: GEM }), { texts: ["q"], inputType: "query", dimensions: 1024 }, q.ctx);
  assert.equal((q.calls[0].body!.requests as Record<string, unknown>[])[0].taskType, "RETRIEVAL_QUERY");
});

test("gemini embeddings: native 3072 left as-is; gemini-embedding-2 uses text prefixes, no taskType", async () => {
  const { ctx, calls } = fakeCtx([200, { embeddings: [{ values: [3, 4] }] }], [200, { embeddings: [{ values: [1, 0] }, { values: [0, 1] }] }]);
  const raw = await gemini.embed!(profile("gemini", "gemini-embedding-001", {}, { base_url: GEM }), { texts: ["a"], inputType: "document", dimensions: 3072 }, ctx);
  assert.deepEqual(raw, [[3, 4]]);
  await gemini.embed!(profile("gemini", "gemini-embedding-2", {}, { base_url: GEM }), { texts: ["a", "b"], inputType: "query", dimensions: 768 }, ctx);
  const r0 = (calls[1].body!.requests as Record<string, unknown>[])[0];
  assert.ok(!("taskType" in r0));
  assert.deepEqual(r0.content, { parts: [{ text: "task: search result | query: a" }] });
  const d = fakeCtx([200, { embeddings: [{ values: [1, 0] }] }]);
  await gemini.embed!(profile("gemini", "gemini-embedding-2", {}, { base_url: GEM }), { texts: ["a"], inputType: "document", dimensions: 768 }, d.ctx);
  assert.deepEqual((d.calls[0].body!.requests as Record<string, unknown>[])[0].content, { parts: [{ text: "title: none | text: a" }] });
});

test("gemini: listModels paginates and filters by supportedGenerationMethods", async () => {
  const page1 = {
    models: [
      { name: "models/gemini-3.8-flash", supportedGenerationMethods: ["generateContent", "countTokens"] },
      { name: "models/gemini-embedding-001", supportedGenerationMethods: ["embedContent", "batchEmbedContents"] },
    ],
    nextPageToken: "p2",
  };
  const page2 = { models: [{ name: "models/gemini-4-argon", supportedGenerationMethods: ["generateContent"] }] };
  const { ctx, calls } = fakeCtx([200, page1], [200, page2], [200, page1], [200, page2]);
  assert.deepEqual(await gemini.listModels!(profile("gemini", "", {}, { base_url: GEM }), "analysis", ctx), ["gemini-3.8-flash", "gemini-4-argon"]);
  assert.equal(calls[1].url, `${GEM}/v1beta/models?pageSize=1000&pageToken=p2`);
  assert.deepEqual(await gemini.listModels!(profile("gemini", "", {}, { base_url: GEM }), "embedding", ctx), ["gemini-embedding-001"]);
});

// ── Bedrock ─────────────────────────────────────────────────────────────────

const BR = "https://bedrock-runtime.ap-northeast-1.amazonaws.com";

const converseOk = (text: string, stopReason = "end_turn") => ({
  output: {
    message: {
      role: "assistant",
      content: [{ reasoningContent: { reasoningText: { text: "hmm", signature: "s" } } }, { text }],
    },
  },
  stopReason,
  usage: { inputTokens: 70, outputTokens: 12, totalTokens: 82 },
  metrics: { latencyMs: 900 },
});

test("bedrock: Converse URL (encoded model id), Bearer key, system/messages/inferenceConfig, Claude extras", async () => {
  const { ctx, calls } = fakeCtx([200, converseOk('```json\n{"a":1}\n```')]);
  const model = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
  const r = await bedrock.chat!(
    profile("bedrock", model, { temperature: 0, top_k: 20, thinking: "enabled", thinking_budget: 2048, effort: "low" }, { base_url: BR }),
    req,
    ctx,
  );
  assert.equal(calls[0].url, `${BR}/model/us.anthropic.claude-haiku-4-5-20251001-v1%3A0/converse`);
  assert.equal(calls[0].headers.Authorization, "Bearer k");
  assert.deepEqual(calls[0].body, {
    messages: [{ role: "user", content: [{ text: "Insert text" }] }],
    system: [{ text: "Extract fields.\n\nReply in JSON." }],
    inferenceConfig: { maxTokens: 8000, temperature: 0 },
    additionalModelRequestFields: {
      top_k: 20,
      thinking: { type: "enabled", budget_tokens: 2048 },
      output_config: { effort: "low" },
    },
  });
  assert.equal(r.content, '{"a":1}');
  assert.equal(r.reasoningChars, 3);
  assert.deepEqual(r.usage, { promptTokens: 70, completionTokens: 12, reasoningTokens: null });
  assert.deepEqual(r.diagnostics, { latency_ms: 900 });
});

test("bedrock: non-Claude models never get additionalModelRequestFields", async () => {
  const { ctx, calls } = fakeCtx([200, converseOk("{}")]);
  await bedrock.chat!(profile("bedrock", "openai.gpt-oss-120b-1:0", { top_k: 5, thinking: "adaptive", top_p: 0.9 }, { base_url: BR }), req, ctx);
  assert.ok(!("additionalModelRequestFields" in calls[0].body!));
  assert.deepEqual(calls[0].body!.inferenceConfig, { maxTokens: 8000, topP: 0.9 });
});

test("bedrock: max_tokens / context-window stop reasons are truncation; content_filtered throws", async () => {
  const { ctx } = fakeCtx(
    [200, converseOk("{", "max_tokens")],
    [200, converseOk("{", "model_context_window_exceeded")],
    [200, { output: { message: { content: [] } }, stopReason: "content_filtered", usage: {} }],
  );
  const p = profile("bedrock", "global.anthropic.claude-sonnet-4-6", {}, { base_url: BR });
  assert.equal((await bedrock.chat!(p, req, ctx)).truncated, true);
  assert.equal((await bedrock.chat!(p, req, ctx)).truncated, true);
  await assert.rejects(bedrock.chat!(p, req, ctx), ProviderReplyError);
});

test("bedrock: a 400 naming a sampling knob drops it from inferenceConfig and retries", async () => {
  const { ctx, calls } = fakeCtx(
    [400, { message: "The model returned the following errors: `temperature` and `top_p` cannot both be specified for this model." }],
    [400, { message: "The model returned the following errors: thinking.type.disabled is not supported for this model" }],
    [200, converseOk("{}")],
  );
  const r = await bedrock.chat!(
    profile("bedrock", "global.anthropic.claude-sonnet-4-6", { temperature: 0.1, top_p: 0.9, thinking: "disabled" }, { base_url: BR }),
    req,
    ctx,
  );
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[1].body!.inferenceConfig, { maxTokens: 8000, topP: 0.9 });
  assert.ok(!("additionalModelRequestFields" in calls[2].body!), "empty extras object is removed");
  assert.deepEqual(r.droppedParams, ["temperature", "thinking"]);
});

test("bedrock: 403 is not retried", async () => {
  const { ctx, calls } = fakeCtx([403, { message: "temperature: Credential should be scoped to a valid region" }]);
  await assert.rejects(bedrock.chat!(profile("bedrock", "anthropic.x", { temperature: 0 }, { base_url: BR }), req, ctx));
  assert.equal(calls.length, 1);
});

test("bedrock embeddings: Titan V2 is one text per call with dimensions + normalize", async () => {
  const { ctx, calls } = fakeCtx([200, { embedding: [0.1, 0.2], inputTextTokenCount: 2 }]);
  const out = await bedrock.embed!(
    profile("bedrock", "amazon.titan-embed-text-v2:0", {}, { base_url: BR }),
    { texts: ["a", "b", "c"], inputType: "document", dimensions: 512 },
    ctx,
  );
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, `${BR}/model/amazon.titan-embed-text-v2%3A0/invoke`);
  assert.deepEqual(calls[1].body, { inputText: "b", dimensions: 512, normalize: true });
  assert.equal(out.length, 3);
  await assert.rejects(
    bedrock.embed!(profile("bedrock", "amazon.titan-embed-text-v2:0", {}, { base_url: BR }), { texts: ["a"], inputType: "query", dimensions: 768 }, ctx),
    /256\/512\/1024/,
  );
});

test("bedrock embeddings: Cohere batches of 96, input_type mapping, v4 output_dimension, normalized", async () => {
  const texts = Array.from({ length: 100 }, (_, i) => `t${i}`);
  const reply = (n: number) => ({ embeddings: { float: Array.from({ length: n }, () => [3, 4]) }, response_type: "embeddings_by_type" });
  const { ctx, calls } = fakeCtx([200, reply(96)], [200, reply(4)]);
  const out = await bedrock.embed!(profile("bedrock", "cohere.embed-v4:0", {}, { base_url: BR }), { texts, inputType: "query", dimensions: 1024 }, ctx);
  assert.equal(calls.length, 2);
  assert.equal((calls[0].body!.texts as string[]).length, 96);
  assert.equal((calls[1].body!.texts as string[]).length, 4);
  assert.equal(calls[0].body!.input_type, "search_query");
  assert.equal(calls[0].body!.output_dimension, 1024);
  assert.equal(out.length, 100);
  assert.ok(Math.abs(norm(out[0]!) - 1) < 1e-9);

  const v3 = fakeCtx([200, { embeddings: [[1, 0]], response_type: "embeddings_floats" }]);
  const o3 = await bedrock.embed!(profile("bedrock", "cohere.embed-multilingual-v3", {}, { base_url: BR }), { texts: ["d"], inputType: "document", dimensions: 1024 }, v3.ctx);
  assert.equal(v3.calls[0].body!.input_type, "search_document");
  assert.ok(!("output_dimension" in v3.calls[0].body!), "v3 has fixed 1024 dims");
  assert.deepEqual(o3, [[1, 0]]);
});

test("bedrock: listModels uses the control plane, filters by modality, adds inference profiles", async () => {
  assert.equal(bedrockControlPlane(BR), "https://bedrock.ap-northeast-1.amazonaws.com");
  const fm = {
    modelSummaries: [
      { modelId: "anthropic.claude-sonnet-4-6", inputModalities: ["TEXT", "IMAGE"], outputModalities: ["TEXT"], inferenceTypesSupported: ["INFERENCE_PROFILE"] },
      { modelId: "openai.gpt-oss-120b-1:0", inputModalities: ["TEXT"], outputModalities: ["TEXT"], inferenceTypesSupported: ["ON_DEMAND"] },
      { modelId: "amazon.titan-embed-text-v2:0", inputModalities: ["TEXT"], outputModalities: ["EMBEDDING"], inferenceTypesSupported: ["ON_DEMAND"] },
    ],
  };
  const ip = {
    inferenceProfileSummaries: [
      {
        inferenceProfileId: "apac.anthropic.claude-sonnet-4-6",
        models: [{ modelArn: "arn:aws:bedrock:ap-northeast-1::foundation-model/anthropic.claude-sonnet-4-6" }],
      },
    ],
  };
  const { ctx, calls } = fakeCtx([200, fm], [200, ip], [200, fm], [500, "nope"]);
  const chat = await bedrock.listModels!(profile("bedrock", "", {}, { base_url: BR }), "analysis", ctx);
  assert.equal(calls[0].url, "https://bedrock.ap-northeast-1.amazonaws.com/foundation-models");
  assert.equal(calls[0].headers.Authorization, "Bearer k");
  assert.deepEqual(chat, ["apac.anthropic.claude-sonnet-4-6", "openai.gpt-oss-120b-1:0"]);
  // inference-profile listing failing is tolerated
  const emb = await bedrock.listModels!(profile("bedrock", "", {}, { base_url: BR }), "embedding", ctx);
  assert.deepEqual(emb, ["amazon.titan-embed-text-v2:0"]);
});
