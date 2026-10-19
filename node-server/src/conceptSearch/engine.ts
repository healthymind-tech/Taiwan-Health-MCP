/**
 * In-memory lexical index + hybrid ranking for the concepts of one CodeSystem (pure, no I/O).
 *
 * Documents are the concept's terms (display, designations in any language, supplement
 * names, names borrowed through property / ConceptMap links, short definitions, the code
 * itself). A concept scores as its best term. Scoring is BM25-like over the tokens of
 * text.ts with query/term coverage factors and exact / containment boosts, so the
 * official name typed verbatim always ranks first.
 *
 * Queries are expanded into weighted variants (clinical core, without brackets, acronym
 * expansions, zh↔en lexicon bridges); a concept keeps its best variant score.
 */

import {
  clinicalCore,
  compact,
  groupKey,
  guessLang,
  normalizeText,
  stemLatin,
  tokenize,
  tokKey,
  umlsNorm,
  withoutBrackets,
  type Tok,
} from "./text.js";
import type { Thesaurus } from "./thesaurus.js";

export type TermKind = "code" | "display" | "designation" | "linked" | "property" | "definition" | "umls";

/** Relative trust of a match per term kind. */
export const KIND_WEIGHT: Record<TermKind, number> = {
  code: 1,
  display: 1,
  designation: 1,
  linked: 0.8,
  property: 0.55,
  definition: 0.35,
  // Synonym of a UMLS concept the IG concept's English name maps to (match-only, never shown).
  umls: 0.6,
};

export interface TermInput {
  text: string;
  lang: string | null;
  kind: TermKind;
  source?: string | null;
}

export interface ConceptInput {
  code: string;
  display: string | null;
  terms: TermInput[];
  info?: Record<string, unknown> | null;
}

interface Term {
  concept: number;
  text: string;
  lang: string | null;
  kind: TermKind;
  compact: string;
  toks: Map<string, number>; // key → token weight
  mass: number; // Σ weight·idf (filled after idf)
}

interface Concept {
  code: string;
  display: string | null;
  info: Record<string, unknown> | null;
  group: string;
}

export interface QueryVariant {
  label: string;
  weight: number;
  toks: Tok[];
  compact: string;
  /** The normalised variant text. */
  text: string;
}

export interface LexHit {
  concept: number;
  score: number; // normalised to the query (≈ 0..1, exact ≥ 1.5)
  term: number;
  exact: boolean;
  variant: string;
  /** Share of the (variant's) query mass the best term covers, 0..1. */
  coverage?: number;
}

export interface SemHit {
  code: string;
  sim: number; // cosine similarity
  term: string;
  lang: string | null;
}

export interface RankedConcept {
  code: string;
  display: string | null;
  score: number;
  lexical: number;
  semantic: number | null;
  matchedTerm: string | null;
  matchedLang: string | null;
  matchedKind: TermKind | null;
  exact: boolean;
  source: "lexical" | "semantic" | "hybrid";
  info: Record<string, unknown> | null;
  group: string;
  /** Share of the query the best lexical term covers (0 without a lexical hit). */
  coverage: number;
}

const MAX_VARIANTS = 28;
/** Credit of a query word matched through another form of the same stem. */
const STEM_FORM_FACTOR = 0.8;
/** Variants that are the caller's own text (an exact match on them is an exact match). */
const LITERAL_VARIANTS = new Set(["text", "core", "core_no_brackets"]);

const SEGMENT_SPLIT = /[,;，；、()（）[\]{}/]|\s(?:for|before|after|under|on|at|via|due to|because of|since|then|and|plus|\+)\s/;

/** Clauses of a normalised query (split at punctuation, "/" lists and linking words), up to 4. */
export function querySegments(normalized: string): string[] {
  // Single-letter shorthand (c/s, l/s, u/s) is one token, not a list.
  const protectedText = normalized.replace(/(?<![a-z0-9])([a-z])\/(?=[a-z](?![a-z0-9]))/g, "$1\u0001");
  const parts = protectedText
    .split(new RegExp(SEGMENT_SPLIT.source, "g"))
    .map((x) => x.replace(/\u0001/g, "/"))
    .map((x) => x.replace(/\s+/g, " ").trim())
    .filter((x) => compact(x).length >= 2 && /[\p{L}]/u.test(x));
  if (parts.length < 2) return [];
  return [...new Set(parts)].slice(0, 4);
}

/** Lower-cased words of `text` that are written like abbreviations. */
/** Shorthand joined by "&" / "/" (I&D, U/A, Na/K) or a (hyphenated) word. */
const SHORTHAND_OR_WORD = /(?<![a-z0-9])[a-z]{1,2}[&/][a-z]{1,2}(?![a-z0-9/])|[a-z][a-z0-9]*(?:-[a-z0-9]+)?/gi;

export function abbreviationWords(text: string): Set<string> {
  const raw = String(text || "").normalize("NFKC");
  const primary = raw.match(SHORTHAND_OR_WORD) || [];
  const out = new Set<string>();
  const latinOnly = primary.length === 1 && !/[\p{Script=Han}]/u.test(raw);
  const check = (w: string, lone: boolean): void => {
    const upper = (w.match(/[A-Z]/g) || []).length;
    const abbr = upper >= 2 || (/\d/.test(w) && /[A-Za-z]/.test(w)) || (lone && w.length <= 6) || (upper === 1 && w.length <= 3 && w[0] !== w[0].toUpperCase());
    if (abbr) out.add(normalizeText(w));
  };
  for (const w of primary) {
    check(w, latinOnly);
    // The parts of shorthand ("Na/K") are judged as words of a longer text.
    if (/[&/]/.test(w)) for (const x of w.split(/[&/]/)) if (/^[A-Za-z]/.test(x)) check(x, false);
  }
  return out;
}

/**
 * Latin words of a normalised query that may be abbreviations: words, hyphenated words
 * (ca19-9, t-bil) and short shorthand joined by "&" or "/" (i&d, u/a, b/c).
 */
export function queryWords(normalized: string): string[] {
  const out: string[] = [];
  for (const w of normalized.match(SHORTHAND_OR_WORD) || []) {
    out.push(w);
    // The parts of "na/k" are words of their own.
    if (/[&/]/.test(w)) out.push(...w.split(/[&/]/).filter((x) => /^[a-z]/.test(x)));
  }
  return [...new Set(out)];
}

/** A phrase of the query (umlsNorm form) and other names of the same concept (synonym store). */
export interface PhraseSynonyms {
  phrase: string;
  alternatives: string[];
}

const MAX_SYNONYM_VARIANTS = 14;

/**
 * Sense selection for gap-filling expansions from the general abbreviation lexicon (one
 * object so evaluation harnesses can sweep it). A sense is scored by how well the
 * CodeSystem's own vocabulary names it ({@link ConceptIndex.supportHit}: lexical score capped
 * at `lexCap` + `popWeight` × usage of the concept it names) and must reach `lexiconMin`;
 * abbreviations shorter than `minLength` letters/digits are too ambiguous to expand from it.
 */
export const SENSES = { lexiconMin: 0.45, maxCandidates: 48, popWeight: 0.3, lexCap: 1, minLength: 3 };

/** Optional inputs of {@link prepareQuery}. */
export interface PrepareOptions {
  synonyms?: PhraseSynonyms[];
  /** Index of the target CodeSystem: ranks abbreviation senses by its vocabulary. */
  index?: ConceptIndex | null;
  /** Lower-cased query word → expansions from the abbreviation lexicon (already filtered by case rules). */
  lexicon?: Map<string, string[]>;
}

/**
 * Expansions of one abbreviation, best first: the thesaurus readings in their own order
 * (curated lexicon, then the most frequent mined expansion). Only when none of them is
 * named by the CodeSystem (support below `lexiconMin`) and the CodeSystem does not use the
 * abbreviation itself as a word, the general abbreviation lexicon fills the gap: its
 * senses are ranked by how well the CodeSystem names them, one reading per concept.
 */
export function rankSenses(
  word: string,
  thesaurus: Thesaurus,
  index: ConceptIndex | null | undefined,
  lexicon: string[] | undefined,
  max: number,
): string[] {
  const own = thesaurus.expansions(word, max);
  if (!index || !lexicon?.length || index.hasWord(word)) return own;
  if (thesaurus.expansions(word, 12).some((e) => index.support(e) >= SENSES.lexiconMin)) return own;
  const byConcept = new Set<number>();
  const ranked = [...new Set(lexicon)]
    .slice(0, SENSES.maxCandidates)
    .map((exp) => ({ exp, ...index.supportHit(exp) }))
    .filter((c) => c.score >= SENSES.lexiconMin)
    .sort((a, b) => b.score - a.score)
    .filter((c) => !byConcept.has(c.concept) && byConcept.add(c.concept) !== undefined)
    .map((c) => c.exp);
  return [...ranked, ...own].slice(0, max);
}

/** Build the weighted query variants of a free-text query. */
export function prepareQuery(text: string, thesaurus: Thesaurus | null, opts: PrepareOptions = {}): QueryVariant[] {
  const full = normalizeText(text);
  const core = clinicalCore(full);
  const bare = withoutBrackets(core);
  const out: QueryVariant[] = [];
  const seen = new Set<string>();
  const add = (label: string, s: string, weight: number): void => {
    const n = s.replace(/\s+/g, " ").trim();
    if (!n || seen.has(n) || out.length >= MAX_VARIANTS) return;
    seen.add(n);
    const toks = tokenize(n);
    if (!toks.length) return;
    out.push({ label, weight, toks, compact: compact(n), text: n });
  };
  add("text", full, 1);
  add("core", core, 1);
  add("core_no_brackets", bare, 0.97);
  // Synonyms of query phrases (UMLS): each reading replaces its phrase.
  if (opts.synonyms?.length) {
    const baseN = umlsNorm(core || full);
    let n = 0;
    for (const ps of opts.synonyms) {
      const re = new RegExp(`(?<![\\p{L}\\p{N}])${ps.phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "u");
      if (!re.test(baseN)) continue;
      for (const alt of ps.alternatives) {
        if (n >= MAX_SYNONYM_VARIANTS) break;
        const before = out.length;
        add("synonym", baseN.replace(re, ` ${normalizeText(alt)} `), 0.8);
        if (out.length > before) n += 1;
      }
    }
  }
  if (!thesaurus) return out;

  const base = core || full;
  // Acronym / abbreviation expansion, only for words written like abbreviations (TKA, HbA1c,
  // aPTT, CA19-9, I&D) or a lone short query word — never ordinary words ("test", "blood").
  const words = queryWords(base);
  const abbrevLike = abbreviationWords(text);
  const lexicon = opts.index ? opts.lexicon : undefined;
  const slots = words
    .filter((w) => abbrevLike.has(w) || thesaurus.curated.has(w) || Boolean(lexicon?.get(w)?.length))
    .map((w, _i, all) => ({ w, exps: rankSenses(w, thesaurus, opts.index, lexicon?.get(w), all.length === 1 ? 5 : 3) }))
    .filter((s) => s.exps.length > 0);
  const replaceWord = (s: string, w: string, rep: string): string =>
    s.replace(new RegExp(`(?<![a-z0-9])${w.replace(/[-&/]/g, "\\$&")}(?![a-z0-9])`, "g"), ` ${normalizeText(rep)} `);
  if (slots.length) {
    const rounds = Math.max(...slots.map((x) => x.exps.length));
    for (let k = 0; k < rounds; k += 1) {
      let s = base;
      let changed = false;
      for (const slot of slots) {
        const rep = slot.exps[Math.min(k, slot.exps.length - 1)];
        if (k > 0 && k >= slot.exps.length) continue;
        s = replaceWord(s, slot.w, rep);
        changed = true;
      }
      if (changed) add(`abbrev_${k}`, s, 0.9);
    }
    if (slots.length > 1) {
      for (const slot of slots) for (const rep of slot.exps.slice(0, 2)) add("abbrev_one", replaceWord(base, slot.w, rep), 0.85);
    }
  }
  // zh → en bridge (helps CodeSystems with English designations) and en → zh.
  let zhEn = base;
  let zhChanged = false;
  for (const [zh, en] of thesaurus.zhEn) {
    if (zh.length >= 2 && zhEn.includes(zh)) {
      zhEn = zhEn.split(zh).join(` ${en} `);
      zhChanged = true;
    }
  }
  if (zhChanged) add("zh_en", zhEn, 0.8);
  let enZh = base;
  let enChanged = false;
  for (const w of words) {
    const zs = thesaurus.enZh.get(w) ?? thesaurus.enZh.get(stemLatin(w));
    if (zs && zs.length) {
      enZh = replaceWord(enZh, w, zs[0]);
      enChanged = true;
    }
  }
  // Also expand abbreviations first, then bridge their words (hd → hemodialysis → 透析).
  for (const slot of slots) {
    for (const ew of normalizeText(slot.exps[0]).split(/\s+/)) {
      const zs = thesaurus.enZh.get(ew) ?? thesaurus.enZh.get(stemLatin(ew));
      if (zs && zs.length) {
        enZh = replaceWord(enZh, slot.w, zs[0]);
        enChanged = true;
        break;
      }
    }
  }
  if (enChanged) add("en_zh", enZh, 0.8);
  return out;
}

/** Usage below 10^floorLog10 counts as no usage (one object so harnesses can sweep it). */
export const POPULARITY = { floorLog10: 0 };

export class ConceptIndex {
  private readonly concepts: Concept[] = [];
  private readonly terms: Term[] = [];
  private readonly postings = new Map<string, number[]>();
  private readonly idf = new Map<string, number>();
  private readonly byCode = new Map<string, number>();
  private readonly groups = new Map<string, number[]>();
  private maxIdf = 1;
  private maxPopularity = 0;
  readonly termCount: number;

  constructor(input: Iterable<ConceptInput>) {
    for (const c of input) {
      const ci = this.concepts.length;
      const group = groupKey(c.display || c.terms.find((t) => t.kind === "display")?.text || "");
      this.concepts.push({ code: c.code, display: c.display, info: c.info ?? null, group });
      const pop = Number(c.info?.popularity);
      if (Number.isFinite(pop) && pop > this.maxPopularity) this.maxPopularity = pop;
      this.byCode.set(c.code, ci);
      if (group) {
        const g = this.groups.get(group);
        if (g) g.push(ci);
        else this.groups.set(group, [ci]);
      }
      const seen = new Set<string>();
      const all: TermInput[] = [{ text: c.code, lang: null, kind: "code" }, ...c.terms];
      for (const t of all) {
        const norm = normalizeText(t.text);
        const cmp = compact(norm);
        if (!cmp || seen.has(`${t.kind}|${cmp}`)) continue;
        seen.add(`${t.kind}|${cmp}`);
        const toks = new Map<string, number>();
        for (const tok of tokenize(norm)) toks.set(tokKey(tok), Math.max(toks.get(tokKey(tok)) ?? 0, tok.w));
        if (!toks.size) continue;
        const ti = this.terms.length;
        this.terms.push({ concept: ci, text: t.text, lang: t.lang, kind: t.kind, compact: cmp, toks, mass: 0 });
        for (const k of toks.keys()) {
          const p = this.postings.get(k);
          if (p) p.push(ti);
          else this.postings.set(k, [ti]);
        }
      }
    }
    const n = this.terms.length || 1;
    for (const [k, p] of this.postings) {
      const v = Math.log(1 + (n - p.length + 0.5) / (p.length + 0.5));
      this.idf.set(k, v);
      if (v > this.maxIdf) this.maxIdf = v;
    }
    for (const t of this.terms) {
      let m = 0;
      for (const [k, w] of t.toks) m += w * (this.idf.get(k) ?? 0);
      t.mass = m;
    }
    this.termCount = this.terms.length;
  }

  get size(): number {
    return this.concepts.length;
  }

  private supportCache = new Map<string, { score: number; concept: number }>();

  /**
   * How well the CodeSystem names a phrase on its own: the best lexical score of the phrase
   * against the index (capped at 1.2; ≈ 1 when it is a term) plus the usage prior of that
   * best concept, and which concept that is. Used to pick an abbreviation's sense: a sense
   * the CodeSystem names, and names for a commonly used concept, wins.
   */
  supportHit(phrase: string): { score: number; concept: number } {
    const key = normalizeText(phrase);
    const hit = this.supportCache.get(key);
    if (hit) return hit;
    const toks = tokenize(key);
    let out = { score: 0, concept: -1 };
    const top = toks.length ? this.search([{ label: "sense", weight: 1, toks, compact: compact(key), text: key }], 1)[0] : undefined;
    if (top) out = { score: Math.min(top.score, SENSES.lexCap) + SENSES.popWeight * this.popularity(top.concept), concept: top.concept };
    if (this.supportCache.size > 20000) this.supportCache.clear();
    this.supportCache.set(key, out);
    return out;
  }

  support(phrase: string): number {
    return this.supportHit(phrase).score;
  }

  /** Whether a (Latin, normalised) word occurs in the index, as is or stemmed. */
  hasWord(word: string): boolean {
    return this.postings.has(word) || this.postings.has(stemLatin(word));
  }

  /**
   * How commonly the concept is used, 0..1 on a log scale relative to the CodeSystem's most
   * used concept (info.popularity, e.g. annual claim volume); 0 when the CodeSystem carries
   * no usage data or the concept has none.
   */
  /** Whether any concept carries usage data. */
  get hasPopularity(): boolean {
    return this.maxPopularity > 0;
  }

  popularity(i: number): number {
    if (this.maxPopularity <= 0) return 0;
    const pop = Number(this.concepts[i]?.info?.popularity);
    if (!(Number.isFinite(pop) && pop > 0)) return 0;
    const floor = POPULARITY.floorLog10;
    const top = Math.log10(1 + this.maxPopularity);
    return top <= floor ? Math.log1p(pop) / Math.log1p(this.maxPopularity) : Math.max(0, (Math.log10(1 + pop) - floor) / (top - floor));
  }

  conceptAt(i: number): Concept {
    return this.concepts[i];
  }

  indexOf(code: string): number | undefined {
    return this.byCode.get(code);
  }

  codes(): IterableIterator<string> {
    return this.byCode.keys();
  }

  termAt(i: number): { text: string; lang: string | null; kind: TermKind } {
    const t = this.terms[i];
    return { text: t.text, lang: t.lang, kind: t.kind };
  }

  /** Other concepts sharing the group key (near-duplicate siblings), excluding `ci`. */
  siblings(ci: number, max = 6): number[] {
    const c = this.concepts[ci];
    if (!c?.group) return [];
    return (this.groups.get(c.group) || []).filter((x) => x !== ci).slice(0, max);
  }

  private tokIdf(key: string): number {
    return this.idf.get(key) ?? this.maxIdf;
  }

  private vocab: string[] | null = null;
  private prefixCache = new Map<string, { keys: Set<string>; idf: number } | null>();

  /**
   * Latin index words that a query word not in the index is a prefix of — clinical
   * truncations ("abd" → abdominal, "retic" → reticulocyte, "vanco" → vancomycin).
   * Too-unspecific prefixes (> 40 words) are ignored.
   */
  private prefixFamily(key: string): { keys: Set<string>; idf: number } | null {
    if (this.prefixCache.has(key)) return this.prefixCache.get(key)!;
    let out: { keys: Set<string>; idf: number } | null = null;
    if (key.length >= 3 && /^[a-z][a-z0-9]*$/.test(key) && !this.postings.has(key)) {
      if (!this.vocab) this.vocab = [...this.postings.keys()].filter((k) => /^[a-z][a-z0-9]{3,}$/.test(k)).sort();
      const v = this.vocab;
      let lo = 0;
      let hi = v.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (v[mid] < key) lo = mid + 1;
        else hi = mid;
      }
      const keys = new Set<string>();
      for (let i = lo; i < v.length && v[i].startsWith(key); i += 1) keys.add(v[i]);
      if (keys.size && keys.size <= 40) {
        const docs = new Set<number>();
        for (const k of keys) for (const ti of this.postings.get(k)!) docs.add(ti);
        const n = this.terms.length || 1;
        out = { keys, idf: Math.log(1 + (n - docs.size + 0.5) / (docs.size + 0.5)) };
      }
    }
    this.prefixCache.set(key, out);
    return out;
  }

  private stemCache = new Map<string, string[] | null>();

  /**
   * Other forms of a long Latin query word: index words sharing its first 6 letters
   * ("recurrent" ↔ recurrence, "laparoscopic" ↔ laparoscopy, "anesthesia" ↔ anesthetic).
   * Matched at a discount when the word itself is not in a term. Up to 12 forms.
   */
  private stemForms(key: string): string[] | null {
    if (this.stemCache.has(key)) return this.stemCache.get(key)!;
    let out: string[] | null = null;
    if (key.length >= 7 && /^[a-z]+$/.test(key)) {
      if (!this.vocab) this.vocab = [...this.postings.keys()].filter((k) => /^[a-z][a-z0-9]{3,}$/.test(k)).sort();
      const v = this.vocab;
      const stem = key.slice(0, 6);
      let lo = 0;
      let hi = v.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (v[mid] < stem) lo = mid + 1;
        else hi = mid;
      }
      const forms: string[] = [];
      for (let i = lo; i < v.length && v[i].startsWith(stem); i += 1) if (v[i] !== key && v[i].length >= 7) forms.push(v[i]);
      if (forms.length && forms.length <= 12) out = forms;
    }
    this.stemCache.set(key, out);
    return out;
  }

  /** Lexical ranking: best (concept, term) score over all variants. */
  search(variants: QueryVariant[], limit = 50): LexHit[] {
    const best = new Map<number, { hit: LexHit; sum: number }>();
    const nTerms = this.terms.length || 1;
    for (const v of variants) {
      const perVariant = new Map<number, LexHit>();
      const qtoks = v.toks.map((t) => {
        const key = tokKey(t);
        const fam = t.k === "w" ? this.prefixFamily(key) : null;
        const forms = t.k === "w" && !fam ? this.stemForms(key) : null;
        return { key, w: t.w, k: t.k, fam, forms, idf: fam ? fam.idf : this.tokIdf(key) };
      });
      let qMass = 0;
      for (const q of qtoks) qMass += q.w * q.idf;
      if (qMass <= 0) continue;
      // Candidate terms: postings of the selective tokens (unigrams only when there is nothing else).
      const hasStrong = qtoks.some((q) => q.k !== "u" && this.postings.has(q.key));
      const cand = new Set<number>();
      for (const q of qtoks) {
        if (hasStrong && q.k === "u") continue;
        if (q.fam) {
          for (const k of q.fam.keys) for (const ti of this.postings.get(k)!) cand.add(ti);
          continue;
        }
        if (q.forms) for (const k of q.forms) for (const ti of this.postings.get(k)!) cand.add(ti);
        const p = this.postings.get(q.key);
        if (!p) continue;
        if (nTerms > 200 && p.length > nTerms * 0.25 && qtoks.length > 1) continue;
        for (const ti of p) cand.add(ti);
      }
      // A query that is exactly a term (code / name) must be found even through common tokens.
      for (const q of qtoks) {
        const p = this.postings.get(q.key);
        if (p && p.length > nTerms * 0.25) for (const ti of p) if (this.terms[ti].compact === v.compact) cand.add(ti);
      }
      for (const ti of cand) {
        const t = this.terms[ti];
        let matched = 0;
        let matchedTermSide = 0;
        for (const q of qtoks) {
          let tw = t.toks.get(q.key);
          let factor = 1;
          if (tw === undefined && q.fam) {
            for (const k of q.fam.keys) {
              const x = t.toks.get(k);
              if (x !== undefined) {
                tw = x;
                factor = 0.75;
                break;
              }
            }
          }
          if (tw === undefined && q.forms) {
            for (const k of q.forms) {
              const x = t.toks.get(k);
              if (x !== undefined) {
                tw = x;
                factor = STEM_FORM_FACTOR;
                break;
              }
            }
          }
          if (tw === undefined) continue;
          matched += Math.min(q.w, tw) * q.idf * factor;
          matchedTermSide += tw * q.idf;
        }
        if (matched <= 0) continue;
        const qcov = Math.min(1, matched / qMass);
        const tcov = t.mass > 0 ? Math.min(1, matchedTermSide / t.mass) : 0;
        let s = qcov * (0.3 + 0.7 * tcov) + 0.15 * tcov * qcov;
        let exact = false;
        if (t.compact === v.compact && v.compact.length >= 1 && LITERAL_VARIANTS.has(v.label) && t.kind !== "umls") {
          // The text as typed (not a thesaurus reading of it) names this concept exactly.
          s = 1.5 + (t.kind === "display" ? 0.2 : t.kind === "code" ? 0.3 : 0.1);
          exact = true;
        } else if (t.compact === v.compact && v.compact.length >= 1) {
          s = Math.max(s, 1);
        } else if (v.compact.length >= 2 && t.compact.includes(v.compact)) {
          s *= t.compact.startsWith(v.compact) ? 1.25 : 1.15;
        } else if (t.compact.length >= 2 && v.compact.includes(t.compact)) {
          s *= 1.15;
        }
        s *= KIND_WEIGHT[t.kind] * v.weight;
        if (t.kind === "code" && !exact) s *= 0.3;
        const prev = perVariant.get(t.concept);
        if (!prev || s > prev.score) perVariant.set(t.concept, { concept: t.concept, score: s, term: ti, exact, variant: v.label, coverage: exact ? 1 : qcov * v.weight });
      }
      for (const [ci, h] of perVariant) {
        const agg = best.get(ci);
        if (!agg) best.set(ci, { hit: h, sum: h.score });
        else {
          agg.sum += h.score;
          if (h.score > agg.hit.score) agg.hit = h;
        }
      }
    }
    // A concept keeps its best variant score, plus a little for agreeing variants (the full
    // text and its clauses all pointing at it beats a single clause match).
    return [...best.values()]
      .map(({ hit, sum }) => ({ ...hit, score: hit.score + 0.08 * Math.min(sum - hit.score, 2) }))
      .sort((a, b) => b.score - a.score || a.concept - b.concept)
      .slice(0, limit);
  }
}

export interface FuseOptions {
  lexWeight?: number;
  semWeight?: number;
  /**
   * Absolute cosine similarity at or below which a semantic hit carries no weight. Off by
   * default: absolute similarity levels are model-specific (Qwen3-Embedding-0.6B put unrelated
   * text at ~0.7, the 4B model with a query instruction puts the best match at ~0.6–0.75), so
   * the channel is calibrated on the query's own similarity distribution instead.
   */
  semFloor?: number;
  /** Absolute top similarity for full confidence (only with semFloor). */
  semFull?: number;
  /** Rank in the similarity list whose value is the "zero" of the rescaled score. */
  semFloorRank?: number;
  /** Gap between the best similarity and the floor at which the channel gets full confidence. */
  semGap?: number;
  /** Weight of the usage prior ({@link ConceptIndex.popularity}). */
  popWeight?: number;
  /**
   * Sibling ordering (needs usage data): within a group of near-duplicate siblings (same
   * name before a method / setting / size qualifier), members whose query coverage is within
   * this of the group's best are ordered by usage instead of by vector noise. ≤ 0 = off.
   */
  siblingLexTol?: number;
  /** …and when the query matched none of the group lexically, members within this similarity. */
  siblingSimTol?: number;
}

/** Defaults of {@link FuseOptions} (one object so evaluation harnesses can sweep them). */
export const FUSE_DEFAULTS = { lexWeight: 0.55, semWeight: 0.45, semFloorRank: 40, semGap: 0.12, popWeight: 0.3, siblingLexTol: 0.05, siblingSimTol: 0.02 };

/**
 * Hybrid fusion of lexical hits and semantic hits (cosine similarities of the query
 * vector to term vectors, best per concept). Exact name/code matches stay on top.
 */
export function fuse(index: ConceptIndex, lex: LexHit[], sem: SemHit[] | null, limit: number, opts: FuseOptions = {}): RankedConcept[] {
  const lw = opts.lexWeight ?? FUSE_DEFAULTS.lexWeight;
  const sw = opts.semWeight ?? FUSE_DEFAULTS.semWeight;
  const pw = opts.popWeight ?? FUSE_DEFAULTS.popWeight;
  const semBest = new Map<number, SemHit>();
  for (const h of sem || []) {
    const ci = index.indexOf(h.code);
    if (ci === undefined) continue;
    const prev = semBest.get(ci);
    if (!prev || h.sim > prev.sim) semBest.set(ci, h);
  }
  const sims = [...semBest.values()].map((h) => h.sim).sort((a, b) => b - a);
  const top = sims[0] ?? 0;
  // Similarities are rescaled within the query's own distribution (best = 1, the value at
  // rank semFloorRank = 0), and the whole channel is trusted less when the best hit barely
  // stands out from the crowd (a short abbreviation embeds poorly).
  const rankFloor = sims.length ? sims[Math.min(sims.length - 1, opts.semFloorRank ?? FUSE_DEFAULTS.semFloorRank)] : 0;
  const floor = Math.max(opts.semFloor ?? 0, rankFloor);
  const span = Math.max(top - floor, 0.03);
  const conf =
    opts.semFloor !== undefined
      ? Math.max(0, Math.min(1, (top - floor) / Math.max((opts.semFull ?? 0.9) - floor, 0.01)))
      : Math.max(0, Math.min(1, (top - floor) / (opts.semGap ?? FUSE_DEFAULTS.semGap)));
  const semNorm = (sim: number): number => Math.max(0, Math.min(1, (sim - floor) / span)) * conf;

  const lexBest = new Map<number, LexHit>();
  for (const h of lex) lexBest.set(h.concept, h);
  const ids = new Set<number>([...lexBest.keys(), ...semBest.keys()]);
  const out: RankedConcept[] = [];
  const hasSem = semBest.size > 0;
  for (const ci of ids) {
    const l = lexBest.get(ci);
    const s = semBest.get(ci);
    const lexScore = l ? Math.min(l.score, 2) : 0;
    const semScore = s ? semNorm(s.sim) : 0;
    let score = hasSem ? lw * Math.min(lexScore, 1.2) + sw * semScore : lexScore;
    if (l?.exact) score += 1;
    score += pw * index.popularity(ci);
    const c = index.conceptAt(ci);
    const useLexTerm = l && (!s || lw * lexScore >= sw * semScore);
    let term = useLexTerm ? index.termAt(l!.term) : null;
    // UMLS strings are licensed data: report the concept's own name instead.
    if (term && term.kind === "umls") term = { text: c.display ?? c.code, lang: c.display ? guessLang(c.display) : null, kind: "display" };
    out.push({
      code: c.code,
      display: c.display,
      score,
      lexical: lexScore,
      semantic: s ? s.sim : null,
      matchedTerm: term ? term.text : s ? s.term : null,
      matchedLang: term ? term.lang : s ? s.lang : null,
      matchedKind: term ? term.kind : s ? "designation" : null,
      exact: Boolean(l?.exact),
      source: l && s ? "hybrid" : l ? "lexical" : "semantic",
      info: c.info,
      group: c.group,
      coverage: l?.coverage ?? 0,
    });
  }
  orderSiblings(index, out, pw, opts.siblingLexTol ?? FUSE_DEFAULTS.siblingLexTol, opts.siblingSimTol ?? FUSE_DEFAULTS.siblingSimTol);
  out.sort((a, b) => b.score - a.score || a.code.localeCompare(b.code));
  return out.slice(0, limit);
}

/** Query coverage above which a group is said to be matched by the query's words. */
const SIBLING_LEX_SIGNAL = 0.3;

/**
 * Within each sibling group, hand the group's relevance scores (best first) to its members
 * the query cannot tell apart from the best one — same exact-match status and nearly the
 * same lexical score (or, without lexical evidence, nearly the same similarity) — most used
 * first; the rest keep their order. The group keeps its place among other candidates. A
 * query naming the qualifier ("住院 洗腎", "復發性") still wins: it lifts that sibling's
 * lexical score out of the tie. No-op without usage data.
 */
function orderSiblings(index: ConceptIndex, out: RankedConcept[], pw: number, lexTol: number, simTol: number): void {
  if (lexTol <= 0 || !index.hasPopularity) return;
  const groups = new Map<string, RankedConcept[]>();
  for (const r of out) {
    if (!r.group) continue;
    const g = groups.get(r.group);
    if (g) g.push(r);
    else groups.set(r.group, [r]);
  }
  const pop = (r: RankedConcept): number => {
    const ci = index.indexOf(r.code);
    return ci === undefined ? 0 : index.popularity(ci);
  };
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const rel = (r: RankedConcept): number => r.score - pw * pop(r);
    const best = members.reduce((a, b) => (rel(b) > rel(a) ? b : a));
    // Tied = covers as much of the query as the best-covering sibling (a qualifier the query
    // names is covered by one sibling only), or nearly the same similarity without words.
    const maxCov = Math.max(...members.map((m) => m.coverage));
    const maxSim = Math.max(...members.map((m) => m.semantic ?? -1));
    const tied = (m: RankedConcept): boolean =>
      m.exact === best.exact &&
      (maxCov >= SIBLING_LEX_SIGNAL ? m.coverage >= maxCov - lexTol : m.semantic !== null && m.semantic >= maxSim - simTol);
    const scores = members.map(rel).sort((a, b) => b - a);
    const head = members.filter(tied).sort((a, b) => pop(b) - pop(a) || rel(b) - rel(a));
    const rest = members.filter((m) => !tied(m)).sort((a, b) => rel(b) - rel(a));
    [...head, ...rest].forEach((m, i) => (m.score = scores[i] + pw * pop(m)));
  }
}


/** Codes that look like a mistyped `code` (same prefix / small edit distance). */
export function nearCodes(codes: Iterable<string>, code: string, max = 5): string[] {
  const target = code.trim().toUpperCase();
  if (!target) return [];
  const scored: Array<[string, number]> = [];
  for (const c of codes) {
    const u = c.toUpperCase();
    if (u === target) continue;
    const d = editDistance(u, target, 2);
    let s = d <= 2 ? 3 - d : 0;
    let pre = 0;
    while (pre < u.length && pre < target.length && u[pre] === target[pre]) pre += 1;
    if (pre >= Math.max(3, target.length - 2)) s = Math.max(s, 0.5 + pre / target.length);
    if (s > 0) scored.push([c, s]);
  }
  return scored
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([c]) => c);
}

/** Levenshtein distance with an early cut-off (returns max+1 when larger). */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}
