/**
 * Other names of LOINC analytes (components), for search_loinc and the LOINC branch of
 * fhir_normalize_code (pure, no I/O).
 *
 * LOINC's own synonym data, both shipped in the release zip the LOINC import already reads:
 *  - Loinc.csv RELATEDNAMES2 — English synonyms and abbreviations ("Uric acid" for Urate,
 *    "FSH" / "Follicle stimulating hormone" for Follitropin, "SGPT", "Hgb", "EtOH" …);
 *  - AccessoryFiles/LinguisticVariants/zhCN*LinguisticVariant.csv — the Chinese component
 *    name and Chinese related names (incl. Taiwanese forms such as 白血球, 血色素, 泌乳激素),
 *    folded from Simplified to Traditional script.
 * RELATEDNAMES2 mixes analyte synonyms with axis vocabulary (Serum, Point in time, QNT,
 * Chemistry …). A name that recurs across many analytes describes an axis or a class, not
 * the analyte, so names used by more than {@link MAX_COMPONENTS_PER_NAME} components are
 * dropped (a data-derived filter: "Hgb" 169, "FSH" 78, "uric acid" 20 stay; "serum" 14k,
 * "kidney" 553, "UA" 3.7k go), and so is a name carried by only a minority of the analyte's
 * terms (a specimen, timing or method word: "Ascites", "2HR", "自動計數" on some Creatinine
 * terms) — a synonym of the analyte is listed on (nearly) all of its terms.
 *
 * Search looks names up by an exact normalised key: every word n-gram of an English query
 * and every substring of a Chinese run, so a name inside a longer query ("uric acid level",
 * "空腹血糖") is found with one indexed lookup.
 */

import { toTraditional } from "./conceptSearch/s2t.js";

/** Names shared by more analytes than this are axis / class vocabulary, not synonyms. */
export const MAX_COMPONENTS_PER_NAME = 300;
/** A synonym is listed on at least this share of the analyte's terms. */
export const MIN_TERM_SHARE = 0.5;
/** At most this many names kept per component (shortest first). */
export const MAX_NAMES_PER_COMPONENT = 40;

const HAN = /\p{Script=Han}/u;

/** Normalised lookup key of a name or query fragment: NFKC, lower case, Traditional script, single spaces. */
export function nameKey(text: string): string {
  return toTraditional(String(text ?? "").normalize("NFKC"))
    .toLowerCase()
    .replace(/[‐-―−]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/** Lookup keys of a query: word 1–4-grams of its Latin text, substrings (2–10 chars; 1 in runs of ≤ 3) of its Han runs. */
export function queryNameKeys(query: string, max = 200): string[] {
  const n = nameKey(query);
  const out = new Set<string>();
  if (n.length >= 2 && n.length <= 80) out.add(n);
  const words = n.split(/[^\p{L}\p{N}.+\-/]+/u).filter(Boolean);
  for (let len = 1; len <= 4; len += 1) {
    for (let i = 0; i + len <= words.length; i += 1) {
      const g = words.slice(i, i + len).join(" ");
      if (g.length >= 2 && !HAN.test(g)) out.add(g);
    }
  }
  for (const run of n.match(/\p{Script=Han}+/gu) || []) {
    const chars = [...run];
    // Single characters only from short runs ("鋅", "血鈉"), never out of a long phrase.
    const minLen = chars.length <= 3 ? 1 : 2;
    for (let len = Math.min(10, chars.length); len >= minLen; len -= 1) {
      for (let i = 0; i + len <= chars.length; i += 1) out.add(chars.slice(i, i + len).join(""));
    }
  }
  return [...out].slice(0, max);
}

/** Han-only names out of a zh-CN RELATEDNAMES2 value (";"-separated, axis groups space-separated). */
function zhRelatedNames(value: string): string[] {
  const out: string[] = [];
  for (const part of String(value ?? "").split(";")) {
    for (const piece of part.split(/\s+/)) {
      const p = piece.replace(/[（(][^）)]*[）)]?/g, "").trim();
      if (p.length >= 2 && HAN.test(p) && /^[\p{Script=Han}\p{N}A-Za-z.·\-/]+$/u.test(p)) out.push(p);
    }
  }
  return out;
}

export interface ComponentNameSource {
  /** Loinc.csv rows (LOINC_NUM, COMPONENT, RELATEDNAMES2). */
  rows: Array<Record<string, string>>;
  /** zh-CN linguistic variant rows (LOINC_NUM, COMPONENT, RELATEDNAMES2), when present. */
  zhRows?: Array<Record<string, string>> | null;
}

/**
 * Rows (component, name, lang, name_key) for loinc.component_names. `component` is the
 * English COMPONENT as in loinc.concepts.
 */
export function buildComponentNames(src: ComponentNameSource): string[][] {
  const compOf = new Map<string, string>();
  const termsPer = new Map<string, number>();
  // lang|key → { name, terms per component }
  const names = new Map<string, { lang: string; name: string; comps: Map<string, number> }>();
  const add = (comp: string, raw: string, lang: string, seen: Set<string>): void => {
    const name = String(raw ?? "").trim();
    // One Han character can be a whole analyte name (鈉, 鉀, 鋅); one Latin letter cannot.
    const minLen = HAN.test(name) ? 1 : 2;
    if (!comp || name.length < minLen || name.length > 80) return;
    const key = nameKey(name);
    if (key.length < minLen || key === nameKey(comp)) return;
    const k = `${lang}|${key}`;
    if (seen.has(k)) return;
    seen.add(k);
    let e = names.get(k);
    if (!e) {
      e = { lang, name: lang === "zh" ? toTraditional(name) : name, comps: new Map() };
      names.set(k, e);
    }
    e.comps.set(comp, (e.comps.get(comp) ?? 0) + 1);
  };
  for (const r of src.rows) {
    const num = (r.LOINC_NUM ?? "").trim();
    const comp = (r.COMPONENT ?? "").trim();
    if (!num || !comp) continue;
    compOf.set(num, comp);
    termsPer.set(comp, (termsPer.get(comp) ?? 0) + 1);
    const seen = new Set<string>();
    for (const n of String(r.RELATEDNAMES2 ?? "").split(";")) add(comp, n, "en", seen);
  }
  const zhTermsPer = new Map<string, number>();
  for (const r of src.zhRows || []) {
    const comp = compOf.get((r.LOINC_NUM ?? "").trim());
    if (!comp) continue;
    zhTermsPer.set(comp, (zhTermsPer.get(comp) ?? 0) + 1);
    const seen = new Set<string>();
    add(comp, r.COMPONENT ?? "", "zh", seen);
    for (const n of zhRelatedNames(r.RELATEDNAMES2 ?? "")) add(comp, n, "zh", seen);
  }
  const perComp = new Map<string, Array<{ name: string; lang: string; key: string }>>();
  for (const [k, e] of names) {
    if (e.comps.size > MAX_COMPONENTS_PER_NAME) continue;
    const key = k.slice(k.indexOf("|") + 1);
    for (const [c, n] of e.comps) {
      const m = (e.lang === "zh" ? zhTermsPer : termsPer).get(c) ?? 1;
      if (n / m < MIN_TERM_SHARE) continue;
      const list = perComp.get(c);
      const item = { name: e.name, lang: e.lang, key };
      if (list) list.push(item);
      else perComp.set(c, [item]);
    }
  }
  const out: string[][] = [];
  for (const [comp, list] of perComp) {
    const seen = new Set<string>();
    list
      .sort((a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name))
      .filter((x) => (seen.has(x.key) ? false : (seen.add(x.key), true)))
      .slice(0, MAX_NAMES_PER_COMPONENT)
      .forEach((x) => out.push([comp, x.name, x.lang, x.key]));
  }
  return out;
}
