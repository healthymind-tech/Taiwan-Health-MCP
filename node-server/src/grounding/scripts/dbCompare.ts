/**
 * Dev script (not a unit test): compare the DB-backed terminology provider with the reference terminology cache,
 * read-only, against a Postgres you point it at (staging — never production).
 *
 *   cd node-server && GROUNDING_DB_URL=postgresql://mcp:***@127.0.0.1:15432/taiwan_health \
 *     node --import tsx src/grounding/scripts/dbCompare.ts [--names] [--json out.json]
 *
 * The session is forced read-only (default_transaction_read_only = on).
 */
import { writeFileSync } from "node:fs";

import pg from "pg";

import { checkGrounding, type GroundingIssue, type GroundingResult } from "../checkGrounding.js";
import { createDbTerminologyNames } from "../terminologyDb.js";
import { loadFixture, referenceTerminology } from "../testkit.js";

const url = process.env.GROUNDING_DB_URL;
if (!url) {
  console.error("GROUNDING_DB_URL is required");
  process.exit(2);
}
const client = new pg.Client({ connectionString: url });
await client.connect();
await client.query("SET default_transaction_read_only = on");
const db = createDbTerminologyNames({ query: (sql, params) => client.query(sql, params as unknown[]) as any });
const ref = referenceTerminology();
console.log("terminology:", await db.version());

const G = loadFixture("grounding_golden.json");
const MUT = loadFixture("mutation_golden.json");
const cache = loadFixture("terminology_cache.json").codes as Record<string, { found: boolean; names: string[] }>;

// ---- per-code names
const keys = Object.keys(cache).sort();
const dbNames = await db.lookup(keys);
const nameRows: Array<Record<string, unknown>> = [];
let bothFound = 0;
let onlyRef = 0;
let onlyDb = 0;
for (const k of keys) {
  const a = cache[k];
  const b = dbNames.get(k)!;
  if (a.found && b.found) bothFound++;
  else if (a.found) onlyRef++;
  else if (b.found) onlyDb++;
  const added = b.names.filter((n) => !a.names.includes(n));
  const lost = a.names.filter((n) => !b.names.includes(n));
  if (a.found !== b.found || added.length || lost.length) nameRows.push({ key: k, refFound: a.found, dbFound: b.found, added, lost });
}
console.log(`codes ${keys.length}: found in both ${bothFound}, only reference ${onlyRef}, only DB ${onlyDb}; name-set differences ${nameRows.length}`);

// ---- verdict differences
const sig = (r: GroundingResult, sev: "error" | "warning"): string[] =>
  [...new Set([...r.issues, ...r.entries.flatMap((e) => e.issues)].filter((i: GroundingIssue) => i.severity === sev).map((i) => `${i.rule}@${i.path}`))].sort();
const caseRows: Array<Record<string, unknown>> = [];
const inputs: Array<[string, any]> = G.cases.map((c: any) => [c.id, c.input]);
for (const m of MUT.mutations) {
  const base = G.cases.find((c: any) => c.id === `V_${m.case_id}_gold_auto`).input;
  const bundle = structuredClone(base.bundle);
  bundle.entry[m.ei].resource = m.resource;
  inputs.push([`MUT ${m.case_id} ${m.kind} ${m.path}`, { ...base, bundle }]);
}
const times: number[] = [];
let validFlips = 0;
for (const [id, input] of inputs) {
  const a = await checkGrounding({ ...input, verbosity: "all" }, { terminology: ref });
  const t0 = performance.now();
  const b = await checkGrounding({ ...input, verbosity: "all" }, { terminology: db });
  times.push(performance.now() - t0);
  const ea = sig(a, "error");
  const eb = sig(b, "error");
  const wa = sig(a, "warning");
  const wb = sig(b, "warning");
  if (a.valid !== b.valid) validFlips++;
  if (ea.join() !== eb.join() || wa.join() !== wb.join()) {
    const msgs = [...b.issues, ...b.entries.flatMap((e) => e.issues)]
      .filter((i) => (i.severity === "error" && !ea.includes(`${i.rule}@${i.path}`)) || (i.severity === "warning" && !wa.includes(`${i.rule}@${i.path}`)))
      .map((i) => `${i.severity} ${i.rule}@${i.path}: ${i.message.slice(0, 220)}`);
    caseRows.push({
      id,
      validRef: a.valid,
      validDb: b.valid,
      errorsAdded: eb.filter((x) => !ea.includes(x)),
      errorsRemoved: ea.filter((x) => !eb.includes(x)),
      warningsAdded: wb.filter((x) => !wa.includes(x)),
      warningsRemoved: wa.filter((x) => !wb.includes(x)),
      newMessages: msgs,
    });
  }
}
times.sort((x, y) => x - y);
console.log(
  `runs ${inputs.length}: valid flips ${validFlips}, cases with different error/warning sets ${caseRows.length}; DB-provider latency p50 ${times[Math.floor(times.length / 2)].toFixed(1)} ms p95 ${times[Math.floor(0.95 * (times.length - 1))].toFixed(1)} ms max ${times[times.length - 1].toFixed(1)} ms`,
);
for (const r of caseRows) console.log(JSON.stringify(r));
if (process.argv.includes("--names")) for (const r of nameRows) console.log(JSON.stringify(r));
const ji = process.argv.indexOf("--json");
if (ji > 0) writeFileSync(process.argv[ji + 1], JSON.stringify({ nameRows, caseRows }, null, 1));
console.log("lookup stats", db.stats());
await client.end();
