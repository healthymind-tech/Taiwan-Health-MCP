/**
 * Turn an embedding endpoint's failure into something an operator can act on.
 *
 * Every admin path that calls an embedding endpoint (profile save, account /
 * model test, fingerprint check, model switch pre-check, health) runs its
 * failure through here and gets a stable `{ code, params }` the console
 * translates (web-v2 llmErrors.ts) — never a raw HTTP body. The raw text stays
 * in `params.detail` for the "技術細節" disclosure.
 *
 * Codes:
 *   embedding_model_not_found       the server answers but does not serve that model
 *                                   (params.available: what it does serve)
 *   embedding_dims_unsupported      the vectors that came back are not the configured size
 *                                   (the server rejected / ignored `dimensions`, or it is
 *                                   not sent and the model's native size differs)
 *   embedding_endpoint_unreachable  no answer (connection refused, DNS, timeout, bad URL)
 *   embedding_endpoint_auth         401 / 403
 *   embedding_endpoint_error        any other HTTP error (5xx, 4xx that is not one of the above)
 *   embedding_no_vectors            answered 200 without a vector for every text
 */

import { getAdapter } from "../providers/registry.js";
import { ProviderHttpError, snippet, type CallContext } from "../providers/types.js";
import { embeddingDimensions, type LlmProfile } from "./llmProfiles.js";

export interface EmbedIssue {
  code: string;
  params: Record<string, unknown>;
}

type Leaf = LlmProfile & { account_name?: string };

/** Account / endpoint facts every issue carries, so the UI can name the culprit. */
export function leafContext(leaf: Leaf): Record<string, unknown> {
  const i = leaf.name.lastIndexOf(" · ");
  return {
    name: leaf.name,
    account: leaf.account_name ?? (i >= 0 ? leaf.name.slice(0, i) : leaf.name),
    account_id: leaf.account_id ?? null,
    base_url: leaf.base_url,
    provider: leaf.provider,
    model: leaf.model,
  };
}

/** The `error.message` (or similar) of a provider's JSON error body; else a one-line snippet. */
export function serverMessage(body: string): string {
  try {
    const j = JSON.parse(body) as Record<string, unknown>;
    const e = j.error ?? j.detail ?? j.message;
    if (typeof e === "string") return e;
    if (e && typeof e === "object") {
      const m = (e as Record<string, unknown>).message ?? (e as Record<string, unknown>).msg;
      if (typeof m === "string") return m;
    }
  } catch {
    /* not JSON */
  }
  return snippet(body, 240);
}

const sendsDimensions = (leaf: Leaf): boolean => {
  const raw = leaf.params?.send_dimensions;
  return raw === true || ["1", "true", "yes", "on"].includes(String(raw ?? "").toLowerCase());
};

/**
 * Embedding families that can truncate their output (Matryoshka). A guess from
 * the model name, used only to decide which fix to suggest first.
 */
export function likelyMatryoshka(model: string): boolean {
  return /qwen3-?embedding|text-embedding-3|nomic-embed|jina-embeddings-v[3-9]|gte-qwen|mxbai-embed|arctic-embed-l-v2|embeddinggemma|voyage-3|voyage-4|bge-m3-matryoshka|mrl/i.test(model);
}

/** OpenAI-compatible self-hosted servers: where vLLM's --hf-overrides hint applies. */
const selfHostedCompat = (leaf: Leaf): boolean => leaf.provider === "openai_compatible" || leaf.provider === "vllm";

const MODEL_MISSING_RE = /does not exist|not found|no such model|unknown model|model .*(not (available|loaded|served|exist))|try pulling it|is not a valid model|invalid model/i;
const DIMENSIONS_RE = /dimension|matryoshka/i;

/** The returned vectors are not the configured size: why, and what to change. */
export function dimsIssue(leaf: Leaf, returned: number): EmbedIssue | null {
  const configured = embeddingDimensions(leaf);
  if (returned === configured) return null;
  return {
    code: "embedding_dims_unsupported",
    params: {
      ...leafContext(leaf),
      configured,
      returned,
      send_dimensions: sendsDimensions(leaf),
      matryoshka: likelyMatryoshka(leaf.model),
      self_hosted: selfHostedCompat(leaf),
      detail: `The endpoint returned ${returned}-dimension vectors; ${configured} are configured${sendsDimensions(leaf) ? " (the dimensions parameter was sent and rejected or ignored)" : " (dimensions parameter not sent)"}.`,
    },
  };
}

/** Classify a failed embedding call (no network). */
export function classifyEmbedFailure(leaf: Leaf, exc: unknown): EmbedIssue {
  const ctx = leafContext(leaf);
  const raw = exc instanceof Error ? exc.message : String(exc);
  if (exc instanceof ProviderHttpError) {
    const msg = serverMessage(exc.body);
    const detail = `HTTP ${exc.status} from ${exc.url}: ${msg}`;
    if ((exc.status === 404 || exc.status === 400) && /model/i.test(msg) && MODEL_MISSING_RE.test(msg) && !DIMENSIONS_RE.test(msg)) {
      return { code: "embedding_model_not_found", params: { ...ctx, status: exc.status, server_message: msg, available: [], detail } };
    }
    if ((exc.status === 400 || exc.status === 422) && DIMENSIONS_RE.test(msg)) {
      return {
        code: "embedding_dims_unsupported",
        params: {
          ...ctx,
          configured: embeddingDimensions(leaf),
          returned: null,
          send_dimensions: true,
          matryoshka: likelyMatryoshka(leaf.model),
          self_hosted: selfHostedCompat(leaf),
          server_message: msg,
          detail,
        },
      };
    }
    if (exc.status === 401 || exc.status === 403) return { code: "embedding_endpoint_auth", params: { ...ctx, status: exc.status, server_message: msg, detail } };
    if (exc.status === 404) return { code: "embedding_endpoint_error", params: { ...ctx, status: 404, path_problem: true, server_message: msg, detail } };
    return { code: "embedding_endpoint_error", params: { ...ctx, status: exc.status, server_message: msg, detail } };
  }
  if (/did not return a vector|returned no (embedding )?vector/i.test(raw)) return { code: "embedding_no_vectors", params: { ...ctx, detail: raw } };
  let reason = "unreachable";
  if (/Failed to parse URL|Invalid URL|ERR_INVALID_URL/i.test(raw)) reason = "bad_url";
  else if (/timed? ?out|ETIMEDOUT|aborted|TimeoutError/i.test(raw)) reason = "timeout";
  else if (!/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|fetch failed|getaddrinfo|socket hang up|ECONNRESET/i.test(raw)) reason = "other";
  return { code: "embedding_endpoint_unreachable", params: { ...ctx, reason, detail: raw } };
}

function timed(ms: number): CallContext {
  return { fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(ms) }) };
}

/** Models the account serves for embeddings (best effort; [] when it cannot list). */
export async function availableEmbeddingModels(leaf: Leaf, ctx: CallContext = timed(10_000)): Promise<{ models: string[]; ok: boolean }> {
  const adapter = getAdapter(leaf.provider, leaf.base_url);
  if (!adapter?.listModels) return { models: [], ok: false };
  try {
    return { models: await adapter.listModels(leaf, "embedding", ctx), ok: true };
  } catch {
    return { models: [], ok: false };
  }
}

/** `classifyEmbedFailure`, plus the server's model list when the model is missing. */
export async function diagnoseEmbedFailure(leaf: Leaf, exc: unknown, ctx?: CallContext): Promise<EmbedIssue> {
  const issue = classifyEmbedFailure(leaf, exc);
  if (issue.code === "embedding_model_not_found") {
    const listing = await availableEmbeddingModels(leaf, ctx);
    issue.params.available = listing.models.filter((m) => m !== leaf.model).slice(0, 30);
    issue.params.listing_ok = listing.ok;
  }
  return issue;
}

export interface EmbedProbe {
  ok: boolean;
  /** Size of the vectors that came back (null when none did). */
  returned_dims: number | null;
  configured_dims: number;
  latency_ms: number | null;
  vectors: number[][] | null;
  issue: EmbedIssue | null;
}

/**
 * Embed `texts` through one leaf and judge the reply: an answer of the wrong
 * size is a failure too (it could never be stored next to the others).
 */
export async function probeEmbedding(
  leaf: Leaf,
  texts: string[],
  opts: { timeoutMs?: number; ctx?: CallContext; inputType?: "query" | "document" } = {},
): Promise<EmbedProbe> {
  const configured = embeddingDimensions(leaf);
  const ctx = opts.ctx ?? timed(opts.timeoutMs ?? 90_000);
  const adapter = getAdapter(leaf.provider, leaf.base_url);
  if (!adapter?.embed) {
    return {
      ok: false,
      returned_dims: null,
      configured_dims: configured,
      latency_ms: null,
      vectors: null,
      issue: { code: "provider_no_role", params: { ...leafContext(leaf), role: "embedding" } },
    };
  }
  const t0 = Date.now();
  let vecs: (number[] | null)[];
  try {
    vecs = await adapter.embed(leaf, { texts, inputType: opts.inputType ?? "document", dimensions: configured }, ctx);
  } catch (exc) {
    return { ok: false, returned_dims: null, configured_dims: configured, latency_ms: null, vectors: null, issue: await diagnoseEmbedFailure(leaf, exc, ctx) };
  }
  const latency = Date.now() - t0;
  if (vecs.length !== texts.length || vecs.some((v) => !v || v.length === 0)) {
    return {
      ok: false,
      returned_dims: null,
      configured_dims: configured,
      latency_ms: latency,
      vectors: null,
      issue: { code: "embedding_no_vectors", params: { ...leafContext(leaf), detail: "The endpoint did not return a vector for every text." } },
    };
  }
  const returned = (vecs[0] as number[]).length;
  const issue = dimsIssue(leaf, returned);
  return { ok: issue === null, returned_dims: returned, configured_dims: configured, latency_ms: latency, vectors: vecs as number[][], issue };
}
