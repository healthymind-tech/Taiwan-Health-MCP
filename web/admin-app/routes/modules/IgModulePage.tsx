import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { qk } from "../../lib/queryKeys";
import { useActiveJobTypes } from "../../lib/jobs";
import { toast } from "../../components/toast";
import { StatusBadge } from "../../components/StatusBadge";
import type { ModulesPayload } from "../../lib/types";
import { IgAddModal } from "./IgAddModal";
import { IgDetailDrawer } from "./IgDetailDrawer";
import { IgPreviewModal } from "./IgPreviewModal";

const MODULE_KEY = "ig";
const LABEL = "Implementation Guides";
const IMPORT_JOB = "ig_import";

export interface IgCounts {
  artifacts: number;
  codesystems: number;
  concepts: number;
}
export interface IgMissingDep {
  package_id: string;
  version: string;
  reason?: string;
}
export interface IgSummary {
  package_id: string;
  version: string;
  title: string;
  canonical: string | null;
  fhir_version: string | null;
  status: string | null;
  is_default: boolean;
  imported_at: string | null;
  dependencies: Record<string, string>;
  counts: IgCounts;
  deps_total: number;
  deps_missing: IgMissingDep[];
}

interface IgsResponse {
  igs: IgSummary[];
}

export function IgModulePage(): JSX.Element {
  const qc = useQueryClient();
  const activeJobTypes = useActiveJobTypes();
  const importing = activeJobTypes.has(IMPORT_JOB);

  const [showAdd, setShowAdd] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [selected, setSelected] = useState<{ id: string; version: string } | null>(null);

  const modulesQ = useQuery({
    queryKey: qk.modules,
    queryFn: () => api.get<ModulesPayload>("/admin/api/modules"),
    staleTime: 15_000,
  });

  const igsQ = useQuery({
    queryKey: qk.igs,
    queryFn: () => api.get<IgsResponse>("/admin/api/igs"),
    // While an import recurses through dependencies, poll so cards (and the
    // "N missing" chips) update live as each package lands.
    refetchInterval: importing ? 3000 : false,
  });

  function refresh() {
    void qc.invalidateQueries({ queryKey: qk.igs });
    void qc.invalidateQueries({ queryKey: qk.modules });
    void qc.invalidateQueries({ queryKey: qk.overview });
  }

  const toggleMaintenance = useMutation({
    mutationFn: (enabled: boolean) =>
      api.post("/admin/api/module-maintenance", { module_key: MODULE_KEY, enabled }),
    onSuccess: (_d, enabled) => {
      void qc.invalidateQueries({ queryKey: qk.modules });
      void qc.invalidateQueries({ queryKey: qk.overview });
      toast.success(enabled ? "Maintenance mode enabled" : "Maintenance mode disabled");
    },
    onError: (err) => toast.error(String(err)),
  });

  const clearAll = useMutation({
    mutationFn: () => api.post(`/admin/api/modules/${MODULE_KEY}/clear`, {}),
    onSuccess: () => {
      refresh();
      toast.success("All Implementation Guides cleared");
    },
    onError: (err) => toast.error(String(err)),
  });

  const data = modulesQ.data;
  const maintenance = data?.maintenance?.[MODULE_KEY] ?? false;
  const recordCount = data?.record_counts?.[MODULE_KEY] ?? 0;
  const populated = recordCount > 0;
  const storage = data?.storage;
  const igs = igsQ.data?.igs ?? [];

  function confirmClear() {
    if (
      window.confirm(
        "Clear ALL Implementation Guides?\n\nThis removes every imported IG package " +
          "(CodeSystems, concepts, artifacts) and uploaded package files. You will need " +
          "to re-add IGs from the registry or by upload. This cannot be undone.",
      )
    ) {
      clearAll.mutate();
    }
  }

  return (
    <div>
      <div className="module-card__head">
        <div>
          <h3 className="subhead" style={{ margin: 0 }}>
            {LABEL}
          </h3>
          <div className="muted small">
            {igs.length > 0
              ? `${igs.length} IG${igs.length === 1 ? "" : "s"} installed · ` +
                `${recordCount.toLocaleString()} indexed records`
              : "No Implementation Guides installed yet"}
          </div>
        </div>
        <div className="head-actions">
          <label
            className="switch"
            title="Maintenance mode pauses the FHIR IG tools and unlocks destructive actions"
          >
            <input
              type="checkbox"
              checked={maintenance}
              disabled={toggleMaintenance.isPending}
              onChange={(e) => toggleMaintenance.mutate(e.target.checked)}
            />
            <span className="switch__track" aria-hidden="true" />
            <span className="switch__label">Maintenance</span>
          </label>
          <button
            type="button"
            className="btn"
            disabled={!populated}
            title={!populated ? "Add an IG first" : "Browse all installed IG content"}
            onClick={() => setShowPreview(true)}
          >
            Browse content
          </button>
          <button type="button" className="btn btn--active" onClick={() => setShowAdd(true)}>
            + Add IG
          </button>
        </div>
      </div>

      {maintenance && (
        <div className="banner banner--warn">
          <strong>Maintenance mode is ON.</strong> The FHIR IG tools return a
          service-under-maintenance response. Turn this off when you are done modifying the module.
        </div>
      )}

      {importing && (
        <div className="banner banner--info">
          <span className="ig-spinner" aria-hidden="true" /> Importing — fetching the package and its
          dependency IGs from the registry. Cards update as each package lands.
        </div>
      )}

      {storage && (
        <div className="summary-row">
          <StatusBadge status={storage.minio_enabled ? "ready" : "unavailable"} />
          <span className="muted small">
            Object storage: {storage.detail}
            {storage.bucket ? ` (${storage.bucket})` : ""}
          </span>
        </div>
      )}

      {igsQ.isPending ? (
        <div className="ig-grid">
          {[0, 1, 2].map((i) => (
            <div key={i} className="ig-card ig-card--skeleton" />
          ))}
        </div>
      ) : igsQ.isError ? (
        <div className="error-box">Failed to load IGs: {String(igsQ.error)}</div>
      ) : igs.length === 0 ? (
        <div className="module-card ig-empty">
          <div className="ig-empty__title">No Implementation Guides yet</div>
          <div className="muted">
            Add one from the FHIR registry (e.g. <code>hl7.fhir.us.core</code>) or upload a
            package <code>.tgz</code>. Declared dependency IGs are fetched automatically.
          </div>
          <button type="button" className="btn btn--active" onClick={() => setShowAdd(true)}>
            + Add your first IG
          </button>
        </div>
      ) : (
        <div className="ig-grid">
          {igs.map((ig) => (
            <IgCard
              key={`${ig.package_id}@${ig.version}`}
              ig={ig}
              onOpen={() => setSelected({ id: ig.package_id, version: ig.version })}
            />
          ))}
        </div>
      )}

      {populated && maintenance && (
        <div className="module-card" style={{ marginTop: 16 }}>
          <div className="source-role__head" style={{ borderTop: "none" }}>
            <div>
              <strong>Clear &amp; start over</strong>
              <div className="muted small">
                Wipes every installed IG (CodeSystems, concepts, artifacts) and uploaded files.
              </div>
            </div>
            <button
              type="button"
              className="btn btn--danger"
              disabled={clearAll.isPending}
              onClick={confirmClear}
            >
              {clearAll.isPending ? "Clearing…" : "Clear all IGs"}
            </button>
          </div>
        </div>
      )}

      {showAdd && (
        <IgAddModal
          onClose={() => setShowAdd(false)}
          onStarted={() => {
            setShowAdd(false);
            void qc.invalidateQueries({ queryKey: qk.jobs });
            void qc.invalidateQueries({ queryKey: qk.igs });
          }}
        />
      )}
      {selected && (
        <IgDetailDrawer
          packageId={selected.id}
          version={selected.version}
          onClose={() => setSelected(null)}
          onChanged={refresh}
        />
      )}
      {showPreview && <IgPreviewModal onClose={() => setShowPreview(false)} />}
    </div>
  );
}

function IgCard({ ig, onOpen }: { ig: IgSummary; onOpen: () => void }): JSX.Element {
  const missing = ig.deps_missing.length;
  return (
    <button type="button" className="ig-card" onClick={onOpen}>
      <div className="ig-card__head">
        <span className="ig-card__title">{ig.title}</span>
        {ig.is_default && (
          <span className="ig-card__star" title="Default IG">
            ★
          </span>
        )}
      </div>
      <div className="ig-card__pkg">{ig.package_id}</div>
      <div className="ig-card__badges">
        <span className="badge badge--muted">v{ig.version}</span>
        {ig.fhir_version && <span className="badge badge--muted">{ig.fhir_version}</span>}
        {ig.status && <span className="badge badge--muted">{ig.status}</span>}
      </div>
      <div className="ig-card__counts muted small">
        {ig.counts.artifacts.toLocaleString()} artifacts ·{" "}
        {ig.counts.codesystems.toLocaleString()} CodeSystems ·{" "}
        {ig.counts.concepts.toLocaleString()} concepts
      </div>
      <div className="ig-card__deps">
        {ig.deps_total === 0 ? (
          <span className="chip chip--muted">no dependencies</span>
        ) : missing === 0 ? (
          <span className="chip chip--ok">✓ dependencies complete</span>
        ) : (
          <span className="chip chip--warn">
            ⚠ {missing} missing {missing === 1 ? "dependency" : "dependencies"}
          </span>
        )}
      </div>
    </button>
  );
}
