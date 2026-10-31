/**
 * Build data/terminology/loinc-tx-display.json.gz: the displays the reference terminology server
 * (tx.fhir.org, used by HL7 validator_cli) accepts for LOINC codes whose names changed after the
 * locally held release (ISSUES_v17.5: LOINC 2.81+ renamed e.g. 30954-2 'Relevant diagnostic
 * tests/laboratory data Narrative' → '… note'; validator_cli reports the old name as Wrong Display
 * Name while a 2.80 table accepts it). Only codes whose English display set differs from the local
 * release (long common name, short name) are written; until a newer LOINC is imported, the validator
 * and the display repair use these (src/txCodeTables.ts).
 *
 * Inputs:
 *   --local <tsv>   loinc_num, long_common_name, shortname of the candidate codes (the LOINC codes the
 *                   installed IGs reference, the Nar / Doc scale codes, the common tests / orders);
 *   --tx-dir <dir>  the server's expansions of those codes, 1,000 per request:
 *                   POST https://tx.fhir.org/r4/ValueSet/$expand Parameters{valueSet: {compose.include:
 *                     [{system: http://loinc.org, concept: [...]}]}, includeDesignations: true, count: 1000}
 *                   saved as <tx-dir>/c_<nnn>.json.
 *
 * usage: npx tsx scripts/supplements/build-tx-loinc.mts --local local.tsv --tx-dir tx [--fetched YYYY-MM-DD] [--out data/terminology/loinc-tx-display.json.gz]
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { byCodePoint, parseArgs } from "./lib.mts";

const LOINC = "http://loinc.org";
const USAGE = "build-tx-loinc.mts --local <tsv> --tx-dir <dir> [--fetched <YYYY-MM-DD>] [--out <file>]";

function main(): void {
  const a = parseArgs(process.argv.slice(2), ["local", "tx-dir"], USAGE);
  const local = new Map<string, string[]>();
  for (const line of fs.readFileSync(a.local, "utf8").split("\n")) {
    const [code, lcn, sn] = line.split("\t");
    if (code) local.set(code, [lcn, sn].filter((x): x is string => !!x && !!x.trim()));
  }
  let edition: string | null = null;
  const server = new Map<string, string[]>();
  for (const f of fs.readdirSync(a["tx-dir"]).filter((x) => /^c_\d+\.json$/u.test(x)).sort()) {
    const vs = JSON.parse(fs.readFileSync(path.join(a["tx-dir"], f), "utf8"));
    if (vs.resourceType !== "ValueSet" || !vs.expansion) throw new Error(`${f} is not an expansion`);
    for (const p of vs.expansion.parameter || []) if (p.name === "used-codesystem" && String(p.valueUri).startsWith(`${LOINC}|`)) edition = String(p.valueUri).split("|")[1];
    for (const c of vs.expansion.contains || []) {
      if (c.system !== LOINC || typeof c.code !== "string") continue;
      const en: string[] = [];
      if (typeof c.display === "string" && c.display) en.push(c.display);
      for (const d of c.designation || []) if (typeof d.value === "string" && /^en\b/iu.test(String(d.language ?? "en")) && !en.includes(d.value)) en.push(d.value);
      server.set(c.code, en);
    }
  }
  if (!edition || server.size < local.size * 0.9) throw new Error(`implausible expansion (${server.size} of ${local.size} codes, edition ${edition})`);
  const codes: Record<string, string[]> = {};
  const norm = (xs: string[]): string => [...new Set(xs.map((x) => x.trim().toLowerCase()))].sort().join("\u0000");
  for (const [code, mine] of [...local].sort((x, y) => byCodePoint(x[0], y[0]))) {
    const theirs = server.get(code);
    if (theirs && theirs.length && norm(theirs) !== norm(mine)) codes[code] = theirs;
  }
  const out = {
    source: "tx.fhir.org ValueSet/$expand (includeDesignations), English display + designations",
    system: LOINC,
    edition,
    fetched: a.fetched ?? new Date().toISOString().slice(0, 10),
    compared_with_local: local.size,
    note: "codes whose English displays at the reference server differ from the locally held release (long common name, short name)",
    codes,
  };
  const file = a.out ?? path.join("data", "terminology", "loinc-tx-display.json.gz");
  fs.writeFileSync(file, zlib.gzipSync(Buffer.from(JSON.stringify(out))));
  console.log(`${file}: edition ${edition}, ${Object.keys(codes).length} of ${local.size} codes differ`);
}

main();
