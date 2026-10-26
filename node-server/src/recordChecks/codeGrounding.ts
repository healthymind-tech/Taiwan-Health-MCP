/**
 * Grounding issues on CODED elements in the validating tools (ISSUES_v15.3 R3) — needs source_text.
 *
 * fhir_check_grounding reports `G-UNGROUNDED` (and `G-VALUE-MISMATCH`) on a CodeableConcept / Coding
 * (Condition.code = 'sct#…' "is not stated in the record") when auto-locate finds no record line that
 * carries one of the code's names. A code itself never appears in a record, and on complete records the
 * code is often right but named in other words or another language — so the message misleads a model
 * into "the record lacks this diagnosis". fhir_check_grounding's own output is NEVER changed (the CARVE
 * gates compare it with the reference implementation); only the copy the validating tools return
 * (fhir_validate_bundle / fhir_validate_resource, also behind fhir_author_resources /
 * fhir_assemble_bundle) is annotated here:
 *
 *  - the message says what was compared: the code's meaning (CodeableConcept.text, displays, the
 *    terminology names the tool looked up — English + Chinese designations — and the ICD-10 code when the
 *    record writes codes) against the record lines (instruction / site-config / family-history lines
 *    excluded);
 *  - `closest_record_phrase` {text, similarity, section}: the best match among the record's clauses
 *    (split at 。；;，,、| and after a field label), similarity = the grounding engine's weighted name
 *    containment (abbreviation + zh→en bridge expansion), and for Chinese / Chinese also the character-
 *    bigram Dice over the concept-search normalisation (normalizeText + clinicalCore); rounded to 2
 *    decimals; null when nothing reaches 0.1;
 *  - severity: an error stays an error ONLY with strong negative evidence — the closest phrase is
 *    unrelated (similarity < 0.25) AND the record has a slot of the same kind that names something else:
 *    for the code of the encounter's PRIMARY Condition (diagnosisSlot.primaryCondition — a comorbidity from
 *    the past history is never in the slot) a non-empty diagnosis slot whose every item is comparable with
 *    the Condition (both carry an ICD-10 code; the same script as one of its names; or another language
 *    the grounding zh→en bridge translates for ≥ 80 % of the Chinese side; never an abbreviation-only item)
 *    and dissimilar to it. Every other coded element (medicines — brand vs generic names —, lab codes,
 *    comorbidities) is never "contradicted". Otherwise —
 *    a related phrase exists (≥ 0.25), the wording cannot be compared (another language / script), or the
 *    record has no such slot — it becomes a warning (`downgraded_from: "error"`, verdict "related" or
 *    "uncertain"). `grounding_code_check` names the verdict ("related" / "uncertain" / "contradicted").
 *
 * When a downgrade removes the last error of an entry / of the grounding result, `entries[i].valid`,
 * `groundingValid`, `valid` and the grounding summary counts are recomputed from the remaining issues.
 * Report only: nothing in the instance changes. Deterministic; the record text is never logged.
 */
import { bridgeCoverage, nameSimilarity as containment, nfkc } from "../grounding/lexicon.js";
import { RecordText } from "../grounding/recordText.js";
import { nameSimilarity as dice } from "../conceptSearch/related.js";
import { clinicalCore, hasCjk, normalizeText } from "../conceptSearch/text.js";
import { diagnosisSlots, primaryCondition, type DxSlot } from "./diagnosisSlot.js";

type Json = Record<string, any>;
const isObj = (x: unknown): x is Json => !!x && typeof x === "object" && !Array.isArray(x);
const clip = (s: string, n = 100): string => (s.length > n ? `${s.slice(0, n)}…` : s);

const RULES = new Set(["G-UNGROUNDED", "G-VALUE-MISMATCH"]);
const SKIP_SECTIONS = new Set(["instruction", "site_config", "family_history"]);
const RE_CLAUSE = /[。；;，,、|]|\s+\/\s+/u;
const RE_LABEL = /^\s*[^:：]{1,24}[:：]\s*/u;
const RE_ICD = /^[A-Z]\d{2}(\.[0-9A-Z]{1,4})?$/u;
const RE_ICD_IN = /\b[A-Z]\d{2}(?:\.[0-9A-Z]{1,4})?\b/gu;
const RE_TAG = /\s*\((disorder|finding|symptom|situation|observable entity|morphologic abnormality|procedure|substance|product|regime\/therapy)\)\s*$/iu;
/** Below this the closest record phrase is unrelated. */
export const RELATED_SIMILARITY = 0.25;


export interface Phrase {
  text: string;
  similarity: number;
  section: string;
}

export type CodeVerdict = "related" | "uncertain" | "contradicted";

/** Terminology names by `system|code` (the grounding provider's names: English + Chinese designations). */
export type CodeNames = ReadonlyMap<string, readonly string[]>;

/**
 * Names of a CodeableConcept / Coding: text, displays (semantic tag removed), the terminology names of each coding
 * (when the tool looked them up — the names grounding compared), ICD-10-style codes.
 */
export function conceptNames(v: Json, codeNames: CodeNames | null = null): string[] {
  const out: string[] = [];
  const codings: Json[] = Array.isArray(v.coding) ? v.coding.filter(isObj) : typeof v.code === "string" ? [v] : [];
  if (typeof v.text === "string") out.push(v.text);
  for (const c of codings) {
    if (typeof c.display === "string") out.push(c.display.replace(RE_TAG, ""));
    for (const n of codeNames?.get(`${c.system ?? "None"}|${c.code ?? "None"}`) ?? []) out.push(n.replace(RE_TAG, ""));
    if (typeof c.code === "string" && RE_ICD.test(c.code)) out.push(c.code);
  }
  return [...new Set(out.map((x) => x.trim()).filter((x) => x.length >= 2))].slice(0, 12);
}

const prep = (s: string): string => clinicalCore(normalizeText(s));

/**
 * Similarity of a concept name to a record phrase: the grounding engine's weighted name containment (Latin tokens with
 * abbreviation and zh→en bridge expansion, CJK bigrams) and, when both are Chinese, character-bigram Dice over the
 * concept-search normalisation (Latin character bigrams are too noisy to mean anything).
 */
export function phraseSimilarity(name: string, phrase: string): number {
  if (RE_ICD.test(name)) return nfkc(phrase).toUpperCase().includes(name.toUpperCase()) ? 1 : 0;
  const a = prep(name);
  const b = prep(phrase);
  if (!a || !b) return 0;
  const c = containment(phrase, name);
  return hasCjk(a) && hasCjk(b) ? Math.max(c, dice(a, b)) : c;
}

/** Record clauses (instruction / site-config / family-history lines excluded) with their section. */
function clausesOf(rt: RecordText): Array<{ text: string; section: string }> {
  const out: Array<{ text: string; section: string }> = [];
  for (const ln of rt.lines) {
    if (SKIP_SECTIONS.has(ln.section) || !ln.line.trim()) continue;
    const body = ln.line.replace(RE_LABEL, "");
    for (const c of [body, ...body.split(RE_CLAUSE)]) {
      const t = c.trim();
      if (t.length >= 2) out.push({ text: t, section: ln.section });
    }
  }
  return out;
}

/** The record phrase closest to any of the names. */
export function closestPhrase(names: readonly string[], rt: RecordText): Phrase | null {
  let best: Phrase | null = null;
  for (const cl of clausesOf(rt)) {
    for (const n of names) {
      const s = phraseSimilarity(n, cl.text);
      // ties prefer the shorter phrase (the clause rather than its whole line)
      if (!best || s > best.similarity + 1e-9 || (Math.abs(s - best.similarity) <= 1e-9 && cl.text.length < best.text.length)) best = { text: clip(cl.text), similarity: s, section: cl.section };
    }
  }
  if (!best || best.similarity < 0.1) return null; // nothing comparable: no phrase is "closest"
  best.similarity = Math.round(best.similarity * 100) / 100;
  return best;
}

/** Share of a Chinese text the grounding zh→en bridge translates, above which it is compared with an English name. */
const BRIDGE_MIN = 0.8;
const latin3 = (s: string): boolean => /[a-z]{3,}/iu.test(s.replace(RE_ICD_IN, ""));

/**
 * Whether an item of the record can be compared with the concept's names: both carry ICD-10 codes; the same script
 * (Chinese / Chinese, English / English); or across languages when the grounding lexicon's zh→en bridge translates
 * at least 80 % of the Chinese side. Otherwise the wording cannot be compared and nothing is concluded.
 */
function comparable(names: readonly string[], item: string): boolean {
  if ((item.match(RE_ICD_IN) ?? []).length && names.some((n) => RE_ICD.test(n))) return true;
  // an item written as abbreviations only (CAP, AGE, s/p PCI) cannot be compared word for word
  if (!hasCjk(item) && item.replace(RE_ICD_IN, "").split(/[^A-Za-z]+/u).filter(Boolean).every((w) => w.length <= 5 && (w === w.toUpperCase() || w.length <= 2))) return false;
  const ic = hasCjk(item);
  const il = latin3(item);
  for (const n of names) {
    if (RE_ICD.test(n)) continue;
    const nc = hasCjk(n);
    const nl = latin3(n);
    if (ic && nc) return true;
    if (il && nl && !ic && !nc) return true;
    if (ic && !nc && nl && bridgeCoverage(item) >= BRIDGE_MIN) return true;
    if (!ic && il && nc && bridgeCoverage(n) >= BRIDGE_MIN) return true;
  }
  return false;
}

/** A slot of the same kind that names something else: every item comparable and unrelated. */
function namesSomethingElse(items: readonly string[], names: readonly string[]): boolean {
  if (!items.length) return false;
  return items.every((it) => comparable(names, it) && names.every((n) => phraseSimilarity(n, it) < RELATED_SIMILARITY));
}

export interface CodeJudgement {
  verdict: CodeVerdict;
  names: string[];
  closest: Phrase | null;
  /** The slot that names something else (for "contradicted"). */
  other: string | null;
}

/**
 * Judge one coded element against the record. `gpath` is the generic path (Condition.code,
 * MedicationRequest.medicationCodeableConcept); `primary`: the element is the code of the encounter's primary Condition
 * (diagnosisSlot.primaryCondition) — only then can the diagnosis slot contradict it (a comorbidity from the past
 * history is not in the slot).
 */
export function judgeCode(value: Json, gpath: string, rt: RecordText, slots: readonly DxSlot[], primary: boolean, codeNames: CodeNames | null = null): CodeJudgement {
  const names = conceptNames(value, codeNames);
  const closest = names.length ? closestPhrase(names, rt) : null;
  if (closest && closest.similarity >= RELATED_SIMILARITY) return { verdict: "related", names, closest, other: null };
  let other: string | null = null;
  if (names.length && gpath === "Condition.code" && primary) {
    const dx = slots.filter((s) => !s.empty && s.items.length);
    const items = dx.flatMap((s) => s.items.map((it) => it.text));
    if (namesSomethingElse(items, names)) other = dx.map((s) => s.quote).join(" / ");
  }
  return { verdict: other ? "contradicted" : "uncertain", names, closest, other };
}

const RE_TOKEN = /([^.[\]]+)(?:\[(\d+)\])?/gu;

/** Value at an issue path and its generic path (Bundle.entry[i].resource.… or <ResourceType>.…). */
function valueAt(target: Json, path: string): { value: unknown; gpath: string } | null {
  const toks = [...path.matchAll(RE_TOKEN)].map((m) => [m[1], m[2] === undefined ? null : Number(m[2])] as const);
  if (!toks.length || toks[0][0] !== target.resourceType) return null;
  let node: unknown = target;
  let rt = String(target.resourceType);
  let gparts: string[] = [];
  for (const [k, i] of toks.slice(1)) {
    if (!isObj(node)) return null;
    node = node[k];
    if (i !== null) node = Array.isArray(node) ? node[i] : undefined;
    if (k === "resource" && isObj(node) && typeof node.resourceType === "string") {
      rt = node.resourceType;
      gparts = [];
    } else if (!(target.resourceType === "Bundle" && gparts.length === 0 && k === "entry")) gparts.push(k);
  }
  return { value: node, gpath: [rt, ...gparts].join(".") };
}

/** A CodeableConcept (codings or text) or a Coding. */
function coded(v: unknown): v is Json {
  return isObj(v) && (Array.isArray(v.coding) || (typeof v.code === "string" && ("system" in v || "display" in v)) || (typeof v.text === "string" && Object.keys(v).every((k) => ["text", "extension", "id"].includes(k))));
}

function rewrite(iss: Json, j: CodeJudgement): Json {
  const prefix = `[grounding:${iss.rule}]`;
  const orig = String(iss.message ?? "");
  const body = orig.startsWith(prefix) ? orig.slice(prefix.length).trim() : orig;
  const subject = body.includes(" is not stated in the record") ? body.slice(0, body.indexOf(" is not stated in the record")) : body;
  const names = j.names.slice(0, 4).map((n) => `'${clip(n, 50)}'`).join(", ") || "(none)";
  const near = j.closest ? `Closest record phrase: 「${j.closest.text}」 (similarity ${j.closest.similarity.toFixed(2)}).` : "The record has no comparable phrase.";
  const nearZh = j.closest ? `病歷中最相近的敘述：「${j.closest.text}」（相似度 ${j.closest.similarity.toFixed(2)}）。` : "病歷中沒有可比較的敘述。";
  const head = `${subject}: the code's meaning (display / text ${names}) was compared with the record text — codes themselves are not written in records — and no record phrase states it with these names${body !== subject && !body.includes(" is not stated in the record") ? ` (${body})` : ""}. ${near}`;
  const headZh = `${subject}：比對的是代碼的意思（display／text ${names}）與病歷文字（病歷不會寫代碼本身），病歷中沒有以這些名稱敘述它的句子。${nearZh}`;
  let tail: string;
  let tailZh: string;
  if (j.verdict === "related") {
    tail = "A related record phrase exists: the code may name it in other words — verify that the code means what the record says; this is not evidence that the record lacks the information.";
    tailZh = "病歷有相關的敘述，代碼可能只是用了不同的說法——請確認代碼的意思與病歷一致；這不表示病歷沒有這項資訊。";
  } else if (j.verdict === "uncertain") {
    tail = "Uncertain: no clearly related phrase, but nothing in the record names something else in its place (or the wording cannot be compared, e.g. another language) — verify the code; do not read this as \"the record lacks this information\".";
    tailZh = "無法確定：病歷沒有明顯相關的敘述，但也沒有記載別的內容取而代之（或用語無法直接比較，例如不同語言）——請確認代碼；不要把它解讀為「病歷沒有這項資訊」。";
  } else {
    tail = `The record states nothing related, and its diagnosis slot names something else (「${clip(j.other ?? "", 80)}」): this code is not the diagnosis the record states.`;
    tailZh = `病歷沒有任何相關的敘述，而且病歷的診斷欄記載的是別的內容（「${clip(j.other ?? "", 80)}」）：這個代碼不是病歷所寫的診斷。`;
  }
  const downgrade = iss.severity === "error" && j.verdict !== "contradicted";
  return {
    ...iss,
    severity: downgrade ? "warning" : iss.severity,
    message: `${prefix} ${head} ${tail}`,
    message_zh: `${prefix} ${headZh}${tailZh}`,
    grounding_code_check: j.verdict,
    compared: { names: j.names, against: "record lines (instruction / site-config / family-history lines excluded)" },
    closest_record_phrase: j.closest,
    ...(downgrade ? { downgraded_from: "error" } : {}),
  };
}

export interface CodeGroundingStats {
  examined: number;
  warnings: number;
  errors: number;
}

/**
 * Annotate the coded-element G-UNGROUNDED / G-VALUE-MISMATCH grounding issues of a validation data block in place
 * (see the module comment). Returns the counts, or null when there were none.
 */
export function annotateGroundingCodes(data: Json, target: Json, sourceText: string, siteConfig: string | null, codeNames: CodeNames | null = null): CodeGroundingStats | null {
  let rt: RecordText | null = null;
  let slots: DxSlot[] = [];
  let primaryBase: string | null = null;
  const stats: CodeGroundingStats = { examined: 0, warnings: 0, errors: 0 };
  let downgraded = 0;
  const touched = new Set<Json>();
  const fix = (list: unknown, owner: Json | null): void => {
    if (!Array.isArray(list)) return;
    list.forEach((iss, k) => {
      if (!isObj(iss) || iss.source !== "grounding" || !RULES.has(String(iss.rule)) || typeof iss.path !== "string") return;
      const at = valueAt(target, iss.path);
      if (!at || !coded(at.value)) return;
      if (!rt) {
        rt = new RecordText(sourceText, siteConfig);
        slots = diagnosisSlots(rt);
        primaryBase = primaryCondition(target, rt, slots.filter((x) => !x.empty))?.base ?? null;
      }
      const primary = primaryBase !== null && iss.path === `${primaryBase}.code`;
      const j = judgeCode(at.value, at.gpath, rt, slots, primary, codeNames);
      const out = rewrite(iss, j);
      list[k] = out;
      stats.examined++;
      if (out.severity === "error") stats.errors++;
      else stats.warnings++;
      if (out.downgraded_from) {
        downgraded++;
        if (owner) touched.add(owner);
      }
    });
  };
  fix(data.issues, null);
  for (const e of Array.isArray(data.entries) ? data.entries : []) if (isObj(e)) fix(e.issues, e);
  if (!stats.examined) return null;
  if (downgraded) {
    const hasError = (xs: unknown): boolean => Array.isArray(xs) && xs.some((i) => isObj(i) && i.severity === "error");
    for (const e of touched) if (e.valid === false && !hasError(e.issues)) e.valid = true;
    if (isObj(data.grounding)) {
      if (typeof data.grounding.errors === "number") data.grounding.errors = Math.max(0, data.grounding.errors - downgraded);
      if (typeof data.grounding.warnings === "number") data.grounding.warnings += downgraded;
    }
    const groundingError = (xs: unknown): boolean => Array.isArray(xs) && xs.some((i) => isObj(i) && i.source === "grounding" && i.severity === "error");
    if (data.groundingValid === false && !groundingError(data.issues) && !(Array.isArray(data.entries) ? data.entries : []).some((e: unknown) => isObj(e) && groundingError(e.issues))) {
      data.groundingValid = true;
      const recordOk = !isObj(data.record_checks) || data.record_checks.ok !== false;
      if (data.valid === false && data.conformanceValid !== false && recordOk) data.valid = true;
    }
  }
  return stats;
}
