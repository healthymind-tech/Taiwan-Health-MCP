/**
 * Synthetic dev set for ISSUES_v15.1 (value grounding, primary diagnosis slot, other time points).
 *
 * One complete inpatient case (record + Bundle) and ≥ 80 variants in the six miss classes the
 * evaluator reported — identity, date, quantity, medication, diagnosis, structure — plus
 * other-time-point values: the record lacks (or states the absence of) a piece of information and the
 * Bundle fills it with a made-up identifier / date / T00:00:00 / 0 / a differential copied into
 * Condition.code.text / a symptom code / a value of another measurement. Complete controls cover the
 * derivations that must stay grounded (入院第N天, POD#N, 3 天前, ROC dates, unit conversion, BMI, dose ×
 * count, site_config identifiers, Z times) and the bracket-scope false positive (Elevated PSA
 * （未確立惡性腫瘤）). All names, numbers and records are invented; nothing comes from any dataset.
 */

type Json = Record<string, any>;

export type V151Class = "identity" | "date" | "quantity" | "medication" | "diagnosis" | "structure" | "other-time-point" | "roc-conversion" | "complete";

export interface V151Case {
  id: string;
  cls: V151Class;
  /** Any of these codes at error (or warning when severity is "warning") counts as detected; null for complete controls. */
  expect: { codes: string[]; severity: "error" | "warning" } | null;
  bundle: Json;
  source_text: string;
  site_config: string | null;
  /** R6: the corrected values the issue's suggestions must offer (in this order: the first is the best). */
  suggest?: string[];
}

const MOI = "http://www.moi.gov.tw";
const MRN = "https://hosp.example.tw/mrn";
const ENC = "https://hosp.example.tw/encounter";
const ICD = "http://hl7.org/fhir/sid/icd-10-cm";
const SCT = "http://snomed.info/sct";
const LOINC = "http://loinc.org";
const UCUM = "http://unitsofmeasure.org";
const VS = "http://terminology.hl7.org/CodeSystem/condition-ver-status";
const CAT = "http://terminology.hl7.org/CodeSystem/condition-category";
const OBSCAT = "http://terminology.hl7.org/CodeSystem/observation-category";
const NHI_MED = "https://twcore.mohw.gov.tw/ig/twcore/CodeSystem/medication-nhi-tw";

export const IN_RECORD = [
  "住院病歷摘要",
  "姓名：王大明　性別：男　出生日期：民國60年5月3日",
  "身分證字號：B120345673　病歷號：00451234",
  "入院日期：2025/06/10 14:30",
  "主訴：發燒三天，咳嗽有痰",
  "現病史：三天前開始發燒，伴隨咳嗽。入院第2天抽血追蹤。",
  "過去病史：高血壓10年，規則服藥。",
  "生命徵象：體溫 38.6°C，血壓 132/84 mmHg，心跳 98 次/分，體重 72 kg，身高 175 cm",
  "檢驗（2025/06/11 07:00 採檢）：白血球 12.3 x10^3/uL，CRP 8.2 mg/dL",
  "血糖：06/11 07:00 156 mg/dL；06/11 11:00 142 mg/dL",
  "診斷：社區型肺炎 (J18.9)",
  "處方：Ceftriaxone 2 g 靜脈注射 每日一次 7 天",
].join("\n");

const U = (n: number): string => `urn:uuid:7c1e0d52-0000-4000-8000-${String(n).padStart(12, "0")}`;
const P = { reference: U(1) };

function obs(n: number, code: string, display: string, text: string, eff: string, value: number, unit: string, ucum: string, cat = "laboratory"): Json {
  return {
    fullUrl: U(n),
    resource: {
      resourceType: "Observation",
      status: "final",
      category: [{ coding: [{ system: OBSCAT, code: cat }] }],
      code: { coding: [{ system: LOINC, code, display }], text },
      subject: P,
      effectiveDateTime: eff,
      valueQuantity: { value, unit, system: UCUM, code: ucum },
    },
  };
}

export function inBundle(): Json {
  return {
    resourceType: "Bundle",
    type: "collection",
    entry: [
      {
        fullUrl: U(1),
        resource: {
          resourceType: "Patient",
          identifier: [
            { type: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v2-0203", code: "NNxxx" }] }, system: MOI, value: "B120345673" },
            { type: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v2-0203", code: "MR" }] }, system: MRN, value: "00451234" },
          ],
          name: [{ text: "王大明", family: "王", given: ["大明"] }],
          gender: "male",
          birthDate: "1971-05-03",
        },
      },
      {
        fullUrl: U(2),
        resource: { resourceType: "Encounter", status: "in-progress", class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "IMP" }, subject: P, period: { start: "2025-06-10T14:30:00+08:00" } },
      },
      {
        fullUrl: U(3),
        resource: {
          resourceType: "Condition",
          clinicalStatus: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-clinical", code: "active" }] },
          verificationStatus: { coding: [{ system: VS, code: "confirmed" }] },
          category: [{ coding: [{ system: CAT, code: "encounter-diagnosis" }] }],
          code: { coding: [{ system: ICD, code: "J18.9", display: "Pneumonia, unspecified organism" }], text: "社區型肺炎" },
          subject: P,
        },
      },
      {
        fullUrl: U(4),
        resource: {
          resourceType: "Condition",
          clinicalStatus: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-clinical", code: "active" }] },
          verificationStatus: { coding: [{ system: VS, code: "confirmed" }] },
          category: [{ coding: [{ system: CAT, code: "problem-list-item" }] }],
          code: { coding: [{ system: ICD, code: "I10", display: "Essential (primary) hypertension" }], text: "高血壓" },
          subject: P,
          onsetDateTime: "2015",
        },
      },
      obs(5, "8310-5", "Body temperature", "體溫", "2025-06-10T14:30:00+08:00", 38.6, "°C", "Cel", "vital-signs"),
      obs(6, "6690-2", "Leukocytes [#/volume] in Blood by Automated count", "白血球", "2025-06-11T07:00:00+08:00", 12.3, "10*3/uL", "10*3/uL"),
      obs(7, "2339-0", "Glucose [Mass/volume] in Blood", "血糖", "2025-06-11T07:00:00+08:00", 156, "mg/dL", "mg/dL"),
      obs(8, "2339-0", "Glucose [Mass/volume] in Blood", "血糖", "2025-06-11T11:00:00+08:00", 142, "mg/dL", "mg/dL"),
      {
        fullUrl: U(9),
        resource: {
          resourceType: "MedicationRequest",
          status: "active",
          intent: "order",
          medicationCodeableConcept: { coding: [{ system: NHI_MED, code: "BC00000100" }], text: "Ceftriaxone" },
          subject: P,
          authoredOn: "2025-06-10",
          dosageInstruction: [{ text: "Ceftriaxone 2 g IV qd", doseAndRate: [{ doseQuantity: { value: 2, unit: "g", system: UCUM, code: "g" } }] }],
        },
      },
    ],
  };
}

const clone = <T>(x: T): T => structuredClone(x);
const rep = (base: string, from: string, to: string): string => {
  if (!base.includes(from)) throw new Error(`synthetic151: '${from}' not in the record`);
  return base.split(from).join(to);
};
const R = IN_RECORD;
const res = (b: Json, i: number): Json => b.entry[i].resource;

export function syntheticV151Cases(): V151Case[] {
  const out: V151Case[] = [];
  const add = (id: string, cls: V151Class, codes: string[] | null, edit: (b: Json) => void, record: string, site: string | null = null, severity: "error" | "warning" = "error"): void => {
    const b = clone(inBundle());
    edit(b);
    out.push({ id, cls, expect: codes ? { codes, severity } : null, bundle: b, source_text: record, site_config: site });
  };
  const UNG = ["ungrounded-value", "information-absent", "value-from-other-event"];
  const ABS = ["information-absent", "ungrounded-value"];
  const UNC = ["unconfirmed-as-confirmed"];

  // ---------------------------------------------------------------- identity
  for (const [i, [rec, val]] of ([
    ["病歷號：申請中", "I115051002"],
    ["病歷號：新病人建檔中，尚未給號", "00451299"],
    ["病歷號：待補", "MRN-2025-0001"],
    ["病歷號：（空白）", "A0012345"],
  ] as Array<[string, string]>).entries()) {
    add(`id-mrn-fabricated-${i}`, "identity", ABS, (b) => (res(b, 0).identifier[1].value = val), rep(R, "病歷號：00451234", rec));
  }
  add("id-nid-fabricated-valid-checksum", "identity", ABS, (b) => (res(b, 0).identifier[0].value = "E221087657"), rep(R, "身分證字號：B120345673", "身分證字號：家屬表示證件未帶"));
  add("id-nid-fabricated-unstated", "identity", ABS, (b) => (res(b, 0).identifier[0].value = "K100554432"), rep(R, "身分證字號：B120345673　", ""));
  add("id-encounter-fabricated", "identity", UNG, (b) => (res(b, 1).identifier = [{ system: ENC, value: "IP115-008417" }]), R);
  add("id-mrn-digits-changed", "identity", UNG, (b) => (res(b, 0).identifier[1].value = "00451243"), R);

  // ---------------------------------------------------------------- structure
  add("struct-nid-system-only", "structure", ["information-absent"], (b) => (res(b, 0).identifier[0] = { system: MOI }), rep(R, "身分證字號：B120345673　", ""));
  add("struct-mrn-system-only", "structure", ["information-absent"], (b) => (res(b, 0).identifier[1] = { system: MRN, type: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v2-0203", code: "MR" }] } }), rep(R, "病歷號：00451234", "病歷號：申請中"));
  add("struct-nid-system-only-record-has", "structure", ["incomplete-value"], (b) => (res(b, 0).identifier[0] = { system: MOI }), R);
  add("struct-qty-unit-only", "structure", ["incomplete-value"], (b) => delete res(b, 5).valueQuantity.value, rep(R, "白血球 12.3 x10^3/uL，", "白血球 檢體凝固未發報告，"));
  add("struct-qty-null", "structure", ["incomplete-value", "information-absent"], (b) => (res(b, 4).valueQuantity.value = null), rep(R, "體溫 38.6°C，", "體溫 未測，"));
  add("struct-dose-unit-only", "structure", ["incomplete-value"], (b) => delete res(b, 8).dosageInstruction[0].doseAndRate[0].doseQuantity.value, rep(R, "Ceftriaxone 2 g 靜脈注射", "Ceftriaxone 靜脈注射"));
  add("struct-date-month", "structure", ["insufficient-precision"], (b) => (res(b, 1).period.start = "2025-06"), rep(R, "入院日期：2025/06/10 14:30", "入院日期：六月份"));
  add("struct-mrn-empty-string", "structure", ["information-absent"], (b) => (res(b, 0).identifier[1].value = ""), rep(R, "病歷號：00451234", "病歷號：尚未取號"));

  // ---------------------------------------------------------------- date
  const noLabDate = rep(R, "檢驗（2025/06/11 07:00 採檢）：", "檢驗：");
  add("date-lab-fabricated-2026", "date", UNG, (b) => (res(b, 5).effectiveDateTime = "2026-01-01"), noLabDate);
  add("date-lab-fabricated-2022", "date", UNG, (b) => (res(b, 5).effectiveDateTime = "2022-01-02"), noLabDate);
  add("date-lab-visit-T00", "date", UNG, (b) => (res(b, 5).effectiveDateTime = "2025-06-10T00:00:00+08:00"), noLabDate);
  add("date-enc-T00", "date", UNG, (b) => (res(b, 1).period.start = "2025-06-10T00:00:00+08:00"), rep(R, "入院日期：2025/06/10 14:30", "入院日期：2025/06/10"));
  add("date-enc-T00-noTZ", "date", UNG, (b) => (res(b, 1).period.start = "2025-06-10T00:00:00"), rep(R, "入院日期：2025/06/10 14:30", "入院日期：2025/06/10"));
  add("date-enc-fabricated-time", "date", UNG, (b) => (res(b, 1).period.start = "2025-06-10T08:00:00+08:00"), rep(R, "入院日期：2025/06/10 14:30", "入院日期：2025/06/10"));
  add("date-enc-fabricated-seconds", "date", UNG, (b) => (res(b, 1).period.start = "2025-06-10T14:30:27+08:00"), R);
  add("date-enc-other-day", "date", UNG, (b) => (res(b, 1).period.start = "2025-06-01T14:30:00+08:00"), R);
  add("date-birth-from-age", "date", UNG, (b) => (res(b, 0).birthDate = "1971-01-01"), rep(R, "出生日期：民國60年5月3日", "年齡：54歲"));
  add("date-birth-stated-absent", "date", ABS, (b) => (res(b, 0).birthDate = "1971-05-03"), rep(R, "出生日期：民國60年5月3日", "出生日期：不詳"));
  add("date-onset-fabricated", "date", UNG, (b) => (res(b, 2).onsetDateTime = "2025-05-20"), R);
  add("date-specimen-unreadable", "date", ["value-from-other-event", "information-absent"], (b) => (res(b, 5).effectiveDateTime = "2025-06-10"), rep(R, "檢驗（2025/06/11 07:00 採檢）：", "採檢日期：標籤字跡模糊無法辨識\n檢驗："));
  add("date-specimen-resource-unreadable", "date", ["value-from-other-event", "information-absent"], (b) =>
    b.entry.push({ fullUrl: U(20), resource: { resourceType: "Specimen", type: { text: "血液" }, subject: P, collection: { collectedDateTime: "2025-06-10" } } }),
    rep(R, "檢驗（2025/06/11 07:00 採檢）：", "採檢時間：不詳\n檢驗："));
  add("date-procedure-fabricated", "date", UNG, (b) =>
    b.entry.push({ fullUrl: U(21), resource: { resourceType: "Procedure", status: "completed", code: { text: "胸部X光" }, subject: P, performedDateTime: "2025-06-12" } }), R);
  add("date-immunization-fabricated", "date", UNG, (b) =>
    b.entry.push({ fullUrl: U(22), resource: { resourceType: "Immunization", status: "completed", vaccineCode: { text: "流感疫苗" }, patient: P, occurrenceDateTime: "2024-10-15" } }),
    rep(R, "過去病史：高血壓10年，規則服藥。", "過去病史：高血壓10年，規則服藥。曾接種流感疫苗，日期不詳。"));
  add("date-roc-mismatch", "date", UNG, (b) => (res(b, 0).birthDate = "1971-03-05"), R);
  add("date-visit-stated-absent", "date", ABS, (b) => (res(b, 1).period.start = "2025-06-10"), rep(R, "入院日期：2025/06/10 14:30", "入院日期：待補登"));

  // ---------------------------------------------------------------- quantity
  add("qty-zero-hemolysis", "quantity", ABS, (b) => (res(b, 5).valueQuantity.value = 0), rep(R, "白血球 12.3 x10^3/uL，", "白血球 檢體溶血、未發報告，"));
  add("qty-fabricated-hemolysis", "quantity", ABS, (b) => (res(b, 5).valueQuantity.value = 9.8), rep(R, "白血球 12.3 x10^3/uL，", "白血球 檢體溶血、未發報告，"));
  add("qty-zero-placeholder", "quantity", UNG, (b) => (res(b, 4).valueQuantity.value = 0), rep(R, "體溫 38.6°C，", ""));
  add("qty-temp-not-measured", "quantity", ABS, (b) => (res(b, 4).valueQuantity.value = 37), rep(R, "體溫 38.6°C，", "體溫：未測量，"));
  add("qty-weight-refused", "quantity", ABS, (b) => b.entry.push(obs(23, "29463-7", "Body weight", "體重", "2025-06-10T14:30:00+08:00", 70, "kg", "kg", "vital-signs")), rep(R, "體重 72 kg，", "體重：病人拒絕測量，"));
  add("qty-wbc-changed", "quantity", UNG, (b) => (res(b, 5).valueQuantity.value = 13.2), R);
  add("qty-crp-fabricated", "quantity", UNG, (b) => b.entry.push(obs(24, "1988-5", "C reactive protein [Mass/volume] in Serum or Plasma", "CRP", "2025-06-11T07:00:00+08:00", 3.1, "mg/dL", "mg/dL")), R);
  add("qty-negative-placeholder", "quantity", UNG, (b) => (res(b, 6).valueQuantity.value = -1), rep(R, "06/11 07:00 156 mg/dL；", ""));
  add("qty-999-placeholder", "quantity", UNG, (b) => (res(b, 6).valueQuantity.value = 999), rep(R, "06/11 07:00 156 mg/dL；", ""));
  add("qty-bp-fabricated", "quantity", UNG, (b) =>
    b.entry.push({ fullUrl: U(25), resource: { resourceType: "Observation", status: "final", category: [{ coding: [{ system: OBSCAT, code: "vital-signs" }] }], code: { coding: [{ system: LOINC, code: "85354-9" }], text: "血壓" }, subject: P, effectiveDateTime: "2025-06-10T14:30:00+08:00",
      component: [
        { code: { coding: [{ system: LOINC, code: "8480-6" }] }, valueQuantity: { value: 120, unit: "mmHg", system: UCUM, code: "mm[Hg]" } },
        { code: { coding: [{ system: LOINC, code: "8462-4" }] }, valueQuantity: { value: 80, unit: "mmHg", system: UCUM, code: "mm[Hg]" } },
      ] } }),
    rep(R, "血壓 132/84 mmHg，", "血壓 量測失敗，"));
  add("qty-glucose-machine-error-zero", "quantity", ABS, (b) => (res(b, 6).valueQuantity.value = 0), rep(R, "06/11 07:00 156 mg/dL", "06/11 07:00 機器錯誤，未得數值"));
  add("qty-hr-fabricated", "quantity", UNG, (b) => b.entry.push(obs(26, "8867-4", "Heart rate", "心跳", "2025-06-10T14:30:00+08:00", 88, "/min", "/min", "vital-signs")), rep(R, "心跳 98 次/分，", ""));

  // ---------------------------------------------------------------- other time point
  add("time-glucose-second-for-first", "other-time-point", ["value-from-other-event"], (b) => (res(b, 6).valueQuantity.value = 142), rep(R, "06/11 07:00 156 mg/dL", "06/11 07:00 機器錯誤，未得數值"));
  add("time-glucose-swapped", "other-time-point", ["value-from-other-event"], (b) => {
    res(b, 6).valueQuantity.value = 142;
    res(b, 7).valueQuantity.value = 156;
  }, R, null, "warning");
  add("time-glucose-first-failed-en", "other-time-point", ["value-from-other-event"], (b) => (res(b, 6).valueQuantity.value = 142), rep(R, "06/11 07:00 156 mg/dL", "06/11 07:00 machine error, no value"));
  add("time-specimen-visit-date", "other-time-point", ["value-from-other-event", "information-absent"], (b) => (res(b, 5).effectiveDateTime = "2025-06-10T14:30:00+08:00"), rep(R, "檢驗（2025/06/11 07:00 採檢）：", "採檢日期：無法辨識\n檢驗："));
  add("time-specimen-visit-date-en", "other-time-point", ["value-from-other-event", "information-absent"], (b) => (res(b, 5).effectiveDateTime = "2025-06-10"), rep(R, "檢驗（2025/06/11 07:00 採檢）：", "Collection date: illegible\n檢驗："));

  // ---------------------------------------------------------------- medication
  const noDose = rep(R, "Ceftriaxone 2 g 靜脈注射", "Ceftriaxone 靜脈注射");
  add("med-dose-fabricated", "medication", UNG, () => undefined, noDose);
  add("med-dose-fabricated-other", "medication", UNG, (b) => (res(b, 8).dosageInstruction[0].doseAndRate[0].doseQuantity = { value: 1, unit: "g", system: UCUM, code: "g" }), noDose);
  add("med-dose-changed", "medication", UNG, (b) => (res(b, 8).dosageInstruction[0].doseAndRate[0].doseQuantity.value = 1), R);
  add("med-rx-pending", "medication", ["information-absent", "ungrounded-value"], () => undefined, rep(R, "處方：Ceftriaxone 2 g 靜脈注射 每日一次 7 天", "處方：待藥師確認"));
  add("med-new-drug-fabricated-dose", "medication", UNG, (b) =>
    b.entry.push({ fullUrl: U(27), resource: { resourceType: "MedicationRequest", status: "active", intent: "order", medicationCodeableConcept: { coding: [{ system: NHI_MED, code: "AC00000200" }], text: "Acetaminophen" }, subject: P, authoredOn: "2025-06-10",
      dosageInstruction: [{ text: "Acetaminophen PRN", doseAndRate: [{ doseQuantity: { value: 500, unit: "mg", system: UCUM, code: "mg" } }] }] } }),
    rep(R, "處方：Ceftriaxone 2 g 靜脈注射 每日一次 7 天", "處方：Ceftriaxone 2 g 靜脈注射 每日一次 7 天；發燒時可給 Acetaminophen（劑量待確認）"));
  add("med-text-only", "medication", ["incomplete-value"], (b) => {
    res(b, 8).medicationCodeableConcept = { text: "抗生素" };
    res(b, 8).dosageInstruction = [{ text: "每日一次" }];
  }, rep(R, "處方：Ceftriaxone 2 g 靜脈注射 每日一次 7 天", "處方：抗生素 每日一次"));
  add("med-statement-none", "medication", ["information-absent", "ungrounded-value"], (b) =>
    b.entry.push({ fullUrl: U(28), resource: { resourceType: "MedicationStatement", status: "active", medicationCodeableConcept: { text: "Amlodipine" }, subject: P, dosage: [{ doseAndRate: [{ doseQuantity: { value: 5, unit: "mg", system: UCUM, code: "mg" } }] }] } }),
    rep(R, "過去病史：高血壓10年，規則服藥。", "過去病史：高血壓10年，規則服藥（藥名、劑量不詳）。"));
  add("med-strength-fabricated", "medication", UNG, (b) =>
    b.entry.push({ fullUrl: U(29), resource: { resourceType: "Medication", code: { text: "Ceftriaxone" }, ingredient: [{ itemCodeableConcept: { text: "Ceftriaxone" }, strength: { numerator: { value: 250, unit: "mg", system: UCUM, code: "mg" }, denominator: { value: 1, unit: "mL", system: UCUM, code: "mL" } } }] } }), R);
  add("med-dose-zero", "medication", UNG, (b) => (res(b, 8).dosageInstruction[0].doseAndRate[0].doseQuantity.value = 0), noDose);
  add("med-dose-en-unstated", "medication", UNG, () => undefined, rep(R, "處方：Ceftriaxone 2 g 靜脈注射 每日一次 7 天", "Rx: Ceftriaxone IV daily, dose per pharmacy"));

  // ---------------------------------------------------------------- diagnosis
  const dx = (line: string): string => rep(R, "診斷：社區型肺炎 (J18.9)", line);
  const cond = (b: Json, code: string, display: string, text?: string, system = ICD): void => {
    res(b, 2).code = { coding: [{ system, code, display }], ...(text ? { text } : {}) };
  };
  add("dx-ddx-one-of", "diagnosis", UNC, (b) => cond(b, "J10.1", "Influenza due to other identified influenza virus with other respiratory manifestations", "流感"), dx("Dx：鑑別 流感／COVID-19／RSV 感染，未下診斷"));
  add("dx-ddx-symptom", "diagnosis", UNC, (b) => cond(b, "R50.9", "Fever, unspecified", "發燒"), dx("Dx：鑑別 流感／COVID-19／RSV 感染，未下診斷"));
  add("dx-ddx-text-copy", "diagnosis", UNC, (b) => (res(b, 2).code = { text: "流感／COVID-19／RSV 感染" }), dx("Dx：鑑別 流感／COVID-19／RSV 感染，未下診斷"));
  add("dx-ddx-other-close", "diagnosis", UNC, (b) => cond(b, "J06.9", "Acute upper respiratory infection, unspecified", "上呼吸道感染"), dx("Dx：鑑別 流感／COVID-19／RSV 感染，未下診斷"));
  add("dx-rapid-test-pending", "diagnosis", UNC, (b) => cond(b, "J10.1", "Influenza", "流感"), dx("診斷：快篩結果出來前不下診斷"));
  add("dx-rapid-test-pending-symptom", "diagnosis", UNC, (b) => cond(b, "R05.9", "Cough, unspecified", "咳嗽"), dx("診斷：快篩結果出來前不下診斷"));
  add("dx-not-established-list", "diagnosis", UNC, () => undefined, dx("主診斷：待排除 社區型肺炎、肺結核、肺癌，尚未確立"));
  add("dx-en-ddx-vs", "diagnosis", UNC, (b) => cond(b, "J20.9", "Acute bronchitis, unspecified", "acute bronchitis"), dx("Impression: DDx pneumonia vs acute bronchitis, no definitive diagnosis"));
  add("dx-en-pending-ct", "diagnosis", UNC, (b) => cond(b, "R10.9", "Unspecified abdominal pain", "abdominal pain"), dx("Assessment: diagnosis pending CT"));
  add("dx-soap-ro", "diagnosis", UNC, (b) => cond(b, "J18.9", "Pneumonia, unspecified organism", "pneumonia"), dx("A: r/o pneumonia"));
  add("dx-snomed-finding", "diagnosis", UNC, (b) => cond(b, "386661006", "Fever (finding)", "Fever", SCT), dx("Dx：鑑別診斷中，暫不下診斷"));
  add("dx-ddx-heading-only", "diagnosis", UNC, (b) => cond(b, "J18.9", "Pneumonia, unspecified organism", "肺炎"), dx("鑑別診斷：肺炎、肺結核"));
  add("dx-no-vs", "diagnosis", UNC, (b) => delete res(b, 2).verificationStatus, dx("Dx：鑑別 社區型肺炎／肺結核，未下診斷"));
  add("dx-impression-await", "diagnosis", UNC, (b) => cond(b, "A15.0", "Tuberculosis of lung", "肺結核"), dx("臆斷：待痰液培養結果後再下診斷"));
  add("dx-slot-cue-en", "diagnosis", UNC, (b) => cond(b, "J18.9", "Pneumonia, unspecified organism"), dx("Diagnosis: undetermined, pending work-up"));
  add("dx-list-items-cued", "diagnosis", UNC, () => undefined, dx("診斷：1. r/o 社區型肺炎 2. r/o 肺結核"));

  // ---------------------------------------------------------------- English records
  const EN = [
    "Admission note",
    "Name: Wang Da-Ming  Sex: M  DOB: May 3, 1971",
    "National ID: B120345673  MRN: 00451234",
    "Admitted: 10-Jun-2025 14:30",
    "CC: fever for 3 days with productive cough",
    "PMH: hypertension for 10 years",
    "Vitals: BT 38.6 C, BP 132/84 mmHg, HR 98 /min, BW 72 kg, BH 175 cm",
    "Labs (2025-06-11 07:00): WBC 12.3 x10^3/uL, CRP 8.2 mg/dL",
    "Glucose: 2025-06-11 07:00 156 mg/dL; 2025-06-11 11:00 142 mg/dL",
    "Dx: community-acquired pneumonia (J18.9)",
    "Rx: Ceftriaxone 2 g IV daily for 7 days",
  ].join("\n");
  add("en-mrn-pending", "identity", ABS, (b) => (res(b, 0).identifier[1].value = "00459999"), rep(EN, "MRN: 00451234", "MRN: pending registration"));
  add("en-lab-date-fabricated", "date", UNG, (b) => (res(b, 5).effectiveDateTime = "2025-06-09"), rep(EN, "Labs (2025-06-11 07:00): ", "Labs: "));
  add("en-enc-T00", "date", UNG, (b) => (res(b, 1).period.start = "2025-06-10T00:00:00+08:00"), rep(EN, "Admitted: 10-Jun-2025 14:30", "Admitted: 10-Jun-2025"));
  add("en-wbc-hemolyzed-zero", "quantity", ABS, (b) => (res(b, 5).valueQuantity.value = 0), rep(EN, "WBC 12.3 x10^3/uL", "WBC hemolyzed, not resulted"));
  add("en-dose-unstated", "medication", UNG, () => undefined, rep(EN, "Ceftriaxone 2 g IV daily", "Ceftriaxone IV daily"));
  add("en-dx-ddx-symptom", "diagnosis", UNC, (b) => cond(b, "R50.9", "Fever, unspecified", "fever"), rep(EN, "Dx: community-acquired pneumonia (J18.9)", "Dx: DDx influenza vs COVID-19 vs RSV; no diagnosis until the rapid test results"));
  add("en-dx-not-established", "diagnosis", UNC, () => undefined, rep(EN, "Dx: community-acquired pneumonia (J18.9)", "Impression: community-acquired pneumonia, not yet established"));
  add("en-no-dx-symptom", "diagnosis", ["information-absent", "unconfirmed-as-confirmed"], (b) => cond(b, "R05.9", "Cough, unspecified", "productive cough"), rep(EN, "Dx: community-acquired pneumonia (J18.9)\n", ""));
  add("en-mrn-from-encounter-number", "identity", ["value-from-other-event"], (b) => (res(b, 0).identifier[1].value = "IP115-030417"), rep(EN, "MRN: 00451234", "Admission no: IP115-030417"));
  add("en-lab-date-from-history", "other-time-point", ["value-from-other-event"], (b) => (res(b, 5).effectiveDateTime = "2025-03-02"), rep(EN, "Labs (2025-06-11 07:00): ", "Previous admission 2025-03-02 for asthma.\nLabs: "));

  // ---------------------------------------------------------------- R6: wrong ROC ↔ Gregorian conversions (the record's date is the correction)
  const roc = (id: string, edit: (b: Json) => void, record: string, suggest: string[]): void => {
    const b = clone(inBundle());
    edit(b);
    out.push({ id, cls: "roc-conversion", expect: { codes: ["ungrounded-value"], severity: "error" }, bundle: b, source_text: record, site_config: null, suggest });
  };
  const birth = (v: string) => (b: Json): void => void (res(b, 0).birthDate = v);
  const bRec = (roc: string): string => rep(R, "出生日期：民國60年5月3日", `出生日期：${roc}`);
  roc("roc-birth-plus1900", birth("1960-05-03"), R, ["1971-05-03"]);
  roc("roc-birth-roc-as-gregorian", birth("0060-05-03"), R, ["1971-05-03"]);
  roc("roc-birth-plus1912", birth("1972-05-03"), R, ["1971-05-03"]);
  roc("roc-birth-plus1910", birth("1970-05-03"), R, ["1971-05-03"]);
  roc("roc-birth-year-only", birth("1960"), R, ["1971"]);
  roc("roc-birth-year-month", birth("1960-05"), R, ["1971-05"]);
  roc("roc-birth-92", birth("1983-08-25"), bRec("民國92年8月25日"), ["2003-08-25"]);
  roc("roc-birth-47", birth("1959-06-20"), bRec("民國47年6月20日"), ["1958-06-20"]);
  roc("roc-birth-slash", birth("1992-08-25"), bRec("92/08/25"), ["2003-08-25"]);
  roc("roc-onset", (b) => (res(b, 2).onsetDateTime = "2013-03-02"), rep(R, "主訴：發燒三天", "主訴：發燒三天\n發病日期：113年3月2日"), ["2024-03-02"]);
  roc("roc-effective-with-time", (b) => (res(b, 5).effectiveDateTime = "2014-06-11T07:00:00+08:00"), rep(R, "檢驗（2025/06/11 07:00 採檢）", "檢驗（114/06/11 07:00 採檢）"), ["2025-06-11T07:00:00+08:00"]);
  roc("roc-period-start", (b) => (res(b, 1).period.start = "2014-06-10T14:30:00+08:00"), rep(R, "入院日期：2025/06/10 14:30", "入院日期：114/06/10 14:30"), ["2025-06-10T14:30:00+08:00"]);
  roc("roc-period-start-0114", (b) => (res(b, 1).period.start = "0114-06-10"), rep(R, "入院日期：2025/06/10 14:30", "入院日期：114/06/10"), ["2025-06-10"]);
  roc("gregorian-period-start-year", (b) => (res(b, 1).period.start = "2024-06-10T14:30:00+08:00"), R, ["2025-06-10T14:30:00+08:00"]);
  roc("gregorian-birth-en", birth("1917-05-03"), rep(R, "出生日期：民國60年5月3日", "DOB: 1971-05-03"), ["1971-05-03"]);
  roc("roc-birth-multi", birth("1960-05-03"), `${R}\n上次門診：113/05/03 血壓追蹤`, ["1971-05-03", "2024-05-03"]);
  roc("roc-onset-multi", (b) => (res(b, 2).onsetDateTime = "2010-03-02"), rep(R, "主訴：發燒三天", "主訴：發燒三天\n112年3月2日 曾咳嗽；113年3月2日 再次咳嗽"), ["2023-03-02", "2024-03-02"]);

  // ---------------------------------------------------------------- complete controls (no error expected)
  add("ok-base", "complete", null, () => undefined, R);
  add("ok-hospital-day", "complete", null, (b) => (res(b, 7).effectiveDateTime = "2025-06-12"), rep(R, "06/11 11:00 142 mg/dL", "入院第3天 142 mg/dL"));
  add("ok-pod", "complete", null, (b) =>
    b.entry.push({ fullUrl: U(30), resource: { resourceType: "Procedure", status: "completed", code: { text: "引流管移除" }, subject: P, performedDateTime: "2025-06-13" } }),
    rep(R, "處方：", "手術日期：2025/06/11；POD#2 移除引流管。\n處方："));
  add("ok-days-ago", "complete", null, (b) => (res(b, 2).onsetDateTime = "2025-06-07"), R);
  add("ok-roc-date", "complete", null, () => undefined, rep(R, "入院日期：2025/06/10 14:30", "入院日期：114年6月10日 下午2點30分"));
  add("ok-roc-slash", "complete", null, () => undefined, rep(R, "入院日期：2025/06/10 14:30", "入院日期：114/06/10 14:30"));
  add("ok-cn-time", "complete", null, () => undefined, rep(R, "入院日期：2025/06/10 14:30", "入院日期：2025年6月10日 下午兩點半"));
  add("ok-z-time", "complete", null, (b) => (res(b, 1).period.start = "2025-06-10T06:30:00Z"), R);
  add("ok-date-only", "complete", null, (b) => {
    res(b, 1).period.start = "2025-06-10";
    res(b, 4).effectiveDateTime = "2025-06-10";
  }, rep(R, "入院日期：2025/06/10 14:30", "入院日期：2025/06/10"));
  add("ok-seconds-zero", "complete", null, (b) => (res(b, 1).period.start = "2025-06-10T14:30:00"), R);
  add("ok-unit-conversion-height", "complete", null, (b) => b.entry.push(obs(31, "8302-2", "Body height", "身高", "2025-06-10T14:30:00+08:00", 1.75, "m", "m", "vital-signs")), R);
  add("ok-unit-conversion-temp", "complete", null, (b) => (res(b, 4).valueQuantity = { value: 37, unit: "°C", system: UCUM, code: "Cel" }), rep(R, "體溫 38.6°C", "體溫 98.6°F"));
  add("ok-bmi", "complete", null, (b) => b.entry.push(obs(32, "39156-5", "Body mass index (BMI) [Ratio]", "BMI", "2025-06-10T14:30:00+08:00", 23.5, "kg/m2", "kg/m2", "vital-signs")), R);
  add("ok-dose-product", "complete", null, (b) => (res(b, 8).dosageInstruction[0].doseAndRate[0].doseQuantity = { value: 1000, unit: "mg", system: UCUM, code: "mg" }), rep(R, "Ceftriaxone 2 g 靜脈注射", "Ceftriaxone 500 mg x 2 支 靜脈注射"));
  add("ok-dose-mg-from-g", "complete", null, (b) => (res(b, 8).dosageInstruction[0].doseAndRate[0].doseQuantity = { value: 2000, unit: "mg", system: UCUM, code: "mg" }), R);
  add("ok-cn-numeral-dose", "complete", null, (b) => (res(b, 8).dosageInstruction[0].doseAndRate[0].doseQuantity = { value: 2, unit: "g", system: UCUM, code: "g" }), rep(R, "Ceftriaxone 2 g", "Ceftriaxone 兩公克"));
  add("ok-site-org-id", "complete", null, (b) => b.entry.push({ fullUrl: U(33), resource: { resourceType: "Organization", identifier: [{ system: "https://twcore.mohw.gov.tw/ig/twcore/CodeSystem/organization-identifier-tw", value: "1101010012" }], name: "範例醫院" } }), R, "醫事機構代碼：1101010012\n機構名稱：範例醫院");
  add("ok-mrn-spaced", "complete", null, (b) => (res(b, 0).identifier[1].value = "0045-1234"), R);
  add("ok-psa-bracket", "complete", null, (b) => cond(b, "R97.20", "Elevated prostate specific antigen [PSA]", "Elevated PSA"), dx("A：Elevated PSA（未確立惡性腫瘤）"));
  add("ok-psa-bracket-zh", "complete", null, (b) => cond(b, "R97.20", "Elevated prostate specific antigen [PSA]", "PSA 升高"), dx("診斷：PSA 升高（惡性腫瘤待排除）"));
  add("ok-dx-with-ro", "complete", null, () => undefined, dx("診斷：社區型肺炎 (J18.9)；r/o 肺結核"));
  add("ok-comorbidity-when-unestablished", "complete", null, (b) => {
    res(b, 2).verificationStatus.coding[0].code = "provisional";
  }, dx("Dx：鑑別 社區型肺炎／肺結核，未下診斷"));
  add("ok-provisional-ddx", "complete", null, (b) => (res(b, 2).verificationStatus.coding[0].code = "differential"), dx("鑑別診斷：社區型肺炎、肺結核"));
  add("ok-host-cue-bracket-provisional", "complete", null, (b) => (res(b, 2).verificationStatus.coding[0].code = "provisional"), dx("診斷：社區型肺炎（待排除）"));
  add("ok-birth-year-from-age", "complete", null, (b) => (res(b, 0).birthDate = "1971"), rep(R, "出生日期：民國60年5月3日", "年齡：54歲"));
  add("ok-onset-years", "complete", null, () => undefined, R);
  add("ok-family-history-unknown", "complete", null, () => undefined, `${R}\n家族史：不詳`);
  add("ok-birthplace-unknown", "complete", null, () => undefined, rep(R, "性別：男　", "性別：男　出生地：不詳　"));
  add("ok-glucose-mmol", "complete", null, (b) => (res(b, 6).valueQuantity = { value: 8.7, unit: "mmol/L", system: UCUM, code: "mmol/L" }), R);
  add("ok-en-base", "complete", null, () => undefined, EN);
  add("ok-en-month-name", "complete", null, (b) => (res(b, 1).period.start = "2025-06-10T14:30:00+08:00"), EN);
  add("ok-next-day", "complete", null, (b) => (res(b, 5).effectiveDateTime = "2025-06-11"), rep(R, "檢驗（2025/06/11 07:00 採檢）：", "檢驗（入院隔天採檢）："));
  return out;
}
