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
import { healthcheck as dbHealthcheck } from "./db.js";
import { monitor as dbHealthMonitor } from "./dbHealth.js";
import { getClient } from "./cache.js";
import { getModuleStatus } from "./moduleStatus.js";
import { IcdService } from "./icdService.js";
import { LabService } from "./labService.js";
import { SnomedService } from "./snomedService.js";
import { FoodNutritionService } from "./foodService.js";
import { HealthSupplementsService } from "./supplementsService.js";
import { FHIRConditionService } from "./fhirConditionService.js";
import { FHIRMedicationService } from "./fhirMedicationService.js";
import { FHIRServerService } from "./fhirServerService.js";
import { DrugService } from "./drugService.js";
import { ClinicalGuidelineService } from "./guidelineService.js";
import { FHIRIGService } from "./fhirIgService.js";
import * as fhirReference from "./fhirReference.js";
import { getEmbeddingService } from "./embeddingService.js";
import { logError } from "./logger.js";

const SERVER_NAME = "taiwan-health-mcp";
const SERVER_VERSION = "0.0.0";

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
    guideline: false,
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
      guideline: status.guideline,
      ig: status.ig,
      snomed: status.snomed,
    };
  } catch {
    // leave all-false
  }

  return JSON.stringify({
    status: dbOk ? "ok" : "degraded",
    database: dbOk ? "ok" : "error",
    db_health: dbHealthMonitor().snapshot(),
    cache: cacheOk ? "ok" : "error",
    services,
  });
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
 * Register the ICD-10 tool group. Mirrors `_TOOL_GROUPS["ICD-10"]` minus
 * `search_medical_codes` (hybrid search — pending the embedding-service port).
 * Only called when the `icd` module is active, matching Python's dynamic
 * add/remove via ModuleStatusManager.
 */
function registerIcdTools(server: McpServer, svc: IcdService): void {
  server.registerTool(
    "search_medical_codes",
    {
      description:
        "Search ICD-10-CM 2025 diagnosis codes and ICD-10-PCS 2025 procedure codes. " +
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

// Lazily-initialized Clinical Guideline service singleton.
let _guideline: ClinicalGuidelineService | null = null;
async function getGuidelineService(): Promise<ClinicalGuidelineService | null> {
  if (_guideline) return _guideline;
  try {
    const svc = new ClinicalGuidelineService(await getEmbeddingService());
    await svc.initialize();
    _guideline = svc;
    return _guideline;
  } catch (err) {
    logError("Clinical guideline service init failed", { error: String((err as Error).message) });
    return null;
  }
}

/** Register the Guidelines tool group. Mirrors `_TOOL_GROUPS["Guidelines"]`. */
function registerGuidelineTools(server: McpServer, svc: ClinicalGuidelineService): void {
  server.registerTool(
    "search_clinical_guideline",
    {
      description:
        "Search Taiwan clinical practice guidelines by disease name or ICD-10 code. " +
        "Hybrid BM25 + semantic ranking (cross-language). Returns up to `limit` guidelines.",
      inputSchema: {
        keyword: z.string(),
        limit: z.number().int().default(3),
      },
    },
    async ({ keyword, limit }) => jsonResult(await svc.searchGuideline(keyword, limit ?? 3)),
  );

  server.registerTool(
    "query_guideline",
    {
      description:
        "Retrieve a specific section from a Taiwan clinical practice guideline by ICD code. " +
        "section: complete (default) | medication | test | goals | pathway | contraindications. " +
        "contraindications REQUIRES medication_class; pathway accepts optional patient_context_json.",
      inputSchema: {
        icd_code: z.string(),
        section: z
          .enum(["complete", "medication", "test", "goals", "pathway", "contraindications"])
          .default("complete"),
        patient_context_json: z.string().nullish().default(null),
        medication_class: z.string().nullish().default(null),
      },
    },
    async ({ icd_code, section, patient_context_json, medication_class }) => {
      const sec = section ?? "complete";
      if (sec === "contraindications") {
        if (!medication_class) {
          return jsonResult({ error: "medication_class is required for section=contraindications" });
        }
        return jsonResult(await svc.checkMedicationContraindications(icd_code, medication_class));
      }
      if (sec === "pathway") {
        let context: Record<string, unknown> | null = null;
        if (patient_context_json) {
          try {
            context = JSON.parse(patient_context_json);
          } catch {
            return jsonResult({ error: "patient_context_json is not valid JSON" });
          }
        }
        return jsonResult(await svc.suggestClinicalPathway(icd_code, context));
      }
      if (sec === "medication") return jsonResult(await svc.getMedicationRecommendations(icd_code));
      if (sec === "test") return jsonResult(await svc.getTestRecommendations(icd_code));
      if (sec === "goals") return jsonResult(await svc.getTreatmentGoals(icd_code));
      return jsonResult(await svc.getCompleteGuideline(icd_code));
    },
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

/** Register the FHIR IG tool group (19 tools). Mirrors `_TOOL_GROUPS["FHIR IG"]`. */
function registerFhirIgTools(server: McpServer, svc: FHIRIGService): void {
  const pkg = { package_id: z.string().nullish().default(null), version: z.string().nullish().default(null) };

  server.registerTool(
    "fhir_list_igs",
    { description: "List the FHIR Implementation Guide (IG) packages installed on this server.", inputSchema: {} },
    async () => rawResult(await svc.listIgs()),
  );

  server.registerTool(
    "fhir_get_ig",
    { description: "Details of one IG package: identity, dependencies, and per-resource-type artifact counts.", inputSchema: { ...pkg } },
    async ({ package_id, version }) => rawResult(await svc.getIg(package_id ?? null, version ?? null)),
  );

  server.registerTool(
    "fhir_list_artifacts",
    {
      description: "List an IG's conformance artifacts (StructureDefinitions, ValueSets, CodeSystems, examples) as summary rows.",
      inputSchema: { resource_type: z.string().nullish().default(null), grouping_id: z.string().nullish().default(null), ...pkg, limit: z.number().int().default(50) },
    },
    async ({ resource_type, grouping_id, package_id, version, limit }) =>
      rawResult(await svc.listArtifacts(package_id ?? null, version ?? null, resource_type ?? null, grouping_id ?? null, limit ?? 50)),
  );

  server.registerTool(
    "fhir_search_artifacts",
    {
      description: "Full-text search an IG's artifacts by id / canonical URL / name / title / description.",
      inputSchema: { keyword: z.string(), resource_type: z.string().nullish().default(null), ...pkg, limit: z.number().int().default(20) },
    },
    async ({ keyword, resource_type, package_id, version, limit }) =>
      rawResult(await svc.searchArtifacts(keyword, package_id ?? null, version ?? null, resource_type ?? null, limit ?? 20)),
  );

  server.registerTool(
    "fhir_list_resource_profiles",
    {
      description: "List the IG's selectable resource Profiles (constraint StructureDefinitions), grouped by base FHIR resource type.",
      inputSchema: { base_type: z.string().nullish().default(null), ...pkg },
    },
    async ({ base_type, package_id, version }) =>
      rawResult(await svc.listResourceProfiles(package_id ?? null, version ?? null, base_type ?? null)),
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
      description: "Summary of one Profile / StructureDefinition: identity, base definition, derivation, element count.",
      inputSchema: { identifier: z.string(), ...pkg },
    },
    async ({ identifier, package_id, version }) =>
      rawResult(await svc.getProfile(identifier, package_id ?? null, version ?? null)),
  );

  server.registerTool(
    "fhir_get_profile_elements",
    {
      description: "Read a Profile's StructureDefinition snapshot via a view: elements | element | slices | choices | binding | examples. path is required for element/slices/choices/binding.",
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
      description: "Check whether a (system, code) is a member of a ValueSet. Returns valid | invalid | unverifiable.",
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

  server.registerTool(
    "fhir_validate_resource",
    {
      description: "Validate a FHIR resource against an IG profile, in-process (source:builtin). Pre-flight only.",
      inputSchema: { resource: z.record(z.any()), profile: z.string().nullish().default(null), ...pkg },
    },
    async ({ resource, profile, package_id, version }) =>
      rawResult(await svc.validateResource(resource as Record<string, any>, profile ?? null, package_id ?? null, version ?? null)),
  );

  server.registerTool(
    "fhir_validate_bundle",
    {
      description: "Validate a FHIR Bundle in-process: each entry's resource against its meta.profile plus internal reference integrity.",
      inputSchema: { bundle: z.record(z.any()), ...pkg },
    },
    async ({ bundle, package_id, version }) =>
      rawResult(await svc.validateBundle(bundle as Record<string, any>, package_id ?? null, version ?? null)),
  );

  server.registerTool(
    "fhir_get_resource_skeleton",
    {
      description: "Get a blanked, annotated fill-form for authoring a resource against a profile (paths, cardinality, types, candidate codes, examples).",
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
  const [icd, drug, hs, food, cond, med, lab, guideline, ig, snomed] = await Promise.all([
    getIcdService(),
    getDrugService(),
    getSupplementsService(),
    getFoodService(),
    getFhirConditionService(),
    getFhirMedicationService(),
    getLabService(),
    getGuidelineService(),
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
    guideline: guideline !== null,
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

/** Construct a fresh McpServer with all currently-ported tools registered. */
export async function buildMcpServer(): Promise<McpServer> {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

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
    if (status.guideline) {
      const svc = await getGuidelineService();
      if (svc) registerGuidelineTools(server, svc);
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

  return server;
}
