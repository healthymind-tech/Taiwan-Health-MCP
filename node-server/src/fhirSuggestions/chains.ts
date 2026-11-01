/**
 * release v1 — cascades back to their root cause. One failed rule in an entry (an invariant, a missing element) makes
 * every reference to it fail profile matching and every Bundle entry slice that should take it go unmatched; the
 * official validator reports each of those separately. Here:
 *   - an entry slice that is required but not found (`Slice 'Bundle.entry:<name>': a matching slice is required`) gets
 *     `caused_by`: the own errors of the entries the slice is for (same resource type as the slice name, or whose
 *     meta.profile names it), when they have errors that are not themselves cascades;
 *   - every issue with `caused_by` gets `root_causes`: the errors at the end of the chain (a cause that is itself a
 *     profile-match error is followed into the entry it names), deduplicated.
 * Additive and fail-open: issue set, severities and messages are unchanged.
 */

import type { CausedBy } from "./types.js";

type Json = Record<string, any>;

const CASCADE = /^Unable to find a profile match for |a matching slice is required, but not found|does not match any known slice/u;
// an entry slice of the Bundle, or a reference slice elsewhere (Composition.section:x.entry:MedicationRequest): the
// slice name is matched against the entries' resource types / profiles; other slices find no entry and get nothing
const SLICE_REQUIRED = /^Slice '[^']*:([^':]+)': a matching slice is required, but not found/u;
const isError = (i: Json): boolean => i.severity === "error" || i.severity === "fatal";
const MAX = 10;

function entryIndexOf(path: string): number | null {
  const m = /^Bundle\.entry\[(\d+)\]/u.exec(path);
  return m ? Number(m[1]) : null;
}

export function attachRootCauses(issues: Json[], root: Json): void {
  try {
    if (!root || root.resourceType !== "Bundle" || !Array.isArray(root.entry)) return;
    const entries: Json[] = root.entry;
    const pathOf = (i: Json): string => String(i.location_path ?? i.path ?? "");
    const byEntry = new Map<number, Json[]>();
    for (const i of issues) {
      if (!isError(i)) continue;
      const k = entryIndexOf(pathOf(i));
      if (k === null) continue;
      const l = byEntry.get(k) ?? [];
      l.push(i);
      byEntry.set(k, l);
    }
    const ownRoots = (k: number): Json[] => (byEntry.get(k) ?? []).filter((i) => !CASCADE.test(String(i.message ?? "")));
    const cause = (k: number, i: Json): CausedBy => ({ fullUrl: entries[k]?.fullUrl ?? null, entry: k, severity: String(i.severity), path: pathOf(i), message: String(i.message) });

    // entry slices: the entries the slice is for
    for (const i of issues) {
      if (!isError(i) || (Array.isArray(i.caused_by) && i.caused_by.length)) continue;
      const m = SLICE_REQUIRED.exec(String(i.message ?? ""));
      if (!m) continue;
      const name = m[1].toLowerCase();
      const out: CausedBy[] = [];
      entries.forEach((e, k) => {
        const r = e?.resource;
        if (!r || typeof r !== "object") return;
        const profiles: string[] = Array.isArray(r.meta?.profile) ? r.meta.profile.map(String) : [];
        const forSlice = String(r.resourceType).toLowerCase() === name || profiles.some((p) => (p.split("|")[0].split("/").pop() ?? "").toLowerCase().includes(name));
        if (!forSlice) return;
        // its own root errors, else its cascade errors (root_causes below follows them to the end)
        const own = ownRoots(k);
        for (const c of own.length ? own : byEntry.get(k) ?? []) if (out.length < MAX) out.push(cause(k, c));
      });
      if (out.length) i.caused_by = out;
    }

    // root causes: follow profile-match causes into the entry they name
    const targetOf = (c: Json): number | null => {
      const pm = /^Unable to find a profile match for (\S+) among choices/u.exec(String(c.message ?? ""));
      if (!pm) return null;
      const ref = pm[1];
      let k = entries.findIndex((e) => e?.fullUrl === ref || (typeof e?.fullUrl === "string" && e.fullUrl.endsWith(`/${ref}`)));
      if (k < 0) {
        const t = /^([A-Z][A-Za-z]+)\/([^/]+)$/u.exec(ref);
        if (t) k = entries.findIndex((e) => e?.resource?.resourceType === t[1] && e?.resource?.id === t[2]);
      }
      return k >= 0 ? k : null;
    };
    for (const i of issues) {
      if (!Array.isArray(i.caused_by) || !i.caused_by.length) continue;
      const roots: CausedBy[] = [];
      const seen = new Set<string>();
      const visited = new Set<number>();
      const visit = (c: Json, depth: number): void => {
        if (roots.length >= MAX || depth > 6) return;
        const k = CASCADE.test(String(c.message ?? "")) ? targetOf(c) : null;
        if (k !== null && !visited.has(k)) {
          visited.add(k);
          const own = ownRoots(k);
          if (own.length) {
            for (const o of own) visit(cause(k, o), depth + 1);
            return;
          }
          for (const o of byEntry.get(k) ?? []) visit(cause(k, o), depth + 1);
          return;
        }
        if (CASCADE.test(String(c.message ?? ""))) return;
        const key = `${c.path}\u0000${c.message}`;
        if (seen.has(key)) return;
        seen.add(key);
        roots.push(c as CausedBy);
      };
      for (const c of i.caused_by) visit(c, 0);
      if (roots.length) i.root_causes = roots;
    }
  } catch {
    // fail-open
  }
}
