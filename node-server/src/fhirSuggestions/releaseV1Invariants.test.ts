/**
 * release v1 — a failed invariant names what it wants: the expression, its literal values (system / code candidates
 * with their displays), JSON-patchable replacements of the coding the rule is about, and cascades (profile match /
 * entry slices) pointing back to the root cause. Synthetic, no DB.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { identifierSystemsOf, literalsOf, literalSuggestions } from "./invariants.js";
import { attachRootCauses } from "./chains.js";
import { decorateIssue, type PointerContext } from "./pointers.js";

const V2 = "http://terminology.hl7.org/CodeSystem/v2-0203";
const EXPR = `identifier.where(type.coding.where(system = '${V2}' and (code = 'NNxxx' or code = 'PPN' or code = 'PRC')).exists()).exists()`;
const DISPLAY: Record<string, string> = {
  NNxxx: "National Person Identifier where the xxx is the ISO table 3166 3-character (alphabetic) country code",
  PPN: "Passport number",
  PRC: "Permanent Resident Card Number",
  NI: "National unique individual identifier",
  MR: "Medical record number",
};

test("literalsOf: systems, codes paired with their system, formats", () => {
  const l = literalsOf(EXPR);
  assert.deepEqual(l.systems, [V2]);
  assert.deepEqual(l.codes, ["NNxxx", "PPN", "PRC"].map((code) => ({ code, system: V2 })));
  assert.equal(l.values, undefined, "system / code literals are not repeated as values");
  assert.deepEqual(literalsOf("value.ofType(Quantity).value.all(toString().matches('^[0-9]{1,4}$'))").formats, ["^[0-9]{1,4}$"]);
  assert.deepEqual(literalsOf("status = 'final' or code.coding.where(code = 'x').exists()").values, [{ path: "status", value: "final" }]);
});

test("literalSuggestions: only the coding the rule is about (NI, not MR) gets the accepted codes, best first", async () => {
  const lits = literalsOf(EXPR);
  for (const c of lits.codes!) c.display = DISPLAY[c.code];
  const patient = { resourceType: "Patient", identifier: [{ type: { coding: [{ system: V2, code: "NI" }] }, value: "A123" }, { type: { coding: [{ system: V2, code: "MR" }] }, value: "9" }] };
  const s = await literalSuggestions("pat-id-1", lits, patient, "Patient", async (_s, c) => DISPLAY[c] ?? null);
  assert.deepEqual(s.map((x) => [x.patch!.path, x.value]), [
    ["Patient.identifier[0].type.coding[0].code", "NNxxx"],
    ["Patient.identifier[0].type.coding[0].code", "PPN"],
    ["Patient.identifier[0].type.coding[0].code", "PRC"],
  ]);
  assert.match(s[1].reason, /Passport number/u);
  assert.ok(s[0].confidence > s[1].confidence);
  // no coding of the rule's system at all: nothing is invented
  assert.deepEqual(await literalSuggestions("pat-id-1", lits, { resourceType: "Patient", identifier: [{ value: "x" }] }, "Patient"), []);
});

test("attachRootCauses: entry-slice and profile-match cascades point back to the failed invariant", () => {
  const root = {
    resourceType: "Bundle",
    entry: [
      { fullUrl: "urn:a", resource: { resourceType: "Composition", subject: { reference: "urn:p" } } },
      { fullUrl: "urn:p", resource: { resourceType: "Patient" } },
      { fullUrl: "urn:e", resource: { resourceType: "Encounter", subject: { reference: "urn:p" } } },
    ],
  };
  const inv = { severity: "error", path: "Bundle.entry[1].resource", message: "Constraint failed: pat-id-1: 'x' (defined in http://x/P)" };
  const encSubject = { severity: "error", path: "Bundle.entry[2].resource.subject", message: "Unable to find a profile match for urn:p among choices: http://x/P" };
  const compEnc = { severity: "error", path: "Bundle.entry[0].resource.encounter", message: "Unable to find a profile match for urn:e among choices: http://x/E", caused_by: [{ fullUrl: "urn:e", entry: 2, severity: "error", path: encSubject.path, message: encSubject.message }] };
  const slice = { severity: "error", path: "Bundle", message: "Slice 'Bundle.entry:Patient': a matching slice is required, but not found (from http://x/B)" };
  const issues: Array<Record<string, any>> = [inv, encSubject, compEnc, slice];
  attachRootCauses(issues, root);
  assert.deepEqual(slice.caused_by && (slice as any).caused_by.map((c: any) => c.message), [inv.message]);
  assert.deepEqual((compEnc as any).root_causes.map((c: any) => c.message), [inv.message], "Composition → Encounter → Patient → pat-id-1");
  assert.equal((inv as any).root_causes, undefined);
});

// ------------------------------------------------------------------------------------------------ v20.1 pat-id-1 patches

const withDisplays = (expr: string): ReturnType<typeof literalsOf> => {
  const l = literalsOf(expr);
  for (const c of l.codes ?? []) c.display = DISPLAY[c.code];
  return l;
};
/** The JSON Patch candidates the validation envelope would carry for one failed-invariant issue (pointers.ts). */
const patchesOf = (sent: Record<string, any>, path: string, suggestions: unknown[]): Array<{ ops: unknown[] }> => {
  const issue: Record<string, any> = { severity: "error", path, message: "Constraint failed: pat-id-1: 'x'", suggestions };
  const ctx: PointerContext = { sent, validated: sent, entryMap: null, normalized: false };
  decorateIssue(issue, ctx);
  return issue.patches ?? [];
};

test("v20.1 literalSuggestions: a replaced code also gets the new code's display (replace / add), or loses a stale one", async () => {
  const lits = withDisplays(EXPR);
  // the coding has the old code's display → replace both
  const patient = { resourceType: "Patient", identifier: [{ type: { coding: [{ system: V2, code: "NI", display: DISPLAY.NI }] }, value: "A123" }] };
  const s = await literalSuggestions("pat-id-1", lits, patient, "Patient", async (_s, c) => DISPLAY[c] ?? null);
  assert.deepEqual(s[0].patch, {
    op: "replace",
    path: "Patient.identifier[0].type.coding[0].code",
    value: "NNxxx",
    also: [{ op: "replace", path: "Patient.identifier[0].type.coding[0].display", value: DISPLAY.NNxxx }],
  });
  assert.deepEqual(patchesOf(patient, "Patient", s.slice(0, 1))[0].ops, [
    { op: "replace", path: "/identifier/0/type/coding/0/code", value: "NNxxx" },
    { op: "replace", path: "/identifier/0/type/coding/0/display", value: DISPLAY.NNxxx },
  ]);
  // no display yet → the display is added
  const bare = { resourceType: "Patient", identifier: [{ type: { coding: [{ system: V2, code: "NI" }] }, value: "A123" }] };
  const s2 = await literalSuggestions("pat-id-1", lits, bare, "Patient", async (_s, c) => DISPLAY[c] ?? null);
  assert.deepEqual(patchesOf(bare, "Patient", s2.slice(0, 1))[0].ops, [
    { op: "replace", path: "/identifier/0/type/coding/0/code", value: "NNxxx" },
    { op: "add", path: "/identifier/0/type/coding/0/display", value: DISPLAY.NNxxx },
  ]);
  // the new code's display is unknown → the old (now wrong) display is removed
  const noDisp = literalsOf(EXPR);
  const s3 = await literalSuggestions("pat-id-1", noDisp, patient, "Patient");
  assert.deepEqual(s3[0].patch?.also, [{ op: "remove", path: "Patient.identifier[0].type.coding[0].display" }]);
});

test("v20.1 literalSuggestions: an accepted code under another (or no) system gets the rule's system", async () => {
  const lits = withDisplays(EXPR);
  const wrongSys = { resourceType: "Patient", identifier: [{ type: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v2-0203x", code: "PPN" }] }, value: "P1" }] };
  const s = await literalSuggestions("pat-id-1", lits, wrongSys, "Patient");
  assert.deepEqual(s.map((x) => [x.kind, x.value, x.patch?.path]), [["replace_system", V2, "Patient.identifier[0].type.coding[0].system"]]);
  assert.deepEqual(patchesOf(wrongSys, "Patient", s)[0].ops, [
    { op: "replace", path: "/identifier/0/type/coding/0/system", value: V2 },
    { op: "add", path: "/identifier/0/type/coding/0/display", value: DISPLAY.PPN },
  ]);
  // a coding without a system (and without a display) is still a coding of type.coding
  const noSys = { resourceType: "Patient", identifier: [{ type: { coding: [{ code: "PPN" }] }, value: "P1" }] };
  const s2 = await literalSuggestions("pat-id-1", lits, noSys, "Patient");
  assert.deepEqual(patchesOf(noSys, "Patient", s2)[0].ops[0], { op: "add", path: "/identifier/0/type/coding/0/system", value: V2 });
});

test("v20.1 literalSuggestions: Identifier.system literals — replaced when one system is accepted and the type code is", async () => {
  const MOI = "http://www.moi.gov.tw";
  const expr = `identifier.where(system = '${MOI}' and type.coding.where(system = '${V2}' and code = 'NNxxx').exists()).exists()`;
  assert.deepEqual(identifierSystemsOf(expr), [MOI], "the type.coding system is not an identifier system");
  assert.deepEqual(identifierSystemsOf(EXPR), []);
  const lits = withDisplays(expr);
  const patient = {
    resourceType: "Patient",
    identifier: [
      { system: "http://www.moi.gov.tw/", type: { coding: [{ system: V2, code: "NNxxx" }] }, value: "A123456789" },
      { system: "https://example.org/mrn", type: { coding: [{ system: V2, code: "MR" }] }, value: "9" },
    ],
  };
  const s = await literalSuggestions("pat-id-x", lits, patient, "Patient", undefined, expr);
  const sys = s.filter((x) => x.kind === "replace_system");
  assert.deepEqual(sys.map((x) => [x.value, x.patch?.path]), [[MOI, "Patient.identifier[0].system"]], "only the identifier whose type the rule accepts");
  assert.deepEqual(patchesOf(patient, "Patient", sys)[0].ops, [{ op: "replace", path: "/identifier/0/system", value: MOI }]);
  // two accepted systems: which one is not known → no identifier-system patch
  const two = `identifier.where(system = '${MOI}' or system = 'https://example.org/b').exists() and identifier.type.coding.where(code = 'NNxxx').exists()`;
  const s2 = await literalSuggestions("x", withDisplays(two), patient, "Patient", undefined, two);
  assert.deepEqual(s2.filter((x) => x.kind === "replace_system" && x.patch?.path.endsWith("identifier[0].system")), []);
});
