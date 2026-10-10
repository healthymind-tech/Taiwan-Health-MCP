/**
 * Clinical calculators — unit tests.
 *
 * Ports the known vectors from `lucidrains/tests/test_calculators.py`
 * (CHA₂DS₂-VASc, Wells PE/DVT, DAS28, CDAI) and adds known clinical values for
 * the extended calculators (BMI, eGFR, HAS-BLED, CURB-65, qSOFA, GCS).
 *
 * Pure functions — no DB, Redis, or MinIO. Run via `npm test`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import {
  bmiInputShape,
  calculateBmi,
  calculateCdai,
  calculateChads2Vasc,
  calculateCurb65,
  calculateDas28,
  calculateEgfr,
  calculateGcs,
  calculateHasBled,
  calculateQsofa,
  calculateWellsDvt,
  calculateWellsPe,
  cdaiInputShape,
  das28InputShape,
  egfrInputShape,
  gcsInputShape,
  qsofaInputShape,
} from "./clinicalCalculators.js";

/** Parse tool arguments exactly as the MCP transport and `POST /tools/*` do. */
function accepts(shape: z.ZodRawShape, args: Record<string, unknown>): boolean {
  return z.object(shape).safeParse(args).success;
}

test("CHA₂DS₂-VASc: no risk factors → 0, low risk", () => {
  const r = calculateChads2Vasc({ age: 50, sex: "M" });
  assert.equal(r.score, 0);
  assert.equal(r.adjusted_score, 0);
  assert.equal(r.risk_category, "低風險");
});

test("CHA₂DS₂-VASc: female sex alone scores 1 but adjusted 0 → low risk", () => {
  const r = calculateChads2Vasc({ age: 50, sex: "F" });
  assert.equal(r.score, 1);
  assert.equal(r.adjusted_score, 0);
  assert.equal(r.risk_category, "低風險");
});

test("CHA₂DS₂-VASc: hypertension alone → 1, consider anticoagulation", () => {
  const r = calculateChads2Vasc({ age: 50, sex: "M", hypertension: true });
  assert.equal(r.score, 1);
  assert.equal(r.adjusted_score, 1);
  assert.equal(r.risk_category, "中風險");
});

test("CHA₂DS₂-VASc: hypertension + age 65 → 2, high risk", () => {
  const r = calculateChads2Vasc({ age: 65, sex: "M", hypertension: true });
  assert.equal(r.score, 2);
  assert.equal(r.risk_category, "高風險");
});

test("CHA₂DS₂-VASc: stroke + age 75 + diabetes → 5, recommended", () => {
  const r = calculateChads2Vasc({ age: 75, sex: "M", stroke_or_tia: true, diabetes: true });
  assert.equal(r.score, 5);
  assert.equal(r.risk_category, "高風險");
});

test("Wells PE: no findings → 0, unlikely, low", () => {
  const r = calculateWellsPe({});
  assert.equal(r.score, 0);
  assert.match(r.two_tier_risk, /unlikely/);
  assert.equal(r.three_tier_risk, "低風險");
});

test("Wells PE: DVT signs + alt-dx less likely + malignancy → 7, likely, high", () => {
  const r = calculateWellsPe({
    clinical_signs_dvt: true,
    alternative_diagnosis_less_likely: true,
    active_malignancy: true,
  });
  assert.equal(r.score, 7);
  assert.match(r.two_tier_risk, /likely/);
  assert.equal(r.three_tier_risk, "高風險");
});

test("Wells PE: heart rate 105 + hemoptysis → 2.5, unlikely, moderate", () => {
  const r = calculateWellsPe({ heart_rate_bpm: 105, hemoptysis: true });
  assert.equal(r.score, 2.5);
  assert.match(r.two_tier_risk, /unlikely/);
  assert.equal(r.three_tier_risk, "中風險");
});

test("Wells DVT: cancer + alternative dx as likely → -1, unlikely, low", () => {
  const r = calculateWellsDvt({ active_cancer: true, alternative_diagnosis_as_likely: true });
  assert.equal(r.score, -1);
  assert.match(r.two_tier_risk, /unlikely/);
  assert.equal(r.three_tier_risk, "低風險");
});

test("Wells DVT: cancer + leg swollen + prior DVT → 3, likely, high", () => {
  const r = calculateWellsDvt({ active_cancer: true, entire_leg_swollen: true, previous_dvt: true });
  assert.equal(r.score, 3);
  assert.match(r.two_tier_risk, /likely/);
  assert.equal(r.three_tier_risk, "高風險");
});

test("DAS28-ESR: tender 8, swollen 4, ESR 30, GH 50 → ≈5.22 high", () => {
  const r = calculateDas28({ tender_count: 8, swollen_count: 4, esr: 30, global_health: 50, formula: "esr" });
  assert.ok(Math.abs(r.score - 5.22) < 0.01, `expected ≈5.22, got ${r.score}`);
  assert.match(r.disease_activity, /High|高/);
});

test("DAS28-CRP: tender 8, swollen 4, CRP 10, GH 50 → ≈4.67 moderate", () => {
  const r = calculateDas28({ tender_count: 8, swollen_count: 4, crp: 10, global_health: 50, formula: "crp" });
  assert.ok(Math.abs(r.score - 4.67) < 0.01, `expected ≈4.67, got ${r.score}`);
  assert.match(r.disease_activity, /Moderate|中/);
});

test("CDAI: tender 4, swollen 2, patient 3.5, provider 2.5 → 12 moderate", () => {
  const r = calculateCdai({ tender_count: 4, swollen_count: 2, patient_global: 3.5, provider_global: 2.5 });
  assert.equal(r.score, 12);
  assert.match(r.disease_activity, /Moderate|中/);
});

test("BMI: 75kg / 165cm → ≈27.5 obese (Taiwan cutoff)", () => {
  const r = calculateBmi({ weight_kg: 75, height_cm: 165 });
  assert.ok(Math.abs(r.score - 27.55) < 0.05, `expected ≈27.5, got ${r.score}`);
  assert.equal(r.category, "肥胖");
});

test("BMI: 60kg / 165cm → ≈22 normal", () => {
  const r = calculateBmi({ weight_kg: 60, height_cm: 165 });
  assert.equal(r.category, "正常");
});

test("eGFR: 50y female, SCr 0.9 → ≈75 (G2)", () => {
  const r = calculateEgfr({ age: 50, sex: "F", serum_creatinine_mgdl: 0.9 });
  assert.ok(r.score > 60 && r.score < 90, `expected G2 range, got ${r.score}`);
  assert.equal(r.ckd_stage, "G2（輕度下降）");
});

test("eGFR: 70y male, SCr 2.5 → G3/G4 (low)", () => {
  const r = calculateEgfr({ age: 70, sex: "M", serum_creatinine_mgdl: 2.5 });
  assert.ok(r.score < 60, `expected <60, got ${r.score}`);
});

test("HAS-BLED: age 70 + SBP 165 + abnormal renal → 3 high bleeding risk", () => {
  const r = calculateHasBled({ age: 70, systolic_bp_mmhg: 165, abnormal_renal_function: true });
  assert.equal(r.score, 3);
  assert.equal(r.risk_category, "高出血風險");
});

test("HAS-BLED: SBP ≤160 does not count as uncontrolled hypertension", () => {
  const r = calculateHasBled({ age: 70, systolic_bp_mmhg: 160, abnormal_renal_function: true });
  assert.equal(r.score, 2);
});

test("CURB-65: 70y + confusion + BUN 25 + RR 32 + low BP → 5 high", () => {
  const r = calculateCurb65({
    age: 70,
    confusion: true,
    bun_mgdl: 25,
    respiratory_rate: 32,
    sbp_mmhg: 85,
    dbp_mmhg: 60,
  });
  assert.equal(r.score, 5);
  assert.match(r.risk_category, /高風險/);
});

test("qSOFA: RR 24 + SBP 95 → 2, suspected sepsis", () => {
  const r = calculateQsofa({ respiratory_rate: 24, sbp_mmhg: 95 });
  assert.equal(r.score, 2);
  assert.match(r.risk_category, /疑似敗血症/);
});

test("qSOFA: GCS 13 counts as altered mentation; GCS 15 does not", () => {
  assert.equal(calculateQsofa({ gcs: 13 }).score, 1);
  assert.equal(calculateQsofa({ gcs: 15 }).score, 0);
});

test("GCS: E4 V5 M6 → 15 mild", () => {
  const r = calculateGcs({ eye_response: 4, verbal_response: 5, motor_response: 6 });
  assert.equal(r.score, 15);
  assert.match(r.severity, /輕度/);
});

test("GCS: E1 V2 M3 → 6 severe", () => {
  const r = calculateGcs({ eye_response: 1, verbal_response: 2, motor_response: 3 });
  assert.equal(r.score, 6);
  assert.match(r.severity, /重度/);
});

test("GCS: out-of-range sub-scores are rejected by the input schema", () => {
  assert.ok(accepts(gcsInputShape, { eye_response: 4, verbal_response: 5, motor_response: 6 }));
  assert.ok(!accepts(gcsInputShape, { eye_response: 5, verbal_response: 5, motor_response: 6 }));
  assert.ok(!accepts(gcsInputShape, { eye_response: 4, verbal_response: 0, motor_response: 6 }));
  assert.ok(!accepts(gcsInputShape, { eye_response: 4, verbal_response: 5, motor_response: 7 }));
});

test("every result carries a non-empty disclaimer", () => {
  const results = [
    calculateChads2Vasc({ age: 50, sex: "M" }),
    calculateWellsPe({}),
    calculateWellsDvt({}),
    calculateDas28({ tender_count: 0, swollen_count: 0, esr: 10, global_health: 10, formula: "esr" }),
    calculateCdai({ tender_count: 0, swollen_count: 0, patient_global: 0, provider_global: 0 }),
    calculateBmi({ weight_kg: 60, height_cm: 165 }),
    calculateEgfr({ age: 50, sex: "F", serum_creatinine_mgdl: 0.9 }),
    calculateHasBled({ age: 50 }),
    calculateCurb65({ age: 30 }),
    calculateQsofa({}),
    calculateGcs({ eye_response: 4, verbal_response: 5, motor_response: 6 }),
  ];
  for (const r of results) {
    assert.ok(r.disclaimer && r.disclaimer.length > 0, `${r.calculator} missing disclaimer`);
  }
});

// ── Input bounds (wrong units / impossible values never reach a formula) ─────

test("eGFR schema: rejects zero/negative creatinine, µmol/L values and children", () => {
  assert.ok(accepts(egfrInputShape, { age: 50, sex: "F", serum_creatinine_mgdl: 0.9 }));
  assert.ok(!accepts(egfrInputShape, { age: 50, sex: "F", serum_creatinine_mgdl: 0 }));
  assert.ok(!accepts(egfrInputShape, { age: 50, sex: "F", serum_creatinine_mgdl: -1 }));
  // 88 µmol/L ≈ 1.0 mg/dL — passing the µmol/L number must not yield "G5".
  assert.ok(!accepts(egfrInputShape, { age: 50, sex: "F", serum_creatinine_mgdl: 88 }));
  // CKD-EPI 2021 is an adult equation.
  assert.ok(!accepts(egfrInputShape, { age: 8, sex: "F", serum_creatinine_mgdl: 0.5 }));
  assert.ok(!accepts(egfrInputShape, { age: -5, sex: "F", serum_creatinine_mgdl: 0.9 }));
});

test("DAS28 schema: rejects ESR ≤ 0, negative CRP, joint counts outside 0–28, VAS > 100", () => {
  const base = { tender_count: 8, swollen_count: 4, global_health: 50, formula: "esr", esr: 30 };
  assert.ok(accepts(das28InputShape, base));
  assert.ok(!accepts(das28InputShape, { ...base, esr: 0 }));
  assert.ok(!accepts(das28InputShape, { ...base, formula: "crp", esr: null, crp: -1 }));
  assert.ok(!accepts(das28InputShape, { ...base, tender_count: -2 }));
  assert.ok(!accepts(das28InputShape, { ...base, swollen_count: 29 }));
  assert.ok(!accepts(das28InputShape, { ...base, global_health: 101 }));
});

test("CDAI schema: joint counts are 0–28 (28-joint count), globals 0–10", () => {
  assert.ok(accepts(cdaiInputShape, { tender_count: 20, swollen_count: 15, patient_global: 5, provider_global: 5 }));
  assert.ok(!accepts(cdaiInputShape, { tender_count: 29, swollen_count: 0, patient_global: 0, provider_global: 0 }));
  assert.ok(!accepts(cdaiInputShape, { tender_count: 0, swollen_count: 0, patient_global: 11, provider_global: 0 }));
});

test("CDAI: 20 tender + 15 swollen joints score in full (not clamped to 10)", () => {
  const r = calculateCdai({ tender_count: 20, swollen_count: 15, patient_global: 5, provider_global: 5 });
  assert.equal(r.score, 45);
  assert.match(r.disease_activity, /High|高/);
});

test("BMI schema: rejects zero weight, zero height and height given in metres", () => {
  assert.ok(accepts(bmiInputShape, { weight_kg: 75, height_cm: 165 }));
  assert.ok(!accepts(bmiInputShape, { weight_kg: 0, height_cm: 165 }));
  assert.ok(!accepts(bmiInputShape, { weight_kg: 75, height_cm: 0 }));
  assert.ok(!accepts(bmiInputShape, { weight_kg: 75, height_cm: 1.65 }));
});

test("qSOFA schema: GCS must be 3–15", () => {
  assert.ok(accepts(qsofaInputShape, { gcs: 13 }));
  assert.ok(!accepts(qsofaInputShape, { gcs: 0 }));
  assert.ok(!accepts(qsofaInputShape, { gcs: 2 }));
  assert.ok(!accepts(qsofaInputShape, { gcs: 20 }));
});

test("non-finite results throw instead of being labelled with a band", () => {
  assert.throws(() => calculateEgfr({ age: 50, sex: "F", serum_creatinine_mgdl: 0 }), /non-finite/);
  assert.throws(() => calculateBmi({ weight_kg: 75, height_cm: 0 }), /non-finite/);
  assert.throws(
    () => calculateDas28({ tender_count: -2, swollen_count: 4, global_health: 50, formula: "esr", esr: 30 }),
    /non-finite/,
  );
});

// ── Reported score and band always agree ─────────────────────────────────────

function ckdStageOf(egfr: number): string {
  if (egfr >= 90) return "G1";
  if (egfr >= 60) return "G2";
  if (egfr >= 45) return "G3a";
  if (egfr >= 30) return "G3b";
  if (egfr >= 15) return "G4";
  return "G5";
}

test("eGFR: the stage always matches the reported (rounded) eGFR", () => {
  for (const sex of ["M", "F"] as const) {
    for (const age of [18, 40, 65, 90]) {
      for (let scr = 0.3; scr <= 8; scr += 0.001) {
        const r = calculateEgfr({ age, sex, serum_creatinine_mgdl: scr });
        assert.ok(
          r.ckd_stage.startsWith(`${ckdStageOf(r.score)}（`),
          `eGFR ${r.score} reported with stage ${r.ckd_stage}`,
        );
      }
    }
  }
});

test("BMI: a value that rounds to 24 is classified as overweight, not normal", () => {
  // 65.33 / 1.65² = 23.996… → reported as 24, which is the overweight cutoff.
  const r = calculateBmi({ weight_kg: 65.33, height_cm: 165 });
  assert.equal(r.score, 24);
  assert.equal(r.category, "過重");
});

test("DAS28: the activity band always matches the reported (rounded) score", () => {
  const bandOf = (s: number): RegExp =>
    s <= 2.6 ? /Remission/ : s <= 3.2 ? /Low/ : s <= 5.1 ? /Moderate/ : /High/;
  for (let esr = 1; esr <= 120; esr += 0.01) {
    const r = calculateDas28({ tender_count: 1, swollen_count: 1, global_health: 20, formula: "esr", esr });
    assert.match(r.disease_activity, bandOf(r.score), `DAS28 ${r.score} reported as ${r.disease_activity}`);
  }
});

test("CDAI: float noise on a band edge does not change the band", () => {
  // 0.1 + 2.7 sums to 2.8000000000000003 in IEEE-754; CDAI 2.8 is remission.
  const r = calculateCdai({ tender_count: 0, swollen_count: 0, patient_global: 0.1, provider_global: 2.7 });
  assert.equal(r.score, 2.8);
  assert.match(r.disease_activity, /Remission|緩解/);
});
