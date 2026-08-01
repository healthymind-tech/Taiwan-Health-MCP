/**
 * Admin-side helpers for drug import pipeline visibility.
 *
 * Faithful port of `src/admin_drug.py` (+ `src/drug_status_utils.py`
 * `display_drug_statuses`). Covers the three pure-DB read endpoints:
 *   GET /admin/api/drug/status          → getDrugAdminStatus
 *   GET /admin/api/drug/pipeline-status → getDrugPipelineStatus
 *   GET /admin/api/drug/events          → getDrugLicenseEvents
 * (`/drug/details` reuses the MCP drug service; `/drug/assets` and
 * `/drug/asset-content` need MinIO and land with the MinIO port.)
 *
 * Parity notes:
 *  - `COUNT(*)` without a `::int` cast is Postgres bigint; node-pg decodes
 *    bigint to a string, so those values are `Number(...)`-coerced (Python
 *    wraps each in `int(... or 0)`). `COUNT(*)::int` already returns an int4
 *    JS number — left as-is.
 *  - Timestamps mirror Python's `_iso` (None → "", else `.isoformat()`): the
 *    column is rendered with `tsIsoExpr` (fixed-width UTC text) and fed through
 *    `pyIso`; null renders to "".
 */

import { query } from "../db.js";
import { tsIsoExpr, pyIso } from "./adminJobs.js";

// ── drug_status_utils.display_drug_statuses ────────────────────────────────────

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

/** Faithful port of `display_drug_statuses`. */
function displayDrugStatuses(
  raw: Record<string, unknown>,
  isActive: boolean,
  hasNormalizedRecord: boolean,
): Record<string, string> {
  const statuses: Record<string, string> = {};
  for (const field of STATUS_FIELDS) {
    statuses[field] = String(raw[field] || "pending");
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

// ── shared helpers ─────────────────────────────────────────────────────────────

/** Mirror `_iso`: None/null → "", else isoformat-equivalent. */
function iso(text: string | null | undefined): string {
  return text === null || text === undefined ? "" : pyIso(text);
}

/** Coerce a bigint-as-string (or null) COUNT to a number, mirroring `int(... or 0)`. */
function n(v: unknown): number {
  return Number(v ?? 0);
}

interface JobRow {
  job_id: string;
  status: string | null;
  current_step: string | null;
  created_at: string | null;
  updated_at: string | null;
}

function jobSnapshot(row: JobRow | undefined): Record<string, unknown> {
  if (row === undefined) {
    return {
      job_id: null,
      status: null,
      current_step: null,
      created_at: null,
      updated_at: null,
    };
  }
  return {
    job_id: row.job_id,
    status: row.status,
    current_step: row.current_step,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

const JOB_SELECT = (jobType: string): string => `
  SELECT job_id::text AS job_id, status, current_step,
         ${tsIsoExpr("created_at")} AS created_at,
         ${tsIsoExpr("updated_at")} AS updated_at
  FROM admin.import_jobs
  WHERE job_type = '${jobType}'
  ORDER BY created_at DESC
  LIMIT 1`;

// ── get_drug_pipeline_status ────────────────────────────────────────────────────

/** Faithful port of `get_drug_pipeline_status`. */
export async function getDrugPipelineStatus(): Promise<Record<string, unknown>> {
  // ── Phase 1: Index ──
  const totalLicenses = n(
    (await query<{ c: string }>("SELECT COUNT(*) AS c FROM drug.licenses WHERE is_listed")).rows[0]
      ?.c,
  );
  const lastIndexJob = (await query<JobRow>(JOB_SELECT("drug_index_import"))).rows[0];

  // ── Phase 2: Enrichment ──
  const eqRows = (
    await query<{ status: string; cnt: number }>(`
      SELECT eq.status, COUNT(*)::int AS cnt
      FROM drug.enrichment_queue eq
      JOIN drug.licenses l ON l.license_id = eq.license_id
      WHERE l.is_active
      GROUP BY eq.status`)
  ).rows;
  const eqCounts = new Map<string, number>();
  for (const r of eqRows) eqCounts.set(String(r.status), Number(r.cnt));
  const get = (k: string): number => eqCounts.get(k) ?? 0;
  const enrichmentPending = get("pending");
  const enrichmentDone = get("success") + get("partial_success");
  const enrichmentFailed = get("retryable_failed");
  let enrichmentTotal = 0;
  for (const v of eqCounts.values()) enrichmentTotal += v;
  const inactiveLicenses = n(
    (
      await query<{ c: string }>(
        "SELECT COUNT(*) AS c FROM drug.licenses WHERE is_listed AND NOT is_active",
      )
    ).rows[0]?.c,
  );
  const enrichedCounts = (
    await query<{ ei_only: number; pdf_analyzed: number; total_enriched: number }>(`
      SELECT
        COUNT(*) FILTER (WHERE primary_insert_source = 'electronic_insert')::int AS ei_only,
        COUNT(*) FILTER (WHERE primary_insert_source = 'pdf_insert')::int          AS pdf_analyzed,
        COUNT(*) FILTER (WHERE primary_insert_source != 'index_only')::int         AS total_enriched
      FROM drug.normalized_records`)
  ).rows[0];
  const enrichedLicenses = Number(enrichedCounts?.total_enriched ?? 0);
  const eiOnlyLicenses = Number(enrichedCounts?.ei_only ?? 0);
  const pdfAnalyzedLicenses = Number(enrichedCounts?.pdf_analyzed ?? 0);
  const needsOcrLicenses = n(
    (
      await query<{ c: string }>(`
        SELECT COUNT(*) AS c FROM drug.import_license_state
        WHERE ocr_status = 'pending' AND storage_status = 'success'`)
    ).rows[0]?.c,
  );
  const lastEnrichmentJob = (await query<JobRow>(JOB_SELECT("drug_enrichment"))).rows[0];

  // ── Phase 3: Analysis ──
  const ar = (
    await query<{ pending: number; done: number; failed: number; total: number }>(`
      SELECT
        COUNT(*) FILTER (
          WHERE ocr_status NOT IN ('success') OR analysis_status NOT IN ('success')
        )::int  AS pending,
        COUNT(*) FILTER (
          WHERE ocr_status = 'success' AND analysis_status = 'success'
        )::int  AS done,
        COUNT(*) FILTER (
          WHERE ocr_status = 'retryable_failed' OR analysis_status = 'retryable_failed'
        )::int  AS failed,
        COUNT(*)::int AS total
      FROM drug.insert_analysis`)
  ).rows[0];
  const analysisPending = Number(ar?.pending ?? 0);
  const analysisDone = Number(ar?.done ?? 0);
  const analysisFailed = Number(ar?.failed ?? 0);
  const analysisTotal = Number(ar?.total ?? 0);
  const unsubmittedAssets = n(
    (
      await query<{ c: string }>(`
        SELECT COUNT(*) AS c
        FROM drug.assets a
        WHERE a.is_latest_for_analysis
          AND NOT EXISTS (
              SELECT 1 FROM drug.insert_analysis ia
              WHERE ia.source_asset_id = a.asset_id
          )`)
    ).rows[0]?.c,
  );
  const lastAnalysisJob = (await query<JobRow>(JOB_SELECT("drug_analysis"))).rows[0];
  const lastPipelineJob = (await query<JobRow>(JOB_SELECT("drug_pipeline"))).rows[0];

  return {
    index: {
      total_licenses: totalLicenses,
      last_job: jobSnapshot(lastIndexJob),
    },
    // Unified view for the drug_pipeline job type (enrich+OCR+analyze as one
    // per-license unit): `drug.enrichment_queue.status` is reconciled after
    // both phases run (see loaders/drugPipeline.ts's reconcileQueueStatus), so
    // these counts are already the true end-to-end outcome per license — no
    // separate analysis-stage query needed the way the legacy `analysis`
    // block below has one. Kept alongside (not replacing) `enrichment`/
    // `analysis` so existing consumers of those two blocks are unaffected.
    pipeline: {
      queue_total: enrichmentTotal,
      queue_pending: enrichmentPending,
      queue_done: enrichmentDone,
      queue_failed: enrichmentFailed,
      is_complete: enrichmentPending === 0,
      last_job: jobSnapshot(lastPipelineJob),
    },
    enrichment: {
      queue_total: enrichmentTotal,
      queue_pending: enrichmentPending,
      queue_done: enrichmentDone,
      queue_failed: enrichmentFailed,
      enriched_licenses: enrichedLicenses,
      ei_only_licenses: eiOnlyLicenses,
      pdf_analyzed_licenses: pdfAnalyzedLicenses,
      needs_ocr_licenses: needsOcrLicenses,
      inactive_licenses: inactiveLicenses,
      is_complete: enrichmentPending === 0,
      last_job: jobSnapshot(lastEnrichmentJob),
    },
    analysis: {
      total: analysisTotal + unsubmittedAssets,
      pending: analysisPending + unsubmittedAssets,
      done: analysisDone,
      failed: analysisFailed,
      is_complete: analysisPending + unsubmittedAssets === 0,
      last_job: jobSnapshot(lastAnalysisJob),
    },
  };
}

// ── get_drug_license_events ─────────────────────────────────────────────────────

/** Faithful port of `get_drug_license_events`. */
export async function getDrugLicenseEvents(
  licenseId: string,
  limit = 50,
): Promise<Record<string, unknown>[]> {
  const cap = Math.max(1, Math.min(limit, 200));
  const rows = (
    await query<{
      stage: string | null;
      to_status: string | null;
      error_message: string | null;
      created_at: string | null;
    }>(
      `SELECT stage, to_status, error_message, ${tsIsoExpr("created_at")} AS created_at
         FROM drug.import_stage_events
        WHERE license_id = $1
        ORDER BY created_at DESC, event_id DESC
        LIMIT $2`,
      [licenseId, cap],
    )
  ).rows;
  return rows.map((row) => ({
    stage: row.stage || "",
    status: row.to_status || "",
    error_message: row.error_message || "",
    created_at: iso(row.created_at),
  }));
}

// ── get_drug_admin_status ───────────────────────────────────────────────────────

interface AdminStatusOptions {
  page?: number;
  perPage?: number;
  q?: string;
  activeOnly?: boolean;
  failedOnly?: boolean;
}

/** Faithful port of `get_drug_admin_status`. */
export async function getDrugAdminStatus(
  opts: AdminStatusOptions = {},
): Promise<Record<string, unknown>> {
  const page = Math.max(1, opts.page ?? 1);
  const perPage = Math.max(1, Math.min(opts.perPage ?? 50, 200));
  const q = opts.q ?? "";
  const activeOnly = opts.activeOnly ?? true;
  const failedOnly = opts.failedOnly ?? false;
  const offset = (page - 1) * perPage;

  const totalLicenses = n(
    (await query<{ c: string }>("SELECT COUNT(*) AS c FROM drug.licenses WHERE is_listed")).rows[0]
      ?.c,
  );
  const activeLicenses = n(
    (
      await query<{ c: string }>(
        "SELECT COUNT(*) AS c FROM drug.licenses WHERE is_listed AND is_active",
      )
    ).rows[0]?.c,
  );
  const queueRows = (
    await query<{ status: string; count: number }>(`
      SELECT eq.status, COUNT(*)::int AS count
      FROM drug.enrichment_queue eq
      JOIN drug.licenses l ON l.license_id = eq.license_id
      WHERE l.is_active
      GROUP BY eq.status`)
  ).rows;
  const queueCounts = new Map<string, number>();
  for (const r of queueRows) queueCounts.set(String(r.status), Number(r.count));

  const stateCounts =
    (
      await query<Record<string, number>>(`
        SELECT
          COUNT(*) FILTER (WHERE s.electronic_insert_status = 'retryable_failed')::int AS electronic_failed,
          COUNT(*) FILTER (WHERE s.insert_pdf_status = 'retryable_failed')::int AS insert_failed,
          COUNT(*) FILTER (WHERE s.label_pdf_status = 'retryable_failed')::int AS label_failed,
          COUNT(*) FILTER (WHERE s.shape_status = 'retryable_failed')::int AS shape_failed,
          COUNT(*) FILTER (WHERE s.storage_status = 'retryable_failed')::int AS storage_failed,
          COUNT(*) FILTER (WHERE s.ocr_status = 'retryable_failed')::int AS ocr_failed,
          COUNT(*) FILTER (WHERE s.analysis_status = 'retryable_failed')::int AS analysis_failed,
          COUNT(*) FILTER (WHERE s.normalize_status = 'retryable_failed')::int AS normalize_failed,
          COUNT(*) FILTER (WHERE s.electronic_insert_status = 'pending')::int AS electronic_pending,
          COUNT(*) FILTER (WHERE s.ocr_status = 'pending')::int AS ocr_pending,
          COUNT(*) FILTER (WHERE s.analysis_status = 'pending')::int AS analysis_pending
        FROM drug.import_license_state s
        JOIN drug.licenses l ON l.license_id = s.license_id
        WHERE l.is_active`)
    ).rows[0] ?? {};

  // Build parameterized WHERE clause for license query
  const params: unknown[] = [];
  const whereParts = ["l.is_listed"];
  if (activeOnly) whereParts.push("l.is_active");
  if (q) {
    params.push(`%${q}%`);
    const p = params.length;
    whereParts.push(
      `(l.license_id ILIKE $${p} OR l.chinese_name ILIKE $${p} OR l.english_name ILIKE $${p})`,
    );
  }
  const failedWhere = `(
      s.electronic_insert_status = 'retryable_failed'
      OR s.insert_pdf_status = 'retryable_failed'
      OR s.label_pdf_status = 'retryable_failed'
      OR s.shape_status = 'retryable_failed'
      OR s.storage_status = 'retryable_failed'
      OR s.ocr_status = 'retryable_failed'
      OR s.analysis_status = 'retryable_failed'
      OR s.normalize_status = 'retryable_failed'
      OR q.status = 'retryable_failed'
  )`;
  if (failedOnly) whereParts.push(failedWhere);
  const whereSql = whereParts.join(" AND ");

  const totalCount = n(
    (
      await query<{ c: string }>(
        `SELECT COUNT(*) AS c
           FROM drug.import_license_state s
           JOIN drug.licenses l ON l.license_id = s.license_id
           LEFT JOIN drug.enrichment_queue q ON q.license_id = s.license_id
          WHERE ${whereSql}`,
        params,
      )
    ).rows[0]?.c,
  );

  params.push(perPage);
  const limitParam = params.length;
  params.push(offset);
  const offsetParam = params.length;

  const licenseRows = (
    await query<Record<string, unknown>>(
      `SELECT
          l.license_id,
          l.chinese_name,
          l.english_name,
          l.is_active,
          s.index_status,
          s.electronic_insert_status,
          s.insert_pdf_status,
          s.label_pdf_status,
          s.shape_status,
          s.storage_status,
          s.ocr_status,
          s.analysis_status,
          s.normalize_status,
          s.last_error_code,
          s.last_error_message,
          ${tsIsoExpr("s.updated_at")} AS updated_at,
          q.status AS queue_status,
          q.reason AS queue_reason,
          q.attempt_count,
          e.stage AS last_event_stage,
          e.to_status AS last_event_status,
          e.error_message AS last_event_error_message,
          ${tsIsoExpr("e.created_at")} AS last_event_at,
          (SELECT COUNT(*) FROM drug.assets a WHERE a.license_id = l.license_id)::int AS asset_count
        FROM drug.import_license_state s
        JOIN drug.licenses l ON l.license_id = s.license_id
        LEFT JOIN drug.enrichment_queue q ON q.license_id = s.license_id
        LEFT JOIN LATERAL (
          SELECT stage, to_status, error_message, created_at
          FROM drug.import_stage_events ev
          WHERE ev.license_id = s.license_id
          ORDER BY ev.created_at DESC, ev.event_id DESC
          LIMIT 1
        ) e ON TRUE
        WHERE ${whereSql}
        ORDER BY
          l.is_active DESC,
          CASE
              WHEN s.analysis_status = 'retryable_failed' THEN 0
              WHEN s.ocr_status = 'retryable_failed' THEN 1
              WHEN s.storage_status = 'retryable_failed' THEN 2
              WHEN s.electronic_insert_status = 'retryable_failed' THEN 3
              WHEN q.status = 'pending' THEN 4
              ELSE 5
          END,
          s.updated_at DESC NULLS LAST,
          l.license_id
        LIMIT $${limitParam} OFFSET $${offsetParam}`,
      params,
    )
  ).rows;

  const licenses = licenseRows.map((row) => {
    const isActive = Boolean(row.is_active);
    return {
      license_id: row.license_id,
      name_zh: row.chinese_name || "",
      name_en: row.english_name || "",
      is_active: isActive,
      queue_status: row.queue_status || "",
      queue_reason: row.queue_reason || "",
      attempt_count: Number(row.attempt_count ?? 0),
      asset_count: Number(row.asset_count ?? 0),
      statuses: displayDrugStatuses(row, isActive, row.normalize_status === "success"),
      last_error_code: row.last_error_code || "",
      last_error_message: row.last_error_message || "",
      updated_at: iso(row.updated_at as string | null),
      last_event: {
        stage: row.last_event_stage || "",
        status: row.last_event_status || "",
        error_message: row.last_event_error_message || "",
        created_at: iso(row.last_event_at as string | null),
      },
    };
  });

  const eventRows = (
    await query<{
      license_id: string | null;
      stage: string | null;
      to_status: string | null;
      error_message: string | null;
      created_at: string | null;
      chinese_name: string | null;
    }>(`
      SELECT
        e.license_id,
        e.stage,
        e.to_status,
        e.error_message,
        ${tsIsoExpr("e.created_at")} AS created_at,
        l.chinese_name
      FROM drug.import_stage_events e
      LEFT JOIN drug.licenses l ON l.license_id = e.license_id
      ORDER BY e.created_at DESC, e.event_id DESC
      LIMIT 100`)
  ).rows;
  const recentEvents = eventRows.map((row) => ({
    license_id: row.license_id || "",
    name_zh: row.chinese_name || "",
    stage: row.stage || "",
    status: row.to_status || "",
    error_message: row.error_message || "",
    created_at: iso(row.created_at),
  }));

  const qc = (k: string): number => queueCounts.get(k) ?? 0;
  const sc = (k: string): number => Number(stateCounts[k] ?? 0);

  return {
    summary: {
      total_licenses: totalLicenses,
      active_licenses: activeLicenses,
      queue_counts: {
        pending: qc("pending"),
        success: qc("success"),
        partial_success: qc("partial_success"),
        retryable_failed: qc("retryable_failed"),
      },
      state_counts: {
        electronic_failed: sc("electronic_failed"),
        insert_failed: sc("insert_failed"),
        label_failed: sc("label_failed"),
        shape_failed: sc("shape_failed"),
        storage_failed: sc("storage_failed"),
        ocr_failed: sc("ocr_failed"),
        analysis_failed: sc("analysis_failed"),
        normalize_failed: sc("normalize_failed"),
        electronic_pending: sc("electronic_pending"),
        ocr_pending: sc("ocr_pending"),
        analysis_pending: sc("analysis_pending"),
      },
    },
    licenses,
    recent_events: recentEvents,
    pagination: {
      total: totalCount,
      page,
      per_page: perPage,
      total_pages: Math.max(1, Math.ceil(totalCount / perPage)),
    },
  };
}
