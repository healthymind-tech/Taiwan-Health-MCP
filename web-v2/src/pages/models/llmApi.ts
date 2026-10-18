/**
 * Provider accounts, profiles and role bindings — client side of
 * node-server/src/admin/adminLlmApi.ts (/admin/api/llm/*).
 */
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { LlmProfileKind, LlmProfileStats } from "@/lib/types";
import type { KnobValue, ProviderSpec } from "./profileModel";

export type RouteStrategy = "single" | "fallback" | "round_robin" | "load_balance";

export interface ProviderAccount {
  id: number;
  name: string;
  provider: string;
  base_url: string;
  auth_type: "api_key" | "oauth" | "none";
  enabled: boolean;
  params: Record<string, unknown>;
  last_test: { ok: boolean; message?: string; code?: string; params?: Record<string, unknown>; at?: string; model_count?: number } | null;
  has_api_key: boolean;
  /** Subscription sign-in summary (never tokens). */
  oauth: { email: string; status: string; expires_at: string | null; connected_by: string; connected_at: string | null; last_error: string | null } | null;
  created_at: string;
  updated_at: string;
}

export interface RouteMember {
  id: number;
  member_type: "model" | "route";
  provider_id: number | null;
  model: string;
  child_route_id: number | null;
  weight: number;
  enabled: boolean;
  params: Record<string, KnobValue>;
}

export interface Route {
  id: number;
  name: string;
  kind: LlmProfileKind;
  strategy: RouteStrategy;
  description: string;
  members: RouteMember[];
  updated_at: string;
  /** Embedding profile with an endpoint known not to match the system model (e.g. after a model switch). */
  stale?: boolean;
}

export interface RoutesPayload {
  routes: Route[];
  roles: Record<LlmProfileKind, number | null>;
  stats: Record<string, LlmProfileStats>;
  cooling: Record<string, number>;
}

export interface AccountsPayload {
  accounts: ProviderAccount[];
  cooling: Record<string, number>;
}

export const llmKeys = {
  accounts: ["llm", "accounts"] as const,
  routes: ["llm", "routes"] as const,
  models: (id: number, kind: LlmProfileKind) => ["llm", "models", id, kind] as const,
};

export function useAccounts() {
  return useQuery({ queryKey: llmKeys.accounts, queryFn: () => api.get<AccountsPayload>("/admin/api/llm/accounts"), staleTime: 10_000 });
}

export function useRoutes() {
  return useQuery({
    queryKey: llmKeys.routes,
    queryFn: () => api.get<RoutesPayload>("/admin/api/llm/routes"),
    staleTime: 10_000,
    refetchInterval: 30_000,
  });
}

export interface ModelListing {
  ok: boolean;
  models: string[];
  message: string;
  /** Stable message code + params (see llmErrors.ts). */
  code?: string;
  params?: Record<string, unknown>;
}

/** Live model list of one account for a role (cached; the palette and pickers share it). */
export function useAccountModels(id: number | null, kind: LlmProfileKind, enabled = true) {
  return useQuery({
    queryKey: llmKeys.models(id ?? 0, kind),
    queryFn: () => api.post<ModelListing>(`/admin/api/llm/accounts/${id}/models`, { kind }),
    enabled: enabled && id !== null,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export const STRATEGY_META: Record<RouteStrategy, { label: string; short: string; description: string }> = {
  single: { label: "單一模型", short: "單一", description: "只使用一個成員。最簡單，沒有備援。" },
  fallback: { label: "依序備援", short: "備援", description: "永遠先用第一個；失敗、逾時或冷卻中才依序換下一個。" },
  round_robin: { label: "輪詢", short: "輪詢", description: "每個請求輪流從下一個成員開始，平均分攤；失敗仍會往後備援。" },
  load_balance: { label: "加權負載平衡", short: "加權", description: "依權重隨機抽出先用的成員；權重 0 只當備援。失敗仍會往後備援。" },
};

/** Stable accent per provider type (neutral palette — status colours stay reserved). */
const ACCENTS = ["brand", "indigo", "cyan", "violet", "grape", "teal", "blue", "pink", "orange", "lime"];
export function providerAccent(providerId: string): string {
  let h = 0;
  for (const ch of providerId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return ACCENTS[h % ACCENTS.length];
}

export function specFor(specs: ProviderSpec[] | undefined, id: string): ProviderSpec | undefined {
  return specs?.find((s) => s.id === id);
}

/** Profiles of `kind` that can be placed inside `routeId` without creating a loop. */
export function nestableRoutes(routes: Route[], kind: LlmProfileKind, routeId: number | null): Route[] {
  const byId = new Map(routes.map((r) => [r.id, r]));
  const contains = (from: number, target: number, seen = new Set<number>()): boolean => {
    if (from === target) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return (byId.get(from)?.members ?? []).some((m) => m.member_type === "route" && m.child_route_id !== null && contains(m.child_route_id, target, seen));
  };
  return routes.filter((r) => r.kind === kind && r.id !== routeId && (routeId === null || !contains(r.id, routeId)));
}

export interface FlatLeaf {
  member: RouteMember;
  account: ProviderAccount | undefined;
  /** Probability this leaf is tried first for a request (0 = backup only). */
  share: number;
  /** 1-based position in the static fallback order. */
  rank: number;
  /** Nested profile names this leaf is reached through (outermost first). */
  via: string[];
  /** Why it would be skipped at call time, if it would. */
  skipped: "disabled" | "account_disabled" | "not_allowed" | null;
}

/**
 * Client mirror of the server's profile expansion (llmRouting.ts), for display:
 * every leaf in static order, with its chance of being the first one tried
 * (fallback/single: the first usable member; round robin: equal; load balance:
 * by weight; nesting multiplies).
 */
export function flattenRoute(route: Route, routes: Map<number, Route>, accounts: Map<number, ProviderAccount>): FlatLeaf[] {
  const out: FlatLeaf[] = [];
  const walk = (r: Route, share: number, via: string[], path: Set<number>) => {
    const usable = (m: RouteMember) => {
      if (!m.enabled) return false;
      if (m.member_type === "route") return m.child_route_id !== null && routes.has(m.child_route_id) && !path.has(m.child_route_id);
      const a = m.provider_id !== null ? accounts.get(m.provider_id) : undefined;
      return Boolean(a && a.enabled && (a.auth_type !== "oauth" || a.params.allow_role_use === true));
    };
    const live = r.members.filter(usable);
    const totalW = live.reduce((s, m) => s + Math.max(0, m.weight), 0);
    const firstShare = (m: RouteMember): number => {
      if (!usable(m)) return 0;
      switch (r.strategy) {
        case "single":
        case "fallback":
          return m === live[0] ? 1 : 0;
        case "round_robin":
          return 1 / live.length;
        case "load_balance":
          return totalW > 0 ? Math.max(0, m.weight) / totalW : m === live[0] ? 1 : 0;
      }
    };
    const members = r.strategy === "single" ? r.members.slice(0, 1) : r.members;
    for (const m of members) {
      const s = share * firstShare(m);
      if (m.member_type === "route") {
        const child = m.child_route_id !== null ? routes.get(m.child_route_id) : undefined;
        if (child && !path.has(child.id)) walk(child, s, [...via, child.name], new Set(path).add(child.id));
        continue;
      }
      const a = m.provider_id !== null ? accounts.get(m.provider_id) : undefined;
      out.push({
        member: m,
        account: a,
        share: s,
        rank: 0,
        via,
        skipped: !m.enabled ? "disabled" : !a || !a.enabled ? "account_disabled" : a.auth_type === "oauth" && a.params.allow_role_use !== true ? "not_allowed" : null,
      });
    }
  };
  walk(route, 1, [], new Set([route.id]));
  let rank = 0;
  for (const l of out) l.rank = l.skipped ? 0 : ++rank;
  return out;
}

// ── system embedding identity (node-server/src/admin/embeddingIdentity.ts) ──

export interface EmbeddingIdentityPayload {
  identity: {
    version: number;
    state: "active" | "switching";
    model: string;
    provider: string;
    account_name: string;
    dimensions: number;
    created_at: string;
    created_by: string;
  } | null;
  counts: { table: string; label: string; module: string; count: number }[];
  min_similarity: number;
  probe_count: number;
}

export interface FingerprintResult {
  ok: boolean;
  /** The endpoint did not answer the probe. */
  unreachable?: boolean;
  anchor_missing: boolean;
  min_similarity: number | null;
  mean_similarity: number | null;
  dimensions: number | null;
  message: string;
  /** The endpoint answered, but not with usable embeddings (HTTP 4xx/5xx). */
  incompatible?: boolean;
  /** Stable message code + params (see llmErrors.ts). */
  code?: string;
  params?: Record<string, unknown>;
}

export const embeddingKeys = {
  identity: ["llm", "embedding", "identity"] as const,
  check: (providerId: number, model: string, dims: number) => ["llm", "embedding", "check", providerId, model, dims] as const,
};

export function useEmbeddingIdentity() {
  return useQuery({
    queryKey: embeddingKeys.identity,
    queryFn: () => api.get<EmbeddingIdentityPayload>("/admin/api/llm/embedding"),
    staleTime: 15_000,
  });
}

/** Cached fingerprint verdict for one (account, model, dims) — for badges in lists. */
export function useFingerprint(providerId: number | null, model: string, dims: number, enabled = true) {
  return useQuery({
    queryKey: embeddingKeys.check(providerId ?? 0, model, dims),
    queryFn: () => api.post<FingerprintResult>("/admin/api/llm/embedding/check", { provider_id: providerId, model, params: { dimensions: dims }, cached: true }),
    enabled: enabled && providerId !== null && model.trim() !== "",
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/** An endpoint problem, coded like errors (see llmErrors.ts). */
export interface EmbedIssue {
  code: string;
  params: Record<string, unknown>;
}

/** POST /admin/api/llm/embedding/precheck — what a switch would find, without side effects. */
export interface SwitchPrecheck {
  ok: boolean;
  blocking: EmbedIssue | null;
  warnings: EmbedIssue[];
  returned_dims: number | null;
  configured_dims: number;
  latency_ms: number | null;
  same_model: boolean;
  similarity: number | null;
  identity: { model: string; dimensions: number; account: string } | null;
  column_dims: number | null;
  alter_columns: boolean;
  hnsw: boolean;
  summary: Record<string, unknown>;
}

export interface EmbeddingHealth {
  members: { member_id: number; name: string; account: string; model: string; ok: boolean; latency_ms: number | null; returned_dims: number | null; issue: EmbedIssue | null }[];
  degraded: boolean;
  down: boolean;
  answering: string | null;
  checked_at: string;
}

export const embeddingHealthKey = ["llm", "embedding", "health"] as const;

/** Live probe of each embedding-role member (server caches it for a minute). */
export function useEmbeddingHealth(enabled = true) {
  return useQuery({
    queryKey: embeddingHealthKey,
    queryFn: () => api.get<EmbeddingHealth>("/admin/api/llm/embedding/health"),
    enabled,
    staleTime: 60_000,
    refetchInterval: 120_000,
    retry: false,
  });
}
