import { useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { qk } from "../../lib/queryKeys";
import { Modal } from "../../components/Modal";

const PER_PAGE = 50;

type IcdTable = "cm" | "pcs";
type SortKey = "code" | "name_en" | "name_zh" | "category";
type SortDirection = "asc" | "desc";
type ZhFilter = "all" | "with_zh" | "missing_zh";

interface IcdRow {
  code: string;
  name_en: string;
  name_zh: string;
  category?: string;
  child_count?: number;
}

interface IcdPreviewResult {
  rows?: IcdRow[];
  nodes?: IcdRow[];
  category_options?: IcdRow[];
  total?: number;
  page?: number;
  per_page?: number;
  total_cm?: number;
  total_pcs?: number;
  message?: string;
}

function fmt(n: number | undefined): string {
  return typeof n === "number" ? n.toLocaleString() : "0";
}

function initialParam(name: string): string {
  return new URLSearchParams(window.location.search).get(name) ?? "";
}

function initialPage(): number {
  const n = Number(initialParam("icd_page") || "1");
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function cleanPreviewParams() {
  const url = new URL(window.location.href);
  [
    "icd_preview",
    "icd_table",
    "icd_page",
    "icd_q",
    "icd_category",
    "icd_code_prefix",
    "icd_code_from",
    "icd_code_to",
    "icd_zh_filter",
    "icd_sort",
    "icd_direction",
  ].forEach((key) => url.searchParams.delete(key));
  window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
}

export function IcdPreviewModal({ onClose }: { onClose: () => void }): JSX.Element {
  const [table, setTable] = useState<IcdTable>(() => initialParam("icd_table") === "pcs" ? "pcs" : "cm");
  const [page, setPage] = useState(initialPage);
  const [qInput, setQInput] = useState(() => initialParam("icd_q"));
  const [q, setQ] = useState(() => initialParam("icd_q"));
  const [category, setCategory] = useState(() => initialParam("icd_category").toUpperCase());
  const [codePrefixInput, setCodePrefixInput] = useState(() => initialParam("icd_code_prefix").toUpperCase());
  const [codePrefix, setCodePrefix] = useState(() => initialParam("icd_code_prefix").toUpperCase());
  const [codeFromInput, setCodeFromInput] = useState(() => initialParam("icd_code_from").toUpperCase());
  const [codeFrom, setCodeFrom] = useState(() => initialParam("icd_code_from").toUpperCase());
  const [codeToInput, setCodeToInput] = useState(() => initialParam("icd_code_to").toUpperCase());
  const [codeTo, setCodeTo] = useState(() => initialParam("icd_code_to").toUpperCase());
  const [zhFilter, setZhFilter] = useState<ZhFilter>(() => {
    const raw = initialParam("icd_zh_filter");
    return raw === "with_zh" || raw === "missing_zh" ? raw : "all";
  });
  const [sort, setSort] = useState<SortKey>(() => {
    const raw = initialParam("icd_sort");
    return raw === "name_en" || raw === "name_zh" || raw === "category" ? raw : "code";
  });
  const [direction, setDirection] = useState<SortDirection>(() =>
    initialParam("icd_direction") === "desc" ? "desc" : "asc",
  );
  const [showAdvanced, setShowAdvanced] = useState(false);

  const params: Record<string, string> = {
    table,
    page: String(page),
    per_page: String(PER_PAGE),
    sort,
    direction,
    ...(q ? { q } : {}),
    ...(table === "cm" && category ? { category } : {}),
    ...(codePrefix ? { code_prefix: codePrefix } : {}),
    ...(codeFrom ? { code_from: codeFrom } : {}),
    ...(codeTo ? { code_to: codeTo } : {}),
    ...(zhFilter !== "all" ? { zh_filter: zhFilter } : {}),
  };

  const { data, isPending, isError, error, isFetching } = useQuery({
    queryKey: qk.modulePreview("icd", params),
    queryFn: () =>
      api.get<IcdPreviewResult>(
        `/admin/api/modules/icd/preview?${new URLSearchParams(params).toString()}`,
      ),
    placeholderData: keepPreviousData,
  });

  const rows = data?.rows ?? data?.nodes ?? [];
  const categoryOptions = data?.category_options ?? (table === "cm" ? rows.filter((r) => r.child_count) : []);
  const total = data?.total ?? rows.length;
  const effectivePage = data?.page ?? page;
  const effectivePerPage = data?.per_page ?? PER_PAGE;
  const totalPages = Math.max(1, Math.ceil(total / effectivePerPage));
  const activeAdvancedCount = [
    category,
    codePrefix,
    codeFrom,
    codeTo,
    zhFilter !== "all" ? zhFilter : "",
    sort !== "code" ? sort : "",
    direction !== "asc" ? direction : "",
  ].filter(Boolean).length;

  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("icd_preview", "1");
    url.searchParams.set("icd_table", table);
    url.searchParams.set("icd_page", String(page));
    url.searchParams.set("icd_sort", sort);
    url.searchParams.set("icd_direction", direction);
    if (q) url.searchParams.set("icd_q", q);
    else url.searchParams.delete("icd_q");
    if (category) url.searchParams.set("icd_category", category);
    else url.searchParams.delete("icd_category");
    if (codePrefix) url.searchParams.set("icd_code_prefix", codePrefix);
    else url.searchParams.delete("icd_code_prefix");
    if (codeFrom) url.searchParams.set("icd_code_from", codeFrom);
    else url.searchParams.delete("icd_code_from");
    if (codeTo) url.searchParams.set("icd_code_to", codeTo);
    else url.searchParams.delete("icd_code_to");
    if (zhFilter !== "all") url.searchParams.set("icd_zh_filter", zhFilter);
    else url.searchParams.delete("icd_zh_filter");
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  }, [category, codeFrom, codePrefix, codeTo, direction, page, q, sort, table, zhFilter]);

  function runSearch(e: React.FormEvent) {
    e.preventDefault();
    setPage(1);
    setQ(qInput.trim());
    setCodePrefix(codePrefixInput.trim().toUpperCase());
    setCodeFrom(codeFromInput.trim().toUpperCase());
    setCodeTo(codeToInput.trim().toUpperCase());
  }

  function switchTable(next: IcdTable) {
    setTable(next);
    setPage(1);
    if (next === "pcs") {
      setCategory("");
      if (sort === "category") setSort("code");
    }
  }

  function openCategory(code: string) {
    setPage(1);
    setCategory(code);
  }

  function close() {
    cleanPreviewParams();
    onClose();
  }

  return (
    <Modal title="ICD-10 — data preview" onClose={close} wide>
      <form onSubmit={runSearch} style={{ marginBottom: 12 }}>
        <div className="settings-grid">
          <label className="settings-field">
            <span className="settings-field__label">Table</span>
            <select value={table} onChange={(e) => switchTable(e.target.value as IcdTable)}>
              <option value="cm">Diagnoses (CM)</option>
              <option value="pcs">Procedures (PCS)</option>
            </select>
          </label>
          <label className="settings-field" style={{ gridColumn: "span 2" }}>
            <span className="settings-field__label">Search</span>
            <input
              type="text"
              placeholder="Code or name"
              value={qInput}
              onChange={(e) => setQInput(e.target.value)}
            />
          </label>
          <div className="head-actions" style={{ alignSelf: "end" }}>
            <button type="submit" className="btn btn--sm">Apply</button>
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => setShowAdvanced((v) => !v)}
            >
              {showAdvanced ? "Hide filters" : `More filters${activeAdvancedCount ? ` (${activeAdvancedCount})` : ""}`}
            </button>
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => {
                setPage(1);
                setQ("");
                setQInput("");
                setCategory("");
                setCodePrefix("");
                setCodePrefixInput("");
                setCodeFrom("");
                setCodeFromInput("");
                setCodeTo("");
                setCodeToInput("");
                setZhFilter("all");
                setSort("code");
                setDirection("asc");
              }}
            >
              Clear
            </button>
          </div>
        </div>

        {showAdvanced && (
          <div className="settings-grid" style={{ marginTop: 12 }}>
            <label className="settings-field">
              <span className="settings-field__label">Code prefix</span>
              <input
                type="text"
                placeholder="e.g. A00"
                value={codePrefixInput}
                onChange={(e) => setCodePrefixInput(e.target.value.toUpperCase())}
              />
            </label>
            <label className="settings-field">
              <span className="settings-field__label">Code from</span>
              <input
                type="text"
                placeholder="e.g. A00"
                value={codeFromInput}
                onChange={(e) => setCodeFromInput(e.target.value.toUpperCase())}
              />
            </label>
            <label className="settings-field">
              <span className="settings-field__label">Code to</span>
              <input
                type="text"
                placeholder="e.g. A09.9"
                value={codeToInput}
                onChange={(e) => setCodeToInput(e.target.value.toUpperCase())}
              />
            </label>
            <label className="settings-field">
              <span className="settings-field__label">Category</span>
              <select
                value={category}
                disabled={table !== "cm"}
                onChange={(e) => {
                  setPage(1);
                  setCategory(e.target.value);
                }}
              >
                <option value="">All categories</option>
                {categoryOptions.map((cat) => (
                  <option key={cat.code} value={cat.code}>
                    {cat.code} · {cat.name_en} ({cat.child_count ?? 0})
                  </option>
                ))}
              </select>
            </label>
            <label className="settings-field">
              <span className="settings-field__label">Chinese name</span>
              <select
                value={zhFilter}
                onChange={(e) => {
                  setPage(1);
                  setZhFilter(e.target.value as ZhFilter);
                }}
              >
                <option value="all">All</option>
                <option value="with_zh">Has Chinese name</option>
                <option value="missing_zh">Missing Chinese name</option>
              </select>
            </label>
            <label className="settings-field">
              <span className="settings-field__label">Sort by</span>
              <select
                value={sort}
                onChange={(e) => {
                  setPage(1);
                  setSort(e.target.value as SortKey);
                }}
              >
                <option value="code">Code</option>
                {table === "cm" && <option value="category">Category</option>}
                <option value="name_zh">Chinese name</option>
                <option value="name_en">English name</option>
              </select>
            </label>
            <label className="settings-field">
              <span className="settings-field__label">Direction</span>
              <select
                value={direction}
                onChange={(e) => {
                  setPage(1);
                  setDirection(e.target.value as SortDirection);
                }}
              >
                <option value="asc">Ascending</option>
                <option value="desc">Descending</option>
              </select>
            </label>
          </div>
        )}
      </form>

      <div className="muted small" style={{ marginBottom: 12 }}>
        CM {fmt(data?.total_cm)} records · PCS {fmt(data?.total_pcs)} records
        {table === "cm" && category ? ` · category ${category}` : ""}
        {codePrefix ? ` · prefix ${codePrefix}` : ""}
        {codeFrom || codeTo ? ` · range ${codeFrom || "first"}-${codeTo || "last"}` : ""}
        {q ? ` · search "${q}"` : ""}
        {isFetching ? " · refreshing…" : ""}
      </div>

      {isPending ? (
        <div className="muted">Loading preview…</div>
      ) : isError ? (
        <div className="error-box">Preview failed: {String(error)}</div>
      ) : data?.message && rows.length === 0 ? (
        <div className="muted">{data.message}</div>
      ) : rows.length === 0 ? (
        <div className="muted">No matching ICD rows.</div>
      ) : (
        <>
          <div className="preview-scroll">
            <table className="jobs-table">
              <thead>
                <tr>
                  <th>Code</th>
                  {table === "cm" && <th>Category</th>}
                  <th>Chinese name</th>
                  <th>English name</th>
                  <th>Children</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.code}>
                    <td className="small" data-label="Code">
                      {table === "cm" && row.child_count ? (
                        <button type="button" className="btn btn--ghost btn--sm" onClick={() => openCategory(row.code)}>
                          {row.code}
                        </button>
                      ) : (
                        <strong>{row.code}</strong>
                      )}
                    </td>
                    {table === "cm" && <td className="small" data-label="Category">{row.category || ""}</td>}
                    <td className="small preview-cell" title={row.name_zh} data-label="Chinese name">{row.name_zh}</td>
                    <td className="small preview-cell" title={row.name_en} data-label="English name">{row.name_en}</td>
                    <td className="small" data-label="Children">{row.child_count ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="head-actions" style={{ marginTop: 12, justifyContent: "space-between" }}>
            <span className="muted small">
              {total.toLocaleString()} matching rows
            </span>
            <span className="head-actions">
              <button type="button" className="btn btn--sm" disabled={effectivePage <= 1} onClick={() => setPage((p) => p - 1)}>
                Prev
              </button>
              <span className="muted small">
                {effectivePage} / {totalPages}
              </span>
              <button type="button" className="btn btn--sm" disabled={effectivePage >= totalPages} onClick={() => setPage((p) => p + 1)}>
                Next
              </button>
            </span>
          </div>
        </>
      )}
    </Modal>
  );
}
