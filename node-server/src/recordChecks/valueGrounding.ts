/**
 * Value grounding (ISSUES_v15.1 R1 / R2 / R4) — needs source_text.
 *
 * Every Identifier.value, date / dateTime / instant and Quantity.value in the instance must be found in
 * the record (or, for identifiers, the site configuration): verbatim or normalised (recordValues.ts:
 * ROC → Gregorian, full-width → half-width, separators, Chinese numerals, units converted) or by an
 * explicit derivation (relative dates anchored on a record date, durations, ages, BMI from weight and
 * height, a dose × count product on one line). Not found → error `ungrounded-value` ("病歷中找不到這個
 * 值"), with the forms tried and the nearest record candidates as evidence. A dateTime whose date is in
 * the record but whose time is not (the typical record date + T00:00:00) is ungrounded too; a
 * date-only value matching a record date is fine.
 *
 * Also here (they need the same index):
 *  - R1 identifier with a system but no value: `information-absent` when the record has no such
 *    number, `incomplete-value` when it has one (the value was left out).
 *  - R1 stated absence: the record writes the field label with an absence statement (病歷號：申請中,
 *    採檢日期：無法辨識, 血糖：機器錯誤，未得數值) and the Bundle has a value for that field —
 *    `information-absent` when the value is not in the record, `value-from-other-event` when it is (it
 *    was taken from another event, e.g. the visit date used as the specimen date).
 *  - R4 another time point: an Observation value that the record states only for another measurement
 *    time (two readings, the one at the Observation's time failed) — error when the record says that
 *    reading failed, warning when the reading is merely different. Only when the times decide it.
 *
 * Exempt: record-keeping timestamps written by the tools (Bundle.timestamp, Composition.date,
 * Provenance.recorded, DocumentReference.date) — never checked; other record-keeping times
 * (authoredOn, recordedDate, issued …) get a warning for an ungrounded date and no time check;
 * derived quantities (dispense quantity, supply duration, Claim item quantity) and reference ranges get
 * a warning; denominators and system-generated identifiers (urn:uuid, Bundle / Composition identifier)
 * are not checked.
 */
import { CONVERT, canonUnit, HIST_CUES, nfkc, unitsCompatible, VITAL_LABELS } from "../grounding/lexicon.js";
import { EVENT_TIMES } from "./recordAware.js";
import { absenceOf, ABSENT_LABELS } from "./lexicon.js";
import { makeIssue } from "./issue.js";
import type { Suggestion } from "../fhirSuggestions/types.js";
import { parseDatesPos } from "../grounding/lexicon.js";
import { dateCorrections } from "./dateSuggestions.js";
import { TW_LEXICON_DATA } from "../grounding/twLexiconData.js";
import { dayKey, idNorm, monthKey, RecordValues, type RecNumber } from "./recordValues.js";
import { resourcesOf, type Slot } from "./slots.js";
import type { RecordIssue } from "./types.js";

type Json = Record<string, any>;
const isObj = (x: unknown): x is Json => !!x && typeof x === "object" && !Array.isArray(x);
const clip = (s: string, n = 80): string => (s.length > n ? `${s.slice(0, n)}…` : s);
const pad = (n: number): string => String(n).padStart(2, "0");

/** Timestamps the tools / the document write themselves: never record facts. */
const SYSTEM_TIMES: ReadonlySet<string> = new Set([
  "Bundle.timestamp",
  "Composition.date",
  "Composition.attester.time",
  "Provenance.recorded",
  "Provenance.occurredDateTime",
  "DocumentReference.date",
  "AuditEvent.recorded",
  "Claim.created",
  "ClaimResponse.created",
]);
/** Record-keeping times: an ungrounded date is a warning; the time of day is not checked. */
const ADMIN_TIMES: ReadonlySet<string> = new Set([
  "MedicationRequest.authoredOn",
  "Condition.recordedDate",
  "AllergyIntolerance.recordedDate",
  "MedicationStatement.dateAsserted",
  "Observation.issued",
  "DiagnosticReport.issued",
  "Immunization.recorded",
  "MedicationDispense.whenPrepared",
  "ServiceRequest.authoredOn",
  "CarePlan.created",
  "Consent.dateTime",
  "Composition.event.period.start",
]);
const RE_DERIVED_QTY = /(dispenseRequest\.quantity|expectedSupplyDuration|dispenseRequest\.initialFill\.quantity|Claim\.item\.quantity|MedicationDispense\.quantity|MedicationDispense\.daysSupply|Encounter\.length|\.net$|\.unitPrice$)/u;
const RE_SKIP_QTY = /(\.denominator$|\.repeat\.|\.boundsDuration|Claim\.total|Coverage\.)/u;
const RE_RANGE_QTY = /\.referenceRange\./u;
/** Identifiers the submitting system / document assigns (document id, PAS application number), not record facts. */
const RE_SYSTEM_ID = /^(Bundle|Composition|DocumentReference|Provenance|AuditEvent|Claim|ClaimResponse|OperationOutcome|Task)\.identifier/u;
/** Elements whose date must be STATED in the record (relative derivations anchor on them, they do not come from them). */
const STATED_ONLY: ReadonlySet<string> = new Set(["Encounter.period.start", "Patient.birthDate"]);
const RE_UUID = /^(urn:(uuid|oid):)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const FHIR_DT = /^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?)?)?$/u;

// ------------------------------------------------------------------------------------------- helpers

interface ParsedDt {
  y: number;
  m: number | null;
  d: number | null;
  hh: number | null;
  mi: number | null;
  ss: number | null;
  tz: string | null;
}

function parseDt(v: string): ParsedDt | null {
  const m = FHIR_DT.exec(v.trim());
  if (!m) return null;
  const n = (x: string | undefined): number | null => (x === undefined ? null : parseInt(x, 10));
  return { y: Number(m[1]), m: n(m[2]), d: n(m[3]), hh: n(m[4]), mi: n(m[5]), ss: n(m[6]), tz: m[7] ?? null };
}

/** Offset in minutes of "+08:00" / "Z"; null when unparseable. */
function tzMinutes(tz: string): number | null {
  if (tz === "Z") return 0;
  const m = /^([+-])(\d{2}):(\d{2})$/u.exec(tz);
  return m ? (m[1] === "+" ? 1 : -1) * (parseInt(m[2], 10) * 60 + parseInt(m[3], 10)) : null;
}

/** The site timezone from site_config (`timezone: +08:00`, `時區：Asia/Taipei`); Taiwan (+08:00) by default. */
export function siteOffset(siteConfig: string | null): number {
  const m = /(?:timezone|time zone|時區)\s*[:：=]\s*([+-]\d{2}:\d{2}|z|utc|gmt|asia\/taipei)/iu.exec(siteConfig ?? "");
  if (!m) return 480;
  const v = m[1].toLowerCase();
  if (v === "z" || v === "utc" || v === "gmt") return 0;
  if (v === "asia/taipei") return 480;
  return tzMinutes(m[1]) ?? 480;
}

/** Local (site) wall-clock date-time of a value written in another offset. */
function toSite(p: ParsedDt, site: number): ParsedDt | null {
  if (p.hh === null || p.tz === null || p.m === null || p.d === null) return null;
  const off = tzMinutes(p.tz);
  if (off === null || off === site) return null;
  const t = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mi ?? 0) + (site - off) * 60000;
  const d = new Date(t);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), hh: d.getUTCHours(), mi: d.getUTCMinutes(), ss: p.ss, tz: null };
}

const same = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9 || Math.abs(a - b) <= 1e-6 * Math.max(Math.abs(a), Math.abs(b));
/** `b` is `a` rounded to the decimals `b` is written with (a conversion 99.5 °F → 37.5 °C, 1.70 m → 170 cm). */
function closeRounded(a: number, b: number): boolean {
  const dec = Math.min((String(b).split(".")[1] ?? "").length, 6);
  return Math.abs(a - b) <= 0.5 * 10 ** -dec + 1e-9;
}

/** Dimension + factor to a base unit, for conversions between equivalent units. */
const DIM: Record<string, [string, number]> = {
  kg: ["mass", 1000], g: ["mass", 1], mg: ["mass", 1e-3], ug: ["mass", 1e-6], ng: ["mass", 1e-9],
  l: ["vol", 1000], dl: ["vol", 100], ml: ["vol", 1], ul: ["vol", 1e-3],
  m: ["len", 100], cm: ["len", 1], mm: ["len", 0.1],
  d: ["time", 1440], h: ["time", 60], min: ["time", 1], s: ["time", 1 / 60], wk: ["time", 10080], mo: ["time", 43200], a: ["time", 525600],
  "mg/dl": ["conc", 1], "g/dl": ["conc", 1000], "g/l": ["conc", 100], "mg/l": ["conc", 0.1],
};

function unitOf(q: Json): string | null {
  const u = typeof q.code === "string" && q.code ? q.code : typeof q.unit === "string" ? q.unit : null;
  return u ? canonUnit(u) : null;
}

/** Record number n (unit nu) expressed in unit vu, every reading the tables allow. */
function conversions(n: number, nu: string | null, vu: string | null): number[] {
  if (nu === null || vu === null || nu === vu) return [];
  const out: number[] = [];
  const f = CONVERT.get(`${nu}|${vu}`);
  if (f) out.push(n * f);
  const a = DIM[nu];
  const b = DIM[vu];
  if (a && b && a[0] === b[0]) out.push((n * a[1]) / b[1]);
  if (nu === "cel" && /^(\[degf\]|degf|°f|f)$/u.test(vu)) out.push((n * 9) / 5 + 32);
  if (/^(\[degf\]|degf|°f|f)$/u.test(nu) && vu === "cel") out.push(((n - 32) * 5) / 9);
  // counts per volume written with an exponent (12.3 x10^3/uL = 12300 /uL)
  const ex = /^10\*(\d+)\/ul$/u.exec(nu);
  if (ex && /^\/(ul|mm3)$/u.test(vu)) out.push(n * 10 ** Number(ex[1]));
  const ev = /^10\*(\d+)\/ul$/u.exec(vu);
  if (ev && /^\/(ul|mm3)$/u.test(nu)) out.push(n / 10 ** Number(ev[1]));
  // glucose mg/dL <-> mmol/L
  if (nu === "mg/dl" && vu === "mmol/l") out.push(n / 18, n / 18.016);
  if (nu === "mmol/l" && vu === "mg/dl") out.push(n * 18, n * 18.016);
  return out;
}

function codeLabels(cc: unknown): string[] {
  const out: string[] = [];
  if (!isObj(cc)) return out;
  if (typeof cc.text === "string") out.push(cc.text);
  for (const c of Array.isArray(cc.coding) ? cc.coding : []) {
    if (!isObj(c)) continue;
    if (typeof c.display === "string") out.push(c.display);
    for (const l of (VITAL_LABELS as Record<string, string[]>)[String(c.code ?? "")] ?? []) if (l.length >= 2) out.push(l);
  }
  return [...new Set(out.map((x) => nfkc(x).trim()).filter((x) => x.length >= 2))];
}

function obsLabels(s: Slot): string[] {
  const res = s.resource;
  const m = /\.component\[(\d+)\]/u.exec(s.path);
  if (m && Array.isArray(res.component)) return codeLabels(res.component[Number(m[1])]?.code);
  return codeLabels(res.code);
}

const isBmi = (s: Slot): boolean =>
  s.resource.resourceType === "Observation" &&
  (JSON.stringify(s.resource.code ?? {}).includes("39156-5") || /\bbmi\b|body mass index|身體質量指數/iu.test(codeLabels(s.resource.code).join(" ")));

// ------------------------------------------------------------------------------------------- stated absences

interface Stamp {
  times: Set<string>;
  days: Set<string>;
}

interface StatedAbsent {
  family: string;
  label: string;
  line: string;
  li: number;
  /** Time / date written with the absence statement (08:00 血糖：機器錯誤 → 8:00). */
  stamp: Stamp;
}

/**
 * Fields of an NFKC line: split at punctuation, and at a space before the next "label:" once the text
 * before it already holds a field (the ideographic space of 「姓名：王　性別：男」 is a plain space by then;
 * "Collection date: illegible" stays one field).
 */
function splitFields(t: string): string[] {
  const out: string[] = [];
  for (const part of t.split(/[，,；;|│]/u)) {
    let rest = part;
    for (;;) {
      const colon = rest.search(/[:：]/u);
      if (colon < 0) break;
      // the next label: up to three words, not starting with a digit (14:30 is a time, not a label)
      const re = /\s+(?=(?:[^\s:：\d][^\s:：]{0,15}\s){0,2}[^\s:：\d][^\s:：]{0,15}\s*[:：])/gu;
      re.lastIndex = colon + 1;
      const m = re.exec(rest);
      if (!m) break;
      out.push(rest.slice(0, m.index));
      rest = rest.slice(m.index + m[0].length);
    }
    out.push(rest);
  }
  return out;
}
const RE_FIELD = /^\s*([^:：]{1,16}?)\s*[:：]\s*(.*)$/u;
/** A date / time written before a field label ("08:00 血糖：…", "3/14 採檢：…") is the line's stamp, not the label. */
const RE_STAMP_PREFIX = /^\s*(?:\d{2,4}[/.-]\d{1,2}(?:[/.-]\d{1,2})?\s*)?(?:\d{1,2}[:：]\d{2}(?:[:：]\d{2})?)?\s*/u;
const RE_LABEL_QUALIFIER = /(日期|時間|號碼|字號|編號|號|date|time|no\.?|number|#)$/u;
const labelCore = (x: string): string => x.trim().replace(RE_LABEL_QUALIFIER, "").trim();

/** Family of a field label: the WHOLE label (minus a 日期 / 時間 / 號碼 qualifier) is a known label — 出生地 is not 出生. */
function labelFamily(label: string): string | null {
  for (const [l, fam] of ABSENT_LABELS) if (label === l) return fam;
  const core = labelCore(label);
  for (const [l, fam] of ABSENT_LABELS) if (core === labelCore(l)) return fam;
  return null;
}

/** Times / days written in a text (h:mm; y-mm-dd and month-day mm-dd keys). */
function stampOf(text: string): Stamp {
  const times = new Set<string>();
  const days = new Set<string>();
  for (const m of text.matchAll(/(?<!\d)([01]?\d|2[0-3])\s*[:：]\s*([0-5]\d)(?!\d)/gu)) times.add(`${parseInt(m[1], 10)}:${m[2]}`);
  for (const pd of parseDatesPos(text)) {
    const [prec, [y, mo, d]] = pd.date;
    if (prec === "day") {
      days.add(dayKey(y!, mo!, d!));
      days.add(`${pad(mo!)}-${pad(d!)}`);
    } else if (prec === "md") days.add(`${pad(mo!)}-${pad(d!)}`);
  }
  return { times, days };
}

const ID_FAMILIES = new Set(["mrn", "national_id", "resident_id", "passport", "nhi_card", "encounter_id"]);

function statedAbsences(rv: RecordValues): { absent: StatedAbsent[]; positive: Set<string>; obsAbsent: StatedAbsent[]; idFields: Map<string, Set<string>> } {
  const absent: StatedAbsent[] = [];
  const obsAbsent: StatedAbsent[] = [];
  const positive = new Set<string>();
  /** Identifier values the record writes after an identifier label: normalised value → families of those labels. */
  const idFields = new Map<string, Set<string>>();
  for (const [li, t] of rv.lineText) {
    if (rv.rt.lines[li]?.section === "family_history") continue;
    const fields = splitFields(t);
    const line = clip(rv.rt.lines[li].line.trim());
    for (let k = 0; k < fields.length; k++) {
      let m = RE_FIELD.exec(fields[k].replace(RE_STAMP_PREFIX, ""));
      if (!m) {
        // a measurement written without a colon: 「白血球 檢體溶血、未發報告」, "BT not measured"
        const c = fields[k].replace(RE_STAMP_PREFIX, "").trim();
        for (const sp of c.matchAll(/\s+/gu)) {
          const label = c.slice(0, sp.index).trim();
          const rest = c.slice(sp.index! + sp[0].length).trim();
          if (label.length > 16 || /^[\d\s:：/.-]*$/u.test(label) || labelFamily(label)) break;
          if (rest && absenceOf(rest, true)) {
            obsAbsent.push({ family: "observation", label, line, li, stamp: stampOf(fields[k]) });
            break;
          }
        }
        continue;
      }
      if (/^[\d\s:：/.-]*$/u.test(m[1])) continue;
      // a section label before the field label (生命徵象：體溫：未測量): the innermost label names the field
      for (let inner = RE_FIELD.exec(m[2]); inner && !/^[\d\s:：/.-]*$/u.test(inner[1]); inner = RE_FIELD.exec(m[2])) m = inner;
      const label = m[1].trim();
      // the value of a field runs to the next field label (病歷號：申請中，身分證：A1… → 申請中)
      const pieces: Array<[string, string]> = [[fields[k], m[2]]];
      for (let j = k + 1; j < fields.length && !RE_FIELD.test(fields[j].replace(RE_STAMP_PREFIX, "")); j++) pieces.push([fields[j], fields[j]]);
      const value = pieces.map(([, v]) => v.trim()).filter(Boolean).join("，");
      const fam = labelFamily(label);
      if (fam) {
        if (value && absenceOf(value, true)) absent.push({ family: fam, label, line, li, stamp: stampOf(fields[k]) });
        else if (value) {
          positive.add(fam);
          if (ID_FAMILIES.has(fam)) {
            const tok = /^[a-z0-9][a-z0-9\-_./ ]*[a-z0-9]/u.exec(value)?.[0];
            if (tok) idFields.set(idNorm(tok), new Set([...(idFields.get(idNorm(tok)) ?? []), fam]));
          }
        }
        continue;
      }
      // a measurement: each clause of its value may be one reading (07:00 機器錯誤，未得數值；11:00 142 mg/dL)
      for (const [raw, v] of pieces) {
        const core = v.replace(RE_STAMP_PREFIX, "").trim();
        if (!core) continue;
        if (absenceOf(core, true)) {
          obsAbsent.push({ family: "observation", label, line, li, stamp: stampOf(raw) });
          continue;
        }
        // 「檢驗：白血球 檢體溶血、未發報告」: the item named before the absence statement
        for (const sp of core.matchAll(/\s+/gu)) {
          const inner = core.slice(0, sp.index).trim();
          const rest = core.slice(sp.index! + sp[0].length).trim();
          if (inner.length > 16 || /^[\d\s:：/.-]*$/u.test(inner)) break;
          if (rest && absenceOf(rest, true)) {
            obsAbsent.push({ family: "observation", label: inner, line, li, stamp: stampOf(raw) });
            break;
          }
        }
      }
    }
  }
  return { absent, positive, obsAbsent, idFields };
}

const ID_FAMILY_SYSTEMS: Array<[RegExp, string]> = [
  [/^http:\/\/www\.moi\.gov\.tw/u, "national_id"],
  [/^http:\/\/www\.immigration\.gov\.tw/u, "resident_id"],
  [/passport/iu, "passport"],
  [/(mrn|chart|medical-?record|病歷)/iu, "mrn"],
  [/(nhi|健保)/iu, "nhi_card"],
];

function idFamily(holder: Json | null, resourceType?: string): string | null {
  if (!holder) return null;
  if (resourceType === "Encounter" || resourceType === "EpisodeOfCare") return "encounter_id";
  const sys = typeof holder.system === "string" ? holder.system : "";
  const types = isObj(holder.type) && Array.isArray(holder.type.coding) ? holder.type.coding.map((c: Json) => String(c?.code ?? "")) : [];
  if (types.includes("MR")) return "mrn";
  if (types.includes("NI") || types.includes("NNxxx") || types.includes("NNTWN")) return "national_id";
  if (types.includes("PPN")) return "passport";
  for (const [rx, fam] of ID_FAMILY_SYSTEMS) if (rx.test(sys)) return fam;
  return null;
}

const DATE_FAMILY_PATHS: Record<string, RegExp> = {
  birth: /^(Patient|Practitioner|RelatedPerson)\.birthDate$/u,
  visit: /^Encounter\.period\.start$/u,
  discharge: /^Encounter\.period\.end$/u,
  collection: /^(Specimen\.collection\.collected(DateTime|Period\.start)|Specimen\.receivedTime|DiagnosticReport\.effective(DateTime|Period\.start)|Observation\.effective(DateTime|Period\.start|Instant))$/u,
  test_date: /^(DiagnosticReport\.effective(DateTime|Period\.start)|Observation\.effective(DateTime|Period\.start|Instant))$/u,
  onset: /^(Condition|AllergyIntolerance)\.onset(DateTime|Period\.start)$/u,
  order_date: /^MedicationRequest\.authoredOn$/u,
  vaccination_date: /^Immunization\.occurrenceDateTime$/u,
  procedure_date: /^Procedure\.performed(DateTime|Period\.start)$/u,
};

function isVitalObservation(res: Json): boolean {
  return JSON.stringify(res.category ?? []).includes("vital-signs");
}

const FAMILY_ZH: Record<string, string> = { mrn: "病歷號", national_id: "身分證字號", resident_id: "居留證號", passport: "護照號碼", nhi_card: "健保卡號", encounter_id: "住院號／就診號" };
const FAMILY_EN: Record<string, string> = { mrn: "medical record number", national_id: "national ID", resident_id: "resident certificate number", passport: "passport number", nhi_card: "NHI card number", encounter_id: "admission / visit number" };

const ID_LABELS_BY_FAMILY: Record<string, string[]> = {
  mrn: ["病歷號碼", "病歷號", "病歷編號", "mrn", "chart no", "chart number"],
  national_id: ["身分證字號", "身分證號", "身分證", "身份證字號", "身份證", "national id", "id no"],
  resident_id: ["居留證號", "居留證", "統一證號"],
  passport: ["護照號碼", "護照", "passport"],
  nhi_card: ["健保卡號", "健保卡"],
};

// ------------------------------------------------------------------------------------------- the checks

export interface GroundingContext {
  rv: RecordValues;
  siteConfig: string | null;
  stated: ReturnType<typeof statedAbsences>;
}

function evidenceNumbers(rv: RecordValues, labels: string[]): string[] {
  const out: string[] = [];
  for (const [li, t] of rv.lineText) {
    if (!labels.some((l) => t.includes(l))) continue;
    for (const n of rv.numbers) if (n.li === li) out.push(`${n.raw}`);
  }
  return [...new Set(out)].slice(0, 5);
}

/** Canonical units the lexicons know; any other spelling (u[IU]/mL, {cells}/uL …) is never compared. */
const KNOWN_UNITS = new Set<string>([...Object.keys(TW_LEXICON_DATA.numbers.unitAliases), ...Object.keys(DIM)]);

/** Whether a record number's unit can denote a value in unit `vu` (unknown units are not compared). */
function unitFits(nu: string | null, vu: string | null): boolean {
  if (nu === null || vu === null || !KNOWN_UNITS.has(nu) || !KNOWN_UNITS.has(vu)) return true;
  if (unitsCompatible(nu, vu)) return true;
  const a = DIM[nu];
  const b = DIM[vu];
  return !!a && !!b && a[0] === b[0];
}

function numberGrounded(rv: RecordValues, v: number, vu: string | null, allowProduct: boolean, bmi: boolean): { how: string; n: RecNumber | null } | null {
  for (const n of rv.numbers) if (same(n.value, v) && unitFits(n.unit, vu)) return { how: `stated as '${n.raw}'`, n };
  for (const n of rv.numbers) for (const c of conversions(n.value, n.unit, vu)) if (same(c, v) || closeRounded(c, v)) return { how: `converted from '${n.raw}' (${n.unit} → ${vu})`, n };
  if (bmi) {
    const w = rv.numbers.filter((n) => n.unit === "kg");
    const h = rv.numbers.filter((n) => n.unit === "cm" || n.unit === "m");
    for (const a of w) for (const b of h) {
      const hm = b.unit === "cm" ? b.value / 100 : b.value;
      if (hm > 0.3 && Math.abs(a.value / (hm * hm) - v) <= 0.15) return { how: `derived: BMI from '${a.raw}' and '${b.raw}'`, n: null };
    }
  }
  if (allowProduct) {
    // derived quantities only (dispense quantity, supply duration): a product of numbers written on one line
    const byLine = new Map<number, RecNumber[]>();
    for (const n of rv.numbers) byLine.set(n.li, [...(byLine.get(n.li) ?? []), n]);
    for (const ns of byLine.values()) {
      for (let i = 0; i < ns.length; i++) for (let j = i + 1; j < ns.length; j++) {
        if (same(ns[i].value * ns[j].value, v)) return { how: `derived: '${ns[i].raw}' × '${ns[j].raw}'`, n: null };
        for (let k = j + 1; k < ns.length; k++) if (same(ns[i].value * ns[j].value * ns[k].value, v)) return { how: `derived: '${ns[i].raw}' × '${ns[j].raw}' × '${ns[k].raw}'`, n: null };
      }
    }
  }
  return null;
}

function checkIdentifier(s: Slot, g: GroundingContext, stated: ReturnType<typeof statedAbsences>): RecordIssue | null {
  if (s.kind !== "identifier" || RE_SYSTEM_ID.test(s.gpath)) return null;
  const holder = s.holder;
  const system = holder && typeof holder.system === "string" ? holder.system : null;
  if (system === "urn:ietf:rfc:3986") return null;
  const fam = s.gpath.endsWith(".identifier.value") && s.gpath.split(".").length === 3 ? idFamily(holder, s.resource.resourceType) : idFamily(holder);
  const v = typeof s.value === "string" ? s.value.trim() : s.value === undefined || s.value === null ? "" : String(s.value);
  if (!v) {
    // R1 (ISSUES_v15.1 R2): an identifier with a system / type but no value
    if (!holder || (!system && !isObj(holder.type))) return null;
    const cands = fam === "national_id" ? [...g.rv.lineText.values()].flatMap((t) => t.toUpperCase().match(/(?<![A-Z0-9])[A-Z][12]\d{8}(?![0-9])/gu) ?? [])
      : fam === "resident_id" ? [...g.rv.lineText.values()].flatMap((t) => t.toUpperCase().match(/(?<![A-Z0-9])[A-Z][89A-D]\d{8}(?![0-9])/gu) ?? [])
      : fam ? g.rv.identifierNear(ID_LABELS_BY_FAMILY[fam] ?? []) : [];
    const path = s.path.endsWith(".value") ? s.path : `${s.path}.value`;
    if (cands.length) {
      return makeIssue(
        "R1", "error", "incomplete-value", path,
        `識別碼不完整：有 system${system ? ` ${system}` : ""} 但沒有 value；病歷有這個號碼 ${cands.slice(0, 2).map((c) => `'${c}'`).join("、")}——請填入 value`,
        `Incomplete identifier: it has a system${system ? ` ${system}` : ""} but no value; the record states ${cands.slice(0, 2).map((c) => `'${c}'`).join(", ")} — fill in the value`,
        `R1 identifier without value; searched the record for a ${fam ?? "matching"} number (${fam === "national_id" || fam === "resident_id" ? "ID format" : "after the field label"}): found ${cands.length}`,
      );
    }
    return makeIssue(
      "R1", "error", "information-absent", path,
      `病歷沒有提供這項資訊：識別碼有 system${system ? ` ${system}` : ""} 但沒有 value，而病歷中也找不到這個號碼。不要輸出沒有值的識別碼；若任務需要它，請回報 insufficient_information`,
      `The record does not provide this information: the identifier has a system${system ? ` ${system}` : ""} but no value, and the record does not state such a number. Do not output an identifier without a value; if the task needs it, report insufficient_information`,
      `R1 identifier without value; searched the record for a ${fam ?? "matching"} number (${fam === "national_id" || fam === "resident_id" ? "by its ID format" : fam ? "after the field label" : "no family known for this system"}): found none`,
    );
  }
  if (RE_UUID.test(v) || /^urn:/iu.test(v)) return null;
  const inRecord = g.rv.hasIdentifier(v);
  const sa = fam ? stated.absent.find((a) => a.family === fam) : undefined;
  if (sa && !stated.positive.has(fam!)) {
    return makeIssue(
      "R1", "error", inRecord ? "value-from-other-event" : "information-absent", s.path,
      inRecord
        ? `病歷明說這項資訊沒有提供（「${sa.line}」），值「${clip(v, 40)}」雖出現在病歷中，但屬於其他欄位或事件。若任務需要這項資訊，請回報 insufficient_information`
        : `病歷沒有提供這項資訊：病歷寫「${sa.line}」，值「${clip(v, 40)}」在病歷中找不到。不要自行編號；若任務需要它，請回報 insufficient_information`,
      inRecord
        ? `The record says this information is not available ("${sa.line}"); the value "${clip(v, 40)}" occurs in the record but belongs to another field / event. If the task needs it, report insufficient_information`
        : `The record does not provide this information: it says "${sa.line}", and the value "${clip(v, 40)}" is not in the record. Do not make up a number; if the task needs it, report insufficient_information`,
      `R1 stated absence: field label '${sa.label}' (${fam}) is written with an absence statement and no other line gives it a value; identifier value ${inRecord ? "found" : "not found"} in the record / site_config`,
      [sa.line],
    );
  }
  if (inRecord) {
    // R4: the number is in the record, but after the label of ANOTHER identifier (the 住院號 written as the 病歷號)
    const fams = g.stated.idFields.get(idNorm(v));
    if (fam && fams && !fams.has(fam)) {
      const other = [...fams][0];
      return makeIssue(
        "R5", "error", "value-from-other-event", s.path,
        `這個值在病歷中屬於另一個欄位：「${clip(v, 40)}」在病歷中是${FAMILY_ZH[other] ?? other}，不是${FAMILY_ZH[fam] ?? fam}。不要用其他號碼代替；病歷若沒有${FAMILY_ZH[fam] ?? fam}，請回報 insufficient_information`,
        `This value belongs to another field in the record: "${clip(v, 40)}" is the record's ${FAMILY_EN[other] ?? other}, not its ${FAMILY_EN[fam] ?? fam}. Do not substitute another number; if the record gives no ${FAMILY_EN[fam] ?? fam}, report insufficient_information`,
        `R4 field of origin: the value occurs in the record after a '${other}' label only; this identifier is a '${fam}' (by its type / system / resource)`,
      );
    }
    return null;
  }
  return makeIssue(
    "R5", "error", "ungrounded-value", s.path,
    `病歷中找不到這個值：識別碼「${clip(v, 40)}」不在病歷或 site_config 中（已比對大小寫、全形／半形、分隔符號與前導 0）。不要自行編號；若任務需要它而病歷沒有，請回報 insufficient_information`,
    `This value is not in the record: the identifier "${clip(v, 40)}" occurs neither in the record nor in site_config (compared case-insensitively, full-/half-width, without separators and leading zeros). Do not make up a number; if the record does not give it, report insufficient_information`,
    `R5 identifier grounding: normalised value '${clip(v.replace(/\s+/gu, ""), 40)}' searched in ${g.rv.lineText.size} record line(s) (instruction lines excluded) and the site configuration, as whole tokens / separator pieces / with a label prefix; found none`,
  );
}

function checkDate(s: Slot, g: GroundingContext, stated: ReturnType<typeof statedAbsences>): RecordIssue | null {
  if (s.kind !== "date" || typeof s.value !== "string" || SYSTEM_TIMES.has(s.gpath)) return null;
  const p = parseDt(s.value);
  if (!p) return null;
  const rv = g.rv;
  const admin = ADMIN_TIMES.has(s.gpath);
  const site = siteOffset(g.siteConfig);
  const local = toSite(p, site);
  const forms = [p, ...(local ? [local] : [])];
  const dateState = (q: ParsedDt): "stated" | "derived" | null => {
    if (q.d !== null && q.m !== null) {
      const k = dayKey(q.y, q.m, q.d);
      return rv.days.has(k) ? "stated" : rv.derivedDays.has(k) && !STATED_ONLY.has(s.gpath) ? "derived" : null;
    }
    if (q.m !== null) {
      const k = monthKey(q.y, q.m);
      return rv.months.has(k) ? "stated" : rv.derivedMonths.has(k) ? "derived" : null;
    }
    return rv.years.has(q.y) ? "stated" : rv.derivedYears.has(q.y) ? "derived" : null;
  };
  const dateForm = forms.find((q) => dateState(q) !== null) ?? null;
  // R1 / R4: the record states this field as not available
  for (const [fam, rx] of Object.entries(DATE_FAMILY_PATHS)) {
    if (!rx.test(s.gpath) || stated.positive.has(fam)) continue;
    if ((fam === "collection" || fam === "test_date") && s.resource.resourceType === "Observation" && isVitalObservation(s.resource)) continue;
    const sa = stated.absent.find((a) => a.family === fam);
    if (!sa) continue;
    const found = dateForm !== null;
    return makeIssue(
      "R1", "error", found ? "value-from-other-event" : "information-absent", s.path,
      found
        ? `這個值在病歷中屬於另一個時間點：病歷明說這個日期沒有提供（「${sa.line}」），值「${s.value}」是病歷中其他事件的日期（例如就診日）。不要用其他事件的日期代替；若任務需要它，請回報 insufficient_information`
        : `病歷沒有提供這項資訊：病歷寫「${sa.line}」，值「${s.value}」在病歷中找不到。若任務需要它，請回報 insufficient_information`,
      found
        ? `This value belongs to another time point in the record: the record says this date is not available ("${sa.line}"), and "${s.value}" is the date of another event in the record (e.g. the visit). Do not substitute another event's date; if the task needs it, report insufficient_information`
        : `The record does not provide this information: it says "${sa.line}", and "${s.value}" is not in the record. If the task needs it, report insufficient_information`,
      `R1 stated absence: field label '${sa.label}' (${fam}) is written with an absence statement and no other line gives it a value; ${s.gpath} is that field; the value's date ${found ? "is" : "is not"} stated elsewhere in the record`,
      [sa.line],
    );
  }
  const tried = forms.map((q) => (q.d !== null ? dayKey(q.y, q.m!, q.d) : q.m !== null ? monthKey(q.y, q.m) : String(q.y)));
  const formsNote = `normalised forms tried: ${[...new Set(tried)].join(", ")} (record dates read as western, ROC 民國, 年月日, slashes and month-day; relative expressions such as 入院第N天 / POD#N / N天前 / 隔天 resolved on the record's dates)`;
  if (!dateForm) {
    const near = p.m !== null && p.d !== null ? rv.nearestDays(p.y, p.m, p.d) : [...rv.days.keys()].slice(0, 3);
    const issue = makeIssue(
      "R5", admin ? "warning" : "error", "ungrounded-value", s.path,
      `病歷中找不到這個值：日期「${s.value}」不在病歷中，也無法由病歷的日期推得（如「入院第3天」+入院日）。${near.length ? `病歷中的日期：${near.join("、")}。` : "病歷沒有任何日期。"}不要自行填日期；若任務需要它而病歷沒有，請回報 insufficient_information`,
      `This value is not in the record: the date "${s.value}" is neither stated in the record nor derivable from its dates (e.g. "hospital day 3" + the admission date).${near.length ? ` Record dates: ${near.join(", ")}.` : " The record states no date."} Do not make up a date; if the record does not give it, report insufficient_information`,
      `R5 date grounding: ${formsNote}; nearest record candidates: ${near.join(", ") || "none"}${admin ? "; record-keeping timestamp, so a warning" : ""}`,
    );
    return withDateCorrections(issue, s.value, s.path, s.gpath, rv);
  }
  // R4: the date is in the record, but only as a past event (上次 / 曾 / previous …) or as the birth date
  if (!admin && EVENT_TIMES.has(s.gpath) && dateForm.d !== null && dateState(dateForm) === "stated") {
    const k = dayKey(dateForm.y, dateForm.m!, dateForm.d);
    const occ = rv.dates.filter((d) => d.prec === "day" && dayKey(d.y!, d.m!, d.d!) === k);
    const past = (d: (typeof occ)[number]): boolean => !!d.birth || HIST_CUES.some((c) => rv.clauseText(d.li, d.ci).includes(nfkc(c)));
    if (occ.length && occ.every(past)) {
      const line = clip(rv.rt.lines[occ[0].li].line.trim());
      return makeIssue(
        "R5", "error", "value-from-other-event", s.path,
        `這個值在病歷中屬於另一個時間點：日期「${s.value}」在病歷中是${occ[0].birth ? "出生日期" : "過去的事件"}（「${line}」），不是這筆資料的時間。不要用其他事件的日期代替；若病歷沒有這次的日期，請回報 insufficient_information`,
        `This value belongs to another time point in the record: the date "${s.value}" is ${occ[0].birth ? "the birth date" : "a past event"} there ("${line}"), not the time of this entry. Do not substitute another event's date; if the record gives no date for this one, report insufficient_information`,
        `R4 time point: every record occurrence of ${k} is ${occ[0].birth ? "labelled as a birth date" : "in a clause with a history cue (上次 / 曾 / 之前 / previous …)"}; ${s.gpath} is a current-event time`,
        [line],
      );
    }
  }
  if (admin || p.hh === null) return null;
  const timeOk = (q: ParsedDt): boolean => {
    const k = `${q.hh}:${pad(q.mi!)}`;
    if (!rv.timeKeys.has(k) && !rv.derivedTimes.has(k)) return false;
    if (q.ss !== null && q.ss !== 0 && !rv.timeKeys.has(`${k}:${pad(q.ss)}`)) return false;
    return true;
  };
  if (forms.some(timeOk)) return null;
  const midnight = p.hh === 0 && p.mi === 0 && (p.ss ?? 0) === 0;
  const times = [...new Set(rv.times.map((t) => `${pad(t.h)}:${pad(t.mi)}`))].slice(0, 4);
  const hhmm = `${pad(p.hh)}:${pad(p.mi!)}${p.ss ? `:${pad(p.ss)}` : ""}`;
  return makeIssue(
    "R5", "error", "ungrounded-value", s.path,
    midnight
      ? `病歷中找不到這個值的時間：日期「${s.value.slice(0, 10)}」在病歷中，但時間 00:00 是補上的（病歷沒有寫這個時間）。病歷只有日期時請只寫日期（YYYY-MM-DD），不要補 T00:00:00`
      : `病歷中找不到這個值的時間：日期在病歷中，但時間 ${hhmm} 不在病歷中${times.length ? `（病歷中的時間：${times.join("、")}）` : "（病歷沒有寫任何時間）"}。病歷只有日期時請只寫日期，不要自行補時間`,
    midnight
      ? `The time of this value is not in the record: the date "${s.value.slice(0, 10)}" is, but the time 00:00 was filled in (the record states no such time). When the record gives only the date, write the date only (YYYY-MM-DD), not T00:00:00`
      : `The time of this value is not in the record: the date is, but the time ${hhmm} is not${times.length ? ` (record times: ${times.join(", ")})` : " (the record states no time)"}. When the record gives only the date, write the date only; do not make up a time`,
    `R5 dateTime grounding: date ${dateKey(dateForm)} ${dateState(dateForm)} in the record; time of day ${hhmm}${local ? ` (also tried ${pad(local.hh!)}:${pad(local.mi!)} in the site timezone)` : ""} searched among ${rv.times.length} record time(s) (HH:MM, 上午/下午 N 點 M 分, am/pm, HHMM after a date) and relative times (N 分鐘 / 小時 後): found none`,
  );
}

function dateKey(q: ParsedDt): string {
  return q.d !== null ? dayKey(q.y, q.m!, q.d) : q.m !== null ? monthKey(q.y, q.m) : String(q.y);
}

function checkQuantity(s: Slot, g: GroundingContext, stated: ReturnType<typeof statedAbsences>): RecordIssue | null {
  if (s.kind !== "quantity" || !s.holder || RE_SKIP_QTY.test(s.gpath)) return null;
  const raw = s.holder.value;
  const v = typeof raw === "number" ? raw : typeof raw === "string" && /^-?\d+(\.\d+)?$/u.test(raw.trim()) ? Number(raw) : null;
  if (v === null || !Number.isFinite(v)) return null;
  const derived = RE_DERIVED_QTY.test(s.gpath);
  const range = RE_RANGE_QTY.test(s.gpath);
  const vu = unitOf(s.holder);
  const isObs = s.resource.resourceType === "Observation";
  const labels = isObs ? obsLabels(s) : [];
  const hit = numberGrounded(g.rv, v, vu, derived, isObs && isBmi(s));
  const path = s.path.endsWith(".value") ? s.path : `${s.path}.value`;
  // R1 / R4: the record states this measurement as not obtained (血糖：機器錯誤，未得數值)
  if (isObs && labels.length && !range) {
    const fails = stated.obsAbsent.filter((a) => labels.some((l) => a.label.includes(l) || (a.label.length >= 2 && l.includes(a.label))));
    if (fails.length) {
      const r = otherTimePoint(s, g, fails, hit);
      if (r) return r;
      if (!hit) {
        return makeIssue(
          "R1", "error", "information-absent", path,
          `病歷沒有提供這項資訊：病歷寫「${fails[0].line}」，數值 ${v} 在病歷中找不到。不要填入 0 或估計值；若任務需要它，請回報 insufficient_information`,
          `The record does not provide this information: it says "${fails[0].line}", and the value ${v} is not in the record. Do not write 0 or an estimate; if the task needs it, report insufficient_information`,
          `R1 stated absence: the record line naming this measurement ('${fails[0].label}') says it was not obtained; the value ${v} is not stated in the record`,
          fails.slice(0, 2).map((f) => f.line),
        );
      }
    }
  }
  if (hit) {
    if (isObs && !range) return otherTimePoint(s, g, [], hit);
    return null;
  }
  const near = labels.length ? evidenceNumbers(g.rv, labels) : [];
  const placeholder = v === 0 || v < 0 || /^9{3,}$/u.test(String(v));
  const sev: "error" | "warning" = derived || range ? "warning" : "error";
  return makeIssue(
    "R5", sev, "ungrounded-value", path,
    `病歷中找不到這個值：數值 ${v}${vu ? ` ${vu}` : ""} 不在病歷中，也不能由病歷的數值換算（單位換算、明寫的乘積如 500 mg x 2${isObs && isBmi(s) ? "、身高體重算 BMI" : ""}）得到${placeholder ? "；0／負數／999 這類值看起來是佔位值" : ""}。${near.length ? `病歷中這個項目的數值：${near.join("、")}。` : ""}${sev === "error" ? "不要自行填值；若任務需要它而病歷沒有，請回報 insufficient_information" : "請確認這個值的來源"}`,
    `This value is not in the record: ${v}${vu ? ` ${vu}` : ""} is neither stated in the record nor obtainable from its numbers (unit conversion, an explicit product such as 500 mg x 2${isObs && isBmi(s) ? ", BMI from height and weight" : ""})${placeholder ? "; 0 / negative / 999 values look like placeholders" : ""}.${near.length ? ` Record numbers for this item: ${near.join(", ")}.` : ""} ${sev === "error" ? "Do not make up a value; if the record does not give it, report insufficient_information" : "Check where this value comes from"}`,
    `R5 quantity grounding: ${v}${vu ? ` (${vu})` : ""} compared with ${g.rv.numbers.length} record number(s) outside dates and times (Chinese numerals, 半, fractions included), unit conversions (mass / volume / length / time, °F ↔ °C, glucose mg/dL ↔ mmol/L)` +
      `${derived || !isObs ? ", products of numbers on one line" : ""}: found none${derived ? "; derived quantity, so a warning" : range ? "; reference range, so a warning" : ""}`,
  );
}

/** Stamp of a clause of a record line (its times / days); a clause without one takes the line's single stamp. */
function clauseStamp(rv: RecordValues, li: number, ci: number): Stamp {
  const mk = (pred: (x: { li: number; ci: number }) => boolean): Stamp => ({
    times: new Set(rv.times.filter(pred).map((t) => `${t.h}:${pad(t.mi)}`)),
    days: new Set(
      rv.dates
        .filter(pred)
        .filter((d) => d.prec === "day" || d.prec === "md")
        .flatMap((d) => [`${pad(d.m!)}-${pad(d.d!)}`, ...(d.prec === "day" ? [dayKey(d.y!, d.m!, d.d!)] : [])]),
    ),
  });
  const own = mk((x) => x.li === li && x.ci === ci);
  if (own.times.size || own.days.size) return own;
  const line = mk((x) => x.li === li);
  return line.times.size <= 1 && line.days.size <= 2 ? line : { times: new Set(), days: new Set() };
}

function effectiveOf(res: Json): ParsedDt | null {
  const v = typeof res.effectiveDateTime === "string" ? res.effectiveDateTime : isObj(res.effectivePeriod) && typeof res.effectivePeriod.start === "string" ? res.effectivePeriod.start : typeof res.effectiveInstant === "string" ? res.effectiveInstant : null;
  return v ? parseDt(v) : null;
}

/**
 * R4: an Observation value stated in the record only for another measurement time. Determinable only
 * when the Observation has a time (or a day) and the record clauses carry their own stamps.
 */
function otherTimePoint(s: Slot, g: GroundingContext, fails: StatedAbsent[], hit: ReturnType<typeof numberGrounded>): RecordIssue | null {
  const eff = effectiveOf(s.resource);
  if (!eff || eff.d === null || eff.m === null) return null;
  const rv = g.rv;
  const v = Number(s.holder!.value);
  const timeKey = eff.hh !== null ? `${eff.hh}:${pad(eff.mi!)}` : null;
  const dayKeys = [dayKey(eff.y, eff.m, eff.d), `${pad(eff.m)}-${pad(eff.d)}`];
  const matches = (st: Stamp): boolean | null => {
    if (timeKey !== null && st.times.size) return st.times.has(timeKey);
    if (st.days.size) return dayKeys.some((k) => st.days.has(k));
    return null; // no stamp: undecidable
  };
  const valueClauses = rv.numbers.filter((n) => same(n.value, v)).map((n) => ({ n, st: clauseStamp(rv, n.li, n.ci) }));
  const path = s.path.endsWith(".value") ? s.path : `${s.path}.value`;
  const key = timeKey ?? dayKeys[0];
  const failAtEff = fails.find((f) => matches(f.stamp) === true);
  if (failAtEff && hit && valueClauses.length && valueClauses.every((c) => matches(c.st) === false)) {
    const other = clip(rv.rt.lines[valueClauses[0].n.li].line.trim());
    return makeIssue(
      "R5", "error", "value-from-other-event", path,
      `這個值在病歷中屬於另一個時間點：這筆 Observation 的時間（${key}）在病歷中是「${failAtEff.line}」——沒有得到數值；數值 ${v} 是另一次測量（「${other}」）。請把數值寫在它自己的時間點；這次測量若任務需要，請回報 insufficient_information`,
      `This value belongs to another time point in the record: at this Observation's time (${key}) the record says "${failAtEff.line}" — no value was obtained; ${v} is from another measurement ("${other}"). Write the value at its own time; for this measurement, report insufficient_information if the task needs it`,
      `R4 time point: the record clause stamped ${key} names this measurement with an absence statement; the value ${v} occurs only in clause(s) stamped with another ${timeKey !== null ? "time" : "date"}`,
      [failAtEff.line, other],
    );
  }
  if (fails.length || !hit || !valueClauses.length) return null;
  if (!valueClauses.every((c) => matches(c.st) === false)) return null;
  // a clause stamped with the Observation's time names this measurement (and holds another number)
  const labels = obsLabels(s);
  const atEff = rv.numbers.find((n) => {
    if (same(n.value, v) || matches(clauseStamp(rv, n.li, n.ci)) !== true) return false;
    const t = rv.lineText.get(n.li) ?? "";
    return labels.some((l) => t.includes(l));
  });
  if (!atEff) return null;
  const other = clip(rv.rt.lines[valueClauses[0].n.li].line.trim());
  return makeIssue(
    "R5", "warning", "value-from-other-event", path,
    `這個值在病歷中可能屬於另一個時間點：數值 ${v} 在病歷中屬於另一次測量（「${other}」），而這筆 Observation 的時間（${key}）在病歷中的數值是 ${atEff.raw}。請確認數值與時間屬於同一次測量`,
    `This value may belong to another time point in the record: ${v} is from another measurement ("${other}"), while at this Observation's time (${key}) the record states ${atEff.raw}. Check that value and time belong to the same measurement`,
    `R4 time point: every record clause stating ${v} carries another ${timeKey !== null ? "time" : "date"} stamp; a clause stamped ${key} on a line naming this measurement states ${atEff.raw}`,
    [other],
  );
}

/**
 * ISSUES_v15.1 R6: attach the record's own date as a replace_value suggestion when the record states the
 * value's month / day with another year (a wrong ROC ↔ Gregorian conversion); one candidate is also named in
 * the message. Severity and code are unchanged.
 */
export function withDateCorrections<T extends { message: string; message_zh?: string; message_en?: string; suggestions?: Suggestion[] }>(
  issue: T,
  value: string,
  path: string,
  gpath: string,
  rv: RecordValues,
): T {
  const sug = dateCorrections(value, path, gpath, rv);
  if (!sug.length) return issue;
  const out: T = { ...issue, suggestions: [...(issue.suggestions ?? []), ...sug] };
  if (sug.length === 1 && out.message_zh !== undefined && out.message_en !== undefined) {
    out.message_zh = `${out.message_zh}。病歷有同月同日的日期，正確值應為 ${sug[0].value}（見 suggestions：民國 N 年 = 西元 N+1911）`;
    out.message_en = `${out.message_en}. The record has this month / day: the correct value is ${sug[0].value} (see suggestions: ROC year N = Gregorian N+1911)`;
    out.message = `${out.message_zh} / ${out.message_en}`;
  }
  return out;
}

const MED_RESOURCES = new Set(["MedicationRequest", "MedicationStatement", "MedicationAdministration", "MedicationDispense"]);

/** R1: the record states its medication field as absent (處方：待藥師確認, 用藥：不詳) and the instance has medicines. */
function statedAbsentMedication(root: Json, stated: ReturnType<typeof statedAbsences>): RecordIssue[] {
  const sa = stated.absent.find((a) => a.family === "medication");
  if (!sa || stated.positive.has("medication")) return [];
  const out: RecordIssue[] = [];
  for (const r of resourcesOf(root)) {
    if (!MED_RESOURCES.has(r.resource.resourceType)) continue;
    const key = isObj(r.resource.medicationCodeableConcept) ? "medicationCodeableConcept" : isObj(r.resource.medicationReference) ? "medicationReference" : null;
    if (!key) continue;
    out.push(makeIssue(
      "R1", "error", "information-absent", `${r.base}.${key}`,
      `病歷沒有提供這項資訊：病歷寫「${sa.line}」（藥物尚未確定），但這裡寫了 ${r.resource.resourceType}。不要自行補上藥物；若任務需要它，請回報 insufficient_information`,
      `The record does not provide this information: it says "${sa.line}" (no medicine decided yet), but a ${r.resource.resourceType} is written. Do not add a medicine yourself; if the task needs it, report insufficient_information`,
      `R1 stated absence: the medication field label '${sa.label}' is written with an absence statement and no other line gives it a value`,
      [sa.line],
    ));
  }
  return out;
}

/** R5 value grounding + the R1 / R4 checks that need the record value index (see the header). */
export function valueGroundingChecks(root: Json, slots: Slot[], sourceText: string, siteConfig: string | null, skipPaths: ReadonlySet<string>): RecordIssue[] {
  const rv = new RecordValues(sourceText, siteConfig);
  const stated = statedAbsences(rv);
  const g: GroundingContext = { rv, siteConfig, stated };
  const out: RecordIssue[] = [];
  try {
    out.push(...statedAbsentMedication(root, stated));
  } catch {
    // fail-open
  }
  for (const s of slots) {
    if (skipPaths.has(s.path) || skipPaths.has(`${s.path}.value`)) continue;
    try {
      const r = checkIdentifier(s, g, stated) ?? checkDate(s, g, stated) ?? checkQuantity(s, g, stated);
      if (r) out.push(r);
    } catch {
      // fail-open per slot
    }
  }
  return out;
}
