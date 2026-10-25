/**
 * Record checks ISSUES_v15.1 (value grounding, primary diagnosis slot, other time points) — synthetic data only.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { IN_RECORD, inBundle, syntheticV151Cases } from "../../scripts/record-checks-eval/synthetic151.js";
import { diagnosisSlots } from "./diagnosisSlot.js";
import { addRecordChecksToValidation } from "./envelope.js";
import { runRecordChecks } from "./index.js";
import { RecordText } from "../grounding/recordText.js";
import { RecordValues } from "./recordValues.js";

type Json = Record<string, any>;
const R = IN_RECORD;
const run = (b: Json, sourceText: string = R, siteConfig: string | null = null) => runRecordChecks(b, { sourceText, siteConfig }).issues;
const codes = (b: Json, sourceText: string = R, siteConfig: string | null = null): string[] => run(b, sourceText, siteConfig).map((i) => `${i.severity}:${i.code}`);
const at = (b: Json, path: string, sourceText: string = R) => run(b, sourceText).filter((i) => i.path.startsWith(path));
const res = (b: Json, i: number): Json => b.entry[i].resource;
const rep = (from: string, to: string, base = R): string => {
  assert.ok(base.includes(from), from);
  return base.split(from).join(to);
};

test("v15.1 synthetic dev set: ≥ 80 missing-information variants, ≥ 90 % detected; complete controls get no error", () => {
  const cases = syntheticV151Cases();
  const pos = cases.filter((c) => c.expect);
  assert.ok(pos.length >= 80, `dev set has ${pos.length} variants`);
  for (const cls of ["identity", "date", "quantity", "medication", "diagnosis", "structure", "other-time-point"]) assert.ok(pos.some((c) => c.cls === cls), cls);
  const missed = pos.filter((c) => !run(c.bundle, c.source_text, c.site_config).some((i) => c.expect!.codes.includes(i.code) && (c.expect!.severity === "warning" || i.severity === "error")));
  assert.ok(missed.length / pos.length <= 0.1, `missed: ${missed.map((c) => c.id).join(", ")}`);
  for (const c of cases.filter((x) => !x.expect)) assert.deepEqual(run(c.bundle, c.source_text, c.site_config).filter((i) => i.severity === "error"), [], c.id);
});

test("R5 identifiers: a made-up number is ungrounded; separators / case / site_config are normalised", () => {
  const b = inBundle();
  res(b, 0).identifier[1].value = "I115051002";
  const [i] = at(b, "Bundle.entry[0].resource.identifier[1]");
  assert.equal(i.code, "ungrounded-value");
  assert.equal(i.rule, "R5");
  assert.match(i.message_zh, /病歷中找不到這個值/u);
  assert.match(i.evidence, /searched in \d+ record line/u);
  const ok = inBundle();
  res(ok, 0).identifier[1].value = "0045-1234";
  res(ok, 0).identifier[0].value = "b120345673";
  assert.deepEqual(codes(ok), []);
  const org = inBundle();
  org.entry.push({ resource: { resourceType: "Organization", identifier: [{ value: "1101010012" }] } });
  assert.deepEqual(codes(org, R, "醫事機構代碼：1101010012"), []);
  assert.deepEqual(codes(org), ["error:ungrounded-value"]);
});

test("R1 stated absence: 病歷號：申請中 + a made-up number → information-absent; the number of another field → value-from-other-event", () => {
  const b = inBundle();
  res(b, 0).identifier[1].value = "I115051002";
  const [i] = at(b, "Bundle.entry[0].resource.identifier[1]", rep("病歷號：00451234", "病歷號：申請中"));
  assert.equal(i.code, "information-absent");
  assert.match(i.message_zh, /病歷沒有提供這項資訊/u);
  assert.deepEqual(i.located_quotes, ["身分證字號：B120345673　病歷號：申請中"]);
  const o = inBundle();
  res(o, 0).identifier[1].value = "IP115-030417";
  assert.deepEqual(at(o, "Bundle.entry[0].resource.identifier[1]", rep("病歷號：00451234", "住院號：IP115-030417")).map((x) => x.code), ["value-from-other-event"]);
  // a label that only starts like a known one is another field (出生地 is not 出生日期)
  assert.deepEqual(codes(inBundle(), rep("性別：男", "性別：男　出生地：不詳")), []);
});

test("R1 identifier with a system but no value: information-absent, or incomplete-value when the record has the number", () => {
  const b = inBundle();
  res(b, 0).identifier[0] = { system: "http://www.moi.gov.tw" };
  assert.deepEqual(at(b, "Bundle.entry[0].resource.identifier[0]", rep("身分證字號：B120345673　", "")).map((i) => `${i.severity}:${i.code}`), ["error:information-absent"]);
  const has = at(b, "Bundle.entry[0].resource.identifier[0]");
  assert.equal(has[0].code, "incomplete-value");
  assert.match(has[0].message_zh, /B120345673/u);
  // without source_text nothing new (byte identity of the conformance-only output)
  assert.deepEqual(runRecordChecks(b, {}).issues, []);
});

test("R5 dates: fabricated dates and filled-in T00:00:00 are ungrounded; date-only values and derivations are grounded", () => {
  const noLabDate = rep("檢驗（2025/06/11 07:00 採檢）：", "檢驗：");
  for (const v of ["2026-01-01", "2022-01-02"]) {
    const b = inBundle();
    res(b, 5).effectiveDateTime = v;
    assert.deepEqual(at(b, "Bundle.entry[5]", noLabDate).map((i) => i.code), ["ungrounded-value"], v);
  }
  const t0 = inBundle();
  res(t0, 1).period.start = "2025-06-10T00:00:00+08:00";
  res(t0, 4).effectiveDateTime = "2025-06-10";
  const [m] = at(t0, "Bundle.entry[1]", rep("入院日期：2025/06/10 14:30", "入院日期：2025/06/10"));
  assert.equal(m.code, "ungrounded-value");
  assert.match(m.message_zh, /00:00 是補上的/u);
  const only = inBundle();
  res(only, 1).period.start = "2025-06-10";
  res(only, 4).effectiveDateTime = "2025-06-10";
  assert.deepEqual(codes(only, rep("入院日期：2025/06/10 14:30", "入院日期：2025/06/10")), []);
  // 入院第3天 + the admission date; POD#2 + the operation date; 三天前 + the visit; ROC dates; a Z time in the site timezone
  const hd = inBundle();
  res(hd, 7).effectiveDateTime = "2025-06-12";
  assert.deepEqual(codes(hd, rep("06/11 11:00 142 mg/dL", "入院第3天 142 mg/dL")), []);
  const onset = inBundle();
  res(onset, 2).onsetDateTime = "2025-06-07";
  assert.deepEqual(codes(onset), []);
  const z = inBundle();
  res(z, 1).period.start = "2025-06-10T06:30:00Z";
  assert.deepEqual(codes(z, rep("入院日期：2025/06/10 14:30", "入院日期：114/06/10 下午2點30分")), []);
  // a record-keeping time (authoredOn) not in the record is a warning only
  const adm = inBundle();
  res(adm, 8).authoredOn = "2025-07-01";
  assert.deepEqual(codes(adm), ["warning:ungrounded-value"]);
});

test("R5 / R4 dates of another event: a past visit date, or the visit date where the record says the specimen date is unreadable", () => {
  const b = inBundle();
  res(b, 5).effectiveDateTime = "2025-03-02";
  assert.deepEqual(at(b, "Bundle.entry[5]", rep("檢驗（2025/06/11 07:00 採檢）：", "上次住院 2025/03/02 因氣喘。\n檢驗：")).map((i) => i.code), ["value-from-other-event"]);
  const s = inBundle();
  res(s, 5).effectiveDateTime = "2025-06-10";
  const [i] = at(s, "Bundle.entry[5]", rep("檢驗（2025/06/11 07:00 採檢）：", "採檢日期：標籤字跡模糊無法辨識\n檢驗："));
  assert.equal(i.code, "value-from-other-event");
  assert.match(i.message_zh, /屬於另一個時間點/u);
});

test("R5 quantities: 0 / placeholders / made-up values are ungrounded; unit conversion, BMI and explicit products are grounded", () => {
  const z = inBundle();
  res(z, 4).valueQuantity.value = 0;
  const [q] = at(z, "Bundle.entry[4]", rep("體溫 38.6°C，", ""));
  assert.equal(q.code, "ungrounded-value");
  assert.match(q.message_zh, /佔位值/u);
  // a 0 is never grounded by a time (08:00) or a date
  const t = inBundle();
  res(t, 4).valueQuantity.value = 0;
  assert.equal(at(t, "Bundle.entry[4]", rep("體溫 38.6°C，", "08:00 體溫測量，")).length, 1);
  const h = inBundle();
  h.entry.push({ resource: { resourceType: "Observation", code: { coding: [{ system: "http://loinc.org", code: "8302-2" }], text: "身高" }, valueQuantity: { value: 1.75, unit: "m", code: "m" } } });
  h.entry.push({ resource: { resourceType: "Observation", code: { coding: [{ system: "http://loinc.org", code: "39156-5" }], text: "BMI" }, valueQuantity: { value: 23.5, unit: "kg/m2", code: "kg/m2" } } });
  assert.deepEqual(codes(h), []);
  const p = inBundle();
  res(p, 8).dosageInstruction[0].doseAndRate[0].doseQuantity = { value: 1000, unit: "mg", code: "mg" };
  assert.deepEqual(codes(p, rep("Ceftriaxone 2 g 靜脈注射", "Ceftriaxone 500 mg x 2 支 靜脈注射")), []);
  // a doubled dose is not grounded by "2" written elsewhere on the line (no implicit products)
  const d = inBundle();
  res(d, 8).dosageInstruction[0].doseAndRate[0].doseQuantity.value = 4;
  assert.deepEqual(codes(d), ["error:ungrounded-value"]);
  // a stated failed measurement
  const f = inBundle();
  res(f, 5).valueQuantity.value = 0;
  assert.deepEqual(at(f, "Bundle.entry[5]", rep("白血球 12.3 x10^3/uL，", "白血球 檢體溶血、未發報告，")).map((i) => i.code), ["information-absent"]);
});

test("R4 another time point: the second reading written for the failed first one → error; swapped readings → warning", () => {
  const b = inBundle();
  res(b, 6).valueQuantity.value = 142;
  const [e] = at(b, "Bundle.entry[6]", rep("06/11 07:00 156 mg/dL", "06/11 07:00 機器錯誤，未得數值"));
  assert.equal(`${e.severity}:${e.code}`, "error:value-from-other-event");
  assert.match(e.message_zh, /另一次測量/u);
  const s = inBundle();
  res(s, 6).valueQuantity.value = 142;
  res(s, 7).valueQuantity.value = 156;
  assert.deepEqual(codes(s), ["warning:value-from-other-event", "warning:value-from-other-event"]);
});

test("R4 primary diagnosis slot: differential / pending slots make an established Condition an error", () => {
  const dx = (line: string): string => rep("診斷：社區型肺炎 (J18.9)", line);
  const cond = (code: string, display: string, text?: string): Json => {
    const b = inBundle();
    res(b, 2).code = { coding: [{ system: "http://hl7.org/fhir/sid/icd-10-cm", code, display }], ...(text ? { text } : {}) };
    return b;
  };
  const err = (b: Json, rec: string): string[] => at(b, "Bundle.entry[2]", rec).map((i) => `${i.severity}:${i.code}`);
  const ddx = dx("Dx：鑑別 流感／COVID-19／RSV 感染，未下診斷");
  assert.deepEqual(err(cond("J10.1", "Influenza", "流感"), ddx), ["error:unconfirmed-as-confirmed"]);
  assert.deepEqual(err(cond("R50.9", "Fever, unspecified", "發燒"), ddx), ["error:unconfirmed-as-confirmed"]);
  assert.deepEqual(err(cond("J06.9", "Acute upper respiratory infection", "上呼吸道感染"), ddx), ["error:unconfirmed-as-confirmed"]);
  const copy = inBundle();
  res(copy, 2).code = { text: "流感／COVID-19／RSV 感染" };
  assert.match(at(copy, "Bundle.entry[2]", ddx)[0].evidence, /copies the record's/u);
  assert.deepEqual(err(cond("J10.1", "Influenza", "流感"), dx("診斷：快篩結果出來前不下診斷")), ["error:unconfirmed-as-confirmed"]);
  // the comorbidity from the past history (entry 3) is never reported
  assert.deepEqual(at(cond("J10.1", "Influenza", "流感"), "Bundle.entry[3]", ddx), []);
  // provisional / differential Conditions are fine
  const prov = cond("J10.1", "Influenza", "流感");
  res(prov, 2).verificationStatus.coding[0].code = "differential";
  assert.deepEqual(err(prov, ddx), []);
});

test("R5 (false positive): a cue inside a bracket that names another concept scopes over that concept only", () => {
  const b = inBundle();
  res(b, 2).code = { coding: [{ system: "http://hl7.org/fhir/sid/icd-10-cm", code: "R97.20", display: "Elevated prostate specific antigen [PSA]" }], text: "Elevated PSA" };
  assert.deepEqual(codes(b, rep("診斷：社區型肺炎 (J18.9)", "A：Elevated PSA（未確立惡性腫瘤）")), []);
  // the concept inside the bracket written as an established Condition is still an error
  const m = inBundle();
  res(m, 2).code = { coding: [{ system: "http://hl7.org/fhir/sid/icd-10-cm", code: "C61", display: "Malignant neoplasm of prostate" }], text: "惡性腫瘤" };
  assert.deepEqual(at(m, "Bundle.entry[2]", rep("診斷：社區型肺炎 (J18.9)", "A：Elevated PSA（未確立惡性腫瘤）")).map((i) => i.code), ["unconfirmed-as-confirmed"]);
  // a bracket holding only the cue qualifies its host
  const slots = diagnosisSlots(new RecordText("主訴：咳嗽\n診斷：肺炎（待排除）、氣喘", null));
  assert.deepEqual(slots[0].items.map((i) => [i.core, i.strength]), [["肺炎", "explicit"], ["氣喘", null]]);
});

test("R4 no diagnosis in the record: a symptom from the complaint written as the encounter diagnosis → information-absent", () => {
  const b = inBundle();
  res(b, 2).code = { coding: [{ system: "http://hl7.org/fhir/sid/icd-10-cm", code: "R05.9", display: "Cough, unspecified" }], text: "咳嗽有痰" };
  assert.deepEqual(at(b, "Bundle.entry[2]", rep("診斷：社區型肺炎 (J18.9)\n", "")).map((i) => i.code), ["information-absent"]);
  assert.deepEqual(at(b, "Bundle.entry[2]", rep("診斷：社區型肺炎 (J18.9)", "診斷：")).map((i) => i.code), ["information-absent"]);
});

test("record value index: ROC / 中文 / English dates, Chinese numerals, relative expressions, numbers outside dates and times", () => {
  const rv = new RecordValues("就診：民國114年6月10日 下午兩點半\nAdmitted: 10-Jun-2025 14:30\n入院第三天抽血，體溫三十八度\n3/14 08:00 BP 120/80", null);
  for (const k of ["2025-06-10"]) assert.ok(rv.days.has(k), k);
  assert.ok(rv.timeKeys.has("14:30"));
  assert.ok(rv.derivedDays.has("2025-06-12"));
  assert.ok(rv.numbers.some((n) => n.value === 38));
  assert.ok(rv.numbers.some((n) => n.value === 120) && rv.numbers.some((n) => n.value === 80));
  assert.ok(!rv.numbers.some((n) => n.value === 0 || n.value === 10 || n.value === 6));
});

test("R6: a wrong ROC ↔ Gregorian conversion gets the record's date as replace_value (single → 0.95; several → all)", () => {
  const b = inBundle();
  res(b, 0).birthDate = "1983-08-25";
  const rec = rep("出生日期：民國60年5月3日", "出生日期：民國92年8月25日");
  const [i] = at(b, "Bundle.entry[0].resource.birthDate", rec);
  assert.equal(`${i.severity}:${i.code}`, "error:ungrounded-value");
  assert.equal(i.suggestions!.length, 1);
  const s = i.suggestions![0];
  assert.deepEqual([s.value, s.kind, s.confidence, s.patch], ["2003-08-25", "replace_value", 0.95, { op: "replace", path: "Bundle.entry[0].resource.birthDate", value: "2003-08-25" }]);
  assert.match(s.reason, /民國92年8月25日/u);
  assert.match(s.reason, /92\+1911/u);
  assert.match(i.message_zh, /正確值應為 2003-08-25/u);
  // 民國47年 written with +1912; the ROC year written as the Gregorian one; a time part is kept
  const b2 = inBundle();
  res(b2, 0).birthDate = "1959-06-20";
  assert.equal(at(b2, "Bundle.entry[0].resource.birthDate", rep("出生日期：民國60年5月3日", "出生日期：民國47年6月20日"))[0].suggestions![0].value, "1958-06-20");
  const b3 = inBundle();
  res(b3, 1).period.start = "0114-06-10T14:30:00+08:00";
  const s3 = at(b3, "Bundle.entry[1].resource.period.start", rep("入院日期：2025/06/10 14:30", "入院日期：114/06/10 14:30"))[0].suggestions![0];
  assert.equal(s3.value, "2025-06-10T14:30:00+08:00");
  assert.match(s3.reason, /ROC year 114 was written as the Gregorian year/u);
  // several record dates with this month / day: all listed, the one under the field's label first
  const b4 = inBundle();
  res(b4, 0).birthDate = "1960-05-03";
  const sg = at(b4, "Bundle.entry[0].resource.birthDate", `${R}\n上次門診：113/05/03 血壓追蹤`)[0].suggestions!;
  assert.deepEqual(sg.map((x) => [x.value, x.confidence]), [["1971-05-03", 0.7], ["2024-05-03", 0.5]]);
  // no record date with this month / day → no suggestion
  const b5 = inBundle();
  res(b5, 0).birthDate = "1960-01-01";
  assert.equal(at(b5, "Bundle.entry[0].resource.birthDate")[0].suggestions, undefined);
});

test("R6 on grounding issues: the validating tools' G-UNGROUNDED dates carry the suggestion; nothing without source_text", () => {
  const b = inBundle();
  res(b, 0).birthDate = "1960-05-03";
  const env = JSON.stringify({
    ok: true,
    data: {
      valid: false,
      issues: [],
      entries: b.entry.map((e: Json, k: number) => ({
        fullUrl: e.fullUrl ?? null,
        resourceType: e.resource.resourceType,
        valid: k !== 0,
        issues: k === 0 ? [{ severity: "error", code: "incomplete", path: "Bundle.entry[0].resource.birthDate", message: "[grounding:G-UNGROUNDED] not stated", rule: "G-UNGROUNDED", source: "grounding" }] : [],
      })),
    },
    warnings: [],
  });
  const out = JSON.parse(addRecordChecksToValidation(env, b, { sourceText: R }));
  const g = out.data.entries[0].issues.find((i: Json) => i.source === "grounding");
  assert.equal(g.severity, "error");
  assert.equal(g.message, "[grounding:G-UNGROUNDED] not stated");
  assert.deepEqual(g.suggestions.map((s: Json) => [s.value, s.kind, s.patch.path]), [["1971-05-03", "replace_value", "Bundle.entry[0].resource.birthDate"]]);
  const plain = JSON.parse(addRecordChecksToValidation(env, b, {}));
  assert.equal(plain.data.entries[0].issues.find((i: Json) => i.source === "grounding").suggestions, undefined);
});
