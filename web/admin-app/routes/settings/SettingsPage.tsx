// Settings tab — one form per settings group (admin_settings.py SETTINGS_SCHEMA).
//
// Replaces the old hand-written updateSaveState dirty tracking with controlled
// React forms: only changed fields are sent on save (so masked secrets left
// untouched are preserved by the backend). Conditional fields honour show_if;
// is_model fields get a "Fetch models" picker; groups with a test get a
// "Test connection" button.

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { qk } from "../../lib/queryKeys";
import { toast } from "../../components/toast";
import { PasskeysCard } from "./PasskeysCard";
import { LlmProfilesCard } from "./LlmProfilesCard";
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

  return (
    <div className="module-card">
      <div className="module-card__head">
        <div>
          <h3 className="subhead" style={{ margin: 0 }}>{group.label}</h3>
          <div className="muted small">{group.description}</div>
        </div>
        <div className="head-actions">
          {group.test && (
            <button type="button" className="btn" disabled={test.isPending} onClick={() => test.mutate()}>
              {test.isPending ? "Testing…" : "Test connection"}
            </button>
          )}
          {/* A read-only group has no Save: the server refuses the write anyway,
              and offering the button would promise something we cannot deliver. */}
          {!group.readonly && (
            <button
              type="button"
              className="btn"
              disabled={!dirty || save.isPending}
              onClick={() => save.mutate()}
            >
              {save.isPending ? "Saving…" : dirty ? "Save changes" : "Saved"}
            </button>
          )}
        </div>
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
        checked={Boolean(value)}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
    );
  }
  if (field.options) {
    return (
      <select
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
function BackupCard(): JSX.Element {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);

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
      const res = await api.post<{ imported: number; groups: string[]; skipped: string[] }>(
        "/admin/api/settings/import",
        doc,
      );
      await qc.invalidateQueries({ queryKey: qk.settings });
      await qc.invalidateQueries({ queryKey: qk.services });
      await qc.invalidateQueries({ queryKey: qk.overview });
      const skipped = res.skipped.length ? ` (${res.skipped.length} unknown key(s) skipped)` : "";
      toast.success(
        `Imported ${res.imported} setting(s) across ${res.groups.length} group(s)${skipped}`,
      );
    } catch (err) {
      toast.error(`Import failed: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="module-card">
      <div className="module-card__head">
        <div>
          <h3 className="subhead" style={{ margin: 0 }}>Backup &amp; restore</h3>
          <div className="muted small">
            Move a working configuration between installs. The exported file contains your API
            keys in plain text — keep it somewhere you would keep a password.
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
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = ""; // let the same file be picked again
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
  );
}

export function SettingsPage(): JSX.Element {
  const { data, isPending, isError, error } = useQuery({
    queryKey: qk.settings,
    queryFn: () => api.get<SettingsPayload>("/admin/api/settings"),
    staleTime: 30_000,
  });

  if (isPending) return <div className="muted">Loading settings…</div>;
  if (isError) return <div className="error-box">Failed to load settings: {String(error)}</div>;

  return (
    <section>
      <header className="section-head">
        <h2>Settings</h2>
      </header>
      <PasskeysCard />
      <BackupCard />
      {data.groups.map((group) => {
        const strategy = String(
          group.fields.find((f) => f.key === "strategy")?.value ?? "failover",
        );
        return (
          <div key={group.group}>
            <SettingsGroupForm group={group} />
            {/* The endpoints for these two roles are profiles, not fields. */}
            {(group.group === "analysis" || group.group === "embedding") && (
              <LlmProfilesCard kind={group.group} strategy={strategy} />
            )}
          </div>
        );
      })}
    </section>
  );
}
