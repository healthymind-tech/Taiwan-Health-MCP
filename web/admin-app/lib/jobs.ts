// Shared jobs query + derived helpers. The jobs list is invalidated by the WS
// map (wsInvalidation.ts) on every job_status_changed, so anything reading it
// — e.g. disabling an "Import" button while that job runs — stays live.

import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { qk } from "./queryKeys";
import type { JobsPayload, JobStatus } from "./types";

const ACTIVE_STATUSES: ReadonlySet<JobStatus> = new Set<JobStatus>([
  "queued",
  "running",
  "paused",
]);

export function useJobs() {
  return useQuery({
    queryKey: qk.jobs,
    queryFn: () => api.get<JobsPayload>("/admin/api/jobs"),
    staleTime: 10_000,
  });
}

/** Set of job_types that currently have a queued/running/paused job. */
export function useActiveJobTypes(): Set<string> {
  const { data } = useJobs();
  const active = new Set<string>();
  for (const job of data?.jobs ?? []) {
    if (ACTIVE_STATUSES.has(job.status)) active.add(job.job_type);
  }
  return active;
}
