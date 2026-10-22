/**
 * fhirSuggestions/bundleType: a document / message Bundle without its head resource gets the
 * two ways out as suggestions (Bundle.type from the entries' shape, or the missing head
 * resource); the issues themselves are untouched. Synthetic data on the test kit.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { CORE, FakeResolver, SDS, el, sd } from "../fhirTestKit.test.js";
import { attachBundleTypeSuggestions, isBundleHeadIssue } from "./bundleType.js";

const deps = new FakeResolver();
const BDL11 = "Constraint failed: bdl-11: 'A document must have a Composition as the first resource'";
const BDL9 = "Constraint failed: bdl-9: 'A document must have an identifier with a system and a value'";
const BDL12 = "Constraint failed: bdl-12: 'A message must have a MessageHeader as the first resource'";
const issue = (message: string, extra: Record<string, unknown> = {}): Record<string, any> => ({ severity: "error", path: "Bundle", code: "invariant", message, ...extra });
const patient = (id: string): Record<string, any> => ({ resourceType: "Patient", id });

test("isBundleHeadIssue matches bdl-9 / 10 / 11 / 12 and the HL7 wording only", () => {
  for (const m of [BDL11, BDL9, BDL12, "Constraint failed: bdl-10: 'A document must have a date'", "The first entry in a document must be a composition", "The first entry in a message must be a MessageHeader"]) {
    assert.ok(isBundleHeadIssue({ message: m }), m);
  }
  for (const m of ["Constraint failed: bdl-7: 'FullUrl must be unique in a bundle'", "UUIDs must be valid and lowercase (x)", ""]) assert.ok(!isBundleHeadIssue({ message: m }), m);
});

test("document without any Composition: replace_value candidates from the entries' shape, then add_resource Composition; wording / severity untouched", async () => {
  const bundle = { resourceType: "Bundle", type: "document", entry: [{ fullUrl: "urn:uuid:3f2a9c1e-7b4d-4e8a-9f1c-2d5e6a7b8c9d", resource: patient("p") }] };
  const issues = [issue(BDL11), issue(BDL9), issue("Constraint failed: bdl-7: 'x'"), issue("Unrecognized property 'foo'", { suggestions: [{ value: "bar", kind: "rename_property", confidence: 0.5, reason: "r" }] })];
  const before = JSON.stringify(issues.map(({ suggestions: _s, ...rest }) => rest));
  assert.equal(await attachBundleTypeSuggestions(issues, bundle, deps), 2);
  assert.equal(JSON.stringify(issues.map(({ suggestions: _s, ...rest }) => rest)), before, "only suggestions were added");
  const s11 = issues[0].suggestions;
  assert.deepEqual(s11.map((s: any) => [s.kind, s.value]), [["replace_value", "collection"], ["add_resource", "Composition"]]);
  assert.deepEqual(s11[0].patch, { op: "replace", path: "Bundle.type", value: "collection" });
  assert.equal(s11[0].confidence, 0.8);
  assert.match(s11[0].reason, /requires a Composition as the first entry \(bdl-11\)/);
  assert.deepEqual(s11[1].patch, { op: "add", path: "Bundle.entry[0]", value: { resource: { resourceType: "Composition" } } });
  assert.match(s11[1].reason, /it needs status, type, date, author, title/, "required elements from the core StructureDefinition");
  assert.ok(s11[0].confidence > s11[1].confidence);
  assert.deepEqual(issues[1].suggestions.map((s: any) => s.kind), ["replace_value"], "bdl-9 follows from the wrong type: only the type change");
  assert.equal(issues[2].suggestions, undefined);
  assert.equal(issues[3].suggestions.length, 1, "unrelated issue untouched");
  // Transaction-shaped entries: transaction first, batch when nothing references another entry.
  const tx = { resourceType: "Bundle", type: "document", entry: [{ resource: patient("a"), request: { method: "POST", url: "Patient" } }, { resource: patient("b"), request: { method: "POST", url: "Patient" } }] };
  const i2 = [issue(BDL11)];
  await attachBundleTypeSuggestions(i2, tx, deps);
  assert.deepEqual(i2[0].suggestions.map((s: any) => s.value), ["transaction", "batch", "Composition"]);
  assert.deepEqual(i2[0].suggestions.map((s: any) => s.confidence), [0.7, 0.4, 0.35]);
  // Existing suggestions are kept after ours; duplicates by kind + value dropped.
  const i3 = [issue(BDL11, { suggestions: [{ value: "collection", kind: "replace_value", confidence: 0.1, reason: "old" }, { value: "x", kind: "replace_code", confidence: 0.2, reason: "o" }] })];
  await attachBundleTypeSuggestions(i3, bundle, deps);
  assert.deepEqual(i3[0].suggestions.map((s: any) => [s.kind, s.value, s.reason === "old"]), [["replace_value", "collection", false], ["add_resource", "Composition", false], ["replace_code", "x", false]]);
});

test("a Composition anywhere (the finalizer's move_entry covers it), a non-document type, or no matching issue: nothing is attached", async () => {
  const comp = { resourceType: "Composition", status: "final", type: { text: "t" }, date: "2024-01-01", title: "x" };
  const misplaced = { resourceType: "Bundle", type: "document", entry: [{ resource: patient("p") }, { resource: comp }] };
  const i1 = [issue(BDL11)];
  assert.equal(await attachBundleTypeSuggestions(i1, misplaced, deps), 0);
  assert.equal(i1[0].suggestions, undefined);
  const i2 = [issue(BDL11)];
  assert.equal(await attachBundleTypeSuggestions(i2, { resourceType: "Bundle", type: "collection", entry: [{ resource: patient("p") }] }, deps), 0);
  const i3 = [issue("Constraint failed: bdl-7: 'x'")];
  assert.equal(await attachBundleTypeSuggestions(i3, { resourceType: "Bundle", type: "document", entry: [] }, deps), 0);
  assert.equal(await attachBundleTypeSuggestions([issue(BDL11)], null as unknown as Record<string, any>, deps), 0);
});

test("a Bundle.type fixed by the profile is never suggested away: only the head resource is offered, and the reason says why", async () => {
  const PROFILE = "http://example.tw/fhir/StructureDefinition/doc-bundle-s";
  const docSd = sd(PROFILE, "Bundle", "resource", [el("Bundle", 0, "*"), el("Bundle.type", 1, "1", ["code"], { fixedCode: "document" }), el("Bundle.entry", 0, "*", ["BackboneElement"])]);
  const fixedDeps = { fetchStructureDefinition: async (url: string): Promise<Record<string, any> | null> => (url.split("|")[0] === PROFILE ? docSd : SDS[url.split("|")[0]] ?? null) };
  const bundle = { resourceType: "Bundle", meta: { profile: [`${PROFILE}|1.0.0`] }, type: "document", entry: [{ resource: patient("p") }] };
  const issues = [issue(BDL11), issue(BDL9)];
  assert.equal(await attachBundleTypeSuggestions(issues, bundle, fixedDeps), 1);
  assert.deepEqual(issues[0].suggestions.map((s: any) => s.kind), ["add_resource"]);
  assert.match(issues[0].suggestions[0].reason, /Bundle.type is fixed to 'document' by the profile/);
  assert.equal(issues[1].suggestions, undefined, "no type change to offer for bdl-9");
});

test("message without a MessageHeader (bdl-12): the same two ways out; required elements fall back to the R4 list when the definition is unavailable", async () => {
  const bundle = { resourceType: "Bundle", type: "message", entry: [{ resource: patient("p") }] };
  const issues = [issue(BDL12), issue(BDL11)];
  const none = { fetchStructureDefinition: async (): Promise<Record<string, any> | null> => null };
  assert.equal(await attachBundleTypeSuggestions(issues, bundle, none), 1);
  assert.deepEqual(issues[0].suggestions.map((s: any) => [s.kind, s.value]), [["replace_value", "collection"], ["add_resource", "MessageHeader"]]);
  assert.match(issues[0].suggestions[1].reason, /it needs event\[x\], source/);
  assert.equal(issues[1].suggestions, undefined, "a document issue on a message Bundle is not ours");
  // A throwing resolver is fail-open.
  const boom = { fetchStructureDefinition: async (): Promise<Record<string, any> | null> => { throw new Error("db"); } };
  const i2 = [issue(BDL12)];
  assert.equal(await attachBundleTypeSuggestions(i2, bundle, boom), 1);
  assert.ok(SDS[CORE + "Composition"], "kit sanity");
});
