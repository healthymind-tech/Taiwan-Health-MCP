/**
 * Record-aware checks (need source_text): R3 (insufficient precision / incomplete value, with a
 * search of the record for a more complete value) and R4 (a diagnosis the record leaves
 * unconfirmed, written as confirmed).
 *
 * The record is indexed with the grounding engine's RecordText (same line segmentation, sections,
 * instruction lines 【轉換目標】 never evidence, normalised quote search), and dates / numbers are
 * read with the grounding lexicon's parsers (western, ROC 民國, Chinese 年月日 dates; numbers with
 * canonical units). Lines of the instruction / site-config / family-history sections are never
 * searched. Only the field under test and the record sentences about the same thing are examined.
 */
import { nfkc, numbersWithUnits, parseDatesPos, unitsCompatible, VITAL_LABELS } from "../grounding/lexicon.js";
import { RecordText } from "../grounding/recordText.js";
import { confirmsIn, cuesIn, type CueHit } from "./lexicon.js";
import { makeIssue } from "./issue.js";
import { resourcesOf, type Slot } from "./slots.js";
import type { RecordIssue } from "./types.js";

type Json = Record<string, any>;
const isObj = (x: unknown): x is Json => !!x && typeof x === "object" && !Array.isArray(x);
const clip = (s: string, n = 80): string => (s.length > n ? `${s.slice(0, n)}…` : s);

const SKIP_SECTIONS = new Set(["instruction", "site_config", "family_history"]);

/**
 * Event times: elements of type dateTime / instant that record WHEN this encounter's event happened,
 * where a value coarser than a day cannot be used (an admission / a measurement / an order needs its
 * day). History-type times (Condition.onset, AllergyIntolerance.onset, MedicationStatement.effective,
 * Procedure.performed, Immunization.occurrence — often known only to the year) and `date`-typed
 * elements (Patient.birthDate) are deliberately not listed.
 */
export const EVENT_TIMES: ReadonlySet<string> = new Set([
  "Encounter.period.start",
  "Encounter.period.end",
  "Observation.effectiveDateTime",
  "Observation.effectivePeriod.start",
  "Observation.effectivePeriod.end",
  "Observation.effectiveInstant",
  "Observation.issued",
  "DiagnosticReport.effectiveDateTime",
  "DiagnosticReport.effectivePeriod.start",
  "DiagnosticReport.effectivePeriod.end",
  "DiagnosticReport.issued",
  "MedicationRequest.authoredOn",
  "MedicationAdministration.effectiveDateTime",
  "MedicationAdministration.effectivePeriod.start",
  "MedicationDispense.whenHandedOver",
  "MedicationDispense.whenPrepared",
  "Specimen.collection.collectedDateTime",
  "Specimen.receivedTime",
  "ImagingStudy.started",
  "Composition.date",
]);

/** Quantities that ARE the value of their element (a measurement / a dose): without `value` they say nothing. */
const VALUE_QUANTITIES: ReadonlySet<string> = new Set([
  "Observation.valueQuantity",
  "Observation.component.valueQuantity",
  "MedicationRequest.dosageInstruction.doseAndRate.doseQuantity",
  "MedicationStatement.dosage.doseAndRate.doseQuantity",
  "MedicationAdministration.dosage.dose",
  "MedicationDispense.dosageInstruction.doseAndRate.doseQuantity",
  "Immunization.doseQuantity",
]);

const DOSE_UNITS = new Set(["mg", "g", "ug", "[iu]", "{tab}", "{puff}", "{bottle}", "{tube}", "ml", "mg/ml"]);
const MED_TYPES: Record<string, string> = {
  MedicationRequest: "dosageInstruction",
  MedicationStatement: "dosage",
  MedicationAdministration: "dosage",
  MedicationDispense: "dosageInstruction",
};
const NOT_CONFIRMED = new Set(["provisional", "differential", "unconfirmed", "refuted", "entered-in-error"]);
const RE_DIAG_LABEL = /(診斷|臆斷|impression|assessment|diagnos|\bdx\b|病名)/u;

// ------------------------------------------------------------------------------------------- record index

class RecordIndex {
  readonly rt: RecordText;
  constructor(text: string, site: string | null) {
    this.rt = new RecordText(text, site);
  }
  /** Searchable lines: [index, line] of every record line outside instruction / site-config / family history. */
  lines(): Array<[number, string]> {
    return this.rt.lines.map((l, i) => [i, l] as const).filter(([, l]) => !SKIP_SECTIONS.has(l.section) && l.line.trim()).map(([i, l]) => [i, l.line]);
  }
  section(i: number): string {
    return this.rt.lines[i]?.section ?? "";
  }
  /** Record-origin occurrences of `name` outside the skipped sections: [line index, start, end] (offsets in the line). */
  find(name: string): Array<{ li: number; start: number; end: number; line: string }> {
    if (!name || name.trim().length < 2) return [];
    const out: Array<{ li: number; start: number; end: number; line: string }> = [];
    for (const o of this.rt.find(name)) {
      if (o.origin !== "record" || o.li === null || SKIP_SECTIONS.has(o.section)) continue;
      const ln = this.rt.lines[o.li];
      out.push({ li: o.li, start: o.start - ln.start, end: o.end - ln.start, line: ln.line });
    }
    return out;
  }
}

/** Per-character NFKC + lower case keeping the line's offsets (cue matching on the original positions). */
function alignNorm(line: string): string {
  let out = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    const n = nfkc(c);
    out += n.length === 1 ? n : c.toLowerCase();
  }
  return out;
}

// ------------------------------------------------------------------------------------------- R3: dates

const RE_FHIR_DATE = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?/u;

function precisionOf(v: string): { y: number; m: number | null; prec: "year" | "month" | "day" } | null {
  const m = RE_FHIR_DATE.exec(v.trim());
  if (!m) return null;
  return { y: Number(m[1]), m: m[2] ? Number(m[2]) : null, prec: m[3] ? "day" : m[2] ? "month" : "year" };
}

const pad = (n: number): string => String(n).padStart(2, "0");

function dateCandidates(rec: RecordIndex, y: number, m: number | null): Array<{ value: string; line: string }> {
  const out: Array<{ value: string; line: string }> = [];
  const seen = new Set<string>();
  for (const [, line] of rec.lines()) {
    for (const pd of parseDatesPos(line)) {
      const [prec, [yy, mm, dd]] = pd.date;
      let value: string | null = null;
      if (prec === "day" && yy === y && (m === null || mm === m)) value = `${yy}-${pad(mm!)}-${pad(dd!)}`;
      else if (prec === "md" && m !== null && mm === m) value = `${y}-${pad(mm!)}-${pad(dd!)}`;
      if (!value || seen.has(value)) continue;
      seen.add(value);
      out.push({ value, line: clip(line.trim()) });
    }
  }
  return out;
}

function r3Date(s: Slot, rec: RecordIndex): RecordIssue | null {
  if (s.kind !== "date" || typeof s.value !== "string" || !EVENT_TIMES.has(s.gpath)) return null;
  const p = precisionOf(s.value);
  if (!p || p.prec === "day") return null;
  const lines = rec.lines().length;
  const range = p.m === null ? `${p.y}` : `${p.y}-${pad(p.m)}`;
  const precZh = p.prec === "month" ? "月份" : "年份";
  const cands = dateCandidates(rec, p.y, p.m);
  const evidence =
    `R3 ${s.gpath} is a dateTime event time (needs at least the day); the value has ${p.prec} precision. Searched ${lines} record line(s) ` +
    `(instruction / site-config / family-history lines excluded) for day-precision dates within ${range} (western, ROC 民國, 年月日 and month-day forms): ` +
    (cands.length ? `found ${cands.length}: ${cands.slice(0, 3).map((c) => c.value).join(", ")}` : "found none");
  if (cands.length) {
    const list = cands.slice(0, 3).map((c) => `'${c.value}'`).join("、");
    return makeIssue(
      "R3", "error", "insufficient-precision", s.path,
      `日期精度不足：這個欄位需要到日的日期時間，值「${s.value}」只到${precZh}。病歷有更完整的值 ${list}——請確認是否為這個事件的日期再填入`,
      `Insufficient precision: this element needs a date-time to the day, the value "${s.value}" has only the ${p.prec}. The record has a more complete value ${cands.slice(0, 3).map((c) => `'${c.value}'`).join(", ")} — use it if it is this event's date`,
      evidence, cands.slice(0, 3).map((c) => c.line),
    );
  }
  return makeIssue(
    "R3", "error", "insufficient-precision", s.path,
    `日期精度不足：這個欄位需要到日的日期時間，值「${s.value}」只到${precZh}，而病歷沒有提供更完整的日期。不要自行補日；若任務需要這項資訊，請回報 insufficient_information`,
    `Insufficient precision: this element needs a date-time to the day, the value "${s.value}" has only the ${p.prec}, and the record does not provide a more complete date. Do not invent the day; if the task needs it, report insufficient_information`,
    evidence,
  );
}

// ------------------------------------------------------------------------------------------- R3: quantities

function codeLabels(cc: unknown): string[] {
  const out: string[] = [];
  if (!isObj(cc)) return out;
  if (typeof cc.text === "string") out.push(cc.text);
  for (const c of Array.isArray(cc.coding) ? cc.coding : []) {
    if (!isObj(c)) continue;
    if (typeof c.display === "string") out.push(c.display);
    for (const l of (VITAL_LABELS as Record<string, string[]>)[String(c.code ?? "")] ?? []) if (l.length >= 2) out.push(l);
  }
  return [...new Set(out.map((x) => x.trim()).filter((x) => x.length >= 2))];
}

function quantityLabels(s: Slot): string[] {
  const res = s.resource;
  const m = /\.component\[(\d+)\]/u.exec(s.path);
  if (m && Array.isArray(res.component)) return codeLabels(res.component[Number(m[1])]?.code);
  if (res.resourceType === "Observation") return codeLabels(res.code);
  if (MED_TYPES[res.resourceType] !== undefined) return medicineNames(res);
  if (res.resourceType === "Immunization") return codeLabels(res.vaccineCode);
  return [];
}

function numbersNear(rec: RecordIndex, labels: string[], unit: string | null, doseOnly: boolean): Array<{ value: string; line: string }> {
  const out: Array<{ value: string; line: string }> = [];
  const seen = new Set<string>();
  for (const lb of labels) {
    for (const o of rec.find(lb)) {
      const tail = o.line.slice(o.end, o.end + 60);
      for (const [, num, u, raw] of numbersWithUnits(tail)) {
        if (u === null) continue;
        if (doseOnly && !DOSE_UNITS.has(u)) continue;
        if (unit !== null && !unitsCompatible(unit, u)) continue;
        const key = `${num}|${u}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ value: raw.trim() || `${num} ${u}`, line: clip(o.line.trim()) });
      }
    }
  }
  return out;
}

function r3Quantity(s: Slot, rec: RecordIndex): RecordIssue | null {
  if (s.kind !== "quantity" || !VALUE_QUANTITIES.has(s.gpath) || !s.holder) return null;
  const v = s.holder.value;
  if (v !== undefined && v !== null) return null;
  const unit = typeof s.holder.unit === "string" ? s.holder.unit : typeof s.holder.code === "string" ? s.holder.code : null;
  const labels = quantityLabels(s);
  const dose = s.gpath !== "Observation.valueQuantity" && s.gpath !== "Observation.component.valueQuantity";
  const cands = labels.length ? numbersNear(rec, labels, unit, dose) : [];
  const what = labels.length ? `「${clip(labels[0], 30)}」` : "這個項目";
  const evidence =
    `R3 ${s.gpath} has no value${unit ? ` (unit ${unit})` : ""}. Searched record lines mentioning ${labels.length ? labels.slice(0, 4).map((l) => `'${l}'`).join(", ") : "(no label to search)"} ` +
    `for a number with a ${unit ? "compatible " : ""}unit after the label: ` + (cands.length ? `found ${cands.slice(0, 3).map((c) => c.value).join(", ")}` : "found none");
  const path = s.path.endsWith(".value") ? s.path : `${s.path}.value`;
  if (cands.length) {
    return makeIssue(
      "R3", "error", "incomplete-value", path,
      `數值不完整：Quantity 沒有 value，只有單位或代碼。病歷有更完整的值 ${cands.slice(0, 3).map((c) => `'${c.value}'`).join("、")}（${what}）`,
      `Incomplete value: the Quantity has no value, only a unit / code. The record has a more complete value ${cands.slice(0, 3).map((c) => `'${c.value}'`).join(", ")}`,
      evidence, cands.slice(0, 3).map((c) => c.line),
    );
  }
  return makeIssue(
    "R3", "error", "incomplete-value", path,
    `數值不完整：Quantity 沒有 value，只有單位或代碼，而病歷沒有提供${what}的數值。若任務需要這項資訊，請回報 insufficient_information，不要輸出沒有數值的 Quantity`,
    `Incomplete value: the Quantity has no value, only a unit / code, and the record does not provide the number. If the task needs it, report insufficient_information instead of a Quantity without a value`,
    evidence,
  );
}

// ------------------------------------------------------------------------------------------- R3: medicines as text only

const RE_DOSE_IN_TEXT = /\d/u;

function medicineNames(res: Json): string[] {
  const cc = res.medicationCodeableConcept;
  const names: string[] = [];
  if (isObj(cc) && typeof cc.text === "string") {
    names.push(cc.text);
    // the name part without the strength ("某藥 200 mg" → "某藥")
    const bare = cc.text.replace(/[\d.,]+\s*[a-zA-Zµμ%/一-鿿]{0,6}.*$/u, "").trim();
    if (bare && bare !== cc.text) names.push(bare);
  }
  return [...new Set(names.filter((n) => n.trim().length >= 2))];
}

function hasStructuredCode(cc: unknown): boolean {
  return isObj(cc) && Array.isArray(cc.coding) && cc.coding.some((c: unknown) => isObj(c) && typeof c.code === "string" && c.code.trim() !== "");
}

function dosageHasDose(d: unknown): boolean {
  if (!isObj(d)) return false;
  if (isObj(d.dose) && d.dose.value !== undefined && d.dose.value !== null) return true; // MedicationAdministration.dosage.dose
  for (const dr of Array.isArray(d.doseAndRate) ? d.doseAndRate : []) {
    if (!isObj(dr)) continue;
    if (isObj(dr.doseQuantity) && dr.doseQuantity.value !== undefined && dr.doseQuantity.value !== null) return true;
    if (isObj(dr.doseRange)) return true;
  }
  // a dose written in the dosage text (1 tab bid, 200mg qd) is stated, only not structured
  return typeof d.text === "string" && numbersWithUnits(d.text).some(([, , u]) => u !== null && DOSE_UNITS.has(u));
}

function r3Medicine(res: Json, base: string, rec: RecordIndex, bundleMedicines: Map<string, Json>): RecordIssue | null {
  const dz = MED_TYPES[res.resourceType];
  if (dz === undefined) return null;
  let cc: unknown = res.medicationCodeableConcept;
  let ccPath = `${base}.medicationCodeableConcept`;
  let strength = false;
  if (!isObj(cc) && isObj(res.medicationReference) && typeof res.medicationReference.reference === "string") {
    const med = bundleMedicines.get(res.medicationReference.reference);
    if (!med) return null;
    cc = med.code;
    ccPath = `${base}.medicationReference`;
    strength = (Array.isArray(med.ingredient) ? med.ingredient : []).some((i: unknown) => isObj(i) && isObj(i.strength));
  }
  if (!isObj(cc) || typeof cc.text !== "string" || !cc.text.trim() || hasStructuredCode(cc)) return null;
  const dosages: unknown[] = Array.isArray(res[dz]) ? res[dz] : isObj(res[dz]) ? [res[dz]] : [];
  if (strength || dosages.some(dosageHasDose)) return null;
  const text = cc.text.trim();
  const inText = RE_DOSE_IN_TEXT.test(text) ? numbersWithUnits(text).filter(([, , u]) => u !== null && DOSE_UNITS.has(u)).map(([, , , raw]) => raw.trim()) : [];
  const names = medicineNames({ medicationCodeableConcept: cc });
  const cands = numbersNear(rec, names, null, true).filter((c) => !inText.includes(c.value));
  const evidence =
    `R3 ${res.resourceType}: the medicine is free text only (no coding with a code) and no structured dose (doseAndRate / dosage.dose / ingredient strength / a dose in dosage text). ` +
    `Searched record lines mentioning ${names.map((n) => `'${clip(n, 30)}'`).join(", ")} for a dose (number + mg / g / mcg / mL / IU / tab …): ` +
    (cands.length ? `found ${cands.slice(0, 3).map((c) => c.value).join(", ")}` : "found none") + (inText.length ? `; the text itself contains ${inText.join(", ")}` : "");
  const head = `藥品只有自由文字「${clip(text, 40)}」，沒有任何代碼，也沒有結構化劑量`;
  const headEn = `The medicine is only free text "${clip(text, 40)}", with no code and no structured dose`;
  if (cands.length || inText.length) {
    const found = [...inText, ...cands.map((c) => c.value)].slice(0, 3);
    return makeIssue(
      "R3", "error", "incomplete-value", ccPath,
      `${head}。病歷有更完整的值：劑量 ${found.map((f) => `'${f}'`).join("、")}——請寫入 dose（doseAndRate.doseQuantity），並依病歷補上藥品代碼`,
      `${headEn}. The record has a more complete value: dose ${found.map((f) => `'${f}'`).join(", ")} — write it as a structured dose (doseAndRate.doseQuantity) and code the medicine from the record`,
      evidence, cands.slice(0, 3).map((c) => c.line),
    );
  }
  return makeIssue(
    "R3", "error", "incomplete-value", ccPath,
    `${head}，而病歷沒有提供劑量。若任務需要這項資訊，請回報 insufficient_information`,
    `${headEn}, and the record does not provide a dose. If the task needs it, report insufficient_information`,
    evidence,
  );
}

// ------------------------------------------------------------------------------------------- R4: diagnoses

type Reading = "explicit" | "uncertain" | "plain" | "confirmed";

interface Mention {
  reading: Reading;
  cue: string | null;
  quote: string;
  section: string;
}

const RE_SENT = /[。；;]/u;
const RE_COMMA = /[，,]/u;

/** How one occurrence of a diagnosis name in a record line is qualified. */
function readMention(line: string, start: number, end: number, section: string): Mention {
  const t = alignNorm(line);
  let s0 = 0;
  for (let i = start - 1; i >= 0; i--) if (RE_SENT.test(t[i])) { s0 = i + 1; break; }
  let s1 = t.length;
  for (let i = end; i < t.length; i++) if (RE_SENT.test(t[i])) { s1 = i; break; }
  const sentence = t.slice(s0, s1);
  const quote = clip(line.slice(s0, s1).trim(), 100);
  const cues = cuesIn(sentence).map((c) => ({ ...c, start: c.start + s0, end: c.end + s0 }));
  const confirms = confirmsIn(sentence, cuesIn(sentence));
  if (confirms.length) return { reading: "confirmed", cue: confirms[0].cue, quote, section };
  if (section === "rule_out") return { reading: "explicit", cue: "rule-out section", quote, section };
  const applies: CueHit[] = [];
  for (const c of cues) {
    if (c.position === "prefix" && c.end <= start) {
      const between = t.slice(c.end, start);
      if (!RE_COMMA.test(between) && between.length <= 40) applies.push(c);
    } else if (c.position === "postfix" && c.start >= end) {
      const between = t.slice(end, c.start);
      if (c.cue === "?" || c.cue === "？") {
        if (between.trim().length <= 1) applies.push(c);
        continue;
      }
      if (!RE_COMMA.test(between) && between.length <= 20) {
        applies.push(c);
        continue;
      }
      // "…A、B、C，尚未確立": a postfix cue opening the next comma clause governs the clause before it
      const k = between.search(RE_COMMA);
      if (k >= 0 && !RE_COMMA.test(between.slice(k + 1))) {
        const lead = between.slice(k + 1).replace(/^\s*(但|仍|目前|尚|均|皆|都|but|still|yet|currently)?\s*/u, "");
        let clauseEnd = t.slice(c.end).search(RE_COMMA);
        clauseEnd = clauseEnd < 0 ? t.length - c.end : clauseEnd;
        if (lead.length === 0 && clauseEnd <= 8) applies.push(c);
      }
    }
  }
  if (applies.some((c) => c.strength === "explicit")) return { reading: "explicit", cue: applies.find((c) => c.strength === "explicit")!.cue, quote, section };
  if (applies.length) return { reading: "uncertain", cue: applies[0].cue, quote, section };
  return { reading: "plain", cue: null, quote, section };
}

function conditionNames(res: Json): string[] {
  const out: string[] = [];
  const cc = res.code;
  if (isObj(cc)) {
    if (typeof cc.text === "string") out.push(cc.text);
    for (const c of Array.isArray(cc.coding) ? cc.coding : []) {
      if (!isObj(c)) continue;
      if (typeof c.display === "string") out.push(c.display);
      // ICD-10 style codes are often written in the record next to the name (I10 原發性高血壓)
      if (typeof c.code === "string" && /^[A-Z]\d{2}(\.[0-9A-Z]{1,4})?$/u.test(c.code)) out.push(c.code);
    }
  }
  return [...new Set(out.map((x) => x.trim()).filter((x) => x.length >= 2))];
}

function verificationOf(res: Json): string | null {
  const vs = res.verificationStatus;
  if (!isObj(vs)) return null;
  for (const c of Array.isArray(vs.coding) ? vs.coding : []) if (isObj(c) && typeof c.code === "string") return c.code;
  return null;
}

function mentionsOf(rec: RecordIndex, names: string[]): Mention[] {
  const out: Mention[] = [];
  const seen = new Set<string>();
  for (const n of names) {
    for (const o of rec.find(n)) {
      const key = `${o.li}:${o.start}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(readMention(o.line, o.start, o.end, rec.section(o.li)));
    }
  }
  return out;
}

function r4Condition(res: Json, base: string, rec: RecordIndex): RecordIssue | null {
  if (res.resourceType !== "Condition") return null;
  const vs = verificationOf(res);
  if (vs !== null && NOT_CONFIRMED.has(vs)) return null;
  const names = conditionNames(res);
  const ms = mentionsOf(rec, names);
  if (!ms.length || ms.some((m) => m.reading === "confirmed")) return null;
  const explicit = ms.filter((m) => m.reading === "explicit");
  const uncertain = ms.filter((m) => m.reading === "uncertain");
  const plain = ms.filter((m) => m.reading === "plain");
  let severity: "error" | "warning";
  let basis: Mention[];
  if (explicit.length && !plain.length) {
    severity = "error";
    basis = explicit;
  } else if (explicit.length || (uncertain.length && !plain.length)) {
    severity = "warning";
    basis = explicit.length ? explicit : uncertain;
  } else return null;
  const quotes = [...new Set(basis.map((m) => m.quote))].slice(0, 3);
  const cue = basis[0].cue ?? "";
  const written = vs === null ? "沒有標示 verificationStatus（讀作已確立）" : `verificationStatus 是 ${vs}`;
  const writtenEn = vs === null ? "has no verificationStatus (read as established)" : `has verificationStatus ${vs}`;
  const name = clip(names[0] ?? "", 30);
  const evidence =
    `R4 located ${ms.length} record mention(s) of ${names.slice(0, 3).map((n) => `'${clip(n, 30)}'`).join(", ")}: ${explicit.length} under an explicit not-established cue ` +
    `(待排除 / 尚未確立 / r/o / differential …), ${uncertain.length} hedged (疑似 / possible …), ${plain.length} plain, 0 confirmed; cue scope = the sentence, ` +
    `prefix cues up to the next comma, postfix cues in the same or the following short clause`;
  const path = isObj(res.verificationStatus) ? `${base}.verificationStatus` : `${base}.code`;
  if (severity === "error") {
    return makeIssue(
      "R4", "error", "unconfirmed-as-confirmed", path,
      `尚未確立的診斷被寫成確立：病歷關於「${name}」的敘述是「${quotes[0]}」（${cue}），但這個 Condition ${written}。請標成 provisional 或 differential；若任務需要確立的診斷而病歷沒有，請回報 insufficient_information`,
      `A diagnosis the record leaves unestablished is written as established: the record says "${quotes[0]}" (${cue}) about '${name}', but this Condition ${writtenEn}. Mark it provisional or differential; if the task needs an established diagnosis and the record has none, report insufficient_information`,
      evidence, quotes,
    );
  }
  return makeIssue(
    "R4", "warning", "unconfirmed-as-confirmed", path,
    `診斷可能尚未確立：病歷關於「${name}」的敘述是「${quotes[0]}」（${cue}），這個 Condition ${written}。請確認病歷是否已確立這個診斷；若未確立，請標成 provisional`,
    `The diagnosis may not be established: the record says "${quotes[0]}" (${cue}) about '${name}', and this Condition ${writtenEn}. Check whether the record establishes it; if not, mark it provisional`,
    evidence, quotes,
  );
}

const RE_ICD = /icd-?10/iu;

/** Record sentences that state a main / working diagnosis is still to be ruled out (explicit cue in a diagnosis context). */
function unconfirmedDiagnosisStatements(rec: RecordIndex): string[] {
  const out: string[] = [];
  for (const [i, line] of rec.lines()) {
    const sec = rec.section(i);
    for (const sent0 of line.split(RE_SENT)) {
      const sent = alignNorm(sent0);
      const explicit = cuesIn(sent).some((c) => c.strength === "explicit");
      if (!explicit) continue;
      if (sec === "rule_out" || sec === "diagnosis" || RE_DIAG_LABEL.test(sent)) out.push(clip(sent0.trim(), 100));
    }
  }
  return out;
}

function r4Symptom(res: Json, base: string, rec: RecordIndex, statements: string[], anyProvisional: boolean): RecordIssue | null {
  if (res.resourceType !== "Condition" || anyProvisional || !statements.length) return null;
  const vs = verificationOf(res);
  if (vs !== null && NOT_CONFIRMED.has(vs)) return null;
  const cc = res.code;
  const symptom = (isObj(cc) && Array.isArray(cc.coding) ? cc.coding : []).find((c: unknown) => isObj(c) && RE_ICD.test(String(c.system ?? "")) && /^R\d{2}/u.test(String(c.code ?? "")));
  if (!symptom) return null;
  // its own mentions under a cue are handled by r4Condition
  if (mentionsOf(rec, conditionNames(res)).some((m) => m.reading !== "plain")) return null;
  return makeIssue(
    "R4", "warning", "symptom-for-unconfirmed-diagnosis", `${base}.code`,
    `以症狀碼代替尚未確立的主診斷：這個 Condition 是症狀碼 ${symptom.code}，而病歷寫「${statements[0]}」。若主診斷尚未確立，請依病歷以 provisional / differential 的 Condition 表達，或回報 insufficient_information`,
    `A symptom code stands in for a main diagnosis that is still to be ruled out: this Condition is the symptom code ${symptom.code}, while the record says "${statements[0]}". Express the unestablished diagnosis as a provisional / differential Condition, or report insufficient_information`,
    `R4 the Condition is coded with an ICD-10 symptom chapter code (R00–R99); the record has ${statements.length} sentence(s) with an explicit not-established cue in a diagnosis context; no Condition in the input is marked provisional / differential / unconfirmed`,
    statements.slice(0, 3),
  );
}

// ------------------------------------------------------------------------------------------- driver

export function recordAwareChecks(root: Json, slots: Slot[], sourceText: string, siteConfig: string | null, skipPaths: ReadonlySet<string>): RecordIssue[] {
  const rec = new RecordIndex(sourceText, siteConfig);
  const out: RecordIssue[] = [];
  for (const s of slots) {
    if (skipPaths.has(s.path)) continue;
    try {
      const d = r3Date(s, rec) ?? r3Quantity(s, rec);
      if (d) out.push(d);
    } catch {
      // fail-open per slot
    }
  }
  const resources = resourcesOf(root);
  const medicines = new Map<string, Json>();
  for (const r of resources) {
    if (r.resource.resourceType !== "Medication") continue;
    if (r.fullUrl) medicines.set(r.fullUrl, r.resource);
    if (typeof r.resource.id === "string") medicines.set(`Medication/${r.resource.id}`, r.resource);
  }
  for (const r of resources) {
    for (const c of Array.isArray(r.resource.contained) ? r.resource.contained : []) {
      if (isObj(c) && c.resourceType === "Medication" && typeof c.id === "string") medicines.set(`#${c.id}`, c);
    }
  }
  const anyProvisional = resources.some((r) => r.resource.resourceType === "Condition" && NOT_CONFIRMED.has(verificationOf(r.resource) ?? ""));
  let statements: string[] | null = null;
  for (const r of resources) {
    try {
      const m = r3Medicine(r.resource, r.base, rec, medicines);
      if (m) out.push(m);
      const c = r4Condition(r.resource, r.base, rec);
      if (c) out.push(c);
      else if (r.resource.resourceType === "Condition") {
        statements ??= unconfirmedDiagnosisStatements(rec);
        const w = r4Symptom(r.resource, r.base, rec, statements, anyProvisional);
        if (w) out.push(w);
      }
    } catch {
      // fail-open per resource
    }
  }
  return out;
}
