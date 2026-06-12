// A single module's page (/modules/:moduleKey).
//
// Handles both upload-based modules (icd/loinc/drug/ig/snomed — source
// uploads, activate, import, embed) and action-only modules (guideline /
// health_supplements / food_nutrition — sync/seed). The drug page also embeds the
// pipeline panel. Reactive status still flows from the WS map: a finished
// import invalidates qk.modules and this page re-renders automatically.

import { useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { qk } from "../../lib/queryKeys";
import { formatRelative } from "../../lib/time";
import { useActiveJobTypes } from "../../lib/jobs";
import { ACTION_MODULES, UPLOAD_MODULE_META } from "../../lib/moduleMeta";
import { PREVIEW_SUPPORTED_MODULES, SCHEDULABLE_MODULES } from "../../lib/adminSets";
import { toast } from "../../components/toast";
import { StatusBadge } from "../../components/StatusBadge";
import { EmbeddingStatus, EmbedButton } from "./EmbeddingStatus";
import { IcdModulePage } from "./IcdModulePage";
import { LoincModulePage } from "./LoincModulePage";
import { SnomedModulePage } from "./SnomedModulePage";
import { RxnormModulePage } from "./RxnormModulePage";
import { IgModulePage } from "./IgModulePage";
import { DrugModulePage } from "./drug/DrugModulePage";
import { UploadField } from "./UploadField";
import { VersionHistoryModal } from "./VersionHistoryModal";
import { ScheduleModal } from "./ScheduleModal";
import { DataPreviewModal } from "./DataPreviewModal";
import type { CatalogEntry, ModulesPayload, UploadedFile } from "../../lib/types";

type ModalKind = "versions" | "schedule" | "preview";
type ModalState = { kind: ModalKind; sourceRoles: string[] } | null;

interface JobBody {
  job_type: string;
  module_key: string;
  job_options?: Record<string, unknown>;
  source_uploaded_file_id?: string;
}
type SourceAction = "activate" | "deactivate" | "delete";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function ModulePage(): JSX.Element {
  const { moduleKey = "" } = useParams();

  // ICD has its own state machine (maintenance mode, required uploads, clear-all);
  // it deliberately does not use versions / activate / schedule.
  if (moduleKey === "icd") return <IcdModulePage />;
  if (moduleKey === "loinc") return <LoincModulePage />;
  if (moduleKey === "snomed") return <SnomedModulePage />;
  if (moduleKey === "rxnorm") return <RxnormModulePage />;
  if (moduleKey === "ig") return <IgModulePage />;
  if (moduleKey === "drug") return <DrugModulePage />;

  return <GenericModulePage moduleKey={moduleKey} />;
}

function GenericModulePage({ moduleKey }: { moduleKey: string }): JSX.Element {
  const qc = useQueryClient();
  const activeJobTypes = useActiveJobTypes();
  const isRunning = (jobType: string | null): boolean => !!jobType && activeJobTypes.has(jobType);
  const [modal, setModal] = useState<ModalState>(null);

  const meta = UPLOAD_MODULE_META[moduleKey];
  const action = ACTION_MODULES.find((d) => d.moduleKey === moduleKey);
  const label = meta?.label ?? action?.label ?? moduleKey;

  const modulesQ = useQuery({
    queryKey: qk.modules,
    queryFn: () => api.get<ModulesPayload>("/admin/api/modules"),
    staleTime: 15_000,
    enabled: !!meta || !!action, // upload modules need the catalog; action modules need record_counts
  });

  const triggerJob = useMutation({
    mutationFn: (body: JobBody) => api.post("/admin/api/jobs", body),
    onSuccess: (_d, body) => {
      void qc.invalidateQueries({ queryKey: qk.jobs });
      toast.success(`Started ${body.job_type}`);
    },
    onError: (err) => toast.error(`Failed to start job: ${String(err)}`),
  });

  const sourceAction = useMutation({
    mutationFn: (v: { action: SourceAction; uploaded_file_id: string }) =>
      api.post(`/admin/api/module-sources/${v.action}`, { uploaded_file_id: v.uploaded_file_id }),
    onSuccess: (_d, v) => {
      void qc.invalidateQueries({ queryKey: qk.modules });
      toast.success(`Source ${v.action}d`);
    },
    onError: (err) => toast.error(String(err)),
  });

  function refreshModules() {
    void qc.invalidateQueries({ queryKey: qk.modules });
  }
  function confirmDelete(file: UploadedFile) {
    if (window.confirm(`Delete uploaded file "${file.original_filename}"? This only removes the upload.`)) {
      sourceAction.mutate({ action: "delete", uploaded_file_id: file.uploaded_file_id });
    }
  }

  function SecondaryActions({
    sourceRoles,
    previewDisabled = false,
    previewDisabledReason = "Load data before previewing this module.",
  }: {
    sourceRoles: string[];
    previewDisabled?: boolean;
    previewDisabledReason?: string;
  }): JSX.Element {
    return (
      <>
        {sourceRoles.length > 0 && (
          <button type="button" className="btn" onClick={() => setModal({ kind: "versions", sourceRoles })}>
            Versions
          </button>
        )}
        {SCHEDULABLE_MODULES.has(moduleKey) && (
          <button type="button" className="btn" onClick={() => setModal({ kind: "schedule", sourceRoles })}>
            Schedule
          </button>
        )}
        {PREVIEW_SUPPORTED_MODULES.has(moduleKey) && (
          <button
            type="button"
            className="btn"
            disabled={previewDisabled}
            title={previewDisabled ? previewDisabledReason : undefined}
            onClick={() => setModal({ kind: "preview", sourceRoles })}
          >
            Preview data
          </button>
        )}
      </>
    );
  }

  const modals = (sourceRoles: string[]) => (
    <>
      {modal?.kind === "versions" && (
        <VersionHistoryModal moduleKey={moduleKey} label={label} onClose={() => setModal(null)} />
      )}
      {modal?.kind === "schedule" && (
        <ScheduleModal moduleKey={moduleKey} label={label} sourceRoles={sourceRoles} onClose={() => setModal(null)} />
      )}
      {modal?.kind === "preview" && (
        <DataPreviewModal moduleKey={moduleKey} label={label} onClose={() => setModal(null)} />
      )}
    </>
  );

  // ── Unknown module ──
  if (!meta && !action) {
    return <div className="error-box">Unknown module: {moduleKey}</div>;
  }

  // ── Action-only module (no uploads) ──
  if (!meta && action) {
    if (modulesQ.isPending) return <div className="muted">Loading…</div>;
    if (modulesQ.isError) return <div className="error-box">Failed to load: {String(modulesQ.error)}</div>;

    const recordCount = modulesQ.data.record_counts?.[action.moduleKey] ?? 0;
    const populated = recordCount > 0;
    const running = isRunning(action.jobType);
    const embedding = isRunning(action.embedJobType);
    const emptyReason = `${action.label} has no loaded records yet. Run ${action.actionLabel} first.`;
    return (
      <div>
        <div className="module-card__head">
          <div>
            <h3 className="subhead" style={{ margin: 0 }}>{action.label}</h3>
            <div className="muted small">{action.description}</div>
          </div>
          <div className="head-actions">
            <button
              type="button"
              className="btn"
              disabled={running}
              onClick={() =>
                triggerJob.mutate({ job_type: action.jobType, module_key: action.moduleKey, job_options: { source: "admin-console" } })
              }
            >
              {running ? "Running…" : action.actionLabel}
            </button>
            {action.embedJobType && (
              <EmbedButton
                moduleKey={action.moduleKey}
                populated={populated}
                busy={embedding}
                notReadyReason={emptyReason}
                onEmbed={() => triggerJob.mutate({ job_type: action.embedJobType!, module_key: action.moduleKey })}
              />
            )}
            <SecondaryActions sourceRoles={[]} previewDisabled={!populated} previewDisabledReason={emptyReason} />
          </div>
        </div>
        <div className="summary-row">
          <StatusBadge status={populated ? "ready" : "empty"} />
          <span className="muted small">
            {populated ? `${recordCount.toLocaleString()} loaded records` : "No loaded records yet"}
          </span>
        </div>
        <EmbeddingStatus moduleKey={action.moduleKey} />
        {modals([])}
      </div>
    );
  }

  // ── Upload-based module ──
  if (modulesQ.isPending) return <div className="muted">Loading…</div>;
  if (modulesQ.isError) return <div className="error-box">Failed to load: {String(modulesQ.error)}</div>;

  const entries: CatalogEntry[] = modulesQ.data.modules.filter((e) => e.module_key === moduleKey);
  const sourceRoles = entries.map((e) => e.source_role);
  const maxUploadMb = modulesQ.data.upload_limits.max_upload_mb;
  const importing = isRunning(meta!.importJobType);
  const embedding = isRunning(meta!.embedJobType);
  const storage = modulesQ.data.storage;

  return (
    <div>
      <div className="module-card__head">
        <div>
          <h3 className="subhead" style={{ margin: 0 }}>{meta!.label}</h3>
          <div className="muted small">
            Last imported {formatRelative(entries[0]?.last_imported_at)}
            {entries[0]?.cumulative_total != null ? ` · ${entries[0].cumulative_total} records` : ""}
          </div>
        </div>
        <div className="head-actions">
          {!meta!.perFileImport && (
            <button
              type="button"
              className="btn"
              disabled={importing}
              onClick={() => triggerJob.mutate({ job_type: meta!.importJobType, module_key: moduleKey, job_options: { source: "admin-console" } })}
            >
              {importing ? "Importing…" : "Import now"}
            </button>
          )}
          {meta!.embedJobType && (
            <button type="button" className="btn" disabled={embedding} onClick={() => triggerJob.mutate({ job_type: meta!.embedJobType!, module_key: moduleKey })}>
              {embedding ? "Embedding…" : "Embed"}
            </button>
          )}
          <SecondaryActions sourceRoles={sourceRoles} />
        </div>
      </div>

      <div className="summary-row">
        <StatusBadge status={storage.minio_enabled ? "ready" : "unavailable"} />
        <span className="muted small">
          Object storage: {storage.detail}
          {storage.bucket ? ` (${storage.bucket})` : ""}
        </span>
      </div>

      {entries.map((entry) => (
        <div className="source-role" key={entry.source_role}>
          <div className="source-role__head">
            <div>
              <strong>{entry.label}</strong>
              <div className="muted small">{entry.description}</div>
            </div>
            <UploadField
              moduleKey={entry.module_key}
              sourceRole={entry.source_role}
              acceptedExtensions={entry.accepted_extensions}
              autoActivate={!entry.multi_source}
              maxUploadMb={maxUploadMb}
              onUploaded={refreshModules}
            />
          </div>
          {entry.recent_uploads.length > 0 ? (
            <div className="service-list">
              {entry.recent_uploads.map((file) => (
                <div className="row row--service" key={file.uploaded_file_id}>
                  <div className="row__main">
                    <div className="row__name">
                      {file.original_filename}{" "}
                      {file.is_active && <span className="badge badge--ok">active</span>}
                      {file.imported && <span className="badge badge--ok">imported</span>}
                    </div>
                    <div className="muted small">
                      {formatBytes(file.size_bytes)} · {file.uploaded_by} · {formatRelative(file.uploaded_at)}
                      {file.validation_error ? ` · ${file.validation_error}` : ""}
                    </div>
                  </div>
                  <div className="row__meta">
                    <StatusBadge status={file.validation_status} />
                    {meta!.perFileImport && !file.imported && (
                      <button
                        type="button"
                        className="btn btn--sm"
                        disabled={importing}
                        onClick={() =>
                          triggerJob.mutate({
                            job_type: meta!.importJobType,
                            module_key: entry.module_key,
                            source_uploaded_file_id: file.uploaded_file_id,
                          })
                        }
                      >
                        Import
                      </button>
                    )}
                    {!meta!.perFileImport && file.module_source_id && !file.is_active && (
                      <button type="button" className="btn btn--sm" onClick={() => sourceAction.mutate({ action: "activate", uploaded_file_id: file.uploaded_file_id })}>
                        Activate
                      </button>
                    )}
                    {!meta!.perFileImport && file.is_active && (
                      <button type="button" className="btn btn--sm" onClick={() => sourceAction.mutate({ action: "deactivate", uploaded_file_id: file.uploaded_file_id })}>
                        Deactivate
                      </button>
                    )}
                    <button type="button" className="btn btn--sm" onClick={() => confirmDelete(file)}>
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="muted small" style={{ padding: "8px 0" }}>
              No uploads yet.
            </div>
          )}
        </div>
      ))}

      {modals(sourceRoles)}
    </div>
  );
}
