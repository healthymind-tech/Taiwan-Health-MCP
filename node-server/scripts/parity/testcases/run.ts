/**
 * Official HL7 validator test suite runner for the in-process TS validator (parity v3 harness).
 *
 * Reads fhir-test-cases validator/manifest.json (FHIR_TEST_CASES, default ~/ref/fhir-test-cases), keeps the R4 cases
 * (version 4.0 / 4.0.1, or no version with an R4 expected output), and for each run (base validation, plus the
 * `profile` step when present — see manifest.ts) loads offline:
 *   base layer  R4 core + hl7.terminology.r4 + hl7.fhir.uv.extensions.r4 (manifest `versions`, nearest cached)
 *               + hl7.fhir.uv.tools.r4 (the tools extensions — implied-type-slice, matchetype — validator_cli knows),
 *   case layer  `packages` (+ dependency closure; .tgz paths unpacked) and `supporting` / `profiles` files,
 * validates the instance with InstanceValidator over FileValidatorResolver (no DB, no tx server) and compares the
 * error-level issues with the expected validator_cli output (lib/compare.ts: strict / class / count agreement).
 *
 *   systemd-run --user --scope -q -p MemoryMax=2G -p CPUQuota=80% nice -n 15 \
 *     node --max-old-space-size=1800 --import tsx scripts/parity/testcases/run.ts \
 *       [--only name[,name]] [--module tx,profile] [--format xml|json] [--json out.json] [--timeout ms] [-v] [--show-skipped]
 *       [--oracle jar.jsonl]
 *
 * --oracle (scripts/parity/oracle/oracle.sh suite): validator_cli 7.0.1 is the judge, the suite's expected files are
 * reference only. Each run is compared with the jar's own outcome and the report adds agreement with the jar over the
 * env-excluded denominator of parity_v3/progress.md; a run that fails the suite but matches the jar is `jar-agrees`.
 *
 * Output: a summary per module on stdout and per-run JSON (default scripts/parity/testcases/results.json, ignored by
 * git). Exit code 0 always (a report, not a gate) unless the suite cannot be read.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { InstanceValidator, type Issue } from "../../../src/fhirValidator.js";
import { parseFhirXml } from "../../../src/fhirXml.js";
import { errorClass } from "../classify.js";
import { compareIssues, isError, issuesOfOutcome, type Comparison, type SimpleIssue } from "../lib/compare.js";
import { FileValidatorResolver, ResourceStore } from "../lib/fileResolver.js";
import { findPackage, packageClosure, type Res } from "../lib/packages.js";
import { loadRuns, SUITE_DIR, type TestRun } from "./manifest.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (k: string): string | null => (args.includes(k) ? args[args.indexOf(k) + 1] ?? null : null);
const only = opt("--only")?.split(",").filter(Boolean) ?? null;
const modules = opt("--module")?.split(",").filter(Boolean) ?? null;
const formatFilter = opt("--format"); // json | xml: runs whose instance (or profile step source) has that format
const outFile = opt("--json") ?? join(HERE, "results.json");
const timeoutMs = Number(opt("--timeout") ?? 60_000);
const verbose = args.includes("-v");
const showSkipped = args.includes("--show-skipped");
const oracleFile = opt("--oracle");

export interface RunResult {
  id: string;
  name: string;
  module: string;
  step: string;
  file: string;
  status: "pass" | "fail" | "skipped" | "crash" | "timeout";
  skip?: string;
  comparison?: Comparison;
  expectedSource?: string;
  /** Flags that explain a mismatch without being a validator verdict difference. */
  flags: string[];
  missingPackages?: string[];
  snapshotless?: string[];
  /** Differential-only profiles whose snapshot was generated (src/fhirSnapshotGenerator.ts) + its error messages. */
  snapshotGenerated?: string[];
  snapshotMessages?: string[];
  txLookups?: number;
  ms?: number;
  error?: string;
  actual?: SimpleIssue[];
  /** With --oracle: this run against the jar's outcome. */
  oracle?: OracleVerdict;
}

/** agree: our errors equal the jar's. jar-agrees: same, and the run fails the suite. no-outcome: the jar gave none. */
export type OracleClass = "agree" | "jar-agrees" | "disagree" | "no-outcome" | "not-run";
export interface OracleVerdict {
  class: OracleClass;
  /** Our issues vs the jar's. */
  comparison?: Comparison;
  /** The jar's issues vs the suite's expected file: false = the suite's expectation is not what this jar does. */
  jarMatchesSuite?: boolean;
  jarErrors?: number;
  jarStatus?: string;
  jarError?: string;
  /** Requests that missed the bundled tx cache (the jar's outcome depended on the live server). */
  txRequests?: number;
}

export interface OracleRow {
  id: string;
  status: string;
  outcome?: Res;
  error?: string;
  txRequests?: number;
}

/** The jar's record: one JSON object per line (oracle/java/oracle/SuiteOracle.java); a re-run's later line wins. */
export function readOracle(file: string): Map<string, OracleRow> {
  const rows = new Map<string, OracleRow>();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as OracleRow;
    rows.set(row.id, row);
  }
  return rows;
}

export function judgeWithOracle(r: RunResult, row: OracleRow | undefined, expected: SimpleIssue[]): OracleVerdict {
  if (r.status === "skipped") return { class: "not-run" };
  if (row?.status === "threw" && row.error) {
    // the evaluator's rule for an official crash: the instance is not accepted, so ours must give at least one error
    const rejected = (r.actual ?? []).some(isError);
    return { class: rejected ? (r.status === "pass" ? "agree" : "jar-agrees") : "disagree", jarStatus: row.status, jarError: row.error, txRequests: row.txRequests };
  }
  if (!row || row.status !== "ok") return { class: "no-outcome", jarStatus: row?.status ?? "missing", jarError: row?.error, txRequests: row?.txRequests };
  const jarIssues = issuesOfOutcome(row.outcome);
  // our crash / timeout has no issue list: it can only disagree
  const comparison = compareIssues(jarIssues, r.actual ?? [{ severity: "fatal", path: "", message: `harness ${r.status}` }]);
  return {
    class: comparison.strict ? (r.status === "pass" ? "agree" : "jar-agrees") : "disagree",
    comparison,
    jarMatchesSuite: compareIssues(expected, jarIssues).strict,
    jarErrors: comparison.expectedErrors,
    jarStatus: row.status,
    txRequests: row.txRequests,
  };
}

/** parity_v3/progress.md: runs without tx-dependent / no-snapshot / missing-package / any option:* flag. */
export function envExcluded(r: RunResult): boolean {
  return r.status !== "skipped" && !r.flags.some((f) => f === "tx-dependent" || f === "no-snapshot" || f === "missing-package" || f.startsWith("option:"));
}

export function oracleReport(results: RunResult[]): string {
  const lines: string[] = [];
  const row = (label: string, rs: RunResult[]): string => {
    const n = (c: OracleClass): number => rs.filter((r) => r.oracle?.class === c).length;
    const judged = n("agree") + n("jar-agrees") + n("disagree");
    const lenient = rs.filter((r) => r.oracle?.comparison?.lenient).length;
    const verdict = rs.filter((r) => r.oracle?.comparison && (r.oracle.comparison.expectedErrors > 0) === (r.oracle.comparison.actualErrors > 0)).length;
    return `${label.padEnd(26)} judged ${String(judged).padStart(4)}  agree-with-jar ${n("agree") + n("jar-agrees")} (${pct(n("agree") + n("jar-agrees"), judged)})  of which jar-agrees ${n("jar-agrees")}  disagree ${n("disagree")}  lenient ${lenient}  same-valid/invalid ${verdict}  no-jar-outcome ${n("no-outcome")}`;
  };
  const ran = results.filter((r) => r.status !== "skipped");
  const excl = results.filter(envExcluded);
  lines.push("agreement with validator_cli 7.0.1 (strict = same errors, path + message; suite figures above are reference only)");
  lines.push(row("env-excluded", excl), row("all runs", ran));
  lines.push(row("env-excl., failing suite", excl.filter((r) => r.status !== "pass")), row("env-excl., passing suite", excl.filter((r) => r.status === "pass")));
  const js = ran.filter((r) => r.oracle?.jarMatchesSuite === false);
  lines.push(`jar differs from the suite's expected file: ${js.length} runs (${excl.filter((r) => r.oracle?.jarMatchesSuite === false).length} env-excluded)`);
  for (const r of excl.filter((x) => x.oracle?.class === "disagree")) lines.push(`  disagree ${r.id} [${r.module}] jar errors ${r.oracle!.comparison?.expectedErrors ?? "(crash)"}, ours ${r.oracle!.comparison?.actualErrors ?? 0}`);
  for (const r of excl.filter((x) => x.oracle?.class === "jar-agrees")) lines.push(`  jar-agrees ${r.id} [${r.module}]`);
  for (const r of ran.filter((x) => x.oracle?.class === "no-outcome")) lines.push(`  no jar outcome ${r.id}: ${r.oracle!.jarStatus} ${(r.oracle!.jarError ?? "").slice(0, 160)}`);
  return lines.join("\n");
}

function loadJsonFile(p: string): Res | null {
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Res;
  } catch {
    return null;
  }
}

/** The shared base layer (built once). */
function baseStore(suite: string): { store: ResourceStore; ids: Set<string>; missing: string[] } {
  const manifest = loadJsonFile(join(suite, "manifest.json")) ?? {};
  const v = (manifest.versions ?? {}) as Res;
  const specs = ["hl7.fhir.r4.core#4.0.1", `hl7.terminology.r4#${v.terminology ?? ""}`.replace(/#$/, ""), `hl7.fhir.uv.extensions.r4#${v.extensions ?? ""}`.replace(/#$/, ""), "hl7.fhir.uv.tools.r4"];
  const store = new ResourceStore();
  const ids = new Set<string>();
  const missing: string[] = [];
  for (const s of specs) {
    const ref = findPackage(s) ?? findPackage(s.split("#")[0]);
    if (!ref) {
      missing.push(s);
      continue;
    }
    store.addPackage(ref);
    ids.add(ref.id);
  }
  return { store, ids, missing };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout after ${ms} ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export async function executeRun(run: TestRun, base: { store: ResourceStore; ids: Set<string> }, suite = SUITE_DIR): Promise<RunResult> {
  const r: RunResult = { id: run.id, name: run.name, module: run.module, step: run.step, file: run.file, status: "skipped", flags: [...run.options.map((o) => `option:${o}`)] };
  if (run.skip) {
    r.skip = run.skip;
    return r;
  }
  const store = new ResourceStore(base.store);
  const closure = packageClosure(run.packages, { relDir: suite, skip: base.ids });
  for (const p of closure.packages) store.addPackage(p);
  if (closure.missing.length) {
    r.missingPackages = closure.missing;
    r.flags.push("missing-package");
  }
  // XML conformance files are read the way validator_cli reads them (XmlParser over the base definitions)
  const xmlResolver = new FileValidatorResolver(base.store);
  const loadFile = async (p: string): Promise<Res | null> => {
    if (!existsSync(p)) return null;
    if (/\.xml$/i.test(p)) {
      try {
        return (await parseFhirXml(readFileSync(p, "utf8"), xmlResolver)).resource;
      } catch {
        return null;
      }
    }
    return loadJsonFile(p);
  };
  const igs: Res[] = []; // loose ImplementationGuides (validator_cli: the loaded IGs, whose `global` profiles apply)
  for (const f of run.supporting) {
    const p = join(suite, f);
    if (!/\.(json|xml)$/i.test(f)) {
      r.flags.push(`supporting-unloaded:${f.split(".").pop()}`);
      continue;
    }
    const res = await loadFile(p);
    if (!res) r.flags.push(`supporting-missing:${f}`);
    else {
      store.addResource(res, `supporting:${f}`);
      if (res.resourceType === "ImplementationGuide") igs.push(res);
    }
  }
  const profiles: string[] = [];
  if (run.profileSource && /^https?:\/\//i.test(run.profileSource)) {
    // the profile step names a canonical of a loaded package (ValidationTests: fetchResource by URL)
    profiles.push(run.profileSource);
  } else if (run.profileSource) {
    const sd = await loadFile(join(suite, run.profileSource));
    if (!sd || typeof sd.url !== "string") {
      r.skip = "profile-unreadable";
      return r;
    }
    store.addResource(sd, `profile:${run.profileSource}`);
    profiles.push(sd.url);
  }
  const resolver = new FileValidatorResolver(store);
  resolver.testFetcher = run.raw.fetcher !== "standalone";
  // ValidationTests' fetcher for `validateReference` cases: `Type/id` → the suite file <id>.json / <id>.xml of that type
  // (one object per reference, so reference cycles are recognised)
  const fetched = new Map<string, Promise<Res | null>>();
  resolver.fetchReference = (ref: string): Promise<Res | null> => {
    let p = fetched.get(ref);
    if (!p) {
      p = (async () => {
        const m = /^(?:.*\/)?([A-Z][A-Za-z]+)\/([A-Za-z0-9\-.]{1,64})$/.exec(ref);
        if (!m) return null;
        // the instance under validation is the same element (ResourceValidationTracker: a cycle back to it is valid)
        if (resource && resource.resourceType === m[1] && resource.id === m[2]) return resource;
        for (const f of [`${m[2]}.json`, `${m[2]}.xml`]) {
          const res = await loadFile(join(suite, f));
          if (res && res.resourceType === m[1] && res.id === m[2]) return res;
        }
        return null;
      })();
      fetched.set(ref, p);
    }
    return p;
  };
  let actual: SimpleIssue[];
  const t0 = Date.now();
  const text = readFileSync(join(suite, run.file), "utf8");
  let resource: Res | null = null;
  let parseIssues: Issue[] = [];
  if (/\.xml$/i.test(run.file)) {
    // validator_cli's XmlParser: parse-time issues + the element model handed to the validator
    const x = await parseFhirXml(text, resolver);
    parseIssues = x.issues;
    resource = x.resource;
    r.flags.push("xml");
    if (!resource) actual = parseIssues.map((i) => ({ severity: i.severity, path: i.path, message: i.message, code: i.code }));
  } else {
    // JSON: the file text through validateText (validator_cli's JSON reader: syntax errors, comments, commas, quotes,
    // duplicate names); "allow-comments" cases accept comments (elementmodel JsonParser.allowComments)
    try {
      JSON.parse(text);
    } catch {
      r.flags.push("json-parse");
    }
  }
  const isXml = /\.xml$/i.test(run.file);
  if (resource || !isXml) {
    try {
      // ValidationTests: the test locale is en-US (display messages "for the language(s) 'en-US'"); "language" sets
      // the validation language; "wrong-displays": "warning" → displayWarningMode; allowExamples unless "examples": false
      const languages = typeof run.raw.language === "string" && run.raw.language ? [run.raw.language] : ["en-US"];
      const displayWarnings = run.raw["wrong-displays"] === "warning";
      // ValidationTests runs with allowExamples = true unless the case says "examples": false (manifest: dr-example-org
      // / pat-example-extensions are the only R4 outputs with TYPE_SPECIFIC_CHECKS_DT_URL_EXAMPLE)
      const allowExamples = run.raw.examples !== false;
      // "noHtmlInMarkdown": true → htmlInMarkdownCheck ERROR (ValidationTests); validator_cli default WARNING
      const htmlInMarkdown: "warning" | "error" = run.raw.noHtmlInMarkdown === true ? "error" : "warning";
      // ValidationTests: a primitive "matchetype" in the case → MatchetypeStatus.Required
      const matchetypeStatus: "required" | undefined = typeof run.raw.matchetype === "boolean" && run.raw.matchetype ? "required" : undefined;
      const opts = { profiles, languages, displayWarnings, allowExamples, matchetypeStatus, htmlInMarkdown, assumeValidRestReferences: run.options.includes("assumeValidRestReferences"), bundleRules: bundleRulesOf(run.raw), implementationGuides: igs, validateReference: referencePolicyOf(run.raw) };
      const v = new InstanceValidator(resolver);
      const issues = isXml
        ? [...parseIssues, ...(await withTimeout(v.validate(resource!, { ...opts, format: "xml" }), timeoutMs))]
        : await withTimeout(v.validateText(text, { ...opts, allowJsonComments: run.raw["allow-comments"] === true }), timeoutMs);
      actual = issues.map((i) => ({ severity: i.severity, path: i.path, message: i.message, code: i.code }));
    } catch (e) {
      r.ms = Date.now() - t0;
      r.status = /timeout/.test(String((e as Error).message)) ? "timeout" : "crash";
      r.error = String((e as Error).stack ?? e).split("\n").slice(0, 4).join("\n");
      return r;
    }
  }
  r.ms = Date.now() - t0;
  r.txLookups = resolver.txLookups;
  if (resolver.txLookups) r.flags.push("tx-dependent");
  if (resolver.snapshotless.size) {
    r.snapshotless = [...resolver.snapshotless];
    r.flags.push("no-snapshot");
  }
  if (resolver.snapshotGenerated.size) {
    r.snapshotGenerated = [...resolver.snapshotGenerated];
    r.flags.push("snapshot-generated");
    const errs = resolver.snapshots.messages.filter((m) => m.level === "error");
    if (errs.length) r.snapshotMessages = errs.slice(0, 10).map((m) => `${m.path}: ${m.message}`);
  }
  const exp = run.expectation!;
  r.expectedSource = exp.source;
  r.comparison = compareIssues(exp.issues, actual!);
  if (exp.source === "inline-count" && exp.errorCount !== null) {
    // only a count to compare
    r.comparison.count = r.comparison.class = r.comparison.lenient = r.comparison.strict = r.comparison.actualErrors === exp.errorCount;
    r.comparison.expectedErrors = exp.errorCount;
  }
  r.actual = actual!;
  r.status = r.comparison.strict ? "pass" : "fail";
  return r;
}

function pct(n: number, d: number): string {
  return d ? `${((100 * n) / d).toFixed(1)}%` : "-";
}

export function summarise(results: RunResult[]): string {
  const lines: string[] = [];
  const ran = results.filter((r) => r.status !== "skipped");
  const mods = [...new Set(results.map((r) => r.module))].sort();
  lines.push(`module                 runs  strict        lenient       class         count         crash/timeout  skipped`);
  const row = (label: string, rs: RunResult[]): string => {
    const x = rs.filter((r) => r.status !== "skipped");
    const st = x.filter((r) => r.comparison?.strict).length;
    const cl = x.filter((r) => r.comparison?.class).length;
    const le = x.filter((r) => r.comparison?.lenient).length;
    const co = x.filter((r) => r.comparison?.count).length;
    const cr = x.filter((r) => r.status === "crash" || r.status === "timeout").length;
    const f = (n: number): string => `${n} (${pct(n, x.length)})`.padEnd(14);
    return `${label.padEnd(22)} ${String(x.length).padStart(4)}  ${f(st)}${f(le)}${f(cl)}${f(co)}${String(cr).padEnd(15)}${rs.length - x.length}`;
  };
  for (const m of mods) lines.push(row(m, results.filter((r) => r.module === m)));
  lines.push(row("TOTAL", results));
  const skipTally = new Map<string, number>();
  for (const r of results) if (r.status === "skipped") skipTally.set(r.skip ?? "?", (skipTally.get(r.skip ?? "?") ?? 0) + 1);
  lines.push("", "skipped: " + [...skipTally].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(", "));
  const flagTally = new Map<string, number>();
  for (const r of ran.filter((x) => x.status !== "pass")) for (const f of r.flags) flagTally.set(f, (flagTally.get(f) ?? 0) + 1);
  lines.push("flags on non-passing runs: " + [...flagTally].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, v]) => `${k}=${v}`).join(", "));
  const miss = new Map<string, number>();
  const extra = new Map<string, number>();
  for (const r of ran) {
    // tallied over lenient differences (verdicts), not wording-only twins
    const cls = (k: string): string => errorClass(k.split(" | ").slice(1).join(" | "));
    for (const k of r.comparison?.lenientMissing ?? []) miss.set(cls(k), (miss.get(cls(k)) ?? 0) + 1);
    for (const k of r.comparison?.lenientExtra ?? []) extra.set(cls(k), (extra.get(cls(k)) ?? 0) + 1);
  }
  lines.push("", "top MISSING error classes (official has, we don't; lenient differences):");
  for (const [k, v] of [...miss].sort((a, b) => b[1] - a[1]).slice(0, 25)) lines.push(`  ${String(v).padStart(4)}  ${k}`);
  lines.push("", "top EXTRA error classes (we report, official doesn't):");
  for (const [k, v] of [...extra].sort((a, b) => b[1] - a[1]).slice(0, 25)) lines.push(`  ${String(v).padStart(4)}  ${k}`);
  const missPk = new Map<string, number>();
  for (const r of ran) for (const p of r.missingPackages ?? []) missPk.set(p, (missPk.get(p) ?? 0) + 1);
  if (missPk.size) lines.push("", "missing packages: " + [...missPk].map(([k, v]) => `${k}(${v})`).join(", "));
  return lines.join("\n");
}

async function main(): Promise<void> {
  const suite = SUITE_DIR;
  let runs = loadRuns(suite);
  if (only) runs = runs.filter((r) => only.includes(r.name) || only.includes(r.id));
  if (modules) runs = runs.filter((r) => modules.includes(r.module));
  if (formatFilter) runs = runs.filter((r) => [r.file, r.profileSource ?? ""].some((f) => f.toLowerCase().endsWith(`.${formatFilter}`)));
  const base = baseStore(suite);
  if (base.missing.length) console.error(`base packages missing: ${base.missing.join(", ")}`);
  console.error(`base layer: ${base.store.packages.join(", ")}; ${runs.length} runs`);
  const results: RunResult[] = [];
  const oracle = oracleFile ? readOracle(oracleFile) : null;
  let i = 0;
  for (const run of runs) {
    i++;
    const res = await executeRun(run, base, suite);
    if (oracle) res.oracle = judgeWithOracle(res, oracle.get(run.id), run.expectation?.issues ?? []);
    results.push(res);
    if (verbose || (only && res.status !== "skipped") || (showSkipped && res.status === "skipped")) {
      const c = res.comparison;
      console.log(`[${i}/${runs.length}] ${res.id} (${res.module}) ${res.status}${res.skip ? ` (${res.skip})` : ""}${c ? ` errors official=${c.expectedErrors} ours=${c.actualErrors}` : ""}${res.flags.length ? ` flags=${res.flags.join(",")}` : ""}${res.error ? `\n  ${res.error}` : ""}`);
      if (c && (verbose || only)) {
        for (const m of c.missing) console.log(`   - MISSING ${m}`);
        for (const m of c.extra) console.log(`   + EXTRA   ${m}`);
        if (!c.strict && c.lenient) console.log("   (lenient match: wording-only differences)");
      }
    } else if (i % 50 === 0) console.error(`… ${i}/${runs.length}`);
  }
  writeFileSync(outFile, JSON.stringify({ generated: new Date().toISOString(), suite, base: base.store.packages, results }, null, 1));
  console.log(summarise(results));
  if (oracle) console.log(`\n${oracleReport(results)}`);
  console.log(`\nper-run JSON: ${outFile}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e);
    process.exit(2);
  });
}

/** The manifest's `bundle-param` ({rule, profile}, or a list of them) — validator_cli `-bundle <rule> <profile>`. */
function bundleRulesOf(raw: Record<string, any>): Array<{ rule: string; profile: string }> {
  const v = raw["bundle-param"];
  const list = Array.isArray(v) ? v : v ? [v] : [];
  return list.filter((x: any) => x && typeof x.rule === "string" && typeof x.profile === "string").map((x: any) => ({ rule: x.rule, profile: x.profile }));
}

/** The manifest's `validateReference` (true = CHECK_VALID, or a ReferenceValidationPolicy name). */
function referencePolicyOf(raw: Record<string, any>): "CHECK_EXISTS" | "CHECK_EXISTS_AND_TYPE" | "CHECK_VALID" | undefined {
  const v = raw.validateReference;
  if (v === true) return "CHECK_VALID";
  return v === "CHECK_EXISTS" || v === "CHECK_EXISTS_AND_TYPE" || v === "CHECK_VALID" ? v : undefined;
}
