/**
 * Relatedness of two concepts of one IG CodeSystem (ISSUES_v15.2 R2): is a candidate code a
 * plausible replacement for a code the caller wrote? Used to gate "Unknown code" suggestions,
 * the accepted-first ordering of fhir_normalize_code and the finalize repair, so that a search
 * of a small CodeSystem excerpt (TW Core 1.0.0 ships 35 of ~45k NHI drug codes) never turns into
 * a suggestion of an unrelated code that only shares a dose form or a strength.
 *
 * Evidence, strongest first (pure, data-driven — nothing is keyed on a particular CodeSystem):
 *   1. linked codings (Coding properties, e.g. a drug's ATC code): when both concepts carry
 *      links of the same system, they are related iff they share a code there (same ATC =
 *      same substance; a different one — another substance or a combination — is not);
 *   2. a shared RARE word of their names / designations / property values: a Latin word
 *      (≥ 4 letters, no digits) or a CJK bigram held by at most RARE_SHARE of the reference
 *      index's concepts (dose forms, salts and units are common, an ingredient is rare);
 *   3. near-identical names (textual similarity ≥ NEAR_SAME_NAME).
 * Negative evidence: both name a strength (number + unit) and none is shared → not related
 * (a replacement must not change the dose).
 */

import type { ConceptIndex } from "./engine.js";
import { normalizeText, tokenize, tokKey } from "./text.js";

/** A word shared by at most this share of the reference CodeSystem's concepts counts as rare. */
export const RARE_SHARE = 0.01;
/** Textual similarity (Dice over character bigrams) at which two names are the same name. */
export const NEAR_SAME_NAME = 0.85;

export interface ConceptProfile {
  /** Names: display, designations, property values (ingredient …), the caller's display / text. */
  texts: string[];
  /** Linked codings as `system|code`. */
  links: string[];
}

export interface Relatedness {
  related: boolean;
  /** Human-readable evidence (reason texts). */
  why: string;
}

/** Profile of an indexed concept (null when the index does not hold the code). */
export function conceptProfile(index: ConceptIndex, code: string, extraTexts: Array<string | null | undefined> = []): ConceptProfile | null {
  const ci = index.indexOf(code);
  if (ci === undefined) return null;
  const c = index.conceptAt(ci);
  const texts = index
    .termsOf(ci)
    .filter((t) => t.kind !== "code" && t.kind !== "umls")
    .map((t) => t.text);
  for (const t of extraTexts) if (t && t.trim()) texts.push(t);
  const links = Array.isArray(c.info?.links)
    ? (c.info!.links as Array<Record<string, unknown>>)
        .filter((l) => l && typeof l.code === "string" && l.code)
        .map((l) => `${typeof l.system === "string" ? l.system : ""}|${String(l.code)}`)
    : [];
  return { texts, links };
}

/** Profile from free text only (a Coding display / CodeableConcept text). */
export function textProfile(...texts: Array<string | null | undefined>): ConceptProfile {
  return { texts: texts.filter((t): t is string => !!t && !!t.trim()), links: [] };
}

/** Rare word keys of a profile against a reference index. */
function rareKeys(p: ConceptProfile, ref: ConceptIndex): Map<string, string> {
  const out = new Map<string, string>();
  const cap = Math.max(1, Math.floor(RARE_SHARE * ref.size));
  for (const text of p.texts) {
    for (const tok of tokenize(normalizeText(text))) {
      const informative = (tok.k === "w" && tok.t.length >= 4 && !/\d/.test(tok.t)) || tok.k === "b";
      if (!informative) continue;
      const key = tokKey(tok);
      if (out.has(key)) continue;
      if (ref.conceptFrequency(key) <= cap) out.set(key, tok.t);
    }
  }
  return out;
}

const UNIT_ALIASES: Record<string, string> = {
  mcg: "ug", μg: "ug", µg: "ug", ug: "ug", mg: "mg", g: "g", gm: "g", ml: "ml", l: "l", iu: "iu", u: "u", unit: "u", units: "u", meq: "meq", mmol: "mmol", "%": "%",
  公絲: "mg", 毫克: "mg", 公克: "g", 克: "g", 毫升: "ml", 公撮: "ml", 微克: "ug", 單位: "u",
};

/** Strengths named in a text ("5mg", "0.5 MG", "500 公絲", "100 U/mL" → "100u"), canonical. */
export function strengths(texts: string[]): Set<string> {
  const out = new Set<string>();
  const re = /(\d+(?:\.\d+)?)\s*(mcg|μg|µg|ug|mg|gm|g|ml|iu|units?|u|meq|mmol|%|公絲|毫克|公克|克|毫升|公撮|微克|單位)(?![a-z])/giu;
  for (const t of texts) {
    const s = String(t || "").normalize("NFKC").toLowerCase();
    for (const m of s.matchAll(re)) {
      const unit = UNIT_ALIASES[m[2]] ?? m[2];
      let n = Number(m[1]);
      if (!Number.isFinite(n)) continue;
      // One scale for mass: g / ug → mg (500 mg = 0.5 g).
      let u = unit;
      if (u === "g") {
        n *= 1000;
        u = "mg";
      } else if (u === "ug") {
        n /= 1000;
        u = "mg";
      }
      out.add(`${Math.round(n * 1e6) / 1e6}${u}`);
    }
  }
  return out;
}

function bigrams(s: string): Map<string, number> {
  const t = normalizeText(s).replace(/\s+/g, " ");
  const out = new Map<string, number>();
  for (let i = 0; i + 1 < t.length; i += 1) {
    const g = t.slice(i, i + 2);
    out.set(g, (out.get(g) ?? 0) + 1);
  }
  return out;
}

/** Dice coefficient over character bigrams of the normalised texts. */
export function nameSimilarity(a: string, b: string): number {
  const x = bigrams(a);
  const y = bigrams(b);
  let nx = 0;
  let ny = 0;
  let both = 0;
  for (const v of x.values()) nx += v;
  for (const [g, v] of y) {
    ny += v;
    both += Math.min(v, x.get(g) ?? 0);
  }
  return nx + ny ? (2 * both) / (nx + ny) : 0;
}

/**
 * Is `b` related to `a` (see the module comment)? `ref` is the index word rarity is judged
 * against — the largest copy of the CodeSystem available (an excerpt of 35 codes says little
 * about which words are common).
 */
export function relatedness(a: ConceptProfile, b: ConceptProfile, ref: ConceptIndex): Relatedness {
  const sa = strengths(a.texts);
  const sb = strengths(b.texts);
  const strengthDiffers = sa.size > 0 && sb.size > 0 && ![...sa].some((x) => sb.has(x));
  // 1. Linked codings of a common system.
  const sysOf = (l: string): string => l.slice(0, l.lastIndexOf("|"));
  const aSys = new Set(a.links.map(sysOf));
  const common = b.links.filter((l) => aSys.has(sysOf(l)));
  if (common.length) {
    const shared = common.filter((l) => a.links.includes(l));
    if (!shared.length) return { related: false, why: `different ${sysOf(common[0]) || "linked"} codes` };
    if (strengthDiffers) return { related: false, why: `same ${shared[0]} but a different strength` };
    return { related: true, why: `same ${shared[0].replace("|", " ")}` };
  }
  // 2. A shared rare word.
  const ka = rareKeys(a, ref);
  const kb = rareKeys(b, ref);
  const shared = [...ka.keys()].filter((k) => kb.has(k));
  if (shared.length) {
    if (strengthDiffers) return { related: false, why: `shares '${ka.get(shared[0])}' but a different strength` };
    return { related: true, why: `shares '${ka.get(shared[0])}'` };
  }
  // 3. Near-identical names.
  for (const x of a.texts) {
    for (const y of b.texts) {
      if (nameSimilarity(x, y) >= NEAR_SAME_NAME) return strengthDiffers ? { related: false, why: "similar name but a different strength" } : { related: true, why: `near-identical name '${y}'` };
    }
  }
  return { related: false, why: "no shared ingredient / linked code / name" };
}
