/**
 * Unit tests of the validator suggestion layer (fhirSuggestions/). Pure: hand-built
 * StructureDefinitions and fake collaborators, no DB. The fixture-based acceptance run
 * (real validator, TW Core package closure from a local FHIR package cache) is
 * scripts/suggestions-eval/evalSuggestions.ts; it runs here too when FHIR_PACKAGE_CACHE is set.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { CodeCheck } from "../fhirValidator.js";
import { el, sd } from "../fhirTestKit.test.js";
import { suggestCanonical } from "./canonicals.js";
import { codeVariants, parseBindingValueSet, parseValidDisplays, suggestBinding, suggestUnknownCode } from "./codes.js";
import { attachSuggestions, suggestionCategory } from "./index.js";
import { suggestChoiceType, suggestProperty } from "./properties.js";
import { causedBy } from "./references.js";
import type { SuggestionDeps } from "./types.js";
import { suggestUcum } from "./ucum.js";
import { levenshtein, nodeAt, parsePath, rankSuggestions } from "./util.js";

const CORE = "http://hl7.org/fhir/StructureDefinition/";
const THO = "http://terminology.hl7.org/CodeSystem/";

const SDS: Record<string, Record<string, any>> = {};
for (const s of [
  sd(CORE + "MedicationRequest", "MedicationRequest", "resource", [
    el("MedicationRequest", 0, "*"),
    el("MedicationRequest.status", 1, "1", ["code"]),
    el("MedicationRequest.medication[x]", 1, "1", ["CodeableConcept", "Reference"]),
    el("MedicationRequest.dosageInstruction", 0, "*", ["Dosage"]),
  ]),
  sd(CORE + "Dosage", "Dosage", "complex-type", [
    el("Dosage", 0, "*"),
    el("Dosage.text", 0, "1", ["string"]),
    el("Dosage.timing", 0, "1", ["Timing"]),
    el("Dosage.route", 0, "1", ["CodeableConcept"]),
    el("Dosage.doseAndRate", 0, "*", ["Element"]),
    el("Dosage.doseAndRate.dose[x]", 0, "1", ["Range", "Quantity"]),
  ]),
  sd(CORE + "Timing", "Timing", "complex-type", [
    el("Timing", 0, "*"),
    el("Timing.event", 0, "*", ["dateTime"]),
    el("Timing.repeat", 0, "1", ["Element"]),
    el("Timing.repeat.frequency", 0, "1", ["positiveInt"]),
    el("Timing.repeat.period", 0, "1", ["decimal"]),
    el("Timing.repeat.periodUnit", 0, "1", ["code"]),
    el("Timing.code", 0, "1", ["CodeableConcept"]),
  ]),
  sd(CORE + "CodeableConcept", "CodeableConcept", "complex-type", [el("CodeableConcept", 0, "*"), el("CodeableConcept.coding", 0, "*", ["Coding"]), el("CodeableConcept.text", 0, "1", ["string"])]),
  sd(CORE + "Coding", "Coding", "complex-type", [el("Coding", 0, "*"), el("Coding.system", 0, "1", ["uri"]), el("Coding.code", 0, "1", ["code"]), el("Coding.display", 0, "1", ["string"])]),
  sd(CORE + "Quantity", "Quantity", "complex-type", [el("Quantity", 0, "*"), el("Quantity.value", 0, "1", ["decimal"]), el("Quantity.unit", 0, "1", ["string"]), el("Quantity.system", 0, "1", ["uri"]), el("Quantity.code", 0, "1", ["code"])]),
  sd(CORE + "Reference", "Reference", "complex-type", [el("Reference", 0, "*"), el("Reference.reference", 0, "1", ["string"])]),
  sd(CORE + "Range", "Range", "complex-type", [el("Range", 0, "*"), el("Range.low", 0, "1", ["Quantity"], { short: "Low limit" }), el("Range.high", 0, "1", ["Quantity"], { short: "High limit" })]),
  sd(CORE + "Annotation", "Annotation", "complex-type", [el("Annotation", 0, "*"), el("Annotation.time", 0, "1", ["dateTime"]), el("Annotation.text", 1, "1", ["markdown"])]),
  sd(CORE + "Period", "Period", "complex-type", [el("Period", 0, "*"), el("Period.start", 0, "1", ["dateTime"]), el("Period.end", 0, "1", ["dateTime"])]),
  sd(CORE + "Address", "Address", "complex-type", [el("Address", 0, "*"), el("Address.city", 0, "1", ["string"]), el("Address.postalCode", 0, "1", ["string"], { alias: ["Zip"] })]),
  sd(CORE + "HumanName", "HumanName", "complex-type", [el("HumanName", 0, "*"), el("HumanName.family", 0, "1", ["string"], { alias: ["surname"] }), el("HumanName.given", 0, "*", ["string"])]),
  sd(CORE + "Patient", "Patient", "resource", [
    el("Patient", 0, "*"),
    el("Patient.identifier", 0, "*", ["Identifier"]),
    el("Patient.name", 0, "*", ["HumanName"]),
    el("Patient.gender", 0, "1", ["code"], { short: "male | female | other | unknown" }),
    el("Patient.birthDate", 0, "1", ["date"], { short: "The date of birth for the individual" }),
    el("Patient.address", 0, "*", ["Address"]),
    el("Patient.contact", 0, "*", ["BackboneElement"]),
    el("Patient.contact.name", 0, "1", ["HumanName"]),
    el("Patient.contact.period", 0, "1", ["Period"]),
  ]),
  sd(CORE + "Observation", "Observation", "resource", [
    el("Observation", 0, "*"),
    el("Observation.status", 1, "1", ["code"]),
    el("Observation.code", 1, "1", ["CodeableConcept"]),
    el("Observation.effective[x]", 0, "1", ["dateTime", "Period"], { alias: ["Occurrence"], short: "Clinically relevant time/time-period for observation" }),
    el("Observation.value[x]", 0, "1", ["Quantity", "Range", "string"], { short: "Actual result" }),
    el("Observation.note", 0, "*", ["Annotation"], { short: "Comments about the observation" }),
  ]),
]) {
  SDS[s.url] = s;
}
// Timing.repeat.period short text (rename evidence); Timing.repeat.periodMax for a precision check.
SDS[CORE + "Timing"].snapshot.element.find((e: any) => e.path === "Timing.repeat.period").short = "Event occurs frequency times per period";
SDS[CORE + "Timing"].snapshot.element.push(el("Timing.repeat.periodMax", 0, "1", ["decimal"], { short: "Upper limit of period (3-4 hours)" }));

/** A tiny code table: system → code → display. */
const CODES: Record<string, Record<string, string>> = {
  [THO + "v3-ActCode"]: { AMB: "ambulatory", IMP: "inpatient encounter" },
  [THO + "observation-category"]: { "vital-signs": "Vital Signs", laboratory: "Laboratory" },
  "http://loinc.org": { "8867-4": "Heart rate" },
  "http://hl7.org/fhir/sid/icd-10-cm": { "E11.9": "Type 2 diabetes mellitus without complications" },
};

function fakeDeps(over: Partial<SuggestionDeps> = {}): SuggestionDeps {
  return {
    fetchStructureDefinition: async (url) => SDS[url] ?? null,
    checkCode: async (system, code): Promise<CodeCheck> => {
      const t = CODES[system];
      if (!t) return { status: "unknown-system" };
      return code in t ? { status: "ok" } : { status: "invalid-code", severity: "error", message: `Unknown code '${code}' in the CodeSystem '${system}'` };
    },
    loadValueSet: async (url) =>
      url === "http://terminology.hl7.org/ValueSet/v3-ActEncounterCode" ? { url, compose: { include: [{ system: THO + "v3-ActCode", filter: [] }] } } : null,
    expandValueSet: async (url) =>
      url === "http://hl7.org/fhir/ValueSet/units-of-time"
        ? { codings: ["s", "min", "h", "d", "wk", "mo", "a"].map((c, i) => ({ system: "http://unitsofmeasure.org", code: c, display: ["second", "minute", "hour", "day", "week", "month", "year"][i] })), total: 7, truncated: false }
        : null,
    normalize: async (text, target) => {
      const t = target.system ? CODES[target.system] ?? {} : {};
      return Object.entries(t)
        .filter(([, d]) => d.toLowerCase() === text.toLowerCase())
        .map(([code, display]) => ({ system: target.system ?? null, code, display, exact: true }));
    },
    canonicalsUnder: async (prefix, types) =>
      types.includes("CodeSystem") && prefix === THO ? [THO + "v3-ActCode", THO + "observation-category", THO + "condition-clinical"] : [],
    ...over,
  };
}

test("util: OSA distance, validator paths with url qualifiers", () => {
  assert.equal(levenshtein("periodUnits", "periodUnit"), 1);
  assert.equal(levenshtein("ab", "ba"), 1);
  assert.deepEqual(
    parsePath("Patient.extension[0][url='http://x.org/a.b'].valueCoding"),
    [{ name: "Patient", index: null }, { name: "extension", index: 0 }, { name: "valueCoding", index: null }],
  );
  const root = { resourceType: "Observation", code: { coding: [{ code: "a" }, { code: "b" }] } };
  assert.equal(nodeAt(root, "Observation.code.coding[1].code"), "b");
  assert.equal(nodeAt(root, "Observation.missing"), undefined);
});

test("ucum: atom repairs are valid UCUM, cheapest first", () => {
  const first = (c: string): string | undefined => suggestUcum(c)[0]?.value;
  assert.ok(["[iU]/mL", "[IU]/mL"].includes(first("[UI]/mL")!));
  assert.equal(first("[U]"), "U");
  assert.equal(first("tab"), "{tablet}");
  assert.equal(first("mcg"), "ug");
  assert.equal(first("mmHg"), "mm[Hg]");
  assert.equal(first("kg/m^2"), "kg/m2");
  assert.equal(first("mEq/L"), "meq/L");
  assert.equal(first("times/day"), "/d");
  assert.deepEqual(suggestUcum("mg"), [], "a valid code gets no repair");
  // Quantity.unit as a fallback signal.
  assert.ok(suggestUcum("xx", "mg").some((c) => c.value === "mg"));
});

test("properties: rename at the same level, move to the level that has the element", async () => {
  const deps = fakeDeps();
  const mr = (dosage: any) => ({ resourceType: "MedicationRequest", status: "active", medicationCodeableConcept: { text: "x" }, dosageInstruction: [dosage] });
  const r1 = await suggestProperty(deps, mr({ timing: { repeat: { periodUnits: "d" } } }), "MedicationRequest.dosageInstruction[0].timing.repeat", "periodUnits");
  assert.equal(rankSuggestions(r1, 5)[0].value, "periodUnit");
  assert.equal(rankSuggestions(r1, 5)[0].kind, "rename_property");
  const r2 = rankSuggestions(await suggestProperty(deps, mr({ timing: { periodUnit: "d" } }), "MedicationRequest.dosageInstruction[0].timing", "periodUnit"), 5);
  assert.equal(r2[0].kind, "move_property");
  assert.equal(r2[0].value, "MedicationRequest.dosageInstruction[0].timing.repeat.periodUnit");
  assert.deepEqual(r2[0].patch, { op: "move", from: "MedicationRequest.dosageInstruction[0].timing.periodUnit", path: "MedicationRequest.dosageInstruction[0].timing.repeat.periodUnit" });
  const r3 = rankSuggestions(await suggestProperty(deps, mr({ doseQuantity: { value: 1 } }), "MedicationRequest.dosageInstruction[0]", "doseQuantity"), 5);
  assert.equal(r3[0].value, "MedicationRequest.dosageInstruction[0].doseAndRate[0].doseQuantity");
  // Choice stem: the value's JSON shape picks the typed name.
  const r4 = rankSuggestions(await suggestProperty(deps, { resourceType: "MedicationRequest", status: "active", medication: { reference: "Medication/1" } }, "MedicationRequest", "medication"), 5);
  assert.equal(r4[0].value, "medicationReference");
  // Unknown level → nothing (fail-closed on the walk, never a guess).
  assert.deepEqual(await suggestProperty(deps, { resourceType: "Nope" }, "Nope", "x"), []);
});

test("properties: disallowed choice type → the allowed typed name that fits the value", () => {
  const s = rankSuggestions(
    suggestChoiceType({ resourceType: "Condition", onsetDate: "2020-01-01" }, "Condition.onsetDate", "The type 'date' is not allowed for Condition.onset[x] (allowed: dateTime, Age, Period, Range, string)"),
    5,
  );
  assert.equal(s[0].value, "onsetDateTime");
  assert.deepEqual(s[0].patch, { op: "move", from: "Condition.onsetDate", path: "Condition.onsetDateTime" });
});

test("canonicals: ValueSet name → its CodeSystem; closest known URL; code check ranks", async () => {
  const deps = fakeDeps();
  const r = rankSuggestions(await suggestCanonical(deps, THO + "v3-ActEncounterCode", { expect: "CodeSystem", code: "AMB", path: "Encounter.class.system" }, { left: 4 }), 5);
  assert.equal(r[0].value, THO + "v3-ActCode");
  assert.equal(r[0].kind, "replace_system");
  assert.ok(r[0].confidence >= 0.9);
  const r2 = rankSuggestions(await suggestCanonical(deps, THO + "observation-categories", { expect: "CodeSystem", code: "vital-signs", path: "x.system" }, { left: 4 }), 5);
  assert.equal(r2[0].value, THO + "observation-category");
});

test("codes: message parsing (displays with apostrophes, binding ValueSet canonical)", () => {
  assert.deepEqual(parseValidDisplays("Wrong Display Name 'x' for http://a#1. Valid display is 'Heart rate'"), ["Heart rate"]);
  assert.deepEqual(
    parseValidDisplays("Wrong Display Name 'x' for http://a#1. Valid display is one of 3 choices: 'Alzheimer's disease' (en), 'B' or 'C' (for the language(s) 'en')"),
    ["Alzheimer's disease", "B", "C"],
  );
  assert.deepEqual(parseValidDisplays("Wrong Display Name 'x' for http://a#1. There are no valid display names found for language(s) 'en'. Default display is 'D'"), ["D"]);
  assert.equal(
    parseBindingValueSet("The value provided ('day') was not found in the value set 'UnitsOfTime' (http://hl7.org/fhir/ValueSet/units-of-time|4.0.1), and a code is required from this value set"),
    "http://hl7.org/fhir/ValueSet/units-of-time|4.0.1",
  );
  assert.ok(codeVariants("E119", "http://hl7.org/fhir/sid/icd-10-cm").includes("E11.9"));
});

test("codes: unknown code → spelling repair / named code / other terminology", async () => {
  const deps = fakeDeps();
  const enc = { resourceType: "Encounter", class: { system: THO + "v3-ActCode", code: "amb" } };
  const r = rankSuggestions(await suggestUnknownCode(deps, enc, "Encounter.class.code", THO + "v3-ActCode", "amb", { left: 4 }), 5);
  assert.equal(r[0].value, "AMB");
  assert.deepEqual(r[0].patch, { op: "replace", path: "Encounter.class.code", value: "AMB" });
  const obs = { resourceType: "Observation", code: { coding: [{ system: "http://snomed.info/sct", code: "8867-4", display: "Heart rate" }] } };
  const r2 = rankSuggestions(await suggestUnknownCode(deps, obs, "Observation.code.coding[0].code", "http://snomed.info/sct", "8867-4", { left: 4 }), 5);
  assert.equal(r2[0].kind, "replace_system");
  assert.equal(r2[0].value, "http://loinc.org");
  const cat = { resourceType: "Observation", category: [{ coding: [{ system: THO + "observation-category", code: "lab", display: "Laboratory" }] }] };
  const r3 = rankSuggestions(await suggestUnknownCode(deps, cat, "Observation.category[0].coding[0].code", THO + "observation-category", "lab", { left: 4 }), 5);
  assert.equal(r3[0].value, "laboratory");
  assert.equal(r3[0].display, "Laboratory");
});

test("codes: binding → the small value set ranked by closeness", async () => {
  const deps = fakeDeps();
  const mr = { resourceType: "MedicationRequest", dosageInstruction: [{ timing: { repeat: { periodUnit: "hr" } } }] };
  const msg = "The value provided ('hr') was not found in the value set 'UnitsOfTime' (http://hl7.org/fhir/ValueSet/units-of-time|4.0.1), and a code is required from this value set";
  const r = rankSuggestions(await suggestBinding(deps, mr, "MedicationRequest.dosageInstruction[0].timing.repeat.periodUnit", msg.replace("|4.0.1", ""), { left: 4 }), 12);
  assert.equal(r[0].value, "h");
  assert.equal(r[0].kind, "choose_code");
  assert.equal(r.length, 7, "a small value set is offered whole");
});

test("references: caused_by = the target's own errors, else its errors against the required profile", async () => {
  const bundle = {
    resourceType: "Bundle",
    entry: [
      { fullUrl: "urn:uuid:a", resource: { resourceType: "Condition", subject: { reference: "urn:uuid:b" } } },
      { fullUrl: "urn:uuid:b", resource: { resourceType: "Patient" } },
    ],
  };
  const chain = { severity: "error", path: "Bundle.entry[0].resource.subject", code: "structure", message: "Unable to find a profile match for urn:uuid:b among choices: http://x/Patient-p" };
  const own = { severity: "error", path: "Bundle.entry[1].resource.gender", code: "code-invalid", message: "bad gender" };
  assert.deepEqual(await causedBy(fakeDeps(), bundle, chain, [chain, own], { left: 2 }), [
    { fullUrl: "urn:uuid:b", entry: 1, severity: "error", path: "Bundle.entry[1].resource.gender", message: "bad gender" },
  ]);
  const deps = fakeDeps({ validateAgainst: async () => [{ severity: "error", path: "Patient", message: "Patient.identifier: minimum required = 1" }, { severity: "warning", path: "Patient", message: "w" }] });
  assert.deepEqual(await causedBy(deps, bundle, chain, [chain], { left: 2 }), [
    { fullUrl: "urn:uuid:b", entry: 1, severity: "error", path: "Bundle.entry[1].resource", message: "Patient.identifier: minimum required = 1", profile: "http://x/Patient-p" },
  ]);
});


test("properties: remove_property when the name exists nowhere, with the level's element names and the resources that carry it", async () => {
  const deps = fakeDeps({ resourceElementPaths: async () => [{ type: "Encounter", paths: ["Encounter", "Encounter.reasonCode"] }, { type: "Procedure", paths: ["Procedure", "Procedure.reasonCode"] }, { type: "Observation", paths: ["Observation", "Observation.code"] }] });
  const r = rankSuggestions(await suggestProperty(deps, { resourceType: "Observation", status: "final", reasonCode: [{ text: "x" }] }, "Observation", "reasonCode"), 5);
  assert.equal(r.length, 1);
  assert.equal(r[0].kind, "remove_property");
  assert.equal(r[0].value, "reasonCode");
  assert.equal(r[0].confidence, 0.5);
  assert.deepEqual(r[0].patch, { op: "remove", path: "Observation.reasonCode" });
  assert.match(r[0].reason, /no element named 'reasonCode' on Observation/);
  assert.match(r[0].reason, /'reasonCode' is an element of Encounter, Procedure/);
  assert.match(r[0].reason, /elements of Observation are: status, code, effective\[x\], value\[x\], note$/);
  // No element-path collaborator: the same suggestion without the carrier list.
  const r2 = await suggestProperty(fakeDeps(), { resourceType: "Observation", foo: 1 }, "Observation", "foo");
  assert.equal(r2.length, 1);
  assert.equal(r2[0].kind, "remove_property");
  assert.doesNotMatch(r2[0].reason, /is an element of/);
});

test("properties: evidence rename from short text / alias / synonyms, gated by the value shape; remove ranks below it", async () => {
  const mr = { resourceType: "MedicationRequest", dosageInstruction: [{ timing: { repeat: { frequency: 1, periodUnit: "h", every: 8 } } }] };
  const r = rankSuggestions(await suggestProperty(fakeDeps(), mr, "MedicationRequest.dosageInstruction[0].timing.repeat", "every"), 5);
  assert.deepEqual(r.map((s) => `${s.kind}:${s.value}`), ["rename_property:period", "rename_property:periodMax", "remove_property:every"]);
  assert.ok(r[0].confidence < 0.68 && r[0].confidence > r[1].confidence && r[1].confidence > r[2].confidence, JSON.stringify(r));
  assert.equal(r[2].confidence, 0.4, "remove below an evidence rename");
  assert.match(r[0].reason, /'period' \("Event occurs frequency times per period"\) means the same and the value fits its type/);
  assert.deepEqual(r[0].patch, { op: "move", from: "MedicationRequest.dosageInstruction[0].timing.repeat.every", path: "MedicationRequest.dosageInstruction[0].timing.repeat.period" });
  // A string cannot be a decimal: the rename is dropped, remove stays (alone, so 0.5).
  const bad = { resourceType: "MedicationRequest", dosageInstruction: [{ timing: { repeat: { periodUnit: "h", every: "eight" } } }] };
  const rb = await suggestProperty(fakeDeps(), bad, "MedicationRequest.dosageInstruction[0].timing.repeat", "every");
  assert.deepEqual(rb.map((s) => `${s.kind}:${s.value}@${s.confidence}`), ["remove_property:every@0.5"]);
  // Alias ('Zip' on Address.postalCode), whole-name synonym (dob), Range.high from "High limit" + the upper/high group.
  const zip = await suggestProperty(fakeDeps(), { resourceType: "Patient", address: [{ city: "Taipei", zip: "100" }] }, "Patient.address[0]", "zip");
  assert.equal(zip[0].value, "postalCode");
  assert.match(zip[0].reason, /alias 'Zip'/);
  const dob = await suggestProperty(fakeDeps(), { resourceType: "Patient", dob: "1990-01-01" }, "Patient", "dob");
  assert.equal(dob[0].value, "birthDate");
  const high = rankSuggestions(await suggestProperty(fakeDeps(), { resourceType: "Observation", valueRange: { low: { value: 1 }, upperLimit: { value: 5 } } }, "Observation.valueRange", "upperLimit"), 5);
  assert.equal(high[0].value, "high");
  assert.equal(high[0].kind, "rename_property");
  // A string into an Annotation-typed element: allowed as a restructuring (Annotation.text takes it), flagged in the reason.
  const note = await suggestProperty(fakeDeps(), { resourceType: "Observation", comment: "x" }, "Observation", "comment");
  assert.equal(note[0].value, "note");
  assert.match(note[0].reason, /restructured as Annotation/);
  // A number into a Period (no child takes a number): no rename, remove only.
  const every = await suggestProperty(fakeDeps(), { resourceType: "Patient", contact: [{ every: 2 }] }, "Patient.contact[0]", "every");
  assert.deepEqual(every.map((s) => s.kind), ["remove_property"]);
});

test("properties: moves reach datatype children anywhere, nearest route first, absent repeating elements indexed", async () => {
  // A descendant two levels down through an absent repeating element.
  const city = await suggestProperty(fakeDeps(), { resourceType: "Patient", city: "Taipei" }, "Patient", "city");
  assert.equal(city[0].kind, "move_property");
  assert.equal(city[0].value, "Patient.address[0].city");
  assert.deepEqual(city[0].patch, { op: "move", from: "Patient.city", path: "Patient.address[0].city" });
  // A sibling datatype of the ancestor (HumanName under contact → Patient.address), via the parent's children.
  const fam = await suggestProperty(fakeDeps(), { resourceType: "Patient", contact: [{ name: { given: ["A"] }, city: "Taipei" }] }, "Patient.contact[0]", "city");
  assert.equal(fam[0].value, "Patient.address[0].city");
  // Period is reachable under contact.period (depth 2) and nowhere nearer: the nearest route is reported once.
  const start = await suggestProperty(fakeDeps(), { resourceType: "Patient", start: "2020-01-01" }, "Patient", "start");
  assert.deepEqual(start.filter((s) => s.kind === "move_property").map((s) => s.value), ["Patient.contact[0].period.start"]);
  // A choice value that is present is searched (Quantity under valueQuantity); a stem at another level takes the fitting typed name.
  const unit = await suggestProperty(fakeDeps(), { resourceType: "Observation", valueQuantity: { value: 1 }, unit: "mg" }, "Observation", "unit");
  assert.equal(unit[0].value, "Observation.valueQuantity.unit");
  const dose = await suggestProperty(fakeDeps(), { resourceType: "MedicationRequest", dose: { value: 1, unit: "mg" } }, "MedicationRequest", "dose");
  assert.equal(dose[0].value, "MedicationRequest.dosageInstruction[0].doseAndRate[0].doseQuantity");
  assert.match(dose[0].reason, /'dose' is a choice element of Dosage.doseAndRate/);
  // Parent-level evidence move when nothing exact exists (`comment` under Dosage → MedicationRequest.note needs a note element: here Patient.contact → Patient.gender for `sex`).
  const sex = await suggestProperty(fakeDeps(), { resourceType: "Patient", contact: [{ sex: "male" }] }, "Patient.contact[0]", "sex");
  assert.deepEqual(sex.map((s) => `${s.kind}:${s.value}`), ["move_property:Patient.gender", "remove_property:sex"]);
  assert.ok(sex[0].confidence <= 0.6 && sex[0].confidence > sex[1].confidence);
  // Exact and case renames outrank everything; a typo rename never matches a short fragment inside a long name (`age` in `language`).
  const age = await suggestProperty(fakeDeps(), { resourceType: "Patient", age: 30 }, "Patient", "age");
  assert.deepEqual(age.map((s) => s.kind), ["remove_property"]);
});

test("attachSuggestions: additive only, deterministic, fail-open", async () => {
  const res = {
    resourceType: "MedicationRequest",
    status: "active",
    medicationCodeableConcept: { text: "x" },
    dosageInstruction: [{ timing: { repeat: { periodUnits: "d" } }, doseAndRate: [{ doseQuantity: { value: 1, system: "http://unitsofmeasure.org", code: "tab" } }] }],
  };
  const mk = () => [
    { severity: "error", path: "MedicationRequest.dosageInstruction[0].timing.repeat", code: "structure", message: "Unrecognized property 'periodUnits'" },
    { severity: "error", path: "MedicationRequest.dosageInstruction[0].doseAndRate[0].doseQuantity.code", code: "code-invalid", message: "Unknown code 'tab' in the CodeSystem 'http://unitsofmeasure.org' version '2.2'" },
    { severity: "error", path: "MedicationRequest", code: "invariant", message: "Constraint failed: x" },
  ];
  const a = mk();
  await attachSuggestions(a, res, fakeDeps());
  const b = mk();
  await attachSuggestions(b, res, fakeDeps());
  assert.deepEqual(a, b, "deterministic");
  const strip = (xs: any[]) => xs.map(({ suggestions, caused_by, ...r }) => r);
  assert.deepEqual(strip(a), mk(), "existing fields unchanged");
  assert.equal(a[0].suggestions[0].value, "periodUnit");
  assert.equal(a[1].suggestions[0].value, "{tablet}");
  assert.deepEqual(a[1].suggestions[0].patch, { op: "replace", path: "MedicationRequest.dosageInstruction[0].doseAndRate[0].doseQuantity.code", value: "{tablet}" });
  assert.equal("suggestions" in a[2], false, "no suggester → no field");
  // Every collaborator throwing → no suggestions from them, no exception.
  const boom = async (): Promise<never> => {
    throw new Error("down");
  };
  const c = mk();
  await attachSuggestions(c, res, { fetchStructureDefinition: boom, checkCode: boom, normalize: boom, expandValueSet: boom });
  assert.deepEqual(strip(c), mk());
  assert.equal("suggestions" in c[0], false);
  assert.equal(suggestionCategory({ severity: "information", message: "Unrecognized property 'x'" }), null, "information issues are left alone");
});

const CACHE = process.env.FHIR_PACKAGE_CACHE;
test("acceptance: fixture evaluation on the TW Core closure (needs FHIR_PACKAGE_CACHE)", { skip: !CACHE || !existsSync(join(CACHE, "hl7.fhir.r4.core#4.0.1")) }, async () => {
  const { FilePackages } = await import("../../scripts/suggestions-eval/fileDeps.js");
  const { runEval } = await import("../../scripts/suggestions-eval/evalSuggestions.js");
  const { FIXTURES, HELDOUT } = await import("../../scripts/suggestions-eval/fixtures.js");
  const pk = new FilePackages(CACHE!);
  for (const set of [FIXTURES, HELDOUT]) {
    const { rows, mutated } = await runEval(pk, set);
    const det = rows.filter((r) => r.detected);
    assert.deepEqual(mutated, []);
    assert.ok(rows.filter((r) => r.covered).length / det.length >= 0.9, "coverage ≥ 90 %");
    assert.ok(rows.filter((r) => r.correct).length / det.length >= 0.8, "top-1 ≥ 80 %");
  }
});

test("parseValidDisplays ignores the language note and the different-concept clause", () => {
  const msg = "Wrong Display Name 'Clopidogrel 75 MG Oral Tablet' for http://www.nlm.nih.gov/research/umls/rxnorm#313375. Valid display is 'thyroglobulin 100 MG Oral Tablet' (for the language(s) 'en'); the display denotes a different concept: none of its drug-name words (clopidogrel) appears in any RxNorm name of this code";
  assert.deepEqual(parseValidDisplays(msg), ["thyroglobulin 100 MG Oral Tablet"]);
});
