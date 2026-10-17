/**
 * DB-backed terminology provider: routing, batching, LRU and fail-open behaviour against a fake `query`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { createDbTerminologyNames, routeSystem } from "./terminologyDb.js";

type Row = Record<string, unknown>;

function fakeDb(fail: RegExp | null = null): { calls: string[]; query: (sql: string, params: unknown[]) => Promise<{ rows: Row[] }> } {
  const calls: string[] = [];
  const query = async (sql: string, params: unknown[]): Promise<{ rows: Row[] }> => {
    calls.push(sql);
    if (fail && fail.test(sql)) throw new Error("boom");
    const p0 = (params[0] ?? []) as string[];
    if (sql.includes("FROM icd.diagnoses"))
      return {
        rows: [{ code: "M54.50", short_name_en: "Low back pain, unspecified", name_en: "Low back pain, unspecified", name_zh: "下背痛" }].filter((r) => p0.includes(r.code)),
      };
    if (sql.includes("FROM icd.procedures")) return { rows: [] };
    if (sql.includes("FROM loinc.concepts"))
      return {
        rows: [
          { loinc_num: "2160-0", long_common_name: "Creatinine [Mass/volume] in Serum or Plasma", shortname: "Creat SerPl-mCnc", name_zh: "肌酸酐", common_name_zh: "Cr", consumer_name: null, component: "Creatinine" },
        ].filter((r) => p0.includes(r.loinc_num)),
      };
    if (sql.includes("FROM snomed.descriptions"))
      return {
        rows: [
          { code: "26643006", term: "Oral route", type_id: "900000000000013009", us_preferred: true },
          { code: "26643006", term: "Oral route (qualifier value)", type_id: "900000000000003001", us_preferred: false },
        ].filter((r) => p0.includes(r.code)),
      };
    if (sql.includes("FROM rxnorm.concepts")) return { rows: [] };
    if (sql.includes("FROM fhir.concepts"))
      return { rows: [{ cs_id: "medical-consultation-department-nhi-tw", code: "01", display: "家醫科", definition: null }] };
    if (sql.includes("icd.editions")) return { rows: [{ edition: "2026-04-01" }] };
    if (sql.includes("loinc.editions")) return { rows: [{ version: "2.80" }] };
    if (sql.includes("snomed.editions")) return { rows: [{ v: "2025-06-01" }] };
    if (sql.includes("ig_packages")) return { rows: [{ v: "tw.gov.mohw.twcore#1.0.0" }] };
    return { rows: [] };
  };
  return { calls, query };
}

const KEYS = [
  "http://hl7.org/fhir/sid/icd-10-cm|M54.50",
  "https://twcore.mohw.gov.tw/ig/twcore/CodeSystem/icd-10-cm-2023-tw|M5450",
  "http://loinc.org|2160-0",
  "http://snomed.info/sct|26643006",
  "http://hl7.org/fhir/sid/cvx|08",
  "https://twcore.mohw.gov.tw/ig/twcore/CodeSystem/medical-consultation-department-nhi-tw|01",
  "http://terminology.hl7.org/CodeSystem/v3-ActCode|AMB",
  "http://www.whocc.no/atc|N02BE01",
];

test("routing of code systems", () => {
  assert.equal(routeSystem("http://hl7.org/fhir/sid/icd-10-cm"), "icd_cm");
  assert.equal(routeSystem("https://twcore.mohw.gov.tw/ig/twcore/CodeSystem/icd-10-cm-2023-tw"), "icd_cm");
  assert.equal(routeSystem("https://twcore.mohw.gov.tw/ig/twcore/CodeSystem/icd-10-pcs-2021-tw"), "icd_pcs");
  assert.equal(routeSystem("http://www.cms.gov/Medicare/Coding/ICD10"), "icd_any");
  assert.equal(routeSystem("http://loinc.org"), "loinc");
  assert.equal(routeSystem("http://terminology.hl7.org/CodeSystem/v3-ActCode"), "skip");
  assert.equal(routeSystem("http://www.whocc.no/atc"), "ig");
});

test("batch lookup: names per source, ICD dot variants, IG displays, skipped systems not found", async () => {
  const db = fakeDb();
  const p = createDbTerminologyNames({ query: db.query });
  const m = await p.lookup(KEYS);
  assert.deepStrictEqual(m.get(KEYS[0]), { found: true, names: ["Low back pain, unspecified", "下背痛"], source: ["icd.diagnoses"] });
  assert.deepStrictEqual(m.get(KEYS[1])?.names, ["Low back pain, unspecified", "下背痛"]);
  assert.ok(m.get(KEYS[2])?.names.includes("肌酸酐"));
  assert.deepStrictEqual(m.get(KEYS[3])?.names, ["Oral route", "Oral route (qualifier value)"]);
  assert.ok(m.get(KEYS[4])?.found);
  assert.deepStrictEqual(m.get(KEYS[5])?.names, ["家醫科"]);
  assert.equal(m.get(KEYS[6])?.found, false);
  assert.equal(m.get(KEYS[7])?.found, false);
  // one query per table, no per-code round trips
  assert.ok(db.calls.length <= 6, String(db.calls.length));
  const before = db.calls.length;
  await p.lookup(KEYS);
  assert.equal(db.calls.length, before, "second lookup must be served from the LRU");
  assert.equal(p.stats().hits, KEYS.length);
  assert.equal(await p.version(), "db: icd10cm 2026-04-01; loinc 2.80; snomed 2025-06-01; ig tw.gov.mohw.twcore#1.0.0");
});

test("fail-open: a failing table yields not-found (never throws) and is not cached", async () => {
  const db = fakeDb(/loinc\.concepts/);
  const p = createDbTerminologyNames({ query: db.query });
  const m = await p.lookup(["http://loinc.org|2160-0", "http://hl7.org/fhir/sid/icd-10-cm|M54.50"]);
  assert.equal(m.get("http://loinc.org|2160-0")?.found, false);
  assert.equal(m.get("http://hl7.org/fhir/sid/icd-10-cm|M54.50")?.found, true);
  assert.equal(p.stats().cached, 1);
});

test("LRU evicts least recently used entries", async () => {
  const db = fakeDb();
  const p = createDbTerminologyNames({ query: db.query, cacheSize: 2 });
  await p.lookup(["http://loinc.org|2160-0", "http://loinc.org|a", "http://loinc.org|b"]);
  assert.equal(p.stats().cached, 2);
});
