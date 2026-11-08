/** Caches bounded by estimated bytes, least recently used out (staging heap profile 2026-11-08). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { envBudgetBytes, estimateBytes } from "./memSize.js";
import { TtlCache } from "./fhirTerminology.js";
import { TtlMemo } from "./ttlMemo.js";
import { ConceptIndex } from "./conceptSearch/engine.js";

test("estimateBytes grows with content, counts Maps / Sets and shared objects once", () => {
  const small = estimateBytes({ a: "x" });
  const big = estimateBytes({ a: "x".repeat(10_000) });
  assert.ok(big > small + 19_000, `${small} ${big}`);
  const m = new Map<string, Set<string>>([["k", new Set(["a", "b"])]]);
  assert.ok(estimateBytes(m) > estimateBytes(new Map()), "Map entries count");
  const shared = { s: "y".repeat(1000) };
  const one = estimateBytes([shared]);
  assert.ok(estimateBytes([shared, shared]) < one + 100, "a shared object counts once");
  const cyc: Record<string, unknown> = {};
  cyc.self = cyc;
  assert.ok(estimateBytes(cyc) > 0, "cycles terminate");
  assert.equal(envBudgetBytes("NO_SUCH_BUDGET_VAR", 3), 3 * 1048576);
});

test("TtlCache: weight in bytes, eviction least recently used (a hit refreshes)", () => {
  const c = new TtlCache<string>(100);
  c.set("a", "A", 40);
  c.set("b", "B", 40);
  assert.equal(c.get("a"), "A"); // a is now the most recently used
  c.set("c", "C", 40); // over 100: b (least recently used) goes, not a
  assert.equal(c.get("b"), undefined);
  assert.equal(c.get("a"), "A");
  assert.equal(c.get("c"), "C");
  assert.equal(c.weight, 80);
  c.set("huge", "H", 101); // larger than the whole budget: not held, nothing evicted
  assert.equal(c.get("huge"), undefined);
  assert.equal(c.size, 2);
});

test("TtlMemo with a byte budget: settled values are weighed and evicted least recently used", async () => {
  const m = new TtlMemo<string>(60_000, 100, 4000);
  const v = (n: number): string => "z".repeat(n);
  await m.get("a", async () => v(500)); // ~1.6 KB estimated
  await m.get("b", async () => v(500));
  await m.get("a", async () => "recomputed"); // hit: a refreshed
  await m.get("c", async () => v(500)); // ~4.8 KB in all: over budget → b out
  await new Promise((r) => setImmediate(r));
  assert.equal(m.has("b"), false);
  assert.equal(m.has("a"), true);
  assert.equal(m.has("c"), true);
  assert.equal(await m.get("a", async () => "recomputed"), v(500), "a kept its value");
  assert.ok(m.weight <= 4000, String(m.weight));
  // a value larger than the budget is answered but not held
  assert.equal(await m.get("big", async () => v(5000)), v(5000));
  await new Promise((r) => setImmediate(r));
  assert.equal(m.has("big"), false);
  // without a byte budget: entry bound only, weight 0
  const plain = new TtlMemo<string>(60_000, 2);
  await plain.get("x", async () => v(10_000));
  assert.equal(plain.weight, 0);
  assert.equal(plain.has("x"), true);
});

test("a ConceptIndex's estimate scales with its terms", () => {
  const mk = (n: number) => new ConceptIndex(Array.from({ length: n }, (_, i) => ({ code: `C${i}`, display: `concept number ${i} of the test set`, terms: [{ text: `concept number ${i} of the test set`, lang: "en", kind: "display" as const }] })));
  const a = estimateBytes(mk(100));
  const b = estimateBytes(mk(1000));
  assert.ok(b > 5 * a, `${a} ${b}`);
});
