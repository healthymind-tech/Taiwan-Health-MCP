/**
 * Abbreviation equivalence (ISSUES_v20 R6) over the data-derived expansions a terminology provider returns
 * (TerminologyNames.abbreviations: fhir.term_thesaurus — SNOMED / LOINC / IG acronyms, bilingual pairs — and the
 * abbreviation lexicon). A record label and a code name "say the same" when
 *   - an expansion of a record token covers the name (≥ 0.5) or is wholly contained in it: Hb → "hemoglobin";
 *   - an expansion of a name token is in the record text: name "PEF Airway PFM", record "peak expiratory flow 410";
 *   - a record token and a name token share an expansion: PEFR ~ PEF (both "Peak expiratory flow rate").
 * Only ever used to ACCEPT a match the literal comparison missed (a label check, a code-meaning comparison); it never
 * creates a finding. Deterministic; no I/O here (the map is prefetched).
 */
import { nameSimilarity } from "./lexicon.js";
import { abbreviationTokens, type AbbreviationMap } from "./terminologyNames.js";

export type { AbbreviationMap } from "./terminologyNames.js";

const SIMILAR = 0.5;

/** How `quote` and `name` are equivalent through abbreviations, or null. */
export function abbreviationMatch(quote: string, name: string, abbr: AbbreviationMap | null | undefined): string | null {
  if (!abbr || !abbr.size || !quote || !name) return null;
  const qTok = abbreviationTokens([quote], 60);
  const nTok = abbreviationTokens([name], 30);
  const lower = (xs: readonly string[]): Set<string> => new Set(xs.map((x) => x.toLowerCase().trim()));
  for (const t of qTok) {
    const e = abbr.get(t);
    if (!e) continue;
    for (const x of e) if (x.length >= 3 && (nameSimilarity(x, name) >= SIMILAR || nameSimilarity(name, x) >= 0.99)) return `${t} = ${x}`;
  }
  for (const u of nTok) {
    const f = abbr.get(u);
    if (!f) continue;
    for (const x of f) if (x.length >= 6 && nameSimilarity(quote, x) >= 0.99) return `${u} = ${x}`;
    const fs = lower(f);
    for (const t of qTok) {
      if (t === u) continue;
      const e = abbr.get(t);
      if (e && e.some((x) => fs.has(x.toLowerCase().trim()))) return `${t} ~ ${u}`;
    }
  }
  return null;
}
