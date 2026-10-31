/**
 * ISSUES_v17.2 — skeleton / grounding / record checks agree on IG-defined values, on the real packages
 * (TWPAS 1.2.7, TW Core 1.0.0 from FHIR_PACKAGE_CACHE; skipped when absent):
 *   1. every resource profile: its minimal skeleton (record placeholders removed) put into a Bundle and
 *      grounded against an unrelated record — no grounding or record-check value issue on an ig-constant;
 *   2. the IGs' own example Bundles (valid under validator_cli): no such issue on an IG-defined value —
 *      and without the exemption the payer agency's name / OID are reported (the bug being fixed).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { minimalSkeleton } from "./skeleton.js";
import { igDefinedValues } from "./igValues.js";
import { availableClosure, fileBlueprintDeps, pkgDir, TWCORE_CLOSURE, TWPAS_CLOSURE } from "./fileDeps.test.js";
import type { BlueprintDeps } from "./common.js";
import { checkGrounding } from "../grounding/checkGrounding.js";
import { allLeaves, isIgDefined, type IgDefinedValues } from "../grounding/igDefined.js";
import { runRecordChecks, valueAt } from "../recordChecks/index.js";
import { syntheticTerminology } from "../grounding/testkit.js";

type R = Record<string, any>;

const PAS = availableClosure(TWPAS_CLOSURE);
const TWC = availableClosure(TWCORE_CLOSURE);
const pasDeps = PAS ? fileBlueprintDeps(PAS) : null;
const twcDeps = TWC ? fileBlueprintDeps(TWC) : null;

const RECORD = "門診病歷\n主訴：頭痛三天。\n診斷：緊張型頭痛。\nP: Acetaminophen 500mg 1# PO QID 3 天。";
const VALUE_CODES = new Set(["G-UNGROUNDED", "G-CONTEXT", "G-CONTEXT-LABEL", "G-CONTEXT-NEGATED", "G-CONTEXT-SECTION", "G-CONTEXT-HISTORICAL", "G-CONTEXT-SITE", "G-CONTEXT-INSTRUCTION", "G-VALUE-MISMATCH", "G-VALUE-WEAK", "G-VALUE-PRECISION", "G-QUOTE-NOT-FOUND", "G-STATED-ABSENT", "ungrounded-value", "information-absent", "value-from-other-event"]);

function resourceProfiles(spec: string): string[] {
  const dir = pkgDir(spec);
  if (!dir) return [];
  return readdirSync(dir)
    .filter((f) => f.startsWith("StructureDefinition-") && f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as R)
    .filter((sd) => sd.kind === "resource" && sd.derivation === "constraint" && sd.type !== "Bundle" && sd.abstract !== true)
    .map((sd) => String(sd.url))
    .sort();
}

/** The skeleton without record placeholders (`<...>` strings) and the containers they leave empty. */
function stripPlaceholders(v: unknown): unknown {
  if (typeof v === "string") return v.startsWith("<") && v.endsWith(">") ? undefined : v;
  if (Array.isArray(v)) {
    const out = v.map(stripPlaceholders).filter((x) => x !== undefined);
    return out.length ? out : undefined;
  }
  if (v && typeof v === "object") {
    const out: R = {};
    for (const [k, x] of Object.entries(v)) {
      const y = stripPlaceholders(x);
      if (y !== undefined) out[k] = y;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return v;
}

const bundleOf = (...resources: R[]): R => ({
  resourceType: "Bundle",
  type: "collection",
  entry: resources.map((r, i) => ({ fullUrl: `urn:uuid:00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, resource: r })),
});

/** Grounding + record-check value issues (errors and warnings) on IG-defined values. */
async function issuesOnIgValues(bundle: R, defs: IgDefinedValues | null, judge: IgDefinedValues): Promise<string[]> {
  const g = await checkGrounding({ bundle, source_text: RECORD, ig_defined: defs }, { terminology: syntheticTerminology() });
  const out: string[] = [];
  for (const i of [...g.issues, ...g.entries.flatMap((e) => e.issues)]) {
    if (i.severity === "information" || !VALUE_CODES.has(i.rule)) continue;
    if (isIgDefined(valueAt(bundle, i.path), judge, i.path)) out.push(`${i.rule} ${i.path}`);
  }
  for (const i of runRecordChecks(bundle, { sourceText: RECORD, igDefined: defs }).issues) {
    if (!VALUE_CODES.has(i.code)) continue;
    if (isIgDefined(valueAt(bundle, i.path), judge, i.path)) out.push(`${i.code} ${i.path}`);
  }
  return out;
}

async function skeletonConsistency(deps: BlueprintDeps, spec: string): Promise<{ profiles: number; constants: number }> {
  let profiles = 0;
  let constants = 0;
  const failures: string[] = [];
  for (const url of resourceProfiles(spec)) {
    let sk;
    try {
      sk = await minimalSkeleton({ profile: url }, deps);
    } catch {
      continue;
    }
    const leaves = new Set((sk.igConstants ?? []).flatMap((c) => allLeaves(c.value)));
    if (!leaves.size) continue;
    const resource = stripPlaceholders((sk.data as R).skeleton) as R | undefined;
    if (!resource?.resourceType) continue;
    profiles++;
    constants += sk.igConstants!.length;
    const bundle = bundleOf(resource);
    const defs = await igDefinedValues(bundle, deps, { packageId: null, version: null, cacheKey: spec });
    for (const l of leaves) assert.ok(defs.constants.has(l), `${url}: skeleton ig-constant '${l}' not collected`);
    failures.push(...(await issuesOnIgValues(bundle, defs, { constants: leaves, literals: new Set() })).map((f) => `${url}: ${f}`));
  }
  assert.deepEqual(failures, []);
  return { profiles, constants };
}

test("TWPAS: every profile's skeleton ig-constants pass grounding and the record checks", { skip: !pasDeps }, async () => {
  const r = await skeletonConsistency(pasDeps!, PAS![0]);
  assert.ok(r.profiles >= 5, `profiles with ig-constants: ${r.profiles}`);
});

test("TW Core: every profile's skeleton ig-constants pass grounding and the record checks", { skip: !twcDeps }, async () => {
  const r = await skeletonConsistency(twcDeps!, TWC![0]);
  assert.ok(r.profiles >= 5, `profiles with ig-constants: ${r.profiles}`);
});

function exampleBundles(spec: string): Array<[string, R]> {
  const dir = pkgDir(spec);
  if (!dir) return [];
  const out: Array<[string, R]> = [];
  for (const d of [join(dir, "example"), dir]) {
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d).sort()) {
      if (!f.startsWith("Bundle-") || !f.endsWith(".json")) continue;
      const b = JSON.parse(readFileSync(join(d, f), "utf8")) as R;
      if (Array.isArray(b.entry) && b.entry.length) out.push([f, b]);
    }
  }
  return out;
}

async function exampleBundleCheck(deps: BlueprintDeps, spec: string): Promise<{ bundles: number; without: string[] }> {
  const failures: string[] = [];
  const without: string[] = [];
  let bundles = 0;
  for (const [f, b] of exampleBundles(spec)) {
    const defs = await igDefinedValues(b, deps, { packageId: null, version: null, cacheKey: spec, exampleProfiles: async () => [] });
    bundles++;
    failures.push(...(await issuesOnIgValues(b, defs, defs)).map((x) => `${f}: ${x}`));
    without.push(...(await issuesOnIgValues(b, null, defs)).map((x) => `${f}: ${x}`));
  }
  assert.deepEqual(failures, []);
  return { bundles, without };
}

test("TWPAS example Bundles: no value issue on IG-defined values (the NHI agency's name / OID were reported before v17.2)", { skip: !pasDeps }, async () => {
  const r = await exampleBundleCheck(pasDeps!, PAS![0]);
  assert.ok(r.bundles >= 4);
  assert.ok(r.without.some((x) => /Organization|identifier|name/.test(x)), `without the exemption: ${r.without.slice(0, 5).join("; ")}`);
});

test("TW Core example Bundles: no value issue on IG-defined values", { skip: !twcDeps }, async () => {
  const r = await exampleBundleCheck(twcDeps!, TWC![0]);
  assert.ok(r.bundles >= 3);
});

test("TWPAS: an invariant literal (pat-ast-value 'class1') is IG-defined; a fabricated hospital name / patient id are still reported", { skip: !pasDeps }, async () => {
  const obsUrl = "https://nhicore.nhi.gov.tw/pas/StructureDefinition/Observation-pat-assessment-twpas";
  const bundle = bundleOf(
    { resourceType: "Patient", meta: { profile: ["https://nhicore.nhi.gov.tw/pas/StructureDefinition/Patient-twpas"] }, identifier: [{ system: "http://www.moi.gov.tw/", value: "Z299999999" }], name: [{ text: "王大明" }] },
    { resourceType: "Organization", meta: { profile: ["https://nhicore.nhi.gov.tw/pas/StructureDefinition/Organization-twpas"] }, name: "幸福聯合醫院", identifier: [{ system: "https://www.nhi.gov.tw/", value: "9876543210" }] },
    { resourceType: "Observation", meta: { profile: [obsUrl] }, status: "final", code: { coding: [{ system: "http://loinc.org", code: "88020-3" }] }, subject: { reference: "urn:uuid:00000000-0000-4000-8000-000000000000" }, valueString: "class1" },
  );
  const defs = await igDefinedValues(bundle, pasDeps!, { packageId: null, version: null, cacheKey: "pas-literals" });
  assert.ok(defs.literals.has("class1"));
  assert.ok(!defs.literals.has("male") && !defs.literals.has("female"), "a guard literal (gender = 'male') is not an IG value");
  const g = await checkGrounding({ bundle, source_text: RECORD, ig_defined: defs }, { terminology: syntheticTerminology() });
  const paths = g.entries.flatMap((e) => e.issues).filter((i) => i.severity === "error").map((i) => i.path);
  assert.ok(!paths.some((p) => p.endsWith("valueString")), "class1 exempt");
  assert.ok(paths.some((p) => p.startsWith("Bundle.entry[1].resource.name")), "fabricated hospital name still reported");
  const rc = runRecordChecks(bundle, { sourceText: RECORD, igDefined: defs }).issues.filter((i) => i.code === "ungrounded-value").map((i) => i.path);
  assert.ok(rc.some((p) => p.startsWith("Bundle.entry[0].resource.identifier")), "fabricated patient id still reported");
  assert.ok(rc.some((p) => p.startsWith("Bundle.entry[1].resource.identifier")), "fabricated hospital id still reported");
});
