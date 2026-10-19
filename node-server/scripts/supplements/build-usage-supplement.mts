/**
 * Build nhi-payment-usage-supplement: annual NHI claim volume of the TW Core
 * `medical-service-payment-tw` codes, from the NHI open dataset 「診療項目醫令申報量(年)」
 * (data.gov.tw 175960, resource A21030000I-D20022-002). Per code the most recent fee year
 * (費用年) with data; volume rounded half-to-even to an integer. Used by concept search as a
 * usage prior among near-identical sibling codes.
 *
 * usage: npx tsx scripts/supplements/build-usage-supplement.mts \
 *   --volume-csv vol.csv --twcore-tgz tw.gov.mohw.twcore-1.0.0.tgz [--date YYYY-MM-DD] [--out-dir data/supplements] [--pretty]
 */

import { byCodePoint, codeMap, NS, packageResource, parseArgs, readCsv, roundHalfEven, TWCORE_PAYMENT, writeResource } from "./lib.mts";

const USAGE = "build-usage-supplement.mts --volume-csv <csv> --twcore-tgz <tgz> [--date <YYYY-MM-DD>] [--out-dir <dir>] [--pretty]";

function main(): void {
  const a = parseArgs(process.argv.slice(2), ["volume-csv", "twcore-tgz"], USAGE);
  const known = codeMap(packageResource(a["twcore-tgz"], "CodeSystem-medical-service-payment-tw.json"));
  const best = new Map<string, [number, number]>();
  const years = new Set<number>();
  for (const r of readCsv(a["volume-csv"])) {
    const v = String(r["申報量（次）"] ?? "").trim();
    const c = String(r["診療項目代碼"] ?? "").trim();
    if (!c || v === "" || v === "-") continue;
    const y = Number.parseInt(r["費用年"], 10);
    if (!Number.isFinite(y)) throw new Error(`bad 費用年 for ${c}: ${r["費用年"]}`);
    years.add(y);
    const prev = best.get(c);
    if (!prev || y > prev[0]) best.set(c, [y, Number(v)]);
  }
  const latest = Math.max(...years);
  const concepts: Array<Record<string, unknown>> = [];
  for (const c of [...best.keys()].sort(byCodePoint)) {
    if (!known.has(c)) continue;
    const [y, v] = best.get(c)!;
    concepts.push({ code: c, property: [{ code: "claim-volume", valueInteger: roundHalfEven(v) }, { code: "claim-year", valueInteger: y }] });
  }
  const url = `${NS}/nhi-payment-usage-supplement`;
  const res = {
    resourceType: "CodeSystem",
    id: "nhi-payment-usage-supplement",
    url,
    version: String(latest),
    name: "NHIPaymentUsageSupplement",
    title: "Annual NHI claim volume of TW NHI medical service payment codes (supplement)",
    status: "active",
    experimental: false,
    date: a.date || new Date().toISOString().slice(0, 10),
    publisher: "Taiwan Health MCP (derived data)",
    description:
      "Supplement adding 'claim-volume' (annual number of claims, 申報量 次) and 'claim-year' (費用年) to NHI " +
      "medical service payment codes, from the NHI open dataset 診療項目醫令申報量(年) " +
      "(https://data.gov.tw/dataset/175960, resource 診療項目醫令申報量(105年至114年)). Per code the most recent " +
      "year with data. Used by concept search as a usage prior: among near-identical sibling codes (same item, " +
      "different method / setting), the commonly billed one ranks first.",
    copyright:
      "Source: 衛生福利部中央健康保險署 (National Health Insurance Administration, Taiwan), " +
      "政府資料開放授權條款-第1版 (Open Government Data License, version 1.0, https://data.gov.tw/license).",
    caseSensitive: true,
    content: "supplement",
    supplements: TWCORE_PAYMENT,
    count: concepts.length,
    property: [
      { code: "claim-volume", uri: `${url}#claim-volume`, description: "Annual NHI claim volume (申報量, number of claims) in claim-year", type: "integer" },
      { code: "claim-year", uri: `${url}#claim-year`, description: "Fee year (費用年) of that figure", type: "integer" },
    ],
    concept: concepts,
  };
  console.log(writeResource(a["out-dir"] || "data/supplements", res, a.pretty === "true"));
  console.log(`${concepts.length} concepts (of ${known.size} codes), latest year ${latest}`);
}

main();
