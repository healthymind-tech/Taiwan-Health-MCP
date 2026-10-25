/**
 * Record value index (ISSUES_v15.1 R1): every identifier token, date, time of day and number the
 * record states, normalised, plus the values DERIVABLE from it by a small generic resolver:
 *
 *   dates   western / ROC 民國 / 中文年月日 / slashes / month-day (resolved with the record's years),
 *           shifted by the relative expressions the record writes — 入院第N天 / hospital day N / HD#N
 *           (admission + N-1 or N), 術後第N天 / POD#N (+N), 第N天 / day N, N 天前 / N days ago, N 天後 /
 *           N days later, 昨天 / 前天 / 今天 / 隔天 / 次日 / tomorrow …, N 週前 / 後, N 個月前 / 後, a
 *           complaint duration (咳嗽 3 天 → onset 3 or 2 days before; also +N / +N-1 for course ends),
 *           N 年前 / N 年 (years), an age (65 歲 → birth year); Chinese numerals are read (入院第三天).
 *           Anchors are the record's own day-precision dates — never "today".
 *   times   HH:MM(:SS), 上午 / 下午 9 點 20 分, 9:20 pm, a compact HHMM right after a date, shifted by
 *           "N 分鐘 / 小時 後 / 前" expressions.
 *   numbers every number outside a date / time (so a 0 or a 14 is never grounded by "08:00" or
 *           "2025/03/14"), with its unit; Chinese numerals (三天, 一百二十), 半 (0.5), fractions (1/2).
 *   ids     alphanumeric runs (separators -, space, /, . removed), and their separator pieces.
 *
 * Lines of the conversion instruction (【轉換目標】) and of the site configuration section are never
 * record evidence; the site configuration TEXT is searched for identifiers only (facility / license
 * numbers live there). Pure and deterministic; nothing is logged.
 */
import { addDays, canonUnit, findAll, nfkc, numbersWithUnits, parseDatesPos, TIME_RE } from "../grounding/lexicon.js";
import { RecordText } from "../grounding/recordText.js";

export interface RecDate {
  prec: "day" | "month" | "year" | "md";
  y: number | null;
  m: number | null;
  d: number | null;
  li: number;
  ci: number;
  /** A birth date (出生日期 / 生日 / DOB written before it): never an anchor for the current events. */
  birth?: boolean;
  /** The date as written in the record (NFKC), e.g. 民國92年8月25日 / 92/08/25 / 2003-08-25. */
  raw?: string;
}

export interface RecTime {
  h: number;
  mi: number;
  s: number | null;
  li: number;
  ci: number;
  /** Day the time is written with (same line, right after a date), when there is one. */
  day: string | null;
}

export interface RecNumber {
  value: number;
  unit: string | null;
  li: number;
  /** Clause of the line (split at ；;。) — a measurement's own stamp is in its clause. */
  ci: number;
  raw: string;
}

const SKIP = new Set(["instruction", "site_config"]);
const pad = (n: number): string => String(n).padStart(2, "0");
export const dayKey = (y: number, m: number, d: number): string => `${y}-${pad(m)}-${pad(d)}`;
export const monthKey = (y: number, m: number): string => `${y}-${pad(m)}`;

// ------------------------------------------------------------------------------------------- Chinese numerals

const CN_DIGIT: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 兩: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const RE_CN_RUN = /[零〇一二兩两三四五六七八九十百千]+/gu;

function cnValue(s: string): number | null {
  let total = 0;
  let cur = 0;
  let any = false;
  for (const ch of s) {
    if (ch in CN_DIGIT) {
      cur = cur * 10 + CN_DIGIT[ch];
      any = true;
    } else {
      const mult = ch === "十" ? 10 : ch === "百" ? 100 : ch === "千" ? 1000 : 0;
      if (!mult) return null;
      total += (cur || 1) * mult;
      cur = 0;
      any = true;
    }
  }
  return any ? total + cur : null;
}

/** Chinese numeral runs written as Arabic digits (入院第三天 → 入院第3天); other text unchanged. */
export function cnToArabic(t: string): string {
  return t.replace(RE_CN_RUN, (run) => {
    const v = cnValue(run);
    return v === null ? run : String(v);
  });
}

// ------------------------------------------------------------------------------------------- relative expressions

/**
 * What a relative expression counts from: the admission date (入院第N天, HD#N), the operation date
 * (POD#N, 術後第N天), or — for everything else (N 天前, 昨天, 咳嗽 3 天) — the date in force at the line: a date on
 * the line itself, else the nearest preceding dated line, else the visit / admission date.
 */
type AnchorKind = "admission" | "surgery" | "local";
interface DayOff {
  off: number;
  kind: AnchorKind;
  li: number;
}
interface Offsets {
  days: DayOff[];
  months: Set<number>;
  years: Set<number>;
  ages: Set<number>;
  minutes: Set<number>;
}

const n1 = (x: string | undefined): number => parseInt(x ?? "0", 10);
const DAY_RULES: Array<[RegExp, (m: RegExpExecArray) => number[], AnchorKind?]> = [
  // 入院第 N 天 / hospital day N: day 1 is the admission day (and back from a dated "day N" to the admission)
  [/(?:入院|住院|admission|hospital)\s*(?:第|day|d)\s*#?\s*(\d{1,3})\s*(?:天|日)?/gu, (m) => [n1(m[1]) - 1], "admission"],
  [/\bhd\s*#?\s*(\d{1,3})\b/gu, (m) => [n1(m[1]) - 1], "admission"],
  [/(?:術後|手術後|產後|post-?op(?:erative)?\s*day|pod)\s*(?:第)?\s*#?\s*(\d{1,3})\s*(?:天|日)?/gu, (m) => [n1(m[1])], "surgery"],
  [/(?<!入院|住院|術後|手術後|產後)第\s*(\d{1,3})\s*(?:天|日)/gu, (m) => [n1(m[1]) - 1, -(n1(m[1]) - 1)]],
  [/(?<!hospital\s*|post-?op(?:erative)?\s*)\bday\s*#?\s*(\d{1,3})\b/gu, (m) => [n1(m[1]) - 1, -(n1(m[1]) - 1)]],
  [/(\d{1,3})\s*(?:天|日)\s*(?:前|之前|以前)/gu, (m) => [-n1(m[1])]],
  [/前\s*(\d{1,3})\s*(?:天|日)/gu, (m) => [-n1(m[1])]],
  [/(\d{1,3})\s*days?\s*(?:ago|before|earlier|prior)/gu, (m) => [-n1(m[1])]],
  [/(\d{1,3})\s*(?:天|日)\s*(?:後|之後|以後)/gu, (m) => [n1(m[1])]],
  [/(\d{1,3})\s*days?\s*(?:later|after)/gu, (m) => [n1(m[1])]],
  [/after\s*(\d{1,3})\s*days?/gu, (m) => [n1(m[1])]],
  [/隔\s*(\d{1,3})\s*(?:天|日)/gu, (m) => [n1(m[1])]],
  [/(\d{1,3})\s*(?:週|周|星期|weeks?|wks?)\s*(?:前|之前|ago|before|earlier)/gu, (m) => [-7 * n1(m[1])]],
  [/(\d{1,3})\s*(?:週|周|星期|weeks?|wks?)\s*(?:後|之後|later|after)/gu, (m) => [7 * n1(m[1])]],
  // a duration (咳嗽 3 天, x 3 days, for 3 days): onset N or N-1 days before
  [/(?<![\d.])(\d{1,3})\s*(?:天|日|days?)(?!前|之前|後|之後|份)/gu, (m) => [-n1(m[1]), -(n1(m[1]) - 1)]],
  [/(?<![\d.])(\d{1,2})\s*(?:週|周|星期|weeks?|wks?)(?!前|之前|後|之後)/gu, (m) => [-7 * n1(m[1])]],
];
/** On a treatment-course line (處方 … 7 天, for 14 days): the course ends N or N-1 days after its start. */
const COURSE_RULES: Array<[RegExp, (m: RegExpExecArray) => number[]]> = [
  [/(?<![\d.])(\d{1,3})\s*(?:天|日|days?)(?!前|之前|後|之後)/gu, (m) => [n1(m[1]), n1(m[1]) - 1]],
  [/(?<![\d.])(\d{1,2})\s*(?:週|周|星期|weeks?|wks?)(?!前|之前|後|之後)/gu, (m) => [7 * n1(m[1]), 7 * n1(m[1]) - 1]],
];
const RE_COURSE_LINE = /(處方|療程|服用|口服|靜脈|注射|天份|帶藥|用藥|\brx\b|\btab|\bcap|\bmg\b|supply|for\s+\d+\s+(?:days?|weeks?)|\b(?:qd|bid|tid|qid|qod|hs|prn)\b|每日|一天|每天)/u;
const DAY_WORDS: Array<[RegExp, number]> = [
  [/大前天/gu, -3],
  [/昨天|昨日|昨晚|昨夜|昨早|yesterday/gu, -1],
  [/前天|前日|前晚/gu, -2],
  [/今天|今日|今晚|今早|今晨|本日|當天|當日|同日|同天|today|tonight|same day/gu, 0],
  [/明天|明日|隔天|隔日|翌日|次日|tomorrow|next day|following day|next morning/gu, 1],
  [/後天/gu, 2],
  [/上週|上周|上星期|last week|a week ago/gu, -7],
  [/下週|下周|下星期|next week/gu, 7],
];
const MONTH_RULES: Array<[RegExp, (m: RegExpExecArray) => number[]]> = [
  [/(\d{1,2})\s*(?:個月|個多月|months?)\s*(?:前|之前|ago|before)/gu, (m) => [-n1(m[1])]],
  [/(\d{1,2})\s*(?:個月|months?)\s*(?:後|之後|later|after)/gu, (m) => [n1(m[1])]],
  [/(?<![\d.])(\d{1,2})\s*(?:個月|個多月|months?)(?!前|之前|後|之後)/gu, (m) => [-n1(m[1]), n1(m[1])]],
  [/上個月|上月|last month/gu, () => [-1]],
  [/下個月|下月|next month/gu, () => [1]],
];
const YEAR_RULES: Array<[RegExp, (m: RegExpExecArray) => number[]]> = [
  [/(\d{1,2})\s*(?:年|years?|yrs?)\s*(?:前|之前|ago|before)/gu, (m) => [-n1(m[1]), -n1(m[1]) - 1]],
  [/(?<![\d.])(\d{1,2})\s*(?:年|多年|years?|yrs?)(?!前|之前|後|月|\s*\d)/gu, (m) => [-n1(m[1]), -n1(m[1]) - 1]],
  [/去年|last year/gu, () => [-1]],
  [/前年/gu, () => [-2]],
  [/今年|this year/gu, () => [0]],
];
const RE_AGE = /(?<![\d.])(\d{1,3})\s*(?:歲|y\/o|yo|y\.o\.|years?\s*old|-year-old|y)(?![a-z])/gu;
const MINUTE_RULES: Array<[RegExp, (m: RegExpExecArray) => number[]]> = [
  [/(\d{1,3})\s*(?:分鐘|分|minutes?|mins?)\s*(?:後|之後|later|after)/gu, (m) => [n1(m[1])]],
  [/(\d{1,3})\s*(?:分鐘|分|minutes?|mins?)\s*(?:前|之前|ago|before|earlier)/gu, (m) => [-n1(m[1])]],
  [/(\d{1,2})\s*(?:小時|個小時|hours?|hrs?|h)\s*(?:後|之後|later|after)/gu, (m) => [60 * n1(m[1])]],
  [/(\d{1,2})\s*(?:小時|個小時|hours?|hrs?|h)\s*(?:前|之前|ago|before|earlier)/gu, (m) => [-60 * n1(m[1])]],
  [/半\s*(?:小時|個小時)\s*(?:後|之後)/gu, () => [30]],
  [/(?<![\d.])(\d{1,2})\s*(?:小時|個小時|hours?|hrs?)(?!前|之前|後|之後)/gu, (m) => [-60 * n1(m[1]), 60 * n1(m[1])]],
];

function collectOffsets(t: string, o: Offsets, course: boolean, li: number): void {
  for (const [rx, f, kind] of DAY_RULES) for (const m of findAll(rx, t)) for (const x of f(m)) o.days.push({ off: x, kind: kind ?? "local", li });
  if (course) for (const [rx, f] of COURSE_RULES) for (const m of findAll(rx, t)) for (const x of f(m)) o.days.push({ off: x, kind: "local", li });
  for (const [rx, x] of DAY_WORDS) if (findAll(rx, t).length) o.days.push({ off: x, kind: "local", li });
  for (const [rx, f] of MONTH_RULES) for (const m of findAll(rx, t)) for (const x of f(m)) o.months.add(x);
  for (const [rx, f] of YEAR_RULES) for (const m of findAll(rx, t)) for (const x of f(m)) o.years.add(x);
  for (const m of findAll(RE_AGE, t)) {
    const a = n1(m[1]);
    if (a >= 0 && a <= 120) o.ages.add(a);
  }
  for (const [rx, f] of MINUTE_RULES) for (const m of findAll(rx, t)) for (const x of f(m)) o.minutes.add(x);
}

// ------------------------------------------------------------------------------------------- times

const RE_TIME = new RegExp(TIME_RE.source, "gu");
const RE_CN_TIME = /(上午|早上|清晨|凌晨|中午|下午|傍晚|晚上|夜間|半夜)?\s*(\d{1,2})\s*(?:點|時)\s*(?:(\d{1,2})\s*分|半|整)?/gu;
const RE_AMPM = /(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)/gu;
const RE_COMPACT_AFTER_DATE = /^\s*(?:t|,)?\s*([01]\d|2[0-3])([0-5]\d)(?![\d:])/u;

function pm(prefix: string | undefined, h: number): number {
  if (!prefix) return h;
  if (/(下午|傍晚|晚上|夜間)/u.test(prefix) && h < 12) return h + 12;
  if (/(半夜|凌晨)/u.test(prefix) && h === 12) return 0;
  if (prefix === "中午" && h < 6) return h + 12;
  return h;
}

const EN_MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const RE_EN_MDY = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/gu;
const RE_EN_DMY = /\b(\d{1,2})(?:st|nd|rd|th)?[\s-]+(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?[\s,-]+(\d{4})\b/gu;

const escRe = (x: string): string => x.replace(/[.*+?^$()|[\]{}\\/]/gu, "\\$&");

// ------------------------------------------------------------------------------------------- identifiers

const RE_ID_RUN = /[a-z0-9](?:[a-z0-9]|[-_./\s](?=[a-z0-9]))*/gu;
const RE_ID_SEP = /[-_./\s]+/u;

/** Identifier normal form: NFKC, upper case, separators (- _ . / space :) removed. */
export function idNorm(v: string): string {
  return nfkc(v).replace(/[-_./\s:：]/gu, "").toUpperCase();
}

// ------------------------------------------------------------------------------------------- the index

export class RecordValues {
  readonly rt: RecordText;
  readonly dates: RecDate[] = [];
  readonly times: RecTime[] = [];
  readonly numbers: RecNumber[] = [];
  /** Day keys stated in the record, and derived from it (with the expression that derives them). */
  readonly days = new Map<string, number>();
  readonly derivedDays = new Set<string>();
  readonly months = new Set<string>();
  readonly derivedMonths = new Set<string>();
  readonly years = new Set<number>();
  readonly derivedYears = new Set<number>();
  /** "h:mm" and "h:mm:ss" keys stated in the record; derived ones separately. */
  readonly timeKeys = new Set<string>();
  readonly derivedTimes = new Set<string>();
  /** Identifier pieces (idNorm) of the record and of the site configuration. */
  private readonly idPieces = new Set<string>();
  private readonly idRuns: string[] = [];
  /** Normalised full text (record + site), for identifiers that are not alphanumeric (醫字第012345號). */
  private readonly flat: string;
  /** Lines (record line index → nfkc text) outside the instruction / site sections. */
  readonly lineText = new Map<number, string>();

  constructor(sourceText: string, siteConfig: string | null) {
    this.rt = new RecordText(sourceText, siteConfig);
    const off: Offsets = { days: [], months: new Set(), years: new Set(), ages: new Set(), minutes: new Set() };
    const recordLines: string[] = [];
    this.rt.lines.forEach((ln, li) => {
      if (SKIP.has(ln.section) || !ln.line.trim()) return;
      recordLines.push(ln.line);
      const t = nfkc(ln.line);
      this.lineText.set(li, t);
      // relative expressions are read outside the dates / times of the line (「3月14日」 is not "14 days")
      const blank = cnToArabic(this.indexLine(t, li));
      collectOffsets(blank, off, ln.section === "plan" || RE_COURSE_LINE.test(blank), li);
    });
    this.indexIds([...recordLines, ...(siteConfig ?? "").split(/\r?\n/u)]);
    this.flat = nfkc([...recordLines, siteConfig ?? ""].join("\n")).replace(/[\s\-_./:：,，;；、()（）]/gu, "").toUpperCase();
    this.derive(off);
  }

  private addEnDate(y: number, m: number, d: number, li: number, ci: number, mask: Array<[number, number]>, a: number, b: number, dayEnds: Array<[number, string]>): void {
    if (m < 1 || y < 1900 || y > 2100 || d < 1 || d > 31) return;
    const k = dayKey(y, m, d);
    this.dates.push({ prec: "day", y, m, d, li, ci, raw: this.lineText.get(li)?.slice(a, b) });
    if (!this.days.has(k)) this.days.set(k, li);
    this.months.add(monthKey(y, m));
    this.years.add(y);
    mask.push([a, b]);
    dayEnds.push([b, k]);
  }

  /** Index one line; returns the line with its date / time spans blanked. */
  private indexLine(t: string, li: number): string {
    const bounds: number[] = [];
    for (let i = 0; i < t.length; i++) if (/[；;。]/u.test(t[i])) bounds.push(i);
    const ciOf = (pos: number): number => bounds.filter((b) => b < pos).length;
    // dates (spans masked out of the number scan below)
    const mask: Array<[number, number]> = [];
    const dayEnds: Array<[number, string]> = [];
    for (const pd of parseDatesPos(t)) {
      const [prec, [y, m, d]] = pd.date;
      const birth = /(生日|出生|生於|dob|birth)[^，,；;。]{0,6}$/u.test(t.slice(Math.max(0, pd.start - 12), pd.start));
      this.dates.push({ prec, y, m, d, li, ci: ciOf(pd.start), birth, raw: t.slice(pd.start, pd.end) });
      if (prec === "day") {
        const k = dayKey(y!, m!, d!);
        if (!this.days.has(k)) this.days.set(k, li);
        this.months.add(monthKey(y!, m!));
        this.years.add(y!);
        mask.push([pd.start, pd.end]);
        dayEnds.push([pd.end, k]);
      } else if (prec === "month") {
        this.months.add(monthKey(y!, m!));
        this.years.add(y!);
        mask.push([pd.start, pd.end]);
      } else if (prec === "year") {
        this.years.add(y!);
        if (/年/u.test(t.slice(pd.start, pd.end)) && /民國/u.test(t.slice(Math.max(0, pd.start - 3), pd.end))) mask.push([pd.start, pd.end]);
      }
    }
    // English month names (Oct 5, 2026 / 5-Oct-2026 / 5 October 2026)
    for (const m of findAll(RE_EN_MDY, t)) {
      const mo = EN_MONTHS.indexOf(m[1].slice(0, 3)) + 1;
      this.addEnDate(n1(m[3]), mo, n1(m[2]), li, ciOf(m.index), mask, m.index, m.index + m[0].length, dayEnds);
    }
    for (const m of findAll(RE_EN_DMY, t)) {
      const mo = EN_MONTHS.indexOf(m[2].slice(0, 3)) + 1;
      this.addEnDate(n1(m[3]), mo, n1(m[1]), li, ciOf(m.index), mask, m.index, m.index + m[0].length, dayEnds);
    }
    // times
    const addTime = (h: number, mi: number, s: number | null, start: number, end: number): void => {
      if (h > 23 || mi > 59) return;
      let day: string | null = null;
      for (const [e, k] of dayEnds) if (start >= e && start - e <= 3) day = k;
      this.times.push({ h, mi, s, li, ci: ciOf(start), day });
      this.timeKeys.add(`${h}:${pad(mi)}`);
      if (s !== null) this.timeKeys.add(`${h}:${pad(mi)}:${pad(s)}`);
      mask.push([start, end]);
    };
    for (const m of findAll(RE_TIME, t)) {
      const after = t.slice(m.index + m[0].length, m.index + m[0].length + 6);
      const before = t.slice(Math.max(0, m.index - 4), m.index);
      let h = n1(m[1]);
      if (/^\s*(pm|p\.m\.)/u.test(after) && h < 12) h += 12;
      if (/^\s*(am|a\.m\.)/u.test(after) && h === 12) h = 0;
      h = pm(/(上午|早上|清晨|凌晨|中午|下午|傍晚|晚上|夜間|半夜)\s*$/u.exec(before)?.[1], h);
      addTime(h, n1(m[2]), m[3] !== undefined ? n1(m[3]) : null, m.index, m.index + m[0].length);
    }
    for (const m of findAll(RE_CN_TIME, t)) {
      if (!m[1] && !/點/u.test(m[0]) && m[3] === undefined) continue; // "3 時" alone is ambiguous (3 hours); 21時30分 is a time
      const h = pm(m[1], n1(m[2]));
      const mi = m[3] !== undefined ? n1(m[3]) : m[0].includes("半") ? 30 : 0;
      addTime(h, mi, null, m.index, m.index + m[0].length);
    }
    const tc = cnToArabic(t);
    if (tc !== t) {
      // 下午三點二十分: Chinese-numeral times (no masking: offsets differ from the line's)
      for (const m of findAll(RE_CN_TIME, tc)) {
        if (!/點/u.test(m[0])) continue;
        const h = pm(m[1], n1(m[2]));
        const mi = m[3] !== undefined ? n1(m[3]) : m[0].includes("半") ? 30 : 0;
        if (h <= 23 && mi <= 59) {
          this.times.push({ h, mi, s: null, li, ci: 0, day: null });
          this.timeKeys.add(`${h}:${pad(mi)}`);
        }
      }
    }
    for (const m of findAll(RE_AMPM, t)) {
      let h = n1(m[1]);
      if (h > 12) continue;
      if (m[3].startsWith("p") && h < 12) h += 12;
      if (m[3].startsWith("a") && h === 12) h = 0;
      addTime(h, m[2] ? n1(m[2]) : 0, null, m.index, m.index + m[0].length);
    }
    for (const [e] of dayEnds) {
      const c = RE_COMPACT_AFTER_DATE.exec(t.slice(e));
      if (c) addTime(n1(c[1]), n1(c[2]), null, e, e + c[0].length);
    }
    // numbers outside dates / times, clause by clause
    let masked = "";
    for (let i = 0; i < t.length; i++) masked += mask.some(([a, b]) => i >= a && i < b) ? " " : t[i];
    const starts = [0, ...bounds.map((b) => b + 1)];
    starts.forEach((a, ci) => {
      const c = masked.slice(a, ci < bounds.length ? bounds[ci] : masked.length);
      const push = (value: number, unit: string | null, raw: string): void => void this.numbers.push({ value, unit, li, ci, raw });
      for (const [, num, unit, raw] of numbersWithUnits(c)) {
        // °F is not in the grounding unit table: read it here (98.6°F → [degf])
        const f = new RegExp(`${escRe(raw.trim())}\\s*(?:°\\s*f|degf|華氏)(?![a-z])`, "u").test(c);
        push(num, f ? "[degf]" : unit, raw.trim());
      }
      for (const m of findAll(RE_CN_RUN, c)) {
        const v = cnValue(m[0]);
        if (v === null) continue;
        const rest = c.slice(m.index + m[0].length, m.index + m[0].length + 4);
        const unit = canonUnit(/^\s*([^\s\d，,。；;]{1,2})/u.exec(rest)?.[1] ?? "");
        push(v, unit && unit.length <= 12 ? unit : null, m[0]);
        if (/^\s*(?:顆|錠|粒|包|片|支|個|瓶)?\s*半/u.test(rest)) push(v + 0.5, "{tab}", `${m[0]}半`);
      }
      // an explicit product (500 mg x 2, 2 × 500 mg): the total is stated by the record too
      for (const m of findAll(/(?<![\d.])(\d+(?:\.\d+)?)\s*([a-zµμ%]{1,5}|毫克|公克|毫升)?\s*[x×*]\s*(\d+(?:\.\d+)?)(?!\s*[\^*]|\s*10\s*[\^*])\s*([a-zµμ%]{1,5}|毫克|公克|毫升)?/gu, c)) {
        if (m[3] === "10" && /^\s*\^/u.test(c.slice(m.index + m[0].length))) continue;
        push(Number(m[1]) * Number(m[3]), canonUnit(m[2] ?? m[4] ?? "") || null, m[0]);
      }
      if (/半\s*(?:顆|錠|粒|包|片|支|瓶|tab|cap)/u.test(c) || /(?:一|1)\s*半/u.test(c)) push(0.5, "{tab}", "半");
      for (const m of findAll(/(\d+)\s*(?:顆|錠|粒|包|片|支|個|瓶)\s*半/gu, c)) push(n1(m[1]) + 0.5, "{tab}", m[0]);
      for (const m of findAll(/(?<![\d/])(\d)\s*[/⁄]\s*([2-4])(?![\d/])/gu, t.slice(a, ci < bounds.length ? bounds[ci] : t.length))) {
        const x = n1(m[1]);
        const y = n1(m[2]);
        if (x < y) push(x / y, null, m[0]);
      }
    });
    return masked;
  }

  private indexIds(lines: string[]): void {
    for (const line of lines) {
      const t = nfkc(line);
      for (const m of findAll(RE_ID_RUN, t)) {
        const pieces = m[0].split(RE_ID_SEP).filter(Boolean).map((p) => p.toUpperCase());
        this.idRuns.push(pieces.join(""));
        // every contiguous join of separator pieces ("0912-345-678", "A 123 456 789")
        for (let i = 0; i < pieces.length; i++) {
          let acc = "";
          for (let j = i; j < pieces.length && j < i + 6; j++) {
            acc += pieces[j];
            this.idPieces.add(acc);
          }
        }
      }
    }
  }

  private derive(off: Offsets): void {
    const anchors: Array<[number, number, number]> = [];
    for (const k of this.days.keys()) {
      const [y, m, d] = k.split("-").map(Number);
      anchors.push([y, m, d]);
    }
    // month-day dates take the record's years
    for (const dt of this.dates) {
      if (dt.prec !== "md") continue;
      for (const y of this.years) {
        const k = dayKey(y, dt.m!, dt.d!);
        if (!this.days.has(k)) this.derivedDays.add(k);
      }
    }
    const capped = anchors.slice(0, 40);
    // anchors per kind (see AnchorKind)
    const dayDates = this.dates.filter((d) => d.prec === "day" && !d.birth);
    const linesMatching = (rx: RegExp): Array<[number, number, number]> =>
      dayDates.filter((d) => rx.test(this.lineText.get(d.li) ?? "")).map((d) => [d.y!, d.m!, d.d!]);
    const visit = linesMatching(/(入院|住院|admission|admitted|admit|就診|看診|門診日|到院|visit|arrival|encounter)/u);
    const admission = linesMatching(/(入院|住院|admission|admitted|admit)/u);
    const surgery = linesMatching(/(手術|術式|開刀|operation|surgery|\bop\b|post-?op)/u);
    const fallback = visit.length ? visit : capped;
    const local = (li: number): Array<[number, number, number]> => {
      const own = dayDates.filter((d) => d.li === li);
      if (own.length) return own.map((d) => [d.y!, d.m!, d.d!]);
      const prev = dayDates.filter((d) => d.li < li).sort((a, b) => b.li - a.li);
      if (prev.length) return dayDates.filter((d) => d.li === prev[0].li).map((d) => [d.y!, d.m!, d.d!]);
      return fallback;
    };
    for (const o of off.days) {
      if (Math.abs(o.off) > 400) continue;
      const base = o.kind === "admission" ? (admission.length ? admission : fallback) : o.kind === "surgery" ? (surgery.length ? surgery : fallback) : local(o.li);
      for (const [y, m, d] of base) {
        const [yy, mm, dd] = addDays(y, m, d, o.off);
        this.derivedDays.add(dayKey(yy, mm, dd));
      }
    }
    for (const [y, m, d] of capped) {
      for (const o of off.months) {
        let mm = m + o;
        let yy = y;
        while (mm < 1) {
          mm += 12;
          yy--;
        }
        while (mm > 12) {
          mm -= 12;
          yy++;
        }
        this.derivedMonths.add(monthKey(yy, mm));
        this.derivedDays.add(dayKey(yy, mm, Math.min(d, 28)));
        if (d > 28) this.derivedDays.add(dayKey(yy, mm, d));
      }
    }
    for (const k of this.derivedDays) this.derivedMonths.add(k.slice(0, 7));
    // years count from the current events (a birth date is never an anchor: 「高血壓10年」 is not 10 years before birth)
    const anchorYears = new Set(dayDates.map((d) => d.y!));
    if (!anchorYears.size) for (const y of this.years) anchorYears.add(y);
    for (const y of anchorYears) {
      for (const o of off.years) this.derivedYears.add(y + o);
      for (const a of off.ages) {
        this.derivedYears.add(y - a);
        this.derivedYears.add(y - a - 1);
      }
    }
    for (const k of this.derivedMonths) this.derivedYears.add(Number(k.slice(0, 4)));
    for (const t of this.times) {
      for (const o of off.minutes) {
        const tot = (((t.h * 60 + t.mi + o) % 1440) + 1440) % 1440;
        this.derivedTimes.add(`${Math.floor(tot / 60)}:${pad(tot % 60)}`);
      }
    }
  }

  /** Whether an identifier value is stated in the record / site configuration (see the header). */
  hasIdentifier(value: string): boolean {
    const v = idNorm(value);
    if (!v) return true;
    if (!/^[A-Z0-9]+$/u.test(v)) return this.flat.includes(v);
    if (this.idPieces.has(v)) return true;
    const stripped = /^\d+$/u.test(v) ? v.replace(/^0+(?=\d)/u, "") : null;
    for (const run of this.idRuns) {
      if (stripped !== null && /^\d+$/u.test(run) && run.replace(/^0+(?=\d)/u, "") === stripped) return true;
      // a label glued to the number (MRN00775310) or the value with its label prefix (MRN-00775310 vs 00775310)
      if (v.length >= 4 && /\d/u.test(v)) {
        if (run.endsWith(v) && /^[A-Z]{1,5}$/u.test(run.slice(0, run.length - v.length))) return true;
        if (v.endsWith(run) && run.length >= 4 && /\d/u.test(run) && /^[A-Z]{1,5}$/u.test(v.slice(0, v.length - run.length))) return true;
      }
    }
    return false;
  }

  /** Candidates of an identifier the record states next to one of `labels` (for "identifier without value"). */
  identifierNear(labels: readonly string[]): string[] {
    const out: string[] = [];
    for (const t of this.lineText.values()) {
      for (const lb of labels) {
        const i = t.indexOf(lb);
        if (i < 0) continue;
        const tail = t.slice(i + lb.length, i + lb.length + 30);
        const m = /^\s*(?:號碼|字號|號|no\.?|number|#)?\s*[:：]?\s*([a-z0-9][a-z0-9-]{3,})/u.exec(tail);
        if (m && /\d/u.test(m[1])) out.push(m[1].toUpperCase());
      }
    }
    return [...new Set(out)];
  }

  /** Text of clause `ci` (split at ；;。) of record line `li` (NFKC). */
  clauseText(li: number, ci: number): string {
    return (this.lineText.get(li) ?? "").split(/[；;。]/u)[ci] ?? "";
  }

  /** Nearest stated day dates to a date (for evidence). */
  nearestDays(y: number, m: number, d: number, n = 3): string[] {
    const t0 = Date.UTC(y, m - 1, d);
    return [...this.days.keys()]
      .map((k) => {
        const [yy, mm, dd] = k.split("-").map(Number);
        return [k, Math.abs(Date.UTC(yy, mm - 1, dd) - t0)] as const;
      })
      .sort((a, b) => a[1] - b[1])
      .slice(0, n)
      .map(([k]) => k);
  }
}
