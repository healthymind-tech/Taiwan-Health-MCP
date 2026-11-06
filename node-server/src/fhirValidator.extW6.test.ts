/**
 * External IG wave 6 unsafe releases (validator_cli 7.0.1 invalid, TS 0 errors + fully checked): the generic rules behind them.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { InstanceValidator, type Issue } from "./fhirValidator.js";
import { composeContains, indexCodeSystem, type TerminologyDeps } from "./fhirCodeSystem.js";
import { CORE, FakeResolver, SDS, el, sd } from "./fhirTestKit.test.js";

const DAR = "http://hl7.org/fhir/StructureDefinition/data-absent-reason";
const base = (t: string): Array<Record<string, any>> => [el(t, 0, "*"), el(`${t}.id`, 0, "1", ["id"]), el(`${t}.extension`, 0, "*", ["Extension"])];

const TEST_SDS: Record<string, Record<string, any>> = {
  [CORE + "Task"]: sd(CORE + "Task", "Task", "resource", [...base("Task"), el("Task.instantiatesCanonical", 0, "1", ["canonical"])]),
  [CORE + "RequestGroup"]: sd(CORE + "RequestGroup", "RequestGroup", "resource", [
    ...base("RequestGroup"),
    el("RequestGroup.action", 0, "*", ["BackboneElement"], {
      constraint: [{ key: "rqg-1", severity: "error", human: "Must have resource or action but not both", expression: "resource.exists() != action.exists()" }],
    }),
    el("RequestGroup.action.title", 0, "1", ["string"]),
    el("RequestGroup.action.resource", 0, "1", ["Reference"]),
    el("RequestGroup.action.action", 0, "*", [], { contentReference: "#RequestGroup.action" }),
  ]),
  "http://example.org/StructureDefinition/rg-profile": sd("http://example.org/StructureDefinition/rg-profile", "RequestGroup", "resource", [
    ...base("RequestGroup"),
    el("RequestGroup.action", 0, "*", ["BackboneElement"], {
      constraint: [{ key: "rqg-1", severity: "error", human: "Must have resource or action but not both", expression: "resource.exists() != action.exists()" }],
    }),
    el("RequestGroup.action.title", 0, "1", ["string"]),
    el("RequestGroup.action.resource", 0, "1", ["Reference"]),
    el("RequestGroup.action.action", 0, "*", [], { contentReference: CORE + "RequestGroup#RequestGroup.action" }),
  ], { baseDefinition: CORE + "RequestGroup", derivation: "constraint" }),
  [CORE + "Observation"]: sd(CORE + "Observation", "Observation", "resource", [
    ...base("Observation"),
    el("Observation.effective[x]", 0, "1", ["dateTime"], {
      constraint: [{ key: "x-1", severity: "error", human: "Datetime must be at least to day.", expression: "($this as dateTime).toString().length() >= 8" }],
    }),
  ]),
  [CORE + "Subscription"]: sd(CORE + "Subscription", "Subscription", "resource", [...base("Subscription"), el("Subscription.criteria", 0, "1", ["string"])]),
};

class W6Resolver extends FakeResolver {
  override async fetchStructureDefinition(url: string): Promise<Record<string, any> | null> {
    return TEST_SDS[url.split("|")[0]] ?? SDS[url.split("|")[0]] ?? null;
  }
  async definitionExists(url: string): Promise<boolean> {
    return url === "https://example.org/fhir/Questionnaire/q";
  }
  async definitionVersionExists(url: string, version: string): Promise<boolean> {
    return url === "https://example.org/fhir/Questionnaire/q" && version === "1.0.0";
  }
}

const errs = async (r: Record<string, any>): Promise<Array<[string, string]>> =>
  (await new InstanceValidator(new W6Resolver()).validate(r, { profiles: [] }))
    .filter((i: Issue) => i.severity === "error" || i.severity === "fatal")
    .map((i: Issue) => [i.path, i.message]);

// ValidationEngine.resolveURL l. 1420 → BaseWorkerContext.fetchResourceWithExceptionByVersion l. 2646-2650: `url|version`
// resolves only that version (CanonicalResourceManager.getByPackage l. 699-737)
test("an example-URL canonical with a version no installed definition has is URL_EXAMPLE", async () => {
  const task = (c: string): Record<string, any> => ({ resourceType: "Task", instantiatesCanonical: c });
  const ex = (e: Array<[string, string]>): boolean => e.some(([, m]) => m.startsWith("Example URLs are not allowed in this context"));
  assert.ok(ex(await errs(task("https://example.org/fhir/Questionnaire/q|2.1"))));
  assert.ok(!ex(await errs(task("https://example.org/fhir/Questionnaire/q|1.0.0"))));
  assert.ok(!ex(await errs(task("https://example.org/fhir/Questionnaire/q"))));
  assert.ok(ex(await errs(task("https://example.org/fhir/Questionnaire/other"))));
});

// checkChildByDefinition l. 7957-7964 / 8010: a contentReference element is checked with the referenced element's invariants
test("invariants of a contentReference element are the referenced element's", async () => {
  const e = await errs({ resourceType: "RequestGroup", action: [{ title: "a", action: [{ title: "b" }] }, { title: "c", resource: { reference: "Task/t" } }] });
  const rqg = e.filter(([, m]) => m.startsWith("Constraint failed: rqg-1"));
  assert.deepEqual(rqg.map(([p]) => p), ["RequestGroup.action[0].action[0]"], JSON.stringify(e));
  // resolveNameReference l. 6291-6296 matches `#id` only: an absolute `url#id` keeps the referencing element's invariants
  const issues = await new InstanceValidator(new W6Resolver()).validate(
    { resourceType: "RequestGroup", meta: { profile: ["http://example.org/StructureDefinition/rg-profile"] }, action: [{ title: "a", action: [{ title: "b" }] }] },
    { profiles: ["http://example.org/StructureDefinition/rg-profile"] },
  );
  assert.ok(!issues.some((i) => i.message.startsWith("Constraint failed: rqg-1")), JSON.stringify(issues));
});

// checkChildByDefinition l. 8010: the invariants of a primitive element without a value (only its `_x` shadow) still run
test("a value-less primitive with an extension is checked against its invariants", async () => {
  const shadow = await errs({ resourceType: "Observation", _effectiveDateTime: { extension: [{ url: DAR, valueCode: "unknown" }] } });
  assert.ok(shadow.some(([, m]) => m.startsWith("Constraint failed: x-1: 'Datetime must be at least to day.'")), JSON.stringify(shadow));
  assert.ok(!(await errs({ resourceType: "Observation", effectiveDateTime: "2020-01-02" })).some(([, m]) => m.startsWith("Constraint failed: x-1")));
});

// JsonParser.parseChildComplex l. 417-431: `extension: []` in a primitive's shadow is ARRAY_CANNOT_BE_EMPTY
test("an empty extension array in a primitive shadow is an error", async () => {
  const e = await errs({ resourceType: "Subscription", criteria: "x", _criteria: { extension: [] } });
  assert.ok(e.some(([p, m]) => p === "Subscription.criteria.extension" && m === "Array cannot be empty - the property should not be present if it has no values"), JSON.stringify(e));
});

// ValueSetValidator l. 2113-2142 (standalone 7.0.1): an include pinned to a version no held copy has goes to the server
test("an enumerated include pinned to a version not held: membership undecided for a server-known system", async () => {
  const SYS = "http://terminology.hl7.org/CodeSystem/v2-0532";
  const deps: TerminologyDeps = {
    loadValueSet: async () => null,
    loadCodeSystem: async (url) => (url === SYS ? indexCodeSystem({ resourceType: "CodeSystem", url: SYS, version: "2.0.0", content: "complete", concept: [{ code: "Y" }, { code: "N" }] }) : null),
    lookupExternal: async () => null,
    externalSystemHeld: async () => false,
  };
  const inc = (system: string, version?: string): Record<string, any> => ({ include: [{ system, ...(version ? { version } : {}), concept: [{ code: "Y" }] }] });
  assert.equal(await composeContains(inc(SYS, "HL7 v2.5"), SYS, "Y", deps), undefined);
  assert.equal(await composeContains(inc(SYS, "HL7 v2.5"), SYS, "Q", deps), false);
  assert.equal(await composeContains(inc(SYS), SYS, "Y", deps), true);
  assert.equal(await composeContains(inc("http://other.org/cs", "9"), "http://other.org/cs", "Y", deps), true);
  // no copy held at all (THO's not-present stub only): the server judges the pinned version, its versions unknown here
  // (BFDR: PHIN VADS 7933 pins icd-10 '2020', the jar answers UNKNOWN_CODESYSTEM_VERSION, valid 2019-covid-expanded)
  const ICD10 = "http://hl7.org/fhir/sid/icd-10";
  assert.equal(await composeContains(inc(ICD10, "2020"), ICD10, "Y", deps), undefined);
  assert.equal(await composeContains(inc(ICD10), ICD10, "Y", deps), true);
  // a terminology this host answers in the server's stead keeps its answer
  assert.equal(await composeContains(inc("http://unitsofmeasure.org", "2.1"), "http://unitsofmeasure.org", "Y", deps), true);
});
