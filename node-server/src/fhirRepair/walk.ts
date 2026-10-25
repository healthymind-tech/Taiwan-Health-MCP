/**
 * StructureDefinition-driven instance walk of the repair layer: every property of a resource is
 * located on its element definitions — the core definition of the resource type (which decides
 * what is a known property) plus every resolvable profile (meta.profile and the caller's
 * profiles), with the slices the discriminators identify (fhirAuthoring.decidedSliceMatch:
 * decided only, never guessed), choice types, backbone elements, contentReference, datatype
 * definitions (type.profile, else the core datatype) and contained resources.
 *
 * The walk only reads; the rules (shape.ts, units.ts, …) decide and write.
 */

import { decidedSliceMatch, projectedById } from "../fhirAuthoring.js";
import { SdIdx, typeCodeOf, type Group } from "../fhirBundleFinalize.js";
import type { ProjectedElement } from "../fhirRequiredElements.js";
import { isRawNumber } from "../losslessJson.js";
import type { NormalizeCandidate, RepairDeps } from "./types.js";

export const CORE = "http://hl7.org/fhir/StructureDefinition/";

export const PRIMITIVES = new Set([
  "boolean", "integer", "integer64", "unsignedInt", "positiveInt", "decimal", "string", "markdown", "xhtml", "code", "id",
  "uri", "url", "canonical", "oid", "uuid", "base64Binary", "date", "dateTime", "instant", "time",
]);

export const QUANTITY_TYPES = new Set(["Quantity", "SimpleQuantity", "Age", "Duration", "Count", "Distance", "MoneyQuantity"]);

type El = Record<string, any>;

/** A JSON object (a lossless RawNumber is a scalar). */
export function isObject(v: unknown): v is Record<string, any> {
  return v !== null && typeof v === "object" && !Array.isArray(v) && !isRawNumber(v);
}

export interface View {
  url: string;
  sdx: SdIdx;
  E: Map<string, ProjectedElement>;
}

/** Caches and budgets shared by every resource of one tool call. */
export class Session {
  private readonly views = new Map<string, Promise<View | null>>();
  private readonly memos = new Map<string, Promise<unknown>>();
  /** fhir_normalize_code calls left (R1 different-meaning test + candidates; v14.1: 60, so a large Bundle's displays all get candidates). */
  normalizeLeft = 60;
  /** Terminology display checks left. */
  displayChecksLeft = 80;

  constructor(readonly deps: RepairDeps) {}

  view(url: string): Promise<View | null> {
    const key = String(url || "").trim();
    if (!key) return Promise.resolve(null);
    let p = this.views.get(key);
    if (!p) {
      p = this.deps
        .fetchStructureDefinition(key)
        .then((sd) => {
          if (!sd || !isObject(sd) || !isObject(sd.snapshot) || !Array.isArray(sd.snapshot.element) || !sd.snapshot.element.length) return null;
          return { url: String(sd.url || key).split("|")[0], sdx: new SdIdx(sd), E: projectedById(sd) };
        })
        .catch(() => null);
      this.views.set(key, p);
    }
    return p;
  }

  /** Memoised async question (same key → one call; a failure answers `fallback`). */
  memo<T>(key: string, fn: () => Promise<T>, fallback: T): Promise<T> {
    let p = this.memos.get(key) as Promise<T> | undefined;
    if (!p) {
      p = fn().catch(() => fallback);
      this.memos.set(key, p);
    }
    return p;
  }

  async normalize(text: string, target: { system?: string; valueSet?: string }, limit: number): Promise<NormalizeCandidate[] | null> {
    if (!this.deps.normalize) return null;
    const key = `norm\0${text}\0${target.system ?? ""}\0${target.valueSet ?? ""}\0${limit}`;
    if (!this.memos.has(key)) {
      if (this.normalizeLeft <= 0) return null;
      this.normalizeLeft--;
    }
    return this.memo<NormalizeCandidate[] | null>(key, () => this.deps.normalize!(text, target, limit), null);
  }
}

export interface Member {
  view: View;
  /** Element ids (base + decided slices) of this node in that view. */
  ids: string[];
}

export interface Site {
  /** Resource-rooted instance path (`Observation.component[0].valueQuantity`). */
  path: string;
  holder: Record<string, any>;
  key: string;
  /** Array position (null = single value). */
  index: number | null;
  value: unknown;
  /** FHIR type code of the value (choice: the suffix type; "" = unknown). */
  type: string;
  /** Element definitions of this value (every view: base + decided slices). */
  defs: El[];
  /** Per view: the element ids, so child definitions can be looked up. */
  members: Member[];
  /** Not a property of the core definition (Unrecognized property). */
  unknown: boolean;
  /** Path / type / members of the object holding `key`. */
  ownerPath: string;
  ownerType: string;
  ownerMembers: Member[];
  /** Root of the resource this site lives in (contained resources are their own roots). */
  resource: Record<string, any>;
  resourcePath: string;
}

const MAX_DEPTH = 40;
const MAX_SITES = 6000;

/** Allowed type codes of a definition (choice type slices with max 0 removed are not filtered — the validator reports those). */
export function typeCodes(def: El | null | undefined): string[] {
  return def && Array.isArray(def.type) ? def.type.filter(isObject).map(typeCodeOf).filter(Boolean) : [];
}

/** Base cardinality max of a definition ("1" / "*" / n). */
export function baseMax(def: El | null | undefined): string {
  if (!def) return "*";
  const b = isObject(def.base) && def.base.max !== undefined ? def.base.max : def.max;
  return String(b ?? "*");
}

export function repeats(def: El | null | undefined): boolean {
  const m = baseMax(def);
  return m === "*" || (/^\d+$/.test(m) && Number(m) > 1);
}

/** The group a JSON key belongs to under `groups` (exact name, else a choice stem + allowed type suffix). */
export function groupFor(groups: Map<string, Group>, key: string): { grp: Group; type: string; choice: boolean } | null {
  const exact = groups.get(key);
  if (exact && !key.endsWith("[x]")) {
    const def = exact.base || exact.slices[0];
    const types = typeCodes(def);
    return { grp: exact, type: types[0] || (def && def.contentReference ? "BackboneElement" : ""), choice: false };
  }
  for (const grp of groups.values()) {
    if (!grp.name.endsWith("[x]")) continue;
    const stem = grp.name.slice(0, -3);
    if (!key.startsWith(stem) || key.length === stem.length || !/[A-Z]/.test(key[stem.length])) continue;
    const suffix = key.slice(stem.length);
    const def = grp.base || grp.slices[0];
    // SimpleQuantity / MoneyQuantity are Quantity profiles: their JSON suffix is "Quantity".
    const jsonSuffix = (a: string): string => (a === "SimpleQuantity" || a === "MoneyQuantity" ? "Quantity" : a[0].toUpperCase() + a.slice(1));
    const t = typeCodes(def).find((a) => jsonSuffix(a) === suffix);
    if (t) return { grp, type: t, choice: true };
  }
  return null;
}

/** Definition of `name` under a node's members (first view that defines it), with its type. */
export function childDefs(members: Member[], name: string): El[] {
  const out: El[] = [];
  for (const m of members) {
    for (const id of m.ids) {
      const groups = m.view.sdx.childrenOfId(id);
      if (!groups) continue;
      const hit = groupFor(groups, name) ?? (groups.get(name) ? { grp: groups.get(name)!, type: "", choice: false } : null);
      if (!hit) continue;
      if (hit.grp.base) out.push(hit.grp.base);
      // slices of a choice element named by the JSON key (value[x]:valueQuantity)
      for (const s of hit.grp.slices) if (hit.choice && (s.sliceName === name || String(s.id).endsWith(`:${name}`))) out.push(s);
    }
  }
  return out;
}

export interface WalkOptions {
  profiles?: string[];
}

/** Profile canonicals to walk a resource with (meta.profile first, then the caller's), at most 3. */
function profilesOf(res: Record<string, any>, extra: string[] = []): string[] {
  const out: string[] = [];
  const metas = isObject(res.meta) && Array.isArray(res.meta.profile) ? res.meta.profile : [];
  for (const p of [...metas, ...extra]) if (typeof p === "string" && p.trim() && !out.includes(p.trim())) out.push(p.trim());
  return out.slice(0, 3);
}

/**
 * All sites of a resource (document order, merged over the views). `path` is the resource's own
 * root path (its resourceType for a top-level resource).
 */
export async function walkResource(session: Session, resource: Record<string, any>, opts: WalkOptions = {}, path: string | null = null): Promise<Site[]> {
  const out = new Map<string, Site>();
  const order: string[] = [];
  await walkInto(session, resource, path ?? String(resource.resourceType || ""), opts.profiles || [], out, order, 0);
  return order.map((p) => out.get(p)!);
}

async function walkInto(session: Session, resource: Record<string, any>, root: string, extraProfiles: string[], out: Map<string, Site>, order: string[], depth: number): Promise<void> {
  const rt = typeof resource.resourceType === "string" ? resource.resourceType : "";
  if (!rt || depth > 4) return;
  // The core definition decides what is a known property; without it (no core package) the first
  // profile takes that role.
  const views: View[] = [];
  const core = await session.view(CORE + rt);
  if (core) views.push(core);
  for (const p of profilesOf(resource, extraProfiles)) {
    const v = (await session.view(p)) ?? (p.includes("|") ? await session.view(p.split("|")[0]) : null);
    if (v && v.sdx.type === rt && !views.some((x) => x.url === v.url)) views.push(v);
  }
  if (!views.length) return;
  const contained: Array<[Record<string, any>, string]> = [];
  for (const [vi, view] of views.entries()) {
    const ctx: Ctx = { session, out, order, isCore: vi === 0, resource, resourcePath: root, contained };
    await walkNode(ctx, view, [String(view.sdx.root.id || rt)], resource, root, rt, 0);
  }
  for (const [c, p] of contained) await walkInto(session, c, p, [], out, order, depth + 1);
}

interface Ctx {
  session: Session;
  out: Map<string, Site>;
  order: string[];
  isCore: boolean;
  resource: Record<string, any>;
  resourcePath: string;
  contained: Array<[Record<string, any>, string]>;
}

function addSite(ctx: Ctx, site: Site): void {
  const cur = ctx.out.get(site.path);
  if (!cur) {
    if (ctx.order.length >= MAX_SITES) return;
    ctx.out.set(site.path, site);
    ctx.order.push(site.path);
    return;
  }
  for (const d of site.defs) if (!cur.defs.includes(d)) cur.defs.push(d);
  cur.members.push(...site.members);
  if (!cur.type && site.type) cur.type = site.type;
  if (cur.unknown && !site.unknown && ctx.isCore) cur.unknown = false;
}

async function walkNode(ctx: Ctx, view: View, ids: string[], node: Record<string, any>, path: string, type: string, depth: number): Promise<void> {
  if (depth > MAX_DEPTH) return;
  let groupsList = ids.map((id) => view.sdx.childrenOfId(id)).filter((g): g is Map<string, Group> => !!g && g.size > 0);
  let members: Member[] = [{ view, ids }];
  if (!groupsList.length) {
    // No inline children: the datatype's own definition (type.profile when the definition names one).
    if (!type || !/^[A-Z]/.test(type) || type === "Resource" || type === "DomainResource") return;
    const def = ids.map((id) => view.sdx.byId.get(id)).find(Boolean);
    const prof = def ? (def.type || []).find((t: any) => isObject(t) && typeCodeOf(t) === type && Array.isArray(t.profile) && t.profile.length)?.profile?.[0] : undefined;
    const dt = (typeof prof === "string" ? await ctx.session.view(prof) : null) ?? (await ctx.session.view(CORE + type));
    if (!dt) return;
    view = dt;
    ids = [String(dt.sdx.root.id || type)];
    members = [{ view, ids }];
    groupsList = ids.map((id) => view.sdx.childrenOfId(id)).filter((g): g is Map<string, Group> => !!g && g.size > 0);
    if (!groupsList.length) return;
  }
  for (const key of Object.keys(node)) {
    if (key === "resourceType" || key.startsWith("_") || key === "fhir_comments") continue;
    let hit: { grp: Group; type: string; choice: boolean } | null = null;
    for (const g of groupsList) {
      hit = groupFor(g, key);
      if (hit) break;
    }
    const raw = node[key];
    const items: Array<[unknown, number | null]> = Array.isArray(raw) ? raw.map((v, i) => [v, i]) : [[raw, null]];
    if (!hit) {
      if (!ctx.isCore) continue;
      for (const [v, i] of items) {
        addSite(ctx, {
          path: i === null ? `${path}.${key}` : `${path}.${key}[${i}]`, holder: node, key, index: i, value: v, type: "", defs: [], members: [], unknown: true,
          ownerPath: path, ownerType: type, ownerMembers: members, resource: ctx.resource, resourcePath: ctx.resourcePath,
        });
      }
      continue;
    }
    const { grp, type: t } = hit;
    // Every group of the same name across the node's ids (base + slices of each id).
    const groups: Group[] = [];
    for (const g of groupsList) {
      const x = groupFor(g, key);
      if (x && !groups.includes(x.grp)) groups.push(x.grp);
    }
    if (!groups.includes(grp)) groups.unshift(grp);
    for (const [v, i] of items) {
      const ipath = i === null ? `${path}.${key}` : `${path}.${key}[${i}]`;
      const defs: El[] = [];
      for (const g of groups) {
        if (g.base) defs.push(g.base);
        for (const s of g.slices) {
          let match = false;
          try {
            match = decidedSliceMatch(v, key, String(s.id), view.E);
          } catch {
            match = false;
          }
          if (match) defs.push(s);
        }
      }
      if (!defs.length && grp.slices[0]) defs.push(grp.slices[0]);
      addSite(ctx, {
        path: ipath, holder: node, key, index: i, value: v, type: t, defs: [...defs], members: [{ view, ids: defs.map((d) => String(d.id || d.path)) }], unknown: false,
        ownerPath: path, ownerType: type, ownerMembers: members, resource: ctx.resource, resourcePath: ctx.resourcePath,
      });
      if (!isObject(v) || PRIMITIVES.has(t)) continue;
      // Embedded resources (contained, Parameters.parameter.resource …) are walked as their own roots.
      if (typeof v.resourceType === "string" && (t === "Resource" || t === "DomainResource" || key === "contained")) {
        if (key === "contained" && ctx.isCore) ctx.contained.push([v, ipath]);
        continue;
      }
      let childIds = defs.map((d) => String(d.id || d.path)).filter((id) => (view.sdx.childrenOfId(id)?.size ?? 0) > 0);
      if (!childIds.length) {
        const cr = defs.map((d) => d.contentReference).find((c) => typeof c === "string" && c);
        if (cr) childIds = [String(cr).replace(/^.*#/, "")];
      }
      await walkNode(ctx, view, childIds.length ? childIds : defs.map((d) => String(d.id || d.path)), v, ipath, t, depth + 1);
    }
  }
}

/** Replace `site`'s value in its holder (array position kept). */
export function setSiteValue(site: Site, value: unknown): void {
  if (site.index === null) site.holder[site.key] = value;
  else (site.holder[site.key] as unknown[])[site.index] = value;
}

/** Reported path: the resource root replaced by the caller's prefix (`Bundle.entry[2].resource`). */
export function reportPath(rootType: string, rootPath: string | undefined, path: string): string {
  if (!rootPath) return path;
  if (path === rootType) return rootPath;
  return path.startsWith(`${rootType}.`) || path.startsWith(`${rootType}[`) ? rootPath + path.slice(rootType.length) : path;
}

/** Deep clone keeping RawNumber instances (frozen scalars) — so a lossless tree stays lossless. */
export function cloneTree<T>(v: T): T {
  if (Array.isArray(v)) return v.map((x) => cloneTree(x)) as unknown as T;
  if (isObject(v)) {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) o[k] = cloneTree(x);
    return o as T;
  }
  return v;
}

/** Replace key `from` of `obj` by `to` with `value`, keeping the key's position. */
export function replaceKey(obj: Record<string, any>, from: string, to: string, value: unknown): void {
  const entries = Object.entries(obj);
  for (const k of Object.keys(obj)) delete obj[k];
  for (const [k, v] of entries) {
    if (k === from) obj[to] = value;
    else if (k !== to) obj[k] = v;
  }
}

/** Insert `key` into `obj` before the first of `before` present (else at the end). */
export function insertKey(obj: Record<string, any>, key: string, value: unknown, before: string[] = []): void {
  if (key in obj) {
    obj[key] = value;
    return;
  }
  const entries = Object.entries(obj);
  const at = entries.findIndex(([k]) => before.includes(k));
  if (at < 0) {
    obj[key] = value;
    return;
  }
  for (const k of Object.keys(obj)) delete obj[k];
  entries.splice(at, 0, [key, value]);
  for (const [k, v] of entries) obj[k] = v;
}
