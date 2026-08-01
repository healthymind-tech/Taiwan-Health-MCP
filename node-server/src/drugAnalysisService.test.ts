/**
 * Coverage for the post-LM cleanup in normalizeAnalysisData: MinerU OCR
 * artifact characters, OCR-merged English component names, and non-canonical
 * 含量 (amount) values. Everything here is deterministic — no LM involved.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  convertTextToTraditional,
  normalizeAnalysisData,
  validateContentChecks,
} from "./drugAnalysisService.js";

test("convertTextToTraditional fixes MinerU OCR artifact characters", () => {
  assert.equal(convertTextToTraditional("同㇐個注射筒㇠醯㇠⾧"), "同一個注射筒乙醯乙長");
  assert.equal(convertTextToTraditional("\uF071成分："), "成分：");
});

test("normalizeAnalysisData fixes OCR-merged English component names", () => {
  const out = normalizeAnalysisData({
    有效成分及含量: [],
    其他成分: [
      { 成分: "WaterforInjection", 含量: "" },
      { 成分: "PolyethyleneGlycol400", 含量: "" },
      { 成分: "TartaricAcid", 含量: "" },
      { 成分: "HydrochloricAcid", 含量: "" },
    ],
  });
  const names = (out["其他成分"] as Record<string, string>[]).map((i) => i["成分"]);
  assert.deepEqual(names, [
    "Water for Injection",
    "Polyethylene Glycol 400",
    "Tartaric Acid",
    "Hydrochloric Acid",
  ]);
});

test("normalizeAnalysisData leaves already-correct names alone", () => {
  const out = normalizeAnalysisData({
    有效成分及含量: [{ 成分: "Benzyl Alcohol", 含量: "" }],
    其他成分: [],
  });
  assert.deepEqual(out["有效成分及含量"], [{ 成分: "Benzyl Alcohol", 含量: "" }]);
});

test("normalizeAnalysisData canonicalizes and cleans 含量", () => {
  const out = normalizeAnalysisData({
    有效成分及含量: [
      { 成分: "Dextrose Monohydrate", 含量: "0.4 gm" },
      { 成分: "Dipyridamole", 含量: "10mg" },
      { 成分: "Sodium Bicarbonate", 含量: "500.0 mg" },
      { 成分: "Estradiol Cyclopentylpropionate", 含量: "每 ml 含" },
      { 成分: "Vitamin C", 含量: "50mg" },
      { 成分: "Calcium", 含量: "適量" },
      { 成分: "Sodium", 含量: "賦形劑" },
    ],
    其他成分: [],
  });
  const amounts = (out["有效成分及含量"] as Record<string, string>[]).map((i) => i["含量"]);
  assert.deepEqual(amounts, ["0.4 g", "10 mg", "500.0 mg", "", "50 mg", "適量", ""]);
});

const populated = {
  有效成分及含量: [{ 成分: "Dipyridamole", 含量: "10 mg" }],
  其他成分: [],
  "用途(適應症)": ["腳氣病，多發性神經炎"],
};

test("validateContentChecks passes a populated analysis", () => {
  assert.deepEqual(validateContentChecks(populated, "適應症 腳氣病。"), []);
});

test("validateContentChecks rejects an empty 有效成分及含量", () => {
  const errors = validateContentChecks({ ...populated, 有效成分及含量: [] });
  assert.deepEqual(errors, ["$.有效成分及含量 不能為空"]);
});

test("validateContentChecks rejects an empty 用途 only when the markdown mentions one", () => {
  const emptyUsage = { ...populated, "用途(適應症)": [] };
  assert.deepEqual(validateContentChecks(emptyUsage, "適應症 青光眼。"), [
    "$.用途(適應症) 不能為空",
  ]);
  assert.deepEqual(validateContentChecks(emptyUsage, "成分及儲存方式說明。"), []);
  assert.deepEqual(validateContentChecks(emptyUsage), []);
});
