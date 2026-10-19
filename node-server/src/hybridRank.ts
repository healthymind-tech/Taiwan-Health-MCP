/**
 * Score-aware hybrid ranking for the terminology search tools (pure, no I/O).
 *
 * Used by search_medical_codes (ICD-10-CM), search_loinc, search_snomed_concept and
 * the SNOMED / LOINC / ICD branches of fhir_normalize_code. Each caller gathers a
 * candidate pool (full-text matches ∪ nearest vectors), the cosine similarity of
 * EVERY candidate to the query vector, the names to match against and a weak prior;
 * this module orders them.
 *
 * Why not reciprocal-rank fusion: RRF only sees positions, so twenty weak lexical
 * hits ("Heart failure with …", "… due to heart failure") outvote the concept the
 * vector search ranks first by a wide margin. Here both channels keep their
 * strength:
 *
 *  - lexical  = how well the query and a name cover each other (tokens of
 *               conceptSearch/text.ts: Latin words, CJK bigrams), so a short query
 *               prefers the concept whose name it *is* over longer names that merely
 *               contain it — the generic counter to "short query → overly specific
 *               sub-concept". Generic qualifiers ("unspecified", 未明示) do not count
 *               against a name.
 *  - semantic = the cosine similarity rescaled within the pool (best = 1, the
 *               pool's lower tail = 0).
 *  - prior    = a small additive per-candidate prior supplied by the caller
 *               (ICD code depth, LOINC common-test rank / status, SNOMED name length).
 *
 * A guard keeps the vector channel's best candidates in the result: a strong
 * semantic match can never be pushed out of the top-k by weak lexical hits.
 */

import { compact, normalizeText, tokenize, tokKey, type Tok } from "./conceptSearch/text.js";

/** A name of a candidate to match the query against, with its field's trust. */
export interface RankText {
  text: string | null | undefined;
  weight?: number;
}

export interface RankCandidate {
  key: string;
  texts: RankText[];
  /** Cosine similarity to the query vector; null when the candidate has no vector. */
  sim: number | null;
  /** Additive prior (keep within about ±0.15). */
  prior?: number;
  /**
   * Candidates that name the same thing and differ only in qualifiers (e.g. the LOINC terms
   * of one analyte: specimen, mass vs molar unit, method). Within a family the members the
   * query text cannot tell apart are ordered by {@link defaultness}, not by vector noise.
   */
  family?: string | null;
  /** How much this member is the family's default reading (higher = more standard / common). */
  defaultness?: number;
}

export interface RankedCandidate {
  key: string;
  score: number;
  lexical: number;
  semantic: number;
  sim: number | null;
  exact: boolean;
  source: "lexical" | "semantic" | "hybrid";
  /** Share of the query's words found in the best-covering name (0..1). */
  coverage: number;
}

export interface RankOptions {
  lexWeight?: number;
  semWeight?: number;
  /** Added when the query is (one of) the candidate's names verbatim. */
  exactBonus?: number;
  /** How many of the vector channel's best candidates are guaranteed a place in the top `limit`. */
  semanticKeep?: number;
  /** Rank in the similarity order whose value is the "zero" of the rescaled semantic score. */
  semFloorRank?: number;
  /**
   * Smallest similarity span mapped onto 0..1: when the pool's best match barely stands out
   * (top − floor below this), the semantic score stays proportionally small instead of
   * blowing a 0.02 cosine difference up to the full range.
   */
  semSpan?: number;
  /**
   * Family ordering: members whose query coverage (share of the query's words their names
   * contain) is within this of the family's best are indistinguishable by the query's words
   * (it named the family, not a qualifier).
   */
  familyLexTol?: number;
  /** Below this best coverage the query matched the family only through the vector channel. */
  familyLexSignal?: number;
  /** …and then members within this cosine similarity of the family's best are indistinguishable. */
  familySimTol?: number;
}

/** Qualifier words that never make a name less specific to the query. */
const GENERIC = new Set<string>([
  "unspecified", "nos", "specified", "otherwise", "nec", "classified", "elsewhere",
]);
/** CJK qualifiers (as bigrams) with the same role: 未明示, 未特定, 其他. */
const GENERIC_CJK = new Set<string>(["b:未明", "b:明示", "b:未特", "b:特定", "b:其他"]);

function isGeneric(t: Tok): boolean {
  return t.k === "w" ? GENERIC.has(t.t) : t.k === "b" ? GENERIC_CJK.has(tokKey(t)) : false;
}

interface Prepared {
  toks: Map<string, number>;
  mass: number;
  compact: string;
}

function prepare(text: string, dropGeneric: boolean): Prepared {
  const n = normalizeText(text);
  const toks = new Map<string, number>();
  let mass = 0;
  for (const t of tokenize(n)) {
    if (dropGeneric && isGeneric(t)) continue;
    const k = tokKey(t);
    if (toks.has(k)) continue;
    toks.set(k, t.w);
    mass += t.w;
  }
  return { toks, mass, compact: compact(n) };
}

/** Compact form of a name without its generic qualifiers ("Heart failure, unspecified" → "heartfailure"). */
function compactCore(text: string): string {
  const n = normalizeText(text)
    .replace(/\b(?:unspecified|nos|not otherwise specified|not elsewhere classified)\b/g, " ")
    .replace(/未明示|未特定/g, " ");
  return compact(n);
}

/** Score of a query that is a whole delimited part of a name (below an exact name match). */
const SEGMENT_SCORE = 0.85;

/** Compact parts of a name split at punctuation / brackets (not at spaces). */
function segments(name: string): string[] {
  return normalizeText(name)
    .split(/[,，、;；:：()（）[\]{}\/|]+/)
    .map((x) => compact(x))
    .filter((x) => x.length >= 2);
}

/**
 * Lexical match of a query to one name, 0..1 (1 = the query is the name).
 * Query coverage dominates; name coverage separates "is" from "contains".
 */
export function lexicalMatch(query: string, name: string): { score: number; exact: boolean; coverage: number } {
  const q = prepare(query, false);
  if (!q.mass || !name) return { score: 0, exact: false, coverage: 0 };
  const qc = q.compact;
  if (qc && (compact(normalizeText(name)) === qc || compactCore(name) === qc)) return { score: 1, exact: true, coverage: 1 };
  const t = prepare(name, true);
  if (!t.mass) return { score: 0, exact: false, coverage: 0 };
  let qm = 0;
  let tm = 0;
  for (const [k, w] of q.toks) {
    const tw = t.toks.get(k);
    if (tw === undefined) continue;
    qm += Math.min(w, tw);
    tm += tw;
  }
  if (qm <= 0) return { score: 0, exact: false, coverage: 0 };
  const qcov = Math.min(1, qm / q.mass);
  const tcov = Math.min(1, tm / t.mass);
  let s = qcov * (0.35 + 0.65 * tcov);
  // The query is one whole delimited part of the name ("高血壓" in "本態性(原發性)高血壓",
  // "hypertension" in "Essential (primary) hypertension"): the name names it, with qualifiers.
  if (qc.length >= 2 && segments(name).includes(qc)) s = Math.max(s, SEGMENT_SCORE);
  // Whole-query containment ("heart failure" inside "congestive heart failure").
  if (qc.length >= 2 && t.compact.includes(qc)) s *= 1.1;
  return { score: Math.min(s, 0.95), exact: false, coverage: qcov };
}

/** Defaults of {@link RankOptions} (one object so evaluation harnesses can sweep them). */
export const RANK_DEFAULTS: Required<RankOptions> = {
  lexWeight: 0.5,
  semWeight: 0.5,
  exactBonus: 0.25,
  semanticKeep: 2,
  semFloorRank: 30,
  semSpan: 0.1,
  familyLexTol: 0.03,
  familyLexSignal: 0.3,
  familySimTol: 0.2,
};

/**
 * Within each family, hand the family's scores (best first) to its members in this order:
 * the members the query cannot tell apart from the family's best match — the same share of
 * the query's words covered, or, when the query matched no name of the family, nearly the
 * same similarity — most
 * default first; then the rest by their own score. The family's place among other
 * candidates is unchanged; only which member holds it changes. "hemoglobin" thus lands on
 * the commonly resulted Hemoglobin [Mass/volume] in Blood rather than on whichever
 * specimen / unit variant the embedding happens to put first, while "arterial lactate"
 * still prefers the arterial term (it matches more of the query).
 */
function orderFamilies(scored: RankedCandidate[], meta: Map<string, { family: string; defaultness: number; prior: number }>, o: Required<RankOptions>): void {
  const fams = new Map<string, RankedCandidate[]>();
  for (const c of scored) {
    const m = meta.get(c.key);
    if (!m) continue;
    const list = fams.get(m.family);
    if (list) list.push(c);
    else fams.set(m.family, [c]);
  }
  for (const members of fams.values()) {
    if (members.length < 2) continue;
    // Relevance (score without the member's own prior) moves; each member keeps its prior.
    const prior = (m: RankedCandidate): number => meta.get(m.key)!.prior;
    const scores = members.map((m) => m.score - prior(m)).sort((a, b) => b - a);
    // "Cannot tell apart": the member's names cover as much of the query as the family's
    // best-covering member ("hemoglobin" — every specimen / unit variant; "CSF protein" —
    // only the CSF term covers "csf"), or, when no name of the family covers the query
    // (a Chinese query against English names), nearly the same similarity.
    const maxCov = Math.max(...members.map((m) => m.coverage));
    const maxSim = Math.max(...members.map((m) => m.sim ?? -1));
    const tied = (m: RankedCandidate): boolean =>
      maxCov >= o.familyLexSignal ? m.coverage >= maxCov - o.familyLexTol : m.sim !== null && m.sim >= maxSim - o.familySimTol;
    const def = (m: RankedCandidate): number => meta.get(m.key)!.defaultness;
    const head = members.filter(tied).sort((a, b) => def(b) - def(a) || b.score - a.score);
    const rest = members.filter((m) => !tied(m)).sort((a, b) => b.score - a.score);
    [...head, ...rest].forEach((m, i) => (m.score = scores[i] + prior(m)));
  }
}

/** Order a candidate pool. Returns at most `limit` candidates, best first. */
export function rankHybrid(query: string, candidates: RankCandidate[], limit: number, opts: RankOptions = {}): RankedCandidate[] {
  const lw = opts.lexWeight ?? RANK_DEFAULTS.lexWeight;
  const sw = opts.semWeight ?? RANK_DEFAULTS.semWeight;
  const exactBonus = opts.exactBonus ?? RANK_DEFAULTS.exactBonus;
  const keep = opts.semanticKeep ?? RANK_DEFAULTS.semanticKeep;
  const floorRank = opts.semFloorRank ?? RANK_DEFAULTS.semFloorRank;
  const minSpan = opts.semSpan ?? RANK_DEFAULTS.semSpan;
  const all: Required<RankOptions> = { ...RANK_DEFAULTS, ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)) };

  const sims = candidates.map((c) => c.sim).filter((s): s is number => typeof s === "number" && Number.isFinite(s)).sort((a, b) => b - a);
  const hasSem = sims.length > 0;
  const top = sims[0] ?? 0;
  const floor = sims.length ? sims[Math.min(sims.length - 1, floorRank)] : 0;
  const span = Math.max(top - floor, minSpan);
  const semNorm = (sim: number | null): number => (sim === null || !hasSem ? 0 : Math.max(0, Math.min(1, (sim - floor) / span)));

  const scored: RankedCandidate[] = candidates.map((c) => {
    let lex = 0;
    let exact = false;
    let coverage = 0;
    for (const t of c.texts) {
      if (!t.text) continue;
      const m = lexicalMatch(query, t.text);
      const w = t.weight ?? 1;
      const v = m.score * w;
      if (v > lex) lex = v;
      if (m.coverage > coverage) coverage = m.coverage;
      if (m.exact && w >= 0.85) exact = true;
    }
    const sem = semNorm(c.sim);
    const score = (hasSem ? lw * lex + sw * sem : lex) + (exact ? exactBonus : 0) + (c.prior ?? 0);
    const source: RankedCandidate["source"] = lex > 0.2 && sem > 0.5 ? "hybrid" : lex >= sem ? "lexical" : "semantic";
    return { key: c.key, score, lexical: lex, semantic: sem, sim: c.sim, exact, source, coverage };
  });
  const meta = new Map<string, { family: string; defaultness: number; prior: number }>();
  for (const c of candidates) if (c.family) meta.set(c.key, { family: c.family, defaultness: c.defaultness ?? 0, prior: c.prior ?? 0 });
  if (meta.size > 1) orderFamilies(scored, meta, all);
  scored.sort((a, b) => b.score - a.score || (b.sim ?? -1) - (a.sim ?? -1) || a.key.localeCompare(b.key));
  const out = scored.slice(0, limit);
  if (hasSem && keep > 0 && limit >= 3) {
    // Guarantee: the vector channel's best `keep` candidates stay in the result.
    const bySim = [...scored].filter((c) => c.sim !== null).sort((a, b) => (b.sim ?? 0) - (a.sim ?? 0)).slice(0, keep);
    for (const s of bySim) {
      if (out.some((o) => o.key === s.key)) continue;
      // Replace the lowest-ranked candidate that is not itself protected or exact.
      for (let i = out.length - 1; i >= 0; i -= 1) {
        if (out[i].exact || bySim.some((b) => b.key === out[i].key)) continue;
        out[i] = s;
        break;
      }
    }
    out.sort((a, b) => b.score - a.score || (b.sim ?? -1) - (a.sim ?? -1) || a.key.localeCompare(b.key));
  }
  return out;
}
