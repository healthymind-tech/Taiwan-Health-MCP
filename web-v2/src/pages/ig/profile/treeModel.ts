// Pure element-tree logic for the profile page: view filters, search, expansion, flattening.
import type { ElementRow, LinkTarget } from "./profileTypes";

export type TreeView = "snapshot" | "diff" | "key";
export const TREE_VIEWS: readonly TreeView[] = ["snapshot", "diff", "key"];

export interface TreeIndex {
  rows: ElementRow[];
  byId: Map<string, ElementRow>;
}

export function indexRows(rows: ElementRow[]): TreeIndex {
  return { rows, byId: new Map(rows.map((r) => [r.id, r])) };
}

export function ancestors(id: string, idx: TreeIndex): string[] {
  const out: string[] = [];
  let cur = idx.byId.get(id)?.parent ?? null;
  for (let guard = 0; cur && guard < 64; guard++) {
    out.push(cur);
    cur = idx.byId.get(cur)?.parent ?? null;
  }
  return out;
}

/** Row is a "key element": must-support, required (min ≥ 1 or in the LLM required set) or constrained here. */
export function isKey(r: ElementRow, required: Set<string>): boolean {
  return r.mustSupport || (r.min ?? 0) >= 1 || required.has(r.id) || r.inDiff;
}

/** Ids passing the view filter, plus their ancestors (so the tree stays connected). null = every row. */
export function viewSet(idx: TreeIndex, view: TreeView, required: Set<string>): Set<string> | null {
  if (view === "snapshot") return null;
  const hit = idx.rows.filter((r) => (view === "diff" ? r.inDiff : isKey(r, required)));
  return withAncestors(hit.map((r) => r.id), idx);
}

function withAncestors(ids: string[], idx: TreeIndex): Set<string> {
  const out = new Set<string>();
  for (const id of ids) {
    out.add(id);
    for (const a of ancestors(id, idx)) out.add(a);
  }
  return out;
}

/** Text a search matches against: id, slice, short, type codes, profile titles. */
function haystack(r: ElementRow, links: Record<string, LinkTarget>): string {
  const types = r.types
    .flatMap((t) => [t.code.startsWith("http") ? "" : t.code, ...(t.profile ?? []).map((p) => links[bare(p)]?.title ?? p), ...(t.targetProfile ?? []).map((p) => links[bare(p)]?.title ?? p)])
    .join(" ");
  return `${r.id} ${r.sliceName ?? ""} ${r.short ?? ""} ${types}`.toLowerCase();
}

export function bare(url: string): string {
  const i = url.indexOf("|");
  return i >= 0 ? url.slice(0, i) : url;
}

export interface SearchResult {
  matches: Set<string>;
  /** Matches + their ancestors. */
  visible: Set<string>;
}

export function searchRows(idx: TreeIndex, q: string, links: Record<string, LinkTarget>, within: Set<string> | null): SearchResult | null {
  const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return null;
  const matches = new Set<string>();
  for (const r of idx.rows) {
    if (within && !within.has(r.id)) continue;
    const h = haystack(r, links);
    if (terms.every((t) => h.includes(t))) matches.add(r.id);
  }
  return { matches, visible: withAncestors([...matches], idx) };
}

/** Default expansion: the root plus every branch that holds a key element (the interesting parts open). */
export function defaultExpanded(idx: TreeIndex, required: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const r of idx.rows) {
    if (r.depth === 0) out.add(r.id);
    if (r.parent && (r.inDiff || r.mustSupport || required.has(r.id))) for (const a of ancestors(r.id, idx)) out.add(a);
  }
  return out;
}

export function allExpandable(idx: TreeIndex): Set<string> {
  return new Set(idx.rows.filter((r) => r.hasChildren).map((r) => r.id));
}

export interface FlatRow {
  row: ElementRow;
  /** Has children inside the current filter. */
  expandable: boolean;
  expanded: boolean;
}

/** Pre-order rows to render: inside `visible` (null = all) and with every ancestor expanded. */
export function flatten(idx: TreeIndex, visible: Set<string> | null, expanded: Set<string>): FlatRow[] {
  const kids = new Set<string>();
  for (const r of idx.rows) if (r.parent && (!visible || visible.has(r.id))) kids.add(r.parent);
  const shown = new Set<string>();
  const out: FlatRow[] = [];
  for (const r of idx.rows) {
    if (visible && !visible.has(r.id)) continue;
    if (r.parent && !(shown.has(r.parent) && expanded.has(r.parent))) continue;
    shown.add(r.id);
    out.push({ row: r, expandable: kids.has(r.id), expanded: expanded.has(r.id) });
  }
  return out;
}

/** "0..1", "1..*". */
export function card(min: number | null, max: string | null): string {
  if (min === null && max === null) return "";
  return `${min ?? ""}..${max ?? ""}`;
}

/** Human label for a binding strength. */
export const STRENGTH: Record<string, { label: string; color: string }> = {
  required: { label: "required 必須", color: "red" },
  extensible: { label: "extensible 可擴充", color: "orange" },
  preferred: { label: "preferred 建議", color: "blue" },
  example: { label: "example 範例", color: "gray" },
};
