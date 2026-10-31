/**
 * ISSUES_v17.3 — IG known defects surfaced by the structure tools, on TWPAS 1.2.7 (FHIR_PACKAGE_CACHE; skipped
 * when absent): the Condition-twpas defect (its own examples fail the closed `pattern $this` slicing) marks the
 * Bundle slices that require it `known_invalid`, with where the diagnosis goes instead.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { bundleBlueprint } from "./blueprint.js";
import { availableClosure, fileBlueprintDeps, TWPAS_CLOSURE } from "./fileDeps.test.js";
import { deriveKnownDefects } from "../igKnownDefects.js";

const PAS = availableClosure(TWPAS_CLOSURE);
const base = PAS ? fileBlueprintDeps(PAS) : null;
const COND = "https://nhicore.nhi.gov.tw/pas/StructureDefinition/Condition-twpas";
const defects = deriveKnownDefects(
  [{ source: "con-diagnosis", profile: COND, issues: [{ severity: "error", path: "Condition.code.coding[0]", message: `This element does not match any known slice defined in the profile ${COND} and slicing is CLOSED` }] }],
  () => "Condition",
);

test("TWPAS Bundle blueprint: Condition slices are known_invalid with the Claim.diagnosis alternative", { skip: !base }, async () => {
  const deps = { ...base!, knownDefects: async () => defects };
  const r = await bundleBlueprint({ bundle_profile: "Bundle-twpas" }, deps);
  const ki = (r.data.known_invalid ?? []) as Array<Record<string, any>>;
  console.log(JSON.stringify(ki));
  assert.ok(ki.length >= 1, "a known_invalid slice");
  assert.ok(ki.every((k) => k.known_invalid === true && /official validation/.test(k.note)));
  assert.ok(ki.some((k) => /claim: diagnosis\.diagnosisCodeableConcept/i.test(k.note)), "names where the diagnosis goes");
  const plain = await bundleBlueprint({ bundle_profile: "Bundle-twpas" }, base!);
  assert.equal(plain.data.known_invalid, undefined, "nothing known: output unchanged");
});
