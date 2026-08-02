/**
 * Shared "Analysis LM" chat-completion client: failover across `admin.llm_profiles`
 * (`kind='analysis'`), per-profile output-budget escalation, and the OpenAI/vLLM
 * parameter-adaptation retries. Extracted from `drugAnalysisService.ts` so other
 * document-analysis pipelines can reuse the exact same
 * profile-selection/circuit-breaker/budget machinery instead of forking it — the
 * logic is document-format-agnostic, only the prompt/template differ per caller.
 */

import { reportFailure, reportSuccess, type LlmProfile } from "./admin/llmProfiles.js";
import { recordProfileStats, type LlmCallUsage } from "./admin/llmProfileStats.js";
import { logWarning } from "./logger.js";

export type Message = { role: string; content: string };

const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_REASONING_MAX_TOKENS = 16384;
const DEFAULT_TIMEOUT_MS = 600_000;
const REASONING_MODEL_PREFIXES = ["gpt-5", "o1", "o3", "o4"];

/** How many times a single endpoint call retries on a transport failure
 * (timeout / network error) before the profile counts as failed. */
const TRANSPORT_RETRIES = 3;
/** Backoff (ms) between transport retries. */
const TRANSPORT_BACKOFF_MS = [2_000, 4_000, 8_000];

function profileTimeoutMs(profile: LlmProfile): number {
  const value = Math.trunc(Number(profile.params?.timeout_ms ?? DEFAULT_TIMEOUT_MS));
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS;
}

/** Ceiling for the automatic budget escalation (see `callProfileWithBudget`). */
export const MAX_TOKEN_BUDGET = 65536;

/**
 * Ceiling for non-reasoning models. The doubling exists to buy a reasoning model
 * room for hidden reasoning; a non-reasoning model doing structured extraction
 * that cannot finish within one escalation is almost always looping (a small
 * quantized model repeating itself, finish_reason=length forever). Doubling on
 * to 64k would make each regeneration 10min+ and block the pipeline — fail fast
 * instead.
 */
const NON_REASONING_MAX_TOKEN_BUDGET = 8192;

/** True for model families that bill hidden reasoning against the output budget. */
export function isReasoningModel(model: string): boolean {
  const name = (model || "").trim().toLowerCase();
  return REASONING_MODEL_PREFIXES.some((prefix) => name.startsWith(prefix));
}

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

function profileTemperature(profile: LlmProfile, fallback = 0.1): number {
  const value = Number(profile.params?.temperature ?? fallback);
  return Number.isFinite(value) ? value : fallback;
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

function normalizeOpenAiBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
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
  const ceiling = Math.max(budget, profileBudgetCeiling(profile));
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

/**
 * Endpoints behind a proxy/CDN answer failures with a full HTML error page
 * (e.g. a Cloudflare 5xx). Embedding that whole body in the error — which then
 * becomes a job's `last_error_message` and floods the task log with markup — is
 * useless. Keep a short single-line snippet: enough to identify the failure.
 */
function httpErrorSnippet(body: string, max = 300): string {
  const oneLine = body.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}… (${oneLine.length} chars total)` : oneLine;
}

/** Retry a single endpoint call on transient transport failures (timeout,
 * network error). A fresh `AbortSignal.timeout` is created per attempt, so a
 * timed-out signal never leaks into the next try. */
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
  const startedAt = Date.now();
  if (profile.provider === "openai" || profile.provider === "vllm") {
    const url = `${normalizeOpenAiBaseUrl(profile.base_url)}/chat/completions`;
    const payload: Record<string, unknown> = {
      model: profile.model,
      messages,
      temperature: profileTemperature(profile),
      response_format: { type: "json_object" },
    };
    const tokenParam =
      profile.provider === "openai" && isReasoningModel(profile.model)
        ? "max_completion_tokens"
        : "max_tokens";
    payload[tokenParam] = maxTokens;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (profile.api_key) headers.Authorization = `Bearer ${profile.api_key}`;

    let data: Record<string, unknown> | null = null;
    let lastMessage = "";
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await fetchWithTransportRetry(
        url,
        {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
        },
        profileTimeoutMs(profile),
      );
      if (response.ok) {
        data = (await response.json()) as Record<string, unknown>;
        break;
      }
      const body = await response.text().catch(() => "");
      const low = body.toLowerCase();
      lastMessage = `HTTP ${response.status} from ${url}: ${httpErrorSnippet(body)}`;
      let adapted = false;
      if (low.includes("max_completion_tokens") && "max_tokens" in payload) {
        payload.max_completion_tokens = payload.max_tokens;
        delete payload.max_tokens;
        adapted = true;
      } else if (
        low.includes("max_tokens") &&
        "max_completion_tokens" in payload &&
        (low.includes("unsupported") || low.includes("not supported"))
      ) {
        payload.max_tokens = payload.max_completion_tokens;
        delete payload.max_completion_tokens;
        adapted = true;
      }
      if (
        !adapted &&
        "temperature" in payload &&
        low.includes("temperature") &&
        (low.includes("unsupported") || low.includes("does not support"))
      ) {
        delete payload.temperature;
        adapted = true;
      }
      if (
        !adapted &&
        "response_format" in payload &&
        low.includes("response_format") &&
        (low.includes("unsupported") || low.includes("not supported"))
      ) {
        delete payload.response_format;
        adapted = true;
      }
      if (!adapted) throw new Error(lastMessage);
    }
    if (data === null) {
      throw new Error(lastMessage || "Analysis LLM call failed after parameter-adaptation retries");
    }

    const choices = (data.choices ?? []) as Record<string, unknown>[];
    const choice = choices[0] ?? {};
    const message = (choice.message ?? {}) as Record<string, unknown>;
    const content = String(message.content ?? "");
    const finishReason = String(choice.finish_reason ?? "");
    const usage = (data.usage ?? {}) as Record<string, unknown>;
    const details = (usage.completion_tokens_details ?? {}) as Record<string, unknown>;
    const reasoningTokens =
      details.reasoning_tokens === undefined ? null : Number(details.reasoning_tokens);
    const callUsage: LlmCallUsage = {
      promptTokens: positiveNum(usage.prompt_tokens),
      completionTokens: positiveNum(usage.completion_tokens),
      latencyMs: Date.now() - startedAt,
    };

    if (finishReason === "length" || !content.trim()) {
      throw new TokenBudgetExceeded(
        `${profile.model} ran out of output budget at ${maxTokens} tokens` +
          (reasoningTokens ? ` (${reasoningTokens} of them spent on reasoning)` : "") +
          `; finish_reason=${finishReason || "none"}`,
        maxTokens,
        finishReason,
        reasoningTokens,
        callUsage,
      );
    }
    return { content, usage: callUsage };
  }

  if (profile.provider === "ollama") {
    const url = `${profile.base_url.replace(/\/+$/, "")}/api/chat`;
    const response = await fetchWithTransportRetry(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: profile.model,
          messages,
          stream: false,
          format: "json",
          options: { temperature: profileTemperature(profile), num_predict: maxTokens },
        }),
      },
      profileTimeoutMs(profile),
    );
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status} from ${url}: ${httpErrorSnippet(body)}`);
    }
    const data = (await response.json()) as Record<string, unknown>;
    const message = (data.message ?? {}) as Record<string, unknown>;
    const content = String(message.content ?? "");
    const doneReason = String(data.done_reason ?? "");
    const callUsage: LlmCallUsage = {
      promptTokens: positiveNum(data.prompt_eval_count),
      completionTokens: positiveNum(data.eval_count),
      latencyMs: Date.now() - startedAt,
    };
    if (doneReason === "length" || !content.trim()) {
      throw new TokenBudgetExceeded(
        `${profile.model} ran out of output budget at ${maxTokens} tokens; ` +
          `done_reason=${doneReason || "none"}`,
        maxTokens,
        doneReason,
        null,
        callUsage,
      );
    }
    return { content, usage: callUsage };
  }

  throw new Error(`Unsupported analysis provider: ${profile.provider}`);
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
): Promise<AnalysisLlmCallResult> {
  if (profiles.length === 0) {
    throw new AnalysisLlmUnavailable(
      "Analysis LM is not configured yet — set it up in the admin console.",
    );
  }

  const failures: string[] = [];
  // A budget failure means the endpoint is healthy (see below), so it must not
  // make the whole call read as "LM unavailable". Only a real transport/HTTP
  // failure does — track whether at least one profile failed for that reason.
  let anyEndpointFailure = false;
  for (const profile of profiles) {
    try {
      const { content, usage } = await callProfileWithBudget(profile, messages);
      reportSuccess(profile.id);
      await recordProfileStats(profile.id, { ok: true, budgetFailure: false, usage });
      await onCall?.({ messages, profileUsed: profile, content, usage, status: "ok", error: "" });
      return { content, profileUsed: profile };
    } catch (err) {
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
  const message = `Every Analysis LM profile failed: ${failures.join("; ")}`;
  // At least one endpoint failed for a non-budget reason → the fleet is (partly
  // or wholly) down. Signal that distinctly so a batch caller can pause instead
  // of failing every remaining item against the same dead endpoints.
  if (anyEndpointFailure) throw new AnalysisLlmUnavailable(message);
  throw new Error(message);
}
