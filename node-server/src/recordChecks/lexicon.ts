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
const NEG_PREFIXES_ZH = ["尚未", "還未", "仍未", "迄未", "未", "還沒有", "還沒", "沒有", "沒", "尚無", "仍無", "無法", "未能", "不能", "尚待", "有待", "待", "等待", "等候", "忘記", "忘了", "拒絕", "拒"];
/** Process verbs a record uses for information that has not been produced yet. */
const PROCESS_VERBS_ZH = [
  "取號", "取得", "取", "給號", "配號", "編號", "建檔", "建立", "提供", "帶", "帶來", "攜帶", "記載", "記錄", "紀錄", "登錄",
  "登記", "填寫", "填", "輸入", "確認", "確定", "確立", "確診", "核發", "發給", "發放", "申請", "辦理", "告知", "測量", "量測",
  "量", "檢驗", "檢測", "回報", "出來", "得知", "查到", "查詢", "掛號", "報到", "補", "補登", "補上", "補齊", "補充", "決定",
  "安排", "開立", "釐清", "詢問", "問到", "知道", "核對", "核實", "上傳", "完成",
  // 1.1.0 (ISSUES_v15.1): results that were not obtained / not readable (未得數值, 無法辨識, 未發報告)
  "得", "得到", "得出", "測得", "測出", "驗出", "發", "發出", "辨識", "辨認", "判讀", "讀出", "看清", "看清楚", "下", "訂", "抽血", "採檢", "採血",
  // 1.2.0 (ISSUES_v15.3 R1): diagnoses / results still to come (待排除, 尚未診斷, 待重抽, 未出報告)
  "排除", "診斷", "判定", "重抽", "重驗", "重測", "重做", "重新抽血", "重新採檢", "出報告", "發報告", "出爐", "測", "驗", "做",
];
/** Verbs that combine with 中 (in progress) / 失敗 (failed) / 尚在 … (still being …). */
const PROGRESS_VERBS_ZH = [
  "申請", "辦理", "處理", "確認", "建檔", "取號", "查詢", "審核", "核發", "補辦", "掛號", "登錄", "登記", "讀卡", "讀取", "上傳", "配號",
  // 1.2.0 (ISSUES_v15.3 R1): results / diagnoses in progress (重抽中, 送驗中, 培養中, 鑑別中, 觀察中)
  "重抽", "重驗", "重測", "重做", "送驗", "檢驗", "化驗", "培養", "判讀", "分析", "鑑別", "評估", "觀察", "追蹤", "排除", "外送",
];
const PROGRESS_PREFIXES_ZH = ["尚在", "仍在", "正在", "還在", "目前在"];
/** Standalone absence predicates. */
const ABSENCE_WORDS_ZH = [
  "不詳", "未詳", "不明", "不清楚", "不知道", "不知", "未知", "不確定", "未定", "空白", "從缺", "缺漏", "缺少", "缺", "遺失", "遺漏",
  "查無資料", "查無此人", "查無", "無資料", "沒資料", "沒有資料", "無此資料", "無紀錄", "無記錄", "無記載", "待補登", "待補", "待查",
  "待定", "再補", "後補", "另補", "稍後補", "不提供", "拒絕提供", "拒提供", "拒答", "未填", "尚無", "暫無", "目前無", "無從得知",
  "無法得知", "無法提供", "無法確認", "沒帶", "未帶",
  // 1.1.0 (ISSUES_v15.1): failed / unreadable measurements and documents
  "機器錯誤", "儀器錯誤", "機器故障", "儀器故障", "故障", "失效", "字跡模糊", "字跡不清", "模糊不清", "模糊", "看不清", "看不清楚",
  "難以辨識", "無法判讀", "無結果", "無數值", "無報告", "未出", "未出來", "尚未出來", "未回", "尚未回", "未回報", "作廢", "退件",
  // 1.2.0 (ISSUES_v15.3 R1): not determined / not established / pending (the diagnosis-slot cues are added as well, see SLOT_CUES)
  "待", "未明", "原因未明", "原因不明", "不下", "暫不下", "未確定", "尚未確定", "無定論", "尚無定論", "未定論",
];
/** Nil words: count as absence only in fields that need a structured value (identifier, date, quantity, name, reference). */
const NIL_WORDS_ZH = ["無", "沒有", "空", "無號"];

const NOT_VERBS_EN = [
  "assigned", "available", "provided", "recorded", "documented", "known", "stated", "specified", "given", "issued", "obtained",
  "confirmed", "determined", "registered", "created", "entered", "measured", "reported", "brought", "established", "allocated",
  "generated", "filed", "verified", "collected", "done", "received",
  // 1.2.0 (ISSUES_v15.3 R1)
  "performed", "drawn", "resulted", "diagnosed", "finalized", "finalised", "released", "back", "out", "available yet", "ruled out",
];
const ABSENCE_WORDS_EN = [
  "unknown", "unk", "n/a", "not applicable", "unavailable", "unspecified", "unassigned", "undetermined", "unconfirmed", "unrecorded",
  "undocumented", "pending", "awaiting", "tbd", "tba", "tbc", "missing", "no data", "no record", "no records", "no information",
  "no info", "registration failed", "failed", "declined", "refused", "withheld", "blank", "empty", "not on file", "on order",
  "in progress", "forgot", "forgotten",
  // 1.1.0 (ISSUES_v15.1)
  "illegible", "unreadable", "not readable", "machine error", "instrument error", "error", "hemolyzed", "haemolyzed", "no result",
  "no value", "not resulted", "cancelled", "canceled",
  // 1.2.0 (ISSUES_v15.3 R1)
  "result pending", "results pending", "pending result", "pending results", "awaiting result", "awaiting results", "redraw", "redrawn",
  "being redrawn", "to be redrawn", "recollect", "recollection", "repeat pending", "to follow", "tbd", "inconclusive", "indeterminate",
];
const NIL_WORDS_EN = ["none", "nil", "null", "na", "n.a.", "-"];

/** Field nouns: words naming the field itself (病歷號尚未取號 = MRN + predicate). */
const FIELD_NOUNS_ZH = [
  "病歷號碼", "病歷號", "病歷編號", "病歷", "身分證字號", "身分證號碼", "身分證號", "身分證統一編號", "身分證", "身份證字號", "身份證號碼",
  "身份證號", "身份證", "統一證號", "居留證號碼", "居留證號", "居留證", "護照號碼", "護照號", "護照", "健保卡號", "健保卡", "健保",
  "卡號", "號碼", "編號", "證號", "字號", "識別碼", "識別號", "代碼", "代號", "號", "資料", "資訊", "日期", "時間", "時刻", "年月日",
  "數值", "數據", "結果", "報告", "劑量", "姓名", "名字", "欄位", "欄", "電話", "地址", "批號", "診斷", "藥名", "藥品", "證件", "文件",
  "住院號", "就診號", "掛號號碼", "檢驗", "檢查",
  // 1.1.0 (ISSUES_v15.1)
  "檢體", "標本", "採檢日期", "採檢時間", "採檢", "字跡", "數字", "值", "日", "時", "第一次", "第二次", "第1次", "第2次", "標籤", "條碼",
  "藥師", "醫師", "護理師",
  // 1.2.0 (ISSUES_v15.3 R1): tests / reports a pending statement names (待 CT 正式報告, 待病理報告, 快篩結果未出)
  "CT", "MRI", "X光", "X-ray", "電腦斷層", "核磁共振", "超音波", "心電圖", "切片", "病理", "病理報告", "培養", "細菌培養", "快篩", "篩檢",
  "影像", "影像報告", "正式報告", "檢驗報告", "檢查報告", "抽血", "血液", "尿液", "痰液", "鑑別診斷", "主診斷", "臆斷", "病因", "原因",
];
const FIELD_NOUNS_EN = [
  "id", "identifier", "number", "no", "no.", "#", "mrn", "chart", "record", "medical", "national", "card", "resident", "certificate",
  "passport", "nhi", "insurance", "date", "time", "datetime", "value", "result", "results", "code", "name", "dose", "field",
  "information", "info", "data", "registration", "assignment", "confirmation", "details", "documents", "document", "test", "lab",
  // 1.2.0 (ISSUES_v15.3 R1)
  "ct", "mri", "x-ray", "xray", "cxr", "ultrasound", "echo", "ecg", "ekg", "biopsy", "pathology", "culture", "cultures", "imaging",
  "scan", "workup", "work-up", "rapid", "report", "reports", "diagnosis", "dx", "impression", "cause", "etiology", "level", "levels",
];
const FILLERS_ZH = [
  "新病人", "新患者", "新個案", "初診", "家屬說", "家屬表示", "家屬稱", "家屬", "病人說", "病人表示", "病人稱", "病患表示", "患者表示", "個案表示", "據稱", "據家屬", "表示", "說",
  "稱", "目前", "現在", "暫時", "暫", "尚", "仍", "還", "也", "都", "均", "皆", "因為", "因", "由於", "所以", "故", "但", "而", "且",
  "已", "為", "是", "的", "之", "了", "等", "再", "會", "將", "要", "需要", "需", "請", "於", "在", "時", "此", "該", "本", "其",
  "病人", "病患", "患者", "個案", "系統", "院方", "櫃台", "櫃檯", "掛號處", "之後", "以後", "下次", "回診時", "來院", "來", "今日",
  "今天", "當天", "先", "後", "中", "所", "被", "給", "有", "一下", "一樣", "後續", "另行", "另", "補件", "下來", "完畢", "前", "申請", "辦理", "核發", "辦",
  // 1.1.0 (ISSUES_v15.1)
  "溶血", "凝固", "不足", "量不足", "因而", "導致", "致", "故而", "所以未",
  // 1.2.0 (ISSUES_v15.3 R1)
  "正式", "最終", "初步", "進一步", "暫不", "暫且", "先行", "再行", "行", "做", "作", "等", "結果後", "之前", "以前", "出來後", "後再",
];
const FILLERS_EN = [
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being", "has", "have", "had", "yet", "still", "currently", "at", "this",
  "time", "moment", "present", "as", "of", "for", "by", "per", "patient", "pt", "family", "says", "said", "and", "or", "but", "so",
  "will", "to", "later", "until", "with", "from", "on", "in", "it", "its", "his", "her", "their", "due", "please", "awaits", "pt's",
  "patient's", "hospital", "system", "today",
  // 1.1.0 (ISSUES_v15.1)
  "specimen", "sample", "machine", "first", "second", "reading", "measurement", "report", "due",
  // 1.2.0 (ISSUES_v15.3 R1)
  "official", "formal", "final", "further", "repeat", "result", "results", "after", "before", "need", "needs", "needed",
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

/**
 * 1.1.0 (ISSUES_v15.1 R3): headings of the record's PRIMARY diagnosis slot (the label before ：/: at the
 * start of a line; SOAP "A:"), headings of a differential-only slot, and headings of secondary slots
 * (never primary). Matched on the whole label after NFKC + lower case.
 */
const PRIMARY_DX_HEADINGS = [
  "診斷", "主診斷", "主要診斷", "臆斷", "初步診斷", "臨床診斷", "門診診斷", "急診診斷", "入院診斷", "出院診斷", "工作診斷", "暫時診斷",
  "診斷結果", "醫師診斷", "醫師判定", "病名", "評估", "臆測診斷", "impression", "imp", "clinical impression", "assessment", "a/p",
  "assessment and plan", "assessment & plan", "dx", "diagnosis", "diagnoses", "working diagnosis", "primary diagnosis",
  "principal diagnosis", "main diagnosis", "final diagnosis", "admission diagnosis", "discharge diagnosis", "ed diagnosis",
  "provisional diagnosis", "final dx", "discharge dx", "admission dx", "ed dx", "er dx", "primary dx", "working dx", "main dx",
  "principal dx", "dx/impression", "impression/dx", "a",
];
const DIFFERENTIAL_HEADINGS = ["鑑別診斷", "鑑別", "ddx", "dd", "differential diagnosis", "differential diagnoses", "differentials", "differential", "r/o", "rule out", "待排除"];
const SECONDARY_DX_HEADINGS = ["次診斷", "副診斷", "其他診斷", "共病", "secondary diagnosis", "secondary diagnoses", "comorbidity", "comorbidities", "other diagnoses", "pmh", "過去病史"];
/**
 * Slot-level cues: the slot as a whole says no diagnosis is established yet (未下診斷, diagnosis
 * pending …) — they qualify the slot, not one listed item. Plus regular patterns for "no diagnosis
 * before / until <a result>" (快篩結果出來前不下診斷, 待報告後再下診斷, no diagnosis until …).
 */
const SLOT_CUES = [
  "未下診斷", "尚未下診斷", "暫不下診斷", "不下診斷", "先不下診斷", "暫不診斷", "診斷未定", "診斷待定", "診斷未明", "診斷不明", "尚無診斷",
  "尚無明確診斷", "無明確診斷", "未有明確診斷", "沒有明確診斷", "診斷尚未確立", "診斷未確立", "尚未確立診斷", "未能確立診斷", "診斷待確認",
  "診斷尚待確認", "待確診", "有待確診", "仍待確診", "鑑別中", "鑑別診斷中", "待鑑別", "仍在鑑別", "尚在鑑別", "待釐清診斷", "原因待查",
  "no diagnosis", "no definitive diagnosis", "no definite diagnosis", "no final diagnosis", "no firm diagnosis", "no established diagnosis",
  "diagnosis pending", "diagnosis deferred", "diagnosis not established", "diagnosis not yet established", "diagnosis undetermined",
  "diagnosis uncertain", "diagnosis unclear", "diagnosis to be determined", "undiagnosed", "not yet diagnosed", "pending diagnosis",
  "to be determined", "work-up pending", "workup pending", "pending work-up", "pending workup",
];
const SLOT_CUE_PATTERNS = [
  String.raw`(前|之前|以前)[^，,。；;]{0,8}(不|暫不|先不|未|勿|不予)[^，,。；;]{0,3}(下|做|作|定|給)?[^，,。；;]{0,2}診斷`,
  String.raw`待[^，,。；;]{1,24}(結果|報告|檢查|回報)[^，,。；;]{0,8}(後|再)[^，,。；;]{0,8}(下|做|作|確定|決定|確立)[^，,。；;]{0,2}診斷`,
  String.raw`\bno\s+(definitive\s+|final\s+|firm\s+|definite\s+)?diagnos\w*\s+(until|before|pending|prior)`,
  String.raw`\bdiagnos\w*\s+(will\s+be|to\s+be|is\s+to\s+be)\s+(made|determined|confirmed|established|decided)`,
  String.raw`\b(await|awaiting|pending)\s+[^,.;]{1,40}\bbefore\s+(making\s+)?(a\s+)?diagnos`,
];
/** Item separators inside a diagnosis slot (top level, outside brackets). */
const SLOT_ITEM_SEPARATORS = ["、", "；", ";", "，", ",", "／", "/", " vs. ", " vs ", " versus ", "或", " or ", "及", " and "];
/** Cues that an item was considered and EXCLUDED (resolved, not pending): such items are neither established nor open. */
const REFUTED_CUES = ["已排除", "可排除", "予以排除", "排除了", "已除外", "不支持", "不考慮", "ruled out", "excluded", "was excluded", "negative work-up", "negative workup"];
/** ICD-10 chapter XVIII (R00–R99): symptoms, signs and abnormal findings — never a main diagnosis that is still to be ruled out. */
const SYMPTOM_ICD = "^R\\d{2}";
/** SNOMED CT semantic tags (FSN display) of findings that are symptoms rather than disorders. */
const SYMPTOM_SNOMED_TAGS = ["(finding)", "(symptom)", "(observable entity)", "(situation)"];

/**
 * 1.1.0 (ISSUES_v15.1 R1 / R4): record field labels whose value can be STATED ABSENT in the record
 * ("採檢日期：無法辨識", "病歷號：申請中"), keyed by the field family they name. A Bundle value for that
 * field then does not come from the record. Matched as a substring of the label before ：/: (NFKC, lower case).
 */
const STATED_ABSENT_LABELS: Record<string, string[]> = {
  mrn: ["病歷號", "病歷號碼", "病歷編號", "mrn", "chart no", "chart number", "medical record no", "medical record number"],
  national_id: ["身分證", "身份證", "統一編號", "national id", "id no", "id number"],
  resident_id: ["居留證", "統一證號", "arc no", "resident certificate"],
  passport: ["護照", "passport"],
  nhi_card: ["健保卡號", "健保卡", "nhi card"],
  encounter_id: ["住院號", "住院號碼", "就診號", "就診號碼", "急診號", "門診號", "掛號號碼", "批價號", "adm no", "admission no", "admission number", "visit no", "visit number", "encounter no", "encounter number"],
  birth: ["出生日期", "出生", "生日", "dob", "date of birth", "birth date"],
  visit: ["就診日期", "就診日", "看診日期", "門診日期", "到院日期", "到院時間", "入院日期", "入院時間", "visit date", "encounter date", "admission date", "arrival time"],
  discharge: ["出院日期", "出院時間", "離院時間", "discharge date", "discharge time"],
  collection: ["採檢日期", "採檢時間", "採檢", "採血日期", "採血時間", "採血", "檢體採集", "採集日期", "採集時間", "收檢", "collection date", "collection time", "collected", "specimen date", "specimen collected"],
  test_date: ["檢查日期", "檢驗日期", "報告日期", "報告時間", "檢查時間", "test date", "report date", "exam date"],
  onset: ["發病日期", "發病時間", "發病", "發作時間", "起始日期", "onset date", "onset"],
  order_date: ["開立日期", "處方日期", "開藥日期", "order date", "prescription date"],
  vaccination_date: ["接種日期", "接種時間", "vaccination date", "immunization date"],
  procedure_date: ["手術日期", "手術時間", "處置日期", "operation date", "surgery date", "procedure date"],
  medication: ["處方", "藥物", "用藥", "藥品", "開立藥物", "出院帶藥", "medication", "medications", "rx", "prescription", "discharge medication", "discharge medications"],
};

/**
 * 1.2.0 (ISSUES_v15.3 R1): "no result" vocabulary that counts as an absence predicate ONLY in a result slot — an
 * Observation whose code needs a quantitative result (its valueString / note): specimen problems (溶血, 凝固,
 * 檢體不足, hemolyzed, clotted, QNS) and pointers elsewhere (詳見報告, see report, sent out). Elsewhere they are fillers
 * ("hemolyzed" is a real result of a serum-appearance test, 溶血 a Condition name).
 */
const RESULT_ABSENCE_ZH = ["溶血", "凝固", "檢體溶血", "檢體凝固", "檢體不足", "量不足", "檢體量不足", "見報告", "詳見報告", "另見報告", "參見報告", "外送", "送外院", "拒收"];
const RESULT_ABSENCE_EN = ["hemolyzed", "haemolyzed", "hemolysis", "clotted", "qns", "quantity not sufficient", "insufficient", "insufficient sample", "see report", "see attached", "see below", "sent out", "send out", "send-out"];

export const RECORD_CHECKS_LEXICON = {
  name: "record-checks-lexicon",
  // 1.1.0 (ISSUES_v15.1): measurement / document failure vocabulary; primary-diagnosis slot headings and cues; stated-absent field labels.
  // 1.2.0 (ISSUES_v15.3 R1): pending / not-determined / not-established / being-redrawn vocabulary for text fields (the
  //   diagnosis-slot cues count as absence predicates too), test / report nouns, and the result-slot-only "no result" words.
  version: "1.2.0",
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
  resultOnly: { zh: RESULT_ABSENCE_ZH, en: RESULT_ABSENCE_EN },
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
  diagnosisSlot: {
    primaryHeadings: PRIMARY_DX_HEADINGS,
    differentialHeadings: DIFFERENTIAL_HEADINGS,
    secondaryHeadings: SECONDARY_DX_HEADINGS,
    slotCues: SLOT_CUES,
    slotCuePatterns: SLOT_CUE_PATTERNS,
    itemSeparators: SLOT_ITEM_SEPARATORS,
    refutedCues: REFUTED_CUES,
    symptomIcd: SYMPTOM_ICD,
    symptomSnomedTags: SYMPTOM_SNOMED_TAGS,
  },
  statedAbsentLabels: STATED_ABSENT_LABELS,
} as const;

export const RECORD_CHECKS_LEXICON_VERSION = `${RECORD_CHECKS_LEXICON.name} ${RECORD_CHECKS_LEXICON.version}`;
export const RECORD_CHECKS_LEXICON_SHA256 = createHash("sha256").update(JSON.stringify(RECORD_CHECKS_LEXICON)).digest("hex");

// ------------------------------------------------------------------------------------------- term table

type TermClass = "absence" | "nil" | "noun" | "filler" | "result";

function absenceTermsZh(): string[] {
  // 1.2.0: the slot-level diagnosis cues (未下診斷, 暫不下診斷, 診斷未定 …) are absence statements of a diagnosis field too
  const out = new Set<string>([...ABSENCE_WORDS_ZH, ...SLOT_CUES.filter((c) => !/^[a-z]/u.test(c))]);
  for (const p of NEG_PREFIXES_ZH) for (const v of PROCESS_VERBS_ZH) out.add(p + v);
  for (const v of PROGRESS_VERBS_ZH) {
    out.add(`${v}中`);
    out.add(`${v}失敗`);
    for (const p of PROGRESS_PREFIXES_ZH) out.add(p + v);
  }
  return [...out];
}

function absenceTermsEn(): string[] {
  const out = new Set<string>([...ABSENCE_WORDS_EN, ...SLOT_CUES.filter((c) => /^[a-z]/u.test(c))]);
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
  add(RESULT_ABSENCE_ZH, "result");
  add(RESULT_ABSENCE_EN, "result");
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

/** Measurement-time qualifiers a result slot may carry (3 h, 2hr, 07:00, 第2次): skipped in result mode. */
const RE_RESULT_TIME = /(?<![\d.])\d{1,2}\s*(?:h|hr|hrs|小時|分鐘|分|min|mins)(?![a-z])|(?<!\d)\d{1,2}:\d{2}(?!\d)/gu;

export interface AbsenceOptions {
  /**
   * 1.2.0 (ISSUES_v15.3 R1): the value is the result of an Observation whose code needs a quantitative result
   * (valueString / note): the result-only vocabulary (溶血, 檢體不足, see report …) counts as absence predicates and
   * measurement-time qualifiers (3 h, 07:00) are skipped.
   */
  result?: boolean;
}

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
export function absenceOf(value: unknown, allowNil: boolean, opts: AbsenceOptions = {}): AbsenceMatch | null {
  if (typeof value !== "string") return null;
  let t = nfkc(value).trim();
  if (opts.result) t = t.replace(RE_RESULT_TIME, (m) => " ".repeat(m.length)).trim();
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
      const isPred = term.cls === "absence" || (term.cls === "nil" && allowNil) || (term.cls === "result" && !!opts.result);
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

// ------------------------------------------------------------------------------------------- v15.1 tables (normalised)

const nf = (xs: readonly string[]): string[] => [...new Set(xs.map((x) => nfkc(x).trim()))].sort((a, b) => b.length - a.length);

/** Diagnosis-slot vocabulary (ISSUES_v15.1 R3), NFKC + lower case, longest first. */
export const DX_SLOT = {
  primary: new Set(nf(PRIMARY_DX_HEADINGS)),
  differential: new Set(nf(DIFFERENTIAL_HEADINGS)),
  secondary: new Set(nf(SECONDARY_DX_HEADINGS)),
  slotCues: nf(SLOT_CUES),
  slotCuePatterns: SLOT_CUE_PATTERNS.map((p) => new RegExp(p, "u")),
  separators: nf(SLOT_ITEM_SEPARATORS.map((s) => s.replace(/^ | $/gu, "\u0000"))).map((s) => s.replace(/\u0000/gu, " ")),
  symptomIcd: new RegExp(SYMPTOM_ICD, "u"),
  symptomSnomedTags: nf(SYMPTOM_SNOMED_TAGS),
  refuted: nf(REFUTED_CUES),
} as const;

/** Stated-absent field labels (ISSUES_v15.1 R1 / R4): family → labels (NFKC + lower case, longest first). */
export const ABSENT_LABELS: ReadonlyArray<readonly [string, string]> = Object.entries(STATED_ABSENT_LABELS)
  .flatMap(([fam, ls]) => ls.map((l) => [nfkc(l), fam] as const))
  .sort((a, b) => b[0].length - a[0].length);
