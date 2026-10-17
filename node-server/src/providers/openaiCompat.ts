/**
 * The OpenAI wire format (POST {root}/chat/completions, {root}/embeddings,
 * GET {root}/models), parameterised by each vendor's quirks. Most providers in
 * the registry speak it; their adapter files only describe what differs.
 */

import type { LlmProfile } from "../admin/llmProfiles.js";
import { detectTruncation, getJson, pNum, positive, postAdaptive, splitThink, stripJsonFence } from "./common.js";
import {
  ProviderReplyError,
  type CallContext,
  type ChatRequest,
  type ChatResult,
  type EmbedRequest,
  type Role,
} from "./types.js";

export interface OpenAiCompatOptions {
  /** API root, e.g. https://api.openai.com/v1 (no trailing slash). */
  root(profile: LlmProfile): string;
  headers(profile: LlmProfile): Record<string, string>;
  /** Output-budget field name. Default max_tokens. */
  tokenParam?: (profile: LlmProfile) => "max_tokens" | "max_completion_tokens";
  /** How to request JSON. Default json_object. */
  jsonMode?: (profile: LlmProfile) => "json_object" | "none";
  /** Provider rejects json_object unless a message mentions "json". */
  jsonNeedsKeyword?: boolean;
  /** Whether temperature / top_p from params are sent (some models fix them). */
  sendSampling?: (profile: LlmProfile) => boolean;
  /** Provider-specific body fields derived from params (thinking, effort, …). */
  extraBody?: (profile: LlmProfile, req: ChatRequest) => Record<string, unknown>;
  /** Top-level keys that may be dropped when the server rejects them. */
  droppable?: string[];
  /** Finish reasons that mean "cut by the output budget". */
  truncationReasons?: string[];
  embeddings?: {
    path?: string;
    /** Body fields for size / input type; omit a key to not send it. */
    body?: (profile: LlmProfile, req: EmbedRequest) => Record<string, unknown>;
    /** Max inputs per request; larger batches are split. */
    batchLimit?: number;
  };
  /** Filter / shape the /models listing per role. */
  filterModels?: (ids: string[], role: Role, raw: Record<string, unknown>[]) => string[];
  modelsPath?: string;
}

const DEFAULT_DROPPABLE = [
  "temperature",
  "top_p",
  "top_k",
  "min_p",
  "response_format",
  "reasoning_effort",
  "chat_template_kwargs",
  "enable_thinking",
  "thinking_budget",
  "thinking",
  "seed",
  "repetition_penalty",
  "verbosity",
];

/** max_tokens ↔ max_completion_tokens, as servers demand. */
function swapTokenParam(body: Record<string, unknown>, low: string): string | null {
  if (low.includes("max_completion_tokens") && "max_tokens" in body) {
    body.max_completion_tokens = body.max_tokens;
    delete body.max_tokens;
    return "max_tokens→max_completion_tokens";
  }
  if (
    low.includes("max_tokens") &&
    "max_completion_tokens" in body &&
    (low.includes("unsupported") || low.includes("not supported") || low.includes("unrecognized") || low.includes("unknown"))
  ) {
    body.max_tokens = body.max_completion_tokens;
    delete body.max_completion_tokens;
    return "max_completion_tokens→max_tokens";
  }
  return null;
}

/** Message content can be a string or a list of typed parts (Mistral reasoning, Cohere). */
function contentParts(raw: unknown): { text: string; thinking: string } {
  if (typeof raw === "string") return { text: raw, thinking: "" };
  if (!Array.isArray(raw)) return { text: "", thinking: "" };
  let text = "";
  let thinking = "";
  for (const part of raw as Record<string, unknown>[]) {
    const type = String(part?.type ?? "");
    if (type === "thinking" || type === "reasoning") {
      const t = part.thinking;
      thinking += Array.isArray(t) ? t.map((x: Record<string, unknown>) => String(x?.text ?? "")).join("") : String(t ?? part.text ?? "");
    } else if (type === "text" || type === "output_text") {
      text += String(part.text ?? "");
    }
  }
  return { text, thinking };
}

export function buildChatBody(profile: LlmProfile, req: ChatRequest, opts: OpenAiCompatOptions): Record<string, unknown> {
  let messages = req.messages;
  const jsonMode = req.json ? (opts.jsonMode?.(profile) ?? "json_object") : "none";
  if (jsonMode === "json_object" && opts.jsonNeedsKeyword && !messages.some((m) => /json/i.test(m.content))) {
    messages = [{ role: "system", content: "Respond with a JSON object." }, ...messages];
  }
  const body: Record<string, unknown> = { model: profile.model, messages };
  if (opts.sendSampling?.(profile) ?? true) {
    const t = pNum(profile.params, "temperature");
    if (t !== undefined) body.temperature = t;
    const p = pNum(profile.params, "top_p");
    if (p !== undefined) body.top_p = p;
  }
  body[opts.tokenParam?.(profile) ?? "max_tokens"] = req.maxTokens;
  if (jsonMode === "json_object") body.response_format = { type: "json_object" };
  Object.assign(body, opts.extraBody?.(profile, req) ?? {});
  return body;
}

export async function openAiCompatChat(
  profile: LlmProfile,
  req: ChatRequest,
  ctx: CallContext,
  opts: OpenAiCompatOptions,
): Promise<ChatResult> {
  const url = `${opts.root(profile)}/chat/completions`;
  const body = buildChatBody(profile, req, opts);
  const { json, dropped } = await postAdaptive(
    ctx,
    url,
    opts.headers(profile),
    body,
    opts.droppable ?? DEFAULT_DROPPABLE,
    swapTokenParam,
  );
  if (!Array.isArray(json.choices) && json.error) {
    const e = json.error as Record<string, unknown>;
    throw new ProviderReplyError(`Provider error: ${String(e.message ?? JSON.stringify(e)).slice(0, 300)}`);
  }
  const choice = ((json.choices as Record<string, unknown>[] | undefined) ?? [])[0] ?? {};
  // OpenRouter reports a mid-generation upstream failure on the choice itself.
  if (choice.error || choice.finish_reason === "error") {
    const e = (choice.error ?? {}) as Record<string, unknown>;
    throw new ProviderReplyError(`Provider error: ${String(e.message ?? (choice.error ? JSON.stringify(choice.error) : "finish_reason=error")).slice(0, 300)}`);
  }
  const message = (choice.message ?? {}) as Record<string, unknown>;
  const parts = contentParts(message.content);
  let content = parts.text;
  let reasoning = parts.thinking || String(message.reasoning_content ?? message.reasoning ?? "");
  if (!reasoning) {
    const split = splitThink(content);
    content = split.content;
    reasoning = split.reasoning;
  }
  if (req.json) content = stripJsonFence(content);
  const finishReason = String(choice.finish_reason ?? "");
  const usage = (json.usage ?? {}) as Record<string, unknown>;
  const details = (usage.completion_tokens_details ?? {}) as Record<string, unknown>;
  const truncReasons = opts.truncationReasons ?? ["length", "model_length", "max_tokens"];
  const reasoningTokens = details.reasoning_tokens === undefined ? null : positive(details.reasoning_tokens);
  return {
    content,
    finishReason,
    truncated: detectTruncation({
      provider: profile.provider,
      content,
      finishReason,
      cutReasons: truncReasons,
      reasoningChars: reasoning.length,
      reasoningTokens,
    }),
    usage: {
      promptTokens: positive(usage.prompt_tokens),
      completionTokens: positive(usage.completion_tokens),
      reasoningTokens,
    },
    reasoningChars: reasoning.length,
    droppedParams: dropped,
  };
}

export async function openAiCompatEmbed(
  profile: LlmProfile,
  req: EmbedRequest,
  ctx: CallContext,
  opts: OpenAiCompatOptions,
): Promise<(number[] | null)[]> {
  const path = opts.embeddings?.path ?? "/embeddings";
  const root = opts.root(profile);
  const url = root.endsWith("/embeddings") ? root : `${root}${path}`;
  const limit = Math.max(1, opts.embeddings?.batchLimit ?? req.texts.length);
  // Fixed-length result: each vector lands at its own text's position (the
  // reply's `index`, offset by the sub-batch start), so a dropped item stays
  // null instead of shifting every later vector onto the wrong text.
  const out: (number[] | null)[] = req.texts.map(() => null);
  for (let start = 0; start < req.texts.length; start += limit) {
    const texts = req.texts.slice(start, start + limit);
    const body: Record<string, unknown> = {
      model: profile.model,
      input: texts,
      encoding_format: "float",
      ...(opts.embeddings?.body?.(profile, { ...req, texts }) ?? {}),
    };
    const { json } = await postAdaptive(ctx, url, opts.headers(profile), body, ["encoding_format", "dimensions"]);
    const data = (json.data as { index?: number; embedding?: number[] }[] | undefined) ?? [];
    const indexed = data.every((d) => Number.isInteger(d?.index));
    data.forEach((d, pos) => {
      // Servers that omit `index` answer in input order.
      const i = indexed ? Number(d.index) : pos;
      if (i < 0 || i >= texts.length) return;
      out[start + i] = Array.isArray(d.embedding) ? d.embedding : null;
    });
  }
  return out;
}

export async function openAiCompatModels(
  profile: LlmProfile,
  role: Role,
  ctx: CallContext,
  opts: OpenAiCompatOptions,
): Promise<string[]> {
  const json = await getJson(ctx, `${opts.root(profile)}${opts.modelsPath ?? "/models"}`, opts.headers(profile));
  const raw = ((json.data ?? json.models ?? []) as Record<string, unknown>[]).filter((m) => m && typeof m === "object");
  const ids = raw.map((m) => String(m.id ?? m.name ?? "")).filter(Boolean);
  return (opts.filterModels ? opts.filterModels(ids, role, raw) : ids).sort();
}

/** Bearer auth headers, omitting the header when no key is configured. */
export function bearer(profile: LlmProfile): Record<string, string> {
  return profile.api_key ? { Authorization: `Bearer ${profile.api_key}` } : {};
}

/** Heuristic split of a mixed /models listing into embedding vs chat models. */
export function byEmbeddingName(ids: string[], role: Role): string[] {
  const isEmb = (id: string) => /embed|bge|e5-|gte-|nomic|mxbai|minilm|jina-emb|voyage/i.test(id);
  return ids.filter((id) => (role === "embedding" ? isEmb(id) : !isEmb(id)));
}
