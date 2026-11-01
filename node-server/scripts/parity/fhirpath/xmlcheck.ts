/**
 * Self-check of the FHIR XML → JSON converter: the R4 examples that exist in both
 * formats must convert to the official JSON (narrative div excluded).
 *   node --import tsx scripts/parity/fhirpath/xmlcheck.ts
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { FhirXmlConverter, parseXml } from "./xml.js";

const CACHE = process.env.FHIR_PACKAGE_CACHE || join(homedir(), ".fhir", "packages");
const R = process.env.FHIR_TEST_CASES ? join(process.env.FHIR_TEST_CASES, "r4") : join(homedir(), "ref/fhir-test-cases/r4");
const conv = new FhirXmlConverter(join(CACHE, "hl7.fhir.r4.core#4.0.1", "package"));

function diff(a: any, b: any, p: string, out: string[]): void {
  if (typeof a !== typeof b || Array.isArray(a) !== Array.isArray(b)) {
    out.push(`${p}: ${JSON.stringify(a)?.slice(0, 80)} vs ${JSON.stringify(b)?.slice(0, 80)}`);
    return;
  }
  if (a && typeof a === "object") {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (k !== "div") diff(a[k], b[k], `${p}.${k}`, out);
    return;
  }
  if (a !== b) out.push(`${p}: ${a} vs ${b}`);
}

let bad = 0;
for (const n of ["patient-example", "observation-example", "questionnaire-example", "codesystem-example"]) {
  const x = conv.convertResource(parseXml(readFileSync(join(R, `${n}.xml`), "utf8")));
  const j = JSON.parse(readFileSync(join(R, "examples", `${n}.json`), "utf8"));
  const out: string[] = [];
  diff(x, j, n, out);
  bad += out.length;
  console.log(n, out.length, out.slice(0, 15));
}
process.exit(bad ? 1 : 0);
