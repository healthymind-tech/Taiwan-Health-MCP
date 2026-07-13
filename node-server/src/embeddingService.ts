/**
 * EmbeddingService — async embedding client (Ollama / OpenAI / Google).
 *
 * Provides vector embeddings for hybrid (BM25 + pgvector) search. Every failure
 * degrades to `null` so callers fall back to keyword-only search rather than
 * erroring.
 *
 * Config is **not** read from env. The endpoints are `admin.llm_profiles` rows
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
import { logInfo, logWarning } from "./logger.js";
import {
  candidateOrder,
  embeddingDimensions,
  reportFailure,
  reportSuccess,
  type LlmProfile,
  type Strategy,
} from "./admin/llmProfiles.js";

export interface EmbeddingSettings {
  strategy: Strategy;
  timeout: number;
  batchSize: number;
}

const GOOGLE_BASE = "https://generativelanguage.googleapis.com";

/** Embed a batch via one profile. Throws on HTTP error (the caller fails over). */
async function providerEmbed(
  p: LlmProfile,
  s: EmbeddingSettings,
  texts: string[],
): Promise<(number[] | null)[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), s.timeout * 1000);
  const baseUrl = p.base_url.replace(/\/+$/, "");
  const dimensions = embeddingDimensions(p);
  try {
    if (p.provider === "openai") {
      const base = baseUrl.endsWith("/embeddings") ? baseUrl : `${baseUrl}/embeddings`;
      const body: Record<string, unknown> = {
        model: p.model,
        input: texts,
        encoding_format: "float",
      };
      if (dimensions && p.model.startsWith("text-embedding-3")) {
        body.dimensions = dimensions;
      }
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (p.api_key) headers.Authorization = `Bearer ${p.api_key}`;
      const resp = await fetch(base, { method: "POST", headers, body: JSON.stringify(body), signal: ctrl.signal });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const json = (await resp.json()) as { data?: { index?: number; embedding?: number[] }[] };
      const data = [...(json.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      return data.map((d) => d.embedding ?? null);
    }
    if (p.provider === "google") {
      const modelPath = p.model.startsWith("models/") ? p.model : `models/${p.model}`;
      const reqs = texts.map((t) => {
        const req: Record<string, unknown> = { model: modelPath, content: { parts: [{ text: t }] } };
        if (dimensions) req.outputDimensionality = dimensions;
        return req;
      });
      const resp = await fetch(`${GOOGLE_BASE}/v1beta/${modelPath}:batchEmbedContents`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": p.api_key },
        body: JSON.stringify({ requests: reqs }),
        signal: ctrl.signal,
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const json = (await resp.json()) as { embeddings?: { values?: number[] }[] };
      return (json.embeddings ?? []).map((e) => e.values ?? null);
    }
    // ollama
    const resp = await fetch(`${baseUrl}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: p.model, input: texts }),
      signal: ctrl.signal,
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = (await resp.json()) as { embeddings?: number[][] };
    return json.embeddings ?? [];
  } finally {
    clearTimeout(timer);
  }
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
    const results = await this.embedBatch([text]);
    return results[0] ?? null;
  }

  /**
   * Embed multiple texts in one call. Each item is a vector or null.
   *
   * Walks the candidate order: the first profile that answers wins; one that
   * fails is reported (feeding the cool-down) and the next is tried. Only when
   * every profile has failed do we degrade to keyword-only.
   */
  async embedBatch(texts: string[]): Promise<(number[] | null)[]> {
    if (!this.enabled || texts.length === 0) return texts.map(() => null);

    const order = await candidateOrder("embedding", this.settings.strategy);
    const candidates = order.length > 0 ? order : this.profiles;
    let lastError = "no embedding profile answered";

    for (const p of candidates) {
      try {
        const embeddings = await providerEmbed(p, this.settings, texts);
        const result: (number[] | null)[] = [];
        for (let i = 0; i < texts.length; i++) {
          result.push(i < embeddings.length ? embeddings[i] : null);
        }
        reportSuccess(p.id);
        if (!this.available_) {
          logInfo("Embedding connection restored — semantic search re-enabled", { profile: p.name });
        }
        this.available_ = true;
        return result;
      } catch (exc) {
        lastError = String((exc as Error).message);
        reportFailure(p.id, lastError);
        logWarning("Embedding profile failed — trying the next one", {
          profile: p.name,
          error: lastError,
        });
      }
    }

    if (this.available_) {
      logWarning("All embedding profiles failed — falling back to keyword search", {
        error: lastError,
      });
    }
    this.available_ = false;
    return texts.map(() => null);
  }
}

/** Load the shared `embedding` settings group. Fails open to the defaults. */
export async function loadEmbeddingSettings(): Promise<EmbeddingSettings> {
  const defaults: EmbeddingSettings = {
    strategy: "failover",
    timeout: 30,
    batchSize: 32,
  };
  try {
    const res = await query<{ key: string; value: string | null }>(
      "SELECT key, value FROM admin.app_settings WHERE group_key = 'embedding'",
    );
    const m = new Map(res.rows.map((r) => [r.key, r.value ?? ""]));
    const strategy = (m.get("strategy") || "failover").trim().toLowerCase();
    return {
      strategy: strategy === "weighted" ? "weighted" : "failover",
      timeout: Number(m.get("timeout")) || 30,
      batchSize: Number(m.get("batch_size")) || 32,
    };
  } catch {
    return defaults;
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
