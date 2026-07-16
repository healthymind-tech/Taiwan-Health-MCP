/**
 * Admin-side read surface + upload glue for the Clinical Guideline PDF pipeline.
 *
 * Mirrors `adminDrug.ts`'s split: this module is purely read-side (status /
 * pipeline-status / listing) plus the small "register an already-uploaded PDF"
 * step that turns a generic `admin.uploaded_files` row into a
 * `guideline.source_documents` row. No ICD code is declared here — the
 * Analysis LM determines the disease(s)/ICD code(s) from the document content
 * itself (see `guidelineAnalysisService.ts`), and one PDF can fan out into
 * several `document_analysis` rows. Review/approve/reject write logic lives in
 * `guidelineReview.ts` — kept separate because it is the safety-critical,
 * transactional piece and benefits from being easy to find in isolation.
 */

import { query, withTransaction } from "../db.js";
import { tsIsoExpr, pyIso } from "./adminJobs.js";
import * as minio from "../minioService.js";
import { config } from "../config.js";
import {
  catalogEntry,
  createUploadedSource,
  validateSourceContent,
  validateSourceFilename,
} from "./adminSources.js";
import { fetchUrlSafely, UrlFetchError } from "./safeUrlFetch.js";

function iso(text: string | null | undefined): string {
  return text === null || text === undefined ? "" : pyIso(text);
}

function n(v: unknown): number {
  return Number(v ?? 0);
}

export class GuidelineValueError extends Error {}

/** Exact-match check against the loaded ICD-10-CM dataset — the safety net for LLM-determined ICD codes, used both to flag extractions for review (display hint) and to hard-block approval in `guidelineReview.ts`. */
export async function icdCodeExists(code: string): Promise<boolean> {
  const trimmed = code.trim();
  if (!trimmed) return false;
  const res = await query<{ found: number }>(
    "SELECT 1 AS found FROM icd.diagnoses WHERE code = $1 LIMIT 1",
    [trimmed],
  );
  return res.rows.length > 0;
}

/** Register an already-uploaded PDF (via the generic `POST /admin/api/uploads` endpoint) as a `guideline.source_documents` row the analysis pipeline picks up. No ICD code or disease name is declared here — that's for the Analysis LM to determine. */
export async function registerGuidelineSourceDocument(opts: {
  uploadedFileId: string;
  uploadedBy: string;
}): Promise<Record<string, unknown>> {
  const fileRes = await query<Record<string, unknown>>(
    `SELECT uploaded_file_id::text AS uploaded_file_id, original_filename, bucket, object_key,
            minio_uri, sha256, size_bytes
     FROM admin.uploaded_files
     WHERE uploaded_file_id = $1::uuid AND module_key = 'guideline' AND source_role = 'guideline_pdf'`,
    [opts.uploadedFileId],
  );
  const file = fileRes.rows[0];
  if (!file) {
    throw new GuidelineValueError(
      "uploaded_file_id was not found, or was not uploaded under module 'guideline' / role 'guideline_pdf'",
    );
  }

  const documentId = await withTransaction(async (client) => {
    const id = (await client.query<{ document_id: string }>(
      `INSERT INTO guideline.source_documents (
         document_id, uploaded_file_id, source_filename,
         bucket, object_key, minio_uri, sha256, size_bytes, pipeline_stage, uploaded_by, uploaded_at
       )
       VALUES (gen_random_uuid(), $1::uuid, $2, $3, $4, $5, $6, $7, 'queued', $8, NOW())
       RETURNING document_id::text AS document_id`,
      [
        file.uploaded_file_id,
        file.original_filename,
        file.bucket,
        file.object_key,
        file.minio_uri,
        file.sha256,
        file.size_bytes === null || file.size_bytes === undefined ? null : Number(file.size_bytes),
        opts.uploadedBy,
      ],
    )).rows[0].document_id;
    await client.query(
      `INSERT INTO admin.admin_audit_log (admin_user, action, target_type, target_id, payload_json)
       VALUES ($1, 'create_guideline_source_document', 'guideline_source_document', $2, $3::jsonb)`,
      [opts.uploadedBy, id, JSON.stringify({ uploaded_file_id: file.uploaded_file_id })],
    );
    return id;
  });

  return getGuidelineDocument(documentId);
}

/**
 * Same end result as `registerGuidelineSourceDocument`, but the PDF is fetched
 * server-side from an admin-supplied URL instead of uploaded from the browser.
 * Runs the identical filename/magic-byte validation the generic upload route
 * runs (`POST /admin/api/uploads`) before handing the bytes to
 * `createUploadedSource` — `fetchUrlSafely` only guards the network fetch
 * itself (SSRF), it says nothing about whether the fetched bytes are actually
 * a PDF.
 */
export async function registerGuidelineSourceDocumentFromUrl(opts: {
  url: string;
  uploadedBy: string;
}): Promise<Record<string, unknown>> {
  const url = opts.url.trim();
  if (!url) throw new GuidelineValueError("url is required");

  const maxBytes = Math.max(config().adminMaxUploadMb, 1) * 1024 * 1024;
  let fetched;
  try {
    fetched = await fetchUrlSafely(url, { maxBytes });
  } catch (err) {
    if (err instanceof UrlFetchError) throw new GuidelineValueError(err.message);
    throw err;
  }

  const entry = catalogEntry("guideline", "guideline_pdf");
  const filename = fetched.filename.toLowerCase().endsWith(".pdf") ? fetched.filename : `${fetched.filename}.pdf`;
  validateSourceFilename(filename, entry);
  validateSourceContent(fetched.data, entry);

  const { uploaded_file } = await createUploadedSource({
    moduleKey: "guideline",
    sourceRole: "guideline_pdf",
    originalFilename: filename,
    mimeType: fetched.contentType,
    data: fetched.data,
    uploadedBy: opts.uploadedBy,
    autoActivate: true,
  });

  return registerGuidelineSourceDocument({
    uploadedFileId: String(uploaded_file.uploaded_file_id),
    uploadedBy: opts.uploadedBy,
  });
}

export async function getGuidelineDocument(documentId: string): Promise<Record<string, unknown>> {
  const res = await query<Record<string, unknown>>(
    `SELECT d.document_id::text AS document_id, d.source_filename, d.pipeline_stage, d.uploaded_by,
            ${tsIsoExpr("d.uploaded_at")} AS uploaded_at_iso,
            COUNT(da.analysis_id)::int AS extraction_count,
            COALESCE(
              array_agg(da.extracted_icd_code ORDER BY da.extracted_icd_code)
                FILTER (WHERE da.extracted_icd_code IS NOT NULL),
              '{}'
            ) AS extracted_codes
     FROM guideline.source_documents d
     LEFT JOIN guideline.document_analysis da ON da.document_id = d.document_id
     WHERE d.document_id = $1::uuid
     GROUP BY d.document_id, d.source_filename, d.pipeline_stage, d.uploaded_by, d.uploaded_at`,
    [documentId],
  );
  const row = res.rows[0];
  if (!row) throw new GuidelineValueError(`Document not found: ${documentId}`);
  return { ...row, uploaded_at: iso(row.uploaded_at_iso as string | null), uploaded_at_iso: undefined };
}

export interface GuidelineAdminStatusOptions {
  page?: number;
  perPage?: number;
  icdCode?: string;
  stage?: string;
}

/** `GET /admin/api/guideline/status` — paginated source-document listing, with a per-document rollup of its extractions (a document can now own several, one per disease). */
export async function getGuidelineAdminStatus(
  opts: GuidelineAdminStatusOptions = {},
): Promise<Record<string, unknown>> {
  const page = Math.max(1, opts.page ?? 1);
  const perPage = Math.max(1, Math.min(opts.perPage ?? 50, 200));
  const offset = (page - 1) * perPage;

  const params: unknown[] = [];
  const where: string[] = [];
  if (opts.icdCode) {
    params.push(`%${opts.icdCode}%`);
    where.push(
      `EXISTS (SELECT 1 FROM guideline.document_analysis da2 ` +
        `WHERE da2.document_id = d.document_id AND da2.extracted_icd_code ILIKE $${params.length})`,
    );
  }
  if (opts.stage) {
    params.push(opts.stage);
    where.push(`d.pipeline_stage = $${params.length}`);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const totalRes = await query<{ c: string }>(
    `SELECT COUNT(*) AS c FROM guideline.source_documents d ${whereSql}`,
    params,
  );
  params.push(perPage);
  params.push(offset);
  const rowsRes = await query<Record<string, unknown>>(
    `SELECT d.document_id::text AS document_id, d.source_filename, d.pipeline_stage, d.uploaded_by,
            ${tsIsoExpr("d.uploaded_at")} AS uploaded_at_iso,
            COUNT(da.analysis_id)::int AS extraction_count,
            COALESCE(
              array_agg(da.extracted_icd_code ORDER BY da.extracted_icd_code)
                FILTER (WHERE da.extracted_icd_code IS NOT NULL),
              '{}'
            ) AS extracted_codes,
            COUNT(*) FILTER (WHERE da.review_status = 'pending_review')::int AS pending_review_count,
            COUNT(*) FILTER (WHERE da.review_status = 'approved')::int AS approved_count,
            COUNT(*) FILTER (WHERE da.review_status = 'rejected')::int AS rejected_count
     FROM guideline.source_documents d
     LEFT JOIN guideline.document_analysis da ON da.document_id = d.document_id
     ${whereSql}
     GROUP BY d.document_id, d.source_filename, d.pipeline_stage, d.uploaded_by, d.uploaded_at
     ORDER BY d.uploaded_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  return {
    total: n(totalRes.rows[0]?.c),
    page,
    per_page: perPage,
    documents: rowsRes.rows.map((row) => ({
      ...row,
      uploaded_at: iso(row.uploaded_at_iso as string | null),
      uploaded_at_iso: undefined,
    })),
  };
}

const JOB_SELECT = `
  SELECT job_id::text AS job_id, status, current_step,
         ${tsIsoExpr("created_at")} AS created_at,
         ${tsIsoExpr("updated_at")} AS updated_at
  FROM admin.import_jobs
  WHERE job_type = 'guideline_analysis'
  ORDER BY created_at DESC
  LIMIT 1`;

/** `GET /admin/api/guideline/pipeline-status` — stage counts + last job snapshot. */
export async function getGuidelinePipelineStatus(): Promise<Record<string, unknown>> {
  const stageRows = (
    await query<{ pipeline_stage: string; count: string }>(
      "SELECT pipeline_stage, COUNT(*)::int AS count FROM guideline.source_documents GROUP BY pipeline_stage",
    )
  ).rows;
  const stageCounts: Record<string, number> = {};
  for (const row of stageRows) stageCounts[row.pipeline_stage] = n(row.count);

  const pendingReview = n(
    (
      await query<{ c: string }>(
        "SELECT COUNT(*) AS c FROM guideline.document_analysis WHERE review_status = 'pending_review'",
      )
    ).rows[0]?.c,
  );
  const liveGuidelines = n(
    (await query<{ c: string }>("SELECT COUNT(*) AS c FROM guideline.disease_guidelines")).rows[0]
      ?.c,
  );
  const lastJobRow = (await query<Record<string, unknown>>(JOB_SELECT)).rows[0];

  return {
    stage_counts: stageCounts,
    pending_review: pendingReview,
    live_guidelines: liveGuidelines,
    last_job: lastJobRow
      ? {
          job_id: lastJobRow.job_id,
          status: lastJobRow.status,
          current_step: lastJobRow.current_step,
          created_at: iso(lastJobRow.created_at as string | null),
          updated_at: iso(lastJobRow.updated_at as string | null),
        }
      : null,
  };
}

export type GuidelineAssetKind = "pdf" | "ocr";

const KIND_MIME: Record<GuidelineAssetKind, string> = {
  pdf: "application/pdf",
  ocr: "text/markdown; charset=utf-8",
};

/**
 * Stream one of a document's shared artefacts (the raw PDF, or the OCR
 * Markdown — both are one-per-PDF, produced once regardless of how many
 * diseases the document was split into) from MinIO, same-origin proxy
 * pattern as `getDrugAssetContent`. Only object keys already recorded
 * against this exact document are ever read — the caller never supplies an
 * object key directly. For the per-extraction analysis JSON, see
 * `getGuidelineAnalysisAssetContent`.
 */
export async function getGuidelineAssetContent(
  documentId: string,
  kind: GuidelineAssetKind,
): Promise<{ data: Buffer; mimeType: string; filename: string } | null> {
  const res = await query<Record<string, unknown>>(
    `SELECT d.object_key AS pdf_object_key, d.source_filename, da.ocr_object_key
     FROM guideline.source_documents d
     LEFT JOIN guideline.document_analysis da
       ON da.document_id = d.document_id AND da.ocr_object_key IS NOT NULL
     WHERE d.document_id = $1::uuid
     LIMIT 1`,
    [documentId],
  );
  const row = res.rows[0];
  if (!row) return null;

  const objectKey = kind === "pdf" ? row.pdf_object_key : row.ocr_object_key;
  if (!objectKey) return null;

  const data = await minio.downloadBytes(String(objectKey));
  const stem = String(row.source_filename ?? "guideline").replace(/\.[^.]+$/, "");
  const filename = kind === "pdf" ? `${stem}.pdf` : `${stem}.ocr.md`;
  return { data, mimeType: KIND_MIME[kind], filename };
}

/** Stream one extraction's Analysis LM JSON artefact from MinIO — keyed by `analysis_id` since a document can own several. */
export async function getGuidelineAnalysisAssetContent(
  analysisId: string,
): Promise<{ data: Buffer; mimeType: string; filename: string } | null> {
  const res = await query<Record<string, unknown>>(
    `SELECT da.analysis_object_key, d.source_filename
     FROM guideline.document_analysis da
     JOIN guideline.source_documents d ON d.document_id = da.document_id
     WHERE da.analysis_id = $1::uuid`,
    [analysisId],
  );
  const row = res.rows[0];
  if (!row || !row.analysis_object_key) return null;

  const data = await minio.downloadBytes(String(row.analysis_object_key));
  const stem = String(row.source_filename ?? "guideline").replace(/\.[^.]+$/, "");
  return { data, mimeType: "application/json", filename: `${stem}.analysis.json` };
}
