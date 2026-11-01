/**
 * FHIRPath parity (parity v3): runs the official R4 FHIRPath test suite
 * (fhir-test-cases r4/fhirpath/tests-fhir-r4.xml) through the engine our validator
 * uses for invariants — `evaluateExpression` in src/fhirPath.ts, the same
 * compile cache / R4 model / user functions / %resource variables as
 * `evaluateConstraint`.
 *
 *   node --import tsx scripts/parity/fhirpath/run.ts [--json out.json] [-v] [--group <name>] [--test <name>]
 *
 * Env: FHIR_TEST_CASES (default ~/ref/fhir-test-cases), FHIR_PACKAGE_CACHE (default ~/.fhir/packages; the
 * hl7.fhir.r4.core#4.0.1 StructureDefinitions drive the XML → JSON conversion of the XML-only inputs).
 *
 * Comparison follows the HL7 Java test runner (FHIRPathTests): invalid="…" expects an exception (syntax at
 * parse, semantic / execution at run — fhirpath.js has no separate static check phase, so a semantic error is
 * only seen when evaluation throws); predicate="true" converts the result with convertToBoolean; otherwise the
 * result count, each item's type (when the test names one) and its primitive string value must match, in order
 * unless ordered="false". Quantities compare as "<value> '<unit>'". Dates / times compare without the literal's
 * '@' / 'T' markers.
 *
 * Outcome per test: pass | fail | error (unexpected exception) | skip (group mode="custom": HL7 Java-only
 * document functions, not part of FHIRPath / FHIR — never used by invariants) | na (invalid="semantic" and the
 * engine evaluated it: a static-check-only failure; the validator never runs the static check on invariants).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { evaluateExpression, fhirPathBase, resultTypes, type FhirPathEnv } from "../../../src/fhirPath.js";
import { FhirXmlConverter, parseXml, type XmlEl } from "./xml.js";

const require = createRequire(import.meta.url);
const fpUtil: any = require("fhirpath/src/utilities");
const fpTypes: any = require("fhirpath/src/types");
const r4Model: any = require("fhirpath/fhir-context/r4");

type Json = Record<string, any>;
const args = process.argv.slice(2);
const opt = (n: string): string | null => (args.includes(n) ? args[args.indexOf(n) + 1] : null);
const verbose = args.includes("-v");
const onlyGroup = opt("--group");
const onlyTest = opt("--test");
const jsonOut = opt("--json");

const TC = process.env.FHIR_TEST_CASES || join(homedir(), "ref", "fhir-test-cases");
const CACHE = process.env.FHIR_PACKAGE_CACHE || join(homedir(), ".fhir", "packages");
const R4 = join(TC, "r4");
const conv = new FhirXmlConverter(join(CACHE, "hl7.fhir.r4.core#4.0.1", "package"));

const inputs = new Map<string, string>();
function loadInput(name: string): Json {
  if (!inputs.has(name)) {
    const src = readFileSync(join(R4, name), "utf8");
    const res = name.endsWith(".xml") ? conv.convertResource(parseXml(src)) : JSON.parse(src);
    inputs.set(name, JSON.stringify(res));
  }
  return JSON.parse(inputs.get(name)!); // fresh copy per test (fhirpath.js annotates its input)
}

/** Simple offline reference resolution (contained + Bundle entries), like the validator's resolver. */
function resolverFor(root: Json): FhirPathEnv["resolveReference"] {
  return (ref: string, from: Json): Json | null => {
    if (ref.startsWith("#")) return (from.contained ?? []).find((c: Json) => c.id === ref.slice(1)) ?? null;
    if (root.resourceType === "Bundle") {
      for (const e of root.entry ?? []) {
        if (e.fullUrl === ref) return e.resource ?? null;
        const r = e.resource;
        if (r && `${r.resourceType}/${r.id}` === ref) return r;
        if (r && e.fullUrl && e.fullUrl.endsWith(`/${ref}`)) return r;
      }
    }
    return null;
  };
}

const SYSTEM_TYPE: Record<string, string> = {
  String: "string", Integer: "integer", Decimal: "decimal", Boolean: "boolean", Date: "date",
  DateTime: "dateTime", Time: "time", Quantity: "Quantity", Long: "integer64",
};
function fhirTypeName(t: string): string {
  const [ns, name] = t.includes(".") ? [t.slice(0, t.indexOf(".")), t.slice(t.indexOf(".") + 1)] : ["", t];
  return ns === "System" ? (SYSTEM_TYPE[name] ?? name) : name;
}

function stringValue(item: any): string {
  const v = fpUtil.valData(item);
  if (v instanceof fpTypes.FP_Quantity) return `${v.value} ${v.unit}`;
  if (v instanceof fpTypes.FP_Type) return String(v.toString());
  if (v && typeof v === "object") {
    if (typeof v.value === "number" && ("unit" in v || "code" in v)) return `${v.value} '${v.code ?? v.unit}'`;
    return JSON.stringify(v);
  }
  return String(v);
}

function normExpected(type: string | null, s: string): string {
  let v = s.trim();
  if (type === "date" || type === "dateTime" || type === "time" || v.startsWith("@")) v = v.replace(/^@/, "");
  if (type === "time") v = v.replace(/^T/, "");
  return v;
}
function normFound(type: string, s: string): string {
  let v = s;
  if (type === "date" || type === "dateTime" || type === "time") v = v.replace(/^@/, "");
  if (type === "time") v = v.replace(/^T/, "");
  return v;
}

/** HL7 FHIRPathEngine.convertToBoolean. */
function convertToBoolean(items: any[]): boolean {
  if (items.length === 1) {
    const v = fpUtil.valData(items[0]);
    if (typeof v === "boolean") return v;
  }
  return items.length > 0;
}

interface Row { group: string; name: string; outcome: "pass" | "fail" | "error" | "skip" | "na"; why?: string; expr: string }
const rows: Row[] = [];

const suite = parseXml(readFileSync(join(R4, "fhirpath", "tests-fhir-r4.xml"), "utf8"));
for (const g of suite.children.filter((c) => c.name === "group")) {
  const group = g.attrs.name;
  if (onlyGroup && group !== onlyGroup) continue;
  for (const t of g.children.filter((c) => c.name === "test")) {
    const name = t.attrs.name ?? `${group}#${g.children.indexOf(t)}`;
    if (onlyTest && name !== onlyTest) continue;
    const exprEl = t.children.find((c) => c.name === "expression")!;
    const expr = exprEl.text;
    const row: Row = { group, name, expr, outcome: "pass" };
    rows.push(row);
    if (g.attrs.mode === "custom") {
      row.outcome = "skip";
      row.why = "mode=custom (HL7 Java document functions)";
      continue;
    }
    const invalid = exprEl.attrs.invalid ?? null;
    const outputs = t.children.filter((c) => c.name === "output");
    try {
      const resource = t.attrs.inputfile ? loadInput(t.attrs.inputfile) : null;
      const env: FhirPathEnv = resource
        ? { resource, rootResource: resource, resolveReference: resolverFor(resource) }
        : { resource: {}, rootResource: {} };
      const base = resource?.resourceType ?? "";
      let result: any[];
      if (t.attrs.context && resource) {
        // evaluate the expression on each item of the context, the way an invariant is evaluated on an element
        result = [];
        const ctxNodes = evaluateExpression(resource, base, t.attrs.context, env, {}, { internal: true });
        const ctxTypes = resultTypes(ctxNodes);
        ctxNodes.forEach((n: any, k: number) => {
          const tn = fhirTypeName(ctxTypes[k]);
          const choice = (r4Model.choiceTypePaths as Record<string, string[]>)[t.attrs.context];
          const nodeBase = fhirPathBase(choice ? `${t.attrs.context}[x]` : t.attrs.context, tn);
          result.push(...evaluateExpression(fpUtil.valData(n), nodeBase, expr, env, {}, { internal: true }));
        });
      } else result = evaluateExpression(resource ?? {}, base, expr, env, {}, { internal: true });
      if (invalid === "semantic") {
        // a static type-check failure (FHIRPathEngine.check): InstanceValidator.checkInvariant only parses and
        // evaluates (fpe.parse + evaluateToBoolean), so for invariant evaluation running it is the Java behaviour
        row.outcome = "na";
        row.why = "semantic check only (not run by checkInvariant)";
        continue;
      }
      if (invalid) {
        row.outcome = "fail";
        row.why = `expected ${invalid} error, got ${result.length} item(s)`;
        continue;
      }
      if (t.attrs.predicate === "true") result = [convertToBoolean(result)];
      check(row, t, result, outputs);
    } catch (e) {
      if (invalid) continue; // expected an error
      row.outcome = "error";
      row.why = (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 200);
    }
  }
}

function check(row: Row, t: XmlEl, result: any[], outputs: XmlEl[]): void {
  if (result.length !== outputs.length) {
    row.outcome = "fail";
    row.why = `count ${result.length} != ${outputs.length}: [${result.slice(0, 5).map(stringValue).join(", ")}]`;
    return;
  }
  let types: string[];
  try {
    types = resultTypes(result).map(fhirTypeName);
  } catch {
    types = result.map(() => "?");
  }
  const found = result.map((r, i) => ({ type: types[i], value: normFound(types[i], stringValue(r)) }));
  const wanted = outputs.map((o) => ({ type: o.attrs.type ?? null, value: normExpected(o.attrs.type ?? null, o.text) }));
  const same = (f: { type: string; value: string }, w: { type: string | null; value: string }): string | null => {
    if (w.type && f.type !== w.type) return `type ${f.type} != ${w.type} (value ${f.value})`;
    if (f.value !== w.value) return `value ${f.value} != ${w.value}`;
    return null;
  };
  if (t.attrs.ordered === "false") {
    const left = [...found];
    for (const w of wanted) {
      const k = left.findIndex((f) => same(f, w) === null);
      if (k < 0) {
        row.outcome = "fail";
        row.why = `missing ${w.value}`;
        return;
      }
      left.splice(k, 1);
    }
    return;
  }
  for (let i = 0; i < wanted.length; i++) {
    const d = same(found[i], wanted[i]);
    if (d) {
      row.outcome = "fail";
      row.why = `#${i}: ${d}`;
      return;
    }
  }
}

// ------------------------------------------------------------------ report
const by = new Map<string, Record<string, number>>();
const tot: Record<string, number> = { pass: 0, fail: 0, error: 0, skip: 0, na: 0 };
for (const r of rows) {
  const c = by.get(r.group) ?? { pass: 0, fail: 0, error: 0, skip: 0, na: 0 };
  c[r.outcome]++;
  tot[r.outcome]++;
  by.set(r.group, c);
}
console.log(`total ${rows.length}: pass ${tot.pass}  fail ${tot.fail}  error ${tot.error}  skip ${tot.skip}  n/a ${tot.na}`);
for (const [g, c] of by) {
  if (c.fail || c.error || verbose) console.log(`${g.padEnd(40)} pass ${c.pass}  fail ${c.fail}  error ${c.error}  skip ${c.skip}  n/a ${c.na}`);
}
if (verbose) for (const r of rows) if (r.outcome === "fail" || r.outcome === "error") console.log(`  [${r.outcome}] ${r.group}/${r.name}: ${r.expr.trim().replace(/\s+/g, " ").slice(0, 120)}  — ${r.why}`);
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ totals: tot, groups: Object.fromEntries(by), rows }, null, 1));
