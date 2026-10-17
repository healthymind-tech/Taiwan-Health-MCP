/**
 * OpenAI (official API only) and Azure OpenAI (v1 API). Same wire format; Azure
 * differs in base URL, the `api-key` header and `model` = deployment name.
 * Docs: https://developers.openai.com/api/docs/guides/reasoning ,
 * https://learn.microsoft.com/en-us/azure/foundry/openai/reference
 */

import type { LlmProfile } from "../admin/llmProfiles.js";
import { ensureV1, pNum, pStr, TEMPERATURE_PARAM, TOP_P_PARAM, trimSlash } from "./common.js";
import {
  bearer,
  openAiCompatChat,
  openAiCompatEmbed,
  openAiCompatModels,
  type OpenAiCompatOptions,
} from "./openaiCompat.js";
import type { ParamSpec, ProviderAdapter, Role } from "./types.js";

export const OPENAI_BASE_URL = "https://api.openai.com/v1";

/** gpt-5.x / gpt-6.x / o-series reason by default and bill it against the output budget. */
export function isOpenAiReasoningModel(model: string): boolean {
  return /^(gpt-5|gpt-6|o\d)/i.test(model.trim());
}

const EFFORT_PARAM: ParamSpec = {
  key: "reasoning_effort",
  type: "select",
  label: "推理強度（reasoning_effort）",
  help:
    "推理模型（gpt-5／gpt-6／o 系列）思考的深度。結構化萃取通常 low 或 none 就夠，越高越慢、越耗輸出預算。" +
    "可用值依模型而異：none 僅 gpt-5.1 之後（gpt-6-astra、gpt-6.1-sol 不支援）；minimal 僅原始 gpt-5；max 僅 gpt-5.6／gpt-6。端點拒絕時會自動略過。",
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
  modelPattern: "^(gpt-5|gpt-6|o\\d)",
};

const VERBOSITY_PARAM: ParamSpec = {
  key: "verbosity",
  type: "select",
  label: "回覆詳細度（verbosity）",
  help: "gpt-5 之後的模型可用。JSON 萃取建議 low，可減少多餘文字。",
  roles: ["analysis"],
  group: "generation",
  options: [
    { value: "low", label: "low" },
    { value: "medium", label: "medium" },
    { value: "high", label: "high" },
  ],
  placeholder: "模型預設",
  modelPattern: "^(gpt-5|gpt-6)",
};

const SERVICE_TIER_PARAM: ParamSpec = {
  key: "service_tier",
  type: "select",
  label: "服務等級（service_tier）",
  help: "flex 約半價但較慢、可能排隊，適合背景批次分析；priority 較快但較貴。",
  roles: ["analysis"],
  group: "advanced",
  options: [
    { value: "auto", label: "auto" },
    { value: "default", label: "default" },
    { value: "flex", label: "flex（半價、較慢）" },
    { value: "priority", label: "priority" },
  ],
  placeholder: "帳號預設",
};

const SAMPLING_NOTE = "推理模型在推理強度不是 none 時不接受此參數，系統會自動不送出。";

const OPENAI_PARAMS: ParamSpec[] = [
  { ...TEMPERATURE_PARAM, help: `${TEMPERATURE_PARAM.help}${SAMPLING_NOTE}` },
  { ...TOP_P_PARAM, help: `${TOP_P_PARAM.help}${SAMPLING_NOTE}` },
  EFFORT_PARAM,
  VERBOSITY_PARAM,
  SERVICE_TIER_PARAM,
];

/** The model whose capabilities apply (Azure: the deployment's underlying model when given). */
function capabilityModel(profile: LlmProfile): string {
  return pStr(profile.params, "base_model") ?? profile.model;
}

function sharedOptions(root: (p: LlmProfile) => string, headers: (p: LlmProfile) => Record<string, string>): OpenAiCompatOptions {
  return {
    root,
    headers,
    tokenParam: () => "max_completion_tokens",
    jsonNeedsKeyword: true,
    sendSampling: (p) => {
      const model = capabilityModel(p);
      return !isOpenAiReasoningModel(model) || pStr(p.params, "reasoning_effort") === "none";
    },
    extraBody: (p) => {
      const body: Record<string, unknown> = {};
      const model = capabilityModel(p);
      const effort = pStr(p.params, "reasoning_effort");
      if (effort && isOpenAiReasoningModel(model)) body.reasoning_effort = effort;
      const verbosity = pStr(p.params, "verbosity");
      if (verbosity && /^(gpt-5|gpt-6)/i.test(model)) body.verbosity = verbosity;
      const tier = pStr(p.params, "service_tier");
      if (tier) body.service_tier = tier;
      return body;
    },
    embeddings: {
      // `dimensions` only exists on text-embedding-3 and later.
      body: (p, req) => (/text-embedding-3/i.test(capabilityModel(p)) ? { dimensions: req.dimensions } : {}),
      batchLimit: 2048,
    },
    filterModels: (ids: string[], role: Role) =>
      ids.filter((id) =>
        role === "embedding"
          ? /embedding/i.test(id)
          : /^(gpt-|o\d|chatgpt)/i.test(id) && !/(audio|realtime|tts|transcribe|image|search|embedding|instruct)/i.test(id),
      ),
  };
}

const openaiOpts = sharedOptions(() => OPENAI_BASE_URL, bearer);

export const openai: ProviderAdapter = {
  spec: {
    id: "openai",
    label: "OpenAI",
    category: "cloud",
    description: "OpenAI 官方 API（api.openai.com）。自架或其他相容 OpenAI 格式的服務請選「OpenAI-Compatible API」。",
    roles: ["analysis", "embedding"],
    baseUrl: { default: OPENAI_BASE_URL, fixed: true },
    keyRequired: true,
    keyHelp: "在 platform.openai.com → API keys 建立。",
    modelExamples: { analysis: ["gpt-6-luna", "gpt-6.1-sol", "gpt-5.5"], embedding: ["text-embedding-3-large", "text-embedding-3-small"] },
    canListModels: true,
    docsUrl: "https://developers.openai.com/api/docs",
    params: OPENAI_PARAMS,
    embeddingBatchLimit: 2048,
  },
  chat: (p, req, ctx) => openAiCompatChat(p, req, ctx, openaiOpts),
  embed: (p, req, ctx) => openAiCompatEmbed(p, req, ctx, openaiOpts),
  listModels: (p, role, ctx) => openAiCompatModels(p, role, ctx, openaiOpts),
};

/** Azure v1 root: accepts the resource URL with or without /openai/v1. */
export function azureRoot(baseUrl: string): string {
  const u = trimSlash(baseUrl);
  if (/\/openai\/v1$/i.test(u)) return u;
  if (/\/openai$/i.test(u)) return `${u}/v1`;
  return /\/v1$/i.test(u) ? u : `${u}/openai/v1`;
}

const azureOpts = sharedOptions(
  (p) => azureRoot(p.base_url),
  (p): Record<string, string> => (p.api_key ? { "api-key": p.api_key } : {}),
);

export const azureOpenai: ProviderAdapter = {
  spec: {
    id: "azure_openai",
    label: "Azure OpenAI",
    category: "cloud",
    description: "Azure OpenAI／Microsoft Foundry（v1 API）。模型欄位填「部署名稱」。",
    roles: ["analysis", "embedding"],
    baseUrl: {
      placeholder: "https://<資源名稱>.openai.azure.com/openai/v1",
      help: "資源的端點，也接受 *.services.ai.azure.com。只填到資源網址也可以，系統會補上 /openai/v1。",
    },
    keyRequired: true,
    keyHelp: "Azure 入口網站 → 資源 → 金鑰與端點。以 api-key 標頭送出。",
    modelLabel: "部署名稱（deployment）",
    modelHelp: "Azure 以部署名稱呼叫模型，無法用 API 金鑰列出部署，請手動輸入。",
    modelExamples: { analysis: ["my-gpt-6-luna"], embedding: ["my-text-embedding-3-large"] },
    canListModels: false,
    docsUrl: "https://learn.microsoft.com/en-us/azure/foundry/openai/reference",
    params: [
      {
        key: "base_model",
        type: "text",
        label: "部署的基礎模型",
        help: "這個部署背後的模型（如 gpt-6-luna、text-embedding-3-large）。部署名稱看不出模型時，系統靠它決定可用參數（推理強度、維度…）。",
        roles: ["analysis", "embedding"],
        group: "advanced",
        placeholder: "與部署名稱相同時可留空",
      },
      ...OPENAI_PARAMS.filter((x) => x.key !== "service_tier"),
    ],
    embeddingBatchLimit: 2048,
  },
  chat: (p, req, ctx) => openAiCompatChat(p, req, ctx, azureOpts),
  embed: (p, req, ctx) => openAiCompatEmbed(p, req, ctx, azureOpts),
};

