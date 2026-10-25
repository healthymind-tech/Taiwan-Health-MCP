/**
 * Dates of the repair layer (ISSUES_v14 R3) and the authoring value grammar (authoring/values.ts
 * re-exports the parsers): ISO at any precision, ROC (民國) dates → Gregorian (+1911, precision
 * kept), and the repair rule for date / dateTime / instant values written as ROC dates.
 */

import { primitiveOk } from "../fhirValidator.js";
import { describe, fail, type Parsed } from "./parsed.js";
import type { RepairChange, RepairIssue } from "./types.js";
import type { Site } from "./walk.js";

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

export const TIME_RE = /^(\d{1,2}):(\d{2})(?::(\d{2})(\.\d+)?)?$/;

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
// R3 repair rule
// --------------------------------------------------------------------------- //


const DATE_TYPES = new Set(["date", "dateTime", "instant"]);
/** A ROC year is certain when it is marked (民國 / ROC) or has exactly three digits; 1–2 digits are ambiguous. */
const ROC_MARK = /^\s*(民國|ROC)/i;
const LEAD_YEAR = /^\s*(?:民國|ROC)?\s*(\d{1,4})\s*[/.\-年]/i;

/**
 * R3: a date / dateTime / instant written as a ROC (民國) date → Gregorian (+1911, precision
 * kept). Certain only for a marked year (民國115年10月3日, ROC 115/10/03) or a three-digit year
 * (115-10-03, 115/10/03, 115-10-03T16:05:00); a one- or two-digit unmarked year is ambiguous
 * (ROC 99 or 1999?) and reported. A time keeps the offset written with it, else takes the
 * caller's timezone (context / facility setting); without either it is reported — an offset is
 * never invented. Values that are already valid, and four-digit years, are never touched.
 */
export function repairDates(sites: Site[], rp: (p: string) => string, skip: (p: string) => boolean, timezone: string | null | undefined): { changes: RepairChange[]; issues: RepairIssue[] } {
  const changes: RepairChange[] = [];
  const issues: RepairIssue[] = [];
  for (const site of sites) {
    if (!DATE_TYPES.has(site.type) || typeof site.value !== "string" || skip(site.path)) continue;
    const raw = site.value;
    if (primitiveOk(site.type, raw)) continue;
    const lead = LEAD_YEAR.exec(raw);
    if (!lead) continue;
    const digits = lead[1].length;
    const marked = ROC_MARK.test(raw);
    if (digits === 4) continue; // Gregorian: not this rule's business
    const path = rp(site.path);
    if (!marked && digits !== 3) {
      issues.push({ path, rule: "roc-date", severity: "error", message: `'${raw}' has a ${digits}-digit year: a ROC (民國) year or a Gregorian one cannot be told apart — write the full year (e.g. ${2026}-…) or 民國YYY` });
      continue;
    }
    const p = parseDateValue(raw);
    if (!p.ok || !p.value.roc) {
      if (!p.ok) issues.push({ path, rule: "roc-date", severity: "error", message: `'${raw}' looks like a ROC (民國) date but is not a valid date: ${p.message}` });
      continue;
    }
    const fitted = fitDate(p.value, site.type as "date" | "dateTime" | "instant", timezone ?? null);
    if (!fitted.ok) {
      issues.push({ path, rule: "roc-date", severity: "error", message: `'${raw}' is the ROC date ${p.value.value} but cannot be written as a FHIR ${site.type}: ${fitted.message}` });
      continue;
    }
    if (!primitiveOk(site.type, fitted.value)) continue;
    if (site.index === null) site.holder[site.key] = fitted.value;
    else (site.holder[site.key] as unknown[])[site.index] = fitted.value;
    const tz = p.value.precision === "time" && !p.value.hasOffset ? ` (UTC offset ${timezone} from the context timezone)` : "";
    changes.push({ path, from: raw, to: fitted.value, rule: "roc-date", reason: `ROC (民國) year ${lead[1]} = ${Number(lead[1]) + 1911}${tz}` });
  }
  return { changes, issues };
}
