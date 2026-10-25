/**
 * Record-checks dev set (ISSUES_v15): detection on synthetic missing-information cases and new
 * errors (false positives) on complete cases.
 *
 *   node --import tsx scripts/record-checks-eval/run.ts [-v]
 *
 * Sets:
 *   synthetic       synthetic.ts — ≥ 40 A / B / C / R2 variants + complete controls (always present);
 *   complete+record private fixtures (mcp_proposal/, src/grounding/__fixtures__/private/) — gold Bundles
 *                   with their records (R1–R4), plus the 15 TW PAS example Bundles with a generated record;
 *   complete-noRec  private model-output Bundles without a record (v9 valid_bundles, v14 dev_failures): R1 / R2.
 * Private sets are skipped when absent. Record text is never printed — only case ids, paths and codes.
 * Exit 1 when synthetic detection < 90 % or a complete case gets a new error; 0 otherwise.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { collectCodingKeys } from "../../src/grounding/checkGrounding.js";
import { loadPasBundles, pasTerminology } from "../../src/grounding/pasEval.js";
import { renderPasRecord } from "../../src/grounding/pasTestkit.js";
import { runRecordChecks, type RecordIssue } from "../../src/recordChecks/index.js";
import { syntheticCases } from "./synthetic.js";

type Json = Record<string, any>;
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const MP = join(REPO, "mcp_proposal");
const PRIV = join(REPO, "node-server", "src", "grounding", "__fixtures__", "private");
const verbose = process.argv.includes("-v");

interface Case {
  set: string;
  id: string;
  bundle: Json;
  source_text: string | null;
  site_config: string | null;
}

const readJson = (p: string): any => JSON.parse(readFileSync(p, "utf8"));
const asObj = (x: unknown): any => (typeof x === "string" ? JSON.parse(x) : x);

function privateComplete(): Case[] {
  const out: Case[] = [];
  const seen = new Set<string>();
  const push = (c: Case): void => {
    const k = JSON.stringify([c.bundle, c.source_text]);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(c);
  };
  const golden = join(PRIV, "grounding_golden.json");
  if (existsSync(golden)) {
    for (const c of readJson(golden).cases as Json[]) {
      const id = String(c.id);
      // gold Bundles against their own (complete) record: G01–G04, G19 (TWB) and the V_<case>_gold_* variants
      const input = asObj(c.input);
      // informational: a complete (source-case) Bundle against a TWU record that lacks one fact
      if (/^G\d+_TWU-/u.test(id)) {
        push({ set: "twu-info", id, bundle: input.bundle, source_text: input.source_text, site_config: input.site_config ?? null });
        continue;
      }
      if (!/(^G0[1-4]_|^G19_|^V_TWB-\d+_gold_)/u.test(id)) continue;
      push({ set: "complete+record", id, bundle: input.bundle, source_text: input.source_text, site_config: input.site_config ?? null });
    }
  }
  const repro = join(MP, "issues_v1", "repro");
  if (existsSync(repro)) {
    for (const f of readdirSync(repro).filter((x) => x.endsWith(".grounding_input.json")).sort()) {
      const j = readJson(join(repro, f));
      const input = j.input ?? j;
      if (input.bundle && input.source_text) push({ set: "complete+record", id: `v1-${j.case_id ?? f}`, bundle: input.bundle, source_text: input.source_text, site_config: input.site_config ?? null });
    }
  }
  const vbc = join(MP, "fixtures", "validate_bundle_combined");
  if (existsSync(vbc)) {
    for (const f of readdirSync(vbc).filter((x) => /^TWB-.*\.input\.json$/u.test(x))) {
      const input = readJson(join(vbc, f)).input;
      push({ set: "complete+record", id: `vbc-${f}`, bundle: input.bundle, source_text: input.source_text, site_config: input.site_config ?? null });
    }
  }
  return out;
}

async function pasComplete(): Promise<Case[]> {
  const out: Case[] = [];
  const terminology = pasTerminology();
  for (const { key, bundle } of loadPasBundles()) {
    const terms = await terminology.lookup(collectCodingKeys(bundle));
    const r = renderPasRecord(bundle, terms);
    out.push({ set: "pas+record", id: `pas-${key}`, bundle, source_text: r.text, site_config: r.site });
  }
  return out;
}

function privateNoRecord(): Case[] {
  const out: Case[] = [];
  const v9 = join(MP, "issues_v9", "repro_ids", "valid_bundles.json");
  if (existsSync(v9)) for (const r of readJson(v9) as Json[]) out.push({ set: "v9-model-output", id: `v9-${r.id}`, bundle: r.bundle, source_text: null, site_config: null });
  const v14 = join(MP, "issues_v14", "dev_failures");
  if (existsSync(v14)) {
    for (const f of readdirSync(v14).filter((x) => x.endsWith(".json")).sort()) {
      const j = readJson(join(v14, f));
      out.push({ set: "v14-model-output", id: `v14-${j.id ?? f}`, bundle: j.bundle, source_text: null, site_config: null });
    }
  }
  return out;
}

const short = (i: RecordIssue): string => `${i.severity} ${i.code} @ ${i.path}: ${i.message_en.slice(0, 150)}`;

async function main(): Promise<void> {
  let fail = false;
  // ---- synthetic
  const syn = syntheticCases();
  const pos = syn.filter((c) => c.expect);
  let hit = 0;
  const misses: string[] = [];
  const byType = new Map<string, [number, number]>();
  for (const c of pos) {
    const r = runRecordChecks(c.bundle, { sourceText: c.source_text, siteConfig: c.site_config ?? null });
    const ok = r.issues.some((i) => i.code === c.expect!.code && (c.expect!.severity === "warning" || i.severity === "error"));
    const t = byType.get(c.type) ?? [0, 0];
    byType.set(c.type, [t[0] + (ok ? 1 : 0), t[1] + 1]);
    if (ok) hit++;
    else misses.push(`${c.id}: expected ${c.expect!.severity} ${c.expect!.code}; got ${r.issues.map((i) => `${i.severity} ${i.code}`).join(", ") || "nothing"}`);
    if (verbose) for (const i of r.issues) console.log(`  [${c.id}] ${short(i)}`);
  }
  console.log(`synthetic missing-information cases: ${hit}/${pos.length} detected (${((100 * hit) / pos.length).toFixed(1)} %)`);
  for (const [t, [h, n]] of byType) console.log(`  type ${t}: ${h}/${n}`);
  for (const m of misses) console.log(`  MISS ${m}`);
  if (hit / pos.length < 0.9) fail = true;
  const controls = syn.filter((c) => !c.expect);
  for (const c of controls) {
    const r = runRecordChecks(c.bundle, { sourceText: c.source_text, siteConfig: c.site_config ?? null });
    const errs = r.issues.filter((i) => i.severity === "error");
    console.log(`  control ${c.id}: ${errs.length} error(s), ${r.issues.length - errs.length} warning(s)`);
    for (const i of r.issues) console.log(`    ${short(i)}`);
    if (errs.length) fail = true;
  }

  // ---- complete cases
  const noRec = privateNoRecord();
  // the model-output Bundles again, each with a record rendered from its own values (the PAS testkit renderer):
  // a consistent record, so R3 / R4 must not fire unless the Bundle itself is coarse / unconfirmed
  const rendered: Case[] = [];
  const terminology = pasTerminology();
  for (const c of noRec) {
    try {
      const r = renderPasRecord(c.bundle, await terminology.lookup(collectCodingKeys(c.bundle)));
      rendered.push({ ...c, set: `${c.set}+rendered-record`, source_text: r.text, site_config: r.site });
    } catch {
      // renderer does not cover this Bundle
    }
  }
  const sets = [...privateComplete(), ...(await pasComplete()), ...noRec, ...rendered];
  if (!sets.length) console.log("private fixtures absent: only the synthetic set ran");
  const groups = new Map<string, Case[]>();
  for (const c of sets) groups.set(c.set, [...(groups.get(c.set) ?? []), c]);
  for (const [name, cases] of groups) {
    let withErr = 0;
    let warnCount = 0;
    const lines: string[] = [];
    for (const c of cases) {
      const r = runRecordChecks(c.bundle, { sourceText: c.source_text, siteConfig: c.site_config });
      const errs = r.issues.filter((i) => i.severity === "error");
      warnCount += r.issues.length - errs.length;
      if (errs.length) withErr++;
      for (const i of r.issues) if (i.severity === "error" || verbose) lines.push(`    ${c.id}: ${short(i)}`);
    }
    console.log(`${name}: ${cases.length} bundle(s), ${withErr} with a new error (${((100 * withErr) / Math.max(cases.length, 1)).toFixed(1)} %), ${warnCount} warning(s)`);
    for (const l of lines) console.log(l);
    if (!name.startsWith("v14-") && !name.startsWith("v9-") && name !== "twu-info" && withErr) fail = true;
  }
  process.exit(fail ? 1 : 0);
}

void main();
