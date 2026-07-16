/**
 * Clinical guideline PDF OCR / analysis loader.
 *
 * Mirrors `loaders/drugAnalysis.ts`'s shape: for each pending
 * `guideline.source_documents` row, downloads the PDF from MinIO, OCRs it,
 * and extracts structured JSON with the Analysis LM. Unlike the drug loader,
 * one PDF can now fan out into MULTIPLE `guideline.document_analysis` rows —
 * the Analysis LM itself decides how many diseases the document covers and
 * emits one extraction per disease (no ICD code is declared up front).
 * Each run replaces the document's prior not-yet-reviewed batch (rows with
 * `review_status = 'pending_review'`) rather than merging into it; rows
 * already `approved`/`rejected` are left alone as historical record.
 *
 * This deliberately stops at staging — it never touches
 * `guideline.disease_guidelines` or its child tables. Fan-out into the live
 * tables only happens per-extraction when an operator approves it via
 * `admin/guidelineReview.ts`.
 *
 * `retryStage` re-runs one stage without redoing the one before it: `analysis`
 * reuses the stored OCR Markdown instead of re-OCRing the PDF.
 */

import { randomUUID } from "node:crypto";
import pg from "pg";
import * as minio from "../minioService.js";
import { logInfo, logWarning } from "../logger.js";
import {
  GuidelineAnalysisService,
  loadGuidelineAnalysisConfig,
  type GuidelineAnalysisResult,
} from "../guidelineAnalysisService.js";

function stem(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(0, dot) : filename;
}

const analysisObjectKey = (documentId: string, filename: string): string =>
  `guideline/${documentId}/analysis/${filename}`;

interface Candidate {
  document_id: string;
  object_key: string;
  source_filename: string;
}

export type RetryStage = "ocr" | "analysis";

export interface GuidelineAnalysisOptions {
  limit?: number | null;
  documentIds?: string[] | null;
  retryFailed?: boolean;
  retryStage?: string | null;
  /** Called after each document; throw to abort (used for pause/cancel). */
  onProgress?: (done: number, total: number, documentId: string) => Promise<void> | void;
}

async function loadExistingOcrMarkdown(
  client: pg.PoolClient,
  documentId: string,
): Promise<string | null> {
  const res = await client.query<{ ocr_object_key: string | null }>(
    `SELECT ocr_object_key FROM guideline.document_analysis
     WHERE document_id = $1 AND ocr_status = 'success'`,
    [documentId],
  );
  const objectKey = res.rows[0]?.ocr_object_key;
  if (!objectKey) return null;
  try {
    return (await minio.downloadBytes(objectKey)).toString("utf8");
  } catch {
    return null;
  }
}

async function candidateSources(
  client: pg.PoolClient,
  opts: GuidelineAnalysisOptions & { retryStage: RetryStage | null },
): Promise<Candidate[]> {
  const where: string[] = [];
  const params: unknown[] = [];

  if (opts.documentIds && opts.documentIds.length > 0) {
    params.push(opts.documentIds);
    where.push(`d.document_id = ANY($${params.length}::uuid[])`);
  } else {
    const pendingStages = ["queued"];
    if (opts.retryFailed) pendingStages.push("ocr_failed", "analysis_failed");
    params.push(pendingStages);
    const stageParam = `$${params.length}::text[]`;
    if (opts.retryStage === "analysis") {
      // A retry-analysis run needs prior OCR output to reuse — only documents that
      // have at least one document_analysis row (from a previous run) qualify.
      where.push(
        `EXISTS (SELECT 1 FROM guideline.document_analysis da WHERE da.document_id = d.document_id) ` +
          `AND (d.pipeline_stage = ANY(${stageParam}) OR d.pipeline_stage = 'queued')`,
      );
    } else {
      where.push(`d.pipeline_stage = ANY(${stageParam})`);
    }
  }

  let sql = `
    SELECT d.document_id::text AS document_id, d.object_key, d.source_filename
    FROM guideline.source_documents d
    WHERE ${where.length ? where.join(" AND ") : "TRUE"}
    ORDER BY d.uploaded_at
  `;
  if (opts.limit) {
    params.push(opts.limit);
    sql += ` LIMIT $${params.length}`;
  }
  const res = await client.query<Candidate>(sql, params);
  return res.rows;
}

/** The documents this run would analyse — used by the worker to pin its batch. */
export async function selectAnalysisCandidates(
  pool: pg.Pool,
  options: GuidelineAnalysisOptions,
): Promise<string[]> {
  const stage = (options.retryStage ?? "").trim().toLowerCase();
  const retryStage = (stage || null) as RetryStage | null;
  const client = await pool.connect();
  try {
    const rows = await candidateSources(client, { ...options, retryStage });
    return rows.map((row) => row.document_id);
  } finally {
    client.release();
  }
}

export async function loadGuidelineAnalysis(
  pool: pg.Pool,
  options: GuidelineAnalysisOptions = {},
): Promise<void> {
  const stage = (options.retryStage ?? "").trim().toLowerCase();
  if (stage && !["ocr", "analysis"].includes(stage)) {
    throw new Error("retryStage must be one of: ocr, analysis");
  }
  const retryStage = (stage || null) as RetryStage | null;

  const service = new GuidelineAnalysisService(await loadGuidelineAnalysisConfig());
  if (!minio.initialized()) await minio.initialize();

  const [ready, reason] =
    retryStage === "analysis" ? service.analysisReadiness() : service.readiness();
  if (!ready) {
    logInfo(`  Guideline analysis skipped: ${reason}`);
    return;
  }
  if (!minio.enabled()) {
    logInfo(`  Guideline analysis skipped: ${minio.initError() ?? "MinIO not configured"}`);
    return;
  }

  const listClient = await pool.connect();
  let candidates: Candidate[];
  try {
    candidates = await candidateSources(listClient, { ...options, retryStage });
  } finally {
    listClient.release();
  }

  if (candidates.length === 0) {
    logInfo("  Guideline analysis: no candidate documents found.");
    return;
  }
  logInfo(`Running guideline analysis for ${candidates.length} document(s) ...`);

  let done = 0;
  for (const candidate of candidates) {
    const documentId = candidate.document_id;
    const now = new Date();
    const sourceFilename = candidate.source_filename || "guideline.pdf";

    try {
      await pool.query(
        `UPDATE guideline.source_documents
         SET pipeline_stage = $2
         WHERE document_id = $1`,
        [documentId, retryStage === "analysis" ? "analysis_running" : "ocr_running"],
      );

      const pdfBytes = await minio.downloadBytes(candidate.object_key);

      let existingMarkdown: string | null = null;
      if (retryStage === "analysis") {
        const client = await pool.connect();
        try {
          existingMarkdown = await loadExistingOcrMarkdown(client, documentId);
        } finally {
          client.release();
        }
      }

      const result: GuidelineAnalysisResult = await service.analyzePdfBytes({
        documentId,
        sourceFilename,
        pdfBytes,
        existingMarkdown,
      });
      if (result.analysisItems.length === 0) {
        throw new Error("Analysis LM returned zero guideline extractions");
      }

      const markdownKey = analysisObjectKey(documentId, `${stem(sourceFilename)}.ocr.md`);
      await minio.uploadBytes({
        objectKey: markdownKey,
        data: Buffer.from(result.markdown, "utf8"),
        contentType: "text/markdown; charset=utf-8",
      });

      // One extraction round can claim the same code more than once (or claim
      // nothing) — batch the lookup once rather than a round-trip per item.
      const claimedCodes = [
        ...new Set(
          result.analysisItems
            .map((item) => String((item.disease_info as Record<string, string>)?.icd_code ?? "").trim())
            .filter((code) => code.length > 0),
        ),
      ];
      const knownCodes = new Set<string>(
        claimedCodes.length === 0
          ? []
          : (
              await pool.query<{ code: string }>(
                `SELECT code FROM icd.diagnoses WHERE code = ANY($1::text[])`,
                [claimedCodes],
              )
            ).rows.map((row) => row.code),
      );

      const rows: {
        analysisId: string;
        jsonKey: string;
        item: Record<string, unknown>;
        icdCode: string;
        diseaseName: string;
        icdCodeKnown: boolean;
      }[] = [];
      for (const [idx, item] of result.analysisItems.entries()) {
        const info = (item.disease_info ?? {}) as Record<string, string>;
        const icdCode = String(info.icd_code ?? "").trim();
        const jsonKey = analysisObjectKey(
          documentId,
          `${stem(sourceFilename)}.analysis.${idx + 1}.json`,
        );
        await minio.uploadBytes({
          objectKey: jsonKey,
          data: Buffer.from(JSON.stringify(item, null, 2), "utf8"),
          contentType: "application/json",
        });
        rows.push({
          analysisId: randomUUID(),
          jsonKey,
          item,
          icdCode,
          diseaseName: info.disease_name_zh || info.disease_name_en || "",
          icdCodeKnown: icdCode.length > 0 && knownCodes.has(icdCode),
        });
      }

      // Replace, not merge: a re-run of analysis (fresh upload or retryStage="analysis")
      // supersedes the previous not-yet-reviewed batch for this document. Rows already
      // approved/rejected are historical record and are left untouched.
      const writeClient = await pool.connect();
      try {
        await writeClient.query("BEGIN");
        await writeClient.query(
          `DELETE FROM guideline.document_analysis WHERE document_id = $1 AND review_status = 'pending_review'`,
          [documentId],
        );
        for (const row of rows) {
          await writeClient.query(
            `INSERT INTO guideline.document_analysis (
               analysis_id, document_id, ocr_object_key, analysis_object_key,
               ocr_provider, analysis_provider, ocr_status, analysis_status,
               normalized_json, extracted_icd_code, extracted_disease_name, icd_code_known,
               last_error_code, last_error_message, last_attempt_at, completed_at, review_status
             )
             VALUES ($1, $2, $3, $4, $5, $6, 'success', 'success', $7::jsonb, $8, $9, $10,
                     '', '', $11, $11, 'pending_review')`,
            [
              row.analysisId,
              documentId,
              markdownKey,
              row.jsonKey,
              result.ocrProvider,
              result.analysisProvider,
              JSON.stringify(row.item),
              row.icdCode || null,
              row.diseaseName || null,
              row.icdCodeKnown,
              now,
            ],
          );
        }
        await writeClient.query(
          `UPDATE guideline.source_documents SET pipeline_stage = 'pending_review' WHERE document_id = $1`,
          [documentId],
        );
        await writeClient.query("COMMIT");
      } catch (err) {
        await writeClient.query("ROLLBACK");
        throw err;
      } finally {
        writeClient.release();
      }

      logInfo(
        `  ${documentId}: ocr=success, analysis=success -> pending_review (${rows.length} guideline(s), ` +
          `${rows.filter((r) => !r.icdCodeKnown).length} with unrecognized ICD code)`,
      );
    } catch (err) {
      const errorMessage = String(err instanceof Error ? err.message : err);
      const failedStage = retryStage === "analysis" ? "analysis_failed" : "ocr_failed";
      // A retryStage="analysis" run reuses previously-successful OCR output, so a
      // failure here is an analysis-only failure — leave ocr_status alone (it stays
      // 'success' from the prior run). Otherwise both stages ran in this attempt and
      // either could be the cause, so both are marked retryable together, same
      // imprecision as the drug loader's failure path.
      const ocrStatusOnFailure = retryStage === "analysis" ? "success" : "retryable_failed";

      await pool.query(
        `UPDATE guideline.source_documents SET pipeline_stage = $2 WHERE document_id = $1`,
        [documentId, failedStage],
      );
      // Replace any not-yet-reviewed batch or stale failure marker for this document
      // with this attempt's failure marker — same replace-not-accumulate rule as the
      // success path. Approved/rejected rows are untouched.
      await pool.query(
        `DELETE FROM guideline.document_analysis
         WHERE document_id = $1 AND (review_status = 'pending_review' OR analysis_status = 'retryable_failed')`,
        [documentId],
      );
      await pool.query(
        `INSERT INTO guideline.document_analysis (
           analysis_id, document_id, ocr_status, analysis_status,
           last_error_code, last_error_message, last_attempt_at
         )
         VALUES ($1, $2, $3, 'retryable_failed', 'analysis_error', $4, $5)`,
        [randomUUID(), documentId, ocrStatusOnFailure, errorMessage.slice(0, 2000), new Date()],
      );

      logWarning("Guideline analysis failed", { document_id: documentId, error: errorMessage });
    }

    done += 1;
    if (options.onProgress) await options.onProgress(done, candidates.length, documentId);
  }
}
