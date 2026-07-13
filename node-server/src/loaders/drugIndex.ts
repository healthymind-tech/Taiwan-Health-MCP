/**
 * Loader for the Taiwan FDA drug index CSV (36_2.csv).
 *
 * Node port of `loader/loaders/drug_index_loader.py`. It:
 *   1. snapshots the source file metadata
 *   2. upserts the relational projection tables
 *   3. stores canonical normalized records in JSONB
 *   4. enqueues changed licenses for the enrichment phase
 *
 * Run standalone:  node dist/loaders/drugIndex.js <path-to-36_2.csv>
 * (requires DATABASE_URL pointing directly at Postgres, bypassing pgBouncer.)
 */

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { logInfo } from "../logger.js";
import {
  INDEX_LICENSE,
  buildIndexOnlyRecord,
  isActiveIndexRow,
  normalizeLicenseToken,
  type Dict,
  type IndexRow,
} from "./drugRecordBuilder.js";

const PARAM_LIMIT = 60000;

export interface DrugIndexSummary {
  source_file: string;
  source_sha256: string;
  row_count: number;
  duplicates_overwritten: number;
  new_licenses: number;
  changed_licenses: number;
  relisted_licenses: number;
  removed_licenses: number;
  queued_for_enrichment: number;
}

/**
 * RFC 4180 CSV reader, returning the header row plus each record's raw cells.
 * Quoted fields may contain commas, doubled quotes and newlines.
 *
 * Fields are cut out with `slice` rather than accumulated character by character:
 * this file is ~44 MB, and one cons-string per character is what pushed the import
 * over Node's heap limit.
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let i = 0;
  const len = text.length;

  while (i < len) {
    let field: string;

    if (text[i] === '"') {
      i += 1;
      const start = i;
      let parts: string[] | null = null; // only allocated when "" needs unescaping
      for (;;) {
        const quote = text.indexOf('"', i);
        if (quote === -1) {
          // Unterminated quote: take the rest of the file as the field.
          const tail = text.slice(i);
          field = parts ? parts.join("") + tail : tail;
          i = len;
          break;
        }
        if (text[quote + 1] === '"') {
          parts ??= [];
          parts.push(text.slice(i === start ? start : i, quote), '"');
          i = quote + 2;
          continue;
        }
        const last = text.slice(i === start ? start : i, quote);
        field = parts ? parts.join("") + last : last;
        i = quote + 1;
        break;
      }
    } else {
      let end = i;
      while (end < len) {
        const ch = text[end];
        if (ch === "," || ch === "\n" || ch === "\r") break;
        end += 1;
      }
      field = text.slice(i, end);
      i = end;
    }

    row.push(field);

    if (i >= len) break;
    const ch = text[i];
    if (ch === ",") {
      i += 1;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      i += 1;
      rows.push(row);
      row = [];
    }
  }

  // A trailing newline must not yield a phantom record, but an unterminated last
  // line must still be kept.
  if (row.length > 1 || (row.length === 1 && row[0] !== "")) rows.push(row);
  return rows;
}

/**
 * Python `csv.DictReader` plus the loader's normalization, exactly: cells are
 * stripped, and a short row leaves its trailing keys *absent* (DictReader fills
 * them with None, which the loader's isinstance(str) filter then drops) rather
 * than present-and-empty — a distinction the row hash is sensitive to.
 */
function loadIndexRows(csvText: string): { rows: Map<string, IndexRow>; duplicates: number } {
  const records = parseCsv(csvText.replace(/^﻿/, "")); // utf-8-sig
  const rows = new Map<string, IndexRow>();
  let duplicates = 0;
  if (records.length === 0) return { rows, duplicates };

  const header = records[0];
  for (const cells of records.slice(1)) {
    const normalized: IndexRow = {};
    header.forEach((key, idx) => {
      if (idx < cells.length) normalized[key] = (cells[idx] ?? "").trim();
    });
    const licenseId = normalized[INDEX_LICENSE] ?? "";
    if (!licenseId) continue;
    if (rows.has(licenseId)) duplicates += 1;
    rows.set(licenseId, normalized);
  }
  return { rows, duplicates };
}

/** Python `json.dumps(row, ensure_ascii=False, sort_keys=True, separators=(",", ":"))`. */
function canonicalRowJson(row: IndexRow): string {
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(row).sort()) sorted[key] = row[key];
  return JSON.stringify(sorted);
}

function rowHash(row: IndexRow): string {
  return createHash("sha256").update(canonicalRowJson(row), "utf8").digest("hex");
}

/**
 * Python `datetime.strptime(value, "%Y/%m/%d").date()` — strict format, but a
 * short year is accepted (`106/12/22` is year 106, not 2017). Returned as the
 * `YYYY-MM-DD` string Postgres casts into a `date`.
 */
function parseIndexDate(value: string): string | null {
  const text = (value || "").trim();
  if (!text) return null;
  const match = /^(\d{1,4})\/(\d{1,2})\/(\d{1,2})$/.exec(text);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  // strptime raises on an out-of-range month/day; JS would silently roll over.
  const probe = new Date(Date.UTC(2000, month - 1, day));
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  const pad = (n: number, width: number): string => String(n).padStart(width, "0");
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

function queueReason(
  licenseId: string,
  existingHashes: Map<string, string>,
  existingListed: Map<string, boolean>,
  newHash: string,
): string | null {
  if (!existingHashes.has(licenseId)) return "new_index_entry";
  if (!(existingListed.get(licenseId) ?? true)) return "relisted_index_entry";
  if (existingHashes.get(licenseId) !== newHash) return "index_row_changed";
  return null;
}

/** Multi-row INSERT, chunked to stay under Postgres' bind-parameter limit. */
async function batchInsert(
  client: pg.PoolClient,
  head: string,
  tail: string,
  casts: (string | null)[],
  rows: unknown[][],
): Promise<void> {
  const ncols = casts.length;
  const chunk = Math.max(1, Math.floor(PARAM_LIMIT / ncols));
  for (let i = 0; i < rows.length; i += chunk) {
    const slice = rows.slice(i, i + chunk);
    const values: string[] = [];
    const params: unknown[] = [];
    slice.forEach((record, ri) => {
      const placeholders = casts.map(
        (cast, ci) => `$${ri * ncols + ci + 1}${cast ? `::${cast}` : ""}`,
      );
      values.push(`(${placeholders.join(",")})`);
      params.push(...record);
    });
    await client.query(`${head} VALUES ${values.join(",")} ${tail}`, params);
  }
}

const LICENSE_COLUMNS = [
  "license_id",
  "snapshot_id",
  "row_hash",
  "license_token",
  "is_active",
  "is_listed",
  "cancellation_status",
  "cancellation_date",
  "cancellation_reason",
  "valid_until",
  "issue_date",
  "last_changed_date",
  "license_type",
  "old_license_no",
  "customs_clearance_no",
  "chinese_name",
  "english_name",
  "drug_category",
  "controlled_drug_level",
  "dosage_form",
  "package",
  "indications_text",
  "main_ingredient_summary",
  "applicant_name",
  "applicant_address",
  "applicant_tax_id",
  "manufacturer_name",
  "manufacturer_factory_address",
  "manufacturer_company_address",
  "manufacturer_country",
  "manufacturing_process",
  "usage_text_from_index",
  "barcode_text",
  "raw_index_json",
  "created_at",
  "updated_at",
] as const;

const LICENSE_UPDATE_COLUMNS = LICENSE_COLUMNS.filter(
  (col) => col !== "license_id" && col !== "created_at",
);

export async function loadDrugIndex(pool: pg.Pool, indexCsvPath: string): Promise<DrugIndexSummary> {
  if (!fs.existsSync(indexCsvPath) || !fs.statSync(indexCsvPath).isFile()) {
    throw new Error(`Drug index CSV not found: ${indexCsvPath}`);
  }

  logInfo(`Loading Taiwan FDA drug index from ${indexCsvPath} ...`);
  const fileBuffer = fs.readFileSync(indexCsvPath);
  const { rows: rowsByLicense, duplicates } = loadIndexRows(fileBuffer.toString("utf8"));
  if (rowsByLicense.size === 0) {
    throw new Error(`Drug index CSV is empty: ${indexCsvPath}`);
  }

  const fileSha256 = createHash("sha256").update(fileBuffer).digest("hex");
  const snapshotId = randomUUID();
  const runId = randomUUID();
  const now = new Date();

  const client = await pool.connect();
  try {
    const existing = await client.query<{
      license_id: string;
      row_hash: string | null;
      is_listed: boolean | null;
    }>("SELECT license_id, row_hash, is_listed FROM drug.licenses");
    const existingHashes = new Map<string, string>();
    const existingListed = new Map<string, boolean>();
    for (const row of existing.rows) {
      existingHashes.set(row.license_id, row.row_hash ?? "");
      existingListed.set(row.license_id, Boolean(row.is_listed));
    }

    const existingState = await client.query<{ license_id: string; index_status: string | null }>(
      "SELECT license_id, index_status FROM drug.import_license_state",
    );
    const previousIndexStatus = new Map<string, string>();
    for (const row of existingState.rows) {
      previousIndexStatus.set(row.license_id, row.index_status ?? "pending");
    }

    // Cumulative model: each CSV is an additive batch (union + dedup). Licenses
    // absent from this file are NOT treated as removed — importing a partial file
    // must never un-list drugs added by earlier files. Per-row cancellation (註銷)
    // is still derived from each CSV row via isActiveIndexRow.
    const removedLicenseIds: string[] = [];

    // Pass 1 — decide what changed. Only the hash and the reason are kept per
    // license; the heavy per-license records are built in the chunked pass below
    // and released after each write. Holding all ~66k of them at once (as the
    // Python does, where a row costs far less) exhausts Node's heap.
    const sortedIds = [...rowsByLicense.keys()].sort();
    const hashes = new Map<string, string>();
    const reasons = new Map<string, string>();

    let changedCount = 0;
    let newCount = 0;
    let relistedCount = 0;
    let queuedCount = 0;

    for (const licenseId of sortedIds) {
      const row = rowsByLicense.get(licenseId) as IndexRow;
      const hash = rowHash(row);
      hashes.set(licenseId, hash);

      const reason = queueReason(licenseId, existingHashes, existingListed, hash);
      if (reason === null) continue;
      reasons.set(licenseId, reason);

      if (reason === "new_index_entry") newCount += 1;
      else if (reason === "relisted_index_entry") relistedCount += 1;
      else if (reason === "index_row_changed") changedCount += 1;

      // Only active licenses are enqueued. The enrichment worker claims with
      // `AND l.is_active`, so a pending queue row for an inactive (已註銷) license
      // could never be drained and would sit 'pending' forever. Their state change
      // is still recorded as an index_load event.
      if (isActiveIndexRow(row)) queuedCount += 1;
    }

    /** Build every table's rows for one slice of licenses. */
    const buildChunk = (
      licenseIds: string[],
    ): {
      licenseRows: unknown[][];
      ingredientRows: unknown[][];
      normalizedRows: unknown[][];
      stateRows: unknown[][];
      queueRows: unknown[][];
      eventRows: unknown[][];
    } => {
      const licenseRows: unknown[][] = [];
      const ingredientRows: unknown[][] = [];
      const normalizedRows: unknown[][] = [];
      const stateRows: unknown[][] = [];
      const queueRows: unknown[][] = [];
      const eventRows: unknown[][] = [];

      for (const licenseId of licenseIds) {
        const row = rowsByLicense.get(licenseId) as IndexRow;
        const hash = hashes.get(licenseId) as string;
        const isActive = isActiveIndexRow(row);
        const record = buildIndexOnlyRecord(row, now);
        const recordJson = JSON.stringify(record);
        const rawRowJson = canonicalRowJson(row);
        const reason = reasons.get(licenseId) ?? null;

        if (reason !== null) {
          if (isActive) {
            queueRows.push([licenseId, reason, 100, "pending", now, null, null, 0, ""]);
          }
          eventRows.push([
            runId,
            licenseId,
            "index_load",
            previousIndexStatus.get(licenseId) ?? "pending",
            "success",
            "",
            "",
            JSON.stringify({ reason }),
            now,
          ]);
        }

        licenseRows.push([
        licenseId,
        snapshotId,
        hash,
        normalizeLicenseToken(licenseId),
        isActive,
        true,
        row["註銷狀態"] ?? "",
        parseIndexDate(row["註銷日期"] ?? ""),
        row["註銷理由"] ?? "",
        parseIndexDate(row["有效日期"] ?? ""),
        parseIndexDate(row["發證日期"] ?? ""),
        parseIndexDate(row["異動日期"] ?? ""),
        row["許可證種類"] ?? "",
        row["舊證字號"] ?? "",
        row["通關簽審文件編號"] ?? "",
        row["中文品名"] ?? "",
        row["英文品名"] ?? "",
        row["藥品類別"] ?? "",
        row["管制藥品分類級別"] ?? "",
        row["劑型"] ?? "",
        row["包裝"] ?? "",
        row["適應症"] ?? "",
        row["主成分略述"] ?? "",
        row["申請商名稱"] ?? "",
        row["申請商地址"] ?? "",
        row["申請商統一編號"] ?? "",
        row["製造商名稱"] ?? "",
        row["製造廠廠址"] ?? "",
        row["製造廠公司地址"] ?? "",
        row["製造廠國別"] ?? "",
        row["製程"] ?? "",
        row["用法用量"] ?? "",
        row["包裝與國際條碼"] ?? "",
        rawRowJson,
        now,
        now,
      ]);

      const ingredients = (record.ingredients as Dict).active as Record<string, string>[];
      ingredients.forEach((ingredient, index) => {
        ingredientRows.push([
          licenseId,
          ingredient.name ?? "",
          ingredient.amount ?? "",
          ingredient.unit ?? "",
          ingredient.raw_text ?? "",
          "index_summary",
          index + 1,
          JSON.stringify({ raw_summary: row["主成分略述"] ?? "" }),
        ]);
      });

      const source = record.source as Dict;
      const quality = record.quality as Dict;
      normalizedRows.push([
        licenseId,
        recordJson,
        source.primary_insert_source,
        quality.confidence,
        JSON.stringify(quality.missing_fields),
        JSON.stringify(quality.conflict_fields),
        JSON.stringify(source.errors),
        now,
      ]);

      const downstreamInitialStatus = isActive ? "pending" : "no_data";
      stateRows.push([
        licenseId,
        runId,
        "success",
        downstreamInitialStatus,
        downstreamInitialStatus,
        downstreamInitialStatus,
        downstreamInitialStatus,
        downstreamInitialStatus,
        downstreamInitialStatus,
        downstreamInitialStatus,
        "success",
        null,
        0,
        "",
        "",
        now,
      ]);
    }

      return { licenseRows, ingredientRows, normalizedRows, stateRows, queueRows, eventRows };
    };

    const summary: DrugIndexSummary = {
      source_file: indexCsvPath,
      source_sha256: fileSha256,
      row_count: rowsByLicense.size,
      duplicates_overwritten: duplicates,
      new_licenses: newCount,
      changed_licenses: changedCount,
      relisted_licenses: relistedCount,
      removed_licenses: removedLicenseIds.length,
      queued_for_enrichment: queuedCount,
    };

    await client.query("BEGIN");
    try {
      await client.query(
        `INSERT INTO drug.import_runs (
           run_id, run_type, trigger_type, status, started_at, finished_at, summary_json
         )
         VALUES ($1, 'index_full', 'manual', 'success', $2, $2, $3::jsonb)`,
        [runId, now, JSON.stringify(summary)],
      );
      await client.query(
        `INSERT INTO drug.index_snapshots (
           snapshot_id, source_filename, source_sha256, row_count, loaded_at, status, notes
         )
         VALUES ($1, $2, $3, $4, $5, 'success', $6::jsonb)`,
        [
          snapshotId,
          path.basename(indexCsvPath),
          fileSha256,
          rowsByLicense.size,
          now,
          JSON.stringify({
            path: indexCsvPath,
            new_licenses: newCount,
            changed_licenses: changedCount,
            relisted_licenses: relistedCount,
            duplicates_overwritten: duplicates,
          }),
        ],
      );

      const currentIds = sortedIds;
      if (currentIds.length > 0) {
        await client.query("DELETE FROM drug.ingredients WHERE license_id = ANY($1::text[])", [
          currentIds,
        ]);
        await client.query("DELETE FROM drug.atc WHERE license_id = ANY($1::text[])", [currentIds]);
      }

      // Build and write one slice at a time. Everything still lands in this single
      // transaction, so the import stays all-or-nothing; only the JS-side memory is
      // bounded.
      const BUILD_CHUNK = 2000;
      for (let offset = 0; offset < sortedIds.length; offset += BUILD_CHUNK) {
        const chunk = buildChunk(sortedIds.slice(offset, offset + BUILD_CHUNK));

        await batchInsert(
          client,
          `INSERT INTO drug.licenses (${LICENSE_COLUMNS.join(", ")})`,
          `ON CONFLICT (license_id) DO UPDATE SET ${LICENSE_UPDATE_COLUMNS.map(
            (col) => `${col} = EXCLUDED.${col}`,
          ).join(", ")}`,
          LICENSE_COLUMNS.map((col) => (col === "raw_index_json" ? "jsonb" : null)),
          chunk.licenseRows,
        );

        await batchInsert(
          client,
          `INSERT INTO drug.ingredients (
             license_id, name, amount, unit, raw_text, source, sort_order, raw_json
           )`,
          "",
          [null, null, null, null, null, null, null, "jsonb"],
          chunk.ingredientRows,
        );

        await batchInsert(
          client,
          `INSERT INTO drug.normalized_records (
             license_id, normalized_json, primary_insert_source,
             quality_confidence, missing_fields, conflict_fields,
             source_errors, normalized_at
           )`,
          `ON CONFLICT (license_id) DO UPDATE SET
             normalized_json = EXCLUDED.normalized_json,
             primary_insert_source = EXCLUDED.primary_insert_source,
             quality_confidence = EXCLUDED.quality_confidence,
             missing_fields = EXCLUDED.missing_fields,
             conflict_fields = EXCLUDED.conflict_fields,
             source_errors = EXCLUDED.source_errors,
             normalized_at = EXCLUDED.normalized_at`,
          [null, "jsonb", null, null, "jsonb", "jsonb", "jsonb", null],
          chunk.normalizedRows,
        );

        await writeStateRows(client, chunk.stateRows);

        if (chunk.queueRows.length > 0) {
          await batchInsert(
            client,
            `INSERT INTO drug.enrichment_queue (
               license_id, reason, priority, status, available_at,
               claimed_at, claimed_by, attempt_count, last_error_message
             )`,
            "ON CONFLICT (license_id) WHERE status = 'pending' DO NOTHING",
            new Array(9).fill(null),
            chunk.queueRows,
          );
        }

        if (chunk.eventRows.length > 0) {
          await batchInsert(
            client,
            `INSERT INTO drug.import_stage_events (
               run_id, license_id, stage, from_status, to_status,
               error_code, error_message, payload, created_at
             )`,
            "",
            [null, null, null, null, null, null, null, "jsonb", null],
            chunk.eventRows,
          );
        }
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }

    logInfo(
      `  Drug index loaded: ${rowsByLicense.size} licenses ` +
        `(${newCount} new, ${changedCount} changed, ${relistedCount} relisted, ` +
        `${removedLicenseIds.length} removed, ${duplicates} duplicates overwritten).`,
    );
    return summary;
  } finally {
    client.release();
  }
}

/** `drug.import_license_state` upsert: a stage once marked 'no_data' stays there. */
async function writeStateRows(client: pg.PoolClient, stateRows: unknown[][]): Promise<void> {
  await batchInsert(
        client,
        `INSERT INTO drug.import_license_state AS ils (
           license_id, current_run_id, index_status, electronic_insert_status,
           insert_pdf_status, label_pdf_status, shape_status, storage_status,
           ocr_status, analysis_status, normalize_status, next_retry_at,
           retry_count, last_error_code, last_error_message, updated_at
         )`,
        // A stage marked 'no_data' stays there unless this import says otherwise;
        // stages already in flight keep their existing status.
        `ON CONFLICT (license_id) DO UPDATE SET
           current_run_id = EXCLUDED.current_run_id,
           index_status = EXCLUDED.index_status,
           electronic_insert_status = CASE
             WHEN EXCLUDED.electronic_insert_status = 'no_data' THEN 'no_data'
             WHEN ils.electronic_insert_status = 'no_data' THEN EXCLUDED.electronic_insert_status
             ELSE ils.electronic_insert_status END,
           insert_pdf_status = CASE
             WHEN EXCLUDED.insert_pdf_status = 'no_data' THEN 'no_data'
             WHEN ils.insert_pdf_status = 'no_data' THEN EXCLUDED.insert_pdf_status
             ELSE ils.insert_pdf_status END,
           label_pdf_status = CASE
             WHEN EXCLUDED.label_pdf_status = 'no_data' THEN 'no_data'
             WHEN ils.label_pdf_status = 'no_data' THEN EXCLUDED.label_pdf_status
             ELSE ils.label_pdf_status END,
           shape_status = CASE
             WHEN EXCLUDED.shape_status = 'no_data' THEN 'no_data'
             WHEN ils.shape_status = 'no_data' THEN EXCLUDED.shape_status
             ELSE ils.shape_status END,
           storage_status = CASE
             WHEN EXCLUDED.storage_status = 'no_data' THEN 'no_data'
             WHEN ils.storage_status = 'no_data' THEN EXCLUDED.storage_status
             ELSE ils.storage_status END,
           ocr_status = CASE
             WHEN EXCLUDED.ocr_status = 'no_data' THEN 'no_data'
             WHEN ils.ocr_status = 'no_data' THEN EXCLUDED.ocr_status
             ELSE ils.ocr_status END,
           analysis_status = CASE
             WHEN EXCLUDED.analysis_status = 'no_data' THEN 'no_data'
             WHEN ils.analysis_status = 'no_data' THEN EXCLUDED.analysis_status
             ELSE ils.analysis_status END,
           normalize_status = EXCLUDED.normalize_status,
           updated_at = EXCLUDED.updated_at`,
    new Array(16).fill(null),
    stateRows,
  );
}
