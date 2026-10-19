/**
 * Deterministic Taiwan clinical-text normalizers and lexicon lookups for the grounding engine.
 *
 * TypeScript port of mcp_proposal/reference/tw_lexicon.py (reference only). All tables live in the versioned
 * data module twLexiconData.ts; this file holds the pure functions. Python regex semantics that differ from JS
 * (Unicode `\b` / `\w`, `str.isalpha`, whitespace) are emulated through py.ts so that results match the
 * reference fixtures. No I/O, no LLM, no randomness.
 */
import { createHash } from "node:crypto";

import {
  PB,
  PW,
  cpLen,
  cpSlice,
  escapeRe,
  isAlnum,
  isAlpha,
  isAscii,
  pyFloat,
  pyLstrip,
  pyRound,
  pyStrip,
  validDate,
  daysFromCivil,
  civilFromDays,
} from "./py.js";
import { TW_LEXICON_DATA } from "./twLexiconData.js";

const D = TW_LEXICON_DATA;

export const LEXICON_VERSION = `${D.name} ${D.version}`;
/** SHA-256 of the canonical JSON of the lexicon data (reported in provenance). */
export const LEXICON_SHA256 = createHash("sha256").update(JSON.stringify(D)).digest("hex");

// --------------------------------------------------------------------------------------------- Python regex syntax
/**
 * Compile a Python `re` pattern (as written in the lexicon data) to a `u`-flag JS RegExp:
 * `\b` / `\w` / `\W` become Unicode-aware (Python str semantics), `\-` outside a class becomes `-`
 * (an invalid identity escape in `u` mode), unknown identity escapes are unescaped.
 */
export function pyRe(src: string, flags = ""): RegExp {
  let out = "";
  let inClass = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\\" && i + 1 < src.length) {
      const n = src[++i];
      if (inClass) {
        if (n === "w") out += "\\p{L}\\p{N}_";
        else if (n === "-") out += "\\-";
        else if (/[dDsSnrtfv\\\]^[./*+?(){}|$]/.test(n) || /[0-9]/.test(n)) out += "\\" + n;
        else out += escapeRe(n);
      } else {
        if (n === "b") out += PB;
        else if (n === "w") out += PW;
        else if (n === "W") out += "[^\\p{L}\\p{N}_]";
        else if (/[dDsSBnrtfv\\^$.|?*+()[\]{}/]/.test(n) || /[0-9]/.test(n)) out += "\\" + n;
        else out += escapeRe(n);
      }
      continue;
    }
    if (c === "[" && !inClass) inClass = true;
    else if (c === "]" && inClass) inClass = false;
    out += c;
  }
  return new RegExp(out, "u" + flags);
}

/** All matches of a global regex (Python `finditer`). */
export function findAll(rx: RegExp, s: string): RegExpExecArray[] {
  const out: RegExpExecArray[] = [];
  rx.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(s)) !== null) {
    out.push(m);
    if (m[0].length === 0) rx.lastIndex++;
  }
  rx.lastIndex = 0;
  return out;
}

// --------------------------------------------------------------------------------------------- normalization
const DASH_SET = new Set(Array.from(D.normalization.dashes));
const KEEP = new Set(Array.from(D.normalization.keepSymbols));

/** NFKC (full-width -> half-width, ℃ -> °C, ① -> 1 ...), unify dashes, lower-case. */
export function nfkc(s: unknown): string {
  const t = String(s).normalize("NFKC");
  let out = "";
  for (const ch of t) out += DASH_SET.has(ch) ? "-" : ch;
  return out.toLowerCase();
}

function keep(ch: string): boolean {
  return isAlnum(ch) || KEEP.has(ch);
}

const NORM_CACHE = new Map<string, [string, number[]]>();

/**
 * Normalized string plus an index map (normalized position -> UTF-16 offset of the source character).
 * Whitespace and most punctuation are dropped. Each source code point is normalized on its own, as in the
 * reference, so positions always map back to a whole source character.
 */
export function normWithMap(text: string): [string, number[]] {
  const hit = NORM_CACHE.get(text);
  if (hit) return hit;
  let out = "";
  const idx: number[] = [];
  let i = 0;
  for (const c of text) {
    for (const ch of nfkc(c)) {
      if (keep(ch)) {
        out += ch;
        idx.push(i);
      }
    }
    i += c.length;
  }
  const r: [string, number[]] = [out, idx];
  if (text.length <= 20000) {
    if (NORM_CACHE.size > 5000) NORM_CACHE.clear();
    NORM_CACHE.set(text, r);
  }
  return r;
}

export function norm(text: string): string {
  return normWithMap(text)[0];
}

export function isCjk(ch: string): boolean {
  if (!ch) return false;
  const cp = ch.codePointAt(0)!;
  return (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf);
}

function lastChar(s: string): string {
  const a = Array.from(s);
  return a.length ? a[a.length - 1] : "";
}

// --------------------------------------------------------------------------------------------- sections
export type SectionKey = string;

const SEC_LIST: Array<[string, string]> = Object.entries(D.sections.terms as Record<string, string[]>)
  .flatMap(([k, ts]) => ts.map((t) => [t, k] as [string, string]))
  .sort((a, b) => cpLen(b[0]) - cpLen(a[0]));
const SEC_RE = new Map<string, RegExp>(SEC_LIST.map(([t]) => [t, new RegExp("(?<![a-z])" + escapeRe(t) + "(?![a-z])", "u")]));
const SOAP = D.sections.soapLetters as Record<string, string>;
export const DEFAULT_INSTRUCTION_MARKERS: readonly string[] = D.sections.instructionMarkers;
const SITE_MARK = nfkc(D.sections.siteConfigMarker);
const SINGLE_LINE_SECTIONS = new Set<string>(D.sections.singleLineSections);
const RE_SOAP = /^([soap])\s*[:：]/u;
const RE_DATE_PREFIX = /^\d{2,4}[/.-]\d{1,2}[/.-]\d{1,2}\s*(\d{1,2}:\d{2}(\s*[-~～]\s*\d{1,2}:\d{2})?)?\s*/u;
const RE_LIST_PREFIX = /^[-*#・•●]|^\(?\d+[.)、]|^\(\d+\)/u;
const RE_LABEL = /^([^:：]{1,40}?)\s*[:：]/u;
const RE_ANY_DIGIT = /\p{Nd}/u;

function normMarkers(markers: readonly string[]): string[] {
  return markers.map((m) => pyStrip(nfkc(m))).filter((m) => m.length > 0);
}

/**
 * Section key if the line starts a section (label before ':'/'：' contains a section term, or SOAP 'A:'), else null.
 * Numbered list items ('1. ...', '# ...', '(2) ...') are never headers. Lines starting with one of the instruction
 * markers are 'instruction' lines (never evidence).
 */
export function headerOf(line: string, instructionMarkers: readonly string[] = DEFAULT_INSTRUCTION_MARKERS): string | null {
  return headerOfNorm(line, normMarkers(instructionMarkers));
}

function headerOfNorm(line: string, markers: readonly string[]): string | null {
  let s = pyStrip(nfkc(line));
  if (!s) return null;
  for (const mk of markers) if (s.startsWith(mk)) return "instruction";
  if (s.startsWith(SITE_MARK)) return "site_config";
  const ms = RE_SOAP.exec(s);
  if (ms) return SOAP[ms[1]];
  s = s.replace(RE_DATE_PREFIX, "");
  if (RE_LIST_PREFIX.test(s)) return null;
  const m = RE_LABEL.exec(s);
  const label = m ? pyStrip(m[1]) : cpLen(s) <= 24 && !RE_ANY_DIGIT.test(s) ? s : null;
  if (!label) return null;
  for (const [term, key] of SEC_LIST) {
    if (label.startsWith(term)) {
      const tl = cpLen(term);
      if (isCjk(lastChar(term)) || !isAlpha(cpSlice(label, tl, tl + 1))) return key;
    }
  }
  for (const [term, key] of SEC_LIST) {
    if (cpLen(term) >= 2 && (isCjk(Array.from(term)[0]) ? label.includes(term) : SEC_RE.get(term)!.test(label))) return key;
  }
  return null;
}

export interface SourceLine {
  start: number;
  end: number;
  line: string;
  section: string;
  header: boolean;
}

/** Split into lines and assign a section to each line. Offsets are UTF-16 offsets into `text`. */
export function segment(text: string, instructionMarkers: readonly string[] = DEFAULT_INSTRUCTION_MARKERS): SourceLine[] {
  const markers = normMarkers(instructionMarkers);
  const lines: SourceLine[] = [];
  let pos = 0;
  let cur = "preamble";
  for (const raw of text.split("\n")) {
    const h = headerOfNorm(raw, markers);
    const sec = h ?? cur;
    if (h && !SINGLE_LINE_SECTIONS.has(h)) cur = h;
    lines.push({ start: pos, end: pos + raw.length, line: raw, section: sec, header: !!h });
    pos += raw.length + 1;
  }
  return lines;
}

export function hasStructure(lines: readonly SourceLine[]): boolean {
  return lines.filter((l) => l.header && l.section !== "instruction" && l.section !== "site_config").length >= 2;
}

// --------------------------------------------------------------------------------------------- negation / history / absence
export const NEG_CUES: readonly string[] = D.context.negCues;
export const HIST_CUES: readonly string[] = D.context.histCues;
export const OBS_HIST_CUES: readonly string[] = D.context.obsHistCues;
export const CLAUSE_SPLIT = pyRe(D.context.clauseSplit, "g");
export const ABSENCE_WORDS: readonly string[] = D.context.absenceWords;
export const ABSENCE_CONCEPTS = D.context.absenceConcepts as Record<string, string[]>;
/** Concepts that belong to the patient (one value per record): matched on the whole field label only. */
export const ABSENCE_PATIENT_CONCEPTS = new Set<string>(D.context.absencePatientConcepts);
const ABSENCE_QUALIFIERS: readonly string[] = D.context.absenceLabelQualifiers;
const ABSENCE_FILLERS: readonly string[] = D.context.absenceLabelFillers;
const ABSENCE_VALUE_FILLERS: readonly string[] = D.context.absenceValueFillers;
const ABSENCE_WORDS_LONGEST = [...D.context.absenceWords].sort((a, b) => b.length - a.length);

/** Characters a field label may consist of (labels end at ':' and other punctuation; '、' '/' '&' separate list items). */
const LABEL_CHARS = String.raw`\p{Script=Han}a-z0-9#.&'\-、/ `;
const RE_LABEL_TAIL = new RegExp(`[${LABEL_CHARS}]+$`, "u");
const RE_LABEL_HEAD = new RegExp(`^[${LABEL_CHARS}]+`, "u");
const RE_LIST_SEP = /、|\/|&|及|與|和|\band\b|\bor\b|或/u;
const HAN_RE = /\p{Script=Han}/u;
const ASCII_WORD_RE = /^[a-z][a-z'.\-]*$/u;
const isHan = (ch: string | undefined): boolean => !!ch && HAN_RE.test(ch);

function stripFillers(x: string, fillers: readonly string[], atEnd: boolean): string {
  let s = x.trim();
  for (let changed = true; changed && s; ) {
    changed = false;
    for (const f of fillers) {
      const latin = /^[a-z]/u.test(f);
      if (atEnd && s.endsWith(f) && (!latin || s.length === f.length || s[s.length - f.length - 1] === " ")) {
        s = s.slice(0, s.length - f.length).trim();
        changed = true;
      } else if (!atEnd && s.startsWith(f) && (!latin || s.length === f.length || s[f.length] === " ")) {
        s = s.slice(f.length).replace(/^(的|之|'s)\s*/u, "").trim();
        changed = true;
      }
    }
  }
  return s;
}

/**
 * The absence concept a field label names, by whole-label matching (never by prefix: 出生地 / 出生院所 are not the
 * birth date, 住院號 is not a date, 聯絡人姓名 is not the patient's name).
 * - patient concepts (name / MRN / national ID / birth date): the label, after dropping trailing fillers (欄位 …) and a
 *   leading patient qualifier (病人 / patient …), must equal a term;
 * - other concepts (date / dose / frequency / value / diagnosis): the label must equal or END with a term — Chinese
 *   labels are head-final (施測日期, 新劑量, 檢驗結果) — Latin terms as whole words.
 * The longest matching term wins (出生日期 = birth date, not 日期 = date).
 */
export function absenceConceptOfLabel(label0: string, position: "before" | "after" = "before"): string | null {
  const x = stripFillers(nfkc(label0), ABSENCE_FILLERS, true);
  if (!x) return null;
  const y = stripFillers(x, ABSENCE_QUALIFIERS, false);
  const toks = x.split(/\s+/u).filter(Boolean);
  let best: [string, number] | null = null;
  const consider = (c: string, w: string, score: number): void => {
    if (!best || score > best[1]) best = [c, score];
  };
  for (const [c, terms] of Object.entries(ABSENCE_CONCEPTS)) {
    const patient = ABSENCE_PATIENT_CONCEPTS.has(c);
    for (const w0 of terms) {
      const w = nfkc(w0);
      const wl = w.length;
      if (x === w || y === w) {
        consider(c, w, 1000 + wl);
        continue;
      }
      const latin = !HAN_RE.test(w);
      if (latin) {
        // whole-word suffix ('patient dob') / prefix after the absence word ('unknown dob, …'); the neighbouring word
        // must not be another Latin noun ('contact name', 'name of father')
        const wt = w.split(/\s+/u);
        const k = wt.length;
        if (toks.length <= k) continue;
        if (position === "before" && toks.slice(-k).join(" ") === w) {
          const prev = toks[toks.length - k - 1];
          if (patient && ASCII_WORD_RE.test(prev) && !ABSENCE_QUALIFIERS.includes(prev)) continue;
          consider(c, w, wl);
        } else if (position === "after" && toks.slice(0, k).join(" ") === w) {
          if (toks[k] === "of") continue;
          if (!patient || !ASCII_WORD_RE.test(toks[k])) consider(c, w, wl);
        }
        continue;
      }
      if (!patient && position === "before" && x.endsWith(w)) consider(c, w, wl);
    }
  }
  return best ? (best as [string, number])[0] : null;
}

function labelItems(run: string, position: "before" | "after"): string[] {
  const out: string[] = [];
  for (const part of run.split(RE_LIST_SEP)) {
    let it = part.trim();
    if (!it) continue;
    const ws = it.split(/\s+/u);
    // a Chinese label never contains a space: keep the word next to the absence word
    if (position === "before" && HAN_RE.test(ws[ws.length - 1])) it = ws[ws.length - 1];
    if (position === "after" && HAN_RE.test(ws[0])) it = ws[0];
    out.push(it);
  }
  return out;
}

function absenceWordAt(cl: string, i: number): string | null {
  for (const a of ABSENCE_WORDS_LONGEST) {
    if (!cl.startsWith(a, i)) continue;
    if (/^[a-z]/u.test(a)) {
      if (/[a-z0-9]/u.test(cl[i - 1] ?? "") || /[a-z0-9]/u.test(cl[i + a.length] ?? "")) continue;
    }
    return a;
  }
  return null;
}

/**
 * Concepts a clause states as not available ('出生日期：不詳', '（新劑量待補登）', '姓名、病歷號碼欄位空白', '未提供病歷號',
 * 'DOB: unknown'). The absence word must be the value of a field whose label names the concept (label before it), or —
 * when no label precedes it — be followed directly by the concept ('未記載劑量'). A Chinese absence word that is part
 * of a longer term after a label ('診斷：不明原因發燒') is not an absence statement.
 */
export function absenceConceptsIn(clause: string): string[] {
  const cl = nfkc(clause);
  const out = new Set<string>();
  for (let i = 0; i < cl.length; ) {
    const a = absenceWordAt(cl, i);
    if (!a) {
      i++;
      continue;
    }
    const e = i + a.length;
    let pre = cl.slice(0, i).replace(/[\s:=]+$/u, "");
    pre = stripFillers(pre, ABSENCE_VALUE_FILLERS, true).replace(/[\s:=]+$/u, "");
    const run = RE_LABEL_TAIL.exec(pre)?.[0]?.trim() ?? "";
    // '未提供病歷號' (absence word directly followed by the concept) or 'unknown DOB' with no label before it
    const prefixUse = HAN_RE.test(a) ? isHan(cl[e]) : !run;
    if (prefixUse) {
      const post = cl.slice(e).replace(/^\s*(的|之|of)?\s*/u, "");
      const head = RE_LABEL_HEAD.exec(post)?.[0]?.trim() ?? "";
      if (head)
        for (const it of labelItems(head, "after")) {
          const c = absenceConceptOfLabel(it, "after");
          if (c) out.add(c);
        }
    } else if (run) {
      for (const it of labelItems(run, "before")) {
        const c = absenceConceptOfLabel(it, "before");
        if (c) out.add(c);
      }
    }
    i = e;
  }
  return [...out];
}

/**
 * Patient concepts the record states WITH a value ('出生日期：1960/03/02'): a stated-absent scan never reports a patient
 * concept the same record gives positively.
 */
export function positivePatientConcepts(text: string): Set<string> {
  const out = new Set<string>();
  const t = nfkc(text);
  for (const m of t.matchAll(new RegExp(`([${LABEL_CHARS}]+?)\\s*:\\s*([^\\s:;；。,，]+)`, "gu"))) {
    const run = m[1].trim();
    const value = m[2].replace(/^[(\[（「]+/u, "");
    if (!value || ABSENCE_WORDS_LONGEST.some((w) => value.startsWith(w))) continue;
    const items = labelItems(run, "before");
    const c = items.length ? absenceConceptOfLabel(items[items.length - 1], "before") : null;
    if (c && ABSENCE_PATIENT_CONCEPTS.has(c)) out.add(c);
  }
  return out;
}

// --------------------------------------------------------------------------------------------- identifiers
export const ID_LABELS = D.identifiers.labels as Record<string, string[]>;
export const TW_ID_RE = pyRe(D.identifiers.twIdPattern);
export const NO_SITE_SYSTEMS: readonly string[] = D.identifiers.noSiteSystems;
const TWID_LETTER = new Map<string, number>(Array.from(D.identifiers.twIdLetters).map((c, i) => [c, 10 + i]));

/** Taiwan national ID check digit. */
export function twIdChecksumOk(value: string): boolean {
  const v = value.toUpperCase();
  if (!/^[A-Z][12489]\d{8}\n?$/u.test(v)) return false;
  const n = TWID_LETTER.get(v[0]);
  if (n === undefined) return false;
  let s = Math.floor(n / 10) + (n % 10) * 9;
  for (let i = 1; i <= 8; i++) s += Number(v[i]) * (9 - i);
  s += Number(v[9]);
  return s % 10 === 0;
}

// --------------------------------------------------------------------------------------------- gender
const RE_MALE = pyRe(D.gender.male);
const RE_FEMALE = pyRe(D.gender.female);

export function gendersIn(text: string): Set<string> {
  const t = nfkc(text);
  const out = new Set<string>();
  if (RE_MALE.test(t)) out.add("male");
  if (RE_FEMALE.test(t)) out.add("female");
  return out;
}

// --------------------------------------------------------------------------------------------- dates
export const CN_NUM = D.dates.cnNum as Record<string, number>;
export const DATE_PATTERNS: Array<[RegExp, string]> = D.dates.patterns.map(([p, k]) => [pyRe(p, "g"), k] as [RegExp, string]);
export const TIME_RE = pyRe(D.dates.time, "g");
const CN_TIME_RE = pyRe(D.dates.cnTime, "g");
const RELATIVE: Array<[RegExp, number | string]> = (D.dates.relative as Array<[string, number | string]>).map(([p, o]) => [pyRe(p, "g"), o]);
export const FHIR_DT = pyRe(D.dates.fhirDateTime.replace(/\$$/, "\\n?$"));

export type DatePrecision = "day" | "month" | "year" | "md";
export type ParsedDate = [DatePrecision, [number | null, number | null, number | null]];

function groupsInt(m: RegExpExecArray): number[] {
  return m.slice(1).filter((x) => x !== undefined).map((x) => parseInt(x, 10));
}


/** All absolute dates in text -> [precision, [y, m, d]] (ROC years converted). */
const DATES_CACHE = new Map<string, ParsedDate[]>();

export function parseDates(text: string): ParsedDate[] {
  const hit = DATES_CACHE.get(text);
  if (hit) return hit;
  const found = parseDatesPos(text).map((x) => x.date);
  if (DATES_CACHE.size > 5000) DATES_CACHE.clear();
  DATES_CACHE.set(text, found);
  return found;
}

export interface PositionedDate {
  date: ParsedDate;
  /** span in nfkc(text) */
  start: number;
  end: number;
}

const DATES_POS_CACHE = new Map<string, PositionedDate[]>();

/** parseDates with the span of each date (same dates, same order). */
export function parseDatesPos(text: string): PositionedDate[] {
  const hit = DATES_POS_CACHE.get(text);
  if (hit) return hit;
  const t = nfkc(text);
  const found: PositionedDate[] = [];
  const spans: Array<[number, number]> = [];
  for (const [rx, kind] of DATE_PATTERNS) {
    for (const m of findAll(rx, t)) {
      const st = m.index;
      if (spans.some(([a, b]) => a <= st && st < b)) continue;
      const g = groupsInt(m);
      const span: [number, number] = [st, st + m[0].length];
      if (kind === "roc" || kind === "west") {
        const y = kind === "roc" ? g[0] + 1911 : g[0];
        if (kind === "roc" && !(g[0] >= 1 && g[0] <= 200)) continue;
        if (validDate(y, g[1], g[2])) {
          found.push({ date: ["day", [y, g[1], g[2]]], start: span[0], end: span[1] });
          spans.push(span);
        }
      } else if (kind === "ym") {
        if (g[1] >= 1 && g[1] <= 12 && g[0] >= 1900 && g[0] <= 2100) {
          found.push({ date: ["month", [g[0], g[1], null]], start: span[0], end: span[1] });
          spans.push(span);
        }
      } else if (kind === "y") {
        if (g[0] >= 1900 && g[0] <= 2100) {
          found.push({ date: ["year", [g[0], null, null]], start: span[0], end: span[1] });
          spans.push(span);
        }
      } else if (kind === "md") {
        if (g[0] >= 1 && g[0] <= 12 && g[1] >= 1 && g[1] <= 31) {
          found.push({ date: ["md", [null, g[0], g[1]]], start: span[0], end: span[1] });
          spans.push(span);
        }
      } else if (kind === "roc_y") {
        if (g[0] >= 1 && g[0] <= 200) {
          found.push({ date: ["year", [g[0] + 1911, null, null]], start: span[0], end: span[1] });
          spans.push(span);
        }
      }
    }
  }
  if (DATES_POS_CACHE.size > 5000) DATES_POS_CACHE.clear();
  DATES_POS_CACHE.set(text, found);
  return found;
}

export function parseTimes(text: string): Array<[number, number]> {
  const t = nfkc(text);
  const out: Array<[number, number]> = findAll(TIME_RE, t).map((m) => [parseInt(m[1], 10), parseInt(m[2], 10)]);
  for (const m of findAll(CN_TIME_RE, t)) {
    let h = parseInt(m[2], 10);
    const mi = m[3] !== undefined && m[3] !== "" ? parseInt(m[3], 10) : m[0].includes("半") ? 30 : 0;
    if ((m[1] === "下午" || m[1] === "晚上") && h < 12) h += 12;
    if (h >= 0 && h <= 23) out.push([h, mi]);
  }
  return out;
}

export function relativeOffsets(text: string): number[] {
  const t = nfkc(text);
  const out: number[] = [];
  for (const [rx, off] of RELATIVE) {
    for (const m of findAll(rx, t)) {
      if (off === "n") out.push(-parseInt(m[1] ?? m[2], 10));
      else out.push(off as number);
    }
  }
  return out;
}

export interface FhirDateTime {
  y: number;
  m: number | null;
  d: number | null;
  hh: number | null;
  mi: number | null;
  tz: string | null;
  tz_converted?: string;
}

/** Parse a FHIR date/dateTime; times in other zones are converted to Asia/Taipei (+08:00) for comparison. */
export function parseFhirDatetime(v: unknown): FhirDateTime | null {
  const m = FHIR_DT.exec(typeof v === "string" ? v : typeof v === "number" ? String(v) : "\u0000");
  if (!m) return null;
  const [, y, mo, d, hh, mi, , tz] = m;
  const r: FhirDateTime = {
    y: parseInt(y, 10),
    m: mo ? parseInt(mo, 10) : null,
    d: d ? parseInt(d, 10) : null,
    hh: hh ? parseInt(hh, 10) : null,
    mi: mi ? parseInt(mi, 10) : null,
    tz: tz ?? null,
  };
  if (r.hh !== null && tz && tz !== "+08:00") {
    // Deviation (robustness): the reference raises on impossible components here; we treat them as unparseable.
    if (!validDate(r.y, r.m!, r.d!) || r.hh > 23 || r.mi! > 59) return null;
    const off = tz === "Z" ? 0 : (parseInt(tz.slice(1, 3), 10) * 60 + parseInt(tz.slice(4, 6), 10)) * (tz[0] === "+" ? 1 : -1);
    const total = daysFromCivil(r.y, r.m!, r.d!) * 1440 + r.hh * 60 + r.mi! - off + 480;
    const days = Math.floor(total / 1440);
    const mins = total - days * 1440;
    const [yy, mm, dd] = civilFromDays(days);
    Object.assign(r, { y: yy, m: mm, d: dd, hh: Math.floor(mins / 60), mi: mins % 60, tz_converted: tz });
  }
  return r;
}

/** `datetime.date(y,m,d) + timedelta(days)` -> [y, m, d]. */
export function addDays(y: number, m: number, d: number, days: number): [number, number, number] {
  return civilFromDays(daysFromCivil(y, m, d) + days);
}

// --------------------------------------------------------------------------------------------- numbers & units
const NUM_RE = pyRe(D.numbers.number, "g");
const UNIT_ALIASES = D.numbers.unitAliases as Record<string, string[]>;
const UNIT_INDEX = new Map<string, string>();
for (const [canon, al] of Object.entries(UNIT_ALIASES)) for (const a of al) if (!UNIT_INDEX.has(a)) UNIT_INDEX.set(a, canon);
const UNIT_TOKENS = [...UNIT_INDEX.keys()].sort((a, b) => cpLen(b) - cpLen(a));
const RE_COMPOUND_UNIT = /^[a-zµμ%[\]{}0-9.*^_]+\/[a-zµμ0-9.[\]{}_²]+/u;
const DOSE_UNIT_CLASS = D.numbers.doseUnitClass as Record<string, string>;
export const CONVERT = new Map<string, number>((D.numbers.convert as Array<[string, string, number]>).map(([f, t, k]) => [`${f}|${t}`, k]));

export function canonUnit(u: unknown): string | null {
  if (u === null || u === undefined) return null;
  const s = nfkc(u).replace(/ /g, "");
  return UNIT_INDEX.get(s) ?? (s || null);
}

/** [comparator, value, canonical unit, raw match] for every number in the text. */
export type NumberWithUnit = [string | null, number, string | null, string];

const NUMS_CACHE = new Map<string, NumberWithUnit[]>();

export function numbersWithUnits(text: string): NumberWithUnit[] {
  const hit = NUMS_CACHE.get(text);
  if (hit) return hit;
  const t = nfkc(text);
  const out: NumberWithUnit[] = [];
  for (const m of findAll(NUM_RE, t)) {
    const cmp = m[1] ?? null;
    const num = Number(m[2].replace(/,/g, ""));
    const exp = m[3];
    const end = m.index + m[0].length;
    const rawRest = t.slice(end, end + 18);
    const rest = pyLstrip(rawRest);
    const gap = rawRest.length - rest.length;
    let unit: string | null = null;
    if (exp) {
      unit = exp === "3" ? "10*3/ul" : exp === "6" ? "10*6/ul" : `10*${exp}/ul`;
    } else {
      for (const tok of UNIT_TOKENS) {
        if (!rest.startsWith(tok)) continue;
        const nxt = cpSlice(rest, cpLen(tok), cpLen(tok) + 1);
        if (isAlpha(lastChar(tok)) && isAlpha(nxt) && !isCjk(nxt)) continue;
        if (gap > 2 || (cpLen(tok) === 1 && isAscii(tok) && isAlpha(tok) && gap > 1)) break; // 'H' flag columns later is not a unit
        unit = UNIT_INDEX.get(tok)!;
        if (nxt === "/" && !tok.includes("/")) {
          const m2 = RE_COMPOUND_UNIT.exec(rest);
          if (m2) unit = canonUnit(m2[0]);
        }
        break;
      }
    }
    out.push([cmp, num, unit, m[0]]);
  }
  if (NUMS_CACHE.size > 5000) NUMS_CACHE.clear();
  NUMS_CACHE.set(text, out);
  return out;
}

export function sameNumber(a: unknown, b: unknown): boolean {
  const x = pyFloat(a);
  const y = pyFloat(b);
  if (Number.isNaN(x) || Number.isNaN(y)) return false;
  return Math.abs(x - y) < 1e-9;
}

export function unitsCompatible(qUnit: unknown, vUnit: unknown): boolean {
  if (qUnit === null || qUnit === undefined || vUnit === null || vUnit === undefined) return true;
  const a = canonUnit(qUnit);
  const b = canonUnit(vUnit);
  if (a === b) return true;
  const ca = a !== null ? DOSE_UNIT_CLASS[a] ?? a : a;
  const cb = b !== null ? DOSE_UNIT_CLASS[b] ?? b : b;
  return ca === cb;
}

// --------------------------------------------------------------------------------------------- frequency / route
export type PerDay = number | "once";
export const FREQ_CODES = D.medication.freqCodes as unknown as Record<string, [PerDay, string | null]>;
const RE_FREQ_CODE = pyRe(D.medication.freqCodePattern, "g");
const FREQ_ZH: Array<[RegExp, number]> = (D.medication.freqZh as Array<[string, number]>).map(([p, n]) => [pyRe(p), n]);
const EVERY_N_H = pyRe(D.medication.everyNHours, "g");
export const PRN_RE = pyRe(D.medication.prn);
/** Whether a text states as-needed (PRN) use in any phrasing of the lexicon ('PO PRN', '需要時使用', 'as needed', '視需要'). */
export function statesPrn(text: string): boolean {
  return PRN_RE.test(nfkc(text));
}
const HS_RE = pyRe(D.medication.hs);
export const UNIT_DOSE_FORM_RE = pyRe(D.medication.unitDoseForm);

/** Administrations per day stated in the text ('once' for STAT). */
export function freqSignatures(text: string): Set<PerDay> {
  const t = nfkc(text);
  const out = new Set<PerDay>();
  for (const m of findAll(RE_FREQ_CODE, t)) {
    const fc = FREQ_CODES[m[1]];
    // Deviation (robustness): the reference raises KeyError on e.g. 'q5h'; EVERY_N_H below covers those.
    if (fc) out.add(fc[0]);
  }
  for (const [rx, n] of FREQ_ZH) if (rx.test(t)) out.add(n);
  for (const m of findAll(EVERY_N_H, t)) {
    const g = m.slice(1).find((x) => x);
    const n = parseInt(g!, 10);
    if (n > 0) out.add(pyRound(24 / n, 3)); // deviation: the reference divides by zero on 'every 0 hours'
  }
  if (HS_RE.test(t)) out.add(1);
  return out;
}

const ROUTES = D.medication.routes as Record<string, string[]>;
const ROUTE_RES: Array<[string, RegExp[]]> = Object.entries(ROUTES).map(([k, al]) => [
  k,
  al.map((a) => new RegExp("(?<![a-z0-9])" + escapeRe(a) + "(?![a-z0-9])", "u")),
]);

export function routesIn(text: string): Set<string> {
  const t = nfkc(text);
  const out = new Set<string>();
  for (const [k, res] of ROUTE_RES) {
    if (res.some((r) => r.test(t))) out.add(k);
  }
  return out;
}

export const ENC_CLASS = D.encounter.encClass as Record<string, string[]>;
/** Department key (English stem, matched in code names) -> zh / en aliases of that department or care setting. */
export const DEPT_ZH = D.encounter.departments as Record<string, string[]>;

const ALIAS_RE_CACHE = new Map<string, RegExp>();
/**
 * Whether a lexicon alias occurs in the text. Aliases containing Chinese match as substrings. Latin aliases match as
 * whole tokens (case-insensitive; 'ED' / 'ER' / 'OPD' / 'ICU' never match inside 'treated' / 'fever' / 'medical');
 * aliases of 4+ letters also accept a plural / past-tense ending ('discharged', 'visits').
 */
export function aliasIn(text: string, alias: string): boolean {
  const a = nfkc(alias).trim();
  if (!a) return false;
  const t = nfkc(text);
  if (HAN_RE.test(a)) return t.includes(a);
  let r = ALIAS_RE_CACHE.get(a);
  if (!r) {
    const body = a.split(/\s+/u).map(escapeRe).join("[\\s\\-]+");
    const infl = a.length >= 4 && /[a-z]$/u.test(a) ? "(?:s|es|d|ed)?" : "";
    r = new RegExp(`(?<![a-z0-9])${body}${infl}(?![a-z0-9])`, "u");
    ALIAS_RE_CACHE.set(a, r);
  }
  return r.test(t);
}

/** Core of a department name without its suffix (急診醫學科 -> 急診, 心臟血管內科 -> 心臟血管內). */
export function departmentCore(name: string): string {
  return nfkc(name).trim().replace(DEPARTMENT_SUFFIX_RE, "");
}
const DEPARTMENT_SUFFIX_RE = pyRe(D.encounter.departmentSuffix);

/**
 * Department keys a code name / text denotes: the English key stem occurs in the name ('Emergency medicine' ->
 * emergency), a Latin alias occurs in it as whole words, or the name (or its core) equals a Chinese alias
 * ('急診醫學科' -> emergency; '神經內科' is neurology, not internal medicine).
 */
export function departmentKeysOf(name: string): string[] {
  const ln = nfkc(name).trim();
  const core = departmentCore(ln);
  const out: string[] = [];
  for (const [key, aliases] of Object.entries(DEPT_ZH)) {
    const hit =
      ln.includes(key) ||
      aliases.some((a0) => {
        const a = nfkc(a0).trim();
        if (HAN_RE.test(a)) return ln === a || (core.length >= 2 && core === departmentCore(a));
        return a.length >= 4 && aliasIn(ln, a);
      });
    if (hit) out.push(key);
  }
  return out;
}

// --------------------------------------------------------------------------------------------- terminology matching
const STOP = new Set<string>(D.terminology.stop);
const ZH_EN = Object.entries(D.terminology.zhEn as Record<string, string>);
const ABBREV = D.terminology.abbrev as Record<string, string>;
const LAT_TOKEN = pyRe(D.terminology.latToken, "g");
const GENERIC_TOKENS = new Set<string>(D.terminology.genericTokens);
const GENERIC_BIGRAMS = new Set<string>(D.terminology.genericBigrams);

function stem(w: string): string {
  if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length > 4 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

const LAT_CACHE = new Map<string, Set<string>>();

/** Latin tokens (stemmed, stop words removed); with `expand`, CJK terms add their English bridge and abbreviations expand. */
export function latTokens(s: string, expand = true): Set<string> {
  const key = (expand ? "1" : "0") + s;
  const hit = LAT_CACHE.get(key);
  if (hit) return hit;
  let t = nfkc(s);
  if (expand) for (const [zh, en] of ZH_EN) if (t.includes(zh)) t += " " + en;
  const toks = new Set<string>();
  for (const m of findAll(LAT_TOKEN, t)) {
    const w = m[0];
    const parts = [w, ...(w.includes("-") ? w.split("-") : [])];
    for (const p of parts) {
      if (expand && Object.prototype.hasOwnProperty.call(ABBREV, p)) for (const x of ABBREV[p].split(/\s+/).filter(Boolean)) toks.add(stem(x));
      if (p && !STOP.has(p)) toks.add(stem(p));
    }
  }
  const out = new Set([...toks].filter((x) => !STOP.has(x)));
  if (LAT_CACHE.size > 20000) LAT_CACHE.clear();
  LAT_CACHE.set(key, out);
  return out;
}

const BRIDGE_NEUTRAL: readonly string[] = D.terminology.bridgeNeutral;

/** Share of a name's CJK characters covered by zh->en bridge terms or bridge-neutral specimen words (血液, 及 …). */
export function bridgeCoverage(name: string): number {
  const cj = cjkChars(name).join("");
  if (!cj) return 0;
  const covered = new Array<boolean>(cj.length).fill(false);
  for (const term of [...ZH_EN.map(([zh]) => zh), ...BRIDGE_NEUTRAL]) {
    for (let i = cj.indexOf(term); i >= 0; i = cj.indexOf(term, i + 1)) for (let k = 0; k < term.length; k++) covered[i + k] = true;
  }
  return covered.filter(Boolean).length / cj.length;
}

function cjkChars(s: string): string[] {
  return Array.from(nfkc(s)).filter(isCjk);
}

export function cjkBigrams(s: string): Set<string> {
  const cj = cjkChars(s);
  if (cj.length === 1) return new Set(cj);
  const out = new Set<string>();
  for (let i = 0; i < cj.length - 1; i++) out.add(cj[i] + cj[i + 1]);
  return out;
}

/** Longest common CJK substring length (reference algorithm, including its early break). */
export function lcsCjk(a0: string, b0: string): number {
  const a = cjkChars(a0).join("");
  const b = cjkChars(b0).join("");
  let best = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = i + best + 1; j <= a.length; j++) {
      if (b.includes(a.slice(i, j))) best = j - i;
      else break;
    }
  }
  return best;
}

/**
 * Weighted containment of the name tokens in the quote. Generic tokens weigh 0.2 (here 1 vs 5 in integers, so the
 * ratio is computed exactly and independently of set iteration order — the reference sums floats in hash order).
 */
function wcont(nameSet: Set<string>, quoteSet: Set<string>, generic: Set<string>): number {
  if (nameSet.size === 0) return 0;
  let total = 0;
  let hit = 0;
  for (const t of nameSet) {
    const w = generic.has(t) ? 1 : 5;
    total += w;
    if (quoteSet.has(t)) hit += w;
  }
  return hit / total;
}

/**
 * Similarity of an authoritative code name to a quote: max(latin-token, CJK-bigram weighted containment).
 * 'Acute nasopharyngitis' vs 'Acute appendicitis' scores low because 'acute' is generic.
 */
export function nameSimilarity(quote: string, name: string): number {
  const nt = latTokens(name, false);
  const ntExp = latTokens(name, true);
  const qt = latTokens(quote, true);
  let lat = 0;
  if (nt.size) lat = Math.max(wcont(nt, qt, GENERIC_TOKENS), wcont(ntExp, qt, GENERIC_TOKENS));
  else if (ntExp.size && [...ntExp].some((t) => !GENERIC_TOKENS.has(t))) {
    // Deviation (lexicon 0.3.0): a Chinese-only name (NHI payment / TW Core displays such as 09140C
    // '血液及體液葡萄糖-餐後') is compared with a Latin quote ('Glucose PC 2h') through its zh->en bridge, scaled by
    // the share of the name the bridge translates; names less than half translated are not compared this way (the
    // untranslated remainder can carry the distinguishing part).
    // A translation is weaker evidence than the name itself: it passes only when every translated term is in the
    // quote ('Glucose AC' must not match 葡萄糖-餐後 through 'glucose' alone: at most weak, 0.49).
    const cov = bridgeCoverage(name);
    const w = wcont(ntExp, qt, GENERIC_TOKENS);
    if (cov >= 0.5) lat = w >= 1 - 1e-9 ? cov : Math.min(w * cov, 0.49);
  }
  const nb = cjkBigrams(name);
  const qb = cjkBigrams(quote);
  let cj = nb.size ? wcont(nb, qb, GENERIC_BIGRAMS) : 0;
  if (nb.size && cj < 0.5 && nb.size >= 8) {
    const lcs = lcsCjk(name, quote);
    cj = Math.max(cj, lcs >= 4 ? 0.5 : 0);
  }
  if (SHORT_CJK_STRICT && cj >= 0.5 && isShortCjkPartial(name, quote)) cj = 0.49;
  return Math.max(lat, cj);
}

/** Deviation switch (on): see `isShortCjkPartial`. Exported for the parity test. */
export const SHORT_CJK_STRICT = true;

/**
 * Deviation from the reference: a short Chinese name (3-5 characters) must occur contiguously. Bigram containment
 * alone lets '白血球計數' (WBC) match '紅血球計數' (RBC) at 0.75, i.e. the wrong analyte. Partial matches drop to
 * "weak" (0.49), which still yields a warning, never a silent pass.
 */
export function isShortCjkPartial(name: string, quote: string): boolean {
  const n = cjkChars(name).length;
  return n >= 3 && n <= 5 && lcsCjk(name, quote) < n;
}

// --------------------------------------------------------------------------------------------- workflow defaults
export const WORKFLOW_DEFAULTS = D.status.workflowDefaults as Record<string, Array<string | number | boolean>>;
export const STATUS_EVIDENCE = D.status.statusEvidence as Record<string, string[]>;

// --------------------------------------------------------------------------------------------- grounding-specific tables
export const VITAL_LABELS = D.observation.vitalLabels as Record<string, string[]>;
/** PAS Claim.supportingInfo category code -> measurement labels (value must be quoted with its label). */
export const SUPPORTING_INFO_LABELS = D.pas.supportingInfoLabels as Record<string, string[]>;
/** Resources that are not derived from the clinical record (payer responses, server outcomes): never checked. */
export const NON_RECORD_RESOURCES = new Set<string>(D.pas.nonRecordResources);
export const PROFILE_LABEL_CODE = D.observation.profileLabelCode as Record<string, string>;
export const FIXED_CODE_PROFILES = new Set<string>(D.observation.fixedCodeProfiles);
export const VISIT_WORDS: readonly string[] = D.encounter.visitWords;
export const VISIT_LINE_WORDS: readonly string[] = D.encounter.visitLineWords;
export const BIRTH_LABELS: readonly string[] = D.encounter.birthLabels;
export const IDENTITY_RE = pyRe(D.encounter.identityLine);
export const DISPOSITION = D.encounter.disposition as Record<string, string[]>;
export const DEPARTMENT_SUFFIX = pyRe(D.encounter.departmentSuffix);
export const LIST_ITEM = pyRe(D.structure.listItem);

