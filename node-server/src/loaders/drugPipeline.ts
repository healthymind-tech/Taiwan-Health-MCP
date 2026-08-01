/**
 * Unified drug pipeline: for one license, enrich (crawl TFDA + store assets)
 * then — only if that produced a usable insert PDF — OCR + LLM-analyze +
 * normalize, all as one unit of work. This is deliberately a thin composition
 * layer, not a reimplementation: `loadDrugEnrichment`/`loadDrugAnalysis`
 * (`drugEnrichment.ts`/`drugAnalysis.ts`) already support being scoped to
 * exactly one license via `licenseIds`+`limit:1` — that's the exact shape
 * `admin/adminJobs.ts`'s `runDrugEnrichmentJob`/`runDrugAnalysisJob` already
 * use internally for their own per-license checkpointed loops. This module
 * just calls both, per license, in sequence.
 *
 * Replaces the old two-stage design (drug_enrichment then drug_analysis as
 * separate, independently-scheduled job types chained by `maybeAutoChain`)
 * with one job type that does both per license, so a license's outcome is
 * never "enrichment succeeded, analysis silently still pending from a
 * previous run" — see `reconcileQueueStatus` below.
 */

import pg from "pg";
import { loadDrugEnrichment, selectEnrichmentCandidates, type DrugEnrichmentOptions } from "./drugEnrichment.js";
import { loadDrugAnalysis } from "./drugAnalysis.js";

export interface DrugPipelineOptions {
  limit?: number | null;
  licenseIds?: string[] | null;
  includeCancelled?: boolean;
  retryFailed?: boolean;
}

/**
 * The end-to-end outcome for one license, computed from its now-current
 * `drug.import_license_state` row. Returned by `runOneLicensePipeline` so the
 * caller (the worker's `runDrugPipelineJob`) can surface per-license failures
 * in the *job log* — the loaders below deliberately swallow per-license errors
 * into DB status columns + `last_error_message` and only touch the application
 * logger, so without this the task log stays silent while drugs quietly fail.
 */
export interface LicensePipelineOutcome {
  licenseId: string;
  status: "success" | "partial_success" | "retryable_failed";
  /** Stage columns (without the `_status` suffix) that ended failed/partial. */
  failedStages: string[];
  /** Most recent per-license error message recorded by either loader, if any. */
  lastErrorMessage: string;
  /**
   * The failure was the Analysis LM being unavailable (its fleet down / not
   * configured), not a problem with this drug's data. The batch caller pauses
   * the whole job on this rather than continuing to fail every remaining
   * license identically — see `runDrugPipelineJob`.
   */
  llmUnavailable: boolean;
}

/**
 * The licenses a pipeline batch would process. Reuses the enrichment queue's
 * candidate selection — it's still the correct front door for "this license
 * needs (re)work," since every license that enters the queue now goes through
 * the full enrich+OCR+analyze unit, not just enrichment.
 */
export async function selectPipelineCandidates(
  pool: pg.Pool,
  options: DrugPipelineOptions,
): Promise<string[]> {
  return selectEnrichmentCandidates(pool, options);
}

/**
 * Run the whole pipeline for one license. `loadDrugAnalysis` naturally no-ops
 * (logs "no candidate licenses found" and returns) when the license has no
 * successfully-stored insert PDF yet — its candidate query inner-joins on a
 * stored `insert_pdf` asset — so this doesn't need to pre-check whether
 * enrichment produced one.
 */
export async function runOneLicensePipeline(
  pool: pg.Pool,
  licenseId: string,
  opts: {
    includeCancelled: boolean;
    retryFailed: boolean;
    tfdaValues: DrugEnrichmentOptions["tfdaValues"];
  },
): Promise<LicensePipelineOutcome> {
  await loadDrugEnrichment(pool, {
    licenseIds: [licenseId],
    limit: 1,
    includeCancelled: opts.includeCancelled,
    retryFailed: opts.retryFailed,
    tfdaValues: opts.tfdaValues,
  });

  await loadDrugAnalysis(pool, {
    licenseIds: [licenseId],
    limit: 1,
    includeCancelled: opts.includeCancelled,
    retryFailed: opts.retryFailed,
    retryStage: null,
  });

  return reconcileQueueStatus(pool, licenseId);
}

/**
 * `loadDrugEnrichment` writes `drug.enrichment_queue.status` from the stage
 * columns it knows about *at the time it runs* — including `ocr_status`/
 * `analysis_status`, which are still whatever they were before the analysis
 * phase above just ran (e.g. still `'pending'` on a first pass). Recompute the
 * queue status from the now-current `drug.import_license_state` row so it
 * reflects this run's true end-to-end outcome — the correctness improvement
 * the merge is partly for: the queue never again says "success" for a license
 * whose analysis hasn't actually happened yet.
 */
async function reconcileQueueStatus(
  pool: pg.Pool,
  licenseId: string,
): Promise<LicensePipelineOutcome> {
  const client = await pool.connect();
  try {
    const res = await client.query<{
      electronic_insert_status: string;
      insert_pdf_status: string;
      label_pdf_status: string;
      shape_status: string;
      storage_status: string;
      ocr_status: string;
      analysis_status: string;
      normalize_status: string;
      last_error_code: string | null;
      last_error_message: string | null;
    }>(
      `SELECT electronic_insert_status, insert_pdf_status, label_pdf_status, shape_status,
              storage_status, ocr_status, analysis_status, normalize_status,
              last_error_code, last_error_message
       FROM drug.import_license_state WHERE license_id = $1`,
      [licenseId],
    );
    const state = res.rows[0];
    if (!state) {
      // No state row means neither loader got far enough to write one — treat as
      // a failure so it's visible rather than silently counted as success.
      return {
        licenseId,
        status: "retryable_failed",
        failedStages: [],
        lastErrorMessage: "no import_license_state row after pipeline run",
        llmUnavailable: false,
      };
    }

    const stageEntries: [string, string][] = [
      ["electronic_insert", state.electronic_insert_status],
      ["insert_pdf", state.insert_pdf_status],
      ["label_pdf", state.label_pdf_status],
      ["shape", state.shape_status],
      ["storage", state.storage_status],
      ["ocr", state.ocr_status],
      ["analysis", state.analysis_status],
      ["normalize", state.normalize_status],
    ];

    const anyRetryable = stageEntries.some(([, status]) => status === "retryable_failed");
    const anyPartial = [
      state.insert_pdf_status,
      state.label_pdf_status,
      state.shape_status,
      state.storage_status,
    ].some((status) => status === "partial_success");
    const queueStatus: LicensePipelineOutcome["status"] = anyRetryable
      ? "retryable_failed"
      : anyPartial
        ? "partial_success"
        : "success";

    await client.query("UPDATE drug.enrichment_queue SET status = $2 WHERE license_id = $1", [
      licenseId,
      queueStatus,
    ]);

    const failedStages = stageEntries
      .filter(([, status]) => status === "retryable_failed" || status === "partial_success")
      .map(([stage]) => stage);

    return {
      licenseId,
      status: queueStatus,
      failedStages,
      lastErrorMessage: state.last_error_message ?? "",
      // Only meaningful when this run actually ended failed — a stale code left on
      // a since-succeeded license must not trigger a pause.
      llmUnavailable: queueStatus === "retryable_failed" && state.last_error_code === "llm_unavailable",
    };
  } finally {
    client.release();
  }
}
