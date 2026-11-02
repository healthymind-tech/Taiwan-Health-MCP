/**
 * Build data/terminology/tx-codesystems.json.gz: the CodeSystem URIs the reference terminology server (tx.fhir.org, used by
 * HL7 validator_cli) declares in its TerminologyCapabilities. A public list of URIs: no codes, no names, no licensed content.
 *
 * validator_cli decides with this very list whether a system not held in its context goes to the server
 * (ValueSetValidator.preferServerSide → TerminologyClientManager.supportsSystem, standalone tag 7.0.1:1135-1148): a listed
 * system is checked there, an unlisted one ends in the UNKNOWN_CODESYSTEM warning. src/txCodeTables.ts reads it, so that
 * `checked_fully` can tell "the validator checks this, we cannot" from "the validator cannot check it either".
 *
 * Input: curl -sS -H 'Accept: application/fhir+json' 'https://tx.fhir.org/r4/metadata?mode=terminology' -o tc.json
 *
 * usage: npx tsx scripts/supplements/build-tx-systems.mts --capabilities <tc.json> [--fetched YYYY-MM-DD] [--out data/terminology/tx-codesystems.json.gz]
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import zlib from "node:zlib";
import { byCodePoint, parseArgs } from "./lib.mts";

const USAGE = "build-tx-systems.mts --capabilities <tc.json> [--fetched <YYYY-MM-DD>] [--out <file>]";
const CONTENT_EXT = "extension-TerminologyCapabilities.codeSystem.content";

function main(): void {
  const a = parseArgs(process.argv.slice(2), ["capabilities"], USAGE);
  const text = fs.readFileSync(a.capabilities, "utf8");
  const tc = JSON.parse(text);
  if (tc.resourceType !== "TerminologyCapabilities" || !Array.isArray(tc.codeSystem)) throw new Error("not a TerminologyCapabilities resource");
  const systems = new Set<string>();
  const notComplete: Record<string, string> = {};
  for (const c of tc.codeSystem) {
    if (typeof c.uri !== "string" || !c.uri) continue;
    systems.add(c.uri);
    const content = (c.extension || []).find((x: any) => String(x.url).endsWith(CONTENT_EXT))?.valueCode;
    if (typeof content === "string" && content !== "complete") notComplete[c.uri] = content;
  }
  if (systems.size < 500) throw new Error(`implausible capabilities (${systems.size} code systems)`);
  const list = [...systems].sort(byCodePoint);
  const out = {
    source: "tx.fhir.org/r4/metadata?mode=terminology",
    fetched: a.fetched ?? String(tc.date ?? "").slice(0, 10),
    server_version: tc.version ?? null,
    systems: list,
    not_complete: Object.fromEntries(Object.entries(notComplete).sort(([x], [y]) => byCodePoint(x, y))),
  };
  const file = a.out ?? "data/terminology/tx-codesystems.json.gz";
  fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(out), { level: 9 }));
  const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
  console.log(JSON.stringify({ file, systems: list.length, not_complete: Object.keys(notComplete).length, fetched: out.fetched, server_version: out.server_version, uri_list_sha256: sha(list.join("\n")), input_sha256: sha(text) }));
}

main();
