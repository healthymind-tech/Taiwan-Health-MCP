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
]) {
  SDS[s.url] = s;
}

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
  assert.equal(r3[0].value, "MedicationRequest.dosageInstruction[0].doseAndRate.doseQuantity");
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
