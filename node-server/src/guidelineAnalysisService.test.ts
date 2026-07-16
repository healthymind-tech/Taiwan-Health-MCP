/**
 * Coverage for the one genuinely new validation shape the guideline analysis
 * pipeline needs beyond the drug pipeline's `validateAnalysisShape`: arrays of
 * row-shaped objects (diagnostic/medication/test/goal recommendations), not
 * just scalars/nested objects.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GUIDELINE_ANALYSIS_TEMPLATE,
  normalizeGuidelineAnalysisData,
  normalizeGuidelineAnalysisResponse,
  validateGuidelineAnalysisShape,
  validateGuidelineAnalysisResponse,
} from "./guidelineAnalysisService.js";

function validSample(): Record<string, unknown> {
  return {
    disease_info: {
      icd_code: "E11",
      disease_name_zh: "第二型糖尿病",
      disease_name_en: "Type 2 Diabetes Mellitus",
      guideline_title: "2024 台灣糖尿病臨床照護指引",
      guideline_source: "中華民國糖尿病學會",
      publication_year: "2024",
      guideline_summary: "涵蓋診斷、血糖控制目標、藥物治療",
    },
    diagnostic_recommendations: [
      { step_order: "1", recommendation_type: "實驗室檢查", description: "空腹血糖 ≥126 mg/dL", evidence_level: "A" },
    ],
    medication_recommendations: [
      {
        line_of_therapy: "第一線",
        medication_class: "雙胍類",
        medication_examples: "Metformin",
        dosage_guidance: "500mg 每日一次",
        contraindications: "腎功能不全",
        evidence_level: "A",
      },
    ],
    test_recommendations: [
      {
        test_category: "生化檢驗",
        test_name: "糖化血色素",
        loinc_code: "4548-4",
        frequency: "每3個月一次",
        indication: "監測血糖控制",
        evidence_level: "A",
      },
    ],
    treatment_goals: [
      { goal_type: "血糖控制", target_parameter: "HbA1c", target_value: "<7.0%", timeframe: "長期目標" },
    ],
  };
}

test("validateGuidelineAnalysisShape accepts a well-formed extraction", () => {
  assert.deepEqual(validateGuidelineAnalysisShape(validSample()), []);
});

test("validateGuidelineAnalysisShape rejects a non-object payload", () => {
  assert.deepEqual(validateGuidelineAnalysisShape("not an object"), ["$ 必須是 object。"]);
  assert.deepEqual(validateGuidelineAnalysisShape(null), ["$ 必須是 object。"]);
});

test("validateGuidelineAnalysisShape reports missing/extra top-level fields", () => {
  const data = validSample();
  delete (data as Record<string, unknown>).treatment_goals;
  (data as Record<string, unknown>).unexpected_field = [];
  const errors = validateGuidelineAnalysisShape(data);
  assert.ok(errors.some((e) => e.includes("缺少欄位: treatment_goals")));
  assert.ok(errors.some((e) => e.includes("多出欄位: unexpected_field")));
});

test("validateGuidelineAnalysisShape rejects disease_info missing/extra fields and wrong types", () => {
  const data = validSample();
  const info = data.disease_info as Record<string, unknown>;
  delete info.guideline_source;
  info.extra_thing = "x";
  info.publication_year = 2024; // number instead of string
  const errors = validateGuidelineAnalysisShape(data);
  assert.ok(errors.some((e) => e.includes("$.disease_info 缺少欄位: guideline_source")));
  assert.ok(errors.some((e) => e.includes("$.disease_info 多出欄位: extra_thing")));
  assert.ok(errors.some((e) => e === "$.disease_info.publication_year 必須是 string。"));
});

test("validateGuidelineAnalysisShape requires recommendation arrays to be arrays", () => {
  const data = validSample();
  (data as Record<string, unknown>).medication_recommendations = "not an array";
  const errors = validateGuidelineAnalysisShape(data);
  assert.ok(errors.includes("$.medication_recommendations 必須是 array。"));
});

test("validateGuidelineAnalysisShape checks each row's fields against its row template", () => {
  const data = validSample();
  const rows = data.medication_recommendations as Record<string, unknown>[];
  delete rows[0].dosage_guidance;
  rows[0].unexpected = "x";
  rows[0].evidence_level = 5; // wrong type
  const errors = validateGuidelineAnalysisShape(data);
  assert.ok(errors.some((e) => e.includes("$.medication_recommendations[0] 缺少欄位: dosage_guidance")));
  assert.ok(errors.some((e) => e.includes("$.medication_recommendations[0] 多出欄位: unexpected")));
  assert.ok(errors.some((e) => e === "$.medication_recommendations[0].evidence_level 必須是 string。"));
});

test("normalizeGuidelineAnalysisData fills missing/malformed input with template defaults", () => {
  const normalized = normalizeGuidelineAnalysisData({});
  assert.deepEqual(normalized, {
    disease_info: {
      icd_code: "",
      disease_name_zh: "",
      disease_name_en: "",
      guideline_title: "",
      guideline_source: "",
      publication_year: "",
      guideline_summary: "",
    },
    diagnostic_recommendations: [],
    medication_recommendations: [],
    test_recommendations: [],
    treatment_goals: [],
  });
  // The normalized shape always validates clean, even from garbage input.
  assert.deepEqual(validateGuidelineAnalysisShape(normalized), []);
});

test("normalizeGuidelineAnalysisData coerces non-string scalars and drops non-object rows", () => {
  const normalized = normalizeGuidelineAnalysisData({
    disease_info: { icd_code: "E11", publication_year: 2024 },
    diagnostic_recommendations: [
      { step_order: 1, recommendation_type: "x", description: "y", evidence_level: "A" },
      "not an object",
      null,
    ],
  });
  const info = normalized.disease_info as Record<string, string>;
  assert.equal(info.icd_code, "E11");
  assert.equal(info.publication_year, "2024");
  const diagnostics = normalized.diagnostic_recommendations as Record<string, string>[];
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].step_order, "1");
});

test("GUIDELINE_ANALYSIS_TEMPLATE has the five documented top-level sections", () => {
  assert.deepEqual(Object.keys(GUIDELINE_ANALYSIS_TEMPLATE).sort(), [
    "diagnostic_recommendations",
    "disease_info",
    "medication_recommendations",
    "test_recommendations",
    "treatment_goals",
  ]);
});

// ── Envelope-level: {"guidelines": [...]} — one PDF may cover several diseases ──

function validResponseSample(): Record<string, unknown> {
  return { guidelines: [validSample(), validSample()] };
}

test("validateGuidelineAnalysisResponse accepts a multi-disease response", () => {
  assert.deepEqual(validateGuidelineAnalysisResponse(validResponseSample()), []);
});

test("validateGuidelineAnalysisResponse rejects a non-object payload", () => {
  assert.deepEqual(validateGuidelineAnalysisResponse("not an object"), ["$ 必須是 object。"]);
});

test("validateGuidelineAnalysisResponse requires guidelines to be a non-empty array", () => {
  assert.ok(
    validateGuidelineAnalysisResponse({}).some((e) => e.includes("缺少欄位: guidelines")),
  );
  assert.deepEqual(validateGuidelineAnalysisResponse({ guidelines: "not an array" }), [
    "$.guidelines 必須是 array。",
  ]);
  assert.deepEqual(validateGuidelineAnalysisResponse({ guidelines: [] }), [
    "$.guidelines 不可為空陣列（至少要判斷出一種疾病）。",
  ]);
});

test("validateGuidelineAnalysisResponse delegates per-element validation with an indexed path", () => {
  const bad = validSample();
  delete (bad as Record<string, unknown>).treatment_goals;
  const errors = validateGuidelineAnalysisResponse({ guidelines: [validSample(), bad] });
  assert.ok(errors.some((e) => e.includes("$.guidelines[1]") && e.includes("缺少欄位: treatment_goals")));
});

test("normalizeGuidelineAnalysisResponse normalizes every element and drops a non-array guidelines field", () => {
  assert.deepEqual(normalizeGuidelineAnalysisResponse({ guidelines: "nope" }), []);
  const normalized = normalizeGuidelineAnalysisResponse({
    guidelines: [{ disease_info: { icd_code: "E11" } }, { disease_info: { icd_code: "I10" } }],
  });
  assert.equal(normalized.length, 2);
  assert.equal((normalized[0].disease_info as Record<string, string>).icd_code, "E11");
  assert.equal((normalized[1].disease_info as Record<string, string>).icd_code, "I10");
  assert.deepEqual(validateGuidelineAnalysisResponse({ guidelines: normalized }), []);
});
