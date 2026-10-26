/**
 * ISSUES_v16 R5 — Bundle entry slices at assembly (fhir_assemble_bundle with bundle_profile), for
 * any IG: every stored resource is placed into the Bundle profile's entry slice its declared
 * profile names (or, failing that, the only slice of its resource type / the clearly closest one),
 * slice min / max and closed slicing are checked BEFORE validation, and required slices nobody
 * fills are reported as `missing` with what to author — never invented.
 *
 * Changes it makes (reported in `meta_profile_set` / `reordered`):
 *   - meta.profile gets the slice's profile when the resource was authored FOR that profile (the
 *     stored input's profile equals the slice's, ignoring `|version`) and does not declare it yet;
 *   - when the slicing is `ordered`, entries are put in slice order (stable; unplaced entries last).
 * Everything else is reported only. Rules come from the StructureDefinition snapshots
 * (fhirSliceMatch.bundleEntrySlices / profileAffinity) — nothing IG-specific.
 */

import { insertKey } from "../fhirRepair/walk.js";
import { bundleEntrySlices, declaredProfiles, profileAffinity, stripVersion, type EntrySlice } from "../fhirSliceMatch.js";

export interface SliceEntryInput {
  key: string;
  resource: Record<string, any>;
  /** The profile the resource was authored for (the stored input's profile, canonical when resolved). */
  authoredProfile: string | null;
}

export interface BundleSliceReport {
  profile: string;
  rules: string;
  ordered: boolean;
  /** Per key (assembly order): the slice it was placed in and how that was decided. */
  entries: Array<{ key: string; resourceType: string | null; slice: string | null; by: "declared-profile" | "authored-profile" | "only-slice-of-type" | "closest" | null; candidates?: string[] }>;
  /** Required slices with fewer entries than their min: author these (never invented). */
  missing: Array<{ slice: string; profile: string | null; resourceType: string | null; min: number; found: number; guidance: string }>;
  /** Slices with more entries than their max. */
  excess: Array<{ slice: string; max: string; keys: string[] }>;
  /** Entries no slice takes (or whose slice their profile does not decide) — listed only when the slicing is closed. */
  unmatched: Array<{ key: string; resourceType: string | null; reason: string }>;
  /** Keys whose meta.profile was completed with their slice's profile. */
  meta_profile_set: string[];
  /** true when the entries were reordered to the slice order (slicing.ordered). */
  reordered: boolean;
}

/** Profile type of each slice (the first profile's StructureDefinition type, else the slice's type). */
async function sliceTypes(slices: EntrySlice[], fetch: (u: string) => Promise<Record<string, any> | null>): Promise<Map<string, { type: string | null; sd: Record<string, any> | null }>> {
  const out = new Map<string, { type: string | null; sd: Record<string, any> | null }>();
  for (const s of slices) {
    const sd = s.profiles[0] ? await fetch(s.profiles[0]).catch(() => null) : null;
    const type = sd && typeof sd.type === "string" ? sd.type : s.types.find((t) => t !== "Resource" && t !== "DomainResource") ?? null;
    out.set(s.id, { type, sd });
  }
  return out;
}

/**
 * Place the entries into the entry slices of `bundleSd`, in place (meta.profile completion), and
 * return the new key order with the report; null when the profile does not slice Bundle.entry.
 */
export async function placeEntrySlices(
  entries: SliceEntryInput[],
  bundleSd: Record<string, any> | null,
  fetch: (url: string) => Promise<Record<string, any> | null>,
): Promise<{ order: string[]; report: BundleSliceReport } | null> {
  const slicing = bundleEntrySlices(bundleSd);
  if (!slicing || !slicing.slices.length) return null;
  const types = await sliceTypes(slicing.slices, fetch);
  const report: BundleSliceReport = {
    profile: stripVersion(String(bundleSd?.url ?? "")),
    rules: slicing.rules,
    ordered: slicing.ordered,
    entries: [],
    missing: [],
    excess: [],
    unmatched: [],
    meta_profile_set: [],
    reordered: false,
  };
  const placed = new Map<string, EntrySlice>();
  const sliceHas = (s: EntrySlice, p: string | null | undefined): boolean => !!p && s.profiles.some((x) => stripVersion(x) === stripVersion(p));
  // The authored profile may be an artifact id (`Patient-x`): it names the canonical ending in /<id>.
  const authoredFor = (s: EntrySlice, p: string | null): boolean =>
    !!p && (sliceHas(s, p) || (!stripVersion(p).includes("/") && s.profiles.some((x) => stripVersion(x).endsWith(`/${stripVersion(p)}`))));
  for (const e of entries) {
    const rt = typeof e.resource.resourceType === "string" ? e.resource.resourceType : null;
    const sameType = slicing.slices.filter((s) => types.get(s.id)?.type === rt);
    const declared = declaredProfiles(e.resource).list;
    let slice: EntrySlice | null = null;
    let by: BundleSliceReport["entries"][number]["by"] = null;
    let candidates: string[] | undefined;
    const byDeclared = sameType.filter((s) => declared.some((d) => sliceHas(s, d)));
    const byAuthored = sameType.filter((s) => authoredFor(s, e.authoredProfile));
    if (byDeclared.length === 1) [slice, by] = [byDeclared[0], "declared-profile"];
    else if (byAuthored.length === 1) [slice, by] = [byAuthored[0], "authored-profile"];
    else if (sameType.length === 1) [slice, by] = [sameType[0], "only-slice-of-type"];
    else if (sameType.length > 1) {
      const scored = sameType.map((s, i) => ({ s, i, a: profileAffinity(e.resource, types.get(s.id)?.sd ?? null, s.profiles[0]).score })).sort((a, b) => b.a - a.a || a.i - b.i);
      if (scored[0].a - scored[1].a >= 0.1) [slice, by] = [scored[0].s, "closest"];
      else candidates = scored.filter((x) => scored[0].a - x.a < 0.1).map((x) => x.s.name);
    }
    if (slice) {
      placed.set(e.key, slice);
      // meta.profile: only for a resource authored for exactly this slice's profile.
      const prof = slice.profiles[0];
      if (prof && authoredFor(slice, e.authoredProfile) && !declared.some((d) => sliceHas(slice!, d))) {
        if (!(e.resource.meta && typeof e.resource.meta === "object" && !Array.isArray(e.resource.meta))) insertKey(e.resource, "meta", {}, Object.keys(e.resource).filter((k) => k !== "resourceType" && k !== "id"));
        const meta = e.resource.meta;
        meta.profile = [...(Array.isArray(meta.profile) ? meta.profile : []), sliceHas(slice, e.authoredProfile) && e.authoredProfile!.includes("|") ? e.authoredProfile! : prof];
        report.meta_profile_set.push(e.key);
      }
    } else {
      const reason = sameType.length
        ? `several slices take a ${rt} (${(candidates ?? sameType.map((s) => s.name)).join(", ")}) and its profile does not decide: author it for one of ${sameType.map((s) => stripVersion(s.profiles[0] ?? "")).filter(Boolean).join(", ")}`
        : `no entry slice of ${report.profile} takes a ${rt ?? "resource without resourceType"}${slicing.rules === "closed" ? " (slicing is CLOSED: the Bundle will be invalid with it — drop the key or author the resource for one of the slices)" : ""}`;
      // Open slicing admits entries outside the slices: only closed slicing makes them a problem.
      if (slicing.rules === "closed") report.unmatched.push({ key: e.key, resourceType: rt, reason });
    }
    report.entries.push({ key: e.key, resourceType: rt, slice: slice?.name ?? null, by, ...(candidates ? { candidates } : {}) });
  }
  for (const s of slicing.slices) {
    const keys = entries.filter((e) => placed.get(e.key) === s).map((e) => e.key);
    const type = types.get(s.id)?.type ?? null;
    if (keys.length < s.min) {
      const prof = s.profiles[0] ? stripVersion(s.profiles[0]) : null;
      report.missing.push({
        slice: s.name,
        profile: prof,
        resourceType: type,
        min: s.min,
        found: keys.length,
        guidance: `author ${s.min - keys.length > 1 ? `${s.min - keys.length} ` : "a "}${type ?? "resource"}${prof ? ` for profile ${prof}` : ""} (slice '${s.name}', min ${s.min}) with fhir_author_resources from the record, then add its key — it is never invented`,
      });
    }
    if (s.max !== "*" && /^\d+$/.test(s.max) && keys.length > Number(s.max)) report.excess.push({ slice: s.name, max: s.max, keys });
  }
  let order = entries.map((e) => e.key);
  if (slicing.ordered) {
    const rank = (k: string): number => {
      const s = placed.get(k);
      return s ? slicing.slices.indexOf(s) : slicing.slices.length;
    };
    const next = order.map((k, i) => ({ k, i })).sort((a, b) => rank(a.k) - rank(b.k) || a.i - b.i).map((x) => x.k);
    report.reordered = next.some((k, i) => k !== order[i]);
    order = next;
  }
  return { order, report };
}
