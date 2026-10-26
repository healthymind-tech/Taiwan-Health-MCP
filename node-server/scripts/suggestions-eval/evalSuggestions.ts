/**
 * Suggestion-layer evaluation: runs the real InstanceValidator over the synthetic fixtures
 * (fixtures.ts) on a file-backed package closure (TW Core 1.0.0 + its HL7 dependencies from
 * a local FHIR package cache), attaches suggestions, and reports per category:
 *   detected  — the validator raised an issue of that category,
 *   covered   — that issue got ≥ 1 suggestion (reference chain: ≥ 1 caused_by),
 *   top-1     — the first suggestion is an expected value.
 * Also checks that attaching suggestions changes no existing issue field, and times it.
 *
 *   FHIR_PACKAGE_CACHE=~/.fhir/packages node --import tsx scripts/suggestions-eval/evalSuggestions.ts [-v]
 *
 * Exit code 1 when coverage < 90 % or top-1 < 80 % overall (the R1 acceptance bar), 2 when
 * the package cache is missing.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { InstanceValidator } from "../../src/fhirValidator.js";
import { attachSuggestions, suggestionCategory } from "../../src/fhirSuggestions/index.js";
import { FilePackages, PACKAGES } from "./fileDeps.js";
import { FIXTURES, HELDOUT, type Fixture } from "./fixtures.js";

function candidatesDir(): string | null {
  const dirs = [process.env.FHIR_PACKAGE_CACHE, join(homedir(), ".fhir", "packages")].filter((d): d is string => !!d);
  return dirs.find((d) => PACKAGES.every((p) => existsSync(join(d, p, "package")))) ?? null;
}

function strip(issues: Array<Record<string, any>>): string {
  return JSON.stringify(issues.map(({ suggestions, caused_by, slice_match, profile_match, ...rest }) => rest));
}

function pct(n: number, d: number): string {
  return d ? `${((100 * n) / d).toFixed(1)}%` : "-";
}

function quantile(xs: number[], q: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)];
}

export interface EvalRow {
  id: string;
  category: string;
  /** Fixture sub-category (per-kind breakdown), when the fixture has one. */
  sub: string | null;
  detected: boolean;
  covered: boolean;
  correct: boolean;
  first: string | null;
  ms: number;
}

export async function runEval(pk: FilePackages, fixtures: Fixture[] = FIXTURES): Promise<{ rows: EvalRow[]; validateMs: number[]; mutated: string[] }> {
  const resolver = pk.resolver();
  const deps = pk.suggestionDeps();
  const rows: EvalRow[] = [];
  const validateMs: number[] = [];
  const mutated: string[] = [];
  for (const f of fixtures) {
    const res = JSON.parse(JSON.stringify(f.resource));
    const t0 = performance.now();
    const issues = (await new InstanceValidator(resolver).validate(res, { profiles: f.profile ? [f.profile] : [] })) as Array<Record<string, any>>;
    validateMs.push(performance.now() - t0);
    const before = strip(issues);
    const t1 = performance.now();
    await attachSuggestions(issues, res, deps);
    const ms = performance.now() - t1;
    if (strip(issues) !== before) mutated.push(f.id);
    const target = issues.find((i) => suggestionCategory(i) === f.category);
    let first: string | null = null;
    let firstKind: string | null = null;
    let covered = false;
    if (target) {
      if (f.category === "reference_chain") {
        covered = Array.isArray(target.caused_by) && target.caused_by.length > 0;
        first = covered ? String(target.caused_by[0].path) : null;
      } else {
        covered = Array.isArray(target.suggestions) && target.suggestions.length > 0;
        first = covered ? String(target.suggestions[0].value) : null;
        firstKind = covered ? String(target.suggestions[0].kind) : null;
      }
    }
    const correct =
      first !== null &&
      (!f.kind || firstKind === f.kind) &&
      (f.category === "reference_chain" ? f.expect.some((e) => first === e || first!.startsWith(e + ".")) : f.suffix ? f.expect.some((e) => first!.endsWith(e)) : f.expect.includes(first));
    rows.push({ id: f.id, category: f.category, sub: f.sub ?? null, detected: !!target, covered, correct, first: first !== null && firstKind ? `${firstKind}:${first}` : first, ms });
    if (process.argv.includes("-v")) {
      console.log(`${correct ? "OK  " : covered ? "MISS" : target ? "NONE" : "UNDET"} ${f.id}: ${target ? target.message : "(no issue of this category: " + issues.map((i) => i.message).join(" | ") + ")"}`);
      if (target && (target.suggestions || target.caused_by)) console.log("      →", JSON.stringify((target.suggestions || target.caused_by).slice(0, 3).map((s: any) => (s.kind ? `${s.kind}:${s.value}@${s.confidence}` : s.value ?? s.path + " " + s.message))));
    }
  }
  return { rows, validateMs, mutated };
}

async function main(): Promise<void> {
  const dir = candidatesDir();
  if (!dir) {
    console.error(`FHIR package cache with ${PACKAGES.join(", ")} not found (set FHIR_PACKAGE_CACHE)`);
    process.exit(2);
  }
  const t = performance.now();
  const pk = new FilePackages(dir);
  console.log(`loaded ${pk.byUrl.size} definitions in ${((performance.now() - t) / 1000).toFixed(1)} s from ${dir}`);
  // Warm-up (UCUM tables, SD caches) so the timings below are steady-state.
  await runEval(pk, FIXTURES.slice(0, 3));
  let failed = false;
  for (const [name, set] of [["development set", FIXTURES], ["held-out set", HELDOUT]] as const) {
    const { rows, validateMs, mutated } = await runEval(pk, set);
    console.log(`\n== ${name} (${set.length} fixtures)`);
    const cats = [...new Set(rows.map((r) => r.category))];
    const line = (label: string, rs: EvalRow[]): void => {
      const det = rs.filter((r) => r.detected);
      const cov = rs.filter((r) => r.covered);
      const ok = rs.filter((r) => r.correct);
      console.log(`${label.padEnd(22)} ${String(rs.length).padStart(2)}  ${pct(det.length, rs.length).padStart(8)}  ${pct(cov.length, det.length).padStart(8)}  ${pct(ok.length, det.length).padStart(19)}  ${pct(ok.length, cov.length).padStart(18)}`);
    };
    console.log("category               n  detected  coverage  top-1 (of detected)  top-1 (of covered)");
    for (const c of [...cats, "ALL"]) line(c, c === "ALL" ? rows : rows.filter((r) => r.category === c));
    const subs = [...new Set(rows.map((r) => r.sub).filter((x): x is string => x !== null))].sort();
    if (subs.length) {
      console.log("sub-category (first suggestion must also be of the expected kind)");
      for (const sub of subs) line("  " + sub, rows.filter((r) => r.sub === sub));
    }
    const miss = rows.filter((r) => !r.correct).map((r) => `${r.id}${r.first !== null ? ` (got ${r.first})` : r.detected ? " (none)" : " (not detected)"}`);
    if (miss.length) console.log(`misses: ${miss.join("; ")}`);
    const ms = rows.map((r) => r.ms);
    console.log(`suggestion time per resource: p50 ${quantile(ms, 0.5).toFixed(1)} ms, p95 ${quantile(ms, 0.95).toFixed(1)} ms, max ${Math.max(...ms).toFixed(1)} ms`);
    console.log(`validation time per resource: p50 ${quantile(validateMs, 0.5).toFixed(1)} ms, p95 ${quantile(validateMs, 0.95).toFixed(1)} ms`);
    console.log(`existing issue fields changed: ${mutated.length ? mutated.join(", ") : "none"}`);
    const det = rows.filter((r) => r.detected);
    const coverage = rows.filter((r) => r.covered).length / Math.max(1, det.length);
    const top1 = rows.filter((r) => r.correct).length / Math.max(1, det.length);
    if (mutated.length || coverage < 0.9 || top1 < 0.8) failed = true;
  }
  if (failed) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
