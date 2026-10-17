/**
 * China / Asia-hosted model platforms. All speak the OpenAI chat format with
 * vendor-specific thinking switches, token-budget semantics and JSON rules.
 *
 * - siliconflow: SiliconFlow (api.siliconflow.com / .cn) — chat + Qwen3-Embedding.
 * - dashscope:   Alibaba Cloud Model Studio (Qwen) compatible-mode — chat + text-embedding-v4.
 * - moonshot:    Moonshot Kimi — chat only; current models fix temperature / top_p.
 * - zhipu:       Zhipu GLM / Z.ai — chat + embedding-3 (base already ends in /v4).
 * - volcengine:  Volcengine Ark / BytePlus ModelArk (Doubao) — chat only.
 * - minimax:     MiniMax — chat only, no response_format.
 *
 * Docs: https://docs.siliconflow.com , https://www.alibabacloud.com/help/en/model-studio ,
 * https://platform.kimi.ai/docs/api/chat , https://docs.bigmodel.cn , https://docs.z.ai ,
 * https://www.volcengine.com/docs/82379 , https://platform.minimax.io/docs
 */

import type { LlmProfile } from "../admin/llmProfiles.js";
import { ensureV1, getJson, pNum, pStr, TEMPERATURE_PARAM, TOP_P_PARAM, trimSlash } from "./common.js";
import {
  bearer,
  byEmbeddingName,
  openAiCompatChat,
  openAiCompatEmbed,
  openAiCompatModels,
  type OpenAiCompatOptions,
} from "./openaiCompat.js";
import type { CallContext, ParamSpec, ProviderAdapter, Role } from "./types.js";

// ── Local helpers ───────────────────────────────────────────────────────────

/** True when the profile's model matches a ParamSpec.modelPattern (no pattern = always). */
function modelMatches(profile: LlmProfile, pattern: string | undefined): boolean {
  return !pattern || new RegExp(pattern, "i").test(profile.model);
}

/** Base URL from the profile, or the provider default when left blank. */
function baseOr(profile: LlmProfile, fallback: string): string {
  const u = trimSlash((profile.base_url ?? "").trim());
  return u || fallback;
}

/** Drop a pasted endpoint suffix so the root serves both chat and embeddings. */
function stripEndpoint(url: string): string {
  return trimSlash(url).replace(/\/(chat\/completions|embeddings|completions|models)$/i, "");
}

/** "on" / "off" select → boolean; anything else (blank, "default") → not sent. */
function onOff(profile: LlmProfile, key: string): boolean | undefined {
  const v = pStr(profile.params, key)?.toLowerCase();
  if (v === "on" || v === "true" || v === "enabled") return true;
  if (v === "off" || v === "false" || v === "disabled") return false;
  return undefined;
}

/** Copy numeric params that are set (and allowed for this model) into the body. */
function copyNums(profile: LlmProfile, specs: ParamSpec[], body: Record<string, unknown>): void {
  for (const spec of specs) {
    if (!modelMatches(profile, spec.modelPattern)) continue;
    const v = pNum(profile.params, spec.key);
    if (v !== undefined) body[spec.key] = v;
  }
}

const ON_OFF_OPTIONS = [
  { value: "on", label: "開啟" },
  { value: "off", label: "關閉" },
];

const TRANSIENT_RE = /fetch failed|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|UND_ERR_SOCKET|socket hang up|timeout|timed out/i;

function isTransientNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const cause = (err as Error & { cause?: { code?: unknown; message?: unknown } }).cause;
  const text = `${err.name} ${err.message} ${String(cause?.code ?? "")} ${String(cause?.message ?? "")}`;
  return TRANSIENT_RE.test(text);
}

/**
 * Retry a thrown network failure (not an HTTP error reply) up to `retries`
 * times with 100/200/400 ms backoff — SiliconFlow's embedding endpoint drops
 * connections under load, and the pre-registry client retried the same way.
 */
export function withTransientRetry(ctx: CallContext, retries = 3, baseDelayMs = 100): CallContext {
  return {
    fetch: async (url, init) => {
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await ctx.fetch(url, init);
        } catch (err) {
          if (attempt >= retries || !isTransientNetworkError(err)) throw err;
          await new Promise((resolve) => setTimeout(resolve, baseDelayMs * 2 ** attempt));
        }
      }
    },
  };
}

// ── SiliconFlow ─────────────────────────────────────────────────────────────

export const SILICONFLOW_INTL = "https://api.siliconflow.com/v1";
export const SILICONFLOW_CN = "https://api.siliconflow.cn/v1";

/** Accepts legacy stored URLs ending in /embeddings or /chat/completions. */
export function siliconflowRoot(profile: LlmProfile): string {
  return ensureV1(stripEndpoint(baseOr(profile, SILICONFLOW_INTL)));
}

const SF_THINKING: ParamSpec = {
  key: "enable_thinking",
  type: "select",
  label: "思考模式（enable_thinking）",
  help: "混合思考模型（Qwen3、GLM、DeepSeek-V3.1 之後等）是否先思考再回答。結構化萃取建議關閉，可大幅縮短時間。純推理模型會忽略。",
  roles: ["analysis"],
  group: "reasoning",
  options: ON_OFF_OPTIONS,
  placeholder: "模型預設",
};

const SF_BUDGET: ParamSpec = {
  key: "thinking_budget",
  type: "integer",
  label: "思考預算（thinking_budget）",
  help: "思考鏈最多可用的 token 數（128–32768）。Qwen3 原生支援；其他推理模型可能超過預算仍繼續思考。SiliconFlow 的 max_tokens 不含思考鏈。",
  roles: ["analysis"],
  group: "reasoning",
  min: 128,
  max: 32768,
  step: 128,
  placeholder: "模型預設",
};

const SF_EFFORT: ParamSpec = {
  key: "reasoning_effort",
  type: "select",
  label: "推理強度（reasoning_effort）",
  help: "僅 DeepSeek-V4、GLM-5.2 之後的模型。low／medium 會被視為 high，xhigh 視為 max。",
  roles: ["analysis"],
  group: "reasoning",
  options: [
    { value: "high", label: "high" },
    { value: "max", label: "max" },
  ],
  placeholder: "模型預設（high）",
  modelPattern: "deepseek-v4|glm-5\\.[2-9]|glm-[6-9]",
};

const SF_TOP_K: ParamSpec = {
  key: "top_k",
  type: "integer",
  label: "Top-k",
  help: "只從機率最高的 k 個 token 取樣（上限 100）。留空使用模型預設。",
  roles: ["analysis"],
  group: "generation",
  min: 1,
  max: 100,
  placeholder: "模型預設",
};

const SF_MIN_P: ParamSpec = {
  key: "min_p",
  type: "number",
  label: "Min-p",
  help: "僅 Qwen3 系列。過濾機率低於最高者 × min_p 的 token，Qwen 建議 0。",
  roles: ["analysis"],
  group: "generation",
  min: 0,
  max: 1,
  step: 0.01,
  placeholder: "模型預設",
  modelPattern: "qwen3",
};

const SF_PARAMS: ParamSpec[] = [TEMPERATURE_PARAM, TOP_P_PARAM, SF_TOP_K, SF_MIN_P, SF_THINKING, SF_BUDGET, SF_EFFORT];

/** Qwen3-Embedding sizes; bge / bce models are fixed-size and reject `dimensions`. */
const SF_DIM_MODEL = /qwen3-embedding/i;

const siliconflowOpts: OpenAiCompatOptions = {
  root: siliconflowRoot,
  headers: bearer,
  tokenParam: () => "max_tokens",
  jsonNeedsKeyword: true,
  extraBody: (p) => {
    const body: Record<string, unknown> = {};
    copyNums(p, [SF_TOP_K, SF_MIN_P, SF_BUDGET], body);
    const thinking = onOff(p, "enable_thinking");
    if (thinking !== undefined) body.enable_thinking = thinking;
    if (thinking === false) delete body.thinking_budget;
    const effort = pStr(p.params, "reasoning_effort");
    if (effort && modelMatches(p, SF_EFFORT.modelPattern) && thinking !== false) body.reasoning_effort = effort;
    return body;
  },
  embeddings: {
    body: (p, req) => (SF_DIM_MODEL.test(p.model) ? { dimensions: req.dimensions } : {}),
    batchLimit: 32,
  },
};

function siliconflowModelsOpts(role: Role): OpenAiCompatOptions {
  return {
    ...siliconflowOpts,
    modelsPath: `/models?type=text&sub_type=${role === "embedding" ? "embedding" : "chat"}`,
  };
}

export const siliconflow: ProviderAdapter = {
  spec: {
    id: "siliconflow",
    label: "SiliconFlow 矽基流動",
    category: "asia",
    description:
      "SiliconFlow 託管的開源模型（Qwen、DeepSeek、GLM、Kimi 等）與 Qwen3-Embedding，按量計費、價格低。想用開源模型但不想自架 GPU 時選它。國際站（siliconflow.com）與中國站（siliconflow.cn）帳號分開。",
    roles: ["analysis", "embedding"],
    baseUrl: {
      default: SILICONFLOW_INTL,
      options: [
        { value: SILICONFLOW_INTL, label: "國際站（api.siliconflow.com）" },
        { value: SILICONFLOW_CN, label: "中國站（api.siliconflow.cn）" },
      ],
      help: "請選與 API 金鑰同一站的網址。舊設定結尾帶 /embeddings 或 /chat/completions 也可以，系統會自動去掉。",
    },
    keyRequired: true,
    keyHelp: "在 cloud.siliconflow.com（國際站）或 cloud.siliconflow.cn（中國站）→ API 金鑰建立；兩站金鑰不互通。",
    modelHelp: "填完整模型 id（含組織前綴，如 Qwen/Qwen3-32B）。可按「列出模型」從帳號取得清單。",
    modelExamples: {
      analysis: ["Qwen/Qwen3-32B", "deepseek-ai/DeepSeek-V3.2", "zai-org/GLM-4.6"],
      embedding: ["Qwen/Qwen3-Embedding-8B", "Qwen/Qwen3-Embedding-4B", "Qwen/Qwen3-Embedding-0.6B", "BAAI/bge-m3"],
    },
    canListModels: true,
    docsUrl: "https://docs.siliconflow.com/en/api-reference/chat-completions/chat-completions",
    params: SF_PARAMS,
    embeddingBatchLimit: 32,
  },
  chat: (p, req, ctx) => openAiCompatChat(p, req, ctx, siliconflowOpts),
  embed: (p, req, ctx) => openAiCompatEmbed(p, req, withTransientRetry(ctx), siliconflowOpts),
  listModels: (p, role, ctx) => openAiCompatModels(p, role, ctx, siliconflowModelsOpts(role)),
};

// ── Alibaba Cloud Model Studio / DashScope ──────────────────────────────────

export const DASHSCOPE_INTL = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
export const DASHSCOPE_CN = "https://dashscope.aliyuncs.com/compatible-mode/v1";
export const DASHSCOPE_HK = "https://cn-hongkong.dashscope.aliyuncs.com/compatible-mode/v1";

/** `<host>/compatible-mode/v1` from a host, a native `/api/v1` URL or a full endpoint URL. */
export function dashscopeRoot(profile: LlmProfile): string {
  let u = stripEndpoint(baseOr(profile, DASHSCOPE_INTL));
  if (/\/compatible-mode\/v1$/i.test(u)) return u;
  u = u.replace(/\/(compatible-mode|api\/v1|api)$/i, "");
  return `${u}/compatible-mode/v1`;
}

const DS_THINKING: ParamSpec = {
  key: "enable_thinking",
  type: "select",
  label: "思考模式（enable_thinking）",
  help:
    "混合思考模型是否先思考。Qwen3.5 之後多數預設開啟，qwen-plus／qwen-flash 預設關閉；純思考模型無法關閉。" +
    "結構化萃取建議關閉：思考模式下 JSON 模式不會報錯，但輸出可能不是合法 JSON。部分開源模型只在串流時支援思考，非串流呼叫會回錯誤。",
  roles: ["analysis"],
  group: "reasoning",
  options: ON_OFF_OPTIONS,
  placeholder: "模型預設",
};

const DS_BUDGET: ParamSpec = {
  key: "thinking_budget",
  type: "integer",
  label: "思考預算（thinking_budget）",
  help: "思考鏈最多可用的 token 數。Qwen3.x、GLM、Kimi K2.x 支援；kimi-k3 不支援。",
  roles: ["analysis"],
  group: "reasoning",
  min: 1,
  max: 32768,
  step: 256,
  placeholder: "模型預設",
};

const DS_TOP_K: ParamSpec = {
  key: "top_k",
  type: "integer",
  label: "Top-k",
  help: "只從機率最高的 k 個 token 取樣（大於 100 等於停用）。百煉上的 DeepSeek、Kimi、MiniMax 模型不支援，被拒時會自動略過。",
  roles: ["analysis"],
  group: "generation",
  min: 1,
  max: 100,
  placeholder: "模型預設",
};

const DS_PARAMS: ParamSpec[] = [
  { ...TEMPERATURE_PARAM, max: 1.99, help: `${TEMPERATURE_PARAM.help}百煉範圍為 [0, 2)，不建議設為 0。` },
  TOP_P_PARAM,
  DS_TOP_K,
  DS_THINKING,
  DS_BUDGET,
];

/** text-embedding-v3/v4 accept `dimensions` in compatible mode. */
const DS_DIM_MODEL = /text-embedding-v[34]/i;

const dashscopeOpts: OpenAiCompatOptions = {
  root: dashscopeRoot,
  headers: bearer,
  // Recommended field: covers thinking + answer (max_tokens is deprecated and model-dependent).
  tokenParam: () => "max_completion_tokens",
  jsonNeedsKeyword: true,
  extraBody: (p) => {
    const body: Record<string, unknown> = {};
    copyNums(p, [DS_TOP_K], body);
    const thinking = onOff(p, "enable_thinking");
    if (thinking !== undefined) body.enable_thinking = thinking;
    const budget = pNum(p.params, "thinking_budget");
    if (budget !== undefined && thinking !== false && !/kimi-k3/i.test(p.model)) body.thinking_budget = budget;
    return body;
  },
  droppable: ["temperature", "top_p", "top_k", "enable_thinking", "thinking_budget", "response_format"],
  embeddings: {
    body: (p, req) => (DS_DIM_MODEL.test(p.model) ? { dimensions: req.dimensions } : {}),
    batchLimit: 10,
  },
};

/**
 * Model list from the native catalogue (`<host>/api/v1/models`, paged
 * `output.models[]`) — the compatible-mode `/models` is not documented.
 */
async function dashscopeModels(p: LlmProfile, role: Role, ctx: CallContext): Promise<string[]> {
  const host = dashscopeRoot(p).replace(/\/compatible-mode\/v1$/i, "");
  const pageSize = 100;
  const ids = new Set<string>();
  for (let page = 1; page <= 20; page += 1) {
    const json = await getJson(ctx, `${host}/api/v1/models?page_no=${page}&page_size=${pageSize}`, bearer(p));
    const output = (json.output ?? json) as Record<string, unknown>;
    const models = ((output.models ?? json.data ?? []) as Record<string, unknown>[]).filter((m) => m && typeof m === "object");
    for (const m of models) {
      const id = String(m.model ?? m.id ?? m.name ?? "");
      if (!id) continue;
      const caps = (Array.isArray(m.capabilities) ? m.capabilities : []).map((c) => String(c).toUpperCase());
      const isEmbedding = /embedding/i.test(id);
      if (role === "embedding") {
        if (isEmbedding && !/multimodal|vision|vl-/i.test(id)) ids.add(id);
      } else if (
        !isEmbedding &&
        !/rerank|tts|asr|image|wanx|wan\d|video|audio|realtime|omni|ocr|mt-/i.test(id) &&
        (caps.length === 0 || caps.includes("TG") || caps.includes("REASONING"))
      ) {
        ids.add(id);
      }
    }
    if (models.length < pageSize) break;
  }
  return [...ids].sort();
}

export const dashscope: ProviderAdapter = {
  spec: {
    id: "dashscope",
    label: "阿里雲百煉（Qwen／DashScope）",
    category: "asia",
    description:
      "阿里雲 Model Studio（百煉）的 OpenAI 相容模式：Qwen 官方模型（對中文長文件表現好）與 text-embedding-v4。想直接用 Qwen 最新官方版本時選它。",
    roles: ["analysis", "embedding"],
    baseUrl: {
      default: DASHSCOPE_INTL,
      options: [
        { value: DASHSCOPE_INTL, label: "國際（新加坡）" },
        { value: DASHSCOPE_CN, label: "中國（北京）" },
        { value: DASHSCOPE_HK, label: "香港" },
      ],
      placeholder: "https://<WorkspaceId>.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
      help:
        "API 金鑰綁定地區，選錯地區會回 401。阿里雲現在建議使用工作空間專屬網域 https://<WorkspaceId>.<地區>.maas.aliyuncs.com" +
        "（地區如 ap-southeast-1、cn-beijing、us-east-1 美國維吉尼亞、ap-northeast-1、eu-central-1）；美國等地區只有這種網域。" +
        "只填主機也可以，系統會補上 /compatible-mode/v1。",
    },
    keyRequired: true,
    keyHelp: "在 Model Studio 主控台 → API Key 建立，並確認金鑰與上方網址屬於同一地區。",
    modelHelp:
      "輸出預算以 max_completion_tokens 送出（含思考鏈）。非串流呼叫超過約 300 秒會被截斷，長仿單建議關閉思考或選較快的模型。",
    modelExamples: {
      analysis: ["qwen-plus", "qwen-flash", "qwen3-max", "qwen3.7-plus"],
      embedding: ["text-embedding-v4", "text-embedding-v3"],
    },
    canListModels: true,
    docsUrl: "https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-openai-chat-completions",
    params: DS_PARAMS,
    embeddingBatchLimit: 10,
  },
  chat: (p, req, ctx) => openAiCompatChat(p, req, ctx, dashscopeOpts),
  embed: (p, req, ctx) => openAiCompatEmbed(p, req, ctx, dashscopeOpts),
  listModels: dashscopeModels,
};

// ── Moonshot Kimi ───────────────────────────────────────────────────────────

export const MOONSHOT_INTL = "https://api.moonshot.ai/v1";
export const MOONSHOT_CN = "https://api.moonshot.cn/v1";

/** kimi-k2.6 / k2.7 / k3 and later fix temperature, top_p, n and penalties. */
export function kimiFixedSampling(model: string): boolean {
  return /^kimi-k(2\.[6-9]|[3-9])/i.test(model.trim());
}

const KIMI_THINKING: ParamSpec = {
  key: "thinking",
  type: "select",
  label: "思考模式（thinking）",
  help: "僅 kimi-k2.6 可切換（預設開啟）。kimi-k2.7-code 一律思考，kimi-k3 請改用推理強度。結構化萃取建議關閉。",
  roles: ["analysis"],
  group: "reasoning",
  options: ON_OFF_OPTIONS,
  placeholder: "模型預設（開啟）",
  modelPattern: "^kimi-k2\\.6",
};

const KIMI_EFFORT: ParamSpec = {
  key: "reasoning_effort",
  type: "select",
  label: "推理強度（reasoning_effort）",
  help: "僅 kimi-k3（一律推理，預設 max）。low 最快、最省輸出預算。",
  roles: ["analysis"],
  group: "reasoning",
  options: [
    { value: "low", label: "low" },
    { value: "high", label: "high" },
    { value: "max", label: "max" },
  ],
  placeholder: "模型預設（max）",
  modelPattern: "^kimi-k3",
};

const moonshotOpts: OpenAiCompatOptions = {
  root: (p) => ensureV1(stripEndpoint(baseOr(p, MOONSHOT_INTL))),
  headers: bearer,
  tokenParam: () => "max_completion_tokens",
  jsonNeedsKeyword: true,
  sendSampling: (p) => !kimiFixedSampling(p.model),
  extraBody: (p) => {
    const body: Record<string, unknown> = {};
    const thinking = onOff(p, "thinking");
    if (thinking !== undefined && modelMatches(p, KIMI_THINKING.modelPattern)) {
      body.thinking = { type: thinking ? "enabled" : "disabled" };
    }
    const effort = pStr(p.params, "reasoning_effort");
    if (effort && modelMatches(p, KIMI_EFFORT.modelPattern)) body.reasoning_effort = effort;
    return body;
  },
};

export const moonshot: ProviderAdapter = {
  spec: {
    id: "moonshot",
    label: "Moonshot Kimi",
    category: "asia",
    description:
      "月之暗面 Kimi 官方 API，長上下文（kimi-k3 達 1M token），適合超長仿單。不提供嵌入模型。現行模型的 temperature／top_p 固定，系統不會送出取樣參數。",
    roles: ["analysis"],
    baseUrl: {
      default: MOONSHOT_INTL,
      options: [
        { value: MOONSHOT_INTL, label: "國際（api.moonshot.ai）" },
        { value: MOONSHOT_CN, label: "中國（api.moonshot.cn）" },
      ],
      help: "請選與 API 金鑰同一平台的網址；兩個平台帳號與金鑰分開。",
    },
    keyRequired: true,
    keyHelp: "在 platform.kimi.ai（國際）或 platform.kimi.com（中國）→ API Keys 建立。",
    modelHelp: "輸出預算以 max_completion_tokens 送出（含思考）。輸入加輸出超過上下文長度會直接回錯誤。",
    modelExamples: { analysis: ["kimi-k3", "kimi-k2.6", "kimi-k2.7-code"] },
    canListModels: true,
    docsUrl: "https://platform.kimi.ai/docs/api/chat",
    params: [KIMI_THINKING, KIMI_EFFORT],
  },
  chat: (p, req, ctx) => openAiCompatChat(p, req, ctx, moonshotOpts),
  listModels: (p, role, ctx) =>
    openAiCompatModels(p, role, ctx, { ...moonshotOpts, filterModels: (ids) => byEmbeddingName(ids, "analysis") }),
};

// ── Zhipu GLM / Z.ai ────────────────────────────────────────────────────────

export const ZHIPU_INTL = "https://api.z.ai/api/paas/v4";
export const ZHIPU_CN = "https://open.bigmodel.cn/api/paas/v4";

/** The API root already ends in /v4 — never append /v1. */
export function zhipuRoot(profile: LlmProfile): string {
  const u = stripEndpoint(baseOr(profile, ZHIPU_INTL));
  if (/\/v\d+$/i.test(u)) return u;
  if (/\/paas$/i.test(u)) return `${u}/v4`;
  if (/\/api$/i.test(u)) return `${u}/paas/v4`;
  return `${u}/api/paas/v4`;
}

const ZHIPU_MAX_TOKENS = 131072;

const GLM_THINKING: ParamSpec = {
  key: "thinking",
  type: "select",
  label: "思考模式（thinking）",
  help: "GLM-4.5 之後預設開啟。結構化萃取建議關閉。GLM-5.3 系列無法關閉思考，請改用推理強度。",
  roles: ["analysis"],
  group: "reasoning",
  options: ON_OFF_OPTIONS,
  placeholder: "模型預設（開啟）",
};

const GLM_EFFORT: ParamSpec = {
  key: "reasoning_effort",
  type: "select",
  label: "推理強度（reasoning_effort）",
  help: "GLM-5.2 之後可用，預設 max。GLM-5.3 只接受 low／high／max；GLM-5.2 的 none／minimal 等於不思考。",
  roles: ["analysis"],
  group: "reasoning",
  options: [
    { value: "none", label: "none（不思考）" },
    { value: "minimal", label: "minimal" },
    { value: "low", label: "low" },
    { value: "medium", label: "medium" },
    { value: "high", label: "high" },
    { value: "xhigh", label: "xhigh" },
    { value: "max", label: "max" },
  ],
  placeholder: "模型預設（max）",
  modelPattern: "glm-5\\.[2-9]|glm-[6-9]",
};

const zhipuOpts: OpenAiCompatOptions = {
  root: zhipuRoot,
  headers: bearer,
  tokenParam: () => "max_tokens",
  extraBody: (p, req) => {
    const body: Record<string, unknown> = { max_tokens: Math.min(req.maxTokens, ZHIPU_MAX_TOKENS) };
    const thinking = onOff(p, "thinking");
    if (thinking !== undefined) body.thinking = { type: thinking ? "enabled" : "disabled" };
    const effort = pStr(p.params, "reasoning_effort");
    if (effort && modelMatches(p, GLM_EFFORT.modelPattern)) body.reasoning_effort = effort;
    return body;
  },
  truncationReasons: ["length", "model_context_window_exceeded"],
  embeddings: {
    // embedding-3: 256/512/1024/2048; embedding-2 is fixed at 1024.
    body: (p, req) => (/embedding-3/i.test(p.model) ? { dimensions: req.dimensions } : {}),
    batchLimit: 64,
  },
};

export const zhipu: ProviderAdapter = {
  spec: {
    id: "zhipu",
    label: "智譜 GLM（Z.ai）",
    category: "asia",
    description:
      "智譜 GLM 官方 API（國際站 Z.ai、中國站 bigmodel.cn），GLM 系列中文理解佳，並提供 embedding-3 嵌入模型。想用 GLM 官方版本時選它。",
    roles: ["analysis", "embedding"],
    baseUrl: {
      default: ZHIPU_INTL,
      options: [
        { value: ZHIPU_INTL, label: "國際（Z.ai）" },
        { value: ZHIPU_CN, label: "中國（open.bigmodel.cn）" },
      ],
      help: "網址本身已含 /api/paas/v4，不要再加 /v1。兩站帳號與金鑰分開。嵌入模型 embedding-3 目前僅確認中國站提供。",
    },
    keyRequired: true,
    keyHelp: "在 z.ai（國際）或 open.bigmodel.cn（中國）→ API Keys 建立。",
    modelHelp: "智譜沒有列出模型的 API，請手動輸入模型 id。",
    modelExamples: {
      analysis: ["glm-5.3", "glm-5.2", "glm-4.7", "glm-4.5-air"],
      embedding: ["embedding-3", "embedding-2"],
    },
    canListModels: false,
    docsUrl: "https://docs.z.ai/api-reference/llm/chat-completion",
    params: [
      { ...TEMPERATURE_PARAM, max: 1, help: `${TEMPERATURE_PARAM.help}智譜範圍為 0–1。` },
      TOP_P_PARAM,
      GLM_THINKING,
      GLM_EFFORT,
    ],
    embeddingBatchLimit: 64,
  },
  chat: (p, req, ctx) => openAiCompatChat(p, req, ctx, zhipuOpts),
  embed: (p, req, ctx) => openAiCompatEmbed(p, req, ctx, zhipuOpts),
};

// ── Volcengine Ark / BytePlus ModelArk ─────────────────────────────────────

export const ARK_CN = "https://ark.cn-beijing.volces.com/api/v3";
export const ARK_INTL = "https://ark.ap-southeast.bytepluses.com/api/v3";

export function arkRoot(profile: LlmProfile): string {
  const u = stripEndpoint(baseOr(profile, ARK_CN));
  if (/\/v\d+$/i.test(u)) return u;
  return /\/api$/i.test(u) ? `${u}/v3` : `${u}/api/v3`;
}

const ARK_THINKING: ParamSpec = {
  key: "thinking",
  type: "select",
  label: "思考模式（thinking）",
  help: "enabled 先思考、disabled 直接回答、auto 由模型自行判斷（僅部分模型支援 auto）。結構化萃取建議 disabled。",
  roles: ["analysis"],
  group: "reasoning",
  options: [
    { value: "enabled", label: "開啟（enabled）" },
    { value: "disabled", label: "關閉（disabled）" },
    { value: "auto", label: "自動（auto）" },
  ],
  placeholder: "模型預設",
};

const ARK_EFFORT: ParamSpec = {
  key: "reasoning_effort",
  type: "select",
  label: "推理強度（reasoning_effort）",
  help: "思考深度。思考模式設為 disabled 時不會送出（兩者同時送會回錯誤）。",
  roles: ["analysis"],
  group: "reasoning",
  options: ["none", "minimal", "low", "medium", "high", "xhigh", "max"].map((v) => ({ value: v, label: v })),
  placeholder: "模型預設",
};

/** doubao-seed-2-0-pro/lite fix temperature at 1. */
function arkFixedSampling(model: string): boolean {
  return /doubao-seed-2-0-(pro|lite)/i.test(model);
}

const arkOpts: OpenAiCompatOptions = {
  root: arkRoot,
  headers: bearer,
  // Only ever one of the two token fields — Ark rejects both together (swap removes the old one).
  tokenParam: () => "max_tokens",
  sendSampling: (p) => !arkFixedSampling(p.model),
  extraBody: (p) => {
    const body: Record<string, unknown> = {};
    const thinking = pStr(p.params, "thinking")?.toLowerCase();
    if (thinking === "enabled" || thinking === "disabled" || thinking === "auto") body.thinking = { type: thinking };
    const effort = pStr(p.params, "reasoning_effort");
    if (effort && thinking !== "disabled") body.reasoning_effort = effort;
    return body;
  },
};

export const volcengine: ProviderAdapter = {
  spec: {
    id: "volcengine",
    label: "火山方舟／BytePlus ModelArk（豆包）",
    category: "asia",
    description:
      "字節跳動的模型平台：中國站為火山引擎方舟，國際站為 BytePlus ModelArk。提供豆包（Doubao Seed）與託管的 DeepSeek 等模型。想用豆包模型時選它。",
    roles: ["analysis"],
    baseUrl: {
      default: ARK_CN,
      options: [
        { value: ARK_CN, label: "火山方舟（中國・北京）" },
        { value: ARK_INTL, label: "BytePlus ModelArk（國際・東南亞）" },
      ],
      help: "請選與 API 金鑰同一平台的網址。只填主機也可以，系統會補上 /api/v3。",
    },
    keyRequired: true,
    keyHelp: "火山引擎方舟主控台或 BytePlus ModelArk 主控台 → API Key 管理建立。",
    modelLabel: "模型 ID／推論端點 ID",
    modelHelp:
      "可填模型 ID（如 doubao-seed-2-0-pro-260215，需先在主控台開通該模型），或自建推論端點的 ID（ep- 開頭）。" +
      "輸出預算以 max_tokens 送出，多數模型只計回答、不含思考鏈；未設定時平台預設僅 4096。",
    modelExamples: { analysis: ["doubao-seed-2-0-pro-260215", "doubao-seed-2-0-lite-260215", "ep-20260101000000-xxxxx"] },
    canListModels: false,
    docsUrl: "https://www.volcengine.com/docs/82379/1494384",
    params: [
      { ...TEMPERATURE_PARAM, help: `${TEMPERATURE_PARAM.help}doubao-seed-2-0-pro／lite 固定為 1，系統不會送出。` },
      { ...TOP_P_PARAM, help: `${TOP_P_PARAM.help}doubao-seed-2-0-pro／lite 不會送出。` },
      ARK_THINKING,
      ARK_EFFORT,
    ],
  },
  chat: (p, req, ctx) => openAiCompatChat(p, req, ctx, arkOpts),
};

// ── MiniMax ─────────────────────────────────────────────────────────────────

export const MINIMAX_INTL = "https://api.minimax.io/v1";
export const MINIMAX_CN = "https://api.minimaxi.com/v1";

const MINIMAX_THINKING: ParamSpec = {
  key: "thinking",
  type: "select",
  label: "思考模式（thinking）",
  help: "只有 MiniMax-M3 可以關閉思考；M2.x 一律思考（會忽略），M3.1 不接受此參數。",
  roles: ["analysis"],
  group: "reasoning",
  options: [{ value: "off", label: "關閉" }],
  placeholder: "模型預設（開啟）",
  modelPattern: "^minimax-m3$",
};

const MINIMAX_EFFORT: ParamSpec = {
  key: "reasoning_effort",
  type: "select",
  label: "推理強度（reasoning_effort）",
  help: "僅 MiniMax-M3.1。不接受 none。",
  roles: ["analysis"],
  group: "reasoning",
  options: [
    { value: "low", label: "low" },
    { value: "medium", label: "medium" },
    { value: "high", label: "high" },
  ],
  placeholder: "模型預設",
  modelPattern: "m3\\.1",
};

const minimaxOpts: OpenAiCompatOptions = {
  root: (p) => ensureV1(stripEndpoint(baseOr(p, MINIMAX_INTL))),
  headers: bearer,
  tokenParam: () => "max_completion_tokens",
  // response_format is undocumented — JSON relies on the prompt (fences are stripped).
  jsonMode: () => "none",
  extraBody: (p) => {
    // Reasoning goes to reasoning_content instead of an inline <think> block.
    const body: Record<string, unknown> = { reasoning_split: true };
    if (onOff(p, "thinking") === false && modelMatches(p, MINIMAX_THINKING.modelPattern)) body.thinking = { type: "disabled" };
    const effort = pStr(p.params, "reasoning_effort");
    if (effort && modelMatches(p, MINIMAX_EFFORT.modelPattern)) body.reasoning_effort = effort;
    return body;
  },
  droppable: ["temperature", "top_p", "thinking", "reasoning_effort", "reasoning_split"],
};

export const minimax: ProviderAdapter = {
  spec: {
    id: "minimax",
    label: "MiniMax",
    category: "asia",
    description:
      "MiniMax 官方 API（MiniMax-M3 等），長上下文。不提供強制 JSON 輸出（只靠提示詞），也不提供嵌入模型。",
    roles: ["analysis"],
    baseUrl: {
      default: MINIMAX_INTL,
      options: [
        { value: MINIMAX_INTL, label: "國際（api.minimax.io）" },
        { value: MINIMAX_CN, label: "中國（api.minimaxi.com）" },
      ],
      help: "請選與 API 金鑰同一平台的網址。",
    },
    keyRequired: true,
    keyHelp: "在 platform.minimax.io（國際）或 platform.minimaxi.com（中國）→ API Keys 建立。",
    modelHelp:
      "輸出預算包含思考 token：預算太小時可能只思考完就被截斷、回覆為空（系統會自動加大預算重試）。思考內容以 reasoning_split 分開回傳，不會混進 JSON。",
    modelExamples: { analysis: ["MiniMax-M3", "MiniMax-M2.7", "MiniMax-M2.5"] },
    canListModels: false,
    docsUrl: "https://platform.minimax.io/docs/api-reference/text-openai-api",
    params: [TEMPERATURE_PARAM, TOP_P_PARAM, MINIMAX_THINKING, MINIMAX_EFFORT],
  },
  chat: (p, req, ctx) => openAiCompatChat(p, req, ctx, minimaxOpts),
};

export const ADAPTERS: ProviderAdapter[] = [siliconflow, dashscope, moonshot, zhipu, volcengine, minimax];
