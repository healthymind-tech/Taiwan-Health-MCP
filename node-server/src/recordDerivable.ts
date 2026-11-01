/**
 * Record-derivable elements (ISSUES_v20 R5): elements whose value the record determines although it
 * never writes the value literally. They are record facts — a model must write them whenever the
 * record carries the cue — not workflow defaults and not values the MCP fills:
 *
 *   Condition.verificationStatus  the record's diagnosis field (Dx / Diagnosis / Impression / A: / 診斷 /
 *                                 臨床診斷 / 主診斷 …) states the diagnosis without hedging → confirmed;
 *                                 hedged (疑似 / possible) → provisional; r/o / 待排除 / 鑑別 → differential.
 *   Observation.interpretation    the record marks the value (H / L / HH / LL / ↑ / ↓ / * / (H)) or gives a
 *                                 reference range the value lies outside (H / L) or inside (N) of →
 *                                 v3-ObservationInterpretation H / L / HH / LL / N.
 *   MedicationRequest.category    the record's setting of the order: 出院帶藥 / discharge medication →
 *                                 discharge; 門診 / OPD → outpatient; 住院 / inpatient order → inpatient.
 *
 * One table shared by fhir_get_minimal_skeleton (value_source "derivable"), fhir_get_authoring_fields
 * (source "derived", never auto) and the content-coverage check (recordChecks/coverage.ts: a missing
 * derivable fact is a record-fact-missing finding, with source_text only). Generic: base FHIR R4 paths
 * and code systems; an IG that binds its own ValueSet is served through the codes of that ValueSet whose
 * code or display names the same meaning (`derivableCodes`), and an element whose binding has no such
 * code is not derivable.
 */

export interface DerivableCode {
  system: string | null;
  code: string;
  display: string | null;
}

export interface RecordDerivableRule {
  /** Base FHIR path. */
  path: string;
  /** How to derive the value, LLM-facing (English). */
  rule: string;
  /** Where the record carries the cue. */
  cue: string;
  /** Code system of the base FHIR R4 codes the rule produces. */
  system: string;
  /** Base ValueSets whose codes are exactly the rule's (no expansion needed). */
  valueSets: string[];
  /** Meaning → [base code, display matcher for an IG's own ValueSet]. */
  meanings: Record<string, [string, RegExp]>;
}

const VER_STATUS = "http://terminology.hl7.org/CodeSystem/condition-ver-status";
const INTERP = "http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation";
const MR_CAT = "http://terminology.hl7.org/CodeSystem/medicationrequest-category";

export const RECORD_DERIVABLE: Record<string, RecordDerivableRule> = {
  "Condition.verificationStatus": {
    path: "Condition.verificationStatus",
    rule: "confirmed if the diagnosis field (Dx / Impression / A: / 診斷) states it unhedged; provisional if hedged (疑似); differential for r/o / 待排除",
    cue: "the diagnosis field",
    system: VER_STATUS,
    valueSets: ["http://hl7.org/fhir/ValueSet/condition-ver-status"],
    meanings: {
      confirmed: ["confirmed", /^confirmed$/iu],
      provisional: ["provisional", /^provisional$/iu],
      differential: ["differential", /^differential$/iu],
    },
  },
  "Observation.interpretation": {
    path: "Observation.interpretation",
    rule: "the value's flag (H / ↑ / (H) = H, L / ↓ / (L) = L, HH, LL) or the record's reference range (above = H, below = L, inside = N)",
    cue: "the flag / reference range after the result value",
    system: INTERP,
    valueSets: ["http://hl7.org/fhir/ValueSet/observation-interpretation"],
    meanings: {
      H: ["H", /^high$/iu],
      L: ["L", /^low$/iu],
      HH: ["HH", /^(critical(ly)? high|panic high)$/iu],
      LL: ["LL", /^(critical(ly)? low|panic low)$/iu],
      N: ["N", /^normal$/iu],
      A: ["A", /^abnormal$/iu],
    },
  },
  "MedicationRequest.category": {
    path: "MedicationRequest.category",
    rule: "the order's setting: 出院帶藥 / discharge medication = discharge; 門診 / OPD = outpatient; 住院 / inpatient order = inpatient",
    cue: "the heading the medication is listed under, else the visit setting",
    system: MR_CAT,
    valueSets: ["http://hl7.org/fhir/ValueSet/medicationrequest-category"],
    meanings: {
      discharge: ["discharge", /discharge|出院/iu],
      outpatient: ["outpatient", /outpatient|ambulatory|門診/iu],
      inpatient: ["inpatient", /inpatient|住院/iu],
    },
  },
};

const stripSlices = (p: string): string => p.replace(/:[^.]+/gu, "");

/** The rule of a base path (slices folded), or null. */
export function recordDerivableRule(path: string): RecordDerivableRule | null {
  return RECORD_DERIVABLE[stripSlices(path)] ?? null;
}

/**
 * Meaning → code of the element's binding the rule can produce. `codes` = the binding's expansion
 * (null when unknown); `valueSet` = the bound canonical. A base binding (or no binding / no expansion
 * for elements whose base binding is the rule's) gives the base codes; an IG ValueSet gives its codes
 * matched by base system + code, else by display. Null when the binding holds none of them.
 */
export function derivableCodes(rule: RecordDerivableRule, valueSet: string | null | undefined, codes: readonly DerivableCode[] | null): Map<string, DerivableCode> | null {
  const vs = valueSet ? String(valueSet).split("|")[0] : null;
  const base = (): Map<string, DerivableCode> => new Map(Object.entries(rule.meanings).map(([m, [code]]) => [m, { system: rule.system, code, display: null }]));
  if (!vs || rule.valueSets.includes(vs)) return base();
  if (!codes || !codes.length) return null;
  const out = new Map<string, DerivableCode>();
  for (const [m, [code, re]] of Object.entries(rule.meanings)) {
    const hit =
      codes.find((c) => c.system === rule.system && c.code === code) ??
      codes.find((c) => c.code.toLowerCase() === code.toLowerCase()) ??
      codes.find((c) => !!c.display && re.test(c.display.trim()));
    if (hit) out.set(m, hit);
  }
  return out.size ? out : null;
}

/** "derive …" text of a rule, naming the IG's own codes when they differ from the base ones. */
export function derivableText(rule: RecordDerivableRule, codes: Map<string, DerivableCode> | null, max = 260): string {
  let t = rule.rule;
  if (codes) {
    const own = [...codes.entries()].filter(([m, c]) => c.code !== rule.meanings[m][0] || (c.system && c.system !== rule.system));
    if (own.length) t += ` (this binding's codes: ${own.map(([m, c]) => `${m} = ${c.code}`).join(", ")})`;
  }
  t = `derive from the record: ${t} (record cue: ${rule.cue})`;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
