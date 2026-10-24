/**
 * v13: a ValueSet canonical used as Coding.system (Terminology_TX_System_ValueSet2) and
 * LOINC property filters in ValueSet membership. Rules confirmed with validator_cli 7.0.1 +
 * tx.fhir.org (-ig tw.gov.mohw.twcore#1.0.0), one resource per JVM — see
 * scripts/validator-audit/REPORT.md §v13.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { InstanceValidator, type Issue } from "./fhirValidator.js";
import { FakeResolver, SDS, el, fakeDeps, sd } from "./fhirTestKit.test.js";
import { composeContains, type ComposeFilter } from "./fhirCodeSystem.js";

const EX = "http://example.tw/fhir/";
const LAB_VS = `${EX}ValueSet/lab-codes`;
const CLASS_VS = `${EX}ValueSet/encounter-class`;
const PART_VS = `${EX}ValueSet/lab-part`; // included by LAB_VS
const OTHER_VS = `${EX}ValueSet/route`; // bound nowhere
const PROFILE = `${EX}StructureDefinition/lab-obs`;
const ENC = `${EX}StructureDefinition/enc`;

class Resolver extends FakeResolver {
  async fetchValueSet(url: string): Promise<Record<string, any> | null> {
    const u = url.split("|")[0];
    if (u === LAB_VS) return { resourceType: "ValueSet", url: LAB_VS, title: "Lab codes", compose: { include: [{ system: "http://loinc.org", filter: [{ property: "CLASSTYPE", op: "=", value: "1" }] }, { valueSet: [PART_VS] }] } };
    if (u === PART_VS) return { resourceType: "ValueSet", url: PART_VS, compose: { include: [{ system: `${EX}CodeSystem/pay`, concept: [{ code: "06001C" }] }] } };
    if (u === OTHER_VS) return { resourceType: "ValueSet", url: OTHER_VS, compose: { include: [{ system: `${EX}CodeSystem/route` }] } };
    if (u === CLASS_VS) return { resourceType: "ValueSet", url: CLASS_VS, title: "Encounter class", compose: { include: [{ system: `${EX}CodeSystem/class` }] } };
    return super.fetchValueSet(url);
  }
}

SDS[PROFILE] = sd(PROFILE, "Observation", "resource", [
  el("Observation", 0, "*"),
  el("Observation.status", 1, "1", ["code"]),
  el("Observation.code", 1, "1", ["CodeableConcept"], { binding: { strength: "extensible", valueSet: LAB_VS } }),
  el("Observation.method", 0, "1", ["CodeableConcept"]),
], { baseDefinition: "http://hl7.org/fhir/StructureDefinition/Observation" });
SDS[ENC] = sd(ENC, "Encounter", "resource", [
  el("Encounter", 0, "*"),
  el("Encounter.status", 1, "1", ["code"]),
  el("Encounter.class", 1, "1", ["Coding"], { binding: { strength: "extensible", valueSet: CLASS_VS } }),
], { baseDefinition: "http://hl7.org/fhir/StructureDefinition/Encounter" });

async function run(resource: Record<string, any>, profiles: string[]): Promise<Issue[]> {
  return new InstanceValidator(new Resolver()).validate(resource, { profiles });
}
const VS2 = (url: string): RegExp => new RegExp(`^The Coding references a value set, not a code system \\('${url.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}'\\)$`);

test("v13: an IG-local ValueSet canonical as the system of a CodeableConcept coding is an error (HL7 wording)", async () => {
  for (const code of ["2160-0", "WBC"]) {
    const issues = await run({ resourceType: "Observation", status: "final", code: { coding: [{ system: LAB_VS, code }] } }, [PROFILE]);
    const hit = issues.filter((i) => VS2(LAB_VS).test(i.message));
    assert.equal(hit.length, 1, JSON.stringify(issues));
    assert.equal(hit[0].severity, "error");
    assert.equal(hit[0].path, "Observation.code.coding[0].system");
    // the unknown-CodeSystem warning is replaced, not added
    assert.ok(!issues.some((i) => /A definition for CodeSystem/.test(i.message)));
  }
});

test("v13: the same in an element bound elsewhere (Observation.method) and in a second coding", async () => {
  const method = await run({ resourceType: "Observation", status: "final", code: { text: "x" }, method: { coding: [{ system: LAB_VS, code: "2160-0" }] } }, [PROFILE]);
  assert.ok(method.some((i) => i.severity === "error" && i.path === "Observation.method.coding[0].system" && VS2(LAB_VS).test(i.message)));
  const two = await run({ resourceType: "Observation", status: "final", code: { coding: [{ system: "http://loinc.org", code: "2160-0" }, { system: LAB_VS, code: "2160-0" }] } }, [PROFILE]);
  assert.ok(two.some((i) => i.severity === "error" && i.path === "Observation.code.coding[1].system"));
});

test("v13: a ValueSet included by a bound ValueSet counts; one the instance never binds stays the warning (validator_cli)", async () => {
  const inc = await run({ resourceType: "Observation", status: "final", code: { coding: [{ system: PART_VS, code: "06001C" }] } }, [PROFILE]);
  assert.ok(inc.some((i) => i.severity === "error" && VS2(PART_VS).test(i.message)), JSON.stringify(inc));
  const other = await run({ resourceType: "Observation", status: "final", code: { coding: [{ system: OTHER_VS, code: "PO" }] } }, [PROFILE]);
  assert.ok(!other.some((i) => /references a value set/.test(i.message)), JSON.stringify(other));
  assert.ok(other.some((i) => i.severity === "warning" && i.path === "Observation.code.coding[0].system" && /A definition for CodeSystem/.test(i.message)));
  // the binding may sit on another resource of the Bundle
  const bundle = {
    resourceType: "Bundle",
    type: "collection",
    entry: [
      { fullUrl: "urn:uuid:00000000-0000-4000-8000-000000000001", resource: { resourceType: "Observation", meta: { profile: [PROFILE] }, status: "final", code: { coding: [{ system: "http://loinc.org", code: "2160-0" }] } } },
      { fullUrl: "urn:uuid:00000000-0000-4000-8000-000000000002", resource: { resourceType: "Observation", status: "final", code: { coding: [{ system: LAB_VS, code: "x" }] } } },
    ],
  };
  const b = await new InstanceValidator(new Resolver()).validate(bundle);
  assert.ok(b.some((i) => i.severity === "error" && /entry\[1\].*code\.coding\[0\]\.system$/.test(i.path) && VS2(LAB_VS).test(i.message)), JSON.stringify(b.filter((i) => i.severity !== "information")));
});

test("v13: a directly bound Coding (Encounter.class) with a ValueSet URL as system keeps the binding verdict only", async () => {
  const issues = await run({ resourceType: "Encounter", status: "finished", class: { system: CLASS_VS, code: "AMB" } }, [ENC]);
  assert.ok(!issues.some((i) => VS2(CLASS_VS).test(i.message)), JSON.stringify(issues));
});

test("v13: a URL that is no ValueSet stays the unknown-CodeSystem warning", async () => {
  const issues = await run({ resourceType: "Observation", status: "final", code: { coding: [{ system: `${EX}CodeSystem/nothing`, code: "x" }] } }, [PROFILE]);
  assert.ok(issues.some((i) => i.severity === "warning" && /A definition for CodeSystem/.test(i.message)));
  assert.ok(!issues.some((i) => /references a value set/.test(i.message)));
});

test("v13: compose filters on an external system are decided through deps.externalFilter", async () => {
  const seen: Array<[string, ComposeFilter, string]> = [];
  const deps = {
    ...fakeDeps(),
    externalFilter: async (system: string, f: ComposeFilter, code: string) => {
      seen.push([system, f, code]);
      if (code === "2160-0") return true;
      if (code === "8480-6") return false;
      return undefined;
    },
  };
  const compose = { include: [{ system: "http://loinc.org", filter: [{ property: "CLASSTYPE", op: "=", value: "Laboratory class" }] }, { system: `${EX}CodeSystem/pay`, concept: [{ code: "06001C" }] }] };
  assert.equal(await composeContains(compose, "http://loinc.org", "2160-0", deps), true);
  assert.equal(await composeContains(compose, "http://loinc.org", "8480-6", deps), false);
  assert.equal(await composeContains(compose, "http://loinc.org", "WBC", deps), undefined);
  assert.equal(await composeContains(compose, `${EX}CodeSystem/pay`, "06001C", deps), true);
  assert.equal(seen[0][1].property, "CLASSTYPE");
  // without the hook a property filter stays undecidable
  assert.equal(await composeContains(compose, "http://loinc.org", "2160-0", fakeDeps()), undefined);
});
