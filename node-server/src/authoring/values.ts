/**
 * Value grammar of the authoring layer (README "Value grammar"): pure, synchronous parsers
 * that turn what the model wrote into FHIR datatype shapes. No I/O, no terminology — the
 * coded kinds (Coding / CodeableConcept / bound codes) need lookups and live in compose.ts.
 *
 *   dates      ISO at any precision, or ROC (民國) `YYY/MM/DD[ HH:mm[:ss]]` (+1911, precision kept)
 *   quantity   `{value, unit}` / `"95 mg/dL"` → value + unit text + UCUM code (resolveUnit)
 *   units      a valid UCUM expression as is; else the UCUM definitions' own names / synonyms /
 *              print symbols (ucum-lhc tables); else the suggestion layer's repair (fhirSuggestions/ucum.ts)
 *   frequency  a small generic grammar over HL7 timing abbreviations (BID, q8h …), English and
 *              Chinese phrases → Timing.repeat {frequency, period, periodUnit, when}
 *   reference  `{ref: key}` (context key) vs `{reference}` / `Type/id` / urn / url (external)
 *   period     `{start, end?}` (dates above) or a single date → {start}
 *   humanName  string → {text}; `{family, given, text, use, prefix, suffix}` (given/prefix/suffix wrapped)
 *   choice     the value's shape picks the type among the element's allowed types (shapeType)
 */

import { createRequire } from "node:module";
import { isRawNumber, RawNumber } from "../losslessJson.js";
import { checkUcumCode, UCUM_SYSTEM } from "../fhirUcum.js";
import { suggestUcum } from "../fhirSuggestions/ucum.js";

export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string; candidates?: unknown[] };

export function fail<T = never>(message: string, candidates?: unknown[]): Parsed<T> {
  return candidates && candidates.length ? { ok: false, message, candidates } : { ok: false, message };
}

export function isObject(v: unknown): v is Record<string, any> {
  return v !== null && typeof v === "object" && !Array.isArray(v) && !isRawNumber(v);
}

export function isNumberLike(v: unknown): boolean {
  return typeof v === "number" || isRawNumber(v);
}

// --------------------------------------------------------------------------- //
// Numbers
// --------------------------------------------------------------------------- //

const NUMERIC_TEXT = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/** A JSON number as the model gave it; a numeric string keeps its spelling when Number() would not. */
export function parseNumber(raw: unknown): Parsed<number | RawNumber> {
  if (typeof raw === "number") return Number.isFinite(raw) ? { ok: true, value: raw } : fail("not a finite number");
  if (isRawNumber(raw)) return { ok: true, value: raw };
  if (typeof raw === "string") {
    const t = raw.trim().replace(/,/g, "");
    if (!NUMERIC_TEXT.test(t)) return fail(`not a number: ${JSON.stringify(raw)}`);
    const n = Number(t);
    if (!Number.isFinite(n)) return fail(`not a finite number: ${JSON.stringify(raw)}`);
    return { ok: true, value: String(n) === t ? n : new RawNumber(t) };
  }
  return fail(`expected a number, got ${describe(raw)}`);
}

export function parseInteger(raw: unknown, kind: "integer" | "positiveInt" | "unsignedInt" = "integer"): Parsed<number> {
  const p = parseNumber(raw);
  if (!p.ok) return p;
  const n = Number(p.value);
  if (!Number.isInteger(n)) return fail(`expected an integer, got ${JSON.stringify(raw)}`);
  if (kind === "positiveInt" && n < 1) return fail(`expected a positive integer (>= 1), got ${n}`);
  if (kind === "unsignedInt" && n < 0) return fail(`expected a non-negative integer, got ${n}`);
  return { ok: true, value: n };
}

export function parseBoolean(raw: unknown): Parsed<boolean> {
  if (typeof raw === "boolean") return { ok: true, value: raw };
  if (typeof raw === "string") {
    const t = raw.trim().toLowerCase();
    if (["true", "yes", "y", "是"].includes(t)) return { ok: true, value: true };
    if (["false", "no", "n", "否"].includes(t)) return { ok: true, value: false };
  }
  return fail(`expected true or false, got ${describe(raw)}`);
}

export function describe(v: unknown): string {
  if (v === null) return "null";
  if (v === undefined) return "nothing";
  if (Array.isArray(v)) return "an array";
  if (isRawNumber(v)) return `a number (${v.text})`;
  if (typeof v === "object") return `an object with keys ${Object.keys(v as object).join(", ") || "(none)"}`;
  if (typeof v === "string") return `a string (${JSON.stringify(v.length > 40 ? v.slice(0, 39) + "…" : v)})`;
  return `${typeof v} ${String(v)}`;
}

// --------------------------------------------------------------------------- //
// Dates
// --------------------------------------------------------------------------- //

export type DatePrecision = "year" | "month" | "day" | "time";

export interface ParsedDate {
  /** ISO value at the parsed precision; a time carries seconds and the offset when one was given / supplied. */
  value: string;
  precision: DatePrecision;
  hasOffset: boolean;
  /** The input was a ROC (民國) date. */
  roc: boolean;
}

const ISO_RE = /^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?(?:[T\s](\d{1,2}):(\d{2})(?::(\d{2})(\.\d+)?)?\s*(Z|z|[+-]\d{2}:?\d{2})?)?$/;
/** `YYY/MM/DD`, `YYY-M-D` (1–3 digit year = ROC), `YYYY/MM/DD`, `民國115年6月15日`, optional ` HH:mm[:ss]`. */
const LOOSE_RE = /^(民國|ROC)?\s*(\d{1,4})\s*[/.\-年]\s*(\d{1,2})(?:\s*[/.\-月]\s*(\d{1,2})\s*日?)?(?:\s*(?:[T\s]|,)?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(Z|z|[+-]\d{2}:?\d{2})?)?$/;
const YEAR_MONTH_CN = /^(民國|ROC)?\s*(\d{1,4})\s*年\s*(\d{1,2})\s*月$/;

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function normalizeOffset(o: string | undefined): string | null {
  if (!o) return null;
  if (o === "Z" || o === "z") return "Z";
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(o);
  if (!m) return null;
  const hh = Number(m[2]);
  const mm = Number(m[3]);
  if (hh > 14 || mm > 59) return null;
  return `${m[1]}${m[2]}:${m[3]}`;
}

/** Accepts ISO (any precision) and ROC dates; rejects impossible calendar dates and times. */
export function parseDateValue(raw: unknown): Parsed<ParsedDate> {
  if (typeof raw !== "string") return fail(`expected a date string, got ${describe(raw)}`);
  const text = raw.trim();
  let y: number;
  let mo: number | null = null;
  let d: number | null = null;
  let hh: string | undefined;
  let mi: string | undefined;
  let ss: string | undefined;
  let frac: string | undefined;
  let off: string | undefined;
  let roc = false;
  let m = ISO_RE.exec(text);
  if (m) {
    y = Number(m[1]);
    mo = m[2] !== undefined ? Number(m[2]) : null;
    d = m[3] !== undefined ? Number(m[3]) : null;
    [hh, mi, ss, frac, off] = [m[4], m[5], m[6], m[7], m[8]];
  } else if ((m = LOOSE_RE.exec(text))) {
    const yearText = m[2];
    y = Number(yearText);
    roc = Boolean(m[1]) || yearText.length <= 3;
    mo = Number(m[3]);
    d = m[4] !== undefined ? Number(m[4]) : null;
    [hh, mi, ss, off] = [m[5], m[6], m[7], m[8]];
    if (roc) {
      if (y < 1) return fail(`ROC year must be >= 1: ${JSON.stringify(raw)}`);
      y += 1911;
    }
  } else if ((m = YEAR_MONTH_CN.exec(text))) {
    y = Number(m[2]);
    roc = Boolean(m[1]) || m[2].length <= 3;
    if (roc) y += 1911;
    mo = Number(m[3]);
  } else if (/^\d{4}$/.test(text) || /^(民國|ROC)?\s*\d{1,3}\s*年$/.test(text)) {
    const yt = text.replace(/\D/g, "");
    roc = yt.length <= 3;
    y = Number(yt) + (roc ? 1911 : 0);
  } else {
    return fail(`not a date: ${JSON.stringify(raw)} (use ISO 2026-06-15 / 2026-06-15T06:00+08:00 or ROC 115/06/15)`);
  }
  if (y < 1 || y > 9999) return fail(`year out of range: ${JSON.stringify(raw)}`);
  if (mo !== null && (mo < 1 || mo > 12)) return fail(`month out of range (1-12): ${JSON.stringify(raw)}`);
  if (d !== null && (mo === null || d < 1 || d > daysInMonth(y, mo))) return fail(`impossible date: ${JSON.stringify(raw)}`);
  let value = String(y).padStart(4, "0");
  let precision: DatePrecision = "year";
  if (mo !== null) {
    value += `-${pad2(mo)}`;
    precision = "month";
  }
  if (d !== null) {
    value += `-${pad2(d)}`;
    precision = "day";
  }
  let hasOffset = false;
  if (hh !== undefined && mi !== undefined) {
    if (d === null) return fail(`a time needs a full date: ${JSON.stringify(raw)}`);
    const h = Number(hh);
    const n = Number(mi);
    const s = ss !== undefined ? Number(ss) : 0;
    if (h > 23 || n > 59 || s > 60) return fail(`impossible time: ${JSON.stringify(raw)}`);
    value += `T${pad2(h)}:${pad2(n)}:${pad2(s)}${frac ?? ""}`;
    precision = "time";
    if (off !== undefined) {
      const o = normalizeOffset(off);
      if (!o) return fail(`invalid UTC offset: ${JSON.stringify(raw)}`);
      value += o;
      hasOffset = true;
    }
  }
  return { ok: true, value: { value, precision, hasOffset, roc } };
}

/**
 * Fit a parsed date to an element type. `timezone` (an offset such as "+08:00", a facility
 * setting the context may carry) completes a time that has none; without it such a value
 * is an error — an offset is never guessed.
 */
export function fitDate(p: ParsedDate, typeCode: "date" | "dateTime" | "instant", timezone?: string | null): Parsed<string> {
  if (typeCode === "date") {
    if (p.precision !== "time") return { ok: true, value: p.value };
    const day = p.value.slice(0, 10);
    const time = p.value.slice(11, 19);
    if (time === "00:00:00") return { ok: true, value: day };
    return fail(`this element is a date without a time; give ${day} (the time ${time} cannot be kept)`);
  }
  if (p.precision !== "time") {
    if (typeCode === "instant") return fail("an instant needs a full date, time and UTC offset (e.g. 2026-06-15T06:00:00+08:00)");
    return { ok: true, value: p.value };
  }
  if (p.hasOffset) return { ok: true, value: p.value };
  const tz = timezone ? normalizeOffset(timezone) : null;
  if (tz) return { ok: true, value: p.value + tz };
  return fail(`a time needs a UTC offset (e.g. ${p.value}+08:00); give the offset, or set the context timezone`);
}

const TIME_RE = /^(\d{1,2}):(\d{2})(?::(\d{2})(\.\d+)?)?$/;

export function parseTimeValue(raw: unknown): Parsed<string> {
  if (typeof raw !== "string") return fail(`expected a time string (HH:mm[:ss]), got ${describe(raw)}`);
  const m = TIME_RE.exec(raw.trim());
  if (!m) return fail(`not a time: ${JSON.stringify(raw)} (use HH:mm or HH:mm:ss)`);
  const h = Number(m[1]);
  const n = Number(m[2]);
  const s = m[3] !== undefined ? Number(m[3]) : 0;
  if (h > 23 || n > 59 || s > 60) return fail(`impossible time: ${JSON.stringify(raw)}`);
  return { ok: true, value: `${pad2(h)}:${pad2(n)}:${pad2(s)}${m[4] ?? ""}` };
}

// --------------------------------------------------------------------------- //
// Units (UCUM)
// --------------------------------------------------------------------------- //

export interface UnitResolution {
  code: string;
  /** How the code was found: a valid UCUM expression as given, a UCUM unit name / synonym / print symbol, or a spelling repair. */
  source: "ucum" | "name" | "spelling";
}

let nameTable: Map<string, string[]> | null | undefined;

/** UCUM definitions (ucum-lhc): lower-cased unit names, synonyms and print symbols → codes. Exact phrase match only. */
function unitNames(): Map<string, string[]> | null {
  if (nameTable !== undefined) return nameTable;
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("@lhncbc/ucum-lhc");
    pkg.UcumLhcUtils.getInstance();
    const ut = pkg.UnitTables.getInstance();
    const table = new Map<string, string[]>();
    const add = (phrase: unknown, code: string): void => {
      if (typeof phrase !== "string") return;
      const k = phrase.trim().toLowerCase();
      if (!k) return;
      const list = table.get(k) || [];
      if (!list.includes(code)) list.push(code);
      table.set(k, list);
    };
    for (const code of ut.getAllUnitCodes() as string[]) {
      const u = ut.getUnitByCode(code);
      if (!u || typeof code !== "string") continue;
      add(u.name_, code);
      add(u.printSymbol_, code);
      for (const s of String(u.synonyms_ || "").split(";")) add(s, code);
    }
    nameTable = table;
  } catch {
    nameTable = null;
  }
  return nameTable;
}

/** Prefer a plain atom over a composed expression, then the shorter code (stable). */
function pickCode(codes: string[]): string {
  return [...codes].sort((a, b) => {
    const ca = /[/.()]/.test(a) ? 1 : 0;
    const cb = /[/.()]/.test(b) ? 1 : 0;
    return ca - cb || a.length - b.length || (a < b ? -1 : 1);
  })[0];
}

const unitCache = new Map<string, UnitResolution | null>();

/**
 * Unit text → UCUM code. A valid UCUM expression is itself the code; otherwise the UCUM
 * definitions' own names / synonyms / print symbols ("millimeter of mercury", "mmHg", "°C"),
 * then the suggestion layer's generic repair (case, brackets, common clinical spellings such
 * as bpm → /min, tablet → {tablet}) when it is a cheap edit. Null when nothing resolves.
 */
export function resolveUnit(text: string): UnitResolution | null {
  const t = String(text ?? "").trim();
  if (!t) return null;
  const hit = unitCache.get(t);
  if (hit !== undefined) return hit;
  let out: UnitResolution | null = null;
  if (checkUcumCode(t) === "valid") out = { code: t, source: "ucum" };
  else {
    const names = unitNames();
    const variants = [t.toLowerCase(), t.toLowerCase().replace(/\s+/g, " "), t.toLowerCase().replace(/s$/, "")];
    for (const v of variants) {
      const codes = names?.get(v);
      if (codes && codes.length) {
        out = { code: pickCode(codes), source: "name" };
        break;
      }
    }
    if (!out) {
      const cand = suggestUcum(t, null, 1)[0];
      if (cand && cand.cost <= 0.6) out = { code: cand.value, source: "spelling" };
    }
  }
  if (unitCache.size > 2000) unitCache.clear();
  unitCache.set(t, out);
  return out;
}

// --------------------------------------------------------------------------- //
// Quantity
// --------------------------------------------------------------------------- //

export interface QuantityShape {
  value?: number | RawNumber;
  comparator?: string;
  unit?: string;
  system?: string;
  code?: string;
  /** The UCUM code was supplied by the composer (unit text → code), not by the model. */
  codeResolved?: boolean;
}

const QUANTITY_TEXT = /^\s*(<=|>=|<|>)?\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*(.*?)\s*$/;

/** `{value, unit?, code?, system?, comparator?}`, a number, or `"95 mg/dL"`; the unit text is kept and its UCUM code resolved. */
export function parseQuantityValue(raw: unknown): Parsed<QuantityShape> {
  if (isNumberLike(raw)) return { ok: true, value: { value: raw as number | RawNumber } };
  if (typeof raw === "string") {
    const m = QUANTITY_TEXT.exec(raw);
    if (!m) return fail(`not a quantity: ${JSON.stringify(raw)} (use "95 mg/dL" or {value, unit})`);
    const n = parseNumber(m[2]);
    if (!n.ok) return n;
    const q: QuantityShape = { value: n.value };
    if (m[1]) q.comparator = m[1];
    if (m[3]) applyUnit(q, m[3]);
    return { ok: true, value: q };
  }
  if (!isObject(raw)) return fail(`expected a quantity ({value, unit} or "95 mg/dL"), got ${describe(raw)}`);
  const q: QuantityShape = {};
  if (raw.value !== undefined && raw.value !== null) {
    const n = parseNumber(raw.value);
    if (!n.ok) return fail(`quantity value: ${n.message}`);
    q.value = n.value;
  }
  if (raw.comparator !== undefined) {
    if (!["<", "<=", ">=", ">"].includes(String(raw.comparator))) return fail(`quantity comparator must be one of < <= >= >, got ${JSON.stringify(raw.comparator)}`);
    q.comparator = String(raw.comparator);
  }
  if (typeof raw.system === "string" && raw.system) q.system = raw.system;
  if (typeof raw.code === "string" && raw.code) q.code = raw.code;
  if (raw.unit !== undefined && raw.unit !== null) {
    if (typeof raw.unit !== "string") return fail(`quantity unit must be a string, got ${describe(raw.unit)}`);
    if (q.code) q.unit = raw.unit;
    else applyUnit(q, raw.unit);
  }
  if (q.code && !q.system) q.system = UCUM_SYSTEM;
  if (q.value === undefined) return fail("a quantity needs a value (e.g. {value: 95, unit: \"mg/dL\"})");
  return { ok: true, value: q };
}

function applyUnit(q: QuantityShape, unitText: string): void {
  const t = unitText.trim();
  if (!t) return;
  q.unit = t;
  const r = resolveUnit(t);
  if (r) {
    q.code = r.code;
    q.system = UCUM_SYSTEM;
    q.codeResolved = true;
  }
}

/** Plain FHIR Quantity JSON (without the composer's bookkeeping). */
export function quantityJson(q: QuantityShape): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (q.value !== undefined) out.value = q.value;
  if (q.comparator) out.comparator = q.comparator;
  if (q.unit) out.unit = q.unit;
  if (q.system) out.system = q.system;
  if (q.code) out.code = q.code;
  return out;
}

// --------------------------------------------------------------------------- //
// Frequency grammar (Timing.repeat)
// --------------------------------------------------------------------------- //

/**
 * Generic frequency grammar. Everything it understands maps onto FHIR R4 Timing.repeat
 * (frequency / period / periodUnit / when / count) — no clinical knowledge beyond the HL7
 * timing abbreviations (v3 GTSAbbreviation / R4 Timing table) and plain phrases:
 *
 *   abbreviations  QD OD daily → 1 per 1 d; BID → 2/d; TID → 3/d; QID → 4/d; QOD → 1 per 2 d;
 *                  Q<n>H q8h q8° → 1 per n h; Q<n>D → 1 per n d; QW weekly → 1/wk; QM monthly → 1/mo;
 *                  HS QHS → 1/d at bedtime (when HS); AC PC ACM ACD ACV PCM PCD PCV (when codes);
 *                  PRN → as needed; STAT / once → count 1
 *   English        "<n> times a day", "twice daily", "every 8 hours", "every other day",
 *                  "3x/day", "2/day", "weekly", "at bedtime", "before/after meals (breakfast…)",
 *                  "in the morning / evening", "as needed"
 *   Chinese        每天三次 / 一天三次 / 每日N次; 每8小時(一次); 每N天; 隔日; 每週N次; 每月N次;
 *                  睡前 (HS); 飯前/飯後 (AC/PC); 早餐前/後 (ACM/PCM) 午餐 (ACD/PCD) 晚餐 (ACV/PCV);
 *                  早上/中午/下午/晚上/夜間 (MORN/NOON/AFT/EVE/NIGHT); 需要時/必要時 (as needed)
 *   object         {frequency, period, periodUnit, frequencyMax?, periodMax?, when?, count?, …}:
 *                  pass-through; periodUnit / durationUnit words (hour, 天, wk …) → s/min/h/d/wk/mo/a
 *
 * Returns null when the text is not understood (the composer then reports an error rather
 * than guessing).
 */
export interface FrequencyParse {
  repeat: Record<string, unknown>;
  /** HL7 abbreviation of the whole frequency when one applies (BID, TID, Q8H …). */
  abbreviation?: string;
  asNeeded?: boolean;
}

const CN_DIGITS: Record<string, number> = { 零: 0, 一: 1, 二: 2, 兩: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

export function chineseNumber(s: string): number | null {
  if (/^\d+$/.test(s)) return Number(s);
  if (s === "十") return 10;
  if (s === "半") return 0.5;
  const m = /^([一二三四五六七八九兩两]?)(十?)([一二三四五六七八九]?)$/.exec(s);
  if (!m || !s) return null;
  if (!m[2]) return m[1] ? CN_DIGITS[m[1]] : null;
  return (m[1] ? CN_DIGITS[m[1]] : 1) * 10 + (m[3] ? CN_DIGITS[m[3]] : 0);
}

const EN_NUMBERS: Record<string, number> = {
  one: 1, once: 1, two: 2, twice: 2, three: 3, thrice: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

function enNumber(s: string): number | null {
  if (/^\d+$/.test(s)) return Number(s);
  return s in EN_NUMBERS ? EN_NUMBERS[s] : null;
}

/** Words for FHIR units-of-time (Timing.repeat.periodUnit / durationUnit / bounds). */
export const TIME_UNIT_WORDS: Record<string, string> = {
  s: "s", sec: "s", secs: "s", second: "s", seconds: "s", 秒: "s",
  min: "min", mins: "min", minute: "min", minutes: "min", 分: "min", 分鐘: "min",
  h: "h", hr: "h", hrs: "h", hour: "h", hours: "h", hourly: "h", 小時: "h", 時: "h", 鐘頭: "h",
  d: "d", day: "d", days: "d", daily: "d", 天: "d", 日: "d",
  wk: "wk", w: "wk", week: "wk", weeks: "wk", weekly: "wk", 週: "wk", 周: "wk", 星期: "wk", 禮拜: "wk",
  mo: "mo", month: "mo", months: "mo", monthly: "mo", 月: "mo", 個月: "mo",
  a: "a", y: "a", yr: "a", yrs: "a", year: "a", years: "a", yearly: "a", 年: "a",
};

export function timeUnitCode(word: string): string | null {
  const w = String(word ?? "").trim().toLowerCase();
  return w in TIME_UNIT_WORDS ? TIME_UNIT_WORDS[w] : null;
}

/** Event-timing codes (FHIR R4 ValueSet event-timing) for phrases. */
const WHEN_PHRASES: Array<[RegExp, string]> = [
  [/\b(at )?bedtime\b|\bat night\b|\bnightly\b|睡前|臨睡前/i, "HS"],
  [/\bbefore breakfast\b|早餐前|早飯前/i, "ACM"],
  [/\bafter breakfast\b|早餐後|早飯後/i, "PCM"],
  [/\bbefore lunch\b|午餐前|午飯前/i, "ACD"],
  [/\bafter lunch\b|午餐後|午飯後/i, "PCD"],
  [/\bbefore (dinner|supper)\b|晚餐前|晚飯前/i, "ACV"],
  [/\bafter (dinner|supper)\b|晚餐後|晚飯後/i, "PCV"],
  [/\bbefore (meals?|food|eating)\b|飯前|餐前|空腹/i, "AC"],
  [/\bafter (meals?|food|eating)\b|飯後|餐後/i, "PC"],
  [/\bwith (meals?|food)\b|隨餐|與食物/i, "C"],
  [/\b(in the )?morning\b|早上|早晨|清晨/i, "MORN"],
  [/\b(at )?noon\b|中午/i, "NOON"],
  [/\b(in the )?afternoon\b|下午/i, "AFT"],
  [/\b(in the )?evening\b|晚上|傍晚/i, "EVE"],
  [/\b(during the )?night\b|夜間|夜裡/i, "NIGHT"],
  [/\b(on )?waking\b|起床時|醒來時/i, "WAKE"],
];

const AS_NEEDED_RE = /\b(prn|as needed|when needed|if needed|when necessary|as required)\b|需要時|必要時|視需要|按需/i;

/** Tokens of the abbreviation form: QD, BID, TID, QID, QOD, Q8H, Q8°, Q1D, QW, QM, HS, QHS, AC, PC … */
function abbreviation(token: string): Partial<FrequencyParse["repeat"]> | "prn" | "stat" | null {
  const t = token.toLowerCase().replace(/\./g, "");
  const fixed: Record<string, Record<string, unknown>> = {
    qd: { frequency: 1, period: 1, periodUnit: "d" },
    od: { frequency: 1, period: 1, periodUnit: "d" },
    daily: { frequency: 1, period: 1, periodUnit: "d" },
    bid: { frequency: 2, period: 1, periodUnit: "d" },
    tid: { frequency: 3, period: 1, periodUnit: "d" },
    qid: { frequency: 4, period: 1, periodUnit: "d" },
    qod: { frequency: 1, period: 2, periodUnit: "d" },
    qw: { frequency: 1, period: 1, periodUnit: "wk" },
    weekly: { frequency: 1, period: 1, periodUnit: "wk" },
    qm: { frequency: 1, period: 1, periodUnit: "mo" },
    monthly: { frequency: 1, period: 1, periodUnit: "mo" },
    hourly: { frequency: 1, period: 1, periodUnit: "h" },
    hs: { frequency: 1, period: 1, periodUnit: "d", when: ["HS"] },
    qhs: { frequency: 1, period: 1, periodUnit: "d", when: ["HS"] },
    qpm: { frequency: 1, period: 1, periodUnit: "d", when: ["EVE"] },
    qam: { frequency: 1, period: 1, periodUnit: "d", when: ["MORN"] },
    ac: { when: ["AC"] },
    pc: { when: ["PC"] },
    acm: { when: ["ACM"] },
    acd: { when: ["ACD"] },
    acv: { when: ["ACV"] },
    pcm: { when: ["PCM"] },
    pcd: { when: ["PCD"] },
    pcv: { when: ["PCV"] },
  };
  if (t in fixed) return fixed[t];
  if (t === "prn") return "prn";
  if (t === "stat" || t === "once") return "stat";
  let m = /^q(\d+)\s*(h|hr|hrs|hours?|°)$/.exec(t);
  if (m) return { frequency: 1, period: Number(m[1]), periodUnit: "h" };
  m = /^q(\d+)\s*(d|days?)$/.exec(t);
  if (m) return { frequency: 1, period: Number(m[1]), periodUnit: "d" };
  m = /^q(\d+)\s*(wk|w|weeks?)$/.exec(t);
  if (m) return { frequency: 1, period: Number(m[1]), periodUnit: "wk" };
  m = /^q(\d+)\s*(min|mins?)$/.exec(t);
  if (m) return { frequency: 1, period: Number(m[1]), periodUnit: "min" };
  m = /^q(h|d|w|wk|mo|m)$/.exec(t);
  if (m) return { frequency: 1, period: 1, periodUnit: { h: "h", d: "d", w: "wk", wk: "wk", mo: "mo", m: "mo" }[m[1]] };
  return null;
}

function abbreviationOf(rep: Record<string, unknown>): string | undefined {
  const f = rep.frequency;
  const p = rep.period;
  const u = rep.periodUnit;
  if (u === "d" && p === 1) {
    if (f === 1) return Array.isArray(rep.when) && (rep.when as string[]).includes("HS") ? "QHS" : "QD";
    if (f === 2) return "BID";
    if (f === 3) return "TID";
    if (f === 4) return "QID";
  }
  if (u === "d" && p === 2 && f === 1) return "QOD";
  if (u === "h" && f === 1 && typeof p === "number") return `Q${p}H`;
  if (u === "wk" && p === 1 && f === 1) return "QW";
  if (u === "mo" && p === 1 && f === 1) return "QM";
  return undefined;
}

export function parseFrequency(raw: unknown): FrequencyParse | null {
  if (isObject(raw)) return frequencyObject(raw);
  if (typeof raw !== "string") return null;
  let text = raw.trim();
  if (!text) return null;
  const out: FrequencyParse = { repeat: {} };
  if (AS_NEEDED_RE.test(text)) {
    out.asNeeded = true;
    text = text.replace(AS_NEEDED_RE, " ").trim();
  }
  const when: string[] = [];
  for (const [re, code] of WHEN_PHRASES) {
    if (re.test(text)) {
      if (!when.includes(code)) when.push(code);
      text = text.replace(re, " ");
    }
  }
  // connectors left behind by removed phrases ("twice daily, before breakfast and dinner")
  text = text.replace(/[,，;；、]|\b(and|&|then)\b|及|和|與|並|且/g, " ").replace(/\s+/g, " ").trim();
  let rep: Record<string, unknown> | null = null;
  if (text) {
    rep = chinesePhrase(text) ?? englishPhrase(text) ?? abbreviationTokens(text, out);
    if (!rep) return null;
  } else if (!when.length && !out.asNeeded) return null;
  rep = rep || {};
  if (when.length) rep.when = [...new Set([...(Array.isArray(rep.when) ? (rep.when as string[]) : []), ...when])];
  if (when.includes("HS") && rep.frequency === undefined && rep.count === undefined) Object.assign(rep, { frequency: 1, period: 1, periodUnit: "d" });
  out.repeat = rep;
  const abbr = abbreviationOf(rep);
  if (abbr) out.abbreviation = abbr;
  return out;
}

function frequencyObject(o: Record<string, any>): FrequencyParse | null {
  const rep: Record<string, unknown> = {};
  const nums = ["frequency", "frequencyMax", "period", "periodMax", "count", "countMax", "duration", "durationMax", "offset"];
  for (const k of nums) {
    if (o[k] === undefined || o[k] === null) continue;
    const n = parseNumber(o[k]);
    if (!n.ok) return null;
    rep[k] = n.value;
  }
  for (const k of ["periodUnit", "durationUnit"]) {
    if (o[k] === undefined || o[k] === null) continue;
    const u = timeUnitCode(String(o[k]));
    if (!u) return null;
    rep[k] = u;
  }
  for (const k of ["when", "dayOfWeek", "timeOfDay"]) {
    if (o[k] === undefined || o[k] === null) continue;
    rep[k] = Array.isArray(o[k]) ? o[k].map(String) : [String(o[k])];
  }
  for (const k of ["boundsPeriod", "boundsDuration", "boundsRange"]) if (isObject(o[k])) rep[k] = o[k];
  if (!Object.keys(rep).length) return null;
  const out: FrequencyParse = { repeat: rep };
  const abbr = abbreviationOf(rep);
  if (abbr) out.abbreviation = abbr;
  return out;
}

function chinesePhrase(text: string): Record<string, unknown> | null {
  const N = "([0-9]+|[一二三四五六七八九十兩两半]+)";
  const unitRe = "(小時|時|鐘頭|分鐘|分|天|日|週|周|星期|禮拜|月|個月|年)";
  let m: RegExpExecArray | null;
  // 每天三次 / 一天三次 / 每日N次 / 每週N次 / 每月N次 / 每N小時N次
  if ((m = new RegExp(`^(?:每|一|每隔)?\\s*${N}?\\s*${unitRe}\\s*${N}\\s*次$`).exec(text))) {
    const per = m[1] ? chineseNumber(m[1]) : 1;
    const unit = timeUnitCode(m[2]);
    const times = chineseNumber(m[3]);
    if (per === null || !unit || times === null) return null;
    return { frequency: times, period: per, periodUnit: unit };
  }
  // 每8小時(一次) / 每隔8小時 / 每N天(一次) / 每週(一次) / 隔日
  if ((m = new RegExp(`^(?:每|每隔|隔)\\s*${N}?\\s*${unitRe}\\s*(?:一次|1次)?$`).exec(text))) {
    let per = m[1] ? chineseNumber(m[1]) : 1;
    const unit = timeUnitCode(m[2]);
    if (per === null || !unit) return null;
    if (text.startsWith("每隔") || text.startsWith("隔")) per = m[1] ? per + 1 : 2;
    return { frequency: 1, period: per, periodUnit: unit };
  }
  if (/^(隔日|隔天)(一次)?$/.test(text)) return { frequency: 1, period: 2, periodUnit: "d" };
  if ((m = new RegExp(`^${N}\\s*次$`).exec(text))) {
    const times = chineseNumber(m[1]);
    return times === null ? null : { count: times };
  }
  if (/^(一次|單次|單劑)$/.test(text)) return { count: 1 };
  return null;
}

function englishPhrase(text: string): Record<string, unknown> | null {
  const t = text.toLowerCase().replace(/\s+/g, " ").trim();
  const NUM = "(\\d+|one|once|two|twice|three|thrice|four|five|six|seven|eight|nine|ten|eleven|twelve)";
  const UNIT = "(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|wks?|months?|years?)";
  let m: RegExpExecArray | null;
  if (/^(daily|every day|each day|once daily|once a day|once per day|per day|a day)$/.test(t)) return { frequency: 1, period: 1, periodUnit: "d" };
  if (/^(weekly|every week|once weekly|once a week)$/.test(t)) return { frequency: 1, period: 1, periodUnit: "wk" };
  if (/^(monthly|every month|once monthly|once a month)$/.test(t)) return { frequency: 1, period: 1, periodUnit: "mo" };
  if (/^(hourly|every hour)$/.test(t)) return { frequency: 1, period: 1, periodUnit: "h" };
  if (/^(every other day|alternate days|every second day)$/.test(t)) return { frequency: 1, period: 2, periodUnit: "d" };
  // "3 times a day", "twice daily", "three times per week", "2 times/day", "3x daily"
  if ((m = new RegExp(`^${NUM}\\s*(?:times?|x)?\\s*(?:a|per|/|each|every)?\\s*(daily|${UNIT})$`).exec(t))) {
    const n = enNumber(m[1]);
    const unit = m[2] === "daily" ? "d" : timeUnitCode(m[2]);
    if (n === null || !unit) return null;
    return { frequency: n, period: 1, periodUnit: unit };
  }
  // "every 8 hours", "every 2 days", "q 8 h"
  if ((m = new RegExp(`^(?:every|each|q)\\s*${NUM}?\\s*${UNIT}$`).exec(t))) {
    const n = m[1] ? enNumber(m[1]) : 1;
    const unit = timeUnitCode(m[2]);
    if (n === null || !unit) return null;
    return { frequency: 1, period: n, periodUnit: unit };
  }
  // "3 times" / "once" / "one dose" / "single dose"
  if ((m = new RegExp(`^${NUM}\\s*(?:times?|doses?)?$`).exec(t))) {
    const n = enNumber(m[1]);
    return n === null ? null : { count: n };
  }
  if (/^(single dose|one time|one-time|one off)$/.test(t)) return { count: 1 };
  return null;
}

function abbreviationTokens(text: string, out: FrequencyParse): Record<string, unknown> | null {
  const tokens = text.split(/\s+/).filter(Boolean);
  const rep: Record<string, unknown> = {};
  const when: string[] = [];
  let any = false;
  for (const tok of tokens) {
    const a = abbreviation(tok);
    if (a === null) return null;
    any = true;
    if (a === "prn") {
      out.asNeeded = true;
      continue;
    }
    if (a === "stat") {
      rep.count = 1;
      continue;
    }
    for (const [k, v] of Object.entries(a)) {
      if (k === "when") when.push(...(v as string[]));
      else if (rep[k] !== undefined && rep[k] !== v) return null; // two conflicting frequencies
      else rep[k] = v;
    }
  }
  if (!any) return null;
  if (when.length) rep.when = [...new Set(when)];
  return rep;
}

// --------------------------------------------------------------------------- //
// References, names, periods
// --------------------------------------------------------------------------- //

export type ReferenceShape = { kind: "key"; key: string; display?: string } | { kind: "external"; reference: Record<string, unknown> } | { kind: "error"; message: string };

const EXTERNAL_REF = /^(urn:(uuid|oid):|https?:\/\/|#|[A-Z][A-Za-z]+\/[A-Za-z0-9\-.]{1,64}(\/_history\/[A-Za-z0-9\-.]{1,64})?$)/;

/** `{ref: key}` → a context key; `{reference, display?, type?, identifier?}` / `Type/id` / urn / url → external, kept as is. */
export function classifyReference(raw: unknown): ReferenceShape {
  if (typeof raw === "string") {
    const s = raw.trim();
    if (!s) return { kind: "error", message: "empty reference" };
    return EXTERNAL_REF.test(s) ? { kind: "external", reference: { reference: s } } : { kind: "key", key: s };
  }
  if (!isObject(raw)) return { kind: "error", message: `expected a reference ({ref: key} or {reference}), got ${describe(raw)}` };
  if (typeof raw.ref === "string" && raw.ref.trim()) {
    const o: ReferenceShape = { kind: "key", key: raw.ref.trim() };
    if (typeof raw.display === "string" && raw.display) o.display = raw.display;
    return o;
  }
  if (typeof raw.reference === "string" || isObject(raw.identifier)) {
    const out: Record<string, unknown> = {};
    for (const k of ["reference", "type", "identifier", "display"]) if (raw[k] !== undefined) out[k] = raw[k];
    return { kind: "external", reference: out };
  }
  return { kind: "error", message: `a reference needs {ref: "<key>"} (same context) or {reference: "<Type/id or URL>"}, got ${describe(raw)}` };
}

export function parseHumanNameValue(raw: unknown): Parsed<Record<string, unknown>> {
  if (typeof raw === "string") return raw.trim() ? { ok: true, value: { text: raw.trim() } } : fail("empty name");
  if (!isObject(raw)) return fail(`expected a name (string or {family, given, text}), got ${describe(raw)}`);
  const out: Record<string, unknown> = {};
  for (const k of ["use", "text", "family"]) {
    if (raw[k] === undefined || raw[k] === null) continue;
    if (typeof raw[k] !== "string") return fail(`name.${k} must be a string`);
    out[k] = raw[k];
  }
  for (const k of ["given", "prefix", "suffix"]) {
    if (raw[k] === undefined || raw[k] === null) continue;
    const arr = Array.isArray(raw[k]) ? raw[k] : [raw[k]];
    if (!arr.every((x: unknown) => typeof x === "string")) return fail(`name.${k} must be a string or an array of strings`);
    out[k] = arr;
  }
  if (isObject(raw.period)) out.period = raw.period;
  if (!Object.keys(out).length) return fail("a name needs at least text, family or given");
  return { ok: true, value: out };
}

export interface PeriodShape {
  start?: ParsedDate;
  end?: ParsedDate;
}

/** `{start, end?}` (either may be absent), or a single date string → {start}. */
export function parsePeriodValue(raw: unknown): Parsed<PeriodShape> {
  if (typeof raw === "string") {
    const sep = /\s*(?:–|—|~|～|\bto\b|至|到)\s*/;
    const parts = raw.split(sep).map((s) => s.trim()).filter(Boolean);
    if (parts.length === 2) return parsePeriodValue({ start: parts[0], end: parts[1] });
    const d = parseDateValue(raw);
    return d.ok ? { ok: true, value: { start: d.value } } : d;
  }
  if (!isObject(raw)) return fail(`expected a period ({start, end?}), got ${describe(raw)}`);
  const out: PeriodShape = {};
  for (const k of ["start", "end"] as const) {
    if (raw[k] === undefined || raw[k] === null || raw[k] === "") continue;
    const d = parseDateValue(raw[k]);
    if (!d.ok) return fail(`period.${k}: ${d.message}`);
    out[k] = d.value;
  }
  if (!out.start && !out.end) return fail("a period needs a start or an end");
  return { ok: true, value: out };
}

// --------------------------------------------------------------------------- //
// Choice types: pick the type from the value's shape
// --------------------------------------------------------------------------- //

export const QUANTITY_TYPES = ["Quantity", "SimpleQuantity", "Age", "Duration", "Count", "Distance", "MoneyQuantity"];
const DATE_TYPES = ["dateTime", "date", "instant"];

function looksLikeDate(s: string): boolean {
  return parseDateValue(s).ok;
}

function looksLikeQuantity(s: string): boolean {
  const m = QUANTITY_TEXT.exec(s);
  return !!m && m[3] !== "" && !looksLikeDate(s);
}

/**
 * The type a value selects among an element's allowed types (null = nothing fits). A single
 * allowed type is always taken (the parser for that type then judges the value).
 */
export function shapeType(value: unknown, allowed: string[]): string | null {
  if (!allowed.length) return null;
  if (allowed.length === 1) return allowed[0];
  const has = (t: string): boolean => allowed.includes(t);
  const first = (ts: string[]): string | null => ts.find((t) => has(t)) ?? null;
  if (typeof value === "boolean") return has("boolean") ? "boolean" : null;
  if (isNumberLike(value)) {
    const n = Number(value);
    if (Number.isInteger(n)) {
      const t = first(["integer", "positiveInt", "unsignedInt", "decimal"]);
      if (t) return t;
    } else if (has("decimal")) return "decimal";
    return first(QUANTITY_TYPES) ?? first(["string"]);
  }
  if (typeof value === "string") {
    const s = value.trim();
    if (/^(true|false)$/i.test(s) && has("boolean")) return "boolean";
    if (looksLikeDate(s)) {
      const p = parseDateValue(s);
      const prec = p.ok ? p.value.precision : "day";
      const order = prec === "time" ? ["dateTime", "instant", "date"] : ["dateTime", "date", "instant"];
      const t = first(order);
      if (t) return t;
    }
    if (TIME_RE.test(s) && has("time")) return "time";
    if (looksLikeQuantity(s)) {
      const t = first(QUANTITY_TYPES);
      if (t) return t;
    }
    if (NUMERIC_TEXT.test(s)) {
      const t = first(Number.isInteger(Number(s)) ? ["integer", "positiveInt", "unsignedInt", "decimal"] : ["decimal"]);
      if (t) return t;
      const q = first(QUANTITY_TYPES);
      if (q) return q;
    }
    return first(["string", "markdown", "code", "CodeableConcept", "Coding", "uri", "url", "canonical", "id", "Annotation", "HumanName", "Address", "Reference"]);
  }
  if (Array.isArray(value)) return first(["CodeableConcept", "Coding"]) ?? null;
  if (!isObject(value)) return null;
  const keys = new Set(Object.keys(value));
  const any = (...ks: string[]): boolean => ks.some((k) => keys.has(k));
  if (any("ref", "reference")) return first(["Reference"]);
  if (any("start", "end")) return first(["Period"]);
  if (any("low", "high")) return first(["Range"]);
  if (any("numerator", "denominator")) return first(["Ratio"]);
  if (any("coding", "text") && !any("value")) return first(["CodeableConcept", "Coding"]);
  if (any("code", "system") && !any("value")) return first(["CodeableConcept", "Coding"]);
  if (any("value") || any("unit", "comparator")) return first(QUANTITY_TYPES);
  if (any("family", "given")) return first(["HumanName"]);
  if (any("origin", "dimensions")) return first(["SampledData"]);
  if (any("event", "repeat", "frequency")) return first(["Timing"]);
  if (any("contentType", "data", "url", "title")) return first(["Attachment"]);
  if (any("line", "city", "postalCode", "country")) return first(["Address"]);
  if (any("author", "authorString", "authorReference")) return first(["Annotation"]);
  return null;
}

// --------------------------------------------------------------------------- //
// Built-in R4 datatype knowledge (fallback when no core StructureDefinition is reachable)
// --------------------------------------------------------------------------- //

interface DtChild {
  name: string;
  types: string[];
  max?: "1" | "*";
  binding?: { strength: string; valueSet: string };
  /** Children of this child are defined inline (Element / BackboneElement of a datatype). */
  children?: DtChild[];
}

const VS = "http://hl7.org/fhir/ValueSet/";
const req = (vs: string): { strength: string; valueSet: string } => ({ strength: "required", valueSet: `${VS}${vs}|4.0.1` });

const QUANTITY_CHILDREN: DtChild[] = [
  { name: "value", types: ["decimal"] },
  { name: "comparator", types: ["code"], binding: req("quantity-comparator") },
  { name: "unit", types: ["string"] },
  { name: "system", types: ["uri"] },
  { name: "code", types: ["code"] },
];

/** FHIR R4 datatype children (max "1" unless "*"), types in choice order as in the spec. */
export const R4_DATATYPES: Record<string, DtChild[]> = {
  Quantity: QUANTITY_CHILDREN,
  SimpleQuantity: QUANTITY_CHILDREN,
  Age: QUANTITY_CHILDREN,
  Duration: QUANTITY_CHILDREN,
  Count: QUANTITY_CHILDREN,
  Distance: QUANTITY_CHILDREN,
  MoneyQuantity: QUANTITY_CHILDREN,
  Money: [
    { name: "value", types: ["decimal"] },
    { name: "currency", types: ["code"], binding: req("currencies") },
  ],
  Coding: [
    { name: "system", types: ["uri"] },
    { name: "version", types: ["string"] },
    { name: "code", types: ["code"] },
    { name: "display", types: ["string"] },
    { name: "userSelected", types: ["boolean"] },
  ],
  CodeableConcept: [
    { name: "coding", types: ["Coding"], max: "*" },
    { name: "text", types: ["string"] },
  ],
  Identifier: [
    { name: "use", types: ["code"], binding: req("identifier-use") },
    { name: "type", types: ["CodeableConcept"], binding: { strength: "extensible", valueSet: `${VS}identifier-type` } },
    { name: "system", types: ["uri"] },
    { name: "value", types: ["string"] },
    { name: "period", types: ["Period"] },
    { name: "assigner", types: ["Reference"] },
  ],
  HumanName: [
    { name: "use", types: ["code"], binding: req("name-use") },
    { name: "text", types: ["string"] },
    { name: "family", types: ["string"] },
    { name: "given", types: ["string"], max: "*" },
    { name: "prefix", types: ["string"], max: "*" },
    { name: "suffix", types: ["string"], max: "*" },
    { name: "period", types: ["Period"] },
  ],
  Period: [
    { name: "start", types: ["dateTime"] },
    { name: "end", types: ["dateTime"] },
  ],
  Range: [
    { name: "low", types: ["SimpleQuantity"] },
    { name: "high", types: ["SimpleQuantity"] },
  ],
  Ratio: [
    { name: "numerator", types: ["Quantity"] },
    { name: "denominator", types: ["Quantity"] },
  ],
  Reference: [
    { name: "reference", types: ["string"] },
    { name: "type", types: ["uri"] },
    { name: "identifier", types: ["Identifier"] },
    { name: "display", types: ["string"] },
  ],
  Annotation: [
    { name: "author[x]", types: ["Reference", "string"] },
    { name: "time", types: ["dateTime"] },
    { name: "text", types: ["markdown"] },
  ],
  ContactPoint: [
    { name: "system", types: ["code"], binding: req("contact-point-system") },
    { name: "value", types: ["string"] },
    { name: "use", types: ["code"], binding: req("contact-point-use") },
    { name: "rank", types: ["positiveInt"] },
    { name: "period", types: ["Period"] },
  ],
  Address: [
    { name: "use", types: ["code"], binding: req("address-use") },
    { name: "type", types: ["code"], binding: req("address-type") },
    { name: "text", types: ["string"] },
    { name: "line", types: ["string"], max: "*" },
    { name: "city", types: ["string"] },
    { name: "district", types: ["string"] },
    { name: "state", types: ["string"] },
    { name: "postalCode", types: ["string"] },
    { name: "country", types: ["string"] },
    { name: "period", types: ["Period"] },
  ],
  Attachment: [
    { name: "contentType", types: ["code"] },
    { name: "language", types: ["code"] },
    { name: "data", types: ["base64Binary"] },
    { name: "url", types: ["url"] },
    { name: "size", types: ["unsignedInt"] },
    { name: "hash", types: ["base64Binary"] },
    { name: "title", types: ["string"] },
    { name: "creation", types: ["dateTime"] },
  ],
  SampledData: [
    { name: "origin", types: ["SimpleQuantity"] },
    { name: "period", types: ["decimal"] },
    { name: "factor", types: ["decimal"] },
    { name: "lowerLimit", types: ["decimal"] },
    { name: "upperLimit", types: ["decimal"] },
    { name: "dimensions", types: ["positiveInt"] },
    { name: "data", types: ["string"] },
  ],
  Timing: [
    { name: "event", types: ["dateTime"], max: "*" },
    {
      name: "repeat",
      types: ["Element"],
      children: [
        { name: "bounds[x]", types: ["Duration", "Range", "Period"] },
        { name: "count", types: ["positiveInt"] },
        { name: "countMax", types: ["positiveInt"] },
        { name: "duration", types: ["decimal"] },
        { name: "durationMax", types: ["decimal"] },
        { name: "durationUnit", types: ["code"], binding: req("units-of-time") },
        { name: "frequency", types: ["positiveInt"] },
        { name: "frequencyMax", types: ["positiveInt"] },
        { name: "period", types: ["decimal"] },
        { name: "periodMax", types: ["decimal"] },
        { name: "periodUnit", types: ["code"], binding: req("units-of-time") },
        { name: "dayOfWeek", types: ["code"], max: "*", binding: req("days-of-week") },
        { name: "timeOfDay", types: ["time"], max: "*" },
        { name: "when", types: ["code"], max: "*", binding: req("event-timing") },
        { name: "offset", types: ["unsignedInt"] },
      ],
    },
    { name: "code", types: ["CodeableConcept"], binding: { strength: "preferred", valueSet: `${VS}timing-abbreviation` } },
  ],
  Dosage: [
    { name: "sequence", types: ["integer"] },
    { name: "text", types: ["string"] },
    { name: "additionalInstruction", types: ["CodeableConcept"], max: "*", binding: { strength: "example", valueSet: `${VS}additional-instruction-codes` } },
    { name: "patientInstruction", types: ["string"] },
    { name: "timing", types: ["Timing"] },
    { name: "asNeeded[x]", types: ["boolean", "CodeableConcept"], binding: { strength: "example", valueSet: `${VS}medication-as-needed-reason` } },
    { name: "site", types: ["CodeableConcept"], binding: { strength: "example", valueSet: `${VS}approach-site-codes` } },
    { name: "route", types: ["CodeableConcept"], binding: { strength: "example", valueSet: `${VS}route-codes` } },
    { name: "method", types: ["CodeableConcept"], binding: { strength: "example", valueSet: `${VS}administration-method-codes` } },
    {
      name: "doseAndRate",
      types: ["Element"],
      max: "*",
      children: [
        { name: "type", types: ["CodeableConcept"] },
        { name: "dose[x]", types: ["Range", "SimpleQuantity"] },
        { name: "rate[x]", types: ["Ratio", "Range", "SimpleQuantity"] },
      ],
    },
    { name: "maxDosePerPeriod", types: ["Ratio"] },
    { name: "maxDosePerAdministration", types: ["SimpleQuantity"] },
    { name: "maxDosePerLifetime", types: ["SimpleQuantity"] },
  ],
  Meta: [
    { name: "versionId", types: ["id"] },
    { name: "lastUpdated", types: ["instant"] },
    { name: "source", types: ["uri"] },
    { name: "profile", types: ["canonical"], max: "*" },
    { name: "security", types: ["Coding"], max: "*" },
    { name: "tag", types: ["Coding"], max: "*" },
  ],
  Narrative: [
    { name: "status", types: ["code"], binding: req("narrative-status") },
    { name: "div", types: ["xhtml"] },
  ],
  Extension: [
    { name: "url", types: ["uri"] },
    { name: "value[x]", types: ["string", "boolean", "integer", "decimal", "dateTime", "date", "code", "uri", "Coding", "CodeableConcept", "Quantity", "Reference", "Period", "Identifier", "HumanName", "Address"] },
  ],
};

/** A synthetic StructureDefinition snapshot for a built-in datatype (same shape as a core SD). */
export function syntheticDatatypeSd(type: string): Record<string, any> | null {
  const kids = R4_DATATYPES[type];
  if (!kids) return null;
  const elements: Array<Record<string, any>> = [{ id: type, path: type, min: 0, max: "*" }];
  const emit = (parent: string, list: DtChild[]): void => {
    for (const c of list) {
      const max = c.max ?? "1";
      const el: Record<string, any> = { id: `${parent}.${c.name}`, path: `${parent}.${c.name}`, min: 0, max, base: { path: `${parent}.${c.name}`, min: 0, max }, type: c.types.map((code) => ({ code })) };
      if (c.binding) el.binding = c.binding;
      elements.push(el);
      if (c.children) emit(`${parent}.${c.name}`, c.children);
    }
  };
  emit(type, kids);
  return { resourceType: "StructureDefinition", url: `http://hl7.org/fhir/StructureDefinition/${type}`, type, kind: "complex-type", snapshot: { element: elements } };
}
