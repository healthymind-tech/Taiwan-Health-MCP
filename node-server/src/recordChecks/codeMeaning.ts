/**
 * Code meaning check (ISSUES_v20 R2) — needs source_text.
 *
 * A coding can be syntactically valid and a member of its ValueSet yet mean something else than the record says (a
 * LOINC code of another test, an ICD-10 code of another diagnosis, another medicine / procedure). Grounding and the
 * validator cannot see it. This rule compares the coding's OFFICIAL names — the terminology names grounding compares
 * (LOINC long / short / component / Chinese names, SNOMED descriptions + Chinese names from grounding/snomedChinese.ts,
 * ICD-10-CM titles + TW Chinese names, NHI / TFDA drug names, IG CodeSystem designations; never the model's own
 * display) — with the record phrase the element stands for:
 *
 *   - the CodeableConcept.text, or a coding display the model wrote, when the record states it (the phrase the value is
 *     grounded on: grounding accepts the element through it);
 *   - for an Observation (and each component) with a numeric value: the label right before the value on the record
 *     clause that carries it (「Hb 10.2 g/dL」 → Hb; 「血糖：110」 → 血糖). Every such clause must disagree.
 *
 * Similarity is the grounding engine's weighted name containment in both directions (abbreviations and the zh→en bridge
 * expanded) plus abbreviation equivalence over the data-derived thesaurus / abbreviation lexicon
 * (grounding/abbreviations.ts). A phrase that cannot be compared (another language the bridge does not translate, an
 * abbreviation no table expands) is never judged.
 *
 * Two steps, so that the rule never guesses:
 *   1. meaningTargets (pure): codings whose names are unrelated to the phrase (< 0.2), or — for code-structured systems
 *      (ICD-10 / LOINC) — only partly related (< 0.7);
 *   2. the tool asks fhir_normalize_code for the phrase restricted to the coding's system (lookups.ts) and passes the
 *      candidates in RecordCheckOptions.meaningCandidates. An error is reported only when the candidates CONFIRM it:
 *      the coding is not among them and one of them clearly names the phrase (≥ 0.5; for the partly-related tier the
 *      whole phrase is in its display and it is no ICD parent / child of the coding). Medicines: the unrelated tier
 *      only, and no candidate sharing an ingredient word with the coding's names (brand vs generic names).
 * Without candidates (no normalize hook) there is no finding. Deterministic; the record text is never logged.
 */
import { abbreviationMatch, type AbbreviationMap } from "../grounding/abbreviations.js";
import { bridgeCoverage, latTokens, nameSimilarity, norm } from "../grounding/lexicon.js";
import { RecordText } from "../grounding/recordText.js";
import { hasCjk } from "../conceptSearch/text.js";
import { makeIssue } from "./issue.js";
import { resourcesOf } from "./slots.js";
import type { MeaningCandidate, RecordIssue } from "./types.js";

type Json = Record<string, any>;
const isObj = (x: unknown): x is Json => !!x && typeof x === "object" && !Array.isArray(x);
const clip = (s: string, n = 60): string => (s.length > n ? `${s.slice(0, n)}…` : s);

/** Below this, the phrase and the code's names are unrelated. */
export const UNRELATED = 0.2;
/** Below this, partly related (only judged for code-structured systems, with an exact candidate). */
export const PARTLY = 0.7;
/** A candidate names the phrase at or above this. */
export const NAMES_PHRASE = 0.5;

const MED_TYPES = new Set(["MedicationRequest", "MedicationStatement", "MedicationAdministration", "MedicationDispense", "Medication"]);
const ELEMENTS: Record<string, string[]> = {
  Observation: ["code"],
  Condition: ["code"],
  Procedure: ["code"],
  DiagnosticReport: ["code"],
  ServiceRequest: ["code"],
  AllergyIntolerance: ["code"],
  Immunization: ["vaccineCode"],
  Medication: ["code"],
  MedicationRequest: ["medicationCodeableConcept"],
  MedicationStatement: ["medicationCodeableConcept"],
  MedicationAdministration: ["medicationCodeableConcept"],
  MedicationDispense: ["medicationCodeableConcept"],
};
const STRUCTURED = /^(http:\/\/hl7\.org\/fhir\/sid\/icd-10(-cm)?|http:\/\/loinc\.org)$/u;
const ICD = /icd-10/u;
const SKIP_SECTIONS = new Set(["instruction", "site_config", "family_history"]);
const RE_TAG = /\s*\((disorder|finding|symptom|situation|observable entity|procedure|substance|product|regime\/therapy|morphologic abnormality)\)\s*$/iu;
/** The label right before a value: words starting with a letter / CJK character (digits break it). */
const RE_LABEL_TAIL = /(?:[A-Za-z㐀-鿿][A-Za-z0-9㐀-鿿%#.\-()（）]*)(?:\s+[A-Za-z㐀-鿿][A-Za-z0-9㐀-鿿%#.\-()（）]*){0,3}$/u;
const RE_CLAUSE = /[，,；;。|]/u;

export interface MeaningTarget {
  /** Instance path of the CodeableConcept (…resource.code / …component[1].code). */
  path: string;
  system: string;
  code: string;
  display: string | null;
  resourceType: string;
  /** The record phrase the element stands for. */
  phrase: string;
  source: "text" | "display" | "value-label";
  /** The record line, clipped (located quote). */
  line: string;
  /** Official names compared. */
  names: string[];
  similarity: number;
  tier: "unrelated" | "partly";
}

/** Key of a target's candidates in RecordCheckOptions.meaningCandidates. */
export const meaningKey = (path: string, phrase: string): string => `${path}\u0000${phrase}`;

/** Similarity of a phrase and a name: containment both ways, abbreviation equivalence = 1. */
export function meaningSimilarity(phrase: string, name: string, abbr: AbbreviationMap | null): number {
  const n = name.replace(RE_TAG, "");
  const s = Math.max(nameSimilarity(phrase, n), nameSimilarity(n, phrase));
  if (s >= 0.99) return s;
  return abbreviationMatch(phrase, n, abbr) ? 1 : s;
}

/** Whether a phrase can be compared with the names at all (see the module comment). */
function comparable(phrase: string, names: readonly string[], abbr: AbbreviationMap | null): boolean {
  const cj = hasCjk(phrase);
  if (cj) return names.some((n) => hasCjk(n)) || bridgeCoverage(phrase) >= 0.8;
  const words = phrase.normalize("NFKC").split(/[^A-Za-z0-9]+/u).filter((w) => /[A-Za-z]/u.test(w));
  if (!words.length || !names.some((n) => /[A-Za-z]{3,}/u.test(n))) return false;
  // an abbreviation-only phrase is comparable only when a table expands every abbreviation in it
  const abbrOnly = words.every((w) => w.length <= 5 && (w === w.toUpperCase() || w.length <= 3));
  if (!abbrOnly) return true;
  return words.every((w) => (abbr?.get(w.toLowerCase())?.length ?? 0) > 0 || latTokens(w, true).size > latTokens(w, false).size);
}

interface Phrase {
  text: string;
  source: MeaningTarget["source"];
  line: string;
}

/** Record lines (instruction / site-config / family-history excluded), NFKC with the record's casing. */
function recordLines(rt: RecordText): string[] {
  return rt.lines.filter((l) => !SKIP_SECTIONS.has(l.section) && l.line.trim()).map((l) => l.line.normalize("NFKC"));
}

function fmtNumber(v: unknown): RegExp | null {
  const n = typeof v === "number" ? v : typeof v === "string" && /^-?\d+(\.\d+)?$/u.test(v.trim()) ? Number(v) : NaN;
  if (!Number.isFinite(n)) return null;
  const [i, f = ""] = String(n).split(".");
  // 10.2 also as 10.20; 7 also as 7.0
  const frac = f ? `\\.${f}0*` : "(?:\\.0+)?";
  return new RegExp(`(?<![\\d.])${i.replace("-", "\\-")}${frac}(?![\\d])`, "gu");
}

/**
 * The label right before a value: the words after the last field colon, back to the previous number (「BP 120/80 HR」 →
 * HR), a semantic tag dropped; null when it has no word of 2+ letters / CJK characters.
 */
export function labelBefore(before0: string): string | null {
  const before = (before0.split(/[:：]/u).pop() ?? "").replace(/[\s=＝]+$/u, "");
  const toks = before.split(/\s+/u).filter(Boolean);
  const out: string[] = [];
  for (let i = toks.length - 1; i >= 0 && out.length < 12; i--) {
    if (/^[<>≤≥~]?[\d.,/%-]+$/u.test(toks[i]) || /\d[/]\d/u.test(toks[i])) break; // a number: the previous measurement
    out.unshift(toks[i]);
  }
  while (out.length && !/^[A-Za-z\u3400-\u9fff]/u.test(out[0])) out.shift();
  const text = out.join(" ").replace(RE_TAG, "").replace(/[()（）.\-]+$/u, "").trim();
  return text.length >= 2 && /[A-Za-z\u3400-\u9fff]{2,}|[\u3400-\u9fff]/u.test(text) ? text : null;
}

/** Labels right before the value on the record clauses that carry it. */
function valueLabels(lines: readonly string[], value: unknown, unit: string | null): Phrase[] {
  const rx = fmtNumber(value);
  if (!rx) return [];
  const all: Array<Phrase & { unitHit: boolean }> = [];
  for (const line of lines) {
    for (const clause0 of line.split(RE_CLAUSE)) {
      const clause = clause0.trim();
      for (const m of clause.matchAll(rx)) {
        const text = labelBefore(clause.slice(0, m.index));
        if (!text) continue;
        const after = clause.slice(m.index + m[0].length, m.index + m[0].length + 14).toLowerCase();
        all.push({ text, source: "value-label", line: line.trim().slice(0, 120), unitHit: !!unit && after.includes(unit.toLowerCase()) });
      }
    }
  }
  const withUnit = all.filter((p) => p.unitHit);
  return (withUnit.length ? withUnit : all).map(({ text, source, line }) => ({ text, source, line }));
}

/** Text / model display of the element stated verbatim in the record. */
function statedPhrases(cc: Json, coding: Json, lines: readonly string[], official: readonly string[]): Phrase[] {
  const out: Phrase[] = [];
  const add = (t: unknown, source: Phrase["source"]): void => {
    if (typeof t !== "string" || t.trim().length < 2) return;
    const n = norm(t);
    if (n.length < 2) return;
    const line = lines.find((l) => norm(l).includes(n));
    if (line) out.push({ text: t.trim(), source, line: line.trim().slice(0, 120) });
  };
  add(cc.text, "text");
  if (typeof coding.display === "string" && !official.some((o) => norm(o) === norm(coding.display))) add(coding.display, "display");
  return out;
}

/** Codings whose official names do not fit the record phrase (step 1, pure). */
export function meaningTargets(
  root: Json,
  sourceText: string,
  siteConfig: string | null,
  codeNames: ReadonlyMap<string, readonly string[]> | null,
  codeNamesZh: ReadonlyMap<string, readonly { name: string; confidence: number }[]> | null,
  abbr: AbbreviationMap | null,
): MeaningTarget[] {
  if (!codeNames || !codeNames.size) return [];
  const lines = recordLines(new RecordText(sourceText, siteConfig));
  const out: MeaningTarget[] = [];
  for (const r of resourcesOf(root)) {
    const res = r.resource;
    const els = ELEMENTS[res.resourceType];
    if (!els) continue;
    const nodes: Array<[string, Json, Json | null]> = els.filter((k) => isObj(res[k])).map((k) => [`${r.base}.${k}`, res[k], res]);
    if (res.resourceType === "Observation" && Array.isArray(res.component)) {
      res.component.forEach((c: unknown, i: number) => {
        if (isObj(c) && isObj(c.code)) nodes.push([`${r.base}.component[${i}].code`, c.code, c]);
      });
    }
    for (const [path, cc, owner] of nodes) {
      const codings: Json[] = Array.isArray(cc.coding) ? cc.coding.filter(isObj) : [];
      for (const c of codings) {
        if (typeof c.system !== "string" || typeof c.code !== "string" || !c.code.trim()) continue;
        const key = `${c.system}|${c.code}`;
        const names = [...(codeNames.get(key) ?? []), ...(codeNamesZh?.get(key) ?? []).filter((z) => z.confidence >= 0.5).map((z) => z.name)].filter((n) => typeof n === "string" && n.trim().length >= 2);
        if (!names.length) continue; // no official names: nothing to compare
        const phrases = statedPhrases(cc, c, lines, names);
        const q = owner && isObj(owner.valueQuantity) ? owner.valueQuantity : null;
        const labels = q && q.value !== undefined ? valueLabels(lines, q.value, typeof q.unit === "string" ? q.unit : typeof q.code === "string" ? q.code : null) : [];
        // value labels: judged only when every labelled occurrence disagrees
        const groups: Phrase[][] = [...phrases.map((p) => [p]), ...(labels.length ? [labels] : [])];
        for (const g of groups) {
          if (!g.every((p) => comparable(p.text, names, abbr))) continue;
          const sims = g.map((p) => Math.max(...names.map((n) => meaningSimilarity(p.text, n, abbr))));
          const sim = Math.max(...sims);
          const structured = STRUCTURED.test(c.system);
          const tier = sim < UNRELATED ? "unrelated" : sim < PARTLY && structured && !MED_TYPES.has(res.resourceType) ? "partly" : null;
          if (!tier) continue;
          const p = g[sims.indexOf(Math.min(...sims))];
          out.push({ path, system: c.system, code: c.code, display: typeof c.display === "string" ? c.display : null, resourceType: res.resourceType, phrase: p.text, source: p.source, line: p.line, names, similarity: Math.round(sim * 100) / 100, tier });
          break; // one phrase per coding
        }
      }
    }
  }
  return out;
}

const icdRelated = (a: string, b: string): boolean => {
  const x = a.replace(/\./gu, "").toUpperCase();
  const y = b.replace(/\./gu, "").toUpperCase();
  return x.startsWith(y) || y.startsWith(x);
};
const ingredientWords = (names: readonly string[]): Set<string> => new Set(names.flatMap((n) => [...latTokens(n, false)].filter((w) => w.length >= 4 && /^[a-z]+$/u.test(w))));

/** Step 2: the confirmed mismatches (see the module comment). */
export function codeMeaningChecks(
  root: Json,
  sourceText: string,
  siteConfig: string | null,
  codeNames: ReadonlyMap<string, readonly string[]> | null,
  codeNamesZh: ReadonlyMap<string, readonly { name: string; confidence: number }[]> | null,
  abbr: AbbreviationMap | null,
  candidates: ReadonlyMap<string, readonly MeaningCandidate[]> | null,
  skip: ReadonlySet<string>,
): RecordIssue[] {
  if (!candidates || !candidates.size) return [];
  const out: RecordIssue[] = [];
  const done = new Set<string>();
  for (const t of meaningTargets(root, sourceText, siteConfig, codeNames, codeNamesZh, abbr)) {
    if (skip.has(t.path) || done.has(t.path)) continue;
    const cands = (candidates.get(meaningKey(t.path, t.phrase)) ?? []).filter((c) => c && typeof c.code === "string" && (c.system ?? t.system) === t.system);
    if (!cands.length) continue;
    if (cands.some((c) => c.code === t.code)) continue; // the normalizer finds this very code for the phrase
    const naming = cands.filter((c) => {
      if (!c.display) return false;
      if (ICD.test(t.system) && icdRelated(c.code, t.code)) return false; // a parent / child, never "another diagnosis"
      const s = meaningSimilarity(t.phrase, c.display, abbr);
      if (t.tier === "partly") return nameSimilarity(c.display, t.phrase) >= 0.99 && s - t.similarity >= 0.3;
      return s >= NAMES_PHRASE;
    });
    if (!naming.length) continue;
    if (MED_TYPES.has(t.resourceType)) {
      const own = ingredientWords(t.names);
      if (naming.some((c) => [...ingredientWords([c.display ?? ""])].some((w) => own.has(w)))) continue;
    }
    done.add(t.path);
    const shown = naming.slice(0, 5);
    const codeName = clip(t.names[0], 60);
    const list = shown.map((c) => `${c.code}${c.display ? ` ${clip(c.display, 40)}` : ""}`).join("; ");
    const issue = makeIssue(
      "R7", "error", "code-meaning-mismatch", t.path,
      `代碼的意思與病歷不符：病歷寫「${clip(t.phrase, 40)}」，但 ${t.system}#${t.code} 的意思是「${codeName}」。請改用與病歷相符的代碼（fhir_normalize_code 候選：${list}）`,
      `The code does not mean what the record says: the record states "${clip(t.phrase, 40)}", but ${t.system}#${t.code} means "${codeName}". Use the code that matches the record (fhir_normalize_code candidates: ${list})`,
      `R7 code meaning (ISSUES_v20 R2): the coding's official names (${t.names.slice(0, 3).map((n) => `'${clip(n, 40)}'`).join(", ")}) compared with the record phrase from ${t.source === "value-label" ? "the label before the value" : t.source === "text" ? "CodeableConcept.text" : "the coding display"} — similarity ${t.similarity.toFixed(2)} (${t.tier}); fhir_normalize_code for the phrase (system ${t.system}) does not return this code and returns ${shown.length} that name the phrase`,
      [t.line],
    );
    out.push({
      ...issue,
      record_phrase: t.phrase,
      code_display: t.names[0],
      suggestions: shown.map((c, i) => ({ value: c.code, kind: "replace_code" as const, confidence: Math.round(Math.max(0.3, 0.7 - i * 0.1) * 100) / 100, reason: `fhir_normalize_code candidate for "${clip(t.phrase, 40)}"`, system: t.system, ...(c.display ? { display: c.display } : {}) })),
    } as RecordIssue);
  }
  return out;
}
