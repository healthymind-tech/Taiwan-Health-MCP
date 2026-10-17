/**
 * Shared helpers for the grounding parity tests and scripts (not used at runtime by the tool).
 */
import { readFileSync } from "node:fs";

import type { GroundingIssue, GroundingResult } from "./checkGrounding.js";
import { staticTerminologyNames, type TerminologyCacheFile, type TerminologyNames } from "./terminologyNames.js";

export function fixturePath(name: string): URL {
  return new URL(`./__fixtures__/${name}`, import.meta.url);
}

export function loadFixture<T = any>(name: string): T {
  return JSON.parse(readFileSync(fixturePath(name), "utf8")) as T;
}

/** Static provider over the reference terminology cache (fixture parity). */
export function referenceTerminology(): TerminologyNames {
  return staticTerminologyNames(loadFixture<TerminologyCacheFile>("terminology_cache.json"), "reference terminology_cache.json");
}

/** Bundle-level information issues this port adds on purpose (spec §2.2.8: entries without resource). */
export function isDeviationIssue(i: GroundingIssue): boolean {
  return i.rule === "G-UNCLASSIFIED" && /^Bundle\.entry\[\d+\]$/.test(i.path);
}

/**
 * Normalize a TS result for comparison with a reference output: drop elapsed_ms, drop documented deviation issues,
 * and convert the information count to the reference definition (entry-level information only).
 */
export function comparable(out: GroundingResult): Record<string, unknown> {
  const o = JSON.parse(JSON.stringify(out)) as GroundingResult & Record<string, unknown>;
  delete (o as Partial<GroundingResult>).elapsed_ms;
  const bundleInfo = o.issues.filter((i) => i.severity === "information").length;
  o.issues = o.issues.filter((i) => !isDeviationIssue(i));
  o.grounding = { ...o.grounding, information: o.grounding.information - bundleInfo };
  return o;
}

export function errorSet(d: { issues: GroundingIssue[]; entries: Array<{ issues: GroundingIssue[] }> }): string[] {
  const s = new Set<string>();
  for (const e of d.entries) for (const i of e.issues) if (i.severity === "error") s.add(`${i.rule}@${i.path}`);
  for (const i of d.issues) if (i.severity === "error") s.add(`${i.rule}@${i.path}`);
  return [...s].sort();
}

/** First differing JSON path between two values (for readable test failures). */
export function firstDiff(a: unknown, b: unknown, path = "$"): string | null {
  if (typeof a !== typeof b || Array.isArray(a) !== Array.isArray(b) || (a === null) !== (b === null))
    return `${path}: ${JSON.stringify(a)?.slice(0, 300)} != ${JSON.stringify(b)?.slice(0, 300)}`;
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const d = firstDiff(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  if (a && typeof a === "object") {
    const ka = Object.keys(a as object).sort();
    const kb = Object.keys(b as object).sort();
    if (ka.join() !== kb.join()) return `${path}: keys ${ka} != ${kb}`;
    for (const k of ka) {
      const d = firstDiff((a as any)[k], (b as any)[k], `${path}.${k}`);
      if (d) return d;
    }
    return null;
  }
  return a === b ? null : `${path}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`;
}

/**
 * Resource types whose path rules this port extends beyond the reference (TW PAS support). For reference-parity
 * comparisons their entries — and the summary, which counts them — are removed from both sides.
 */
export const EXTENDED_RESOURCE_TYPES = new Set(["Claim"]);

export function withoutExtendedEntries(d: any): any {
  d = blankObservationDateLocations(d);
  if (!d.entries.some((e: any) => EXTENDED_RESOURCE_TYPES.has(e.resourceType))) return d;
  const o = { ...d, entries: d.entries.filter((e: any) => !EXTENDED_RESOURCE_TYPES.has(e.resourceType)) };
  delete o.grounding;
  delete o.valid;
  return o;
}

/**
 * Documented deviation: an Observation date is located on the line that also names the Observation when such a line
 * exists (the reference took the first line with the date, e.g. the visit header). Only the information-level
 * G-AUTO-LOCATED quote differs, so its text fields are blanked on both sides for reference-parity comparisons.
 */
export function blankObservationDateLocations(d: any): any {
  const o = JSON.parse(JSON.stringify(d));
  for (const e of o.entries)
    for (const i of e.issues)
      if (i.rule === "G-AUTO-LOCATED" && /\.effective(DateTime|Period\.(start|end))$/.test(i.path)) {
        i.message = i.message.replace(/「.*」$/u, "「…」");
        delete i.located_quote;
        delete i.located_quotes;
      }
  return o;
}
