/**
 * Specialist cloud vendors: Mistral AI and Cohere (chat + embeddings), Voyage AI
 * (MongoDB) and Jina AI (embeddings only).
 *
 * - Mistral speaks the OpenAI format with quirks (temperature 0–1.5,
 *   `random_seed`, reasoning chunks in `content`, `model_length` finish reason,
 *   `output_dimension` on codestral-embed only).
 * - Cohere uses its native v2 API: the compatibility layer has no
 *   `input_type` / `output_dimension` for embeddings, so it cannot serve the
 *   embedding role properly.
 * - Voyage and Jina have OpenAI-like embedding replies but their own request
 *   fields (`input_type` / `task`, `output_dimension` / `dimensions`, dtype).
 *
 * Docs: https://docs.mistral.ai/api/ , https://docs.cohere.com/reference/chat ,
 * https://docs.cohere.com/reference/embed , https://docs.voyageai.com/reference/embeddings-api ,
 * https://api.jina.ai/openapi.json
 */

import type { LlmProfile } from "../admin/llmProfiles.js";
import {
  detectTruncation,
  getJson,
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
  bearer,
  openAiCompatChat,
  openAiCompatEmbed,
  openAiCompatModels,
  type OpenAiCompatOptions,
} from "./openaiCompat.js";
import {
  ProviderReplyError,
  type CallContext,
  type ChatRequest,
  type ChatResult,
  type EmbedRequest,
  type ParamSpec,
  type ProviderAdapter,
  type Role,
} from "./types.js";

// ---------------------------------------------------------------------------
// Shared: token-aware batch planning
// ---------------------------------------------------------------------------

/**
 * Rough token estimate used to stay under per-request token caps. ASCII text
 * runs ≈ 3 chars/token (deliberately pessimistic vs the usual 4); CJK and other
 * non-ASCII characters are counted as 1.5 tokens each, because chars/3 badly
 * under-counts Chinese text (most Han characters are ≥ 1 token).
 */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (const ch of text) {
    if (ch.charCodeAt(0) < 128) ascii += 1;
    else other += 1;
  }
  return Math.ceil(ascii / 3 + other * 1.5);
}

/**
 * Split `texts` into consecutive batches of at most `maxItems` items and at
 * most `maxTokens` estimated tokens. A single over-sized text still gets its
 * own batch (the provider truncates it).
 */
export function planBatches(texts: string[], maxItems: number, maxTokens = Infinity): string[][] {
  const batches: string[][] = [];
  let cur: string[] = [];
  let curTokens = 0;
  for (const t of texts) {
    const n = estimateTokens(t);
    if (cur.length && (cur.length >= maxItems || curTokens + n > maxTokens)) {
      batches.push(cur);
      cur = [];
      curTokens = 0;
    }
    cur.push(t);
    curTokens += n;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

/** Pad / trim a batch reply so callers always get one slot per input. */
function fit(vectors: (number[] | null)[], count: number): (number[] | null)[] {
  const out = vectors.slice(0, count);
  while (out.length < count) out.push(null);
  return out;
}

/** Read an OpenAI-shaped `data[]` embedding reply in input order. */
function readDataEmbeddings(json: Record<string, unknown>): (number[] | null)[] {
  const data = [...((json.data as { index?: number; embedding?: unknown }[] | undefined) ?? [])].sort(
    (a, b) => (a.index ?? 0) - (b.index ?? 0),
  );
  return data.map((d) => (Array.isArray(d.embedding) ? (d.embedding as number[]) : null));
}

// ---------------------------------------------------------------------------
// Mistral AI
// ---------------------------------------------------------------------------

export const MISTRAL_BASE_URL = "https://api.mistral.ai/v1";

/** Models that take `reasoning_effort` (docs.mistral.ai/capabilities/reasoning). */
const MISTRAL_REASONING_PATTERN = "^(mistral-(small|medium|large)|zai-glm)";

/** Mistral does not publish embedding batch limits; stay well under the commonly cited ~16k tokens/request. */
const MISTRAL_EMBED_MAX_ITEMS = 128;
const MISTRAL_EMBED_MAX_TOKENS = 12_000;

const MISTRAL_PARAMS: ParamSpec[] = [
  {
    ...TEMPERATURE_PARAM,
    max: 1.5,
    help: "Mistral 範圍 0–1.5，官方建議 0–0.7；結構化萃取建議 0–0.2。留空使用模型預設（各模型不同）。與 Top-p 擇一調整即可。",
  },
  TOP_P_PARAM,
  {
    key: "reasoning_effort",
    type: "select",
    label: "推理強度（reasoning_effort）",
    help:
      "支援推理的模型（mistral-small-latest、mistral-medium-3-5、mistral-large-4-0、zai-glm-5-3）思考的深度。" +
      "結構化萃取建議 none（不思考，回覆較乾淨、省輸出預算）。zai-glm-5-3 不接受 none，只接受 low／high。端點拒絕時會自動略過。",
    roles: ["analysis"],
    group: "reasoning",
    options: [
      { value: "none", label: "none（不推理）" },
      { value: "minimal", label: "minimal" },
      { value: "low", label: "low" },
      { value: "medium", label: "medium" },
      { value: "high", label: "high" },
      { value: "xhigh", label: "xhigh" },
    ],
    placeholder: "模型預設",
    modelPattern: MISTRAL_REASONING_PATTERN,
  },
  {
    key: "random_seed",
    type: "integer",
    label: "隨機種子（random_seed）",
    help: "固定種子讓相同輸入盡量得到相同輸出，方便比對。留空不固定。",
    roles: ["analysis"],
    group: "advanced",
    min: 0,
    placeholder: "不固定",
  },
];

const mistralOpts: OpenAiCompatOptions = {
  root: () => MISTRAL_BASE_URL,
  headers: bearer,
  tokenParam: () => "max_tokens",
  // json_object only works when the prompt itself asks for JSON.
  jsonNeedsKeyword: true,
  extraBody: (p) => {
    const body: Record<string, unknown> = {};
    const effort = pStr(p.params, "reasoning_effort");
    if (effort && new RegExp(MISTRAL_REASONING_PATTERN, "i").test(p.model)) body.reasoning_effort = effort;
    const seed = pNum(p.params, "random_seed");
    if (seed !== undefined) body.random_seed = Math.trunc(seed);
    return body;
  },
  droppable: ["temperature", "top_p", "response_format", "reasoning_effort", "random_seed"],
  // length = max_tokens hit, model_length = context window hit.
  truncationReasons: ["length", "model_length"],
  embeddings: {
    // mistral-embed is fixed at 1024 and documents no size knob; codestral-embed is Matryoshka (≤ 3072).
    body: (p, req) => (/codestral-embed/i.test(p.model) ? { output_dimension: req.dimensions, output_dtype: "float" } : {}),
    batchLimit: MISTRAL_EMBED_MAX_ITEMS,
  },
  filterModels: (_ids, role, raw) => {
    const now = Date.now();
    return raw
      .filter((m) => {
        const dep = m.deprecation ? Date.parse(String(m.deprecation)) : NaN;
        return !(Number.isFinite(dep) && dep < now);
      })
      .filter((m) => {
        const id = String(m.id ?? "");
        const caps = (m.capabilities ?? {}) as Record<string, unknown>;
        const isEmbed = /embed/i.test(id);
        if (role === "embedding") return isEmbed;
        if (isEmbed) return false;
        // Without a capabilities block fall back to the name.
        if (!m.capabilities) return !/(ocr|moderation|voxtral|transcribe)/i.test(id);
        return caps.completion_chat === true;
      })
      .map((m) => String(m.id ?? ""))
      .filter(Boolean)
      .filter((id, i, arr) => arr.indexOf(id) === i);
  },
};

async function mistralEmbed(profile: LlmProfile, req: EmbedRequest, ctx: CallContext): Promise<(number[] | null)[]> {
  const out: (number[] | null)[] = [];
  for (const texts of planBatches(req.texts, MISTRAL_EMBED_MAX_ITEMS, MISTRAL_EMBED_MAX_TOKENS)) {
    out.push(...fit(await openAiCompatEmbed(profile, { ...req, texts }, ctx, mistralOpts), texts.length));
  }
  return out;
}

export const mistral: ProviderAdapter = {
  spec: {
    id: "mistral",
    label: "Mistral AI",
    category: "cloud",
    description:
      "Mistral AI 官方 API（法國，資料可留在歐盟）。Mistral Small／Medium／Large 系列可用 reasoning_effort 開關思考；嵌入可選 mistral-embed（固定 1024 維）或 codestral-embed（可調維度）。",
    roles: ["analysis", "embedding"],
    baseUrl: { default: MISTRAL_BASE_URL, fixed: true },
    keyRequired: true,
    keyHelp: "在 console.mistral.ai → API Keys 建立（需先啟用付費方案或實驗方案）。",
    modelExamples: {
      analysis: ["mistral-medium-3-5", "mistral-large-4-0", "mistral-small-latest"],
      embedding: ["mistral-embed", "codestral-embed"],
    },
    canListModels: true,
    docsUrl: "https://docs.mistral.ai/api/",
    params: MISTRAL_PARAMS,
    embeddingBatchLimit: MISTRAL_EMBED_MAX_ITEMS,
  },
  chat: (p, req, ctx) => openAiCompatChat(p, req, ctx, mistralOpts),
  embed: mistralEmbed,
  listModels: (p, role, ctx) => openAiCompatModels(p, role, ctx, mistralOpts),
};

// ---------------------------------------------------------------------------
// Cohere (native v2 API)
// ---------------------------------------------------------------------------

export const COHERE_BASE_URL = "https://api.cohere.com";
const COHERE_EMBED_MAX_ITEMS = 96;

/** Reasoning-capable Command models (thinking is on by default there). */
const COHERE_REASONING_PATTERN = "(reasoning|command-a-plus)";

/** Models that accept `output_dimension` (embed-v4.0 and later). */
function cohereFlexibleDims(model: string): boolean {
  return /^embed-v([4-9]|\d{2,})/i.test(model);
}

const COHERE_PARAMS: ParamSpec[] = [
  { ...TEMPERATURE_PARAM, help: "越低越穩定，Cohere 預設 0.3。結構化萃取建議 0–0.2。留空使用模型預設。" },
  {
    key: "p",
    type: "number",
    label: "Top-p（p）",
    help: "Cohere 的 top-p，範圍 0.01–0.99（不接受 1），預設 0.75。留空使用模型預設。",
    roles: ["analysis"],
    group: "generation",
    min: 0.01,
    max: 0.99,
    step: 0.01,
    placeholder: "模型預設",
  },
  {
    key: "k",
    type: "integer",
    label: "Top-k（k）",
    help: "只從機率最高的 k 個 token 取樣，0 表示關閉（預設）。",
    roles: ["analysis"],
    group: "generation",
    min: 0,
    max: 500,
    placeholder: "模型預設",
  },
  {
    key: "thinking",
    type: "select",
    label: "思考模式（thinking）",
    help: "推理模型（command-a-reasoning、command-a-plus）預設會先思考。結構化萃取建議關閉，回覆較快、輸出預算全留給答案。",
    roles: ["analysis"],
    group: "reasoning",
    options: [
      { value: "disabled", label: "關閉" },
      { value: "enabled", label: "開啟" },
    ],
    placeholder: "模型預設（開啟）",
    modelPattern: COHERE_REASONING_PATTERN,
  },
  {
    key: "thinking_token_budget",
    type: "integer",
    label: "思考 token 上限（token_budget）",
    help: "思考模式開啟時，思考最多用多少 token；超過即直接作答。官方建議不設限，若要設請至少留 1000 token 給答案。",
    roles: ["analysis"],
    group: "reasoning",
    min: 1,
    max: 31000,
    placeholder: "不限制",
    modelPattern: COHERE_REASONING_PATTERN,
  },
];

function cohereHeaders(profile: LlmProfile): Record<string, string> {
  return { ...bearer(profile), "X-Client-Name": "taiwan-health-mcp" };
}

export function buildCohereChatBody(profile: LlmProfile, req: ChatRequest): Record<string, unknown> {
  const body: Record<string, unknown> = { model: profile.model, messages: req.messages, max_tokens: req.maxTokens };
  const t = pNum(profile.params, "temperature");
  if (t !== undefined) body.temperature = t;
  const p = pNum(profile.params, "p");
  if (p !== undefined) body.p = p;
  const k = pNum(profile.params, "k");
  if (k !== undefined) body.k = Math.trunc(k);
  if (req.json) body.response_format = { type: "json_object" };
  if (new RegExp(COHERE_REASONING_PATTERN, "i").test(profile.model)) {
    const mode = pStr(profile.params, "thinking");
    const budget = pNum(profile.params, "thinking_token_budget");
    if (mode === "disabled") body.thinking = { type: "disabled" };
    else if (mode === "enabled" || budget !== undefined) {
      body.thinking = { type: "enabled", ...(budget !== undefined && budget > 0 ? { token_budget: Math.trunc(budget) } : {}) };
    }
  }
  return body;
}

async function cohereChat(profile: LlmProfile, req: ChatRequest, ctx: CallContext): Promise<ChatResult> {
  const url = `${COHERE_BASE_URL}/v2/chat`;
  const { json, dropped } = await postAdaptive(ctx, url, cohereHeaders(profile), buildCohereChatBody(profile, req), [
    "temperature",
    "p",
    "k",
    "response_format",
    "thinking",
  ]);
  const message = json.message as Record<string, unknown> | undefined;
  if (!message) {
    throw new ProviderReplyError(`Cohere reply has no message: ${String(json.message ?? JSON.stringify(json)).slice(0, 300)}`);
  }
  let content = "";
  let thinking = "";
  const raw = message.content;
  if (typeof raw === "string") content = raw;
  else if (Array.isArray(raw)) {
    for (const part of raw as Record<string, unknown>[]) {
      if (part?.type === "text") content += String(part.text ?? "");
      else if (part?.type === "thinking") thinking += String(part.thinking ?? part.text ?? "");
    }
  }
  if (req.json) content = stripJsonFence(content);
  const finishReason = String(json.finish_reason ?? "");
  const usage = (json.usage ?? {}) as Record<string, unknown>;
  const tokens = (usage.tokens ?? {}) as Record<string, unknown>;
  const billed = (usage.billed_units ?? {}) as Record<string, unknown>;
  return {
    content,
    finishReason,
    truncated: detectTruncation({ provider: "Cohere", content, finishReason, cutReasons: ["MAX_TOKENS"], reasoningChars: thinking.length }),
    usage: {
      promptTokens: positive(tokens.input_tokens ?? billed.input_tokens),
      completionTokens: positive(tokens.output_tokens ?? billed.output_tokens),
      reasoningTokens: null,
    },
    reasoningChars: thinking.length,
    droppedParams: dropped,
  };
}

async function cohereEmbed(profile: LlmProfile, req: EmbedRequest, ctx: CallContext): Promise<(number[] | null)[]> {
  const url = `${COHERE_BASE_URL}/v2/embed`;
  const out: (number[] | null)[] = [];
  for (const texts of planBatches(req.texts, COHERE_EMBED_MAX_ITEMS)) {
    const body: Record<string, unknown> = {
      model: profile.model,
      texts,
      input_type: req.inputType === "query" ? "search_query" : "search_document",
      embedding_types: ["float"],
    };
    if (cohereFlexibleDims(profile.model)) body.output_dimension = req.dimensions;
    const json = await postJson(ctx, url, cohereHeaders(profile), body);
    const floats = ((json.embeddings ?? {}) as Record<string, unknown>).float;
    const vecs = Array.isArray(floats) ? (floats as unknown[]).map((v) => (Array.isArray(v) ? (v as number[]) : null)) : [];
    out.push(...fit(vecs, texts.length));
  }
  return out;
}

async function cohereModels(profile: LlmProfile, role: Role, ctx: CallContext): Promise<string[]> {
  const endpoint = role === "embedding" ? "embed" : "chat";
  const ids: string[] = [];
  let pageToken = "";
  for (let page = 0; page < 10; page += 1) {
    const qs = new URLSearchParams({ endpoint, page_size: "1000" });
    if (pageToken) qs.set("page_token", pageToken);
    const json = await getJson(ctx, `${COHERE_BASE_URL}/v1/models?${qs.toString()}`, cohereHeaders(profile));
    for (const m of (json.models ?? []) as Record<string, unknown>[]) {
      if (m?.name && m.is_deprecated !== true) ids.push(String(m.name));
    }
    pageToken = String(json.next_page_token ?? "");
    if (!pageToken) break;
  }
  return [...new Set(ids)].sort();
}

export const cohere: ProviderAdapter = {
  spec: {
    id: "cohere",
    label: "Cohere",
    category: "cloud",
    description:
      "Cohere 原生 v2 API（不是相容層）。Command A 系列做分析；Embed v4／v5 支援查詢／文件非對稱嵌入並可調維度（256–2048），多語（含中文）表現佳。每批最多 96 段文字。",
    roles: ["analysis", "embedding"],
    baseUrl: { default: COHERE_BASE_URL, fixed: true },
    keyRequired: true,
    keyHelp: "在 dashboard.cohere.com → API Keys 建立。試用金鑰（Trial）速率很低（約每分鐘 40 次），正式匯入請用 Production 金鑰。",
    modelExamples: {
      analysis: ["command-a-plus-05-2026", "command-a-reasoning-08-2025", "command-a-03-2025"],
      embedding: ["embed-v5.0-pro", "embed-v5.0-fast", "embed-v4.0", "embed-multilingual-v3.0"],
    },
    modelHelp: "command-a-03-2025 最多只輸出 8k token，長 JSON 可能被截斷；需要長輸出請選 command-a-plus 或 command-a-reasoning。embed-multilingual-v3.0 固定 1024 維、每段只讀 512 token。",
    canListModels: true,
    docsUrl: "https://docs.cohere.com/reference/chat",
    params: COHERE_PARAMS,
    embeddingBatchLimit: COHERE_EMBED_MAX_ITEMS,
  },
  chat: cohereChat,
  embed: cohereEmbed,
  listModels: cohereModels,
};

// ---------------------------------------------------------------------------
// Voyage AI (MongoDB)
// ---------------------------------------------------------------------------

export const VOYAGE_BASE_URL = "https://api.voyageai.com/v1";
const VOYAGE_MAX_ITEMS = 1000;

/** Models that accept output_dimension 256/512/1024/2048 (others are fixed-size). */
function voyageFlexibleDims(model: string): boolean {
  return /^voyage-(4|code-4|3\.5|3-large|code-3)(-|$)/i.test(model) && !/context/i.test(model);
}

/** Per-request total-token cap by model (docs.voyageai.com/reference/embeddings-api). */
export function voyageTokenCap(model: string): number {
  const m = model.toLowerCase();
  if (/^voyage-(4-lite|3\.5-lite)$/.test(m)) return 1_000_000;
  if (/^voyage-(4|3\.5|2)$/.test(m)) return 320_000;
  return 120_000;
}

function voyageRoot(profile: LlmProfile): string {
  const u = trimSlash(profile.base_url || VOYAGE_BASE_URL);
  return /\/v\d+$/i.test(u) ? u : `${u}/v1`;
}

async function voyageEmbed(profile: LlmProfile, req: EmbedRequest, ctx: CallContext): Promise<(number[] | null)[]> {
  const url = `${voyageRoot(profile)}/embeddings`;
  // 10% headroom: the estimate is approximate.
  const cap = Math.floor(voyageTokenCap(profile.model) * 0.9);
  const out: (number[] | null)[] = [];
  for (const texts of planBatches(req.texts, VOYAGE_MAX_ITEMS, cap)) {
    const body: Record<string, unknown> = {
      input: texts,
      model: profile.model,
      input_type: req.inputType,
      truncation: true,
    };
    if (voyageFlexibleDims(profile.model)) {
      body.output_dimension = req.dimensions;
      body.output_dtype = "float";
    }
    const json = await postJson(ctx, url, bearer(profile), body);
    out.push(...fit(readDataEmbeddings(json), texts.length));
  }
  return out;
}

export const voyage: ProviderAdapter = {
  spec: {
    id: "voyage",
    label: "Voyage AI（MongoDB）",
    category: "cloud",
    description:
      "Voyage AI 嵌入（已併入 MongoDB）。voyage-4 系列共用同一向量空間，可用 voyage-4-large 建索引、voyage-4-lite 查詢；維度可選 256／512／1024／2048。只提供嵌入。",
    roles: ["embedding"],
    baseUrl: {
      default: VOYAGE_BASE_URL,
      options: [
        { value: "https://api.voyageai.com/v1", label: "Voyage 平台金鑰（api.voyageai.com）" },
        { value: "https://ai.mongodb.com/v1", label: "MongoDB Atlas 模型金鑰（ai.mongodb.com）" },
        { value: "https://us.ai.mongodb.com/v1", label: "MongoDB Atlas 美國區金鑰（us.ai.mongodb.com）" },
        { value: "https://eu.ai.mongodb.com/v1", label: "MongoDB Atlas 歐盟區金鑰（eu.ai.mongodb.com）" },
      ],
      help: "依金鑰來源選擇：Voyage 平台金鑰用 api.voyageai.com；MongoDB Atlas 建立的模型 API 金鑰用 ai.mongodb.com；限定區域的金鑰只能打對應區域的網址。",
    },
    keyRequired: true,
    keyHelp: "Voyage 平台（dashboard.voyageai.com）或 MongoDB Atlas → AI Models → API Keys 建立。網址必須與金鑰來源一致。",
    modelExamples: { embedding: ["voyage-4-large", "voyage-4", "voyage-4-lite", "voyage-multilingual-2"] },
    modelHelp: "voyage-4／3.5／3-large／code 系列可調維度（預設 1024）；voyage-multilingual-2、voyage-3 等舊模型固定 1024 維。無法列出模型，請手動輸入。",
    canListModels: false,
    docsUrl: "https://docs.voyageai.com/reference/embeddings-api",
    params: [],
    embeddingBatchLimit: VOYAGE_MAX_ITEMS,
  },
  embed: voyageEmbed,
};

// ---------------------------------------------------------------------------
// Jina AI
// ---------------------------------------------------------------------------

export const JINA_EMBEDDINGS_URL = "https://api.jina.ai/v1/embeddings";
/** No hard per-request item cap, but the free tier allows only 100K tokens/minute. */
const JINA_MAX_ITEMS = 256;
const JINA_MAX_TOKENS = 50_000;

/** jina-embeddings v3 / v4 / v5-* all accept retrieval.query / retrieval.passage and `dimensions`. */
function jinaRetrievalFamily(model: string): boolean {
  return /^jina-embeddings-v[345](-|$)/i.test(model);
}

async function jinaEmbed(profile: LlmProfile, req: EmbedRequest, ctx: CallContext): Promise<(number[] | null)[]> {
  const out: (number[] | null)[] = [];
  for (const texts of planBatches(req.texts, JINA_MAX_ITEMS, JINA_MAX_TOKENS)) {
    const body: Record<string, unknown> = {
      model: profile.model,
      input: texts,
      embedding_type: "float",
      // Default is false (over-length input errors); truncate instead.
      truncate: true,
    };
    if (jinaRetrievalFamily(profile.model)) {
      body.task = req.inputType === "query" ? "retrieval.query" : "retrieval.passage";
      body.dimensions = req.dimensions;
    }
    const json = await postJson(ctx, JINA_EMBEDDINGS_URL, bearer(profile), body);
    out.push(...fit(readDataEmbeddings(json), texts.length));
  }
  return out;
}

export const jina: ProviderAdapter = {
  spec: {
    id: "jina",
    label: "Jina AI",
    category: "cloud",
    description:
      "Jina AI 嵌入 API。jina-embeddings-v5-text-small 與 v3 支援查詢／文件非對稱嵌入（task）與 1–1024 維；v4 最高 2048 維但官方標示免費、較慢、不建議正式使用。只提供嵌入。",
    roles: ["embedding"],
    baseUrl: { default: "https://api.jina.ai/v1", fixed: true },
    keyRequired: true,
    keyHelp: "在 jina.ai 取得 API 金鑰。免費額度速率為每分鐘 100 次／10 萬 token，大量匯入請使用付費金鑰。",
    modelExamples: { embedding: ["jina-embeddings-v5-text-small", "jina-embeddings-v5-text-nano", "jina-embeddings-v3"] },
    modelHelp: "v5-text-small／v3 最高 1024 維；v5-text-nano 每段最多 8192 token。無法列出模型，請手動輸入。",
    canListModels: false,
    docsUrl: "https://jina.ai/embeddings/",
    params: [],
    embeddingBatchLimit: JINA_MAX_ITEMS,
  },
  embed: jinaEmbed,
};

export const ADAPTERS: ProviderAdapter[] = [mistral, cohere, voyage, jina];
