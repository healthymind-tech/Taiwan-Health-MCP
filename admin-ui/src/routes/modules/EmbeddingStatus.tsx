// Per-module embedding visibility + an embedding-aware Embed button.
//
// Both the status line and the button derive from one query (qk.embedding,
// which the WS map invalidates whenever any *_embed job finishes), via the
// useModuleEmbedding hook — so they always agree and refresh on their own.
//
// States handled (see useModuleEmbedding):
//   • no embeddings for this module / no data loaded  → status hidden, button
//     governed only by `populated`
//   • 0 embedded                                       → "not embedded", N pending
//   • partial (0 < embedded < total)                   → "partial X%", N pending
//   • fully embedded but source changed since          → "stale" (re-embed)
//   • fully embedded & fresh                            → "embedded", button DISABLED

import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { qk } from "../../lib/queryKeys";
import { formatRelative } from "../../lib/time";
import type { EmbeddingStatusPayload } from "../../lib/types";

export interface ModuleEmbedding {
  total: number;
  embedded: number;
  pending: number;
  stale: boolean;
  hasData: boolean;
  /** There is embedding work to do: rows pending, or the source changed. */
  hasWork: boolean;
  lastEmbeddedAt: string;
  ollamaReady: boolean;
  ollamaModel: string;
}

function isStale(lastEmbedded: string, lastSource: string): boolean {
  if (!lastEmbedded || !lastSource) return false;
  const e = Date.parse(lastEmbedded);
  const s = Date.parse(lastSource);
  return Number.isFinite(e) && Number.isFinite(s) && s > e;
}

/** Derived embedding state for a module, or null while loading / not embeddable. */
export function useModuleEmbedding(moduleKey: string): ModuleEmbedding | null {
  const { data } = useQuery({
    queryKey: qk.embedding,
    queryFn: () => api.get<EmbeddingStatusPayload>("/admin/api/embedding/status"),
    staleTime: 30_000,
  });
  const mod = data?.modules.find((m) => m.key === moduleKey);
  if (!data || !mod) return null;

  const pending = Math.max(0, mod.total - mod.embedded);
  const stale = isStale(mod.last_embedded_at, mod.last_source_updated_at);
  const hasData = mod.total > 0;
  return {
    total: mod.total,
    embedded: mod.embedded,
    pending,
    stale,
    hasData,
    hasWork: hasData && (pending > 0 || stale),
    lastEmbeddedAt: mod.last_embedded_at,
    ollamaReady: data.ollama.configured && data.ollama.reachable,
    ollamaModel: data.ollama.model,
  };
}

export function EmbeddingStatus({ moduleKey }: { moduleKey: string }): JSX.Element | null {
  const emb = useModuleEmbedding(moduleKey);
  if (!emb || !emb.hasData) return null; // no embeddings concept, or no data yet

  const { embedded, total, pending, stale } = emb;
  const pct = Math.round((embedded / total) * 100);

  let tone: "ok" | "warn";
  let label: string;
  let detail: string;
  if (embedded === 0) {
    tone = "warn";
    label = "not embedded";
    detail = `0 / ${total.toLocaleString()} · ${pending.toLocaleString()} pending`;
  } else if (pending > 0) {
    tone = "warn";
    label = `partial · ${pct}%`;
    detail = `${embedded.toLocaleString()} / ${total.toLocaleString()} · ${pending.toLocaleString()} pending`;
  } else if (stale) {
    tone = "warn";
    label = "stale";
    detail = `${embedded.toLocaleString()} / ${total.toLocaleString()} · source changed`;
  } else {
    tone = "ok";
    label = "embedded";
    detail = `${embedded.toLocaleString()} / ${total.toLocaleString()}`;
  }

  const extra: string[] = [];
  if (emb.lastEmbeddedAt) extra.push(`updated ${formatRelative(emb.lastEmbeddedAt)}`);
  if (emb.ollamaModel) extra.push(emb.ollamaModel);

  return (
    <div className="summary-row embed-status">
      <span className="embed-status__tag">Embeddings</span>
      <span className={`badge badge--${tone}`}>{label}</span>
      <span className="muted small">
        {detail}
        {extra.length > 0 ? ` · ${extra.join(" · ")}` : ""}
      </span>
      {emb.hasWork && !emb.ollamaReady && (
        <span
          className="badge badge--muted"
          title="The embedding provider is not configured or unreachable; an Embed run will fail until it is back."
        >
          provider offline
        </span>
      )}
    </div>
  );
}

export function EmbedButton({
  moduleKey,
  populated,
  busy,
  onEmbed,
  notReadyReason = "Import data first",
}: {
  moduleKey: string;
  populated: boolean;
  busy: boolean;
  onEmbed: () => void;
  notReadyReason?: string;
}): JSX.Element {
  const emb = useModuleEmbedding(moduleKey);
  // Disable when fully embedded and up to date — there is nothing to embed.
  const nothingToDo = !!emb && emb.hasData && !emb.hasWork;
  const disabled = !populated || busy || nothingToDo;

  const label = busy ? "Embedding…" : nothingToDo ? "Embedded" : "Embed";
  const title = !populated
    ? notReadyReason
    : nothingToDo
      ? "All records are already embedded"
      : emb?.stale
        ? "Source changed since last embed — re-embed recommended"
        : emb && emb.pending > 0
          ? `${emb.pending.toLocaleString()} record(s) not embedded yet`
          : undefined;

  return (
    <button type="button" className="btn" disabled={disabled} title={title} onClick={onEmbed}>
      {label}
    </button>
  );
}
