/**
 * Structural validation of CodeSystem supplements against the FHIR R4 supplement rules and the
 * code list of the supplemented CodeSystem (from a FHIR package .tgz). Exit 1 on any error.
 *
 * usage: npx tsx scripts/supplements/validate-supplements.mts --twcore-tgz <tgz> <CodeSystem-x.json[.gz]> ...
 *   (the base CodeSystem is the package's CodeSystem whose url equals the supplement's `supplements`)
 */

import fs from "node:fs";
import zlib from "node:zlib";
import { readTgz } from "../../src/loaders/ig.ts";
import { codeMap } from "./lib.mts";

const ALLOWED_TOP = new Set(["resourceType", "id", "url", "version", "name", "title", "status", "experimental", "date", "publisher",
  "description", "copyright", "caseSensitive", "content", "supplements", "count", "property", "concept", "language"]);
const TYPE_KEY: Record<string, string> = { code: "valueCode", Coding: "valueCoding", string: "valueString", integer: "valueInteger",
  boolean: "valueBoolean", dateTime: "valueDateTime", decimal: "valueDecimal" };

function main(): number {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--twcore-tgz");
  if (i < 0 || !argv[i + 1]) {
    console.error("usage: validate-supplements.mts --twcore-tgz <tgz> <supplement.json[.gz]> ...");
    return 2;
  }
  const tgz = argv[i + 1];
  const files = argv.filter((_, j) => j !== i && j !== i + 1);
  const codeSystems = readTgz(tgz)
    .filter((e) => /\/CodeSystem-[^/]+\.json$/.test(e.name))
    .map((e) => JSON.parse(Buffer.from(e.data).toString("utf8")));
  let failed = 0;
  for (const f of files) {
    const raw = fs.readFileSync(f);
    const cs = JSON.parse((f.endsWith(".gz") ? zlib.gunzipSync(raw) : raw).toString("utf8"));
    const err: string[] = [];
    if (cs.resourceType !== "CodeSystem") err.push("resourceType");
    if (cs.content !== "supplement") err.push("content must be supplement");
    if (!cs.supplements) err.push("supplements missing");
    const extraTop = Object.keys(cs).filter((k) => !ALLOWED_TOP.has(k));
    if (extraTop.length) err.push(`unexpected top-level keys ${extraTop}`);
    if (!/^[A-Za-z0-9\-.]{1,64}$/.test(cs.id ?? "")) err.push("bad id");
    if (!/^[A-Z][A-Za-z0-9_]{0,254}$/.test(cs.name ?? "")) err.push("bad name (cnl-0)");
    const baseCs = codeSystems.find((c) => c.url === String(cs.supplements).split("|")[0]);
    if (!baseCs) err.push(`supplemented CodeSystem ${cs.supplements} not in ${tgz}`);
    const base = baseCs ? codeMap(baseCs) : new Map<string, string>();
    const props = new Map<string, string>((cs.property || []).map((p: any) => [p.code, p.type]));
    const seen = new Set<string>();
    let des = 0;
    let pv = 0;
    for (const c of cs.concept || []) {
      if (seen.has(c.code)) err.push(`duplicate ${c.code}`);
      seen.add(c.code);
      if (baseCs && !base.has(c.code)) err.push(`code not in base: ${c.code}`);
      const extra = Object.keys(c).filter((k) => !["code", "designation", "property"].includes(k));
      if (extra.length) err.push(`${c.code}: supplement concept may only carry designation/property, has ${extra}`);
      for (const d of c.designation || []) {
        des += 1;
        if (!d.value || d.value !== d.value.trim()) err.push(`${c.code}: empty/untrimmed designation`);
      }
      for (const p of c.property || []) {
        pv += 1;
        const t = props.get(p.code);
        if (!t) err.push(`${c.code}: undeclared property ${p.code}`);
        else if (!(TYPE_KEY[t] in p)) err.push(`${c.code}: property ${p.code} wrong value[x]`);
      }
    }
    if (cs.count !== (cs.concept || []).length) err.push("count mismatch");
    const covered = [...seen].filter((c) => base.has(c)).length;
    console.log(JSON.stringify({
      file: f.split("/").pop(), concepts: (cs.concept || []).length, base_codes: base.size,
      coverage_pct: base.size ? Math.round((10000 * covered) / base.size) / 100 : 0, designations: des, property_values: pv,
      errors: err.length, first_errors: err.slice(0, 10),
    }));
    if (err.length) failed += 1;
  }
  return failed ? 1 : 0;
}

process.exit(main());
