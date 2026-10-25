/**
 * Unit text → UCUM code (shared by the authoring value grammar and the repair layer's R2 rule).
 *
 *   1. a valid UCUM expression is itself the code;
 *   2. the UCUM definitions' own names / synonyms / print symbols (ucum-lhc tables: "mmHg",
 *      "millimeter of mercury", "°C");
 *   3. a rate written as `<count word>/<time unit>` or `<unit>/<time unit>` in any of the time
 *      words below (English or Chinese: 次/分, 下/分鐘, breaths/min, mg/天): the count word is a
 *      dimensionless count and is dropped (UCUM `/min`), a unit numerator is resolved by 1–2
 *      (`mg/d`) — a grammar over FHIR units-of-time, no list of example strings;
 *   4. (v14.1) structural rewrites that keep the unit's meaning: the micro sign / Greek mu written
 *      for the UCUM prefix `u` (µg, μIU), an atom that is a UCUM bracketed unit written without its
 *      brackets, alone or after a UCUM prefix (IU → [IU], μIU → u[IU]), and a numeric factor
 *      glued to a unit in a divisor — a decimal one, which UCUM cannot write as a factor, as the
 *      annotation `{1.73_m2}` (mL/min/1.73m2 → mL/min/{1.73_m2}, the LOINC convention), an
 *      integer one as `(24.h)`; the result must be a valid UCUM expression;
 *   5. the suggestion layer's generic repair (case, brackets, common clinical spellings such as
 *      bpm → /min, tablet → {tablet}) when it is a cheap edit.
 * Null when nothing resolves. Deterministic and cached.
 */

import { createRequire } from "node:module";
import { checkUcumCode } from "../fhirUcum.js";
import { suggestUcum } from "../fhirSuggestions/ucum.js";

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


/**
 * Count words of the rate grammar: a counted event, not a unit (UCUM drops it: `次/分` → `/min`).
 * Chinese measure words for occurrences / beats and the English count words of the UCUM
 * suggestion layer.
 */
const COUNT_WORDS = new Set(["次", "下", "回", "拍", "跳", "times", "time", "x", "count", "beats", "beat", "breaths", "breath", "events", "event", "counts"]);

/** `<count word | unit>/<time word>` → UCUM (null when the text is not such a rate). */
function rateUnit(t: string): string | null {
  const m = /^\s*([^/]*?)\s*\/\s*(?:每)?\s*(?:1\s*)?([^/\s\d][^/]*?)\s*$/.exec(t);
  if (!m) return null;
  const time = timeUnitCode(m[2]);
  if (!time) return null;
  const num = m[1].trim().toLowerCase();
  if (!num || COUNT_WORDS.has(num)) return checkUcumCode(`/${time}`) === "valid" ? `/${time}` : null;
  if (/[\/]/.test(num)) return null;
  const n = resolveAtom(num);
  if (!n) return null;
  const code = /[./]/.test(n) ? `(${n})/${time}` : `${n}/${time}`;
  return checkUcumCode(code) === "valid" ? code : null;
}

export interface UnitResolution {
  code: string;
  /** How the code was found: a valid UCUM expression as given, a UCUM unit name / synonym / print symbol, or a spelling repair. */
  source: "ucum" | "name" | "rate" | "rewrite" | "spelling";
}

/** UCUM prefixes (longest first so `da` is tried before `d`). */
const PREFIXES = ["da", "Ki", "Mi", "Gi", "Ti", "Y", "Z", "E", "P", "T", "G", "M", "k", "h", "d", "c", "m", "u", "n", "p", "f", "a", "z", "y"];

function ucumOk(c: string): boolean {
  return checkUcumCode(c) === "valid";
}

/** An atom that is a bracketed UCUM unit written without its brackets (IU → [IU], uIU → u[IU]); null unless exactly one reading. */
function bracketAtom(atom: string): string | null {
  if (!atom || ucumOk(atom) || /[[\]{}()]/.test(atom)) return null;
  const hits = new Set<string>();
  if (ucumOk(`[${atom}]`)) hits.add(`[${atom}]`);
  for (const p of PREFIXES) {
    if (!atom.startsWith(p) || atom.length <= p.length) continue;
    const c = `${p}[${atom.slice(p.length)}]`;
    if (ucumOk(c)) hits.add(c);
  }
  return hits.size === 1 ? [...hits][0] : null;
}

/** Step 4: structural rewrites (see the module comment); null when none gives a valid UCUM expression. */
function structuralRewrite(t: string): string | null {
  const micro = t.replace(/[\u00B5\u03BC]/g, "u");
  if (micro !== t && ucumOk(micro)) return micro;
  const segs = micro.split("/");
  let changed = micro !== t;
  const out: string[] = [];
  for (const [i, raw] of segs.entries()) {
    const seg = raw.trim();
    if (!seg || ucumOk(seg) || (i === 0 && seg === "1")) {
      out.push(seg);
      continue;
    }
    // A numeric factor glued to a unit (only as a divisor: "per 1.73 m2", "per 24 h").
    const f = i > 0 ? /^(\d+)(?:\.(\d+))?\s*([A-Za-z][A-Za-z0-9]*)$/.exec(seg) : null;
    if (f && ucumOk(f[3])) {
      out.push(f[2] !== undefined ? `{${f[1]}.${f[2]}_${f[3]}}` : `(${f[1]}.${f[3]})`);
      changed = true;
      continue;
    }
    // Atoms of a product (a.b) that are bracketed units written without brackets.
    const atoms = seg.split(".");
    const fixed = atoms.map((a) => (ucumOk(a) ? a : bracketAtom(a)));
    if (fixed.some((a) => a === null)) return null;
    out.push(fixed.join("."));
    changed = true;
  }
  const code = out.join("/");
  return changed && ucumOk(code) ? code : null;
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

interface UcumConvert {
  convertUnitTo(from: string, value: number, to: string): { status: string; toVal?: number };
}

let converter: UcumConvert | null | undefined;
const equivCache = new Map<string, boolean>();

/**
 * Are two valid UCUM expressions the same unit (conversion factor exactly 1, no offset — `1/min` ≡
 * `/min`, `{beats}/min` ≡ `/min`; `Cel` ≢ `K`)? ucum-lhc conversion; false when it cannot tell.
 */
export function ucumEquivalent(a: string, b: string): boolean {
  if (a === b) return true;
  if (!ucumOk(a) || !ucumOk(b)) return false;
  const k = `${a}\u0000${b}`;
  const hit = equivCache.get(k);
  if (hit !== undefined) return hit;
  let out = false;
  try {
    if (converter === undefined) {
      const require = createRequire(import.meta.url);
      converter = require("@lhncbc/ucum-lhc").UcumLhcUtils.getInstance() as UcumConvert;
    }
    if (converter) {
      const same = (v: number): boolean => {
        const r = converter!.convertUnitTo(a, v, b);
        return !!r && r.status === "succeeded" && typeof r.toVal === "number" && Math.abs(r.toVal - v) <= 1e-9 * Math.max(1, Math.abs(v));
      };
      out = same(1) && same(7) && same(0);
    }
  } catch {
    converter = null;
    out = false;
  }
  if (equivCache.size > 2000) equivCache.clear();
  equivCache.set(k, out);
  return out;
}

/**
 * Unit text → UCUM code. A valid UCUM expression is itself the code; otherwise the UCUM
 * definitions' own names / synonyms / print symbols ("millimeter of mercury", "mmHg", "°C"),
 * then the suggestion layer's generic repair (case, brackets, common clinical spellings such
 * as bpm → /min, tablet → {tablet}) when it is a cheap edit. Null when nothing resolves.
 */
export function resolveUnit(text: string): UnitResolution | null {
  return resolveUnitText(text, true);
}

/** Steps 1, 2 and 4 (no rate grammar) — the numerator of a rate. */
function resolveAtom(text: string): string | null {
  return resolveUnitText(text, false)?.code ?? null;
}

function resolveUnitText(text: string, rates: boolean): UnitResolution | null {
  const raw = String(text ?? "").trim();
  // Compatibility characters are the same unit (NFKC: ℃ → °C, ㎎ → mg, full-width ／ → /).
  const t = checkUcumCode(raw) === "valid" ? raw : raw.normalize("NFKC").trim();
  if (!t) return null;
  const ck = `${rates ? "r" : "a"}\u0000${t}`;
  const hit = unitCache.get(ck);
  if (hit !== undefined) return hit;
  let out: UnitResolution | null = null;
  if (checkUcumCode(t) === "valid") out = { code: t, source: "ucum" };
  else if (/[\u00B5\u03BC]/.test(t) && ucumOk(t.replace(/[\u00B5\u03BC]/g, "u"))) out = { code: t.replace(/[\u00B5\u03BC]/g, "u"), source: "rewrite" };
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
    if (!out && rates) {
      const r = rateUnit(t);
      if (r) out = { code: r, source: "rate" };
    }
    if (!out) {
      const r = structuralRewrite(t);
      if (r) out = { code: r, source: "rewrite" };
    }
    if (!out) {
      const cand = suggestUcum(t, null, 1)[0];
      if (cand && cand.cost <= 0.6) out = { code: cand.value, source: "spelling" };
    }
  }
  if (unitCache.size > 2000) unitCache.clear();
  unitCache.set(ck, out);
  return out;
}
