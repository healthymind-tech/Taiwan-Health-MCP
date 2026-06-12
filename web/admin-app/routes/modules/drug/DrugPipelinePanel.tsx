// Drug pipeline summary + stage triggers, embedded in the Modules drug card.
//
// Consumes /admin/api/drug/pipeline-status; exposes drug_enrichment and
// drug_analysis job triggers; opens the license browser for per-license detail
// and asset preview.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../lib/api";
import { qk } from "../../../lib/queryKeys";
import { useActiveJobTypes } from "../../../lib/jobs";
import { StatusBadge } from "../../../components/StatusBadge";
import { ProgressBar } from "../../../components/Modal";
import { toast } from "../../../components/toast";
import { DrugLicensesModal } from "./DrugLicensesModal";

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
  enrichment?: Stage;
  analysis?: Stage;
}

function StageRow({ name, stage }: { name: string; stage: Stage | undefined }): JSX.Element | null {
  if (!stage) return null;
  const done = name === "Index"
    ? stage.total_licenses ?? 0
    : name === "Enrichment"
      ? stage.queue_done ?? 0
      : stage.done ?? 0;
  const total = name === "Index"
    ? stage.total_licenses ?? 0
    : name === "Enrichment"
      ? stage.queue_total ?? 0
      : stage.total ?? 0;
  const failed = name === "Enrichment" ? stage.queue_failed ?? 0 : stage.failed ?? 0;
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
  const [browsing, setBrowsing] = useState(false);

  const { data } = useQuery({
    queryKey: qk.drugPipeline,
    queryFn: () => api.get<PipelineStatus>("/admin/api/drug/pipeline-status"),
    staleTime: 10_000,
  });

  const trigger = useMutation({
    mutationFn: (jobType: string) =>
      api.post("/admin/api/jobs", { job_type: jobType, module_key: "drug" }),
    onSuccess: (_d, jobType) => {
      void qc.invalidateQueries({ queryKey: qk.jobs });
      void qc.invalidateQueries({ queryKey: qk.drugPipeline });
      toast.success(`Started ${jobType}`);
    },
    onError: (err) => toast.error(String(err)),
  });

  const p = data ?? {};
  const running = (jt: string) => activeJobTypes.has(jt);
  const enrichmentRunning = running("drug_enrichment");
  const analysisRunning = running("drug_analysis");
  const actionTitle = disabled ? disabledReason : "";

  return (
    <div className="source-role">
      <div className="source-role__head">
        <strong>Pipeline</strong>
        <div className="head-actions">
          <button
            type="button"
            className="btn btn--sm"
            disabled={disabled || enrichmentRunning}
            title={actionTitle}
            onClick={() => trigger.mutate("drug_enrichment")}
          >
            {enrichmentRunning ? "Enriching…" : "Run enrichment"}
          </button>
          <button
            type="button"
            className="btn btn--sm"
            disabled={disabled || analysisRunning}
            title={actionTitle}
            onClick={() => trigger.mutate("drug_analysis")}
          >
            {analysisRunning ? "Analyzing…" : "Run analysis"}
          </button>
          <button
            type="button"
            className="btn btn--sm"
            disabled={disabled && !p.index?.total_licenses}
            title={actionTitle}
            onClick={() => setBrowsing(true)}
          >
            Browse licenses
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
        <StageRow name="Enrichment" stage={p.enrichment} />
        <StageRow name="Analysis" stage={p.analysis} />
      </div>

      {browsing && <DrugLicensesModal onClose={() => setBrowsing(false)} />}
    </div>
  );
}
