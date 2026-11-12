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
