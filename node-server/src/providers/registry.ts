/**
 * The provider registry: id → adapter. `getAdapter` also resolves legacy ids
 * stored before the registry existed (`vllm`, `google`) — the 2026-10 migration
 * rewrites them, this keeps an un-migrated row working meanwhile.
 */

import { ADAPTERS as ASIA } from "./asia.js";
import { ADAPTERS as CLOUD_COMPAT } from "./cloudCompat.js";
import { ADAPTERS as CLOUD_MAJOR } from "./cloudMajor.js";
import { ADAPTERS as CLOUD_SPECIALIST } from "./cloudSpecialist.js";
import { chatgpt } from "./chatgpt.js";
import { azureOpenai, openai } from "./openai.js";
import { ollama, openaiCompatible } from "./selfhost.js";
import type { ProviderAdapter, ProviderSpec, Role } from "./types.js";

const ALL: ProviderAdapter[] = [
  openai,
  azureOpenai,
  ...CLOUD_MAJOR,
  ...CLOUD_SPECIALIST,
  ...CLOUD_COMPAT,
  ...ASIA,
  openaiCompatible,
  ollama,
  chatgpt,
];

/**
 * The param value that switches thinking off (or to its minimum where it cannot
 * be disabled), per provider — used by the admin test panel's one-click fix.
 * Kept here so each adapter file stays a pure description of its API.
 */
const THINKING_OFF: Record<string, { key: string; value: string }> = {
  openai: { key: "reasoning_effort", value: "none" },
  azure_openai: { key: "reasoning_effort", value: "none" },
  anthropic: { key: "thinking", value: "disabled" },
  gemini: { key: "thinking_level", value: "minimal" },
  bedrock: { key: "thinking", value: "disabled" },
  mistral: { key: "reasoning_effort", value: "none" },
  cohere: { key: "thinking", value: "disabled" },
  deepseek: { key: "thinking", value: "disabled" },
  groq: { key: "reasoning_effort", value: "none" },
  openrouter: { key: "reasoning_effort", value: "none" },
  together: { key: "thinking", value: "off" },
  fireworks: { key: "reasoning_effort", value: "none" },
  siliconflow: { key: "enable_thinking", value: "off" },
  dashscope: { key: "enable_thinking", value: "off" },
  moonshot: { key: "thinking", value: "off" },
  zhipu: { key: "thinking", value: "off" },
  volcengine: { key: "thinking", value: "disabled" },
  minimax: { key: "thinking", value: "off" },
  openai_compatible: { key: "thinking", value: "off" },
  ollama: { key: "think", value: "off" },
};
for (const a of ALL) {
  const off = THINKING_OFF[a.spec.id];
  if (off && !a.spec.thinkingOff) a.spec.thinkingOff = off;
}

const BY_ID = new Map(ALL.map((a) => [a.spec.id, a]));

/** Legacy provider ids → registry ids. */
export const PROVIDER_ALIASES: Record<string, string> = {
  vllm: "openai_compatible",
  google: "gemini",
  azure: "azure_openai",
  claude: "anthropic",
};

/**
 * Canonical id for a provider value (aliases resolved). The URL never changes
 * the type: an account created as "openai" is OpenAI, and a fixed-URL provider
 * ignores whatever URL came with it. Only documents from before the provider
 * registry need the URL — see `legacyProviderId`.
 */
export function canonicalProviderId(provider: string, _baseUrl = ""): string {
  const id = (provider || "").trim().toLowerCase();
  return PROVIDER_ALIASES[id] ?? id;
}

/**
 * Provider id for a pre-registry endpoint profile (settings export v2, the
 * 2026-10 migration): back then "openai" meant "speaks the OpenAI API", so a
 * non-official URL is an OpenAI-compatible server.
 */
export function legacyProviderId(provider: string, baseUrl = ""): string {
  const id = (provider || "").trim().toLowerCase();
  if (id === "openai" && baseUrl.trim() && !/^https:\/\/api\.openai\.com(\/|$)/i.test(baseUrl.trim())) {
    return "openai_compatible";
  }
  return canonicalProviderId(id);
}

export function getAdapter(provider: string, baseUrl = ""): ProviderAdapter | undefined {
  return BY_ID.get(canonicalProviderId(provider, baseUrl));
}

export function providerSpecs(role?: Role): ProviderSpec[] {
  return ALL.map((a) => a.spec).filter((s) => !role || s.roles.includes(role));
}

export function allAdapters(): readonly ProviderAdapter[] {
  return ALL;
}
