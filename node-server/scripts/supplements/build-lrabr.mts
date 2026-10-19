/**
 * Build the bundled abbreviation lexicon (data/abbreviations/lrabr-<release>.tsv.gz) from the
 * SPECIALIST Lexicon's LRABR table (NLM Lexical Systems Group; LEX/LRABR of a lexicon
 * release or of a full UMLS release). Rows are filtered and de-duplicated exactly as the UMLS
 * loader keeps them (conceptSearch/abbreviations.ts parseLrabrLine / lrabrRows), so the
 * bundled copy and an LRABR-carrying UMLS upload yield the same fhir.abbreviation_lexicon.
 *
 * Output: header "#LRABR<TAB><release>", then "abbr<TAB>kind<TAB>expansion" lines.
 *
 * usage: npx tsx scripts/supplements/build-lrabr.mts --lrabr LEX/LRABR --release 2024AA [--out-dir data/abbreviations]
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { lrabrFile } from "../../src/loaders/umls.ts";
import { parseArgs } from "./lib.mts";

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2), ["lrabr", "release"], "build-lrabr.mts --lrabr <LRABR> --release <label> [--out-dir <dir>]");
  if (!/^[\w.-]+$/.test(a.release)) throw new Error("--release must be a plain label (letters, digits, . _ -)");
  const seen = new Set<string>();
  const lines = [`#LRABR\t${a.release}`];
  for await (const r of lrabrFile(a.lrabr)) {
    const k = `${r.key}\u0000${r.abbr}\u0000${r.expansion}`;
    if (seen.has(k)) continue;
    seen.add(k);
    lines.push(`${r.abbr}\t${r.kind}\t${r.expansion}`);
  }
  const outDir = a["out-dir"] || "data/abbreviations";
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `lrabr-${a.release}.tsv.gz`);
  fs.writeFileSync(out, zlib.gzipSync(lines.join("\n") + "\n", { level: 9 }));
  console.log(out, `${lines.length - 1} rows`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
