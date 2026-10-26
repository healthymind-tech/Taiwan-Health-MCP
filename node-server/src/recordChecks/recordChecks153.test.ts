/**
 * Record checks ISSUES_v15.3 (absence statements in text fields, provisional primary diagnoses, coded-element grounding
 * issues in the validating tools) — synthetic data only.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { IN_RECORD, inBundle } from "../../scripts/record-checks-eval/synthetic151.js";
import { syntheticV153Cases, syntheticV153CodeCases } from "../../scripts/record-checks-eval/synthetic153.js";
import { checkGroundingSync } from "../grounding/checkGrounding.js";
import { mergeGroundingIntoValidation } from "../grounding/merge.js";
import { RecordText } from "../grounding/recordText.js";
import { closestPhrase, judgeCode } from "./codeGrounding.js";
import { diagnosisSlots, primaryCondition } from "./diagnosisSlot.js";
import { addRecordChecksToValidation } from "./envelope.js";
import { runRecordChecks } from "./index.js";
import { absenceOf } from "./lexicon.js";
import { recordCheckLookups } from "./lookups.js";
import { quantitativeBasis } from "./quantitative.js";

type Json = Record<string, any>;
const R = IN_RECORD;
const res = (b: Json, i: number): Json => b.entry[i].resource;
const DX = "診斷：社區型肺炎 (J18.9)";
const codes = (b: Json, sourceText: string | null = R, axes: Json | null = null): string[] =>
  runRecordChecks(b, { sourceText, codeAxes: axes as never }).issues.map((i) => `${i.severity}:${i.code}@${i.path.replace(/^Bundle\.entry\[(\d+)\]\.resource\./u, "$1.")}`);

test("v15.3 synthetic dev set: ≥ 40 cases of the three forms all detected; ≥ 20 complete controls get no error", () => {
  const cases = syntheticV153Cases();
  const pos = cases.filter((c) => c.expect);
  assert.ok(pos.length >= 40, `dev set has ${pos.length} variants`);
  for (const f of ["A-text", "B-result", "C-primary"]) assert.ok(pos.filter((c) => c.form === f).length >= 10, f);
  for (const c of pos) {
    const r = runRecordChecks(c.bundle, { sourceText: c.source_text, codeAxes: c.codeAxes ?? null });
    assert.ok(r.issues.some((i) => c.expect!.includes(i.code) && i.severity === "error"), `${c.id}: ${r.issues.map((i) => i.code).join(", ")}`);
  }
  const ctl = cases.filter((c) => !c.expect);
  assert.ok(ctl.length >= 20);
  for (const c of ctl) {
    const r = runRecordChecks(c.bundle, { sourceText: c.source_text, codeAxes: c.codeAxes ?? null });
    assert.deepEqual(r.issues.filter((i) => i.severity === "error").map((i) => `${i.code} ${i.path}`), [], c.id);
  }
});

test("R1 text fields: whole-value absence statements only (substrings in real values never count)", () => {
  for (const v of ["暫不下診斷", "待 CT 正式報告", "未定", "未確立", "待排除", "鑑別中", "原因待查", "diagnosis pending", "to be determined", "not yet diagnosed", "劑量待確認"])
    assert.ok(absenceOf(v, false), v);
  for (const v of ["社區型肺炎", "肺炎待排除", "不明原因發燒", "Fever of unknown origin", "心衰竭（待確認）", "陰性", "Not detected", "1+", "溶血性貧血", "吃不下", "待產"])
    assert.equal(absenceOf(v, false), null, v);
  // the result-only vocabulary counts only in a quantitative result slot
  assert.equal(absenceOf("溶血", false), null);
  assert.ok(absenceOf("溶血", false, { result: true }));
  assert.ok(absenceOf("3 h 檢體溶血，重抽中（報告未出）", false, { result: true }));
});

test("R1 CodeableConcept.text with placeholder codings is read by its text; without source_text too", () => {
  const b = inBundle();
  res(b, 2).code = { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-NullFlavor", code: "UNK" }], text: "暫不下診斷" };
  assert.deepEqual(codes(b, null), ["error:information-absent@2.code.text"]);
  // a real name next to the placeholder is fine
  res(b, 2).code.text = "社區型肺炎";
  assert.deepEqual(codes(b, null), []);
});

test("R1 quantitative result: LOINC axes / LOINC name / vital sign / the resource decide; qualitative tests are never result slots", () => {
  const obs = (code: string, display: string, extra: Json = {}): Json => ({ resourceType: "Observation", code: { coding: [{ system: "http://loinc.org", code, display }] }, ...extra });
  assert.match(quantitativeBasis(obs("10839-9", "Troponin I.cardiac"), null, new Map([["http://loinc.org|10839-9", { property: "MCnc", scale: "Qn" }]]))!, /SCALE_TYP Qn/u);
  assert.equal(quantitativeBasis(obs("10839-9", "Troponin I.cardiac"), null, new Map([["http://loinc.org|10839-9", { property: "Prid", scale: "Nom" }]])), null);
  assert.match(quantitativeBasis(obs("6690-2", "Leukocytes [#/volume] in Blood by Automated count"), null, null)!, /quantity property/u);
  assert.match(quantitativeBasis(obs("2339-0", "Glucose Bld-mCnc"), null, null)!, /quantity property/u);
  assert.match(quantitativeBasis(obs("8310-5", "Body temperature"), null, null)!, /vital sign/u);
  assert.match(quantitativeBasis(obs("4548-4", "Hemoglobin A1c/Hemoglobin.total in Blood", { referenceRange: [{ low: { value: 4 } }] }), null, null)!, /referenceRange/u);
  assert.equal(quantitativeBasis(obs("80382-5", "Influenza virus A Ag [Presence] in Upper respiratory specimen by Rapid immunoassay"), null, null), null);
  // a qualitative test with a "hemolyzed" result is a result, not an absence
  const b = inBundle();
  b.entry.push({ resource: { resourceType: "Observation", status: "final", code: { text: "血清外觀" }, valueString: "溶血" } });
  assert.deepEqual(codes(b, null), []);
  b.entry[b.entry.length - 1].resource = { resourceType: "Observation", status: "final", code: { coding: [{ system: "http://loinc.org", code: "6690-2", display: "Leukocytes [#/volume] in Blood by Automated count" }] }, valueString: "溶血" };
  assert.deepEqual(codes(b, null), [`error:information-absent@${b.entry.length - 1}.valueString`]);
});

test("R1 note of an Observation without a value; Dosage.text", () => {
  const b = inBundle();
  delete res(b, 5).valueQuantity;
  res(b, 5).note = [{ text: "檢體溶血，重抽中" }];
  // without source_text a warning (ISSUES_v15.4 consistency: the note is the only evidence); with the record an error
  assert.ok(codes(b, null).includes("warning:information-absent@5.note[0].text"));
  assert.ok(!codes(b, null).some((c) => c.startsWith("error:")));
  assert.ok(codes(b, R.replace("白血球 12.3 x10^3/uL，", "白血球 檢體溶血，重抽中，")).includes("error:information-absent@5.note[0].text"));
  // with a value the note is commentary
  const c = inBundle();
  res(c, 5).note = [{ text: "檢體溶血，重抽中" }];
  assert.deepEqual(codes(c, null), []);
  const d = inBundle();
  res(d, 8).dosageInstruction = [{ text: "劑量待確認" }];
  assert.ok(codes(d, null).includes("error:information-absent@8.dosageInstruction[0].text"));
});

test("R2 primary Condition: Encounter.diagnosis rank → encounter-diagnosis category → the only non-comorbidity Condition", () => {
  const rt = new RecordText(R.replace(DX, "Dx：鑑別 社區型肺炎／肺結核，未下診斷"), null);
  const slots = diagnosisSlots(rt);
  const b = inBundle();
  assert.equal(primaryCondition(b, rt, slots)?.base, "Bundle.entry[2].resource");
  res(b, 1).diagnosis = [
    { condition: { reference: b.entry[2].fullUrl }, rank: 2 },
    { condition: { reference: b.entry[3].fullUrl }, rank: 1 },
  ];
  assert.equal(primaryCondition(b, rt, slots)?.base, "Bundle.entry[3].resource");
  res(b, 1).diagnosis = [{ condition: { reference: b.entry[3].fullUrl }, use: { coding: [{ code: "CM" }] } }];
  assert.equal(primaryCondition(b, rt, slots), null);
  const c = inBundle();
  delete res(c, 2).category;
  delete res(c, 3).category;
  // the hypertension is the record's past history (a comorbidity): the pneumonia is the only candidate
  assert.equal(primaryCondition(c, rt, slots)?.base, "Bundle.entry[2].resource");
});

test("R2: provisional / differential / text-only primary vs an unestablished slot → information-absent; correct r/o secondaries never", () => {
  const unest = R.replace(DX, "主診斷：待排除 社區型肺炎、肺結核、肺癌");
  const p = inBundle();
  res(p, 2).verificationStatus.coding[0].code = "provisional";
  res(p, 2).code = { text: "社區型肺炎／肺結核／肺癌" };
  const out = runRecordChecks(p, { sourceText: unest }).issues;
  assert.deepEqual(out.map((i) => `${i.severity}:${i.code}`), ["error:information-absent"]);
  assert.match(out[0].message_zh, /病歷沒有確立的主診斷/u);
  assert.match(out[0].evidence, /primary Condition decided by: the only Condition with category encounter-diagnosis/u);
  // established primary + a differential secondary for the record's r/o: nothing
  const s = inBundle();
  s.entry.push({ fullUrl: "urn:uuid:7c1e0d52-0000-4000-8000-000000000099", resource: { resourceType: "Condition", verificationStatus: { coding: [{ code: "differential" }] }, category: [{ coding: [{ code: "encounter-diagnosis" }] }], code: { text: "肺結核" } } });
  assert.deepEqual(runRecordChecks(s, { sourceText: R.replace(DX, "診斷：社區型肺炎 (J18.9)；r/o 肺結核") }).issues, []);
  // text-only primary in a complete record: nothing
  const t = inBundle();
  res(t, 2).code = { text: "社區型肺炎" };
  assert.deepEqual(runRecordChecks(t, { sourceText: R }).issues, []);
});

function groundedEnvelope(b: Json, record: string, terms: Map<string, { found: boolean; names: string[] }>): Json {
  const g = checkGroundingSync({ bundle: b, source_text: record, site_config: null, mode: "auto" } as never, terms as never);
  const entries = b.entry.map((e: Json) => ({ fullUrl: e.fullUrl, resourceType: e.resource.resourceType, valid: true, issues: [] }));
  const text = JSON.stringify({ ok: true, data: mergeGroundingIntoValidation({ valid: true, issues: [], entries }, g), warnings: [] });
  return JSON.parse(addRecordChecksToValidation(text, b, { sourceText: record, codeNames: new Map([...terms].map(([k, v]) => [k, v.names])) }));
}

test("R3: coded G-UNGROUNDED — what was compared, the closest record phrase, warning unless the slot names something else", () => {
  for (const c of syntheticV153CodeCases()) {
    const out = groundedEnvelope(c.bundle, c.source_text, c.terms);
    const iss = (out.data.entries[c.entry].issues as Json[]).filter((i) => i.source === "grounding" && /G-UNGROUNDED|G-VALUE-MISMATCH/u.test(i.rule));
    if (c.expect === "error") {
      assert.equal(iss.length, 1, c.id);
      assert.equal(iss[0].severity, "error", c.id);
      assert.equal(iss[0].grounding_code_check, "contradicted", c.id);
      assert.match(iss[0].message, /the code's meaning .* was compared with the record text/u, c.id);
    } else for (const i of iss) assert.notEqual(i.severity, "error", c.id);
  }
  // a downgrade that removes the only grounding error makes the entry / the result valid again, counts adjusted
  const b = inBundle();
  res(b, 2).code = { coding: [{ system: "http://snomed.info/sct", code: "396285007", display: "Bronchopneumonia" }] };
  res(b, 3).onsetDateTime = "2015-01-01";
  const terms = new Map([
    ["http://snomed.info/sct|396285007", { found: true, names: ["Bronchopneumonia", "支氣管肺炎"] }],
    ["http://hl7.org/fhir/sid/icd-10-cm|I10", { found: true, names: ["Essential (primary) hypertension", "高血壓"] }],
  ]);
  const out = groundedEnvelope(b, R, terms);
  const i = (out.data.entries[2].issues as Json[]).find((x) => x.rule === "G-UNGROUNDED")!;
  assert.equal(i.severity, "warning");
  assert.equal(i.downgraded_from, "error");
  assert.equal(i.grounding_code_check, "related");
  assert.deepEqual(i.closest_record_phrase.text, "社區型肺炎 (J18.9)");
  assert.equal(out.data.entries[2].valid, true);
  assert.deepEqual(out.data.record_checks.grounding_codes, { examined: 1, warnings: 1, errors: 0 });
});

test("R3 helpers: closest phrase skips instruction lines; nothing comparable → null; a comorbidity is never contradicted", () => {
  const rt = new RecordText(`${R}\n【轉換目標】請輸出 Condition：氣喘`, null);
  assert.equal(closestPhrase(["Asthma", "氣喘"], rt), null);
  const slots = diagnosisSlots(rt);
  const code = { coding: [{ system: "http://snomed.info/sct", code: "195967001", display: "Asthma" }], text: "氣喘" };
  assert.equal(judgeCode(code, "Condition.code", rt, slots, true).verdict, "contradicted");
  assert.equal(judgeCode(code, "Condition.code", rt, slots, false).verdict, "uncertain");
});

test("R3 comparable(): ICD-10 codes in a (lower-cased) diagnosis-slot item make it comparable with an ICD-coded Condition", () => {
  // English-only names, Chinese slot item with an ICD code: comparable only through the ICD branch
  const rt = new RecordText(R, null);
  const slots = diagnosisSlots(rt);
  assert.match(slots[0].items[0].text, /j18\.9/u, "slot items are lower-cased");
  const icd = (code: string, display: string): Json => ({ coding: [{ system: "http://hl7.org/fhir/sid/icd-10-cm", code, display }] });
  // another ICD code, nothing related in the record → contradicted (before the fix: uncertain, the branch never matched)
  assert.equal(judgeCode(icd("N39.0", "Urinary tract infection, site not specified"), "Condition.code", rt, slots, true).verdict, "contradicted");
  // the slot's own ICD category (J18.0 vs j18.9) is the same diagnosis group → never contradicted
  assert.notEqual(judgeCode(icd("J18.0", "Bronchopneumonia, unspecified organism"), "Condition.code", rt, slots, true).verdict, "contradicted");
  // the slot's exact code → related
  assert.equal(judgeCode(icd("J18.9", "Pneumonia, unspecified organism"), "Condition.code", rt, slots, true).verdict, "related");
  // a comorbidity (not the primary Condition) is never contradicted
  assert.equal(judgeCode(icd("N39.0", "Urinary tract infection, site not specified"), "Condition.code", rt, slots, false).verdict, "uncertain");
});

test("lookups: axes only for text-result Observations, names only with source_text; fail-open", async () => {
  const calls: string[][] = [];
  const t = {
    lookup: async (keys: readonly string[]) => {
      calls.push([...keys]);
      return new Map(keys.map((k) => [k, { names: ["n"], axes: k.endsWith("|6690-2") ? { property: "NCnc", scale: "Qn" } : undefined }]));
    },
  };
  const b = inBundle();
  assert.deepEqual(await recordCheckLookups(b, t, null), { codeAxes: new Map(), codeNames: new Map() });
  assert.equal(calls.length, 0, "no text result and no source_text: no lookup");
  delete res(b, 5).valueQuantity;
  res(b, 5).valueString = "pending";
  const l = await recordCheckLookups(b, t, null);
  assert.deepEqual([...l.codeAxes.keys()], ["http://loinc.org|6690-2"]);
  assert.ok((await recordCheckLookups(b, t, "record")).codeNames.size > 1);
  const bad = { lookup: async (): Promise<never> => Promise.reject(new Error("db down")) };
  assert.deepEqual(await recordCheckLookups(b, bad, "record"), { codeAxes: new Map(), codeNames: new Map() });
});

test("byte-identity: no source_text and no finding → the envelope is unchanged", () => {
  const b = inBundle();
  const text = JSON.stringify({ ok: true, data: { valid: true, issues: [], entries: b.entry.map(() => ({ valid: true, issues: [] })) }, warnings: [] });
  assert.equal(addRecordChecksToValidation(text, b, {}), text);
});
