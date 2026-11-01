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
 *
 * v20.1 (fewer false positives, scale / instrument confusions; the finding is advisory — `gate: "advisory"`):
 *   - like with like: a value label is the item's own phrase only when every occurrence of the value has a label (a
 *     value inside 「30/24」 has none: no verdict), the label does not name another coding of the Bundle (「BMI 24」 is the
 *     BMI Observation's label, never the ALT Observation's) and the resource's own stated text / display does not
 *     already agree with the code;
 *   - generic codes are never judged by similarity: document / study / panel / note / report names (LOINC Doc
 *     ontology, imaging study, panels) and short class-word-only names (「Cancer stage」, 「Diagnostic imaging study」);
 *   - instrument tier: the item's phrase names an instrument / score (an acronym such as ECOG / DAS28, or a CamelCase
 *     method such as VectraDA) the code's names do not, while the code names another one the record does not state
 *     (ECOG vs NYHA / KPS, DAS28 vs VectraDA) — confirmed only by a candidate naming the record's instrument and not the
 *     code's;
 *   - timing tier: the item's phrase states a timing cue (AC / 空腹 / 飯前 / fasting vs PC / 飯後 / 餐後 / post-prandial vs
 *     random / 隨機) and the code's names state another one (LOINC TIME / challenge part of the component and long name:
 *     「Fasting glucose」, 「--2 hours post meal」) — a code without timing is never judged; the normalize query is the
 *     code's analyte + the English cue, and only a candidate of the record's timing confirms.
 * Both new tiers report only when a more precise candidate exists (else no finding).
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
const AXIS_TYPES = new Set(["Observation", "DiagnosticReport", "ServiceRequest", "Procedure"]);
const STRUCTURED = /^(http:\/\/hl7\.org\/fhir\/sid\/icd-10(-cm)?|http:\/\/loinc\.org)$/u;
const ICD = /icd-10/u;
const SKIP_SECTIONS = new Set(["instruction", "site_config", "family_history"]);
const RE_TAG = /\s*\((disorder|finding|symptom|situation|observable entity|procedure|substance|product|regime\/therapy|morphologic abnormality)\)\s*$/iu;
/** The label right before a value: words starting with a letter / CJK character (digits break it). */
const RE_LABEL_TAIL = /(?:[A-Za-z㐀-鿿][A-Za-z0-9㐀-鿿%#.\-()（）]*)(?:\s+[A-Za-z㐀-鿿][A-Za-z0-9㐀-鿿%#.\-()（）]*){0,3}$/u;
const RE_CLAUSE = /[，,；;。|]/u;

/** Document / study / panel names: a code of a class of items, never "another item" of the record. */
const RE_GENERIC_NAME = /\b(?:study|studies|panel|pnl|note|notes|document|documents|report|reports|summary)\b|\{setting\}|\{role\}/iu;
/** Class words: a name made of these only (≤ 3 words) is a generic code. */
const CLASS_WORDS = new Set(
  "diagnostic diagnosis imaging study test tests testing laboratory lab result results cancer tumor tumour stage staging grade grading genetic gene variant molecular assessment evaluation examination exam procedure finding findings disorder disease condition observation measurement therapy treatment medication drug hormone status score scale history physical clinical general other unspecified".split(" "),
);
const TAG_ANY = /\s*\([^()]*\)\s*$/u;

/** Whether a coding's names are those of a generic / class code (see the module comment). */
export function isGenericCode(names: readonly string[]): boolean {
  const en = names.filter((n) => /[A-Za-z]{3,}/u.test(n) && !hasCjk(n));
  if (!en.length) return false;
  if (en.some((n) => RE_GENERIC_NAME.test(n))) return true;
  return en.some((n) => {
    const w = n.replace(TAG_ANY, "").toLowerCase().split(/[^a-z0-9]+/u).filter((x) => x.length > 1 && x !== "of" && x !== "and" && x !== "in");
    return w.length > 0 && w.length <= 3 && w.every((x) => CLASS_WORDS.has(x));
  });
}

/** Instrument / score tokens: acronyms (ECOG, NYHA, KPS, DAS28) and CamelCase methods (VectraDA). */
const RE_INSTRUMENT = /^(?:[A-Z]{3,}\d*|[A-Z]{2,}\d+|[A-Z][a-z]{3,}[A-Z]{2,})$/u;
export function instrumentTokens(s: string): string[] {
  return [...new Set((s.normalize("NFKC").match(/[A-Za-z][A-Za-z0-9]*/gu) ?? []).filter((t) => RE_INSTRUMENT.test(t)))];
}
const latWords = (s: string): string[] => (s.normalize("NFKC").match(/[A-Za-z][A-Za-z0-9]*/gu) ?? []).map((t) => t.toLowerCase());
/** The record token R is named by the text when one of its words equals R or is a more specific form of it (R…). */
const namesToken = (text: string, r: string): boolean => latWords(text).some((w) => w.startsWith(r.toLowerCase()));
const namesTokenExact = (text: string, r: string): boolean => (text.normalize("NFKC").match(/[A-Za-z][A-Za-z0-9]*/gu) ?? []).some((w) => w.startsWith(r));

export type Timing = "fasting" | "post-meal" | "random";
const CODE_TIMING: Array<[Timing, RegExp]> = [
  ["fasting", /\bfasting\b|\bp fast\b|\bpost CFst\b|\bpre-?meal\b|\bpreprandial\b/iu],
  ["post-meal", /\bpost[ -]?meal\b|\bp meal\b|\bpost-?prandial\b|\bPC\b/iu],
  ["random", /\brandom\b/iu],
];
const RECORD_TIMING: Array<[Timing, RegExp]> = [
  ["fasting", /(?<![A-Za-z])(?:AC|FBS|FPG)(?![A-Za-z])|空腹|飯前|餐前|禁食|\b[Ff]asting\b|\b[Pp]re-?prandial\b/u],
  ["post-meal", /(?<![A-Za-z])\d?h?(?:PC|PPG)(?![A-Za-z])|飯後|餐後|\b[Pp]ost-?prandial\b|\b[Pp]ost[ -]?meal\b/u],
  ["random", /隨機|\brandom\b/iu],
];
const TIMING_QUERY: Record<Timing, string> = { fasting: "fasting", "post-meal": "post meal", random: "random" };
const timingsOf = (texts: readonly string[], table: Array<[Timing, RegExp]>): Set<Timing> => new Set(table.filter(([, re]) => texts.some((t) => re.test(t.normalize("NFKC")))).map(([k]) => k));
/** The timing a coding's names state (one, or null: none / several). */
export function codeTiming(names: readonly string[]): Timing | null {
  const t = timingsOf(names.filter((n) => !hasCjk(n)), CODE_TIMING);
  if (!t.size) {
    const zh = timingsOf(names.filter((n) => hasCjk(n)), RECORD_TIMING);
    return zh.size === 1 ? [...zh][0] : null;
  }
  return t.size === 1 ? [...t][0] : null;
}
/** The timing a record phrase states (one, or null). AC / PC only as standalone upper-case tokens. */
export function recordTiming(phrase: string): Timing | null {
  const t = timingsOf([phrase], RECORD_TIMING);
  return t.size === 1 ? [...t][0] : null;
}
/** The code's analyte (LOINC component before `^`, else the shortest English name's leading words). */
function analyteOf(names: readonly string[]): string | null {
  const comp = names.find((n) => /\^/u.test(n));
  if (comp) return comp.split("^")[0].trim() || null;
  const en = names.filter((n) => !hasCjk(n) && /[A-Za-z]{3,}/u.test(n)).map((n) => n.replace(/\s*\[.*$/u, "").replace(/\s+--.*$/u, "").trim());
  const base = en.map((n) => n.replace(/^(?:fasting|random)\s+/iu, "")).sort((a, b) => a.length - b.length)[0];
  return base && base.length >= 3 ? base : null;
}

export interface MeaningTarget {
  /** Instance path of the CodeableConcept (…resource.code / …component[1].code). */
  path: string;
  system: string;
  code: string;
  display: string | null;
  resourceType: string;
  /**
   * The record phrase the element stands for — and the text fhir_normalize_code is asked (lookups.ts keys the
   * candidates by it). Timing tier: the code's analyte + the English cue (「Glucose post meal」 for 飯後血糖), the record
   * wording then in `recordPhrase`.
   */
  phrase: string;
  /** The record wording when `phrase` is a derived query (timing tier). */
  recordPhrase?: string;
  source: "text" | "display" | "value-label";
  /** The record line, clipped (located quote). */
  line: string;
  /** Official names compared. */
  names: string[];
  similarity: number;
  tier: "unrelated" | "partly" | "instrument" | "timing";
  /** instrument tier: the record's instrument token and the code's (one the record does not state). */
  instrument?: { record: string; code: string };
  /** timing tier: the record's timing and the code's. */
  timing?: { record: Timing; code: Timing };
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
  /** The element's text / display not stated in the record, kept only for the instrument tier. */
  instrumentOnly?: boolean;
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

/**
 * Labels right before the value on the record clauses that carry it. `unlabeled`: an occurrence (of the preferred,
 * unit-carrying ones) has no label (「30/24」) — then no occurrence may be said to be the item's.
 */
function valueLabels(lines: readonly string[], value: unknown, unit: string | null): { labels: Phrase[]; unlabeled: boolean } {
  const rx = fmtNumber(value);
  if (!rx) return { labels: [], unlabeled: false };
  const all: Array<{ p: Phrase | null; unitHit: boolean }> = [];
  for (const line of lines) {
    for (const clause0 of line.split(RE_CLAUSE)) {
      const clause = clause0.trim();
      for (const m of clause.matchAll(rx)) {
        const text = labelBefore(clause.slice(0, m.index));
        const after = clause.slice(m.index + m[0].length, m.index + m[0].length + 14).toLowerCase();
        const unitHit = !!unit && after.includes(unit.toLowerCase());
        all.push({ p: text ? { text, source: "value-label", line: line.trim().slice(0, 120) } : null, unitHit });
      }
    }
  }
  const withUnit = all.filter((p) => p.unitHit);
  const use = withUnit.length ? withUnit : all;
  return { labels: use.flatMap((x) => (x.p ? [x.p] : [])), unlabeled: use.some((x) => !x.p) };
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

/** Numeric value of an Observation / component (valueQuantity / valueInteger) with its unit. */
function numericValue(owner: Json | null): { value: unknown; unit: string | null } | null {
  if (!owner) return null;
  const q = isObj(owner.valueQuantity) ? owner.valueQuantity : null;
  if (q && q.value !== undefined) return { value: q.value, unit: typeof q.unit === "string" ? q.unit : typeof q.code === "string" ? q.code : null };
  if (typeof owner.valueInteger === "number") return { value: owner.valueInteger, unit: null };
  return null;
}
const numberOf = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && /^-?\d+(\.\d+)?$/u.test(v.trim()) ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
/** Units that say nothing about the item (scores, ratios): no label is preferred by them. */
const RE_BLANK_UNIT = /^(?:\{[^}]*\}|1|%|)$/u;
const tokenIn = (text: string, tok: string): boolean => new RegExp(`(?<![A-Za-z0-9])${tok}(?![A-Za-z])`, "u").test(text.normalize("NFKC"));

/**
 * The instrument tier (see the module comment): the record's instrument token that the code's names do not name, and
 * a code instrument token that the record line / phrase does not state; null when there is no such pair.
 */
function instrumentConflict(phrase: string, line: string, names: readonly string[], abbr: AbbreviationMap | null): { record: string; code: string } | null {
  const rec = instrumentTokens(phrase).filter((r) => !names.some((n) => namesToken(n, r)) && !names.some((n) => abbreviationMatch(r, n, abbr)));
  if (!rec.length) return null;
  const codeToks = [...new Set(names.filter((n) => !hasCjk(n)).flatMap(instrumentTokens))];
  const absent = codeToks.filter((c) => !namesToken(line, c) && !namesToken(phrase, c) && !abbreviationMatch(phrase, c, abbr));
  if (!absent.length) return null;
  return { record: rec[0], code: absent[0] };
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
  const namesOf = (key: string): string[] =>
    [...(codeNames.get(key) ?? []), ...(codeNamesZh?.get(key) ?? []).filter((z) => z.confidence >= 0.5).map((z) => z.name)].filter((n) => typeof n === "string" && n.trim().length >= 2);
  // every coded element of the Bundle (like with like: a label naming another element's coding is not this element's)
  const work: Array<{ res: Json; path: string; cc: Json; owner: Json | null }> = [];
  const allCodings: Array<{ path: string; names: string[]; value: number | null }> = [];
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
      work.push({ res, path, cc, owner });
      for (const c of Array.isArray(cc.coding) ? cc.coding.filter(isObj) : []) {
        if (typeof c.system === "string" && typeof c.code === "string") allCodings.push({ path, names: namesOf(`${c.system}|${c.code}`), value: numberOf(numericValue(owner)?.value) });
      }
    }
  }
  // the label names another element carrying the same value (「BMI 24」 and an ALT of 24): it is that element's label
  const namesOther = (path: string, value: number | null, label: string): boolean =>
    value !== null && allCodings.some((o) => o.path !== path && o.value === value && o.names.some((n) => meaningSimilarity(label, n, abbr) >= PARTLY));
  const out: MeaningTarget[] = [];
  for (const { res, path, cc, owner } of work) {
    const codings: Json[] = Array.isArray(cc.coding) ? cc.coding.filter(isObj) : [];
    for (const c of codings) {
      if (typeof c.system !== "string" || typeof c.code !== "string" || !c.code.trim()) continue;
      const names = namesOf(`${c.system}|${c.code}`);
      if (!names.length) continue; // no official names: nothing to compare
      const generic = isGenericCode(names);
      const phrases = statedPhrases(cc, c, lines, names);
      // the element's own text / display naming an instrument the record states (「ECOG performance status」 for 「ECOG：1」)
      const stated = new Set(phrases.map((p) => p.text));
      for (const [t, source] of [[cc.text, "text"], [c.display, "display"]] as const) {
        if (typeof t !== "string" || stated.has(t.trim())) continue;
        const tok = instrumentTokens(t).find((x) => lines.some((l) => tokenIn(l, x)));
        const line = tok ? lines.find((l) => tokenIn(l, tok)) : undefined;
        if (tok && line) phrases.push({ text: t.trim(), source, line: line.trim().slice(0, 120), instrumentOnly: true });
      }
      const ownAgrees = phrases.some((p) => !p.instrumentOnly && Math.max(...names.map((n) => meaningSimilarity(p.text, n, abbr))) >= PARTLY);
      const num = numericValue(owner);
      let labels: Phrase[] = [];
      if (num && !ownAgrees) {
        const unit = num.unit && !RE_BLANK_UNIT.test(num.unit.trim()) ? num.unit : null;
        const v = valueLabels(lines, num.value, unit);
        // like with like: every occurrence labelled, none naming another coding of the Bundle
        if (!v.unlabeled && v.labels.length && !v.labels.some((p) => namesOther(path, numberOf(num.value), p.text))) labels = v.labels;
      }
      // value labels: judged only when every labelled occurrence disagrees
      const groups: Phrase[][] = [...phrases.map((p) => [p]), ...(labels.length ? [labels] : [])];
      const structured = STRUCTURED.test(c.system);
      const base = { path, system: c.system, code: c.code, display: typeof c.display === "string" ? c.display : null, resourceType: res.resourceType, names };
      // instrument / timing tiers: measurements and orders only (never medicines — brand vs generic — or diagnoses)
      const axisOk = AXIS_TYPES.has(res.resourceType);
      const ct = axisOk ? codeTiming(names) : null;
      // at most one target per tier, the most specific first (timing, then similarity, then instrument); step 2 reports
      // the first one its candidates confirm
      let timing: MeaningTarget | null = null;
      let similar: MeaningTarget | null = null;
      let instrument: MeaningTarget | null = null;
      for (const g of groups) {
        const p0 = g[0];
        // timing tier: every phrase of the group states the same timing, the code another one
        const rts = g.map((p) => recordTiming(p.text));
        if (!timing && ct && rts[0] && rts.every((x) => x === rts[0]) && rts[0] !== ct) {
          const analyte = analyteOf(names);
          if (analyte) timing = { ...base, phrase: `${analyte} ${TIMING_QUERY[rts[0]]}`, recordPhrase: p0.text, source: p0.source, line: p0.line, similarity: 0, tier: "timing", timing: { record: rts[0], code: ct } };
        }
        // instrument tier: every phrase names the same instrument the code does not, the code one the record does not
        const conf = axisOk ? g.map((p) => instrumentConflict(p.text, p.line, names, abbr)) : [];
        const c0 = conf[0];
        if (!instrument && c0 && conf.every((x) => x && x.record === c0.record)) instrument = { ...base, phrase: p0.text, source: p0.source, line: p0.line, similarity: 0, tier: "instrument", instrument: c0 };
        // similarity tiers: never for a class code, never on a text the record does not state
        if (similar || generic || g.some((p) => p.instrumentOnly)) continue;
        if (!g.every((p) => comparable(p.text, names, abbr))) continue;
        const sims = g.map((p) => Math.max(...names.map((n) => meaningSimilarity(p.text, n, abbr))));
        const sim = Math.max(...sims);
        const tier = sim < UNRELATED ? "unrelated" : sim < PARTLY && structured && !MED_TYPES.has(res.resourceType) ? "partly" : null;
        if (!tier) continue;
        const p = g[sims.indexOf(Math.min(...sims))];
        similar = { ...base, phrase: p.text, source: p.source, line: p.line, similarity: Math.round(sim * 100) / 100, tier };
      }
      for (const t of [timing, similar, instrument]) if (t) out.push(t);
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

/** Shared words of the LOINC property / system parts (「[Mass/volume] in Serum or Plasma」): same kind of measurement. */
const measureParts = (n: string): Set<string> => {
  const m = /\[([^\]]+)\]\s*(?:in\s+([^-]+))?/u.exec(n);
  return new Set(m ? [m[1], (m[2] ?? "").trim()].filter(Boolean).map((x) => x.toLowerCase()) : []);
};
const TIMING_ZH: Record<Timing, string> = { fasting: "空腹", "post-meal": "飯後", random: "隨機" };

/** Candidates confirming an instrument / timing target, closest kind of measurement first. */
function axisCandidates(t: MeaningTarget, cands: readonly MeaningCandidate[]): MeaningCandidate[] {
  const own = new Set(t.names.flatMap((n) => [...measureParts(n)]));
  const ok = cands.filter((c) => {
    if (!c.display || c.code === t.code) return false;
    if (t.tier === "timing" && t.timing) {
      const analyte = t.phrase.slice(0, t.phrase.length - TIMING_QUERY[t.timing.record].length).trim().toLowerCase();
      return codeTiming([c.display]) === t.timing.record && c.display.toLowerCase().includes(analyte);
    }
    // the record's instrument as the record writes it (ECOG, never the 「ECog」 of another instrument)
    if (t.tier === "instrument" && t.instrument) return namesTokenExact(c.display, t.instrument.record) && !namesToken(c.display, t.instrument.code);
    return false;
  });
  // timing: the same property / specimen; instrument: the most words shared with the code's names (score vs panel)
  const ownWords = new Set(t.names.flatMap((n) => latWords(n)).filter((w) => w.length > 2));
  const shared = (c: MeaningCandidate): number =>
    t.tier === "timing" ? [...measureParts(c.display ?? "")].filter((x) => own.has(x)).length : latWords(c.display ?? "").filter((w) => ownWords.has(w)).length;
  return ok.map((c, i) => ({ c, i, s: shared(c) })).sort((x, y) => y.s - x.s || x.i - y.i).map((x) => x.c);
}

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
    const axis = t.tier === "instrument" || t.tier === "timing";
    let naming: MeaningCandidate[];
    if (axis) {
      // only when a more precise code (the record's instrument / timing) exists among the candidates
      naming = axisCandidates(t, cands);
    } else {
      if (cands.some((c) => c.code === t.code)) continue; // the normalizer finds this very code for the phrase
      naming = cands.filter((c) => {
        if (!c.display) return false;
        if (ICD.test(t.system) && icdRelated(c.code, t.code)) return false; // a parent / child, never "another diagnosis"
        const s = meaningSimilarity(t.phrase, c.display, abbr);
        if (t.tier === "partly") return nameSimilarity(c.display, t.phrase) >= 0.99 && s - t.similarity >= 0.3;
        return s >= NAMES_PHRASE;
      });
    }
    if (!naming.length) continue;
    if (!axis && MED_TYPES.has(t.resourceType)) {
      const own = ingredientWords(t.names);
      if (naming.some((c) => [...ingredientWords([c.display ?? ""])].some((w) => own.has(w)))) continue;
    }
    done.add(t.path);
    const shown = naming.slice(0, 5);
    const codeName = clip(t.names[0], 60);
    const phrase = clip(t.recordPhrase ?? t.phrase, 40);
    const list = shown.map((c) => `${c.code}${c.display ? ` ${clip(c.display, 40)}` : ""}`).join("; ");
    const from = t.source === "value-label" ? "the label before the value" : t.source === "text" ? "CodeableConcept.text" : "the coding display";
    let zh: string;
    let en: string;
    let evidence: string;
    if (t.tier === "timing" && t.timing) {
      zh = `代碼的採檢時機與病歷不符：病歷寫「${phrase}」（${TIMING_ZH[t.timing.record]}），但 ${t.system}#${t.code}「${codeName}」是${TIMING_ZH[t.timing.code]}的檢驗。請改用相符時機的代碼（候選：${list}）`;
      en = `The code's timing does not match the record: the record states "${phrase}" (${t.timing.record}), but ${t.system}#${t.code} "${codeName}" is a ${t.timing.code} test. Use the code of the record's timing (candidates: ${list})`;
      evidence = `R7 code meaning (ISSUES_v20.1, timing axis): the record phrase from ${from} states ${t.timing.record}, the coding's official names state ${t.timing.code}; fhir_normalize_code for '${clip(t.phrase, 40)}' (system ${t.system}) returns ${shown.length} code(s) of the record's timing`;
    } else if (t.tier === "instrument" && t.instrument) {
      zh = `代碼的量表／方法與病歷不符：病歷寫「${phrase}」（${t.instrument.record}），但 ${t.system}#${t.code}「${codeName}」是 ${t.instrument.code}。請改用病歷所寫量表的代碼（候選：${list}）`;
      en = `The code names another instrument than the record: the record states "${phrase}" (${t.instrument.record}), but ${t.system}#${t.code} "${codeName}" is ${t.instrument.code}. Use the code of the record's instrument (candidates: ${list})`;
      evidence = `R7 code meaning (ISSUES_v20.1, instrument): the record phrase from ${from} names ${t.instrument.record}, which the coding's official names do not; they name ${t.instrument.code}, which the record line does not state; fhir_normalize_code for the phrase (system ${t.system}) returns ${shown.length} code(s) naming ${t.instrument.record}`;
    } else {
      zh = `代碼的意思與病歷不符：病歷寫「${phrase}」，但 ${t.system}#${t.code} 的意思是「${codeName}」。請改用與病歷相符的代碼（fhir_normalize_code 候選：${list}）`;
      en = `The code does not mean what the record says: the record states "${phrase}", but ${t.system}#${t.code} means "${codeName}". Use the code that matches the record (fhir_normalize_code candidates: ${list})`;
      evidence = `R7 code meaning (ISSUES_v20 R2): the coding's official names (${t.names.slice(0, 3).map((n) => `'${clip(n, 40)}'`).join(", ")}) compared with the record phrase from ${from} — similarity ${t.similarity.toFixed(2)} (${t.tier}); fhir_normalize_code for the phrase (system ${t.system}) does not return this code and returns ${shown.length} that name the phrase`;
    }
    const issue = makeIssue("R7", "error", "code-meaning-mismatch", t.path, zh, en, evidence, [t.line]);
    out.push({
      ...issue,
      // ISSUES_v20.1: advisory — fed back to the model, never a release blocker
      gate: "advisory",
      record_phrase: t.recordPhrase ?? t.phrase,
      code_display: t.names[0],
      suggestions: shown.map((c, i) => ({ value: c.code, kind: "replace_code" as const, confidence: Math.round(Math.max(0.3, 0.7 - i * 0.1) * 100) / 100, reason: `fhir_normalize_code candidate for "${clip(t.phrase, 40)}"`, system: t.system, ...(c.display ? { display: c.display } : {}) })),
    } as RecordIssue);
  }
  return out;
}
