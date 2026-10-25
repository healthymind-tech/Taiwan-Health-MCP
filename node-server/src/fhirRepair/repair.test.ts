/**
 * Shared content-repair layer (ISSUES_v14) over synthetic StructureDefinitions and in-memory
 * collaborators: R1 display (same concept replaced / different concept kept + candidates), R2 UCUM,
 * R3 ROC dates, R4 / R5 Coding.system, R6 shapes, verification (a change that adds an error is
 * withdrawn), idempotence and lossless numbers. No DB.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { syntheticDatatypeSd } from "../authoring/values.js";
import { parseLossless, RawNumber, stringifyLossless, toPlain } from "../losslessJson.js";
import { cloneTree, repairBundle, repairResource, type RepairDeps } from "./index.js";

type El = Record<string, any>;
const CORE = "http://hl7.org/fhir/StructureDefinition/";
const UCUM = "http://unitsofmeasure.org";
const LOINC = "http://loinc.org";
const SCT = "http://snomed.info/sct";
const ICD = "http://hl7.org/fhir/sid/icd-10-cm";
const ACT = "http://terminology.hl7.org/CodeSystem/v3-ActCode";
const EX = "http://example.org/fhir/";

function el(id: string, min: number, max: string, types: string[] = [], extra: El = {}): El {
  const path = id.replace(/:[^.]+/g, "");
  return { id, path, min, max, base: { path, min, max: extra.baseMax ?? max }, ...(types.length ? { type: types.map((code) => ({ code })) } : {}), ...extra };
}
function sd(url: string, type: string, elements: El[], kind = "resource"): El {
  return { resourceType: "StructureDefinition", url, type, kind, snapshot: { element: elements } };
}
const domain = (rt: string): El[] => [el(`${rt}.id`, 0, "1", ["id"]), el(`${rt}.meta`, 0, "1", ["Meta"]), el(`${rt}.text`, 0, "1", ["Narrative"])];

const SDS: Record<string, El> = {
  [CORE + "Observation"]: sd(CORE + "Observation", "Observation", [
    el("Observation", 0, "*"),
    ...domain("Observation"),
    el("Observation.status", 1, "1", ["code"]),
    el("Observation.code", 1, "1", ["CodeableConcept"]),
    el("Observation.effective[x]", 0, "1", ["dateTime", "Period"]),
    el("Observation.value[x]", 0, "1", ["Quantity", "CodeableConcept", "string"]),
    el("Observation.component", 0, "*", ["BackboneElement"]),
    el("Observation.component.code", 1, "1", ["CodeableConcept"]),
    el("Observation.component.value[x]", 0, "1", ["Quantity", "string"]),
  ]),
  [CORE + "Patient"]: sd(CORE + "Patient", "Patient", [el("Patient", 0, "*"), ...domain("Patient"), el("Patient.birthDate", 0, "1", ["date"]), el("Patient.gender", 0, "1", ["code"])]),
  [CORE + "Encounter"]: sd(CORE + "Encounter", "Encounter", [
    el("Encounter", 0, "*"),
    ...domain("Encounter"),
    el("Encounter.status", 1, "1", ["code"]),
    el("Encounter.class", 1, "1", ["Coding"]),
    el("Encounter.type", 0, "*", ["CodeableConcept"]),
  ]),
  [CORE + "Condition"]: sd(CORE + "Condition", "Condition", [
    el("Condition", 0, "*"),
    ...domain("Condition"),
    el("Condition.clinicalStatus", 0, "1", ["CodeableConcept"]),
    el("Condition.code", 0, "1", ["CodeableConcept"]),
    el("Condition.onset[x]", 0, "1", ["dateTime", "string"]),
  ]),
  [CORE + "MedicationRequest"]: sd(CORE + "MedicationRequest", "MedicationRequest", [
    el("MedicationRequest", 0, "*"),
    ...domain("MedicationRequest"),
    el("MedicationRequest.status", 1, "1", ["code"]),
    el("MedicationRequest.dosageInstruction", 0, "*", ["Dosage"]),
  ]),
  [CORE + "Bundle"]: sd(CORE + "Bundle", "Bundle", [
    el("Bundle", 0, "*"),
    el("Bundle.id", 0, "1", ["id"]),
    el("Bundle.type", 1, "1", ["code"]),
    el("Bundle.entry", 0, "*", ["BackboneElement"]),
    el("Bundle.entry.fullUrl", 0, "1", ["uri"]),
    el("Bundle.entry.resource", 0, "1", ["Resource"]),
  ]),
  // A respiratory-rate profile fixing the UCUM code (like the HL7 resprate / TW Core profiles).
  [EX + "RespRate"]: sd(EX + "RespRate", "Observation", [
    el("Observation", 0, "*"),
    ...domain("Observation"),
    el("Observation.status", 1, "1", ["code"]),
    el("Observation.code", 1, "1", ["CodeableConcept"]),
    el("Observation.value[x]", 0, "1", ["Quantity"], { slicing: { discriminator: [{ type: "type", path: "$this" }], rules: "closed" } }),
    el("Observation.value[x]:valueQuantity", 0, "1", ["Quantity"], { sliceName: "valueQuantity" }),
    el("Observation.value[x]:valueQuantity.value", 1, "1", ["decimal"]),
    el("Observation.value[x]:valueQuantity.unit", 1, "1", ["string"]),
    el("Observation.value[x]:valueQuantity.system", 1, "1", ["uri"], { fixedUri: UCUM }),
    el("Observation.value[x]:valueQuantity.code", 1, "1", ["code"], { fixedCode: "/min" }),
  ]),
  [EX + "BodyTemp"]: sd(EX + "BodyTemp", "Observation", [
    el("Observation", 0, "*"),
    ...domain("Observation"),
    el("Observation.status", 1, "1", ["code"]),
    el("Observation.code", 1, "1", ["CodeableConcept"]),
    el("Observation.value[x]", 0, "1", ["Quantity"], { slicing: { discriminator: [{ type: "type", path: "$this" }], rules: "closed" } }),
    el("Observation.value[x]:valueQuantity", 0, "1", ["Quantity"], { sliceName: "valueQuantity" }),
    el("Observation.value[x]:valueQuantity.code", 1, "1", ["code"], { binding: { strength: "required", valueSet: EX + "ValueSet/bodytemp" } }),
  ]),
};

const CODES: Record<string, Record<string, string[]>> = {
  [LOINC]: { "8310-5": ["Body temperature", "Temp"], "9279-1": ["Respiratory rate"], "2160-0": ["Creatinine [Mass/volume] in Serum or Plasma"], "8480-6": ["Systolic blood pressure"] },
  [SCT]: { "428921007": ["Infection of uncertain etiology"], "233604007": ["Pneumonia"], "38341003": ["Hypertensive disorder, systemic arterial", "Hypertensive disorder, systemic arterial (disorder)"] },
  [ICD]: { "E11.9": ["Type 2 diabetes mellitus without complications"], "I10": ["Essential (primary) hypertension"] },
  [ACT]: { ACUTE: ["inpatient acute"], AMB: ["ambulatory"], IMP: ["inpatient encounter"], _ActMedicalServiceCode: ["ActMedicalServiceCode"] },
};
const SEARCH: Record<string, Array<{ system: string; code: string; display: string; exact?: boolean }>> = {
  [`${SCT}|Pneumonia`]: [{ system: SCT, code: "233604007", display: "Pneumonia", exact: true }, { system: SCT, code: "53084003", display: "Bacterial pneumonia" }],
  [`${ACT}|Acute`]: [{ system: ACT, code: "ACUTE", display: "inpatient acute", exact: true }, { system: ACT, code: "ACU", display: "short term/acute" }],
  [`${LOINC}|Uric acid`]: [{ system: LOINC, code: "3084-1", display: "Urate [Mass/volume] in Serum or Plasma" }],
};

function deps(extra: Partial<RepairDeps> = {}): RepairDeps {
  return {
    fetchStructureDefinition: async (url) => {
      const u = url.split("|")[0];
      if (SDS[u]) return SDS[u];
      return u.startsWith(CORE) ? syntheticDatatypeSd(u.slice(CORE.length)) : null;
    },
    lookupDisplay: async (system, code) => CODES[system]?.[code]?.[0] ?? null,
    checkDisplay: async (system, code, display) => {
      const valid = CODES[system]?.[code];
      if (!valid) return { status: "unknown", valid: [] };
      return valid.some((d) => d.toLowerCase() === display.toLowerCase()) ? { status: "ok", valid: [] } : { status: "invalid-display", valid };
    },
    normalize: async (text, target) => (SEARCH[`${target.system}|${text}`] ?? []).map((x) => ({ ...x })),
    expandValueSet: async (url) =>
      url.split("|")[0] === EX + "ValueSet/bodytemp" ? { codings: [{ system: UCUM, code: "Cel", display: "degree Celsius" }, { system: UCUM, code: "[degF]", display: "degree Fahrenheit" }], total: 2, truncated: false } : null,
    resolveSystem: async (url) => (CODES[url] || url === UCUM ? { kind: "codesystem" } : /^https?:\/\/(hl7\.org|terminology\.hl7\.org)\//.test(url) ? { kind: "unknown", codeSystemTwin: null } : { kind: "other" }),
    codeInSystem: async (system, code) => (CODES[system] ? code in CODES[system] : undefined),
    codeSystemDirectory: async () => [{ url: ACT, names: ["ActCode", "v3-ActCode", "v3 Code System ActCode"] }],
    codeSystemsWithCode: async (code) => Object.keys(CODES).filter((s) => code in CODES[s]),
    ...extra,
  };
}

const obs = (more: El): El => ({ resourceType: "Observation", status: "final", code: { coding: [{ system: LOINC, code: "8310-5" }] }, ...more });

test("R1: the same concept written differently is replaced (spelling / search); the wording is kept as text", async () => {
  const enc: El = { resourceType: "Encounter", status: "finished", class: { system: ACT, code: "ACUTE", display: "Acute" } };
  const r = await repairResource(enc, deps());
  assert.equal(enc.class.display, "inpatient acute");
  assert.equal(r.changes[0].rule, "display");
  assert.match(r.changes[0].reason, /finds ACUTE first \(exact\)/);
  const cond: El = { resourceType: "Condition", code: { coding: [{ system: SCT, code: "38341003", display: "Systemic arterial hypertensive disorder" }] } };
  const r2 = await repairResource(cond, deps());
  assert.equal(cond.code.coding[0].display, "Hypertensive disorder, systemic arterial");
  assert.equal(cond.code.text, "Systemic arterial hypertensive disorder");
  assert.match(r2.changes[0].reason, /written differently/);
  const plural: El = { resourceType: "Condition", code: { coding: [{ system: ICD, code: "E11.9", display: "Type II diabetes mellitus without complication" }] } };
  await repairResource(plural, deps());
  assert.equal(plural.code.coding[0].display, "Type 2 diabetes mellitus without complications");
});

test("R1: a display naming a DIFFERENT concept is never replaced; candidates come from searching the display", async () => {
  const cond: El = { resourceType: "Condition", code: { coding: [{ system: SCT, code: "428921007", display: "Pneumonia" }] } };
  const before = JSON.stringify(cond);
  const r = await repairResource(cond, deps());
  assert.equal(JSON.stringify(cond), before);
  assert.deepEqual(r.changes, []);
  assert.equal(r.issues.length, 1);
  assert.equal(r.issues[0].rule, "display");
  assert.match(r.issues[0].message, /NOT replaced: 'Pneumonia' denotes http:\/\/snomed\.info\/sct#233604007/);
  assert.deepEqual((r.issues[0].candidates as any[]).map((c) => c.code), ["233604007", "53084003"]);
  // nothing found / no search available → undecidable → kept
  const lab = obs({ code: { coding: [{ system: LOINC, code: "2160-0", display: "Uric acid" }] } });
  assert.deepEqual((await repairResource(lab, deps())).changes, []);
  const noSearch = { resourceType: "Encounter", status: "finished", class: { system: ACT, code: "ACUTE", display: "Acute" } };
  const d = deps();
  delete d.normalize;
  assert.deepEqual((await repairResource(noSearch, d)).changes, []);
  assert.equal(noSearch.class.display, "Acute");
});

test("R2: UCUM code / system from the unit or code text, fitted to fixed codes and required ValueSets", async () => {
  const bp = obs({ component: [{ code: { coding: [{ system: LOINC, code: "8480-6" }] }, valueQuantity: { value: 120, unit: "mmHg" } }] });
  const r = await repairResource(bp, deps());
  assert.deepEqual(bp.component[0].valueQuantity, { value: 120, unit: "mmHg", system: UCUM, code: "mm[Hg]" });
  assert.deepEqual(r.changes.map((c) => c.rule), ["ucum", "ucum"]);
  const t = obs({ meta: { profile: [EX + "BodyTemp"] }, valueQuantity: { value: 37.2, unit: "°C", system: UCUM, code: "8310-5" } });
  await repairResource(t, deps());
  assert.equal(t.valueQuantity.code, "Cel", "a LOINC code in Quantity.code is replaced by the unit's UCUM code");
  const degC = obs({ meta: { profile: [EX + "BodyTemp"] }, valueQuantity: { value: 37.2, unit: "degC", system: UCUM, code: "degC" } });
  await repairResource(degC, deps());
  assert.equal(degC.valueQuantity.code, "Cel");
  const kelvin = obs({ meta: { profile: [EX + "BodyTemp"] }, valueQuantity: { value: 310, unit: "K" } });
  const rk = await repairResource(kelvin, deps());
  assert.deepEqual(rk.changes, [], "K is not in the required ValueSet: not changed");
  assert.match(rk.issues[0].message, /not uniquely determined.*not allowed/);
  const rr = obs({ meta: { profile: [EX + "RespRate"] }, code: { coding: [{ system: LOINC, code: "9279-1" }] }, valueQuantity: { value: 18, unit: "次/分鐘", system: UCUM, code: "min" } });
  const rrr = await repairResource(rr, deps());
  assert.equal(rr.valueQuantity.code, "/min");
  assert.match(rrr.changes[0].reason, /rate/);
  const conflict = obs({ valueQuantity: { value: 1, unit: "kg", system: UCUM, code: "mmHg" } });
  const rc = await repairResource(conflict, deps());
  assert.equal(conflict.valueQuantity.code, "mmHg", "code and unit disagree: not changed");
  assert.equal(rc.issues[0].rule, "ucum");
  // a Quantity in another real code system is not touched
  const other = obs({ valueQuantity: { value: 1, unit: "tab", system: ACT, code: "AMB" } });
  assert.deepEqual((await repairResource(other, deps())).changes, []);
});

test("R3: ROC dates → Gregorian when certain; offsets never invented; 1–2-digit and 4-digit years untouched", async () => {
  const p: El = { resourceType: "Patient", birthDate: "069/05/30" };
  await repairResource(p, deps());
  assert.equal(p.birthDate, "1980-05-30");
  const cn: El = { resourceType: "Patient", birthDate: "民國69年5月30日" };
  await repairResource(cn, deps());
  assert.equal(cn.birthDate, "1980-05-30");
  const noTz = obs({ effectiveDateTime: "115-10-03T16:05:00" });
  const r = await repairResource(noTz, deps());
  assert.equal(noTz.effectiveDateTime, "115-10-03T16:05:00");
  assert.match(r.issues[0].message, /UTC offset/);
  const tz = obs({ effectiveDateTime: "115-10-03T16:05:00" });
  await repairResource(tz, deps(), { timezone: "+08:00" });
  assert.equal(tz.effectiveDateTime, "2026-10-03T16:05:00+08:00");
  const two: El = { resourceType: "Patient", birthDate: "99-10-03" };
  const r2 = await repairResource(two, deps());
  assert.equal(two.birthDate, "99-10-03");
  assert.match(r2.issues[0].message, /2-digit year/);
  const four: El = { resourceType: "Patient", birthDate: "2026/10/03" };
  assert.deepEqual(await repairResource(four, deps()), { changes: [], issues: [] });
});

test("R4 / R5: a system name or an unknown URL → the one CodeSystem it names that holds the code", async () => {
  const c: El = { resourceType: "Condition", code: { coding: [{ system: "ICD-10-CM", code: "E11.9" }] } };
  const r = await repairResource(c, deps());
  assert.equal(c.code.coding[0].system, ICD);
  assert.match(r.changes[0].reason, /absolute URI/);
  const bad: El = { resourceType: "Condition", code: { coding: [{ system: "ICD-10-CM", code: "XX.9" }] } };
  const rb = await repairResource(bad, deps());
  assert.equal(bad.code.coding[0].system, "ICD-10-CM");
  assert.match(rb.issues[0].message, /not a code there/);
  const frag: El = { resourceType: "Condition", code: { coding: [{ system: "http://hl7.org/fhir/ns/fhir/CodeSystem#icd-10-cm", code: "I10" }] } };
  await repairResource(frag, deps());
  assert.equal(frag.code.coding[0].system, ICD);
  const abs: El = { resourceType: "Encounter", status: "finished", class: { system: "http://terminology.hl7.org/CodeSystem/_ActMedicalServiceCode", code: "AMB" } };
  const ra = await repairResource(abs, deps());
  assert.equal(abs.class.system, ACT);
  assert.match(ra.changes[0].reason, /abstract code/);
  const name: El = { resourceType: "Encounter", status: "finished", class: { system: "v3-ActCode", code: "IMP" } };
  await repairResource(name, deps());
  assert.equal(name.class.system, ACT);
});

test("R6: lossless reshapes only; ambiguous shapes are reported with an example", async () => {
  const e: El = { resourceType: "Encounter", status: "finished", class: { coding: [{ system: ACT, code: "AMB", display: "ambulatory" }] } };
  const r = await repairResource(e, deps());
  assert.deepEqual(e.class, { system: ACT, code: "AMB", display: "ambulatory" });
  assert.equal(r.changes[0].rule, "shape");
  const nested: El = { resourceType: "Encounter", status: "finished", class: { code: { system: ACT, code: "IMP", display: "inpatient encounter" } } };
  await repairResource(nested, deps());
  assert.deepEqual(nested.class, { system: ACT, code: "IMP", display: "inpatient encounter" });
  const two: El = { resourceType: "Encounter", status: "finished", class: { coding: [{ system: ACT, code: "AMB" }, { system: ACT, code: "IMP" }] } };
  const r2 = await repairResource(two, deps());
  assert.deepEqual(r2.changes, []);
  assert.match(r2.issues[0].message, /2 codings .*"system": "<CodeSystem URL>"/);
  const bare: El = { resourceType: "Condition", clinicalStatus: { system: "http://terminology.hl7.org/CodeSystem/condition-clinical", code: "active" } };
  await repairResource(bare, deps());
  assert.deepEqual(bare.clinicalStatus, { coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-clinical", code: "active" }] });
  const mr: El = { resourceType: "MedicationRequest", status: "active", dosageInstruction: [{ text: "500 mg", doseQuantity: { value: 500, unit: "mg", system: UCUM, code: "mg" } }] };
  const rm = await repairResource(mr, deps());
  assert.deepEqual(mr.dosageInstruction[0], { text: "500 mg", doseAndRate: [{ doseQuantity: { value: 500, unit: "mg", system: UCUM, code: "mg" } }] });
  assert.equal(rm.changes[0].path, "MedicationRequest.dosageInstruction[0].doseAndRate[0].doseQuantity");
  const arr = obs({ valueQuantity: [{ value: 1, unit: "mg", system: UCUM, code: "mg" }] });
  await repairResource(arr, deps());
  assert.deepEqual(arr.valueQuantity, { value: 1, unit: "mg", system: UCUM, code: "mg" });
});

test("verification: a change after which the resource has an error it did not have is withdrawn and reported", async () => {
  // A fake validator: the corrected ICD-10-CM system exposes the display check (as the real one does).
  const validate = async (res: El): Promise<Array<{ severity: string; path: string; message: string }>> => {
    const c = res.code?.coding?.[0];
    if (c && c.system === ICD && c.display === "Stroke") return [{ severity: "error", path: "Condition.code.coding[0].display", message: "Wrong Display Name 'Stroke'" }];
    if (c && c.system === "ICD-10-CM") return [{ severity: "error", path: "Condition.code.coding[0].system", message: "Coding.system must be an absolute reference, not a local reference" }];
    return [];
  };
  const c: El = { resourceType: "Condition", code: { coding: [{ system: "ICD-10-CM", code: "I10", display: "Stroke" }] } };
  const r = await repairResource(c, deps({ validate, checkDisplay: async () => ({ status: "ok", valid: [] }) }));
  assert.equal(c.code.coding[0].system, "ICD-10-CM", "withdrawn: the resource is as written");
  assert.deepEqual(r.changes, []);
  assert.ok(r.issues.some((i) => /not applied: .*Wrong Display Name 'Stroke'/.test(i.message)), JSON.stringify(r.issues));
  const ok: El = { resourceType: "Condition", code: { coding: [{ system: "ICD-10-CM", code: "I10" }] } };
  await repairResource(ok, deps({ validate }));
  assert.equal(ok.code.coding[0].system, ICD);
});

test("idempotent, deterministic, lossless: repair(repair(x)) changes nothing and numbers keep their spelling", async () => {
  const text = JSON.stringify({
    resourceType: "Bundle",
    type: "collection",
    entry: [
      { fullUrl: "urn:uuid:7c1e7b52-5f0b-4c55-9a41-0d2f6f0e1a01", resource: { resourceType: "Observation", status: "final", code: { coding: [{ system: LOINC, code: "8310-5" }] }, valueQuantity: { value: 1, unit: "mmHg" } } },
      { fullUrl: "urn:uuid:7c1e7b52-5f0b-4c55-9a41-0d2f6f0e1a02", resource: { resourceType: "Patient", birthDate: "115/10/03" } },
    ],
  }).replace('"value":1,', '"value":37.50,');
  const tree = parseLossless(text) as El;
  const a = cloneTree(tree);
  const r1 = await repairBundle(a, deps());
  assert.ok(r1.changes.length >= 3, JSON.stringify(r1.changes));
  assert.ok(a.entry[0].resource.valueQuantity.value instanceof RawNumber);
  assert.match(stringifyLossless(a), /"value":37\.50,/);
  assert.equal(a.entry[1].resource.birthDate, "2026-10-03");
  const b = cloneTree(a);
  const r2 = await repairBundle(b, deps());
  assert.deepEqual(r2.changes, []);
  assert.equal(stringifyLossless(b), stringifyLossless(a));
  const c = cloneTree(tree);
  await repairBundle(c, deps());
  assert.equal(stringifyLossless(c), stringifyLossless(a), "same input, same output");
  assert.deepEqual(toPlain(tree), JSON.parse(text), "the input tree is not mutated");
});
