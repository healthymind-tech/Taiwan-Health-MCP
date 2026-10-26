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
 * Chinese names of SNOMED codes (ISSUES_v15.3 R3 follow-up; grounding/snomedChinese.ts: IG designations, the SNOMED →
 * ICD-10 map's ICD-10-CM Chinese names, the mined bilingual thesaurus) — SNOMED CT itself has English names only, so a
 * Chinese diagnosis slot was never comparable and a wrong SNOMED code stayed "uncertain". With them:
 *  - names with confidence ≥ 0.5 join the names compared with the record (closest phrase, "related");
 *  - names with confidence ≥ 0.6 (ZH_CONFIDENCE_MIN) also make a Chinese slot item comparable with the code;
 *  - an item made comparable only through them is "something else" when it is unrelated (< 0.25) to EVERY name of the
 *    code — English, Chinese, and every Chinese name of the mapped ICD-10 code's 3-character category (confidence 0.3:
 *    a slot naming a diagnosis of the same ICD category is never "different") — and, when the only such names are
 *    ICD-derived (the map is many-to-one and coarse), even below 0.15 (ICD_ONLY_UNRELATED); an item carrying an ICD-10
 *    code of the mapped target's category is never "different";
 *  - otherwise the verdict is as before (related → warning; not comparable → uncertain warning).
 * The names used are listed in `compared.chinese_names` {name, source, confidence}; fhir_check_grounding never sees them.
 * Hierarchy guard (all codes): a slot item whose SNOMED concept (lookups.ts codeSlotRelations: its ICD-10 code via the
 * reverse SNOMED → ICD-10 map, or an identical ICD Chinese name) is the coded concept, an ancestor or a descendant of it is
 * never "something else" — a broader / narrower concept (lower respiratory tract infection vs 社區型肺炎 (J18.9)) is at most
 * a warning. Abbreviation-only items are recognised on the record's own casing (slot items are lower-cased).
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
/** Chinese names (snomedChinese.ts) at or above this make a Chinese slot item comparable with the code. */
export const ZH_CONFIDENCE_MIN = 0.6;
/** Chinese names at or above this are compared with the whole record (lower ones only with the slot, to block an error). */
export const ZH_RECORD_MIN = 0.5;
/** Unrelated threshold when only ICD-derived Chinese names make the slot comparable (the ICD map is coarse). */
export const ICD_ONLY_UNRELATED = 0.15;


export interface Phrase {
  text: string;
  similarity: number;
  section: string;
}

export type CodeVerdict = "related" | "uncertain" | "contradicted";

/** Terminology names by `system|code` (the grounding provider's names: English + Chinese designations). */
export type CodeNames = ReadonlyMap<string, readonly string[]>;

/** A Chinese name of a code with its source and confidence (grounding/snomedChinese.ts ZhName). */
export interface ChineseName {
  name: string;
  source: string;
  confidence: number;
  icd?: string;
}

/** Chinese names by `system|code` (SNOMED codings only). */
export type ChineseCodeNames = ReadonlyMap<string, readonly ChineseName[]>;

/** Chinese names of the codings of a CodeableConcept / Coding. */
export function chineseNamesOf(v: Json, zh: ChineseCodeNames | null): ChineseName[] {
  if (!zh) return [];
  const codings: Json[] = Array.isArray(v.coding) ? v.coding.filter(isObj) : typeof v.code === "string" ? [v] : [];
  const out: ChineseName[] = [];
  for (const c of codings) for (const n of zh.get(`${c.system ?? "None"}|${c.code ?? "None"}`) ?? []) if (n && typeof n.name === "string" && n.name.trim()) out.push(n);
  return out;
}

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
/** ICD-10 codes an item states. Diagnosis-slot items are NFKC lower-cased ("社區型肺炎 (j18.9)"), so match upper-cased. */
const icdCodesIn = (item: string): string[] => nfkc(item).toUpperCase().match(RE_ICD_IN) ?? [];

function comparable(names: readonly string[], item: string, orig: string = item): boolean {
  if (icdCodesIn(item).length && names.some((n) => RE_ICD.test(n))) return true;
  // an item written as abbreviations only (CAP, AGE, s/p PCI) cannot be compared word for word — judged on the record's
  // own casing (`orig`): slot items are lower-cased, so "cap" never looked upper-case
  if (!hasCjk(orig) && orig.normalize("NFKC").replace(/\b[A-Za-z]\d{2}(?:\.[0-9A-Za-z]{1,4})?\b/gu, "").split(/[^A-Za-z]+/u).filter(Boolean).every((w) => w.length <= 5 && (w === w.toUpperCase() || w.length <= 2))) return false;
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

/**
 * A slot of the same kind that names something else: every item comparable and unrelated. `names`: the code's names
 * compared with the record; `zh`: its Chinese names (see the module comment); `base`: the names without them. Returns the Chinese name that made an
 * item comparable (null when the other names did), or false.
 */
/** A diagnosis-slot item: the slot parser's lower-cased text and the record's own spelling of it. */
interface ItemText {
  text: string;
  orig: string;
}

/** The item in the record's casing (slot items are NFKC lower-cased; the slot quote keeps the record's spelling). */
function originalCase(item: string, quote: string): string {
  const q = quote.normalize("NFKC"); // not lexicon.nfkc: that one also lower-cases
  const i = q.toLowerCase().indexOf(item);
  return i >= 0 && q.length === q.toLowerCase().length ? q.slice(i, i + item.length) : item;
}

function namesSomethingElse(
  items: readonly ItemText[],
  names: readonly string[],
  zh: readonly ChineseName[] = [],
  base: readonly string[] = names,
  related: ReadonlySet<string> = new Set(),
): ChineseName | null | false {
  if (!items.length) return false;
  const strong = zh.filter((z) => z.confidence >= ZH_CONFIDENCE_MIN);
  const strongNames = strong.map((z) => z.name);
  const all = [...new Set([...names, ...zh.map((z) => z.name)])];
  // names of other codes of the mapped ICD category: they show a same-category diagnosis only when clearly related
  // (≥ 0.25) — a shared generic word (急性) must not block
  const members = new Set(zh.filter((z) => z.source === "icd_category_member").map((z) => z.name));
  const main = all.filter((n) => !members.has(n));
  const icdOnly = strong.length > 0 && strong.every((z) => z.source.startsWith("icd_"));
  const cats = new Set(zh.filter((z) => z.icd && z.source !== "icd_category_member").map((z) => z.icd!.slice(0, 3)));
  let via: ChineseName | null = null;
  for (const { text: it, orig } of items) {
    // hierarchy guard: the item's SNOMED concept is this concept, a broader or a narrower one (lookups.ts
    // codeSlotRelations, snomed.concept_ancestors) — a parent / child concept is not a different diagnosis
    if (related.has(it)) return false;
    // the item states an ICD-10 code of the mapped category (slot items are lower-cased): the same diagnosis group, never "different"
    if (cats.size && icdCodesIn(it).some((c) => cats.has(c.slice(0, 3)))) return false;
    // the item states the concept's own ICD-10 code (or one of its category): the same diagnosis, never "something else"
    const own = names.filter((n) => RE_ICD.test(n)).map((n) => n.slice(0, 3));
    if (own.length && icdCodesIn(it).some((c) => own.includes(c.slice(0, 3)))) return false;
    if (comparable(base, it, orig)) {
      if (!all.every((n) => phraseSimilarity(n, it) < RELATED_SIMILARITY)) return false;
      continue;
    }
    if (!strong.length || !comparable(strongNames, it, orig)) return false;
    const limit = icdOnly ? ICD_ONLY_UNRELATED : RELATED_SIMILARITY;
    if (!main.every((n) => phraseSimilarity(n, it) < limit)) return false;
    if (![...members].every((n) => phraseSimilarity(n, it) < RELATED_SIMILARITY)) return false;
    via ??= strong.find((z) => comparable([z.name], it, orig)) ?? strong[0];
  }
  return via;
}

export interface CodeJudgement {
  verdict: CodeVerdict;
  names: string[];
  closest: Phrase | null;
  /** The slot that names something else (for "contradicted"). */
  other: string | null;
  /** Chinese names compared (confidence ≥ ZH_RECORD_MIN), when the code has any. */
  chinese?: ChineseName[];
  /** The Chinese name through which the slot was compared (for "contradicted"). */
  via?: ChineseName | null;
}

/**
 * Judge one coded element against the record. `gpath` is the generic path (Condition.code,
 * MedicationRequest.medicationCodeableConcept); `primary`: the element is the code of the encounter's primary Condition
 * (diagnosisSlot.primaryCondition) — only then can the diagnosis slot contradict it (a comorbidity from the past
 * history is not in the slot).
 */
export function judgeCode(
  value: Json,
  gpath: string,
  rt: RecordText,
  slots: readonly DxSlot[],
  primary: boolean,
  codeNames: CodeNames | null = null,
  zhNames: ChineseCodeNames | null = null,
  slotRelations: ReadonlyMap<string, ReadonlySet<string>> | null = null,
): CodeJudgement {
  const zh = chineseNamesOf(value, zhNames);
  const shown = zh.filter((z) => z.confidence >= ZH_RECORD_MIN);
  const base = conceptNames(value, codeNames);
  const names = [...new Set([...base, ...shown.map((z) => z.name)])];
  const extra = shown.length ? { chinese: shown } : {};
  const closest = names.length ? closestPhrase(names, rt) : null;
  if (closest && closest.similarity >= RELATED_SIMILARITY) return { verdict: "related", names, closest, other: null, ...extra };
  let other: string | null = null;
  let via: ChineseName | null = null;
  if (names.length && gpath === "Condition.code" && primary) {
    const dx = slots.filter((s) => !s.empty && s.items.length);
    const items = dx.flatMap((s) => s.items.map((it) => ({ text: it.text, orig: originalCase(it.text, s.quote) })));
    const codings: Json[] = Array.isArray(value.coding) ? value.coding.filter(isObj) : typeof value.code === "string" ? [value] : [];
    const related = new Set(codings.flatMap((c) => [...(slotRelations?.get(`${c.system ?? "None"}|${c.code ?? "None"}`) ?? [])]));
    const r = namesSomethingElse(items, names, zh, base, related);
    if (r !== false) {
      other = dx.map((s) => s.quote).join(" / ");
      via = r;
    }
  }
  return { verdict: other ? "contradicted" : "uncertain", names, closest, other, ...extra, ...(via ? { via } : {}) };
}

const SOURCE_EN: Record<string, string> = {
  ig_designation: "an IG designation",
  ig_display: "an IG ValueSet display",
  icd_map: "its SNOMED → ICD-10 map",
  icd_map_child: "its SNOMED → ICD-10 map",
  icd_category: "its SNOMED → ICD-10 map category",
  thesaurus: "the bilingual thesaurus",
};
const SOURCE_ZH: Record<string, string> = {
  ig_designation: "IG 的中文 designation",
  ig_display: "IG ValueSet 的中文 display",
  icd_map: "SNOMED → ICD-10 對應",
  icd_map_child: "SNOMED → ICD-10 對應",
  icd_category: "SNOMED → ICD-10 對應的類目",
  thesaurus: "中英對照詞庫",
};

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
    const via = j.via ? ` (compared through the code's Chinese name '${clip(j.via.name, 40)}' from ${SOURCE_EN[j.via.source] ?? j.via.source}${j.via.icd ? ` ${j.via.icd}` : ""})` : "";
    const viaZh = j.via ? `（以代碼的中文名稱「${clip(j.via.name, 40)}」比對，來源：${SOURCE_ZH[j.via.source] ?? j.via.source}${j.via.icd ? ` ${j.via.icd}` : ""}）` : "";
    tail = `The record states nothing related, and its diagnosis slot names something else (「${clip(j.other ?? "", 80)}」)${via}: this code is not the diagnosis the record states.`;
    tailZh = `病歷沒有任何相關的敘述，而且病歷的診斷欄記載的是別的內容（「${clip(j.other ?? "", 80)}」）${viaZh}：這個代碼不是病歷所寫的診斷。`;
  }
  const downgrade = iss.severity === "error" && j.verdict !== "contradicted";
  return {
    ...iss,
    severity: downgrade ? "warning" : iss.severity,
    message: `${prefix} ${head} ${tail}`,
    message_zh: `${prefix} ${headZh}${tailZh}`,
    grounding_code_check: j.verdict,
    compared: {
      names: j.names,
      against: "record lines (instruction / site-config / family-history lines excluded)",
      ...(j.chinese?.length ? { chinese_names: j.chinese.map((z) => ({ name: z.name, source: z.source, confidence: z.confidence })) } : {}),
    },
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
export function annotateGroundingCodes(
  data: Json,
  target: Json,
  sourceText: string,
  siteConfig: string | null,
  codeNames: CodeNames | null = null,
  zhNames: ChineseCodeNames | null = null,
  slotRelations: ReadonlyMap<string, ReadonlySet<string>> | null = null,
): CodeGroundingStats | null {
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
      const j = judgeCode(at.value, at.gpath, rt, slots, primary, codeNames, zhNames, slotRelations);
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
