/** singleFlight: concurrent calls share one initialisation; a later call after a failure starts a new one. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { singleFlight } from "./singleFlight.js";

test("concurrent callers share one call; after it settles the next call runs again", async () => {
  let built = 0;
  const get = singleFlight(async () => {
    built++;
    await new Promise((r) => setTimeout(r, 5));
    return { n: built };
  });
  const [a, b, c] = await Promise.all([get(), get(), get()]);
  assert.equal(built, 1);
  assert.equal(a, b);
  assert.equal(b, c);
  await get();
  assert.equal(built, 2, "a settled call is not cached here (the getter caches its own instance)");
});

test("a failed call is shared by its concurrent callers and retried by the next", async () => {
  let calls = 0;
  const get = singleFlight(async () => {
    calls++;
    if (calls === 1) throw new Error("db down");
    return "ok";
  });
  const r = await Promise.allSettled([get(), get()]);
  assert.deepEqual(r.map((x) => x.status), ["rejected", "rejected"]);
  assert.equal(await get(), "ok");
  assert.equal(calls, 2);
});
