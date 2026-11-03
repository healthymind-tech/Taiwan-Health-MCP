/**
 * ISSUES_v17.3 — IG known defects surfaced by the structure tools, on the TWPAS 1.2.7 package structure
 * (FHIR_PACKAGE_CACHE; skipped when absent). The defect below is a FIXTURE injected through `deps.knownDefects`, to show
 * how a defect on a profile marks the Bundle slices that require it `known_invalid`. It is not a claim about TWPAS: on a
 * correct import ig_selfcheck finds no known_invalid there (206 of 206 examples pass).
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

test("a defect injected on a slice's profile: the Bundle blueprint marks it known_invalid, with the alternative", { skip: !base }, async () => {
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
