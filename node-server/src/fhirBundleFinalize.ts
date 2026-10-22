/**
 * Bundle finalizer: deterministic normalisation of a FHIR Bundle's entry.fullUrl,
 * Reference strings, Bundle.id / resource.id and (when a Bundle profile fixes it)
 * Bundle.type / document entry order. IG-agnostic: every rule comes from the FHIR R4
 * core specification or from the StructureDefinitions the caller's resolver hands out.
 *
 * Shared by fhir_finalize_bundle, fhir_validate_bundle (normalize_ids / id suggestions)
 * and fhir_build_bundle. Pure apart from the injected StructureDefinition lookup.
 *
 * Guarantees:
 *  - the input is never mutated (deep clone, key order preserved);
 *  - nothing but fullUrl, Reference.reference strings, entry resource.id, Bundle.id,
 *    Bundle.type (profile-fixed, or requested through opts.bundleType) and entry order
 *    (document) is ever changed; numbers keep the caller's spelling when the tool layer hands
 *    in the lossless tree of the request (losslessFinalizedBundle, losslessJson.ts);
 *  - the same input always yields the same output (UUID v5 over a fixed namespace, seeded
 *    by the entry's resourceType / original fullUrl / resource.id / position plus a
 *    bundle-level salt = SHA-256 of the bundle with the rewritable fields stripped), and a
 *    finalized Bundle yields `changes: []`;
 *  - what cannot be decided (duplicate fullUrl, a reference with no or several matching
 *    entries) is reported with candidates, never guessed.
 *
 * Reference elements are located by walking each resource against its StructureDefinition
 * snapshot (meta.profile when resolvable, else the core definition): choice elements,
 * extensions (resolved by url / slice), complex datatypes (Identifier.assigner,
 * Annotation.author[x] …), backbone elements, contentReference, contained resources.
 * Property names alone are only used when no definition is available at all.
 */

import { createHash } from "node:crypto";
import { isRawNumber, restoreNumbers } from "./losslessJson.js";

// --------------------------------------------------------------------------- //
// Public types
// --------------------------------------------------------------------------- //

export type FinalizeRule = "fullUrl-uuid" | "reference-rewire" | "resource-id" | "bundle-type" | "document-order";

export interface FinalizeChange {
  /** Instance path in the validator's dotted form (`Bundle.entry[0].fullUrl`, `Bundle.entry[1].resource.subject.reference`). */
  path: string;
  from: unknown;
  to: unknown;
  rule: FinalizeRule;
  /** Why (only where a rule has several triggers: bundle-type requested by the caller). */
  reason?: string;
}

/** FHIR R4 Bundle.type value set (http://hl7.org/fhir/ValueSet/bundle-type), in specification order. */
export const BUNDLE_TYPES = ["document", "message", "transaction", "transaction-response", "batch", "batch-response", "history", "searchset", "collection"] as const;
export type BundleType = (typeof BUNDLE_TYPES)[number];

export interface FinalizeUnresolved {
  path: string;
  reference: string;
  /** fullUrls of the entries that could be meant (same target resource type), in entry order. */
  candidates: string[];
  reason: string;
}

export interface FinalizeResult {
  bundle: Record<string, any>;
  changes: FinalizeChange[];
  unresolved: FinalizeUnresolved[];
  notes: string[];
  /** Old fullUrl / id value → new value (every value that references must follow). */
  id_map: Record<string, string>;
}

export interface FinalizeDeps {
  /** StructureDefinition by canonical URL (may carry `|version`); null when not held. */
  fetchStructureDefinition(url: string): Promise<Record<string, any> | null>;
}

export interface FinalizeOptions {
  /** Canonical of the target Bundle profile (else the Bundle's own meta.profile is tried). */
  bundleProfile?: string | null;
  /** Extra names an entry may be referenced by (fhir_build_bundle keys): entry index → names. */
  aliases?: Map<number, string[]>;
  /**
   * Bundle.type the caller asks for (R4 value set). Applied as rule `bundle-type` ("requested by
   * caller") unless the resolved Bundle profile fixes the type — then the profile wins and a note
   * reports the conflict. Never part of the salt, so UUIDs do not depend on it.
   */
  bundleType?: string | null;
}

/** One Bundle.type the entries' shape suggests (fhir_validate_bundle document suggestions, finalize notes). */
export interface BundleTypeCandidate {
  type: BundleType;
  /** Heuristic confidence in [0, 1], by the evidence in `reason`. */
  confidence: number;
  reason: string;
}

/** Bundle-level core rules for fhir_get_profile_required_elements (R4). */
export interface BundleRules {
  source: string[];
  fullUrl: string;
  references: string;
  ids: string;
  bundle_type: string;
  fixed_type: string | null;
  entry_order: string | null;
  required_elements: string[];
  required_entries: Array<{ slice: string; min: number; max: string; profile: string | null }>;
  finalize: string;
}

// --------------------------------------------------------------------------- //
// Constants / small helpers
// --------------------------------------------------------------------------- //

const CORE = "http://hl7.org/fhir/StructureDefinition/";
/** Fixed namespace of every UUID this engine mints (UUID v5 over SHA-1). */
export const FINALIZE_UUID_NAMESPACE = "3e1c5f6a-7b2d-4c8e-9a0f-1d2b3c4d5e6f";

const UUID_FULLURL = /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OID_FULLURL = /^urn:oid:[0-2](\.(0|[1-9][0-9]*))+$/;
const HTTP_FULLURL = /^https?:\/\/\S+$/;
const ABSOLUTE_URI = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const ID_RE = /^[A-Za-z0-9\-.]{1,64}$/;
const RESTFUL_REF = /^([A-Z][A-Za-z]+)\/([^/]+)$/;
const HISTORY_RE = /^(.*)\/_history\/([^/]+)$/;
const FHIR_TYPE_EXT = "http://hl7.org/fhir/StructureDefinition/structuredefinition-fhir-type";

const PRIMITIVES = new Set([
  "boolean", "integer", "integer64", "unsignedInt", "positiveInt", "decimal", "string", "markdown", "xhtml", "code", "id",
  "uri", "url", "canonical", "oid", "uuid", "base64Binary", "date", "dateTime", "instant", "time",
]);
const COMPLEX_TYPES = new Set([
  "Address", "Age", "Annotation", "Attachment", "CodeableConcept", "Coding", "ContactPoint", "Count", "Distance", "Duration",
  "HumanName", "Identifier", "Money", "MoneyQuantity", "Period", "Quantity", "Range", "Ratio", "Reference", "SampledData",
  "Signature", "SimpleQuantity", "Timing", "ContactDetail", "Contributor", "DataRequirement", "Expression",
  "ParameterDefinition", "RelatedArtifact", "TriggerDefinition", "UsageContext", "Dosage", "Meta", "Narrative", "Extension",
  "ElementDefinition", "MarketingStatus", "Population", "ProdCharacteristic", "ProductShelfLife", "SubstanceAmount",
  "BackboneElement", "Element",
]);
const KNOWN_TYPE_BY_SUFFIX = new Map<string, string>();
for (const t of [...PRIMITIVES, ...COMPLEX_TYPES]) KNOWN_TYPE_BY_SUFFIX.set(t[0].toUpperCase() + t.slice(1), t);

const MAX_DEPTH = 60;
const MAX_CANDIDATES = 10;

/** A JSON object — a lossless RawNumber (losslessJson.ts) is a scalar, never walked into. */
function isObject(v: unknown): v is Record<string, any> {
  return v !== null && typeof v === "object" && !Array.isArray(v) && !isRawNumber(v);
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function typeCodeOf(t: Record<string, any>): string {
  const code = String(t.code || "");
  for (const ext of t.extension || []) {
    if (isObject(ext) && ext.url === FHIR_TYPE_EXT) return String(ext.valueUrl ?? ext.valueUri ?? ext.valueString ?? code);
  }
  if (code.startsWith("http://hl7.org/fhirpath/System.")) return "string";
  return code;
}

/** Last path segment of a urn / url (`urn:uuid:patient-1` → `patient-1`, `http://x/Patient/1` → `1`). */
function lastSegment(s: string): string {
  const parts = s.split(/[:/]/).filter((p) => p !== "");
  return parts.length ? parts[parts.length - 1] : s;
}

function validFullUrl(u: unknown): u is string {
  return typeof u === "string" && (UUID_FULLURL.test(u) || OID_FULLURL.test(u) || HTTP_FULLURL.test(u));
}

/** JSON with sorted keys (stable across key order) — only for hashing. */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(stableJson).join(",") + "]";
  if (isObject(v)) {
    return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stableJson(v[k])).join(",") + "}";
  }
  return JSON.stringify(v) ?? "null";
}

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** RFC 4122 UUID v5 (SHA-1) of `name` under `namespace`, lowercase. */
export function uuidV5(namespace: string, name: string): string {
  const ns = Buffer.from(namespace.replace(/-/g, ""), "hex");
  const h = createHash("sha1").update(ns).update(Buffer.from(name, "utf8")).digest();
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

/**
 * Bundle-level salt: SHA-256 of the Bundle with every rewritable field stripped
 * (fullUrl, `reference` strings, entry resource.id, Bundle.id, Bundle.type, entry order),
 * so the salt is invariant under the engine's own changes while different bundles
 * get different UUIDs.
 */
export function bundleSalt(bundle: Record<string, any>): string {
  const strip = (v: unknown, dropId: boolean): unknown => {
    if (Array.isArray(v)) return v.map((x) => strip(x, false));
    if (!isObject(v)) return v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (k === "reference" && typeof x === "string") continue;
      if (dropId && k === "id") continue;
      out[k] = strip(x, false);
    }
    return out;
  };
  const entries = (Array.isArray(bundle.entry) ? bundle.entry : [])
    .map((e: unknown) => {
      if (!isObject(e)) return stableJson(e);
      const { fullUrl: _fu, resource, ...rest } = e;
      return stableJson({ ...strip(rest, false) as Record<string, unknown>, resource: isObject(resource) ? strip(resource, true) : resource });
    })
    .sort();
  const { id: _id, type: _type, entry: _entry, ...rest } = bundle;
  return sha256(stableJson({ ...(strip(rest, false) as Record<string, unknown>), entry: entries }));
}

// --------------------------------------------------------------------------- //
// StructureDefinition index (children by element id, slices grouped)
// --------------------------------------------------------------------------- //

interface Group {
  name: string;
  base: Record<string, any> | null;
  slices: Array<Record<string, any>>;
}

class SdIdx {
  readonly url: string;
  readonly type: string;
  readonly kind: string;
  readonly root: Record<string, any>;
  readonly byId = new Map<string, Record<string, any>>();
  private readonly groups = new Map<string, Map<string, Group>>();

  constructor(readonly sd: Record<string, any>) {
    this.url = String(sd.url || "").split("|")[0];
    this.type = String(sd.type || "");
    this.kind = String(sd.kind || "");
    const els: Array<Record<string, any>> = (sd.snapshot || {}).element || [];
    this.root = els[0] || { id: this.type, path: this.type };
    for (const el of els) {
      const id = String(el.id || el.path || "");
      this.byId.set(id, el);
      if (el === els[0]) continue;
      const segs = id.split(".");
      const last = segs[segs.length - 1];
      if (segs.slice(0, -1).some((s) => s.includes("/"))) continue;
      const parentId = segs.slice(0, -1).join(".");
      const colon = last.indexOf(":");
      const name = colon >= 0 ? last.slice(0, colon) : last;
      const sliceName = colon >= 0 ? last.slice(colon + 1) : null;
      if (sliceName && sliceName.includes("/")) continue;
      let g = this.groups.get(parentId);
      if (!g) {
        g = new Map();
        this.groups.set(parentId, g);
      }
      let grp = g.get(name);
      if (!grp) {
        grp = { name, base: null, slices: [] };
        g.set(name, grp);
      }
      if (sliceName) grp.slices.push(el);
      else grp.base = el;
    }
  }

  children(el: Record<string, any>): Map<string, Group> | undefined {
    return this.groups.get(String(el.id || el.path || ""));
  }

  hasChildren(el: Record<string, any>): boolean {
    const g = this.children(el);
    return !!g && g.size > 0;
  }
}

// --------------------------------------------------------------------------- //
// Reference discovery (StructureDefinition-driven)
// --------------------------------------------------------------------------- //

interface RefSite {
  /** Path of the Reference element (the change path is `${path}.reference`). */
  path: string;
  holder: Record<string, any>;
  /** Resource types the element may target (null = any / unknown). */
  targetTypes: Set<string> | null;
  /** Entry the reference lives in (-1 for the Bundle root). */
  entryIndex: number;
}

class RefFinder {
  private readonly sdCache = new Map<string, Promise<SdIdx | null>>();
  private readonly typeCache = new Map<string, Promise<string | null>>();
  readonly notes: string[] = [];
  private noDefinition = new Set<string>();

  constructor(private readonly deps: FinalizeDeps | null) {}

  sdx(url: string): Promise<SdIdx | null> {
    const key = String(url || "").trim();
    if (!key || !this.deps) return Promise.resolve(null);
    let p = this.sdCache.get(key);
    if (!p) {
      p = this.deps
        .fetchStructureDefinition(key)
        .then((sd) => (sd && isObject(sd) && isObject(sd.snapshot) && Array.isArray(sd.snapshot.element) && sd.snapshot.element.length ? new SdIdx(sd) : null))
        .catch(() => null);
      this.sdCache.set(key, p);
    }
    return p;
  }

  /** Resource type a target profile canonical constrains (null = any / unknown). */
  private targetType(canonical: string): Promise<string | null> {
    let p = this.typeCache.get(canonical);
    if (!p) {
      p = (async (): Promise<string | null> => {
        const bare = canonical.split("|")[0];
        if (bare.startsWith(CORE)) {
          const t = bare.slice(CORE.length);
          if (t === "Resource" || t === "DomainResource") return null;
          if (/^[A-Z][A-Za-z]+$/.test(t)) return t;
        }
        const s = await this.sdx(canonical);
        if (!s) return null;
        if (!s.type || s.type === "Resource" || s.type === "DomainResource") return null;
        return s.type;
      })();
      this.typeCache.set(canonical, p);
    }
    return p;
  }

  private async targetTypesOf(def: Record<string, any>): Promise<Set<string> | null> {
    const out = new Set<string>();
    for (const t of def.type || []) {
      if (!isObject(t) || typeCodeOf(t) !== "Reference") continue;
      const profiles: unknown[] = Array.isArray(t.targetProfile) ? t.targetProfile : [];
      if (!profiles.length) return null;
      for (const p of profiles) {
        if (typeof p !== "string" || !p) return null;
        const rt = await this.targetType(p);
        if (rt === null) return null;
        out.add(rt);
      }
    }
    return out.size ? out : null;
  }

  /** Definition to walk a resource with: its first resolvable meta.profile, else the core type. */
  private async resourceSdx(res: Record<string, any>): Promise<SdIdx | null> {
    const rt = String(res.resourceType || "");
    const metas: unknown[] = isObject(res.meta) && Array.isArray(res.meta.profile) ? res.meta.profile : [];
    for (const m of metas.slice(0, 2)) {
      if (typeof m !== "string" || !m) continue;
      const s = (await this.sdx(m)) ?? (m.includes("|") ? await this.sdx(m.split("|")[0]) : null);
      if (s && s.type === rt) return s;
    }
    return this.sdx(CORE + rt);
  }

  async walkResource(res: Record<string, any>, path: string, entryIndex: number, out: RefSite[], depth: number): Promise<void> {
    if (depth > MAX_DEPTH) return;
    const rt = typeof res.resourceType === "string" ? res.resourceType : "";
    if (!rt) return;
    const sdx = await this.resourceSdx(res);
    if (!sdx) {
      if (!this.noDefinition.has(rt)) {
        this.noDefinition.add(rt);
        this.notes.push(`No StructureDefinition available for ${rt}: its references were located by property name only`);
      }
      nameWalk(res, path, entryIndex, out);
      return;
    }
    await this.walkChildren(sdx, sdx.root, res, path, entryIndex, out, depth);
  }

  async walkChildren(sdx: SdIdx, el: Record<string, any>, node: Record<string, any>, path: string, entryIndex: number, out: RefSite[], depth: number): Promise<void> {
    if (depth > MAX_DEPTH) return;
    const groups = sdx.children(el);
    if (!groups || groups.size === 0) return;
    for (const grp of groups.values()) {
      const def = grp.base || grp.slices[0];
      if (!def) continue;
      const name = grp.name;
      const allowed: string[] = (def.type || []).filter(isObject).map(typeCodeOf);
      const present: Array<[string, string]> = [];
      if (name.endsWith("[x]")) {
        const stem = name.slice(0, -3);
        for (const key of Object.keys(node)) {
          if (!key.startsWith(stem) || key.length === stem.length || !/[A-Z]/.test(key[stem.length]) || groups.has(key)) continue;
          const suffix = key.slice(stem.length);
          const t = allowed.find((a) => a[0].toUpperCase() + a.slice(1) === suffix) ?? KNOWN_TYPE_BY_SUFFIX.get(suffix);
          if (t) present.push([key, t]);
        }
      } else if (name in node) {
        present.push([name, allowed[0] || (def.contentReference ? "BackboneElement" : "")]);
      }
      for (const [key, typeCode] of present) {
        const raw = node[key];
        const items: Array<[unknown, string]> = Array.isArray(raw) ? raw.map((v, i) => [v, `${path}.${key}[${i}]`]) : [[raw, `${path}.${key}`]];
        for (const [value, ipath] of items) await this.handleItem(sdx, def, grp, value, ipath, typeCode, entryIndex, out, depth + 1);
      }
    }
  }

  private async handleItem(sdx: SdIdx, def: Record<string, any>, grp: Group, value: unknown, path: string, typeCode: string, entryIndex: number, out: RefSite[], depth: number): Promise<void> {
    if (!isObject(value) || PRIMITIVES.has(typeCode)) return;
    if (typeCode === "Reference") {
      out.push({ path, holder: value, targetTypes: await this.targetTypesOf(def), entryIndex });
      return;
    }
    if (typeCode === "Extension") {
      await this.walkExtension(sdx, def, grp, value, path, entryIndex, out, depth);
      return;
    }
    // Embedded resource (contained, Bundle.entry.resource, Parameters.parameter.resource …).
    if (typeof value.resourceType === "string" && !COMPLEX_TYPES.has(typeCode)) {
      if (value.resourceType === "Bundle") {
        this.notes.push(`Nested Bundle at ${path} was not traversed (its references are resolved against its own entries)`);
        return;
      }
      await this.walkResource(value, path, entryIndex, out, depth);
      return;
    }
    if (sdx.hasChildren(def)) {
      await this.walkChildren(sdx, def, value, path, entryIndex, out, depth);
      return;
    }
    if (def.contentReference) {
      const target = sdx.byId.get(String(def.contentReference).replace(/^.*#/, ""));
      if (target) await this.walkChildren(sdx, target, value, path, entryIndex, out, depth);
      return;
    }
    if (!typeCode || !/^[A-Z]/.test(typeCode)) return;
    const profile = (def.type || []).find((t: any) => isObject(t) && typeCodeOf(t) === typeCode && Array.isArray(t.profile) && t.profile.length)?.profile?.[0];
    const tsdx = (typeof profile === "string" ? await this.sdx(profile) : null) ?? (await this.sdx(CORE + typeCode));
    if (tsdx) await this.walkChildren(tsdx, tsdx.root, value, path, entryIndex, out, depth);
  }

  /** An extension instance: its slice (by url) or its definition (by url), else the core Extension type. */
  private async walkExtension(sdx: SdIdx, def: Record<string, any>, grp: Group, value: Record<string, any>, path: string, entryIndex: number, out: RefSite[], depth: number): Promise<void> {
    const url = typeof value.url === "string" ? value.url : "";
    // A slice of this group whose url is fixed to the instance url and that defines children inline.
    for (const s of grp.slices) {
      const urlEl = sdx.byId.get(`${s.id}.url`);
      const fixed = urlEl ? urlEl.fixedUri ?? urlEl.fixedUrl ?? urlEl.patternUri : undefined;
      if (url && fixed === url && sdx.hasChildren(s)) {
        await this.walkChildren(sdx, s, value, path, entryIndex, out, depth);
        return;
      }
      const prof = (s.type || []).find((t: any) => isObject(t) && Array.isArray(t.profile) && t.profile.length)?.profile?.[0];
      if (url && typeof prof === "string") {
        const esdx = await this.sdx(prof);
        if (esdx && esdx.url === url.split("|")[0]) {
          await this.walkChildren(esdx, esdx.root, value, path, entryIndex, out, depth);
          return;
        }
      }
    }
    if (sdx.hasChildren(def)) {
      await this.walkChildren(sdx, def, value, path, entryIndex, out, depth);
      return;
    }
    const own = url && ABSOLUTE_URI.test(url) ? await this.sdx(url) : null;
    const esdx = own ?? (await this.sdx(CORE + "Extension"));
    if (esdx) await this.walkChildren(esdx, esdx.root, value, path, entryIndex, out, depth);
    else nameWalk(value, path, entryIndex, out);
  }
}

/** Fallback when no definition is available: every object carrying a string `reference`. */
function nameWalk(node: unknown, path: string, entryIndex: number, out: RefSite[]): void {
  if (Array.isArray(node)) {
    node.forEach((v, i) => nameWalk(v, `${path}[${i}]`, entryIndex, out));
    return;
  }
  if (!isObject(node)) return;
  if (typeof node.reference === "string") out.push({ path, holder: node, targetTypes: null, entryIndex });
  for (const [k, v] of Object.entries(node)) {
    if (k === "reference") continue;
    if (Array.isArray(v) || isObject(v)) nameWalk(v, `${path}.${k}`, entryIndex, out);
  }
}

// --------------------------------------------------------------------------- //
// Finalize
// --------------------------------------------------------------------------- //

interface EntryInfo {
  index: number;
  entry: Record<string, any>;
  resource: Record<string, any> | null;
  rt: string;
  oldFullUrl: unknown;
  fullUrl: string | null;
}

function fixedBundleType(sdx: SdIdx): string | null {
  const el = sdx.byId.get("Bundle.type");
  if (!el) return null;
  const v = el.fixedCode ?? el.patternCode;
  return typeof v === "string" && v ? v : null;
}

/** Direct Bundle children a profile requires (min ≥ 1) other than type / entry. */
function requiredBundleChildren(sdx: SdIdx): Array<Record<string, any>> {
  const out: Array<Record<string, any>> = [];
  for (const el of (sdx.sd.snapshot || {}).element || []) {
    const id = String(el.id || "");
    if (!/^Bundle\.[A-Za-z]+$/.test(id) || id === "Bundle.type" || id === "Bundle.entry") continue;
    if (typeof el.min === "number" && el.min >= 1) out.push(el);
  }
  return out;
}

export async function finalizeBundle(input: Record<string, any>, deps: FinalizeDeps | null, opts: FinalizeOptions = {}): Promise<FinalizeResult> {
  if (!isObject(input) || input.resourceType !== "Bundle") throw new TypeError("bundle must be a FHIR Bundle resource");
  const bundle = clone(input);
  const changes: FinalizeChange[] = [];
  const unresolved: FinalizeUnresolved[] = [];
  const notes: string[] = [];
  const idMap: Record<string, string> = {};
  const finder = new RefFinder(deps);

  // ---- 4.6 Bundle.type (profile-fixed) and document order: first, so entry positions are final.
  let bundleSdx: SdIdx | null = null;
  const metaProfiles: unknown[] = isObject(bundle.meta) && Array.isArray(bundle.meta.profile) ? bundle.meta.profile : [];
  for (const cand of [opts.bundleProfile, ...metaProfiles]) {
    if (typeof cand !== "string" || !cand.trim() || !deps) continue;
    const s = await finder.sdx(cand.trim());
    if (s && s.type === "Bundle") {
      bundleSdx = s;
      break;
    }
  }
  const requested = typeof opts.bundleType === "string" && opts.bundleType.trim() ? opts.bundleType.trim() : null;
  if (requested !== null && !(BUNDLE_TYPES as readonly string[]).includes(requested)) {
    throw new TypeError(`bundle_type must be one of ${BUNDLE_TYPES.join(" | ")}`);
  }
  let fixed: string | null = null;
  if (bundleSdx) {
    fixed = fixedBundleType(bundleSdx);
    if (fixed && bundle.type !== fixed) {
      changes.push({ path: "Bundle.type", from: bundle.type ?? null, to: fixed, rule: "bundle-type" });
      bundle.type = fixed;
    }
    for (const el of requiredBundleChildren(bundleSdx)) {
      const name = String(el.id).slice("Bundle.".length);
      if (!(name in bundle)) notes.push(`Bundle.${name} is required by ${bundleSdx.url} (min ${el.min}) but missing; it needs a real value and is not generated`);
    }
  }
  if (requested !== null) {
    if (fixed && requested !== fixed) {
      notes.push(`bundle_type '${requested}' was requested but ${bundleSdx!.url} fixes Bundle.type to '${fixed}'; the profile's value is kept`);
    } else if (!fixed && bundle.type !== requested) {
      changes.push({ path: "Bundle.type", from: bundle.type ?? null, to: requested, rule: "bundle-type", reason: "requested by caller (bundle_type)" });
      bundle.type = requested;
    }
  }
  if (bundle.type === "document" && Array.isArray(bundle.entry)) {
    const k = bundle.entry.findIndex((e: unknown) => isObject(e) && isObject(e.resource) && e.resource.resourceType === "Composition");
    if (k > 0) {
      const [comp] = bundle.entry.splice(k, 1);
      bundle.entry.unshift(comp);
      changes.push({ path: `Bundle.entry[${k}]`, from: `Bundle.entry[${k}]`, to: "Bundle.entry[0]", rule: "document-order" });
    } else if (k < 0 && bundle.entry.length) {
      const alt = fixed ? null : suggestBundleType(bundle)[0];
      notes.push(
        "Bundle.type is document but no entry holds a Composition (bdl-11): " +
          (alt
            ? `either set bundle_type=${alt.type} (${alt.reason}) or add a Composition as the first entry`
            : `add a Composition as the first entry (Bundle.type is fixed to document by ${bundleSdx!.url})`),
      );
    }
  }

  // A stray entry written at Bundle level (fullUrl / resource beside `entry`) is not an id
  // problem and is never moved — but it is the most likely reason for a later
  // "Unrecognized property" error, so say so.
  const strayEntryKeys = ["fullUrl", "resource", "request", "response", "search"].filter((k) => k in bundle);
  if (strayEntryKeys.length) {
    notes.push(
      `Bundle has ${strayEntryKeys.map((k) => `'${k}'`).join(" / ")} at the top level, which Bundle does not define; ` +
        "this looks like an entry written outside the entry array — move it into Bundle.entry (not changed here)",
    );
  }

  // ---- 4.1 fullUrl normalisation.
  const salt = bundleSalt(bundle);
  const rawEntries: unknown[] = Array.isArray(bundle.entry) ? bundle.entry : [];
  const entries: EntryInfo[] = [];
  const oldUses = new Map<string, number>();
  for (const e of rawEntries) if (isObject(e) && typeof e.fullUrl === "string" && e.fullUrl) oldUses.set(e.fullUrl, (oldUses.get(e.fullUrl) ?? 0) + 1);
  rawEntries.forEach((e, index) => {
    if (!isObject(e)) {
      notes.push(`Bundle.entry[${index}] is not an object; left untouched`);
      return;
    }
    const resource = isObject(e.resource) ? e.resource : null;
    const rt = resource && typeof resource.resourceType === "string" ? resource.resourceType : "";
    const old = e.fullUrl;
    let fullUrl: string | null = null;
    if (validFullUrl(old)) fullUrl = old;
    else if (typeof old === "string" && UUID_FULLURL.test(old.toLowerCase())) fullUrl = old.toLowerCase();
    else if (resource) {
      const id = resource.id;
      const seed = [rt || "Resource", typeof old === "string" ? old : "", typeof id === "string" || typeof id === "number" ? String(id) : "", String(index)].join("|");
      fullUrl = `urn:uuid:${uuidV5(FINALIZE_UUID_NAMESPACE, `${salt}|${seed}`)}`;
    } else {
      notes.push(`Bundle.entry[${index}] has no resource; its fullUrl was left untouched`);
    }
    if (fullUrl !== null && fullUrl !== old) {
      changes.push({ path: `Bundle.entry[${index}].fullUrl`, from: old === undefined ? null : old, to: fullUrl, rule: "fullUrl-uuid" });
      if (typeof old === "string" && old && oldUses.get(old) === 1) idMap[old] = fullUrl;
      e.fullUrl = fullUrl;
    }
    entries.push({ index, entry: e, resource, rt, oldFullUrl: old, fullUrl: fullUrl ?? (typeof old === "string" && old ? old : null) });
  });

  // Duplicate fullUrls (bdl-7): reported, never merged.
  const byFullUrl = new Map<string, EntryInfo[]>();
  for (const en of entries) {
    if (!en.fullUrl) continue;
    const list = byFullUrl.get(en.fullUrl) || [];
    list.push(en);
    byFullUrl.set(en.fullUrl, list);
  }
  const duplicated = new Set<string>();
  for (const [fu, list] of byFullUrl) {
    if (list.length > 1) {
      duplicated.add(fu);
      notes.push(`bdl-7: fullUrl ${fu} is used by entries [${list.map((x) => x.index).join(", ")}]; not merged — give each entry its own fullUrl or drop the duplicate`);
    }
  }

  // ---- alias table: every way the model may have named an entry → entry.
  const alias = new Map<string, EntryInfo[]>();
  const aliasLower = new Map<string, EntryInfo[]>();
  const addAlias = (key: string, en: EntryInfo): void => {
    if (!key) return;
    for (const [map, k] of [[alias, key], [aliasLower, key.toLowerCase()]] as Array<[Map<string, EntryInfo[]>, string]>) {
      const list = map.get(k) || [];
      if (!list.includes(en)) list.push(en);
      map.set(k, list);
    }
  };
  for (const en of entries) {
    if (!en.resource) continue;
    const names: string[] = [];
    if (typeof en.oldFullUrl === "string" && en.oldFullUrl) names.push(en.oldFullUrl, lastSegment(en.oldFullUrl));
    if (en.fullUrl) names.push(en.fullUrl, lastSegment(en.fullUrl));
    const id = en.resource.id;
    if (typeof id === "string" || typeof id === "number") names.push(String(id), `urn:uuid:${String(id)}`);
    for (const extra of opts.aliases?.get(en.index) || []) names.push(extra, `urn:uuid:${extra}`);
    for (const n of names) {
      addAlias(n, en);
      if (en.rt && !n.includes(":") && !n.includes("/")) addAlias(`${en.rt}/${n}`, en);
    }
  }
  const lookup = (key: string): EntryInfo[] => alias.get(key) ?? aliasLower.get(key.toLowerCase()) ?? [];

  // ---- 4.2 references.
  const sites: RefSite[] = [];
  const bundleWalkSdx = bundleSdx ?? (deps ? await finder.sdx(CORE + "Bundle") : null);
  if (bundleWalkSdx) {
    // The Bundle's own elements (identifier.assigner, signature.who …) against the Bundle definition; index -1.
    const { entry: _e, ...rest } = bundle;
    await finder.walkChildren(bundleWalkSdx, bundleWalkSdx.root, rest, "Bundle", -1, sites, 0);
  }
  for (const en of entries) {
    if (en.resource) await finder.walkResource(en.resource, `Bundle.entry[${en.index}].resource`, en.index, sites, 1);
  }
  notes.push(...finder.notes);

  const entryByIndex = new Map(entries.map((e) => [e.index, e]));
  const resolvesAsIs = (base: string, from: EntryInfo | null): string | null => {
    if (ABSOLUTE_URI.test(base)) return byFullUrl.has(base) ? base : null;
    const m = RESTFUL_REF.exec(base);
    if (!m || !from?.fullUrl || !from.resource) return null;
    const self = `${from.rt}/${from.resource.id}`;
    if (!/^https?:\/\//.test(from.fullUrl) || !from.fullUrl.endsWith("/" + self)) return null;
    const abs = from.fullUrl.slice(0, from.fullUrl.length - self.length) + base;
    return byFullUrl.has(abs) ? abs : null;
  };
  const candidateList = (list: EntryInfo[]): string[] => {
    const out: string[] = [];
    for (const en of list) if (en.fullUrl && !out.includes(en.fullUrl)) out.push(en.fullUrl);
    return out.slice(0, MAX_CANDIDATES);
  };

  for (const site of sites) {
    const ref = site.holder.reference;
    if (typeof ref !== "string" || ref === "" || ref.startsWith("#")) continue;
    const path = `${site.path}.reference`;
    const trimmed = ref.trim();
    const hm = HISTORY_RE.exec(trimmed);
    const base = hm ? hm[1] : trimmed;
    const version = hm ? hm[2] : null;
    const from = entryByIndex.get(site.entryIndex) ?? null;
    const asIs = resolvesAsIs(base, from);
    if (asIs !== null) {
      if (duplicated.has(asIs)) {
        unresolved.push({ path, reference: ref, candidates: [asIs], reason: `target fullUrl ${asIs} is shared by ${byFullUrl.get(asIs)!.length} entries (bdl-7)` });
      }
      continue;
    }
    if (/^https?:\/\//.test(base)) continue; // absolute URL outside the Bundle: left untouched
    // Alias resolution: original fullUrl, case-different UUID, Type/id, bare id.
    let hits = lookup(base);
    const typed = RESTFUL_REF.exec(base);
    if (!hits.length && typed) hits = lookup(typed[2]).filter((en) => en.rt === typed[1]);
    if (typed) hits = hits.filter((en) => en.rt === typed[1]);
    if (hits.length > 1 && site.targetTypes) {
      const narrowed = hits.filter((en) => site.targetTypes!.has(en.rt));
      if (narrowed.length) hits = narrowed;
    }
    const distinct = [...new Set(hits)];
    if (distinct.length === 1 && distinct[0].fullUrl) {
      const target = distinct[0];
      if (duplicated.has(target.fullUrl!)) {
        unresolved.push({ path, reference: ref, candidates: [target.fullUrl!], reason: `target fullUrl ${target.fullUrl} is shared by ${byFullUrl.get(target.fullUrl!)!.length} entries (bdl-7)` });
        continue;
      }
      const to = version !== null ? `${target.fullUrl}/_history/${version}` : target.fullUrl!;
      if (to !== ref) {
        changes.push({ path, from: ref, to, rule: "reference-rewire" });
        site.holder.reference = to;
      }
      continue;
    }
    if (distinct.length > 1) {
      unresolved.push({ path, reference: ref, candidates: candidateList(distinct), reason: `'${ref}' matches ${distinct.length} entries; choose one` });
      continue;
    }
    // No entry matches: candidates of the expected type (reference prefix, else the element's target types).
    const expected = typed ? new Set([typed[1]]) : site.targetTypes;
    const pool = entries.filter((en) => en.resource && (expected ? expected.has(en.rt) : true));
    unresolved.push({
      path,
      reference: ref,
      candidates: candidateList(pool),
      reason: expected ? `no entry matches '${ref}'; entries of type ${[...expected].join(" | ")} listed` : `no entry matches '${ref}'`,
    });
  }

  // ---- 4.3 ids.
  const fixId = (value: unknown, fallback: string | null): string | null => {
    const s = typeof value === "string" || typeof value === "number" ? String(value) : "";
    const last = lastSegment(s);
    if (ID_RE.test(last)) return last;
    return fallback;
  };
  for (const en of entries) {
    if (!en.resource || !("id" in en.resource)) continue;
    const id = en.resource.id;
    if (typeof id === "string" && ID_RE.test(id)) continue;
    const fixed = fixId(id, en.fullUrl && UUID_FULLURL.test(en.fullUrl) ? en.fullUrl.slice("urn:uuid:".length) : null);
    const path = `Bundle.entry[${en.index}].resource.id`;
    changes.push({ path, from: id ?? null, to: fixed, rule: "resource-id" });
    if (typeof id === "string" && id && fixed) idMap[id] = fixed;
    if (fixed === null) delete en.resource.id;
    else en.resource.id = fixed;
  }
  if ("id" in bundle && !(typeof bundle.id === "string" && ID_RE.test(bundle.id))) {
    const fixed = fixId(bundle.id, uuidV5(FINALIZE_UUID_NAMESPACE, `${salt}|Bundle.id`));
    changes.push({ path: "Bundle.id", from: bundle.id ?? null, to: fixed, rule: "resource-id" });
    if (typeof bundle.id === "string" && bundle.id && fixed) idMap[bundle.id] = fixed;
    if (fixed === null) delete bundle.id;
    else bundle.id = fixed;
  }

  return { bundle, changes, unresolved, notes, id_map: idMap };
}

// --------------------------------------------------------------------------- //
// Bundle.type suggestions (evidence from the entries; FHIR R4 Bundle.type definitions)
// --------------------------------------------------------------------------- //

/** Does any Reference string inside the entries name another entry (fullUrl, Type/id or bare id)? */
function hasInternalReferences(bundle: Record<string, any>): boolean {
  const entries: unknown[] = Array.isArray(bundle.entry) ? bundle.entry : [];
  const names = new Set<string>();
  for (const e of entries) {
    if (!isObject(e)) continue;
    if (typeof e.fullUrl === "string" && e.fullUrl) names.add(e.fullUrl);
    if (isObject(e.resource) && (typeof e.resource.id === "string" || typeof e.resource.id === "number")) {
      names.add(String(e.resource.id));
      if (typeof e.resource.resourceType === "string") names.add(`${e.resource.resourceType}/${String(e.resource.id)}`);
    }
  }
  if (!names.size) return false;
  const sites: RefSite[] = [];
  for (const e of entries) if (isObject(e) && isObject(e.resource)) nameWalk(e.resource, "", 0, sites);
  return sites.some((s) => typeof s.holder.reference === "string" && names.has(s.holder.reference.trim()));
}

/**
 * Bundle.type candidates for a Bundle whose entries show what it is (highest confidence first,
 * never empty): every entry carries a `request` → transaction (batch when no entry references
 * another); some do → transaction, then collection; every entry carries `search` → searchset;
 * otherwise collection. Derived from the entries only — nothing IG-specific.
 */
export function suggestBundleType(bundle: Record<string, any>): BundleTypeCandidate[] {
  const entries = (Array.isArray(bundle.entry) ? bundle.entry : []).filter(isObject);
  const n = entries.length;
  const withRequest = entries.filter((e) => isObject(e.request)).length;
  const withResponse = entries.filter((e) => isObject(e.response)).length;
  const withSearch = entries.filter((e) => isObject(e.search)).length;
  const out: BundleTypeCandidate[] = [];
  if (n && withResponse === n) {
    out.push({ type: "transaction-response", confidence: 0.6, reason: "every entry carries a response" });
    out.push({ type: "batch-response", confidence: 0.4, reason: "every entry carries a response" });
  } else if (n && withRequest === n) {
    out.push({ type: "transaction", confidence: 0.7, reason: "every entry carries a request" });
    if (!hasInternalReferences(bundle)) out.push({ type: "batch", confidence: 0.4, reason: "every entry carries a request and none references another entry" });
  } else if (withRequest) {
    out.push({ type: "transaction", confidence: 0.5, reason: `${withRequest} of ${n} entries carry a request (the others need one too)` });
    out.push({ type: "collection", confidence: 0.4, reason: `${withRequest} of ${n} entries carry a request (drop them for a collection)` });
  } else if (n && withSearch === n) {
    out.push({ type: "searchset", confidence: 0.6, reason: "every entry carries search" });
    out.push({ type: "collection", confidence: 0.4, reason: "entries carry no request or response" });
  } else {
    out.push({ type: "collection", confidence: 0.8, reason: "entries carry no request, response or search" });
  }
  return out;
}

// --------------------------------------------------------------------------- //
// Lossless numbers (losslessJson.ts): the finalized Bundle with the caller's number spellings
// --------------------------------------------------------------------------- //

/** Output position → input position of the entries, from the `document-order` change (identity otherwise). */
export function entryOrderOf(changes: FinalizeChange[], count: number): number[] {
  const order = Array.from({ length: count }, (_, i) => i);
  for (const c of changes) {
    if (c.rule !== "document-order") continue;
    const m = /^Bundle\.entry\[(\d+)\]$/.exec(String(c.from));
    const k = m ? Number(m[1]) : -1;
    if (k > 0 && k < count) order.splice(0, 0, ...order.splice(k, 1));
  }
  return order;
}

/**
 * The finalized Bundle (`fin.bundle`, ordinary tree) with each number replaced by the caller's
 * spelling from `source`, the lossless tree of the Bundle as the request wrote it (parseLossless);
 * the entry permutation of a document reorder is honoured. Same JSON value as `fin.bundle`;
 * null when `source` is unusable (then the ordinary tree is the answer).
 */
export function losslessFinalizedBundle(out: Record<string, any>, changes: FinalizeChange[], source: unknown): Record<string, any> | null {
  if (!isObject(source)) return null;
  let src: Record<string, any> = source;
  if (Array.isArray(out.entry) && Array.isArray(src.entry) && src.entry.length === out.entry.length) {
    const order = entryOrderOf(changes, out.entry.length);
    if (order.some((v, i) => v !== i)) src = { ...src, entry: order.map((i) => src.entry[i]) };
  }
  const restored = restoreNumbers(out, src);
  return isObject(restored) ? restored : null;
}

// --------------------------------------------------------------------------- //
// Bundle-level rules for fhir_get_profile_required_elements (R4)
// --------------------------------------------------------------------------- //

const FULLURL_OPTIONAL_TYPES = new Set(["transaction", "batch", "transaction-response", "batch-response"]);

/**
 * The core Bundle rules a model must follow, generated from the FHIR R4 specification
 * plus what the given Bundle StructureDefinition fixes (Bundle.type, required elements,
 * required entry slices). Nothing here is specific to any IG.
 */
export function bundleRules(sd: Record<string, any> | null): BundleRules {
  const sdx = sd && isObject(sd) && isObject(sd.snapshot) ? new SdIdx(sd) : null;
  const fixed = sdx ? fixedBundleType(sdx) : null;
  const source = ["FHIR R4 Bundle: entry.fullUrl, bdl-7, bdl-11 / bdl-12, reference resolution (bundle.html#references)"];
  if (sdx?.url) source.push(sdx.url);
  const required = sdx ? requiredBundleChildren(sdx).map((el) => String(el.path)) : [];
  const requiredEntries: BundleRules["required_entries"] = [];
  if (sdx) {
    for (const el of (sdx.sd.snapshot || {}).element || []) {
      const id = String(el.id || "");
      const m = /^Bundle\.entry:([^.]+)$/.exec(id);
      if (!m || typeof el.min !== "number" || el.min < 1) continue;
      const res = sdx.byId.get(`${id}.resource`);
      const prof = res ? (res.type || []).find((t: any) => isObject(t) && Array.isArray(t.profile) && t.profile.length)?.profile?.[0] : undefined;
      requiredEntries.push({ slice: m[1], min: el.min, max: String(el.max ?? "*"), profile: typeof prof === "string" ? prof : null });
    }
  }
  const fullUrlWhen = fixed
    ? FULLURL_OPTIONAL_TYPES.has(fixed)
      ? `optional for a ${fixed} Bundle but, when present,`
      : `required on every entry of a ${fixed} Bundle and`
    : "required on every entry except in transaction / batch Bundles, and always";
  return {
    source,
    fullUrl:
      `entry.fullUrl is ${fullUrlWhen} must be an absolute URI: 'urn:uuid:' + a lowercase UUID (8-4-4-4-12 hex digits, e.g. ` +
      `urn:uuid:3f2a9c1e-7b4d-4e8a-9f1c-2d5e6a7b8c9d), 'urn:oid:…', or an absolute http(s) URL ending in <ResourceType>/<resource.id>. ` +
      "Labels such as urn:uuid:patient-1 are rejected (UUIDs must be valid and lowercase). No two entries may share a fullUrl (bdl-7).",
    references:
      "Inside the Bundle, Reference.reference must be exactly the target entry's fullUrl (the same urn:uuid string), never a label, " +
      "'Type/id' or a bare id; 'Type/id' only resolves against http(s) fullUrls of the same server base; '#id' only addresses a contained resource; " +
      "an identifier-only reference needs no reference string.",
    ids: "Bundle.id and resource.id, when present, match [A-Za-z0-9\\-.]{1,64} (never a urn or URL); a resource.id need not equal the fullUrl's UUID.",
    bundle_type: fixed
      ? `Bundle.type must be '${fixed}' (fixed by ${sdx?.url ?? "the profile"}); fhir_finalize_bundle sets it, and its bundle_type argument cannot override it`
      : "Bundle.type is not fixed by this profile: choose it per use (collection, document, transaction …), or pass bundle_type to fhir_finalize_bundle to set it deterministically",
    fixed_type: fixed,
    entry_order:
      fixed === null || fixed === "document" || fixed === "message"
        ? "type=document: entry[0] must be the Composition (bdl-11) and every entry must be reachable from it; type=message: entry[0] must be the MessageHeader (bdl-12)"
        : null,
    required_elements: required,
    required_entries: requiredEntries,
    finalize:
      "Before emitting the finished Bundle call fhir_finalize_bundle (or fhir_validate_bundle with normalize_ids=true): it normalises fullUrl / " +
      "reference / id deterministically, lists every change, and never touches clinical content. Required elements such as Bundle.identifier / " +
      "Bundle.timestamp need real values and are not generated.",
  };
}
