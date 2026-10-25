/**
 * Synthetic dev set for the record checks (ISSUES_v15): one complete outpatient case (record +
 * Bundle) and ≥ 40 variants where the record lacks a piece of information and the Bundle fills it
 * anyway — A (an absence sentence used as the value), B (a value too coarse / incomplete to use),
 * C (an unestablished diagnosis written as established) — in Chinese and English. All names, ids
 * and records are invented; no case is taken from any dataset.
 */

type Json = Record<string, any>;

export interface SyntheticCase {
  id: string;
  type: "A" | "B" | "C" | "R2" | "complete";
  /** Expected record-check finding (code + minimum severity); null for the complete controls. */
  expect: { code: string; severity: "error" | "warning" } | null;
  bundle: Json;
  source_text: string | null;
  site_config?: string | null;
}

const MOI = "http://www.moi.gov.tw";
const MRN = "https://clinic.example.tw/mrn";
const ICD = "http://hl7.org/fhir/sid/icd-10-cm";
const LOINC = "http://loinc.org";
const UCUM = "http://unitsofmeasure.org";
const VS = "http://terminology.hl7.org/CodeSystem/condition-ver-status";

export const BASE_RECORD = [
  "門診病歷",
  "姓名：陳美玲　性別：女　出生日期：1975/08/21",
  "身分證字號：A223456781　病歷號：00881234",
  "就診日期：2025/03/14 09:20",
  "主訴：咳嗽三天",
  "生命徵象：體溫 37.8°C，心跳 92 次/分",
  "診斷：急性支氣管炎 (J20.9)",
  "處方：Amoxicillin 500 mg 口服 一天三次 7 天",
  "家族史：不詳",
].join("\n");

export const BASE_RECORD_EN = [
  "Outpatient note",
  "Name: Lin Wei-Jie  Sex: male  DOB: 1968-02-03",
  "National ID: F128803121  MRN: 00775310",
  "Visit date: 2025-04-02 14:05",
  "CC: fever for two days",
  "Vitals: BT 38.4 °C, HR 104 /min",
  "Dx: acute pharyngitis (J02.9)",
  "Rx: Acetaminophen 500 mg PO q6h prn",
  "Family history: unknown",
].join("\n");

function bundleOf(o: {
  name: string;
  family: string;
  given: string;
  nid: string;
  mrn: string;
  birth: string;
  gender: string;
  start: string;
  dx: [string, string];
  temp: number;
  med: string;
  dose: number;
  authored?: string;
}): Json {
  return {
    resourceType: "Bundle",
    type: "collection",
    entry: [
      {
        fullUrl: "urn:uuid:9b0c1f62-0000-4000-8000-000000000001",
        resource: {
          resourceType: "Patient",
          identifier: [
            { use: "official", type: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v2-0203", code: "NNxxx" }] }, system: MOI, value: o.nid },
            { type: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v2-0203", code: "MR" }] }, system: MRN, value: o.mrn },
          ],
          name: [{ text: o.name, family: o.family, given: [o.given] }],
          gender: o.gender,
          birthDate: o.birth,
        },
      },
      {
        fullUrl: "urn:uuid:9b0c1f62-0000-4000-8000-000000000002",
        resource: {
          resourceType: "Encounter",
          status: "finished",
          class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "AMB" },
          subject: { reference: "urn:uuid:9b0c1f62-0000-4000-8000-000000000001" },
          period: { start: o.start },
        },
      },
      {
        fullUrl: "urn:uuid:9b0c1f62-0000-4000-8000-000000000003",
        resource: {
          resourceType: "Condition",
          clinicalStatus: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-clinical", code: "active" }] },
          verificationStatus: { coding: [{ system: VS, code: "confirmed" }] },
          code: { coding: [{ system: ICD, code: o.dx[0], display: o.dx[1] }], text: o.dx[1] },
          subject: { reference: "urn:uuid:9b0c1f62-0000-4000-8000-000000000001" },
        },
      },
      {
        fullUrl: "urn:uuid:9b0c1f62-0000-4000-8000-000000000004",
        resource: {
          resourceType: "Observation",
          status: "final",
          code: { coding: [{ system: LOINC, code: "8310-5", display: "Body temperature" }] },
          subject: { reference: "urn:uuid:9b0c1f62-0000-4000-8000-000000000001" },
          effectiveDateTime: o.start,
          valueQuantity: { value: o.temp, unit: "°C", system: UCUM, code: "Cel" },
        },
      },
      {
        fullUrl: "urn:uuid:9b0c1f62-0000-4000-8000-000000000005",
        resource: {
          resourceType: "MedicationRequest",
          status: "active",
          intent: "order",
          medicationCodeableConcept: { coding: [{ system: "https://twcore.mohw.gov.tw/ig/twcore/CodeSystem/medication-nhi-tw", code: "AC00000100" }], text: o.med },
          subject: { reference: "urn:uuid:9b0c1f62-0000-4000-8000-000000000001" },
          authoredOn: o.authored ?? o.start,
          dosageInstruction: [{ text: `${o.med}`, doseAndRate: [{ doseQuantity: { value: o.dose, unit: "mg", system: UCUM, code: "mg" } }] }],
        },
      },
    ],
  };
}

export const BASE_BUNDLE = (): Json =>
  bundleOf({ name: "陳美玲", family: "陳", given: "美玲", nid: "A223456781", mrn: "00881234", birth: "1975-08-21", gender: "female", start: "2025-03-14T09:20:00+08:00", dx: ["J20.9", "急性支氣管炎"], temp: 37.8, med: "Amoxicillin 500 mg", dose: 500 });

export const BASE_BUNDLE_EN = (): Json =>
  bundleOf({ name: "Lin Wei-Jie", family: "Lin", given: "Wei-Jie", nid: "F128803121", mrn: "00775310", birth: "1968-02-03", gender: "male", start: "2025-04-02T14:05:00+08:00", dx: ["J02.9", "acute pharyngitis"], temp: 38.4, med: "Acetaminophen 500 mg", dose: 500 });

const clone = <T>(x: T): T => structuredClone(x);
const res = (b: Json, i: number): Json => b.entry[i].resource;

/** Replace `from` with `to` in the record (the record variant that lacks the information). */
const rec = (base: string, from: string, to: string): string => base.split(from).join(to);

export function syntheticCases(): SyntheticCase[] {
  const out: SyntheticCase[] = [];
  const add = (id: string, type: SyntheticCase["type"], expect: SyntheticCase["expect"], edit: (b: Json) => void, record: string | null, en = false): void => {
    const b = clone(en ? BASE_BUNDLE_EN() : BASE_BUNDLE());
    edit(b);
    out.push({ id, type, expect, bundle: b, source_text: record, site_config: id === "R2-site-format" ? `identifier-format ${MRN} [0-9]{8}` : null });
  };
  const absent = { code: "information-absent", severity: "error" as const };
  const fmt = { code: "identifier-format", severity: "error" as const };
  const prec = { code: "insufficient-precision", severity: "error" as const };
  const inc = { code: "incomplete-value", severity: "error" as const };
  const unconf = { code: "unconfirmed-as-confirmed", severity: "error" as const };
  const hedged = { code: "unconfirmed-as-confirmed", severity: "warning" as const };
  const symptom = { code: "symptom-for-unconfirmed-diagnosis", severity: "warning" as const };
  const R = BASE_RECORD;
  const E = BASE_RECORD_EN;

  // ---- A: an absence sentence used as the value (MRN / national ID / name / dates / codes / values)
  const mrnRec = (v: string): string => rec(R, "病歷號：00881234", `病歷號：${v}`);
  for (const [i, v] of ["新病人建檔中，尚未給號", "病歷號尚未取得", "待補", "系統建檔失敗", "取號中", "目前無法提供"].entries()) {
    add(`A-mrn-zh-${i}`, "A", absent, (b) => (res(b, 0).identifier[1].value = v), mrnRec(v));
  }
  for (const [i, v] of ["not yet assigned", "Pending registration", "N/A", "unknown", "--"].entries()) {
    add(`A-mrn-en-${i}`, "A", absent, (b) => (res(b, 0).identifier[1].value = v), rec(E, "MRN: 00775310", `MRN: ${v}`), true);
  }
  for (const [i, v] of ["家屬表示證件忘記帶來", "身分證號碼不詳", "尚在申請中", "病人拒絕提供"].entries()) {
    add(`A-nid-zh-${i}`, "A", absent, (b) => (res(b, 0).identifier[0].value = v), rec(R, "身分證字號：A223456781", `身分證字號：${v}`));
  }
  add("A-nid-en-0", "A", absent, (b) => (res(b, 0).identifier[0].value = "ID not provided by family"), rec(E, "National ID: F128803121", "National ID: not provided by family"), true);
  add("A-name-zh", "A", absent, (b) => {
    res(b, 0).name[0] = { text: "姓名不詳" };
  }, rec(R, "姓名：陳美玲", "姓名：不詳"));
  add("A-name-en", "A", absent, (b) => {
    res(b, 0).name[0] = { text: "Unknown" };
  }, rec(E, "Name: Lin Wei-Jie", "Name: unknown"), true);
  add("A-date-zh", "A", absent, (b) => (res(b, 1).period.start = "日期不詳"), rec(R, "就診日期：2025/03/14 09:20", "就診日期：不詳"));
  add("A-date-en", "A", absent, (b) => (res(b, 1).period.start = "unknown"), rec(E, "Visit date: 2025-04-02 14:05", "Visit date: unknown"), true);
  add("A-value-zh", "A", absent, (b) => (res(b, 3).valueQuantity.value = "未測量"), rec(R, "體溫 37.8°C", "體溫 未測量"));
  add("A-value-en", "A", absent, (b) => (res(b, 3).valueQuantity.value = "not measured"), rec(E, "BT 38.4 °C", "BT not measured"), true);
  add("A-code-zh", "A", absent, (b) => (res(b, 2).code = { text: "診斷待確認" }), rec(R, "診斷：急性支氣管炎 (J20.9)", "診斷：待確認"));
  add("A-code-en", "A", absent, (b) => (res(b, 2).code.coding[0].code = "pending"), rec(E, "Dx: acute pharyngitis (J02.9)", "Dx: pending"), true);
  add("A-ref", "A", absent, (b) => (res(b, 1).subject = { display: "不詳" }), R);

  // ---- R2: identifier formats
  add("R2-checksum", "R2", fmt, (b) => (res(b, 0).identifier[0].value = "A223456789"), R);
  add("R2-checksum-nosource", "R2", fmt, (b) => (res(b, 0).identifier[0].value = "A223456789"), null);
  add("R2-checksum-as-recorded", "R2", { code: "identifier-format", severity: "warning" }, (b) => (res(b, 0).identifier[0].value = "A223456789"), rec(R, "A223456781", "A223456789"));
  add("R2-site-format", "R2", fmt, (b) => (res(b, 0).identifier[1].value = "88-1234"), mrnRec("88-1234"));
  add("R2-shape", "R2", fmt, (b) => (res(b, 0).identifier[0].value = "A22345"), rec(R, "A223456781", "A22345"));
  add("R2-resident-under-moi", "R2", fmt, (b) => (res(b, 0).identifier[0].value = "F800312747"), rec(R, "A223456781", "F800312747"));
  add("R2-sentence-mrn", "R2", fmt, (b) => (res(b, 0).identifier[1].value = "請見住院病歷首頁"), mrnRec("請見住院病歷首頁"));

  // ---- B: too coarse / incomplete
  add("B-enc-month-zh", "B", prec, (b) => (res(b, 1).period.start = "2025-03"), rec(R, "就診日期：2025/03/14 09:20", "就診日期：三月份就診"));
  add("B-enc-month-zh-has-day", "B", prec, (b) => (res(b, 1).period.start = "2025-03"), R);
  add("B-enc-year-en", "B", prec, (b) => (res(b, 1).period.start = "2025"), rec(E, "Visit date: 2025-04-02 14:05", "Visit: sometime in 2025"), true);
  add("B-obs-month", "B", prec, (b) => (res(b, 3).effectiveDateTime = "2025-03"), rec(R, "就診日期：2025/03/14 09:20", "就診月份：2025年3月"));
  add("B-authored-month-en", "B", prec, (b) => (res(b, 4).authoredOn = "2025-04"), rec(E, "Visit date: 2025-04-02 14:05", "Visit date: April 2025"), true);
  add("B-qty-novalue-zh", "B", inc, (b) => delete res(b, 3).valueQuantity.value, rec(R, "體溫 37.8°C，", ""));
  add("B-qty-null-en", "B", inc, (b) => (res(b, 3).valueQuantity.value = null), rec(E, "BT 38.4 °C, ", ""), true);
  add("B-qty-novalue-has", "B", inc, (b) => delete res(b, 3).valueQuantity.value, R);
  add("B-med-text-only-zh", "B", inc, (b) => {
    res(b, 4).medicationCodeableConcept = { text: "抗生素 一天三次" };
    res(b, 4).dosageInstruction = [{ text: "一天三次" }];
  }, rec(R, "處方：Amoxicillin 500 mg 口服 一天三次 7 天", "處方：抗生素 一天三次"));
  add("B-med-text-dose-in-text", "B", inc, (b) => {
    res(b, 4).medicationCodeableConcept = { text: "Amoxicillin 500 mg" };
    res(b, 4).dosageInstruction = [{ text: "口服 一天三次" }];
  }, R);
  add("B-med-text-only-en", "B", inc, (b) => {
    res(b, 4).medicationCodeableConcept = { text: "pain killer" };
    delete res(b, 4).dosageInstruction;
  }, rec(E, "Rx: Acetaminophen 500 mg PO q6h prn", "Rx: pain killer as needed"), true);
  add("B-dose-novalue", "B", inc, (b) => delete res(b, 4).dosageInstruction[0].doseAndRate[0].doseQuantity.value, rec(R, "Amoxicillin 500 mg", "Amoxicillin"));

  // ---- C: unestablished diagnoses written as established
  const dxRec = (line: string): string => rec(R, "診斷：急性支氣管炎 (J20.9)", line);
  add("C-rule-out-zh", "C", unconf, () => undefined, dxRec("診斷：急性支氣管炎待排除，尚未確立"));
  add("C-list-zh", "C", unconf, () => undefined, dxRec("主診斷：待排除 肺炎、急性支氣管炎、氣喘，尚未確立"));
  add("C-ddx-zh", "C", unconf, () => undefined, dxRec("鑑別診斷：急性支氣管炎、百日咳"));
  add("C-ro-en", "C", unconf, () => undefined, rec(E, "Dx: acute pharyngitis (J02.9)", "Impression: r/o acute pharyngitis"), true);
  add("C-not-established-en", "C", unconf, () => undefined, rec(E, "Dx: acute pharyngitis (J02.9)", "Dx: acute pharyngitis, not yet established"), true);
  add("C-no-vs-zh", "C", unconf, (b) => delete res(b, 2).verificationStatus, dxRec("診斷：急性支氣管炎？尚未確診"));
  add("C-suspected-zh", "C", hedged, () => undefined, dxRec("診斷：疑似急性支氣管炎"));
  add("C-possible-en", "C", hedged, () => undefined, rec(E, "Dx: acute pharyngitis (J02.9)", "Dx: possible acute pharyngitis"), true);
  add("C-symptom-code", "C", symptom, (b) => (res(b, 2).code = { coding: [{ system: ICD, code: "R05.9", display: "Cough, unspecified" }], text: "咳嗽" }), dxRec("主診斷：待排除肺炎，尚未確立"));

  // ---- complete controls (no finding expected)
  out.push({ id: "complete-zh", type: "complete", expect: null, bundle: BASE_BUNDLE(), source_text: R });
  out.push({ id: "complete-en", type: "complete", expect: null, bundle: BASE_BUNDLE_EN(), source_text: E });
  out.push({ id: "complete-zh-nosource", type: "complete", expect: null, bundle: BASE_BUNDLE(), source_text: null });
  const prov = clone(BASE_BUNDLE());
  res(prov, 2).verificationStatus.coding[0].code = "provisional";
  out.push({ id: "complete-provisional", type: "complete", expect: null, bundle: prov, source_text: dxRec("診斷：急性支氣管炎待排除") });
  out.push({ id: "complete-confirmed-later", type: "complete", expect: null, bundle: BASE_BUNDLE(), source_text: dxRec("主訴懷疑急性支氣管炎；診斷：經胸部 X 光證實為急性支氣管炎") });
  out.push({ id: "complete-other-ro", type: "complete", expect: null, bundle: BASE_BUNDLE(), source_text: dxRec("診斷：急性支氣管炎；r/o 肺炎") });
  return out;
}
