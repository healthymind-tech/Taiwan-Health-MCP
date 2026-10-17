/**
 * OpenAI-compatible cloud adapters (DeepSeek, xAI, Groq, OpenRouter, Together,
 * Fireworks) against a fake fetch: URL, auth, token param and quirk mapping.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { ADAPTERS } from "./cloudCompat.js";
import { fakeCtx, profile } from "./testUtil.js";
import { ProviderReplyError, type ProviderAdapter } from "./types.js";

const chatOk = (content: string, extra: Record<string, unknown> = {}, finish = "stop") => ({
  choices: [{ message: { content, ...extra }, finish_reason: finish }],
  usage: { prompt_tokens: 10, completion_tokens: 5, completion_tokens_details: { reasoning_tokens: 3 } },
});

const req = { messages: [{ role: "user", content: "Return JSON" }], maxTokens: 100, json: true };

function adapter(id: string): ProviderAdapter {
  const a = ADAPTERS.find((x) => x.spec.id === id);
  assert.ok(a, `adapter ${id} registered`);
  return a;
}

test("ADAPTERS order and spec basics", () => {
  assert.deepEqual(
    ADAPTERS.map((a) => a.spec.id),
    ["deepseek", "xai", "groq", "openrouter", "together", "fireworks"],
  );
  for (const a of ADAPTERS) {
    assert.equal(a.spec.category, "cloud");
    assert.equal(a.spec.baseUrl.fixed, true);
    const keys = a.spec.params.map((p) => p.key);
    assert.equal(new Set(keys).size, keys.length, `${a.spec.id}: duplicate param keys`);
    for (const banned of ["max_tokens", "max_token_budget", "timeout_ms", "rpm", "tpm", "dimensions"]) {
      assert.ok(!keys.includes(banned), `${a.spec.id}: ${banned} is UI-owned`);
    }
    assert.equal(Boolean(a.embed), a.spec.roles.includes("embedding"), `${a.spec.id}: embed ↔ roles`);
  }
});

test("deepseek: fixed URL, max_tokens, thinking + effort, json keyword injected", async () => {
  const { ctx, calls } = fakeCtx([200, chatOk('{"a":1}', { reasoning_content: "think" })]);
  const r = await adapter("deepseek").chat!(
    profile("deepseek", "deepseek-v4-pro", { thinking: "enabled", reasoning_effort: "max", temperature: 0.1 }),
    { messages: [{ role: "user", content: "Extract the fields." }], maxTokens: 100, json: true },
    ctx,
  );
  assert.equal(calls[0].url, "https://api.deepseek.com/chat/completions");
  assert.equal(calls[0].headers.Authorization, "Bearer k");
  const b = calls[0].body!;
  assert.equal(b.max_tokens, 100);
  assert.ok(!("max_completion_tokens" in b));
  assert.deepEqual(b.thinking, { type: "enabled" });
  assert.equal(b.reasoning_effort, "max");
  assert.deepEqual(b.response_format, { type: "json_object" });
  const msgs = b.messages as { role: string; content: string }[];
  assert.ok(msgs.some((m) => /json/i.test(m.content)), "prompt must mention json");
  assert.equal(r.reasoningChars, "think".length);
});

test("deepseek: thinking disabled suppresses effort", async () => {
  const { ctx, calls } = fakeCtx([200, chatOk("{}")]);
  await adapter("deepseek").chat!(profile("deepseek", "deepseek-flash", { thinking: "disabled", reasoning_effort: "high" }), req, ctx);
  assert.deepEqual(calls[0].body!.thinking, { type: "disabled" });
  assert.ok(!("reasoning_effort" in calls[0].body!));
});

test("xai: max_completion_tokens, effort only on reasoning models", async () => {
  const { ctx, calls } = fakeCtx([200, chatOk("{}")], [200, chatOk("{}")]);
  const x = adapter("xai");
  await x.chat!(profile("xai", "grok-4.7", { reasoning_effort: "xhigh" }), req, ctx);
  await x.chat!(profile("xai", "grok-4.20-0309-non-reasoning", { reasoning_effort: "xhigh" }), req, ctx);
  assert.equal(calls[0].url, "https://api.x.ai/v1/chat/completions");
  assert.equal(calls[0].headers.Authorization, "Bearer k");
  assert.equal(calls[0].body!.max_completion_tokens, 100);
  assert.ok(!("max_tokens" in calls[0].body!));
  assert.equal(calls[0].body!.reasoning_effort, "xhigh");
  assert.ok(!("reasoning_effort" in calls[1].body!));
  for (const k of ["stop", "presence_penalty", "frequency_penalty"]) assert.ok(!(k in calls[0].body!));
});

test("groq: always sends max_completion_tokens; effort; reasoning_format auto/parsed, never on gpt-oss", async () => {
  const { ctx, calls } = fakeCtx([200, chatOk("{}", { reasoning: "r" })], [200, chatOk("{}")], [200, chatOk("hi")]);
  const g = adapter("groq");
  const r = await g.chat!(profile("groq", "qwen/qwen3.8-27b", { reasoning_effort: "none" }), req, ctx);
  await g.chat!(profile("groq", "openai/gpt-oss-120b", { reasoning_effort: "low", reasoning_format: "hidden" }), req, ctx);
  await g.chat!(profile("groq", "llama-3.3-70b-versatile"), { ...req, json: false }, ctx);
  assert.equal(calls[0].url, "https://api.groq.com/openai/v1/chat/completions");
  assert.equal(calls[0].headers.Authorization, "Bearer k");
  for (const c of calls) {
    assert.equal(c.body!.max_completion_tokens, 100, "Groq default is 1024 — must always be sent");
    assert.ok(!("max_tokens" in c.body!));
  }
  assert.equal(calls[0].body!.reasoning_effort, "none");
  assert.equal(calls[0].body!.reasoning_format, "parsed");
  assert.equal(calls[1].body!.reasoning_effort, "low");
  assert.ok(!("reasoning_format" in calls[1].body!), "gpt-oss rejects reasoning_format");
  assert.ok(!("reasoning_format" in calls[2].body!));
  assert.equal(r.reasoningChars, 1);
});

test("groq: rejected reasoning_format is dropped and retried", async () => {
  const { ctx, calls } = fakeCtx(
    [400, { error: { message: "`reasoning_format` is not supported with this model", type: "invalid_request_error" } }],
    [200, chatOk("{}")],
  );
  const r = await adapter("groq").chat!(profile("groq", "minimaxai/minimax-m2.7", { reasoning_format: "parsed" }), req, ctx);
  assert.equal(calls.length, 2);
  assert.ok(!("reasoning_format" in calls[1].body!));
  assert.deepEqual(r.droppedParams, ["reasoning_format"]);
});

test("openrouter: headers, max_tokens, reasoning + provider objects", async () => {
  const { ctx, calls } = fakeCtx([200, chatOk("{}")], [200, chatOk("{}")]);
  const o = adapter("openrouter");
  await o.chat!(
    profile("openrouter", "deepseek/deepseek-v4.1-flash", { reasoning_effort: "low", reasoning_exclude: true, zdr: true, require_parameters: false }),
    req,
    ctx,
  );
  await o.chat!(profile("openrouter", "openai/gpt-oss-120b"), req, ctx);
  const c = calls[0];
  assert.equal(c.url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(c.headers.Authorization, "Bearer k");
  assert.equal(c.headers["X-Title"], "Taiwan Health MCP");
  assert.ok(c.headers["HTTP-Referer"]);
  assert.equal(c.body!.max_tokens, 100);
  assert.deepEqual(c.body!.reasoning, { effort: "low", exclude: true });
  assert.deepEqual(c.body!.provider, { require_parameters: false, zdr: true });
  // Defaults: require_parameters true, no reasoning object, no zdr.
  assert.deepEqual(calls[1].body!.provider, { require_parameters: true });
  assert.ok(!("reasoning" in calls[1].body!));
});

test("openrouter: HTTP 200 with an error body and no choices throws ProviderReplyError", async () => {
  const { ctx } = fakeCtx([200, { error: { code: 502, message: "Upstream provider returned an error" } }]);
  await assert.rejects(
    adapter("openrouter").chat!(profile("openrouter", "openai/gpt-oss-120b"), req, ctx),
    (err: unknown) => err instanceof ProviderReplyError && /Upstream provider/.test(err.message),
  );
});

test("openrouter embeddings: dimensions sent, zdr routing; model listing per role", async () => {
  const { ctx, calls } = fakeCtx(
    [200, { data: [{ index: 0, embedding: [0.1, 0.2] }] }],
    [200, { data: [{ id: "qwen/qwen3-embedding-8b" }, { id: "baai/bge-m3" }] }],
    [200, { data: [{ id: "openai/gpt-oss-120b" }] }],
  );
  const o = adapter("openrouter");
  const v = await o.embed!(profile("openrouter", "qwen/qwen3-embedding-8b", { zdr: true }), { texts: ["a"], inputType: "document", dimensions: 1024 }, ctx);
  assert.equal(calls[0].url, "https://openrouter.ai/api/v1/embeddings");
  assert.equal(calls[0].body!.dimensions, 1024);
  assert.deepEqual(calls[0].body!.provider, { zdr: true });
  assert.deepEqual(v, [[0.1, 0.2]]);
  const emb = await o.listModels!(profile("openrouter", "x"), "embedding", ctx);
  assert.equal(calls[1].url, "https://openrouter.ai/api/v1/embeddings/models");
  assert.deepEqual(emb, ["baai/bge-m3", "qwen/qwen3-embedding-8b"]);
  const chat = await o.listModels!(profile("openrouter", "x"), "analysis", ctx);
  assert.equal(calls[2].url, "https://openrouter.ai/api/v1/models");
  assert.deepEqual(chat, ["openai/gpt-oss-120b"]);
});

test("together: max_tokens, reasoning.enabled toggle, eos is a normal stop", async () => {
  const { ctx, calls } = fakeCtx([200, chatOk('{"a":1}', { reasoning_content: "rc" }, "eos")], [200, chatOk("{}", {}, "length")]);
  const t = adapter("together");
  const r = await t.chat!(profile("together", "zai-org/GLM-5.2", { thinking: "off", reasoning_effort: "high", temperature: 0 }), req, ctx);
  assert.equal(calls[0].url, "https://api.together.xyz/v1/chat/completions");
  assert.equal(calls[0].headers.Authorization, "Bearer k");
  assert.equal(calls[0].body!.max_tokens, 100);
  assert.deepEqual(calls[0].body!.reasoning, { enabled: false });
  assert.ok(!("reasoning_effort" in calls[0].body!));
  assert.equal(calls[0].body!.temperature, 0);
  assert.equal(r.truncated, false);
  assert.equal(r.finishReason, "eos");
  assert.equal(r.reasoningChars, 2);
  const r2 = await t.chat!(profile("together", "openai/gpt-oss-120b", { thinking: "on", reasoning_effort: "high" }), req, ctx);
  assert.deepEqual(calls[1].body!.reasoning, { enabled: true });
  assert.equal(calls[1].body!.reasoning_effort, "high");
  assert.equal(r2.truncated, true);
});

test("together: /models bare array filtered by type", async () => {
  const { ctx } = fakeCtx([200, [{ id: "b-chat", type: "chat" }, { id: "e", type: "embedding" }, { id: "a-chat", type: "chat" }]]);
  assert.deepEqual(await adapter("together").listModels!(profile("together", "x"), "analysis", ctx), ["a-chat", "b-chat"]);
});

test("fireworks: context_length_exceeded_behavior=error, effort, max_tokens, json keyword", async () => {
  const { ctx, calls } = fakeCtx([200, chatOk("{}")]);
  await adapter("fireworks").chat!(
    profile("fireworks", "accounts/fireworks/models/kimi-k2p5", { reasoning_effort: "none" }),
    { messages: [{ role: "user", content: "Extract." }], maxTokens: 100, json: true },
    ctx,
  );
  const b = calls[0].body!;
  assert.equal(calls[0].url, "https://api.fireworks.ai/inference/v1/chat/completions");
  assert.equal(calls[0].headers.Authorization, "Bearer k");
  assert.equal(b.context_length_exceeded_behavior, "error");
  assert.equal(b.reasoning_effort, "none");
  assert.equal(b.max_tokens, 100);
  assert.ok(!("max_completion_tokens" in b));
  assert.ok((b.messages as { content: string }[]).some((m) => /json/i.test(m.content)));
});

test("fireworks embeddings: dimensions only for resizable models", async () => {
  const { ctx, calls } = fakeCtx([200, { data: [{ index: 0, embedding: [1] }] }], [200, { data: [{ index: 0, embedding: [2] }] }]);
  const f = adapter("fireworks");
  const e = { texts: ["a"], inputType: "query" as const, dimensions: 1024 };
  await f.embed!(profile("fireworks", "fireworks/qwen3-embedding-8b"), e, ctx);
  await f.embed!(profile("fireworks", "thenlper/gte-large"), e, ctx);
  assert.equal(calls[0].url, "https://api.fireworks.ai/inference/v1/embeddings");
  assert.equal(calls[0].body!.dimensions, 1024);
  assert.ok(!("dimensions" in calls[1].body!));
});
