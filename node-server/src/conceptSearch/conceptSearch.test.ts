import { test } from "node:test";
import assert from "node:assert/strict";
import { clinicalCore, cnToInt, groupKey, normalizeText, tokenize } from "./text.js";
import { buildEntries, mineLoincAcronyms, mineSnomedAcronyms, plausibleAbbreviation, Thesaurus } from "./thesaurus.js";
import { ConceptIndex, editDistance, fuse, nearCodes, prepareQuery } from "./engine.js";
import { assembleCodeSystem, conceptMapLinks, supplementApplies } from "./assemble.js";

test("normalizeText: NFKC, dashes, variants, Chinese numerals before measure words, units, comparators", () => {
  assert.equal(normalizeText("Ｃ反應性蛋白試驗－免疫比濁法"), "c反應性蛋白試驗-免疫比濁法");
  assert.equal(normalizeText("傷口長小於五公分者"), "傷口長小於5公分者");
  assert.equal(normalizeText("五至十公分"), "5至10公分");
  assert.equal(normalizeText("一般門診"), "一般門診"); // not a quantity
  assert.equal(normalizeText("傷口 < 5 cm"), "傷口 小於 5公分");
  assert.equal(normalizeText("轉氨基脢"), "轉氨基酶");
  assert.equal(cnToInt("三十六"), 36);
  assert.equal(cnToInt("十一"), 11);
  assert.equal(cnToInt("二百"), 200);
});

test("tokenize: CJK bigrams + weak unigrams, Latin stems, stop words, letter/digit split", () => {
  const t = tokenize(normalizeText("血液透析 of Platelets HbA1c"));
  const keys = t.map((x) => `${x.k}:${x.t}`);
  assert.ok(keys.includes("b:血液") && keys.includes("b:透析") && keys.includes("u:血"));
  assert.ok(keys.includes("w:platelet"));
  assert.ok(!keys.includes("w:of"));
  assert.ok(keys.includes("w:hba1c") && keys.includes("w:hba") && keys.includes("d:1"));
  assert.deepEqual(tokenize("鈉").map((x) => [x.k, x.w]), [["u", 1]]);
});

test("clinicalCore strips laterality, counts and suture specs but keeps sizes", () => {
  const n = normalizeText("清創縫合 4-0 Nylon 5 針（淺部創傷處理，傷口 < 5 cm） 右側 x1");
  const core = clinicalCore(n);
  assert.ok(!/nylon|4-0|5針|右側|x1/.test(core), core);
  assert.ok(core.includes("清創縫合") && core.includes("小於 5公分"), core);
});

test("groupKey cuts at the method / qualifier separator", () => {
  assert.equal(groupKey("Ｃ反應性蛋白試驗－免疫比濁法"), groupKey("Ｃ反應性蛋白試驗—乳膠凝集法"));
  assert.equal(groupKey("血液透析(一次)-住院"), "血液透析");
});

test("Schwartz–Hearst abbreviation check and acronym mining", () => {
  assert.ok(plausibleAbbreviation("PCI", "Percutaneous coronary intervention"));
  assert.ok(plausibleAbbreviation("TKA", "total knee arthroplasty"));
  assert.ok(!plausibleAbbreviation("PCI", "Hemodialysis"));
  const sn = mineSnomedAcronyms([
    "PCI - Percutaneous coronary intervention",
    "TKA (total knee arthroplasty) using impaction bone graft",
    "C-reactive protein (CRP)",
    "Hemodialysis",
    "Bad - Not an expansion",
  ]);
  assert.deepEqual(sn, [
    ["PCI", "Percutaneous coronary intervention"],
    ["TKA", "total knee arthroplasty"],
    ["CRP", "C-reactive protein"],
  ]);
  const lo = mineLoincAcronyms([{ shortname: "CRP SerPl-mCnc", component: "C reactive protein" }, { shortname: "Glucose SerPl", component: "Glucose" }]);
  assert.deepEqual(lo, [["CRP", "C reactive protein"]]);
  const e = buildEntries([["CRP", "C reactive protein"], ["CRP", "C reactive protein"], ["CRP", "canalith repositioning procedure"]], "x");
  assert.equal(e[0].expansion, "C reactive protein");
  assert.equal(e[0].freq, 2);
});

function paymentIndex(): ConceptIndex {
  return new ConceptIndex([
    { code: "58001C", display: "血液透析(一次)-住院", terms: [{ text: "血液透析(一次)-住院", lang: "zh", kind: "display" }, { text: "Hemodialysis", lang: "en", kind: "designation" }] },
    { code: "12015C", display: "Ｃ反應性蛋白試驗－免疫比濁法", terms: [{ text: "Ｃ反應性蛋白試驗－免疫比濁法", lang: "zh", kind: "display" }, { text: "C.R.P (C-reactive protein) - Nephelometry", lang: "en", kind: "designation" }] },
    { code: "12013C", display: "Ｃ反應性蛋白試驗—乳膠凝集法", terms: [{ text: "Ｃ反應性蛋白試驗—乳膠凝集法", lang: "zh", kind: "display" }] },
    { code: "09020C", display: "鐵", terms: [{ text: "鐵", lang: "zh", kind: "display" }, { text: "Fe (Iron-bound)", lang: "en", kind: "designation" }] },
    { code: "08042C", display: "骨髓鐵染色", terms: [{ text: "骨髓鐵染色", lang: "zh", kind: "display" }] },
    { code: "48001C", display: "淺部創傷處理－傷口長小於五公分者", terms: [{ text: "淺部創傷處理－傷口長小於五公分者", lang: "zh", kind: "display" }] },
    { code: "48002C", display: "淺部創傷處理－傷口長五至十公分者", terms: [{ text: "淺部創傷處理－傷口長五至十公分者", lang: "zh", kind: "display" }] },
    { code: "64164B", display: "全膝關節置換術", terms: [{ text: "全膝關節置換術", lang: "zh", kind: "display" }, { text: "Total knee replacement", lang: "en", kind: "designation" }] },
    { code: "14034C", display: "Ｂ型肝炎ｅ抗原檢查", terms: [{ text: "Ｂ型肝炎ｅ抗原檢查", lang: "zh", kind: "display" }, { text: "HBeAg", lang: "en", kind: "designation" }] },
  ]);
}

const th = new Thesaurus([
  { abbr: "crp", expansion: "C reactive protein", source: "loinc", freq: 15 },
  { abbr: "tka", expansion: "total knee arthroplasty", source: "snomed", freq: 11 },
  { abbr: "hd", expansion: "Hemodialysis", source: "snomed", freq: 1 },
]);

function top(index: ConceptIndex, q: string, n = 3): string[] {
  return index.search(prepareQuery(q, th), 10).slice(0, n).map((h) => index.conceptAt(h.concept).code);
}

test("official name typed verbatim ranks first (exact beats partial)", () => {
  const ix = paymentIndex();
  assert.equal(top(ix, "鐵")[0], "09020C");
  assert.equal(top(ix, "全膝關節置換術")[0], "64164B");
  assert.equal(top(ix, "Ｃ反應性蛋白試驗－免疫比濁法")[0], "12015C");
});

test("English designations, abbreviations and clinical noise", () => {
  const ix = paymentIndex();
  assert.equal(top(ix, "Emergent hemodialysis")[0], "58001C");
  assert.ok(top(ix, "CRP").slice(0, 2).includes("12015C"));
  assert.equal(top(ix, "清創縫合 4-0 Nylon 5 針（淺部創傷處理，傷口 < 5 cm）")[0], "48001C");
  assert.equal(top(ix, "全膝關節置換術 右側")[0], "64164B");
});

test("short Latin abbreviations match whole tokens only", () => {
  const ix = paymentIndex();
  // "hb" must not hit "HBeAg" by substring.
  assert.ok(!top(ix, "Hb").includes("14034C"));
});

test("fuse: semantic-only hits are ranked, exact lexical stays on top", () => {
  const ix = paymentIndex();
  const lex = ix.search(prepareQuery("鐵", th), 10);
  const ranked = fuse(ix, lex, [
    { code: "08042C", sim: 0.8, term: "骨髓鐵染色", lang: "zh" },
    { code: "64164B", sim: 0.3, term: "x", lang: "zh" },
  ], 5);
  assert.equal(ranked[0].code, "09020C");
  const semOnly = fuse(ix, [], [{ code: "64164B", sim: 0.88, term: "Total knee replacement", lang: "en" }, { code: "58001C", sim: 0.74, term: "Hemodialysis", lang: "en" }], 5);
  assert.equal(semOnly[0].code, "64164B");
  assert.equal(semOnly[0].source, "semantic");
});

test("siblings share the group key", () => {
  const ix = paymentIndex();
  const ci = ix.indexOf("12015C")!;
  assert.deepEqual(ix.siblings(ci).map((i) => ix.conceptAt(i).code), ["12013C"]);
});

test("nearCodes / editDistance", () => {
  assert.equal(editDistance("09005C", "09005", 2), 1);
  assert.deepEqual(nearCodes(["09005C", "09006C", "58001C"], "09005"), ["09005C", "09006C"]);
});

test("assembleCodeSystem: nested concepts, designations, supplements, properties, links, category", () => {
  const cs = {
    resourceType: "CodeSystem",
    url: "http://x/CodeSystem/pay",
    version: "1",
    content: "complete",
    property: [{ code: "category", type: "string" }, { code: "status", type: "code" }],
    concept: [
      {
        code: "A",
        display: "檢驗",
        concept: [{ code: "A1", display: "鈉", designation: [{ language: "en", value: "Na (Sodium)" }], property: [{ code: "status", valueCode: "active" }] }],
      },
    ],
  };
  const sup = {
    resourceType: "CodeSystem",
    url: "http://x/sup",
    content: "supplement",
    supplements: "http://x/CodeSystem/pay",
    language: "en",
    property: [{ code: "loinc", type: "Coding" }, { code: "ingredient", type: "string" }],
    concept: [{ code: "A1", display: "Sodium, serum", property: [{ code: "loinc", valueCoding: { system: "http://loinc.org", code: "2951-2" } }, { code: "ingredient", valueString: "NA ION" }] }],
  };
  assert.ok(supplementApplies("http://x/CodeSystem/pay|1", "http://x/CodeSystem/pay", "1"));
  assert.ok(!supplementApplies("http://x/CodeSystem/pay|2", "http://x/CodeSystem/pay", "1"));
  const out = assembleCodeSystem(cs, [{ url: sup.url, version: null, resource: sup }]);
  const a1 = out.find((c) => c.code === "A1")!;
  assert.deepEqual(
    a1.terms.map((t) => [t.kind, t.text, t.lang]),
    [
      ["display", "鈉", "zh"],
      ["designation", "Na (Sodium)", "en"],
      ["designation", "Sodium, serum", "en"],
      ["property", "NA ION", "en"],
    ],
  );
  assert.deepEqual(a1.links, [{ system: "http://loinc.org", code: "2951-2", display: null, via: "loinc" }]);
  assert.equal(a1.info.category, "檢驗");
  const links = conceptMapLinks([{ url: "cm", group: [{ source: "http://x/CodeSystem/pay", target: "http://snomed.info/sct", element: [{ code: "A1", target: [{ code: "123", display: "Sodium measurement", equivalence: "equivalent" }] }] }] }], "http://x/CodeSystem/pay");
  assert.equal(links.get("A1")![0].display, "Sodium measurement");
});

test("checkSupplement validates FHIR R4 CodeSystem supplements", async () => {
  const { checkSupplement } = await import("../admin/igSupplements.js");
  assert.equal(checkSupplement({ resourceType: "ValueSet" }).ok, false);
  assert.equal(checkSupplement({ resourceType: "CodeSystem", content: "complete", url: "u" }).ok, false);
  assert.equal(checkSupplement({ resourceType: "CodeSystem", content: "supplement", url: "u", supplements: "u" }).ok, false);
  const ok = checkSupplement({ resourceType: "CodeSystem", content: "supplement", url: "u", version: "1", supplements: "http://x|2", concept: [{ code: "A", concept: [{ code: "B" }] }] });
  assert.equal(ok.ok, true);
  assert.equal(ok.conceptCount, 2);
});

test("search_medical_codes system routing: ICD-10 names vs IG CodeSystems", async () => {
  const { icdSystemType } = await import("../mcp.js");
  assert.equal(icdSystemType("icd10cm"), "diagnosis");
  assert.equal(icdSystemType("ICD-10-CM"), "diagnosis");
  assert.equal(icdSystemType("http://hl7.org/fhir/sid/icd-10-cm"), "diagnosis");
  assert.equal(icdSystemType("icd10pcs"), "procedure");
  assert.equal(icdSystemType("nhi_payment"), null);
});

test("inline acronyms, bilingual mining, clause split, prefix truncations", async () => {
  const { mineInlineAcronyms, mineBilingual } = await import("./thesaurus.js");
  const { querySegments } = await import("./engine.js");
  assert.deepEqual(mineInlineAcronyms(["Extracorporeal shock wave lithotripsy (ESWL) for urolithiasis", "TIBC(Total Iron Binding Capacity)"]), [
    ["ESWL", "Extracorporeal shock wave lithotripsy"],
    ["TIBC", "Total Iron Binding Capacity"],
  ]);
  const pairs: Array<[string, string]> = [];
  const sites: Array<[string, string]> = [["乳房", "breast"], ["膝部", "knee"], ["肩部", "shoulder"], ["頸部", "neck"], ["腹部", "abdomen"], ["背部", "back"]];
  const kinds: Array<[string, string]> = [["腫塊", "lump"], ["疼痛", "pain"], ["囊腫", "cyst"], ["挫傷", "contusion"], ["感染", "infection"], ["腫脹", "swelling"]];
  for (const [sz, se] of sites) for (const [kz, ke] of kinds) pairs.push([`${sz}${kz}`, `${ke} of ${se}`]);
  const bi = new Map(mineBilingual(pairs, { minCount: 3 }).map(([w, g]) => [w, g]));
  assert.equal(bi.get("breast")?.includes("乳房"), true);
  assert.equal(bi.get("knee")?.includes("膝"), true);
  assert.deepEqual(querySegments(normalizeText("PLT f/u (on heparin, r/o HIT)")).length > 1, true);
  assert.deepEqual(querySegments(normalizeText("C/S at 39w")), ["c/s", "39w"]);
  const ix = new ConceptIndex([
    { code: "A", display: "Abdominal ultrasound", terms: [{ text: "Abdominal ultrasound", lang: "en", kind: "display" }] },
    { code: "B", display: "Breast ultrasound", terms: [{ text: "Breast ultrasound", lang: "en", kind: "display" }] },
  ]);
  assert.equal(ix.conceptAt(ix.search(prepareQuery("abd ultrasound", null), 5)[0].concept).code, "A");
});

test("UMLS match-only terms and query synonyms never surface as matched_term", () => {
  const ix = new ConceptIndex([
    {
      code: "18005C",
      display: "超音波心臟圖(包括單面、雙面)",
      terms: [
        { text: "超音波心臟圖(包括單面、雙面)", lang: "zh", kind: "display" },
        { text: "TTE", lang: "en", kind: "umls" },
        { text: "Transthoracic echocardiography", lang: "en", kind: "umls" },
      ],
    },
    { code: "19001C", display: "腹部超音波", terms: [{ text: "腹部超音波", lang: "zh", kind: "display" }] },
  ]);
  const lex = ix.search(prepareQuery("TTE", null), 5);
  const ranked = fuse(ix, lex, null, 5);
  assert.equal(ranked[0].code, "18005C");
  assert.equal(ranked[0].exact, false); // a UMLS string is never an exact match
  assert.equal(ranked[0].matchedTerm, "超音波心臟圖(包括單面、雙面)");
  const viaSynonym = prepareQuery("cardiac echo", null, { synonyms: [{ phrase: "cardiac echo", alternatives: ["Transthoracic echocardiography"] }] });
  assert.ok(viaSynonym.some((v) => v.label === "synonym"));
  const r2 = fuse(ix, ix.search(viaSynonym, 5), null, 5);
  assert.equal(r2[0].code, "18005C");
  assert.notEqual(r2[0].matchedTerm, "Transthoracic echocardiography");
});
