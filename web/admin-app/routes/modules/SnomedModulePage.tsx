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
import { SnomedPreviewModal } from "./SnomedPreviewModal";
import type { CatalogEntry, ModulesPayload, UploadedFile } from "../../lib/types";

const MODULE_KEY = "snomed";
const LABEL = "SNOMED CT";
const IMPORT_JOB = "snomed_import";
const EMBED_JOB = "snomed_embed";
const REQUIRED_ROLE = "snomed_ct";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function SnomedModulePage(): JSX.Element {
  const qc = useQueryClient();
  const activeJobTypes = useActiveJobTypes();
  // Must be called before the loading/error early-returns below (Rules of Hooks).
  const { uploading, onUploadingChange } = useUploadTracker();
  const [showPreview, setShowPreview] = useState(
    () => new URLSearchParams(window.location.search).get("snomed_preview") === "1",
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
      toast.success("SNOMED CT data and uploaded files cleared");
    },
    onError: (err) => toast.error(String(err)),
  });

  const deleteUpload = useMutation({
    mutationFn: (uploadedFileId: string) =>
      api.post("/admin/api/module-sources/delete", { uploaded_file_id: uploadedFileId }),
    onSuccess: () => {
      refresh();
      toast.success("Uploaded SNOMED CT file deleted");
    },
    onError: (err) => toast.error(String(err)),
  });

  if (modulesQ.isPending) return <div className="muted">Loading...</div>;
  if (modulesQ.isError) return <div className="error-box">Failed to load: {String(modulesQ.error)}</div>;

  const data = modulesQ.data;
  const entries: CatalogEntry[] = data.modules.filter((e) => e.module_key === MODULE_KEY);
  const entry = entries.find((e) => e.source_role === REQUIRED_ROLE);
  const file: UploadedFile | undefined = entry?.recent_uploads[0];
  const storage = data.storage;
  const maintenance = data.maintenance?.[MODULE_KEY] ?? false;
  const recordCount = data.record_counts?.[MODULE_KEY] ?? 0;
  const populated = recordCount > 0;
  const importing = activeJobTypes.has(IMPORT_JOB);
  const embedding = activeJobTypes.has(EMBED_JOB);
  const busy = importing || embedding || toggleMaintenance.isPending || clearAll.isPending;
  const lastImported = entry?.last_imported_at ?? "";

  function confirmClear() {
    if (
      window.confirm(
        "Clear ALL SNOMED CT data?\n\nThis deletes imported concepts, descriptions, relationships, ICD maps, embeddings, and uploaded source files. You will need to re-upload the RF2 ZIP to import again. This cannot be undone.",
      )
    ) {
      clearAll.mutate();
    }
  }

  function confirmDelete(upload: UploadedFile) {
    if (
      window.confirm(
        `Delete uploaded file "${upload.original_filename}"?\n\nThis only removes the pending upload. You can upload a replacement before importing.`,
      )
    ) {
      deleteUpload.mutate(upload.uploaded_file_id);
    }
  }

  return (
    <div>
      <div className="module-card__head">
        <div>
          <h3 className="subhead" style={{ margin: 0 }}>{LABEL}</h3>
          <div className="muted small">
            {populated
              ? `${recordCount.toLocaleString()} concepts · last imported ${formatRelative(lastImported)}`
              : "No data imported yet"}
          </div>
        </div>
        <div className="head-actions">
          <VerboseToggle value={verbose} onChange={setVerbose} />
          <label className="switch" title="Maintenance mode pauses SNOMED CT tools and unlocks destructive actions">
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
            moduleKey="snomed"
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
          <strong>Maintenance mode is ON.</strong> SNOMED CT MCP tools return a
          service-under-maintenance response, and the Overview shows SNOMED as
          <em> maintaining</em>. Turn this off when you are done modifying the module.
        </div>
      )}

      <div className="summary-row">
        <StatusBadge status={storage.minio_enabled ? "ready" : "unavailable"} />
        <span className="muted small">
          Object storage: {storage.detail}
          {storage.bucket ? ` (${storage.bucket})` : ""}
        </span>
      </div>

      <EmbeddingStatus moduleKey="snomed" />

      {!populated && (
        <div className="module-card">
          <div className="source-role__head" style={{ borderTop: "none", marginBottom: 12 }}>
            <div>
              <strong>Source file</strong>
              <div className="muted small">SNOMED CT International RF2 ZIP is required before importing.</div>
            </div>
            <button
              type="button"
              className="btn"
              disabled={!file || importing || uploading}
              title={
                uploading
                  ? "Wait for uploads to finish"
                  : file
                    ? ""
                    : "Upload the RF2 ZIP first"
              }
              onClick={() => triggerJob.mutate(IMPORT_JOB)}
            >
              {importing ? "Importing..." : "Import now"}
            </button>
          </div>

          <div className="service-list">
            <div className="row row--service">
              <div className="row__main">
                <div className="row__name">
                  {entry?.label ?? REQUIRED_ROLE}{" "}
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
                    sourceRole={REQUIRED_ROLE}
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
          </div>
        </div>
      )}

      {populated && !maintenance && (
        <div className="module-card">
          <div className="muted">
            SNOMED CT is loaded and serving. To modify it, enable <strong>Maintenance</strong>{" "}
            mode. That pauses the SNOMED CT tools and lets you clear &amp; re-import.
          </div>
        </div>
      )}

      {populated && maintenance && (
        <div className="module-card">
          <div className="source-role__head" style={{ borderTop: "none" }}>
            <div>
              <strong>Clear &amp; start over</strong>
              <div className="muted small">
                Wipes concepts, descriptions, relationships, ICD maps, embeddings, and uploaded source files.
              </div>
            </div>
            <button
              type="button"
              className="btn btn--danger"
              disabled={busy}
              onClick={confirmClear}
            >
              {clearAll.isPending ? "Clearing..." : "Clear all SNOMED CT data"}
            </button>
          </div>
        </div>
      )}

      {showPreview && (
        <SnomedPreviewModal onClose={() => setShowPreview(false)} />
      )}
    </div>
  );
}
