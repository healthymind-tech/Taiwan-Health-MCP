import type { IgInstallOrigin, IgSummary } from "./igTypes";

// Client-side filtering / sorting / paging of the IG library. The list API
// returns every installed package in one call (58 on staging; fine into the
// low thousands), so all of this runs in the browser off URL query params.

export type OriginFilter = "" | IgInstallOrigin;
export type DepsFilter = "" | "missing" | "complete";
export type IgSort = "name" | "recent" | "size";

export const PAGE_SIZES = [12, 24, 48] as const;
export const DEFAULT_PAGE_SIZE = 24;

export interface IgFilters {
  q: string;
  origin: OriginFilter;
  deps: DepsFilter;
  fhir: string;
  defaultOnly: boolean;
  examples: boolean;
  sort: IgSort;
  page: number;
  size: number;
}

/** Query-param names (kept short; `tab` is the page's tab param). */
export const P = { q: "q", origin: "origin", deps: "deps", fhir: "fhir", def: "default", ex: "examples", sort: "sort", page: "page", size: "size" } as const;

/** `origin` param value that clears the default "manual" origin filter. */
export const ORIGIN_ALL = "all";

export function readFilters(sp: URLSearchParams): IgFilters {
  const origin = sp.get(P.origin);
  const deps = sp.get(P.deps);
  const sort = sp.get(P.sort);
  const size = Number(sp.get(P.size));
  const page = Math.floor(Number(sp.get(P.page)));
  return {
    q: sp.get(P.q) ?? "",
    // No param → the default view (manually installed IGs only); "all" → no origin filter.
    origin: origin === "manual" || origin === "dependency" ? origin : origin === ORIGIN_ALL ? "" : "manual",
    deps: deps === "missing" || deps === "complete" ? deps : "",
    fhir: sp.get(P.fhir) ?? "",
    defaultOnly: sp.get(P.def) === "1",
    examples: sp.get(P.ex) === "1",
    sort: sort === "recent" || sort === "size" ? sort : "name",
    page: Number.isFinite(page) && page > 1 ? page : 1,
    size: (PAGE_SIZES as readonly number[]).includes(size) ? size : DEFAULT_PAGE_SIZE,
  };
}

export const normalizeQuery = (q: string): string => q.trim().toLowerCase();

/** Fields the text search looks at, in display order. */
export function searchFields(ig: IgSummary): string[] {
  return [ig.title, ig.package_id, ig.version, `${ig.package_id}@${ig.version}`, ig.canonical ?? "", ig.description ?? ""];
}

/** Every whitespace-separated term must appear in some field. */
export function matchesQuery(ig: IgSummary, q: string): boolean {
  const terms = normalizeQuery(q).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const hay = searchFields(ig).join("\n").toLowerCase();
  return terms.every((t) => hay.includes(t));
}

export const hasMissingDeps = (ig: IgSummary): boolean => ig.deps_missing.length > 0;

type Facet = "q" | "origin" | "deps" | "fhir" | "defaultOnly" | "examples";

/** Apply every filter except `skip` (for per-option facet counts). */
export function applyFilters(list: IgSummary[], f: IgFilters, skip?: Facet): IgSummary[] {
  return list.filter(
    (ig) =>
      (skip === "q" || matchesQuery(ig, f.q)) &&
      (skip === "origin" || !f.origin || ig.install_origin === f.origin) &&
      (skip === "deps" || !f.deps || (f.deps === "missing" ? hasMissingDeps(ig) : !hasMissingDeps(ig))) &&
      (skip === "fhir" || !f.fhir || (ig.fhir_version ?? "") === f.fhir) &&
      (skip === "defaultOnly" || !f.defaultOnly || ig.is_default) &&
      (skip === "examples" || !f.examples || (ig.counts.examples ?? 0) > 0),
  );
}

const size = (ig: IgSummary) => ig.counts.artifacts + ig.counts.concepts;

export function sortIgs(list: IgSummary[], sort: IgSort): IgSummary[] {
  const byName = (a: IgSummary, b: IgSummary) =>
    a.title.localeCompare(b.title) || a.package_id.localeCompare(b.package_id) || b.version.localeCompare(a.version, undefined, { numeric: true });
  const out = [...list];
  if (sort === "recent") out.sort((a, b) => (b.imported_at ?? "").localeCompare(a.imported_at ?? "") || byName(a, b));
  else if (sort === "size") out.sort((a, b) => size(b) - size(a) || byName(a, b));
  else out.sort((a, b) => Number(b.is_default) - Number(a.is_default) || byName(a, b));
  return out;
}

export function paginate<T>(rows: T[], page: number, pageSize: number): { rows: T[]; page: number; totalPages: number; from: number; to: number } {
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const p = Math.min(Math.max(1, page), totalPages);
  const start = (p - 1) * pageSize;
  const slice = rows.slice(start, start + pageSize);
  return { rows: slice, page: p, totalPages, from: slice.length ? start + 1 : 0, to: start + slice.length };
}

/** A short excerpt of `text` around the first query term (for description matches). */
export function excerpt(text: string, q: string, radius = 60): string | null {
  const terms = normalizeQuery(q).split(/\s+/).filter(Boolean);
  const lower = text.toLowerCase();
  const hit = terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0).sort((a, b) => a - b)[0];
  if (hit === undefined) return null;
  const start = Math.max(0, hit - radius);
  const end = Math.min(text.length, hit + radius * 2);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ").trim()}${end < text.length ? "…" : ""}`;
}
