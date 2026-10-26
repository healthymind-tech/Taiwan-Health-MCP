/**
 * Slice / profile match analysis (ISSUES_v16 R3 / R5), IG-agnostic: everything is read from the
 * StructureDefinition snapshots (slicing discriminators, slice cardinalities, fixed / pattern
 * values, type profiles) and FHIR R4 core semantics — no IG / profile names.
 *
 *   slicingOf(sd, baseId)        the slicing of an element (discriminators, rules, ordered) and its slices;
 *   bundleEntrySlices(sd)        Bundle.entry slicing of a Bundle profile: per slice its resource types / profiles;
 *   profileRelation(decl, want)  how a resource's meta.profile relates to a wanted canonical
 *                                (exact / other version / misspelled / another profile / missing);
 *   profileAffinity(res, sd)     a cheap agreement score of a resource with a profile (resourceType,
 *                                meta.profile, required fixed / pattern values, required top-level elements);
 *   checkItemAgainstSlice(...)   every discriminator of a slicing evaluated for one item, with the reason it fails.
 *
 * All functions are deterministic and side-effect free; the conformance of an item to a profile
 * (the expensive part of a `profile` discriminator) is NOT decided here — callers validate the
 * closest candidate themselves (budgeted).
 */

import { patternMatches } from "./fhirValidator.js";

type El = Record<string, any>;

export function isObj(v: unknown): v is Record<string, any> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

export function stripVersion(url: string): string {
  return String(url || "").split("|")[0];
}

/** Snapshot elements by id (first wins). */
export function elementsById(sd: El | null | undefined): Map<string, El> {
  const out = new Map<string, El>();
  const list = isObj(sd) && isObj(sd.snapshot) && Array.isArray(sd.snapshot.element) ? sd.snapshot.element : [];
  for (const e of list) if (isObj(e) && typeof e.id === "string" && !out.has(e.id)) out.set(e.id, e);
  return out;
}

/** The fixed[x] / pattern[x] value of an element (fixed first), or undefined. */
export function fixedOrPatternOf(el: El | null | undefined): { kind: "fixed" | "pattern"; value: unknown } | undefined {
  if (!isObj(el)) return undefined;
  for (const k of Object.keys(el)) if (k.startsWith("fixed") && k.length > 5 && /[A-Z]/.test(k[5])) return { kind: "fixed", value: el[k] };
  for (const k of Object.keys(el)) if (k.startsWith("pattern") && k.length > 7 && /[A-Z]/.test(k[7])) return { kind: "pattern", value: el[k] };
  return undefined;
}

export interface SliceDef {
  /** Element id (`Bundle.entry:patient`). */
  id: string;
  /** Slice name (`patient`). */
  name: string;
  min: number;
  max: string;
}

export interface Slicing {
  /** Element id of the sliced element (`Bundle.entry`). */
  baseId: string;
  discriminators: Array<{ type: string; path: string }>;
  rules: string;
  ordered: boolean;
  slices: SliceDef[];
}

/** The slicing of element `baseId` and its direct slices (re-slices `a/b` included), in snapshot order. */
export function slicingOf(E: Map<string, El>, baseId: string): Slicing | null {
  const base = E.get(baseId);
  if (!base || !isObj(base.slicing)) {
    // Extension slicing is implicit in many snapshots (discriminator url).
    if (!base || !/\.(extension|modifierExtension)$/.test(baseId)) return null;
  }
  const s = isObj(base.slicing) ? base.slicing : { discriminator: [{ type: "value", path: "url" }], rules: "open" };
  const slices: SliceDef[] = [];
  for (const [id, e] of E) {
    if (!id.startsWith(`${baseId}:`)) continue;
    const name = id.slice(baseId.length + 1);
    if (name.includes(".")) continue;
    slices.push({ id, name, min: typeof e.min === "number" ? e.min : 0, max: e.max === undefined || e.max === null ? "*" : String(e.max) });
  }
  return {
    baseId,
    discriminators: (Array.isArray(s.discriminator) ? s.discriminator : []).filter(isObj).map((d: El) => ({ type: String(d.type || "value"), path: String(d.path || "$this") })),
    rules: String(s.rules || "open"),
    ordered: s.ordered === true,
    slices,
  };
}

function typeCode(t: El): string {
  return String(t.code || "");
}

/** Element reached from `startId` by a simple discriminator path (slice-local ids; resolve() / ofType() are skipped). */
function elementAtPath(E: Map<string, El>, startId: string, path: string): El | null {
  if (path === "$this" || path === "") return E.get(startId) ?? null;
  let id = startId;
  for (const raw of path.split(".")) {
    if (raw === "resolve()" || raw.startsWith("ofType(")) continue;
    const ext = /^extension\('([^']+)'\)$/.exec(raw);
    if (ext) {
      const s = slicingOf(E, `${id}.extension`);
      const hit = s?.slices.find((sl) => (E.get(sl.id)?.type || []).some((t: El) => (t.profile || []).map(stripVersion).includes(ext[1])));
      if (!hit) return null;
      id = hit.id;
      continue;
    }
    const seg = raw.replace(/\(.*\)$/, "");
    if (E.has(`${id}.${seg}`)) id = `${id}.${seg}`;
    else if (E.has(`${id}.${seg}[x]`)) id = `${id}.${seg}[x]`;
    else return null;
  }
  return E.get(id) ?? null;
}

/** Profiles (type.profile + type.targetProfile) and type codes an element allows. */
function typeInfo(el: El | null): { types: string[]; profiles: string[] } {
  const types: string[] = [];
  const profiles: string[] = [];
  for (const t of (el && Array.isArray(el.type) ? el.type : []) as El[]) {
    if (!isObj(t)) continue;
    types.push(typeCode(t));
    for (const p of [...(Array.isArray(t.profile) ? t.profile : []), ...(Array.isArray(t.targetProfile) ? t.targetProfile : [])]) if (typeof p === "string") profiles.push(p);
  }
  return { types: [...new Set(types)], profiles: [...new Set(profiles)] };
}

export interface EntrySlice extends SliceDef {
  /** Resource types the slice's `resource` allows. */
  types: string[];
  /** Profiles the slice's `resource` (or the discriminator path) names. */
  profiles: string[];
}

export interface EntrySlicing {
  rules: string;
  ordered: boolean;
  discriminators: Array<{ type: string; path: string }>;
  slices: EntrySlice[];
}

/** Bundle.entry slicing of a Bundle profile (null when the profile does not slice entry). */
export function bundleEntrySlices(sd: El | null | undefined): EntrySlicing | null {
  const E = elementsById(sd);
  const s = slicingOf(E, "Bundle.entry");
  if (!s) return null;
  const slices: EntrySlice[] = s.slices.map((sl) => {
    const res = typeInfo(E.get(`${sl.id}.resource`) ?? null);
    // A profile discriminator on another path (resource.meta.profile …) still names its profile on resource.
    const disc = s.discriminators.find((d) => d.type === "profile" || d.type === "type");
    const at = disc && disc.path !== "resource" ? typeInfo(elementAtPath(E, sl.id, disc.path)) : { types: [], profiles: [] };
    return { ...sl, types: res.types.length ? res.types : at.types, profiles: [...new Set([...res.profiles, ...at.profiles])] };
  });
  return { rules: s.rules, ordered: s.ordered, discriminators: s.discriminators, slices };
}

// --------------------------------------------------------------------------- //
// meta.profile relation
// --------------------------------------------------------------------------- //

export type ProfileRelation = "exact" | "other-version" | "misspelled" | "other-profile" | "missing" | "malformed";

function lev(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

/** Declared meta.profile values of a resource (a single string is read as one value). */
export function declaredProfiles(res: unknown): { list: string[]; malformed: boolean } {
  if (!isObj(res) || !isObj(res.meta) || res.meta.profile === undefined) return { list: [], malformed: false };
  const p = res.meta.profile;
  if (typeof p === "string") return { list: [p], malformed: true };
  if (!Array.isArray(p)) return { list: [], malformed: true };
  return { list: p.filter((x: unknown): x is string => typeof x === "string"), malformed: false };
}

/**
 * How the declared profiles relate to `wanted`, with the declared value it was judged on.
 * misspelled = same last path segment ignoring case / punctuation, or edit distance ≤ 3 (and ≤ 15 %).
 */
export function profileRelation(declared: string[], wanted: string, malformed = false): { relation: ProfileRelation; value: string | null } {
  const w = stripVersion(wanted);
  if (!declared.length) return { relation: malformed ? "malformed" : "missing", value: null };
  for (const d of declared) {
    if (stripVersion(d) !== w) continue;
    const otherVersion = d.includes("|") && wanted.includes("|") && d !== wanted;
    return { relation: malformed ? "malformed" : otherVersion ? "other-version" : "exact", value: d };
  }
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const lastSeg = (s: string): string => norm(stripVersion(s).split("/").pop() || "");
  for (const d of declared) {
    const ds = stripVersion(d);
    if (lastSeg(ds) === lastSeg(w) || norm(ds) === norm(w)) return { relation: "misspelled", value: d };
    const dist = lev(ds, w);
    if (dist <= 3 && dist / Math.max(ds.length, w.length) <= 0.15) return { relation: "misspelled", value: d };
  }
  return { relation: "other-profile", value: declared[0] };
}

const RELATION_WEIGHT: Record<ProfileRelation, number> = { exact: 1, "other-version": 0.9, malformed: 0.85, misspelled: 0.8, missing: 0.5, "other-profile": 0.15 };

// --------------------------------------------------------------------------- //
// Instance navigation
// --------------------------------------------------------------------------- //

/** Values at a simple dotted path below `node` (arrays flattened; `[x]` stems match any typed key). */
export function valuesAtPath(node: unknown, path: string): unknown[] {
  let cur: unknown[] = [node];
  if (path === "" || path === "$this") return cur;
  for (const seg of path.split(".")) {
    const next: unknown[] = [];
    for (const n of cur) {
      if (!isObj(n)) continue;
      const keys = seg.endsWith("[x]") ? Object.keys(n).filter((k) => k.startsWith(seg.slice(0, -3)) && /[A-Z]/.test(k[seg.length - 3] ?? "")) : seg in n ? [seg] : [];
      for (const k of keys) {
        const v = n[k];
        if (Array.isArray(v)) next.push(...v.filter((x) => x !== null && x !== undefined));
        else if (v !== null && v !== undefined) next.push(v);
      }
    }
    cur = next;
  }
  return cur;
}

/** Resolve a Reference inside a Bundle (fullUrl, `Type/id`, contained `#id`); null when it does not resolve. */
export function resolveInBundle(ref: unknown, bundle: unknown, holder?: unknown): Record<string, any> | null {
  const r = isObj(ref) && typeof ref.reference === "string" ? ref.reference : null;
  if (!r) return null;
  if (r.startsWith("#") && isObj(holder) && Array.isArray(holder.contained)) return holder.contained.find((c: unknown) => isObj(c) && `#${c.id}` === r) ?? null;
  if (!isObj(bundle) || !Array.isArray(bundle.entry)) return null;
  for (const e of bundle.entry) if (isObj(e) && e.fullUrl === r && isObj(e.resource)) return e.resource;
  const m = /^([A-Z][A-Za-z]+)\/([A-Za-z0-9\-.]{1,64})$/.exec(r);
  if (m) for (const e of bundle.entry) if (isObj(e) && isObj(e.resource) && e.resource.resourceType === m[1] && e.resource.id === m[2]) return e.resource;
  for (const e of bundle.entry) if (isObj(e) && typeof e.fullUrl === "string" && e.fullUrl.endsWith(`/${r}`) && isObj(e.resource)) return e.resource;
  return null;
}

/** Values at a discriminator path (resolve(), ofType(T), extension('url') supported). */
export function discriminatorValues(item: unknown, path: string, bundle: unknown): { values: unknown[]; unresolved: number } {
  let cur: unknown[] = [item];
  let unresolved = 0;
  if (path === "$this" || path === "") return { values: cur, unresolved };
  for (const raw of path.split(".")) {
    if (raw === "resolve()") {
      const next: unknown[] = [];
      for (const n of cur) {
        const t = resolveInBundle(n, bundle);
        if (t) next.push(t);
        else unresolved++;
      }
      cur = next;
      continue;
    }
    const of = /^ofType\(([^)]+)\)$/.exec(raw);
    if (of) {
      cur = cur.filter((n) => isObj(n) && (n.resourceType === of[1] || !n.resourceType));
      continue;
    }
    const ext = /^extension\('([^']+)'\)$/.exec(raw);
    if (ext) {
      cur = valuesAtPath({ x: cur }, "x.extension").filter((e) => isObj(e) && e.url === ext[1]);
      continue;
    }
    const next: unknown[] = [];
    for (const n of cur) next.push(...valuesAtPath(n, raw));
    cur = next;
  }
  return { values: cur, unresolved };
}

function short(v: unknown, n = 120): string {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s === undefined ? "undefined" : s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

// --------------------------------------------------------------------------- //
// Profile affinity (cheap; no validation)
// --------------------------------------------------------------------------- //

export interface AffinityCheck {
  /** Instance path relative to the resource (`code`, `category`). */
  path: string;
  kind: "pattern" | "fixed" | "required";
  ok: boolean;
  expected?: unknown;
  actual?: unknown;
}

export interface Affinity {
  /** 0..1 (1 = every cheap check agrees). */
  score: number;
  typeOk: boolean;
  relation: ProfileRelation;
  declared: string | null;
  checks: AffinityCheck[];
}

/**
 * Cheap agreement of a resource with profile `sd`: resourceType, meta.profile relation, and the
 * required fixed / pattern values (elements of depth ≤ 3 whose element and ancestors are min ≥ 1)
 * plus the required top-level elements. Deterministic; at most 16 value checks.
 */
export function profileAffinity(res: unknown, sd: El | null | undefined, wanted?: string): Affinity {
  const url = wanted ?? (isObj(sd) ? String(sd.url || "") : "");
  const type = isObj(sd) ? String(sd.type || "") : "";
  const rt = isObj(res) ? String(res.resourceType || "") : "";
  const decl = declaredProfiles(res);
  const rel = profileRelation(decl.list, url, decl.malformed);
  const typeOk = !!type && rt === type;
  const checks: AffinityCheck[] = [];
  const E = elementsById(sd);
  const minOk = new Map<string, boolean>();
  for (const [id, e] of E) {
    const dot = id.lastIndexOf(".");
    const parent = dot > 0 ? id.slice(0, dot) : null;
    const selfMin = typeof e.min === "number" ? e.min >= 1 : false;
    minOk.set(id, parent === null ? true : selfMin && (minOk.get(parent) ?? (parent.includes(".") ? false : true)));
  }
  for (const [id, e] of E) {
    if (checks.length >= 16) break;
    const segs = String(e.path || "").split(".");
    if (segs.length < 2 || segs.length > 4 || !minOk.get(id)) continue;
    if (segs[1] === "meta" || segs[1] === "id" || segs[1] === "text") continue;
    const rel2 = segs.slice(1).join(".");
    const fp = fixedOrPatternOf(e);
    if (fp) {
      // a fixed / pattern value inside an already-checked pattern is part of it
      if (checks.some((c) => (c.kind === "pattern" || c.kind === "fixed") && rel2.startsWith(`${c.path}.`))) continue;
      const vals = valuesAtPath(res, rel2);
      const ok = vals.some((v) => (fp.kind === "fixed" ? JSON.stringify(v) === JSON.stringify(fp.value) || patternMatches(v, fp.value) : patternMatches(v, fp.value)));
      checks.push({ path: rel2, kind: fp.kind, ok, expected: fp.value, ...(vals.length ? { actual: vals.length === 1 ? vals[0] : vals } : {}) });
    } else if (segs.length === 2 && !id.includes(":")) {
      const vals = valuesAtPath(res, rel2);
      checks.push({ path: rel2, kind: "required", ok: vals.length > 0 });
    }
  }
  const valueChecks = checks.filter((c) => c.kind !== "required");
  const reqChecks = checks.filter((c) => c.kind === "required");
  const vScore = valueChecks.length ? valueChecks.filter((c) => c.ok).length / valueChecks.length : 1;
  const rScore = reqChecks.length ? reqChecks.filter((c) => c.ok).length / reqChecks.length : 1;
  const score = typeOk ? 0.25 + 0.35 * RELATION_WEIGHT[rel.relation] + 0.28 * vScore + 0.12 * rScore : 0;
  return { score: Math.round(score * 1000) / 1000, typeOk, relation: rel.relation, declared: rel.value, checks };
}

// --------------------------------------------------------------------------- //
// Discriminator checks for one item against one slice
// --------------------------------------------------------------------------- //

export interface DiscriminatorFailure {
  /** `<type>:<path>` of the discriminator. */
  discriminator: string;
  /**
   * resource-type-differs | meta-profile-missing | meta-profile-misspelled | meta-profile-other-version |
   * meta-profile-not-array | meta-profile-other | pattern-differs | value-missing | not-in-valueset |
   * exists-differs | type-differs | reference-unresolved | profile-not-met
   */
  reason: string;
  detail: string;
  path?: string;
  expected?: unknown;
  actual?: unknown;
}

export interface SliceCheck {
  slice: SliceDef;
  /** Profiles of a profile / type discriminator (the slice's), when any. */
  profiles: string[];
  /** 0..1; 1 = every decidable discriminator agrees (a profile one still needs conformance). */
  score: number;
  /** Discriminators decided false (or, for profile ones, the cheap signs that it fails). */
  failed: DiscriminatorFailure[];
  /** A profile discriminator whose conformance the caller must still decide (validation). */
  needsConformance: Array<{ profile: string; target: Record<string, any>; relPath: string }>;
}

export interface SliceCheckDeps {
  fetchStructureDefinition(url: string): Promise<El | null>;
  valueSetContains?(url: string, system: string | null, code: string): Promise<boolean | undefined>;
}

function codingsOfValue(v: unknown): Array<[string | null, string]> {
  const out: Array<[string | null, string]> = [];
  if (typeof v === "string") out.push([null, v]);
  else if (isObj(v)) {
    if (typeof v.code === "string") out.push([typeof v.system === "string" ? v.system : null, v.code]);
    if (Array.isArray(v.coding)) for (const c of v.coding) if (isObj(c) && typeof c.code === "string") out.push([typeof c.system === "string" ? c.system : null, c.code]);
  }
  return out;
}

/** Expected fixed / pattern values at a discriminator path of a slice (carried down from an ancestor pattern). */
function expectationAt(E: Map<string, El>, sliceId: string, path: string): { kind: "fixed" | "pattern"; values: unknown[] } | { kind: "binding"; valueSet: string } | null {
  const segs = path === "$this" ? [] : path.split(".");
  let id = sliceId;
  let carried: { kind: "fixed" | "pattern"; values: unknown[] } | null = null;
  const own = (el: El | undefined): { kind: "fixed" | "pattern"; values: unknown[] } | null => {
    const fp = fixedOrPatternOf(el);
    return fp ? { kind: fp.kind, values: [fp.value] } : null;
  };
  carried = own(E.get(id));
  if (segs.length === 1 && segs[0] === "url") {
    const u = own(E.get(`${id}.url`));
    if (u) return u;
    const prof = (E.get(id)?.type || []).find((t: El) => typeCode(t) === "Extension" && Array.isArray(t.profile) && t.profile.length)?.profile?.[0];
    if (prof) return { kind: "fixed", values: [stripVersion(prof)] };
  }
  let last: El | undefined = E.get(id);
  for (const seg of segs) {
    if (seg === "resolve()" || seg.startsWith("ofType(") || seg.startsWith("extension(")) return null;
    if (carried) {
      const next: unknown[] = [];
      for (const v of carried.values) {
        if (!isObj(v)) continue;
        const x = v[seg];
        if (Array.isArray(x)) next.push(...x);
        else if (x !== undefined) next.push(x);
      }
      carried = next.length ? { kind: carried.kind, values: next } : null;
    }
    id = E.has(`${id}.${seg}`) ? `${id}.${seg}` : E.has(`${id}.${seg}[x]`) ? `${id}.${seg}[x]` : `${id}.${seg}`;
    last = E.get(id);
    const mine = own(last);
    if (mine) carried = mine;
  }
  if (carried) return carried;
  if (last && isObj(last.binding) && last.binding.strength === "required" && typeof last.binding.valueSet === "string") return { kind: "binding", valueSet: last.binding.valueSet };
  return null;
}

/**
 * Evaluate every discriminator of `slicing` for `item` against `slice`. `bundle` resolves
 * references (resolve()). Profile discriminators are scored with profileAffinity (cheap) and
 * returned in `needsConformance` — conformance itself is the caller's (validation) decision.
 */
export async function checkItemAgainstSlice(
  E: Map<string, El>,
  slicing: Slicing,
  slice: SliceDef,
  item: unknown,
  bundle: unknown,
  deps: SliceCheckDeps,
): Promise<SliceCheck> {
  const failed: DiscriminatorFailure[] = [];
  const needs: SliceCheck["needsConformance"] = [];
  let total = 0;
  let got = 0;
  const profiles: string[] = [];
  for (const d of slicing.discriminators) {
    const label = `${d.type}:${d.path}`;
    const { values, unresolved } = discriminatorValues(item, d.path, bundle);
    total++;
    if (d.type === "profile" || d.type === "type") {
      const el = elementAtPath(E, slice.id, d.path);
      const info = typeInfo(el ?? E.get(slice.id) ?? null);
      profiles.push(...info.profiles);
      if (unresolved && !values.length) {
        failed.push({ discriminator: label, reason: "reference-unresolved", detail: `${d.path} does not resolve to a resource inside the Bundle`, path: d.path });
        continue;
      }
      const targets = values.filter(isObj);
      if (d.type === "type") {
        const actual = targets.map((t) => String(t.resourceType || "")).filter(Boolean);
        if (info.types.length && actual.some((a) => info.types.includes(a))) got++;
        else failed.push({ discriminator: label, reason: actual.length ? "resource-type-differs" : "value-missing", detail: actual.length ? `resourceType is ${actual.join(", ")}; the slice takes ${info.types.join(", ")}` : `nothing at ${d.path}`, path: d.path, expected: info.types, actual });
        continue;
      }
      if (!info.profiles.length) {
        total--;
        continue;
      }
      // profile: best (target, profile) pair by affinity
      let best: { aff: Affinity; profile: string; target: Record<string, any> } | null = null;
      for (const p of info.profiles.slice(0, 4)) {
        const sd = await deps.fetchStructureDefinition(p).catch(() => null);
        for (const t of targets) {
          const aff = profileAffinity(t, sd, p);
          if (!sd) aff.typeOk = true;
          if (!best || aff.score > best.aff.score) best = { aff, profile: p, target: t };
        }
      }
      if (!best) {
        failed.push({ discriminator: label, reason: "value-missing", detail: `no resource at ${d.path}`, path: d.path });
        continue;
      }
      const { aff, profile, target } = best;
      // A "misspelling" that names an existing profile is another profile.
      if (aff.relation === "misspelled" && aff.declared && (await deps.fetchStructureDefinition(aff.declared).catch(() => null))) aff.relation = "other-profile";
      if (declaredProfiles(target).malformed && aff.relation !== "malformed") failed.push({ discriminator: label, reason: "meta-profile-not-array", detail: "meta.profile must be an array of canonical URLs", path: `${d.path === "$this" ? "" : `${d.path.replace(/\.?resolve\(\)$/, "")}.`}meta.profile`, actual: aff.declared });
      if (!aff.typeOk) {
        const sd = await deps.fetchStructureDefinition(profile).catch(() => null);
        failed.push({ discriminator: label, reason: "resource-type-differs", detail: `resourceType is ${String(target.resourceType || "(missing)")}; ${stripVersion(profile)} is a profile of ${String(sd?.type || "another type")}`, path: `${d.path === "$this" ? "" : `${d.path}.`}resourceType`, expected: sd?.type ?? null, actual: target.resourceType ?? null });
        continue;
      }
      got += aff.score;
      const metaPath = `${d.path === "$this" ? "" : `${d.path.replace(/\.?resolve\(\)$/, "")}.`}meta.profile`;
      if (aff.relation === "missing") failed.push({ discriminator: label, reason: "meta-profile-missing", detail: `meta.profile does not declare ${stripVersion(profile)} (not required for a match, but the resource must then conform to it)`, path: metaPath, expected: [profile] });
      else if (aff.relation === "misspelled") failed.push({ discriminator: label, reason: "meta-profile-misspelled", detail: `meta.profile '${aff.declared}' looks like a misspelling of ${stripVersion(profile)}`, path: metaPath, expected: [profile], actual: aff.declared });
      else if (aff.relation === "other-version") failed.push({ discriminator: label, reason: "meta-profile-other-version", detail: `meta.profile '${aff.declared}' names another version of ${stripVersion(profile)}`, path: metaPath, expected: [profile], actual: aff.declared });
      else if (aff.relation === "malformed") failed.push({ discriminator: label, reason: "meta-profile-not-array", detail: "meta.profile must be an array of canonical URLs", path: metaPath, expected: [profile], actual: aff.declared });
      else if (aff.relation === "other-profile") failed.push({ discriminator: label, reason: "meta-profile-other", detail: `meta.profile declares '${aff.declared}', not ${stripVersion(profile)}`, path: metaPath, expected: [profile], actual: aff.declared });
      for (const c of aff.checks.filter((x) => !x.ok).slice(0, 4)) {
        const at = `${d.path === "$this" ? "" : `${d.path.replace(/\.?resolve\(\)$/, "")}.`}${c.path}`;
        if (c.kind === "required") failed.push({ discriminator: label, reason: "value-missing", detail: `${c.path} is required by ${stripVersion(profile)} and absent`, path: at });
        else failed.push({ discriminator: label, reason: c.actual === undefined ? "value-missing" : "pattern-differs", detail: c.actual === undefined ? `${c.path} must be ${short(c.expected)} (${c.kind} in ${stripVersion(profile)}) and is absent` : `${c.path} must match ${short(c.expected)} (${c.kind} in ${stripVersion(profile)}); found ${short(c.actual)}`, path: at, expected: c.expected, ...(c.actual !== undefined ? { actual: c.actual } : {}) });
      }
      needs.push({ profile, target, relPath: d.path.replace(/\.?resolve\(\)$/, "") });
      continue;
    }
    if (d.type === "exists") {
      const el = elementAtPath(E, slice.id, d.path);
      const want = el ? ((el.min ?? 0) >= 1 ? true : String(el.max) === "0" ? false : undefined) : undefined;
      if (want === undefined) {
        total--;
        continue;
      }
      if ((values.length > 0) === want) got++;
      else failed.push({ discriminator: label, reason: "exists-differs", detail: want ? `${d.path} must be present` : `${d.path} must be absent`, path: d.path });
      continue;
    }
    // value / pattern
    const exp = expectationAt(E, slice.id, d.path);
    if (!exp) {
      total--;
      continue;
    }
    if (exp.kind === "binding") {
      let hit = false;
      let undecided = false;
      for (const v of values) {
        for (const [system, code] of codingsOfValue(v)) {
          const m = deps.valueSetContains ? await deps.valueSetContains(exp.valueSet, system, code).catch(() => undefined) : undefined;
          if (m === true) hit = true;
          else if (m === undefined) undecided = true;
        }
      }
      if (hit) got++;
      else if (undecided) total--;
      else failed.push({ discriminator: label, reason: values.length ? "not-in-valueset" : "value-missing", detail: values.length ? `${d.path} ${short(values[0])} is not a code of ${stripVersion(exp.valueSet)} (required binding of the slice)` : `${d.path} is absent; the slice needs a code of ${stripVersion(exp.valueSet)}`, path: d.path, expected: { valueSet: exp.valueSet }, ...(values.length ? { actual: values[0] } : {}) });
      continue;
    }
    const ok = values.some((v) => exp.values.some((e) => (exp.kind === "fixed" ? JSON.stringify(v) === JSON.stringify(e) : patternMatches(v, e))));
    if (ok) got++;
    else failed.push({ discriminator: label, reason: values.length ? "pattern-differs" : "value-missing", detail: values.length ? `${d.path} is ${short(values.length === 1 ? values[0] : values)}; the slice requires ${short(exp.values.length === 1 ? exp.values[0] : exp.values)}` : `${d.path} is absent; the slice requires ${short(exp.values.length === 1 ? exp.values[0] : exp.values)}`, path: d.path, expected: exp.values.length === 1 ? exp.values[0] : exp.values, ...(values.length ? { actual: values.length === 1 ? values[0] : values } : {}) });
  }
  const score = total > 0 ? Math.round((got / total) * 1000) / 1000 : 0;
  return { slice, profiles: [...new Set(profiles)], score, failed, needsConformance: needs };
}
