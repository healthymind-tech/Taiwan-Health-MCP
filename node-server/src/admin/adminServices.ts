/**
 * Service-probe read surface for the admin console.
 *
 * Faithful port of the read path in `src/admin_services.py`
 * (`SERVICE_PROBE_ORDER`, `SERVICE_PROBE_META`, `_normalize_probe_row`,
 * `_placeholder_probe_row`, `serialize_service_probes`, `list_service_probes`).
 * The active probing logic (which writes admin.service_probes) belongs to the
 * worker chunk; this only renders the cached rows for `GET /admin/api/services`.
 *
 * `checked_at` / `last_checked_at` are real (non-volatile) timestamps shared via
 * the DB, so they go through the Postgres-rendered isoformat helper to match
 * asyncpg's microsecond `+00:00`. `generated_at` is volatile (now()).
 */

import { query, withTransaction } from "../db.js";
import { tsIsoExpr, pyIso } from "./adminJobs.js";
import { getClient as getRedisClient } from "../cache.js";
import { getGroup, isGroupConfigured } from "./adminSettings.js";
import { listEnabled, type LlmProfile } from "./llmProfiles.js";
import * as minioService from "../minioService.js";

export const SERVICE_PROBE_ORDER = [
  "database",
  "redis",
  "minio",
  "embedding_model",
  "ocr_server",
  "analysis_server",
];

interface ProbeMeta {
  label: string;
  category: string;
  description: string;
}

export const SERVICE_PROBE_META: Record<string, ProbeMeta> = {
  database: {
    label: "PostgreSQL",
    category: "infrastructure",
    description: "Primary relational store and admin control plane backend.",
  },
  redis: {
    label: "Redis",
    category: "infrastructure",
    description: "Cache and coordination client used by the MCP server.",
  },
  minio: {
    label: "MinIO",
    category: "storage",
    description: "Object storage for uploaded sources and drug assets.",
  },
  embedding_model: {
    label: "Embedding Model",
    category: "ml",
    description: "Semantic-search embedding endpoint.",
  },
  ocr_server: {
    label: "OCR Server",
    category: "ml",
    description: "Vision/OCR backend for drug insert PDFs.",
  },
  analysis_server: {
    label: "Analysis LM",
    category: "ml",
    description: "Text-generation endpoint backing structured drug-insert analysis.",
  },
};

function canonicalServiceKey(key: string): string {
  return key === "lm_server" ? "analysis_server" : key;
}

/** Mirror Python `_ensure_json_object`. node-pg parses jsonb; normalize to object. */
function ensureJsonObject(value: unknown): Record<string, unknown> {
  let v = value;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return {};
    }
  }
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

interface ProbeRow {
  service_key: string | null;
  status: string | null;
  endpoint: string | null;
  latency_ms: number | null;
  message: string | null;
  details_json: unknown;
  details?: unknown;
  // pre-rendered isoformat text (UTC, microsecond) or null
  checked_at_iso: string | null;
}

interface NormalizedProbe {
  service_key: string;
  label: string;
  category: string;
  description: string;
  status: string;
  endpoint: string;
  latency_ms: number | null;
  message: string;
  details: Record<string, unknown>;
  checked_at: string | null;
}

function normalizeProbeRow(row: ProbeRow): NormalizedProbe {
  const serviceKey = String(row.service_key || "");
  const meta = SERVICE_PROBE_META[serviceKey] ?? null;
  const details = ensureJsonObject(row.details_json ?? row.details);
  return {
    service_key: serviceKey,
    label: meta?.label ?? (serviceKey || "Unknown"),
    category: meta?.category ?? "other",
    description: meta?.description ?? "",
    status: String(row.status || "degraded"),
    endpoint: String(row.endpoint || ""),
    latency_ms: row.latency_ms ?? null,
    message: String(row.message || ""),
    details,
    checked_at: row.checked_at_iso === null || row.checked_at_iso === undefined ? null : pyIso(row.checked_at_iso),
  };
}

function placeholderProbeRow(serviceKey: string): NormalizedProbe {
  const meta = SERVICE_PROBE_META[serviceKey];
  return {
    service_key: serviceKey,
    label: meta.label,
    category: meta.category,
    description: meta.description,
    status: "degraded",
    endpoint: "",
    latency_ms: null,
    message: "No cached probe result yet.",
    details: { state: "unprobed" },
    checked_at: null,
  };
}

function serializeServiceProbes(currentRows: ProbeRow[], historyRows: ProbeRow[]): Record<string, unknown> {
  const currentByKey = new Map<string, NormalizedProbe>();
  for (const row of currentRows) {
    if (String(row.service_key || "")) currentByKey.set(String(row.service_key), normalizeProbeRow(row));
  }
  const services = SERVICE_PROBE_ORDER.map((k) => currentByKey.get(k) ?? placeholderProbeRow(k));
  const history = historyRows.map(normalizeProbeRow);
  const okCount = services.filter((r) => r.status === "ok").length;
  const degradedCount = services.filter((r) => r.status === "degraded").length;
  const errorCount = services.filter((r) => r.status === "error").length;
  // checked_at strings share the fixed isoformat width, so lexical max == chronological max.
  let lastCheckedAt: string | null = null;
  for (const r of services) {
    if (r.checked_at && (lastCheckedAt === null || r.checked_at > lastCheckedAt)) lastCheckedAt = r.checked_at;
  }
  return {
    services,
    history,
    summary: {
      total: services.length,
      ok: okCount,
      degraded: degradedCount,
      error: errorCount,
      last_checked_at: lastCheckedAt,
    },
  };
}

/** Faithful port of `list_service_probes`. */
export async function listServiceProbes(historyLimit = 28): Promise<Record<string, unknown>> {
  const cur = await query<ProbeRow>(
    `SELECT service_key, status, endpoint, latency_ms, message, details_json,
            ${tsIsoExpr("checked_at")} AS checked_at_iso
       FROM admin.service_probes
       ORDER BY service_key`,
  );
  const hist = await query<ProbeRow>(
    `SELECT service_key, status, endpoint, latency_ms, message, details_json,
            ${tsIsoExpr("checked_at")} AS checked_at_iso
       FROM admin.service_probe_history
       ORDER BY checked_at DESC, service_probe_history_id DESC
       LIMIT $1`,
    [historyLimit],
  );
  const payload = serializeServiceProbes(cur.rows, hist.rows);
  payload.generated_at = new Date().toISOString();
  return payload;
}

// ── Active probing (port of `run_service_probes` + `_probe_*`) ────────────────
// Runs live reachability checks and persists them to admin.service_probes /
// _history, which the read path above renders. Since the Python `app` is
// retired, this is the sole implementation — functional correctness against the
// read path matters, not byte-parity with the old asyncpg backend.

interface ProbeResult {
  status: string;
  endpoint: string;
  latency_ms: number | null;
  message: string;
  details: Record<string, unknown>;
}

/** Port of `_probe_http_candidates`: GET each candidate; first 2xx wins. */
async function probeHttpCandidates(
  candidates: string[],
  headers: Record<string, string> = {},
  timeoutMs = 4000,
): Promise<{ ok: boolean; endpoint: string; latencyMs: number | null; message: string; details: Record<string, unknown> }> {
  let lastMessage = "No probe URL candidates configured.";
  let lastDetails: Record<string, unknown> = {};
  if (candidates.length === 0) return { ok: false, endpoint: "", latencyMs: null, message: lastMessage, details: {} };
  for (const candidate of candidates) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const started = performance.now();
    try {
      const resp = await fetch(candidate, { headers, redirect: "follow", signal: ctrl.signal });
      const latencyMs = Math.max(Math.trunc(performance.now() - started), 0);
      const details = { http_status: resp.status };
      if (resp.status >= 200 && resp.status < 300) {
        return { ok: true, endpoint: candidate, latencyMs, message: `HTTP ${resp.status}`, details };
      }
      lastMessage = `HTTP ${resp.status}`;
      lastDetails = details;
    } catch (exc) {
      lastMessage = String((exc as Error).message);
      lastDetails = { error_type: (exc as Error).name };
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, endpoint: candidates[0], latencyMs: null, message: lastMessage, details: lastDetails };
}

/** Port of `_ollama_probe_candidates`. */
function ollamaCandidates(baseUrl: string): string[] {
  const base = baseUrl.replace(/\/+$/, "");
  if (base.endsWith("/api")) return [`${base}/version`, `${base}/tags`];
  if (base.endsWith("/api/version") || base.endsWith("/api/tags")) return [base];
  return [`${base}/api/version`, `${base}/api/tags`];
}

/** Port of `_openai_like_probe_candidates`. */
function openaiCandidates(baseUrl: string): string[] {
  const base = baseUrl.replace(/\/+$/, "");
  if (base.endsWith("/models")) return [base];
  if (base.endsWith("/v1")) return [`${base}/models`];
  return [`${base}/models`, `${base}/v1/models`];
}

async function probeDatabase(): Promise<ProbeResult> {
  const started = performance.now();
  await query("SELECT 1");
  const latency = Math.max(Math.trunc(performance.now() - started), 0);
  return {
    status: "ok",
    endpoint: "postgresql://database",
    latency_ms: latency,
    message: "SELECT 1 succeeded.",
    details: { query: "SELECT 1" },
  };
}

async function probeRedis(): Promise<ProbeResult> {
  const started = performance.now();
  await getRedisClient().ping();
  const latency = Math.max(Math.trunc(performance.now() - started), 0);
  return {
    status: "ok",
    endpoint: "redis://cache",
    latency_ms: latency,
    message: "Redis PING succeeded.",
    details: { command: "PING" },
  };
}

async function probeMinio(): Promise<ProbeResult> {
  if (!minioService.initialized()) {
    return { status: "error", endpoint: "", latency_ms: null, message: "MinIO service has not been initialized.", details: { state: "missing" } };
  }
  if (minioService.enabled()) {
    return { status: "ok", endpoint: `minio://${minioService.bucket()}`, latency_ms: null, message: `Bucket ${minioService.bucket()} reachable.`, details: { bucket: minioService.bucket() } };
  }
  if (minioService.configEnabled()) {
    return { status: "error", endpoint: "", latency_ms: null, message: minioService.initError() || "MinIO configured but unavailable.", details: { state: "unavailable" } };
  }
  return { status: "degraded", endpoint: "", latency_ms: null, message: "MinIO disabled by configuration.", details: { state: "disabled" } };
}

/**
 * The Settings groups an operator must fill in are not seeded, so `getGroup`
 * answering with schema defaults means "nothing is set" — not "set to this".
 * Probing those defaults would dial an endpoint nobody chose and then report it
 * as broken; say "unconfigured" instead.
 */
function unconfigured(label: string): ProbeResult {
  return {
    status: "degraded",
    endpoint: "",
    latency_ms: null,
    message: `${label} is not configured yet — set it up in Admin → Settings.`,
    details: { state: "unconfigured" },
  };
}

/**
 * Probe every enabled profile of a role and fold the results into one row: the
 * role is healthy while *any* endpoint answers (that is the point of failover),
 * degraded when some are down, error only when they all are.
 */
async function probeProfiles(
  kind: "analysis" | "embedding",
  label: string,
  probeOne: (p: LlmProfile) => Promise<{ ok: boolean; endpoint: string; latencyMs: number | null; message: string; details: Record<string, unknown> }>,
): Promise<ProbeResult> {
  const profiles = await listEnabled(kind);
  const usable = profiles.filter((p) => p.base_url && p.model);
  if (usable.length === 0) return unconfigured(label);

  const results = await Promise.all(
    usable.map(async (p) => ({ profile: p, probe: await probeOne(p) })),
  );
  const healthy = results.filter((r) => r.probe.ok);
  const failed = results.filter((r) => !r.probe.ok);
  const first = healthy[0] ?? results[0];
  const perProfile = results.map((r) => ({
    name: r.profile.name,
    model: r.profile.model,
    provider: r.profile.provider,
    enabled: r.profile.enabled,
    priority: r.profile.priority,
    weight: r.profile.weight,
    ok: r.probe.ok,
    latency_ms: r.probe.latencyMs,
    message: r.probe.message,
  }));

  const status = healthy.length === 0 ? "error" : failed.length > 0 ? "degraded" : "ok";
  const message =
    healthy.length === 0
      ? `${label}: no profile is reachable (${failed.map((f) => f.profile.name).join(", ")}).`
      : failed.length > 0
        ? `${label}: ${healthy.length}/${usable.length} profiles reachable — ${failed
            .map((f) => f.profile.name)
            .join(", ")} down, failing over.`
        : `${label}: all ${usable.length} profile(s) reachable.`;

  return {
    status,
    endpoint: first.probe.endpoint,
    latency_ms: first.probe.latencyMs,
    message,
    details: { profiles: perProfile },
  };
}

async function probeEmbedding(): Promise<ProbeResult> {
  return probeProfiles("embedding", "Embedding", async (p) => {
    const base = p.base_url.replace(/\/+$/, "");
    const headers: Record<string, string> = p.api_key ? { Authorization: `Bearer ${p.api_key}` } : {};
    const candidates = p.provider === "ollama" ? ollamaCandidates(base) : openaiCandidates(base);
    return probeHttpCandidates(candidates, headers);
  });
}

/** Probe the MinerU server the drug pipeline uploads insert PDFs to. */
async function probeOcrServer(): Promise<ProbeResult> {
  if (!(await isGroupConfigured("ocr"))) return unconfigured("OCR server");
  const ocr = await getGroup("ocr");
  const provider = String((ocr.provider ?? "mineru") || "mineru").trim().toLowerCase();
  const endpoint = String((ocr.base_url ?? "") || "").trim().replace(/\/+$/, "");
  const backend = String((ocr.backend ?? "hybrid-engine") || "hybrid-engine").trim();
  const effort = String((ocr.effort ?? "medium") || "medium").trim();
  if (provider !== "mineru") {
    return { status: "error", endpoint, latency_ms: null, message: `Unsupported OCR provider: ${provider}`, details: { provider, backend } };
  }
  if (!endpoint) {
    return { status: "error", endpoint, latency_ms: null, message: "OCR base URL is not configured yet.", details: { provider, backend } };
  }
  const probe = await probeHttpCandidates([`${endpoint}/health`]);
  return {
    status: probe.ok ? "ok" : "error",
    endpoint: probe.endpoint,
    latency_ms: probe.latencyMs,
    message: probe.ok ? `OCR server reachable (${backend}).` : `OCR server probe failed: ${probe.message}`,
    details: { provider, backend, effort, ...probe.details },
  };
}

/** Probe every Analysis LM profile and fold failover endpoints into one row. */
async function probeAnalysis(): Promise<ProbeResult> {
  return probeProfiles("analysis", "Analysis LM", async (p) => {
    const base = p.base_url.replace(/\/+$/, "");
    const headers: Record<string, string> = p.api_key ? { Authorization: `Bearer ${p.api_key}` } : {};
    const candidates = p.provider === "ollama" ? ollamaCandidates(base) : openaiCandidates(base);
    return probeHttpCandidates(candidates, headers);
  });
}

/**
 * Run live probes for `serviceKeys` (all when empty), persist to
 * admin.service_probes + _history, and return the refreshed read payload plus
 * `probed_service_keys`. Port of `run_service_probes`.
 */
export async function runServiceProbes(serviceKeys?: string[]): Promise<Record<string, unknown>> {
  let selected = SERVICE_PROBE_ORDER;
  if (serviceKeys && serviceKeys.length) {
    const requested = new Set(
      serviceKeys.map((k) => canonicalServiceKey(String(k).trim())).filter(Boolean),
    );
    const invalid = [...requested].filter((k) => !SERVICE_PROBE_ORDER.includes(k)).sort();
    if (invalid.length) throw new ValueError(`Unsupported service probe keys: ${invalid.join(", ")}`);
    selected = SERVICE_PROBE_ORDER.filter((k) => requested.has(k));
  }

  const checkedAt = new Date();
  const results: (ProbeResult & { service_key: string })[] = [];

  for (const key of selected) {
    try {
      let result: ProbeResult;
      if (key === "database") result = await probeDatabase();
      else if (key === "redis") result = await probeRedis();
      else if (key === "minio") result = await probeMinio();
      else if (key === "embedding_model") result = await probeEmbedding();
      else if (key === "ocr_server") result = await probeOcrServer();
      else if (key === "analysis_server") result = await probeAnalysis();
      else {
        throw new ValueError(`Unsupported service probe key: ${key}`);
      }
      results.push({ service_key: key, ...result });
    } catch (exc) {
      if (exc instanceof ValueError) throw exc;
      results.push({
        service_key: key,
        status: "error",
        endpoint: "",
        latency_ms: null,
        message: String((exc as Error).message),
        details: { error_type: (exc as Error).name },
      });
    }
  }

  await withTransaction(async (client) => {
    for (const r of results) {
      const params = [
        r.service_key,
        r.status,
        r.endpoint || null,
        r.latency_ms,
        r.message || null,
        JSON.stringify(r.details ?? {}),
        checkedAt,
      ];
      await client.query(
        `INSERT INTO admin.service_probes
            (service_key, status, endpoint, latency_ms, message, details_json, checked_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
         ON CONFLICT (service_key) DO UPDATE
            SET status = EXCLUDED.status, endpoint = EXCLUDED.endpoint,
                latency_ms = EXCLUDED.latency_ms, message = EXCLUDED.message,
                details_json = EXCLUDED.details_json, checked_at = EXCLUDED.checked_at`,
        params,
      );
      await client.query(
        `INSERT INTO admin.service_probe_history
            (service_key, status, endpoint, latency_ms, message, details_json, checked_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
        params,
      );
    }
  });

  const payload = await listServiceProbes();
  payload.probed_service_keys = selected;
  return payload;
}

/** Raised for a bad `service_keys` request → HTTP 400 (mirrors Python ValueError). */
export class ValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValueError";
  }
}

/**
 * Faithful port of `JOB_TYPE_DEPENDENCIES` — the hard service dependencies that
 * must not be in `error` state before a job of the given type may run.
 */
export const JOB_TYPE_DEPENDENCIES: Record<string, string[]> = {
  icd_import: ["minio"],
  loinc_import: ["minio"],
  ig_import: ["minio"],
  snomed_import: ["minio"],
  rxnorm_import: ["minio"],
  drug_index_import: ["minio"],
  drug_enrichment: [], // only outbound HTTP to TFDA — no local service dep
  drug_analysis: ["minio", "ocr_server", "analysis_server"],
  guideline_seed: [],
  health_supplements_sync: [],
  food_nutrition_sync: [],
  noop: [],
};

/**
 * Faithful port of `get_unhealthy_dependencies`. Returns the service keys that
 * are in hard `status='error'` for the given job type. `degraded` is allowed,
 * and a service with no probe row yet gets the benefit of the doubt (not
 * blocking). Empty list ⇒ all dependencies healthy / no requirements.
 */
export async function getUnhealthyDependencies(jobType: string): Promise<string[]> {
  const required = JOB_TYPE_DEPENDENCIES[jobType] ?? [];
  if (required.length === 0) return [];
  const res = await query<{ service_key: string; status: string }>(
    `SELECT service_key, status FROM admin.service_probes WHERE service_key = ANY($1::text[])`,
    [required],
  );
  const byKey = new Map<string, string>();
  for (const row of res.rows) byKey.set(row.service_key, row.status);
  return required.filter((key) => byKey.get(key) === "error");
}
