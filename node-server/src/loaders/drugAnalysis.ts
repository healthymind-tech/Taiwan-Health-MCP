/**
 * Drug insert OCR / analysis / normalize loader.
 *
 * Node port of `loader/loaders/drug_analysis_loader.py`. For each license it takes
 * the newest stored insert PDF, OCRs it, extracts structured JSON with the
 * Analysis LM, stores both artefacts in MinIO, and rebuilds the canonical record
 * with the analysis as the primary source.
 *
 * `retryStage` re-runs one stage without redoing the ones before it: `analysis`
 * reuses the stored OCR Markdown, `normalize` only rebuilds the record.
 */

import { createHash } from "node:crypto";
import pg from "pg";
import * as minio from "../minioService.js";
import { logInfo, logWarning } from "../logger.js";
import {
  DrugAnalysisService,
  loadDrugAnalysisConfig,
  type DrugAnalysisResult,
} from "../drugAnalysisService.js";
import { buildDrugRecord, type Dict, type IndexRow } from "./drugRecordBuilder.js";

const NAMESPACE_URL = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";

/** Python `uuid.uuid5(namespace, name)`. */
function uuid5(namespace: string, name: string): string {
  const nsBytes = Buffer.from(namespace.replace(/-/g, ""), "hex");
  const hash = createHash("sha1")
    .update(Buffer.concat([nsBytes, Buffer.from(name, "utf8")]))
    .digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const ANALYSIS_NAMESPACE = uuid5(NAMESPACE_URL, "taiwan-health-mcp/drug-insert-analysis");
const ANALYSIS_ASSET_NAMESPACE = uuid5(NAMESPACE_URL, "taiwan-health-mcp/drug-analysis-assets");

const analysisId = (sourceAssetId: string): string => uuid5(ANALYSIS_NAMESPACE, sourceAssetId);
const analysisAssetId = (sourceAssetId: string, kind: string): string =>
  uuid5(ANALYSIS_ASSET_NAMESPACE, `${sourceAssetId}|${kind}`);
const analysisObjectKey = (licenseId: string, sourceAssetId: string, filename: string): string =>
  `drug/${licenseId}/analysis/${sourceAssetId}/${filename}`;

/** Python `_date_text`: a date renders as YYYY-MM-DD, null as "". */
function dateText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}

/** Python `_parse_date`: the leading YYYY-MM-DD, or null. */
function parseDbDate(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function stem(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(0, dot) : filename;
}

async function loadIndexRow(client: pg.PoolClient, licenseId: string): Promise<IndexRow | null> {
  const res = await client.query<{ raw_index_json: unknown }>(
    "SELECT raw_index_json FROM drug.licenses WHERE license_id = $1",
    [licenseId],
  );
  const raw = res.rows[0]?.raw_index_json;
  if (raw == null) return null;
  const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as IndexRow)
    : null;
}

async function loadExistingSourceErrors(
  client: pg.PoolClient,
  licenseId: string,
): Promise<string[]> {
  const res = await client.query<{ source_errors: unknown }>(
    "SELECT source_errors FROM drug.normalized_records WHERE license_id = $1",
    [licenseId],
  );
  const value = res.rows[0]?.source_errors;
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

async function loadElectronicInsert(
  client: pg.PoolClient,
  licenseId: string,
): Promise<Dict | null> {
  const res = await client.query<Record<string, unknown>>(
    `SELECT source_url, basic_info_json, manufacturers_json, sections_json,
            ingredients_json, atc_codes_json, label_pdfs_json, history_pdfs_json,
            public_pdfs_json, paper_pdfs_json, authorizations_json
     FROM drug.electronic_inserts WHERE license_id = $1`,
    [licenseId],
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    source_url: row.source_url ?? "",
    basic_info: row.basic_info_json ?? {},
    manufacturers: row.manufacturers_json ?? [],
    sections: row.sections_json ?? {},
    ingredients: row.ingredients_json ?? {},
    atc_codes: row.atc_codes_json ?? [],
    label_pdfs: row.label_pdfs_json ?? [],
    history_pdfs: row.history_pdfs_json ?? [],
    public_pdfs: row.public_pdfs_json ?? [],
    paper_pdfs: row.paper_pdfs_json ?? [],
    authorizations: row.authorizations_json ?? [],
  };
}

async function loadAssetRows(
  client: pg.PoolClient,
  licenseId: string,
  assetGroup: string,
): Promise<Dict[]> {
  const res = await client.query<Record<string, unknown>>(
    `SELECT asset_id::text AS asset_id, appearance_id::text AS appearance_id, asset_type,
            asset_group, source_page, source_url, source_filename, normalized_filename,
            upload_date, mime_type, size_bytes, sha256, bucket, object_key, minio_uri,
            etag, version_id, download_status, storage_status, is_latest_for_analysis,
            retry_count, last_error_code, last_error_message, last_attempt_at,
            downloaded_at, stored_at
     FROM drug.assets
     WHERE license_id = $1 AND asset_group = $2
     ORDER BY upload_date DESC NULLS LAST, normalized_filename`,
    [licenseId, assetGroup],
  );
  return res.rows.map((row) => ({ ...row, upload_date: dateText(row.upload_date) }));
}

async function loadAppearanceRecords(client: pg.PoolClient, licenseId: string): Promise<Dict[]> {
  const records = await client.query<Record<string, unknown>>(
    `SELECT appearance_id::text AS appearance_id, shape_id, appearance_no, detail_url,
            description, color, shape, scoring, symbol, size, imprint, raw_json
     FROM drug.appearance_records
     WHERE license_id = $1
     ORDER BY appearance_no, shape_id`,
    [licenseId],
  );
  const shapeAssets = await client.query<Record<string, unknown>>(
    `SELECT asset_id::text AS asset_id, appearance_id::text AS appearance_id, source_filename,
            normalized_filename, source_url, upload_date, bucket, object_key, minio_uri
     FROM drug.assets
     WHERE license_id = $1 AND asset_group = 'shape'
     ORDER BY normalized_filename`,
    [licenseId],
  );

  const imagesByAppearance = new Map<string, Dict[]>();
  for (const row of shapeAssets.rows) {
    const key = String(row.appearance_id ?? "");
    const images = imagesByAppearance.get(key) ?? [];
    images.push({
      asset_id: row.asset_id,
      source_filename: row.source_filename ?? "",
      normalized_filename: row.normalized_filename ?? "",
      source_url: row.source_url ?? "",
      upload_date: dateText(row.upload_date),
      bucket: row.bucket ?? "",
      object_key: row.object_key ?? "",
      minio_uri: row.minio_uri ?? "",
    });
    imagesByAppearance.set(key, images);
  }

  return records.rows.map((row) => ({
    ...row,
    raw_json: row.raw_json ?? {},
    images: imagesByAppearance.get(String(row.appearance_id ?? "")) ?? [],
  }));
}

async function loadAnalysisPayload(
  client: pg.PoolClient,
  sourceAssetId: string,
): Promise<Dict | null> {
  const res = await client.query<{ normalized_json: unknown }>(
    `SELECT normalized_json FROM drug.insert_analysis
     WHERE source_asset_id::text = $1 AND analysis_status = 'success'`,
    [sourceAssetId],
  );
  const value = res.rows[0]?.normalized_json;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Dict;
}

async function loadExistingOcrMarkdown(
  client: pg.PoolClient,
  sourceAssetId: string,
): Promise<string | null> {
  const res = await client.query<{ object_key: string | null }>(
    `SELECT a.object_key
     FROM drug.insert_analysis ia
     JOIN drug.assets a ON a.asset_id = ia.ocr_asset_id
     WHERE ia.source_asset_id::text = $1
       AND ia.ocr_status = 'success'
       AND a.storage_status = 'success'`,
    [sourceAssetId],
  );
  const objectKey = res.rows[0]?.object_key;
  if (!objectKey) return null;
  try {
    return (await minio.downloadBytes(objectKey)).toString("utf8");
  } catch {
    return null;
  }
}

async function refreshNormalizedRecord(
  client: pg.PoolClient,
  opts: {
    licenseId: string;
    sourceAssetId: string;
    analysisJson: Dict | null;
    normalizedAt: Date;
  },
): Promise<Dict> {
  const indexRow = await loadIndexRow(client, opts.licenseId);
  if (indexRow === null) throw new Error(`Index row not found for ${opts.licenseId}`);
  const analysisJson = opts.analysisJson ?? (await loadAnalysisPayload(client, opts.sourceAssetId));
  return buildDrugRecord(indexRow, {
    electronicInsert: await loadElectronicInsert(client, opts.licenseId),
    analysis: analysisJson,
    insertAssets: await loadAssetRows(client, opts.licenseId, "insert"),
    labelAssets: await loadAssetRows(client, opts.licenseId, "label"),
    appearanceRecords: await loadAppearanceRecords(client, opts.licenseId),
    sourceErrors: await loadExistingSourceErrors(client, opts.licenseId),
    normalizedAt: opts.normalizedAt,
  });
}

async function upsertNormalizedRecord(
  client: pg.PoolClient,
  licenseId: string,
  record: Dict,
  now: Date,
): Promise<void> {
  const source = record.source as Dict;
  const quality = record.quality as Dict;
  await client.query(
    `INSERT INTO drug.normalized_records (
       license_id, normalized_json, primary_insert_source,
       quality_confidence, missing_fields, conflict_fields,
       source_errors, normalized_at
     )
     VALUES ($1, $2::jsonb, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8)
     ON CONFLICT (license_id) DO UPDATE SET
       normalized_json = EXCLUDED.normalized_json,
       primary_insert_source = EXCLUDED.primary_insert_source,
       quality_confidence = EXCLUDED.quality_confidence,
       missing_fields = EXCLUDED.missing_fields,
       conflict_fields = EXCLUDED.conflict_fields,
       source_errors = EXCLUDED.source_errors,
       normalized_at = EXCLUDED.normalized_at`,
    [
      licenseId,
      JSON.stringify(record),
      source.primary_insert_source,
      quality.confidence,
      JSON.stringify(quality.missing_fields),
      JSON.stringify(quality.conflict_fields),
      JSON.stringify(source.errors),
      now,
    ],
  );
}

interface AnalysisAsset {
  assetId: string;
  licenseId: string;
  assetType: string;
  filename: string;
  mimeType: string;
  data: Buffer;
  locator: Record<string, string>;
  storageStatus: string;
  sourceUploadDate: string;
  now: Date;
}

async function upsertAnalysisAsset(client: pg.PoolClient, asset: AnalysisAsset): Promise<void> {
  await client.query(
    `INSERT INTO drug.assets (
       asset_id, license_id, appearance_id, asset_type, asset_group,
       source_page, source_url, source_filename, normalized_filename,
       upload_date, mime_type, size_bytes, sha256, bucket, object_key,
       minio_uri, etag, version_id, download_status, storage_status,
       is_latest_for_analysis, retry_count, last_error_code,
       last_error_message, last_attempt_at, downloaded_at, stored_at
     )
     VALUES ($1, $2, NULL, $3, 'analysis', 'analysis', '', $4, $4, $5, $6, $7, $8, $9, $10,
             $11, $12, $13, 'success', $14, FALSE, 0, '', '', $15, $15, $16)
     ON CONFLICT (asset_id) DO UPDATE SET
       license_id = EXCLUDED.license_id,
       appearance_id = EXCLUDED.appearance_id,
       asset_type = EXCLUDED.asset_type,
       asset_group = EXCLUDED.asset_group,
       source_page = EXCLUDED.source_page,
       source_url = EXCLUDED.source_url,
       source_filename = EXCLUDED.source_filename,
       normalized_filename = EXCLUDED.normalized_filename,
       upload_date = EXCLUDED.upload_date,
       mime_type = EXCLUDED.mime_type,
       size_bytes = EXCLUDED.size_bytes,
       sha256 = EXCLUDED.sha256,
       bucket = EXCLUDED.bucket,
       object_key = EXCLUDED.object_key,
       minio_uri = EXCLUDED.minio_uri,
       etag = EXCLUDED.etag,
       version_id = EXCLUDED.version_id,
       download_status = EXCLUDED.download_status,
       storage_status = EXCLUDED.storage_status,
       is_latest_for_analysis = EXCLUDED.is_latest_for_analysis,
       retry_count = EXCLUDED.retry_count,
       last_error_code = EXCLUDED.last_error_code,
       last_error_message = EXCLUDED.last_error_message,
       last_attempt_at = EXCLUDED.last_attempt_at,
       downloaded_at = EXCLUDED.downloaded_at,
       stored_at = EXCLUDED.stored_at`,
    [
      asset.assetId,
      asset.licenseId,
      asset.assetType,
      asset.filename,
      parseDbDate(asset.sourceUploadDate),
      asset.mimeType,
      asset.data.length,
      createHash("sha256").update(asset.data).digest("hex"),
      asset.locator.bucket ?? "",
      asset.locator.object_key ?? "",
      asset.locator.minio_uri ?? "",
      asset.locator.etag ?? "",
      asset.locator.version_id ?? "",
      asset.storageStatus,
      asset.now,
      asset.storageStatus === "success" ? asset.now : null,
    ],
  );
}

async function upsertStageEvent(
  client: pg.PoolClient,
  opts: {
    licenseId: string;
    stage: string;
    status: string;
    errorCode: string;
    errorMessage: string;
    payload: Dict;
    now: Date;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO drug.import_stage_events (
       run_id, license_id, stage, from_status, to_status,
       error_code, error_message, payload, created_at
     )
     VALUES (NULL, $1, $2, NULL, $3, $4, $5, $6::jsonb, $7)`,
    [
      opts.licenseId,
      opts.stage,
      opts.status,
      opts.errorCode,
      opts.errorMessage,
      JSON.stringify(opts.payload),
      opts.now,
    ],
  );
}

interface Candidate {
  license_id: string;
  source_asset_id: string;
  object_key: string;
  normalized_filename: string | null;
  upload_date: Date | null;
  ocr_status: string;
  analysis_status: string;
  normalize_status: string;
}

export type RetryStage = "ocr" | "analysis" | "normalize";

export interface DrugAnalysisOptions {
  limit?: number | null;
  licenseIds?: string[] | null;
  includeCancelled?: boolean;
  retryFailed?: boolean;
  retryStage?: string | null;
  /** Called after each license; throw to abort (used for pause/cancel). */
  onProgress?: (done: number, total: number, licenseId: string) => Promise<void> | void;
}

/** The licenses this run would analyse — used by the worker to pin its batch. */
export async function selectAnalysisCandidates(
  pool: pg.Pool,
  options: DrugAnalysisOptions,
): Promise<string[]> {
  const stage = (options.retryStage ?? "").trim().toLowerCase();
  const retryStage = (stage || null) as RetryStage | null;
  const client = await pool.connect();
  try {
    const rows = await candidateSources(client, { ...options, retryStage });
    return rows.map((row) => row.license_id);
  } finally {
    client.release();
  }
}

async function candidateSources(
  client: pg.PoolClient,
  opts: DrugAnalysisOptions & { retryStage: RetryStage | null },
): Promise<Candidate[]> {
  const where = ["l.is_listed"];
  const params: unknown[] = [];
  if (!opts.includeCancelled) where.push("l.is_active");

  if (opts.licenseIds && opts.licenseIds.length > 0) {
    params.push(opts.licenseIds);
    where.push(`l.license_id = ANY($${params.length}::text[])`);
  } else {
    const pendingStatuses = ["pending", "partial_success"];
    if (opts.retryFailed) pendingStatuses.push("retryable_failed");
    params.push(pendingStatuses);
    const statusParam = `$${params.length}::text[]`;
    if (opts.retryStage === "ocr") {
      where.push(`COALESCE(s.ocr_status, 'pending') = ANY(${statusParam})`);
    } else if (opts.retryStage === "analysis") {
      where.push(
        `(ia.source_asset_id IS NULL OR COALESCE(s.analysis_status, 'pending') = ANY(${statusParam}))`,
      );
    } else if (opts.retryStage === "normalize") {
      where.push(`COALESCE(s.normalize_status, 'pending') = ANY(${statusParam})`);
    } else {
      where.push(
        `(ia.source_asset_id IS NULL OR ` +
          `COALESCE(s.ocr_status, 'pending') = ANY(${statusParam}) OR ` +
          `COALESCE(s.analysis_status, 'pending') = ANY(${statusParam}) OR ` +
          `COALESCE(s.normalize_status, 'pending') = ANY(${statusParam}))`,
      );
    }
  }

  let sql = `
    SELECT
      l.license_id,
      a.asset_id::text AS source_asset_id,
      a.object_key,
      a.normalized_filename,
      a.upload_date,
      COALESCE(s.ocr_status, 'pending') AS ocr_status,
      COALESCE(s.analysis_status, 'pending') AS analysis_status,
      COALESCE(s.normalize_status, 'pending') AS normalize_status
    FROM drug.licenses l
    JOIN LATERAL (
      SELECT asset_id, object_key, normalized_filename, upload_date
      FROM drug.assets a
      WHERE a.license_id = l.license_id
        AND a.asset_type = 'insert_pdf'
        AND a.storage_status = 'success'
      ORDER BY a.is_latest_for_analysis DESC,
               a.upload_date DESC NULLS LAST,
               a.stored_at DESC NULLS LAST,
               a.normalized_filename
      LIMIT 1
    ) a ON TRUE
    LEFT JOIN drug.import_license_state s ON s.license_id = l.license_id
    LEFT JOIN drug.insert_analysis ia ON ia.source_asset_id = a.asset_id
    WHERE ${where.join(" AND ")}
    ORDER BY l.license_id
  `;
  if (opts.limit) {
    params.push(opts.limit);
    sql += ` LIMIT $${params.length}`;
  }
  const res = await client.query<Candidate>(sql, params);
  return res.rows;
}

export async function loadDrugAnalysis(
  pool: pg.Pool,
  options: DrugAnalysisOptions = {},
): Promise<void> {
  const stage = (options.retryStage ?? "").trim().toLowerCase();
  if (stage && !["ocr", "analysis", "normalize"].includes(stage)) {
    throw new Error("retryStage must be one of: ocr, analysis, normalize");
  }
  const retryStage = (stage || null) as RetryStage | null;

  const service = new DrugAnalysisService(await loadDrugAnalysisConfig());
  if (!minio.initialized()) await minio.initialize();

  if (retryStage !== "normalize") {
    const [ready, reason] =
      retryStage === "analysis" ? service.analysisReadiness() : service.readiness();
    if (!ready) {
      logInfo(`  Drug analysis skipped: ${reason}`);
      return;
    }
    if (!minio.enabled()) {
      logInfo(`  Drug analysis skipped: ${minio.initError() ?? "MinIO not configured"}`);
      return;
    }
  }

  const listClient = await pool.connect();
  let candidates: Candidate[];
  try {
    candidates = await candidateSources(listClient, { ...options, retryStage });
  } finally {
    listClient.release();
  }

  if (candidates.length === 0) {
    logInfo("  Drug analysis: no candidate licenses found.");
    return;
  }
  logInfo(`Running drug analysis for ${candidates.length} license(s) ...`);

  let done = 0;
  for (const candidate of candidates) {
    const licenseId = candidate.license_id;
    const sourceAssetId = candidate.source_asset_id;
    const now = new Date();
    const sourceFilename = candidate.normalized_filename || "insert.pdf";
    const sourceUploadDate = dateText(candidate.upload_date);

    try {
      if (retryStage === "normalize") {
        const client = await pool.connect();
        try {
          const analysisJson = await loadAnalysisPayload(client, sourceAssetId);
          const record = await refreshNormalizedRecord(client, {
            licenseId,
            sourceAssetId,
            analysisJson,
            normalizedAt: now,
          });
          await client.query("BEGIN");
          try {
            await upsertNormalizedRecord(client, licenseId, record, now);
            await client.query(
              `UPDATE drug.import_license_state
               SET normalize_status = 'success', updated_at = $2, next_retry_at = NULL,
                   last_error_code = '', last_error_message = ''
               WHERE license_id = $1`,
              [licenseId, now],
            );
            await upsertStageEvent(client, {
              licenseId,
              stage: "normalize",
              status: "success",
              errorCode: "",
              errorMessage: "",
              payload: { retry_stage: "normalize" },
              now,
            });
            await client.query("COMMIT");
          } catch (err) {
            await client.query("ROLLBACK");
            throw err;
          }
        } finally {
          client.release();
        }
        logInfo(`  ${licenseId}: normalize=success`);
        done += 1;
        if (options.onProgress) await options.onProgress(done, candidates.length, licenseId);
        continue;
      }

      const pdfBytes = await minio.downloadBytes(candidate.object_key);

      let existingMarkdown: string | null = null;
      if (retryStage === "analysis") {
        const client = await pool.connect();
        try {
          existingMarkdown = await loadExistingOcrMarkdown(client, sourceAssetId);
        } finally {
          client.release();
        }
      }

      const result: DrugAnalysisResult = await service.analyzePdfBytes({
        licenseId,
        sourceFilename,
        pdfBytes,
        existingMarkdown,
      });

      const ocrAssetId = analysisAssetId(sourceAssetId, "ocr");
      const jsonAssetId = analysisAssetId(sourceAssetId, "analysis");
      const markdownFilename = `${stem(sourceFilename)}.ocr.md`;
      const jsonFilename = `${stem(sourceFilename)}.analysis.json`;
      const markdownBytes = Buffer.from(result.markdown, "utf8");
      const jsonBytes = Buffer.from(JSON.stringify(result.analysisJson, null, 2), "utf8");

      const markdownKey = analysisObjectKey(licenseId, sourceAssetId, markdownFilename);
      const jsonKey = analysisObjectKey(licenseId, sourceAssetId, jsonFilename);

      const markdownLocator = {
        ...minio.buildLocator(markdownKey),
        ...(await minio.uploadBytes({
          objectKey: markdownKey,
          data: markdownBytes,
          contentType: "text/markdown; charset=utf-8",
        })),
      };
      const jsonLocator = {
        ...minio.buildLocator(jsonKey),
        ...(await minio.uploadBytes({
          objectKey: jsonKey,
          data: jsonBytes,
          contentType: "application/json",
        })),
      };

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        try {
          await upsertAnalysisAsset(client, {
            assetId: ocrAssetId,
            licenseId,
            assetType: "ocr_markdown",
            filename: markdownFilename,
            mimeType: "text/markdown",
            data: markdownBytes,
            locator: markdownLocator,
            storageStatus: "success",
            sourceUploadDate,
            now,
          });
          await upsertAnalysisAsset(client, {
            assetId: jsonAssetId,
            licenseId,
            assetType: "analysis_json",
            filename: jsonFilename,
            mimeType: "application/json",
            data: jsonBytes,
            locator: jsonLocator,
            storageStatus: "success",
            sourceUploadDate,
            now,
          });

          await client.query(
            `INSERT INTO drug.insert_analysis (
               analysis_id, license_id, source_asset_id, ocr_asset_id,
               analysis_asset_id, primary_insert_source, ocr_provider,
               analysis_provider, ocr_status, analysis_status,
               normalized_json, last_error_code, last_error_message,
               last_attempt_at, completed_at
             )
             VALUES ($1, $2, $3::uuid, $4::uuid, $5::uuid, 'pdf_insert', $6, $7,
                     'success', 'success', $8::jsonb, '', '', $9, $9)
             ON CONFLICT (source_asset_id) DO UPDATE SET
               ocr_asset_id = EXCLUDED.ocr_asset_id,
               analysis_asset_id = EXCLUDED.analysis_asset_id,
               primary_insert_source = EXCLUDED.primary_insert_source,
               ocr_provider = EXCLUDED.ocr_provider,
               analysis_provider = EXCLUDED.analysis_provider,
               ocr_status = EXCLUDED.ocr_status,
               analysis_status = EXCLUDED.analysis_status,
               normalized_json = EXCLUDED.normalized_json,
               last_error_code = EXCLUDED.last_error_code,
               last_error_message = EXCLUDED.last_error_message,
               last_attempt_at = EXCLUDED.last_attempt_at,
               completed_at = EXCLUDED.completed_at`,
            [
              analysisId(sourceAssetId),
              licenseId,
              sourceAssetId,
              ocrAssetId,
              jsonAssetId,
              result.ocrProvider,
              result.analysisProvider,
              JSON.stringify(result.analysisJson),
              now,
            ],
          );

          const record = await refreshNormalizedRecord(client, {
            licenseId,
            sourceAssetId,
            analysisJson: result.analysisJson as Dict,
            normalizedAt: now,
          });
          await upsertNormalizedRecord(client, licenseId, record, now);

          await client.query(
            `UPDATE drug.import_license_state
             SET ocr_status = 'success', analysis_status = 'success',
                 normalize_status = 'success', updated_at = $2, next_retry_at = NULL,
                 last_error_code = '', last_error_message = ''
             WHERE license_id = $1`,
            [licenseId, now],
          );

          for (const stageName of ["ocr", "analysis", "normalize"]) {
            await upsertStageEvent(client, {
              licenseId,
              stage: stageName,
              status: "success",
              errorCode: "",
              errorMessage: "",
              payload: { source_asset_id: sourceAssetId },
              now,
            });
          }

          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK");
          throw err;
        }
      } finally {
        client.release();
      }

      logInfo(`  ${licenseId}: ocr=success, analysis=success, normalize=success`);
    } catch (err) {
      const errorMessage = String(err instanceof Error ? err.message : err);
      const nextRetryAt = new Date(now.getTime() + 30 * 60 * 1000);
      // Only the stages this run was responsible for are marked failed; one that
      // was skipped (because retryStage started later) keeps its previous status.
      const failedOcr =
        retryStage === "analysis" || retryStage === "normalize"
          ? candidate.ocr_status
          : "retryable_failed";
      const failedAnalysis =
        retryStage === null || retryStage === "analysis" || retryStage === "ocr"
          ? "retryable_failed"
          : candidate.analysis_status;
      const failedNormalize = "retryable_failed";

      const client = await pool.connect();
      try {
        await client.query(
          `UPDATE drug.import_license_state
           SET ocr_status = $2, analysis_status = $3, normalize_status = $4,
               updated_at = $5, next_retry_at = $6, retry_count = retry_count + 1,
               last_error_code = 'retryable_failed', last_error_message = $7
           WHERE license_id = $1`,
          [licenseId, failedOcr, failedAnalysis, failedNormalize, now, nextRetryAt, errorMessage],
        );
        if (retryStage !== "normalize") {
          await client.query(
            `INSERT INTO drug.insert_analysis (
               analysis_id, license_id, source_asset_id, primary_insert_source,
               ocr_provider, analysis_provider, ocr_status, analysis_status,
               normalized_json, last_error_code, last_error_message,
               last_attempt_at, completed_at
             )
             VALUES ($1, $2, $3::uuid, 'pdf_insert', $4, $5, $6, $7,
                     '{}'::jsonb, 'retryable_failed', $8, $9, NULL)
             ON CONFLICT (source_asset_id) DO UPDATE SET
               ocr_provider = EXCLUDED.ocr_provider,
               analysis_provider = EXCLUDED.analysis_provider,
               ocr_status = EXCLUDED.ocr_status,
               analysis_status = EXCLUDED.analysis_status,
               last_error_code = EXCLUDED.last_error_code,
               last_error_message = EXCLUDED.last_error_message,
               last_attempt_at = EXCLUDED.last_attempt_at,
               completed_at = NULL`,
            [
              analysisId(sourceAssetId),
              licenseId,
              sourceAssetId,
              service.config.ocrProvider,
              service.config.analysisProfiles[0]?.provider ?? "",
              failedOcr,
              failedAnalysis,
              errorMessage,
              now,
            ],
          );
        }
        await upsertStageEvent(client, {
          licenseId,
          stage: retryStage ?? "analysis_pipeline",
          status: "retryable_failed",
          errorCode: "retryable_failed",
          errorMessage,
          payload: { source_asset_id: sourceAssetId },
          now,
        });
      } finally {
        client.release();
      }
      logWarning(`  ${licenseId}: analysis failed (${errorMessage})`);
    }

    done += 1;
    if (options.onProgress) await options.onProgress(done, candidates.length, licenseId);
  }
}
