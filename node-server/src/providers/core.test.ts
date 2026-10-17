/**
 * Reference adapters (OpenAI, Azure, OpenAI-compatible, Ollama) against a fake
 * fetch: the exact request each one sends and how replies are read.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { azureOpenai, openai } from "./openai.js";
import { canonicalProviderId, getAdapter, legacyProviderId, providerSpecs } from "./registry.js";
import { ollama, openaiCompatible } from "./selfhost.js";
import { fakeCtx, profile } from "./testUtil.js";

const chatOk = (content: string, extra: Record<string, unknown> = {}) => ({
  choices: [{ message: { content, ...extra }, finish_reason: "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 5, completion_tokens_details: { reasoning_tokens: 3 } },
});

const req = { messages: [{ role: "user", content: "Return JSON" }], maxTokens: 100, json: true };

test("openai: fixed URL, max_completion_tokens, effort, sampling dropped for reasoning models", async () => {
  const { ctx, calls } = fakeCtx([200, chatOk('{"ok":true}')]);
  const r = await openai.chat!(profile("openai", "gpt-6-luna", { reasoning_effort: "low", temperature: 0.1, verbosity: "low" }), req, ctx);
  assert.equal(calls[0].url, "https://api.openai.com/v1/chat/completions");
  assert.equal(calls[0].headers.Authorization, "Bearer k");
  const b = calls[0].body!;
  assert.equal(b.max_completion_tokens, 100);
  assert.equal(b.reasoning_effort, "low");
  assert.equal(b.verbosity, "low");
  assert.ok(!("temperature" in b), "temperature must not be sent with effort != none");
  assert.deepEqual(b.response_format, { type: "json_object" });
  assert.equal(r.content, '{"ok":true}');
  assert.equal(r.usage.reasoningTokens, 3);
});

test("openai: sampling kept when effort is none or model is not a reasoning model", async () => {
  const { ctx, calls } = fakeCtx([200, chatOk("{}")], [200, chatOk("{}")]);
  await openai.chat!(profile("openai", "gpt-6-luna", { reasoning_effort: "none", temperature: 0.2 }), req, ctx);
  await openai.chat!(profile("openai", "gpt-4.1-mini", { temperature: 0.2 }), req, ctx);
  assert.equal(calls[0].body!.temperature, 0.2);
  assert.equal(calls[1].body!.temperature, 0.2);
  assert.ok(!("reasoning_effort" in calls[1].body!));
});

test("openai: a rejected effort value is dropped and the call retried", async () => {
  const { ctx, calls } = fakeCtx(
    [400, { error: { message: "Unsupported value: 'reasoning_effort' does not support 'none' with this model." } }],
    [200, chatOk("{}")],
  );
  const r = await openai.chat!(profile("openai", "gpt-6-astra", { reasoning_effort: "none" }), req, ctx);
  assert.equal(calls.length, 2);
  assert.ok(!("reasoning_effort" in calls[1].body!));
  assert.deepEqual(r.droppedParams, ["reasoning_effort"]);
});

test("openai embeddings: dimensions only for text-embedding-3", async () => {
  const { ctx, calls } = fakeCtx([200, { data: [{ index: 1, embedding: [2] }, { index: 0, embedding: [1] }] }]);
  const v = await openai.embed!(profile("openai", "text-embedding-3-large"), { texts: ["a", "b"], inputType: "document", dimensions: 1024 }, ctx);
  assert.equal(calls[0].body!.dimensions, 1024);
  assert.deepEqual(v, [[1], [2]]);
});

test("azure: v1 root from a bare resource URL, api-key header, base_model drives capabilities", async () => {
  const { ctx, calls } = fakeCtx([200, chatOk("{}")]);
  await azureOpenai.chat!(
    profile("azure_openai", "prod-extractor", { base_model: "gpt-6-luna", reasoning_effort: "low", temperature: 0.3 }, { base_url: "https://res.openai.azure.com" }),
    req,
    ctx,
  );
  assert.equal(calls[0].url, "https://res.openai.azure.com/openai/v1/chat/completions");
  assert.equal(calls[0].headers["api-key"], "k");
  assert.equal(calls[0].body!.model, "prod-extractor");
  assert.equal(calls[0].body!.reasoning_effort, "low");
  assert.ok(!("temperature" in calls[0].body!));
});

test("openai_compatible: /v1 appended, thinking via chat_template_kwargs, reasoning field read", async () => {
  const { ctx, calls } = fakeCtx([200, chatOk('{"a":1}', { reasoning: "thought" })]);
  const r = await openaiCompatible.chat!(
    profile("openai_compatible", "Qwen/Qwen3-32B", { thinking: "off", top_k: 20, min_p: 0 }, { base_url: "http://gpu:8000" }),
    req,
    ctx,
  );
  assert.equal(calls[0].url, "http://gpu:8000/v1/chat/completions");
  assert.deepEqual(calls[0].body!.chat_template_kwargs, { enable_thinking: false });
  assert.equal(calls[0].body!.top_k, 20);
  assert.equal(calls[0].body!.min_p, 0);
  assert.equal(r.reasoningChars, "thought".length);
});

test("openai_compatible: inline <think> stripped, code fence removed", async () => {
  const { ctx } = fakeCtx([200, chatOk('<think>hmm</think>\n```json\n{"a":1}\n```')]);
  const r = await openaiCompatible.chat!(profile("openai_compatible", "m", {}, { base_url: "http://x/v1" }), req, ctx);
  assert.equal(r.content, '{"a":1}');
  assert.equal(r.reasoningChars, 3);
});

test("ollama: native body with think/num_ctx/keep_alive, truncation from done_reason", async () => {
  const { ctx, calls } = fakeCtx([200, { message: { content: "", thinking: "abc" }, done_reason: "length", eval_count: 100, eval_duration: 2e9 }]);
  const r = await ollama.chat!(
    profile("ollama", "qwen3:32b", { think: "off", num_ctx: 32768, keep_alive: "-1", temperature: 0.1 }, { base_url: "http://h:11434" }),
    req,
    ctx,
  );
  const b = calls[0].body!;
  assert.equal(calls[0].url, "http://h:11434/api/chat");
  assert.equal(b.think, false);
  assert.equal(b.keep_alive, -1);
  assert.equal(b.format, "json");
  assert.deepEqual(b.options, { num_predict: 100, temperature: 0.1, num_ctx: 32768 });
  assert.equal(r.truncated, true);
  assert.equal(r.diagnostics!.tokens_per_sec, 50);
});

test("ollama cloud: no format (structured output unsupported there)", async () => {
  const { ctx, calls } = fakeCtx([200, { message: { content: "{}" }, done_reason: "stop" }]);
  await ollama.chat!(profile("ollama", "gpt-oss:120b", { think: "off" }, { base_url: "https://ollama.com" }), req, ctx);
  assert.ok(!("format" in calls[0].body!));
  assert.equal(calls[0].body!.think, "low");
});

test("registry: legacy ids and the openai/openai_compatible split", () => {
  assert.equal(canonicalProviderId("openai", "https://api.openai.com/v1"), "openai");
  // The URL never changes an account's type; only pre-registry documents map "openai" + own URL.
  assert.equal(canonicalProviderId("openai", "http://10.0.0.5:8000/v1"), "openai");
  assert.equal(legacyProviderId("openai", "http://10.0.0.5:8000/v1"), "openai_compatible");
  assert.equal(legacyProviderId("openai", "https://api.openai.com/v1"), "openai");
  assert.equal(canonicalProviderId("vllm"), "openai_compatible");
  assert.equal(canonicalProviderId("google"), "gemini");
  assert.equal(getAdapter("ollama")?.spec.id, "ollama");
  const ids = providerSpecs().map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, "provider ids are unique");
  for (const s of providerSpecs()) {
    const keys = s.params.map((x) => x.key);
    assert.equal(new Set(keys).size, keys.length, `${s.id}: duplicate param keys`);
  }
});

test("registry: every thinkingOff points at a real option of that provider", () => {
  for (const s of providerSpecs()) {
    if (!s.thinkingOff) continue;
    const param = s.params.find((x) => x.key === s.thinkingOff!.key);
    assert.ok(param, `${s.id}: thinkingOff key ${s.thinkingOff.key} missing`);
    assert.ok(param!.options?.some((o) => o.value === s.thinkingOff!.value), `${s.id}: ${s.thinkingOff.value} not an option`);
  }
});
