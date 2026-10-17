/**
 * Profile expansion: strategies, nesting, weights, disabled parts and loops —
 * the call-time order a request walks.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { __test, planDeleteInGraph, type ProviderAccount, type Route, type RouteMember, type RoutingGraph } from "./llmRouting.js";

const { orderMembers, expand, collectLeaves } = __test;

function account(id: number, enabled = true): ProviderAccount {
  return {
    id,
    name: `acc${id}`,
    provider: "openai_compatible",
    base_url: `http://h${id}/v1`,
    auth_type: "none",
    api_key: "",
    enabled,
    params: { rpm: 10, temperature: 9 },
    oauth: null,
    last_test: null,
    created_at: "",
    updated_at: "",
  };
}

let nextMember = 100;
function model(provider: number, name: string, weight = 1, enabled = true): RouteMember {
  return { id: nextMember++, member_type: "model", provider_id: provider, model: name, child_route_id: null, weight, enabled, params: { dimensions: 1024 } };
}
function sub(child: number, weight = 1): RouteMember {
  return { id: nextMember++, member_type: "route", provider_id: null, model: "", child_route_id: child, weight, enabled: true, params: {} };
}
function route(id: number, strategy: Route["strategy"], members: RouteMember[]): Route {
  return { id, name: `r${id}`, kind: "analysis", strategy, description: "", members, updated_at: "" };
}
function graph(routes: Route[], accounts = [account(1), account(2), account(3)]): RoutingGraph {
  return { accounts: new Map(accounts.map((a) => [a.id, a])), routes: new Map(routes.map((r) => [r.id, r])), roles: { analysis: routes[0]?.id ?? null, embedding: null } };
}
const models = (g: RoutingGraph, id: number, rnd = Math.random) => expand(g, id, new Set(), rnd).map((l) => l.model);

test("fallback keeps order; single takes only the first member", () => {
  const g = graph([route(1, "fallback", [model(1, "a"), model(2, "b"), model(3, "c")]), route(2, "single", [model(2, "x")])]);
  assert.deepEqual(models(g, 1), ["a", "b", "c"]);
  assert.deepEqual(models(g, 2), ["x"]);
});

test("round robin rotates the starting member on each request", () => {
  const g = graph([route(10, "round_robin", [model(1, "a"), model(2, "b"), model(3, "c")])]);
  assert.deepEqual(models(g, 10), ["a", "b", "c"]);
  assert.deepEqual(models(g, 10), ["b", "c", "a"]);
  assert.deepEqual(models(g, 10), ["c", "a", "b"]);
  assert.deepEqual(models(g, 10), ["a", "b", "c"]);
});

test("load balance draws by weight; weight 0 is fallback-only and goes last", () => {
  const g = graph([route(20, "load_balance", [model(1, "heavy", 3), model(2, "light", 1), model(3, "spare", 0)])]);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const firsts: Record<string, number> = {};
  for (let i = 0; i < 4000; i += 1) {
    const order = models(g, 20, rnd);
    assert.equal(order[2], "spare");
    firsts[order[0]] = (firsts[order[0]] ?? 0) + 1;
  }
  const share = firsts.heavy / 4000;
  assert.ok(share > 0.7 && share < 0.8, `heavy first ~75%, got ${share}`);
  assert.ok(!firsts.spare);
});

test("nested profiles expand in place, and members keep their own strategy", () => {
  const g = graph([route(30, "fallback", [model(1, "primary"), sub(31), model(3, "last")]), route(31, "fallback", [model(2, "inner1"), model(2, "inner2")])]);
  assert.deepEqual(models(g, 30), ["primary", "inner1", "inner2", "last"]);
});

test("disabled members, disabled accounts and missing children are skipped", () => {
  const g = graph(
    [route(40, "fallback", [model(1, "on"), model(2, "member-off", 1, false), model(3, "account-off"), sub(999)])],
    [account(1), account(2), account(3, false)],
  );
  assert.deepEqual(models(g, 40), ["on"]);
});

test("a loop in stored data cannot recurse forever", () => {
  const g = graph([route(50, "fallback", [model(1, "a"), sub(51)]), route(51, "fallback", [sub(50), model(2, "b")])]);
  assert.deepEqual(models(g, 50), ["a", "b"]);
  assert.deepEqual(collectLeaves(g, 50).map((l) => l.model), ["a", "b"]);
});

test("leaf carries account URL/key, account-wide limits and the member's own knobs", () => {
  const g = graph([route(60, "single", [model(2, "m")])]);
  const [leaf] = expand(g, 60, new Set(), Math.random);
  assert.equal(leaf.base_url, "http://h2/v1");
  assert.equal(leaf.params.rpm, 10, "account rpm applies");
  assert.equal(leaf.params.temperature, undefined, "non-account params on the account are not leaked into the model");
  assert.equal(leaf.params.dimensions, 1024);
});

test("orderMembers with no members is empty", () => {
  assert.deepEqual(orderMembers(route(70, "fallback", []), [], Math.random), []);
});

test("subscription (OAuth) accounts serve role traffic only when explicitly allowed", () => {
  const oauthAcc = { ...account(2), auth_type: "oauth" as const, params: {} };
  const allowed = { ...account(3), auth_type: "oauth" as const, params: { allow_role_use: true } };
  const g = graph([route(80, "fallback", [model(1, "key"), model(2, "plan-not-allowed"), model(3, "plan-allowed")])], [account(1), oauthAcc, allowed]);
  assert.deepEqual(models(g, 80), ["key", "plan-allowed"]);
});

test("delete plan: referencing profiles lose the member; emptied ones cascade upward; roles unbind", () => {
  // top(90) ⊃ mid(91) ⊃ leaf(92); other(93) ⊃ [leaf(92), model]; role analysis → top; leaf contains child(94).
  const g = graph([
    route(90, "fallback", [sub(91)]),
    route(91, "fallback", [sub(92)]),
    route(92, "fallback", [sub(94), model(1, "x")]),
    route(93, "fallback", [sub(92), model(2, "y")]),
    route(94, "single", [model(3, "z")]),
  ]);
  g.roles.analysis = 90;
  const plan = planDeleteInGraph(g, 92);
  assert.deepEqual(plan.cascade.map((c) => c.name).sort(), ["r90", "r91"]);
  assert.deepEqual(plan.modified.map((m) => [m.name, m.removed, m.remaining]), [["r93", ["r92"], 1]]);
  assert.deepEqual(plan.unbound_roles, [{ role: "analysis", route: "r90" }]);
  assert.deepEqual(plan.children_kept.map((c) => c.name), ["r94"]);
  assert.equal(plan.has_impact, true);
});

test("delete plan: an unreferenced, unbound profile has no impact; a bound one unbinds", () => {
  const g = graph([route(95, "single", [model(1, "a")]), route(96, "fallback", [sub(95), model(2, "b")])]);
  g.roles.analysis = 96;
  assert.equal(planDeleteInGraph(g, 96).has_impact, true);
  assert.deepEqual(planDeleteInGraph(g, 96).unbound_roles.map((r) => r.role), ["analysis"]);
  const p95 = planDeleteInGraph(g, 95);
  assert.deepEqual(p95.affected_roles, [{ role: "analysis", route: "r96" }]);
  assert.equal(p95.cascade.length, 0);
  const loneGraph = graph([route(97, "single", [model(1, "a")])]);
  loneGraph.roles.analysis = null; // the helper binds the first route; this one is free-standing
  const lone = planDeleteInGraph(loneGraph, 97);
  assert.equal(lone.has_impact, false);
});
