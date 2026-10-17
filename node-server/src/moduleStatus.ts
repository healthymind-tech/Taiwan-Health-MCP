import { query } from "./db.js";
import { logWarning } from "./logger.js";

export interface ModuleStatus {
  icd: boolean;
  drug: boolean;
  health_supplements: boolean;
  food_nutrition: boolean;
  fhir_condition: boolean;
  fhir_medication: boolean;
  lab: boolean;
  ig: boolean;
  snomed: boolean;
}

export interface ModuleRequirement {
  key: keyof Omit<ModuleStatus, "fhir_condition" | "fhir_medication">;
  table: string;
  minimum: number;
}

const REQUIREMENTS: ModuleRequirement[] = [
  { key: "icd", table: "icd.diagnoses", minimum: 10_000 },
  { key: "drug", table: "drug.licenses", minimum: 1 },
  {
    key: "health_supplements",
    table: "health_supplements.items",
    minimum: 10,
  },
  {
    key: "food_nutrition",
    table: "food_nutrition.measurements",
    minimum: 10,
  },
  { key: "lab", table: "loinc.concepts", minimum: 1_000 },
  { key: "ig", table: "fhir.ig_packages", minimum: 1 },
  { key: "snomed", table: "snomed.concepts", minimum: 100_000 },
];

const EMPTY_STATUS: ModuleStatus = {
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

/** Row-count thresholds that gate each module's tool group (read-only view). */
export const MODULE_REQUIREMENTS: ReadonlyArray<Readonly<ModuleRequirement>> = REQUIREMENTS;

/** Modules derived from another module's data (no table of their own). */
export const DERIVED_MODULES: Readonly<Record<"fhir_condition" | "fhir_medication", ModuleRequirement["key"]>> = {
  fhir_condition: "icd",
  fhir_medication: "drug",
};

export interface ModuleCount {
  table: string;
  minimum: number;
  /** null when the count query failed (error carries the message). */
  count: number | null;
  error?: string;
}

/**
 * Current row count of every gating table, uncached. For the admin console's
 * "why is this tool disabled" view; tool registration keeps using getModuleStatus.
 */
export async function getModuleCounts(): Promise<Record<ModuleRequirement["key"], ModuleCount>> {
  const out = {} as Record<ModuleRequirement["key"], ModuleCount>;
  await Promise.all(
    REQUIREMENTS.map(async ({ key, table, minimum }) => {
      try {
        const result = await query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM ${table}`,
          [],
          `module_counts.${String(key)}`,
        );
        out[key] = { table, minimum, count: Number.parseInt(result.rows[0]?.count ?? "0", 10) };
      } catch (err) {
        out[key] = { table, minimum, count: null, error: String((err as Error).message) };
      }
    }),
  );
  return out;
}

let cachedStatus: ModuleStatus | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 30_000;

export async function getModuleStatus(force = false): Promise<ModuleStatus> {
  if (!force && cachedStatus && Date.now() - cachedAt < CACHE_TTL_MS) {
    return { ...cachedStatus };
  }

  const status: ModuleStatus = { ...EMPTY_STATUS };
  await Promise.all(
    REQUIREMENTS.map(async ({ key, table, minimum }) => {
      try {
        const result = await query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM ${table}`,
          [],
          `module_status.${String(key)}`,
        );
        status[key] = Number.parseInt(result.rows[0]?.count ?? "0", 10) >= minimum;
      } catch (err) {
        // Fail closed, but never silently: this is what removes a tool group from
        // tools/list, so a transient DB error looks to an MCP client exactly like
        // "the data was never loaded". Without this line there is nothing in the
        // logs to correlate the disappearance against.
        logWarning("Module status probe failed; treating module as unavailable", {
          module: String(key),
          table,
          error: String((err as Error).message),
        });
        status[key] = false;
      }
    }),
  );

  status.fhir_condition = status.icd;
  status.fhir_medication = status.drug;
  cachedStatus = status;
  cachedAt = Date.now();
  return { ...status };
}

