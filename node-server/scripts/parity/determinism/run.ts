/**
 * Determinism regression (parity v3, large-Bundle non-determinism; pre-deploy gate): the validator must give byte-identical
 * results for the same input on every run. The largest corpus Bundle of each IG (<corpus>/<ig>/manifest.jsonl) and
 * synthetic document Bundles (synthetic.ts, default 100 / 500 / 1000 entries) are validated repeatedly in every mode, and
 * the canonical output (issues in their order, checked_fully and every other field of the tool result) must be the same
 * string across all runs and modes. On a difference the first differing issue is printed and the exit code is 1.
 *
 * Modes (each `--runs` validations per Bundle, default 20):
 *   sequential   one after another
 *   concurrent4  four at a time, the same Bundle object
 *   tiny         every cache forced to one entry / weight 1 (setCacheLimits), so everything is evicted constantly
 *   expired      TTL 0, four at a time: no cache entry survives, the request pin is the only thing that holds
 *   mixed4       all the Bundles interleaved four at a time (state leaking between different validations)
 *
 * Engines: `db` (default when DATABASE_URL is set): FHIRIGService.validateBundle exactly as fhir_validate_bundle calls it, on
 * the installed packages (read-only queries), official validator bridge off; `file`: InstanceValidator over the local package
 * cache (no DB: the DB caches are not exercised). Synthetic Bundles run against hl7.fhir.r4.core#4.0.1.
 *
 *   npm run test:determinism                                    (DATABASE_URL set; exit 1 on any difference)
 *   node --import tsx scripts/parity/determinism/run.ts [--corpus dir] [--runs n] [--sizes 100,500,1000] [--modes a,b]
 *     [--engine db|file] [--no-corpus] [--only substring] [--timing 100,500,1000,2000] [--md out.md]
 *
 * --timing prints time against entries (whole validation + Bundle rules: reference resolution and reachability) with the
 * growth exponent between sizes, and skips the determinism runs unless --runs is given too.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { InstanceValidator, completenessOf, isValid } from "../../../src/fhirValidator.js";
import { setCacheLimits } from "../../../src/fhirValidationSnapshot.js";
import { FileValidatorResolver, ResourceStore } from "../lib/fileResolver.js";
import { findPackage, packageClosure } from "../lib/packages.js";
import { syntheticBundle } from "./synthetic.js";

type Json = Record<string, any>;
const args = process.argv.slice(2);
const opt = (k: string): string | null => (args.includes(k) ? args[args.indexOf(k) + 1] ?? null : null);
const list = (k: string, dflt: string): string[] => (opt(k) ?? dflt).split(",").filter(Boolean);

const corpusDir = opt("--corpus") ?? join(homedir(), "ref", "parity_corpus");
const timingSizes = opt("--timing") ? list("--timing", "").map(Number) : null;
const runs = Number(opt("--runs") ?? (timingSizes ? 0 : 20));
const sizes = list("--sizes", "100,500,1000").map(Number);
const modes = list("--modes", "sequential,concurrent4,tiny,expired,mixed4");
const useCorpus = !args.includes("--no-corpus");
const engineName = opt("--engine") ?? (process.env.DATABASE_URL ? "db" : "file");
const mdOut = opt("--md");
const only = opt("--only");

interface Item {
  id: string;
  packageId: string;
  version: string;
  profile: string | null;
  bundle: Json;
}

const CORE = { packageId: "hl7.fhir.r4.core", version: "4.0.1" };

/** The largest parseable Bundle of each IG in the corpus. */
function corpusItems(): Item[] {
  if (!useCorpus || !existsSync(corpusDir)) return [];
  const out: Item[] = [];
  for (const ig of readdirSync(corpusDir).sort()) {
    const manifest = join(corpusDir, ig, "manifest.jsonl");
    if (!existsSync(manifest)) continue;
    let best: { row: Json; size: number; file: string } | null = null;
    for (const line of readFileSync(manifest, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const row = JSON.parse(line) as Json;
      if (row.raw === true || row.status === "crash") continue;
      const file = join(corpusDir, ig, `${row.id}.json`);
      if (!existsSync(file)) continue;
      const size = statSync(file).size;
      if (!best || size > best.size) best = { row, size, file };
    }
    if (!best) continue;
    const bundle = JSON.parse(readFileSync(best.file, "utf8")) as Json;
    if (bundle.resourceType !== "Bundle") continue;
    const [packageId, version] = String(best.row.package).split("#");
    out.push({ id: `${ig}/${best.row.id} (${bundle.entry?.length ?? 0} entries)`, packageId, version, profile: best.row.profile ?? null, bundle });
  }
  return out;
}

type Validate = (item: Item) => Promise<string>;

/** Canonical text of one result: the whole tool result. */
function canonical(env: Json): string {
  return JSON.stringify(env);
}

async function dbEngine(): Promise<{ validate: Validate; close: () => Promise<void> }> {
  process.env.OFFICIAL_VALIDATOR_URLS = ""; // the built-in validator is the judge
  const { closePool, initPool } = await import("../../../src/db.js");
  const { FHIRIGService } = await import("../../../src/fhirIgService.js");
  initPool({ maxSize: 4 });
  const svc = new FHIRIGService(null);
  return {
    validate: async (item) => canonical(JSON.parse(await svc.validateBundle(item.bundle, item.packageId, item.version, false, undefined, "ids", null, item.profile))),
    close: closePool,
  };
}

function fileEngine(): { validate: Validate; close: () => Promise<void> } {
  const core = new ResourceStore();
  const ref = findPackage(`${CORE.packageId}#${CORE.version}`);
  if (ref) core.addPackage(ref);
  const stores = new Map<string, ResourceStore>();
  const storeFor = (key: string): ResourceStore => {
    let s = stores.get(key);
    if (!s) {
      s = new ResourceStore(core);
      if (!key.startsWith(CORE.packageId)) for (const p of packageClosure([key], { skip: new Set([CORE.packageId]) }).packages) s.addPackage(p);
      stores.set(key, s);
    }
    return s;
  };
  return {
    validate: async (item) => {
      const v = new InstanceValidator(new FileValidatorResolver(storeFor(`${item.packageId}#${item.version}`)));
      const issues = await v.validate(item.bundle, { profiles: item.profile ? [item.profile] : [] });
      return canonical({ valid: isValid(issues), ...completenessOf(issues), issues });
    },
    close: async () => undefined,
  };
}

// --------------------------------------------------------------------------- //
// Comparison
// --------------------------------------------------------------------------- //

const sha = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 16);

function issuesOf(env: Json): Json[] {
  const d = env.data ?? env;
  return [...(d.issues ?? []), ...((d.entries ?? []) as Json[]).flatMap((e) => e.issues ?? [])];
}

/** The first difference between two canonical results, as text. */
function firstDifference(a: string, b: string): string {
  const ea = JSON.parse(a) as Json;
  const eb = JSON.parse(b) as Json;
  const ia = issuesOf(ea);
  const ib = issuesOf(eb);
  for (let i = 0; i < Math.max(ia.length, ib.length); i++) {
    if (JSON.stringify(ia[i]) !== JSON.stringify(ib[i])) {
      return `issue #${i} of ${ia.length} / ${ib.length}\n  reference: ${JSON.stringify(ia[i])?.slice(0, 600)}\n  this run : ${JSON.stringify(ib[i])?.slice(0, 600)}`;
    }
  }
  let at = 0;
  while (at < a.length && a[at] === b[at]) at++;
  return `no issue differs; first different byte ${at}\n  reference: …${a.slice(Math.max(0, at - 120), at + 200)}\n  this run : …${b.slice(Math.max(0, at - 120), at + 200)}`;
}

interface Row {
  item: string;
  mode: string;
  runs: number;
  distinct: number;
  ms: number;
}

async function pool<T>(tasks: Array<() => Promise<T>>, width: number): Promise<T[]> {
  const out: T[] = new Array(tasks.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < tasks.length) {
      const i = next++;
      out[i] = await tasks[i]();
    }
  };
  await Promise.all(Array.from({ length: width }, worker));
  return out;
}

async function determinism(items: Item[], validate: Validate): Promise<{ rows: Row[]; failed: boolean }> {
  const reference = new Map<string, string>();
  const rows: Row[] = [];
  let failed = false;
  const check = (item: Item, mode: string, text: string): boolean => {
    const ref = reference.get(item.id);
    if (ref === undefined) {
      reference.set(item.id, text);
      return true;
    }
    if (ref === text) return true;
    if (!failed) console.error(`DIFFERENCE ${item.id} [${mode}]: ${firstDifference(ref, text)}`);
    failed = true;
    return false;
  };
  const record = (item: string, mode: string, n: number, texts: Set<string>, t0: number): void => {
    const row = { item, mode, runs: n, distinct: texts.size, ms: Math.round(performance.now() - t0) };
    rows.push(row);
    const ref = reference.get(item);
    const d = ref ? ((JSON.parse(ref) as Json).data ?? JSON.parse(ref)) as Json : null;
    console.log(`${item} [${mode}] ${n} runs, ${texts.size} distinct, ${row.ms} ms${d ? `, valid ${d.valid}, checked_fully ${d.checked_fully}, ${JSON.stringify({ i: d.invariants_unchecked, l: d.limits_exceeded, f: d.lookups_failed })}, sha ${sha(ref!)}` : ""}`);
  };
  for (const mode of modes) {
    if (mode === "mixed4") continue;
    setCacheLimits(mode === "tiny" ? { maxEntries: 1, maxWeight: 1 } : mode === "expired" ? { ttlMs: -1 } : {});
    const width = mode === "concurrent4" || mode === "expired" ? 4 : 1;
    for (const item of items) {
      const t0 = performance.now();
      const seen = new Set<string>();
      const texts = await pool(Array.from({ length: runs }, () => () => validate(item)), width);
      for (const text of texts) {
        seen.add(sha(text));
        check(item, mode, text);
      }
      record(item.id, mode, runs, seen, t0);
    }
    setCacheLimits({});
  }
  if (modes.includes("mixed4")) {
    const t0 = performance.now();
    const queue: Item[] = [];
    for (let r = 0; r < runs; r++) for (const item of items) queue.push(item);
    const texts = await pool(queue.map((item) => () => validate(item)), 4);
    const seen = new Set<string>();
    texts.forEach((text, i) => {
      seen.add(`${queue[i].id}:${sha(text)}`);
      check(queue[i], "mixed4", text);
    });
    record(`all ${items.length} Bundles`, "mixed4", queue.length, seen, t0);
    const expected = items.length;
    if (seen.size !== expected) failed = true;
  }
  return { rows, failed };
}

// --------------------------------------------------------------------------- //
// Timing
// --------------------------------------------------------------------------- //

/** Time of the Bundle rules alone (reference resolution, interlinks, reachability) on an already warm definition cache. */
async function rulesMs(bundle: Json): Promise<number> {
  const store = new ResourceStore();
  const ref = findPackage(`${CORE.packageId}#${CORE.version}`);
  if (ref) store.addPackage(ref);
  const engine = new InstanceValidator(new FileValidatorResolver(store)) as any;
  const issues: Json[] = [];
  await engine.sdx("http://hl7.org/fhir/StructureDefinition/Patient");
  const ctx = engine.bundleCtx(bundle);
  const t = performance.now();
  await engine.validateBundleRules(ctx, "Bundle", issues);
  for (const e of ctx.raw as Json[]) {
    const r = e.resource as Json | null;
    if (!r) continue;
    const refs = JSON.stringify(r).match(/"reference":"[^"]+"/gu) ?? [];
    for (const m of refs) engine.getFromBundle(ctx, m.slice(13, -1), e.fullUrl, null, "Bundle");
  }
  return performance.now() - t;
}

async function timing(validate: Validate): Promise<string> {
  const lines = ["| entries | validate (ms) | exp | Bundle rules (ms) | exp |", "|---|---|---|---|---|"];
  let prev: { n: number; all: number; rules: number } | null = null;
  const exponent = (a: number, b: number, n0: number, n1: number): string => (a > 0 && b > 0 ? (Math.log(b / a) / Math.log(n1 / n0)).toFixed(2) : "-");
  // warm the definition caches first: the table is about entries, not cold loads
  await validate({ id: "warm", ...CORE, profile: null, bundle: syntheticBundle(20) });
  for (const n of timingSizes ?? []) {
    const bundle = syntheticBundle(n);
    const item: Item = { id: `synthetic-${n}`, ...CORE, profile: null, bundle };
    const t = performance.now();
    await validate(item);
    const all = performance.now() - t;
    const rules = await rulesMs(bundle);
    lines.push(`| ${n} | ${Math.round(all)} | ${prev ? exponent(prev.all, all, prev.n, n) : ""} | ${rules.toFixed(1)} | ${prev ? exponent(prev.rules, rules, prev.n, n) : ""} |`);
    prev = { n, all, rules };
    console.log(lines[lines.length - 1]);
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const { validate, close } = engineName === "db" ? await dbEngine() : fileEngine();
  const md: string[] = [`engine ${engineName}, runs ${runs} per mode, modes ${modes.join(" ")}`];
  let failed = false;
  if (runs > 0) {
    const items: Item[] = [...corpusItems(), ...sizes.map((n) => ({ id: `synthetic-${n}`, ...CORE, profile: null, bundle: syntheticBundle(n) }))].filter((i) => !only || i.id.includes(only));
    const r = await determinism(items, validate);
    failed = r.failed;
    md.push("", "| Bundle | mode | runs | distinct results | ms |", "|---|---|---|---|---|");
    for (const row of r.rows) md.push(`| ${row.item} | ${row.mode} | ${row.runs} | ${row.distinct} | ${row.ms} |`);
    const total = r.rows.reduce((s, x) => s + x.runs, 0);
    console.log(failed ? `FAIL: results differ (${total} validations)` : `PASS: ${items.length} Bundles, ${total} validations, modes ${modes.join(" ")}: byte-identical`);
    md.push("", failed ? `FAIL (${total} validations)` : `PASS: ${items.length} Bundles, ${total} validations byte-identical`);
  }
  if (timingSizes) md.push("", await timing(validate));
  if (mdOut) writeFileSync(mdOut, md.join("\n") + "\n");
  await close();
  process.exit(failed ? 1 : 0);
}

await main();
