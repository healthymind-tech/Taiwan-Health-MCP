// Tasks tab — recent jobs list, each row opening a live detail modal.
//
// The jobs list is invalidated by the WS map on every job_status_changed /
// job_step_updated, so rows (status, progress) update live without polling.

import { useState } from "react";
import { useJobs } from "../../lib/jobs";
import { formatRelative } from "../../lib/time";
import { StatusBadge } from "../../components/StatusBadge";
import { ProgressBar } from "../../components/Modal";
import { JobDetail } from "./JobDetail";

export function TasksPage(): JSX.Element {
  const { data, isPending, isError, error, isFetching } = useJobs();
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);

  if (isPending) return <div className="muted">Loading jobs…</div>;
  if (isError) return <div className="error-box">Failed to load jobs: {String(error)}</div>;

  const jobs = data.jobs;

  return (
    <section>
      <header className="section-head">
        <h2>Tasks</h2>
        <span className="muted small">{isFetching ? "Refreshing…" : `${jobs.length} recent jobs`}</span>
      </header>

      {jobs.length === 0 ? (
        <div className="muted">No jobs yet. Trigger an import or sync from the Modules tab.</div>
      ) : (
        <table className="jobs-table">
          <thead>
            <tr>
              <th>Job</th>
              <th>Module</th>
              <th>Status</th>
              <th>Progress</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => (
              <tr key={job.job_id} className="jobs-table__row" onClick={() => setSelectedJobId(job.job_id)}>
                <td data-label="Job">
                  <div className="row__name">{job.job_type}</div>
                  <code className="muted small">{job.job_id.slice(0, 8)}…</code>
                </td>
                <td className="muted small" data-label="Module">{job.module_key || "—"}</td>
                <td data-label="Status">
                  <StatusBadge status={job.status} />
                </td>
                <td data-label="Progress">
                  <ProgressBar current={job.progress_current ?? 0} total={job.progress_total ?? 0} />
                </td>
                <td className="muted small" data-label="Updated">{formatRelative(job.updated_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {selectedJobId && (
        <JobDetail jobId={selectedJobId} onClose={() => setSelectedJobId(null)} />
      )}
    </section>
  );
}
