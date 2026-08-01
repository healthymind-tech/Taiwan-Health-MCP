// LLM profiles for one role (Analysis LM / Embedding): several endpoints, each
// enable-able, ordered by priority for failover and weighted for load balancing.
//
// The API never returns a stored API key — only `has_api_key` — so the key input
// is always blank and an empty value on save means "keep the stored one".

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { qk } from "../../lib/queryKeys";
import { toast } from "../../components/toast";
import type { LlmProfile, LlmProfileKind } from "../../lib/types";

const PROVIDERS: Record<LlmProfileKind, string[]> = {
  analysis: ["openai", "ollama"],
  embedding: ["ollama", "openai", "google"],
};

const BASE_URL_DEFAULTS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  ollama: "http://host.docker.internal:11434",
  google: "https://generativelanguage.googleapis.com",
};

interface DraftProfile {
  id?: number;
  kind: LlmProfileKind;
  name: string;
  provider: string;
  base_url: string;
  api_key: string;
  model: string;
  enabled: boolean;
  priority: number;
  weight: number;
  dimensions: number;
  temperature: number;
  max_tokens: number;
}

function emptyDraft(kind: LlmProfileKind): DraftProfile {
  const provider = PROVIDERS[kind][0];
  return {
    kind,
    name: "",
    provider,
    base_url: BASE_URL_DEFAULTS[provider] ?? "",
    api_key: "",
    model: "",
    enabled: true,
    priority: 100,
    weight: 1,
    dimensions: 1024,
    temperature: 0.1,
    max_tokens: DEFAULT_MAX_TOKENS,
  };
}

// Reasoning models (gpt-5 / o-series) bill their hidden reasoning against the same
// budget as the answer, so a budget sized for the answer alone gets spent thinking
// and the reply comes back empty. Mirrors llm_profiles.is_reasoning_model.
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_REASONING_MAX_TOKENS = 16384;

function isReasoningModel(model: string): boolean {
  const m = (model ?? "").trim().toLowerCase();
  return ["gpt-5", "o1", "o3", "o4"].some((p) => m.startsWith(p));
}

function defaultMaxTokens(model: string): number {
  return isReasoningModel(model) ? DEFAULT_REASONING_MAX_TOKENS : DEFAULT_MAX_TOKENS;
}

function toDraft(p: LlmProfile): DraftProfile {
  return {
    id: p.id,
    kind: p.kind,
    name: p.name,
    provider: p.provider,
    base_url: p.base_url,
    api_key: "", // never populated: the server does not send it
    model: p.model,
    enabled: p.enabled,
    priority: p.priority,
    weight: p.weight,
    dimensions: Number(p.params?.dimensions ?? 1024),
    temperature: Number(p.params?.temperature ?? 0.1),
    max_tokens: Number(p.params?.max_tokens ?? defaultMaxTokens(p.model)),
  };
}

/** A blank key is omitted, not sent — the server keeps the stored one. */
function toPayload(d: DraftProfile): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    kind: d.kind,
    name: d.name,
    provider: d.provider,
    base_url: d.base_url,
    model: d.model,
    enabled: d.enabled,
    priority: d.priority,
    weight: d.weight,
    params:
      d.kind === "analysis"
        ? { temperature: d.temperature, max_tokens: d.max_tokens }
        : { dimensions: d.dimensions },
  };
  if (d.api_key.trim()) payload.api_key = d.api_key.trim();
  return payload;
}

export function LlmProfilesCard({
  kind,
  strategy,
}: {
  kind: LlmProfileKind;
  strategy: string;
}): JSX.Element {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<DraftProfile | null>(null);
  const [models, setModels] = useState<string[]>([]);

  const { data, isPending } = useQuery({
    queryKey: qk.llmProfiles(kind),
    queryFn: () => api.get<{ profiles: LlmProfile[] }>(`/admin/api/llm-profiles?kind=${kind}`),
  });

  function refresh(): void {
    void qc.invalidateQueries({ queryKey: qk.llmProfiles(kind) });
    void qc.invalidateQueries({ queryKey: qk.services });
    void qc.invalidateQueries({ queryKey: qk.overview });
  }

  const save = useMutation({
    mutationFn: (d: DraftProfile) =>
      d.id
        ? api.patch<{ profile: LlmProfile }>(`/admin/api/llm-profiles/${d.id}`, toPayload(d))
        : api.post<{ profile: LlmProfile }>("/admin/api/llm-profiles", toPayload(d)),
    onSuccess: () => {
      setEditing(null);
      refresh();
      toast.success("Profile saved");
    },
    onError: (err) => toast.error(String(err)),
  });

  const toggle = useMutation({
    mutationFn: (p: LlmProfile) =>
      api.patch<{ profile: LlmProfile }>(`/admin/api/llm-profiles/${p.id}`, {
        enabled: !p.enabled,
      }),
    onSuccess: () => refresh(),
    onError: (err) => toast.error(String(err)),
  });

  const remove = useMutation({
    mutationFn: (p: LlmProfile) => api.del<{ ok: boolean }>(`/admin/api/llm-profiles/${p.id}`),
    onSuccess: () => {
      refresh();
      toast.success("Profile deleted");
    },
    onError: (err) => toast.error(String(err)),
  });

  const test = useMutation({
    mutationFn: (d: DraftProfile) =>
      api.post<{ ok: boolean; message: string }>("/admin/api/llm-profiles/test", {
        id: d.id,
        kind: d.kind,
        provider: d.provider,
        base_url: d.base_url,
        api_key: d.api_key,
        model: d.model,
        params: d.kind === "embedding" ? { dimensions: d.dimensions } : undefined,
      }),
    onSuccess: (res) =>
      res.ok
        ? toast.success(res.message || "Connection OK")
        : toast.error(res.message || "Test failed"),
    onError: (err) => toast.error(String(err)),
  });

  const fetchModels = useMutation({
    mutationFn: (d: DraftProfile) =>
      api.post<{ ok: boolean; models?: string[]; message: string }>(
        "/admin/api/llm-profiles/models",
        {
          id: d.id,
          kind: d.kind,
          provider: d.provider,
          base_url: d.base_url,
          api_key: d.api_key,
        },
      ),
    onSuccess: (res) => {
      if (res.ok && res.models?.length) {
        setModels(res.models);
        toast.success(`Loaded ${res.models.length} models`);
      } else {
        toast.error(res.message || "No models returned");
      }
    },
    onError: (err) => toast.error(String(err)),
  });

  const profiles = data?.profiles ?? [];
  const enabledCount = profiles.filter((p) => p.enabled).length;
  const testingProfileId = test.isPending ? test.variables?.id : undefined;

  return (
    <div className="module-card">
      <div className="module-card__head">
        <div>
          <h3 className="subhead" style={{ margin: 0 }}>
            {kind === "analysis" ? "Analysis LM profiles" : "Embedding profiles"}
          </h3>
          <div className="muted small">
            {enabledCount} of {profiles.length} enabled.{" "}
            {strategy === "weighted"
              ? "Traffic is spread by weight; a failed call still falls back to the others."
              : "The lowest-priority enabled profile is used; the rest are fallbacks."}
          </div>
        </div>
        <div className="head-actions">
          <button
            type="button"
            className="btn"
            onClick={() => {
              setModels([]);
              setEditing(emptyDraft(kind));
            }}
          >
            Add profile
          </button>
        </div>
      </div>

      {kind === "embedding" && (
        <div className="warning-box">
          <strong>Every enabled embedding profile must serve the same model and dimensions.</strong>{" "}
          Vectors from different embedding models — including different quantisations of the same
          model (<code>:q8_0</code> vs <code>:f16</code>) — are not comparable, and every vector in
          the database shares one column. Extra profiles are for redundancy across hosts running
          the <em>same</em> model. Changing model or dimensions means re-embedding every module.
        </div>
      )}

      {isPending ? (
        <div className="muted">Loading profiles…</div>
      ) : profiles.length === 0 ? (
        <div className="muted small">
          No profiles yet — add one to enable{" "}
          {kind === "analysis" ? "drug-insert analysis" : "semantic search"}.
        </div>
      ) : (
        <table className="jobs-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Provider</th>
              <th>Model</th>
              {kind === "embedding" && <th>Dim</th>}
              <th>Priority</th>
              <th>Weight</th>
              <th>Key</th>
              <th>Enabled</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {profiles.map((p) => (
              <tr key={p.id}>
                <td data-label="Name">{p.name}</td>
                <td data-label="Provider">{p.provider}</td>
                <td data-label="Model">{p.model}</td>
                {kind === "embedding" && (
                  <td data-label="Dim">{Number(p.params?.dimensions ?? 1024)}</td>
                )}
                <td data-label="Priority">{p.priority}</td>
                <td data-label="Weight">{strategy === "weighted" ? p.weight : "—"}</td>
                <td data-label="Key">{p.has_api_key ? "saved" : "—"}</td>
                <td data-label="Enabled">
                  <input
                    type="checkbox"
                    checked={p.enabled}
                    disabled={toggle.isPending}
                    onChange={() => toggle.mutate(p)}
                  />
                </td>
                <td data-label="Actions">
                  <button
                    type="button"
                    className="btn btn--sm"
                    disabled={test.isPending}
                    onClick={() => test.mutate(toDraft(p))}
                  >
                    {testingProfileId === p.id ? "Testing…" : "Test"}
                  </button>{" "}
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={() => {
                      setModels([]);
                      setEditing(toDraft(p));
                    }}
                  >
                    Edit
                  </button>{" "}
                  <button
                    type="button"
                    className="btn btn--sm"
                    disabled={remove.isPending}
                    onClick={() => {
                      if (window.confirm(`Delete profile '${p.name}'?`)) remove.mutate(p);
                    }}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {editing && (
        <div style={{ marginTop: "1rem" }}>
          <h4 className="subhead" style={{ margin: "0 0 0.75rem" }}>
            {editing.id ? "Edit profile" : "New profile"}
          </h4>
          <div className="settings-grid">
          <label className="settings-field">
            <span className="settings-field__label">Name</span>
            <input
              type="text"
              name="name"
              autoComplete="off"
              value={editing.name}
              autoFocus
              placeholder="e.g. OpenAI primary"
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
            />
          </label>
          <label className="settings-field">
            <span className="settings-field__label">Provider</span>
            <select
              name="provider"
              value={editing.provider}
              onChange={(e) => {
                const provider = e.target.value;
                // Only swap the URL when it is still a default — never clobber a
                // hand-typed endpoint.
                const isDefault =
                  editing.base_url === "" ||
                  Object.values(BASE_URL_DEFAULTS).includes(editing.base_url);
                setEditing({
                  ...editing,
                  provider,
                  base_url: isDefault ? (BASE_URL_DEFAULTS[provider] ?? "") : editing.base_url,
                });
              }}
            >
              {PROVIDERS[kind].map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
          <label className="settings-field">
            <span className="settings-field__label">Base URL</span>
            <input
              type="text"
              name="base_url"
              value={editing.base_url}
              onChange={(e) => setEditing({ ...editing, base_url: e.target.value })}
            />
          </label>
          <label className="settings-field">
            <span className="settings-field__label">API Key</span>
            <input
              type="password"
              name="api_key"
              autoComplete="new-password"
              value={editing.api_key}
              placeholder={
                editing.id && profiles.find((p) => p.id === editing.id)?.has_api_key
                  ? "Saved — leave blank to keep it"
                  : "Not set"
              }
              onChange={(e) => setEditing({ ...editing, api_key: e.target.value })}
            />
          </label>
          <label className="settings-field">
            <span className="settings-field__label">Model</span>
            <span className="field-with-action">
                <input
                  type="text"
                  name="model"
                  value={editing.model}
                  placeholder="e.g. OpenAI primary"
                  list={`models-${kind}`}
                  onChange={(e) => setEditing({ ...editing, model: e.target.value })}
                />
              <datalist id={`models-${kind}`}>
                {models.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
              <button
                type="button"
                className="btn btn--sm"
                disabled={fetchModels.isPending}
                onClick={() => fetchModels.mutate(editing)}
              >
                {fetchModels.isPending ? "…" : "Fetch models"}
              </button>
            </span>
          </label>
          <label className="settings-field">
            <span className="settings-field__label">Priority</span>
            <input
              type="number"
              name="priority"
              value={editing.priority}
              onChange={(e) => setEditing({ ...editing, priority: Number(e.target.value) })}
            />
            <span className="muted small">Lower is tried first.</span>
          </label>
          <label className="settings-field">
            <span className="settings-field__label">Weight</span>
            <input
              type="number"
              name="weight"
              min={0}
              value={editing.weight}
              onChange={(e) => setEditing({ ...editing, weight: Number(e.target.value) })}
            />
            <span className="muted small">
              Share of traffic under the weighted strategy. 0 = fallback only.
            </span>
          </label>
          {kind === "analysis" && (
            <>
              <label className="settings-field">
                <span className="settings-field__label">Temperature</span>
                <input
                  type="number"
                  name="temperature"
                  step="0.1"
                  value={editing.temperature}
                  onChange={(e) =>
                    setEditing({ ...editing, temperature: Number(e.target.value) })
                  }
                />
              </label>
              <label className="settings-field">
                <span className="settings-field__label">Max tokens</span>
                <input
                  type="number"
                  name="max_tokens"
                  value={editing.max_tokens}
                  onChange={(e) => setEditing({ ...editing, max_tokens: Number(e.target.value) })}
                />
                {isReasoningModel(editing.model) &&
                  editing.max_tokens < DEFAULT_REASONING_MAX_TOKENS && (
                    <span className="muted small">
                      {editing.model} is a reasoning model: it spends this budget on
                      hidden reasoning before it writes any answer, so a low value can
                      leave nothing for the reply. {DEFAULT_REASONING_MAX_TOKENS} or
                      more is recommended. The pipeline raises the budget on its own
                      when a call runs out, so this is a starting point, not a cap.
                    </span>
                  )}
              </label>
            </>
          )}
          {kind === "embedding" && (
            <label className="settings-field">
              <span className="settings-field__label">Dimensions</span>
              <input
                type="number"
                name="dimensions"
                min={1}
                value={editing.dimensions}
                onChange={(e) => setEditing({ ...editing, dimensions: Number(e.target.value) })}
              />
              <span className="muted small">
                Must match the model output. All enabled embedding profiles must agree.
              </span>
            </label>
          )}
          <label className="settings-field">
            <span className="settings-field__label">Enabled</span>
            <input
              type="checkbox"
              name="enabled"
              checked={editing.enabled}
              onChange={(e) => setEditing({ ...editing, enabled: e.target.checked })}
            />
          </label>

          <div className="head-actions" style={{ gridColumn: "1 / -1" }}>
            <button
              type="button"
              className="btn"
              disabled={test.isPending}
              onClick={() => test.mutate(editing)}
            >
              {test.isPending ? "Testing…" : "Test connection"}
            </button>
            <button
              type="button"
              className="btn"
              disabled={save.isPending}
              onClick={() => save.mutate(editing)}
            >
              {save.isPending ? "Saving…" : editing.id ? "Save profile" : "Create profile"}
            </button>
            <button type="button" className="btn" onClick={() => setEditing(null)}>
              Cancel
            </button>
          </div>
          </div>
        </div>
      )}
    </div>
  );
}
