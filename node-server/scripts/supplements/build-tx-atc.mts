/**
 * Build data/terminology/atc-tx-check.json.gz: which WHO ATC codes the reference terminology
 * server (tx.fhir.org, used by HL7 validator_cli) knows, restricted to the ATC codes the
 * installed / bundled data already carries — TW Core's ValueSet `medcation-atc-tw` and the
 * `atc` property of the bundled NHI medication supplement. No ATC names are written: per code
 * only "known" / "unknown", and for TW Core ValueSet codes whether the ValueSet's display is the
 * server's display (case-insensitive). WHO ATC itself is not held locally; this lets
 *   - the validator report ATC codes the server rejects (validator_cli parity:
 *     "Unknown code 'X' in the CodeSystem 'http://www.whocc.no/atc' version '<edition>'"), and
 *   - search / suggestions / repairs offer an ATC coding only when the validator accepts it.
 *
 * Input: the server's expansion of http://www.whocc.no/atc, one $expand per anatomical group
 * (the server refuses > 3000 codes per expansion):
 *   POST https://tx.fhir.org/r4/ValueSet/$expand  Parameters{valueSet: {compose.include:
 *     [{system: http://www.whocc.no/atc, filter: [{property: concept, op: is-a, value: <A|B|C…>}]}]}, count: 3000}
 * saved as <tx-dir>/g_<group>.json (A B C D G H J L M N P R S V).
 *
 * usage: npx tsx scripts/supplements/build-tx-atc.mts --tx-dir <dir> --twcore-tgz tw.gov.mohw.twcore-1.0.0.tgz \
 *          --supplement data/supplements/CodeSystem-nhi-medication-supplement.json.gz [--fetched YYYY-MM-DD] [--out data/terminology/atc-tx-check.json.gz]
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { byCodePoint, packageResource, parseArgs } from "./lib.mts";

const ATC = "http://www.whocc.no/atc";
const GROUPS = ["A", "B", "C", "D", "G", "H", "J", "L", "M", "N", "P", "R", "S", "V"];
const USAGE = "build-tx-atc.mts --tx-dir <dir> --twcore-tgz <tgz> --supplement <json.gz> [--fetched <YYYY-MM-DD>] [--out <file>]";

function main(): void {
  const a = parseArgs(process.argv.slice(2), ["tx-dir", "twcore-tgz", "supplement"], USAGE);
  // The server's codes (nested expansion flattened) and its edition.
  const server = new Map<string, string>();
  let edition: string | null = null;
  const walk = (list: any[] | undefined): void => {
    for (const c of list || []) {
      if (typeof c.code === "string") server.set(c.code, String(c.display ?? ""));
      walk(c.contains);
    }
  };
  for (const g of GROUPS) {
    const vs = JSON.parse(fs.readFileSync(path.join(a["tx-dir"], `g_${g}.json`), "utf8"));
    if (vs.resourceType !== "ValueSet" || !vs.expansion) throw new Error(`g_${g}.json is not an expansion`);
    for (const p of vs.expansion.parameter || []) {
      if (p.name === "used-codesystem" && typeof p.valueUri === "string" && p.valueUri.startsWith(`${ATC}|`)) edition = p.valueUri.split("|")[1];
    }
    walk(vs.expansion.contains);
  }
  if (!edition || server.size < 5000) throw new Error(`implausible expansion (${server.size} codes, edition ${edition})`);
  // The codes the shipped data carries.
  const vs = packageResource(a["twcore-tgz"], "ValueSet-medcation-atc-tw.json");
  const vsDisplay = new Map<string, string>();
  for (const inc of vs.compose?.include || []) {
    if (inc.system !== ATC) continue;
    for (const c of inc.concept || []) vsDisplay.set(String(c.code), String(c.display ?? ""));
  }
  const sup = JSON.parse(zlib.gunzipSync(fs.readFileSync(a.supplement)).toString("utf8"));
  const carried = new Set<string>(vsDisplay.keys());
  for (const c of sup.concept || []) {
    for (const p of c.property || []) if (p.code === "atc" && p.valueCoding?.system === ATC && p.valueCoding.code) carried.add(String(p.valueCoding.code));
  }
  const known: string[] = [];
  const unknown: string[] = [];
  const displayVerified: string[] = [];
  for (const code of [...carried].sort(byCodePoint)) {
    if (!server.has(code)) {
      unknown.push(code);
      continue;
    }
    known.push(code);
    const d = vsDisplay.get(code);
    if (d && d.toLowerCase() === server.get(code)!.toLowerCase()) displayVerified.push(code);
  }
  const out = {
    system: ATC,
    edition,
    source: "tx.fhir.org (r4) ValueSet/$expand of http://www.whocc.no/atc, one expansion per anatomical group",
    fetched: a.fetched || new Date().toISOString().slice(0, 10),
    scope: `ATC codes of TW Core ValueSet ${vs.url}|${vs.version ?? ""} and of the 'atc' property of ${sup.url}|${sup.version ?? ""}`,
    known,
    unknown,
    display_verified: displayVerified,
  };
  const file = a.out || path.join("data", "terminology", "atc-tx-check.json.gz");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(out), { level: 9 }));
  console.log(`${file}: edition ${edition}, ${known.length} known, ${unknown.length} unknown, ${displayVerified.length} ValueSet displays verified`);
}

main();
