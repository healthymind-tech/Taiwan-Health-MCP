// Live job log lines arriving over the WebSocket, buffered per job so the job
// detail view can append them without refetching.
import { useSyncExternalStore } from "react";

export interface LiveLogLine {
  job_id: string;
  level: string;
  message: string;
  payload: Record<string, unknown>;
  timestamp: string;
}

const MAX_PER_JOB = 1000;
const store = new Map<string, LiveLogLine[]>();
const listeners = new Set<() => void>();
const EMPTY: LiveLogLine[] = [];

export function pushLiveLog(line: LiveLogLine): void {
  if (!line?.job_id) return;
  const prev = store.get(line.job_id) ?? [];
  const next = prev.length >= MAX_PER_JOB ? [...prev.slice(-MAX_PER_JOB + 1), line] : [...prev, line];
  store.set(line.job_id, next);
  listeners.forEach((l) => l());
}

export function useLiveLogs(jobId: string | null | undefined): LiveLogLine[] {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => (jobId ? (store.get(jobId) ?? EMPTY) : EMPTY),
  );
}
