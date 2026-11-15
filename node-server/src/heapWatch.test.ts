/** heapWatch: alert after a sustained high live heap, rotation after a sustained higher one, the bounded drain. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Drain, HeapWatch, heapWatchOptionsFromEnv } from "./heapWatch.js";

const MIN = 60_000;

test("alert: only after the ratio stayed above it for the whole window; cleared once below", () => {
  const w = new HeapWatch({ alertRatio: 0.75, alertMs: 10 * MIN, rotateRatio: 0, rotateMs: 0 }, () => assert.fail("no rotation"));
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

test("rotation: once, after the ratio stayed above the rotation ratio for the window", () => {
  const rotations: number[] = [];
  const w = new HeapWatch({ alertRatio: 0.75, alertMs: 10 * MIN, rotateRatio: 0.85, rotateMs: 5 * MIN }, (r) => rotations.push(r));
  w.sample(0.9, 0);
  w.sample(0.8, 2 * MIN); // between: alert window keeps running, rotation window restarts
  w.sample(0.9, 3 * MIN);
  w.sample(0.9, 7 * MIN);
  assert.deepEqual(rotations, []);
  w.sample(0.92, 8 * MIN);
  assert.deepEqual(rotations, [0.92]);
  w.sample(0.95, 30 * MIN);
  assert.equal(rotations.length, 1, "a rotation is started once");
});

test("ratio 0 turns alert and rotation off", () => {
  const w = new HeapWatch({ alertRatio: 0, alertMs: 0, rotateRatio: 0, rotateMs: 0 }, () => assert.fail("no rotation"));
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
  const keys = ["MCP_HEAP_ALERT_RATIO", "MCP_HEAP_ALERT_MINUTES", "MCP_HEAP_ROTATE_RATIO", "MCP_HEAP_ROTATE_MINUTES"];
  const saved = keys.map((k) => process.env[k]);
  try {
    for (const k of keys) delete process.env[k];
    assert.deepEqual(heapWatchOptionsFromEnv(), { alertRatio: 0.75, alertMs: 10 * MIN, rotateRatio: 0.85, rotateMs: 5 * MIN });
    process.env.MCP_HEAP_ROTATE_RATIO = "0";
    process.env.MCP_HEAP_ALERT_MINUTES = "2";
    assert.equal(heapWatchOptionsFromEnv().rotateRatio, 0);
    assert.equal(heapWatchOptionsFromEnv().alertMs, 2 * MIN);
  } finally {
    keys.forEach((k, i) => (saved[i] === undefined ? delete process.env[k] : (process.env[k] = saved[i])));
  }
});
