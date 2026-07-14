import assert from "node:assert/strict";
import test from "node:test";
import { parseByteRange } from "./drugAssetResponse.js";

test("drug asset byte ranges support explicit, open, and suffix forms", () => {
  assert.deepEqual(parseByteRange("bytes=0-99", 1_000), { start: 0, end: 99 });
  assert.deepEqual(parseByteRange("bytes=900-", 1_000), { start: 900, end: 999 });
  assert.deepEqual(parseByteRange("bytes=-100", 1_000), { start: 900, end: 999 });
  assert.deepEqual(parseByteRange("bytes=0-9999", 1_000), { start: 0, end: 999 });
});

test("drug asset byte ranges reject malformed and unsatisfiable requests", () => {
  assert.equal(parseByteRange(undefined, 1_000), undefined);
  assert.equal(parseByteRange("bytes=1000-", 1_000), null);
  assert.equal(parseByteRange("bytes=20-10", 1_000), null);
  assert.equal(parseByteRange("bytes=0-1,4-5", 1_000), null);
});
