// Generic data browser for any preview-supported module.
//
// Every preview handler (admin_preview.py) returns the same envelope shape
// — { rows, total, page, per_page, message? } — so one component covers all
// modules, rendering rows as a dynamic table with search + pagination.

import { useState } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { qk } from "../../lib/queryKeys";
import { Modal } from "../../components/Modal";
import type { PreviewResult } from "../../lib/types";

const PER_PAGE = 25;
const MAX_COLS = 8;

function cellText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function DataPreviewModal({
  moduleKey,
  label,
  onClose,
}: {
  moduleKey: string;
  label: string;
  onClose: () => void;
}): JSX.Element {
  const [page, setPage] = useState(1);
  const [qInput, setQInput] = useState("");
  const [q, setQ] = useState("");

  const params: Record<string, string> = {
    page: String(page),
    per_page: String(PER_PAGE),
    ...(q ? { q } : {}),
  };

  const { data, isPending, isError, error, isFetching } = useQuery({
    queryKey: qk.modulePreview(moduleKey, params),
    queryFn: () =>
      api.get<PreviewResult>(
        `/admin/api/modules/${moduleKey}/preview?${new URLSearchParams(params).toString()}`,
      ),
    placeholderData: keepPreviousData,
  });

  const rows = data?.rows ?? [];
  const total = data?.total ?? rows.length;
  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));
  // Column union across the page's rows, capped for readability.
  const columns = Array.from(
    rows.reduce((set, row) => {
      Object.keys(row).forEach((k) => set.add(k));
      return set;
    }, new Set<string>()),
  ).slice(0, MAX_COLS);

  function submitSearch(e: React.FormEvent) {
    e.preventDefault();
    setPage(1);
    setQ(qInput.trim());
  }

  return (
    <Modal title={`${label} — data preview`} onClose={onClose} wide>
      <form className="head-actions" onSubmit={submitSearch} style={{ marginBottom: 12 }}>
        <input
          type="text"
          placeholder="Search…"
          value={qInput}
          onChange={(e) => setQInput(e.target.value)}
          style={{ flex: 1, padding: "7px 10px", border: "1px solid var(--line)", borderRadius: 8 }}
        />
        <button type="submit" className="btn btn--sm">Search</button>
      </form>

      {isPending ? (
        <div className="muted">Loading preview…</div>
      ) : isError ? (
        <div className="error-box">Preview failed: {String(error)}</div>
      ) : data?.message && rows.length === 0 ? (
        <div className="muted">{data.message}</div>
      ) : rows.length === 0 ? (
        <div className="muted">No rows.</div>
      ) : (
        <>
          <div className="preview-scroll">
            <table className="jobs-table">
              <thead>
                <tr>
                  {columns.map((c) => (
                    <th key={c}>{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr key={i}>
                    {columns.map((c) => (
                      <td key={c} className="small preview-cell" title={cellText(row[c])} data-label={c}>
                        {cellText(row[c])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="head-actions" style={{ marginTop: 12, justifyContent: "space-between" }}>
            <span className="muted small">
              {total} rows{isFetching ? " · refreshing…" : ""}
            </span>
            <span className="head-actions">
              <button type="button" className="btn btn--sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                Prev
              </button>
              <span className="muted small">
                {page} / {totalPages}
              </span>
              <button type="button" className="btn btn--sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
                Next
              </button>
            </span>
          </div>
        </>
      )}
    </Modal>
  );
}
