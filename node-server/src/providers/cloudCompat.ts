/**
 * OpenAI-compatible clouds: DeepSeek, xAI, Groq, OpenRouter, Together AI,
 * Fireworks AI. All speak POST /chat/completions; this file only describes the
 * per-vendor quirks (token param name, thinking switch, JSON rules, routing).
 * Research: official docs as of 2026-10-15 (see each adapter's docsUrl).
 */

import type { LlmProfile } from "../admin/llmProfiles.js";
import { getJson, pBool, pStr, TEMPERATURE_PARAM, TOP_P_PARAM } from "./common.js";
import {
  bearer,
  byEmbeddingName,
  openAiCompatChat,
  openAiCompatEmbed,
  openAiCompatModels,
  type OpenAiCompatOptions,
} from "./openaiCompat.js";
import type { CallContext, ParamSpec, ProviderAdapter, Role } from "./types.js";

/** Default droppable keys from openaiCompat plus vendor-specific extras. */
const BASE_DROPPABLE = [
  "temperature",
  "top_p",
  "response_format",
  "reasoning_effort",
  "thinking",
  "chat_template_kwargs",
];

function adapterFrom(spec: ProviderAdapter["spec"], opts: OpenAiCompatOptions, withEmbed = false): ProviderAdapter {
  return {
    spec,
    chat: (p, req, ctx) => openAiCompatChat(p, req, ctx, opts),
    ...(withEmbed ? { embed: (p, req, ctx) => openAiCompatEmbed(p, req, ctx, opts) } : {}),
    listModels: (p, role, ctx) => openAiCompatModels(p, role, ctx, opts),
  };
}

// ---------------------------------------------------------------------------
// DeepSeek — https://api-docs.deepseek.com
// ---------------------------------------------------------------------------

export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";

const deepseekOpts: OpenAiCompatOptions = {
  root: () => DEEPSEEK_BASE_URL,
  headers: bearer,
  tokenParam: () => "max_tokens",
  // json_object only (no json_schema), and the prompt must contain "json".
  jsonNeedsKeyword: true,
  extraBody: (p) => {
    const body: Record<string, unknown> = {};
    const thinking = pStr(p.params, "thinking");
    if (thinking === "enabled" || thinking === "disabled") body.thinking = { type: thinking };
    const effort = pStr(p.params, "reasoning_effort");
    // Effort is meaningless once thinking is switched off.
    if (effort && thinking !== "disabled") body.reasoning_effort = effort;
    return body;
  },
  droppable: BASE_DROPPABLE,
};

const deepseek = adapterFrom(
  {
    id: "deepseek",
    label: "DeepSeek",
    category: "cloud",
    description:
      "DeepSeek 官方 API（api.deepseek.com）。V4 系列 1M context、價格低，適合長篇仿單萃取；只支援 json_object（無 json_schema），不提供 embedding。",
    roles: ["analysis"],
    baseUrl: { default: DEEPSEEK_BASE_URL, fixed: true },
    keyRequired: true,
    keyHelp: "在 platform.deepseek.com → API keys 建立。餘額不足時會回 HTTP 402。",
    modelHelp: "deepseek-chat／deepseek-reasoner 已於 2026-07-24 停用，請改用 deepseek-flash 或 deepseek-v4-pro。",
    modelExamples: { analysis: ["deepseek-flash", "deepseek-v4-pro"] },
    canListModels: true,
    docsUrl: "https://api-docs.deepseek.com/api/create-chat-completion",
    params: [
      { ...TEMPERATURE_PARAM, help: `${TEMPERATURE_PARAM.help}思考模式下此參數無效（不會報錯，只是被忽略）。` },
      {
        key: "thinking",
        type: "select",
        label: "思考模式（thinking）",
        help: "預設開啟。開啟時輸出預算同時包含思考內容，萃取速度較慢；結構化萃取通常可關閉。以 thinking.type 送出。",
        roles: ["analysis"],
        group: "reasoning",
        options: [
          { value: "enabled", label: "開啟（enabled）" },
          { value: "disabled", label: "關閉（disabled）" },
        ],
        placeholder: "模型預設（開啟）",
      },
      {
        key: "reasoning_effort",
        type: "select",
        label: "推理強度（reasoning_effort）",
        help: "思考模式下的思考深度，預設 high。思考模式關閉時不會送出。",
        roles: ["analysis"],
        group: "reasoning",
        options: [
          { value: "none", label: "none" },
          { value: "low", label: "low" },
          { value: "high", label: "high" },
          { value: "max", label: "max" },
        ],
        placeholder: "模型預設（high）",
      },
    ],
  },
  deepseekOpts,
);

// ---------------------------------------------------------------------------
// xAI — https://docs.x.ai
// ---------------------------------------------------------------------------

export const XAI_BASE_URL = "https://api.x.ai/v1";

function isXaiNonReasoning(model: string): boolean {
  return /non-reasoning/i.test(model);
}

const xaiOpts: OpenAiCompatOptions = {
  root: () => XAI_BASE_URL,
  headers: bearer,
  // max_tokens is deprecated on xAI.
  tokenParam: () => "max_completion_tokens",
  extraBody: (p) => {
    // stop / presence_penalty / frequency_penalty are rejected by reasoning
    // models; we never send them.
    const effort = pStr(p.params, "reasoning_effort");
    return effort && !isXaiNonReasoning(p.model) ? { reasoning_effort: effort } : {};
  },
  droppable: BASE_DROPPABLE,
  filterModels: (ids) => ids.filter((id) => /^grok/i.test(id) && !/(image|imagine|video|embed)/i.test(id)),
};

const xai = adapterFrom(
  {
    id: "xai",
    label: "xAI Grok",
    category: "cloud",
    description: "xAI 官方 API（api.x.ai）。Grok 4.x 推理模型 context 達 500k–1M；推理無法關閉，需要快速回覆時請選 *-non-reasoning 模型。",
    roles: ["analysis"],
    baseUrl: { default: XAI_BASE_URL, fixed: true },
    keyRequired: true,
    keyHelp: "在 console.x.ai → API Keys 建立。",
    modelExamples: { analysis: ["grok-4.7", "grok-4.3", "grok-4.20-0309-non-reasoning"] },
    canListModels: true,
    docsUrl: "https://docs.x.ai/docs/guides/reasoning",
    params: [
      TEMPERATURE_PARAM,
      TOP_P_PARAM,
      {
        key: "reasoning_effort",
        type: "select",
        label: "推理強度（reasoning_effort）",
        help:
          "推理模型的思考深度，預設 high。xAI 推理模型無法關閉推理；不想要推理請改用 *-non-reasoning 模型（此時不送出本參數）。" +
          "xhigh 僅 grok-4.6 之後（grok-4.5 視為 high）；grok-4.20-multi-agent 以此值決定 4 或 16 個 agent。",
        roles: ["analysis"],
        group: "reasoning",
        options: [
          { value: "low", label: "low" },
          { value: "medium", label: "medium" },
          { value: "high", label: "high" },
          { value: "xhigh", label: "xhigh" },
        ],
        placeholder: "模型預設（high）",
        modelPattern: "^grok(?!.*non-reasoning)",
      },
    ],
  },
  xaiOpts,
);

// ---------------------------------------------------------------------------
// Groq — https://console.groq.com/docs
// ---------------------------------------------------------------------------

export const GROQ_BASE_URL = "https://api.groq.com/openai/v1";

const GROQ_GPT_OSS = /gpt-oss/i;
/** Models that emit reasoning text and accept reasoning_format. */
const GROQ_REASONING_FORMAT = /(qwen|minimax|deepseek)/i;

const groqOpts: OpenAiCompatOptions = {
  root: () => GROQ_BASE_URL,
  headers: bearer,
  // Groq's default output budget is only 1024 tokens, so the field must always
  // be present — buildChatBody always sets it from req.maxTokens.
  tokenParam: () => "max_completion_tokens",
  extraBody: (p, req) => {
    const body: Record<string, unknown> = {};
    const effort = pStr(p.params, "reasoning_effort");
    if (effort) body.reasoning_effort = effort;
    if (!GROQ_GPT_OSS.test(p.model)) {
      // "raw" (the documented default) + JSON mode is a 400, so JSON calls on
      // reasoning models fall back to "parsed" unless the operator chose.
      const fmt = pStr(p.params, "reasoning_format");
      if (fmt === "parsed" || fmt === "hidden") body.reasoning_format = fmt;
      else if (req.json && GROQ_REASONING_FORMAT.test(p.model)) body.reasoning_format = "parsed";
    }
    return body;
  },
  droppable: [...BASE_DROPPABLE, "reasoning_format"],
  filterModels: (ids) => ids.filter((id) => !/(whisper|tts|playai|orpheus|guard|distil)/i.test(id)),
};

const groq = adapterFrom(
  {
    id: "groq",
    label: "Groq",
    category: "cloud",
    description: "Groq LPU 推論服務，輸出速度極快；context 約 128k、單次輸出上限 16k–131k（依模型）。免費／開發方案的 TPM 可能小於一次 30k token 的仿單請求。",
    roles: ["analysis"],
    baseUrl: { default: GROQ_BASE_URL, fixed: true },
    keyRequired: true,
    keyHelp: "在 console.groq.com → API Keys 建立。",
    modelExamples: { analysis: ["openai/gpt-oss-120b", "qwen/qwen3.8-27b", "llama-3.3-70b-versatile"] },
    canListModels: true,
    docsUrl: "https://console.groq.com/docs/reasoning",
    params: [
      { ...TEMPERATURE_PARAM, help: `${TEMPERATURE_PARAM.help}Groq 建議推理模型用 0.5–0.7。` },
      TOP_P_PARAM,
      {
        key: "reasoning_effort",
        type: "select",
        label: "推理強度（reasoning_effort）",
        help:
          "可用值依模型而異，不支援的值會回 HTTP 400（系統會略過後重試）：gpt-oss 只接受 low／medium／high；" +
          "qwen3.8-27b 接受 none／default／low／medium／high（default 不回傳推理內容）。非推理模型請留空。",
        roles: ["analysis"],
        group: "reasoning",
        options: [
          { value: "none", label: "none（不推理，僅 qwen）" },
          { value: "default", label: "default（僅 qwen）" },
          { value: "low", label: "low" },
          { value: "medium", label: "medium" },
          { value: "high", label: "high" },
        ],
        placeholder: "模型預設",
      },
      {
        key: "reasoning_format",
        type: "select",
        label: "推理內容格式（reasoning_format）",
        help:
          "parsed：推理放在獨立欄位；hidden：不回傳推理。不提供 raw（推理混在內容中，與 JSON 模式併用會回 400）。" +
          "留空時，JSON 請求在推理模型上自動使用 parsed。gpt-oss 不支援此參數，不會送出。",
        roles: ["analysis"],
        group: "reasoning",
        options: [
          { value: "parsed", label: "parsed" },
          { value: "hidden", label: "hidden" },
        ],
        placeholder: "自動",
        modelPattern: "^(?!.*gpt-oss)",
      },
    ],
  },
  groqOpts,
);

// ---------------------------------------------------------------------------
// OpenRouter — https://openrouter.ai/docs
// ---------------------------------------------------------------------------

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/** Attribution only (rankings); not used for auth. */
const OPENROUTER_HEADERS = {
  "HTTP-Referer": "https://github.com/healthymind-tech/Taiwan-Health-MCP",
  "X-Title": "Taiwan Health MCP",
  "X-OpenRouter-Title": "Taiwan Health MCP",
};

/** provider:{…} routing object shared by chat and embeddings. */
function openRouterProvider(p: LlmProfile): Record<string, unknown> {
  const provider: Record<string, unknown> = {
    // Default true here (OpenRouter's own default is false): otherwise upstream
    // providers silently ignore knobs they don't support (response_format, effort…).
    require_parameters: pBool(p.params, "require_parameters") ?? true,
  };
  if (pBool(p.params, "zdr")) provider.zdr = true;
  return provider;
}

const openrouterOpts: OpenAiCompatOptions = {
  root: () => OPENROUTER_BASE_URL,
  headers: (p) => ({ ...bearer(p), ...OPENROUTER_HEADERS }),
  tokenParam: () => "max_tokens",
  extraBody: (p) => {
    const body: Record<string, unknown> = { provider: openRouterProvider(p) };
    const reasoning: Record<string, unknown> = {};
    const effort = pStr(p.params, "reasoning_effort");
    if (effort) reasoning.effort = effort;
    if (pBool(p.params, "reasoning_exclude")) reasoning.exclude = true;
    if (Object.keys(reasoning).length) body.reasoning = reasoning;
    return body;
  },
  droppable: [...BASE_DROPPABLE, "reasoning"],
  embeddings: {
    body: (p, req) => {
      const body: Record<string, unknown> = { dimensions: req.dimensions };
      if (pBool(p.params, "zdr")) body.provider = { zdr: true };
      return body;
    },
  },
};

const openrouterEmbeddingModels: OpenAiCompatOptions = { ...openrouterOpts, modelsPath: "/embeddings/models" };

const openrouter: ProviderAdapter = {
  spec: {
    id: "openrouter",
    label: "OpenRouter",
    category: "cloud",
    description:
      "OpenRouter 聚合閘道：一把金鑰呼叫數百個模型（OpenAI、Anthropic、Gemini、DeepSeek、Qwen…），也提供 embedding（Qwen3-Embedding、bge-m3 等）。適合想快速比較模型或需要多家容錯時選用。",
    roles: ["analysis", "embedding"],
    baseUrl: { default: OPENROUTER_BASE_URL, fixed: true },
    keyRequired: true,
    keyHelp: "在 openrouter.ai → Keys 建立。點數不足時回 HTTP 402。",
    modelHelp: "模型 id 格式為「廠商/模型」，例如 deepseek/deepseek-v4.1-flash。",
    modelExamples: {
      analysis: ["deepseek/deepseek-v4.1-flash", "openai/gpt-oss-120b", "qwen/qwen3.7-plus"],
      embedding: ["qwen/qwen3-embedding-8b", "baai/bge-m3", "intfloat/multilingual-e5-large"],
    },
    canListModels: true,
    docsUrl: "https://openrouter.ai/docs/api-reference/overview",
    params: [
      TEMPERATURE_PARAM,
      TOP_P_PARAM,
      {
        key: "reasoning_effort",
        type: "select",
        label: "推理強度（reasoning.effort）",
        help:
          "OpenRouter 統一的推理參數，會換算成各家模型的設定（約為輸出預算的 10%–95%）。none 關閉推理。" +
          "實際支援的值依模型而異（見 /models 的 supported_efforts）。",
        roles: ["analysis"],
        group: "reasoning",
        options: [
          { value: "none", label: "none（不推理）" },
          { value: "minimal", label: "minimal" },
          { value: "low", label: "low" },
          { value: "medium", label: "medium" },
          { value: "high", label: "high" },
          { value: "xhigh", label: "xhigh" },
          { value: "max", label: "max" },
        ],
        placeholder: "模型預設",
      },
      {
        key: "reasoning_exclude",
        type: "boolean",
        label: "不回傳推理內容（reasoning.exclude）",
        help: "只是不回傳，模型仍會推理且照樣計費。要省成本請把推理強度設為 none。",
        roles: ["analysis"],
        group: "reasoning",
      },
      {
        key: "require_parameters",
        type: "boolean",
        label: "只路由到支援全部參數的供應商（require_parameters）",
        help:
          "建議開啟（未設定時系統預設開啟）。關閉時，OpenRouter 可能把請求送到不支援 JSON 模式、推理強度等參數的上游，" +
          "這些參數會被「靜默忽略」而不報錯，導致輸出格式不穩定。",
        roles: ["analysis"],
        group: "advanced",
      },
      {
        key: "zdr",
        type: "boolean",
        label: "僅限零資料保留供應商（zdr）",
        help: "只路由到承諾不保存請求內容的供應商（Zero Data Retention）。處理醫療資料時強烈建議開啟；可選模型會變少。",
        roles: ["analysis", "embedding"],
        group: "advanced",
      },
    ],
  },
  chat: (p, req, ctx) => openAiCompatChat(p, req, ctx, openrouterOpts),
  embed: (p, req, ctx) => openAiCompatEmbed(p, req, ctx, openrouterOpts),
  listModels: (p, role, ctx) =>
    role === "embedding"
      ? openAiCompatModels(p, role, ctx, openrouterEmbeddingModels)
      : openAiCompatModels(p, role, ctx, openrouterOpts),
};

// ---------------------------------------------------------------------------
// Together AI — https://docs.together.ai
// ---------------------------------------------------------------------------

export const TOGETHER_BASE_URL = "https://api.together.xyz/v1";

const togetherOpts: OpenAiCompatOptions = {
  root: () => TOGETHER_BASE_URL,
  headers: bearer,
  tokenParam: () => "max_tokens",
  extraBody: (p) => {
    const body: Record<string, unknown> = {};
    const thinking = pStr(p.params, "thinking");
    if (thinking === "on" || thinking === "off") body.reasoning = { enabled: thinking === "on" };
    const effort = pStr(p.params, "reasoning_effort");
    if (effort && thinking !== "off") body.reasoning_effort = effort;
    return body;
  },
  droppable: [...BASE_DROPPABLE, "reasoning"],
  // Together also returns the non-standard "eos" — a normal stop, so it is
  // deliberately absent here.
  truncationReasons: ["length"],
};

/** Together's /models answers a bare array of {id, type}; tolerate {data:[…]} too. */
async function togetherModels(p: LlmProfile, role: Role, ctx: CallContext): Promise<string[]> {
  const json = (await getJson(ctx, `${TOGETHER_BASE_URL}/models`, bearer(p))) as unknown;
  const raw = (Array.isArray(json) ? json : ((json as Record<string, unknown>).data ?? [])) as Record<string, unknown>[];
  const wanted = role === "embedding" ? "embedding" : "chat";
  return raw
    .filter((m) => m && typeof m === "object" && (!m.type || String(m.type) === wanted))
    .map((m) => String(m.id ?? ""))
    .filter(Boolean)
    .sort();
}

const together: ProviderAdapter = {
  spec: {
    id: "together",
    label: "Together AI",
    category: "cloud",
    description:
      "Together AI serverless 開源模型（DeepSeek V4、Kimi K3、GLM-5、Qwen3.x、gpt-oss…）。serverless 已不提供 embedding 模型，請改用其他供應商。",
    roles: ["analysis"],
    baseUrl: { default: TOGETHER_BASE_URL, fixed: true },
    keyRequired: true,
    keyHelp: "在 api.together.ai → Settings → API Keys 建立。",
    modelExamples: { analysis: ["deepseek-ai/DeepSeek-V4.1-Flash", "moonshotai/Kimi-K3", "Qwen/Qwen3.7-Plus", "openai/gpt-oss-120b"] },
    canListModels: true,
    docsUrl: "https://docs.together.ai/reference/chat-completions-1",
    params: [
      TEMPERATURE_PARAM,
      TOP_P_PARAM,
      {
        key: "thinking",
        type: "select",
        label: "思考模式",
        help: "混合思考模型（GLM-5.x、DeepSeek V4、Qwen3.x…）是否先思考。以 reasoning.enabled 送出。結構化 JSON 萃取建議關閉（官方 JSON 範例即關閉）。",
        roles: ["analysis"],
        group: "reasoning",
        options: [
          { value: "off", label: "關閉" },
          { value: "on", label: "開啟" },
        ],
        placeholder: "模型預設",
      },
      {
        key: "reasoning_effort",
        type: "select",
        label: "推理強度（reasoning_effort）",
        help: "gpt-oss 等支援。DeepSeek-V4-Pro 只有 high／max 兩級（low、medium 視為 high）。思考模式關閉時不送出。",
        roles: ["analysis"],
        group: "reasoning",
        options: [
          { value: "low", label: "low" },
          { value: "medium", label: "medium" },
          { value: "high", label: "high" },
        ],
        placeholder: "模型預設",
      },
    ],
  },
  chat: (p, req, ctx) => openAiCompatChat(p, req, ctx, togetherOpts),
  listModels: togetherModels,
};

// ---------------------------------------------------------------------------
// Fireworks AI — https://docs.fireworks.ai
// ---------------------------------------------------------------------------

export const FIREWORKS_BASE_URL = "https://api.fireworks.ai/inference/v1";

/** Embedding models that accept `dimensions` (Matryoshka); others 400 "not resizable". */
const FIREWORKS_RESIZABLE = /(qwen3-embedding|nomic-embed-text-v1\.5)/i;

const fireworksOpts: OpenAiCompatOptions = {
  root: () => FIREWORKS_BASE_URL,
  headers: bearer,
  // Accepts max_completion_tokens as an alias, but sending both is an error.
  tokenParam: () => "max_tokens",
  // Without a JSON request in the prompt the model may emit whitespace until
  // the budget runs out.
  jsonNeedsKeyword: true,
  extraBody: (p) => {
    // Fireworks' default ("truncate") silently LOWERS max_tokens when prompt +
    // max_tokens exceed the context window. For a 30k-token insert that would
    // turn into a mysteriously short, truncated JSON reply; "error" makes it
    // fail loudly like OpenAI so the client can react. Never droppable.
    const body: Record<string, unknown> = { context_length_exceeded_behavior: "error" };
    const effort = pStr(p.params, "reasoning_effort");
    if (effort) body.reasoning_effort = effort;
    return body;
  },
  droppable: BASE_DROPPABLE,
  embeddings: {
    body: (p, req) => (FIREWORKS_RESIZABLE.test(p.model) ? { dimensions: req.dimensions } : {}),
    batchLimit: 2048,
  },
  filterModels: (ids, role) => byEmbeddingName(ids, role),
};

const fireworks = adapterFrom(
  {
    id: "fireworks",
    label: "Fireworks AI",
    category: "cloud",
    description: "Fireworks AI serverless 開源模型推論（DeepSeek、Kimi、GLM、Qwen、gpt-oss…），也提供 embedding（qwen3-embedding-8b 可指定維度）。",
    roles: ["analysis", "embedding"],
    baseUrl: { default: FIREWORKS_BASE_URL, fixed: true },
    keyRequired: true,
    keyHelp: "在 app.fireworks.ai → Settings → API Keys 建立。",
    modelHelp: "對話模型 id 格式為 accounts/fireworks/models/<名稱>。",
    modelExamples: {
      analysis: ["accounts/fireworks/models/kimi-k2p5", "accounts/fireworks/models/gpt-oss-120b"],
      embedding: ["fireworks/qwen3-embedding-8b", "thenlper/gte-large", "mixedbread-ai/mxbai-embed-large-v1"],
    },
    canListModels: true,
    docsUrl: "https://docs.fireworks.ai/api-reference/post-chatcompletions",
    params: [
      TEMPERATURE_PARAM,
      TOP_P_PARAM,
      {
        key: "reasoning_effort",
        type: "select",
        label: "推理強度（reasoning_effort）",
        help:
          "可用值依模型而異：gpt-oss 只接受 low／medium／high（不能 none）；MiniMax M2 推理無法關閉；" +
          "DeepSeek V4／V4.1、Kimi K3、GLM 5.2 會把值對應到自己的級距。none 關閉推理（支援的模型）。被拒絕時系統會略過後重試。",
        roles: ["analysis"],
        group: "reasoning",
        options: [
          { value: "none", label: "none（不推理）" },
          { value: "low", label: "low" },
          { value: "medium", label: "medium" },
          { value: "high", label: "high" },
          { value: "xhigh", label: "xhigh" },
          { value: "max", label: "max" },
        ],
        placeholder: "模型預設",
      },
    ],
    embeddingBatchLimit: 2048,
  },
  fireworksOpts,
  true,
);

export const ADAPTERS: ProviderAdapter[] = [deepseek, xai, groq, openrouter, together, fireworks];
