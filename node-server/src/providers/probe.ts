/**
 * Reachability checks for a model endpoint, through its provider adapter, so
 * health pages and job pre-flights never hard-code one vendor's URL scheme.
 *
 * - shallow (default): list models — the cheapest authenticated call; providers
 *   without a listing fall back to "the host answers HTTP at all".
 * - deep: one real one-text embedding (embedding role only) — verifies key,
 *   model and dimensions before a job commits to thousands of calls.
 */

import type { LlmProfile } from "../admin/llmProfiles.js";
import { embeddingDimensions } from "../admin/llmProfiles.js";
import { getAdapter } from "./registry.js";
import { ProviderHttpError, type CallContext, type Role } from "./types.js";

export interface EndpointProbe {
  ok: boolean;
  endpoint: string;
  latencyMs: number | null;
  message: string;
  httpStatus: number | null;
  provider: string;
}

function timed(ms: number): CallContext {
  return { fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(ms) }) };
}

export async function probeEndpoint(
  p: LlmProfile,
  role: Role,
  opts: { deep?: boolean; timeoutMs?: number } = {},
): Promise<EndpointProbe> {
  const adapter = getAdapter(p.provider, p.base_url);
  const endpoint = p.base_url || adapter?.spec.baseUrl.default || "";
  const base = { endpoint, provider: adapter?.spec.id ?? p.provider };
  if (!adapter) return { ...base, ok: false, latencyMs: null, message: `Unknown provider '${p.provider}'`, httpStatus: null };
  const timeoutMs = opts.timeoutMs ?? 8000;
  const started = performance.now();
  const elapsed = () => Math.trunc(performance.now() - started);
  const fail = (exc: unknown) => ({
    ...base,
    ok: false,
    latencyMs: null,
    httpStatus: exc instanceof ProviderHttpError ? exc.status : null,
    message: exc instanceof ProviderHttpError ? `HTTP ${exc.status}` : String((exc as Error).message),
  });

  if (opts.deep && role === "embedding" && adapter.embed) {
    try {
      const vecs = await adapter.embed(p, { texts: ["ping"], inputType: "query", dimensions: embeddingDimensions(p) }, timed(timeoutMs));
      const dim = vecs[0]?.length ?? 0;
      return {
        ...base,
        ok: dim > 0,
        latencyMs: elapsed(),
        httpStatus: 200,
        message: dim > 0 ? `${adapter.spec.label}: embedded a sample (${dim} dims)` : `${adapter.spec.label}: returned no vector`,
      };
    } catch (exc) {
      return fail(exc);
    }
  }

  if (adapter.listModels) {
    try {
      const models = await adapter.listModels(p, role, timed(timeoutMs));
      return { ...base, ok: true, latencyMs: elapsed(), httpStatus: 200, message: `${adapter.spec.label}: ${models.length} model(s) listed` };
    } catch (exc) {
      return fail(exc);
    }
  }

  try {
    const resp = await fetch(endpoint, { method: "GET", signal: AbortSignal.timeout(Math.min(timeoutMs, 4000)) });
    return {
      ...base,
      ok: true,
      latencyMs: elapsed(),
      httpStatus: resp.status,
      message: `${adapter.spec.label}: host reachable (HTTP ${resp.status}; no model listing to verify the key)`,
    };
  } catch (exc) {
    return fail(exc);
  }
}
