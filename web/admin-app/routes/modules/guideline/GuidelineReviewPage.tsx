// Human review/approval gate for Analysis-LM-extracted clinical guideline data
// — the one piece of this pipeline with no existing pattern to copy anywhere
// else in the admin console. A reviewer inspects the extracted JSON next to
// the original PDF/OCR text (in a floating side-by-side viewer, same pattern
// as the Drug Explorer's — see AssetViewerModal), may correct any field, then
// either Approves (fans out into the live disease_guidelines/* tables) or
// Rejects (with a required reason; the document can be re-analyzed later).
//
// The Analysis LM determines the ICD code itself (no operator-declared code
// up front), so a single PDF may fan out into several extractions — one per
// disease, each reviewed/approved/rejected independently (grouped in the
// sidebar by their shared document_id). Approval is hard-blocked server-side
// when the ICD code doesn't match the loaded ICD-10-CM dataset; this page
// mirrors that check live as the reviewer edits the field so the Approve
// button reflects it before they even submit.

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText } from "lucide-react";
import { api } from "../../../lib/api";
import { formatRelative } from "../../../lib/time";
import { toast } from "../../../components/toast";
import { Modal } from "../../../components/Modal";
import { AssetViewerModal, type AssetViewerState } from "../../../components/AssetViewerModal";

interface PendingDoc {
  analysis_id: string;
  document_id: string;
  extracted_icd_code: string | null;
  extracted_disease_name: string | null;
  icd_code_known: boolean | null;
  source_filename: string;
  uploaded_at: string;
  completed_at: string;
}
interface PendingPayload {
  total: number;
  documents: PendingDoc[];
}

interface DiseaseInfo {
  icd_code: string;
  disease_name_zh: string;
  disease_name_en: string;
  guideline_title: string;
  guideline_source: string;
  publication_year: string;
  guideline_summary: string;
}
type Row = Record<string, string>;
interface ExtractedJson {
  disease_info: DiseaseInfo;
  diagnostic_recommendations: Row[];
  medication_recommendations: Row[];
  test_recommendations: Row[];
  treatment_goals: Row[];
}
interface ReviewDetail {
  analysis_id: string;
  document_id: string;
  normalized_json: ExtractedJson;
  edited_json: ExtractedJson | null;
  extracted_icd_code: string | null;
  extracted_disease_name: string | null;
  icd_code_known: boolean | null;
  source_filename: string;
  ocr_object_key: string | null;
  analysis_object_key: string | null;
}

const DISEASE_INFO_FIELDS: { key: keyof DiseaseInfo; label: string }[] = [
  { key: "icd_code", label: "ICD-10 code" },
  { key: "disease_name_zh", label: "Disease name (中文)" },
  { key: "disease_name_en", label: "Disease name (English)" },
  { key: "guideline_title", label: "Guideline title" },
  { key: "guideline_source", label: "Source society" },
  { key: "publication_year", label: "Publication year" },
  { key: "guideline_summary", label: "Summary" },
];

const ROW_SECTIONS: {
  key: keyof Pick<
    ExtractedJson,
    "diagnostic_recommendations" | "medication_recommendations" | "test_recommendations" | "treatment_goals"
  >;
  label: string;
  fields: { key: string; label: string }[];
}[] = [
  {
    key: "diagnostic_recommendations",
    label: "Diagnostic recommendations",
    fields: [
      { key: "step_order", label: "Step" },
      { key: "recommendation_type", label: "Type" },
      { key: "description", label: "Description" },
      { key: "evidence_level", label: "Evidence" },
    ],
  },
  {
    key: "medication_recommendations",
    label: "Medication recommendations",
    fields: [
      { key: "line_of_therapy", label: "Line of therapy" },
      { key: "medication_class", label: "Class" },
      { key: "medication_examples", label: "Examples" },
      { key: "dosage_guidance", label: "Dosage" },
      { key: "contraindications", label: "Contraindications" },
      { key: "evidence_level", label: "Evidence" },
    ],
  },
  {
    key: "test_recommendations",
    label: "Test recommendations",
    fields: [
      { key: "test_category", label: "Category" },
      { key: "test_name", label: "Test name" },
      { key: "loinc_code", label: "LOINC" },
      { key: "frequency", label: "Frequency" },
      { key: "indication", label: "Indication" },
      { key: "evidence_level", label: "Evidence" },
    ],
  },
  {
    key: "treatment_goals",
    label: "Treatment goals",
    fields: [
      { key: "goal_type", label: "Goal type" },
      { key: "target_parameter", label: "Parameter" },
      { key: "target_value", label: "Target value" },
      { key: "timeframe", label: "Timeframe" },
    ],
  },
];

function emptyRow(fields: { key: string }[]): Row {
  const row: Row = {};
  for (const f of fields) row[f.key] = "";
  return row;
}

/** PDF + OCR side by side (when OCR exists), same floating-viewer pattern as the Drug Explorer. */
function documentViewer(detail: ReviewDetail): AssetViewerState {
  const tabs: AssetViewerState["tabs"] = [
    {
      id: "pdf",
      kind: "pdf",
      label: "Source PDF",
      url: `/admin/api/guideline/asset-content?document_id=${detail.document_id}&kind=pdf`,
    },
  ];
  if (detail.ocr_object_key) {
    tabs.push({
      id: "ocr",
      kind: "markdown",
      label: "OCR Markdown",
      url: `/admin/api/guideline/asset-content?document_id=${detail.document_id}&kind=ocr`,
    });
  }
  if (detail.analysis_object_key) {
    tabs.push({
      id: "analysis",
      kind: "json",
      label: "Analysis JSON",
      url: `/admin/api/guideline/asset-content?analysis_id=${detail.analysis_id}&kind=analysis`,
    });
  }
  return {
    title: `${detail.extracted_icd_code || "(no ICD code)"} — ${detail.source_filename}`,
    tabs,
    initialId: "pdf",
  };
}

export function GuidelineReviewPage(): JSX.Element {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [form, setForm] = useState<ExtractedJson | null>(null);
  const [notes, setNotes] = useState("");
  const [viewer, setViewer] = useState<AssetViewerState | null>(null);

  const pendingQ = useQuery({
    queryKey: ["guideline", "review", "pending"],
    queryFn: () => api.get<PendingPayload>("/admin/api/guideline/review/pending?per_page=200"),
    staleTime: 5_000,
  });

  const detailQ = useQuery({
    queryKey: ["guideline", "review", "detail", selected],
    queryFn: () => api.get<ReviewDetail>(`/admin/api/guideline/review/${selected}`),
    enabled: !!selected,
  });

  useEffect(() => {
    if (detailQ.data) {
      setForm(detailQ.data.edited_json ?? detailQ.data.normalized_json);
      setNotes("");
    }
  }, [detailQ.data]);

  useEffect(() => {
    if (!selected && pendingQ.data && pendingQ.data.documents.length > 0) {
      setSelected(pendingQ.data.documents[0].analysis_id);
    }
  }, [selected, pendingQ.data]);

  // Live mirror of the server-side hard block in approveReview: as the reviewer
  // edits the ICD code, re-check it against the loaded ICD-10-CM dataset so the
  // Approve button reflects reality before they even submit. `null` = still
  // checking / unknown; the button stays disabled until this resolves `true`.
  const [icdKnownLive, setIcdKnownLive] = useState<boolean | null>(null);
  const icdCodeValue = form?.disease_info.icd_code ?? "";
  useEffect(() => {
    const code = icdCodeValue.trim();
    if (!code) {
      setIcdKnownLive(false);
      return;
    }
    setIcdKnownLive(null);
    const handle = setTimeout(() => {
      api
        .get<{ code: string; exists: boolean }>(
          `/admin/api/guideline/icd-exists?code=${encodeURIComponent(code)}`,
        )
        .then((res) => setIcdKnownLive(res.exists))
        .catch(() => setIcdKnownLive(null));
    }, 400);
    return () => clearTimeout(handle);
  }, [icdCodeValue]);

  function refreshLists(): void {
    void qc.invalidateQueries({ queryKey: ["guideline", "review", "pending"] });
    void qc.invalidateQueries({ queryKey: ["guideline", "status"] });
    void qc.invalidateQueries({ queryKey: ["guideline", "pipeline-status"] });
  }

  const approve = useMutation({
    mutationFn: () =>
      api.post(`/admin/api/guideline/review/${selected}/approve`, {
        edits: form,
        notes: notes.trim() || undefined,
      }),
    onSuccess: () => {
      toast.success("Approved — now live");
      setSelected(null);
      refreshLists();
    },
    onError: (err) => toast.error(String(err instanceof Error ? err.message : err)),
  });

  const reject = useMutation({
    mutationFn: () => api.post(`/admin/api/guideline/review/${selected}/reject`, { notes }),
    onSuccess: () => {
      toast.success("Rejected");
      setSelected(null);
      refreshLists();
    },
    onError: (err) => toast.error(String(err instanceof Error ? err.message : err)),
  });

  function updateInfo(key: keyof DiseaseInfo, value: string): void {
    setForm((f) => (f ? { ...f, disease_info: { ...f.disease_info, [key]: value } } : f));
  }
  function updateRow(section: (typeof ROW_SECTIONS)[number]["key"], idx: number, field: string, value: string): void {
    setForm((f) => {
      if (!f) return f;
      const rows = [...f[section]];
      rows[idx] = { ...rows[idx], [field]: value };
      return { ...f, [section]: rows };
    });
  }
  function addRow(section: (typeof ROW_SECTIONS)[number]["key"], fields: { key: string }[]): void {
    setForm((f) => (f ? { ...f, [section]: [...f[section], emptyRow(fields)] } : f));
  }
  function removeRow(section: (typeof ROW_SECTIONS)[number]["key"], idx: number): void {
    setForm((f) => (f ? { ...f, [section]: f[section].filter((_, i) => i !== idx) } : f));
  }

  const documents = pendingQ.data?.documents ?? [];
  const detail = detailQ.data;

  return (
    <Modal title="Clinical guideline review queue" onClose={() => navigate("/modules/guideline")} workspace>
      <div className="guideline-review">
        <nav className="guideline-review-sidebar" aria-label="Pending extractions">
          {pendingQ.isPending && (
            <div className="muted small" style={{ padding: 14 }}>
              Loading…
            </div>
          )}
          {pendingQ.isError && (
            <div className="error-box" style={{ margin: 14 }}>
              Failed to load: {String(pendingQ.error)}
            </div>
          )}
          {documents.length === 0 && !pendingQ.isPending && (
            <div className="muted small" style={{ padding: 14 }}>
              Nothing pending review.
            </div>
          )}
          {documents.map((doc) => (
            <button
              key={doc.analysis_id}
              type="button"
              className={`guideline-review-item ${selected === doc.analysis_id ? "guideline-review-item--active" : ""}`}
              onClick={() => setSelected(doc.analysis_id)}
            >
              <span className="guideline-review-item__title">
                {doc.extracted_icd_code || "(no ICD code)"}
                {doc.icd_code_known === false && (
                  <span className="badge badge--bad" title="Not found in the loaded ICD-10-CM dataset">
                    unrecognized
                  </span>
                )}
              </span>
              <span>{doc.extracted_disease_name || "—"}</span>
              <span className="muted small">
                {doc.source_filename} · {formatRelative(doc.completed_at)}
              </span>
            </button>
          ))}
        </nav>

        <div className="guideline-review-detail">
          {!selected && <div className="muted">Select an extraction to review.</div>}
          {selected && detailQ.isPending && <div className="muted">Loading…</div>}
          {selected && detailQ.isError && (
            <div className="error-box">Failed to load: {String(detailQ.error)}</div>
          )}
          {selected && detail && form && (
            <div>
              <div className="module-card__head">
                <div>
                  <h3 className="subhead" style={{ margin: 0 }}>
                    {detail.extracted_icd_code || "(no ICD code)"} — {detail.extracted_disease_name || detail.source_filename}
                  </h3>
                  <div className="muted small">{detail.source_filename}</div>
                </div>
                <div className="head-actions">
                  <button type="button" className="btn btn--sm" onClick={() => setViewer(documentViewer(detail))}>
                    <FileText size={15} />
                    <span>View PDF{detail.ocr_object_key ? " + OCR" : ""}</span>
                  </button>
                </div>
              </div>

              <div className="module-card guideline-review-section">
                <div className="guideline-review-section__label">Disease info</div>
                <div className="guideline-review-grid">
                  {DISEASE_INFO_FIELDS.map(({ key, label }) => (
                    <label key={key} className="guideline-review-field">
                      {label}
                      {key === "guideline_summary" ? (
                        <textarea
                          value={form.disease_info[key] ?? ""}
                          onChange={(e) => updateInfo(key, e.target.value)}
                          rows={2}
                        />
                      ) : (
                        <input
                          type="text"
                          value={form.disease_info[key] ?? ""}
                          onChange={(e) => updateInfo(key, e.target.value)}
                        />
                      )}
                    </label>
                  ))}
                </div>
              </div>

              {ROW_SECTIONS.map((section) => (
                <div key={section.key} className="module-card guideline-review-section">
                  <div className="guideline-review-section__label">{section.label}</div>
                  <div className="guideline-review-table" style={{ overflowX: "auto" }}>
                    <table className="jobs-table">
                      <thead>
                        <tr>
                          {section.fields.map((f) => (
                            <th key={f.key}>{f.label}</th>
                          ))}
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {form[section.key].map((row, idx) => (
                          <tr key={idx}>
                            {section.fields.map((f) => (
                              <td key={f.key}>
                                <input
                                  type="text"
                                  value={row[f.key] ?? ""}
                                  onChange={(e) => updateRow(section.key, idx, f.key, e.target.value)}
                                />
                              </td>
                            ))}
                            <td>
                              <button type="button" className="icon-btn" onClick={() => removeRow(section.key, idx)} aria-label="Remove row">
                                ×
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <button
                    type="button"
                    className="btn btn--sm"
                    style={{ marginTop: 10 }}
                    onClick={() => addRow(section.key, section.fields)}
                  >
                    + Add row
                  </button>
                </div>
              ))}

              <label className="guideline-review-field" style={{ marginBottom: 12 }}>
                Review notes (required to reject)
                <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
              </label>

              <div className="head-actions">
                <button
                  type="button"
                  className="btn btn--primary"
                  disabled={approve.isPending || icdKnownLive !== true}
                  title={
                    icdKnownLive === false
                      ? "ICD code was not found in the loaded ICD-10-CM dataset — edit it to a recognized code"
                      : icdKnownLive === null
                        ? "Checking ICD code…"
                        : undefined
                  }
                  onClick={() => approve.mutate()}
                >
                  {approve.isPending ? "Approving…" : "Approve"}
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={reject.isPending || !notes.trim()}
                  title={!notes.trim() ? "Review notes are required to reject" : undefined}
                  onClick={() => reject.mutate()}
                >
                  {reject.isPending ? "Rejecting…" : "Reject"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {viewer && <AssetViewerModal viewer={viewer} onClose={() => setViewer(null)} />}
    </Modal>
  );
}
