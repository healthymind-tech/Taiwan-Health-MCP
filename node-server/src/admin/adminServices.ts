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

import { query } from "../db.js";
import { tsIsoExpr, pyIso } from "./adminJobs.js";

export const SERVICE_PROBE_ORDER = [
  "database",
  "redis",
  "minio",
  "embedding_model",
  "ocr_server",
  "analysis_server",
  "lm_server",
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
    label: "Analyze Server",
    category: "ml",
    description: "Structured-analysis runtime and provider configuration.",
  },
  lm_server: {
    label: "LM Server",
    category: "ml",
    description: "Text-generation endpoint currently backing structured analysis.",
  },
};

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
