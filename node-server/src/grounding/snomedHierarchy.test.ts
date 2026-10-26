import assert from "node:assert/strict";
import { test } from "node:test";

import { createSnomedHierarchy, type QueryFn } from "./snomedChinese.js";

// Fake terminology: J18 肺炎 → 233604007 (pneumonia), whose ancestors include 50417007 (lower respiratory tract infection);
// 10625071000119104 is a narrower pneumonia concept.
const ICD: Record<string, string> = { 肺炎: "J18", 氣喘: "J45" };
const MAP: Record<string, string> = { J18: "233604007", "J18.9": "233604007", J45: "195967001", "J45.9": "195967001" };
const ANC: Record<string, string[]> = {
  "233604007": ["50417007", "404684003"],
  "50417007": ["404684003"],
  "195967001": ["404684003"],
  "10625071000119104": ["233604007", "50417007", "404684003"],
};
const query: QueryFn = async (sql, params) => {
  const arg = params[0] as string[];
  if (sql.includes("icd.diagnoses")) return { rows: arg.filter((n) => ICD[n]).map((n) => ({ code: ICD[n], name_zh: n })) };
  if (sql.includes("icd10_map")) return { rows: [...new Set(arg.map((t) => MAP[t]).filter(Boolean))].map((id) => ({ id })) };
  if (sql.includes("concept_ancestors")) return { rows: arg.filter((c) => ANC[c]).map((c) => ({ id: c, anc: ANC[c] })) };
  return { rows: [] };
};

test("hierarchy guard: a Chinese name without an exact ICD name relates through its head-final tail, broader codes only", async () => {
  const h = createSnomedHierarchy({ query });
  const items = [{ key: "社區型肺炎", icd: [], names: ["社區型肺炎"] }];
  const r = await h.relatedSlotItems(["50417007", "233604007", "10625071000119104", "195967001"], items);
  assert.deepEqual([...(r.get("50417007") ?? [])], ["社區型肺炎"]); // LRTI: an ancestor of the tail's pneumonia
  assert.deepEqual([...(r.get("233604007") ?? [])], ["社區型肺炎"]); // the tail's own concept
  assert.equal(r.has("10625071000119104"), false); // narrower than the tail: may be another pneumonia
  assert.equal(r.has("195967001"), false); // asthma: unrelated
});

test("hierarchy guard: an exact ICD name keeps both directions; no tail is tried", async () => {
  const h = createSnomedHierarchy({ query });
  const r = await h.relatedSlotItems(["10625071000119104", "50417007"], [{ key: "肺炎", icd: [], names: ["肺炎"] }]);
  assert.equal(r.has("10625071000119104"), true);
  assert.equal(r.has("50417007"), true);
});
