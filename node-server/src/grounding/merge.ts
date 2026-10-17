/**
 * Merge a grounding result into a `fhir_validate_bundle` (conformance) result — spec §2.4.
 *
 *   data.conformanceValid = original valid
 *   data.groundingValid   = grounding valid
 *   data.valid            = conformanceValid ∧ groundingValid
 *   entries[i].issues    += grounding entry i issues (each carries source:"grounding"); entries[i].valid ∧= grounding entry valid
 *   data.issues          += grounding Bundle-level issues
 *   data.grounding        = grounding summary; data.groundingMode = mode; data.source = "builtin+grounding"
 *
 * Entries are matched by index (both results enumerate `Bundle.entry` in order); when the conformance entry at the
 * same index has a different fullUrl, a fullUrl match is used instead. Inputs are not mutated.
 */
import { GROUNDING_TOOL_VERSION, type GroundingIssue, type GroundingResult, type GroundingSummary } from "./checkGrounding.js";
import { LEXICON_SHA256, LEXICON_VERSION } from "./lexicon.js";

export interface ConformanceEntry {
  fullUrl?: string | null;
  resourceType?: string | null;
  valid: boolean;
  profile?: string;
  issues: Array<Record<string, unknown>>;
  [k: string]: unknown;
}

export interface ConformanceData {
  valid: boolean;
  source?: string;
  profile?: string;
  issues: Array<Record<string, unknown>>;
  entries: ConformanceEntry[];
  referenceIssues?: Array<Record<string, unknown>>;
  [k: string]: unknown;
}

export interface MergedValidationData extends ConformanceData {
  conformanceValid: boolean;
  groundingValid: boolean;
  grounding: GroundingSummary;
  groundingMode: GroundingResult["mode"];
  source: string;
}

export function mergeGroundingIntoValidation(conformance: ConformanceData, grounding: GroundingResult): MergedValidationData {
  const conf = structuredClone(conformance);
  const entries: ConformanceEntry[] = (conf.entries ?? []).map((e) => ({ ...e, issues: [...(e.issues ?? [])] }));
  const used = new Set<number>();
  grounding.entries.forEach((ge, i) => {
    let idx = i < entries.length ? i : -1;
    if (idx >= 0 && ge.fullUrl && entries[idx].fullUrl && entries[idx].fullUrl !== ge.fullUrl) {
      const byUrl = entries.findIndex((e, k) => !used.has(k) && e.fullUrl === ge.fullUrl);
      if (byUrl >= 0) idx = byUrl;
    }
    if (idx < 0) {
      entries.push({ fullUrl: ge.fullUrl, resourceType: ge.resourceType, valid: ge.valid, profile: ge.profile, issues: [...ge.issues] as unknown as Array<Record<string, unknown>> });
      used.add(entries.length - 1);
      return;
    }
    used.add(idx);
    const e = entries[idx];
    e.issues = [...e.issues, ...(ge.issues as unknown as Array<Record<string, unknown>>)];
    e.valid = e.valid && ge.valid;
  });
  const conformanceValid = !!conf.valid;
  const groundingValid = grounding.valid;
  return {
    ...conf,
    valid: conformanceValid && groundingValid,
    source: "builtin+grounding",
    issues: [...(conf.issues ?? []), ...(grounding.issues as GroundingIssue[] as unknown as Array<Record<string, unknown>>)],
    entries,
    referenceIssues: conf.referenceIssues ?? [],
    conformanceValid,
    groundingValid,
    grounding: grounding.grounding,
    groundingMode: grounding.mode,
  };
}

/** Fields to add to the `fhir_validate_bundle` provenance when grounding ran (spec §2.4). */
export function groundingProvenanceFields(): { groundingVersion: string; lexiconVersion: string; lexiconSha256: string } {
  return { groundingVersion: GROUNDING_TOOL_VERSION, lexiconVersion: LEXICON_VERSION, lexiconSha256: LEXICON_SHA256 };
}

/**
 * Resolve `fhir_validate_bundle`'s `grounding` parameter: "off" or no source_text -> null (output must stay
 * byte-identical to the conformance-only result); otherwise the grounding mode.
 */
export function resolveValidateGrounding(
  grounding: "off" | "auto" | "strict" | null | undefined,
  sourceText: string | null | undefined,
  evidenceMap: unknown,
): "auto" | "strict" | null {
  if (grounding === "off" || sourceText === null || sourceText === undefined) return null;
  if (grounding === "auto" || grounding === "strict") return grounding;
  const hasMap = Array.isArray(evidenceMap) ? evidenceMap.length > 0 : !!evidenceMap && typeof evidenceMap === "object" && Object.keys(evidenceMap).length > 0;
  return hasMap ? "strict" : "auto";
}
