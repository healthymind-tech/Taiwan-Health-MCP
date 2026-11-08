/** A finished request's validation snapshot holds nothing, even when an async resource it created outlives it. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { currentSnapshot, withValidationSnapshot } from "./fhirValidationSnapshot.js";

test("the snapshot is emptied and closed when the request settles; a long-lived resource created inside sees none", async () => {
  const owner = {};
  let inside: ReturnType<typeof currentSnapshot>;
  let later: ReturnType<typeof currentSnapshot> | "unset" = "unset";
  let timer: ReturnType<typeof setInterval> | undefined;
  const ticked = new Promise<void>((resolve) => {
    void withValidationSnapshot(async () => {
      inside = currentSnapshot();
      inside!.pin(owner, "big", { payload: "x".repeat(1000) });
      assert.equal(inside!.size, 1);
      // a keep-alive socket / pooled connection created during the request keeps its async context (the store) alive
      timer = setInterval(() => {
        later = currentSnapshot();
        clearInterval(timer);
        resolve();
      }, 5);
      return "done";
    });
  });
  await ticked;
  assert.equal(inside!.size, 0, "pins dropped");
  assert.equal(inside!.isClosed, true);
  assert.equal(later, undefined, "no snapshot after the request");
  inside!.pin(owner, "again", 1);
  assert.equal(inside!.size, 0, "a closed snapshot pins nothing");
  // nested calls still join the open one; a new request after a closed one gets a fresh snapshot
  await withValidationSnapshot(async () => {
    const outer = currentSnapshot();
    await withValidationSnapshot(async () => assert.equal(currentSnapshot(), outer));
    assert.notEqual(outer, inside);
  });
});

test("a failing request closes its snapshot too", async () => {
  let snap: ReturnType<typeof currentSnapshot>;
  await assert.rejects(
    withValidationSnapshot(async () => {
      snap = currentSnapshot();
      snap!.pin({}, "k", 1);
      throw new Error("boom");
    }),
  );
  assert.equal(snap!.size, 0);
  assert.equal(snap!.isClosed, true);
});
