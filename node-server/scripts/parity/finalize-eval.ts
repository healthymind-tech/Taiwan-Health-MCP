/**
 * ISSUES_v19 R1 evaluation: for every repro Bundle (<dir>/<name>.bundle.json) validate → fhir_finalize_bundle → validate
 * (in process, DB from DATABASE_URL, read-only) and report per R1 category the structural (non content-check) errors
 * before / after, the errors finalize ADDED (must be 0), the share fixed, and how many of the remaining R1-category
 * errors the finalize response lists in `ambiguous` (by pointer). The repro set is private evaluator data
 * (mcp_proposal/, untracked) — never commit it or this script's output.
 *
 *   DATABASE_URL=… node --import tsx scripts/parity/finalize-eval.ts <repro dir> [--json out.json] [-v] [--only <name>] [--batch 15]
 *     [--exposed strict|allow_under_moved]   (fhir_finalize_bundle exposed_errors)
 * The Bundles run in child processes of --batch Bundles each (the service's caches grow per Bundle). Exit 1 when
 * finalize added an error to any Bundle.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isContentCheck } from "./classify.js";
import { applyPatch, errorCategory, errorKey, R1_CATEGORIES, resolvePointer } from "../../src/fhirRepair/autoFix.js";

type Json = Record<string, any>;
const args = process.argv.slice(2);
const flag = (k: string): string | null => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
const VALUED = new Set(["--json", "--only", "--batch", "--worker", "--start", "--count", "--exposed"]);
const dir = args.find((a, i) => !a.startsWith("-") && !VALUED.has(args[i - 1] ?? ""))!;
const verbose = args.includes("-v");
const pkgFor = (name: string, b: Json): [string, string] => {
  const p = JSON.stringify(b.meta?.profile ?? []);
  if (name.startsWith("ipsx") || p.includes("/uv/ips/")) return ["hl7.fhir.uv.ips", "1.1.0"];
  if (name.startsWith("pasx") || p.includes("nhicore.nhi.gov.tw/pas")) return ["tw.gov.mohw.nhi.pas", "1.2.7"];
  return ["tw.gov.mohw.twcore", "1.0.0"];
};
const names = readdirSync(dir)
  .filter((f) => f.endsWith(".bundle.json"))
  .map((f) => f.replace(/\.bundle\.json$/u, ""))
  .filter((n) => !flag("--only") || n === flag("--only"))
  .sort();

function structuralErrors(env: Json): Json[] {
  const issues: Json[] = [...(env.data?.issues ?? []), ...((env.data?.entries ?? []) as Json[]).flatMap((e) => e.issues ?? [])];
  return issues.filter((i) => (i.severity === "error" || i.severity === "fatal") && !isContentCheck(i));
}

/** Worker: finalize + validate a slice of the Bundles, one JSON line each. */
async function worker(out: string, start: number, count: number): Promise<void> {
  const { closePool, initPool } = await import("../../src/db.js");
  const { FHIRIGService } = await import("../../src/fhirIgService.js");
  initPool({ maxSize: 2 });
  const svc = new FHIRIGService(null);
  for (const n of names.slice(start, start + count)) {
    const bundle = JSON.parse(readFileSync(join(dir, `${n}.bundle.json`), "utf8"));
    let cmp: Json = {};
    if (existsSync(join(dir, `${n}.compare.json`))) cmp = JSON.parse(readFileSync(join(dir, `${n}.compare.json`), "utf8"));
    const [pid, ver] = pkgFor(n, bundle);
    const named = ((cmp.official_errors ?? []) as Json[]).map((i) => /(https?:\/\/\S+\/StructureDefinition\/Bundle-[A-Za-z0-9-]+)/u.exec(i.message)?.[1]).find(Boolean);
    const bp = named ?? (pid === "hl7.fhir.uv.ips" ? "http://hl7.org/fhir/uv/ips/StructureDefinition/Bundle-uv-ips" : pid === "tw.gov.mohw.nhi.pas" ? "https://nhicore.nhi.gov.tw/pas/StructureDefinition/Bundle-twpas" : null);
    const t0 = Date.now();
    const before = structuralErrors(JSON.parse(await svc.validateBundle(bundle, pid, ver, false, undefined, "ids", null, bp)));
    const fin = JSON.parse(await svc.finalizeBundle(bundle, pid, ver, bp, { exposedErrors: (flag("--exposed") as "strict" | "allow_under_moved" | null) ?? "strict" }));
    const after = fin.ok ? structuralErrors(JSON.parse(await svc.validateBundle(fin.data.bundle, pid, ver, false, undefined, "ids", null, bp))) : before;
    const row = {
      name: n,
      ms: Date.now() - t0,
      heap_mb: Math.round(process.memoryUsage().heapUsed / 1048576),
      ok: !!fin.ok,
      before: before.map((i) => ({ path: i.path, message: i.message })),
      after: after.map((i) => ({ path: i.path, message: i.message })),
      changes: (fin.data?.changes ?? []).map((c: Json) => ({ category: c.category, rule: c.rule, pointer: c.pointer, moved_to: c.moved_to, before: c.before, after: c.after, reason: String(c.reason ?? "").slice(0, 200) })),
      ambiguous: (fin.data?.ambiguous ?? []).map((a: Json) => ({
        pointer: a.pointer,
        pointer_out: a.pointer_out,
        resolves: resolvePointer(bundle, a.pointer).found,
        resolves_out: fin.ok ? resolvePointer(fin.data.bundle, a.pointer_out ?? a.pointer).found : null,
        patches_out_ok: fin.ok ? (a.candidates ?? []).filter((c: Json) => c.patch_out).every((c: Json) => applyPatch(fin.data.bundle, c.patch_out) !== null) : null,
        category: a.category,
        candidates: (a.candidates ?? []).length,
        patches: (a.candidates ?? []).filter((c: Json) => c.patch).length,
        message: String(a.message).slice(0, 160),
      })),
    };
    appendFileSync(out, JSON.stringify(row) + "\n");
    process.stderr.write(`${n} ${before.length} → ${after.length} (${row.ms} ms)\n`);
  }
  await closePool();
}

function report(rows: Json[]): number {
  const cats = [...R1_CATEGORIES, "other"];
  const tot = Object.fromEntries(cats.map((c) => [c, { before: 0, after: 0, added: 0, flagged: 0 }])) as Record<string, { before: number; after: number; added: number; flagged: number }>;
  const addedTally = new Map<string, number>();
  const leftTally = new Map<string, number>();
  let zeroB = 0;
  let zeroA = 0;
  let amb = 0;
  let ambPatched = 0;
  for (const r of rows) {
    const left = new Map<string, number>();
    for (const i of r.before) left.set(errorKey(i.message), (left.get(errorKey(i.message)) ?? 0) + 1);
    for (const i of r.before) tot[errorCategory(i.message) ?? "other"].before++;
    for (const i of r.after) {
      const c = errorCategory(i.message) ?? "other";
      tot[c].after++;
      const k = errorKey(i.message);
      const n = left.get(k) ?? 0;
      if (n > 0) left.set(k, n - 1);
      else {
        tot[c].added++;
        addedTally.set(`${r.name}: ${i.path} | ${String(i.message).slice(0, 160)}`, 1);
      }
      if (c !== "other") {
        // flagged: the response lists an ambiguous item of that category
        if (r.ambiguous.some((a: Json) => a.category === c)) tot[c].flagged++;
        const key = `${c}: ${String(i.message).replace(/https?:\/\/\S+/gu, "<url>").replace(/'[^']*'/gu, "'<v>'").replace(/\d+/gu, "<n>").slice(0, 110)}`;
        leftTally.set(key, (leftTally.get(key) ?? 0) + 1);
      }
    }
    amb += r.ambiguous.length;
    ambPatched += r.ambiguous.filter((a: Json) => a.patches > 0).length;
    if (!r.before.length) zeroB++;
    if (!r.after.length) zeroA++;
  }
  // v19 release: no-op changes, existing values a fixed / pattern change overwrote, ambiguous pointers that do not resolve
  const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const all = rows.flatMap((r) => r.changes.map((c: Json) => ({ ...c, bundle: r.name })));
  const noops = all.filter((c) => (c.moved_to === undefined || c.moved_to === c.pointer) && same(c.before, c.after));
  const overwrites = all.filter((c) => (c.category === "fixed_pattern" || /\b(?:fixe[sd]|pattern)\b/u.test(c.reason)) && c.before !== null && c.after !== null && c.moved_to === undefined && !same(c.before, c.after) && c.rule !== "bundle-type");
  const bundleType = all.filter((c) => c.rule === "bundle-type" && c.before !== null);
  const ambs = rows.flatMap((r) => r.ambiguous.map((a: Json) => ({ ...a, bundle: r.name })));
  console.log(`changes ${all.length}; no-op ${noops.length}; fixed/pattern overwrites of an existing value ${overwrites.length}; Bundle.type set over an existing type ${bundleType.length}`);
  console.log(`ambiguous ${ambs.length}: pointer unresolved ${ambs.filter((a) => !a.resolves).length}; pointer_out ${ambs.filter((a) => a.pointer_out !== undefined).length} (unresolved in the result ${ambs.filter((a) => a.resolves_out === false).length}); patch_out not applicable ${ambs.filter((a) => a.patches_out_ok === false).length}`);
  if (verbose || noops.length || overwrites.length) {
    for (const c of [...noops, ...overwrites].slice(0, 30)) console.log(`  ${noops.includes(c) ? "no-op" : "overwrite"} ${c.bundle} ${c.rule} ${c.pointer} ${JSON.stringify(c.before).slice(0, 80)} → ${JSON.stringify(c.after).slice(0, 80)} | ${c.reason.slice(0, 120)}`);
    for (const a of ambs.filter((x) => !x.resolves || x.resolves_out === false).slice(0, 20)) console.log(`  unresolved ${a.bundle} ${a.pointer} / ${a.pointer_out ?? "-"} | ${a.message.slice(0, 100)}`);
  }
  const sum = (k: "before" | "after" | "added"): number => cats.reduce((s, c) => s + tot[c][k], 0);
  console.log(`bundles ${rows.length}; structural errors ${sum("before")} → ${sum("after")} (${(100 * (1 - sum("after") / Math.max(1, sum("before")))).toFixed(1)}% fewer); ADDED ${sum("added")}; 0-error bundles ${zeroB} → ${zeroA}; ambiguous items ${amb} (${ambPatched} with a patch)`);
  console.log("category              before  after  added  fixed   remaining flagged");
  for (const c of cats) {
    const t = tot[c];
    console.log(`${c.padEnd(22)}${String(t.before).padStart(6)} ${String(t.after).padStart(6)} ${String(t.added).padStart(6)}  ${(t.before ? ((100 * (t.before - t.after)) / t.before).toFixed(1) + "%" : "-").padStart(6)}   ${c === "other" ? "" : `${t.flagged}/${t.after}`}`);
  }
  if (verbose) {
    console.log("added:", JSON.stringify([...addedTally.keys()].slice(0, 40), null, 1));
    console.log("left (R1 categories):", JSON.stringify([...leftTally].sort((a, b) => b[1] - a[1]).slice(0, 50), null, 1));
  }
  return sum("added");
}

async function main(): Promise<void> {
  if (flag("--worker")) return worker(flag("--worker")!, Number(flag("--start")), Number(flag("--count")));
  const batch = Number(flag("--batch") ?? 10);
  const tmp = join(tmpdir(), `finalize-eval-${process.pid}.jsonl`);
  if (existsSync(tmp)) rmSync(tmp);
  for (let s = 0; s < names.length; s += batch) {
    const r = spawnSync(process.execPath, [...process.execArgv, "--max-old-space-size=2400", process.argv[1], ...args, "--worker", tmp, "--start", String(s), "--count", String(batch)], { stdio: ["ignore", "inherit", verbose ? "inherit" : "ignore"], env: process.env });
    if (r.status !== 0) console.error(`worker for Bundles ${s}..${s + batch - 1} exited ${r.status}`);
  }
  const rows = existsSync(tmp) ? readFileSync(tmp, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const added = report(rows);
  const out = flag("--json");
  if (out) writeFileSync(out, JSON.stringify(rows, null, 1));
  if (existsSync(tmp)) rmSync(tmp);
  process.exit(added ? 1 : 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(2);
});
