/**
 * R6 content coverage (ISSUES_v17 R2): with the record text, does the instance say what the record
 * says — no more (negated / cancelled / deferred / excluded items written as done), no twice
 * (duplicate entries), and not only as prose (facts in a text field whose structured element is
 * empty)?
 *
 *   negated-item-present  (error)    an item (medicine, procedure, test, diagnosis, allergy …) the record
 *                                    mentions in a clause that negates it (本次不開立, 未執行, 已停用, 取消,
 *                                    否認, 待排程 …) — or that the conversion target (【轉換目標】 lines) says
 *                                    not to convert — present with a status that says it happened / is active.
 *   duplicate-entry       (error)    two entries with the same content apart from ids, or the same thing
 *                                    (same type and the same identifying fields: concept + time + value / dose).
 *   text-only-fact        (warning; coverageSeverity="error" makes it an error)  Dosage.text (or a medication
 *                                    request's note) states a dose, frequency, route or duration while the
 *                                    corresponding structured element is empty.
 *   record-fact-missing   (warning; coverageSeverity="error" makes it an error)  a fact the record states is
 *                                    absent from the instance: the department, durations, dose / frequency / route,
 *                                    the patient's name (elements the profile marks mustSupport / required), and
 *                                    (ISSUES_v20 R5) the record-derivable facts of recordDerivable.ts wherever the
 *                                    profile has the element and its binding holds the code: Condition.verificationStatus
 *                                    from the diagnosis field (diagnosis-slot parser: plain → confirmed, hedged →
 *                                    provisional, r/o → differential), Observation.interpretation from the value's flag /
 *                                    reference range (H / L / HH / LL / N / A), MedicationRequest.category from the
 *                                    order's setting heading (discharge / outpatient / inpatient).
 *
 * Every R6 rule needs source_text (runRecordChecks runs them only with it).
 *
 * IG-agnostic: item names come from the instance's own codings / texts (and the terminology names the
 * tools looked up); statuses and Dosage elements are those of base FHIR R4, which every IG profiles.
 * The phrase tables (negation cues, frequency / route / duration words) are shared data. Deterministic,
 * no LLM; the record text is never logged.
 */

import { norm } from "../grounding/lexicon.js";
import { RecordText, type Occurrence } from "../grounding/recordText.js";
import { derivableCodes, RECORD_DERIVABLE, type DerivableCode, type RecordDerivableRule } from "../recordDerivable.js";
import { diagnosisSlots, type DxSlot } from "./diagnosisSlot.js";
import { makeIssue } from "./issue.js";
import { resourcesOf } from "./slots.js";
import type { RecordIssue } from "./types.js";
import type { Suggestion } from "../fhirSuggestions/types.js";

type Json = Record<string, any>;
const isObj = (x: unknown): x is Json => !!x && typeof x === "object" && !Array.isArray(x);
const clip = (s: string, n = 80): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// ------------------------------------------------------------------------------------------------ cue tables

export type CueClass = "not-ordered" | "not-done" | "stopped" | "denied" | "pending";

/** Cues AFTER the item in its sentence (Chinese record style: 「Atorvastatin …，本次不開立」). */
const AFTER_CUES: ReadonlyArray<[CueClass, RegExp]> = [
  ["not-ordered", /本次不開立|本次不開|不予開立|不開立|未開立|暫不開立|暫不開|不開藥|不需開立|無須開立|不給藥|未給藥|不再開立|不續開|未續開|家中尚有藥|家中還有藥|not prescribed|not ordered|no refill/iu],
  ["not-done", /未執行|未施行|未做|沒做|未施打|未接種|未給予|未給|未使用|未抽血|未檢驗|未採檢|取消|已取消|撤銷|拒絕|婉拒|拒做|cancel(?:l)?ed|not (?:done|performed|given|administered|taken)|declined|refused/iu],
  ["stopped", /已停用|停用|停藥|已停止|停止使用|自行停藥|已停|暫停使用|暫停|discontinued|\bd\/c\b|stopped|on hold|held/iu],
  ["pending", /待排程|待安排|排程中|擬安排|將安排|尚未安排|預約中|待預約|待追蹤結果|to be scheduled|pending|planned for|will be scheduled/iu],
];
/** Cues right BEFORE the item (否認 X, 取消 X, no X, denies X). */
const BEFORE_CUES: ReadonlyArray<[CueClass, RegExp]> = [
  ["denied", /(否認|沒有|denies|denied|no known|no history of|negative for|\bno)\s*[:：]?\s*$/iu],
  ["not-done", /(取消|未做|未執行|未施打|未接種|拒絕|cancel(?:l)?ed)\s*$/iu],
  ["stopped", /(停用|停止|停|d\/c|discontinue[ds]?)\s*$/iu],
  ["not-ordered", /(不開立|未開立|不開|不給)\s*$/iu],
];
/** A change of subject inside a sentence: what follows is about something else (改用 B …). */
const TURN = /改用|改為|改開|改成|換成|換為|轉為|另開|但|然而|instead|switch(?:ed)? to|changed to|replaced by/iu;
/** Sentence ends (a cue never reaches across them). */
const SENTENCE_END = /[。；;!?！？\n]/u;

/** Conversion-target statements that exclude items (【轉換目標】 lines). */
const EXCLUDE_CUE = /不需轉換|不用轉換|不必轉換|不須轉換|無須轉換|無需轉換|勿轉換|不要轉換|不轉換|不需納入|不納入|不用寫|不需寫|排除|除外|do not (?:convert|include)|exclude[ds]?|not to be (?:converted|included)/iu;

/** Status values that say the item did not happen / is not in force (base FHIR R4 status value sets). */
const NEGATIVE_STATUS = new Set(["cancelled", "stopped", "on-hold", "not-done", "entered-in-error", "revoked", "draft", "not-taken", "inactive", "suspended", "rejected", "declined"]);
/** Status values of an item that happened / is in force. */
const DONE_STATUS = new Set(["completed", "final", "amended", "corrected", "appended"]);
const ACTIVE_STATUS = new Set(["active", "in-progress", "preparation", "intended", "accepted", "booked", "arrived", "fulfilled"]);

/** Resource types that are entities / containers, not items a record negates. */
const NOT_ITEMS = new Set(["Bundle", "Composition", "Patient", "Practitioner", "PractitionerRole", "Organization", "Location", "Encounter", "Coverage", "Claim", "ClaimResponse", "RelatedPerson", "Device", "Endpoint", "HealthcareService", "Provenance", "DocumentReference", "Binary", "Media", "MessageHeader", "List"]);

// ------------------------------------------------------------------------------------------------ item names

const NAME_KEYS = ["code", "medicationCodeableConcept", "vaccineCode", "productOrService", "substance", "item"];

function ccNames(cc: unknown, out: Set<string>, lookups?: ReadonlyMap<string, readonly string[]> | null): void {
  if (!isObj(cc)) return;
  if (typeof cc.text === "string") out.add(cc.text);
  if (typeof cc.display === "string") out.add(cc.display);
  const codings = Array.isArray(cc.coding) ? cc.coding : isObj(cc) && typeof cc.code === "string" ? [cc] : [];
  for (const c of codings) {
    if (!isObj(c)) continue;
    if (typeof c.display === "string") out.add(c.display);
    const more = lookups?.get(`${c.system ?? ""}|${c.code ?? ""}`);
    for (const n of more ?? []) out.add(n);
  }
}

/** The names an item resource is called by: its coded concepts' displays / texts (+ looked-up names), a referenced Medication's code. */
export function itemNames(res: Json, root: Json, lookups?: ReadonlyMap<string, readonly string[]> | null): string[] {
  const raw = new Set<string>();
  for (const k of NAME_KEYS) {
    const v = res[k];
    for (const x of Array.isArray(v) ? v : [v]) ccNames(x, raw, lookups);
  }
  const ref = isObj(res.medicationReference) ? res.medicationReference.reference : null;
  if (typeof ref === "string") {
    const med = resolveRef(ref, root, res);
    if (med) ccNames(med.code, raw, lookups);
  }
  const out = new Set<string>();
  for (const n0 of raw) {
    const n = n0.trim();
    if (!n) continue;
    out.add(n);
    // a drug name with strength / form after it: its leading word (Atorvastatin 20 mg → Atorvastatin)
    const lead = /^([A-Za-z][A-Za-z\-]{4,})\b/u.exec(n)?.[1];
    if (lead && lead.length < n.length) out.add(lead);
    // a name with a bracketed alias: both parts (立普妥 (Atorvastatin) …)
    for (const m of n.matchAll(/[（(]([^）)]{2,40})[）)]/gu)) out.add(m[1].trim());
    const head = n.replace(/[（(][^）)]*[）)]/gu, "").trim();
    if (head && head !== n) out.add(head);
  }
  return [...out].filter((n) => {
    const k = norm(n);
    return /\p{Script=Han}/u.test(k) ? k.length >= 2 : k.replace(/[^a-z0-9]/gu, "").length >= 4;
  });
}

function resolveRef(ref: string, root: Json, holder: Json): Json | null {
  if (ref.startsWith("#") && Array.isArray(holder.contained)) return holder.contained.find((c: Json) => isObj(c) && `#${c.id}` === ref) ?? null;
  if (root.resourceType !== "Bundle" || !Array.isArray(root.entry)) return null;
  for (const e of root.entry) {
    if (!isObj(e) || !isObj(e.resource)) continue;
    if (e.fullUrl === ref || `${e.resource.resourceType}/${e.resource.id}` === ref) return e.resource;
  }
  return null;
}

// ------------------------------------------------------------------------------------------------ status

const codeOf = (cc: unknown): string | null => {
  if (!isObj(cc)) return null;
  const c = Array.isArray(cc.coding) ? cc.coding.find((x: unknown) => isObj(x) && typeof x.code === "string") : null;
  return c ? String(c.code) : null;
};

/** How the instance states the item: done / active (a claim the record must support) or not in force. */
export function itemState(res: Json): { stated: "done" | "active" | "negative" | "unknown"; path: string; value: string | null } {
  if (res.doNotPerform === true) return { stated: "negative", path: "doNotPerform", value: "true" };
  const ver = codeOf(res.verificationStatus);
  if (ver === "refuted" || ver === "entered-in-error") return { stated: "negative", path: "verificationStatus", value: ver };
  const clin = codeOf(res.clinicalStatus);
  if (clin && ["inactive", "resolved", "remission"].includes(clin)) return { stated: "negative", path: "clinicalStatus", value: clin };
  const st = typeof res.status === "string" ? res.status : null;
  if (st && NEGATIVE_STATUS.has(st)) return { stated: "negative", path: "status", value: st };
  if (st && DONE_STATUS.has(st)) return { stated: "done", path: "status", value: st };
  if (st && ACTIVE_STATUS.has(st)) return { stated: "active", path: "status", value: st };
  if (clin === "active" || clin === "recurrence" || clin === "relapse") return { stated: "active", path: "clinicalStatus", value: clin };
  if (!st && ver === "confirmed") return { stated: "active", path: "verificationStatus", value: ver };
  return { stated: st || clin || ver ? "unknown" : "active", path: st ? "status" : "", value: st };
}

/** Whether the stated state contradicts the record's cue. `pending` contradicts only "done". */
function contradicts(cue: CueClass, stated: ReturnType<typeof itemState>["stated"]): boolean {
  if (stated === "negative" || stated === "unknown") return false;
  if (cue === "pending") return stated === "done";
  return true;
}

/** What to write instead, by base resource type (base FHIR R4 status codes). */
function fixFor(rt: string, cue: CueClass): string {
  const status: Record<string, Record<CueClass, string>> = {
    MedicationRequest: { "not-ordered": "omit the entry (nothing was prescribed), or status cancelled / doNotPerform true", "not-done": "status cancelled", stopped: "status stopped", denied: "omit the entry", pending: "status draft / on-hold" },
    MedicationStatement: { "not-ordered": "status not-taken", "not-done": "status not-taken", stopped: "status stopped", denied: "status not-taken", pending: "status intended" },
    MedicationAdministration: { "not-ordered": "omit the entry", "not-done": "status not-done", stopped: "status stopped", denied: "status not-done", pending: "omit the entry (not given yet)" },
    MedicationDispense: { "not-ordered": "omit the entry", "not-done": "status cancelled / declined", stopped: "status stopped", denied: "status declined", pending: "status preparation" },
    Procedure: { "not-ordered": "omit the entry", "not-done": "status not-done", stopped: "status stopped", denied: "status not-done", pending: "status preparation, or a ServiceRequest instead" },
    Immunization: { "not-ordered": "status not-done", "not-done": "status not-done", stopped: "status not-done", denied: "status not-done", pending: "omit the entry (not given yet)" },
    Observation: { "not-ordered": "omit the entry", "not-done": "status cancelled", stopped: "status cancelled", denied: "omit the entry, or a negative result if the record states one", pending: "status registered (no value yet)" },
    ServiceRequest: { "not-ordered": "status revoked / omit the entry", "not-done": "status revoked", stopped: "status revoked", denied: "omit the entry", pending: "status draft / active (requested, not done)" },
    Condition: { "not-ordered": "omit the entry", "not-done": "omit the entry", stopped: "clinicalStatus inactive / resolved", denied: "verificationStatus refuted, or omit the entry", pending: "verificationStatus provisional" },
    AllergyIntolerance: { "not-ordered": "omit the entry", "not-done": "omit the entry", stopped: "clinicalStatus inactive", denied: "verificationStatus refuted, or omit the entry", pending: "verificationStatus unconfirmed" },
  };
  return status[rt]?.[cue] ?? (cue === "pending" ? "a status that says it has not happened yet" : "omit the entry, or a status that says it did not happen");
}

// ------------------------------------------------------------------------------------------------ negated items

interface Mention {
  occ: Occurrence;
  cue: CueClass;
  cueText: string;
  sentence: string;
}

/** Resource types a medication-stop cue (停藥 / 停用 / discontinued / on hold) can be about (v20.1). */
const MEDICATION_TYPES = new Set(["MedicationRequest", "MedicationStatement", "MedicationAdministration", "MedicationDispense", "Medication"]);

/**
 * v20.1: whether a cue class applies to a resource type. A stop cue is about a medicine: 「體重 58 kg，Aspirin 停藥」 says
 * nothing about the body-weight Observation (it never gets a status change suggestion from it).
 */
function cueApplies(cls: CueClass, rtype: string | null): boolean {
  return cls !== "stopped" || rtype === null || MEDICATION_TYPES.has(rtype);
}

/** The sentence around an occurrence and the record's cue about the item in it (null when none). */
function cueAt(rt: RecordText, occ: Occurrence, otherNames: readonly string[], rtype: string | null = null): Mention | null {
  const text = rt.text;
  let s = occ.start;
  while (s > 0 && !SENTENCE_END.test(text[s - 1])) s--;
  let e = occ.end;
  while (e < text.length && !SENTENCE_END.test(text[e])) e++;
  const sentence = text.slice(s, e).trim();
  // after the item: up to a change of subject or the next other item named in the same sentence
  let after = text.slice(occ.end, e);
  const turn = TURN.exec(after);
  if (turn) after = after.slice(0, turn.index);
  const na = norm(after);
  for (const o of otherNames) {
    const k = norm(o);
    const at = k.length >= 2 ? na.indexOf(k) : -1;
    if (at >= 0) {
      // cut where the other item starts (approximate on the raw text by ratio — the normalised text is shorter)
      after = after.slice(0, Math.max(0, Math.floor((at / Math.max(1, na.length)) * after.length)));
    }
  }
  after = after.slice(0, 80);
  for (const [cls, re] of AFTER_CUES) {
    if (!cueApplies(cls, rtype)) continue;
    const m = re.exec(after);
    if (m) return { occ, cue: cls, cueText: m[0], sentence };
  }
  const before = text.slice(Math.max(s, occ.start - 12), occ.start);
  for (const [cls, re] of BEFORE_CUES) {
    if (!cueApplies(cls, rtype)) continue;
    const m = re.exec(before);
    if (m) return { occ, cue: cls, cueText: m[1] ?? m[0], sentence };
  }
  return null;
}

/**
 * v20.1: what the conversion target names as INCLUDED — every instruction line (【轉換目標】 …) with its exclusion clauses
 * removed. An item named here is never "excluded by the target", whichever line the exclusion is on.
 */
export function targetIncludedText(rt: RecordText): string {
  const out: string[] = [];
  for (const l of rt.lines) {
    if (l.section !== "instruction") continue;
    const line = l.line.replace(/【[^】]*】/gu, " ");
    out.push(line.split(/[，,；;。]/u).filter((c) => !EXCLUDE_CUE.test(c)).join(" "));
  }
  return out.join(" ");
}

/** Item names the conversion target excludes (【轉換目標】 lines with 不需轉換 / 排除 …): only the clause that carries the cue. */
export function excludedByTarget(rt: RecordText): Array<{ phrase: string; line: string; others: boolean; included: string }> {
  const out: Array<{ phrase: string; line: string; others: boolean; included: string }> = [];
  const cueG = new RegExp(EXCLUDE_CUE.source, "iu");
  for (const l of rt.lines) {
    if (l.section !== "instruction" || !EXCLUDE_CUE.test(l.line)) continue;
    const line = l.line.replace(/【[^】]*】/gu, " ");
    // what the target does include: the clauses without an exclusion cue (an item named there is never excluded)
    const included = line.split(/[，,；;。]/u).filter((c) => !EXCLUDE_CUE.test(c)).join(" ");
    for (const clause of line.split(/[，,；;。]/u)) {
      const m = cueG.exec(clause);
      if (!m) continue;
      // the items: before the cue (「A、B 不需轉換」), else after it (「排除：A、B」「不需轉換：A」)
      const before = clause.slice(0, m.index);
      const after = clause.slice(m.index + m[0].length);
      const clean = (x: string): string =>
        x.replace(/[：:]/gu, " ").replace(/^\s*(其中|另外|其餘|其他|病歷中的?|以下|上述|但|而|另|則|的|之)+/u, "").replace(/(項目|部分|資料|資訊|紀錄|記錄|的|之|均|都|皆|則|也)+\s*$/u, "").trim();
      const pick = clean(before) ? before : after;
      // 「其他 / 其餘 X 不需轉換」: only the X the target does not name — a category word then excludes nothing by itself
      const others = /^\s*(其他|其餘|其它|另外的|other|remaining)/iu.test(pick);
      for (const part of pick.split(/[、/]|及|與|和|以及|\band\b/u)) {
        const p = clean(part).replace(/^(其他|其餘|其它)/u, "").trim();
        if (norm(p).length >= 2 && !/轉換|bundle|fhir|請|將/iu.test(p)) out.push({ phrase: p, line: l.line.trim(), others, included });
      }
    }
  }
  return out;
}

/** Category words of a conversion target → the base resource types they name (shared phrase table, base FHIR types). */
const CATEGORY_TYPES: ReadonlyArray<[RegExp, readonly string[]]> = [
  [/過敏|allerg/iu, ["AllergyIntolerance"]],
  [/家族史|family history/iu, ["FamilyMemberHistory"]],
  [/疫苗|預防接種|接種|immuni[sz]ation|vaccin/iu, ["Immunization"]],
  [/生命徵象|vital/iu, ["Observation"]],
  [/檢驗|檢查|化驗|實驗室|lab(?:oratory)?\b/iu, ["Observation", "DiagnosticReport", "Specimen"]],
  [/用藥|藥物|藥品|處方|medication|prescription/iu, ["MedicationRequest", "MedicationStatement", "MedicationAdministration", "MedicationDispense", "Medication"]],
  [/手術|處置|procedure/iu, ["Procedure"]],
  [/診斷|diagnos/iu, ["Condition"]],
  [/影像|imaging/iu, ["ImagingStudy", "DiagnosticReport"]],
];

/** Base resource types a phrase names as a category (過敏史 → AllergyIntolerance), when the phrase is only a category word. */
function categoryTypes(phrase: string): readonly string[] {
  const p = phrase.replace(/史|資料|紀錄|記錄|項目|部分|結果|報告|資訊|清單|list|records?|history/giu, "").trim();
  for (const [re, types] of CATEGORY_TYPES) {
    const m = re.exec(p);
    // a bare category word only: a qualifier (疑似診斷, 過去接種紀錄, 延後的疫苗) names a subset, not the whole category
    if (m && p.replace(m[0], "").replace(/[的之]/gu, "").trim().length === 0) return types;
  }
  return [];
}

export function negatedItemChecks(root: Json, recordText: string, siteConfig: string | null, lookups?: ReadonlyMap<string, readonly string[]> | null): RecordIssue[] {
  const rt = new RecordText(recordText, siteConfig);
  const items = resourcesOf(root).filter((r) => !NOT_ITEMS.has(String(r.resource.resourceType)));
  const named = items.map((r) => ({ ...r, names: itemNames(r.resource, root, lookups) }));
  const excluded = excludedByTarget(rt);
  const targetIncl = excluded.length ? norm(targetIncludedText(rt)) : "";
  const out: RecordIssue[] = [];
  for (const it of named) {
    if (!it.names.length && !excluded.length) continue;
    const rtype = String(it.resource.resourceType);
    const state = itemState(it.resource);
    const others = named.filter((o) => o !== it).flatMap((o) => o.names).filter((n) => !it.names.some((m) => norm(m).includes(norm(n)) || norm(n).includes(norm(m))));
    const statePath = state.path ? `${it.base}.${state.path}` : it.base;
    // 1. the conversion target says not to convert it
    // v20.1: named in ANY include clause of the target (not only the exclusion's own line) → never excluded
    const namedInTarget = (x: { included: string }): boolean => it.names.some((n) => norm(n).length >= 2 && (norm(x.included).includes(norm(n)) || targetIncl.includes(norm(n))));
    const ex = excluded.find(
      (x) =>
        !namedInTarget(x) &&
        ((!x.others && categoryTypes(x.phrase).includes(rtype)) ||
        it.names.some((n) => {
          const a = norm(n);
          const b = norm(x.phrase);
          return a.length >= 2 && b.length >= 2 && (a.includes(b) || b.includes(a));
        })),
    );
    if (ex) {
      out.push(makeIssue(
        "R6", "error", "negated-item-present", it.base,
        `轉換目標排除了這個項目：${rtype}（${clip(it.names[0] ?? rtype, 40)}）不應出現在 Bundle 中（轉換目標：「${clip(ex.line, 80)}」）。請對照病歷與轉換目標確認`,
        `The conversion target excludes this item: ${rtype} (${clip(it.names[0] ?? rtype, 40)}) must not be in the Bundle (target: "${clip(ex.line, 80)}"). Verify against the record and the target`,
        `R6 conversion-target exclusion: an 【轉換目標】 line with an exclusion cue names '${clip(ex.phrase, 40)}', which matches the item's name`,
        [ex.line],
      ));
      continue;
    }
    if (!it.names.length) continue;
    // an Observation without a value that documents why (dataAbsentReason / note) already says it was not done
    if (rtype === "Observation" && !Object.keys(it.resource).some((k) => k.startsWith("value")) && (it.resource.dataAbsentReason || Array.isArray(it.resource.note))) continue;
    // 2. the record negates / cancels / defers it while the instance states it as done / active
    let hit: Mention | null = null;
    let positive = false;
    for (const n of it.names) {
      for (const occ of rt.find(n)) {
        if (occ.origin !== "record" || occ.section === "instruction") continue;
        const m = cueAt(rt, occ, others, rtype);
        if (!m) positive = true;
        else if (!hit) hit = m;
      }
    }
    // the item is also mentioned plainly elsewhere (ordered on another line, e.g. a new prescription): not decidable
    if (!hit || positive || !contradicts(hit.cue, state.stated)) continue;
    const said = state.value ? `${state.path} = ${state.value}` : "an active / completed item (no status that says otherwise)";
    const fix = fixFor(rtype, hit.cue);
    const cueZh: Record<CueClass, string> = { "not-ordered": "沒有開立", "not-done": "沒有執行 / 已取消", stopped: "已停用", denied: "否認 / 沒有", pending: "尚未執行（待排程）" };
    out.push(withSuggestion(makeIssue(
      "R6", "error", "negated-item-present", statePath,
      `病歷表示這個項目${cueZh[hit.cue]}（「${clip(hit.sentence, 90)}」，關鍵字「${hit.cueText}」），但 ${rtype}（${clip(it.names[0], 40)}）寫成 ${said}。建議：${fix}`,
      `The record says this item was ${hit.cue === "pending" ? "not done yet" : hit.cue.replace("-", " ")} ("${clip(hit.sentence, 90)}", cue "${hit.cueText}"), but the ${rtype} (${clip(it.names[0], 40)}) states ${said}. Suggested: ${fix}`,
      `R6 negated item: the item's name occurs in the record only inside a clause with a ${hit.cue} cue (after the name up to a change of subject, or right before it); the instance's status / doNotPerform / verificationStatus / clinicalStatus was compared`,
      [hit.sentence],
    ), /omit the entry/u.test(fix) && !/status/u.test(fix.split(",")[0])
      ? { value: "remove entry", kind: "remove_entry", confidence: 0.7, reason: fix, patch: { op: "remove", path: it.base.replace(/\.resource$/u, "") } }
      : { value: fix, kind: "replace_value", confidence: 0.6, reason: fix }));
  }
  return out;
}

function withSuggestion(i: RecordIssue, s: Suggestion | null): RecordIssue {
  if (s) i.suggestions = [s];
  return i;
}

// ------------------------------------------------------------------------------------------------ duplicates

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

/** Content without identity: id, meta, text (narrative) and identifier values removed at the resource root. */
function contentKey(res: Json): string {
  const o: Json = {};
  for (const [k, v] of Object.entries(res)) if (!["id", "meta", "text", "identifier"].includes(k)) o[k] = v;
  return stable(o);
}

const conceptKey = (cc: unknown): string | null => {
  if (!isObj(cc)) return null;
  const codes = (Array.isArray(cc.coding) ? cc.coding : []).filter((c: unknown) => isObj(c) && typeof c.code === "string").map((c: Json) => `${c.system ?? ""}|${c.code}`).sort();
  if (codes.length) return codes.join(",");
  return typeof cc.text === "string" && cc.text.trim() ? `text:${norm(cc.text)}` : null;
};
const firstOf = (...v: unknown[]): unknown => v.find((x) => x !== undefined && x !== null);

/** "The same thing" by base resource type: the identifying fields (null = compare by content only). */
function sameThingKey(res: Json): string | null {
  const rt = String(res.resourceType);
  const subj = isObj(res.subject) ? res.subject.reference ?? "" : isObj(res.patient) ? res.patient.reference ?? "" : "";
  switch (rt) {
    case "Condition": {
      const c = conceptKey(res.code);
      return c ? `${rt}|${subj}|${c}` : null;
    }
    case "AllergyIntolerance": {
      const c = conceptKey(res.code);
      return c ? `${rt}|${subj}|${c}` : null;
    }
    case "Observation": {
      const c = conceptKey(res.code);
      if (!c) return null;
      const t = stable(firstOf(res.effectiveDateTime, res.effectivePeriod, res.effectiveInstant, res.issued) ?? null);
      const val = stable(firstOf(res.valueQuantity, res.valueCodeableConcept, res.valueString, res.valueBoolean, res.valueInteger, res.component) ?? null);
      return `${rt}|${subj}|${c}|${t}|${val}`;
    }
    case "MedicationRequest":
    case "MedicationStatement":
    case "MedicationAdministration":
    case "MedicationDispense": {
      const med = conceptKey(res.medicationCodeableConcept) ?? (isObj(res.medicationReference) ? `ref:${res.medicationReference.reference ?? ""}` : null);
      if (!med) return null;
      const dosage = stable(firstOf(res.dosageInstruction, res.dosage) ?? null);
      return `${rt}|${subj}|${med}|${dosage}|${res.intent ?? ""}`;
    }
    case "Procedure":
    case "Immunization": {
      const c = conceptKey(firstOf(res.code, res.vaccineCode));
      if (!c) return null;
      return `${rt}|${subj}|${c}|${stable(firstOf(res.performedDateTime, res.performedPeriod, res.occurrenceDateTime, res.occurrenceString) ?? null)}`;
    }
    case "Encounter":
      return `${rt}|${subj}|${stable(res.period ?? null)}|${stable(res.class ?? null)}`;
    default:
      return null;
  }
}

export function duplicateEntryChecks(root: Json): RecordIssue[] {
  if (!isObj(root) || root.resourceType !== "Bundle") return [];
  const out: RecordIssue[] = [];
  const seenContent = new Map<string, { base: string; entry: number | null }>();
  const seenThing = new Map<string, { base: string; entry: number | null }>();
  for (const r of resourcesOf(root)) {
    const rt = String(r.resource.resourceType);
    const ck = `${rt}|${contentKey(r.resource)}`;
    const first = seenContent.get(ck);
    const tk = sameThingKey(r.resource);
    const firstThing = tk ? seenThing.get(tk) : undefined;
    const prior = first ?? firstThing;
    if (prior) {
      const same = first ? "內容相同（只有 id 不同）" : "代表同一件事（相同的代碼、時間與數值 / 劑量）";
      const sameEn = first ? "the same content apart from ids" : "the same thing (same concept, time and value / dose)";
      out.push(withSuggestion(makeIssue(
        "R6", "error", "duplicate-entry", r.base,
        `重複的 entry：這個 ${rt} 與 entry[${prior.entry}] ${same}。請只保留一筆，並把指向它的 reference 改指向保留的那筆`,
        `Duplicate entry: this ${rt} is ${sameEn} as entry[${prior.entry}]. Keep one, and point references to it`,
        first ? "R6 duplicate: resource content compared without id / meta / text / identifier" : "R6 duplicate: identifying fields by base resource type (Condition / AllergyIntolerance: subject + code; Observation: + time + value; medication resources: + medicine + dosage + intent; Procedure / Immunization: + time; Encounter: period + class)",
      ), { value: "remove entry", kind: "remove_entry", confidence: first ? 0.9 : 0.7, reason: `duplicate of entry[${prior.entry}]`, patch: { op: "remove", path: r.base.replace(/\.resource$/u, "") } }));
      continue;
    }
    seenContent.set(ck, { base: r.base, entry: r.entry });
    if (tk) seenThing.set(tk, { base: r.base, entry: r.entry });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ text-only facts

const UCUM_UNITS: Record<string, string> = { mg: "mg", g: "g", mcg: "ug", "μg": "ug", ug: "ug", ml: "mL", "㏄": "mL", cc: "mL", l: "L", iu: "[iU]", "[iu]": "[iU]", "[u]": "U", u: "U", meq: "meq", mmol: "mmol" };
/** Dose: a number with a mass / volume / count unit (500 mg, 1#, 2 顆, 1 tab). */
const RE_DOSE = /(\d+(?:\.\d+)?)\s*(mg|mcg|μg|ug|g|ml|㏄|cc|\[i?u\]|iu|meq|mmol|u|#|tab(?:let)?s?|cap(?:sule)?s?|顆|錠|粒|片|包|支|滴|puffs?|噴|單位)(?![a-z])/iu;
/** Frequency abbreviations / words → v3-GTSAbbreviation code (asNeeded for PRN). */
const FREQ: ReadonlyArray<[RegExp, string]> = [
  [/\bQ\.?D\b|\bQDAY\b|每日一次|一天一次|每天一次|1次\/日|每日1次/iu, "QD"],
  [/\bB\.?I\.?D\b|每日兩次|每日二次|一天兩次|一天二次|每日2次|2次\/日/iu, "BID"],
  [/\bT\.?I\.?D\b|每日三次|一天三次|每日3次|3次\/日/iu, "TID"],
  [/\bQ\.?I\.?D\b|每日四次|一天四次|每日4次|4次\/日/iu, "QID"],
  [/\bQOD\b|隔日一次|每兩天一次/iu, "QOD"],
  [/\bQ\s?(4|6|8|12)\s?H\b|每\s?(4|6|8|12)\s?小時/iu, "Q#H"],
  [/\bHS\b|睡前/iu, "HS"],
  [/\bQW\b|每週一次|一週一次/iu, "WK"],
  [/\bPRN\b|需要時|必要時|有需要時/iu, "PRN"],
];
const ROUTE = /\b(PO|IV|IM|SC|SQ|SL|INH|TOP|PR|IVD|IVP|ID|EXT)\b|口服|靜脈|肌肉注射|肌注|皮下|舌下|吸入|外用|塗抹|肛門|直腸|點眼|眼用|鼻用|局部/iu;
const DURATION = /(?:共|x|×|\*|for)\s*(\d{1,3})\s*(天|日|days?|d|週|weeks?|wk)\b|(\d{1,3})\s*(天份|日份|天|日|days?)(?:\s*(?:份|量))?/iu;

/** The Dosage nodes of a medication resource with their paths. */
function dosagesOf(res: Json, base: string): Array<{ d: Json; path: string }> {
  const out: Array<{ d: Json; path: string }> = [];
  for (const k of ["dosageInstruction", "dosage"]) {
    const v = res[k];
    if (Array.isArray(v)) v.forEach((d, i) => isObj(d) && out.push({ d, path: `${base}.${k}[${i}]` }));
    else if (isObj(v)) out.push({ d: v, path: `${base}.${k}` });
  }
  return out;
}

function hasTiming(d: Json): boolean {
  const t = d.timing;
  return isObj(t) && (isObj(t.code) || isObj(t.repeat) || Array.isArray(t.event));
}

export function textOnlyFactChecks(root: Json, severity: "warning" | "error", recordText: string | null): RecordIssue[] {
  const out: RecordIssue[] = [];
  const rt = recordText ? new RecordText(recordText, null) : null;
  const quoteFor = (text: string): string[] => {
    if (!rt) return [];
    const o = rt.find(text).find((x) => x.origin === "record" && x.section !== "instruction");
    return o ? [o.line.trim()] : [];
  };
  for (const r of resourcesOf(root)) {
    const rtype = String(r.resource.resourceType);
    if (!/^Medication(Request|Statement|Administration|Dispense)$/u.test(rtype)) continue;
    for (const { d, path } of dosagesOf(r.resource, r.base)) {
      const text = typeof d.text === "string" ? d.text : "";
      if (!text.trim()) continue;
      const facts: Array<{ field: string; zh: string; value: string; patch?: unknown }> = [];
      const dose = RE_DOSE.exec(text);
      const doseSet = Array.isArray(d.doseAndRate) ? d.doseAndRate.some((x: unknown) => isObj(x) && (x.doseQuantity || x.doseRange)) : isObj(d.dose);
      if (dose && !doseSet) {
        const u = dose[2].toLowerCase();
        const ucum = UCUM_UNITS[u];
        facts.push({
          field: rtype === "MedicationAdministration" ? "dose" : "doseAndRate[0].doseQuantity",
          zh: "單次劑量",
          value: `${dose[1]} ${dose[2]}`,
          patch: { value: Number(dose[1]), unit: dose[2], ...(ucum ? { system: "http://unitsofmeasure.org", code: ucum } : {}) },
        });
      }
      const freq = FREQ.find(([re]) => re.test(text));
      if (freq && !hasTiming(d) && !(freq[1] === "PRN" && (d.asNeededBoolean !== undefined || d.asNeededCodeableConcept))) {
        const m = freq[0].exec(text)!;
        const code = freq[1] === "Q#H" ? `Q${m[1] ?? m[2]}H` : freq[1];
        facts.push(
          code === "PRN"
            ? { field: "asNeededBoolean", zh: "需要時使用（PRN）", value: m[0], patch: true }
            : { field: "timing.code", zh: "頻次", value: m[0], patch: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation", code }] } },
        );
      }
      const route = ROUTE.exec(text);
      if (route && !isObj(d.route) && rtype !== "MedicationAdministration") facts.push({ field: "route", zh: "給藥途徑", value: route[0] });
      if (route && rtype === "MedicationAdministration" && !isObj(d.route)) facts.push({ field: "route", zh: "給藥途徑", value: route[0] });
      const dur = DURATION.exec(text);
      if (dur && rtype === "MedicationRequest") {
        const n = Number(dur[1] ?? dur[3]);
        const unitRaw = (dur[2] ?? dur[4] ?? "").toLowerCase();
        const weeks = /週|week|wk/u.test(unitRaw);
        const supply = isObj(r.resource.dispenseRequest) && isObj(r.resource.dispenseRequest.expectedSupplyDuration);
        const bounds = isObj(d.timing) && isObj(d.timing.repeat) && (isObj(d.timing.repeat.boundsDuration) || isObj(d.timing.repeat.boundsPeriod));
        if (!supply && !bounds && n > 0) {
          facts.push({ field: "(MedicationRequest.)dispenseRequest.expectedSupplyDuration", zh: "給藥天數", value: dur[0].trim(), patch: { value: weeks ? n * 7 : n, unit: "days", system: "http://unitsofmeasure.org", code: "d" } });
        }
      }
      for (const f of facts) {
        const fieldPath = f.field.startsWith("(MedicationRequest.)") ? `${r.base}.${f.field.slice("(MedicationRequest.)".length)}` : `${path}.${f.field}`;
        const sugg: Suggestion = {
          value: f.patch !== undefined ? JSON.stringify(f.patch) : f.value,
          kind: "add_value",
          confidence: f.patch !== undefined ? 0.6 : 0.4,
          reason: f.patch !== undefined
            ? `structured ${f.field} for "${f.value}" (check the unit / code against the profile's binding)`
            : `code "${f.value}" with fhir_normalize_code(text, value_set=<the element's bound ValueSet>)`,
          ...(f.patch !== undefined ? { patch: { op: "add" as const, path: fieldPath, value: f.patch } } : {}),
        };
        out.push(withSuggestion(makeIssue(
          "R6", severity, "text-only-fact", fieldPath,
          `${f.zh}只寫在文字欄位：${path.split(".").slice(-1)[0]}.text「${clip(text, 60)}」寫了「${f.value}」，但結構化的 ${f.field.replace("(MedicationRequest.)", "")} 是空的。請同時寫入結構化欄位`,
          `${f.zh === "頻次" ? "Frequency" : f.zh === "單次劑量" ? "Dose" : f.zh === "給藥途徑" ? "Route" : f.zh === "給藥天數" ? "Supply duration" : "As-needed"} written only as text: Dosage.text "${clip(text, 60)}" states "${f.value}" while the structured ${f.field.replace("(MedicationRequest.)", "")} is empty. Write the structured element as well`,
          "R6 text-only fact: Dosage.text scanned for dose (number + unit), frequency (QD / BID / … / 每日兩次), route (PO / IV / 口服 …) and duration (共 28 天 / x7d); the structured Dosage / dispenseRequest element was empty",
          quoteFor(text),
        ), sugg));
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ record facts left out

/**
 * Per declared profile: the element paths it marks mustSupport / requires / its examples commonly carry / prohibits,
 * and (ISSUES_v20 R5, optional) the binding of each record-derivable element (recordDerivable.ts): its ValueSet and,
 * for a ValueSet other than the base one, its expansion (null = not expandable). Absent → the base binding.
 */
export type ProfileElements = ReadonlyMap<string, { mustSupport: ReadonlySet<string>; required: ReadonlySet<string>; common?: ReadonlySet<string>; prohibited?: ReadonlySet<string>; bindings?: ReadonlyMap<string, { valueSet: string | null; codes: readonly DerivableCode[] | null }> }>;

/** Clinical departments (shared phrase table; longest first so 心臟內科 wins over 內科). */
const DEPARTMENTS = [
  "家庭醫學科", "家醫科", "一般內科", "心臟血管內科", "心臟內科", "心臟外科", "胃腸肝膽科", "腸胃內科", "腸胃科", "消化內科", "胸腔內科", "胸腔外科", "胸腔科",
  "腎臟內科", "腎臟科", "新陳代謝科", "內分泌科", "風濕免疫科", "過敏免疫風濕科", "感染科", "血液腫瘤科", "腫瘤內科", "放射腫瘤科", "神經內科", "神經外科",
  "精神科", "身心科", "小兒科", "兒科", "婦產科", "婦科", "產科", "骨科", "眼科", "耳鼻喉科", "皮膚科", "泌尿科", "一般外科", "整形外科", "大腸直腸外科",
  "急診醫學科", "急診科", "復健科", "牙科", "口腔外科", "中醫科", "老年醫學科", "疼痛科", "麻醉科", "職業醫學科", "內科", "外科",
].sort((a, b) => b.length - a.length);
const FLAG_HH = /(?:\bHH\b|↑↑|critical(?:ly)? high|panic high|危急值?偏高)/iu;
const FLAG_LL = /(?:\bLL\b|↓↓|critical(?:ly)? low|panic low|危急值?偏低)/iu;
const FLAG_HIGH = /(?:\b[HＨ]\b|↑|偏高|過高|高於|上升|elevated|\bhigh\b)/iu;
const FLAG_LOW = /(?:\b[LＬ]\b|↓|偏低|過低|低於|下降|\blow\b)/iu;
/** An abnormal mark without a direction (「12.5*」「12.5 (*)」). */
const FLAG_STAR = /^\s*[（(]?\s*[*＊]/u;
const DISCHARGE = /出院帶藥|出院用藥|出院處方|discharge medication|discharge prescription|discharge rx/iu;
/** Headings / lines that put an order in the inpatient / outpatient setting (the drug listed under them). */
const INPATIENT_HDR = /住院醫囑|住院用藥|住院處方|住院中用藥|院內用藥|住院期間用藥|inpatient (?:order|medication|prescription)s?|admission orders?/iu;
const OUTPATIENT_HDR = /門診處方|門診用藥|門診藥物|門診醫囑|門診開立|outpatient (?:prescription|medication|order)s?|\bOPD\s+(?:rx|prescription|medication)s?\b/iu;
/** The record's visit setting (record level, used only when it is the record's only setting and no discharge heading exists). */
const OUTPATIENT_VISIT = /門診(?:病歷|紀錄|記錄|就診|日期|看診)|(?:就診|就醫|看診)(?:類別|類型|方式)?\s*[:：]\s*門診|\bOPD\b(?!\s*(?:f\/u|follow))|outpatient (?:visit|clinic|note)/iu;
const INPATIENT_VISIT = /住院(?:病歷|紀錄|記錄|日期|期間|醫囑|中)|入院(?:日期|紀錄|記錄)|admission (?:note|date)|\binpatient\b/iu;
const SETTING_ZH: Record<"discharge" | "outpatient" | "inpatient", string> = { discharge: "出院帶藥", outpatient: "門診", inpatient: "住院" };
type Interp = "H" | "L" | "HH" | "LL" | "N" | "A";

/** Whether the declared profile of `res` marks `path` (base form) mustSupport or required. */
function profileUses(res: Json, path: string, pe: ProfileElements | null | undefined): boolean {
  if (!pe || !pe.size) return false;
  const urls: string[] = Array.isArray(res?.meta?.profile) ? res.meta.profile.map((u: unknown) => String(u).split("|")[0]) : [];
  const sets = urls.map((u) => pe.get(u)).filter(Boolean) as Array<{ mustSupport: ReadonlySet<string>; required: ReadonlySet<string>; common?: ReadonlySet<string>; prohibited?: ReadonlySet<string> }>;
  if (!sets.length && pe.size === 1) sets.push([...pe.values()][0]);
  return sets.some((x) => x.mustSupport.has(path) || x.required.has(path) || (x.common?.has(path) ?? false));
}

/** Whether the declared profile allows `path` at all (not max 0) — for facts the record states explicitly (H / L flags). */
function profileAllows(res: Json, path: string, pe: ProfileElements | null | undefined): boolean {
  if (!pe || !pe.size) return false;
  const urls: string[] = Array.isArray(res?.meta?.profile) ? res.meta.profile.map((u: unknown) => String(u).split("|")[0]) : [];
  const sets = urls.map((u) => pe.get(u)).filter(Boolean) as Array<{ prohibited?: ReadonlySet<string> }>;
  if (!sets.length && pe.size === 1) sets.push([...pe.values()][0]);
  return sets.length > 0 && sets.every((x) => !(x.prohibited?.has(path) ?? false));
}

/** The record lines (not instruction text) that mention one of `names`. */
function linesNaming(rt: RecordText, names: readonly string[]): string[] {
  const out: string[] = [];
  for (const n of names) for (const o of rt.find(n)) if (o.origin === "record" && o.section !== "instruction" && !out.includes(o.line)) out.push(o.line);
  return out;
}

// ---- record-derivable facts (ISSUES_v20 R5) ----

/** Meaning → code of the declared profile's binding for a record-derivable element (null: the binding holds none). */
function codesFor(res: Json, rule: RecordDerivableRule, pe: ProfileElements | null | undefined): Map<string, DerivableCode> | null {
  const urls: string[] = Array.isArray(res?.meta?.profile) ? res.meta.profile.map((u: unknown) => String(u).split("|")[0]) : [];
  const sets = pe ? (urls.map((u) => pe.get(u)).filter(Boolean) as Array<NonNullable<ReturnType<NonNullable<ProfileElements>["get"]>>>) : [];
  if (!sets.length && pe && pe.size === 1) sets.push([...pe.values()][0]);
  const b = sets.map((s) => s.bindings?.get(rule.path)).find(Boolean);
  // no binding information (older callers, tests): the base FHIR binding
  return b ? derivableCodes(rule, b.valueSet, b.codes) : derivableCodes(rule, null, null);
}

const codingOf = (c: DerivableCode): Json => ({ ...(c.system ? { system: c.system } : {}), code: c.code, ...(c.display ? { display: c.display } : {}) });

function safeSlots(rt: RecordText): DxSlot[] {
  try {
    return diagnosisSlots(rt);
  } catch {
    return [];
  }
}

/** The names a Condition is called by (codings' displays / texts, looked-up names, an ICD-10 code). */
function conditionNamesOf(res: Json, root: Json, lookups?: ReadonlyMap<string, readonly string[]> | null): string[] {
  const out = new Set(itemNames(res, root, lookups));
  for (const c of isObj(res.code) && Array.isArray(res.code.coding) ? res.code.coding : []) {
    if (isObj(c) && typeof c.code === "string" && /^[A-Z]\d{2}(\.[0-9A-Z]{1,4})?$/u.test(c.code)) out.add(c.code);
    if (isObj(c) && typeof c.display === "string") out.add(c.display.replace(/\s*\((disorder|finding|symptom|situation)\)\s*$/iu, ""));
  }
  return [...out];
}

const RULE_OUT_CUE = /r\/o|rule[ -]?out|待排除|排除|鑑別|ddx|\bvs\.?\b|differential/iu;

/**
 * The verification status the record's diagnosis field gives a Condition named `names`: a plain item (no
 * uncertainty cue over it, the slot not under a slot-level cue) → confirmed; under a rule-out / differential
 * cue or in a differential slot → differential; any other hedge (疑似 / possible / ?) → provisional. A refuted
 * item (已排除) gives nothing. A plain item of any primary slot wins over a hedged mention elsewhere.
 */
function slotVerification(slots: readonly DxSlot[], names: readonly string[]): { meaning: "confirmed" | "provisional" | "differential"; quote: string } | null {
  const keys = names.map((n) => norm(n)).filter((n) => n.length >= 2);
  if (!keys.length) return null;
  const matches = (text: string, core: string): boolean => {
    const it = norm(text);
    const ic = norm(core);
    return keys.some((n) => (/^[a-z]\d{2}/u.test(n) ? it.includes(n) || it.includes(n.replace(".", "")) : ic.length >= 2 && (ic.includes(n) || (n.includes(ic) && ic.length >= Math.min(4, n.length)))));
  };
  let hedged: { meaning: "provisional" | "differential"; quote: string } | null = null;
  for (const s of slots) {
    for (const it of s.items) {
      if (it.refuted || !matches(it.text, it.core)) continue;
      if (it.strength === null && !s.slotCue && s.kind === "primary") return { meaning: "confirmed", quote: s.quote };
      const diff = s.kind === "differential" || RULE_OUT_CUE.test(it.cue ?? "") || RULE_OUT_CUE.test(s.slotCue ?? "");
      if (!hedged || (diff && hedged.meaning === "provisional")) hedged = { meaning: diff ? "differential" : "provisional", quote: s.quote };
    }
  }
  return hedged;
}

function numericValue(res: Json): number | null {
  if (isObj(res.valueQuantity) && typeof res.valueQuantity.value === "number") return res.valueQuantity.value;
  if (typeof res.valueInteger === "number") return res.valueInteger;
  return null;
}

/**
 * The interpretation the record gives an Observation's value: the flag right after the value on the record line
 * naming the test (else any record line stating the value), HH / LL before H / L; else the value against the
 * record's reference range right after it, else against the resource's own referenceRange: outside → H / L,
 * inside → N. A direction-less mark (*) → H / L by the range, else A.
 */
function interpretationOf(res: Json, v: number, rt: RecordText, body: ReadonlyArray<{ line: string }>, names: readonly string[]): { code: Interp; quote: string; zh: string; en: string } | null {
  const named = linesNaming(rt, names);
  const cand = [...named, ...body.map((l) => l.line).filter((l) => !named.includes(l))];
  const rr = Array.isArray(res.referenceRange) ? res.referenceRange[0] : null;
  const lo = isObj(rr) && typeof rr.low?.value === "number" ? (rr.low.value as number) : null;
  const hi = isObj(rr) && typeof rr.high?.value === "number" ? (rr.high.value as number) : null;
  const byRange = (low: number | null, high: number | null): Interp | null => (high !== null && v > high ? "H" : low !== null && v < low ? "L" : low !== null && high !== null ? "N" : null);
  let seen = false;
  for (const l of cand) {
    for (const m of l.matchAll(/(?<![\d.])(\d+(?:\.\d+)?)(?![\d.])/gu)) {
      if (Number(m[1]) !== v) continue;
      // after the number: skip its unit (U/L, mmol/L, uIU/mL — an "L" inside a unit is no flag), then the flag
      const rest = l.slice(m.index! + m[1].length).replace(/^\s*(?!(?:HH|LL|H|L|high|low|↑|↓|\*)(?:\s|[,，;；)）]|$))[^\s（(，,;；*＊]+(?=\s|[（(，,;；*＊]|$)/iu, "");
      // a reference range right after the value (「(ref 4.0-6.0)」「（參考值 70-99）」): stated in the record — compare with it
      const rng = /^\s*[（(]\s*(?:ref(?:erence)?|參考值|參考範圍|正常值|normal)?\s*[:：]?\s*(\d+(?:\.\d+)?)\s*[-~～–]\s*(\d+(?:\.\d+)?)\s*[^）)]*[）)]/iu.exec(rest);
      const after = rng ? rest.slice(rng[0].length) : rest;
      const near = after.slice(0, 12).split(/[,，;；]/u)[0];
      const flag: Interp | null = FLAG_HH.test(near) ? "HH" : FLAG_LL.test(near) ? "LL" : FLAG_HIGH.test(near) ? "H" : FLAG_LOW.test(near) ? "L" : null;
      if (flag) return { code: flag, quote: l, zh: `病歷標記「${near.trim()}」`, en: `the record flags the value "${near.trim()}"` };
      const star = FLAG_STAR.test(after) || FLAG_STAR.test(rest);
      const rc = rng ? byRange(Number(rng[1]), Number(rng[2])) : null;
      if (rc && (rc !== "N" || !star)) return { code: rc, quote: l, zh: rc === "N" ? "數值在病歷的參考範圍內" : "數值超出病歷的參考範圍", en: rc === "N" ? "the value is inside the record's reference range" : "the value is outside the record's reference range" };
      if (star) {
        const d = byRange(lo, hi);
        return { code: d && d !== "N" ? d : "A", quote: l, zh: "病歷以 * 標記異常", en: "the record marks the value abnormal (*)" };
      }
      seen = true;
      if (named.includes(l)) break; // the test's own line states the value without a flag: look at the resource's range
    }
  }
  // the resource's own range, when the record states the value at all (the result is the record's)
  const rc = byRange(lo, hi);
  if (rc && seen) return { code: rc, quote: `${v} (reference ${lo ?? ""}–${hi ?? ""})`, zh: rc === "N" ? "數值在參考範圍內" : "數值超出參考範圍", en: rc === "N" ? "the value is inside the reference range" : "the value is outside the reference range" };
  return null;
}

/**
 * The setting of a medication order: the heading / line it is listed under (up to 15 lines above, stopping at
 * another heading): discharge / inpatient / outpatient; else the record's visit setting when the record names
 * exactly one (outpatient or inpatient) and has no discharge-medication heading at all.
 */
function settingOf(rt: RecordText, line: string): { setting: "discharge" | "outpatient" | "inpatient"; quote: string } | null {
  const li = rt.lines.findIndex((l) => l.line === line);
  const test = (t: string): "discharge" | "outpatient" | "inpatient" | null => (DISCHARGE.test(t) ? "discharge" : INPATIENT_HDR.test(t) ? "inpatient" : OUTPATIENT_HDR.test(t) ? "outpatient" : null);
  const own = test(line);
  if (own) return { setting: own, quote: line };
  for (let i = li - 1; i >= 0 && i >= li - 15; i--) {
    const l = rt.lines[i];
    if (l.section === "instruction" || l.section === "site_config") break;
    const s = test(l.line);
    if (s) return { setting: s, quote: l.line };
    if (l.header) break;
  }
  const body = rt.lines.filter((l) => l.section !== "instruction" && l.section !== "site_config");
  if (body.some((l) => DISCHARGE.test(l.line))) return null;
  const out = body.find((l) => OUTPATIENT_VISIT.test(l.line));
  const inp = body.find((l) => INPATIENT_VISIT.test(l.line));
  if (out && !inp) return { setting: "outpatient", quote: out.line };
  if (inp && !out) return { setting: "inpatient", quote: inp.line };
  return null;
}

export function recordFactChecks(root: Json, recordText: string, siteConfig: string | null, severity: "warning" | "error", pe: ProfileElements | null | undefined, lookups?: ReadonlyMap<string, readonly string[]> | null): RecordIssue[] {
  if (!pe || !pe.size) return [];
  const rt = new RecordText(recordText, siteConfig);
  const body = rt.lines.filter((l) => l.section !== "instruction" && l.section !== "site_config");
  const out: RecordIssue[] = [];
  const add = (path: string, zh: string, en: string, quote: string, value: unknown, field: string, derivable = false): void => {
    out.push(withSuggestion(makeIssue(
      "R6", severity, "record-fact-missing", path,
      derivable
        ? `病歷有寫但沒有轉換：${zh}（病歷：「${clip(quote.trim(), 80)}」）。病歷雖未逐字寫出代碼，但已決定這個值（可由病歷推得），屬於病歷事實，請寫入`
        : `病歷有寫但沒有轉換：${zh}（病歷：「${clip(quote.trim(), 80)}」）。這個欄位是 profile 的 mustSupport / 必填欄位，請寫入`,
      derivable
        ? `Stated in the record but not converted: ${en} (record: "${clip(quote.trim(), 80)}"). The record determines this value without writing the code (record-derivable) — it is a record fact, write it`
        : `Stated in the record but not converted: ${en} (record: "${clip(quote.trim(), 80)}"). The profile marks this element mustSupport / required — write it`,
      derivable
        ? "R6 record fact, record-derivable (ISSUES_v20 R5, recordDerivable.ts): the diagnosis field's hedging (diagnosis-slot parser), the value's flag / reference range, the order's setting heading; wherever the declared profile has the element and its binding holds the code, and only when empty"
        : "R6 record fact: shared phrase tables (departments, durations, dose / frequency / route, the patient's name) on the record lines; only elements the declared profile marks mustSupport or requires, and only when empty",
      [quote.trim()],
    ), { value: typeof value === "string" ? value : JSON.stringify(value), kind: "add_value", confidence: derivable ? 0.7 : 0.5, reason: `write ${field} (codes from the element's binding: fhir_normalize_code(text, value_set=…))`, patch: { op: "add", path, value } }));
  };
  let slots: DxSlot[] | null = null;
  for (const r of resourcesOf(root)) {
    const res = r.resource;
    const rtype = String(res.resourceType);
    // 1. Encounter.serviceType ← the department the record names
    if (rtype === "Encounter" && !res.serviceType && profileUses(res, "Encounter.serviceType", pe)) {
      const line = body.find((l) => /科別|門診|就診|掛號|department|clinic/iu.test(l.line) && DEPARTMENTS.some((d) => l.line.includes(d))) ?? body.find((l) => DEPARTMENTS.some((d) => l.line.includes(d)));
      const dept = line ? DEPARTMENTS.find((d) => line.line.includes(d)) : undefined;
      if (line && dept) add(`${r.base}.serviceType`, `就診科別「${dept}」→ Encounter.serviceType`, `the department "${dept}" → Encounter.serviceType`, line.line, { text: dept }, "Encounter.serviceType");
    }
    // 2. Condition.verificationStatus ← the record's diagnosis field (ISSUES_v20 R5, recordDerivable.ts): an item the
    // field states without hedging → confirmed; hedged (疑似) → provisional; r/o / 待排除 / a differential slot →
    // differential — read by the v15.3 diagnosis-slot parser (diagnosisSlots). Only where the profile has the element.
    if (rtype === "Condition" && !res.verificationStatus && profileAllows(res, "Condition.verificationStatus", pe)) {
      const rule = RECORD_DERIVABLE["Condition.verificationStatus"];
      const dc = codesFor(res, rule, pe);
      slots ??= safeSlots(rt);
      const hit = dc ? slotVerification(slots, conditionNamesOf(res, root, lookups)) : null;
      const c = hit ? dc!.get(hit.meaning) : undefined;
      if (hit && c) {
        const zhState = hit.meaning === "confirmed" ? "寫明（未加保留）" : hit.meaning === "provisional" ? "以保留語氣寫（疑似）" : "列為待排除 / 鑑別";
        const enState = hit.meaning === "confirmed" ? "states it without hedging" : hit.meaning === "provisional" ? "hedges it" : "lists it as rule-out / differential";
        add(`${r.base}.verificationStatus`, `診斷的確認狀態（病歷的診斷欄${zhState}）→ verificationStatus = ${c.code}`, `the diagnosis's verification status (the record's diagnosis field ${enState}) → verificationStatus = ${c.code}`, hit.quote, { coding: [codingOf(c)] }, "Condition.verificationStatus", true);
      }
    }
    // 3. Observation.interpretation ← the record's flag after the value (H / L / HH / LL / ↑ / ↓ / * / (H)), or the value
    // compared with a reference range (the record's, else the resource's): outside → H / L, inside → N (ISSUES_v20 R5:
    // wherever the profile has interpretation, any cardinality, and its binding holds the code)
    const qv = rtype === "Observation" ? numericValue(res) : null;
    if (rtype === "Observation" && !res.interpretation && qv !== null && profileAllows(res, "Observation.interpretation", pe)) {
      const dc = codesFor(res, RECORD_DERIVABLE["Observation.interpretation"], pe);
      const hit = dc ? interpretationOf(res, qv, rt, body, itemNames(res, root, lookups)) : null;
      const c = hit ? dc!.get(hit.code) : undefined;
      if (hit && c) add(`${r.base}.interpretation`, `檢驗值的判讀（${hit.zh}）→ interpretation = ${c.code}`, `the result interpretation (${hit.en}) → interpretation = ${c.code}`, hit.quote, [{ coding: [codingOf(c)] }], "Observation.interpretation", true);
    }
    if (rtype !== "MedicationRequest") continue;
    const names = itemNames(res, root, lookups);
    const lines = linesNaming(rt, names);
    if (!lines.length) continue;
    // 4. MedicationRequest.category ← the order's setting (ISSUES_v20 R5): the heading the drug is listed under
    // (出院帶藥 / 門診處方 / 住院醫囑 …), else the record's single visit setting; only codes the binding holds
    if (!res.category && profileAllows(res, "MedicationRequest.category", pe)) {
      const dc = codesFor(res, RECORD_DERIVABLE["MedicationRequest.category"], pe);
      const hit = dc ? settingOf(rt, lines[0]) : null;
      const c = hit ? dc!.get(hit.setting) : undefined;
      if (hit && c) add(`${r.base}.category`, `處方類別（${SETTING_ZH[hit.setting]}）→ category = ${c.code}`, `the prescription category (${hit.setting}) → category = ${c.code}`, hit.quote, [{ coding: [codingOf(c)] }], "MedicationRequest.category", true);
    }
    // 5. structured dosage / supply duration ← the drug's own line (when nothing, not even Dosage.text, carries them)
    const d0 = Array.isArray(res.dosageInstruction) && isObj(res.dosageInstruction[0]) ? res.dosageInstruction[0] : null;
    const hasText = !!(d0 && typeof d0.text === "string" && d0.text.trim());
    if (hasText) continue; // text-only-fact covers what the text says
    const line = lines[0];
    const supply = isObj(res.dispenseRequest) && isObj(res.dispenseRequest.expectedSupplyDuration);
    const dur = DURATION.exec(line);
    if (dur && !supply && (profileUses(res, "MedicationRequest.dispenseRequest.expectedSupplyDuration", pe) || profileUses(res, "MedicationRequest.dispenseRequest", pe))) {
      const n = Number(dur[1] ?? dur[3]);
      const weeks = /週|week|wk/u.test(String(dur[2] ?? dur[4] ?? ""));
      if (n > 0) add(`${r.base}.dispenseRequest.expectedSupplyDuration`, `給藥天數「${dur[0].trim()}」`, `the supply duration "${dur[0].trim()}"`, line, { value: weeks ? n * 7 : n, unit: "days", system: "http://unitsofmeasure.org", code: "d" }, "dispenseRequest.expectedSupplyDuration");
    }
    const dosageUsed = profileUses(res, "MedicationRequest.dosageInstruction", pe);
    if (!dosageUsed) continue;
    const dose = RE_DOSE.exec(line);
    const freq = FREQ.find(([re]) => re.test(line));
    const route = ROUTE.exec(line);
    const hasDose = !!(d0 && Array.isArray(d0.doseAndRate) && d0.doseAndRate.length);
    const base = `${r.base}.dosageInstruction[0]`;
    if (dose && !hasDose) add(`${base}.doseAndRate[0].doseQuantity`, `單次劑量「${dose[0]}」`, `the dose "${dose[0]}"`, line, { value: Number(dose[1]), unit: dose[2], ...(UCUM_UNITS[dose[2].toLowerCase()] ? { system: "http://unitsofmeasure.org", code: UCUM_UNITS[dose[2].toLowerCase()] } : {}) }, "doseAndRate.doseQuantity");
    if (freq && !(d0 && hasTiming(d0))) {
      const m = freq[0].exec(line)!;
      const code = freq[1] === "Q#H" ? `Q${m[1] ?? m[2]}H` : freq[1];
      if (code !== "PRN") add(`${base}.timing.code`, `頻次「${m[0]}」`, `the frequency "${m[0]}"`, line, { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation", code }] }, "timing.code");
    }
    if (route && !(d0 && isObj(d0.route))) add(`${base}.route`, `給藥途徑「${route[0]}」`, `the route "${route[0]}"`, line, { text: route[0] }, "route");
  }
  // 6. Patient.name ← 姓名：…
  for (const r of resourcesOf(root)) {
    const res = r.resource;
    if (res.resourceType !== "Patient" || (Array.isArray(res.name) && res.name.length) || !profileUses(res, "Patient.name", pe)) continue;
    const LABEL = /(?:病人姓名|患者姓名|病患姓名|姓名|病人|患者|病患|patient name|name)\s*[:：]\s*([^\s，,；;（(]{2,20})|(?:^|\s)(?:病人|患者|病患|姓名)\s+(\p{Script=Han}{2,4})(?=\s|$)/iu;
    const l = body.find((x) => LABEL.test(x.line));
    const m = l ? LABEL.exec(l.line) : null;
    const nm = m ? m[1] ?? m[2] : null;
    if (l && nm) add(`${r.base}.name`, `病人姓名「${nm}」`, `the patient's name "${nm}"`, l.line, [{ text: nm }], "Patient.name");
  }
  return out;
}

/** All R6 checks (with source_text). */
export function coverageChecks(root: Json, recordText: string, siteConfig: string | null, severity: "warning" | "error", lookups?: ReadonlyMap<string, readonly string[]> | null, pe?: ProfileElements | null): RecordIssue[] {
  const out: RecordIssue[] = [];
  for (const run of [
    () => negatedItemChecks(root, recordText, siteConfig, lookups),
    () => duplicateEntryChecks(root),
    () => textOnlyFactChecks(root, severity, recordText),
    () => recordFactChecks(root, recordText, siteConfig, severity, pe, lookups),
  ]) {
    try {
      out.push(...run());
    } catch {
      // a failing rule drops its own issues only
    }
  }
  return out;
}
