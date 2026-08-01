// Settings tab — one form per settings group (admin_settings.py SETTINGS_SCHEMA).
//
// Replaces the old hand-written updateSaveState dirty tracking with controlled
// React forms: only changed fields are sent on save (so masked secrets left
// untouched are preserved by the backend). Conditional fields honour show_if;
// is_model fields get a "Fetch models" picker; groups with a test get a
// "Test connection" button.

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Navigate, NavLink, useLocation } from "react-router-dom";
import {
  Archive,
  Bot,
  BrainCircuit,
  Cloud,
  Database,
  Download,
  FileScan,
  Globe2,
  HardDrive,
  KeyRound,
  ServerCog,
  Beaker,
} from "lucide-react";
import { api } from "../../lib/api";
import { qk } from "../../lib/queryKeys";
import { toast } from "../../components/toast";
import { qkPasskeys } from "./PasskeysCard";
import { LlmProfilesCard } from "./LlmProfilesCard";
import { PrivacyPage } from "./PrivacyPage";
import { StatusBadge } from "../../components/StatusBadge";
import { OcrTestModal } from "./OcrTestModal";
import type {
  SettingsActionResult,
  SettingsField,
  SettingsGroup,
  SettingsPayload,
} from "../../lib/types";

type FormValue = string | number | boolean | null;
type FormState = Record<string, FormValue>;

// What the backend sends in place of a stored secret (admin_settings SECRET_MASK).
const SECRET_MASK = "●●●●●●●●";

/**
 * A secret never enters the form: the backend only ever tells us *whether* one
 * is stored, and an input pre-filled with mask characters would be sent back on
 * save as if the operator had typed it. Blank means "unchanged" end-to-end.
 */
function initialFrom(fields: SettingsField[]): FormState {
  return Object.fromEntries(fields.map((f) => [f.key, f.secret ? "" : f.value]));
}

function hasStoredSecret(field: SettingsField): boolean {
  return field.secret && field.value === SECRET_MASK;
}

/**
 * On a provider switch, carry the provider-specific fields (base URL, model)
 * over to the new provider's default — but only when the current value is blank
 * or is another provider's default, so a hand-typed endpoint is preserved.
 */
function applyProviderDefaults(
  fields: SettingsField[],
  form: FormState,
  nextProvider: string,
): FormState {
  const next = { ...form };
  for (const f of fields) {
    const defaults = f.provider_defaults;
    if (!defaults) continue;
    const wanted = defaults[nextProvider];
    if (wanted === undefined) continue;
    const current = String(form[f.key] ?? "");
    if (current === "" || Object.values(defaults).includes(current)) next[f.key] = wanted;
  }
  return next;
}

function isVisible(field: SettingsField, form: FormState): boolean {
  if (!field.show_if) return true;
  return Object.entries(field.show_if).every(([otherKey, allowed]) =>
    allowed.includes(String(form[otherKey] ?? "")),
  );
}

function coerce(type: SettingsField["type"], raw: FormValue): FormValue {
  if (type === "int") return raw === "" || raw == null ? 0 : parseInt(String(raw), 10);
  if (type === "float") return raw === "" || raw == null ? 0 : parseFloat(String(raw));
  if (type === "bool") return Boolean(raw);
  return raw;
}

function SettingsGroupForm({ group }: { group: SettingsGroup }): JSX.Element {
  const qc = useQueryClient();
  // Recomputed whenever the server payload ref changes (i.e. after a refetch).
  const incoming = useMemo(() => initialFrom(group.fields), [group.fields]);
  const [form, setForm] = useState<FormState>(incoming);
  const [snapshot, setSnapshot] = useState<FormState>(incoming);
  const [models, setModels] = useState<Record<string, string[]>>({});
  const [isOcrTestOpen, setIsOcrTestOpen] = useState(false);

  // Re-sync when fresh values arrive from the server (post-save refetch).
  useEffect(() => {
    setForm(incoming);
    setSnapshot(incoming);
  }, [incoming]);

  const changedKeys = group.fields
    .map((f) => f.key)
    .filter((k) => form[k] !== snapshot[k]);
  const dirty = changedKeys.length > 0;

  const save = useMutation({
    mutationFn: () => {
      const values: Record<string, FormValue> = {};
      for (const key of changedKeys) {
        const field = group.fields.find((f) => f.key === key)!;
        values[key] = coerce(field.type, form[key]);
      }
      return api.post<SettingsActionResult>(`/admin/api/settings/${group.group}`, { values });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.settings });
      // Settings changes may affect service health (embedding/minio/etc.).
      void qc.invalidateQueries({ queryKey: qk.services });
      void qc.invalidateQueries({ queryKey: qk.overview });
      toast.success(`${group.label} saved`);
    },
    onError: (err) => toast.error(String(err)),
  });

  const test = useMutation({
    mutationFn: () =>
      api.post<SettingsActionResult>(`/admin/api/settings/${group.group}/test`, { values: form }),
    onSuccess: (res) =>
      res.ok ? toast.success(res.message || "Connection OK") : toast.error(res.message || "Test failed"),
    onError: (err) => toast.error(String(err)),
  });

  const fetchModels = useMutation({
    mutationFn: (fieldKey: string) =>
      api
        .post<SettingsActionResult>(`/admin/api/settings/${group.group}/models`, { values: form })
        .then((res) => ({ fieldKey, res })),
    onSuccess: ({ fieldKey, res }) => {
      if (res.ok && res.models?.length) {
        setModels((m) => ({ ...m, [fieldKey]: res.models! }));
        toast.success(`Loaded ${res.models.length} models`);
      } else {
        toast.error(res.message || "No models returned");
      }
    },
    onError: (err) => toast.error(String(err)),
  });

  function setValue(key: string, value: FormValue): void {
    setForm((f) => {
      const next = { ...f, [key]: value };
      if (key === group.provider_field) {
        return applyProviderDefaults(group.fields, next, String(value ?? ""));
      }
      return next;
    });
  }

  const showFooter = group.group === "ocr" || Boolean(group.test) || !group.readonly;

  return (
    <div className="module-card">
      <div className="module-card__head">
        <div className="muted small">{group.description}</div>
      </div>

      {group.readonly && (
        <div className="muted small" style={{ marginBottom: "0.5rem" }}>
          Managed by the deployment — set these in <code>.env</code> / compose and restart the
          affected service. Shown here for reference and testing only.
        </div>
      )}

      <div className="settings-grid">
        {group.fields.filter((f) => isVisible(f, form)).map((field) => (
          <label className="settings-field" key={field.key}>
            <span className="settings-field__label">{field.label}</span>
            <FieldInput
              field={field}
              value={form[field.key]}
              models={models[field.key]}
              disabled={group.readonly}
              onChange={(v) => setValue(field.key, v)}
              onFetchModels={() => fetchModels.mutate(field.key)}
              fetchingModels={fetchModels.isPending}
            />
            {field.help && <span className="muted small">{field.help}</span>}
          </label>
        ))}
      </div>

      {showFooter && (
        <div className="module-card__foot">
          <div className="module-card__actions">
            {group.group === "ocr" && (
              <button
                type="button"
                className="btn"
                onClick={() => setIsOcrTestOpen(true)}
                title="Test OCR functionality with a file"
              >
                <Beaker size={16} style={{ marginRight: "6px" }} />
                Test OCR
              </button>
            )}
            {group.test && (
              <button type="button" className="btn" disabled={test.isPending} onClick={() => test.mutate()}>
                {test.isPending ? "Testing…" : "Test connection"}
              </button>
            )}
          </div>
          {/* A read-only group has no Save: the server refuses the write anyway,
              and offering the button would promise something we cannot deliver. */}
          {!group.readonly && (
            <button
              type="button"
              className="btn btn--primary"
              disabled={!dirty || save.isPending}
              onClick={() => save.mutate()}
            >
              {save.isPending ? "Saving…" : dirty ? "Save changes" : "Saved"}
            </button>
          )}
        </div>
      )}

      <OcrTestModal isOpen={isOcrTestOpen} onClose={() => setIsOcrTestOpen(false)} />
    </div>
  );
}

function FieldInput({
  field,
  value,
  models,
  onChange,
  onFetchModels,
  fetchingModels,
  disabled = false,
}: {
  field: SettingsField;
  value: FormValue;
  models: string[] | undefined;
  onChange: (v: FormValue) => void;
  onFetchModels: () => void;
  fetchingModels: boolean;
  disabled?: boolean;
}): JSX.Element {
  if (field.type === "bool") {
    return (
      <input
        type="checkbox"
        name={field.key}
        checked={Boolean(value)}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
    );
  }
  if (field.options) {
    return (
      <select
        name={field.key}
        value={String(value ?? "")}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        {field.options.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    );
  }

  const inputType = field.type === "int" || field.type === "float" ? "number" : "text";

  if (field.is_model) {
    const listId = `models-${field.key}`;
    return (
      <span className="field-with-action">
        <input
          type="text"
          name={field.key}
          list={listId}
          value={String(value ?? "")}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
        {models && (
          <datalist id={listId}>
            {models.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        )}
        <button type="button" className="btn btn--sm" disabled={fetchingModels} onClick={onFetchModels}>
          {fetchingModels ? "…" : "Fetch models"}
        </button>
      </span>
    );
  }

  if (field.secret) {
    return (
      <input
        type="password"
        name={field.key}
        autoComplete="new-password"
        value={value == null ? "" : String(value)}
        disabled={disabled}
        placeholder={hasStoredSecret(field) ? "Saved — leave blank to keep it" : "Not set"}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }

  return (
    <input
      type={inputType}
      name={field.key}
      value={value == null ? "" : String(value)}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/**
 * Export / import of the whole settings document. The exported file contains the
 * API keys in the clear — it exists to restore a working install verbatim — so
 * the card says so, and an import is confirmed before it overwrites anything.
 */
interface BackupItem {
  job_id: string;
  status: "queued" | "running" | "paused" | "stopped" | "success" | "retryable_failed" | "permanent_failed";
  progress_current: number;
  progress_total: number;
  current_step: string;
  selection: Record<string, boolean>;
  result: { filename?: string; archive_bytes?: number };
  created_at: string;
  finished_at: string;
  error: string;
}

function bytes(value: number | undefined): string {
  const size = Number(value || 0);
  if (size < 1024) return `${size} B`;
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 ** 3) return `${(size / 1024 ** 2).toFixed(1)} MB`;
  return `${(size / 1024 ** 3).toFixed(2)} GB`;
}

function BackupPage(): JSX.Element {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [selection, setSelection] = useState({ settings: true, database: true, object_storage: true });

  const backups = useQuery({
    queryKey: ["system-backups"],
    queryFn: () => api.get<{ backups: BackupItem[] }>("/admin/api/backups"),
    refetchInterval: (query) =>
      query.state.data?.backups.some((item) => item.status === "queued" || item.status === "running") ? 3_000 : false,
  });

  const createBackup = useMutation({
    mutationFn: () => api.post("/admin/api/jobs", {
      module_key: "admin",
      job_type: "system_backup",
      job_options: { selection },
    }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["system-backups"] });
      void qc.invalidateQueries({ queryKey: qk.jobs });
      toast.success("Backup job queued");
    },
    onError: (error) => toast.error(String(error)),
  });

  async function exportSettings(): Promise<void> {
    setBusy(true);
    try {
      const resp = await fetch("/admin/api/settings/export", { credentials: "same-origin" });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `tw-health-settings-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success("Settings exported");
    } catch (err) {
      toast.error(`Export failed: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  async function importSettings(file: File): Promise<void> {
    setBusy(true);
    try {
      const doc: unknown = JSON.parse(await file.text());
      const res = await api.post<{
        imported: number;
        groups: string[];
        profiles: number;
        passkeys: number;
        skipped: string[];
      }>("/admin/api/settings/import", doc);
      await qc.invalidateQueries({ queryKey: qk.settings });
      await qc.invalidateQueries({ queryKey: qk.services });
      await qc.invalidateQueries({ queryKey: qk.overview });
      await qc.invalidateQueries({ queryKey: qkPasskeys });

      // Passkeys dropped for an rp_id mismatch are the one thing the operator has
      // to actually read — the file looked like it restored their login and did
      // not. Say it on its own, rather than folding it into a count of "keys".
      const passkeyNote = res.skipped.find((s) => s.startsWith("passkeys ("));
      if (passkeyNote) toast.error(`Skipped ${passkeyNote}`);

      const unknown = res.skipped.filter((s) => s !== passkeyNote);
      const skipped = unknown.length ? ` (${unknown.length} unknown key(s) skipped)` : "";
      const restored = res.passkeys ? `, ${res.passkeys} passkey(s)` : "";
      toast.success(
        `Imported ${res.imported} setting(s) across ${res.groups.length} group(s)${restored}${skipped}`,
      );
    } catch (err) {
      toast.error(`Import failed: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  function downloadBackup(jobId: string): void {
    const anchor = document.createElement("a");
    anchor.href = `/admin/api/backups/${encodeURIComponent(jobId)}/download`;
    anchor.rel = "noopener";
    anchor.click();
  }

  return (
    <>
      <div className="module-card">
        <div className="module-card__head">
          <div>
            <h3 className="subhead" style={{ margin: 0 }}>System backup</h3>
            <div className="muted small">
              Create a portable ZIP in the background. Completed backups are stored in MinIO.
            </div>
          </div>
        </div>
        <div className="backup-options" role="group" aria-label="Backup contents">
          <BackupOption
            icon={<KeyRound size={20} />}
            title="Settings & credentials"
            description="Application settings, model profiles, FHIR servers, and passkeys. Secrets are included."
            checked={selection.settings}
            onChange={(checked) => setSelection((value) => ({ ...value, settings: checked }))}
          />
          <BackupOption
            icon={<Database size={20} />}
            title="PostgreSQL database"
            description="All loaded datasets, embeddings, pipeline state, schedules, and audit records."
            checked={selection.database}
            onChange={(checked) => setSelection((value) => ({ ...value, database: checked }))}
          />
          <BackupOption
            icon={<HardDrive size={20} />}
            title="Object storage"
            description="Uploaded source files, drug documents, OCR output, analysis JSON, and images."
            checked={selection.object_storage}
            onChange={(checked) => setSelection((value) => ({ ...value, object_storage: checked }))}
          />
        </div>
        <div className="backup-create-row">
          <span className="muted small">Backup artifacts contain sensitive data. Store downloads securely.</span>
          <button
            type="button"
            className="btn"
            disabled={createBackup.isPending || !Object.values(selection).some(Boolean)}
            onClick={() => createBackup.mutate()}
          >
            <Archive size={16} />
            {createBackup.isPending ? "Queueing…" : "Create backup"}
          </button>
        </div>
      </div>

      <div className="module-card">
        <div className="module-card__head">
          <div>
            <h3 className="subhead" style={{ margin: 0 }}>Backup history</h3>
            <div className="muted small">The worker reports progress here and on the Tasks page.</div>
          </div>
        </div>
        {backups.isPending ? (
          <div className="muted small">Loading backups…</div>
        ) : backups.isError ? (
          <div className="error-box">Failed to load backups: {String(backups.error)}</div>
        ) : backups.data.backups.length === 0 ? (
          <div className="muted small">No system backups have been created.</div>
        ) : (
          <div className="backup-list">
            {backups.data.backups.map((item) => {
              const progress = item.progress_total > 0
                ? Math.round((item.progress_current / item.progress_total) * 100)
                : 0;
              return (
                <div className="backup-row" key={item.job_id}>
                  <div className="backup-row__main">
                    <div className="backup-row__title">
                      <span>{item.result.filename || `Backup ${item.job_id.slice(0, 8)}`}</span>
                      <StatusBadge status={item.status} />
                    </div>
                    <div className="muted small backup-row__meta">
                      <span>{new Date(item.created_at).toLocaleString()}</span>
                      {item.result.archive_bytes ? <span>{bytes(item.result.archive_bytes)}</span> : null}
                      <span>{Object.entries(item.selection).filter(([, included]) => included).map(([key]) => key.replace("_", " ")).join(" · ")}</span>
                    </div>
                    {(item.status === "queued" || item.status === "running") && (
                      <div className="backup-progress">
                        <div><span style={{ width: `${progress}%` }} /></div>
                        <span>{progress}%</span>
                      </div>
                    )}
                    {item.error && <div className="field-error small">{item.error}</div>}
                  </div>
                  <button
                    type="button"
                    className="icon-btn"
                    title="Download backup"
                    aria-label="Download backup"
                    disabled={item.status !== "success"}
                    onClick={() => downloadBackup(item.job_id)}
                  >
                    <Download size={17} />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="module-card">
        <div className="module-card__head">
          <div>
            <h3 className="subhead" style={{ margin: 0 }}>Settings file</h3>
            <div className="muted small">
              Export or restore settings only. The JSON contains API keys in plain text.
            </div>
          </div>
          <div className="head-actions">
            <button type="button" className="btn" disabled={busy} onClick={() => void exportSettings()}>
              Export settings
            </button>
            <label className="btn" style={{ cursor: busy ? "default" : "pointer" }}>
              Import settings
              <input
                type="file"
                accept="application/json,.json"
                style={{ display: "none" }}
                disabled={busy}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (!file) return;
                  const ok = window.confirm(
                    "Import settings from this file? Values for the groups it contains will be overwritten.",
                  );
                  if (ok) void importSettings(file);
                }}
              />
            </label>
          </div>
        </div>
      </div>
    </>
  );
}

function BackupOption(props: {
  icon: JSX.Element;
  title: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}): JSX.Element {
  return (
    <label className={`backup-option ${props.checked ? "backup-option--selected" : ""}`}>
      <input type="checkbox" checked={props.checked} onChange={(event) => props.onChange(event.target.checked)} />
      <span className="backup-option__icon">{props.icon}</span>
      <span>
        <strong>{props.title}</strong>
        <span className="muted small">{props.description}</span>
      </span>
    </label>
  );
}

export function SettingsPage(): JSX.Element {
  const location = useLocation();
  const section = location.pathname.split("/").filter(Boolean)[1] ?? "";
  const { data, isPending, isError, error } = useQuery({
    queryKey: qk.settings,
    queryFn: () => api.get<SettingsPayload>("/admin/api/settings"),
    staleTime: 30_000,
  });

  if (isPending) return <div className="muted">Loading settings…</div>;
  if (isError) return <div className="error-box">Failed to load settings: {String(error)}</div>;

  const navigation = [
    { key: "embedding", label: "Embedding", icon: BrainCircuit },
    { key: "analysis", label: "Analysis LM", icon: Bot },
    { key: "ocr", label: "OCR", icon: FileScan },
    { key: "tfda", label: "TFDA crawler", icon: Globe2 },
    { key: "registry", label: "FHIR registry", icon: Cloud },
    { key: "minio", label: "Object storage", icon: HardDrive },
    { key: "worker", label: "Worker", icon: ServerCog },
    { key: "privacy", label: "Privacy", icon: KeyRound },
    { key: "backup", label: "Backup & restore", icon: Archive },
  ] as const;
  if (!section) return <Navigate to="/settings/embedding" replace />;
  if (!navigation.some((item) => item.key === section)) return <Navigate to="/settings/embedding" replace />;

  const selectedNavigation = navigation.find((item) => item.key === section)!;
  const SelectedIcon = selectedNavigation.icon;
  const group = data.groups.find((item) => item.group === section);
  const strategy = String(group?.fields.find((field) => field.key === "strategy")?.value ?? "failover");

  return (
    <section>
      <header className="section-head">
        <h2>Settings</h2>
      </header>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings categories">
          {navigation.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.key}
                to={`/settings/${item.key}`}
                className={({ isActive }) => `settings-nav__item ${isActive ? "settings-nav__item--active" : ""}`}
              >
                <Icon size={17} />
                <span>{item.label}</span>
              </NavLink>
            );
          })}
        </nav>
        <div className="settings-content">
          <div className="settings-content__head">
            <SelectedIcon size={22} />
            <h3>{selectedNavigation.label}</h3>
          </div>
          {section === "privacy" ? (
            <PrivacyPage />
          ) : section === "backup" ? (
            <BackupPage />
          ) : group ? (
            <>
              <SettingsGroupForm group={group} />
              {(group.group === "analysis" || group.group === "embedding") && (
                <LlmProfilesCard kind={group.group} strategy={strategy} />
              )}
            </>
          ) : (
            <div className="error-box">This settings group is not available.</div>
          )}
        </div>
      </div>
    </section>
  );
}
