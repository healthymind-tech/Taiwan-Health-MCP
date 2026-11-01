/**
 * Builds data/terminology/bcp47-subtags.tsv.gz — the IANA Language Subtag Registry (BCP 47) in the compact form
 * fhirBcp47.ts reads: one line per subtag / tag, `type \t subtag \t prefixes (space separated) \t first description`,
 * ranges (qaa..qtz, Qaaa..Qabx, QM..QZ, XA..XZ) expanded.
 *
 * Source: the registry copy the HL7 validator ships (org.hl7.fhir.utilities src/main/resources/lang.dat.txt, the
 * IANA file https://www.iana.org/assignments/language-subtag-registry), or the IANA file itself.
 *
 *   node --import tsx scripts/supplements/build-bcp47.mts <language-subtag-registry> [out.tsv.gz]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const [src, out = "data/terminology/bcp47-subtags.tsv.gz"] = process.argv.slice(2);
if (!src) {
  console.error("usage: build-bcp47.mts <language-subtag-registry> [out.tsv.gz]");
  process.exit(2);
}

/** a..c over one alphabet position per character (case preserved), inclusive. */
function expandRange(from: string, to: string): string[] {
  const outv: string[] = [];
  const cur = [...from];
  for (let guard = 0; guard < 100000; guard++) {
    const s = cur.join("");
    outv.push(s);
    if (s === to) break;
    for (let i = cur.length - 1; i >= 0; i--) {
      const c = cur[i];
      const upper = c >= "A" && c <= "Z";
      const last = upper ? "Z" : "z";
      if (c !== last) {
        cur[i] = String.fromCharCode(c.charCodeAt(0) + 1);
        break;
      }
      cur[i] = upper ? "A" : "a";
    }
  }
  return outv;
}

const lines: string[] = [];
for (const rec of readFileSync(src, "utf8").split(/^%%\s*$/m)) {
  const fields: Array<[string, string]> = [];
  for (const raw of rec.split(/\r?\n/)) {
    if (/^\s/.test(raw) && fields.length) fields[fields.length - 1][1] += ` ${raw.trim()}`;
    else {
      const k = raw.indexOf(":");
      if (k > 0) fields.push([raw.slice(0, k).trim(), raw.slice(k + 1).trim()]);
    }
  }
  const get = (k: string): string[] => fields.filter(([f]) => f === k).map(([, v]) => v);
  const type = get("Type")[0];
  const tag = get("Subtag")[0] ?? get("Tag")[0];
  if (!type || !tag) continue;
  const prefixes = get("Prefix").join(" ");
  const desc = (get("Description")[0] ?? "").replace(/\t/g, " ");
  const tags = tag.includes("..") ? expandRange(tag.split("..")[0], tag.split("..")[1]) : [tag];
  for (const t of tags) lines.push(`${type}\t${t}\t${prefixes}\t${desc}`);
}
writeFileSync(out, gzipSync(Buffer.from(lines.join("\n") + "\n", "utf8"), { level: 9 }));
console.log(`${lines.length} entries → ${out}`);
