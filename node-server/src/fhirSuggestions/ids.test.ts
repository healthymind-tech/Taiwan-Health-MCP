/**
 * fhirSuggestions/ids: ID-class suggestions and normalize_ids information issues for
 * fhir_validate_bundle (ISSUES_v9 R2). Synthetic data; the finalizer runs on the test kit.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { finalizeBundle } from "../fhirBundleFinalize.js";
import { FakeResolver } from "../fhirTestKit.test.js";
import { attachIdSuggestions, isIdClassIssue, normalizationIssues } from "./ids.js";

const deps = new FakeResolver();

const LABELLED = {
  resourceType: "Bundle",
  id: "urn:uuid:b1",
  type: "collection",
  entry: [
    { fullUrl: "urn:uuid:patient-1", resource: { resourceType: "Patient", id: "patient-1" } },
    { fullUrl: "urn:uuid:cond-1", resource: { resourceType: "Condition", subject: { reference: "Patient/patient-1" } } },
    { resource: { resourceType: "Condition", subject: { reference: "Patient/nobody" } } },
  ],
};

test("isIdClassIssue recognises the validator's identity / wiring messages only", () => {
  const yes = [
    "UUIDs must be valid and lowercase (patient-1)",
    "Invalid Resource id: Invalid Characters ('urn:uuid:x')",
    "Bundle entry missing fullUrl",
    "Except for transactions and batches, each entry in a Bundle must have a fullUrl which is the identity of the resource in the entry",
    "URN reference is not locally contained within the bundle urn:uuid:patient-1",
    "Entry 0 matches the reference Patient/patient-1 by type and id but its fullUrl urn:uuid:x does not match the full target URL",
    "Can't find 'urn:uuid:x' in the bundle (Composition.subject)",
    "Constraint failed: bdl-7: 'FullUrl must be unique in a bundle, or else entries with the same fullUrl must have different meta.versionId (except in history bundles)'",
    "The first entry in a document must be a composition",
  ];
  for (const m of yes) assert.ok(isIdClassIssue({ message: m }), m);
  for (const m of ["Unknown code 'x' in the CodeSystem 'y'", "Unrecognized property 'foo'", "Unable to find a profile match for urn:uuid:x among choices: P"]) {
    assert.ok(!isIdClassIssue({ message: m }), m);
  }
});

test("ID-class issues get the finalizer's replacement as suggestions (fullUrl, reference, id, missing fullUrl, profile-match cascade)", async () => {
  const fin = await finalizeBundle(LABELLED, deps);
  const issues: Array<Record<string, any>> = [
    { severity: "error", path: "Bundle.entry[0].fullUrl", code: "invalid", message: "UUIDs must be valid and lowercase (patient-1)" },
    { severity: "error", path: "Bundle.entry[1].fullUrl", code: "invalid", message: "UUIDs must be valid and lowercase (cond-1)" },
    { severity: "warning", path: "Bundle.entry[1].resource.subject", code: "not-found", message: "Entry 0 matches the reference Patient/patient-1 by type and id but its fullUrl urn:uuid:patient-1 does not match the full target URL" },
    { severity: "error", path: "Bundle.entry[1].resource.subject", code: "structure", message: "Unable to find a profile match for Patient/patient-1 among choices: http://x/P", suggestions: [{ value: "keep", kind: "replace_code", confidence: 0.1, reason: "existing" }] },
    { severity: "error", path: "Bundle.entry[2]", code: "structure", message: "Except for transactions and batches, each entry in a Bundle must have a fullUrl which is the identity of the resource in the entry" },
    { severity: "error", path: "Bundle.entry[2].resource.subject", code: "structure", message: "Relative Reference appears inside Bundle whose entry is missing a fullUrl" },
    { severity: "error", path: "Bundle.id", code: "invalid", message: "Invalid Resource id: Invalid Characters ('urn:uuid:b1')" },
    { severity: "error", path: "Bundle.entry[1].resource.code", code: "code-invalid", message: "Unknown code 'x' in the CodeSystem 'y'" },
  ];
  const before = issues.map((i) => ({ ...i, suggestions: undefined }));
  const n = attachIdSuggestions(issues, fin);
  assert.equal(n, 7);
  const fu0 = fin.bundle.entry[0].fullUrl;
  assert.deepEqual(issues[0].suggestions[0].patch, { op: "replace", path: "Bundle.entry[0].fullUrl", value: fu0 });
  assert.equal(issues[0].suggestions[0].kind, "replace_fullurl");
  assert.equal(issues[2].suggestions[0].kind, "replace_reference");
  assert.equal(issues[2].suggestions[0].value, fu0);
  assert.equal(issues[3].suggestions[0].value, fu0, "profile-match cascade on a rewired reference gets the rewire first");
  assert.equal(issues[3].suggestions[1].value, "keep", "existing suggestions are kept after ours");
  assert.equal(issues[4].suggestions[0].patch.op, "add");
  assert.equal(issues[4].suggestions[0].patch.path, "Bundle.entry[2].fullUrl");
  // Unresolved reference: candidates of the referenced type, lower confidence.
  assert.equal(issues[5].suggestions[0].kind, "replace_reference");
  assert.equal(issues[5].suggestions[0].value, fu0);
  assert.ok(issues[5].suggestions[0].confidence < 0.9);
  assert.equal(issues[6].suggestions[0].value, "b1");
  assert.equal(issues[6].suggestions[0].kind, "replace_id");
  assert.equal(issues[7].suggestions, undefined, "non-ID issues untouched");
  // Only `suggestions` was added.
  issues.forEach((i, k) => assert.deepEqual({ ...i, suggestions: undefined }, before[k]));
});

test("normalizationIssues are information-level, one per change, at the change path", async () => {
  const fin = await finalizeBundle(LABELLED, deps);
  const info = normalizationIssues(fin.changes);
  assert.equal(info.length, fin.changes.length);
  for (const i of info) {
    assert.equal(i.severity, "information");
    assert.match(i.message, /^Normalized by normalize_ids \((fullUrl-uuid|reference-rewire|resource-id)\): /);
  }
  assert.equal(info.find((i) => i.path === "Bundle.entry[2].fullUrl")!.message.includes("(missing)"), true);
});
