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
import type {
  SettingsActionResult,
  SettingsField,
  SettingsGroup,
  SettingsPayload,
} from "../../lib/types";

type FormValue = string | number | boolean | null;
type FormState = Record<string, FormValue>;

function initialFrom(fields: SettingsField[]): FormState {
  return Object.fromEntries(fields.map((f) => [f.key, f.value]));
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
    setForm((f) => ({ ...f, [key]: value }));
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
          <button
            type="button"
            className="btn"
            disabled={!dirty || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Saving…" : dirty ? "Save changes" : "Saved"}
          </button>
        </div>
      </div>

      <div className="settings-grid">
        {group.fields.filter((f) => isVisible(f, form)).map((field) => (
          <label className="settings-field" key={field.key}>
            <span className="settings-field__label">{field.label}</span>
            <FieldInput
              field={field}
              value={form[field.key]}
              models={models[field.key]}
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
}: {
  field: SettingsField;
  value: FormValue;
  models: string[] | undefined;
  onChange: (v: FormValue) => void;
  onFetchModels: () => void;
  fetchingModels: boolean;
}): JSX.Element {
  if (field.type === "bool") {
    return (
      <input
        type="checkbox"
        checked={Boolean(value)}
        onChange={(e) => onChange(e.target.checked)}
      />
    );
  }
  if (field.options) {
    return (
      <select value={String(value ?? "")} onChange={(e) => onChange(e.target.value)}>
        {field.options.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    );
  }

  const inputType = field.secret ? "password" : field.type === "int" || field.type === "float" ? "number" : "text";

  if (field.is_model) {
    const listId = `models-${field.key}`;
    return (
      <span className="field-with-action">
        <input
          type="text"
          list={listId}
          value={String(value ?? "")}
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

  return (
    <input
      type={inputType}
      value={value == null ? "" : String(value)}
      onChange={(e) => onChange(e.target.value)}
    />
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
      {data.groups.map((group) => (
        <SettingsGroupForm key={group.group} group={group} />
      ))}
    </section>
  );
}
