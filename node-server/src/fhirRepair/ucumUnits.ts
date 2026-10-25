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
 *   4. the suggestion layer's generic repair (case, brackets, common clinical spellings such as
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
  source: "ucum" | "name" | "rate" | "spelling";
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
      const cand = suggestUcum(t, null, 1)[0];
      if (cand && cand.cost <= 0.6) out = { code: cand.value, source: "spelling" };
    }
  }
  if (unitCache.size > 2000) unitCache.clear();
  unitCache.set(ck, out);
  return out;
}
