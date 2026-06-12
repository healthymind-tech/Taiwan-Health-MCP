// Drug data explorer: paginated license list plus license detail, crawler
// assets, event history, and inline PDF/image/JSON/Markdown preview.

import { FormEvent, useEffect, useMemo, useState } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { api } from "../../../lib/api";
import { qk } from "../../../lib/queryKeys";
import { formatRelative } from "../../../lib/time";
import { Modal } from "../../../components/Modal";
import { StatusBadge } from "../../../components/StatusBadge";
import type {
  DrugAsset,
  DrugAssetsPayload,
  DrugDetailsPayload,
  DrugEvent,
} from "../../../lib/types";

const DEFAULT_PER_PAGE = 25;

type AssetGroup = "all" | "insert" | "label" | "shape" | "analysis";
type CenterTab = "record" | "events" | "assets";
type PreviewMode = "normalized" | "asset";

interface LicenseStatuses {
  index_status?: string;
  electronic_insert_status?: string;
  insert_pdf_status?: string;
  label_pdf_status?: string;
  shape_status?: string;
  storage_status?: string;
  ocr_status?: string;
  analysis_status?: string;
  normalize_status?: string;
}

interface LicenseRow {
  license_id: string;
  name_zh?: string;
  name_en?: string;
  is_active?: boolean;
  queue_status?: string;
  queue_reason?: string;
  attempt_count?: number;
  asset_count?: number;
  statuses?: LicenseStatuses;
  last_error_code?: string;
  last_error_message?: string;
  updated_at?: string;
  last_event?: {
    stage?: string;
    status?: string;
    error_message?: string;
    created_at?: string;
  };
}

interface DrugStatusPayload {
  summary?: {
    total_licenses?: number;
    active_licenses?: number;
    queue_counts?: Record<string, number>;
    state_counts?: Record<string, number>;
  };
  licenses?: LicenseRow[];
  recent_events?: Array<Record<string, unknown>>;
  pagination?: {
    total?: number;
    page?: number;
    per_page?: number;
    total_pages?: number;
  };
}

function formatBytes(n: number | null | undefined): string {
  if (n == null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function textValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function rawRecordAt(record: Record<string, unknown> | undefined, path: string): unknown {
  if (!record) return "";
  let current: unknown = record;
  for (const key of path.split(".")) {
    if (Array.isArray(current) && /^\d+$/.test(key)) {
      current = current[Number(key)];
    } else if (current && typeof current === "object" && key in current) {
      current = (current as Record<string, unknown>)[key];
    } else {
      return "";
    }
  }
  return current;
}

function recordAt(record: Record<string, unknown> | undefined, path: string): string {
  return textValue(rawRecordAt(record, path));
}

function arrayAt(record: Record<string, unknown> | undefined, path: string): unknown[] {
  const value = rawRecordAt(record, path);
  return Array.isArray(value) ? value : [];
}

function stringListAt(record: Record<string, unknown> | undefined, path: string): string[] {
  return arrayAt(record, path).map(textValue).filter(Boolean);
}

function objectValue(item: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = textValue(item[key]);
    if (value) return value;
  }
  return "";
}

function ingredientLabels(items: unknown[]): string[] {
  return items
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return textValue(item);
      const row = item as Record<string, unknown>;
      const name = objectValue(row, "name", "成分");
      const amount = objectValue(row, "amount", "含量");
      const unit = objectValue(row, "unit", "單位");
      const rawText = objectValue(row, "raw_text");
      const dose = [amount, unit].filter(Boolean).join(" ");
      return [name, dose].filter(Boolean).join(" · ") || rawText || textValue(item);
    })
    .filter(Boolean);
}

function firstValue(...values: string[]): string {
  return values.find((value) => value.trim()) || "";
}

function assetLabel(asset: DrugAsset): string {
  return asset.source_filename || asset.normalized_filename || asset.asset_type || asset.asset_id;
}

function assetGroupLabel(group: string | undefined): string {
  switch (group) {
    case "insert":
      return "Insert PDF";
    case "label":
      return "Label PDF";
    case "shape":
      return "Shape image";
    case "analysis":
      return "OCR / analysis";
    default:
      return group || "Asset";
  }
}

function isImage(asset: DrugAsset | null): boolean {
  const mime = (asset?.mime_type || "").toLowerCase();
  const name = assetLabel(asset || ({} as DrugAsset)).toLowerCase();
  return mime.startsWith("image/") || /\.(png|jpe?g|gif|webp)$/i.test(name);
}

function isPdf(asset: DrugAsset | null): boolean {
  const mime = (asset?.mime_type || "").toLowerCase();
  const name = assetLabel(asset || ({} as DrugAsset)).toLowerCase();
  return mime.includes("pdf") || name.endsWith(".pdf");
}

function isTextLike(asset: DrugAsset | null): boolean {
  const mime = (asset?.mime_type || "").toLowerCase();
  const name = assetLabel(asset || ({} as DrugAsset)).toLowerCase();
  return (
    mime.startsWith("text/") ||
    mime.includes("json") ||
    name.endsWith(".json") ||
    name.endsWith(".md") ||
    name.endsWith(".txt")
  );
}

function statusText(status?: string): string {
  return status || "pending";
}

function StatusLine({
  label,
  status,
}: {
  label: string;
  status?: string;
}): JSX.Element {
  return (
    <div className="drug-preview-status">
      <span>{label}</span>
      <StatusBadge status={statusText(status)} />
    </div>
  );
}

function Fact({ label, value }: { label: string; value?: string | number }): JSX.Element {
  return (
    <div className="drug-preview-fact">
      <span className="drug-preview-fact__label">{label}</span>
      <span className="drug-preview-fact__value">{value || "—"}</span>
    </div>
  );
}

function SummaryPill({ label, value }: { label: string; value: number | undefined }): JSX.Element {
  return (
    <span>
      {label}: {(value ?? 0).toLocaleString()}
    </span>
  );
}

function PreviewList({
  title,
  items,
}: {
  title: string;
  items: string[];
}): JSX.Element {
  return (
    <section className="drug-normalized-section">
      <h5>{title}</h5>
      {items.length > 0 ? (
        <ul>
          {items.map((item, idx) => (
            <li key={`${title}-${idx}`}>{item}</li>
          ))}
        </ul>
      ) : (
        <span className="muted small">No data</span>
      )}
    </section>
  );
}

function NormalizedRecordPreview({
  licenseId,
  record,
  availability,
  documentsSummary,
  isLoading,
  error,
  onShowAssets,
}: {
  licenseId: string | null;
  record?: Record<string, unknown>;
  availability: LicenseStatuses | Record<string, string | undefined>;
  documentsSummary?: Record<string, number>;
  isLoading: boolean;
  error?: string;
  onShowAssets: () => void;
}): JSX.Element {
  if (!licenseId) {
    return (
      <div className="drug-preview-empty">
        <strong>No license selected</strong>
        <span>Choose a license from the left panel.</span>
      </div>
    );
  }
  if (isLoading) {
    return (
      <div className="drug-preview-empty">
        <strong>Loading normalized record</strong>
        <span>Fetching the latest database record.</span>
      </div>
    );
  }
  if (error) {
    return (
      <div className="drug-preview-empty">
        <strong>Normalized record unavailable</strong>
        <span>{error}</span>
      </div>
    );
  }
  if (!record) {
    return (
      <div className="drug-preview-empty">
        <strong>No normalized record</strong>
        <span>This license has no normalized database record yet.</span>
      </div>
    );
  }

  const chineseName = recordAt(record, "drug.chinese_name");
  const englishName = recordAt(record, "drug.english_name");
  const manufacturerName = firstValue(
    recordAt(record, "companies.manufacturers.0.name"),
    recordAt(record, "manufacturer.name"),
  );
  const manufacturerCountry = firstValue(
    recordAt(record, "companies.manufacturers.0.country"),
    recordAt(record, "manufacturer.country"),
  );
  const issueDate = recordAt(record, "record_status.issue_date");
  const validUntil = recordAt(record, "record_status.valid_until");
  const normalizedAt = firstValue(
    recordAt(record, "source.normalized_at"),
    recordAt(record, "metadata.normalized_at"),
  );
  const primarySource = firstValue(
    recordAt(record, "source.primary_insert_source"),
    recordAt(record, "metadata.primary_insert_source"),
  );
  const activeIngredients = ingredientLabels(arrayAt(record, "ingredients.active"));
  const inactiveIngredients = ingredientLabels(arrayAt(record, "ingredients.inactive"));
  const indications = stringListAt(record, "drug.indications");
  const purpose = stringListAt(record, "usage.purpose");
  const dosage = stringListAt(record, "usage.dosage_and_administration");
  const precautions = stringListAt(record, "safety.precautions");
  const contraindications = stringListAt(record, "safety.contraindications");
  const missingFields = stringListAt(record, "quality.missing_fields");
  const sourceErrors = stringListAt(record, "source.errors");

  return (
    <div className="drug-normalized">
      <div className="drug-normalized__head">
        <div>
          <span className="drug-normalized__eyebrow">Final normalized record</span>
          <strong>{chineseName || englishName || licenseId}</strong>
          <div className="muted small">{licenseId}</div>
        </div>
        <StatusBadge status={availability.normalize_status || "success"} />
      </div>

      <div className="drug-normalized__body">
        <div className="drug-normalized-facts">
          <Fact label="Chinese name" value={chineseName} />
          <Fact label="English name" value={englishName} />
          <Fact label="Dosage form" value={recordAt(record, "drug.dosage_form")} />
          <Fact label="Package" value={recordAt(record, "drug.package")} />
          <Fact label="Manufacturer" value={manufacturerName} />
          <Fact label="Country" value={manufacturerCountry} />
          <Fact label="Issue date" value={issueDate} />
          <Fact label="Valid until" value={validUntil} />
          <Fact label="Primary source" value={primarySource} />
          <Fact label="Normalized at" value={normalizedAt} />
          <Fact label="Insert PDFs" value={documentsSummary?.insert_pdf_count ?? 0} />
          <Fact label="Label PDFs" value={documentsSummary?.label_pdf_count ?? 0} />
        </div>

        <div className="drug-normalized-docs">
          <div>
            <strong>Source documents</strong>
            <span className="muted small">Crawler assets are available in the Assets tab.</span>
          </div>
          <button type="button" className="btn btn--sm" onClick={onShowAssets}>
            Assets
          </button>
        </div>

        <div className="drug-preview-status-grid drug-preview-status-grid--compact">
          <StatusLine label="Index" status={availability.index_status} />
          <StatusLine label="Storage" status={availability.storage_status} />
          <StatusLine label="OCR" status={availability.ocr_status} />
          <StatusLine label="Analysis" status={availability.analysis_status} />
          <StatusLine label="Normalize" status={availability.normalize_status} />
        </div>

        <PreviewList title="Active ingredients" items={activeIngredients} />
        <PreviewList title="Inactive ingredients" items={inactiveIngredients} />
        <PreviewList title="Indications" items={indications.length ? indications : purpose} />
        <PreviewList title="Dosage and administration" items={dosage} />
        <PreviewList title="Precautions" items={precautions} />
        <PreviewList title="Contraindications" items={contraindications} />

        {(missingFields.length > 0 || sourceErrors.length > 0) && (
          <section className="drug-normalized-section">
            <h5>Quality</h5>
            <div className="drug-normalized-chips">
              {missingFields.map((field) => (
                <span key={`missing-${field}`}>missing: {field}</span>
              ))}
              {sourceErrors.map((sourceError, idx) => (
                <span key={`error-${idx}`}>source error: {sourceError}</span>
              ))}
            </div>
          </section>
        )}

        <details className="drug-normalized-json">
          <summary>Raw normalized JSON</summary>
          <pre>{JSON.stringify(record, null, 2)}</pre>
        </details>
      </div>
    </div>
  );
}

function AssetPreview({
  asset,
  onBack,
}: {
  asset: DrugAsset | null;
  onBack?: () => void;
}): JSX.Element {
  if (!asset) {
    return (
      <div className="drug-preview-empty">
        <strong>No asset selected</strong>
        <span>Select a crawler asset to preview its stored content.</span>
      </div>
    );
  }

  const src = `/admin/api/drug/asset-content?asset_id=${encodeURIComponent(asset.asset_id)}`;
  const label = assetLabel(asset);

  return (
    <div className="drug-asset-viewer">
      <div className="drug-asset-viewer__head">
        <div>
          <strong title={label}>{label}</strong>
          <div className="muted small">
            {assetGroupLabel(asset.asset_group)} · {asset.mime_type || "unknown"}
            {asset.size_bytes != null ? ` · ${formatBytes(asset.size_bytes)}` : ""}
          </div>
        </div>
        <div className="drug-asset-viewer__actions">
          {onBack ? (
            <button type="button" className="btn btn--sm" onClick={onBack}>
              Normalized
            </button>
          ) : null}
          <a className="btn btn--sm" href={src} target="_blank" rel="noreferrer">
            Open
          </a>
        </div>
      </div>
      <div className="drug-asset-viewer__body">
        {isImage(asset) ? (
          <img src={src} alt={label} />
        ) : isPdf(asset) || isTextLike(asset) ? (
          <iframe title={label} src={src} />
        ) : (
          <div className="drug-preview-empty">
            <strong>Preview not available</strong>
            <span>Open this asset in a new tab to inspect it.</span>
          </div>
        )}
      </div>
    </div>
  );
}

function LicenseListItem({
  item,
  active,
  onSelect,
}: {
  item: LicenseRow;
  active: boolean;
  onSelect: () => void;
}): JSX.Element {
  const statuses = item.statuses ?? {};
  const failed =
    Object.values(statuses).some((status) => status === "retryable_failed") ||
    item.queue_status === "retryable_failed";
  return (
    <button
      type="button"
      className={`drug-license-row ${active ? "drug-license-row--active" : ""}`}
      onClick={onSelect}
    >
      <span className="drug-license-row__top">
        <code>{item.license_id}</code>
        {item.is_active === false ? (
          <span className="badge badge--muted">inactive</span>
        ) : failed ? (
          <span className="badge badge--bad">failed</span>
        ) : item.asset_count ? (
          <span className="badge badge--ok">{item.asset_count} assets</span>
        ) : (
          <span className="badge badge--muted">index</span>
        )}
      </span>
      <span className="drug-license-row__name">{item.name_zh || item.name_en || "Unnamed drug"}</span>
      {item.name_zh && item.name_en ? (
        <span className="drug-license-row__sub">{item.name_en}</span>
      ) : null}
      <span className="drug-license-row__meta">
        OCR {statusText(statuses.ocr_status)} · Analysis {statusText(statuses.analysis_status)}
      </span>
    </button>
  );
}

function AssetList({
  assets,
  selectedAssetId,
  onSelect,
}: {
  assets: DrugAsset[];
  selectedAssetId: string | null;
  onSelect: (assetId: string) => void;
}): JSX.Element {
  if (assets.length === 0) {
    return <div className="muted small">No crawler assets stored for this license.</div>;
  }

  const grouped = assets.reduce<Record<string, DrugAsset[]>>((acc, asset) => {
    const key = asset.asset_group || "other";
    acc[key] = acc[key] || [];
    acc[key].push(asset);
    return acc;
  }, {});

  return (
    <div className="drug-assets">
      {Object.entries(grouped).map(([group, groupAssets]) => (
        <section className="drug-asset-group" key={group}>
          <div className="drug-asset-group__head">
            <strong>{assetGroupLabel(group)}</strong>
            <span className="muted small">{groupAssets.length}</span>
          </div>
          <div className="drug-asset-group__items">
            {groupAssets.map((asset) => {
              const selected = selectedAssetId === asset.asset_id;
              return (
                <button
                  type="button"
                  key={asset.asset_id}
                  className={`drug-asset-row ${selected ? "drug-asset-row--active" : ""}`}
                  onClick={() => onSelect(asset.asset_id)}
                >
                  <span className="drug-asset-row__name" title={assetLabel(asset)}>
                    {assetLabel(asset)}
                  </span>
                  <span className="drug-asset-row__meta">
                    {asset.mime_type || "unknown"} · {asset.storage_status}
                    {asset.size_bytes != null ? ` · ${formatBytes(asset.size_bytes)}` : ""}
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

function EventsList({ events }: { events: DrugEvent[] }): JSX.Element {
  if (events.length === 0) return <div className="muted small">No pipeline events yet.</div>;
  return (
    <div className="drug-events">
      {events.map((event, idx) => (
        <div className="drug-event" key={`${event.stage}-${event.created_at}-${idx}`}>
          <div className="drug-event__mark" />
          <div className="drug-event__body">
            <div className="drug-event__top">
              <strong>{event.stage || "stage"}</strong>
              <StatusBadge status={event.status || "pending"} />
            </div>
            <div className="muted small">{formatRelative(event.created_at)}</div>
            {event.error_message ? <div className="error-box small">{event.error_message}</div> : null}
          </div>
        </div>
      ))}
    </div>
  );
}

export function DrugLicensesModal({ onClose }: { onClose: () => void }): JSX.Element {
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(DEFAULT_PER_PAGE);
  const [qInput, setQInput] = useState("");
  const [q, setQ] = useState("");
  const [activeOnly, setActiveOnly] = useState(true);
  const [failedOnly, setFailedOnly] = useState(false);
  const [assetGroup, setAssetGroup] = useState<AssetGroup>("all");
  const [selectedLicenseId, setSelectedLicenseId] = useState<string | null>(null);
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [previewMode, setPreviewMode] = useState<PreviewMode>("normalized");
  const [centerTab, setCenterTab] = useState<CenterTab>("record");

  const params = useMemo<Record<string, string>>(
    () => ({
      page: String(page),
      per_page: String(perPage),
      active_only: String(activeOnly),
      failed_only: String(failedOnly),
      ...(q ? { q } : {}),
    }),
    [activeOnly, failedOnly, page, perPage, q],
  );

  const statusQ = useQuery({
    queryKey: qk.drugStatus(params),
    queryFn: () =>
      api.get<DrugStatusPayload>(`/admin/api/drug/status?${new URLSearchParams(params).toString()}`),
    placeholderData: keepPreviousData,
  });

  const licenses = statusQ.data?.licenses ?? [];
  const selectedLicense = licenses.find((item) => item.license_id === selectedLicenseId) ?? null;
  const pagination = statusQ.data?.pagination ?? {};
  const totalPages = pagination.total_pages ?? 1;

  useEffect(() => {
    if (licenses.length === 0) {
      setSelectedLicenseId(null);
      return;
    }
    if (!selectedLicenseId || !licenses.some((item) => item.license_id === selectedLicenseId)) {
      setSelectedLicenseId(licenses[0].license_id);
    }
  }, [licenses, selectedLicenseId]);

  useEffect(() => {
    setSelectedAssetId(null);
    setPreviewMode("normalized");
    setCenterTab("record");
  }, [selectedLicenseId]);

  const detailsQ = useQuery({
    queryKey: selectedLicenseId ? qk.drugDetails(selectedLicenseId) : ["drug", "details", "none"],
    queryFn: () =>
      api.get<DrugDetailsPayload>(
        `/admin/api/drug/details?license_id=${encodeURIComponent(selectedLicenseId || "")}&include_cancelled=true`,
      ),
    enabled: !!selectedLicenseId,
  });

  const eventsQ = useQuery({
    queryKey: selectedLicenseId ? qk.drugEvents(selectedLicenseId) : ["drug", "events", "none"],
    queryFn: () =>
      api.get<{ events: DrugEvent[] }>(
        `/admin/api/drug/events?license_id=${encodeURIComponent(selectedLicenseId || "")}`,
      ),
    enabled: !!selectedLicenseId,
  });

  const assetsQ = useQuery({
    queryKey: selectedLicenseId ? qk.drugAssets(selectedLicenseId) : ["drug", "assets", "none"],
    queryFn: () =>
      api.get<DrugAssetsPayload>(
        `/admin/api/drug/assets?license_id=${encodeURIComponent(selectedLicenseId || "")}`,
      ),
    enabled: !!selectedLicenseId,
  });

  const allAssets = assetsQ.data?.assets ?? [];
  const assets = useMemo(
    () => (assetGroup === "all" ? allAssets : allAssets.filter((asset) => asset.asset_group === assetGroup)),
    [allAssets, assetGroup],
  );
  const selectedAsset = allAssets.find((asset) => asset.asset_id === selectedAssetId) ?? null;
  const details = detailsQ.data;
  const record = details?.record;
  const availability = details?.availability ?? selectedLicense?.statuses ?? {};
  const events = eventsQ.data?.events ?? [];

  useEffect(() => {
    if (selectedAssetId && !assets.some((asset) => asset.asset_id === selectedAssetId)) {
      setSelectedAssetId(null);
      setPreviewMode("normalized");
    }
  }, [assets, selectedAssetId]);

  function submitSearch(e: FormEvent) {
    e.preventDefault();
    setPage(1);
    setQ(qInput.trim());
  }

  function resetFilters() {
    setQInput("");
    setQ("");
    setActiveOnly(true);
    setFailedOnly(false);
    setAssetGroup("all");
    setPerPage(DEFAULT_PER_PAGE);
    setPage(1);
  }

  function selectCenterTab(tab: CenterTab) {
    setCenterTab(tab);
    if (tab !== "assets") {
      setSelectedAssetId(null);
      setPreviewMode("normalized");
    }
  }

  const summary = statusQ.data?.summary;
  const stateCounts = summary?.state_counts ?? {};
  const queueCounts = summary?.queue_counts ?? {};
  const drugNameZh = selectedLicense?.name_zh || recordAt(record, "drug.chinese_name");
  const drugNameEn = selectedLicense?.name_en || recordAt(record, "drug.english_name");
  const manufacturerName =
    recordAt(record, "companies.manufacturers.0.name") || recordAt(record, "manufacturer.name");
  const manufacturerCountry =
    recordAt(record, "companies.manufacturers.0.country") || recordAt(record, "manufacturer.country");
  const primarySource =
    recordAt(record, "source.primary_insert_source") || recordAt(record, "metadata.primary_insert_source");

  return (
    <Modal title="Drug data preview" onClose={onClose} workspace>
      <div className="drug-preview">
        <form className="drug-preview__toolbar" onSubmit={submitSearch}>
          <label className="settings-field drug-preview__search">
            <span className="settings-field__label">Search</span>
            <input
              type="text"
              placeholder="License, Chinese name, English name"
              value={qInput}
              onChange={(e) => setQInput(e.target.value)}
            />
          </label>
          <label className="settings-field">
            <span className="settings-field__label">Rows</span>
            <select
              value={perPage}
              onChange={(e) => {
                setPerPage(Number(e.target.value));
                setPage(1);
              }}
            >
              <option value={25}>25</option>
              <option value={50}>50</option>
              <option value={100}>100</option>
            </select>
          </label>
          <label className="settings-field">
            <span className="settings-field__label">Assets</span>
            <select
              value={assetGroup}
              onChange={(e) => setAssetGroup(e.target.value as AssetGroup)}
            >
              <option value="all">All assets</option>
              <option value="insert">Insert PDFs</option>
              <option value="label">Label PDFs</option>
              <option value="shape">Shape images</option>
              <option value="analysis">OCR / analysis</option>
            </select>
          </label>
          <div className="drug-preview__toolbar-actions">
            <label className="drug-preview-check">
              <input
                type="checkbox"
                checked={activeOnly}
                onChange={(e) => {
                  setActiveOnly(e.target.checked);
                  setPage(1);
                }}
              />
              <span>Active</span>
            </label>
            <label className="drug-preview-check">
              <input
                type="checkbox"
                checked={failedOnly}
                onChange={(e) => {
                  setFailedOnly(e.target.checked);
                  setPage(1);
                }}
              />
              <span>Failed</span>
            </label>
            <button type="submit" className="btn btn--sm">
              Search
            </button>
            <button type="button" className="btn btn--sm" onClick={resetFilters}>
              Reset
            </button>
          </div>
        </form>

        <div className="drug-preview__meta">
          <SummaryPill label="total" value={summary?.total_licenses} />
          <SummaryPill label="active" value={summary?.active_licenses} />
          <SummaryPill label="queue pending" value={queueCounts.pending} />
          <SummaryPill label="queue failed" value={queueCounts.retryable_failed} />
          <SummaryPill label="OCR failed" value={stateCounts.ocr_failed} />
          <SummaryPill label="analysis failed" value={stateCounts.analysis_failed} />
          {statusQ.isFetching ? <span>refreshing</span> : null}
        </div>

        {statusQ.isPending ? (
          <div className="muted drug-preview__loading">Loading drug preview...</div>
        ) : statusQ.isError ? (
          <div className="error-box drug-preview__loading">
            Failed to load drug preview: {String(statusQ.error)}
          </div>
        ) : (
          <div className="drug-preview__workspace">
            <aside className="drug-preview__licenses">
              <div className="drug-preview__licenses-head">
                <strong>Licenses</strong>
                <span className="muted small">
                  {(pagination.total ?? licenses.length).toLocaleString()} rows
                </span>
              </div>
              <div className="drug-preview__license-list">
                {licenses.length === 0 ? (
                  <div className="muted small">No licenses match the current filters.</div>
                ) : (
                  licenses.map((item) => (
                    <LicenseListItem
                      key={item.license_id}
                      item={item}
                      active={item.license_id === selectedLicenseId}
                      onSelect={() => setSelectedLicenseId(item.license_id)}
                    />
                  ))
                )}
              </div>
              <div className="drug-preview-pager">
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={page <= 1}
                  onClick={() => setPage((value) => value - 1)}
                >
                  Prev
                </button>
                <span className="muted small">
                  {page} / {totalPages}
                </span>
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={page >= totalPages}
                  onClick={() => setPage((value) => value + 1)}
                >
                  Next
                </button>
              </div>
            </aside>

            <main className="drug-preview__detail">
              {!selectedLicenseId ? (
                <div className="drug-preview-empty">
                  <strong>No license selected</strong>
                  <span>Choose a license from the left panel.</span>
                </div>
              ) : (
                <>
                  <section className="drug-preview-detail-head">
                    <div>
                      <code>{selectedLicenseId}</code>
                      <h4>{drugNameZh || drugNameEn || "Unnamed drug"}</h4>
                      {drugNameZh && drugNameEn ? <p>{drugNameEn}</p> : null}
                    </div>
                    <div className="drug-preview-detail-head__badges">
                      {selectedLicense?.is_active === false ? (
                        <span className="badge badge--muted">inactive</span>
                      ) : (
                        <span className="badge badge--ok">active</span>
                      )}
                      <span className="badge badge--muted">{allAssets.length} assets</span>
                    </div>
                  </section>

                  <div className="drug-preview-tabs">
                    <button
                      type="button"
                      className={centerTab === "record" ? "drug-preview-tab--active" : ""}
                      onClick={() => selectCenterTab("record")}
                    >
                      Record
                    </button>
                    <button
                      type="button"
                      className={centerTab === "assets" ? "drug-preview-tab--active" : ""}
                      onClick={() => selectCenterTab("assets")}
                    >
                      Assets
                    </button>
                    <button
                      type="button"
                      className={centerTab === "events" ? "drug-preview-tab--active" : ""}
                      onClick={() => selectCenterTab("events")}
                    >
                      Events
                    </button>
                  </div>

                  {centerTab === "record" && (
                    <div className="drug-preview-section">
                      {detailsQ.isPending ? (
                        <div className="muted small">Loading record...</div>
                      ) : details?.error ? (
                        <div className="error-box small">{details.error}</div>
                      ) : (
                        <>
                          <div className="drug-preview-facts">
                            <Fact label="Chinese name" value={drugNameZh} />
                            <Fact label="English name" value={drugNameEn} />
                            <Fact label="Dosage form" value={recordAt(record, "drug.dosage_form")} />
                            <Fact label="Package" value={recordAt(record, "drug.package")} />
                            <Fact label="Manufacturer" value={manufacturerName} />
                            <Fact label="Country" value={manufacturerCountry} />
                            <Fact label="Primary source" value={primarySource} />
                            <Fact
                              label="Insert PDFs"
                              value={details?.documents_summary?.insert_pdf_count ?? 0}
                            />
                            <Fact
                              label="Label PDFs"
                              value={details?.documents_summary?.label_pdf_count ?? 0}
                            />
                          </div>

                          <div className="drug-preview-status-grid">
                            <StatusLine label="Index" status={availability.index_status} />
                            <StatusLine label="Electronic insert" status={availability.electronic_insert_status} />
                            <StatusLine label="Insert PDF" status={availability.insert_pdf_status} />
                            <StatusLine label="Label PDF" status={availability.label_pdf_status} />
                            <StatusLine label="Shape" status={availability.shape_status} />
                            <StatusLine label="Storage" status={availability.storage_status} />
                            <StatusLine label="OCR" status={availability.ocr_status} />
                            <StatusLine label="Analysis" status={availability.analysis_status} />
                            <StatusLine label="Normalize" status={availability.normalize_status} />
                          </div>

                          {selectedLicense?.last_error_message ? (
                            <div className="error-box small">{selectedLicense.last_error_message}</div>
                          ) : null}
                        </>
                      )}
                    </div>
                  )}

                  {centerTab === "assets" && (
                    <div className="drug-preview-section">
                      {assetsQ.isPending ? (
                        <div className="muted small">Loading assets...</div>
                      ) : (
                        <AssetList
                          assets={assets}
                          selectedAssetId={selectedAssetId}
                          onSelect={(assetId) => {
                            setSelectedAssetId(assetId);
                            setPreviewMode("asset");
                          }}
                        />
                      )}
                    </div>
                  )}

                  {centerTab === "events" && (
                    <div className="drug-preview-section">
                      {eventsQ.isPending ? (
                        <div className="muted small">Loading events...</div>
                      ) : (
                        <EventsList events={events} />
                      )}
                    </div>
                  )}
                </>
              )}
            </main>

            <aside className="drug-preview__asset-pane">
              {previewMode === "asset" && selectedAsset ? (
                <AssetPreview
                  asset={selectedAsset}
                  onBack={() => {
                    setSelectedAssetId(null);
                    setPreviewMode("normalized");
                  }}
                />
              ) : (
                <NormalizedRecordPreview
                  licenseId={selectedLicenseId}
                  record={record}
                  availability={availability}
                  documentsSummary={details?.documents_summary}
                  isLoading={detailsQ.isPending}
                  error={details?.error}
                  onShowAssets={() => selectCenterTab("assets")}
                />
              )}
            </aside>
          </div>
        )}
      </div>
    </Modal>
  );
}
