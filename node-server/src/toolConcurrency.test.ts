import { test } from "node:test";
import assert from "node:assert/strict";
import { BUSY_CODE, MemoryPressureError, ToolGate, admitMemory, gateOptionsFromEnv, maybeShedCaches, oneAtATime, withConcurrencyLimit } from "./toolConcurrency.js";

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

test("memory guard: a heavy call does not start while the live heap is above the ratio (BUSY reason memory); light tools and ratio 0 are never checked", async () => {
  const gate = new ToolGate({ limit: 2, queueTimeoutMs: 1000, maxQueue: 4, heapRatio: 0.8 });
  let ran = 0;
  const handler = async (): Promise<string> => {
    ran++;
    return "done";
  };
  const high = withConcurrencyLimit("fhir_validate_bundle", handler, () => gate, undefined, { ratio: () => 0.9 });
  const r = (await high()) as unknown as { isError: boolean; content: Array<{ text: string }> };
  assert.equal(r.isError, true);
  const body = JSON.parse(r.content[0].text);
  assert.equal(body.error.code, BUSY_CODE);
  assert.equal(body.error.reason, "memory");
  assert.equal(body.error.retry_after_s, 15);
  assert.equal(ran, 0);
  assert.equal(gate.stats().running, 0, "the slot is released");
  assert.equal(await withConcurrencyLimit("fhir_validate_bundle", handler, () => gate, undefined, { ratio: () => 0.5 })(), "done");
  assert.equal(await withConcurrencyLimit("search_loinc", handler, () => gate, undefined, { ratio: () => 0.99 })(), "done");
  const off = new ToolGate({ limit: 2, queueTimeoutMs: 1000, maxQueue: 4, heapRatio: 0 });
  assert.equal(await withConcurrencyLimit("fhir_validate_bundle", handler, () => off, undefined, { ratio: () => 0.99 })(), "done");
});

test("memory guard covers every tool: a light tool does not start above its own ratio, starts below it, never waits for a slot", async () => {
  const gate = new ToolGate({ limit: 1, queueTimeoutMs: 1000, maxQueue: 4, heapRatio: 0.8, lightHeapRatio: 0.9 });
  let ran = 0;
  const handler = async (): Promise<string> => {
    ran++;
    return "done";
  };
  const r = (await withConcurrencyLimit("search_loinc", handler, () => gate, undefined, { ratio: () => 0.95 })()) as unknown as { isError: boolean; content: Array<{ text: string }> };
  assert.equal(r.isError, true);
  const body = JSON.parse(r.content[0].text);
  assert.equal(body.error.code, BUSY_CODE);
  assert.equal(body.error.reason, "memory");
  assert.equal(body.error.tool, "search_loinc");
  assert.equal(ran, 0);
  // between the two ratios: heavy tools are refused, light tools still run
  assert.equal(((await withConcurrencyLimit("fhir_validate_bundle", handler, () => gate, undefined, { ratio: () => 0.85 })()) as unknown as { isError: boolean }).isError, true);
  assert.equal(await withConcurrencyLimit("search_loinc", handler, () => gate, undefined, { ratio: () => 0.85 })(), "done");
  // light tools hold no slot: one runs while the only heavy slot is taken
  assert.equal(await gate.acquire(), true);
  assert.equal(await withConcurrencyLimit("search_loinc", handler, () => gate, undefined, { ratio: () => 0.1 })(), "done");
  gate.release();
});

test("gateOptionsFromEnv: light-tool memory ratio defaults to 0.9, MCP_TOOL_HEAP_RATIO overrides it", () => {
  const saved = process.env.MCP_TOOL_HEAP_RATIO;
  try {
    delete process.env.MCP_TOOL_HEAP_RATIO;
    assert.equal(gateOptionsFromEnv().lightHeapRatio, 0.9);
    process.env.MCP_TOOL_HEAP_RATIO = "0";
    assert.equal(gateOptionsFromEnv().lightHeapRatio, 0);
  } finally {
    if (saved === undefined) delete process.env.MCP_TOOL_HEAP_RATIO;
    else process.env.MCP_TOOL_HEAP_RATIO = saved;
  }
});

test("heapUsedRatio reads the live heap after a major GC, not the garbage-filled used size", async () => {
  const { heapUsedRatio } = await import("./toolConcurrency.js");
  heapUsedRatio(); // starts the observer
  const before = heapUsedRatio();
  let junk: unknown[] = [];
  for (let i = 0; i < 2_000_000; i++) junk.push({ i, s: "x".repeat(8) });
  junk = [];
  const gc = (globalThis as { gc?: () => void }).gc;
  if (gc) gc();
  await new Promise((r) => setTimeout(r, 50)); // the observer callback runs on the next tick
  const after = heapUsedRatio();
  assert.ok(after >= 0 && after < 1, String(after));
  if (gc) assert.ok(after > 0 && after !== before, `a major GC was observed (${before} → ${after})`);
});

test("cache shedding: above the shed ratio after a major GC the caches shed half, at most once a minute; 0 = off", () => {
  const calls: number[] = [];
  const shed = (f: number): number => {
    calls.push(f);
    return 0;
  };
  const t0 = 10_000_000;
  assert.equal(maybeShedCaches(0.6, t0, 0.7, shed), false, "below the ratio: nothing");
  assert.equal(maybeShedCaches(0.75, t0, 0.7, shed), true);
  assert.equal(maybeShedCaches(0.9, t0 + 30_000, 0.7, shed), false, "within a minute of the last shed");
  assert.equal(maybeShedCaches(0.9, t0 + 61_000, 0.7, shed), true);
  assert.equal(maybeShedCaches(0.99, t0 + 200_000, 0, shed), false, "ratio 0 = off");
  assert.deepEqual(calls, [0.5, 0.5]);
});

test("memory admission: a build fits → runs; fits after the caches are emptied → runs; else refused", () => {
  const GB = 1 << 30;
  const heap = (live: number) => ({ live: () => live, limit: () => 6 * GB });
  let shed = 0;
  const shedder = (released: number) => (f: number): number => {
    assert.equal(f, 1, "everything cached goes");
    shed++;
    return released;
  };
  admitMemory(1 * GB, "x", 0.85, shedder(0), heap(3 * GB)); // 4 of 6 GB = 0.67
  assert.equal(shed, 0);
  admitMemory(2 * GB, "x", 0.85, shedder(1 * GB), heap(4 * GB)); // 6 → after 1 GB released 5 of 6 = 0.83
  assert.equal(shed, 1);
  assert.throws(() => admitMemory(2 * GB, "the concept index of S", 0.85, shedder(0.2 * GB), heap(4 * GB)), (e: unknown) => e instanceof MemoryPressureError && /concept index of S/.test((e as Error).message));
  admitMemory(100 * GB, "x", 0, shedder(0), heap(4 * GB)); // ratio 0 = off
});

test("a refused build turns the whole tool call into BUSY (memory), also when the tool swallowed the error", async () => {
  const GB = 1 << 30;
  const gate = new ToolGate({ limit: 2, queueTimeoutMs: 1000, maxQueue: 4, heapRatio: 0.8, lightHeapRatio: 0.9 });
  const handler = async (): Promise<string> => {
    try {
      admitMemory(3 * GB, "an index", 0.85, () => 0, { live: () => 4 * GB, limit: () => 6 * GB });
    } catch {
      return "degraded result"; // a caller that falls back silently
    }
    return "full result";
  };
  for (const tool of ["fhir_finalize_bundle", "fhir_normalize_code"]) {
    const r = (await withConcurrencyLimit(tool, handler, () => gate, undefined, { ratio: () => 0.1 })()) as unknown as { isError: boolean; content: Array<{ text: string }> };
    assert.equal(r.isError, true, tool);
    const body = JSON.parse(r.content[0].text);
    assert.equal(body.error.code, BUSY_CODE);
    assert.equal(body.error.reason, "memory");
  }
  const ok = withConcurrencyLimit("fhir_normalize_code", async () => "fine", () => gate, undefined, { ratio: () => 0.1 });
  assert.equal(await ok(), "fine", "a call without a refusal is unchanged");
});

test("oneAtATime: large builds run one after another, a failed one does not block the next", async () => {
  let running = 0;
  let peak = 0;
  const job = (fail: boolean) => async (): Promise<number> => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 5));
    running--;
    if (fail) throw new Error("boom");
    return 1;
  };
  const r = await Promise.allSettled([oneAtATime(job(false)), oneAtATime(job(true)), oneAtATime(job(false))]);
  assert.deepEqual(r.map((x) => x.status), ["fulfilled", "rejected", "fulfilled"]);
  assert.equal(peak, 1);
});
