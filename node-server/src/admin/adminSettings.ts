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
import { logWarning } from "../logger.js";
import {
  exportProfiles,
  getProfile,
  importProfiles,
  type LlmProfile,
  type ProfileKind,
} from "./llmProfiles.js";

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
  /** Per-provider default, keyed by the value of the group's `provider_field`. */
  provider_defaults: Record<string, string> | null;
  /** Value must be an absolute http(s) URL; enforced on seed and on save. */
  is_url: boolean;
}

export interface SettingsGroupSpec {
  label: string;
  description: string;
  provider_field?: string;
  test?: string;
  /**
   * Whether a fresh install seeds this group from `.env`. False for the groups an
   * operator must configure in the admin console (the LM/OCR endpoints): they have
   * no sensible machine-wide default, and seeding them from env is what let a
   * typo'd value become permanent state. Infrastructure groups (MinIO, TFDA,
   * registry, worker) are still seeded — compose owns their credentials and the
   * app must come up usable without a manual step.
   */
  seed_from_env?: boolean;
  /**
   * Infrastructure the deployment owns, not a knob an operator turns: shown and
   * testable, but never writable through the API. Editing MinIO's endpoint here
   * would not move the running container — it would just point the app somewhere
   * else and orphan every object key already stored against the old bucket. The
   * worker's cadence is only read at worker start-up, so a form that appeared to
   * change it live would simply be lying. Both come from `.env` / compose.
   */
  readonly?: boolean;
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
    provider_defaults?: Record<string, string> | null;
    is_url?: boolean;
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
    provider_defaults: opts.provider_defaults ?? null,
    is_url: Boolean(opts.is_url),
  };
}

/** Absolute http(s) URL check — the guard that keeps junk like `ho` out of the DB. */
export function isValidHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return (u.protocol === "http:" || u.protocol === "https:") && u.host !== "";
  } catch {
    return false;
  }
}

/** Official OpenAI API root; also the fallback for any OpenAI-compatible server. */
const OPENAI_BASE_URL = "https://api.openai.com/v1";
/** Ollama's documented default listen address. */
const OLLAMA_BASE_URL = "http://localhost:11434";

// ── Registry — mirrors admin_settings.SETTINGS_SCHEMA exactly. ───────────────
export const SETTINGS_SCHEMA: Record<string, SettingsGroupSpec> = {
  embedding: {
    label: "Embedding",
    description:
      "How embed requests are spread across the embedding profiles, plus the settings every " +
      "profile must share. Endpoints themselves are the profiles below.",
    seed_from_env: false,
    fields: [
      field("strategy", "str", "failover", "EMBEDDING_STRATEGY", "Strategy", {
        options: ["failover", "weighted"],
        help:
          "failover = always the highest-priority healthy profile; weighted = spread by weight, " +
          "still falling back on failure.",
      }),
      field("dimensions", "int", 1024, "OLLAMA_EMBED_DIMENSIONS", "Dimensions", {
        help:
          "Vector size stored in pgvector. Must match what the model returns — and every stored " +
          "vector, from every module, shares this one size.",
      }),
      field("timeout", "int", 30, "OLLAMA_EMBED_TIMEOUT", "Timeout (s)"),
      field("batch_size", "int", 32, "OLLAMA_EMBED_BATCH_SIZE", "Batch size"),
    ],
  },
  analysis: {
    label: "Analysis LM",
    description:
      "How drug-insert analysis calls are spread across the Analysis LM profiles. Endpoints, " +
      "models and keys are the profiles below.",
    seed_from_env: false,
    fields: [
      field("strategy", "str", "failover", "DRUG_ANALYSIS_STRATEGY", "Strategy", {
        options: ["failover", "weighted"],
        help:
          "failover = always the highest-priority healthy profile; weighted = spread by weight, " +
          "still falling back on failure. Either way a failed call moves on to the next profile.",
      }),
      field("max_retries", "int", 3, "DRUG_ANALYSIS_MAX_RETRIES", "Max retries", {
        help: "Attempts at getting well-formed JSON out of a profile before moving to the next one.",
      }),
    ],
  },
  ocr: {
    label: "OCR Server",
    description: "Vision/OCR backend for drug insert PDFs.",
    provider_field: "provider",
    test: "ocr",
    seed_from_env: false,
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
    ],
  },
  minio: {
    label: "MinIO Object Storage",
    description:
      "Object storage for uploaded sources and drug assets. Owned by the deployment " +
      "(.env / compose) — shown here so you can test it, not change it.",
    test: "minio",
    readonly: true,
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
      field("base_url", "str", "https://mcp.fda.gov.tw", "DRUG_TFDA_BASE_URL", "Base URL", { is_url: true }),
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
    description:
      "Background worker loop cadence, read once when the worker starts. Owned by the " +
      "deployment (.env / compose); change it there and restart the worker.",
    readonly: true,
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

function defaultAsStr(f: SettingsField, provider?: string): string {
  const d = resolveDefault(f, provider);
  if (typeof d === "boolean") return d ? "true" : "false";
  return String(d);
}

/**
 * The default for a field, specialised for the group's selected provider. A
 * fresh DB (or a row we refuse to trust) must never fall back to a value that
 * belongs to a different provider — an OpenAI base URL under Ollama is as
 * broken as no value at all.
 */
function resolveDefault(f: SettingsField, provider?: string): string | number | boolean {
  if (f.provider_defaults && provider && provider in f.provider_defaults) {
    return f.provider_defaults[provider];
  }
  return f.default;
}

/** The provider currently selected for a group (stored row → env → schema default). */
function providerOf(spec: SettingsGroupSpec, stored: Record<string, string | null>): string | undefined {
  const key = spec.provider_field;
  if (!key) return undefined;
  const f = spec.fields.find((x) => x.key === key);
  if (!f) return undefined;
  const raw = stored[key];
  if (raw !== null && raw !== undefined && raw !== "") return String(raw);
  return String(f.default);
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

  const provider = providerOf(spec, stored);
  const out: Record<string, string | number | boolean> = {};
  for (const f of spec.fields) {
    const raw = f.key in stored ? stored[f.key] : null;
    let value = raw === null || raw === undefined ? resolveDefault(f, provider) : coerce(f, raw);
    // A stored URL that isn't one (e.g. the literal `ho` a bad .env once seeded)
    // is unusable — surface the provider default instead of the garbage.
    if (f.is_url && typeof value === "string" && value !== "" && !isValidHttpUrl(value)) {
      value = resolveDefault(f, provider);
    }
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
    provider_defaults: f.provider_defaults,
    is_url: f.is_url,
    value: valuesMasked[f.key],
  }));
  return {
    group,
    label: spec.label ?? group,
    description: spec.description ?? "",
    provider_field: spec.provider_field ?? null,
    test: spec.test ?? null,
    readonly: spec.readonly ?? false,
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
 * Serialize a `getAll()` payload with Python-parity number formatting. A `float`
 * field whose value is a whole number must render as `N.0` (Python
 * `json.dumps(float(3))` → `"3.0"`), which JS `JSON.stringify` drops to `3`;
 * `json.loads` then yields int vs float and the admin REST parity flags it.
 * Non-integer floats (`0.1`) and all other types already match, so only
 * integer-valued floats are tagged. Used by the GET /admin/api/settings route.
 */
export function serializeSettingsResponse(payload: { groups: Record<string, unknown>[] }): string {
  const FLOAT_TAG = "@@FLOAT@@";
  const tagged = {
    groups: (payload.groups ?? []).map((g) => {
      const grp = g as Record<string, unknown>;
      const fields = (grp.fields as Array<Record<string, unknown>>) ?? [];
      return {
        ...grp,
        fields: fields.map((f) =>
          f.type === "float" && typeof f.value === "number" && Number.isInteger(f.value)
            ? { ...f, value: `${FLOAT_TAG}${f.value}` }
            : f,
        ),
      };
    }),
  };
  // Unwrap the tagged placeholders into bare decimal literals (e.g. `3` → `3.0`).
  return JSON.stringify(tagged).replace(new RegExp(`"${FLOAT_TAG}(-?\\d+)"`, "g"), "$1.0");
}

/**
 * The value a field seeds with: the env var if it is usable, else the (provider-
 * specialised) schema default. Env is operator-supplied and unvalidated — a
 * malformed URL there used to be copied verbatim into `admin.app_settings` and
 * then shown in the admin UI forever, since seeding only ever runs once.
 */
function seedValue(f: SettingsField, provider?: string): string {
  const envVal = process.env[f.env];
  if (envVal === undefined) return defaultAsStr(f, provider);
  const trimmed = envVal.trim();
  if (f.is_url && trimmed !== "" && !isValidHttpUrl(trimmed)) {
    logWarning("settings_seed_invalid_url", { env: f.env, value: trimmed });
    return defaultAsStr(f, provider);
  }
  // `0` was the historical "no API key" placeholder; it is not a key.
  if (f.secret && trimmed === "0") return "";
  return envVal;
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
    if (spec.seed_from_env === false) continue; // operator configures these in the UI
    // Env is the seed source, so the provider we specialise defaults on is the
    // env-selected one (not whatever the schema happens to default to).
    const envStored: Record<string, string | null> = {};
    if (spec.provider_field) {
      const pf = spec.fields.find((x) => x.key === spec.provider_field);
      if (pf && process.env[pf.env] !== undefined) envStored[pf.key] = String(process.env[pf.env]);
    }
    const provider = providerOf(spec, envStored);
    for (const f of spec.fields) {
      rows.push([group, f.key, seedValue(f, provider)]);
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
    await repairUnusableRows(client);
  });
  bustCache();
  return rows.length;
}

/**
 * Rewrite rows an earlier seed made unusable: a non-URL in a URL field (a typo'd
 * `.env` used to be copied in verbatim and stuck there forever, since seeding is
 * ON CONFLICT DO NOTHING) and the `0` placeholder in a secret field. Idempotent —
 * a row that is already valid is never touched, so custom values survive.
 */
async function repairUnusableRows(client: {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: { key: string; value: string | null }[] }>;
}): Promise<void> {
  for (const [group, spec] of Object.entries(SETTINGS_SCHEMA)) {
    const res = await client.query("SELECT key, value FROM admin.app_settings WHERE group_key = $1", [group]);
    const stored: Record<string, string | null> = {};
    for (const r of res.rows) stored[r.key] = r.value;
    const provider = providerOf(spec, stored);
    for (const f of spec.fields) {
      const raw = stored[f.key];
      if (raw === null || raw === undefined) continue;
      let fixed: string | null = null;
      if (f.is_url && raw.trim() !== "" && !isValidHttpUrl(raw.trim())) {
        fixed = defaultAsStr(f, provider);
      } else if (f.secret && raw.trim() === "0") {
        fixed = "";
      }
      if (fixed === null) continue;
      logWarning("settings_repair_unusable_value", { group, key: f.key });
      await client.query(
        "UPDATE admin.app_settings SET value = $1, updated_at = NOW(), updated_by = 'system' " +
          "WHERE group_key = $2 AND key = $3",
        [fixed, group, f.key],
      );
    }
  }
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
  if (spec.readonly) {
    throw new Error(
      `${group} is managed by the deployment (.env / compose) and cannot be changed here.`,
    );
  }

  const toWrite: [string, string, string, string][] = [];
  for (const f of spec.fields) {
    const key = f.key;
    if (!(key in values)) continue;
    const incoming = values[key];
    // A secret is only ever *replaced*, never cleared by omission: the UI renders
    // it blank (or masked) whether or not one is stored, so an empty/masked value
    // means "unchanged", not "delete the key I saved last week".
    if (f.secret) {
      const s = incoming === null || incoming === undefined ? "" : String(incoming).trim();
      if (s === "" || s === SECRET_MASK) continue;
    }
    // Validate enum options.
    if (f.options !== null && !f.options.includes(String(incoming))) {
      throw new Error(`${group}.${key}: '${incoming}' is not one of ${pyListRepr(f.options)}`);
    }
    if (f.is_url) {
      const s = String(incoming ?? "").trim();
      if (s !== "" && !isValidHttpUrl(s)) {
        throw new Error(`${group}.${key}: '${incoming}' is not a valid http(s) URL`);
      }
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

/**
 * Has an operator actually configured this group? True once any row exists for
 * it. `getGroup` always answers with schema defaults so the form has something
 * to prefill, which means callers cannot tell "left at the default" from "never
 * set" — but a probe or a drug job must not go dial a default endpoint nobody
 * chose. They ask this instead.
 */
export async function isGroupConfigured(group: string): Promise<boolean> {
  const res = await query<{ one: number }>(
    "SELECT 1 AS one FROM admin.app_settings WHERE group_key = $1 LIMIT 1",
    [group],
  );
  return res.rows.length > 0;
}

// ── Export / import ──────────────────────────────────────────────────────────

export const SETTINGS_EXPORT_VERSION = 1;

export interface SettingsExport {
  version: number;
  exported_at: string;
  groups: Record<string, Record<string, string>>;
  /** LLM endpoints (admin.llm_profiles), keys included — see exportSettings. */
  profiles: Omit<LlmProfile, "id">[];
}

/**
 * Every stored setting, as a portable document. Secrets are included in the
 * clear — the file is meant to restore a working configuration verbatim, and a
 * redacted key would restore a broken one. Callers (the admin route) must treat
 * the result as a credential-bearing artefact.
 *
 * Only keys that exist in the DB are exported: an un-configured group stays
 * absent rather than being materialised as a wall of defaults.
 */
export async function exportSettings(): Promise<SettingsExport> {
  const res = await query<{ group_key: string; key: string; value: string | null }>(
    "SELECT group_key, key, value FROM admin.app_settings ORDER BY group_key, key",
  );
  const groups: Record<string, Record<string, string>> = {};
  for (const r of res.rows) {
    const spec = SETTINGS_SCHEMA[r.group_key];
    if (!spec || !spec.fields.some((f) => f.key === r.key)) continue; // drop retired keys
    // Deployment-owned groups come from .env on every install; carrying them in a
    // portable document would just re-point a *different* install at this one's
    // MinIO (and hand over its credentials).
    if (spec.readonly) continue;
    (groups[r.group_key] ??= {})[r.key] = r.value ?? "";
  }
  return {
    version: SETTINGS_EXPORT_VERSION,
    exported_at: new Date().toISOString(),
    groups,
    profiles: await exportProfiles(),
  };
}

export interface SettingsImportResult {
  ok: boolean;
  imported: number;
  groups: string[];
  profiles: number;
  skipped: string[];
}

/**
 * Apply an exported document. Every value goes through the same validation as a
 * form save (enum, URL, type coercion), so a hand-edited file cannot write junk
 * that the UI would then have to defend against. Unknown groups/keys are skipped
 * and reported rather than failing the whole import — an export from an older
 * version stays usable.
 *
 * Unlike a form save, a secret present in the document *is* written: the file is
 * the operator's own backup, and restoring it must restore the keys.
 */
export async function importSettings(
  doc: unknown,
  updatedBy: string,
): Promise<SettingsImportResult> {
  const root = (doc ?? {}) as Record<string, unknown>;
  const version = Number(root.version ?? 0);
  if (!Number.isFinite(version) || version < 1 || version > SETTINGS_EXPORT_VERSION) {
    throw new Error(`Unsupported settings export version: ${String(root.version)}`);
  }
  const groupsIn = (root.groups ?? {}) as Record<string, unknown>;
  if (typeof groupsIn !== "object" || Array.isArray(groupsIn)) {
    throw new Error("Malformed export: 'groups' must be an object");
  }

  const skipped: string[] = [];
  const toWrite: [string, string, string][] = [];
  const touched = new Set<string>();

  for (const [group, valuesIn] of Object.entries(groupsIn)) {
    const spec = SETTINGS_SCHEMA[group];
    if (!spec || spec.readonly || typeof valuesIn !== "object" || valuesIn === null) {
      skipped.push(group);
      continue;
    }
    for (const [key, rawValue] of Object.entries(valuesIn as Record<string, unknown>)) {
      const f = spec.fields.find((x) => x.key === key);
      if (!f) {
        skipped.push(`${group}.${key}`);
        continue;
      }
      if (f.options !== null && !f.options.includes(String(rawValue))) {
        throw new Error(`${group}.${key}: '${String(rawValue)}' is not one of ${pyListRepr(f.options)}`);
      }
      if (f.is_url) {
        const s = String(rawValue ?? "").trim();
        if (s !== "" && !isValidHttpUrl(s)) {
          throw new Error(`${group}.${key}: '${String(rawValue)}' is not a valid http(s) URL`);
        }
      }
      toWrite.push([group, key, valueToStr(f, coerce(f, rawValue))]);
      touched.add(group);
    }
  }

  if (toWrite.length > 0) {
    await withTransaction(async (client) => {
      for (const [g, key, val] of toWrite) {
        await client.query(
          `INSERT INTO admin.app_settings (group_key, key, value, updated_by, updated_at)
             VALUES ($1, $2, $3, $4, NOW())
           ON CONFLICT (group_key, key)
           DO UPDATE SET value = EXCLUDED.value,
                         updated_by = EXCLUDED.updated_by,
                         updated_at = NOW()`,
          [g, key, val, updatedBy],
        );
      }
      await client.query(
        `INSERT INTO admin.admin_audit_log
           (admin_user, action, target_type, target_id, payload_json)
         VALUES ($1, 'import_settings', 'settings', 'all', $2::jsonb)`,
        [
          updatedBy,
          JSON.stringify({
            groups: [...touched].sort(),
            key_count: toWrite.length,
            skipped,
          }),
        ],
      );
    });
  }
  // Profiles are replaced wholesale (they are a list, not a merge), and validated
  // by importProfiles — including the "one embedding model" rule.
  const profileCount = await importProfiles((root as { profiles?: unknown }).profiles, updatedBy);

  bustCache();
  return {
    ok: true,
    imported: toWrite.length,
    groups: [...touched].sort(),
    profiles: profileCount,
    skipped,
  };
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
  const headers: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
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
  if (group === "ocr") return testOcr(draft);
  if (group === "minio") return testMinio(draft);
  if (group === "tfda") return testTfda(draft);
  return { ok: false, message: "This service has no test." };
}

// ── Per-profile model list / test (the endpoint now lives on the profile) ─────

/**
 * A profile draft as the admin form sends it. A blank `api_key` means "use the
 * key already stored on this profile" (`id`), so the operator can test an edit
 * without retyping the secret — the same rule the settings form follows.
 */
export interface ProfileDraft {
  id?: number;
  kind: ProfileKind;
  provider: string;
  base_url: string;
  api_key?: string;
  model?: string;
  params?: Record<string, unknown>;
}

async function resolveProfileKey(draft: ProfileDraft): Promise<string> {
  const typed = String(draft.api_key ?? "").trim();
  if (typed && typed !== SECRET_MASK) return typed;
  if (draft.id !== undefined && draft.id > 0) {
    const stored = await getProfile(draft.id);
    if (stored) return stored.api_key;
  }
  return "";
}

/** Models the profile's server actually serves, for the model picker. */
export async function listProfileModels(draft: ProfileDraft): Promise<ModelsResult> {
  const provider = String(draft.provider || "").toLowerCase();
  const base = String(draft.base_url || "").replace(/\/+$/, "");
  const key = await resolveProfileKey(draft);
  if (provider === "google") return googleEmbeddingModels(key);
  if (provider === "ollama") return ollamaTags(base);
  return openaiModels(base, key);
}

/** Run a real call against one profile's endpoint. */
export async function testProfile(draft: ProfileDraft): Promise<TestResult> {
  const key = await resolveProfileKey(draft);
  const common = {
    provider: draft.provider,
    base_url: draft.base_url,
    model: draft.model,
    api_key: key,
  };
  if (draft.kind === "embedding") {
    const emb = await getGroup("embedding");
    return testEmbedding({ ...common, dimensions: emb.dimensions, timeout: emb.timeout });
  }
  return testAnalysis(common);
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
      const headers: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
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
