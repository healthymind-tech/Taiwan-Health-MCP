/**
 * Synthetic error fixtures for the suggestion layer, one category per R1 row. Every
 * resource is hand-written (no clinical record text). `expect` lists the acceptable
 * first-suggestion values (`suffix: true` → the value must end with one of them, used for
 * move targets that carry the full instance path; reference_chain → the first caused_by
 * path must start with one of them).
 */

export interface Fixture {
  id: string;
  category: "choice_type" | "ucum" | "unknown_url" | "unrecognized_property" | "binding" | "unknown_code" | "wrong_display" | "reference_chain";
  resource: Record<string, any>;
  profile?: string;
  expect: string[];
  suffix?: boolean;
  /** When set, the first suggestion must also be of this kind (remove_property / move_property ...). */
  kind?: string;
  /** Sub-category for the per-kind breakdown (unrecognized_property: prop/rename, prop/move, prop/shape-rename, prop/shape-move, prop/remove). */
  sub?: string;
}

const UCUM = "http://unitsofmeasure.org";
const LOINC = "http://loinc.org";
const SCT = "http://snomed.info/sct";
const ICD = "http://hl7.org/fhir/sid/icd-10-cm";
const THO = "http://terminology.hl7.org/CodeSystem/";
const TW = "https://twcore.mohw.gov.tw/ig/twcore/StructureDefinition/";

function obs(extra: Record<string, any> = {}): Record<string, any> {
  return {
    resourceType: "Observation",
    status: "final",
    code: { coding: [{ system: LOINC, code: "8867-4", display: "Heart rate" }] },
    subject: { reference: "Patient/p1" },
    ...extra,
  };
}

function qty(code: string, unit = code): Record<string, any> {
  return obs({ valueQuantity: { value: 1, unit, system: UCUM, code } });
}

function medReq(dosage: Record<string, any>, extra: Record<string, any> = {}): Record<string, any> {
  return {
    resourceType: "MedicationRequest",
    status: "active",
    intent: "order",
    medicationCodeableConcept: { text: "Drug A 500 mg tablet" },
    subject: { reference: "Patient/p1" },
    dosageInstruction: [dosage],
    ...extra,
  };
}

function dose(code: string): Record<string, any> {
  return medReq({ text: "1 per day", doseAndRate: [{ doseQuantity: { value: 1, unit: code, system: UCUM, code } }] });
}

function coded(system: string, code: string, display?: string, text?: string): Record<string, any> {
  return obs({ category: [{ coding: [{ system, code, ...(display ? { display } : {}) }], ...(text ? { text } : {}) }] });
}

function codeOf(system: string, code: string, display?: string): Record<string, any> {
  return obs({ code: { coding: [{ system, code, ...(display ? { display } : {}) }] } });
}

function cond(coding: Record<string, any>): Record<string, any> {
  return { resourceType: "Condition", subject: { reference: "Patient/p1" }, code: { coding: [coding] } };
}

function enc(classCoding: Record<string, any>): Record<string, any> {
  return { resourceType: "Encounter", status: "finished", class: classCoding, subject: { reference: "Patient/p1" } };
}


function pat(extra: Record<string, any> = {}): Record<string, any> {
  return { resourceType: "Patient", name: [{ family: "Chen", given: ["A"] }], ...extra };
}

function proc(extra: Record<string, any> = {}): Record<string, any> {
  return { resourceType: "Procedure", status: "completed", subject: { reference: "Patient/p1" }, ...extra };
}

function allergy(extra: Record<string, any> = {}): Record<string, any> {
  return { resourceType: "AllergyIntolerance", patient: { reference: "Patient/p1" }, ...extra };
}

const AMB = { system: THO + "v3-ActCode", code: "AMB" };
const P = "unrecognized_property" as const;
const MOVE = "move_property";
const RENAME = "rename_property";
const REMOVE = "remove_property";

function encX(extra: Record<string, any> = {}): Record<string, any> {
  return { ...enc(AMB), ...extra };
}

export const FIXTURES: Fixture[] = [
  // --- UCUM ----------------------------------------------------------------
  { id: "ucum-ui-ml", category: "ucum", resource: qty("[UI]/mL"), expect: ["[iU]/mL", "[IU]/mL"] },
  { id: "ucum-tab", category: "ucum", resource: dose("tab"), expect: ["{tablet}"] },
  { id: "ucum-U-bracket", category: "ucum", resource: dose("[U]"), expect: ["U"] },
  { id: "ucum-mcg", category: "ucum", resource: qty("mcg"), expect: ["ug"] },
  { id: "ucum-mmHg", category: "ucum", resource: qty("mmHg"), expect: ["mm[Hg]"] },
  { id: "ucum-IU-ml", category: "ucum", resource: qty("IU/mL"), expect: ["[iU]/mL", "[IU]/mL"] },
  { id: "ucum-hr", category: "ucum", resource: qty("/hr"), expect: ["/h"] },
  { id: "ucum-degC", category: "ucum", resource: qty("degC"), expect: ["Cel"] },
  { id: "ucum-mEq", category: "ucum", resource: qty("mEq/L"), expect: ["meq/L"] },
  { id: "ucum-cc", category: "ucum", resource: dose("cc"), expect: ["mL"] },
  { id: "ucum-bpm", category: "ucum", resource: qty("bpm"), expect: ["/min"] },
  { id: "ucum-caret", category: "ucum", resource: qty("kg/m^2"), expect: ["kg/m2"] },
  { id: "ucum-puff", category: "ucum", resource: dose("puff"), expect: ["{puff}"] },
  { id: "ucum-units", category: "ucum", resource: dose("Units"), expect: ["U"] },
  { id: "ucum-capsule", category: "ucum", resource: dose("capsule"), expect: ["{capsule}"] },
  { id: "ucum-space", category: "ucum", resource: qty("mg /dL"), expect: ["mg/dL"] },
  { id: "ucum-times-day", category: "ucum", resource: qty("times/day"), expect: ["/d"] },
  { id: "ucum-drops", category: "ucum", resource: dose("drops"), expect: ["[drp]"] },

  // --- Unknown URL / system --------------------------------------------------
  { id: "url-vs-tail", category: "unknown_url", resource: enc({ system: THO + "v3-ActEncounterCode", code: "AMB" }), expect: [THO + "v3-ActCode"] },
  { id: "url-r2-style", category: "unknown_url", resource: enc({ system: "http://hl7.org/fhir/v3/ActCode", code: "AMB" }), expect: [THO + "v3-ActCode"] },
  { id: "url-plural", category: "unknown_url", resource: coded(THO + "observation-categories", "vital-signs"), expect: [THO + "observation-category"] },
  { id: "url-condition-clinical", category: "unknown_url", resource: { ...cond({ system: SCT, code: "44054006" }), clinicalStatus: { coding: [{ system: THO + "condition-clinical-status", code: "active" }] } }, expect: [THO + "condition-clinical"] },
  { id: "url-v2-0203", category: "unknown_url", resource: { resourceType: "Patient", identifier: [{ type: { coding: [{ system: THO + "v2-203", code: "MR" }] }, system: "urn:oid:2.16.886.101.20003.20001", value: "1" }] }, expect: [THO + "v2-0203"] },
  { id: "url-vs-as-system", category: "unknown_url", resource: coded("http://hl7.org/fhir/ValueSet/observation-category", "vital-signs"), expect: [THO + "observation-category"] },
  { id: "url-allergy", category: "unknown_url", resource: { resourceType: "AllergyIntolerance", patient: { reference: "Patient/p1" }, clinicalStatus: { coding: [{ system: THO + "allergy-intolerance-clinical", code: "active" }] } }, expect: [THO + "allergyintolerance-clinical"] },
  { id: "url-medreq-category", category: "unknown_url", resource: medReq({ text: "x" }, { category: [{ coding: [{ system: THO + "medication-request-category", code: "outpatient" }] }] }), expect: [THO + "medicationrequest-category"] },
  { id: "url-ver-status", category: "unknown_url", resource: { ...cond({ system: SCT, code: "44054006" }), verificationStatus: { coding: [{ system: THO + "condition-verification-status", code: "confirmed" }] } }, expect: [THO + "condition-ver-status"] },
  { id: "url-dose-rate-type", category: "unknown_url", resource: medReq({ text: "x", doseAndRate: [{ type: { coding: [{ system: THO + "dose-rate-types", code: "ordered" }] } }] }), expect: [THO + "dose-rate-type"] },

  // --- Unrecognized property -------------------------------------------------
  { id: "prop-periodUnits", category: "unrecognized_property", sub: "prop/rename", resource: medReq({ text: "x", timing: { repeat: { frequency: 1, period: 1, periodUnits: "d" } } }), expect: ["periodUnit"] },
  { id: "prop-periodUnit-level", category: "unrecognized_property", sub: "prop/move", resource: medReq({ text: "x", timing: { repeat: { frequency: 1, period: 1 }, periodUnit: "d" } }), expect: ["timing.repeat.periodUnit"], suffix: true },
  { id: "prop-doseQuantity-level", category: "unrecognized_property", sub: "prop/move", resource: medReq({ text: "x", doseQuantity: { value: 1, unit: "mg", system: UCUM, code: "mg" } }), expect: ["doseAndRate[0].doseQuantity"], suffix: true },
  { id: "prop-typo", category: "unrecognized_property", sub: "prop/rename", resource: obs({ valueQuantiy: { value: 1 } }), expect: ["valueQuantity"] },
  { id: "prop-case", category: "unrecognized_property", sub: "prop/rename", resource: (({ status, ...o }) => ({ ...o, Status: "final" }))(obs()), expect: ["status"] },
  { id: "prop-choice-stem", category: "unrecognized_property", sub: "prop/rename", resource: obs({ value: { value: 72, unit: "/min", system: UCUM, code: "/min" } }), expect: ["valueQuantity"] },
  { id: "prop-birthdate", category: "unrecognized_property", sub: "prop/rename", resource: { resourceType: "Patient", birthdate: "1990-01-01" }, expect: ["birthDate"] },
  { id: "prop-onsetDate", category: "choice_type", resource: { ...cond({ system: SCT, code: "44054006" }), onsetDate: "2020-01-01" }, expect: ["onsetDateTime"] },
  { id: "prop-effectiveDate", category: "choice_type", resource: obs({ effectiveDate: "2020-01-01" }), expect: ["effectiveDateTime"] },
  { id: "prop-medication-stem", category: "unrecognized_property", sub: "prop/rename", resource: { ...medReq({ text: "x" }), medicationCodeableConcept: undefined, medication: { reference: "Medication/m1" } }, expect: ["medicationReference"] },
  { id: "prop-coding-Code", category: "unrecognized_property", sub: "prop/rename", resource: obs({ code: { coding: [{ system: LOINC, Code: "8867-4" }] } }), expect: ["code"] },
  { id: "prop-snake", category: "unrecognized_property", sub: "prop/rename", resource: medReq({ text: "x", timing: { repeat: { duration: 1, duration_unit: "h" } } }), expect: ["durationUnit"] },
  { id: "prop-familyName", category: "unrecognized_property", sub: "prop/rename", resource: { resourceType: "Patient", name: [{ familyName: "Chen" }] }, expect: ["family"] },
  { id: "prop-route-level", category: "unrecognized_property", sub: "prop/move", resource: medReq({ text: "x", timing: { route: { text: "oral" } } }), expect: ["dosageInstruction[0].route"], suffix: true },


  // --- Unrecognized property: move (the name lives at another level of this resource) -------
  { id: "mv-note-in-dosage", category: P, sub: "prop/move", kind: MOVE, resource: medReq({ text: "x", note: [{ text: "n" }] }), expect: ["MedicationRequest.note"], suffix: true },
  { id: "mv-reasonCode-in-diagnosis", category: P, sub: "prop/move", kind: MOVE, resource: encX({ diagnosis: [{ condition: { reference: "Condition/c1" }, reasonCode: [{ text: "x" }] }] }) , expect: ["Encounter.reasonCode"], suffix: true },
  { id: "mv-family-root", category: P, sub: "prop/move", kind: MOVE, resource: { resourceType: "Patient", family: "Chen" }, expect: ["name[0].family"], suffix: true },
  { id: "mv-city-root", category: P, sub: "prop/move", kind: MOVE, resource: pat({ city: "Taipei" }), expect: ["address[0].city"], suffix: true },
  { id: "mv-unit-root-choice-present", category: P, sub: "prop/move", kind: MOVE, resource: obs({ valueQuantity: { value: 1 }, unit: "mg" }), expect: ["valueQuantity.unit"], suffix: true },
  { id: "mv-severity-allergy", category: P, sub: "prop/move", kind: MOVE, resource: allergy({ severity: "severe" }), expect: ["reaction[0].severity"], suffix: true },
  { id: "mv-start-encounter", category: P, sub: "prop/move", kind: MOVE, resource: encX({ start: "2020-01-01" }), expect: ["Encounter.period.start"], suffix: true },
  { id: "mv-timing-in-doseAndRate", category: P, sub: "prop/move", kind: MOVE, resource: medReq({ doseAndRate: [{ doseQuantity: { value: 1 }, timing: { repeat: { frequency: 1 } } }] }), expect: ["dosageInstruction[0].timing"], suffix: true },
  { id: "mv-birthDate-in-name", category: P, sub: "prop/move", kind: MOVE, resource: pat({ name: [{ family: "Chen", birthDate: "1990-01-01" }] }), expect: ["Patient.birthDate"], suffix: true },
  { id: "mv-city-in-telecom", category: P, sub: "prop/move", kind: MOVE, resource: pat({ telecom: [{ system: "phone", value: "1", city: "Taipei" }] }), expect: ["address[0].city"], suffix: true },
  { id: "mv-dose-root", category: P, sub: "prop/move", kind: MOVE, resource: medReq({ text: "x" }, { dose: { value: 1, unit: "mg" } }), expect: ["doseAndRate[0].doseQuantity"], suffix: true },
  { id: "mv-class-in-hospitalization", category: P, sub: "prop/move", kind: MOVE, resource: { resourceType: "Encounter", status: "finished", hospitalization: { class: AMB } }, expect: ["Encounter.class"], suffix: true },
  { id: "mv-clinicalStatus-in-code", category: P, sub: "prop/move", kind: MOVE, resource: { resourceType: "Condition", subject: { reference: "Patient/p1" }, code: { coding: [{ system: SCT, code: "44054006" }], clinicalStatus: { coding: [{ system: THO + "condition-clinical", code: "active" }] } } }, expect: ["Condition.clinicalStatus"], suffix: true },
  { id: "mv-authoredOn-in-dosage", category: P, sub: "prop/move", kind: MOVE, resource: medReq({ text: "x", authoredOn: "2020-01-01" }), expect: ["MedicationRequest.authoredOn"], suffix: true },

  // --- Unrecognized property: value-shape / synonym rename -----------------------------------
  { id: "sr-every-period", category: P, sub: "prop/shape-rename", kind: RENAME, resource: medReq({ timing: { repeat: { frequency: 1, periodUnit: "h", every: 8 } } }), expect: ["period"] },
  { id: "sr-upperLimit-high", category: P, sub: "prop/shape-rename", kind: RENAME, resource: obs({ valueRange: { low: { value: 1, unit: "mg" }, upperLimit: { value: 5, unit: "mg" } } }), expect: ["high"] },
  { id: "sr-comment-note", category: P, sub: "prop/shape-rename", kind: RENAME, resource: obs({ comment: "text" }), expect: ["note"] },
  { id: "sr-sex-gender", category: P, sub: "prop/shape-rename", kind: RENAME, resource: pat({ sex: "male" }), expect: ["gender"] },
  { id: "sr-dob-birthDate", category: P, sub: "prop/shape-rename", kind: RENAME, resource: pat({ dob: "1990-01-01" }), expect: ["birthDate"] },
  { id: "sr-surname-family", category: P, sub: "prop/shape-rename", kind: RENAME, resource: { resourceType: "Patient", name: [{ surname: "Chen" }] }, expect: ["family"] },
  { id: "sr-firstName-given", category: P, sub: "prop/shape-rename", kind: RENAME, resource: { resourceType: "Patient", name: [{ family: "Chen", firstName: "A" }] }, expect: ["given"] },
  { id: "sr-phone-telecom", category: P, sub: "prop/shape-rename", kind: RENAME, resource: pat({ phone: "02-1234" }), expect: ["telecom"] },
  { id: "sr-prescriber-requester", category: P, sub: "prop/shape-rename", kind: RENAME, resource: medReq({ text: "x" }, { prescriber: { reference: "Practitioner/x" } }), expect: ["requester"] },
  { id: "sr-interval-period", category: P, sub: "prop/shape-rename", kind: RENAME, resource: medReq({ timing: { repeat: { periodUnit: "h", interval: 6 } } }), expect: ["period"] },
  { id: "sr-result-value", category: P, sub: "prop/shape-rename", kind: RENAME, resource: obs({ result: 5 }), expect: ["valueInteger", "valueQuantity"] },
  { id: "sr-from-start", category: P, sub: "prop/shape-rename", kind: RENAME, resource: encX({ period: { from: "2020-01-01", end: "2020-01-02" } }), expect: ["start"] },
  { id: "sr-uom-unit", category: P, sub: "prop/shape-rename", kind: RENAME, resource: obs({ valueQuantity: { value: 1, uom: "mg" } }), expect: ["unit"] },
  { id: "sr-kind-type", category: P, sub: "prop/shape-rename", kind: RENAME, resource: encX({ kind: [{ text: "consult" }] }), expect: ["type"] },
  { id: "sr-comment-in-dosage", category: P, sub: "prop/shape-move", kind: MOVE, resource: medReq({ text: "x", comment: "with food" }), expect: ["MedicationRequest.note"], suffix: true },
  { id: "sr-notes-in-stage", category: P, sub: "prop/shape-move", kind: MOVE, resource: { ...cond({ system: SCT, code: "44054006" }), stage: [{ summary: { text: "II" }, notes: "x" }] }, expect: ["Condition.note"], suffix: true },

  // --- Unrecognized property: remove (the name exists nowhere plausible) ---------------------
  { id: "rm-note-patient", category: P, sub: "prop/remove", kind: REMOVE, resource: pat({ note: "follow up" }), expect: ["note"] },
  { id: "rm-reasonCode-observation", category: P, sub: "prop/remove", kind: REMOVE, resource: obs({ reasonCode: [{ text: "x" }] }), expect: ["reasonCode"] },
  { id: "rm-foo-observation", category: P, sub: "prop/remove", kind: REMOVE, resource: obs({ foo: 1 }), expect: ["foo"] },
  { id: "rm-priority-condition", category: P, sub: "prop/remove", kind: REMOVE, resource: { ...cond({ system: SCT, code: "44054006" }), priority: "high" }, expect: ["priority"] },
  { id: "rm-age-patient", category: P, sub: "prop/remove", kind: REMOVE, resource: pat({ age: 30 }), expect: ["age"] },
  { id: "rm-weight-patient", category: P, sub: "prop/remove", kind: REMOVE, resource: pat({ weight: 70 }), expect: ["weight"] },
  { id: "rm-every-encounter", category: P, sub: "prop/remove", kind: REMOVE, resource: encX({ every: 2 }), expect: ["every"] },
  { id: "rm-bed-location", category: P, sub: "prop/remove", kind: REMOVE, resource: encX({ location: [{ location: { reference: "Location/l1" }, bed: "12A" }] }), expect: ["bed"] },
  { id: "rm-anesthesia-procedure", category: P, sub: "prop/remove", kind: REMOVE, resource: proc({ anesthesia: "general" }), expect: ["anesthesia"] },
  { id: "rm-mrn-identifier", category: P, sub: "prop/remove", kind: REMOVE, resource: pat({ identifier: [{ system: "urn:x", mrn: "1" }] }), expect: ["mrn"] },
  { id: "rm-units-observation", category: P, sub: "prop/remove", kind: REMOVE, resource: obs({ units: "mg" }), expect: ["units"] },
  { id: "rm-labName-observation", category: P, sub: "prop/remove", kind: REMOVE, resource: obs({ labName: "Lab A" }), expect: ["labName"] },

  // --- Required / extensible binding -----------------------------------------
  { id: "bind-case", category: "binding", resource: { ...obs(), status: "Final" }, expect: ["final"] },
  { id: "bind-gender-M", category: "binding", resource: { resourceType: "Patient", gender: "M" }, expect: ["male"] },
  { id: "bind-gender-Male", category: "binding", resource: { resourceType: "Patient", gender: "Male" }, expect: ["male"] },
  { id: "bind-intent", category: "binding", resource: { ...medReq({ text: "x" }), intent: "orders" }, expect: ["order"] },
  { id: "bind-mr-status", category: "binding", resource: { ...medReq({ text: "x" }), status: "Active" }, expect: ["active"] },
  { id: "bind-enc-status", category: "binding", resource: { ...enc({ system: THO + "v3-ActCode", code: "AMB" }), status: "finish" }, expect: ["finished"] },
  { id: "bind-criticality", category: "binding", resource: { resourceType: "AllergyIntolerance", patient: { reference: "Patient/p1" }, criticality: "High" }, expect: ["high"] },
  { id: "bind-imm-status", category: "binding", resource: { resourceType: "Immunization", status: "complete", vaccineCode: { text: "x" }, patient: { reference: "Patient/p1" }, occurrenceDateTime: "2020-01-01" }, expect: ["completed"] },
  { id: "bind-period-day", category: "binding", resource: medReq({ text: "x", timing: { repeat: { frequency: 1, period: 1, periodUnit: "day" } } }), expect: ["d"] },
  { id: "bind-period-hr", category: "binding", resource: medReq({ text: "x", timing: { repeat: { frequency: 1, period: 8, periodUnit: "hr" } } }), expect: ["h"] },
  { id: "bind-obs-completed", category: "binding", resource: { ...obs(), status: "completed" }, expect: ["final"] },
  { id: "bind-proc-done", category: "binding", resource: { resourceType: "Procedure", status: "done", subject: { reference: "Patient/p1" } }, expect: ["completed"] },
  { id: "bind-name-use", category: "binding", resource: { resourceType: "Patient", name: [{ use: "Official", family: "Chen" }] }, expect: ["official"] },
  { id: "bind-contact-system", category: "binding", resource: { resourceType: "Patient", telecom: [{ system: "telephone", value: "02-1234" }] }, expect: ["phone"] },

  // --- Unknown code in other CodeSystems ------------------------------------
  { id: "code-case-clinical", category: "unknown_code", resource: { ...cond({ system: SCT, code: "44054006" }), clinicalStatus: { coding: [{ system: THO + "condition-clinical", code: "Active" }] } }, expect: ["active"] },
  { id: "code-near-vital", category: "unknown_code", resource: coded(THO + "observation-category", "vital-sign", "Vital Signs"), expect: ["vital-signs"] },
  { id: "code-case-amb", category: "unknown_code", resource: enc({ system: THO + "v3-ActCode", code: "amb" }), expect: ["AMB"] },
  { id: "code-icd-dot", category: "unknown_code", resource: cond({ system: ICD, code: "E119", display: "Type 2 diabetes mellitus without complications" }), expect: ["E11.9"] },
  { id: "code-loinc-in-sct", category: "unknown_code", resource: codeOf(SCT, "8867-4", "Heart rate"), expect: [LOINC] },
  { id: "code-loinc-nodash", category: "unknown_code", resource: codeOf(LOINC, "88674", "Heart rate"), expect: ["8867-4"] },
  { id: "code-sct-in-icd", category: "unknown_code", resource: cond({ system: ICD, code: "44054006", display: "Diabetes mellitus type 2" }), expect: [SCT] },
  { id: "code-lab-display", category: "unknown_code", resource: coded(THO + "observation-category", "lab", "Laboratory"), expect: ["laboratory"] },
  { id: "code-v2-case", category: "unknown_code", resource: { resourceType: "Patient", identifier: [{ type: { coding: [{ system: THO + "v2-0203", code: "mr" }] }, system: "urn:oid:2.16.886.101.20003.20001", value: "1" }] }, expect: ["MR"] },
  { id: "code-ver-status", category: "unknown_code", resource: { ...cond({ system: SCT, code: "44054006" }), verificationStatus: { coding: [{ system: THO + "condition-ver-status", code: "confirm", display: "Confirmed" }] } }, expect: ["confirmed"] },
  { id: "code-icd-text", category: "unknown_code", resource: { ...cond({ system: ICD, code: "E11" }), code: { coding: [{ system: ICD, code: "E11.90" }], text: "Type 2 diabetes mellitus without complications" } }, expect: ["E11.9"] },
  { id: "code-sct-display", category: "unknown_code", resource: cond({ system: SCT, code: "44054007", display: "Type 2 diabetes mellitus" }), expect: ["44054006"] },

  // --- Wrong display --------------------------------------------------------
  { id: "disp-loinc", category: "wrong_display", resource: codeOf(LOINC, "8867-4", "Pulse"), expect: ["Heart rate"] },
  { id: "disp-actcode", category: "wrong_display", resource: enc({ system: THO + "v3-ActCode", code: "AMB", display: "outpatient" }), expect: ["ambulatory"] },
  { id: "disp-vital", category: "wrong_display", resource: coded(THO + "observation-category", "vital-signs", "Vital Sign"), expect: ["Vital Signs"] },
  { id: "disp-clinical", category: "wrong_display", resource: { ...cond({ system: SCT, code: "44054006" }), clinicalStatus: { coding: [{ system: THO + "condition-clinical", code: "active", display: "Active condition" }] } }, expect: ["Active"] },
  { id: "disp-sct", category: "wrong_display", resource: cond({ system: SCT, code: "44054006", display: "Type II diabetes" }), expect: ["Diabetes mellitus type 2", "Type 2 diabetes mellitus"] },
  { id: "disp-icd", category: "wrong_display", resource: cond({ system: ICD, code: "E11.9", display: "Diabetes" }), expect: ["Type 2 diabetes mellitus without complications"] },
  { id: "disp-v2", category: "wrong_display", resource: { resourceType: "Patient", identifier: [{ type: { coding: [{ system: THO + "v2-0203", code: "MR", display: "Medical Record" }] }, system: "urn:oid:2.16.886.101.20003.20001", value: "1" }] }, expect: ["Medical record number"] },
  { id: "disp-other-code", category: "wrong_display", resource: codeOf(LOINC, "8867-4", "Body temperature"), expect: ["Heart rate"] },
  { id: "disp-whitespace", category: "wrong_display", resource: codeOf(LOINC, "8310-5", "Body  temperature"), expect: ["Body temperature"] },

  // --- Reference chain ------------------------------------------------------
  {
    id: "ref-patient-noprofile",
    category: "reference_chain",
    resource: {
      resourceType: "Bundle",
      type: "collection",
      entry: [
        { fullUrl: "urn:uuid:11111111-1111-4111-8111-111111111111", resource: { resourceType: "Condition", meta: { profile: [TW + "Condition-twcore"] }, clinicalStatus: { coding: [{ system: THO + "condition-clinical", code: "active" }] }, code: { coding: [{ system: ICD, code: "E11.9" }] }, subject: { reference: "urn:uuid:22222222-2222-4222-8222-222222222222" } } },
        { fullUrl: "urn:uuid:22222222-2222-4222-8222-222222222222", resource: { resourceType: "Patient", gender: "male", birthDate: "1990-01-01" } },
      ],
    },
    expect: ["Bundle.entry[1].resource"],
  },
  {
    id: "ref-patient-own-errors",
    category: "reference_chain",
    resource: {
      resourceType: "Bundle",
      type: "collection",
      entry: [
        { fullUrl: "urn:uuid:11111111-1111-4111-8111-111111111112", resource: { resourceType: "MedicationRequest", meta: { profile: [TW + "MedicationRequest-twcore"] }, status: "active", intent: "order", medicationCodeableConcept: { text: "x" }, subject: { reference: "urn:uuid:22222222-2222-4222-8222-222222222223" } } },
        { fullUrl: "urn:uuid:22222222-2222-4222-8222-222222222223", resource: { resourceType: "Patient", meta: { profile: [TW + "Patient-twcore"] }, identifier: [{ system: "urn:oid:2.16.886.101.20003.20001", value: "1" }], gender: "M", birthDate: "1990-01-01" } },
      ],
    },
    expect: ["Bundle.entry[1].resource"],
  },
  {
    id: "ref-encounter-noprofile",
    category: "reference_chain",
    resource: {
      resourceType: "Bundle",
      type: "collection",
      entry: [
        { fullUrl: "urn:uuid:11111111-1111-4111-8111-111111111113", resource: { resourceType: "Condition", meta: { profile: [TW + "Condition-twcore"] }, code: { coding: [{ system: ICD, code: "E11.9" }] }, subject: { reference: "urn:uuid:22222222-2222-4222-8222-222222222224" }, encounter: { reference: "urn:uuid:33333333-3333-4333-8333-333333333333" } } },
        { fullUrl: "urn:uuid:22222222-2222-4222-8222-222222222224", resource: { resourceType: "Patient", meta: { profile: [TW + "Patient-twcore"] }, identifier: [{ system: "urn:oid:2.16.886.101.20003.20001", value: "1" }], gender: "male", birthDate: "1990-01-01" } },
        { fullUrl: "urn:uuid:33333333-3333-4333-8333-333333333333", resource: { resourceType: "Encounter", status: "finished" } },
      ],
    },
    expect: ["Bundle.entry[2].resource"],
  },
];

/**
 * Held-out set: written after the suggesters were frozen and never used to tune them
 * (an honest estimate on unseen errors of the same categories).
 */
export const HELDOUT: Fixture[] = [
  { id: "h-ucum-mcg-kg-min", category: "ucum", resource: qty("mcg/kg/min"), expect: ["ug/kg/min"] },
  { id: "h-ucum-gm", category: "ucum", resource: qty("gm"), expect: ["g"] },
  { id: "h-ucum-mls", category: "ucum", resource: dose("mls"), expect: ["mL"] },
  { id: "h-ucum-Kg", category: "ucum", resource: qty("Kg"), expect: ["kg"] },
  { id: "h-ucum-kcal-day", category: "ucum", resource: qty("kcal/day"), expect: ["kcal/d"] },
  { id: "h-ucum-tablets", category: "ucum", resource: dose("tablets"), expect: ["{tablet}"] },
  { id: "h-ucum-sachet", category: "ucum", resource: dose("sachet"), expect: ["{sachet}"] },
  { id: "h-ucum-micro", category: "ucum", resource: qty("\u03bcg"), expect: ["ug"] },
  { id: "h-url-actcodes", category: "unknown_url", resource: enc({ system: THO + "v3-ActCodes", code: "IMP" }), expect: [THO + "v3-ActCode"] },
  { id: "h-url-allergy-ver", category: "unknown_url", resource: { resourceType: "AllergyIntolerance", patient: { reference: "Patient/p1" }, verificationStatus: { coding: [{ system: THO + "allergyintolerance-verification-status", code: "confirmed" }] } }, expect: [THO + "allergyintolerance-verification"] },
  { id: "h-url-interp", category: "unknown_url", resource: obs({ interpretation: [{ coding: [{ system: THO + "observation-interpretation", code: "H" }] }] }), expect: [THO + "v3-ObservationInterpretation"] },
  { id: "h-prop-telecoms", category: "unrecognized_property", sub: "prop/rename", resource: { resourceType: "Patient", telecoms: [{ system: "phone", value: "1" }] }, expect: ["telecom"] },
  { id: "h-prop-asNeeded", category: "unrecognized_property", sub: "prop/rename", resource: medReq({ text: "x", asNeeded: true }), expect: ["asNeededBoolean"] },
  { id: "h-prop-periods", category: "unrecognized_property", sub: "prop/rename", resource: { ...enc({ system: THO + "v3-ActCode", code: "AMB" }), periods: { start: "2020-01-01" } }, expect: ["period"] },
  { id: "h-prop-reactions", category: "unrecognized_property", sub: "prop/rename", resource: { resourceType: "AllergyIntolerance", patient: { reference: "Patient/p1" }, reactions: [{ manifestation: [{ text: "rash" }] }] }, expect: ["reaction"] },
  { id: "h-prop-zip", category: "unrecognized_property", sub: "prop/shape-rename", resource: { resourceType: "Patient", address: [{ city: "Taipei", zip: "100" }] }, expect: ["postalCode"] },
  { id: "h-bind-prelim", category: "binding", resource: { ...obs(), status: "Preliminary" }, expect: ["preliminary"] },
  { id: "h-bind-gender-F", category: "binding", resource: { resourceType: "Patient", gender: "F" }, expect: ["female"] },
  { id: "h-bind-in-progress", category: "binding", resource: { ...enc({ system: THO + "v3-ActCode", code: "AMB" }), status: "in progress" }, expect: ["in-progress"] },
  { id: "h-bind-days", category: "binding", resource: medReq({ text: "x", timing: { repeat: { frequency: 1, period: 1, periodUnit: "days" } } }), expect: ["d"] },
  { id: "h-bind-week", category: "binding", resource: medReq({ text: "x", timing: { repeat: { frequency: 1, period: 1, periodUnit: "week" } } }), expect: ["wk"] },
  { id: "h-bind-allergy-type", category: "binding", resource: { resourceType: "AllergyIntolerance", patient: { reference: "Patient/p1" }, type: "Allergy" }, expect: ["allergy"] },
  { id: "h-code-vital-case", category: "unknown_code", resource: coded(THO + "observation-category", "Vital-Signs"), expect: ["vital-signs"] },
  { id: "h-code-resolve", category: "unknown_code", resource: { ...cond({ system: SCT, code: "44054006" }), clinicalStatus: { coding: [{ system: THO + "condition-clinical", code: "resolve", display: "Resolved" }] } }, expect: ["resolved"] },
  { id: "h-code-icd-lower", category: "unknown_code", resource: cond({ system: ICD, code: "j45909" }), expect: ["J45.909"] },
  { id: "h-code-icd-trailing-dot", category: "unknown_code", resource: cond({ system: ICD, code: "I10." }), expect: ["I10"] },
  { id: "h-code-loinc-in-sct", category: "unknown_code", resource: codeOf(SCT, "8302-2", "Body height"), expect: [LOINC] },
  { id: "h-code-sct-in-loinc", category: "unknown_code", resource: codeOf(LOINC, "386661006", "Fever"), expect: [SCT] },
  { id: "h-disp-weight", category: "wrong_display", resource: codeOf(LOINC, "29463-7", "Weight"), expect: ["Body weight"] },
  { id: "h-disp-htn", category: "wrong_display", resource: cond({ system: ICD, code: "I10", display: "Hypertension" }), expect: ["Essential (primary) hypertension"] },
  { id: "h-disp-lab", category: "wrong_display", resource: coded(THO + "observation-category", "laboratory", "Lab"), expect: ["Laboratory"] },

  // --- Unrecognized property (held-out): move / shape rename / remove ------------------------
  { id: "h-mv-interpretation-in-quantity", category: P, sub: "prop/move", kind: MOVE, resource: obs({ valueQuantity: { value: 1, interpretation: [{ text: "high" }] } }), expect: ["Observation.interpretation"], suffix: true },
  { id: "h-mv-postalCode-root", category: P, sub: "prop/move", kind: MOVE, resource: pat({ postalCode: "100" }), expect: ["address[0].postalCode"], suffix: true },
  { id: "h-mv-periodUnit-in-dosage", category: P, sub: "prop/move", kind: MOVE, resource: medReq({ text: "x", periodUnit: "d" }), expect: ["timing.repeat.periodUnit"], suffix: true },
  { id: "h-mv-onsetDateTime-in-code", category: P, sub: "prop/move", kind: MOVE, resource: { resourceType: "Condition", subject: { reference: "Patient/p1" }, code: { coding: [{ system: SCT, code: "44054006" }], onsetDateTime: "2020-01-01" } }, expect: ["Condition.onsetDateTime"], suffix: true },
  { id: "h-mv-individual-root", category: P, sub: "prop/move", kind: MOVE, resource: encX({ individual: { reference: "Practitioner/x" } }), expect: ["participant[0].individual"], suffix: true },
  { id: "h-mv-doseNumber-root", category: P, sub: "prop/move", kind: MOVE, resource: { resourceType: "Immunization", status: "completed", vaccineCode: { text: "x" }, patient: { reference: "Patient/p1" }, occurrenceDateTime: "2020-01-01", doseNumberPositiveInt: 1 }, expect: ["protocolApplied[0].doseNumberPositiveInt"], suffix: true },
  { id: "h-mv-relationship-root", category: P, sub: "prop/move", kind: MOVE, resource: pat({ relationship: [{ text: "mother" }] }), expect: ["contact[0].relationship"], suffix: true },
  { id: "h-sr-birthday", category: P, sub: "prop/shape-rename", kind: RENAME, resource: pat({ birthday: "1990-01-01" }), expect: ["birthDate"] },
  { id: "h-sr-telephone", category: P, sub: "prop/shape-rename", kind: RENAME, resource: pat({ telephone: "02-1234" }), expect: ["telecom"] },
  { id: "h-sr-remarks", category: P, sub: "prop/shape-rename", kind: RENAME, resource: obs({ remarks: "x" }), expect: ["note"] },
  { id: "h-sr-physician", category: P, sub: "prop/shape-rename", kind: RENAME, resource: proc({ physician: { reference: "Practitioner/x" } }), expect: ["performer"] },
  { id: "h-sr-indication", category: P, sub: "prop/shape-rename", kind: RENAME, resource: encX({ indication: [{ text: "x" }] }), expect: ["reasonCode"] },
  { id: "h-sr-lowerLimit", category: P, sub: "prop/shape-rename", kind: RENAME, resource: obs({ valueRange: { lowerLimit: { value: 1, unit: "mg" }, high: { value: 5, unit: "mg" } } }), expect: ["low"] },
  { id: "h-sr-amount-quantity", category: P, sub: "prop/shape-rename", kind: RENAME, resource: medReq({ text: "x" }, { dispenseRequest: { amount: { value: 30, unit: "tablet" } } }), expect: ["quantity"] },
  { id: "h-sr-beginDate", category: P, sub: "prop/shape-rename", kind: RENAME, resource: { ...cond({ system: SCT, code: "44054006" }), beginDate: "2020-01-01" }, expect: ["onsetDateTime"] },
  { id: "h-rm-department", category: P, sub: "prop/remove", kind: REMOVE, resource: obs({ department: "cardiology" }), expect: ["department"] },
  { id: "h-rm-hospital", category: P, sub: "prop/remove", kind: REMOVE, resource: { ...cond({ system: SCT, code: "44054006" }), hospital: "A" }, expect: ["hospital"] },
  { id: "h-rm-insurance", category: P, sub: "prop/remove", kind: REMOVE, resource: pat({ insurance: "NHI" }), expect: ["insurance"] },
  { id: "h-rm-refills", category: P, sub: "prop/remove", kind: REMOVE, resource: medReq({ text: "x" }, { refills: 2 }), expect: ["refills"] },
  { id: "h-rm-floor", category: P, sub: "prop/remove", kind: REMOVE, resource: encX({ location: [{ location: { reference: "Location/l1" }, floor: 3 }] }), expect: ["floor"] },
  { id: "h-rm-strength-dosage", category: P, sub: "prop/remove", kind: REMOVE, resource: medReq({ text: "x", strength: "500 mg" }), expect: ["strength"] },
  { id: "h-choice-onsetString", category: "choice_type", resource: { ...cond({ system: SCT, code: "44054006" }), onsetInteger: 5 }, expect: ["onsetAge"] },
];
