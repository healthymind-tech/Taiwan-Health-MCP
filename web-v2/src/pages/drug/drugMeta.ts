// Display metadata for drug pipeline stages, statuses and asset types.

export const DRUG_JOB_TYPES = ["drug_pipeline", "drug_index_import", "drug_enrichment", "drug_analysis"] as const;
export const DRUG_MODULE_KEY = "drug";
export const DRUG_SOURCE_ROLE = "drug_index_csv";
/** Mirrors DRUG_AUTOCHAIN_BATCH_LIMIT's default in adminJobs.ts. */
export const DEFAULT_BATCH_LIMIT = 200;

/** Stage column (import_license_state) → label. Order = pipeline order. */
export const STAGE_COLUMNS: { key: string; stage: string; label: string; short: string }[] = [
  { key: "index_status", stage: "index", label: "許可證索引", short: "索引" },
  { key: "electronic_insert_status", stage: "electronic_insert", label: "電子仿單", short: "電子仿單" },
  { key: "insert_pdf_status", stage: "insert_pdf", label: "仿單 PDF", short: "仿單" },
  { key: "label_pdf_status", stage: "label_pdf", label: "外盒 PDF", short: "外盒" },
  { key: "shape_status", stage: "shape", label: "外觀圖片", short: "外觀" },
  { key: "storage_status", stage: "storage", label: "物件儲存", short: "儲存" },
  { key: "ocr_status", stage: "ocr", label: "OCR", short: "OCR" },
  { key: "analysis_status", stage: "analysis", label: "LLM 分析", short: "分析" },
  { key: "normalize_status", stage: "normalize", label: "正規化", short: "正規化" },
];

/** Stage keys used in drug.import_stage_events. */
export const EVENT_STAGE_LABELS: Record<string, string> = {
  index_import: "索引匯入",
  electronic_insert_scrape: "電子仿單擷取",
  insert_pdf_download: "仿單 PDF 下載",
  label_pdf_download: "外盒 PDF 下載",
  shape_scrape: "外觀圖片擷取",
  object_upload: "上傳物件儲存",
  ocr: "OCR",
  analysis: "LLM 分析",
  normalize: "正規化",
};

export function eventStageLabel(stage: string | null | undefined): string {
  const s = String(stage ?? "");
  return EVENT_STAGE_LABELS[s] ?? STAGE_COLUMNS.find((c) => c.stage === s)?.label ?? (s || "—");
}

export interface DrugStatusMeta {
  label: string;
  color: string;
}

export const DRUG_STATUS: Record<string, DrugStatusMeta> = {
  success: { label: "完成", color: "teal" },
  partial_success: { label: "部分完成", color: "amber" },
  pending: { label: "待處理", color: "gray" },
  running: { label: "處理中", color: "blue" },
  in_progress: { label: "處理中", color: "blue" },
  no_data: { label: "無資料", color: "gray" },
  skipped: { label: "略過", color: "gray" },
  retryable_failed: { label: "失敗（可重試）", color: "orange" },
  permanent_failed: { label: "失敗", color: "red" },
  failed: { label: "失敗", color: "red" },
};

export function drugStatusMeta(status: string | null | undefined): DrugStatusMeta {
  const s = String(status ?? "");
  return DRUG_STATUS[s] ?? { label: s || "未知", color: "gray" };
}

/** Statuses offered in stage filters. */
export const STAGE_STATUS_OPTIONS = [
  { value: "success", label: "完成" },
  { value: "pending", label: "待處理" },
  { value: "no_data", label: "無資料" },
  { value: "retryable_failed", label: "失敗（可重試）" },
  { value: "permanent_failed", label: "失敗" },
];

export const ASSET_TYPE_LABELS: Record<string, string> = {
  insert_pdf: "仿單 PDF",
  label_pdf: "外盒 PDF",
  shape_image: "外觀圖片",
  web_image: "網頁縮圖",
  ocr_markdown: "OCR 文字",
  analysis_json: "分析 JSON",
};

export function assetTypeLabel(t: string | null | undefined): string {
  const s = String(t ?? "");
  return ASSET_TYPE_LABELS[s] ?? (s || "其他");
}

/** Asset kinds offered as explorer filters (web_image excluded: implied by shape_image). */
export const FILTER_ASSET_TYPES = ["insert_pdf", "label_pdf", "shape_image", "ocr_markdown", "analysis_json"] as const;

export function assetContentUrl(assetId: string, opts: { variant?: string; download?: boolean } = {}): string {
  const sp = new URLSearchParams({ asset_id: assetId });
  if (opts.variant) sp.set("variant", opts.variant);
  if (opts.download) sp.set("download", "true");
  return `/admin/api/drug/asset-content?${sp.toString()}`;
}

/** Route path to a license detail page (license ids contain CJK + punctuation). */
export function drugDetailPath(licenseId: string): string {
  return `/drug/explorer/${encodeURIComponent(licenseId)}`;
}
