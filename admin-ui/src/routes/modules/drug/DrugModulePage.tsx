import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../lib/api";
import { qk } from "../../../lib/queryKeys";
import { formatRelative } from "../../../lib/time";
import { useActiveJobTypes } from "../../../lib/jobs";
import { toast } from "../../../components/toast";
import { StatusBadge } from "../../../components/StatusBadge";
import { UploadField } from "../UploadField";
import { ScheduleModal } from "../ScheduleModal";
import { DrugPipelinePanel } from "./DrugPipelinePanel";
import { DrugLicensesModal } from "./DrugLicensesModal";
import type { CatalogEntry, ModulesPayload, UploadedFile } from "../../../lib/types";

const MODULE_KEY = "drug";
const LABEL = "Drug index";
const IMPORT_JOB = "drug_index_import";
const REQUIRED_ROLE = "drug_index_csv";
const DRUG_JOB_TYPES = ["drug_index_import", "drug_enrichment", "drug_analysis"] as const;

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function importStatus(file: UploadedFile): "pending" | "importing" | "imported" | "failed" {
  return file.import_status ?? (file.imported ? "imported" : "pending");
}

function statusBadge(status: ReturnType<typeof importStatus>): JSX.Element {
  if (status === "imported") return <span className="badge badge--ok">imported</span>;
  if (status === "importing") return <span className="badge badge--warn">importing</span>;
  if (status === "failed") return <span className="badge badge--bad">failed</span>;
  return <span className="badge badge--muted">pending</span>;
}

export function DrugModulePage(): JSX.Element {
  const qc = useQueryClient();
  const activeJobTypes = useActiveJobTypes();
  const [showSchedule, setShowSchedule] = useState(false);
  const [showPreview, setShowPreview] = useState(
    () => new URLSearchParams(window.location.search).get("drug_preview") === "1",
  );

  const modulesQ = useQuery({
    queryKey: qk.modules,
    queryFn: () => api.get<ModulesPayload>("/admin/api/modules"),
    staleTime: 15_000,
  });

  function refresh() {
    void qc.invalidateQueries({ queryKey: qk.modules });
    void qc.invalidateQueries({ queryKey: qk.drugPipeline });
    void qc.invalidateQueries({ queryKey: qk.overview });
  }

  const triggerImport = useMutation({
    mutationFn: (uploadedFileId: string) =>
      api.post("/admin/api/jobs", {
        job_type: IMPORT_JOB,
        module_key: MODULE_KEY,
        source_uploaded_file_id: uploadedFileId,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.jobs });
      refresh();
      toast.success(`Started ${IMPORT_JOB}`);
    },
    onError: (err) => toast.error(`Failed to start import: ${String(err)}`),
  });

  const deleteUpload = useMutation({
    mutationFn: (uploadedFileId: string) =>
      api.post("/admin/api/module-sources/delete", { uploaded_file_id: uploadedFileId }),
    onSuccess: () => {
      refresh();
      toast.success("Uploaded drug CSV deleted");
    },
    onError: (err) => toast.error(String(err)),
  });

  const toggleMaintenance = useMutation({
    mutationFn: (enabled: boolean) =>
      api.post("/admin/api/module-maintenance", { module_key: MODULE_KEY, enabled }),
    onSuccess: (_d, enabled) => {
      refresh();
      toast.success(enabled ? "Maintenance mode enabled" : "Maintenance mode disabled");
    },
    onError: (err) => toast.error(String(err)),
  });

  const clearAll = useMutation({
    mutationFn: () => api.post(`/admin/api/modules/${MODULE_KEY}/clear`, {}),
    onSuccess: () => {
      refresh();
      toast.success("Drug data, pipeline state, assets, and uploaded CSVs cleared");
    },
    onError: (err) => toast.error(String(err)),
  });

  if (modulesQ.isPending) return <div className="muted">Loading...</div>;
  if (modulesQ.isError) return <div className="error-box">Failed to load: {String(modulesQ.error)}</div>;

  const data = modulesQ.data;
  const entries: CatalogEntry[] = data.modules.filter((e) => e.module_key === MODULE_KEY);
  const entry = entries.find((e) => e.source_role === REQUIRED_ROLE);
  const files = entry?.recent_uploads ?? [];
  const storage = data.storage;
  const maintenance = data.maintenance?.[MODULE_KEY] ?? false;
  const totalRecords = data.record_counts?.[MODULE_KEY] ?? entry?.cumulative_total ?? 0;
  const populated = totalRecords > 0;
  const activeDrugJob = DRUG_JOB_TYPES.some((jobType) => activeJobTypes.has(jobType));
  const importing = activeDrugJob || triggerImport.isPending;
  const busy = activeDrugJob || triggerImport.isPending || toggleMaintenance.isPending || clearAll.isPending;
  const lastImported = entry?.last_imported_at ?? "";
  const counts = files.reduce(
    (acc, file) => {
      acc[importStatus(file)] += 1;
      return acc;
    },
    { pending: 0, importing: 0, imported: 0, failed: 0 },
  );

  function confirmDelete(file: UploadedFile) {
    if (
      window.confirm(
        `Delete uploaded file "${file.original_filename}"?\n\nOnly pending or failed drug index files can be deleted. Imported files are cumulative and cannot be unmerged individually.`,
      )
    ) {
      deleteUpload.mutate(file.uploaded_file_id);
    }
  }

  function confirmClear() {
    if (
      window.confirm(
        "Clear ALL Drug data?\n\nThis deletes every imported drug license, enrichment/analysis pipeline state, crawler asset record, stored PDF/image/OCR/analysis object, and uploaded Drug CSV. You will need to upload and import again. This cannot be undone.",
      )
    ) {
      clearAll.mutate();
    }
  }

  return (
    <div>
      <div className="module-card__head">
        <div>
          <h3 className="subhead" style={{ margin: 0 }}>{LABEL}</h3>
          <div className="muted small">
            {totalRecords.toLocaleString()} cumulative licenses
            {populated && lastImported ? ` · last imported ${formatRelative(lastImported)}` : ""}
          </div>
        </div>
        <div className="head-actions">
          <label className="switch" title="Maintenance mode pauses Drug tools and unlocks destructive clear-all">
            <input
              type="checkbox"
              checked={maintenance}
              disabled={toggleMaintenance.isPending}
              onChange={(e) => toggleMaintenance.mutate(e.target.checked)}
            />
            <span className="switch__track" aria-hidden="true" />
            <span className="switch__label">Maintenance</span>
          </label>
          <button type="button" className="btn" onClick={() => setShowSchedule(true)}>
            Schedule
          </button>
          <button
            type="button"
            className="btn"
            disabled={totalRecords === 0}
            title={totalRecords === 0 ? "Import drug index data first" : ""}
            onClick={() => setShowPreview(true)}
          >
            Preview data
          </button>
        </div>
      </div>

      {maintenance && (
        <div className="banner banner--warn">
          <strong>Maintenance mode is ON.</strong> Drug and FHIR Medication MCP tools
          return a service-under-maintenance response, and destructive clear-all is
          unlocked below. Turn this off when the module is ready to serve again.
        </div>
      )}

      <div className="summary-row">
        <StatusBadge status={storage.minio_enabled ? "ready" : "unavailable"} />
        <span className="muted small">
          Object storage: {storage.detail}
          {storage.bucket ? ` (${storage.bucket})` : ""}
        </span>
      </div>

      <DrugPipelinePanel
        disabled={!populated || clearAll.isPending}
        disabledReason={!populated ? "Import drug index data first" : "Clear is in progress"}
      />

      {populated && !maintenance && (
        <div className="module-card">
          <div className="muted">
            Drug is loaded and serving. New CSV uploads are cumulative imports. To wipe
            the whole Drug module and start over, enable <strong>Maintenance</strong>{" "}
            mode first.
          </div>
        </div>
      )}

      {populated && maintenance && (
        <div className="module-card">
          <div className="source-role__head" style={{ borderTop: "none" }}>
            <div>
              <strong>Clear &amp; start over</strong>
              <div className="muted small">
                Wipes drug licenses, normalized records, crawler assets, OCR/analysis
                outputs, pipeline state, and uploaded CSV files. Job history remains
                for audit, but the imported module returns to empty.
              </div>
            </div>
            <button
              type="button"
              className="btn btn--danger"
              disabled={busy}
              title={activeDrugJob ? "Wait for the active Drug job to finish or stop it first" : ""}
              onClick={confirmClear}
            >
              {clearAll.isPending ? "Clearing..." : "Clear all Drug data"}
            </button>
          </div>
        </div>
      )}

      <div className="module-card">
        <div className="source-role__head" style={{ borderTop: "none", marginBottom: 12 }}>
          <div>
            <strong>{entry?.label ?? "Drug index CSV"}</strong>
            <div className="muted small">
              Each imported CSV is cumulative. Pending or failed files may be deleted; imported files cannot be changed individually.
            </div>
          </div>
          {entry && (
            <UploadField
              moduleKey={MODULE_KEY}
              sourceRole={REQUIRED_ROLE}
              acceptedExtensions={entry.accepted_extensions}
              autoActivate={false}
              maxUploadMb={data.upload_limits.max_upload_mb}
              onUploaded={refresh}
            />
          )}
        </div>

        <div className="summary-row" style={{ marginBottom: 12, flexWrap: "wrap" }}>
          <span className="badge badge--muted">{counts.pending} pending</span>
          <span className="badge badge--warn">{counts.importing} importing</span>
          <span className="badge badge--ok">{counts.imported} imported</span>
          <span className="badge badge--bad">{counts.failed} failed</span>
        </div>

        {files.length === 0 ? (
          <div className="muted small">No uploads yet.</div>
        ) : (
          <div className="service-list">
            {files.map((file) => {
              const status = importStatus(file);
              const canImport = status === "pending" || status === "failed";
              const canDelete = status === "pending" || status === "failed";
              return (
                <div className="row row--service" key={file.uploaded_file_id}>
                  <div className="row__main">
                    <div className="row__name">
                      {file.original_filename} {statusBadge(status)}
                    </div>
                    <div className="muted small">
                      {formatBytes(file.size_bytes)} · uploaded {formatRelative(file.uploaded_at)}
                      {file.imported_at ? ` · imported ${formatRelative(file.imported_at)}` : ""}
                      {file.import_current_step ? ` · ${file.import_current_step}` : ""}
                    </div>
                    {file.import_error && <div className="error-box small">{file.import_error}</div>}
                  </div>
                  <div className="row__meta">
                    <StatusBadge status={file.validation_status} />
                    {canImport && (
                      <button
                        type="button"
                        className="btn btn--sm"
                        disabled={importing}
                        onClick={() => triggerImport.mutate(file.uploaded_file_id)}
                      >
                        {status === "failed" ? "Retry import" : "Import"}
                      </button>
                    )}
                    {canDelete && (
                      <button
                        type="button"
                        className="btn btn--sm"
                        disabled={deleteUpload.isPending}
                        onClick={() => confirmDelete(file)}
                      >
                        Delete
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {showSchedule && (
        <ScheduleModal
          moduleKey={MODULE_KEY}
          label={LABEL}
          sourceRoles={[REQUIRED_ROLE]}
          onClose={() => setShowSchedule(false)}
        />
      )}
      {showPreview && <DrugLicensesModal onClose={() => setShowPreview(false)} />}
    </div>
  );
}
