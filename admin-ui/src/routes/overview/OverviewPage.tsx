// Overview tab — the Phase A proof that the reactive backbone works end to end.
// It reads /admin/api/overview through TanStack Query; the WS invalidation map
// refreshes it whenever a job reaches a terminal state, with no manual reload.

import { Fragment } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { qk } from "../../lib/queryKeys";
import type { OverviewPayload } from "../../lib/types";
import { SERVICE_CATEGORIES, serviceLabel } from "../../lib/serviceCategories";
import { StatusBadge } from "../../components/StatusBadge";

// Each overview service is { initialized, module_ready, health: { status, reason } }.
interface ServiceInfo {
  initialized?: boolean;
  module_ready?: boolean;
  health?: { status?: string; reason?: string };
}

function serviceStatus(svc: ServiceInfo): string {
  return svc.health?.status ?? (svc.initialized ? "ok" : "unavailable");
}

function SummaryCard({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="card">
      <div className="card__label">{label}</div>
      <div className="card__value">{value}</div>
    </div>
  );
}

function ServiceRow({ name, info }: { name: string; info: ServiceInfo }): JSX.Element {
  return (
    <div className="row row--service">
      <div className="row__main">
        <div className="row__name">{serviceLabel(name)}</div>
        {info.health?.reason && <div className="muted small">{info.health.reason}</div>}
      </div>
      <div className="row__meta">
        {info.module_ready === false && <span className="muted small">no data</span>}
        <StatusBadge status={serviceStatus(info)} />
      </div>
    </div>
  );
}

export function OverviewPage(): JSX.Element {
  const { data, isPending, isError, error, isFetching } = useQuery({
    queryKey: qk.overview,
    queryFn: () => api.get<OverviewPayload>("/admin/api/overview"),
    staleTime: 30_000,
  });

  if (isPending) return <div className="muted">Loading overview…</div>;
  if (isError) return <div className="error-box">Failed to load overview: {String(error)}</div>;

  const summary = data.summary ?? {};
  const services = (data.services ?? {}) as Record<string, ServiceInfo>;
  const fhirServers = data.fhir_servers;

  // Group services into ordered categories; unknown keys land in "Other".
  const usedKeys = new Set<string>();
  const serviceGroups = SERVICE_CATEGORIES.map((cat) => {
    const items = cat.keys
      .filter((k) => k in services)
      .map((k) => {
        usedKeys.add(k);
        return [k, services[k]] as const;
      });
    return { label: cat.label, items };
  }).filter((g) => g.items.length > 0);
  const otherItems = Object.entries(services).filter(([k]) => !usedKeys.has(k));
  if (otherItems.length > 0) {
    serviceGroups.push({ label: "Other", items: otherItems });
  }

  return (
    <section>
      <header className="section-head">
        <h2>Overview</h2>
        <span className="muted small">
          {isFetching ? "Refreshing…" : `Updated ${data.generated_at}`}
        </span>
      </header>

      <div className="card-grid">
        {Object.entries(summary).map(([k, v]) => (
          <SummaryCard key={k} label={k} value={String(v)} />
        ))}
      </div>

      {serviceGroups.map((group) => {
        const total = group.items.length;
        const ok = group.items.filter(([, info]) => serviceStatus(info) === "ok").length;
        return (
          <Fragment key={group.label}>
            <h3 className="subhead">
              {group.label}{" "}
              <span className="muted small">({ok}/{total} ok)</span>
            </h3>
            <div className="service-list">
              {group.items.map(([name, info]) => (
                <ServiceRow key={name} name={name} info={info} />
              ))}
            </div>
          </Fragment>
        );
      })}

      {fhirServers && (
        <>
          <h3 className="subhead">
            External FHIR servers{" "}
            <span className="muted small">
              {fhirServers.total > 0
                ? `(${fhirServers.ok}/${fhirServers.total} probed OK)`
                : "(none registered)"}
            </span>
          </h3>
          {fhirServers.error ? (
            <div className="error-box">Failed to read FHIR servers: {fhirServers.error}</div>
          ) : fhirServers.items.length === 0 ? (
            <div className="muted small">
              No external FHIR servers configured. Add one under Modules → FHIR Servers.
            </div>
          ) : (
            <div className="service-list">
              {fhirServers.items.map((s) => {
                // last_probe_status is "ok" / "error" / "" (never probed).
                const probed = s.last_probe_status !== "";
                const detail = !s.enabled
                  ? "disabled"
                  : !probed
                    ? "never probed — run Probe on the FHIR Servers page"
                    : s.last_probe_error || (s.last_probe_at ? `probed ${s.last_probe_at}` : "");
                return (
                  <div className="row row--service" key={s.server_key}>
                    <div className="row__main">
                      <div className="row__name">
                        {s.name}{" "}
                        <span className="muted small">
                          {s.server_key}
                          {s.is_default ? " · default" : ""} · {s.auth_profile}
                        </span>
                      </div>
                      {detail && <div className="muted small">{detail}</div>}
                    </div>
                    <div className="row__meta">
                      {probed ? (
                        <StatusBadge status={s.last_probe_status === "ok" ? "ok" : "error"} />
                      ) : (
                        <span className="muted small">not probed</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </section>
  );
}
