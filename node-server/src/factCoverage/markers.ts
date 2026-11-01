/**
 * fhir_check_fact_coverage step 1 + 2: is the quote in the record, and does the clause around it make the fact unusable?
 *
 * Quote matching is lenient only about spelling, never about content: NFKC (full-width → half-width, lower case) with
 * whitespace collapsed first; then the grounding normalisation (grounding/lexicon.ts `norm`: whitespace and most
 * punctuation dropped). A quote found neither way is `quote-not-in-record` (a fabricated basis).
 *
 * The clause around a found quote is the stretch of its line between clause delimiters (，,；;。 brackets, list
 * enumerators). Markers reuse the v17.x vocabularies — grounding negation cues (NEG_CUES), observation-history cues
 * (OBS_HIST_CUES), the record checks' diagnosis-uncertainty cues (recordChecks/lexicon `cuesIn`) and clause-level
 * absence classes (`clausesOf`: pending result, undecided, not done, not obtained …) — plus the v17.4 stale-value cue
 * set (mirrors recordChecks/valueGrounding.ts RE_STALE, which is module-private). Prefix cues count only before the
 * quote (or inside it), postfix cues only after it (or inside it); stale cues anywhere in the clause.
 *
 * A marker the fact itself carries is not a reason to drop the fact: when the value / attribute states the negation,
 * the uncertainty or the old / stopped state (無, negative, provisional, 疑似, inactive …), the fact is ABOUT that
 * state and stays usable.
 */
import { NEG_CUES, OBS_HIST_CUES, nfkc, normWithMap } from "../grounding/lexicon.js";
import { clausesOf, cuesIn } from "../recordChecks/lexicon.js";

export type MarkerClass = "negated" | "unconfirmed" | "stale" | "pending" | "not-applicable" | "not-done";

export interface Marker {
  cls: MarkerClass;
  /** The cue as found (NFKC, lower case). */
  cue: string;
}

export interface QuoteHit {
  /** UTF-16 span of the quote in source_text. */
  start: number;
  end: number;
  match: "exact" | "normalized";
}

/** NFKC + lower case with every whitespace run collapsed to one space, and the map back to source offsets. */
function collapsed(text: string): [string, number[]] {
  let out = "";
  const idx: number[] = [];
  let i = 0;
  let space = false;
  for (const c of text) {
    for (const ch of nfkc(c)) {
      if (/\s/u.test(ch)) {
        if (!space && out.length) {
          out += " ";
          idx.push(i);
        }
        space = true;
      } else {
        out += ch;
        idx.push(i);
        space = false;
      }
    }
    i += c.length;
  }
  return [out, idx];
}

function spanOf(map: number[], k: number, len: number, text: string): [number, number] {
  const start = map[k];
  const lastStart = map[k + len - 1];
  // end = the end of the source code point holding the last matched character
  const cp = text.codePointAt(lastStart) ?? 0;
  return [start, lastStart + (cp > 0xffff ? 2 : 1)];
}

/** Where the quote is in source_text (first occurrence), or null when it is not there. */
export function findQuote(source: string, quote: string): QuoteHit | null {
  const q0 = collapsed(quote)[0].trim();
  if (!q0) return null;
  const [s1, m1] = collapsed(source);
  const k1 = s1.indexOf(q0);
  if (k1 >= 0) {
    const [start, end] = spanOf(m1, k1, q0.length, source);
    return { start, end, match: "exact" };
  }
  const q2 = normWithMap(quote)[0];
  if (!q2) return null;
  const [s2, m2] = normWithMap(source);
  const k2 = s2.indexOf(q2);
  if (k2 < 0) return null;
  const [start, end] = spanOf(m2, k2, q2.length, source);
  return { start, end, match: "normalized" };
}

const RE_CUT = /[，,；;。（）()［］[\]【】\n\r]/u;
/** A list enumerator starting a new item ("1. HTN 2. r/o DM"): the clause ends before it. */
const RE_ENUM = /(?:^|\s)(?:\d{1,2}[.)、]|[(（]\d{1,2}[)）])\s*$/u;

/** The clause holding [start, end): bounded by clause delimiters and list enumerators; the quote itself is never cut. */
export function clauseAround(source: string, start: number, end: number): { start: number; end: number } {
  let a = start;
  while (a > 0 && !RE_CUT.test(source[a - 1])) {
    if (RE_ENUM.test(source.slice(Math.max(0, a - 6), a)) && a < start) break;
    a--;
  }
  let b = end;
  while (b < source.length && !RE_CUT.test(source[b])) {
    if (b > end && /\s/u.test(source[b - 1]) && /^(?:\d{1,2}[.)、]|[(（]\d{1,2}[)）])\s/u.test(source.slice(b, b + 5))) break;
    b++;
  }
  return { start: a, end: b };
}

/** v17.4 stale / not-applicable / pending cues (same set as recordChecks/valueGrounding.ts RE_STALE). */
const STALE: Array<[RegExp, MarkerClass]> = [
  [/已不適用|不再適用|不適用|not applicable|no longer (?:valid|applicable)|\bn\/a\b/iu, "not-applicable"],
  [/已失效|失效|舊值|outdated|\bold (?:value|result|reading|weight|measurement)\b|已停用|作廢|cancell?ed/iu, "stale"],
  [/前次|上次|先前|移植前|\bpreviously\b|\bprevious\b|\bprior\b(?! to)|\bformer\b/iu, "stale"],
  [/待補|待測|本次未測|未測量|未量|not measured|\bpending\b/iu, "pending"],
];

const LATIN = /[a-z0-9]/u;
/** Characters between a negation cue and the quote within which the cue still governs it. */
const NEG_REACH = 10;
const NOT_NEG = /^(?:無法|無誤|無礙|未來|未滿)/u;
/** NEG_CUES entries that rule an item out (not established) rather than negate it. */
const RULE_OUT = new Set(["r/o", "rule out", "rule-out", "排除", "不考慮", "不支持", "ruled out"]);

function occurrences(t: string, cue: string): number[] {
  const out: number[] = [];
  const c = cue.trimEnd() === cue ? cue : cue.trimEnd();
  for (let i = t.indexOf(c); i >= 0; i = t.indexOf(c, i + 1)) {
    const j = i + c.length;
    if (LATIN.test(c[0]) && i > 0 && LATIN.test(t[i - 1])) continue;
    if (LATIN.test(c[c.length - 1]) && j < t.length && LATIN.test(t[j])) continue;
    out.push(i);
  }
  return out;
}

/** Words in the value / attribute that say the fact is about the marked state itself. */
const REFLECTS: Record<MarkerClass, RegExp> = {
  negated: /^(?:無|否|沒有|未|陰性|none|no|negative|denied|denies|absent|false|refuted|nkda|nka)$|否認|negative|absent|refuted|排除|ruled out|not present/iu,
  unconfirmed: /疑似|可能|待排除|待確認|未確立|provisional|suspected|differential|unconfirmed|possible|probable|rule out|r\/o/iu,
  stale: /過去|曾|舊|前次|上次|先前|history|previous|prior|inactive|resolved|stopped|completed|已停用|停用|entered-in-error/iu,
  pending: /待補|待測|pending|unknown|未知|registered|preliminary|not-done|未做/iu,
  "not-applicable": /不適用|not applicable|n\/a/iu,
  "not-done": /未做|未執行|not-done|not done|not performed|cancelled|拒絕|refused|declined/iu,
};

/** Markers of the clause around a quote that make the fact unusable as written (empty = usable). */
export function clauseMarkers(source: string, hit: QuoteHit, value: string, attribute: string): { markers: Marker[]; clause: string } {
  const cl = clauseAround(source, hit.start, hit.end);
  const before = nfkc(source.slice(cl.start, hit.start));
  const inside = nfkc(source.slice(hit.start, hit.end));
  const after = nfkc(source.slice(hit.end, cl.end));
  const clause = nfkc(source.slice(cl.start, cl.end)).trim();
  const found: Marker[] = [];
  const add = (cls: MarkerClass, cue: string): void => {
    if (!found.some((m) => m.cls === cls && m.cue === cue)) found.push({ cls, cue: cue.trim() });
  };
  // negation (grounding NEG_CUES): a prefix cue — before the quote or inside it
  // A cue governs only a short stretch before the quote (無法進食，體重 50 kg: 無 does not negate the weight), and
  // 無法 / 無誤 / 未來 are not negations.
  const near = (c: string): boolean =>
    occurrences(before, c).some((i) => before.length - (i + c.length) <= NEG_REACH && !NOT_NEG.test(before.slice(i, i + c.length + 1))) ||
    occurrences(inside, c).some((i) => !NOT_NEG.test(inside.slice(i, i + c.length + 1)));
  for (const cue of NEG_CUES) {
    const c = nfkc(cue);
    if (RULE_OUT.has(c)) {
      if (near(c)) add("unconfirmed", c);
      continue;
    }
    if (near(c)) add("negated", c);
  }
  // diagnosis uncertainty (record checks cue table): prefix cues before / inside, postfix cues after / inside
  const whole = before + inside + after;
  const qs = before.length;
  const qe = before.length + inside.length;
  for (const h of cuesIn(whole)) {
    // both strengths (explicit r/o, 待排除 · vague 疑似, possible) leave the item not established
    if (h.position === "prefix" ? h.start < qe : h.end > qs) add("unconfirmed", h.cue);
  }
  // observation history / stale / pending / not applicable: anywhere in the clause
  for (const cue of OBS_HIST_CUES) if (occurrences(whole, nfkc(cue)).length) add("stale", nfkc(cue));
  for (const [rx, cls] of STALE) {
    const m = rx.exec(whole);
    if (m) add(cls, m[0]);
  }
  // clause-level absence classes (pending result, undecided, not done, not obtained …)
  for (const c of clausesOf(clause)) {
    if (!c.hit) continue;
    const cls: MarkerClass = c.hit.cls === "not-done" ? "not-done" : c.hit.cls === "undecided" || c.hit.cls === "indistinguishable" ? "unconfirmed" : "pending";
    add(cls, c.hit.predicate);
  }
  const own = [nfkc(value).trim(), nfkc(attribute).trim()].filter(Boolean);
  const markers = found.filter((m) => !own.some((o) => o.includes(m.cue) || REFLECTS[m.cls].test(o)));
  return { markers, clause };
}
