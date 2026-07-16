// Status pill reused across tabs (job status, service health, module state).

type Tone = "ok" | "live" | "warn" | "bad" | "halt" | "muted";

const TONE_BY_STATUS: Record<string, Tone> = {
  // Job statuses. The three an operator acts on must never share a colour:
  // running (blue, in flight) / paused (amber, waiting on you) / stopped (slate,
  // deliberately ended). `queued` stays muted — nothing has happened to it yet.
  completed: "ok",
  success: "ok",
  running: "live",
  queued: "muted",
  paused: "warn",
  stopped: "halt",
  cancelled: "halt",
  failed: "bad",
  retryable_failed: "bad",
  permanent_failed: "bad",
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
  // guideline PDF pipeline (pipeline_stage / review_status)
  ocr_running: "live",
  analysis_running: "live",
  ocr_failed: "bad",
  analysis_failed: "bad",
  pending_review: "warn",
  approved: "ok",
  rejected: "bad",
};

export function StatusBadge({ status }: { status: string }): JSX.Element {
  const tone = TONE_BY_STATUS[status.toLowerCase()] ?? "muted";
  return <span className={`badge badge--${tone}`}>{status}</span>;
}
