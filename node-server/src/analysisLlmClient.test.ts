/**
 * Budget-escalation behavior for the shared Analysis LM client. A model that
 * keeps hitting finish_reason=length is usually looping; the escalation must
 * give a reasoning model room for hidden reasoning but stop fast on a
 * non-reasoning one instead of doubling all the way to 64k.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { callAnalysisLlm, MAX_TOKEN_BUDGET } from "./analysisLlmClient.js";
import { setProfileStatsEnabled } from "./admin/llmProfileStats.js";

setProfileStatsEnabled(false); // unit tests never touch the database

const lengthReply = () =>
  ({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: "x" }, finish_reason: "length" }],
    }),
  }) as Response;

function profile(model: string, params: Record<string, unknown> = {}) {
  return {
    id: 1,
    kind: "analysis" as const,
    name: "test",
    provider: "openai",
    base_url: "https://lm.test",
    api_key: "",
    model,
    enabled: true,
    priority: 1,
    weight: 1,
    params,
  };
}

test("non-reasoning model escalates once then gives up (no 64k runaway)", async () => {
  let calls = 0;
  const originalFetch = globalThis.fetch;
  // @ts-expect-error mock
  globalThis.fetch = async () => {
    calls += 1;
    return lengthReply();
  };
  try {
    await assert.rejects(
      callAnalysisLlm([profile("Qwen3.5-2B-MLX-4bit")], [{ role: "user", content: "x" }]),
      /Every Analysis LM profile failed/,
    );
    assert.equal(calls, 2, "budget 4096 → 8192, then stop — not 15 escalations to 64k");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("reasoning model keeps escalating to the ceiling", async () => {
  let calls = 0;
  const originalFetch = globalThis.fetch;
  // @ts-expect-error mock
  globalThis.fetch = async () => {
    calls += 1;
    return lengthReply();
  };
  try {
    await assert.rejects(
      callAnalysisLlm([profile("o3-mini")], [{ role: "user", content: "x" }]),
      /ran out of output budget at 65536/,
    );
    assert.ok(calls >= 3, `expected ~3 doublings to ${MAX_TOKEN_BUDGET}, got ${calls}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("profile max_token_budget override raises the non-reasoning ceiling", async () => {
  let calls = 0;
  const originalFetch = globalThis.fetch;
  // @ts-expect-error mock
  globalThis.fetch = async () => {
    calls += 1;
    return lengthReply();
  };
  try {
    await assert.rejects(
      callAnalysisLlm(
        [profile("gemma-4-e4b-it-OptiQ-4bit", { max_token_budget: 16384 })],
        [{ role: "user", content: "x" }],
      ),
      /ran out of output budget at 16384/,
    );
    assert.equal(calls, 3, "budget 4096 → 8192 → 16384, then stop at the override");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
