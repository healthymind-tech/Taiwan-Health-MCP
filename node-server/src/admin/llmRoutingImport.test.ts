/**
 * Settings import of the LLM section: validated in full before anything is
 * written, then applied in one transaction; subscription accounts survive.
 * Runs against a fake pg pool that records every statement.
 */

process.env.DATABASE_URL ??= "postgresql://qa:qa@127.0.0.1:1/qa";

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { initPool } from "../db.js";
import { importRouting, invalidateRoutingCache } from "./llmRouting.js";
import { ProfileValidationError } from "./llmProfiles.js";

const state = {
  accounts: [] as Record<string, unknown>[],
  routes: [] as Record<string, unknown>[],
  members: [] as Record<string, unknown>[],
  statements: [] as { sql: string; params: unknown[] }[],
  nextId: 100,
};

const pool = initPool();
const q = async (sql: string, params: unknown[] = []) => {
  const s = sql.trim().replace(/\s+/g, " ");
  state.statements.push({ sql: s, params });
  if (/^SELECT .* FROM admin\.llm_providers/.test(s)) return { rows: state.accounts };
  if (/^SELECT .* FROM admin\.llm_routes/.test(s)) return { rows: state.routes };
  if (/^SELECT .* FROM admin\.llm_route_members/.test(s)) return { rows: state.members };
  if (/RETURNING id$/.test(s)) return { rows: [{ id: String(state.nextId++) }] };
  return { rows: [] };
};
(pool as unknown as { query: unknown }).query = q;
(pool as unknown as { connect: unknown }).connect = async () => ({ query: q, release() {} });

const writes = () => state.statements.filter((x) => /^(INSERT|DELETE|UPDATE)/.test(x.sql));

beforeEach(() => {
  state.accounts = [
    { id: "5", name: "ChatGPT Pro", provider: "chatgpt", base_url: "https://chatgpt.com/backend-api/codex", auth_type: "oauth", api_key: "", enabled: true, params: { allow_role_use: true }, oauth: { access_token: "t" }, last_test: null, created_at: "", updated_at: "" },
    { id: "6", name: "gpu", provider: "ollama", base_url: "http://gpu:11434", auth_type: "none", api_key: "", enabled: true, params: {}, oauth: null, last_test: null, created_at: "", updated_at: "" },
  ];
  state.routes = [{ id: "9", name: "Main", kind: "analysis", strategy: "fallback", description: "", updated_at: "" }];
  state.members = [
    { id: "90", route_id: "9", member_type: "model", provider_id: "6", model: "qwen3:8b", child_route_id: null, weight: 1, enabled: true, params: {} },
    { id: "91", route_id: "9", member_type: "model", provider_id: "5", model: "gpt-5", child_route_id: null, weight: 1, enabled: true, params: {} },
  ];
  state.statements = [];
  state.nextId = 100;
  invalidateRoutingCache();
});

const exportDoc = {
  providers: [{ ref: "gpu", name: "gpu", provider: "ollama", base_url: "http://gpu:11434", auth_type: "none", api_key: "", enabled: true, params: {} }],
  profiles: [{ ref: "Main", name: "Main", kind: "analysis", strategy: "fallback", description: "", members: [{ member_type: "model", provider: "gpu", model: "qwen3:8b", weight: 1, enabled: true, params: {} }] }],
  roles: { analysis: "Main", embedding: null },
};

test("an invalid account aborts the import before anything is deleted", async () => {
  await assert.rejects(importRouting({ providers: [{ name: "bad", provider: "foobar" }], profiles: [] }, "qa"), ProfileValidationError);
  assert.deepEqual(writes(), []);
});

test("a malformed document (providers not a list) is a validation error and writes nothing", async () => {
  await assert.rejects(importRouting({ providers: "x" }, "qa"), ProfileValidationError);
  await assert.rejects(importRouting({ providers: [], profiles: [{ name: "x" }] }, "qa"), /members\[\]/);
  assert.deepEqual(writes(), []);
});

test("an invalid profile aborts the import before anything is deleted", async () => {
  const doc = structuredClone(exportDoc);
  doc.profiles[0].members[0].weight = 5000;
  await assert.rejects(importRouting(doc, "qa"), /weight/);
  assert.deepEqual(writes(), []);
});

test("a valid import replaces everything inside one transaction", async () => {
  await importRouting(exportDoc, "qa");
  const sqls = state.statements.map((x) => x.sql);
  const begin = sqls.indexOf("BEGIN");
  const commit = sqls.indexOf("COMMIT");
  assert.ok(begin >= 0 && commit > begin, "wrapped in BEGIN … COMMIT");
  const w = writes().map((x) => x.sql);
  assert.ok(w.every((x) => { const i = sqls.indexOf(x); return i > begin && i < commit; }), "every write is inside the transaction");
  assert.ok(w.some((x) => /DELETE FROM admin\.llm_providers WHERE auth_type <> 'oauth'/.test(x)), "subscription accounts are not deleted");
});

test("members on a kept subscription account are put back into the same-named profile", async () => {
  await importRouting(exportDoc, "qa");
  const memberInserts = writes().filter((x) => /^INSERT INTO admin\.llm_route_members/.test(x.sql));
  assert.equal(memberInserts.length, 2);
  assert.ok(memberInserts.some((x) => x.params[3] === 5 && x.params[4] === "gpt-5"), JSON.stringify(memberInserts.map((x) => x.params)));
  const role = writes().find((x) => /INSERT INTO admin\.llm_role_routes/.test(x.sql) && x.params[0] === "analysis");
  assert.ok(role && role.params[1] !== null, "the analysis role is bound to the imported profile");
});

test("an imported account may not take the name of a kept subscription account", async () => {
  const doc = structuredClone(exportDoc);
  doc.providers[0].name = "ChatGPT Pro";
  await assert.rejects(importRouting(doc, "qa"), /already exists/);
  assert.deepEqual(writes(), []);
});
