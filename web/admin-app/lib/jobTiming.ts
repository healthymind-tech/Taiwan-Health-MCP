import { formatDuration, secondsBetween } from "./time";

interface TimedProgress {
  status: string;
  started_at?: string;
  finished_at?: string;
  progress_current?: number;
  progress_total?: number;
}

export function formatElapsedTime(item: TimedProgress, nowMs: number): string {
  const seconds = secondsBetween(item.started_at, item.finished_at, nowMs);
  return seconds === null ? "—" : formatDuration(seconds);
}

export function formatEstimatedRemaining(item: TimedProgress, nowMs: number): string {
  if (item.status !== "running") return "—";
  const elapsed = secondsBetween(item.started_at, null, nowMs);
  const current = item.progress_current ?? 0;
  const total = item.progress_total ?? 0;
  if (current >= total && total > 0) return "0s";
  if (elapsed === null || current <= 0 || total <= 0) return "estimating";
  const remaining = (elapsed / current) * (total - current);
  return formatDuration(remaining);
}
