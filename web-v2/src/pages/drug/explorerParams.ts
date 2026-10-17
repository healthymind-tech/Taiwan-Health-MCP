// URL search-param model for the drug explorer. Every filter lives in the URL
// so links, reloads and the back button restore the exact view.

export interface ExplorerFilters {
  q: string;
  active: "active" | "inactive" | "all";
  asset_types: string[];
  asset_match: "any" | "all";
  missing_asset_types: string[];
  pipeline_statuses: string[];
  stage: string;
  stage_statuses: string[];
  has_error: "" | "true" | "false";
  manufacturer: string;
  country: string;
  dosage_form: string;
  ingredient: string;
  appearance_color: string;
  appearance_shape: string;
  updated_from: string;
  sort: string;
  order: "asc" | "desc";
  page: number;
  per_page: number;
}

export const DEFAULT_FILTERS: ExplorerFilters = {
  q: "",
  active: "active",
  asset_types: [],
  asset_match: "any",
  missing_asset_types: [],
  pipeline_statuses: [],
  stage: "",
  stage_statuses: [],
  has_error: "",
  manufacturer: "",
  country: "",
  dosage_form: "",
  ingredient: "",
  appearance_color: "",
  appearance_shape: "",
  updated_from: "",
  sort: "",
  order: "desc",
  page: 1,
  per_page: 25,
};

const LIST_KEYS = ["asset_types", "missing_asset_types", "pipeline_statuses", "stage_statuses"] as const;

function csv(v: string | null): string[] {
  return (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function parseFilters(sp: URLSearchParams): ExplorerFilters {
  const active = sp.get("active");
  const order = sp.get("order");
  const hasError = sp.get("has_error");
  const page = Number(sp.get("page"));
  const perPage = Number(sp.get("per_page"));
  return {
    q: sp.get("q") ?? "",
    active: active === "inactive" || active === "all" ? active : "active",
    asset_types: csv(sp.get("asset_types")),
    asset_match: sp.get("asset_match") === "all" ? "all" : "any",
    missing_asset_types: csv(sp.get("missing_asset_types")),
    pipeline_statuses: csv(sp.get("pipeline_statuses")),
    stage: sp.get("stage") ?? "",
    stage_statuses: csv(sp.get("stage_statuses")),
    has_error: hasError === "true" || hasError === "false" ? hasError : "",
    manufacturer: sp.get("manufacturer") ?? "",
    country: sp.get("country") ?? "",
    dosage_form: sp.get("dosage_form") ?? "",
    ingredient: sp.get("ingredient") ?? "",
    appearance_color: sp.get("appearance_color") ?? "",
    appearance_shape: sp.get("appearance_shape") ?? "",
    updated_from: sp.get("updated_from") ?? "",
    sort: sp.get("sort") ?? "",
    order: order === "asc" ? "asc" : "desc",
    page: Number.isFinite(page) && page >= 1 ? Math.trunc(page) : 1,
    per_page: [10, 25, 50, 100].includes(perPage) ? perPage : 25,
  };
}

/** Serialize, omitting defaults so URLs stay short. */
export function filtersToParams(f: ExplorerFilters): URLSearchParams {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(f) as [keyof ExplorerFilters, ExplorerFilters[keyof ExplorerFilters]][]) {
    const def = DEFAULT_FILTERS[k];
    if ((LIST_KEYS as readonly string[]).includes(k)) {
      const arr = v as string[];
      if (arr.length) sp.set(k, arr.join(","));
      continue;
    }
    if (v === def || v === "" || v === null || v === undefined) continue;
    sp.set(k, String(v));
  }
  return sp;
}

/** The backend wants the same keys; asset_match is only meaningful with ≥2 asset types. */
export function apiQuery(f: ExplorerFilters): string {
  const sp = filtersToParams(f);
  if (f.active === "active") sp.set("active", "active");
  if (f.stage_statuses.length === 0) sp.delete("stage");
  if (!f.stage) sp.delete("stage_statuses");
  sp.set("page", String(f.page));
  sp.set("per_page", String(f.per_page));
  sp.set("order", f.order);
  sp.set("asset_match", f.asset_match);
  return sp.toString();
}

/** Count of non-default filters (excluding q, paging and sorting). */
export function activeFilterCount(f: ExplorerFilters): number {
  let n = 0;
  if (f.active !== "active") n += 1;
  n += f.asset_types.length ? 1 : 0;
  n += f.missing_asset_types.length ? 1 : 0;
  n += f.pipeline_statuses.length ? 1 : 0;
  n += f.stage && f.stage_statuses.length ? 1 : 0;
  for (const k of ["has_error", "manufacturer", "country", "dosage_form", "ingredient", "appearance_color", "appearance_shape", "updated_from"] as const) {
    if (f[k]) n += 1;
  }
  return n;
}
