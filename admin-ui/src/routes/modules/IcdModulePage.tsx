// ICD-10 module page — a deliberately different model from the generic
// ModulePage (no versions / no active-deactivate / no schedule). ICD follows a
// strict state machine driven by record count + maintenance mode:
//
//   EMPTY (0 rows)              → upload all three required files, then Import.
//   POPULATED + maintain OFF    → read-only; Embed + Preview only.
//   POPULATED + maintain ON     → Clear-all (wipes data AND uploaded files,
//                                 returning to EMPTY) + Embed + Preview.
//
// While maintenance is ON the ICD MCP tools return a "maintenance" response and
// the Overview shows the service as "maintaining" (enforced server-side).
// Embed is always available once data exists. Clearing deletes the uploaded
// source files too, so re-importing means re-uploading first.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { qk } from "../../lib/queryKeys";
import { formatRelative } from "../../lib/time";
import { useActiveJobTypes } from "../../lib/jobs";
import { toast } from "../../components/toast";
import { VerboseToggle } from "../../components/VerboseToggle";
import { StatusBadge } from "../../components/StatusBadge";
import { EmbeddingStatus, EmbedButton } from "./EmbeddingStatus";
import { UploadField, useUploadTracker } from "./UploadField";
import { IcdPreviewModal } from "./IcdPreviewModal";
import type { CatalogEntry, ModulesPayload, UploadedFile } from "../../lib/types";

const MODULE_KEY = "icd";
const LABEL = "ICD-10";
const IMPORT_JOB = "icd_import";
const EMBED_JOB = "icd_embed";
// Catalog source roles, in the order the backend requires them.
const REQUIRED_ROLES = ["icd10cm", "icd10pcs", "icd_zh_tw"] as const;

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function IcdModulePage(): JSX.Element {
  const qc = useQueryClient();
  const activeJobTypes = useActiveJobTypes();
  // Must be called before the loading/error early-returns below (Rules of Hooks).
  const { uploading, onUploadingChange } = useUploadTracker();
  const [showPreview, setShowPreview] = useState(
    () => new URLSearchParams(window.location.search).get("icd_preview") === "1",
  );

  const modulesQ = useQuery({
    queryKey: qk.modules,
    queryFn: () => api.get<ModulesPayload>("/admin/api/modules"),
    staleTime: 15_000,
  });

  function refresh() {
    void qc.invalidateQueries({ queryKey: qk.modules });
    void qc.invalidateQueries({ queryKey: qk.overview });
  }

  const [verbose, setVerbose] = useState(false);
  const triggerJob = useMutation({
    mutationFn: (jobType: string) =>
      api.post("/admin/api/jobs", {
        job_type: jobType,
        module_key: MODULE_KEY,
        job_options: { source: "admin-console", ...(verbose ? { log_verbose: true } : {}) },
      }),
    onSuccess: (_d, jobType) => {
      void qc.invalidateQueries({ queryKey: qk.jobs });
      toast.success(`Started ${jobType}`);
    },
    onError: (err) => toast.error(`Failed to start job: ${String(err)}`),
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
      toast.success("ICD data and uploaded files cleared");
    },
    onError: (err) => toast.error(String(err)),
  });

  const deleteUpload = useMutation({
    mutationFn: (uploadedFileId: string) =>
      api.post("/admin/api/module-sources/delete", { uploaded_file_id: uploadedFileId }),
    onSuccess: () => {
      refresh();
      toast.success("Uploaded ICD file deleted");
    },
    onError: (err) => toast.error(String(err)),
  });

  if (modulesQ.isPending) return <div className="muted">Loading…</div>;
  if (modulesQ.isError) return <div className="error-box">Failed to load: {String(modulesQ.error)}</div>;

  const data = modulesQ.data;
  const entries: CatalogEntry[] = data.modules.filter((e) => e.module_key === MODULE_KEY);
  const byRole = new Map(entries.map((e) => [e.source_role, e]));
  const storage = data.storage;
  const maintenance = data.maintenance?.[MODULE_KEY] ?? false;
  const recordCount = data.record_counts?.[MODULE_KEY] ?? 0;
  const populated = recordCount > 0;

  const importing = activeJobTypes.has(IMPORT_JOB);
  const embedding = activeJobTypes.has(EMBED_JOB);
  const busy = importing || embedding || toggleMaintenance.isPending || clearAll.isPending;

  // EMPTY-state gating: every required role must have at least one uploaded file.
  const uploadedByRole = (role: string): UploadedFile | undefined =>
    byRole.get(role)?.recent_uploads[0];
  const allUploaded = REQUIRED_ROLES.every((r) => !!uploadedByRole(r));
  const lastImported = entries.find((e) => e.last_imported_at)?.last_imported_at ?? "";

  function confirmClear() {
    if (
      window.confirm(
        "Clear ALL ICD data?\n\nThis deletes every imported diagnosis/procedure AND removes the uploaded source files. You will need to re-upload all three files to import again. This cannot be undone.",
      )
    ) {
      clearAll.mutate();
    }
  }

  function confirmDelete(file: UploadedFile) {
    if (
      window.confirm(
        `Delete uploaded file "${file.original_filename}"?\n\nThis only removes the pending upload. You can upload a replacement before importing.`,
      )
    ) {
      deleteUpload.mutate(file.uploaded_file_id);
    }
  }

  return (
    <div>
      <div className="module-card__head">
        <div>
          <h3 className="subhead" style={{ margin: 0 }}>{LABEL}</h3>
          <div className="muted small">
            {populated
              ? `${recordCount.toLocaleString()} records · last imported ${formatRelative(lastImported)}`
              : "No data imported yet"}
          </div>
        </div>
        <div className="head-actions">
          <VerboseToggle value={verbose} onChange={setVerbose} />
          <label className="switch" title="Maintenance mode pauses the ICD MCP tools and unlocks destructive actions">
            <input
              type="checkbox"
              checked={maintenance}
              disabled={toggleMaintenance.isPending}
              onChange={(e) => toggleMaintenance.mutate(e.target.checked)}
            />
            <span className="switch__track" aria-hidden="true" />
            <span className="switch__label">Maintenance</span>
          </label>
          <EmbedButton
            moduleKey="icd"
            populated={populated}
            busy={embedding}
            onEmbed={() => triggerJob.mutate(EMBED_JOB)}
          />
          <button
            type="button"
            className="btn"
            disabled={!populated}
            title={!populated ? "Import data first" : ""}
            onClick={() => setShowPreview(true)}
          >
            Preview data
          </button>
        </div>
      </div>

      {maintenance && (
        <div className="banner banner--warn">
          <strong>Maintenance mode is ON.</strong> ICD MCP tools and the FHIR
          Condition tool return a “service under maintenance” response, and the
          Overview shows ICD as <em>maintaining</em>. Turn this off when you are
          done modifying the module.
        </div>
      )}

      <div className="summary-row">
        <StatusBadge status={storage.minio_enabled ? "ready" : "unavailable"} />
        <span className="muted small">
          Object storage: {storage.detail}
          {storage.bucket ? ` (${storage.bucket})` : ""}
        </span>
      </div>

      <EmbeddingStatus moduleKey="icd" />

      {/* ── EMPTY: upload the three required files, then import ── */}
      {!populated && (
        <div className="module-card">
          <div className="source-role__head" style={{ borderTop: "none", marginBottom: 12 }}>
            <div>
              <strong>Source files</strong>
              <div className="muted small">All three files are required before importing.</div>
            </div>
            <button
              type="button"
              className="btn"
              disabled={!allUploaded || importing || uploading}
              title={
                uploading
                  ? "Wait for uploads to finish"
                  : allUploaded
                    ? ""
                    : "Upload all three files first"
              }
              onClick={() => triggerJob.mutate(IMPORT_JOB)}
            >
              {importing ? "Importing…" : "Import now"}
            </button>
          </div>

          <div className="service-list">
            {REQUIRED_ROLES.map((role) => {
              const entry = byRole.get(role);
              const file = uploadedByRole(role);
              return (
                <div className="row row--service" key={role}>
                  <div className="row__main">
                    <div className="row__name">
                      {entry?.label ?? role}{" "}
                      {file ? (
                        <span className="badge badge--ok">uploaded</span>
                      ) : (
                        <span className="badge badge--bad">required</span>
                      )}
                    </div>
                    <div className="muted small">
                      {file
                        ? `${file.original_filename} · ${formatBytes(file.size_bytes)} · ${formatRelative(file.uploaded_at)}`
                        : entry?.description ?? ""}
                    </div>
                  </div>
                  <div className="row__meta">
                    {entry && !file && (
                      <UploadField
                        moduleKey={MODULE_KEY}
                        sourceRole={role}
                        acceptedExtensions={entry.accepted_extensions}
                        autoActivate={false}
                        maxUploadMb={data.upload_limits.max_upload_mb}
                        onUploaded={refresh}
                        onUploadingChange={onUploadingChange}
                      />
                    )}
                    {file && (
                      <button
                        type="button"
                        className="btn btn--sm"
                        disabled={deleteUpload.isPending || importing}
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
        </div>
      )}

      {/* ── POPULATED: locked unless maintaining ── */}
      {populated && !maintenance && (
        <div className="module-card">
          <div className="muted">
            ICD is loaded and serving. To modify it, enable <strong>Maintenance</strong>{" "}
            mode — that pauses the ICD tools and lets you clear &amp; re-import.
          </div>
        </div>
      )}

      {populated && maintenance && (
        <div className="module-card">
          <div className="source-role__head" style={{ borderTop: "none" }}>
            <div>
              <strong>Clear &amp; start over</strong>
              <div className="muted small">
                Wipes all imported data and the uploaded source files. ICD returns to
                its initial empty state; re-import requires uploading all three files
                again.
              </div>
            </div>
            <button
              type="button"
              className="btn btn--danger"
              disabled={busy}
              onClick={confirmClear}
            >
              {clearAll.isPending ? "Clearing…" : "Clear all ICD data"}
            </button>
          </div>
        </div>
      )}

      {showPreview && <IcdPreviewModal onClose={() => setShowPreview(false)} />}
    </div>
  );
}
