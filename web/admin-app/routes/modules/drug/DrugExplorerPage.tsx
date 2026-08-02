import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  ArrowDownAZ,
  ArrowLeft,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Cpu,
  Download,
  Eye,
  ExternalLink,
  FileJson,
  FileText,
  Filter,
  Image as ImageIcon,
  Search,
  ZoomIn,
  ZoomOut,
  X,
} from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import { Document as PdfDocument, Page as PdfPage, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import { api } from "../../../lib/api";
import { qk } from "../../../lib/queryKeys";
import { StatusBadge } from "../../../components/StatusBadge";
import { Modal } from "../../../components/Modal";
import { SmartCropImage } from "../../../components/SmartCropImage";

pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

type DetailView = "overview" | "timeline" | "documents" | "llm";

interface DrugRow {
  license_id: string;
  name_zh?: string;
  name_en?: string;
  is_active?: boolean;
  dosage_form?: string;
  manufacturer_name?: string;
  asset_count?: number;
  pipeline_progress?: number;
  has_error?: boolean;
  updated_at?: string;
  thumbnail_url?: string | null;
  statuses?: Record<string, string>;
}

interface ValueFacet { value: string; count: number }
interface ExplorerPayload {
  drugs: DrugRow[];
  pagination: { total: number; page: number; per_page: number; total_pages: number };
  facets: {
    asset_types?: Record<string, number>;
    dosage_form?: ValueFacet[];
    country?: ValueFacet[];
    manufacturer?: ValueFacet[];
    appearance_color?: ValueFacet[];
    appearance_shape?: ValueFacet[];
  };
}

interface AppearanceImage {
  asset_id: string;
  filename: string;
  preview_url: string;
  original_url: string;
  width?: number;
  height?: number;
}
interface Appearance {
  appearance_id: string;
  appearance_no?: string;
  description?: string;
  color?: string;
  shape?: string;
  scoring?: string;
  symbol?: string;
  size?: string;
  imprint?: string;
  images: AppearanceImage[];
}
interface DocumentRow {
  source_asset_id: string;
  asset_type: string;
  source_filename?: string;
  normalized_filename?: string;
  mime_type?: string;
  size_bytes?: number;
  upload_date?: string;
  storage_status?: string;
  ocr_asset_id?: string;
  ocr_filename?: string;
  analysis_asset_id?: string;
  analysis_filename?: string;
  ocr_status?: string;
  analysis_status?: string;
}
interface AssetRow {
  asset_id: string;
  asset_type: string;
  source_filename?: string;
  normalized_filename?: string;
  mime_type?: string;
  size_bytes?: number;
  upload_date?: string;
  storage_status?: string;
}

interface LlmCallSummary {
  id: number;
  created_at?: string | null;
  attempt: number;
  profileName: string;
  model: string;
  provider: string;
  status: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  isJson: boolean;
}
interface LlmCallDetail {
  id: number;
  licenseId: string;
  attempt: number;
  profileName: string;
  model: string;
  provider: string;
  status: string;
  promptMessages: Array<{ role: string; content: string }>;
  responseContent: string;
  error: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  createdAt?: string | null;
}

type AssetPreviewKind = "pdf" | "markdown" | "json" | "image" | "text" | "unsupported";
interface AssetPreviewTab {
  assetId: string;
  kind: AssetPreviewKind;
  label: string;
}
interface AssetViewerState {
  title: string;
  tabs: AssetPreviewTab[];
  initialAssetId: string;
}
interface TimelineEvent {
  event_id?: number;
  stage?: string;
  from_status?: string;
  status?: string;
  error_code?: string;
  error_message?: string;
  created_at?: string;
}
interface TimelineStage {
  stage: string;
  status: string;
  events: TimelineEvent[];
}
interface DrugDetailPayload {
  drug: Record<string, unknown>;
  appearances: Appearance[];
  documents: DocumentRow[];
  assets: AssetRow[];
  timeline: { stages: TimelineStage[]; events: TimelineEvent[] };
}

interface FilterState {
  active: string;
  assetTypes: string[];
  assetMatch: string;
  missingAssetTypes: string[];
  pipelineStatuses: string[];
  stage: string;
  stageStatuses: string[];
  hasError: string;
  manufacturer: string;
  country: string;
  dosageForm: string;
  ingredient: string;
  appearanceColor: string;
  appearanceShape: string;
  updatedFrom: string;
  updatedTo: string;
  documentFrom: string;
  documentTo: string;
}

const ASSETS = [
  ["insert_pdf", "Insert PDF"],
  ["label_pdf", "Label PDF"],
  ["shape_image", "Shape image"],
  ["web_image", "WebP preview"],
  ["ocr_markdown", "OCR Markdown"],
  ["analysis_json", "Analysis JSON"],
] as const;
const STATUSES = ["pending", "success", "partial_success", "retryable_failed", "no_data"];
const STAGES = [
  ["index", "Index"], ["electronic_insert", "Electronic insert"],
  ["insert_pdf", "Insert PDF"], ["label_pdf", "Label PDF"],
  ["shape", "Appearance"], ["storage", "Storage"],
  ["ocr", "OCR"], ["analysis", "Analysis"], ["normalize", "Normalize"],
] as const;

const csv = (value: string | null): string[] => value?.split(",").filter(Boolean) ?? [];
const value = (record: Record<string, unknown>, path: string): string => {
  let current: unknown = record;
  for (const key of path.split(".")) {
    if (!current || typeof current !== "object") return "";
    current = Array.isArray(current)
      ? current[Number(key)]
      : (current as Record<string, unknown>)[key];
  }
  if (current == null) return "";
  return typeof current === "string" ? current : String(current);
};
const listValue = (record: Record<string, unknown>, path: string): string[] => {
  let current: unknown = record;
  for (const key of path.split(".")) {
    if (!current || typeof current !== "object") return [];
    current = Array.isArray(current)
      ? current[Number(key)]
      : (current as Record<string, unknown>)[key];
  }
  if (!Array.isArray(current)) return [];
  return current.map((item) => {
    if (typeof item === "string") return item;
    if (!item || typeof item !== "object" || Array.isArray(item)) return String(item ?? "");
    const row = item as Record<string, unknown>;
    const name = String(row.name ?? row["成分"] ?? "");
    const amount = String(row.amount ?? row["含量"] ?? "");
    const unit = String(row.unit ?? row["單位"] ?? "");
    return [name, [amount, unit].filter(Boolean).join(" ")].filter(Boolean).join(" · ")
      || String(row.raw_text ?? "");
  }).filter(Boolean);
};
const assetUrl = (assetId: string, download = false): string =>
  `/admin/api/drug/asset-content?asset_id=${encodeURIComponent(assetId)}${download ? "&download=true" : ""}`;

function formatBytes(size?: number): string {
  if (size == null) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function readFilters(params: URLSearchParams): FilterState {
  return {
    active: params.get("active") || "active",
    assetTypes: csv(params.get("asset_types")),
    assetMatch: params.get("asset_match") || "all",
    missingAssetTypes: csv(params.get("missing_asset_types")),
    pipelineStatuses: csv(params.get("pipeline_statuses")),
    stage: params.get("stage") || "",
    stageStatuses: csv(params.get("stage_statuses")),
    hasError: params.get("has_error") || "",
    manufacturer: params.get("manufacturer") || "",
    country: params.get("country") || "",
    dosageForm: params.get("dosage_form") || "",
    ingredient: params.get("ingredient") || "",
    appearanceColor: params.get("appearance_color") || "",
    appearanceShape: params.get("appearance_shape") || "",
    updatedFrom: params.get("updated_from") || "",
    updatedTo: params.get("updated_to") || "",
    documentFrom: params.get("document_from") || "",
    documentTo: params.get("document_to") || "",
  };
}

function CheckGroup({
  values, selected, onChange, counts, disabled,
}: {
  values: readonly (readonly [string, string])[];
  selected: string[];
  onChange: (values: string[]) => void;
  counts?: Record<string, number>;
  disabled?: string[];
}): JSX.Element {
  const disabledSet = new Set(disabled ?? []);
  return <div className="drug-filter-checks">
    {values.map(([key, label]) => {
      const isDisabled = disabledSet.has(key);
      return <label key={key} className={isDisabled ? "is-disabled" : undefined}>
        <input type="checkbox" checked={selected.includes(key)} disabled={isDisabled} onChange={(event) =>
          onChange(event.target.checked ? [...selected, key] : selected.filter((item) => item !== key))
        } />
        <span>{label}</span>
        {counts ? <small>{(counts[key] ?? 0).toLocaleString()}</small> : null}
      </label>;
    })}
  </div>;
}

function FilterPanel({
  initial, facets, onApply, onClose,
}: {
  initial: FilterState;
  facets: ExplorerPayload["facets"];
  onApply: (state: FilterState) => void;
  onClose: () => void;
}): JSX.Element {
  const [draft, setDraft] = useState(initial);
  const update = <K extends keyof FilterState>(key: K, next: FilterState[K]): void =>
    setDraft((current) => ({ ...current, [key]: next }));
  return <div className="drug-filter-backdrop" onMouseDown={(event) => {
    if (event.target === event.currentTarget) onClose();
  }}>
    <aside className="drug-filter-panel" aria-label="Drug filters">
      <header>
        <div><Filter size={18} /><strong>Filters</strong></div>
        <button className="icon-btn" type="button" onClick={onClose} aria-label="Close filters"><X size={18} /></button>
      </header>
      <div className="drug-filter-panel__body">
        <fieldset>
          <legend>License status</legend>
          <div className="segmented">
            {["active", "inactive", "all"].map((option) =>
              <button key={option} type="button" className={draft.active === option ? "is-active" : ""}
                onClick={() => update("active", option)}>{option}</button>)}
          </div>
        </fieldset>
        <fieldset>
          <legend>Must have assets</legend>
          <div className="segmented segmented--compact">
            <button type="button" className={draft.assetMatch === "any" ? "is-active" : ""} onClick={() => update("assetMatch", "any")}>Any</button>
            <button type="button" className={draft.assetMatch === "all" ? "is-active" : ""} onClick={() => update("assetMatch", "all")}>All</button>
          </div>
          <CheckGroup values={ASSETS} selected={draft.assetTypes} onChange={(next) => update("assetTypes", next)} counts={facets.asset_types} disabled={draft.missingAssetTypes} />
        </fieldset>
        <fieldset>
          <legend>Must not have assets</legend>
          <CheckGroup values={ASSETS} selected={draft.missingAssetTypes} onChange={(next) => update("missingAssetTypes", next)} counts={facets.asset_types} disabled={draft.assetTypes} />
        </fieldset>
        <fieldset>
          <legend>Any pipeline status</legend>
          <CheckGroup values={STATUSES.map((status) => [status, status.replaceAll("_", " ")] as const)}
            selected={draft.pipelineStatuses} onChange={(next) => update("pipelineStatuses", next)} />
        </fieldset>
        <fieldset>
          <legend>Specific stage</legend>
          <select value={draft.stage} onChange={(event) => update("stage", event.target.value)}>
            <option value="">Any stage</option>
            {STAGES.map(([key, label]) => <option value={key} key={key}>{label}</option>)}
          </select>
          {draft.stage ? <CheckGroup values={STATUSES.map((status) => [status, status.replaceAll("_", " ")] as const)}
            selected={draft.stageStatuses} onChange={(next) => update("stageStatuses", next)} /> : null}
        </fieldset>
        <fieldset>
          <legend>Data quality</legend>
          <select value={draft.hasError} onChange={(event) => update("hasError", event.target.value)}>
            <option value="">Any</option><option value="false">No pipeline error</option><option value="true">Has pipeline error</option>
          </select>
        </fieldset>
        <fieldset className="drug-filter-selects">
          <legend>Drug attributes</legend>
          <label>Dosage form<input list="drug-dosage-forms" value={draft.dosageForm} onChange={(event) => update("dosageForm", event.target.value)} placeholder="e.g. 錠劑, 注射液" />
            <datalist id="drug-dosage-forms">{facets.dosage_form?.map((item) => <option key={item.value} value={item.value}>{item.value} ({item.count})</option>)}</datalist>
          </label>
          <label>Main ingredient<input value={draft.ingredient} onChange={(event) => update("ingredient", event.target.value)} placeholder="e.g. Aspirin, 乙醯胺酚" /></label>
          <label>Country<select value={draft.country} onChange={(event) => update("country", event.target.value)}>
            <option value="">All countries</option>{facets.country?.map((item) => <option key={item.value} value={item.value}>{item.value} ({item.count})</option>)}
          </select></label>
          <label>Manufacturer<input list="drug-manufacturers" value={draft.manufacturer} onChange={(event) => update("manufacturer", event.target.value)} placeholder="e.g. 永信, Pfizer" />
            <datalist id="drug-manufacturers">{facets.manufacturer?.map((item) => <option key={item.value} value={item.value}>{item.value} ({item.count})</option>)}</datalist>
          </label>
          <label>Appearance color<select value={draft.appearanceColor} onChange={(event) => update("appearanceColor", event.target.value)}>
            <option value="">All colors</option>{facets.appearance_color?.map((item) => <option key={item.value} value={item.value}>{item.value} ({item.count})</option>)}
          </select></label>
          <label>Appearance shape<select value={draft.appearanceShape} onChange={(event) => update("appearanceShape", event.target.value)}>
            <option value="">All shapes</option>{facets.appearance_shape?.map((item) => <option key={item.value} value={item.value}>{item.value} ({item.count})</option>)}
          </select></label>
        </fieldset>
        <fieldset className="drug-filter-dates">
          <legend>Date ranges</legend>
          <span>Pipeline updated</span><div><label>From<input type="date" value={draft.updatedFrom} onChange={(event) => update("updatedFrom", event.target.value)} /></label><label>To<input type="date" value={draft.updatedTo} onChange={(event) => update("updatedTo", event.target.value)} /></label></div>
          <span>Document upload date</span><div><label>From<input type="date" value={draft.documentFrom} onChange={(event) => update("documentFrom", event.target.value)} /></label><label>To<input type="date" value={draft.documentTo} onChange={(event) => update("documentTo", event.target.value)} /></label></div>
        </fieldset>
      </div>
      <footer>
        <button type="button" className="btn" onClick={() => setDraft(readFilters(new URLSearchParams()))}>Clear all</button>
        <button type="button" className="btn btn--primary" onClick={() => onApply(draft)}>Apply filters</button>
      </footer>
    </aside>
  </div>;
}

function DrugListItem({ row, selected, onSelect }: { row: DrugRow; selected: boolean; onSelect: () => void }): JSX.Element {
  const status = row.has_error ? "retryable_failed" : row.statuses?.normalize_status || "pending";
  return <button type="button" className={`drug-result ${selected ? "drug-result--selected" : ""}`} onClick={onSelect}>
    <span className="drug-result__thumb">
      {row.thumbnail_url ? <SmartCropImage contain src={row.thumbnail_url} alt="" /> : <ImageIcon size={20} />}
    </span>
    <span className="drug-result__content">
      <span className="drug-result__title">{row.name_zh || row.name_en || "Unnamed drug"}</span>
      {row.name_zh && row.name_en ? <span className="drug-result__sub">{row.name_en}</span> : null}
      <code>{row.license_id}</code>
      <span className="drug-result__meta">
        <StatusBadge status={status} />
        <span>{row.asset_count ?? 0} assets</span>
        <span>{row.pipeline_progress ?? 0}/9 stages</span>
      </span>
    </span>
  </button>;
}

function Fact({ label, content }: { label: string; content: unknown }): JSX.Element | null {
  const text = content == null ? "" : String(content);
  if (!text) return null;
  return <div className="drug-detail-fact"><dt>{label}</dt><dd>{text}</dd></div>;
}

function Overview({ detail }: { detail: DrugDetailPayload }): JSX.Element {
  const drug = detail.drug;
  const normalized = (drug.normalized_record && typeof drug.normalized_record === "object"
    ? drug.normalized_record : {}) as Record<string, unknown>;
  const ingredients = listValue(normalized, "ingredients.active");
  const indications = listValue(normalized, "drug.indications");
  const dosage = listValue(normalized, "usage.dosage_and_administration");
  const images = detail.appearances.flatMap((appearance) => appearance.images.map((image) => ({ image, appearance })));
  return <div className="drug-overview">
    {images.length ? <section className="drug-appearance-band">
      <div className="drug-section-title"><ImageIcon size={18} /><h3>Appearance</h3><span>{images.length} image{images.length === 1 ? "" : "s"}</span></div>
      <div className="drug-image-grid">
        {images.map(({ image, appearance }) => <a key={image.asset_id} href={image.original_url} target="_blank" rel="noreferrer" className="drug-image-item">
          <SmartCropImage src={image.preview_url} alt={appearance.description || String(drug.chinese_name || "Drug appearance")} />
          <span><strong>{appearance.appearance_no || appearance.shape || "Appearance"}</strong><small>{[appearance.color, appearance.shape, appearance.imprint].filter(Boolean).join(" · ")}</small></span>
          <ExternalLink size={15} />
        </a>)}
      </div>
      {detail.appearances.length ? <div className="drug-appearance-specs">
        {detail.appearances.map((appearance) => <dl key={appearance.appearance_id}>
          <Fact label="Appearance" content={appearance.appearance_no || appearance.description} />
          <Fact label="Color" content={appearance.color} /><Fact label="Shape" content={appearance.shape} />
          <Fact label="Scoring" content={appearance.scoring} /><Fact label="Imprint" content={appearance.imprint} />
          <Fact label="Size" content={appearance.size} /><Fact label="Symbol" content={appearance.symbol} />
        </dl>)}
      </div> : null}
    </section> : null}
    <section className="drug-information-band">
      <div className="drug-section-title"><FileText size={18} /><h3>Drug information</h3></div>
      <dl className="drug-detail-facts">
        <Fact label="Chinese name" content={drug.chinese_name || value(normalized, "drug.chinese_name")} />
        <Fact label="English name" content={drug.english_name || value(normalized, "drug.english_name")} />
        <Fact label="Dosage form" content={drug.dosage_form || value(normalized, "drug.dosage_form")} />
        <Fact label="Package" content={drug.package || value(normalized, "drug.package")} />
        <Fact label="Category" content={drug.drug_category} /><Fact label="Valid until" content={String(drug.valid_until || "").slice(0, 10)} />
        <Fact label="Applicant" content={drug.applicant_name} /><Fact label="Manufacturer" content={drug.manufacturer_name} />
        <Fact label="Country" content={drug.manufacturer_country} /><Fact label="Quality" content={drug.quality_confidence} />
      </dl>
    </section>
    <TextSection title="Active ingredients" items={ingredients} />
    <TextSection title="Indications" items={indications.length ? indications : [String(drug.indications_text || "")].filter(Boolean)} />
    <TextSection title="Dosage and administration" items={dosage} />
  </div>;
}

function TextSection({ title, items }: { title: string; items: string[] }): JSX.Element | null {
  if (!items.length) return null;
  return <section className="drug-text-section"><h3>{title}</h3><ul>{items.map((item, index) => <li key={`${title}-${index}`}>{item}</li>)}</ul></section>;
}

const stageLabel = (stage: string): string => STAGES.find(([key]) => stage.startsWith(key))?.[1] ?? stage.replaceAll("_", " ");

function Timeline({ timeline, documents }: { timeline: DrugDetailPayload["timeline"]; documents: DocumentRow[] }): JSX.Element {
  const ocrPair = documents.find((document) => document.source_asset_id && document.ocr_asset_id);
  const [viewer, setViewer] = useState<AssetViewerState | null>(null);

  return <div className="drug-timeline-view">
    <div className="drug-section-title"><Clock3 size={18} /><h3>Process timeline</h3><span>{timeline.events.length} events</span></div>
    <div className="drug-stage-track">
      {timeline.stages.map((stage) => <section key={stage.stage} className={`drug-stage drug-stage--${stage.status}`}>
        <span className="drug-stage__marker" />
        <div className="drug-stage__body">
          <header><strong>{stageLabel(stage.stage)}</strong><StatusBadge status={stage.status} /></header>
          {stage.events.length ? stage.events.map((event) => <div className="drug-stage-event" key={event.event_id ?? `${event.stage}-${event.created_at}`}>
            <span>{event.created_at ? new Date(event.created_at).toLocaleString() : ""}</span>
            {event.from_status ? <small>{event.from_status} → {event.status}</small> : null}
            {event.error_message ? <p>{event.error_message}</p> : null}
          </div>) : <span className="muted small">No recorded transition</span>}
          {stage.stage === "ocr" && ocrPair ? <button type="button" className="btn btn--sm drug-stage__action" onClick={() => setViewer(documentViewer(ocrPair))}><Eye size={15} /> View PDF + OCR</button> : null}
        </div>
      </section>)}
    </div>
    {viewer ? <AssetViewer viewer={viewer} onClose={() => setViewer(null)} /> : null}
  </div>;
}

const assetFilename = (asset: Pick<AssetRow, "source_filename" | "normalized_filename">): string =>
  asset.source_filename || asset.normalized_filename || "Untitled asset";

function inferPreviewKind(asset: Pick<AssetRow, "asset_type" | "source_filename" | "normalized_filename" | "mime_type">): AssetPreviewKind {
  const filename = assetFilename(asset).toLowerCase();
  const mime = asset.mime_type?.toLowerCase() ?? "";
  if (mime === "application/pdf" || filename.endsWith(".pdf")) return "pdf";
  if (asset.asset_type === "ocr_markdown" || filename.endsWith(".md") || filename.endsWith(".markdown")) return "markdown";
  if (asset.asset_type === "analysis_json" || mime.includes("json") || filename.endsWith(".json")) return "json";
  if (mime.startsWith("image/") || /\.(avif|gif|jpe?g|png|webp)$/.test(filename)) return "image";
  if (mime.startsWith("text/") || /\.(csv|log|txt|xml)$/.test(filename)) return "text";
  return "unsupported";
}

function documentViewer(document: DocumentRow, initialAssetId = document.source_asset_id): AssetViewerState {
  const tabs: AssetPreviewTab[] = [{ assetId: document.source_asset_id, kind: "pdf", label: "Source PDF" }];
  if (document.ocr_asset_id) tabs.push({ assetId: document.ocr_asset_id, kind: "markdown", label: "OCR Markdown" });
  if (document.analysis_asset_id) tabs.push({ assetId: document.analysis_asset_id, kind: "json", label: "Analysis JSON" });
  return { title: document.source_filename || document.normalized_filename || "Drug document", tabs, initialAssetId };
}

function Documents({ documents, assets }: { documents: DocumentRow[]; assets: AssetRow[] }): JSX.Element {
  const [viewer, setViewer] = useState<AssetViewerState | null>(null);
  const linked = new Set(documents.flatMap((document) => [document.source_asset_id, document.ocr_asset_id, document.analysis_asset_id].filter(Boolean)));
  const otherAssets = assets.filter((asset) => !linked.has(asset.asset_id));
  return <div className="drug-documents-view">
    <header className="drug-documents-head">
      <div><FileText size={19} /><div><h3>Documents and assets</h3><p>Select a file to open a large preview.</p></div></div>
      <span>{assets.length} files</span>
    </header>
    <section className="drug-file-section">
      <h4>Source documents <span>{documents.length}</span></h4>
      {documents.length ? <div className="drug-file-list">{documents.map((document) => <article className="drug-file-row" key={document.source_asset_id}>
        <button type="button" className="drug-file-row__main" onClick={() => setViewer(documentViewer(document))}>
          <FileText size={20} />
          <span><strong>{document.source_filename || document.normalized_filename || "Untitled document"}</strong>
            <small>{document.asset_type.replaceAll("_", " ")} · {formatBytes(document.size_bytes)}{document.upload_date ? ` · ${document.upload_date.slice(0, 10)}` : ""}</small></span>
        </button>
        <div className="drug-file-row__badges">
          <span className="badge">PDF</span>
          {document.ocr_asset_id ? <span className="badge badge--ok">OCR</span> : null}
          {document.analysis_asset_id ? <span className="badge badge--ok">JSON</span> : null}
        </div>
        <div className="drug-file-row__actions">
          {document.ocr_asset_id ? <button type="button" className="btn btn--sm" onClick={() => setViewer(documentViewer(document, document.ocr_asset_id))}>OCR</button> : null}
          {document.analysis_asset_id ? <button type="button" className="btn btn--sm" onClick={() => setViewer(documentViewer(document, document.analysis_asset_id))}>JSON</button> : null}
          <button type="button" className="icon-btn" onClick={() => setViewer(documentViewer(document))} aria-label="Preview document" title="Preview document"><Eye size={17} /></button>
        </div>
      </article>)}</div> : <div className="drug-empty-inline"><FileText size={22} /><span>No PDF documents were collected.</span></div>}
    </section>
    {otherAssets.length ? <section className="drug-file-section">
      <h4>Other assets <span>{otherAssets.length}</span></h4>
      <div className="drug-file-list">{otherAssets.map((asset) => {
        const preview: AssetViewerState = { title: assetFilename(asset), tabs: [{ assetId: asset.asset_id, kind: inferPreviewKind(asset), label: asset.asset_type.replaceAll("_", " ") }], initialAssetId: asset.asset_id };
        return <article className="drug-file-row" key={asset.asset_id}>
          <button type="button" className="drug-file-row__main" onClick={() => setViewer(preview)}>
            {asset.asset_type === "analysis_json" ? <FileJson size={20} /> : asset.mime_type?.startsWith("image/") ? <ImageIcon size={20} /> : <FileText size={20} />}
            <span><strong>{assetFilename(asset)}</strong><small>{asset.asset_type.replaceAll("_", " ")} · {formatBytes(asset.size_bytes)}</small></span>
          </button>
          <div className="drug-file-row__actions"><button type="button" className="icon-btn" onClick={() => setViewer(preview)} aria-label="Preview asset" title="Preview asset"><Eye size={17} /></button></div>
        </article>;
      })}</div>
    </section> : null}
    {viewer ? <AssetViewer viewer={viewer} onClose={() => setViewer(null)} /> : null}
  </div>;
}

function AssetViewer({ viewer, onClose }: { viewer: AssetViewerState; onClose: () => void }): JSX.Element {
  const [activeId, setActiveId] = useState(viewer.initialAssetId);
  const active = viewer.tabs.find((tab) => tab.assetId === activeId) ?? viewer.tabs[0];
  const pdf = viewer.tabs.find((tab) => tab.kind === "pdf");
  const ocr = viewer.tabs.find((tab) => tab.kind === "markdown");
  const paired = Boolean(pdf && ocr && (active.assetId === pdf.assetId || active.assetId === ocr.assetId));
  const standaloneTabs = viewer.tabs.filter((tab) => tab.assetId !== pdf?.assetId && tab.assetId !== ocr?.assetId);
  return <Modal title={viewer.title} onClose={onClose} workspace panelClassName="drug-asset-viewer-modal">
    <div className="drug-asset-modal">
      <div className="drug-asset-modal__toolbar">
        <div className="segmented" role="tablist" aria-label="Available file formats">
          {pdf && ocr ? <button type="button" role="tab" aria-selected={paired} className={paired ? "is-active" : ""} onClick={() => setActiveId(pdf.assetId)}>PDF + OCR</button> : null}
          {(pdf && !ocr ? [pdf] : ocr && !pdf ? [ocr] : []).concat(standaloneTabs).map((tab) => <button type="button" role="tab" aria-selected={active.assetId === tab.assetId} className={active.assetId === tab.assetId ? "is-active" : ""} key={tab.assetId} onClick={() => setActiveId(tab.assetId)}>{tab.label}</button>)}
        </div>
        <div className="drug-asset-modal__actions">
          {paired && pdf && ocr ? <>
            <a className="btn btn--sm" href={assetUrl(pdf.assetId)} target="_blank" rel="noreferrer" title="Open source PDF in a new tab"><ExternalLink size={16} /><span>PDF</span></a>
            <a className="btn btn--sm" href={assetUrl(pdf.assetId, true)} title="Download source PDF"><Download size={16} /><span>PDF</span></a>
            <a className="btn btn--sm" href={assetUrl(ocr.assetId, true)} title="Download OCR Markdown"><Download size={16} /><span>OCR</span></a>
          </> : <>
            <a className="icon-btn" href={assetUrl(active.assetId)} target="_blank" rel="noreferrer" aria-label="Open file in a new tab" title="Open file in a new tab"><ExternalLink size={17} /></a>
            <a className="icon-btn" href={assetUrl(active.assetId, true)} aria-label="Download file" title="Download file"><Download size={17} /></a>
          </>}
        </div>
      </div>
      <div className="drug-asset-modal__preview">
        {paired && pdf && ocr ? <div className="drug-paired-preview">
          <section><header>Source PDF</header><PdfPreview assetId={pdf.assetId} /></section>
          <section><header>OCR Markdown</header><MarkdownPreview assetId={ocr.assetId} /></section>
        </div> : <AssetPreview asset={active} />}
      </div>
    </div>
  </Modal>;
}

function AssetPreview({ asset }: { asset: AssetPreviewTab }): JSX.Element {
  if (asset.kind === "pdf") return <PdfPreview assetId={asset.assetId} />;
  if (asset.kind === "markdown") return <MarkdownPreview assetId={asset.assetId} />;
  if (asset.kind === "json" || asset.kind === "text") return <TextPreview assetId={asset.assetId} json={asset.kind === "json"} />;
  if (asset.kind === "image") return <div className="drug-image-preview"><SmartCropImage contain src={assetUrl(asset.assetId)} alt="Drug asset" /></div>;
  return <div className="drug-document-loading">This file type cannot be previewed. Open it in a new tab or download the original file.</div>;
}

function TextPreview({ assetId, json }: { assetId: string; json: boolean }): JSX.Element {
  const textQ = useQuery({
    queryKey: [json ? "drug-asset-json" : "drug-asset-text", assetId],
    queryFn: async ({ signal }) => {
      const response = await fetch(assetUrl(assetId), { credentials: "same-origin", signal });
      if (!response.ok) throw new Error(`Unable to load file (${response.status})`);
      const text = await response.text();
      if (!json) return text;
      try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
    },
    staleTime: 5 * 60_000,
  });
  if (textQ.isPending) return <div className="drug-document-loading">Loading file...</div>;
  if (textQ.isError) return <div className="drug-document-error">{String(textQ.error)}</div>;
  return <pre className="drug-text-preview">{textQ.data}</pre>;
}

function PdfPreview({ assetId }: { assetId: string }): JSX.Element {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [pageNumber, setPageNumber] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [zoom, setZoom] = useState(1);
  const source = useMemo(() => ({ url: assetUrl(assetId), withCredentials: true }), [assetId]);

  useEffect(() => {
    setPageNumber(1);
    setPageCount(0);
    setZoom(1);
  }, [assetId]);
  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const update = (): void => setViewportWidth(element.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const fittedWidth = Math.max(220, viewportWidth - 28);
  return <div className="drug-pdf-viewer">
    <div className="drug-pdf-toolbar">
      <button type="button" className="icon-btn" disabled={pageNumber <= 1} onClick={() => setPageNumber((page) => page - 1)} aria-label="Previous PDF page"><ChevronLeft size={16} /></button>
      <span>Page <strong>{pageNumber}</strong> / {pageCount || "-"}</span>
      <button type="button" className="icon-btn" disabled={!pageCount || pageNumber >= pageCount} onClick={() => setPageNumber((page) => page + 1)} aria-label="Next PDF page"><ChevronRight size={16} /></button>
      <span className="drug-pdf-toolbar__spacer" />
      <button type="button" className="icon-btn" disabled={zoom <= .75} onClick={() => setZoom((value) => Math.max(.75, value - .25))} aria-label="Zoom out"><ZoomOut size={16} /></button>
      <span>{Math.round(zoom * 100)}%</span>
      <button type="button" className="icon-btn" disabled={zoom >= 2} onClick={() => setZoom((value) => Math.min(2, value + .25))} aria-label="Zoom in"><ZoomIn size={16} /></button>
    </div>
    <div className="drug-pdf-canvas" ref={viewportRef}>
      <PdfDocument
        file={source}
        loading={<div className="drug-document-loading">Loading PDF...</div>}
        error={<div className="drug-document-error">Unable to display this PDF. Use the PDF download button to open the original.</div>}
        onLoadSuccess={({ numPages }: { numPages: number }) => {
          setPageCount(numPages);
          setPageNumber((page) => Math.min(page, numPages));
        }}
      >
        <PdfPage pageNumber={pageNumber} width={Math.round(fittedWidth * zoom)} />
      </PdfDocument>
    </div>
  </div>;
}

function MarkdownPreview({ assetId }: { assetId: string }): JSX.Element {
  const markdownQ = useQuery({
    queryKey: ["drug-asset-markdown", assetId],
    queryFn: async ({ signal }) => {
      const response = await fetch(assetUrl(assetId), { credentials: "same-origin", signal });
      if (response.status === 401) {
        window.location.href = "/admin/login";
        throw new Error("Authentication required");
      }
      if (!response.ok) throw new Error(`Unable to load OCR (${response.status})`);
      return response.text();
    },
    staleTime: 5 * 60_000,
  });
  if (markdownQ.isPending) return <div className="drug-markdown-state">Loading OCR...</div>;
  if (markdownQ.isError) return <div className="drug-markdown-state drug-markdown-state--error">{String(markdownQ.error)}</div>;
  if (!markdownQ.data.trim()) return <div className="drug-markdown-state">OCR output is empty.</div>;
  return <div className="drug-markdown-preview">
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeRaw, rehypeSanitize]}
      components={{
        a: ({ children, ...props }) => <a {...props} target="_blank" rel="noreferrer">{children}</a>,
      }}
    >{markdownQ.data}</ReactMarkdown>
  </div>;
}

const formatCallTokens = (summary: { promptTokens: number; completionTokens: number; latencyMs: number }): string =>
  `${(summary.promptTokens + summary.completionTokens).toLocaleString()} tokens · ${summary.latencyMs}ms`;

/** Plain-text or pretty-printed JSON viewer for a stored LLM reply. */
function LlmContentPane({ content, isJson }: { content: string; isJson: boolean }): JSX.Element {
  if (!content.trim()) return <div className="drug-document-state">No output was returned.</div>;
  const pretty = isJson ? (() => {
    try { return JSON.stringify(JSON.parse(content), null, 2); } catch { return content; }
  })() : content;
  return <div className="drug-llm-content">
    {isJson ? <span className="badge badge--ok drug-llm-content__badge">JSON output</span> : null}
    <pre className="drug-text-preview">{pretty}</pre>
  </div>;
}

function LlmCallModal({ callId, onClose }: { callId: number; onClose: () => void }): JSX.Element {
  const detailQ = useQuery({
    queryKey: ["drug-llm-call", callId],
    queryFn: () => api.get<LlmCallDetail>(`/admin/api/drug/llm-call?id=${callId}`),
  });
  const [tab, setTab] = useState<"system" | "user" | "response">("response");
  if (detailQ.isPending) return <Modal title="LLM call" onClose={onClose} workspace panelClassName="drug-llm-modal"><div className="drug-detail-loading">Loading LLM call...</div></Modal>;
  if (detailQ.isError || !detailQ.data) {
    return <Modal title="LLM call" onClose={onClose} workspace panelClassName="drug-llm-modal"><div className="error-box">Failed to load LLM call: {String(detailQ.error)}</div></Modal>;
  }
  const call = detailQ.data;
  const system = call.promptMessages.find((message) => message.role === "system")?.content ?? "";
  const user = call.promptMessages.find((message) => message.role === "user")?.content ?? "";
  const isJson = (() => {
    try { JSON.parse(call.responseContent); return true; } catch { return false; }
  })();
  return <Modal title={`LLM call · ${call.profileName || call.model || "analysis"} · attempt ${call.attempt}`} onClose={onClose} workspace panelClassName="drug-llm-modal">
    <div className="drug-llm-modal__head">
      <div className="drug-llm-modal__facts">
        <StatusBadge status={call.status} />
        <span>{new Date(call.createdAt ?? "").toLocaleString()}</span>
        <span>{call.model || call.profileName}</span>
        <span>{formatCallTokens(call)}</span>
      </div>
      {call.error ? <p className="drug-llm-modal__error">{call.error}</p> : null}
    </div>
    <div className="segmented" role="tablist" aria-label="LLM call parts">
      <button type="button" role="tab" aria-selected={tab === "system"} className={tab === "system" ? "is-active" : ""} onClick={() => setTab("system")}>System prompt</button>
      <button type="button" role="tab" aria-selected={tab === "user"} className={tab === "user" ? "is-active" : ""} onClick={() => setTab("user")}>User prompt</button>
      <button type="button" role="tab" aria-selected={tab === "response"} className={tab === "response" ? "is-active" : ""} onClick={() => setTab("response")}>Response{isJson ? " (JSON)" : ""}</button>
    </div>
    <div className="drug-llm-modal__body">
      {tab === "system" ? <LlmContentPane content={system} isJson={false} /> : null}
      {tab === "user" ? <LlmContentPane content={user} isJson={false} /> : null}
      {tab === "response" ? <LlmContentPane content={call.responseContent} isJson={isJson} /> : null}
    </div>
  </Modal>;
}

function LlmCalls({ licenseId }: { licenseId: string }): JSX.Element {
  const [selected, setSelected] = useState<number | null>(null);
  const listQ = useQuery({
    queryKey: ["drug-llm-calls", licenseId],
    queryFn: () => api.get<{ calls: LlmCallSummary[] }>(`/admin/api/drug/llm-calls?license_id=${encodeURIComponent(licenseId)}`),
  });
  if (listQ.isPending) return <div className="drug-detail-loading">Loading LLM calls...</div>;
  if (listQ.isError) return <div className="error-box">Failed to load LLM calls: {String(listQ.error)}</div>;
  const calls = listQ.data.calls;
  return <div className="drug-llm-view">
    <div className="drug-section-title"><Cpu size={18} /><h3>LLM calls</h3><span>{calls.length} calls</span></div>
    {calls.length ? <div className="drug-llm-list">{calls.map((call) => <button type="button" key={call.id} className="drug-llm-row" onClick={() => setSelected(call.id)}>
      <span className="drug-llm-row__meta">
        <strong>{call.profileName || call.model || "Analysis LM"}</strong>
        <small>{new Date(call.created_at ?? "").toLocaleString()}{call.attempt > 1 ? ` · attempt ${call.attempt}` : ""}</small>
      </span>
      <span className="drug-llm-row__tokens">{formatCallTokens(call)}</span>
      {call.isJson ? <span className="badge badge--ok">JSON</span> : null}
      <StatusBadge status={call.status} />
    </button>)}</div> : <div className="drug-empty-inline"><Cpu size={22} /><span>No LLM calls recorded for this drug yet.</span></div>}
    {selected !== null ? <LlmCallModal callId={selected} onClose={() => setSelected(null)} /> : null}
  </div>;
}

function DrugDetail({ licenseId, view, onView, onBack, onExit }: { licenseId: string; view: DetailView; onView: (view: DetailView) => void; onBack: () => void; onExit: () => void }): JSX.Element {
  const detailQ = useQuery({
    queryKey: qk.drugExplorerDetail(licenseId),
    queryFn: () => api.get<DrugDetailPayload>(`/admin/api/drug/explorer-detail?license_id=${encodeURIComponent(licenseId)}`),
  });
  if (detailQ.isPending) return <div className="drug-detail-loading">Loading drug details...</div>;
  if (detailQ.isError) return <div className="error-box">Failed to load drug: {String(detailQ.error)}</div>;
  const detail = detailQ.data;
  const drug = detail.drug;
  return <article className="drug-detail">
    <header className="drug-detail-head">
      <button type="button" className="icon-btn drug-detail-back" onClick={onBack} aria-label="Back to drug results"><ArrowLeft size={19} /></button>
      <div className="drug-detail-head__identity">
        <code>{licenseId}</code><h2>{String(drug.chinese_name || drug.english_name || "Unnamed drug")}</h2>
        {drug.chinese_name && drug.english_name ? <p>{String(drug.english_name)}</p> : null}
      </div>
      <div className="drug-detail-head__actions">
        <button type="button" className="btn btn--sm drug-detail-exit" onClick={onExit}><ArrowLeft size={16} /> Drug index</button>
        <StatusBadge status={drug.is_active ? "success" : "inactive"} />
        <a className="btn btn--primary" href={String(drug.tfda_url)} target="_blank" rel="noreferrer"><ExternalLink size={16} /> Open in TFDA</a>
      </div>
    </header>
    <nav className="drug-detail-tabs" aria-label="Drug detail views">
      {(["overview", "timeline", "documents", "llm"] as const).map((tab) => <button type="button" key={tab}
        className={view === tab ? "is-active" : ""} onClick={() => onView(tab)}>
        {tab === "overview" ? <ImageIcon size={16} /> : tab === "timeline" ? <Clock3 size={16} /> : tab === "documents" ? <FileText size={16} /> : <Cpu size={16} />}
        {tab === "timeline" ? "Process timeline" : tab === "llm" ? "LLM calls" : tab[0].toUpperCase() + tab.slice(1)}
      </button>)}
    </nav>
    <div className="drug-detail-body">
      {view === "overview" ? <Overview detail={detail} /> : null}
      {view === "timeline" ? <Timeline timeline={detail.timeline} documents={detail.documents} /> : null}
      {view === "documents" ? <Documents documents={detail.documents} assets={detail.assets} /> : null}
      {view === "llm" ? <LlmCalls licenseId={licenseId} /> : null}
    </div>
  </article>;
}

export function DrugExplorerPage(): JSX.Element {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [searchInput, setSearchInput] = useState(params.get("q") || "");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filters = useMemo(() => readFilters(params), [params]);
  const selectedLicense = params.get("license") || "";
  const view = (["overview", "timeline", "documents", "llm"].includes(params.get("view") || "") ? params.get("view") : "overview") as DetailView;

  // Live, debounced search: typing in the box filters without pressing Enter.
  useEffect(() => {
    const q = searchInput.trim();
    if (!q || q === params.get("q")) return;
    const timer = setTimeout(() => setParam("q", q, true), 400);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const apiParams = useMemo(() => {
    const next = new URLSearchParams(params);
    next.delete("license"); next.delete("view");
    return next;
  }, [params]);
  const explorerQ = useQuery({
    queryKey: qk.drugExplorer(apiParams.toString()),
    queryFn: () => api.get<ExplorerPayload>(`/admin/api/drug/explorer?${apiParams.toString()}`),
    placeholderData: keepPreviousData,
  });
  const drugs = explorerQ.data?.drugs ?? [];

  useEffect(() => {
    if (!selectedLicense && drugs.length && !window.matchMedia("(max-width: 767px)").matches) {
      const next = new URLSearchParams(params); next.set("license", drugs[0].license_id); setParams(next, { replace: true });
    }
  }, [drugs, params, selectedLicense, setParams]);

  const setParam = (key: string, nextValue: string, resetPage = false): void => {
    const next = new URLSearchParams(params);
    if (nextValue) next.set(key, nextValue); else next.delete(key);
    if (resetPage) next.delete("page");
    setParams(next);
  };
  const applyFilters = (nextFilters: FilterState): void => {
    const next = new URLSearchParams(params);
    const fields: Array<[string, string]> = [
      ["active", nextFilters.active], ["asset_types", nextFilters.assetTypes.join(",")],
      ["asset_match", nextFilters.assetMatch], ["missing_asset_types", nextFilters.missingAssetTypes.join(",")],
      ["pipeline_statuses", nextFilters.pipelineStatuses.join(",")], ["stage", nextFilters.stage],
      ["stage_statuses", nextFilters.stageStatuses.join(",")], ["has_error", nextFilters.hasError],
      ["manufacturer", nextFilters.manufacturer], ["country", nextFilters.country], ["dosage_form", nextFilters.dosageForm],
      ["ingredient", nextFilters.ingredient],
      ["appearance_color", nextFilters.appearanceColor], ["appearance_shape", nextFilters.appearanceShape],
      ["updated_from", nextFilters.updatedFrom], ["updated_to", nextFilters.updatedTo],
      ["document_from", nextFilters.documentFrom], ["document_to", nextFilters.documentTo],
    ];
    for (const [key, entry] of fields) entry && !(key === "active" && entry === "active") && !(key === "asset_match" && entry === "any") ? next.set(key, entry) : next.delete(key);
    next.delete("page"); next.delete("license"); setParams(next); setFiltersOpen(false);
  };
  const clearFilters = (): void => {
    const next = new URLSearchParams();
    const q = params.get("q"); if (q) next.set("q", q);
    const sort = params.get("sort"); if (sort) next.set("sort", sort);
    setParams(next);
  };
  const removeFilter = (key: string, item?: string): void => {
    const next = new URLSearchParams(params);
    if (item) {
      const remaining = csv(next.get(key)).filter((entry) => entry !== item);
      if (remaining.length) next.set(key, remaining.join(",")); else next.delete(key);
    } else {
      next.delete(key);
      if (key === "stage") next.delete("stage_statuses");
    }
    next.delete("page"); next.delete("license"); setParams(next);
  };
  const filterCount = [filters.active !== "active", filters.assetTypes.length > 0, filters.missingAssetTypes.length > 0,
    filters.pipelineStatuses.length > 0, Boolean(filters.stage), Boolean(filters.hasError), Boolean(filters.manufacturer),
    Boolean(filters.country), Boolean(filters.dosageForm), Boolean(filters.ingredient),
    Boolean(filters.appearanceColor), Boolean(filters.appearanceShape),
    Boolean(filters.updatedFrom || filters.updatedTo), Boolean(filters.documentFrom || filters.documentTo)].filter(Boolean).length;
  const assetName = (key: string): string => ASSETS.find(([asset]) => asset === key)?.[1] ?? key;
  const filterChips: Array<{ key: string; item?: string; label: string }> = [
    ...(filters.active !== "active" ? [{ key: "active", label: `License: ${filters.active}` }] : []),
    ...filters.assetTypes.map((item) => ({ key: "asset_types", item, label: `Has ${assetName(item)}` })),
    ...filters.missingAssetTypes.map((item) => ({ key: "missing_asset_types", item, label: `Missing ${assetName(item)}` })),
    ...filters.pipelineStatuses.map((item) => ({ key: "pipeline_statuses", item, label: `Status: ${item.replaceAll("_", " ")}` })),
    ...(filters.stage ? [{ key: "stage", label: `${stageLabel(filters.stage)}: ${filters.stageStatuses.map((status) => status.replaceAll("_", " ")).join(" or ") || "any"}` }] : []),
    ...(filters.hasError ? [{ key: "has_error", label: filters.hasError === "true" ? "Has pipeline error" : "No pipeline error" }] : []),
    ...(filters.dosageForm ? [{ key: "dosage_form", label: `Dosage: ${filters.dosageForm}` }] : []),
    ...(filters.country ? [{ key: "country", label: `Country: ${filters.country}` }] : []),
    ...(filters.manufacturer ? [{ key: "manufacturer", label: `Manufacturer: ${filters.manufacturer}` }] : []),
    ...(filters.ingredient ? [{ key: "ingredient", label: `Ingredient: ${filters.ingredient}` }] : []),
    ...(filters.appearanceColor ? [{ key: "appearance_color", label: `Color: ${filters.appearanceColor}` }] : []),
    ...(filters.appearanceShape ? [{ key: "appearance_shape", label: `Shape: ${filters.appearanceShape}` }] : []),
    ...(filters.updatedFrom ? [{ key: "updated_from", label: `Updated from ${filters.updatedFrom}` }] : []),
    ...(filters.updatedTo ? [{ key: "updated_to", label: `Updated to ${filters.updatedTo}` }] : []),
    ...(filters.documentFrom ? [{ key: "document_from", label: `Document from ${filters.documentFrom}` }] : []),
    ...(filters.documentTo ? [{ key: "document_to", label: `Document to ${filters.documentTo}` }] : []),
  ];
  const pagination = explorerQ.data?.pagination;

  return <Modal title="Drug Explorer" onClose={() => navigate("/modules/drug")} workspace panelClassName="drug-explorer-modal">
    <div className={`drug-explorer ${selectedLicense ? "drug-explorer--has-selection" : ""}`}>
      <div className="drug-explorer-toolbar">
      <form onSubmit={(event: FormEvent) => { event.preventDefault(); setParam("q", searchInput.trim(), true); }}>
        <Search size={18} /><input value={searchInput} onChange={(event) => setSearchInput(event.target.value)} placeholder="License, drug, ingredient, manufacturer" />
        {searchInput ? <button type="button" className="icon-btn" onClick={() => { setSearchInput(""); setParam("q", "", true); }} aria-label="Clear search"><X size={16} /></button> : null}
      </form>
      <button type="button" className="btn drug-filter-button" aria-label={filterCount ? `Filters, ${filterCount} active` : "Filters"} onClick={() => setFiltersOpen(true)}><Filter size={17} /><span className="drug-filter-label">Filters</span>{filterCount ? <span className="drug-filter-count">{filterCount}</span> : null}</button>
      <label className="drug-sort"><ArrowUpDown size={17} /><select value={params.get("sort") || "work_priority"} onChange={(event) => setParam("sort", event.target.value, true)}>
        <option value="work_priority">Work priority</option><option value="relevance">Relevance</option>
        <option value="updated_at">Recently updated</option><option value="name_zh">Chinese name</option>
        <option value="name_en">English name</option><option value="license_id">License ID</option>
        <option value="asset_count">Most assets</option><option value="latest_document">Latest document</option>
        <option value="pipeline_progress">Pipeline progress</option><option value="failed_first">Failed first</option>
        <option value="missing_data">Missing data</option>
      </select></label>
      <button type="button" className="icon-btn drug-order" onClick={() => setParam("order", params.get("order") === "asc" ? "desc" : "asc", true)}
        aria-label="Reverse sort order" title="Reverse sort order"><ArrowDownAZ size={18} /></button>
    </div>
    {filterCount ? <div className="drug-active-filters"><div>{filterChips.map((chip) => <button type="button" key={`${chip.key}-${chip.item || chip.label}`} onClick={() => removeFilter(chip.key, chip.item)}>{chip.label}<X size={13} /></button>)}</div><button type="button" className="drug-active-filters__clear" onClick={clearFilters}>Clear all</button></div> : null}
    <div className="drug-explorer-workspace">
      <aside className="drug-results-pane">
        <div className="drug-results-summary"><strong>{(pagination?.total ?? 0).toLocaleString()} drugs</strong><span>Page {pagination?.page ?? 1} of {pagination?.total_pages ?? 1}</span></div>
        <div className="drug-results-list">
          {explorerQ.isPending ? <div className="drug-list-message">Loading drugs...</div> : explorerQ.isError ? <div className="error-box">{String(explorerQ.error)}</div> :
            drugs.length ? drugs.map((row) => <DrugListItem key={row.license_id} row={row} selected={row.license_id === selectedLicense}
              onSelect={() => setParam("license", row.license_id)} />) : <div className="drug-list-message"><Search size={24} /><strong>No matching drugs</strong><span>Change or clear the current filters.</span></div>}
        </div>
        <div className="drug-results-pager">
          <button type="button" className="icon-btn" disabled={(pagination?.page ?? 1) <= 1} onClick={() => setParam("page", String((pagination?.page ?? 1) - 1))} aria-label="Previous page"><ChevronLeft size={18} /></button>
          <select value={params.get("per_page") || "25"} onChange={(event) => setParam("per_page", event.target.value, true)}><option>25</option><option>50</option><option>100</option></select>
          <button type="button" className="icon-btn" disabled={(pagination?.page ?? 1) >= (pagination?.total_pages ?? 1)} onClick={() => setParam("page", String((pagination?.page ?? 1) + 1))} aria-label="Next page"><ChevronRight size={18} /></button>
        </div>
      </aside>
      <main className="drug-detail-pane">
        {selectedLicense ? <DrugDetail licenseId={selectedLicense} view={view} onView={(nextView) => setParam("view", nextView)} onBack={() => setParam("license", "")} onExit={() => navigate("/modules/drug")} /> :
          <div className="drug-empty-detail"><Search size={30} /><strong>Select a drug</strong></div>}
      </main>
    </div>
      {filtersOpen ? <FilterPanel initial={filters} facets={explorerQ.data?.facets ?? {}} onApply={applyFilters} onClose={() => setFiltersOpen(false)} /> : null}
    </div>
  </Modal>;
}
