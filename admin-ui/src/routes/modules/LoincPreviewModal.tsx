import { useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { qk } from "../../lib/queryKeys";
import { Modal } from "../../components/Modal";

const PER_PAGE = 50;

type SortKey =
  | "loinc_num"
  | "long_common_name"
  | "shortname"
  | "class"
  | "status"
  | "name_zh"
  | "component"
  | "system"
  | "property"
  | "scale_type"
  | "method_type"
  | "specimen_type"
  | "unit";
type SortDirection = "asc" | "desc";
type ZhFilter = "all" | "with_zh" | "missing_zh";
type ReferenceFilter = "all" | "with_reference" | "missing_reference";

interface LoincRow {
  loinc_num: string;
  long_common_name: string;
  shortname: string;
  class: string;
  status: string;
  name_zh: string;
  common_name_zh: string;
  component: string;
  property: string;
  time_aspect: string;
  system: string;
  scale_type: string;
  method_type: string;
  specimen_type: string;
  unit: string;
  consumer_name: string;
  classtype: number | null;
  has_reference_range?: boolean;
}

interface LoincPreviewResult {
  rows?: LoincRow[];
  total?: number;
  total_all?: number;
  page?: number;
  per_page?: number;
  pages?: number;
  classes?: string[];
  systems?: string[];
  properties?: string[];
  scale_types?: string[];
  message?: string;
}

function fmt(n: number | undefined): string {
  return typeof n === "number" ? n.toLocaleString() : "0";
}

function initialParam(name: string): string {
  return new URLSearchParams(window.location.search).get(name) ?? "";
}

function initialPage(): number {
  const n = Number(initialParam("loinc_page") || "1");
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function cleanPreviewParams() {
  const url = new URL(window.location.href);
  [
    "loinc_preview",
    "loinc_page",
    "loinc_q",
    "loinc_status",
    "loinc_class",
    "loinc_code_prefix",
    "loinc_code_from",
    "loinc_code_to",
    "loinc_component",
    "loinc_system",
    "loinc_property",
    "loinc_scale_type",
    "loinc_method_type",
    "loinc_specimen_type",
    "loinc_unit",
    "loinc_zh_filter",
    "loinc_reference_filter",
    "loinc_sort",
    "loinc_direction",
  ].forEach((key) => url.searchParams.delete(key));
  window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
}

export function LoincPreviewModal({ onClose }: { onClose: () => void }): JSX.Element {
  const [page, setPage] = useState(initialPage);
  const [qInput, setQInput] = useState(() => initialParam("loinc_q"));
  const [q, setQ] = useState(() => initialParam("loinc_q"));
  const [status, setStatus] = useState(() => initialParam("loinc_status") || "ACTIVE");
  const [klass, setKlass] = useState(() => initialParam("loinc_class") || "ALL");
  const [codePrefixInput, setCodePrefixInput] = useState(() => initialParam("loinc_code_prefix").toUpperCase());
  const [codePrefix, setCodePrefix] = useState(() => initialParam("loinc_code_prefix").toUpperCase());
  const [codeFromInput, setCodeFromInput] = useState(() => initialParam("loinc_code_from").toUpperCase());
  const [codeFrom, setCodeFrom] = useState(() => initialParam("loinc_code_from").toUpperCase());
  const [codeToInput, setCodeToInput] = useState(() => initialParam("loinc_code_to").toUpperCase());
  const [codeTo, setCodeTo] = useState(() => initialParam("loinc_code_to").toUpperCase());
  const [componentInput, setComponentInput] = useState(() => initialParam("loinc_component"));
  const [component, setComponent] = useState(() => initialParam("loinc_component"));
  const [systemInput, setSystemInput] = useState(() => initialParam("loinc_system"));
  const [system, setSystem] = useState(() => initialParam("loinc_system"));
  const [propertyInput, setPropertyInput] = useState(() => initialParam("loinc_property"));
  const [property, setProperty] = useState(() => initialParam("loinc_property"));
  const [scaleTypeInput, setScaleTypeInput] = useState(() => initialParam("loinc_scale_type"));
  const [scaleType, setScaleType] = useState(() => initialParam("loinc_scale_type"));
  const [methodTypeInput, setMethodTypeInput] = useState(() => initialParam("loinc_method_type"));
  const [methodType, setMethodType] = useState(() => initialParam("loinc_method_type"));
  const [specimenTypeInput, setSpecimenTypeInput] = useState(() => initialParam("loinc_specimen_type"));
  const [specimenType, setSpecimenType] = useState(() => initialParam("loinc_specimen_type"));
  const [unitInput, setUnitInput] = useState(() => initialParam("loinc_unit"));
  const [unit, setUnit] = useState(() => initialParam("loinc_unit"));
  const [zhFilter, setZhFilter] = useState<ZhFilter>(() => {
    const raw = initialParam("loinc_zh_filter");
    return raw === "with_zh" || raw === "missing_zh" ? raw : "all";
  });
  const [referenceFilter, setReferenceFilter] = useState<ReferenceFilter>(() => {
    const raw = initialParam("loinc_reference_filter");
    return raw === "with_reference" || raw === "missing_reference" ? raw : "all";
  });
  const [sort, setSort] = useState<SortKey>(() => {
    const raw = initialParam("loinc_sort");
    return raw === "long_common_name"
      || raw === "shortname"
      || raw === "class"
      || raw === "status"
      || raw === "name_zh"
      || raw === "component"
      || raw === "system"
      || raw === "property"
      || raw === "scale_type"
      || raw === "method_type"
      || raw === "specimen_type"
      || raw === "unit"
      ? raw
      : "loinc_num";
  });
  const [direction, setDirection] = useState<SortDirection>(() =>
    initialParam("loinc_direction") === "desc" ? "desc" : "asc",
  );
  const [showAdvanced, setShowAdvanced] = useState(false);

  const params: Record<string, string> = {
    page: String(page),
    per_page: String(PER_PAGE),
    status,
    sort,
    direction,
    ...(q ? { q } : {}),
    ...(klass !== "ALL" ? { class: klass } : {}),
    ...(codePrefix ? { code_prefix: codePrefix } : {}),
    ...(codeFrom ? { code_from: codeFrom } : {}),
    ...(codeTo ? { code_to: codeTo } : {}),
    ...(component ? { component } : {}),
    ...(system ? { system } : {}),
    ...(property ? { property } : {}),
    ...(scaleType ? { scale_type: scaleType } : {}),
    ...(methodType ? { method_type: methodType } : {}),
    ...(specimenType ? { specimen_type: specimenType } : {}),
    ...(unit ? { unit } : {}),
    ...(zhFilter !== "all" ? { zh_filter: zhFilter } : {}),
    ...(referenceFilter !== "all" ? { reference_filter: referenceFilter } : {}),
  };

  const { data, isPending, isError, error, isFetching } = useQuery({
    queryKey: qk.modulePreview("loinc", params),
    queryFn: () =>
      api.get<LoincPreviewResult>(
        `/admin/api/modules/loinc/preview?${new URLSearchParams(params).toString()}`,
      ),
    placeholderData: keepPreviousData,
  });

  const rows = data?.rows ?? [];
  const total = data?.total ?? rows.length;
  const effectivePage = data?.page ?? page;
  const totalPages = data?.pages ?? Math.max(1, Math.ceil(total / PER_PAGE));
  const activeAdvancedCount = [
    status !== "ACTIVE" ? status : "",
    klass !== "ALL" ? klass : "",
    codePrefix,
    codeFrom,
    codeTo,
    component,
    system,
    property,
    scaleType,
    methodType,
    specimenType,
    unit,
    zhFilter !== "all" ? zhFilter : "",
    referenceFilter !== "all" ? referenceFilter : "",
    sort !== "loinc_num" ? sort : "",
    direction !== "asc" ? direction : "",
  ].filter(Boolean).length;

  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("loinc_preview", "1");
    url.searchParams.set("loinc_page", String(page));
    url.searchParams.set("loinc_status", status);
    url.searchParams.set("loinc_sort", sort);
    url.searchParams.set("loinc_direction", direction);
    if (q) url.searchParams.set("loinc_q", q);
    else url.searchParams.delete("loinc_q");
    if (klass !== "ALL") url.searchParams.set("loinc_class", klass);
    else url.searchParams.delete("loinc_class");
    if (codePrefix) url.searchParams.set("loinc_code_prefix", codePrefix);
    else url.searchParams.delete("loinc_code_prefix");
    if (codeFrom) url.searchParams.set("loinc_code_from", codeFrom);
    else url.searchParams.delete("loinc_code_from");
    if (codeTo) url.searchParams.set("loinc_code_to", codeTo);
    else url.searchParams.delete("loinc_code_to");
    if (component) url.searchParams.set("loinc_component", component);
    else url.searchParams.delete("loinc_component");
    if (system) url.searchParams.set("loinc_system", system);
    else url.searchParams.delete("loinc_system");
    if (property) url.searchParams.set("loinc_property", property);
    else url.searchParams.delete("loinc_property");
    if (scaleType) url.searchParams.set("loinc_scale_type", scaleType);
    else url.searchParams.delete("loinc_scale_type");
    if (methodType) url.searchParams.set("loinc_method_type", methodType);
    else url.searchParams.delete("loinc_method_type");
    if (specimenType) url.searchParams.set("loinc_specimen_type", specimenType);
    else url.searchParams.delete("loinc_specimen_type");
    if (unit) url.searchParams.set("loinc_unit", unit);
    else url.searchParams.delete("loinc_unit");
    if (zhFilter !== "all") url.searchParams.set("loinc_zh_filter", zhFilter);
    else url.searchParams.delete("loinc_zh_filter");
    if (referenceFilter !== "all") url.searchParams.set("loinc_reference_filter", referenceFilter);
    else url.searchParams.delete("loinc_reference_filter");
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  }, [
    codeFrom,
    codePrefix,
    codeTo,
    component,
    direction,
    klass,
    methodType,
    page,
    property,
    q,
    referenceFilter,
    scaleType,
    sort,
    specimenType,
    status,
    system,
    unit,
    zhFilter,
  ]);

  function runSearch(e: React.FormEvent) {
    e.preventDefault();
    setPage(1);
    setQ(qInput.trim());
    setCodePrefix(codePrefixInput.trim().toUpperCase());
    setCodeFrom(codeFromInput.trim().toUpperCase());
    setCodeTo(codeToInput.trim().toUpperCase());
    setComponent(componentInput.trim());
    setSystem(systemInput.trim());
    setProperty(propertyInput.trim());
    setScaleType(scaleTypeInput.trim());
    setMethodType(methodTypeInput.trim());
    setSpecimenType(specimenTypeInput.trim());
    setUnit(unitInput.trim());
  }

  function close() {
    cleanPreviewParams();
    onClose();
  }

  return (
    <Modal title="LOINC Preview" onClose={close} wide>
      <form onSubmit={runSearch} style={{ marginBottom: 12 }}>
        <div className="settings-grid">
          <label className="settings-field" style={{ gridColumn: "span 2" }}>
            <span className="settings-field__label">Search</span>
            <input
              type="text"
              placeholder="LOINC code or name"
              value={qInput}
              onChange={(e) => setQInput(e.target.value)}
            />
          </label>
          <div className="head-actions" style={{ alignSelf: "end" }}>
            <button type="submit" className="btn btn--sm">Apply</button>
            <button type="button" className="btn btn--sm" onClick={() => setShowAdvanced((v) => !v)}>
              {showAdvanced ? "Hide filters" : `More filters${activeAdvancedCount ? ` (${activeAdvancedCount})` : ""}`}
            </button>
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => {
                setPage(1);
                setQ("");
                setQInput("");
                setStatus("ACTIVE");
                setKlass("ALL");
                setCodePrefix("");
                setCodePrefixInput("");
                setCodeFrom("");
                setCodeFromInput("");
                setCodeTo("");
                setCodeToInput("");
                setComponent("");
                setComponentInput("");
                setSystem("");
                setSystemInput("");
                setProperty("");
                setPropertyInput("");
                setScaleType("");
                setScaleTypeInput("");
                setMethodType("");
                setMethodTypeInput("");
                setSpecimenType("");
                setSpecimenTypeInput("");
                setUnit("");
                setUnitInput("");
                setZhFilter("all");
                setReferenceFilter("all");
                setSort("loinc_num");
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
              <span className="settings-field__label">Status</span>
              <select value={status} onChange={(e) => { setPage(1); setStatus(e.target.value); }}>
                <option value="ACTIVE">ACTIVE</option>
                <option value="ALL">ALL</option>
                <option value="DEPRECATED">DEPRECATED</option>
                <option value="DISCOURAGED">DISCOURAGED</option>
                <option value="TRIAL">TRIAL</option>
              </select>
            </label>
            <label className="settings-field">
              <span className="settings-field__label">Class</span>
              <select value={klass} onChange={(e) => { setPage(1); setKlass(e.target.value); }}>
                <option value="ALL">All classes</option>
                {(data?.classes ?? []).map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </label>
            <label className="settings-field">
              <span className="settings-field__label">Code prefix</span>
              <input type="text" placeholder="e.g. 2951" value={codePrefixInput} onChange={(e) => setCodePrefixInput(e.target.value.toUpperCase())} />
            </label>
            <label className="settings-field">
              <span className="settings-field__label">Code from</span>
              <input type="text" placeholder="e.g. 1000-9" value={codeFromInput} onChange={(e) => setCodeFromInput(e.target.value.toUpperCase())} />
            </label>
            <label className="settings-field">
              <span className="settings-field__label">Code to</span>
              <input type="text" placeholder="e.g. 99999-9" value={codeToInput} onChange={(e) => setCodeToInput(e.target.value.toUpperCase())} />
            </label>
            <label className="settings-field">
              <span className="settings-field__label">Component</span>
              <input type="text" placeholder="e.g. Glucose" value={componentInput} onChange={(e) => setComponentInput(e.target.value)} />
            </label>
            <label className="settings-field">
              <span className="settings-field__label">System / specimen</span>
              <input type="text" placeholder="e.g. Ser/Plas" value={systemInput} onChange={(e) => setSystemInput(e.target.value)} />
            </label>
            <label className="settings-field">
              <span className="settings-field__label">Property</span>
              <input type="text" placeholder="e.g. MCnc" value={propertyInput} onChange={(e) => setPropertyInput(e.target.value)} list="loinc-property-options" />
              <datalist id="loinc-property-options">
                {(data?.properties ?? []).map((p) => <option key={p} value={p} />)}
              </datalist>
            </label>
            <label className="settings-field">
              <span className="settings-field__label">Scale</span>
              <input type="text" placeholder="e.g. Qn" value={scaleTypeInput} onChange={(e) => setScaleTypeInput(e.target.value)} list="loinc-scale-options" />
              <datalist id="loinc-scale-options">
                {(data?.scale_types ?? []).map((s) => <option key={s} value={s} />)}
              </datalist>
            </label>
            <label className="settings-field">
              <span className="settings-field__label">Method</span>
              <input type="text" placeholder="method type" value={methodTypeInput} onChange={(e) => setMethodTypeInput(e.target.value)} />
            </label>
            <label className="settings-field">
              <span className="settings-field__label">Specimen type</span>
              <input type="text" placeholder="Taiwan mapping specimen" value={specimenTypeInput} onChange={(e) => setSpecimenTypeInput(e.target.value)} />
            </label>
            <label className="settings-field">
              <span className="settings-field__label">Unit</span>
              <input type="text" placeholder="e.g. mg/dL" value={unitInput} onChange={(e) => setUnitInput(e.target.value)} />
            </label>
            <label className="settings-field">
              <span className="settings-field__label">Chinese name</span>
              <select value={zhFilter} onChange={(e) => { setPage(1); setZhFilter(e.target.value as ZhFilter); }}>
                <option value="all">All</option>
                <option value="with_zh">Has Chinese name</option>
                <option value="missing_zh">Missing Chinese name</option>
              </select>
            </label>
            <label className="settings-field">
              <span className="settings-field__label">Reference range</span>
              <select value={referenceFilter} onChange={(e) => { setPage(1); setReferenceFilter(e.target.value as ReferenceFilter); }}>
                <option value="all">All</option>
                <option value="with_reference">Has reference range</option>
                <option value="missing_reference">Missing reference range</option>
              </select>
            </label>
            <label className="settings-field">
              <span className="settings-field__label">Sort by</span>
              <select value={sort} onChange={(e) => { setPage(1); setSort(e.target.value as SortKey); }}>
                <option value="loinc_num">Code</option>
                <option value="class">Class</option>
                <option value="status">Status</option>
                <option value="name_zh">Chinese name</option>
                <option value="component">Component</option>
                <option value="system">System</option>
                <option value="property">Property</option>
                <option value="scale_type">Scale</option>
                <option value="method_type">Method</option>
                <option value="specimen_type">Specimen type</option>
                <option value="unit">Unit</option>
                <option value="shortname">Short name</option>
                <option value="long_common_name">Long common name</option>
              </select>
            </label>
            <label className="settings-field">
              <span className="settings-field__label">Direction</span>
              <select value={direction} onChange={(e) => { setPage(1); setDirection(e.target.value as SortDirection); }}>
                <option value="asc">Ascending</option>
                <option value="desc">Descending</option>
              </select>
            </label>
          </div>
        )}
      </form>

      <div className="muted small" style={{ marginBottom: 12 }}>
        {fmt(total)} matching rows · {fmt(data?.total_all)} total
        {q ? ` · search "${q}"` : ""}
        {status !== "ACTIVE" ? ` · status ${status}` : ""}
        {klass !== "ALL" ? ` · class ${klass}` : ""}
        {codePrefix ? ` · prefix ${codePrefix}` : ""}
        {codeFrom || codeTo ? ` · range ${codeFrom || "first"}-${codeTo || "last"}` : ""}
        {component ? ` · component ${component}` : ""}
        {system ? ` · system ${system}` : ""}
        {property ? ` · property ${property}` : ""}
        {scaleType ? ` · scale ${scaleType}` : ""}
        {methodType ? ` · method ${methodType}` : ""}
        {specimenType ? ` · specimen ${specimenType}` : ""}
        {unit ? ` · unit ${unit}` : ""}
        {referenceFilter !== "all" ? ` · ${referenceFilter.replace("_", " ")}` : ""}
        {isFetching ? " · refreshing..." : ""}
      </div>

      {isPending ? (
        <div className="muted">Loading preview...</div>
      ) : isError ? (
        <div className="error-box">
          Preview failed: {error instanceof Error ? error.message : String(error)}
          {"detail" in (error as object) && (error as { detail?: string }).detail
            ? ` — ${(error as { detail?: string }).detail}`
            : ""}
        </div>
      ) : data?.message && rows.length === 0 ? (
        <div className="muted">{data.message}</div>
      ) : rows.length === 0 ? (
        <div className="muted">No matching LOINC rows.</div>
      ) : (
        <>
          <div className="preview-scroll">
            <table className="jobs-table">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Chinese name</th>
                  <th>Common name</th>
                  <th>Component</th>
                  <th>System</th>
                  <th>Property</th>
                  <th>Time</th>
                  <th>Scale</th>
                  <th>Method</th>
                  <th>Specimen</th>
                  <th>Unit</th>
                  <th>Class</th>
                  <th>Status</th>
                  <th>Ref range</th>
                  <th>Short name</th>
                  <th>Long common name</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.loinc_num}>
                    <td className="small" data-label="Code"><strong>{row.loinc_num}</strong></td>
                    <td className="small preview-cell" title={row.name_zh || row.common_name_zh} data-label="Chinese name">{row.name_zh || row.common_name_zh}</td>
                    <td className="small preview-cell" title={row.common_name_zh || row.consumer_name} data-label="Common name">
                      {row.common_name_zh || row.consumer_name}
                    </td>
                    <td className="small preview-cell" title={row.component} data-label="Component">{row.component}</td>
                    <td className="small preview-cell" title={row.system} data-label="System">{row.system}</td>
                    <td className="small" data-label="Property">{row.property}</td>
                    <td className="small" data-label="Time">{row.time_aspect}</td>
                    <td className="small" data-label="Scale">{row.scale_type}</td>
                    <td className="small preview-cell" title={row.method_type} data-label="Method">{row.method_type}</td>
                    <td className="small preview-cell" title={row.specimen_type} data-label="Specimen">{row.specimen_type}</td>
                    <td className="small" data-label="Unit">{row.unit}</td>
                    <td className="small" data-label="Class">{row.class}</td>
                    <td className="small" data-label="Status">{row.status}</td>
                    <td className="small" data-label="Ref range">{row.has_reference_range ? "yes" : ""}</td>
                    <td className="small preview-cell" title={row.shortname} data-label="Short name">{row.shortname}</td>
                    <td className="small preview-cell" title={row.long_common_name} data-label="Long common name">{row.long_common_name}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="head-actions" style={{ marginTop: 12, justifyContent: "space-between" }}>
            <span className="muted small">{total.toLocaleString()} matching rows</span>
            <span className="head-actions">
              <button type="button" className="btn btn--sm" disabled={effectivePage <= 1} onClick={() => setPage((p) => p - 1)}>
                Prev
              </button>
              <span className="muted small">{effectivePage} / {totalPages}</span>
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
