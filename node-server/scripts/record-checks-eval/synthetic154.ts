/**
 * Synthetic dev set for ISSUES_v15.4 (empty shells: a resource without its primary value, the absence explained in a
 * side field). Built on the v15.1 inpatient case (synthetic151.ts). All names, numbers and records are invented; nothing
 * comes from any dataset.
 *
 *   obs   Observation without value[x] / component values, note / dataAbsentReason / narrative / valueString saying the
 *         result is not out / rejected / machine error (incl. 「檢體溶血，未發報 (< 14)」 with a bracketed limit);
 *   med   MedicationRequest / MedicationStatement without structured dose or timing, dosage text / note saying the dose is
 *         undecided / depends on a result still to come;
 *   dx    Condition without coding, text saying the diagnosis cannot be told apart / is pending;
 *   nosrc the same shells without source_text (warning expected);
 *   complete controls (no error expected): panels, not-done tests, cancelled orders, structured doses with text, sliding
 *         scales, text-only Conditions in complete records, qualitative text results, monitoring statements.
 */
import { IN_RECORD, inBundle } from "./synthetic151.js";

type Json = Record<string, any>;

export type V154Form = "obs" | "med" | "dx" | "nosrc" | "complete";

export interface V154Case {
  id: string;
  form: V154Form;
  /** Expected severity of an information-absent / unconfirmed-as-confirmed issue on the shell's entry; null for controls. */
  expect: "error" | "warning" | null;
  /** Entry index of the shell. */
  entry: number;
  bundle: Json;
  source_text: string | null;
  site_config: string | null;
}

const LOINC = "http://loinc.org";
const UCUM = "http://unitsofmeasure.org";
const OBSCAT = "http://terminology.hl7.org/CodeSystem/observation-category";
const DAR = "http://terminology.hl7.org/CodeSystem/data-absent-reason";
const NHI_MED = "https://twcore.mohw.gov.tw/ig/twcore/CodeSystem/medication-nhi-tw";
const CAT = "http://terminology.hl7.org/CodeSystem/condition-category";
const U = (n: number): string => `urn:uuid:7c1e0d52-0000-4000-8000-${String(n).padStart(12, "0")}`;
const P = { reference: U(1) };
const R = IN_RECORD;
const clone = <T>(x: T): T => structuredClone(x);
const res = (b: Json, i: number): Json => b.entry[i].resource;
const rep = (base: string, from: string, to: string): string => {
  if (!base.includes(from)) throw new Error(`synthetic154: '${from}' not in the record`);
  return base.split(from).join(to);
};
/** The record with an extra line before the glucose line. */
const withLine = (line: string, base = R): string => rep(base, "血糖：", `${line}\n血糖：`);
const dar = (code: string, text?: string): Json => ({ coding: [{ system: DAR, code }], ...(text ? { text } : {}) });

function lab(n: number, code: string, display: string, text: string, extra: Json, status = "final"): Json {
  return {
    fullUrl: U(n),
    resource: { resourceType: "Observation", status, category: [{ coding: [{ system: OBSCAT, code: "laboratory" }] }], code: { coding: [{ system: LOINC, code, display }], text }, subject: P, effectiveDateTime: "2025-06-11T07:00:00+08:00", ...extra },
  };
}

function medReq(n: number, name: string, extra: Json, rt = "MedicationRequest"): Json {
  return {
    fullUrl: U(n),
    resource: {
      resourceType: rt, status: rt === "MedicationRequest" ? "active" : "active", ...(rt === "MedicationRequest" ? { intent: "order", authoredOn: "2025-06-10" } : {}),
      medicationCodeableConcept: { coding: [{ system: NHI_MED, code: `AC${String(n).padStart(8, "0")}` }], text: name }, subject: P, ...extra,
    },
  };
}

function condText(n: number, text: string, extra: Json = {}): Json {
  return { fullUrl: U(n), resource: { resourceType: "Condition", clinicalStatus: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-clinical", code: "active" }] }, category: [{ coding: [{ system: CAT, code: "encounter-diagnosis" }] }], code: { text }, subject: P, ...extra } };
}

const K = ["2823-3", "Potassium [Moles/volume] in Serum or Plasma"] as const;

export function syntheticV154Cases(): V154Case[] {
  const out: V154Case[] = [];
  const add = (id: string, form: V154Form, expect: V154Case["expect"], entry: Json | ((b: Json) => number), record: string | null): void => {
    const b = clone(inBundle());
    let ei: number;
    if (typeof entry === "function") ei = entry(b);
    else {
      b.entry.push(entry);
      ei = b.entry.length - 1;
    }
    out.push({ id, form, expect, entry: ei, bundle: b, source_text: record, site_config: null });
  };
  const replaceDx = (text: string, extra: Json = {}) => (b: Json): number => {
    b.entry[2] = condText(3, text, extra);
    return 2;
  };

  // ------------------------------------------------------------------ obs: Observation shells
  add("obs-k-hemolysis-not-reported", "obs", "error", lab(40, K[0], K[1], "鉀", { note: [{ text: "檢體溶血，不予發報；當日未再重抽" }] }), withLine("鉀：檢體溶血，不予發報，當日未再重抽"));
  add("obs-uacr-rejected-dar", "obs", "error", lab(41, "14959-1", "Microalbumin/Creatinine [Mass Ratio] in Urine", "尿液微白蛋白", { dataAbsentReason: dar("unknown"), note: [{ text: "尿量不足，檢驗科退件，尚未送回" }] }), withLine("尿液微白蛋白：尿量不足，檢驗科退件，尚未送回"));
  add("obs-a1c-sent-out", "obs", "error", lab(42, "4548-4", "Hemoglobin A1c/Hemoglobin.total in Blood", "HbA1c", { note: [{ text: "外送檢驗所，報告尚未回傳" }] }), withLine("HbA1c：外送檢驗所，報告尚未回傳"));
  add("obs-poc-glucose-err", "obs", "error", lab(43, "2345-7", "Glucose [Mass/volume] in Serum or Plasma", "指尖血糖", { note: [{ text: "機器顯示 Err-3，未得數值" }] }), withLine("指尖血糖：機器顯示 Err-3，未得數值"));
  add("obs-ammonia-limit-valuestring", "obs", "error", lab(44, "16362-6", "Ammonia [Moles/volume] in Plasma", "血氨", { valueString: "檢體溶血，未發報 (< 14)" }), withLine("血氨：檢體溶血，未發報 (< 14)"));
  add("obs-crp-dar-only", "obs", "error", (b) => {
    b.entry.push(lab(45, "1988-5", "C reactive protein [Mass/volume] in Serum or Plasma", "CRP", { dataAbsentReason: dar("temp-unknown") }));
    return b.entry.length - 1;
  }, rep(R, "CRP 8.2 mg/dL", "CRP 報告未出"));
  add("obs-pct-registered-en", "obs", "error", lab(46, "33959-8", "Procalcitonin [Mass/volume] in Serum or Plasma", "Procalcitonin", { note: [{ text: "result pending" }] }, "registered"), withLine("Procalcitonin: result pending"));
  add("obs-k-en-hemolyzed", "obs", "error", lab(47, K[0], K[1], "Potassium", { note: [{ text: "Specimen hemolyzed, not reported" }] }), withLine("K (potassium): specimen hemolyzed, not reported"));
  add("obs-lactate-qns", "obs", "error", lab(48, "2524-7", "Lactate [Moles/volume] in Serum or Plasma", "Lactate", { note: [{ text: "QNS, recollect requested" }] }), withLine("Lactate: QNS, recollect requested"));
  add("obs-glucometer-error-en", "obs", "error", lab(49, "2345-7", "Glucose [Mass/volume] in Serum or Plasma", "POC glucose", { note: [{ text: "Glucometer error, no reading" }] }), withLine("POC glucose: glucometer error, no reading"));
  add("obs-bp-components-device", "obs", "error", {
    fullUrl: U(50), resource: { resourceType: "Observation", status: "final", category: [{ coding: [{ system: OBSCAT, code: "vital-signs" }] }], code: { coding: [{ system: LOINC, code: "85354-9" }], text: "血壓" }, subject: P, effectiveDateTime: "2025-06-10T14:30:00+08:00",
      component: [{ code: { coding: [{ system: LOINC, code: "8480-6" }] } }, { code: { coding: [{ system: LOINC, code: "8462-4" }] } }], note: [{ text: "血壓計故障，未量得" }] },
  }, rep(R, "血壓 132/84 mmHg，", "血壓 血壓計故障，未量得；"));
  add("obs-blood-culture-pending", "obs", "error", lab(51, "600-7", "Bacteria identified in Blood by Culture", "血液培養", { note: [{ text: "培養中，尚無結果" }] }, "preliminary"), withLine("血液培養：培養中，尚無結果"));
  add("obs-wbc-dar-text", "obs", "error", (b) => {
    delete res(b, 5).valueQuantity;
    res(b, 5).dataAbsentReason = dar("unknown", "報告未回");
    return 5;
  }, rep(R, "白血球 12.3 x10^3/uL，", "白血球 報告未回，"));
  add("obs-glucose-redraw-note", "obs", "error", (b) => {
    delete res(b, 6).valueQuantity;
    res(b, 6).note = [{ text: "待重抽" }];
    return 6;
  }, rep(R, "06/11 07:00 156 mg/dL", "06/11 07:00 待重抽"));
  add("obs-sodium-narrative", "obs", "error", lab(52, "2951-2", "Sodium [Moles/volume] in Serum or Plasma", "鈉", { text: { status: "generated", div: "<div xmlns=\"http://www.w3.org/1999/xhtml\">鈉：檢體凝固，退件</div>" } }), withLine("鈉：檢體凝固，退件"));
  add("obs-valuestring-rejected-volume", "obs", "error", lab(53, "2160-0", "Creatinine [Mass/volume] in Serum or Plasma", "Creatinine", { valueString: "Specimen rejected (insufficient volume)" }), withLine("Creatinine: specimen rejected (insufficient volume)"));
  add("obs-cxr-report-not-out", "obs", "error", {
    fullUrl: U(54), resource: { resourceType: "Observation", status: "preliminary", category: [{ coding: [{ system: OBSCAT, code: "imaging" }] }], code: { coding: [{ system: LOINC, code: "36643-5", display: "XR Chest 2 Views" }], text: "胸部X光" }, subject: P, note: [{ text: "報告還沒出來" }] },
  }, withLine("胸部X光：已照，報告還沒出來"));
  add("obs-ddimer-in-lab", "obs", "error", lab(55, "48065-7", "Fibrin D-dimer FEU [Mass/volume] in Platelet poor plasma", "D-dimer", { note: [{ text: "檢驗中" }] }), withLine("D-dimer：檢驗中"));
  add("obs-vitd-awaiting", "obs", "error", lab(56, "1989-3", "25-Hydroxyvitamin D3 [Mass/volume] in Serum or Plasma", "Vitamin D", { note: [{ text: "awaiting result from reference lab" }] }), withLine("Vitamin D: awaiting result from reference lab"));
  add("obs-inr-instrument-dar-error", "obs", "error", lab(57, "6301-6", "INR in Platelet poor plasma by Coagulation assay", "INR", { dataAbsentReason: dar("error"), note: [{ text: "儀器錯誤" }] }), withLine("INR：儀器錯誤，未得數值"));
  add("obs-esr-volume", "obs", "error", lab(58, "4537-7", "Erythrocyte sedimentation rate by Westergren method", "ESR", { note: [{ text: "樣本量不足，無法檢驗" }] }), withLine("ESR：樣本量不足，無法檢驗"));
  add("obs-lipase-not-yet-available", "obs", "error", lab(59, "3040-3", "Lipase [Enzymatic activity/volume] in Serum or Plasma", "Lipase", { note: [{ text: "Result not yet available" }] }), withLine("Lipase: result not yet available"));
  add("obs-urine-culture-rejected", "obs", "error", lab(60, "630-4", "Bacteria identified in Urine by Culture", "尿液培養", { note: [{ text: "退件，請重新送檢" }] }), withLine("尿液培養：退件，請重新送檢"));
  add("obs-awaits-lab-callback", "obs", "error", lab(61, "2276-4", "Ferritin [Mass/volume] in Serum or Plasma", "Ferritin", { note: [{ text: "結果要看檢驗科回報" }] }), withLine("Ferritin：結果要看檢驗科回報"));
  add("obs-paraphrased-note", "obs", "error", lab(62, "3016-3", "Thyrotropin [Units/volume] in Serum or Plasma", "TSH", { note: [{ text: "報告尚未出來" }] }), withLine("甲狀腺功能 TSH：外送，報告尚未出來"));

  add("obs-report-not-back-colloquial", "obs", "error", lab(63, "2085-9", "Cholesterol in HDL [Mass/volume] in Serum or Plasma", "HDL", { note: [{ text: "報告還沒回來" }] }), withLine("HDL：抽了，報告還沒回來"));
  add("obs-en-hemolyzed-redraw", "obs", "error", lab(64, "2532-0", "Lactate dehydrogenase [Enzymatic activity/volume] in Serum or Plasma", "LDH", { note: [{ text: "Hemolyzed sample, will redraw" }] }), withLine("LDH: hemolyzed sample, will redraw"));
  add("obs-en-unable-to-obtain", "obs", "error", lab(65, "2019-8", "Carbon dioxide [Partial pressure] in Arterial blood", "ABG pCO2", { note: [{ text: "Unable to obtain specimen" }] }), withLine("ABG: unable to obtain specimen, will retry"));

  // ------------------------------------------------------------------ med: dose / timing shells
  add("med-vanco-depends-on-cr", "med", "error", medReq(70, "Vancomycin", { dosageInstruction: [{ text: "每次劑量與頻次要看 Cr 報告（已抽，未回）依腎功能調整" }] }), rep(R, "處方：Ceftriaxone 2 g 靜脈注射 每日一次 7 天", "處方：Ceftriaxone 2 g 靜脈注射 每日一次 7 天；Vancomycin，每次劑量與頻次要看 Cr 報告（已抽，未回）依腎功能調整"));
  add("med-insulin-dose-undecided-en", "med", "error", medReq(71, "Insulin glargine", { note: [{ text: "Dose undecided, pending morning blood glucose" }] }), withLine("Insulin glargine: dose undecided, pending morning blood glucose"));
  add("med-insulin-await-attending", "med", "error", medReq(72, "Insulin", { dosageInstruction: [{ text: "睡前使用，劑量待主治醫師決定" }] }), withLine("Insulin：睡前使用，劑量待主治醫師決定"));
  add("med-metformin-statement", "med", "error", medReq(73, "Metformin", { dosage: [{ text: "依血糖結果調整" }], note: [{ text: "目前劑量未定" }] }, "MedicationStatement"), withLine("Metformin：劑量依血糖結果調整，目前劑量未定"));
  add("med-gentamicin-tbd-en", "med", "error", medReq(74, "Gentamicin", { dosageInstruction: [{ text: "to be determined after renal panel" }] }), withLine("Gentamicin: dose to be determined after renal panel"));
  add("med-cefazolin-culture", "med", "error", medReq(75, "Cefazolin", { dosageInstruction: [{ text: "視培養結果而定" }] }), withLine("Cefazolin：療程與劑量視培養結果而定"));
  add("med-warfarin-await-inr", "med", "error", medReq(76, "Warfarin", { note: [{ text: "等報告再開劑量" }] }), withLine("Warfarin：等 INR 報告再開劑量"));
  add("med-heparin-on-hold", "med", "error", (b) => {
    const m = medReq(77, "Heparin", { statusReason: { text: "待 CT 結果再決定" } });
    m.resource.status = "on-hold";
    b.entry.push(m);
    return b.entry.length - 1;
  }, withLine("Heparin：待 CT 結果再決定"));
  add("med-ondansetron-frequency-tbd", "med", "error", medReq(78, "Ondansetron", { dosageInstruction: [{ text: "frequency TBD" }] }), withLine("Ondansetron: frequency TBD"));
  add("med-home-med-statement-unknown", "med", "error", medReq(79, "降血壓藥", { dosage: [{ text: "家屬不清楚劑量，待確認" }] }, "MedicationStatement"), withLine("居家用藥：降血壓藥（家屬不清楚劑量，待確認）"));
  add("med-pharmacist-pending", "med", "error", medReq(80, "Meropenem", { dosageInstruction: [{ text: "dose pending pharmacist review" }] }), withLine("Meropenem: dose pending pharmacist review"));
  add("med-depending-on-level", "med", "error", medReq(81, "Phenytoin", { dosageInstruction: [{ text: "Maintenance dose depending on the trough level result" }] }), withLine("Phenytoin: maintenance dose depending on the trough level result (drawn, not back)"));

  add("med-dose-to-discuss", "med", "error", medReq(87, "Enoxaparin", { dosageInstruction: [{ text: "劑量待討論" }] }), withLine("Enoxaparin：劑量待討論"));
  add("med-dose-by-tomorrow-result", "med", "error", medReq(88, "Digoxin", { dosageInstruction: [{ text: "劑量依明天抽血結果決定" }] }), withLine("Digoxin：劑量依明天抽血結果決定"));

  // ------------------------------------------------------------------ dx: Condition text-only shells
  add("dx-bronchitis-vs-pneumonia", "dx", "error", replaceDx("支氣管炎與早期肺炎尚難區分"), rep(R, "診斷：社區型肺炎 (J18.9)", "Dx：支氣管炎與早期肺炎尚難區分"));
  add("dx-en-cannot-differentiate", "dx", "error", replaceDx("Bronchitis vs early pneumonia, cannot differentiate"), rep(R, "診斷：社區型肺炎 (J18.9)", "Impression: bronchitis vs early pneumonia, cannot differentiate yet"));
  add("dx-note-differentiating", "dx", "error", replaceDx("肺炎", { note: [{ text: "與肺結核鑑別中" }] }), rep(R, "診斷：社區型肺炎 (J18.9)", "診斷：肺炎與肺結核鑑別中"));
  add("dx-await-ct", "dx", "error", replaceDx("腹痛原因待 CT 結果"), rep(R, "診斷：社區型肺炎 (J18.9)", "Dx: 腹痛，原因待 CT 結果"));
  add("dx-viral-or-bacterial", "dx", "error", replaceDx("病毒性或細菌性感染，尚無法區分"), rep(R, "診斷：社區型肺炎 (J18.9)", "A: 病毒性或細菌性感染，尚無法區分"));
  add("dx-no-code-note-pathology", "dx", "error", (b) => {
    b.entry[2] = { fullUrl: U(3), resource: { resourceType: "Condition", category: [{ coding: [{ system: CAT, code: "encounter-diagnosis" }] }], subject: P, note: [{ text: "診斷待病理報告" }] } };
    return 2;
  }, rep(R, "診斷：社區型肺炎 (J18.9)", "診斷：待病理報告"));
  add("dx-en-undecided-culture", "dx", "error", replaceDx("undecided, pending culture"), rep(R, "診斷：社區型肺炎 (J18.9)", "Assessment: undecided, pending culture"));
  add("dx-coded-confirmed-indistinguishable", "dx", "error", (b) => {
    res(b, 2).code = { coding: [{ system: "http://hl7.org/fhir/sid/icd-10-cm", code: "J20.9", display: "Acute bronchitis, unspecified" }], text: "急性支氣管炎" };
    return 2;
  }, rep(R, "診斷：社區型肺炎 (J18.9)", "Dx：急性支氣管炎與早期肺炎尚難區分"));
  add("dx-coded-provisional-indistinguishable-en", "dx", "error", (b) => {
    res(b, 2).code = { coding: [{ system: "http://hl7.org/fhir/sid/icd-10-cm", code: "J20.9", display: "Acute bronchitis, unspecified" }], text: "acute bronchitis" };
    res(b, 2).verificationStatus = { coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-ver-status", code: "provisional" }] };
    return 2;
  }, rep(R, "診斷：社區型肺炎 (J18.9)", "Impression: acute bronchitis vs early pneumonia, cannot differentiate yet"));
  add("dx-secondary-gout-uric", "dx", "error", condText(82, "疑似痛風，要看尿酸結果"), rep(R, "診斷：社區型肺炎 (J18.9)", "診斷：社區型肺炎 (J18.9)\n次診斷：疑似痛風，要看尿酸結果"));

  add("dx-further-workup", "dx", "error", replaceDx("肺炎或肺結核，待進一步檢查"), rep(R, "診斷：社區型肺炎 (J18.9)", "診斷：肺炎或肺結核，待進一步檢查"));
  add("dx-en-workup-in-progress", "dx", "error", replaceDx("Unclear etiology, workup in progress"), rep(R, "診斷：社區型肺炎 (J18.9)", "Assessment: unclear etiology, workup in progress"));

  // ------------------------------------------------------------------ nosrc: the same shells without a record → warning
  add("nosrc-k-hemolysis", "nosrc", "warning", lab(83, K[0], K[1], "鉀", { note: [{ text: "檢體溶血，不予發報；當日未再重抽" }] }), null);
  add("nosrc-dose-undecided", "nosrc", "warning", medReq(84, "Insulin glargine", { note: [{ text: "Dose undecided, pending morning blood glucose" }] }), null);
  add("nosrc-dx-indistinguishable", "nosrc", "warning", replaceDx("支氣管炎與早期肺炎尚難區分"), null);
  add("nosrc-a1c-sent-out", "nosrc", "warning", lab(85, "4548-4", "Hemoglobin A1c/Hemoglobin.total in Blood", "HbA1c", { note: [{ text: "外送檢驗所，報告尚未回傳" }] }), null);
  add("src-not-located-warning", "nosrc", "warning", lab(86, "630-4", "Bacteria identified in Urine by Culture", "尿液培養", { note: [{ text: "報告尚未回傳" }] }), R);

  // ------------------------------------------------------------------ complete controls
  add("ok-panel-hasmember", "complete", null, { fullUrl: U(90), resource: { resourceType: "Observation", status: "final", code: { coding: [{ system: LOINC, code: "58410-2", display: "CBC panel - Blood by Automated count" }], text: "CBC" }, subject: P, hasMember: [{ reference: U(6) }] } }, R);
  add("ok-panel-hasmember-note", "complete", null, { fullUrl: U(91), resource: { resourceType: "Observation", status: "final", code: { coding: [{ system: LOINC, code: "24323-8", display: "Comprehensive metabolic 2000 panel - Serum or Plasma" }], text: "生化" }, subject: P, hasMember: [{ reference: U(7) }], note: [{ text: "部分項目待報告" }] } }, R);
  add("ok-xray-cancelled-not-done", "complete", null, { fullUrl: U(92), resource: { resourceType: "Observation", status: "cancelled", code: { coding: [{ system: LOINC, code: "36643-5", display: "XR Chest 2 Views" }], text: "胸部X光" }, subject: P, dataAbsentReason: dar("not-performed"), note: [{ text: "本次未做 X 光" }] } }, withLine("本次未做 X 光"));
  add("ok-xray-not-done-final", "complete", null, { fullUrl: U(93), resource: { resourceType: "Observation", status: "final", code: { coding: [{ system: LOINC, code: "36643-5", display: "XR Chest 2 Views" }], text: "胸部X光" }, subject: P, note: [{ text: "本次未做 X 光" }] } }, withLine("本次未做 X 光"));
  add("ok-declined-blood-draw", "complete", null, lab(94, "2160-0", "Creatinine [Mass/volume] in Serum or Plasma", "Creatinine", { dataAbsentReason: dar("asked-declined"), note: [{ text: "病人拒絕抽血" }] }), withLine("Creatinine：病人拒絕抽血"));
  add("ok-declined-en", "complete", null, lab(95, "2160-0", "Creatinine [Mass/volume] in Serum or Plasma", "Creatinine", { note: [{ text: "Patient declined" }] }), withLine("Creatinine: patient declined"));
  add("ok-cancelled-dar-only", "complete", null, lab(96, "1988-5", "C reactive protein [Mass/volume] in Serum or Plasma", "CRP", { dataAbsentReason: dar("not-performed") }, "cancelled"), R);
  add("ok-dar-unknown-no-statement", "complete", null, lab(97, "2276-4", "Ferritin [Mass/volume] in Serum or Plasma", "Ferritin", { dataAbsentReason: dar("unknown") }), R);
  add("ok-entered-in-error-pending", "complete", null, lab(98, K[0], K[1], "鉀", { note: [{ text: "pending" }] }, "entered-in-error"), withLine("鉀：pending"));
  add("ok-structured-dose-renal-text", "complete", null, (b) => {
    res(b, 8).dosageInstruction[0].text = "2 g IV qd，依腎功能調整";
    return 8;
  }, R);
  add("ok-timing-only-as-directed", "complete", null, medReq(99, "Acetaminophen", { dosageInstruction: [{ text: "依醫囑", timing: { repeat: { frequency: 1, period: 6, periodUnit: "h" } } }] }), withLine("Acetaminophen：依醫囑"));
  add("ok-sliding-scale", "complete", null, medReq(100, "Insulin regular", { dosageInstruction: [{ text: "sliding scale，依血糖調整" }] }), withLine("Insulin regular：sliding scale，依血糖調整"));
  add("ok-dose-in-text", "complete", null, medReq(101, "Amlodipine", { dosageInstruction: [{ text: "5 mg 每日一次" }] }), withLine("Amlodipine 5 mg 每日一次"));
  add("ok-prn-pain", "complete", null, medReq(102, "Acetaminophen", { dosageInstruction: [{ text: "疼痛時使用", asNeededBoolean: true }] }), withLine("Acetaminophen：疼痛時使用"));
  add("ok-statement-not-taken", "complete", null, (b) => {
    const m = medReq(103, "Aspirin", { dosage: [{ text: "病人拒絕服用" }] }, "MedicationStatement");
    m.resource.status = "not-taken";
    b.entry.push(m);
    return b.entry.length - 1;
  }, withLine("Aspirin：病人拒絕服用"));
  add("ok-timing-code-text", "complete", null, medReq(104, "Metformin", { dosageInstruction: [{ text: "每日一次，飯後", timing: { code: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation", code: "QD" }] } } }] }), withLine("Metformin 每日一次，飯後"));
  add("ok-text-only-condition", "complete", null, replaceDx("社區型肺炎"), R);
  add("ok-text-only-problem-list", "complete", null, (b) => {
    res(b, 3).code = { text: "高血壓" };
    return 3;
  }, R);
  add("ok-text-only-fuo", "complete", null, replaceDx("原因不明之發燒"), rep(R, "診斷：社區型肺炎 (J18.9)", "診斷：不明原因發燒"));
  add("ok-text-only-monitoring", "complete", null, condText(105, "慢性腎病，追蹤中"), rep(R, "過去病史：高血壓10年，規則服藥。", "過去病史：高血壓10年，規則服藥；慢性腎病，追蹤中。"));
  add("ok-text-only-ro-secondary", "complete", null, condText(106, "r/o 肺結核", { verificationStatus: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-ver-status", code: "differential" }] } }), rep(R, "診斷：社區型肺炎 (J18.9)", "診斷：社區型肺炎 (J18.9)；r/o 肺結核"));
  add("ok-valuestring-negative-mild-hemolysis", "complete", null, lab(107, "80382-5", "Influenza virus A Ag [Presence] in Upper respiratory specimen by Rapid immunoassay", "流感快篩", { valueString: "陰性，檢體輕微溶血" }), withLine("流感快篩：陰性（檢體輕微溶血）"));
  add("ok-value-with-hemolysis-note", "complete", null, (b) => {
    res(b, 5).note = [{ text: "檢體溶血，結果僅供參考" }];
    return 5;
  }, rep(R, "白血球 12.3 x10^3/uL，", "白血球 12.3 x10^3/uL（檢體溶血，結果僅供參考），"));
  add("ok-no-value-no-abnormality-note", "complete", null, { fullUrl: U(108), resource: { resourceType: "Observation", status: "final", code: { coding: [{ system: LOINC, code: "36643-5", display: "XR Chest 2 Views" }], text: "胸部X光" }, subject: P, note: [{ text: "未發現異常" }] } }, withLine("胸部X光：未發現異常"));
  add("ok-imaging-text-result", "complete", null, { fullUrl: U(109), resource: { resourceType: "Observation", status: "final", code: { coding: [{ system: LOINC, code: "36643-5", display: "XR Chest 2 Views" }], text: "胸部X光" }, subject: P, valueString: "右下肺浸潤" } }, withLine("胸部X光：右下肺浸潤"));
  add("ok-nosrc-dar-unknown", "complete", null, lab(110, "2276-4", "Ferritin [Mass/volume] in Serum or Plasma", "Ferritin", { dataAbsentReason: dar("unknown") }), null);
  add("ok-nosrc-not-done", "complete", null, { fullUrl: U(111), resource: { resourceType: "Observation", status: "final", code: { coding: [{ system: LOINC, code: "36643-5", display: "XR Chest 2 Views" }], text: "胸部X光" }, subject: P, note: [{ text: "本次未做" }] } }, null);
  add("ok-nosrc-clean", "complete", null, (b) => 0, null);
  add("ok-family-history-pending-elsewhere", "complete", null, (b) => 0, `${R}\n家族史：父親病史不詳，報告未出`);
  add("ok-order-cancelled-declined", "complete", null, (b) => {
    const m = medReq(113, "Ceftriaxone", { statusReason: { text: "病人拒絕使用" } });
    m.resource.status = "cancelled";
    b.entry.push(m);
    return b.entry.length - 1;
  }, withLine("Ceftriaxone 另一劑：病人拒絕使用，已取消"));
  add("ok-dar-unknown-record-value", "complete", null, (b) => {
    delete res(b, 5).valueQuantity;
    res(b, 5).dataAbsentReason = dar("unknown");
    return 5;
  }, R);
  add("ok-hedged-text-provisional", "complete", null, replaceDx("社區型肺炎（待確認）", { verificationStatus: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-ver-status", code: "provisional" }] } }), rep(R, "診斷：社區型肺炎 (J18.9)", "診斷：社區型肺炎（待確認）"));
  add("ok-text-only-unknown-cause", "complete", null, replaceDx("腹痛，原因不明"), rep(R, "診斷：社區型肺炎 (J18.9)", "診斷：腹痛，原因不明"));
  add("ok-text-only-unknown-etiology-en", "complete", null, replaceDx("Abdominal pain, unknown etiology"), rep(R, "診斷：社區型肺炎 (J18.9)", "Dx: abdominal pain, unknown etiology"));
  add("ok-note-no-hemolysis", "complete", null, { fullUrl: U(112), resource: { resourceType: "Observation", status: "final", code: { coding: [{ system: LOINC, code: "5767-9", display: "Appearance of Urine" }], text: "尿液外觀" }, subject: P, note: [{ text: "無溶血，清澈" }] } }, withLine("尿液外觀：無溶血，清澈"));
  return out;
}
