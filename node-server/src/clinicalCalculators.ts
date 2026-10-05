/**
 * Clinical calculators (Stage 1).
 *
 * Pure, deterministic scoring functions used across Taiwan clinical practice.
 * Reimplemented in Node/TypeScript from `lucidrains/clinical-calculator-tooluse`
 * (CHA₂DS₂-VASc, Wells PE/DVT, DAS28, CDAI) and extended with validated scores
 * common in Taiwan (BMI with Asian cutoffs, CKD-EPI 2021 eGFR, HAS-BLED,
 * CURB-65, qSOFA, GCS).
 *
 * These are stateless functions — no database, no external service. They follow
 * the in-process pattern of `fhirReference.ts` rather than the DB-backed
 * `*Service.ts` pattern, so no `pg.Pool` and no `initialize()`.
 *
 * Every calculator returns a consistent envelope so the LLM can read the result
 * without guessing: `{ calculator, score, interpretation, inputs, notes,
 * disclaimer }` (plus a `risk_category` / `sub_scores` where meaningful).
 *
 * Interpretation/notes are user-facing Traditional Chinese (matching
 * `labService.ts`); code and comments are English. `score` is rounded to two
 * decimals only when the formula is continuous.
 */

// Shared user-facing disclaimer — decision support, not diagnosis.
const DISCLAIMER = "僅供臨床決策支援，不取代專業醫療判斷。";

/** Round a continuous score to two decimals (discrete integer scores stay integers). */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

type Sex = "M" | "F";

/** Common result fields shared by every calculator. */
interface CalculatorResult {
  calculator: string;
  score: number;
  interpretation: string;
  inputs: Record<string, unknown>;
  notes?: string[];
  disclaimer: string;
}

/** Attach the shared disclaimer to a result object (no call site passes its own). */
function withDisclaimer<T extends object>(result: T): T & { disclaimer: string } {
  return { ...result, disclaimer: DISCLAIMER };
}

// ── CHA₂DS₂-VASc ─────────────────────────────────────────────────────────────

export interface Chads2VascInput {
  age: number;
  sex: Sex;
  congestive_heart_failure?: boolean;
  hypertension?: boolean;
  diabetes?: boolean;
  stroke_or_tia?: boolean;
  vascular_disease?: boolean;
}

export interface Chads2VascResult extends CalculatorResult {
  score: number;
  adjusted_score: number;
  risk_category: string;
}

/**
 * CHA₂DS₂-VASc — stroke risk in non-valvular atrial fibrillation (0–9).
 * Accepts raw `age`/`sex` and computes the age/sex brackets internally, rather
 * than asking the caller to pre-classify. Also returns the 2024 ESC
 * CHA₂DS₂-VA `adjusted_score` (sex criterion removed).
 */
export function calculateChads2Vasc(input: Chads2VascInput): Chads2VascResult {
  const {
    age,
    sex,
    congestive_heart_failure = false,
    hypertension = false,
    diabetes = false,
    stroke_or_tia = false,
    vascular_disease = false,
  } = input;

  let score = 0;
  const items: string[] = [];
  if (congestive_heart_failure) {
    score += 1;
    items.push("鬱血性心衰竭");
  }
  if (hypertension) {
    score += 1;
    items.push("高血壓");
  }
  if (age >= 75) {
    score += 2;
    items.push("年齡 ≥75");
  } else if (age >= 65) {
    score += 1;
    items.push("年齡 65–74");
  }
  if (diabetes) {
    score += 1;
    items.push("糖尿病");
  }
  if (stroke_or_tia) {
    score += 2;
    items.push("中風/TIA 病史");
  }
  if (vascular_disease) {
    score += 1;
    items.push("血管疾病");
  }
  if (sex === "F") {
    score += 1;
    items.push("女性");
  }

  const adjustedScore = score - (sex === "F" ? 1 : 0);

  // Risk thresholding uses the adjusted score (female sex is not itself a risk
  // factor), matching the 2024 ESC CHA₂DS₂-VA guidance.
  let riskCategory: string;
  if (adjustedScore === 0) {
    riskCategory = "低風險";
  } else if (adjustedScore === 1) {
    riskCategory = "中風險";
  } else {
    riskCategory = "高風險";
  }

  return withDisclaimer({
    calculator: "chads2_vasc",
    score,
    adjusted_score: adjustedScore,
    risk_category: riskCategory,
    interpretation: `CHA₂DS₂-VASc 分數 ${score}（CHA₂DS₂-VA ${adjustedScore}），${riskCategory}`,
    inputs: { age, sex, congestive_heart_failure, hypertension, diabetes, stroke_or_tia, vascular_disease },
    notes: [
      `計分項目：${items.join("、") || "無"}`,
      "CHA₂DS₂-VASc 0–9；2024 ESC 建議以 CHA₂DS₂-VA（去除性別）評估：0 分不需抗凝血、1 分考慮、≥2 分建議口服抗凝血。",
    ],
  });
}

// ── Wells PE ──────────────────────────────────────────────────────────────────

export interface WellsPeInput {
  clinical_signs_dvt?: boolean;
  alternative_diagnosis_less_likely?: boolean;
  heart_rate_bpm?: number | null;
  immobilization_or_recent_surgery?: boolean;
  previous_dvt_or_pe?: boolean;
  hemoptysis?: boolean;
  active_malignancy?: boolean;
}

export interface WellsPeResult extends CalculatorResult {
  two_tier_risk: string;
  three_tier_risk: string;
}

/**
 * Wells criteria for pulmonary embolism. Binary clinical findings are booleans;
 * heart rate is a raw bpm (the criterion is >100 bpm, computed internally).
 */
export function calculateWellsPe(input: WellsPeInput): WellsPeResult {
  const {
    clinical_signs_dvt = false,
    alternative_diagnosis_less_likely = false,
    heart_rate_bpm,
    immobilization_or_recent_surgery = false,
    previous_dvt_or_pe = false,
    hemoptysis = false,
    active_malignancy = false,
  } = input;

  const heartRateOver100 = heart_rate_bpm != null && heart_rate_bpm > 100;

  let score = 0;
  if (clinical_signs_dvt) score += 3.0;
  if (alternative_diagnosis_less_likely) score += 3.0;
  if (heartRateOver100) score += 1.5;
  if (immobilization_or_recent_surgery) score += 1.5;
  if (previous_dvt_or_pe) score += 1.5;
  if (hemoptysis) score += 1.0;
  if (active_malignancy) score += 1.0;

  const twoTier = score > 4.0 ? "PE likely (高度可能)" : "PE unlikely (低度可能)";
  const threeTier =
    score < 2.0 ? "低風險" : score <= 6.0 ? "中風險" : "高風險";

  return withDisclaimer({
    calculator: "wells_pe",
    score: round2(score),
    two_tier_risk: twoTier,
    three_tier_risk: threeTier,
    interpretation: `Wells 肺栓塞分數 ${round2(score)}，${twoTier}，三層分級為${threeTier}`,
    inputs: {
      clinical_signs_dvt,
      alternative_diagnosis_less_likely,
      heart_rate_bpm: heart_rate_bpm ?? null,
      immobilization_or_recent_surgery,
      previous_dvt_or_pe,
      hemoptysis,
      active_malignancy,
    },
    notes: ["二層分級：>4.0 為 PE likely；三層分級：<2 低、2–6 中、>6 高風險。"],
  });
}

// ── Wells DVT ─────────────────────────────────────────────────────────────────

export interface WellsDvtInput {
  active_cancer?: boolean;
  paralysis_paresis_or_immobilization?: boolean;
  bedridden_or_recent_surgery?: boolean;
  calf_swelling_gt_3cm?: boolean;
  collateral_superficial_veins?: boolean;
  entire_leg_swollen?: boolean;
  localized_tenderness?: boolean;
  pitting_edema?: boolean;
  previous_dvt?: boolean;
  alternative_diagnosis_as_likely?: boolean;
}

export interface WellsDvtResult extends CalculatorResult {
  two_tier_risk: string;
  three_tier_risk: string;
}

/** Wells criteria for deep-vein thrombosis. All items are binary findings. */
export function calculateWellsDvt(input: WellsDvtInput): WellsDvtResult {
  const {
    active_cancer = false,
    paralysis_paresis_or_immobilization = false,
    bedridden_or_recent_surgery = false,
    calf_swelling_gt_3cm = false,
    collateral_superficial_veins = false,
    entire_leg_swollen = false,
    localized_tenderness = false,
    pitting_edema = false,
    previous_dvt = false,
    alternative_diagnosis_as_likely = false,
  } = input;

  let score = 0;
  if (active_cancer) score += 1;
  if (paralysis_paresis_or_immobilization) score += 1;
  if (bedridden_or_recent_surgery) score += 1;
  if (calf_swelling_gt_3cm) score += 1;
  if (collateral_superficial_veins) score += 1;
  if (entire_leg_swollen) score += 1;
  if (localized_tenderness) score += 1;
  if (pitting_edema) score += 1;
  if (previous_dvt) score += 1;
  if (alternative_diagnosis_as_likely) score -= 2;

  const twoTier = score >= 2 ? "DVT likely (高度可能)" : "DVT unlikely (低度可能)";
  const threeTier =
    score <= 0 ? "低風險" : score <= 2 ? "中風險" : "高風險";

  return withDisclaimer({
    calculator: "wells_dvt",
    score,
    two_tier_risk: twoTier,
    three_tier_risk: threeTier,
    interpretation: `Wells 深層靜脈栓塞分數 ${score}，${twoTier}，三層分級為${threeTier}`,
    inputs: {
      active_cancer,
      paralysis_paresis_or_immobilization,
      bedridden_or_recent_surgery,
      calf_swelling_gt_3cm,
      collateral_superficial_veins,
      entire_leg_swollen,
      localized_tenderness,
      pitting_edema,
      previous_dvt,
      alternative_diagnosis_as_likely,
    },
    notes: ["二層分級：≥2 為 DVT likely；三層分級：≤0 低、1–2 中、≥3 高風險。"],
  });
}

// ── DAS28 / CDAI (rheumatoid arthritis) ──────────────────────────────────────

const DAS28_ACTIVITY: Array<{ max: number; label: string }> = [
  { max: 2.6, label: "緩解 (Remission)" },
  { max: 3.2, label: "低疾病活動度 (Low)" },
  { max: 5.1, label: "中疾病活動度 (Moderate)" },
  { max: Infinity, label: "高疾病活動度 (High)" },
];

const CDAI_ACTIVITY: Array<{ max: number; label: string }> = [
  { max: 2.8, label: "緩解 (Remission)" },
  { max: 10.0, label: "低疾病活動度 (Low)" },
  { max: 22.0, label: "中疾病活動度 (Moderate)" },
  { max: Infinity, label: "高疾病活動度 (High)" },
];

function activityLabel(score: number, bands: Array<{ max: number; label: string }>): string {
  for (const band of bands) {
    if (score <= band.max) return band.label;
  }
  return bands[bands.length - 1].label;
}

export interface Das28Input {
  tender_count: number;
  swollen_count: number;
  global_health: number;
  formula: "esr" | "crp";
  esr?: number | null;
  crp?: number | null;
}

export interface Das28Result extends CalculatorResult {
  disease_activity: string;
  formula: "esr" | "crp";
}

/** DAS28 — rheumatoid arthritis disease activity, ESR or CRP variant. */
export function calculateDas28(input: Das28Input): Das28Result {
  const { tender_count, swollen_count, global_health, formula } = input;

  let score: number;
  if (formula === "esr") {
    if (input.esr == null) {
      throw new Error("esr is required when formula is 'esr'");
    }
    score =
      0.56 * Math.sqrt(tender_count) +
      0.28 * Math.sqrt(swollen_count) +
      0.7 * Math.log(input.esr) +
      0.014 * global_health;
  } else {
    if (input.crp == null) {
      throw new Error("crp is required when formula is 'crp'");
    }
    score =
      0.56 * Math.sqrt(tender_count) +
      0.28 * Math.sqrt(swollen_count) +
      0.36 * Math.log(input.crp + 1) +
      0.014 * global_health +
      0.96;
  }

  const activity = activityLabel(score, DAS28_ACTIVITY);

  return withDisclaimer({
    calculator: "das28",
    formula,
    score: round2(score),
    disease_activity: activity,
    interpretation: `DAS28-${formula.toUpperCase()} ${round2(score)}，${activity}`,
    inputs: { tender_count, swollen_count, global_health, formula, esr: input.esr ?? null, crp: input.crp ?? null },
    notes: [
      "ESR 單位 mm/h，CRP 單位 mg/L，global_health 為病人整體評估 VAS (0–100)。",
      "分級：≤2.6 緩解、≤3.2 低、≤5.1 中、>5.1 高疾病活動度。",
    ],
  });
}

export interface CdaiInput {
  tender_count: number;
  swollen_count: number;
  patient_global: number;
  provider_global: number;
}

export interface CdaiResult extends CalculatorResult {
  disease_activity: string;
}

/** CDAI — lab-free rheumatoid arthritis disease activity. */
export function calculateCdai(input: CdaiInput): CdaiResult {
  const { tender_count, swollen_count, patient_global, provider_global } = input;
  const score = tender_count + swollen_count + patient_global + provider_global;
  const activity = activityLabel(score, CDAI_ACTIVITY);

  return withDisclaimer({
    calculator: "cdai",
    score,
    disease_activity: activity,
    interpretation: `CDAI ${score}，${activity}`,
    inputs: { tender_count, swollen_count, patient_global, provider_global },
    notes: [
      "四項皆 0–10：壓痛關節數、腫脹關節數、病人整體評估、評估者整體評估。",
      "分級：≤2.8 緩解、≤10 低、≤22 中、>22 高疾病活動度。",
    ],
  });
}

// ── BMI ───────────────────────────────────────────────────────────────────────

export interface BmiInput {
  weight_kg: number;
  height_cm: number;
}

export interface BmiResult extends CalculatorResult {
  category: string;
}

/** BMI with Taiwan (Asian) cutoffs: 24 overweight, 27 obese. */
export function calculateBmi(input: BmiInput): BmiResult {
  const { weight_kg, height_cm } = input;
  const heightM = height_cm / 100;
  const bmi = weight_kg / (heightM * heightM);

  let category: string;
  if (bmi < 18.5) category = "過輕";
  else if (bmi < 24) category = "正常";
  else if (bmi < 27) category = "過重";
  else category = "肥胖";

  return withDisclaimer({
    calculator: "bmi",
    score: round2(bmi),
    category,
    interpretation: `BMI ${round2(bmi)}，${category}`,
    inputs: { weight_kg, height_cm },
    notes: [
      "台灣（亞洲）標準：<18.5 過輕、18.5–23.9 正常、24–26.9 過重、≥27 肥胖。",
      "WHO 國際標準為 ≥25 過重、≥30 肥胖，與台灣標準不同。",
    ],
  });
}

// ── eGFR (CKD-EPI 2021) ───────────────────────────────────────────────────────

export interface EgfrInput {
  age: number;
  sex: Sex;
  serum_creatinine_mgdl: number;
}

export interface EgfrResult extends CalculatorResult {
  ckd_stage: string;
  unit: string;
}

/**
 * CKD-EPI 2021 creatinine equation (race-free). Serum creatinine in mg/dL.
 * Stages use the GFR categories from KDIGO.
 */
export function calculateEgfr(input: EgfrInput): EgfrResult {
  const { age, sex, serum_creatinine_mgdl } = input;

  const kappa = sex === "F" ? 0.7 : 0.9;
  const alpha = sex === "F" ? -0.241 : -0.302;
  const sexFactor = sex === "F" ? 1.012 : 1.0;
  const scrKappa = serum_creatinine_mgdl / kappa;

  const egfr =
    142 *
    Math.pow(Math.min(scrKappa, 1), alpha) *
    Math.pow(Math.max(scrKappa, 1), -1.2) *
    Math.pow(0.9938, age) *
    sexFactor;

  let ckdStage: string;
  if (egfr >= 90) ckdStage = "G1（正常或偏高）";
  else if (egfr >= 60) ckdStage = "G2（輕度下降）";
  else if (egfr >= 45) ckdStage = "G3a（輕至中度下降）";
  else if (egfr >= 30) ckdStage = "G3b（中至重度下降）";
  else if (egfr >= 15) ckdStage = "G4（重度下降）";
  else ckdStage = "G5（腎衰竭）";

  return withDisclaimer({
    calculator: "egfr",
    score: round2(egfr),
    ckd_stage: ckdStage,
    unit: "mL/min/1.73 m²",
    interpretation: `eGFR ${round2(egfr)} mL/min/1.73m²，慢性腎病分期 ${ckdStage}`,
    inputs: { age, sex, serum_creatinine_mgdl },
    notes: [
      "CKD-EPI 2021（無種族係數）；serum_creatinine 單位為 mg/dL。",
      "急性腎損傷或非穩定狀態下 eGFR 不適用。",
    ],
  });
}

// ── HAS-BLED ──────────────────────────────────────────────────────────────────

export interface HasBledInput {
  age: number;
  systolic_bp_mmhg?: number | null;
  abnormal_renal_function?: boolean;
  abnormal_liver_function?: boolean;
  stroke_history?: boolean;
  bleeding_history?: boolean;
  labile_inr?: boolean;
  drugs_antiplatelet_or_nsaid?: boolean;
  alcohol?: boolean;
}

export interface HasBledResult extends CalculatorResult {
  risk_category: string;
}

/** HAS-BLED — bleeding risk on oral anticoagulation (0–9). */
export function calculateHasBled(input: HasBledInput): HasBledResult {
  const {
    age,
    systolic_bp_mmhg,
    abnormal_renal_function = false,
    abnormal_liver_function = false,
    stroke_history = false,
    bleeding_history = false,
    labile_inr = false,
    drugs_antiplatelet_or_nsaid = false,
    alcohol = false,
  } = input;

  let score = 0;
  const items: string[] = [];
  if (systolic_bp_mmhg != null && systolic_bp_mmhg > 160) {
    score += 1;
    items.push("未控制高血壓（收縮壓 >160 mmHg）");
  }
  if (abnormal_renal_function) {
    score += 1;
    items.push("腎功能異常");
  }
  if (abnormal_liver_function) {
    score += 1;
    items.push("肝功能異常");
  }
  if (stroke_history) {
    score += 1;
    items.push("中風病史");
  }
  if (bleeding_history) {
    score += 1;
    items.push("出血病史/傾向");
  }
  if (labile_inr) {
    score += 1;
    items.push("INR 不穩定");
  }
  if (age > 65) {
    score += 1;
    items.push("年齡 >65");
  }
  if (drugs_antiplatelet_or_nsaid) {
    score += 1;
    items.push("抗血小板藥/NSAID");
  }
  if (alcohol) {
    score += 1;
    items.push("飲酒 ≥8 杯/週");
  }

  const riskCategory = score >= 3 ? "高出血風險" : "低出血風險";

  return withDisclaimer({
    calculator: "has_bled",
    score,
    risk_category: riskCategory,
    interpretation: `HAS-BLED 分數 ${score}，${riskCategory}`,
    inputs: {
      age,
      systolic_bp_mmhg: systolic_bp_mmhg ?? null,
      abnormal_renal_function,
      abnormal_liver_function,
      stroke_history,
      bleeding_history,
      labile_inr,
      drugs_antiplatelet_or_nsaid,
      alcohol,
    },
    notes: [
      `計分項目：${items.join("、") || "無"}`,
      "原始定義：H=未控制高血壓（收縮壓 >160 mmHg）；A=透析/移植/Cr>2.26 mg/dL；L=肝硬化或膽紅素>2x 正常；≥3 分為高出血風險，應謹慎並定期追蹤。",
    ],
  });
}

// ── CURB-65 ───────────────────────────────────────────────────────────────────

export interface Curb65Input {
  age: number;
  confusion?: boolean;
  bun_mgdl?: number | null;
  respiratory_rate?: number | null;
  sbp_mmhg?: number | null;
  dbp_mmhg?: number | null;
}

export interface Curb65Result extends CalculatorResult {
  risk_category: string;
}

/** CURB-65 — community-acquired pneumonia severity (0–5). BUN in mg/dL. */
export function calculateCurb65(input: Curb65Input): Curb65Result {
  const { age, confusion = false, bun_mgdl, respiratory_rate, sbp_mmhg, dbp_mmhg } = input;

  let score = 0;
  const items: string[] = [];
  if (confusion) {
    score += 1;
    items.push("意識混淆");
  }
  if (bun_mgdl != null && bun_mgdl > 19) {
    score += 1;
    items.push("BUN >19 mg/dL");
  }
  if (respiratory_rate != null && respiratory_rate >= 30) {
    score += 1;
    items.push("呼吸速率 ≥30");
  }
  if ((sbp_mmhg != null && sbp_mmhg < 90) || (dbp_mmhg != null && dbp_mmhg <= 60)) {
    score += 1;
    items.push("低血壓 (SBP<90 或 DBP≤60)");
  }
  if (age >= 65) {
    score += 1;
    items.push("年齡 ≥65");
  }

  let riskCategory: string;
  if (score <= 1) riskCategory = "低風險（可考慮門診治療）";
  else if (score === 2) riskCategory = "中風險（考慮住院/短期住院）";
  else riskCategory = "高風險（嚴重，考慮加護病房）";

  return withDisclaimer({
    calculator: "curb65",
    score,
    risk_category: riskCategory,
    interpretation: `CURB-65 分數 ${score}，${riskCategory}`,
    inputs: { age, confusion, bun_mgdl: bun_mgdl ?? null, respiratory_rate: respiratory_rate ?? null, sbp_mmhg: sbp_mmhg ?? null, dbp_mmhg: dbp_mmhg ?? null },
    notes: [`計分項目：${items.join("、") || "無"}`, "BUN >19 mg/dL ≈ 尿素 >7 mmol/L。"],
  });
}

// ── qSOFA ─────────────────────────────────────────────────────────────────────

export interface QsofaInput {
  respiratory_rate?: number | null;
  gcs?: number | null;
  sbp_mmhg?: number | null;
}

export interface QsofaResult extends CalculatorResult {
  risk_category: string;
}

/** qSOFA — sepsis screening (0–3). ≥2 suggests sepsis (high risk). */
export function calculateQsofa(input: QsofaInput): QsofaResult {
  const { respiratory_rate, gcs, sbp_mmhg } = input;

  let score = 0;
  const items: string[] = [];
  if (respiratory_rate != null && respiratory_rate >= 22) {
    score += 1;
    items.push("呼吸速率 ≥22");
  }
  if (gcs != null && gcs < 15) {
    score += 1;
    items.push("意識改變（GCS <15）");
  }
  if (sbp_mmhg != null && sbp_mmhg <= 100) {
    score += 1;
    items.push("收縮壓 ≤100 mmHg");
  }

  const riskCategory = score >= 2 ? "疑似敗血症（高風險）" : "低風險";

  return withDisclaimer({
    calculator: "qsofa",
    score,
    risk_category: riskCategory,
    interpretation: `qSOFA 分數 ${score}，${riskCategory}`,
    inputs: { respiratory_rate: respiratory_rate ?? null, gcs: gcs ?? null, sbp_mmhg: sbp_mmhg ?? null },
    notes: ["qSOFA ≥2 分應懷疑敗血症並進一步評估；qSOFA 為篩檢工具，非診斷標準。"],
  });
}

// ── GCS ───────────────────────────────────────────────────────────────────────

export interface GcsInput {
  eye_response: number;
  verbal_response: number;
  motor_response: number;
}

export interface GcsResult extends CalculatorResult {
  sub_scores: { eye: number; verbal: number; motor: number };
  severity: string;
}

/** Glasgow Coma Scale (3–15). */
export function calculateGcs(input: GcsInput): GcsResult {
  const { eye_response, verbal_response, motor_response } = input;

  if (eye_response < 1 || eye_response > 4) throw new Error("eye_response must be 1–4");
  if (verbal_response < 1 || verbal_response > 5) throw new Error("verbal_response must be 1–5");
  if (motor_response < 1 || motor_response > 6) throw new Error("motor_response must be 1–6");

  const score = eye_response + verbal_response + motor_response;

  let severity: string;
  if (score >= 13) severity = "輕度（Mild）";
  else if (score >= 9) severity = "中度（Moderate）";
  else severity = "重度（Severe，≤8 為昏迷/需考慮插管）";

  return withDisclaimer({
    calculator: "gcs",
    score,
    sub_scores: { eye: eye_response, verbal: verbal_response, motor: motor_response },
    severity,
    interpretation: `GCS 分數 ${score}（E${eye_response}V${verbal_response}M${motor_response}），${severity}`,
    inputs: { eye_response, verbal_response, motor_response },
    notes: ["眼 E1–4、言語 V1–5、動作 M1–6，總分 3–15；≤8 分為重度、通常需氣管插管。"],
  });
}
