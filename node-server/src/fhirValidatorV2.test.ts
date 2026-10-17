/**
 * Second-round validator fixes (external report v2, issues A–F). Every rule
 * here was confirmed against the official HL7 validator_cli 7.0.1
 * (-ig tw.gov.mohw.twcore#1.0.0 -tx tx.fhir.org) and/or validator.dicom.tw;
 * see scripts/validator-audit/REPORT.md §v2.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { InstanceValidator, impliedVitalSignProfile, type CodeCheck, type Issue } from "./fhirValidator.js";
import { CODE_SYSTEMS, CORE, FakeResolver, SDS, VALUE_SETS, el, sd } from "./fhirTestKit.test.js";
import { findBaseUrl, hl7UrlMustResolve, oidValid, urnSyntaxIssue, uuidValid } from "./fhirUriRules.js";
import { checkUcumCode } from "./fhirUcum.js";
import { DbValidatorResolver, judgeCodeSystemDisplay, judgeDisplay } from "./fhirValidationResolver.js";

/** FakeResolver + definition lookup (a fixed set of known canonicals). */
class UrlResolver extends FakeResolver {
  constructor(private readonly known: Set<string>) {
    super();
  }
  async definitionExists(url: string): Promise<boolean> {
    return this.known.has(url) || url in SDS;
  }
  async fetchValueSet(url: string): Promise<Record<string, any> | null> {
    if (url === "http://hl7.org/fhir/ValueSet/observation-category") {
      return { resourceType: "ValueSet", url, title: "Observation Category Codes", compose: { include: [] } };
    }
    return super.fetchValueSet(url);
  }
  async checkCode(system: string, code: string, display: string | null): Promise<CodeCheck> {
    if (system === "http://hl7.org/fhir/sid/icd-10-cm" || system === "https://www.hospital.tw/cs") return { status: "silent" };
    return super.checkCode(system, code, display);
  }
}

const KNOWN = new Set(["http://terminology.hl7.org/CodeSystem/observation-category", "http://hl7.org/fhir/ValueSet/observation-category"]);

async function run(resource: Record<string, any>, profiles: string[] = []): Promise<Issue[]> {
  return new InstanceValidator(new UrlResolver(KNOWN)).validate(resource, { profiles });
}
const errors = (issues: Issue[]): Issue[] => issues.filter((i) => i.severity === "error" || i.severity === "fatal");
const errText = (issues: Issue[]): string => errors(issues).map((i) => `${i.path}: ${i.message}`).join("\n");

const obs = (extra: Record<string, any>): Record<string, any> => ({
  resourceType: "Observation",
  status: "final",
  code: { text: "x" },
  dataAbsentReason: { text: "n/a" },
  ...extra,
});

// ---- D: OID / UUID syntax --------------------------------------------------------

test("D: OID rules match HL7 OIDUtilities (+ the three-arc rule)", () => {
  for (const ok of ["2.16.886.101.20003.20014", "2.16.886.101.20003.20014.10", "2.16.886.101.20003.20014.0", "1.3.6", "2.16.886", "2.16.886.101."]) {
    assert.ok(oidValid(ok), ok);
  }
  for (const bad of ["2.16.886.101.donghu.mrn", "2.16.886.101.20003.20014.0001", "3.1.2", "1", "2", "1.2.", "01.2.3", "0.1", "1.2.3", "2.16", "2..16.886"]) {
    assert.ok(!oidValid(bad), bad);
  }
  assert.equal(urnSyntaxIssue("urn:oid:2.16.886.101.donghu.mrn", "uri"), "OIDs must be valid (2.16.886.101.donghu.mrn)");
  assert.equal(urnSyntaxIssue("urn:OID:2.16.886", "uri"), null); // upper-case scheme is not checked by HL7 either
  assert.ok(uuidValid("0000000a-0000-4000-8000-000000000000"));
  assert.ok(!uuidValid("0000000A-0000-4000-8000-000000000000"));
  assert.match(urnSyntaxIssue("urn:uuid:not-a-uuid", "uri") ?? "", /UUIDs must be valid and lowercase \(not-a-uuid\)/);
});

test("D: malformed urn:oid in Identifier.system / Coding.system is an error, a valid one is not", async () => {
  const bad = await run({ resourceType: "Patient", identifier: [{ system: "urn:oid:2.16.886.101.20003.20014.0001", value: "1" }] });
  assert.match(errText(bad), /Patient\.identifier\[0\]\.system: OIDs must be valid \(2\.16\.886\.101\.20003\.20014\.0001\)/);
  const ok = await run({ resourceType: "Patient", identifier: [{ system: "urn:oid:2.16.886.101.20003.20014", value: "1" }] });
  assert.equal(errors(ok).length, 0, errText(ok));
});

test("D: Bundle.entry.fullUrl urn:uuid must be a valid lowercase UUID", async () => {
  const b = await run({ resourceType: "Bundle", type: "collection", entry: [{ fullUrl: "urn:uuid:1", resource: { resourceType: "Patient" } }] });
  assert.match(errText(b), /UUIDs must be valid and lowercase \(1\)/);
});

// ---- B: unresolvable URLs in the HL7 spaces ----------------------------------------

test("B: findBaseUrl / hl7UrlMustResolve mirror StandAloneValidatorFetcher.resolveURL", () => {
  assert.equal(findBaseUrl("http://terminology.hl7.org/CodeSystem/v2-0079"), "http://terminology.hl7.org");
  assert.equal(findBaseUrl("http://hl7.org/fhir/sid/foo"), null);
  assert.ok(hl7UrlMustResolve("http://terminology.hl7.org/CodeSystem/v2-0079"));
  assert.ok(hl7UrlMustResolve("http://hl7.org/fhir/sid/twnhi"));
  assert.ok(hl7UrlMustResolve("http://hl7.org/fhir/medication-route"));
  assert.ok(hl7UrlMustResolve("http://hl7.org/fhir/StructureDefinition/country"));
  assert.ok(hl7UrlMustResolve("http://terminology.hl7.org/fhir/CodeSystem/x"));
  // never errors: known SIDs, no resource segment under THO, other IGs, non-HL7 spaces, https
  for (const u of [
    "http://hl7.org/fhir/sid/icd-10-cm",
    "http://hl7.org/fhir/sid/us-ssn",
    "http://hl7.org/fhir/sid/passport-TWN",
    "http://terminology.hl7.org/foo/bar",
    "http://hl7.org/fhir/us/core/StructureDefinition/us-core-race",
    "https://twcore.mohw.gov.tw/ig/twcore/CodeSystem/foo",
    "https://terminology.hl7.org/CodeSystem/v2-0079",
    "http://loinc.org",
    "urn:oid:2.16.886.101",
    "http://hl7.org/fhir/5.0/StructureDefinition/extension-Foo",
  ]) {
    assert.ok(!hl7UrlMustResolve(u), u);
  }
});

test("B: unknown THO CodeSystem in Coding.system → 'No definition could be found' error; known/external → none", async () => {
  const bad = await run(obs({ category: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/v2-0079", code: "N" }] }] }));
  assert.match(errText(bad), /category\[0\]\.coding\[0\]\.system: No definition could be found for URL value 'http:\/\/terminology\.hl7\.org\/CodeSystem\/v2-0079'/);
  const known = await run(obs({ category: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category", code: "laboratory" }] }] }));
  assert.equal(errors(known).length, 0, errText(known));
  const external = await run(obs({ category: [{ coding: [{ system: "https://www.hospital.tw/cs", code: "N" }] }] }));
  assert.equal(errors(external).length, 0, errText(external));
  const sid = await run(obs({ category: [{ coding: [{ system: "http://hl7.org/fhir/sid/icd-10-cm", code: "A09" }] }] }));
  assert.equal(errors(sid).length, 0, errText(sid));
});

test("B: Identifier.system / Quantity.system in the HL7 space are resolved too", async () => {
  const id = await run({ resourceType: "Patient", identifier: [{ system: "http://hl7.org/fhir/sid/foo", value: "1" }] });
  assert.match(errText(id), /identifier\[0\]\.system: No definition could be found/);
  const q = await run(obs({ dataAbsentReason: undefined, valueQuantity: { value: 1, system: "http://terminology.hl7.org/CodeSystem/foo", code: "x" } }));
  assert.match(errText(q), /valueQuantity\.system: No definition could be found/);
});

test("B: unknown HL7 extension → 'not allowed here' AND unresolvable url (two errors)", async () => {
  const r = await run({ resourceType: "Patient", extension: [{ url: "http://hl7.org/fhir/StructureDefinition/country", valueString: "TW" }] });
  const e = errText(r);
  assert.match(e, /Patient\.extension\[0\]: The extension http:\/\/hl7\.org\/fhir\/StructureDefinition\/country could not be found so is not allowed here/);
  assert.match(e, /Patient\.extension\[0\]\.url: No definition could be found/);
});

test("B: an unknown absolute url nested inside a known complex extension is reported", async () => {
  const r = await run({
    resourceType: "Patient",
    extension: [{ url: CORE + "patient-birthPlace", extension: [{ url: "https://www.hospital.tw/ext/child", valueString: "x" }] }],
  });
  assert.match(errText(r), /extension\[0\]\.extension\[0\]: The extension https:\/\/www\.hospital\.tw\/ext\/child could not be found/);
});

// ---- E: ValueSet URL used as Coding.system ----------------------------------------

test("E: Coding.system pointing at a held ValueSet is an error", async () => {
  const r = await run(obs({ category: [{ coding: [{ system: "http://hl7.org/fhir/ValueSet/observation-category", code: "laboratory" }] }] }));
  assert.match(errText(r), /The Coding references a value set, not a code system \('http:\/\/hl7\.org\/fhir\/ValueSet\/observation-category'\)/);
});

// ---- C: UCUM ---------------------------------------------------------------------

test("C: UCUM grammar — oracle-confirmed invalid and valid codes", () => {
  for (const bad of ["[uIU]/mL", "tab", "/HPF", "beats/min", "mmHg", "degC", "mcg", "IU", "units", "x10^3/uL", "bpm", "kg/m^2", "mL/min/1.73m2", "uIU/mL"]) {
    assert.equal(checkUcumCode(bad), "invalid", bad);
  }
  for (const ok of ["m[IU]/L", "u[IU]/mL", "mg/dL", "Cel", "%", "{score}", "1", "/min", "mm[Hg]", "10*3/uL", "/[HPF]", "kg/m2", "mL/min/{1.73_m2}", "[lb_av]", "{beats}/min", "%{HbA1c}"]) {
    assert.equal(checkUcumCode(ok), "valid", ok);
  }
});

test("C: invalid UCUM code in a Quantity is an error at .code", async () => {
  const bad = await run(obs({ dataAbsentReason: undefined, valueQuantity: { value: 1, unit: "uIU/mL", system: "http://unitsofmeasure.org", code: "[uIU]/mL" } }));
  assert.match(errText(bad), /valueQuantity\.code: Unknown code '\[uIU\]\/mL' in the CodeSystem 'http:\/\/unitsofmeasure\.org' version '2\.2'/);
  const ok = await run(obs({ dataAbsentReason: undefined, valueQuantity: { value: 1, unit: "uIU/mL", system: "http://unitsofmeasure.org", code: "u[IU]/mL" } }));
  assert.equal(errors(ok).length, 0, errText(ok));
});

// ---- A: displays -------------------------------------------------------------------

test("A: display rule — case-insensitive, whitespace-significant, HL7 wording", () => {
  const sys = "http://hl7.org/fhir/sid/icd-10-cm";
  const valid = ["Infectious gastroenteritis and colitis, unspecified"];
  assert.equal(judgeDisplay(sys, "A09", "INFECTIOUS GASTROENTERITIS AND COLITIS, UNSPECIFIED", valid, "error"), null);
  const zh = judgeDisplay(sys, "A09", "感染性胃腸炎及大腸炎", valid, "error");
  assert.equal(zh?.status, "invalid-display");
  assert.match((zh as any).message, /^Wrong Display Name '感染性胃腸炎及大腸炎' for http:\/\/hl7\.org\/fhir\/sid\/icd-10-cm#A09\. Valid display is 'Infectious/);
  const ws = judgeDisplay(sys, "A09", "Infectious  gastroenteritis and colitis, unspecified", valid, "error");
  assert.match((ws as any).message, /^Wrong whitespace in Display Name/);
  const multi = judgeDisplay("http://loinc.org", "3016-3", "TSH", ["Thyrotropin [Units/volume] in Serum or Plasma", "TSH SerPl-aCnc"], "error");
  assert.match((multi as any).message, /one of 2 choices/);
});

test("A: ISO 3166 codes/displays from the bundled tx.fhir.org table", async () => {
  const r = new DbValidatorResolver({ package_id: "x", version: "1" } as any);
  assert.deepEqual(await r.checkCode("urn:iso:std:iso:3166", "TW", "Taiwan, Province of China"), { status: "ok" });
  assert.deepEqual(await r.checkCode("urn:iso:std:iso:3166", "TW", "taiwan, province of china"), { status: "ok" });
  assert.deepEqual(await r.checkCode("urn:iso:std:iso:3166", "TWN", null), { status: "ok" });
  assert.deepEqual(await r.checkCode("urn:iso:std:iso:3166", "158", null), { status: "ok" });
  const tw = await r.checkCode("urn:iso:std:iso:3166", "TW", "Taiwan");
  assert.equal(tw.status, "invalid-display");
  assert.equal((tw as any).severity, "error");
  for (const unknown of ["UK", "EU", "tw", "XXX", "999"]) {
    const u = await r.checkCode("urn:iso:std:iso:3166", unknown, null);
    assert.equal(u.status, "invalid-code", unknown);
  }
  const ua = await r.checkCode("urn:iso:std:iso:3166", "AA", "My territory");
  assert.equal((ua as any).severity, "warning"); // user-assigned: display not fixed
});

// ---- F1: implied vital-sign profiles ------------------------------------------------

test("F1: implied vital-sign profile follows the HL7 table (alternative codes, first group wins)", () => {
  const p = (codes: Array<[string, string]>): string | null => impliedVitalSignProfile({ coding: codes.map(([system, code]) => ({ system, code })) });
  assert.equal(p([["http://loinc.org", "3141-9"]]), CORE + "bodyweight");
  assert.equal(p([["http://loinc.org", "8331-1"]]), CORE + "bodytemp");
  assert.equal(p([["http://loinc.org", "8480-6"]]), CORE + "bp");
  assert.equal(p([["http://loinc.org", "8335-2"]]), null);
  assert.equal(p([["http://loinc.org", "8867-4"], ["http://loinc.org", "85353-1"]]), CORE + "vitalspanel");
  assert.equal(p([["http://snomed.info/sct", "60621009"]]), CORE + "bmi");
});

test("F1: an Observation with an alternative body-weight code must carry the magic 29463-7", async () => {
  SDS[CORE + "bodyweight"] = sd(CORE + "bodyweight", "Observation", "resource", [
    el("Observation", 0, "*"),
    el("Observation.status", 1, "1", ["code"]),
    el("Observation.code", 1, "1", ["CodeableConcept"]),
    el("Observation.code.coding", 0, "*", ["Coding"], { slicing: { discriminator: [{ type: "value", path: "code" }, { type: "value", path: "system" }], rules: "open" } }),
    el("Observation.code.coding:BodyWeightCode", 1, "1", ["Coding"]),
    el("Observation.code.coding:BodyWeightCode.system", 1, "1", ["uri"], { fixedUri: "http://loinc.org" }),
    el("Observation.code.coding:BodyWeightCode.code", 1, "1", ["code"], { fixedCode: "29463-7" }),
    el("Observation.dataAbsentReason", 0, "1", ["CodeableConcept"]),
  ]);
  try {
    const bad = await run(obs({ code: { coding: [{ system: "http://loinc.org", code: "3141-9" }] } }));
    assert.match(errText(bad), /BodyWeightCode': a matching slice is required/);
    const ok = await run(obs({ code: { coding: [{ system: "http://loinc.org", code: "29463-7" }, { system: "http://loinc.org", code: "3141-9" }] } }));
    assert.equal(errors(ok).length, 0, errText(ok));
  } finally {
    delete SDS[CORE + "bodyweight"];
  }
});

// ---- F2: element matching more than one slice ---------------------------------------

test("F2: a repeat that matches two slices is an error (HL7 Validation_VAL_Profile_MatchMultiple)", async () => {
  const P = "http://example.tw/fhir/StructureDefinition/multi";
  SDS[P] = sd(P, "Observation", "resource", [
    el("Observation", 0, "*"),
    el("Observation.status", 1, "1", ["code"]),
    el("Observation.code", 1, "1", ["CodeableConcept"]),
    el("Observation.category", 0, "*", ["CodeableConcept"], { slicing: { discriminator: [{ type: "pattern", path: "$this" }], rules: "open" } }),
    el("Observation.category:bySystem", 0, "1", ["CodeableConcept"], { patternCodeableConcept: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category" }] } }),
    el("Observation.category:byCode", 0, "1", ["CodeableConcept"], {
      patternCodeableConcept: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category", code: "laboratory" }] },
    }),
    el("Observation.dataAbsentReason", 0, "1", ["CodeableConcept"]),
  ], { baseDefinition: CORE + "Observation" });
  try {
    const both = await run(obs({ category: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category", code: "laboratory" }] }] }), [P]);
    assert.match(errText(both), /Element matches more than one slice - bySystem, byCode/);
    const one = await run(obs({ category: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category", code: "vital-signs" }] }] }), [P]);
    assert.equal(errors(one).length, 0, errText(one));
  } finally {
    delete SDS[P];
  }
});

test("F2: a code-less Coding matches every required-binding slice → MatchMultiple per extra slice (HL7 memberOf)", async () => {
  // validator_cli 7.0.1 on TW Core DiagnosticReport-twcore after deleting code.coding:LOINCObservationCode.code:
  // "Element matches more than one slice - LOINCObservationCode, TWLaboratoryCategory" (+ one per further slice).
  const P = "http://example.tw/fhir/StructureDefinition/codeless";
  const CS_A = "http://example.tw/fhir/CodeSystem/a";
  const CS_B = "http://example.tw/fhir/CodeSystem/b";
  const VS_A = "http://example.tw/fhir/ValueSet/a";
  const VS_B = "http://example.tw/fhir/ValueSet/b";
  VALUE_SETS[VS_A] = { resourceType: "ValueSet", url: VS_A, compose: { include: [{ system: CS_A }] } };
  VALUE_SETS[VS_B] = { resourceType: "ValueSet", url: VS_B, compose: { include: [{ system: CS_B }] } };
  CODE_SYSTEMS[CS_A] = { resourceType: "CodeSystem", url: CS_A, content: "complete", concept: [{ code: "a1", display: "A one" }] };
  CODE_SYSTEMS[CS_B] = { resourceType: "CodeSystem", url: CS_B, content: "complete", concept: [{ code: "b1", display: "B one" }] };
  const bind = (vs: string) => ({ binding: { strength: "required", valueSet: vs } });
  SDS[P] = sd(P, "Observation", "resource", [
    el("Observation", 0, "*"),
    el("Observation.status", 1, "1", ["code"]),
    el("Observation.code", 1, "1", ["CodeableConcept"]),
    el("Observation.code.coding", 0, "*", ["Coding"], { slicing: { discriminator: [{ type: "pattern", path: "$this" }], rules: "open" } }),
    el("Observation.code.coding:sliceA", 0, "1", ["Coding"], bind(VS_A)),
    el("Observation.code.coding:sliceA.system", 1, "1", ["uri"], { fixedUri: CS_A }),
    el("Observation.code.coding:sliceA.code", 1, "1", ["code"]),
    el("Observation.code.coding:sliceA.display", 0, "1", ["string"]),
    el("Observation.code.coding:sliceB", 0, "1", ["Coding"], bind(VS_B)),
    el("Observation.code.coding:sliceB.system", 0, "1", ["uri"]),
    el("Observation.code.coding:sliceB.code", 1, "1", ["code"]),
    el("Observation.code.coding:sliceB.display", 0, "1", ["string"]),
    el("Observation.dataAbsentReason", 0, "1", ["CodeableConcept"]),
  ], { baseDefinition: CORE + "Observation" });
  class LocalCs extends UrlResolver {
    async codeSystemLocal(system: string): Promise<boolean> {
      return system in CODE_SYSTEMS;
    }
  }
  const check = async (coding: Record<string, any>, resolver: UrlResolver = new LocalCs(KNOWN)) =>
    new InstanceValidator(resolver).validate(obs({ code: { coding: [coding] } }), { profiles: [P] });
  try {
    const multi = /Element matches more than one slice - sliceA, sliceB/;
    // local CodeSystem, code deleted → both slices match (and sliceA's own code min=1 fires)
    const del = await check({ system: CS_B, display: "B one" });
    assert.match(errText(del), multi);
    assert.match(errText(del), /code: minimum required = 1/);
    // "" is dropped by the HL7 parser: same as a missing code
    assert.match(errText(await check({ system: CS_A, code: "" })), multi);
    // no system and no code: HL7 warns "Coding has no system or code" (isOk) → matches too
    assert.match(errText(await check({ display: "x" })), multi);
    // a real code matches only its own slice
    const ok = await check({ system: CS_B, code: "b1" });
    assert.equal(errors(ok).length, 0, errText(ok));
    // systems the HL7 validator sends to the terminology server (or cannot resolve) are not decided here
    assert.doesNotMatch(errText(await check({ system: "http://loinc.org", display: "x" })), multi);
    assert.doesNotMatch(errText(await check({ system: "http://example.tw/unknown", display: "x" })), multi);
    // resolvers without codeSystemLocal keep the previous behaviour for codings with a system
    assert.doesNotMatch(errText(await check({ system: CS_B, display: "B one" }, new UrlResolver(KNOWN))), multi);
  } finally {
    delete SDS[P];
    delete VALUE_SETS[VS_A];
    delete VALUE_SETS[VS_B];
    delete CODE_SYSTEMS[CS_A];
    delete CODE_SYSTEMS[CS_B];
  }
});

test("A: local CodeSystem display check is a port of ValueSetValidator (language-aware)", () => {
  const sys = "http://terminology.hl7.org/CodeSystem/condition-clinical";
  const c = { display: "Active", designationList: [{ language: "nl", value: "Actief" }, { language: "en", value: "Currently active" }] };
  assert.equal(judgeCodeSystemDisplay(sys, "active", "ACTIVE", c, null), null);
  assert.equal(judgeCodeSystemDisplay(sys, "active", "currently active", c, null), null);
  const nl = judgeCodeSystemDisplay(sys, "active", "Actief", c, null); // non-English designation: not accepted
  assert.equal((nl as any).severity, "error");
  assert.match((nl as any).message, /Valid display is one of 2 choices: 'Active' or 'Currently active' \(en\)/);
  const ws = judgeCodeSystemDisplay(sys, "active", "Currently  active", c, null);
  assert.match((ws as any).message, /^Wrong whitespace in Display Name/);
  // CodeSystem in another language: matching its own display is information only
  const zh = { display: "活動中", designationList: [] };
  assert.equal((judgeCodeSystemDisplay(sys, "active", "活動中", zh, "zh-TW") as any).severity, "information");
  assert.equal((judgeCodeSystemDisplay(sys, "active", "別的", zh, "zh-TW") as any).severity, "error");
});
