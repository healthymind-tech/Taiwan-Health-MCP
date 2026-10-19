/**
 * Build nhi-medication-supplement for TW Core `medication-nhi-tw` (NHI drug codes) from the
 * NHI open dataset 「健保用藥品項查詢項目檔」 (data.gov.tw 23715, resource
 * A21030000I-E41001-001). The code list is the TW Core CodeSystem of the given package —
 * TW Core 0.3.2 carries the full list (44,709 codes); 1.0.0 ships only an example subset.
 *
 * Per code, the row with the latest 有效起日 gives:
 *   designation zh-TW / use=display  ← 藥品中文名稱
 *   designation en / use=synonym     ← 藥品英文名稱, only when it differs (case/space-insensitive) from the TW Core display
 *   property ingredient (string)     ← 成分
 *   property atc (Coding, WHO ATC)   ← ATC代碼 (malformed codes skipped)
 *
 * usage: npx tsx scripts/supplements/build-medication-supplement.mts \
 *   --drug-csv drug.csv --csv-date 2026-09-28 --twcore-tgz tw.gov.mohw.twcore-0.3.2.tgz [--out-dir data/supplements] [--pretty]
 */

import { byCodePoint, codeMap, collapse, NS, packageResource, parseArgs, readCsv, TWCORE_MEDICATION, USE_DISPLAY, USE_SYNONYM, writeResource } from "./lib.mts";

const ATC = "http://www.whocc.no/atc";
const ATC_RE = /^[A-Z]\d{2}[A-Z]{0,2}\d{0,2}$/;
const USAGE = "build-medication-supplement.mts --drug-csv <csv> --csv-date <YYYY-MM-DD> --twcore-tgz <tgz> [--out-dir <dir>] [--pretty]";

const key = (s: string): string => String(s ?? "").replace(/[\s\u001c-\u001f\u0085]+/g, "").toUpperCase();
const roc = (s: string): number => {
  const t = String(s ?? "").trim();
  return /^\d+$/.test(t) ? Number(t) : 0;
};

function main(): void {
  const a = parseArgs(process.argv.slice(2), ["drug-csv", "csv-date", "twcore-tgz"], USAGE);
  const base = codeMap(packageResource(a["twcore-tgz"], "CodeSystem-medication-nhi-tw.json"));
  const latest = new Map<string, Record<string, string>>();
  for (const r of readCsv(a["drug-csv"])) {
    const c = r["藥品代號"].trim();
    if (!base.has(c)) continue;
    const prev = latest.get(c);
    if (!prev || roc(r["有效起日"]) > roc(prev["有效起日"])) latest.set(c, r);
  }
  const st = { base_codes: base.size, codes_in_nhi_file: latest.size, zh: 0, en_synonym: 0, ingredient: 0, atc: 0, atc_invalid_skipped: 0 };
  const concepts: Array<Record<string, unknown>> = [];
  for (const c of [...latest.keys()].sort(byCodePoint)) {
    const r = latest.get(c)!;
    const des: unknown[] = [];
    const props: unknown[] = [];
    const zh = collapse(r["藥品中文名稱"]);
    if (zh) {
      des.push({ language: "zh-TW", use: USE_DISPLAY, value: zh });
      st.zh += 1;
    }
    const en = collapse(r["藥品英文名稱"]);
    if (en && key(en) !== key(base.get(c)!)) {
      des.push({ language: "en", use: USE_SYNONYM, value: en });
      st.en_synonym += 1;
    }
    const ing = collapse(r["成分"]);
    if (ing) {
      props.push({ code: "ingredient", valueString: ing });
      st.ingredient += 1;
    }
    const atc = String(r["ATC代碼"] ?? "").trim();
    if (atc) {
      if (ATC_RE.test(atc)) {
        props.push({ code: "atc", valueCoding: { system: ATC, code: atc } });
        st.atc += 1;
      } else st.atc_invalid_skipped += 1;
    }
    if (des.length || props.length) {
      const item: Record<string, unknown> = { code: c };
      if (des.length) item.designation = des;
      if (props.length) item.property = props;
      concepts.push(item);
    }
  }
  const d = a["csv-date"];
  const res = {
    resourceType: "CodeSystem",
    id: "nhi-medication-supplement",
    url: `${NS}/nhi-medication-supplement`,
    version: d,
    name: "NHIMedicationSupplement",
    title: "Chinese names, current English names, ingredients and ATC for TW NHI drug codes (supplement)",
    status: "active",
    experimental: false,
    date: d,
    publisher: "Taiwan Health MCP (derived data)",
    description:
      "Supplement for TW Core medication-nhi-tw built from the NHI Administration open dataset " +
      "「健保用藥品項查詢項目檔」 (data.gov.tw dataset 23715, resource A21030000I-E41001-001, file date " +
      `${d}). Per code the row with the latest 有效起日 is used: 藥品中文名稱 -> zh-TW display ` +
      "designation; 藥品英文名稱 -> en synonym only when it differs from the TW Core display; 成分 -> " +
      "'ingredient' property; ATC代碼 -> 'atc' property. Values copied verbatim (whitespace collapsed).",
    copyright:
      "Source: 衛生福利部中央健康保險署 (National Health Insurance Administration, Taiwan), " +
      `「健保用藥品項查詢項目檔」, ${d.slice(0, 4)}, licensed under the Open Government Data ` +
      "License, version 1.0 (政府資料開放授權條款－第1版), https://data.gov.tw/license.",
    caseSensitive: true,
    content: "supplement",
    supplements: TWCORE_MEDICATION,
    count: concepts.length,
    property: [
      { code: "ingredient", uri: `${NS}/nhi-medication-supplement#ingredient`, description: "Ingredient(s) and strength as published by NHI (成分)", type: "string" },
      { code: "atc", uri: `${NS}/nhi-medication-supplement#atc`, description: "WHO ATC code as published by NHI (ATC代碼)", type: "Coding" },
    ],
    concept: concepts,
  };
  console.log(writeResource(a["out-dir"] || "data/supplements", res, a.pretty === "true"));
  console.log(JSON.stringify({ ...st, supplement_concepts: concepts.length }));
}

main();
