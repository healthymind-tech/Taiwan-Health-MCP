/**
 * Backoff between `llm_unavailable` auto-resume cycles: doubles per attempt
 * (2min → 4 → 8 → 16) and caps at 30min so a dead LM never churns a job on a
 * fast cadence, but the job still retries on its own instead of parking.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { llmUnavailableBackoffMs } from "./adminJobs.js";

test("llmUnavailableBackoffMs doubles per attempt", () => {
  assert.equal(llmUnavailableBackoffMs(1), 2 * 60_000);
  assert.equal(llmUnavailableBackoffMs(2), 4 * 60_000);
  assert.equal(llmUnavailableBackoffMs(3), 8 * 60_000);
  assert.equal(llmUnavailableBackoffMs(4), 16 * 60_000);
});

test("llmUnavailableBackoffMs caps at 30 minutes", () => {
  assert.equal(llmUnavailableBackoffMs(5), 30 * 60_000);
  assert.equal(llmUnavailableBackoffMs(50), 30 * 60_000);
});
