/**
 * release v1 (staging OOM 2026-11-01): the process-wide terminology cache is bounded by weight as well as by count —
 * a few large CodeSystem indexes must not pin the heap.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { TtlCache } from "./fhirTerminology.js";

test("TtlCache: FIFO eviction by summed weight; a value heavier than the budget is not held", () => {
  const c = new TtlCache<string>(100);
  c.set("a", "A", 40);
  c.set("b", "B", 40);
  assert.equal(c.weight, 80);
  c.set("c", "C", 40); // evicts a
  assert.equal(c.get("a"), undefined);
  assert.equal(c.get("b"), "B");
  assert.equal(c.weight, 80);
  c.set("huge", "H", 101);
  assert.equal(c.get("huge"), undefined);
  assert.equal(c.size, 2);
  c.set("b", "B2", 10); // replacing a key releases its old weight
  assert.equal(c.weight, 50);
});
