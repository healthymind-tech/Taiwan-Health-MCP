// Services tab — cached probe results plus on-demand re-probing.
//
// The probe endpoint returns the full refreshed payload, so onSuccess writes it
// straight into the query cache (instant update) and also invalidates the
// overview, which surfaces the same service health.

import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { qk } from "../../lib/queryKeys";
import { formatRelative } from "../../lib/time";
import { toast } from "../../components/toast";
import { StatusBadge } from "../../components/StatusBadge";
import type { ServiceProbe, ServicesPayload } from "../../lib/types";

const CATEGORY_ORDER = ["infrastructure", "storage", "ml", "other"] as const;
const CATEGORY_LABEL: Record<string, string> = {
  infrastructure: "Infrastructure",
  storage: "Storage",
  ml: "ML / Model servers",
  other: "Other",
};

function groupByCategory(services: ServiceProbe[]): Map<string, ServiceProbe[]> {
  const groups = new Map<string, ServiceProbe[]>();
  for (const svc of services) {
    const key = CATEGORY_ORDER.includes(svc.category as never) ? svc.category : "other";
    const bucket = groups.get(key) ?? [];
    bucket.push(svc);
    groups.set(key, bucket);
  }
  return groups;
}

export function ServicesPage(): JSX.Element {
  const qc = useQueryClient();

  const { data, isPending, isError, error, isFetching } = useQuery({
    queryKey: qk.services,
    queryFn: () => api.get<ServicesPayload>("/admin/api/services"),
    staleTime: 15_000,
  });

  const probe = useMutation({
    // Empty service_keys = probe everything.
    mutationFn: (serviceKeys: string[]) =>
      api.post<ServicesPayload>("/admin/api/services/probe", { service_keys: serviceKeys }),
    onSuccess: (result) => {
      qc.setQueryData(qk.services, result);
      void qc.invalidateQueries({ queryKey: qk.overview });
      toast.success("Probe complete");
    },
    onError: (err) => toast.error(`Probe failed: ${String(err)}`),
  });

  // Which single service (if any) is currently being re-probed, for per-row spinners.
  const probingKey =
    probe.isPending && probe.variables?.length === 1 ? probe.variables[0] : null;
  const probingAll = probe.isPending && (probe.variables?.length ?? 0) !== 1;

  // Auto-probe everything once when the page opens, so the user always sees
  // freshly tested results instead of stale/unprobed cache. The ref guards
  // against re-firing on re-renders; navigating away and back remounts the
  // component and triggers a fresh probe.
  const autoProbed = useRef(false);
  useEffect(() => {
    if (!autoProbed.current && data && !probe.isPending) {
      autoProbed.current = true;
      probe.mutate([]);
    }
  }, [data, probe]);

  if (isPending) return <div className="muted">Loading services…</div>;
  if (isError) return <div className="error-box">Failed to load services: {String(error)}</div>;

  const groups = groupByCategory(data.services);
  const s = data.summary;

  return (
    <section>
      <header className="section-head">
        <h2>Services</h2>
        <div className="head-actions">
          <span className="muted small">
            {isFetching ? "Refreshing…" : `Checked ${formatRelative(s.last_checked_at)}`}
          </span>
          <button
            type="button"
            className="btn"
            disabled={probe.isPending}
            onClick={() => probe.mutate([])}
          >
            {probingAll ? "Probing…" : "Probe all"}
          </button>
        </div>
      </header>

      <div className="summary-row">
        <span className="badge badge--ok">{s.ok} ok</span>
        <span className="badge badge--warn">{s.degraded} degraded</span>
        <span className="badge badge--bad">{s.error} error</span>
        <span className="muted small">{s.total} total</span>
      </div>

      {CATEGORY_ORDER.filter((c) => groups.has(c)).map((category) => (
        <div key={category}>
          <h3 className="subhead">{CATEGORY_LABEL[category]}</h3>
          <div className="service-list">
            {groups.get(category)!.map((svc) => (
              <div className="row row--service" key={svc.service_key}>
                <div className="row__main">
                  <div className="row__name">{svc.label}</div>
                  <div className="muted small">
                    {svc.message || svc.description || svc.endpoint || "—"}
                  </div>
                </div>
                <div className="row__meta">
                  {svc.latency_ms != null && (
                    <span className="muted small">{svc.latency_ms} ms</span>
                  )}
                  <span className="muted small">{formatRelative(svc.checked_at)}</span>
                  <StatusBadge status={svc.status} />
                  <button
                    type="button"
                    className="btn btn--sm"
                    disabled={probe.isPending}
                    onClick={() => probe.mutate([svc.service_key])}
                  >
                    {probingKey === svc.service_key ? "…" : "Re-probe"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}
