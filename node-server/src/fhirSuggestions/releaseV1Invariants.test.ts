/**
 * release v1 — a failed invariant names what it wants: the expression, its literal values (system / code candidates
 * with their displays), JSON-patchable replacements of the coding the rule is about, and cascades (profile match /
 * entry slices) pointing back to the root cause. Synthetic, no DB.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { literalsOf, literalSuggestions } from "./invariants.js";
import { attachRootCauses } from "./chains.js";

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
