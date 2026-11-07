import { test } from "node:test";
import assert from "node:assert/strict";
import { BUSY_CODE, ToolGate, withConcurrencyLimit } from "./toolConcurrency.js";

const heavy = new Set(["heavy"]);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test("ToolGate: at most `limit` heavy calls run; the rest wait FIFO; light tools never wait", async () => {
  const gate = new ToolGate({ limit: 2, queueTimeoutMs: 1000, maxQueue: 10 });
  let running = 0;
  let peak = 0;
  const order: number[] = [];
  const h = withConcurrencyLimit("heavy", async (i: number) => {
    running++;
    peak = Math.max(peak, running);
    await sleep(20);
    running--;
    order.push(i);
    return i;
  }, () => gate, heavy);
  const light = withConcurrencyLimit("light", async () => gate.stats().running, () => gate, heavy);
  const calls = [0, 1, 2, 3, 4].map((i) => h(i));
  assert.equal(await light(), 2, "a light tool runs while heavy ones hold the slots");
  assert.deepEqual(await Promise.all(calls), [0, 1, 2, 3, 4]);
  assert.equal(peak, 2);
  assert.deepEqual(order, [0, 1, 2, 3, 4]);
  assert.deepEqual(gate.stats(), { running: 0, queued: 0, limit: 2 });
});

test("ToolGate: queue timeout and overflow answer BUSY with retry_after_s; a failing call frees its slot", async () => {
  const gate = new ToolGate({ limit: 1, queueTimeoutMs: 30, maxQueue: 1 });
  const h = withConcurrencyLimit("heavy", async (ms: number) => {
    await sleep(ms);
    if (ms === 1) throw new Error("boom");
    return "done";
  }, () => gate, heavy);
  const first = h(80);
  const timedOut = h(1);
  const overflow = (await h(1)) as any; // queue full
  assert.equal(JSON.parse(overflow.content[0].text).error.code, BUSY_CODE);
  const t = (await timedOut) as any;
  const err = JSON.parse(t.content[0].text).error;
  assert.equal(err.code, BUSY_CODE);
  assert.ok(err.retry_after_s >= 5 && err.concurrency_limit === 1);
  assert.equal(await first, "done");
  await assert.rejects(h(1), /boom/);
  assert.deepEqual(gate.stats(), { running: 0, queued: 0, limit: 1 });
  const off = new ToolGate({ limit: 0, queueTimeoutMs: 10, maxQueue: 0 });
  assert.equal(await off.acquire(), true, "limit 0 = no cap");
});

test("memory guard: a heavy call does not start while the heap stays above the ratio (BUSY reason memory); a pause that frees it lets it run", async () => {
  const gate = new ToolGate({ limit: 2, queueTimeoutMs: 1000, maxQueue: 4, heapRatio: 0.85 });
  let ran = 0;
  const handler = async (): Promise<string> => {
    ran++;
    return "done";
  };
  const pauses: number[] = [];
  // stays high → BUSY, handler never runs, slot released
  const high = withConcurrencyLimit("fhir_validate_bundle", handler, () => gate, undefined, { ratio: () => 0.9, pause: async (ms) => void pauses.push(ms) });
  const r = (await high()) as unknown as { isError: boolean; content: Array<{ text: string }> };
  assert.equal(r.isError, true);
  const body = JSON.parse(r.content[0].text);
  assert.equal(body.error.code, BUSY_CODE);
  assert.equal(body.error.reason, "memory");
  assert.equal(body.error.retry_after_s, 15);
  assert.equal(ran, 0);
  assert.deepEqual(pauses, [1000]);
  assert.equal(gate.stats().running, 0);
  // high, then collected after the pause → runs
  let n = 0;
  const recovers = withConcurrencyLimit("fhir_validate_bundle", handler, () => gate, undefined, { ratio: () => (n++ === 0 ? 0.9 : 0.5), pause: async () => {} });
  assert.equal(await recovers(), "done");
  // light tools are never checked
  const light = withConcurrencyLimit("search_loinc", handler, () => gate, undefined, { ratio: () => 0.99, pause: async () => {} });
  assert.equal(await light(), "done");
  // ratio 0 = guard off
  const off = new ToolGate({ limit: 2, queueTimeoutMs: 1000, maxQueue: 4, heapRatio: 0 });
  assert.equal(await withConcurrencyLimit("fhir_validate_bundle", handler, () => off, undefined, { ratio: () => 0.99, pause: async () => {} })(), "done");
});
