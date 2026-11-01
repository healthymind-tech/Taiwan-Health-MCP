/**
 * `fhir_get_bundle_form` (ISSUES_v19 R2, layer 2): a PREFILLED FORM of a Bundle profile — a
 * skeleton Bundle whose structure is already correct, so a model only fills values.
 *
 * What the form holds (all derived from the StructureDefinitions, IG-agnostic):
 *   - Bundle.meta.profile, Bundle.type (fixed, else the `bundle_type` argument, else derived:
 *     document when the profile requires a Composition, otherwise collection), Bundle-level
 *     required elements (identifier / timestamp of a document as placeholders);
 *   - one entry per required entry slice (min times) plus the planned `entries`, matched to the
 *     slice their profile conforms to (profile or type discriminator), plus the entries required
 *     references need (a required reference whose target has no entry adds one: the slice of that
 *     target, or the target profile when the slicing is open);
 *   - every entry's resource = the minimal skeleton of its profile (skeletonModel: required
 *     elements, fixed / pattern values, meta.profile, required extensions and slices);
 *   - deterministic fullUrls (urn:uuid v5 of the Bundle profile, slice / profile, ordinal) and every
 *     internal reference wired, also inside extensions: one candidate entry -> its fullUrl;
 *     several -> a placeholder that lists them (`allowed`) — never a guess; Composition
 *     section.entry -> every entry its target profiles accept;
 *   - document Bundles: the Composition first; required sections from the Composition profile,
 *     plus the (optional) section a planned entry belongs to so every entry is reachable;
 *     transaction / batch: entry.request (POST <type>).
 *
 * Every value the record (or a code lookup) must provide is a placeholder token
 * `<<P<n>:<value_source>>>` (a JSON string) at its JSON Pointer; `placeholders[n]` says its FHIR
 * type, what to put, the value source (minimal-skeleton classes), whether it is required, the
 * allowed codes of a small binding / the candidate reference targets, and an IG example value.
 * Replace each token with a JSON value of that `type` (primitive -> JSON primitive; Reference ->
 * {"reference": "<fullUrl>"}).
 */

import { FINALIZE_UUID_NAMESPACE, uuidV5 } from "../fhirBundleFinalize.js";
import { evaluateConstraint } from "../fhirPath.js";
import { nodesAt } from "../fhirRequiredElements.js";
import { CODES_CAP, skeletonModel, type SkeletonItem, type SkeletonModel, type ValueSource } from "./skeleton.js";
import {
  BlueprintError,
  clip,
  compactProvenance,
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

type R = Record<string, any>;

/** Size budget of the whole response (characters, non-ASCII counted as \uXXXX escapes). */
export const FORM_BUDGET = 30000;
/** Entries the form may hold (required slices + planned + reference targets). */
export const MAX_ENTRIES = 40;
/** A planned entry's count is capped at this. */
const MAX_COUNT = 5;
/** Placeholder tokens of the skeleton (`<record>`, `<code>`, `<fullUrl of X>` …). */
const SKELETON_TOKEN = /^<[^<>]*>$/;
/** The form's placeholder tokens. */
export const PLACEHOLDER_TOKEN = /^<<P(\d+):([a-z-]+)>>$/;
const BASE_SD = "http://hl7.org/fhir/StructureDefinition/";
const BASE_RESOURCE_SD = /^http:\/\/hl7\.org\/fhir\/StructureDefinition\/[A-Z][A-Za-z]+$/;
const PRIMITIVES = new Set([
  "boolean", "integer", "string", "decimal", "uri", "url", "canonical", "base64Binary", "instant", "date", "dateTime", "time",
  "code", "oid", "id", "markdown", "unsignedInt", "positiveInt", "uuid", "xhtml", "integer64",
]);
/** Sub-element types of common datatypes (fallback when the datatype SD is not held). */
const DATATYPE_FALLBACK: Record<string, string> = {
  "Identifier.system": "uri", "Identifier.value": "string", "Coding.system": "uri", "Coding.code": "code", "Coding.display": "string",
  "CodeableConcept.text": "string", "CodeableConcept.coding": "Coding", "Quantity.value": "decimal", "Quantity.unit": "string",
  "Quantity.system": "uri", "Quantity.code": "code", "Period.start": "dateTime", "Period.end": "dateTime", "HumanName.text": "string",
  "HumanName.family": "string", "HumanName.given": "string", "Annotation.text": "markdown", "Attachment.contentType": "code",
  "Attachment.data": "base64Binary", "Attachment.url": "url", "ContactPoint.system": "code", "ContactPoint.value": "string",
  "Address.text": "string", "Narrative.status": "code", "Narrative.div": "xhtml", "Reference.reference": "string",
};
const QUANTITY_LIKE = new Set(["Quantity", "SimpleQuantity", "Age", "Duration", "Count", "Distance", "MoneyQuantity"]);

export interface FormEntryPlan {
  profile: string;
  count?: number | null;
}

export interface FormRequest {
  bundle_profile: string;
  package_id?: string | null;
  version?: string | null;
  /** Entries the model plans to write (profile id / canonical, or a resource type), each `count` times. */
  entries?: FormEntryPlan[] | null;
  /** Bundle.type when the profile does not fix it. */
  bundle_type?: string | null;
  envelope_provenance?: Record<string, unknown>;
}

export interface FormResult {
  data: Record<string, unknown>;
  warnings: string[];
  provenance: Record<string, unknown>;
}

export interface FormPlaceholder {
  pointer: string;
  type: string;
  what: string;
  value_source: ValueSource;
  required: boolean;
  allowed?: unknown[];
  target?: string[];
  example?: unknown;
  /** Only on non-required placeholders: what to do when the record has no value. */
  if_empty?: string;
  /** Regular expression the value must match (a `matches('…')` invariant of the profile). */
  format?: string;
  /** Profile rules (invariants) whose condition tests this value: the value decides what else the Bundle must hold. */
  rules?: string[];
}

interface Slice {
  name: string;
  min: number;
  max: number;
  profiles: string[];
  types: string[];
  /** fixed / pattern values the slice pins under the entry (relative path → value), not the resource. */
  pins: Array<[string, unknown]>;
}

interface Entry {
  profile: string;
  rt: string;
  slice: string | null;
  why: string;
  fullUrl: string;
  /** Canonicals the entry's profile is (own + baseDefinition chain). */
  chain: Set<string>;
  model: SkeletonModel;
  resource: R;
  /** Element ids forced required (optional sections the entry needs). */
  forced: string[];
  /** Choice items written as a Reference to an entry (instead of the skeleton's coded / text form). */
  converted: Map<SkeletonItem, string>;
}

interface RefDecision {
  entry: Entry;
  item: SkeletonItem;
  /** Candidate entries when ambiguous (a placeholder lists them). */
  candidates: Entry[];
  targets: string[];
}

function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

function escapePtr(seg: string): string {
  return seg.replace(/~/g, "~0").replace(/\//g, "~1");
}

function ptrSegs(ptr: string): string[] {
  return ptr === "" ? [] : ptr.slice(1).split("/").map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
}

/** Node at an RFC 6901 pointer (undefined when it does not resolve). */
export function getAt(root: unknown, ptr: string): unknown {
  let cur: unknown = root;
  for (const s of ptrSegs(ptr)) {
    if (Array.isArray(cur)) cur = cur[Number(s)];
    else if (isObject(cur)) cur = cur[s];
    else return undefined;
  }
  return cur;
}

function setAt(root: unknown, ptr: string, value: unknown): boolean {
  const segs = ptrSegs(ptr);
  if (!segs.length) return false;
  const parent = getAt(root, `/${segs.slice(0, -1).map(escapePtr).join("/")}`.replace(/^\/$/, ""));
  const last = segs[segs.length - 1];
  if (Array.isArray(parent)) parent[Number(last)] = value;
  else if (isObject(parent)) parent[last] = value;
  else return false;
  return true;
}

function fixedOrPatternRaw(el: R | undefined): unknown {
  if (!el) return undefined;
  for (const [k, v] of Object.entries(el)) if ((k.startsWith("fixed") || k.startsWith("pattern")) && k.length > 5 && k !== "pattern") return v;
  return undefined;
}

function maxNum(m: unknown): number {
  return m === "*" || m === undefined || m === null ? Infinity : Number(m);
}

function targetProfiles(item: SkeletonItem, E: SkeletonModel["E"]): string[] {
  const el = E.get(item.id);
  return [...new Set((el?.types || []).filter((t) => shortType(t.code) === "Reference").flatMap((t) => (t.targetProfile || []).map((u) => stripVersion(u))))];
}

/** Required rows plus the conditional rows placed into the skeleton. */
function allItems(m: SkeletonModel): SkeletonItem[] {
  return [...m.items, ...m.conditional.filter((i) => i.pointer !== undefined)];
}

function isReferenceItem(item: SkeletonItem, resource: R): boolean {
  if (!item.pointer && item.pointer !== "") return false;
  const node = getAt(resource, item.pointer);
  return isObject(node) && typeof node.reference === "string" && SKELETON_TOKEN.test(node.reference) && (item.types || []).includes("Reference");
}

/** Composition.section(.section)*.entry: a list of everything that belongs to the section. */
function isSectionEntry(rt: string, id: string): boolean {
  return rt === "Composition" && /\.section(:[^.]+)?\.entry(:[^.]+)?$/.test(id);
}

/** Every string leaf of `node` that is a skeleton token, with its sub-pointer. */
function tokenLeaves(node: unknown, sub = ""): Array<[string, string]> {
  if (typeof node === "string") return SKELETON_TOKEN.test(node) ? [[sub, node]] : [];
  if (Array.isArray(node)) return node.flatMap((x, i) => tokenLeaves(x, `${sub}/${i}`));
  if (isObject(node)) return Object.entries(node).flatMap(([k, v]) => tokenLeaves(v, `${sub}/${escapePtr(k)}`));
  return [];
}

/** Every reference string inside a resource. */
function referencesIn(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((x) => referencesIn(x, out));
  else if (isObject(node)) {
    for (const [k, v] of Object.entries(node)) {
      if (k === "reference" && typeof v === "string") out.push(v);
      else referencesIn(v, out);
    }
  }
  return out;
}

export async function bundleForm(req: FormRequest, deps: BlueprintDeps): Promise<FormResult> {
  const ident = String(req.bundle_profile ?? "").trim();
  if (!ident) throw new BlueprintError("INVALID_ARGUMENT", "bundle_profile is required");
  const pkgId = req.package_id ?? null;
  const ver = pkgId ? req.version ?? null : null;
  const loaded = await deps.loadProfile(ident, pkgId, ver);
  const sd = loaded.sd;
  const els: R[] = (sd?.snapshot || {}).element || [];
  if (sd?.type !== "Bundle" || !els.length) {
    throw new BlueprintError("INVALID_ARGUMENT", `${ident} is not a Bundle profile (type ${sd?.type ?? "unknown"}); for a resource profile call fhir_get_minimal_skeleton`);
  }
  const warnings = [...(loaded.warnings || [])];
  const notes: string[] = [];
  const byId = new Map(els.map((e) => [String(e.id), e]));
  const slicing = isObject(byId.get("Bundle.entry")?.slicing) ? byId.get("Bundle.entry")!.slicing : null;
  const closed = slicing?.rules === "closed";
  const bundleCanonical = stripVersion(loaded.canonical ?? String(sd.url ?? ident));

  // --- slices --------------------------------------------------------------------------------------
  const slices: Slice[] = [];
  for (const e of els) {
    const m = /^Bundle\.entry:([^.]+)$/.exec(String(e.id || ""));
    if (!m || e.max === "0") continue;
    const res = byId.get(`${e.id}.resource`);
    const types = [...new Set(((res?.type || []) as R[]).map((t) => shortType(t.code)).filter((t) => t && t !== "Resource"))];
    const profiles = [...new Set(((res?.type || []) as R[]).flatMap((t) => (t.profile || []).map((u: string) => stripVersion(String(u)))))];
    const pins: Array<[string, unknown]> = [];
    for (const x of els) {
      const xid = String(x.id || "");
      if (!xid.startsWith(`${e.id}.`) || xid.startsWith(`${e.id}.resource`)) continue;
      const v = fixedOrPatternRaw(x);
      if (v !== undefined) pins.push([stripSlices(xid.slice(String(e.id).length + 1)), v]);
    }
    slices.push({ name: m[1], min: Number(e.min ?? 0), max: maxNum(e.max), profiles, types, pins });
  }

  // --- profile chains + skeleton models (memoised) -------------------------------------------------
  const sdCache = new Map<string, R | null>();
  const sdOf = async (url: string): Promise<R | null> => {
    const k = stripVersion(url);
    if (!sdCache.has(k)) sdCache.set(k, await deps.fetchStructureDefinition(loaded, url).catch(() => null));
    return sdCache.get(k) ?? null;
  };
  const chainCache = new Map<string, Set<string>>();
  const chainOf = async (canonical: string): Promise<Set<string>> => {
    const k = stripVersion(canonical);
    if (chainCache.has(k)) return chainCache.get(k)!;
    const out = new Set<string>([k]);
    let cur = await sdOf(k);
    for (let d = 0; cur && d < 8; d++) {
      const b = typeof cur.baseDefinition === "string" ? stripVersion(cur.baseDefinition) : null;
      if (!b || out.has(b)) break;
      out.add(b);
      if (BASE_RESOURCE_SD.test(b)) break;
      cur = await sdOf(b);
    }
    chainCache.set(k, out);
    return out;
  };
  const loadedCache = new Map<string, LoadedProfile | null>();
  const loadEntryProfile = async (profile: string): Promise<LoadedProfile | null> => {
    if (!loadedCache.has(profile)) loadedCache.set(profile, await deps.loadProfile(profile, pkgId, ver).catch(() => null));
    return loadedCache.get(profile) ?? null;
  };
  const modelCache = new Map<string, SkeletonModel>();
  const modelOf = async (lp: LoadedProfile, forced: string[]): Promise<SkeletonModel> => {
    const k = `${lp.canonical ?? lp.profileId}\u0000${forced.join(",")}`;
    if (!modelCache.has(k)) modelCache.set(k, await skeletonModel({ profile: lp.canonical ?? lp.profileId, package_id: pkgId, version: ver }, deps, { loaded: lp, forceRequired: forced, closedSlices: true, placeConditional: true }));
    return modelCache.get(k)!;
  };

  // --- entries --------------------------------------------------------------------------------------
  const entries: Entry[] = [];
  const ordinal = new Map<string, number>();
  const addEntry = async (profile: string, slice: string | null, why: string): Promise<Entry | null> => {
    if (entries.length >= MAX_ENTRIES) {
      notes.push(`entry cap ${MAX_ENTRIES} reached: ${tail(profile)} (${why}) not added`);
      return null;
    }
    const lp = await loadEntryProfile(profile);
    if (!lp || !(lp.sd?.snapshot?.element || []).length) {
      warnings.push(`profile ${profile} is not installed in the IG closure: its entry is not in the form`);
      return null;
    }
    const canonical = stripVersion(lp.canonical ?? String(lp.sd.url ?? profile));
    const model = await modelOf(lp, []);
    const key = `${slice ?? ""}|${canonical}`;
    const n = (ordinal.get(key) ?? 0) + 1;
    ordinal.set(key, n);
    const e: Entry = {
      profile: canonical,
      rt: model.rt,
      slice,
      why,
      fullUrl: `urn:uuid:${uuidV5(FINALIZE_UUID_NAMESPACE, `bundle-form|${bundleCanonical}|${key}|${n}`)}`,
      chain: await chainOf(canonical),
      model,
      resource: clone(model.skeleton),
      forced: [],
      converted: new Map(),
    };
    entries.push(e);
    return e;
  };
  const sliceProfile = (s: Slice): string => s.profiles[0] ?? (s.types[0] ? `${BASE_SD}${s.types[0]}` : `${BASE_SD}Resource`);
  const sliceAccepts = (s: Slice, chain: Set<string>, rt: string): boolean =>
    s.profiles.length ? s.profiles.some((p) => chain.has(p)) : s.types.length ? s.types.includes(rt) : true;
  const sliceCount = (name: string): number => entries.filter((e) => e.slice === name).length;

  for (const s of slices) {
    for (let i = 0; i < s.min; i++) await addEntry(sliceProfile(s), s.name, `required slice ${s.name} (min ${s.min})`);
  }

  // Planned entries: each matched to the slice its profile conforms to.
  for (const plan of req.entries || []) {
    const raw = String(plan?.profile ?? "").trim();
    if (!raw) continue;
    const count = Math.max(1, Math.min(MAX_COUNT, Math.floor(Number(plan.count ?? 1)) || 1));
    let lp = await loadEntryProfile(raw);
    if (!lp && /^[A-Z][A-Za-z]+$/.test(raw)) {
      // a bare resource type: the slice of that type, else the base resource
      const s = slices.find((x) => x.types.includes(raw) || x.profiles.some((p) => tail(p).startsWith(raw)));
      lp = await loadEntryProfile(s ? sliceProfile(s) : `${BASE_SD}${raw}`);
    }
    if (!lp) {
      warnings.push(`planned entry ${raw}: profile not found in the IG closure`);
      continue;
    }
    const canonical = stripVersion(lp.canonical ?? String(lp.sd.url ?? raw));
    const chain = await chainOf(canonical);
    const rt = String(lp.sd.type ?? "");
    const matching = slices.filter((s) => sliceAccepts(s, chain, rt));
    const slice = matching.find((s) => s.profiles.includes(canonical)) ?? matching[0] ?? null;
    if (!slice && closed) {
      warnings.push(`planned entry ${tail(canonical)} matches no entry slice and the slicing is CLOSED: not added`);
      continue;
    }
    const have = slice ? entries.filter((e) => e.slice === slice.name && e.profile === canonical).length : entries.filter((e) => !e.slice && e.profile === canonical).length;
    for (let i = have; i < count; i++) {
      if (slice && sliceCount(slice.name) >= slice.max) {
        notes.push(`slice ${slice.name} allows ${slice.max}: planned ${tail(canonical)} x${count} capped`);
        break;
      }
      await addEntry(canonical, slice?.name ?? null, "planned");
    }
  }

  // --- Bundle level ---------------------------------------------------------------------------------
  const bundleModel = await skeletonModel({ profile: ident, package_id: pkgId, version: ver }, deps, { loaded });
  const bundle: R = {};
  for (const [k, v] of Object.entries(bundleModel.skeleton)) if (k !== "entry") bundle[k] = clone(v);
  const bundleItems = bundleModel.items.filter((i) => !i.id.startsWith("Bundle.entry") && i.pointer !== undefined && !i.pointer.startsWith("/entry"));
  const typeFixed = fixedOrPatternRaw(byId.get("Bundle.type"));
  const prefilled: Array<{ pointer: string; value_source: ValueSource; how: string; optional?: boolean }> = [];
  let bundleType: string;
  if (typeof typeFixed === "string") bundleType = typeFixed;
  else {
    const allowedTypes = ["document", "message", "transaction", "transaction-response", "batch", "batch-response", "history", "searchset", "collection"];
    const asked = typeof req.bundle_type === "string" && allowedTypes.includes(req.bundle_type) ? req.bundle_type : null;
    const requiresComposition = entries.some((e) => e.rt === "Composition" && e.slice && slices.find((s) => s.name === e.slice)!.min >= 1);
    bundleType = asked ?? (requiresComposition ? "document" : "collection");
    prefilled.push({ pointer: "/type", value_source: "derivable", how: asked ? "bundle_type argument" : `not fixed by the profile: ${bundleType} (pass bundle_type for another)` });
  }
  bundle.type = bundleType;
  if (bundleType === "document") {
    // bdl-9 / bdl-10: a document has an identifier and a timestamp
    if (bundle.identifier === undefined) bundle.identifier = { system: "<system>", value: "<record>" };
    if (bundle.timestamp === undefined) bundle.timestamp = "<record>";
    if (!entries.some((e) => e.rt === "Composition")) await addEntry(`${BASE_SD}Composition`, null, "document Bundle: entry[0] is the Composition");
  } else if (bundleType === "message" && !entries.some((e) => e.rt === "MessageHeader")) {
    await addEntry(`${BASE_SD}MessageHeader`, null, "message Bundle: entry[0] is the MessageHeader");
  }

  // --- reference targets: add the entries required references need ---------------------------------
  const candidatesFor = (from: Entry, targets: string[]): Entry[] =>
    entries.filter((e) => e !== from && (targets.length === 0 || targets.some((t) => e.chain.has(t) || t === `${BASE_SD}Resource`)));
  const addTargetFor = async (from: Entry, item: SkeletonItem, targets: string[]): Promise<Entry | null> => {
    const via = `target of ${tail(from.profile)}.${item.path}`;
    for (const t of targets) {
      const s = slices.find((x) => x.profiles.includes(t) && sliceCount(x.name) < x.max);
      if (s) return addEntry(t, s.name, via);
    }
    for (const t of targets) {
      if (!BASE_RESOURCE_SD.test(t)) continue;
      const rt = tail(t);
      const s = slices.find((x) => (x.types.includes(rt) || x.profiles.some((p) => tail(p).startsWith(rt))) && sliceCount(x.name) < x.max);
      if (s) return addEntry(sliceProfile(s), s.name, via);
    }
    if (closed || !targets.length) return null;
    const t = targets.find((x) => !BASE_RESOURCE_SD.test(x)) ?? targets[0];
    const chain = await chainOf(t);
    const s = slices.find((x) => sliceAccepts(x, chain, tail([...chain].pop() ?? t)) && sliceCount(x.name) < x.max);
    return addEntry(t, s?.name ?? null, via);
  };
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    for (const item of allItems(e.model)) {
      if (!isReferenceItem(item, e.resource)) continue;
      const targets = targetProfiles(item, e.model.E);
      if (candidatesFor(e, targets).length) continue;
      const added = await addTargetFor(e, item, targets);
      if (added) notes.push(`entry ${added.slice ?? tail(added.profile)} added: ${added.why}`);
    }
  }

  // --- document: every entry reachable from the Composition (sections the entries belong to) ------
  const reachableFrom = (rootEntry: Entry): Set<Entry> => {
    const byUrl = new Map(entries.map((e) => [e.fullUrl, e]));
    const seen = new Set<Entry>([rootEntry]);
    const queue = [rootEntry];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const ref of referencesIn(cur.resource)) {
        const t = byUrl.get(ref);
        if (t && !seen.has(t)) {
          seen.add(t);
          queue.push(t);
        }
      }
    }
    return seen;
  };

  const decisions: RefDecision[] = [];
  const wire = (e: Entry): void => {
    const wired = new Set<string>();
    const listUsed = new WeakMap<unknown[], Set<string>>();
    for (const item of allItems(e.model)) {
      if (e.converted.has(item) || !isReferenceItem(item, e.resource)) continue;
      const targets = targetProfiles(item, e.model.E);
      const cands = candidatesFor(e, targets);
      const ptr = item.pointer!;
      if (isSectionEntry(e.rt, item.id) && cands.length) {
        // a section lists every entry it accepts (the first in place, the rest appended)
        const segs = ptrSegs(ptr);
        const list = getAt(e.resource, `/${segs.slice(0, -1).map(escapePtr).join("/")}`);
        const used = Array.isArray(list) ? listUsed.get(list) ?? new Set<string>() : new Set<string>();
        if (Array.isArray(list)) listUsed.set(list, used);
        const fresh = cands.filter((c) => !used.has(c.fullUrl));
        if (!fresh.length) {
          (getAt(e.resource, ptr) as R).reference = cands[0].fullUrl;
          continue;
        }
        (getAt(e.resource, ptr) as R).reference = fresh[0].fullUrl;
        used.add(fresh[0].fullUrl);
        for (const c of fresh.slice(1)) {
          if (Array.isArray(list)) list.push({ reference: c.fullUrl });
          used.add(c.fullUrl);
        }
        continue;
      }
      const targetTypes = new Set(targets.map((t) => tail(t)));
      if (cands.length === 1 && !(targetTypes.size > 1 && wired.has(cands[0].fullUrl))) {
        (getAt(e.resource, ptr) as R).reference = cands[0].fullUrl;
        wired.add(cands[0].fullUrl);
        continue;
      }
      // ambiguous / no candidate: a placeholder listing the candidates
      decisions.push({ entry: e, item, candidates: cands, targets });
    }
  };

  const document = bundleType === "document";
  const head = entries.find((e) => e.rt === (document ? "Composition" : bundleType === "message" ? "MessageHeader" : "\u0000"));
  if (head && document) {
    // sections for unreachable entries (wiring is tried first: references from other entries count)
    const scratch = entries.map((e) => ({ e, res: clone(e.resource) }));
    for (const e of entries) wire(e);
    decisions.length = 0;
    const unreachable = entries.filter((e) => !reachableFrom(head).has(e));
    const compEls: R[] = head.model.loaded.sd?.snapshot?.element || [];
    const sectionTargets: Array<{ section: string; entryId: string; targets: string[]; required: boolean }> = [];
    for (const el of compEls) {
      const id = String(el.id || "");
      const m = /^(Composition\.section:[^.]+)\.entry(:[^.]+)?$/.exec(id);
      if (!m || el.max === "0") continue;
      const tps = ((el.type || []) as R[]).flatMap((t) => (t.targetProfile || []).map((u: string) => stripVersion(u)));
      const secEl = compEls.find((x) => x.id === m[1]);
      sectionTargets.push({ section: m[1], entryId: id, targets: tps, required: (secEl?.min ?? 0) >= 1 });
    }
    const force = new Set<string>();
    for (const u of unreachable) {
      const fits = sectionTargets.filter((s) => s.targets.some((t) => u.chain.has(t)));
      const pick = fits.find((s) => s.required) ?? fits[0];
      if (!pick) {
        notes.push(`entry ${u.slice ?? tail(u.profile)} is not reachable from the Composition: no section of ${tail(head.profile)} accepts ${tail(u.profile)}`);
        continue;
      }
      force.add(pick.section);
      force.add(pick.entryId);
    }
    // restore (wiring is redone below on the final structure)
    for (const { e, res } of scratch) e.resource = res;
    if (force.size) {
      head.forced = [...force].sort();
      head.model = await modelOf(head.model.loaded, head.forced);
      head.resource = clone(head.model.skeleton);
      notes.push(`optional section(s) ${[...force].filter((f) => !f.includes(".entry")).map((f) => f.split(":").pop()).join(", ")} added to the Composition so every entry is reachable`);
    }
  }
  if (head) {
    entries.splice(entries.indexOf(head), 1);
    entries.unshift(head);
  }
  // A choice that may be a Reference (medication[x] …) points to a planned entry of its target
  // that nothing else references — the entry the model planned for exactly that.
  {
    const refd = new Set(entries.flatMap((e) => referencesIn(e.resource)));
    const taken = new Set<Entry>();
    for (const e of entries) {
      for (const item of e.model.items) {
        const last = (item.id.split(".").pop() || "").split(":")[0];
        if (!last.endsWith("[x]") || item.pointer === undefined || (item.types || []).length < 2 || !(item.types || []).includes("Reference")) continue;
        const targets = targetProfiles(item, e.model.E);
        if (!targets.length) continue;
        const cands = candidatesFor(e, targets).filter((c) => c.why === "planned" && !refd.has(c.fullUrl) && !taken.has(c));
        if (cands.length !== 1) continue;
        const segs = ptrSegs(item.pointer);
        const parent = getAt(e.resource, `/${segs.slice(0, -1).map(escapePtr).join("/")}`.replace(/^\/$/, ""));
        if (!isObject(parent)) continue;
        const stem = last.slice(0, -3);
        delete parent[segs[segs.length - 1]];
        parent[`${stem}Reference`] = { reference: cands[0].fullUrl };
        const np = `/${[...segs.slice(0, -1), `${stem}Reference`].map(escapePtr).join("/")}`;
        e.converted.set(item, np);
        taken.add(cands[0]);
        refd.add(cands[0].fullUrl);
      }
    }
  }
  for (const e of entries) wire(e);
  if (document && head) {
    const r = reachableFrom(head);
    const lost = entries.filter((e) => !r.has(e));
    if (lost.length) warnings.push(`${lost.length} entr${lost.length === 1 ? "y is" : "ies are"} not reachable from the Composition: ${lost.map((e) => e.slice ?? tail(e.profile)).join(", ")}`);
  }

  // --- assemble + placeholders ---------------------------------------------------------------------
  const typeTypes = new Map<string, string | null>();
  const typeBindings = new Map<string, string | null>();
  /** Type (and required binding) of `<datatype>.<element>` from the core datatype definition. */
  const subType = async (base: string, seg: string): Promise<string | null> => {
    const k = `${base}.${seg}`;
    if (typeTypes.has(k)) return typeTypes.get(k)!;
    let t: string | null = null;
    const dsd = await sdOf(`${BASE_SD}${base}`);
    const el = ((dsd?.snapshot?.element || []) as R[]).find((x) => x.id === k);
    const code = el?.type?.[0]?.code;
    if (typeof code === "string") t = code.startsWith("http://hl7.org/fhirpath/System.") ? "string" : shortType(code);
    t = t ?? DATATYPE_FALLBACK[k] ?? null;
    typeTypes.set(k, t);
    typeBindings.set(k, el?.binding?.strength === "required" && typeof el.binding.valueSet === "string" ? stripVersion(el.binding.valueSet) : null);
    return t;
  };
  const vsCodes = new Map<string, Array<{ system?: string; code: string; display?: string }> | null>();
  /** Codes of a small required ValueSet (null when large / not held). */
  const smallCodes = async (vs: string): Promise<Array<{ system?: string; code: string; display?: string }> | null> => {
    if (!vsCodes.has(vs)) {
      let v: Array<{ system?: string; code: string; display?: string }> | null = null;
      try {
        const exp = await deps.expandValueSet(loaded, vs, 40);
        if (exp && !exp.truncated && exp.codings.length && exp.codings.length <= CODES_CAP) {
          v = exp.codings.map((c) => ({ ...(c.system ? { system: c.system } : {}), code: String(c.code), ...(c.display ? { display: clip(c.display, 40) } : {}) }));
        }
      } catch {
        v = null;
      }
      vsCodes.set(vs, v);
    }
    return vsCodes.get(vs) ?? null;
  };
  /** Type of an item whose element carries no type of its own (a datatype child, e.g. Narrative.status). */
  const derivedItemType = async (model: SkeletonModel, item: SkeletonItem): Promise<{ type: string; binding: string | null }> => {
    const pid = item.id.slice(0, item.id.lastIndexOf("."));
    const pType = shortType(model.E.get(pid)?.types?.[0]?.code ?? "");
    const seg = (item.id.split(".").pop() || "").split(":")[0];
    if (!pType) return { type: "string", binding: null };
    const t = await subType(pType, seg);
    return { type: t ?? "string", binding: typeBindings.get(`${pType}.${seg}`) ?? null };
  };
  const itemType = (item: SkeletonItem): string => {
    const types = item.types || [];
    const last = (item.id.split(".").pop() || "").split(":")[0];
    if (last.endsWith("[x]") && item.pointer) {
      const key = ptrSegs(item.pointer).filter((s) => !/^\d+$/.test(s)).pop() || "";
      const stem = last.slice(0, -3);
      if (key.startsWith(stem) && key.length > stem.length) {
        const t = key.slice(stem.length);
        const lower = t[0].toLowerCase() + t.slice(1);
        return PRIMITIVES.has(lower) ? lower : t;
      }
    }
    return types[0] ?? "string";
  };
  let leafBinding: string | null = null;
  const leafType = async (base: string, sub: string): Promise<string> => {
    let t = base;
    leafBinding = null;
    for (const seg of ptrSegs(sub)) {
      if (/^\d+$/.test(seg)) continue;
      const next = await subType(t, seg);
      if (!next) return "string";
      leafBinding = typeBindings.get(`${t}.${seg}`) ?? null;
      t = next;
    }
    return t;
  };

  const placeholders: FormPlaceholder[] = [];
  const references: string[] = [];
  const tokenFor = (n: number, src: ValueSource): string => `<<P${n}:${src}>>`;
  const forcedOf = (e: Entry | null, item: SkeletonItem): boolean => Boolean(e && e.forced.some((f) => !f.includes(".entry") && (item.id === f || item.id.startsWith(`${f}.`))));
  const exampleAt = (model: SkeletonModel, item: SkeletonItem, sub: string): unknown => {
    for (const inst of model.instances.slice(0, 6)) {
      for (const v of nodesAt(inst.resource, item.id, model.E)) {
        const x = sub ? getAt(v, sub.replace(/\/\d+(?=\/|$)/g, "/0")) : v;
        if (typeof x === "string" && x && !x.startsWith("urn:") && !/^[A-Z][A-Za-z]+\//.test(x)) return clip(x, 60);
        if (typeof x === "number" || typeof x === "boolean") return x;
      }
    }
    return undefined;
  };
  const subHint = (base: string, sub: string): string => {
    const k = ptrSegs(sub).filter((s) => !/^\d+$/.test(s)).pop();
    if (!k) return "";
    if (k === "system") return base === "ContactPoint" ? " (phone | email | …)" : QUANTITY_LIKE.has(base) ? " (system of the unit code)" : " (namespace / code system URI)";
    if (k === "code" && QUANTITY_LIKE.has(base)) return " (UCUM unit code)";
    if (k === "div") return ' (XHTML: <div xmlns="http://www.w3.org/1999/xhtml">…</div>)';
    return "";
  };

  const emit = async (rootPtr: string, resource: R, rt: string, model: SkeletonModel, items: SkeletonItem[], e: Entry | null): Promise<void> => {
    for (const item of items) {
      if (item.pointer === undefined) continue;
      const conv = e?.converted.get(item);
      if (conv) {
        const to = entries.findIndex((x) => x.fullUrl === (getAt(resource, conv) as R)?.reference);
        references.push(`${rootPtr}${conv} -> /entry/${to}`);
        continue;
      }
      const node = getAt(resource, item.pointer);
      const dec = e ? decisions.find((d) => d.entry === e && d.item === item) : undefined;
      const forced = forcedOf(e, item);
      const required = !forced && !item.condition;
      const ifEmpty = item.condition
        ? `required only when rule ${item.condition} applies (${clip(model.conditionText[item.condition] ?? "", 80)}); delete the element if it does not`
        : "optional section added for a planned entry: delete the section (and the entry) if not filled";
      const base: Omit<FormPlaceholder, "pointer" | "type" | "what" | "value_source"> = { required, ...(required ? {} : { if_empty: ifEmpty }) };
      if (dec) {
        const n = placeholders.length;
        setAt(resource, item.pointer, tokenFor(n, "derivable"));
        const types = [...new Set(dec.targets.map((t) => tail(t)))];
        placeholders.push({
          pointer: `${rootPtr}${item.pointer}`,
          type: "Reference",
          what: `${rt}.${item.path}: {"reference": fullUrl of the ${dec.candidates.length ? "right entry among `allowed`" : `${types.slice(0, 4).join(" | ") || "target"} entry (add it to the Bundle)`}}`,
          value_source: "derivable",
          ...base,
          ...(dec.candidates.length ? { allowed: dec.candidates.map((c) => c.fullUrl) } : {}),
          target: types,
        });
        continue;
      }
      if (isObject(node) && typeof node.reference === "string" && entries.some((x) => x.fullUrl === node.reference) && (item.types || []).includes("Reference")) {
        const i = entries.findIndex((x) => x.fullUrl === node.reference);
        references.push(`${rootPtr}${item.pointer} -> /entry/${i}`);
        if (isSectionEntry(rt, item.id)) {
          const list = getAt(resource, item.pointer.replace(/\/\d+$/, ""));
          if (Array.isArray(list)) {
            list.forEach((x, j) => {
              const k = entries.findIndex((y) => isObject(x) && y.fullUrl === x.reference);
              const p = `${rootPtr}${item.pointer!.replace(/\/\d+$/, "")}/${j}`;
              if (k >= 0 && `${rootPtr}${item.pointer}` !== p && !references.includes(`${p} -> /entry/${k}`)) references.push(`${p} -> /entry/${k}`);
            });
          }
        }
        continue;
      }
      const leaves = tokenLeaves(node);
      if (!leaves.length) {
        if (!item.pinned && (item.source === "derivable" || item.exampleBasis)) {
          prefilled.push({ pointer: `${rootPtr}${item.pointer}`, value_source: item.source, how: clip(item.how, 110), ...(item.how.startsWith("optional") ? { optional: true } : {}) });
        }
        continue;
      }
      let bt = itemType(item);
      let ownBinding: string | null = null;
      if (!(item.types || []).length) ({ type: bt, binding: ownBinding } = await derivedItemType(model, item));
      for (const [sub, tok] of leaves) {
        const type = await leafType(bt, sub);
        const dtBinding = sub ? leafBinding : ownBinding;
        const subPath = ptrSegs(sub).filter((s) => !/^\d+$/.test(s)).join(".");
        const label = `${rt}.${item.path}${subPath ? `.${subPath}` : ""}`;
        const last = subPath.split(".").pop() || "";
        const n = placeholders.length;
        const p: FormPlaceholder = {
          pointer: `${rootPtr}${item.pointer}${sub}`,
          type,
          what: clip(`${label} (${type})${subHint(bt, sub)}: ${item.how || item.source}${tok.startsWith("<fullUrl") ? "" : ""}`, 220),
          value_source: item.source,
          ...base,
        };
        const codes = item.codes || [];
        if (codes.length && (type === "code" || last === "code") && !QUANTITY_LIKE.has(bt)) {
          p.allowed = codes.slice(0, CODES_CAP).map((c) => ({ ...(c.system ? { system: c.system } : {}), code: c.code, ...(c.display ? { display: clip(c.display, 40) } : {}) }));
        } else if (codes.length && last === "system") {
          const systems = [...new Set(codes.map((c) => c.system).filter(Boolean))];
          if (systems.length) p.allowed = systems;
        } else if (item.valueSet && (type === "code" || last === "code" || last === "system")) {
          p.what = clip(`${p.what} (ValueSet ${item.valueSet})`, 240);
        }
        if (!p.allowed && type === "code" && dtBinding) {
          const cs = await smallCodes(dtBinding);
          if (cs) {
            p.allowed = cs;
            p.value_source = "code-lookup";
            p.what = clip(`${label} (code): one of the codes of ${tail(dtBinding)}`, 220);
          }
        }
        let ex = exampleAt(model, item, sub);
        if (ex === undefined && item.exampleCode && (type === "code" || last === "code") && !QUANTITY_LIKE.has(bt)) ex = item.exampleCode.code;
        if (ex === undefined && item.exampleCode?.system && last === "system" && !QUANTITY_LIKE.has(bt)) ex = item.exampleCode.system;
        if (ex !== undefined && !p.allowed) p.example = ex;
        {
          // `matches('…')` invariants on the leaf or an ancestor element (`value.matches('…')` on an identifier slice)
          type Con = { expression?: string; severity?: string };
          const consOf = (id: string): Con[] => ((model.E.get(id) as { constraints?: Con[] } | undefined)?.constraints || []);
          const leafId = subPath ? `${item.id}.${subPath}` : item.id;
          const segs = leafId.split(".");
          for (let up = 0; up <= 2 && segs.length - up >= 2; up++) {
            const owner = segs.slice(0, segs.length - up).join(".");
            const rel = segs.slice(segs.length - up).map((x) => x.split(":")[0]).join(".");
            for (const c of consOf(owner)) {
              if (c.severity && c.severity !== "error") continue;
              const m = /^(?:\$this\.)?(?:([A-Za-z][A-Za-z0-9.]*)\.)?matches\('((?:[^'\\]|\\.)+)'\)$/.exec(String(c.expression ?? "").trim());
              if (m && (m[1] ?? "") === rel && !p.format) p.format = m[2].replace(/\\\\/g, "\\");
            }
          }
        }
        const name = (item.id.split(".").pop() || "").split(":")[0].replace("[x]", "");
        const ruleInvs = model.invariants.filter((inv) => {
          const guard = inv.expression.includes(" implies ") ? inv.expression.slice(0, inv.expression.indexOf(" implies ")) : "";
          return guard && new RegExp(`(^|[^A-Za-z])${name}([^A-Za-z]|$)`).test(guard) && !model.conditional.some((c) => c.condition === inv.key);
        });
        if (ruleInvs.length) p.rules = ruleInvs.slice(0, 3).map((inv) => `${inv.key}: ${clip(inv.human || inv.expression, 160)}`);
        // allowed codes that make a resource-level rule demand content the form does not hold: listed
        // last, each with the rule it triggers (the record decides the code; the rule then needs more)
        if (Array.isArray(p.allowed) && p.allowed.length > 1 && ruleInvs.some((inv) => inv.on.includes(rt))) {
          const ok: unknown[] = [];
          const triggering: unknown[] = [];
          for (const a of p.allowed) {
            if (!isObject(a)) {
              ok.push(a);
              continue;
            }
            const trial = clone(resource);
            setAt(trial, `${item.pointer}${sub}`, a.code);
            const failed = ruleInvs.filter((inv) => inv.on.includes(rt) && evaluateConstraint(trial, rt, inv.expression, { resource: trial, rootResource: trial }).status === "fail");
            if (failed.length) triggering.push({ ...a, triggers: failed.map((f) => f.key) });
            else ok.push(a);
          }
          if (triggering.length && ok.length) p.allowed = [...ok, ...triggering];
          else if (triggering.length) p.allowed = triggering;
        }
        placeholders.push(p);
        setAt(resource, `${item.pointer}${sub}`, tokenFor(n, p.value_source));
      }
    }
  };

  // Bundle-level tokens (identifier / timestamp a document needs, other required Bundle elements)
  {
    const listed = new Set(bundleItems.map((i) => i.pointer));
    const synth: SkeletonItem[] = [];
    if (bundleType === "document") {
      if (!listed.has("/identifier")) synth.push({ id: "Bundle.identifier", path: "identifier", source: "record", how: "document identifier (bdl-9): the record's document number, else a site namespace + id", pointer: "/identifier", types: ["Identifier"] });
      if (!listed.has("/timestamp")) synth.push({ id: "Bundle.timestamp", path: "timestamp", source: "record", how: "when the document was assembled (bdl-10)", pointer: "/timestamp", types: ["instant"] });
    }
    const items = [...bundleItems.filter((i) => i.id !== "Bundle.type" || typeof typeFixed === "string"), ...synth].map((i) =>
      i.id === "Bundle.timestamp" && i.source === "record" ? { ...i, how: "when the Bundle was assembled (instant, with seconds and offset)" } : i,
    );
    await emit("", bundle, "Bundle", bundleModel, items, null);
  }
  const bundleEntries: R[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const entry: R = { fullUrl: e.fullUrl, resource: e.resource };
    const s = e.slice ? slices.find((x) => x.name === e.slice) : null;
    for (const [path, v] of s?.pins || []) {
      const segs = path.split(".");
      let node = entry;
      for (const seg of segs.slice(0, -1)) node = isObject(node[seg]) ? node[seg] : (node[seg] = {});
      if (node[segs[segs.length - 1]] === undefined) node[segs[segs.length - 1]] = clone(v);
    }
    if (bundleType === "transaction" || bundleType === "batch") {
      entry.request = { method: "POST", url: e.rt, ...(isObject(entry.request) ? entry.request : {}) };
      prefilled.push({ pointer: `/entry/${i}/request`, value_source: "derivable", how: "POST <resourceType> (create); PUT <type>/<id> to update" });
    }
    bundleEntries.push(entry);
    await emit(`/entry/${i}/resource`, e.resource, e.rt, e.model, allItems(e.model), e);
  }
  bundle.entry = bundleEntries;
  // order: resourceType, meta, … entry last
  const ordered: R = { resourceType: "Bundle" };
  for (const k of ["meta", "identifier", "type", "timestamp"]) if (bundle[k] !== undefined) ordered[k] = bundle[k];
  for (const [k, v] of Object.entries(bundle)) if (!(k in ordered) && k !== "entry") ordered[k] = v;
  ordered.entry = bundle.entry;

  const bySource: Record<string, number> = {};
  for (const p of placeholders) bySource[p.value_source] = (bySource[p.value_source] ?? 0) + 1;
  const prov = compactProvenance({ ...(loaded.provenance || {}), ...(req.envelope_provenance || {}) });
  for (const e of entries) for (const w of e.model.warnings) if (!warnings.includes(w)) warnings.push(w);

  const entryRows = entries.map((e, i) => ({ index: i, fullUrl: e.fullUrl, resourceType: e.rt, profile: e.profile, ...(e.slice ? { slice: e.slice } : {}), why: e.why }));
  interface Level {
    whatLen: number;
    examples: boolean;
    allowedDisplay: boolean;
    prefilled: boolean;
    references: boolean;
  }
  const build = (lv: Level): R => {
    const ph = placeholders.map((p) => {
      const o: R = { ...p, what: clip(p.what, lv.whatLen) };
      if (!lv.examples) delete o.example;
      if (!lv.allowedDisplay && Array.isArray(o.allowed)) o.allowed = o.allowed.map((a: unknown) => (isObject(a) ? { ...(a.system ? { system: a.system } : {}), code: a.code } : a));
      return o;
    });
    const data: R = {
      bundle_profile: { id: loaded.profileId, canonical: loaded.canonical },
      bundle: ordered,
      entries: entryRows,
      placeholders: ph,
      placeholder_format:
        "every <<P<n>:<value_source>>> string in `bundle` is placeholders[n] at its `pointer` (RFC 6901): replace it with a JSON value of its `type` " +
        '(primitive -> JSON string / number / boolean; Reference -> {"reference": "<an entry fullUrl>"}); allowed = pick one (codes: also set the sibling system); ' +
        "required=false -> delete the element (with its section) when the record has no value. Every other value is final.",
      summary: { entries: entries.length, placeholders: placeholders.length, by_value_source: bySource, references_wired: references.length, references_open: decisions.length },
    };
    if (lv.prefilled && prefilled.length) data.prefilled = prefilled;
    else if (prefilled.length) data.prefilled_count = prefilled.length;
    if (lv.references && references.length) data.references = references;
    if (notes.length) data.notes = notes;
    data.legend =
      "value_source: record = a fact the record states; code-lookup = pick a code (allowed / the ValueSet: fhir_normalize_code); text-allowed = free text is valid; " +
      "derivable = computed without a record fact (dates of writing = the record's date for it, references = an entry fullUrl). Only `record` needs the record. " +
      "prefilled = defaults already in the form (change only when the record says otherwise). Next: fill -> fhir_finalize_bundle / fhir_validate_bundle (bundle_profile).";
    if ((loaded.depsMissing || []).length) data.deps_missing = loaded.depsMissing;
    return data;
  };
  const levels: Level[] = [
    { whatLen: 220, examples: true, allowedDisplay: true, prefilled: true, references: true },
    { whatLen: 160, examples: true, allowedDisplay: true, prefilled: true, references: false },
    { whatLen: 120, examples: true, allowedDisplay: false, prefilled: false, references: false },
    { whatLen: 90, examples: false, allowedDisplay: false, prefilled: false, references: false },
    { whatLen: 60, examples: false, allowedDisplay: false, prefilled: false, references: false },
  ];
  const limit = FORM_BUDGET - RESPONSE_MARGIN;
  let data = build(levels[0]);
  let level = 0;
  for (; level < levels.length; level++) {
    data = build(levels[level]);
    if (measureResponse(data, warnings, prov) <= limit) break;
  }
  if (level >= levels.length) warnings.push(`the form exceeds ${FORM_BUDGET} characters even compacted (placeholders are never dropped)`);
  data.omitted = {
    level: Math.min(level, levels.length - 1),
    ...(level > 0 ? { compacted: "what shortened / examples, displays, prefilled or references lists dropped for size" } : {}),
  };
  data.response_chars = measureResponse(data, warnings, prov);
  return { data, warnings, provenance: prov };
}

export const _internal = { getAt, setAt, tokenLeaves, isSectionEntry };
