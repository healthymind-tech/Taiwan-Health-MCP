import { query } from "../db.js";
import { encodeLicenseId } from "../loaders/tfdaParserUtils.js";
import { pyIso, tsIsoExpr } from "./adminJobs.js";
import { logInfo } from "../logger.js";

const ASSET_TYPES = new Set([
  "insert_pdf",
  "label_pdf",
  "shape_image",
  "ocr_markdown",
  "analysis_json",
  "web_image",
]);

const STAGE_COLUMNS: Record<string, string> = {
  index: "index_status",
  electronic_insert: "electronic_insert_status",
  insert_pdf: "insert_pdf_status",
  label_pdf: "label_pdf_status",
  shape: "shape_status",
  storage: "storage_status",
  ocr: "ocr_status",
  analysis: "analysis_status",
  normalize: "normalize_status",
};

const PIPELINE_STAGES = [
  ["index_import", "index_status"],
  ["electronic_insert_scrape", "electronic_insert_status"],
  ["insert_pdf_download", "insert_pdf_status"],
  ["label_pdf_download", "label_pdf_status"],
  ["shape_scrape", "shape_status"],
  ["object_upload", "storage_status"],
  ["ocr", "ocr_status"],
  ["analysis", "analysis_status"],
  ["normalize", "normalize_status"],
] as const;

export interface DrugExplorerOptions {
  q?: string;
  active?: "active" | "inactive" | "all";
  assetTypes?: string[];
  assetMatch?: "any" | "all";
  missingAssetTypes?: string[];
  pipelineStatuses?: string[];
  stage?: string;
  stageStatuses?: string[];
  hasError?: boolean | null;
  manufacturer?: string;
  country?: string;
  dosageForm?: string;
  ingredient?: string;
  appearanceColor?: string;
  appearanceShape?: string;
  updatedFrom?: string;
  updatedTo?: string;
  documentFrom?: string;
  documentTo?: string;
  sort?: string;
  order?: "asc" | "desc";
  page?: number;
  perPage?: number;
}

function list(values: string[] | undefined, allowed?: Set<string>): string[] {
  return [...new Set((values ?? []).map((v) => v.trim()).filter((v) => v && (!allowed || allowed.has(v))))];
}

function assetExists(type: string, licenseExpr = "l.license_id"): string {
  if (type === "web_image") {
    return `EXISTS (
      SELECT 1 FROM drug.assets ax
      JOIN drug.asset_variants av ON av.source_asset_id = ax.asset_id
      WHERE ax.license_id = ${licenseExpr}
        AND ax.asset_type = 'shape_image'
        AND av.variant_kind = 'web' AND av.storage_status = 'success'
    )`;
  }
  return `EXISTS (
    SELECT 1 FROM drug.assets ax
    WHERE ax.license_id = ${licenseExpr}
      AND ax.asset_type = '${type}' AND ax.storage_status = 'success'
  )`;
}

function buildWhere(opts: DrugExplorerOptions): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const where = ["l.is_listed"];
  const add = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };

  const q = (opts.q ?? "").trim();
  if (q) {
    const p = add(`%${q}%`);
    where.push(`(
      l.license_id ILIKE ${p} OR l.chinese_name ILIKE ${p} OR l.english_name ILIKE ${p}
      OR l.manufacturer_name ILIKE ${p} OR l.main_ingredient_summary ILIKE ${p}
      OR EXISTS (SELECT 1 FROM drug.ingredients i WHERE i.license_id = l.license_id
                 AND (i.name ILIKE ${p} OR i.raw_text ILIKE ${p}))
    )`);
  }

  if ((opts.active ?? "active") === "active") where.push("l.is_active");
  if (opts.active === "inactive") where.push("NOT l.is_active");

  const assetTypes = list(opts.assetTypes, ASSET_TYPES);
  if (assetTypes.length > 0) {
    const checks = assetTypes.map((type) => assetExists(type));
    where.push(`(${checks.join(opts.assetMatch === "all" ? " AND " : " OR ")})`);
  }
  for (const type of list(opts.missingAssetTypes, ASSET_TYPES)) {
    where.push(`NOT (${assetExists(type)})`);
  }

  const pipelineStatuses = list(opts.pipelineStatuses);
  if (pipelineStatuses.length > 0) {
    const p = add(pipelineStatuses);
    where.push(`ARRAY[
      s.index_status, s.electronic_insert_status, s.insert_pdf_status,
      s.label_pdf_status, s.shape_status, s.storage_status,
      s.ocr_status, s.analysis_status, s.normalize_status
    ] && ${p}::text[]`);
  }
  const stageColumn = STAGE_COLUMNS[opts.stage ?? ""];
  const stageStatuses = list(opts.stageStatuses);
  if (stageColumn && stageStatuses.length > 0) {
    where.push(`s.${stageColumn} = ANY(${add(stageStatuses)}::text[])`);
  }
  if (opts.hasError === true) where.push("COALESCE(s.last_error_message, '') <> ''");
  if (opts.hasError === false) where.push("COALESCE(s.last_error_message, '') = ''");
  // manufacturer and dosage form are free-text (contains) so a partial name like
  // 永信 finds the drug even though the facet dropdown only shows the top 50.
  if (opts.manufacturer) {
    where.push(`l.manufacturer_name ILIKE ${add(`%${opts.manufacturer}%`)}`);
  }
  if (opts.dosageForm) {
    where.push(`l.dosage_form ILIKE ${add(`%${opts.dosageForm}%`)}`);
  }
  if (opts.country) where.push(`l.manufacturer_country = ${add(opts.country)}`);
  if (opts.ingredient) {
    const p = add(`%${opts.ingredient}%`);
    where.push(`(
      l.main_ingredient_summary ILIKE ${p}
      OR EXISTS (
        SELECT 1 FROM drug.ingredients i WHERE i.license_id = l.license_id AND i.name ILIKE ${p}
      )
    )`);
  }
  if (opts.appearanceColor) {
    where.push(`EXISTS (SELECT 1 FROM drug.appearance_records ar WHERE ar.license_id = l.license_id AND ar.color = ${add(opts.appearanceColor)})`);
  }
  if (opts.appearanceShape) {
    where.push(`EXISTS (SELECT 1 FROM drug.appearance_records ar WHERE ar.license_id = l.license_id AND ar.shape = ${add(opts.appearanceShape)})`);
  }
  if (opts.updatedFrom) where.push(`s.updated_at >= ${add(opts.updatedFrom)}::date`);
  if (opts.updatedTo) where.push(`s.updated_at < (${add(opts.updatedTo)}::date + INTERVAL '1 day')`);
  if (opts.documentFrom) {
    where.push(`EXISTS (SELECT 1 FROM drug.assets ad WHERE ad.license_id = l.license_id AND ad.asset_type IN ('insert_pdf','label_pdf') AND ad.upload_date >= ${add(opts.documentFrom)}::date)`);
  }
  if (opts.documentTo) {
    where.push(`EXISTS (SELECT 1 FROM drug.assets ad WHERE ad.license_id = l.license_id AND ad.asset_type IN ('insert_pdf','label_pdf') AND ad.upload_date <= ${add(opts.documentTo)}::date)`);
  }

  return { sql: where.join(" AND "), params };
}

function sortSql(opts: DrugExplorerOptions): string {
  const direction = opts.order === "asc" ? "ASC" : "DESC";
  const sort = opts.sort ?? (opts.q ? "relevance" : "work_priority");
  const options: Record<string, string> = {
    relevance: `CASE
      WHEN l.license_id = $SORT_Q$ THEN 0
      WHEN l.chinese_name ILIKE $SORT_PREFIX$ OR l.english_name ILIKE $SORT_PREFIX$ THEN 1
      ELSE 2 END ASC`,
    updated_at: `s.updated_at ${direction} NULLS LAST`,
    name_zh: `l.chinese_name ${direction} NULLS LAST`,
    name_en: `l.english_name ${direction} NULLS LAST`,
    license_id: `l.license_id ${direction}`,
    asset_count: `asset_stats.asset_count ${direction}`,
    latest_document: `asset_stats.latest_document_at ${direction} NULLS LAST`,
    pipeline_progress: `pipeline_progress ${direction}`,
    failed_first: `has_error DESC, s.updated_at DESC NULLS LAST`,
    missing_data: `missing_count ${direction}`,
    work_priority: `has_error DESC,
      CASE WHEN q.status = 'pending' THEN 0 WHEN q.status = 'retryable_failed' THEN 1 ELSE 2 END,
      s.updated_at DESC NULLS LAST`,
  };
  return `${options[sort] ?? options.work_priority}, l.license_id ASC`;
}

export async function getDrugExplorer(opts: DrugExplorerOptions = {}): Promise<Record<string, unknown>> {
  const page = Math.max(1, opts.page ?? 1);
  const perPage = Math.max(10, Math.min(opts.perPage ?? 25, 100));
  const offset = (page - 1) * perPage;
  const built = buildWhere(opts);
  const params = [...built.params];

  let ordering = sortSql(opts);
  if (ordering.includes("$SORT_Q$")) {
    params.push((opts.q ?? "").trim());
    ordering = ordering.replace("$SORT_Q$", `$${params.length}`);
    params.push(`${(opts.q ?? "").trim()}%`);
    ordering = ordering.replaceAll("$SORT_PREFIX$", `$${params.length}`);
  }
  params.push(perPage);
  const limitParam = params.length;
  params.push(offset);
  const offsetParam = params.length;

  const from = `
    FROM drug.licenses l
    LEFT JOIN drug.import_license_state s ON s.license_id = l.license_id
    LEFT JOIN drug.enrichment_queue q ON q.license_id = l.license_id
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS asset_count,
             MAX(a.stored_at) FILTER (WHERE a.asset_type IN ('insert_pdf', 'label_pdf')) AS latest_document_at
      FROM drug.assets a WHERE a.license_id = l.license_id AND a.storage_status = 'success'
    ) asset_stats ON TRUE`;

  // Facets and the total only need licenses + state; the per-drug lateral joins
  // (asset_stats, thumbnail, enrichment_queue) exist purely for the returned
  // result rows, so recomputing them inside the count/facet passes is wasted
  // work that scales with the whole filtered set (82k+ licenses).
  const lightFrom = `
    FROM drug.licenses l
    LEFT JOIN drug.import_license_state s ON s.license_id = l.license_id`;

  const rowsPromise = query<Record<string, unknown>>(
    `SELECT l.license_id, l.chinese_name AS name_zh, l.english_name AS name_en,
            l.is_active, l.dosage_form, l.manufacturer_name, l.manufacturer_country,
            s.index_status, s.electronic_insert_status, s.insert_pdf_status,
            s.label_pdf_status, s.shape_status, s.storage_status, s.ocr_status,
            s.analysis_status, s.normalize_status, s.last_error_message,
            ${tsIsoExpr("s.updated_at")} AS updated_at,
            COALESCE(asset_stats.asset_count, 0)::int AS asset_count,
            COALESCE((s.index_status = 'success')::int +
                     (s.electronic_insert_status IN ('success','no_data'))::int +
                     (s.insert_pdf_status IN ('success','no_data'))::int +
                     (s.label_pdf_status IN ('success','no_data'))::int +
                     (s.shape_status IN ('success','no_data'))::int +
                     (s.storage_status IN ('success','no_data'))::int +
                     (s.ocr_status IN ('success','no_data'))::int +
                     (s.analysis_status IN ('success','no_data'))::int +
                     (s.normalize_status = 'success')::int, 0) AS pipeline_progress,
            (COALESCE(s.last_error_message, '') <> '') AS has_error,
            (CASE WHEN s.electronic_insert_status IN ('pending','retryable_failed') THEN 1 ELSE 0 END +
             CASE WHEN s.insert_pdf_status IN ('pending','retryable_failed') THEN 1 ELSE 0 END +
             CASE WHEN s.shape_status IN ('pending','retryable_failed') THEN 1 ELSE 0 END +
             CASE WHEN s.ocr_status IN ('pending','retryable_failed') THEN 1 ELSE 0 END +
             CASE WHEN s.analysis_status IN ('pending','retryable_failed') THEN 1 ELSE 0 END) AS missing_count,
            thumb.asset_id::text AS thumbnail_asset_id,
            COALESCE(thumb.has_web, FALSE) AS thumbnail_has_web
       ${from}
       LEFT JOIN LATERAL (
         SELECT a.asset_id,
                EXISTS (SELECT 1 FROM drug.asset_variants av
                        WHERE av.source_asset_id = a.asset_id
                          AND av.variant_kind = 'web' AND av.storage_status = 'success') AS has_web
         FROM drug.assets a
         WHERE a.license_id = l.license_id AND a.asset_type = 'shape_image'
           AND a.storage_status = 'success'
         ORDER BY a.stored_at DESC NULLS LAST, a.asset_id
         LIMIT 1
       ) thumb ON TRUE
      WHERE ${built.sql}
      ORDER BY ${ordering}
      LIMIT $${limitParam} OFFSET $${offsetParam}`,
    params,
  );
  const facetPromise = query<Record<string, unknown>>(
    `WITH filtered AS (
       SELECT l.license_id, l.dosage_form, l.manufacturer_country, l.manufacturer_name
         ${lightFrom} WHERE ${built.sql}
     ),
     total AS (SELECT COUNT(*)::int AS n FROM filtered),
     kinds(asset_type) AS (
       VALUES ('insert_pdf'), ('label_pdf'), ('shape_image'), ('ocr_markdown'), ('analysis_json')
     ),
     asset_facets AS (
       SELECT kinds.asset_type, NULL::text AS value, COUNT(DISTINCT a.license_id)::int AS count
         FROM kinds
         LEFT JOIN drug.assets a ON a.asset_type = kinds.asset_type
           AND a.storage_status = 'success'
           AND EXISTS (SELECT 1 FROM filtered f WHERE f.license_id = a.license_id)
        GROUP BY kinds.asset_type
       UNION ALL
       SELECT 'web_image', NULL::text, COUNT(DISTINCT a.license_id)::int
         FROM filtered f
         JOIN drug.assets a ON a.license_id = f.license_id AND a.asset_type = 'shape_image'
         JOIN drug.asset_variants av ON av.source_asset_id = a.asset_id
           AND av.variant_kind = 'web' AND av.storage_status = 'success'
     ),
     value_facets AS (
       SELECT 'dosage_form' AS facet, dosage_form AS value, COUNT(*)::int AS count
         FROM filtered WHERE COALESCE(dosage_form, '') <> '' GROUP BY dosage_form
       UNION ALL
       SELECT 'country', manufacturer_country, COUNT(*)::int
         FROM filtered WHERE COALESCE(manufacturer_country, '') <> '' GROUP BY manufacturer_country
       UNION ALL
       SELECT 'manufacturer', manufacturer_name, COUNT(*)::int
         FROM filtered WHERE COALESCE(manufacturer_name, '') <> '' GROUP BY manufacturer_name
       UNION ALL
       SELECT 'appearance_color', ar.color, COUNT(DISTINCT ar.license_id)::int
         FROM drug.appearance_records ar JOIN filtered f ON f.license_id = ar.license_id
         WHERE COALESCE(ar.color, '') <> '' GROUP BY ar.color
       UNION ALL
       SELECT 'appearance_shape', ar.shape, COUNT(DISTINCT ar.license_id)::int
         FROM drug.appearance_records ar JOIN filtered f ON f.license_id = ar.license_id
         WHERE COALESCE(ar.shape, '') <> '' GROUP BY ar.shape
     ),
     ranked AS (
       SELECT *, ROW_NUMBER() OVER (PARTITION BY facet ORDER BY count DESC, value) AS rank
         FROM value_facets
     )
     SELECT 'total' AS facet, NULL::text AS value, (SELECT n FROM total) AS count
     UNION ALL
     SELECT asset_type AS facet, NULL::text, count FROM asset_facets
     UNION ALL
     SELECT facet, value, count FROM ranked WHERE rank <= 50
     ORDER BY facet`,
    built.params,
  );

  const [rowsResult, facetResult] = await Promise.all([rowsPromise, facetPromise]);
  let total = 0;
  const assetFacets: Record<string, number> = {};
  const valueFacets: Record<string, Array<{ value: string; count: number }>> = {};
  for (const row of facetResult.rows) {
    const facet = String(row.facet);
    const count = Number(row.count);
    if (facet === "total") {
      total = count;
      continue;
    }
    if (row.value === null) {
      assetFacets[facet] = count;
      continue;
    }
    (valueFacets[facet] ??= []).push({ value: String(row.value), count });
  }

  return {
    drugs: rowsResult.rows.map((row) => ({
      ...row,
      statuses: Object.fromEntries(
        Object.values(STAGE_COLUMNS).map((column) => [column, String(row[column] ?? "pending")]),
      ),
      thumbnail_url: row.thumbnail_asset_id
        ? `/admin/api/drug/asset-content?asset_id=${row.thumbnail_asset_id}${row.thumbnail_has_web ? "&variant=web" : ""}`
        : null,
    })),
    pagination: { total, page, per_page: perPage, total_pages: Math.max(1, Math.ceil(total / perPage)) },
    facets: { asset_types: assetFacets, ...valueFacets },
  };
}

function iso(value: string | null): string {
  return value ? pyIso(value) : "";
}

// The explorer searches with `ILIKE '%q%'` (contains), which a btree index cannot
// serve. Trigram GIN indexes cover the contains match for CJK names (≥3 chars)
// and Latin names alike. Idempotent — CREATE INDEX IF NOT EXISTS makes it safe to
// run on every boot; fresh installs get the same indexes from db/schema.sql.
export async function ensureDrugExplorerIndexes(): Promise<void> {
  await query(`
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
    CREATE INDEX IF NOT EXISTS idx_drug_license_id_trgm
      ON drug.licenses USING gin (license_id gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS idx_drug_chinese_name_trgm
      ON drug.licenses USING gin (chinese_name gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS idx_drug_english_name_trgm
      ON drug.licenses USING gin (english_name gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS idx_drug_manufacturer_name_trgm
      ON drug.licenses USING gin (manufacturer_name gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS idx_drug_ingredient_summary_trgm
      ON drug.licenses USING gin (main_ingredient_summary gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS idx_drug_ingredients_name_trgm
      ON drug.ingredients USING gin (name gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS idx_drug_ingredients_raw_text_trgm
      ON drug.ingredients USING gin (raw_text gin_trgm_ops);
  `);
  logInfo("Drug explorer trigram indexes ensured");
}

export async function getDrugExplorerDetail(licenseId: string): Promise<Record<string, unknown> | null> {
  const drugResult = await query<Record<string, unknown>>(
    `SELECT l.*, nr.normalized_json, nr.quality_confidence, nr.missing_fields,
            nr.conflict_fields, nr.source_errors, ei.source_url AS tfda_url,
            s.index_status, s.electronic_insert_status, s.insert_pdf_status,
            s.label_pdf_status, s.shape_status, s.storage_status, s.ocr_status,
            s.analysis_status, s.normalize_status, s.last_error_code,
            s.last_error_message, ${tsIsoExpr("s.updated_at")} AS pipeline_updated_at
       FROM drug.licenses l
       LEFT JOIN drug.normalized_records nr ON nr.license_id = l.license_id
       LEFT JOIN drug.electronic_inserts ei ON ei.license_id = l.license_id
       LEFT JOIN drug.import_license_state s ON s.license_id = l.license_id
      WHERE l.license_id = $1 AND l.is_listed`,
    [licenseId],
  );
  const drug = drugResult.rows[0];
  if (!drug) return null;

  const [appearanceResult, documentResult, assetResult, eventResult] = await Promise.all([
    query<Record<string, unknown>>(
      `SELECT ar.appearance_id::text, ar.appearance_no, ar.description, ar.color,
              ar.shape, ar.scoring, ar.symbol, ar.size, ar.imprint, ar.detail_url,
              a.asset_id::text AS image_asset_id, a.source_filename,
              (av.storage_status = 'success') AS has_web,
              av.width_px, av.height_px
         FROM drug.appearance_records ar
         LEFT JOIN drug.assets a ON a.appearance_id = ar.appearance_id
           AND a.asset_type = 'shape_image' AND a.storage_status = 'success'
         LEFT JOIN drug.asset_variants av ON av.source_asset_id = a.asset_id
           AND av.variant_kind = 'web'
        WHERE ar.license_id = $1
        ORDER BY ar.appearance_no NULLS LAST, ar.shape_id, a.source_filename`,
      [licenseId],
    ),
    query<Record<string, unknown>>(
      `SELECT src.asset_id::text AS source_asset_id, src.asset_type, src.source_filename,
              src.normalized_filename, src.mime_type, src.size_bytes,
              src.upload_date::text, src.source_url, src.storage_status,
              ocr.asset_id::text AS ocr_asset_id, ocr.source_filename AS ocr_filename,
              analysis.asset_id::text AS analysis_asset_id,
              analysis.source_filename AS analysis_filename,
              ia.ocr_status, ia.analysis_status, ia.completed_at::text
         FROM drug.assets src
         LEFT JOIN drug.insert_analysis ia ON ia.source_asset_id = src.asset_id
         LEFT JOIN drug.assets ocr ON ocr.asset_id = ia.ocr_asset_id
         LEFT JOIN drug.assets analysis ON analysis.asset_id = ia.analysis_asset_id
        WHERE src.license_id = $1 AND src.asset_type IN ('insert_pdf', 'label_pdf')
        ORDER BY src.asset_type, src.upload_date DESC NULLS LAST, src.source_filename`,
      [licenseId],
    ),
    query<Record<string, unknown>>(
      `SELECT asset_id::text, asset_type, asset_group, source_filename,
              normalized_filename, mime_type, size_bytes, upload_date::text,
              source_url, storage_status
         FROM drug.assets
        WHERE license_id = $1
        ORDER BY asset_group, upload_date DESC NULLS LAST, source_filename`,
      [licenseId],
    ),
    query<Record<string, unknown>>(
      `SELECT event_id, stage, from_status, to_status AS status,
              error_code, error_message, payload,
              ${tsIsoExpr("created_at")} AS created_at
         FROM drug.import_stage_events
        WHERE license_id = $1
        ORDER BY created_at ASC, event_id ASC`,
      [licenseId],
    ),
  ]);

  const appearancesById = new Map<string, Record<string, unknown>>();
  for (const row of appearanceResult.rows) {
    const id = String(row.appearance_id);
    let appearance = appearancesById.get(id);
    if (!appearance) {
      appearance = { ...row, images: [] };
      delete appearance.image_asset_id;
      delete appearance.source_filename;
      delete appearance.has_web;
      appearancesById.set(id, appearance);
    }
    if (row.image_asset_id) {
      (appearance.images as unknown[]).push({
        asset_id: row.image_asset_id,
        filename: row.source_filename,
        preview_url: `/admin/api/drug/asset-content?asset_id=${row.image_asset_id}${row.has_web ? "&variant=web" : ""}`,
        original_url: `/admin/api/drug/asset-content?asset_id=${row.image_asset_id}`,
        width: row.width_px,
        height: row.height_px,
      });
    }
  }

  const events: Record<string, unknown>[] = eventResult.rows.map((row) => ({
    ...row,
    created_at: iso(row.created_at as string | null),
  }));
  const currentStages = PIPELINE_STAGES.map(([stage, column]) => ({
    stage,
    status: String(drug[column] ?? "pending"),
    events: events.filter((event) => event.stage === stage),
  }));
  const baseUrl = (process.env.DRUG_TFDA_BASE_URL || "https://mcp.fda.gov.tw").replace(/\/+$/, "");

  return {
    drug: {
      ...drug,
      normalized_record: drug.normalized_json ?? null,
      tfda_url: drug.tfda_url || `${baseUrl}/im_detail_1/${encodeLicenseId(licenseId)}`,
    },
    appearances: [...appearancesById.values()],
    documents: documentResult.rows,
    assets: assetResult.rows,
    timeline: { stages: currentStages, events },
  };
}
