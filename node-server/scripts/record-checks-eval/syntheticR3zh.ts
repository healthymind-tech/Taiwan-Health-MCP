/**
 * Synthetic R3 set for the Chinese names of SNOMED codes (ISSUES_v15.3 R3 follow-up, grounding/snomedChinese.ts): a
 * SNOMED-coded primary Condition whose terminology names are English only (as snomed.descriptions holds them) against
 * a Chinese diagnosis slot. The Chinese names come from fake tables run through the real provider — a SNOMED → ICD-10
 * map, ICD-10-CM Chinese names, mined bilingual word pairs and one IG ValueSet display — answered by an in-memory
 * `query`. All names, codes' Chinese renderings and records are invented for the test; nothing comes from any dataset.
 *
 *   expect "error"    the slot clearly names another diagnosis and nothing related is in the record;
 *   expect "warning"  the code is right / near (pneumonia vs viral pneumonia, same ICD category, English record):
 *                     no error.
 */
import { createSnomedChineseNames, type QueryFn, type ZhName } from "../../src/grounding/snomedChinese.js";
import { IN_RECORD, inBundle } from "./synthetic151.js";

type Json = Record<string, any>;
const SCT = "http://snomed.info/sct";
const ICD = "http://hl7.org/fhir/sid/icd-10-cm";

/** Fake snomed.icd10_map rows: [concept, target, rule, priority, group]. */
export const FAKE_MAP: Array<[string, string, string, number, number]> = [
  ["195967001", "J45.9", "TRUE", 1, 1],
  ["68566005", "N39.0", "TRUE", 1, 1],
  ["233604007", "J18.9", "TRUE", 1, 1],
  ["75570004", "J12.9", "TRUE", 1, 1],
  ["385093006", "J18.9", "TRUE", 1, 1],
  ["396285007", "J18.0", "TRUE", 1, 1],
  ["38341003", "I10", "TRUE", 1, 1],
  ["44054006", "E11.9", "TRUE", 1, 1],
  ["22298006", "I21.9", "TRUE", 1, 1],
  ["422504002", "I63.9", "TRUE", 1, 1],
  ["230690007", "I64", "TRUE", 1, 1], // WHO-only code: no ICD-10-CM Chinese name
  ["13645005", "J44.9", "TRUE", 1, 1],
  ["235595009", "K21.9", "TRUE", 1, 1],
  ["36971009", "J32.9", "TRUE", 1, 1],
  ["271737000", "D50.9", "IFA 1234567 | Iron deficiency (finding) |", 1, 1],
  ["271737000", "D64.9", "OTHERWISE TRUE", 2, 1],
];

/** Fake icd.diagnoses Chinese names (invented renderings in the ICD-10-CM Chinese style). */
export const FAKE_ICD_ZH: Record<string, string> = {
  "J45.909": "未明示氣喘，無併發症",
  "J45.901": "未明示氣喘，伴有急性發作",
  "J18.9": "肺炎，未明示病原體",
  "J18.0": "支氣管肺炎，未明示病原體",
  "J12.9": "病毒性肺炎，未明示",
  "N39.0": "泌尿道感染，部位未明示",
  "N39.3": "應力性尿失禁",
  I10: "本態性（原發性）高血壓",
  "E11.9": "第二型糖尿病，無併發症",
  "I21.9": "急性心肌梗塞，未明示",
  "I63.9": "腦梗塞，未明示",
  "J44.9": "慢性阻塞性肺病，未明示",
  "J44.1": "慢性阻塞性肺病伴有急性惡化",
  "K21.9": "胃食道逆流疾病，未伴有食道炎",
  "J32.9": "慢性鼻竇炎，未明示",
  "D64.9": "貧血，未明示",
  "D50.9": "缺鐵性貧血，未明示",
};

/** Fake mined bilingual pairs (fhir.term_thesaurus source 'bilingual': stem → Chinese word, freq = Dice × 1000). */
export const FAKE_BILINGUAL: Array<[string, string, number]> = [
  ["asthma", "氣喘", 900],
  ["pneumonia", "肺炎", 950],
  ["viral", "病毒性", 800],
  ["urinary", "泌尿", 820],
  ["tract", "道", 600],
  ["infectious", "感染", 760],
  ["infection", "感染", 850],
  ["stroke", "中風", 850],
  ["cerebrovascular", "腦血管", 800],
  ["accident", "意外", 600],
  ["ischemic", "缺血性", 800],
  ["gastroesophageal", "胃食道", 800],
  ["reflux", "逆流", 820],
];

/** Fake IG ValueSet concept with a Chinese display. */
export const FAKE_IG_DISPLAY: Array<[string, string]> = [["38341003", "高血壓"]];

/** English names the SNOMED descriptions would give. */
export const FAKE_EN: Record<string, string[]> = {
  "195967001": ["Asthma", "Asthma (disorder)", "Bronchial asthma"],
  "68566005": ["Urinary tract infectious disease", "Urinary tract infectious disease (disorder)", "Urinary tract infection", "UTI - Urinary tract infection"],
  "233604007": ["Pneumonia", "Pneumonia (disorder)"],
  "75570004": ["Viral pneumonia", "Viral pneumonia (disorder)"],
  "385093006": ["Community acquired pneumonia", "Infective pneumonia acquired prior to hospitalization (disorder)"],
  "396285007": ["Bronchopneumonia", "Bronchopneumonia (disorder)"],
  "38341003": ["Hypertensive disorder", "Hypertensive disorder, systemic arterial (disorder)", "High blood pressure", "Hypertension"],
  "44054006": ["Type 2 diabetes mellitus", "Diabetes mellitus type 2 (disorder)"],
  "22298006": ["Myocardial infarction", "Myocardial infarction (disorder)", "Heart attack"],
  "422504002": ["Ischemic stroke", "Ischemic stroke (disorder)", "Cerebral infarction"],
  "230690007": ["Cerebrovascular accident", "Cerebrovascular accident (disorder)", "Stroke", "CVA"],
  "13645005": ["Chronic obstructive lung disease", "Chronic obstructive lung disease (disorder)", "COPD"],
  "235595009": ["Gastroesophageal reflux disease", "Gastroesophageal reflux disease (disorder)", "GERD"],
  "36971009": ["Sinusitis", "Sinusitis (disorder)"],
  "271737000": ["Anemia", "Anemia (disorder)"],
};

/** In-memory `query` answering the SQL of grounding/snomedChinese.ts from the fake tables. */
export function fakeChineseQuery(log: string[] = []): QueryFn {
  return async (sql, params) => {
    log.push(sql);
    if (sql.includes("FROM fhir.artifacts a CROSS JOIN LATERAL") && sql.includes("compose")) {
      return { rows: FAKE_IG_DISPLAY.map(([code, display]) => ({ code, display, lang: null, value: null })) };
    }
    if (sql.includes("fhir.artifacts") || sql.includes("fhir.codesystem_supplements")) return { rows: [] };
    if (sql.includes("FROM snomed.icd10_map")) {
      const ids = new Set((params[0] as string[]).map(String));
      return { rows: FAKE_MAP.filter(([c]) => ids.has(c)).map(([id, map_target, map_rule, map_priority, map_group]) => ({ id, map_target, map_rule, map_advice: "", map_priority, map_group, active: true })) };
    }
    if (sql.includes("FROM icd.diagnoses WHERE code = ANY")) {
      const want = new Set(params[0] as string[]);
      return { rows: Object.entries(FAKE_ICD_ZH).filter(([c]) => want.has(c)).map(([code, name_zh]) => ({ code, name_zh })) };
    }
    if (sql.includes("FROM icd.diagnoses WHERE category = ANY")) {
      const cats = new Set(params[0] as string[]);
      return { rows: Object.entries(FAKE_ICD_ZH).filter(([c]) => cats.has(c.slice(0, 3)) && c.length <= 7).map(([code, name_zh]) => ({ code, name_zh, category: code.slice(0, 3) })) };
    }
    if (sql.includes("FROM fhir.term_thesaurus")) {
      const stems = new Set(params[0] as string[]);
      return { rows: FAKE_BILINGUAL.filter(([a]) => stems.has(a)).map(([abbr, expansion, freq]) => ({ abbr, expansion, freq })) };
    }
    throw new Error(`fakeChineseQuery: unexpected SQL ${sql.slice(0, 80)}`);
  };
}

/** The provider over the fake tables. */
export function fakeChineseNames(log: string[] = []): ReturnType<typeof createSnomedChineseNames> {
  return createSnomedChineseNames({ query: fakeChineseQuery(log), englishNames: async (ids) => new Map(ids.map((id) => [id, FAKE_EN[id] ?? []])) });
}

export interface R3ZhCase {
  id: string;
  expect: "warning" | "error";
  bundle: Json;
  source_text: string;
  entry: number;
  element: string;
  /** Terminology names grounding compares (English only for SNOMED, as in snomed.descriptions). */
  terms: Map<string, { found: boolean; names: string[] }>;
  /** Chinese names by `system|code`, filled by `withChineseNames`. */
  zh?: Map<string, ZhName[]>;
}

const DX = "診斷：社區型肺炎 (J18.9)";
const rep = (base: string, from: string, to: string): string => {
  if (!base.includes(from)) throw new Error(`syntheticR3zh: '${from}' not in the record`);
  return base.split(from).join(to);
};

export function syntheticR3ZhCases(): R3ZhCase[] {
  const out: R3ZhCase[] = [];
  const HTN: [string, { found: boolean; names: string[] }] = [`${ICD}|I10`, { found: true, names: ["Essential (primary) hypertension", "高血壓"] }];
  const add = (id: string, expect: "warning" | "error", code: string, slot: string | null, record: string = IN_RECORD): void => {
    const b = structuredClone(inBundle());
    const en = FAKE_EN[code];
    b.entry[2].resource.code = { coding: [{ system: SCT, code, display: en[0] }] };
    const src = slot === null ? record : rep(record, DX, slot);
    out.push({ id, expect, bundle: b, source_text: src, entry: 2, element: "code", terms: new Map([[`${SCT}|${code}`, { found: true, names: en }], HTN]) });
  };
  // the slot names another diagnosis → error
  add("zh-asthma-vs-cap", "error", "195967001", null);
  add("zh-uti-vs-cap", "error", "68566005", null);
  add("zh-gerd-vs-cap", "error", "235595009", null);
  add("zh-t2dm-vs-cap", "error", "44054006", null);
  add("zh-mi-vs-uti", "error", "22298006", "診斷：泌尿道感染");
  add("zh-asthma-vs-appendicitis", "error", "195967001", "診斷：急性闌尾炎");
  add("zh-copd-vs-uti-coded", "error", "13645005", "診斷：泌尿道感染 (N39.0)");
  add("zh-uti-vs-t2dm", "error", "68566005", "主診斷：第二型糖尿病");
  add("en-asthma-vs-cap-en", "error", "195967001", "Dx: community-acquired pneumonia (J18.9)");
  // the code is right or near → no error
  add("ok-pneumonia-vs-viral-pneumonia", "warning", "233604007", "診斷：病毒性肺炎");
  add("ok-viral-pneumonia-vs-cap", "warning", "75570004", null);
  add("ok-cap-vs-cap", "warning", "385093006", null);
  add("ok-bronchopneumonia-vs-cap", "warning", "396285007", null);
  add("ok-asthma-exacerbation", "warning", "195967001", "診斷：氣喘急性發作");
  add("ok-htn-ig-display", "warning", "38341003", "診斷：高血壓");
  add("ok-t2dm-reordered", "warning", "44054006", "診斷：糖尿病第2型");
  add("ok-mi-acute", "warning", "22298006", "診斷：急性心肌梗塞");
  add("ok-ischemic-stroke-infarct", "warning", "422504002", "診斷：腦梗塞");
  add("ok-cva-no-cm-name", "warning", "230690007", "診斷：腦中風");
  add("ok-copd-exacerbation-mixed", "warning", "13645005", "診斷：COPD 急性惡化");
  add("ok-asthma-icd-only-slot", "warning", "195967001", "診斷：J45.909");
  add("ok-uti-english-record", "warning", "68566005", "Dx: urinary tract infection");
  add("ok-anemia-conditional-map", "warning", "271737000", "診斷：缺鐵性貧血");
  add("ok-sinusitis-chronic", "warning", "36971009", "診斷：慢性鼻竇炎");
  add("ok-gerd-zh", "warning", "235595009", "診斷：胃食道逆流");
  return out;
}

/** Fill each case's Chinese names through the provider (as recordCheckLookups does in the tools). */
export async function withChineseNames(cases: R3ZhCase[], provider = fakeChineseNames()): Promise<R3ZhCase[]> {
  for (const c of cases) {
    const ids = [...c.terms.keys()].filter((k) => k.startsWith(`${SCT}|`)).map((k) => k.slice(SCT.length + 1));
    const m = await provider.lookup(ids);
    c.zh = new Map([...m].map(([id, v]) => [`${SCT}|${id}`, v]));
  }
  return cases;
}
