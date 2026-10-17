import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyFilter,
  composeContains,
  descendantsOf,
  expandComposeWith,
  indexCodeSystem,
  loincCheckDigitValid,
  snomedCheckDigitValid,
  valueSetContains,
  type TerminologyDeps,
} from "./fhirCodeSystem.js";
import { CONDITION_CLINICAL_CS, fakeDeps } from "./fhirTestKit.test.js";

const CC = "http://terminology.hl7.org/CodeSystem/condition-clinical";

test("indexCodeSystem flattens nested concept.concept with parent/child links", () => {
  const idx = indexCodeSystem(CONDITION_CLINICAL_CS);
  assert.equal(idx.concepts.size, 7);
  assert.deepEqual([...idx.concepts.get("resolved")!.parents], ["inactive"]);
  assert.deepEqual([...descendantsOf(idx, "inactive")].sort(), ["remission", "resolved"]);
});

test("whole-system include expands nested codes (condition-clinical → 7 codes)", async () => {
  const exp = await expandComposeWith({ include: [{ system: CC }] }, fakeDeps(), 500);
  assert.equal(exp.total, 7);
  assert.ok(exp.codings.some((c) => c.code === "resolved"));
  assert.deepEqual(exp.unresolved, []);
});

test("filters: is-a, descendent-of, is-not-a, generalizes, child-of", () => {
  const idx = indexCodeSystem(CONDITION_CLINICAL_CS);
  const codes = (op: string, value: string): string[] => [...(applyFilter(idx, { property: "concept", op, value }) || [])].sort();
  assert.deepEqual(codes("is-a", "inactive"), ["inactive", "remission", "resolved"]);
  assert.deepEqual(codes("descendent-of", "inactive"), ["remission", "resolved"]);
  assert.deepEqual(codes("is-not-a", "inactive"), ["active", "recurrence", "relapse", "unknown"]);
  assert.deepEqual(codes("generalizes", "resolved"), ["inactive", "resolved"]);
  assert.deepEqual(codes("child-of", "active"), ["recurrence", "relapse"]);
  assert.equal(applyFilter(idx, { property: "concept", op: "bogus-op", value: "x" }), null);
});

test("filters on properties: =, in, regex, exists", () => {
  const idx = indexCodeSystem({
    url: "http://x/cs",
    content: "complete",
    concept: [
      { code: "A00", property: [{ code: "USE", valueString: "0" }] },
      { code: "A00.0", property: [{ code: "USE", valueString: "1" }] },
      { code: "B01", property: [{ code: "USE", valueString: "1" }, { code: "status", valueCode: "retired" }] },
    ],
  });
  assert.deepEqual([...applyFilter(idx, { property: "USE", op: "=", value: "1" })!].sort(), ["A00.0", "B01"]);
  assert.deepEqual([...applyFilter(idx, { property: "code", op: "in", value: "A00, B01" })!].sort(), ["A00", "B01"]);
  assert.deepEqual([...applyFilter(idx, { property: "code", op: "regex", value: "A.*" })!].sort(), ["A00", "A00.0"]);
  assert.deepEqual([...applyFilter(idx, { property: "status", op: "exists", value: "true" })!], ["B01"]);
});

test("hierarchy from a parent property declared by URI (THO v3 `subsumedBy`)", () => {
  const idx = indexCodeSystem({
    url: "http://terminology.hl7.org/CodeSystem/v3-ActCode",
    content: "complete",
    property: [{ code: "subsumedBy", uri: "http://hl7.org/fhir/concept-properties#parent", type: "code" }],
    concept: [
      { code: "_ActEncounterCode" },
      { code: "AMB", property: [{ code: "subsumedBy", valueCode: "_ActEncounterCode" }] },
      { code: "IMP", property: [{ code: "subsumedBy", valueCode: "_ActEncounterCode" }] },
    ],
  });
  assert.deepEqual([...applyFilter(idx, { property: "concept", op: "is-a", value: "_ActEncounterCode" })!].sort(), ["AMB", "IMP", "_ActEncounterCode"]);
});

test("membership: nested code, unknown code, valueSet import intersection and exclude", async () => {
  const deps = fakeDeps();
  assert.equal(await valueSetContains("http://hl7.org/fhir/ValueSet/condition-clinical", CC, "resolved", deps), true);
  assert.equal(await valueSetContains("http://hl7.org/fhir/ValueSet/condition-clinical", CC, "foo", deps), false);
  assert.equal(await valueSetContains("http://hl7.org/fhir/ValueSet/condition-clinical", null, "relapse", deps), true);
  const compose = {
    include: [{ system: CC, filter: [{ property: "concept", op: "is-a", value: "inactive" }] }],
    exclude: [{ system: CC, concept: [{ code: "remission" }] }],
  };
  assert.equal(await composeContains(compose, CC, "resolved", deps), true);
  assert.equal(await composeContains(compose, CC, "remission", deps), false);
  assert.equal(await composeContains(compose, CC, "active", deps), false);
  const both = { include: [{ system: CC, valueSet: ["http://hl7.org/fhir/ValueSet/condition-clinical"], concept: [{ code: "active" }] }] };
  assert.equal(await composeContains(both, CC, "active", deps), true);
});

test("membership is undefined (not false) when the system is not held", async () => {
  const deps: TerminologyDeps = { ...fakeDeps() };
  assert.equal(await composeContains({ include: [{ system: "http://snomed.info/sct" }] }, "http://snomed.info/sct", "22298006", deps), undefined);
  assert.equal(
    await composeContains({ include: [{ system: "http://snomed.info/sct", filter: [{ property: "concept", op: "is-a", value: "1" }] }] }, "http://snomed.info/sct", "2", deps),
    undefined,
  );
});

test("SNOMED is-a filter goes through the subsumption dependency", async () => {
  const deps: TerminologyDeps = {
    ...fakeDeps(),
    snomedSubsumedBy: async (code, anc) => code === "112144000" && anc === "365636006",
  };
  const compose = { include: [{ system: "http://snomed.info/sct", filter: [{ property: "concept", op: "descendent-of", value: "365636006" }] }] };
  assert.equal(await composeContains(compose, "http://snomed.info/sct", "112144000", deps), true);
  assert.equal(await composeContains(compose, "http://snomed.info/sct", "22298006", deps), false);
});

test("check digits: LOINC mod-10 and SNOMED Verhoeff", () => {
  assert.equal(loincCheckDigitValid("8310-5"), true);
  assert.equal(loincCheckDigitValid("8310-4"), false);
  assert.equal(loincCheckDigitValid("99999-99"), false);
  assert.equal(loincCheckDigitValid("LA6752-5"), true);
  assert.equal(snomedCheckDigitValid("22298006"), true);
  assert.equal(snomedCheckDigitValid("112144000"), true);
  assert.equal(snomedCheckDigitValid("123456789999"), false);
});
