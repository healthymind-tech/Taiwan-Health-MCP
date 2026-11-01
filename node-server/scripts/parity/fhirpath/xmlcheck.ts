/**
 * Self-check of the FHIR XML reader (src/fhirXml.ts): every R4 example of fhir-test-cases r4/ that exists in both
 * formats (r4/<name>.xml + r4/examples/<name>.json) must convert to the official JSON — narrative div compared after
 * whitespace normalisation — with no parse issues.
 *   node --import tsx scripts/parity/fhirpath/xmlcheck.ts
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseFhirXml } from "../../../src/fhirXml.js";
import { FileValidatorResolver, ResourceStore } from "../lib/fileResolver.js";
import { findPackage } from "../lib/packages.js";

const R = process.env.FHIR_TEST_CASES ? join(process.env.FHIR_TEST_CASES, "r4") : join(homedir(), "ref/fhir-test-cases/r4");
const core = findPackage("hl7.fhir.r4.core#4.0.1");
if (!core) {
  console.error("hl7.fhir.r4.core#4.0.1 not in the package caches");
  process.exit(2);
}
const store = new ResourceStore();
store.addPackage(core);
const resolver = new FileValidatorResolver(store);

const normDiv = (s: string): string => s.replace(/\s+/g, " ").replace(/> </g, "><").trim();

function diff(a: any, b: any, p: string, out: string[]): void {
  if (typeof a === "string" && typeof b === "string" && p.endsWith(".div")) {
    if (normDiv(a) !== normDiv(b)) out.push(`${p}: div differs\n    ${normDiv(a).slice(0, 200)}\n    ${normDiv(b).slice(0, 200)}`);
    return;
  }
  if (typeof a !== typeof b || Array.isArray(a) !== Array.isArray(b)) {
    out.push(`${p}: ${JSON.stringify(a)?.slice(0, 80)} vs ${JSON.stringify(b)?.slice(0, 80)}`);
    return;
  }
  if (a && typeof a === "object") {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (k !== "fhir_comments") diff(a[k], b[k], `${p}.${k}`, out);
    return;
  }
  if (a !== b) out.push(`${p}: ${a} vs ${b}`);
}

let bad = 0;
let n = 0;
for (const f of readdirSync(R).filter((x) => x.endsWith(".xml")).sort()) {
  const name = f.slice(0, -4);
  const jf = join(R, "examples", `${name}.json`);
  if (!existsSync(jf)) continue;
  n++;
  const x = await parseFhirXml(readFileSync(join(R, f), "utf8"), resolver);
  const out: string[] = x.issues.map((i) => `issue ${i.severity} ${i.path}: ${i.message}`);
  diff(x.resource, JSON.parse(readFileSync(jf, "utf8")), name, out);
  bad += out.length;
  console.log(name, out.length, out.slice(0, 10));
}
console.log(`${n} XML/JSON pairs, ${bad} differences`);
if (process.argv.includes("--validator")) {
  // informational: validator test inputs that exist in both formats (some are R5 or deliberately different variants)
  const V = join(R, "..", "validator");
  for (const f of readdirSync(V).filter((x) => x.endsWith(".xml")).sort()) {
    const jf = join(V, `${f.slice(0, -4)}.json`);
    if (!existsSync(jf)) continue;
    let j: any;
    try {
      j = JSON.parse(readFileSync(jf, "utf8"));
    } catch {
      continue;
    }
    const x = await parseFhirXml(readFileSync(join(V, f), "utf8"), resolver);
    const out: string[] = x.issues.map((i) => `issue ${i.severity} ${i.path}: ${i.message}`);
    diff(x.resource, j, f, out);
    console.log(`[validator] ${f}`, out.length, out.slice(0, 8));
  }
}
process.exit(bad ? 1 : 0);
