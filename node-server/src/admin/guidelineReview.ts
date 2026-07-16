/**
 * Human review/approve gate for Analysis-LM-extracted clinical guideline data.
 *
 * This is the one piece of the guideline pipeline with no equivalent anywhere
 * else in the codebase: the drug pipeline auto-commits its LLM output, but
 * guideline data (medication contraindications, treatment goals) is judged
 * higher-stakes, so nothing here reaches the live `guideline.*` tables until an
 * operator explicitly approves it. Kept in its own file (rather than folded into
 * `adminGuideline.ts`, which is the read-surface) so this safety-critical,
 * transactional logic is easy to find and review in isolation.
 *
 * One PDF (`source_documents`) can produce several extractions
 * (`document_analysis` rows, one per disease the Analysis LM identified) —
 * every function here operates on a single extraction (`analysisId`), never
 * on a whole document, so a reviewer can approve one disease and reject
 * another from the same PDF independently.
 */

import { query, withTransaction } from "../db.js";
import { tsIsoExpr, pyIso } from "./adminJobs.js";
import { icdCodeExists } from "./adminGuideline.js";
import {
  GUIDELINE_ANALYSIS_TEMPLATE,
  normalizeGuidelineAnalysisData,
  validateGuidelineAnalysisShape,
} from "../guidelineAnalysisService.js";

export class ReviewValueError extends Error {}

function iso(text: string | null | undefined): string {
  return text === null || text === undefined ? "" : pyIso(text);
}

function n(v: unknown): number {
  return Number(v ?? 0);
}

export interface ListPendingReviewsOptions {
  page?: number;
  perPage?: number;
}

/** `GET /admin/api/guideline/review/pending`. */
export async function listPendingReviews(
  opts: ListPendingReviewsOptions = {},
): Promise<Record<string, unknown>> {
  const page = Math.max(1, opts.page ?? 1);
  const perPage = Math.max(1, Math.min(opts.perPage ?? 50, 200));
  const offset = (page - 1) * perPage;

  // analysis_status='success' excludes a stale row left behind by a failed
  // re-analysis attempt — its normalized_json/edited_json would be from the
  // last *successful* run, not something a reviewer should act on right now.
  const totalRes = await query<{ c: string }>(
    `SELECT COUNT(*) AS c FROM guideline.document_analysis
     WHERE review_status = 'pending_review' AND analysis_status = 'success'`,
  );
  const rowsRes = await query<Record<string, unknown>>(
    `SELECT da.analysis_id::text AS analysis_id, da.document_id::text AS document_id,
            da.extracted_icd_code, da.extracted_disease_name, da.icd_code_known,
            d.source_filename, ${tsIsoExpr("d.uploaded_at")} AS uploaded_at_iso,
            ${tsIsoExpr("da.completed_at")} AS completed_at_iso
     FROM guideline.document_analysis da
     JOIN guideline.source_documents d ON d.document_id = da.document_id
     WHERE da.review_status = 'pending_review' AND da.analysis_status = 'success'
     ORDER BY da.document_id, da.completed_at ASC
     LIMIT $1 OFFSET $2`,
    [perPage, offset],
  );

  return {
    total: n(totalRes.rows[0]?.c),
    page,
    per_page: perPage,
    documents: rowsRes.rows.map((row) => ({
      ...row,
      uploaded_at: iso(row.uploaded_at_iso as string | null),
      uploaded_at_iso: undefined,
      completed_at: iso(row.completed_at_iso as string | null),
      completed_at_iso: undefined,
    })),
  };
}

/** `GET /admin/api/guideline/review/:analysisId`. */
export async function getReviewDetail(analysisId: string): Promise<Record<string, unknown>> {
  const res = await query<Record<string, unknown>>(
    `SELECT da.analysis_id::text AS analysis_id, da.document_id::text AS document_id,
            da.normalized_json, da.edited_json, da.extracted_icd_code, da.extracted_disease_name,
            da.icd_code_known, da.ocr_object_key, da.analysis_object_key,
            da.ocr_provider, da.analysis_provider,
            da.review_status, da.reviewed_by, ${tsIsoExpr("da.reviewed_at")} AS reviewed_at_iso,
            da.review_notes,
            d.source_filename, d.object_key AS pdf_object_key,
            ${tsIsoExpr("d.uploaded_at")} AS uploaded_at_iso
     FROM guideline.document_analysis da
     JOIN guideline.source_documents d ON d.document_id = da.document_id
     WHERE da.analysis_id = $1::uuid`,
    [analysisId],
  );
  const row = res.rows[0];
  if (!row) throw new ReviewValueError(`No analysis found: ${analysisId}`);
  return {
    ...row,
    reviewed_at: iso(row.reviewed_at_iso as string | null),
    reviewed_at_iso: undefined,
    uploaded_at: iso(row.uploaded_at_iso as string | null),
    uploaded_at_iso: undefined,
    template: GUIDELINE_ANALYSIS_TEMPLATE,
  };
}

function parseIntOr(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function str(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

export interface ApproveReviewOptions {
  edits?: unknown;
  reviewedBy: string;
  notes?: string;
}

export interface ApproveReviewResult {
  guidelineId: number;
}

/**
 * Approve a pending extraction: fan out its (possibly reviewer-edited) JSON
 * into `disease_guidelines` and fully replace its four child tables — a full
 * replace, not a merge, because mixing recommendations from two different
 * source extractions for the same disease is the actual patient-safety risk
 * to avoid. If part of an older approved extraction should be kept, that is
 * an edit-before-approve action, not something this function does
 * automatically.
 *
 * Hard-blocks on an unrecognized ICD code (whether from the original
 * extraction or from reviewer edits): since the Analysis LM now determines
 * the ICD code itself rather than echoing an operator-declared one, the
 * exact-match check against `icd.diagnoses` is the safety net that replaces
 * the old "human declared it up front" guarantee.
 */
export async function approveReview(
  analysisId: string,
  opts: ApproveReviewOptions,
): Promise<ApproveReviewResult> {
  return withTransaction(async (client) => {
    const res = await client.query<Record<string, unknown>>(
      `SELECT normalized_json, review_status
       FROM guideline.document_analysis
       WHERE analysis_id = $1::uuid
       FOR UPDATE`,
      [analysisId],
    );
    const row = res.rows[0];
    if (!row) throw new ReviewValueError(`No analysis found: ${analysisId}`);
    if (row.review_status !== "pending_review") {
      throw new ReviewValueError(`Analysis is not pending review (status: ${row.review_status})`);
    }

    let finalJson: Record<string, unknown>;
    if (opts.edits !== undefined && opts.edits !== null) {
      const errors = validateGuidelineAnalysisShape(opts.edits);
      if (errors.length > 0) {
        throw new ReviewValueError(`Edited JSON does not match the expected shape: ${errors.join("; ")}`);
      }
      finalJson = normalizeGuidelineAnalysisData(opts.edits);
    } else {
      finalJson = normalizeGuidelineAnalysisData(row.normalized_json);
    }

    const info = finalJson.disease_info as Record<string, string>;
    const icdCode = info.icd_code.trim();
    if (!icdCode || !(await icdCodeExists(icdCode))) {
      throw new ReviewValueError(
        `ICD code "${icdCode || "(empty)"}" was not found in the loaded ICD-10-CM dataset — ` +
          "edit it to a recognized code before approving.",
      );
    }
    const publicationYear = (() => {
      const parsed = Number.parseInt(info.publication_year, 10);
      return Number.isFinite(parsed) ? parsed : null;
    })();

    const guidelineRow = await client.query<{ id: number }>(
      `INSERT INTO guideline.disease_guidelines (
         icd_code, disease_name_zh, disease_name_en, guideline_title,
         guideline_source, publication_year, guideline_summary, source_analysis_id
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::uuid)
       ON CONFLICT (icd_code) DO UPDATE SET
         disease_name_zh = EXCLUDED.disease_name_zh,
         disease_name_en = EXCLUDED.disease_name_en,
         guideline_title = EXCLUDED.guideline_title,
         guideline_source = EXCLUDED.guideline_source,
         publication_year = EXCLUDED.publication_year,
         guideline_summary = EXCLUDED.guideline_summary,
         source_analysis_id = EXCLUDED.source_analysis_id
       RETURNING id`,
      [
        icdCode,
        info.disease_name_zh || icdCode,
        info.disease_name_en || null,
        info.guideline_title || icdCode,
        info.guideline_source || null,
        publicationYear,
        info.guideline_summary || null,
        analysisId,
      ],
    );
    const guidelineId = guidelineRow.rows[0].id;

    const diagnostics = finalJson.diagnostic_recommendations as Record<string, string>[];
    await client.query("DELETE FROM guideline.diagnostic_recommendations WHERE guideline_id = $1", [
      guidelineId,
    ]);
    for (const [idx, r] of diagnostics.entries()) {
      await client.query(
        `INSERT INTO guideline.diagnostic_recommendations
           (guideline_id, step_order, recommendation_type, description, evidence_level)
         VALUES ($1, $2, $3, $4, $5)`,
        [guidelineId, parseIntOr(r.step_order, idx + 1), r.recommendation_type, r.description, r.evidence_level],
      );
    }

    const medications = finalJson.medication_recommendations as Record<string, string>[];
    await client.query("DELETE FROM guideline.medication_recommendations WHERE guideline_id = $1", [
      guidelineId,
    ]);
    for (const r of medications) {
      await client.query(
        `INSERT INTO guideline.medication_recommendations
           (guideline_id, line_of_therapy, medication_class, medication_examples,
            dosage_guidance, contraindications, evidence_level)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          guidelineId,
          r.line_of_therapy,
          r.medication_class,
          r.medication_examples,
          r.dosage_guidance,
          r.contraindications,
          r.evidence_level,
        ],
      );
    }

    const tests = finalJson.test_recommendations as Record<string, string>[];
    await client.query("DELETE FROM guideline.test_recommendations WHERE guideline_id = $1", [
      guidelineId,
    ]);
    for (const r of tests) {
      await client.query(
        `INSERT INTO guideline.test_recommendations
           (guideline_id, test_category, test_name, loinc_code, frequency, indication, evidence_level)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [guidelineId, r.test_category, r.test_name, r.loinc_code || null, r.frequency, r.indication, r.evidence_level],
      );
    }

    const goals = finalJson.treatment_goals as Record<string, string>[];
    await client.query("DELETE FROM guideline.treatment_goals WHERE guideline_id = $1", [guidelineId]);
    for (const r of goals) {
      await client.query(
        `INSERT INTO guideline.treatment_goals
           (guideline_id, goal_type, target_parameter, target_value, timeframe)
         VALUES ($1, $2, $3, $4, $5)`,
        [guidelineId, r.goal_type, r.target_parameter, r.target_value, r.timeframe],
      );
    }

    await client.query(
      `UPDATE guideline.document_analysis
       SET review_status = 'approved', reviewed_by = $2, reviewed_at = NOW(),
           review_notes = $3, edited_json = $4::jsonb, produced_guideline_id = $5,
           extracted_icd_code = $6, icd_code_known = TRUE
       WHERE analysis_id = $1::uuid`,
      [
        analysisId,
        opts.reviewedBy,
        opts.notes ?? null,
        opts.edits !== undefined && opts.edits !== null ? JSON.stringify(opts.edits) : null,
        guidelineId,
        icdCode,
      ],
    );
    // A previously-approved extraction for the same resolved ICD code is now
    // superseded — keep it around for audit history rather than deleting it.
    await client.query(
      `UPDATE guideline.document_analysis
       SET superseded_by = $2::uuid
       WHERE extracted_icd_code = $1 AND analysis_id <> $2::uuid
             AND review_status = 'approved' AND superseded_by IS NULL`,
      [icdCode, analysisId],
    );

    await client.query(
      `INSERT INTO admin.admin_audit_log (admin_user, action, target_type, target_id, payload_json)
       VALUES ($1, 'approve_guideline_review', 'guideline_document_analysis', $2, $3::jsonb)`,
      [opts.reviewedBy, analysisId, JSON.stringify({ icd_code: icdCode, guideline_id: guidelineId })],
    );

    return { guidelineId };
  });
}

export interface RejectReviewOptions {
  reviewedBy: string;
  notes: string;
}

/** Reject a pending extraction. `notes` is required — a rejection with no reason is not useful for a safety-critical review. Its parent document remains eligible for re-analysis (which replaces this row anyway). */
export async function rejectReview(analysisId: string, opts: RejectReviewOptions): Promise<void> {
  const notes = str(opts.notes).trim();
  if (!notes) throw new ReviewValueError("notes is required to reject a review");

  await withTransaction(async (client) => {
    const res = await client.query<{ review_status: string }>(
      `SELECT review_status FROM guideline.document_analysis WHERE analysis_id = $1::uuid FOR UPDATE`,
      [analysisId],
    );
    const row = res.rows[0];
    if (!row) throw new ReviewValueError(`No analysis found: ${analysisId}`);
    if (row.review_status !== "pending_review") {
      throw new ReviewValueError(`Analysis is not pending review (status: ${row.review_status})`);
    }

    await client.query(
      `UPDATE guideline.document_analysis
       SET review_status = 'rejected', reviewed_by = $2, reviewed_at = NOW(), review_notes = $3
       WHERE analysis_id = $1::uuid`,
      [analysisId, opts.reviewedBy, notes],
    );
    await client.query(
      `INSERT INTO admin.admin_audit_log (admin_user, action, target_type, target_id, payload_json)
       VALUES ($1, 'reject_guideline_review', 'guideline_document_analysis', $2, $3::jsonb)`,
      [opts.reviewedBy, analysisId, JSON.stringify({ notes })],
    );
  });
}
