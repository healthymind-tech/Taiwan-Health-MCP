/**
 * QA: route expansion at call time — round robin across calls and nested
 * profiles, load-balance distribution, weight 0, disabled parts, OAuth accounts,
 * cool-down ordering and dedupe. Pure `expand` tests use the `__test` export;
 * `routeCandidates` runs against a fake pg pool (no Postgres).
 */

process.env.DATABASE_URL ??= "postgresql://qa:qa@127.0.0.1:1/qa";

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { initPool } from "../db.js";
import { __test, invalidateRoutingCache, routeCandidates, type ProviderAccount, type Route, type RouteMember, type RoutingGraph } from "./llmRouting.js";
import { candidateOrder, reportFailure, reportSuccess, resetBreakers } from "./llmProfiles.js";

const { expand } = __test;

function account(id: number, extra: Partial<ProviderAccount> = {}): ProviderAccount {
  return {
    id,
    name: `acc${id}`,
    provider: "openai_compatible",
    base_url: `http://h${id}/v1`,
    auth_type: "none",
    api_key: "",
    enabled: true,
    params: {},
    oauth: null,
    last_test: null,
    created_at: "",
    updated_at: "",
    ...extra,
  };
}
let nextId = 1000;
const model = (provider: number, name: string, weight = 1, enabled = true): RouteMember => ({
  id: nextId++,
  member_type: "model",
  provider_id: provider,
  model: name,
  child_route_id: null,
  weight,
  enabled,
  params: {},
});
const sub = (child: number, weight = 1): RouteMember => ({
  id: nextId++,
  member_type: "route",
  provider_id: null,
  model: "",
  child_route_id: child,
  weight,
  enabled: true,
  params: {},
});
const route = (id: number, strategy: Route["strategy"], members: RouteMember[]): Route => ({
  id,
  name: `r${id}`,
  kind: "analysis",
  strategy,
  description: "",
  members,
  updated_at: "",
});
function graph(routes: Route[], accounts: ProviderAccount[] = [account(1), account(2), account(3)]): RoutingGraph {
  return {
    accounts: new Map(accounts.map((a) => [a.id, a])),
    routes: new Map(routes.map((r) => [r.id, r])),
    roles: { analysis: routes[0]?.id ?? null, embedding: null },
  };
}
const names = (g: RoutingGraph, id: number, rnd = Math.random) => expand(g, id, new Set(), rnd).map((l) => l.model);

// ── pure expansion ───────────────────────────────────────────────────────────

test("round robin: a nested RR child rotates once per request", () => {
  const g = graph([route(100, "fallback", [sub(101), model(3, "z")]), route(101, "round_robin", [model(1, "a"), model(2, "b")])]);
  assert.deepEqual(names(g, 100), ["a", "b", "z"]);
  assert.deepEqual(names(g, 100), ["b", "a", "z"]);
  assert.deepEqual(names(g, 100), ["a", "b", "z"]);
});

test("round robin: the counter survives a member being disabled (index wraps over the shorter list)", () => {
  const m = [model(1, "a"), model(2, "b"), model(3, "c")];
  const g = graph([route(110, "round_robin", m)]);
  assert.deepEqual(names(g, 110), ["a", "b", "c"]);
  m[1].enabled = false;
  const second = names(g, 110);
  assert.equal(second.length, 2);
  assert.ok(second.includes("a") && second.includes("c"));
});

test(
  "round robin: a profile reachable through two nested paths still rotates once per request",
  () => {
    // outer fallback: [RR child, wrapper → RR child]  (operator reuses the RR building block)
    const g = graph([
      route(120, "fallback", [sub(121), sub(122)]),
      route(121, "round_robin", [model(1, "a"), model(2, "b")]),
      route(122, "fallback", [sub(121), model(3, "z")]),
    ]);
    const firsts = [0, 1, 2, 3].map(() => names(g, 120)[0]);
    assert.deepEqual(firsts, ["a", "b", "a", "b"], `first leaf per request: ${firsts.join(",")}`);
  },
);

test("round robin: the counter also advances on requests that never reach the RR child (fallback after a healthy primary)", () => {
  // Documented characteristic: rotation is per *expansion*, not per use.
  const g = graph([route(130, "fallback", [model(3, "primary"), sub(131)]), route(131, "round_robin", [model(1, "a"), model(2, "b")])]);
  assert.deepEqual(names(g, 130), ["primary", "a", "b"]);
  assert.deepEqual(names(g, 130), ["primary", "b", "a"]);
});

test("load balance: share follows weights over many draws; weight 0 always last and never first", () => {
  const g = graph([route(140, "load_balance", [model(1, "w1", 1), model(2, "w2", 2), model(3, "w0", 0)])]);
  let seed = 11;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const first: Record<string, number> = {};
  const N = 6000;
  for (let i = 0; i < N; i += 1) {
    const o = names(g, 140, rnd);
    assert.equal(o[o.length - 1], "w0");
    first[o[0]] = (first[o[0]] ?? 0) + 1;
  }
  const share = first.w2 / N;
  assert.ok(share > 0.63 && share < 0.70, `w2 first ≈ 2/3, got ${share}`);
  assert.equal(first.w0 ?? 0, 0);
});

test("load balance: random() returning exactly 1 (or rounding) still yields a full permutation", () => {
  const g = graph([route(150, "load_balance", [model(1, "a", 1), model(2, "b", 1)])]);
  assert.deepEqual(names(g, 150, () => 0.9999999999999999).sort(), ["a", "b"]);
  assert.deepEqual(names(g, 150, () => 1).sort(), ["a", "b"]);
});

test(
  "load balance: a member whose weight is NaN (bad import / junk value) is kept as fallback-only, like weight 0",
  () => {
    const g = graph([route(160, "load_balance", [model(1, "good", 1), model(2, "nan", Number.NaN)])]);
    assert.deepEqual(names(g, 160), ["good", "nan"]);
  },
);

test("disabled member / disabled account / missing child / empty model are skipped", () => {
  const g = graph(
    [route(170, "fallback", [model(1, "on"), model(2, "off", 1, false), model(3, "acc-off"), sub(9999), model(1, "")])],
    [account(1), account(2), account(3, { enabled: false })],
  );
  assert.deepEqual(names(g, 170), ["on"]);
});

test("OAuth (subscription) accounts serve roles only with params.allow_role_use === true", () => {
  const accs = [account(1, { auth_type: "oauth", provider: "chatgpt" }), account(2, { auth_type: "oauth", provider: "chatgpt", params: { allow_role_use: true } }), account(3, { auth_type: "oauth", params: { allow_role_use: "true" } })];
  const g = graph([route(180, "fallback", [model(1, "no-flag"), model(2, "allowed"), model(3, "string-true")])], accs);
  assert.deepEqual(names(g, 180), ["allowed"], "string 'true' is not accepted (strict ===)");
});

test("'single' with first member disabled falls through to the next usable member", () => {
  const g = graph([route(190, "single", [model(1, "first", 1, false), model(2, "second")])]);
  assert.deepEqual(names(g, 190), ["second"]);
});

test("cycles terminate (A → B → A)", () => {
  const g = graph([route(200, "fallback", [model(1, "a"), sub(201)]), route(201, "fallback", [sub(200), model(2, "b")])]);
  assert.deepEqual(names(g, 200), ["a", "b"]);
});

// ── routeCandidates with a fake DB ───────────────────────────────────────────

interface FakeDb {
  accounts: Record<string, unknown>[];
  routes: Record<string, unknown>[];
  members: Record<string, unknown>[];
  roles: Record<string, unknown>[];
  graphLoads: number;
}
const db: FakeDb = { accounts: [], routes: [], members: [], roles: [], graphLoads: 0 };
const pool = initPool();
const fakeQuery = async (sql: string) => {
  if (/FROM admin\.llm_providers/.test(sql)) {
    db.graphLoads += 1;
    return { rows: db.accounts };
  }
  if (/FROM admin\.llm_routes/.test(sql)) return { rows: db.routes };
  if (/FROM admin\.llm_route_members/.test(sql)) return { rows: db.members };
  if (/FROM admin\.llm_role_routes/.test(sql)) return { rows: db.roles };
  if (/embedding_identity/.test(sql)) return { rows: [] };
  return { rows: [] };
};
(pool as unknown as { query: unknown }).query = fakeQuery;

function seedDb(): void {
  db.accounts = [1, 2, 3].map((id) => ({
    id: String(id),
    name: `acc${id}`,
    provider: "openai_compatible",
    base_url: `http://h${id}/v1`,
    auth_type: "none",
    api_key: "",
    enabled: true,
    params: { rpm: 5 },
    oauth: null,
    last_test: null,
    created_at: new Date(0),
    updated_at: new Date(0),
  }));
  db.routes = [
    { id: "1", name: "outer", kind: "analysis", strategy: "fallback", description: "", updated_at: new Date(0) },
    { id: "2", name: "inner", kind: "analysis", strategy: "fallback", description: "", updated_at: new Date(0) },
  ];
  // outer: [m11 (acc1), inner, m13 (acc3)]; inner: [m21 (acc2), m11-again? no — a second member on acc1]
  db.members = [
    { id: "11", route_id: "1", member_type: "model", provider_id: "1", model: "a", child_route_id: null, weight: 1, enabled: true, params: { temperature: 0 } },
    { id: "12", route_id: "1", member_type: "route", provider_id: null, model: "", child_route_id: "2", weight: 1, enabled: true, params: {} },
    { id: "13", route_id: "1", member_type: "model", provider_id: "3", model: "c", child_route_id: null, weight: 1, enabled: true, params: {} },
    { id: "21", route_id: "2", member_type: "model", provider_id: "2", model: "b", child_route_id: null, weight: 1, enabled: true, params: {} },
    { id: "22", route_id: "2", member_type: "route", provider_id: null, model: "", child_route_id: "3", weight: 1, enabled: true, params: {} },
  ];
  db.routes.push({ id: "3", name: "shared", kind: "analysis", strategy: "fallback", description: "", updated_at: new Date(0) });
  db.members.push({ id: "31", route_id: "3", member_type: "model", provider_id: "1", model: "shared", child_route_id: null, weight: 1, enabled: true, params: {} });
  // route 3 is ALSO reachable directly from outer → leaf 31 reachable twice.
  db.members.push({ id: "14", route_id: "1", member_type: "route", provider_id: null, model: "", child_route_id: "3", weight: 1, enabled: true, params: {} });
  db.roles = [{ role: "analysis", route_id: "1" }];
}

beforeEach(() => {
  seedDb();
  invalidateRoutingCache();
  resetBreakers();
});

test("routeCandidates: leaf reachable via two nested paths appears once; priorities renumbered; account rpm merged into params", async () => {
  const leaves = await routeCandidates("analysis");
  assert.deepEqual(leaves.map((l) => l.id), [11, 21, 31, 13]);
  assert.deepEqual(leaves.map((l) => l.priority), [0, 1, 2, 3]);
  assert.equal(leaves[0].params.rpm, 5);
  assert.equal(leaves[0].params.temperature, 0);
  assert.equal(leaves[0].name, "acc1 · a");
});

test("routeCandidates: a cooled leaf moves to the back but is still tried; reportSuccess restores order", async () => {
  for (let i = 0; i < 3; i += 1) reportFailure(11, "dead");
  let ids = (await candidateOrder("analysis")).map((l) => l.id);
  assert.deepEqual(ids, [21, 31, 13, 11]);
  reportSuccess(11);
  ids = (await candidateOrder("analysis")).map((l) => l.id);
  assert.deepEqual(ids, [11, 21, 31, 13]);
});

test("routeCandidates: every leaf cooled → all still returned (original order)", async () => {
  for (const id of [11, 21, 31, 13]) for (let i = 0; i < 3; i += 1) reportFailure(id, "x");
  assert.deepEqual((await candidateOrder("analysis")).map((l) => l.id), [11, 21, 31, 13]);
});

test("routeCandidates: the graph is cached ~3s (one DB round per window), invalidateRoutingCache forces reload", async () => {
  db.graphLoads = 0;
  await routeCandidates("analysis");
  await routeCandidates("analysis");
  await routeCandidates("analysis");
  assert.equal(db.graphLoads, 1);
  invalidateRoutingCache();
  await routeCandidates("analysis");
  assert.equal(db.graphLoads, 2);
});

test("invalidateRoutingCache also clears every breaker (an unrelated config edit revives a dead leaf)", async () => {
  for (let i = 0; i < 3; i += 1) reportFailure(11, "dead");
  invalidateRoutingCache();
  assert.equal((await candidateOrder("analysis"))[0].id, 11);
});

test("routeCandidates: no role binding → []", async () => {
  db.roles = [];
  assert.deepEqual(await routeCandidates("analysis"), []);
});
