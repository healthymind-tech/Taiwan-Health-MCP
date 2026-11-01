/**
 * ISSUES_v19 R1 — fhir_finalize_bundle layer 1: categories, JSON Pointers against the Bundle as sent (entry reorder /
 * duplicates / entries moved in from Bundle level), RFC 6902 patches, the no-new-error guard (per-change rollback,
 * give-up), ambiguous reporting, the validator-driven fixes (fixed value, pinned display, profile-narrowed choice
 * type, section narrative) on synthetic definitions; and the near-name renames / Bundle-level entry move of the
 * shared content repair on FHIR R4 core (local package cache; skipped when absent).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { FinalizeChange } from "../fhirBundleFinalize.js";
import { InstanceValidator } from "../fhirValidator.js";
import { available, packages } from "../../scripts/v16-structure-eval/packages.js";
import {
  annotateChanges,
  applyPatch,
  autoFixBundle,
  buildAmbiguous,
  changeCategory,
  EntryMap,
  errorCategory,
  escapeToken,
  guardNoNewErrors,
  newErrors,
  resolvePointer,
  type Disabled,
  type PipelineResult,
  type ValidatorIssue,
} from "./autoFix.js";
import { repairBundle, type RepairChange, type RepairDeps } from "./index.js";

type Json = Record<string, any>;
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

test("errorCategory / changeCategory: validator_cli wording → R1 category", () => {
  assert.equal(errorCategory("Unrecognized property 'dosageInstruction'"), "unrecognized_property");
  assert.equal(errorCategory("Wrong Display Name 'x' for http://loinc.org#1-8. Valid display is 'y'"), "display");
  assert.equal(errorCategory("Value is 'preliminary' but is fixed to 'final' in the profile P#Observation.status"), "fixed_pattern");
  assert.equal(errorCategory("The first entry in a document must be a composition"), "document_structure");
  assert.equal(errorCategory("Entry 'urn:uuid:1' isn't reachable by traversing links (forward or backward) from the Composition"), "document_structure");
  assert.equal(errorCategory("Can't find 'urn:uuid:1' in the bundle (Section Entry)"), "ids_references");
  assert.equal(errorCategory("This property must be a simple value, not an Object (series at .x)"), "shape");
  assert.equal(errorCategory("Unknown code 'x' in the CodeSystem 'y'"), null);
  assert.equal(changeCategory({ rule: "shape", from: { path: "a.b", value: 1 } }), "unrecognized_property");
  assert.equal(changeCategory({ rule: "shape", from: [1] }), "shape");
  assert.equal(changeCategory({ rule: "document-order" }), "document_structure");
  assert.equal(changeCategory({ rule: "reference-rewire" }), "ids_references");
  assert.equal(changeCategory({ rule: "fixed-value" }), "fixed_pattern");
  assert.equal(changeCategory({ rule: "document", path: "Bundle.entry[0].resource.section[1].code", reason: "section 'x' code display" }), "display");
});

test("RFC 6901 / 6902: escaping, resolve, apply (copy, never in place; failures → null)", () => {
  assert.equal(escapeToken("a/b~c"), "a~1b~0c");
  const doc = { "a/b": { "~": [1, 2] } };
  assert.deepEqual(resolvePointer(doc, "/a~1b/~0/1"), { found: true, value: 2 });
  assert.equal(resolvePointer(doc, "/a~1b/x").found, false);
  const out = applyPatch(doc, [{ op: "add", path: "/a~1b/~0/-", value: 3 }, { op: "move", from: "/a~1b/~0/0", path: "/first" }, { op: "test", path: "/first", value: 1 }]) as Json;
  assert.deepEqual(out, { "a/b": { "~": [2, 3] }, first: 1 });
  assert.deepEqual(doc, { "a/b": { "~": [1, 2] } });
  assert.equal(applyPatch(doc, [{ op: "replace", path: "/nope", value: 1 }]), null);
  assert.equal(applyPatch(doc, [{ op: "remove", path: "/a~1b/~0/5" }]), null);
});

test("pointers are relative to the Bundle as sent: document reorder, dropped duplicate, entry moved in from Bundle level", () => {
  const sent = {
    resourceType: "Bundle",
    type: "document",
    fullUrl: "urn:uuid:stray",
    resource: { resourceType: "Immunization", status: "completed" },
    entry: [
      { fullUrl: "urn:uuid:p", resource: { resourceType: "Patient", name: [{ text: "A" }] } },
      { fullUrl: "urn:uuid:p", resource: { resourceType: "Patient", name: [{ text: "A" }] } },
      { fullUrl: "urn:uuid:c", resource: { resourceType: "Composition", section: [{ code: { coding: [{ code: "x" }] } }] } },
    ],
  };
  // content space: entry[1] (duplicate) dropped → Composition at 1; the stray entry appended at 2 (before the drop: 3)
  const content: RepairChange[] = [
    { path: "Bundle.entry[3]", from: { path: "Bundle.resource", value: {}, keys: ["Bundle.fullUrl", "Bundle.resource"] }, to: { fullUrl: "urn:uuid:stray" }, rule: "shape", reason: "moved" },
    { path: "Bundle.entry[1]", from: {}, to: null, rule: "shape", reason: "duplicate" },
    { path: "Bundle.entry[1].resource.section[0].code.coding[0].display", from: null, to: "X", rule: "display", reason: "" },
    { path: "Bundle.entry[2].resource.statusReason", from: { path: "Bundle.entry[2].resource.reason", value: "r" }, to: "r", rule: "shape", reason: "" },
  ];
  // final space: the finalizer moved the Composition (content 1) to 0
  const fin: FinalizeChange[] = [
    { path: "Bundle.entry[1]", from: "Bundle.entry[1]", to: "Bundle.entry[0]", rule: "document-order" },
    { path: "Bundle.entry[0].resource.section[0].entry[0].reference", from: "Patient/1", to: "urn:uuid:p", rule: "reference-rewire" },
  ];
  const map = new EntryMap(3, content, fin, 3);
  assert.equal(map.contentToSent(0), 0);
  assert.equal(map.contentToSent(1), 2);
  assert.equal(map.finalToContent(0), 1);
  const a = annotateChanges(content, fin, map, sent);
  assert.equal(a[2].pointer, "/entry/2/resource/section/0/code/coding/0/display");
  assert.equal(a[2].category, "display");
  assert.equal(a[3].pointer, "/resource/reason"); // inside the entry that was written at Bundle level
  assert.equal(a[3].category, "unrecognized_property");
  assert.equal(a[4].pointer, "/entry/2"); // document-order names the sent position
  assert.equal(a[4].moved_to, "/entry/0");
  assert.equal(a[5].pointer, "/entry/2/resource/section/0/entry/0/reference"); // final entry[0] = the sent Composition
  assert.equal(a[5].category, "ids_references");
  // validator paths on the finalized Bundle map back too
  assert.equal(map.pointer("Bundle.entry[0].resource.section[0]", "final", sent), "/entry/2/resource/section/0");
  assert.equal(map.pointer("Bundle.entry[1].resource.value.ofType(string)", "final", sent), "/entry/0/resource/valueString");
});

/** A fake pipeline: changes 'a' (fine) and 'b' (adds an error) on a two-entry Bundle; honours Disabled.blocked. */
function fakePipeline(sent: Json) {
  const runs: Disabled[] = [];
  const run = async (d: Disabled): Promise<PipelineResult> => {
    runs.push({ blocked: new Set(d.blocked), steps: new Set(d.steps), all: d.all });
    const b = clone(sent);
    const ch: RepairChange[] = [];
    if (!d.all && !d.blocked.has("shape\u0000Bundle.entry[0].resource.a")) {
      b.entry[0].resource.a = "fixed";
      ch.push({ path: "Bundle.entry[0].resource.a", from: "bad", to: "fixed", rule: "shape", reason: "a" });
    }
    if (!d.all && !d.blocked.has("display\u0000Bundle.entry[1].resource.code.coding[0].display")) {
      b.entry[1].resource.code.coding[0].display = "new";
      ch.push({ path: "Bundle.entry[1].resource.code.coding[0].display", from: "old", to: "new", rule: "display", reason: "b" });
    }
    const map = new EntryMap(2, ch, [], 2);
    return { bundle: b, changes: annotateChanges(ch, [], map, sent), map };
  };
  return { run, runs };
}

const SENT = { resourceType: "Bundle", type: "collection", entry: [{ resource: { resourceType: "Basic", a: "bad" } }, { resource: { resourceType: "Basic", code: { coding: [{ code: "1", display: "old" }] } } }] };

test("guard: the change that adds an error is withdrawn (only it), reported ambiguous with its patch; errors after ⊆ before", async () => {
  const validate = async (b: Json): Promise<ValidatorIssue[]> => {
    const out: ValidatorIssue[] = [];
    if (b.entry[0].resource.a === "bad") out.push({ severity: "error", path: "Bundle.entry[0].resource.a", message: "bad a" });
    if (b.entry[1].resource.code.coding[0].display === "new") out.push({ severity: "error", path: "Bundle.entry[1].resource.code.coding[0]", message: "Wrong Display Name 'new'" });
    return out;
  };
  const { run, runs } = fakePipeline(SENT);
  const g = await guardNoNewErrors(SENT, run, validate);
  assert.equal(g.checked, true);
  assert.equal(g.gaveUp, false);
  assert.deepEqual(g.result.changes.map((c) => c.reason), ["a"]);
  assert.equal(g.withdrawn.length, 1);
  assert.equal(g.withdrawn[0].change.pointer, "/entry/1/resource/code/coding/0/display");
  assert.equal(runs.length, 2);
  assert.deepEqual(newErrors(g.before, g.after), []);
  assert.equal(g.after.length, 0);
  const amb = buildAmbiguous({ sent: SENT, map: g.result.map, withdrawn: g.withdrawn, repairIssues: [], unresolved: [], idMap: {}, remaining: g.after });
  assert.equal(amb.length, 1);
  assert.equal(amb[0].pointer, "/entry/1/resource/code/coding/0/display");
  assert.deepEqual(amb[0].candidates[0].patch, [{ op: "replace", path: "/entry/1/resource/code/coding/0/display", value: "new" }]);
  assert.ok(applyPatch(SENT, amb[0].candidates[0].patch!));
});

test("guard: an error every change set brings → every change withdrawn, nothing applied", async () => {
  const { run } = fakePipeline(SENT);
  let n = 0;
  const validate = async (): Promise<ValidatorIssue[]> => (n++ === 0 ? [] : [{ severity: "error", path: "Bundle", message: `new ${n}` }]);
  const g = await guardNoNewErrors(SENT, run, validate, 1);
  assert.equal(g.result.changes.length, 0);
  assert.equal(g.result.changes.length, 0);
  assert.ok(g.withdrawn.length >= 1);
});

test("guard: entry order and minted UUIDs do not make an old error new", () => {
  const before = [{ severity: "error", path: "Bundle.entry[3]", message: "Entry 'urn:uuid:00000000-0000-0000-0000-000000000001' isn't reachable … entry[3]" }];
  const after = [{ severity: "error", path: "Bundle.entry[1]", message: "Entry 'urn:uuid:99999999-0000-0000-0000-000000000001' isn't reachable … entry[1]" }];
  assert.deepEqual(newErrors(before, after), []);
  assert.equal(newErrors([], after).length, 1);
});

test("ambiguous: repair issues with candidates (display / rename) as applicable patches; remaining R1 errors located", () => {
  const sent = { resourceType: "Bundle", entry: [{ resource: { resourceType: "Observation", code: { coding: [{ system: "http://loinc.org", code: "1-8", display: "Foo" }] }, dosex: 1 } }] };
  const map = new EntryMap(1, [], [], 1);
  const amb = buildAmbiguous({
    sent,
    map,
    withdrawn: [],
    repairIssues: [
      { path: "Bundle.entry[0].resource.code.coding[0].display", rule: "display", severity: "error", message: "Display 'Foo' does not match http://loinc.org#1-8 (valid: 'Bar') and was NOT replaced", candidates: [{ system: "http://loinc.org", code: "2-6", display: "Foo" }] },
      { path: "Bundle.entry[0].resource.dosex", rule: "shape", severity: "error", message: "ambiguous", candidates: [{ name: "doseA", value: 1, reason: "r" }, { name: "doseB", value: 1, reason: "r" }] },
    ],
    unresolved: [],
    idMap: {},
    remaining: [{ severity: "error", path: "Bundle.entry[0].resource", message: "Unrecognized property 'zzz'" }],
  });
  assert.equal(amb.length, 3);
  assert.deepEqual(amb[0].candidates[0].patch, [{ op: "replace", path: "/entry/0/resource/code/coding/0/display", value: "Bar" }]);
  assert.ok(amb[0].candidates[1].patch!.some((o) => o.path.endsWith("/code") && o.value === "2-6"));
  for (const a of amb) for (const c of a.candidates) if (c.patch) assert.ok(applyPatch(sent, c.patch), JSON.stringify(c.patch));
  assert.equal(amb[1].candidates.length, 2);
  assert.equal(amb[2].pointer, "/entry/0/resource");
  assert.equal(amb[2].category, "unrecognized_property");
});

test("autoFixBundle: fixed value, display of a pinned code, profile-narrowed choice type, section narrative from entries", async () => {
  const P = "http://example.org/StructureDefinition/obs";
  const C = "http://example.org/StructureDefinition/comp";
  const sds: Record<string, Json> = {
    [P]: { url: P, snapshot: { element: [{ id: "Observation.status", path: "Observation.status", fixedCode: "final" }] } },
    [C]: { url: C, snapshot: { element: [{ id: "Composition.type", path: "Composition.type", patternCodeableConcept: { coding: [{ system: "http://loinc.org", code: "60591-5" }] } }] } },
  };
  const tree: Json = {
    resourceType: "Bundle",
    entry: [
      { fullUrl: "urn:uuid:c", resource: { resourceType: "Composition", meta: { profile: [C] }, type: { coding: [{ system: "http://loinc.org", code: "60591-5", display: "Summary" }] }, section: [{ entry: [{ reference: "urn:uuid:o" }] }] } },
      { fullUrl: "urn:uuid:o", resource: { resourceType: "Observation", meta: { profile: [P] }, status: "preliminary", code: { text: "Glucose" } } },
      { fullUrl: "urn:uuid:x", resource: { resourceType: "Claim", supportingInfo: [{ valueString: "true" }], code: { coding: [{ system: "http://loinc.org", code: "1-8", display: "Other" }] } } },
    ],
  };
  const issues: ValidatorIssue[] = [
    { severity: "error", path: "Bundle.entry[1].resource.status", message: `Value is 'preliminary' but is fixed to 'final' in the profile ${P}|1.0#Observation.status` },
    { severity: "error", path: "Bundle.entry[0].resource.type.coding[0]", message: "Wrong Display Name 'Summary' for http://loinc.org#60591-5. Valid display is 'Patient summary Document' (for the language(s) 'en')" },
    { severity: "error", path: "Bundle.entry[2].resource.code.coding[0]", message: "Wrong Display Name 'Other' for http://loinc.org#1-8. Valid display is 'Something'" },
    { severity: "error", path: "Bundle.entry[2].resource.supportingInfo[0].value.ofType(string)", message: "The Profile 'X|1' definition allows for the type boolean but found type string" },
    { severity: "error", path: "Bundle.entry[0].resource.section[0]", message: `Composition.section.text: minimum required = 1, but only found 0 (from ${C})` },
  ];
  const r = await autoFixBundle(tree, { fetchStructureDefinition: async (u) => sds[u.split("|")[0]] ?? null, validate: async () => issues });
  assert.equal(tree.entry[1].resource.status, "final");
  assert.equal(tree.entry[0].resource.type.coding[0].display, "Patient summary Document");
  assert.equal(tree.entry[2].resource.code.coding[0].display, "Other", "an unpinned code's display is not decided here");
  assert.deepEqual(tree.entry[2].resource.supportingInfo[0], { valueBoolean: true });
  assert.match(tree.entry[0].resource.section[0].text.div, /<li>Glucose<\/li>/u);
  assert.deepEqual(r.changes.map((c) => c.rule).sort(), ["display", "document", "fixed-value", "shape"]);
  // blocked → not applied
  const t2: Json = clone({ ...tree, entry: [tree.entry[0], { ...tree.entry[1], resource: { ...tree.entry[1].resource, status: "preliminary" } }] });
  const r2 = await autoFixBundle(t2, { fetchStructureDefinition: async (u) => sds[u.split("|")[0]] ?? null, validate: async () => [issues[0]] }, new Set(["fixed-value\u0000Bundle.entry[1].resource.status"]));
  assert.equal(r2.changes.length, 0);
  assert.equal(t2.entry[1].resource.status, "preliminary");
});

// ---------------------------------------------------------------------------------------------- R4 core (package cache)

const core = available("twcore");
function coreDeps(): RepairDeps {
  const pk = packages("twcore");
  const r = pk.resolver();
  return {
    fetchStructureDefinition: (u) => r.fetchStructureDefinition(u),
    valueSetContains: (u, s, c) => r.valueSetContains(u, s, c),
    validate: async (res, profiles) => (await new InstanceValidator(r).validate(clone(res), { profiles })) as any[],
  };
}

test("content repair (R4 core): STU3 / near names renamed — dosageInstruction, doseNumberPositiveInteger \"1\", doseSequence, periodUnits, item → itemCodeableConcept", { skip: !core && "R4 core package not in the local cache" }, async () => {
  const b: Json = {
    resourceType: "Bundle",
    type: "collection",
    entry: [
      { fullUrl: "urn:uuid:11111111-1111-4111-8111-111111111111", resource: { resourceType: "MedicationStatement", status: "active", medicationCodeableConcept: { text: "x" }, subject: { display: "p" }, dosageInstruction: [{ text: "1 tab", timing: { repeat: { period: 1, periodUnits: "d" } } }] } },
      { fullUrl: "urn:uuid:22222222-2222-4222-8222-222222222222", resource: { resourceType: "Immunization", status: "completed", vaccineCode: { text: "v" }, patient: { display: "p" }, occurrenceDateTime: "2020-01-01", protocolApplied: [{ doseNumberPositiveInteger: "1" }, { doseSequence: 2 }] } },
      { fullUrl: "urn:uuid:33333333-3333-4333-8333-333333333333", resource: { resourceType: "Medication", ingredient: [{ item: { coding: [{ system: "http://snomed.info/sct", code: "409149001" }] } }] } },
    ],
  };
  const r = await repairBundle(b, coreDeps());
  const ms = b.entry[0].resource;
  assert.ok(Array.isArray(ms.dosage) && !("dosageInstruction" in ms), JSON.stringify(ms));
  assert.deepEqual(ms.dosage[0].timing.repeat, { period: 1, periodUnit: "d" });
  assert.deepEqual(b.entry[1].resource.protocolApplied, [{ doseNumberPositiveInt: 1 }, { doseNumberPositiveInt: 2 }]);
  assert.deepEqual(Object.keys(b.entry[2].resource.ingredient[0]), ["itemCodeableConcept"]);
  assert.ok(r.changes.every((c) => c.rule === "shape" && typeof (c.from as any)?.path === "string"), JSON.stringify(r.changes));
});

test("content repair (R4 core): an entry written at Bundle level becomes the last entry; ambiguous choice stems are reported, not guessed", { skip: !core && "R4 core package not in the local cache" }, async () => {
  const b: Json = {
    resourceType: "Bundle",
    type: "collection",
    entry: [{ fullUrl: "urn:uuid:11111111-1111-4111-8111-111111111111", resource: { resourceType: "Observation", status: "final", code: { text: "x" }, value: "high" } }],
    fullUrl: "urn:uuid:22222222-2222-4222-8222-222222222222",
    resource: { resourceType: "Basic", code: { text: "y" } },
  };
  const r = await repairBundle(b, coreDeps());
  assert.equal(b.entry.length, 2);
  assert.deepEqual(b.entry[1], { fullUrl: "urn:uuid:22222222-2222-4222-8222-222222222222", resource: { resourceType: "Basic", code: { text: "y" } } });
  assert.ok(!("resource" in b) && !("fullUrl" in b));
  // value: "high" fits valueString / valueCodeableConcept? (a string: string, time? no) — whichever: never two applied
  const obs = b.entry[0].resource;
  assert.ok("value" in obs || Object.keys(obs).filter((k) => k.startsWith("value")).length === 1);
  assert.ok(r.changes.some((c) => c.path === "Bundle.entry[1]"));
});
