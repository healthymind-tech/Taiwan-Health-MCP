/** fhir_validate_bundle reports why `checked_fully` is false, with the same fields as fhir_validate_resource. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { FHIRIGService, noOfficialValidatorIssue, officialVerdictFields } from "./fhirIgService.js";

test("validateBundle carries codes / slices / invariants unchecked and lookups_failed", async () => {
  const svc = new FHIRIGService(null) as unknown as Record<string, any>;
  svc.resolve = async () => ({ package_id: "p", version: "1", fhir_version: "4.0.1" });
  svc.validateCore = async () => ({
    valid: true,
    issues: [],
    checked_fully: false,
    profiles_unchecked: ["http://x/p"],
    valuesets_unchecked: ["http://x/v"],
    codes_unchecked: ["http://x/c"],
    slices_unchecked: ["http://x/p#a"],
    invariants_unchecked: ["http://x/p#k"],
    lookups_failed: 2,
    undecided_causes: ["http://snomed.info/sct|http://x/v"],
  });
  const env = JSON.parse(await svc.validateBundle({ resourceType: "Bundle", type: "collection" }));
  assert.equal(env.data.checked_fully, false);
  assert.deepEqual(env.data.codes_unchecked, ["http://x/c"]);
  assert.deepEqual(env.data.slices_unchecked, ["http://x/p#a"]);
  assert.deepEqual(env.data.invariants_unchecked, ["http://x/p#k"]);
  assert.equal(env.data.lookups_failed, 2);
  assert.deepEqual(env.data.undecided_causes, ["http://snomed.info/sct|http://x/v"]);
  assert.deepEqual(env.data.profiles_unchecked, ["http://x/p"]);
  assert.deepEqual(env.data.valuesets_unchecked, ["http://x/v"]);
});

test("engine / official_verdict: unchanged with an official validator; builtin + \"none\" without one", () => {
  assert.deepEqual(officialVerdictFields(true, true, null, 0), { engine: "hl7-official", fields: { official_verdict: true } });
  assert.deepEqual(officialVerdictFields(true, true, null, 2), { engine: "hl7-official", fields: { checked_fully: false, official_verdict: true } });
  assert.deepEqual(officialVerdictFields(true, false, "timed out", 0), { engine: "mcp-fallback", fields: { checked_fully: false, official_verdict: false, fallback_reason: "timed out" } });
  assert.deepEqual(officialVerdictFields(true, true, "down (require)", 0), { engine: "hl7-official", fields: { checked_fully: false, official_verdict: false, fallback_reason: "down (require)" } });
  assert.deepEqual(officialVerdictFields(false, false, null, 0), { engine: "builtin", fields: { official_verdict: "none" } });
  const w = noOfficialValidatorIssue("tw.gov.mohw.twcore", "0.2.0");
  assert.equal(w.severity, "warning");
  assert.equal(w.message, "No official validator serves tw.gov.mohw.twcore#0.2.0: this result is for fixing only, not an official verdict; fhir_release_check will not release it.");
  assert.equal(w.message_zh, "此 IG 沒有官方 validator，結果僅供修正參考，release_check 會擋下");
});

test("validateBundle passes engine \"builtin\" / official_verdict \"none\" and the warning through", async () => {
  const svc = new FHIRIGService(null) as unknown as Record<string, any>;
  svc.resolve = async () => ({ package_id: "p", version: "1", fhir_version: "4.0.1" });
  svc.validateCore = async () => ({ valid: true, source: "builtin", engine: "builtin", issues: [noOfficialValidatorIssue("p", "1")], checked_fully: true, official_verdict: "none" });
  const env = JSON.parse(await svc.validateBundle({ resourceType: "Bundle", type: "collection" }));
  assert.equal(env.data.engine, "builtin");
  assert.equal(env.data.official_verdict, "none");
  assert.ok(JSON.stringify(env.data).includes("No official validator serves p#1"), JSON.stringify(env.data));
});
