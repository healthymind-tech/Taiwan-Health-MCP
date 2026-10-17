// Local, precise types for the /admin/api/drug/* payloads (see
// node-server/src/admin/adminDrug.ts, adminDrugExplorer.ts, llmCallLog.ts).

export interface DrugJobSnapshot {
  job_id: string | null;
  status: string | null;
  current_step: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface DrugPipelineStatus {
  index: { total_licenses: number; last_job: DrugJobSnapshot };
  pipeline: {
    queue_total: number;
    queue_pending: number;
    queue_done: number;
    queue_failed: number;
    is_complete: boolean;
    last_job: DrugJobSnapshot;
  };
  enrichment: {
    queue_total: number;
    queue_pending: number;
    queue_done: number;
    queue_failed: number;
    enriched_licenses: number;
    ei_only_licenses: number;
    pdf_analyzed_licenses: number;
    needs_ocr_licenses: number;
    inactive_licenses: number;
    is_complete: boolean;
    last_job: DrugJobSnapshot;
  };
  analysis: {
    total: number;
    pending: number;
    done: number;
    failed: number;
    is_complete: boolean;
    last_job: DrugJobSnapshot;
  };
}

export interface DrugRecentEvent {
  license_id: string;
  name_zh: string;
  stage: string;
  status: string;
  error_message: string;
  created_at: string;
}

export interface DrugAdminStatus {
  summary: {
    total_licenses: number;
    active_licenses: number;
    queue_counts: { pending: number; success: number; partial_success: number; retryable_failed: number };
    state_counts: Record<string, number>;
  };
  licenses: unknown[];
  recent_events: DrugRecentEvent[];
  pagination: { total: number; page: number; per_page: number; total_pages: number };
}

export interface ExplorerDrug {
  license_id: string;
  name_zh: string | null;
  name_en: string | null;
  is_active: boolean;
  dosage_form: string | null;
  manufacturer_name: string | null;
  manufacturer_country: string | null;
  last_error_message: string | null;
  updated_at: string | null;
  asset_count: number;
  pipeline_progress: number;
  has_error: boolean;
  missing_count: number;
  statuses: Record<string, string>;
  thumbnail_url: string | null;
}

export interface FacetValue {
  value: string;
  count: number;
}

export interface ExplorerPayload {
  drugs: ExplorerDrug[];
  pagination: { total: number; page: number; per_page: number; total_pages: number };
  facets: {
    asset_types?: Record<string, number>;
    dosage_form?: FacetValue[];
    country?: FacetValue[];
    manufacturer?: FacetValue[];
    appearance_color?: FacetValue[];
    appearance_shape?: FacetValue[];
  };
}

export interface ExplorerImage {
  asset_id: string;
  filename: string | null;
  preview_url: string;
  original_url: string;
  width: number | null;
  height: number | null;
}

export interface ExplorerAppearance {
  appearance_id: string;
  appearance_no: string | number | null;
  description: string | null;
  color: string | null;
  shape: string | null;
  scoring: string | null;
  symbol: string | null;
  size: string | null;
  imprint: string | null;
  detail_url: string | null;
  width_px?: number | null;
  height_px?: number | null;
  images: ExplorerImage[];
}

export interface ExplorerDocument {
  source_asset_id: string;
  asset_type: string;
  source_filename: string | null;
  normalized_filename: string | null;
  mime_type: string | null;
  size_bytes: number | string | null;
  upload_date: string | null;
  source_url: string | null;
  storage_status: string | null;
  ocr_asset_id: string | null;
  ocr_filename: string | null;
  analysis_asset_id: string | null;
  analysis_filename: string | null;
  ocr_status: string | null;
  analysis_status: string | null;
  completed_at: string | null;
}

export interface ExplorerAsset {
  asset_id: string;
  asset_type: string;
  asset_group: string | null;
  source_filename: string | null;
  normalized_filename: string | null;
  mime_type: string | null;
  size_bytes: number | string | null;
  upload_date: string | null;
  source_url: string | null;
  storage_status: string | null;
}

export interface TimelineEvent {
  event_id: number | string;
  stage: string;
  from_status: string | null;
  status: string | null;
  error_code: string | null;
  error_message: string | null;
  payload: unknown;
  created_at: string;
}

export interface ExplorerDetail {
  drug: Record<string, unknown> & {
    license_id: string;
    chinese_name?: string | null;
    english_name?: string | null;
    is_active?: boolean;
    tfda_url?: string;
    normalized_record?: unknown;
    quality_confidence?: string | null;
    missing_fields?: unknown;
    conflict_fields?: unknown;
    source_errors?: unknown;
    last_error_code?: string | null;
    last_error_message?: string | null;
    pipeline_updated_at?: string | null;
  };
  appearances: ExplorerAppearance[];
  documents: ExplorerDocument[];
  assets: ExplorerAsset[];
  timeline: {
    stages: { stage: string; status: string; events: TimelineEvent[] }[];
    events: TimelineEvent[];
  };
}

export interface LlmCallSummary {
  id: number;
  created_at: string | null;
  attempt: number;
  profileName: string;
  model: string;
  provider: string;
  status: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  isJson: boolean;
}

export interface LlmCallDetail {
  id: number;
  licenseId: string;
  attempt: number;
  profileName: string;
  model: string;
  provider: string;
  status: string;
  promptMessages: { role: string; content: string }[];
  responseContent: string;
  error: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  createdAt: string | null;
}

/** Narrowing helpers for the loosely-typed normalized record. */
export type Dict = Record<string, unknown>;

export function isDict(v: unknown): v is Dict {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function asDict(v: unknown): Dict {
  return isDict(v) ? v : {};
}

export function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export function asText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

/** Strings of a list (ignores non-string / empty items). */
export function textItems(v: unknown): string[] {
  if (typeof v === "string") return v.trim() ? [v] : [];
  return asArray(v)
    .map((x) => asText(x).trim())
    .filter(Boolean);
}

/** True when a value carries no displayable content. */
export function isEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.every(isEmptyValue);
  if (isDict(v)) return Object.values(v).every(isEmptyValue);
  return false;
}
