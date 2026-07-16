/**
 * Module source catalog + source-version read surface.
 *
 * Faithful port of the read pieces of `src/admin_sources.py`: the static
 * `SOURCE_CATALOG` (with `SourceCatalogEntry.to_dict`) and `list_source_versions`.
 * Upload / activation / dedup mutations belong to the write chunk.
 *
 * `activated_at` / `uploaded_at` are serialized by the endpoint via
 * `.isoformat()`, so they go through `tsIsoExpr` + `pyIso`. `size_bytes` is a
 * Postgres bigint; node-pg decodes bigint to a string while asyncpg yields an
 * int, so we coerce to Number to match the Python JSON (sizes stay < 2^53).
 */

import { createHash, randomUUID } from "node:crypto";
import { query, withTransaction } from "../db.js";
import { tsIsoExpr, pyIso } from "./adminJobs.js";
import * as minioService from "../minioService.js";

export interface SourceCatalogEntry {
  module_key: string;
  source_role: string;
  label: string;
  description: string;
  accepted_extensions: string[];
  multi_source: boolean;
}

/** Faithful port of `SOURCE_CATALOG` (read-relevant fields). */
export const SOURCE_CATALOG: readonly SourceCatalogEntry[] = [
  {
    module_key: "icd",
    source_role: "icd10cm",
    label: "ICD-10-CM 2025 ZIP",
    description: "Main ICD-10-CM release archive used for diagnosis import.",
    accepted_extensions: [".zip"],
    multi_source: false,
  },
  {
    module_key: "icd",
    source_role: "icd10pcs",
    label: "ICD-10-PCS 2025 ZIP",
    description: "Procedure code archive for ICD-10-PCS import.",
    accepted_extensions: [".zip"],
    multi_source: false,
  },
  {
    module_key: "icd",
    source_role: "icd_zh_tw",
    label: "Taiwan ICD bilingual XLSX",
    description: "Optional MOHW bilingual ICD Excel for Chinese names.",
    accepted_extensions: [".xlsx"],
    multi_source: false,
  },
  {
    module_key: "loinc",
    source_role: "loinc",
    label: "LOINC ZIP",
    description: "Primary LOINC release ZIP.",
    accepted_extensions: [".zip"],
    multi_source: false,
  },
  {
    module_key: "loinc",
    source_role: "loinc_taiwan_mapping",
    label: "LOINC Taiwan mapping CSV",
    description: "Optional Taiwan mapping file for local names.",
    accepted_extensions: [".csv"],
    multi_source: false,
  },
  {
    module_key: "loinc",
    source_role: "loinc_reference_ranges",
    label: "LOINC reference ranges CSV",
    description: "Optional age/gender reference ranges.",
    accepted_extensions: [".csv"],
    multi_source: false,
  },
  {
    module_key: "snomed",
    source_role: "snomed_ct",
    label: "SNOMED CT RF2 ZIP",
    description: "International RF2 release archive.",
    accepted_extensions: [".zip"],
    multi_source: false,
  },
  {
    module_key: "rxnorm",
    source_role: "rxnorm_full",
    label: "RxNorm Full Release ZIP",
    description:
      "RxNorm_full_<date> archive — concept-only import (RXNCONSO.RRF) so IG ValueSets can expand RxNorm TTY filters into real codes.",
    accepted_extensions: [".zip"],
    multi_source: false,
  },
  {
    module_key: "ig",
    source_role: "ig",
    label: "FHIR IG package.tgz",
    description:
      "FHIR NPM package (package.tgz) for any Implementation Guide — its resources, profiles, terminology, and examples. Declared dependency IGs are auto-fetched from the FHIR registry; upload one here only when the registry cannot supply it.",
    accepted_extensions: [".tgz", ".tar.gz"],
    multi_source: true,
  },
  {
    module_key: "drug",
    source_role: "drug_index_csv",
    label: "Drug index CSV (36_2.csv)",
    description: "Authoritative Taiwan drug index snapshot for drug Phase 1 index import.",
    accepted_extensions: [".csv"],
    multi_source: true,
  },
  {
    module_key: "guideline",
    source_role: "guideline_pdf",
    label: "Clinical guideline PDF",
    description:
      "Raw clinical-guideline PDF for one disease/ICD target; OCR'd and extracted by the guideline analysis pipeline. Many may be active at once — one per uploaded document.",
    accepted_extensions: [".pdf"],
    multi_source: true,
  },
];

interface VersionRow {
  module_source_id: string;
  module_key: string;
  source_role: string;
  is_active: boolean;
  version_num: number | null;
  uploaded_file_id: string;
  original_filename: string | null;
  size_bytes: number | string | null;
  sha256: string | null;
  uploaded_by: string | null;
  validation_status: string | null;
  activated_at_iso: string | null;
  uploaded_at_iso: string | null;
}

/** Faithful port of `list_source_versions`. */
export async function listSourceVersions(moduleKey: string): Promise<Record<string, unknown>[]> {
  if (moduleKey === "drug") return [];

  const validRoles = new Set<string>();
  const roleLabels = new Map<string, string>();
  for (const entry of SOURCE_CATALOG) {
    if (entry.module_key === moduleKey) {
      validRoles.add(entry.source_role);
      roleLabels.set(entry.source_role, entry.label);
    }
  }
  if (validRoles.size === 0) return [];

  const res = await query<VersionRow>(
    `SELECT
        ds.module_source_id::text  AS module_source_id,
        ds.module_key,
        ds.source_role,
        ds.is_active,
        ds.version_num,
        uf.uploaded_file_id::text   AS uploaded_file_id,
        uf.original_filename,
        uf.size_bytes,
        uf.sha256,
        uf.uploaded_by,
        uf.validation_status,
        ${tsIsoExpr("ds.activated_at")} AS activated_at_iso,
        ${tsIsoExpr("uf.uploaded_at")}  AS uploaded_at_iso
     FROM admin.module_sources ds
     JOIN admin.uploaded_files uf
       ON uf.uploaded_file_id = ds.uploaded_file_id
     WHERE ds.module_key = $1
     ORDER BY
        ds.source_role,
        COALESCE(ds.version_num, 0) DESC,
        ds.activated_at DESC NULLS LAST`,
    [moduleKey],
  );

  const result: Record<string, unknown>[] = [];
  for (const row of res.rows) {
    if (!validRoles.has(row.source_role)) continue;
    result.push({
      module_source_id: row.module_source_id,
      module_key: row.module_key,
      source_role: row.source_role,
      role_label: roleLabels.get(row.source_role) ?? row.source_role,
      is_active: Boolean(row.is_active),
      version_num: row.version_num ?? null,
      uploaded_file_id: row.uploaded_file_id,
      original_filename: row.original_filename || "",
      size_bytes: row.size_bytes === null || row.size_bytes === undefined ? null : Number(row.size_bytes),
      sha256: row.sha256 || "",
      uploaded_by: row.uploaded_by || "",
      validation_status: row.validation_status || "",
      activated_at: row.activated_at_iso === null ? null : pyIso(row.activated_at_iso),
      uploaded_at: row.uploaded_at_iso === null ? null : pyIso(row.uploaded_at_iso),
    });
  }
  return result;
}

// ── _ROLE_JOB_TYPE ──────────────────────────────────────────────────────────

/** Faithful port of `_ROLE_JOB_TYPE` ("module_key|source_role" → job_type). */
export const ROLE_JOB_TYPE = new Map<string, string>([
  ["icd|icd10cm", "icd_import"],
  ["loinc|loinc", "loinc_import"],
  ["drug|drug_index_csv", "drug_index_import"],
  ["ig|ig", "ig_import"],
  ["snomed|snomed_ct", "snomed_import"],
  ["rxnorm|rxnorm_full", "rxnorm_import"],
]);

/** iso-or-empty: null/undefined → "", else `pyIso` (mirrors `.isoformat() if x else ""`). */
function isoOrEmpty(text: string | null | undefined): string {
  return text === null || text === undefined ? "" : pyIso(text);
}

// ── _module_record_counts ─────────────────────────────────────────────────────

/** Run a scalar COUNT, returning 0 on any error (mirrors the per-module try/except). */
async function safeCount(sql: string): Promise<number> {
  try {
    const res = await query<{ c: string }>(sql);
    return Number(res.rows[0]?.c ?? 0);
  } catch {
    return 0;
  }
}

/**
 * Faithful port of `_module_record_counts`. Key insertion order matches Python:
 * icd, loinc, snomed, rxnorm, ig, drug, guideline, health_supplements, food_nutrition.
 */
export async function moduleRecordCounts(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  let icd = 0;
  try {
    const diag = await query<{ c: string }>("SELECT COUNT(*) AS c FROM icd.diagnoses");
    const proc = await query<{ c: string }>("SELECT COUNT(*) AS c FROM icd.procedures");
    icd = Number(diag.rows[0]?.c ?? 0) + Number(proc.rows[0]?.c ?? 0);
  } catch {
    icd = 0;
  }
  counts.icd = icd;
  counts.loinc = await safeCount("SELECT COUNT(*) AS c FROM loinc.concepts");
  counts.snomed = await safeCount("SELECT COUNT(*) AS c FROM snomed.concepts");
  counts.rxnorm = await safeCount("SELECT COUNT(*) AS c FROM rxnorm.concepts");
  counts.ig = await safeCount(
    "SELECT (SELECT COUNT(*) FROM fhir.codesystems) + (SELECT COUNT(*) FROM fhir.artifacts) AS c",
  );
  counts.drug = await safeCount("SELECT COUNT(*) AS c FROM drug.licenses WHERE is_listed");
  counts.guideline = await safeCount("SELECT COUNT(*) AS c FROM guideline.disease_guidelines");
  counts.health_supplements = await safeCount("SELECT COUNT(*) AS c FROM health_supplements.items");
  counts.food_nutrition = await safeCount(
    "SELECT (SELECT COUNT(DISTINCT sample_name) FROM food_nutrition.measurements) + (SELECT COUNT(*) FROM food_nutrition.ingredients) AS c",
  );
  return counts;
}

// ── list_source_catalog ─────────────────────────────────────────────────────

interface UploadedRow {
  uploaded_file_id: string;
  module_key: string;
  source_role: string;
  original_filename: string | null;
  mime_type: string | null;
  size_bytes: string | null;
  sha256: string | null;
  bucket: string | null;
  object_key: string | null;
  minio_uri: string | null;
  uploaded_by: string | null;
  uploaded_at_iso: string | null;
  validation_status: string | null;
  validation_error: string | null;
  module_source_id: string | null;
  is_active: boolean | null;
  activated_at_iso: string | null;
}

const DRUG_IN_PROGRESS = new Set(["queued", "running", "paused"]);
const DRUG_FAILED = new Set([
  "retryable_failed",
  "permanent_failed",
  "stopped",
  "cancelled",
]);

/**
 * Mirror `_uploaded_file_dict` + the activated_at isoformat in
 * `list_source_catalog`: raw column values (null stays null — NOT coerced to ""),
 * `size_bytes` bigint → Number, `uploaded_at`/`activated_at` via `pyIso`.
 * Keys are in the SELECT column order so JSON key order matches `dict(row)`.
 */
function uploadedFileDict(row: UploadedRow): Record<string, unknown> {
  return {
    uploaded_file_id: row.uploaded_file_id,
    module_key: row.module_key,
    source_role: row.source_role,
    original_filename: row.original_filename,
    mime_type: row.mime_type,
    size_bytes: row.size_bytes === null || row.size_bytes === undefined ? null : Number(row.size_bytes),
    sha256: row.sha256,
    bucket: row.bucket,
    object_key: row.object_key,
    minio_uri: row.minio_uri,
    uploaded_by: row.uploaded_by,
    uploaded_at: row.uploaded_at_iso === null ? null : pyIso(row.uploaded_at_iso),
    validation_status: row.validation_status,
    validation_error: row.validation_error,
    module_source_id: row.module_source_id,
    is_active: row.is_active,
    activated_at: row.activated_at_iso === null ? null : pyIso(row.activated_at_iso),
  };
}

/** Faithful port of `list_source_catalog`. */
export async function listSourceCatalog(): Promise<Record<string, unknown>[]> {
  const uploadedRows = (
    await query<UploadedRow>(`
      SELECT
        uf.uploaded_file_id::text AS uploaded_file_id,
        uf.module_key,
        uf.source_role,
        uf.original_filename,
        uf.mime_type,
        uf.size_bytes,
        uf.sha256,
        uf.bucket,
        uf.object_key,
        uf.minio_uri,
        uf.uploaded_by,
        ${tsIsoExpr("uf.uploaded_at")} AS uploaded_at_iso,
        uf.validation_status,
        uf.validation_error,
        ds.module_source_id::text AS module_source_id,
        ds.is_active,
        ${tsIsoExpr("ds.activated_at")} AS activated_at_iso
      FROM admin.uploaded_files uf
      LEFT JOIN admin.module_sources ds
        ON ds.uploaded_file_id = uf.uploaded_file_id
      ORDER BY uf.uploaded_at DESC`)
  ).rows;

  const jobRows = (
    await query<{ job_type: string; updated_at_iso: string | null }>(`
      SELECT DISTINCT ON (job_type)
        job_type, ${tsIsoExpr("updated_at")} AS updated_at_iso
      FROM admin.import_jobs
      WHERE status IN ('success', 'partial_success')
      ORDER BY job_type, updated_at DESC`)
  ).rows;

  const drugImportJobRows = (
    await query<{ uploaded_file_id: string | null; imported_at_iso: string | null }>(`
      SELECT
        source_uploaded_file_id::text AS uploaded_file_id,
        ${tsIsoExpr("MAX(updated_at)")} AS imported_at_iso
      FROM admin.import_jobs
      WHERE job_type = 'drug_index_import'
        AND status IN ('success', 'partial_success')
        AND source_uploaded_file_id IS NOT NULL
      GROUP BY source_uploaded_file_id`)
  ).rows;

  const drugLatestJobRows = (
    await query<{
      uploaded_file_id: string | null;
      job_id: string;
      status: string | null;
      current_step: string | null;
      created_at_iso: string | null;
      updated_at_iso: string | null;
      finished_at_iso: string | null;
      last_error_message: string | null;
    }>(`
      SELECT DISTINCT ON (source_uploaded_file_id)
        source_uploaded_file_id::text AS uploaded_file_id,
        job_id::text                  AS job_id,
        status,
        current_step,
        ${tsIsoExpr("created_at")}  AS created_at_iso,
        ${tsIsoExpr("updated_at")}  AS updated_at_iso,
        ${tsIsoExpr("finished_at")} AS finished_at_iso,
        last_error_message
      FROM admin.import_jobs
      WHERE job_type = 'drug_index_import'
        AND source_uploaded_file_id IS NOT NULL
      ORDER BY source_uploaded_file_id, created_at DESC`)
  ).rows;

  const drugCumulativeTotal = Number(
    (await query<{ c: string }>("SELECT COUNT(*) AS c FROM drug.licenses WHERE is_listed")).rows[0]
      ?.c ?? 0,
  );

  const lastImportByJobType = new Map<string, string>();
  for (const r of jobRows) lastImportByJobType.set(String(r.job_type), isoOrEmpty(r.updated_at_iso));

  const drugImportedByFile = new Map<string, string>();
  for (const r of drugImportJobRows) {
    drugImportedByFile.set(String(r.uploaded_file_id), isoOrEmpty(r.imported_at_iso));
  }

  interface DrugLatest {
    job_id: string;
    status: string | null;
    current_step: string | null;
    created_at: string;
    updated_at: string;
    finished_at: string;
    last_error_message: string | null;
  }
  const drugLatestJobByFile = new Map<string, DrugLatest>();
  for (const r of drugLatestJobRows) {
    drugLatestJobByFile.set(String(r.uploaded_file_id ?? ""), {
      job_id: r.job_id,
      status: r.status,
      current_step: r.current_step,
      created_at: isoOrEmpty(r.created_at_iso),
      updated_at: isoOrEmpty(r.updated_at_iso),
      finished_at: isoOrEmpty(r.finished_at_iso),
      last_error_message: r.last_error_message,
    });
  }

  // Group uploads by (module_key, source_role), preserving uploaded_at DESC order.
  const grouped = new Map<string, Record<string, unknown>[]>();
  for (const row of uploadedRows) {
    const item = uploadedFileDict(row);
    const key = `${String(item.module_key)}|${String(item.source_role)}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(item);
  }

  const entries: Record<string, unknown>[] = [];
  for (const entry of SOURCE_CATALOG) {
    const uploads = grouped.get(`${entry.module_key}|${entry.source_role}`) ?? [];
    const active = uploads.find((item) => item.is_active) ?? null;
    const activeSources = uploads.filter((item) => item.is_active);
    const jobType = ROLE_JOB_TYPE.get(`${entry.module_key}|${entry.source_role}`) ?? "";
    const lastImportedAt = jobType ? (lastImportByJobType.get(jobType) ?? "") : "";

    const isDrug = entry.module_key === "drug";
    if (isDrug) {
      for (const u of uploads) {
        const uploadedFileId = String(u.uploaded_file_id ?? "");
        const importedAt = drugImportedByFile.get(uploadedFileId);
        const latestJob = drugLatestJobByFile.get(uploadedFileId);
        const latestStatus = String(latestJob?.status ?? "");
        const inProgress = DRUG_IN_PROGRESS.has(latestStatus);
        const failed = DRUG_FAILED.has(latestStatus);
        u.imported = importedAt !== undefined;
        u.imported_at = importedAt ?? "";
        u.import_status = importedAt !== undefined
          ? "imported"
          : inProgress
            ? "importing"
            : failed
              ? "failed"
              : "pending";
        u.import_job_id = latestJob?.job_id || "";
        u.import_job_status = latestStatus;
        u.import_current_step = latestJob?.current_step || "";
        u.import_started_at = latestJob?.created_at || "";
        u.import_updated_at = latestJob?.updated_at || "";
        u.import_finished_at = latestJob?.finished_at || "";
        u.import_error = latestJob?.last_error_message || "";
      }
    }

    const entryOut: Record<string, unknown> = {
      module_key: entry.module_key,
      source_role: entry.source_role,
      label: entry.label,
      description: entry.description,
      accepted_extensions: [...entry.accepted_extensions],
      multi_source: entry.multi_source,
      active_source: active,
      active_sources: activeSources,
      recent_uploads: isDrug ? uploads.slice(0, 100) : uploads.slice(0, 10),
      last_imported_at: lastImportedAt,
    };
    if (isDrug) entryOut.cumulative_total = drugCumulativeTotal;
    entries.push(entryOut);
  }
  return entries;
}

// ── Write path: upload / activate / deactivate / delete ──────────────────────
// Faithful port of the mutating pieces of `src/admin_sources.py`.

/** Maps `ValueError` (Python) — caller decides the HTTP status per endpoint. */
export class SourceValueError extends Error {}
/** Maps `RuntimeError` (Python) — surfaced as 503. */
export class SourceRuntimeError extends Error {}

// Magika-compatible label sets per module/role. The Node implementation
// reproduces the legacy accept/reject decisions for these four label sets with
// a magic-byte detector (see `detectContentLabel`). Representative labels keep
// set membership consistent for every role/file combination.
const ZIP_LABELS = ["zip"];
const GZIP_LABELS = ["gzip"];
const XLSX_LABELS = ["xlsx"];
const CSV_LABELS = ["csv", "txt", "tsv"];
const PDF_LABELS = ["pdf"];
const ALLOWED_LABELS = new Map<string, string[]>([
  ["icd/icd10cm", ZIP_LABELS],
  ["icd/icd10pcs", ZIP_LABELS],
  ["icd/icd_zh_tw", XLSX_LABELS],
  ["loinc/loinc", ZIP_LABELS],
  ["loinc/loinc_taiwan_mapping", CSV_LABELS],
  ["loinc/loinc_reference_ranges", CSV_LABELS],
  ["snomed/snomed_ct", ZIP_LABELS],
  ["rxnorm/rxnorm_full", ZIP_LABELS],
  ["ig/ig", GZIP_LABELS],
  ["drug/drug_index_csv", CSV_LABELS],
  ["guideline/guideline_pdf", PDF_LABELS],
]);

const CATALOG_BY_KEY = new Map<string, SourceCatalogEntry>(
  SOURCE_CATALOG.map((e) => [`${e.module_key}/${e.source_role}`, e]),
);

/** Mirror `catalog_entry`. */
export function catalogEntry(moduleKey: string, sourceRole: string): SourceCatalogEntry {
  const entry = CATALOG_BY_KEY.get(`${moduleKey.trim()}/${sourceRole.trim()}`);
  if (entry === undefined) {
    throw new SourceValueError(`Unsupported module source: ${moduleKey}/${sourceRole}`);
  }
  return entry;
}

const SAFE_FILENAME_RE = /[^A-Za-z0-9._-]+/g;

/** Strip leading/trailing chars in `chars` (mirrors Python str.strip(chars)). */
function strip(value: string, chars: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && chars.includes(value[start])) start += 1;
  while (end > start && chars.includes(value[end - 1])) end -= 1;
  return value.slice(start, end);
}

/** Mirror `safe_source_filename`. */
export function safeSourceFilename(filename: string): string {
  const base = (filename || "upload.bin").split("/").pop() ?? "upload.bin";
  const value = base.trim() || "upload.bin";
  let normalized = value.replace(SAFE_FILENAME_RE, "-");
  normalized = strip(normalized, ".-") || "upload.bin";
  return normalized.slice(0, 180);
}

/** Mirror `validate_source_filename`. */
export function validateSourceFilename(filename: string, entry: SourceCatalogEntry): string {
  const safeName = safeSourceFilename(filename);
  const lowered = safeName.toLowerCase();
  if (!entry.accepted_extensions.some((ext) => lowered.endsWith(ext.toLowerCase()))) {
    const accepted = entry.accepted_extensions.join(", ");
    throw new SourceValueError(`File type not allowed for ${entry.source_role}. Accepted: ${accepted}`);
  }
  return safeName;
}

/**
 * Magic-byte content classifier — reproduces Magika's accept/reject for the four
 * label-sets we use. The returned string only needs the SAME set-membership as
 * Magika's real label (sets are disjoint per role).
 */
function detectContentLabel(data: Buffer): string {
  if (data.subarray(0, 5).toString("latin1") === "%PDF-") return "pdf";
  if (data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b) return "gzip";
  // ZIP family: PK\x03\x04 (local), PK\x05\x06 (empty), PK\x07\x08 (spanned).
  if (data.length >= 4 && data[0] === 0x50 && data[1] === 0x4b && (data[2] === 0x03 || data[2] === 0x05 || data[2] === 0x07)) {
    const head = data.subarray(0, Math.min(data.length, 65536)).toString("latin1");
    if (head.includes("xl/")) return "xlsx";
    if (head.includes("word/")) return "docx";
    if (head.includes("ppt/")) return "pptx";
    return "zip";
  }
  // Text vs binary: a NUL byte in the head marks binary content.
  const head = data.subarray(0, Math.min(data.length, 8192));
  if (head.includes(0x00)) return "unknown";
  return "txt"; // csv / txt / tsv are accepted together
}

/** Mirror `validate_source_content` (Magika check; here a magic-byte equivalent). */
export function validateSourceContent(data: Buffer, entry: SourceCatalogEntry): void {
  const allowed = ALLOWED_LABELS.get(`${entry.module_key}/${entry.source_role}`) ?? [];
  const detected = detectContentLabel(data);
  if (!allowed.includes(detected)) {
    const allowedStr = allowed.join(", ");
    throw new SourceValueError(
      `File content type rejected: Magika detected '${detected}' but ${entry.source_role} requires one of ` +
        `[${allowedStr}]. Upload a valid file.`,
    );
  }
}

function sha256Bytes(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function sourceObjectKey(moduleKey: string, sourceRole: string, sha256: string, filename: string): string {
  return `admin-sources/${moduleKey}/${sourceRole}/${sha256}/${safeSourceFilename(filename)}`;
}

const DRUG_CSV_REQUIRED_COLUMNS = ["許可證字號", "中文品名", "英文品名"];

/** Mirror `validate_drug_index_csv` (UTF-8 CSV with required columns + ≥1 data row). */
export function validateDrugIndexCsv(data: Buffer): void {
  // utf-8-sig: strip a leading BOM if present.
  let text = data.toString("utf-8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = parseCsv(text);
  if (rows.length === 0) {
    throw new SourceValueError("CSV is empty — no header row found.");
  }
  const header = rows[0].map((h) => h.trim());
  const missing = DRUG_CSV_REQUIRED_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length > 0) {
    throw new SourceValueError(
      "CSV is missing required column(s): " +
        missing.join(", ") +
        ". Expected the Taiwan FDA drug index columns (許可證字號, 中文品名, 英文品名).",
    );
  }
  const licenseIdx = header.indexOf("許可證字號");
  let hasData = false;
  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i];
    if (row.length > licenseIdx && row[licenseIdx].trim()) {
      hasData = true;
      break;
    }
  }
  if (!hasData) {
    throw new SourceValueError("CSV has no data rows with a 許可證字號 value.");
  }
}

/** Minimal RFC4180 CSV parser (quoted fields, "" escape, CRLF) — for header/row scan. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;
  let started = false;
  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
    started = false;
  };
  while (i < text.length) {
    const ch = text[i];
    started = true;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      pushField();
      i += 1;
      continue;
    }
    if (ch === "\r") {
      if (text[i + 1] === "\n") i += 1;
      pushRow();
      i += 1;
      continue;
    }
    if (ch === "\n") {
      pushRow();
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (started || field.length > 0 || row.length > 0) pushRow();
  return rows;
}

/** Validate a canonical UUID; mirror `uuid.UUID(...)` raising on malformed input. */
function parseUuid(value: string): string {
  if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value)) {
    throw new SourceValueError("badly formed hexadecimal UUID string");
  }
  return value;
}

/** Mirror `_next_version_num` (MAX(version_num)+1, ≥1). */
async function nextVersionNum(
  client: { query: (sql: string, params: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
  moduleKey: string,
  sourceRole: string,
): Promise<number> {
  const res = await client.query(
    `SELECT COALESCE(MAX(version_num), 0) + 1 AS v
       FROM admin.module_sources WHERE module_key = $1 AND source_role = $2`,
    [moduleKey, sourceRole],
  );
  return Number(res.rows[0]?.v ?? 1) || 1;
}

// Columns of admin.uploaded_files joined with module_sources for the dedup SELECT.
const DEDUP_SELECT = `
  uf.uploaded_file_id::text AS uploaded_file_id,
  uf.module_key,
  uf.source_role,
  uf.original_filename,
  uf.mime_type,
  uf.size_bytes,
  uf.sha256,
  uf.bucket,
  uf.object_key,
  uf.minio_uri,
  uf.uploaded_by,
  ${tsIsoExpr("uf.uploaded_at")} AS uploaded_at_iso,
  uf.validation_status,
  uf.validation_error,
  ds.module_source_id::text AS module_source_id,
  ds.is_active,
  ${tsIsoExpr("ds.activated_at")} AS activated_at_iso`;

/** Faithful port of `create_uploaded_source`. */
export async function createUploadedSource(opts: {
  moduleKey: string;
  sourceRole: string;
  originalFilename: string;
  mimeType: string;
  data: Buffer;
  uploadedBy: string;
  autoActivate: boolean;
}): Promise<{ duplicate: boolean; uploaded_file: Record<string, unknown> }> {
  const entry = catalogEntry(opts.moduleKey, opts.sourceRole);
  const filename = validateSourceFilename(opts.originalFilename, entry);
  const digest = sha256Bytes(opts.data);
  const mime = opts.mimeType || "application/octet-stream";

  if (entry.module_key === "drug") validateDrugIndexCsv(opts.data);

  // Drug index is cumulative: refuse a CSV whose bytes were already imported.
  if (entry.module_key === "drug") {
    const r = await query(
      `SELECT 1 FROM admin.import_jobs j
         JOIN admin.uploaded_files uf ON uf.uploaded_file_id = j.source_uploaded_file_id
        WHERE uf.module_key = 'drug' AND uf.sha256 = $1
          AND j.job_type = 'drug_index_import'
          AND j.status IN ('success', 'partial_success') LIMIT 1`,
      [digest],
    );
    if (r.rows.length > 0) {
      throw new SourceValueError("This file has already been imported into the drug index.");
    }
  }

  const existingRes = await query<UploadedRow>(
    `SELECT ${DEDUP_SELECT}
       FROM admin.uploaded_files uf
       LEFT JOIN admin.module_sources ds ON ds.uploaded_file_id = uf.uploaded_file_id
      WHERE uf.module_key = $1 AND uf.source_role = $2 AND uf.sha256 = $3 LIMIT 1`,
    [entry.module_key, entry.source_role, digest],
  );

  if (existingRes.rows.length > 0) {
    let existing = existingRes.rows[0];
    const uploadedFileId = String(existing.uploaded_file_id);
    if (opts.autoActivate) {
      const now = new Date();
      await withTransaction(async (client) => {
        if (!entry.multi_source) {
          await client.query(
            `UPDATE admin.module_sources SET is_active = FALSE
              WHERE module_key = $1 AND source_role = $2 AND uploaded_file_id <> $3`,
            [entry.module_key, entry.source_role, uploadedFileId],
          );
        }
        const nextVer = await nextVersionNum(client, entry.module_key, entry.source_role);
        if (existing.module_source_id) {
          await client.query(
            `UPDATE admin.module_sources
                SET is_active = TRUE, activated_at = $2, version_num = $3
              WHERE uploaded_file_id = $1`,
            [uploadedFileId, now, nextVer],
          );
        } else {
          await client.query(
            `INSERT INTO admin.module_sources
               (module_source_id, module_key, source_role, uploaded_file_id, is_active, activated_at, version_num, notes)
             VALUES ($1, $2, $3, $4, TRUE, $5, $6, '{}'::jsonb)`,
            [randomUUID(), entry.module_key, entry.source_role, uploadedFileId, now, nextVer],
          );
        }
        await client.query(
          `INSERT INTO admin.admin_audit_log (admin_user, action, target_type, target_id, payload_json)
           VALUES ($1, 'activate_duplicate_source', 'uploaded_file', $2, $3::jsonb)`,
          [
            opts.uploadedBy,
            uploadedFileId,
            JSON.stringify({
              module_key: entry.module_key,
              source_role: entry.source_role,
              original_filename: filename,
            }),
          ],
        );
      });
      const reread = await query<UploadedRow>(
        `SELECT ${DEDUP_SELECT}
           FROM admin.uploaded_files uf
           LEFT JOIN admin.module_sources ds ON ds.uploaded_file_id = uf.uploaded_file_id
          WHERE uf.uploaded_file_id = $1 LIMIT 1`,
        [uploadedFileId],
      );
      existing = reread.rows[0];
    }
    return { duplicate: true, uploaded_file: uploadedFileDict(existing) };
  }

  if (!minioService.enabled()) {
    throw new SourceRuntimeError("MinIO is required for admin source uploads");
  }

  const objectKey = sourceObjectKey(entry.module_key, entry.source_role, digest, filename);
  const locator = await minioService.uploadBytes({ objectKey, data: opts.data, contentType: mime });

  const uploadedFileId = randomUUID();
  const moduleSourceId = randomUUID();
  const now = new Date();

  const inserted = await withTransaction(async (client) => {
    const ins = await client.query(
      `INSERT INTO admin.uploaded_files
         (uploaded_file_id, module_key, source_role, original_filename, mime_type, size_bytes, sha256,
          bucket, object_key, minio_uri, uploaded_by, uploaded_at, validation_status, validation_error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'accepted', '')
       RETURNING uploaded_file_id::text AS uploaded_file_id, module_key, source_role, original_filename,
                 mime_type, size_bytes, sha256, bucket, object_key, minio_uri, uploaded_by,
                 ${tsIsoExpr("uploaded_at")} AS uploaded_at_iso, validation_status, validation_error`,
      [
        uploadedFileId,
        entry.module_key,
        entry.source_role,
        filename,
        mime,
        opts.data.length,
        digest,
        locator.bucket,
        locator.object_key,
        locator.minio_uri,
        opts.uploadedBy,
        now,
      ],
    );
    // Single-source roles: clear the prior active row before inserting the new one.
    if (opts.autoActivate && !entry.multi_source) {
      await client.query(
        `UPDATE admin.module_sources SET is_active = FALSE WHERE module_key = $1 AND source_role = $2`,
        [entry.module_key, entry.source_role],
      );
    }
    const nextVer = opts.autoActivate ? await nextVersionNum(client, entry.module_key, entry.source_role) : null;
    await client.query(
      `INSERT INTO admin.module_sources
         (module_source_id, module_key, source_role, uploaded_file_id, is_active, activated_at, version_num, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, '{}'::jsonb)`,
      [
        moduleSourceId,
        entry.module_key,
        entry.source_role,
        uploadedFileId,
        opts.autoActivate,
        opts.autoActivate ? now : null,
        nextVer,
      ],
    );
    await client.query(
      `INSERT INTO admin.admin_audit_log (admin_user, action, target_type, target_id, payload_json)
       VALUES ($1, 'upload_source', 'uploaded_file', $2, $3::jsonb)`,
      [
        opts.uploadedBy,
        uploadedFileId,
        JSON.stringify({
          module_key: entry.module_key,
          source_role: entry.source_role,
          original_filename: filename,
          auto_activate: opts.autoActivate,
        }),
      ],
    );
    return { row: ins.rows[0] as UploadedRow | undefined, nextVer };
  });

  if (!inserted.row) throw new SourceRuntimeError("Failed to persist uploaded source");
  const row = inserted.row;
  // Build the dict in Python's key order: 14 uploaded_files cols, then the four
  // appended keys (module_source_id, is_active, activated_at, version_num).
  const item: Record<string, unknown> = {
    uploaded_file_id: row.uploaded_file_id,
    module_key: row.module_key,
    source_role: row.source_role,
    original_filename: row.original_filename,
    mime_type: row.mime_type,
    size_bytes: row.size_bytes === null || row.size_bytes === undefined ? null : Number(row.size_bytes),
    sha256: row.sha256,
    bucket: row.bucket,
    object_key: row.object_key,
    minio_uri: row.minio_uri,
    uploaded_by: row.uploaded_by,
    uploaded_at: row.uploaded_at_iso === null ? null : pyIso(row.uploaded_at_iso),
    validation_status: row.validation_status,
    validation_error: row.validation_error,
    module_source_id: moduleSourceId,
    is_active: opts.autoActivate,
    activated_at: opts.autoActivate ? pyIsoFromDate(now) : "",
    version_num: inserted.nextVer,
  };
  return { duplicate: false, uploaded_file: item };
}

/** Render a JS Date as a Python `datetime.isoformat()` UTC string (microseconds). */
function pyIsoFromDate(d: Date): string {
  // JS Date has millisecond precision; pad to 6 fractional digits like isoformat.
  const iso = d.toISOString(); // YYYY-MM-DDTHH:MM:SS.sssZ
  return iso.replace(/\.(\d{3})Z$/, ".$1000+00:00");
}

/** Faithful port of `activate_source`. */
export async function activateSource(uploadedFileId: string, activatedBy: string): Promise<Record<string, unknown>> {
  const targetUuid = parseUuid(uploadedFileId);
  const now = new Date();
  return withTransaction(async (client) => {
    const target = await client.query<{ module_key: string; source_role: string }>(
      `SELECT module_key, source_role FROM admin.uploaded_files WHERE uploaded_file_id = $1`,
      [targetUuid],
    );
    if (target.rows.length === 0) throw new SourceValueError("Uploaded source not found");
    const moduleKey = target.rows[0].module_key;
    const sourceRole = target.rows[0].source_role;
    const entry = CATALOG_BY_KEY.get(`${moduleKey}/${sourceRole}`);
    const isMulti = entry ? entry.multi_source : false;
    if (!isMulti) {
      await client.query(
        `UPDATE admin.module_sources SET is_active = FALSE WHERE module_key = $1 AND source_role = $2`,
        [moduleKey, sourceRole],
      );
    }
    const nextVer = await nextVersionNum(client, moduleKey, sourceRole);
    const upd = await client.query<Record<string, unknown>>(
      `UPDATE admin.module_sources
          SET is_active = TRUE, activated_at = $2, version_num = $3
        WHERE uploaded_file_id = $1
        RETURNING module_source_id::text AS module_source_id, module_key, source_role,
                  uploaded_file_id::text AS uploaded_file_id, is_active,
                  ${tsIsoExpr("activated_at")} AS activated_at_iso, version_num`,
      [targetUuid, now, nextVer],
    );
    if (upd.rows.length === 0) throw new SourceRuntimeError("Module source row not found for uploaded file");
    const row = upd.rows[0];
    await client.query(
      `INSERT INTO admin.admin_audit_log (admin_user, action, target_type, target_id, payload_json)
       VALUES ($1, 'activate_source', 'uploaded_file', $2, $3::jsonb)`,
      [activatedBy, uploadedFileId, JSON.stringify({ module_key: moduleKey, source_role: sourceRole })],
    );
    return {
      module_source_id: row.module_source_id,
      module_key: row.module_key,
      source_role: row.source_role,
      uploaded_file_id: row.uploaded_file_id,
      is_active: row.is_active,
      activated_at: row.activated_at_iso === null ? null : pyIso(row.activated_at_iso as string),
      version_num: row.version_num === null || row.version_num === undefined ? null : Number(row.version_num),
    };
  });
}

/** Faithful port of `deactivate_source`. */
export async function deactivateSource(uploadedFileId: string, deactivatedBy: string): Promise<Record<string, unknown>> {
  const targetUuid = parseUuid(uploadedFileId);
  return withTransaction(async (client) => {
    const upd = await client.query<Record<string, unknown>>(
      `UPDATE admin.module_sources SET is_active = FALSE
        WHERE uploaded_file_id = $1
        RETURNING module_source_id::text AS module_source_id, module_key, source_role,
                  uploaded_file_id::text AS uploaded_file_id, is_active`,
      [targetUuid],
    );
    if (upd.rows.length === 0) throw new SourceValueError("Module source not found for uploaded file");
    const row = upd.rows[0];
    await client.query(
      `INSERT INTO admin.admin_audit_log (admin_user, action, target_type, target_id, payload_json)
       VALUES ($1, 'deactivate_source', 'uploaded_file', $2, $3::jsonb)`,
      [deactivatedBy, uploadedFileId, JSON.stringify({ module_key: row.module_key, source_role: row.source_role })],
    );
    return {
      module_source_id: row.module_source_id,
      module_key: row.module_key,
      source_role: row.source_role,
      uploaded_file_id: row.uploaded_file_id,
      is_active: row.is_active,
    };
  });
}

/** Faithful port of `delete_uploaded_source`. */
export async function deleteUploadedSource(uploadedFileId: string, deletedBy: string): Promise<Record<string, unknown>> {
  const targetUuid = parseUuid(uploadedFileId);
  const fileRow = await query<{
    uploaded_file_id: string;
    module_key: string;
    source_role: string;
    original_filename: string;
    object_key: string | null;
  }>(
    `SELECT uploaded_file_id::text AS uploaded_file_id, module_key, source_role, original_filename, object_key
       FROM admin.uploaded_files WHERE uploaded_file_id = $1`,
    [targetUuid],
  );
  if (fileRow.rows.length === 0) throw new SourceValueError("Uploaded file not found");
  const row = fileRow.rows[0];

  if (row.module_key === "drug") {
    const importing = await query(
      `SELECT 1 FROM admin.import_jobs
        WHERE job_type = 'drug_index_import' AND source_uploaded_file_id = $1
          AND status IN ('queued', 'running', 'paused') LIMIT 1`,
      [targetUuid],
    );
    if (importing.rows.length > 0) {
      throw new SourceValueError("Cannot delete: this file is already queued or importing.");
    }
    const imported = await query(
      `SELECT 1 FROM admin.import_jobs
        WHERE job_type = 'drug_index_import' AND status IN ('success', 'partial_success')
          AND source_uploaded_file_id = $1 LIMIT 1`,
      [targetUuid],
    );
    if (imported.rows.length > 0) {
      throw new SourceValueError("Cannot delete: this file has already been imported into the drug index.");
    }
  } else {
    let allowPendingModuleDelete = false;
    if (row.module_key === "icd") {
      const c = await query<{ n: string }>(
        `SELECT (SELECT COUNT(*) FROM icd.diagnoses) + (SELECT COUNT(*) FROM icd.procedures) AS n`,
      );
      allowPendingModuleDelete = Number(c.rows[0]?.n ?? 0) === 0;
    } else if (row.module_key === "loinc") {
      const c = await query<{ n: string }>(`SELECT COUNT(*) AS n FROM loinc.concepts`);
      allowPendingModuleDelete = Number(c.rows[0]?.n ?? 0) === 0;
    } else if (row.module_key === "snomed") {
      const c = await query<{ n: string }>(`SELECT COUNT(*) AS n FROM snomed.concepts`);
      allowPendingModuleDelete = Number(c.rows[0]?.n ?? 0) === 0;
    } else if (row.module_key === "ig") {
      const c = await query<{ n: string }>(
        `SELECT (SELECT COUNT(*) FROM fhir.codesystems) + (SELECT COUNT(*) FROM fhir.artifacts) AS n`,
      );
      allowPendingModuleDelete = Number(c.rows[0]?.n ?? 0) === 0;
    }
    if (!allowPendingModuleDelete) {
      const imported = await query(
        `SELECT 1 FROM admin.module_sources WHERE uploaded_file_id = $1 AND activated_at IS NOT NULL LIMIT 1`,
        [targetUuid],
      );
      if (imported.rows.length > 0) {
        throw new SourceValueError("Cannot delete: this file has already been imported.");
      }
    }
  }

  await withTransaction(async (client) => {
    await client.query(`DELETE FROM admin.uploaded_files WHERE uploaded_file_id = $1`, [targetUuid]);
    await client.query(
      `INSERT INTO admin.admin_audit_log (admin_user, action, target_type, target_id, payload_json)
       VALUES ($1, 'delete_source', 'uploaded_file', $2, $3::jsonb)`,
      [
        deletedBy,
        uploadedFileId,
        JSON.stringify({
          module_key: row.module_key,
          source_role: row.source_role,
          original_filename: row.original_filename,
        }),
      ],
    );
  });

  const objectKey = row.object_key || "";
  if (objectKey) {
    try {
      await minioService.removeObject(objectKey);
    } catch {
      /* best-effort */
    }
  }
  return { uploaded_file_id: uploadedFileId, module_key: row.module_key };
}
