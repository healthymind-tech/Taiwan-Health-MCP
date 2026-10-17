/**
 * Fingerprint comparison: the same model (small numeric drift, e.g. another
 * provider or quantisation) passes; a different model with the same dimensions
 * (unrelated directions) fails.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { compareFingerprint, MIN_SIMILARITY, PROBE_TEXTS } from "./embeddingIdentity.js";

let seed = 42;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
const vec = (n = 1024) => Array.from({ length: n }, rnd);
const anchor = PROBE_TEXTS.map(() => vec());

test("same model with provider/quantisation drift passes", () => {
  const drifted = anchor.map((v) => v.map((x) => x + rnd() * 0.05));
  const r = compareFingerprint(drifted, anchor);
  assert.ok(r.ok, `min ${r.min}`);
  assert.ok(r.min > 0.99);
});

test("a different model (unrelated vectors, same dims) fails", () => {
  const other = anchor.map(() => vec());
  const r = compareFingerprint(other, anchor);
  assert.equal(r.ok, false);
  assert.ok(Math.abs(r.mean) < 0.1);
});

test("one diverging probe is enough to fail; size mismatch fails", () => {
  const mixed = anchor.map((v, i) => (i === 3 ? vec() : v));
  assert.equal(compareFingerprint(mixed, anchor).ok, false);
  assert.equal(compareFingerprint(anchor.map((v) => v.slice(0, 512)), anchor).ok, false);
  assert.ok(MIN_SIMILARITY >= 0.9 && MIN_SIMILARITY < 0.999);
});
