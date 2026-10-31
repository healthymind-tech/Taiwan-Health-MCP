/**
 * ISSUES_v17.3 — IG known defects (igKnownDefects.ts): derived from synthetic self-check results; the validation
 * note names the optional entry and where its information goes.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { annotateKnownDefects, deriveKnownDefects, elementOf, ruleOf, runSelfcheck, type ExampleResult } from "./igKnownDefects.js";

const COND = "http://x/StructureDefinition/Condition-x";
const BUN = "http://x/StructureDefinition/Bundle-x";
const ORG = "http://x/StructureDefinition/Organization-x";
const SLICE = (p: string) => `This element does not match any known slice defined in the profile ${p} and slicing is CLOSED`;
const types = (p: string): string => (p === COND ? "Condition" : p === BUN ? "Bundle" : "Organization");
const err = (path: string, message: string) => ({ severity: "error", path, message });

test("elementOf / ruleOf: indices and instance values do not split a rule", () => {
  assert.equal(elementOf("Bundle.entry[3].resource.code.coding[0]", "Condition"), "Condition.code.coding");
  assert.equal(elementOf("Condition.code.coding[1]", "Condition"), "Condition.code.coding");
  assert.equal(ruleOf("Value '12' at http://a/b is wrong (3)"), ruleOf("Value '7' at http://c/d is wrong (9)"));
});

test("a structural error in every example of a profile is a known defect; value errors and partial ones are not known_invalid", () => {
  const results: ExampleResult[] = [
    { source: "con-1", profile: COND, issues: [err("Condition.code.coding[0]", SLICE(COND))] },
    { source: "bun-1#2", profile: COND, issues: [err("Condition.code.coding[0]", SLICE(COND))] },
    { source: "org-1", profile: ORG, issues: [err("Organization.identifier[0].system", "Example URLs are not allowed in this context (http://example.org/x)")] },
    { source: "org-2", profile: ORG, issues: [] },
    // the Bundle's entry slice error is the consequence of its failing Condition entry
    { source: "bun-1", profile: BUN, issues: [err("Bundle.entry[2]", SLICE(BUN)), err("Bundle.entry[2].resource.code.coding[0]", SLICE(COND))] },
  ];
  const d = deriveKnownDefects(results, types);
  assert.deepEqual(d.map((x) => [x.profile, x.element, x.knownInvalid, x.failing, x.total]), [[COND, "Condition.code.coding", true, 2, 2]]);
  assert.deepEqual(d[0].examples, ["con-1", "bun-1#2"]);
});

test("validation note: matching issue gets ig_known_defect + advice naming the CodeableConcept alternative; others untouched", () => {
  const defects = deriveKnownDefects([{ source: "con-1", profile: COND, issues: [err("Condition.code.coding[0]", SLICE(COND))] }], types);
  const bundle = {
    resourceType: "Bundle",
    entry: [
      { fullUrl: "urn:uuid:c", resource: { resourceType: "Claim", diagnosis: [{ sequence: 1, diagnosisReference: { reference: "urn:uuid:d" } }] } },
      { fullUrl: "urn:uuid:d", resource: { resourceType: "Condition", meta: { profile: [`${COND}|1.0`] }, code: { coding: [{ code: "M17.11" }] } } },
    ],
  };
  const issues: Array<Record<string, any>> = [
    { severity: "error", path: "Bundle.entry[1].resource.code.coding[0]", message: SLICE(COND) },
    { severity: "error", path: "Bundle.entry[1].resource.subject", message: "minimum required = 1, but only found 0" },
  ];
  annotateKnownDefects(issues, bundle, null, defects);
  assert.equal(issues[0].ig_known_defect.profile, COND);
  assert.match(issues[0].message, /IG known defect/);
  assert.match(issues[0].ig_known_defect.advice, /Claim\.diagnosis\.diagnosisCodeableConcept/);
  assert.equal(issues[0].severity, "error", "severity unchanged");
  assert.equal(issues[1].ig_known_defect, undefined);
  assert.doesNotMatch(issues[1].message, /known defect/);
});

test("runSelfcheck: examples validated against the package's own profiles they declare (Bundle entries too)", async () => {
  const seen: string[] = [];
  const run = await runSelfcheck({
    examples: async () => [
      { source: "con-1", resource: { resourceType: "Condition", meta: { profile: [COND] } } },
      { source: "bun-1", resource: { resourceType: "Bundle", meta: { profile: [BUN] }, entry: [{ resource: { resourceType: "Condition", meta: { profile: [COND] } } }, { resource: { resourceType: "Patient", meta: { profile: ["http://other/Patient"] } } }] } },
    ],
    profiles: async () => new Map([[COND, "Condition"], [BUN, "Bundle"]]),
    validate: async (r, p) => {
      seen.push(`${r.resourceType}@${p}`);
      return r.resourceType === "Condition" ? [err("Condition.code.coding[0]", SLICE(COND))] : [];
    },
  });
  assert.deepEqual(seen.sort(), [`Bundle@${BUN}`, `Condition@${COND}`, `Condition@${COND}`]);
  assert.equal(run.examplesTotal, 3);
  assert.equal(run.examplesValid, 1);
  assert.equal(run.defects.length, 1);
});
