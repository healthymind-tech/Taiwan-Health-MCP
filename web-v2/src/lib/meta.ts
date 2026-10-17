/**
 * Display metadata for jobs and modules. The backend payloads carry raw keys;
 * everything a human reads (labels, colours, capabilities) is defined here once.
 */

import type { JobStatus } from "./types";

// ── Job status ────────────────────────────────────────────────────────────────
export const ACTIVE_STATUSES: ReadonlySet<string> = new Set(["queued", "running", "paused"]);
export const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "success",
  "partial_success",
  "stopped",
  "cancelled",
  "retryable_failed",
  "permanent_failed",
]);

export interface StatusMeta {
  label: string;
  color: string;
  /** Pulsing dot for in-progress states. */
  live?: boolean;
}

export const JOB_STATUS: Record<string, StatusMeta> = {
  queued: { label: "排隊中", color: "gray" },
  running: { label: "執行中", color: "blue", live: true },
  paused: { label: "已暫停", color: "amber" },
  stopped: { label: "已停止", color: "gray" },
  cancelled: { label: "已取消", color: "gray" },
  success: { label: "成功", color: "teal" },
  partial_success: { label: "部分成功", color: "amber" },
  retryable_failed: { label: "失敗（可重試）", color: "orange" },
  permanent_failed: { label: "失敗", color: "red" },
};

export function jobStatusMeta(status: string | null | undefined): StatusMeta {
  return JOB_STATUS[String(status ?? "")] ?? { label: String(status || "未知"), color: "gray" };
}

export const JOB_STATUS_FILTERS: { value: string; label: string }[] = [
  { value: "active", label: "進行中" },
  { value: "success", label: "成功" },
  { value: "failed", label: "失敗" },
  { value: "stopped", label: "已停止" },
];

export function matchesStatusFilter(status: JobStatus | string, filter: string): boolean {
  switch (filter) {
    case "active":
      return ACTIVE_STATUSES.has(status);
    case "success":
      return status === "success" || status === "partial_success";
    case "failed":
      return status === "retryable_failed" || status === "permanent_failed";
    case "stopped":
      return status === "stopped" || status === "cancelled";
    default:
      return true;
  }
}

// ── Job types ─────────────────────────────────────────────────────────────────
export const JOB_TYPE_LABELS: Record<string, string> = {
  noop: "測試工作",
  system_backup: "系統備份",
  icd_import: "ICD-10 匯入",
  loinc_import: "LOINC 匯入",
  snomed_import: "SNOMED CT 匯入",
  rxnorm_import: "RxNorm 匯入",
  ig_import: "FHIR IG 匯入",
  health_supplements_sync: "健康食品同步",
  food_nutrition_sync: "食品營養同步",
  drug_index_import: "藥品許可證索引匯入",
  drug_enrichment: "藥品資料擴充（爬取）",
  drug_analysis: "藥品仿單分析（OCR + LLM）",
  drug_pipeline: "藥品完整管線",
  icd_embed: "ICD-10 向量嵌入",
  loinc_embed: "LOINC 向量嵌入",
  snomed_embed: "SNOMED CT 向量嵌入",
  health_supplements_embed: "健康食品向量嵌入",
  food_nutrition_embed: "食品營養向量嵌入",
};

export function jobTypeLabel(jobType: string | null | undefined): string {
  return JOB_TYPE_LABELS[String(jobType ?? "")] ?? String(jobType ?? "—");
}

export const JOB_ACTION_LABELS: Record<string, string> = {
  pause: "暫停",
  resume: "繼續",
  stop: "停止",
  restart: "重新開始",
};

// ── Modules ───────────────────────────────────────────────────────────────────
export type ModuleKind = "upload" | "sync" | "drug" | "ig";
export type ClearScope = "embeddings" | "data" | "sources" | "all";

export interface ModuleMeta {
  key: string;
  label: string;
  shortLabel: string;
  description: string;
  kind: ModuleKind;
  group: "terminology" | "fhir" | "tfda";
  importJobType: string | null;
  embedJobType: string | null;
  schedulable: boolean;
  previewable: boolean;
  maintenance: boolean;
  /** Key in /admin/api/modules record_counts. */
  countKey: string;
  /** Key in /admin/api/overview modules & services maps. */
  serviceKey: string | null;
  clearScopes: ClearScope[];
  /** Upstream licence / provenance line shown on the module page. */
  source: string;
}

export const MODULES: ModuleMeta[] = [
  {
    key: "icd",
    label: "ICD-10-CM / PCS",
    shortLabel: "ICD-10",
    description: "國際疾病分類第十版診斷碼與處置碼，含台灣中文對照。",
    kind: "upload",
    group: "terminology",
    importJobType: "icd_import",
    embedJobType: "icd_embed",
    schedulable: true,
    previewable: true,
    maintenance: true,
    countKey: "icd",
    serviceKey: "icd",
    clearScopes: ["embeddings", "data", "sources", "all"],
    source: "NLM / CMS（公開）＋ 衛福部中文對照",
  },
  {
    key: "loinc",
    label: "LOINC",
    shortLabel: "LOINC",
    description: "檢驗觀察項目代碼、參考區間與台灣對照。",
    kind: "upload",
    group: "terminology",
    importJobType: "loinc_import",
    embedJobType: "loinc_embed",
    schedulable: false,
    previewable: true,
    maintenance: true,
    countKey: "loinc",
    serviceKey: "lab",
    clearScopes: ["embeddings", "data", "sources", "all"],
    source: "Regenstrief Institute（LOINC License）",
  },
  {
    key: "snomed",
    label: "SNOMED CT",
    shortLabel: "SNOMED CT",
    description: "臨床術語概念、描述、關聯與 ICD-10 對應。",
    kind: "upload",
    group: "terminology",
    importJobType: "snomed_import",
    embedJobType: "snomed_embed",
    schedulable: false,
    previewable: true,
    maintenance: true,
    countKey: "snomed",
    serviceKey: "snomed",
    clearScopes: ["embeddings", "data", "sources", "all"],
    source: "SNOMED International（需會員授權）",
  },
  {
    key: "rxnorm",
    label: "RxNorm",
    shortLabel: "RxNorm",
    description: "藥品命名參考術語，供 FHIR IG ValueSet 展開使用。",
    kind: "upload",
    group: "terminology",
    importJobType: "rxnorm_import",
    embedJobType: null,
    schedulable: false,
    previewable: true,
    maintenance: true,
    countKey: "rxnorm",
    serviceKey: null,
    clearScopes: ["data", "sources", "all"],
    source: "NLM（UMLS License）",
  },
  {
    key: "ig",
    label: "FHIR Implementation Guides",
    shortLabel: "FHIR IG",
    description: "多 IG 套件管理：Profile、ValueSet、CodeSystem 與術語驗證。",
    kind: "ig",
    group: "fhir",
    importJobType: "ig_import",
    embedJobType: null,
    schedulable: true,
    previewable: true,
    maintenance: true,
    countKey: "ig",
    serviceKey: "ig",
    clearScopes: ["data", "sources", "all"],
    source: "HL7 FHIR Package Registry / 上傳 package.tgz",
  },
  {
    key: "drug",
    label: "藥品（TFDA）",
    shortLabel: "藥品",
    description: "食藥署藥品許可證、仿單、外觀與 OCR + LLM 結構化分析。",
    kind: "drug",
    group: "tfda",
    importJobType: "drug_index_import",
    embedJobType: null,
    schedulable: true,
    previewable: true,
    maintenance: true,
    countKey: "drug",
    serviceKey: "drug",
    clearScopes: [],
    source: "衛生福利部食品藥物管理署",
  },
  {
    key: "health_supplements",
    label: "健康食品",
    shortLabel: "健康食品",
    description: "食藥署健康食品許可資料，含保健功效與疾病對應。",
    kind: "sync",
    group: "tfda",
    importJobType: "health_supplements_sync",
    embedJobType: "health_supplements_embed",
    schedulable: true,
    previewable: true,
    maintenance: false,
    countKey: "health_supplements",
    serviceKey: "health_supplements",
    clearScopes: ["embeddings", "data", "all"],
    source: "食藥署開放資料 API",
  },
  {
    key: "food_nutrition",
    label: "食品營養成分",
    shortLabel: "食品營養",
    description: "台灣食品營養成分資料庫，含營養素與食材查詢。",
    kind: "sync",
    group: "tfda",
    importJobType: "food_nutrition_sync",
    embedJobType: "food_nutrition_embed",
    schedulable: true,
    previewable: true,
    maintenance: false,
    countKey: "food_nutrition",
    serviceKey: "food_nutrition",
    clearScopes: ["embeddings", "data", "all"],
    source: "食藥署開放資料 API",
  },
];

export const MODULE_BY_KEY: Record<string, ModuleMeta> = Object.fromEntries(MODULES.map((m) => [m.key, m]));

export function moduleLabel(key: string | null | undefined): string {
  return MODULE_BY_KEY[String(key ?? "")]?.shortLabel ?? String(key || "—");
}

export const CLEAR_SCOPE_META: Record<ClearScope, { label: string; description: string; destructive: "medium" | "high" }> = {
  embeddings: {
    label: "只清除向量嵌入",
    description: "刪除此模組的所有向量，保留匯入資料與來源檔。語意搜尋會暫時退回關鍵字搜尋，之後可重新嵌入。",
    destructive: "medium",
  },
  data: {
    label: "清除匯入資料",
    description: "刪除所有已匯入的資料列（向量會一併刪除），保留來源檔，可直接重新匯入。此模組的 MCP 工具會下架。",
    destructive: "high",
  },
  sources: {
    label: "只刪除來源檔",
    description: "刪除所有上傳的來源檔與物件儲存中的檔案，已匯入的資料保留。之後重新匯入需要再上傳。",
    destructive: "medium",
  },
  all: {
    label: "全部清除",
    description: "刪除匯入資料、向量與所有來源檔，模組回到全新狀態。",
    destructive: "high",
  },
};

export const SERVICE_LABELS: Record<string, string> = {
  icd: "ICD-10-CM/PCS",
  lab: "LOINC 檢驗",
  snomed: "SNOMED CT",
  ig: "FHIR IG",
  fhir_condition: "FHIR Condition",
  fhir_medication: "FHIR Medication",
  drug: "藥品（TFDA）",
  health_supplements: "健康食品",
  food_nutrition: "食品營養",
};

export const WEEKDAYS_ZH = ["週一", "週二", "週三", "週四", "週五", "週六", "週日"];

export const TERMINOLOGY_MODULES: ModuleMeta[] = MODULES.filter((m) => m.group === "terminology");

/** Canonical in-app route for a module's page. */
export function moduleHref(key: string): string {
  if (key === "drug") return "/drug";
  if (key === "ig") return "/fhir/ig";
  return MODULE_BY_KEY[key]?.group === "terminology" ? `/terminology/${key}` : `/data/${key}`;
}
