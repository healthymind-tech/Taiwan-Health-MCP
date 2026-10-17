/**
 * MCP server construction (B2 stub).
 *
 * Builds an `McpServer` exposing the always-on `health_check` tool, whose JSON
 * payload shape mirrors `src/server.py::health_check`. This is the parity target
 * stub: the streamable-http transport in `server.ts` mounts this so the parity
 * runner's `initialize` + `tools/list` + `tools/call health_check` succeed.
 *
 * As L1 tools are ported they get registered here alongside `health_check`.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { healthcheck as dbHealthcheck, query as dbQuery } from "./db.js";
import { monitor as dbHealthMonitor } from "./dbHealth.js";
import { getClient } from "./cache.js";
import { getModuleStatus, type ModuleStatus } from "./moduleStatus.js";
import { IcdService } from "./icdService.js";
import { LabService } from "./labService.js";
import { SnomedService } from "./snomedService.js";
import { FoodNutritionService } from "./foodService.js";
import { HealthSupplementsService } from "./supplementsService.js";
import { FHIRConditionService } from "./fhirConditionService.js";
import { FHIRMedicationService } from "./fhirMedicationService.js";
import { FHIRServerService } from "./fhirServerService.js";
import { DrugService } from "./drugService.js";
import { FHIRIGService } from "./fhirIgService.js";
import * as fhirReference from "./fhirReference.js";
import { getEmbeddingService } from "./embeddingService.js";
import { logError } from "./logger.js";
import { recordToolCall } from "./metrics.js";
import { getStates as getMaintenanceStates } from "./admin/adminMaintenance.js";
import { BUILD, SERVER_VERSION, TOOLS_VERSION } from "./toolVersions.js";
import { LEXICON_SHA256, LEXICON_VERSION, groundingInputShape, validateBundleGroundingShape } from "./grounding/index.js";
import { completenessInputShape, type CompletenessInput } from "./grounding/completeness/index.js";
import {
  TOOL_DESCRIPTIONS,
  addBundleGrounding,
  addResourceGrounding,
  dbTerminologyNames,
  groundingLogger,
  runCheckCompletenessTool,
  runCheckGroundingTool,
  type CheckGroundingArgs,
  type GroundingToolDeps,
  type ValidateGroundingArgs,
} from "./groundingTools.js";
import {
  bmiInputShape,
  calculateBmi,
  calculateCdai,
  calculateChads2Vasc,
  calculateCurb65,
  calculateDas28,
  calculateEgfr,
  calculateGcs,
  calculateHasBled,
  calculateQsofa,
  calculateWellsDvt,
  calculateWellsPe,
  cdaiInputShape,
  chads2VascInputShape,
  curb65InputShape,
  das28InputShape,
  egfrInputShape,
  gcsInputShape,
  hasBledInputShape,
  qsofaInputShape,
  wellsDvtInputShape,
  wellsPeInputShape,
} from "./clinicalCalculators.js";

export const SERVER_NAME = "taiwan-health-mcp";

// ── Tool registry (OpenAPI bridge) ────────────────────────────────────────────
// Mirrors the Python OpenAPI bridge (`_build_openapi_spec` + `_handle_openapi_tool_call`):
// every tool registered on the McpServer is also captured here so `GET /openapi.json`
// can advertise it and `POST /tools/<name>` can invoke it outside the MCP transport.
// `buildMcpServer` wraps `server.registerTool` to populate this on each build.
const _OPENAPI_TOOL_PREFIX = "/tools/";

interface RegisteredTool {
  name: string;
  description: string;
  shape: z.ZodRawShape;
  handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text?: string }> }>;
}

let toolRegistry = new Map<string, RegisteredTool>();

/**
 * Wrap a tool handler so every invocation records Prometheus
 * `mcp_tool_requests_total{tool,status}` / `mcp_tool_duration_seconds{tool}`.
 * This is the single dispatch point shared by the MCP transport, the
 * `POST /tools/<name>` bridge and the admin playground (both go through
 * `toolRegistry`). Labels are the tool name and "success" / "error" only —
 * arguments are never recorded.
 */
export function withToolMetrics<A extends unknown[], R>(
  name: string,
  handler: (...args: A) => Promise<R> | R,
  record: (tool: string, status: string, durationS: number) => void = recordToolCall,
): (...args: A) => Promise<R> {
  return async (...args: A): Promise<R> => {
    const started = process.hrtime.bigint();
    let status = "error";
    try {
      const result = await handler(...args);
      const isError = (result as { isError?: unknown } | null | undefined)?.isError === true;
      status = isError ? "error" : "success";
      return result;
    } finally {
      try {
        record(name, status, Number(process.hrtime.bigint() - started) / 1e9);
      } catch {
        // Metrics must never break a tool call.
      }
    }
  };
}

// ── Maintenance gate ──────────────────────────────────────────────────────────

/**
 * Maintenance module (admin/adminMaintenance.ts MAINTENANCE_MODULES) that gates each tool group, or null when the
 * group is never gated. Derived groups follow the module whose data they read (FHIR Condition -> icd, FHIR
 * Medication -> drug). rxnorm has a toggle but no tool group of its own, so it gates no tool. Always-on groups
 * (FHIR Servers, Clinical Calculators, System) and the TFDA Open Data groups have no maintenance toggle.
 */
export const GROUP_MAINTENANCE_MODULE: Readonly<Record<ToolGroupKey, string | null>> = {
  icd: "icd",
  fhir_condition: "icd",
  drug: "drug",
  fhir_medication: "drug",
  lab: "loinc",
  snomed: "snomed",
  fhir_ig: "ig",
  health_supplements: null,
  food_nutrition: null,
  fhir_servers: null,
  calculators: null,
  system: null,
};

let _toolMaintenanceModule: Map<string, string> | null = null;

/** Maintenance module gating `tool`, or null (unknown tools and always-on groups are never gated). */
export function maintenanceModuleForTool(tool: string): string | null {
  if (!_toolMaintenanceModule) {
    const m = new Map<string, string>();
    for (const t of toolCatalog()) {
      const mod = GROUP_MAINTENANCE_MODULE[t.group];
      if (mod) m.set(t.name, mod);
    }
    _toolMaintenanceModule = m;
  }
  return _toolMaintenanceModule.get(tool) ?? null;
}

export const MODULE_MAINTENANCE_CODE = "MODULE_MAINTENANCE";

/** The isError tool result returned while `module` is in maintenance mode (same envelope as other tool errors). */
export function maintenanceToolResult(tool: string, module: string): { content: Array<{ type: "text"; text: string }>; isError: true } {
  const body = {
    ok: false,
    data: null,
    warnings: [],
    error: {
      code: MODULE_MAINTENANCE_CODE,
      module,
      tool,
      retryable: true,
      message: `Module '${module}' is under maintenance (data is being updated); ${tool} is temporarily unavailable. Retry later.`,
      message_zh: `模組「${module}」維護中（資料更新中），${tool} 暫時無法使用，請稍後再試。`,
    },
  };
  return { content: [{ type: "text", text: JSON.stringify(body) }], isError: true };
}

/**
 * Wrap a tool handler so calls fail fast with MODULE_MAINTENANCE while the tool's module is in maintenance mode.
 * Shares the dispatch point with withToolMetrics (MCP transport, POST /tools/<name>, admin playground). The tool
 * stays in tools/list — clients see a clear error instead of tool-list churn. State comes from adminMaintenance's
 * 5 s cache; a failing state lookup fails open (the call proceeds), so a DB hiccup never blocks every tool.
 */
export function withMaintenanceGate<A extends unknown[], R>(
  name: string,
  handler: (...args: A) => Promise<R> | R,
  states: (keys: readonly string[]) => Promise<Record<string, boolean>> = getMaintenanceStates,
  moduleOf: (tool: string) => string | null = maintenanceModuleForTool,
): (...args: A) => Promise<R> {
  return async (...args: A): Promise<R> => {
    const module = moduleOf(name);
    if (module) {
      let inMaintenance = false;
      try {
        inMaintenance = (await states([module]))[module] === true;
      } catch {
        inMaintenance = false;
      }
      if (inMaintenance) return maintenanceToolResult(name, module) as unknown as R;
    }
    return handler(...args);
  };
}

/** Patch `server.registerTool` so every registration is also recorded in `into`. */
function captureToolRegistrations(server: McpServer, into: Map<string, RegisteredTool>): void {
  const orig = server.registerTool.bind(server) as (...a: unknown[]) => unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).registerTool = (name: string, config: any, handler: any) => {
    const instrumented = withToolMetrics(name, withMaintenanceGate(name, handler as (...a: unknown[]) => Promise<unknown>));
    into.set(name, {
      name,
      description: typeof config?.description === "string" ? config.description : "",
      shape: (config?.inputSchema ?? {}) as z.ZodRawShape,
      handler: instrumented as RegisteredTool["handler"],
    });
    return orig(name, config, instrumented);
  };
}

/** JSON Schema for a tool's input shape (mirrors the schema the SDK exposes via tools/list). */
function toolInputJsonSchema(shape: z.ZodRawShape): Record<string, unknown> {
  const schema = zodToJsonSchema(z.object(shape ?? {})) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}

/**
 * Build an OpenAPI 3.1 spec exposing the currently-registered MCP tools.
 * Faithful port of Python `_build_openapi_spec`: each tool `foo` → `POST /tools/foo`
 * with the tool's input JSON-Schema as the request body and `operationId = foo`.
 */
export function buildOpenApiSpec(serverUrl: string, bearerAuth = false): Record<string, unknown> {
  const paths: Record<string, unknown> = {};
  for (const tool of toolRegistry.values()) {
    const schema = toolInputJsonSchema(tool.shape);
    const description = (tool.description || "").trim();
    const summary = description ? description.split("\n")[0].slice(0, 120) : tool.name;
    const required = schema.required;
    paths[`${_OPENAPI_TOOL_PREFIX}${tool.name}`] = {
      post: {
        operationId: tool.name,
        summary,
        description,
        requestBody: {
          required: Array.isArray(required) && required.length > 0,
          content: { "application/json": { schema } },
        },
        responses: {
          "200": {
            description: "Tool result",
            content: { "application/json": { schema: { type: "object" } } },
          },
        },
      },
    };
  }
  const spec: Record<string, unknown> = {
    openapi: "3.1.0",
    info: {
      title: "Taiwan Health MCP — OpenAPI bridge",
      description:
        "REST/OpenAPI surface over the Taiwan Health MCP tools, for OpenAPI tool " +
        "clients such as Open WebUI. Tools are the same ones served over MCP at the " +
        "streamable-http endpoint.",
      version: "1.0.0",
    },
    paths,
  };
  if (serverUrl) spec.servers = [{ url: serverUrl }];
  if (bearerAuth) {
    spec.components = {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer" },
      },
    };
    spec.security = [{ bearerAuth: [] }];
  }
  return spec;
}

/** True once at least one tool has been registered (registry warmed). */
export function toolRegistryReady(): boolean {
  return toolRegistry.size > 0;
}

/** Flatten a tool result's text content blocks (mirrors `_extract_text_from_tool_result`). */
function extractToolText(result: { content?: Array<{ text?: string }> }): string {
  const blocks = result?.content;
  if (!Array.isArray(blocks)) return String(result);
  return blocks.map((b) => (b?.text != null ? b.text : "")).filter((t) => t !== "").join("\n");
}

/**
 * Invoke a registered tool by name with a JSON-object of arguments and return the
 * flattened text result. Mirrors Python `mcp.call_tool` + text extraction.
 * Throws `unknown_tool` if not registered; validation/handler errors propagate.
 */
export async function invokeRegisteredTool(
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const tool = toolRegistry.get(name);
  if (!tool) throw new Error(`unknown_tool: ${name}`);
  // Validate + coerce (applies zod defaults) the same way the MCP transport would.
  const parsed = z.object(tool.shape ?? {}).parse(args) as Record<string, unknown>;
  const result = await tool.handler(parsed);
  return extractToolText(result);
}

/**
 * Build the health_check JSON string.
 *
 * Shape parity with Python `health_check`:
 *   { status, database, db_health, cache, services{...10 flags} }
 *
 * `db_health` is the snapshot of the ported `dbHealth` monitor (mirrors
 * `db_health.monitor().snapshot()`), value-for-value comparable with Python.
 */
async function buildHealthCheck(): Promise<string> {
  const db = await dbHealthcheck();
  const dbOk = db.ok;

  let cacheOk = false;
  try {
    await getClient().ping();
    cacheOk = true;
  } catch {
    cacheOk = false;
  }

  let services = {
    icd: false,
    drug: false,
    health_supplements: false,
    food_nutrition: false,
    fhir_condition: false,
    fhir_medication: false,
    lab: false,
    ig: false,
    snomed: false,
  };
  try {
    const status = await getModuleStatus();
    services = {
      icd: status.icd,
      drug: status.drug,
      health_supplements: status.health_supplements,
      food_nutrition: status.food_nutrition,
      fhir_condition: status.fhir_condition,
      fhir_medication: status.fhir_medication,
      lab: status.lab,
      ig: status.ig,
      snomed: status.snomed,
    };
  } catch {
    // leave all-false
  }

  const versions = dbOk ? await versionInfo() : { terminology: {}, ig_packages: [], default_ig: null };

  return JSON.stringify({
    status: dbOk ? "ok" : "degraded",
    database: dbOk ? "ok" : "error",
    db_health: dbHealthMonitor().snapshot(),
    cache: cacheOk ? "ok" : "error",
    services,
    version: SERVER_VERSION,
    build: BUILD,
    tools_version: TOOLS_VERSION,
    lexicon_version: LEXICON_VERSION,
    lexicon_sha256: LEXICON_SHA256,
    terminology: versions.terminology,
    ig_packages: versions.ig_packages,
    default_ig: versions.default_ig,
  });
}

/**
 * Loaded terminology editions + installed IG packages for health_check
 * (MCP_GROUNDING_SPEC §6.3). Every query is independent and fail-soft: a
 * missing editions table (older schema) just omits that entry.
 */
async function versionInfo(): Promise<{
  terminology: Record<string, string>;
  ig_packages: string[];
  default_ig: string | null;
}> {
  const terminology: Record<string, string> = {};
  const safe = async <T extends Record<string, any>>(sql: string): Promise<T[]> => {
    try {
      return (await dbQuery<T>(sql)).rows;
    } catch {
      return [];
    }
  };
  for (const r of await safe<{ code_system: string; edition: string; code_count: number }>(
    "SELECT code_system, edition, code_count FROM icd.editions ORDER BY code_system",
  )) {
    const key = r.code_system === "icd-10-cm" ? "icd10cm" : r.code_system === "icd-10" ? "icd10" : r.code_system;
    terminology[key] = String(r.edition);
  }
  for (const r of await safe<{ version: string }>("SELECT version FROM loinc.editions WHERE code_system = 'loinc'")) {
    terminology.loinc = String(r.version);
  }
  for (const r of await safe<{ module_id: string; version_date: string | Date }>(
    "SELECT module_id, version_date FROM snomed.editions WHERE code_system = 'snomed'",
  )) {
    const d = r.version_date instanceof Date ? r.version_date.toISOString().slice(0, 10) : String(r.version_date).slice(0, 10);
    terminology.snomed = `${r.module_id}/${d.replace(/-/g, "")}`;
  }
  const igRows = await safe<{ package_id: string; version: string; is_default: boolean }>(
    "SELECT package_id, version, is_default FROM fhir.ig_packages ORDER BY is_default DESC, package_id, version",
  );
  const ig_packages = igRows.map((r) => `${r.package_id}#${r.version}`);
  const def = igRows.find((r) => r.is_default);
  return { terminology, ig_packages, default_ig: def ? `${def.package_id}#${def.version}` : null };
}

/** Wrap any value as the MCP text-content result holding its JSON string. */
function jsonResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

/** Wrap a pre-serialized JSON string (e.g. the FHIR IG envelope) as a tool result. */
function rawResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

// Lazily-initialized ICD service singleton (mirrors the Python lifespan service).
let _icd: IcdService | null = null;
async function getIcdService(): Promise<IcdService | null> {
  if (_icd) return _icd;
  try {
    const svc = new IcdService(await getEmbeddingService());
    await svc.initialize();
    _icd = svc;
    return _icd;
  } catch (err) {
    logError("ICD service init failed", { error: String((err as Error).message) });
    return null;
  }
}

/**
 * Register the ICD-10 tool group (`_TOOL_GROUPS["ICD-10"]`, including the
 * hybrid `search_medical_codes`). Only called when the `icd` module is active, matching Python's dynamic
 * add/remove via ModuleStatusManager.
 */
function registerIcdTools(server: McpServer, svc: IcdService): void {
  server.registerTool(
    "search_medical_codes",
    {
      description:
        "Search ICD-10-CM diagnosis codes and ICD-10-PCS procedure codes " +
        "(the editions loaded on this server; see health_check.terminology). " +
        "diagnosis: hybrid BM25 + vector embedding re-ranking; procedure: BM25 only; " +
        "all (default): both, returned under separate diagnoses/procedures keys. " +
        "Results are ranked by relevance, not alphabetical.",
      inputSchema: {
        keyword: z.string(),
        type: z.enum(["diagnosis", "procedure", "all"]).default("all"),
        limit: z.number().int().default(3),
      },
    },
    async ({ keyword, type, limit }) =>
      jsonResult(await svc.searchCodes(keyword, type ?? "all", limit ?? 3)),
  );

  server.registerTool(
    "infer_complications",
    {
      description:
        "Explore the ICD-10-CM hierarchy for a diagnosis code or category prefix. " +
        "Pure hierarchy lookup: parent codes expand to child codes; leaf codes list siblings.",
      inputSchema: { code: z.string() },
    },
    async ({ code }) => jsonResult(await svc.inferComplications(code)),
  );

  server.registerTool(
    "get_nearby_codes",
    {
      description:
        "Retrieve the two ICD-10-CM codes immediately before and after a known code " +
        "(alphabetical ordering neighbors, not semantic matches).",
      inputSchema: { code: z.string() },
    },
    async ({ code }) => jsonResult(await svc.getNearbyCodes(code)),
  );

  server.registerTool(
    "check_medical_conflict",
    {
      description:
        "Fetch full metadata for one diagnosis + one procedure code side-by-side for " +
        "coding QA / conflict analysis. Returns facts only, no pass/fail verdict.",
      inputSchema: { diagnosis_code: z.string(), procedure_code: z.string() },
    },
    async ({ diagnosis_code, procedure_code }) =>
      jsonResult(await svc.getConflictInfo(diagnosis_code, procedure_code)),
  );

  server.registerTool(
    "browse_icd_category",
    {
      description:
        "Browse ICD-10-CM structure by chapter or 3-character category. Omit category to " +
        "enumerate all categories with counts; pass a category to expand it into codes.",
      inputSchema: {
        category: z.string().nullish().default(null),
        limit: z.number().int().default(50),
      },
    },
    async ({ category, limit }) =>
      jsonResult(await svc.browseCategory(category ?? null, limit ?? 50)),
  );
}

// Lazily-initialized LOINC lab service singleton.
let _lab: LabService | null = null;
async function getLabService(): Promise<LabService> {
  if (!_lab) _lab = new LabService(await getEmbeddingService());
  return _lab;
}

// Lazily-initialized SNOMED service singleton.
let _snomed: SnomedService | null = null;
async function getSnomedService(): Promise<SnomedService | null> {
  if (_snomed) return _snomed;
  try {
    const svc = new SnomedService(await getEmbeddingService());
    await svc.initialize();
    _snomed = svc;
    return _snomed;
  } catch (err) {
    logError("SNOMED service init failed", { error: String((err as Error).message) });
    return null;
  }
}

// Lazily-initialized Food Nutrition service singleton.
let _food: FoodNutritionService | null = null;
async function getFoodService(): Promise<FoodNutritionService | null> {
  if (_food) return _food;
  try {
    const svc = new FoodNutritionService(await getEmbeddingService());
    await svc.initialize();
    _food = svc;
    return _food;
  } catch (err) {
    logError("Food nutrition service init failed", { error: String((err as Error).message) });
    return null;
  }
}

/** Register the Food Nutrition tool group. Mirrors `_TOOL_GROUPS["Food Nutrition"]`. */
function registerFoodTools(server: McpServer, svc: FoodNutritionService): void {
  server.registerTool(
    "query_food_nutrition",
    {
      description:
        "Search Taiwan FDA food composition database for nutritional content per 100 g " +
        "(hybrid BM25 + semantic). detailed=false (default): quick flat lookup with optional " +
        "nutrient filter; detailed=true: full nutrient panel grouped by category (limit ignored).",
      inputSchema: {
        food_name: z.string(),
        nutrient: z.string().nullish().default(null),
        limit: z.number().int().default(3),
        detailed: z.boolean().default(false),
      },
    },
    async ({ food_name, nutrient, limit, detailed }) => {
      if (detailed) return jsonResult(await svc.getDetailedNutrition(food_name));
      return jsonResult(await svc.searchNutrition(food_name, nutrient ?? null, limit ?? 3));
    },
  );

  server.registerTool(
    "query_food_ingredient",
    {
      description:
        "Search the Taiwan FDA food ingredient classification database by keyword, with an " +
        "optional major_category filter (hybrid BM25 + semantic).",
      inputSchema: {
        keyword: z.string(),
        category: z.enum(["可供食品使用之原料", "未確認安全性尚不得使用之原料"]).nullish().default(null),
        limit: z.number().int().default(3),
      },
    },
    async ({ keyword, category, limit }) =>
      jsonResult(await svc.searchFoodIngredient(keyword, limit ?? 3, category ?? null)),
  );

  server.registerTool(
    "search_foods_by_nutrient",
    {
      description:
        "Rank Taiwan FDA foods by highest content of a specific nutrient (per 100 g). " +
        "Nutrient resolution: alias map → partial ILIKE → semantic embedding fallback.",
      inputSchema: {
        nutrient: z.string(),
        limit: z.number().int().default(20),
      },
    },
    async ({ nutrient, limit }) =>
      jsonResult(await svc.searchFoodsByNutrient(nutrient, Math.min(Math.max(1, limit ?? 20), 50))),
  );

  server.registerTool(
    "analyze_meal_nutrition",
    {
      description:
        "Aggregate nutrition for a meal from multiple foods (100 g per food assumed). " +
        "Returns per-food breakdowns and a combined meal total.",
      inputSchema: {
        foods: z.array(z.string()),
      },
    },
    async ({ foods }) => jsonResult(await svc.analyzeMealNutrition(foods)),
  );
}

// Lazily-initialized Health Supplements service singleton.
let _supplements: HealthSupplementsService | null = null;
async function getSupplementsService(): Promise<HealthSupplementsService | null> {
  if (_supplements) return _supplements;
  try {
    const svc = new HealthSupplementsService(await getEmbeddingService());
    await svc.initialize();
    _supplements = svc;
    return _supplements;
  } catch (err) {
    logError("Health supplements service init failed", { error: String((err as Error).message) });
    return null;
  }
}

/** Shape one health_supplements.items row for MCP output (mirror `_health_supplement_result`). */
function healthSupplementResult(row: {
  permit_no?: unknown;
  name?: unknown;
  applicant?: unknown;
  category?: unknown;
  benefit_claims?: unknown;
  valid_from?: unknown;
}) {
  return {
    permit_no: row.permit_no ?? null,
    product_name: row.name ?? null,
    company: row.applicant ?? null,
    category: row.category ?? null,
    benefits: row.benefit_claims ?? null,
    approval_date: row.valid_from || null,
  };
}

/** Register the Health Supplements tool group. Mirrors `_TOOL_GROUPS["Health Supplements"]`. */
function registerSupplementsTools(server: McpServer, svc: HealthSupplementsService): void {
  server.registerTool(
    "search_health_supplements",
    {
      description:
        "Search Taiwan FDA certified health supplements (健康食品) by three modes. " +
        "keyword (default): hybrid BM25 + semantic search across name/company/benefits. " +
        "permit_no: look up one product by permit number or its digits (limit ignored). " +
        "condition: map a disease name or ICD-10 code to recommended benefit categories, " +
        "then find certified products matching those benefits (adds icd_code + recommended_benefits).",
      inputSchema: {
        mode: z.enum(["keyword", "permit_no", "condition"]).default("keyword"),
        keyword: z.string().default(""),
        limit: z.number().int().default(3),
      },
    },
    async ({ mode, keyword, limit }) => {
      if (!keyword) return jsonResult({ error: "Provide keyword" });
      const cappedLimit = Math.min(Math.max(1, limit ?? 3), 10);
      const m = mode ?? "keyword";

      if (m === "keyword") {
        const payload = (await svc.searchHealthSupplements(keyword, cappedLimit)) as {
          results?: Array<Record<string, unknown>>;
          search_mode?: unknown;
          search_note?: unknown;
        };
        const results = (payload.results ?? []).map((item) => healthSupplementResult(item));
        const out: Record<string, unknown> = { mode: m, keyword, results };
        if ("search_mode" in payload) {
          out.search_mode = payload.search_mode;
          out.search_note = payload.search_note ?? null;
        }
        return jsonResult(out);
      }

      if (m === "permit_no") {
        const row = await svc.lookupByPermit(keyword);
        if (!row) return jsonResult({ mode: m, keyword, results: [] });
        return jsonResult({ mode: m, keyword, results: [healthSupplementResult(row)] });
      }

      // condition mode
      const icd = await getIcdService();
      const analysis = await svc.analyzeHealthSupportForCondition(keyword, icd);
      const results = [];
      for (const food of analysis.health_supplements.slice(0, cappedLimit)) {
        if (!food.permit_no) continue;
        const row = await svc.lookupByPermit(food.permit_no);
        if (row) results.push(healthSupplementResult(row));
      }
      return jsonResult({
        mode: m,
        keyword,
        icd_code: analysis.icd_code,
        recommended_benefits: analysis.recommended_benefits ?? [],
        results,
      });
    },
  );
}

// Lazily-initialized Drug service singleton.
let _drug: DrugService | null = null;
export async function getDrugService(): Promise<DrugService | null> {
  if (_drug) return _drug;
  try {
    const svc = new DrugService();
    await svc.initialize();
    _drug = svc;
    return _drug;
  } catch (err) {
    logError("Drug service init failed", { error: String((err as Error).message) });
    return null;
  }
}

/** Register the Drug / TFDA tool group. Mirrors `_TOOL_GROUPS["Drug / TFDA"]`. */
function registerDrugTools(server: McpServer, svc: DrugService): void {
  server.registerTool(
    "search_drug",
    {
      description:
        "Search Taiwan FDA drug records by mode. drug_name (default), ingredient, license_id, atc_code. " +
        "Output: { mode, keyword, include_cancelled, results }.",
      inputSchema: {
        mode: z.enum(["drug_name", "ingredient", "license_id", "atc_code"]).default("drug_name"),
        keyword: z.string().default(""),
        limit: z.number().int().default(3),
        include_cancelled: z.boolean().default(false),
      },
    },
    async ({ mode, keyword, limit, include_cancelled }) => {
      const m = mode ?? "drug_name";
      const kw = keyword ?? "";
      const inc = include_cancelled ?? false;
      const lim = limit ?? 3;
      if (!kw.trim()) {
        return jsonResult({ error: "keyword is required", mode: m, results: [] });
      }
      let payload: { results: unknown[] };
      if (m === "drug_name") payload = await svc.searchByName(kw, lim, inc);
      else if (m === "ingredient") payload = await svc.searchByIngredient(kw, lim, inc);
      else if (m === "license_id") payload = await svc.searchByLicenseId(kw, lim, inc);
      else if (m === "atc_code") payload = await svc.searchByAtcCode(kw, lim, inc);
      else {
        return jsonResult({
          error: `Unsupported mode: ${m}`,
          allowed_modes: ["drug_name", "ingredient", "license_id", "atc_code"],
        });
      }
      return jsonResult({ ...payload, mode: m, keyword: kw, include_cancelled: inc });
    },
  );

  server.registerTool(
    "identify_unknown_pill",
    {
      description:
        "Identify a Taiwan FDA drug by pill appearance keywords (space-separated), " +
        "matched conjunctively against appearance fields with a small color/shape synonym map.",
      inputSchema: {
        features: z.string(),
      },
    },
    async ({ features }) => {
      if (!features.trim()) return jsonResult({ error: "features is required", results: [] });
      return jsonResult(await svc.identifyUnknownPill(features));
    },
  );

  server.registerTool(
    "get_drug_details",
    {
      description:
        "Return the canonical normalized drug record for one Taiwan FDA license, " +
        "augmented with stage availability and document counts.",
      inputSchema: {
        license_id: z.string(),
        include_cancelled: z.boolean().default(false),
      },
    },
    async ({ license_id, include_cancelled }) => {
      if (!license_id.trim()) return jsonResult({ error: "license_id is required" });
      return jsonResult(await svc.getDrugDetails(license_id, include_cancelled ?? false));
    },
  );

  server.registerTool(
    "get_drug_asset_links",
    {
      description:
        "Return persisted asset metadata plus runtime-generated MinIO download links " +
        "(presigned URLs are null when MinIO is unconfigured).",
      inputSchema: {
        license_id: z.string().nullish().default(null),
        asset_id: z.string().nullish().default(null),
        asset_group: z.enum(["insert", "label", "shape", "analysis"]).nullish().default(null),
        latest_insert_only: z.boolean().default(false),
      },
    },
    async ({ license_id, asset_id, asset_group, latest_insert_only }) =>
      jsonResult(
        await svc.getDrugAssetLinks({
          license_id: license_id ?? null,
          asset_id: asset_id ?? null,
          asset_group: asset_group ?? null,
          latest_insert_only: latest_insert_only ?? false,
        }),
      ),
  );
}

// Lazily-initialized FHIR IG service singleton.
let _fhirIg: FHIRIGService | null = null;
async function getFhirIgService(): Promise<FHIRIGService | null> {
  if (_fhirIg) return _fhirIg;
  try {
    const svc = new FHIRIGService(await getEmbeddingService());
    await svc.initialize();
    _fhirIg = svc;
    return _fhirIg;
  } catch (err) {
    logError("FHIR IG service init failed", { error: String((err as Error).message) });
    return null;
  }
}

/** Register the FHIR IG tool group (22 tools): `_TOOL_GROUPS["FHIR IG"]` + required elements + grounding / completeness checks. */
function registerFhirIgTools(server: McpServer, svc: FHIRIGService): void {
  const pkg = {
    package_id: z
      .string()
      .nullish()
      .default(null)
      .describe(
        "IG package id (e.g. tw.gov.mohw.twcore). Omit to auto-resolve: a canonical argument or meta.profile pinned " +
          "with '|version' → the package holding that version; otherwise the package that owns the canonical / " +
          "meta.profile (manually-installed IG first); otherwise the default IG. provenance.resolved_by says which rule applied. " +
          "With no default IG and no owner, the call fails with NO_DEFAULT_IG.",
      ),
    version: z
      .string()
      .nullish()
      .default(null)
      .describe("Package version (with package_id). Omitted → the default IG's version, else the highest release (pre-releases only if no release exists)."),
  };
  const allPackages = {
    all_packages: z
      .boolean()
      .default(false)
      .describe("Search every installed package instead of one (rows then carry package_id / package_version); package_id is ignored."),
  };

  server.registerTool(
    "fhir_list_igs",
    {
      description:
        "List the FHIR Implementation Guide (IG) packages installed on this server (isDefault, installOrigin manual|dependency, dependencies). " +
        "Tools that omit package_id use the package owning the canonical / meta.profile involved, else the default IG.",
      inputSchema: {},
    },
    async () => rawResult(await svc.listIgs()),
  );

  server.registerTool(
    "fhir_get_ig",
    {
      description:
        "Details of one IG package: identity, dependencies, and per-resource-type artifact counts. " +
        "data.deps_missing lists declared dependencies that are not installed (incomplete closure).",
      inputSchema: { ...pkg },
    },
    async ({ package_id, version }) => rawResult(await svc.getIg(package_id ?? null, version ?? null)),
  );

  server.registerTool(
    "fhir_list_artifacts",
    {
      description:
        "List an IG's conformance artifacts (StructureDefinitions, ValueSets, CodeSystems, examples) as summary rows. " +
        "Without package_id only the default IG is listed; all_packages=true lists every installed package. " +
        "Zero rows comes with data.hint naming the other packages that match.",
      inputSchema: {
        resource_type: z.string().nullish().default(null),
        grouping_id: z.string().nullish().default(null),
        ...pkg,
        ...allPackages,
        limit: z.number().int().default(50),
      },
    },
    async ({ resource_type, grouping_id, package_id, version, all_packages, limit }) =>
      rawResult(
        await svc.listArtifacts(package_id ?? null, version ?? null, resource_type ?? null, grouping_id ?? null, limit ?? 50, all_packages ?? false),
      ),
  );

  server.registerTool(
    "fhir_search_artifacts",
    {
      description:
        "Full-text search an IG's artifacts by id / canonical URL / name / title / description. " +
        "Without package_id only the default IG is searched; all_packages=true searches every installed package. " +
        "Zero hits comes with data.hint naming the other packages that match (e.g. Claim → the PAS IG).",
      inputSchema: { keyword: z.string(), resource_type: z.string().nullish().default(null), ...pkg, ...allPackages, limit: z.number().int().default(20) },
    },
    async ({ keyword, resource_type, package_id, version, all_packages, limit }) =>
      rawResult(await svc.searchArtifacts(keyword, package_id ?? null, version ?? null, resource_type ?? null, limit ?? 20, all_packages ?? false)),
  );

  server.registerTool(
    "fhir_list_resource_profiles",
    {
      description: "List the IG's selectable resource Profiles (constraint StructureDefinitions), grouped by base FHIR resource type. " +
        "Without package_id: the default IG (all_packages=true: every installed package; zero rows → data.hint). " +
        "After choosing one, call fhir_get_profile_required_elements to learn exactly which elements it requires.",
      inputSchema: { base_type: z.string().nullish().default(null), ...pkg, ...allPackages },
    },
    async ({ base_type, package_id, version, all_packages }) =>
      rawResult(await svc.listResourceProfiles(package_id ?? null, version ?? null, base_type ?? null, all_packages ?? false)),
  );

  server.registerTool(
    "fhir_rank_resource_profiles",
    {
      description: "Rank candidate Profiles by how many of your source-data field keys match each profile's element paths. Suggests only (selectionRequired:true).",
      inputSchema: { keys: z.array(z.string()), base_type: z.string().nullish().default(null), ...pkg, limit: z.number().int().default(5) },
    },
    async ({ keys, base_type, package_id, version, limit }) =>
      rawResult(await svc.rankResourceProfiles(keys, package_id ?? null, version ?? null, base_type ?? null, limit ?? 5)),
  );

  server.registerTool(
    "fhir_get_profile",
    {
      description:
        "Summary of one Profile / StructureDefinition: identity, base definition, derivation, element count. " +
        "identifier may be an id or a canonical URL, optionally pinned as 'url|version' (an uninstalled version is ARTIFACT_NOT_FOUND).",
      inputSchema: { identifier: z.string(), ...pkg },
    },
    async ({ identifier, package_id, version }) =>
      rawResult(await svc.getProfile(identifier, package_id ?? null, version ?? null)),
  );

  server.registerTool(
    "fhir_get_profile_elements",
    {
      description: "Read a Profile's StructureDefinition snapshot via a view: elements | element | slices | choices | binding | examples. path is required for element/slices/choices/binding. " +
        "Raw min is per element and ignores parent optionality — for the effective required set use fhir_get_profile_required_elements.",
      inputSchema: {
        profile: z.string(),
        view: z.enum(["elements", "element", "slices", "choices", "binding", "examples"]).default("elements"),
        path: z.string().nullish().default(null),
        slice_name: z.string().nullish().default(null),
        ...pkg,
        limit: z.number().int().default(200),
      },
    },
    async ({ profile, view, path, slice_name, package_id, version, limit }) =>
      rawResult(await svc.getProfileElements(profile, package_id ?? null, version ?? null, view ?? "elements", path ?? null, slice_name ?? null, limit ?? 200)),
  );

  server.registerTool(
    "fhir_get_profile_required_elements",
    {
      description:
        "Return every element a profile effectively requires (min>=1 with required ancestors, required slices, choice types, " +
        "invariant-implied value-or-dataAbsentReason) plus target-implied primary content, each classified as auto, coding, " +
        "source_fact or workflow_default, with cardinality, type, binding, fixed/pattern, mustSupport and a short fill hint. " +
        "Use it before writing a resource so every required field is filled; works for any installed IG " +
        "(without package_id the package owning the profile is used; 'url|version' pins a version). " +
        "Profiled extensions are expanded from their definitions, and profile-specific error invariants are listed under `invariants`. " +
        "verbosity='compact' (default) keeps id/required_by/grounding_class/fixed|pattern|value/choices/allowedCodes/hint and folds " +
        "profile-pinned subtrees into one copyable `value`; verbosity='full' adds min/max/types/binding/mustSupport per row.",
      inputSchema: {
        profile: z.string().describe("Profile id (e.g. Patient-twcore) or canonical URL"),
        ...pkg,
        instance: z
          .record(z.any())
          .nullish()
          .default(null)
          .describe("Optional draft resource: optional parents it populates make their min>=1 children required too"),
        include_target_implied: z.boolean().default(true),
        include_mustsupport: z
          .boolean()
          .default(false)
          .describe("Also list mustSupport-but-optional elements (required_by='mustSupport-only'). mustSupport is not required."),
        verbosity: z
          .enum(["compact", "full"])
          .default("compact")
          .describe("compact (default): minimal keys per row, pinned subtrees folded; full: every row with min/max/types/binding/mustSupport"),
      },
    },
    async ({ profile, package_id, version, instance, include_target_implied, include_mustsupport, verbosity }) =>
      rawResult(
        await svc.getProfileRequiredElements(
          profile,
          package_id ?? null,
          version ?? null,
          (instance as Record<string, any> | null) ?? null,
          include_target_implied ?? true,
          include_mustsupport ?? false,
          verbosity ?? "compact",
        ),
      ),
  );

  server.registerTool(
    "fhir_get_valueset",
    { description: "Return a ValueSet's definition (compose block + metadata) without expanding it.", inputSchema: { identifier: z.string(), ...pkg } },
    async ({ identifier, package_id, version }) =>
      rawResult(await svc.getValueset(identifier, package_id ?? null, version ?? null)),
  );

  server.registerTool(
    "fhir_expand_valueset",
    {
      description: "Expand a ValueSet to its member codings, resolved locally where possible. Whole large external systems are not enumerated (TOO_BROAD).",
      inputSchema: { identifier: z.string(), ...pkg, limit: z.number().int().default(500) },
    },
    async ({ identifier, package_id, version, limit }) =>
      rawResult(await svc.expandValueset(identifier, package_id ?? null, version ?? null, limit ?? 500)),
  );

  server.registerTool(
    "fhir_lookup_code",
    { description: "Look up the display/definition of a (system, code) pair from locally held terminology.", inputSchema: { system: z.string(), code: z.string(), ...pkg } },
    async ({ system, code, package_id, version }) =>
      rawResult(await svc.lookupCode(system, code, package_id ?? null, version ?? null)),
  );

  server.registerTool(
    "fhir_validate_code",
    {
      description:
        "Check whether a (system, code) is a member of a ValueSet. Returns valid | invalid | unverifiable. " +
        "value_set may be pinned as 'url|version'.",
      inputSchema: { system: z.string(), code: z.string(), value_set: z.string(), ...pkg },
    },
    async ({ system, code, value_set, package_id, version }) =>
      rawResult(await svc.validateCode(system, code, value_set, package_id ?? null, version ?? null)),
  );

  server.registerTool(
    "fhir_normalize_code",
    {
      description: "Turn free text into ranked candidate codes for a target system or ValueSet (ConceptMap + lexical + semantic). Provide at least one of value_set or system.",
      inputSchema: { text: z.string(), value_set: z.string().nullish().default(null), system: z.string().nullish().default(null), ...pkg, limit: z.number().int().default(10) },
    },
    async ({ text, value_set, system, package_id, version, limit }) =>
      rawResult(await svc.normalizeCode(text, value_set ?? null, system ?? null, package_id ?? null, version ?? null, limit ?? 10)),
  );

  server.registerTool(
    "fhir_resolve_reference",
    {
      description: "Mint (or return) a stable urn:uuid reference for a logical key within a build context, so resources can reference each other before finalization.",
      inputSchema: { key: z.string(), resource_type: z.string().nullish().default(null), context_id: z.string().nullish().default(null), display: z.string().nullish().default(null) },
    },
    async ({ key, resource_type, context_id, display }) => {
      if (!key || !String(key).trim()) {
        return rawResult(JSON.stringify({ ok: false, data: null, warnings: [], error: { code: "INVALID_ARGUMENT", message: "key is required" } }));
      }
      const [cid, urn] = fhirReference.mint(context_id ?? null, String(key));
      return rawResult(
        JSON.stringify({
          ok: true,
          data: { contextId: cid, reference: urn, resourceType: resource_type ?? null, display: display ?? null },
          warnings: [],
          provenance: null,
        }),
      );
    },
  );

  server.registerTool(
    "fhir_build_bundle",
    {
      description: "Assemble inline FHIR resources into a Bundle, wiring urn:uuid references. Each entry is {resource, key?, fullUrl?, request?}.",
      inputSchema: { entries: z.array(z.record(z.any())), bundle_type: z.string().default("transaction"), context_id: z.string().nullish().default(null) },
    },
    async ({ entries, bundle_type, context_id }) => {
      if (!Array.isArray(entries) || !entries.length) {
        return rawResult(JSON.stringify({ ok: false, data: null, warnings: [], error: { code: "INVALID_ARGUMENT", message: "entries must be a non-empty list" } }));
      }
      const result = fhirReference.buildBundle(entries as any[], bundle_type ?? "transaction", context_id ?? null);
      const warnings = result.unresolved.length
        ? [`${result.unresolved.length} reference(s) could not be resolved within the bundle`]
        : [];
      return rawResult(JSON.stringify({ ok: true, data: result, warnings, provenance: null }));
    },
  );

  // Grounding collaborators: local-DB terminology names + the IG package for provenance.
  const groundingDeps: GroundingToolDeps = {
    terminology: dbTerminologyNames(),
    packageProvenance: (pid, ver) => svc.packageProvenance(pid, ver),
    logger: groundingLogger,
  };

  server.registerTool(
    "fhir_validate_resource",
    {
      description: TOOL_DESCRIPTIONS.fhir_validate_resource,
      inputSchema: { resource: z.record(z.any()), profile: z.string().nullish().default(null), ...pkg, ...validateBundleGroundingShape },
    },
    async ({ resource, profile, package_id, version, ...g }) => {
      const conformance = await svc.validateResource(resource as Record<string, any>, profile ?? null, package_id ?? null, version ?? null);
      return rawResult(await addResourceGrounding(conformance, resource as Record<string, any>, { ...g, package_id, version } as ValidateGroundingArgs, groundingDeps));
    },
  );

  server.registerTool(
    "fhir_validate_bundle",
    {
      description: TOOL_DESCRIPTIONS.fhir_validate_bundle,
      inputSchema: { bundle: z.record(z.any()), ...pkg, ...validateBundleGroundingShape },
    },
    async ({ bundle, package_id, version, ...g }) => {
      const conformance = await svc.validateBundle(bundle as Record<string, any>, package_id ?? null, version ?? null);
      return rawResult(await addBundleGrounding(conformance, bundle as Record<string, any>, { ...g, package_id, version } as ValidateGroundingArgs, groundingDeps));
    },
  );

  server.registerTool(
    "fhir_check_grounding",
    { description: TOOL_DESCRIPTIONS.fhir_check_grounding, inputSchema: groundingInputShape },
    async (args) => rawResult(await runCheckGroundingTool(args as CheckGroundingArgs, groundingDeps)),
  );

  server.registerTool(
    "fhir_check_completeness",
    { description: TOOL_DESCRIPTIONS.fhir_check_completeness, inputSchema: completenessInputShape },
    async (args) => rawResult(await runCheckCompletenessTool(args as CompletenessInput, groundingDeps)),
  );

  server.registerTool(
    "fhir_get_resource_skeleton",
    {
      description: "Get a blanked, annotated fill-form for authoring a resource against a profile (paths, cardinality, types, candidate codes, examples). " +
        "Each field's `required` is the element's own min>=1; `effectiveRequired` also requires every ancestor to be required. " +
        "For the complete required list (slices, invariants, where each value comes from) call fhir_get_profile_required_elements.",
      inputSchema: { profile: z.string(), ...pkg, candidate_limit: z.number().int().default(20), include_examples: z.boolean().default(true) },
    },
    async ({ profile, package_id, version, candidate_limit, include_examples }) =>
      rawResult(await svc.getResourceSkeleton(profile, package_id ?? null, version ?? null, candidate_limit ?? 20, include_examples ?? true)),
  );

  server.registerTool(
    "fhir_finalize_resource",
    {
      description: "Finalize an LLM-filled draft: pin mechanical fields (fixed/pattern/meta.profile), infer single-system codings, wire references, generate narrative, then validate. Does not auto-loop.",
      inputSchema: {
        profile: z.string(),
        draft: z.record(z.any()),
        context_id: z.string().nullish().default(null),
        key: z.string().nullish().default(null),
        ...pkg,
        generate_narrative: z.boolean().default(true),
      },
    },
    async ({ profile, draft, context_id, key, package_id, version, generate_narrative }) =>
      rawResult(
        await svc.finalizeResource(
          profile,
          draft as Record<string, any>,
          context_id ?? null,
          key ?? null,
          package_id ?? null,
          version ?? null,
          generate_narrative ?? true,
        ),
      ),
  );
}

// Lazily-initialized FHIR Condition service singleton.
let _fhirCondition: FHIRConditionService | null = null;
async function getFhirConditionService(): Promise<FHIRConditionService | null> {
  if (_fhirCondition) return _fhirCondition;
  try {
    const svc = new FHIRConditionService();
    await svc.initialize();
    _fhirCondition = svc;
    return _fhirCondition;
  } catch (err) {
    logError("FHIR Condition service init failed", { error: String((err as Error).message) });
    return null;
  }
}

// Lazily-initialized FHIR Medication service singleton.
let _fhirMedication: FHIRMedicationService | null = null;
async function getFhirMedicationService(): Promise<FHIRMedicationService | null> {
  if (_fhirMedication) return _fhirMedication;
  try {
    const svc = new FHIRMedicationService();
    await svc.initialize();
    _fhirMedication = svc;
    return _fhirMedication;
  } catch (err) {
    logError("FHIR Medication service init failed", { error: String((err as Error).message) });
    return null;
  }
}

/**
 * Force-initialize every service singleton and report which ones came up.
 * Mirrors the Python lifespan's eager service creation + `_admin_service_registry`
 * ({key: service is not None}). Used by the admin overview's `services` block so
 * `initialized` matches Python regardless of which MCP tools have been called.
 * Key order matches Python `_admin_service_registry`.
 */
export async function getServiceRegistry(): Promise<Record<string, boolean>> {
  const [icd, drug, hs, food, cond, med, lab, ig, snomed] = await Promise.all([
    getIcdService(),
    getDrugService(),
    getSupplementsService(),
    getFoodService(),
    getFhirConditionService(),
    getFhirMedicationService(),
    getLabService(),
    getFhirIgService(),
    getSnomedService(),
  ]);
  return {
    icd: icd !== null,
    drug: drug !== null,
    health_supplements: hs !== null,
    food_nutrition: food !== null,
    fhir_condition: cond !== null,
    fhir_medication: med !== null,
    lab: lab !== null,
    ig: ig !== null,
    snomed: snomed !== null,
  };
}

/** Register the FHIR Condition tool group. Mirrors `_TOOL_GROUPS["FHIR R4 (Condition)"]`. */
function registerFhirConditionTools(server: McpServer, svc: FHIRConditionService): void {
  server.registerTool(
    "query_fhir_condition",
    {
      description:
        "Generate a FHIR R4 Condition resource from an ICD-10-CM code or a diagnosis keyword. " +
        "Provide exactly one of icd_code (Path A — full field support) or diagnosis_keyword " +
        "(Path B — search-first; only patient_id/clinical_status/verification_status/severity applied).",
      inputSchema: {
        icd_code: z.string().nullish().default(null),
        diagnosis_keyword: z.string().nullish().default(null),
        patient_id: z.string().default(""),
        clinical_status: z
          .enum(["active", "inactive", "resolved", "remission"])
          .default("active"),
        verification_status: z
          .enum(["confirmed", "provisional", "differential", "refuted"])
          .default("confirmed"),
        category: z
          .enum(["encounter-diagnosis", "problem-list-item"])
          .default("encounter-diagnosis"),
        severity: z.string().nullish().default(null),
        onset_date: z.string().nullish().default(null),
        recorded_date: z.string().nullish().default(null),
        additional_notes: z.string().nullish().default(null),
      },
    },
    async ({
      icd_code,
      diagnosis_keyword,
      patient_id,
      clinical_status,
      verification_status,
      category,
      severity,
      onset_date,
      recorded_date,
      additional_notes,
    }) => {
      if (diagnosis_keyword) {
        return jsonResult(
          await svc.createConditionFromSearch(diagnosis_keyword, patient_id ?? "", {
            clinical_status,
            verification_status,
            severity: severity ?? null,
          }),
        );
      }
      if (!icd_code) return jsonResult({ error: "Provide either icd_code or diagnosis_keyword" });
      return jsonResult(
        await svc.createCondition(icd_code, patient_id ?? "", {
          clinical_status,
          verification_status,
          category,
          severity: severity ?? null,
          onset_date: onset_date ?? null,
          recorded_date: recorded_date ?? null,
          additional_notes: additional_notes ?? null,
        }),
      );
    },
  );

  server.registerTool(
    "validate_fhir_condition",
    {
      description:
        "Validate a FHIR R4 Condition resource for required fields (resourceType/code/subject) " +
        "and status presence. Basic structural validation only.",
      inputSchema: { condition_json: z.string() },
    },
    async ({ condition_json }) => {
      let condition: Record<string, unknown>;
      try {
        condition = JSON.parse(condition_json);
      } catch (e) {
        const msg = `Invalid JSON: ${String((e as Error).message)}`;
        return jsonResult({ error: msg, valid: false, errors: [msg] });
      }
      return jsonResult(svc.validateCondition(condition));
    },
  );
}

/** Register the FHIR Medication tool group. Mirrors `_TOOL_GROUPS["FHIR R4 (Medication)"]`. */
function registerFhirMedicationTools(server: McpServer, svc: FHIRMedicationService): void {
  server.registerTool(
    "query_fhir_medication",
    {
      description:
        "Generate a FHIR R4 Medication or MedicationKnowledge resource for a TFDA drug. " +
        "Provide exactly one of license_id (Path A — direct) or keyword (Path B — search-first). " +
        "Derived from normalized TFDA data only (no RxNorm).",
      inputSchema: {
        license_id: z.string().nullish().default(null),
        keyword: z.string().nullish().default(null),
        resource_type: z.enum(["Medication", "MedicationKnowledge"]).default("Medication"),
      },
    },
    async ({ license_id, keyword, resource_type }) => {
      if (license_id) {
        return jsonResult(await svc.createMedication(license_id, resource_type));
      }
      if (keyword) {
        return jsonResult(await svc.createMedicationFromSearch(keyword, resource_type));
      }
      return jsonResult({ error: "Provide either license_id or keyword" });
    },
  );

  server.registerTool(
    "validate_fhir_medication",
    {
      description:
        "Validate structure and core field semantics of FHIR Medication / MedicationKnowledge " +
        "resources (resourceType, code.coding, ingredient items). Basic validation only.",
      inputSchema: { medication_json: z.string() },
    },
    async ({ medication_json }) => {
      let medication: Record<string, unknown>;
      try {
        medication = JSON.parse(medication_json);
      } catch (e) {
        const msg = `Invalid JSON: ${String((e as Error).message)}`;
        return jsonResult({ error: msg, valid: false, errors: [msg] });
      }
      return jsonResult(svc.validateMedication(medication));
    },
  );
}

// Lazily-initialized FHIR Server (registry) service singleton — always-on group.
let _fhirServer: FHIRServerService | null = null;
async function getFhirServerService(): Promise<FHIRServerService | null> {
  if (_fhirServer) return _fhirServer;
  try {
    const svc = new FHIRServerService();
    await svc.initialize();
    _fhirServer = svc;
    return _fhirServer;
  } catch (err) {
    logError("FHIR Server service init failed", { error: String((err as Error).message) });
    return null;
  }
}

/** Register the always-on FHIR Servers tool group. Mirrors `_TOOL_GROUPS["FHIR Servers"]`. */
function registerFhirServerTools(server: McpServer, svc: FHIRServerService): void {
  server.registerTool(
    "list_fhir_servers",
    {
      description:
        "List admin-configured external FHIR servers available for MCP workflows. " +
        "Discovery entry point — returns {count, servers:[...]} with identity, capabilities, " +
        "non-sensitive auth metadata, and the last stored probe. Secrets are never returned.",
      inputSchema: { include_disabled: z.boolean().default(false) },
    },
    async ({ include_disabled }) => {
      try {
        return jsonResult(await svc.listFhirServers(include_disabled ?? false));
      } catch (e) {
        return jsonResult({ error: "Failed to list FHIR servers", detail: String((e as Error).message) });
      }
    },
  );

  server.registerTool(
    "get_fhir_server_status",
    {
      description:
        "Get the status and configuration of ONE admin-configured external FHIR server " +
        "(same fields as list_fhir_servers). Does not make a live call — returns the last " +
        "stored probe. Secrets are never returned.",
      inputSchema: { server_key: z.string() },
    },
    async ({ server_key }) => {
      try {
        return jsonResult(await svc.getFhirServerStatus(server_key));
      } catch (e) {
        return jsonResult({ error: "Failed to get FHIR server status", detail: String((e as Error).message) });
      }
    },
  );

  server.registerTool(
    "crud_fhir_server",
    {
      description:
        "Perform a controlled FHIR REST operation against an admin-configured server. " +
        "Never accepts arbitrary URLs; builds standard FHIR paths from operation/resource_type/" +
        "resource_id. Write ops require confirm_write=true and must be in the server's allowed set.",
      inputSchema: {
        server_key: z.string(),
        operation: z
          .enum(["metadata", "read", "search", "create", "update", "patch", "delete"])
          .default("metadata"),
        resource_type: z.string().default(""),
        resource_id: z.string().default(""),
        query_json: z.string().default(""),
        resource_json: z.string().default(""),
        patch_json: z.string().default(""),
        confirm_write: z.boolean().default(false),
        token_strategy: z.enum(["auto", "fresh", "cached"]).default("auto"),
      },
    },
    async (args) =>
      jsonResult(
        await svc.crudFhirServer({
          server_key: args.server_key,
          operation: args.operation ?? "metadata",
          resource_type: args.resource_type ?? "",
          resource_id: args.resource_id ?? "",
          query_json: args.query_json ?? "",
          resource_json: args.resource_json ?? "",
          patch_json: args.patch_json ?? "",
          confirm_write: args.confirm_write ?? false,
          token_strategy: args.token_strategy ?? "auto",
        }),
      ),
  );
}

/**
 * Register the SNOMED CT tool group. Mirrors `_TOOL_GROUPS["SNOMED CT"]`.
 */
function registerSnomedTools(server: McpServer, svc: SnomedService): void {
  server.registerTool(
    "search_snomed_concept",
    {
      description:
        "Search SNOMED CT International Edition by English term (hybrid BM25 + semantic). " +
        "Returns up to limit closest concepts with concept_id, fsn, preferred_term, active, " +
        "and hierarchy_tag. For full detail use query_snomed_concept.",
      inputSchema: {
        query: z.string(),
        limit: z.number().int().default(3),
        // Python annotates `hierarchy_filter: int = None`, which Pydantic renders as
        // {type:integer, default:null}. Zod cannot reproduce that exact shape while
        // keeping the param optional AND accepting an omitted value at runtime
        // (.default(null) on a non-nullable number marks it required and rejects
        // null). nullish().default(null) is runtime-faithful; only the strict-schema
        // type rendering (nullable union vs bare integer) differs — cosmetic.
        hierarchy_filter: z.number().int().nullish().default(null),
      },
    },
    async ({ query, limit, hierarchy_filter }) =>
      jsonResult(await svc.searchConcepts(query, Math.min(limit ?? 3, 10), hierarchy_filter ?? null)),
  );

  server.registerTool(
    "query_snomed_concept",
    {
      description:
        "Fetch a SNOMED CT concept with optional IS-A hierarchy expansion (ancestors + children). " +
        "The preferred entry point when you want the concept record AND its surrounding tree.",
      inputSchema: {
        concept_id: z.number().int(),
        include_parents: z.boolean().default(true),
        include_children: z.boolean().default(true),
        parent_limit: z.number().int().default(10),
        child_limit: z.number().int().default(20),
      },
    },
    async ({ concept_id, include_parents, include_children, parent_limit, child_limit }) => {
      const concept = await svc.getConcept(concept_id);
      if (concept === null) {
        return jsonResult({ error: `Concept ${concept_id} not found` });
      }
      const result: Record<string, unknown> = { concept_id, concept };
      if (include_parents ?? true) {
        const parents = await svc.getAncestors(concept_id, Math.min(parent_limit ?? 10, 20));
        result.ancestor_count = parents.length;
        result.ancestors = parents;
      }
      if (include_children ?? true) {
        const children = await svc.getChildren(concept_id, Math.min(child_limit ?? 20, 200));
        result.children_count = children.length;
        result.children = children;
      }
      return jsonResult(result);
    },
  );

  server.registerTool(
    "get_snomed_relationships",
    {
      description:
        "Get the clinical attribute relationships (non-IS-A) for a SNOMED CT concept, grouped " +
        "by relationship type with a human-readable label and list of target concepts.",
      inputSchema: {
        concept_id: z.number().int(),
        // See hierarchy_filter above — same Pydantic-vs-Zod rendering caveat for
        // a bare `int = None` param; nullish().default(null) is runtime-faithful.
        relationship_type_id: z.number().int().nullish().default(null),
      },
    },
    async ({ concept_id, relationship_type_id }) => {
      const results = await svc.getRelationships(concept_id, relationship_type_id ?? null);
      const relationshipCount = results.reduce(
        (sum, r) => sum + (r.targets as unknown[]).length,
        0,
      );
      return jsonResult({
        concept_id,
        relationship_count: relationshipCount,
        relationships: results,
      });
    },
  );

  server.registerTool(
    "query_snomed_mapping",
    {
      description:
        "Map between ICD-10-CM codes and SNOMED CT concepts (bidirectional). " +
        "mode=icd: keyword is an ICD-10 code → mapped SNOMED concepts. " +
        "mode=snomed: keyword is a numeric concept_id or English term → mapped ICD-10 codes.",
      inputSchema: {
        mode: z.enum(["icd", "snomed"]).default("icd"),
        keyword: z.string().default(""),
      },
    },
    async ({ mode, keyword }) => {
      mode = mode ?? "icd";
      keyword = keyword ?? "";
      if (mode === "icd") {
        if (!keyword) return jsonResult({ error: "Provide keyword when mode is icd" });
        const results = await svc.mapIcdToSnomed(keyword);
        return jsonResult({ mode: "icd", keyword: keyword.toUpperCase(), snomed_concepts: results });
      }
      if (mode === "snomed") {
        if (!keyword) return jsonResult({ error: "Provide keyword when mode is snomed" });
        let conceptId: number;
        if (/^\d+$/.test(keyword.trim())) {
          conceptId = Number(keyword.trim());
        } else {
          const matches = await svc.searchConcepts(keyword, 1);
          if (!matches.length) {
            return jsonResult({
              error:
                "For mode=snomed, keyword must be a numeric concept_id or match a SNOMED concept",
            });
          }
          conceptId = Number(matches[0].concept_id);
        }
        const results = await svc.mapSnomedToIcd(conceptId);
        return jsonResult({ mode: "snomed", keyword: conceptId, icd10_mappings: results });
      }
      return jsonResult({ error: "Provide mode as icd or snomed" });
    },
  );
}

/**
 * Register the LOINC tool group. Mirrors `_TOOL_GROUPS["Lab / LOINC"]` minus
 * `search_loinc` / `interpret_lab_result` / `batch_interpret_lab_results`
 * (search needs the embedding service; interpretation is a later batch).
 */
function registerLabTools(server: McpServer, svc: LabService): void {
  server.registerTool(
    "search_loinc",
    {
      description:
        "Discover LOINC codes and categories with mode-specific search behavior. " +
        "code (default): hybrid BM25 + semantic search by test name/abbreviation/analyte " +
        "(optional category narrows to a LOINC class). category: list or filter categories. " +
        "specimen: search by specimen/system type. component: search by analyte. " +
        "keyword is required for code/specimen/component modes.",
      inputSchema: {
        mode: z.enum(["code", "category", "specimen", "component"]).default("code"),
        keyword: z.string().default(""),
        category: z.string().nullish().default(null),
        limit: z.number().int().default(3),
      },
    },
    async ({ mode, keyword, category, limit }) => {
      mode = mode ?? "code";
      keyword = keyword ?? "";
      const lim = Math.min(Math.max(1, limit ?? 3), 10);

      if (mode === "category") {
        const all = (await svc.listCategories()) as { categories?: unknown[] };
        if (!keyword) return jsonResult(all);
        const categories = all.categories ?? [];
        const filtered = categories
          .filter((c) => String(c).toLowerCase().includes(keyword.toLowerCase()))
          .slice(0, lim);
        return jsonResult({
          mode: "category",
          keyword,
          total_found: filtered.length,
          categories: filtered,
        });
      }

      if (!keyword) {
        return jsonResult({ error: `keyword is required for mode=${mode}`, mode });
      }

      if (mode === "code") {
        return jsonResult(await svc.searchLoincCode(keyword, category ?? null, lim));
      }
      if (mode === "specimen") {
        return jsonResult(await svc.searchBySpecimen(keyword, lim));
      }
      if (mode === "component") {
        return jsonResult(await svc.findRelatedTests(keyword, lim));
      }
      return jsonResult({ error: `Unsupported mode: ${mode}` });
    },
  );

  server.registerTool(
    "interpret_lab_result",
    {
      description:
        "Interpret one lab result against the applicable age/gender-stratified LOINC " +
        "reference range. Returns the range, the measured value, and a normal/high/low flag. " +
        "Reference values are general guidance only.",
      inputSchema: {
        loinc_code: z.string(),
        value: z.number(),
        age: z.number().int(),
        gender: z.enum(["M", "F", "all"]).default("all"),
      },
    },
    async ({ loinc_code, value, age, gender }) =>
      jsonResult(await svc.interpretLabResult(loinc_code, value, age, gender ?? "all")),
  );

  server.registerTool(
    "batch_interpret_lab_results",
    {
      description:
        "Interpret a full panel of lab results against LOINC reference ranges in one call. " +
        "results_json must be a JSON array of {loinc_code, value} objects; passing a non-array " +
        "returns an error without calling the service.",
      inputSchema: {
        results_json: z.string(),
        age: z.number().int(),
        gender: z.enum(["M", "F", "all"]).default("all"),
      },
    },
    async ({ results_json, age, gender }) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(results_json);
      } catch (e) {
        return jsonResult({ error: `Invalid JSON: ${String((e as Error).message)}` });
      }
      if (!Array.isArray(parsed)) {
        return jsonResult({
          error: "results_json must be a JSON array of {loinc_code, value} objects",
        });
      }
      return jsonResult(
        await svc.batchInterpretResults(parsed as Record<string, unknown>[], age, gender ?? "all"),
      );
    },
  );

  server.registerTool(
    "query_loinc",
    {
      description:
        "Look up a known LOINC code for full detail or age/gender-stratified reference range. " +
        "Use after you already know the LOINC code; for discovery use search_loinc.",
      inputSchema: {
        mode: z.enum(["detail", "reference_range"]).default("detail"),
        loinc_code: z.string().default(""),
        age: z.number().int().nullish().default(null),
        gender: z.enum(["M", "F", "all"]).default("all"),
      },
    },
    async ({ mode, loinc_code, age, gender }) => {
      // Mirror the Python wrapper's argument validation + mode dispatch.
      if (!loinc_code) return jsonResult({ error: "loinc_code is required" });
      if (mode === "detail") {
        return jsonResult(await svc.getPatientFriendlyName(loinc_code));
      }
      if (mode === "reference_range") {
        if (age === undefined || age === null) {
          return jsonResult({ error: "age is required for mode=reference_range" });
        }
        return jsonResult(await svc.getReferenceRange(loinc_code, age, gender ?? "all"));
      }
      return jsonResult({ error: `Unsupported mode: ${mode}` });
    },
  );
}

/**
 * Register the Clinical Calculators tool group (always-on, stateless).
 *
 * Pure scoring functions — no DB, no module gating. Registered unconditionally
 * like `health_check` and the FHIR Servers group. Each calculator is its own
 * tool whose inputSchema is the bounded `*InputShape` exported next to its
 * pure function in `clinicalCalculators.ts`, so out-of-range and wrong-unit
 * values are rejected before any formula runs; handlers wrap via `jsonResult`.
 */
function registerClinicalCalculatorTools(server: McpServer): void {
  server.registerTool(
    "calculate_chads2_vasc",
    {
      description:
        "CHA₂DS₂-VASc stroke-risk score for non-valvular atrial fibrillation (0–9). " +
        "Accepts raw age/sex and computes brackets internally; also returns the 2024 ESC " +
        "CHA₂DS₂-VA adjusted score (sex removed). Decision support only.",
      inputSchema: chads2VascInputShape,
    },
    async (args) => jsonResult(calculateChads2Vasc(args)),
  );

  server.registerTool(
    "calculate_wells_pe",
    {
      description:
        "Wells criteria for pulmonary embolism (two-tier + three-tier risk). " +
        "Binary findings are booleans; heart_rate_bpm is raw and the >100 criterion is computed.",
      inputSchema: wellsPeInputShape,
    },
    async (args) => jsonResult(calculateWellsPe(args)),
  );

  server.registerTool(
    "calculate_wells_dvt",
    {
      description:
        "Wells criteria for deep-vein thrombosis (two-tier + three-tier risk). " +
        "All items are binary clinical findings.",
      inputSchema: wellsDvtInputShape,
    },
    async (args) => jsonResult(calculateWellsDvt(args)),
  );

  server.registerTool(
    "calculate_das28",
    {
      description:
        "DAS28 rheumatoid arthritis disease activity. formula=esr needs esr (mm/h); " +
        "formula=crp needs crp (mg/L). Joint counts are 28-joint (0–28); global_health is a 0–100 VAS " +
        "(not the 0–10 scale CDAI uses). Returns score and activity band (remission/low/moderate/high).",
      inputSchema: das28InputShape,
    },
    async (args) => {
      try {
        return jsonResult(calculateDas28(args));
      } catch (err) {
        return jsonResult({ error: String((err as Error).message) });
      }
    },
  );

  server.registerTool(
    "calculate_cdai",
    {
      description:
        "CDAI (lab-free) rheumatoid arthritis disease activity (0–76). Tender and swollen counts use " +
        "the 28-joint assessment (0–28 each); patient and provider global assessments are 0–10.",
      inputSchema: cdaiInputShape,
    },
    async (args) => jsonResult(calculateCdai(args)),
  );

  server.registerTool(
    "calculate_bmi",
    {
      description:
        "Body mass index with Taiwan (Asian) cutoffs: <18.5 underweight, 18.5–23.9 normal, " +
        "24–26.9 overweight, ≥27 obese. Height in cm (not metres), weight in kg.",
      inputSchema: bmiInputShape,
    },
    async (args) => jsonResult(calculateBmi(args)),
  );

  server.registerTool(
    "calculate_egfr",
    {
      description:
        "Estimated glomerular filtration rate using the CKD-EPI 2021 creatinine equation " +
        "(race-free), adults ≥18 only. serum_creatinine_mgdl in mg/dL (convert µmol/L by dividing by 88.4). " +
        "Returns eGFR in mL/min/1.73m² and KDIGO CKD stage.",
      inputSchema: egfrInputShape,
    },
    async (args) => jsonResult(calculateEgfr(args)),
  );

  server.registerTool(
    "calculate_has_bled",
    {
      description:
        "HAS-BLED bleeding risk on oral anticoagulation (0–9). Accepts raw age (the >65 criterion " +
        "is computed) and raw systolic BP (the H criterion is computed as SBP >160 mmHg). " +
        "Returns score and high/low bleeding-risk category (≥3 high).",
      inputSchema: hasBledInputShape,
    },
    async (args) => jsonResult(calculateHasBled(args)),
  );

  server.registerTool(
    "calculate_curb65",
    {
      description:
        "CURB-65 community-acquired pneumonia severity (0–5). BUN in mg/dL (threshold >19), " +
        "respiratory rate ≥30, hypotension SBP<90 or DBP≤60, confusion, age ≥65.",
      inputSchema: curb65InputShape,
    },
    async (args) => jsonResult(calculateCurb65(args)),
  );

  server.registerTool(
    "calculate_qsofa",
    {
      description:
        "qSOFA sepsis screening (0–3): respiratory rate ≥22, altered mentation (GCS <15), systolic BP ≤100. " +
        "≥2 suggests sepsis and further evaluation.",
      inputSchema: qsofaInputShape,
    },
    async (args) => jsonResult(calculateQsofa(args)),
  );

  server.registerTool(
    "calculate_gcs",
    {
      description:
        "Glasgow Coma Scale (3–15). eye_response 1–4, verbal_response 1–5, motor_response 1–6. " +
        "Returns total, E/V/M sub-scores, and mild/moderate/severe severity (≤8 severe).",
      inputSchema: gcsInputShape,
    },
    async (args) => jsonResult(calculateGcs(args)),
  );
}

/** Register the always-on System group (`health_check`). */
function registerSystemTools(server: McpServer): void {
  server.registerTool(
    "health_check",
    {
      description:
        "Return runtime readiness of the MCP server and every module-backed service. " +
        "Call this first before any workflow to confirm the required services are online.",
      inputSchema: {},
    },
    async () => ({
      content: [{ type: "text" as const, text: await buildHealthCheck() }],
    }),
  );
}

// ── Static tool catalog (admin console) ───────────────────────────────────────
// Every tool this server can expose, registered or not, derived from the same
// register* functions buildMcpServer uses — so the catalog can never drift from
// what MCP / the OpenAPI bridge would serve. The register functions are run
// against a recording stub; handlers are captured but never invoked, and the
// service argument is a placeholder that throws if anything touches it.

/** Tool group keys, in catalog display order. */
export type ToolGroupKey =
  | "icd"
  | "drug"
  | "lab"
  | "snomed"
  | "fhir_condition"
  | "fhir_medication"
  | "fhir_ig"
  | "health_supplements"
  | "food_nutrition"
  | "fhir_servers"
  | "calculators"
  | "system";

export interface ToolGroupInfo {
  key: ToolGroupKey;
  label: string;
  /** ModuleStatus key gating the group; null = always registered. */
  module: keyof ModuleStatus | null;
}

export const TOOL_GROUPS: readonly ToolGroupInfo[] = [
  { key: "icd", label: "ICD-10", module: "icd" },
  { key: "drug", label: "Drug / TFDA", module: "drug" },
  { key: "lab", label: "Lab / LOINC", module: "lab" },
  { key: "snomed", label: "SNOMED CT", module: "snomed" },
  { key: "fhir_condition", label: "FHIR R4 (Condition)", module: "fhir_condition" },
  { key: "fhir_medication", label: "FHIR R4 (Medication)", module: "fhir_medication" },
  { key: "fhir_ig", label: "FHIR IG", module: "ig" },
  { key: "health_supplements", label: "Health Supplements", module: "health_supplements" },
  { key: "food_nutrition", label: "Food Nutrition", module: "food_nutrition" },
  { key: "fhir_servers", label: "FHIR Servers", module: null },
  { key: "calculators", label: "Clinical Calculators", module: null },
  { key: "system", label: "System", module: null },
];

/** Tools that can change state outside this server (everything else is read-only). */
export const WRITE_CAPABLE_TOOLS: ReadonlySet<string> = new Set(["crud_fhir_server"]);

export interface CatalogTool {
  name: string;
  group: ToolGroupKey;
  description: string;
  shape: z.ZodRawShape;
}

const CATALOG_PLACEHOLDER_SERVICE: never = new Proxy(
  {},
  {
    get(_t, prop) {
      throw new Error(`tool catalog: service accessed during registration (${String(prop)})`);
    },
  },
) as never;

const CATALOG_REGISTRARS: ReadonlyArray<[ToolGroupKey, (server: McpServer) => void]> = [
  ["icd", (s) => registerIcdTools(s, CATALOG_PLACEHOLDER_SERVICE)],
  ["drug", (s) => registerDrugTools(s, CATALOG_PLACEHOLDER_SERVICE)],
  ["lab", (s) => registerLabTools(s, CATALOG_PLACEHOLDER_SERVICE)],
  ["snomed", (s) => registerSnomedTools(s, CATALOG_PLACEHOLDER_SERVICE)],
  ["fhir_condition", (s) => registerFhirConditionTools(s, CATALOG_PLACEHOLDER_SERVICE)],
  ["fhir_medication", (s) => registerFhirMedicationTools(s, CATALOG_PLACEHOLDER_SERVICE)],
  ["fhir_ig", (s) => registerFhirIgTools(s, CATALOG_PLACEHOLDER_SERVICE)],
  ["health_supplements", (s) => registerSupplementsTools(s, CATALOG_PLACEHOLDER_SERVICE)],
  ["food_nutrition", (s) => registerFoodTools(s, CATALOG_PLACEHOLDER_SERVICE)],
  ["fhir_servers", (s) => registerFhirServerTools(s, CATALOG_PLACEHOLDER_SERVICE)],
  ["calculators", (s) => registerClinicalCalculatorTools(s)],
  ["system", (s) => registerSystemTools(s)],
];

let _catalog: CatalogTool[] | null = null;

/** Every tool definition in mcp.ts, grouped and ordered by TOOL_GROUPS. Computed once. */
export function toolCatalog(): readonly CatalogTool[] {
  if (_catalog) return _catalog;
  const out: CatalogTool[] = [];
  for (const [group, register] of CATALOG_REGISTRARS) {
    const recorder = {
      registerTool: (name: string, cfg: { description?: unknown; inputSchema?: z.ZodRawShape }) => {
        out.push({
          name,
          group,
          description: typeof cfg?.description === "string" ? cfg.description : "",
          shape: (cfg?.inputSchema ?? {}) as z.ZodRawShape,
        });
      },
    } as unknown as McpServer;
    register(recorder);
  }
  _catalog = out;
  return out;
}

/** JSON Schema for a catalog tool's input — identical to the OpenAPI bridge's request schema. */
export function catalogToolInputSchema(tool: CatalogTool): Record<string, unknown> {
  return toolInputJsonSchema(tool.shape);
}

/** Names of the tools registered by the most recent buildMcpServer (what MCP / OpenAPI serve now). */
export function registeredToolNames(): Set<string> {
  return new Set(toolRegistry.keys());
}

/** Construct a fresh McpServer with all currently-ported tools registered. */
export async function buildMcpServer(): Promise<McpServer> {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  // Repopulate the OpenAPI tool registry from this build (mirrors Python, where
  // the spec reflects the currently-registered tools). Built into a fresh map and
  // swapped in at the end, so a rebuild with different module gating replaces —
  // never accumulates — entries, and a concurrent /tools call never sees a
  // half-built registry.
  const nextRegistry = new Map<string, RegisteredTool>();
  captureToolRegistrations(server, nextRegistry);

  registerSystemTools(server);

  // Always-on Clinical Calculators group (stateless, registered regardless of module data).
  registerClinicalCalculatorTools(server);

  // Always-on FHIR Servers group (registered regardless of module data).
  {
    const svc = await getFhirServerService();
    if (svc) registerFhirServerTools(server, svc);
  }

  // Module-gated groups: only register when the backing data meets threshold,
  // mirroring Python's ModuleStatusManager add/remove on every tools/list.
  try {
    const status = await getModuleStatus();
    if (status.icd) {
      const svc = await getIcdService();
      if (svc) registerIcdTools(server, svc);
    }
    if (status.lab) {
      registerLabTools(server, await getLabService());
    }
    if (status.snomed) {
      const svc = await getSnomedService();
      if (svc) registerSnomedTools(server, svc);
    }
    if (status.food_nutrition) {
      const svc = await getFoodService();
      if (svc) registerFoodTools(server, svc);
    }
    if (status.drug) {
      const svc = await getDrugService();
      if (svc) registerDrugTools(server, svc);
    }
    if (status.ig) {
      const svc = await getFhirIgService();
      if (svc) registerFhirIgTools(server, svc);
    }
    if (status.health_supplements) {
      const svc = await getSupplementsService();
      if (svc) registerSupplementsTools(server, svc);
    }
    if (status.fhir_condition) {
      const svc = await getFhirConditionService();
      if (svc) registerFhirConditionTools(server, svc);
    }
    if (status.fhir_medication) {
      const svc = await getFhirMedicationService();
      if (svc) registerFhirMedicationTools(server, svc);
    }
  } catch (err) {
    logError("Module-gated tool registration skipped", {
      error: String((err as Error).message),
    });
  }

  toolRegistry = nextRegistry;
  return server;
}
