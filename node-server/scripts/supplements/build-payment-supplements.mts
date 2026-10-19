/**
 * Build the two supplements of TW Core `medical-service-payment-tw` (NHI payment codes):
 *
 *   nhi-payment-en-supplement     English item names (英文項目名稱) from the NHI open dataset
 *                                 「醫療服務給付項目及支付標準(csv檔)」 (data.gov.tw 174450,
 *                                 resource A21030000I-D20021-001)
 *   nhi-payment-loinc-supplement  'loinc' Coding properties copied from the TWPAS IG ConceptMap
 *                                 nhi-loinc (tw.gov.mohw.nhi.pas), displays = LOINC Long Common
 *                                 Names (optional: needs the LOINC release, free licence)
 *
 * usage: npx tsx scripts/supplements/build-payment-supplements.mts \
 *   --payment-csv payment.csv --csv-date 2026-10-18 \
 *   --twcore-tgz tw.gov.mohw.twcore-1.0.0.tgz --pas-tgz tw.gov.mohw.nhi.pas-1.2.7.tgz \
 *   [--loinc-zip Loinc_2.80.zip | --loinc-csv LoincTable/Loinc.csv] [--out-dir data/supplements] [--pretty]
 */

import fs from "node:fs";
import { Readable } from "node:stream";
import { fileSource, zipEntries, zipEntryStream } from "../../src/loaders/umls.ts";
import { byCodePoint, codeMap, collapse, NS, packageResource, parseArgs, parseCsv, readCsv, TWCORE_PAYMENT, USE_DISPLAY, writeResource } from "./lib.mts";

const LOINC = "http://loinc.org";
const USAGE =
  "build-payment-supplements.mts --payment-csv <csv> --csv-date <YYYY-MM-DD> --twcore-tgz <tgz> --pas-tgz <tgz> [--loinc-zip <zip> | --loinc-csv <csv>] [--out-dir <dir>] [--pretty]";

async function streamText(r: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of r) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** LOINC_NUM → LONG_COMMON_NAME from Loinc.csv (or the release zip holding it). */
async function loincNames(a: Record<string, string>): Promise<Map<string, string> | null> {
  let text: string | null = null;
  if (a["loinc-csv"]) text = fs.readFileSync(a["loinc-csv"], "utf8");
  else if (a["loinc-zip"]) {
    const src = fileSource(a["loinc-zip"]);
    const entry = (await zipEntries(src)).find((e) => /(^|\/)LoincTable\/Loinc\.csv$/i.test(e.name));
    if (!entry) throw new Error("LoincTable/Loinc.csv not found in the LOINC zip");
    text = await streamText(await zipEntryStream(src, entry));
  }
  if (text === null) return null;
  const out = new Map<string, string>();
  for (const r of parseCsv(text)) if (r.LOINC_NUM) out.set(r.LOINC_NUM, r.LONG_COMMON_NAME ?? "");
  return out;
}

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2), ["payment-csv", "csv-date", "twcore-tgz", "pas-tgz"], USAGE);
  const outDir = a["out-dir"] || "data/supplements";
  const base = codeMap(packageResource(a["twcore-tgz"], "CodeSystem-medical-service-payment-tw.json"));

  const byCode = new Map<string, Record<string, string>>();
  const rows = readCsv(a["payment-csv"]);
  for (const r of rows) {
    const code = r["診療項目代碼"].trim();
    if (byCode.has(code)) throw new Error(`duplicate code ${code} in the payment CSV`);
    byCode.set(code, r);
  }

  // English names: codes of the TW Core CodeSystem with a non-empty 英文項目名稱, verbatim.
  const enConcepts: Array<Record<string, unknown>> = [];
  for (const code of [...base.keys()].sort(byCodePoint)) {
    const en = collapse(byCode.get(code)?.["英文項目名稱"]);
    if (!en) continue;
    enConcepts.push({ code, designation: [{ language: "en", use: USE_DISPLAY, value: en }] });
  }
  const d = a["csv-date"];
  const en = {
    resourceType: "CodeSystem",
    id: "nhi-payment-en-supplement",
    url: `${NS}/nhi-payment-en-supplement`,
    version: d,
    name: "NHIPaymentEnglishSupplement",
    title: "English designations for TW NHI medical service payment codes (supplement)",
    status: "active",
    experimental: false,
    date: d,
    publisher: "Taiwan Health MCP (derived data)",
    description:
      "Supplement adding the official English item names (英文項目名稱) published by the " +
      "National Health Insurance Administration (衛生福利部中央健康保險署) in the open dataset " +
      "「醫療服務給付項目及支付標準(csv檔)」 (data.gov.tw dataset 174450, resource " +
      `A21030000I-D20021-001, file date ${d}). Only codes present in the TW Core ` +
      "CodeSystem and carrying a non-empty English name are included; names are copied verbatim " +
      "(whitespace collapsed). No names were authored by hand.",
    copyright:
      "Source: 衛生福利部中央健康保險署 (National Health Insurance Administration, Taiwan), " +
      `「醫療服務給付項目及支付標準(csv檔)」, ${d.slice(0, 4)}, licensed under the ` +
      "Open Government Data License, version 1.0 (政府資料開放授權條款－第1版), " +
      "https://data.gov.tw/license. Code system: TW Core IG medical-service-payment-tw.",
    caseSensitive: true,
    content: "supplement",
    supplements: TWCORE_PAYMENT,
    count: enConcepts.length,
    concept: enConcepts,
  };

  // LOINC links from the NHI ConceptMap (all 'relatedto': candidate links, not equivalences).
  const cm = packageResource(a["pas-tgz"], "ConceptMap-nhi-loinc.json");
  const links = new Map<string, string[]>();
  for (const g of cm.group || []) {
    if (g.source !== TWCORE_PAYMENT || g.target !== LOINC) throw new Error(`unexpected ConceptMap group ${g.source} → ${g.target}`);
    for (const e of g.element || []) {
      for (const t of e.target || []) {
        const list = links.get(e.code) || [];
        if (!list.includes(t.code)) list.push(t.code);
        links.set(e.code, list);
      }
    }
  }
  const names = await loincNames(a);
  const loincConcepts: Array<Record<string, unknown>> = [];
  for (const code of [...links.keys()].sort(byCodePoint)) {
    if (!base.has(code)) continue;
    loincConcepts.push({
      code,
      property: links.get(code)!.map((n) => {
        const vc: Record<string, string> = { system: LOINC, code: n };
        const lcn = names?.get(n);
        if (lcn) vc.display = lcn;
        return { code: "loinc", valueCoding: vc };
      }),
    });
  }
  const tv = cm.group?.[0]?.targetVersion;
  const loinc = {
    resourceType: "CodeSystem",
    id: "nhi-payment-loinc-supplement",
    url: `${NS}/nhi-payment-loinc-supplement`,
    version: cm.date || cm.version,
    name: "NHIPaymentLoincSupplement",
    title: "LOINC links for TW NHI medical service payment lab codes (supplement)",
    status: "active",
    experimental: false,
    date: cm.date,
    publisher: "Taiwan Health MCP (derived data)",
    description:
      `Supplement adding a 'loinc' concept property to NHI payment lab codes, copied from the NHI ConceptMap ${cm.url} ` +
      `(TWPAS IG tw.gov.mohw.nhi.pas ${cm.version}, date ${cm.date}, target LOINC ${tv}). ` +
      "All source mappings have equivalence 'relatedto' (one payment code -> many LOINC codes " +
      "varying by specimen/method/scale); they are candidate links, not equivalences. " +
      "LOINC displays are LOINC Long Common Names from LOINC 2.80.",
    copyright:
      "Mappings: 衛生福利部中央健康保險署 (NHI Administration, Taiwan), TWPAS IG, package license CC0-1.0. " +
      "This material contains content from LOINC (http://loinc.org). LOINC is copyright (c) Regenstrief " +
      "Institute, Inc. and the LOINC Committee and is available at no cost under the license at " +
      "http://loinc.org/license. LOINC(R) is a registered United States trademark of Regenstrief Institute, Inc.",
    caseSensitive: true,
    content: "supplement",
    supplements: TWCORE_PAYMENT,
    count: loincConcepts.length,
    property: [
      {
        code: "loinc",
        uri: `${NS}/nhi-payment-loinc-supplement#loinc`,
        description: "Related LOINC code (from NHI ConceptMap nhi-loinc, equivalence relatedto)",
        type: "Coding",
      },
    ],
    concept: loincConcepts,
  };

  const pretty = a.pretty === "true";
  console.log(writeResource(outDir, en, pretty), `${enConcepts.length} concepts (of ${base.size} codes; ${rows.length} CSV rows)`);
  console.log(
    writeResource(outDir, loinc, pretty),
    `${loincConcepts.length} concepts` + (names ? "" : " (no LOINC file given: codings carry no display)"),
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
