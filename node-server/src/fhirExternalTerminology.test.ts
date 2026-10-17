/**
 * Validator audit v4: LOINC non-term codes, SNOMED CT inactive content / edition
 * emulation, CVX, WHO ICD-10 and the Coding.version rule. Every expectation is
 * a verdict validator_cli 7.0.1 + tx.fhir.org gave for the same input
 * (scripts/validator-audit corpus v4_probes / v4_mut, REPORT.md §v4).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SNOMED_INT_EDITION_URI,
  codingVersionIssue,
  icd10WhoStrict,
  judgeCvx,
  judgeIcd10Who,
  judgeLoincOther,
  judgeSnomed,
  loincNonTermCheckDigitValid,
  snomedStrict,
  type SnomedDescriptionRow,
} from "./fhirExternalTerminology.js";
import { InstanceValidator, type CodeCheck } from "./fhirValidator.js";
import { FakeResolver } from "./fhirTestKit.test.js";
import { loincReleaseVersion, parseLoincOtherCodes } from "./loaders/loinc.js";
import { parseIcd10WhoJson } from "./loaders/icd.js";
import { firstReleasedFromFull, snomedReleaseDate } from "./loaders/snomed.js";

const bad = (r: CodeCheck): boolean => (r.status === "invalid-code" || r.status === "invalid-display") && r.severity === "error";

// ---- LOINC ------------------------------------------------------------------

test("LOINC non-term check digit: real LA / LL / LP / LG codes pass, neighbours fail", () => {
  for (const ok of ["LA6752-5", "LA11883-8", "LA20278-0", "LA33-6", "LL1101-6", "LL1000-0", "LP7057-5", "LP101394-7", "LG100-4", "LG8749-6"]) {
    assert.ok(loincNonTermCheckDigitValid(ok), ok);
  }
  for (const no of ["LA6752-4", "LA99990-4", "LL1101-5", "LP7057-4", "LG100-5", "LX12-3", "LA-1"]) {
    assert.ok(!loincNonTermCheckDigitValid(no), no);
  }
});

test("LOINC LA / LP / LL displays as tx.fhir.org (2.82)", () => {
  const la = { kind: "answer", display: "Mild", altDisplay: null, status: null };
  assert.equal(judgeLoincOther("LA6752-5", "Mild", la, false).status, "ok");
  assert.equal(judgeLoincOther("LA6752-5", "MILD", la, false).status, "ok");
  assert.equal(judgeLoincOther("LA6752-5", null, la, false).status, "ok");
  const ws = judgeLoincOther("LA6752-5", "Mild ", la, false);
  assert.ok(bad(ws) && ws.status === "invalid-display" && ws.message.startsWith("Wrong whitespace in Display Name"));
  assert.ok(bad(judgeLoincOther("LA6752-5", "Severe", la, false)));
  assert.ok(bad(judgeLoincOther("LA6752-5", "輕微", la, false)));
  const lp = { kind: "part", display: "Blood", altDisplay: "Bld", status: "ACTIVE" };
  assert.equal(judgeLoincOther("LP7057-5", "Bld", lp, false).status, "ok");
  assert.equal(judgeLoincOther("LP7057-5", "blood", lp, false).status, "ok");
  const lpw = judgeLoincOther("LP7057-5", "foo bar", lp, false);
  assert.ok(bad(lpw) && lpw.status === "invalid-display" && lpw.message.includes("Valid display is 'Bld'"));
  const dep = judgeLoincOther("LP183737-8", null, { kind: "part", display: "x", altDisplay: null, status: "DEPRECATED" }, false);
  assert.equal(dep.status, "ok");
  assert.equal(dep.extra?.[0]?.severity, "warning");
  const ll = { kind: "answer_list", display: "PhenX06_24_sunburn skin reaction", altDisplay: null, status: null };
  assert.ok(bad(judgeLoincOther("LL1101-6", "foo bar", ll, false)));
});

test("LOINC unknown non-term codes: LG always, bad check digit always, otherwise only when strict", () => {
  // tx.fhir.org has no LOINC group codes at all.
  const lg = judgeLoincOther("LG11803-0", null, { kind: "group", display: "g", altDisplay: null, status: "Active" }, false);
  assert.ok(bad(lg) && lg.status === "invalid-code" && lg.message === "Unknown code 'LG11803-0' in the CodeSystem 'http://loinc.org' version '2.82'");
  assert.ok(bad(judgeLoincOther("LA6752-4", null, null, false)));
  const missing = judgeLoincOther("LA99999-7", null, null, false);
  assert.equal(missing.status, "invalid-code");
  assert.equal((missing as any).severity, "warning");
  assert.ok(loincNonTermCheckDigitValid("LA99999-7"));
  assert.ok(bad(judgeLoincOther("LA99999-7", null, null, true)));
});

test("LOINC loader: other codes and release version", () => {
  const rows = parseLoincOtherCodes({
    answerList:
      "AnswerListId,AnswerListName,AnswerStringId,DisplayText\n" +
      "LL1000-0,PhenX bread,LA13825-7,1 slice\n" +
      "LL1001-8,Other list,LA13825-7,1 slice\n",
    part: "PartNumber,PartTypeName,PartName,PartDisplayName,Status\nLP7057-5,SYSTEM,Bld,Blood,ACTIVE\n",
    group: "ParentGroupId,GroupId,Group,Archetype,Status\nLG100-4,LG8749-6,(Acer) Ab.IgE,,Active\n",
    parentGroup: "ParentGroupId,ParentGroup,Status\nLG100-4,Chem,ACTIVE\n",
  });
  const by = new Map(rows.map((r) => [r[0], r]));
  assert.deepEqual(by.get("LA13825-7"), ["LA13825-7", "answer", "1 slice", null, null]);
  assert.deepEqual(by.get("LL1000-0"), ["LL1000-0", "answer_list", "PhenX bread", null, null]);
  assert.deepEqual(by.get("LP7057-5"), ["LP7057-5", "part", "Blood", "Bld", "ACTIVE"]);
  assert.equal(by.get("LG8749-6")?.[1], "group");
  assert.equal(by.get("LG100-4")?.[1], "parent_group");
  assert.equal(rows.length, 6);
  assert.equal(loincReleaseVersion([{ VersionLastChanged: "2.9" }, { VersionLastChanged: "2.80" }, { VersionLastChanged: "" }]), "2.80");
});

// ---- SNOMED CT ----------------------------------------------------------------

const ed = { moduleId: "900000000000207008", versionDate: "2025-06-01", includesInactive: true };

test("SNOMED strict mode: International edition with inactive content, not older than tx.fhir.org", () => {
  assert.ok(snomedStrict(ed, null));
  assert.ok(snomedStrict(ed, SNOMED_INT_EDITION_URI));
  assert.ok(snomedStrict(ed, `${SNOMED_INT_EDITION_URI}/version/20250201`));
  assert.ok(!snomedStrict(ed, "http://snomed.info/sct/731000124108"));
  assert.ok(!snomedStrict({ ...ed, includesInactive: false }, null));
  assert.ok(!snomedStrict({ ...ed, versionDate: "2024-09-01" }, null));
  assert.ok(!snomedStrict(null, null));
});

const gravid: SnomedDescriptionRow[] = [
  { term: "Gravid uterus", active: true, effectiveTime: "2017-07-31", firstReleased: "2002-01-31" },
  { term: "Gravid uterus structure", active: true, effectiveTime: "2017-07-31", firstReleased: "2002-01-31" },
  { term: "Gravid uterus structure (body structure)", active: true, effectiveTime: "2017-07-31", firstReleased: "2002-01-31" },
];
const inactiveConcept = { active: false, effectiveTime: "2024-04-01", firstReleased: "2002-01-31" };

test("SNOMED inactive concept: warning, displays from its active descriptions", () => {
  const ok = judgeSnomed("9258009", "Gravid uterus", inactiveConcept, gravid, true);
  assert.equal(ok.status, "ok");
  assert.match(ok.extra?.[0]?.message ?? "", /The concept '9258009' has a status of inactive/);
  assert.ok(bad(judgeSnomed("9258009", "foo bar", inactiveConcept, gravid, true)));
  assert.ok(bad(judgeSnomed("9258009", "測試名稱", inactiveConcept, gravid, true)));
  assert.equal(judgeSnomed("9258009", null, inactiveConcept, gravid, true).status, "ok");
});

test("SNOMED inactive description: INACTIVE_DISPLAY_FOUND unless inactivated after the tx.fhir.org edition", () => {
  const concept = { active: true, effectiveTime: null, firstReleased: "2002-01-31" };
  const descs: SnomedDescriptionRow[] = [
    { term: "Pregnancy", active: true, effectiveTime: null, firstReleased: "2002-01-31" },
    { term: "Pregnancy, NOS", active: false, effectiveTime: "2002-01-31", firstReleased: "2002-01-31" },
    { term: "Late retired", active: false, effectiveTime: "2025-06-01", firstReleased: "2002-01-31" },
    { term: "Brand new synonym", active: true, effectiveTime: null, firstReleased: "2025-06-01" },
  ];
  const r = judgeSnomed("77386006", "Pregnancy, NOS", concept, descs, true);
  assert.ok(bad(r) && r.status === "invalid-display" && r.message.includes("is no longer considered a correct display"));
  // still active in the 2025-02-01 edition tx.fhir.org serves
  assert.equal(judgeSnomed("77386006", "Late retired", concept, descs, true).status, "ok");
  // did not exist yet in that edition
  assert.ok(bad(judgeSnomed("77386006", "Brand new synonym", concept, descs, true)));
});

test("SNOMED unknown concepts: error when strict (incl. released after the tx edition), warning otherwise", () => {
  const u = judgeSnomed("987654321008", null, null, [], true);
  assert.ok(bad(u) && u.status === "invalid-code" && u.message.includes("version 'http://snomed.info/sct/900000000000207008/version/20250201'"));
  assert.equal((judgeSnomed("987654321008", null, null, [], false) as any).severity, "warning");
  const late = { active: true, effectiveTime: null, firstReleased: "2025-03-01" };
  assert.ok(bad(judgeSnomed("1365792007", null, late, [], true)));
  assert.equal(judgeSnomed("1365792007", null, late, [], false).status, "ok");
});

// ---- CVX / WHO ICD-10 ---------------------------------------------------------

test("CVX: tx.fhir.org table, short or long description, exact codes", () => {
  assert.equal(judgeCvx("197", "Influenza, high-dose, quadrivalent, PF").status, "ok");
  assert.equal(judgeCvx("197", "INFLUENZA, HIGH-DOSE, QUADRIVALENT, PF").status, "ok");
  assert.equal(judgeCvx("08", null).status, "ok");
  assert.ok(bad(judgeCvx("8", null)));
  assert.ok(bad(judgeCvx("9999", null)));
  const ws = judgeCvx("197", "Influenza,  high-dose, quadrivalent, PF");
  assert.ok(bad(ws) && ws.status === "invalid-display" && ws.message.startsWith("Wrong whitespace"));
  assert.ok(bad(judgeCvx("197", "foo bar")));
});

test("WHO ICD-10: case-sensitive codes, title or long description, strict only for the tx edition", () => {
  const row = { display: "External upper lip", altDisplays: ["Malignant neoplasm: External upper lip"] };
  assert.equal(judgeIcd10Who("C00.0", "External upper lip", row, "2019-covid-expanded", true).status, "ok");
  assert.equal(judgeIcd10Who("C00.0", "Malignant neoplasm: External upper lip", row, "2019-covid-expanded", true).status, "ok");
  assert.ok(bad(judgeIcd10Who("C00.0", "foo bar", row, "2019-covid-expanded", true)));
  assert.ok(bad(judgeIcd10Who("a09", null, null, "2019-covid-expanded", true)));
  assert.equal((judgeIcd10Who("A09.5", null, null, "2016", false) as any).severity, "warning");
  assert.ok(icd10WhoStrict({ edition: "2019-covid-expanded", complete: true }));
  assert.ok(!icd10WhoStrict({ edition: "2016", complete: true }));
});

test("WHO ICD-10 loader: FHIR CodeSystem and $expand result", () => {
  const cs = parseIcd10WhoJson(
    JSON.stringify({
      resourceType: "CodeSystem",
      url: "http://hl7.org/fhir/sid/icd-10",
      version: "2019-covid-expanded",
      concept: [
        { code: "I", display: "Certain infectious and parasitic diseases", concept: [{ code: "A00-A09", display: "Intestinal infectious diseases" }] },
        { code: "C00.0", display: "External upper lip", designation: [{ value: "Malignant neoplasm: External upper lip" }] },
      ],
    }),
  );
  assert.equal(cs.version, "2019-covid-expanded");
  assert.deepEqual(cs.records.map((r) => r[0]).sort(), ["A00-A09", "C00.0", "I"]);
  assert.deepEqual(cs.records.find((r) => r[0] === "C00.0")?.[3], ["Malignant neoplasm: External upper lip"]);
  const vs = parseIcd10WhoJson(
    JSON.stringify({
      resourceType: "ValueSet",
      expansion: {
        parameter: [{ name: "used-codesystem", valueUri: "http://hl7.org/fhir/sid/icd-10|2019-covid-expanded" }],
        contains: [{ system: "http://hl7.org/fhir/sid/icd-10", code: "A09", display: "Other gastroenteritis", contains: [{ system: "http://hl7.org/fhir/sid/icd-10", code: "A09.0", display: "x" }] }],
      },
    }),
  );
  assert.equal(vs.version, "2019-covid-expanded");
  assert.equal(vs.records.length, 2);
  assert.throws(() => parseIcd10WhoJson(JSON.stringify({ resourceType: "CodeSystem", url: "http://loinc.org", concept: [] })));
});

test("SNOMED loader: first release dates from an RF2 Full file, release date from the member name", () => {
  const text =
    "id\teffectiveTime\tactive\tmoduleId\tdefinitionStatusId\r\n" +
    "9258009\t20020131\t1\t900000000000207008\t900000000000074008\r\n" +
    "9258009\t20240401\t0\t900000000000207008\t900000000000074008\r\n" +
    "1365792007\t20250301\t1\t900000000000207008\t900000000000074008\r\n";
  const m = firstReleasedFromFull(new TextEncoder().encode(text));
  assert.equal(m.get("9258009"), "2002-01-31");
  assert.equal(m.get("1365792007"), "2025-03-01");
  assert.equal(snomedReleaseDate("x/Snapshot/Terminology/sct2_Concept_Snapshot_INT_20250601.txt"), "2025-06-01");
});

// ---- Coding.version vs ValueSet include ----------------------------------------

test("Coding.version: VALUESET_VALUE_MISMATCH_CHANGED for a non-International SNOMED edition", () => {
  const vs = { compose: { include: [{ system: "http://snomed.info/sct", concept: [{ code: "77386006" }] }] } };
  const S = "http://snomed.info/sct";
  assert.equal(codingVersionIssue(vs, S, SNOMED_INT_EDITION_URI), null);
  assert.equal(codingVersionIssue(vs, S, `${SNOMED_INT_EDITION_URI}/version/20250201`), null);
  assert.equal(codingVersionIssue(vs, S, `${SNOMED_INT_EDITION_URI}/version/20240101`), null);
  for (const v of ["http://snomed.info/sct/731000124108", "http://snomed.info/sct/731000124108/version/20250301", "foo", "http://snomed.info/sct/11000146104"]) {
    assert.match(codingVersionIssue(vs, S, v) ?? "", /resulting from the version '' in the ValueSet include is different to the one in the value/, v);
  }
  // no SNOMED include / other systems: nothing to compare
  assert.equal(codingVersionIssue({ compose: { include: [{ system: "http://loinc.org" }] } }, S, "foo"), null);
  assert.equal(codingVersionIssue(vs, "http://loinc.org", "2.80"), null);
});

test("Coding.version rule applies to a preferred binding through the validator", async () => {
  const VS = "http://example.org/ValueSet/preg";
  class R extends FakeResolver {
    async fetchValueSet(url: string): Promise<Record<string, any> | null> {
      if (url === VS) return { resourceType: "ValueSet", url, compose: { include: [{ system: "http://snomed.info/sct", concept: [{ code: "77386006" }] }] } };
      return super.fetchValueSet(url);
    }
    async checkCode(): Promise<CodeCheck> {
      return { status: "ok" };
    }
  }
  const sd = {
    resourceType: "StructureDefinition",
    url: "http://example.org/StructureDefinition/obs-preg",
    type: "Observation",
    baseDefinition: "http://hl7.org/fhir/StructureDefinition/Observation",
    derivation: "constraint",
    snapshot: { element: [] as any[] },
  };
  // Use the base Observation snapshot with a preferred binding on value[x].
  const base = await new R().fetchStructureDefinition("http://hl7.org/fhir/StructureDefinition/Observation");
  assert.ok(base, "test kit Observation SD");
  sd.snapshot.element = (base!.snapshot.element as any[]).map((e) =>
    e.path === "Observation.value[x]" ? { ...e, binding: { strength: "preferred", valueSet: VS } } : e,
  );
  class R2 extends R {
    async fetchStructureDefinition(url: string): Promise<Record<string, any> | null> {
      return url === sd.url ? sd : super.fetchStructureDefinition(url);
    }
  }
  const obs = (version: string) => ({
    resourceType: "Observation",
    status: "final",
    code: { text: "pregnancy" },
    valueCodeableConcept: { coding: [{ system: "http://snomed.info/sct", code: "77386006", version }] },
  });
  const errs = async (v: string): Promise<string[]> =>
    (await new InstanceValidator(new R2()).validate(obs(v), { profiles: [sd.url] }))
      .filter((i) => i.severity === "error")
      .map((i) => `${i.path}: ${i.message}`);
  assert.deepEqual(await errs(SNOMED_INT_EDITION_URI), []);
  const us = await errs("http://snomed.info/sct/731000124108");
  assert.equal(us.length, 1);
  assert.match(us[0], /valueCodeableConcept\.coding\[0\]\.version: The code system 'http:\/\/snomed\.info\/sct' version/);
});
