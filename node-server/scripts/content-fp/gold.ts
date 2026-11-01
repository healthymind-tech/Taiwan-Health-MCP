/**
 * Content-gate precision harness on REALISTIC records (ISSUES_v20.1 item 2).
 *
 * Runs the content half of the fhir_validate_bundle pipeline with source_text (grounding in auto mode, as
 * fhir_release_check calls it, + coded-element annotation + record checks, the same collaborators mcp.ts passes) over
 *   - gold Bundles with their records (every content ERROR there is a false positive), and
 *   - negative cases whose expected findings are known (fabricated / mutated values: an expected finding is a true
 *     positive),
 * and prints per rule: errors on gold (FP), expected hits on negatives (TP), precision, n, the gate the registry gives
 * (contentGates.ts) and how many gold Bundles a BLOCKING finding stops (before = every error blocks, after = gate).
 *
 * The inputs are PRIVATE clinical evaluation data and are read in place, never copied: the untracked mcp_proposal/
 * fixtures and node-server/src/grounding/__fixtures__/private (absent on a plain checkout → exit 2). The PAS hand
 * records (src/grounding/pasHandRecords.ts, tracked, test-only) are always included. Output is counts and rule names
 * only — no record text, no values.
 *
 *   DATABASE_URL=… node --import tsx scripts/content-fp/gold.ts [--root <checkout with the private fixtures>] [--json out.json] [-v]
 *
 * The DB is read-only (terminology names, IG packages). -v adds rule@path per finding (still no record text).
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { closePool, initPool } from "../../src/db.js";
import { FHIRIGService } from "../../src/fhirIgService.js";
import { addBundleGrounding, dbTerminologyNames } from "../../src/groundingTools.js";
import { dbIgDefinedValues } from "../../src/igBlueprint/tools.js";
import { loadPasBundles } from "../../src/grounding/pasEval.js";
import { HAND_RECORDS, handBundle } from "../../src/grounding/pasHandRecords.js";
import { contentGateOf, isValuePath } from "../../src/recordChecks/contentGates.js";
import { addRecordChecksToValidation } from "../../src/recordChecks/envelope.js";
import { recordCheckLookups } from "../../src/recordChecks/lookups.js";

type Json = Record<string, any>;
const args = process.argv.slice(2);
const flag = (n: string): string | null => (args.includes(n) ? args[args.indexOf(n) + 1] : null);
const verbose = args.includes("-v");

// the private fixtures live in the main checkout (a worktree has no untracked files): --root <repo checkout>
const REPO = resolve(flag("--root") ?? resolve(import.meta.dirname, "../../.."));
const FX = join(REPO, "mcp_proposal/fixtures");
const NFX = join(REPO, "node-server/src/grounding/__fixtures__/private");
const V1 = join(REPO, "mcp_proposal/issues_v1/repro");

interface Case {
  id: string;
  kind: "gold" | "negative";
  bundle: Json;
  source_text: string;
  site_config: string | null;
  package_id: string | null;
  version: string | null;
  /** negative cases: expected findings as (rule, path prefix) — a finding matching one is a TP */
  expected?: Array<{ rule?: string; path: string }>;
}

const jload = (p: string): Json => JSON.parse(readFileSync(p, "utf8"));

function corpus(): Case[] {
  const out: Case[] = [];
  const golden = jload(join(NFX, "grounding_golden.json"));
  const byId = new Map<string, Json>(golden.cases.map((c: Json) => [c.id, c]));
  const base = (inp: Json) => ({ bundle: inp.bundle, source_text: inp.source_text, site_config: inp.site_config ?? null, package_id: inp.package_id ?? null, version: inp.version ?? null });
  for (const cid of golden.gold_cases as string[]) {
    const c = byId.get(`V_${cid}_gold_auto`);
    if (c) out.push({ id: cid, kind: "gold", ...base(c.input) });
    // the same gold Bundle with its record flattened (one line, no section layout): still fully supported
    const f = byId.get(`V_${cid}_flattened_auto`);
    if (f && f.expected?.data?.valid === true) out.push({ id: `${cid}~flat`, kind: "gold", ...base(f.input) });
  }
  if (existsSync(V1)) {
    for (const f of readdirSync(V1).filter((x) => x.endsWith(".grounding_input.json")).sort()) {
      const d = jload(join(V1, f));
      if (out.some((c) => c.id === d.case_id)) continue;
      out.push({ id: String(d.case_id), kind: "gold", ...base(d.input) });
    }
  }
  const pas = loadPasBundles();
  for (const h of HAND_RECORDS) out.push({ id: h.id, kind: "gold", bundle: handBundle(pas, h) as Json, source_text: h.text, site_config: h.site, package_id: null, version: null });
  // negatives: the grounding fixtures that expect errors
  for (const f of readdirSync(join(FX, "grounding")).filter((x) => /^G\d+.*\.input\.json$/u.test(x)).sort()) {
    const x = jload(join(FX, "grounding", f));
    const exp = jload(join(FX, "grounding", f.replace(".input.", ".expected.")))["assert"];
    if (!Array.isArray(exp.errors) || !exp.errors.length) continue;
    out.push({ id: x.fixture, kind: "negative", ...base(x.input), expected: exp.errors.map((e: [string, string]) => ({ path: e[1] })) });
  }
  // negatives: recorded single-value mutations of the gold Bundles (an error at the mutated entry is a TP)
  const mut = jload(join(NFX, "mutation_golden.json"));
  for (const [k, m] of (mut.mutations as Json[]).entries()) {
    const g = out.find((c) => c.id === m.case_id && c.kind === "gold");
    if (!g) continue;
    const bundle = structuredClone(g.bundle);
    if (!Array.isArray(bundle.entry) || !bundle.entry[m.ei]) continue;
    bundle.entry[m.ei].resource = m.resource;
    out.push({ ...g, id: `${m.case_id}#mut${k}`, kind: "negative", bundle, expected: [{ path: `Bundle.entry[${m.ei}]` }] });
  }
  return out;
}

const svc = new FHIRIGService(null);
const terminology = dbTerminologyNames();
const deps = { terminology, packageProvenance: async () => null, logger: null, igDefined: (root: Json, pid: string | null, ver: string | null) => dbIgDefinedValues(root, pid, ver).catch(() => null) } as any;

/** Content issues exactly as fhir_validate_bundle(source_text) produces them (conformance stubbed to 0 issues). */
async function contentIssues(c: Case): Promise<Json[]> {
  const entries = (c.bundle.entry ?? []).filter((e: Json) => e && e.resource).map((e: Json) => ({ fullUrl: e.fullUrl ?? null, resourceType: e.resource.resourceType, valid: true, issues: [] }));
  const conformance = JSON.stringify({ ok: true, data: { valid: true, source: "stub", issues: [], entries } });
  const igDefined = await deps.igDefined(c.bundle, c.package_id, c.version);
  const grounded = await addBundleGrounding(conformance, c.bundle, { source_text: c.source_text, site_config: c.site_config, package_id: c.package_id, version: c.version, ig_defined: igDefined }, deps);
  const looked = await recordCheckLookups(c.bundle, terminology, c.source_text, c.site_config, { normalize: (text: string, system: string, limit: number) => (svc as any).meaningCandidates(text, system, c.package_id, c.version, limit) });
  const profileElements = await (svc as any).profileElementUse(c.bundle, c.package_id, c.version).catch(() => null);
  const identifierRules = await (svc as any).identifierValueRules(c.bundle, c.package_id, c.version).catch(() => null);
  const text = addRecordChecksToValidation(grounded, c.bundle, { sourceText: c.source_text, siteConfig: c.site_config, profileElements, igDefined, identifierRules, ...looked });
  const data = JSON.parse(text).data as Json;
  return [...(data.issues ?? []), ...(data.entries ?? []).flatMap((e: Json) => e.issues ?? [])].filter((i: Json) => i.source === "grounding" || i.source === "record-checks");
}

/** Rule key; the value rules are split into value-bearing paths and coded elements (their gates differ). */
const ruleOf = (i: Json): string => {
  if (i.source === "record-checks") return `record:${i.code}`;
  if (i.rule === "G-UNGROUNDED" || i.rule === "G-VALUE-MISMATCH") return `grounding:${i.rule}${isValuePath(String(i.path ?? "")) ? "" : "(coded)"}`;
  return `grounding:${i.rule}`;
};

async function main(): Promise<void> {
  if (![join(NFX, "grounding_golden.json"), join(NFX, "mutation_golden.json"), join(FX, "grounding")].every(existsSync)) {
    console.error("gold.ts: private fixtures not present (mcp_proposal/fixtures, src/grounding/__fixtures__/private)");
    process.exit(2);
  }
  initPool({ maxSize: 2 });
  const cases = corpus();
  const rules = new Map<string, { fp: number; tp: number; unjudged: number; goldBundles: Set<string> }>();
  const row = (r: string) => rules.get(r) ?? (rules.set(r, { fp: 0, tp: 0, unjudged: 0, goldBundles: new Set() }), rules.get(r)!);
  const goldErrs = new Map<string, Set<string>>();
  let goldBlockedBefore = 0;
  let goldBlockedAfter = 0;
  const detail: Json[] = [];
  for (const c of cases) {
    let issues: Json[];
    try {
      issues = await contentIssues(c);
    } catch (e) {
      console.error(`${c.id}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    const errs = issues.filter((i) => i.severity === "error");
    if (c.kind === "gold") {
      goldErrs.set(c.id, new Set(errs.map((i) => `${ruleOf(i)}@${i.path}`)));
      if (errs.length) goldBlockedBefore++;
      if (errs.some((i) => (i.gate ?? contentGateOf(i)) === "blocking")) goldBlockedAfter++;
      for (const i of errs) {
        const r = row(ruleOf(i));
        r.fp++;
        r.goldBundles.add(c.id);
      }
      if (verbose) detail.push({ case: c.id, kind: c.kind, errors: errs.map((i) => `${ruleOf(i)}@${i.path} [${i.gate ?? contentGateOf(i)}]`) });
    } else {
      const baseId = c.id.split("#")[0];
      const known = goldErrs.get(baseId) ?? new Set<string>();
      for (const i of errs) {
        const key = `${ruleOf(i)}@${i.path}`;
        if (known.has(key)) continue; // already counted as a gold FP
        const hit = (c.expected ?? []).some((e) => (!e.rule || e.rule === i.rule) && String(i.path ?? "").startsWith(e.path));
        if (hit) row(ruleOf(i)).tp++;
        else row(ruleOf(i)).unjudged++;
      }
      if (verbose) detail.push({ case: c.id, kind: c.kind, errors: errs.map((i) => `${ruleOf(i)}@${i.path}`) });
    }
  }
  const gold = cases.filter((c) => c.kind === "gold").length;
  console.log(`cases: ${gold} gold, ${cases.length - gold} negative`);
  console.log(`gold Bundles with a content error (before gates): ${goldBlockedBefore}/${gold}; with a BLOCKING one: ${goldBlockedAfter}/${gold}`);
  console.log("rule\tFP(gold)\tgoldBundles\tTP(neg)\tunjudged\tprecision\tn\tgate");
  const table: Json[] = [];
  for (const [r, v] of [...rules.entries()].sort((a, b) => b[1].fp + b[1].tp - (a[1].fp + a[1].tp))) {
    const n = v.tp + v.fp;
    const prec = n ? Math.round((v.tp / n) * 1000) / 10 : null;
    const [src, key] = r.split(":");
    const code = key.replace("(coded)", "");
    const path = key.endsWith("(coded)") ? "Bundle.entry[0].resource.code" : "Bundle.entry[0].resource.valueQuantity.value";
    const gate = contentGateOf(src === "record" ? { source: "record-checks", code, severity: "error", path } : { source: "grounding", rule: code, severity: "error", path });
    table.push({ rule: r, fp: v.fp, gold_bundles: v.goldBundles.size, tp: v.tp, unjudged: v.unjudged, precision: prec, n, gate });
    console.log(`${r}\t${v.fp}\t${v.goldBundles.size}\t${v.tp}\t${v.unjudged}\t${prec ?? "-"}\t${n}\t${gate}`);
  }
  const out = flag("--json");
  if (out) writeFileSync(out, JSON.stringify({ gold, negative: cases.length - gold, goldBlockedBefore, goldBlockedAfter, rules: table, ...(verbose ? { detail } : {}) }, null, 2));
  await closePool();
}

main().catch(async (e) => {
  console.error(e instanceof Error ? e.message : String(e));
  await closePool().catch(() => undefined);
  process.exit(1);
});
