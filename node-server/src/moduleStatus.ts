import { query } from "./db.js";

export interface ModuleStatus {
  icd: boolean;
  drug: boolean;
  health_supplements: boolean;
  food_nutrition: boolean;
  fhir_condition: boolean;
  fhir_medication: boolean;
  lab: boolean;
  guideline: boolean;
  ig: boolean;
  snomed: boolean;
}

const REQUIREMENTS: Array<{
  key: keyof Omit<ModuleStatus, "fhir_condition" | "fhir_medication">;
  table: string;
  minimum: number;
}> = [
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
  {
    key: "guideline",
    table: "guideline.disease_guidelines",
    minimum: 1,
  },
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
  guideline: false,
  ig: false,
  snomed: false,
};

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
      } catch {
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

