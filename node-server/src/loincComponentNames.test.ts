import { test } from "node:test";
import assert from "node:assert/strict";
import { buildComponentNames, nameKey, queryNameKeys } from "./loincComponentNames.js";
import { toTraditional } from "./conceptSearch/s2t.js";
import { loincDefaultness, loincFamily, loincShapePrior } from "./terminologyRanking.js";

test("toTraditional folds Simplified characters, keeps shared ones", () => {
  assert.equal(toTraditional("血红蛋白 白细胞 肝脏 锌"), "血紅蛋白 白細胞 肝臟 鋅");
  assert.equal(toTraditional("后天 尿酸 abc"), "后天 尿酸 abc");
});

test("nameKey / queryNameKeys: normalised, n-grams of Latin words, substrings of Han runs", () => {
  assert.equal(nameKey("  Uric  Acid "), "uric acid");
  assert.equal(nameKey("促卵泡激素"), "促卵泡激素");
  const k = queryNameKeys("uric acid level");
  assert.ok(k.includes("uric acid") && k.includes("uric acid level") && k.includes("acid"));
  const z = queryNameKeys("空腹血糖");
  assert.ok(z.includes("血糖") && z.includes("空腹血糖") && !z.includes("血"));
  assert.ok(queryNameKeys("血鋅").includes("鋅"));
});

test("buildComponentNames keeps analyte synonyms, drops axis vocabulary", () => {
  const rows: Record<string, string>[] = [];
  // Urate: three terms, all list "Uric acid"; one lists the specimen word "Synovial fluid".
  rows.push({ LOINC_NUM: "1-1", COMPONENT: "Urate", RELATEDNAMES2: "Uric acid; Serum; Point in time" });
  rows.push({ LOINC_NUM: "1-2", COMPONENT: "Urate", RELATEDNAMES2: "Uric acid; Urine; Point in time" });
  rows.push({ LOINC_NUM: "1-3", COMPONENT: "Urate", RELATEDNAMES2: "Uric acid; Synovial fluid; Point in time" });
  // "Point in time" on many analytes → axis word.
  for (let i = 0; i < 320; i += 1) rows.push({ LOINC_NUM: `9-${i}`, COMPONENT: `Analyte${i}`, RELATEDNAMES2: "Point in time" });
  const zhRows = [
    { LOINC_NUM: "1-1", COMPONENT: "尿酸盐", RELATEDNAMES2: "尿酸;血清 化学" },
    { LOINC_NUM: "1-2", COMPONENT: "尿酸盐", RELATEDNAMES2: "尿酸;尿液" },
    { LOINC_NUM: "1-3", COMPONENT: "尿酸盐", RELATEDNAMES2: "尿酸;滑膜液" },
  ];
  const out = buildComponentNames({ rows, zhRows });
  const urate = out.filter((r) => r[0] === "Urate").map((r) => `${r[2]}:${r[1]}`).sort();
  assert.deepEqual(urate, ["en:Uric acid", "zh:尿酸", "zh:尿酸鹽"]);
  assert.ok(!out.some((r) => r[1] === "Point in time"));
  assert.ok(out.every((r) => r[3] === nameKey(r[1])));
});

test("LOINC family / defaultness / shape", () => {
  assert.equal(loincFamily("Glucose^post CFst", "MCnc"), loincFamily("Glucose", "MCnc"));
  assert.notEqual(loincFamily("Hemoglobin", "EntMCnc"), loincFamily("Hemoglobin", "MCnc"));
  assert.ok(loincDefaultness({ common_test_rank: 17 }) > loincDefaultness({ common_test_rank: 2493 }));
  assert.ok(loincDefaultness({ common_test_rank: 20000 }) > loincDefaultness({ common_test_rank: null }));
  assert.ok(loincDefaultness({ common_test_rank: null }) > loincDefaultness({ common_test_rank: null, method_type: "Automated count" }));
  assert.ok(loincDefaultness({ common_test_rank: 5, status: "DEPRECATED" }) < 0);
  assert.ok(loincShapePrior("renin", { long_common_name: "Aldosterone and renin panel - Plasma", component: "Aldosterone & renin panel" }) < 0);
  assert.equal(loincShapePrior("renin panel", { long_common_name: "Aldosterone and renin panel - Plasma", component: "x" }), 0);
  assert.ok(loincShapePrior("serum osmolality", { long_common_name: "Osmolality.urine/Osmolality.serum", component: "Osmolality.urine/Osmolality.serum" }) < 0);
  assert.equal(loincShapePrior("BUN/Cr ratio", { long_common_name: "x", component: "Urea nitrogen/Creatinine" }), 0);
});
