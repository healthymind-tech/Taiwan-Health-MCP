/**
 * EmbeddingService — async embedding client (Ollama / OpenAI / Google / SiliconFlow).
 *
 * Provides vector embeddings for hybrid (BM25 + pgvector) search. Every failure
 * degrades to `null` so callers fall back to keyword-only search rather than
 * erroring.
 *
 * Config is **not** read from env. The endpoints are the leaves of the embedding role's profile (llmRouting.ts)
 * with `kind='embedding'` — one per host — and the shared knobs (strategy,
 * timeout, batch size) are the `embedding` settings group. A batch is
 * tried against the profiles in `candidateOrder()` until one answers, so losing a
 * host costs a retry instead of the whole feature.
 *
 * Every enabled embedding profile must serve the *same model*: vectors from
 * different models — or different quantisations of one model — are not
 * comparable, and they all share one pgvector column. `llmProfiles` enforces
 * that on write; here we simply use whichever profile answers, knowing they are
 * interchangeable by construction.
 */

import { query } from "./db.js";
import { getAdapter } from "./providers/registry.js";
import { logInfo, logWarning } from "./logger.js";
import {
  candidateOrder,
  embeddingDimensions,
  reportFailure,
  reportSuccess,
  type LlmProfile,
  type Strategy,
} from "./admin/llmProfiles.js";
import { canRequest, ProfileRateLimited, recordRequest, waitUntilMs } from "./rateLimiter.js";
import { clampConcurrency } from "./loaders/batchPool.js";

export interface EmbeddingSettings {
  strategy: Strategy;
  timeout: number;
  batchSize: number;
  /**
   * How many embedding batch requests an embed job keeps in flight at once
   * (`embedding.concurrency`, clamped to 1..32). Search-time embedding is one
   * text per call and ignores it.
   */
  concurrency: number;
}

export const DEFAULT_EMBEDDING_SETTINGS: EmbeddingSettings = {
  strategy: "failover",
  timeout: 30,
  batchSize: 32,
  concurrency: 1,
};

/** Typed settings from the raw `embedding` group rows (key → stored string). */
export function parseEmbeddingSettings(m: Map<string, string>): EmbeddingSettings {
  const strategy = (m.get("strategy") || "failover").trim().toLowerCase();
  return {
    strategy: strategy === "weighted" ? "weighted" : "failover",
    timeout: Number(m.get("timeout")) || DEFAULT_EMBEDDING_SETTINGS.timeout,
    batchSize: Number(m.get("batch_size")) || DEFAULT_EMBEDDING_SETTINGS.batchSize,
    concurrency: clampConcurrency(m.get("concurrency") ?? DEFAULT_EMBEDDING_SETTINGS.concurrency),
  };
}

/** Per-profile RPM/TPM limits from the leaf params (account-wide) (undefined = unlimited). */
function profileLimits(p: LlmProfile): { rpm?: number; tpm?: number } {
  return {
    rpm: Number(p.params?.rpm) || undefined,
    tpm: Number(p.params?.tpm) || undefined,
  };
}

/** Rough token estimate used by the TPM limiter (≈10 chars per token). */
function estimateTokens(texts: string[]): number {
  return Math.ceil(texts.join("").length / 10);
}

/** Embed a batch via one profile's provider adapter. Throws on failure (the caller fails over). */
async function providerEmbed(
  p: LlmProfile,
  s: EmbeddingSettings,
  texts: string[],
  inputType: "query" | "document",
): Promise<(number[] | null)[]> {
  // Check rate limits. The limiter is process-wide (shared by every parallel
  // batch of an embed job), and the slot is *reserved* synchronously right after
  // the check: recording only after the response would let N concurrent batches
  // all pass the check before any of them is counted and overshoot the RPM/TPM
  // budget by up to N-1 requests. Providers count failed calls too, so a
  // reservation that ends in an error is not refunded.
  const limits = profileLimits(p);
  const { allowed, reason } = canRequest(p.id, limits);
  if (!allowed) {
    const waitMs = waitUntilMs(p.id, limits);
    throw new ProfileRateLimited(`Rate limit: ${reason}. Wait ${Math.ceil(waitMs / 1000)}s.`, waitMs);
  }
  recordRequest(p.id, estimateTokens(texts));

  const adapter = getAdapter(p.provider, p.base_url);
  if (!adapter?.embed) throw new Error(`Provider '${p.provider}' does not offer embeddings`);
  const timeoutMs = s.timeout * 1000;
  return adapter.embed(
    p,
    { texts, inputType, dimensions: embeddingDimensions(p) },
    // A fresh timeout per HTTP call: adapters may split a batch into several requests.
    { fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) }) },
  );
}

export class EmbeddingService {
  private settings: EmbeddingSettings;
  private profiles: LlmProfile[];
  private available_ = false;

  constructor(settings: EmbeddingSettings, profiles: LlmProfile[]) {
    this.settings = settings;
    this.profiles = profiles;
  }

  /** Configured = at least one enabled profile with an endpoint and a model. */
  get enabled(): boolean {
    return this.profiles.length > 0;
  }

  /** The model every enabled profile serves (they are required to agree). */
  get model(): string {
    return this.profiles[0]?.model ?? "";
  }

  /**
   * Reachability flag — false until a successful embed, flipped false on failure.
   * `check_embedding_health` uses it to decide semantic vs keyword-only.
   */
  get available(): boolean {
    return this.available_;
  }

  /** Probe once so `available` reflects reachability before any real query. */
  async initialize(): Promise<void> {
    if (!this.enabled) return;
    await this.embed("ping");
  }

  /** Embed a single text string. Returns the vector, or null when unavailable. */
  async embed(text: string): Promise<number[] | null> {
    const results = await this.embedBatch([text], "query");
    return results[0] ?? null;
  }

  /**
   * Bulk-job pacing: when *every* profile this service knows is currently out of
   * RPM/TPM budget, wait (bounded by `maxWaitMs`) until the earliest one reopens.
   * Without it, a concurrent embed job against rate-limited providers would burn
   * its batches on instant "Rate limit" failures and drop those rows. Profiles
   * without limits are always available, so this is a no-op for them.
   * Returns the milliseconds actually waited.
   */
  async waitForCapacity(maxWaitMs = 60_000): Promise<number> {
    let waited = 0;
    // Re-check after every sleep: other in-flight batches share the same budget
    // and may have taken the slot that just reopened.
    while (waited < maxWaitMs) {
      const ms = this.capacityWaitMs();
      if (ms === 0) break;
      const step = Math.min(Math.max(ms, 50), maxWaitMs - waited);
      await new Promise((resolve) => setTimeout(resolve, step));
      waited += step;
    }
    return waited;
  }

  /** 0 when some profile can take a request now, else ms until the first reopens. */
  private capacityWaitMs(): number {
    if (this.profiles.length === 0) return 0;
    let waitMs = Infinity;
    for (const p of this.profiles) {
      const limits = profileLimits(p);
      if (!limits.rpm && !limits.tpm) return 0;
      if (canRequest(p.id, limits).allowed) return 0;
      waitMs = Math.min(waitMs, waitUntilMs(p.id, limits));
    }
    return waitMs;
  }

  /**
   * Embed multiple texts in one call. Each item is a vector or null.
   *
   * Walks the candidate order: the first profile that answers wins; one that
   * fails is reported (feeding the cool-down) and the next is tried. A profile
   * that answers only partly — fewer vectors than texts, null items, or
   * vectors of the wrong size — counts as a failure too, and the next profile
   * is asked for just the missing items. Only when every profile has failed
   * do we degrade to keyword-only (nulls).
   *
   * Never throws: a routing lookup failure (DB down) or an embedding-model
   * switch in progress also yields nulls, i.e. keyword-only search.
   */
  async embedBatch(texts: string[], inputType: "query" | "document" = "document"): Promise<(number[] | null)[]> {
    if (!this.enabled || texts.length === 0) return texts.map(() => null);

    let candidates: LlmProfile[];
    let identityDims: number | null;
    try {
      // A model switch shuts every embedding endpoint: nothing may embed with
      // the old model (and `this.profiles` is exactly that old model). This is
      // distinct from "no route bound", where the construction-time profiles
      // remain the fallback.
      const ident = await import("./admin/embeddingIdentity.js");
      if (await ident.embeddingSwitching()) {
        this.available_ = false;
        return texts.map(() => null);
      }
      identityDims = await ident.identityDimensions();
      const order = await candidateOrder("embedding", this.settings.strategy);
      candidates = order.length > 0 ? order : this.profiles;
    } catch (exc) {
      if (this.available_) {
        logWarning("Could not resolve embedding profiles — falling back to keyword search", {
          error: String((exc as Error).message),
        });
      }
      this.available_ = false;
      return texts.map(() => null);
    }

    const result: (number[] | null)[] = texts.map(() => null);
    let missing = texts.map((_, i) => i);
    let lastError = "no embedding profile answered";
    /** Vector size every item must have (the pgvector column's), once known. */
    let batchDims: number | null = identityDims;

    for (const p of candidates) {
      if (missing.length === 0) break;
      const explicit = Number(p.params?.dimensions);
      const expected = batchDims ?? (Number.isInteger(explicit) && explicit > 0 ? explicit : null);
      try {
        const embeddings = await providerEmbed(p, this.settings, missing.map((i) => texts[i]), inputType);
        const stillMissing: number[] = [];
        let wrongSize = 0;
        missing.forEach((textIdx, k) => {
          const v = k < embeddings.length ? embeddings[k] : null;
          const dims = expected ?? batchDims;
          if (!Array.isArray(v) || v.length === 0) {
            stillMissing.push(textIdx);
          } else if (dims !== null && v.length !== dims) {
            wrongSize += 1;
            stillMissing.push(textIdx);
          } else {
            batchDims ??= v.length;
            result[textIdx] = v;
          }
        });
        if (stillMissing.length === 0) {
          reportSuccess(p.id);
          missing = stillMissing;
          break;
        }
        lastError =
          wrongSize > 0
            ? `returned ${wrongSize} vector(s) of the wrong size (expected ${expected ?? batchDims} dimensions)`
            : `returned ${missing.length - stillMissing.length} of ${missing.length} vectors`;
        missing = stillMissing;
        reportFailure(p.id, lastError);
        logWarning("Embedding profile answered incompletely — asking the next one for the rest", {
          profile: p.name,
          error: lastError,
          missing: missing.length,
        });
      } catch (exc) {
        lastError = String((exc as Error).message);
        // Our own RPM/TPM limit is not an endpoint failure: skip, do not cool down.
        if (exc instanceof ProfileRateLimited) continue;
        reportFailure(p.id, lastError);
        logWarning("Embedding profile failed — trying the next one", {
          profile: p.name,
          error: lastError,
        });
      }
    }

    if (result.some((v) => v !== null)) {
      if (!this.available_) {
        logInfo("Embedding connection restored — semantic search re-enabled", {});
      }
      this.available_ = true;
      return result;
    }

    if (this.available_) {
      logWarning("All embedding profiles failed — falling back to keyword search", {
        error: lastError,
      });
    }
    this.available_ = false;
    return result;
  }
}

/** Load the shared `embedding` settings group. Fails open to the defaults. */
export async function loadEmbeddingSettings(): Promise<EmbeddingSettings> {
  try {
    const res = await query<{ key: string; value: string | null }>(
      "SELECT key, value FROM admin.app_settings WHERE group_key = 'embedding'",
    );
    return parseEmbeddingSettings(new Map(res.rows.map((r) => [r.key, r.value ?? ""])));
  } catch {
    return { ...DEFAULT_EMBEDDING_SETTINGS };
  }
}

let _svc: EmbeddingService | null = null;

/** Process-wide embedding service singleton (settings + profiles loaded once). */
export async function getEmbeddingService(): Promise<EmbeddingService> {
  if (_svc) return _svc;
  const settings = await loadEmbeddingSettings();
  let profiles: LlmProfile[] = [];
  try {
    profiles = (await candidateOrder("embedding", settings.strategy)) ?? [];
  } catch (exc) {
    logWarning("Could not load embedding profiles", { error: String((exc as Error).message) });
  }
  _svc = new EmbeddingService(settings, profiles);
  if (_svc.enabled) {
    await _svc.initialize();
    logInfo("EmbeddingService ready", {
      profiles: profiles.length,
      model: _svc.model,
      strategy: settings.strategy,
    });
  } else {
    logWarning(
      "No enabled embedding profile — semantic search disabled, using keyword-only. " +
        "Add one in Admin → Settings → Embedding.",
    );
  }
  return _svc;
}

/**
 * Drop the cached singleton so the next `getEmbeddingService()` reloads settings
 * and profiles from the DB and re-pings — no process restart needed after an
 * operator edits them.
 */
export async function reconfigureEmbeddingService(): Promise<void> {
  _svc = null;
  await getEmbeddingService();
}

/** Format a vector as a pgvector/halfvec literal `[a,b,c]`, or null. */
export function vecLiteral(vec: number[] | null): string | null {
  if (!vec || vec.length === 0) return null;
  return `[${vec.join(",")}]`;
}
