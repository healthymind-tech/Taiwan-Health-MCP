/**
 * Query-expansion thesaurus for the IG concept-search engine (pure, no I/O).
 *
 * Every entry is derived from data, never hand-written for a code:
 *  - acronyms mined from SNOMED CT descriptions ("PCI - Percutaneous coronary
 *    intervention", "TKA (total knee arthroplasty) using …", "… (CRP)");
 *  - acronyms mined from LOINC (SHORTNAME head word ↔ COMPONENT, e.g. CRP ↔ C reactive protein);
 *  - the grounding lexicon's curated abbreviation and zh↔en bridge tables (twLexiconData.ts).
 * A mined pair is kept only when the acronym is a plausible abbreviation of the
 * expansion (Schwartz & Hearst 2003 letter matching).
 */

import { TW_LEXICON_DATA } from "../grounding/twLexiconData.js";
import { normalizeText, stemLatin } from "./text.js";

export interface ThesaurusEntry {
  abbr: string;
  expansion: string;
  source: string;
  freq: number;
}

/**
 * Schwartz–Hearst check: every letter/digit of the acronym is found right-to-left in
 * the expansion, and the first one starts a word.
 */
export function plausibleAbbreviation(abbr: string, expansion: string): boolean {
  const s = abbr.toLowerCase().replace(/[^a-z0-9]/g, "");
  const l = expansion.toLowerCase();
  if (s.length < 2 || l.length <= s.length) return false;
  let si = s.length - 1;
  let li = l.length - 1;
  while (si >= 0) {
    const c = s[si];
    while (li >= 0 && (l[li] !== c || (si === 0 && li > 0 && /[a-z0-9]/.test(l[li - 1])))) li -= 1;
    if (li < 0) return false;
    li -= 1;
    si -= 1;
  }
  // The expansion must have at least two words for a 3+ letter acronym (not "Hemoglobin" for "HGB").
  return expansion.trim().split(/[\s\-/.]+/).filter(Boolean).length >= Math.min(2, s.length - 1);
}

const ACR = "[A-Za-z][A-Za-z0-9]{1,7}";
const SN_DASH = new RegExp(`^(${ACR})\\s+-\\s+(.+)$`);
const SN_PAREN_AFTER = new RegExp(`^(${ACR})\\s*\\(([^()]{4,80})\\)`);
const SN_PAREN_TAIL = new RegExp(`^([^()]{4,80}?)\\s*\\((${ACR})\\)\\s*$`);

function looksAcronym(a: string): boolean {
  // Mostly upper-case (allow "HbA1c"-style mixed case) and not a plain word.
  const upper = (a.match(/[A-Z]/g) || []).length;
  return upper >= 2 || (upper >= 1 && /\d/.test(a));
}

function cleanExpansion(e: string): string {
  return e
    .replace(/\s*\[[^\]]*\]\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Acronym pairs from SNOMED CT description terms. */
export function mineSnomedAcronyms(terms: Iterable<string>): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const raw of terms) {
    const term = String(raw || "").trim();
    let m = SN_DASH.exec(term);
    if (m && looksAcronym(m[1])) {
      // "CABG x 2 - …" is caught by ACR only when it is the whole head; strip trailing counts.
      const exp = cleanExpansion(m[2]);
      if (plausibleAbbreviation(m[1], exp)) out.push([m[1], exp]);
      continue;
    }
    m = SN_PAREN_AFTER.exec(term);
    if (m && looksAcronym(m[1])) {
      const exp = cleanExpansion(m[2]);
      if (plausibleAbbreviation(m[1], exp)) out.push([m[1], exp]);
      continue;
    }
    m = SN_PAREN_TAIL.exec(term);
    if (m && looksAcronym(m[2])) {
      const exp = cleanExpansion(m[1]);
      if (plausibleAbbreviation(m[2], exp)) out.push([m[2], exp]);
    }
  }
  return out;
}

const INLINE_SHORT = /\(\s*([A-Za-z][A-Za-z0-9.\-/]{1,9})\s*\)/g;
const INLINE_LONG = /(?:^|[\s,;])([A-Za-z][A-Za-z0-9.\-]{1,9})\s*\(([^()]{4,80})\)/g;

/**
 * Acronyms defined inline in a name, anywhere in it (Schwartz & Hearst): "long form (SF)"
 * — the shortest run of preceding words the acronym abbreviates — and "SF(long form)".
 * Run over the IG CodeSystems' own names this yields in-domain abbreviations
 * ("Extracorporeal shock wave lithotripsy (ESWL) for …", "TIBC(Total Iron Binding Capacity)").
 */
export function mineInlineAcronyms(terms: Iterable<string>): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const raw of terms) {
    const term = String(raw || "").normalize("NFKC");
    for (const m of term.matchAll(INLINE_SHORT)) {
      const sf = m[1].replace(/[.]/g, "");
      if (!looksAcronym(sf) || sf.length > 8) continue;
      const before = term.slice(0, m.index).split(/[,;:(]/).pop() || "";
      const words = before.trim().split(/\s+/).filter(Boolean).slice(-Math.min(sf.length + 5, sf.length * 2));
      for (let k = Math.min(words.length, Math.max(1, sf.length - 1)); k <= words.length; k += 1) {
        const lf = words.slice(-k).join(" ");
        if (/^[A-Za-z]/.test(lf) && plausibleAbbreviation(sf, lf)) {
          out.push([sf, lf]);
          break;
        }
      }
    }
    for (const m of term.matchAll(INLINE_LONG)) {
      const sf = m[1].replace(/[.]/g, "");
      const lf = cleanExpansion(m[2]);
      if (looksAcronym(sf) && sf.length <= 8 && /^[A-Za-z]/.test(lf) && plausibleAbbreviation(sf, lf)) out.push([sf, lf]);
    }
  }
  return out;
}

/** Acronym pairs from LOINC: SHORTNAME head word ↔ COMPONENT (first part before "." / "^"). */
export function mineLoincAcronyms(rows: Iterable<{ shortname: string | null; component: string | null }>): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const r of rows) {
    const head = String(r.shortname || "").trim().split(/\s+/)[0] || "";
    const acr = head.replace(/[^A-Za-z0-9]/g, "");
    if (!acr || acr.length > 8 || !looksAcronym(acr)) continue;
    const comp = String(r.component || "").split(/[.^]/)[0].trim();
    if (!comp || comp.length > 80) continue;
    if (plausibleAbbreviation(acr, comp)) out.push([acr, comp]);
  }
  return out;
}

/** Collapse mined pairs into entries (lower-cased key, frequency, top-N expansions per acronym). */
export function buildEntries(pairs: Iterable<[string, string]>, source: string, perAbbr = 6): ThesaurusEntry[] {
  const counts = new Map<string, Map<string, { exp: string; n: number }>>();
  for (const [a, e] of pairs) {
    const abbr = a.toLowerCase();
    const key = normalizeText(e);
    if (!key || key === abbr) continue;
    let m = counts.get(abbr);
    if (!m) counts.set(abbr, (m = new Map()));
    const hit = m.get(key);
    if (hit) hit.n += 1;
    else m.set(key, { exp: e.trim(), n: 1 });
  }
  const out: ThesaurusEntry[] = [];
  for (const [abbr, m] of counts) {
    const ranked = [...m.values()].sort((x, y) => y.n - x.n || x.exp.length - y.exp.length).slice(0, perAbbr);
    for (const r of ranked) out.push({ abbr, expansion: r.exp, source, freq: r.n });
  }
  return out;
}

/**
 * English word → Chinese word pairs mined from bilingual names (ICD-10 zh/en, IG concepts
 * with zh display + en designation): Dice association between English words and Chinese
 * 2–4-character n-grams, kept only for mutual best matches (competitive linking) with
 * enough support. E.g. breast ↔ 乳房, laparoscopic ↔ 腹腔鏡, dialysis ↔ 透析.
 */
export function mineBilingual(
  pairs: Iterable<[string, string]>,
  opts: { minCount?: number; minDice?: number } = {},
): Array<[string, string, number]> {
  const minCount = opts.minCount ?? 5;
  const minDice = opts.minDice ?? 0.5;
  const docs: Array<[string[], string[]]> = [];
  const cw = new Map<string, number>();
  const cg = new Map<string, number>();
  const inc = (m: Map<string, number>, k: string): void => {
    m.set(k, (m.get(k) ?? 0) + 1);
  };
  for (const [zh, en] of pairs) {
    const ws = new Set<string>();
    for (const w of normalizeText(en).match(/[a-z][a-z0-9]+/g) || []) {
      const st = stemLatin(w);
      if (st.length >= 3 && !BI_STOP.has(st)) ws.add(st);
    }
    const gs = new Set<string>();
    for (const run of normalizeText(zh).match(/[\p{Script=Han}]+/gu) || []) {
      const ch = Array.from(run);
      for (let n = 2; n <= 4; n += 1) for (let i = 0; i + n <= ch.length; i += 1) gs.add(ch.slice(i, i + n).join(""));
    }
    if (!ws.size || !gs.size) continue;
    docs.push([[...ws], [...gs]]);
    for (const w of ws) inc(cw, w);
    for (const g of gs) inc(cg, g);
  }
  const co = new Map<string, number>();
  for (const [ws, gs] of docs) {
    const fw = ws.filter((w) => (cw.get(w) ?? 0) >= minCount);
    const fg = gs.filter((g) => (cg.get(g) ?? 0) >= minCount);
    for (const w of fw) for (const g of fg) inc(co, `${w}\u0000${g}`);
  }
  const bestW = new Map<string, [string, number]>();
  const bestG = new Map<string, [string, number]>();
  for (const [k, c] of co) {
    if (c < minCount) continue;
    const [w, g] = k.split("\u0000");
    const d = (2 * c) / ((cw.get(w) ?? 0) + (cg.get(g) ?? 0));
    // Ties prefer the longer n-gram (乳房攝影 over 乳房 only when it really is as strong).
    const bw = bestW.get(w);
    if (!bw || d > bw[1] + 1e-9 || (Math.abs(d - bw[1]) < 1e-9 && g.length > bw[0].length)) bestW.set(w, [g, d]);
    const bg = bestG.get(g);
    if (!bg || d > bg[1]) bestG.set(g, [w, d]);
  }
  const out: Array<[string, string, number]> = [];
  for (const [w, [g, d]] of bestW) {
    if (d < minDice) continue;
    if (bestG.get(g)?.[0] !== w) continue; // mutual best match only
    out.push([w, g, Math.round(d * 1000) / 1000]);
  }
  return out;
}

export const BI_STOP = new Set(["the", "and", "with", "without", "for", "from", "other", "unspecified", "specified", "not", "elsewhere", "classified", "due", "use", "using", "approach", "open", "percutaneous"]);


// ---------------------------------------------------------------------------- runtime thesaurus

const LEX = (TW_LEXICON_DATA as unknown as { terminology: Record<string, unknown> }).terminology;
const LEX_ABBREV = (LEX.abbrev || {}) as Record<string, string>;
const LEX_ZH_EN = (LEX.zhEn || {}) as Record<string, string>;
const LEX_GENERIC = new Set<string>(((LEX.genericTokens || []) as string[]).map((x) => x.toLowerCase()));

/** In-memory thesaurus used to expand queries. */
export class Thesaurus {
  /** lower-cased abbreviation → expansions (best first). */
  readonly abbr = new Map<string, string[]>();
  /** Abbreviations from the curated lexicon: expanded whatever their case ("lap", "hd"). */
  readonly curated = new Set<string>();
  /** Chinese phrase → English words (lexicon bridge), longest phrase first. */
  readonly zhEn: Array<[string, string]>;
  /** English word → Chinese phrases (reverse bridge; unambiguous content words only). */
  readonly enZh = new Map<string, string[]>();

  constructor(entries: Iterable<ThesaurusEntry> = []) {
    for (const [a, e] of Object.entries(LEX_ABBREV)) {
      this.add(a, e);
      this.curated.add(a.toLowerCase());
    }
    const mined = [...entries].sort((x, y) => y.freq - x.freq);
    for (const e of mined) if (e.source !== "bilingual") this.add(e.abbr, e.expansion);
    this.zhEn = Object.entries(LEX_ZH_EN)
      .map(([zh, en]) => [normalizeText(zh), en] as [string, string])
      .filter(([zh]) => zh.length >= 1)
      .sort((a, b) => b[0].length - a[0].length);
    // Reverse bridge only from short English glosses ("hemodialysis dialysis" → 透析), never from a
    // word inside a longer phrase ("complete blood count" must not turn "blood" into 全套血液檢查).
    const rev = new Map<string, Set<string>>();
    for (const [zh, en] of this.zhEn) {
      if (zh.length < 2) continue;
      const ws = en.toLowerCase().split(/\s+/).filter(Boolean);
      if (ws.length > 2) continue;
      for (const w of ws) {
        if (w.length < 4 || LEX_GENERIC.has(w)) continue;
        if (!rev.has(w)) rev.set(w, new Set());
        rev.get(w)!.add(zh);
      }
    }
    for (const [w, zs] of rev) if (zs.size <= 2) this.enZh.set(w, [...zs].sort((a, b) => a.length - b.length));
    // Mined bilingual pairs (source "bilingual": abbr = English word stem, expansion = Chinese word).
    for (const e of mined) {
      if (e.source !== "bilingual") continue;
      if (!this.enZh.has(e.abbr)) this.enZh.set(e.abbr, [e.expansion]);
    }
  }

  private add(abbr: string, expansion: string): void {
    const a = abbr.toLowerCase().trim();
    if (!a) return;
    const list = this.abbr.get(a) || [];
    const n = normalizeText(expansion);
    if (n && !list.some((x) => normalizeText(x) === n)) list.push(expansion);
    this.abbr.set(a, list);
  }

  expansions(token: string, max = 3): string[] {
    return (this.abbr.get(token.toLowerCase()) || []).slice(0, max);
  }
}
