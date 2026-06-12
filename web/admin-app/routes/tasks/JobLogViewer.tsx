// Live log viewer for one job.
//
// Historical lines come from GET /logs (one fetch on open); live lines arrive
// via job_log_line WS events. These are high-frequency, so they are kept in
// local component state — deliberately NOT in the query cache (see the note in
// wsInvalidation.ts). The buffer is capped and auto-scrolls when the user is
// already near the bottom.

import { useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import { adminWs } from "../../lib/ws";
import type { JobLog, JobLogLineEventFull } from "../../lib/types";

const MAX_LINES = 1500;
const LEVELS = ["info", "warn", "error", "debug"] as const;

interface Line {
  key: string;
  level: string;
  message: string;
  ts: string;
}

export function JobLogViewer({ jobId }: { jobId: string }): JSX.Element {
  const [lines, setLines] = useState<Line[]>([]);
  const [loading, setLoading] = useState(true);
  // Debug lines are hidden by default — they are the verbose per-batch firehose.
  const [hidden, setHidden] = useState<Set<string>>(() => new Set(["debug"]));
  const boxRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const toggleLevel = (level: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(level)) next.delete(level);
      else next.add(level);
      return next;
    });

  // Initial history load.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get<{ logs: JobLog[] }>(`/admin/api/jobs/${jobId}/logs?limit=500`)
      .then((res) => {
        if (cancelled) return;
        setLines(
          res.logs.map((l) => ({
            key: `h${l.job_log_id}`,
            level: l.level,
            message: l.message,
            ts: l.created_at,
          })),
        );
      })
      .catch(() => {
        if (!cancelled) setLines([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  // Live append.
  useEffect(() => {
    let seq = 0;
    const unsubscribe = adminWs.subscribe((evt) => {
      if (evt.type !== "job_log_line") return;
      const data = evt.data as unknown as JobLogLineEventFull;
      if (data.job_id !== jobId) return;
      setLines((prev) => {
        const next = [
          ...prev,
          { key: `l${seq++}`, level: data.level, message: data.message, ts: data.timestamp },
        ];
        return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
      });
    });
    return unsubscribe;
  }, [jobId]);

  // Auto-scroll to bottom when new lines arrive, unless the user scrolled up.
  useEffect(() => {
    const box = boxRef.current;
    if (box && stickToBottom.current) box.scrollTop = box.scrollHeight;
  }, [lines]);

  function onScroll() {
    const box = boxRef.current;
    if (!box) return;
    stickToBottom.current = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  }

  const visible = lines.filter((l) => !hidden.has(l.level.toLowerCase()));

  return (
    <>
      <div className="log-filter">
        {LEVELS.map((lvl) => (
          <button
            key={lvl}
            type="button"
            className={`log-filter__chip log-filter__chip--${lvl}${
              hidden.has(lvl) ? " log-filter__chip--off" : ""
            }`}
            onClick={() => toggleLevel(lvl)}
            aria-pressed={!hidden.has(lvl)}
          >
            {lvl}
          </button>
        ))}
      </div>
      <div className="log-viewer" ref={boxRef} onScroll={onScroll}>
        {loading ? (
          <div className="muted small">Loading logs…</div>
        ) : visible.length === 0 ? (
          <div className="muted small">
            {lines.length === 0 ? "No log output." : "No lines match the current filter."}
          </div>
        ) : (
          visible.map((l) => (
            <div key={l.key} className={`log-line log-line--${l.level.toLowerCase()}`}>
              <span className="log-line__lvl">{l.level || "info"}</span>
              <span className="log-line__msg">{l.message}</span>
            </div>
          ))
        )}
      </div>
    </>
  );
}
