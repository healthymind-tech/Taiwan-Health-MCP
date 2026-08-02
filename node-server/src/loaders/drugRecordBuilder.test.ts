import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDrugRecord, canonicalizeUnit, type Dict } from "./drugRecordBuilder.js";

const ROW: Dict = { 許可證字號: "衛署藥製字第000001號", 主成分略述: "" };

function activeIngredients(record: Dict): Dict[] {
  return (record["ingredients"] as Dict)["active"] as Dict[];
}

test("canonicalizeUnit folds TFDA/analysis unit spellings into the allowed set", () => {
  assert.equal(canonicalizeUnit("MG"), "mg");
  assert.equal(canonicalizeUnit("GM"), "g");
  assert.equal(canonicalizeUnit("ML"), "mL");
  assert.equal(canonicalizeUnit("mcg"), "mcg");
  assert.equal(canonicalizeUnit("μg"), "mcg");
  assert.equal(canonicalizeUnit("毫克"), "mg");
  assert.equal(canonicalizeUnit("公克"), "g");
  assert.equal(canonicalizeUnit("毫升"), "mL");
  assert.equal(canonicalizeUnit("IU"), "IU");
  assert.equal(canonicalizeUnit("單位"), "單位");
  assert.equal(canonicalizeUnit("MG/ML"), "mg/mL");
  assert.equal(canonicalizeUnit("% w/v"), "%w/v");
  assert.equal(canonicalizeUnit(""), "");
  assert.equal(canonicalizeUnit("每錠"), "");
  assert.equal(canonicalizeUnit("Potency"), "");
});

test("analysis 含量 with an embedded unit splits into value + unit", () => {
  const record = buildDrugRecord(ROW, {
    analysis: {
      有效成分及含量: [{ 成分: "Sodium Bicarbonate", 含量: "500.0 mg" }],
      其他成分: [],
    },
  });
  assert.deepEqual(activeIngredients(record), [
    { name: "Sodium Bicarbonate", amount: "500.0", unit: "mg", raw_text: "Sodium Bicarbonate 500.0 mg" },
  ]);
});

test("EI unit column is canonicalized", () => {
  const record = buildDrugRecord(ROW, {
    electronicInsert: {
      ingredients: { 成分: [{ 成分名稱: "NEOMYCIN (SULFATE)", 含量: "250", 單位: "MG" }] },
    },
  });
  assert.deepEqual(activeIngredients(record), [
    { name: "NEOMYCIN (SULFATE)", amount: "250", unit: "mg", raw_text: "NEOMYCIN (SULFATE) 250 MG" },
  ]);
});

test("compound and parenthetical amounts are split, annotations dropped from the display", () => {
  const record = buildDrugRecord(ROW, {
    analysis: {
      有效成分及含量: [
        { 成分: "Glucose", 含量: "25 mg/mL" },
        { 成分: "Kanamycin Sulfate", 含量: "1202 mg(Eq.ToKanamycinBase1 g)" },
        { 成分: "Vitamin C", 含量: "2.5%w/v" },
      ],
      其他成分: [],
    },
  });
  assert.deepEqual(activeIngredients(record), [
    { name: "Glucose", amount: "25", unit: "mg/mL", raw_text: "Glucose 25 mg/mL" },
    { name: "Kanamycin Sulfate", amount: "1202", unit: "mg", raw_text: "Kanamycin Sulfate 1202 mg(Eq.ToKanamycinBase1 g)" },
    { name: "Vitamin C", amount: "2.5", unit: "%w/v", raw_text: "Vitamin C 2.5%w/v" },
  ]);
});

test("no unit is left empty, not invented", () => {
  const record = buildDrugRecord(ROW, {
    analysis: {
      有效成分及含量: [
        { 成分: "Magnesium Stearate", 含量: "適量" },
        { 成分: "Thiamine Hydrochloride", 含量: "每mL含50 mg" },
      ],
      其他成分: [],
    },
  });
  const items = activeIngredients(record);
  assert.deepEqual(items[0], {
    name: "Magnesium Stearate",
    amount: "適量",
    unit: "",
    raw_text: "Magnesium Stearate 適量",
  });
  assert.equal(items[1].amount, "每mL含50 mg");
  assert.equal(items[1].unit, "");
});
