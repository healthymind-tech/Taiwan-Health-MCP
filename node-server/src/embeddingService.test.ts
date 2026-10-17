/**
 * Embedding settings parsing and the shared-limiter pacing used by concurrent
 * embed jobs. No network / DB: the limiter is fed directly.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { EmbeddingService, parseEmbeddingSettings } from "./embeddingService.js";
import { recordRequest, resetAll } from "./rateLimiter.js";
import type { LlmProfile } from "./admin/llmProfiles.js";

function profile(id: number, params: Record<string, unknown>): LlmProfile {
  return {
    id, kind: "embedding", name: `p${id}`, provider: "openai", base_url: "http://x", api_key: "k",
    model: "m", enabled: true, priority: id, weight: 1, params,
  };
}

test("embedding.concurrency defaults to 1 and is clamped to 1..32", () => {
  assert.equal(parseEmbeddingSettings(new Map()).concurrency, 1);
  assert.equal(parseEmbeddingSettings(new Map([["concurrency", "8"]])).concurrency, 8);
  assert.equal(parseEmbeddingSettings(new Map([["concurrency", "0"]])).concurrency, 1);
  assert.equal(parseEmbeddingSettings(new Map([["concurrency", "999"]])).concurrency, 32);
  assert.equal(parseEmbeddingSettings(new Map([["concurrency", "x"]])).concurrency, 1);
  const s = parseEmbeddingSettings(new Map([["strategy", "weighted"], ["batch_size", "16"], ["timeout", "9"]]));
  assert.deepEqual(s, { strategy: "weighted", batchSize: 16, timeout: 9, concurrency: 1 });
});

test("waitForCapacity is a no-op while any profile has budget", async () => {
  resetAll();
  const svc = new EmbeddingService(parseEmbeddingSettings(new Map()), [
    profile(9001, { rpm: 1 }),
    profile(9002, {}),
  ]);
  recordRequest(9001, 0);
  assert.equal(await svc.waitForCapacity(1000), 0, "unlimited profile 9002 can still serve");
});

test("waitForCapacity waits (bounded) when every profile is out of RPM budget", async () => {
  resetAll();
  const svc = new EmbeddingService(parseEmbeddingSettings(new Map()), [
    profile(9003, { rpm: 1 }),
    profile(9004, { rpm: 2 }),
  ]);
  recordRequest(9003, 0);
  recordRequest(9004, 0);
  assert.equal(await svc.waitForCapacity(10), 0, "9004 still has one request left");
  recordRequest(9004, 0);
  const t0 = Date.now();
  const waited = await svc.waitForCapacity(80);
  assert.equal(waited, 80, "capped at maxWaitMs (window reopens in ~60s)");
  assert.ok(Date.now() - t0 >= 75);
  resetAll();
});
