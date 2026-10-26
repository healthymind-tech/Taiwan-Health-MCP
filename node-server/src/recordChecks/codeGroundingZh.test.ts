/**
 * Coded-element grounding with Chinese names of SNOMED codes (ISSUES_v15.3 R3 follow-up): grounding/snomedChinese.ts
 * over fake tables (map rows, ICD Chinese names, designations, thesaurus) and the R3 decision in codeGrounding.ts.
 * Synthetic data only.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { IN_RECORD, inBundle } from "../../scripts/record-checks-eval/synthetic151.js";
import { fakeChineseNames, syntheticR3ZhCases, withChineseNames, type R3ZhCase } from "../../scripts/record-checks-eval/syntheticR3zh.js";
import { checkGroundingSync } from "../grounding/checkGrounding.js";
import { mergeGroundingIntoValidation } from "../grounding/merge.js";
import { RecordText } from "../grounding/recordText.js";
import { judgeCode } from "./codeGrounding.js";
import { diagnosisSlots } from "./diagnosisSlot.js";
import { addRecordChecksToValidation } from "./envelope.js";
import { recordCheckLookups } from "./lookups.js";

type Json = Record<string, any>;
const SCT = "http://snomed.info/sct";

function envelope(c: R3ZhCase, withZh = true): Json {
  const g = checkGroundingSync({ bundle: c.bundle, source_text: c.source_text, site_config: null, mode: "auto" } as never, c.terms as never);
  const entries = c.bundle.entry.map((e: Json) => ({ fullUrl: e.fullUrl, resourceType: e.resource.resourceType, valid: true, issues: [] }));
  const text = JSON.stringify({ ok: true, data: mergeGroundingIntoValidation({ valid: true, issues: [], entries }, g), warnings: [] });
  return JSON.parse(
    addRecordChecksToValidation(text, c.bundle, {
      sourceText: c.source_text,
      codeNames: new Map([...c.terms].map(([k, v]) => [k, v.names])),
      ...(withZh ? { codeNamesZh: c.zh ?? null } : {}),
    }),
  );
}

const codeIssues = (out: Json, c: R3ZhCase): Json[] =>
  (out.data.entries[c.entry].issues as Json[]).filter((i) => i.source === "grounding" && i.path === `Bundle.entry[${c.entry}].resource.${c.element}` && /G-UNGROUNDED|G-VALUE-MISMATCH/u.test(i.rule));

test("R3 Chinese names: ≥ 20 synthetic cases — wrong SNOMED codes vs a Chinese slot are errors, right / near codes never", async () => {
  const cases = await withChineseNames(syntheticR3ZhCases());
  assert.ok(cases.length >= 20, `${cases.length} cases`);
  assert.ok(cases.filter((c) => c.expect === "error").length >= 5 && cases.filter((c) => c.expect === "warning").length >= 10);
  for (const c of cases) {
    const iss = codeIssues(envelope(c), c);
    if (c.expect === "error") {
      assert.equal(iss.length, 1, c.id);
      assert.equal(iss[0].severity, "error", `${c.id}: ${iss[0].grounding_code_check}`);
      assert.equal(iss[0].grounding_code_check, "contradicted", c.id);
    } else for (const i of iss) assert.notEqual(i.severity, "error", `${c.id}: ${i.grounding_code_check} ${JSON.stringify(i.closest_record_phrase)}`);
  }
});

test("R3 Chinese names: the two cases of the last verification (asthma / UTI vs 社區型肺炎) were uncertain, are now contradicted", async () => {
  const cases = await withChineseNames(syntheticR3ZhCases());
  for (const id of ["zh-asthma-vs-cap", "zh-uti-vs-cap"]) {
    const c = cases.find((x) => x.id === id)!;
    const before = codeIssues(envelope(c, false), c);
    assert.equal(before[0].severity, "warning", id);
    assert.equal(before[0].grounding_code_check, "uncertain", id);
    const after = codeIssues(envelope(c), c);
    assert.equal(after[0].severity, "error", id);
    assert.equal(after[0].grounding_code_check, "contradicted", id);
    assert.match(after[0].message, /compared through the code's Chinese name/u, id);
    assert.match(after[0].message_zh, /以代碼的中文名稱/u, id);
    assert.ok(after[0].compared.chinese_names.length > 0, id);
    for (const z of after[0].compared.chinese_names) assert.deepEqual(Object.keys(z).sort(), ["confidence", "name", "source"]);
  }
});

test("snomedChineseNames: sources, confidences, ICD qualifier stripping, conditional map rules, caching", async () => {
  const log: string[] = [];
  const p = fakeChineseNames(log);
  const asthma = await p.snomedChineseNames("195967001");
  const by = (src: string): string[] => asthma.filter((z) => z.source === src).map((z) => z.name);
  // WHO J45.9 is a header in ICD-10-CM: named by its unspecified child J45.909, core without 未明示 / 無併發症
  // (the core 氣喘 is also the thesaurus rendering: one entry per name, the higher confidence kept)
  assert.deepEqual(by("icd_map_child"), ["未明示氣喘，無併發症"], JSON.stringify(asthma));
  assert.equal(asthma.find((z) => z.source === "icd_map_child")!.icd, "J45.909");
  assert.deepEqual(asthma.find((z) => z.name === "氣喘"), { name: "氣喘", source: "thesaurus", confidence: 0.72 });
  assert.ok(asthma.some((z) => z.source === "icd_category_member" && z.confidence < 0.5), "category members are below every threshold");
  // an IG ValueSet with a Chinese display
  const htn = await p.snomedChineseNames("38341003");
  assert.deepEqual(htn.find((z) => z.source === "ig_display"), { name: "高血壓", source: "ig_display", confidence: 0.85 });
  // the first group-1 rule is conditional: the OTHERWISE TRUE target, at lower confidence
  const anemia = await p.snomedChineseNames("271737000");
  const a = anemia.find((z) => z.source === "icd_map")!;
  assert.equal(a.icd, "D64.9");
  assert.equal(a.confidence, 0.65);
  // a WHO-only target (I64) has no ICD Chinese name; the thesaurus still renders 'Stroke'
  const cva = await p.snomedChineseNames("230690007");
  assert.ok(!cva.some((z) => z.source.startsWith("icd_")));
  assert.ok(cva.some((z) => z.source === "thesaurus" && z.name === "中風"));
  // cached: no new query for a known concept
  const n = log.length;
  await p.snomedChineseNames("195967001");
  await p.lookup(["195967001", "38341003"]);
  assert.equal(log.length, n);
  assert.deepEqual(await p.lookup(["not-a-code"]), new Map());
});

test("snomedChineseNames: a failing query degrades to fewer names and is not cached", async () => {
  let fail = true;
  const { createSnomedChineseNames } = await import("../grounding/snomedChinese.js");
  const p = createSnomedChineseNames({
    query: async (sql) => {
      if (fail && sql.includes("snomed.icd10_map")) throw new Error("db down");
      if (sql.includes("snomed.icd10_map")) return { rows: [{ id: "68566005", map_target: "N39.0", map_rule: "TRUE", map_priority: 1, map_group: 1, active: true }] };
      if (sql.includes("WHERE code = ANY")) return { rows: [{ code: "N39.0", name_zh: "泌尿道感染，部位未明示" }] };
      return { rows: [] };
    },
  });
  assert.deepEqual(await p.snomedChineseNames("68566005"), []);
  fail = false;
  const names = await p.snomedChineseNames("68566005");
  assert.deepEqual(names.map((z) => z.name), ["泌尿道感染", "泌尿道感染，部位未明示"]);
  assert.equal(names[0].confidence, 0.75);
});

test("judgeCode: Chinese names below 0.6 never make a slot comparable; the mapped ICD category in the slot is never different", () => {
  const rt = new RecordText(IN_RECORD, null);
  const slots = diagnosisSlots(rt);
  const code = { coding: [{ system: SCT, code: "195967001", display: "Asthma" }] };
  const names = new Map([[`${SCT}|195967001`, ["Asthma"]]]);
  const zh = (confidence: number, source = "thesaurus", icd?: string) => new Map([[`${SCT}|195967001`, [{ name: "氣喘", source, confidence, ...(icd ? { icd } : {}) }]]]);
  assert.equal(judgeCode(code, "Condition.code", rt, slots, true, names).verdict, "uncertain");
  assert.equal(judgeCode(code, "Condition.code", rt, slots, true, names, zh(0.55)).verdict, "uncertain");
  assert.equal(judgeCode(code, "Condition.code", rt, slots, true, names, zh(0.72)).verdict, "contradicted");
  assert.equal(judgeCode(code, "Condition.code", rt, slots, false, names, zh(0.72)).verdict, "uncertain", "never for a non-primary Condition");
  // ICD-derived name whose category is the slot's ICD category (J18): not different
  const rt2 = new RecordText(IN_RECORD.replace("診斷：社區型肺炎 (J18.9)", "診斷：大葉性肺炎 (J18.1)"), null);
  const pn = { coding: [{ system: SCT, code: "195967001", display: "Asthma" }] };
  assert.equal(judgeCode(pn, "Condition.code", rt2, diagnosisSlots(rt2), true, names, zh(0.75, "icd_map", "J18.9")).verdict, "uncertain");
  assert.equal(judgeCode(pn, "Condition.code", rt2, diagnosisSlots(rt2), true, names, zh(0.75, "icd_map", "J45.909")).verdict, "contradicted");
});

test("recordCheckLookups: SNOMED Chinese names only with source_text and a provider that has them; fail-open", async () => {
  const b = inBundle();
  b.entry[2].resource.code = { coding: [{ system: SCT, code: "195967001", display: "Asthma" }] };
  const p = fakeChineseNames();
  const t = {
    lookup: async (keys: readonly string[]) => new Map(keys.map((k) => [k, { names: ["n"] }])),
    snomedChineseNamesBatch: (ids: readonly string[]) => p.lookup(ids),
  };
  assert.equal((await recordCheckLookups(b, t, null)).codeNamesZh, undefined);
  const l = await recordCheckLookups(b, t, "record");
  assert.ok(l.codeNamesZh?.get(`${SCT}|195967001`)?.length);
  const bad = { ...t, snomedChineseNamesBatch: async (): Promise<never> => Promise.reject(new Error("db down")) };
  const l2 = await recordCheckLookups(b, bad, "record");
  assert.equal(l2.codeNamesZh, undefined);
  assert.ok(l2.codeNames.size > 0);
});

test("createDbTerminologyNames: snomedChineseNames uses the cached SNOMED descriptions for the thesaurus; lookup() never returns Chinese names", async () => {
  const { createDbTerminologyNames } = await import("../grounding/terminologyDb.js");
  const { fakeChineseQuery, FAKE_EN } = await import("../../scripts/record-checks-eval/syntheticR3zh.js");
  const zhQuery = fakeChineseQuery();
  const t = createDbTerminologyNames({
    query: async (sql, params) => {
      if (sql.includes("FROM snomed.descriptions")) {
        const ids = (params[0] as string[]).map(String);
        return { rows: ids.flatMap((id) => (FAKE_EN[id] ?? []).map((term) => ({ code: id, term, type_id: "x", us_preferred: true }))) };
      }
      return zhQuery(sql, params);
    },
  });
  const names = await t.snomedChineseNames("230690007");
  assert.ok(names.some((z) => z.source === "thesaurus" && z.name === "中風"), JSON.stringify(names));
  const rec = (await t.lookup([`${SCT}|230690007`])).get(`${SCT}|230690007`)!;
  assert.ok(rec.names.every((n) => !/[一-鿿]/u.test(n)), "grounding's names stay the SNOMED descriptions");
  assert.ok((await t.snomedChineseNamesBatch(["195967001"])).get("195967001")?.length);
});
