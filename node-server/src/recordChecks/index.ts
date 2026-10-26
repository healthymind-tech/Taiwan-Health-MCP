/**
 * Record checks (ISSUES_v15): recognise "the record does not actually provide this information".
 *
 * A post-validation layer, like fhirSuggestions/: it runs AFTER the instance validator and appends
 * its own issues (`source: "record-checks"`, stable `code`, zh + en message, `evidence`) to the
 * tool's issue lists; InstanceValidator is never touched, so the validator parity audit is
 * unaffected. Report only — no value is ever changed or removed.
 *
 *   R1 information-absent  (always)        a value that describes the ABSENCE of the information
 *                                          (未取號 / 建檔失敗 / 不詳 / unknown / pending …) in a field
 *                                          that needs a structured value — error.
 *                                          ISSUES_v15.3: also text fields — CodeableConcept.text with no /
 *                                          only placeholder codings, Dosage.text, Observation.valueString /
 *                                          note when the code needs a quantitative result (quantitative.ts;
 *                                          specimen problems 溶血 / QNS and "see report" count there too).
 *                                          ISSUES_v15.4: EMPTY SHELLS (emptyShell.ts) — an Observation / MedicationRequest /
 *                                          MedicationStatement / Condition without its primary value whose side fields
 *                                          (note, dataAbsentReason, dosage text …) explain the absence clause by clause;
 *                                          error only when the record's statement about the item confirms it.
 *   R2 identifier-format   (always)        identifier format by Identifier.system (registry,
 *                                          identifiers.ts; site_config `identifier-format` lines) and
 *                                          "not a sentence" for every identifier — error.
 *   R3 insufficient-precision / incomplete-value (source_text)  event times coarser than a day,
 *                                          Quantity without value, medicine as text only (no code, no
 *                                          dose); the record is searched for a more complete value —
 *                                          error either way, the message says which.
 *   R4 unconfirmed-as-confirmed / symptom-for-unconfirmed-diagnosis (source_text)  a Condition not
 *                                          marked provisional / differential while the record's
 *                                          sentences about it say it is not established — error when
 *                                          explicit (待排除, r/o, 尚未確立), warning when hedged (疑似,
 *                                          possible); a symptom code standing in for a main diagnosis
 *                                          still to be ruled out — warning. ISSUES_v15.3 R2: the PRIMARY
 *                                          Condition written as provisional / differential / text-only while the
 *                                          record has no established primary diagnosis → information-absent.
 *
 * Errors make the tool's `valid` false; `record_checks: {ok, errors, warnings, rules, source_text}`
 * summarises. Deterministic, no LLM, no network; the record text is never logged.
 */
import { absenceClauses, absenceOf, RECORD_CHECKS_LEXICON_SHA256, RECORD_CHECKS_LEXICON_VERSION } from "./lexicon.js";
import { identifierRegistry, sentenceLike } from "./identifiers.js";
import { makeIssue } from "./issue.js";
import { RecordText } from "../grounding/recordText.js";
import { diagnosisSlotChecks } from "./diagnosisSlot.js";
import { recordAwareChecks } from "./recordAware.js";
import { valueGroundingChecks } from "./valueGrounding.js";
import { quantitativeBasis } from "./quantitative.js";
import { emptyShellChecks } from "./emptyShell.js";
import { resourcesOf, slotsOf, type Slot } from "./slots.js";
import type { RecordCheckOptions, RecordCheckResult, RecordIssue, RecordRule } from "./types.js";

export { makeIssue } from "./issue.js";

export type { RecordCheckCode, RecordCheckOptions, RecordCheckResult, RecordCheckSummary, RecordIssue, RecordRule } from "./types.js";
export { absenceOf, RECORD_CHECKS_LEXICON_SHA256, RECORD_CHECKS_LEXICON_VERSION } from "./lexicon.js";
export { identifierRegistry, BUILTIN_IDENTIFIER_SYSTEMS, BUILTIN_FORMATS } from "./identifiers.js";

/** Engine version (provenance `recordChecksVersion`). */
// 1.1.0 (ISSUES_v15.1): R5 value grounding (ungrounded-value, value-from-other-event), identifiers with a system but
//   no value, stated absences (病歷號：申請中 → information-absent), the primary diagnosis slot (R4), bracket-scoped cues.
// 1.2.0 (ISSUES_v15.3): R1 for text fields (CodeableConcept.text without / with placeholder codings, Dosage.text,
//   Observation.valueString / note in quantitative result slots — quantitative.ts), R2 provisional / differential / text-only
//   primary Condition vs an unestablished diagnosis slot (diagnosisSlot.ts primaryStandIn), R3 coded-element grounding
//   annotation in the validating tools (codeGrounding.ts, envelope only).
// 1.3.0 (ISSUES_v15.4): R1 empty shells (emptyShell.ts: no primary value, the absence explained in a side field; error only
//   when the record's statement about the item confirms it), absence predicate classes + the clause-level dominance rule
//   (lexicon absenceClauses), bracketed limits in result values, dataAbsentReason as a side field, not-done / cancelled
//   Observations out of the v15.3 note rule, indistinguishable diagnosis slots.
// 1.3.1: the v15.3 result-slot note rule is a warning without source_text (as the empty-shell rule); R3 Chinese-name
//   hardening + hierarchy guard + record-casing abbreviation check (codeGrounding.ts, grounding/snomedChinese.ts).
export const RECORD_CHECKS_VERSION = "1.3.1";

type Json = Record<string, any>;
const isObj = (x: unknown): x is Json => !!x && typeof x === "object" && !Array.isArray(x);

/** Code systems defined by HL7 / FHIR (their codes include real "unknown" / "UNK" concepts); hl7.org/fhir/sid/* are external systems (ICD, NDC, CVX …). */
const HL7_SYSTEM = /^https?:\/\/(hl7\.org\/fhir\/(?!sid\/)|terminology\.hl7\.org\/)/u;
const FHIR_DATE = /^\d{4}(-\d{2}(-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?)?)?$/u;

const FIELD_LABELS: Record<string, [string, string]> = {
  identifier: ["識別碼", "identifier"],
  coding: ["代碼", "code"],
  "cc-text": ["代碼文字", "coded text"],
  date: ["日期", "date"],
  quantity: ["數量", "quantity value"],
  reference: ["參照", "reference"],
  "ref-display": ["參照", "reference"],
  "name-part": ["姓名", "name"],
  telecom: ["聯絡方式", "contact value"],
  "value-string": ["結果值", "result value"],
  lot: ["批號", "lot number"],
  "dosage-text": ["劑量用法", "dosage"],
};

/** Main clinical value fields (ISSUES_v15.3 R1): named in the message so the caller sees which clinical fact is missing. */
const MAIN_FIELDS: Array<[RegExp, string, string]> = [
  [/^Condition\.code\.text$/u, "診斷（Condition.code）", "diagnosis (Condition.code)"],
  [/^Observation\.(component\.)?value(String|CodeableConcept\.text)$/u, "檢驗／觀察結果（Observation.value[x]）", "result (Observation.value[x])"],
  [/^Medication(Request|Statement|Administration|Dispense)\.medicationCodeableConcept\.text$/u, "藥品（medication[x]）", "medicine (medication[x])"],
  [/^Medication\.code\.text$/u, "藥品（Medication.code）", "medicine (Medication.code)"],
  [/^Medication(Request|Statement|Administration|Dispense)\.(dosageInstruction|dosage)\.(text|doseAndRate\..*)$/u, "劑量（dosage / doseAndRate）", "dose (dosage / doseAndRate)"],
];

const clip = (s: string, n = 60): string => (s.length > n ? `${s.slice(0, n)}…` : s);

/** Slots whose value R1 examines, with whether nil words (無 / none / N/A / -) count as absence. */
function r1Target(s: Slot): { value: string; allowNil: boolean } | null {
  switch (s.kind) {
    case "identifier":
    case "reference":
    case "ref-display":
    case "name-part":
    case "telecom":
    case "lot":
      return typeof s.value === "string" ? { value: s.value, allowNil: true } : null;
    case "date":
      return typeof s.value === "string" && !FHIR_DATE.test(s.value.trim()) ? { value: s.value, allowNil: true } : null;
    case "quantity":
      return typeof s.value === "string" ? { value: s.value, allowNil: true } : null;
    case "coding": {
      const system = s.holder && typeof s.holder.system === "string" ? s.holder.system : "";
      // codes of HL7 / FHIR code systems (gender unknown, observation-status unknown, NullFlavor UNK) are real codes
      if (HL7_SYSTEM.test(system) || system === "http://unitsofmeasure.org") return null;
      return typeof s.value === "string" ? { value: s.value, allowNil: false } : null;
    }
    case "cc-text":
    case "value-string":
    case "dosage-text":
      return typeof s.value === "string" ? { value: s.value, allowNil: false } : null;
    default:
      return null;
  }
}

interface R1Context {
  axes: RecordCheckOptions["codeAxes"];
  resources: Json[];
}

/** The quantitative-result basis of a value-string slot's Observation (component-aware), or null. */
function resultBasis(s: Slot, ctx: R1Context): string | null {
  if (s.kind !== "value-string") return null;
  const m = /\.component\[(\d+)\]\.valueString$/u.exec(s.path);
  return quantitativeBasis(s.resource, m ? Number(m[1]) : null, ctx.axes, ctx.resources);
}

function r1(s: Slot, ctx: R1Context): RecordIssue | null {
  const t = r1Target(s);
  if (!t) return null;
  const quant = resultBasis(s, ctx);
  // 1.3.0 (ISSUES_v15.4 R1): a result value's reference-range / detection-limit brackets are not content (「未發報 (< 14)」)
  const m = absenceOf(t.value, t.allowNil, { result: quant !== null, limits: s.kind === "value-string" });
  if (!m) return null;
  const main = MAIN_FIELDS.find(([rx]) => rx.test(s.gpath));
  const [fzh, fen] = main ? [main[1], main[2]] : FIELD_LABELS[s.kind] ?? ["欄位", "field"];
  const v = clip(t.value.trim());
  const preds = m.placeholder ? "placeholder" : m.predicates.join(", ");
  const qzh = quant ? `；這個 Observation 的代碼需要數值結果（${quant}），文字並沒有給出結果` : "";
  const qen = quant ? `; this Observation's code needs a quantitative result (${quant}) and the text gives none` : "";
  return makeIssue(
    "R1",
    "error",
    "information-absent",
    s.path,
    `病歷沒有提供這項資訊：${fzh}的值「${v}」是在描述資訊不存在、未定或尚未取得（${preds}），不是資訊本身${qzh}。不要把它當作值；若任務需要這項資訊，請回報 insufficient_information`,
    `The record does not provide this information: the ${fen} value "${v}" describes that the information is absent / not determined / not yet available (${preds}), not the information itself${qen}. Do not use it as the value; if the task needs it, report insufficient_information`,
    `R1 absence recogniser (${RECORD_CHECKS_LEXICON_VERSION}): the whole value is covered by absence predicate(s) [${preds}] plus field nouns / fillers / punctuation, with no other content (no other word, no run of 3+ digits); only this field's own value was examined` +
      (quant ? `; result slot (${quant}): specimen-problem / see-report words and measurement-time qualifiers also count` : ""),
  );
}

/**
 * ISSUES_v15.3 R1: an Observation whose code needs a quantitative result, with no value[x] and no dataAbsentReason, whose
 * note says there is no result (檢體溶血，重抽中 / result pending) — the result is absent, written as a note.
 */
function noteAbsence(root: Json, ctx: R1Context, done: ReadonlySet<string>, withSource = true): RecordIssue[] {
  const out: RecordIssue[] = [];
  for (const r of resourcesOf(root)) {
    const o = r.resource;
    if (o.resourceType !== "Observation" || Object.keys(o).some((k) => k.startsWith("value")) || o.dataAbsentReason !== undefined) continue;
    // 1.3.0 (ISSUES_v15.4 R3): a cancelled / entered-in-error Observation legitimately has no result
    if (o.status === "cancelled" || o.status === "entered-in-error") continue;
    if (Array.isArray(o.component) && o.component.some((c: unknown) => isObj(c) && Object.keys(c).some((k) => k.startsWith("value")))) continue;
    const quant = quantitativeBasis(o, null, ctx.axes, ctx.resources);
    if (!quant) continue;
    (Array.isArray(o.note) ? o.note : []).forEach((n: unknown, i: number) => {
      const path = `${r.base}.note[${i}].text`;
      if (!isObj(n) || typeof n.text !== "string" || done.has(path)) return;
      const m = absenceOf(n.text, false, { result: true });
      if (!m) return;
      // 1.3.0 (ISSUES_v15.4 R3): "not done / declined" is no missing result (the empty-shell check gives it a warning at most)
      const cls = absenceClauses(n.text, { result: true });
      if (cls.length && cls.every((h) => h.cls === "not-done")) return;
      const v = clip(n.text.trim());
      // 1.3.1: without source_text the note is the only evidence — a warning, as the empty-shell rule (emptyShell.ts) gives
      // a shell whose side text states an absence; with source_text it stays an error (v15.3)
      const sev = withSource ? "error" : "warning";
      const unconfirmedZh = withSource ? "" : "（未提供病歷，無法確認病歷是否也這樣記載）";
      const unconfirmedEn = withSource ? "" : " (no record was given, so this is not confirmed against it)";
      out.push(makeIssue(
        "R1", sev, "information-absent", path,
        `病歷沒有提供這項資訊：這個 Observation 沒有結果值（value[x]），note「${v}」說的是沒有結果（${m.predicates.join(", ")}），而它的代碼需要數值結果（${quant}）${unconfirmedZh}。若任務需要這項結果，請回報 insufficient_information`,
        `The record does not provide this information: this Observation has no value[x] and its note "${v}" says there is no result (${m.predicates.join(", ")}), while its code needs a quantitative result (${quant})${unconfirmedEn}. If the task needs the result, report insufficient_information`,
        `R1 absence recogniser (${RECORD_CHECKS_LEXICON_VERSION}) in result mode on Observation.note (the Observation has no value[x] and no dataAbsentReason); the whole note is covered by absence predicates plus nouns / fillers`,
      ));
    });
  }
  return out;
}

function r2(s: Slot, registry: ReturnType<typeof identifierRegistry>, recordText: string | null): RecordIssue | null {
  if (s.kind !== "identifier" || typeof s.value !== "string" || !s.value.trim()) return null;
  const system = s.holder && typeof s.holder.system === "string" ? s.holder.system : null;
  const fmt = registry.formatFor(system);
  const v = clip(s.value.trim());
  if (fmt) {
    const verdict = fmt.check(s.value);
    if (verdict.ok) return null;
    const basis = `R2 identifier registry: ${system} → ${fmt.name} (format${fmt.name.startsWith("site:") ? " from site_config" : " and check digit, TW Core v1.0.0 identifier slice"})`;
    // Only the check digit fails and the record states this exact value: the record itself carries it — a
    // warning (verify the record), not a value the model made up.
    if (verdict.checksum && recordText !== null && recordText.toUpperCase().includes(s.value.trim().toUpperCase())) {
      // recordText = source_text + site_config (a practitioner / facility id lives in the site settings)
      return makeIssue(
        "R2",
        "warning",
        "identifier-format",
        s.path,
        `識別碼檢查碼不符：system ${system} 是${fmt.label_zh}，值「${v}」${verdict.reason_zh}；病歷中寫的就是這個值，請與病歷來源確認`,
        `Identifier check digit: system ${system} is the ${fmt.label}; the value "${v}" — ${verdict.reason}; the record states this exact value, verify it at the source`,
        `${basis}; the value occurs verbatim in source_text, so the severity is warning`,
      );
    }
    return makeIssue(
      "R2",
      "error",
      "identifier-format",
      s.path,
      `識別碼格式不符：system ${system} 是${fmt.label_zh}，值「${v}」${verdict.reason_zh}`,
      `Identifier format: system ${system} is the ${fmt.label}; the value "${v}" — ${verdict.reason}`,
      basis,
    );
  }
  if (sentenceLike(s.value)) {
    return makeIssue(
      "R2",
      "error",
      "identifier-format",
      s.path,
      `識別碼格式不符：值「${v}」是一段敘述，不是識別碼${system ? `（system ${system}）` : ""}。病歷若沒有提供識別碼，請回報 insufficient_information`,
      `Identifier format: the value "${v}" is a sentence, not an identifier${system ? ` (system ${system})` : ""}. If the record gives no identifier, report insufficient_information`,
      "R2 sentence test: 4+ Chinese characters without a run of 3 digits, or 4+ Latin words without any digit",
    );
  }
  return null;
}

/**
 * Run the record checks on a validated instance (a resource, or a Bundle and its entries). Paths
 * follow the validator's: `Bundle.entry[i].resource.…` for a Bundle, `<ResourceType>.…` for a
 * resource. Never throws for any JSON input (a failure inside a rule drops that rule's issues).
 */
export function runRecordChecks(root: Json, opts: RecordCheckOptions = {}): RecordCheckResult {
  const issues: RecordIssue[] = [];
  const notes: string[] = [];
  const registry = identifierRegistry(opts.siteConfig ?? null);
  notes.push(...registry.notes);
  const slots = slotsOf(root);
  const recordText = typeof opts.sourceText === "string" && opts.sourceText.trim() ? opts.sourceText : null;
  const absent = new Set<string>();
  const ctx: R1Context = { axes: opts.codeAxes ?? null, resources: resourcesOf(root).map((r) => r.resource) };
  for (const s of slots) {
    try {
      const a = r1(s, ctx);
      if (a) {
        issues.push(a);
        absent.add(s.path);
        continue; // a sentence of absence is R1 only, never also a format error
      }
      const b = r2(s, registry, recordText === null ? null : `${recordText}\n${opts.siteConfig ?? ""}`);
      if (b) issues.push(b);
    } catch {
      // fail-open per slot
    }
  }
  // ISSUES_v15.4 R1: empty shells — no primary value, the absence explained in a side field (emptyShell.ts). Before the
  // v15.3 result-slot note rule and the diagnosis-slot checks, so a shell the record confirms is reported once, with
  // the record's statement; a v15.3 result-slot error outranks a shell warning on the same resource.
  let shells: RecordIssue[] = [];
  try {
    shells = emptyShellChecks(root, opts, issues);
  } catch {
    notes.push("the empty-shell check could not run on this input (internal error)");
  }
  const shellErrors = shells.filter((i) => i.severity === "error").map((i) => i.path);
  let notes2: RecordIssue[] = [];
  try {
    notes2 = noteAbsence(root, ctx, new Set([...absent, ...shellErrors]), recordText !== null);
  } catch {
    // fail-open
  }
  const resourceOf = (p: string): string => /^(Bundle\.entry\[\d+\]\.resource|[A-Za-z]+)/u.exec(p)?.[1] ?? p;
  const noteResources = new Set(notes2.map((i) => resourceOf(i.path)));
  shells = shells.filter((i) => i.severity === "error" || !noteResources.has(resourceOf(i.path)));
  issues.push(...notes2, ...shells);
  for (const i of [...notes2, ...shells]) if (i.severity === "error") absent.add(i.path);
  const withSource = recordText !== null;
  const rules: RecordRule[] = ["R1", "R2"];
  if (withSource) {
    rules.push("R3", "R4", "R5");
    const site = opts.siteConfig ?? null;
    let covered = new Set<string>();
    let established = new Set<string>();
    try {
      // ISSUES_v15.1 R3: the record's primary diagnosis slot (before the mention-level R4 checks, which skip what it reports)
      const dx = diagnosisSlotChecks(root, new RecordText(opts.sourceText as string, site), absent);
      issues.push(...dx.issues);
      covered = dx.covered;
      established = dx.established;
    } catch {
      notes.push("the primary-diagnosis slot check could not run on this input (internal error)");
    }
    const flagged = new Set<string>(absent);
    try {
      const aware = recordAwareChecks(root, slots, opts.sourceText as string, site, absent, covered, established);
      issues.push(...aware);
      for (const i of aware) flagged.add(i.path);
    } catch {
      notes.push("R3 / R4 could not run on this input (internal error); R1 / R2 results are complete");
    }
    try {
      // ISSUES_v15.1 R1 / R2 / R4: every identifier, date and quantity value must come from the record
      issues.push(...valueGroundingChecks(root, slots, opts.sourceText as string, site, flagged));
    } catch {
      notes.push("R5 (value grounding) could not run on this input (internal error)");
    }
  }
  const errors = issues.filter((i) => i.severity === "error").length;
  const warnings = issues.length - errors;
  return { issues, summary: { ok: errors === 0, errors, warnings, rules, source_text: withSource, ...(notes.length ? { notes } : {}) } };
}

/** Provenance fields of the layer. */
export function recordChecksProvenance(): { recordChecksVersion: string; recordChecksLexicon: string; recordChecksLexiconSha256: string } {
  return { recordChecksVersion: RECORD_CHECKS_VERSION, recordChecksLexicon: RECORD_CHECKS_LEXICON_VERSION, recordChecksLexiconSha256: RECORD_CHECKS_LEXICON_SHA256 };
}
