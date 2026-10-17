/**
 * Survey every ElementDefinition.constraint expression reachable when
 * validating against an IG (its full dependency closure, including
 * hl7.fhir.r4.core) and classify the FHIRPath functions they use:
 *
 *  - supported by fhirpath.js (engine invocation table)
 *  - supplied by our fhirPath.ts user table (resolve, memberOf, htmlChecks, ...)
 *  - deliberately unevaluable (conformsTo -> information, never error)
 *  - UNKNOWN (would throw "Not implemented" -> also caught as unevaluable)
 *
 * Also counts parse failures. An unevaluable invariant is reported by the
 * validator as `information` / `invariant-unevaluated` (fhirValidator.ts
 * checkConstraints), so no row here can turn into an error.
 *
 *   DATABASE_URL=postgresql://... node --import tsx scripts/validator-audit/surveyConstraints.ts [out.json]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { initPool, closePool, query } from "../../src/db.js";
import { FHIRIGService } from "../../src/fhirIgService.js";
import { closureArrays } from "../../src/fhirTerminology.js";

const require = createRequire(import.meta.url);
const fhirpath: any = require("fhirpath");

/** Keys of fhirpath.js's engine.invocationTable (read from its source; it is not exported). */
function engineFunctions(): Set<string> {
  const src = readFileSync(require.resolve("fhirpath/src/fhirpath.js"), "utf8");
  const start = src.indexOf("engine.invocationTable = {");
  const end = src.indexOf("\n};", start);
  const out = new Set<string>();
  for (const m of src.slice(start, end).matchAll(/^\s{2}"?([A-Za-z_][\w]*)"?\s*:/gm)) out.add(m[1]);
  return out;
}

// Mirrors USER_FUNCTIONS in src/fhirPath.ts.
const OURS = new Set(["resolve", "memberOf", "htmlChecks", "as", "startsWith", "endsWith", "contains", "matches"]);
const UNEVALUABLE = new Set(["conformsTo"]);

function functionsOf(ast: any, out: Set<string>): void {
  if (!ast || typeof ast !== "object") return;
  if (ast.type === "FunctionInvocation" && typeof ast.text === "string") out.add(ast.text);
  for (const c of ast.children || []) functionsOf(c, out);
}

const TARGETS: Array<[string, string]> = [
  ["tw.gov.mohw.twcore", "1.0.0"],
  ["tw.gov.mohw.nhi.pas", "1.2.7"],
];

async function main(): Promise<void> {
  initPool({ maxSize: 2 });
  const svc: any = new FHIRIGService(null);
  const engine = engineFunctions();
  const report: Record<string, any> = { engineFunctionCount: engine.size, targets: {} };
  for (const [pid, ver] of TARGETS) {
    const pkg = await svc.resolve(pid, ver);
    const [pids, pvers] = closureArrays(pkg);
    const rows = (
      await query<{ raw_json: any; package_id: string; package_version: string; canonical_url: string; ord: number }>(
        "SELECT a.raw_json, a.package_id, a.package_version, a.canonical_url, dep.ord FROM fhir.artifacts a " +
          "JOIN unnest($1::text[], $2::text[]) WITH ORDINALITY AS dep(pid, pver, ord) " +
          "  ON a.package_id = dep.pid AND a.package_version = dep.pver " +
          "WHERE a.resource_type = 'StructureDefinition' ORDER BY dep.ord",
        [pids, pvers],
      )
    ).rows;
    // First package in closure order wins for a canonical (same as the resolver).
    const seenSd = new Set<string>();
    const exprs = new Map<string, { key: string; expression: string; packages: Set<string>; uses: number }>();
    let constraintUses = 0;
    for (const r of rows) {
      if (seenSd.has(r.canonical_url)) continue;
      seenSd.add(r.canonical_url);
      const sd = typeof r.raw_json === "string" ? JSON.parse(r.raw_json) : r.raw_json;
      for (const el of sd?.snapshot?.element || []) {
        for (const c of el.constraint || []) {
          if (!c.expression || c.key === "ele-1") continue;
          constraintUses++;
          const k = `${c.key}\u0000${c.expression}`;
          let e = exprs.get(k);
          if (!e) exprs.set(k, (e = { key: c.key, expression: String(c.expression), packages: new Set(), uses: 0 }));
          e.packages.add(r.package_id);
          e.uses++;
        }
      }
    }
    const byFn = new Map<string, number>();
    const parseErrors: any[] = [];
    const unknown: any[] = [];
    const unevaluable: any[] = [];
    for (const e of exprs.values()) {
      const fns = new Set<string>();
      try {
        functionsOf(fhirpath.parse(e.expression), fns);
      } catch (err) {
        parseErrors.push({ key: e.key, expression: e.expression, packages: [...e.packages] });
        continue;
      }
      for (const f of fns) byFn.set(f, (byFn.get(f) || 0) + 1);
      const unk = [...fns].filter((f) => !engine.has(f) && !OURS.has(f) && !UNEVALUABLE.has(f));
      if (unk.length) unknown.push({ key: e.key, expression: e.expression, functions: unk, packages: [...e.packages] });
      if ([...fns].some((f) => UNEVALUABLE.has(f))) unevaluable.push({ key: e.key, expression: e.expression, packages: [...e.packages] });
    }
    report.targets[`${pid}#${ver}`] = {
      closure: pids.map((p, i) => `${p}#${pvers[i]}`),
      structureDefinitions: seenSd.size,
      constraintUses,
      distinctConstraints: exprs.size,
      parseErrors,
      unknownFunctionConstraints: unknown,
      deliberatelyUnevaluable: unevaluable,
      functionsUsed: Object.fromEntries(
        [...byFn.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([f, n]) => [f, { constraints: n, source: engine.has(f) ? (OURS.has(f) ? "ours(override)" : "fhirpath.js") : OURS.has(f) ? "ours" : UNEVALUABLE.has(f) ? "unevaluable->information" : "UNKNOWN" }]),
      ),
    };
  }
  const out = process.argv[2];
  if (out) writeFileSync(out, JSON.stringify(report, null, 1));
  for (const [t, r] of Object.entries<any>(report.targets)) {
    console.log(
      `${t}: closure=${r.closure.length} pkgs, SDs=${r.structureDefinitions}, constraint uses=${r.constraintUses}, distinct=${r.distinctConstraints}, ` +
        `parseErrors=${r.parseErrors.length}, unknownFn=${r.unknownFunctionConstraints.length}, unevaluable(conformsTo)=${r.deliberatelyUnevaluable.length}`,
    );
    for (const u of r.unknownFunctionConstraints) console.log("   UNKNOWN", u.key, u.functions.join(","), "|", u.expression.slice(0, 160));
    for (const u of r.parseErrors) console.log("   PARSE", u.key, "|", u.expression.slice(0, 160));
    for (const u of r.deliberatelyUnevaluable) console.log("   UNEVAL", u.key, "|", u.expression.slice(0, 160));
    console.log("   functions:", Object.entries<any>(r.functionsUsed).map(([f, v]) => `${f}(${v.constraints}${v.source === "fhirpath.js" ? "" : "," + v.source})`).join(" "));
  }
  await closePool();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
