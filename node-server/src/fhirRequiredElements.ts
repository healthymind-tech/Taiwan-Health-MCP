/**
 * Effective-required element computation for a FHIR profile
 * (`fhir_get_profile_required_elements`).
 *
 * Pure and synchronous: input is the projected snapshot (the same shape that
 * `fhir_get_profile_elements(view=elements)` returns, see
 * `fhirSnapshot.projectElements`), output is the tool's `data` block. No DB.
 *
 * TypeScript port of `mcp_proposal/reference/grounding_ref.py`
 * (`required_elements()` + `classify_element()`), generalised so it works for
 * any IG:
 *   - "code is fixed by the profile" is detected from the snapshot
 *     (fixed/pattern on `<Type>.code` or a required `code.coding` slice whose
 *     code is pinned) instead of a hard-coded list of TW Core profile ids;
 *   - "value[x] OR dataAbsentReason" invariants are detected from the
 *     FHIRPath expression shape (`[guard implies] (a.exists() or b.exists())`)
 *     instead of the keys vs-2 / vs-3 / tw-core-4, and their guard
 *     (`component.empty() and hasMember.empty()`) is evaluated against the
 *     profile and the optional draft instance.
 *
 * Documented deviation from the reference (see the test file):
 *   - When the guard of a value-or-dataAbsentReason invariant can never hold
 *     (e.g. vs-2 on the blood-pressure profile, where `component` is 1..*), the
 *     invariant row is dropped, and the target-implied `Observation.value[x]`
 *     row is not added either — the component values carry the measurement.
 */

export type ProjectedElement = {
  id: string;
  path: string;
  sliceName?: string | null;
  min: number | null;
  max: string | null;
  mustSupport?: boolean;
  types?: Array<{ code: string; targetProfile?: string[]; profile?: string[] }>;
  binding?: { strength?: string; valueSet?: string } | null;
  fixed?: { field: string; value: unknown } | null;
  pattern?: { field: string; value: unknown } | null;
  short?: string | null;
  constraints?: Array<{ key: string; severity?: string; human?: string; expression?: string; source?: string }>;
  /** ElementDefinition.slicing (optional; lets `instance` matching honour slice discriminators). */
  slicing?: { discriminator?: Array<{ type: string; path: string }>; rules?: string } | null;
  /** ElementDefinition.base.max (optional; decides whether the JSON property is an array). */
  baseMax?: string | null;
};

export type GroundingClass =
  | "auto"
  | "coding"
  | "source_fact"
  | "workflow_default"
  | "structural"
  | "site"
  | "derived"
  | "container";

export const GROUNDING_CLASSES: GroundingClass[] = [
  "auto",
  "coding",
  "source_fact",
  "workflow_default",
  "structural",
  "site",
  "derived",
  "container",
];

export interface RequiredElementRow {
  id: string;
  path: string;
  min: number;
  max: string;
  types: string[];
  binding: { strength?: string; valueSet?: string } | null;
  fixed: { field: string; value: unknown } | null;
  pattern: { field: string; value: unknown } | null;
  mustSupport: boolean;
  required_by: string;
  grounding_class: GroundingClass;
  /** Short LLM-facing fill instruction (product addition; may be absent). */
  hint?: string;
  /** Invariant guard that must hold for the row to apply (e.g. "component and hasMember are empty"). */
  condition?: string;
  /** JSON property names for a choice element (`value[x]` -> `valueQuantity`, ...). */
  choices?: string[];
  /** Allowed codes for a small required binding (filled by the service from the local ValueSet). */
  allowedCodes?: string[];
  /** True on rows that are not required (mustSupport-only rows): fill when the record has the value. */
  optional?: boolean;
  /** Citation of the curated derivation rule quoted in `hint` (derived rows, see DERIVATION_RULES). */
  derivation_source?: string;
}

/**
 * include_mustsupport: false = required rows only; true = also every mustSupport element;
 * "defaults" = only the mustSupport elements whose value needs no source fact (fixed / pattern,
 * a conventional workflow default, or a curated derivation rule).
 */
export type MustSupportMode = boolean | "defaults";

export interface RequiredElementsOptions {
  instance?: Record<string, unknown> | null;
  includeTargetImplied?: boolean;
  includeMustSupport?: MustSupportMode;
}

export interface ProfileInvariant {
  key: string;
  /** Element ids that carry it (the root id for resource-level rules). */
  on: string[];
  human: string;
  expression: string;
}

export interface RequiredElementsResult {
  profile: string;
  resourceType: string;
  count: number;
  summary: Record<GroundingClass, number>;
  elements: RequiredElementRow[];
  /** Error-severity invariants added by the profile (or an IG it derives from), excluding base FHIR rules. */
  invariants: ProfileInvariant[];
}

/** Base FHIR rules (ele-1, ext-1, dom-*, per-1, ...) are known to every author; profile rules are not. */
const BASE_SD_RE = /^http:\/\/hl7\.org\/fhir\/StructureDefinition\/[A-Z][A-Za-z]*(\|.*)?$/;
export function isProfileConstraint(c: { key: string; source?: string }): boolean {
  if (c.key === "ele-1" || c.key === "ext-1") return false;
  if (c.source) return !BASE_SD_RE.test(c.source);
  return !/^[a-z]{2,4}-\d+$/.test(c.key);
}

// --------------------------------------------------------------------------- //
// Classification tables (ported from grounding_ref.py `R` + tw_lexicon.py).   //
// They are keyed on base-FHIR resource paths, so they apply to any IG.       //
// --------------------------------------------------------------------------- //

type RClass = "source_fact" | "coding" | "workflow_default" | "derived" | "narrative";

/** Generic path -> grounding class. Insertion order matters (first prefix match wins). */
const R = new Map<string, RClass>();
function r(paths: string, cls: RClass): void {
  for (const p of paths.split(/\s+/).filter(Boolean)) {
    if (!R.has(p)) R.set(p, cls);
  }
}

for (const rt of ["Patient", "Practitioner"]) {
  r(`${rt}.identifier`, "source_fact");
  r(`${rt}.name`, "source_fact");
  r(`${rt}.gender`, "source_fact");
  r(`${rt}.birthDate`, "source_fact");
  r(`${rt}.telecom`, "source_fact");
  r(`${rt}.address`, "narrative");
  r(`${rt}.active`, "workflow_default");
  r(`${rt}.qualification.code`, "coding");
  r(`${rt}.maritalStatus ${rt}.communication.language`, "coding");
}
r("Organization.identifier", "source_fact");
r("Organization.name", "source_fact");
r("Organization.telecom", "source_fact");
r("Organization.type", "derived");
r("Organization.active", "workflow_default");
r("Organization.address", "narrative");
r("Encounter.status", "workflow_default");
r("Encounter.class", "coding");
r("Encounter.serviceType", "coding");
r("Encounter.type Encounter.reasonCode Encounter.priority", "coding");
r("Encounter.period.start Encounter.period.end", "source_fact");
r("Encounter.identifier", "source_fact");
r("Encounter.hospitalization.dischargeDisposition", "coding");
r("Encounter.hospitalization.admitSource", "coding");
r("Encounter.diagnosis.use Encounter.diagnosis.rank Encounter.participant.type", "derived");
r("Encounter.length", "source_fact");
r("Condition.code", "coding");
r("Condition.clinicalStatus Condition.verificationStatus", "workflow_default");
r("Condition.category", "derived");
r("Condition.severity Condition.bodySite Condition.stage.summary", "coding");
r("Condition.onsetDateTime Condition.abatementDateTime Condition.recordedDate", "source_fact");
r("Condition.onsetString Condition.abatementString Condition.note", "narrative");
r("Observation.status", "workflow_default");
r("Observation.category", "derived");
r("Observation.code", "coding");
r("Observation.effectiveDateTime Observation.effectivePeriod.start Observation.effectivePeriod.end Observation.issued", "source_fact");
r("Observation.valueQuantity Observation.component.valueQuantity", "source_fact");
r("Observation.referenceRange.low Observation.referenceRange.high", "source_fact");
r("Observation.valueCodeableConcept Observation.component.valueCodeableConcept", "coding");
r("Observation.valueString Observation.component.valueString", "source_fact");
r("Observation.valueInteger Observation.valueBoolean", "source_fact");
r("Observation.interpretation Observation.component.interpretation", "derived");
r("Observation.component.code", "coding");
r("Observation.bodySite Observation.method", "coding");
r("Observation.note Observation.referenceRange.text", "narrative");
for (const [rt, dz] of [
  ["MedicationRequest", "dosageInstruction"],
  ["MedicationStatement", "dosage"],
]) {
  r(`${rt}.status`, "workflow_default");
  r(`${rt}.category`, "derived");
  r(`${rt}.medicationCodeableConcept`, "coding");
  r(`${rt}.${dz}.text ${rt}.note`, "narrative");
  r(`${rt}.${dz}.timing`, "source_fact");
  r(`${rt}.${dz}.route`, "coding");
  r(`${rt}.${dz}.doseAndRate.doseQuantity`, "source_fact");
  r(`${rt}.${dz}.doseAndRate.type`, "derived");
  r(`${rt}.${dz}.asNeededBoolean`, "source_fact");
  r(`${rt}.${dz}.asNeededCodeableConcept ${rt}.${dz}.method ${rt}.${dz}.site ${rt}.${dz}.additionalInstruction`, "coding");
}
r("MedicationRequest.intent", "workflow_default");
r("MedicationRequest.authoredOn", "source_fact");
r("MedicationRequest.dispenseRequest.expectedSupplyDuration", "source_fact");
r("MedicationRequest.dispenseRequest.quantity", "source_fact");
r("MedicationRequest.dispenseRequest.numberOfRepeatsAllowed", "workflow_default");
r("MedicationRequest.courseOfTherapyType", "derived");
r("MedicationRequest.dispenseRequest.validityPeriod.start MedicationRequest.dispenseRequest.validityPeriod.end", "source_fact");
r(
  "MedicationStatement.dateAsserted MedicationStatement.effectiveDateTime MedicationStatement.effectivePeriod.start MedicationStatement.effectivePeriod.end",
  "source_fact",
);
r("Procedure.status", "workflow_default");
r("Procedure.code", "coding");
r("Procedure.category", "derived");
r("Procedure.performedDateTime Procedure.performedPeriod.start Procedure.performedPeriod.end", "source_fact");
r("Procedure.bodySite Procedure.outcome Procedure.reasonCode", "coding");
r("Procedure.note", "narrative");
r("AllergyIntolerance.clinicalStatus AllergyIntolerance.verificationStatus", "workflow_default");
r("AllergyIntolerance.type AllergyIntolerance.category AllergyIntolerance.criticality AllergyIntolerance.reaction.severity", "derived");
r("AllergyIntolerance.code AllergyIntolerance.reaction.substance", "coding");
r("AllergyIntolerance.reaction.manifestation", "coding");
r("AllergyIntolerance.onsetDateTime AllergyIntolerance.recordedDate AllergyIntolerance.lastOccurrence", "source_fact");
r("AllergyIntolerance.onsetString AllergyIntolerance.reaction.description AllergyIntolerance.note", "narrative");
r("Immunization.status Immunization.primarySource", "workflow_default");
r("Immunization.vaccineCode", "coding");
r("Immunization.occurrenceDateTime", "source_fact");
r("Immunization.lotNumber", "source_fact");
r("Immunization.site Immunization.protocolApplied.targetDisease", "coding");
r("Immunization.route", "coding");
r("Immunization.doseQuantity", "source_fact");
r("Immunization.protocolApplied.doseNumberPositiveInt", "source_fact");
r("Immunization.protocolApplied.doseNumberString Immunization.occurrenceString Immunization.note", "narrative");
r("Medication.code Medication.ingredient.itemCodeableConcept", "coding");
r("Medication.form", "coding");
r("Medication.ingredient.strength.numerator", "source_fact");

/** Status-like fields with a conventional default value (tw_lexicon.WORKFLOW_DEFAULTS). */
export const WORKFLOW_DEFAULTS: Record<string, unknown[]> = {
  "Patient.active": [true],
  "Practitioner.active": [true],
  "Organization.active": [true],
  "Encounter.status": ["finished"],
  "Condition.clinicalStatus": ["active"],
  "Condition.verificationStatus": ["confirmed"],
  "Observation.status": ["final"],
  "MedicationRequest.status": ["active"],
  "MedicationRequest.intent": ["order"],
  "MedicationStatement.status": ["active"],
  "Procedure.status": ["completed"],
  "Immunization.status": ["completed"],
  "Immunization.primarySource": [true],
  "MedicationRequest.dispenseRequest.numberOfRepeatsAllowed": [0],
  "AllergyIntolerance.clinicalStatus": ["active"],
  "AllergyIntolerance.verificationStatus": ["confirmed"],
};

/**
 * Curated derivation rules for well-known `derived` elements (small and closed on purpose: every
 * rule paraphrases the published definitions of the codes it names, cited in `source`). A rule is
 * used only when the element's binding is one of `valueSets` (or the element has no binding), so a
 * profile that binds a different code list never gets a rule about codes it does not allow.
 * Elements without a rule get the binding's code meanings from the local ValueSet expansion
 * (service side, see `derivedCodeMeanings`).
 */
export interface DerivationRule {
  rule: string;
  source: string;
  /** Canonical URLs (no version) of the bindings this rule describes. */
  valueSets: string[];
}

export const DERIVATION_RULES: Record<string, DerivationRule> = {
  "Condition.category": {
    rule:
      "encounter-diagnosis when the condition is diagnosed or assessed in this visit / admission (an outpatient, " +
      "admission or discharge diagnosis of the record's encounter; also set Condition.encounter to that encounter); " +
      "problem-list-item only for an entry of the patient's longitudinal problem list kept across visits (e.g. a " +
      "chronic problem list or past history the record presents as such); a diagnosis written in a visit note is " +
      "encounter-diagnosis even when the disease is chronic",
    source:
      "FHIR R4 condition-category code definitions (http://hl7.org/fhir/R4/codesystem-condition-category.html); " +
      "US Core Condition Encounter Diagnosis vs Problems and Health Concerns profiles " +
      "(http://hl7.org/fhir/us/core/STU6.1/StructureDefinition-us-core-condition-encounter-diagnosis.html)",
    valueSets: [
      "http://hl7.org/fhir/ValueSet/condition-category",
      "http://hl7.org/fhir/us/core/ValueSet/us-core-condition-category",
      "http://hl7.org/fhir/us/core/ValueSet/us-core-problem-or-health-concern",
    ],
  },
  "Observation.category": {
    rule:
      "from what was measured: laboratory = a lab test on a specimen; vital-signs = BP, heart / respiratory rate, " +
      "body temperature, SpO2, height, weight, BMI, head circumference; imaging = an imaging result; exam = a " +
      "physical-exam finding; survey = a questionnaire or assessment score; social-history = smoking, alcohol, " +
      "occupation and other lifestyle facts; procedure / therapy / activity / symptom as their names say",
    source:
      "FHIR R4 observation-category code definitions (http://hl7.org/fhir/R4/codesystem-observation-category.html); " +
      "FHIR R4 Vital Signs profile (http://hl7.org/fhir/R4/observation-vitalsigns.html)",
    valueSets: ["http://hl7.org/fhir/ValueSet/observation-category", "http://hl7.org/fhir/us/core/ValueSet/us-core-observation-category"],
  },
  "Encounter.diagnosis.use": {
    rule:
      "from where the record lists the diagnosis: admission diagnosis = AD, discharge diagnosis = DD, chief complaint = " +
      "CC, comorbidity = CM, pre- / post-operative diagnosis = pre-op / post-op, a claim's billing diagnosis = billing",
    source: "FHIR R4 diagnosis-role code definitions (http://hl7.org/fhir/R4/codesystem-diagnosis-role.html)",
    valueSets: ["http://hl7.org/fhir/ValueSet/diagnosis-role"],
  },
  "Encounter.diagnosis.rank": {
    rule: "1 for the principal (primary) diagnosis, then 2, 3 … in the order the record lists them; ranks count per use",
    source: "FHIR R4 Encounter.diagnosis.rank: 'Ranking of the diagnosis (for each role type)' (http://hl7.org/fhir/R4/encounter-definitions.html#Encounter.diagnosis.rank)",
    valueSets: [],
  },
  "MedicationRequest.category": {
    rule:
      "from the setting of the order: inpatient = to be administered during an inpatient stay; outpatient = ordered " +
      "in a clinic / outpatient visit; community = to be taken by the patient at home (incl. OTC); discharge = a " +
      "discharge prescription",
    source: "FHIR R4 medicationrequest-category code definitions (http://hl7.org/fhir/R4/codesystem-medicationrequest-category.html)",
    valueSets: ["http://hl7.org/fhir/ValueSet/medicationrequest-category"],
  },
  "MedicationStatement.category": {
    rule:
      "from where the medication is used: inpatient = during an inpatient stay; outpatient = in an outpatient " +
      "setting; community = at home by the patient; patientspecified = as reported by the patient or a relative",
    source: "FHIR R4 medication-statement-category code definitions (http://hl7.org/fhir/R4/codesystem-medication-statement-category.html)",
    valueSets: ["http://hl7.org/fhir/ValueSet/medication-statement-category"],
  },
  "MedicationRequest.courseOfTherapyType": {
    rule: "continuous = long-term / chronic medication (incl. refill prescriptions); acute = a short, defined course; seasonal = taken only in a season",
    source: "FHIR R4 medicationrequest-course-of-therapy code definitions (http://hl7.org/fhir/R4/codesystem-medicationrequest-course-of-therapy.html)",
    valueSets: ["http://hl7.org/fhir/ValueSet/medicationrequest-course-of-therapy"],
  },
  "AllergyIntolerance.category": {
    rule: "from the substance: medication = a drug; food = a food or food additive; environment = pollen, dust, animal, latex and other environmental substances; biologic = blood products, vaccines, other biologics",
    source: "FHIR R4 allergy-intolerance-category code definitions (http://hl7.org/fhir/R4/codesystem-allergy-intolerance-category.html)",
    valueSets: ["http://hl7.org/fhir/ValueSet/allergy-intolerance-category"],
  },
  "AllergyIntolerance.type": {
    rule: "allergy = an immune-mediated reaction (what records usually call an allergy); intolerance = a non-immune reaction (e.g. a side effect the record calls intolerance)",
    source: "FHIR R4 allergy-intolerance-type code definitions (http://hl7.org/fhir/R4/codesystem-allergy-intolerance-type.html)",
    valueSets: ["http://hl7.org/fhir/ValueSet/allergy-intolerance-type"],
  },
  "AllergyIntolerance.criticality": {
    rule: "high = the record reports a life-threatening reaction (e.g. anaphylaxis) or calls it severe / critical; low = the record states a low risk; otherwise unable-to-assess",
    source: "FHIR R4 allergy-intolerance-criticality code definitions (http://hl7.org/fhir/R4/codesystem-allergy-intolerance-criticality.html)",
    valueSets: ["http://hl7.org/fhir/ValueSet/allergy-intolerance-criticality"],
  },
  "Observation.interpretation": {
    rule: "the record's flag, or the value compared with its reference range: N normal, H high, L low, HH / LL critically high / low, A abnormal (non-numeric)",
    source: "FHIR R4 observation-interpretation (v3 ObservationInterpretation) code definitions (http://hl7.org/fhir/R4/v3/ObservationInterpretation/cs.html)",
    valueSets: ["http://hl7.org/fhir/ValueSet/observation-interpretation"],
  },
};

/** The curated rule for a derived row, or null when none applies to its binding. */
export function derivationRuleFor(path: string, binding: { valueSet?: string } | null | undefined): DerivationRule | null {
  const rule = DERIVATION_RULES[stripSlices(path)];
  if (!rule) return null;
  const vs = binding?.valueSet ? String(binding.valueSet).split("|")[0] : null;
  if (vs && rule.valueSets.length && !rule.valueSets.includes(vs)) return null;
  return rule;
}

/**
 * "codes: a = meaning; b = meaning" for a derived row without a curated rule, from the local
 * ValueSet expansion (CodeSystem definitions, else displays). Undefined when nothing to say.
 */
export function derivedCodeMeanings(codes: Array<{ code: string; display?: string | null; definition?: string | null }>, max = 10): string | undefined {
  const clip = (t: string, n: number): string => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
  const parts = codes
    .slice(0, max)
    .map((c) => {
      const m = (c.definition || c.display || "").replace(/\s+/g, " ").trim();
      return m && m.toLowerCase() !== c.code.toLowerCase() ? `${c.code} = ${clip(m, 90)}` : null;
    })
    .filter((x): x is string => Boolean(x));
  if (!parts.length) return undefined;
  return `pick the code whose meaning fits the record: ${parts.join("; ")}${codes.length > max ? `; (+${codes.length - max} more)` : ""}`;
}

/** Target-implied primary content: optional in the profile, but the entry is meaningless without it. */
export const PRIMARY_CONTENT: Record<string, Array<[string, string]>> = {
  Condition: [["Condition.code", "the diagnosis itself"]],
  Observation: [["Observation.value[x]", "the measured value (component values for panels such as blood pressure)"]],
  MedicationRequest: [
    ["MedicationRequest.dosageInstruction.doseAndRate.dose[x]", "dose"],
    ["MedicationRequest.dosageInstruction.timing", "frequency"],
  ],
  MedicationStatement: [
    ["MedicationStatement.dosage.doseAndRate.dose[x]", "dose"],
    ["MedicationStatement.dosage.timing", "frequency"],
  ],
  Encounter: [["Encounter.period.start", "encounter date"]],
  Procedure: [["Procedure.performed[x]", "procedure date"]],
  Patient: [["Patient.name", "patient name"]],
};

const BUNDLE_STRUCTURAL = new Set([
  "Bundle.type",
  "Bundle.identifier",
  "Bundle.timestamp",
  "Bundle.entry",
  "Bundle.entry.fullUrl",
  "Bundle.entry.resource",
]);

/** R4 datatypes with min>=1 children (applies when the profile does not expand the type). */
export const DATATYPE_REQUIRED: Record<string, string[]> = {
  Narrative: ["status", "div"],
  Extension: ["url"],
  Annotation: ["text"],
  Signature: ["type", "when", "who"],
  SampledData: ["origin", "period", "dimensions"],
  UsageContext: ["code", "value[x]"],
  RelatedArtifact: ["type"],
  Expression: ["language"],
  DataRequirement: ["type"],
  TriggerDefinition: ["type"],
  ParameterDefinition: ["use", "type"],
  Contributor: ["type", "name"],
};

const CHOICE_STEMS = ["value", "effective", "onset", "performed", "occurrence", "medication", "asNeeded"];

// --------------------------------------------------------------------------- //
// Helpers                                                                     //
// --------------------------------------------------------------------------- //

function typeCodes(el: ProjectedElement | undefined): string[] {
  return (el?.types || []).map((t) => String(t.code ?? ""));
}

function shortType(code: string): string {
  const parts = code.split(".");
  return parts[parts.length - 1];
}

function stripSlices(id: string): string {
  return id.replace(/:[^.]+/g, "");
}

function parentId(id: string): string | null {
  const i = id.lastIndexOf(".");
  return i >= 0 ? id.slice(0, i) : null;
}

/** `value[x]` + `Quantity` -> `valueQuantity`. */
function choiceProperty(path: string, typeCode: string): string {
  const base = path.split(".").pop() || "";
  const stem = base.endsWith("[x]") ? base.slice(0, -3) : base;
  const t = shortType(typeCode);
  return stem + t.slice(0, 1).toUpperCase() + t.slice(1);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True when the profile already decides `<rt>.code`: fixed/pattern on the code
 * element (or its codings), or a required coding slice whose code is pinned.
 * Generic replacement for the reference's FIXED_CODE_PROFILES list.
 */
export function profileFixesCode(rt: string, els: ProjectedElement[]): boolean {
  const E = new Map(els.map((e) => [e.id, e]));
  const codeRe = new RegExp(`^${escapeRe(rt)}\\.code(\\.coding(:[^.]+)?)?$`);
  for (const e of els) {
    if (!codeRe.test(e.id)) continue;
    if ((e.min ?? 0) < 1) continue;
    if (e.fixed || e.pattern) return true;
    if (/:[^.]+$/.test(e.id)) {
      const code = E.get(`${e.id}.code`);
      if (code && (code.fixed || code.pattern)) return true;
    }
  }
  return false;
}

/** Port of grounding_ref.classify_element (with the generic code-fixed test). */
export function classifyElement(rt: string, el: ProjectedElement, codeFixed: boolean): GroundingClass {
  const gp = stripSlices(el.path || el.id);
  if (el.fixed || el.pattern) return "auto";
  const types = typeCodes(el).map(shortType);
  const codeIdRe = new RegExp(`^${escapeRe(rt)}\\.(component(:[^.]+)?\\.)?code(\\.coding(:[^.]+)?)?$`);
  if (codeFixed && codeIdRe.test(el.id)) return "auto";
  if (codeFixed && rt === "Observation" && gp.startsWith("Observation.category")) return "auto";
  if (types.length === 1 && types[0] === "BackboneElement") return "container";
  if (
    (types.length === 1 && types[0] === "Reference") ||
    gp.endsWith(".id") ||
    gp.endsWith(".extension") ||
    gp.endsWith(".modifierExtension") ||
    gp === `${rt}.meta` ||
    gp === `${rt}.text` ||
    gp === `${rt}.contained`
  ) {
    return "structural";
  }
  if (BUNDLE_STRUCTURAL.has(gp)) return "structural";
  if (gp in WORKFLOW_DEFAULTS) return "workflow_default";
  if (gp.endsWith(".system") && gp.includes(".identifier")) return "site";
  const base = gp.replace("[x]", "");
  for (const [k, cls] of R) {
    if (
      k === gp ||
      (k.startsWith(base) && (k.length === base.length || k[base.length] === ".")) ||
      (CHOICE_STEMS.some((s) => base.endsWith(s)) && k.startsWith(base))
    ) {
      return cls === "narrative" ? "source_fact" : cls;
    }
  }
  if (types.some((t) => t === "CodeableConcept" || t === "Coding")) return "coding";
  if (types.includes("code")) {
    const s = el.binding?.strength;
    return s === "required" || s === "extensible" ? "coding" : "source_fact";
  }
  if (types.some((t) => t === "BackboneElement" || t === "Element")) return "container";
  return "source_fact";
}

/**
 * Grounding class of a generic element path (e.g. `Observation.value[x]`,
 * `MedicationRequest.dosageInstruction.timing`) when no snapshot is at hand:
 * the same tables `classifyElement` uses, for an element with no fixed/pattern
 * value and no declared types. Shared with fhir_check_completeness so both
 * tools classify a fact identically.
 */
export function groundingClassOfPath(path: string): GroundingClass {
  const rt = path.split(".")[0];
  return classifyElement(rt, { id: path, path, min: null, max: null }, false);
}

/** pattern[x] semantics: every property of the pattern is present (arrays: each pattern item matches some item). */
function patternMatches(actual: unknown, pattern: unknown): boolean {
  if (pattern && typeof pattern === "object" && !Array.isArray(pattern)) {
    if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
    return Object.entries(pattern as Record<string, unknown>).every(([k, v]) => patternMatches((actual as Record<string, unknown>)[k], v));
  }
  if (Array.isArray(pattern)) {
    const arr = Array.isArray(actual) ? actual : actual === undefined ? [] : [actual];
    return pattern.every((p) => arr.some((a) => patternMatches(a, p)));
  }
  return JSON.stringify(actual) === JSON.stringify(pattern);
}

/** Values reached from `node` by a simple dotted FHIRPath (choice stems and `resolve()` are not followed). */
function valuesAt(node: unknown, rel: string): unknown[] {
  let cur: unknown[] = [node];
  for (const seg of rel.split(".").filter(Boolean)) {
    const next: unknown[] = [];
    for (const n of cur) {
      if (!n || typeof n !== "object" || Array.isArray(n)) continue;
      const v = (n as Record<string, unknown>)[seg];
      if (Array.isArray(v)) next.push(...v);
      else if (v !== undefined && v !== null) next.push(v);
    }
    cur = next;
  }
  return cur;
}

function expectedValue(el: ProjectedElement | undefined): unknown {
  if (!el) return undefined;
  if (el.fixed) return el.fixed.value;
  if (el.pattern) return el.pattern.value;
  return undefined;
}

/**
 * Whether an instance item belongs to the slice `sliceId`, judged from the slicing
 * discriminators carried on the projected elements (`slicing`, see ProjectedElement).
 * Returns true when membership cannot be decided locally (no slicing info, `exists`,
 * `resolve()`, an expected value the profile does not pin) — the conservative choice
 * that keeps the pre-slicing behaviour for callers that pass bare projections.
 */
export function sliceMatches(item: unknown, jsonKey: string, sliceId: string, E: Map<string, ProjectedElement> | null | undefined): boolean {
  if (!E) return true;
  const colon = sliceId.lastIndexOf(":");
  if (colon < 0) return true;
  const baseId = sliceId.slice(0, colon);
  const sliceName = sliceId.slice(colon + 1);
  const slice = E.get(sliceId);
  if (baseId.endsWith("[x]")) {
    // type slice on a choice: value[x]:valueQuantity
    if (jsonKey === sliceName) return true;
    const t = slice?.types?.length === 1 ? shortType(slice.types[0].code) : null;
    return t ? jsonKey === choiceProperty(baseId, t) : true;
  }
  const base = E.get(baseId);
  let discs = base?.slicing?.discriminator ?? null;
  if (!discs && /\.(extension|modifierExtension)$/.test(baseId)) discs = [{ type: "value", path: "url" }];
  if (!discs || !discs.length) return true;
  const obj = item && typeof item === "object" && !Array.isArray(item) ? (item as Record<string, unknown>) : null;
  let decided = false;
  for (const d of discs) {
    const p = String(d.path || "$this");
    if (p.includes("resolve()") || p.includes("(")) continue;
    if (d.type === "value" || d.type === "pattern") {
      let exp = expectedValue(p === "$this" ? slice : E.get(`${sliceId}.${p}`));
      if (exp === undefined && p === "url" && /\.(extension|modifierExtension)$/.test(baseId)) {
        const prof = slice?.types?.[0]?.profile?.[0];
        if (prof) exp = prof.split("|")[0];
      }
      if (exp === undefined) continue;
      decided = true;
      const vals = p === "$this" ? [item] : valuesAt(item, p);
      if (!vals.some((v) => patternMatches(v, exp))) return false;
    } else if (d.type === "type") {
      const el = p === "$this" ? slice : E.get(`${sliceId}.${p}`);
      const types = (el?.types || []).map((t) => shortType(t.code));
      const vals = p === "$this" ? [item] : valuesAt(item, p);
      const rts = vals.map((v) => (v && typeof v === "object" ? (v as Record<string, unknown>).resourceType : undefined)).filter(Boolean);
      if (types.length && rts.length) decided = true;
      if (types.length && rts.length && !rts.some((r) => types.includes(String(r)))) return false;
    } else if (d.type === "profile") {
      const el = p === "$this" ? slice : E.get(`${sliceId}.${p}`);
      const profs = new Set((el?.types || []).flatMap((t) => (t.profile || []).map((u) => u.split("|")[0])));
      const types = (el?.types || []).map((t) => shortType(t.code));
      const vals = (p === "$this" ? [item] : valuesAt(item, p)).filter((v) => v && typeof v === "object") as Array<Record<string, any>>;
      if (!vals.length) return false;
      decided = true;
      // An instance that declares meta.profile is matched on it; otherwise on resource type.
      const ok = vals.some((v) => {
        const declared: string[] = (v.meta?.profile || []).map((u: string) => String(u).split("|")[0]);
        if (declared.length && profs.size) return declared.some((u) => profs.has(u));
        return !types.length || !v.resourceType || types.includes(String(v.resourceType));
      });
      if (!ok) return false;
    }
  }
  if (!decided && obj) {
    // Undecidable discriminator (e.g. `$this` pattern resolved through a ValueSet binding): an item
    // that contradicts a fixed/pattern value the slice puts on one of its direct children
    // (typically coding.system) cannot be a member.
    const prefix = `${sliceId}.`;
    for (const [cid, ce] of E) {
      if (!cid.startsWith(prefix) || cid.slice(prefix.length).includes(".") || cid.slice(prefix.length).includes(":")) continue;
      const exp = expectedValue(ce);
      if (exp === undefined) continue;
      const v = obj[cid.slice(prefix.length)];
      if (v !== undefined && !patternMatches(v, exp)) return false;
    }
  }
  return obj !== null || item !== undefined;
}

/**
 * Instance nodes at a snapshot element id. Sliced segments keep only the items that
 * match the slice (when `E` carries slicing info, see sliceMatches).
 */
export function nodesAt(instance: unknown, eid: string, E?: Map<string, ProjectedElement> | null): unknown[] {
  if (!instance || typeof instance !== "object") return [];
  const segs = eid.split(".");
  let nodes: unknown[] = [instance];
  let idSoFar = segs[0];
  for (const seg of segs.slice(1)) {
    idSoFar = `${idSoFar}.${seg}`;
    const colon = seg.indexOf(":");
    const p = colon >= 0 ? seg.slice(0, colon) : seg;
    const sliced = colon >= 0;
    const next: unknown[] = [];
    for (const n of nodes) {
      if (!n || typeof n !== "object" || Array.isArray(n)) continue;
      const obj = n as Record<string, unknown>;
      const keys: string[] = [];
      if (p.endsWith("[x]")) {
        const stem = p.slice(0, -3);
        for (const k of Object.keys(obj)) if (k.startsWith(stem) && k.length > stem.length && /[A-Z]/.test(k[stem.length])) keys.push(k);
      } else if (p in obj) keys.push(p);
      for (const k of keys) {
        const v = obj[k];
        const items = Array.isArray(v) ? v : v === null || v === undefined ? [] : [v];
        for (const it of items) {
          if (sliced && !sliceMatches(it, k, idSoFar, E)) continue;
          next.push(it);
        }
      }
    }
    nodes = next;
  }
  return nodes;
}

export interface ExtensionSite {
  /** Element path of the extension array (e.g. `Practitioner.address.extension`). */
  path: string;
  url: string | null;
  item: Record<string, unknown>;
}

/**
 * Extensions present in a draft that no declared extension slice accounts for (unknown
 * extensions, or extensions inside datatypes the profile does not expand). Element paths
 * use `[x]` for choice properties the snapshot knows.
 */
export function instanceExtensionSites(instance: Record<string, unknown> | null | undefined, els: ProjectedElement[]): ExtensionSite[] {
  if (!instance || typeof instance !== "object") return [];
  const rt = String((instance as Record<string, unknown>).resourceType ?? (els[0]?.path || "").split(".")[0]);
  const paths = new Set(els.map((e) => e.path));
  const declared = new Map<string, Set<string>>(); // extension element path -> slice urls
  const E = new Map(els.map((e) => [e.id, e]));
  for (const e of els) {
    if (!e.sliceName || !/\.(extension|modifierExtension)$/.test(e.path)) continue;
    const url = (expectedValue(E.get(`${e.id}.url`)) as string | undefined) ?? e.types?.[0]?.profile?.[0];
    if (!url) continue;
    if (!declared.has(e.path)) declared.set(e.path, new Set());
    declared.get(e.path)!.add(String(url).split("|")[0]);
  }
  const out: ExtensionSite[] = [];
  const walk = (node: Record<string, unknown>, path: string, depth: number): void => {
    if (depth > 12) return;
    for (const [k, v] of Object.entries(node)) {
      if (k === "resourceType" || k.startsWith("_") || k === "contained") continue;
      let seg = k;
      if (!paths.has(`${path}.${k}`)) {
        for (const p of paths) {
          if (!p.startsWith(`${path}.`) || !p.endsWith("[x]")) continue;
          const stem = p.slice(path.length + 1, -3);
          if (!stem.includes(".") && k.startsWith(stem) && k.length > stem.length && /[A-Z]/.test(k[stem.length])) seg = `${stem}[x]`;
        }
      }
      const childPath = `${path}.${seg}`;
      const items = Array.isArray(v) ? v : [v];
      for (const it of items) {
        if (!it || typeof it !== "object" || Array.isArray(it)) continue;
        const obj = it as Record<string, unknown>;
        if (obj.resourceType) continue; // nested resource (Bundle.entry.resource): its own profile
        if (k === "extension" || k === "modifierExtension") {
          const url = typeof obj.url === "string" ? obj.url : null;
          if (url && declared.get(childPath)?.has(url)) continue; // governed by the declared slice's definition
          out.push({ path: childPath, url, item: obj });
          continue; // its content is governed by its own definition (expanded by the service)
        }
        walk(obj, childPath, depth + 1);
      }
    }
  };
  walk(instance as Record<string, unknown>, rt, 0);
  return out;
}

/**
 * Whether the draft instance has a value at the element id. Slice segments are
 * honoured when `E` (projected elements by id, with `slicing`) is given; without it
 * they are ignored (any item of the sliced element counts).
 */
export function populatedIn(instance: Record<string, unknown> | null | undefined, eid: string, E?: Map<string, ProjectedElement> | null): boolean {
  return nodesAt(instance, eid, E).length > 0;
}

// --------------------------------------------------------------------------- //
// Invariant parsing: "[guard implies] (a.exists() or b.exists() ...)"         //
// --------------------------------------------------------------------------- //

export interface OneOfInvariant {
  /** Element names, at least one of which must exist. */
  terms: string[];
  /** Element names that must all be empty for the invariant to apply (null = unconditional). */
  guardEmpty: string[] | null;
  /** True when the guard exists but could not be parsed into `x.empty() and ...`. */
  guardOpaque: boolean;
}

function stripParens(s: string): string {
  let t = s.trim();
  while (t.startsWith("(") && t.endsWith(")")) {
    // only strip when the outer pair matches
    let depth = 0;
    let wraps = true;
    for (let i = 0; i < t.length; i++) {
      if (t[i] === "(") depth++;
      else if (t[i] === ")") depth--;
      if (depth === 0 && i < t.length - 1) {
        wraps = false;
        break;
      }
    }
    if (!wraps) break;
    t = t.slice(1, -1).trim();
  }
  return t;
}

/** Parse a FHIRPath "at least one of these child elements exists" invariant. */
export function parseOneOfInvariant(expression: string | null | undefined): OneOfInvariant | null {
  if (!expression) return null;
  const expr = expression.replace(/\s+/g, " ").trim();
  let guard: string | null = null;
  let body = expr;
  const idx = expr.indexOf(" implies ");
  if (idx >= 0) {
    guard = expr.slice(0, idx);
    body = expr.slice(idx + " implies ".length);
  }
  const terms: string[] = [];
  for (const part of stripParens(body).split(" or ")) {
    const m = /^([A-Za-z][A-Za-z0-9]*)\.exists\(\)$/.exec(stripParens(part));
    if (!m) return null;
    terms.push(m[1]);
  }
  if (terms.length < 2) return null;
  let guardEmpty: string[] | null = null;
  let guardOpaque = false;
  if (guard !== null) {
    guardEmpty = [];
    for (const part of stripParens(guard).split(" and ")) {
      const m = /^([A-Za-z][A-Za-z0-9]*)\.empty\(\)$/.exec(stripParens(part));
      if (!m) {
        guardOpaque = true;
        guardEmpty = null;
        break;
      }
      guardEmpty.push(m[1]);
    }
  }
  return { terms, guardEmpty, guardOpaque };
}

// --------------------------------------------------------------------------- //
// Main                                                                        //
// --------------------------------------------------------------------------- //

function compactJson(v: unknown, max = 160): string {
  const s = typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function rowFrom(
  e: ProjectedElement | undefined,
  id: string,
  path: string,
  requiredBy: string,
  cls: GroundingClass,
  overrides: Partial<RequiredElementRow> = {},
): RequiredElementRow {
  return {
    id,
    path,
    min: e?.min ?? 0,
    max: e?.max ?? "1",
    types: typeCodes(e),
    binding: e?.binding ?? null,
    fixed: e?.fixed ?? null,
    pattern: e?.pattern ?? null,
    mustSupport: Boolean(e?.mustSupport),
    required_by: requiredBy,
    grounding_class: cls,
    ...overrides,
  };
}

/** Attach the per-row fill hint (synchronous part; allowed codes are added by the service). */
export function hintFor(
  row: RequiredElementRow,
  E: Map<string, ProjectedElement>,
  rowsById: Map<string, RequiredElementRow> = new Map(),
): string | undefined {
  const parts: string[] = [];
  const types = row.types.map(shortType);
  const lastSeg = row.id.split(".").pop() || "";
  const sliceOnLast = /:([^.]+)$/.exec(row.id);
  // fixed/pattern rows: the `fixed` / `pattern` field is the instruction (copy it); a pattern on a
  // complex type only needs to be *contained*, which is worth saying.
  if (!row.fixed && row.pattern && row.pattern.value && typeof row.pattern.value === "object") {
    parts.push("must contain the pattern (extra codings allowed)");
  }
  if (sliceOnLast && !row.fixed && !row.pattern) {
    const baseId = row.id.slice(0, row.id.length - sliceOnLast[0].length);
    if (baseId.endsWith("[x]") && E.has(baseId)) {
      parts.push(`type slice: write it as JSON property "${sliceOnLast[1]}"`);
    } else {
      parts.push(`slice "${sliceOnLast[1]}": include an entry matching this slice`);
    }
  } else if (row.grounding_class === "auto" && !row.fixed && !row.pattern && rowsById.get(parentId(row.id) || "")?.grounding_class !== "auto") {
    parts.push("decided by the profile: copy the fixed/pattern values listed for its children");
  }
  if (types.length === 1 && /^[A-Z]/.test(types[0]) && types[0] !== "Extension" && E.get(row.id)?.types?.[0]?.profile?.length && row.id.endsWith(".resource")) {
    const prof = E.get(row.id)!.types![0].profile![0];
    parts.push(`a ${types[0]} conforming to ${prof.split("|")[0].split("/").pop()} (query this tool for that profile)`);
  }
  if (types.length === 1 && types[0] === "Extension") {
    const prof = E.get(row.id)?.types?.[0]?.profile?.[0];
    if (prof) parts.push(`extension url "${prof.split("|")[0]}"`);
  }
  if (row.choices && row.choices.length) {
    const shown = row.choices.slice(0, 6).join(" | ");
    parts.push(`choice: use exactly one of ${shown}${row.choices.length > 6 ? ` (+${row.choices.length - 6} more)` : ""}`);
  }
  if (row.required_by.startsWith("invariant:") && row.required_by.includes("dataAbsentReason")) {
    parts.push(`give ${lastSeg}; only if the value is genuinely unknown use dataAbsentReason instead (conformance-only, not a value)`);
  }
  if (row.grounding_class === "workflow_default") {
    const gp = stripSlices(row.path);
    const dflt = WORKFLOW_DEFAULTS[gp];
    if (dflt) parts.push(`usual default ${compactJson(dflt[0])}; use another value only if the record says so`);
  }
  if (row.grounding_class === "derived") {
    const rule = derivationRuleFor(row.path, row.binding);
    if (rule) parts.push(`derive: ${rule.rule}`);
    else parts.push("derivable from other filled values (e.g. the code's kind); pick from the binding");
  }
  if (row.grounding_class === "site") {
    parts.push("namespace URI of the issuing organisation (site config or the profile's identifier slice pattern)");
  }
  if (types.length === 1 && types[0] === "Reference") {
    const el = E.get(row.id);
    const targets = (el?.types?.[0]?.targetProfile || []).map((u) => u.split("/").pop() || u);
    if (targets.length) parts.push(`Reference to ${targets.slice(0, 4).join(" | ")}${targets.length > 4 ? " | …" : ""}`);
  }
  if (row.grounding_class === "container" && !sliceOnLast) {
    parts.push(row.max === "1" ? "object; fill its required children listed here" : "array of objects; fill each item's required children listed here");
  }
  if (row.required_by.startsWith("target-implied")) {
    parts.push("optional in the profile, but the entry is meaningless without it: fill from the record");
  }
  // Closed slicing: every item must match one of the allowed (max != 0) slices.
  const sel = E.get(row.id);
  if (sel?.slicing?.rules === "closed") {
    const allowed: string[] = [];
    for (const [k, v] of E) {
      if (!k.startsWith(`${row.id}:`) || k.slice(row.id.length + 1).includes(".") || v.max === "0") continue;
      const name = k.slice(row.id.length + 1);
      const sys = E.get(`${k}.system`);
      const sv = sys?.fixed?.value ?? sys?.pattern?.value;
      const vs = v.binding?.valueSet ? String(v.binding.valueSet).split("|")[0] : null;
      allowed.push(typeof sv === "string" ? `${name} (system ${sv})` : vs ? `${name} (ValueSet ${vs})` : name);
    }
    if (allowed.length) {
      parts.push(`closed slicing: each item must match one of ${allowed.slice(0, 8).join(" | ")}${allowed.length > 8 ? ` (+${allowed.length - 8} more)` : ""}`);
    }
  }
  if (row.min > 1) parts.push(`at least ${row.min} items`);
  if (row.optional) {
    const gp = stripSlices(row.path);
    const defaultable =
      Boolean(row.fixed || row.pattern) || row.grounding_class === "auto" || gp in WORKFLOW_DEFAULTS || (row.grounding_class === "derived" && derivationRuleFor(row.path, row.binding) !== null);
    parts.push(
      defaultable
        ? "optional (mustSupport, not required): fill it with the value or rule above when it applies, or leave it out (never refuse because it is missing)"
        : "optional (mustSupport, not required): include it when the record gives the value, otherwise leave it out (never refuse because it is missing)",
    );
  }
  return parts.length ? parts.join("; ") : undefined;
}

/**
 * Compute the effectively-required elements of a profile.
 *
 * @param profile   profile id (artifact id) for the output
 * @param elements  projected snapshot elements (fhirSnapshot.projectElements)
 */
export function requiredElements(
  profile: string,
  elements: ProjectedElement[],
  opts: RequiredElementsOptions = {},
): RequiredElementsResult {
  const instance = opts.instance ?? null;
  const includeTargetImplied = opts.includeTargetImplied ?? true;
  const includeMustSupport = opts.includeMustSupport ?? false;
  const els = elements.filter((e) => e && typeof e.id === "string");
  const E = new Map(els.map((e) => [e.id, e]));
  const rt = (els[0]?.path || els[0]?.id || "").split(".")[0];
  const codeFixed = profileFixesCode(rt, els);

  const rows: RequiredElementRow[] = [];
  const included = new Set<string>([rt]);

  // 1) min>=1 with a required (or populated) ancestor chain.
  for (const e of els) {
    const id = e.id;
    if (!id.includes(".") || (e.min ?? 0) < 1) continue;
    let ok = true;
    const via: string[] = [];
    let p = parentId(id);
    while (p && p.includes(".")) {
      const pe = E.get(p);
      if (pe && (pe.min ?? 0) < 1) {
        if (populatedIn(instance, p, E)) via.push(`parent ${p} populated`);
        else {
          ok = false;
          break;
        }
      }
      p = parentId(p);
    }
    if (!ok) continue;
    const slices = [...id.matchAll(/:([^.]+)/g)].map((m) => m[1]);
    const reqBy = slices.length ? `slice:${slices[slices.length - 1]}` : "profile";
    rows.push(
      rowFrom(e, id, e.path, reqBy + (via.length ? ` (${via.join("; ")})` : ""), classifyElement(rt, e, codeFixed)),
    );
    included.add(id);
  }

  // 2) Invariant-implied "X OR dataAbsentReason" (vs-2 / vs-3 / tw-core-4 style).
  const isSet = (owner: ProjectedElement, name: string): boolean => {
    const childIdBase = `${owner.id}.${name}`;
    const child = E.get(childIdBase) || E.get(`${childIdBase}[x]`);
    if (child && (child.min ?? 0) >= 1) return true;
    return populatedIn(instance, child ? child.id : childIdBase, E);
  };
  // An element counts when it is required or (given a draft) populated; invariants declared on a
  // slicing base also bind every slice member (snapshots do not always copy them onto the slices).
  const active = (id: string): boolean => included.has(id) || (instance !== null && id !== rt && populatedIn(instance, id, E));
  const darTargets: Array<[ProjectedElement, NonNullable<ProjectedElement["constraints"]>[number]]> = [];
  for (const e of els) {
    if (!active(e.id)) continue;
    const activeSlices = els.filter((s) => s.id.startsWith(`${e.id}:`) && !s.id.slice(e.id.length + 1).includes(".") && active(s.id));
    for (const c of e.constraints || []) {
      if (c.severity && c.severity !== "error") continue;
      const inv = parseOneOfInvariant(c.expression);
      if (!inv || !inv.terms.includes("dataAbsentReason")) continue;
      if (activeSlices.length && e.id !== rt) {
        for (const sl of activeSlices) {
          if (!(sl.constraints || []).some((x) => x.key === c.key)) darTargets.push([sl, c]);
        }
        continue;
      }
      darTargets.push([e, c]);
    }
  }
  for (const [e, c] of darTargets) {
    {
      const inv = parseOneOfInvariant(c.expression)!;
      let condition: string | undefined;
      if (inv.guardEmpty && inv.guardEmpty.length) {
        if (inv.guardEmpty.some((g) => isSet(e, g))) continue; // guard can never hold -> not required
        condition = `only while ${inv.guardEmpty.join(" and ")} ${inv.guardEmpty.length > 1 ? "are" : "is"} empty`;
      } else if (inv.guardOpaque) {
        condition = "conditional (see invariant expression)";
      }
      for (const term of inv.terms) {
        if (term === "dataAbsentReason") continue;
        const choiceId = `${e.id}.${term}[x]`;
        const plainId = `${e.id}.${term}`;
        const genericChoice = `${stripSlices(e.id)}.${term}[x]`;
        const target = E.get(choiceId) || E.get(plainId) || E.get(genericChoice) || E.get(`${stripSlices(e.id)}.${term}`);
        const isChoice = Boolean(E.get(choiceId) || E.get(genericChoice)) || !E.get(plainId);
        const id = isChoice ? choiceId : plainId;
        const path = `${e.path}.${term}${isChoice ? "[x]" : ""}`;
        const what = `${term}${isChoice ? "[x]" : ""}`;
        const isRoot = e.id === rt;
        const reqBy = isRoot
          ? `invariant:${c.key} (${what} OR dataAbsentReason; dataAbsentReason satisfies conformance but is not a value)`
          : `invariant:${c.key} (${stripSlices(e.id).split(".").pop()} ${what} OR dataAbsentReason)`;
        if (included.has(id)) continue;
        const row = rowFrom(target, id, path, reqBy, "source_fact", { min: 0, max: target?.max ?? "1", binding: null, fixed: null, pattern: null });
        if (condition) row.condition = condition;
        rows.push(row);
        included.add(id);
      }
    }
  }

  // 2b) ext-1 ("extension or value[x], not both"): a simple extension (nested `extension`
  //     prohibited) must carry value[x] even when the definition leaves it 0..1.
  for (const e of [...els]) {
    const isExtRoot = e.id === rt && rt === "Extension";
    const isExtRow = included.has(e.id) && e.types?.length === 1 && shortType(e.types[0].code) === "Extension";
    if (!isExtRoot && !isExtRow) continue;
    const v = E.get(`${e.id}.value[x]`);
    const sub = E.get(`${e.id}.extension`);
    if (!v || v.max === "0" || (v.min ?? 0) >= 1 || included.has(v.id)) continue;
    if (!sub || sub.max !== "0") continue;
    rows.push(rowFrom(v, v.id, v.path, "invariant:ext-1 (a simple extension must carry value[x])", "source_fact", { min: 1 }));
    included.add(v.id);
    // its own required children (e.g. Identifier.system/value) now apply too
    for (const c of els) {
      if (!c.id.startsWith(`${v.id}.`) || (c.min ?? 0) < 1 || included.has(c.id)) continue;
      let ok = true;
      for (let p = parentId(c.id); p && p !== v.id; p = parentId(p)) if ((E.get(p)?.min ?? 0) < 1 && !populatedIn(instance, p, E)) ok = false;
      if (!ok) continue;
      rows.push(rowFrom(c, c.id, c.path, "invariant:ext-1 (child of the required value[x])", classifyElement(rt, c, codeFixed)));
      included.add(c.id);
    }
  }

  // 2c) Base-datatype required children of a populated / required element whose type the
  //     profile does not expand (Narrative.div, Extension.url, Annotation.text, ...).
  {
    for (const e of els) {
      if (!e.id.includes(".") || e.types?.length !== 1) continue;
      const t = shortType(e.types[0].code);
      const kids = DATATYPE_REQUIRED[t];
      if (!kids) continue;
      if (t === "Extension" && e.types[0].profile?.length) continue; // expanded from its definition by the service
      if (!included.has(e.id) && !populatedIn(instance, e.id, E)) continue;
      // sliced base: its slices (or the ext-1 rows) cover it
      if (e.slicing || els.some((s) => s.id.startsWith(`${e.id}:`))) continue;
      let anc = true;
      for (let p = parentId(e.id); p && p.includes("."); p = parentId(p)) {
        if ((E.get(p)?.min ?? 0) < 1 && !populatedIn(instance, p, E)) anc = false;
      }
      if (!anc) continue;
      for (const k of kids) {
        const cid = `${e.id}.${k}`;
        if (E.has(cid) || E.has(`${cid}[x]`) || included.has(cid)) continue;
        rows.push(
          rowFrom(undefined, cid, `${e.path}.${k}`, `datatype:${t} (${included.has(e.id) ? "parent required" : `parent ${e.id} populated`})`, "source_fact", { min: 1, max: "1" }),
        );
        included.add(cid);
      }
    }
  }

  // 2d) Extensions in the draft that no declared slice accounts for still need their url.
  for (const site of instanceExtensionSites(instance, els)) {
    const id = `${site.path}.url`;
    if (included.has(id) || E.has(id)) continue;
    rows.push(rowFrom(undefined, id, id, `datatype:Extension (parent ${site.path} populated)`, "structural", { min: 1, max: "1", types: ["uri"] }));
    included.add(id);
  }

  // 3) Target-implied primary content.
  if (includeTargetImplied) {
    const componentValuesCover = rows.some((r) => /^Observation\.component(:[^.]+)?\.value\[x\]$/.test(r.id));
    for (const [pth, why] of PRIMARY_CONTENT[rt] || []) {
      if (rows.some((r) => r.path === pth)) continue;
      if (pth === "Observation.value[x]" && componentValuesCover) continue;
      const el = E.get(pth);
      rows.push(
        rowFrom(el, pth, pth, `target-implied (${why})`, pth.endsWith("code") ? "coding" : "source_fact", {
          min: el?.min ?? 0,
          max: el?.max ?? "1",
          fixed: null,
          pattern: null,
        }),
      );
      included.add(pth);
    }
  }

  // 4) mustSupport-only (opt-in): MS elements whose ancestors are required or MS themselves.
  //    "defaults": only MS elements whose value needs no source fact (fixed / pattern, a workflow
  //    default, a curated derivation rule) and whose ancestors are all listed.
  if (includeMustSupport) {
    const defaultsOnly = includeMustSupport === "defaults";
    const listed = new Set(rows.map((r) => r.id));
    for (const e of els) {
      if (!e.mustSupport || !e.id.includes(".") || listed.has(e.id) || e.max === "0") continue;
      let ok = true;
      let p = parentId(e.id);
      while (p && p.includes(".")) {
        const pe = E.get(p);
        if (pe && !included.has(p) && (defaultsOnly ? !listed.has(p) : !pe.mustSupport)) {
          ok = false;
          break;
        }
        p = parentId(p);
      }
      if (!ok) continue;
      const cls = classifyElement(rt, e, codeFixed);
      if (defaultsOnly) {
        const gp = stripSlices(e.path || e.id);
        const defaultable =
          Boolean(e.fixed || e.pattern) || cls === "auto" || gp in WORKFLOW_DEFAULTS || (cls === "derived" && derivationRuleFor(e.path, e.binding) !== null);
        if (!defaultable) continue;
      }
      rows.push(rowFrom(e, e.id, e.path, "mustSupport-only", cls, { optional: true }));
      listed.add(e.id);
    }
  }

  // Choice property names + hints (product additions; do not affect id/required_by/class).
  const rowsById = new Map(rows.map((r) => [r.id, r]));
  for (const row of rows) {
    if (row.id.endsWith("[x]") && row.types.length) {
      row.choices = row.types.map((t) => choiceProperty(row.id, t));
    }
    const h = hintFor(row, E, rowsById);
    if (h) row.hint = h;
    if (row.grounding_class === "derived") {
      const rule = derivationRuleFor(row.path, row.binding);
      if (rule) row.derivation_source = rule.source;
    }
  }

  // Profile-defined error invariants on the root, on listed elements and on populated ones.
  // They are not rows (most are conditional business rules), but an author must satisfy them.
  const invariants: ProfileInvariant[] = [];
  const invByKey = new Map<string, ProfileInvariant>();
  for (const e of els) {
    if (!(e.id === rt || included.has(e.id) || (instance && populatedIn(instance, e.id, E)))) continue;
    for (const c of e.constraints || []) {
      if (!c.key || (c.severity && c.severity !== "error") || !isProfileConstraint(c)) continue;
      const inv = parseOneOfInvariant(c.expression);
      if (inv && inv.terms.includes("dataAbsentReason")) continue; // already rows
      const k = `${c.key}\u0000${c.expression ?? ""}`;
      const prev = invByKey.get(k);
      if (prev) {
        if (!prev.on.includes(e.id)) prev.on.push(e.id);
        continue;
      }
      const item: ProfileInvariant = { key: c.key, on: [e.id], human: c.human ?? "", expression: c.expression ?? "" };
      invByKey.set(k, item);
      invariants.push(item);
    }
  }

  const summary = Object.fromEntries(GROUNDING_CLASSES.map((k) => [k, rows.filter((r) => r.grounding_class === k).length])) as Record<
    GroundingClass,
    number
  >;
  return { profile, resourceType: rt, count: rows.length, summary, elements: rows, invariants };
}

/**
 * Effective-required flag for an unsliced element path within a snapshot:
 * own min>=1 and every ancestor path (unsliced) also min>=1. Used to add
 * `effectiveRequired` to fhir_get_resource_skeleton fields.
 */
export function effectiveRequiredPaths(snapshotElements: Array<Record<string, any>>): Set<string> {
  const byPath = new Map<string, Record<string, any>>();
  for (const el of snapshotElements) {
    const id = String(el.id || "");
    if (id.includes(":")) continue;
    if (el.path && !byPath.has(el.path)) byPath.set(el.path, el);
  }
  const out = new Set<string>();
  for (const [path, el] of byPath) {
    if (!path.includes(".") || !(typeof el.min === "number" && el.min >= 1)) continue;
    let ok = true;
    let p = parentId(path);
    while (p && p.includes(".")) {
      const pe = byPath.get(p);
      if (pe && !(typeof pe.min === "number" && pe.min >= 1)) {
        ok = false;
        break;
      }
      p = parentId(p);
    }
    if (ok) out.add(path);
  }
  return out;
}

/** One-paragraph reading guide returned with every result (LLM-facing). */
export const READING_GUIDE =
  "Every listed element must be present for the resource to be conformant and meaningful; elements not listed are optional. " +
  "grounding_class says where the value comes from: auto = copy the fixed/pattern value; coding = map record text to a code " +
  "(see binding / allowedCodes); source_fact = take it verbatim from the source record, never invent it; workflow_default = " +
  "conventional default unless the record says otherwise; structural = reference/ids/bundle plumbing; site = organisation " +
  "namespace; derived = computable from other filled values; container = object/array that holds the listed children. " +
  "required_by: profile = min>=1 with every ancestor required; slice:<name> = inside a required slice; invariant:<key> = an " +
  "invariant demands the value (or dataAbsentReason); target-implied = optional in the profile but the entry is pointless " +
  "without it. 'condition' limits when a row applies. Pass your draft as `instance` to also get the required children of " +
  "optional parents you have populated.";

/**
 * Compact a row for the wire: drop null/empty/default-valued keys and `path`
 * when it equals `id`. Keeps every key the spec defines whenever it carries
 * information, which keeps big profiles (e.g. blood pressure) small enough
 * for clients that truncate tool output.
 */
export function compactRow(row: RequiredElementRow): Record<string, unknown> {
  const out: Record<string, unknown> = { id: row.id };
  if (row.path !== row.id) out.path = row.path;
  out.min = row.min;
  out.max = row.max;
  if (row.types.length) out.types = row.types;
  if (row.binding) out.binding = row.binding;
  if (row.fixed) out.fixed = row.fixed;
  if (row.pattern) out.pattern = row.pattern;
  if (row.mustSupport) out.mustSupport = true;
  out.required_by = row.required_by;
  out.grounding_class = row.grounding_class;
  if (row.condition) out.condition = row.condition;
  if (row.choices) out.choices = row.choices;
  if (row.allowedCodes) out.allowedCodes = row.allowedCodes;
  if (row.optional) out.optional = true;
  if (row.hint) out.hint = row.hint;
  if (row.derivation_source) out.derivation_source = row.derivation_source;
  return out;
}

/** Appended to the guide when the output carries optional (mustSupport) rows. */
export const OPTIONAL_ROWS_NOTE =
  "Rows with optional:true are mustSupport elements, NOT required: fill them when the record (or the listed default / " +
  "fixed value / derivation) gives the value, otherwise leave them out — a missing optional element is never a reason to refuse.";

/** Shorter guide for the compact view (the per-row keys it explains are fewer). */
export const READING_GUIDE_COMPACT =
  "Every listed element must be present; unlisted elements are optional. ids are snapshot element ids (':name' = slice; " +
  "'[x]' = choice, write one of `choices`). grounding_class: auto = copy `fixed`/`value` as is, `pattern` must be contained (extra content allowed); coding = map record " +
  "text to a code (allowedCodes / binding); source_fact = from the source record, never invent; workflow_default = usual " +
  "default unless the record says otherwise; structural = reference/ids/plumbing; site = organisation namespace; derived = " +
  "computable from other values; container = object/array holding the listed children. required_by (absent = profile: " +
  "min>=1 with every ancestor required): slice:<name> | " +
  "invariant:<key> | extension:<definition> | datatype:<Type> | target-implied (optional but the entry is meaningless " +
  "without it). `invariants` are extra profile rules to satisfy (`moreInvariants`: further keys, listed in full by verbosity='full'). Pass your draft as `instance` to also get the required " +
  "children of optional parents you populated; verbosity='full' adds min/max/types/binding/mustSupport.";

/**
 * Snapshot projection used by fhir_get_profile_required_elements: the
 * fhir_get_profile_elements projection plus `slicing` and constraint `source`, which the
 * slice-aware instance matching and the base-vs-profile invariant split need.
 */
export function projectForRequired(snapshotElements: Array<Record<string, any>>, project: (el: Record<string, any>) => Record<string, any>): ProjectedElement[] {
  return snapshotElements.map((el) => {
    const p = project(el) as ProjectedElement;
    p.slicing = el.slicing ? { discriminator: el.slicing.discriminator || [], rules: el.slicing.rules } : null;
    p.baseMax = el.base?.max ?? null;
    p.constraints = (el.constraint || []).map((c: any) => ({ key: c.key, severity: c.severity, human: c.human, expression: c.expression, source: c.source }));
    return p;
  });
}

/** True when the JSON property for this element id holds an array (the unsliced base repeats). */
function repeats(row: RequiredElementRow, E: Map<string, ProjectedElement>): boolean {
  const own = E.get(row.id);
  if (own?.baseMax) return own.baseMax !== "1" && own.baseMax !== "0";
  // only repeating elements can be sliced (choice-type slices aside)
  const last = row.id.split(".").pop() || "";
  if (last.includes(":") && !last.split(":")[0].endsWith("[x]")) return true;
  const base = E.get(stripSlices(row.id)) ?? own;
  if (base?.baseMax) return base.baseMax !== "1" && base.baseMax !== "0";
  const max = base?.max ?? row.max;
  return max !== "1" && max !== "0";
}

/**
 * Compact wire view (verbosity="compact", the default since tool version 1.1.0).
 *   - drops min/max/types/mustSupport (implied by FHIR or by `choices`/hint), keeps
 *     binding only for coding rows without allowedCodes, as "strength valueSet";
 *   - fixed/pattern become plain `fixed` / `pattern` values (no {field,value} wrapper);
 *   - required_by keeps its leading token (the parenthetical detail is in `full`);
 *   - an element whose listed descendants are all `auto` (profile-pinned) is folded into
 *     one row carrying the assembled JSON `value` to copy (e.g. a pinned LOINC coding).
 */
export function compactView(rows: RequiredElementRow[], E: Map<string, ProjectedElement>): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const folded = new Set<string>();
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const row of rows) {
    if (folded.has(row.id)) continue;
    const desc = rows.filter((d) => d.id.startsWith(`${row.id}.`));
    let value: unknown;
    const leavesPinned = desc.every((d) => d.fixed || d.pattern || desc.some((x) => x.id.startsWith(`${d.id}.`) || x.id.startsWith(`${d.id}:`)));
    if (desc.length && leavesPinned && desc.every((d) => d.grounding_class === "auto") && (row.grounding_class === "auto" || row.grounding_class === "container")) {
      value = assemble(row, desc, byId, E);
      if (value !== undefined) for (const d of desc) folded.add(d.id);
    }
    const o: Record<string, unknown> = { id: row.id };
    const by = row.required_by.split(" ")[0];
    if (by !== "profile") o.required_by = by; // the common case is implied (see the compact guide)
    o.grounding_class = value !== undefined ? "auto" : row.grounding_class;
    if (value !== undefined) o.value = value;
    else {
      if (row.fixed) o.fixed = row.fixed.value;
      if (row.pattern) o.pattern = row.pattern.value;
    }
    if (row.condition) o.condition = row.condition;
    if (row.choices) o.choices = row.choices;
    if (row.allowedCodes) o.allowedCodes = row.allowedCodes;
    else if (row.binding?.valueSet && row.grounding_class === "coding" && !row.fixed && !row.pattern && value === undefined) {
      o.binding = `${row.binding.strength ?? ""} ${String(row.binding.valueSet).split("|")[0]}`.trim();
    }
    let hint = row.hint;
    if (value !== undefined) hint = `pinned by the profile: copy \`value\`${repeats(row, E) ? " as one array item" : ""}`;
    else if (hint) {
      hint = hint
        .replace(/give \S+; only if the value is genuinely unknown use dataAbsentReason instead \(conformance-only, not a value\)/, "or dataAbsentReason only if genuinely unknown")
        .replace(/usual default (.*?); use another value only if the record says so/, "default $1")
        .split("; ")
        .map(compactHintPart)
        .filter(Boolean)
        .join("; ");
      if (row.grounding_class === "container") hint = [hint, containerShape(row, E)].filter(Boolean).join("; ");
    } else if (row.grounding_class === "container") hint = containerShape(row, E);
    if (row.optional) o.optional = true;
    if (hint) o.hint = hint;
    out.push(o);
  }
  return out;
}

function containerShape(row: RequiredElementRow, E: Map<string, ProjectedElement>): string {
  if (/:[^.]+$/.test(row.id)) return "one array item";
  return repeats(row, E) ? "array" : "object";
}

/** Hint fragments the compact guide already explains are dropped or shortened. */
function compactHintPart(h: string): string {
  if (h.startsWith("decided by the profile")) return "pinned by the profile through the rows listed under it";
  if (
    h.startsWith("object; fill") ||
    h.startsWith("array of objects") ||
    h.startsWith("fill each item") ||
    h.startsWith("slice \"") ||
    h.startsWith("must contain the pattern") ||
    h.startsWith("choice: use exactly one") ||
    h.startsWith("optional in the profile") ||
    h.startsWith("derivable from other") ||
    h === "pick from the binding" ||
    h.startsWith("namespace URI")
  ) {
    return "";
  }
  if (h.startsWith("optional (mustSupport, not required): fill it with")) return "optional: use this value / rule or leave it out";
  if (h.startsWith("optional (mustSupport, not required)")) return "optional: leave it out if the record lacks it";
  if (h.startsWith("type slice: write it as JSON property")) return h.replace("type slice: write it as JSON property", "JSON property");
  const dar = /^give (\S+); only if the value is genuinely unknown use dataAbsentReason/.exec(h);
  if (dar) return "or dataAbsentReason only if genuinely unknown";
  const dflt = /^usual default (.*); use another value only if the record says so$/.exec(h);
  if (dflt) return `default ${dflt[1]}`;
  return h;
}

/** Build the JSON value of `row` from its pinned descendants; undefined when the shape is not plain. */
function assemble(row: RequiredElementRow, desc: RequiredElementRow[], byId: Map<string, RequiredElementRow>, E: Map<string, ProjectedElement>): unknown {
  const own = row.fixed?.value ?? row.pattern?.value;
  if (own !== undefined && (typeof own !== "object" || own === null || Array.isArray(own))) return undefined;
  const root: Record<string, unknown> = own ? JSON.parse(JSON.stringify(own)) : {};
  const sorted = [...desc].sort((a, b) => a.id.split(".").length - b.id.split(".").length);
  for (const d of sorted) {
    const rel = d.id.slice(row.id.length + 1).split(".");
    if (rel.some((s) => s.includes("[x]"))) return undefined;
    let cur: Record<string, unknown> = root;
    let prefix = row.id;
    for (let i = 0; i < rel.length; i++) {
      const seg = rel[i];
      prefix = `${prefix}.${seg}`;
      const name = seg.split(":")[0];
      const r = byId.get(prefix);
      if (!r) return undefined;
      const arr = repeats(r, E);
      const last = i === rel.length - 1;
      const v = last ? (r.fixed?.value ?? r.pattern?.value) : undefined;
      if (last && v === undefined) {
        // pinned container without its own value (e.g. a required coding slice): make the node
        if (cur[name] === undefined) cur[name] = arr ? [{}] : {};
        continue;
      }
      if (last) {
        if (arr) {
          const list = (Array.isArray(cur[name]) ? cur[name] : []) as unknown[];
          if (typeof v === "object" && v !== null && !Array.isArray(v) && list.length && typeof list[0] === "object") Object.assign(list[0] as object, v);
          else list.push(v);
          cur[name] = list;
        } else if (typeof v === "object" && v !== null && typeof cur[name] === "object" && cur[name] !== null && !Array.isArray(v)) {
          Object.assign(cur[name] as object, v);
        } else cur[name] = v;
        continue;
      }
      if (arr) {
        if (!Array.isArray(cur[name])) cur[name] = [{}];
        const list = cur[name] as unknown[];
        // slices of one repeating element each get their own item
        const sliceKey = seg.includes(":") ? seg : null;
        if (sliceKey) {
          const tag = `__slice_${sliceKey}`;
          let item = list.find((x) => x && typeof x === "object" && (x as any)[tag]) as Record<string, unknown> | undefined;
          if (!item) {
            item = list.length === 1 && Object.keys(list[0] as object).length === 0 ? (list[0] as Record<string, unknown>) : {};
            if (!list.includes(item)) list.push(item);
            Object.defineProperty(item, tag, { value: true, enumerable: false });
          }
          cur = item;
        } else cur = list[0] as Record<string, unknown>;
      } else {
        if (Array.isArray(cur[name])) return undefined;
        if (typeof cur[name] !== "object" || cur[name] === null) cur[name] = {};
        cur = cur[name] as Record<string, unknown>;
      }
    }
  }
  return root;
}
