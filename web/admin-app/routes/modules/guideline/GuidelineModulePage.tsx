// Clinical Guideline module page: upload a guideline PDF, watch it move
// through the OCR/Analysis LM pipeline, then jump to the review queue (human
// approval gate — see GuidelineReviewPage) or the Explorer (browse the live,
// approved guidelines — see GuidelineExplorerPage).
//
// No ICD code is declared at upload time — the Analysis LM determines the
// disease(s)/ICD code(s) from the document itself, and a single PDF can fan
// out into several independently-reviewable extractions (one per disease).
//
// Unlike every other module here, guideline data never becomes queryable just
// because a job succeeded: `pipeline_stage` only reaches `pending_review` on
// its own, and only an explicit Approve in the review queue promotes an
// extraction into `disease_guidelines` (see node-server/src/admin/guidelineReview.ts).

import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../lib/api";
import { qk } from "../../../lib/queryKeys";
import { formatRelative } from "../../../lib/time";
import { useActiveJobTypes } from "../../../lib/jobs";
import { uploadWithProgress } from "../../../lib/upload";
import { toast } from "../../../components/toast";
import { StatusBadge } from "../../../components/StatusBadge";
import { EmbeddingStatus, EmbedButton } from "../EmbeddingStatus";

interface GuidelineDocument {
  document_id: string;
  source_filename: string;
  pipeline_stage: string;
  uploaded_by: string;
  uploaded_at: string;
  extraction_count: number;
  extracted_codes: string[];
  pending_review_count: number;
  approved_count: number;
  rejected_count: number;
}

interface GuidelineStatusPayload {
  total: number;
  page: number;
  per_page: number;
  documents: GuidelineDocument[];
}

interface GuidelinePipelineStatus {
  stage_counts: Record<string, number>;
  pending_review: number;
  live_guidelines: number;
  last_job: { job_id: string; status: string; current_step: string } | null;
}

const guidelineStatusKey = ["guideline", "status"] as const;
const guidelinePipelineKey = ["guideline", "pipeline-status"] as const;

export function GuidelineModulePage(): JSX.Element {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const activeJobTypes = useActiveJobTypes();
  const analyzing = activeJobTypes.has("guideline_analysis");

  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [pdfUrl, setPdfUrl] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const statusQ = useQuery({
    queryKey: guidelineStatusKey,
    queryFn: () => api.get<GuidelineStatusPayload>("/admin/api/guideline/status?per_page=100"),
    staleTime: 10_000,
  });
  const pipelineQ = useQuery({
    queryKey: guidelinePipelineKey,
    queryFn: () => api.get<GuidelinePipelineStatus>("/admin/api/guideline/pipeline-status"),
    staleTime: 10_000,
  });

  function refresh(): void {
    void qc.invalidateQueries({ queryKey: guidelineStatusKey });
    void qc.invalidateQueries({ queryKey: guidelinePipelineKey });
  }

  const triggerAnalysis = useMutation({
    mutationFn: () => api.post("/admin/api/jobs", { job_type: "guideline_analysis", module_key: "guideline" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.jobs });
      toast.success("Started guideline_analysis");
    },
    onError: (err) => toast.error(`Failed to start analysis: ${String(err)}`),
  });

  const triggerEmbed = useMutation({
    mutationFn: () => api.post("/admin/api/jobs", { job_type: "guideline_embed", module_key: "guideline" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.jobs });
      toast.success("Started guideline_embed");
    },
    onError: (err) => toast.error(String(err)),
  });

  async function handleUpload(file: File): Promise<void> {
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      toast.error("Only .pdf files are accepted");
      return;
    }
    setUploadPct(0);
    try {
      const uploadResult = await uploadWithProgress(
        file,
        { moduleKey: "guideline", sourceRole: "guideline_pdf", filename: file.name, autoActivate: true },
        setUploadPct,
      );
      const uploadedFileId = String(uploadResult.uploaded_file?.uploaded_file_id ?? "");
      if (!uploadedFileId) throw new Error("Upload succeeded but returned no uploaded_file_id");

      await api.post("/admin/api/guideline/documents", { uploaded_file_id: uploadedFileId });
      toast.success(`Uploaded ${file.name} — queued for analysis`);
      refresh();
    } catch (err) {
      toast.error(String(err instanceof Error ? err.message : err));
    } finally {
      setUploadPct(null);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  // The server fetches the PDF itself (SSRF-guarded, HTTPS-only, no redirects,
  // private/loopback addresses rejected — see node-server/src/admin/safeUrlFetch.ts),
  // so there's no client-side upload-progress signal like the file path has.
  const fetchFromUrl = useMutation({
    mutationFn: (url: string) => api.post("/admin/api/guideline/documents/from-url", { url }),
    onSuccess: () => {
      toast.success("Fetched PDF from URL — queued for analysis");
      setPdfUrl("");
      refresh();
    },
    onError: (err) => toast.error(String(err instanceof Error ? err.message : err)),
  });

  if (statusQ.isPending || pipelineQ.isPending) return <div className="muted">Loading…</div>;
  if (statusQ.isError) return <div className="error-box">Failed to load: {String(statusQ.error)}</div>;
  if (pipelineQ.isError) return <div className="error-box">Failed to load: {String(pipelineQ.error)}</div>;

  const documents = statusQ.data.documents;
  const pipeline = pipelineQ.data;
  const populated = pipeline.live_guidelines > 0;
  const queuedCount = pipeline.stage_counts.queued ?? 0;

  return (
    <div>
      <div className="module-card__head">
        <div>
          <h3 className="subhead" style={{ margin: 0 }}>Clinical guidelines</h3>
          <div className="muted small">
            Upload a clinical-guideline PDF, extracted by OCR + Analysis LM, and reviewed by an
            operator before it becomes live and queryable.
          </div>
        </div>
        <div className="head-actions">
          <button
            type="button"
            className="btn"
            disabled={analyzing || queuedCount === 0}
            title={queuedCount === 0 ? "No queued documents to analyze" : undefined}
            onClick={() => triggerAnalysis.mutate()}
          >
            {analyzing ? "Analyzing…" : `Run analysis${queuedCount ? ` (${queuedCount})` : ""}`}
          </button>
          <EmbedButton
            moduleKey="guideline"
            populated={populated}
            busy={activeJobTypes.has("guideline_embed")}
            notReadyReason="Approve at least one guideline before embedding."
            onEmbed={() => triggerEmbed.mutate()}
          />
          <button type="button" className="btn" onClick={() => navigate("/modules/guideline/review")}>
            Review queue{pipeline.pending_review > 0 ? ` (${pipeline.pending_review})` : ""}
          </button>
          <button type="button" className="btn" onClick={() => navigate("/modules/guideline/explorer")}>
            Explorer
          </button>
        </div>
      </div>

      <div className="summary-row">
        <StatusBadge status={populated ? "ready" : "empty"} />
        <span className="muted small">
          {pipeline.live_guidelines.toLocaleString()} live guideline(s) · {pipeline.pending_review} pending review
        </span>
      </div>
      <EmbeddingStatus moduleKey="guideline" />

      <div className="source-role">
        <div className="source-role__head">
          <div>
            <strong>Upload a guideline PDF</strong>
            <div className="muted small">
              The Analysis LM determines the disease(s)/ICD code(s) — one PDF may fan out into several.
            </div>
          </div>
        </div>
        <div className="form-row" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input
            ref={inputRef}
            type="file"
            accept=".pdf"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleUpload(file);
            }}
          />
          {uploadPct === null ? (
            <button type="button" className="btn btn--sm" onClick={() => inputRef.current?.click()}>
              Upload PDF…
            </button>
          ) : (
            <span className="upload-progress">
              <span className="upload-progress__bar" style={{ width: `${uploadPct}%` }} />
              <span className="upload-progress__label">{uploadPct}%</span>
            </span>
          )}
          <span className="muted small">or</span>
          <div className="field-with-action">
            <input
              type="url"
              placeholder="https://example.org/guideline.pdf"
              value={pdfUrl}
              onChange={(e) => setPdfUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && pdfUrl.trim() && !fetchFromUrl.isPending) fetchFromUrl.mutate(pdfUrl.trim());
              }}
              style={{ minWidth: 280 }}
            />
            <button
              type="button"
              className="btn btn--sm"
              disabled={!pdfUrl.trim() || fetchFromUrl.isPending}
              onClick={() => fetchFromUrl.mutate(pdfUrl.trim())}
            >
              {fetchFromUrl.isPending ? "Fetching…" : "Fetch from URL"}
            </button>
          </div>
        </div>
      </div>

      {documents.length > 0 ? (
        <div className="service-list">
          {documents.map((doc) => (
            <div className="row row--service" key={doc.document_id}>
              <div className="row__main">
                <div className="row__name">
                  {doc.source_filename}
                  {doc.extracted_codes.length > 0 ? ` — ${doc.extracted_codes.join(", ")}` : ""}
                </div>
                <div className="muted small">
                  {doc.uploaded_by} · {formatRelative(doc.uploaded_at)}
                  {doc.extraction_count > 0
                    ? ` · ${doc.extraction_count} extracted (${doc.pending_review_count} pending, ` +
                      `${doc.approved_count} approved, ${doc.rejected_count} rejected)`
                    : ""}
                </div>
              </div>
              <div className="row__meta">
                <StatusBadge status={doc.pipeline_stage} />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="muted small" style={{ padding: "8px 0" }}>
          No guideline documents uploaded yet.
        </div>
      )}
    </div>
  );
}
