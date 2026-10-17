/**
 * Shared "Analysis LM" chat-completion client: failover across the analysis role's profile (llmRouting.ts)
 * (`kind='analysis'`), per-profile output-budget escalation, and the OpenAI/vLLM
 * parameter-adaptation retries. Extracted from `drugAnalysisService.ts` so other
 * document-analysis pipelines can reuse the exact same
 * profile-selection/circuit-breaker/budget machinery instead of forking it — the
 * logic is document-format-agnostic, only the prompt/template differ per caller.
 */

import { reportFailure, reportSuccess, type LlmProfile } from "./admin/llmProfiles.js";
import { recordProfileStats, type LlmCallUsage } from "./admin/llmProfileStats.js";
import { logWarning } from "./logger.js";
import { canRequest, ProfileRateLimited, recordRequest, waitUntilMs } from "./rateLimiter.js";
import { getAdapter } from "./providers/registry.js";
import type { Message } from "./providers/types.js";

export type { Message };

const REASONING_MODEL_PREFIXES = ["gpt-5", "gpt-6", "o1", "o3", "o4"];

/** True for model families that bill hidden reasoning against the output budget. */
export function isReasoningModel(model: string): boolean {
  const name = (model || "").trim().toLowerCase();
  return REASONING_MODEL_PREFIXES.some((prefix) => name.startsWith(prefix));
}

// Starting output budget. Both families now start here: a locally hosted thinking
// model is indistinguishable from a plain one by name (see REASONING_MODEL_PREFIXES),
// so the safe assumption is that any model may spend budget on hidden reasoning
// first. The escalation ceilings still differ.
const DEFAULT_MAX_TOKENS = 16384;
const DEFAULT_REASONING_MAX_TOKENS = 16384;
const DEFAULT_TIMEOUT_MS = 600_000;

/** How many times a single endpoint call retries on a connection-level failure
 * (reset / refused / DNS) before the profile counts as failed. A *timeout* is
 * never retried: an endpoint that let a request run for the whole timeout is
 * not going to answer the same request faster, so the next profile is tried
 * immediately instead of burning several more timeouts on it. */
const TRANSPORT_RETRIES = 2;
/** Backoff (ms) between transport retries — short: these are blips, not outages. */
const TRANSPORT_BACKOFF_MS = [1_000, 2_000];

/** Default cap on how long one call waits for a profile's own RPM/TPM window. */
export const DEFAULT_RATE_LIMIT_WAIT_MS = 15_000;

function profileTimeoutMs(profile: LlmProfile): number {
  const value = Math.trunc(Number(profile.params?.timeout_ms ?? DEFAULT_TIMEOUT_MS));
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS;
}

/** Ceiling for the automatic budget escalation (see `callProfileWithBudget`). */
export const MAX_TOKEN_BUDGET = 65536;

/**
 * Ceiling for models this client does not recognise as reasoning models.
 *
 * The doubling exists to buy a reasoning model room for hidden reasoning, and a
 * model that truly cannot finish structured extraction within one escalation is
 * usually looping (a small quantized model repeating itself, finish_reason=length
 * forever) — doubling on to 64k would make each regeneration 10min+ and block the
 * pipeline. But `isReasoningModel()` only matches a few OpenAI prefixes, so any
 * locally hosted thinking model (Qwen, DeepSeek-R1, ThinkingCap, …) lands here
 * and spends this budget on reasoning before writing a single character of JSON.
 * The old 8192 was not enough for a drug insert under those models; this keeps a
 * bound on the runaway case while leaving real extraction room.
 */
const NON_REASONING_MAX_TOKEN_BUDGET = 32768;


/**
 * The model ran out of output budget before finishing the JSON.
 *
 * Deliberately distinct from a broken endpoint: the server answered correctly, we
 * simply did not give it room to reply. It must not count against the profile's
 * health (no cool-down) — the caller retries the *same* profile with more budget.
 */
export class TokenBudgetExceeded extends Error {
  constructor(
    message: string,
    readonly budget: number,
    readonly finishReason = "",
    readonly reasoningTokens: number | null = null,
    readonly usage: LlmCallUsage = { promptTokens: 0, completionTokens: 0, latencyMs: 0 },
  ) {
    super(message);
    this.name = "TokenBudgetExceeded";
  }
}

/**
 * Every configured Analysis LM endpoint is currently unusable — a transport
 * error, timeout, or HTTP failure from all of them, or none configured at all.
 * Distinct from a per-document failure (malformed output, oversized input): the
 * fleet is down, so a caller processing a batch should stop and wait for the LM
 * to come back rather than burn through every remaining item failing identically.
 */
export class AnalysisLlmUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnalysisLlmUnavailable";
  }
}

/**
 * Every profile that could have answered is only held back by its own local
 * RPM/TPM limit, and the window does not reopen within the caller's wait cap.
 * The endpoints are healthy — this is "retry later", never "the fleet is down",
 * and it never feeds the circuit breaker.
 */
export class AnalysisLlmRateLimited extends Error {
  constructor(
    message: string,
    readonly retryAfterMs: number,
  ) {
    super(message);
    this.name = "AnalysisLlmRateLimited";
  }
}

/** Usage counts can be absent or 0 on some providers — never negative/NaN. */
function positiveNum(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function profileMaxTokens(profile: LlmProfile): number {
  const fallback = isReasoningModel(profile.model)
    ? DEFAULT_REASONING_MAX_TOKENS
    : DEFAULT_MAX_TOKENS;
  const value = Math.trunc(Number(profile.params?.max_tokens ?? fallback));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Call one profile, buying more output budget whenever it runs out. A reasoning
 * model spends its budget on hidden reasoning first, so the room a document needs
 * depends on how hard the model finds it — start from the configured budget and
 * double it until the model finishes, up to `MAX_TOKEN_BUDGET`.
 */
/**
 * Ceiling for the automatic budget escalation. Defaults to the model-family
 * ceiling (64k reasoning / 8k non-reasoning), but an operator can raise it per
 * profile via `params.max_token_budget`: a long drug insert can legitimately
 * need more than 8k output tokens, and the 8k default exists to stop a looping
 * *non-reasoning* model from doubling to 64k — not to starve a real extraction.
 */
function profileBudgetCeiling(profile: LlmProfile): number {
  const override = Math.trunc(Number(profile.params?.max_token_budget ?? 0));
  const fallback = isReasoningModel(profile.model)
    ? MAX_TOKEN_BUDGET
    : NON_REASONING_MAX_TOKEN_BUDGET;
  return Number.isFinite(override) && override > 0 ? override : fallback;
}

async function callProfileWithBudget(
  profile: LlmProfile,
  messages: Message[],
): Promise<{ content: string; usage: LlmCallUsage }> {
  let budget = profileMaxTokens(profile);
  // A provider that cannot be given an output budget would only repeat the
  // identical request: no escalation there.
  const fixedBudget = getAdapter(profile.provider, profile.base_url)?.ignoresMaxTokens === true;
  const ceiling = fixedBudget ? budget : Math.max(budget, profileBudgetCeiling(profile));
  for (;;) {
    try {
      return await callOneProfile(profile, messages, budget);
    } catch (err) {
      if (!(err instanceof TokenBudgetExceeded) || budget >= ceiling) throw err;
      const previous = budget;
      budget = Math.min(budget * 2, ceiling);
      logWarning("analysis_budget_escalated", {
        profile: profile.name,
        model: profile.model,
        previous_budget: previous,
        new_budget: budget,
        finish_reason: err.finishReason,
        reasoning_tokens: err.reasoningTokens,
      });
    }
  }
}

function isTimeout(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  return name === "TimeoutError" || name === "AbortError";
}

/** Retry a single endpoint call on connection-level failures (reset, refused).
 * A timeout fails at once (see TRANSPORT_RETRIES). A fresh
 * `AbortSignal.timeout` is created per attempt, so a timed-out signal never
 * leaks into the next try. */
async function fetchWithTransportRetry(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= TRANSPORT_RETRIES; attempt += 1) {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      if (isTimeout(err)) {
        throw new Error(`No reply within ${Math.round(timeoutMs / 1000)}s (timeout) from ${url}`);
      }
      lastError = err;
      if (attempt === TRANSPORT_RETRIES) break;
      const backoff = TRANSPORT_BACKOFF_MS[attempt] ?? TRANSPORT_BACKOFF_MS[TRANSPORT_BACKOFF_MS.length - 1];
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
  }
  throw lastError;
}

async function callOneProfile(
  profile: LlmProfile,
  messages: Message[],
  maxTokens: number,
): Promise<{ content: string; usage: LlmCallUsage }> {
  // Check rate limits before proceeding
  const limits = {
    rpm: Number(profile.params?.rpm) || undefined,
    tpm: Number(profile.params?.tpm) || undefined,
  };
  const { allowed, reason } = canRequest(profile.id, limits);
  if (!allowed) {
    const waitMs = waitUntilMs(profile.id, limits);
    throw new ProfileRateLimited(`Rate limit: ${reason}. Wait ${Math.ceil(waitMs / 1000)}s.`, waitMs);
  }

  const adapter = getAdapter(profile.provider, profile.base_url);
  if (!adapter?.chat) throw new Error(`Unsupported analysis provider: ${profile.provider}`);
  const timeoutMs = profileTimeoutMs(profile);
  const startedAt = Date.now();
  const result = await adapter.chat(
    profile,
    { messages, maxTokens, json: true },
    { fetch: (url, init) => fetchWithTransportRetry(url, init, timeoutMs) },
  );
  const callUsage: LlmCallUsage = {
    promptTokens: result.usage.promptTokens,
    completionTokens: result.usage.completionTokens,
    latencyMs: Date.now() - startedAt,
  };
  // Every answered call is billed — a truncated one included — so it counts
  // toward the profile's RPM/TPM window either way.
  recordRequest(profile.id, callUsage.promptTokens + callUsage.completionTokens);
  if (result.droppedParams.length) {
    logWarning("analysis_params_dropped", { profile: profile.name, model: profile.model, dropped: result.droppedParams });
  }
  if (result.truncated) {
    throw new TokenBudgetExceeded(
      `${profile.model} ran out of output budget at ${maxTokens} tokens` +
        (result.usage.reasoningTokens ? ` (${result.usage.reasoningTokens} of them spent on reasoning)` : "") +
        `; finish_reason=${result.finishReason || "none"}`,
      maxTokens,
      result.finishReason,
      result.usage.reasoningTokens,
      callUsage,
    );
  }

  return { content: result.content, usage: callUsage };
}

export interface AnalysisLlmCallResult {
  content: string;
  profileUsed: LlmProfile;
}

/**
 * One attempt against one profile, reported to an optional observer so a caller
 * can audit prompt → reply (e.g. persist the system prompt and the raw output).
 * The final profile's call is reported with `status='ok'`; earlier profiles
 * that failed (budget or endpoint) are each reported too.
 */
export interface LlmCallAttempt {
  messages: Message[];
  profileUsed: LlmProfile;
  content: string;
  usage: LlmCallUsage | null;
  status: "ok" | "budget" | "failed";
  error: string;
}

/**
 * Call the Analysis LM, moving to the next profile when one fails.
 *
 * A transport error, timeout or HTTP failure means *this endpoint* is unusable
 * right now, so it is recorded against the profile (feeding the cool-down) and the
 * next one is tried. Only when every profile fails does the call fail, and the
 * error then names each one, so an operator can tell one bad key from a dead fleet.
 */
export async function callAnalysisLlm(
  profiles: LlmProfile[],
  messages: Message[],
  onCall?: (attempt: LlmCallAttempt) => void | Promise<void>,
  opts: { maxRateLimitWaitMs?: number } = {},
): Promise<AnalysisLlmCallResult> {
  if (profiles.length === 0) {
    throw new AnalysisLlmUnavailable(
      "Analysis LM is not configured yet — set it up in the admin console.",
    );
  }
  const maxWaitMs = Math.max(0, opts.maxRateLimitWaitMs ?? DEFAULT_RATE_LIMIT_WAIT_MS);

  const failures: string[] = [];
  // A budget failure means the endpoint is healthy (see below), so it must not
  // make the whole call read as "LM unavailable". Only a real transport/HTTP
  // failure does — track whether at least one profile failed for that reason.
  let anyEndpointFailure = false;
  let waited = 0;
  let pending = profiles;
  for (;;) {
    // Profiles skipped only because their own RPM/TPM window is full: healthy,
    // so never reported to the breaker; retried below after a bounded wait.
    const limited: { profile: LlmProfile; waitMs: number; message: string }[] = [];
    for (const profile of pending) {
      try {
        const { content, usage } = await callProfileWithBudget(profile, messages);
        reportSuccess(profile.id);
        await recordProfileStats(profile.id, { ok: true, budgetFailure: false, usage });
        await onCall?.({ messages, profileUsed: profile, content, usage, status: "ok", error: "" });
        return { content, profileUsed: profile };
      } catch (err) {
        if (err instanceof ProfileRateLimited) {
          limited.push({ profile, waitMs: err.waitMs, message: err.message });
          continue;
        }
        if (err instanceof TokenBudgetExceeded) {
          // The endpoint is healthy — we just could not buy enough room, even at the
          // ceiling. Do NOT feed the circuit breaker: cooling down a working endpoint
          // over our own budget would take it out of rotation for every other caller.
          failures.push(`${profile.name}: ${err.message}`);
          await recordProfileStats(profile.id, { ok: false, budgetFailure: true, usage: err.usage });
          await onCall?.({
            messages,
            profileUsed: profile,
            content: "",
            usage: err.usage,
            status: "budget",
            error: err.message,
          });
          logWarning("analysis_profile_out_of_budget", {
            profile: profile.name,
            model: profile.model,
            budget: err.budget,
            finish_reason: err.finishReason,
            reasoning_tokens: err.reasoningTokens,
          });
          continue;
        }
        const message = String(err instanceof Error ? err.message : err);
        anyEndpointFailure = true;
        failures.push(`${profile.name}: ${message}`);
        reportFailure(profile.id, message);
        await recordProfileStats(profile.id, { ok: false, budgetFailure: false, usage: null });
        await onCall?.({
          messages,
          profileUsed: profile,
          content: "",
          usage: null,
          status: "failed",
          error: message,
        });
        logWarning("analysis_profile_failed", {
          profile: profile.name,
          provider: profile.provider,
          model: profile.model,
          error: message,
        });
      }
    }
    if (limited.length === 0) break;
    const soonest = Math.max(1, Math.min(...limited.map((l) => l.waitMs)));
    if (waited + soonest > maxWaitMs) {
      throw new AnalysisLlmRateLimited(
        `Every usable Analysis LM profile is at its own rate limit: ${[
          ...failures,
          ...limited.map((l) => `${l.profile.name}: ${l.message}`),
        ].join("; ")}`,
        soonest,
      );
    }
    logWarning("analysis_rate_limit_wait", { wait_ms: soonest, profiles: limited.map((l) => l.profile.name) });
    await new Promise((resolve) => setTimeout(resolve, soonest));
    waited += soonest;
    pending = limited.map((l) => l.profile);
  }
  const message = `Every Analysis LM profile failed: ${failures.join("; ")}`;
  // At least one endpoint failed for a non-budget reason → the fleet is (partly
  // or wholly) down. Signal that distinctly so a batch caller can pause instead
  // of failing every remaining item against the same dead endpoints.
  if (anyEndpointFailure) throw new AnalysisLlmUnavailable(message);
  throw new Error(message);
}
