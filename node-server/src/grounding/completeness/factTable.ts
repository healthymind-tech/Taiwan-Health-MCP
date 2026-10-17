/**
 * Single data table for fhir_check_completeness: which source facts each target resourceType
 * needs, the FHIR element each fact grounds, why it is required, its grounding class, and the
 * zh-TW label / follow-up question template used when it is missing.
 *
 * Single source of truth with `fhir_get_profile_required_elements` (fhirRequiredElements.ts):
 *  - `groundingClass` is not written here — it is computed from the element path with the same
 *    classification tables the required-elements tool uses (`groundingClassOfPath`);
 *  - the target-implied facts are exactly that tool's PRIMARY_CONTENT table
 *    (`primaryContentGaps()` must be empty; asserted by completeness.test.ts).
 * The `requiredBy` strings stay as the reference implementation (gap_ref.py) emits them, since
 * the parity fixtures compare them verbatim.
 */
import { PRIMARY_CONTENT, groundingClassOfPath } from "../../fhirRequiredElements.js";

export type GroundingClass = "source_fact" | "coding";

export interface FactSpec {
  /** Fact key as used in targets[].require / also_require / optional and extracted_facts[].fact. */
  fact: string;
  /** FHIR element this fact grounds (generic path, as fhir_get_profile_required_elements reports it). */
  element: string;
  /** required_by string reported in the output row. */
  requiredBy: string;
  groundingClass: GroundingClass;
  /** Part of the default required set for the resourceType (spec §2.3.2 table). */
  isDefault: boolean;
  /** zh-TW label used in `missing` ("<item or resourceType> <label>"). */
  labelZh: string;
}

/** Grounding class of a fact's element, from the required-elements classification tables. */
function classOf(element: string): GroundingClass {
  const c = groundingClassOfPath(element);
  if (c !== "source_fact" && c !== "coding") throw new Error(`completeness fact ${element}: unexpected grounding class ${c}`);
  return c;
}

const f = (fact: string, element: string, requiredBy: string, labelZh: string, isDefault = true): FactSpec => ({
  fact,
  element,
  requiredBy,
  groundingClass: classOf(element),
  isDefault,
  labelZh,
});

const medFacts = (rt: "MedicationRequest" | "MedicationStatement"): FactSpec[] => {
  const dosage = rt === "MedicationRequest" ? "dosageInstruction" : "dosage";
  return [
    f("medication", `${rt}.medication[x]`, "profile (medication[x] 1..1)", "藥品"),
    f("dose", `${rt}.${dosage}.doseAndRate.dose[x]`, "target-implied (dosage.doseAndRate.dose[x])", "劑量"),
    f("frequency", `${rt}.${dosage}.timing`, "target-implied (dosage.timing)", "頻次"),
    f("route", `${rt}.${dosage}.route`, "conversion target", "給藥途徑", false),
    f("duration", `${rt}.${dosage}.timing.repeat.boundsDuration`, "conversion target", "給藥天數", false),
  ];
};

/**
 * Fact rows per resourceType, in default-require order (the order facts are checked and the
 * order `missing` labels are emitted).
 */
export const FACT_TABLE: Readonly<Record<string, readonly FactSpec[]>> = {
  Patient: [
    f("identifier", "Patient.identifier", "profile (Patient.identifier 1..*)", "身分證字號或病歷號"),
    f("gender", "Patient.gender", "profile (Patient.gender 1..1)", "性別"),
    f("birthDate", "Patient.birthDate", "profile (Patient.birthDate 1..1)", "出生日期"),
    f("name", "Patient.name", "target-implied (Patient.name)", "姓名"),
  ],
  Encounter: [
    f("period.start", "Encounter.period.start", "target-implied (Encounter.period.start)", "就診日期"),
  ],
  Condition: [f("code", "Condition.code", "target-implied (Condition.code)", "診斷")],
  Observation: [
    f(
      "value",
      "Observation.value[x]",
      "target-implied + invariant vs-2/tw-core-4 (Observation.value[x])",
      "數值",
    ),
    f("effective", "Observation.effective[x]", "profile (Observation.effective[x] 1..1)", "檢查／量測日期"),
  ],
  MedicationRequest: medFacts("MedicationRequest"),
  MedicationStatement: medFacts("MedicationStatement"),
  Immunization: [
    f("occurrence", "Immunization.occurrence[x]", "profile (Immunization.occurrence[x] 1..1)", "接種日期"),
    f("vaccine", "Immunization.vaccineCode", "profile (Immunization.vaccineCode 1..1)", "疫苗"),
  ],
  Procedure: [
    f("code", "Procedure.code", "target-implied (Procedure.code)", "處置"),
    f("performed", "Procedure.performed[x]", "target-implied (Procedure.performed[x])", "執行日期"),
  ],
  AllergyIntolerance: [
    f("substance", "AllergyIntolerance.code", "profile (AllergyIntolerance.code 1..1)", "過敏原"),
  ],
};

/**
 * PRIMARY_CONTENT elements (fhir_get_profile_required_elements' target-implied table) that are not
 * a default fact here — must be empty, otherwise the two tools disagree on what a target needs.
 */
export function primaryContentGaps(): string[] {
  const gaps: string[] = [];
  for (const [rt, rows] of Object.entries(PRIMARY_CONTENT)) {
    for (const [element] of rows) {
      if (!(FACT_TABLE[rt] ?? []).some((r) => r.element === element && r.isDefault)) gaps.push(`${rt}: ${element}`);
    }
  }
  return gaps;
}

/** Labels for facts requested on a resourceType that has no row for them (free-form require). */
const GENERIC_LABEL_ZH: Record<string, string> = {
  identifier: "身分證字號或病歷號", name: "姓名", gender: "性別", birthDate: "出生日期", "period.start": "就診日期",
  code: "診斷", value: "數值", effective: "檢查／量測日期", dose: "劑量", frequency: "頻次", route: "給藥途徑",
  duration: "給藥天數", occurrence: "接種日期", performed: "執行日期", substance: "過敏原", medication: "藥品", vaccine: "疫苗",
};

export function factSpec(resourceType: string, fact: string): FactSpec | undefined {
  return FACT_TABLE[resourceType]?.find((r) => r.fact === fact);
}

export function defaultFacts(resourceType: string): string[] {
  return (FACT_TABLE[resourceType] ?? []).filter((r) => r.isDefault).map((r) => r.fact);
}

export function requiredByOf(resourceType: string, fact: string): string {
  return factSpec(resourceType, fact)?.requiredBy ?? "conversion target";
}

export function labelZhOf(resourceType: string, fact: string): string {
  return factSpec(resourceType, fact)?.labelZh ?? GENERIC_LABEL_ZH[fact] ?? fact;
}

/** Template follow-up question (spec §2.3.4); no LLM. */
export function questionFor(resourceType: string, fact: string, item: string, reason: string): string {
  switch (resourceType) {
    case "Patient": {
      const q: Record<string, string> = {
        identifier: "請提供病人的身分證字號或本院病歷號",
        name: "請提供病人姓名",
        gender: "請提供病人性別",
        birthDate: "請提供病人出生日期" + (reason.includes("age") ? "（紀錄中僅有年齡）" : ""),
      };
      return q[fact] ?? `請提供病人${labelZhOf(resourceType, fact)}`;
    }
    case "Encounter":
      return "請提供本次就診（或住院）日期";
    case "Condition":
      return "請提供本次的診斷" + (reason.includes("ruled-out") ? "（紀錄中只有已排除的診斷）" : "（紀錄中沒有診斷／評估）");
    case "Observation":
      return `請提供${item}的${fact === "value" ? "數值與單位" : "檢查／量測日期"}`;
    case "MedicationRequest":
    case "MedicationStatement":
      return `請提供${item}的${labelZhOf(resourceType, fact)}`;
    case "Immunization":
      return fact === "occurrence" ? `請提供${item}的接種日期` : "請確認接種的疫苗";
    default:
      return `請提供${item}${labelZhOf(resourceType, fact)}`;
  }
}
