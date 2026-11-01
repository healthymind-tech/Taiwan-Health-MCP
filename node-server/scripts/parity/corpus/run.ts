/**
 * Differential-corpus runner (parity v3): each corpus item (instance + packages + profile + official validator_cli
 * issues, layout detected by corpus/loaders.ts) is validated offline with InstanceValidator over FileValidatorResolver
 * (base layer R4 core + its package closure, no DB, no tx server) and compared on error-level issues
 * (lib/compare.ts: strict / class / count; MCP content checks are dropped with classify.isContentCheck).
 * --repro <dir> writes a minimal repro (lib/minimize.ts) for the first mismatch of each failing item.
 *
 *   systemd-run --user --scope -q -p MemoryMax=2G -p CPUQuota=80% nice -n 15 \
 *     node --max-old-space-size=1800 --import tsx scripts/parity/corpus/run.ts [<corpus dir> (default ~/ref/parity_corpus)] \
 *       [--format repro|dirs|jsonl] [--only id[,id]] [--json out.json] [--repro <dir>] [--limit n] [-v]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { InstanceValidator } from "../../../src/fhirValidator.js";
import { isContentCheck } from "../classify.js";
import { compareIssues, isError, type Comparison, type SimpleIssue } from "../lib/compare.js";
import { FileValidatorResolver, ResourceStore } from "../lib/fileResolver.js";
import { minimize } from "../lib/minimize.js";
import { findPackage, packageClosure, type Res } from "../lib/packages.js";
import { pickLoader, type CorpusItem } from "./loaders.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (k: string): string | null => (args.includes(k) ? args[args.indexOf(k) + 1] ?? null : null);
const valued = new Set(["--format", "--only", "--json", "--repro", "--limit"]);
const positional = args.filter((a, i) => !a.startsWith("-") && !valued.has(args[i - 1] ?? ""));
const dir = positional[0] ?? join(homedir(), "ref", "parity_corpus");
const only = opt("--only")?.split(",") ?? null;
const outFile = opt("--json") ?? join(HERE, "results.json");
const reproDir = opt("--repro");
const limit = Number(opt("--limit") ?? Infinity);
const verbose = args.includes("-v");

const CORE = "hl7.fhir.r4.core#4.0.1";

/** One shared core layer; one store per distinct package list (closures are cached). */
const core = new ResourceStore();
const coreRef = findPackage(CORE);
if (coreRef) core.addPackage(coreRef);
const stores = new Map<string, { store: ResourceStore; missing: string[] }>();
function storeFor(packages: string[]): { store: ResourceStore; missing: string[] } {
  const key = packages.join(",");
  let s = stores.get(key);
  if (!s) {
    const store = new ResourceStore(core);
    const c = packageClosure(packages, { skip: new Set(["hl7.fhir.r4.core"]) });
    for (const p of c.packages) store.addPackage(p);
    s = { store, missing: c.missing };
    stores.set(key, s);
    if (stores.size > 8) stores.delete(stores.keys().next().value!); // bound memory
  }
  return s;
}

interface ItemResult {
  id: string;
  source: string;
  status: "pass" | "fail" | "crash";
  comparison?: Comparison;
  flags: string[];
  missingPackages?: string[];
  error?: string;
  repro?: string;
}

async function validateWith(store: ResourceStore, item: CorpusItem, instance: Res): Promise<{ issues: SimpleIssue[]; resolver: FileValidatorResolver }> {
  const resolver = new FileValidatorResolver(store);
  const issues = await new InstanceValidator(resolver).validate(instance, { profiles: item.profile ? [item.profile] : [] });
  return { issues: issues.map((i) => ({ severity: i.severity, path: i.path, message: i.message, code: i.code })).filter((i) => !isContentCheck(i)), resolver };
}

async function main(): Promise<void> {
  const loader = pickLoader(dir, opt("--format"));
  if (!loader) {
    console.error(`no corpus loader recognises ${dir} (known: repro, dirs, jsonl — add one in corpus/loaders.ts)`);
    process.exit(2);
  }
  console.error(`corpus ${dir} (format ${loader.name})`);
  const results: ItemResult[] = [];
  let n = 0;
  for (const item of loader.load(dir)) {
    if (only && !only.includes(item.id)) continue;
    if (n++ >= limit) break;
    const { store, missing } = storeFor(item.packages);
    const r: ItemResult = { id: item.id, source: item.source, status: "fail", flags: [] };
    if (missing.length) {
      r.missingPackages = missing;
      r.flags.push("missing-package");
    }
    try {
      const { issues, resolver } = await validateWith(store, item, item.instance);
      if (resolver.txLookups) r.flags.push("tx-dependent");
      if (resolver.snapshotless.size) r.flags.push("no-snapshot");
      r.comparison = compareIssues(item.official.filter((i) => !isContentCheck(i)), issues);
      r.status = r.comparison.strict ? "pass" : "fail";
      if (reproDir && !r.comparison.strict) {
        const [kind, key] = r.comparison.extra.length ? (["extra", r.comparison.extra[0]] as const) : (["missing", r.comparison.missing[0]] as const);
        if (key) {
          const [path, ...msg] = key.split(" | ");
          const target = { kind, path, message: msg.join(" | ") };
          const m = await minimize(item.instance, target, async (x) => (await validateWith(store, item, x)).issues);
          if (m.reproduced) {
            const out = join(reproDir, item.id.replace(/[^A-Za-z0-9._-]/g, "_"));
            mkdirSync(out, { recursive: true });
            writeFileSync(join(out, "instance.json"), JSON.stringify(m.instance, null, 1));
            const ours = (await validateWith(store, item, m.instance)).issues.filter(isError);
            writeFileSync(join(out, "meta.json"), JSON.stringify({ packages: item.packages, profile: item.profile, target, steps: m.steps, ours }, null, 1));
            r.repro = out;
          }
        }
      }
    } catch (e) {
      r.status = "crash";
      r.error = String((e as Error).stack ?? e).split("\n").slice(0, 4).join("\n");
    }
    results.push(r);
    if (verbose || only) {
      const c = r.comparison;
      console.log(`${r.id} ${r.status}${c ? ` official=${c.expectedErrors} ours=${c.actualErrors}` : ""}${r.flags.length ? ` flags=${r.flags.join(",")}` : ""}${r.error ? `\n  ${r.error}` : ""}`);
      for (const m of c?.missing ?? []) console.log(`   - MISSING ${m}`);
      for (const m of c?.extra ?? []) console.log(`   + EXTRA   ${m}`);
    }
  }
  const tot = results.length;
  const cnt = (f: (r: ItemResult) => boolean): string => `${results.filter(f).length}/${tot}`;
  console.log(`items ${tot}: strict ${cnt((r) => !!r.comparison?.strict)}, class ${cnt((r) => !!r.comparison?.class)}, count ${cnt((r) => !!r.comparison?.count)}, crash ${cnt((r) => r.status === "crash")}`);
  const tally = (pick: (c: Comparison) => string[]): Array<[string, number]> => {
    const m = new Map<string, number>();
    for (const r of results) for (const k of r.comparison ? pick(r.comparison) : []) m.set(k, (m.get(k) ?? 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1]).slice(0, 20);
  };
  console.log("top missing classes:\n" + tally((c) => c.missingClasses).map(([k, v]) => `  ${String(v).padStart(4)}  ${k}`).join("\n"));
  console.log("top extra classes:\n" + tally((c) => c.extraClasses).map(([k, v]) => `  ${String(v).padStart(4)}  ${k}`).join("\n"));
  writeFileSync(outFile, JSON.stringify({ generated: new Date().toISOString(), corpus: dir, format: loader.name, results }, null, 1));
  console.log(`per-item JSON: ${outFile}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
