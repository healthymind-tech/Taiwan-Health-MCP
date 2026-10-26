/**
 * Record checks ISSUES_v15.4 (empty shells: a resource without its primary value, the absence explained in a side
 * field; absence predicate classes; false-positive control) — synthetic data only.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { IN_RECORD, inBundle } from "../../scripts/record-checks-eval/synthetic151.js";
import { syntheticV154Cases } from "../../scripts/record-checks-eval/synthetic154.js";
import { addRecordChecksToValidation } from "./envelope.js";
import { runRecordChecks } from "./index.js";
import { absenceClauses, absenceOf, dataAbsentTier } from "./lexicon.js";

type Json = Record<string, any>;
const R = IN_RECORD;
const LOINC = "http://loinc.org";
const DAR = "http://terminology.hl7.org/CodeSystem/data-absent-reason";
const P = { reference: "urn:uuid:7c1e0d52-0000-4000-8000-000000000001" };

const classes = (t: string, result = false): string[] => absenceClauses(t, { result }).map((h) => h.cls);

function withObs(extra: Json, code = ["2823-3", "Potassium [Moles/volume] in Serum or Plasma", "鉀"], status = "final"): Json {
  const b = inBundle();
  b.entry.push({ fullUrl: "urn:uuid:7c1e0d52-0000-4000-8000-000000000900", resource: { resourceType: "Observation", status, code: { coding: [{ system: LOINC, code: code[0], display: code[1] }], text: code[2] }, subject: P, ...extra } });
  return b;
}
const onShell = (b: Json, sourceText: string | null): string[] =>
  runRecordChecks(b, { sourceText }).issues.filter((i) => i.path.startsWith(`Bundle.entry[${b.entry.length - 1}]`)).map((i) => `${i.severity}:${i.code}`);
const recordWith = (line: string): string => R.replace("血糖：", `${line}\n血糖：`);

test("v15.4 synthetic dev set: ≥ 40 shells detected (error with a record, warning without); ≥ 25 complete controls get no error", () => {
  const cases = syntheticV154Cases();
  const pos = cases.filter((c) => c.expect);
  assert.ok(pos.length >= 40, `dev set has ${pos.length} shells`);
  for (const c of pos) {
    const on = runRecordChecks(c.bundle, { sourceText: c.source_text }).issues.filter((i) => i.path.startsWith(`Bundle.entry[${c.entry}]`));
    const hit = on.some((i) => (i.code === "information-absent" || i.code === "unconfirmed-as-confirmed") && (c.expect === "warning" || i.severity === "error"));
    assert.ok(hit, `${c.id}: ${on.map((i) => `${i.severity} ${i.code}`).join(", ")}`);
    if (c.expect === "warning") assert.ok(!on.some((i) => i.severity === "error"), `${c.id}: warning expected`);
  }
  const ctl = cases.filter((c) => !c.expect);
  assert.ok(ctl.length >= 25);
  for (const c of ctl) {
    const errs = runRecordChecks(c.bundle, { sourceText: c.source_text }).issues.filter((i) => i.severity === "error");
    assert.equal(errs.length, 0, `${c.id}: ${errs.map((i) => i.message_en).join(" | ")}`);
  }
});

test("predicate classes: pending / rejected / machine error / undecided / indistinguishable / conditional / not-done", () => {
  assert.ok(classes("外送檢驗所，報告尚未回傳").includes("pending-result"));
  assert.deepEqual(classes("報告尚未回傳"), ["pending-result"]);
  assert.ok(classes("result not back yet").includes("pending-result"));
  assert.deepEqual(classes("尿量不足，檢驗科退件"), ["rejected-specimen", "rejected-specimen"]);
  assert.ok(classes("Specimen rejected - QNS").includes("rejected-specimen"));
  assert.ok(classes("機器顯示 Err-3").includes("machine-error"));
  assert.ok(classes("glucometer error, no reading").includes("machine-error"));
  assert.deepEqual(classes("Dose undecided"), ["undecided"]);
  assert.ok(classes("劑量待主治醫師決定").includes("undecided"));
  assert.deepEqual(classes("支氣管炎與早期肺炎尚難區分"), ["indistinguishable"]);
  assert.ok(classes("cannot differentiate bronchitis from pneumonia").includes("indistinguishable"));
  assert.ok(classes("每次劑量要看 Cr 報告").includes("conditional-on-future-result"));
  assert.ok(classes("depending on the trough level result").includes("conditional-on-future-result"));
  assert.deepEqual(classes("本次未做 X 光"), ["not-done"]);
  assert.deepEqual(classes("Patient declined"), ["not-done"]);
  // specimen conditions are absence only in a result slot (血清外觀：溶血 is a result)
  assert.deepEqual(classes("溶血"), []);
  assert.deepEqual(classes("溶血", true), ["rejected-specimen"]);
  assert.equal(dataAbsentTier("temp-unknown"), "absent");
  assert.equal(dataAbsentTier("not-performed"), "not-done");
});

test("dominance rule: negations, results, monitoring and unknown-cause clauses are not absence statements", () => {
  for (const t of ["無溶血", "no hemolysis noted", "未發現異常", "陰性，檢體輕微溶血", "依血糖調整 (sliding scale)", "Ceftriaxone 2 g IV qd，依醫囑", "社區型肺炎", "慢性腎病，追蹤中", "腹痛，原因不明", "Abdominal pain, unknown etiology", "未定期追蹤", "2 週後回診", "血壓 132/84 mmHg"]) {
    assert.deepEqual(classes(t, true), [], t);
  }
  // a bracketed limit is not a result: the whole valueString is absent
  assert.ok(absenceOf("檢體溶血，未發報 (< 14)", false, { result: true, limits: true }));
  assert.equal(absenceOf("檢體溶血，未發報 (< 14)", false, { result: true }), null);
  assert.ok(classes("檢體溶血，未發報 (< 14)", true).length >= 1);
});

test("Observation shell: error when the record says the item is not out; warning without a record or when the record is silent", () => {
  const b = withObs({ note: [{ text: "檢體溶血，不予發報" }] });
  assert.deepEqual(onShell(b, recordWith("鉀：檢體溶血，不予發報")), ["error:information-absent"]);
  const iss = runRecordChecks(b, { sourceText: recordWith("鉀：檢體溶血，不予發報") }).issues.find((i) => i.path.endsWith("note[0].text"))!;
  assert.match(iss.message_zh, /這筆資源沒有提供病歷中應有的值；病歷寫的是「鉀：檢體溶血，不予發報」/u);
  assert.match(iss.message_zh, /請回報 insufficient_information，不要建立空的資源/u);
  assert.deepEqual(iss.located_quotes, ["鉀：檢體溶血，不予發報"]);
  // a non-quantitative item (no v15.3 result-slot rule): the empty-shell matrix alone
  const c = withObs({ note: [{ text: "報告尚未回傳" }] }, ["630-4", "Bacteria identified in Urine by Culture", "尿液培養"]);
  assert.deepEqual(onShell(c, null), ["warning:information-absent"]);
  assert.deepEqual(onShell(c, R), ["warning:information-absent"]);
  assert.deepEqual(onShell(c, recordWith("尿液培養：報告尚未回傳")), ["error:information-absent"]);
  // the record names the item with a value: neutral → warning, never error
  const d = withObs({ note: [{ text: "報告尚未回傳" }] }, ["600-7", "Bacteria identified in Blood by Culture", "血液培養"]);
  assert.deepEqual(onShell(d, recordWith("血液培養：Staphylococcus aureus 3+")), ["warning:information-absent"]);
});

test("dataAbsentReason: evidence with a record; alone and without a record nothing (byte identity)", () => {
  const b = withObs({ dataAbsentReason: { coding: [{ system: DAR, code: "temp-unknown" }] } }, ["1988-5", "C reactive protein [Mass/volume] in Serum or Plasma", "CRP"]);
  assert.deepEqual(onShell(b, R.replace("CRP 8.2 mg/dL", "CRP 報告未出")), ["error:information-absent"]);
  assert.deepEqual(onShell(b, R), []);
  assert.deepEqual(onShell(b, null), []);
  const text = JSON.stringify({ ok: true, data: { valid: true, issues: [], entries: b.entry.map(() => ({ valid: true, issues: [] })) }, warnings: [] });
  assert.equal(addRecordChecksToValidation(text, b, {}), text);
});

test("legitimate no-value Observations: panels, cancelled not-done, entered-in-error, not-done tests (warning at most)", () => {
  const panel = withObs({ hasMember: [{ reference: "urn:uuid:7c1e0d52-0000-4000-8000-000000000006" }], note: [{ text: "部分項目待報告" }] }, ["58410-2", "CBC panel - Blood by Automated count", "CBC"]);
  assert.deepEqual(onShell(panel, R), []);
  const xr = ["36643-5", "XR Chest 2 Views", "胸部X光"];
  assert.deepEqual(onShell(withObs({ dataAbsentReason: { coding: [{ system: DAR, code: "not-performed" }] }, note: [{ text: "本次未做 X 光" }] }, xr, "cancelled"), recordWith("本次未做 X 光")), []);
  assert.deepEqual(onShell(withObs({ note: [{ text: "本次未做 X 光" }] }, xr), recordWith("本次未做 X 光")), ["warning:information-absent"]);
  assert.deepEqual(onShell(withObs({ note: [{ text: "本次未做 X 光" }] }, xr), null), []);
  assert.deepEqual(onShell(withObs({ note: [{ text: "pending" }] }, undefined, "entered-in-error"), recordWith("鉀：pending")), []);
  assert.deepEqual(onShell(withObs({ note: [{ text: "Patient declined" }] }), recordWith("鉀：patient declined")), ["warning:information-absent"]);
});

test("medication shells: no structured dose / timing + an undecided / conditional dose text; structured doses and sliding scales are fine", () => {
  const med = (dosage: Json[], extra: Json = {}): Json => {
    const b = inBundle();
    b.entry[8].resource.dosageInstruction = dosage;
    Object.assign(b.entry[8].resource, extra);
    return b;
  };
  const rx = (line: string): string => R.replace("處方：Ceftriaxone 2 g 靜脈注射 每日一次 7 天", line);
  const at8 = (b: Json, st: string | null): string[] => runRecordChecks(b, { sourceText: st }).issues.filter((i) => i.path.startsWith("Bundle.entry[8]")).map((i) => `${i.severity}:${i.code}`);
  assert.deepEqual(at8(med([{ text: "每次劑量與頻次要看 Cr 報告（已抽，未回）" }]), rx("處方：Ceftriaxone，每次劑量與頻次要看 Cr 報告（已抽，未回）")), ["error:information-absent"]);
  assert.deepEqual(at8(med([{ text: "依腎功能調整", doseAndRate: [{ doseQuantity: { value: 2, unit: "g" } }] }]), R), []);
  assert.deepEqual(at8(med([{ text: "依醫囑", timing: { repeat: { frequency: 1, period: 1, periodUnit: "d" } } }]), R), []);
  assert.deepEqual(at8(med([{ text: "sliding scale，依血糖調整" }]), rx("處方：Ceftriaxone sliding scale，依血糖調整")), []);
  assert.deepEqual(at8(med([], { note: [{ text: "Dose undecided, pending morning blood glucose" }] }), null), ["warning:information-absent"]);
});

test("Condition shells: text-only 'cannot tell apart' → error; named hedge written provisional and unknown-cause symptoms → nothing", () => {
  const dxText = (text: string, vs?: string): Json => {
    const b = inBundle();
    b.entry[2].resource.code = { text };
    if (vs) b.entry[2].resource.verificationStatus = { coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-ver-status", code: vs }] };
    else delete b.entry[2].resource.verificationStatus;
    return b;
  };
  const slot = (line: string): string => R.replace("診斷：社區型肺炎 (J18.9)", line);
  const at2 = (b: Json, st: string | null): string[] => runRecordChecks(b, { sourceText: st }).issues.filter((i) => i.path.startsWith("Bundle.entry[2]")).map((i) => `${i.severity}:${i.code}`);
  assert.deepEqual(at2(dxText("支氣管炎與早期肺炎尚難區分"), slot("Dx：支氣管炎與早期肺炎尚難區分")), ["error:information-absent"]);
  assert.deepEqual(at2(dxText("社區型肺炎（待確認）", "provisional"), slot("診斷：社區型肺炎（待確認）")), []);
  assert.deepEqual(at2(dxText("腹痛，原因不明"), slot("診斷：腹痛，原因不明")), []);
  assert.deepEqual(at2(dxText("社區型肺炎"), R), []);
  // a coded established Condition against a slot whose candidates cannot be told apart
  const b = inBundle();
  b.entry[2].resource.code = { coding: [{ system: "http://hl7.org/fhir/sid/icd-10-cm", code: "J20.9", display: "Acute bronchitis, unspecified" }], text: "急性支氣管炎" };
  assert.ok(at2(b, slot("Dx：急性支氣管炎與早期肺炎尚難區分")).includes("error:unconfirmed-as-confirmed"));
});
