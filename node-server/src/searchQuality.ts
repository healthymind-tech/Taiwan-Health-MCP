/**
 * Helpers for signalling degraded (keyword-only) hybrid search quality.
 *
 * Faithful port of `src/search_quality.py`. A hybrid (BM25 + embedding) search
 * is *degraded to keyword-only* when the semantic half cannot contribute, for
 * either reason: the embedding provider returned nothing (`vecStr === null`), or
 * the module's embeddings table is empty. In both cases the response gets a
 * `search_mode: "keyword_only"` marker so the calling LLM knows results are
 * literal keyword matches; when hybrid works fully, no marker is added.
 */

import { query } from "./db.js";

// Short TTL: embeddings presence flips only when a (re)embed job runs.
const PRESENCE_TTL_MS = 60_000;
const presenceCache = new Map<string, { at: number; present: boolean }>();

export const KEYWORD_ONLY_MODE = "keyword_only";
export const KEYWORD_ONLY_NOTE =
  "Semantic ranking unavailable (embeddings not built yet or the embedding " +
  "provider is offline); results are keyword/BM25 matches only, so " +
  "cross-language and synonym matching may miss.";

/**
 * Whether *table* (a fully-qualified embeddings table) has any rows. `table` is
 * always a hard-coded literal supplied by the caller, never user input, so
 * direct interpolation is safe. Cached per table; fails closed (false) on error.
 */
export async function embeddingsPresent(table: string, ttlMs = PRESENCE_TTL_MS): Promise<boolean> {
  const now = Date.now();
  const cached = presenceCache.get(table);
  if (cached && now - cached.at < ttlMs) {
    return cached.present;
  }
  let present = false;
  try {
    const res = await query<{ exists: boolean }>(`SELECT EXISTS (SELECT 1 FROM ${table}) AS exists`);
    present = Boolean(res.rows[0]?.exists);
  } catch {
    present = false;
  }
  presenceCache.set(table, { at: now, present });
  return present;
}

/** True when semantic ranking did not contribute to this query. */
export function isKeywordOnly(vecStr: string | null, hasEmbeddings: boolean): boolean {
  return vecStr === null || !hasEmbeddings;
}

/** Add the keyword-only markers to *payload* in place when degraded. */
export function annotate<T extends Record<string, unknown>>(
  payload: T,
  vecStr: string | null,
  hasEmbeddings: boolean,
): T {
  if (isKeywordOnly(vecStr, hasEmbeddings)) {
    (payload as Record<string, unknown>).search_mode = KEYWORD_ONLY_MODE;
    (payload as Record<string, unknown>).search_note = KEYWORD_ONLY_NOTE;
  }
  return payload;
}
