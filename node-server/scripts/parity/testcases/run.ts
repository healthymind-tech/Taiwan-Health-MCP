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
 *       [--only name[,name]] [--module tx,profile] [--json out.json] [--timeout ms] [-v] [--show-skipped]
 *
 * Output: a summary per module on stdout and per-run JSON (default scripts/parity/testcases/results.json, ignored by
 * git). Exit code 0 always (a report, not a gate) unless the suite cannot be read.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { InstanceValidator } from "../../../src/fhirValidator.js";
import { compareIssues, type Comparison, type SimpleIssue } from "../lib/compare.js";
import { FileValidatorResolver, ResourceStore } from "../lib/fileResolver.js";
import { findPackage, packageClosure, type Res } from "../lib/packages.js";
import { loadRuns, SUITE_DIR, type TestRun } from "./manifest.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (k: string): string | null => (args.includes(k) ? args[args.indexOf(k) + 1] ?? null : null);
const only = opt("--only")?.split(",").filter(Boolean) ?? null;
const modules = opt("--module")?.split(",").filter(Boolean) ?? null;
const outFile = opt("--json") ?? join(HERE, "results.json");
const timeoutMs = Number(opt("--timeout") ?? 60_000);
const verbose = args.includes("-v");
const showSkipped = args.includes("--show-skipped");

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
  txLookups?: number;
  ms?: number;
  error?: string;
  actual?: SimpleIssue[];
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
  for (const f of run.supporting) {
    const p = join(suite, f);
    if (!/\.json$/i.test(f)) {
      r.flags.push(`supporting-unloaded:${f.split(".").pop()}`);
      continue;
    }
    const res = existsSync(p) ? loadJsonFile(p) : null;
    if (!res) r.flags.push(`supporting-missing:${f}`);
    else store.addResource(res, `supporting:${f}`);
  }
  const profiles: string[] = [];
  if (run.profileSource) {
    const sd = loadJsonFile(join(suite, run.profileSource));
    if (!sd || typeof sd.url !== "string") {
      r.skip = "profile-unreadable";
      return r;
    }
    store.addResource(sd, `profile:${run.profileSource}`);
    profiles.push(sd.url);
  }
  const resolver = new FileValidatorResolver(store);
  let actual: SimpleIssue[];
  const t0 = Date.now();
  const text = readFileSync(join(suite, run.file), "utf8");
  let resource: Res | null = null;
  try {
    resource = JSON.parse(text) as Res;
  } catch (e) {
    actual = [{ severity: "fatal", path: "", message: `JSON parse error: ${(e as Error).message}` }];
    r.flags.push("json-parse");
  }
  if (resource) {
    try {
      const issues = await withTimeout(new InstanceValidator(resolver).validate(resource, { profiles }), timeoutMs);
      actual = issues.map((i) => ({ severity: i.severity, path: i.path, message: i.message, code: i.code }));
      // ValidationTests runs with allowExamples = true unless the case says "examples": false (manifest: dr-example-org
      // / pat-example-extensions are the only R4 outputs with TYPE_SPECIFIC_CHECKS_DT_URL_EXAMPLE); the TS validator
      // has no such switch (validator_cli default false), so the harness drops that message.
      if (run.raw.examples !== false) {
        const n = actual.length;
        actual = actual.filter((i) => !/^Example URLs are not allowed in this context/.test(i.message));
        if (actual.length !== n) r.flags.push("harness:allowExamples");
      }
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
  const exp = run.expectation!;
  r.expectedSource = exp.source;
  r.comparison = compareIssues(exp.issues, actual!);
  if (exp.source === "inline-count" && exp.errorCount !== null) {
    // only a count to compare
    r.comparison.count = r.comparison.class = r.comparison.strict = r.comparison.actualErrors === exp.errorCount;
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
  lines.push(`module                 runs  strict        class         count         crash/timeout  skipped`);
  const row = (label: string, rs: RunResult[]): string => {
    const x = rs.filter((r) => r.status !== "skipped");
    const st = x.filter((r) => r.comparison?.strict).length;
    const cl = x.filter((r) => r.comparison?.class).length;
    const co = x.filter((r) => r.comparison?.count).length;
    const cr = x.filter((r) => r.status === "crash" || r.status === "timeout").length;
    const f = (n: number): string => `${n} (${pct(n, x.length)})`.padEnd(14);
    return `${label.padEnd(22)} ${String(x.length).padStart(4)}  ${f(st)}${f(cl)}${f(co)}${String(cr).padEnd(15)}${rs.length - x.length}`;
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
    for (const c of r.comparison?.missingClasses ?? []) miss.set(c, (miss.get(c) ?? 0) + 1);
    for (const c of r.comparison?.extraClasses ?? []) extra.set(c, (extra.get(c) ?? 0) + 1);
  }
  lines.push("", "top MISSING error classes (official has, we don't):");
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
  const base = baseStore(suite);
  if (base.missing.length) console.error(`base packages missing: ${base.missing.join(", ")}`);
  console.error(`base layer: ${base.store.packages.join(", ")}; ${runs.length} runs`);
  const results: RunResult[] = [];
  let i = 0;
  for (const run of runs) {
    i++;
    const res = await executeRun(run, base, suite);
    results.push(res);
    if (verbose || (only && res.status !== "skipped") || (showSkipped && res.status === "skipped")) {
      const c = res.comparison;
      console.log(`[${i}/${runs.length}] ${res.id} (${res.module}) ${res.status}${res.skip ? ` (${res.skip})` : ""}${c ? ` errors official=${c.expectedErrors} ours=${c.actualErrors}` : ""}${res.flags.length ? ` flags=${res.flags.join(",")}` : ""}${res.error ? `\n  ${res.error}` : ""}`);
      if (c && (verbose || only)) {
        for (const m of c.missing) console.log(`   - MISSING ${m}`);
        for (const m of c.extra) console.log(`   + EXTRA   ${m}`);
      }
    } else if (i % 50 === 0) console.error(`… ${i}/${runs.length}`);
  }
  writeFileSync(outFile, JSON.stringify({ generated: new Date().toISOString(), suite, base: base.store.packages, results }, null, 1));
  console.log(summarise(results));
  console.log(`\nper-run JSON: ${outFile}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e);
    process.exit(2);
  });
}
