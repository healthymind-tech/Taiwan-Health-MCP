/**
 * FHIRPath parity (parity v3): runs the official R4 FHIRPath test suite
 * (fhir-test-cases r4/fhirpath/tests-fhir-r4.xml) through the engine our validator
 * uses for invariants — `evaluateExpression` in src/fhirPath.ts, the same
 * compile cache / R4 model / user functions / %resource variables as
 * `evaluateConstraint`.
 *
 *   node --import tsx scripts/parity/fhirpath/run.ts [--json out.json] [-v] [--group <name>] [--test <name>] [--oracle jar.json]
 *
 * --oracle (scripts/parity/oracle/oracle.sh fhirpath): validator_cli 7.0.1 is the judge. The score is the number of
 * cases whose result equals the jar's (a throw on the jar is a result: ours must throw too); the suite pass rate is
 * reference only. Cases where the jar and the suite differ are listed with the Java file:line of the reason, from the
 * jar's stack trace or from fhirpath/jar-vs-suite.json. Run with TZ=UTC, the jar's zone (`now()` and date arithmetic).
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
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { evaluateExpression, fhirPathBase, resultTypes, type FhirPathEnv } from "../../../src/fhirPath.js";
import { parseFhirXml, parseXmlDocument, type XElement } from "../../../src/fhirXml.js";
import { FileValidatorResolver, ResourceStore } from "../lib/fileResolver.js";
import { findPackage } from "../lib/packages.js";

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
const oracleFile = opt("--oracle");

const TC = process.env.FHIR_TEST_CASES || join(homedir(), "ref", "fhir-test-cases");
const CACHE = process.env.FHIR_PACKAGE_CACHE || join(homedir(), ".fhir", "packages");
const R4 = join(TC, "r4");
// XML inputs are read with the validator's XML reader (src/fhirXml.ts) over the R4 core definitions
const coreStore = new ResourceStore();
const corePkg = findPackage("hl7.fhir.r4.core#4.0.1");
if (!corePkg) throw new Error(`hl7.fhir.r4.core#4.0.1 not found (package caches incl. ${CACHE})`);
coreStore.addPackage(corePkg);
const xmlResolver = new FileValidatorResolver(coreStore);

/** Generic view of an XML element (the test-suite file itself). */
interface XmlEl {
  name: string;
  attrs: Record<string, string>;
  children: XmlEl[];
  text: string;
}
function xmlEl(el: XElement): XmlEl {
  const text = (e: XElement): string => e.children.map((c) => (c.type === "text" || c.type === "cdata" ? c.text : c.type === "element" ? text(c) : "")).join("");
  return {
    name: el.local,
    attrs: Object.fromEntries(el.attrs.map((a) => [a.local, a.value])),
    children: el.children.filter((c): c is XElement => c.type === "element").map(xmlEl),
    text: text(el),
  };
}

const inputs = new Map<string, string>();
async function preloadInput(name: string): Promise<void> {
  if (inputs.has(name)) return;
  const src = readFileSync(join(R4, name), "utf8");
  const res = name.endsWith(".xml") ? (await parseFhirXml(src, xmlResolver)).resource : JSON.parse(src);
  inputs.set(name, JSON.stringify(res));
}
function loadInput(name: string): Json {
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
  const timeLiteral = v.startsWith("@T");
  if (type === "date" || type === "dateTime" || type === "time" || v.startsWith("@")) v = v.replace(/^@/, "");
  if (type === "time" || timeLiteral) v = v.replace(/^T/, "");
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

interface Item { type: string; value?: string; leaves?: string[] }
/** What the engine returned for a case: the shared shape of ours and the jar's. */
interface Observed { threw: boolean; items: Item[]; ordered: boolean }
interface Row { key: string; group: string; name: string; outcome: "pass" | "fail" | "error" | "skip" | "na"; why?: string; expr: string; observed?: Observed }
const rows: Row[] = [];
const expectedOf = new Map<string, { t: XmlEl; outputs: XmlEl[]; invalid: string | null }>();

const suite = xmlEl(parseXmlDocument(readFileSync(join(R4, "fhirpath", "tests-fhir-r4.xml"), "utf8")).root);
for (const g of suite.children) for (const t of g.children) if (t.attrs.inputfile) await preloadInput(t.attrs.inputfile);
for (const g of suite.children.filter((c) => c.name === "group")) {
  const group = g.attrs.name;
  if (onlyGroup && group !== onlyGroup) continue;
  const groupTests = g.children.filter((c) => c.name === "test");
  for (const t of groupTests) {
    const name = t.attrs.name ?? `${group}#${g.children.indexOf(t)}`;
    if (onlyTest && name !== onlyTest) continue;
    const exprEl = t.children.find((c) => c.name === "expression")!;
    const expr = exprEl.text;
    const row: Row = { key: `${group}#${groupTests.indexOf(t)}`, group, name, expr, outcome: "pass" };
    rows.push(row);
    if (g.attrs.mode === "custom") {
      row.outcome = "skip";
      row.why = "mode=custom (HL7 Java document functions)";
      continue;
    }
    const invalid = exprEl.attrs.invalid ?? null;
    const outputs = t.children.filter((c) => c.name === "output");
    expectedOf.set(row.key, { t, outputs, invalid });
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
      row.observed = { threw: false, items: itemsOf(result), ordered: t.attrs.ordered !== "false" };
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
      row.observed = { threw: true, items: [], ordered: true };
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

/** Every primitive below a JSON element as "path=value", the form of the jar's `leaves`. */
function leavesOf(v: unknown, path: string, out: string[]): string[] {
  if (Array.isArray(v)) for (const x of v) leavesOf(x, path, out);
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v as Json)) leavesOf(x, path ? `${path}.${k.replace(/^_/, "")}` : k, out);
  else if (v !== null && v !== undefined) out.push(`${path}=${String(v)}`);
  return out;
}

function itemsOf(result: any[]): Item[] {
  let types: string[];
  try {
    types = resultTypes(result).map(fhirTypeName);
  } catch {
    types = result.map(() => "?");
  }
  return result.map((r, i) => {
    const v = fpUtil.valData(r);
    const type = types[i];
    if (v && typeof v === "object" && !(v instanceof fpTypes.FP_Type) && !(typeof v.value === "number" && ("unit" in v || "code" in v))) {
      return { type, leaves: leavesOf(v, "", []).filter((l) => !l.startsWith("resourceType=")).sort() };
    }
    return { type, value: normFound(type, stringValue(r)) };
  });
}

/** Same value for a verdict: decimals as numbers (1.0 = 1), quantities as value + unit, dates without their literal markers. */
function comparable(i: Item): string {
  if (i.type === "Quantity") {
    if (i.leaves) {
      const leaf = (n: string): string | undefined => i.leaves!.find((l) => l.startsWith(`${n}=`))?.slice(n.length + 1);
      return `${Number(leaf("value"))} ${leaf("code") ?? leaf("unit") ?? ""}`;
    }
    const m = /^(\S+)\s+'?([^']*)'?$/.exec(i.value ?? "");
    return m ? `${Number(m[1])} ${m[2]}` : (i.value ?? "");
  }
  if (i.leaves) return i.leaves.join("\n");
  const v = i.value ?? "";
  if (i.type === "decimal") return String(Number(v));
  if (i.type === "date" || i.type === "dateTime" || i.type === "time" || i.type === "instant") return v.replace(/^@T?/, "").replace(/^T/, "");
  return v;
}

function sameResult(a: Observed, b: Observed): boolean {
  if (a.threw || b.threw) return a.threw === b.threw;
  if (a.items.length !== b.items.length) return false;
  const k = (i: Item): string => `${i.type}|${comparable(i)}`;
  const x = a.items.map(k);
  const y = b.items.map(k);
  return (a.ordered && b.ordered ? x : x.sort()).join("\u0000") === (a.ordered && b.ordered ? y : y.sort()).join("\u0000");
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

// ------------------------------------------------------------------ the jar as judge
interface JarCase { name: string; parse?: string; check?: string; eval?: string; items?: Item[]; predicate?: boolean; error?: string; frames?: string[]; skip?: string }

/** Would the HL7 runner (FHIRPathTests) accept what the jar did? The reason text when not, null when it passes. */
function jarVsSuite(jar: JarCase, key: string): string | null {
  const e = expectedOf.get(key);
  if (!e) return null;
  if (e.invalid === "syntax") return jar.parse === "threw" ? null : "suite expects a syntax error, jar parsed";
  if (jar.parse === "threw") return `jar syntax error: ${jar.error}`;
  if (e.invalid === "semantic") return jar.check === "threw" ? null : "suite expects a semantic error, jar's static check passed";
  if (e.invalid === "execution") return jar.eval === "threw" ? null : "suite expects an execution error, jar evaluated";
  if (jar.eval === "threw") return `jar threw: ${jar.error}`;
  const items: Item[] = e.t.attrs.predicate === "true" ? [{ type: "boolean", value: String(jar.predicate) }] : (jar.items ?? []);
  if (items.length !== e.outputs.length) return `count ${items.length} != ${e.outputs.length}`;
  const wanted = e.outputs.map((o) => ({ type: o.attrs.type ?? "", value: normExpected(o.attrs.type ?? null, o.text) }));
  const matches = (i: Item, w: { type: string; value: string }): boolean =>
    (!w.type || w.type === i.type) && (w.value === "" || comparable(i) === comparable({ type: i.type, value: w.value }));
  if (e.t.attrs.ordered === "false") {
    const left = [...items];
    for (const w of wanted) {
      const k = left.findIndex((i) => matches(i, w));
      if (k < 0) return `missing ${w.value}`;
      left.splice(k, 1);
    }
    return null;
  }
  for (let i = 0; i < wanted.length; i++) if (!matches(items[i], wanted[i])) return `#${i}: ${items[i].type} ${items[i].value ?? "(complex)"} != ${wanted[i].type} ${wanted[i].value}`;
  return null;
}

if (oracleFile) {
  const jar = JSON.parse(readFileSync(oracleFile, "utf8")) as Record<string, JarCase>;
  const reasonsFile = join(dirname(fileURLToPath(import.meta.url)), "jar-vs-suite.json");
  const reasons = (existsSync(reasonsFile) ? JSON.parse(readFileSync(reasonsFile, "utf8")) : {}) as Record<string, { java: string; reason: string }>;
  const judged = rows.filter((r) => jar[r.key] && !jar[r.key].skip);
  const disagree: Row[] = [];
  const jarSuite: Array<{ key: string; name: string; why: string; java: string; reason?: string }> = [];
  for (const r of judged) {
    const j = jar[r.key];
    const jo: Observed = { threw: j.parse === "threw" || j.eval === "threw", items: j.items ?? [], ordered: expectedOf.get(r.key)?.t.attrs.ordered !== "false" };
    if (!r.observed || !sameResult(jo, r.observed)) disagree.push(r);
    const why = jarVsSuite(j, r.key);
    if (why) jarSuite.push({ key: r.key, name: r.name, why, java: reasons[r.key]?.java ?? j.frames?.[0] ?? "(no reason recorded)", reason: reasons[r.key]?.reason });
  }
  const unexplained = jarSuite.filter((x) => x.java === "(no reason recorded)").length;
  console.log(`\nagreement with validator_cli 7.0.1: ${judged.length - disagree.length}/${judged.length} (${((100 * (judged.length - disagree.length)) / judged.length).toFixed(1)}%), target 100%`);
  console.log(`suite pass rate (reference only): ${tot.pass}/${rows.length}`);
  console.log(`jar vs suite: ${jarSuite.length} cases differ (${unexplained} without a Java reason)`);
  if (verbose) {
    for (const r of disagree) {
      const j = jar[r.key];
      const show = (o: { threw?: boolean; items?: Item[] } | undefined): string => (o?.threw ? "threw" : JSON.stringify((o?.items ?? []).map((i) => `${i.type}:${i.value ?? `{${(i.leaves ?? []).length} leaves}`}`)));
      console.log(`  [disagree] ${r.key} ${r.name}: ${r.expr.trim().replace(/\s+/g, " ").slice(0, 100)}\n     jar ${show({ threw: j.parse === "threw" || j.eval === "threw", items: j.items })}${j.error ? ` (${j.error.slice(0, 120)})` : ""}\n     ts  ${show(r.observed)}`);
    }
    for (const x of jarSuite) console.log(`  [jar != suite] ${x.key} ${x.name}: ${x.why.slice(0, 140)} <- ${x.java}`);
  }
  if (jsonOut) {
    const prior = JSON.parse(readFileSync(jsonOut, "utf8"));
    writeFileSync(jsonOut, JSON.stringify({ ...prior, oracle: { judged: judged.length, agree: judged.length - disagree.length, disagree: disagree.map((r) => ({ key: r.key, name: r.name, expr: r.expr, jar: jar[r.key], ts: r.observed })), jarVsSuite: jarSuite } }, null, 1));
  }
}
