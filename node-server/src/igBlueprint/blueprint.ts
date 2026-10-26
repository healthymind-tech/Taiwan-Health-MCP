/**
 * `fhir_get_bundle_blueprint` (ISSUES_v16 R1): the structure of a Bundle profile in a form a
 * model can follow — every entry slice (name, cardinality, the resource profile it requires), how
 * an entry is matched to a slice (the slicing discriminators turned into "write it like this"),
 * whether the slicing is closed / ordered, Bundle.type, the required references between slices
 * (each slice profile's Reference elements — also inside its extensions — whose target profile is
 * another slice's profile) and a short recipe. Pure over `BlueprintDeps`; IG-agnostic (read from
 * the snapshots only). The whole response stays within BLUEPRINT_BUDGET characters; what does not
 * fit is counted in `omitted`.
 */

import { bundleRules } from "../fhirBundleFinalize.js";
import {
  BLUEPRINT_BUDGET,
  BlueprintError,
  compactProvenance,
  canonicalDir,
  choiceProperty,
  clip,
  isObject,
  measureResponse,
  RESPONSE_MARGIN,
  shortType,
  stripSlices,
  stripVersion,
  tail,
  type BlueprintDeps,
  type LoadedProfile,
} from "./common.js";

type El = Record<string, any>;

export interface BlueprintRequest {
  bundle_profile: string;
  /** "summary" (default): slices + the most important references + recipe; "references": every reference line. */
  view?: "summary" | "references";
  package_id?: string | null;
  version?: string | null;
  /** Provenance keys the tool envelope adds (tool, toolVersion) - measured into `response_chars`. */
  envelope_provenance?: Record<string, unknown>;
}

export interface BlueprintResult {
  data: Record<string, unknown>;
  warnings: string[];
  provenance: Record<string, unknown>;
}

interface SliceInfo {
  name: string;
  id: string;
  min: number;
  max: string;
  types: string[];
  profiles: string[];
  /** Discriminator values the slice pins (path=value). */
  pins: string[];
}

interface RefInfo {
  from: string;
  path: string;
  to: string[];
  /** required | if <ancestor> used | mustSupport */
  status: string;
  rank: number;
}

const BASE_RESOURCE_SD = /^http:\/\/hl7\.org\/fhir\/StructureDefinition\/[A-Z][A-Za-z]+$/;

function fixedOrPattern(el: El | undefined): unknown {
  if (!el) return undefined;
  for (const [k, v] of Object.entries(el)) if ((k.startsWith("fixed") || k.startsWith("pattern")) && k !== "fixed" && k !== "pattern") return v;
  return undefined;
}

function card(min: number, max: string): string {
  return `${min}..${max}`;
}

function compactValue(v: unknown): string {
  if (typeof v === "string") return v;
  const s = JSON.stringify(v);
  return clip(s, 80);
}

/**
 * min>=1 chain of `id` within a snapshot: whether every ancestor (excluding the element itself)
 * is required, and the outermost optional ancestor (relative id) when not.
 */
function chain(id: string, byId: Map<string, El>, rt: string): { ancestorsRequired: boolean; optionalAncestor: string | null } {
  let optional: string | null = null;
  for (let p = parentOf(id); p && p.includes("."); p = parentOf(p)) {
    const pe = byId.get(p);
    if (pe && (pe.min ?? 0) < 1) optional = p;
  }
  return { ancestorsRequired: optional === null, optionalAncestor: optional ? optional.slice(rt.length + 1) : null };
}

function parentOf(id: string): string | null {
  const i = id.lastIndexOf(".");
  return i > 0 ? id.slice(0, i) : null;
}

function referenceTargets(el: El): string[] {
  return [...new Set((el.type || []).filter((t: El) => shortType(t.code) === "Reference").flatMap((t: El) => (t.targetProfile || []).map((u: string) => stripVersion(u))))] as string[];
}

/** JSON-facing relative path: `value[x]` of a Reference-only choice -> `valueReference`. */
function jsonPath(relId: string, el: El | undefined): string {
  if (!relId.endsWith("[x]")) return relId;
  const types = (el?.type || []).map((t: El) => shortType(t.code));
  if (types.length !== 1) return relId;
  const segs = relId.split(".");
  segs[segs.length - 1] = choiceProperty(segs[segs.length - 1].split(":")[0], types[0]);
  return segs.join(".");
}

/** Reference elements of one slice profile (incl. extension values), with their requirement status. */
async function profileReferences(
  sd: El,
  deps: BlueprintDeps,
  loaded: LoadedProfile,
  extCache: Map<string, El | null>,
): Promise<Array<{ path: string; targets: string[]; status: string; rank: number }>> {
  const els: El[] = (sd.snapshot || {}).element || [];
  const rt = String(sd.type || els[0]?.path || "");
  const byId = new Map(els.map((e) => [String(e.id), e]));
  const out: Array<{ path: string; targets: string[]; status: string; rank: number }> = [];
  /**
   * required = the element (and, for an extension value, the value) is min>=1 with every ancestor
   * required; "if X used" = min>=1 below the optional X; mustSupport = optional but mustSupport;
   * plain optional references are not listed.
   */
  const statusOf = (id: string, el: El, valueRequired: boolean): { status: string; rank: number } | null => {
    const c = chain(id, byId, rt);
    const own = (el.min ?? 0) >= 1 && valueRequired;
    if (own && c.ancestorsRequired) return { status: "required", rank: 0 };
    if (own && c.optionalAncestor) return { status: `if ${c.optionalAncestor} used`, rank: 1 };
    if (el.mustSupport) return { status: "mustSupport", rank: 2 };
    return null;
  };
  for (const el of els) {
    const id = String(el.id || "");
    if (!id.includes(".") || el.max === "0") continue;
    const targets = referenceTargets(el);
    if (targets.length) {
      const st = statusOf(id, el, true);
      if (st) out.push({ path: jsonPath(id.slice(rt.length + 1), el), targets, ...st });
      continue;
    }
    // Profiled extension not expanded in place: read its definition's Reference value(s).
    const types = el.type || [];
    if (types.length !== 1 || shortType(types[0].code) !== "Extension" || !types[0].profile?.length) continue;
    if (els.some((x) => String(x.id || "").startsWith(`${id}.value`))) continue; // expanded in place (scanned above)
    const url = String(types[0].profile[0]);
    const key = stripVersion(url);
    if (!extCache.has(key)) extCache.set(key, await deps.fetchStructureDefinition(loaded, url).catch(() => null));
    const ext = extCache.get(key);
    if (!ext || ext.type !== "Extension") continue;
    const xEls: El[] = (ext.snapshot || {}).element || [];
    const xById = new Map(xEls.map((e) => [String(e.id), e]));
    const simple = xById.get("Extension.extension")?.max === "0";
    for (const x of xEls) {
      const xid = String(x.id || "");
      if (x.max === "0") continue;
      const xt = referenceTargets(x);
      if (!xt.length) continue;
      // the value is required when the extension is: min>=1, or ext-1 on a simple extension's value[x]
      let required = (x.min ?? 0) >= 1 || (xid === "Extension.value[x]" && simple);
      for (let p = parentOf(xid); p && p.includes("."); p = parentOf(p)) {
        if ((xById.get(p)?.min ?? 0) < 1) required = false;
      }
      const st = statusOf(id, el, required);
      if (!st) continue;
      out.push({ path: jsonPath(`${id.slice(rt.length + 1)}${xid.slice("Extension".length)}`, x), targets: xt, ...st });
    }
  }
  return out;
}

function discriminatorText(d: { type: string; path: string }): string {
  const p = String(d.path || "$this");
  const at = p === "$this" ? "the entry" : `entry.${p}`;
  switch (d.type) {
    case "profile":
      return `set ${at}.meta.profile = [its slice's profile] and write it to that profile (slice = the profile it conforms to)`;
    case "type":
      return `slice = ${at}.resourceType`;
    case "value":
    case "pattern":
      return `slice = the ${d.type} of ${at}: give the value shown in the slice row`;
    case "exists":
      return `slice = whether ${at} exists`;
    default:
      return `${d.type} of ${at}`;
  }
}

export async function bundleBlueprint(req: BlueprintRequest, deps: BlueprintDeps): Promise<BlueprintResult> {
  const ident = String(req.bundle_profile ?? "").trim();
  if (!ident) throw new BlueprintError("INVALID_ARGUMENT", "bundle_profile is required");
  const loaded = await deps.loadProfile(ident, req.package_id ?? null, req.version ?? null);
  const sd = loaded.sd;
  const els: El[] = (sd?.snapshot || {}).element || [];
  if (sd?.type !== "Bundle" || !els.length) {
    throw new BlueprintError("INVALID_ARGUMENT", `${ident} is not a Bundle profile (type ${sd?.type ?? "unknown"}); for a resource profile call fhir_get_minimal_skeleton`);
  }
  const byId = new Map(els.map((e) => [String(e.id), e]));
  const entry = byId.get("Bundle.entry");
  const slicing = isObject(entry?.slicing) ? entry!.slicing : null;
  const discs: Array<{ type: string; path: string }> = Array.isArray(slicing?.discriminator) ? slicing!.discriminator : [];

  // --- slices ----------------------------------------------------------------------------------
  const slices: SliceInfo[] = [];
  for (const e of els) {
    const id = String(e.id || "");
    const m = /^Bundle\.entry:([^.]+)$/.exec(id);
    if (!m || e.max === "0") continue;
    const res = byId.get(`${id}.resource`);
    const types = [...new Set(((res?.type || []) as El[]).map((t) => shortType(t.code)).filter((t) => t && t !== "Resource"))];
    const profiles = [...new Set(((res?.type || []) as El[]).flatMap((t) => (t.profile || []).map((u: string) => String(u))))];
    const pins: string[] = [];
    for (const d of discs) {
      if (d.type !== "value" && d.type !== "pattern") continue;
      const v = fixedOrPattern(byId.get(`${id}.${d.path}`));
      if (v !== undefined) pins.push(`${d.path}=${compactValue(v)}`);
    }
    slices.push({ name: m[1], id, min: Number(e.min ?? 0), max: String(e.max ?? "*"), types, profiles, pins });
  }

  // Canonical directory shared by most slice profiles: printed once, slice rows show the tail.
  const dirCount = new Map<string, number>();
  for (const s of slices) for (const p of s.profiles) {
    const d = canonicalDir(p);
    if (d) dirCount.set(d, (dirCount.get(d) ?? 0) + 1);
  }
  const profileBase = [...dirCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const shortProfile = (u: string): string => {
    const v = stripVersion(u);
    return profileBase && v.startsWith(profileBase) && !v.slice(profileBase.length).includes("/") ? v.slice(profileBase.length) + (u.includes("|") ? `|${u.split("|")[1]}` : "") : u;
  };
  const sliceRow = (s: SliceInfo): string => {
    const what = s.profiles.length ? s.profiles.map(shortProfile).join(" | ") : s.types.join(" | ") || "any resource";
    const typ = s.profiles.length && s.types.length && !s.types.every((t) => s.profiles.some((p) => tail(p).startsWith(t))) ? ` (${s.types.join("|")})` : "";
    const c = s.min === 0 && s.max === "*" ? "" : ` ${card(s.min, s.max)}`;
    return `${s.name}${c} ${what}${typ}${s.pins.length ? ` [${s.pins.join(", ")}]` : ""}`;
  };

  // --- references between slices -----------------------------------------------------------------
  const sliceByProfile = new Map<string, string[]>();
  for (const s of slices) for (const p of s.profiles) {
    const k = stripVersion(p);
    if (!sliceByProfile.has(k)) sliceByProfile.set(k, []);
    sliceByProfile.get(k)!.push(s.name);
  }
  const refs: RefInfo[] = [];
  const unsliced: string[] = [];
  const extCache = new Map<string, El | null>();
  const sdCache = new Map<string, El | null>();
  const sdOf = async (u: string): Promise<El | null> => {
    const k = stripVersion(u);
    if (!sdCache.has(k)) sdCache.set(k, await deps.fetchStructureDefinition(loaded, u).catch(() => null));
    return sdCache.get(k) ?? null;
  };
  // A reference whose targetProfile is a profile a slice's profile derives from is satisfied by that slice too.
  for (const s of slices) {
    for (const p of s.profiles) {
      let cur = await sdOf(p);
      for (let depth = 0; cur && depth < 6; depth++) {
        const b = typeof cur.baseDefinition === "string" ? stripVersion(cur.baseDefinition) : null;
        if (!b || BASE_RESOURCE_SD.test(b)) break;
        if (!sliceByProfile.has(b)) sliceByProfile.set(b, []);
        if (!sliceByProfile.get(b)!.includes(s.name)) sliceByProfile.get(b)!.push(s.name);
        cur = await sdOf(b);
      }
    }
  }
  const warnings = [...(loaded.warnings || [])];
  let missingProfiles = 0;
  for (const s of slices) {
    for (const p of s.profiles) {
      const psd = await sdOf(p);
      if (!psd) {
        missingProfiles++;
        continue;
      }
      for (const r of await profileReferences(psd, deps, loaded, extCache)) {
        const to = [...new Set(r.targets.flatMap((t) => sliceByProfile.get(t) ?? []))];
        if (!to.length) {
          // a required reference to a profile that has no slice (the Bundle must still hold it, unless slicing is closed)
          const own = r.targets.filter((t) => !BASE_RESOURCE_SD.test(t));
          if (r.status === "required" && own.length && s.min >= 1) unsliced.push(`${s.name}: ${r.path} -> ${own.map(shortProfile).join(" | ")}`);
          continue;
        }
        refs.push({ from: s.name, path: r.path, to, status: r.status, rank: r.rank + (s.min >= 1 ? 0 : 3) });
      }
    }
  }
  if (missingProfiles) warnings.push(`${missingProfiles} slice profile(s) are not installed in the closure: their references are not listed`);
  // Targets a required reference makes mandatory although their own slice is optional.
  const sliceMin = new Map(slices.map((s) => [s.name, s.min]));
  const impliedRequired = [
    ...new Set(refs.filter((r) => r.status === "required" && (sliceMin.get(r.from) ?? 0) >= 1 && r.to.length === 1 && (sliceMin.get(r.to[0]) ?? 0) < 1).map((r) => r.to[0])),
  ];

  // --- Bundle-level facts --------------------------------------------------------------------------
  const typeEl = byId.get("Bundle.type");
  const fixedType = typeEl ? fixedOrPattern(typeEl) : undefined;
  const requiredTop = els
    .filter((e) => /^Bundle\.[A-Za-z]+$/.test(String(e.id)) && (e.min ?? 0) >= 1 && !["Bundle.type", "Bundle.entry", "Bundle.meta"].includes(String(e.id)))
    .map((e) => String(e.id).slice("Bundle.".length));
  const metaProfile = fixedOrPattern(byId.get("Bundle.meta.profile"));
  const rules = slicing?.rules ?? null;
  const sliceMode: "profile" | "type" | "other" = discs.some((d) => d.type === "profile") ? "profile" : discs.some((d) => d.type === "type") ? "type" : "other";

  const recipe: string[] = [];
  const top: string[] = [];
  top.push(fixedType !== undefined ? `Bundle.type = ${JSON.stringify(fixedType)}` : "Bundle.type not fixed (collection, document, transaction ... per use)");
  if (metaProfile !== undefined) {
    const mp = (Array.isArray(metaProfile) ? metaProfile : [metaProfile]).map(String);
    top.push(`Bundle.meta.profile = ${mp.length === 1 && loaded.canonical && stripVersion(mp[0]) === stripVersion(loaded.canonical) ? "[bundle_profile.canonical]" : JSON.stringify(mp)}`);
  }
  if (requiredTop.length) top.push(`required: ${requiredTop.join(", ")} (record values, never invented)`);
  recipe.push(top.join("; "));
  if (slices.length) {
    const req = slices.filter((s) => s.min >= 1).map((s) => (s.min > 1 ? `${s.name}x${s.min}` : s.name));
    recipe.push(
      `required slices: ${req.join(", ") || "none"}` +
        (impliedRequired.length ? `, plus ${impliedRequired.join(", ")} (a required reference points to it)` : "") +
        "; respect each max",
    );
    for (const d of discs) recipe.push(discriminatorText(d));
    recipe.push(
      rules === "closed"
        ? "CLOSED: an entry matching no slice is an error - add no other resources"
        : rules === "openAtEnd"
          ? "slicing openAtEnd: other resources only after the sliced entries"
          : "slicing open: other resources allowed; the slices still need their min",
    );
    if (slicing?.ordered) recipe.push("slicing ORDERED: entries in the order of `slices`");
  } else {
    recipe.push("no entry slices: any resources (each conforming to the profile it declares)");
  }
  if (fixedType === "document" || fixedType === "message") {
    const order = bundleRules(sd).entry_order;
    if (order) recipe.push(fixedType === "document" ? "type=document: entry[0] = the Composition (bdl-11)" : "type=message: entry[0] = the MessageHeader (bdl-12)");
  }
  recipe.push("entry.fullUrl = urn:uuid:<lowercase uuid>; references between entries = the target's fullUrl");
  recipe.push("next: fhir_get_minimal_skeleton(profile, package_id) per slice profile -> write the resources -> fhir_finalize_bundle / fhir_validate_bundle (bundle_profile)");

  const prov = compactProvenance({ ...(loaded.provenance || {}), ...(req.envelope_provenance || {}) });
  // One line per (element, target, status), listing every source slice that has it; references of
  // the sibling slices of one optional sliced element ("if supportingInfo:X used") share a line.
  type Group = { from: string[]; path: string; to: string[]; status: string; rank: number; members?: string[] };
  const groups = new Map<string, Group>();
  for (const r of refs) {
    const m = /^if (.+):([^.:]+) used$/.exec(r.status);
    if (m && r.path.startsWith(`${m[1]}:${m[2]}`)) {
      const suffix = r.path.slice(`${m[1]}:${m[2]}`.length);
      const k = `S\u0000${r.from}\u0000${m[1]}\u0000${suffix}`;
      const g = groups.get(k);
      const member = `${m[2]}->${r.to.join("|")}`;
      if (g) g.members!.push(member);
      else groups.set(k, { from: [r.from], path: `${m[1]}:<slice>${suffix}`, to: [], status: "when that slice is used", rank: r.rank, members: [member] });
      continue;
    }
    const k = `${r.path}\u0000${r.to.join("|")}\u0000${r.status}`;
    const g = groups.get(k);
    if (g) {
      if (!g.from.includes(r.from)) g.from.push(r.from);
      g.rank = Math.min(g.rank, r.rank);
    } else groups.set(k, { from: [r.from], path: r.path, to: r.to, status: r.status, rank: r.rank });
  }
  // Long member lists are split (5 per line) so the size budget can keep part of them.
  const chunked: Group[] = [];
  for (const g of groups.values()) {
    if (!g.members || g.members.length <= 5) chunked.push(g);
    else for (let i = 0; i < g.members.length; i += 5) chunked.push({ ...g, members: g.members.slice(i, i + 5) });
  }
  const sortedRefs = chunked.sort((a, b) => a.rank - b.rank || b.from.length - a.from.length);
  const fromText = (from: string[]): string => (from.length > 4 ? `${from.length} slices (${from.slice(0, 3).join(",")},...)` : from.join(","));
  const refRow = (r: Group): string =>
    r.members
      ? `${fromText(r.from)}: ${r.path} (${r.status}): ${r.members.join(", ")}`
      : `${fromText(r.from)}: ${r.path} -> ${r.to.join(" | ")}${r.status === "required" ? "" : ` (${r.status})`}`;

  const build = (opts: { refs: Set<number>; slicesShown: number; unsliced: boolean }): Record<string, unknown> => {
    const data: Record<string, unknown> = {
      bundle_profile: { id: loaded.profileId, canonical: loaded.canonical },
      type: fixedType ?? null,
      entry: {
        min: Number(entry?.min ?? 0),
        max: String(entry?.max ?? "*"),
        slicing: slicing ? { rules: rules ?? "open", ordered: Boolean(slicing.ordered), discriminator: discs.map((d) => `${d.type}:${d.path}`) } : null,
      },
    };
    if (profileBase) data.profile_base = profileBase;
    data.slices = slices.slice(0, opts.slicesShown).map(sliceRow);
    data.references = sortedRefs.filter((_, i) => opts.refs.has(i)).map(refRow);
    if (opts.unsliced && unsliced.length) data.required_targets_without_slice = unsliced.slice(0, 8);
    data.recipe = recipe;
    data.legend =
      "slices: name, min..max (none = 0..*), profile (profile_base + it, unless a URL). references: from slices: element -> target slice " +
      "(no suffix = required; 'if X used' = when X is present)";
    const omittedRefs = sortedRefs.length - opts.refs.size;
    const omittedSlices = slices.length - Math.min(opts.slicesShown, slices.length);
    data.omitted = {
      references: omittedRefs,
      slices: omittedSlices,
      ...(opts.unsliced || !unsliced.length ? {} : { required_targets_without_slice: unsliced.length }),
      ...(omittedRefs ? { all_references: "call again with view='references'" } : {}),
    };
    if ((loaded.depsMissing || []).length) data.deps_missing = loaded.depsMissing;
    return data;
  };

  const limit = BLUEPRINT_BUDGET - RESPONSE_MARGIN;
  const fits = (d: Record<string, unknown>): boolean => measureResponse(d, warnings, prov) <= limit;
  if (req.view === "references") {
    const refsView = (chosen: Set<number>): Record<string, unknown> => {
      const d: Record<string, unknown> = { bundle_profile: { id: loaded.profileId, canonical: loaded.canonical }, view: "references" };
      d.references = sortedRefs.filter((_, i) => chosen.has(i)).map(refRow);
      if (unsliced.length) d.required_targets_without_slice = unsliced.slice(0, 8);
      d.legend = "from slices: element -> target slice (no suffix = required; 'if X used' = when X is present; mustSupport = when the record has it)";
      d.omitted = { references: sortedRefs.length - chosen.size };
      return d;
    };
    const chosen = new Set<number>();
    for (let i = 0; i < sortedRefs.length; i++) {
      chosen.add(i);
      if (!fits(refsView(chosen))) chosen.delete(i);
    }
    const d = refsView(chosen);
    d.response_chars = measureResponse(d, warnings, prov);
    return { data: d, warnings, provenance: prov };
  }
  const all = new Set(sortedRefs.map((_, i) => i));
  let data = build({ refs: all, slicesShown: slices.length, unsliced: true });
  if (!fits(data)) {
    // Greedy in importance order: add each reference line that still fits (the rest counted in `omitted`).
    const chosen = new Set<number>();
    let shown = slices.length;
    if (!fits(build({ refs: chosen, slicesShown: shown, unsliced: false }))) {
      while (shown > 0 && !fits(build({ refs: chosen, slicesShown: shown, unsliced: false }))) shown--;
    }
    for (let i = 0; i < sortedRefs.length; i++) {
      chosen.add(i);
      if (!fits(build({ refs: chosen, slicesShown: shown, unsliced: false }))) chosen.delete(i);
    }
    data = build({ refs: chosen, slicesShown: shown, unsliced: false });
  }
  data.response_chars = measureResponse(data, warnings, prov);
  return { data, warnings, provenance: prov };
}

/** Exposed for tests: the reference scan of one profile. */
export const _internal = { profileReferences, chain, jsonPath, stripSlices };
