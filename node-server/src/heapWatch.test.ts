/** heapWatch: alert after a sustained high live heap, rotation after a sustained higher one, the bounded drain. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Drain, HeapWatch, heapWatchOptionsFromEnv } from "./heapWatch.js";

const MIN = 60_000;

test("alert: only after the ratio stayed above it for the whole window; cleared once below", () => {
  const w = new HeapWatch({ alertRatio: 0.75, alertMs: 10 * MIN, rotateRatio: 0, rotateMs: 0, emergencyRatio: 0 }, () => assert.fail("no rotation"));
  w.sample(0.8, 0);
  w.sample(0.8, 9 * MIN);
  assert.equal(w.alert, 0);
  w.sample(0.7, 9.5 * MIN); // a dip resets the window
  w.sample(0.8, 10 * MIN);
  w.sample(0.8, 19 * MIN);
  assert.equal(w.alert, 0);
  w.sample(0.8, 20 * MIN);
  assert.equal(w.alert, 1);
  w.sample(0.6, 21 * MIN);
  assert.equal(w.alert, 0);
});

test("rotation: high for the window (dips above the alert ratio keep the clock), now above the rotation ratio; once", () => {
  const rotations: number[] = [];
  const w = new HeapWatch({ alertRatio: 0.75, alertMs: 10 * MIN, rotateRatio: 0.85, rotateMs: 5 * MIN, emergencyRatio: 0.95 }, (r) => rotations.push(r));
  w.sample(0.9, 0);
  w.sample(0.84, 2 * MIN); // a dip below 0.85 but above 0.75: the clock keeps running (soak 2026-11-15)
  w.sample(0.9, 4 * MIN);
  assert.deepEqual(rotations, []);
  w.sample(0.83, 5 * MIN); // window passed, but not above the rotation ratio now
  assert.deepEqual(rotations, []);
  w.sample(0.88, 6 * MIN);
  assert.deepEqual(rotations, [0.88]);
  w.sample(0.97, 30 * MIN);
  assert.equal(rotations.length, 1, "a rotation is started once");
});

test("rotation: a dip below the alert ratio restarts the window; above the emergency ratio it rotates at once", () => {
  const rotations: number[] = [];
  const w = new HeapWatch({ alertRatio: 0.75, alertMs: 10 * MIN, rotateRatio: 0.85, rotateMs: 5 * MIN, emergencyRatio: 0.95 }, (r) => rotations.push(r));
  w.sample(0.9, 0);
  w.sample(0.6, 3 * MIN);
  w.sample(0.9, 4 * MIN);
  w.sample(0.9, 8 * MIN);
  assert.deepEqual(rotations, [], "only 4 min above since the dip");
  w.sample(0.96, 8.5 * MIN);
  assert.deepEqual(rotations, [0.96]);
});

test("ratio 0 turns alert and rotation off", () => {
  const w = new HeapWatch({ alertRatio: 0, alertMs: 0, rotateRatio: 0, rotateMs: 0, emergencyRatio: 0 }, () => assert.fail("no rotation"));
  w.sample(0.99, 0);
  w.sample(0.99, 100 * MIN);
  assert.equal(w.alert, 0);
});

test("drain: refuses new requests once started, resolves when the last in flight leaves", async () => {
  const d = new Drain();
  assert.equal(d.enter(), true);
  assert.equal(d.enter(), true);
  d.startDrain();
  assert.equal(d.enter(), false, "new requests are refused");
  const done = d.drained(10_000);
  d.leave();
  assert.equal(d.active, 1);
  d.leave();
  assert.equal(await done, true);
});

test("drain: the bound wins over a request that never finishes", async () => {
  const d = new Drain();
  d.enter();
  d.startDrain();
  assert.equal(await d.drained(20), false);
  assert.equal(await new Drain().drained(20), true, "nothing in flight: drained at once");
});

test("options from env: defaults 0.75 / 10 min, 0.85 / 5 min", () => {
  const keys = ["MCP_HEAP_ALERT_RATIO", "MCP_HEAP_ALERT_MINUTES", "MCP_HEAP_ROTATE_RATIO", "MCP_HEAP_ROTATE_MINUTES", "MCP_HEAP_EMERGENCY_RATIO"];
  const saved = keys.map((k) => process.env[k]);
  try {
    for (const k of keys) delete process.env[k];
    assert.deepEqual(heapWatchOptionsFromEnv(), { alertRatio: 0.75, alertMs: 10 * MIN, rotateRatio: 0.85, rotateMs: 5 * MIN, emergencyRatio: 0.95 });
    process.env.MCP_HEAP_ROTATE_RATIO = "0";
    process.env.MCP_HEAP_ALERT_MINUTES = "2";
    assert.equal(heapWatchOptionsFromEnv().rotateRatio, 0);
    assert.equal(heapWatchOptionsFromEnv().alertMs, 2 * MIN);
  } finally {
    keys.forEach((k, i) => (saved[i] === undefined ? delete process.env[k] : (process.env[k] = saved[i])));
  }
});

test("event-loop lag alert: on above the threshold for an interval, cleared below; 0 = off", async () => {
  const { LagWatch, lagAlertMsFromEnv } = await import("./heapWatch.js");
  const w = new LagWatch(10_000);
  w.check(3_000);
  assert.equal(w.alert, 0);
  w.check(12_000);
  assert.equal(w.alert, 1);
  w.check(800);
  assert.equal(w.alert, 0);
  assert.equal(new LagWatch(0).sample(), 0, "off");
  const saved = process.env.MCP_EVENT_LOOP_ALERT_MS;
  delete process.env.MCP_EVENT_LOOP_ALERT_MS;
  assert.equal(lagAlertMsFromEnv(), 10_000);
  if (saved !== undefined) process.env.MCP_EVENT_LOOP_ALERT_MS = saved;
});
