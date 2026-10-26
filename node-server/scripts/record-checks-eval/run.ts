/**
 * Record-checks dev set (ISSUES_v15): detection on synthetic missing-information cases and new
 * errors (false positives) on complete cases.
 *
 *   node --import tsx scripts/record-checks-eval/run.ts [-v]
 *
 * Sets:
 *   synthetic       synthetic.ts — ≥ 40 A / B / C / R2 variants + complete controls (always present);
 *   synthetic v15.1 synthetic151.ts — ≥ 80 missing-information variants in the six miss classes (identity, date,
 *                   quantity, medication, diagnosis, structure) + other-time-point values, and complete controls
 *                   for the derivations that must stay grounded (always present);
 *                   (incl. ≥ 15 R6 cases: a wrong ROC ↔ Gregorian conversion must get the record's date as replace_value);
 *   synthetic v15.3 synthetic153.ts — ≥ 40 cases of the three v15.3 forms (A: absence statements in CodeableConcept.text /
 *                   dose text; B: text results where the code needs a number; C: provisional / differential / text-only
 *                   primary diagnosis while the record's slot is unestablished) and ≥ 20 complete controls (correct
 *                   differential r/o secondaries, text-only codes in complete records, qualitative text results);
 *   grounding codes (R3) every set with a record: fhir_check_grounding run on it (offline terminology snapshots), merged
 *                   into a validation envelope and passed through the record-check envelope — counts how many
 *                   coded-element G-UNGROUNDED / G-VALUE-MISMATCH errors stay errors vs become warnings;
 *   mutations       private: the recorded single-value mutations of the gold Bundles (date / identifier /
 *                   quantity / dose mutations must get a record-check error at their entry);
 *   v9+real-record  private: the v9 model-output Bundles whose case record is available (completeness / grounding
 *                   fixtures) — real model outputs on complete records, the closest offline stand-in for the
 *                   evaluator's complete-case set;
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
import { syntheticV151Cases } from "./synthetic151.js";
import { syntheticV153Cases, syntheticV153CodeCases } from "./synthetic153.js";
import { checkGroundingSync } from "../../src/grounding/checkGrounding.js";
import { mergeGroundingIntoValidation } from "../../src/grounding/merge.js";
import { addRecordChecksToValidation } from "../../src/recordChecks/envelope.js";
import type { TermRecord } from "../../src/grounding/terminologyNames.js";

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

/** Real records by case id (TWB-xxx): completeness "a" fixtures and the gold grounding inputs. */
function recordsByCase(): Map<string, { source_text: string; site_config: string | null }> {
  const out = new Map<string, { source_text: string; site_config: string | null }>();
  const comp = join(MP, "fixtures", "completeness");
  if (existsSync(comp)) {
    for (const f of readdirSync(comp).filter((x) => /^C\d+a_(TWB-\d+)\.input\.json$/u.test(x))) {
      const id = /(TWB-\d+)/u.exec(f)![1];
      const input = readJson(join(comp, f)).input;
      out.set(id, { source_text: input.source_text, site_config: input.site_config ?? null });
    }
  }
  const golden = join(PRIV, "grounding_golden.json");
  if (existsSync(golden)) {
    for (const c of readJson(golden).cases as Json[]) {
      const m = /^V_(TWB-\d+)_gold_auto$/u.exec(String(c.id));
      if (!m || out.has(m[1])) continue;
      const input = asObj(c.input);
      out.set(m[1], { source_text: input.source_text, site_config: input.site_config ?? null });
    }
  }
  return out;
}

function v9WithRealRecords(): Case[] {
  const v9 = join(MP, "issues_v9", "repro_ids", "valid_bundles.json");
  if (!existsSync(v9)) return [];
  const recs = recordsByCase();
  const out: Case[] = [];
  for (const r of readJson(v9) as Json[]) {
    const m = /\/(TWB-\d+)\//u.exec(String(r.id));
    const rec = m ? recs.get(m[1]) : undefined;
    if (rec) out.push({ set: "v9-model-output+real-record", id: `v9-${r.id}`, bundle: r.bundle, source_text: rec.source_text, site_config: rec.site_config });
  }
  return out;
}

interface MutationCase {
  id: string;
  kind: string;
  ei: number;
  path: string;
  bundle: Json;
  source_text: string;
  site_config: string | null;
}

function mutationCases(): MutationCase[] {
  const mf = join(PRIV, "mutation_golden.json");
  const golden = join(PRIV, "grounding_golden.json");
  if (!existsSync(mf) || !existsSync(golden)) return [];
  const gold = new Map<string, Json>();
  for (const c of readJson(golden).cases as Json[]) {
    const m = /^V_(TWB-\d+)_gold_auto$/u.exec(String(c.id));
    if (m) gold.set(m[1], asObj(c.input));
  }
  const out: MutationCase[] = [];
  for (const [k, m] of (readJson(mf).mutations as Json[]).entries()) {
    const base = gold.get(String(m.case_id));
    if (!base) continue;
    const bundle = structuredClone(base.bundle);
    const ei = Number(m.ei);
    bundle.entry[ei].resource = asObj(m.resource);
    out.push({ id: `mut-${k}-${m.case_id}-${m.kind}`, kind: String(m.kind), ei, path: String(m.path), bundle, source_text: base.source_text, site_config: base.site_config ?? null });
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

/** Offline terminology: the reference terminology cache + the PAS snapshot (fixtures; absent → empty). */
function groundingTerms(): Map<string, TermRecord> {
  const out = new Map<string, TermRecord>();
  const tc = join(PRIV, "terminology_cache.json");
  if (existsSync(tc)) for (const [k, v] of Object.entries(readJson(tc).codes as Record<string, Json>)) out.set(k, { found: !!v.found, names: v.names ?? [] });
  const pt = join(REPO, "node-server", "src", "grounding", "__fixtures__", "pas_terminology.json");
  if (existsSync(pt)) {
    const j = readJson(pt);
    for (const [k, v] of Object.entries((j.codes ?? j) as Record<string, Json>)) if (v && typeof v === "object" && !out.has(k)) out.set(k, { found: !!v.found, names: v.names ?? [] });
  }
  return out;
}

/** Grounding (auto mode) → validation envelope → record-check envelope; counts of coded-element grounding issues. */
function codeGrounding(c: Case, terms: Map<string, TermRecord>): { examined: number; warnings: number; errors: number; kept: string[] } {
  const none = { examined: 0, warnings: 0, errors: 0, kept: [] as string[] };
  let g;
  try {
    g = checkGroundingSync({ bundle: c.bundle, source_text: c.source_text as string, site_config: c.site_config, mode: "auto" } as never, terms);
  } catch {
    return none;
  }
  const entries = (Array.isArray(c.bundle.entry) ? c.bundle.entry : []).filter((e: Json) => e && e.resource).map((e: Json) => ({ fullUrl: e.fullUrl ?? null, resourceType: e.resource.resourceType, valid: true, issues: [] }));
  const merged = mergeGroundingIntoValidation({ valid: true, issues: [], entries }, g);
  const text = JSON.stringify({ ok: true, data: merged, warnings: [], provenance: {} });
  const codeNames = new Map<string, string[]>();
  for (const k of collectCodingKeys(c.bundle)) if (terms.get(k)?.names.length) codeNames.set(k, terms.get(k)!.names);
  const out = JSON.parse(addRecordChecksToValidation(text, c.bundle, { sourceText: c.source_text, siteConfig: c.site_config, codeNames }));
  const st = out.data?.record_checks?.grounding_codes;
  if (!st) return none;
  const kept: string[] = [];
  for (const e of [{ issues: out.data.issues }, ...(out.data.entries ?? [])])
    for (const i of e.issues ?? []) if (i.source === "grounding" && i.grounding_code_check === "contradicted") kept.push(`${i.path} (closest ${i.closest_record_phrase?.similarity ?? "-"})`);
  return { ...st, kept };
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

  // ---- synthetic v15.1
  const v151 = syntheticV151Cases();
  const vpos = v151.filter((c) => c.expect);
  const byCls = new Map<string, [number, number]>();
  let vhit = 0;
  for (const c of vpos) {
    const r = runRecordChecks(c.bundle, { sourceText: c.source_text, siteConfig: c.site_config });
    const ok = r.issues.some(
      (i) =>
        c.expect!.codes.includes(i.code) &&
        (c.expect!.severity === "warning" || i.severity === "error") &&
        // R6: the correction the record determines must be offered — all candidates, the best first
        (!c.suggest || (JSON.stringify((i.suggestions ?? []).map((x) => x.value).sort()) === JSON.stringify([...c.suggest].sort()) && i.suggestions![0].value === c.suggest[0] && i.suggestions!.every((x) => x.kind === "replace_value" && x.patch?.op === "replace" && x.patch.path === i.path))),
    );
    const t = byCls.get(c.cls) ?? [0, 0];
    byCls.set(c.cls, [t[0] + (ok ? 1 : 0), t[1] + 1]);
    if (ok) vhit++;
    else console.log(`  MISS v15.1 ${c.id}: expected ${c.expect!.severity} ${c.expect!.codes.join("|")}; got ${r.issues.map((i) => `${i.severity} ${i.code}`).join(", ") || "nothing"}`);
    if (verbose) for (const i of r.issues) console.log(`  [${c.id}] ${short(i)}`);
  }
  console.log(`synthetic v15.1 missing-information cases: ${vhit}/${vpos.length} detected (${((100 * vhit) / vpos.length).toFixed(1)} %)`);
  for (const [t, [h, n]] of byCls) console.log(`  class ${t}: ${h}/${n}`);
  if (vhit / vpos.length < 0.9) fail = true;
  const vctl = v151.filter((c) => !c.expect);
  let vctlErr = 0;
  for (const c of vctl) {
    const r = runRecordChecks(c.bundle, { sourceText: c.source_text, siteConfig: c.site_config });
    const errs = r.issues.filter((i) => i.severity === "error");
    if (errs.length) vctlErr++;
    for (const i of r.issues) if (i.severity === "error" || verbose) console.log(`    control ${c.id}: ${short(i)}`);
  }
  console.log(`synthetic v15.1 complete controls: ${vctl.length}, ${vctlErr} with an error`);
  if (vctlErr) fail = true;

  // ---- synthetic v15.3
  const v153 = syntheticV153Cases();
  const tpos = v153.filter((c) => c.expect);
  const byForm = new Map<string, [number, number]>();
  let thit = 0;
  for (const c of tpos) {
    const r = runRecordChecks(c.bundle, { sourceText: c.source_text, siteConfig: c.site_config, codeAxes: c.codeAxes ?? null });
    const ok = r.issues.some((i) => c.expect!.includes(i.code) && i.severity === "error");
    const t = byForm.get(c.form) ?? [0, 0];
    byForm.set(c.form, [t[0] + (ok ? 1 : 0), t[1] + 1]);
    if (ok) thit++;
    else console.log(`  MISS v15.3 ${c.id}: expected error ${c.expect!.join("|")}; got ${r.issues.map((i) => `${i.severity} ${i.code}`).join(", ") || "nothing"}`);
    if (verbose) for (const i of r.issues) console.log(`  [${c.id}] ${short(i)}`);
  }
  console.log(`synthetic v15.3 missing-information cases: ${thit}/${tpos.length} detected (${((100 * thit) / tpos.length).toFixed(1)} %)`);
  for (const [t, [h, n]] of byForm) console.log(`  form ${t}: ${h}/${n}`);
  if (thit / tpos.length < 0.9) fail = true;
  const tctl = v153.filter((c) => !c.expect);
  let tctlErr = 0;
  for (const c of tctl) {
    const r = runRecordChecks(c.bundle, { sourceText: c.source_text, siteConfig: c.site_config, codeAxes: c.codeAxes ?? null });
    const errs = r.issues.filter((i) => i.severity === "error");
    if (errs.length) tctlErr++;
    for (const i of r.issues) if (i.severity === "error" || verbose) console.log(`    control v15.3 ${c.id}: ${short(i)}`);
  }
  console.log(`synthetic v15.3 complete controls: ${tctl.length}, ${tctlErr} with an error`);
  if (tctlErr) fail = true;
  // R3: coded-element grounding issues through the envelope
  let r3ok = 0;
  const r3 = syntheticV153CodeCases();
  for (const c of r3) {
    const g = checkGroundingSync({ bundle: c.bundle, source_text: c.source_text, site_config: null, mode: "auto" } as never, c.terms as never);
    const entries = c.bundle.entry.map((e: Json) => ({ fullUrl: e.fullUrl, resourceType: e.resource.resourceType, valid: true, issues: [] }));
    const env = JSON.stringify({ ok: true, data: mergeGroundingIntoValidation({ valid: true, issues: [], entries }, g), warnings: [] });
    const out = JSON.parse(addRecordChecksToValidation(env, c.bundle, { sourceText: c.source_text, codeNames: new Map([...c.terms].map(([k, v]) => [k, v.names])) }));
    const path = `Bundle.entry[${c.entry}].resource.${c.element}`;
    const iss = (out.data.entries[c.entry]?.issues ?? []).filter((i: Json) => i.source === "grounding" && i.path === path && /G-UNGROUNDED|G-VALUE-MISMATCH/u.test(i.rule));
    const ok = c.expect === "error" ? iss.some((i: Json) => i.severity === "error" && i.closest_record_phrase !== undefined) : iss.every((i: Json) => i.severity !== "error");
    if (ok) r3ok++;
    else console.log(`  MISS R3 ${c.id}: expected ${c.expect}; got ${iss.map((i: Json) => `${i.severity} ${i.rule} ${i.grounding_code_check ?? ""}`).join(", ") || "no grounding issue"}`);
    if (verbose) for (const i of iss) console.log(`  [${c.id}] ${i.severity} ${i.grounding_code_check}: ${String(i.message).slice(0, 220)}`);
  }
  console.log(`synthetic v15.3 R3 coded grounding cases: ${r3ok}/${r3.length} as expected (${r3.filter((c) => c.expect === "warning").length} reworded / plausible → warning, ${r3.filter((c) => c.expect === "error").length} contradicted → error)`);
  if (r3ok !== r3.length) fail = true;

  // ---- recorded single-value mutations of the gold Bundles (positives for value grounding)
  const muts = mutationCases();
  if (muts.length) {
    const VALUE_KINDS = new Set(["date", "identifier", "quantity", "dose"]);
    const per = new Map<string, [number, number]>();
    for (const m of muts) {
      const r = runRecordChecks(m.bundle, { sourceText: m.source_text, siteConfig: m.site_config });
      const ok = r.issues.some((i) => i.severity === "error" && i.path.startsWith(`Bundle.entry[${m.ei}]`));
      const t = per.get(m.kind) ?? [0, 0];
      per.set(m.kind, [t[0] + (ok ? 1 : 0), t[1] + 1]);
      if (!ok && VALUE_KINDS.has(m.kind)) console.log(`  MISS mutation ${m.id} @ ${m.path}`);
    }
    const vk = [...per].filter(([k]) => VALUE_KINDS.has(k));
    const vh = vk.reduce((a, [, [h]]) => a + h, 0);
    const vn = vk.reduce((a, [, [, n]]) => a + n, 0);
    console.log(`gold mutations (value kinds date / identifier / quantity / dose): ${vh}/${vn} detected by the record checks; per kind: ${[...per].map(([k, [h, n]]) => `${k} ${h}/${n}`).join(", ")}`);
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
  const sets = [...privateComplete(), ...(await pasComplete()), ...v9WithRealRecords(), ...noRec, ...rendered];
  if (!sets.length) console.log("private fixtures absent: only the synthetic set ran");
  const groups = new Map<string, Case[]>();
  for (const c of sets) groups.set(c.set, [...(groups.get(c.set) ?? []), c]);
  const terms = groundingTerms();
  const codeTotals = { examined: 0, warnings: 0, errors: 0 };
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
    // R3: coded-element grounding issues after the envelope (only sets with a record)
    const g = { examined: 0, warnings: 0, errors: 0 };
    const gl: string[] = [];
    for (const c of cases) {
      if (!c.source_text) continue;
      const st = codeGrounding(c, terms);
      g.examined += st.examined;
      g.warnings += st.warnings;
      g.errors += st.errors;
      for (const l of st.kept) gl.push(`    ${c.id}: kept error ${l}`);
    }
    if (g.examined) {
      console.log(`  grounding codes (R3): ${g.examined} coded G-UNGROUNDED / G-VALUE-MISMATCH issue(s): ${g.warnings} warning(s), ${g.errors} error(s) after the envelope`);
      for (const l of gl) console.log(l);
      if (!name.startsWith("twu-")) {
        codeTotals.examined += g.examined;
        codeTotals.warnings += g.warnings;
        codeTotals.errors += g.errors;
      }
    }
    // model outputs (v9 / v14) may carry real problems; twu-info records lack a fact by design; rendered records do not
    // render every element (encounter identifiers, timing bounds): reported for inspection, never a failure
    if (!name.startsWith("v14-") && !name.startsWith("v9-") && name !== "twu-info" && name !== "pas+record" && withErr) fail = true;
  }
  if (codeTotals.examined) console.log(`grounding codes (R3), complete sets: ${codeTotals.examined} coded issue(s) → ${codeTotals.warnings} warning(s), ${codeTotals.errors} error(s)`);
  process.exit(fail ? 1 : 0);
}

void main();
