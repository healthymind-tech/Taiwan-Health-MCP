/**
 * Preconditions checked before `POST /admin/api/jobs` queues a job, so the
 * operator learns about a problem immediately (with what to do) instead of
 * from a job that fails in the worker minutes later.
 *
 *   - a second active job of a whole-module import / sync / embed type
 *     (it would only wait behind the first and then redo the same work);
 *   - a drug OCR / analysis / pipeline job while OCR or the analysis LLM is not configured.
 *
 * Pure decision logic over injected lookups (tested in jobPrechecks.test.ts).
 * Internal job creation (auto-chain, schedules, embedding switch) does not go
 * through here.
 */

import { classifyMessage } from "./adminErrorCodes.js";

/** Job types that act on a whole module: running two at once never makes sense. */
export const SINGLETON_JOB_TYPES: ReadonlySet<string> = new Set([
  "icd_import",
  "loinc_import",
  "snomed_import",
  "rxnorm_import",
  "umls_import",
  "ig_concept_index",
  "health_supplements_sync",
  "food_nutrition_sync",
  "icd_embed",
  "loinc_embed",
  "snomed_embed",
  "ig_embed",
  "health_supplements_embed",
  "food_nutrition_embed",
  "system_backup",
]);

export interface ActiveJobRef {
  job_id: string;
  status: string;
}

export interface JobPrecheckDeps {
  /** queued / running / paused jobs of this type. */
  activeJobs(jobType: string): Promise<ActiveJobRef[]>;
  /** [ready, reason] for the drug pipeline stage (OCR + analysis LLM configuration). */
  drugReadiness(stage: "full" | "analysis"): Promise<[boolean, string]>;
}

export interface PrecheckFailure {
  status: number;
  body: Record<string, unknown>;
}

const STATUS_ZH: Record<string, string> = { queued: "排隊中", running: "執行中", paused: "暫停中" };

export async function precheckJobCreate(
  jobType: string,
  jobOptions: Record<string, unknown>,
  deps: JobPrecheckDeps,
): Promise<PrecheckFailure | null> {
  if (SINGLETON_JOB_TYPES.has(jobType)) {
    const active = await deps.activeJobs(jobType).catch(() => [] as ActiveJobRef[]); // lookup failure: fail open
    if (active.length > 0) {
      const j = active[0];
      return {
        status: 409,
        body: {
          error: `A ${jobType} job is already ${j.status}`,
          code: "JOB_ALREADY_ACTIVE",
          message_zh: `已經有一個相同的工作（${jobType}）${STATUS_ZH[j.status] ?? j.status}，不需要再建立一個。`,
          hint_zh: "請到「背景工作」查看它的進度；若要用新的來源檔重跑，請先停止它再重新開始。",
          active_job_id: j.job_id,
        },
      };
    }
  }
  if (jobType === "drug_analysis" || jobType === "drug_pipeline") {
    const stage = jobType === "drug_pipeline" ? "" : String(jobOptions.retry_stage ?? "").trim().toLowerCase();
    if (stage !== "normalize") {
      const [ready, reason] = await deps
        .drugReadiness(stage === "analysis" ? "analysis" : "full")
        .catch((): [boolean, string] => [true, ""]); // config lookup failure: let the worker report it
      if (!ready) {
        const known = classifyMessage(reason);
        return {
          status: 409,
          body: {
            error: reason,
            code: known?.code ?? "DRUG_PIPELINE_NOT_READY",
            message_zh: known?.message_zh ?? "藥品仿單分析的前置設定不完整。",
            hint_zh: known?.hint_zh ?? "請確認「外部服務 → OCR」與「模型端點」的分析角色都已設定。",
          },
        };
      }
    }
  }
  return null;
}
