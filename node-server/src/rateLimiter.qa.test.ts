/**
 * QA: RPM/TPM sliding-window limiter — limits, waitUntilMs correctness, and the
 * cost of a check with many tokens in the window. Date.now is faked where the
 * window matters.
 */

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { canRequest, getStats, recordRequest, resetAll, waitUntilMs } from "./rateLimiter.js";

const realNow = Date.now;
let fakeT = 0;
function freezeTime(start = 1_000_000_000_000): (ms: number) => void {
  fakeT = start;
  Date.now = () => fakeT;
  return (ms) => {
    fakeT += ms;
  };
}
afterEach(() => {
  Date.now = realNow;
  resetAll();
});

test("RPM: exactly `rpm` requests allowed, the next is refused", () => {
  freezeTime();
  for (let i = 0; i < 5; i += 1) {
    assert.equal(canRequest(1, { rpm: 5 }).allowed, true);
    recordRequest(1, 0);
  }
  const r = canRequest(1, { rpm: 5 });
  assert.equal(r.allowed, false);
  assert.match(r.reason!, /RPM limit \(5\)/);
});

test("TPM: refused once used tokens ≥ tpm", () => {
  freezeTime();
  recordRequest(2, 999);
  assert.equal(canRequest(2, { tpm: 1000 }).allowed, true);
  recordRequest(2, 1);
  assert.equal(canRequest(2, { tpm: 1000 }).allowed, false);
});

test("TPM: the check ignores the size of the request about to be sent (one huge request overshoots the budget)", () => {
  // Documented characteristic: a 900k-token request is allowed with tpm=1000 when the window is empty.
  freezeTime();
  assert.equal(canRequest(3, { tpm: 1000 }).allowed, true);
  recordRequest(3, 900_000);
  assert.equal(getStats(3).tokens, 900_000);
});

test("waitUntilMs: 0 when allowed; ≈ oldest + 60s when RPM is full", () => {
  const advance = freezeTime();
  assert.equal(waitUntilMs(4, { rpm: 2 }), 0);
  recordRequest(4, 0);
  advance(10_000);
  recordRequest(4, 0);
  assert.equal(waitUntilMs(4, { rpm: 2 }), 50_000);
  advance(50_001);
  assert.equal(canRequest(4, { rpm: 2 }).allowed, true, "oldest left the window");
});

test(
  "canRequest and waitUntilMs agree — 'not allowed' never comes with a 0 ms wait",
  () => {
    const advance = freezeTime();
    recordRequest(5, 0); // t=0
    advance(5_000);
    recordRequest(5, 0); // t=5s
    // Keep lastCleanupAt fresh so the next calls do not purge.
    advance(59_000); // t=64s: the first entry expired at 60s, the second at 65s
    // lastCleanupAt was set at creation (t=0) → >10s → this call purges. Re-arm the trap:
    canRequest(5, { rpm: 2 });
    recordRequest(5, 0); // t=64s; count now 2 (t=5s, t=64s) → full
    advance(2_000); // t=66s: entry t=5s expired, but last purge was 2s ago → still counted
    const allowed = canRequest(5, { rpm: 2 }).allowed;
    const wait = waitUntilMs(5, { rpm: 2 });
    assert.ok(allowed || wait > 0, `allowed=${allowed}, waitUntilMs=${wait}`);
  },
);

test(
  "waitUntilMs for TPM returns when enough tokens have left the window, not merely the oldest one",
  () => {
    const advance = freezeTime();
    recordRequest(6, 1); // 1 token at t=0
    advance(30_000);
    recordRequest(6, 2000); // 2000 tokens at t=30s
    const wait = waitUntilMs(6, { tpm: 1000 });
    advance(wait + 1);
    assert.equal(canRequest(6, { tpm: 1000 }).allowed, true, `woken after ${wait}ms but still over TPM`);
  },
);

test("perf: TPM with 1M tokens/min — memory and time of one-timestamp-per-token storage", () => {
  freezeTime();
  const before = process.memoryUsage().heapUsed;
  const t0 = performance.now();
  // 100 requests × 10k tokens = 1M tokens in the window.
  for (let i = 0; i < 100; i += 1) recordRequest(7, 10_000);
  const recordMs = performance.now() - t0;
  const t1 = performance.now();
  for (let i = 0; i < 100; i += 1) canRequest(7, { tpm: 2_000_000 });
  const checkMs = (performance.now() - t1) / 100;
  const heapMb = (process.memoryUsage().heapUsed - before) / 1024 / 1024;
  console.log(`[qa-perf] record 1M tokens: ${recordMs.toFixed(1)} ms; canRequest: ${checkMs.toFixed(2)} ms/call; heap +${heapMb.toFixed(1)} MB`);
  assert.equal(getStats(7).tokens, 1_000_000);
  // Thresholds are generous: the point is to surface the O(tokens) cost in the log.
  assert.ok(checkMs < 50, `canRequest is O(tokens): ${checkMs} ms per call`);
});

test(
  "limiter cost should not scale with token count (O(1)/O(requests) per check)",
  () => {
    freezeTime();
    for (let i = 0; i < 100; i += 1) recordRequest(8, 50_000); // 5M tokens
    const t0 = performance.now();
    for (let i = 0; i < 20; i += 1) canRequest(8, { tpm: 10_000_000 });
    const perCall = (performance.now() - t0) / 20;
    console.log(`[qa-perf] canRequest with 5M stored token timestamps: ${perCall.toFixed(2)} ms/call`);
    assert.ok(perCall < 0.5, `${perCall.toFixed(2)} ms per check`);
  },
);
