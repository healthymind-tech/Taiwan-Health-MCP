/**
 * Content-check false-positive harness (ISSUES_v20 R6).
 *
 * IG example Bundles (and every single-resource example, wrapped in a one-entry collection Bundle) are rendered into a
 * synthetic record that states every fact (render.ts), then checked exactly as fhir_validate_bundle does with
 * source_text: fhir_check_grounding (DB terminology names + abbreviations), the coded-element annotation
 * (codeGrounding.ts) and the record checks (lookups incl. fhir_normalize_code candidates for the code-meaning check).
 * Every content ERROR is a false positive by construction; the rate is per fact (checked grounding unit).
 *
 *   DATABASE_URL=… node --import tsx scripts/content-fp/run.ts <package dir>… [--json out.json] [--max N] [-v]
 *
 * A package dir is an unpacked FHIR package (its `example/` folder is read, else the package folder itself). The DB is
 * read-only here (terminology names, IG packages for normalize). The rendered records are synthetic, never clinical.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { closePool, initPool, query as dbQuery } from "../../src/db.js";
import { FHIRIGService } from "../../src/fhirIgService.js";
import { checkGrounding, collectCodingKeys } from "../../src/grounding/checkGrounding.js";
import { createDbTerminologyNames } from "../../src/grounding/terminologyDb.js";
import { annotateGroundingCodes } from "../../src/recordChecks/codeGrounding.js";
import { recordCheckLookups } from "../../src/recordChecks/lookups.js";
import { runRecordChecks } from "../../src/recordChecks/index.js";
import { renderRecord } from "./render.js";

type Json = Record<string, any>;
const args = process.argv.slice(2);
const flag = (n: string): string | null => (args.includes(n) ? args[args.indexOf(n) + 1] : null);
const dirs = args.filter((a, i) => !a.startsWith("-") && !["--json", "--max"].includes(args[i - 1] ?? ""));
const verbose = args.includes("-v");
const max = Number(flag("--max") ?? "100000");

function examples(dir: string): Array<{ name: string; json: Json }> {
  const ex = existsSync(join(dir, "example")) ? join(dir, "example") : dir;
  const out: Array<{ name: string; json: Json }> = [];
  for (const f of readdirSync(ex).filter((x) => x.endsWith(".json")).sort()) {
    try {
      const j = JSON.parse(readFileSync(join(ex, f), "utf8"));
      if (j && typeof j.resourceType === "string") out.push({ name: f, json: j });
    } catch {
      // skip unreadable
    }
  }
  return out;
}

const NON_CLINICAL = new Set(["CapabilityStatement", "StructureDefinition", "ValueSet", "CodeSystem", "ImplementationGuide", "SearchParameter", "OperationDefinition", "ConceptMap", "NamingSystem", "OperationOutcome", "Parameters", "Binary", "Subscription", "MessageDefinition", "Questionnaire"]);

function asBundle(j: Json): Json | null {
  if (j.resourceType === "Bundle") return Array.isArray(j.entry) && j.entry.length ? j : null;
  if (NON_CLINICAL.has(j.resourceType)) return null;
  return { resourceType: "Bundle", type: "collection", entry: [{ fullUrl: `urn:uuid:00000000-0000-4000-8000-${String(Math.abs(hash(JSON.stringify(j)))).padStart(12, "0").slice(0, 12)}`, resource: j }] };
}
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

const pkgOf = (dir: string): [string | null, string | null] => {
  try {
    const p = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    return [p.name ?? null, p.version ?? null];
  } catch {
    return [null, null];
  }
};

async function main(): Promise<void> {
  initPool({ maxSize: 2 });
  const svc = new FHIRIGService(null);
  const terminology = createDbTerminologyNames({ query: async (sql, params) => ({ rows: (await dbQuery(sql, params)).rows as Array<Record<string, unknown>> }) });
  const report: Json = { igs: {} };
  for (const dir of dirs) {
    const [pid, ver] = pkgOf(dir);
    const tally = new Map<string, number>();
    const examplesOut: Json[] = [];
    let facts = 0;
    let bundles = 0;
    let suspects = 0;
    for (const ex of examples(dir).slice(0, max)) {
      const bundle = asBundle(ex.json);
      if (!bundle) continue;
      bundles++;
      const keys = collectCodingKeys(bundle);
      const terms = keys.length ? await terminology.lookup(keys) : new Map();
      const rec = renderRecord(bundle, terms);
      if (!rec.facts) continue;
      facts += rec.facts;
      const g = await checkGrounding({ bundle, source_text: rec.text, package_id: pid, version: ver, verbosity: "warnings" }, { terminology });
      const looked = await recordCheckLookups(bundle, terminology, rec.text, null, {
        normalize: typeof (svc as any).meaningCandidates === "function" ? (text: string, system: string, limit: number) => (svc as any).meaningCandidates(text, system, pid, ver, limit) : null,
      });
      const rules = typeof (svc as any).identifierValueRules === "function" ? await (svc as any).identifierValueRules(bundle, pid, ver).catch(() => null) : null;
      const data: Json = { issues: g.issues, entries: g.entries, grounding: { ...g.grounding } };
      annotateGroundingCodes(data, bundle, rec.text, null, looked.codeNames, looked.codeNamesZh ?? null, looked.codeSlotRelations ?? null);
      const rc = runRecordChecks(bundle, { sourceText: rec.text, identifierRules: rules, ...looked });
      suspects += (looked as Json).meaningCandidates?.size ?? 0;
      const errs: Json[] = [
        ...[...data.issues, ...data.entries.flatMap((e: Json) => e.issues)].filter((i: Json) => i.severity === "error").map((i: Json) => ({ check: `grounding:${i.rule}`, path: i.path, message: String(i.message).slice(0, 220) })),
        ...rc.issues.filter((i) => i.severity === "error").map((i) => ({ check: `record:${i.code}`, path: i.path, message: i.message_en.slice(0, 220) })),
      ];
      for (const e of errs) tally.set(e.check, (tally.get(e.check) ?? 0) + 1);
      if (errs.length) examplesOut.push({ example: ex.name, facts: rec.facts, errors: errs, ...(verbose ? { record: rec.text } : {}) });
    }
    const total = [...tally.values()].reduce((a, b) => a + b, 0);
    report.igs[`${pid}#${ver}`] = {
      bundles,
      facts,
      errors: total,
      fp_rate: facts ? Math.round((total / facts) * 10000) / 100 : 0,
      by_check: Object.fromEntries([...tally.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, { errors: v, per_fact_pct: Math.round((v / Math.max(1, facts)) * 10000) / 100 }])),
      code_meaning_normalized: suspects,
      examples: examplesOut,
    };
    console.log(`${pid}#${ver}: ${bundles} bundles, ${facts} facts, ${total} errors (${report.igs[`${pid}#${ver}`].fp_rate}% of facts)`);
    for (const [k, v] of [...tally.entries()].sort((a, b) => b[1] - a[1])) console.log(`   ${k}: ${v}`);
  }
  const out = flag("--json");
  if (out) writeFileSync(out, JSON.stringify(report, null, 2));
  await closePool();
}

main().catch(async (e) => {
  console.error(e instanceof Error ? e.message : String(e));
  await closePool().catch(() => undefined);
  process.exit(1);
});
