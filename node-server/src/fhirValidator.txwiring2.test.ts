/**
 * parity v3 tx-validator-wiring, round 2: REVIEW_port_2 G3 (determineVersion, standalone ValueSetValidator.java:1878,
 * tag 7.0.1), REVIEW_port_1 F9 (FHIRPathEngine.opMemberOf: isOk includes the display) and F20 maxValueSet
 * (InstanceValidator.checkMaxValueSet IV:2267-2365).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { codingVersionIssues, presentVersionList, versionIsMoreDetailed } from "./fhirCsVersion.js";
import { judgeExternalDisplay } from "./fhirExternalTerminology.js";
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
  // TERMINOLOGY_TX_SYSTEM_RELATIVE on an unbound Quantity: on the Quantity only (jar alone: system "" and "local", Observation
  // valueQuantity, MedicationDispense.daysSupply, Medication strength.denominator with system 1)
  for (const system of ["", "local", 1]) {
    const e: Issue[] = [];
    await v.checkQuantity({ value: 2, system, code: "mg" }, { path: "X.valueQuantity" }, e);
    const rel = e.filter((i) => /absolute reference/.test(i.message)).map((i) => i.path);
    assert.deepEqual(rel, ["X.valueQuantity"], JSON.stringify(e));
  }
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

const SP = "http://x/StructureDefinition/cond-coding-sct";
const SCTVS = "http://x/ValueSet/sct";
const SCT = "http://snomed.info/sct";
class SnomedBindingResolver extends FakeResolver {
  constructor(private readonly filtered: boolean) {
    super();
  }
  async fetchStructureDefinition(url: string): Promise<Json | null> {
    if (url.split("|")[0] !== SP) return super.fetchStructureDefinition(url);
    const base = JSON.parse(JSON.stringify(await super.fetchStructureDefinition(CORE + "Condition")));
    base.url = SP;
    base.derivation = "constraint";
    const at = base.snapshot.element.findIndex((e: Json) => e.path === "Condition.code");
    base.snapshot.element[at].binding = undefined;
    base.snapshot.element.splice(at + 1, 0, { id: "Condition.code.coding", path: "Condition.code.coding", min: 0, max: "*", type: [{ code: "Coding" }], binding: { strength: "required", valueSet: SCTVS } });
    return base;
  }
  async fetchValueSet(url: string): Promise<Json | null> {
    if (url.split("|")[0] !== SCTVS) return super.fetchValueSet(url);
    const include: Json = this.filtered ? { system: SCT, filter: [{ property: "concept", op: "is-a", value: "1234" }] } : { system: SCT, concept: [{ code: "1234" }] };
    return { resourceType: "ValueSet", url: SCTVS, title: "Sct", compose: { include: [include] } };
  }
  async valueSetContains(url: string, system: string | null, code: string): Promise<boolean | undefined> {
    return url.split("|")[0] === SCTVS ? code === "1234" : super.valueSetContains(url, system, code);
  }
  async checkCode(system: string, code: string, display: string | null): Promise<CodeCheck> {
    return system === SCT ? { status: "invalid-code", severity: "error", message: `Unknown code '${code}'` } : super.checkCode(system, code, display);
  }
}

test("Terminology_TX_Confirm_4a: the server's expression parser comes first when the value set filters SNOMED CT, display or not (tx.fhir.org probe)", async () => {
  const run = async (filtered: boolean, coding: Json): Promise<string> => {
    const r = await new InstanceValidator(new SnomedBindingResolver(filtered)).validate({ resourceType: "Condition", id: "c", meta: { profile: [SP] }, code: { coding: [coding] }, subject: { reference: "Patient/p" } });
    return r.find((i) => i.path === "Condition.code.coding[0]" && i.severity === "error")?.message ?? "";
  };
  const after = (shown: string, code: string): string => `The provided code '${shown}' was not found in the value set '${SCTVS}'; Unknown code '${code}'`;
  assert.ok((await run(true, { system: SCT, code: "zz-x" })).endsWith(`required: Not a valid expression: Concept not found (next char = "z", in "zz-x") at character 1; ${after(`${SCT}#zz-x`, "zz-x")}`));
  assert.ok((await run(true, { system: SCT, code: "zz-x", display: "d" })).endsWith(`required: Not a valid expression: Concept not found (next char = "z", in "zz-x") at character 1; ${after(`${SCT}#zz-x ('d')`, "zz-x")}`));
  assert.ok((await run(true, { system: SCT, code: " lead" })).includes(`(next char = "l", in " lead") at character 2; `));
  assert.ok((await run(true, { system: SCT, code: "123 abc" })).includes(`required: Not a valid expression: Found content ("a") after end of expression at character 5; `));
  assert.ok((await run(true, { system: SCT, code: "12345a6" })).includes(`Found content ("a") after end of expression at character 6; `));
  assert.ok((await run(true, { system: SCT, code: "999" })).endsWith(`required: ${after(`${SCT}#999`, "999")}`));
  assert.ok((await run(true, { system: SCT, code: "123|x|" })).endsWith(`required: ${after(`${SCT}#123|x|`, "123|x|")}`));
  assert.ok((await run(false, { system: SCT, code: "zz-x" })).endsWith(`required: ${after(`${SCT}#zz-x`, "zz-x")}`));
});

const RP = "http://x/StructureDefinition/cond-coding-req";
const CCP = "http://x/StructureDefinition/cond-cc-req";
const PATP = "http://x/StructureDefinition/cond-pattern";
class RequiredCodingResolver extends CodingBindingResolver {
  async fetchStructureDefinition(url: string): Promise<Json | null> {
    const u = url.split("|")[0];
    if (u !== RP && u !== CCP && u !== PATP) return super.fetchStructureDefinition(url);
    const base = JSON.parse(JSON.stringify(await super.fetchStructureDefinition(CORE + "Condition")));
    base.url = u;
    base.derivation = "constraint";
    const at = base.snapshot.element.findIndex((e: Json) => e.path === "Condition.code");
    base.snapshot.element[at].binding = u === CCP ? { strength: "required", valueSet: SMALL } : undefined;
    if (u === PATP) base.snapshot.element[at].patternCodeableConcept = { coding: [{ system: GENDER, code: "male" }] };
    if (u === RP) base.snapshot.element.splice(at + 1, 0, { id: "Condition.code.coding", path: "Condition.code.coding", min: 0, max: "*", type: [{ code: "Coding" }], binding: { strength: "required", valueSet: SMALL } });
    return base;
  }
}
const cond = (profile: string, coding: Json): Json => ({ resourceType: "Condition", id: "c", meta: { profile: [profile] }, code: { coding: [coding] }, subject: { reference: "Patient/p" } });

test("a required Coding, a wrong display of a locally validated system: Terminology_TX_NoValid_12 (official corpus)", async () => {
  const r = errors(await new InstanceValidator(new RequiredCodingResolver()).validate(cond(RP, { system: GENDER, code: "male", display: "nope" })));
  assert.ok(r.some((i) => i.path === "Condition.code.coding[0]" && i.message === `The Coding provided (${GENDER}#male) was not found in the value set 'Small' (${SMALL}|1.0), and a code is required from this value set.  (error message = Wrong Display Name 'nope')`), JSON.stringify(r));
});

test("a number as display is read as its text, an instance's control character stays in the message", async () => {
  const num = errors(await new InstanceValidator(new RequiredCodingResolver()).validate(cond(RP, { system: GENDER, code: "male", display: 7 })));
  assert.ok(num.some((i) => i.message === "Wrong Display Name '7'"), JSON.stringify(num));
  const ctl = errors(await new InstanceValidator(new RequiredCodingResolver()).validate(cond(RP, { system: GENDER, code: "male", display: "tab\u0001" })));
  assert.ok(ctl.some((i) => i.message === "Wrong Display Name 'tab\u0001'"), JSON.stringify(ctl));
});

test("an empty code: Terminology_TX_Confirm_4a on a Coding with a binding of its own, null in a CodeableConcept's summary (official corpus)", async () => {
  const c = errors(await new InstanceValidator(new RequiredCodingResolver()).validate(cond(RP, { system: GENDER, code: "" })));
  assert.ok(c.some((i) => i.path === "Condition.code.coding[0]" && i.message === `The code provided (${GENDER}#) was not found in the value set 'Small' (${SMALL}|1.0), and a code from this value set is required: Coding has no code for system ${GENDER} and cannot be validated`), JSON.stringify(c));
  const cc = errors(await new InstanceValidator(new RequiredCodingResolver()).validate(cond(CCP, { system: GENDER, code: "" })));
  assert.ok(cc.some((i) => i.path === "Condition.code" && i.message.endsWith(`(codes = ${GENDER}#null)`)), JSON.stringify(cc));
});

test("a pattern's nested locations carry the entry resource's comment (List<ValidationMessage>.toString, official corpus)", async () => {
  const bundle = { resourceType: "Bundle", type: "collection", entry: [{ fullUrl: "urn:uuid:7c1b7a4e-0a33-4b52-9d1a-1f0f2f7f9b11", resource: cond(PATP, { system: "http://x/other", code: "male" }) }] };
  const r = await new InstanceValidator(new RequiredCodingResolver()).validate(bundle);
  const m = r.find((i) => i.path === "Bundle.entry[0].resource.code" && i.message.startsWith("The pattern ["));
  assert.ok(m?.message.includes("location=Bundle.entry[0].resource/*Condition/c*/.code.coding.system"), JSON.stringify(r));
});

test("a pattern's system with only its _system shadow: Value is 'null', not Missing element; a number as system in the CodeableConcept summary (official corpus)", async () => {
  const shadow = { resourceType: "Condition", id: "c", meta: { profile: [PATP] }, code: { coding: [{ _system: { extension: [{ url: "http://x/e", valueString: "v" }] }, code: "male" }] }, subject: { reference: "Patient/p" } };
  const r = await new InstanceValidator(new RequiredCodingResolver()).validate(shadow);
  const m = r.find((i) => i.path === "Condition.code" && i.message.startsWith("The pattern ["));
  assert.ok(m?.message.includes(`message=Value is 'null' but is fixed to '${GENDER}' in the profile`), JSON.stringify(r));
  const num = errors(await new InstanceValidator(new RequiredCodingResolver()).validate(cond(CCP, { system: 1, code: "female" })));
  assert.ok(num.some((i) => i.path === "Condition.code" && i.message.endsWith("(codes = 1#female)")), JSON.stringify(num));
});

test("SNOMED CT display choices carry their language (official corpus)", () => {
  const r = judgeExternalDisplay(SCT, "1", "x", ["A", "B", "C"], ["A", "B", "C"], undefined, "en");
  assert.equal(r?.status === "invalid-display" ? r.message : "", `Wrong Display Name 'x' for ${SCT}#1. Valid display is one of 3 choices: 'A' (en), 'B' (en) or 'C' (en) (for the language(s) 'en')`);
  const two = judgeExternalDisplay(SCT, "1", "x", ["A", "B"], ["A", "B"], undefined, "en");
  assert.ok(two?.status === "invalid-display" && two.message.includes("one of 2 choices: 'A' (en) or 'B' (en) (for"));
});

const NEXTP = "http://x/StructureDefinition/cond-next";
class NextElementResolver extends RequiredCodingResolver {
  constructor(private readonly next: Json | null) {
    super();
  }
  async fetchStructureDefinition(url: string): Promise<Json | null> {
    if (url.split("|")[0] !== NEXTP) return super.fetchStructureDefinition(url);
    const base = JSON.parse(JSON.stringify(await super.fetchStructureDefinition(PATP)));
    base.url = NEXTP;
    const at = base.snapshot.element.findIndex((e: Json) => e.path === "Condition.code");
    if (this.next) base.snapshot.element.splice(at + 1, 0, this.next);
    return base;
  }
}

test("checkChildByDefinition l. 8173-8184: a next snapshot element whose path starts with this one repeats the fixed / pattern check against the element's own definition", async () => {
  const run = async (next: Json | null): Promise<string[]> => {
    const r = await new InstanceValidator(new NextElementResolver(next)).validate(cond(NEXTP, { system: "http://x/other", code: "male" }));
    return r.filter((i) => i.path === "Condition.code" && i.message.startsWith("The pattern [")).map((i) => /in the profile \S+#([^\],]+)/u.exec(i.message)?.[1] ?? "");
  };
  // a string prefix, not a child (Encounter.class / Encounter.classHistory)
  assert.deepEqual(await run({ id: "Condition.codeHistory", path: "Condition.codeHistory", min: 0, max: "*", type: [{ code: "string" }] }), ["Condition", "Condition.code"]);
  // a real child
  assert.deepEqual(await run({ id: "Condition.code.text", path: "Condition.code.text", min: 0, max: "1", type: [{ code: "string" }] }), ["Condition", "Condition.code"]);
  assert.deepEqual(await run(null), ["Condition"]);
});

const CS203 = "http://x/CodeSystem/v2";
class ScopedCsResolver extends RequiredCodingResolver {
  async fetchValueSet(url: string): Promise<Json | null> {
    if (url.split("|")[0] === SMALL) return { resourceType: "ValueSet", url: SMALL, version: "1.0", title: "Small", compose: { include: [{ system: CS203 }] } };
    return super.fetchValueSet(url);
  }
  async valueSetContains(url: string, system: string | null, code: string): Promise<boolean | undefined> {
    return url.split("|")[0] === SMALL ? false : super.valueSetContains(url, system, code);
  }
  async checkCode(system: string, code: string, display: string | null): Promise<CodeCheck> {
    return system === CS203 ? { status: "invalid-code", severity: "error", message: `Unknown code '${code}' in the CodeSystem '${CS203}' version '5.0.0'` } : super.checkCode(system, code, display);
  }
  async scopedDefinitionVersion(url: string, source: Json, type?: string): Promise<string | null> {
    return url === CS203 && source.url === SMALL && type === "CodeSystem" ? "4.0.0" : null;
  }
}

test("resolveCodeSystem with the value set as source: an unpinned include answers with the version of the value set's package", async () => {
  const r = errors(await new InstanceValidator(new ScopedCsResolver()).validate(cond(CCP, { system: CS203, code: "zz" })));
  const at = r.filter((i) => i.path === "Condition.code.coding[0].code").map((i) => i.message);
  assert.ok(at.includes(`Unknown code 'zz' in the CodeSystem '${CS203}' version '4.0.0'`), JSON.stringify(r));
});

class HeldGenderResolver extends RequiredCodingResolver {
  async fetchCodeSystem(url: string): Promise<Json | null> {
    return url.split("|")[0] === GENDER ? { resourceType: "CodeSystem", url: GENDER, version: "4.0.1", content: "complete", concept: [{ code: "male" }] } : null;
  }
}

test("an empty code of a held CodeSystem: NO_CODE_PROVIDED_VERSION only, no Terminology_TX_Confirm_4a (official corpus: PAS nhi-medication)", async () => {
  const r = errors(await new InstanceValidator(new HeldGenderResolver()).validate(cond(RP, { system: GENDER, code: "" })));
  assert.ok(!r.some((i) => i.message.startsWith(`The code provided (${GENDER}#)`)), JSON.stringify(r));
});

const IMPP = "http://x/StructureDefinition/cond-import";
const OUTER = "http://x/ValueSet/outer";
const INNER = "http://x/ValueSet/inner";
class ImportResolver extends FakeResolver {
  constructor(private readonly innerHeld: boolean) {
    super();
  }
  async fetchStructureDefinition(url: string): Promise<Json | null> {
    if (url.split("|")[0] !== IMPP) return super.fetchStructureDefinition(url);
    const base = JSON.parse(JSON.stringify(await super.fetchStructureDefinition(CORE + "Condition")));
    base.url = IMPP;
    base.derivation = "constraint";
    for (const e of base.snapshot.element) if (e.path === "Condition.code") e.binding = { strength: "preferred", valueSet: OUTER };
    return base;
  }
  async fetchValueSet(url: string): Promise<Json | null> {
    const u = url.split("|")[0];
    if (u === OUTER) return { resourceType: "ValueSet", url: OUTER, compose: { include: [{ valueSet: [INNER] }, { system: "http://x/cs", concept: [{ code: "a" }] }] } };
    if (u === INNER) return this.innerHeld ? { resourceType: "ValueSet", url: INNER, compose: { include: [{ system: SCT, concept: [{ code: "77386006" }] }] } } : null;
    return super.fetchValueSet(url);
  }
}

test("Coding.version under a value set reaching SNOMED CT through an import: the import's includes decide; an import not held is not checked", async () => {
  const c = { resourceType: "Condition", id: "c", meta: { profile: [IMPP] }, code: { coding: [{ system: SCT, version: "http://snomed.info/sct/731000124108", code: "77386006" }] }, subject: { reference: "Patient/p" } };
  const held = await new InstanceValidator(new ImportResolver(true)).validate(c);
  assert.ok(held.some((i) => i.severity === "error" && i.path === "Condition.code.coding[0].version" && i.message === `The code system '${SCT}' version 'http://snomed.info/sct/900000000000207008' resulting from the version '' in the ValueSet include is different to the one in the value ('http://snomed.info/sct/731000124108')`), JSON.stringify(held));
  const dropped = await new InstanceValidator(new ImportResolver(true)).validate({ ...c, code: { coding: [{ system: SCT, version: "http://snomed.info/sct/731000124108", code: ["77386006"] }] } });
  assert.ok(!dropped.some((i) => i.path === "Condition.code.coding[0].version"), JSON.stringify(dropped));
  const away = await new InstanceValidator(new ImportResolver(false)).validate(c);
  const note = away.find((i) => i.path === "Condition.code.coding[0].version");
  assert.ok(note && note.severity === "information" && note.unchecked?.kind === "valueSet" && note.unchecked.canonical === INNER, JSON.stringify(away));
});

const BAREP = "http://x/StructureDefinition/pat-bare";
const BAREVS = "http://x/ValueSet/bare";
class BareCodeResolver extends FakeResolver {
  async fetchStructureDefinition(url: string): Promise<Json | null> {
    if (url.split("|")[0] !== BAREP) return super.fetchStructureDefinition(url);
    const base = JSON.parse(JSON.stringify(await super.fetchStructureDefinition(CORE + "Patient")));
    base.url = BAREP;
    base.derivation = "constraint";
    for (const e of base.snapshot.element) if (e.path === "Patient.gender") e.binding = { strength: "extensible", valueSet: BAREVS };
    return base;
  }
  async fetchValueSet(url: string): Promise<Json | null> {
    return url.split("|")[0] === BAREVS ? { resourceType: "ValueSet", url: BAREVS, compose: { include: [{ system: "https://x.example/states" }] } } : super.fetchValueSet(url);
  }
  async valueSetContains(url: string, system: string | null, code: string): Promise<boolean | undefined> {
    return url.split("|")[0] === BAREVS ? undefined : super.valueSetContains(url, system, code);
  }
}

test("an undecided bare code names the system it would be inferred from, not an empty one", async () => {
  const r = await new InstanceValidator(new BareCodeResolver()).validate({ resourceType: "Patient", id: "p", meta: { profile: [BAREP] }, gender: "CA" });
  const note = r.find((i) => i.path === "Patient.gender" && i.unchecked?.kind === "code");
  assert.deepEqual(note?.unchecked?.causes, [`https://x.example/states|${BAREVS}`], JSON.stringify(r));
});

test("LOINC display choices: the display, then every designation, equal names not merged (official corpus)", async () => {
  const { loincDisplayChoices } = await import("./fhirValidationResolver.js");
  assert.equal(loincDisplayChoices(["Hispanic or Latino", "Hispanic or Latino"]), "one of 3 choices: 'Hispanic or Latino' (en-US), 'Hispanic or Latino' (en-US) or 'Hispanic or Latino' (en-US)");
  assert.equal(loincDisplayChoices(["A"]), "one of 2 choices: 'A' (en-US) or 'A' (en-US)");
});

const VSDP = "http://x/StructureDefinition/cond-vsdisplay";
const VSD = "http://x/ValueSet/with-display";
class VsDisplayResolver extends RequiredCodingResolver {
  async fetchStructureDefinition(url: string): Promise<Json | null> {
    if (url.split("|")[0] !== VSDP) return super.fetchStructureDefinition(url);
    const base = JSON.parse(JSON.stringify(await super.fetchStructureDefinition(CORE + "Condition")));
    base.url = VSDP;
    base.derivation = "constraint";
    for (const e of base.snapshot.element) if (e.path === "Condition.code") e.binding = { strength: "extensible", valueSet: VSD };
    return base;
  }
  async fetchValueSet(url: string): Promise<Json | null> {
    return url.split("|")[0] === VSD ? { resourceType: "ValueSet", url: VSD, title: "WithDisplay", compose: { include: [{ system: GENDER, concept: [{ code: "male", display: "Man" }] }] } } : super.fetchValueSet(url);
  }
  async valueSetContains(url: string, system: string | null, code: string): Promise<boolean | undefined> {
    return url.split("|")[0] === VSD ? code === "male" : super.valueSetContains(url, system, code);
  }
  async checkCode(system: string, code: string, display: string | null): Promise<CodeCheck> {
    if (system === GENDER && code === "male" && display !== null && display.toLowerCase() !== "male") {
      return { status: "invalid-display", severity: "error", message: `Wrong Display Name '${display}' for ${GENDER}#male. Valid display is 'Male' (en) (for the language(s) 'en')`, choices: ["'Male' (en)"], ws: false, langList: "en" };
    }
    return super.checkCode(system, code, display);
  }
}

test("useValueSetDisplays (ValueSetValidator 7.0.1:1366-1385): the value set's display is a valid one and joins the choices of its issue", async () => {
  const run = async (display: string): Promise<Issue[]> => (await new InstanceValidator(new VsDisplayResolver()).validate(cond(VSDP, { system: GENDER, code: "male", display }))).filter((i) => i.path === "Condition.code.coding[0].display" || i.path === "Condition.code");
  const wrong = await run("nope");
  assert.ok(wrong.some((i) => i.message === `Wrong Display Name 'nope' for ${GENDER}#male. Valid display is one of 2 choices: 'Male' (en) or 'Man' (for the language(s) 'en')`), JSON.stringify(wrong));
  const vsName = await run("Man");
  assert.ok(!vsName.some((i) => i.path === "Condition.code"), JSON.stringify(vsName));
});

test("ValueSetValidator.checkValueSetOptions: an invalid resource language fails every locally answered binding (INVALID_DISPLAY_NAME, jar alone)", async () => {
  const r = await new InstanceValidator(new RequiredCodingResolver()).validate({ resourceType: "Patient", id: "p", language: "trailing ", gender: "male" });
  const at = r.filter((i) => i.path === "Patient.gender").map((i) => `${i.severity} ${i.message}`);
  assert.ok(at.includes("error Invalid displayLanguage: 'trailing'"), JSON.stringify(r));
  assert.ok(at.some((m) => m.startsWith("error The value provided ('male') was not found in the value set") && m.endsWith("(error message = Invalid displayLanguage: 'trailing')")), JSON.stringify(r));
  const ok = await new InstanceValidator(new RequiredCodingResolver()).validate({ resourceType: "Patient", id: "p", language: "de-CH", gender: "male" });
  assert.ok(!ok.some((i) => /Invalid displayLanguage/.test(i.message)), JSON.stringify(ok));
});

test("a UCUM unit the grammar rejects under a binding the validator checks: Unknown_Code_in_Version on .code as well (official corpus, mcode m^2)", async () => {
  const v = new InstanceValidator(new FakeResolver()) as any;
  const e: Issue[] = [];
  await v.checkQuantity({ value: 2, system: "http://unitsofmeasure.org", code: "m^2" }, { path: "X.valueQuantity" }, e, { path: "X.valueQuantity", binding: { strength: "extensible", valueSet: "http://hl7.org/fhir/ValueSet/ucum-units" } });
  assert.ok(e.some((i) => i.severity === "error" && i.path === "X.valueQuantity.code" && i.message === "Unknown code 'm^2' in the CodeSystem 'http://unitsofmeasure.org' version '2.2'"), JSON.stringify(e));
});
