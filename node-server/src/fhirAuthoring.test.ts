/**
 * Unit tests for the slice-aware pinning of fhirAuthoring.ts (fhir_finalize_resource):
 * discriminator-decided members, nested `_slice` tags and the shared pinned fragment.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { COND_PROFILE, SDS, VITAL, el, sd } from "./fhirTestKit.test.js";
import { decidedSliceMatch, pinFixedPattern, pinSliceMembers, pinSlices, pinnedFragment, projectedById } from "./fhirAuthoring.js";

const OBS_CAT = "http://terminology.hl7.org/CodeSystem/observation-category";
const UCUM = "http://unitsofmeasure.org";

const BP = "http://example.tw/fhir/StructureDefinition/bp-pin";
const comp = (name: string, code: string): Array<Record<string, any>> => [
  el(`Observation.component:${name}`, 1, "1", ["BackboneElement"]),
  el(`Observation.component:${name}.code`, 1, "1", ["CodeableConcept"]),
  el(`Observation.component:${name}.code.coding`, 1, "*", ["Coding"], { slicing: { discriminator: [{ type: "value", path: "code" }, { type: "value", path: "system" }], rules: "open" } }),
  el(`Observation.component:${name}.code.coding:Code`, 1, "1", ["Coding"]),
  el(`Observation.component:${name}.code.coding:Code.system`, 1, "1", ["uri"], { fixedUri: "http://loinc.org" }),
  el(`Observation.component:${name}.code.coding:Code.code`, 1, "1", ["code"], { fixedCode: code }),
  el(`Observation.component:${name}.value[x]`, 0, "1", ["Quantity"]),
  el(`Observation.component:${name}.value[x].system`, 1, "1", ["uri"], { fixedUri: UCUM }),
  el(`Observation.component:${name}.value[x].code`, 1, "1", ["code"], { fixedCode: "mm[Hg]" }),
];
const BP_SD = sd(BP, "Observation", "resource", [
  el("Observation", 0, "*"),
  el("Observation.status", 1, "1", ["code"]),
  el("Observation.code", 1, "1", ["CodeableConcept"]),
  el("Observation.component", 2, "*", ["BackboneElement"], {
    slicing: { discriminator: [{ type: "value", path: "code.coding.code" }, { type: "value", path: "code.coding.system" }], rules: "open" },
  }),
  el("Observation.component.code", 1, "1", ["CodeableConcept"]),
  el("Observation.component.value[x]", 0, "1", ["Quantity", "string"]),
  ...comp("SystolicBP", "8480-6"),
  ...comp("DiastolicBP", "8462-4"),
]);

test("pinnedFragment: nested coding slices become array items, single-type choices their JSON property", () => {
  const E = projectedById(BP_SD);
  assert.deepEqual(pinnedFragment("Observation.component:SystolicBP", E), {
    code: { coding: [{ system: "http://loinc.org", code: "8480-6" }] },
    valueQuantity: { system: UCUM, code: "mm[Hg]" },
  });
  assert.equal(pinnedFragment("Observation.status", E), undefined);
  // VITAL: the slice's own pattern plus nothing below it
  assert.deepEqual(pinnedFragment("Observation.category:VSCat", projectedById(SDS[VITAL])), { coding: [{ system: OBS_CAT, code: "vital-signs" }] });
});

test("pinSliceMembers: a component whose code identifies the slice gets the slice's unit system / code (nothing invented)", () => {
  const draft: Record<string, any> = {
    resourceType: "Observation",
    status: "final",
    component: [
      { code: { coding: [{ system: "http://loinc.org", code: "8480-6" }] }, valueQuantity: { value: 120, unit: "mmHg" } },
      { code: { coding: [{ system: "http://loinc.org", code: "8462-4" }] }, valueQuantity: { value: 80, unit: "mmHg" } },
      { code: { coding: [{ system: "http://loinc.org", code: "8867-4" }] }, valueQuantity: { value: 70, unit: "/min" } },
    ],
  };
  const trace = pinSliceMembers(BP_SD, draft);
  assert.deepEqual(draft.component[0].valueQuantity, { value: 120, unit: "mmHg", system: UCUM, code: "mm[Hg]" });
  assert.deepEqual(draft.component[1].valueQuantity, { value: 80, unit: "mmHg", system: UCUM, code: "mm[Hg]" });
  assert.deepEqual(draft.component[2].valueQuantity, { value: 70, unit: "/min" }, "a component that matches no slice is untouched");
  const set = trace.filter((t) => t.action === "set").map((t) => t.path).sort();
  assert.deepEqual(set, [
    "Observation.component:DiastolicBP.value[x].code",
    "Observation.component:DiastolicBP.value[x].system",
    "Observation.component:SystolicBP.value[x].code",
    "Observation.component:SystolicBP.value[x].system",
  ]);
  // already-present fixed values are reported, not overwritten
  assert.ok(trace.some((t) => t.path === "Observation.component:SystolicBP.code.coding:Code.code" && t.action === "exists"));
  // a component without a value node gets nothing (no node is created)
  const bare: Record<string, any> = { resourceType: "Observation", component: [{ code: { coding: [{ system: "http://loinc.org", code: "8480-6" }] } }] };
  pinSliceMembers(BP_SD, bare);
  assert.ok(!("valueQuantity" in bare.component[0]));
});

test("pinSliceMembers: type slice on a choice (value[x]:valueQuantity) and $this pattern slices", () => {
  const draft: Record<string, any> = {
    resourceType: "Observation",
    status: "final",
    category: [{ coding: [{ system: OBS_CAT, code: "vital-signs" }] }, { coding: [{ system: OBS_CAT, code: "laboratory" }] }],
    valueQuantity: { value: 37.2, unit: "Cel", code: "Cel" },
  };
  const trace = pinSliceMembers(SDS[VITAL], draft);
  assert.equal(draft.valueQuantity.system, UCUM);
  assert.ok(trace.some((t) => t.path === "Observation.value[x]:valueQuantity.system" && t.action === "set"));
  assert.ok(trace.some((t) => t.path === "Observation.category:VSCat" && t.action === "exists"));
  assert.deepEqual(draft.category[1], { coding: [{ system: OBS_CAT, code: "laboratory" }] });
  const E = projectedById(SDS[VITAL]);
  assert.equal(decidedSliceMatch(draft.category[0], "category", "Observation.category:VSCat", E), true);
  assert.equal(decidedSliceMatch(draft.category[1], "category", "Observation.category:VSCat", E), false);
  // undecidable (membership only through a binding): never matched, never pinned
  assert.equal(decidedSliceMatch({ code: "I10" }, "coding", "Condition.code.coding:icd", projectedById(SDS[COND_PROFILE])), false);
});

test("pinSlices: `_slice` tags at any depth are resolved (template merged) or reported, and always removed", () => {
  const draft: Record<string, any> = {
    resourceType: "Observation",
    status: "final",
    category: [{ _slice: "VSCat" }],
    code: { coding: [{ _slice: "nope", code: "x" }] },
    valueQuantity: { value: 1, _slice: "valueQuantity" },
  };
  const trace = pinSlices(SDS[VITAL], draft);
  assert.deepEqual(draft.category, [{ coding: [{ system: OBS_CAT, code: "vital-signs" }] }]);
  assert.deepEqual(draft.code, { coding: [{ code: "x" }] });
  assert.deepEqual(draft.valueQuantity, { value: 1, system: UCUM });
  assert.deepEqual(
    trace.map((t) => [t.path, t.slice, t.action]),
    [
      ["Observation.category", "VSCat", "pinned"],
      ["Observation.code.coding", "nope", "unknown-slice"],
      ["Observation.value[x]", "valueQuantity", "pinned"],
    ],
  );
  assert.equal(JSON.stringify(draft).includes("_slice"), false);
});

test("pinFixedPattern still pins unsliced elements and skips slice members", () => {
  const draft: Record<string, any> = { resourceType: "Observation", status: "final", component: [{ code: {} }] };
  const trace = pinFixedPattern(BP_SD, draft);
  assert.equal(trace.length, 0, "BP_SD pins only inside slices");
  const PAT = SDS["http://example.tw/fhir/StructureDefinition/pat"];
  const p: Record<string, any> = { resourceType: "Patient" };
  assert.equal(pinFixedPattern(PAT, p).length, 0);
});
