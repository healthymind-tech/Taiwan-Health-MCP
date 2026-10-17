/**
 * Input validation for accounts and profiles (pure parts): what is rejected
 * with a 400-class error instead of reaching Postgres, and what is normalised.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { __test, legacyProfilesToRouting, type ProviderAccount, type Route, type RouteInput, type RoutingGraph } from "./llmRouting.js";
import { ProfileValidationError } from "./llmProfiles.js";

const { checkRouteDraft, normalizeAccount } = __test;

function account(id: number, provider = "ollama"): ProviderAccount {
  return {
    id,
    name: `acc${id}`,
    provider,
    base_url: "http://h/v1",
    auth_type: "none",
    api_key: "",
    enabled: true,
    params: {},
    oauth: null,
    last_test: null,
    created_at: "",
    updated_at: "",
  };
}

function graph(routes: Route[] = []): RoutingGraph {
  return { accounts: new Map([[1, account(1)]]), routes: new Map(routes.map((r) => [r.id, r])), roles: { analysis: null, embedding: null } };
}

const child: Route = {
  id: 7,
  name: "Pool",
  kind: "analysis",
  strategy: "fallback",
  description: "",
  members: [{ id: 70, member_type: "model", provider_id: 1, model: "m", child_route_id: null, weight: 1, enabled: true, params: {} }],
  updated_at: "",
};

const route = (members: RouteInput["members"], extra: Partial<RouteInput> = {}): RouteInput => ({ name: "P", kind: "analysis", strategy: "fallback", members, ...extra });
const model = (extra: Record<string, unknown> = {}) => ({ member_type: "model" as const, provider_id: 1, model: "qwen3:8b", ...extra });
const rejects = (fn: () => unknown, re: RegExp) => assert.throws(fn, (e: unknown) => e instanceof ProfileValidationError && re.test((e as Error).message));

test("weight must be an integer within 0..1000 (no Postgres integer overflow)", () => {
  for (const w of [-1, 1.5, "abc", 3_000_000_000, 1001]) rejects(() => checkRouteDraft(route([model({ weight: w })]), null, graph()), /weight must be an integer between 0 and 1000/);
  assert.equal(checkRouteDraft(route([model({ weight: 1000 })]), null, graph()).members[0].weight, 1000);
});

test("enabled must be a boolean", () => {
  rejects(() => checkRouteDraft(route([model({ enabled: "abc" })]), null, graph()), /enabled must be true or false/);
  rejects(() => normalizeAccount({ name: "a", provider: "ollama", base_url: "http://h", enabled: "abc" as unknown as boolean }), /Enabled must be true or false/);
});

test("unknown knobs and knobs of the other role are dropped; known ones are kept", () => {
  const c = checkRouteDraft(route([model({ params: { no_such_knob: 1, dimensions: 512, num_ctx: 8192, timeout_ms: 1000 } })]), null, graph());
  assert.deepEqual(Object.keys(c.members[0].params ?? {}).sort(), ["num_ctx", "timeout_ms"]);
});

test("the same child profile twice in one profile is refused", () => {
  rejects(
    () => checkRouteDraft(route([{ member_type: "route", child_route_id: 7 }, { member_type: "route", child_route_id: 7 }]), null, graph([child])),
    /Member 2: 'Pool' is already a member of this profile/,
  );
});

test("profile names are capped at 120 characters", () => {
  rejects(() => checkRouteDraft(route([model()], { name: "x".repeat(121) }), null, graph()), /too long/);
  assert.ok(checkRouteDraft(route([model()], { name: "x".repeat(120) }), null, graph()));
});

test("rpm / tpm must be real positive integers (true, [5], 1.5 are refused)", () => {
  for (const rpm of [true, [5], 1.5, 0, "abc"]) rejects(() => normalizeAccount({ name: "a", provider: "ollama", base_url: "http://h", params: { rpm } }), /RPM \/ TPM/);
  assert.equal(normalizeAccount({ name: "a", provider: "ollama", base_url: "http://h", params: { rpm: "60" } }).params.rpm, 60);
});

test("a fixed-URL provider ignores the typed URL and keeps its type", () => {
  const a = normalizeAccount({ name: "o", provider: "openai", base_url: "https://evil.example.com/v1", api_key: "sk-x" });
  assert.equal(a.provider, "openai");
  assert.match(a.base_url, /api\.openai\.com/);
});

test("api_key null clears the key of an optional-key provider; blank keeps it", () => {
  const existing = { ...account(1), api_key: "secret", auth_type: "api_key" as const };
  assert.equal(normalizeAccount({ name: "a", provider: "ollama", base_url: "http://h", api_key: "" }, existing).api_key, "secret");
  const cleared = normalizeAccount({ name: "a", provider: "ollama", base_url: "http://h", api_key: null }, existing);
  assert.equal(cleared.api_key, "");
  assert.equal(cleared.auth_type, "none");
});

test("legacy import: profiles merged into one account keep differing limits per member", () => {
  const doc = legacyProfilesToRouting(
    [
      { kind: "analysis", name: "a", provider: "ollama", base_url: "http://h", api_key: "", model: "m1", priority: 2, params: { think: "off", rpm: 60 } },
      { kind: "analysis", name: "b", provider: "ollama", base_url: "http://h", api_key: "", model: "m2", priority: 1, params: {} },
    ],
    {},
  );
  assert.equal(doc.providers.length, 1);
  assert.equal(doc.providers[0].params.rpm, undefined, "not imposed on the profile that had none");
  const m1 = doc.profiles[0].members.find((m) => m.model === "m1")!;
  assert.equal((m1.params as Record<string, unknown>).rpm, 60, "rpm:60 is not lost");
});

test("legacy import: limits all merged profiles agree on move to the account", () => {
  const doc = legacyProfilesToRouting(
    [
      { kind: "analysis", name: "a", provider: "ollama", base_url: "http://h", model: "m1", params: { rpm: 30 } },
      { kind: "analysis", name: "b", provider: "ollama", base_url: "http://h", model: "m2", params: { rpm: 30 } },
    ],
    {},
  );
  assert.equal(doc.providers[0].params.rpm, 30);
  assert.ok(doc.profiles[0].members.every((m) => (m.params as Record<string, unknown>).rpm === undefined));
});

test("legacy import: 'openai' with a self-hosted URL is an OpenAI-compatible server", () => {
  const doc = legacyProfilesToRouting([{ kind: "analysis", name: "v", provider: "openai", base_url: "http://gpu:8000/v1", model: "m" }], {});
  assert.equal(doc.providers[0].provider, "openai_compatible");
});
