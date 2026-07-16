// Browse the LIVE, approved clinical guidelines (disease_guidelines + its four
// child tables). Read-only — editing happens before approval, in
// GuidelineReviewPage. Reuses the existing generic preview endpoint
// (GET /admin/api/modules/guideline/preview), which already returns a rich
// list/search/detail shape for this module.

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../lib/api";
import { Modal } from "../../../components/Modal";

interface DiseaseRow {
  id: number;
  icd_code: string;
  disease_name_zh: string;
  disease_name_en: string;
  guideline_title: string;
  guideline_source: string;
  publication_year: number | null;
}
interface ListPayload {
  type: "list" | "empty";
  total?: number;
  diseases?: DiseaseRow[];
  message?: string;
}
interface DetailPayload {
  type: "detail" | "error";
  message?: string;
  guideline?: {
    id: number;
    icd_code: string;
    disease_name_zh: string;
    disease_name_en: string;
    guideline_title: string;
    guideline_source: string;
    publication_year: number | null;
    guideline_summary: string;
  };
  diagnostic_recommendations?: Record<string, unknown>[];
  medication_recommendations?: Record<string, unknown>[];
  test_recommendations?: Record<string, unknown>[];
  treatment_goals?: Record<string, unknown>[];
}

function GenericTable({ rows }: { rows: Record<string, unknown>[] }): JSX.Element {
  if (rows.length === 0) return <div className="muted small">None recorded.</div>;
  const columns = Object.keys(rows[0]);
  return (
    <div style={{ overflowX: "auto" }}>
      <table className="table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, idx) => (
            <tr key={idx}>
              {columns.map((c) => (
                <td key={c}>{String(row[c] ?? "")}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function GuidelineExplorerPage(): JSX.Element {
  const navigate = useNavigate();
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const listQ = useQuery({
    queryKey: ["guideline", "explorer", "list"],
    queryFn: () => api.get<ListPayload>("/admin/api/modules/guideline/preview"),
    staleTime: 15_000,
  });

  const detailQ = useQuery({
    queryKey: ["guideline", "explorer", "detail", selectedId],
    queryFn: () => api.get<DetailPayload>(`/admin/api/modules/guideline/preview?id=${selectedId}`),
    enabled: selectedId !== null,
  });

  const diseases = listQ.data?.diseases ?? [];
  const detail = detailQ.data;

  return (
    <Modal
      title="Clinical guideline explorer"
      onClose={() => navigate("/modules/guideline")}
      workspace
      panelClassName="drug-explorer-modal"
    >
      <div className="modules-workspace" style={{ height: "100%" }}>
        <nav className="modules-sidebar" aria-label="Live guidelines" style={{ minWidth: 260 }}>
          {listQ.isPending && <div className="muted small">Loading…</div>}
          {listQ.isError && <div className="error-box">Failed to load: {String(listQ.error)}</div>}
          {listQ.data?.type === "empty" && <div className="muted small">{listQ.data.message}</div>}
          {diseases.map((d) => (
            <button
              key={d.id}
              type="button"
              className={`modules-sidebar__item ${selectedId === d.id ? "modules-sidebar__item--active" : ""}`}
              style={{ width: "100%", textAlign: "left", border: "none", background: "none", cursor: "pointer" }}
              onClick={() => setSelectedId(d.id)}
            >
              <span>
                <strong>{d.icd_code}</strong> — {d.disease_name_zh}
                <div className="muted small">{d.guideline_source} · {d.publication_year ?? "—"}</div>
              </span>
            </button>
          ))}
        </nav>

        <div className="modules-main" style={{ overflowY: "auto" }}>
          {selectedId === null && <div className="muted">Select a guideline to view its detail.</div>}
          {selectedId !== null && detailQ.isPending && <div className="muted">Loading…</div>}
          {selectedId !== null && detail?.type === "error" && (
            <div className="error-box">{detail.message}</div>
          )}
          {detail?.type === "detail" && detail.guideline && (
            <div>
              <h3 className="subhead" style={{ margin: 0 }}>
                {detail.guideline.icd_code} — {detail.guideline.disease_name_zh}
                {detail.guideline.disease_name_en ? ` (${detail.guideline.disease_name_en})` : ""}
              </h3>
              <div className="muted small" style={{ marginBottom: 12 }}>
                {detail.guideline.guideline_title} · {detail.guideline.guideline_source} ·{" "}
                {detail.guideline.publication_year ?? "—"}
              </div>
              {detail.guideline.guideline_summary && (
                <p className="muted">{detail.guideline.guideline_summary}</p>
              )}

              <h4>Diagnostic recommendations</h4>
              <GenericTable rows={detail.diagnostic_recommendations ?? []} />
              <h4>Medication recommendations</h4>
              <GenericTable rows={detail.medication_recommendations ?? []} />
              <h4>Test recommendations</h4>
              <GenericTable rows={detail.test_recommendations ?? []} />
              <h4>Treatment goals</h4>
              <GenericTable rows={detail.treatment_goals ?? []} />
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
