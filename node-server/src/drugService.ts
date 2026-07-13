/**
 * Drug service — Taiwan FDA medication search and detail access.
 * Faithful port of the read surface of `src/drug_service.py`
 * (`search_by_*`, `get_drug_details`, `get_drug_asset_links`,
 * `identify_unknown_pill`). The MCP tool wrappers live in `mcp.ts`.
 *
 * The TFDA crawl / OCR / analysis loader pipeline is NOT ported here — it is
 * deferred to a later phase. MinIO presigning is also not wired in the Node
 * backend yet; `presigned_url` is emitted as `null` (same as the Python server
 * when MinIO is unconfigured), so asset-link output stays parity-faithful.
 */

import { query } from "./db.js";
import { logInfo } from "./logger.js";
import { normalizeLicenseToken } from "./fhirMedicationService.js";

// ---- Pill appearance synonym map (mirror `_PILL_FEATURE_SYNONYMS`) ----------
const PILL_FEATURE_SYNONYMS: Record<string, string[]> = {
  white: ["白", "白色"],
  yellow: ["黃", "黃色"],
  orange: ["橘", "橘色", "橙", "橙色"],
  pink: ["粉紅", "粉紅色"],
  red: ["紅", "紅色"],
  blue: ["藍", "藍色"],
  green: ["綠", "綠色"],
  brown: ["棕", "棕色", "褐", "褐色"],
  black: ["黑", "黑色"],
  round: ["圓", "圓形"],
  oval: ["橢圓", "橢圓形"],
  oblong: ["長橢圓", "長橢圓形"],
  capsule: ["膠囊", "膠囊形"],
  triangle: ["三角", "三角形"],
  square: ["方形", "正方形"],
  diamond: ["菱形"],
};

// ---- Shared SELECT/JOIN fragments (mirror `_BASE_SELECT` / `_BASE_JOINS`) ----
const BASE_SELECT = `
    l.license_id,
    l.chinese_name,
    l.english_name,
    l.indications_text,
    l.dosage_form,
    l.package,
    l.drug_category,
    l.applicant_name,
    l.manufacturer_name,
    l.is_active,
    l.cancellation_status,
    l.valid_until,
    n.primary_insert_source,
    n.quality_confidence,
    n.missing_fields,
    n.source_errors,
    s.index_status,
    s.electronic_insert_status,
    s.ocr_status,
    s.analysis_status,
    COALESCE(docs.insert_pdf_count, 0) AS insert_pdf_count,
    COALESCE(docs.label_pdf_count, 0) AS label_pdf_count,
    COALESCE(docs.has_analysis, FALSE) AS has_analysis,
    COALESCE(ei.has_electronic_insert, FALSE) AS has_electronic_insert
`;

const BASE_JOINS = `
    LEFT JOIN drug.normalized_records n ON n.license_id = l.license_id
    LEFT JOIN drug.import_license_state s ON s.license_id = l.license_id
    LEFT JOIN LATERAL (
        SELECT
            COUNT(*) FILTER (WHERE asset_type = 'insert_pdf') AS insert_pdf_count,
            COUNT(*) FILTER (WHERE asset_type = 'label_pdf') AS label_pdf_count,
            BOOL_OR(asset_type = 'analysis_json') AS has_analysis
        FROM drug.assets a
        WHERE a.license_id = l.license_id
          AND a.storage_status IN ('success', 'partial_success')
    ) docs ON TRUE
    LEFT JOIN LATERAL (
        SELECT TRUE AS has_electronic_insert
        FROM drug.electronic_inserts e
        WHERE e.license_id = l.license_id
        LIMIT 1
    ) ei ON TRUE
`;

const STATUS_FIELDS = [
  "index_status",
  "electronic_insert_status",
  "insert_pdf_status",
  "label_pdf_status",
  "shape_status",
  "storage_status",
  "ocr_status",
  "analysis_status",
  "normalize_status",
] as const;

const INACTIVE_NO_DATA_FIELDS = [
  "electronic_insert_status",
  "insert_pdf_status",
  "label_pdf_status",
  "shape_status",
  "storage_status",
  "ocr_status",
  "analysis_status",
] as const;

/** Mirror `drug_status_utils.display_drug_statuses`. */
function displayDrugStatuses(
  raw: Record<string, unknown>,
  isActive: boolean,
  hasNormalizedRecord: boolean,
): Record<string, string> {
  const statuses: Record<string, string> = {};
  // `str(value or "pending")` — falsy (null/undefined/""/0) → "pending".
  for (const field of STATUS_FIELDS) {
    statuses[field] = String((raw[field] as unknown) || "pending");
  }
  if (hasNormalizedRecord && statuses.normalize_status === "pending") {
    statuses.normalize_status = "success";
  }
  if (!isActive) {
    for (const field of INACTIVE_NO_DATA_FIELDS) {
      if (statuses[field] === "pending") statuses[field] = "no_data";
    }
  }
  return statuses;
}

/** Mirror `DrugService._maybe_json`: jsonb → object; string → parse; else fallback. */
function maybeJson<T>(value: unknown, fallback: T): T | unknown {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "object") return value;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }
  return fallback;
}

/** Format a DATE column the way Python `date.isoformat()` does ("YYYY-MM-DD"). */
function dateIso(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) {
    const p = (n: number) => String(n).padStart(2, "0");
    return `${value.getFullYear()}-${p(value.getMonth() + 1)}-${p(value.getDate())}`;
  }
  // node-pg may already hand back a string for DATE depending on parsers.
  return String(value);
}

function normalizeLimit(limit: number, maxLimit = 10): number {
  return Math.min(Math.max(1, limit), maxLimit);
}

interface DrugRow {
  license_id: string;
  chinese_name: string | null;
  english_name: string | null;
  indications_text: string | null;
  dosage_form: string | null;
  package: string | null;
  drug_category: string | null;
  applicant_name: string | null;
  manufacturer_name: string | null;
  is_active: boolean;
  cancellation_status: string | null;
  valid_until: unknown;
  primary_insert_source: string | null;
  quality_confidence: string | null;
  missing_fields: unknown;
  source_errors: unknown;
  index_status: string | null;
  electronic_insert_status: string | null;
  ocr_status: string | null;
  analysis_status: string | null;
  insert_pdf_count: number | string | null;
  label_pdf_count: number | string | null;
  has_analysis: boolean | null;
  has_electronic_insert: boolean | null;
}

export class DrugService {
  async initialize(): Promise<void> {
    const r = await query<{ count: string }>("SELECT COUNT(*) AS count FROM drug.licenses");
    const count = Number(r.rows[0]?.count ?? 0);
    if (count === 0) {
      logInfo("Drug DB empty — run loader --drug-index to load data");
    } else {
      logInfo("Drug Service ready", { licenses: count });
    }
  }

  private baseFilters(includeCancelled: boolean): string {
    return includeCancelled ? "l.is_listed" : "l.is_listed AND l.is_active";
  }

  private rowToResult(row: DrugRow): Record<string, unknown> {
    return {
      license_id: row.license_id,
      name_zh: row.chinese_name,
      name_en: row.english_name,
      indication: row.indications_text,
      dosage_form: row.dosage_form,
      package: row.package,
      drug_category: row.drug_category,
      applicant_name: row.applicant_name,
      manufacturer_name: row.manufacturer_name,
      is_active: row.is_active,
      cancellation_status: row.cancellation_status || "",
      valid_until: dateIso(row.valid_until),
      documents_summary: {
        insert_pdf_count: Number(row.insert_pdf_count ?? 0) || 0,
        label_pdf_count: Number(row.label_pdf_count ?? 0) || 0,
        has_electronic_insert: Boolean(row.has_electronic_insert),
        has_analysis: Boolean(row.has_analysis),
      },
      availability: {
        index_status: row.index_status || "pending",
        enrichment_status: row.electronic_insert_status || "pending",
        ocr_status: row.ocr_status || "pending",
        analysis_status: row.analysis_status || "pending",
      },
      quality: {
        confidence: row.quality_confidence || "low",
        missing_fields: maybeJson(row.missing_fields, []),
        errors: maybeJson(row.source_errors, []),
      },
      primary_insert_source: row.primary_insert_source || "index_only",
    };
  }

  private async runSearch(sql: string, params: unknown[]): Promise<{ results: unknown[] }> {
    const r = await query<DrugRow>(sql, params);
    return { results: r.rows.map((row) => this.rowToResult(row)) };
  }

  async searchByName(keyword: string, limit = 3, includeCancelled = false) {
    const lim = normalizeLimit(limit);
    const like = `%${keyword}%`;
    const filters = this.baseFilters(includeCancelled);
    const sql = `
            WITH ranked AS (
                SELECT
                    l.license_id,
                    CASE
                        WHEN COALESCE(l.chinese_name, '') = $1 OR COALESCE(l.english_name, '') = $1 THEN 0
                        WHEN COALESCE(l.chinese_name, '') ILIKE $2 OR COALESCE(l.english_name, '') ILIKE $2 THEN 1
                        WHEN COALESCE(l.indications_text, '') ILIKE $2 THEN 2
                        ELSE 3
                    END AS match_rank
                FROM drug.licenses l
                WHERE ${filters}
                  AND (
                    COALESCE(l.chinese_name, '') ILIKE $2
                    OR COALESCE(l.english_name, '') ILIKE $2
                    OR COALESCE(l.indications_text, '') ILIKE $2
                    OR to_tsvector(
                        'simple',
                        COALESCE(l.chinese_name, '') || ' ' ||
                        COALESCE(l.english_name, '') || ' ' ||
                        COALESCE(l.indications_text, '')
                    ) @@ websearch_to_tsquery('simple', $1)
                  )
            )
            SELECT ${BASE_SELECT}, ranked.match_rank
            FROM ranked
            JOIN drug.licenses l ON l.license_id = ranked.license_id
            ${BASE_JOINS}
            ORDER BY ranked.match_rank, l.is_active DESC, l.license_id
            LIMIT $3
        `;
    return this.runSearch(sql, [keyword, like, lim]);
  }

  async searchByIngredient(keyword: string, limit = 3, includeCancelled = false) {
    const lim = normalizeLimit(limit);
    const like = `%${keyword}%`;
    const filters = this.baseFilters(includeCancelled);
    const sql = `
            WITH ranked AS (
                SELECT
                    l.license_id,
                    MIN(
                        CASE
                            WHEN COALESCE(i.name, '') = $1 THEN 0
                            WHEN COALESCE(i.name, '') ILIKE $2 THEN 1
                            WHEN COALESCE(i.raw_text, '') ILIKE $2 THEN 2
                            ELSE 3
                        END
                    ) AS match_rank
                FROM drug.ingredients i
                JOIN drug.licenses l ON l.license_id = i.license_id
                WHERE ${filters}
                  AND (
                    COALESCE(i.name, '') ILIKE $2
                    OR COALESCE(i.raw_text, '') ILIKE $2
                    OR to_tsvector(
                        'simple',
                        COALESCE(i.name, '') || ' ' || COALESCE(i.raw_text, '')
                    ) @@ websearch_to_tsquery('simple', $1)
                  )
                GROUP BY l.license_id
            )
            SELECT ${BASE_SELECT}, ranked.match_rank
            FROM ranked
            JOIN drug.licenses l ON l.license_id = ranked.license_id
            ${BASE_JOINS}
            ORDER BY ranked.match_rank, l.is_active DESC, l.license_id
            LIMIT $3
        `;
    return this.runSearch(sql, [keyword, like, lim]);
  }

  async searchByLicenseId(keyword: string, limit = 3, includeCancelled = false) {
    const lim = normalizeLimit(limit);
    const like = `%${keyword}%`;
    const token = normalizeLicenseToken(keyword);
    const filters = this.baseFilters(includeCancelled);
    const sql = `
            SELECT ${BASE_SELECT}
            FROM drug.licenses l
            ${BASE_JOINS}
            WHERE ${filters}
              AND (
                l.license_id = $1
                OR l.license_token = $2
                OR l.license_id ILIKE $3
              )
            ORDER BY
                CASE
                    WHEN l.license_id = $1 THEN 0
                    WHEN l.license_token = $2 THEN 1
                    ELSE 2
                END,
                l.is_active DESC,
                l.license_id
            LIMIT $4
        `;
    return this.runSearch(sql, [keyword, token, like, lim]);
  }

  async searchByAtcCode(keyword: string, limit = 3, includeCancelled = false) {
    const lim = normalizeLimit(limit);
    const like = `%${keyword}%`;
    const filters = this.baseFilters(includeCancelled);
    const sql = `
            WITH ranked AS (
                SELECT
                    l.license_id,
                    MIN(
                        CASE
                            WHEN COALESCE(a.code, '') = $1 THEN 0
                            WHEN COALESCE(a.code, '') ILIKE $2 THEN 1
                            WHEN COALESCE(a.name, '') ILIKE $2 THEN 2
                            ELSE 3
                        END
                    ) AS match_rank
                FROM drug.atc a
                JOIN drug.licenses l ON l.license_id = a.license_id
                WHERE ${filters}
                  AND (
                    COALESCE(a.code, '') ILIKE $2
                    OR COALESCE(a.name, '') ILIKE $2
                  )
                GROUP BY l.license_id
            )
            SELECT ${BASE_SELECT}, ranked.match_rank
            FROM ranked
            JOIN drug.licenses l ON l.license_id = ranked.license_id
            ${BASE_JOINS}
            ORDER BY ranked.match_rank, l.is_active DESC, l.license_id
            LIMIT $3
        `;
    return this.runSearch(sql, [keyword, like, lim]);
  }

  async getDrugDetails(licenseId: string, includeCancelled = false): Promise<Record<string, unknown>> {
    const filters = this.baseFilters(includeCancelled);
    const r = await query<Record<string, unknown>>(
      `
                SELECT
                    l.is_active,
                    n.normalized_json,
                    s.index_status,
                    s.electronic_insert_status,
                    s.insert_pdf_status,
                    s.label_pdf_status,
                    s.shape_status,
                    s.storage_status,
                    s.ocr_status,
                    s.analysis_status,
                    s.normalize_status,
                    COALESCE(docs.insert_pdf_count, 0) AS insert_pdf_count,
                    COALESCE(docs.label_pdf_count, 0) AS label_pdf_count
                FROM drug.licenses l
                LEFT JOIN drug.normalized_records n ON n.license_id = l.license_id
                LEFT JOIN drug.import_license_state s ON s.license_id = l.license_id
                LEFT JOIN LATERAL (
                    SELECT
                        COUNT(*) FILTER (WHERE asset_type = 'insert_pdf') AS insert_pdf_count,
                        COUNT(*) FILTER (WHERE asset_type = 'label_pdf') AS label_pdf_count
                    FROM drug.assets a
                    WHERE a.license_id = l.license_id
                ) docs ON TRUE
                WHERE ${filters} AND l.license_id = $1
                `,
      [licenseId],
    );
    const row = r.rows[0];
    if (!row || row.normalized_json === null || row.normalized_json === undefined) {
      return { error: `Drug ${licenseId} not found`, license_id: licenseId };
    }
    return {
      license_id: licenseId,
      record: maybeJson(row.normalized_json, {}),
      availability: displayDrugStatuses(row, Boolean(row.is_active), true),
      documents_summary: {
        insert_pdf_count: Number(row.insert_pdf_count ?? 0) || 0,
        label_pdf_count: Number(row.label_pdf_count ?? 0) || 0,
      },
    };
  }

  async getDrugAssetLinks(opts: {
    license_id?: string | null;
    asset_id?: string | null;
    asset_group?: string | null;
    latest_insert_only?: boolean;
  }): Promise<Record<string, unknown>> {
    const { license_id = null, asset_id = null, asset_group = null, latest_insert_only = false } = opts;
    if (!license_id && !asset_id) {
      return { error: "Provide either license_id or asset_id" };
    }

    const params: unknown[] = [];
    const where: string[] = [];
    if (asset_id) {
      params.push(asset_id);
      where.push(`a.asset_id::text = $${params.length}`);
    }
    if (license_id) {
      params.push(license_id);
      where.push(`a.license_id = $${params.length}`);
    }
    if (asset_group) {
      params.push(asset_group);
      where.push(`a.asset_group = $${params.length}`);
    }
    if (latest_insert_only) {
      where.push("a.is_latest_for_analysis");
    }

    const sql = `
            SELECT
                a.asset_id::text AS asset_id,
                a.license_id,
                a.asset_type,
                a.asset_group,
                a.source_page,
                a.source_url,
                a.source_filename,
                a.normalized_filename,
                a.upload_date,
                a.mime_type,
                a.size_bytes,
                a.bucket,
                a.object_key,
                a.minio_uri,
                a.storage_status,
                a.download_status
            FROM drug.assets a
            WHERE ${where.join(" AND ")}
            ORDER BY a.asset_group, a.upload_date DESC NULLS LAST, a.normalized_filename
        `;
    const r = await query<Record<string, unknown>>(sql, params);

    const assets = r.rows.map((row) => {
      const objectKey = (row.object_key as string) || "";
      // MinIO presigning is not wired in the Node backend yet — emit null,
      // matching the Python server when MinIO is unconfigured.
      const presignedUrl: string | null = null;
      return {
        asset_id: row.asset_id,
        license_id: row.license_id,
        asset_type: row.asset_type,
        asset_group: row.asset_group,
        source_page: row.source_page,
        source_url: row.source_url,
        source_filename: row.source_filename,
        normalized_filename: row.normalized_filename,
        upload_date: dateIso(row.upload_date),
        mime_type: row.mime_type,
        size_bytes: row.size_bytes === null || row.size_bytes === undefined ? null : Number(row.size_bytes),
        storage_status: row.storage_status,
        download_status: row.download_status,
        minio: {
          bucket: (row.bucket as string) || "",
          object_key: objectKey,
          uri: (row.minio_uri as string) || "",
          presigned_url: presignedUrl,
        },
      };
    });

    return {
      license_id,
      asset_id,
      asset_group,
      latest_insert_only,
      assets,
    };
  }

  async identifyUnknownPill(features: string, limit = 5): Promise<Record<string, unknown>> {
    const lim = normalizeLimit(limit, 5);
    const tokens = features.trim().split(/\s+/).filter((t) => t);
    if (tokens.length === 0) {
      return { error: "features is required", results: [] };
    }

    const conditions: string[] = [];
    const params: unknown[] = [];
    for (const token of tokens) {
      const variants = new Set<string>([token]);
      for (const v of PILL_FEATURE_SYNONYMS[token.toLowerCase()] ?? []) variants.add(v);
      const perToken: string[] = [];
      for (const variant of variants) {
        params.push(`%${variant}%`);
        perToken.push(`search_blob ILIKE $${params.length}`);
      }
      conditions.push("(" + perToken.join(" OR ") + ")");
    }

    params.push(lim);
    const sql = `
            WITH appearances AS (
                SELECT
                    ar.appearance_id,
                    ar.license_id,
                    ar.appearance_no,
                    ar.description,
                    ar.color,
                    ar.shape,
                    ar.scoring,
                    ar.symbol,
                    ar.size,
                    ar.imprint,
                    l.chinese_name,
                    l.english_name,
                    (
                        COALESCE(ar.description, '') || ' ' ||
                        COALESCE(ar.color, '') || ' ' ||
                        COALESCE(ar.shape, '') || ' ' ||
                        COALESCE(ar.scoring, '') || ' ' ||
                        COALESCE(ar.symbol, '') || ' ' ||
                        COALESCE(ar.size, '') || ' ' ||
                        COALESCE(ar.imprint, '')
                    ) AS search_blob
                FROM drug.appearance_records ar
                JOIN drug.licenses l ON l.license_id = ar.license_id
                WHERE l.is_listed AND l.is_active
            )
            SELECT
                appearance_id::text,
                license_id,
                appearance_no,
                description,
                color,
                shape,
                scoring,
                symbol,
                size,
                imprint,
                chinese_name,
                english_name
            FROM appearances
            WHERE ${conditions.join(" AND ")}
            ORDER BY license_id, appearance_no
            LIMIT $${params.length}
        `;
    const r = await query<Record<string, unknown>>(sql, params);
    return {
      results: r.rows.map((row) => ({
        appearance_id: row.appearance_id,
        license_id: row.license_id,
        name_zh: row.chinese_name,
        name_en: row.english_name,
        appearance_no: row.appearance_no,
        description: row.description,
        color: row.color,
        shape: row.shape,
        scoring: row.scoring,
        symbol: row.symbol,
        size: row.size,
        imprint: row.imprint,
      })),
    };
  }
}
