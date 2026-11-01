/**
 * ISSUES_v19 R3 (fhirSuggestions/pointers.ts): validator path → JSON Pointer into the instance as
 * sent, suggestion patch → verified JSON Patch, entry permutation of normalize_ids. Synthetic data,
 * no DB.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { finalizeBundle } from "../fhirBundleFinalize.js";
import { FakeResolver } from "../fhirTestKit.test.js";
import { patchApplies, resolvePointer } from "../jsonPatch.js";
import { stringifyLossless } from "../losslessJson.js";
import { inInputPositions } from "./ids.js";
import { addValidationPointers, decorateIssue, entryMapping, linkRelatedPatches, parseFhirPath, suggestionPatchOps, walkFhirPath, type PointerContext } from "./pointers.js";

const OBS = {
  resourceType: "Observation",
  status: "final",
  code: { coding: [{ system: "http://loinc.org", code: "1234-5", display: "x" }] },
  valueString: "12",
  effectiveDateTime: "2024-01-01",
  extension: [{ url: "http://e/a", valueCode: "a" }, { url: "http://e/b", valueCode: "b" }],
  _status: { extension: [{ url: "http://e/s", valueString: "s" }] },
  component: [{ code: { text: "c0" } }, { code: { text: "c1" } }],
};
const BUNDLE = {
  resourceType: "Bundle",
  type: "collection",
  entry: [
    { fullUrl: "urn:uuid:0", resource: { resourceType: "Patient", name: [{ family: "A" }] } },
    { fullUrl: "urn:uuid:1", resource: structuredClone(OBS) },
  ],
};

const ptr = (root: unknown, path: string): { pointer: string; exact: boolean } => {
  const w = walkFhirPath(root, path);
  return { pointer: w.tokens.map((t) => "/" + t.replace(/~/g, "~0").replace(/\//g, "~1")).join(""), exact: w.exact };
};

test("parseFhirPath: indices, choice stems, url qualifiers, functions, comments, slice names", () => {
  const s = parseFhirPath("Bundle.entry[3].resource/*Observation/x*/.value.ofType(string)");
  assert.deepEqual(
    s.map((x) => [x.name, x.index, x.fn]),
    [["Bundle", null, null], ["entry", 3, null], ["resource", null, null], ["value", null, null], ["", null, "ofType"]],
  );
  const t = parseFhirPath("Observation.value[x].extension[url='http://a.b/c'].component:sys[1]");
  assert.equal(t[1].choice, true);
  assert.equal(t[2].url, "http://a.b/c");
  assert.deepEqual([t[3].name, t[3].index], ["component", 1]);
});

test("stand-alone resource paths: root token, arrays, ofType, choice, url qualifier, primitive extensions", () => {
  assert.deepEqual(ptr(OBS, "Observation.code.coding[0].display"), { pointer: "/code/coding/0/display", exact: true });
  assert.deepEqual(ptr(OBS, "Observation.value.ofType(string)"), { pointer: "/valueString", exact: true });
  assert.deepEqual(ptr(OBS, "Observation.value[x]"), { pointer: "/valueString", exact: true });
  assert.deepEqual(ptr(OBS, "Observation.effective"), { pointer: "/effectiveDateTime", exact: true });
  assert.deepEqual(ptr(OBS, "Observation.extension[url='http://e/b'].value[x]"), { pointer: "/extension/1/valueCode", exact: true });
  assert.deepEqual(ptr(OBS, "Observation.extension('http://e/b')"), { pointer: "/extension/1", exact: true });
  assert.deepEqual(ptr(OBS, "Observation.status.extension[0]"), { pointer: "/status", exact: false }); // `status` is a string
  assert.deepEqual(ptr({ resourceType: "Observation", _status: OBS._status }, "Observation.status.extension[0]"), { pointer: "/_status/extension/0", exact: true });
  assert.deepEqual(ptr(OBS, "Observation"), { pointer: "", exact: true });
  assert.deepEqual(ptr(OBS, ""), { pointer: "", exact: true });
});

test("missing leaf → nearest existing ancestor (where to add it)", () => {
  assert.deepEqual(ptr(OBS, "Observation.code.coding[0].version"), { pointer: "/code/coding/0", exact: false });
  assert.deepEqual(ptr(OBS, "Observation.subject.reference"), { pointer: "", exact: false });
  assert.deepEqual(ptr(OBS, "Observation.component[5].code"), { pointer: "/component", exact: false });
  assert.deepEqual(ptr(OBS, "Observation.component.code"), { pointer: "/component", exact: false }); // ambiguous: 2 components
  assert.deepEqual(ptr(OBS, "Observation.value.ofType(Quantity)"), { pointer: "", exact: false });
  assert.deepEqual(ptr(BUNDLE, "Bundle.entry[1].resource.subject.resolve().name"), { pointer: "/entry/1/resource", exact: false });
});

test("Bundle paths", () => {
  assert.deepEqual(ptr(BUNDLE, "Bundle.entry[1].resource.code.coding[0].display"), { pointer: "/entry/1/resource/code/coding/0/display", exact: true });
  assert.deepEqual(ptr(BUNDLE, "Bundle.entry[0].resource.ofType(Patient).name[0].family"), { pointer: "/entry/0/resource/name/0/family", exact: true });
  assert.deepEqual(ptr(BUNDLE, "Bundle.entry[1].resource.value.ofType(string)"), { pointer: "/entry/1/resource/valueString", exact: true });
  assert.deepEqual(ptr(BUNDLE, "Bundle.entry[1]/*Observation/null*/.resource.status"), { pointer: "/entry/1/resource/status", exact: true });
});

test("suggestion patches → JSON Patch ops over the tree", () => {
  assert.deepEqual(suggestionPatchOps(BUNDLE, { op: "replace", path: "Bundle.entry[1].resource.code.coding[0].display", value: "D" }), [
    { op: "replace", path: "/entry/1/resource/code/coding/0/display", value: "D" },
  ]);
  // replace of a missing element → add at its parent
  assert.deepEqual(suggestionPatchOps(BUNDLE, { op: "replace", path: "Bundle.entry[1].resource.code.coding[0].version", value: "1" }), [
    { op: "add", path: "/entry/1/resource/code/coding/0/version", value: "1" },
  ]);
  // add with missing containers: meta.profile on a resource without meta
  assert.deepEqual(suggestionPatchOps(BUNDLE, { op: "add", path: "Bundle.entry[0].resource.meta.profile", value: ["http://p"] }), [
    { op: "add", path: "/entry/0/resource/meta", value: { profile: ["http://p"] } },
  ]);
  // an indexed missing array element is created as an array
  assert.deepEqual(suggestionPatchOps(BUNDLE, { op: "add", path: "Bundle.entry[0].resource.identifier[0].system", value: "urn:x" }), [
    { op: "add", path: "/entry/0/resource/identifier", value: [{ system: "urn:x" }] },
  ]);
  // array insert / append
  assert.deepEqual(suggestionPatchOps(BUNDLE, { op: "add", path: "Bundle.entry[0]", value: { resource: { resourceType: "Composition" } } }), [
    { op: "add", path: "/entry/0", value: { resource: { resourceType: "Composition" } } },
  ]);
  assert.deepEqual(suggestionPatchOps(BUNDLE, { op: "add", path: "Bundle.entry[0].resource.name[1]", value: { family: "B" } }), [
    { op: "add", path: "/entry/0/resource/name/-", value: { family: "B" } },
  ]);
  assert.deepEqual(suggestionPatchOps(BUNDLE, { op: "remove", path: "Bundle.entry[1].resource.valueString" }), [{ op: "remove", path: "/entry/1/resource/valueString" }]);
  assert.equal(suggestionPatchOps(BUNDLE, { op: "remove", path: "Bundle.entry[1].resource.nothing" }), null);
  // rename / move → move
  assert.deepEqual(suggestionPatchOps(BUNDLE, { op: "move", from: "Bundle.entry[1].resource.valueString", path: "Bundle.entry[1].resource.note" }), [
    { op: "move", from: "/entry/1/resource/valueString", path: "/entry/1/resource/note" },
  ]);
  assert.deepEqual(suggestionPatchOps(BUNDLE, { op: "move", from: "Bundle.entry[1]", path: "Bundle.entry[0]" }), [{ op: "move", from: "/entry/1", path: "/entry/0" }]);
  // move into a container that does not exist yet → add (with the value) + remove
  assert.deepEqual(suggestionPatchOps(BUNDLE, { op: "move", from: "Bundle.entry[1].resource.valueString", path: "Bundle.entry[1].resource.note[0].text" }), [
    { op: "add", path: "/entry/1/resource/note", value: [{ text: "12" }] },
    { op: "remove", path: "/entry/1/resource/valueString" },
  ]);
  // a missing choice element cannot be named
  assert.equal(suggestionPatchOps(BUNDLE, { op: "add", path: "Bundle.entry[0].resource.deceased[x]", value: true }), null);
});

test("decorateIssue: pointer, pointer_kind and verified patches; failing candidates dropped; non-errors get no patches", () => {
  const sent = structuredClone(BUNDLE);
  const ctx: PointerContext = { sent, validated: sent, entryMap: null, normalized: false };
  const issue: Record<string, any> = {
    severity: "error",
    path: "Bundle.entry[1].resource.code.coding[0].display",
    message: "Wrong Display Name 'x' for http://loinc.org#1234-5",
    suggestions: [
      { kind: "replace_display", value: "Good", confidence: 0.9, reason: "valid display", patch: { op: "replace", path: "Bundle.entry[1].resource.code.coding[0].display", value: "Good" } },
      { kind: "replace_code", value: "z", confidence: 0.5, reason: "broken", patch: { op: "replace", path: "Bundle.entry[1].resource.code.coding[7].code", value: "z" } },
      { kind: "choose_code", value: "q", confidence: 0.4, reason: "no patch" },
    ],
  };
  decorateIssue(issue, ctx);
  assert.equal(issue.pointer, "/entry/1/resource/code/coding/0/display");
  assert.equal(issue.pointer_kind, "element");
  assert.equal(issue.patches.length, 2); // the [7] candidate becomes an append at /coding/- (applies); choose_code has no patch
  for (const p of issue.patches) assert.ok(patchApplies(sent, p.ops), JSON.stringify(p));
  assert.deepEqual(issue.patches[0], { ops: [{ op: "replace", path: "/entry/1/resource/code/coding/0/display", value: "Good" }], reason: "valid display", kind: "replace_display", confidence: 0.9 });
  assert.deepEqual(sent, BUNDLE, "the sent Bundle is never modified");

  const missing: Record<string, any> = { severity: "error", path: "Bundle.entry[0].resource", message: "Patient.gender: minimum required = 1, but only found 0 (from http://p)" };
  decorateIssue(missing, ctx);
  assert.equal(missing.pointer, "/entry/0/resource");
  assert.equal(missing.patches, undefined);

  const warn: Record<string, any> = { severity: "warning", path: "Bundle.entry[0].resource.name[0].family", message: "w", suggestions: issue.suggestions };
  decorateIssue(warn, ctx);
  assert.equal(warn.pointer, "/entry/0/resource/name/0/family");
  assert.equal(warn.patches, undefined);
});

test("message-derived shape patches (one correct edit)", () => {
  const sent = { resourceType: "Patient", name: { family: "A" }, gender: ["male"], telecom: [], address: [{}], birthDate: "" } as Record<string, any>;
  const ctx: PointerContext = { sent, validated: sent, entryMap: null, normalized: false };
  const cases: Array<[Record<string, any>, unknown]> = [
    [{ severity: "error", path: "Patient.name", message: "The property name must be a JSON Array, not an Object (at Patient)" }, [{ op: "replace", path: "/name", value: [{ family: "A" }] }]],
    [{ severity: "error", path: "Patient.gender", message: "This property must be a simple value, not an Array (gender at Patient.gender)" }, [{ op: "replace", path: "/gender", value: "male" }]],
    [{ severity: "error", path: "Patient.telecom", message: "Array cannot be empty - the property should not be present if it has no values" }, [{ op: "remove", path: "/telecom" }]],
    [{ severity: "error", path: "Patient.address[0]", message: "Constraint failed: ele-1: 'All FHIR elements must have a @value or children'" }, [{ op: "remove", path: "/address/0" }]],
    [{ severity: "error", path: "Patient.birthDate", message: "@value cannot be empty" }, [{ op: "remove", path: "/birthDate" }]],
  ];
  for (const [issue, ops] of cases) {
    decorateIssue(issue, ctx);
    assert.deepEqual(issue.patches?.[0]?.ops, ops, issue.message);
  }
  const fixed: Record<string, any> = { severity: "error", path: "Patient.gender", message: "Value is 'x' but must be 'female' (fixed by http://p)" };
  decorateIssue(fixed, { ...ctx, sent: { resourceType: "Patient", gender: "x" }, validated: { resourceType: "Patient", gender: "x" } });
  assert.deepEqual(fixed.patches[0].ops, [{ op: "replace", path: "/gender", value: "female" }]);
});

test("ids: finalizer change paths are mapped back to the sent entry positions", async () => {
  const sent = {
    resourceType: "Bundle",
    type: "document",
    entry: [
      { fullUrl: "Patient/p1", resource: { resourceType: "Patient", id: "p1" } },
      { fullUrl: "Composition/c1", resource: { resourceType: "Composition", id: "c1", subject: { reference: "Patient/p1" } } },
    ],
  };
  const fin = await finalizeBundle(sent, new FakeResolver(), {});
  const mapped = inInputPositions(fin, 2);
  // the Patient's fullUrl change is at output position 1, input position 0
  const out = fin.changes.find((c) => c.rule === "fullUrl-uuid" && c.from === "Patient/p1")!;
  const inn = mapped.changes.find((c) => c.rule === "fullUrl-uuid" && c.from === "Patient/p1")!;
  assert.equal(out.path, "Bundle.entry[1].fullUrl");
  assert.equal(inn.path, "Bundle.entry[0].fullUrl");
  const ref = mapped.changes.find((c) => c.rule === "reference-rewire")!;
  assert.equal(ref.path, "Bundle.entry[1].resource.subject.reference");
  assert.equal(mapped.changes.find((c) => c.rule === "document-order")!.path, "Bundle.entry[1]");
});

test("normalize_ids envelope: pointers name the sent entries (document reorder mapped back, fullUrl checked)", async () => {
  const sent = {
    resourceType: "Bundle",
    type: "document",
    entry: [
      { fullUrl: "Patient/p1", resource: { resourceType: "Patient", id: "p1", gender: ["male"] } },
      { fullUrl: "Observation/o1", resource: { resourceType: "Observation", id: "o1", status: "final" } },
      { fullUrl: "Composition/c1", resource: { resourceType: "Composition", id: "c1", subject: { reference: "Patient/p1" } } },
    ],
  };
  const fin = await finalizeBundle(sent, new FakeResolver(), {});
  const V = fin.bundle;
  assert.equal(V.entry[0].resource.resourceType, "Composition");
  const map = entryMapping(sent, V, fin.changes, true);
  assert.deepEqual([...map.entries()], [[0, 2], [1, 0], [2, 1]]);
  const env = {
    ok: true,
    data: {
      valid: false,
      issues: [{ severity: "information", path: "Bundle.entry[1].fullUrl", message: "Normalized" }],
      entries: V.entry.map((e: any, k: number) => ({
        fullUrl: e.fullUrl,
        resourceType: e.resource.resourceType,
        issues:
          k === 1
            ? [{ severity: "error", path: "Bundle.entry[1].resource.gender", message: "This property must be a simple value, not an Array (gender at Bundle.entry[1].resource.gender)" }]
            : k === 2
              ? [{ severity: "error", path: "Bundle.entry[2].resource", message: "Observation.code: minimum required = 1, but only found 0 (from x)" }]
              : [],
      })),
      normalized_bundle: V,
      id_changes: fin.changes,
    },
  };
  const out = JSON.parse(addValidationPointers(stringifyLossless(env), sent));
  assert.deepEqual(out.data.entries.map((r: any) => r.pointer), ["/entry/2", "/entry/0", "/entry/1"]);
  const g = out.data.entries[1].issues[0];
  assert.equal(g.pointer, "/entry/0/resource/gender");
  assert.equal(resolvePointer(sent, `${out.data.entries[1].pointer}/resource`).value, sent.entry[0].resource); // the Patient
  assert.deepEqual(g.patches[0].ops, [{ op: "replace", path: "/entry/0/resource/gender", value: "male" }]);
  assert.ok(patchApplies(sent, g.patches[0].ops));
  assert.equal(out.data.entries[2].issues[0].pointer, "/entry/1/resource");
  assert.equal(out.data.issues[0].pointer, "/entry/0/fullUrl");
  // the sent entry the pointer names is the one the row reports (by fullUrl, followed back through id_changes)
  const back = new Map(fin.changes.filter((c) => c.rule === "fullUrl-uuid").map((c) => [c.to, c.from]));
  out.data.entries.forEach((r: any) => {
    const k = Number(r.pointer.split("/")[2]);
    assert.equal(sent.entry[k].fullUrl, back.get(r.fullUrl) ?? r.fullUrl);
  });
  // everything else unchanged
  assert.equal(out.data.valid, false);
  assert.equal(out.data.entries[1].issues[0].message, env.data.entries[1].issues[0].message);
});

test("default mode: a fullUrl replacement carries the reference rewrites that go with it", async () => {
  const sent = {
    resourceType: "Bundle",
    type: "collection",
    entry: [
      { fullUrl: "urn:uuid:PATIENT-1", resource: { resourceType: "Patient" } },
      { fullUrl: "urn:uuid:obs-1", resource: { resourceType: "Observation", subject: { reference: "urn:uuid:PATIENT-1" } } },
    ],
  };
  const fin = await finalizeBundle(sent, new FakeResolver(), {});
  const fu = fin.changes.find((c) => c.rule === "fullUrl-uuid" && c.from === "urn:uuid:PATIENT-1");
  assert.ok(fu, JSON.stringify(fin.changes));
  const env = {
    ok: true,
    data: {
      valid: false,
      issues: [],
      entries: [
        {
          fullUrl: "urn:uuid:PATIENT-1",
          issues: [
            {
              severity: "error",
              path: "Bundle.entry[0].fullUrl",
              message: "UUIDs must be valid and lowercase (PATIENT-1)",
              suggestions: [{ kind: "replace_fullurl", value: fu!.to, confidence: 0.95, reason: "r", patch: { op: "replace", path: "Bundle.entry[0].fullUrl", value: fu!.to } }],
            },
          ],
        },
        { fullUrl: "urn:uuid:obs-1", issues: [] },
      ],
      id_changes: fin.changes,
    },
  };
  const out = JSON.parse(addValidationPointers(stringifyLossless(env), sent));
  const p = out.data.entries[0].issues[0].patches[0];
  assert.deepEqual(p.ops[0], { op: "replace", path: "/entry/0/fullUrl", value: fu!.to });
  assert.ok(p.ops.some((o: any) => o.path === "/entry/1/resource/subject/reference" && o.value === fu!.to), JSON.stringify(p));
  assert.ok(patchApplies(sent, p.ops));
});

test("envelope fail-open: not an envelope / no issues → text unchanged", () => {
  assert.equal(addValidationPointers("not json", {}), "not json");
  const t = JSON.stringify({ ok: false, error: { code: "X" } });
  assert.equal(addValidationPointers(t, {}), t);
  const clean = JSON.stringify({ ok: true, data: { valid: true, issues: [] } });
  assert.equal(addValidationPointers(clean, { resourceType: "Patient" }), clean);
});

test("linkRelatedPatches: required element supplied by a rename, ele-1 of unrecognised children, blocked slice match, slice values", () => {
  const sent = {
    resourceType: "Bundle",
    type: "collection",
    entry: [
      { fullUrl: "urn:uuid:a", resource: { resourceType: "Immunization", protocolApplied: [{ doseNumberPositiveInteger: 1 }] } },
      { fullUrl: "urn:uuid:b", resource: { resourceType: "Claim", diagnosis: [{ diagnosisCodeableConcept: { coding: [{ system: "http://x/icd", code: "C1" }] } }] } },
    ],
  };
  const rename = {
    ops: [{ op: "move", from: "/entry/0/resource/protocolApplied/0/doseNumberPositiveInteger", path: "/entry/0/resource/protocolApplied/0/doseNumberPositiveInt" }],
    reason: "typo",
    kind: "rename_property",
    confidence: 0.9,
  };
  const unrec: Record<string, any> = { severity: "error", path: "Bundle.entry[0].resource.protocolApplied[0]", pointer: "/entry/0/resource/protocolApplied/0", message: "Unrecognized property 'doseNumberPositiveInteger'", patches: [rename] };
  const ele1: Record<string, any> = { severity: "error", path: unrec.path, pointer: unrec.pointer, message: "Constraint failed: ele-1: 'All FHIR elements must have a @value or children'" };
  const min: Record<string, any> = { severity: "error", path: unrec.path, pointer: unrec.pointer, message: "Immunization.protocolApplied.doseNumber[x]: minimum required = 1, but only found 0 (from x)" };
  const blocked: Record<string, any> = {
    severity: "error",
    path: "Bundle.entry[0]",
    pointer: "/entry/0",
    message: "This element does not match any known slice defined in the profile http://b and slicing is CLOSED",
    slice_match: { closest: { slice: "imm", profile: "http://imm", score: 1 }, failed: [], blocking: [{ path: unrec.path, message: unrec.message }], blocking_total: 1 },
  };
  const coding: Record<string, any> = {
    severity: "error",
    path: "Bundle.entry[1].resource.diagnosis[0].diagnosisCodeableConcept.coding[0]",
    pointer: "/entry/1/resource/diagnosis/0/diagnosisCodeableConcept/coding/0",
    message: "This element does not match any known slice defined in the profile http://claim and slicing is CLOSED",
    slice_match: { closest: null, failed: [{ reason: "pattern-differs", path: "system", expected: "http://tw/icd" }], options: [{ slice: "tw", card: "0..1", requires: { system: "http://tw/icd" } }] },
  };
  const none: Record<string, any> = { severity: "error", path: "Bundle.entry[1].resource", pointer: "/entry/1/resource", message: "Claim.patient: minimum required = 1, but only found 0 (from x)" };
  linkRelatedPatches([unrec, ele1, min, blocked, coding, none], sent);
  assert.deepEqual(min.patches[0].ops, rename.ops);
  assert.deepEqual(ele1.patches[0].ops, rename.ops);
  assert.equal(blocked.patches[0].kind, "fix_blocking");
  assert.deepEqual(blocked.patches[0].ops, rename.ops);
  assert.deepEqual(coding.patches[0].ops, [{ op: "replace", path: "/entry/1/resource/diagnosis/0/diagnosisCodeableConcept/coding/0/system", value: "http://tw/icd" }]);
  assert.equal(none.patches, undefined, "missing record content: pointer only, never an invented value");
  for (const i of [min, ele1, blocked, coding]) for (const p of i.patches) assert.ok(patchApplies(sent, p.ops));
});
