/**
 * Latency profile of fhir_validate_resource / fhir_validate_bundle / fhir_normalize_code,
 * in-process against a real database (no HTTP): per call wall time, DB round-trips, and the
 * time spent in the validator's sub-phases (profile walk, structural pass, extension context,
 * StructureDefinition index builds, resolver lookups) and in the suggestion layer.
 *
 * Read-only by construction — pass a connection that forces read-only transactions:
 *
 *   DATABASE_URL='postgresql://mcp:<pw>@<host>:5432/taiwan_health?options=-c%20default_transaction_read_only%3Don' \
 *     node --import tsx scripts/validator-audit/perfProfile.mts [--iters 20] [--group all|resource|bundle|probes|normalize]
 *
 * Corpora: the tracked audit corpus (scripts/validator-audit/corpus) and, when present, the
 * an optional private gold bundle (PERF_GOLD_BUNDLE path, never copied). Sets FHIR_VALIDATE_PROFILE=1
 * so FHIRIGService.validateCore logs its phase breakdown, which this script aggregates.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { gunzipSync } from "node:zlib";

process.env.FHIR_VALIDATE_PROFILE = "1";

const { closePool, initPool, query } = await import("../../src/db.js");
const { FHIRIGService } = await import("../../src/fhirIgService.js");
const { InstanceValidator } = await import("../../src/fhirValidator.js");
const { DbValidatorResolver } = await import("../../src/fhirValidationResolver.js");
const { IgConceptSearch } = await import("../../src/conceptSearch/service.js");

const HERE = new URL(".", import.meta.url).pathname;
/** Repository root (TWH_ROOT when the script runs from a copied tree, e.g. an A/B baseline). */
const ROOT = process.env.TWH_ROOT || join(HERE, "..", "..", "..");
const VERSIONS: Record<string, string> = { "tw.gov.mohw.twcore": "1.0.0", "tw.gov.mohw.nhi.pas": "1.2.7" };

const args = process.argv.slice(2);
const iters = Number(args[args.indexOf("--iters") + 1] || 20);
const group = args.includes("--group") ? args[args.indexOf("--group") + 1] : "all";

// ---------------------------------------------------------------- instrumentation

const timers = new Map<string, { n: number; ms: number }>();
function tick(name: string, ms: number): void {
  const t = timers.get(name) ?? { n: 0, ms: 0 };
  t.n++;
  t.ms += ms;
  timers.set(name, t);
}
function wrap(proto: any, method: string, label = method): void {
  const orig = proto[method];
  if (typeof orig !== "function") throw new Error(`no method ${method}`);
  proto[method] = function (this: any, ...a: any[]) {
    const t0 = performance.now();
    const r = orig.apply(this, a);
    if (r && typeof r.then === "function") return r.finally(() => tick(label, performance.now() - t0));
    tick(label, performance.now() - t0);
    return r;
  };
}
// Validator sub-phases (private methods, patched on the prototype).
wrap(InstanceValidator.prototype, "validateResource", "validator.walk(top)");
wrap(InstanceValidator.prototype, "structuralPass", "validator.structuralPass(top)");
wrap(InstanceValidator.prototype, "checkExtensionContext", "validator.checkExtensionContext");
wrap(InstanceValidator.prototype, "checkConstraints", "validator.checkConstraints");
wrap(InstanceValidator.prototype, "checkBinding", "validator.checkBinding");
wrap(InstanceValidator.prototype, "checkCoding", "validator.checkCoding");
wrap(InstanceValidator.prototype, "checkUri", "validator.checkUri");
wrap(InstanceValidator.prototype, "sdx", "validator.sdx (index lookups)");
for (const m of ["fetchStructureDefinition", "fetchValueSet", "valueSetContains", "checkCode", "definitionExists", "codeSystemResolvable", "codeSystemLocal"]) {
  wrap(DbValidatorResolver.prototype, m, `resolver.${m}`);
}
for (const m of ["fullerCopy", "index", "loadThesaurus", "locate", "search", "nearCodes"]) wrap(IgConceptSearch.prototype, m, `conceptSearch.${m}`);

// DB round-trips: count + time at the pool.
const pgPath = join(ROOT, "node-server", "node_modules", "pg", "lib", "index.js");
const pg = (await import(pgPath)).default;
let dbCalls = 0;
let dbMs = 0;
const sqlCounts = new Map<string, number>();
const origQuery = pg.Pool.prototype.query;
pg.Pool.prototype.query = function (this: any, ...a: any[]) {
  dbCalls++;
  const sql = typeof a[0] === "string" ? a[0] : a[0]?.text;
  if (typeof sql === "string") {
    const k = sql.replace(/\s+/g, " ").slice(0, 90);
    sqlCounts.set(k, (sqlCounts.get(k) ?? 0) + 1);
  }
  const t0 = performance.now();
  const r = origQuery.apply(this, a);
  return r.finally(() => (dbMs += performance.now() - t0));
};

// validateCore phase logs (stderr JSON lines).
const phaseLogs: Array<Record<string, any>> = [];
const origWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = ((chunk: any, ...rest: any[]) => {
  const s = String(chunk);
  if (s.includes('"fhir validation profile"')) {
    for (const line of s.split("\n")) {
      if (!line.includes("fhir validation profile")) continue;
      try {
        phaseLogs.push(JSON.parse(line));
      } catch {
        /* ignore */
      }
    }
    return true;
  }
  return origWrite(chunk, ...rest);
}) as any;

// ---------------------------------------------------------------- corpora

function corpus(name: string): any[] {
  const p = join(HERE, "corpus", `${name}.json.gz`);
  return JSON.parse(gunzipSync(readFileSync(p)).toString("utf8"));
}
/** Optional private gold bundle: PERF_GOLD_BUNDLE=<path to a validate_bundle fixture .input.json>. */
function privateGoldBundle(): Record<string, any> | null {
  const p = process.env.PERF_GOLD_BUNDLE;
  if (!p || !existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")).input.bundle;
}

function quantile(xs: number[], q: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)];
}
const fmt = (x: number): string => x.toFixed(1).padStart(7);

interface Run {
  ms: number;
  db: number;
  dbMs: number;
  issues: number;
  valid: boolean | null;
}

async function measure(label: string, calls: Array<() => Promise<string>>, reps: number): Promise<void> {
  // Warm once (caches), then measure.
  for (const c of calls) await c();
  timers.clear();
  phaseLogs.length = 0;
  sqlCounts.clear();
  const runs: Run[] = [];
  for (let r = 0; r < reps; r++) {
    for (const c of calls) {
      const d0 = dbCalls;
      const m0 = dbMs;
      const t0 = performance.now();
      const raw = await c();
      const ms = performance.now() - t0;
      let issues = 0;
      let valid: boolean | null = null;
      try {
        const env = JSON.parse(raw);
        const data = env.data || {};
        valid = typeof data.valid === "boolean" ? data.valid : null;
        issues = (data.issues || []).length + (data.entries || []).reduce((n: number, e: any) => n + (e.issues || []).length, 0);
      } catch {
        /* normalize envelope etc. */
      }
      runs.push({ ms, db: dbCalls - d0, dbMs: dbMs - m0, issues, valid });
    }
  }
  const ms = runs.map((r) => r.ms);
  const db = runs.map((r) => r.db);
  const n = runs.length;
  console.log(`\n== ${label}: ${calls.length} case(s) x ${reps} rep(s) = ${n} calls`);
  console.log(`   wall ms   avg ${fmt(ms.reduce((a, b) => a + b, 0) / n)}  min ${fmt(Math.min(...ms))}  p50 ${fmt(quantile(ms, 0.5))}  p95 ${fmt(quantile(ms, 0.95))}  max ${fmt(Math.max(...ms))}`);
  console.log(`   db/call   avg ${fmt(db.reduce((a, b) => a + b, 0) / n)}  min ${fmt(Math.min(...db))}  p50 ${fmt(quantile(db, 0.5))}  p95 ${fmt(quantile(db, 0.95))}  max ${fmt(Math.max(...db))}   db ms/call avg ${fmt(runs.reduce((a, r) => a + r.dbMs, 0) / n)}`);
  const inv = runs.filter((r) => r.valid === false).length;
  console.log(`   issues/call avg ${fmt(runs.reduce((a, r) => a + r.issues, 0) / n)}   invalid results ${inv}/${n}`);
  if (phaseLogs.length) {
    const phases = new Map<string, { ms: number; q: number }>();
    for (const l of phaseLogs) {
      for (const [k, v] of Object.entries(l.phases || {})) {
        const p = phases.get(k) ?? { ms: 0, q: 0 };
        p.ms += (v as any).ms;
        p.q += (v as any).queries;
        phases.set(k, p);
      }
    }
    console.log(`   validateCore phases (avg per call over ${phaseLogs.length} validateCore runs):`);
    for (const [k, v] of phases) console.log(`     ${k.padEnd(18)} ${fmt(v.ms / phaseLogs.length)} ms   ${fmt(v.q / phaseLogs.length)} queries`);
  }
  const rows = [...timers.entries()].sort((a, b) => b[1].ms - a[1].ms);
  console.log("   sub-phases (avg per call; nested, so they overlap):");
  for (const [k, v] of rows) console.log(`     ${k.padEnd(40)} ${fmt(v.ms / n)} ms   ${fmt(v.n / n)} calls`);
  const top = [...sqlCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (top.length) {
    console.log("   top SQL (count per call):");
    for (const [k, c] of top) console.log(`     ${fmt(c / n)}  ${k}`);
  }
}

async function main(): Promise<void> {
  initPool({ maxSize: 4 });
  console.log("read-only:", (await query("SHOW default_transaction_read_only")).rows[0]);
  const svc = new FHIRIGService(null);
  const examples = corpus("examples");
  const pick = (key: string): any => examples.find((c) => c.key === key) ?? examples.find((c) => String(c.key).startsWith(key));
  const patient = pick("Patient/pat-example");
  const tw = examples.filter((c) => c.pkg === "tw.gov.mohw.twcore");

  if (group === "all" || group === "resource") {
    await measure("validate_resource: TW Core Patient example", [() => svc.validateResource(patient.res, null, patient.pkg, VERSIONS[patient.pkg])], iters);
    const varied = tw.filter((_, i) => i % 2 === 0).slice(0, 50);
    await measure(
      `validate_resource: ${varied.length} varied TW Core examples`,
      varied.map((c) => () => svc.validateResource(c.res, null, c.pkg, VERSIONS[c.pkg])),
      Math.max(1, Math.round(iters / 10)),
    );
  }
  if (group === "all" || group === "bundle") {
    const gold = privateGoldBundle();
    if (gold) await measure("validate_bundle: private 4-entry gold bundle (clean)", [() => svc.validateBundle(gold, "tw.gov.mohw.twcore", "1.0.0")], iters);
    const bundles = corpus("bundles").filter((c) => c.pkg === "tw.gov.mohw.twcore").slice(0, 10);
    await measure(`validate_bundle: ${bundles.length} generated TW Core bundles`, bundles.map((c) => () => svc.validateBundle(c.res, c.pkg, VERSIONS[c.pkg])), Math.max(1, Math.round(iters / 5)));
  }
  if (group === "all" || group === "probes") {
    const v8 = corpus("v8_probes").filter((c) => c.tool === "bundle");
    await measure(
      `validate_bundle: ${v8.length} v8 probe bundles (with errors)`,
      v8.map((c) => () => svc.validateBundle(c.res, c.pkg, VERSIONS[c.pkg])),
      Math.max(1, Math.round(iters / 10)),
    );
    const v7 = corpus("v7_probes").filter((c) => c.tool !== "bundle");
    await measure(
      `validate_resource: ${v7.length} v7 probe resources (with errors)`,
      v7.map((c) => () => svc.validateResource(c.res, c.profile ?? null, c.pkg, VERSIONS[c.pkg])),
      Math.max(1, Math.round(iters / 10)),
    );
  }
  if (group === "all" || group === "normalize") {
    const calls = [
      () => svc.normalizeCode("Metformin", null, "https://twcore.mohw.gov.tw/ig/twcore/CodeSystem/medication-nhi-tw", null, null, 5),
      () => svc.normalizeCode("Diabetes", null, "http://hl7.org/fhir/sid/icd-10-cm", null, null, 5),
      () => svc.normalizeCode("Hypertension", "http://hl7.org/fhir/ValueSet/condition-code", null, null, null, 5),
    ];
    await measure("normalize_code: 3 targets (no embedding endpoint here)", calls, Math.max(1, Math.round(iters / 2)));
  }
  await closePool();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
