// Drug pipeline summary + trigger, embedded in the Modules drug card.
//
// Consumes /admin/api/drug/pipeline-status; exposes one drug_pipeline job
// trigger (enrich + OCR + analyze per license, end to end) plus a "Retry
// failed" action that disables itself once nothing is left to retry.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../lib/api";
import { qk } from "../../../lib/queryKeys";
import { useActiveJobTypes } from "../../../lib/jobs";
import { StatusBadge } from "../../../components/StatusBadge";
import { ProgressBar } from "../../../components/Modal";
import { toast } from "../../../components/toast";

interface Stage {
  status?: string;
  done?: number;
  total?: number;
  pending?: number;
  failed?: number;
  total_licenses?: number;
  queue_total?: number;
  queue_done?: number;
  queue_pending?: number;
  queue_failed?: number;
  enriched_licenses?: number;
  pdf_analyzed_licenses?: number;
  needs_ocr_licenses?: number;
  current_step?: string;
}
interface PipelineStatus {
  total_licenses?: number;
  enriched_licenses?: number;
  pdf_analyzed_licenses?: number;
  needs_ocr_licenses?: number;
  queue_total?: number;
  queue_done?: number;
  queue_pending?: number;
  queue_failed?: number;
  is_complete?: boolean;
  index?: Stage;
  pipeline?: Stage;
  enrichment?: Stage;
  analysis?: Stage;
}

function StageRow({ name, stage }: { name: string; stage: Stage | undefined }): JSX.Element | null {
  if (!stage) return null;
  const done = name === "Index"
    ? stage.total_licenses ?? 0
    : name === "Pipeline"
      ? stage.queue_done ?? 0
      : stage.done ?? 0;
  const total = name === "Index"
    ? stage.total_licenses ?? 0
    : name === "Pipeline"
      ? stage.queue_total ?? 0
      : stage.total ?? 0;
  const failed = name === "Pipeline" ? stage.queue_failed ?? 0 : stage.failed ?? 0;
  return (
    <div className="row">
      <span className="row__name">{name}</span>
      <div className="row__meta">
        {failed ? <span className="badge badge--bad">{failed} failed</span> : null}
        <span className="muted small">
          {done}/{total}
        </span>
        <ProgressBar current={done} total={total} />
        {stage.status && <StatusBadge status={stage.status} />}
      </div>
    </div>
  );
}

interface Props {
  disabled?: boolean;
  disabledReason?: string;
}

export function DrugPipelinePanel({ disabled = false, disabledReason = "" }: Props): JSX.Element {
  const qc = useQueryClient();
  const activeJobTypes = useActiveJobTypes();

  const { data } = useQuery({
    queryKey: qk.drugPipeline,
    queryFn: () => api.get<PipelineStatus>("/admin/api/drug/pipeline-status"),
    staleTime: 10_000,
  });

  const trigger = useMutation({
    mutationFn: (opts: { jobType: string; jobOptions?: Record<string, unknown> }) =>
      api.post("/admin/api/jobs", {
        job_type: opts.jobType,
        module_key: "drug",
        job_options: opts.jobOptions,
      }),
    onSuccess: (_d, opts) => {
      void qc.invalidateQueries({ queryKey: qk.jobs });
      void qc.invalidateQueries({ queryKey: qk.drugPipeline });
      toast.success(`Started ${opts.jobType}`);
    },
    onError: (err) => toast.error(String(err)),
  });

  const p = data ?? {};
  const running = (jt: string) => activeJobTypes.has(jt);
  const pipelineRunning = running("drug_pipeline");
  const queuePending = p.pipeline?.queue_pending ?? 0;
  const queueFailed = p.pipeline?.queue_failed ?? 0;
  const actionTitle = disabled ? disabledReason : "";

  return (
    <div className="source-role">
      <div className="source-role__head">
        <strong>Pipeline</strong>
        <div className="head-actions">
          <button
            type="button"
            className="btn btn--sm"
            disabled={disabled || pipelineRunning || (queuePending === 0 && queueFailed === 0)}
            title={actionTitle}
            onClick={() => trigger.mutate({ jobType: "drug_pipeline" })}
          >
            {pipelineRunning ? "Running…" : `Run pipeline${queuePending ? ` (${queuePending})` : ""}`}
          </button>
          <button
            type="button"
            className="btn btn--sm"
            disabled={disabled || pipelineRunning || queueFailed === 0}
            title={actionTitle}
            onClick={() => trigger.mutate({ jobType: "drug_pipeline", jobOptions: { retry_failed: true } })}
          >
            {pipelineRunning ? "Running…" : `Retry failed${queueFailed ? ` (${queueFailed})` : ""}`}
          </button>
        </div>
      </div>

      <div className="summary-row">
        <span className="muted small">{p.index?.total_licenses ?? p.total_licenses ?? 0} licenses</span>
        <span className="badge badge--ok">{p.enrichment?.enriched_licenses ?? p.enriched_licenses ?? 0} enriched</span>
        <span className="badge badge--ok">{p.enrichment?.pdf_analyzed_licenses ?? p.pdf_analyzed_licenses ?? 0} analyzed</span>
        {(p.enrichment?.needs_ocr_licenses ?? p.needs_ocr_licenses) ? (
          <span className="badge badge--warn">{p.enrichment?.needs_ocr_licenses ?? p.needs_ocr_licenses} need OCR</span>
        ) : null}
        {(p.enrichment?.queue_failed ?? p.queue_failed) ? (
          <span className="badge badge--bad">{p.enrichment?.queue_failed ?? p.queue_failed} queue failed</span>
        ) : null}
      </div>

      <div className="service-list">
        <StageRow name="Index" stage={p.index} />
        <StageRow name="Pipeline" stage={p.pipeline} />
      </div>

    </div>
  );
}
