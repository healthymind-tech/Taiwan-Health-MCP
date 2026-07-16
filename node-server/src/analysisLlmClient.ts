/**
 * Shared "Analysis LM" chat-completion client: failover across `admin.llm_profiles`
 * (`kind='analysis'`), per-profile output-budget escalation, and the OpenAI/vLLM
 * parameter-adaptation retries. Extracted from `drugAnalysisService.ts` so the
 * Clinical Guideline analysis pipeline (`guidelineAnalysisService.ts`) can reuse the
 * exact same profile-selection/circuit-breaker/budget machinery instead of forking
 * it — the logic is document-format-agnostic, only the prompt/template differ per
 * caller.
 */

import { reportFailure, reportSuccess, type LlmProfile } from "./admin/llmProfiles.js";
import { logWarning } from "./logger.js";

export type Message = { role: string; content: string };

const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_REASONING_MAX_TOKENS = 16384;
const REASONING_MODEL_PREFIXES = ["gpt-5", "o1", "o3", "o4"];

/** Ceiling for the automatic budget escalation (see `callProfileWithBudget`). */
export const MAX_TOKEN_BUDGET = 65536;

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
  ) {
    super(message);
    this.name = "TokenBudgetExceeded";
  }
}

function profileTemperature(profile: LlmProfile, fallback = 0.1): number {
  const value = Number(profile.params?.temperature ?? fallback);
  return Number.isFinite(value) ? value : fallback;
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
async function callProfileWithBudget(profile: LlmProfile, messages: Message[]): Promise<string> {
  let budget = profileMaxTokens(profile);
  for (;;) {
    try {
      return await callOneProfile(profile, messages, budget);
    } catch (err) {
      if (!(err instanceof TokenBudgetExceeded) || budget >= MAX_TOKEN_BUDGET) throw err;
      const previous = budget;
      budget = Math.min(budget * 2, MAX_TOKEN_BUDGET);
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

async function callOneProfile(
  profile: LlmProfile,
  messages: Message[],
  maxTokens: number,
): Promise<string> {
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
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(300_000),
      });
      if (response.ok) {
        data = (await response.json()) as Record<string, unknown>;
        break;
      }
      const body = await response.text().catch(() => "");
      const low = body.toLowerCase();
      lastMessage = `HTTP ${response.status} from ${url}: ${body}`;
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

    if (finishReason === "length" || !content.trim()) {
      throw new TokenBudgetExceeded(
        `${profile.model} ran out of output budget at ${maxTokens} tokens` +
          (reasoningTokens ? ` (${reasoningTokens} of them spent on reasoning)` : "") +
          `; finish_reason=${finishReason || "none"}`,
        maxTokens,
        finishReason,
        reasoningTokens,
      );
    }
    return content;
  }

  if (profile.provider === "ollama") {
    const url = `${profile.base_url.replace(/\/+$/, "")}/api/chat`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: profile.model,
        messages,
        stream: false,
        format: "json",
        options: { temperature: profileTemperature(profile), num_predict: maxTokens },
      }),
      signal: AbortSignal.timeout(300_000),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status} from ${url}: ${body}`);
    }
    const data = (await response.json()) as Record<string, unknown>;
    const message = (data.message ?? {}) as Record<string, unknown>;
    const content = String(message.content ?? "");
    const doneReason = String(data.done_reason ?? "");
    if (doneReason === "length" || !content.trim()) {
      throw new TokenBudgetExceeded(
        `${profile.model} ran out of output budget at ${maxTokens} tokens; ` +
          `done_reason=${doneReason || "none"}`,
        maxTokens,
        doneReason,
      );
    }
    return content;
  }

  throw new Error(`Unsupported analysis provider: ${profile.provider}`);
}

export interface AnalysisLlmCallResult {
  content: string;
  profileUsed: LlmProfile;
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
): Promise<AnalysisLlmCallResult> {
  if (profiles.length === 0) {
    throw new Error("Analysis LM is not configured yet — set it up in the admin console.");
  }

  const failures: string[] = [];
  for (const profile of profiles) {
    try {
      const content = await callProfileWithBudget(profile, messages);
      reportSuccess(profile.id);
      return { content, profileUsed: profile };
    } catch (err) {
      if (err instanceof TokenBudgetExceeded) {
        // The endpoint is healthy — we just could not buy enough room, even at the
        // ceiling. Do NOT feed the circuit breaker: cooling down a working endpoint
        // over our own budget would take it out of rotation for every other caller.
        failures.push(`${profile.name}: ${err.message}`);
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
      failures.push(`${profile.name}: ${message}`);
      reportFailure(profile.id, message);
      logWarning("analysis_profile_failed", {
        profile: profile.name,
        provider: profile.provider,
        model: profile.model,
        error: message,
      });
    }
  }
  throw new Error(`Every Analysis LM profile failed: ${failures.join("; ")}`);
}
