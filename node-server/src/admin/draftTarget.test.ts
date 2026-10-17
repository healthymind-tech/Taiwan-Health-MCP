/**
 * A draft test that names a saved account only gets that account's stored key
 * when it calls the account's own endpoint.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { draftBaseUrl, draftTargetsAccount } from "./adminSettings.js";

const stored = { provider: "siliconflow", base_url: "https://api.siliconflow.cn/v1" };

test("same provider and URL (trailing slash / case aside) targets the account", () => {
  assert.equal(draftTargetsAccount({ provider: "siliconflow", base_url: "https://API.siliconflow.cn/v1/" }, stored), true);
});

test("another URL or provider does not (the stored key must not travel there)", () => {
  assert.equal(draftTargetsAccount({ provider: "siliconflow", base_url: "https://evil.example.com/v1" }, stored), false);
  assert.equal(draftTargetsAccount({ provider: "openai_compatible", base_url: stored.base_url }, stored), false);
});

test("fixed-URL providers always call their official endpoint", () => {
  assert.match(draftBaseUrl({ provider: "openai", base_url: "https://evil.example.com/v1" }), /api\.openai\.com/);
  assert.equal(draftTargetsAccount({ provider: "openai", base_url: "https://evil.example.com/v1" }, { provider: "openai", base_url: "https://api.openai.com/v1" }), true);
});
