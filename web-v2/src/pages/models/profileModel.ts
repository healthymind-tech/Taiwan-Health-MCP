/**
 * Provider registry, client side: the vendor specs served by
 * GET /admin/api/llm-providers (node-server/src/providers/registry.ts). Forms for
 * provider accounts and model knobs are rendered from these.
 */
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import type { LlmProfileKind } from "@/lib/types";

export type { LlmProfileKind };

export type KnobValue = string | number | boolean;

// ── provider registry (mirror of node-server/src/providers/types.ts) ───────

export interface ParamOption {
  value: string;
  label: string;
}

export interface ParamSpec {
  key: string;
  type: "number" | "integer" | "select" | "boolean" | "text";
  label: string;
  help?: string;
  roles: LlmProfileKind[];
  group: "generation" | "reasoning" | "embedding" | "advanced";
  min?: number;
  max?: number;
  step?: number;
  options?: ParamOption[];
  placeholder?: string;
  modelPattern?: string;
}

export interface ProviderSpec {
  id: string;
  label: string;
  category: "cloud" | "asia" | "selfhost" | "subscription";
  description: string;
  roles: LlmProfileKind[];
  baseUrl: { default?: string; fixed?: boolean; options?: ParamOption[]; placeholder?: string; help?: string };
  keyRequired: boolean;
  keyHelp?: string;
  modelLabel?: string;
  modelHelp?: string;
  modelExamples?: Partial<Record<LlmProfileKind, string[]>>;
  canListModels: boolean;
  docsUrl: string;
  params: ParamSpec[];
  embeddingBatchLimit?: number;
  thinkingOff?: { key: string; value: string };
  /** Connected by signing in rather than with a key. */
  auth?: "oauth_chatgpt";
  warnings?: string[];
}

export const CATEGORY_LABEL: Record<ProviderSpec["category"], string> = {
  cloud: "雲端服務",
  asia: "亞洲雲端服務",
  selfhost: "自架",
  subscription: "訂閱帳號登入",
};

export function useProviders() {
  return useQuery({
    queryKey: qk.llmProviders,
    queryFn: () => api.get<{ providers: ProviderSpec[] }>("/admin/api/llm-providers"),
    staleTime: Infinity,
    select: (d) => d.providers,
  });
}

/** Knobs of `spec` that apply to this role and model. */
export function visibleParams(spec: ProviderSpec | undefined, kind: LlmProfileKind, model: string): ParamSpec[] {
  if (!spec) return [];
  return spec.params.filter((p) => {
    if (!p.roles.includes(kind)) return false;
    if (!p.modelPattern || !model.trim()) return true;
    try {
      return new RegExp(p.modelPattern, "i").test(model.trim());
    } catch {
      return true;
    }
  });
}
