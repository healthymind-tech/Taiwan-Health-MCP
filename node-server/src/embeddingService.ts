/**
 * EmbeddingService — async embedding client (Ollama / OpenAI / Google).
 *
 * Faithful port of `src/embedding_service.py`. Provides vector embeddings for
 * hybrid (BM25 + pgvector) search. Falls back to `null` on any error so callers
 * degrade gracefully to keyword-only search.
 *
 * Config is **not** read from env here (those are seed-only in this project).
 * Settings live in `admin.app_settings` group `embedding`, exactly as the Python
 * lifespan applies them via `embedding_service.configure(...)`. `getEmbeddingService`
 * loads that group from the DB once and caches the configured singleton.
 */

import { query } from "./db.js";
import { logInfo, logWarning } from "./logger.js";

export interface EmbeddingSettings {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  timeout: number;
  batchSize: number;
  dimensions: number;
}

const GOOGLE_BASE = "https://generativelanguage.googleapis.com";

function configured(s: EmbeddingSettings): boolean {
  if (s.provider === "ollama") return Boolean(s.baseUrl);
  return Boolean(s.model && s.apiKey);
}

/** Embed a batch via the configured provider. Throws on HTTP error. */
async function providerEmbed(s: EmbeddingSettings, texts: string[]): Promise<(number[] | null)[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), s.timeout * 1000);
  try {
    if (s.provider === "openai") {
      const base = s.baseUrl.endsWith("/embeddings") ? s.baseUrl : `${s.baseUrl}/embeddings`;
      const body: Record<string, unknown> = {
        model: s.model,
        input: texts,
        encoding_format: "float",
      };
      if (s.dimensions && s.model.startsWith("text-embedding-3")) {
        body.dimensions = s.dimensions;
      }
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (s.apiKey) headers.Authorization = `Bearer ${s.apiKey}`;
      const resp = await fetch(base, { method: "POST", headers, body: JSON.stringify(body), signal: ctrl.signal });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const json = (await resp.json()) as { data?: { index?: number; embedding?: number[] }[] };
      const data = [...(json.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      return data.map((d) => d.embedding ?? null);
    }
    if (s.provider === "google") {
      const modelPath = s.model.startsWith("models/") ? s.model : `models/${s.model}`;
      const reqs = texts.map((t) => {
        const req: Record<string, unknown> = { model: modelPath, content: { parts: [{ text: t }] } };
        if (s.dimensions) req.outputDimensionality = s.dimensions;
        return req;
      });
      const resp = await fetch(`${GOOGLE_BASE}/v1beta/${modelPath}:batchEmbedContents`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": s.apiKey },
        body: JSON.stringify({ requests: reqs }),
        signal: ctrl.signal,
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const json = (await resp.json()) as { embeddings?: { values?: number[] }[] };
      return (json.embeddings ?? []).map((e) => e.values ?? null);
    }
    // ollama
    const resp = await fetch(`${s.baseUrl}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: s.model, input: texts }),
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
  private available_ = false;

  constructor(settings: EmbeddingSettings) {
    this.settings = settings;
  }

  get enabled(): boolean {
    return configured(this.settings);
  }

  /**
   * Reachability flag — mirrors Python `embedding_service._available`: false
   * until a successful embed (or init ping), flipped false on failure. Used by
   * `check_embedding_health` to decide semantic vs keyword-only.
   */
  get available(): boolean {
    return this.available_;
  }

  /**
   * Mirror Python `initialize()` → `_ping()`: probe the provider once with a
   * trivial embed so `available` reflects reachability before any real query.
   * Fail-open (the embed catch already records availability).
   */
  async initialize(): Promise<void> {
    if (!configured(this.settings)) return;
    await this.embed("ping");
  }

  /** Embed a single text string. Returns the vector, or null when unavailable. */
  async embed(text: string): Promise<number[] | null> {
    const results = await this.embedBatch([text]);
    return results[0] ?? null;
  }

  /** Embed multiple texts in one call. Each item is a vector or null. */
  async embedBatch(texts: string[]): Promise<(number[] | null)[]> {
    if (!configured(this.settings) || texts.length === 0) {
      return texts.map(() => null);
    }
    try {
      const embeddings = await providerEmbed(this.settings, texts);
      const result: (number[] | null)[] = [];
      for (let i = 0; i < texts.length; i++) {
        result.push(i < embeddings.length ? embeddings[i] : null);
      }
      if (!this.available_) {
        logInfo("Embedding connection restored — semantic search re-enabled");
      }
      this.available_ = true;
      return result;
    } catch (exc) {
      if (this.available_) {
        logWarning("Embedding failed — falling back to keyword search", {
          error: String((exc as Error).message),
        });
      }
      this.available_ = false;
      return texts.map(() => null);
    }
  }
}

/** Load the `embedding` settings group from admin.app_settings. Fails open. */
export async function loadEmbeddingSettings(): Promise<EmbeddingSettings> {
  const defaults: EmbeddingSettings = {
    provider: "ollama",
    baseUrl: "",
    apiKey: "",
    model: "",
    timeout: 30,
    batchSize: 32,
    dimensions: 1024,
  };
  try {
    const res = await query<{ key: string; value: string | null }>(
      "SELECT key, value FROM admin.app_settings WHERE group_key = 'embedding'",
    );
    const m = new Map(res.rows.map((r) => [r.key, r.value ?? ""]));
    return {
      provider: (m.get("provider") || "ollama").trim().toLowerCase(),
      baseUrl: (m.get("base_url") || "").replace(/\/+$/, ""),
      apiKey: m.get("api_key") || "",
      model: m.get("model") || "",
      timeout: Number(m.get("timeout")) || 30,
      batchSize: Number(m.get("batch_size")) || 32,
      dimensions: Number(m.get("dimensions")) || 1024,
    };
  } catch {
    return defaults;
  }
}

let _svc: EmbeddingService | null = null;

/**
 * Process-wide embedding service singleton. Loads settings from the DB once
 * (mirrors the Python lifespan applying `admin_settings.get_group("embedding")`).
 */
export async function getEmbeddingService(): Promise<EmbeddingService> {
  if (_svc) return _svc;
  const settings = await loadEmbeddingSettings();
  _svc = new EmbeddingService(settings);
  if (settings.provider && configured(settings)) {
    // Mirror Python lifespan: ping on init so `available` reflects reachability.
    await _svc.initialize();
    logInfo("EmbeddingService ready", {
      provider: settings.provider,
      model: settings.model,
      base_url: settings.baseUrl,
    });
  } else {
    logWarning("Embedding provider not configured — semantic search disabled, using keyword-only");
  }
  return _svc;
}

/**
 * Drop the cached singleton so the next `getEmbeddingService()` reloads settings
 * from `admin.app_settings` and re-pings. Mirrors the Python
 * `_refresh_settings_singletons` path that calls `embedding_service.configure(...)`
 * after an `embedding` settings save — no process restart needed.
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
