/**
 * Date corrections (ISSUES_v15.1 R6): a date judged ungrounded (record checks `ungrounded-value`, grounding
 * G-UNGROUNDED / G-VALUE-MISMATCH as surfaced by the validating tools) whose month and day the record
 * states with another year is most often a wrong ROC ↔ Gregorian conversion — 民國92年8月25日 written as
 * 1983-08-25 (correct 2003-08-25), 民國47年6月20日 as 1959-06-20 (correct 1958-06-20), the ROC year written
 * as the Gregorian one (0092-08-25, 1992), an offset of 1912 / 1910 / 11. The record's own date is the
 * correct value: it is offered as a `replace_value` suggestion with patch {op: "replace", path, value} and a
 * reason quoting the record text and the rule (民國 N 年 = 西元 N+1911).
 *
 * Deterministic: the record's date is read with the shared parsers (ROC converted with +1911), never
 * guessed. One candidate → one suggestion (confidence 0.95); several → all of them, the ones written
 * under this field's label (出生日期 for birthDate …) first. The issue itself is unchanged (still an
 * error) and nothing is ever applied.
 */
import type { Suggestion } from "../fhirSuggestions/types.js";
import { nfkc } from "../grounding/lexicon.js";
import { dayKey, type RecDate, RecordValues } from "./recordValues.js";

const FHIR_DT = /^(\d{4})(?:-(\d{2})(?:-(\d{2})(T.*)?)?)?$/u;
const pad = (n: number): string => String(n).padStart(2, "0");
const clip = (s: string, n = 80): string => (s.length > n ? `${s.slice(0, n)}…` : s);

/** Labels that say which field a record date belongs to (for ordering several candidates). */
const FIELD_LABELS: Array<[RegExp, RegExp]> = [
  [/\.birthDate$/u, /(出生|生日|生於|dob|birth)/u],
  [/^Encounter\.period/u, /(就診|看診|門診|到院|入院|出院|visit|admi|arrival|discharge)/u],
  [/\.onset/u, /(發病|發作|起始|onset|開始)/u],
  [/(effective|issued|collected|Specimen)/u, /(採檢|採血|檢驗|檢查|報告|collect|lab|test)/u],
  [/(performed|Procedure)/u, /(手術|處置|operation|surgery|procedure)/u],
  [/occurrence/u, /(接種|vaccin|immuni)/u],
];

function isRocRaw(raw: string): boolean {
  if (/民國/u.test(raw)) return true;
  const m = /^\D*(\d+)/u.exec(raw);
  return !!m && m[1].length >= 2 && m[1].length <= 3;
}

/** How the value's year relates to the record's (the conversion mistake, when it is a known one). */
function mistake(vy: number, ry: number, roc: boolean): { zh: string; en: string } {
  const n = ry - 1911;
  if (roc && vy === n) return { zh: `把民國年 ${n} 直接當成西元年`, en: `the ROC year ${n} was written as the Gregorian year` };
  if (roc && vy === n + 1900) return { zh: `以 +1900 換算（${n}+1900=${vy}）`, en: `converted with +1900 (${n}+1900=${vy})` };
  if (roc && vy === n + 1912) return { zh: `以 +1912 換算（${n}+1912=${vy}）`, en: `converted with +1912 (${n}+1912=${vy})` };
  if (roc && vy === n + 1910) return { zh: `以 +1910 換算（${n}+1910=${vy}）`, en: `converted with +1910 (${n}+1910=${vy})` };
  const diff = vy - ry;
  return { zh: `年份差 ${diff > 0 ? "+" : ""}${diff} 年`, en: `the year is off by ${diff > 0 ? "+" : ""}${diff}` };
}

/** A year-only / year-month value is a conversion of the record year only through a known mistake. */
function knownOffset(vy: number, ry: number, roc: boolean): boolean {
  const n = ry - 1911;
  const offs = [vy - ry];
  return (roc && (vy === n || vy === n + 1900 || vy === n + 1912 || vy === n + 1910)) || offs.some((d) => d === 1 || d === -1 || d === 11 || d === -11);
}

/**
 * Suggestions for an ungrounded date value at `path` (element `gpath`, e.g. Patient.birthDate). Empty when
 * the record has no date with the same month / day (or, for a coarser value, no date of a known
 * conversion mistake).
 */
export function dateCorrections(value: string, path: string, gpath: string, rv: RecordValues): Suggestion[] {
  const m = FHIR_DT.exec(value.trim());
  if (!m) return [];
  const vy = Number(m[1]);
  const vm = m[2] ? Number(m[2]) : null;
  const vd = m[3] ? Number(m[3]) : null;
  const time = m[4] ?? "";
  const seen = new Map<string, { d: RecDate; fieldMatch: boolean }>();
  for (const d of rv.dates) {
    if (d.prec !== "day" || d.y === null || d.m === null || d.d === null) continue;
    const roc = isRocRaw(d.raw ?? "");
    let fixed: string;
    if (vm !== null && vd !== null) {
      if (d.m !== vm || d.d !== vd || d.y === vy) continue;
      fixed = `${dayKey(d.y, d.m, d.d)}${time}`;
    } else if (vm !== null) {
      if (d.m !== vm || d.y === vy || !knownOffset(vy, d.y, roc)) continue;
      fixed = `${d.y}-${pad(d.m)}`;
    } else {
      if (d.y === vy || !knownOffset(vy, d.y, roc)) continue;
      fixed = String(d.y);
    }
    const line = rv.lineText.get(d.li) ?? "";
    const lab = FIELD_LABELS.find(([g]) => g.test(gpath))?.[1];
    const fieldMatch = !!lab && (lab.test(line.slice(0, line.indexOf(d.raw ?? "\u0000") >= 0 ? line.indexOf(d.raw!) : line.length)) || (gpath.endsWith("birthDate") && !!d.birth));
    const prev = seen.get(fixed);
    if (!prev || (!prev.fieldMatch && fieldMatch)) seen.set(fixed, { d, fieldMatch });
  }
  const cands = [...seen.entries()].sort((a, b) => Number(b[1].fieldMatch) - Number(a[1].fieldMatch));
  const single = cands.length === 1;
  return cands.map(([fixed, { d, fieldMatch }]) => {
    const roc = isRocRaw(d.raw ?? "");
    const raw = nfkc(d.raw ?? "").trim();
    const quote = clip((rv.rt.lines[d.li]?.line ?? raw).trim());
    const n = d.y! - 1911;
    const mk = mistake(vy, d.y!, roc);
    const rule = roc
      ? `民國 N 年 = 西元 N+1911（${n}+1911=${d.y}） / ROC year N = Gregorian N+1911 (${n}+1911=${d.y})`
      : `the record states this month / day in Gregorian ${d.y}`;
    const reason =
      `病歷寫「${raw}」（${quote}）：${roc ? `民國 ${n} 年 = 西元 ${n}+1911 = ${d.y} 年` : `西元 ${d.y} 年`}，正確值為 ${fixed}；目前的值「${value}」${mk.zh}。` +
      ` / The record says "${raw}" ("${quote}"): ${roc ? `ROC year ${n} = Gregorian ${n}+1911 = ${d.y}` : `Gregorian ${d.y}`}, so the value is ${fixed}; "${value}" — ${mk.en}. Rule: ${rule}` +
      (single ? "" : " (one of several record dates with this month / day — choose the one that belongs to this element)");
    return {
      value: fixed,
      kind: "replace_value",
      confidence: single ? 0.95 : fieldMatch ? 0.7 : 0.5,
      reason,
      patch: { op: "replace", path, value: fixed },
    } satisfies Suggestion;
  });
}
