/**
 * TFDA drug enrichment loader: scrapes each queued license, stores its assets in
 * MinIO, and rebuilds the canonical record.
 *
 * Node port of `loader/loaders/drug_enrichment_loader.py`. Asset and appearance
 * IDs are UUIDv5 over the same namespaces and name strings as the Python, so a
 * re-run overwrites the same rows and object keys rather than duplicating them.
 */

import { createHash } from "node:crypto";
import pg from "pg";
import * as minio from "../minioService.js";
import { logInfo, logWarning } from "../logger.js";
import { buildDrugRecord, isEiComplete, type Dict, type IndexRow } from "./drugRecordBuilder.js";
import { parseDate } from "./tfdaParserUtils.js";
import { renderDrugWebImage } from "./drugImageVariant.js";
import {
  TFDACrawlerService,
  type AppearanceRecordScrape,
  type DrugEnrichmentPayload,
  type ScrapedAsset,
} from "./tfdaCrawler.js";

const NAMESPACE_URL = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";

/** Python `uuid.uuid5(namespace, name)` — SHA-1 over the namespace bytes + name. */
function uuid5(namespace: string, name: string): string {
  const nsBytes = Buffer.from(namespace.replace(/-/g, ""), "hex");
  const hash = createHash("sha1")
    .update(Buffer.concat([nsBytes, Buffer.from(name, "utf8")]))
    .digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const ASSET_NAMESPACE = uuid5(NAMESPACE_URL, "taiwan-health-mcp/drug-assets");
const APPEARANCE_NAMESPACE = uuid5(NAMESPACE_URL, "taiwan-health-mcp/drug-appearance");
const VARIANT_NAMESPACE = uuid5(NAMESPACE_URL, "taiwan-health-mcp/drug-asset-variants");

function deterministicAssetId(
  licenseId: string,
  assetType: string,
  normalizedFilename: string,
  sourceUrl: string,
): string {
  return uuid5(ASSET_NAMESPACE, `${licenseId}|${assetType}|${normalizedFilename}|${sourceUrl}`);
}

function deterministicAppearanceId(licenseId: string, shapeId: string): string {
  return uuid5(APPEARANCE_NAMESPACE, `${licenseId}|${shapeId}`);
}

function plannedObjectKey(
  licenseId: string,
  assetGroup: string,
  assetId: string,
  normalizedFilename: string,
): string {
  return `drug/${licenseId}/${assetGroup}/${assetId}/${normalizedFilename}`;
}

function deterministicVariantId(assetId: string, variantKind: string): string {
  return uuid5(VARIANT_NAMESPACE, `${assetId}|${variantKind}`);
}

interface AssetVariantRow {
  variant_id: string;
  source_asset_id: string;
  variant_kind: string;
  mime_type: string;
  width_px: number | null;
  height_px: number | null;
  size_bytes: number | null;
  sha256: string;
  bucket: string;
  object_key: string;
  minio_uri: string;
  etag: string;
  version_id: string;
  storage_status: string;
  last_error_message: string;
  stored_at: Date | null;
}

function stageStatus(itemCount: number, hadError: boolean): string {
  if (hadError && itemCount > 0) return "partial_success";
  if (hadError) return "retryable_failed";
  if (itemCount > 0) return "success";
  return "no_data";
}

function stageErrors(payload: DrugEnrichmentPayload, prefix: string): string[] {
  return payload.errors.filter((err) => err.startsWith(prefix));
}

/** A `drug.assets` row, keyed the way the record builder expects to read it. */
interface AssetRow extends Dict {
  asset_id: string;
  license_id: string;
  appearance_id: string | null;
  asset_type: string;
  asset_group: string;
  source_page: string;
  source_url: string;
  source_filename: string;
  normalized_filename: string;
  upload_date: string | null;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  bucket: string;
  object_key: string;
  minio_uri: string;
  etag: string;
  version_id: string;
  download_status: string;
  storage_status: string;
  is_latest_for_analysis: boolean;
  retry_count: number;
  last_error_code: string;
  last_error_message: string;
  last_attempt_at: Date;
  downloaded_at: Date;
  stored_at: Date | null;
}

function assetRowFromUploaded(
  licenseId: string,
  asset: ScrapedAsset,
  opts: {
    assetId: string;
    appearanceId: string | null;
    locator: Record<string, string>;
    storageStatus: string;
    lastErrorMessage?: string;
  },
): AssetRow {
  const uploadDate = parseDate(asset.uploadDate);
  const lastErrorMessage = opts.lastErrorMessage ?? "";
  return {
    asset_id: opts.assetId,
    license_id: licenseId,
    appearance_id: opts.appearanceId,
    asset_type: asset.assetType,
    asset_group: asset.assetGroup,
    source_page: asset.sourcePage,
    source_url: asset.sourceUrl,
    source_filename: asset.sourceFilename,
    normalized_filename: asset.normalizedFilename,
    upload_date: uploadDate ? uploadDate.toISOString().slice(0, 10) : null,
    mime_type: asset.mimeType,
    size_bytes: asset.sizeBytes,
    sha256: asset.sha256,
    bucket: opts.locator.bucket ?? "",
    object_key: opts.locator.object_key ?? "",
    minio_uri: opts.locator.minio_uri ?? "",
    etag: opts.locator.etag ?? "",
    version_id: opts.locator.version_id ?? "",
    download_status: asset.downloadStatus,
    storage_status: opts.storageStatus,
    is_latest_for_analysis: false,
    retry_count: 0,
    last_error_code: lastErrorMessage ? "storage_failed" : "",
    last_error_message: lastErrorMessage,
    last_attempt_at: new Date(),
    downloaded_at: asset.downloadedAt,
    stored_at: opts.storageStatus === "success" ? new Date() : null,
  };
}

function convertAtcRows(licenseId: string, electronicInsert: Dict | null): unknown[][] {
  if (!electronicInsert) return [];
  const rows: unknown[][] = [];
  const codes = electronicInsert.atc_codes;
  for (const item of Array.isArray(codes) ? codes : []) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const entry = item as Dict;
    const code = entry["ATC Code"] || entry["代碼"] || entry.ATC || "";
    const name =
      entry["ATC名稱"] || entry["中文分類名稱"] || entry["英文分類名稱"] || entry["名稱"] || "";
    if (code || name) rows.push([licenseId, code, name, JSON.stringify(entry)]);
  }
  return rows;
}

interface AppearanceRow extends Dict {
  appearance_id: string;
  license_id: string;
  shape_id: string;
  appearance_no: string;
  detail_url: string;
  description: string;
  color: string;
  shape: string;
  scoring: string;
  symbol: string;
  size: string;
  imprint: string;
  raw_json: Dict;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function joinParts(parts: unknown[]): string {
  return parts
    .map(str)
    .filter((part) => part !== "")
    .join(" ");
}

function convertAppearanceRows(
  licenseId: string,
  records: AppearanceRecordScrape[],
): AppearanceRow[] {
  return records.map((record) => {
    const raw = record.rawJson;
    return {
      appearance_id: deterministicAppearanceId(licenseId, record.shapeId),
      license_id: licenseId,
      shape_id: record.shapeId,
      appearance_no: str(raw["外觀編號"] ?? ""),
      detail_url: record.detailUrl,
      description: str(raw["藥品外觀"] ?? raw["外觀"] ?? ""),
      color: joinParts([raw["顏色"], raw["顏色1"], raw["顏色2"]]),
      shape: str(raw["形狀"] ?? ""),
      scoring: str(raw["刻痕"] ?? ""),
      symbol: str(raw["符號"] ?? ""),
      size: str(raw["大小"] ?? ""),
      imprint: joinParts([raw["標記"], raw["標記1"], raw["標記2"]]),
      raw_json: raw,
    };
  });
}

export interface DrugEnrichmentOptions {
  limit?: number | null;
  licenseIds?: string[] | null;
  includeCancelled?: boolean;
  retryFailed?: boolean;
  tfdaValues?: { base_url?: unknown; http_timeout?: unknown } | null;
  /** Called after each license; throw to abort (used for pause/cancel). */
  onProgress?: (done: number, total: number, licenseId: string) => Promise<void> | void;
}

/** The licenses this run would enrich — used by the worker to pin its batch. */
export async function selectEnrichmentCandidates(
  pool: pg.Pool,
  options: DrugEnrichmentOptions,
): Promise<string[]> {
  const client = await pool.connect();
  try {
    return await candidateLicenses(client, options);
  } finally {
    client.release();
  }
}

async function candidateLicenses(
  client: pg.PoolClient,
  opts: DrugEnrichmentOptions,
): Promise<string[]> {
  if (opts.licenseIds && opts.licenseIds.length > 0) {
    const sql = opts.includeCancelled
      ? "SELECT license_id FROM drug.licenses WHERE license_id = ANY($1::text[]) ORDER BY license_id"
      : "SELECT license_id FROM drug.licenses WHERE license_id = ANY($1::text[]) AND is_active ORDER BY license_id";
    const res = await client.query<{ license_id: string }>(sql, [opts.licenseIds]);
    return res.rows.map((row) => row.license_id);
  }

  const statuses = ["pending", "partial_success"];
  if (opts.retryFailed) statuses.push("retryable_failed");
  let sql = `
    SELECT q.license_id
    FROM drug.enrichment_queue q
    JOIN drug.licenses l ON l.license_id = q.license_id
    WHERE q.status = ANY($1::text[])
      AND q.available_at <= NOW()
  `;
  const params: unknown[] = [statuses];
  if (!opts.includeCancelled) sql += " AND l.is_active ";
  sql += " ORDER BY q.priority DESC, q.queue_id ";
  if (opts.limit) {
    sql += " LIMIT $2 ";
    params.push(opts.limit);
  }
  const res = await client.query<{ license_id: string }>(sql, params);
  return res.rows.map((row) => row.license_id);
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

export async function loadDrugEnrichment(
  pool: pg.Pool,
  options: DrugEnrichmentOptions = {},
): Promise<void> {
  const crawler = new TFDACrawlerService(
    options.tfdaValues?.base_url ? String(options.tfdaValues.base_url) : null,
    options.tfdaValues?.http_timeout ? Number(options.tfdaValues.http_timeout) : null,
  );
  if (!minio.initialized()) await minio.initialize();

  const client = await pool.connect();
  let candidates: string[];
  try {
    candidates = await candidateLicenses(client, options);
  } finally {
    client.release();
  }

  if (candidates.length === 0) {
    logInfo("  Drug enrichment: no candidate licenses found.");
    return;
  }
  logInfo(`Running TFDA enrichment for ${candidates.length} license(s) ...`);

  let done = 0;
  for (const licenseId of candidates) {
    try {
      await enrichOneLicense(pool, crawler, licenseId);
    } catch (err) {
      const message = String(err instanceof Error ? err.message : err).slice(0, 500);
      logWarning(`  ${licenseId}: UNEXPECTED ERROR — ${message}`);
      try {
        const errClient = await pool.connect();
        try {
          await errClient.query(
            `UPDATE drug.enrichment_queue
             SET status = 'retryable_failed',
                 attempt_count = attempt_count + 1,
                 last_error_message = $2
             WHERE license_id = $1`,
            [licenseId, message],
          );
          await errClient.query(
            `UPDATE drug.import_license_state
             SET last_error_code = 'unexpected_exception',
                 last_error_message = $2,
                 updated_at = NOW()
             WHERE license_id = $1`,
            [licenseId, message],
          );
        } finally {
          errClient.release();
        }
      } catch (dbErr) {
        logWarning(`  ${licenseId}: failed to record error state: ${String(dbErr)}`);
      }
    }
    done += 1;
    if (options.onProgress) await options.onProgress(done, candidates.length, licenseId);
  }
}

async function enrichOneLicense(
  pool: pg.Pool,
  crawler: TFDACrawlerService,
  licenseId: string,
): Promise<void> {
  const now = new Date();
  const payload = await crawler.scrapeLicense(licenseId);

  const electronicErrors = stageErrors(payload, "electronic_insert:");
  const insertErrors = [
    ...stageErrors(payload, "insert_page:"),
    ...stageErrors(payload, "insert_download:"),
  ];
  const labelErrors = [
    ...stageErrors(payload, "label_page:"),
    ...stageErrors(payload, "label_download:"),
  ];
  const shapeErrors = stageErrors(payload, "shape_scrape:");

  const electronicStatus =
    payload.electronicInsert !== null
      ? "success"
      : electronicErrors.length > 0
        ? "retryable_failed"
        : "no_data";
  const insertStatus = stageStatus(payload.insertAssets.length, insertErrors.length > 0);
  const labelStatus = stageStatus(payload.labelAssets.length, labelErrors.length > 0);
  const shapeStatus = stageStatus(payload.appearanceRecords.length, shapeErrors.length > 0);

  // TFDA occasionally repeats a shape_id in the shape list, which would violate
  // appearance_records_pkey — dedupe both the rows and the source records so the
  // same images aren't uploaded twice.
  const seenAppearanceIds = new Set<string>();
  const appearanceRows = convertAppearanceRows(licenseId, payload.appearanceRecords).filter(
    (row) => {
      if (seenAppearanceIds.has(row.appearance_id)) return false;
      seenAppearanceIds.add(row.appearance_id);
      return true;
    },
  );
  const seenShapeIds = new Set<string>();
  const dedupedAppearanceRecords = payload.appearanceRecords.filter((record) => {
    if (seenShapeIds.has(record.shapeId)) return false;
    seenShapeIds.add(record.shapeId);
    return true;
  });
  const appearanceMap = new Map(appearanceRows.map((row) => [row.shape_id, row.appearance_id]));

  const allAssets: { asset: ScrapedAsset; appearanceId: string | null; assetId: string }[] = [];
  for (const asset of [...payload.insertAssets, ...payload.labelAssets]) {
    allAssets.push({
      asset,
      appearanceId: null,
      assetId: deterministicAssetId(
        licenseId,
        asset.assetType,
        asset.normalizedFilename,
        asset.sourceUrl,
      ),
    });
  }
  for (const record of dedupedAppearanceRecords) {
    const appearanceId = appearanceMap.get(record.shapeId) ?? null;
    for (const asset of record.images) {
      allAssets.push({
        asset,
        appearanceId,
        assetId: deterministicAssetId(
          licenseId,
          asset.assetType,
          asset.normalizedFilename,
          asset.sourceUrl,
        ),
      });
    }
  }

  const uploadedAssets: AssetRow[] = [];
  const uploadedVariants: AssetVariantRow[] = [];
  let storageFailures = 0;
  let latestInsertAssetId: string | null = null;
  let latestInsertUpload: number | null = null;

  for (const { asset, appearanceId, assetId } of allAssets) {
    const objectKey = plannedObjectKey(
      licenseId,
      asset.assetGroup,
      assetId,
      asset.normalizedFilename,
    );
    let locator: Record<string, string> = minio.buildLocator(objectKey);
    let storageStatus = "success";
    let lastErrorMessage = "";

    if (minio.enabled()) {
      try {
        locator = {
          ...locator,
          ...(await minio.uploadBytes({
            objectKey,
            data: asset.content,
            contentType: asset.mimeType,
          })),
        };
      } catch (err) {
        storageStatus = "retryable_failed";
        lastErrorMessage = String(err instanceof Error ? err.message : err);
        storageFailures += 1;
      }
    } else {
      storageStatus = "retryable_failed";
      lastErrorMessage = minio.initError() ?? "MinIO not configured";
      storageFailures += 1;
    }

    uploadedAssets.push(
      assetRowFromUploaded(licenseId, asset, {
        assetId,
        appearanceId,
        locator,
        storageStatus,
        lastErrorMessage,
      }),
    );

    if (asset.assetType === "shape_image") {
      const variantKind = "web";
      const variantId = deterministicVariantId(assetId, variantKind);
      const variantObjectKey = `drug/${licenseId}/${asset.assetGroup}/${assetId}/variants/web.webp`;
      let variantLocator: Record<string, string> = minio.buildLocator(variantObjectKey);
      let variantData: Buffer | null = null;
      let width: number | null = null;
      let height: number | null = null;
      let variantStatus = "success";
      let variantError = "";

      try {
        const rendered = await renderDrugWebImage(asset.content);
        variantData = rendered.data;
        width = rendered.width;
        height = rendered.height;
        if (!minio.enabled()) throw new Error(minio.initError() ?? "MinIO not configured");
        variantLocator = {
          ...variantLocator,
          ...(await minio.uploadBytes({
            objectKey: variantObjectKey,
            data: variantData,
            contentType: "image/webp",
          })),
        };
      } catch (err) {
        variantStatus = "retryable_failed";
        variantError = String(err instanceof Error ? err.message : err);
        logWarning("Drug image WebP generation failed", {
          license_id: licenseId,
          asset_id: assetId,
          error: variantError,
        });
      }

      uploadedVariants.push({
        variant_id: variantId,
        source_asset_id: assetId,
        variant_kind: variantKind,
        mime_type: "image/webp",
        width_px: width,
        height_px: height,
        size_bytes: variantData?.length ?? null,
        sha256: variantData ? createHash("sha256").update(variantData).digest("hex") : "",
        bucket: variantLocator.bucket ?? "",
        object_key: variantLocator.object_key ?? "",
        minio_uri: variantLocator.minio_uri ?? "",
        etag: variantLocator.etag ?? "",
        version_id: variantLocator.version_id ?? "",
        storage_status: variantStatus,
        last_error_message: variantError,
        stored_at: variantStatus === "success" ? new Date() : null,
      });
    }

    if (asset.assetType === "insert_pdf") {
      // Python compares against datetime.min for an undated asset, and ties go to
      // the later one (>=) — a -Infinity sentinel reproduces both.
      const parsed = parseDate(asset.uploadDate);
      const uploadTime = parsed ? parsed.getTime() : -Infinity;
      if (latestInsertUpload === null || uploadTime >= latestInsertUpload) {
        latestInsertUpload = uploadTime;
        latestInsertAssetId = assetId;
      }
    }
  }

  for (const row of uploadedAssets) {
    row.is_latest_for_analysis = row.asset_id === latestInsertAssetId;
  }

  const hasInsertAssets = uploadedAssets.some((row) => row.asset_type === "insert_pdf");
  const hasInsertAssetsStored = uploadedAssets.some(
    (row) => row.asset_type === "insert_pdf" && row.storage_status === "success",
  );

  let storageStatus: string;
  if (uploadedAssets.length === 0) storageStatus = "no_data";
  else if (storageFailures === 0) storageStatus = "success";
  else if (storageFailures < uploadedAssets.length) storageStatus = "partial_success";
  else storageStatus = "retryable_failed";

  const client = await pool.connect();
  try {
    const indexRow = await loadIndexRow(client, licenseId);
    if (indexRow === null) return;

    const appearanceRecordsForRecord = appearanceRows.map((row) => ({
      ...row,
      images: uploadedAssets.filter((asset) => asset.appearance_id === row.appearance_id),
    }));

    const normalizedRecord = buildDrugRecord(indexRow, {
      electronicInsert: payload.electronicInsert,
      insertAssets: uploadedAssets.filter((row) => row.asset_group === "insert"),
      labelAssets: uploadedAssets.filter((row) => row.asset_group === "label"),
      appearanceRecords: appearanceRecordsForRecord,
      sourceErrors: payload.errors,
      normalizedAt: now,
    });

    const atcRows = convertAtcRows(licenseId, payload.electronicInsert);
    const activeIngredients = (normalizedRecord.ingredients as Dict).active as Record<
      string,
      string
    >[];

    // What still has to happen depends on EI completeness and PDF availability:
    //   complete EI, no PDF        → fully enriched, OCR impossible
    //   PDF stored (any EI)        → OCR always wins on quality, so queue it
    //   PDF downloaded, not stored → retry storage before OCR
    //   no PDF, incomplete EI      → index-level quality is the best available
    // buildDrugRecord has already written a preliminary record in every case;
    // normalize_status='pending' is what tells the analysis job to re-normalize.
    const eiComplete = isEiComplete(payload.electronicInsert);
    let normalizeStatus: string;
    let ocrStatus: string;
    let analysisStatus: string;
    if (hasInsertAssetsStored) {
      normalizeStatus = "pending";
      ocrStatus = "pending";
      analysisStatus = "pending";
    } else if (hasInsertAssets) {
      normalizeStatus = "pending";
      ocrStatus = "retryable_failed";
      analysisStatus = "retryable_failed";
    } else if (eiComplete) {
      normalizeStatus = "success";
      ocrStatus = "no_data";
      analysisStatus = "no_data";
    } else {
      normalizeStatus = "success";
      ocrStatus = "no_data";
      analysisStatus = "no_data";
    }

    const anyRetryable = [
      electronicStatus,
      insertStatus,
      labelStatus,
      shapeStatus,
      storageStatus,
      ocrStatus,
      analysisStatus,
    ].some((status) => status === "retryable_failed");
    const anyPartial = [insertStatus, labelStatus, shapeStatus, storageStatus].some(
      (status) => status === "partial_success",
    );
    const queueStatus = anyRetryable
      ? "retryable_failed"
      : anyPartial
        ? "partial_success"
        : "success";

    await client.query("BEGIN");
    try {
      if (electronicStatus !== "retryable_failed") {
        await client.query("DELETE FROM drug.electronic_inserts WHERE license_id = $1", [licenseId]);
        if (payload.electronicInsert !== null) {
          const insert = payload.electronicInsert;
          const json = (key: string, fallback: unknown): string =>
            JSON.stringify(insert[key] ?? fallback);
          await client.query(
            `INSERT INTO drug.electronic_inserts (
               license_id, source_url, basic_info_json, manufacturers_json,
               sections_json, ingredients_json, atc_codes_json, label_pdfs_json,
               history_pdfs_json, public_pdfs_json, paper_pdfs_json,
               authorizations_json, raw_page_hash, scraped_at, parse_status,
               last_error_message
             )
             VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb,
                     $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb, $13, $14, $15, $16)`,
            [
              licenseId,
              insert.source_url ?? "",
              json("basic_info", {}),
              json("manufacturers", []),
              json("sections", {}),
              json("ingredients", {}),
              json("atc_codes", []),
              json("label_pdfs", []),
              json("history_pdfs", []),
              json("public_pdfs", []),
              json("paper_pdfs", []),
              json("authorizations", []),
              "",
              now,
              "success",
              "",
            ],
          );
        }
      }

      if (
        insertStatus !== "retryable_failed" ||
        labelStatus !== "retryable_failed" ||
        shapeStatus !== "retryable_failed"
      ) {
        await client.query("DELETE FROM drug.insert_analysis WHERE license_id = $1", [licenseId]);
        await client.query(
          `DELETE FROM drug.assets
           WHERE license_id = $1
             AND asset_group IN ('insert', 'label', 'shape', 'analysis')`,
          [licenseId],
        );
        await client.query("DELETE FROM drug.appearance_records WHERE license_id = $1", [licenseId]);

        for (const row of appearanceRows) {
          await client.query(
            `INSERT INTO drug.appearance_records (
               appearance_id, license_id, shape_id, appearance_no, detail_url,
               description, color, shape, scoring, symbol, size, imprint,
               raw_json, scraped_at
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14)
             ON CONFLICT (appearance_id) DO NOTHING`,
            [
              row.appearance_id,
              row.license_id,
              row.shape_id,
              row.appearance_no,
              row.detail_url,
              row.description,
              row.color,
              row.shape,
              row.scoring,
              row.symbol,
              row.size,
              row.imprint,
              JSON.stringify(row.raw_json),
              now,
            ],
          );
        }

        for (const row of uploadedAssets) {
          await client.query(
            `INSERT INTO drug.assets (
               asset_id, license_id, appearance_id, asset_type, asset_group,
               source_page, source_url, source_filename, normalized_filename,
               upload_date, mime_type, size_bytes, sha256, bucket, object_key,
               minio_uri, etag, version_id, download_status, storage_status,
               is_latest_for_analysis, retry_count, last_error_code,
               last_error_message, last_attempt_at, downloaded_at, stored_at
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
                     $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27)`,
            [
              row.asset_id,
              row.license_id,
              row.appearance_id,
              row.asset_type,
              row.asset_group,
              row.source_page,
              row.source_url,
              row.source_filename,
              row.normalized_filename,
              row.upload_date,
              row.mime_type,
              row.size_bytes,
              row.sha256,
              row.bucket,
              row.object_key,
              row.minio_uri,
              row.etag,
              row.version_id,
              row.download_status,
              row.storage_status,
              row.is_latest_for_analysis,
              row.retry_count,
              row.last_error_code,
              row.last_error_message,
              row.last_attempt_at,
              row.downloaded_at,
              row.stored_at,
            ],
          );
        }

        for (const row of uploadedVariants) {
          await client.query(
            `INSERT INTO drug.asset_variants (
               variant_id, source_asset_id, variant_kind, mime_type,
               width_px, height_px, size_bytes, sha256, bucket, object_key,
               minio_uri, etag, version_id, storage_status,
               last_error_message, stored_at
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
             ON CONFLICT (source_asset_id, variant_kind) DO UPDATE SET
               mime_type = EXCLUDED.mime_type,
               width_px = EXCLUDED.width_px,
               height_px = EXCLUDED.height_px,
               size_bytes = EXCLUDED.size_bytes,
               sha256 = EXCLUDED.sha256,
               bucket = EXCLUDED.bucket,
               object_key = EXCLUDED.object_key,
               minio_uri = EXCLUDED.minio_uri,
               etag = EXCLUDED.etag,
               version_id = EXCLUDED.version_id,
               storage_status = EXCLUDED.storage_status,
               last_error_message = EXCLUDED.last_error_message,
               stored_at = EXCLUDED.stored_at`,
            [
              row.variant_id,
              row.source_asset_id,
              row.variant_kind,
              row.mime_type,
              row.width_px,
              row.height_px,
              row.size_bytes,
              row.sha256,
              row.bucket,
              row.object_key,
              row.minio_uri,
              row.etag,
              row.version_id,
              row.storage_status,
              row.last_error_message,
              row.stored_at,
            ],
          );
        }
      }

      await client.query("DELETE FROM drug.ingredients WHERE license_id = $1", [licenseId]);
      await client.query("DELETE FROM drug.atc WHERE license_id = $1", [licenseId]);

      let sortOrder = 0;
      for (const item of activeIngredients) {
        sortOrder += 1;
        await client.query(
          `INSERT INTO drug.ingredients (
             license_id, name, amount, unit, raw_text, source, sort_order, raw_json
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
          [
            licenseId,
            item.name ?? "",
            item.amount ?? "",
            item.unit ?? "",
            item.raw_text ?? "",
            "normalized_record",
            sortOrder,
            JSON.stringify(item),
          ],
        );
      }
      for (const row of atcRows) {
        await client.query(
          `INSERT INTO drug.atc (license_id, code, name, source, raw_json)
           VALUES ($1, $2, $3, 'electronic_insert', $4::jsonb)`,
          row,
        );
      }

      const source = normalizedRecord.source as Dict;
      const quality = normalizedRecord.quality as Dict;
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
          JSON.stringify(normalizedRecord),
          source.primary_insert_source,
          quality.confidence,
          JSON.stringify(quality.missing_fields),
          JSON.stringify(quality.conflict_fields),
          JSON.stringify(source.errors),
          now,
        ],
      );

      await client.query(
        `UPDATE drug.import_license_state
         SET electronic_insert_status = $2,
             insert_pdf_status = $3,
             label_pdf_status = $4,
             shape_status = $5,
             storage_status = $6,
             normalize_status = $7,
             ocr_status = $8,
             analysis_status = $9,
             updated_at = $10,
             last_error_code = $11,
             last_error_message = $12
         WHERE license_id = $1`,
        [
          licenseId,
          electronicStatus,
          insertStatus,
          labelStatus,
          shapeStatus,
          storageStatus,
          normalizeStatus,
          ocrStatus,
          analysisStatus,
          now,
          anyRetryable ? "retryable_failed" : "",
          payload.errors[0] ?? "",
        ],
      );

      await client.query(
        `UPDATE drug.enrichment_queue
         SET status = $2,
             claimed_at = $3,
             claimed_by = $4,
             attempt_count = attempt_count + 1,
             last_error_message = $5
         WHERE license_id = $1`,
        [licenseId, queueStatus, now, "data-loader", payload.errors[0] ?? ""],
      );

      const stages: [string, string, string[]][] = [
        ["electronic_insert_scrape", electronicStatus, electronicErrors],
        ["insert_pdf_download", insertStatus, insertErrors],
        ["label_pdf_download", labelStatus, labelErrors],
        ["shape_scrape", shapeStatus, shapeErrors],
        [
          "object_upload",
          storageStatus,
          storageFailures === 0 ? [] : [`${storageFailures} asset(s) failed to upload`],
        ],
        ["normalize", normalizeStatus, []],
      ];
      for (const [stage, status, errors] of stages) {
        // 'pending' is a hand-off marker (normalize is deferred to the analysis
        // phase when a PDF must be OCR'd), not a completed transition — logging it
        // would show a misleading "normalize pending" in Recent Events even though
        // the stage later finishes 'success'. Only terminal outcomes are recorded.
        if (status === "pending") continue;
        await client.query(
          `INSERT INTO drug.import_stage_events (
             run_id, license_id, stage, from_status, to_status,
             error_code, error_message, payload, created_at
           )
           VALUES (NULL, $1, $2, NULL, $3, $4, $5, $6::jsonb, $7)`,
          [
            licenseId,
            stage,
            status,
            status === "retryable_failed" ? "retryable_failed" : "",
            errors.join("; "),
            JSON.stringify({ errors }),
            now,
          ],
        );
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  } finally {
    client.release();
  }

  logInfo(
    `  ${licenseId}: electronic=${electronicStatus}, insert=${insertStatus}, ` +
      `label=${labelStatus}, shape=${shapeStatus}, storage=${storageStatus}`,
  );
}
