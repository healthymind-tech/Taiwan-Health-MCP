/**
 * Sign in with ChatGPT: Responses request shape, SSE parsing and ID-token checks.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { buildResponsesBody, parseResponsesStream } from "./chatgpt.js";
import { verifyIdToken } from "../admin/chatgptOAuth.js";
import { profile } from "./testUtil.js";

const sse = (...events: Record<string, unknown>[]) => events.map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join("");

test("request: store=false, stream=true, system text goes to instructions, JSON format", () => {
  const body = buildResponsesBody(profile("chatgpt", "gpt-6-luna", { reasoning_effort: "low" }), {
    messages: [
      { role: "system", content: "You are a JSON API." },
      { role: "user", content: "hi" },
    ],
    maxTokens: 999,
    json: true,
  });
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  assert.equal(body.instructions, "You are a JSON API.");
  assert.deepEqual(body.input, [{ role: "user", content: "hi" }]);
  assert.deepEqual(body.text, { format: { type: "json_object" } });
  assert.deepEqual(body.reasoning, { effort: "low" });
  assert.ok(!("max_output_tokens" in body) && !("temperature" in body), "preview rejects these");
});

test("stream: deltas assembled, usage read from response.completed", () => {
  const out = parseResponsesStream(
    sse(
      { type: "response.created" },
      { type: "response.reasoning_summary_text.delta", delta: "think" },
      { type: "response.output_text.delta", delta: '{"ok":' },
      { type: "response.output_text.delta", delta: "true}" },
      { type: "response.completed", response: { usage: { input_tokens: 12, output_tokens: 7, output_tokens_details: { reasoning_tokens: 3 } } } },
    ),
  );
  assert.equal(out.status, "completed");
  assert.equal(out.text, '{"ok":true}');
  assert.equal(out.reasoningChars, 5);
  assert.equal(out.usage.output_tokens, 7);
});

test("stream: incomplete and failed outcomes; missing completion detected", () => {
  assert.equal(parseResponsesStream(sse({ type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } })).detail, "max_output_tokens");
  const failed = parseResponsesStream(sse({ type: "response.failed", response: { error: { code: "subscription_sharing_usage_limit_exceeded", message: "limit" } } }));
  assert.equal(failed.status, "failed");
  assert.match(failed.detail, /usage_limit_exceeded/);
  assert.equal(parseResponsesStream(sse({ type: "response.output_text.delta", delta: "x" })).status, "none");
});

test("ID token: RS256 signature, issuer, audience, nonce and expiry are enforced", async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const sign = (claims: Record<string, unknown>) => {
    const head = b64({ alg: "RS256", kid: "k1" });
    const body = b64(claims);
    const sig = crypto.sign("RSA-SHA256", Buffer.from(`${head}.${body}`), privateKey).toString("base64url");
    return `${head}.${body}.${sig}`;
  };
  const good = { iss: "https://auth.openai.com", aud: "oaiapp_1", exp: Math.floor(Date.now() / 1000) + 600, nonce: "n1", sub: "u", email: "a@b.c" };
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 })) as typeof fetch;
  try {
    const claims = await verifyIdToken(sign(good), "oaiapp_1", "n1");
    assert.equal(claims.email, "a@b.c");
    await assert.rejects(verifyIdToken(sign(good), "oaiapp_other", "n1"), /audience/);
    await assert.rejects(verifyIdToken(sign(good), "oaiapp_1", "n2"), /nonce/);
    await assert.rejects(verifyIdToken(sign({ ...good, exp: 1 }), "oaiapp_1", "n1"), /expired/);
    await assert.rejects(verifyIdToken(sign({ ...good, iss: "https://evil.example" }), "oaiapp_1", "n1"), /issuer/);
    const tampered = sign(good).replace(/\.[^.]+\./, `.${b64({ ...good, email: "x@y.z" })}.`);
    await assert.rejects(verifyIdToken(tampered, "oaiapp_1", "n1"), /signature/);
  } finally {
    globalThis.fetch = original;
  }
});
