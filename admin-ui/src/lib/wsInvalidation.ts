// ★ The reactive core of the rewrite.
//
// A single table maps each WebSocket event to the query keys it should
// invalidate. This replaces the scattered, hand-wired DOM refreshes in the old
// admin_html_shell.py (where e.g. an ICD import finishing updated the job rows
// but NOT the module status — forcing a manual page reload). Here, a job
// reaching a terminal state invalidates the modules query, so every component
// reading that data re-fetches and re-renders automatically.

import type { QueryClient } from "@tanstack/react-query";
import { qk } from "./queryKeys";
import type { WsEnvelope, JobStatusChangedEvent, JobStatus } from "./types";

const TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set<JobStatus>([
  "completed",
  "success",
  "failed",
  "cancelled",
]);

// Job types whose completion changes embedding coverage (mirror of the old
// EMBED_JOB_TYPES_SET). Extend as the backend adds embed job types.
function isEmbedJob(jobType: string): boolean {
  return jobType.endsWith("_embed");
}

function handleJobStatusChanged(qc: QueryClient, data: JobStatusChangedEvent): void {
  // The Tasks tab always cares about job state.
  void qc.invalidateQueries({ queryKey: qk.jobs });

  if (!TERMINAL_STATUSES.has(data.status)) return;

  // ── Terminal: fan out to everything a finished job can affect. ──
  // This is the line that fixes the "ICD import → must refresh" bug.
  void qc.invalidateQueries({ queryKey: qk.modules });
  void qc.invalidateQueries({ queryKey: qk.overview });

  if (data.module_key) {
    void qc.invalidateQueries({ queryKey: qk.moduleVersions(data.module_key) });
  }
  if (isEmbedJob(data.job_type)) {
    void qc.invalidateQueries({ queryKey: qk.embedding });
  }
}

export function dispatchWsInvalidation(qc: QueryClient, evt: WsEnvelope): void {
  switch (evt.type) {
    case "job_status_changed":
      handleJobStatusChanged(qc, evt.data as unknown as JobStatusChangedEvent);
      return;
    case "job_step_updated":
      void qc.invalidateQueries({ queryKey: qk.jobs });
      return;
    case "worker_heartbeat":
      void qc.invalidateQueries({ queryKey: qk.workers });
      return;
    // Maintenance toggled / module wiped (possibly from another admin session):
    // refresh the module catalog + overview so the ICD page state machine and
    // the service status re-render without a manual reload.
    case "maintenance_changed":
    case "module_cleared":
      void qc.invalidateQueries({ queryKey: qk.modules });
      void qc.invalidateQueries({ queryKey: qk.overview });
      return;
    // job_log_line is high-frequency; the Tasks tab consumes it through a
    // dedicated log store (added in Phase D), not via query invalidation.
    case "job_log_line":
    case "pong":
      return;
  }
}
