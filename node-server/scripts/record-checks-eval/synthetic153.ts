/**
 * Synthetic dev set for ISSUES_v15.3 (absence statements in text fields; provisional / differential standing in for
 * the primary diagnosis). Built on the v15.1 inpatient case (synthetic151.ts): ≥ 40 missing-information variants in
 * the three forms the evaluator reported, and ≥ 20 complete controls — correct differential "r/o" secondaries, text-only
 * codes in complete records, qualitative text results, hedged diagnoses written as provisional. All names, numbers and
 * records are invented; nothing comes from any dataset.
 *
 *   A  CodeableConcept.text (no coding / placeholder codings) or a dose text that is an absence statement
 *      (暫不下診斷, 待 CT 報告, 未定, 藥名待確認, 劑量待確認 …)
 *   B  Observation.valueString / note that says there is no result while the code needs a quantitative one
 *      (檢體溶血，重抽中（報告未出）, result pending, 詳見報告 …)
 *   C  the primary Condition written as provisional / differential / text only while the record's diagnosis slot
 *      says no diagnosis yet / to be ruled out
 */
import { IN_RECORD, inBundle } from "./synthetic151.js";

type Json = Record<string, any>;

export type V153Form = "A-text" | "B-result" | "C-primary" | "complete";

export interface V153Case {
  id: string;
  form: V153Form;
  /** Any of these codes at error counts as detected; null for complete controls. */
  expect: string[] | null;
  bundle: Json;
  source_text: string;
  site_config: string | null;
  /** LOINC axes the tools would look up (http://loinc.org|code → property / scale). */
  codeAxes?: Map<string, { property: string | null; scale: string | null }>;
}

const SCT = "http://snomed.info/sct";
const ICD = "http://hl7.org/fhir/sid/icd-10-cm";
const LOINC = "http://loinc.org";
const UCUM = "http://unitsofmeasure.org";
const VS = "http://terminology.hl7.org/CodeSystem/condition-ver-status";
const CAT = "http://terminology.hl7.org/CodeSystem/condition-category";
const OBSCAT = "http://terminology.hl7.org/CodeSystem/observation-category";
const NULLFLAVOR = "http://terminology.hl7.org/CodeSystem/v3-NullFlavor";
const ROLE = "http://terminology.hl7.org/CodeSystem/diagnosis-role";

const U = (n: number): string => `urn:uuid:7c1e0d52-0000-4000-8000-${String(n).padStart(12, "0")}`;
const P = { reference: U(1) };
const clone = <T>(x: T): T => structuredClone(x);
const res = (b: Json, i: number): Json => b.entry[i].resource;
const rep = (base: string, from: string, to: string): string => {
  if (!base.includes(from)) throw new Error(`synthetic153: '${from}' not in the record`);
  return base.split(from).join(to);
};
const R = IN_RECORD;
const DX = "診斷：社區型肺炎 (J18.9)";
const dx = (line: string): string => rep(R, DX, line);
const vs = (code: string): Json => ({ coding: [{ system: VS, code }] });
const encDx = { coding: [{ system: CAT, code: "encounter-diagnosis" }] };

function cond(n: number, code: Json, status: string | null, category: Json | null = encDx): Json {
  return {
    fullUrl: U(n),
    resource: {
      resourceType: "Condition",
      clinicalStatus: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-clinical", code: "active" }] },
      ...(status ? { verificationStatus: vs(status) } : {}),
      ...(category ? { category: [category] } : {}),
      code,
      subject: P,
    },
  };
}

function lab(n: number, code: string, display: string, text: string, value: Json, extra: Json = {}): Json {
  return {
    fullUrl: U(n),
    resource: { resourceType: "Observation", status: "final", category: [{ coding: [{ system: OBSCAT, code: "laboratory" }] }], code: { coding: [{ system: LOINC, code, display }], text }, subject: P, effectiveDateTime: "2025-06-11T07:00:00+08:00", ...value, ...extra },
  };
}

export function syntheticV153Cases(): V153Case[] {
  const out: V153Case[] = [];
  const add = (id: string, form: V153Form, expect: string[] | null, edit: (b: Json) => void, record: string, axes?: V153Case["codeAxes"]): void => {
    const b = clone(inBundle());
    edit(b);
    out.push({ id, form, expect, bundle: b, source_text: record, site_config: null, ...(axes ? { codeAxes: axes } : {}) });
  };
  const ABS = ["information-absent"];
  const PRIMARY = ["information-absent", "unconfirmed-as-confirmed"];
  const setCode = (code: Json, status: string | null = "keep") => (b: Json): void => {
    res(b, 2).code = code;
    if (status === null) delete res(b, 2).verificationStatus;
    else if (status !== "keep") res(b, 2).verificationStatus = vs(status);
  };

  // ------------------------------------------------------------------ A: text fields that state an absence
  const pendingCt = dx("Dx：暫不下診斷，待 CT 正式報告");
  add("A-dx-text-defer", "A-text", ABS, setCode({ text: "暫不下診斷" }, null), pendingCt);
  add("A-dx-text-defer-provisional", "A-text", ABS, setCode({ text: "暫不下診斷" }, "provisional"), pendingCt);
  add("A-dx-text-await-ct", "A-text", ABS, setCode({ text: "待CT報告" }, "provisional"), pendingCt);
  add("A-dx-text-await-ct-spaced", "A-text", ABS, setCode({ text: "待 CT 正式報告" }, null), pendingCt);
  add("A-dx-nullflavor-coding", "A-text", ABS, setCode({ coding: [{ system: NULLFLAVOR, code: "UNK" }], text: "診斷未定" }), dx("診斷：診斷未定"));
  add("A-dx-empty-coding", "A-text", ABS, setCode({ coding: [{ system: SCT, code: "" }], text: "pending" }), dx("Dx: pending"));
  add("A-dx-unknown-code", "A-text", ABS, setCode({ coding: [{ system: ICD, code: "unknown" }], text: "尚未確立" }), dx("診斷：尚未確立"));
  add("A-dx-text-not-established", "A-text", ABS, setCode({ text: "未確立" }), dx("主診斷：未確立"));
  add("A-dx-text-to-rule-out", "A-text", ABS, setCode({ text: "待排除" }, "differential"), dx("主診斷：待排除"));
  add("A-dx-text-differentiating", "A-text", ABS, setCode({ text: "鑑別中" }, "provisional"), dx("Dx：鑑別中"));
  add("A-dx-text-cause-pending", "A-text", ABS, setCode({ text: "原因待查" }), dx("診斷：原因待查"));
  add("A-dx-text-en-deferred", "A-text", ABS, setCode({ text: "Diagnosis deferred" }, null), dx("Impression: diagnosis deferred pending CT"));
  add("A-dx-text-en-tbd", "A-text", ABS, setCode({ text: "to be determined" }, "provisional"), dx("Assessment: to be determined after imaging"));
  add("A-dx-text-en-not-yet", "A-text", ABS, setCode({ text: "not yet diagnosed" }), dx("Impression: not yet diagnosed, work-up pending"));
  add("A-med-text-name-pending", "A-text", ABS, (b) => (res(b, 8).medicationCodeableConcept = { text: "藥名待確認" }), rep(R, "處方：Ceftriaxone 2 g 靜脈注射 每日一次 7 天", "處方：抗生素（藥名待確認）"));
  add("A-med-text-en-tbd", "A-text", ABS, (b) => (res(b, 8).medicationCodeableConcept = { text: "TBD" }), rep(R, "處方：Ceftriaxone 2 g 靜脈注射 每日一次 7 天", "Rx: antibiotic to be decided"));
  add("A-dose-text-pending", "A-text", ABS, (b) => (res(b, 8).dosageInstruction = [{ text: "劑量待確認" }]), rep(R, "Ceftriaxone 2 g 靜脈注射", "Ceftriaxone 靜脈注射（劑量待確認）"));
  add("A-dose-text-en", "A-text", ABS, (b) => (res(b, 8).dosageInstruction = [{ text: "dose pending", doseAndRate: [{ doseQuantity: { unit: "g", system: UCUM, code: "g" } }] }]), rep(R, "Ceftriaxone 2 g 靜脈注射", "Ceftriaxone 靜脈注射，dose pending"));
  add("A-value-cc-not-out", "A-text", ABS, (b) => b.entry.push(lab(40, "600-7", "Bacteria identified in Blood by Culture", "血液培養", { valueCodeableConcept: { text: "未出" } })), rep(R, "血糖：", "血液培養：未出\n血糖："));
  add("A-value-cc-culture-pending", "A-text", ABS, (b) => b.entry.push(lab(41, "600-7", "Bacteria identified in Blood by Culture", "血液培養", { valueCodeableConcept: { text: "培養中" } })), rep(R, "血糖：", "血液培養：培養中\n血糖："));

  // ------------------------------------------------------------------ B: text results where a number is needed
  const hemo = rep(R, "白血球 12.3 x10^3/uL，", "白血球 3 h 檢體溶血，重抽中（報告未出），");
  const wbcString = (v: string) => (b: Json): void => {
    delete res(b, 5).valueQuantity;
    res(b, 5).valueString = v;
  };
  add("B-wbc-hemolysis-redraw", "B-result", ABS, wbcString("檢體溶血，重抽中（報告未出）"), hemo);
  add("B-wbc-hemolysis-time", "B-result", ABS, wbcString("3 h 檢體溶血，重抽中（報告未出）"), hemo);
  add("B-wbc-hemolysis-only", "B-result", ABS, wbcString("溶血"), hemo);
  add("B-wbc-en-redraw", "B-result", ABS, wbcString("hemolyzed, redraw pending"), hemo);
  add("B-wbc-see-report", "B-result", ABS, wbcString("詳見報告"), rep(R, "白血球 12.3 x10^3/uL，", "白血球 見另一份報告，"));
  add("B-wbc-not-out", "B-result", ABS, wbcString("報告未出"), rep(R, "白血球 12.3 x10^3/uL，", "白血球 報告未出，"));
  add("B-crp-clotted", "B-result", ABS, (b) => b.entry.push(lab(42, "1988-5", "C reactive protein [Mass/volume] in Serum or Plasma", "CRP", { valueString: "specimen clotted, recollect" })), rep(R, "CRP 8.2 mg/dL", "CRP specimen clotted, recollect"));
  add("B-crp-qns", "B-result", ABS, (b) => b.entry.push(lab(43, "1988-5", "C reactive protein [Mass/volume] in Serum or Plasma", "CRP", { valueString: "QNS" })), rep(R, "CRP 8.2 mg/dL", "CRP QNS"));
  const tropAxes = new Map([[`${LOINC}|10839-9`, { property: "MCnc", scale: "Qn" }]]);
  add("B-troponin-axes-pending", "B-result", ABS, (b) => b.entry.push(lab(44, "10839-9", "Troponin I.cardiac", "Troponin I", { valueString: "result pending" })), rep(R, "血糖：", "Troponin I：result pending\n血糖："), tropAxes);
  add("B-troponin-axes-hemolysis", "B-result", ABS, (b) => b.entry.push(lab(45, "10839-9", "Troponin I.cardiac", "Troponin I", { valueString: "溶血" })), rep(R, "血糖：", "Troponin I：溶血\n血糖："), tropAxes);
  add("B-temp-vital-pending", "B-result", ABS, (b) => {
    delete res(b, 4).valueQuantity;
    res(b, 4).valueString = "待測";
  }, rep(R, "體溫 38.6°C，", "體溫 待測，"));
  add("B-note-no-value", "B-result", ABS, (b) => {
    delete res(b, 5).valueQuantity;
    res(b, 5).note = [{ text: "檢體溶血，重抽中" }];
  }, hemo);
  add("B-bp-component-pending", "B-result", ABS, (b) =>
    b.entry.push({ fullUrl: U(46), resource: { resourceType: "Observation", status: "final", category: [{ coding: [{ system: OBSCAT, code: "vital-signs" }] }], code: { coding: [{ system: LOINC, code: "85354-9" }], text: "血壓" }, subject: P, effectiveDateTime: "2025-06-10T14:30:00+08:00",
      component: [
        { code: { coding: [{ system: LOINC, code: "8480-6" }] }, valueString: "未測" },
        { code: { coding: [{ system: LOINC, code: "8462-4" }] }, valueString: "未測" },
      ] } }),
    rep(R, "血壓 132/84 mmHg，", "血壓 未測，"));
  add("B-a1c-refrange-pending", "B-result", ABS, (b) => b.entry.push(lab(47, "4548-4", "Hemoglobin A1c/Hemoglobin.total in Blood", "HbA1c", { valueString: "外送中", referenceRange: [{ low: { value: 4, unit: "%" }, high: { value: 5.6, unit: "%" } }] })), rep(R, "血糖：", "HbA1c：外送中\n血糖："));
  add("B-glucose-sibling-redraw", "B-result", ABS, (b) => {
    delete res(b, 6).valueQuantity;
    res(b, 6).valueString = "待重抽";
  }, rep(R, "06/11 07:00 156 mg/dL", "06/11 07:00 待重抽"));
  add("B-glucose-not-resulted", "B-result", ABS, (b) => {
    delete res(b, 6).valueQuantity;
    res(b, 6).valueString = "not resulted";
  }, rep(R, "06/11 07:00 156 mg/dL", "06/11 07:00 not resulted"));

  // ------------------------------------------------------------------ C: provisional / differential / text-only primary diagnosis
  add("C-primary-ro-list-provisional", "C-primary", PRIMARY, setCode({ text: "社區型肺炎／肺結核／肺癌" }, "provisional"), dx("主診斷：待排除 社區型肺炎、肺結核、肺癌"));
  add("C-primary-ro-coded-differential", "C-primary", PRIMARY, setCode({ coding: [{ system: ICD, code: "J18.9", display: "Pneumonia, unspecified organism" }], text: "社區型肺炎" }, "differential"), dx("主診斷：待排除 社區型肺炎、肺結核、肺癌"));
  add("C-primary-ddx-provisional", "C-primary", PRIMARY, setCode({ coding: [{ system: ICD, code: "J10.1", display: "Influenza" }], text: "流感" }, "provisional"), dx("Dx：鑑別 流感／COVID-19／RSV 感染，未下診斷"));
  add("C-primary-ddx-heading-differential", "C-primary", PRIMARY, setCode({ coding: [{ system: ICD, code: "J18.9", display: "Pneumonia, unspecified organism" }], text: "肺炎" }, "differential"), dx("鑑別診斷：肺炎、肺結核"));
  add("C-primary-en-ro", "C-primary", PRIMARY, setCode({ coding: [{ system: ICD, code: "J18.9", display: "Pneumonia, unspecified organism" }], text: "pneumonia" }, "provisional"), dx("Impression: r/o pneumonia"));
  add("C-primary-en-pending-ct", "C-primary", PRIMARY, setCode({ coding: [{ system: ICD, code: "R10.9", display: "Unspecified abdominal pain" }], text: "abdominal pain" }, "provisional"), dx("Assessment: diagnosis pending CT"));
  add("C-primary-rapid-test-unconfirmed", "C-primary", PRIMARY, setCode({ coding: [{ system: ICD, code: "J10.1", display: "Influenza" }], text: "流感" }, "unconfirmed"), dx("診斷：快篩結果出來前不下診斷"));
  add("C-primary-text-copy-confirmed", "C-primary", PRIMARY, setCode({ text: "社區型肺炎、肺結核待排除" }), dx("主診斷：待排除 社區型肺炎、肺結核，尚未確立"));
  add("C-primary-text-only-no-status", "C-primary", PRIMARY, setCode({ text: "肺炎" }, null), dx("Dx：鑑別 肺炎／肺結核，未下診斷"));
  add("C-primary-encounter-rank1", "C-primary", PRIMARY, (b) => {
    res(b, 2).verificationStatus = vs("provisional");
    delete res(b, 2).category;
    delete res(b, 3).category;
    res(b, 1).diagnosis = [
      { condition: { reference: U(4) }, use: { coding: [{ system: ROLE, code: "CM" }] }, rank: 2 },
      { condition: { reference: U(3) }, use: { coding: [{ system: ROLE, code: "AD" }] }, rank: 1 },
    ];
  }, dx("Dx：鑑別 社區型肺炎／肺結核，未下診斷"));
  add("C-primary-encounter-first-noncm", "C-primary", PRIMARY, (b) => {
    res(b, 2).verificationStatus = vs("differential");
    res(b, 1).diagnosis = [
      { condition: { reference: U(4) }, use: { coding: [{ system: ROLE, code: "CM" }] } },
      { condition: { reference: U(3) }, use: { coding: [{ system: ROLE, code: "DD" }] } },
    ];
  }, dx("鑑別診斷：社區型肺炎、肺結核"));
  add("C-primary-two-differentials", "C-primary", PRIMARY, (b) => {
    res(b, 2).verificationStatus = vs("differential");
    b.entry.push(cond(48, { coding: [{ system: ICD, code: "A15.0", display: "Tuberculosis of lung" }], text: "肺結核" }, "differential"));
  }, dx("Dx：鑑別 社區型肺炎／肺結核，未下診斷"));
  add("C-primary-empty-slot", "C-primary", PRIMARY, setCode({ coding: [{ system: ICD, code: "J18.9", display: "Pneumonia, unspecified organism" }], text: "社區型肺炎" }, "provisional"), dx("診斷："));
  add("C-primary-only-condition", "C-primary", PRIMARY, (b) => {
    b.entry.splice(3, 1);
    delete res(b, 2).category;
    res(b, 2).verificationStatus = vs("provisional");
    res(b, 2).code = { coding: [{ system: ICD, code: "K35.80", display: "Unspecified acute appendicitis" }], text: "appendicitis" };
  }, dx("Dx: r/o appendicitis"));
  add("C-primary-en-undetermined", "C-primary", PRIMARY, setCode({ coding: [{ system: ICD, code: "J18.9", display: "Pneumonia, unspecified organism" }] }, "differential"), dx("Diagnosis: undetermined, pending work-up"));
  add("C-primary-cued-items", "C-primary", PRIMARY, setCode({ coding: [{ system: ICD, code: "J18.9", display: "Pneumonia, unspecified organism" }], text: "社區型肺炎" }, "provisional"), dx("診斷：1. r/o 社區型肺炎 2. r/o 肺結核"));

  // ------------------------------------------------------------------ complete controls (no error expected)
  const tb = (n: number, status: string): Json => cond(n, { coding: [{ system: ICD, code: "A15.0", display: "Tuberculosis of lung" }], text: "肺結核" }, status);
  add("ok-secondary-ro-differential", "complete", null, (b) => b.entry.push(tb(50, "differential")), dx("診斷：社區型肺炎 (J18.9)；r/o 肺結核"));
  add("ok-secondary-ro-provisional-first", "complete", null, (b) => b.entry.splice(2, 0, tb(51, "provisional")), dx("診斷：社區型肺炎 (J18.9)；r/o 肺結核"));
  add("ok-secondary-ro-en", "complete", null, (b) => {
    res(b, 2).code.text = "community-acquired pneumonia";
    b.entry.push(cond(52, { coding: [{ system: ICD, code: "A15.0", display: "Tuberculosis of lung" }], text: "TB" }, "differential"));
  }, dx("Dx: community-acquired pneumonia (J18.9), r/o TB"));
  add("ok-secondary-ddx-heading", "complete", null, (b) => {
    b.entry.push(tb(53, "differential"));
    res(b, 1).diagnosis = [{ condition: { reference: U(3) }, rank: 1 }, { condition: { reference: U(53) }, rank: 2 }];
  }, dx("診斷：社區型肺炎 (J18.9)\n鑑別診斷：肺結核"));
  add("ok-soap-ro-secondary", "complete", null, (b) => b.entry.push(tb(54, "differential")), dx("A: 1. 社區型肺炎 (J18.9) 2. r/o 肺結核"));
  add("ok-text-only-primary", "complete", null, setCode({ text: "社區型肺炎" }), R);
  add("ok-text-only-primary-no-status", "complete", null, setCode({ text: "社區型肺炎" }, null), R);
  add("ok-text-only-primary-en", "complete", null, setCode({ text: "community-acquired pneumonia" }), dx("Dx: community-acquired pneumonia"));
  add("ok-nullflavor-with-name", "complete", null, setCode({ coding: [{ system: NULLFLAVOR, code: "UNK" }], text: "社區型肺炎" }), R);
  add("ok-hedged-provisional", "complete", null, setCode({ coding: [{ system: ICD, code: "J18.9", display: "Pneumonia, unspecified organism" }], text: "社區型肺炎" }, "provisional"), dx("診斷：疑似社區型肺炎"));
  add("ok-encounter-cm-only-comorbidity", "complete", null, (b) => {
    res(b, 1).diagnosis = [{ condition: { reference: U(3) }, rank: 1 }, { condition: { reference: U(4) }, use: { coding: [{ system: ROLE, code: "CM" }] } }];
  }, R);
  add("ok-pneumonia-bracket-pending-organism", "complete", null, () => undefined, dx("診斷：社區型肺炎 (J18.9)（待痰培養確認菌種）"));
  add("ok-fuo", "complete", null, setCode({ coding: [{ system: ICD, code: "R50.9", display: "Fever, unspecified" }], text: "不明原因發燒" }), dx("診斷：不明原因發燒 (R50.9)"));
  add("ok-flu-negative", "complete", null, (b) => b.entry.push(lab(55, "80382-5", "Influenza virus A Ag [Presence] in Upper respiratory specimen by Rapid immunoassay", "流感快篩 A", { valueString: "陰性" })), rep(R, "血糖：", "流感快篩：A 陰性\n血糖："));
  add("ok-covid-negative-en", "complete", null, (b) => b.entry.push(lab(56, "94500-6", "SARS-CoV-2 (COVID-19) RNA [Presence] in Respiratory system specimen by NAA with probe detection", "COVID-19 PCR", { valueString: "Not detected" })), rep(R, "血糖：", "COVID-19 PCR: not detected\n血糖："));
  add("ok-urine-protein-trace", "complete", null, (b) => b.entry.push(lab(57, "20454-5", "Protein [Presence] in Urine by Test strip", "尿蛋白", { valueString: "1+" })), rep(R, "血糖：", "尿蛋白：1+\n血糖："));
  add("ok-urine-appearance", "complete", null, (b) => b.entry.push(lab(58, "5767-9", "Appearance of Urine", "尿液外觀", { valueString: "yellow, clear" })), rep(R, "血糖：", "尿液外觀：yellow, clear\n血糖："));
  add("ok-serum-appearance-hemolyzed", "complete", null, (b) =>
    b.entry.push({ fullUrl: U(59), resource: { resourceType: "Observation", status: "final", code: { text: "血清外觀" }, subject: P, effectiveDateTime: "2025-06-11T07:00:00+08:00", valueString: "溶血" } }),
    rep(R, "血糖：", "血清外觀：溶血\n血糖："));
  add("ok-troponin-text-number", "complete", null, (b) => b.entry.push(lab(60, "10839-9", "Troponin I.cardiac", "Troponin I", { valueString: "<0.01 ng/mL" })), rep(R, "血糖：", "Troponin I：<0.01 ng/mL\n血糖："), new Map([[`${LOINC}|10839-9`, { property: "MCnc", scale: "Qn" }]]));
  add("ok-note-with-value", "complete", null, (b) => (res(b, 5).note = [{ text: "檢體輕微溶血，結果僅供參考" }]), rep(R, "白血球 12.3 x10^3/uL，", "白血球 12.3 x10^3/uL（檢體輕微溶血），"));
  add("ok-dose-text-as-directed", "complete", null, (b) => (res(b, 8).dosageInstruction[0].text = "Ceftriaxone 2 g IV qd，依醫囑"), R);
  add("ok-family-history-unknown-dx", "complete", null, () => undefined, `${R}\n家族史：不詳`);
  add("ok-ro-refuted-secondary", "complete", null, (b) => b.entry.push(tb(61, "refuted")), dx("診斷：社區型肺炎 (J18.9)；肺結核已排除"));
  return out;
}

/**
 * R3 cases: a coded element that grounding reports G-UNGROUNDED, through the validating tools' envelope. `expect`:
 * "warning" — a correct / plausible code worded differently (another language, a near concept, a comorbidity, a brand
 * name): must not stay an error (no issue at all also passes); "error" — the record's diagnosis slot clearly names
 * something else and nothing related is stated: must stay an error. `terms`: the terminology names grounding compares.
 */
export interface V153CodeCase {
  id: string;
  expect: "warning" | "error";
  bundle: Json;
  source_text: string;
  /** Index of the entry whose coded element is examined, and the element (code / medicationCodeableConcept). */
  entry: number;
  element: string;
  terms: Map<string, { found: boolean; names: string[] }>;
}

export function syntheticV153CodeCases(): V153CodeCase[] {
  const out: V153CodeCase[] = [];
  const HTN: [string, { found: boolean; names: string[] }] = [`${ICD}|I10`, { found: true, names: ["Essential (primary) hypertension", "高血壓"] }];
  const add = (id: string, expect: "warning" | "error", coding: Json, names: string[], record: string, edit?: (b: Json) => void, entry = 2, element = "code"): void => {
    const b = clone(inBundle());
    if (element === "code") res(b, entry).code = { coding: [coding] };
    else res(b, entry)[element] = { coding: [coding] };
    edit?.(b);
    out.push({ id, expect, bundle: b, source_text: record, entry, element, terms: new Map([[`${coding.system}|${coding.code}`, { found: true, names }], HTN]) });
  };
  const EN = rep(R, DX, "Dx: community-acquired pneumonia (J18.9)");
  // correct / plausible codes worded differently → warning
  add("R3-lrti-english-only", "warning", { system: SCT, code: "50417007", display: "Lower respiratory tract infection" }, ["Lower respiratory tract infection"], R);
  add("R3-bronchopneumonia-near", "warning", { system: SCT, code: "396285007", display: "Bronchopneumonia" }, ["Bronchopneumonia", "支氣管肺炎"], R);
  add("R3-pneumonia-organism-en", "warning", { system: SCT, code: "312342009", display: "Infective pneumonia" }, ["Infective pneumonia", "Pneumonia due to infectious organism"], R);
  add("R3-cap-fsn-en-record", "warning", { system: SCT, code: "385093006", display: "Infective pneumonia acquired prior to hospitalization" }, ["Infective pneumonia acquired prior to hospitalization"], EN);
  add("R3-abbreviation-slot", "warning", { system: SCT, code: "233604007", display: "Pneumonia" }, ["Pneumonia"], rep(R, DX, "Dx: CAP"));
  add("R3-comorbidity-other-wording", "warning", { system: ICD, code: "I63.9", display: "Cerebral infarction, unspecified" }, ["Cerebral infarction, unspecified", "腦梗塞"], rep(R, "過去病史：高血壓10年，規則服藥。", "過去病史：高血壓10年，規則服藥；腦中風。"), (b) => {
    b.entry.push({ fullUrl: U(70), resource: { resourceType: "Condition", category: [{ coding: [{ system: CAT, code: "problem-list-item" }] }], code: { coding: [{ system: ICD, code: "I63.9", display: "Cerebral infarction, unspecified" }] }, subject: P } });
    b.entry[2].resource.code = { coding: [{ system: ICD, code: "J18.9", display: "Pneumonia, unspecified organism" }], text: "社區型肺炎" };
  });
  add("R3-medicine-brand-name", "warning", { system: "https://twcore.mohw.gov.tw/ig/twcore/CodeSystem/medication-nhi-tw", code: "BC00000100" }, ["ROCEPHIN INJECTION 1GM"], R, undefined, 8, "medicationCodeableConcept");
  add("R3-hedged-slot-other", "warning", { system: SCT, code: "195967001", display: "Asthma" }, ["Asthma"], rep(R, DX, "診斷：疑似社區型肺炎"));
  // the diagnosis slot names something else, nothing related in the record → error
  add("R3-asthma-vs-pneumonia-zh", "error", { system: SCT, code: "195967001", display: "Asthma" }, ["Asthma", "氣喘"], R);
  add("R3-uti-vs-pneumonia-zh", "error", { system: SCT, code: "68566005", display: "Urinary tract infectious disease" }, ["Urinary tract infectious disease", "泌尿道感染"], R);
  add("R3-icd-uti-vs-pneumonia", "error", { system: ICD, code: "N39.0", display: "Urinary tract infection, site not specified" }, ["Urinary tract infection, site not specified", "泌尿道感染"], R);
  add("R3-gerd-vs-pneumonia-en", "error", { system: SCT, code: "235595009", display: "Gastroesophageal reflux disease" }, ["Gastroesophageal reflux disease"], EN);
  return out;
}
