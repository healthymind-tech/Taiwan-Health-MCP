/**
 * QA: provider adapter edge cases — adaptive parameter dropping, proxy error
 * pages, 200-with-error bodies, empty content from Gemini / Anthropic / Cohere,
 * and the ChatGPT SSE parser. All network is a fake CallContext.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { postAdaptive } from "./common.js";
import { openAiCompatChat } from "./openaiCompat.js";
import { anthropic, gemini } from "./cloudMajor.js";
import { cohere } from "./cloudSpecialist.js";
import { openaiCompatible } from "./selfhost.js";
import { parseResponsesStream } from "./chatgpt.js";
import { ProviderHttpError, ProviderReplyError } from "./types.js";
import { fakeCtx, profile } from "./testUtil.js";

const chatReq = { messages: [{ role: "user", content: "give JSON" }], maxTokens: 1000, json: true };

// ── postAdaptive ─────────────────────────────────────────────────────────────

test("postAdaptive: 400s naming several params in sequence drop each in turn, then succeed", async () => {
  const { ctx, calls } = fakeCtx(
    [400, { error: { message: "Unrecognized request argument supplied: top_k" } }],
    [400, { error: { message: "min_p is not supported" } }],
    [400, { error: { message: "unknown field `repeat_penalty`" } }],
    [200, { ok: true }],
  );
  const body = { model: "m", top_k: 5, min_p: 0.1, repeat_penalty: 1.1, temperature: 0 };
  const r = await postAdaptive(ctx, "http://x", {}, body, ["top_k", "min_p", "repeat_penalty", "temperature"]);
  assert.deepEqual(r.dropped, ["top_k", "min_p", "repeat_penalty"]);
  assert.equal(calls.length, 4);
  assert.equal(calls[3].body!.temperature, 0, "unrelated knob kept");
});

test("postAdaptive: 401/403/404/429/5xx are never treated as a param rejection", async () => {
  for (const status of [401, 403, 404, 429, 500, 503]) {
    const { ctx, calls } = fakeCtx([status, { error: { message: "temperature" } }]);
    await assert.rejects(postAdaptive(ctx, "http://x", {}, { temperature: 1 }, ["temperature"]), ProviderHttpError);
    assert.equal(calls.length, 1, `status ${status} retried`);
  }
});

test("postAdaptive: an HTML 400 page from a proxy with no param name → original HTTP error, bounded message", async () => {
  const html = `<html><head><title>400 Bad Request</title></head><body>${"x".repeat(5000)}</body></html>`;
  const { ctx } = fakeCtx([400, html]);
  await assert.rejects(postAdaptive(ctx, "http://x", {}, { temperature: 1 }, ["temperature"]), (e: ProviderHttpError) => {
    assert.equal(e.status, 400);
    assert.ok(e.message.length < 500, `message length ${e.message.length}`);
    return true;
  });
});

test(
  "a 400 unrelated to params (context length) whose body echoes the prompt must not strip knobs",
  async () => {
    const { ctx, calls } = fakeCtx([
      400,
      { error: { message: "This model's maximum context length is 32768 tokens. Input: '…請於室溫 (temperature 25°C) 以下保存…'" } },
    ]);
    await assert.rejects(postAdaptive(ctx, "http://x", {}, { temperature: 0, top_p: 1 }, ["temperature", "top_p"]));
    assert.equal(calls.length, 1, `re-sent ${calls.length - 1} time(s) with knobs stripped`);
  },
);

test("postAdaptive: max_tokens ↔ max_completion_tokens swap via openAiCompat adapt", async () => {
  const { ctx, calls } = fakeCtx(
    [400, { error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." } }],
    [200, { choices: [{ message: { content: "{}" }, finish_reason: "stop" }] }],
  );
  const r = await openAiCompatChat(profile("openai_compatible", "o3"), chatReq, ctx, { root: () => "http://x/v1", headers: () => ({}) });
  assert.equal(calls[1].body!.max_completion_tokens, 1000);
  assert.ok(!("max_tokens" in calls[1].body!));
  assert.deepEqual(r.droppedParams, ["max_tokens→max_completion_tokens"]);
});

test("postAdaptive: a server that keeps flip-flopping between the two token names stops after 8 attempts", async () => {
  const msg = { error: { message: "max_tokens unsupported; use max_completion_tokens. max_completion_tokens unsupported" } };
  const { ctx, calls } = fakeCtx([400, msg]);
  await assert.rejects(
    openAiCompatChat(profile("openai_compatible", "m"), chatReq, ctx, { root: () => "http://x/v1", headers: () => ({}) }),
    /kept rejecting request parameters/,
  );
  assert.equal(calls.length, 8);
});

// ── 200 with error body / empty content ─────────────────────────────────────

test("openAiCompat: 200 {error} without choices → ProviderReplyError (endpoint failure)", async () => {
  const { ctx } = fakeCtx([200, { error: { message: "No endpoints found", code: 404 } }]);
  await assert.rejects(openaiCompatible.chat!(profile("openai_compatible", "m", {}, { base_url: "http://x" }), chatReq, ctx), ProviderReplyError);
});

test(
  "openAiCompat: 200 with choices[0].error / finish_reason='error' (OpenRouter mid-stream upstream failure) is an endpoint failure",
  async () => {
    const { ctx } = fakeCtx([200, { choices: [{ message: { content: "" }, finish_reason: "error", error: { message: "upstream 502" } }] }]);
    await assert.rejects(openaiCompatible.chat!(profile("openai_compatible", "m", {}, { base_url: "http://x" }), chatReq, ctx), ProviderReplyError);
  },
);

test("Anthropic: empty content with stop_reason=end_turn → ProviderReplyError (endpoint failure, not a budget problem)", async () => {
  const { ctx } = fakeCtx([200, { type: "message", content: [], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 0 } }]);
  await assert.rejects(anthropic.chat!(profile("anthropic", "claude-sonnet-4-5"), chatReq, ctx), ProviderReplyError);
});

test("Anthropic: empty content with stop_reason=max_tokens → truncated (escalation path)", async () => {
  const { ctx } = fakeCtx([200, { type: "message", content: [], stop_reason: "max_tokens", usage: {} }]);
  const r = await anthropic.chat!(profile("anthropic", "claude-sonnet-4-5"), chatReq, ctx);
  assert.equal(r.truncated, true);
});

test("Anthropic: only a thinking block (budget eaten by thinking) → truncated, reasoningChars counted", async () => {
  const { ctx } = fakeCtx([200, { type: "message", content: [{ type: "thinking", thinking: "hmm…" }], stop_reason: "max_tokens", usage: {} }]);
  const r = await anthropic.chat!(profile("anthropic", "claude-sonnet-4-5"), chatReq, ctx);
  assert.equal(r.truncated, true);
  assert.equal(r.reasoningChars, 4);
});

test("Anthropic: refusal → ProviderReplyError; 200 type=error → ProviderReplyError", async () => {
  const a = fakeCtx([200, { type: "message", content: [], stop_reason: "refusal" }]);
  await assert.rejects(anthropic.chat!(profile("anthropic", "claude-x"), chatReq, a.ctx), ProviderReplyError);
  const b = fakeCtx([200, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }]);
  await assert.rejects(anthropic.chat!(profile("anthropic", "claude-x"), chatReq, b.ctx), /Overloaded/);
});

test("Gemini: no candidates and no promptFeedback/error → ProviderReplyError (not a budget escalation)", async () => {
  const { ctx } = fakeCtx([200, { usageMetadata: { promptTokenCount: 3 } }]);
  await assert.rejects(gemini.chat!(profile("gemini", "gemini-2.5-flash"), chatReq, ctx), ProviderReplyError);
});

test("Gemini: SAFETY with empty content → ProviderReplyError; blocked prompt → ProviderReplyError", async () => {
  const a = fakeCtx([200, { candidates: [{ finishReason: "SAFETY", content: { parts: [] } }] }]);
  await assert.rejects(gemini.chat!(profile("gemini", "gemini-2.5-flash"), chatReq, a.ctx), /SAFETY/);
  const b = fakeCtx([200, { promptFeedback: { blockReason: "OTHER" } }]);
  await assert.rejects(gemini.chat!(profile("gemini", "gemini-2.5-flash"), chatReq, b.ctx), /blocked the prompt/);
});

test("Gemini: thought-only parts → content empty, reasoning counted, thoughts billed", async () => {
  const { ctx } = fakeCtx([
    200,
    { candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: "think", thought: true }] } }], usageMetadata: { candidatesTokenCount: 0, thoughtsTokenCount: 999 } },
  ]);
  const r = await gemini.chat!(profile("gemini", "gemini-2.5-flash"), chatReq, ctx);
  assert.equal(r.content, "");
  assert.equal(r.reasoningChars, 5);
  assert.equal(r.usage.completionTokens, 999);
});

test("Cohere: message.content [] with COMPLETE → ProviderReplyError; MAX_TOKENS → truncated; missing message → ProviderReplyError", async () => {
  const a = fakeCtx([200, { message: { role: "assistant", content: [] }, finish_reason: "COMPLETE" }]);
  await assert.rejects(cohere.chat!(profile("cohere", "command-a"), chatReq, a.ctx), ProviderReplyError);
  const c = fakeCtx([200, { message: { role: "assistant", content: [] }, finish_reason: "MAX_TOKENS" }]);
  const r = await cohere.chat!(profile("cohere", "command-a"), chatReq, c.ctx);
  assert.equal(r.truncated, true);
  const b = fakeCtx([200, { id: "x" }]);
  await assert.rejects(cohere.chat!(profile("cohere", "command-a"), chatReq, b.ctx), ProviderReplyError);
});

// ── ChatGPT SSE ──────────────────────────────────────────────────────────────

const ev = (e: Record<string, unknown>, nl = "\n") => `event: ${String(e.type)}${nl}data: ${JSON.stringify(e)}${nl}${nl}`;
const completed = { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 2 } } };

test("SSE: CRLF line endings parse the same as LF", () => {
  const raw = [ev({ type: "response.output_text.delta", delta: '{"a":' }, "\r\n"), ev({ type: "response.output_text.delta", delta: "1}" }, "\r\n"), ev(completed, "\r\n")].join("");
  const out = parseResponsesStream(raw);
  assert.equal(out.status, "completed");
  assert.equal(out.text, '{"a":1}');
});

test("SSE: chunk boundaries are irrelevant (whole body is buffered before parsing), incl. a split mid-JSON", () => {
  const raw = ev({ type: "response.output_text.delta", delta: "héllo 你好" }) + ev(completed);
  // Simulate arbitrary network chunking: the adapter reads res.text(), so re-joining is exact.
  const chunks: string[] = [];
  for (let i = 0; i < raw.length; i += 7) chunks.push(raw.slice(i, i + 7));
  assert.equal(parseResponsesStream(chunks.join("")).text, "héllo 你好");
});

test("SSE: missing response.completed → status 'none' (adapter turns it into ProviderReplyError)", () => {
  const out = parseResponsesStream(ev({ type: "response.output_text.delta", delta: "partial" }));
  assert.equal(out.status, "none");
  assert.equal(out.text, "partial");
});

test("SSE: `data:` without a space, [DONE], comments and garbage lines are tolerated", () => {
  const raw = `: keep-alive\n\ndata:${JSON.stringify({ type: "response.output_text.delta", delta: "x" })}\n\ndata: not json\n\n${ev(completed)}data: [DONE]\n\n`;
  const out = parseResponsesStream(raw);
  assert.equal(out.text, "x");
  assert.equal(out.status, "completed");
});

test("SSE: no deltas → falls back to response.output[].content[].output_text", () => {
  const out = parseResponsesStream(ev({ type: "response.completed", response: { output: [{ content: [{ type: "output_text", text: "{}" }] }], usage: {} } }));
  assert.equal(out.text, "{}");
});

test("SSE: top-level `error` event → failed with code/message", () => {
  const out = parseResponsesStream(ev({ type: "error", code: "rate_limit_exceeded", message: "slow down" }));
  assert.equal(out.status, "failed");
  assert.equal(out.detail, "rate_limit_exceeded slow down");
});

test(
  "SSE with bare CR line endings (allowed by the SSE spec) is parsed",
  () => {
    const raw = [ev({ type: "response.output_text.delta", delta: "ok" }, "\r"), ev(completed, "\r")].join("");
    const out = parseResponsesStream(raw);
    assert.equal(out.status, "completed");
    assert.equal(out.text, "ok");
  },
);

test("SSE: completed after failed → last event wins (status completed) — order-dependent outcome", () => {
  const out = parseResponsesStream(ev({ type: "response.failed", response: { error: { code: "x", message: "y" } } }) + ev(completed));
  assert.equal(out.status, "completed");
});
