/**
 * Unit coverage for the bounded batch dispatcher behind concurrent embed jobs.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { clampConcurrency, runBoundedPool } from "./batchPool.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A task factory that records in-flight peaks and per-index run counts. */
function tracker(delayMs: (i: number) => number = () => 5) {
  let inFlight = 0;
  let maxInFlight = 0;
  const runs = new Map<number, number>();
  const task = async (i: number): Promise<void> => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    runs.set(i, (runs.get(i) ?? 0) + 1);
    try {
      await sleep(delayMs(i));
    } finally {
      inFlight -= 1;
    }
  };
  return { task, runs, max: () => maxInFlight, now: () => inFlight };
}

test("never exceeds the concurrency limit and runs every index exactly once", async () => {
  for (const limit of [1, 3, 8]) {
    const t = tracker((i) => 2 + (i % 5));
    const res = await runBoundedPool({ count: 50, concurrency: () => limit, task: t.task });
    assert.equal(t.max(), limit, `peak in-flight for limit ${limit}`);
    assert.equal(res.completed, 50);
    assert.equal(res.dispatched, 50);
    assert.equal(res.stopped, false);
    assert.deepEqual([...t.runs.keys()].sort((a, b) => a - b), [...Array(50).keys()]);
    assert.ok([...t.runs.values()].every((n) => n === 1), "no index ran twice");
  }
});

test("limit is re-read on every dispatch (hot reload), and clamped", async () => {
  const t = tracker(() => 3);
  let limit = 2;
  let peakAfterRaise = 0;
  const res = await runBoundedPool({
    count: 40,
    concurrency: () => limit,
    task: async (i) => {
      if (i === 10) limit = 6;
      if (i > 20) peakAfterRaise = Math.max(peakAfterRaise, t.now() + 1);
      await t.task(i);
    },
  });
  assert.equal(res.completed, 40);
  assert.ok(t.max() <= 6);
  assert.equal(peakAfterRaise, 6, "raised limit took effect mid-run");

  assert.equal(clampConcurrency(0), 1);
  assert.equal(clampConcurrency("junk"), 1);
  assert.equal(clampConcurrency(4.7), 4);
  assert.equal(clampConcurrency(1000), 32);
});

test("shouldStop stops new dispatch but lets in-flight tasks finish", async () => {
  const t = tracker(() => 10);
  let finishedAfterStop = 0;
  let stopAsked = false;
  const res = await runBoundedPool({
    count: 100,
    concurrency: () => 4,
    shouldStop: () => {
      if (t.runs.size >= 9) stopAsked = true;
      return stopAsked;
    },
    task: async (i) => {
      await t.task(i);
      if (stopAsked) finishedAfterStop += 1;
    },
  });
  assert.equal(res.stopped, true);
  assert.ok(res.dispatched < 100);
  assert.equal(res.completed, res.dispatched, "every dispatched task completed (drained)");
  assert.equal(t.now(), 0, "nothing left in flight when the pool returns");
  assert.ok(finishedAfterStop > 0, "in-flight work landed after the stop request");
  // Dispatched indices are a contiguous prefix: a resume re-derives the rest.
  assert.deepEqual([...t.runs.keys()].sort((a, b) => a - b), [...Array(res.dispatched).keys()]);
  assert.ok(t.max() <= 4);
});

test("shouldStop is not consulted before the first task (matches the old loop)", async () => {
  let calls = 0;
  const res = await runBoundedPool({
    count: 1,
    concurrency: () => 2,
    shouldStop: () => {
      calls += 1;
      return true;
    },
    task: async () => undefined,
  });
  assert.equal(calls, 0);
  assert.equal(res.stopped, false);
  assert.equal(res.completed, 1);
});

test("first error stops dispatch, drains in-flight work, then rethrows", async () => {
  const t = tracker(() => 5);
  const started: number[] = [];
  await assert.rejects(
    runBoundedPool({
      count: 100,
      concurrency: () => 3,
      task: async (i) => {
        started.push(i);
        await t.task(i);
        if (i === 5) throw new Error("boom at 5");
      },
    }),
    /boom at 5/,
  );
  assert.equal(t.now(), 0, "in-flight tasks were awaited before rethrowing");
  assert.ok(started.length < 100, "no new work dispatched after the failure");
  assert.ok(Math.max(...started) <= 5 + 3, "at most a window of tasks past the failing one");
});
