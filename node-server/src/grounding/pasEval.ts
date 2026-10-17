/**
 * TW PAS grounding evaluation (test support): supported-record false positives and detection rates of the
 * negative variants, computed with the static PAS terminology snapshot. Used by pas.test.ts and scripts/pasReport.ts.
 */
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

import { checkGrounding, collectCodingKeys, enumerateUnits, type GroundingInput, type GroundingResult, type Unit } from "./checkGrounding.js";
import { renderPasRecord, variants, type VariantKind } from "./pasTestkit.js";
import { isDict, pyEq, type JsonObject } from "./py.js";
import { FIXED_CODE_PROFILES, WORKFLOW_DEFAULTS } from "./lexicon.js";
import { staticTerminologyNames, type TerminologyNames } from "./terminologyNames.js";
import { fixturePath, loadFixture } from "./testkit.js";

export function loadPasBundles(): Array<{ key: string; bundle: JsonObject }> {
  return JSON.parse(gunzipSync(readFileSync(fixturePath("pas_bundles.json.gz"))).toString()).bundles;
}

export function pasTerminology(): TerminologyNames {
  return staticTerminologyNames(loadFixture("pas_terminology.json"), "PAS terminology snapshot (staging DB)");
}

/** Units the engine actually checks (source facts, codings, non-default workflow values). */
export function checkedUnits(bundle: JsonObject): Unit[] {
  const out: Unit[] = [];
  const entries = (Array.isArray(bundle.entry) ? bundle.entry : []) as unknown[];
  entries.forEach((e, ei) => {
    const r = isDict(e) && isDict(e.resource) ? e.resource : {};
    const prof = (isDict(r.meta) && Array.isArray(r.meta.profile) ? r.meta.profile : []).map((p) => String(p).split("/").pop()!);
    for (const u of enumerateUnits(r, ei)) {
      if (u.cls === "coding" && (u.gpath === "Observation.code" || u.gpath === "Observation.component.code") && prof.some((p) => FIXED_CODE_PROFILES.has(p))) continue;
      if (u.cls === "source_fact" || u.cls === "coding") out.push(u);
      else if (u.cls === "unclassified" && u.kind === "datetime") out.push(u);
      else if (u.cls === "workflow_default") {
        let v: unknown = u.node;
        if (isDict(v) && Array.isArray(v.coding) && isDict(v.coding[0])) v = v.coding[0].code;
        if (!(WORKFLOW_DEFAULTS[u.gpath] ?? []).some((d) => pyEq(d, v))) out.push(u);
      }
    }
  });
  return out;
}

const warningsAt = (r: GroundingResult, path: string): string[] =>
  r.entries.flatMap((e) => e.issues).filter((i) => i.severity === "warning" && (i.path === path || i.path.startsWith(path + "."))).map((i) => i.rule);
const errorsAt = (r: GroundingResult, path: string): string[] =>
  r.entries.flatMap((e) => e.issues).filter((i) => i.severity === "error" && (i.path === path || i.path.startsWith(path + "."))).map((i) => i.rule);
const allErrors = (r: GroundingResult): string[] => [...r.issues, ...r.entries.flatMap((e) => e.issues)].filter((i) => i.severity === "error").map((i) => `${i.rule}@${i.path}`);

export interface PasEval {
  bundles: number;
  units: number;
  supported: { bundlesWithErrors: number; errors: string[]; warnings: number };
  /** detected = error at the unit; warned = no error but a warning at the unit (by policy, e.g. unverifiable code); rest silent. */
  byKind: Record<VariantKind, { total: number; detected: number; warned?: number; derived?: number; misses: string[] }>;
  /** Variants on record-keeping timestamps (warning-level by policy; "detected" = error). */
  adminTimestamps: { total: number; detected: number; warned?: number; derived?: number; misses: string[] };
}

/** A grounding checker: in-process by default; scripts/pasReport.ts can pass one that calls a deployed server. */
export type GroundingChecker = (input: GroundingInput) => Promise<GroundingResult>;

/**
 * `stride` > 1 evaluates every stride-th variant (unit tests); the full run is scripts/pasReport.ts.
 * `terminology` renders the synthetic records (and checks them, unless `check` is given).
 */
export async function evaluatePas(terminology: TerminologyNames = pasTerminology(), stride = 1, check?: GroundingChecker): Promise<PasEval> {
  const run: GroundingChecker = check ?? ((input) => checkGrounding(input, { terminology }));
  let vi = 0;
  const res: PasEval = {
    bundles: 0,
    units: 0,
    supported: { bundlesWithErrors: 0, errors: [], warnings: 0 },
    byKind: {
      bundle_value: { total: 0, detected: 0, misses: [] },
      record_removed: { total: 0, detected: 0, misses: [] },
      record_negated: { total: 0, detected: 0, misses: [] },
      record_historical: { total: 0, detected: 0, misses: [] },
    },
    adminTimestamps: { total: 0, detected: 0, misses: [] },
  };
  for (const { key, bundle } of loadPasBundles()) {
    const terms = await terminology.lookup(collectCodingKeys(bundle));
    const rec = renderPasRecord(bundle, terms);
    const base = { bundle, source_text: rec.text, site_config: rec.site, verbosity: "all" as const, mode: "auto" as const };
    const clean = await run(base);
    res.bundles++;
    const units = checkedUnits(bundle);
    res.units += units.length;
    const errs = allErrors(clean);
    if (errs.length) res.supported.bundlesWithErrors++;
    res.supported.errors.push(...errs.map((e) => `${key}: ${e}`));
    res.supported.warnings += [...clean.issues, ...clean.entries.flatMap((e) => e.issues)].filter((i) => i.severity === "warning").length;
    for (const v of variants(bundle, rec.text, units, terms)) {
      if (vi++ % stride !== 0) continue;
      // a unit whose clean run already erred cannot measure detection
      if (errs.some((e) => e.endsWith("@" + v.unitPath))) continue;
      const out = await run({ ...base, bundle: v.bundle, source_text: v.text });
      const at = errorsAt(out, v.unitPath);
      const ok = v.expectRules ? at.some((r) => v.expectRules!.includes(r)) : at.length > 0;
      const k = v.admin ? res.adminTimestamps : res.byKind[v.kind];
      k.total++;
      if (ok) k.detected++;
      else {
        const w = warningsAt(out, v.unitPath);
        const derived = out.entries.flatMap((e) => e.issues).some((i) => i.rule === "G-DERIVED" && i.path.startsWith(v.unitPath));
        if (w.length) k.warned = (k.warned ?? 0) + 1;
        else if (derived) {
          k.derived = (k.derived ?? 0) + 1;
          w.push("(G-DERIVED information)");
        }
        k.misses.push(`${key} ${v.unitPath} (${v.unitKind})${at.length ? " got " + at.join(",") : ""}${w.length ? " warning " + w.join(",") : " SILENT"}`);
      }
    }
  }
  return res;
}
