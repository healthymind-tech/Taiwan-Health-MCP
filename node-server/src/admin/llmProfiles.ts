/**
 * The call-time view of model endpoints, for the roles that call a model server
 * ("analysis", "embedding").
 *
 * Configuration lives in `llmRouting.ts` (provider accounts + composable
 * profiles + role bindings). Callers never see that structure: they ask
 * `candidateOrder(kind)` for the flat list of leaves to try for one request —
 * each an `LlmProfile` (account URL/key + model + knobs) — and walk it, calling
 * `reportSuccess` / `reportFailure` as they go.
 *
 * A leaf that fails repeatedly goes into a short cool-down (a process-local
 * circuit breaker) so a dead endpoint stops costing every request a timeout —
 * but nothing is ever disabled behind the operator's back.
 */

import { logWarning } from "../logger.js";
import { roleLeaves, routeCandidates } from "./llmRouting.js";

export type ProfileKind = "analysis" | "embedding";
/** @deprecated The strategy now lives on each profile; kept for call-site compatibility. */
export type Strategy = "failover" | "weighted";

/** One callable leaf: a model on a provider account, with its knobs. `id` = route member id. */
export interface LlmProfile {
  id: number;
  kind: ProfileKind;
  name: string;
  provider: string;
  base_url: string;
  api_key: string;
  model: string;
  enabled: boolean;
  priority: number;
  weight: number;
  params: Record<string, unknown>;
  /** Provider account the leaf calls through (OAuth adapters fetch its token). */
  account_id?: number;
}

export class ProfileValidationError extends Error {}

/** The addressed account / profile does not exist (HTTP 404). */
export class ProfileNotFoundError extends ProfileValidationError {}

export function embeddingDimensions(p: Pick<LlmProfile, "params">, fallback = 1024): number {
  const n = Math.trunc(Number(p.params?.dimensions ?? fallback));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Every enabled leaf reachable from the role's profile (no strategy draw). */
export async function listEnabled(kind: ProfileKind): Promise<LlmProfile[]> {
  return (await roleLeaves(kind)).filter((p) => p.enabled);
}

/** Is this role usable at all? (Its profile reaches at least one enabled model.) */
export async function isKindConfigured(kind: ProfileKind): Promise<boolean> {
  return (await listEnabled(kind)).some((p) => p.base_url && p.model);
}

/**
 * The order to try leaves in for one request: the role's profile expanded by
 * each level's strategy (single / fallback / round robin / load balance), with
 * leaves in cool-down moved to the back. `_strategy` is ignored.
 */
export async function candidateOrder(kind: ProfileKind, _strategy?: Strategy): Promise<LlmProfile[]> {
  return (await routeCandidates(kind)).filter((p) => p.base_url && p.model);
}

// ── Circuit breaker ──────────────────────────────────────────────────────────
// Process-local: the app and the worker each learn independently, which is fine —
// this state is a latency optimisation, never a source of truth.

const FAILURES_BEFORE_TRIP = 3;
const COOLDOWN_MS = 60_000;

const breaker = new Map<number, { failures: number; openUntil: number }>();

export function reportSuccess(id: number): void {
  breaker.delete(id);
}

export function reportFailure(id: number, error: string): void {
  const s = breaker.get(id) ?? { failures: 0, openUntil: 0 };
  s.failures += 1;
  if (s.failures >= FAILURES_BEFORE_TRIP) {
    s.openUntil = Date.now() + COOLDOWN_MS;
    logWarning("llm_profile_cooling_down", { profile_id: id, cooldown_ms: COOLDOWN_MS, error });
  }
  breaker.set(id, s);
}

export function isCoolingDown(id: number): boolean {
  const s = breaker.get(id);
  return s !== undefined && s.openUntil > Date.now();
}

/** Remaining cool-down per leaf id (ms), for the admin UI. */
export function coolingDown(): Record<number, number> {
  const out: Record<number, number> = {};
  const now = Date.now();
  for (const [id, s] of breaker) if (s.openUntil > now) out[id] = s.openUntil - now;
  return out;
}

/** Forget every breaker decision (config changed, or tests). */
export function resetBreakers(): void {
  breaker.clear();
}
