/**
 * Unit tests of the binding-aware suggesters (fhirSuggestions/bindings.ts, ISSUES_v10 A) and of
 * the budget / small-ValueSet behaviour they rely on. Pure: hand-built StructureDefinitions
 * (a profile with slices, a base resource, core datatypes) and fake collaborators, no DB.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { CodeCheck } from "../fhirValidator.js";
import { el, sd } from "../fhirTestKit.test.js";
import { elementBindings, suggestBoundCoding, suggestCrossSystem, suggestMoveValue, valueSetSystems } from "./bindings.js";
import { suggestBinding } from "./codes.js";
import { attachSuggestions } from "./index.js";
import type { SuggestionDeps } from "./types.js";
import { rankSuggestions } from "./util.js";

const CORE = "http://hl7.org/fhir/StructureDefinition/";
const THO = "http://terminology.hl7.org/CodeSystem/";
const IG = "https://example.org/ig/";
const SCT = "http://snomed.info/sct";
const PATIENT_PROFILE = IG + "StructureDefinition/Patient-x";
const MEDREQ_PROFILE = IG + "StructureDefinition/MedicationRequest-x";
const VS_ID_TYPE = "http://hl7.org/fhir/ValueSet/identifier-type";
const VS_ID_TYPE_X = IG + "ValueSet/identifier-type-x";
const VS_ROUTE = "http://hl7.org/fhir/ValueSet/route-codes";
const VS_ROUTE_X = IG + "ValueSet/medication-route-x";
const VS_CRIT = "http://hl7.org/fhir/ValueSet/allergy-intolerance-criticality";
const VS_SEV = "http://hl7.org/fhir/ValueSet/reaction-event-severity";
const VS_CAT = "http://hl7.org/fhir/ValueSet/allergy-intolerance-category";
const CS_V2_0203 = THO + "v2-0203";
const CS_V2_0203_X = IG + "CodeSystem/v2-0203";
const CS_ROUTE_X = IG + "CodeSystem/medication-route-x";
const CS_CRIT = "http://hl7.org/fhir/allergy-intolerance-criticality";
const CS_SEV = "http://hl7.org/fhir/reaction-event-severity";
const CS_CAT = "http://hl7.org/fhir/allergy-intolerance-category";

const bind = (strength: string, valueSet: string): Record<string, any> => ({ binding: { strength, valueSet } });

const SDS: Record<string, Record<string, any>> = {};
for (const s of [
  sd(CORE + "Patient", "Patient", "resource", [el("Patient", 0, "*"), el("Patient.identifier", 0, "*", ["Identifier"]), el("Patient.gender", 0, "1", ["code"], bind("required", "http://hl7.org/fhir/ValueSet/administrative-gender"))]),
  // A profile: identifier slices whose `type` is bound to the IG's own ValueSet (the base binding stays on Patient.identifier.type).
  sd(PATIENT_PROFILE, "Patient", "resource", [
    el("Patient", 0, "*"),
    el("Patient.identifier", 1, "*", ["Identifier"]),
    el("Patient.identifier.type", 0, "1", ["CodeableConcept"], bind("extensible", VS_ID_TYPE)),
    el("Patient.identifier:mr", 0, "1", ["Identifier"]),
    el("Patient.identifier:mr.type", 1, "1", ["CodeableConcept"], bind("extensible", VS_ID_TYPE_X)),
    el("Patient.identifier:mr.type.coding", 1, "*", ["Coding"]),
    el("Patient.gender", 0, "1", ["code"], bind("required", "http://hl7.org/fhir/ValueSet/administrative-gender")),
  ]),
  sd(CORE + "Identifier", "Identifier", "complex-type", [el("Identifier", 0, "*"), el("Identifier.type", 0, "1", ["CodeableConcept"], bind("extensible", VS_ID_TYPE)), el("Identifier.system", 0, "1", ["uri"]), el("Identifier.value", 0, "1", ["string"])]),
  sd(CORE + "CodeableConcept", "CodeableConcept", "complex-type", [el("CodeableConcept", 0, "*"), el("CodeableConcept.coding", 0, "*", ["Coding"]), el("CodeableConcept.text", 0, "1", ["string"])]),
  sd(CORE + "Coding", "Coding", "complex-type", [el("Coding", 0, "*"), el("Coding.system", 0, "1", ["uri"]), el("Coding.code", 0, "1", ["code"]), el("Coding.display", 0, "1", ["string"])]),
  sd(CORE + "MedicationRequest", "MedicationRequest", "resource", [el("MedicationRequest", 0, "*"), el("MedicationRequest.status", 1, "1", ["code"]), el("MedicationRequest.dosageInstruction", 0, "*", ["Dosage"])]),
  // A profile binding the Coding under route (the base Dosage.route binding is an example binding).
  sd(MEDREQ_PROFILE, "MedicationRequest", "resource", [
    el("MedicationRequest", 0, "*"),
    el("MedicationRequest.dosageInstruction", 0, "*", ["Dosage"]),
    el("MedicationRequest.dosageInstruction.route", 0, "1", ["CodeableConcept"], bind("example", VS_ROUTE)),
    el("MedicationRequest.dosageInstruction.route.coding", 0, "*", ["Coding"], bind("extensible", VS_ROUTE_X)),
  ]),
  sd(CORE + "Dosage", "Dosage", "complex-type", [el("Dosage", 0, "*"), el("Dosage.text", 0, "1", ["string"]), el("Dosage.route", 0, "1", ["CodeableConcept"], bind("example", VS_ROUTE))]),
  sd(CORE + "AllergyIntolerance", "AllergyIntolerance", "resource", [
    el("AllergyIntolerance", 0, "*"),
    el("AllergyIntolerance.category", 0, "*", ["code"], bind("required", VS_CAT)),
    el("AllergyIntolerance.criticality", 0, "1", ["code"], bind("required", VS_CRIT)),
    el("AllergyIntolerance.code", 0, "1", ["CodeableConcept"], bind("extensible", "http://hl7.org/fhir/ValueSet/allergyintolerance-code")),
    el("AllergyIntolerance.reaction", 0, "*", ["BackboneElement"]),
    el("AllergyIntolerance.reaction.severity", 0, "1", ["code"], bind("required", VS_SEV)),
  ]),
]) {
  SDS[s.url] = s;
}

const CODES: Record<string, Record<string, string>> = {
  [CS_V2_0203]: { MR: "Medical record number", PPN: "Passport number", DL: "Driver's license number" },
  [CS_V2_0203_X]: { GOI: "Government Organization Identifier", UBN: "Unified Business number" },
  [CS_ROUTE_X]: { PO: "口服", IV: "靜脈注射" },
  [SCT]: { "26643006": "Oral route", "47625008": "Intravenous route" },
  [CS_CRIT]: { low: "Low Risk", high: "High Risk", "unable-to-assess": "Unable to Assess Risk" },
  [CS_SEV]: { mild: "Mild", moderate: "Moderate", severe: "Severe" },
  [CS_CAT]: { food: "Food", medication: "Medication", environment: "Environment", biologic: "Biologic" },
};

const VALUESETS: Record<string, Record<string, any>> = {
  [VS_ID_TYPE]: { url: VS_ID_TYPE, compose: { include: [{ system: CS_V2_0203, concept: [{ code: "MR" }, { code: "DL" }] }] } },
  [VS_ID_TYPE_X]: { url: VS_ID_TYPE_X, compose: { include: [{ system: CS_V2_0203 }, { system: CS_V2_0203_X, concept: [{ code: "GOI" }, { code: "UBN" }] }] } },
  [VS_ROUTE]: { url: VS_ROUTE, compose: { include: [{ system: SCT, filter: [{ property: "concept", op: "is-a", value: "284009009" }] }] } },
  [VS_ROUTE_X]: { url: VS_ROUTE_X, compose: { include: [{ system: SCT, concept: [{ code: "26643006" }, { code: "47625008" }] }, { system: CS_ROUTE_X }] } },
  [VS_CRIT]: { url: VS_CRIT, compose: { include: [{ system: CS_CRIT }] } },
  [VS_SEV]: { url: VS_SEV, compose: { include: [{ system: CS_SEV }] } },
  [VS_CAT]: { url: VS_CAT, compose: { include: [{ system: CS_CAT }] } },
};

/** Membership from the composes above (explicit concept lists honoured). */
function member(vsUrl: string, system: string | null, code: string): boolean | undefined {
  const vs = VALUESETS[vsUrl.split("|")[0]];
  if (!vs) return undefined;
  for (const inc of vs.compose.include) {
    if (system && inc.system !== system) continue;
    if (inc.filter) return undefined;
    if (inc.concept) {
      if (inc.concept.some((c: any) => c.code === code)) return true;
    } else if (CODES[inc.system] && code in CODES[inc.system]) return true;
  }
  return false;
}

function fakeDeps(over: Partial<SuggestionDeps> = {}): SuggestionDeps {
  return {
    fetchStructureDefinition: async (url) => SDS[url.split("|")[0]] ?? null,
    checkCode: async (system, code): Promise<CodeCheck> => {
      const t = CODES[system];
      if (!t) return { status: "unknown-system" };
      return code in t ? { status: "ok" } : { status: "invalid-code", severity: "error", message: `Unknown code '${code}' in the CodeSystem '${system}'` };
    },
    loadValueSet: async (url) => VALUESETS[url.split("|")[0]] ?? null,
    valueSetContains: async (url, system, code) => member(url, system, code),
    expandValueSet: async (url) => {
      const vs = VALUESETS[url.split("|")[0]];
      if (!vs || vs.compose.include.some((i: any) => i.filter)) return null;
      const codings: Array<{ system: string | null; code: string; display: string | null }> = [];
      for (const inc of vs.compose.include) for (const [code, display] of Object.entries(CODES[inc.system] ?? {})) if (!inc.concept || inc.concept.some((c: any) => c.code === code)) codings.push({ system: inc.system, code, display });
      return { codings, total: codings.length, truncated: false };
    },
    normalize: async (text, target) => {
      // A stand-in for fhir_normalize_code: the IG route ValueSet knows that "oral" is the oral route.
      if (target.valueSet === VS_ROUTE_X && text.toLowerCase() === "oral") {
        return [
          { system: SCT, code: "26643006", display: "Oral route", score: 0.8 },
          { system: CS_ROUTE_X, code: "PO", display: "口服", score: 0.7 },
        ];
      }
      return [];
    },
    canonicalsUnder: async (prefix, types) => (types.includes("CodeSystem") ? Object.keys(CODES).filter((u) => u.startsWith(prefix)).sort() : []),
    ...over,
  };
}

const bundleWith = (resource: Record<string, any>): Record<string, any> => ({ resourceType: "Bundle", type: "collection", entry: [{ fullUrl: "urn:uuid:a", resource: { resourceType: "Patient" } }, { fullUrl: "urn:uuid:b", resource }] });

test("elementBindings: profile slices, the base datatype binding, the .coding child; Bundle entries", async () => {
  const pat = { resourceType: "Patient", meta: { profile: [PATIENT_PROFILE] }, identifier: [{ type: { coding: [{ system: CS_V2_0203_X, code: "MR" }] }, system: "urn:x", value: "1" }] };
  const b = await elementBindings(fakeDeps(), bundleWith(pat), "Bundle.entry[1].resource.identifier[0].type.coding[0]");
  assert.ok(b);
  assert.equal(b.resourceType, "Patient");
  assert.equal(b.resourcePath, "Bundle.entry[1].resource");
  assert.equal(b.elementPath, "Patient.identifier.type.coding");
  // Both at depth 1 and extensible: the slice's ValueSet first, deduplicated.
  assert.deepEqual(b.bindings.map((x) => x.valueSet), [VS_ID_TYPE_X, VS_ID_TYPE]);
  assert.ok(b.bindings.every((x) => x.depth === 1 && x.strength === "extensible"));
  // Without the profile: only the datatype's binding (reached through Identifier).
  const base = await elementBindings(fakeDeps(), { ...pat, meta: undefined }, "Patient.identifier[0].type");
  assert.deepEqual(base!.bindings.map((x) => [x.valueSet, x.depth, x.element]), [[VS_ID_TYPE, 0, "Identifier.type"]]);
  // The validation's profiles apply to the root resource; a Coding under route sees the profile's .coding binding first.
  const mr = { resourceType: "MedicationRequest", status: "active", dosageInstruction: [{ route: { coding: [{ system: "http://x", code: "oral" }] } }] };
  const r = await elementBindings(fakeDeps(), mr, "MedicationRequest.dosageInstruction[0].route.coding[0]", { profiles: [MEDREQ_PROFILE] });
  assert.deepEqual(r!.bindings.map((x) => [x.valueSet, x.depth, x.strength]), [[VS_ROUTE_X, 0, "extensible"], [VS_ROUTE, 1, "example"]]);
  const vs = await valueSetSystems(fakeDeps(), VS_ID_TYPE_X);
  assert.deepEqual(vs.map((s) => [s.system, s.codes ? [...s.codes] : null, s.filtered]), [[CS_V2_0203, null, false], [CS_V2_0203_X, ["GOI", "UBN"], false]]);
});

test("A1 suggestCrossSystem: the code exists in another CodeSystem of the bound ValueSet → replace_system 0.9", async () => {
  const pat = { resourceType: "Patient", meta: { profile: [PATIENT_PROFILE] }, identifier: [{ type: { coding: [{ system: CS_V2_0203_X, code: "MR" }] }, system: "urn:x", value: "1" }] };
  const r = rankSuggestions(await suggestCrossSystem(fakeDeps(), bundleWith(pat), "Bundle.entry[1].resource.identifier[0].type.coding[0].code", CS_V2_0203_X, "MR"), 5);
  assert.equal(r.length, 1);
  assert.equal(r[0].kind, "replace_system");
  assert.equal(r[0].value, CS_V2_0203);
  assert.equal(r[0].confidence, 0.9);
  // The slice's ValueSet (whole system) is named, not the base one that enumerates a few codes.
  assert.match(r[0].reason, /not in .*v2-0203 but exists in http:\/\/terminology\.hl7\.org\/CodeSystem\/v2-0203, which the bound ValueSet identifier-type-x \(extensible\) also includes/);
  assert.deepEqual(r[0].patch, { op: "replace", path: "Bundle.entry[1].resource.identifier[0].type.coding[0].system", value: CS_V2_0203 });
  // The ValueSet enumerates only some codes of the other system and the code is not among them: still offered, lower.
  const base = { resourceType: "Patient", identifier: [{ type: { coding: [{ system: CS_V2_0203_X, code: "PPN" }] }, system: "urn:x", value: "1" }] };
  const r2 = await suggestCrossSystem(fakeDeps(), base, "Patient.identifier[0].type.coding[0].code", CS_V2_0203_X, "PPN");
  assert.equal(r2.length, 1);
  assert.equal(r2[0].value, CS_V2_0203);
  assert.equal(r2[0].confidence, 0.6);
  assert.match(r2[0].reason, /includes only some codes of v2-0203, not 'PPN'/);
  // No binding at all (an element the definitions do not know): the CodeSystem of the same name under another base.
  const noBind = { resourceType: "Patient", foo: { coding: [{ system: CS_V2_0203_X, code: "DL" }] } };
  const r3 = await suggestCrossSystem(fakeDeps(), noBind, "Patient.foo.coding[0].code", CS_V2_0203_X, "DL");
  assert.equal(r3.length, 1);
  assert.equal(r3[0].confidence, 0.8);
  assert.match(r3[0].reason, /the CodeSystem of the same name \(v2-0203\)/);
  // A code that exists nowhere else: nothing (never a guess).
  assert.deepEqual(await suggestCrossSystem(fakeDeps(), pat, "Patient.identifier[0].type.coding[0].code", CS_V2_0203_X, "ZZZ"), []);
});

test("A2 suggestBoundCoding: unknown Coding.system → codes of the bound ValueSets (normalised), then their CodeSystems", async () => {
  const mr = { resourceType: "MedicationRequest", status: "active", dosageInstruction: [{ route: { coding: [{ system: THO + "route", code: "oral", display: "oral" }] } }] };
  const budget = { left: 2 };
  const r = rankSuggestions(await suggestBoundCoding(fakeDeps(), mr, "MedicationRequest.dosageInstruction[0].route.coding[0].system", THO + "route", budget, { profiles: [MEDREQ_PROFILE] }), 8);
  assert.equal(budget.left, 0, "one normalize call per bound ValueSet, within the budget");
  assert.deepEqual(r.slice(0, 2).map((s) => [s.kind, s.system, s.value, s.display]), [
    ["replace_coding", SCT, "26643006", "Oral route"],
    ["replace_coding", CS_ROUTE_X, "PO", "口服"],
  ]);
  assert.equal(r[0].confidence, 0.8);
  assert.equal(r[1].confidence, 0.75);
  assert.deepEqual(r[0].patch, { op: "replace", path: "MedicationRequest.dosageInstruction[0].route.coding[0]", value: { system: SCT, code: "26643006", display: "Oral route" } });
  assert.match(r[0].reason, /is not a known CodeSystem; MedicationRequest\.dosageInstruction\.route\.coding is bound to medication-route-x \(extensible\), where 'oral' matches/);
  // The systems themselves, lower ('oral' is not a code of either).
  const systems = r.filter((s) => s.kind === "replace_system");
  assert.deepEqual(systems.map((s) => [s.value, s.confidence]), [[SCT, 0.35], [CS_ROUTE_X, 0.35]]);
  assert.deepEqual(systems[0].patch, { op: "replace", path: "MedicationRequest.dosageInstruction[0].route.coding[0].system", value: SCT });
  // No budget: only the systems; a system that holds the code ranks first.
  const mr2 = { resourceType: "MedicationRequest", status: "active", dosageInstruction: [{ route: { coding: [{ system: THO + "route", code: "PO" }] } }] };
  const r2 = rankSuggestions(await suggestBoundCoding(fakeDeps(), mr2, "MedicationRequest.dosageInstruction[0].route.coding[0].system", THO + "route", { left: 0 }, { profiles: [MEDREQ_PROFILE] }), 8);
  assert.deepEqual(r2.map((s) => [s.kind, s.value, s.confidence]), [["replace_system", CS_ROUTE_X, 0.9], ["replace_system", SCT, 0.35]]);
  assert.match(r2[0].reason, /code 'PO' exists in it/);
  // No binding known for the element: nothing.
  assert.deepEqual(await suggestBoundCoding(fakeDeps(), { resourceType: "Patient", foo: { system: THO + "route", code: "x" } }, "Patient.foo.system", THO + "route", { left: 2 }), []);
});

test("A3 suggestMoveValue: a value that is a valid code of another bound element of the resource → move_value", async () => {
  const ai = { resourceType: "AllergyIntolerance", criticality: "severe", reaction: [{ description: "rash" }] };
  const r = await suggestMoveValue(fakeDeps(), bundleWith(ai), "Bundle.entry[1].resource.criticality", VS_CRIT + "|4.0.1");
  assert.equal(r.length, 1);
  assert.equal(r[0].kind, "move_value");
  assert.equal(r[0].value, "Bundle.entry[1].resource.reaction[0].severity");
  assert.equal(r[0].confidence, 0.6);
  assert.deepEqual(r[0].patch, { op: "move", from: "Bundle.entry[1].resource.criticality", path: "Bundle.entry[1].resource.reaction[0].severity" });
  assert.match(r[0].reason, /'severe' is not in allergy-intolerance-criticality but is a valid code of AllergyIntolerance\.reaction\.severity \(ValueSet reaction-event-severity, required\)/);
  // The target already has a value: still offered, lower, and said so.
  const taken = { resourceType: "AllergyIntolerance", criticality: "severe", reaction: [{ severity: "mild" }] };
  const r2 = await suggestMoveValue(fakeDeps(), taken, "AllergyIntolerance.criticality", VS_CRIT);
  assert.equal(r2[0].confidence, 0.45);
  assert.match(r2[0].reason, /already has a value/);
  // A repeating target that is absent gets `[0]`; a bare code never moves into a CodeableConcept element.
  const cat = { resourceType: "AllergyIntolerance", criticality: "food" };
  const r3 = await suggestMoveValue(fakeDeps(), cat, "AllergyIntolerance.criticality", VS_CRIT);
  assert.deepEqual(r3.map((s) => s.value), ["AllergyIntolerance.category[0]"]);
  // A value that no other element accepts: nothing.
  assert.deepEqual(await suggestMoveValue(fakeDeps(), { resourceType: "AllergyIntolerance", criticality: "extreme" }, "AllergyIntolerance.criticality", VS_CRIT), []);
});

test("binding: a small value set is always listed (no budget needed) and ranked by meaning when a similarity collaborator exists", async () => {
  const ai = { resourceType: "AllergyIntolerance", criticality: "severe" };
  const msg = `The value provided ('severe') was not found in the value set 'AllergyIntoleranceCriticality' (${VS_CRIT}|4.0.1), and a code is required from this value set`;
  const noBudget = rankSuggestions(await suggestBinding(fakeDeps(), ai, "AllergyIntolerance.criticality", msg, { left: 0 }), 50);
  assert.equal(noBudget.length, 3, "the whole small value set, even without lookup budget");
  assert.ok(noBudget.every((s) => s.kind === "choose_code" && /one of all 3 codes/.test(s.reason)));
  // Semantic ranking: the similarity collaborator orders the codes; the closest in meaning comes first.
  const sims: Record<string, number> = { "Low Risk": 0.31, "High Risk": 0.62, "Unable to Assess Risk": 0.28 };
  const deps = fakeDeps({ similarity: async (_text, cands) => cands.map((c) => sims[c] ?? 0) });
  const budget = { left: 1 };
  const ranked = rankSuggestions(await suggestBinding(deps, ai, "AllergyIntolerance.criticality", msg, budget), 50);
  assert.equal(budget.left, 0, "the similarity lookup is the issue's one expensive call");
  assert.deepEqual(ranked.map((s) => s.value), ["high", "low", "unable-to-assess"]);
  assert.equal(ranked[0].confidence, 0.65);
  assert.match(ranked[0].reason, /closest in meaning to 'severe'/);
  assert.deepEqual(ranked[0].patch, { op: "replace", path: "AllergyIntolerance.criticality", value: "high" });
  // A similarity collaborator that fails leaves the lexical order (fail-open).
  const broken = fakeDeps({ similarity: async () => null });
  const lex = rankSuggestions(await suggestBinding(broken, ai, "AllergyIntolerance.criticality", msg, { left: 1 }), 50);
  assert.equal(lex.length, 3);
  assert.ok(lex.every((s) => s.confidence < 0.6));
});

test("attachSuggestions: every binding issue is listed (expansion is not budgeted), move_value and the small-set codes together", async () => {
  // Twelve resources' worth of binding errors in one Bundle: formerly only the first ten remote-category issues got anything.
  const entries = Array.from({ length: 12 }, (_, i) => ({ fullUrl: `urn:uuid:${i}`, resource: { resourceType: "AllergyIntolerance", id: String(i), criticality: "severe" } }));
  const bundle = { resourceType: "Bundle", type: "collection", entry: entries };
  const issues = entries.map((_, i) => ({
    severity: "error",
    path: `Bundle.entry[${i}].resource.criticality`,
    code: "code-invalid",
    message: `The value provided ('severe') was not found in the value set 'AllergyIntoleranceCriticality' (${VS_CRIT}|4.0.1), and a code is required from this value set`,
  }));
  await attachSuggestions(issues as Array<Record<string, any>>, bundle, fakeDeps());
  for (const [i, iss] of issues.entries()) {
    const s = (iss as any).suggestions as any[];
    assert.ok(s && s.length === 4, `issue ${i}: 3 codes + 1 move, got ${JSON.stringify(s)}`);
    assert.equal(s[0].kind, "move_value", "without a semantic signal the sibling element outranks the unrelated codes");
    assert.equal(s[0].value, `Bundle.entry[${i}].resource.reaction[0].severity`);
    assert.ok(s.some((x) => x.kind === "choose_code" && x.value === "high"));
  }
  // The validator's fields are untouched.
  assert.deepEqual(Object.keys(issues[0]).sort(), ["code", "message", "path", "severity", "suggestions"]);
});

test("attachSuggestions: an unknown Coding.system gets the bound ValueSets' Coding (A2 end to end), spelled like the validator reports it", async () => {
  const mr = { resourceType: "MedicationRequest", status: "active", dosageInstruction: [{ route: { coding: [{ system: THO + "route", code: "oral", display: "oral" }] } }] };
  const issues = [{ severity: "error", path: "MedicationRequest.dosageInstruction[0].route.coding[0].system", code: "invalid", message: `No definition could be found for URL value '${THO}route'` }];
  await attachSuggestions(issues as Array<Record<string, any>>, mr, fakeDeps(), { profiles: [MEDREQ_PROFILE] });
  const s = (issues[0] as any).suggestions as any[];
  assert.equal(s[0].kind, "replace_coding");
  assert.equal(s[0].system, SCT);
  assert.equal(s[0].value, "26643006");
  // No lookup budget left: the bound ValueSets' CodeSystems only, the one holding the code first.
  const po = { resourceType: "MedicationRequest", status: "active", dosageInstruction: [{ route: { coding: [{ system: THO + "route", code: "PO" }] } }] };
  const issues2 = [{ severity: "error", path: issues[0].path, code: "invalid", message: issues[0].message }];
  await attachSuggestions(issues2 as Array<Record<string, any>>, po, fakeDeps(), { profiles: [MEDREQ_PROFILE], maxRemoteCalls: 0 });
  const s2 = (issues2[0] as any).suggestions as any[];
  assert.ok(s2.every((x) => x.kind === "replace_system"), JSON.stringify(s2));
  assert.deepEqual([s2[0].value, s2[0].confidence], [CS_ROUTE_X, 0.9]);
});

test("v13 suggestBoundCoding: a ValueSet canonical as the system → normalised within it / its CodeSystems, then its CodeSystems", async () => {
  // The route ValueSet written as the system of a Coding under an element with no binding of its own.
  const pat = { resourceType: "Patient", foo: { system: VS_ROUTE_X, code: "oral" } };
  const calls: Array<Record<string, unknown>> = [];
  const deps = fakeDeps({
    normalize: async (text, target) => {
      calls.push(target);
      if (target.system === SCT && text === "oral") return [{ system: SCT, code: "26643006", display: "Oral route", score: 0.8 }];
      return [];
    },
  });
  const r = rankSuggestions(await suggestBoundCoding(deps, pat, "Patient.foo.system", VS_ROUTE_X, { left: 2 }, {}, true), 8);
  // the ValueSet itself first (no candidates), then its first CodeSystem — two calls, the budget
  assert.deepEqual(calls, [{ valueSet: VS_ROUTE_X }, { system: SCT }]);
  assert.deepEqual(r.map((s) => [s.kind, s.value]), [["replace_coding", "26643006"], ["replace_system", SCT], ["replace_system", CS_ROUTE_X]]);
  assert.match(r[0].reason, /is a ValueSet, not a CodeSystem; in http:\/\/snomed\.info\/sct, which the ValueSet medication-route-x includes, 'oral' matches/);
  assert.match(r[1].reason, /is a ValueSet, not a CodeSystem; the ValueSet medication-route-x draws codes from/);
  // without the flag (an unknown URL) an unbound element gets nothing, as before
  assert.deepEqual(await suggestBoundCoding(deps, pat, "Patient.foo.system", VS_ROUTE_X, { left: 2 }), []);
});
