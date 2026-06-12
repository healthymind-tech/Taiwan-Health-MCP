// Automated import/sync schedule for a module.
//
// URL-fetch modules (icd/ig/drug) require an HTTPS fetch_url + source_role;
// API-sync modules (health_supplements/food_nutrition) just need a cadence. Backed by
// GET/POST/DELETE /schedule and POST /schedule/trigger.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { qk } from "../../lib/queryKeys";
import { formatRelative } from "../../lib/time";
import { URL_FETCH_MODULES, WEEKDAYS } from "../../lib/adminSets";
import { Modal } from "../../components/Modal";
import { toast } from "../../components/toast";
import type { Schedule } from "../../lib/types";

type Frequency = "daily" | "weekly" | "monthly";

interface FormState {
  frequency: Frequency;
  hour_utc: number;
  minute_utc: number;
  day_of_week: number;
  day_of_month: number;
  fetch_url: string;
  source_role: string;
  is_enabled: boolean;
}

const DEFAULTS: FormState = {
  frequency: "weekly",
  hour_utc: 2,
  minute_utc: 0,
  day_of_week: 0,
  day_of_month: 1,
  fetch_url: "",
  source_role: "",
  is_enabled: true,
};

export function ScheduleModal({
  moduleKey,
  label,
  sourceRoles,
  onClose,
}: {
  moduleKey: string;
  label: string;
  sourceRoles: string[];
  onClose: () => void;
}): JSX.Element {
  const qc = useQueryClient();
  const needsUrl = URL_FETCH_MODULES.has(moduleKey);
  const [form, setForm] = useState<FormState>(DEFAULTS);

  const { data, isPending } = useQuery({
    queryKey: qk.moduleSchedule(moduleKey),
    queryFn: () => api.get<{ schedule: Schedule | null }>(`/admin/api/modules/${moduleKey}/schedule`),
  });
  const existing = data?.schedule ?? null;

  useEffect(() => {
    if (existing) {
      setForm({
        frequency: existing.frequency,
        hour_utc: existing.hour_utc,
        minute_utc: existing.minute_utc,
        day_of_week: existing.day_of_week ?? 0,
        day_of_month: existing.day_of_month ?? 1,
        fetch_url: existing.fetch_url ?? "",
        source_role: existing.source_role ?? sourceRoles[0] ?? "",
        is_enabled: existing.is_enabled,
      });
    } else {
      setForm({ ...DEFAULTS, source_role: sourceRoles[0] ?? "" });
    }
  }, [existing, sourceRoles]);

  function invalidate() {
    void qc.invalidateQueries({ queryKey: qk.moduleSchedule(moduleKey) });
  }

  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {
        frequency: form.frequency,
        hour_utc: form.hour_utc,
        minute_utc: form.minute_utc,
        is_enabled: form.is_enabled,
      };
      if (form.frequency === "weekly") body.day_of_week = form.day_of_week;
      if (form.frequency === "monthly") body.day_of_month = form.day_of_month;
      if (needsUrl) {
        body.fetch_url = form.fetch_url;
        body.source_role = form.source_role;
      }
      return api.post(`/admin/api/modules/${moduleKey}/schedule`, body);
    },
    onSuccess: () => {
      invalidate();
      toast.success("Schedule saved");
    },
    onError: (err) => toast.error(String(err)),
  });

  const remove = useMutation({
    mutationFn: () => api.del(`/admin/api/modules/${moduleKey}/schedule`),
    onSuccess: () => {
      invalidate();
      toast.success("Schedule removed");
    },
    onError: (err) => toast.error(String(err)),
  });

  const trigger = useMutation({
    mutationFn: () => api.post(`/admin/api/modules/${moduleKey}/schedule/trigger`, {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.jobs });
      toast.success("Triggered now");
    },
    onError: (err) => toast.error(String(err)),
  });

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  return (
    <Modal title={`${label} — schedule`} onClose={onClose}>
      {isPending ? (
        <div className="muted">Loading schedule…</div>
      ) : (
        <>
          {existing && (
            <div className="muted small" style={{ marginBottom: 12 }}>
              Last run {formatRelative(existing.last_run_at)} ({existing.last_run_status || "n/a"}) · next{" "}
              {existing.next_run_at ? formatRelative(existing.next_run_at) : "—"}
              {existing.last_error ? ` · ${existing.last_error}` : ""}
            </div>
          )}

          <div className="settings-grid">
            <label className="settings-field">
              <span className="settings-field__label">Frequency</span>
              <select value={form.frequency} onChange={(e) => set("frequency", e.target.value as Frequency)}>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
              </select>
            </label>

            {form.frequency === "weekly" && (
              <label className="settings-field">
                <span className="settings-field__label">Day of week</span>
                <select value={form.day_of_week} onChange={(e) => set("day_of_week", Number(e.target.value))}>
                  {WEEKDAYS.map((d, i) => (
                    <option key={d} value={i}>
                      {d}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {form.frequency === "monthly" && (
              <label className="settings-field">
                <span className="settings-field__label">Day of month (1–28)</span>
                <input
                  type="number"
                  min={1}
                  max={28}
                  value={form.day_of_month}
                  onChange={(e) => set("day_of_month", Number(e.target.value))}
                />
              </label>
            )}

            <label className="settings-field">
              <span className="settings-field__label">Hour (UTC)</span>
              <input type="number" min={0} max={23} value={form.hour_utc} onChange={(e) => set("hour_utc", Number(e.target.value))} />
            </label>
            <label className="settings-field">
              <span className="settings-field__label">Minute (UTC)</span>
              <input type="number" min={0} max={59} value={form.minute_utc} onChange={(e) => set("minute_utc", Number(e.target.value))} />
            </label>

            {needsUrl && (
              <>
                <label className="settings-field">
                  <span className="settings-field__label">Source role</span>
                  <select value={form.source_role} onChange={(e) => set("source_role", e.target.value)}>
                    {sourceRoles.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="settings-field" style={{ gridColumn: "1 / -1" }}>
                  <span className="settings-field__label">Fetch URL (HTTPS)</span>
                  <input type="text" placeholder="https://…" value={form.fetch_url} onChange={(e) => set("fetch_url", e.target.value)} />
                </label>
              </>
            )}

            <label className="settings-field">
              <span className="settings-field__label">Enabled</span>
              <input type="checkbox" checked={form.is_enabled} onChange={(e) => set("is_enabled", e.target.checked)} />
            </label>
          </div>

          <div className="head-actions" style={{ marginTop: 18, justifyContent: "flex-end" }}>
            {existing && (
              <button type="button" className="btn" disabled={trigger.isPending} onClick={() => trigger.mutate()}>
                {trigger.isPending ? "…" : "Run now"}
              </button>
            )}
            {existing && (
              <button type="button" className="btn" disabled={remove.isPending} onClick={() => remove.mutate()}>
                {remove.isPending ? "…" : "Delete"}
              </button>
            )}
            <button type="button" className="btn" disabled={save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? "Saving…" : "Save schedule"}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
