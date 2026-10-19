/**
 * Shared helpers of the bundled-data generators (scripts/supplements/*.mts). Node only,
 * no third-party dependencies beyond what node-server already has. Inputs are public files
 * downloaded unmodified (see node-server/data/README.md); treat them as untrusted data.
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { readTgz } from "../../src/loaders/ig.ts";

export const NS = "https://tw-health-mcp.healthymind-tech.com/fhir/CodeSystem";
export const TWCORE_PAYMENT = "https://twcore.mohw.gov.tw/ig/twcore/CodeSystem/medical-service-payment-tw";
export const TWCORE_MEDICATION = "https://twcore.mohw.gov.tw/ig/twcore/CodeSystem/medication-nhi-tw";
export const USE_DISPLAY = { system: "http://terminology.hl7.org/CodeSystem/designation-usage", code: "display" };
export const USE_SYNONYM = { system: "http://snomed.info/sct", code: "900000000000013009", display: "Synonym" };

/** `--key value` arguments (a bare `--flag` is "true"). */
export function parseArgs(argv: string[], required: string[], usage: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[a.slice(2)] = "true";
    else {
      out[a.slice(2)] = next;
      i += 1;
    }
  }
  const missing = required.filter((k) => !out[k]);
  if (missing.length) {
    process.stderr.write(`missing --${missing.join(", --")}\nusage: ${usage}\n`);
    process.exit(2);
  }
  return out;
}

/** RFC 4180 CSV (quoted fields, "" escapes, newlines inside quotes); strips a UTF-8 BOM. */
export function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  const [header, ...data] = rows.filter((r) => !(r.length === 1 && r[0] === ""));
  return data.map((r) => Object.fromEntries(header.map((h, j) => [h, r[j] ?? ""])));
}

export function readCsv(file: string): Array<Record<string, string>> {
  return parseCsv(fs.readFileSync(file, "utf8"));
}

/** Python's `" ".join(s.split())`: collapse whitespace runs, trim. */
export function collapse(s: string | undefined | null): string {
  return String(s ?? "")
    .split(/[\s\u001c-\u001f\u0085]+/)
    .filter(Boolean)
    .join(" ");
}

/** Round half to even (Python's round()). */
export function roundHalfEven(x: number): number {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/** One JSON resource out of a FHIR npm package (.tgz), by file name ("CodeSystem-x.json"). */
export function packageResource(tgz: string, fileName: string): Record<string, any> {
  const e = readTgz(tgz).find((x) => x.name.split("/").pop() === fileName);
  if (!e) throw new Error(`${fileName} not found in ${tgz}`);
  return JSON.parse(Buffer.from(e.data).toString("utf8").replace(/^﻿/, ""));
}

/** code → display of a CodeSystem resource (nested concepts flattened). */
export function codeMap(cs: Record<string, any>): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (list: any[] | undefined): void => {
    for (const c of list || []) {
      out.set(String(c.code), String(c.display ?? ""));
      walk(c.concept);
    }
  };
  walk(cs.concept);
  return out;
}

/** Code-point order (Python's sorted() on str). */
export function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Write a resource as minified gzip JSON (the bundled form) and, with `pretty`, a readable .json too. */
export function writeResource(outDir: string, res: Record<string, any>, pretty = false): string {
  fs.mkdirSync(outDir, { recursive: true });
  const base = path.join(outDir, `CodeSystem-${res.id}.json`);
  fs.writeFileSync(`${base}.gz`, zlib.gzipSync(JSON.stringify(res), { level: 9 }));
  if (pretty) fs.writeFileSync(base, JSON.stringify(res, null, 1));
  return `${base}.gz`;
}
