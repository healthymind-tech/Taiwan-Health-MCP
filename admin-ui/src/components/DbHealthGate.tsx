// Global database-health overlay. Polls /admin/api/health and, while the DB is
// down/recovering (or any request returned 503 database_unavailable, or the
// server itself is unreachable), shows a blocking overlay that disables the UI.
// It dismisses itself automatically once the database is healthy again.

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { qk } from "../lib/queryKeys";
import { onDbUnavailable } from "../lib/dbHealth";
import type { DbHealthSnapshot } from "../lib/types";

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export function DbHealthGate(): JSX.Element | null {
  const qc = useQueryClient();
  const [optimisticDown, setOptimisticDown] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const { data, isError } = useQuery({
    queryKey: qk.dbHealth,
    queryFn: () => api.get<DbHealthSnapshot>("/admin/api/health"),
    // Poll fast while anything looks wrong, slow when healthy.
    refetchInterval: (q) => {
      const unhealthy =
        (q.state.data && !q.state.data.healthy) || optimisticDown || !!q.state.error;
      return unhealthy ? 2500 : 8000;
    },
    retry: false,
    refetchOnWindowFocus: true,
  });

  // A 503 from any other request flips the overlay on at once and forces a poll.
  useEffect(
    () =>
      onDbUnavailable(() => {
        setOptimisticDown(true);
        void qc.invalidateQueries({ queryKey: qk.dbHealth });
      }),
    [qc],
  );

  // Clear the optimistic flag once a poll confirms the DB is healthy again.
  useEffect(() => {
    if (data?.healthy) setOptimisticDown(false);
  }, [data?.healthy]);

  const down = isError ? true : data ? !data.healthy : false;
  const show = down || optimisticDown;

  // Live timer while the overlay is visible.
  useEffect(() => {
    if (!show) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [show]);

  if (!show) return null;

  const serverUnreachable = isError && !data;
  const state = serverUnreachable ? "Server/DB unreachable" : data?.state ?? "unreachable";
  const sinceMs = data?.since ? Date.parse(data.since) : NaN;
  const elapsed = Number.isFinite(sinceMs)
    ? (now - sinceMs) / 1000
    : data?.for_seconds ?? 0;

  return (
    <div className="dbgate" role="alertdialog" aria-live="assertive" aria-modal="true">
      <div className="dbgate__card">
        <div className="dbgate__spinner" aria-hidden />
        <h2 className="dbgate__title">Database recovering</h2>
        <p className="dbgate__sub">
          Operations are paused and will resume automatically once the database
          is back online.
        </p>
        <dl className="dbgate__meta">
          <div>
            <dt>Status</dt>
            <dd>{state}</dd>
          </div>
          <div>
            <dt>For</dt>
            <dd>{formatDuration(elapsed)}</dd>
          </div>
          {data?.last_error ? (
            <div>
              <dt>Last error</dt>
              <dd className="dbgate__err">{data.last_error}</dd>
            </div>
          ) : null}
        </dl>
        <div className="dbgate__retry">
          <span className="dbgate__retry-dot" aria-hidden />
          Retrying automatically…
        </div>
      </div>
    </div>
  );
}
