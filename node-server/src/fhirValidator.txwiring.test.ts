/**
 * parity v3 tx-validator-wiring: ValidateOptions languages / displayWarnings, judgeHeldCodeSystem (supplement as a
 * Coding.system, v2-0203 NN<country>, isOkLanguage), Terminology_TX_Code_ValueSet_MISSING, codes without a system in a
 * binding, Terminology_TX_ValueSet_NotFound_CS, and unchecked codes / slices in completenessOf (REVIEW_port_1 F1, F5,
 * F20). Java references: InstanceValidator.checkPrimitive / checkCoding / checkCodedElement, ValueSetValidator
 * validateCode / isOkLanguage / findSpecialConcept (validator 7.0.1).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { composeContains, indexCodeSystem } from "./fhirCodeSystem.js";
import { completenessOf, InstanceValidator, type CodeCheck, type Issue } from "./fhirValidator.js";
import { serverPrefers } from "./fhirSpecialSystems.js";
import { isOkLanguage, judgeHeldCodeSystem } from "./fhirValidationResolver.js";
import { COND_PROFILE, CORE, FakeResolver } from "./fhirTestKit.test.js";

type Json = Record<string, any>;
const errors = (issues: Issue[]): Issue[] => issues.filter((i) => i.severity === "error" || i.severity === "fatal");

test("checkPrimitive: a required-bound primitive without a value is Terminology_TX_Code_ValueSet_MISSING (error); a cross-version extension makes it a warning", async () => {
  const dar = { resourceType: "Patient", id: "p1", _gender: { extension: [{ url: "http://hl7.org/fhir/StructureDefinition/data-absent-reason", valueCode: "unknown" }] } };
  const issues = await new InstanceValidator(new FakeResolver()).validate(dar);
  assert.ok(errors(issues).some((i) => i.path === "Patient.gender" && i.message === "No code provided, and a code is required from the value set"), JSON.stringify(issues));
  const xver = { resourceType: "Patient", id: "p1", _gender: { extension: [{ url: "http://hl7.org/fhir/5.0/StructureDefinition/extension-Patient.gender", valueCode: "x" }] } };
  const i2 = await new InstanceValidator(new FakeResolver()).validate(xver);
  assert.ok(!errors(i2).some((i) => /No code provided/.test(i.message)));
  assert.ok(i2.some((i) => i.severity === "warning" && /no code has been provided; instead, an alternative code 'x'/.test(i.message)));
});

test("judgeHeldCodeSystem: supplement as Coding.system (error at .system), v2-0203 NN<country>, requested languages", () => {
  const sup = indexCodeSystem({ resourceType: "CodeSystem", url: "http://x/cs-sup", content: "supplement", supplements: "http://x/cs", concept: [{ code: "a" }] });
  const r = judgeHeldCodeSystem(sup, "http://x/cs-sup", "a", null);
  assert.deepEqual(r, { status: "invalid-code", severity: "error", at: "system", message: "CodeSystem http://x/cs-sup is a supplement, so can't be used as a value in Coding.system" });
  const v2 = indexCodeSystem({ resourceType: "CodeSystem", url: "http://terminology.hl7.org/CodeSystem/v2-0203", version: "5.0.0", content: "complete", concept: [{ code: "MR", display: "Medical record number" }] });
  assert.deepEqual(judgeHeldCodeSystem(v2, v2.url, "NNFIN", null), { status: "ok" });
  assert.deepEqual(judgeHeldCodeSystem(v2, v2.url, "NNTWN", "National Identifier for Taiwan, Province of China"), { status: "ok" });
  assert.equal(judgeHeldCodeSystem(v2, v2.url, "NNXXX", null)?.status, "invalid-code");
  const cs = indexCodeSystem({ resourceType: "CodeSystem", url: "http://x/cs", content: "complete", concept: [{ code: "a", display: "Alpha" }] });
  const bad = judgeHeldCodeSystem(cs, cs.url, "a", "Beta", ["en-US"]);
  assert.equal(bad && "message" in bad ? bad.message : "", "Wrong Display Name 'Beta' for http://x/cs#a. Valid display is 'Alpha' (for the language(s) 'en-US')");
  // LanguageUtils.langsMatch(requested, designation): requested starts with the designation's language
  assert.equal(isOkLanguage(["en-US"], "en"), true);
  assert.equal(isOkLanguage(["en"], "en-US"), false);
  assert.equal(isOkLanguage(["en"], null), true);
  assert.equal(isOkLanguage(["*"], "de"), true);
});

class DisplayResolver extends FakeResolver {
  langs: Array<string[] | undefined> = [];
  async checkCode(system: string, code: string, display: string | null, _v?: string | null, langs?: string[]): Promise<CodeCheck> {
    this.langs.push(langs);
    return super.checkCode(system, code, display);
  }
}

test("ValidateOptions: languages reach the resolver (default not passed), displayWarnings turns a wrong display into a warning", async () => {
  const cond = {
    resourceType: "Condition",
    id: "c1",
    meta: { profile: [COND_PROFILE] },
    clinicalStatus: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-clinical", code: "active", display: "Wrong" }] },
    category: [{ text: "x" }],
    subject: { reference: "Patient/p1" },
  };
  const r1 = new DisplayResolver();
  const plain = await new InstanceValidator(r1).validate(cond);
  assert.ok(errors(plain).some((i) => /Wrong Display Name 'Wrong'/.test(i.message)));
  assert.ok(r1.langs.every((l) => l === undefined));
  const r2 = new DisplayResolver();
  const warn = await new InstanceValidator(r2).validate(cond, { displayWarnings: true, languages: ["en-US"] });
  assert.ok(!errors(warn).some((i) => /Wrong Display Name/.test(i.message)), JSON.stringify(errors(warn)));
  assert.ok(warn.some((i) => i.severity === "warning" && /Wrong Display Name 'Wrong'/.test(i.message)));
  assert.ok(r2.langs.some((l) => l && l[0] === "en-US"));
});

test("a coding without a system is never a member of a bound value set (ValueSetValidator: Coding_has_no_system)", async () => {
  const cond = { resourceType: "Condition", id: "c1", meta: { profile: [COND_PROFILE] }, clinicalStatus: { coding: [{ code: "active" }] }, category: [{ text: "x" }], subject: { reference: "Patient/p1" } };
  const issues = await new InstanceValidator(new FakeResolver()).validate(cond);
  assert.ok(errors(issues).some((i) => i.path === "Condition.clinicalStatus" && /None of the codings provided are in the value set/.test(i.message)), JSON.stringify(issues));
  // inside a CodeableConcept without a binding of its own: no TERMINOLOGY_TX_SYSTEM_NO_CODE on the coding
  assert.ok(!issues.some((i) => i.path === "Condition.clinicalStatus.coding[0]" && /A code with no system/.test(i.message)));
});

test("a binding naming a CodeSystem instead of a ValueSet is Terminology_TX_ValueSet_NotFound_CS (error)", async () => {
  const P = "http://x/StructureDefinition/pat-cs-binding";
  class R extends FakeResolver {
    async fetchStructureDefinition(url: string): Promise<Json | null> {
      if (url.split("|")[0] !== P) return super.fetchStructureDefinition(url);
      const base = JSON.parse(JSON.stringify(await super.fetchStructureDefinition(CORE + "Patient")));
      base.url = P;
      base.derivation = "constraint";
      for (const e of base.snapshot.element) if (e.path === "Patient.gender") e.binding = { strength: "required", valueSet: "http://hl7.org/fhir/administrative-gender" };
      return base;
    }
    async codeSystemExists(url: string): Promise<boolean> {
      return url === "http://hl7.org/fhir/administrative-gender";
    }
  }
  const issues = await new InstanceValidator(new R()).validate({ resourceType: "Patient", id: "p1", meta: { profile: [P] }, gender: "male" });
  assert.ok(errors(issues).some((i) => i.path === "Patient.gender" && i.message === "Found a reference to a CodeSystem 'http://hl7.org/fhir/administrative-gender' where a ValueSet belongs"), JSON.stringify(issues));
});

test("completenessOf: undecidable codes and slices make the run incomplete (REVIEW F5)", () => {
  const c = completenessOf([
    { severity: "warning", path: "x", code: "code-invalid", message: "m", unchecked: { kind: "code", canonical: "http://vs" } },
    { severity: "information", path: "y", code: "informational", message: "m", unchecked: { kind: "slice", canonical: "http://p#Obs.code.coding" } },
  ]);
  assert.equal(c.checked_fully, false);
  assert.deepEqual(c.codes_unchecked, ["http://vs"]);
  assert.deepEqual(c.slices_unchecked, ["http://p#Obs.code.coding"]);
  const clean = completenessOf([]);
  assert.equal(clean.checked_fully, true);
  assert.equal("codes_unchecked" in clean, false);
});

test("an undecidable code (no local terminology) is reported as unchecked, never a silent pass", async () => {
  class R extends FakeResolver {
    async checkCode(system: string, code: string, display: string | null): Promise<CodeCheck> {
      if (system === "http://hl7.org/fhir/sid/ndc") return { status: "silent", undecided: true };
      return super.checkCode(system, code, display);
    }
  }
  const cond = { resourceType: "Condition", id: "c1", meta: { profile: [COND_PROFILE] }, category: [{ coding: [{ system: "http://hl7.org/fhir/sid/ndc", code: "0002-1433" }] }], subject: { reference: "Patient/p1" } };
  const issues = await new InstanceValidator(new R()).validate(cond);
  assert.equal(completenessOf(issues).checked_fully, false);
  assert.deepEqual(completenessOf(issues).codes_unchecked, ["http://hl7.org/fhir/sid/ndc"]);
});

// ---- REVIEW_port_2 (standalone ValueSetValidator.java, tag 7.0.1) -------------------------------------------------

test("G2: a concept without a display accepts no display (NO_VALID_DISPLAY_FOUND_NONE_FOR_LANG_ERR, Default display 'null') — VSV:1413", () => {
  const cs = indexCodeSystem({ resourceType: "CodeSystem", url: "http://x/oo", content: "complete", concept: [{ code: "資料檢核失敗" }] });
  const r = judgeHeldCodeSystem(cs, cs.url, "資料檢核失敗", "任意文字");
  assert.equal(r?.status, "invalid-display");
  assert.equal(r && "message" in r ? r.message : "", "Wrong Display Name '任意文字' for http://x/oo#資料檢核失敗. There are no valid display names found for language(s) 'en'. Default display is 'null'");
  assert.equal(r && "severity" in r ? r.severity : "", "error");
  assert.deepEqual(judgeHeldCodeSystem(cs, cs.url, "資料檢核失敗", null), { status: "ok" });
});

test("G5: caseSensitive defaults to false (CodeSystem.getCaseSensitive) → a case-different code is found with CODE_CASE_DIFFERENCE; an enumerated include stays exact", async () => {
  const cs = indexCodeSystem({ resourceType: "CodeSystem", url: "http://x/nocase", content: "complete", concept: [{ code: "ABC", display: "A" }] });
  const r = judgeHeldCodeSystem(cs, cs.url, "abc", null);
  assert.equal(r?.status, "ok");
  assert.match(r?.extra?.[0]?.message ?? "", /^The code 'abc' differs from the correct code 'ABC' by case/);
  const cs2 = indexCodeSystem({ resourceType: "CodeSystem", url: "http://x/case", content: "complete", caseSensitive: true, concept: [{ code: "ABC" }] });
  assert.equal(judgeHeldCodeSystem(cs2, cs2.url, "abc", null)?.status, "invalid-code");
  const deps = { loadValueSet: async () => null, loadCodeSystem: async () => cs, lookupExternal: async () => null, externalSystemHeld: async () => false };
  assert.equal(await composeContains({ include: [{ system: "http://x/nocase", concept: [{ code: "ABC" }] }] }, "http://x/nocase", "abc", deps), false);
  assert.equal(await composeContains({ include: [{ system: "http://x/nocase" }] }, "http://x/nocase", "abc", deps), true);
});

test("G11: an unknown DICOM code in a held complete CodeSystem is an error", () => {
  const dcm = indexCodeSystem({ resourceType: "CodeSystem", url: "http://dicom.nema.org/resources/ontology/DCM", version: "01", content: "complete", concept: [{ code: "110114", display: "User Name" }] });
  const r = judgeHeldCodeSystem(dcm, dcm.url, "NOTACODE", null);
  assert.deepEqual(r, { status: "invalid-code", severity: "error", message: "Unknown code 'NOTACODE' in the CodeSystem 'http://dicom.nema.org/resources/ontology/DCM' version '01'" });
});

test("G4: Resource.language is the display language of its code checks (IV:7380 checkLang, IV:9296)", async () => {
  const r = new DisplayResolver();
  const cond = {
    resourceType: "Condition",
    id: "c1",
    language: "zh-TW",
    meta: { profile: [COND_PROFILE] },
    clinicalStatus: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-clinical", code: "active" }] },
    category: [{ text: "x" }],
    subject: { reference: "Patient/p1" },
  };
  await new InstanceValidator(r).validate(cond);
  assert.ok(r.langs.some((l) => l && l[0] === "zh-TW"), JSON.stringify(r.langs));
  const cs = indexCodeSystem({ resourceType: "CodeSystem", url: "http://x/zh", content: "complete", concept: [{ code: "a", display: "Alpha", designation: [{ language: "zh-TW", value: "甲" }] }] });
  assert.deepEqual(judgeHeldCodeSystem(cs, cs.url, "a", "甲", ["zh-TW"]), { status: "ok" });
  assert.equal(judgeHeldCodeSystem(cs, cs.url, "a", "甲", ["en"])?.status, "invalid-display");
});

test("G1: systems the terminology server answers (SERVER_SIDE_LIST) are undecided when not held, not unknown", () => {
  for (const s of ["http://varnomen.hgvs.org", "http://unstats.un.org/unsd/methods/m49/m49.htm", "https://www.usps.com/", "http://www.ama-assn.org/go/cpt"]) assert.equal(serverPrefers(s), true, s);
  assert.equal(serverPrefers("http://hospital.example/cs"), false);
});
