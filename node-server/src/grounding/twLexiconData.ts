/**
 * Taiwan clinical-text lexicon for the grounding engine — VERSIONED DATA.
 *
 * Initially exported from the Python reference (mcp_proposal/reference/tw_lexicon.py tw-lexicon 0.1.0 and the
 * lexical tables of grounding_ref.py) by scripts/export_lexicon.py. This module is now the source of truth:
 * any change to a table must bump `version`; the SHA-256 of the canonical JSON of this object is reported as
 * `lexiconSha256` in tool provenance so results can be tied to an exact lexicon.
 *
 * Regex sources are written in Python `re` syntax (Unicode `\b` / `\w`); lexicon.ts translates them.
 */

export const TW_LEXICON_DATA = {
 "name": "tw-lexicon",
 "version": "0.3.0",
 "basedOn": "tw_lexicon.py 0.1.0 (reference) + PAS tables (0.2.0) + issues-v1 fixes (0.3.0: whole-label stated-absent concepts, zh/en department and setting aliases, NHI lab bridges)",
 "normalization": {
  "dashes": "‐‑‒–—―−－ー",
  "keepSymbols": "#%*+-./<>^~°×"
 },
 "sections": {
  "terms": {
   "diagnosis": [
    "assessment",
    "a/p",
    "impression",
    "imp",
    "dx",
    "diagnosis",
    "diagnoses",
    "discharge dx",
    "discharge diagnosis",
    "admission diagnosis",
    "final diagnosis",
    "principal",
    "comorbidity",
    "secondary",
    "診斷",
    "臆斷",
    "出院診斷",
    "入院診斷",
    "急診診斷",
    "主診斷",
    "次診斷",
    "副診斷",
    "診斷結果",
    "醫師判定",
    "評估",
    "病名",
    "problem list",
    "active problems",
    "問題列表",
    "問題清單",
    "problems",
    "assessment & plan",
    "assessment and plan"
   ],
   "chief_complaint": [
    "cc",
    "chief complaint",
    "主訴"
   ],
   "hpi": [
    "hpi",
    "present illness",
    "現病史",
    "subjective",
    "病史",
    "hx"
   ],
   "history": [
    "pmh",
    "past history",
    "past medical history",
    "過去病史",
    "既往病史",
    "既往史",
    "phx",
    "psh",
    "手術史",
    "疫苗紀錄",
    "接種紀錄",
    "immunization history",
    "vaccination record",
    "用藥史"
   ],
   "family_history": [
    "fhx",
    "fh",
    "family history",
    "家族史"
   ],
   "exam": [
    "pe",
    "physical exam",
    "physical examination",
    "理學檢查",
    "身體檢查",
    "objective",
    "vital signs",
    "triage vital signs",
    "生命徵象",
    "檢傷",
    "vs"
   ],
   "lab": [
    "lab",
    "labs",
    "laboratory",
    "檢驗",
    "實驗室檢查",
    "er labs",
    "檢驗結果"
   ],
   "plan": [
    "plan",
    "p/",
    "tx",
    "treatment",
    "rx",
    "處置",
    "處方",
    "治療",
    "用藥",
    "discharge meds",
    "出院帶藥",
    "medication",
    "medications",
    "meds",
    "ed course",
    "course",
    "hospital course",
    "住院經過",
    "病程",
    "disposition"
   ],
   "rule_out": [
    "r/o",
    "rule out",
    "ddx",
    "鑑別診斷"
   ]
  },
  "soapLetters": {
   "s": "hpi",
   "o": "exam",
   "a": "diagnosis",
   "p": "plan"
  },
  "instructionMarkers": [
   "【轉換目標】"
  ],
  "siteConfigMarker": "【院所設定】",
  "singleLineSections": [
   "rule_out"
  ]
 },
 "context": {
  "negCues": [
   "否認",
   "沒有",
   "無",
   "未見",
   "denies",
   "denied",
   "deny",
   "no ",
   "negative for",
   "without",
   "r/o",
   "rule out",
   "rule-out",
   "排除",
   "不支持",
   "不考慮",
   "ruled out",
   "nkda"
  ],
  "uncertainCues": [
   "疑似",
   "可能",
   "suspect",
   "suspected",
   "possible",
   "probable",
   "?",
   "待釐清",
   "待排除",
   "尚未確立",
   "未確立",
   "pending"
  ],
  "histCues": [
   "上次",
   "前次",
   "之前",
   "先前",
   "過去",
   "曾",
   "去年",
   "previous",
   "prior",
   "last time",
   "history of",
   "初診時",
   "當時"
  ],
  "clauseSplit": "[；;。\\n]|，(?=\\s*(?:r/o|R/O|否認|排除|但|無))",
  "obsHistCues": [
   "上次",
   "前次",
   "previous",
   "prior",
   "初診時",
   "當時",
   "舊值"
  ],
  "absenceWords": [
   "未記載",
   "未記錄",
   "未紀錄",
   "不詳",
   "未知",
   "待補登",
   "待補",
   "空白",
   "未提供",
   "不明",
   "unknown",
   "not recorded",
   "not documented",
   "n/a",
   "未填"
  ],
  "absenceConcepts": {
   "date": [
    "日期",
    "時間",
    "時刻",
    "施測日",
    "檢查日",
    "採檢日",
    "date",
    "time",
    "datetime"
   ],
   "dose": [
    "劑量",
    "用量",
    "dose",
    "dosage"
   ],
   "frequency": [
    "頻次",
    "頻率",
    "frequency"
   ],
   "name": [
    "姓名",
    "名字",
    "name"
   ],
   "mrn": [
    "病歷號",
    "病歷號碼",
    "病歷編號",
    "mrn",
    "chart no",
    "chart no.",
    "chart number",
    "medical record number"
   ],
   "national_id": [
    "身分證",
    "身份證",
    "身分證號",
    "身份證號",
    "身分證字號",
    "身份證字號",
    "身分證號碼",
    "身分證統一編號",
    "national id",
    "id no",
    "id no."
   ],
   "birthDate": [
    "出生",
    "出生日期",
    "出生日",
    "出生年月日",
    "生日",
    "dob",
    "date of birth",
    "birth date",
    "birthdate",
    "birthday"
   ],
   "diagnosis": [
    "診斷",
    "diagnosis",
    "dx"
   ],
   "value": [
    "數值",
    "結果",
    "value",
    "result"
   ]
  },
  "absencePatientConcepts": [
   "name",
   "mrn",
   "national_id",
   "birthDate"
  ],
  "absenceLabelQualifiers": [
   "病人",
   "病患",
   "患者",
   "個案",
   "受檢者",
   "patient",
   "pt",
   "patient's"
  ],
  "absenceLabelFillers": [
   "欄位",
   "欄",
   "項目",
   "資料",
   "資訊",
   "部分",
   "field"
  ],
  "absenceValueFillers": [
   "均",
   "皆",
   "都",
   "仍",
   "尚",
   "暫",
   "目前",
   "為",
   "is",
   "are",
   "was",
   "were"
  ]
 },
 "identifiers": {
  "labels": {
   "national_id": [
    "身分證",
    "身份證",
    "id no",
    "national id",
    "身分證字號",
    "身分證號",
    "統一編號"
   ],
   "mrn": [
    "病歷號",
    "病歷號碼",
    "chart no",
    "chart",
    "mrn",
    "病歷"
   ],
   "encounter": [
    "住院號",
    "adm no",
    "就診號",
    "admission no",
    "visit no",
    "急診號",
    "批價號",
    "掛號"
   ],
   "practitioner": [
    "醫字",
    "證書",
    "license"
   ]
  },
  "twIdPattern": "^[a-z][12489]\\d{8}$",
  "twIdLetters": "ABCDEFGHJKLMNPQRSTUVXYWZIO",
  "noSiteSystems": [
   "http://www.moi.gov.tw",
   "http://hl7.org/fhir/sid/passport-TWN",
   "http://www.immigration.gov.tw",
   "urn:ietf:rfc:3986"
  ]
 },
 "gender": {
  "male": "男(?!友|朋友)|先生|\\bmale\\b|\\bboy\\b|(?<![a-z0-9])m(?![a-z0-9])|\\bman\\b",
  "female": "(?<!婦)女(?!兒|友|婿|性友人)|小姐|女士|\\bfemale\\b|\\bgirl\\b|(?<![a-z0-9])f(?![a-z0-9]|/u)|\\bwoman\\b|孕婦"
 },
 "dates": {
  "cnNum": {
   "一": 1,
   "二": 2,
   "兩": 2,
   "三": 3,
   "四": 4,
   "五": 5,
   "六": 6,
   "七": 7,
   "八": 8,
   "九": 9,
   "十": 10
  },
  "patterns": [
   [
    "民國\\s*(\\d{2,3})\\s*年\\s*(\\d{1,2})\\s*月\\s*(\\d{1,2})\\s*日?",
    "roc"
   ],
   [
    "(?<!\\d)(\\d{4})\\s*年\\s*(\\d{1,2})\\s*月\\s*(\\d{1,2})\\s*日?",
    "west"
   ],
   [
    "(?<!\\d)(\\d{2,3})\\s*年\\s*(\\d{1,2})\\s*月\\s*(\\d{1,2})\\s*日?",
    "roc"
   ],
   [
    "(?<![\\d.])(\\d{4})[/.\\-](\\d{1,2})[/.\\-](\\d{1,2})(?![\\d])",
    "west"
   ],
   [
    "(?<![\\d./\\-])(\\d{2,3})[/.\\-](\\d{1,2})[/.\\-](\\d{1,2})(?![\\d/])",
    "roc"
   ],
   [
    "民國\\s*(\\d{2,3})\\s*年(?!\\s*\\d{1,2}\\s*月)",
    "roc_y"
   ],
   [
    "(?<![\\d/.\\-])(\\d{1,2})/(\\d{1,2})(?![\\d/])(?=\\s|$|[^\\d])",
    "md"
   ],
   [
    "(?<!\\d)(\\d{4})\\s*[/.\\-]\\s*(\\d{1,2})(?![\\d/.\\-])",
    "ym"
   ],
   [
    "(?<!\\d)(\\d{4})\\s*年\\s*(\\d{1,2})\\s*月(?!\\s*\\d)",
    "ym"
   ],
   [
    "(?<![\\d/.])((?:19|20)\\d{2})\\s*年?(?![\\d/.\\-月])",
    "y"
   ],
   [
    "(?<!\\d)(\\d{2,3})\\s*年(?![\\d\\s]*月)",
    "roc_y"
   ]
  ],
  "time": "(?<!\\d)([01]?\\d|2[0-3])\\s*[:：]\\s*([0-5]\\d)(?:\\s*[:：]\\s*([0-5]\\d))?(?!\\d)",
  "cnTime": "(上午|下午|晚上|凌晨|中午)?\\s*(\\d{1,2})\\s*點\\s*(?:(\\d{1,2})\\s*分|半)?",
  "relative": [
   [
    "昨天|昨日|昨晚|yesterday",
    -1
   ],
   [
    "前天|前日",
    -2
   ],
   [
    "今天|今日|今晚|今早|今晨|today|tonight|當天|本日",
    0
   ],
   [
    "(\\d+)\\s*(?:天|日)前|(\\d+)\\s*days?\\s*ago",
    "n"
   ]
  ],
  "fhirDateTime": "^(\\d{4})(?:-(\\d{2})(?:-(\\d{2})(?:T(\\d{2}):(\\d{2})(?::(\\d{2})(?:\\.\\d+)?)?(Z|[+\\-]\\d{2}:\\d{2})?)?)?)?$"
 },
 "numbers": {
  "number": "(?<![\\w.])([<>≤≥]=?)?\\s*(\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?)(?:\\s*(?:x|×)\\s*10\\s*\\^?\\s*(\\d+))?",
  "unitAliases": {
   "mg/dl": [
    "mg/dl"
   ],
   "g/dl": [
    "g/dl",
    "gm/dl"
   ],
   "mmol/l": [
    "mmol/l",
    "meq/l",
    "mm"
   ],
   "umol/l": [
    "umol/l",
    "µmol/l",
    "μmol/l"
   ],
   "u/l": [
    "u/l",
    "iu/l"
   ],
   "ng/ml": [
    "ng/ml"
   ],
   "ng/dl": [
    "ng/dl"
   ],
   "ng/l": [
    "ng/l",
    "pg/ml"
   ],
   "uiu/ml": [
    "uiu/ml",
    "µiu/ml",
    "μiu/ml",
    "miu/l",
    "mu/l",
    "[iu]/ml"
   ],
   "iu/ml": [
    "iu/ml",
    "[iu]/ml"
   ],
   "%": [
    "%",
    "percent"
   ],
   "10*3/ul": [
    "10*3/ul",
    "10^3/ul",
    "k/ul",
    "x10^3/ul",
    "×10^3/ul",
    "10³/ul",
    "10^3/µl",
    "10*3/µl",
    "thou/ul",
    "x10^3",
    "×10^3",
    "10*3/mm3",
    "/nl"
   ],
   "10*6/ul": [
    "10*6/ul",
    "10^6/ul",
    "m/ul"
   ],
   "/[hpf]": [
    "/hpf",
    "/[hpf]",
    "hpf",
    "/hp"
   ],
   "cel": [
    "°c",
    "cel",
    "degc",
    "c",
    "度"
   ],
   "kg": [
    "kg",
    "公斤"
   ],
   "g": [
    "g",
    "gm",
    "公克"
   ],
   "cm": [
    "cm",
    "公分"
   ],
   "mm": [
    "mm"
   ],
   "m": [
    "m"
   ],
   "/min": [
    "/min",
    "bpm",
    "次/分",
    "次/min",
    "beats/min",
    "breaths/min",
    "{beats}/min",
    "{breaths}/min",
    "/分",
    "次"
   ],
   "mm[hg]": [
    "mmhg",
    "mm[hg]"
   ],
   "ml/min/{1.73_m2}": [
    "ml/min/1.73m2",
    "ml/min/1.73m²",
    "ml/min/{1.73_m2}",
    "ml/min/1.73 m2"
   ],
   "kg/m2": [
    "kg/m2",
    "kg/m²",
    "kg/㎡"
   ],
   "mg": [
    "mg",
    "毫克"
   ],
   "ug": [
    "mcg",
    "µg",
    "μg",
    "ug"
   ],
   "[iu]": [
    "u",
    "iu",
    "[iu]",
    "units",
    "unit",
    "單位"
   ],
   "{tab}": [
    "tab",
    "tabs",
    "tablet",
    "tablets",
    "#",
    "錠",
    "顆",
    "粒",
    "{tab}",
    "cap",
    "caps",
    "capsule",
    "{cap}",
    "包",
    "{pack}",
    "amp",
    "{amp}",
    "支",
    "{tbl}",
    "{tablet}",
    "{tablets}",
    "{capsule}",
    "{capsules}"
   ],
   "{puff}": [
    "puff",
    "puffs",
    "噴",
    "{puff}"
   ],
   "{bottle}": [
    "瓶",
    "bottle",
    "bottles",
    "btl",
    "{bottle}"
   ],
   "{tube}": [
    "條",
    "tube",
    "{tube}"
   ],
   "ml": [
    "ml",
    "cc",
    "毫升"
   ],
   "mg/ml": [
    "mg/ml"
   ],
   "mg/g": [
    "mg/g",
    "mg/gcre",
    "mg/g cre"
   ],
   "mmol/mol": [
    "mmol/mol"
   ],
   "g/l": [
    "g/l"
   ],
   "cfu/ml": [
    "cfu/ml"
   ],
   "d": [
    "d",
    "day",
    "days",
    "天",
    "日"
   ],
   "wk": [
    "wk",
    "wks",
    "week",
    "weeks",
    "週",
    "周"
   ],
   "h": [
    "h",
    "hr",
    "hrs",
    "hour",
    "hours",
    "小時"
   ],
   "mo": [
    "mo",
    "month",
    "months",
    "個月"
   ],
   "a": [
    "a",
    "y",
    "yr",
    "year",
    "years",
    "歲"
   ],
   "s": [
    "s",
    "sec"
   ]
  },
  "doseUnitClass": {
   "{tab}": "unitdose",
   "{cap}": "unitdose",
   "{pack}": "unitdose",
   "{amp}": "unitdose"
  },
  "convert": [
   [
    "m",
    "cm",
    100
   ],
   [
    "cm",
    "m",
    0.01
   ],
   [
    "mm",
    "cm",
    0.1
   ],
   [
    "cm",
    "mm",
    10
   ],
   [
    "kg",
    "g",
    1000
   ],
   [
    "g",
    "kg",
    0.001
   ],
   [
    "g",
    "mg",
    1000
   ],
   [
    "mg",
    "g",
    0.001
   ],
   [
    "mg",
    "ug",
    1000
   ],
   [
    "ug",
    "mg",
    0.001
   ]
  ]
 },
 "medication": {
  "freqCodes": {
   "qd": [
    1,
    null
   ],
   "qday": [
    1,
    null
   ],
   "daily": [
    1,
    null
   ],
   "qam": [
    1,
    "MORN"
   ],
   "qpm": [
    1,
    "EVE"
   ],
   "qn": [
    1,
    "HS"
   ],
   "bid": [
    2,
    null
   ],
   "tid": [
    3,
    null
   ],
   "qid": [
    4,
    null
   ],
   "hs": [
    1,
    "HS"
   ],
   "bed": [
    1,
    "HS"
   ],
   "qod": [
    0.5,
    null
   ],
   "q2h": [
    12,
    null
   ],
   "q3h": [
    8,
    null
   ],
   "q4h": [
    6,
    null
   ],
   "q6h": [
    4,
    null
   ],
   "q8h": [
    3,
    null
   ],
   "q12h": [
    2,
    null
   ],
   "q24h": [
    1,
    null
   ],
   "qw": [
    0.14285714285714285,
    null
   ],
   "biw": [
    0.2857142857142857,
    null
   ],
   "tiw": [
    0.42857142857142855,
    null
   ],
   "stat": [
    "once",
    null
   ],
   "st": [
    "once",
    null
   ],
   "qdac": [
    1,
    "AC"
   ],
   "qdpc": [
    1,
    "PC"
   ],
   "bidac": [
    2,
    "AC"
   ],
   "tidac": [
    3,
    "AC"
   ],
   "tidpc": [
    3,
    "PC"
   ],
   "qidac": [
    4,
    "AC"
   ]
  },
  "freqCodePattern": "(?<![a-z0-9])(q\\d{1,2}h|qd|qday|qam|qpm|qn|bid|tid|qid|hs|qod|qw|biw|tiw|stat|daily)(?![a-z0-9])",
  "freqZh": [
   [
    "每(?:日|天)\\s*(?:一|1)\\s*次|一(?:天|日)\\s*(?:一|1)\\s*次|每(?:日|天)早上|每早|每日早晨|一天一顆|每天一顆",
    1
   ],
   [
    "每(?:日|天)\\s*(?:兩|二|2)\\s*次|一(?:天|日)\\s*(?:兩|二|2)\\s*次|早晚各一次",
    2
   ],
   [
    "每(?:日|天)\\s*(?:三|3)\\s*次|一(?:天|日)\\s*(?:三|3)\\s*次|三餐",
    3
   ],
   [
    "每(?:日|天)\\s*(?:四|4)\\s*次|一(?:天|日)\\s*(?:四|4)\\s*次",
    4
   ],
   [
    "每(?:週|周)\\s*(?:一|1)\\s*次|一(?:週|周)\\s*(?:一|1)\\s*次|\\bweekly\\b|once\\s+a\\s+week",
    0.1429
   ],
   [
    "每(?:週|周)\\s*(?:兩|二|2)\\s*次",
    0.2857
   ],
   [
    "\\bonce\\s+(?:a\\s+)?daily\\b|\\bonce\\s+a\\s+day\\b|\\bdaily\\b",
    1
   ],
   [
    "\\btwice\\s+(?:a\\s+)?(?:daily|day)\\b",
    2
   ],
   [
    "\\bthree\\s+times\\s+(?:a\\s+)?(?:daily|day)\\b",
    3
   ],
   [
    "\\bfour\\s+times\\s+(?:a\\s+)?(?:daily|day)\\b",
    4
   ]
  ],
  "everyNHours": "每\\s*(\\d+)\\s*小時|every\\s+(\\d+)\\s*h(?:ours?)?|\\bq\\s*(\\d+)\\s*h\\b",
  "prn": "\\bprn\\b|需要時|必要時|疼痛時|發燒時|as needed|p\\.r\\.n|咳嗽時|不適時",
  "hs": "\\bhs\\b|睡前|bedtime|\\bqn\\b",
  "routes": {
   "oral": [
    "po",
    "p.o.",
    "口服",
    "oral",
    "by mouth",
    "26643006"
   ],
   "sc": [
    "sc",
    "sq",
    "皮下",
    "subcutaneous",
    "34206005",
    "s.c."
   ],
   "iv": [
    "iv",
    "靜脈",
    "靜注",
    "intravenous",
    "47625008",
    "iv drip",
    "ivd",
    "ivf"
   ],
   "im": [
    "im",
    "肌肉注射",
    "肌注",
    "intramuscular",
    "78421000",
    "肌肉"
   ],
   "sl": [
    "sl",
    "舌下",
    "sublingual",
    "37839007"
   ],
   "inh": [
    "inhl",
    "吸入",
    "inhal",
    "inhalation",
    "mdi",
    "inh",
    "447694001",
    "18679011000001101",
    "respiratory tract"
   ],
   "top": [
    "top",
    "外用",
    "塗抹",
    "topical",
    "6064005"
   ],
   "rectal": [
    "pr",
    "肛門",
    "塞劑",
    "rectal",
    "37161004"
   ]
  },
  "unitDoseForm": "\\d\\s*(#|tab|cap|錠|顆|粒|包)|一顆|一錠|一粒"
 },
 "encounter": {
  "encClass": {
   "amb": [
    "門診",
    "outpatient",
    "OPD",
    "clinic",
    "診所",
    "健檢",
    "檢查單",
    "預防保健",
    "健兒",
    "visit",
    "out-patient"
   ],
   "emer": [
    "急診",
    "emergency",
    "ED",
    "ER",
    "A&E",
    "檢傷",
    "triage"
   ],
   "imp": [
    "住院",
    "入院",
    "出院",
    "admission",
    "discharge",
    "病房",
    "ward",
    "admitted",
    "inpatient",
    "in-patient",
    "加護病房",
    "ICU",
    "intensive care"
   ],
   "hh": [
    "居家",
    "home care",
    "home health",
    "訪視"
   ]
  },
  "departments": {
   "family": [
    "家醫",
    "家庭醫學",
    "家醫科",
    "family medicine",
    "family practice",
    "general practice"
   ],
   "internal medicine": [
    "內科",
    "一般內科",
    "internal medicine"
   ],
   "general medicine": [
    "內科",
    "一般內科",
    "general medicine",
    "internal medicine"
   ],
   "cardio": [
    "心臟",
    "心血管",
    "心臟內科",
    "心臟血管內科",
    "cardiology",
    "cardiovascular medicine"
   ],
   "neurology": [
    "神經內科",
    "神經科",
    "neurology"
   ],
   "emergency": [
    "急診",
    "急診醫學",
    "急診醫學科",
    "emergency medicine",
    "emergency department",
    "emergency room",
    "emergency",
    "ED",
    "ER",
    "A&E"
   ],
   "endocrin": [
    "內分泌",
    "新陳代謝",
    "內分泌新陳代謝科",
    "endocrinology",
    "metabolism"
   ],
   "gastro": [
    "腸胃",
    "胃腸",
    "肝膽",
    "消化內科",
    "胃腸肝膽科",
    "gastroenterology",
    "GI"
   ],
   "hepatology": [
    "肝膽",
    "hepatology"
   ],
   "pediatric": [
    "兒科",
    "小兒",
    "兒童",
    "小兒科",
    "pediatrics",
    "paediatrics",
    "pediatric",
    "peds"
   ],
   "obstetric": [
    "婦產",
    "產科",
    "婦產科",
    "obstetrics",
    "OB",
    "OBGYN",
    "OB/GYN"
   ],
   "gyn": [
    "婦產",
    "婦科",
    "婦產科",
    "gynecology",
    "gynaecology",
    "GYN",
    "OBGYN",
    "OB/GYN"
   ],
   "general surgery": [
    "一般外科",
    "外科",
    "general surgery"
   ],
   "surgery": [
    "外科",
    "surgery"
   ],
   "orthop": [
    "骨科",
    "orthopedics",
    "orthopaedics",
    "orthopedic",
    "ortho"
   ],
   "urolog": [
    "泌尿",
    "泌尿科",
    "urology"
   ],
   "dermatolog": [
    "皮膚",
    "皮膚科",
    "dermatology",
    "derm"
   ],
   "ophthalm": [
    "眼科",
    "ophthalmology"
   ],
   "otolaryng": [
    "耳鼻喉",
    "耳鼻喉科",
    "otolaryngology",
    "otorhinolaryngology",
    "ENT"
   ],
   "psychiat": [
    "精神",
    "身心",
    "精神科",
    "身心科",
    "psychiatry"
   ],
   "nephrolog": [
    "腎臟",
    "腎臟內科",
    "nephrology"
   ],
   "pulmon": [
    "胸腔暨重症加護",
    "胸腔",
    "胸腔內科",
    "pulmonology",
    "pulmonary medicine",
    "chest medicine"
   ],
   "respiratory": [
    "胸腔",
    "胸腔內科",
    "respiratory medicine"
   ],
   "infectious": [
    "感染",
    "感染科",
    "infectious disease",
    "infectious diseases"
   ],
   "rheumatolog": [
    "風濕",
    "免疫",
    "風濕免疫科",
    "rheumatology"
   ],
   "colorectal": [
    "大腸直腸",
    "直腸外科",
    "大腸直腸外科",
    "colorectal surgery"
   ],
   "rehabilitation": [
    "復健",
    "復健科",
    "rehabilitation",
    "physical medicine",
    "PM&R"
   ],
   "geriatric": [
    "老年",
    "老年醫學",
    "geriatrics",
    "geriatric medicine"
   ],
   "neurosurg": [
    "神經外科",
    "neurosurgery"
   ],
   "oncolog": [
    "腫瘤",
    "血液腫瘤",
    "oncology"
   ],
   "hematolog": [
    "血液",
    "血液腫瘤",
    "hematology",
    "haematology"
   ],
   "home": [
    "居家",
    "居家照護",
    "home care"
   ],
   "chest": [
    "胸腔",
    "chest medicine"
   ],
   "plastic": [
    "整形",
    "整形外科",
    "plastic surgery"
   ],
   "intensive care": [
    "胸腔暨重症加護",
    "加護",
    "重症",
    "加護病房",
    "重症加護",
    "intensive care",
    "critical care",
    "ICU",
    "MICU",
    "SICU",
    "CCU"
   ],
   "critical care": [
    "加護",
    "重症",
    "加護病房",
    "重症加護",
    "intensive care",
    "critical care",
    "ICU",
    "MICU",
    "SICU",
    "CCU"
   ],
   "anesthes": [
    "麻醉",
    "麻醉科",
    "anesthesiology",
    "anaesthesiology",
    "anesthesia"
   ],
   "dent": [
    "牙科",
    "牙醫",
    "dentistry",
    "dental"
   ],
   "chinese medicine": [
    "中醫",
    "中醫科",
    "traditional chinese medicine",
    "chinese medicine",
    "TCM"
   ],
   "radiolog": [
    "放射",
    "放射線科",
    "放射科",
    "影像醫學",
    "radiology"
   ],
   "nuclear medicine": [
    "核醫",
    "核子醫學",
    "nuclear medicine"
   ],
   "patholog": [
    "病理",
    "病理科",
    "pathology"
   ],
   "cardiothoracic": [
    "心臟血管外科",
    "心臟外科",
    "胸腔外科",
    "心臟胸腔外科",
    "cardiothoracic surgery",
    "cardiovascular surgery",
    "thoracic surgery"
   ],
   "occupational": [
    "職業醫學",
    "職業醫學科",
    "occupational medicine"
   ]
  },
  "departmentSuffix": "(照護|醫學科|醫學|科|部|中心)$",
  "disposition": {
   "home": [
    "返家",
    "回家",
    "home",
    "離院"
   ],
   "snf": [
    "護理之家",
    "安養",
    "nursing",
    "長照",
    "snf"
   ],
   "emd": [
    "急診",
    "er",
    "ed",
    "emergency"
   ],
   "hosp": [
    "轉院",
    "transfer"
   ],
   "exp": [
    "死亡",
    "expired"
   ],
   "aadvice": [
    "自動出院",
    "against"
   ]
  },
  "visitWords": [
   "就診",
   "看診",
   "到院",
   "入院",
   "出院",
   "離院",
   "admission",
   "admitted",
   "arrival",
   "discharge",
   "date",
   "日期",
   "visit",
   "受檢",
   "訪視",
   "住院期間",
   "門診",
   "急診",
   "檢查日期",
   "time",
   "時間"
  ],
  "birthLabels": [
   "出生",
   "生日",
   "dob",
   "birth",
   "生 "
  ],
  "visitLineWords": [
   "就診",
   "到院",
   "visit",
   "date",
   "日期：",
   "入院"
  ],
  "identityLine": "性別|sex|姓名|name|病人|病患|個案|受檢者|孕婦|兒童|病童|pt\\b|patient|歲|y/o|\\d+\\s*y\\b|\\d+y\\b|dob|出生|生日"
 },
 "terminology": {
  "stop": [
   "a",
   "an",
   "and",
   "at",
   "blood",
   "by",
   "containing",
   "disorder",
   "due",
   "finding",
   "for",
   "in",
   "level",
   "mass",
   "moles",
   "nec",
   "nos",
   "of",
   "on",
   "only",
   "or",
   "other",
   "plasma",
   "presence",
   "procedure",
   "product",
   "qualifier",
   "route",
   "sct",
   "serum",
   "specified",
   "structure",
   "substance",
   "test",
   "the",
   "to",
   "unspecified",
   "value",
   "volume",
   "with",
   "without"
  ],
  "zhEn": {
   "蕁麻疹": "urticaria",
   "紅疹": "rash eruption",
   "起疹": "rash eruption",
   "皮疹": "rash eruption",
   "疹子": "rash eruption",
   "眼皮腫": "angioedema swelling eyelid",
   "嘴唇腫": "angioedema swelling lip",
   "腫": "swelling",
   "呼吸困難": "dyspnea",
   "喘": "dyspnea wheezing",
   "噁心": "nausea",
   "嘔吐": "vomiting",
   "過敏性休克": "anaphylaxis",
   "休克": "shock",
   "血栓溶解": "thrombolytic thrombolysis",
   "胃竇": "antrum stomach",
   "胃": "stomach",
   "磺胺": "sulfonamide",
   "b型肝炎疫苗": "hepatitis b vaccine hep",
   "肝炎": "hepatitis",
   "兒科": "pediatric",
   "懷孕": "pregnancy pregnant",
   "頭皮": "scalp",
   "薦骨": "sacral sacrum",
   "乙狀結腸": "sigmoid colon",
   "髖": "hip",
   "手掌": "palm hand",
   "魚際": "thenar",
   "盤尼西林": "penicillin",
   "阿斯匹靈": "aspirin",
   "嗎啡": "morphine",
   "海鮮": "shellfish seafood",
   "蝦": "shellfish shrimp",
   "蟹": "shellfish crab",
   "顯影劑": "contrast media iodinated",
   "透析": "hemodialysis dialysis",
   "插管": "intubation endotracheal",
   "內視鏡": "endoscopy",
   "闌尾切除": "appendectomy",
   "膽囊切除": "cholecystectomy",
   "清創": "debridement",
   "縫合": "suture repair",
   "陽性": "positive",
   "陰性": "negative",
   "頭部": "head",
   "股骨": "femur femoral",
   "腕": "wrist",
   "踝": "ankle",
   "膝": "knee",
   "肺炎": "pneumonia",
   "流感": "influenza",
   "疫苗": "vaccine",
   "心導管": "catheterization cardiac",
   "支架": "stent",
   "氣管": "trachea endotracheal",
   "肌瘤": "leiomyoma myoma",
   "子宮": "uterus uterine",
   "大腸鏡": "colonoscopy",
   "胃鏡": "gastroscopy esophagogastroduodenoscopy",
   "止血": "hemostasis",
   "抗生素": "antibiotic",
   "頭孢": "cephalosporin",
   "大腸桿菌": "escherichia coli",
   "腹腔鏡": "laparoscopic",
   "左": "left",
   "右": "right",
   "葡萄糖": "glucose",
   "血糖": "glucose",
   "餐後": "postprandial",
   "飯後": "postprandial",
   "空腹": "fasting",
   "飯前": "fasting",
   "肌酸酐": "creatinine",
   "尿素氮": "urea nitrogen",
   "尿酸": "urate uric acid",
   "全套血液檢查": "complete blood count cbc"
  },
  "bridgeNeutral": [
   "血液",
   "體液",
   "血清",
   "血漿",
   "血中",
   "及",
   "或"
  ],
  "abbrev": {
   "dm": "diabetes mellitus",
   "t2dm": "type 2 diabetes mellitus",
   "t1dm": "type 1 diabetes mellitus",
   "htn": "hypertension",
   "cap": "community acquired pneumonia",
   "copd": "chronic obstructive pulmonary disease",
   "aki": "acute kidney failure injury",
   "ckd": "chronic kidney disease",
   "nstemi": "non st elevation myocardial infarction",
   "stemi": "st elevation myocardial infarction",
   "af": "atrial fibrillation",
   "afib": "atrial fibrillation",
   "hf": "heart failure",
   "chf": "congestive heart failure",
   "uti": "urinary tract infection",
   "uri": "upper respiratory infection",
   "gerd": "gastro esophageal reflux disease",
   "dka": "diabetic ketoacidosis",
   "oa": "osteoarthritis",
   "gdm": "gestational diabetes mellitus",
   "ida": "iron deficiency anemia",
   "lbp": "low back pain",
   "fx": "fracture",
   "mi": "myocardial infarction",
   "cva": "cerebrovascular accident stroke",
   "tia": "transient ischemic attack",
   "hbv": "hepatitis b",
   "hcv": "hepatitis c",
   "bph": "benign prostatic hyperplasia",
   "got": "ast aspartate aminotransferase",
   "gpt": "alt alanine aminotransferase",
   "ast": "aspartate aminotransferase",
   "alt": "alanine aminotransferase",
   "t-cho": "cholesterol",
   "tcho": "cholesterol",
   "tg": "triglyceride",
   "ua": "urate uric acid",
   "cr": "creatinine",
   "bun": "urea nitrogen",
   "hb": "hemoglobin",
   "hgb": "hemoglobin",
   "wbc": "leukocytes",
   "plt": "platelets",
   "hba1c": "hemoglobin a1c",
   "a1c": "hemoglobin a1c",
   "ft4": "thyroxine free",
   "t4": "thyroxine",
   "tsh": "thyrotropin",
   "k": "potassium",
   "na": "sodium",
   "hco3": "bicarbonate",
   "crp": "c reactive protein",
   "ldl-c": "cholesterol in ldl",
   "ldl": "cholesterol in ldl",
   "hdl-c": "cholesterol in hdl",
   "hdl": "cholesterol in hdl",
   "afp": "alpha 1 fetoprotein",
   "tni": "troponin i",
   "hs-tni": "troponin i cardiac high sensitivity",
   "egfr": "glomerular filtration rate",
   "spo2": "oxygen saturation",
   "bt": "body temperature",
   "pr": "heart rate pulse",
   "rr": "respiratory rate",
   "bp": "blood pressure",
   "bw": "body weight",
   "bh": "body height",
   "bmi": "body mass index",
   "ac": "fasting glucose",
   "glu": "glucose",
   "egd": "esophagogastroduodenoscopy",
   "ett": "endotracheal intubation",
   "hd": "hemodialysis",
   "lap": "laparoscopic",
   "ogtt": "glucose tolerance",
   "esr": "erythrocyte sedimentation rate",
   "uacr": "albumin creatinine urine ratio",
   "acr": "albumin creatinine ratio",
   "inr": "inr coagulation",
   "pci": "percutaneous coronary intervention",
   "des": "drug eluting stent",
   "cabg": "coronary artery bypass graft",
   "thr": "total hip replacement",
   "tkr": "total knee replacement",
   "orif": "open reduction internal fixation",
   "rt-pa": "thrombolytic therapy alteplase",
   "tpa": "thrombolytic therapy alteplase",
   "hr": "heart rate hour",
   "fev1": "forced expiratory volume",
   "rbc": "erythrocytes",
   "ige": "immunoglobulin e",
   "pc": "postprandial",
   "cbc": "complete blood count",
   "psa": "prostate specific antigen"
  },
  "latToken": "[a-z0-9][a-z0-9\\-]*",
  "genericTokens": [
  "acnc", "auto", "automated", "bld", "ccnc", "mcnc", "ncnc", "ord", "plas", "pnl", "pt", "ql", "qn", "scnc", "ser", "serpl", "vfr",
   "1",
   "2",
   "3",
   "4",
   "5",
   "acute",
   "and",
   "bilateral",
   "body",
   "chronic",
   "condition",
   "count",
   "disease",
   "disorder",
   "dose",
   "due",
   "encounter",
   "free",
   "general",
   "history",
   "hour",
   "infection",
   "initial",
   "left",
   "level",
   "lower",
   "mild",
   "moderate",
   "multiple",
   "other",
   "pain",
   "part",
   "post",
   "pressure",
   "primary",
   "rate",
   "ratio",
   "region",
   "right",
   "secondary",
   "severe",
   "single",
   "site",
   "stage",
   "status",
   "subsequent",
   "syndrome",
   "total",
   "type",
   "unspecified",
   "upper",
   "urine"
  ],
  "genericBigrams": [
   "之其",
   "伴有",
   "併有",
   "其他",
   "原發",
   "右側",
   "左側",
   "急性",
   "慢性",
   "明示",
   "未伴",
   "未明",
   "疾病",
   "第一",
   "第三",
   "第二",
   "續發",
   "部位",
   "雙側"
  ]
 },
 "pas": {
  "supportingInfoLabels": {
   "weight": ["bw", "體重", "weight", "wt", "body weight", "kg"],
   "height": ["bh", "身高", "身長", "height", "ht", "cm"],
   "bsa": ["bsa", "體表面積", "body surface"],
   "bmi": ["bmi", "身體質量指數"]
  },
  "nonRecordResources": ["ClaimResponse", "OperationOutcome"]
 },
 "observation": {
  "vitalLabels": {
   "8310-5": [
    "bt",
    "t",
    "體溫",
    "temp",
    "temperature",
    "耳溫",
    "額溫",
    "肛溫",
    "腋溫",
    "發燒"
   ],
   "8867-4": [
    "hr",
    "pr",
    "p",
    "心跳",
    "脈搏",
    "pulse",
    "heart rate",
    "心率"
   ],
   "9279-1": [
    "rr",
    "r",
    "呼吸",
    "respiratory",
    "resp"
   ],
   "85354-9": [
    "bp",
    "血壓",
    "blood pressure"
   ],
   "8480-6": [
    "bp",
    "血壓",
    "sbp",
    "收縮",
    "systolic"
   ],
   "8462-4": [
    "bp",
    "血壓",
    "dbp",
    "舒張",
    "diastolic"
   ],
   "29463-7": [
    "bw",
    "體重",
    "weight",
    "wt",
    "body weight"
   ],
   "8302-2": [
    "bh",
    "身高",
    "身長",
    "height",
    "ht",
    "length"
   ],
   "39156-5": [
    "bmi"
   ],
   "59408-5": [
    "spo2",
    "血氧",
    "sat",
    "o2",
    "saturation"
   ],
   "2708-6": [
    "spo2",
    "血氧",
    "sat",
    "saturation"
   ],
   "9843-4": [
    "頭圍",
    "head",
    "hc",
    "circumference"
   ],
   "8287-5": [
    "頭圍",
    "head",
    "hc",
    "circumference"
   ],
   "59576-9": [
    "bmi",
    "percentile",
    "百分位"
   ],
   "3150-0": [
    "fio2",
    "oxygen",
    "氧",
    "inhaled",
    "l/min",
    "%"
   ],
   "82810-3": [
    "懷孕",
    "pregnan",
    "ga",
    "孕"
   ]
  },
  "profileLabelCode": {
   "Observation-body-temperature-twcore": "8310-5",
   "Observation-heart-rate-twcore": "8867-4",
   "Observation-respiratory-rate-twcore": "9279-1",
   "Observation-bloodPressure-twcore": "85354-9",
   "Observation-body-weight-twcore": "29463-7",
   "Observation-body-height-twcore": "8302-2",
   "Observation-bmi-twcore": "39156-5",
   "Observation-pulse-oximetry-twcore": "59408-5",
   "Observation-head-circumference-twcore": "9843-4",
   "Observation-pediatric-bmi-age-twcore": "59576-9",
   "Observation-pregnancy-status-twcore": "82810-3"
  },
  "fixedCodeProfiles": [
   "Observation-body-temperature-twcore",
   "Observation-heart-rate-twcore",
   "Observation-bloodPressure-twcore",
   "Observation-body-weight-twcore",
   "Observation-body-height-twcore",
   "Observation-respiratory-rate-twcore",
   "Observation-bmi-twcore",
   "Observation-head-circumference-twcore",
   "Observation-pulse-oximetry-twcore",
   "Observation-pediatric-bmi-age-twcore",
   "Observation-pregnancy-status-twcore",
   "Observation-pediatric-head-circumference-twcore",
   "Observation-pediatric-weight-height-twcore",
   "Observation-averageBloodPressure-twcore"
  ]
 },
 "status": {
  "workflowDefaults": {
   "Patient.active": [
    true
   ],
   "Practitioner.active": [
    true
   ],
   "Organization.active": [
    true
   ],
   "Encounter.status": [
    "finished"
   ],
   "Condition.clinicalStatus": [
    "active"
   ],
   "Condition.verificationStatus": [
    "confirmed"
   ],
   "Observation.status": [
    "final"
   ],
   "MedicationRequest.status": [
    "active"
   ],
   "MedicationRequest.intent": [
    "order"
   ],
   "MedicationStatement.status": [
    "active"
   ],
   "Procedure.status": [
    "completed"
   ],
   "Immunization.status": [
    "completed"
   ],
   "Immunization.primarySource": [
    true
   ],
   "MedicationRequest.dispenseRequest.numberOfRepeatsAllowed": [
    0
   ],
   "AllergyIntolerance.clinicalStatus": [
    "active"
   ],
   "AllergyIntolerance.verificationStatus": [
    "confirmed"
   ]
  },
  "statusEvidence": {
   "resolved": [
    "痊癒",
    "已改善",
    "resolved",
    "治癒",
    "已癒",
    "緩解",
    "s/p",
    "已完成",
    "達成",
    "svr"
   ],
   "inactive": [
    "inactive",
    "不活動",
    "已停止"
   ],
   "in-progress": [
    "住院中",
    "仍住院",
    "觀察中",
    "in-progress",
    "收住院",
    "住院",
    "admitted",
    "入院"
   ],
   "stopped": [
    "停用",
    "已停",
    "stopped",
    "d/c",
    "停藥",
    "discontinue"
   ],
   "completed": [
    "完成",
    "completed"
   ],
   "provisional": [
    "疑似",
    "provisional",
    "可能"
   ],
   "differential": [
    "r/o",
    "rule out",
    "鑑別"
   ],
   "refuted": [
    "排除",
    "refuted",
    "ruled out"
   ],
   "unconfirmed": [
    "疑似",
    "unconfirmed",
    "待確認"
   ],
   "entered-in-error": [
    "entered in error"
   ],
   "remission": [
    "remission",
    "緩解"
   ],
   "recurrence": [
    "復發",
    "recurrence"
   ],
   "relapse": [
    "relapse",
    "復發"
   ],
   "on-hold": [
    "暫停",
    "hold"
   ],
   "draft": [
    "draft"
   ],
   "intended": [
    "預計",
    "將",
    "intended"
   ],
   "not-taken": [
    "未服",
    "not taken"
   ],
   "plan": [
    "計畫",
    "plan"
   ],
   "proposal": [
    "建議",
    "proposal"
   ]
  }
 },
 "structure": {
  "listItem": "^\\s*([\\-\\*#・•●]|\\(?\\d+[\\.\\)、]|\\(\\d+\\))"
 }
};
