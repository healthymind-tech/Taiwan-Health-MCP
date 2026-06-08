// RxNorm-specific data preview.
//
// RxNorm is concept-only (rxcui, name, tty, suppress). The headline axis is TTY
// — the same term-type axis IG ValueSets filter on (e.g. TTY in SCD,SBD,GPCK,
// BPCK) — so the TTY distribution doubles as a one-click filter, alongside a
// name/RXCUI search and a paginated table.

import { useState } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { qk } from "../../lib/queryKeys";
import { Modal } from "../../components/Modal";

const PER_PAGE = 50;

interface TtyFacet {
  tty: string;
  count: number;
}
interface RxnormConceptRow {
  rxcui: string;
  name: string;
  tty: string;
  suppress: string;
}
interface RxnormPreviewResult {
  type: string;
  message?: string;
  total?: number;
  total_all?: number;
  tty_facets?: TtyFacet[];
  tty_selected?: string;
  page?: number;
  pages?: number;
  rows?: RxnormConceptRow[];
}

export function RxnormPreviewModal({ onClose }: { onClose: () => void }): JSX.Element {
  const [page, setPage] = useState(1);
  const [qInput, setQInput] = useState("");
  const [q, setQ] = useState("");
  const [tty, setTty] = useState("");

  const params: Record<string, string> = {
    page: String(page),
    per_page: String(PER_PAGE),
    ...(q ? { q } : {}),
    ...(tty ? { tty } : {}),
  };

  const { data, isPending, isError, error, isFetching } = useQuery({
    queryKey: qk.modulePreview("rxnorm", params),
    queryFn: () =>
      api.get<RxnormPreviewResult>(
        `/admin/api/modules/rxnorm/preview?${new URLSearchParams(params).toString()}`,
      ),
    placeholderData: keepPreviousData,
  });

  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const totalAll = data?.total_all ?? 0;
  const facets = data?.tty_facets ?? [];
  const totalPages = data?.pages ?? Math.max(1, Math.ceil(total / PER_PAGE));

  function submitSearch(e: React.FormEvent) {
    e.preventDefault();
    setPage(1);
    setQ(qInput.trim());
  }
  function pickTty(next: string) {
    setPage(1);
    setTty((cur) => (cur === next ? "" : next));
  }

  const empty = data?.type === "empty";

  return (
    <Modal title="RxNorm — data preview" onClose={onClose} wide>
      {isPending ? (
        <div className="muted">Loading preview…</div>
      ) : isError ? (
        <div className="error-box">Preview failed: {String(error)}</div>
      ) : empty ? (
        <div className="muted">{data?.message}</div>
      ) : (
        <>
          <div className="muted small" style={{ marginBottom: 8 }}>
            {totalAll.toLocaleString()} concepts total · {facets.length} term types (TTY)
          </div>

          {/* TTY distribution — click to filter. */}
          <div className="head-actions" style={{ flexWrap: "wrap", marginBottom: 12 }}>
            <button
              type="button"
              className={`btn btn--sm ${tty === "" ? "btn--active" : ""}`}
              onClick={() => pickTty("")}
            >
              All
            </button>
            {facets.map((f) => (
              <button
                type="button"
                key={f.tty}
                className={`btn btn--sm ${tty === f.tty ? "btn--active" : ""}`}
                title={`${f.count.toLocaleString()} concepts with TTY=${f.tty}`}
                onClick={() => pickTty(f.tty)}
              >
                {f.tty} <span className="muted">({f.count.toLocaleString()})</span>
              </button>
            ))}
          </div>

          <form className="head-actions" onSubmit={submitSearch} style={{ marginBottom: 12 }}>
            <input
              type="text"
              placeholder="Search by name or RXCUI…"
              value={qInput}
              onChange={(e) => setQInput(e.target.value)}
              style={{ flex: 1, padding: "7px 10px", border: "1px solid var(--line)", borderRadius: 8 }}
            />
            <button type="submit" className="btn btn--sm">Search</button>
            {(q || tty) && (
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => {
                  setQ("");
                  setQInput("");
                  setTty("");
                  setPage(1);
                }}
              >
                Clear
              </button>
            )}
          </form>

          {rows.length === 0 ? (
            <div className="muted">No concepts match this filter.</div>
          ) : (
            <>
              <div className="preview-scroll">
                <table className="jobs-table">
                  <thead>
                    <tr>
                      <th>RXCUI</th>
                      <th>Name</th>
                      <th>TTY</th>
                      <th>Suppress</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.rxcui}>
                        <td className="small" data-label="RXCUI">{r.rxcui}</td>
                        <td className="small preview-cell" title={r.name} data-label="Name">{r.name}</td>
                        <td className="small" data-label="TTY">{r.tty}</td>
                        <td className="small" data-label="Suppress">{r.suppress}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="head-actions" style={{ marginTop: 12, justifyContent: "space-between" }}>
                <span className="muted small">
                  {total.toLocaleString()} match{total === 1 ? "" : "es"}
                  {isFetching ? " · refreshing…" : ""}
                </span>
                <span className="head-actions">
                  <button type="button" className="btn btn--sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                    Prev
                  </button>
                  <span className="muted small">{page} / {totalPages}</span>
                  <button type="button" className="btn btn--sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
                    Next
                  </button>
                </span>
              </div>
            </>
          )}
        </>
      )}
    </Modal>
  );
}
