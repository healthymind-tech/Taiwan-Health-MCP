/**
 * Provider accounts and composable profiles ("routes").
 *
 *   provider account — a named account of a provider type (registry id): URL,
 *                      credentials, account-wide limits. Several per type are
 *                      fine ("OpenAI – team A", "OpenAI – personal").
 *   route (profile)  — a named strategy over members; a member is either a model
 *                      on a provider account (with its own knobs) or another
 *                      route, so profiles nest like building blocks.
 *   role binding     — which route the analysis / embedding role uses.
 *
 * At call time a route is expanded into a flat, ordered list of leaves (the
 * `LlmProfile` shape every caller already speaks): the first is tried first,
 * the rest are fallbacks. Leaf id = route member id, so cool-downs and stats are
 * per configured model.
 */

import { query, withTransaction } from "../db.js";
import { getAdapter, canonicalProviderId, legacyProviderId } from "../providers/registry.js";
import type { ParamSpec, Role } from "../providers/types.js";
import { credentialSummary } from "./chatgptOAuth.js";
import {
  embeddingDimensions,
  isCoolingDown,
  ProfileNotFoundError,
  ProfileValidationError,
  resetBreakers,
  type LlmProfile,
  type ProfileKind,
} from "./llmProfiles.js";

export type RouteStrategy = "single" | "fallback" | "round_robin" | "load_balance";
export const ROUTE_STRATEGIES: RouteStrategy[] = ["single", "fallback", "round_robin", "load_balance"];
export type AuthType = "api_key" | "oauth" | "none";

/** Account-wide params: limits apply to the whole account, not one model. */
const ACCOUNT_PARAM_KEYS = new Set(["rpm", "tpm", "base_model"]);

/** Highest load-balance weight a member may have. */
export const MAX_MEMBER_WEIGHT = 1000;
/** Longest account / profile name. */
export const MAX_NAME_LENGTH = 120;

/**
 * Member knobs every provider understands, besides its own ParamSpecs: the
 * client-side limits and budgets the call layer reads (analysisLlmClient.ts,
 * embeddingService.ts). Anything else is not a knob for that role and is
 * dropped on save (the UI never shows it, so it could never be removed).
 */
const COMMON_MEMBER_KNOBS: Record<Role, string[]> = {
  analysis: ["max_tokens", "max_token_budget", "timeout_ms", "rpm", "tpm"],
  embedding: ["dimensions", "rpm", "tpm"],
};

export interface ProviderAccount {
  id: number;
  name: string;
  provider: string;
  base_url: string;
  auth_type: AuthType;
  api_key: string;
  enabled: boolean;
  params: Record<string, unknown>;
  /** Subscription sign-in credential (tokens) — server-only. */
  oauth: Record<string, unknown> | null;
  last_test: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export type ProviderAccountPublic = Omit<ProviderAccount, "api_key" | "oauth"> & {
  has_api_key: boolean;
  /** Who/when/status of a subscription sign-in; never the tokens. */
  oauth: Record<string, unknown> | null;
};

export function accountPublic(a: ProviderAccount): ProviderAccountPublic {
  const { api_key, oauth, ...rest } = a;
  return { ...rest, has_api_key: Boolean(api_key), oauth: credentialSummary(oauth) };
}

/**
 * Subscription accounts (consumer plans, consumer data terms) only serve role
 * traffic when the operator explicitly allowed it on the account.
 */
function servesRoles(a: ProviderAccount): boolean {
  return a.auth_type !== "oauth" || a.params.allow_role_use === true;
}

export interface RouteMember {
  id: number;
  member_type: "model" | "route";
  provider_id: number | null;
  model: string;
  child_route_id: number | null;
  weight: number;
  enabled: boolean;
  params: Record<string, unknown>;
}

export interface Route {
  id: number;
  name: string;
  kind: ProfileKind;
  strategy: RouteStrategy;
  description: string;
  members: RouteMember[];
  updated_at: string;
}

// ── reads ────────────────────────────────────────────────────────────────────

interface AccountRow {
  id: string;
  name: string;
  provider: string;
  base_url: string;
  auth_type: AuthType;
  api_key: string;
  enabled: boolean;
  params: Record<string, unknown> | null;
  oauth: Record<string, unknown> | null;
  last_test: Record<string, unknown> | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function iso(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : String(v);
}

function accountFromRow(r: AccountRow): ProviderAccount {
  return {
    id: Number(r.id),
    name: r.name,
    provider: r.provider,
    base_url: r.base_url,
    auth_type: r.auth_type,
    api_key: r.api_key,
    enabled: r.enabled,
    params: r.params ?? {},
    oauth: r.oauth && Object.keys(r.oauth).length ? r.oauth : null,
    last_test: r.last_test,
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
  };
}

const ACCOUNT_COLS = "id, name, provider, base_url, auth_type, api_key, enabled, params, oauth, last_test, created_at, updated_at";

export async function listAccounts(): Promise<ProviderAccount[]> {
  const res = await query<AccountRow>(`SELECT ${ACCOUNT_COLS} FROM admin.llm_providers ORDER BY provider, name`);
  return res.rows.map(accountFromRow);
}

export async function getAccount(id: number): Promise<ProviderAccount | null> {
  const res = await query<AccountRow>(`SELECT ${ACCOUNT_COLS} FROM admin.llm_providers WHERE id = $1`, [id]);
  return res.rows[0] ? accountFromRow(res.rows[0]) : null;
}

interface RouteRow {
  id: string;
  name: string;
  kind: ProfileKind;
  strategy: RouteStrategy;
  description: string;
  updated_at: Date | string;
}

interface MemberRow {
  id: string;
  route_id: string;
  member_type: "model" | "route";
  provider_id: string | null;
  model: string;
  child_route_id: string | null;
  weight: number;
  enabled: boolean;
  params: Record<string, unknown> | null;
}

export async function listRoutes(kind?: ProfileKind): Promise<Route[]> {
  const routes = kind
    ? await query<RouteRow>("SELECT id, name, kind, strategy, description, updated_at FROM admin.llm_routes WHERE kind = $1 ORDER BY name", [kind])
    : await query<RouteRow>("SELECT id, name, kind, strategy, description, updated_at FROM admin.llm_routes ORDER BY kind, name");
  const members = await query<MemberRow>(
    "SELECT id, route_id, member_type, provider_id, model, child_route_id, weight, enabled, params FROM admin.llm_route_members ORDER BY route_id, position, id",
  );
  const byRoute = new Map<number, RouteMember[]>();
  for (const m of members.rows) {
    const list = byRoute.get(Number(m.route_id)) ?? [];
    list.push({
      id: Number(m.id),
      member_type: m.member_type,
      provider_id: m.provider_id === null ? null : Number(m.provider_id),
      model: m.model,
      child_route_id: m.child_route_id === null ? null : Number(m.child_route_id),
      weight: Number(m.weight),
      enabled: m.enabled,
      params: m.params ?? {},
    });
    byRoute.set(Number(m.route_id), list);
  }
  return routes.rows.map((r) => ({
    id: Number(r.id),
    name: r.name,
    kind: r.kind,
    strategy: r.strategy,
    description: r.description,
    members: byRoute.get(Number(r.id)) ?? [],
    updated_at: iso(r.updated_at),
  }));
}

export async function getRoleRoutes(): Promise<Record<ProfileKind, number | null>> {
  const res = await query<{ role: ProfileKind; route_id: string | null }>("SELECT role, route_id FROM admin.llm_role_routes");
  const out: Record<ProfileKind, number | null> = { analysis: null, embedding: null };
  for (const r of res.rows) out[r.role] = r.route_id === null ? null : Number(r.route_id);
  return out;
}

// ── graph + resolver ─────────────────────────────────────────────────────────

interface Graph {
  accounts: Map<number, ProviderAccount>;
  routes: Map<number, Route>;
  roles: Record<ProfileKind, number | null>;
}

// The hot path (every search embeds its query) must not cost three queries per
// call; writes invalidate this process's copy, other processes see changes
// within the TTL.
const GRAPH_TTL_MS = 3000;
let graphCache: { at: number; graph: Promise<Graph> } | null = null;

export function invalidateRoutingCache(): void {
  graphCache = null;
  resetBreakers();
}

async function loadGraph(): Promise<Graph> {
  if (graphCache && Date.now() - graphCache.at < GRAPH_TTL_MS) return graphCache.graph;
  const graph = (async () => {
    const [accounts, routes, roles] = await Promise.all([listAccounts(), listRoutes(), getRoleRoutes()]);
    return {
      accounts: new Map(accounts.map((a) => [a.id, a])),
      routes: new Map(routes.map((r) => [r.id, r])),
      roles,
    };
  })();
  graphCache = { at: Date.now(), graph };
  graph.catch(() => {
    graphCache = null;
  });
  return graph;
}

/** A leaf for an ad-hoc (account, model) pair — tests, fingerprints, model switches. */
export function leafFromAccount(account: ProviderAccount, model: string, params: Record<string, unknown>, kind: ProfileKind): LlmProfile {
  const member: RouteMember = { id: 0, member_type: "model", provider_id: account.id, model, child_route_id: null, weight: 1, enabled: true, params };
  const route: Route = { id: 0, name: "", kind, strategy: "single", description: "", members: [member], updated_at: "" };
  return leafOf(route, member, account);
}

/** The leaf a model member resolves to, in the shape every caller speaks. */
function leafOf(route: Route, m: RouteMember, account: ProviderAccount): LlmProfile {
  const accountParams: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(account.params)) if (ACCOUNT_PARAM_KEYS.has(k)) accountParams[k] = v;
  return {
    id: m.id,
    kind: route.kind,
    name: `${account.name} · ${m.model}`,
    provider: account.provider,
    base_url: account.base_url,
    api_key: account.api_key,
    model: m.model,
    enabled: m.enabled && account.enabled,
    priority: 0,
    weight: m.weight,
    params: { ...accountParams, ...m.params },
    account_id: account.id,
  };
}

const roundRobin = new Map<number, number>();

/** Weight used by the load-balance draw: finite and ≥ 0, anything else is 0. */
function drawWeight(m: RouteMember): number {
  const w = Number(m.weight);
  return Number.isFinite(w) && w > 0 ? w : 0;
}

/** Order members for one request according to the route's strategy. */
function orderMembers(route: Route, members: RouteMember[], random: () => number): RouteMember[] {
  if (members.length === 0) return [];
  switch (route.strategy) {
    case "single":
      return members.slice(0, 1);
    case "round_robin": {
      const start = (roundRobin.get(route.id) ?? 0) % members.length;
      roundRobin.set(route.id, start + 1);
      return [...members.slice(start), ...members.slice(0, start)];
    }
    case "load_balance": {
      // Weighted draw without replacement; weight 0 = fallback only, kept in order at the end.
      // A non-finite / negative weight (junk import) is treated as 0 — the same
      // "fallback only" meaning validation gives the lowest allowed weight —
      // rather than silently dropping the member.
      const pool = members.filter((m) => drawWeight(m) > 0);
      const zero = members.filter((m) => drawWeight(m) <= 0);
      const out: RouteMember[] = [];
      while (pool.length) {
        const total = pool.reduce((s, m) => s + drawWeight(m), 0);
        let ticket = random() * total;
        let idx = pool.findIndex((m) => (ticket -= drawWeight(m)) < 0);
        if (idx < 0) idx = pool.length - 1;
        out.push(pool.splice(idx, 1)[0]);
      }
      return [...out, ...zero];
    }
    default:
      return members;
  }
}

/**
 * Expand a route into leaves for one request. `ordered` memoises each route's
 * member order for the duration of that request, so a route reachable through
 * several nested paths is ordered — and its round-robin counter advanced — once.
 */
function expand(
  graph: Graph,
  routeId: number,
  path: Set<number>,
  random: () => number,
  ordered: Map<number, RouteMember[]> = new Map(),
): LlmProfile[] {
  const route = graph.routes.get(routeId);
  if (!route || path.has(routeId)) return [];
  const nextPath = new Set(path).add(routeId);
  let members = ordered.get(routeId);
  if (!members) {
    const usable = route.members.filter((m) => {
      if (!m.enabled) return false;
      if (m.member_type === "route") return m.child_route_id !== null && graph.routes.has(m.child_route_id);
      const acc = m.provider_id === null ? undefined : graph.accounts.get(m.provider_id);
      return Boolean(acc?.enabled && servesRoles(acc) && m.model);
    });
    members = orderMembers(route, usable, random);
    ordered.set(routeId, members);
  }
  const out: LlmProfile[] = [];
  for (const m of members) {
    if (m.member_type === "route") out.push(...expand(graph, m.child_route_id!, nextPath, random, ordered));
    else out.push(leafOf(route, m, graph.accounts.get(m.provider_id!)!));
  }
  return out;
}

/**
 * The order to try leaves in for one request of `kind` (the role's bound route).
 * Leaves in cool-down go last rather than being dropped, so when every endpoint
 * is unhealthy they are all still tried.
 */
/** Pure pieces exposed for unit tests. */
export const __test = { orderMembers, expand, collectLeaves, checkRouteDraft: (...a: Parameters<typeof checkRouteDraft>) => checkRouteDraft(...a), normalizeAccount: (...a: Parameters<typeof normalizeAccount>) => normalizeAccount(...a) };
export type { Graph as RoutingGraph };

export async function routeCandidates(kind: ProfileKind, routeId?: number): Promise<LlmProfile[]> {
  if (kind === "embedding" && routeId === undefined) {
    // A model switch shuts every embedding endpoint: nothing may write old-model vectors.
    const { embeddingSwitching } = await import("./embeddingIdentity.js");
    if (await embeddingSwitching()) return [];
  }
  const graph = await loadGraph();
  const id = routeId ?? graph.roles[kind];
  if (!id) return [];
  const seen = new Set<number>();
  const leaves = expand(graph, id, new Set(), Math.random).filter((l) => (seen.has(l.id) ? false : (seen.add(l.id), true)));
  leaves.forEach((l, i) => (l.priority = i));
  return [...leaves.filter((l) => !isCoolingDown(l.id)), ...leaves.filter((l) => isCoolingDown(l.id))];
}

/** Every distinct enabled leaf reachable from the role's route (static, no strategy draw). */
export async function roleLeaves(kind: ProfileKind, routeId?: number): Promise<LlmProfile[]> {
  const graph = await loadGraph();
  const id = routeId ?? graph.roles[kind];
  if (!id) return [];
  return collectLeaves(graph, id);
}

function collectLeaves(graph: Graph, routeId: number, path = new Set<number>()): LlmProfile[] {
  const route = graph.routes.get(routeId);
  if (!route || path.has(routeId)) return [];
  const next = new Set(path).add(routeId);
  const out: LlmProfile[] = [];
  const seen = new Set<number>();
  for (const m of route.members) {
    if (!m.enabled) continue;
    const leaves =
      m.member_type === "route"
        ? m.child_route_id === null
          ? []
          : collectLeaves(graph, m.child_route_id, next)
        : (() => {
            const acc = m.provider_id === null ? undefined : graph.accounts.get(m.provider_id);
            return acc && acc.enabled && servesRoles(acc) ? [leafOf(route, m, acc)] : [];
          })();
    for (const l of leaves) if (!seen.has(l.id)) (seen.add(l.id), out.push(l));
  }
  return out;
}

// ── validation ───────────────────────────────────────────────────────────────

function isValidHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return (u.protocol === "http:" || u.protocol === "https:") && u.host !== "";
  } catch {
    return false;
  }
}

function validateParamValue(spec: ParamSpec, value: unknown): void {
  if (value === undefined || value === null || value === "") return;
  const label = `${spec.label} (${spec.key})`;
  if (spec.type === "number" || spec.type === "integer") {
    const n = Number(value);
    if (!Number.isFinite(n) || (spec.type === "integer" && !Number.isInteger(n))) {
      throw new ProfileValidationError(`${label} must be ${spec.type === "integer" ? "an integer" : "a number"}.`);
    }
    if ((spec.min !== undefined && n < spec.min) || (spec.max !== undefined && n > spec.max)) {
      throw new ProfileValidationError(`${label} must be between ${spec.min ?? "-∞"} and ${spec.max ?? "∞"}.`);
    }
  } else if (spec.type === "select") {
    if (!(spec.options ?? []).some((o) => o.value === String(value))) {
      throw new ProfileValidationError(`${label} must be one of: ${(spec.options ?? []).map((o) => o.value).join(", ")}.`);
    }
  }
}

function positiveIntOrUndefined(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  // A real number (or a numeric string) — Number(true) / Number([5]) must not pass.
  const n = typeof v === "number" ? v : typeof v === "string" && /^\s*\d+\s*$/.test(v) ? Number(v) : NaN;
  if (!Number.isInteger(n) || n <= 0) throw new ProfileValidationError("RPM / TPM must be positive integers.");
  return n;
}

function booleanOrUndefined(v: unknown, label: string): boolean | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") throw new ProfileValidationError(`${label} must be true or false.`);
  return v;
}

/**
 * Cheap structural rule for embedding leaves: one vector size. Whether they are
 * the *same model* is decided behaviourally by the fingerprint check
 * (embeddingIdentity.ts) — model names cannot tell.
 */
function assertEmbeddingDims(leaves: LlmProfile[]): void {
  const dims = [...new Set(leaves.map((l) => embeddingDimensions(l)))];
  if (dims.length > 1) {
    throw new ProfileValidationError(`Every model in an embedding profile must use the same dimensions — found ${dims.join(", ")}.`);
  }
}

// ── provider account writes ──────────────────────────────────────────────────

export interface AccountInput {
  name: string;
  provider: string;
  base_url?: string;
  /** Blank/omitted keeps the stored key; null clears it (when the provider allows no key). */
  api_key?: string | null;
  enabled?: boolean;
  params?: Record<string, unknown>;
}

function normalizeAccount(input: AccountInput, existing?: ProviderAccount): Omit<ProviderAccount, "id" | "created_at" | "updated_at" | "last_test" | "oauth"> {
  const name = String(input.name ?? existing?.name ?? "").trim();
  if (!name) throw new ProfileValidationError("Account name is required.");
  if (name.length > MAX_NAME_LENGTH) throw new ProfileValidationError(`Account name is too long (max ${MAX_NAME_LENGTH}).`);
  const rawProvider = String(input.provider ?? existing?.provider ?? "");
  const baseIn = String(input.base_url ?? existing?.base_url ?? "").trim();
  const provider = canonicalProviderId(rawProvider, baseIn);
  const adapter = getAdapter(provider);
  if (!adapter) throw new ProfileValidationError(`Unknown provider: ${rawProvider}`);
  const spec = adapter.spec;
  const base_url = spec.baseUrl.fixed && spec.baseUrl.default ? spec.baseUrl.default : baseIn || spec.baseUrl.default || "";
  if (!isValidHttpUrl(base_url)) throw new ProfileValidationError(`'${base_url}' is not a valid http(s) URL`);
  if (spec.auth && !existing) {
    throw new ProfileValidationError(`${spec.label} accounts are connected by signing in, not with an API key.`);
  }
  const typedKey = typeof input.api_key === "string" ? input.api_key.trim() : "";
  // Blank keeps the stored key; an explicit null clears it (optional-key providers).
  const clearKey = input.api_key === null && !spec.keyRequired;
  const api_key = spec.auth || clearKey ? "" : typedKey || existing?.api_key || "";
  if (spec.keyRequired && !api_key) throw new ProfileValidationError(`${spec.label} requires an API key.`);
  const params: Record<string, unknown> = {};
  const src = { ...(existing?.params ?? {}), ...(input.params ?? {}) };
  const rpm = positiveIntOrUndefined(src.rpm);
  const tpm = positiveIntOrUndefined(src.tpm);
  if (rpm) params.rpm = rpm;
  if (tpm) params.tpm = tpm;
  if (typeof src.base_model === "string" && src.base_model.trim()) params.base_model = src.base_model.trim();
  if (typeof src.allow_role_use === "boolean") params.allow_role_use = src.allow_role_use;
  return {
    name,
    provider,
    base_url,
    auth_type: existing?.auth_type === "oauth" ? "oauth" : api_key ? "api_key" : "none",
    api_key,
    enabled: booleanOrUndefined(input.enabled, "Enabled") ?? existing?.enabled ?? true,
    params,
  };
}

async function audit(user: string, action: string, targetType: string, target: string, payload: unknown): Promise<void> {
  await query(
    `INSERT INTO admin.admin_audit_log (admin_user, action, target_type, target_id, payload_json) VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [user, action, targetType, target, JSON.stringify(payload ?? {})],
  );
}

function uniqueViolation(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && (err as { code?: string }).code === "23505");
}

function fkViolation(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && (err as { code?: string }).code === "23503");
}

export async function createAccount(input: AccountInput, user: string): Promise<ProviderAccount> {
  const a = normalizeAccount(input);
  try {
    const res = await query<AccountRow>(
      `INSERT INTO admin.llm_providers (name, provider, base_url, auth_type, api_key, enabled, params)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING ${ACCOUNT_COLS}`,
      [a.name, a.provider, a.base_url, a.auth_type, a.api_key, a.enabled, JSON.stringify(a.params)],
    );
    await audit(user, "create_llm_provider", "llm_provider", res.rows[0].id, { name: a.name, provider: a.provider });
    invalidateRoutingCache();
    return accountFromRow(res.rows[0]);
  } catch (err) {
    if (uniqueViolation(err)) throw new ProfileValidationError(`An account named '${a.name}' already exists.`);
    throw err;
  }
}

export async function updateAccount(id: number, input: Partial<AccountInput>, user: string): Promise<ProviderAccount> {
  const existing = await getAccount(id);
  if (!existing) throw new ProfileNotFoundError(`No such account: ${id}`);
  const a = normalizeAccount({ ...existing, api_key: undefined, ...input } as AccountInput, existing);
  if (a.provider !== existing.provider) {
    throw new ProfileValidationError("The provider type of an account cannot change; create a new account instead.");
  }
  try {
    const res = await query<AccountRow>(
      `UPDATE admin.llm_providers SET name=$2, base_url=$3, auth_type=$4, api_key=$5, enabled=$6, params=$7::jsonb, updated_at=NOW()
        WHERE id=$1 RETURNING ${ACCOUNT_COLS}`,
      [id, a.name, a.base_url, a.auth_type, a.api_key, a.enabled, JSON.stringify(a.params)],
    );
    await audit(user, "update_llm_provider", "llm_provider", String(id), { name: a.name, key_changed: a.api_key !== existing.api_key });
    invalidateRoutingCache();
    // Embedding consistency can change when an account is re-enabled.
    await assertEmbeddingRoutesValid();
    return accountFromRow(res.rows[0]);
  } catch (err) {
    if (uniqueViolation(err)) throw new ProfileValidationError(`An account named '${a.name}' already exists.`);
    throw err;
  }
}

export async function deleteAccount(id: number, user: string): Promise<void> {
  if (!(await getAccount(id))) throw new ProfileNotFoundError(`No such account: ${id}`);
  const used = await query<{ name: string }>(
    `SELECT DISTINCT r.name FROM admin.llm_route_members m JOIN admin.llm_routes r ON r.id = m.route_id WHERE m.provider_id = $1 ORDER BY r.name`,
    [id],
  );
  if (used.rows.length) {
    throw new ProfileValidationError(`This account is used by profile(s): ${used.rows.map((r) => r.name).join(", ")}. Remove it from them first.`);
  }
  try {
    await query("DELETE FROM admin.llm_providers WHERE id = $1", [id]);
  } catch (err) {
    // A profile started using it between the check and the delete.
    if (fkViolation(err)) throw new ProfileValidationError("This account is used by profile(s): (just added). Remove it from them first.");
    throw err;
  }
  await audit(user, "delete_llm_provider", "llm_provider", String(id), {});
  invalidateRoutingCache();
}

export async function recordAccountTest(id: number, result: Record<string, unknown>): Promise<void> {
  await query("UPDATE admin.llm_providers SET last_test = $2::jsonb WHERE id = $1", [id, JSON.stringify({ ...result, at: new Date().toISOString() })]);
}

// ── route writes ─────────────────────────────────────────────────────────────

export interface MemberInput {
  member_type: "model" | "route";
  provider_id?: number | null;
  model?: string;
  child_route_id?: number | null;
  weight?: number;
  enabled?: boolean;
  params?: Record<string, unknown>;
}

export interface RouteInput {
  name: string;
  kind: ProfileKind;
  strategy: RouteStrategy;
  description?: string;
  members: MemberInput[];
}

/** A route draft checked against a graph: the members as they will be stored, and the graph after the save. */
interface CheckedRoute {
  members: MemberInput[];
  draft: Route;
  draftId: number;
  next: Graph;
}

/**
 * Structural validation of a route as it would be saved, against `graph`
 * (no I/O): names, kinds, members, knobs, cycles and embedding dimensions.
 * Returns the members normalised for storage (unknown knobs dropped).
 */
function checkRouteDraft(input: RouteInput, routeId: number | null, graph: Graph): CheckedRoute {
  const name = String(input.name ?? "").trim();
  if (!name) throw new ProfileValidationError("Profile name is required.");
  if (name.length > MAX_NAME_LENGTH) throw new ProfileValidationError(`Profile name is too long (max ${MAX_NAME_LENGTH}).`);
  if (input.kind !== "analysis" && input.kind !== "embedding") throw new ProfileValidationError(`Unknown profile kind: ${input.kind}`);
  if (!ROUTE_STRATEGIES.includes(input.strategy)) throw new ProfileValidationError(`Unknown strategy: ${input.strategy}`);
  if (!Array.isArray(input.members) || input.members.length === 0) throw new ProfileValidationError("A profile needs at least one member.");
  if (input.strategy === "single" && input.members.length !== 1) {
    throw new ProfileValidationError("A 'single' profile has exactly one member; use fallback / round robin / load balance for more.");
  }

  const role = input.kind as Role;
  const draftId = routeId ?? -1;
  const members: MemberInput[] = [];
  for (const [i, m] of input.members.entries()) {
    const where = `Member ${i + 1}`;
    if (!m || typeof m !== "object") throw new ProfileValidationError(`${where}: unknown member type.`);
    const rawWeight = m.weight ?? 1;
    const weight = typeof rawWeight === "number" ? rawWeight : NaN;
    if (!Number.isInteger(weight) || weight < 0 || weight > MAX_MEMBER_WEIGHT) {
      throw new ProfileValidationError(`${where}: weight must be an integer between 0 and ${MAX_MEMBER_WEIGHT}.`);
    }
    const enabled = booleanOrUndefined(m.enabled, `${where}: enabled`) ?? true;
    if (m.member_type === "model") {
      const acc = m.provider_id ? graph.accounts.get(Number(m.provider_id)) : undefined;
      if (!acc) throw new ProfileValidationError(`${where}: unknown provider account.`);
      const model = typeof m.model === "string" ? m.model.trim() : "";
      if (!model) throw new ProfileValidationError(`${where}: model is required.`);
      const adapter = getAdapter(acc.provider);
      if (!adapter?.spec.roles.includes(role)) {
        throw new ProfileValidationError(`${where}: ${acc.name} (${adapter?.spec.label ?? acc.provider}) does not offer ${role === "embedding" ? "embeddings" : "chat models"}.`);
      }
      const raw = m.params && typeof m.params === "object" && !Array.isArray(m.params) ? m.params : {};
      const specs = adapter.spec.params.filter((spec) => spec.roles.includes(role));
      for (const spec of specs) validateParamValue(spec, raw[spec.key]);
      const allowed = new Set([...specs.map((spec) => spec.key), ...COMMON_MEMBER_KNOBS[role]]);
      const params: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(raw)) if (allowed.has(k) && v !== undefined && v !== null && v !== "") params[k] = v;
      if (params.rpm !== undefined) params.rpm = positiveIntOrUndefined(params.rpm);
      if (params.tpm !== undefined) params.tpm = positiveIntOrUndefined(params.tpm);
      if (input.kind === "embedding") {
        const dims = Number(params.dimensions ?? 1024);
        if (!Number.isInteger(dims) || dims <= 0) throw new ProfileValidationError(`${where}: dimensions must be a positive integer.`);
      }
      members.push({ member_type: "model", provider_id: acc.id, model, child_route_id: null, weight, enabled, params });
    } else if (m.member_type === "route") {
      const child = m.child_route_id ? graph.routes.get(Number(m.child_route_id)) : undefined;
      if (!child) throw new ProfileValidationError(`${where}: unknown profile.`);
      if (child.id === routeId) throw new ProfileValidationError(`${where}: a profile cannot contain itself.`);
      if (members.some((o) => o.member_type === "route" && o.child_route_id === child.id)) {
        throw new ProfileValidationError(`${where}: '${child.name}' is already a member of this profile.`);
      }
      if (child.kind !== input.kind) throw new ProfileValidationError(`${where}: '${child.name}' is a ${child.kind} profile; it cannot go into a ${input.kind} profile.`);
      members.push({ member_type: "route", provider_id: null, model: "", child_route_id: child.id, weight, enabled, params: {} });
    } else {
      throw new ProfileValidationError(`${where}: unknown member type.`);
    }
  }

  // Cycle check on the graph as it would be after the save.
  const draft: Route = {
    id: draftId,
    name,
    kind: input.kind,
    strategy: input.strategy,
    description: String(input.description ?? ""),
    members: members.map((m, i) => ({
      id: -(i + 1),
      member_type: m.member_type,
      provider_id: m.provider_id ?? null,
      model: m.model ?? "",
      child_route_id: m.child_route_id ?? null,
      weight: m.weight ?? 1,
      enabled: m.enabled !== false,
      params: m.params ?? {},
    })),
    updated_at: "",
  };
  const routes = new Map(graph.routes);
  routes.set(draftId, draft);
  const next: Graph = { ...graph, routes };
  const visit = (id: number, stack: number[]): void => {
    if (stack.includes(id)) {
      const names = [...stack.slice(stack.indexOf(id)), id].map((x) => routes.get(x)?.name ?? `#${x}`);
      throw new ProfileValidationError(`Profiles would reference each other in a loop: ${names.join(" → ")}.`);
    }
    for (const m of routes.get(id)?.members ?? []) if (m.member_type === "route" && m.child_route_id) visit(m.child_route_id, [...stack, id]);
  };
  visit(draftId, []);
  if (input.kind === "embedding") {
    // This route, and every embedding route that contains it (directly or not).
    for (const r of routes.values()) {
      if (r.kind !== "embedding") continue;
      const leaves = collectLeaves(next, r.id);
      if (leaves.length) assertEmbeddingDims(leaves);
    }
  }
  return { members, draft, draftId, next };
}

/** Same endpoint and vector size: what the fingerprint verdict is about. */
const leafKey = (l: Pick<LlmProfile, "account_id" | "model" | "params">): string => `${l.account_id}:${l.model}:${embeddingDimensions(l)}`;

/** Does `routeId`'s tree contain `target`? */
function routeContains(graph: Graph, routeId: number, target: number, seen = new Set<number>()): boolean {
  if (routeId === target) return true;
  if (seen.has(routeId)) return false;
  seen.add(routeId);
  return (graph.routes.get(routeId)?.members ?? []).some((m) => m.member_type === "route" && m.child_route_id !== null && routeContains(graph, m.child_route_id, target, seen));
}

/** Validate a route as it would be saved (structure, then the embedding fingerprint); returns the members to store. */
async function validateRoute(input: RouteInput, routeId: number | null, user: string, opts: SaveOptions): Promise<MemberInput[]> {
  invalidateRoutingCache();
  const graph = await loadGraph();
  const checked = checkRouteDraft(input, routeId, graph);
  if (input.kind === "embedding" && !opts.skipFingerprint) {
    // Endpoints this profile already had are not re-judged: editing the name,
    // description, order or weights of a profile must work even after a model
    // switch made it stale (it just cannot serve the role then). Only endpoints
    // the save *adds* must reproduce the system's vectors.
    const existing = new Set(routeId !== null ? collectLeaves(graph, routeId).map(leafKey) : []);
    const added = collectLeaves(checked.next, checked.draftId).filter((l) => !existing.has(leafKey(l)));
    // An outage must not block editing the profile the role runs on: there, the
    // role's own endpoints count as proven. A new profile proves everything.
    const roleRoute = graph.roles.embedding;
    const inRoleTree = routeId !== null && roleRoute !== null && routeContains(graph, roleRoute, routeId);
    const grandfathered = new Set<string>(inRoleTree ? collectLeaves(graph, roleRoute).map((l) => `${l.account_id}:${l.model}`) : []);
    const { assertSameEmbeddingModel } = await import("./embeddingIdentity.js");
    await assertSameEmbeddingModel(added, user, () => roleLeaves("embedding"), grandfathered);
  }
  return checked.members;
}

export interface SaveOptions {
  /** Only for the model-switch procedure, which adopts the new identity itself. */
  skipFingerprint?: boolean;
}

async function assertEmbeddingRoutesValid(): Promise<void> {
  const graph = await loadGraph();
  for (const r of graph.routes.values()) {
    if (r.kind !== "embedding") continue;
    const leaves = collectLeaves(graph, r.id);
    if (leaves.length) assertEmbeddingDims(leaves);
  }
}

export async function saveRoute(input: RouteInput, routeId: number | null, user: string, opts: SaveOptions = {}): Promise<Route> {
  const members = await validateRoute(input, routeId, user, opts);
  if (routeId !== null) {
    const existing = (await listRoutes()).find((r) => r.id === routeId);
    if (!existing) throw new ProfileNotFoundError(`No such profile: ${routeId}`);
    if (existing.kind !== input.kind) {
      const role = await getRoleRoutes();
      const parents = await query("SELECT 1 FROM admin.llm_route_members WHERE child_route_id = $1 LIMIT 1", [routeId]);
      if (role[existing.kind] === routeId || parents.rows.length) {
        throw new ProfileValidationError("This profile is in use; its role (analysis / embedding) cannot change.");
      }
    }
  }
  let id = routeId;
  try {
    await withTransaction(async (client) => {
      if (id === null) {
        const r = await client.query<{ id: string }>(
          "INSERT INTO admin.llm_routes (name, kind, strategy, description) VALUES ($1,$2,$3,$4) RETURNING id",
          [input.name.trim(), input.kind, input.strategy, String(input.description ?? "")],
        );
        id = Number(r.rows[0].id);
      } else {
        await client.query("UPDATE admin.llm_routes SET name=$2, kind=$3, strategy=$4, description=$5, updated_at=NOW() WHERE id=$1", [
          id,
          input.name.trim(),
          input.kind,
          input.strategy,
          String(input.description ?? ""),
        ]);
      }
      // Keep member ids stable where the same block stays (cool-downs and stats are keyed by them).
      const old = await client.query<{ id: string; member_type: string; provider_id: string | null; model: string; child_route_id: string | null }>(
        "SELECT id, member_type, provider_id, model, child_route_id FROM admin.llm_route_members WHERE route_id = $1",
        [id],
      );
      const reusable = new Map<string, number[]>();
      for (const o of old.rows) {
        const k = o.member_type === "model" ? `m:${o.provider_id}:${o.model}` : `r:${o.child_route_id}`;
        reusable.set(k, [...(reusable.get(k) ?? []), Number(o.id)]);
      }
      const kept = new Set<number>();
      for (const [pos, m] of members.entries()) {
        const k = m.member_type === "model" ? `m:${Number(m.provider_id)}:${String(m.model).trim()}` : `r:${Number(m.child_route_id)}`;
        const reuse = reusable.get(k)?.shift();
        const values = [
          pos,
          m.member_type,
          m.member_type === "model" ? Number(m.provider_id) : null,
          m.member_type === "model" ? String(m.model).trim() : "",
          m.member_type === "route" ? Number(m.child_route_id) : null,
          Number(m.weight ?? 1),
          m.enabled !== false,
          JSON.stringify(m.member_type === "model" ? (m.params ?? {}) : {}),
        ];
        if (reuse !== undefined) {
          kept.add(reuse);
          await client.query(
            `UPDATE admin.llm_route_members SET position=$2, member_type=$3, provider_id=$4, model=$5, child_route_id=$6, weight=$7, enabled=$8, params=$9::jsonb WHERE id=$1`,
            [reuse, ...values],
          );
        } else {
          const r = await client.query<{ id: string }>(
            `INSERT INTO admin.llm_route_members (route_id, position, member_type, provider_id, model, child_route_id, weight, enabled, params)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) RETURNING id`,
            [id, ...values],
          );
          kept.add(Number(r.rows[0].id));
        }
      }
      const drop = old.rows.map((o) => Number(o.id)).filter((x) => !kept.has(x));
      if (drop.length) await client.query("DELETE FROM admin.llm_route_members WHERE id = ANY($1::bigint[])", [drop]);
      await client.query(
        `INSERT INTO admin.admin_audit_log (admin_user, action, target_type, target_id, payload_json) VALUES ($1, $2, 'llm_route', $3, $4::jsonb)`,
        [user, routeId === null ? "create_llm_route" : "update_llm_route", String(id), JSON.stringify({ name: input.name, strategy: input.strategy, members: members.length })],
      );
    });
  } catch (err) {
    if (uniqueViolation(err)) throw new ProfileValidationError(`A profile named '${input.name.trim()}' already exists.`);
    // A referenced profile / account was deleted between validation and the write.
    if (fkViolation(err)) throw new ProfileValidationError("A member references a profile or account that was just deleted; reload and try again.");
    throw err;
  }
  invalidateRoutingCache();
  const saved = (await listRoutes()).find((r) => r.id === id);
  // Updated row vanished (deleted concurrently).
  if (!saved) throw new ProfileNotFoundError(`No such profile: ${id}`);
  return saved;
}

export interface DeletePlan {
  target: { id: number; name: string; kind: ProfileKind };
  /** Profiles that reference the target (or a cascaded one) and only lose that member. */
  modified: { id: number; name: string; removed: string[]; remaining: number }[];
  /** Profiles left with no members once the references are removed — deleted too. */
  cascade: { id: number; name: string; because: string }[];
  /** Roles bound to a deleted profile: they become unassigned (requests to them stop). */
  unbound_roles: { role: ProfileKind; route: string }[];
  /** Roles whose profile tree contains a deleted profile: their request path changes. */
  affected_roles: { role: ProfileKind; route: string }[];
  /** Profiles the target contains: they stay, only no longer referenced by it. */
  children_kept: { id: number; name: string }[];
  /** True when anything besides the target itself changes. */
  has_impact: boolean;
}

/**
 * What deleting a profile would do. Referencing profiles lose the member; any
 * left empty is deleted as well, recursively; roles bound to a deleted profile
 * become unassigned.
 */
export async function planRouteDelete(id: number): Promise<DeletePlan> {
  invalidateRoutingCache();
  return planDeleteInGraph(await loadGraph(), id);
}

/** Pure part of `planRouteDelete` (unit-tested). */
export function planDeleteInGraph(graph: Graph, id: number): DeletePlan {
  const target = graph.routes.get(id);
  if (!target) throw new ProfileNotFoundError(`No such profile: ${id}`);
  const deleted = new Map<number, string>([[id, ""]]);
  const removed = new Map<number, Set<number>>(); // parent id → member ids dropped
  const queue = [id];
  while (queue.length) {
    const gone = queue.shift()!;
    for (const r of graph.routes.values()) {
      if (deleted.has(r.id)) continue;
      const refs = r.members.filter((m) => m.member_type === "route" && m.child_route_id === gone);
      if (!refs.length) continue;
      const set = removed.get(r.id) ?? new Set<number>();
      for (const m of refs) set.add(m.id);
      removed.set(r.id, set);
      if (r.members.every((m) => set.has(m.id))) {
        deleted.set(r.id, graph.routes.get(gone)?.name ?? "");
        removed.delete(r.id);
        queue.push(r.id);
      }
    }
  }
  const nameOf = (x: number) => graph.routes.get(x)?.name ?? `#${x}`;
  const containsDeleted = (rid: number, seen = new Set<number>()): boolean => {
    if (deleted.has(rid)) return true;
    if (seen.has(rid)) return false;
    seen.add(rid);
    return (graph.routes.get(rid)?.members ?? []).some((m) => m.member_type === "route" && m.child_route_id !== null && containsDeleted(m.child_route_id, seen));
  };
  const unbound: DeletePlan["unbound_roles"] = [];
  const affected: DeletePlan["affected_roles"] = [];
  for (const role of ["analysis", "embedding"] as const) {
    const bound = graph.roles[role];
    if (!bound) continue;
    if (deleted.has(bound)) unbound.push({ role, route: nameOf(bound) });
    else if (containsDeleted(bound) || removed.has(bound)) affected.push({ role, route: nameOf(bound) });
  }
  const modified = [...removed.entries()].map(([rid, set]) => ({
    id: rid,
    name: nameOf(rid),
    removed: (graph.routes.get(rid)?.members ?? []).filter((m) => set.has(m.id)).map((m) => nameOf(m.child_route_id!)),
    remaining: (graph.routes.get(rid)?.members.length ?? 0) - set.size,
  }));
  const cascade = [...deleted.entries()].filter(([rid]) => rid !== id).map(([rid, because]) => ({ id: rid, name: nameOf(rid), because }));
  const children = target.members.filter((m) => m.member_type === "route" && m.child_route_id !== null && !deleted.has(m.child_route_id)).map((m) => ({ id: m.child_route_id!, name: nameOf(m.child_route_id!) }));
  return {
    target: { id, name: target.name, kind: target.kind },
    modified,
    cascade,
    unbound_roles: unbound,
    affected_roles: affected,
    children_kept: children,
    has_impact: modified.length > 0 || cascade.length > 0 || unbound.length > 0,
  };
}

/**
 * Delete a profile. When others depend on it the caller must pass the plan's
 * confirmation (the target's name) — then references are removed, emptied
 * profiles are deleted and roles unbound, all in one transaction.
 */
export async function deleteRoute(id: number, user: string, opts: { confirm?: string } = {}): Promise<DeletePlan> {
  const plan = await planRouteDelete(id);
  if (plan.has_impact && opts.confirm !== plan.target.name) {
    throw new ProfileValidationError(
      `Deleting '${plan.target.name}' affects other profiles or roles; review the impact and confirm with the profile name.`,
    );
  }
  const ids = [id, ...plan.cascade.map((c) => c.id)];
  try {
  await withTransaction(async (client) => {
    await client.query("UPDATE admin.llm_role_routes SET route_id = NULL, updated_at = NOW() WHERE route_id = ANY($1::bigint[])", [ids]);
    await client.query("DELETE FROM admin.llm_route_members WHERE member_type = 'route' AND child_route_id = ANY($1::bigint[])", [ids]);
    await client.query("DELETE FROM admin.llm_routes WHERE id = ANY($1::bigint[])", [ids]);
    // Re-number positions of the profiles that lost a member.
    for (const m of plan.modified) {
      await client.query(
        `UPDATE admin.llm_route_members t SET position = s.rn - 1
           FROM (SELECT id, row_number() OVER (ORDER BY position, id) AS rn FROM admin.llm_route_members WHERE route_id = $1) s
          WHERE t.id = s.id`,
        [m.id],
      );
    }
    await client.query(
      `INSERT INTO admin.admin_audit_log (admin_user, action, target_type, target_id, payload_json) VALUES ($1, 'delete_llm_route', 'llm_route', $2, $3::jsonb)`,
      [user, String(id), JSON.stringify({ name: plan.target.name, cascade: plan.cascade.map((c) => c.name), modified: plan.modified.map((m) => m.name), unbound_roles: plan.unbound_roles.map((r) => r.role) })],
    );
  });
  } catch (err) {
    // Another profile started referencing it after the plan was made.
    if (fkViolation(err)) {
      throw new ProfileValidationError(`Deleting '${plan.target.name}' affects other profiles or roles; review the impact and confirm with the profile name.`);
    }
    throw err;
  }
  invalidateRoutingCache();
  return plan;
}

export async function setRoleRoute(role: ProfileKind, routeId: number | null, user: string, opts: SaveOptions = {}): Promise<void> {
  if (role !== "analysis" && role !== "embedding") throw new ProfileValidationError(`Unknown role: ${role}`);
  if (routeId !== null) {
    const r = (await listRoutes()).find((x) => x.id === routeId);
    if (!r) throw new ProfileValidationError(`No such profile: ${routeId}`);
    if (r.kind !== role) throw new ProfileValidationError(`'${r.name}' is a ${r.kind} profile; it cannot serve the ${role} role.`);
    invalidateRoutingCache();
    const leaves = await roleLeaves(role, routeId);
    // Every member (or its account) is off: the role would have no model at all.
    if (leaves.length === 0) throw new ProfileValidationError(`'${r.name}' has no enabled model; enable a member before assigning it to a role.`);
    if (role === "embedding" && !opts.skipFingerprint) {
      const { assertSameEmbeddingModel } = await import("./embeddingIdentity.js");
      const inService = new Set((await roleLeaves("embedding")).map((l) => `${l.account_id}:${l.model}`));
      await assertSameEmbeddingModel(leaves, user, () => roleLeaves("embedding"), inService);
    }
  }
  try {
    await query(
      `INSERT INTO admin.llm_role_routes (role, route_id, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (role) DO UPDATE SET route_id = EXCLUDED.route_id, updated_at = NOW()`,
      [role, routeId],
    );
  } catch (err) {
    if (fkViolation(err)) throw new ProfileNotFoundError(`No such profile: ${routeId}`);
    throw err;
  }
  await audit(user, "set_llm_role_route", "llm_role", role, { route_id: routeId });
  invalidateRoutingCache();
}

// ── export / import (settings document) ──────────────────────────────────────

export interface RoutingExport {
  providers: Array<Omit<ProviderAccount, "id" | "created_at" | "updated_at" | "last_test" | "oauth"> & { ref: string }>;
  profiles: Array<{ ref: string; name: string; kind: ProfileKind; strategy: RouteStrategy; description: string; members: Array<Record<string, unknown>> }>;
  roles: Record<ProfileKind, string | null>;
}

/**
 * Subscription sign-ins are left out: their tokens are bound to this host and
 * refresh tokens rotate — a copy used elsewhere would revoke the sign-in here.
 * Members on such accounts are dropped from the exported profiles; sign in
 * again after importing.
 */
export async function exportRouting(): Promise<RoutingExport> {
  const accounts = (await listAccounts()).filter((a) => a.auth_type !== "oauth");
  const exportable = new Set(accounts.map((a) => a.id));
  const routes = (await listRoutes()).map((r) => ({
    ...r,
    members: r.members.filter((m) => m.member_type !== "model" || exportable.has(m.provider_id!)),
  }));
  const roles = await getRoleRoutes();
  const accRef = new Map(accounts.map((a) => [a.id, a.name]));
  const routeRef = new Map(routes.map((r) => [r.id, r.name]));
  return {
    providers: accounts.map((a) => ({
      ref: a.name,
      name: a.name,
      provider: a.provider,
      base_url: a.base_url,
      auth_type: a.auth_type,
      api_key: a.api_key,
      enabled: a.enabled,
      params: a.params,
    })),
    profiles: routes.map((r) => ({
      ref: r.name,
      name: r.name,
      kind: r.kind,
      strategy: r.strategy,
      description: r.description,
      members: r.members.map((m) =>
        m.member_type === "model"
          ? { member_type: "model", provider: accRef.get(m.provider_id!), model: m.model, weight: m.weight, enabled: m.enabled, params: m.params }
          : { member_type: "route", profile: routeRef.get(m.child_route_id!), weight: m.weight, enabled: m.enabled },
      ),
    })),
    roles: { analysis: roles.analysis ? (routeRef.get(roles.analysis) ?? null) : null, embedding: roles.embedding ? (routeRef.get(roles.embedding) ?? null) : null },
  };
}

/** Ids handed to not-yet-written accounts / profiles while an import is validated. */
const VIRTUAL_ACCOUNT_BASE = 1_000_000_000;
const VIRTUAL_ROUTE_BASE = 2_000_000_000;

/** What decides whether two endpoints produce the same vectors: where, as whom, which model, how many dims. */
function endpointSignature(acc: Pick<ProviderAccount, "provider" | "base_url" | "api_key">, model: string, dims: number): string {
  return [acc.provider, acc.base_url.replace(/\/+$/, ""), acc.api_key, model, dims].join("\u0000");
}

/**
 * Replace all accounts, profiles and role bindings with an exported set.
 *
 * Everything is validated first against a virtual graph (nothing written), the
 * embedding fingerprint included; then the replacement happens in one
 * transaction — a bad document leaves the current configuration untouched.
 *
 * Subscription (sign-in) accounts are never in an export, so they are kept,
 * and members on them are put back into the same-named imported profile.
 * Embedding endpoints already serving the system (or with a passing verdict
 * under the current identity) are not re-probed, so re-importing an export
 * works while one of its endpoints is temporarily down.
 */
export async function importRouting(doc: unknown, user: string): Promise<{ providers: number; profiles: number }> {
  const d = (doc && typeof doc === "object" ? doc : {}) as Partial<RoutingExport>;
  if (!Array.isArray(d.providers) || !Array.isArray(d.profiles)) throw new ProfileValidationError("'llm' must contain providers[] and profiles[]");
  invalidateRoutingCache();
  const current = await loadGraph();

  // 1. Accounts.
  const kept = [...current.accounts.values()].filter((a) => a.auth_type === "oauth");
  const accounts = new Map<number, ProviderAccount>(kept.map((a) => [a.id, a]));
  const accIds = new Map<string, number>();
  const accountNames = new Set(kept.map((a) => a.name));
  d.providers.forEach((raw, i) => {
    if (!raw || typeof raw !== "object") throw new ProfileValidationError(`Imported account #${i + 1} is not an object.`);
    const p = raw as RoutingExport["providers"][number];
    const a = normalizeAccount({ name: p.name, provider: p.provider, base_url: p.base_url, api_key: p.api_key, enabled: p.enabled, params: p.params });
    if (accountNames.has(a.name)) throw new ProfileValidationError(`An account named '${a.name}' already exists.`);
    accountNames.add(a.name);
    const id = VIRTUAL_ACCOUNT_BASE + i;
    accounts.set(id, { ...a, id, oauth: null, last_test: null, created_at: "", updated_at: "" });
    accIds.set(String(p.ref ?? p.name), id);
  });

  // 2. Profiles, in dependency order, each checked against the graph built so far.
  const graph: Graph = { accounts, routes: new Map(), roles: { analysis: null, embedding: null } };
  const oldByName = new Map([...current.routes.values()].map((r) => [r.name, r]));
  const keptIds = new Set(kept.map((a) => a.id));
  const pending = d.profiles.map((raw, i) => {
    if (!raw || typeof raw !== "object" || !Array.isArray((raw as { members?: unknown }).members)) {
      throw new ProfileValidationError(`Imported profile #${i + 1} must have a members[] list.`);
    }
    return { p: raw as RoutingExport["profiles"][number], i };
  });
  const routeIds = new Map<string, number>();
  const routeNames = new Set<string>();
  const order: { id: number; input: RouteInput; members: MemberInput[] }[] = [];
  while (pending.length) {
    const idx = pending.findIndex(({ p }) => p.members.every((m) => m?.member_type !== "route" || routeIds.has(String(m.profile))));
    if (idx < 0) throw new ProfileValidationError("Imported profiles reference missing profiles or each other in a loop.");
    const { p, i } = pending.splice(idx, 1)[0];
    const input: RouteInput = {
      name: p.name,
      kind: p.kind,
      strategy: p.strategy,
      description: p.description,
      members: p.members.map((m) =>
        m.member_type === "route"
          ? { member_type: "route", child_route_id: routeIds.get(String(m.profile)), weight: m.weight as number | undefined, enabled: m.enabled as boolean | undefined }
          : {
              member_type: m.member_type as MemberInput["member_type"],
              provider_id: accIds.get(String(m.provider)) ?? null,
              model: m.model as string,
              weight: m.weight as number | undefined,
              enabled: m.enabled as boolean | undefined,
              params: (m.params as Record<string, unknown>) ?? {},
            },
      ),
    };
    const name = String(p.name ?? "").trim();
    if (routeNames.has(name)) throw new ProfileValidationError(`A profile named '${name}' already exists.`);
    routeNames.add(name);
    // Members on subscription accounts were left out of the export: keep them.
    const old = oldByName.get(name);
    if (old && old.kind === input.kind && input.strategy !== "single") {
      for (const m of old.members) {
        if (m.member_type === "model" && m.provider_id !== null && keptIds.has(m.provider_id)) {
          input.members.push({ member_type: "model", provider_id: m.provider_id, model: m.model, weight: m.weight, enabled: m.enabled, params: m.params });
        }
      }
    }
    const id = VIRTUAL_ROUTE_BASE + i;
    const checked = checkRouteDraft(input, id, graph);
    graph.routes.set(id, checked.draft);
    order.push({ id, input, members: checked.members });
    routeIds.set(String(p.ref ?? p.name), id);
  }

  // 3. Role bindings.
  for (const role of ["analysis", "embedding"] as const) {
    const ref = d.roles?.[role];
    const id = ref ? routeIds.get(String(ref)) : undefined;
    if (id === undefined) continue;
    const r = graph.routes.get(id)!;
    if (r.kind !== role) throw new ProfileValidationError(`'${r.name}' is a ${r.kind} profile; it cannot serve the ${role} role.`);
    graph.roles[role] = id;
  }

  // 4. Embedding fingerprint for endpoints that are new to this system.
  const proven = new Set<string>();
  const sigOf = (l: LlmProfile) => endpointSignature(accounts.get(l.account_id!) ?? { provider: l.provider, base_url: l.base_url, api_key: l.api_key }, l.model, embeddingDimensions(l));
  if (current.roles.embedding) for (const l of collectLeaves(current, current.roles.embedding)) proven.add(sigOf(l));
  const { getIdentity, assertSameEmbeddingModel } = await import("./embeddingIdentity.js");
  const identity = await getIdentity();
  if (identity) {
    const ok = await query<{ account_id: string; model: string; dimensions: number }>(
      "SELECT account_id, model, dimensions FROM admin.embedding_fingerprints WHERE ok AND identity_version = $1",
      [identity.version],
    );
    for (const row of ok.rows) {
      const acc = current.accounts.get(Number(row.account_id));
      if (acc) proven.add(endpointSignature(acc, row.model, Number(row.dimensions)));
    }
  }
  const toCheck = new Map<string, LlmProfile>();
  for (const r of graph.routes.values()) {
    if (r.kind !== "embedding") continue;
    for (const l of collectLeaves(graph, r.id)) {
      const sig = sigOf(l);
      // Not-yet-written accounts have no id to cache a verdict under.
      if (!proven.has(sig)) toCheck.set(sig, { ...l, account_id: keptIds.has(l.account_id!) ? l.account_id : 0 });
    }
  }
  if (toCheck.size) await assertSameEmbeddingModel([...toCheck.values()], user, () => roleLeaves("embedding"), new Set());

  // 5. Write everything at once.
  await withTransaction(async (client) => {
    await client.query("DELETE FROM admin.llm_role_routes");
    await client.query("DELETE FROM admin.llm_route_members");
    await client.query("DELETE FROM admin.llm_routes");
    await client.query("DELETE FROM admin.llm_providers WHERE auth_type <> 'oauth'");
    const realAccount = new Map<number, number>(kept.map((a) => [a.id, a.id]));
    for (const [vid, a] of accounts) {
      if (keptIds.has(vid)) continue;
      const res = await client.query<{ id: string }>(
        `INSERT INTO admin.llm_providers (name, provider, base_url, auth_type, api_key, enabled, params) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING id`,
        [a.name, a.provider, a.base_url, a.auth_type, a.api_key, a.enabled, JSON.stringify(a.params)],
      );
      realAccount.set(vid, Number(res.rows[0].id));
    }
    const realRoute = new Map<number, number>();
    for (const o of order) {
      const res = await client.query<{ id: string }>(
        "INSERT INTO admin.llm_routes (name, kind, strategy, description) VALUES ($1,$2,$3,$4) RETURNING id",
        [String(o.input.name).trim(), o.input.kind, o.input.strategy, String(o.input.description ?? "")],
      );
      const rid = Number(res.rows[0].id);
      realRoute.set(o.id, rid);
      for (const [pos, m] of o.members.entries()) {
        await client.query(
          `INSERT INTO admin.llm_route_members (route_id, position, member_type, provider_id, model, child_route_id, weight, enabled, params)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
          [
            rid,
            pos,
            m.member_type,
            m.member_type === "model" ? realAccount.get(Number(m.provider_id)) : null,
            m.member_type === "model" ? m.model : "",
            m.member_type === "route" ? realRoute.get(Number(m.child_route_id)) : null,
            m.weight ?? 1,
            m.enabled !== false,
            JSON.stringify(m.member_type === "model" ? (m.params ?? {}) : {}),
          ],
        );
      }
    }
    for (const role of ["analysis", "embedding"] as const) {
      await client.query("INSERT INTO admin.llm_role_routes (role, route_id, updated_at) VALUES ($1, $2, NOW())", [
        role,
        graph.roles[role] === null ? null : realRoute.get(graph.roles[role]!),
      ]);
    }
    await client.query(
      `INSERT INTO admin.admin_audit_log (admin_user, action, target_type, target_id, payload_json) VALUES ($1, 'import_llm_routing', 'llm', 'all', $2::jsonb)`,
      [user, JSON.stringify({ providers: d.providers!.length, profiles: order.length, kept_subscription_accounts: kept.map((a) => a.name) })],
    );
  });
  invalidateRoutingCache();
  return { providers: d.providers.length, profiles: d.profiles.length };
}

/**
 * Convert a version-2 settings export (flat `profiles[]` + per-role strategy) to
 * the routing document — the same mapping as the 2026-10 database migration.
 */
export function legacyProfilesToRouting(profiles: unknown, strategies: Partial<Record<ProfileKind, string>>): RoutingExport {
  const list = (Array.isArray(profiles) ? profiles : []) as Array<Record<string, unknown>>;
  const out: RoutingExport = { providers: [], profiles: [], roles: { analysis: null, embedding: null } };
  const accountKey = new Map<string, string>();
  for (const kind of ["analysis", "embedding"] as const) {
    const rows = list.filter((p) => p.kind === kind).sort((a, b) => Number(a.priority ?? 100) - Number(b.priority ?? 100));
    if (!rows.length) continue;
    const members: Array<Record<string, unknown>> = [];
    for (const p of rows) {
      const provider = legacyProviderId(String(p.provider ?? ""), String(p.base_url ?? ""));
      const k = `${provider}\t${p.base_url ?? ""}\t${p.api_key ?? ""}`;
      let ref = accountKey.get(k);
      if (!ref) {
        ref = String(p.name ?? provider);
        if (out.providers.some((x) => x.name === ref)) ref = `${ref}（${kind}）`;
        out.providers.push({
          ref,
          name: ref,
          provider,
          base_url: String(p.base_url ?? ""),
          auth_type: p.api_key ? "api_key" : "none",
          api_key: String(p.api_key ?? ""),
          enabled: true,
          params: {},
        });
        accountKey.set(k, ref);
      }
      // Limits stay with the model for now; hoisted to the account below when all its models agree.
      const params = { ...((p.params ?? {}) as Record<string, unknown>) };
      members.push({ member_type: "model", provider: ref, model: String(p.model ?? ""), weight: Number(p.weight ?? 1), enabled: p.enabled !== false, params });
    }
    const name = kind === "analysis" ? "分析 LLM（預設）" : "Embedding（預設）";
    out.profiles.push({
      ref: name,
      name,
      kind,
      strategy: strategies[kind] === "weighted" ? "load_balance" : "fallback",
      description: "由舊版端點設定轉換",
      members,
    });
    out.roles[kind] = name;
  }
  // RPM / TPM were per endpoint profile. Profiles merged into one account keep
  // theirs: when every one of them had the same value it becomes the account's,
  // otherwise each member keeps its own (limits are enforced per member), so a
  // limit is never dropped and never imposed on a profile that had none.
  for (const acc of out.providers) {
    const ms = out.profiles.flatMap((r) => r.members).filter((m) => m.provider === acc.ref);
    for (const key of ["rpm", "tpm"]) {
      const values = new Set(ms.map((m) => JSON.stringify((m.params as Record<string, unknown>)[key] ?? null)));
      if (values.size === 1) {
        const v = (ms[0]?.params as Record<string, unknown> | undefined)?.[key];
        if (v !== undefined && v !== null) acc.params[key] = v;
        for (const m of ms) delete (m.params as Record<string, unknown>)[key];
      } else {
        delete acc.params[key];
      }
    }
  }
  return out;
}
