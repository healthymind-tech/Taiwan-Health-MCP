/**
 * Record-checks lexicon (ISSUES_v15) — VERSIONED DATA + the absence-phrase recogniser.
 *
 * Two curated vocabularies, Traditional Chinese + English:
 *  - ABSENCE: predicates that say a piece of information does not exist / is not known / is pending
 *    (不詳, 未取號, 建檔失敗, 尚在申請, unknown, not yet assigned, pending …). Built from closed
 *    word lists plus a small generative morphology (negation / pending prefixes × process verbs,
 *    verb + 中 / 失敗), so the variants a record writes (尚未取號 / 還沒取號 / 取號中 / 取號失敗)
 *    are all covered without listing each one.
 *  - UNCERTAINTY / CONFIRMATION cues for diagnoses (待排除, 尚未確立, r/o, differential, 疑似,
 *    suspected … / 確診, confirmed …), split by strength: "explicit" (the record says the diagnosis
 *    is not established) vs "uncertain" (hedged).
 *
 * The recogniser (`absenceOf`) never fires on a substring: the WHOLE value must be covered by
 * absence predicates plus field nouns (病歷號, 身分證, ID, date …), fillers (家屬說, 目前, yet …)
 * and punctuation, with at least one predicate — a dynamic-programming cover over the value. A
 * value that still holds real content (any other word, or a run of three or more digits) is never
 * "absent". So 「建檔失敗尚未取號」 and "not yet assigned" are absent, while 「王不明」 (a name with a
 * residue), "Hypertension, unspecified" or 「家族史不詳」 in another field are not.
 *
 * Any change to a table must bump RECORD_CHECKS_LEXICON_VERSION (reported in provenance with its
 * SHA-256, like the grounding lexicon).
 */
import { createHash } from "node:crypto";

import { nfkc } from "../grounding/lexicon.js";

// ------------------------------------------------------------------------------------------- data

/** Prefixes that negate / defer a process verb (尚未取號, 還沒帶來, 無法取得, 待確認). */
const NEG_PREFIXES_ZH = ["尚未", "還未", "仍未", "迄未", "未", "還沒有", "還沒", "沒有", "沒", "尚無", "仍無", "無法", "未能", "不能", "尚待", "有待", "待", "等待", "等候", "忘記", "忘了"];
/** Process verbs a record uses for information that has not been produced yet. */
const PROCESS_VERBS_ZH = [
  "取號", "取得", "取", "給號", "配號", "編號", "建檔", "建立", "提供", "帶", "帶來", "攜帶", "記載", "記錄", "紀錄", "登錄",
  "登記", "填寫", "填", "輸入", "確認", "確定", "確立", "確診", "核發", "發給", "發放", "申請", "辦理", "告知", "測量", "量測",
  "量", "檢驗", "檢測", "回報", "出來", "得知", "查到", "查詢", "掛號", "報到", "補", "補登", "補上", "補齊", "補充", "決定",
  "安排", "開立", "釐清", "詢問", "問到", "知道", "核對", "核實", "上傳", "完成",
];
/** Verbs that combine with 中 (in progress) / 失敗 (failed) / 尚在 … (still being …). */
const PROGRESS_VERBS_ZH = ["申請", "辦理", "處理", "確認", "建檔", "取號", "查詢", "審核", "核發", "補辦", "掛號", "登錄", "登記", "讀卡", "讀取", "上傳", "配號"];
const PROGRESS_PREFIXES_ZH = ["尚在", "仍在", "正在", "還在", "目前在"];
/** Standalone absence predicates. */
const ABSENCE_WORDS_ZH = [
  "不詳", "未詳", "不明", "不清楚", "不知道", "不知", "未知", "不確定", "未定", "空白", "從缺", "缺漏", "缺少", "缺", "遺失", "遺漏",
  "查無資料", "查無此人", "查無", "無資料", "沒資料", "沒有資料", "無此資料", "無紀錄", "無記錄", "無記載", "待補登", "待補", "待查",
  "待定", "再補", "後補", "另補", "稍後補", "不提供", "拒絕提供", "拒提供", "拒答", "未填", "尚無", "暫無", "目前無", "無從得知",
  "無法得知", "無法提供", "無法確認", "沒帶", "未帶",
];
/** Nil words: count as absence only in fields that need a structured value (identifier, date, quantity, name, reference). */
const NIL_WORDS_ZH = ["無", "沒有", "空", "無號"];

const NOT_VERBS_EN = [
  "assigned", "available", "provided", "recorded", "documented", "known", "stated", "specified", "given", "issued", "obtained",
  "confirmed", "determined", "registered", "created", "entered", "measured", "reported", "brought", "established", "allocated",
  "generated", "filed", "verified", "collected", "done", "received",
];
const ABSENCE_WORDS_EN = [
  "unknown", "unk", "n/a", "not applicable", "unavailable", "unspecified", "unassigned", "undetermined", "unconfirmed", "unrecorded",
  "undocumented", "pending", "awaiting", "tbd", "tba", "tbc", "missing", "no data", "no record", "no records", "no information",
  "no info", "registration failed", "failed", "declined", "refused", "withheld", "blank", "empty", "not on file", "on order",
  "in progress", "forgot", "forgotten",
];
const NIL_WORDS_EN = ["none", "nil", "null", "na", "n.a.", "-"];

/** Field nouns: words naming the field itself (病歷號尚未取號 = MRN + predicate). */
const FIELD_NOUNS_ZH = [
  "病歷號碼", "病歷號", "病歷編號", "病歷", "身分證字號", "身分證號碼", "身分證號", "身分證統一編號", "身分證", "身份證字號", "身份證號碼",
  "身份證號", "身份證", "統一證號", "居留證號碼", "居留證號", "居留證", "護照號碼", "護照號", "護照", "健保卡號", "健保卡", "健保",
  "卡號", "號碼", "編號", "證號", "字號", "識別碼", "識別號", "代碼", "代號", "號", "資料", "資訊", "日期", "時間", "時刻", "年月日",
  "數值", "數據", "結果", "報告", "劑量", "姓名", "名字", "欄位", "欄", "電話", "地址", "批號", "診斷", "藥名", "藥品", "證件", "文件",
  "住院號", "就診號", "掛號號碼", "檢驗", "檢查",
];
const FIELD_NOUNS_EN = [
  "id", "identifier", "number", "no", "no.", "#", "mrn", "chart", "record", "medical", "national", "card", "resident", "certificate",
  "passport", "nhi", "insurance", "date", "time", "datetime", "value", "result", "results", "code", "name", "dose", "field",
  "information", "info", "data", "registration", "assignment", "confirmation", "details", "documents", "document", "test", "lab",
];
const FILLERS_ZH = [
  "新病人", "新患者", "新個案", "初診", "家屬說", "家屬表示", "家屬稱", "家屬", "病人說", "病人表示", "病人稱", "病患表示", "患者表示", "個案表示", "據稱", "據家屬", "表示", "說",
  "稱", "目前", "現在", "暫時", "暫", "尚", "仍", "還", "也", "都", "均", "皆", "因為", "因", "由於", "所以", "故", "但", "而", "且",
  "已", "為", "是", "的", "之", "了", "等", "再", "會", "將", "要", "需要", "需", "請", "於", "在", "時", "此", "該", "本", "其",
  "病人", "病患", "患者", "個案", "系統", "院方", "櫃台", "櫃檯", "掛號處", "之後", "以後", "下次", "回診時", "來院", "來", "今日",
  "今天", "當天", "先", "後", "中", "所", "被", "給", "有", "一下", "一樣", "後續", "另行", "另", "補件", "下來", "完畢", "前", "申請", "辦理", "核發", "辦",
];
const FILLERS_EN = [
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being", "has", "have", "had", "yet", "still", "currently", "at", "this",
  "time", "moment", "present", "as", "of", "for", "by", "per", "patient", "pt", "family", "says", "said", "and", "or", "but", "so",
  "will", "to", "later", "until", "with", "from", "on", "in", "it", "its", "his", "her", "their", "due", "please", "awaits", "pt's",
  "patient's", "hospital", "system", "today",
];

/**
 * Diagnosis uncertainty cues. "explicit": the record says the diagnosis is not established (error when
 * written as confirmed); "uncertain": hedged (warning). Prefix cues govern the items after them, postfix
 * cues the clause before them.
 */
const EXPLICIT_PREFIX = ["待排除", "需排除", "須排除", "宜排除", "鑑別診斷", "鑑別", "r/o", "rule out", "rule-out", "to rule out", "ddx", "differential diagnosis", "differential", "疑似", "擬診", "暫定診斷"];
const EXPLICIT_POSTFIX = ["待排除", "尚未確立", "未確立", "尚未確診", "未確診", "待確診", "仍待確診", "尚待確認", "尚未證實", "未證實", "not established", "not yet established", "not confirmed", "not yet confirmed", "unconfirmed", "to be ruled out", "to be excluded", "not yet diagnosed", "疑似", "可能性", "?", "？"];
const UNCERTAIN_PREFIX = ["可能", "懷疑", "考慮", "疑", "possible", "probable", "likely", "suspected", "suspect", "suspicious for", "suspicion of", "consider", "query", "questionable", "impression of"];
const UNCERTAIN_POSTFIX = ["待確認", "待釐清", "待查", "待追蹤", "可能", "suspected", "possible", "probable", "likely", "pending", "questionable"];
/** Cues that pull the explicit set into the "uncertain" tier (疑似 = suspected: provisional, but not "not established"). */
const SUSPECTED = new Set(["疑似", "擬診", "暫定診斷", "可能性", "?", "？"]);
const CONFIRM = ["確診", "確定診斷", "診斷確立", "已確立", "證實", "確認為", "確定為", "confirmed", "proven", "biopsy-proven", "diagnosed with", "diagnosis of"];

export const RECORD_CHECKS_LEXICON = {
  name: "record-checks-lexicon",
  version: "1.0.0",
  absence: {
    negPrefixesZh: NEG_PREFIXES_ZH,
    processVerbsZh: PROCESS_VERBS_ZH,
    progressVerbsZh: PROGRESS_VERBS_ZH,
    progressPrefixesZh: PROGRESS_PREFIXES_ZH,
    wordsZh: ABSENCE_WORDS_ZH,
    nilZh: NIL_WORDS_ZH,
    notVerbsEn: NOT_VERBS_EN,
    wordsEn: ABSENCE_WORDS_EN,
    nilEn: NIL_WORDS_EN,
  },
  fieldNouns: { zh: FIELD_NOUNS_ZH, en: FIELD_NOUNS_EN },
  fillers: { zh: FILLERS_ZH, en: FILLERS_EN },
  diagnosis: {
    explicitPrefix: EXPLICIT_PREFIX,
    explicitPostfix: EXPLICIT_POSTFIX,
    uncertainPrefix: UNCERTAIN_PREFIX,
    uncertainPostfix: UNCERTAIN_POSTFIX,
    suspected: [...SUSPECTED],
    confirm: CONFIRM,
  },
} as const;

export const RECORD_CHECKS_LEXICON_VERSION = `${RECORD_CHECKS_LEXICON.name} ${RECORD_CHECKS_LEXICON.version}`;
export const RECORD_CHECKS_LEXICON_SHA256 = createHash("sha256").update(JSON.stringify(RECORD_CHECKS_LEXICON)).digest("hex");

// ------------------------------------------------------------------------------------------- term table

type TermClass = "absence" | "nil" | "noun" | "filler";

function absenceTermsZh(): string[] {
  const out = new Set<string>(ABSENCE_WORDS_ZH);
  for (const p of NEG_PREFIXES_ZH) for (const v of PROCESS_VERBS_ZH) out.add(p + v);
  for (const v of PROGRESS_VERBS_ZH) {
    out.add(`${v}中`);
    out.add(`${v}失敗`);
    for (const p of PROGRESS_PREFIXES_ZH) out.add(p + v);
  }
  return [...out];
}

function absenceTermsEn(): string[] {
  const out = new Set<string>(ABSENCE_WORDS_EN);
  for (const v of NOT_VERBS_EN) {
    for (const pre of ["not", "not yet", "not been", "not yet been", "never", "never been", "yet to be", "to be", "still to be", "not being"]) out.add(`${pre} ${v}`);
    out.add(`un${v}`);
  }
  return [...out];
}

interface Term {
  text: string;
  cls: TermClass;
  latin: boolean;
}

function buildTerms(): Term[] {
  const t: Term[] = [];
  const add = (xs: Iterable<string>, cls: TermClass): void => {
    for (const x0 of xs) {
      const x = nfkc(x0);
      t.push({ text: x, cls, latin: /^[a-z0-9]/u.test(x) || /[a-z0-9]$/u.test(x) });
    }
  };
  add(absenceTermsZh(), "absence");
  add(absenceTermsEn(), "absence");
  add(NIL_WORDS_ZH, "nil");
  add(NIL_WORDS_EN, "nil");
  add(FIELD_NOUNS_ZH, "noun");
  add(FIELD_NOUNS_EN, "noun");
  add(FILLERS_ZH, "filler");
  add(FILLERS_EN, "filler");
  // Longest first: the cover prefers whole predicates; ties keep insertion order (absence before noun / filler).
  return t.sort((a, b) => b.text.length - a.text.length);
}

const TERMS = buildTerms();
const TERMS_BY_FIRST = new Map<string, Term[]>();
for (const term of TERMS) {
  const k = term.text[0];
  const list = TERMS_BY_FIRST.get(k);
  if (list) list.push(term);
  else TERMS_BY_FIRST.set(k, [term]);
}

const RE_SKIP = /[\s\p{P}\p{S}]/u;
const RE_LATIN = /[a-z0-9]/u;
const RE_DIGIT_RUN = /\d{3,}/u;
/** A value made only of placeholder marks (--, ??, xxx, ***, ___). */
const RE_PLACEHOLDER = /^(?:x{2,}|[?？]+|[-_*.。·—–]+|○+|＊+)$/u;
/** Longest value examined: absence phrases are short; a long text is narrative, not a field value. */
const MAX_VALUE_LENGTH = 160;

export interface AbsenceMatch {
  /** The absence predicates that cover the value, in order (e.g. ["建檔失敗", "尚未取號"]). */
  predicates: string[];
  /** True when the value is a bare placeholder (--, ??, xxx). */
  placeholder?: boolean;
}

/**
 * Does the WHOLE value describe the absence of the information? `allowNil` admits nil words
 * (無 / none / N/A / -) as predicates — for fields that need a structured value, where "none" cannot
 * be the value itself.
 */
export function absenceOf(value: unknown, allowNil: boolean): AbsenceMatch | null {
  if (typeof value !== "string") return null;
  const t = nfkc(value).trim();
  if (!t || t.length > MAX_VALUE_LENGTH) return null;
  if (RE_PLACEHOLDER.test(t)) return allowNil ? { predicates: [value.trim()], placeholder: true } : null;
  if (RE_DIGIT_RUN.test(t)) return null; // still carries real content (a number / an id)
  const n = t.length;
  // best[i] = [predicate count, predicates] of a full cover of t[0..i), or null when unreachable.
  const best: Array<[number, string[]] | null> = new Array(n + 1).fill(null);
  best[0] = [0, []];
  for (let i = 0; i < n; i++) {
    const cur = best[i];
    if (!cur) continue;
    const relax = (j: number, add: string | null): void => {
      const next: [number, string[]] = add ? [cur[0] + 1, [...cur[1], add]] : cur;
      const old = best[j];
      if (!old || next[0] > old[0]) best[j] = next;
    };
    if (RE_SKIP.test(t[i])) relax(i + 1, null);
    for (const term of TERMS_BY_FIRST.get(t[i]) ?? []) {
      if (!t.startsWith(term.text, i)) continue;
      const j = i + term.text.length;
      // Latin terms are whole words: no letter / digit glued to either side.
      if (term.latin && ((i > 0 && RE_LATIN.test(t[i - 1]) && RE_LATIN.test(term.text[0])) || (j < n && RE_LATIN.test(t[j]) && RE_LATIN.test(term.text[term.text.length - 1])))) continue;
      const isPred = term.cls === "absence" || (term.cls === "nil" && allowNil);
      if (term.cls === "nil" && !allowNil) continue;
      relax(j, isPred ? term.text : null);
    }
  }
  const end = best[n];
  if (!end || end[0] === 0) return null;
  return { predicates: end[1] };
}

// ------------------------------------------------------------------------------------------- diagnosis cues

export type CueStrength = "explicit" | "uncertain";

export interface CueHit {
  cue: string;
  strength: CueStrength;
  /** prefix cues govern what follows, postfix cues what precedes. */
  position: "prefix" | "postfix";
  start: number;
  end: number;
}

function cueList(): Array<{ text: string; strength: CueStrength; position: "prefix" | "postfix" }> {
  const out: Array<{ text: string; strength: CueStrength; position: "prefix" | "postfix" }> = [];
  for (const c of EXPLICIT_PREFIX) out.push({ text: nfkc(c), strength: SUSPECTED.has(c) ? "uncertain" : "explicit", position: "prefix" });
  for (const c of EXPLICIT_POSTFIX) out.push({ text: nfkc(c), strength: SUSPECTED.has(c) ? "uncertain" : "explicit", position: "postfix" });
  for (const c of UNCERTAIN_PREFIX) out.push({ text: nfkc(c), strength: "uncertain", position: "prefix" });
  for (const c of UNCERTAIN_POSTFIX) out.push({ text: nfkc(c), strength: "uncertain", position: "postfix" });
  return out.sort((a, b) => b.text.length - a.text.length);
}
const CUES = cueList();
const CONFIRM_NORM = CONFIRM.map((c) => nfkc(c)).sort((a, b) => b.length - a.length);

function latinBoundaryOk(t: string, i: number, j: number, term: string): boolean {
  if (RE_LATIN.test(term[0]) && i > 0 && RE_LATIN.test(t[i - 1])) return false;
  if (RE_LATIN.test(term[term.length - 1]) && j < t.length && RE_LATIN.test(t[j])) return false;
  return true;
}

/** Uncertainty cues in an nfkc-normalised text (longest match at each position; non-overlapping). */
export function cuesIn(t: string): CueHit[] {
  const out: CueHit[] = [];
  for (let i = 0; i < t.length; ) {
    let hit = false;
    for (const c of CUES) {
      if (!t.startsWith(c.text, i)) continue;
      const j = i + c.text.length;
      if (!latinBoundaryOk(t, i, j, c.text)) continue;
      // the same word can be prefix and postfix (疑似 / 待排除): report both readings
      for (const d of CUES) if (d.text === c.text) out.push({ cue: c.text, strength: d.strength, position: d.position, start: i, end: j });
      i = j;
      hit = true;
      break;
    }
    if (!hit) i++;
  }
  return out;
}

/** Confirmation cues (確診, confirmed …) that are not part of a negated / pending cue (尚未確診, not confirmed). */
export function confirmsIn(t: string, cues: CueHit[]): Array<{ start: number; end: number; cue: string }> {
  const out: Array<{ start: number; end: number; cue: string }> = [];
  for (const c of CONFIRM_NORM) {
    for (let i = t.indexOf(c); i >= 0; i = t.indexOf(c, i + 1)) {
      const j = i + c.length;
      if (!latinBoundaryOk(t, i, j, c)) continue;
      if (cues.some((h) => h.start <= i && j <= h.end)) continue;
      // a negation right before it (未證實 / 尚未確診 / not confirmed / un-confirmed) is a pending cue, not a confirmation
      const before = t.slice(Math.max(0, i - 4), i);
      if (/(未|沒|無|不|待)$/u.test(before) || /\b(not|never|un)\s*$/u.test(before) || /not\s+(yet\s+)?$/u.test(t.slice(Math.max(0, i - 10), i))) continue;
      out.push({ start: i, end: j, cue: c });
    }
  }
  return out;
}
