/**
 * parity v3 tx-validator-wiring, round 2: REVIEW_port_2 G3 (determineVersion, standalone ValueSetValidator.java:1878,
 * tag 7.0.1), REVIEW_port_1 F9 (FHIRPathEngine.opMemberOf: isOk includes the display) and F20 maxValueSet
 * (InstanceValidator.checkMaxValueSet IV:2267-2365).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { codingVersionIssues, presentVersionList, versionIsMoreDetailed } from "./fhirCsVersion.js";
import { InstanceValidator, type CodeCheck, type Issue } from "./fhirValidator.js";
import { CORE, FakeResolver } from "./fhirTestKit.test.js";

type Json = Record<string, any>;
const errors = (issues: Issue[]): Issue[] => issues.filter((i) => i.severity === "error" || i.severity === "fatal");

test("G3 determineVersion: VS pin 5.0.0, Coding 9.9.9 → VALUESET_VALUE_MISMATCH + UNKNOWN_CODESYSTEM_VERSION (IG system)", () => {
  const inc = [{ system: "https://x/CodeSystem/freq", version: "5.0.0" }];
  const r = codingVersionIssues(inc, "https://x/CodeSystem/freq", "9.9.9", ["5.0.0"]);
  assert.deepEqual(
    r.issues.map((i) => [i.id, i.severity, i.at]),
    [
      ["VALUESET_VALUE_MISMATCH", "error", "version"],
      ["UNKNOWN_CODESYSTEM_VERSION", "error", "system"],
    ],
  );
  assert.equal(r.issues[0].message, "The code system 'https://x/CodeSystem/freq' version '5.0.0' in the ValueSet include is different to the one in the value ('9.9.9')");
  assert.equal(r.issues[1].message, "A definition for CodeSystem 'https://x/CodeSystem/freq' version '9.9.9' could not be found, so the code cannot be validated. Valid versions: 5.0.0");
  // same version, or a more detailed one → nothing
  assert.deepEqual(codingVersionIssues(inc, "https://x/CodeSystem/freq", "5.0.0", ["5.0.0"]).issues, []);
  // versionless include: VALUESET_VALUE_MISMATCH_DEFAULT (warning) against the held (latest) version
  const d = codingVersionIssues([{ system: "https://x/cs" }], "https://x/cs", "1.0.0", ["2.0.0"]);
  assert.deepEqual(d.issues.map((i) => [i.id, i.severity]), [["VALUESET_VALUE_MISMATCH_DEFAULT", "warning"], ["UNKNOWN_CODESYSTEM_VERSION", "error"]]);
  // the include pins a version not held: still a mismatch when the Coding names another one
  assert.deepEqual(codingVersionIssues([{ system: "https://x/cs", version: "1.0.0" }], "https://x/cs", "2.0.0", ["2.0.0"]).issues.map((i) => i.id), ["VALUESET_VALUE_MISMATCH"]);
  // reportUnknownVersion false (HL7 / THO systems: the server may hold it)
  const h = codingVersionIssues(inc, "https://x/CodeSystem/freq", "9.9.9", ["5.0.0"], { reportUnknownVersion: false });
  assert.deepEqual(h.issues.map((i) => i.id), ["VALUESET_VALUE_MISMATCH"]);
  assert.equal(h.unknownVersion, true);
  assert.equal(versionIsMoreDetailed("1.0", "1.0.2"), false); // semver candidate needs a semver criteria
  assert.equal(versionIsMoreDetailed("1.0.x", "1.0.2"), true);
  assert.equal(presentVersionList(["2.0.0", "1.0.0", "3.0.0"]), "1.0.0, 2.0.0 or 3.0.0");
});

const P = "http://x/StructureDefinition/pat-max";
const VS = "http://x/ValueSet/small";
const MAXVS = "http://x/ValueSet/max";
class MaxResolver extends FakeResolver {
  async fetchStructureDefinition(url: string): Promise<Json | null> {
    if (url.split("|")[0] !== P) return super.fetchStructureDefinition(url);
    const base = JSON.parse(JSON.stringify(await super.fetchStructureDefinition(CORE + "Patient")));
    base.url = P;
    base.derivation = "constraint";
    for (const e of base.snapshot.element) {
      if (e.path === "Patient.gender") {
        e.binding = { strength: "extensible", valueSet: VS, extension: [{ url: "http://hl7.org/fhir/StructureDefinition/elementdefinition-maxValueSet", valueCanonical: MAXVS }] };
      }
    }
    return base;
  }
  async fetchValueSet(url: string): Promise<Json | null> {
    const u = url.split("|")[0];
    if (u === VS) return { resourceType: "ValueSet", url: VS, title: "Small", compose: { include: [{ system: "http://hl7.org/fhir/administrative-gender", concept: [{ code: "male" }] }] } };
    if (u === MAXVS) return { resourceType: "ValueSet", url: MAXVS, title: "Max", compose: { include: [{ system: "http://hl7.org/fhir/administrative-gender", concept: [{ code: "male" }, { code: "female" }] }] } };
    return super.fetchValueSet(url);
  }
  async valueSetContains(url: string, system: string | null, code: string): Promise<boolean | undefined> {
    const u = url.split("|")[0];
    if (u !== VS && u !== MAXVS) return super.valueSetContains(url, system, code);
    const vs = (await this.fetchValueSet(url))!;
    return vs.compose.include.some((i: Json) => (system === null || i.system === system) && i.concept.some((c: Json) => c.code === code));
  }
}

test("F20 maxValueSet: an extensible binding's max value set must hold the code (Terminology_TX_NoValid_11 for a code)", async () => {
  const ok = await new InstanceValidator(new MaxResolver()).validate({ resourceType: "Patient", id: "p", meta: { profile: [P] }, gender: "female" });
  assert.ok(!errors(ok).some((i) => /maximum value set/.test(i.message)), JSON.stringify(errors(ok)));
  const bad = await new InstanceValidator(new MaxResolver()).validate({ resourceType: "Patient", id: "p", meta: { profile: [P] }, gender: "other" });
  assert.ok(errors(bad).some((i) => i.path === "Patient.gender" && /^The code provided is not in the maximum value set 'Max' \(http:\/\/x\/ValueSet\/max\)/.test(i.message)), JSON.stringify(bad));
  assert.ok(errors(bad).some((i) => i.message.endsWith("(code = null#other), error = The System URI could not be determined for the code 'other' in the ValueSet 'http://x/ValueSet/max'; The provided code '#other' was not found in the value set 'http://x/ValueSet/max')")), JSON.stringify(bad));
});

test("F9 memberOf discriminator: a member coding with a wrong display does not match (opMemberOf isOk)", async () => {
  const PR = "http://x/StructureDefinition/cond-slice";
  const VSC = "http://x/ValueSet/cc";
  class R extends FakeResolver {
    async fetchStructureDefinition(url: string): Promise<Json | null> {
      if (url.split("|")[0] !== PR) return super.fetchStructureDefinition(url);
      const base = JSON.parse(JSON.stringify(await super.fetchStructureDefinition(CORE + "Patient")));
      base.url = PR;
      base.derivation = "constraint";
      return base;
    }
    async checkCode(system: string, code: string, display: string | null): Promise<CodeCheck> {
      if (system === "http://x/cs" && display !== null && display !== "Good") return { status: "invalid-display", severity: "error", message: `Wrong Display Name '${display}'` };
      return system === "http://x/cs" ? { status: "ok" } : super.checkCode(system, code, display);
    }
    async valueSetContains(url: string, system: string | null, code: string): Promise<boolean | undefined> {
      if (url === VSC) return system === "http://x/cs" && code === "a";
      return super.valueSetContains(url, system, code);
    }
    async fetchValueSet(url: string): Promise<Json | null> {
      if (url === VSC) return { resourceType: "ValueSet", url: VSC, compose: { include: [{ system: "http://x/cs" }] } };
      return super.fetchValueSet(url);
    }
  }
  // exercised through the private clause evaluator: a value whose member coding has a wrong display is not a match
  const v = new InstanceValidator(new R()) as any;
  assert.equal(await v.bindingClause(VSC, [{ system: "http://x/cs", code: "a", display: "Good" }]), true);
  assert.equal(await v.bindingClause(VSC, [{ system: "http://x/cs", code: "a", display: "Bad" }]), false);
  assert.equal(await v.bindingClause(VSC, [{ coding: [{ system: "http://x/cs", code: "a", display: "Bad" }] }]), false);
  // operator form: any value that is ok matches (not size == 1)
  assert.equal(await v.bindingClause(VSC, [{ system: "http://x/cs", code: "b" }, { system: "http://x/cs", code: "a" }]), true);
});

test("a CodeableConcept with a coding in the value set still fails when another coding has an error (ValueSetValidator info.hasErrors, tag 7.0.1:458)", async () => {
  const P2 = "http://x/StructureDefinition/cond-cc";
  class R extends FakeResolver {
    async fetchStructureDefinition(url: string): Promise<Json | null> {
      return super.fetchStructureDefinition(url.split("|")[0] === P2 ? "http://example.tw/fhir/StructureDefinition/cond" : url);
    }
  }
  const CL = "http://terminology.hl7.org/CodeSystem/condition-clinical";
  const base = { resourceType: "Condition", id: "c1", meta: { profile: [P2] }, category: [{ text: "x" }], subject: { reference: "Patient/p1" } };
  const ok = await new InstanceValidator(new R()).validate({ ...base, clinicalStatus: { coding: [{ system: CL, code: "active" }, { system: "http://unknown/cs", code: "x" }] } });
  assert.ok(!errors(ok).some((i) => /None of the codings/.test(i.message)), JSON.stringify(errors(ok)));
  const bad = await new InstanceValidator(new R()).validate({ ...base, clinicalStatus: { coding: [{ system: CL, code: "active" }, { system: CL, code: "nope" }] } });
  assert.ok(errors(bad).some((i) => i.path === "Condition.clinicalStatus" && /None of the codings provided/.test(i.message)), JSON.stringify(errors(bad)));
});

test("a system-less coding is a member only of a single include enumerating it (ValueSetValidator.inComponent `only && system == null`)", async () => {
  const VSE = "http://x/ValueSet/enum";
  class R extends FakeResolver {
    async fetchValueSet(url: string): Promise<Json | null> {
      return url === VSE ? { resourceType: "ValueSet", url: VSE, compose: { include: [{ system: "http://loinc.org", concept: [{ code: "1-8" }] }] } } : super.fetchValueSet(url);
    }
  }
  const v = new InstanceValidator(new R()) as any;
  assert.equal(await v.bindingClause(VSE, [{ code: "1-8" }]), true);
  assert.equal(await v.bindingClause(VSE, [{ code: "2-6" }]), false);
});

test("a value set pinning the system version names that version in Unknown code (coding of a CodeableConcept: instead; Coding element: besides)", async () => {
  const VSP = "http://x/ValueSet/pinned";
  class R extends FakeResolver {
    async fetchValueSet(url: string): Promise<Json | null> {
      return url === VSP ? { resourceType: "ValueSet", url: VSP, compose: { include: [{ system: "http://x/cs", version: "3.0.0" }] } } : super.fetchValueSet(url);
    }
    async checkCode(system: string, code: string, display: string | null): Promise<CodeCheck> {
      return system === "http://x/cs" ? { status: "invalid-code", severity: "error", message: `Unknown code '${code}' in the CodeSystem '${system}' version '4.0.0'` } : super.checkCode(system, code, display);
    }
  }
  const v = new InstanceValidator(new R()) as any;
  const vs = await new R().fetchValueSet(VSP);
  const held: Issue[] = [{ severity: "error", path: "X.coding[0].code", code: "code-invalid", message: "Unknown code 'a' in the CodeSystem 'http://x/cs' version '4.0.0'" }];
  await v.pinnedUnknownCode(vs, [{ system: "http://x/cs", code: "a" }], "CodeableConcept", { path: "X" }, held);
  assert.deepEqual(held.map((i) => i.message), ["Unknown code 'a' in the CodeSystem 'http://x/cs' version '3.0.0'"]);
  const el: Issue[] = [];
  await v.pinnedUnknownCode(vs, [{ system: "http://x/cs", code: "a" }], "Coding", { path: "Y" }, el);
  assert.deepEqual(el.map((i) => `${i.path} ${i.message}`), ["Y.code Unknown code 'a' in the CodeSystem 'http://x/cs' version '3.0.0'"]);
});
