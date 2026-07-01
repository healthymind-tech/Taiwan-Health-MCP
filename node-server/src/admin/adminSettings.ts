/**
 * DB-backed application settings — read path.
 *
 * Faithful port of `src/admin_settings.py` (`SETTINGS_SCHEMA`, `coerce`,
 * `get_group`, `group_metadata`, `get_all`, plus the short-TTL cache). The
 * write path (`save_group` / `list_models` / `test_group`) is ported in the
 * write-endpoint chunk; this module owns the schema (single source of truth)
 * and the masked read surface consumed by `GET /admin/api/settings`.
 *
 * Field insertion order is preserved exactly so the emitted JSON matches the
 * Python dict iteration order byte-for-byte.
 */

import { query, withTransaction } from "../db.js";

export const SECRET_MASK = "●●●●●●●●";

export interface SettingsField {
  key: string;
  type: "str" | "int" | "float" | "bool" | "secret";
  default: string | number | boolean;
  env: string;
  label: string;
  secret: boolean;
  help: string;
  options: string[] | null;
  show_if: Record<string, string[]> | null;
  is_model: boolean;
}

export interface SettingsGroupSpec {
  label: string;
  description: string;
  provider_field?: string;
  test?: string;
  fields: SettingsField[];
}

function field(
  key: string,
  type_: SettingsField["type"],
  def: string | number | boolean,
  env: string,
  label: string,
  opts: {
    secret?: boolean;
    help?: string;
    options?: string[] | null;
    show_if?: Record<string, string[]> | null;
    is_model?: boolean;
  } = {},
): SettingsField {
  return {
    key,
    type: type_,
    default: def,
    env,
    label,
    secret: Boolean(opts.secret) || type_ === "secret",
    help: opts.help ?? "",
    options: opts.options ?? null,
    show_if: opts.show_if ?? null,
    is_model: Boolean(opts.is_model),
  };
}

// ── Registry — mirrors admin_settings.SETTINGS_SCHEMA exactly. ───────────────
export const SETTINGS_SCHEMA: Record<string, SettingsGroupSpec> = {
  embedding: {
    label: "Embedding Model",
    description: "Embedding provider used by semantic search and all embed jobs.",
    provider_field: "provider",
    test: "embedding",
    fields: [
      field("provider", "str", "ollama", "EMBEDDING_PROVIDER", "Provider", {
        options: ["ollama", "openai", "google"],
        help: "ollama = local Ollama; openai = OpenAI-compatible /v1; google = Gemini API.",
      }),
      field("base_url", "str", "http://host.docker.internal:11434", "OLLAMA_BASE_URL", "Base URL", {
        show_if: { provider: ["ollama", "openai"] },
        help: "Ollama host (…:11434) or the OpenAI-compatible /v1 root. (Google uses a fixed endpoint.)",
      }),
      field("api_key", "secret", "", "EMBEDDING_API_KEY", "API Key", {
        show_if: { provider: ["openai", "google"] },
      }),
      field("model", "str", "qwen3-embedding:0.6b", "OLLAMA_EMBED_MODEL", "Model", {
        is_model: true,
        help: "Click 'Fetch models' to load the provider's available embedding models.",
      }),
      field("dimensions", "int", 1024, "OLLAMA_EMBED_DIMENSIONS", "Dimensions", {
        help: "Vector size stored in pgvector; must match the model's output.",
      }),
      field("timeout", "int", 30, "OLLAMA_EMBED_TIMEOUT", "Timeout (s)"),
      field("batch_size", "int", 32, "OLLAMA_EMBED_BATCH_SIZE", "Batch size"),
    ],
  },
  analysis: {
    label: "Analysis LM",
    description: "Text-generation endpoint backing structured drug-insert analysis.",
    provider_field: "provider",
    test: "analysis",
    fields: [
      field("provider", "str", "openai", "DRUG_ANALYSIS_PROVIDER", "Provider", {
        options: ["openai", "ollama"],
        help: "openai = OpenAI-compatible (/v1); ollama = Ollama native (/api).",
      }),
      field("base_url", "str", "http://127.0.0.1:8001/v1", "DRUG_ANALYSIS_BASE_URL", "Base URL"),
      field("api_key", "secret", "0", "DRUG_ANALYSIS_API_KEY", "API Key", {
        show_if: { provider: ["openai"] },
      }),
      field("model", "str", "qwen2.5:7b", "DRUG_ANALYSIS_MODEL_NAME", "Model", { is_model: true }),
      field("temperature", "float", 0.1, "DRUG_ANALYSIS_TEMPERATURE", "Temperature"),
      field("max_tokens", "int", 4096, "DRUG_ANALYSIS_MAX_TOKENS", "Max tokens"),
      field("max_retries", "int", 3, "DRUG_ANALYSIS_MAX_RETRIES", "Max retries"),
      field("prompt_path", "str", "", "DRUG_ANALYSIS_PROMPT_PATH", "Prompt path (optional)", {
        help: "Leave blank to use the bundled default prompt.",
      }),
    ],
  },
  ocr: {
    label: "OCR Server",
    description: "Vision/OCR backend for drug insert PDFs.",
    provider_field: "provider",
    test: "ocr",
    fields: [
      field("provider", "str", "dots_ocr", "DRUG_OCR_PROVIDER", "Provider", {
        options: ["dots_ocr", "vllm"],
      }),
      field("server_ip", "str", "127.0.0.1", "DRUG_OCR_VLLM_SERVER_IP", "Server IP"),
      field("port", "int", 8002, "DRUG_OCR_VLLM_PORT", "Port"),
      field("model", "str", "Qwen/Qwen2.5-VL-7B-Instruct", "DRUG_OCR_MODEL_NAME", "Model", {
        is_model: true,
      }),
      field("prompt_mode", "str", "prompt_layout_all_en", "DRUG_OCR_PROMPT_MODE", "Prompt mode"),
      field("prompt_path", "str", "", "DRUG_OCR_PROMPT_PATH", "Prompt path (optional)", {
        help: "Leave blank to use the bundled default prompt.",
      }),
    ],
  },
  minio: {
    label: "MinIO Object Storage",
    description: "Object storage for uploaded sources and drug assets.",
    test: "minio",
    fields: [
      field("endpoint", "str", "", "MINIO_ENDPOINT", "Endpoint", { help: "host:port, e.g. minio:9000" }),
      field("access_key", "str", "", "MINIO_ACCESS_KEY", "Access key"),
      field("secret_key", "secret", "", "MINIO_SECRET_KEY", "Secret key"),
      field("bucket", "str", "", "MINIO_BUCKET", "Bucket"),
      field("secure", "bool", false, "MINIO_SECURE", "Use TLS (secure)"),
      field("presign_ttl", "int", 3600, "MINIO_PRESIGN_TTL_SECONDS", "Presign TTL (s)"),
    ],
  },
  tfda: {
    label: "TFDA Crawler",
    description: "Taiwan FDA endpoint used by drug enrichment.",
    test: "tfda",
    fields: [
      field("base_url", "str", "https://mcp.fda.gov.tw", "DRUG_TFDA_BASE_URL", "Base URL"),
      field("http_timeout", "int", 30, "DRUG_HTTP_TIMEOUT", "HTTP timeout (s)"),
      field("crawler_concurrency", "int", 4, "DRUG_CRAWLER_CONCURRENCY", "Crawler concurrency"),
    ],
  },
  registry: {
    label: "FHIR Package Registry",
    description:
      "npm-style FHIR registry used to auto-fetch Implementation Guides and their dependency IGs by packageId@version.",
    fields: [
      field("base_url", "str", "https://packages.fhir.org", "FHIR_REGISTRY_BASE_URL", "Registry base URL", {
        help: "Primary FHIR package registry. Default packages.fhir.org. Can point at Simplifier or an internal mirror.",
      }),
      field("fallback_url", "str", "https://packages2.fhir.org", "FHIR_REGISTRY_FALLBACK_URL", "Fallback base URL", {
        help: "Tried when the primary registry cannot serve a package tarball. Leave blank to disable.",
      }),
    ],
  },
  worker: {
    label: "Admin Worker Tuning",
    description: "Background worker loop cadence. Changes take effect on the next worker restart.",
    fields: [
      field("name", "str", "admin-worker", "ADMIN_WORKER_NAME", "Worker name"),
      field("poll_seconds", "float", 3.0, "ADMIN_WORKER_POLL_SECONDS", "Poll interval (s)"),
      field("heartbeat_interval", "int", 15, "ADMIN_HEARTBEAT_INTERVAL_SECONDS", "Heartbeat interval (s)"),
      field("stale_after", "int", 45, "ADMIN_WORKER_STALE_AFTER_SECONDS", "Stale after (s)"),
      field("reclaim_interval", "float", 60.0, "ADMIN_RECLAIM_INTERVAL_SECONDS", "Reclaim interval (s)"),
    ],
  },
};

export function fieldDef(group: string, key: string): SettingsField | null {
  for (const f of SETTINGS_SCHEMA[group]?.fields ?? []) {
    if (f.key === key) return f;
  }
  return null;
}

/** Coerce a stored string value to the field's typed value (mirrors Python `coerce`). */
export function coerce(f: SettingsField, raw: unknown): string | number | boolean {
  const t = f.type;
  if (raw === null || raw === undefined) return f.default;
  if (t === "str" || t === "secret") return String(raw);
  if (t === "int") {
    const s = String(raw).trim();
    // Python int(str(raw).strip()) — strict integer parse, else ValueError → default.
    if (!/^[+-]?\d+$/.test(s)) return f.default;
    return Number.parseInt(s, 10);
  }
  if (t === "float") {
    const s = String(raw).trim();
    const n = Number(s);
    if (s === "" || !Number.isFinite(n)) return f.default;
    return n;
  }
  if (t === "bool") {
    if (typeof raw === "boolean") return raw;
    return ["1", "true", "yes", "on"].includes(String(raw).trim().toLowerCase());
  }
  return raw as never;
}

// ── Short-TTL cache (mirrors _CACHE_TTL_SECONDS = 5.0). ──────────────────────
const CACHE_TTL_MS = 5000;
const cache = new Map<string, { at: number; stored: Record<string, string | null> }>();

export function bustCache(group?: string): void {
  if (group === undefined) cache.clear();
  else cache.delete(group);
}

function defaultAsStr(f: SettingsField): string {
  const d = f.default;
  if (typeof d === "boolean") return d ? "true" : "false";
  return String(d);
}

/** Typed {key: value} dict for a group, DB rows overlaid on registry defaults. */
export async function getGroup(
  group: string,
  opts: { revealSecrets?: boolean } = {},
): Promise<Record<string, string | number | boolean>> {
  const revealSecrets = opts.revealSecrets ?? true;
  const spec = SETTINGS_SCHEMA[group];
  if (!spec) throw new Error(`Unknown settings group: ${group}`);

  const now = Date.now();
  const cached = cache.get(group);
  let stored: Record<string, string | null>;
  if (cached && now - cached.at < CACHE_TTL_MS) {
    stored = cached.stored;
  } else {
    const res = await query<{ key: string; value: string | null }>(
      "SELECT key, value FROM admin.app_settings WHERE group_key = $1",
      [group],
    );
    stored = {};
    for (const r of res.rows) stored[r.key] = r.value;
    cache.set(group, { at: now, stored });
  }

  const out: Record<string, string | number | boolean> = {};
  for (const f of spec.fields) {
    const raw = f.key in stored ? stored[f.key] : null;
    let value = coerce(f, raw);
    if (f.secret && !revealSecrets) value = value ? SECRET_MASK : "";
    out[f.key] = value;
  }
  return out;
}

/** UI descriptor for a group: field defs + current (masked) values. */
export function groupMetadata(
  group: string,
  valuesMasked: Record<string, string | number | boolean>,
): Record<string, unknown> {
  const spec = SETTINGS_SCHEMA[group];
  const fields = spec.fields.map((f) => ({
    key: f.key,
    type: f.type,
    label: f.label,
    secret: f.secret,
    help: f.help,
    options: f.options,
    show_if: f.show_if,
    is_model: f.is_model,
    value: valuesMasked[f.key],
  }));
  return {
    group,
    label: spec.label ?? group,
    description: spec.description ?? "",
    provider_field: spec.provider_field ?? null,
    test: spec.test ?? null,
    fields,
  };
}

/** All groups with field metadata and masked values, for the Settings UI. */
export async function getAll(): Promise<{ groups: Record<string, unknown>[] }> {
  const groups: Record<string, unknown>[] = [];
  for (const group of Object.keys(SETTINGS_SCHEMA)) {
    const masked = await getGroup(group, { revealSecrets: false });
    groups.push(groupMetadata(group, masked));
  }
  return { groups };
}

/**
 * Seed every registry key from its env var (or default) if not already present.
 * Faithful port of `admin_settings.seed_if_empty`: idempotent via
 * `ON CONFLICT DO NOTHING`, so existing values are never overwritten and
 * newly-added keys self-seed on later upgrades. Returns the number of keys
 * considered (mirrors Python returning `len(rows)`, not the true insert count).
 *
 * Called on both the app and the worker boot path so a fresh deployment gets a
 * populated `admin.app_settings` without any Python process.
 */
export async function seedIfEmpty(): Promise<number> {
  const rows: [string, string, string][] = [];
  for (const [group, spec] of Object.entries(SETTINGS_SCHEMA)) {
    for (const f of spec.fields) {
      const envVal = process.env[f.env];
      const value = envVal !== undefined ? envVal : defaultAsStr(f);
      rows.push([group, f.key, value]);
    }
  }
  await withTransaction(async (client) => {
    // Idempotent migration for existing deployments (schema.sql only runs on a
    // fresh postgres data dir).
    await client.query(`
      CREATE TABLE IF NOT EXISTS admin.app_settings (
          group_key   TEXT NOT NULL,
          key         TEXT NOT NULL,
          value       TEXT,
          updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_by  TEXT,
          PRIMARY KEY (group_key, key)
      )
    `);
    for (const [g, k, v] of rows) {
      await client.query(
        `INSERT INTO admin.app_settings (group_key, key, value)
         VALUES ($1, $2, $3)
         ON CONFLICT (group_key, key) DO NOTHING`,
        [g, k, v],
      );
    }
  });
  bustCache();
  return rows.length;
}

// ── Write path: save_group / list_models / test_group ────────────────────────
// Faithful port of the corresponding `src/admin_settings.py` functions.

function valueToStr(f: SettingsField, value: string | number | boolean): string {
  if (f.type === "bool") return value ? "true" : "false";
  return String(value);
}

/** Mirror `_audit_payload`: secret keys masked to "***"; rest verbatim. */
function auditPayload(spec: SettingsGroupSpec, toWrite: [string, string, string, string][]): string {
  const secretKeys = new Set(spec.fields.filter((f) => f.secret).map((f) => f.key));
  const changed: Record<string, string> = {};
  for (const [, key, val] of toWrite) {
    changed[key] = secretKeys.has(key) ? "***" : val;
  }
  return JSON.stringify({ changed_keys: Object.keys(changed), values: changed });
}

/** Mirror Python's list repr `['a', 'b']` used in the enum-validation error. */
function pyListRepr(items: string[]): string {
  return "[" + items.map((s) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`).join(", ") + "]";
}

/**
 * Validate and persist changed values for a group. Secret fields whose incoming
 * value equals the mask placeholder are left untouched. Returns the new masked
 * values for the group. Throws on unknown group/field/enum (→ 400 upstream).
 */
export async function saveGroup(
  group: string,
  values: Record<string, unknown>,
  updatedBy: string,
): Promise<Record<string, string | number | boolean>> {
  const spec = SETTINGS_SCHEMA[group];
  if (!spec) throw new Error(`Unknown settings group: ${group}`);

  const toWrite: [string, string, string, string][] = [];
  for (const f of spec.fields) {
    const key = f.key;
    if (!(key in values)) continue;
    const incoming = values[key];
    // Preserve secret if the UI sent back the mask unchanged.
    if (f.secret && (incoming === SECRET_MASK || incoming === "")) {
      if (incoming === SECRET_MASK) continue; // keep existing
    }
    // Validate enum options.
    if (f.options !== null && !f.options.includes(String(incoming))) {
      throw new Error(`${group}.${key}: '${incoming}' is not one of ${pyListRepr(f.options)}`);
    }
    const coerced = coerce(f, incoming);
    toWrite.push([group, key, valueToStr(f, coerced), updatedBy]);
  }

  if (toWrite.length > 0) {
    await withTransaction(async (client) => {
      for (const [g, key, val, by] of toWrite) {
        await client.query(
          `INSERT INTO admin.app_settings (group_key, key, value, updated_by, updated_at)
             VALUES ($1, $2, $3, $4, NOW())
           ON CONFLICT (group_key, key)
           DO UPDATE SET value = EXCLUDED.value,
                         updated_by = EXCLUDED.updated_by,
                         updated_at = NOW()`,
          [g, key, val, by],
        );
      }
      await client.query(
        `INSERT INTO admin.admin_audit_log
           (admin_user, action, target_type, target_id, payload_json)
         VALUES ($1, 'update_settings', 'settings_group', $2, $3::jsonb)`,
        [updatedBy, group, auditPayload(spec, toWrite)],
      );
    });
  }
  bustCache(group);
  return getGroup(group, { revealSecrets: false });
}

// ── Provider test / model-list helpers (operate on draft, unsaved values) ─────

class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    readonly bodyText: string,
  ) {
    super(`HTTP ${status}`);
    this.name = "HttpStatusError";
  }
}

/**
 * Human-readable error string that is never empty. For HTTP errors, surface the
 * provider's response body (e.g. OpenAI's "Unsupported parameter ...") instead
 * of the opaque status. Mirrors `admin_settings._err`.
 */
function errStr(exc: unknown): string {
  if (exc instanceof HttpStatusError) {
    let detail = "";
    try {
      const j = JSON.parse(exc.bodyText) as unknown;
      const err = j && typeof j === "object" ? (j as Record<string, unknown>).error : null;
      if (err && typeof err === "object") detail = String((err as Record<string, unknown>).message ?? "") || "";
      else if (typeof err === "string") detail = err;
      if (!detail && j && typeof j === "object") detail = String((j as Record<string, unknown>).message ?? "") || "";
    } catch {
      /* not JSON */
    }
    if (!detail) detail = (exc.bodyText || "").trim().slice(0, 300);
    return detail ? `HTTP ${exc.status}: ${detail}` : `HTTP ${exc.status}`;
  }
  const s = String((exc as Error)?.message ?? "").trim();
  return s ? s : ((exc as Error)?.constructor?.name ?? "Error");
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/** GET JSON with a timeout; throws HttpStatusError on non-2xx (mirror raise_for_status). */
async function httpGetJson(url: string, headers: Record<string, string>, timeoutMs: number): Promise<unknown> {
  const r = await fetchWithTimeout(url, { method: "GET", headers }, timeoutMs);
  if (!r.ok) throw new HttpStatusError(r.status, await r.text());
  return r.json();
}

async function httpPostJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
): Promise<unknown> {
  const r = await fetchWithTimeout(
    url,
    { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) },
    timeoutMs,
  );
  if (!r.ok) throw new HttpStatusError(r.status, await r.text());
  return r.json();
}

/**
 * Fill masked/blank secret fields in a draft from the stored DB values, so
 * 'test before save' works without forcing the user to retype secrets.
 */
export async function resolveDraft(
  group: string,
  draft: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const stored = await getGroup(group, { revealSecrets: true });
  const spec = SETTINGS_SCHEMA[group];
  const out: Record<string, unknown> = { ...draft };
  for (const f of spec?.fields ?? []) {
    if (f.secret) {
      const v = out[f.key];
      if (v === null || v === undefined || v === "" || v === SECRET_MASK) {
        out[f.key] = stored[f.key] ?? "";
      }
    }
  }
  return out;
}

interface ModelsResult {
  ok: boolean;
  models: string[];
  message: string;
}

/** List models the configured server currently has, for the model picker. */
export async function listModels(group: string, draftIn: Record<string, unknown>): Promise<ModelsResult> {
  const spec = SETTINGS_SCHEMA[group];
  if (!spec) throw new Error(`Unknown settings group: ${group}`);
  const draft = await resolveDraft(group, draftIn);

  if (group === "embedding") {
    const provider = String((draft.provider ?? "ollama") || "ollama").toLowerCase();
    const base = String((draft.base_url ?? "") || "").replace(/\/+$/, "");
    const key = String((draft.api_key ?? "") || "");
    if (provider === "openai") return openaiModels(base, key);
    if (provider === "google") return googleEmbeddingModels(key);
    return ollamaTags(base);
  }
  if (group === "analysis") {
    const provider = String((draft.provider ?? "openai") || "openai").toLowerCase();
    const base = String((draft.base_url ?? "") || "").replace(/\/+$/, "");
    if (provider === "ollama") return ollamaTags(base);
    return openaiModels(base, String((draft.api_key ?? "") || ""));
  }
  if (group === "ocr") {
    const ip = String((draft.server_ip ?? "") || "").trim();
    const port = Number(draft.port ?? 8002) || 8002;
    return openaiModels(`http://${ip}:${port}`, "");
  }
  return { ok: false, models: [], message: "This service has no model list." };
}

async function ollamaTags(baseUrl: string): Promise<ModelsResult> {
  if (!baseUrl) return { ok: false, models: [], message: "Base URL is empty." };
  try {
    const j = (await httpGetJson(`${baseUrl}/api/tags`, {}, 8000)) as Record<string, unknown>;
    const models = (Array.isArray(j.models) ? j.models : []) as Record<string, unknown>[];
    const names = models.map((m) => String(m.name ?? "")).filter((n) => n);
    return {
      ok: true,
      models: [...names].sort(),
      message: names.length ? `${names.length} model(s) found.` : "No models loaded on the server.",
    };
  } catch (exc) {
    return { ok: false, models: [], message: `Failed to list models: ${errStr(exc)}` };
  }
}

async function openaiModels(baseUrl: string, apiKey: string): Promise<ModelsResult> {
  if (!baseUrl) return { ok: false, models: [], message: "Base URL is empty." };
  const headers: Record<string, string> = apiKey && apiKey !== "0" ? { Authorization: `Bearer ${apiKey}` } : {};
  try {
    const j = (await httpGetJson(`${baseUrl.replace(/\/+$/, "")}/models`, headers, 8000)) as Record<string, unknown>;
    const data = (Array.isArray(j.data) ? j.data : []) as Record<string, unknown>[];
    const names = data.map((m) => String(m.id ?? "")).filter((n) => n);
    return {
      ok: true,
      models: [...names].sort(),
      message: names.length ? `${names.length} model(s) found.` : "Server returned no models.",
    };
  } catch (exc) {
    return { ok: false, models: [], message: `Failed to list models: ${errStr(exc)}` };
  }
}

const GOOGLE_BASE = "https://generativelanguage.googleapis.com";

async function googleEmbeddingModels(apiKey: string): Promise<ModelsResult> {
  if (!apiKey) return { ok: false, models: [], message: "API key is required for Google." };
  try {
    const j = (await httpGetJson(`${GOOGLE_BASE}/v1beta/models`, { "x-goog-api-key": apiKey }, 8000)) as Record<
      string,
      unknown
    >;
    const models = (Array.isArray(j.models) ? j.models : []) as Record<string, unknown>[];
    const names: string[] = [];
    for (const m of models) {
      const methods = (Array.isArray(m.supportedGenerationMethods) ? m.supportedGenerationMethods : []) as string[];
      if (methods.includes("embedContent") || methods.includes("batchEmbedContents")) {
        const name = String(m.name ?? "");
        names.push(name.startsWith("models/") ? name.slice("models/".length) : name);
      }
    }
    return {
      ok: true,
      models: [...names].sort(),
      message: names.length ? `${names.length} embedding model(s) found.` : "No embedding models found.",
    };
  } catch (exc) {
    return { ok: false, models: [], message: `Failed to list models: ${errStr(exc)}` };
  }
}

interface TestResult {
  ok: boolean;
  message: string;
  details?: Record<string, unknown>;
}

/** Run a real test against the draft config. Returns {ok, message, details}. */
export async function testGroup(group: string, draftIn: Record<string, unknown>): Promise<TestResult> {
  const draft = await resolveDraft(group, draftIn);
  if (group === "embedding") return testEmbedding(draft);
  if (group === "analysis") return testAnalysis(draft);
  if (group === "ocr") return testOcr(draft);
  if (group === "minio") return testMinio(draft);
  if (group === "tfda") return testTfda(draft);
  return { ok: false, message: "This service has no test." };
}

async function testEmbedding(draft: Record<string, unknown>): Promise<TestResult> {
  const provider = String((draft.provider ?? "ollama") || "ollama").toLowerCase();
  const base = String((draft.base_url ?? "") || "").replace(/\/+$/, "");
  const model = String((draft.model ?? "") || "");
  const key = String((draft.api_key ?? "") || "");
  const wantDim = Math.trunc(Number(draft.dimensions ?? 0)) || 0;
  if (!model) return { ok: false, message: "Model is required." };
  if ((provider === "openai" || provider === "google") && !key) {
    return { ok: false, message: "API key is required for this provider." };
  }
  if ((provider === "ollama" || provider === "openai") && !base) {
    return { ok: false, message: "Base URL is required." };
  }
  // Generous timeout: a cold embedding model can take 10-30s to load on first call.
  const timeout = Math.max(Number(draft.timeout ?? 30) || 30, 90.0) * 1000;
  try {
    const t0 = performance.now();
    let vec: unknown;
    if (provider === "openai") {
      const url = base.endsWith("/embeddings") ? base : `${base}/embeddings`;
      const body: Record<string, unknown> = { model, input: ["health check"], encoding_format: "float" };
      if (wantDim && model.startsWith("text-embedding-3")) body.dimensions = wantDim;
      const authHeaders: Record<string, string> = key ? { Authorization: `Bearer ${key}` } : {};
      const j = (await httpPostJson(url, authHeaders, body, timeout)) as Record<string, unknown>;
      const data = (Array.isArray(j.data) ? j.data : [{}]) as Record<string, unknown>[];
      vec = data[0]?.embedding;
    } else if (provider === "google") {
      const mp = model.startsWith("models/") ? model : `models/${model}`;
      const req: Record<string, unknown> = { content: { parts: [{ text: "health check" }] } };
      if (wantDim) req.outputDimensionality = wantDim;
      const j = (await httpPostJson(
        `${GOOGLE_BASE}/v1beta/${mp}:embedContent`,
        { "x-goog-api-key": key },
        req,
        timeout,
      )) as Record<string, unknown>;
      vec = (j.embedding as Record<string, unknown> | undefined)?.values;
    } else {
      const j = (await httpPostJson(`${base}/api/embed`, {}, { model, input: ["health check"] }, timeout)) as Record<
        string,
        unknown
      >;
      const embs = (Array.isArray(j.embeddings) ? j.embeddings : []) as unknown[];
      vec = embs.length ? embs[0] : null;
    }
    const ms = Math.trunc(performance.now() - t0);
    if (!vec || !Array.isArray(vec) || vec.length === 0) {
      return { ok: false, message: "Provider returned no embedding vector." };
    }
    const dim = vec.length;
    const msg = `Embedded sample in ${ms} ms — vector dim = ${dim}.`;
    if (wantDim && dim !== wantDim) {
      return {
        ok: false,
        message: msg + ` ⚠ Configured dimensions = ${wantDim} does not match!`,
        details: { returned_dim: dim, configured_dim: wantDim, latency_ms: ms },
      };
    }
    return { ok: true, message: msg, details: { returned_dim: dim, latency_ms: ms } };
  } catch (exc) {
    return { ok: false, message: `Embedding test failed: ${errStr(exc)}` };
  }
}

async function testAnalysis(draft: Record<string, unknown>): Promise<TestResult> {
  const provider = String((draft.provider ?? "openai") || "openai").toLowerCase();
  const base = String((draft.base_url ?? "") || "").replace(/\/+$/, "");
  const model = String((draft.model ?? "") || "");
  const apiKey = String((draft.api_key ?? "") || "");
  if (!base || !model) return { ok: false, message: "Base URL and model are required." };
  try {
    const t0 = performance.now();
    let text: string;
    if (provider === "ollama") {
      const j = (await httpPostJson(
        `${base}/api/chat`,
        {},
        { model, stream: false, messages: [{ role: "user", content: "Reply with the word OK." }] },
        20000,
      )) as Record<string, unknown>;
      text = String(((j.message as Record<string, unknown> | undefined) ?? {}).content ?? "");
    } else {
      const headers: Record<string, string> = apiKey && apiKey !== "0" ? { Authorization: `Bearer ${apiKey}` } : {};
      const body: Record<string, unknown> = {
        model,
        max_tokens: 16,
        messages: [{ role: "user", content: "Reply with the word OK." }],
      };
      const hdrs = { ...headers, "content-type": "application/json" };
      let r = await fetchWithTimeout(
        `${base}/chat/completions`,
        { method: "POST", headers: hdrs, body: JSON.stringify(body) },
        20000,
      );
      // Newer OpenAI models reject `max_tokens` (400) and require
      // `max_completion_tokens`. Retry once with the new parameter.
      if (r.status === 400) {
        const errText = await r.text();
        if (errText.includes("max_completion_tokens")) {
          delete body.max_tokens;
          body.max_completion_tokens = 256;
          r = await fetchWithTimeout(
            `${base}/chat/completions`,
            { method: "POST", headers: hdrs, body: JSON.stringify(body) },
            20000,
          );
        } else {
          throw new HttpStatusError(r.status, errText);
        }
      }
      if (!r.ok) throw new HttpStatusError(r.status, await r.text());
      const j = (await r.json()) as Record<string, unknown>;
      const choices = (j.choices as Record<string, unknown>[]) ?? [];
      text = String(((choices[0]?.message as Record<string, unknown>) ?? {}).content ?? "");
    }
    const ms = Math.trunc(performance.now() - t0);
    return {
      ok: true,
      message: `Completion in ${ms} ms.`,
      details: { sample: (text || "").trim().slice(0, 200), latency_ms: ms },
    };
  } catch (exc) {
    return { ok: false, message: `Analysis test failed: ${errStr(exc)}` };
  }
}

async function testOcr(draft: Record<string, unknown>): Promise<TestResult> {
  const ip = String((draft.server_ip ?? "") || "").trim();
  const port = Number(draft.port ?? 8002) || 8002;
  const base = `http://${ip}:${port}`;
  const model = String((draft.model ?? "") || "");
  try {
    const j = (await httpGetJson(`${base}/v1/models`, {}, 8000)) as Record<string, unknown>;
    const data = (Array.isArray(j.data) ? j.data : []) as Record<string, unknown>[];
    const names = data.map((m) => String(m.id ?? ""));
    const present = model ? names.includes(model) : true;
    if (names.length === 0) {
      return { ok: false, message: `OCR server at ${base} reachable but reports no models.` };
    }
    if (model && !present) {
      return {
        ok: false,
        message: `OCR server reachable, but model '${model}' is not loaded.`,
        details: { available: names },
      };
    }
    return {
      ok: true,
      message: `OCR server reachable at ${base}; model present.`,
      details: { available: names },
    };
  } catch (exc) {
    return { ok: false, message: `OCR test failed: ${errStr(exc)}` };
  }
}

async function testMinio(draft: Record<string, unknown>): Promise<TestResult> {
  try {
    const { Client: MinioClient } = await import("minio");
    const endpoint = String((draft.endpoint ?? "") || "").trim();
    const accessKey = String((draft.access_key ?? "") || "").trim();
    const secretKey = String((draft.secret_key ?? "") || "").trim();
    const bucketName = String((draft.bucket ?? "") || "").trim();
    const secure =
      draft.secure === true ||
      ["1", "true", "yes", "on"].includes(String(draft.secure ?? "").trim().toLowerCase());
    const enabled_ = Boolean(endpoint && accessKey && secretKey && bucketName);
    if (!enabled_) {
      return { ok: false, message: "MinIO not reachable / bucket missing." };
    }
    const [host, portStr] = endpoint.split(":");
    const port = portStr ? Number.parseInt(portStr, 10) : secure ? 443 : 80;
    const client = new MinioClient({ endPoint: host, port, useSSL: secure, accessKey, secretKey });
    const exists = await client.bucketExists(bucketName);
    if (!exists) await client.makeBucket(bucketName);
    return { ok: true, message: `Connected; bucket '${bucketName}' available.` };
  } catch (exc) {
    return { ok: false, message: `MinIO test failed: ${errStr(exc)}` };
  }
}

async function testTfda(draft: Record<string, unknown>): Promise<TestResult> {
  const base = String((draft.base_url ?? "") || "").replace(/\/+$/, "");
  if (!base) return { ok: false, message: "Base URL is required." };
  try {
    const timeout = (Number(draft.http_timeout ?? 10) || 10) * 1000;
    const t0 = performance.now();
    const r = await fetchWithTimeout(base, { method: "GET", redirect: "follow" }, timeout);
    const ms = Math.trunc(performance.now() - t0);
    return {
      ok: r.status < 500,
      message: `GET ${base} → HTTP ${r.status} in ${ms} ms.`,
      details: { status_code: r.status, latency_ms: ms },
    };
  } catch (exc) {
    return { ok: false, message: `TFDA test failed: ${errStr(exc)}` };
  }
}
