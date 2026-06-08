// Job detail modal: live status/progress/steps + control actions + log viewer.
//
// The job detail and steps queries are keyed under ["jobs", id, …], so the WS
// map's invalidation of ["jobs"] cascades to them — status, progress and steps
// stay live with no extra wiring. Logs are handled separately by JobLogViewer.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { qk } from "../../lib/queryKeys";
import { formatRelative } from "../../lib/time";
import { toast } from "../../components/toast";
import { StatusBadge } from "../../components/StatusBadge";
import { Modal, ProgressBar } from "../../components/Modal";
import { JobLogViewer } from "./JobLogViewer";
import type { JobControlAction, JobDetail as JobDetailT, JobStep } from "../../lib/types";

const ACTION_LABEL: Record<JobControlAction, string> = {
  pause: "Pause",
  resume: "Resume",
  stop: "Stop",
  restart: "Restart",
};

function stepDuration(s: JobStep): string {
  if (!s.started_at) return "";
  const start = Date.parse(s.started_at);
  if (!Number.isFinite(start)) return "";
  const end = s.finished_at ? Date.parse(s.finished_at) : Date.now();
  const sec = Math.max(0, end - start) / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const m = Math.floor(sec / 60);
  return `${m}m ${Math.round(sec % 60)}s`;
}

function StepsTimeline({ steps }: { steps: JobStep[] }): JSX.Element {
  return (
    <div className="job-steps">
      {steps.map((s) => {
        const pct =
          s.progress_total > 0
            ? Math.min(100, Math.round((s.progress_current / s.progress_total) * 100))
            : null;
        const hasCheckpoint = s.checkpoint && Object.keys(s.checkpoint).length > 0;
        return (
          <div key={s.job_step_id} className={`job-step job-step--${s.status}`}>
            <div className="job-step__dot" aria-hidden />
            <div className="job-step__body">
              <div className="job-step__row">
                <span className="job-step__name">{s.step_key.replace(/_/g, " ")}</span>
                <StatusBadge status={s.status} />
                {s.progress_total > 0 && (
                  <span className="muted small">
                    {s.progress_current.toLocaleString()}/{s.progress_total.toLocaleString()}
                  </span>
                )}
                {stepDuration(s) && <span className="muted small">{stepDuration(s)}</span>}
              </div>
              {pct !== null && (
                <div className="job-step__bar">
                  <div className="job-step__bar-fill" style={{ width: `${pct}%` }} />
                </div>
              )}
              {s.last_error_message && (
                <div className="error-box small">{s.last_error_message}</div>
              )}
              {hasCheckpoint && (
                <details className="job-step__cp">
                  <summary className="muted small">checkpoint</summary>
                  <pre className="job-step__cp-json">
                    {JSON.stringify(s.checkpoint, null, 2)}
                  </pre>
                </details>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function JobDetail({ jobId, onClose }: { jobId: string; onClose: () => void }): JSX.Element {
  const qc = useQueryClient();

  const jobQ = useQuery({
    queryKey: qk.job(jobId),
    queryFn: () => api.get<{ job: JobDetailT }>(`/admin/api/jobs/${jobId}`),
    staleTime: 5_000,
  });
  const stepsQ = useQuery({
    queryKey: qk.jobSteps(jobId),
    queryFn: () => api.get<{ steps: JobStep[] }>(`/admin/api/jobs/${jobId}/steps`),
    staleTime: 5_000,
  });

  const control = useMutation({
    mutationFn: (action: JobControlAction) =>
      api.post(`/admin/api/jobs/${jobId}/${action}`, {}),
    onSuccess: (_d, action) => {
      void qc.invalidateQueries({ queryKey: qk.jobs });
      toast.success(`Requested ${action}`);
    },
    onError: (err) => toast.error(String(err)),
  });

  const job = jobQ.data?.job;
  const steps = stepsQ.data?.steps ?? [];

  return (
    <Modal title={job ? `${job.job_type}` : "Job"} onClose={onClose} wide>
      {!job ? (
        <div className="muted">Loading job…</div>
      ) : (
        <div className="job-detail">
          <div className="job-detail__head">
            <div className="job-detail__meta">
              <StatusBadge status={job.status} />
              <code className="muted small">{job.job_id}</code>
              <span className="muted small">
                {job.module_key} · by {job.requested_by} · {formatRelative(job.updated_at)}
              </span>
            </div>
            <div className="head-actions">
              {job.available_actions.map((action) => (
                <button
                  key={action}
                  type="button"
                  className="btn btn--sm"
                  disabled={control.isPending}
                  onClick={() => control.mutate(action)}
                >
                  {ACTION_LABEL[action]}
                </button>
              ))}
            </div>
          </div>

          <div className="job-detail__progress">
            <ProgressBar current={job.progress_current ?? 0} total={job.progress_total ?? 0} />
            {job.current_step && <span className="muted small">{job.current_step}</span>}
          </div>

          {job.last_error_message && (
            <div className="error-box small">{job.last_error_message}</div>
          )}

          {steps.length > 0 && (
            <>
              <h4 className="subhead">Steps</h4>
              <StepsTimeline steps={steps} />
            </>
          )}

          <h4 className="subhead">Logs</h4>
          <JobLogViewer jobId={jobId} />
        </div>
      )}
    </Modal>
  );
}
