/** fhir_validate_bundle reports why `checked_fully` is false, with the same fields as fhir_validate_resource. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { FHIRIGService } from "./fhirIgService.js";

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
