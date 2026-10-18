/**
 * Text normalisation and tokenisation for the IG concept-search engine (pure, no I/O).
 *
 * The same functions run over the indexed terms (CodeSystem displays, designations,
 * supplement names …) and over the caller's free text, so every rule here is
 * symmetric: anything folded on one side is folded the same way on the other.
 *
 *  - NFKC (full-width → half-width, Ｃ → C, （ → ( …), lower-case, Unicode dashes → "-";
 *  - a small table of Chinese variant characters that the same code lists spell both
 *    ways (臺/台, 脢/酶, 沈/沉 …);
 *  - Chinese numerals before a measure word become digits (小於五公分 → 小於5公分),
 *    metric units written in Latin become the Chinese unit (5 cm → 5公分) and
 *    comparison signs become words (< → 小於);
 *  - tokens: Latin/digit words (light plural stemming) and, for CJK runs, character
 *    bigrams plus low-weight unigrams.
 *
 * `clinicalCore` strips record-writing noise that never belongs to a code's name:
 * laterality, counts (x1, ×2, 5針), suture sizes/materials (4-0 Nylon).
 */

/** Unicode dash-like characters folded to "-" (same set as the grounding lexicon). */
const DASHES = "‐‑‒–—―−－ー─━";
const DASH_RE = new RegExp(`[${DASHES}]`, "g");

/** Variant characters spelled both ways in Taiwanese code lists → one canonical form. */
const VARIANT_CHARS: Record<string, string> = {
  臺: "台",
  脢: "酶",
  沈: "沉",
  粘: "黏",
  燐: "磷",
  痠: "酸",
  週: "周",
  裏: "裡",
  着: "著",
  綫: "線",
  爲: "為",
  污: "汙",
  衞: "衛",
  羣: "群",
  鍼: "針",
};
const VARIANT_RE = new RegExp(`[${Object.keys(VARIANT_CHARS).join("")}]`, "g");

const CN_DIGITS: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 兩: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CN_NUM = "[零〇一二兩两三四五六七八九十百]+";
/** Measure words / units after which a Chinese numeral is a quantity. */
const MEASURE = "(?:公分|公釐|公厘|公尺|公斤|公克|毫升|毫克|條|次|歲|周|個|處|支|顆|針|天|日|小時|分鐘|片|根|枚|袋|瓶|劑|級|度|bsa|cm|mm)";
const CN_QTY_RE = new RegExp(`(${CN_NUM})(?=(?:[至到~-]${CN_NUM})?${MEASURE})`, "gu");

/** Parse a Chinese numeral (一 … 九百九十九). Returns null when it is not one. */
export function cnToInt(s: string): number | null {
  if (!s) return null;
  let total = 0;
  let cur = 0;
  let seen = false;
  for (const ch of s) {
    if (ch in CN_DIGITS) {
      cur = CN_DIGITS[ch];
      seen = true;
    } else if (ch === "十") {
      total += (seen && cur ? cur : 1) * 10;
      cur = 0;
      seen = false;
    } else if (ch === "百") {
      total += (seen && cur ? cur : 1) * 100;
      cur = 0;
      seen = false;
    } else {
      return null;
    }
  }
  return total + cur;
}

const UNIT_LATIN: Array<[RegExp, string]> = [
  [/(\d)\s*cm\b/g, "$1公分"],
  [/(\d)\s*mm\b/g, "$1公釐"],
  [/(\d)\s*kg\b/g, "$1公斤"],
  [/(\d)\s*(?:ml|cc)\b/g, "$1毫升"],
];

/** NFKC + lower-case + dash/variant folding + numeral/unit/comparator normalisation. */
export function normalizeText(s: string | null | undefined): string {
  if (!s) return "";
  let t = String(s).normalize("NFKC").toLowerCase();
  t = t.replace(DASH_RE, "-").replace(VARIANT_RE, (c) => VARIANT_CHARS[c] ?? c);
  t = t.replace(CN_QTY_RE, (m) => {
    const n = cnToInt(m);
    return n === null ? m : String(n);
  });
  for (const [re, rep] of UNIT_LATIN) t = t.replace(re, rep);
  // Dotted abbreviations: "e.k.g." / "c.r.p" → "ekg" / "crp".
  t = t.replace(/(?<![a-z0-9])(?:[a-z]\.){1,}[a-z](?![a-z0-9])\.?/g, (m) => m.replace(/\./g, ""));
  // Chart shorthand for with / without.
  t = t.replace(/(?<![a-z])w\/o(?![a-z])/g, " without ").replace(/(?<![a-z])w\/(?=\s|[a-z])/g, " with ");
  t = t
    .replace(/<=|≦|≤/g, " 小於等於 ")
    .replace(/>=|≧|≥/g, " 大於等於 ")
    .replace(/</g, " 小於 ")
    .replace(/>/g, " 大於 ");
  return t.replace(/\s+/g, " ").trim();
}

export function isCjkChar(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0;
  return (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0xf900 && cp <= 0xfaff);
}

export function hasCjk(s: string): boolean {
  for (const ch of s) if (isCjkChar(ch)) return true;
  return false;
}

/** Normalised text without spaces/punctuation — used for exact / containment checks. */
export function compact(normalized: string): string {
  let out = "";
  for (const ch of normalized) if (/[\p{L}\p{N}]/u.test(ch)) out += ch;
  return out;
}

/** Light English stemming (plural, -ing, -ed) shared by index and query. */
export function stemLatin(w: string): string {
  if (w.length > 6 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 5 && /[^e]ed$/.test(w)) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length > 3 && w.endsWith("s") && !/(ss|us|is|os)$/.test(w)) return w.slice(0, -1);
  return w;
}

/** Function words that carry no meaning for code matching. */
export const LATIN_STOP = new Set([
  "a", "an", "the", "of", "and", "or", "with", "without", "in", "on", "at", "for", "by", "to", "from", "per", "as", "via", "w",
  "is", "are", "be", "this", "that", "other", "than",
]);

/** Token kinds: Latin word, digit run, CJK bigram, CJK unigram. */
export type TokKind = "w" | "d" | "b" | "u";

/** One token of a text, with its matching weight. */
export interface Tok {
  t: string;
  k: TokKind;
  w: number;
}

const UNIGRAM_W = 0.3;

/**
 * Tokens of an already-normalised text. CJK runs yield bigrams (weight 1) plus
 * unigrams (weight 0.3; weight 1 for a one-character run); Latin words are stemmed,
 * stop words dropped, letter+digit words are kept whole and also split (ca199 → ca, 199).
 */
export function tokenize(normalized: string): Tok[] {
  const out: Tok[] = [];
  const seen = new Set<string>();
  const push = (t: string, k: TokKind, w: number): void => {
    const key = `${k}:${t}`;
    if (!t || seen.has(key)) return;
    seen.add(key);
    out.push({ t, k, w });
  };
  const runRe = /([\p{Script=Han}]+)|([\p{L}\p{N}]+)/gu;
  for (const m of normalized.matchAll(runRe)) {
    if (m[1]) {
      const chars = Array.from(m[1]);
      if (chars.length === 1) {
        push(chars[0], "u", 1);
        continue;
      }
      for (let i = 0; i + 1 < chars.length; i += 1) push(chars[i] + chars[i + 1], "b", 1);
      for (const c of chars) push(c, "u", UNIGRAM_W);
    } else if (m[2]) {
      const w = m[2];
      if (LATIN_STOP.has(w)) continue;
      if (/^\d+$/.test(w)) {
        push(w, "d", 0.5);
        continue;
      }
      push(stemLatin(w), "w", w.length === 1 ? 0.3 : 1);
      if (/\d/.test(w) && /\p{L}/u.test(w)) {
        for (const part of w.split(/(?<=\d)(?=\p{L})|(?<=\p{L})(?=\d)/u)) {
          if (part === w) continue;
          if (/^\d+$/.test(part)) push(part, "d", 0.4);
          else if (!LATIN_STOP.has(part)) push(stemLatin(part), "w", part.length === 1 ? 0.2 : 0.6);
        }
      }
    }
  }
  return out;
}

/** Token key used by the inverted index (kind-qualified so "b:血糖" never collides with a Latin word). */
export function tokKey(t: Tok): string {
  return t.k === "w" || t.k === "d" ? t.t : `${t.k}:${t.t}`;
}

// ---------------------------------------------------------------------------- clinical noise

const NOISE_PATTERNS: RegExp[] = [
  // laterality
  /(?:左|右|雙|兩|单|單)側/g,
  /\b(?:left|right|bilateral|unilateral|lt|rt)\b/g,
  // counts: x1, × 2, #3, 5針, 2次, 3顆 …
  /(?:^|\s|\b)[x×*#]\s*\d+\b/g,
  /\d+\s*(?:針|次|顆|支|個|處|片|根|枚|袋|瓶|劑|pcs?|units?|times?|shots?|stitch(?:es)?)/g,
  // chart shorthand that never names the coded concept: r/o (rule out), f/u, s/p, c/o, stat
  /(?<![a-z])(?:r\/o|f\/u|s\/p|c\/o|stat)(?![a-z])/g,
  // suture size and material
  /\b\d-0\b/g,
  /\b(?:nylon|vicryl|silk|prolene|dexon|monocryl|chromic|pds|ethilon|dermabond)\b/g,
];

/**
 * The clinically meaningful core of a free-text query: record noise removed,
 * brackets kept (their text often names the coded concept). Input must be normalised.
 */
export function clinicalCore(normalized: string): string {
  let t = normalized;
  for (const re of NOISE_PATTERNS) t = t.replace(re, " ");
  return t.replace(/\s+/g, " ").trim();
}

/** The text with bracketed annotations removed ("清創縫合（淺部…）" → "清創縫合"). */
export function withoutBrackets(normalized: string): string {
  return normalized
    .replace(/\([^()]*\)/g, " ")
    .replace(/\[[^[\]]*\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Group key of a code name: the name before its first method / qualifier separator
 * ("C反應性蛋白試驗-免疫比濁法" → "c反應性蛋白試驗"). Codes sharing it are near-duplicate
 * siblings (same test, different method; same procedure, different size …).
 */
export function groupKey(display: string | null | undefined): string {
  const n = normalizeText(display);
  if (!n) return "";
  const cut = n.split(/\s*(?:-|\(|\[|,|，|、|;|；|:|：)\s*/)[0] ?? n;
  const c = compact(cut);
  return c.length >= 2 ? c : compact(n);
}

/** Script-based language guess for a term without a declared language. */
export function guessLang(term: string): string {
  return hasCjk(term) ? "zh" : /[a-z]/i.test(term) ? "en" : "und";
}

/**
 * Key for phrase-level synonym lookup (UMLS strings, query n-grams): normalised text with
 * punctuation as single spaces ("C-reactive protein" → "c reactive protein").
 */
export function umlsNorm(s: string | null | undefined): string {
  return normalizeText(s)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
