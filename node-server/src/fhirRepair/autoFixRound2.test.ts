/**
 * ISSUES_v19 R1 round 2 — layer-1 fixes of fhir_finalize_bundle with exactly one correct fix, on synthetic
 * definitions (no DB): the display of a determined code (refused when another code of the system has that name, the
 * display shares too few words with the code's names, or a required binding rejects the code), the system a bound
 * ValueSet holds the code + display under, a code written in the wrong element moved to the one sibling whose required
 * ValueSet holds it, a string element given as {text}, and the guard's exposed_errors = allow_under_moved; on FHIR R4
 * core (package cache): an STU3 duplicate removed, performer.reference moved into performer.actor.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { annotateChanges, autoFixBundle, EntryMap, guardNoNewErrors, underMoved, validDisplaysOf, type AutoFixDeps, type Disabled, type PipelineResult, type ValidatorIssue } from "./autoFix.js";
import type { ExpandedCoding, NormalizeCandidate, RepairChange } from "./types.js";
import { InstanceValidator } from "../fhirValidator.js";
import { available, packages } from "../../scripts/v16-structure-eval/packages.js";
import { repairBundle, type RepairDeps } from "./index.js";

type Json = Record<string, any>;
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

const CORE = (rt: string): string => `http://hl7.org/fhir/StructureDefinition/${rt}`;

function deps(issues: ValidatorIssue[], o: { sds?: Record<string, Json>; norm?: Record<string, NormalizeCandidate[]>; vs?: Record<string, ExpandedCoding[]>; display?: Record<string, string> } = {}): AutoFixDeps {
  return {
    fetchStructureDefinition: async (u) => o.sds?.[u.split("|")[0]] ?? null,
    validate: async () => issues,
    lookupDisplay: async (s, c) => o.display?.[`${s}#${c}`] ?? null,
    normalize: async (t, g) => o.norm?.[`${g.system}|${t}`] ?? [],
    expandValueSet: async (u) => {
      const c = o.vs?.[u.split("|")[0]];
      return c ? { codings: c, total: c.length, truncated: false } : null;
    },
  };
}

test("validDisplaysOf: one display, several choices, language suffixes", () => {
  assert.deepEqual(validDisplaysOf("Wrong Display Name 'x' for http://loinc.org#1-8. Valid display is 'y'"), ["y"]);
  assert.deepEqual(validDisplaysOf("Wrong Display Name 'x' for s#c. Valid display is one of 2 choices: 'a', 'b' (for the language(s) 'en')"), ["a", "b"]);
  assert.deepEqual(validDisplaysOf("Wrong Display Name 'Low' for s#L. Valid display is 'Left Equipment' (en) (for the language(s) 'en')"), ["Left Equipment"]);
});

test("display of a determined code: fixed unless another code of the system is named so, too few words are shared, or a required binding rejects the code", async () => {
  const S = "http://terminology.hl7.org/CodeSystem/v2-0203";
  const L = "http://loinc.org";
  const tree: Json = {
    resourceType: "Bundle",
    entry: [
      { fullUrl: "urn:uuid:p", resource: { resourceType: "Patient", identifier: [{ type: { coding: [{ system: S, code: "NI", display: "National Identifier" }] }, value: "1" }] } },
      { fullUrl: "urn:uuid:o", resource: { resourceType: "Observation", code: { coding: [{ system: L, code: "46358-8", display: "CT Chest" }] } } },
      { fullUrl: "urn:uuid:q", resource: { resourceType: "Observation", code: { coding: [{ system: L, code: "88020-3", display: "Some test" }] } } },
      { fullUrl: "urn:uuid:r", resource: { resourceType: "Observation", code: { coding: [{ system: L, code: "88020-3", display: "ECOG performance status" }] } } },
      { fullUrl: "urn:uuid:s", resource: { resourceType: "Observation", code: { coding: [{ system: L, code: "1-8", display: "Cancer staging" }] } } },
    ],
  };
  const issues: ValidatorIssue[] = [
    { severity: "error", path: "Bundle.entry[0].resource.identifier[0].type.coding[0].display", message: `Wrong Display Name 'National Identifier' for ${S}#NI. Valid display is 'National unique individual identifier' (for the language(s) 'en')` },
    { severity: "error", path: "Bundle.entry[1].resource.code.coding[0].display", message: `Wrong Display Name 'CT Chest' for ${L}#46358-8. Valid display is 'MR Whole body'` },
    { severity: "error", path: "Bundle.entry[2].resource.code.coding[0].display", message: `Wrong Display Name 'Some test' for ${L}#88020-3. Valid display is 'Functional capacity NYHA'` },
    { severity: "error", path: "Bundle.entry[3].resource.code.coding[0].display", message: `Wrong Display Name 'ECOG performance status' for ${L}#88020-3. Valid display is 'Functional capacity NYHA'` },
    { severity: "error", path: "Bundle.entry[4].resource.code.coding[0].display", message: `Wrong Display Name 'Cancer staging' for ${L}#1-8. Valid display is 'Gleason grade finding for prostatic cancer'` },
    { severity: "error", path: "Bundle.entry[2].resource.code.coding[0]", message: `The code provided (${L}#88020-3) was not found in the value set 'X' (http://x/vs|1), and a code from this value set is required: Wrong Display Name 'Some test' for ${L}#88020-3.` },
  ];
  const d = deps(issues, {
    norm: { [`${L}|CT Chest`]: [{ system: L, code: "24627-2", display: "CT Chest", exact: true }], [`${S}|National Identifier`]: [{ system: S, code: "NIIP", display: "National Insurance Payor Identifier (Payor)" }] },
    display: { [`${S}#NI`]: "National unique individual identifier" },
  });
  const r = await autoFixBundle(tree, d);
  const id = tree.entry[0].resource.identifier[0].type;
  assert.equal(id.coding[0].display, "National unique individual identifier");
  assert.equal(id.text, "National Identifier", "the written wording is kept as CodeableConcept.text");
  assert.equal(tree.entry[1].resource.code.coding[0].display, "CT Chest", "another LOINC code is named 'CT Chest': the code is what is wrong");
  assert.equal(tree.entry[2].resource.code.coding[0].display, "Some test", "the required ValueSet rejects the code: not decided");
  assert.equal(tree.entry[3].resource.code.coding[0].display, "ECOG performance status", "no word shared with the code's names: another concept, not decided");
  assert.equal(tree.entry[4].resource.code.coding[0].display, "Cancer staging", "one generic word of six shared, and the search does not rank the code first: not decided");
  assert.deepEqual(r.changes.map((c) => c.rule), ["display", "display"]);
  // no terminology search → nothing decided
  const t2: Json = clone(tree);
  t2.entry[0].resource.identifier[0].type = { coding: [{ system: S, code: "NI", display: "National Identifier" }] };
  const r2 = await autoFixBundle(t2, { ...d, normalize: undefined });
  assert.equal(r2.changes.length, 0);
});

test("system: the bound ValueSet holds the code with exactly the written display under one other system", async () => {
  const ACT = "http://terminology.hl7.org/CodeSystem/v3-ActCode";
  const OI = "http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation";
  const sds = { [CORE("Observation")]: { url: CORE("Observation"), snapshot: { element: [{ id: "Observation.interpretation", path: "Observation.interpretation", binding: { strength: "extensible", valueSet: "http://hl7.org/fhir/ValueSet/observation-interpretation" } }] } } };
  const tree: Json = { resourceType: "Bundle", entry: [{ resource: { resourceType: "Observation", interpretation: [{ coding: [{ system: ACT, code: "L", display: "Low" }] }] } }] };
  const issues: ValidatorIssue[] = [{ severity: "error", path: "Bundle.entry[0].resource.interpretation[0].coding[0].display", message: `Wrong Display Name 'Low' for ${ACT}#L. Valid display is 'Left Equipment' (en) (for the language(s) 'en')` }];
  const r = await autoFixBundle(tree, deps(issues, { sds, vs: { "http://hl7.org/fhir/ValueSet/observation-interpretation": [{ system: OI, code: "L", display: "Low" }, { system: OI, code: "H", display: "High" }] } }));
  assert.equal(tree.entry[0].resource.interpretation[0].coding[0].system, OI);
  assert.equal(tree.entry[0].resource.interpretation[0].coding[0].display, "Low");
  assert.deepEqual(r.changes.map((c) => [c.rule, c.path]), [["system", "Bundle.entry[0].resource.interpretation[0].coding[0].system"]]);
});

test("a code in the wrong element → the one sibling whose required ValueSet holds it (absent: moved; carrying it: copy removed)", async () => {
  const AI = CORE("AllergyIntolerance");
  const el = (name: string, type: string, max: string, vs: string): Json => ({ id: `AllergyIntolerance.${name}`, path: `AllergyIntolerance.${name}`, type: [{ code: type }], max, binding: { strength: "required", valueSet: vs } });
  const sds = { [AI]: { url: AI, snapshot: { element: [el("type", "code", "1", "vs-type"), el("category", "code", "*", "vs-cat"), el("criticality", "code", "1", "vs-crit"), el("verificationStatus", "CodeableConcept", "1", "vs-ver")] } } };
  const vs = {
    "vs-type": [{ system: "t", code: "allergy", display: "Allergy" }, { system: "t", code: "intolerance", display: "Intolerance" }],
    "vs-cat": [{ system: "c", code: "medication", display: "Medication" }, { system: "c", code: "food", display: "Food" }],
    "vs-crit": [{ system: "k", code: "low", display: "Low Risk" }, { system: "k", code: "high", display: "High Risk" }],
    "vs-ver": [{ system: "v", code: "confirmed", display: "Confirmed" }, { system: "v", code: "unconfirmed", display: "Unconfirmed" }],
  };
  const tree: Json = {
    resourceType: "Bundle",
    entry: [
      { resource: { resourceType: "AllergyIntolerance", type: "medication", criticality: "unconfirmed", code: { text: "penicillin" } } },
      { resource: { resourceType: "AllergyIntolerance", type: "food", category: ["food"] } },
      { resource: { resourceType: "AllergyIntolerance", type: "medication", category: ["food"] } },
    ],
  };
  const msg = (code: string, v: string): string => `The System URI could not be determined for the code '${code}' in the ValueSet '${v}|4.0.1'`;
  const issues: ValidatorIssue[] = [
    { severity: "error", path: "Bundle.entry[0].resource.type", message: msg("medication", "vs-type") },
    { severity: "error", path: "Bundle.entry[0].resource.criticality", message: msg("unconfirmed", "vs-crit") },
    { severity: "error", path: "Bundle.entry[1].resource.type", message: msg("food", "vs-type") },
    { severity: "error", path: "Bundle.entry[2].resource.type", message: msg("medication", "vs-type") },
  ];
  const r = await autoFixBundle(tree, deps(issues, { sds, vs }));
  assert.deepEqual(tree.entry[0].resource, { resourceType: "AllergyIntolerance", category: ["medication"], verificationStatus: { coding: [{ system: "v", code: "unconfirmed", display: "Unconfirmed" }] }, code: { text: "penicillin" } });
  assert.deepEqual(tree.entry[1].resource, { resourceType: "AllergyIntolerance", category: ["food"] }, "the sibling already carries it: the misplaced copy goes");
  assert.equal(tree.entry[2].resource.type, "medication", "the sibling holds another value: left as written");
  assert.equal(r.changes.length, 3);
  assert.ok(r.changes.every((c) => c.rule === "code" && typeof (c.from as Json).path === "string"));
});

test("a string element given as an object holding only its text → the text", async () => {
  const IM = CORE("Immunization");
  const sds = { [IM]: { url: IM, snapshot: { element: [{ id: "Immunization.protocolApplied.series", path: "Immunization.protocolApplied.series", type: [{ code: "string" }] }, { id: "Immunization.protocolApplied.authority", path: "Immunization.protocolApplied.authority", type: [{ code: "Reference" }] }] } } };
  const tree: Json = { resourceType: "Bundle", entry: [{ resource: { resourceType: "Immunization", protocolApplied: [{ series: { text: "Tdap" }, authority: { display: "x" } }] } }] };
  const issues: ValidatorIssue[] = [
    { severity: "error", path: "Bundle.entry[0].resource.protocolApplied[0].series", message: "This property must be a simple value, not an Object (series at Bundle.entry[0].resource.protocolApplied[0].series)" },
    { severity: "error", path: "Bundle.entry[0].resource.protocolApplied[0].authority", message: "This property must be a simple value, not an Object (authority at Bundle.entry[0].resource.protocolApplied[0].authority)" },
  ];
  const r = await autoFixBundle(tree, deps(issues, { sds }));
  assert.equal(tree.entry[0].resource.protocolApplied[0].series, "Tdap");
  assert.deepEqual(tree.entry[0].resource.protocolApplied[0].authority, { display: "x" }, "not a string element");
  assert.equal(r.changes.length, 1);
});

test("guard exposed_errors: strict withdraws a rename whose new location shows an error; allow_under_moved keeps it", async () => {
  const sent: Json = { resourceType: "Bundle", type: "collection", entry: [{ resource: { resourceType: "MedicationStatement", dosageInstruction: [{ text: "1 tab", timing: { bad: 1 } }] } }] };
  const run = async (d: Disabled): Promise<PipelineResult> => {
    const b = clone(sent);
    const ch: RepairChange[] = [];
    if (!d.all && !d.blocked.has("shape\u0000Bundle.entry[0].resource.dosage") && !d.blocked.has("shape\u0000Bundle.entry[0].resource.dosageInstruction")) {
      b.entry[0].resource.dosage = b.entry[0].resource.dosageInstruction;
      delete b.entry[0].resource.dosageInstruction;
      ch.push({ path: "Bundle.entry[0].resource.dosage", from: { path: "Bundle.entry[0].resource.dosageInstruction", value: sent.entry[0].resource.dosageInstruction }, to: b.entry[0].resource.dosage, rule: "shape", reason: "rename" });
    }
    const map = new EntryMap(1, ch, [], 1);
    return { bundle: b, changes: annotateChanges(ch, [], map, sent), map };
  };
  const validate = async (b: Json): Promise<ValidatorIssue[]> =>
    b.entry[0].resource.dosage
      ? [{ severity: "error", path: "Bundle.entry[0].resource.dosage[0].timing", message: "Unrecognized property 'bad'" }]
      : [{ severity: "error", path: "Bundle.entry[0].resource", message: "Unrecognized property 'dosageInstruction'" }];
  const strict = await guardNoNewErrors(sent, run, validate);
  assert.equal(strict.result.changes.length, 0);
  assert.equal(strict.withdrawn.length, 1);
  const allow = await guardNoNewErrors(sent, run, validate, 3, "allow_under_moved");
  assert.equal(allow.result.changes.length, 1);
  assert.equal(allow.withdrawn.length, 0);
  assert.equal(allow.after.length, 1);
  assert.equal(underMoved("/entry/0/resource/dosage/0/timing", allow.result.changes), true);
  assert.equal(underMoved("/entry/0/resource/note", allow.result.changes), false);
});

// ---------------------------------------------------------------------------------------------- R4 core (package cache)

const core = available("twcore");
function coreDeps(): RepairDeps {
  const r = packages("twcore").resolver();
  return {
    fetchStructureDefinition: (u) => r.fetchStructureDefinition(u),
    valueSetContains: (u, s, c) => r.valueSetContains(u, s, c),
    validate: async (res, profiles) => (await new InstanceValidator(r).validate(clone(res), { profiles })) as any[],
  };
}

test("content repair (R4 core): an STU3 duplicate of a value its R4 element already holds is removed; performer.reference → performer.actor.reference", { skip: !core && "R4 core package not in the local cache" }, async () => {
  const b: Json = {
    resourceType: "Bundle",
    type: "collection",
    entry: [
      {
        fullUrl: "urn:uuid:22222222-2222-4222-8222-222222222222",
        resource: { resourceType: "Immunization", status: "completed", vaccineCode: { text: "v" }, patient: { display: "p" }, occurrenceDateTime: "2020-01-01", performer: [{ reference: "urn:uuid:33333333-3333-4333-8333-333333333333" }], protocolApplied: [{ doseNumberPositiveInteger: 1, doseSequencePositiveInteger: 1 }, { doseNumberPositiveInteger: 1, doseSequencePositiveInteger: 2 }] },
      },
      { fullUrl: "urn:uuid:33333333-3333-4333-8333-333333333333", resource: { resourceType: "Practitioner", name: [{ text: "Dr" }] } },
    ],
  };
  await repairBundle(b, coreDeps());
  const im = b.entry[0].resource;
  assert.deepEqual(im.protocolApplied[0], { doseNumberPositiveInt: 1 });
  assert.equal(im.protocolApplied[1].doseNumberPositiveInt, 1);
  assert.equal(im.protocolApplied[1].doseSequencePositiveInteger, 2, "a different value is not a duplicate: kept");
  assert.deepEqual(im.performer, [{ actor: { reference: "urn:uuid:33333333-3333-4333-8333-333333333333" } }]);
});

test("content repair (R4 core): STU3 Composition.class → category (a bare Coding wrapped as a CodeableConcept)", { skip: !core && "R4 core package not in the local cache" }, async () => {
  const b: Json = {
    resourceType: "Bundle",
    type: "collection",
    entry: [{ fullUrl: "urn:uuid:11111111-1111-4111-8111-111111111111", resource: { resourceType: "Composition", status: "final", type: { text: "summary" }, date: "2024-01-01", author: [{ display: "a" }], title: "t", class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "SUMMARY" } } }],
  };
  await repairBundle(b, coreDeps());
  const c = b.entry[0].resource;
  assert.ok(!("class" in c), JSON.stringify(c));
  assert.deepEqual(c.category, [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "SUMMARY" }] }]);
});
