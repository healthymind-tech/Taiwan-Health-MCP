import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { qk } from "./queryKeys";
import { ACTIVE_STATUSES } from "./meta";
import type { JobSummary, JobsPayload } from "./types";

export function useJobs() {
  return useQuery({
    queryKey: qk.jobs,
    queryFn: () => api.get<JobsPayload>("/admin/api/jobs"),
    staleTime: 5_000,
    refetchInterval: 15_000,
  });
}

/** Most recent queued/running/paused job per job_type. */
export function useActiveJobs(): Map<string, JobSummary> {
  const { data } = useJobs();
  const map = new Map<string, JobSummary>();
  for (const j of data?.jobs ?? []) {
    if (ACTIVE_STATUSES.has(j.status) && !map.has(j.job_type)) map.set(j.job_type, j);
  }
  return map;
}

/** Latest job (any status) of a type, or null. */
export function useLatestJob(jobType: string | null | undefined): JobSummary | null {
  const { data } = useJobs();
  if (!jobType) return null;
  return (data?.jobs ?? []).find((j) => j.job_type === jobType) ?? null;
}

export interface StartJobBody {
  job_type: string;
  module_key: string;
  job_options?: Record<string, unknown>;
  source_uploaded_file_id?: string;
  source_module_source_id?: string;
}

/** POST /admin/api/jobs; invalidates the jobs list. Returns the created job. */
export function useStartJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: StartJobBody) => api.post<{ job: JobSummary }>("/admin/api/jobs", body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.jobs });
    },
  });
}

export function useJobControl() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ jobId, action }: { jobId: string; action: string }) =>
      api.post<Record<string, unknown>>(`/admin/api/jobs/${jobId}/${action}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.jobs });
    },
  });
}
