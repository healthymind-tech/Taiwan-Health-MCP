/**
 * Release v1 (finalize safety): an existing value that differs from a profile's fixed / pattern value is never
 * overwritten (representation-only differences excepted) while a missing one is filled; no no-op changes; every
 * ambiguous item's pointer resolves in the sent Bundle and its pointer_out / patch_out in the returned one.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { FinalizeChange } from "../fhirBundleFinalize.js";
import { patchApplies, type JsonPatchOp } from "../jsonPatch.js";
import { annotateChanges, autoFixBundle, buildAmbiguous, EntryMap, resolvePointer, type ValidatorIssue } from "./autoFix.js";
import { mayWriteFixed, sameValue } from "./fixedGuard.js";

type Json = Record<string, any>;

test("sameValue: representation only (whitespace, one-item array, URI alias of the same system, pattern subset) — never a different value", () => {
  assert.ok(sameValue("final", "final"));
  assert.ok(sameValue(" final ", "final"));
  assert.ok(sameValue(["final"], "final"));
  assert.ok(sameValue("final", ["final"]));
  assert.ok(sameValue("urn:oid:2.16.840.1.113883.6.1", "http://loinc.org"));
  assert.ok(sameValue("http://loinc.org/", "http://loinc.org"));
  assert.ok(sameValue({ coding: [{ system: "http://loinc.org", code: "1-8", display: "x" }] }, { coding: [{ system: "http://loinc.org", code: "1-8" }] }));
  assert.ok(!sameValue("preliminary", "final"));
  assert.ok(!sameValue("Final", "final"), "case is not representation (codes are case-sensitive)");
  assert.ok(!sameValue("http://snomed.info/sct", "http://loinc.org"));
  assert.ok(!sameValue({ coding: [{ system: "http://loinc.org", code: "2-6" }] }, { coding: [{ system: "http://loinc.org", code: "1-8" }] }));
  assert.ok(mayWriteFixed(undefined, "final"));
  assert.ok(mayWriteFixed(null, "final"));
  assert.ok(!mayWriteFixed("preliminary", "final"));
});

const P = "http://example.org/StructureDefinition/obs";
const SDS: Record<string, Json> = {
  [P]: {
    url: P,
    snapshot: {
      element: [
        { id: "Observation", path: "Observation", min: 0, max: "*" },
        { id: "Observation.status", path: "Observation.status", min: 1, max: "1", type: [{ code: "code" }], fixedCode: "final" },
        { id: "Observation.category", path: "Observation.category", min: 1, max: "*", type: [{ code: "CodeableConcept" }], patternCodeableConcept: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category", code: "laboratory" }] } },
      ],
    },
  },
};
const fetchSd = async (u: string): Promise<Json | null> => SDS[u.split("|")[0]] ?? null;

test("autoFix: Observation.status 'preliminary' vs fixed 'final' → not overwritten, an error issue (insufficient_information hint) that becomes ambiguous (fixed_pattern, no patch)", async () => {
  const tree: Json = { resourceType: "Bundle", type: "collection", entry: [{ fullUrl: "urn:uuid:o", resource: { resourceType: "Observation", meta: { profile: [P] }, status: "preliminary", code: { text: "x" } } }] };
  const sent = JSON.parse(JSON.stringify(tree));
  const issues: ValidatorIssue[] = [{ severity: "error", path: "Bundle.entry[0].resource.status", message: `Value is 'preliminary' but is fixed to 'final' in the profile ${P}|1.0#Observation.status` }];
  const r = await autoFixBundle(tree, { fetchStructureDefinition: fetchSd, validate: async () => issues });
  assert.equal(tree.entry[0].resource.status, "preliminary");
  assert.deepEqual(r.changes, []);
  assert.equal(r.issues.length, 1);
  const map = new EntryMap(1, [], [], 1);
  const amb = buildAmbiguous({ sent, map, withdrawn: [], repairIssues: r.issues, unresolved: [], idMap: {}, remaining: issues, out: tree });
  assert.equal(amb.length, 1, "the validator error is covered by the conflict item");
  assert.equal(amb[0].pointer, "/entry/0/resource/status");
  assert.equal(amb[0].category, "fixed_pattern");
  assert.match(amb[0].message, /differs from the profile's fixed/u);
  assert.match(amb[0].message, /insufficient_information/u);
  assert.ok(amb[0].candidates.length > 0 && amb[0].candidates.every((c) => !c.patch && !c.patch_out), "no automatic patch for a status value");
});

test("autoFix: a required element the profile fixes / patterns, absent → filled (status, category); present elements untouched", async () => {
  const tree: Json = { resourceType: "Bundle", type: "collection", entry: [{ fullUrl: "urn:uuid:o", resource: { resourceType: "Observation", meta: { profile: [P] }, code: { text: "x" } } }] };
  const issues: ValidatorIssue[] = [
    { severity: "error", path: "Bundle.entry[0].resource", message: `Observation.status: minimum required = 1, but only found 0 (from ${P}|1.0)` },
    { severity: "error", path: "Bundle.entry[0].resource", message: `Observation.category: minimum required = 1, but only found 0 (from ${P}|1.0)` },
  ];
  const r = await autoFixBundle(tree, { fetchStructureDefinition: fetchSd, validate: async () => issues });
  const o = tree.entry[0].resource;
  assert.equal(o.status, "final");
  assert.deepEqual(o.category, [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category", code: "laboratory" }] }]);
  assert.deepEqual(r.changes.map((c) => [c.rule, c.path, c.from]), [
    ["fixed-value", "Bundle.entry[0].resource.status", null],
    ["fixed-value", "Bundle.entry[0].resource.category", null],
  ]);
  // already present (validator stale) → nothing
  const r2 = await autoFixBundle(tree, { fetchStructureDefinition: fetchSd, validate: async () => issues });
  assert.deepEqual(r2.changes, []);
});

test("annotateChanges: a change whose before and after are the same value at the same place is not emitted", () => {
  const sent: Json = { resourceType: "Bundle", entry: [{ resource: { resourceType: "Observation", status: "final" } }] };
  const map = new EntryMap(1, [], [], 1);
  const out = annotateChanges(
    [
      { path: "Bundle.entry[0].resource.status", from: "final", to: "final", rule: "fixed-value", reason: "same" },
      { path: "Bundle.entry[0].resource.code", from: { path: "Bundle.entry[0].resource.code", value: 1 }, to: 1, rule: "shape", reason: "same place" },
      { path: "Bundle.entry[0].resource.valueBoolean", from: { path: "Bundle.entry[0].resource.valueString", value: "true" }, to: true, rule: "shape", reason: "renamed" },
    ],
    [],
    map,
    sent,
  );
  assert.deepEqual(out.map((c) => c.reason), ["renamed"]);
});

test("ambiguous: pointer resolves in the sent Bundle, pointer_out (entry reordered) in the returned one; patch_out applies there; a vanished element → nearest ancestor, said so", () => {
  const sent: Json = {
    resourceType: "Bundle",
    type: "document",
    entry: [
      { fullUrl: "urn:uuid:a", resource: { resourceType: "Observation", code: { coding: [{ system: "http://loinc.org", code: "1-8", display: "Foo" }] } } },
      { fullUrl: "urn:uuid:c", resource: { resourceType: "Composition", title: "t" } },
    ],
  };
  // the finalizer moved the Composition first
  const out: Json = { ...JSON.parse(JSON.stringify(sent)), entry: [JSON.parse(JSON.stringify(sent.entry[1])), JSON.parse(JSON.stringify(sent.entry[0]))] };
  const fin: FinalizeChange[] = [{ path: "Bundle.entry[0]", from: "Bundle.entry[1]", to: "Bundle.entry[0]", rule: "document-order" }];
  const map = new EntryMap(2, [], fin, 2);
  const amb = buildAmbiguous({
    sent,
    map,
    withdrawn: [],
    repairIssues: [{ path: "Bundle.entry[0].resource.code.coding[0].display", rule: "display", severity: "error", message: "Display 'Foo' does not match http://loinc.org#1-8 (valid: 'Bar') and was NOT replaced" }],
    unresolved: [],
    idMap: {},
    remaining: [
      { severity: "error", path: "Bundle.entry[0].resource.title", message: "Unrecognized property 'title'" },
      { severity: "error", path: "Bundle.entry[0].resource.section[3].text", message: "Narrative div is invalid" },
    ],
    out,
  });
  assert.equal(amb.length, 3);
  for (const a of amb) {
    assert.ok(resolvePointer(sent, a.pointer).found, `pointer ${a.pointer} resolves in the sent Bundle`);
    assert.ok(resolvePointer(out, a.pointer_out ?? a.pointer).found, `pointer_out ${a.pointer_out} resolves in the returned Bundle`);
    for (const c of a.candidates) {
      if (c.patch) assert.ok(patchApplies(sent, c.patch as unknown as JsonPatchOp[]));
      if (c.patch_out) assert.ok(patchApplies(out, c.patch_out as unknown as JsonPatchOp[]));
    }
  }
  const display = amb.find((a) => a.category === "display")!;
  assert.equal(display.pointer, "/entry/0/resource/code/coding/0/display");
  assert.equal(display.pointer_out, "/entry/1/resource/code/coding/0/display");
  assert.deepEqual(display.candidates[0].patch, [{ op: "replace", path: "/entry/0/resource/code/coding/0/display", value: "Bar" }]);
  assert.deepEqual(display.candidates[0].patch_out, [{ op: "replace", path: "/entry/1/resource/code/coding/0/display", value: "Bar" }]);
  const title = amb.find((a) => a.category === "unrecognized_property")!;
  assert.equal(title.pointer, "/entry/1/resource/title");
  assert.equal(title.pointer_out, "/entry/0/resource/title");
  const div = amb.find((a) => a.category === "narrative")!;
  assert.equal(div.pointer, "/entry/1/resource");
  assert.equal(div.pointer_out, "/entry/0/resource");
  assert.match(div.pointer_note ?? "", /nearest existing ancestor/u);
});
