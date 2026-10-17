/**
 * Provider registry contracts.
 *
 * Every provider account (`admin.llm_providers` row) names a provider id. The
 * provider's adapter owns everything that differs between vendors: URL shape,
 * auth header, request/response format, which knobs exist and what values they
 * take, how thinking is switched, and how models are listed. Callers
 * (analysisLlmClient, embeddingService, the admin test/model-list endpoints)
 * only speak these interfaces.
 *
 * The `ProviderSpec` half is served to the admin UI as-is (GET
 * /admin/api/llm-providers), so labels/help are written for the operator
 * (Traditional Chinese) and the form is rendered from it — adding a knob here is
 * the only change needed to expose it.
 */

import type { LlmProfile } from "../admin/llmProfiles.js";

export type Role = "analysis" | "embedding";

export type ProviderCategory = "cloud" | "asia" | "selfhost" | "subscription";

export interface ParamOption {
  value: string;
  label: string;
}

/** One provider-specific knob, stored flat in a route member's `params[key]`. */
export interface ParamSpec {
  key: string;
  type: "number" | "integer" | "select" | "boolean" | "text";
  label: string;
  help?: string;
  roles: Role[];
  /** Form section. */
  group: "generation" | "reasoning" | "embedding" | "advanced";
  min?: number;
  max?: number;
  step?: number;
  options?: ParamOption[];
  placeholder?: string;
  /** Only shown/sent when the model id matches (case-insensitive regex source). */
  modelPattern?: string;
}

export interface BaseUrlSpec {
  /** Pre-filled value for a new profile. */
  default?: string;
  /** The URL cannot be changed (e.g. official OpenAI). */
  fixed?: boolean;
  /** Region / account-type presets the operator picks from. */
  options?: ParamOption[];
  placeholder?: string;
  help?: string;
}

export interface ProviderSpec {
  id: string;
  label: string;
  category: ProviderCategory;
  description: string;
  roles: Role[];
  baseUrl: BaseUrlSpec;
  /** API key required to call the provider. */
  keyRequired: boolean;
  keyHelp?: string;
  /** Label for the model field (e.g. Azure calls it a deployment). */
  modelLabel?: string;
  modelHelp?: string;
  /** Example model ids per role, shown as placeholder / suggestions. */
  modelExamples?: Partial<Record<Role, string[]>>;
  /** listModels is implemented. */
  canListModels: boolean;
  docsUrl: string;
  params: ParamSpec[];
  /** Known limits the UI can warn about. */
  embeddingBatchLimit?: number;
  /** The param setting that turns thinking off, for the test panel's one-click fix. */
  thinkingOff?: { key: string; value: string };
  /** Signed in with an account instead of an API key (the UI runs that flow). */
  auth?: "oauth_chatgpt";
  /** Shown before the operator can connect (consumer terms, preview limits…). */
  warnings?: string[];
}

export type Message = { role: string; content: string };

export interface ChatRequest {
  messages: Message[];
  /** Output budget for this call (the client escalates it on truncation). */
  maxTokens: number;
  /** Ask for a JSON object reply when the provider can enforce it. */
  json: boolean;
}

export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
  /** Reasoning/thinking tokens when the provider reports them. */
  reasoningTokens: number | null;
}

export interface ChatResult {
  content: string;
  /** Provider's own finish/stop reason, verbatim. */
  finishReason: string;
  /** The reply was cut by the output budget (or is empty because thinking used it all). */
  truncated: boolean;
  usage: ChatUsage;
  /** Length of reasoning text returned alongside the answer (0 when none / hidden). */
  reasoningChars: number;
  /** Optional knobs the endpoint rejected and that were dropped to make the call succeed. */
  droppedParams: string[];
  /** Provider-specific timing/diagnostics for the admin test (e.g. Ollama durations). */
  diagnostics?: Record<string, unknown>;
}

export interface EmbedRequest {
  texts: string[];
  /** Search query vs indexed document — providers with asymmetric embeddings use it. */
  inputType: "query" | "document";
  /** Target vector size (route member params.dimensions). */
  dimensions: number;
}

/** Network context injected by the caller: timeouts, transport retries, test fakes. */
export interface CallContext {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
}

export interface ProviderAdapter {
  spec: ProviderSpec;
  /**
   * The provider cannot be given an output budget (ChatRequest.maxTokens is not
   * sent), so the client must not escalate the budget on truncation — every
   * retry would be the same request.
   */
  ignoresMaxTokens?: boolean;
  chat?(profile: LlmProfile, req: ChatRequest, ctx: CallContext): Promise<ChatResult>;
  embed?(profile: LlmProfile, req: EmbedRequest, ctx: CallContext): Promise<(number[] | null)[]>;
  listModels?(profile: LlmProfile, role: Role, ctx: CallContext): Promise<string[]>;
  /** Extra facts for the admin test (e.g. Ollama GPU residency). Best effort. */
  inspect?(profile: LlmProfile, ctx: CallContext): Promise<Record<string, unknown> | null>;
}

/** Non-2xx reply from a provider. `body` is the raw text for diagnostics. */
export class ProviderHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly url: string,
  ) {
    super(`HTTP ${status} from ${url}: ${snippet(body)}`);
    this.name = "ProviderHttpError";
  }
}

/**
 * Provider answered 200 but reported an error in the body (OpenRouter does
 * this for upstream failures). Treated like an endpoint failure.
 */
export class ProviderReplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderReplyError";
  }
}

/** One line, bounded — proxies answer failures with whole HTML pages. */
export function snippet(body: string, max = 300): string {
  const oneLine = body.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}… (${oneLine.length} chars total)` : oneLine;
}
