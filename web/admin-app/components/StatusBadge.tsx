// Status pill reused across tabs (job status, service health, module state).

type Tone = "ok" | "warn" | "bad" | "muted";

const TONE_BY_STATUS: Record<string, Tone> = {
  // job statuses
  completed: "ok",
  success: "ok",
  running: "warn",
  queued: "muted",
  paused: "warn",
  failed: "bad",
  cancelled: "muted",
  // service / module health
  ok: "ok",
  ready: "ok",
  healthy: "ok",
  degraded: "warn",
  maintaining: "warn",
  maintenance: "warn",
  unavailable: "bad",
  error: "bad",
  empty: "muted",
};

export function StatusBadge({ status }: { status: string }): JSX.Element {
  const tone = TONE_BY_STATUS[status.toLowerCase()] ?? "muted";
  return <span className={`badge badge--${tone}`}>{status}</span>;
}
