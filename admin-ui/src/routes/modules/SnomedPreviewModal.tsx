import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../../lib/api";
import { qk } from "../../lib/queryKeys";
import { Modal } from "../../components/Modal";

type SortKey =
  | "concept_id"
  | "preferred_term"
  | "fsn_term"
  | "semantic_tag"
  | "effective_time"
  | "child_count"
  | "icd10_map_count";

interface SnomedRow {
  concept_id: string;
  preferred_term: string;
  fsn_term: string;
  semantic_tag: string;
  active: boolean;
  language_code: string;
  effective_time: string;
  module_id: string;
  definition_status_id: string;
  child_count: number;
  icd10_map_count: number;
}

interface SnomedPreviewResult {
  type: string;
  total: number;
  total_all: number;
  page: number;
  per_page: number;
  pages: number;
  query: string;
  semantic_tag: string;
  active: string;
  language_code: string;
  map_filter: string;
  sort: SortKey;
  direction: "asc" | "desc";
  semantic_tags: string[];
  language_codes: string[];
  rows: SnomedRow[];
  message?: string;
}

function readParam(name: string, fallback = ""): string {
  return new URLSearchParams(window.location.search).get(name) ?? fallback;
}

function readPage(): number {
  const n = Number(readParam("snomed_page", "1"));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
}

function cleanPreviewParams() {
  const url = new URL(window.location.href);
  [
    "snomed_preview",
    "snomed_page",
    "snomed_q",
    "snomed_tag",
    "snomed_active",
    "snomed_lang",
    "snomed_map",
    "snomed_sort",
    "snomed_direction",
    "snomed_filters",
  ].forEach((key) => url.searchParams.delete(key));
  window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
}

function readSort(): SortKey {
  const raw = readParam("snomed_sort", "concept_id");
  return raw === "preferred_term" || raw === "fsn_term" || raw === "semantic_tag"
    || raw === "effective_time" || raw === "child_count" || raw === "icd10_map_count"
    ? raw
    : "concept_id";
}

export function SnomedPreviewModal({ onClose }: { onClose: () => void }): JSX.Element {
  const [page, setPage] = useState(readPage);
  const [qInput, setQInput] = useState(readParam("snomed_q"));
  const [q, setQ] = useState(readParam("snomed_q"));
  const [advancedOpen, setAdvancedOpen] = useState(() => readParam("snomed_filters", "0") === "1");
  const [tag, setTag] = useState(readParam("snomed_tag"));
  const [active, setActive] = useState(readParam("snomed_active", "active"));
  const [language, setLanguage] = useState(readParam("snomed_lang"));
  const [mapFilter, setMapFilter] = useState(readParam("snomed_map", "all"));
  const [sort, setSort] = useState<SortKey>(readSort);
  const [direction, setDirection] = useState<"asc" | "desc">(
    readParam("snomed_direction", "asc") === "desc" ? "desc" : "asc",
  );

  const params = useMemo(() => {
    const p: Record<string, string> = {
      page: String(page),
      per_page: "50",
      active,
      sort,
      direction,
    };
    if (q) p.q = q;
    if (tag) p.semantic_tag = tag;
    if (language) p.language_code = language;
    if (mapFilter !== "all") p.map_filter = mapFilter;
    return p;
  }, [active, direction, language, mapFilter, page, q, sort, tag]);

  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("snomed_preview", "1");
    url.searchParams.set("snomed_page", String(page));
    url.searchParams.set("snomed_active", active);
    url.searchParams.set("snomed_sort", sort);
    url.searchParams.set("snomed_direction", direction);
    url.searchParams.set("snomed_filters", advancedOpen ? "1" : "0");
    for (const [key, value] of [
      ["snomed_q", q],
      ["snomed_tag", tag],
      ["snomed_lang", language],
      ["snomed_map", mapFilter === "all" ? "" : mapFilter],
    ]) {
      if (value) url.searchParams.set(key, value);
      else url.searchParams.delete(key);
    }
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }, [active, advancedOpen, direction, language, mapFilter, page, q, sort, tag]);

  const { data, isPending, isError, error, isFetching } = useQuery({
    queryKey: qk.modulePreview("snomed", params),
    queryFn: () =>
      api.get<SnomedPreviewResult>(
        `/admin/api/modules/snomed/preview?${new URLSearchParams(params).toString()}`,
      ),
    placeholderData: keepPreviousData,
  });

  function applyFilters(e: React.FormEvent) {
    e.preventDefault();
    setPage(1);
    setQ(qInput.trim());
  }

  function resetFilters() {
    setPage(1);
    setQ("");
    setQInput("");
    setTag("");
    setActive("active");
    setLanguage("");
    setMapFilter("all");
    setSort("concept_id");
    setDirection("asc");
  }

  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const totalPages = data?.pages ?? Math.max(1, Math.ceil(total / 50));
  const activeAdvancedCount = [
    tag,
    active !== "active" ? active : "",
    language,
    mapFilter !== "all" ? mapFilter : "",
    sort !== "concept_id" ? sort : "",
    direction !== "asc" ? direction : "",
  ].filter(Boolean).length;

  function close() {
    cleanPreviewParams();
    onClose();
  }

  return (
    <Modal title="SNOMED CT — data preview" onClose={close} wide>
      <form onSubmit={applyFilters} style={{ marginBottom: 12 }}>
        <div className="settings-grid">
          <label className="settings-field" style={{ gridColumn: "span 2" }}>
            <span className="settings-field__label">Search</span>
            <input
              type="text"
              placeholder="Concept ID, FSN, or preferred term"
              value={qInput}
              onChange={(e) => setQInput(e.target.value)}
            />
          </label>
          <label className="settings-field">
            <span className="settings-field__label">Active</span>
            <select value={active} onChange={(e) => { setPage(1); setActive(e.target.value); }}>
              <option value="active">Active only</option>
              <option value="inactive">Inactive only</option>
              <option value="all">All</option>
            </select>
          </label>
          <div className="head-actions" style={{ alignSelf: "end" }}>
            <button type="submit" className="btn btn--sm">Apply</button>
            <button type="button" className="btn btn--sm" onClick={() => setAdvancedOpen((v) => !v)}>
              {advancedOpen ? "Hide filters" : `More filters${activeAdvancedCount ? ` (${activeAdvancedCount})` : ""}`}
            </button>
            <button type="button" className="btn btn--sm" onClick={resetFilters}>Clear</button>
          </div>
        </div>

        {advancedOpen && (
          <div className="settings-grid" style={{ marginTop: 12 }}>
            <label className="settings-field">
              <span className="settings-field__label">Semantic tag</span>
              <select value={tag} onChange={(e) => { setPage(1); setTag(e.target.value); }}>
                <option value="">All tags</option>
                {(data?.semantic_tags ?? []).map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </label>
            <label className="settings-field">
              <span className="settings-field__label">Language</span>
              <select value={language} onChange={(e) => { setPage(1); setLanguage(e.target.value); }}>
                <option value="">All languages</option>
                {(data?.language_codes ?? []).map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </label>
            <label className="settings-field">
              <span className="settings-field__label">ICD map</span>
              <select value={mapFilter} onChange={(e) => { setPage(1); setMapFilter(e.target.value); }}>
                <option value="all">All</option>
                <option value="with_map">Has ICD map</option>
                <option value="missing_map">No ICD map</option>
              </select>
            </label>
            <label className="settings-field">
              <span className="settings-field__label">Sort by</span>
              <select value={sort} onChange={(e) => { setPage(1); setSort(e.target.value as SortKey); }}>
                <option value="concept_id">Concept ID</option>
                <option value="preferred_term">Preferred term</option>
                <option value="fsn_term">FSN</option>
                <option value="semantic_tag">Semantic tag</option>
                <option value="effective_time">Effective time</option>
                <option value="child_count">Children</option>
                <option value="icd10_map_count">ICD maps</option>
              </select>
            </label>
            <label className="settings-field">
              <span className="settings-field__label">Direction</span>
              <select value={direction} onChange={(e) => { setPage(1); setDirection(e.target.value === "desc" ? "desc" : "asc"); }}>
                <option value="asc">Ascending</option>
                <option value="desc">Descending</option>
              </select>
            </label>
          </div>
        )}
      </form>

      <div className="muted small" style={{ marginBottom: 12 }}>
        {(data?.total_all ?? 0).toLocaleString()} active concepts
        {q ? ` · search "${q}"` : ""}
        {active !== "active" ? ` · ${active}` : ""}
        {tag ? ` · tag ${tag}` : ""}
        {language ? ` · language ${language}` : ""}
        {mapFilter !== "all" ? ` · ${mapFilter === "with_map" ? "has ICD map" : "no ICD map"}` : ""}
        {isFetching ? " · refreshing..." : ""}
      </div>

      {isPending ? (
        <div className="muted">Loading preview...</div>
      ) : isError ? (
        <div className="error-box">
          Preview failed: {error instanceof ApiError ? (error.detail || error.message) : String(error)}
        </div>
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
                  <th>Concept ID</th>
                  <th>Preferred term</th>
                  <th>FSN</th>
                  <th>Tag</th>
                  <th>Active</th>
                  <th>Language</th>
                  <th>Effective</th>
                  <th>Children</th>
                  <th>ICD maps</th>
                  <th>Module</th>
                  <th>Definition status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.concept_id}>
                    <td className="small preview-cell" title={row.concept_id} data-label="Concept ID">{row.concept_id}</td>
                    <td className="small preview-cell" title={row.preferred_term} data-label="Preferred term">{row.preferred_term}</td>
                    <td className="small preview-cell" title={row.fsn_term} data-label="FSN">{row.fsn_term}</td>
                    <td className="small preview-cell" title={row.semantic_tag} data-label="Tag">{row.semantic_tag}</td>
                    <td className="small" data-label="Active">{row.active ? "active" : "inactive"}</td>
                    <td className="small" data-label="Language">{row.language_code}</td>
                    <td className="small" data-label="Effective">{row.effective_time}</td>
                    <td className="small" data-label="Children">{row.child_count}</td>
                    <td className="small" data-label="ICD maps">{row.icd10_map_count}</td>
                    <td className="small preview-cell" title={row.module_id} data-label="Module">{row.module_id}</td>
                    <td className="small preview-cell" title={row.definition_status_id} data-label="Definition status">{row.definition_status_id}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="head-actions" style={{ marginTop: 12, justifyContent: "space-between" }}>
            <span className="muted small">
              {total.toLocaleString()} rows of {(data?.total_all ?? 0).toLocaleString()}{isFetching ? " · refreshing..." : ""}
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
    </Modal>
  );
}
