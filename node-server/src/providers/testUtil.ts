/** Test helpers for provider adapters: a profile factory and a recording fake fetch. */

import type { LlmProfile } from "../admin/llmProfiles.js";
import type { CallContext } from "./types.js";

export function profile(provider: string, model: string, params: Record<string, unknown> = {}, extra: Partial<LlmProfile> = {}): LlmProfile {
  return {
    id: 1,
    kind: "analysis",
    name: "t",
    provider,
    base_url: "",
    api_key: "k",
    model,
    enabled: true,
    priority: 1,
    weight: 1,
    params: params as LlmProfile["params"],
    ...extra,
  };
}

export interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

/** Fake fetch: records requests, answers with `replies` in order (status, json). */
export function fakeCtx(...replies: [number, unknown][]): { ctx: CallContext; calls: Captured[] } {
  const calls: Captured[] = [];
  let i = 0;
  const ctx: CallContext = {
    fetch: async (url, init) => {
      calls.push({
        url,
        headers: (init.headers ?? {}) as Record<string, string>,
        body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
      });
      const [status, json] = replies[Math.min(i++, replies.length - 1)];
      return new Response(typeof json === "string" ? json : JSON.stringify(json), { status });
    },
  };
  return { ctx, calls };
}

