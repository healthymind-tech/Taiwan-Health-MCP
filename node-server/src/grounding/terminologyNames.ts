/**
 * Authoritative code names for grounding (`fhir_check_grounding` never trusts the model's own `display`).
 *
 * A provider returns, per `system|code`, whether the code is known locally and its names in every language we
 * hold (ICD-10-CM long/short + Chinese, LOINC long/short/component + Chinese, SNOMED FSN + synonyms, NHI / TW Core
 * CodeSystem displays, ...). The grounding engine pre-fetches all codings of a Bundle in one batch, then runs
 * synchronously on the resulting map.
 *
 * Two providers ship:
 *   - `staticTerminologyNames(cache)`  — fixed table (the reference `terminology_cache.json`; fixture parity)
 *   - `createDbTerminologyNames(...)`  — terminologyDb.ts, our Postgres tables (production)
 */
import { readFileSync } from "node:fs";

export interface TermRecord {
  /** The code exists in a local terminology table. */
  found: boolean;
  /** Authoritative names (English + Chinese designations + synonyms), de-duplicated, in preference order. */
  names: string[];
  /** Where the names came from (diagnostic only). */
  source?: string[];
  /**
   * LOINC axes of the code (loinc.concepts PROPERTY / SCALE_TYP), when the provider has them. Not used by the
   * grounding engine; the record checks read them (ISSUES_v15.3 R1: does an Observation need a quantitative result).
   */
  axes?: { property: string | null; scale: string | null };
}

export interface CodingRef {
  system?: string | null;
  code?: string | null;
}

export function termKey(system: unknown, code: unknown): string {
  return `${system === undefined || system === null ? "None" : String(system)}|${code === undefined || code === null ? "None" : String(code)}`;
}

export interface TerminologyNames {
  /** Human-readable version string for provenance (e.g. "icd10cm 2026-04-01; loinc 2.80; snomed 2025-01-01"). */
  version(): Promise<string> | string;
  /** Batch lookup; keys are `system|code`. Unknown keys may be omitted from the map (treated as not found). */
  lookup(keys: readonly string[]): Promise<ReadonlyMap<string, TermRecord>>;
  /**
   * ISSUES_v20 R6 (optional): expansions of abbreviation tokens (lower-cased keys) from the data-derived thesaurus
   * (fhir.term_thesaurus: SNOMED / LOINC / IG acronyms, bilingual pairs) and the abbreviation lexicon
   * (fhir.abbreviation_lexicon). Used to match a record label (PEFR) with a code name (PEF Airway PFM) when both
   * abbreviate the same term. A provider without it gives no expansions (behaviour unchanged).
   */
  abbreviations?(tokens: readonly string[]): Promise<ReadonlyMap<string, readonly string[]>>;
}

/** Abbreviation expansions by lower-cased token (TerminologyNames.abbreviations). */
export type AbbreviationMap = ReadonlyMap<string, readonly string[]>;

const RE_ABBR_TOKEN = /[A-Za-z][A-Za-z0-9]{1,9}/gu;

/**
 * Tokens worth an abbreviation lookup: Latin words of 2–10 characters written with at least one upper-case letter or
 * at most 5 characters (PEFR, Hb, HbA1c, eGFR). Lower-cased, de-duplicated, capped.
 */
export function abbreviationTokens(texts: readonly string[], cap = 400): string[] {
  const out = new Set<string>();
  for (const t of texts) {
    for (const m of String(t ?? "").normalize("NFKC").matchAll(RE_ABBR_TOKEN)) {
      const w = m[0];
      if (w.length <= 5 || /[A-Z]/u.test(w.slice(1)) || w === w.toUpperCase()) out.add(w.toLowerCase());
      if (out.size >= cap) return [...out];
    }
  }
  return [...out];
}

/** Convenience adapter (used by the completeness module): flat list of names for a list of codings. */
export async function namesFor(provider: TerminologyNames, codings: readonly CodingRef[]): Promise<string[]> {
  const keys = codings.filter((c) => c.code).map((c) => termKey(c.system, c.code));
  const map = await provider.lookup(keys);
  const out: string[] = [];
  for (const k of keys) {
    const r = map.get(k);
    if (r?.found) out.push(...r.names);
  }
  return out;
}

export interface TerminologyCacheFile {
  codes: Record<string, { found?: boolean; names?: string[]; source?: string[] }>;
  built?: string;
  n?: number;
}

/** Provider over a fixed table keyed by `system|code` (exact match, as in the reference). */
export function staticTerminologyNames(cache: TerminologyCacheFile, versionLabel = "static terminology cache"): TerminologyNames {
  const codes = cache.codes ?? {};
  const label = cache.built ? `${versionLabel} (${cache.built})` : versionLabel;
  return {
    version: () => label,
    async lookup(keys) {
      const out = new Map<string, TermRecord>();
      for (const k of keys) {
        const r = codes[k];
        if (r) out.set(k, { found: !!r.found, names: [...(r.names ?? [])], source: r.source });
      }
      return out;
    },
  };
}

/** Load a terminology_cache.json-shaped file. */
export function loadTerminologyCacheFile(path: string): TerminologyCacheFile {
  return JSON.parse(readFileSync(path, "utf8")) as TerminologyCacheFile;
}

/** Provider that knows no code (every coding becomes "unverifiable" — never an error). */
export const emptyTerminologyNames: TerminologyNames = {
  version: () => "none",
  lookup: async () => new Map(),
};
