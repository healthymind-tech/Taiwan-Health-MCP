import assert from "node:assert/strict";
import test from "node:test";
import { TtlMemo } from "./ttlMemo.js";

test("TtlMemo: one computation per key while fresh, in-flight sharing, null values held", async () => {
  const memo = new TtlMemo<string | null>(60_000, 10);
  let calls = 0;
  const compute = async (): Promise<string | null> => {
    calls++;
    return calls === 1 ? "first" : null;
  };
  const [a, b] = await Promise.all([memo.get("k", compute), memo.get("k", compute)]);
  assert.equal(a, "first");
  assert.equal(b, "first", "concurrent callers share the in-flight lookup");
  assert.equal(await memo.get("k", compute), "first");
  assert.equal(calls, 1);
  assert.equal(await memo.get("n", async () => null), null);
  assert.equal(memo.has("n"), true, "a null answer is a cached answer");
  assert.equal(await memo.get("n", async () => "changed"), null);
});

test("TtlMemo: a rejected lookup is not remembered; a fresher entry is not evicted by an old rejection", async () => {
  const memo = new TtlMemo<number>(60_000, 10);
  let n = 0;
  const failing = memo.get("k", async () => {
    throw new Error("db down");
  });
  await assert.rejects(failing, /db down/);
  assert.equal(memo.has("k"), false);
  assert.equal(await memo.get("k", async () => ++n), 1);
  assert.equal(await memo.get("k", async () => ++n), 1, "the successful answer is held");
  // An in-flight failure resolving after a replacement must not drop the replacement.
  let reject!: (e: Error) => void;
  const slow = memo.get("s", () => new Promise<number>((_, rej) => (reject = rej)));
  slow.catch(() => undefined);
  memo.set("s", 42);
  reject(new Error("late"));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(await memo.peek("s"), 42);
});

test("TtlMemo: expiry and bounded size (FIFO)", async () => {
  const memo = new TtlMemo<number>(5, 2);
  await memo.get("a", async () => 1);
  await memo.get("b", async () => 2);
  await memo.get("c", async () => 3);
  assert.equal(memo.size, 2);
  assert.equal(memo.has("a"), false, "oldest entry evicted beyond the bound");
  assert.equal(memo.has("c"), true);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(memo.has("c"), false, "expired");
  assert.equal(memo.peek("c"), undefined);
  assert.equal(await memo.get("c", async () => 4), 4, "recomputed after expiry");
});
