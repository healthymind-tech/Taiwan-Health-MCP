/**
 * Major cloud vendors with their own (non-OpenAI) wire formats:
 *
 * - `anthropic`: Claude Messages API (POST /v1/messages). No embeddings.
 * - `gemini`: Gemini API generateContent / batchEmbedContents (also Vertex AI
 *   express mode, which takes the same body under a different path).
 * - `bedrock`: Amazon Bedrock Converse (chat) and InvokeModel (Titan / Cohere
 *   embeddings), authenticated with a Bedrock API key as a Bearer token.
 *
 * Docs: https://platform.claude.com/docs/en/api/overview ,
 * https://ai.google.dev/api/generate-content , https://ai.google.dev/api/embeddings ,
 * https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html
 */

import type { LlmProfile } from "../admin/llmProfiles.js";
import {
  detectTruncation,
  getJson,
  l2normalize,
  pNum,
  positive,
  postAdaptive,
  postJson,
  pStr,
  stripJsonFence,
  TEMPERATURE_PARAM,
  TOP_P_PARAM,
  trimSlash,
} from "./common.js";
import {
  ProviderReplyError,
  type CallContext,
  type ChatRequest,
  type ChatResult,
  type EmbedRequest,
  type Message,
  type ParamSpec,
  type ProviderAdapter,
  type Role,
} from "./types.js";

type Json = Record<string, unknown>;

// ── Shared local helpers ────────────────────────────────────────────────────

/** System messages joined into one string; the rest as user/assistant turns. */
function splitSystem(messages: Message[]): { system: string; turns: { role: "user" | "assistant"; content: string }[] } {
  const system = messages
    .filter((m) => m.role === "system" || m.role === "developer")
    .map((m) => m.content)
    .join("\n\n");
  const turns = messages
    .filter((m) => m.role !== "system" && m.role !== "developer")
    .map((m) => ({ role: m.role === "assistant" ? ("assistant" as const) : ("user" as const), content: m.content }));
  return { system, turns };
}

/**
 * Drop a knob nested inside an object of the request body (Gemini's
 * generationConfig, Bedrock's inferenceConfig) when the error text names it.
 * `rules` are checked in order; the first one whose pattern matches and whose
 * key is present wins. Returns the dropped label, or null.
 */
interface NestedDropRule {
  pattern: RegExp;
  /** Path of object keys leading to the parent, then the key to delete. */
  path: string[];
  label: string;
}

function dropNested(body: Json, errorText: string, rules: NestedDropRule[]): string | null {
  for (const rule of rules) {
    if (!rule.pattern.test(errorText)) continue;
    const parents: Json[] = [body];
    let node: unknown = body;
    for (const key of rule.path.slice(0, -1)) {
      node = (node as Json | undefined)?.[key];
      if (!node || typeof node !== "object") break;
      parents.push(node as Json);
    }
    if (parents.length !== rule.path.length) continue;
    const leaf = rule.path[rule.path.length - 1];
    const parent = parents[parents.length - 1];
    if (!(leaf in parent)) continue;
    delete parent[leaf];
    // Remove containers left empty so the server does not see `{}`.
    for (let i = parents.length - 1; i > 0; i -= 1) {
      if (Object.keys(parents[i]).length === 0) delete parents[i - 1][rule.path[i - 1]];
    }
    return rule.label;
  }
  return null;
}

const SAMPLING_NOTE_CLAUDE =
  "Claude 4.7 之後與所有 Claude 5.x 模型不接受此參數（會回 400）；只有設定時才送出，被拒絕時系統會自動略過並重試。";

const TOP_K_BASE = {
  key: "top_k",
  type: "integer" as const,
  label: "Top-k",
  roles: ["analysis" as const],
  group: "generation" as const,
  min: 1,
  max: 500,
  placeholder: "模型預設",
};

// ── Anthropic Claude ────────────────────────────────────────────────────────

export const ANTHROPIC_BASE_URL = "https://api.anthropic.com";
export const ANTHROPIC_VERSION = "2023-06-01";

const CLAUDE_EFFORT_OPTIONS = [
  { value: "low", label: "low" },
  { value: "medium", label: "medium" },
  { value: "high", label: "high" },
  { value: "xhigh", label: "xhigh" },
  { value: "max", label: "max" },
];

const CLAUDE_THINKING_OPTIONS = [
  { value: "adaptive", label: "adaptive（模型自行決定）" },
  { value: "disabled", label: "disabled（關閉）" },
  { value: "enabled", label: "enabled（固定預算，舊模型用）" },
];

const ANTHROPIC_PARAMS: ParamSpec[] = [
  {
    key: "effort",
    type: "select",
    label: "推理強度（effort）",
    help:
      "以 output_config.effort 送出，控制思考深度與輸出長度，是主要的成本開關。結構化萃取建議 low 或 medium。" +
      "預設值依模型而異（Opus 5.5、Haiku 5.5 為 medium，其他多為 high）。Haiku 4.5 等舊模型不支援，端點拒絕時會自動略過。",
    roles: ["analysis"],
    group: "reasoning",
    options: CLAUDE_EFFORT_OPTIONS,
    placeholder: "模型預設",
  },
  {
    key: "thinking",
    type: "select",
    label: "思考模式（thinking）",
    help:
      "adaptive：由模型依題目決定是否思考（目前模型的建議做法）。disabled：關閉思考——Opus 5.5、Sonnet 5.5、Fable 5.x 不允許關閉（會被拒絕並自動略過，改用模型預設）。" +
      "enabled：固定思考預算，只適用 Haiku 4.5 等舊模型，需搭配下方「思考預算」。思考 token 會計入輸出上限。",
    roles: ["analysis"],
    group: "reasoning",
    options: CLAUDE_THINKING_OPTIONS,
    placeholder: "模型預設",
  },
  {
    key: "thinking_budget",
    type: "integer",
    label: "思考預算（budget_tokens）",
    help:
      "僅舊模型（Haiku 4.5、Sonnet／Opus 4.5 及更早）使用：思考模式為 enabled 時的思考 token 上限，至少 1024 且必須小於輸出上限。" +
      "Claude 4.7 之後與 5.x 模型不接受，請改用「推理強度」。",
    roles: ["analysis"],
    group: "reasoning",
    min: 1024,
    max: 128_000,
    step: 1024,
    placeholder: "4096",
  },
  { ...TEMPERATURE_PARAM, max: 1, help: `範圍 0–1。${SAMPLING_NOTE_CLAUDE}` },
  { ...TOP_P_PARAM, help: `與 Temperature 不可同時設定。${SAMPLING_NOTE_CLAUDE}` },
  { ...TOP_K_BASE, help: `只從機率最高的 k 個 token 取樣。${SAMPLING_NOTE_CLAUDE}` },
];

const CLAUDE_DROPPABLE = ["temperature", "top_p", "top_k", "thinking", "output_config"];

function anthropicHeaders(p: LlmProfile): Record<string, string> {
  const h: Record<string, string> = { "anthropic-version": ANTHROPIC_VERSION };
  if (p.api_key) h["x-api-key"] = p.api_key;
  return h;
}

/** `thinking` object for the Messages API (also passed through Bedrock). */
export function claudeThinking(params: LlmProfile["params"], maxTokens: number): Json | undefined {
  const mode = pStr(params, "thinking");
  const budget = pNum(params, "thinking_budget");
  if (mode === "adaptive") return { type: "adaptive" };
  if (mode === "disabled") return { type: "disabled" };
  if (mode === "enabled" || (mode === undefined && budget !== undefined)) {
    // budget_tokens must be >= 1024 and < max_tokens.
    const b = Math.min(Math.max(1024, Math.trunc(budget ?? 4096)), maxTokens - 1);
    return b >= 1024 ? { type: "enabled", budget_tokens: b } : undefined;
  }
  return undefined;
}

export function buildAnthropicBody(p: LlmProfile, req: ChatRequest): Json {
  const { system, turns } = splitSystem(req.messages);
  const body: Json = { model: p.model, max_tokens: req.maxTokens };
  if (system) body.system = system;
  body.messages = turns;
  const thinking = claudeThinking(p.params, req.maxTokens);
  if (thinking) body.thinking = thinking;
  const effort = pStr(p.params, "effort");
  if (effort) body.output_config = { effort };
  for (const key of ["temperature", "top_p", "top_k"]) {
    const v = pNum(p.params, key);
    if (v !== undefined) body[key] = v;
  }
  return body;
}

/** Effort errors name `effort`, not always `output_config`. */
function adaptClaude(body: Json, low: string): string | null {
  // Sampling knobs and thinking are handled by the droppable list first.
  if (/\btemperature\b|\btop_p\b|\btop_k\b/.test(low)) return null;
  if (/thinking/.test(low) && "thinking" in body) return null;
  if (/effort/.test(low) && "output_config" in body) {
    delete body.output_config;
    return "effort";
  }
  return null;
}

async function anthropicChat(p: LlmProfile, req: ChatRequest, ctx: CallContext): Promise<ChatResult> {
  const url = `${ANTHROPIC_BASE_URL}/v1/messages`;
  const { json, dropped } = await postAdaptive(ctx, url, anthropicHeaders(p), buildAnthropicBody(p, req), CLAUDE_DROPPABLE, adaptClaude);
  if (json.type === "error") {
    const e = (json.error ?? {}) as Json;
    throw new ProviderReplyError(`Anthropic error: ${String(e.message ?? JSON.stringify(e)).slice(0, 300)}`);
  }
  let content = "";
  let reasoning = "";
  for (const block of (json.content as Json[] | undefined) ?? []) {
    if (block?.type === "text") content += String(block.text ?? "");
    else if (block?.type === "thinking") reasoning += String(block.thinking ?? "");
  }
  const finishReason = String(json.stop_reason ?? "");
  if (finishReason === "refusal") {
    const details = (json.stop_details ?? {}) as Json;
    const category = details.category ? ` (${String(details.category)})` : "";
    throw new ProviderReplyError(`Claude refused the request${category}`);
  }
  if (req.json) content = stripJsonFence(content);
  const usage = (json.usage ?? {}) as Json;
  return {
    content,
    finishReason,
    truncated: detectTruncation({
      provider: "Anthropic",
      content,
      finishReason,
      cutReasons: ["max_tokens", "model_context_window_exceeded"],
      reasoningChars: reasoning.length,
    }),
    usage: {
      promptTokens:
        positive(usage.input_tokens) + positive(usage.cache_creation_input_tokens) + positive(usage.cache_read_input_tokens),
      completionTokens: positive(usage.output_tokens),
      reasoningTokens: null, // output_tokens already includes thinking; no separate count
    },
    reasoningChars: reasoning.length,
    droppedParams: dropped,
  };
}

async function anthropicModels(p: LlmProfile, role: Role, ctx: CallContext): Promise<string[]> {
  if (role === "embedding") return [];
  const ids: string[] = [];
  let after: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const qs = `limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ""}`;
    const json = await getJson(ctx, `${ANTHROPIC_BASE_URL}/v1/models?${qs}`, anthropicHeaders(p));
    for (const m of (json.data as Json[] | undefined) ?? []) if (m?.id) ids.push(String(m.id));
    if (!json.has_more || !json.last_id) break;
    after = String(json.last_id);
  }
  return ids.sort();
}

export const anthropic: ProviderAdapter = {
  spec: {
    id: "anthropic",
    label: "Anthropic Claude",
    category: "cloud",
    description:
      "Anthropic 官方 Claude API（原生 Messages API）。適合需要高品質長文件萃取的仿單分析；Anthropic 沒有向量模型，嵌入請另選其他供應商。" +
      "沒有不帶 schema 的 JSON 模式，系統靠提示詞並自動去除 ```json 包裝。",
    roles: ["analysis"],
    baseUrl: { default: ANTHROPIC_BASE_URL, fixed: true },
    keyRequired: true,
    keyHelp: "在 platform.claude.com → API Keys 建立（sk-ant- 開頭）。以 x-api-key 標頭送出。",
    modelExamples: { analysis: ["claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-5-5"] },
    canListModels: true,
    docsUrl: "https://platform.claude.com/docs/en/api/overview",
    params: ANTHROPIC_PARAMS,
  },
  chat: anthropicChat,
  listModels: anthropicModels,
};

// ── Google Gemini ───────────────────────────────────────────────────────────

export const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com";
export const VERTEX_EXPRESS_BASE_URL = "https://aiplatform.googleapis.com";
const GEMINI_EMBED_BATCH = 100;
/** gemini-embedding-001 native size; other sizes come back non-normalized. */
const GEMINI_EMBED_NATIVE_DIMS = 3072;

const SAMPLING_NOTE_GEMINI = "Gemini 3.6 之後與 Gemini 4 會忽略此參數（未來版本可能回 400）；Gemini 3 建議維持預設。只有設定時才送出。";

const GEMINI_PARAMS: ParamSpec[] = [
  {
    key: "thinking_level",
    type: "select",
    label: "思考等級（thinkingLevel）",
    help:
      "Gemini 3 以後（含 Gemini 4）的思考深度。結構化萃取建議 low（或 3.6 Flash／Flash-Lite 的 minimal）。" +
      "minimal 在 Gemini 4 Argon、3.8 Flash 會被拒絕；minimal 也不保證完全不思考。思考 token 會計入輸出上限。",
    roles: ["analysis"],
    group: "reasoning",
    options: [
      { value: "minimal", label: "minimal" },
      { value: "low", label: "low" },
      { value: "medium", label: "medium" },
      { value: "high", label: "high" },
    ],
    placeholder: "模型預設",
    modelPattern: "^(?!.*gemini-2\\.5)",
  },
  {
    key: "thinking_budget",
    type: "integer",
    label: "思考預算（thinkingBudget）",
    help:
      "僅 Gemini 2.5 使用（Gemini 3 以後請改用思考等級，兩者不會同時送出）。-1＝動態；0＝關閉（Flash／Flash-Lite 可用，2.5 Pro 不可關閉、最少 128）。" +
      "上限：2.5 Pro 32768、Flash／Flash-Lite 24576。",
    roles: ["analysis"],
    group: "reasoning",
    min: -1,
    max: 32_768,
    step: 512,
    placeholder: "模型預設（動態）",
    modelPattern: "gemini-2\\.5",
  },
  { ...TEMPERATURE_PARAM, help: `範圍 0–2。${SAMPLING_NOTE_GEMINI}` },
  { ...TOP_P_PARAM, help: SAMPLING_NOTE_GEMINI },
  { ...TOP_K_BASE, help: `只從機率最高的 k 個 token 取樣。${SAMPLING_NOTE_GEMINI}` },
];

function geminiBase(p: LlmProfile): string {
  return trimSlash(p.base_url || GEMINI_BASE_URL);
}

function isVertexExpress(base: string): boolean {
  return /aiplatform\.googleapis\.com/i.test(base);
}

function geminiModelId(model: string): string {
  return model.trim().replace(/^models\//, "");
}

function geminiHeaders(p: LlmProfile): Record<string, string> {
  return p.api_key ? { "x-goog-api-key": p.api_key } : {};
}

function geminiMethodUrl(p: LlmProfile, method: string): string {
  const base = geminiBase(p);
  const model = encodeURIComponent(geminiModelId(p.model));
  return isVertexExpress(base)
    ? `${base}/v1/publishers/google/models/${model}:${method}`
    : `${base}/v1beta/models/${model}:${method}`;
}

export function isGemini25(model: string): boolean {
  return /gemini-2\.5/i.test(model);
}

/** thinkingConfig: level for Gemini 3+/4, budget for 2.5 — never both (400). */
export function geminiThinkingConfig(p: LlmProfile): Json | undefined {
  if (isGemini25(p.model)) {
    const budget = pNum(p.params, "thinking_budget");
    return budget === undefined ? undefined : { thinkingBudget: Math.trunc(budget) };
  }
  const level = pStr(p.params, "thinking_level");
  return level ? { thinkingLevel: level.toLowerCase() } : undefined;
}

export function buildGeminiBody(p: LlmProfile, req: ChatRequest): Json {
  const { system, turns } = splitSystem(req.messages);
  const body: Json = {};
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  body.contents = turns.map((t) => ({ role: t.role === "assistant" ? "model" : "user", parts: [{ text: t.content }] }));
  const gen: Json = { maxOutputTokens: req.maxTokens };
  if (req.json) gen.responseMimeType = "application/json";
  const t = pNum(p.params, "temperature");
  if (t !== undefined) gen.temperature = t;
  const topP = pNum(p.params, "top_p");
  if (topP !== undefined) gen.topP = topP;
  const topK = pNum(p.params, "top_k");
  if (topK !== undefined) gen.topK = topK;
  const thinking = geminiThinkingConfig(p);
  if (thinking) gen.thinkingConfig = thinking;
  body.generationConfig = gen;
  return body;
}

const GEMINI_DROP_RULES: NestedDropRule[] = [
  { pattern: /temperature/, path: ["generationConfig", "temperature"], label: "temperature" },
  { pattern: /\btop[_ ]?p\b/, path: ["generationConfig", "topP"], label: "top_p" },
  { pattern: /\btop[_ ]?k\b/, path: ["generationConfig", "topK"], label: "top_k" },
  { pattern: /thinking[_ ]?level/, path: ["generationConfig", "thinkingConfig", "thinkingLevel"], label: "thinking_level" },
  { pattern: /thinking[_ ]?budget/, path: ["generationConfig", "thinkingConfig", "thinkingBudget"], label: "thinking_budget" },
  { pattern: /response[_ ]?mime[_ ]?type/, path: ["generationConfig", "responseMimeType"], label: "responseMimeType" },
];

/** finishReasons where the model will not answer no matter the budget. */
const GEMINI_BLOCKED = new Set(["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "RECITATION", "LANGUAGE"]);

async function geminiChat(p: LlmProfile, req: ChatRequest, ctx: CallContext): Promise<ChatResult> {
  const url = geminiMethodUrl(p, "generateContent");
  const { json, dropped } = await postAdaptive(ctx, url, geminiHeaders(p), buildGeminiBody(p, req), [], (body, low) =>
    dropNested(body, low, GEMINI_DROP_RULES),
  );
  const candidates = (json.candidates as Json[] | undefined) ?? [];
  if (!candidates.length) {
    const fb = (json.promptFeedback ?? {}) as Json;
    if (fb.blockReason) throw new ProviderReplyError(`Gemini blocked the prompt: ${String(fb.blockReason)}`);
    if (json.error) {
      const e = json.error as Json;
      throw new ProviderReplyError(`Gemini error: ${String(e.message ?? JSON.stringify(e)).slice(0, 300)}`);
    }
  }
  const cand = candidates[0] ?? {};
  let content = "";
  let reasoning = "";
  for (const part of (((cand.content ?? {}) as Json).parts as Json[] | undefined) ?? []) {
    if (part?.thought === true) reasoning += String(part.text ?? "");
    else if (typeof part?.text === "string") content += part.text;
  }
  const finishReason = String(cand.finishReason ?? "");
  if (GEMINI_BLOCKED.has(finishReason) && !content.trim()) {
    throw new ProviderReplyError(`Gemini stopped without an answer: ${finishReason}`);
  }
  if (req.json) content = stripJsonFence(content);
  const usage = (json.usageMetadata ?? {}) as Json;
  const thoughts = usage.thoughtsTokenCount;
  return {
    content,
    finishReason,
    truncated: detectTruncation({
      provider: "Gemini",
      content,
      finishReason,
      cutReasons: ["MAX_TOKENS", "CONTINUATION"],
      reasoningChars: reasoning.length,
      reasoningTokens: thoughts === undefined ? null : positive(thoughts),
    }),
    usage: {
      promptTokens: positive(usage.promptTokenCount),
      // Billed output = visible candidates + thinking.
      completionTokens: positive(usage.candidatesTokenCount) + positive(thoughts),
      reasoningTokens: thoughts === undefined ? null : positive(thoughts),
    },
    reasoningChars: reasoning.length,
    droppedParams: dropped,
  };
}

/** gemini-embedding-2 rejects taskType; it takes the task as a text prefix instead. */
function usesTaskPrefix(model: string): boolean {
  return /gemini-embedding-(?!001)/i.test(model);
}

async function geminiEmbed(p: LlmProfile, req: EmbedRequest, ctx: CallContext): Promise<(number[] | null)[]> {
  if (isVertexExpress(geminiBase(p))) {
    throw new ProviderReplyError("Vertex AI express mode does not offer embeddings; use the Gemini API base URL");
  }
  const model = geminiModelId(p.model);
  const url = geminiMethodUrl(p, "batchEmbedContents");
  const prefix = usesTaskPrefix(model);
  const out: (number[] | null)[] = [];
  for (let i = 0; i < req.texts.length; i += GEMINI_EMBED_BATCH) {
    const texts = req.texts.slice(i, i + GEMINI_EMBED_BATCH);
    const requests = texts.map((text) => {
      const r: Json = { model: `models/${model}`, outputDimensionality: req.dimensions };
      if (prefix) {
        const t = req.inputType === "query" ? `task: search result | query: ${text}` : `title: none | text: ${text}`;
        r.content = { parts: [{ text: t }] };
      } else {
        r.content = { parts: [{ text }] };
        r.taskType = req.inputType === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT";
      }
      return r;
    });
    const json = await postJson(ctx, url, geminiHeaders(p), { requests });
    const embs = (json.embeddings as { values?: number[] }[] | undefined) ?? [];
    for (let j = 0; j < texts.length; j += 1) {
      const v = embs[j]?.values;
      if (!Array.isArray(v)) {
        out.push(null);
        continue;
      }
      // Truncated (Matryoshka) gemini-embedding-001 vectors are not unit length.
      out.push(req.dimensions !== GEMINI_EMBED_NATIVE_DIMS ? l2normalize(v) : v);
    }
  }
  return out;
}

async function geminiModels(p: LlmProfile, role: Role, ctx: CallContext): Promise<string[]> {
  const base = geminiBase(p);
  if (isVertexExpress(base)) throw new ProviderReplyError("Vertex AI express mode cannot list models; enter the model id manually");
  const method = role === "embedding" ? "embedContent" : "generateContent";
  const ids: string[] = [];
  let token: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const qs = `pageSize=1000${token ? `&pageToken=${encodeURIComponent(token)}` : ""}`;
    const json = await getJson(ctx, `${base}/v1beta/models?${qs}`, geminiHeaders(p));
    for (const m of (json.models as Json[] | undefined) ?? []) {
      const methods = (m.supportedGenerationMethods as string[] | undefined) ?? [];
      if (!methods.includes(method) && !(role === "embedding" && methods.includes("batchEmbedContents"))) continue;
      const id = String(m.name ?? "").replace(/^models\//, "");
      if (id) ids.push(id);
    }
    token = json.nextPageToken ? String(json.nextPageToken) : undefined;
    if (!token) break;
  }
  return [...new Set(ids)].sort();
}

export const gemini: ProviderAdapter = {
  spec: {
    id: "gemini",
    label: "Google Gemini",
    category: "cloud",
    description:
      "Google Gemini API（原生 generateContent／batchEmbedContents），可同時用於仿單分析與向量嵌入；以 responseMimeType 強制 JSON 輸出。" +
      "也可接 Vertex AI 快速模式（express mode）的 API 金鑰，但該模式只支援分析、不支援嵌入與列出模型。",
    roles: ["analysis", "embedding"],
    baseUrl: {
      default: GEMINI_BASE_URL,
      fixed: false,
      options: [
        { value: GEMINI_BASE_URL, label: "Gemini API（Google AI Studio，預設）" },
        { value: VERTEX_EXPRESS_BASE_URL, label: "Vertex AI 快速模式（express mode，僅分析）" },
      ],
      help: "一般使用 Gemini API 即可。Vertex AI 快速模式走全域端點，不需專案與區域。",
    },
    keyRequired: true,
    keyHelp: "在 aistudio.google.com → Get API key 建立（Vertex AI 快速模式則在 Google Cloud 主控台建立）。以 x-goog-api-key 標頭送出。",
    modelExamples: {
      analysis: ["gemini-3.8-flash", "gemini-4-argon", "gemini-3.5-flash-lite"],
      embedding: ["gemini-embedding-001", "gemini-embedding-2"],
    },
    canListModels: true,
    docsUrl: "https://ai.google.dev/api/generate-content",
    params: GEMINI_PARAMS,
    embeddingBatchLimit: GEMINI_EMBED_BATCH,
  },
  chat: geminiChat,
  embed: geminiEmbed,
  listModels: geminiModels,
};

// ── Amazon Bedrock ──────────────────────────────────────────────────────────

const BEDROCK_REGIONS: [string, string][] = [
  ["us-east-1", "美東（維吉尼亞北部）"],
  ["us-west-2", "美西（奧勒岡）"],
  ["ap-northeast-1", "亞太（東京）"],
  ["ap-southeast-1", "亞太（新加坡）"],
  ["ap-southeast-2", "亞太（雪梨）"],
  ["eu-central-1", "歐洲（法蘭克福）"],
  ["eu-west-1", "歐洲（愛爾蘭）"],
];

const COHERE_BATCH = 96;
const TITAN_DIMS = [256, 512, 1024];

/** Claude on Bedrock: base ids (anthropic.…) or inference profiles (us.anthropic.…). */
export function isBedrockClaude(model: string): boolean {
  return /anthropic\.|claude/i.test(model);
}

const BEDROCK_CLAUDE_PATTERN = "anthropic\\.|claude";

const BEDROCK_PARAMS: ParamSpec[] = [
  { ...TEMPERATURE_PARAM, help: `以 inferenceConfig.temperature 送出。${SAMPLING_NOTE_CLAUDE}` },
  { ...TOP_P_PARAM, help: `以 inferenceConfig.topP 送出。${SAMPLING_NOTE_CLAUDE}` },
  {
    ...TOP_K_BASE,
    help: `僅 Claude：以 additionalModelRequestFields.top_k 送出（其他模型會拒絕未知欄位，所以不送）。${SAMPLING_NOTE_CLAUDE}`,
    modelPattern: BEDROCK_CLAUDE_PATTERN,
  },
  {
    key: "thinking",
    type: "select",
    label: "思考模式（Claude）",
    help:
      "僅 Claude 模型，透過 additionalModelRequestFields 送出。adaptive：模型自行決定（Claude 4.6 以後建議）；disabled：關閉（最新的 Opus／Sonnet 5.5、Fable 5.x 不允許，會被拒絕並自動略過）；" +
      "enabled：固定思考預算，只適用 Haiku 4.5 等舊模型，需搭配「思考預算」。",
    roles: ["analysis"],
    group: "reasoning",
    options: CLAUDE_THINKING_OPTIONS,
    placeholder: "模型預設",
    modelPattern: BEDROCK_CLAUDE_PATTERN,
  },
  {
    key: "thinking_budget",
    type: "integer",
    label: "思考預算（budget_tokens）",
    help: "僅舊版 Claude（Haiku 4.5、Sonnet／Opus 4.5 及更早）：思考模式為 enabled 時的思考 token 上限，至少 1024 且必須小於輸出上限。",
    roles: ["analysis"],
    group: "reasoning",
    min: 1024,
    max: 128_000,
    step: 1024,
    placeholder: "4096",
    modelPattern: BEDROCK_CLAUDE_PATTERN,
  },
  {
    key: "effort",
    type: "select",
    label: "推理強度（Claude effort）",
    help: "僅 Claude 4.6 以後的模型：以 additionalModelRequestFields.output_config.effort 送出。結構化萃取建議 low 或 medium。舊模型會拒絕並自動略過。",
    roles: ["analysis"],
    group: "reasoning",
    options: CLAUDE_EFFORT_OPTIONS,
    placeholder: "模型預設",
    modelPattern: BEDROCK_CLAUDE_PATTERN,
  },
];

function bedrockBase(p: LlmProfile): string {
  const base = trimSlash(p.base_url);
  if (!base) throw new ProviderReplyError("Bedrock needs a region endpoint, e.g. https://bedrock-runtime.us-east-1.amazonaws.com");
  return base;
}

function bedrockHeaders(p: LlmProfile): Record<string, string> {
  return p.api_key ? { Authorization: `Bearer ${p.api_key}`, accept: "application/json" } : { accept: "application/json" };
}

function bedrockModelUrl(p: LlmProfile, action: "converse" | "invoke"): string {
  return `${bedrockBase(p)}/model/${encodeURIComponent(p.model.trim())}/${action}`;
}

export function buildBedrockConverseBody(p: LlmProfile, req: ChatRequest): Json {
  const { system, turns } = splitSystem(req.messages);
  const body: Json = { messages: turns.map((t) => ({ role: t.role, content: [{ text: t.content }] })) };
  if (system) body.system = [{ text: system }];
  const inference: Json = { maxTokens: req.maxTokens };
  const t = pNum(p.params, "temperature");
  if (t !== undefined) inference.temperature = t;
  const topP = pNum(p.params, "top_p");
  if (topP !== undefined) inference.topP = topP;
  body.inferenceConfig = inference;
  // Model-native extras: only Claude gets them — other models reject unknown keys.
  if (isBedrockClaude(p.model)) {
    const extra: Json = {};
    const topK = pNum(p.params, "top_k");
    if (topK !== undefined) extra.top_k = topK;
    const thinking = claudeThinking(p.params, req.maxTokens);
    if (thinking) extra.thinking = thinking;
    const effort = pStr(p.params, "effort");
    if (effort) extra.output_config = { effort };
    if (Object.keys(extra).length) body.additionalModelRequestFields = extra;
  }
  return body;
}

const BEDROCK_DROP_RULES: NestedDropRule[] = [
  { pattern: /temperature/, path: ["inferenceConfig", "temperature"], label: "temperature" },
  { pattern: /\btop_?p\b/, path: ["inferenceConfig", "topP"], label: "top_p" },
  { pattern: /\btop_?k\b/, path: ["additionalModelRequestFields", "top_k"], label: "top_k" },
  { pattern: /thinking|budget_tokens/, path: ["additionalModelRequestFields", "thinking"], label: "thinking" },
  { pattern: /effort|output_config/, path: ["additionalModelRequestFields", "output_config"], label: "effort" },
];

const BEDROCK_BLOCKED = new Set(["guardrail_intervened", "content_filtered"]);

async function bedrockChat(p: LlmProfile, req: ChatRequest, ctx: CallContext): Promise<ChatResult> {
  const { json, dropped } = await postAdaptive(
    ctx,
    bedrockModelUrl(p, "converse"),
    bedrockHeaders(p),
    buildBedrockConverseBody(p, req),
    [],
    (body, low) => dropNested(body, low, BEDROCK_DROP_RULES),
  );
  const message = (((json.output ?? {}) as Json).message ?? {}) as Json;
  let content = "";
  let reasoning = "";
  for (const block of (message.content as Json[] | undefined) ?? []) {
    if (typeof block?.text === "string") content += block.text;
    const rc = block?.reasoningContent as Json | undefined;
    const rt = rc?.reasoningText as Json | undefined;
    if (rt?.text) reasoning += String(rt.text);
  }
  const finishReason = String(json.stopReason ?? "");
  if (BEDROCK_BLOCKED.has(finishReason) && !content.trim()) {
    throw new ProviderReplyError(`Bedrock stopped without an answer: ${finishReason}`);
  }
  if (req.json) content = stripJsonFence(content);
  const usage = (json.usage ?? {}) as Json;
  const metrics = (json.metrics ?? {}) as Json;
  return {
    content,
    finishReason,
    truncated: detectTruncation({
      provider: "Bedrock",
      content,
      finishReason,
      cutReasons: ["max_tokens", "model_context_window_exceeded"],
      reasoningChars: reasoning.length,
    }),
    usage: {
      promptTokens: positive(usage.inputTokens) + positive(usage.cacheReadInputTokens) + positive(usage.cacheWriteInputTokens),
      completionTokens: positive(usage.outputTokens),
      reasoningTokens: null,
    },
    reasoningChars: reasoning.length,
    droppedParams: dropped,
    diagnostics: metrics.latencyMs !== undefined ? { latency_ms: positive(metrics.latencyMs) } : undefined,
  };
}

function isTitanEmbed(model: string): boolean {
  return /amazon\.titan-embed/i.test(model);
}

function isCohereEmbed(model: string): boolean {
  return /cohere\.embed/i.test(model);
}

/** Cohere replies `embeddings: [[…]]` or, with embedding_types, `embeddings: {float: [[…]]}`. */
function cohereVectors(json: Json): unknown[] {
  const e = json.embeddings;
  if (Array.isArray(e)) return e;
  if (e && typeof e === "object" && Array.isArray((e as Json).float)) return (e as Json).float as unknown[];
  return [];
}

async function bedrockEmbed(p: LlmProfile, req: EmbedRequest, ctx: CallContext): Promise<(number[] | null)[]> {
  const url = bedrockModelUrl(p, "invoke");
  const headers = bedrockHeaders(p);
  const out: (number[] | null)[] = [];
  if (isTitanEmbed(p.model)) {
    const v2 = /titan-embed-text-v2/i.test(p.model);
    if (v2 && !TITAN_DIMS.includes(req.dimensions)) {
      throw new ProviderReplyError(`Titan Text Embeddings V2 supports dimensions 256/512/1024, not ${req.dimensions}`);
    }
    // Titan takes exactly one text per call.
    for (const text of req.texts) {
      const body: Json = { inputText: text };
      if (v2) {
        body.dimensions = req.dimensions;
        body.normalize = true;
      }
      const json = await postJson(ctx, url, headers, body);
      out.push(Array.isArray(json.embedding) ? (json.embedding as number[]) : null);
    }
    return out;
  }
  if (isCohereEmbed(p.model)) {
    const v4 = /embed-v4/i.test(p.model);
    for (let i = 0; i < req.texts.length; i += COHERE_BATCH) {
      const texts = req.texts.slice(i, i + COHERE_BATCH);
      const body: Json = {
        texts,
        input_type: req.inputType === "query" ? "search_query" : "search_document",
        embedding_types: ["float"],
      };
      if (v4) body.output_dimension = req.dimensions;
      const json = await postJson(ctx, url, headers, body);
      const vecs = cohereVectors(json);
      // Normalization of Cohere vectors on Bedrock is undocumented: normalize here.
      for (let j = 0; j < texts.length; j += 1) out.push(Array.isArray(vecs[j]) ? l2normalize(vecs[j] as number[]) : null);
    }
    return out;
  }
  throw new ProviderReplyError(
    `Unsupported Bedrock embedding model "${p.model}" (supported: amazon.titan-embed-text-v2:0, cohere.embed-*)`,
  );
}

/** bedrock-runtime.{region}.amazonaws.com → bedrock.{region}.amazonaws.com (control plane). */
export function bedrockControlPlane(runtimeBase: string): string {
  const u = trimSlash(runtimeBase);
  if (!/bedrock-runtime(-fips)?\./i.test(u)) {
    throw new ProviderReplyError(`Cannot derive the Bedrock control-plane host from ${u}`);
  }
  return u.replace(/bedrock-runtime(-fips)?\./i, (_m, fips: string | undefined) => `bedrock${fips ?? ""}.`);
}

function modelMatchesRole(m: Json, role: Role): boolean {
  const out = ((m.outputModalities as string[] | undefined) ?? []).map((x) => String(x).toUpperCase());
  const input = ((m.inputModalities as string[] | undefined) ?? []).map((x) => String(x).toUpperCase());
  return role === "embedding" ? out.includes("EMBEDDING") && input.includes("TEXT") : out.includes("TEXT") && input.includes("TEXT");
}

async function bedrockModels(p: LlmProfile, role: Role, ctx: CallContext): Promise<string[]> {
  const control = bedrockControlPlane(bedrockBase(p));
  const headers = bedrockHeaders(p);
  const json = await getJson(ctx, `${control}/foundation-models`, headers);
  const summaries = ((json.modelSummaries as Json[] | undefined) ?? []).filter((m) => modelMatchesRole(m, role));
  const ids = new Set<string>();
  const roleModels = new Set<string>();
  for (const m of summaries) {
    const id = String(m.modelId ?? "");
    if (!id) continue;
    roleModels.add(id);
    const types = ((m.inferenceTypesSupported as string[] | undefined) ?? []).map(String);
    // Profile-only models cannot be called by their base id.
    if (!types.length || types.includes("ON_DEMAND")) ids.add(id);
  }
  // Cross-region inference profiles (us./eu./apac./global.) — best effort.
  try {
    let token: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const qs = `maxResults=1000${token ? `&nextToken=${encodeURIComponent(token)}` : ""}`;
      const prof = await getJson(ctx, `${control}/inference-profiles?${qs}`, headers);
      for (const ip of (prof.inferenceProfileSummaries as Json[] | undefined) ?? []) {
        const pid = String(ip.inferenceProfileId ?? "");
        const arns = ((ip.models as Json[] | undefined) ?? []).map((x) => String(x.modelArn ?? ""));
        const matches = arns.some((arn) => roleModels.has(arn.slice(arn.indexOf("foundation-model/") + "foundation-model/".length)));
        if (pid && matches) ids.add(pid);
      }
      token = prof.nextToken ? String(prof.nextToken) : undefined;
      if (!token) break;
    }
  } catch {
    // Key may lack bedrock:ListInferenceProfiles; base models are still useful.
  }
  return [...ids].sort();
}

export const bedrock: ProviderAdapter = {
  spec: {
    id: "bedrock",
    label: "Amazon Bedrock",
    category: "cloud",
    description:
      "Amazon Bedrock（Converse API 分析、InvokeModel 嵌入），以 Bedrock API 金鑰驗證。適合資料需留在 AWS 帳號內、或已有 AWS 合約的部署。" +
      "可用 Claude 等模型做仿單分析；嵌入支援 Titan Text Embeddings V2 與 Cohere Embed。沒有通用 JSON 模式，系統靠提示詞並自動去除 ```json 包裝。",
    roles: ["analysis", "embedding"],
    baseUrl: {
      placeholder: "https://bedrock-runtime.<區域>.amazonaws.com",
      options: BEDROCK_REGIONS.map(([r, name]) => ({ value: `https://bedrock-runtime.${r}.amazonaws.com`, label: `${r}（${name}）` })),
      help: "選擇 API 金鑰所屬的區域（金鑰綁定區域，填錯會出現「Credential should be scoped to a valid region」）。",
    },
    keyRequired: true,
    keyHelp:
      "AWS 主控台 → Amazon Bedrock → API keys 建立（長期或短期金鑰，短期最長 12 小時）。以 Authorization: Bearer 送出，不需 AWS 存取金鑰／SigV4。",
    modelLabel: "模型 ID 或推論設定檔 ID",
    modelHelp:
      "較新的模型多半只能用跨區域推論設定檔呼叫（例如 us.、apac.、global. 開頭）。嵌入支援 amazon.titan-embed-text-v2:0（256／512／1024 維，一次一筆）與 cohere.embed-*（每批 96 筆）。",
    modelExamples: {
      analysis: ["global.anthropic.claude-sonnet-4-6", "us.anthropic.claude-haiku-4-5-20251001-v1:0", "openai.gpt-oss-120b-1:0"],
      embedding: ["amazon.titan-embed-text-v2:0", "cohere.embed-v4:0", "cohere.embed-multilingual-v3"],
    },
    canListModels: true,
    docsUrl: "https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference.html",
    params: BEDROCK_PARAMS,
    embeddingBatchLimit: COHERE_BATCH,
  },
  chat: bedrockChat,
  embed: bedrockEmbed,
  listModels: bedrockModels,
};

export const ADAPTERS: ProviderAdapter[] = [anthropic, gemini, bedrock];
