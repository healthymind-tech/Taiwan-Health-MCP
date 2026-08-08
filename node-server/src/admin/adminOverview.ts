/**
 * Admin overview aggregator.
 *
 * Faithful port of `server.py::_build_admin_overview_payload` +
 * `AdminOverviewPayload.to_json`. Assembles infrastructure / modules / services
 * / jobs / workers / summary / fhir_servers and the `app` block.
 *
 * Health logic (`service_health.check_embedding_health` + each service's
 * `health_status`) is centralized here rather than on the Node service classes:
 * the Python methods only read the pool + the embedding service's reachability,
 * so this is behaviourally identical and avoids touching 7 service files. The
 * `reason`/`search_mode` strings are byte-matched to `service_health.py`.
 *
 * Volatile/impl fields (normalized away in parity comparison): `generated_at`,
 * `app.uptime`. `infrastructure.mcp.detail` reproduces Python's `str(config)`.
 */

import { query } from "../db.js";
import { getClient } from "../cache.js";
import { config, adminReady, type AppConfig } from "../config.js";
import * as minioService from "../minioService.js";
import { probeOcr } from "./ocrProbe.js";
import { getModuleStatus, type ModuleStatus } from "../moduleStatus.js";
import { getServiceRegistry } from "../mcp.js";
import { getEmbeddingService } from "../embeddingService.js";
import { summarizeJobs, listWorkerHeartbeats } from "./adminJobs.js";
import { getStates as getMaintenanceStates } from "./adminMaintenance.js";

const SERVER_STARTED_AT = Date.now();
const CACHE_TTL_SECONDS = 300; // Python CACHE_TTL = timedelta(minutes=5)

interface Health {
  status: string;
  reason: string;
  search_mode: string;
}

/** Mirror `config.__str__`. */
function configStr(c: AppConfig): string {
  // One branch only: the HTTP listener is unconditional. The old stdio branch hid
  // the endpoint (implying MCP was not served when it was) and the sse branch
  // advertised /sse, a route that does not exist anywhere in this server.
  return `Transport: ${c.transport} | http://${c.host}:${c.port}${c.path}`;
}

/** Mirror `_format_uptime`. */
function formatUptime(): string {
  const total = Math.floor((Date.now() - SERVER_STARTED_AT) / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

async function scalarCount(sql: string): Promise<number> {
  const res = await query<{ c: string }>(sql);
  return Number(res.rows[0]?.c ?? 0);
}

/** Mirror `service_health.check_embedding_health`. */
async function checkEmbeddingHealth(
  ollamaOk: boolean,
  embedCountSql: string,
): Promise<Health> {
  let hasEmbeddings: boolean;
  try {
    hasEmbeddings = (await scalarCount(embedCountSql)) > 0;
  } catch {
    hasEmbeddings = false;
  }
  if (ollamaOk && hasEmbeddings) {
    return { status: "ok", reason: "", search_mode: "semantic+keyword" };
  }
  if (!hasEmbeddings && !ollamaOk) {
    return {
      status: "degraded",
      reason: "Embeddings not generated; Ollama unreachable",
      search_mode: "keyword_only",
    };
  }
  if (!hasEmbeddings) {
    return {
      status: "degraded",
      reason: "Embeddings not generated — run Generate Embeddings",
      search_mode: "keyword_only",
    };
  }
  return {
    status: "degraded",
    reason: "Ollama unreachable — semantic search temporarily disabled",
    search_mode: "keyword_only",
  };
}

const UNAVAILABLE = (reason: string): Health => ({ status: "unavailable", reason, search_mode: "n/a" });

/** Per data-service health (mirrors each `*_service.health_status`). */
async function dataServiceHealth(key: string, ollamaOk: boolean): Promise<Health> {
  switch (key) {
    case "icd": {
      if ((await scalarCount("SELECT COUNT(*) AS c FROM icd.diagnoses")) < 10_000) {
        return UNAVAILABLE("ICD data not loaded");
      }
      return checkEmbeddingHealth(ollamaOk, "SELECT COUNT(*) AS c FROM icd.diagnosis_embeddings");
    }
    case "lab": {
      if ((await scalarCount("SELECT COUNT(*) AS c FROM loinc.concepts")) < 1_000) {
        return UNAVAILABLE("LOINC data not loaded");
      }
      return checkEmbeddingHealth(ollamaOk, "SELECT COUNT(*) AS c FROM loinc.concept_embeddings");
    }
    case "snomed": {
      if ((await scalarCount("SELECT COUNT(*) AS c FROM snomed.concepts")) < 100_000) {
        return UNAVAILABLE("SNOMED CT data not loaded");
      }
      return checkEmbeddingHealth(ollamaOk, "SELECT COUNT(*) AS c FROM snomed.concept_embeddings");
    }
    case "food_nutrition": {
      if ((await scalarCount("SELECT COUNT(*) AS c FROM food_nutrition.measurements")) < 10) {
        return UNAVAILABLE("Food nutrition data not loaded");
      }
      return checkEmbeddingHealth(ollamaOk, "SELECT COUNT(*) AS c FROM food_nutrition.food_embeddings");
    }
    case "health_supplements": {
      if ((await scalarCount("SELECT COUNT(*) AS c FROM health_supplements.items")) < 10) {
        return UNAVAILABLE("Health supplements data not loaded");
      }
      return checkEmbeddingHealth(ollamaOk, "SELECT COUNT(*) AS c FROM health_supplements.item_embeddings");
    }
    case "drug": {
      const licenseCount = await scalarCount("SELECT COUNT(*) AS c FROM drug.licenses WHERE is_listed");
      if (licenseCount < 1) return UNAVAILABLE("Drug index not loaded");
      const analyzed = await scalarCount(
        "SELECT COUNT(*) AS c FROM drug.normalized_records WHERE primary_insert_source = 'pdf_insert'",
      );
      const enriched = await scalarCount(
        "SELECT COUNT(*) AS c FROM drug.normalized_records WHERE primary_insert_source != 'index_only'",
      );
      if (analyzed > 0) return { status: "ok", reason: "", search_mode: "n/a" };
      if (enriched > 0) {
        return {
          status: "degraded",
          reason: `Enriched but OCR/LLM analysis incomplete (${enriched} enriched, ${analyzed} analyzed)`,
          search_mode: "n/a",
        };
      }
      return {
        status: "degraded",
        reason: "Drug index loaded but enrichment not run — search results are index-only quality",
        search_mode: "n/a",
      };
    }
    default:
      return UNAVAILABLE("Not initialized");
  }
}

// SERVICE_MODULES (Python module_status.SERVICE_MODULES) — single requirement each.
const SERVICE_MODULES: Array<{ key: string; table: string; minimum: number }> = [
  { key: "icd", table: "icd.diagnoses", minimum: 10_000 },
  { key: "drug", table: "drug.licenses", minimum: 1 },
  { key: "health_supplements", table: "health_supplements.items", minimum: 10 },
  { key: "food_nutrition", table: "food_nutrition.measurements", minimum: 10 },
  { key: "lab", table: "loinc.concepts", minimum: 1_000 },
  { key: "ig", table: "fhir.ig_packages", minimum: 1 },
  { key: "snomed", table: "snomed.concepts", minimum: 100_000 },
];

// Data services that have a real health_status(); derived ones inherit readiness.
const DATA_SERVICE_KEYS = new Set([
  "icd",
  "drug",
  "health_supplements",
  "food_nutrition",
  "lab",
  "snomed",
]);

/** Faithful port of `_build_admin_overview_payload` + `to_json`. */
export async function buildAdminOverview(): Promise<Record<string, unknown>> {
  const cfg = config();
  const generatedAt = new Date().toISOString().replace("Z", "+00:00");
  const infrastructure: Record<string, { status: string; detail: string }> = {};

  // ── database ──
  let dbOk = false;
  try {
    await query("SELECT 1");
    dbOk = true;
    infrastructure.database = { status: "ok", detail: "PostgreSQL reachable" };
  } catch (exc) {
    infrastructure.database = { status: "error", detail: String((exc as Error).message) };
  }

  // ── redis ──
  let redisOk = false;
  try {
    await getClient().ping();
    redisOk = true;
    infrastructure.redis = { status: "ok", detail: "Redis reachable" };
  } catch (exc) {
    infrastructure.redis = { status: "error", detail: String((exc as Error).message) };
  }

  // ── minio ──
  if (!minioService.initialized()) {
    infrastructure.minio = { status: "error", detail: "MinIO service not initialized" };
  } else if (minioService.enabled()) {
    infrastructure.minio = { status: "ok", detail: `Bucket: ${minioService.bucket()}` };
  } else if (minioService.configEnabled()) {
    infrastructure.minio = {
      status: "degraded",
      detail: minioService.initError() || "MinIO configured but unavailable",
    };
  } else {
    infrastructure.minio = { status: "degraded", detail: "MinIO disabled by configuration" };
  }

  // ── ocr ──
  infrastructure.ocr = await probeOcr();

  // ── mcp ── (status tied to the server being up/serving = Python `_initialized`)
  infrastructure.mcp = { status: "ok", detail: configStr(cfg) };

  // ── modules ──
  const moduleStatus: ModuleStatus = await getModuleStatus(true);
  const modules: Record<string, unknown> = {};
  for (const { key, table, minimum } of SERVICE_MODULES) {
    let count = 0;
    try {
      count = await scalarCount(`SELECT COUNT(*) AS c FROM ${table}`);
    } catch {
      count = 0;
    }
    modules[key] = {
      ready: Boolean((moduleStatus as unknown as Record<string, boolean>)[key]),
      row_count: count,
      threshold: minimum,
      requirements: [{ table, row_count: count, threshold: minimum }],
      cache_ttl_seconds: CACHE_TTL_SECONDS,
    };
  }

  // ── jobs + workers ──
  let jobs: Record<string, number> = {
    queued: 0,
    running: 0,
    success: 0,
    failed: 0,
    paused: 0,
    stopped: 0,
  };
  let workers: Awaited<ReturnType<typeof listWorkerHeartbeats>> = [];
  try {
    jobs = await summarizeJobs();
    workers = await listWorkerHeartbeats();
  } catch (exc) {
    infrastructure.admin_control_plane = {
      status: "degraded",
      detail: String((exc as Error).message),
    };
  }

  // ── services ──
  const registry = await getServiceRegistry();
  const embeddingSvc = await getEmbeddingService();
  const ollamaOk = embeddingSvc.enabled && embeddingSvc.available;
  const cachedStatus = moduleStatus as unknown as Record<string, boolean>;
  const services: Record<string, Record<string, unknown>> = {};
  for (const [key, initialized] of Object.entries(registry)) {
    let health: Health;
    if (DATA_SERVICE_KEYS.has(key)) {
      try {
        health = await dataServiceHealth(key, ollamaOk);
      } catch (he) {
        health = { status: "degraded", reason: String((he as Error).message), search_mode: "n/a" };
      }
    } else {
      // Derived services (ig / fhir_condition / fhir_medication): inherit readiness.
      health = {
        status: cachedStatus[key] ? "ok" : "unavailable",
        reason: "",
        search_mode: "n/a",
      };
    }
    services[key] = {
      initialized,
      module_ready: Boolean(cachedStatus[key]),
      health,
    };
  }

  // Maintenance override.
  let maintenanceStates: Record<string, boolean> = {};
  try {
    maintenanceStates = await getMaintenanceStates();
  } catch {
    maintenanceStates = {};
  }
  for (const [dsKey, on] of Object.entries(maintenanceStates)) {
    if (on && dsKey in services) {
      services[dsKey].health = {
        status: "maintaining",
        reason: "Maintenance mode enabled",
        search_mode: "n/a",
      };
      services[dsKey].maintenance = true;
    }
  }

  // ── fhir_servers ──
  let fhirServers: Record<string, unknown> = { total: 0, ok: 0, items: [] };
  try {
    const res = await query<{
      server_key: string;
      name: string;
      enabled: boolean;
      is_default: boolean;
      auth_profile: string | null;
      last_probe_status: string | null;
      last_probe_at: string | null;
      last_probe_error: string | null;
    }>(
      `SELECT server_key, name, enabled, is_default, auth_profile,
              last_probe_status,
              to_char(last_probe_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS last_probe_at,
              last_probe_error
         FROM admin.fhir_servers
        ORDER BY name`,
    );
    const items = res.rows.map((s) => ({
      server_key: s.server_key,
      name: s.name,
      enabled: Boolean(s.enabled),
      is_default: Boolean(s.is_default),
      auth_profile: s.auth_profile || "none",
      last_probe_status: s.last_probe_status || "",
      last_probe_at: s.last_probe_at,
      last_probe_error: s.last_probe_error || "",
    }));
    fhirServers = {
      total: items.length,
      ok: items.filter((s) => s.last_probe_status === "ok").length,
      items,
    };
  } catch (exc) {
    fhirServers = { total: 0, ok: 0, items: [], error: String((exc as Error).message) };
  }

  // ── summary ──
  const modulesReady = Object.values(modules).filter(
    (m) => (m as { ready: boolean }).ready,
  ).length;
  const servicesInitialized = Object.values(services).filter((s) => s.initialized).length;
  const servicesDegraded = Object.values(services).filter(
    (s) => (s.health as Health).status === "degraded",
  ).length;
  const infraHealthy = Object.values(infrastructure).filter((i) => i.status === "ok").length;
  const overallStatus =
    dbOk &&
    redisOk &&
    servicesInitialized === Object.keys(services).length &&
    servicesDegraded === 0
      ? "ok"
      : "degraded";

  return {
    generated_at: generatedAt,
    app: {
      transport: cfg.transport,
      mcp_path: cfg.path,
      admin_enabled: cfg.adminEnabled,
      admin_ready: adminReady(cfg),
      admin_username: cfg.adminUsername,
      uptime: formatUptime(),
    },
    infrastructure,
    modules,
    services,
    jobs,
    workers,
    summary: {
      overall_status: overallStatus,
      modules_ready: modulesReady,
      modules_total: Object.keys(modules).length,
      services_initialized: servicesInitialized,
      services_degraded: servicesDegraded,
      services_total: Object.keys(services).length,
      infrastructure_healthy: infraHealthy,
      infrastructure_total: Object.keys(infrastructure).length,
      fhir_servers_total: fhirServers.total,
      fhir_servers_ok: fhirServers.ok,
    },
    fhir_servers: fhirServers,
  };
}
