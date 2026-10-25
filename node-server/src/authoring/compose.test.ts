/**
 * composeResource over synthetic StructureDefinitions (fhirTestKit helpers) and in-memory
 * collaborators: value grammar per kind, placement (slices, components, backbones, choice),
 * pinning / conflicts, defaults / derived, missing, provenance, references, determinism.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { el, sd, CORE } from "../fhirTestKit.test.js";
import { RawNumber } from "../losslessJson.js";
import type { ComposeDeps, ExpandedCoding, NormalizeCandidate } from "./deps.js";
import { AUTHORING_UUID_NAMESPACE, composeResource, ComposeProfileError, fieldForPath, fieldSpecsFromSnapshot, isPendingRefIssue, keyToUrn, type ComposeOutput } from "./compose.js";
import type { AuthorInput } from "./types.js";

type El = Record<string, any>;
const EX = "http://example.org/StructureDefinition/";
const VS = "http://hl7.org/fhir/ValueSet/";
const OBS_CAT = "http://terminology.hl7.org/CodeSystem/observation-category";
const COND_CAT = "http://terminology.hl7.org/CodeSystem/condition-category";
const V2_0203 = "http://terminology.hl7.org/CodeSystem/v2-0203";
const LOINC = "http://loinc.org";
const SCT = "http://snomed.info/sct";
const UCUM = "http://unitsofmeasure.org";
const GTS = "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation";

const slice = (id: string, min: number, max: string, types: string[] = [], extra: El = {}): El => el(id, min, max, types, { baseMax: "*", ...extra });
const ref = (id: string, min: number, max: string, targets: string[]): El => el(id, min, max, [], { type: [{ code: "Reference", targetProfile: targets.map((t) => CORE + t) }] });
const domain = (t: string): El[] => [el(`${t}.id`, 0, "1", ["string"]), el(`${t}.meta`, 0, "1", ["Meta"]), el(`${t}.text`, 0, "1", ["Narrative"]), el(`${t}.extension`, 0, "*", ["Extension"])];

// ---- profiles ---------------------------------------------------------------

const LAB = sd(EX + "LabObs", "Observation", "resource", [
  el("Observation", 0, "*", [], {
    constraint: [{ key: "obs-x", severity: "error", human: "value or dataAbsentReason", expression: "(component.empty() and hasMember.empty()) implies (dataAbsentReason.exists() or value.exists())", source: EX + "LabObs" }],
  }),
  ...domain("Observation"),
  el("Observation.status", 1, "1", ["code"], { binding: { strength: "required", valueSet: `${VS}observation-status|4.0.1` }, mustSupport: true }),
  el("Observation.category", 1, "*", ["CodeableConcept"], { slicing: { discriminator: [{ type: "pattern", path: "$this" }], rules: "open" }, binding: { strength: "preferred", valueSet: `${VS}observation-category` } }),
  slice("Observation.category:lab", 1, "1", ["CodeableConcept"], { patternCodeableConcept: { coding: [{ system: OBS_CAT, code: "laboratory" }] }, binding: { strength: "required", valueSet: `${EX}lab-category` } }),
  el("Observation.code", 1, "1", ["CodeableConcept"], { binding: { strength: "extensible", valueSet: `${EX}lab-codes` } }),
  ref("Observation.subject", 1, "1", ["Patient"]),
  ref("Observation.encounter", 0, "1", ["Encounter"]),
  el("Observation.effective[x]", 1, "1", ["dateTime", "Period"]),
  el("Observation.issued", 0, "1", ["instant"]),
  el("Observation.value[x]", 0, "1", ["Quantity", "CodeableConcept", "string", "boolean", "integer"]),
  el("Observation.dataAbsentReason", 0, "1", ["CodeableConcept"]),
  el("Observation.interpretation", 0, "*", ["CodeableConcept"], { binding: { strength: "extensible", valueSet: `${VS}observation-interpretation` } }),
  el("Observation.note", 0, "*", ["Annotation"]),
  el("Observation.referenceRange", 0, "*", ["BackboneElement"]),
  el("Observation.referenceRange.low", 0, "1", ["SimpleQuantity"]),
  el("Observation.referenceRange.high", 0, "1", ["SimpleQuantity"]),
  el("Observation.referenceRange.text", 0, "1", ["string"]),
  el("Observation.hasMember", 0, "*", ["Reference"]),
  el("Observation.component", 0, "*", ["BackboneElement"]),
  el("Observation.component.code", 1, "1", ["CodeableConcept"]),
  el("Observation.component.value[x]", 0, "1", ["Quantity", "string"]),
]);

const BP = sd(EX + "BP", "Observation", "resource", [
  el("Observation", 0, "*"),
  ...domain("Observation"),
  el("Observation.status", 1, "1", ["code"], { binding: { strength: "required", valueSet: `${VS}observation-status|4.0.1` } }),
  el("Observation.category", 1, "*", ["CodeableConcept"], { slicing: { discriminator: [{ type: "value", path: "coding.code" }, { type: "value", path: "coding.system" }], rules: "open" } }),
  slice("Observation.category:VSCat", 1, "1", ["CodeableConcept"]),
  el("Observation.category:VSCat.coding", 1, "*", ["Coding"]),
  el("Observation.category:VSCat.coding.system", 1, "1", ["uri"], { fixedUri: OBS_CAT }),
  el("Observation.category:VSCat.coding.code", 1, "1", ["code"], { fixedCode: "vital-signs" }),
  el("Observation.code", 1, "1", ["CodeableConcept"]),
  el("Observation.code.coding", 1, "*", ["Coding"], { slicing: { discriminator: [{ type: "value", path: "code" }, { type: "value", path: "system" }], rules: "open" } }),
  slice("Observation.code.coding:BPCode", 1, "1", ["Coding"]),
  el("Observation.code.coding:BPCode.system", 1, "1", ["uri"], { fixedUri: LOINC }),
  el("Observation.code.coding:BPCode.code", 1, "1", ["code"], { fixedCode: "85354-9" }),
  ref("Observation.subject", 1, "1", ["Patient"]),
  el("Observation.effective[x]", 1, "1", ["dateTime", "Period"]),
  el("Observation.value[x]", 0, "0", ["Quantity"]),
  el("Observation.component", 2, "*", ["BackboneElement"], { slicing: { discriminator: [{ type: "value", path: "code.coding.code" }, { type: "value", path: "code.coding.system" }], rules: "open" } }),
  el("Observation.component.code", 1, "1", ["CodeableConcept"]),
  el("Observation.component.value[x]", 0, "1", ["Quantity", "string"]),
  slice("Observation.component:SystolicBP", 1, "1", ["BackboneElement"], {
    constraint: [{ key: "vs-3", severity: "error", human: "value or dataAbsentReason", expression: "value.exists() or dataAbsentReason.exists()" }],
  }),
  el("Observation.component:SystolicBP.code", 1, "1", ["CodeableConcept"]),
  el("Observation.component:SystolicBP.code.coding", 1, "*", ["Coding"], { slicing: { discriminator: [{ type: "value", path: "code" }, { type: "value", path: "system" }], rules: "open" } }),
  slice("Observation.component:SystolicBP.code.coding:SBPCode", 1, "1", ["Coding"]),
  el("Observation.component:SystolicBP.code.coding:SBPCode.system", 1, "1", ["uri"], { fixedUri: LOINC }),
  el("Observation.component:SystolicBP.code.coding:SBPCode.code", 1, "1", ["code"], { fixedCode: "8480-6" }),
  el("Observation.component:SystolicBP.value[x]", 0, "1", ["Quantity"]),
  el("Observation.component:SystolicBP.value[x].value", 1, "1", ["decimal"]),
  el("Observation.component:SystolicBP.value[x].unit", 1, "1", ["string"]),
  el("Observation.component:SystolicBP.value[x].system", 1, "1", ["uri"], { fixedUri: UCUM }),
  el("Observation.component:SystolicBP.value[x].code", 1, "1", ["code"], { fixedCode: "mm[Hg]" }),
  slice("Observation.component:DiastolicBP", 1, "1", ["BackboneElement"], {
    constraint: [{ key: "vs-3", severity: "error", human: "value or dataAbsentReason", expression: "value.exists() or dataAbsentReason.exists()" }],
  }),
  el("Observation.component:DiastolicBP.code", 1, "1", ["CodeableConcept"]),
  el("Observation.component:DiastolicBP.code.coding", 1, "*", ["Coding"], { slicing: { discriminator: [{ type: "value", path: "code" }, { type: "value", path: "system" }], rules: "open" } }),
  slice("Observation.component:DiastolicBP.code.coding:DBPCode", 1, "1", ["Coding"]),
  el("Observation.component:DiastolicBP.code.coding:DBPCode.system", 1, "1", ["uri"], { fixedUri: LOINC }),
  el("Observation.component:DiastolicBP.code.coding:DBPCode.code", 1, "1", ["code"], { fixedCode: "8462-4" }),
  el("Observation.component:DiastolicBP.value[x]", 0, "1", ["Quantity"]),
  el("Observation.component:DiastolicBP.value[x].value", 1, "1", ["decimal"]),
  el("Observation.component:DiastolicBP.value[x].unit", 1, "1", ["string"]),
  el("Observation.component:DiastolicBP.value[x].system", 1, "1", ["uri"], { fixedUri: UCUM }),
  el("Observation.component:DiastolicBP.value[x].code", 1, "1", ["code"], { fixedCode: "mm[Hg]" }),
]);

const PATIENT = sd(EX + "Pat", "Patient", "resource", [
  el("Patient", 0, "*"),
  ...domain("Patient"),
  el("Patient.identifier", 1, "*", ["Identifier"], { slicing: { discriminator: [{ type: "value", path: "type.coding.code" }, { type: "value", path: "type.coding.system" }], rules: "open" }, mustSupport: true }),
  el("Patient.identifier.system", 1, "1", ["uri"]),
  el("Patient.identifier.value", 1, "1", ["string"]),
  slice("Patient.identifier:mrn", 0, "1", ["Identifier"]),
  el("Patient.identifier:mrn.use", 0, "1", ["code"], { patternCode: "official", binding: { strength: "required", valueSet: `${VS}identifier-use|4.0.1` } }),
  el("Patient.identifier:mrn.type", 1, "1", ["CodeableConcept"]),
  el("Patient.identifier:mrn.type.coding", 1, "*", ["Coding"]),
  el("Patient.identifier:mrn.type.coding.system", 1, "1", ["uri"], { patternUri: V2_0203 }),
  el("Patient.identifier:mrn.type.coding.code", 1, "1", ["code"], { patternCode: "MR" }),
  el("Patient.identifier:mrn.system", 1, "1", ["uri"]),
  el("Patient.identifier:mrn.value", 1, "1", ["string"]),
  slice("Patient.identifier:national", 0, "1", ["Identifier"]),
  el("Patient.identifier:national.type", 1, "1", ["CodeableConcept"]),
  el("Patient.identifier:national.type.coding", 1, "*", ["Coding"]),
  el("Patient.identifier:national.type.coding.system", 1, "1", ["uri"], { patternUri: V2_0203 }),
  el("Patient.identifier:national.type.coding.code", 1, "1", ["code"], { patternCode: "NNxxx" }),
  el("Patient.identifier:national.system", 1, "1", ["uri"], { patternUri: "http://www.moi.gov.tw" }),
  el("Patient.identifier:national.value", 1, "1", ["string"]),
  el("Patient.active", 0, "1", ["boolean"], { mustSupport: true }),
  el("Patient.name", 0, "*", ["HumanName"], { slicing: { discriminator: [{ type: "pattern", path: "use" }], rules: "open" } }),
  slice("Patient.name:official", 0, "1", ["HumanName"]),
  el("Patient.name:official.use", 1, "1", ["code"], { patternCode: "official" }),
  el("Patient.name:official.text", 0, "1", ["string"]),
  el("Patient.name:official.family", 0, "1", ["string"]),
  el("Patient.name:official.given", 0, "*", ["string"]),
  el("Patient.telecom", 0, "*", ["ContactPoint"]),
  el("Patient.telecom.system", 1, "1", ["code"], { binding: { strength: "required", valueSet: `${VS}contact-point-system|4.0.1` } }),
  el("Patient.telecom.value", 1, "1", ["string"]),
  el("Patient.gender", 1, "1", ["code"], { binding: { strength: "required", valueSet: `${VS}administrative-gender|4.0.1` } }),
  el("Patient.birthDate", 1, "1", ["date"]),
  el("Patient.deceased[x]", 0, "1", ["boolean", "dateTime"]),
  el("Patient.address", 0, "*", ["Address"]),
  el("Patient.contact", 0, "*", ["BackboneElement"]),
  el("Patient.contact.relationship", 0, "*", ["CodeableConcept"]),
  el("Patient.contact.name", 0, "1", ["HumanName"]),
  el("Patient.contact.telecom", 0, "*", ["ContactPoint"]),
  ref("Patient.managingOrganization", 0, "1", ["Organization"]),
]);

const MEDREQ = sd(EX + "MedReq", "MedicationRequest", "resource", [
  el("MedicationRequest", 0, "*"),
  ...domain("MedicationRequest"),
  el("MedicationRequest.status", 1, "1", ["code"], { binding: { strength: "required", valueSet: `${VS}medicationrequest-status|4.0.1` } }),
  el("MedicationRequest.intent", 1, "1", ["code"], { binding: { strength: "required", valueSet: `${VS}medicationrequest-intent|4.0.1` } }),
  el("MedicationRequest.category", 0, "*", ["CodeableConcept"], { binding: { strength: "example", valueSet: `${VS}medicationrequest-category` }, mustSupport: true }),
  el("MedicationRequest.medication[x]", 1, "1", [], { type: [{ code: "CodeableConcept" }, { code: "Reference", targetProfile: [CORE + "Medication"] }] }),
  ref("MedicationRequest.subject", 1, "1", ["Patient"]),
  el("MedicationRequest.authoredOn", 0, "1", ["dateTime"], { mustSupport: true }),
  el("MedicationRequest.dosageInstruction", 0, "*", ["Dosage"], { mustSupport: true }),
  el("MedicationRequest.dispenseRequest", 0, "1", ["BackboneElement"]),
  el("MedicationRequest.dispenseRequest.validityPeriod", 0, "1", ["Period"]),
  el("MedicationRequest.dispenseRequest.numberOfRepeatsAllowed", 0, "1", ["unsignedInt"], { mustSupport: true }),
  el("MedicationRequest.dispenseRequest.quantity", 0, "1", ["SimpleQuantity"]),
]);

const CONDITION = sd(EX + "Cond", "Condition", "resource", [
  el("Condition", 0, "*"),
  ...domain("Condition"),
  el("Condition.clinicalStatus", 0, "1", ["CodeableConcept"], { binding: { strength: "required", valueSet: `${VS}condition-clinical|4.0.1` }, mustSupport: true }),
  el("Condition.category", 0, "*", ["CodeableConcept"], { binding: { strength: "extensible", valueSet: `${VS}condition-category` }, mustSupport: true }),
  el("Condition.code", 1, "1", ["CodeableConcept"]),
  ref("Condition.subject", 1, "1", ["Patient"]),
  ref("Condition.encounter", 0, "1", ["Encounter"]),
  el("Condition.onset[x]", 0, "1", ["dateTime", "Age", "Period", "string"]),
  el("Condition.recordedDate", 0, "1", ["dateTime"]),
]);

const VITALS = sd(EX + "Vitals", "Observation", "resource", [
  el("Observation", 0, "*"),
  ...domain("Observation"),
  el("Observation.status", 1, "1", ["code"], { binding: { strength: "required", valueSet: `${VS}observation-status|4.0.1` } }),
  el("Observation.category", 0, "*", ["CodeableConcept"], { binding: { strength: "preferred", valueSet: `${VS}observation-category` }, mustSupport: true }),
  el("Observation.code", 1, "1", ["CodeableConcept"]),
  ref("Observation.subject", 1, "1", ["Patient"]),
  el("Observation.effective[x]", 1, "1", ["dateTime", "Period"]),
  el("Observation.value[x]", 0, "1", ["Quantity", "string"]),
]);

const PROFILES: Record<string, El> = { [EX + "LabObs"]: LAB, [EX + "BP"]: BP, [EX + "Pat"]: PATIENT, [EX + "MedReq"]: MEDREQ, [EX + "Cond"]: CONDITION, [EX + "Vitals"]: VITALS };

// ---- collaborators ------------------------------------------------------------

const EXPANSIONS: Record<string, ExpandedCoding[]> = {
  [`${VS}observation-status`]: ["registered", "preliminary", "final", "amended", "cancelled"].map((c) => ({ system: "http://hl7.org/fhir/observation-status", code: c, display: c[0].toUpperCase() + c.slice(1) })),
  [`${VS}administrative-gender`]: [
    { system: "http://hl7.org/fhir/administrative-gender", code: "male", display: "Male" },
    { system: "http://hl7.org/fhir/administrative-gender", code: "female", display: "Female" },
    { system: "http://hl7.org/fhir/administrative-gender", code: "other", display: "Other" },
    { system: "http://hl7.org/fhir/administrative-gender", code: "unknown", display: "Unknown" },
  ],
  [`${VS}identifier-use`]: ["usual", "official", "temp", "secondary", "old"].map((c) => ({ system: "http://hl7.org/fhir/identifier-use", code: c, display: c })),
  [`${VS}contact-point-system`]: ["phone", "fax", "email", "pager", "url", "sms", "other"].map((c) => ({ system: "http://hl7.org/fhir/contact-point-system", code: c, display: c })),
  [`${VS}condition-category`]: [
    { system: COND_CAT, code: "problem-list-item", display: "Problem List Item" },
    { system: COND_CAT, code: "encounter-diagnosis", display: "Encounter Diagnosis" },
  ],
  [`${VS}observation-category`]: ["social-history", "vital-signs", "imaging", "laboratory", "procedure", "survey", "exam", "therapy", "activity"].map((c) => ({ system: OBS_CAT, code: c, display: c.replace("-", " ") })),
  [`${EX}lab-category`]: [{ system: OBS_CAT, code: "laboratory", display: "Laboratory" }],
  [`${VS}condition-clinical`]: ["active", "recurrence", "relapse", "inactive", "remission", "resolved"].map((c) => ({ system: "http://terminology.hl7.org/CodeSystem/condition-clinical", code: c, display: c[0].toUpperCase() + c.slice(1) })),
  [`${VS}medicationrequest-status`]: ["active", "on-hold", "cancelled", "completed", "stopped", "draft"].map((c) => ({ system: "http://hl7.org/fhir/CodeSystem/medicationrequest-status", code: c, display: c })),
  [`${VS}medicationrequest-intent`]: ["proposal", "plan", "order", "original-order"].map((c) => ({ system: "http://hl7.org/fhir/CodeSystem/medicationrequest-intent", code: c, display: c })),
  [`${EX}lab-codes`]: [
    { system: LOINC, code: "2345-7", display: "Glucose [Mass/volume] in Serum or Plasma" },
    { system: LOINC, code: "4548-4", display: "Hemoglobin A1c/Hemoglobin.total in Blood" },
  ],
  [`${VS}timing-abbreviation`]: ["BID", "TID", "QID", "QD", "QOD", "Q8H", "AM", "PM"].map((c) => ({ system: GTS, code: c, display: c })),
  [`${VS}units-of-time`]: ["s", "min", "h", "d", "wk", "mo", "a"].map((c) => ({ system: UCUM, code: c, display: c })),
  [`${VS}event-timing`]: ["HS", "AC", "PC", "MORN"].map((c) => ({ system: "http://hl7.org/fhir/event-timing", code: c, display: c })),
};

const DISPLAYS: Record<string, string> = {
  [`${LOINC}|85354-9`]: "Blood pressure panel with all children optional",
  [`${LOINC}|8480-6`]: "Systolic blood pressure",
  [`${LOINC}|8462-4`]: "Diastolic blood pressure",
  [`${LOINC}|2345-7`]: "Glucose [Mass/volume] in Serum or Plasma",
  [`${LOINC}|8867-4`]: "Heart rate",
  [`${SCT}|26643006`]: "Oral route",
  [`${OBS_CAT}|laboratory`]: "Laboratory",
  [`${OBS_CAT}|vital-signs`]: "Vital Signs",
  [`${V2_0203}|MR`]: "Medical record number",
  [`${SCT}|44054006`]: "Diabetes mellitus type 2",
};

const LEXICON: Record<string, NormalizeCandidate[]> = {
  "口服": [{ system: SCT, code: "26643006", display: "Oral route", exact: true, score: 1 }],
  glucose: [{ system: LOINC, code: "2345-7", display: "Glucose [Mass/volume] in Serum or Plasma", exact: true, score: 1 }],
  "blood sugar": [
    { system: LOINC, code: "2345-7", display: "Glucose [Mass/volume] in Serum or Plasma", score: 0.8 },
    { system: LOINC, code: "4548-4", display: "Hemoglobin A1c/Hemoglobin.total in Blood", score: 0.4 },
  ],
  "完成": [{ system: "http://hl7.org/fhir/observation-status", code: "final", display: "Final", score: 0.7 }],
};

export function makeDeps(opts: { profiles?: Record<string, El>; calls?: string[] } = {}): ComposeDeps {
  const profiles = opts.profiles ?? PROFILES;
  const calls = opts.calls;
  return {
    async resolveProfile(id) {
      const s = profiles[id] ?? Object.values(profiles).find((p) => p.id === id || p.url.split("/").pop() === id);
      return s ? { sd: s, canonical: s.url, id: s.url.split("/").pop()! } : null;
    },
    async expandValueSet(url, limit) {
      calls?.push(`expand ${url}`);
      const codings = EXPANSIONS[url.split("|")[0]];
      return codings ? { codings: codings.slice(0, limit), total: codings.length, truncated: codings.length > limit } : null;
    },
    async lookupDisplay(system, code) {
      calls?.push(`lookup ${system}|${code}`);
      return DISPLAYS[`${system}|${code}`] ?? null;
    },
    async normalize(text) {
      calls?.push(`normalize ${text}`);
      return LEXICON[text.toLowerCase()] ?? [];
    },
  };
}

const CTX = { contextId: "0123456789abcdef0123456789abcdef", knownKeys: new Set(["pat1", "enc1"]) };

async function compose(profile: string, fields: Record<string, unknown>, extra: Partial<AuthorInput> = {}, ctx = CTX, deps = makeDeps()): Promise<ComposeOutput> {
  return composeResource({ key: extra.key ?? "k1", profile, fields, ...extra }, deps, ctx);
}

function errorsOf(out: ComposeOutput): string[] {
  return out.errors.map((e) => `${e.field ?? "-"}: ${e.message}`);
}

// --------------------------------------------------------------------------- //
// Scalars and codes
// --------------------------------------------------------------------------- //

test("scalars: strings, booleans, integers and lossless decimals", async () => {
  const out = await compose(EX + "Pat", { identifier: { value: 12345, system: "http://h.example/mrn" }, active: "yes", gender: "female", birthDate: "1990-05-01", deceased: "false" });
  assert.deepEqual(errorsOf(out), []);
  assert.equal(out.resource.identifier[0].value, "12345");
  assert.equal(out.resource.active, true);
  assert.equal(out.resource.deceasedBoolean, false);
  assert.equal(out.resource.gender, "female");
  const lab = await compose(EX + "LabObs", { status: "final", code: { system: LOINC, code: "2345-7" }, subject: { ref: "pat1" }, effective: "2026-06-15", value: "95.0 mg/dL" });
  assert.deepEqual(errorsOf(lab), []);
  assert.ok(lab.resource.valueQuantity.value instanceof RawNumber, "a decimal spelled 95.0 keeps its spelling");
  assert.equal(lab.resource.valueQuantity.value.text, "95.0");
  const int = await compose(EX + "LabObs", { status: "final", code: { system: LOINC, code: "2345-7" }, subject: { ref: "pat1" }, effective: "2026-06-15", value: 7 });
  assert.equal(int.resource.valueInteger, 7, "a bare integer picks valueInteger over valueQuantity");
});

test("code with a required binding: label / display / case resolve to the code; a miss is an error with candidates", async () => {
  const a = await compose(EX + "LabObs", { status: "Final", code: { system: LOINC, code: "2345-7" }, subject: { ref: "pat1" }, effective: "2026-06-15", value: 1 });
  assert.equal(a.resource.status, "final");
  const b = await compose(EX + "Pat", { identifier: { value: "1", system: "http://h.example/mrn" }, gender: "Female", birthDate: "1990-05-01" });
  assert.equal(b.resource.gender, "female");
  const c = await compose(EX + "LabObs", { status: "完成", code: { system: LOINC, code: "2345-7" }, subject: { ref: "pat1" }, effective: "2026-06-15", value: 1 });
  assert.equal(c.resource.status, undefined);
  const err = c.errors.find((e) => e.field === "status");
  assert.ok(err && /not a code of the required ValueSet observation-status/.test(err.message), errorsOf(c).join("\n"));
  assert.deepEqual(err!.candidates, [{ system: "http://hl7.org/fhir/observation-status", code: "final", display: "Final" }]);
  assert.ok(!c.missing.some((m) => m.field === "status"), "an errored field is not also reported missing");
});

test("coding / CodeableConcept forms: object, array, text, {code} with inferred system, label via exact normalize", async () => {
  const out = await compose(EX + "LabObs", {
    status: "final",
    code: [{ system: LOINC, code: "2345-7" }, { system: "http://h.example/local", code: "GLU", display: "Glucose (local)" }],
    subject: { ref: "pat1" },
    effective: "2026-06-15",
    value: { text: "trace" },
    interpretation: "high",
  });
  assert.deepEqual(errorsOf(out), []);
  assert.equal(out.resource.code.coding.length, 2);
  assert.equal(out.resource.code.coding[0].display, "Glucose [Mass/volume] in Serum or Plasma", "display looked up");
  assert.equal(out.provenance["Observation.code.coding[0].display"], "lookup");
  assert.equal(out.resource.code.coding[1].display, "Glucose (local)", "the model's display is kept");
  assert.deepEqual(out.resource.valueCodeableConcept, { text: "trace" });
  assert.deepEqual(out.resource.interpretation, [{ text: "high" }], "extensible binding without a match → text");
  const inferred = await compose(EX + "Pat", { identifier: { value: "1", system: "http://h.example/mrn" }, gender: { code: "male" }, birthDate: "1990-05-01" });
  assert.equal(inferred.resource.gender, "male");
  const lab = await compose(EX + "LabObs", { status: "final", code: "glucose", subject: { ref: "pat1" }, effective: "2026-06-15", value: 1 });
  assert.deepEqual(lab.resource.code, { coding: [{ code: "2345-7", system: LOINC, display: "Glucose [Mass/volume] in Serum or Plasma" }], text: "glucose" }, "an exact normalize hit on an extensible binding becomes the coding; the label stays as text");
  assert.equal(lab.provenance["Observation.code.coding[0]"], "lookup");
  const fuzzy = await compose(EX + "LabObs", { status: "final", code: "blood sugar", subject: { ref: "pat1" }, effective: "2026-06-15", value: 1 });
  assert.deepEqual(fuzzy.resource.code, { text: "blood sugar" }, "a fuzzy match is never picked; extensible → text");
  const reqMiss = await compose(EX + "LabObs", { status: "final", code: { system: LOINC, code: "2345-7" }, "category:lab": "blood sugar", subject: { ref: "pat1" }, effective: "2026-06-15", value: 1 });
  const e = reqMiss.errors.find((x) => x.field === "category:lab");
  assert.ok(e && e.candidates && e.candidates.length === 2, "required binding: error carries candidates");
});

// --------------------------------------------------------------------------- //
// Quantities, dates, periods
// --------------------------------------------------------------------------- //

test("quantity grammar: text and object forms, UCUM resolution of unit words and rates, unknown units kept as text", async () => {
  const base = { status: "final", code: { system: LOINC, code: "2345-7" }, subject: { ref: "pat1" }, effective: "2026-06-15" };
  const cases: Array<[unknown, Record<string, unknown>]> = [
    ["95 mg/dL", { value: 95, unit: "mg/dL", system: UCUM, code: "mg/dL" }],
    [{ value: 120, unit: "mmHg" }, { value: 120, unit: "mmHg", system: UCUM, code: "mm[Hg]" }],
    ["37.2 °C", { value: 37.2, unit: "°C", system: UCUM, code: "Cel" }],
    ["72 bpm", { value: 72, unit: "bpm", system: UCUM, code: "/min" }],
    ["<5 mg/L", { value: 5, comparator: "<", unit: "mg/L", system: UCUM, code: "mg/L" }],
    [{ value: "60", unit: "kilogram" }, { value: 60, unit: "kilogram", system: UCUM, code: "kg" }],
    // v1.4: the `<count>/<time>` rate grammar (fhirRepair/ucumUnits.ts)
    [{ value: 3, unit: "次/分" }, { value: 3, unit: "次/分", system: UCUM, code: "/min" }],
    [{ value: 3, unit: "顆粒" }, { value: 3, unit: "顆粒" }],
    [{ value: 2, code: "{tablet}" }, { value: 2, system: UCUM, code: "{tablet}" }],
  ];
  for (const [given, want] of cases) {
    const out = await compose(EX + "LabObs", { ...base, value: given });
    assert.deepEqual(errorsOf(out), [], JSON.stringify(given));
    assert.deepEqual(out.resource.valueQuantity, want, JSON.stringify(given));
  }
  const r = await compose(EX + "LabObs", { ...base, value: "95 mg/dL" });
  assert.equal(r.provenance["Observation.valueQuantity.code"], "lookup");
  const bad = await compose(EX + "LabObs", { ...base, value: { unit: "mg" } });
  assert.ok(bad.errors.some((e) => e.field === "value" && /needs a value/.test(e.message)));
});

test("dates: ISO precisions, ROC conversion, timezone completion, impossible dates, date vs dateTime", async () => {
  const base = { status: "final", code: { system: LOINC, code: "2345-7" }, subject: { ref: "pat1" }, value: 1 };
  const ok: Array<[string, string]> = [
    ["2026", "2026"],
    ["2026-06", "2026-06"],
    ["2026-06-15", "2026-06-15"],
    ["2026-06-15T06:00+08:00", "2026-06-15T06:00:00+08:00"],
    ["2026-06-15T06:00:30Z", "2026-06-15T06:00:30Z"],
    ["115/06/15", "2026-06-15"],
    ["115/6/5", "2026-06-05"],
    ["民國115年6月15日", "2026-06-15"],
    ["115-06-15", "2026-06-15"],
    ["2026/06/15", "2026-06-15"],
    ["115年6月", "2026-06"],
  ];
  for (const [given, want] of ok) {
    const out = await compose(EX + "LabObs", { ...base, effective: given });
    assert.deepEqual(errorsOf(out), [], given);
    assert.equal(out.resource.effectiveDateTime, want, given);
    assert.equal(out.provenance["Observation.effectiveDateTime"], "model");
  }
  const tz = await compose(EX + "LabObs", { ...base, effective: "115/06/15 06:00" }, {}, { ...CTX, timezone: "+08:00" });
  assert.equal(tz.resource.effectiveDateTime, "2026-06-15T06:00:00+08:00");
  const noTz = await compose(EX + "LabObs", { ...base, effective: "2026-06-15T06:00" });
  assert.ok(noTz.errors.some((e) => e.field === "effective" && /UTC offset/.test(e.message)), errorsOf(noTz).join());
  for (const bad of ["2026-02-30", "115/13/01", "2026-06-15T25:00+08:00", "0/01/01", "15 June 2026"]) {
    const out = await compose(EX + "LabObs", { ...base, effective: bad });
    assert.ok(out.errors.some((e) => e.field === "effective"), bad);
    assert.equal(out.resource.effectiveDateTime, undefined, bad);
  }
  const instant = await compose(EX + "LabObs", { ...base, effective: "2026-06-15", issued: "2026-06-15" });
  assert.ok(instant.errors.some((e) => e.field === "issued" && /instant/.test(e.message)));
  const bd = await compose(EX + "Pat", { identifier: { value: "1", system: "http://h.example/mrn" }, gender: "male", birthDate: "79/03/02T00:00" });
  assert.equal(bd.resource.birthDate, "1990-03-02", "a midnight time on a date element is dropped");
  const bd2 = await compose(EX + "Pat", { identifier: { value: "1", system: "http://h.example/mrn" }, gender: "male", birthDate: "1990-03-02T08:30" });
  assert.ok(bd2.errors.some((e) => e.field === "birthDate" && /without a time/.test(e.message)));
});

test("period: object, text range, single date; end before start is an error", async () => {
  const base = { status: "final", code: { system: LOINC, code: "2345-7" }, subject: { ref: "pat1" }, value: 1 };
  const a = await compose(EX + "LabObs", { ...base, effective: { start: "115/06/15", end: "2026-06-16" } });
  assert.deepEqual(a.resource.effectivePeriod, { start: "2026-06-15", end: "2026-06-16" });
  const b = await compose(EX + "LabObs", { ...base, effectivePeriod: "2026-06-15 ~ 2026-06-20" });
  assert.deepEqual(b.resource.effectivePeriod, { start: "2026-06-15", end: "2026-06-20" });
  const c = await compose(EX + "LabObs", { ...base, effectivePeriod: { start: "2026-06-15" } });
  assert.deepEqual(c.resource.effectivePeriod, { start: "2026-06-15" });
  const d = await compose(EX + "LabObs", { ...base, effective: { start: "2026-06-20", end: "2026-06-15" } });
  assert.ok(d.errors.some((e) => /before its start/.test(e.message)));
});

// --------------------------------------------------------------------------- //
// Placement: slices, identifiers, names, backbones, choice
// --------------------------------------------------------------------------- //

test("identifier slices: named slice pins its pattern; an unnamed entry is matched by its discriminators; strings and arrays", async () => {
  const out = await compose(EX + "Pat", {
    "identifier:mrn": { value: "MRN-1", system: "http://h.example/mrn" },
    identifier: [{ value: "A123456789", system: "http://www.moi.gov.tw", type: "NNxxx" }, "plain-id"],
    gender: "male",
    birthDate: "1990-01-01",
  });
  assert.deepEqual(errorsOf(out), []);
  const ids = out.resource.identifier;
  assert.equal(ids.length, 3);
  assert.deepEqual(ids[0], { value: "MRN-1", system: "http://h.example/mrn", use: "official", type: { coding: [{ system: V2_0203, code: "MR", display: "Medical record number" }] } });
  assert.equal(out.provenance["Patient.identifier[0].type"], "fixed");
  assert.equal(out.provenance["Patient.identifier[0].use"], "fixed");
  assert.equal(out.provenance["Patient.identifier[0].type.coding[0].display"], "lookup");
  assert.deepEqual(ids[1].type.coding[0], { code: "NNxxx", system: V2_0203 }, "the unnamed national id was matched to its slice and its system pinned");
  assert.equal(ids[1].system, "http://www.moi.gov.tw");
  assert.deepEqual(ids[2], { value: "plain-id" });
  assert.equal(out.fieldMap["Patient.identifier[0]"], "identifier:mrn");
  assert.equal(out.fieldMap["Patient.identifier[2]"], "identifier");
  assert.ok(out.missing.some((m) => m.field === "identifier.system"), "the plain identifier lacks its required system: " + JSON.stringify(out.missing));
});

test("human names, contact points, addresses and backbone objects", async () => {
  const out = await compose(EX + "Pat", {
    identifier: { value: "1", system: "http://h.example/mrn" },
    "name:official": { family: "王", given: "小明" },
    name: "王小明",
    telecom: [{ system: "phone", value: "02-1234-5678" }, "a@b.example"],
    address: "台北市中正區",
    contact: { name: { family: "李" }, telecom: { system: "phone", value: "0912" }, relationship: { text: "mother" } },
    gender: "male",
    birthDate: "1990-01-01",
  });
  assert.deepEqual(errorsOf(out), []);
  assert.deepEqual(out.resource.name[0], { family: "王", given: ["小明"], use: "official" });
  assert.deepEqual(out.resource.name[1], { text: "王小明" });
  assert.deepEqual(out.resource.telecom[1], { value: "a@b.example" });
  assert.deepEqual(out.resource.address, [{ text: "台北市中正區" }]);
  assert.deepEqual(out.resource.contact, [{ name: { family: "李" }, telecom: [{ system: "phone", value: "0912" }], relationship: [{ text: "mother" }] }]);
  assert.equal(out.fieldMap["Patient.contact[0].name"], "contact.name");
  assert.ok(out.missing.some((m) => m.field === "telecom.system"), "telecom[1] lacks its system → missing");
});

test("nested dotted fields create backbones; an optional default inside them (numberOfRepeatsAllowed) is never filled", async () => {
  const out = await compose(EX + "MedReq", {
    status: "active",
    intent: "order",
    medication: { system: "http://h.example/drug", code: "D1", display: "Drug 1" },
    subject: { ref: "pat1" },
    "dispenseRequest.validityPeriod": { start: "115/06/15", end: "115/06/22" },
    "dispenseRequest.quantity": "14 {tablet}",
  });
  assert.deepEqual(errorsOf(out), []);
  assert.deepEqual(out.resource.dispenseRequest, { validityPeriod: { start: "2026-06-15", end: "2026-06-22" }, quantity: { value: 14, unit: "{tablet}", system: UCUM, code: "{tablet}" } });
  assert.equal(out.provenance["MedicationRequest.dispenseRequest.numberOfRepeatsAllowed"], undefined, "0..1 (mustSupport): no workflow default");
  const without = await compose(EX + "MedReq", { status: "active", intent: "order", medication: { text: "x" }, subject: { ref: "pat1" } });
  assert.equal(without.resource.dispenseRequest, undefined, "no parent → no default inside it");
  assert.deepEqual(without.resource.medicationCodeableConcept, { text: "x" });
});

test("choice elements: shape selects the type, explicit property names work, two types for one choice is an error", async () => {
  const base = { status: "final", code: { system: LOINC, code: "2345-7" }, subject: { ref: "pat1" }, effective: "2026-06-15" };
  const q = await compose(EX + "LabObs", { ...base, value: "95 mg/dL" });
  assert.equal(q.resource.valueQuantity.value, 95);
  const cc = await compose(EX + "LabObs", { ...base, value: { system: SCT, code: "260385009" } });
  assert.deepEqual(cc.resource.valueCodeableConcept, { coding: [{ system: SCT, code: "260385009" }] });
  const s = await compose(EX + "LabObs", { ...base, value: "positive" });
  assert.equal(s.resource.valueString, "positive");
  const b = await compose(EX + "LabObs", { ...base, value: true });
  assert.equal(b.resource.valueBoolean, true);
  const explicit = await compose(EX + "LabObs", { ...base, valueString: "95" });
  assert.equal(explicit.resource.valueString, "95", "an explicit property name forces the type");
  const bracket = await compose(EX + "LabObs", { ...base, "value[x]": "95 mg/dL" });
  assert.equal(bracket.resource.valueQuantity.code, "mg/dL");
  const dup = await compose(EX + "LabObs", { ...base, value: "95 mg/dL", valueString: "x" });
  assert.ok(dup.errors.some((e) => /exactly one type/.test(e.message)));
  const medRef = await compose(EX + "MedReq", { status: "active", intent: "order", medication: { ref: "med1" }, subject: { ref: "pat1" } });
  assert.equal(medRef.resource.medicationReference.reference, keyToUrn(CTX.contextId, "med1"));
  assert.deepEqual(medRef.refs.pending, ["med1"]);
  const onsetAge = await compose(EX + "Cond", { code: { text: "x" }, subject: { ref: "pat1" }, onset: "45 a" });
  assert.deepEqual(onsetAge.resource.onsetAge, { value: 45, unit: "a", system: UCUM, code: "a" });
  const onsetStr = await compose(EX + "Cond", { code: { text: "x" }, subject: { ref: "pat1" }, onset: "childhood" });
  assert.equal(onsetStr.resource.onsetString, "childhood");
});

test("unknown fields are errors that list the valid fields and the closest names; nested unknown keys too", async () => {
  const out = await compose(EX + "LabObs", { status: "final", code: { system: LOINC, code: "2345-7" }, subjet: { ref: "pat1" }, effective: "2026-06-15", value: 1, "referenceRange.lo": "70 mg/dL" });
  const e = out.errors.find((x) => x.field === "subjet");
  assert.ok(e && /unknown field 'subjet'/.test(e.message) && /did you mean 'subject'/.test(e.message) && /Valid fields: /.test(e.message), errorsOf(out).join("\n"));
  const n = out.errors.find((x) => x.field === "referenceRange.lo");
  assert.ok(n && /under referenceRange/.test(n.message) && /'low'/.test(n.message), errorsOf(out).join("\n"));
  assert.ok(out.missing.some((m) => m.field === "subject"));
  const comp = await compose(EX + "LabObs", { status: "final", code: { system: LOINC, code: "2345-7" }, subject: { ref: "pat1" }, effective: "2026-06-15", component: [{ code: { system: LOINC, code: "1" }, val: 1 }] });
  assert.ok(comp.errors.some((x) => x.field === "component.val" && /did you mean 'value\[x\]'/.test(x.message)), errorsOf(comp).join("\n"));
  const injected = makeDeps();
  injected.authoringFields = () => [{ field: "status", required: true, kind: "code", multiple: false, source: "default" }, { field: "subject", required: true, kind: "reference", multiple: false, source: "record" }];
  const inj = await compose(EX + "LabObs", { stat: "final" }, {}, CTX, injected);
  assert.ok(inj.errors[0].message.includes("Valid fields: status, subject"), "the injected field list is used");
});

test("cardinality: a slice with max 1 given two values, a non-repeating element given an array, a prohibited element", async () => {
  const two = await compose(EX + "Pat", { "identifier:mrn": [{ value: "a", system: "http://x" }, { value: "b", system: "http://x" }], gender: "male", birthDate: "1990-01-01" });
  assert.ok(two.errors.some((e) => /at most 1 value/.test(e.message)));
  const arr = await compose(EX + "Pat", { identifier: { value: "a", system: "http://x" }, gender: ["male", "female"], birthDate: "1990-01-01" });
  assert.ok(arr.errors.some((e) => e.field === "gender" && /does not repeat/.test(e.message)));
  const prohibited = await compose(EX + "BP", { status: "final", subject: { ref: "pat1" }, effective: "2026-06-15", value: "1 mm[Hg]" });
  assert.ok(prohibited.errors.some((e) => e.field === "value" && /prohibited/.test(e.message)));
});

// --------------------------------------------------------------------------- //
// Components, pinning, determined content, conflicts
// --------------------------------------------------------------------------- //

test("blood pressure: components land in their slices by discriminator, fixed units / codes are pinned, category and code are created", async () => {
  const out = await compose(EX + "BP", {
    status: "final",
    subject: { ref: "pat1" },
    effective: "115/06/15",
    component: [
      { code: { system: LOINC, code: "8480-6" }, value: "120 mmHg" },
      { code: { system: LOINC, code: "8462-4" }, value: { value: 80, unit: "mmHg" } },
    ],
  });
  assert.deepEqual(errorsOf(out), []);
  assert.deepEqual(out.resource.category, [{ coding: [{ system: OBS_CAT, code: "vital-signs", display: "Vital Signs" }] }]);
  assert.equal(out.provenance["Observation.category[0]"], "fixed");
  assert.deepEqual(out.resource.code, { coding: [{ system: LOINC, code: "85354-9", display: "Blood pressure panel with all children optional" }] });
  assert.equal(out.provenance["Observation.code"], "fixed");
  assert.equal(out.provenance["Observation.code.coding[0].display"], "lookup");
  assert.deepEqual(out.resource.component[0].valueQuantity, { value: 120, unit: "mmHg", system: UCUM, code: "mm[Hg]" });
  assert.deepEqual(out.resource.component[1].valueQuantity, { value: 80, unit: "mmHg", system: UCUM, code: "mm[Hg]" });
  assert.equal(out.resource.component[0].code.coding[0].display, "Systolic blood pressure");
  assert.equal(out.fieldMap["Observation.component[1]"], "component");
  assert.equal(fieldForPath(out.fieldMap, "Observation.component[1].valueQuantity.code"), "component.value", "the most specific placed path wins");
  assert.deepEqual(out.missing, []);
  assert.equal(out.resource.id, undefined, "no id is invented");
  assert.deepEqual(out.resource.meta, { profile: [EX + "BP"] });
});

test("blood pressure: a unit that contradicts the fixed UCUM code is a conflict error; a missing slice is reported, not invented", async () => {
  const kpa = await compose(EX + "BP", {
    status: "final",
    subject: { ref: "pat1" },
    effective: "2026-06-15",
    component: [{ code: { system: LOINC, code: "8480-6" }, value: "16 kPa" }, { code: { system: LOINC, code: "8462-4" }, value: "80 mmHg" }],
  });
  const e = kpa.errors.find((x) => /mm\[Hg\]/.test(x.message));
  assert.ok(e && e.field === "component.value" && e.path === "Observation.component[0].valueQuantity.code", errorsOf(kpa).join("\n"));
  const only = await compose(EX + "BP", { status: "final", subject: { ref: "pat1" }, effective: "2026-06-15", component: [{ code: { system: LOINC, code: "8462-4" }, value: "80 mmHg" }] });
  assert.deepEqual(errorsOf(only), []);
  assert.equal(only.resource.component.length, 1, "the systolic component is not fabricated");
  assert.ok(only.missing.some((m) => m.field === "component:SystolicBP" && /slice:SystolicBP/.test(m.why)), JSON.stringify(only.missing));
  const named = await compose(EX + "BP", {
    status: "final",
    subject: { ref: "pat1" },
    effective: "2026-06-15",
    "component:SystolicBP": { value: "120 mmHg" },
    "component:DiastolicBP": { value: "80 mmHg" },
  });
  assert.deepEqual(errorsOf(named), []);
  assert.deepEqual(named.resource.component[0].code.coding[0], { system: LOINC, code: "8480-6", display: "Systolic blood pressure" }, "a named slice entry gets its pinned code");
  assert.deepEqual(named.missing, []);
  const conflict = await compose(EX + "BP", { status: "final", subject: { ref: "pat1" }, effective: "2026-06-15", "category:VSCat": { system: OBS_CAT, code: "laboratory" }, component: [] });
  assert.ok(conflict.errors.some((x) => x.field === "category:VSCat" && /fixes category:VSCat.coding.code to "vital-signs"/.test(x.message)), errorsOf(conflict).join("\n"));
});

test("lab result: the category slice pattern is created when absent, matched when given as a label, kept beside an unrelated entry", async () => {
  const base = { status: "final", code: { system: LOINC, code: "2345-7" }, subject: { ref: "pat1" }, effective: "2026-06-15", value: "95 mg/dL" };
  const absent = await compose(EX + "LabObs", base);
  assert.deepEqual(errorsOf(absent), []);
  assert.deepEqual(absent.resource.category, [{ coding: [{ system: OBS_CAT, code: "laboratory", display: "Laboratory" }] }]);
  assert.equal(absent.provenance["Observation.category[0]"], "fixed");
  assert.deepEqual(absent.missing, []);
  const label = await compose(EX + "LabObs", { ...base, category: "laboratory" });
  assert.deepEqual(errorsOf(label), []);
  assert.equal(label.resource.category.length, 1, "the label resolved to the slice coding; no duplicate entry");
  assert.equal(label.provenance["Observation.category[0]"], "model");
  const other = await compose(EX + "LabObs", { ...base, category: { text: "lab" } });
  assert.equal(other.resource.category.length, 2, "an entry that is not the slice stays and the required slice is added");
  assert.deepEqual(other.resource.category[0], { text: "lab" });
});

// --------------------------------------------------------------------------- //
// Dosage
// --------------------------------------------------------------------------- //

test("dosage grammar: text / route / dose / frequency / period / asNeeded → Dosage with Timing.repeat", async () => {
  const out = await compose(EX + "MedReq", {
    status: "active",
    intent: "order",
    medication: { text: "Amoxicillin 500 mg capsule" },
    subject: { ref: "pat1" },
    dosageInstruction: { text: "1 cap q8h x 7d", route: "口服", dose: "500 mg", frequency: "q8h", period: "7 days", asNeeded: false },
  });
  assert.deepEqual(errorsOf(out), []);
  const d = out.resource.dosageInstruction[0];
  assert.equal(d.text, "1 cap q8h x 7d");
  assert.deepEqual(d.route, { coding: [{ code: "26643006", system: SCT, display: "Oral route" }], text: "口服" });
  assert.deepEqual(d.doseAndRate, [{ doseQuantity: { value: 500, unit: "mg", system: UCUM, code: "mg" } }]);
  assert.deepEqual(d.timing, { repeat: { frequency: 1, period: 8, periodUnit: "h", boundsDuration: { value: 7, unit: "days", system: UCUM, code: "d" } }, code: { coding: [{ system: GTS, code: "Q8H", display: "Q8H" }] } });
  assert.equal(out.provenance["MedicationRequest.dosageInstruction[0].timing.code"], "lookup");
  assert.equal(d.asNeededBoolean, false);
  assert.equal(out.provenance["MedicationRequest.dosageInstruction[0].route.coding[0]"], "lookup");
  const cases: Array<[unknown, Record<string, unknown>, string | undefined]> = [
    ["BID", { frequency: 2, period: 1, periodUnit: "d" }, "BID"],
    ["每天三次", { frequency: 3, period: 1, periodUnit: "d" }, "TID"],
    ["一天兩次飯後", { frequency: 2, period: 1, periodUnit: "d", when: ["PC"] }, "BID"],
    ["every 6 hours", { frequency: 1, period: 6, periodUnit: "h" }, undefined],
    ["3 times a day", { frequency: 3, period: 1, periodUnit: "d" }, "TID"],
    ["睡前", { when: ["HS"], frequency: 1, period: 1, periodUnit: "d" }, undefined],
    ["隔日", { frequency: 1, period: 2, periodUnit: "d" }, "QOD"],
    ["每週一次", { frequency: 1, period: 1, periodUnit: "wk" }, undefined],
    [{ frequency: 2, period: 1, periodUnit: "day" }, { frequency: 2, period: 1, periodUnit: "d" }, "BID"],
    ["TID AC", { frequency: 3, period: 1, periodUnit: "d", when: ["AC"] }, "TID"],
  ];
  for (const [freq, repeat, abbr] of cases) {
    const r = await compose(EX + "MedReq", { status: "active", intent: "order", medication: { text: "x" }, subject: { ref: "pat1" }, dosageInstruction: { frequency: freq } });
    assert.deepEqual(errorsOf(r), [], JSON.stringify(freq));
    const t = r.resource.dosageInstruction[0].timing;
    assert.deepEqual(t.repeat, repeat, JSON.stringify(freq));
    if (abbr && ["BID", "TID", "QOD", "Q8H"].includes(abbr)) assert.deepEqual(t.code, { coding: [{ system: GTS, code: abbr, display: abbr }] }, `${JSON.stringify(freq)} → Timing.code ${abbr} from the bound ValueSet`);
    else assert.equal(t.code, undefined, JSON.stringify(freq));
  }
  const prn = await compose(EX + "MedReq", { status: "active", intent: "order", medication: { text: "x" }, subject: { ref: "pat1" }, dosageInstruction: { frequency: "q4h prn", dose: "1 {tablet}" } });
  assert.equal(prn.resource.dosageInstruction[0].asNeededBoolean, true);
  assert.deepEqual(prn.resource.dosageInstruction[0].timing.repeat, { frequency: 1, period: 4, periodUnit: "h" });
  const bad = await compose(EX + "MedReq", { status: "active", intent: "order", medication: { text: "x" }, subject: { ref: "pat1" }, dosageInstruction: { frequency: "whenever the moon is full" } });
  assert.ok(bad.errors.some((e) => e.field === "dosageInstruction" && /frequency not understood/.test(e.message)));
  const plain = await compose(EX + "MedReq", { status: "active", intent: "order", medication: { text: "x" }, subject: { ref: "pat1" }, dosageInstruction: ["每日一次 睡前"] });
  assert.deepEqual(plain.resource.dosageInstruction, [{ text: "每日一次 睡前" }], "a plain string is Dosage.text");
  const unknown = await compose(EX + "MedReq", { status: "active", intent: "order", medication: { text: "x" }, subject: { ref: "pat1" }, dosageInstruction: { dosis: "1" } });
  assert.ok(unknown.errors.some((e) => /unknown dosage field\(s\) dosis/.test(e.message)));
});

// --------------------------------------------------------------------------- //
// References
// --------------------------------------------------------------------------- //

test("references: context keys become deterministic urns, unknown keys are pending, external references are untouched", async () => {
  const out = await compose(EX + "LabObs", {
    status: "final",
    code: { system: LOINC, code: "2345-7" },
    subject: { ref: "pat1" },
    encounter: { ref: "enc-later" },
    effective: "2026-06-15",
    value: 1,
    hasMember: [{ reference: "Observation/ext-1", display: "external" }, "Observation/ext-2", "obs2"],
  });
  assert.deepEqual(errorsOf(out), []);
  assert.equal(out.resource.subject.reference, keyToUrn(CTX.contextId, "pat1"));
  assert.match(out.resource.subject.reference, /^urn:uuid:[0-9a-f-]{36}$/);
  assert.deepEqual(out.resource.hasMember[0], { reference: "Observation/ext-1", display: "external" });
  assert.deepEqual(out.resource.hasMember[1], { reference: "Observation/ext-2" });
  assert.deepEqual(out.refs.resolved, ["pat1"]);
  assert.deepEqual(out.refs.pending, ["enc-later", "obs2"]);
  assert.deepEqual(out.refs.pendingUrns, [keyToUrn(CTX.contextId, "enc-later"), keyToUrn(CTX.contextId, "obs2")]);
  assert.deepEqual(out.refs.pendingPaths, ["Observation.encounter", "Observation.hasMember[2]"]);
  assert.ok(isPendingRefIssue({ path: "Observation.encounter", message: `Can't find '${keyToUrn(CTX.contextId, "enc-later")}' in the bundle` }, out.refs));
  assert.ok(isPendingRefIssue({ path: "Observation.hasMember[2].reference", message: "URN reference is not locally contained" }, out.refs));
  assert.ok(!isPendingRefIssue({ path: "Observation.subject", message: "Unable to find a profile match" }, out.refs));
  assert.notEqual(keyToUrn("a", "k"), keyToUrn("b", "k"));
  assert.equal(keyToUrn(CTX.contextId, "pat1"), keyToUrn(CTX.contextId, "pat1"));
  assert.match(AUTHORING_UUID_NAMESPACE, /^[0-9a-f-]{36}$/);
});

// --------------------------------------------------------------------------- //
// Defaults, derived values, missing, provenance, determinism
// --------------------------------------------------------------------------- //

test("defaults: workflow defaults fill only REQUIRED elements the model left empty; optional (even mustSupport) ones never; model values win", async () => {
  const out = await compose(EX + "LabObs", { code: { system: LOINC, code: "2345-7" }, subject: { ref: "pat1" }, effective: "2026-06-15", value: 1 });
  assert.equal(out.resource.status, "final");
  assert.equal(out.provenance["Observation.status"], "default");
  const given = await compose(EX + "LabObs", { status: "registered", code: { system: LOINC, code: "2345-7" }, subject: { ref: "pat1" }, effective: "2026-06-15", value: 1 });
  assert.equal(given.resource.status, "registered");
  assert.equal(given.provenance["Observation.status"], "model");
  const pat = await compose(EX + "Pat", { identifier: { value: "1", system: "http://x" }, gender: "male", birthDate: "1990-01-01" });
  assert.equal(pat.resource.active, undefined, "Patient.active is 0..1 (mustSupport): never auto-filled");
  assert.equal(pat.provenance["Patient.active"], undefined);
  assert.ok(!pat.missing.some((m) => m.field === "active"), "an optional element is not missing either");
  const med = await compose(EX + "MedReq", { medication: { text: "x" }, subject: { ref: "pat1" } });
  assert.equal(med.resource.status, "active");
  assert.equal(med.resource.intent, "order");
  const cond = await compose(EX + "Cond", { code: { text: "x" }, subject: { ref: "pat1" } });
  assert.equal(cond.resource.clinicalStatus, undefined, "Condition.clinicalStatus 0..1: no default");
  const condReq = sd(EX + "CondReq", "Condition", "resource", [
    el("Condition", 0, "*"),
    ...domain("Condition"),
    el("Condition.clinicalStatus", 1, "1", ["CodeableConcept"], { binding: { strength: "required", valueSet: `${VS}condition-clinical|4.0.1` } }),
    el("Condition.code", 0, "1", ["CodeableConcept"]),
  ]);
  const reqd = await compose(EX + "CondReq", { code: { text: "x" } }, {}, CTX, makeDeps({ profiles: { ...PROFILES, [EX + "CondReq"]: condReq } }));
  assert.deepEqual(reqd.resource.clinicalStatus, { coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-clinical", code: "active", display: "Active" }] }, "required: a CodeableConcept default takes its system from the bound ValueSet");
  assert.equal(reqd.provenance["Condition.clinicalStatus"], "default");
  const dv = sd(EX + "Dv", "Patient", "resource", [
    el("Patient", 0, "*"),
    ...domain("Patient"),
    el("Patient.active", 1, "1", ["boolean"], { defaultValueBoolean: false }),
    el("Patient.gender", 0, "1", ["code"], { defaultValueCode: "unknown" }),
  ]);
  const dvOut = await compose(EX + "Dv", {}, {}, CTX, makeDeps({ profiles: { [EX + "Dv"]: dv } }));
  assert.equal(dvOut.resource.active, false, "required element: its defaultValue[x] applies");
  assert.equal(dvOut.resource.gender, undefined, "optional element: its defaultValue[x] is never applied");
});

test("apply_defaults=none: no default at all; the required elements then appear in missing; derived values unchanged", async () => {
  const none = { ...CTX, applyDefaults: "none" as const };
  const lab = await compose(EX + "LabObs", { code: { system: LOINC, code: "2345-7" }, subject: { ref: "pat1" }, effective: "2026-06-15", value: 1 }, {}, none);
  assert.equal(lab.resource.status, undefined);
  assert.ok(lab.missing.some((m) => m.field === "status" && /^required by profile/.test(m.why)), JSON.stringify(lab.missing));
  assert.equal(lab.resource.category[0].coding[0].code, "laboratory", "fixed / pattern content is not a default: still created");
  const med = await compose(EX + "MedReq", { medication: { text: "x" }, subject: { ref: "pat1" } }, {}, none);
  assert.equal(med.resource.status, undefined);
  assert.equal(med.resource.intent, undefined);
  assert.ok(med.missing.some((m) => m.field === "status") && med.missing.some((m) => m.field === "intent"));
  const cond = await compose(EX + "Cond", { code: { text: "x" }, subject: { ref: "pat1" }, encounter: { ref: "enc1" } }, {}, none);
  assert.equal(cond.resource.category[0].coding[0].code, "encounter-diagnosis", "derived rules are not defaults");
  const req = await compose(EX + "LabObs", { code: { system: LOINC, code: "2345-7" }, subject: { ref: "pat1" }, effective: "2026-06-15", value: 1 }, {}, { ...CTX, applyDefaults: "required" });
  assert.equal(req.resource.status, "final");
});

test("derived: Condition.category from the encounter reference, Observation.category vital-signs from the R4 vital-sign codes", async () => {
  const withEnc = await compose(EX + "Cond", { code: { text: "x" }, subject: { ref: "pat1" }, encounter: { ref: "enc1" } });
  assert.deepEqual(withEnc.resource.category, [{ coding: [{ system: COND_CAT, code: "encounter-diagnosis", display: "Encounter Diagnosis" }] }]);
  assert.equal(withEnc.provenance["Condition.category[0]"], "derived");
  const noEnc = await compose(EX + "Cond", { code: { text: "x" }, subject: { ref: "pat1" } });
  assert.equal(noEnc.resource.category, undefined, "problem-list vs encounter cannot be known without an encounter");
  const model = await compose(EX + "Cond", { code: { text: "x" }, subject: { ref: "pat1" }, encounter: { ref: "enc1" }, category: { system: COND_CAT, code: "problem-list-item" } });
  assert.equal(model.resource.category[0].coding[0].code, "problem-list-item", "the model's category wins");
  assert.equal(model.provenance["Condition.category[0]"], "model");
  const hr = await compose(EX + "Vitals", { code: { system: LOINC, code: "8867-4" }, subject: { ref: "pat1" }, effective: "2026-06-15", value: "72 /min" });
  assert.deepEqual(hr.resource.category, [{ coding: [{ system: OBS_CAT, code: "vital-signs", display: "vital signs" }] }]);
  assert.equal(hr.provenance["Observation.category[0]"], "derived");
  const glu = await compose(EX + "Vitals", { code: { system: LOINC, code: "2345-7" }, subject: { ref: "pat1" }, effective: "2026-06-15", value: "95 mg/dL" });
  assert.equal(glu.resource.category, undefined, "laboratory is not derivable");
});

test("missing: required, slice, invariant-implied and target-implied values are reported with a reason — never invented", async () => {
  const out = await compose(EX + "LabObs", { code: { system: LOINC, code: "2345-7" } });
  assert.deepEqual(errorsOf(out), []);
  const by = Object.fromEntries(out.missing.map((m) => [m.field, m.why]));
  assert.equal(by.subject, "required by profile");
  assert.equal(by["effective[x]"], "required by profile");
  assert.match(by["value[x]"], /^required by invariant:obs-x/);
  assert.equal(by.status, undefined, "status got its default");
  assert.equal(by.category, undefined, "category got its slice pattern");
  assert.equal(out.resource.subject, undefined);
  assert.equal(out.resource.effectiveDateTime, undefined);
  assert.equal(out.resource.id, undefined);
  assert.ok(!JSON.stringify(out.resource).includes(String(new Date().getFullYear())), "no clock value leaks into the resource");
  const pat = await compose(EX + "Pat", { gender: "male" });
  const pb = Object.fromEntries(pat.missing.map((m) => [m.field, m.why]));
  assert.equal(pb.identifier, "required by profile");
  assert.equal(pb.birthDate, "required by profile");
  assert.equal(pb.name, "expected: patient name");
  const med = await compose(EX + "MedReq", { medication: { text: "x" }, subject: { ref: "pat1" } });
  assert.ok(med.missing.some((m) => m.field === "dosageInstruction.doseAndRate.dose[x]" && /^expected: dose/.test(m.why)), JSON.stringify(med.missing));
});

test("provenance covers every written path with the right origin; fieldMap resolves issue paths", async () => {
  const out = await compose(EX + "LabObs", { code: { system: LOINC, code: "2345-7" }, subject: { ref: "pat1" }, effective: "115/06/15", value: "95 mg/dL", note: "fasting" });
  const p = out.provenance;
  assert.equal(p["Observation.meta.profile[0]"], "fixed");
  assert.equal(p["Observation.status"], "default");
  assert.equal(p["Observation.category[0]"], "fixed");
  assert.equal(p["Observation.code"], "model");
  assert.equal(p["Observation.code.coding[0].display"], "lookup");
  assert.equal(p["Observation.subject"], "model");
  assert.equal(p["Observation.effectiveDateTime"], "model");
  assert.equal(p["Observation.valueQuantity"], "model");
  assert.equal(p["Observation.valueQuantity.code"], "lookup");
  assert.equal(p["Observation.note[0]"], "model");
  const allowed = new Set(["model", "fixed", "default", "derived", "lookup"]);
  for (const v of Object.values(p)) assert.ok(allowed.has(v));
  assert.equal(fieldForPath(out.fieldMap, "Observation.valueQuantity.value"), "value");
  assert.equal(fieldForPath(out.fieldMap, "Observation.status"), null, "a default has no model field");
  assert.equal(fieldForPath(out.fieldMap, "Observation.code.coding[0].system"), "code");
});

test("determinism: identical input and context give identical output; a different context changes only the urns", async () => {
  const fields = { status: "final", subject: { ref: "pat1" }, effective: "2026-06-15", component: [{ code: { system: LOINC, code: "8480-6" }, value: "120 mmHg" }, { code: { system: LOINC, code: "8462-4" }, value: "80 mmHg" }] };
  const a = await compose(EX + "BP", fields);
  const b = await compose(EX + "BP", fields);
  assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
  const c = await compose(EX + "BP", fields, {}, { ...CTX, contextId: "ffffffffffffffffffffffffffffffff" });
  assert.notEqual(c.resource.subject.reference, a.resource.subject.reference);
  const strip = (r: Record<string, any>): Record<string, any> => ({ ...r, subject: undefined });
  assert.deepEqual(strip(c.resource), strip(a.resource));
});

test("profile errors and field specs", async () => {
  await assert.rejects(compose("http://example.org/StructureDefinition/Nope", {}), (e: unknown) => e instanceof ComposeProfileError && e.code === "ARTIFACT_NOT_FOUND");
  await assert.rejects(composeResource({ key: "k", profile: "", fields: {} }, makeDeps(), CTX), (e: unknown) => e instanceof ComposeProfileError && e.code === "INVALID_ARGUMENT");
  const byId = await compose("BP", { status: "final", subject: { ref: "pat1" }, effective: "2026-06-15", component: [] });
  assert.equal(byId.profile.canonical, EX + "BP");
  const specs = fieldSpecsFromSnapshot(PATIENT);
  const names = specs.map((s) => s.field);
  assert.deepEqual(names, ["identifier", "identifier:mrn", "identifier:national", "active", "name", "name:official", "telecom", "gender", "birthDate", "deceased[x]", "address", "contact", "managingOrganization"]);
  assert.equal(specs.find((s) => s.field === "gender")!.required, true);
  assert.equal(specs.find((s) => s.field === "identifier")!.multiple, true);
});

test("performance: a warm compose of the blood pressure profile stays under 200 ms at p95", async () => {
  const fields = { status: "final", subject: { ref: "pat1" }, effective: "2026-06-15", component: [{ code: { system: LOINC, code: "8480-6" }, value: "120 mmHg" }, { code: { system: LOINC, code: "8462-4" }, value: "80 mmHg" }] };
  const deps = makeDeps();
  await compose(EX + "BP", fields, {}, CTX, deps);
  const times: number[] = [];
  for (let i = 0; i < 40; i++) {
    const t0 = performance.now();
    await compose(EX + "BP", fields, {}, CTX, deps);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const p95 = times[Math.floor(times.length * 0.95) - 1];
  assert.ok(p95 < 200, `p95 ${p95.toFixed(1)} ms`);
});

// --------------------------------------------------------------------------- //
// Extension slices (integration round, coordinator)
// --------------------------------------------------------------------------- //

test("extension slices: {value} / the bare value becomes {url, value[x]} typed by the extension definition; written FHIR JSON is kept", async () => {
  const EXT_SITE = sd(EX + "ext-site", "Extension", "complex-type", [
    el("Extension", 0, "*"),
    el("Extension.url", 1, "1", ["uri"], { fixedUri: EX + "ext-site" }),
    el("Extension.value[x]", 1, "1", ["CodeableConcept"]),
  ]);
  const EXT_ENC = sd(EX + "ext-enc", "Extension", "complex-type", [
    el("Extension", 0, "*"),
    el("Extension.url", 1, "1", ["uri"], { fixedUri: EX + "ext-enc" }),
    el("Extension.value[x]", 1, "1", [], { type: [{ code: "Reference", targetProfile: [CORE + "Encounter"] }] }),
  ]);
  const COND_EXT = sd(EX + "CondExt", "Condition", "resource", [
    el("Condition", 0, "*"),
    ...domainEls("Condition"),
    el("Condition.extension:site", 0, "1", [], { type: [{ code: "Extension", profile: [EX + "ext-site"] }], baseMax: "*", sliceName: "site" }),
    el("Condition.extension:enc", 0, "1", [], { type: [{ code: "Extension", profile: [EX + "ext-enc"] }], baseMax: "*", sliceName: "enc" }),
    el("Condition.code", 1, "1", ["CodeableConcept"]),
    ref("Condition.subject", 1, "1", ["Patient"]),
  ]);
  const profiles = { [EX + "CondExt"]: COND_EXT, [EX + "ext-site"]: EXT_SITE, [EX + "ext-enc"]: EXT_ENC };
  const deps: ComposeDeps = { ...makeDeps({ profiles }), fetchStructureDefinition: async (url) => profiles[url.split("|")[0]] ?? null };
  const out = await compose(EX + "CondExt", {
    code: { system: SCT, code: "44054006" },
    subject: { ref: "pat1" },
    "extension:site": { value: { system: SCT, code: "368209003", display: "Right arm" } },
    "extension:enc": { ref: "enc1" },
  }, {}, CTX, deps);
  assert.deepEqual(errorsOf(out), []);
  const ext = out.resource.extension as Array<Record<string, unknown>>;
  assert.equal(ext.length, 2);
  assert.deepEqual(ext[0], { url: EX + "ext-site", valueCodeableConcept: { coding: [{ system: SCT, code: "368209003", display: "Right arm" }] } });
  assert.deepEqual(ext[1], { url: EX + "ext-enc", valueReference: { reference: keyToUrn(CTX.contextId, "enc1") } });
  assert.ok(out.refs.resolved.includes("enc1"));
  // written as FHIR JSON → kept; a non-object → error naming the field
  const asJson = await compose(EX + "CondExt", { code: { system: SCT, code: "44054006" }, subject: { ref: "pat1" }, "extension:site": { url: EX + "ext-site", valueString: "x" } }, {}, CTX, deps);
  assert.deepEqual((asJson.resource.extension as unknown[])[0], { url: EX + "ext-site", valueString: "x" });
  const bad = await compose(EX + "CondExt", { code: { system: SCT, code: "44054006" }, subject: { ref: "pat1" }, "extension:site": "right arm" }, {}, CTX, deps);
  assert.ok(errorsOf(bad).some((e) => e.startsWith("extension:site:")), errorsOf(bad).join("; "));
});

function domainEls(t: string): El[] {
  return [el(`${t}.id`, 0, "1", ["string"]), el(`${t}.meta`, 0, "1", ["Meta"]), el(`${t}.text`, 0, "1", ["Narrative"]), el(`${t}.extension`, 0, "*", ["Extension"])];
}

// --------------------------------------------------------------------------- //
// v1.1: displays derived from the code, single values wrapped into arrays
// --------------------------------------------------------------------------- //

const CRP = "C reactive protein [Mass/volume] in Serum or Plasma";
/** Valid displays per system|code, as the validator's terminology rule would judge them (case-insensitive match). */
const VALID_DISPLAYS: Record<string, string[]> = {
  [`${LOINC}|1988-5`]: [CRP, "CRP SerPl-mCnc"],
  [`${LOINC}|2345-7`]: ["Glucose [Mass/volume] in Serum or Plasma"],
  [`${V2_0203}|MR`]: ["Medical record number"],
};

function displayDeps(calls?: string[]): ComposeDeps {
  const base = makeDeps({ calls });
  return {
    ...base,
    async lookupDisplay(system, code) {
      if (system === LOINC && code === "1988-5") return CRP;
      return base.lookupDisplay!(system, code);
    },
    // v1.4 (ISSUES_v14 R1): the display is searched in the code's system to tell a different spelling
    // of the same concept from a different concept (fhirRepair/displays.ts).
    async normalize(text, target) {
      calls?.push(`normalize ${text}`);
      const hits: Record<string, Array<{ system: string; code: string; display: string; exact?: boolean }>> = {
        [`${LOINC}|CRP`]: [{ system: LOINC, code: "1988-5", display: CRP, exact: true }, { system: LOINC, code: "30522-7", display: "C reactive protein [Mass/volume] in Serum or Plasma by High sensitivity method" }],
        [`${LOINC}|Creatinine`]: [{ system: LOINC, code: "2160-0", display: "Creatinine [Mass/volume] in Serum or Plasma", exact: true }, { system: LOINC, code: "2345-7", display: "Glucose [Mass/volume] in Serum or Plasma" }],
        [`${V2_0203}|chart no`]: [{ system: V2_0203, code: "MR", display: "Medical record number", exact: true }],
      };
      return (hits[`${target.system}|${text}`] ?? []).map((h) => ({ ...h }));
    },
    async checkDisplay(system, code, display) {
      calls?.push(`check ${system}|${code}`);
      const valid = VALID_DISPLAYS[`${system}|${code}`];
      if (!valid) return { status: "unknown", valid: [] };
      return valid.some((d) => d.toLowerCase() === display.toLowerCase()) ? { status: "ok", valid: [] } : { status: "invalid-display", valid };
    },
  };
}

const LAB_BASE = { status: "final", subject: { ref: "pat1" }, effective: "2026-06-15", value: "5 mg/L" };

test("display: a model display the terminology rejects is replaced by the code's display; the model text moves to CodeableConcept.text", async () => {
  const out = await compose(EX + "LabObs", { ...LAB_BASE, code: { system: LOINC, code: "1988-5", display: "CRP" } }, {}, CTX, displayDeps());
  assert.deepEqual(errorsOf(out), []);
  assert.deepEqual(out.resource.code, { coding: [{ system: LOINC, code: "1988-5", display: CRP }], text: "CRP" }, "code / system untouched, display canonical, wording kept as text");
  assert.equal(out.provenance["Observation.code.coding[0].display"], "lookup");
  assert.equal(out.provenance["Observation.code.text"], "model");
  assert.deepEqual(out.notes, ["display replaced for code (was 'CRP')"]);
  // an existing text is never overwritten
  const withText = await compose(EX + "LabObs", { ...LAB_BASE, code: { coding: [{ system: LOINC, code: "1988-5", display: "CRP" }], text: "C-reactive protein" } }, {}, CTX, displayDeps());
  assert.deepEqual(withText.resource.code, { coding: [{ system: LOINC, code: "1988-5", display: CRP }], text: "C-reactive protein" });
  assert.equal(withText.notes.length, 1);
  // a valid display (case-insensitive) is kept as written, no note
  const caseOnly = await compose(EX + "LabObs", { ...LAB_BASE, code: { system: LOINC, code: "1988-5", display: "crp serpl-mcnc" } }, {}, CTX, displayDeps());
  assert.equal(caseOnly.resource.code.coding[0].display, "crp serpl-mcnc");
  assert.equal(caseOnly.resource.code.text, undefined);
  assert.deepEqual(caseOnly.notes, []);
  assert.equal(caseOnly.provenance["Observation.code.coding[0].display"], undefined);
  // whitespace-only difference: the valid spelling, silently (the same display)
  const ws = await compose(EX + "LabObs", { ...LAB_BASE, code: { system: LOINC, code: "1988-5", display: " C reactive  protein [Mass/volume] in Serum or Plasma" } }, {}, CTX, displayDeps());
  assert.equal(ws.resource.code.coding[0].display, CRP);
  assert.equal(ws.resource.code.text, undefined);
  assert.deepEqual(ws.notes, []);
  // an unresolvable code keeps the model display (validation reports the unknown code)
  const unknown = await compose(EX + "LabObs", { ...LAB_BASE, code: { system: LOINC, code: "99999-9", display: "CRP" } }, {}, CTX, displayDeps());
  assert.deepEqual(unknown.resource.code, { coding: [{ system: LOINC, code: "99999-9", display: "CRP" }] });
  assert.deepEqual(unknown.notes, []);
  // without the collaborator nothing changes
  const plain = await compose(EX + "LabObs", { ...LAB_BASE, code: { system: LOINC, code: "1988-5", display: "CRP" } });
  assert.equal(plain.resource.code.coding[0].display, "CRP");
  assert.deepEqual(plain.notes, []);
});

test("display (v1.4 R1): a display naming a DIFFERENT concept is kept, with the codes it denotes as candidates (warning)", async () => {
  const out = await compose(EX + "LabObs", { ...LAB_BASE, code: { system: LOINC, code: "2345-7", display: "Creatinine" } }, {}, CTX, displayDeps());
  assert.deepEqual(out.resource.code, { coding: [{ system: LOINC, code: "2345-7", display: "Creatinine" }] }, "display, code and text untouched");
  assert.deepEqual(out.notes, []);
  const w = out.errors.find((e) => e.path === "Observation.code.coding[0].display");
  assert.ok(w && w.severity === "warning" && /NOT replaced/.test(w.message), JSON.stringify(out.errors));
  assert.deepEqual((w!.candidates as any[]).map((c) => c.code), ["2160-0"]);
  // no terminology search available: undecidable → kept (never replaced on a guess)
  const d = displayDeps();
  delete d.normalize;
  const noSearch = await compose(EX + "LabObs", { ...LAB_BASE, code: { system: LOINC, code: "1988-5", display: "CRP" } }, {}, CTX, d);
  assert.equal(noSearch.resource.code.coding[0].display, "CRP");
  // a different spelling of a valid display (word order / punctuation) needs no search
  const reordered = await compose(EX + "LabObs", { ...LAB_BASE, code: { system: LOINC, code: "1988-5", display: "SerPl-mCnc CRP" } }, {}, CTX, d);
  assert.equal(reordered.resource.code.coding[0].display, CRP);
});

test("display: several codings, identifier type codings, looked-up and profile-pinned displays are not re-checked", async () => {
  const calls: string[] = [];
  const out = await compose(
    EX + "LabObs",
    { ...LAB_BASE, code: [{ system: LOINC, code: "1988-5", display: "CRP" }, { system: LOINC, code: "2345-7" }, { system: "http://h.example/local", code: "CRP", display: "CRP (local)" }] },
    {},
    CTX,
    displayDeps(calls),
  );
  assert.equal(out.resource.code.coding[0].display, CRP);
  assert.equal(out.resource.code.text, "CRP");
  assert.equal(out.resource.code.coding[1].display, "Glucose [Mass/volume] in Serum or Plasma", "looked up (no model display)");
  assert.equal(out.resource.code.coding[2].display, "CRP (local)", "unknown local code: kept");
  assert.ok(!calls.includes(`check ${LOINC}|2345-7`), "a display the MCP looked up is not checked");
  assert.ok(!calls.some((c) => c.startsWith("check ") && c.includes(OBS_CAT)), "the category pattern created from the profile is not checked");
  // a display the profile pins (pattern) is the profile's, never replaced
  const pinned = sd(EX + "CrpObs", "Observation", "resource", [
    el("Observation", 0, "*"),
    ...domain("Observation"),
    el("Observation.status", 1, "1", ["code"]),
    el("Observation.code", 1, "1", ["CodeableConcept"], { patternCodeableConcept: { coding: [{ system: LOINC, code: "1988-5", display: "CRP" }] } }),
  ]);
  const pinCalls: string[] = [];
  const pinDeps = { ...displayDeps(pinCalls), resolveProfile: makeDeps({ profiles: { [EX + "CrpObs"]: pinned } }).resolveProfile };
  const pinOut = await compose(EX + "CrpObs", { status: "final" }, {}, CTX, pinDeps);
  assert.deepEqual(pinOut.resource.code, { coding: [{ system: LOINC, code: "1988-5", display: "CRP" }] });
  assert.deepEqual(pinOut.notes, []);
  assert.ok(!pinCalls.some((c) => c.startsWith("check ")), JSON.stringify(pinCalls));
  const pat = await compose(EX + "Pat", { identifier: { value: "1", system: "http://h.example/mrn", type: { coding: [{ system: V2_0203, code: "MR", display: "chart no" }] } }, gender: "male", birthDate: "1990-01-01" }, {}, CTX, displayDeps());
  assert.deepEqual(pat.resource.identifier[0].type, { coding: [{ system: V2_0203, code: "MR", display: "Medical record number" }], text: "chart no" });
  assert.deepEqual(pat.notes, ["display replaced for identifier (was 'chart no')"]);
});

test("arrays: a single Coding object under CodeableConcept.coding is wrapped (value grammar and nested FHIR shapes), with a note", async () => {
  const out = await compose(EX + "LabObs", { ...LAB_BASE, code: { coding: { system: LOINC, code: "2345-7" } } });
  assert.deepEqual(errorsOf(out), []);
  assert.deepEqual(out.resource.code, { coding: [{ system: LOINC, code: "2345-7", display: "Glucose [Mass/volume] in Serum or Plasma" }] });
  assert.deepEqual(out.notes, ["wrapped Observation.code.coding into an array"]);
  assert.equal(out.provenance["Observation.code"], "model");
  const vit = await compose(EX + "Vitals", { status: "final", code: { coding: { system: LOINC, code: "8867-4" } }, category: { coding: { system: OBS_CAT, code: "vital-signs" } }, subject: { ref: "pat1" }, effective: "2026-06-15", value: "72 /min" });
  assert.deepEqual(errorsOf(vit), []);
  assert.ok(Array.isArray(vit.resource.category) && Array.isArray(vit.resource.category[0].coding), JSON.stringify(vit.resource.category));
  assert.equal(vit.resource.category[0].coding[0].code, "vital-signs");
  assert.ok(vit.notes.includes("wrapped Observation.category[0].coding into an array") && vit.notes.includes("wrapped Observation.code.coding into an array"), JSON.stringify(vit.notes));
  // inside an identifier: type {coding: {...}} still selects the identifier slice
  const pat = await compose(EX + "Pat", { identifier: { value: "M1", system: "http://h.example/mrn", type: { coding: { system: V2_0203, code: "MR" } } }, gender: "male", birthDate: "1990-01-01" });
  assert.deepEqual(errorsOf(pat), []);
  assert.equal(pat.resource.identifier[0].type.coding[0].code, "MR");
  assert.equal(pat.resource.identifier[0].use, "official", "assigned to the mrn slice: its pattern applies");
  assert.ok(pat.notes.includes("wrapped Patient.identifier[0].type.coding into an array"), JSON.stringify(pat.notes));
});

test("arrays: a repeating element given one object inside a nested FHIR shape is wrapped at any depth; top-level single values need no note", async () => {
  const out = await compose(EX + "Pat", {
    identifier: { value: "1", system: "http://h.example/mrn" },
    gender: "male",
    birthDate: "1990-01-01",
    contact: { telecom: { system: "phone", value: "0912" }, relationship: { coding: { system: "http://terminology.hl7.org/CodeSystem/v2-0131", code: "N" } } },
  });
  assert.deepEqual(errorsOf(out), []);
  assert.deepEqual(out.resource.contact, [{ telecom: [{ system: "phone", value: "0912" }], relationship: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/v2-0131", code: "N" }] }] }]);
  assert.deepEqual(
    [...out.notes].sort(),
    ["wrapped Patient.contact[0].relationship into an array", "wrapped Patient.contact[0].relationship[0].coding into an array", "wrapped Patient.contact[0].telecom into an array"],
  );
  assert.ok(!out.notes.some((n) => /Patient\.identifier into/.test(n)), "one identifier at the top level is the documented grammar");
  // raw FHIR JSON kept as written (an extension with its url): nested repeating keys are wrapped too
  const ext = await compose(EX + "LabObs", { ...LAB_BASE, code: { system: LOINC, code: "2345-7" }, extension: { url: "http://h.example/ext", extension: { url: "part", valueString: "x" } } });
  assert.deepEqual(errorsOf(ext), []);
  assert.deepEqual(ext.resource.extension, [{ url: "http://h.example/ext", extension: [{ url: "part", valueString: "x" }] }]);
  assert.ok(ext.notes.includes("wrapped Observation.extension[0].extension into an array"), JSON.stringify(ext.notes));
  // dosage doseAndRate written as one object
  const med = await compose(EX + "MedReq", { status: "active", intent: "order", medication: { text: "x" }, subject: { ref: "pat1" }, dosageInstruction: { text: "1 tab", doseAndRate: { doseQuantity: { value: 1, unit: "tablet" } } } });
  assert.deepEqual(errorsOf(med), []);
  assert.deepEqual(med.resource.dosageInstruction[0].doseAndRate, [{ doseQuantity: { value: 1, unit: "tablet" } }]);
  assert.ok(med.notes.includes("wrapped MedicationRequest.dosageInstruction[0].doseAndRate into an array"), JSON.stringify(med.notes));
});
