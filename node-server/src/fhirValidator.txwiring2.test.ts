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

test("an incompleteness note is an information issue with `unchecked`, so checked_fully reflects it", async () => {
  class R extends FakeResolver {
    async checkCode(system: string, code: string): Promise<CodeCheck> {
      if (code === "lag") return { status: "invalid-code", severity: "information", undecided: true, message: `Code '${code}' was not found in the locally held release of '${system}'` };
      if (code === "dsp") return { status: "display-unchecked", message: `Display not checked: no local terminology for ${system}` };
      return super.checkCode(system, code, null);
    }
  }
  const v = new InstanceValidator(new R()) as any;
  for (const code of ["lag", "dsp"]) {
    const issues: Issue[] = await v.validate({ resourceType: "Observation", id: "o", status: "final", code: { coding: [{ system: "http://x/lag", code, display: "d" }] } });
    const note = issues.find((i) => /locally held|not checked/.test(i.message));
    assert.ok(note, JSON.stringify(issues));
    assert.equal(note!.severity, "information");
    assert.deepEqual((note as any).unchecked, { kind: "code", canonical: "http://x/lag" });
  }
});

test("memberOf() in an invariant is answered by the terminology: the value set decides pass and fail", async () => {
  const VSC = "http://x/ValueSet/country";
  class R extends FakeResolver {
    async fetchValueSet(url: string): Promise<Json | null> {
      return url.startsWith("http://x/ValueSet/") ? { resourceType: "ValueSet", url, compose: { include: [{ system: "urn:iso:std:iso:3166", concept: [{ code: "NL" }] }] } } : super.fetchValueSet(url);
    }
    async valueSetContains(url: string, system: string | null, code: string): Promise<boolean | undefined> {
      return url.split("|")[0] === VSC ? code === "NL" : undefined;
    }
  }
  const el = { path: "Patient.address", constraint: [{ key: "x-1", severity: "error", human: "country", expression: `country.empty() or country.memberOf('${VSC}')` }] };
  const run = async (country: string, url = VSC): Promise<Issue[]> => {
    const issues: Issue[] = [];
    const v = new InstanceValidator(new R()) as any;
    const e = url === VSC ? el : { ...el, constraint: [{ ...el.constraint[0], expression: `country.memberOf('${url}')` }] };
    await v.checkConstraints({ url: "http://x/sd", type: "Patient", children: () => undefined }, e, { value: { country }, path: "Patient.address[0]" }, "", { resource: { resourceType: "Patient" } }, issues);
    return issues;
  };
  assert.deepEqual(await run("NL"), []);
  const bad = await run("BE");
  assert.equal(bad.length, 1);
  assert.equal(bad[0].severity, "error");
  const unknown = await run("NL", "http://x/ValueSet/other");
  assert.equal(unknown[0].severity, "information");
  assert.deepEqual((unknown[0] as any).unchecked, { kind: "invariant", canonical: "http://x/sd#x-1" });
});

test("G21 (jar): a CodeableConcept of a system nobody holds, the required value set listing that system: UNKNOWN_CODESYSTEM only, nothing unchecked", async () => {
  const VSN = "http://x/ValueSet/nowhere";
  const CSN = "http://x/nowhere/cs";
  class R extends FakeResolver {
    async fetchValueSet(url: string): Promise<Json | null> {
      return url.split("|")[0] === VSN ? { resourceType: "ValueSet", url: VSN, compose: { include: [{ system: CSN, concept: [{ code: "A" }] }] } } : super.fetchValueSet(url);
    }
    async valueSetContains(url: string, system: string | null, code: string): Promise<boolean | undefined> {
      return url.split("|")[0] === VSN ? (code === "A" ? true : undefined) : super.valueSetContains(url, system, code);
    }
    async checkCode(system: string, code: string, display: string | null): Promise<CodeCheck> {
      return system === CSN ? { status: "unknown-system" } : super.checkCode(system, code, display);
    }
  }
  const v = new InstanceValidator(new R()) as any;
  const issues: Issue[] = [];
  const el = { path: "Observation.code", base: { path: "Observation.code" }, binding: { strength: "required", valueSet: VSN } };
  await v.checkBinding(el, { coding: [{ system: CSN, code: "Z" }] }, "CodeableConcept", { path: "Observation.code", value: {} }, issues);
  assert.deepEqual(issues.filter((i) => i.severity === "error" || (i as any).unchecked), []);
});

test("a ValueSet nobody holds: outside the HL7 space a definite not found, inside it undecided (jar: tx.fhir.org holds some IG value sets)", async () => {
  class R extends FakeResolver {
    async definitionExists(): Promise<boolean> {
      return false;
    }
    async valueSetContains(): Promise<boolean | undefined> {
      return undefined;
    }
  }
  const run = async (url: string): Promise<Issue[]> => {
    const issues: Issue[] = [];
    const el = { path: "Observation.code", base: { path: "Observation.code" }, binding: { strength: "required", valueSet: url } };
    await (new InstanceValidator(new R()) as any).checkBinding(el, { coding: [{ system: "http://x/cs", code: "a" }] }, "CodeableConcept", { path: "Observation.code", value: {} }, issues, null);
    return issues;
  };
  const far = await run("http://www.rsna.org/RadLex_Playbook.aspx");
  assert.deepEqual(far.map((i) => [i.severity, i.message, (i as any).unchecked]), [["warning", "ValueSet 'http://www.rsna.org/RadLex_Playbook.aspx' not found", undefined]]);
  const near = await run("http://hl7.org/fhir/uv/ips/ValueSet/vaccines-uv-ips");
  assert.deepEqual((near[0] as any).unchecked, { kind: "valueSet", canonical: "http://hl7.org/fhir/uv/ips/ValueSet/vaccines-uv-ips" });
});

test("a coding without a code: the value set still answers (cc.hasCoding), and a held CodeSystem says NO_CODE_PROVIDED_VERSION", async () => {
  const VSH = "http://x/ValueSet/held";
  const CSH = "http://x/held/cs";
  class R extends FakeResolver {
    async fetchValueSet(url: string): Promise<Json | null> {
      return url.split("|")[0] === VSH ? { resourceType: "ValueSet", url: VSH, title: "Held", compose: { include: [{ system: CSH }] } } : super.fetchValueSet(url);
    }
    async fetchCodeSystem(url: string): Promise<Json | null> {
      return url === CSH ? { resourceType: "CodeSystem", url: CSH, version: "1.0.1", content: "complete", concept: [] } : null;
    }
    async codeSystemResolvable(): Promise<boolean> {
      return true;
    }
  }
  const v = new InstanceValidator(new R()) as any;
  const bound: Issue[] = [];
  await v.checkBinding({ path: "X.y", base: { path: "X.y" }, binding: { strength: "required", valueSet: VSH } }, { coding: [{ system: CSH, code: ["a"] }] }, "CodeableConcept", { path: "X.y", value: {} }, bound, null);
  assert.deepEqual(bound.map((i) => i.message), [`None of the codings provided are in the value set 'Held' (${VSH}), and a coding from this value set is required) (codes = ${CSH}#null)`]);
  const el = { path: "CodeableConcept.coding", base: { path: "CodeableConcept.coding" } };
  const held: Issue[] = [];
  await v.checkCoding({ system: CSH }, { path: "X.y.coding[0]" }, held, el);
  assert.deepEqual(held.map((i) => `${i.severity} ${i.path} ${i.message}`), [`warning X.y.coding[0] No code provided for CodeSystem '${CSH}' version '1.0.1'`]);
  const server: Issue[] = [];
  await v.checkCoding({ system: "urn:ietf:bcp:47", code: "" }, { path: "X.y.coding[0]" }, server, el);
  assert.deepEqual(server.map((i) => `${i.severity} ${i.path}`), ["error X.y.coding[0]", "warning X.y"]);
  assert.equal(server[0].message, "Coding has no code for system urn:ietf:bcp:47 and cannot be validated");
  const lo: Issue[] = [];
  await v.checkCoding({ system: "http://loinc.org" }, { path: "X.y.coding[0]" }, lo, el);
  assert.deepEqual(lo.map((i) => `${i.severity} ${i.path}`), ["warning X.y.coding[0]"]); // jar alone
});

test("Coding.system: a number is read as its text, a value that does not start with http:, https: or urn: is reported", async () => {
  const v = new InstanceValidator(new FakeResolver()) as any;
  const a: Issue[] = [];
  await v.checkCoding({ system: 1, code: "a" }, { path: "X" }, a);
  assert.deepEqual(a.map((i) => i.message), ["Coding.system must be an absolute reference, not a local reference"]);
  const b: Issue[] = [];
  await v.checkCoding({ system: "not a uri with spaces", code: "a" }, { path: "X" }, b, { path: "CodeableConcept.coding" });
  assert.deepEqual(b.map((i) => i.path), ["X.system"]); // jar alone, 11 items
});

test("a value of another type on a bound primitive, coding as an object, an empty system, a unit without a code", async () => {
  const v = new InstanceValidator(new FakeResolver()) as any;
  const a: Issue[] = [];
  await v.checkBinding({ path: "Extension.value[x]", binding: { strength: "required", valueSet: "http://x/vs" } }, { start: "2020" }, "code", { path: "X.valuePeriod", value: {}, profileType: true }, a, null);
  assert.equal(a[0].message, "No code provided, and a code is required from the value set");
  await v.complexAsPrimitive({ start: "2020" }, { path: "X.valuePeriod", value: {}, profileType: true, actualType: "Period" }, "code", a);
  assert.ok(a[1].path === "X.valuePeriod.start" && a[1].message.startsWith("This element is not allowed by the profile http://hl7.org/fhir/StructureDefinition/code"), JSON.stringify(a));
  const c: Issue[] = [];
  await v.checkCoding({ system: "", code: "a" }, { path: "X.sopClass" }, c);
  assert.deepEqual(c.filter((i) => i.severity === "error").map((i) => i.path), ["X.sopClass"]);
  const ws: Issue[] = [];
  await v.checkCoding({ system: " http://example.org", code: "a" }, { path: "X.sopClass" }, ws);
  assert.deepEqual(ws.map((i) => i.path), ["X.sopClass"]);
  const boundWs: Issue[] = [];
  (v as any).vsHeader = async (u: string) => (u === "http://x/vs" ? { url: u } : null);
  await v.checkCoding({ system: " http://example.org", code: "a" }, { path: "X.class" }, boundWs, { path: "X.class", binding: { strength: "extensible", valueSet: "http://x/vs" } });
  assert.ok(!boundWs.some((i) => /absolute reference/.test(i.message)), JSON.stringify(boundWs));
  const q: Issue[] = [];
  await v.checkQuantity({ value: 2, system: "http://unitsofmeasure.org", code: "" }, { path: "X.valueQuantity" }, q);
  assert.deepEqual(q.map((i) => `${i.severity} ${i.message}`), ["warning Coding has no code for system http://unitsofmeasure.org and cannot be validated", "error Coding has no code for system http://unitsofmeasure.org and cannot be validated (for 'http://unitsofmeasure.org#')"]);
  const e: Issue[] = [];
  await v.checkQuantity({ value: 2, system: "", code: "mg" }, { path: "X.valueQuantity" }, e);
  assert.ok(e.some((i) => i.path === "X.valueQuantity.system" && /absolute reference/.test(i.message)), JSON.stringify(e));
});

const CP = "http://x/StructureDefinition/cond-coding-ext";
const SMALL = "http://x/ValueSet/small-gender";
const UP = "http://x/StructureDefinition/pat-ucum";
const UCUMVS = "http://x/ValueSet/units";
const GENDER = "http://hl7.org/fhir/administrative-gender";
class CodingBindingResolver extends FakeResolver {
  async fetchStructureDefinition(url: string): Promise<Json | null> {
    const u = url.split("|")[0];
    if (u === CP) {
      const base = JSON.parse(JSON.stringify(await super.fetchStructureDefinition(CORE + "Condition")));
      base.url = CP;
      base.derivation = "constraint";
      const at = base.snapshot.element.findIndex((e: Json) => e.path === "Condition.code");
      base.snapshot.element[at].binding = undefined;
      base.snapshot.element.splice(at + 1, 0, { id: "Condition.code.coding", path: "Condition.code.coding", min: 0, max: "*", type: [{ code: "Coding" }], binding: { strength: "extensible", valueSet: SMALL } });
      return base;
    }
    if (u === UP) {
      const base = JSON.parse(JSON.stringify(await super.fetchStructureDefinition(CORE + "Patient")));
      base.url = UP;
      base.derivation = "constraint";
      for (const e of base.snapshot.element) if (e.path === "Patient.gender") e.binding = { strength: "required", valueSet: UCUMVS };
      return base;
    }
    return super.fetchStructureDefinition(url);
  }
  async fetchValueSet(url: string): Promise<Json | null> {
    const u = url.split("|")[0];
    if (u === SMALL) return { resourceType: "ValueSet", url: SMALL, version: "1.0", title: "Small", compose: { include: [{ system: GENDER, concept: [{ code: "male" }] }] } };
    if (u === UCUMVS) return { resourceType: "ValueSet", url: UCUMVS, version: "1.0", title: "Units", compose: { include: [{ system: "http://unitsofmeasure.org" }] } };
    return super.fetchValueSet(url);
  }
  async valueSetContains(url: string, system: string | null, code: string): Promise<boolean | undefined> {
    const u = url.split("|")[0];
    if (u === SMALL) return code === "male";
    if (u === UCUMVS) return code === "mg";
    return super.valueSetContains(url, system, code);
  }
}

test("Terminology_TX_NoValid_13: a coding outside an extensible binding (IV tag 7.0.1:2530), the system's complaint in its {1}", async () => {
  const run = async (coding: Json): Promise<Issue[]> => {
    const r = await new InstanceValidator(new CodingBindingResolver()).validate({ resourceType: "Condition", id: "c", meta: { profile: [CP] }, code: { coding: [coding] }, subject: { reference: "Patient/p" } });
    return r.filter((i) => i.path === "Condition.code.coding[0]" && i.severity === "warning");
  };
  const head = `The Coding provided (${GENDER}#female) was not found in the value set 'Small' (${SMALL}|1.0), and a code should come from this value set unless it has no suitable code (note that the validator cannot judge what is suitable).  (error message = `;
  const plain = await run({ system: GENDER, code: "female" });
  assert.deepEqual(plain.map((i) => i.message), [`${head}The provided code '${GENDER}#female' was not found in the value set '${SMALL}|1.0')`]);
  const wrong = await run({ system: GENDER, code: "female", display: "nope" });
  assert.deepEqual(wrong.map((i) => i.message), [`${head}The provided code '${GENDER}#female ('nope')' was not found in the value set '${SMALL}|1.0'; Wrong Display Name 'nope')`]);
  assert.deepEqual(await run({ system: GENDER, code: "male" }), []);
});

test("systemForCodeInValueSet: a bare code UCUM's grammar rejects is UNABLE_TO_INFER_CODESYSTEM + Terminology_TX_NoValid_16 (jar: ucum-units, ZZZ-9)", async () => {
  const run = async (gender: string): Promise<string[]> => errors(await new InstanceValidator(new CodingBindingResolver()).validate({ resourceType: "Patient", id: "p", meta: { profile: [UP] }, gender })).map((i) => i.message).filter((m) => m.includes(UCUMVS));
  const infer = `The System URI could not be determined for the code 'ZZZ-9' in the ValueSet '${UCUMVS}|1.0'`;
  assert.deepEqual(await run("ZZZ-9"), [
    infer,
    `The value provided ('ZZZ-9') was not found in the value set 'Units' (${UCUMVS}|1.0), and a code is required from this value set  (error message = ${infer}; The provided code '#ZZZ-9' was not found in the value set '${UCUMVS}|1.0')`,
  ]);
  assert.deepEqual(await run("mg"), []);
});
