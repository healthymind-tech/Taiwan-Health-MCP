/**
 * Self-hosted endpoints.
 *
 * - `openai_compatible`: any server speaking the OpenAI /v1 format — vLLM,
 *   SGLang, llama.cpp llama-server, LM Studio, LiteLLM, TEI, Infinity… Extra
 *   sampling knobs are sent only when set; these servers ignore unknown fields.
 * - `ollama`: Ollama's native API (/api/chat, /api/embed). Native rather than
 *   its /v1 shim because only native can set the context window per request.
 *   Also covers Ollama Cloud (https://ollama.com, Bearer key).
 * Docs: https://docs.vllm.ai , https://docs.ollama.com/api
 */

import type { LlmProfile } from "../admin/llmProfiles.js";
import {
  detectTruncation,
  ensureV1,
  getJson,
  pBool,
  pNum,
  positive,
  postJson,
  pStr,
  stripJsonFence,
  TEMPERATURE_PARAM,
  TOP_P_PARAM,
  trimSlash,
} from "./common.js";
import {
  bearer,
  byEmbeddingName,
  openAiCompatChat,
  openAiCompatEmbed,
  openAiCompatModels,
  type OpenAiCompatOptions,
} from "./openaiCompat.js";
import type { CallContext, ChatRequest, ChatResult, EmbedRequest, ParamSpec, ProviderAdapter } from "./types.js";

const THINKING_ONOFF: ParamSpec = {
  key: "thinking",
  type: "select",
  label: "思考模式",
  help: "混合思考模型（Qwen3、DeepSeek-R1 蒸餾等）是否先思考再回答。以 chat_template_kwargs.enable_thinking 送出（vLLM、SGLang、llama.cpp 支援；LM Studio 會忽略）。結構化萃取建議關閉。",
  roles: ["analysis"],
  group: "reasoning",
  options: [
    { value: "off", label: "關閉" },
    { value: "on", label: "開啟" },
  ],
  placeholder: "模型預設",
};

const COMPAT_PARAMS: ParamSpec[] = [
  TEMPERATURE_PARAM,
  TOP_P_PARAM,
  { key: "top_k", type: "integer", label: "Top-k", help: "只從機率最高的 k 個 token 取樣。留空使用伺服器預設。", roles: ["analysis"], group: "generation", min: 1, max: 1000, placeholder: "伺服器預設" },
  { key: "min_p", type: "number", label: "Min-p", help: "過濾機率低於最高者 × min_p 的 token。Qwen 建議 0。", roles: ["analysis"], group: "generation", min: 0, max: 1, step: 0.01, placeholder: "伺服器預設" },
  { key: "repetition_penalty", type: "number", label: "重複懲罰（repetition_penalty）", help: "大於 1 抑制重複。小模型輸出迴圈時可設 1.05–1.1。llama.cpp 用 repeat_penalty，系統會一併送出。", roles: ["analysis"], group: "generation", min: 0.5, max: 2, step: 0.01, placeholder: "伺服器預設" },
  THINKING_ONOFF,
  {
    key: "json_mode",
    type: "select",
    label: "JSON 輸出模式",
    help: "json_object：請伺服器以 response_format 強制 JSON（vLLM、SGLang、llama.cpp 支援）。不支援時選「只靠提示詞」。",
    roles: ["analysis"],
    group: "advanced",
    options: [
      { value: "json_object", label: "response_format=json_object" },
      { value: "none", label: "只靠提示詞" },
    ],
    placeholder: "json_object",
  },
  {
    key: "send_dimensions",
    type: "boolean",
    label: "送出維度參數（dimensions）",
    help: "模型支援 Matryoshka（可截短維度）時才開啟，例如 Qwen3-Embedding。不支援的模型在 vLLM 上會回錯誤。關閉時伺服器回傳模型原生維度，必須等於上方設定的維度。",
    roles: ["embedding"],
    group: "embedding",
  },
  { key: "batch_size", type: "integer", label: "每批筆數上限", help: "單次請求最多送幾段文字。TEI 預設上限 32。留空不切分。", roles: ["embedding"], group: "embedding", min: 1, max: 4096, placeholder: "不限制" },
];

const compatOpts: OpenAiCompatOptions = {
  root: (p) => ensureV1(p.base_url),
  headers: bearer,
  jsonMode: (p) => (pStr(p.params, "json_mode") === "none" ? "none" : "json_object"),
  extraBody: (p) => {
    const body: Record<string, unknown> = {};
    const topK = pNum(p.params, "top_k");
    if (topK !== undefined) body.top_k = topK;
    const minP = pNum(p.params, "min_p");
    if (minP !== undefined) body.min_p = minP;
    const rep = pNum(p.params, "repetition_penalty");
    if (rep !== undefined) {
      body.repetition_penalty = rep;
      body.repeat_penalty = rep; // llama.cpp / LM Studio spelling
    }
    const thinking = pStr(p.params, "thinking");
    if (thinking === "on" || thinking === "off") body.chat_template_kwargs = { enable_thinking: thinking === "on" };
    return body;
  },
  // LiteLLM without drop_params is the one server that rejects unknown keys.
  droppable: ["top_k", "min_p", "repetition_penalty", "repeat_penalty", "chat_template_kwargs", "response_format", "temperature", "top_p"],
  embeddings: {
    body: (p, req) => (pBool(p.params, "send_dimensions") ? { dimensions: req.dimensions } : {}),
  },
  filterModels: (ids, role) => {
    const filtered = byEmbeddingName(ids, role);
    return filtered.length ? filtered : ids;
  },
};

export const openaiCompatible: ProviderAdapter = {
  spec: {
    id: "openai_compatible",
    label: "OpenAI-Compatible API",
    category: "selfhost",
    description: "自架或第三方、相容 OpenAI /v1 格式的服務：vLLM、SGLang、llama.cpp、LM Studio、LiteLLM、TEI、Infinity 等。",
    roles: ["analysis", "embedding"],
    baseUrl: { placeholder: "http://主機:8000/v1", help: "服務的 /v1 根網址；省略 /v1 時系統會補上。" },
    keyRequired: false,
    keyHelp: "伺服器有設定 API 金鑰（例如 vLLM --api-key）才需要填。",
    modelExamples: { analysis: ["Qwen/Qwen3-32B"], embedding: ["Qwen/Qwen3-Embedding-0.6B"] },
    canListModels: true,
    docsUrl: "https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html",
    params: COMPAT_PARAMS,
  },
  chat: (p, req, ctx) => openAiCompatChat(p, req, ctx, compatOpts),
  embed: (p, req, ctx) =>
    openAiCompatEmbed(p, req, ctx, {
      ...compatOpts,
      embeddings: { ...compatOpts.embeddings, batchLimit: pNum(p.params, "batch_size") },
    }),
  listModels: (p, role, ctx) => openAiCompatModels(p, role, ctx, compatOpts),
};

// ── Ollama (native) ─────────────────────────────────────────────────────────

const OLLAMA_PARAMS: ParamSpec[] = [
  TEMPERATURE_PARAM,
  TOP_P_PARAM,
  { key: "top_k", type: "integer", label: "Top-k", roles: ["analysis"], group: "generation", min: 1, max: 1000, placeholder: "模型預設" },
  { key: "min_p", type: "number", label: "Min-p", roles: ["analysis"], group: "generation", min: 0, max: 1, step: 0.01, placeholder: "模型預設" },
  { key: "repeat_penalty", type: "number", label: "重複懲罰（repeat_penalty）", help: "大於 1 抑制重複；小模型輸出迴圈時可設 1.05–1.1。", roles: ["analysis"], group: "generation", min: 0.5, max: 2, step: 0.01, placeholder: "模型預設" },
  {
    key: "think",
    type: "select",
    label: "思考模式（think）",
    help: "Qwen3、DeepSeek-R1 等可開關；gpt-oss 只能選強度（關閉時以 low 代替）。結構化萃取建議關閉——在同一模型上實測可快 10 倍以上。",
    roles: ["analysis"],
    group: "reasoning",
    options: [
      { value: "off", label: "關閉" },
      { value: "on", label: "開啟" },
      { value: "low", label: "low" },
      { value: "medium", label: "medium" },
      { value: "high", label: "high" },
    ],
    placeholder: "模型預設",
  },
  {
    key: "num_ctx",
    type: "integer",
    label: "上下文長度（num_ctx）",
    help: "輸入＋輸出的 token 上限。未設定時 Ollama 依顯存決定（<24 GiB 只有 4k，長仿單會被默默截斷；≥48 GiB 則用 256k，KV 快取可能把模型擠出 GPU）。仿單通常 32k 足夠。變更會讓模型重新載入。",
    roles: ["analysis", "embedding"],
    group: "advanced",
    min: 512,
    max: 1_048_576,
    step: 4096,
    placeholder: "伺服器預設",
  },
  {
    key: "keep_alive",
    type: "select",
    label: "模型常駐時間（keep_alive）",
    help: "最後一次呼叫後模型保留在記憶體多久。批次工作時設長一點可避免反覆重新載入。",
    roles: ["analysis", "embedding"],
    group: "advanced",
    options: [
      { value: "5m", label: "5 分鐘" },
      { value: "30m", label: "30 分鐘" },
      { value: "1h", label: "1 小時" },
      { value: "-1", label: "永久常駐" },
    ],
    placeholder: "伺服器預設（5 分鐘）",
  },
  {
    key: "send_dimensions",
    type: "boolean",
    label: "送出維度參數（dimensions）",
    help: "請 Ollama 截短向量維度（需模型支援 Matryoshka）。關閉時回傳模型原生維度，必須等於上方設定的維度。",
    roles: ["embedding"],
    group: "embedding",
  },
];

function ollamaHeaders(p: LlmProfile): Record<string, string> {
  return bearer(p); // local: no key; Ollama Cloud: Bearer
}

function keepAlive(p: LlmProfile): string | number | undefined {
  const v = pStr(p.params, "keep_alive");
  if (v === undefined) return undefined;
  return /^-?\d+$/.test(v) ? Number(v) : v;
}

/** `think` value: gpt-oss only accepts levels, other thinking models a boolean. */
export function ollamaThink(model: string, setting: string | undefined): boolean | string | undefined {
  if (!setting) return undefined;
  const gptOss = /gpt-oss/i.test(model);
  if (setting === "off") return gptOss ? "low" : false;
  if (setting === "on") return gptOss ? "medium" : true;
  return gptOss ? setting : true;
}

export function buildOllamaChatBody(p: LlmProfile, req: ChatRequest): Record<string, unknown> {
  const options: Record<string, unknown> = { num_predict: req.maxTokens };
  for (const key of ["temperature", "top_p", "top_k", "min_p", "repeat_penalty", "num_ctx"]) {
    const v = pNum(p.params, key);
    if (v !== undefined) options[key] = v;
  }
  const body: Record<string, unknown> = { model: p.model, messages: req.messages, stream: false, options };
  // Ollama Cloud does not support structured outputs; `format` would be ignored at best.
  if (req.json && !/^https:\/\/(www\.)?ollama\.com/i.test(trimSlash(p.base_url))) body.format = "json";
  const think = ollamaThink(p.model, pStr(p.params, "think"));
  if (think !== undefined) body.think = think;
  const ka = keepAlive(p);
  if (ka !== undefined) body.keep_alive = ka;
  return body;
}

function nsToMs(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n / 1e6) : null;
}

async function ollamaChat(p: LlmProfile, req: ChatRequest, ctx: CallContext): Promise<ChatResult> {
  const json = await postJson(ctx, `${trimSlash(p.base_url)}/api/chat`, ollamaHeaders(p), buildOllamaChatBody(p, req));
  const message = (json.message ?? {}) as Record<string, unknown>;
  let content = String(message.content ?? "");
  if (req.json) content = stripJsonFence(content);
  const finishReason = String(json.done_reason ?? "");
  const evalCount = positive(json.eval_count);
  const evalMs = nsToMs(json.eval_duration);
  return {
    content,
    finishReason,
    truncated: detectTruncation({
      provider: "Ollama",
      content,
      finishReason,
      cutReasons: ["length"],
      reasoningChars: String(message.thinking ?? "").length,
    }),
    usage: { promptTokens: positive(json.prompt_eval_count), completionTokens: evalCount, reasoningTokens: null },
    reasoningChars: String(message.thinking ?? "").length,
    droppedParams: [],
    diagnostics: {
      load_ms: nsToMs(json.load_duration),
      prompt_eval_ms: nsToMs(json.prompt_eval_duration),
      eval_ms: evalMs,
      tokens_per_sec: evalMs ? Math.round((evalCount / evalMs) * 10_000) / 10 : null,
    },
  };
}

async function ollamaEmbed(p: LlmProfile, req: EmbedRequest, ctx: CallContext): Promise<(number[] | null)[]> {
  const body: Record<string, unknown> = { model: p.model, input: req.texts };
  if (pBool(p.params, "send_dimensions")) body.dimensions = req.dimensions;
  const numCtx = pNum(p.params, "num_ctx");
  if (numCtx !== undefined) body.options = { num_ctx: numCtx };
  const ka = keepAlive(p);
  if (ka !== undefined) body.keep_alive = ka;
  const json = await postJson(ctx, `${trimSlash(p.base_url)}/api/embed`, ollamaHeaders(p), body);
  return ((json.embeddings as number[][] | undefined) ?? []).map((v) => (Array.isArray(v) ? v : null));
}

async function ollamaModels(p: LlmProfile, role: "analysis" | "embedding", ctx: CallContext): Promise<string[]> {
  const json = await getJson(ctx, `${trimSlash(p.base_url)}/api/tags`, ollamaHeaders(p));
  const ids = ((json.models as Record<string, unknown>[] | undefined) ?? []).map((m) => String(m.name ?? m.model ?? "")).filter(Boolean);
  const filtered = byEmbeddingName(ids, role);
  return (filtered.length ? filtered : ids).sort();
}

/** Where the model sits (`/api/ps`): VRAM share and allocated context. */
async function ollamaInspect(p: LlmProfile, ctx: CallContext): Promise<Record<string, unknown> | null> {
  try {
    const json = await getJson(ctx, `${trimSlash(p.base_url)}/api/ps`, ollamaHeaders(p));
    const m = ((json.models as Record<string, unknown>[] | undefined) ?? []).find((x) => x.name === p.model || x.model === p.model);
    if (!m) return { residency: { loaded: false } };
    const size = Number(m.size) || 0;
    const vram = Number(m.size_vram) || 0;
    return {
      residency: {
        loaded: true,
        model_size_bytes: size,
        vram_bytes: vram,
        gpu_ratio: size > 0 ? Math.min(1, vram / size) : null,
        context_length: Number(m.context_length) || null,
      },
    };
  } catch {
    return null;
  }
}

export const ollama: ProviderAdapter = {
  spec: {
    id: "ollama",
    label: "Ollama",
    category: "selfhost",
    description: "自架 Ollama（原生 API，可設定上下文長度與思考模式）。也可接 Ollama Cloud（https://ollama.com，需金鑰；Cloud 不支援強制 JSON 輸出）。",
    roles: ["analysis", "embedding"],
    baseUrl: {
      default: "http://host.docker.internal:11434",
      placeholder: "http://主機:11434",
      help: "容器內連到同一台主機請用 host.docker.internal。Ollama Cloud 填 https://ollama.com。",
      options: [
        { value: "http://host.docker.internal:11434", label: "本機（host.docker.internal）" },
        { value: "https://ollama.com", label: "Ollama Cloud" },
      ],
    },
    keyRequired: false,
    keyHelp: "本機 Ollama 不需要；Ollama Cloud 需填 ollama.com 的 API 金鑰。",
    modelExamples: { analysis: ["qwen3:32b", "gpt-oss:20b"], embedding: ["qwen3-embedding:0.6b"] },
    canListModels: true,
    docsUrl: "https://docs.ollama.com/api",
    params: OLLAMA_PARAMS,
  },
  chat: ollamaChat,
  embed: ollamaEmbed,
  listModels: ollamaModels,
  inspect: ollamaInspect,
};
