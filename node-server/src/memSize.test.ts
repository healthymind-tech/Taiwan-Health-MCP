/** memSize: the cache registry behind the mcp_cache_* gauges (labels = where the cache was built, weakly held). */

import { test } from "node:test";
import assert from "node:assert/strict";
import { trackedCacheStats } from "./memSize.js";
import { TtlMemo } from "./ttlMemo.js";
import { TtlCache } from "./fhirTerminology.js";

test("TtlMemo and TtlCache register themselves under their construction site and report entries / estimated bytes", async () => {
  const memo = new TtlMemo<string>(60_000, 10, 1 << 20);
  const cache = new TtlCache<string>(1 << 20);
  const counted = new TtlCache<string>();
  await memo.get("k", async () => "x".repeat(1000));
  await new Promise((r) => setTimeout(r, 0)); // the size is estimated once the lookup settled
  cache.set("a", "v", 500);
  counted.set("b", "v");
  const site = (line: number): string => `memSize.test.ts:${line}`;
  const stats = new Map(trackedCacheStats().map((s) => [s.name, s]));
  const m = stats.get(site(10));
  assert.ok(m, `the memo is labelled by its construction site: ${[...stats.keys()].join(", ")}`);
  assert.equal(m.entries, 1);
  assert.ok(m.bytes > 1000, "the settled value's estimated size");
  assert.deepEqual(stats.get(site(11)), { name: site(11), entries: 1, bytes: 500 });
  assert.deepEqual(stats.get(site(12)), { name: site(12), entries: 1, bytes: 0 }, "a count-bounded cache reports no bytes");
});

test("shedTrackedCaches: every tracked cache drops its least recently used half and reports the bytes released", async () => {
  const { shedTrackedCaches } = await import("./memSize.js");
  const memo = new TtlMemo<string>(60_000, 100, 1 << 30);
  for (let i = 0; i < 10; i++) await memo.get(`k${i}`, async () => "v".repeat(1000));
  await new Promise((r) => setTimeout(r, 0));
  await memo.get("k0", async () => "unused"); // k0 becomes the most recently used
  const cache = new TtlCache<string>(1 << 30);
  for (let i = 0; i < 4; i++) cache.set(`c${i}`, "v", 1000);
  const before = memo.weight;
  const released = shedTrackedCaches(0.5);
  assert.equal(memo.size, 5);
  assert.ok(memo.has("k0"), "the most recently used entry stays");
  assert.ok(!memo.has("k1"), "the least recently used go first");
  assert.equal(cache.size, 2);
  assert.ok(cache.get("c3") !== undefined && cache.get("c0") === undefined);
  assert.ok(released >= before - memo.weight + 2000, `released ${released}`);
});

test("estimateBytesAsync gives exactly estimateBytes, in slices", async () => {
  const { estimateBytes, estimateBytesAsync } = await import("./memSize.js");
  const shared = { s: "x".repeat(100) };
  const value = { a: Array.from({ length: 5000 }, (_, i) => ({ i, t: `term ${i}`, shared })), m: new Map([["k", [1, 2, 3]]]), set: new Set(["a", "b"]) };
  assert.equal(await estimateBytesAsync(value, Infinity, 100), estimateBytes(value));
  assert.equal(await estimateBytesAsync(value, 10_000, 100), estimateBytes(value, 10_000), "the limit stops both at the same point");
});

test("TtlCache shared: one object held under several keys is weighed once; the weight moves when its payer goes", () => {
  const idx = { big: true };
  const other = { big: true };
  const c = new TtlCache<object>(1100, 100, (v) => v);
  c.set("closure-A|icd", idx, 600);
  c.set("closure-B|icd", idx, 600); // same index through another closure
  c.set("closure-C|icd", idx, 600);
  assert.equal(c.size, 3, "all three held: the budget sees one 600-byte index, not 1800");
  assert.ok(c.weight < 600 + 3 * 64 + 1, `weight ${c.weight}`);
  c.set("closure-A|pcs", other, 300); // distinct content still fits (600 + 300 + 2 × 64)
  assert.equal(c.size, 4);
  c.shed(0.25); // drops the oldest: closure-A|icd, the payer
  assert.equal(c.size, 3);
  assert.ok(c.weight >= 600 + 300, `another holder took the 600 over: ${c.weight}`);
  c.set("closure-D|x", { other: 1 }, 200); // 600 + 300 + 64 + 200 > 1100: the least recently used go first
  assert.ok(c.weight <= 1100, `stays within the budget: ${c.weight}`);
  const plain = new TtlCache<object>(1000);
  plain.set("a", idx, 600);
  plain.set("b", idx, 600);
  assert.equal(plain.size, 1, "without `shared` every key pays (unchanged)");
});

test("estimateBytes walks large containers child by child and still counts exactly what the one-visit walk counted", async () => {
  const { estimateBytes, estimateBytesAsync } = await import("./memSize.js");
  // the walk before v22 G6 (all children pushed in one visit), as the reference
  const reference = (value: unknown): number => {
    const seen = new WeakSet<object>();
    const stack: unknown[] = [value];
    let total = 0;
    while (stack.length) {
      const v = stack.pop();
      if (v === null || v === undefined) continue;
      if (typeof v === "string") total += 16 + 2 * v.length;
      else if (typeof v === "number") total += 8;
      else if (typeof v === "object") {
        if (seen.has(v)) continue;
        seen.add(v);
        const push = (x: unknown): void => void (x !== null && (typeof x === "object" || typeof x === "string") && stack.push(x));
        if (Array.isArray(v)) {
          total += 32 + 8 * v.length;
          v.forEach(push);
        } else if (v instanceof Map) {
          total += 24 + 40 * v.size;
          for (const [k, x] of v) {
            if (typeof k === "string" || (k !== null && typeof k === "object")) stack.push(k);
            push(x);
          }
        } else if (v instanceof Set) {
          total += 24 + 40 * v.size;
          v.forEach(push);
        } else {
          const keys = Object.keys(v);
          total += 24 + 8 * keys.length;
          for (const k of keys) {
            const x = (v as Record<string, unknown>)[k];
            if (typeof x === "number") total += 8;
            else push(x);
          }
        }
      }
    }
    return Math.round(total * 1.5);
  };
  const shared = { name: "shared", list: Array.from({ length: 100 }, (_, i) => `s${i}`) };
  const concepts = new Map(Array.from({ length: 5000 }, (_, i) => [`C${i}`, { code: `C${i}`, n: i, parents: new Set(i ? [`C${i - 1}`] : []), shared, terms: Array.from({ length: i % 90 }, (_, j) => `t${j}`) }]));
  const value = { concepts, lower: new Map([...concepts.keys()].map((k) => [k.toLowerCase(), k])), big: Array.from({ length: 3000 }, (_, i) => (i % 3 ? { i } : shared)) };
  const want = reference(value);
  assert.equal(estimateBytes(value), want);
  assert.equal(await estimateBytesAsync(value, Infinity, 100), want);
});
