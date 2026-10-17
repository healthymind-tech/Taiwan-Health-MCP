import { test } from "node:test";
import assert from "node:assert/strict";
import type { Q, Row } from "./common.js";
import { ftsPrefixQuery, hasCjk, VersionedCache } from "./common.js";
import {
  buildParentMap,
  buildWhoIndex,
  categoryIndex,
  cmChildren,
  cmPath,
  cmStructure,
  codeNode,
  isSeventhExtension,
  normalizeCmCode,
  pcsBreakdown,
  pcsHierarchy,
  pcsTables,
  type CodeRow,
} from "./icd.js";
import { buildAxisBar, groupAnswerLists, loincWhere, parseLoincFilters } from "./loinc.js";
import { pickTerms, semanticTag, shapeAssociations, shapeAttributes, FSN, SYNONYM } from "./snomed.js";
import { parseDrugName } from "./rxnorm.js";
import { buildCsIndex, completeness } from "./igCodeSystem.js";
import { handleTerminologyApi } from "./router.js";

/** Fake query runner: the first matcher whose substring occurs in the SQL answers. */
function fakeQ(matchers: [string, (params: unknown[]) => Row[]][]): Q & { calls: string[] } {
  const calls: string[] = [];
  const q = (async (sql: string, params: unknown[] = []) => {
    calls.push(sql);
    for (const [needle, fn] of matchers) if (sql.includes(needle)) return { rows: fn(params) };
    throw new Error(`unexpected SQL: ${sql.slice(0, 80)}`);
  }) as Q & { calls: string[] };
  q.calls = calls;
  return q;
}

const row = (code: string, is_header: boolean, name_en = code, name_zh: string | null = null): CodeRow => ({ code, is_header, name_en, name_zh });

const S93: CodeRow[] = [
  row("S93", true),
  row("S93.4", true),
  row("S93.40", true),
  row("S93.401", true, "Sprain of unspecified ligament of right ankle", "右側踝部韌帶扭傷"),
  row("S93.401A", false, "…, initial encounter", "右側踝部韌帶扭傷之初期照護"),
  row("S93.401D", false, "…, subsequent encounter"),
  row("S93.401S", false, "…, sequela"),
  row("S93.409", true),
  row("S93.409A", false),
];

const E11: CodeRow[] = [row("E11", true), row("E11.2", true), row("E11.21", false, "Type 2 DM with diabetic nephropathy"), row("E11.22", false), row("E11.9", false)];

test("parent map uses the longest existing prefix, trimming a trailing dot", () => {
  const p = buildParentMap(["E11", "E11.2", "E11.21", "E11.9", "T36.0X", "T36.0X1", "T36.0X1A", "T36"]);
  assert.equal(p.get("E11"), null);
  assert.equal(p.get("E11.2"), "E11");
  assert.equal(p.get("E11.21"), "E11.2");
  assert.equal(p.get("E11.9"), "E11");
  assert.equal(p.get("T36.0X1A"), "T36.0X1");
  assert.equal(p.get("T36.0X"), "T36");
});

test("category index counts billable descendants inclusively", () => {
  const idx = categoryIndex(S93);
  assert.equal(idx.billable.get("S93"), 4);
  assert.equal(idx.billable.get("S93.401"), 3);
  assert.equal(idx.billable.get("S93.401A"), 1);
  assert.deepEqual(
    idx.children.get("S93.40")?.map((r) => r.code),
    ["S93.401", "S93.409"],
  );
});

test("7th characters fold into chips with their meaning", () => {
  const defs = cmStructure().seventh;
  assert.ok(isSeventhExtension("S93.401A", "S93.401", defs));
  assert.ok(!isSeventhExtension("S93.401", "S93.40", defs));
  assert.ok(!isSeventhExtension("E11.21", "E11.2", defs));
  const idx = categoryIndex(S93);
  const n = codeNode(idx.byCode.get("S93.401")!, idx, defs);
  assert.equal(n.has_children, false);
  assert.deepEqual(
    n.seventh?.map((c) => [c.char, c.meaning]),
    [
      ["A", "initial encounter"],
      ["D", "subsequent encounter"],
      ["S", "sequela"],
    ],
  );
  assert.equal(n.seventh?.[0].title_zh, "右側踝部韌帶扭傷之初期照護");
  // A plain header keeps tree children.
  const h = codeNode(categoryIndex(E11).byCode.get("E11.2")!, categoryIndex(E11), defs);
  assert.equal(h.kind, "header");
  assert.equal(h.has_children, true);
  assert.equal(h.seventh, undefined);
});

test("normalizeCmCode accepts codes without the dot", () => {
  assert.equal(normalizeCmCode(" e1121 "), "E11.21");
  assert.equal(normalizeCmCode("S93.401A"), "S93.401A");
  assert.equal(normalizeCmCode("E11"), "E11");
});

function icdFake(rowsByCategory: Record<string, CodeRow[]>): ReturnType<typeof fakeQ> {
  const all = Object.values(rowsByCategory).flat();
  return fakeQ([
    ["FROM icd.editions", () => [{ v: "2026-10-16" }]],
    ["GROUP BY category", () => Object.entries(rowsByCategory).map(([category, rows]) => ({ category, b: rows.filter((r) => !r.is_header).length, n: rows.length }))],
    ["WHERE code = ANY", (p) => all.filter((r) => (p[0] as string[]).includes(r.code))],
    ["WHERE category = $1", (p) => rowsByCategory[p[0] as string] ?? []],
  ]);
}

test("cmChildren walks chapter → block → category → code", async () => {
  const q = icdFake({ E11: E11, S93: S93 });
  const roots = await cmChildren(q, "");
  assert.equal(roots.length, 22);
  const ch4 = roots.find((r) => r.id === "ch:4")!;
  assert.equal(ch4.title_zh, "內分泌、營養和代謝疾病");
  assert.equal(ch4.billable_count, 3);
  const blocks = await cmChildren(q, "ch:4");
  assert.ok(blocks.some((b) => b.id === "sec:E08-E13" && b.billable_count === 3));
  const cats = await cmChildren(q, "sec:E08-E13");
  assert.deepEqual(
    cats.map((c) => [c.code, c.has_children]),
    [["E11", true]],
  );
  const kids = await cmChildren(q, "E11");
  assert.deepEqual(
    kids.map((k) => [k.code, k.kind]),
    [
      ["E11.2", "header"],
      ["E11.9", "billable"],
    ],
  );
  await assert.rejects(cmChildren(q, "ch:99"), /Unknown chapter/);
});

test("cmPath reveals a folded 7th character on its stem", async () => {
  const q = icdFake({ S93: S93 });
  const p = await cmPath(q, "s93401a");
  assert.equal(p.code, "S93.401A");
  assert.equal(p.node_id, "S93.401");
  assert.deepEqual(p.path, ["ch:19", "sec:S90-S99", "S93", "S93.4", "S93.40", "S93.401"]);
  assert.ok(p.children["S93.40"].some((n) => n.code === "S93.401" && n.seventh?.length === 3));
  assert.deepEqual(p.detail.seventh, { char: "A", meaning: "initial encounter" });
  assert.equal(p.detail.chapter?.code, "19");
  await assert.rejects(cmPath(q, "S93.999Z"), /not found/);
});

test("WHO index nests blocks inside chapters and wider blocks", () => {
  const idx = buildWhoIndex([
    { code: "II", display: "Neoplasms" },
    { code: "C00-C97", display: "Malignant neoplasms" },
    { code: "C00-C75", display: "… specified sites" },
    { code: "C00-C14", display: "Lip, oral cavity and pharynx" },
    { code: "C00", display: "Malignant neoplasm of lip" },
    { code: "C00.0", display: "External upper lip" },
    { code: "D00-D09", display: "In situ neoplasms" },
    { code: "D00", display: "Carcinoma in situ of oral cavity" },
  ]);
  assert.equal(idx.parent.get("C00-C97"), "II");
  assert.equal(idx.parent.get("C00-C75"), "C00-C97");
  assert.equal(idx.parent.get("C00-C14"), "C00-C75");
  assert.equal(idx.parent.get("C00"), "C00-C14");
  assert.equal(idx.parent.get("C00.0"), "C00");
  assert.equal(idx.parent.get("D00"), "D00-D09");
  assert.deepEqual(idx.children.get("II"), ["C00-C97", "D00-D09"]);
  assert.equal(idx.leafCount.get("II"), 2);
});

test("PCS breakdown labels all 7 axes from the matching table row", () => {
  const t = pcsTables().tables;
  const b = pcsBreakdown("0DTJ4ZZ", t);
  assert.equal(b.valid, true);
  assert.deepEqual(
    b.axes.map((a) => a.label),
    ["Medical and Surgical", "Gastrointestinal System", "Resection", "Appendix", "Percutaneous Endoscopic", "No Device", "No Qualifier"],
  );
  assert.equal(b.axes[3].title, "Body Part");
  const bad = pcsBreakdown("0DTJ4Z9", t);
  assert.equal(bad.valid, false);
  assert.equal(bad.axes[3].label, "Appendix");
  assert.equal(pcsBreakdown("ZZZ0000", t).table_key, null);
});

test("PCS hierarchy groups tables and sums DB counts", () => {
  const h = pcsHierarchy(pcsTables().tables, new Map([["0DT", 40], ["0D5", 2]]));
  const med = h.find((s) => s.code === "0")!;
  assert.equal(med.label_zh, "內科及外科");
  const gi = med.systems.find((s) => s.code === "D")!;
  assert.equal(gi.db_count, 42);
  assert.ok(gi.ops.some((o) => o.key === "0DT" && o.label === "Resection"));
});

test("loincWhere leaves the excluded facet out and supports empty values", () => {
  const f = parseLoincFilters({ system: "Ser/Plas", scale: "Qn", method: "∅", bogus: "x" });
  const all = loincWhere(f);
  assert.match(all.sql, /system = \$1/);
  assert.match(all.sql, /scale_type = \$2/);
  assert.match(all.sql, /COALESCE\(method_type, ''\) = ''/);
  assert.deepEqual(all.params, ["Ser/Plas", "Qn"]);
  const noSystem = loincWhere(f, "system");
  assert.doesNotMatch(noSystem.sql, /system =/);
  assert.deepEqual(noSystem.params, ["Qn"]);
  assert.match(loincWhere({ q: "2345-7" }).sql, /loinc_num LIKE/);
  assert.match(loincWhere({ q: "glucose ser" }).sql, /to_tsquery\('simple', \$1\)/);
  assert.deepEqual(loincWhere({ q: "glucose ser" }).params, ["glucose:* & ser:*"]);
  assert.match(loincWhere({ q: "血糖" }).sql, /strpos/);
  assert.equal(loincWhere({}).sql, "");
});

test("axis bar and answer lists are shaped from link rows", () => {
  const axes = buildAxisBar(
    { component: "Glucose", property: "MCnc", time_aspect: "Pt", system: "Ser/Plas", scale_type: "Qn", method_type: "" },
    [
      { part_type: "COMPONENT", part_number: "LP14635-4", part_name: "Glucose" },
      { part_type: "SYSTEM", part_number: "LP7576-4", part_name: "Ser/Plas" },
    ],
  );
  assert.deepEqual(
    axes.map((a) => [a.axis, a.value, a.parts.map((p) => p.part_number).join()]),
    [
      ["component", "Glucose", "LP14635-4"],
      ["property", "MCnc", ""],
      ["time", "Pt", ""],
      ["system", "Ser/Plas", "LP7576-4"],
      ["scale", "Qn", ""],
      ["method", "", ""],
    ],
  );
  const lists = groupAnswerLists(
    [{ list_id: "LL2419-1", link_type: "PREFERRED", context: "" }],
    [
      { list_id: "LL2419-1", seq: 2, answer_code: "LA19709-7", display: "Group B" },
      { list_id: "LL2419-1", seq: 1, answer_code: "LA19710-5", display: "Group A" },
    ],
    new Map([["LL2419-1", "ABO group"]]),
  );
  assert.equal(lists[0].name, "ABO group");
  assert.deepEqual(
    (lists[0].answers as Row[]).map((a) => a.code),
    ["LA19710-5", "LA19709-7"],
  );
});

test("SNOMED terms: FSN, US-preferred term, semantic tag", () => {
  const t = pickTerms([
    { concept_id: "1", type_id: FSN, term: "Diabetes mellitus type 2 (disorder)", us_preferred: true },
    { concept_id: "1", type_id: SYNONYM, term: "Type II diabetes mellitus", us_preferred: false },
    { concept_id: "1", type_id: SYNONYM, term: "Type 2 diabetes mellitus", us_preferred: true },
    { concept_id: "2", type_id: FSN, term: "Gravid uterus structure (body structure)", us_preferred: false },
  ]);
  assert.equal(t.get("1")?.pt, "Type 2 diabetes mellitus");
  assert.equal(t.get("2")?.pt, "Gravid uterus structure");
  assert.equal(semanticTag(t.get("1")?.fsn), "disorder");
  assert.equal(semanticTag("no tag"), null);
});

test("SNOMED attributes drop IS-A; associations rank SAME AS before REPLACED BY", () => {
  const ref = (id: string, term: string) => ({ id, term, fsn: null, tag: null, active: true });
  const terms = new Map([
    ["363698007", ref("363698007", "Finding site")],
    ["113331007", ref("113331007", "Endocrine system structure")],
    ["35039007", ref("35039007", "Uterine structure")],
    ["9", ref("9", "Other")],
  ]);
  const attrs = shapeAttributes(
    [
      { type_id: "116680003", target_id: "73211009" },
      { type_id: "363698007", target_id: "113331007" },
    ],
    terms,
  );
  assert.deepEqual(
    attrs.map((a) => [a.type, a.target.term]),
    [["Finding site", "Endocrine system structure"]],
  );
  const assoc = shapeAssociations(
    [
      { refset_id: "900000000000526001", target_id: "35039007" },
      { refset_id: "900000000000527005", target_id: "9" },
    ],
    terms,
  );
  assert.deepEqual(
    assoc.map((a) => a.label),
    ["SAME AS", "REPLACED BY"],
  );
});

test("RxNorm drug names split into ingredients, strength, dose form, brand", () => {
  const sbd = parseDrugName("metformin hydrochloride 500 MG / sitagliptin 50 MG Extended Release Oral Tablet [Janumet]");
  assert.equal(sbd.brand, "Janumet");
  assert.equal(sbd.clinical, "metformin hydrochloride 500 MG / sitagliptin 50 MG Extended Release Oral Tablet");
  assert.deepEqual(sbd.ingredients, ["metformin hydrochloride", "sitagliptin"]);
  assert.deepEqual(sbd.components, ["metformin hydrochloride 500 MG", "sitagliptin 50 MG"]);
  assert.equal(sbd.doseForm, "Extended Release Oral Tablet");
  const sol = parseDrugName("metformin hydrochloride 100 MG/ML Oral Solution");
  assert.equal(sol.doseForm, "Oral Solution");
  assert.deepEqual(sol.components, ["metformin hydrochloride 100 MG/ML"]);
  assert.equal(parseDrugName("metformin").doseForm, null);
});

test("CodeSystem index follows concept.concept nesting", () => {
  const idx = buildCsIndex({
    concept: [
      {
        code: "active",
        display: "Active",
        concept: [
          { code: "recurrence", display: "Recurrence" },
          { code: "relapse", display: "Relapse", designation: [{ language: "zh-TW", value: "復發" }] },
        ],
      },
      { code: "inactive", concept: [{ code: "remission" }, { code: "resolved", property: [{ code: "status", valueCode: "active" }] }] },
      { code: "active" },
    ],
  });
  assert.equal(idx.total, 6);
  assert.equal(idx.depth, 2);
  assert.deepEqual(idx.children.get(""), ["active", "inactive"]);
  assert.equal(idx.nodes.get("active")?.child_count, 2);
  assert.equal(idx.nodes.get("active")?.descendant_count, 2);
  assert.equal(idx.parent.get("relapse"), "active");
  assert.equal(idx.nodes.get("relapse")?.designations[0].value, "復發");
  assert.deepEqual(idx.nodes.get("resolved")?.properties, [{ code: "status", value: "active" }]);
});

test("CodeSystem completeness flags truncated packages", () => {
  assert.equal(completeness("complete", 5, 5, 5, [{ version: "0.3.2", concept_count: 91737 }]).status, "truncated");
  assert.equal(completeness("complete", null, 3, 6, []).status, "complete");
  assert.equal(completeness("fragment", null, 3, 6, []).status, "fragment");
  assert.equal(completeness("complete", 100, 10, 10, []).status, "truncated");
  assert.equal(completeness(null, null, 1, 1, []).status, "unknown");
});

test("text helpers", () => {
  assert.equal(ftsPrefixQuery("Type 2 diab'"), "type:* & 2:* & diab:*");
  assert.equal(ftsPrefixQuery("糖尿病"), null);
  assert.ok(hasCjk("第二型糖尿病"));
  assert.ok(!hasCjk("E11.21"));
});

test("VersionedCache reloads when the version changes", async () => {
  const c = new VersionedCache<number>(60_000, 2);
  let loads = 0;
  const load = async () => ++loads;
  assert.equal(await c.get("k", "v1", load), 1);
  assert.equal(await c.get("k", "v1", load), 1);
  assert.equal(await c.get("k", "v2", load), 2);
});

test("router: unknown route 404, non-GET 405, bad input 400, never echoes params", async () => {
  const q = fakeQ([]);
  assert.equal((await handleTerminologyApi(q, "GET", "/admin/api/other", {})), null);
  assert.equal((await handleTerminologyApi(q, "GET", "/admin/api/terminology/nope", {}))?.status, 404);
  assert.equal((await handleTerminologyApi(q, "POST", "/admin/api/terminology/icd/cm/children", {}))?.status, 405);
  const bad = await handleTerminologyApi(q, "GET", "/admin/api/terminology/snomed/concept", { id: "abc; drop" });
  assert.equal(bad?.status, 400);
  assert.doesNotMatch(JSON.stringify(bad?.body), /drop/);
  const pcs = await handleTerminologyApi(q, "GET", "/admin/api/terminology/icd/pcs/code", { code: "0DTJ4Z" });
  assert.equal(pcs?.status, 400);
});
