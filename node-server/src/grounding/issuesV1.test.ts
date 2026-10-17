/**
 * Regression tests for the external acceptance report "issues v1" (2026-10-17): four grounding false positives,
 * each with negative tests proving the fix does not open a hole. Hand-written synthetic records (the reporter's
 * own files are not in this repo). Pure: a small static terminology table, no private fixtures needed.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { checkGrounding, type GroundingInput, type GroundingResult } from "./checkGrounding.js";
import { absenceConceptsIn, aliasIn, departmentKeysOf, nameSimilarity, positivePatientConcepts } from "./lexicon.js";
import { staticTerminologyNames } from "./terminologyNames.js";

const P = "https://twcore.mohw.gov.tw/ig/twcore/StructureDefinition/";
const NHI = "https://twcore.mohw.gov.tw/ig/twcore/CodeSystem/medical-service-payment-tw";
const PT_URL = "urn:uuid:00000000-0000-4000-8000-000000000001";

// every coding these records use: the SNOMED display, and the displays our DB provider returns for the NHI glucose
// codes (fhir.concepts)
const terminology = staticTerminologyNames({
  codes: {
    "http://snomed.info/sct|773568002": { found: true, names: ["Emergency medicine (qualifier value)", "Emergency medicine"] },
    [`${NHI}|09140C`]: { found: true, names: ["血液及體液葡萄糖-餐後"] },
    [`${NHI}|09005C`]: { found: true, names: ["血液及體液葡萄糖-空腹"] },
  },
});

const patient = (extra: Record<string, unknown> = {}): unknown => ({
  fullUrl: PT_URL,
  resource: { resourceType: "Patient", meta: { profile: [P + "Patient-twcore"] }, name: [{ text: "王大明" }], gender: "male", birthDate: "1960-03-02", ...extra },
});
const encounter = (start: string, end: string, extra: Record<string, unknown> = {}): unknown => ({
  fullUrl: "urn:uuid:00000000-0000-4000-8000-000000000002",
  resource: {
    resourceType: "Encounter",
    meta: { profile: [P + "Encounter-twcore"] },
    status: "finished",
    class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "EMER" },
    subject: { reference: PT_URL },
    period: { start, end },
    ...extra,
  },
});
const glucoseObs = (code: string, text: string): unknown => ({
  fullUrl: "urn:uuid:00000000-0000-4000-8000-000000000003",
  resource: {
    resourceType: "Observation",
    meta: { profile: [P + "Observation-laboratoryResult-twcore"] },
    status: "final",
    code: { coding: [{ system: NHI, code }], text },
    subject: { reference: PT_URL },
    effectiveDateTime: "2026-09-27",
    valueQuantity: { value: 182, unit: "mg/dL", system: "http://unitsofmeasure.org", code: "mg/dL" },
  },
});
const bundle = (...entry: unknown[]): Record<string, unknown> => ({ resourceType: "Bundle", type: "collection", meta: { profile: [P + "Bundle-twcore"] }, entry });
const serviceType = { serviceType: { coding: [{ system: "http://snomed.info/sct", code: "773568002", display: "Emergency medicine" }], text: "急診" } };

const ER_RECORD = [
  "Emergency Department Record",
  "姓名：王大明　性別：男　出生日期：1960/03/02",
  "Arrival：115.09.27 01:48",
  "Triage Level 1",
  "CC: chest pain for 2 hours",
  "PE: BP 92/60 mmHg, HR 118",
  "Impression: acute chest pain",
  "Disposition：06:10 離院",
  "【轉換目標】請將本次急診就診轉換為 Patient 與 Encounter",
].join("\n");

async function run(input: Partial<GroundingInput> & { bundle: unknown; source_text: string }): Promise<GroundingResult> {
  return checkGrounding({ verbosity: "all", ...input } as GroundingInput, { terminology });
}
const errorsAt = (out: GroundingResult, pathTail: string): string[] =>
  out.entries.flatMap((e) => e.issues).filter((i) => i.severity === "error" && i.path.endsWith(pathTail)).map((i) => i.rule);

// ------------------------------------------------------------------------------------------------ issue 1
test("issue 1: a time-only line takes its date from the encounter context in force (Arrival date, later Disposition time)", async () => {
  const out = await run({ bundle: bundle(patient(), encounter("2026-09-27T01:48:00+08:00", "2026-09-27T06:10:00+08:00")), source_text: ER_RECORD });
  assert.deepStrictEqual(errorsAt(out, "period.end"), []);
  const loc = out.entries[1].issues.find((i) => i.rule === "G-AUTO-LOCATED" && i.path.endsWith("period.end"))!;
  assert.deepStrictEqual(loc.located_quotes, ["Arrival：115.09.27 01:48", "Disposition：06:10 離院"]);
});

test("issue 1 negative: a time after another current-event date belongs to that date, not to the arrival date", async () => {
  const text = ["急診病歷", "姓名：王大明　性別：男　出生日期：1960/03/02", "到院：115.09.27 01:48", "Impression: chest pain", "回診日期：115.10.04", "Disposition：06:10 離院"].join("\n");
  const out = await run({ bundle: bundle(patient(), encounter("2026-09-27T01:48:00+08:00", "2026-09-27T06:10:00+08:00")), source_text: text });
  assert.deepStrictEqual(errorsAt(out, "period.end"), ["G-VALUE-PRECISION"]);
});

test("issue 1 negative: the date-time pairing rule still holds (到院 09-21 23:15 … 離院 09-22 03:40 rejects 09-22T23:15)", async () => {
  const text = ["急診病歷", "姓名：王大明　性別：男　出生日期：1960/03/02", "到院 2026-09-21 23:15", "Impression: chest pain", "離院 2026-09-22 03:40"].join("\n");
  const bad = await run({ bundle: bundle(patient(), encounter("2026-09-21T23:15:00+08:00", "2026-09-22T23:15:00+08:00")), source_text: text });
  assert.ok(errorsAt(bad, "period.end").length > 0);
  const good = await run({ bundle: bundle(patient(), encounter("2026-09-21T23:15:00+08:00", "2026-09-22T03:40:00+08:00")), source_text: text });
  assert.deepStrictEqual(errorsAt(good, "period"), []);
});

test("issue 1: history / birth-date lines do not change the date context; a time before any date is not paired", async () => {
  const hist = ["急診病歷", "姓名：王大明　性別：男", "到院：115.09.27 01:48", "PMH：上次住院 115.03.02（肺炎）", "出生日期：1960/03/02", "Disposition：06:10 離院"].join("\n");
  const out = await run({ bundle: bundle(patient(), encounter("2026-09-27T01:48:00+08:00", "2026-09-27T06:10:00+08:00")), source_text: hist });
  assert.deepStrictEqual(errorsAt(out, "period.end"), []);
  const before = ["急診病歷", "06:10 離院", "姓名：王大明　性別：男　出生日期：1960/03/02", "到院：115.09.27 01:48"].join("\n");
  const out2 = await run({ bundle: bundle(patient(), encounter("2026-09-27T01:48:00+08:00", "2026-09-27T06:10:00+08:00")), source_text: before });
  assert.ok(errorsAt(out2, "period.end").length > 0);
});

// ------------------------------------------------------------------------------------------------ issue 2
test("issue 2: stated-absent concepts are matched on whole labels, never by prefix", () => {
  const cases: Array<[string, string[]]> = [
    ["出生地：不詳", []],
    ["出生地點：不詳", []],
    ["出生院所：不詳", []],
    ["出生日期：不詳", ["birthDate"]],
    ["出生：不詳", ["birthDate"]],
    ["生日不詳", ["birthDate"]],
    ["出生年月日：未記載", ["birthDate"]],
    ["DOB: unknown", ["birthDate"]],
    ["unknown DOB", ["birthDate"]],
    ["住院號：不詳", []],
    ["住院日期：不詳", ["date"]],
    ["聯絡人姓名：不詳", []],
    ["聯絡電話：不詳", []],
    ["contact name: unknown", []],
    ["病人姓名：不詳", ["name"]],
    ["姓名、生日均不詳", ["name", "birthDate"]],
    ["病人：（姓名、病歷號欄位未填）", ["name", "mrn"]],
    ["未提供病歷號", ["mrn"]],
    ["身分證字號：未提供", ["national_id"]],
    ["Rx: Methimazole 減量續用 × 28 天（新劑量待補登）", ["dose"]],
    ["上週已做 HbA1c 檢驗（抽血日期未記載）", ["date"]],
    ["診斷：不明原因發燒", []],
    ["出生日期：1960/03/02　出生地：不詳", []],
  ];
  for (const [s, exp] of cases) assert.deepStrictEqual(absenceConceptsIn(s).sort(), [...exp].sort(), s);
  assert.deepStrictEqual([...positivePatientConcepts("姓名：王大明\n出生日期：1960/03/02　出生地：不詳")].sort(), ["birthDate", "name"]);
});

test("issue 2: '出生地：不詳' with a stated birth date is no G-STATED-ABSENT", async () => {
  const text = "門診病歷\n姓名：王大明　性別：男\n出生日期：1960/03/02　出生地：不詳\n就診日期：115/09/27\nDx: J00 acute nasopharyngitis";
  const out = await run({ bundle: bundle(patient()), source_text: text });
  assert.deepStrictEqual(errorsAt(out, "birthDate"), []);
});

test("issue 2 negative: '出生地：不詳' and no birth date -> G-UNGROUNDED (not G-STATED-ABSENT)", async () => {
  const text = "門診病歷\n姓名：王大明　性別：男\n出生地：不詳\n就診日期：115/09/27\nDx: J00 acute nasopharyngitis";
  const out = await run({ bundle: bundle(patient()), source_text: text });
  assert.deepStrictEqual(errorsAt(out, "birthDate"), ["G-UNGROUNDED"]);
});

test("issue 2 negative: a real stated-absent birth date ('出生日期：不詳') is still G-STATED-ABSENT", async () => {
  const text = "門診病歷\n姓名：王大明　性別：男\n出生日期：不詳\n就診日期：115/09/27\nDx: J00 acute nasopharyngitis";
  const out = await run({ bundle: bundle(patient()), source_text: text });
  assert.ok(errorsAt(out, "birthDate").includes("G-STATED-ABSENT"));
});

// ------------------------------------------------------------------------------------------------ issue 3
test("issue 3: English department name in the record body grounds serviceType (instruction line not needed)", async () => {
  const out = await run({ bundle: bundle(patient(), encounter("2026-09-27T01:48:00+08:00", "2026-09-27T06:10:00+08:00", serviceType)), source_text: ER_RECORD });
  assert.deepStrictEqual(errorsAt(out, "serviceType"), []);
  assert.deepStrictEqual(errorsAt(out, "class"), []);
  const loc = out.entries[1].issues.find((i) => i.rule === "G-AUTO-LOCATED" && i.path.endsWith("serviceType"))!;
  assert.equal(loc.located_quote, "Emergency Department Record");
});

test("issue 3 negative: 'ED'/'ER' inside other words is no support; instruction-only support stays G-CONTEXT-INSTRUCTION", async () => {
  const text = [
    "Outpatient medical record (treated, followed up; fever)",
    "姓名：王大明　性別：男　出生日期：1960/03/02",
    "Visit date：115.09.27 01:48",
    "Impression: acute chest pain",
    "Disposition：06:10 離院",
    "【轉換目標】請將本次急診就診轉換為 Patient 與 Encounter",
  ].join("\n");
  const out = await run({ bundle: bundle(patient(), encounter("2026-09-27T01:48:00+08:00", "2026-09-27T06:10:00+08:00", serviceType)), source_text: text });
  assert.deepStrictEqual(errorsAt(out, "serviceType"), ["G-CONTEXT-INSTRUCTION"]);
  assert.deepStrictEqual(errorsAt(out, "class"), ["G-CONTEXT-INSTRUCTION"]);
});

test("issue 3: alias matching — short tokens whole-token only; zh/en department keys", () => {
  assert.equal(aliasIn("treated, followed up", "ED"), false);
  assert.equal(aliasIn("fever", "ER"), false);
  assert.equal(aliasIn("PICU", "ICU"), false);
  assert.equal(aliasIn("medical record", "ED"), false);
  assert.equal(aliasIn("ED visit", "ED"), true);
  assert.equal(aliasIn("轉 ICU 觀察", "ICU"), true);
  assert.equal(aliasIn("OPD follow-up", "OPD"), true);
  assert.equal(aliasIn("Emergency Department Record", "emergency department"), true);
  assert.equal(aliasIn("discharged home", "discharge"), true);
  assert.deepStrictEqual(departmentKeysOf("Emergency medicine"), ["emergency"]);
  assert.deepStrictEqual(departmentKeysOf("急診醫學科"), ["emergency"]);
  assert.deepStrictEqual(departmentKeysOf("神經內科"), ["neurology"]);
  assert.ok(departmentKeysOf("心臟血管內科").includes("cardio"));
});

test("issue 3: the instruction line never lends header/label lines to another line's window", async () => {
  // instruction first, then a body line without any department word: no support from the instruction line
  const text = ["【轉換目標】請將本次急診就診轉換為 Patient 與 Encounter", "Visit record", "姓名：王大明　性別：男　出生日期：1960/03/02", "Visit date：115.09.27 01:48", "Disposition：06:10 離院"].join("\n");
  const out = await run({ bundle: bundle(patient(), encounter("2026-09-27T01:48:00+08:00", "2026-09-27T06:10:00+08:00", serviceType)), source_text: text });
  assert.deepStrictEqual(errorsAt(out, "serviceType"), ["G-CONTEXT-INSTRUCTION"]);
});

// ------------------------------------------------------------------------------------------------ issue 4
test("issue 4: NHI payment code with a Chinese-only display is matched through the zh/en bridge (09140C ~ 'Glucose PC 2h')", async () => {
  const text = "門診檢驗報告\n姓名：王大明　性別：男　出生日期：1960/03/02\n採檢日期：115/09/27\nLab:\nGlucose PC 2h：182 mg/dL\nHbA1c：7.8 %";
  const out = await run({ bundle: bundle(patient(), glucoseObs("09140C", "Glucose PC 2h")), source_text: text });
  assert.deepStrictEqual(errorsAt(out, ".code"), []);
  assert.deepStrictEqual(errorsAt(out, "valueQuantity"), []);
  assert.equal(nameSimilarity("飯後血糖 182 mg/dL", "血液及體液葡萄糖-餐後"), 1);
});

test("issue 4 negative: NHI code with unrelated evidence -> G-CODING-UNRELATED; fasting vs post-prandial is not a match", async () => {
  const out = await run({
    mode: "strict",
    evidence_map: [{ path: "Bundle.entry[0].resource.code", quote: "Creatinine：1.2 mg/dL" }],
    bundle: bundle(glucoseObs("09140C", "Glucose PC 2h")),
    source_text: "門診檢驗報告\n採檢日期：115/09/27\nLab:\nCreatinine：1.2 mg/dL",
  });
  assert.deepStrictEqual(errorsAt(out, ".code"), ["G-CODING-UNRELATED"]);
  assert.ok(nameSimilarity("Glucose AC 108 mg/dL", "血液及體液葡萄糖-餐後") < 0.5);
  assert.ok(nameSimilarity("Glucose PC 182 mg/dL", "血液及體液葡萄糖-空腹") < 0.5);
  // a mostly untranslated Chinese name is not compared through the bridge at all
  assert.equal(nameSimilarity("right ankle sprain", "右側踝部韌帶扭傷之初期照護"), nameSimilarity("x", "右側踝部韌帶扭傷之初期照護"));
});
