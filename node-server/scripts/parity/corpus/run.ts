/**
 * Differential-corpus runner (parity v3): each corpus item (instance + packages + profile + official validator_cli
 * issues, layout detected by corpus/loaders.ts) is validated in process with the TS validator and compared on
 * error-level issues (lib/compare.ts: strict / lenient / class / count; MCP content checks are dropped with
 * classify.isContentCheck). Per item the JSON keeps the official and our error keys (normalised path, classify.errorClass,
 * Java message id) so corpus/report.ts can compute the acceptance metrics and failure buckets over shards.
 *
 * Engines (--engine):
 *  - `db` (default for the `evaluator` layout): FHIRIGService.validateBundle / validateResource exactly as the MCP tools
 *    fhir_validate_bundle / fhir_validate_resource call them (no normalize_ids, `-profile` = the item's profile,
 *    package = the item's IG), over the installed packages in Postgres (DATABASE_URL, read-only queries). The official
 *    validator bridge is switched off (OFFICIAL_VALIDATOR_URLS cleared) so the built-in engine is the judge. A Bundle
 *    root goes to fhir_validate_bundle, any other root to fhir_validate_resource; a tool-level rejection
 *    (INVALID_ARGUMENT …) counts as one error issue at the root ("tool-rejected" flag).
 *  - `file` (default for the other layouts): InstanceValidator over FileValidatorResolver (base layer R4 core + the
 *    package closure from the local package cache, no DB, no tx server).
 *
 * --repro <dir> writes a minimal repro (lib/minimize.ts) for the first mismatch of each failing item, or, with
 * --repro-plan <plan.json> (written by report.ts: [{id, kind, path, message, bucket}]), for exactly the planned targets
 * (class-level match, so a repro keeps the bucket's error class at its location).
 *
 *   PW=$(grep '^POSTGRES_PASSWORD=' ../.env | cut -d= -f2-); DATABASE_URL="postgresql://mcp:$PW@127.0.0.1:5432/taiwan_health" \
 *   systemd-run --user --scope -q -p MemoryMax=3G -p CPUQuota=150% nice -n 10 \
 *     node --max-old-space-size=2500 --import tsx scripts/parity/corpus/run.ts [<corpus dir> (default ~/ref/parity_corpus)] \
 *       [--format evaluator|repro|dirs|jsonl] [--engine db|file] [--only id[,id]] [--json out.json] [--start n] [--count n] [--shard k/n]
 *       [--repro <dir>] [--repro-plan plan.json] [--max-steps n (minimizer budget, default 250)]
 *       [--timeout-ms n (per item, default 180000)] [--exclude-from done.json[,…]] [--crash-only] [--limit n] [-v] [--package id#ver[,id#ver]] [--profile url]
 *       [--raw-text]   (file engine: raw items validated from their text with InstanceValidator.validateText)
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { InstanceValidator } from "../../../src/fhirValidator.js";
import { errorClass, isContentCheck } from "../classify.js";
import { compareIssues, isError, lenientMessage, normMessage, normPath, type Comparison, type SimpleIssue } from "../lib/compare.js";
import { FileValidatorResolver, ResourceStore } from "../lib/fileResolver.js";
import { minimize, type Target } from "../lib/minimize.js";
import { findPackage, packageClosure, type Res } from "../lib/packages.js";
import { pickLoader, type CorpusItem } from "./loaders.js";
import { ResultWriter, readResults } from "./results.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (k: string): string | null => (args.includes(k) ? args[args.indexOf(k) + 1] ?? null : null);
const valued = new Set(["--format", "--only", "--json", "--repro", "--repro-plan", "--limit", "--package", "--profile", "--engine", "--start", "--count", "--shard", "--max-steps", "--timeout-ms", "--exclude-from"]);
const positional = args.filter((a, i) => !a.startsWith("-") && !valued.has(args[i - 1] ?? ""));
const dir = positional[0] ?? join(homedir(), "ref", "parity_corpus");
const outFile = opt("--json") ?? join(HERE, "results.json");
const reproDir = opt("--repro");
const reproPlanFile = opt("--repro-plan");
/** --raw-text (file engine): raw items (family raw-json) are validated from their file text with validateText. */
const rawText = args.includes("--raw-text");
const limit = Number(opt("--limit") ?? Infinity);
const start = Number(opt("--start") ?? 0);
const count = Number(opt("--count") ?? Infinity);
/** --shard k/n: every n-th item from the k-th (balances Bundles, which cluster in the manifest order). */
const [shardK, shardN] = (opt("--shard") ?? "0/1").split("/").map(Number);
const verbose = args.includes("-v");
/** Defaults for items whose layout does not name them (comma-separated package list; one profile). */
const defaultPackages = opt("--package")?.split(",").filter(Boolean) ?? [];
const defaultProfile = opt("--profile");

interface PlanTarget extends Target {
  id: string;
  bucket?: string;
}
const reproPlan: PlanTarget[] | null = reproPlanFile ? (JSON.parse(readFileSync(reproPlanFile, "utf8")) as PlanTarget[]) : null;
const only = opt("--only")?.split(",") ?? (reproPlan ? [...new Set(reproPlan.map((t) => t.id))] : null);

type Validate = (item: CorpusItem, instance: Res) => Promise<{ issues: SimpleIssue[]; flags: string[] }>;

/** --engine file: InstanceValidator over the offline package cache. */
function fileEngine(): Validate {
  const CORE = "hl7.fhir.r4.core#4.0.1";
  const core = new ResourceStore();
  const coreRef = findPackage(CORE);
  if (coreRef) core.addPackage(coreRef);
  const stores = new Map<string, { store: ResourceStore; missing: string[] }>();
  const storeFor = (packages: string[]): { store: ResourceStore; missing: string[] } => {
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
  };
  return async (item, instance) => {
    const { store, missing } = storeFor(item.packages);
    const resolver = new FileValidatorResolver(store);
    const opts = { profiles: item.profile ? [item.profile] : [] };
    // --raw-text: a raw item's file text through validateText (validator_cli's JSON reader), unless minimise() hands
    // over a reduced tree
    const v = new InstanceValidator(resolver);
    const issues = rawText && item.raw?.text !== undefined && instance === item.instance ? await v.validateText(item.raw.text, opts) : await v.validate(instance, opts);
    const flags: string[] = [];
    if (missing.length) flags.push("missing-package");
    if (resolver.txLookups) flags.push("tx-dependent");
    if (resolver.snapshotless.size) flags.push("no-snapshot");
    return { issues: issues.map((i) => ({ severity: i.severity, path: i.path, message: i.message, code: i.code })), flags };
  };
}

/** --engine db: the fhir_validate_bundle / fhir_validate_resource service calls over the installed packages. */
async function dbEngine(): Promise<{ validate: Validate; close: () => Promise<void> }> {
  process.env.OFFICIAL_VALIDATOR_URLS = ""; // the built-in validator is the judge (no validator_cli bridge)
  const { initPool, closePool } = await import("../../../src/db.js");
  const { FHIRIGService } = await import("../../../src/fhirIgService.js");
  initPool({ maxSize: 2 });
  const svc = new FHIRIGService(null);
  const validate: Validate = async (item, instance) => {
    const [pid, ver] = (item.packages[0] ?? "").split("#");
    const isBundle = instance && typeof instance === "object" && instance.resourceType === "Bundle";
    const text = isBundle
      ? await svc.validateBundle(instance, pid || null, ver || null, false, undefined, "ids", null, item.profile)
      : await svc.validateResource(instance, item.profile, pid || null, ver || null);
    const env = JSON.parse(text) as Res;
    if (!env.ok) return { issues: [{ severity: "error", path: String(instance?.resourceType ?? ""), message: `tool error ${env.error?.code}: ${env.error?.message}` }], flags: ["tool-rejected"] };
    const d = env.data ?? {};
    const raw: Res[] = [...(d.issues ?? []), ...((d.entries ?? []) as Res[]).flatMap((e) => e.issues ?? [])];
    const flags: string[] = [];
    if (d.checked_fully === false) flags.push("not-checked-fully");
    if (raw.some((i) => i.code === "exception" || /lookups? failed|internal error/u.test(String(i.message ?? "")))) flags.push("lookup-failure");
    return { issues: raw.map((i) => ({ severity: String(i.severity), path: String(i.path ?? ""), message: String(i.message ?? ""), code: i.code })), flags };
  };
  return { validate, close: closePool };
}

interface ErrKey {
  path: string;
  cls: string;
  msg: string;
  msgid?: string | null;
}

interface ItemResult {
  id: string;
  source: string;
  ig?: string;
  kind?: string;
  family?: string;
  mutation?: string;
  raw?: string;
  status: "pass" | "fail" | "crash" | "skipped";
  skip?: "official-crash" | "raw-unparseable";
  /** validator_cli crashed on this item (manifest status official_crash); our result is still recorded. */
  officialCrash?: boolean;
  comparison?: Comparison;
  /** Official / our error-level issues (content checks dropped), as (normalised path, class, message[, Java id]). */
  officialErrors?: ErrKey[];
  ourErrors?: ErrKey[];
  flags: string[];
  error?: string;
  repro?: string[];
}

/** per-item validation timeout (an item that times out is a harness "crash" — a FAIL for official-crash items). */
const timeoutMs = Number(opt("--timeout-ms") ?? 180_000);
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  return Promise.race([p, new Promise<T>((_, rej) => (t = setTimeout(() => rej(new Error(`timeout after ${ms} ms`)), ms)))]).finally(() => clearTimeout(t));
}
/** --exclude-from a.json[,b.json]: skip ids already compared there (resume / add new corpus items only). */
const excluded = new Set<string>();
for (const f of opt("--exclude-from")?.split(",").filter(Boolean) ?? []) {
  readResults(f, (x) => {
    if (x.comparison || x.skip === "raw-unparseable") excluded.add(String(x.id));
  });
}
const crashOnly = args.includes("--crash-only");

const keyOf = (i: SimpleIssue): ErrKey => ({ path: normPath(i.path), cls: errorClass(normMessage(i.message)), msg: normMessage(i.message), ...(i.messageId !== undefined ? { msgid: i.messageId } : {}) });

async function main(): Promise<void> {
  const loader = pickLoader(dir, opt("--format"));
  if (!loader) {
    console.error(`no corpus loader recognises ${dir} (known: evaluator, repro, dirs, jsonl — add one in corpus/loaders.ts)`);
    process.exit(2);
  }
  const engineName = opt("--engine") ?? (loader.name === "evaluator" ? "db" : "file");
  const db = engineName === "db" ? await dbEngine() : null;
  const validate: Validate = db ? db.validate : fileEngine();
  const ours = async (item: CorpusItem, x: Res): Promise<SimpleIssue[]> => (await validate(item, x)).issues.filter((i) => !isContentCheck(i));
  console.error(`corpus ${dir} (format ${loader.name}, engine ${engineName})`);
  const writer = new ResultWriter(outFile, { generated: new Date().toISOString(), corpus: dir, format: loader.name, engine: engineName, start, count: Number.isFinite(count) ? count : null, shard: `${shardK}/${shardN}` });
  const results: ItemResult[] = [];
  let n = 0;
  let idx = -1;
  for (const item of loader.load(dir)) {
    idx++;
    if (idx < start || idx >= start + count || idx % shardN !== shardK) continue;
    if (only && !only.includes(item.id)) continue;
    if (excluded.has(item.id) || (crashOnly && !item.officialCrash)) continue;
    if (n++ >= limit) break;
    if (!item.packages.length) item.packages = defaultPackages;
    if (!item.profile && defaultProfile) item.profile = defaultProfile;
    const m = item.meta ?? {};
    const r: ItemResult = { id: item.id, source: item.source, status: "fail", flags: [], ...(m.ig ? { ig: m.ig, kind: m.kind, family: m.family, mutation: m.mutation } : {}), ...(item.raw ? { raw: item.raw.parse } : {}) };
    const official = item.official.filter((i) => !isContentCheck(i));
    r.officialErrors = official.filter(isError).map(keyOf);
    // evaluator rule: validator_cli threw on these — TS must answer with >= 1 error (no throw / timeout); validated,
    // marked officialCrash, scored apart by report.ts
    if (item.officialCrash) r.officialCrash = true;
    if (!item.instance && !(rawText && item.raw?.text !== undefined)) {
      r.status = "skipped";
      r.skip = "raw-unparseable";
      if (item.raw?.error) r.error = item.raw.error;
    } else {
      try {
        const v = await withTimeout(validate(item, item.instance), timeoutMs);
        r.flags.push(...v.flags);
        const issues = v.issues.filter((i) => !isContentCheck(i));
        r.ourErrors = issues.filter(isError).map(keyOf);
        r.comparison = compareIssues(official, issues);
        r.status = r.comparison.strict ? "pass" : "fail";
        const targets: Target[] = [];
        if (reproDir && reproPlan) targets.push(...reproPlan.filter((t) => t.id === item.id));
        else if (reproDir && !r.comparison.strict) {
          // target a verdict difference (lenient level) when there is one, else the first wording difference
          const c = r.comparison;
          const [kind, lkey] = c.lenientExtra.length ? (["extra", c.lenientExtra[0]] as const) : c.lenientMissing.length ? (["missing", c.lenientMissing[0]] as const) : c.extra.length ? (["extra", c.extra[0]] as const) : (["missing", c.missing[0]] as const);
          const pool = kind === "extra" ? c.extra : c.missing;
          const key = pool.find((k) => k.split(" | ")[0] === lkey?.split(" | ")[0] && lenientMessage(k.split(" | ").slice(1).join(" | ")) === lkey?.split(" | ").slice(1).join(" | ")) ?? lkey;
          if (key) {
            const [path, ...msg] = key.split(" | ");
            targets.push({ kind, path, message: msg.join(" | ") });
          }
        }
        for (const target of targets) {
          const mm = await minimize(item.instance, target, (x) => ours(item, x), { maxSteps: Number(opt("--max-steps") ?? 250) });
          if (!mm.reproduced) {
            r.flags.push(`repro-not-reproduced:${target.kind}`);
            continue;
          }
          const bucket = (target as PlanTarget).bucket;
          const name = `${String(bucket ?? "").replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80)}${bucket ? "__" : ""}${item.id.replace(/[^A-Za-z0-9._-]/g, "_")}`;
          const out = join(reproDir!, name);
          mkdirSync(out, { recursive: true });
          writeFileSync(join(out, "instance.json"), JSON.stringify(mm.instance, null, 1));
          const after = (await ours(item, mm.instance)).filter(isError);
          writeFileSync(
            join(out, "meta.json"),
            JSON.stringify({ id: item.id, bucket, packages: item.packages, profile: item.profile, engine: engineName, family: m.family, mutation: m.mutation, mutation_path: m.mutation_path, target, steps: mm.steps, official_errors_full_item: official.filter(isError), ours_after: after }, null, 1),
          );
          (r.repro ??= []).push(out);
        }
      } catch (e) {
        r.status = "crash";
        r.error = String((e as Error).stack ?? e).split("\n").slice(0, 4).join("\n");
      }
    }
    writer.add(r);
    results.push(r);
    if (verbose || only) {
      const c = r.comparison;
      console.log(`${r.id} ${r.status}${r.skip ? ` (${r.skip})` : ""}${c ? ` official=${c.expectedErrors} ours=${c.actualErrors}` : ""}${r.flags.length ? ` flags=${r.flags.join(",")}` : ""}${r.error ? `\n  ${r.error}` : ""}`);
      for (const k of c?.missing ?? []) console.log(`   - MISSING ${k}`);
      for (const k of c?.extra ?? []) console.log(`   + EXTRA   ${k}`);
    }
    // on disk now: only the summary below reads the item from here on
    delete r.officialErrors;
    delete r.ourErrors;
    if (r.comparison) {
      r.comparison.missing = [];
      r.comparison.extra = [];
    }
    if (results.length % 200 === 0) console.error(`… ${results.length} items`);
  }
  const done = results.filter((r) => r.comparison);
  const tot = done.length;
  const cnt = (f: (r: ItemResult) => boolean): string => `${done.filter(f).length}/${tot}`;
  console.log(
    `items ${results.length} (compared ${tot}, official-crash ${results.filter((r) => r.officialCrash).length}, raw-unparseable ${results.filter((r) => r.skip === "raw-unparseable").length}): ` +
      `strict ${cnt((r) => !!r.comparison?.strict)}, lenient ${cnt((r) => !!r.comparison?.lenient)}, class ${cnt((r) => !!r.comparison?.class)}, count ${cnt((r) => !!r.comparison?.count)}, crash ${results.filter((r) => r.status === "crash").length}`,
  );
  const cls = (k: string): string => errorClass(k.split(" | ").slice(1).join(" | "));
  const tally = (pick: (c: Comparison) => string[]): Array<[string, number]> => {
    const mp = new Map<string, number>();
    for (const r of done) for (const k of pick(r.comparison!)) mp.set(k, (mp.get(k) ?? 0) + 1);
    return [...mp].sort((a, b) => b[1] - a[1]).slice(0, 20);
  };
  console.log("top missing classes:\n" + tally((c) => c.lenientMissing.map(cls)).map(([k, v]) => `  ${String(v).padStart(4)}  ${k}`).join("\n"));
  console.log("top extra classes:\n" + tally((c) => c.lenientExtra.map(cls)).map(([k, v]) => `  ${String(v).padStart(4)}  ${k}`).join("\n"));
  writer.close();
  console.log(`per-item JSON: ${outFile}`);
  if (db) await db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
