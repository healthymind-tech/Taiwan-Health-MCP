/**
 * Clinical abbreviation lexicon for query expansion (pure, no I/O).
 *
 * Source: the SPECIALIST Lexicon's LRABR table (NLM Lexical Systems Group, shipped in
 * LEX/LRABR of every lexicon release and in the full UMLS release). One row per
 * (abbreviation, expansion):
 *
 *   EUI|abbreviation|type|EUI of expansion|expansion|
 *   E0000048|AA|acronym|E0000204|Alcoholics Anonymous|
 *
 * The table is general biomedical English, so an abbreviation often has many senses
 * ("LP" → lipoprotein, lumbar puncture, lichen planus …). Nothing here picks a sense: the
 * concept-search engine ranks every sense by how well the target CodeSystem's own
 * vocabulary names it (engine.ts `rankSenses`). Expansions only steer matching and are
 * never returned by a tool.
 */

import { normalizeText, umlsNorm } from "./text.js";

export interface AbbreviationRow {
  /** Lookup key: the abbreviation lower-cased (NFKC), punctuation kept ("i&d", "ca19-9"). */
  key: string;
  /** The abbreviation as written in the source ("LP", "chole"). */
  abbr: string;
  expansion: string;
  /** "acronym" | "abbreviation" (LRABR type). */
  kind: string;
}

const MAX_ABBR = 10;
const MAX_EXPANSION = 80;

/** Lookup key of an abbreviation (as written in a query or in the lexicon). */
export function abbreviationKey(s: string): string {
  return String(s || "").normalize("NFKC").toLowerCase().trim();
}

/** Whether an abbreviation is written in lower case in the lexicon ("chole", "trach"). */
export function isLowerCaseForm(abbr: string): boolean {
  return /[a-z]/.test(abbr) && !/[A-Z]/.test(abbr);
}

/**
 * One LRABR line → row, or null when it is not a usable clinical abbreviation: the
 * abbreviation must be 2–10 characters with a letter and no spaces; the expansion
 * 3–80 characters, Latin script, not itself the abbreviation.
 */
export function parseLrabrLine(line: string): AbbreviationRow | null {
  const p = line.split("|");
  if (p.length < 5) return null;
  const abbr = p[1].trim();
  const kind = p[2].trim();
  const expansion = p[4].trim();
  if (kind !== "acronym" && kind !== "abbreviation") return null;
  if (abbr.length < 2 || abbr.length > MAX_ABBR || /\s/.test(abbr) || !/[A-Za-z]/.test(abbr)) return null;
  if (expansion.length < 3 || expansion.length > MAX_EXPANSION || !/^[A-Za-z0-9]/.test(expansion)) return null;
  if (/[^\x20-\x7e]/.test(expansion)) return null;
  const key = abbreviationKey(abbr);
  if (umlsNorm(expansion).replace(/ /g, "") === umlsNorm(abbr).replace(/ /g, "")) return null;
  return { key, abbr, expansion, kind };
}

/**
 * Rows of an LRABR file, one per (abbreviation as written, expansion reading): spelling
 * variants of the same expansion ("plasma exchange" / "plasma-exchange") collapse to the
 * first one.
 */
export function* lrabrRows(lines: Iterable<string>): Generator<AbbreviationRow> {
  const seen = new Set<string>();
  for (const line of lines) {
    const r = parseLrabrLine(line);
    if (!r) continue;
    const k = `${r.abbr}\u0000${umlsNorm(r.expansion)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    yield r;
  }
}

/**
 * Expansions for one query word from lexicon rows. A row written in upper / mixed case
 * (an acronym: "LP", "PLEX") applies only when the query writes the word like an
 * abbreviation (`abbreviationLike`); a lower-case row (a clipping: "chole", "trach")
 * applies to any query word the CodeSystem does not know as a word.
 */
export function applicableExpansions(rows: Iterable<Pick<AbbreviationRow, "abbr" | "expansion">>, abbreviationLike: boolean, knownWord: boolean): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const lower = isLowerCaseForm(r.abbr);
    if (!(abbreviationLike || (lower && !knownWord))) continue;
    if (!plausibleSense(r.abbr, r.expansion)) continue;
    const n = normalizeText(r.expansion);
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(r.expansion);
  }
  return out;
}

/**
 * Whether an expansion reads as a sense of the abbreviation: a multi-word expansion
 * (initialism: "PLEX" → plasma exchange), or one word the abbreviation clips ("trach" →
 * tracheostomy, "cysto" → cystoscopy). Single words the letters merely occur in
 * ("ABO" → antibody) are dropped.
 */
export function plausibleSense(abbr: string, expansion: string): boolean {
  const words = umlsNorm(expansion).split(" ").filter(Boolean);
  if (words.length >= 2) return true;
  const a = abbreviationKey(abbr).replace(/[^a-z0-9]/g, "");
  return a.length >= 2 && (words[0] || "").startsWith(a.slice(0, 2));
}
