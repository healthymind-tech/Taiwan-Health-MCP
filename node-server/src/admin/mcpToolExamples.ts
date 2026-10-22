/**
 * Curated, working example inputs for every MCP tool (admin console → MCP 工具 playground).
 *
 * Each tool has a zh-TW display title and one or more named presets. The first preset is
 * the default the playground pre-fills; it must succeed against a loaded installation
 * (TW Core 1.0.0 default IG, ICD-10-CM, LOINC 2.80, SNOMED CT International, TFDA drugs).
 * Optional arguments that a preset omits are pre-filled by the UI from the schema default.
 *
 * `mcpToolExamples.test.ts` fails when a catalog tool has no entry here, or when any
 * preset does not parse against its tool's zod input schema — so a renamed or re-shaped
 * argument cannot leave a stale example behind. Bump MCP_TOOL_EXAMPLES_VERSION whenever
 * the examples change in a way the UI's per-browser history should notice.
 *
 * All clinical records here are fictional (TW Core examples and hand-written playground records).
 */

import {
  COMPLETENESS_COMPLETE_INPUT,
  COMPLETENESS_INSUFFICIENT_INPUT,
  GROUNDING_FABRICATED_INPUT,
  GROUNDING_VALID_INPUT,
  GROUNDING_WRONG_DATE_INPUT,
  TWCORE_BUNDLE_EXAMPLE,
  TWCORE_CONDITION_EXAMPLE,
  TWCORE_PATIENT_EXAMPLE,
} from "./mcpToolExampleFixtures.js";

export const MCP_TOOL_EXAMPLES_VERSION = "3";

export interface ToolExample {
  /** Stable id within the tool (used by the UI and in tests). */
  id: string;
  /** Short zh-TW label, e.g. 「有效範例」. */
  label: string;
  description?: string;
  args: Record<string, unknown>;
}

export interface ToolExampleSet {
  /** zh-TW display title of the tool. */
  title: string;
  examples: ToolExample[];
}

const TWCORE = "tw.gov.mohw.twcore";
const TWCORE_VERSION = "1.0.0";
const TWCORE_SD = "https://twcore.mohw.gov.tw/ig/twcore/StructureDefinition";
const TWCORE_VS = "https://twcore.mohw.gov.tw/ig/twcore/ValueSet";
const NHI_PAYMENT_CS = "https://twcore.mohw.gov.tw/ig/twcore/CodeSystem/medical-service-payment-tw";
const PANADOL_LICENSE = "衛署藥製字第048683號";

const example = (id: string, label: string, args: Record<string, unknown>, description?: string): ToolExample =>
  description ? { id, label, description, args } : { id, label, args };

/** A small TW Core Condition used by the Condition validator presets. */
const CONDITION_JSON = {
  resourceType: "Condition",
  id: "dm2-demo",
  clinicalStatus: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-clinical", code: "active" }] },
  verificationStatus: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-ver-status", code: "confirmed" }] },
  code: { coding: [{ system: "http://hl7.org/fhir/sid/icd-10-cm", code: "E11.9", display: "Type 2 diabetes mellitus without complications" }], text: "第二型糖尿病" },
  subject: { reference: "Patient/pat-example" },
  onsetDateTime: "2024-03-15",
};

const MEDICATION_JSON = {
  resourceType: "Medication",
  id: "panadol-demo",
  code: {
    coding: [{ system: "https://data.fda.gov.tw/drug-license", code: PANADOL_LICENSE, display: "普拿疼伏冒日夜膜衣錠" }],
    text: "普拿疼伏冒日夜膜衣錠",
  },
  ingredient: [
    {
      itemCodeableConcept: { text: "ACETAMINOPHEN" },
      strength: { numerator: { value: 500, unit: "mg" }, denominator: { value: 1, unit: "tablet" } },
    },
  ],
};

/** Patient + Condition wired by logical key — fhir_build_bundle rewrites the keys to urn:uuid. */
const BUILD_BUNDLE_ENTRIES = [
  {
    key: "patient",
    resource: {
      resourceType: "Patient",
      meta: { profile: [`${TWCORE_SD}/Patient-twcore`] },
      identifier: [{ system: "http://www.moi.gov.tw", value: "A123456789" }],
      name: [{ text: "王大明" }],
      gender: "male",
      birthDate: "1968-05-20",
    },
  },
  {
    key: "dx",
    resource: {
      resourceType: "Condition",
      meta: { profile: [`${TWCORE_SD}/Condition-twcore`] },
      clinicalStatus: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-clinical", code: "active" }] },
      code: { coding: [{ system: "http://hl7.org/fhir/sid/icd-10-cm", code: "E11.9" }], text: "第二型糖尿病" },
      subject: { reference: "patient" },
    },
  },
];

/**
 * A Bundle written the way weaker models write it: readable labels as fullUrl / references, an urn as
 * Bundle.id. fhir_finalize_bundle turns the labels into deterministic urn:uuid fullUrls and rewires
 * every reference; the clinical content is untouched. Synthetic data.
 */
const LABELLED_BUNDLE = {
  resourceType: "Bundle",
  id: "urn:uuid:bundle-1",
  meta: { profile: [`${TWCORE_SD}/Bundle-twcore`] },
  type: "collection",
  entry: [
    {
      fullUrl: "urn:uuid:patient-1",
      resource: {
        resourceType: "Patient",
        id: "patient-1",
        meta: { profile: [`${TWCORE_SD}/Patient-twcore`] },
        identifier: [{ system: "http://www.moi.gov.tw", value: "A123456789" }],
        name: [{ text: "王大明" }],
        gender: "male",
        birthDate: "1968-05-20",
      },
    },
    {
      fullUrl: "urn:uuid:encounter-1",
      resource: {
        resourceType: "Encounter",
        id: "encounter-1",
        meta: { profile: [`${TWCORE_SD}/Encounter-twcore`] },
        status: "finished",
        class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "AMB" },
        subject: { reference: "Patient/patient-1" },
      },
    },
    {
      fullUrl: "urn:uuid:condition-1",
      resource: {
        resourceType: "Condition",
        meta: { profile: [`${TWCORE_SD}/Condition-twcore`] },
        clinicalStatus: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-clinical", code: "active" }] },
        category: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-category", code: "encounter-diagnosis" }] }],
        code: { coding: [{ system: "http://hl7.org/fhir/sid/icd-10-cm", code: "E11.9", display: "Type 2 diabetes mellitus without complications" }], text: "第二型糖尿病" },
        subject: { reference: "urn:uuid:patient-1" },
        encounter: { reference: "encounter-1" },
      },
    },
  ],
};

const PATIENT_DRAFT = {
  resourceType: "Patient",
  identifier: [{ system: "http://www.moi.gov.tw", value: "A123456789" }],
  name: [{ text: "王大明" }],
  gender: "male",
  birthDate: "1968-05-20",
};

/** Same Condition example with a broken status code and no subject — fails validation. */
const INVALID_CONDITION = (() => {
  const c = JSON.parse(JSON.stringify(TWCORE_CONDITION_EXAMPLE)) as Record<string, unknown>;
  delete c.subject;
  c.clinicalStatus = { coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-clinical", code: "not-a-status" }] };
  return c;
})();

export const MCP_TOOL_EXAMPLES: Record<string, ToolExampleSet> = {
  // ── ICD-10 ───────────────────────────────────────────────────────────────
  search_medical_codes: {
    title: "搜尋 ICD-10 診斷 / 處置碼",
    examples: [
      example("dx", "診斷：第二型糖尿病", { keyword: "第二型糖尿病", type: "diagnosis", limit: 3 }),
      example("pcs", "處置：Resection of Appendix", { keyword: "Resection of Appendix", type: "procedure", limit: 3 }),
      example("all", "診斷 + 處置：hypertension", { keyword: "hypertension", type: "all", limit: 3 }),
      example("nhi", "健保支付代碼（別名）：CRP", { keyword: "CRP", type: "all", limit: 5, system: "nhi_payment" }),
      example("nhi_zh", "健保支付代碼：清創縫合（淺部創傷，傷口 < 5 cm）", {
        keyword: "清創縫合 4-0 Nylon 5 針（淺部創傷處理，傷口 < 5 cm）",
        type: "all",
        limit: 5,
        system: NHI_PAYMENT_CS,
      }),
    ],
  },
  infer_complications: {
    title: "ICD-10 階層展開（併發症 / 子碼）",
    examples: [
      example("category", "類別 E11（第二型糖尿病）", { code: "E11" }),
      example("leaf", "葉節點 E11.9（列出同層）", { code: "E11.9" }),
    ],
  },
  get_nearby_codes: {
    title: "ICD-10 相鄰代碼",
    examples: [example("default", "E11.9 前後代碼", { code: "E11.9" })],
  },
  check_medical_conflict: {
    title: "診斷 / 處置並列比對",
    examples: [
      example("appendicitis", "急性闌尾炎 + 腹腔鏡闌尾切除", { diagnosis_code: "K35.80", procedure_code: "0DTJ4ZZ" }),
      example("mismatch", "第二型糖尿病 + 闌尾切除（不相關）", { diagnosis_code: "E11.9", procedure_code: "0DTJ4ZZ" }),
    ],
  },
  browse_icd_category: {
    title: "瀏覽 ICD-10-CM 分類",
    examples: [
      example("category", "展開 E11", { category: "E11", limit: 20 }),
      example("all", "列出所有類別", { category: null, limit: 20 }),
    ],
  },

  // ── Drug / TFDA ──────────────────────────────────────────────────────────
  search_drug: {
    title: "搜尋 TFDA 藥品",
    examples: [
      example("name", "品名：普拿疼", { mode: "drug_name", keyword: "普拿疼", limit: 3, include_cancelled: false }),
      example("ingredient", "成分：acetaminophen", { mode: "ingredient", keyword: "acetaminophen", limit: 3, include_cancelled: false }),
      example("atc", "ATC：N02BE01", { mode: "atc_code", keyword: "N02BE01", limit: 3, include_cancelled: false }),
    ],
  },
  identify_unknown_pill: {
    title: "外觀辨識藥品",
    examples: [
      example("white-round", "白色圓形", { features: "白色 圓形" }),
      example("yellow-oval", "黃色橢圓形", { features: "黃 橢圓形" }),
    ],
  },
  get_drug_details: {
    title: "藥品許可證詳細資料",
    examples: [example("default", "普拿疼伏冒日夜膜衣錠", { license_id: PANADOL_LICENSE, include_cancelled: false })],
  },
  get_drug_asset_links: {
    title: "藥品資產下載連結",
    examples: [
      example("license", "依許可證列出資產", { license_id: PANADOL_LICENSE, asset_group: null, latest_insert_only: false }),
      example("insert", "只取最新仿單", { license_id: PANADOL_LICENSE, asset_group: "insert", latest_insert_only: true }),
    ],
  },

  // ── Lab / LOINC ──────────────────────────────────────────────────────────
  search_loinc: {
    title: "搜尋 LOINC 檢驗代碼",
    examples: [
      example("code", "檢驗：glucose", { mode: "code", keyword: "glucose", limit: 3 }),
      example("category", "類別：CHEM", { mode: "category", keyword: "CHEM", limit: 5 }),
      example("component", "分析物：Hemoglobin A1c", { mode: "component", keyword: "Hemoglobin A1c", limit: 3 }),
    ],
  },
  interpret_lab_result: {
    title: "判讀單一檢驗值",
    examples: [
      example("high", "空腹血糖 126 mg/dL（55 歲男性）", { loinc_code: "1558-6", value: 126, age: 55, gender: "M" }),
      example("normal", "血紅素 13.2 g/dL（30 歲女性）", { loinc_code: "718-7", value: 13.2, age: 30, gender: "F" }),
    ],
  },
  batch_interpret_lab_results: {
    title: "批次判讀檢驗結果",
    examples: [
      example("panel", "空腹血糖 + HbA1c + 肌酸酐", {
        results_json: JSON.stringify([
          { loinc_code: "1558-6", value: 126 },
          { loinc_code: "4548-4", value: 7.2 },
          { loinc_code: "2160-0", value: 1.1 },
        ]),
        age: 55,
        gender: "M",
      }),
    ],
  },
  query_loinc: {
    title: "查詢 LOINC 代碼",
    examples: [
      example("detail", "代碼詳細資料 2345-7", { mode: "detail", loinc_code: "2345-7", age: null, gender: "all" }),
      example("range", "參考值範圍：肌酸酐（45 歲女性）", { mode: "reference_range", loinc_code: "2160-0", age: 45, gender: "F" }),
    ],
  },

  // ── SNOMED CT ────────────────────────────────────────────────────────────
  search_snomed_concept: {
    title: "搜尋 SNOMED CT 概念",
    examples: [
      example("dm2", "Type 2 diabetes mellitus", { query: "type 2 diabetes mellitus", limit: 3, hierarchy_filter: null }),
      example("hierarchy", "限定糖尿病（73211009）子階層", { query: "type 2", limit: 3, hierarchy_filter: 73211009 }),
    ],
  },
  query_snomed_concept: {
    title: "查詢 SNOMED CT 概念與階層",
    examples: [
      example("dm2", "44054006 第二型糖尿病", { concept_id: 44054006, include_parents: true, include_children: true, parent_limit: 10, child_limit: 20 }),
    ],
  },
  get_snomed_relationships: {
    title: "SNOMED CT 屬性關係",
    examples: [
      example("dm2", "44054006 的所有關係", { concept_id: 44054006, relationship_type_id: null }),
      example("site", "只看 finding site（363698007）", { concept_id: 44054006, relationship_type_id: 363698007 }),
    ],
  },
  query_snomed_mapping: {
    title: "ICD-10 ↔ SNOMED CT 對應",
    examples: [
      example("icd", "ICD-10 E11.9 → SNOMED", { mode: "icd", keyword: "E11.9" }),
      example("snomed", "SNOMED 44054006 → ICD-10", { mode: "snomed", keyword: "44054006" }),
    ],
  },

  // ── FHIR Condition / Medication ──────────────────────────────────────────
  query_fhir_condition: {
    title: "產生 FHIR Condition",
    examples: [
      example("icd", "由 ICD 碼 E11.9 產生", {
        icd_code: "E11.9",
        diagnosis_keyword: null,
        patient_id: "pat-example",
        clinical_status: "active",
        verification_status: "confirmed",
        category: "encounter-diagnosis",
        severity: "moderate",
        onset_date: "2024-03-15",
        recorded_date: "2024-03-20",
        additional_notes: "門診追蹤，飯前血糖控制不佳",
      }),
      example("keyword", "由診斷關鍵字產生", {
        icd_code: null,
        diagnosis_keyword: "第二型糖尿病",
        patient_id: "pat-example",
        clinical_status: "active",
        verification_status: "provisional",
      }),
    ],
  },
  validate_fhir_condition: {
    title: "驗證 FHIR Condition（結構）",
    examples: [
      example("valid", "有效範例", { condition_json: JSON.stringify(CONDITION_JSON, null, 2) }),
      example("invalid", "無效範例（缺 subject）", {
        condition_json: JSON.stringify({ ...CONDITION_JSON, subject: undefined }, null, 2),
      }),
    ],
  },
  query_fhir_medication: {
    title: "產生 FHIR Medication",
    examples: [
      example("license", "由許可證字號產生", { license_id: PANADOL_LICENSE, keyword: null, resource_type: "Medication" }),
      example("knowledge", "由關鍵字產生 MedicationKnowledge", { license_id: null, keyword: "普拿疼", resource_type: "MedicationKnowledge" }),
    ],
  },
  validate_fhir_medication: {
    title: "驗證 FHIR Medication（結構）",
    examples: [
      example("valid", "有效範例", { medication_json: JSON.stringify(MEDICATION_JSON, null, 2) }),
      example("invalid", "無效範例（缺 code）", {
        medication_json: JSON.stringify({ resourceType: "Medication", id: "broken" }, null, 2),
      }),
    ],
  },

  // ── FHIR IG ──────────────────────────────────────────────────────────────
  fhir_list_igs: {
    title: "列出已安裝 IG",
    examples: [example("default", "全部 IG", { compact: false }), example("compact", "精簡輸出（套件 → 標題）", { compact: true })],
  },
  fhir_get_ig: {
    title: "IG 套件詳細資料",
    examples: [example("twcore", "TW Core 1.0.0", { package_id: TWCORE, version: TWCORE_VERSION })],
  },
  fhir_list_artifacts: {
    title: "列出 IG 構件",
    examples: [
      example("sd", "TW Core 的 StructureDefinition", { resource_type: "StructureDefinition", package_id: TWCORE, version: TWCORE_VERSION, all_packages: false, limit: 20 }),
      example("vs", "TW Core 的 ValueSet", { resource_type: "ValueSet", package_id: TWCORE, version: TWCORE_VERSION, all_packages: false, limit: 20 }),
      example("compact", "精簡輸出（id → 標題）", { resource_type: "StructureDefinition", package_id: TWCORE, version: TWCORE_VERSION, all_packages: false, limit: 50, compact: true }),
    ],
  },
  fhir_search_artifacts: {
    title: "全文搜尋 IG 構件",
    examples: [
      example("patient", "搜尋 Patient", { keyword: "Patient", resource_type: "StructureDefinition", package_id: TWCORE, version: TWCORE_VERSION, all_packages: false, limit: 10 }),
      example("all", "所有套件搜尋 Claim", { keyword: "Claim", resource_type: null, all_packages: true, limit: 10 }),
      example("compact", "精簡輸出搜尋 Condition", { keyword: "Condition", resource_type: null, all_packages: false, limit: 20, compact: true }),
    ],
  },
  fhir_list_resource_profiles: {
    title: "列出可選 Profile",
    examples: [
      example("patient", "Patient 的 Profile", { base_type: "Patient", package_id: TWCORE, version: TWCORE_VERSION, all_packages: false }),
      example("all", "TW Core 全部 Profile", { base_type: null, package_id: TWCORE, version: TWCORE_VERSION, all_packages: false }),
      example("compact", "TW Core 全部 Profile（精簡）", { base_type: null, package_id: TWCORE, version: TWCORE_VERSION, all_packages: false, compact: true }),
    ],
  },
  fhir_rank_resource_profiles: {
    title: "依欄位排序候選 Profile",
    examples: [
      example("patient", "病人欄位", { keys: ["identifier", "name", "gender", "birthDate", "address"], base_type: "Patient", package_id: TWCORE, version: TWCORE_VERSION, limit: 5 }),
      example("lab", "檢驗欄位", { keys: ["code", "valueQuantity", "effectiveDateTime", "subject", "category"], base_type: "Observation", package_id: TWCORE, version: TWCORE_VERSION, limit: 5 }),
    ],
  },
  fhir_get_profile: {
    title: "Profile 摘要",
    examples: [
      example("id", "以 id：Patient-twcore", { identifier: "Patient-twcore", package_id: TWCORE, version: TWCORE_VERSION }),
      example("canonical", "以 canonical URL：Condition-twcore", { identifier: `${TWCORE_SD}/Condition-twcore` }),
    ],
  },
  fhir_get_profile_elements: {
    title: "讀取 Profile 元素",
    examples: [
      example("elements", "Patient-twcore 元素清單", { profile: "Patient-twcore", view: "elements", path: null, slice_name: null, package_id: TWCORE, version: TWCORE_VERSION, limit: 50 }),
      example("slices", "Patient.identifier 切片", { profile: "Patient-twcore", view: "slices", path: "Patient.identifier", slice_name: null, package_id: TWCORE, version: TWCORE_VERSION, limit: 50 }),
      example("binding", "Condition.code 綁定", { profile: "Condition-twcore", view: "binding", path: "Condition.code", slice_name: null, package_id: TWCORE, version: TWCORE_VERSION, limit: 50 }),
    ],
  },
  fhir_get_profile_required_elements: {
    title: "Profile 必填元素",
    examples: [
      example("patient", "Patient-twcore（精簡）", { profile: "Patient-twcore", package_id: TWCORE, version: TWCORE_VERSION, instance: null, include_target_implied: true, include_mustsupport: false, verbosity: "compact" }),
      example("observation", "Observation-laboratoryResult-twcore（完整）", { profile: "Observation-laboratoryResult-twcore", package_id: TWCORE, version: TWCORE_VERSION, instance: null, include_target_implied: true, include_mustsupport: false, verbosity: "full" }),
      example("condition", "Condition-twcore（category 推導規則 + allowedCodes）", { profile: "Condition-twcore", package_id: TWCORE, version: TWCORE_VERSION, instance: null, include_target_implied: true, include_mustsupport: false, verbosity: "compact" }),
      example("ms_defaults", "Condition-twcore + 有預設值的 Must Support（optional:true）", { profile: "Condition-twcore", package_id: TWCORE, version: TWCORE_VERSION, instance: null, include_target_implied: true, include_mustsupport: "defaults", verbosity: "compact" }),
    ],
  },
  fhir_get_valueset: {
    title: "ValueSet 定義",
    examples: [example("marital", "婚姻狀態 marital-status-tw", { identifier: `${TWCORE_VS}/marital-status-tw`, package_id: TWCORE, version: TWCORE_VERSION })],
  },
  fhir_expand_valueset: {
    title: "展開 ValueSet",
    examples: [
      example("marital", "婚姻狀態 marital-status-tw", { identifier: `${TWCORE_VS}/marital-status-tw`, package_id: TWCORE, version: TWCORE_VERSION, limit: 100 }),
      example("canonical", "以 canonical：identifier-type-tw", { identifier: `${TWCORE_VS}/identifier-type-tw`, limit: 100 }),
    ],
  },
  fhir_lookup_code: {
    title: "查詢代碼顯示名稱",
    examples: [
      example("v2", "v2-0203 MR（病歷號）", { system: "http://terminology.hl7.org/CodeSystem/v2-0203", code: "MR", package_id: TWCORE, version: TWCORE_VERSION }),
      example("icd", "ICD-10-CM E11.9", { system: "http://hl7.org/fhir/sid/icd-10-cm", code: "E11.9", package_id: TWCORE, version: TWCORE_VERSION }),
      example("nhi", "健保支付代碼 09005C", { system: NHI_PAYMENT_CS, code: "09005C", package_id: TWCORE, version: TWCORE_VERSION }),
      example("typo", "打錯的代碼（回傳 near_codes 與 hint）", { system: NHI_PAYMENT_CS, code: "09005", package_id: TWCORE, version: TWCORE_VERSION }),
    ],
  },
  fhir_validate_code: {
    title: "驗證代碼是否屬於 ValueSet",
    examples: [
      example("valid", "有效範例：婚姻狀態 M", {
        system: "http://terminology.hl7.org/CodeSystem/v3-MaritalStatus",
        code: "M",
        value_set: `${TWCORE_VS}/marital-status-tw`,
        package_id: TWCORE,
        version: TWCORE_VERSION,
      }),
      example("invalid", "無效範例：不存在的代碼", {
        system: "http://terminology.hl7.org/CodeSystem/v3-MaritalStatus",
        code: "ZZZ",
        value_set: `${TWCORE_VS}/marital-status-tw`,
        package_id: TWCORE,
        version: TWCORE_VERSION,
      }),
    ],
  },
  fhir_normalize_code: {
    title: "自由文字轉標準代碼",
    examples: [
      example("icd", "「第二型糖尿病」→ ICD-10-CM", { text: "第二型糖尿病", value_set: null, system: "http://hl7.org/fhir/sid/icd-10-cm", package_id: TWCORE, version: TWCORE_VERSION, limit: 5 }),
      example("vs", "「已婚」→ marital-status-tw", { text: "已婚", value_set: `${TWCORE_VS}/marital-status-tw`, system: null, package_id: TWCORE, version: TWCORE_VERSION, limit: 5 }),
      example("nhi_en", "「Emergent hemodialysis」→ 健保支付代碼", { text: "Emergent hemodialysis", value_set: null, system: NHI_PAYMENT_CS, package_id: TWCORE, version: TWCORE_VERSION, limit: 5 }),
      example("nhi_abbr", "「TKA」→ 健保支付代碼", { text: "TKA", value_set: null, system: NHI_PAYMENT_CS, package_id: TWCORE, version: TWCORE_VERSION, limit: 5 }),
      example("nhi_alias", "「全膝關節置換術 右側」→ system 別名 nhi_payment", { text: "全膝關節置換術 右側", value_set: null, system: "nhi_payment", package_id: null, version: null, limit: 5 }),
      example("nhi_drug", "「脈優錠 5mg」→ 健保藥品代碼（含 ATC linked）", { text: "脈優錠 5mg", value_set: null, system: "medication-nhi-tw", package_id: null, version: null, limit: 5 }),
    ],
  },
  fhir_resolve_reference: {
    title: "產生 urn:uuid 參照",
    examples: [example("patient", "病人參照", { key: "patient", resource_type: "Patient", context_id: "playground-demo", display: "王大明" })],
  },
  fhir_build_bundle: {
    title: "組裝 Bundle",
    examples: [
      example("transaction", "Patient + Condition（transaction）", { entries: BUILD_BUNDLE_ENTRIES, bundle_type: "transaction", context_id: "playground-demo" }),
      example("collection", "同上（collection）", { entries: BUILD_BUNDLE_ENTRIES, bundle_type: "collection", context_id: null }),
    ],
  },
  fhir_validate_resource: {
    title: "驗證 FHIR 資源（Profile）",
    examples: [
      example("condition", "有效範例：TW Core Condition", { resource: TWCORE_CONDITION_EXAMPLE, profile: null, package_id: TWCORE, version: TWCORE_VERSION }),
      example("patient", "TW Core Patient 範例", { resource: TWCORE_PATIENT_EXAMPLE, profile: `${TWCORE_SD}/Patient-twcore`, package_id: TWCORE, version: TWCORE_VERSION }),
      example("invalid", "無效範例：缺 subject、錯誤狀態碼", { resource: INVALID_CONDITION, profile: null, package_id: TWCORE, version: TWCORE_VERSION }),
    ],
  },
  fhir_validate_bundle: {
    title: "驗證 FHIR Bundle",
    examples: [
      example("twcore", "TW Core Bundle 範例", { bundle: TWCORE_BUNDLE_EXAMPLE, package_id: TWCORE, version: TWCORE_VERSION }),
      example("id_suggestions", "標籤式 fullUrl（urn:uuid:patient-1）：ID 錯誤附 suggestions 與 id_map", { bundle: LABELLED_BUNDLE, package_id: TWCORE, version: TWCORE_VERSION, normalize_ids: false }),
      example("normalize_ids", "同上，normalize_ids=true：先整理再驗證，回傳 normalized_bundle", { bundle: LABELLED_BUNDLE, package_id: TWCORE, version: TWCORE_VERSION, normalize_ids: true }),
      example(
        "grounded",
        "含病歷原文落地檢查",
        {
          bundle: GROUNDING_VALID_INPUT.bundle,
          package_id: TWCORE,
          version: TWCORE_VERSION,
          source_text: GROUNDING_VALID_INPUT.source_text,
          site_config: GROUNDING_VALID_INPUT.site_config,
          evidence_map: GROUNDING_VALID_INPUT.evidence_map,
        },
        "加上 source_text 時同時執行 grounding（虛構病歷）",
      ),
    ],
  },
  fhir_check_grounding: {
    title: "病歷落地檢查（Grounding）",
    examples: [
      example("valid", "有效範例：與原文一致", GROUNDING_VALID_INPUT, "耳鼻喉科門診紀錄 + Bundle 與 evidence map（虛構）"),
      example("wrong-date", "無效範例：就診日期被改", GROUNDING_WRONG_DATE_INPUT),
      example("fabricated", "無效範例：病歷未記載的診斷", GROUNDING_FABRICATED_INPUT),
    ],
  },
  fhir_check_completeness: {
    title: "病歷完整性檢查",
    examples: [
      example("complete", "資料齊全", COMPLETENESS_COMPLETE_INPUT, "糖尿病追蹤門診（虛構）"),
      example("insufficient", "資料不足：缺 HbA1c 數值與 Metformin 劑量、頻次", COMPLETENESS_INSUFFICIENT_INPUT),
    ],
  },
  fhir_get_resource_skeleton: {
    title: "Profile 填寫骨架",
    examples: [
      example("condition", "Condition-twcore", { profile: "Condition-twcore", package_id: TWCORE, version: TWCORE_VERSION, candidate_limit: 10, include_examples: true }),
      example("patient", "Patient-twcore（不含範例）", { profile: "Patient-twcore", package_id: TWCORE, version: TWCORE_VERSION, candidate_limit: 10, include_examples: false }),
    ],
  },
  fhir_finalize_resource: {
    title: "完成並驗證草稿資源",
    examples: [
      example("patient", "Patient 草稿", { profile: "Patient-twcore", draft: PATIENT_DRAFT, context_id: "playground-demo", key: "patient", package_id: TWCORE, version: TWCORE_VERSION, generate_narrative: true }),
    ],
  },
  fhir_finalize_bundle: {
    title: "整理 Bundle 的 fullUrl / reference / id",
    examples: [
      example("labels", "標籤式 fullUrl 與三種引用寫法 → 確定性 urn:uuid", { bundle: LABELLED_BUNDLE, package_id: TWCORE, version: TWCORE_VERSION, bundle_profile: null }, "fullUrl urn:uuid:patient-1、引用 Patient/patient-1 / 裸 id、Bundle.id 為 urn；changes 列出每一處改動"),
      example("valid", "已合法的 Bundle：原樣回傳，changes 為空", { bundle: TWCORE_BUNDLE_EXAMPLE, package_id: TWCORE, version: TWCORE_VERSION, bundle_profile: null }),
      example("profile", "指定 Bundle profile（固定 type 時套用）", { bundle: LABELLED_BUNDLE, package_id: null, version: null, bundle_profile: `${TWCORE_SD}/Bundle-twcore` }),
    ],
  },

  // ── Health Supplements / Food Nutrition ──────────────────────────────────
  search_health_supplements: {
    title: "搜尋健康食品",
    examples: [
      example("keyword", "關鍵字：調節血脂", { mode: "keyword", keyword: "調節血脂", limit: 3 }),
      example("condition", "疾病：第二型糖尿病", { mode: "condition", keyword: "E11", limit: 3 }),
    ],
  },
  query_food_nutrition: {
    title: "查詢食品營養成分",
    examples: [
      example("quick", "白飯（熱量）", { food_name: "白飯", nutrient: "熱量", limit: 3, detailed: false }),
      example("detailed", "地瓜（完整營養）", { food_name: "地瓜", nutrient: null, limit: 3, detailed: true }),
    ],
  },
  query_food_ingredient: {
    title: "查詢食品原料分類",
    examples: [example("default", "原料：薑黃", { keyword: "薑黃", category: null, limit: 3 })],
  },
  search_foods_by_nutrient: {
    title: "依營養素排序食品",
    examples: [example("default", "鈣含量最高", { nutrient: "鈣", limit: 10 })],
  },
  analyze_meal_nutrition: {
    title: "整餐營養分析",
    examples: [example("default", "早餐：白飯、雞蛋、豆漿", { foods: ["白飯", "雞蛋", "豆漿"] })],
  },

  // ── FHIR Servers ─────────────────────────────────────────────────────────
  list_fhir_servers: {
    title: "列出外部 FHIR 伺服器",
    examples: [
      example("enabled", "只列啟用中", { include_disabled: false }),
      example("all", "包含停用", { include_disabled: true }),
    ],
  },
  get_fhir_server_status: {
    title: "FHIR 伺服器狀態",
    examples: [example("default", "hapi-public", { server_key: "hapi-public" })],
  },
  crud_fhir_server: {
    title: "外部 FHIR 伺服器操作",
    examples: [
      example("metadata", "唯讀：CapabilityStatement", {
        server_key: "hapi-public",
        operation: "metadata",
        resource_type: "",
        resource_id: "",
        query_json: "",
        resource_json: "",
        patch_json: "",
        confirm_write: false,
        token_strategy: "auto",
      }),
      example("search", "唯讀：搜尋 Patient（1 筆）", {
        server_key: "hapi-public",
        operation: "search",
        resource_type: "Patient",
        query_json: JSON.stringify({ _count: 1 }),
        confirm_write: false,
      }),
      example(
        "create",
        "寫入：建立 Patient（會被拒絕）",
        {
          server_key: "hapi-public",
          operation: "create",
          resource_type: "Patient",
          resource_json: JSON.stringify(PATIENT_DRAFT, null, 2),
          confirm_write: false,
        },
        "寫入需同時 confirm_write=true 且伺服器允許 create；本範例兩者皆不符，示範被拒絕的回應",
      ),
    ],
  },

  // ── Clinical Calculators ─────────────────────────────────────────────────
  calculate_chads2_vasc: {
    title: "CHA₂DS₂-VASc 中風風險",
    examples: [
      example("af", "72 歲女性、高血壓、糖尿病", { age: 72, sex: "F", congestive_heart_failure: false, hypertension: true, diabetes: true, stroke_or_tia: false, vascular_disease: false }),
      example("low", "45 歲男性、無危險因子", { age: 45, sex: "M" }),
    ],
  },
  calculate_wells_pe: {
    title: "Wells 肺栓塞",
    examples: [
      example("moderate", "心跳 112、近期手術", { clinical_signs_dvt: false, alternative_diagnosis_less_likely: true, heart_rate_bpm: 112, immobilization_or_recent_surgery: true, previous_dvt_or_pe: false, hemoptysis: false, active_malignancy: false }),
    ],
  },
  calculate_wells_dvt: {
    title: "Wells 深部靜脈栓塞",
    examples: [
      example("likely", "小腿腫脹 > 3 cm、凹陷性水腫", { active_cancer: false, paralysis_paresis_or_immobilization: false, bedridden_or_recent_surgery: true, calf_swelling_gt_3cm: true, collateral_superficial_veins: false, entire_leg_swollen: false, localized_tenderness: true, pitting_edema: true, previous_dvt: false, alternative_diagnosis_as_likely: false }),
    ],
  },
  calculate_das28: {
    title: "DAS28 類風濕性關節炎活性",
    examples: [
      example("esr", "ESR 公式", { tender_count: 6, swollen_count: 4, global_health: 50, formula: "esr", esr: 32, crp: null }),
      example("crp", "CRP 公式", { tender_count: 6, swollen_count: 4, global_health: 50, formula: "crp", esr: null, crp: 12 }),
    ],
  },
  calculate_cdai: {
    title: "CDAI 類風濕性關節炎活性",
    examples: [example("moderate", "中度活性", { tender_count: 6, swollen_count: 4, patient_global: 5, provider_global: 4 })],
  },
  calculate_bmi: {
    title: "BMI（台灣切點）",
    examples: [
      example("overweight", "170 cm / 72 kg", { weight_kg: 72, height_cm: 170 }),
      example("normal", "160 cm / 52 kg", { weight_kg: 52, height_cm: 160 }),
    ],
  },
  calculate_egfr: {
    title: "eGFR（CKD-EPI 2021）",
    examples: [
      example("ckd3", "65 歲男性、肌酸酐 1.4 mg/dL", { age: 65, sex: "M", serum_creatinine_mgdl: 1.4 }),
      example("normal", "40 歲女性、肌酸酐 0.7 mg/dL", { age: 40, sex: "F", serum_creatinine_mgdl: 0.7 }),
    ],
  },
  calculate_has_bled: {
    title: "HAS-BLED 出血風險",
    examples: [
      example("high", "70 歲、SBP 165、服用 NSAID", { age: 70, systolic_bp_mmhg: 165, abnormal_renal_function: false, abnormal_liver_function: false, stroke_history: false, bleeding_history: true, labile_inr: false, drugs_antiplatelet_or_nsaid: true, alcohol: false }),
    ],
  },
  calculate_curb65: {
    title: "CURB-65 肺炎嚴重度",
    examples: [
      example("moderate", "78 歲、BUN 24、RR 26", { age: 78, confusion: false, bun_mgdl: 24, respiratory_rate: 26, sbp_mmhg: 118, dbp_mmhg: 70 }),
    ],
  },
  calculate_qsofa: {
    title: "qSOFA 敗血症篩檢",
    examples: [
      example("positive", "RR 24、GCS 14、SBP 95", { respiratory_rate: 24, gcs: 14, sbp_mmhg: 95 }),
      example("negative", "RR 16、GCS 15、SBP 125", { respiratory_rate: 16, gcs: 15, sbp_mmhg: 125 }),
    ],
  },
  calculate_gcs: {
    title: "GCS 昏迷指數",
    examples: [
      example("moderate", "E3 V4 M5", { eye_response: 3, verbal_response: 4, motor_response: 5 }),
      example("severe", "E1 V2 M4", { eye_response: 1, verbal_response: 2, motor_response: 4 }),
    ],
  },

  // ── System ───────────────────────────────────────────────────────────────
  health_check: { title: "伺服器健康檢查", examples: [example("default", "健康檢查", {})] },
};

/** Example set for one tool, or null when none is curated. */
export function toolExamples(name: string): ToolExampleSet | null {
  return Object.prototype.hasOwnProperty.call(MCP_TOOL_EXAMPLES, name) ? MCP_TOOL_EXAMPLES[name] : null;
}
