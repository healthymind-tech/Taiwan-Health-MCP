/**
 * composeResource — field values → a profile-conformant FHIR resource (workstream B of the
 * authoring layer, README in this directory).
 *
 * Pipeline (all rules come from the resolved StructureDefinition snapshot, FHIR R4 core
 * datatypes and the bound ValueSets — no profile-specific special cases):
 *
 *   1. placement   every `fields[path]` is resolved against the snapshot (slices `a:b`, nested
 *                  `a.b.c`, choice `value[x]` / `valueQuantity` / `value`), parsed by the element's
 *                  type with the value grammar (values.ts) and written at its JSON location
 *                  (arrays vs single values, slice entries, backbone objects, choice renaming)
 *   2. slices      entries of a sliced element the model did not name are assigned to the one slice
 *                  whose discriminators they satisfy
 *   3. determined  required content the profile fully decides (fixed / pattern chains, required
 *                  slices such as a category pattern or a pinned LOINC coding) is created
 *   4. pinning     fixed[x] / pattern[x] of every element are merged where the element exists; a
 *                  model value that contradicts a fixed / pattern value is an error, never overwritten
 *   1b. arrays     any element with max > 1 holding a single object / scalar (a raw FHIR shape the
 *                  model passed through, e.g. `code: {coding: {…}}`) is wrapped into a one-item
 *                  array, at any depth (note `wrapped <path> into an array`)
 *   5. defaults    `defaultValue[x]` and the conventional workflow defaults (fhirRequiredElements
 *                  WORKFLOW_DEFAULTS) only on elements the profile REQUIRES (min >= 1, required
 *                  slices included) that the model left empty; optional ones are never filled;
 *                  `applyDefaults: "none"` fills none (required ones then appear in `missing`)
 *   6. derived     computable derivations (Condition.category from the encounter reference,
 *                  Observation.category vital-signs from the R4 vital-sign code list) — only when the
 *                  element's binding is the one the rule describes and the model gave nothing
 *   7. lookups     display of codings without one, UCUM codes for unit text (values.ts), ROC dates;
 *                  a model-written display the validator would reject for a resolvable code is
 *                  replaced by the code's display (the model's text moves to CodeableConcept.text
 *                  when that is empty; note `display replaced for <field> (was '<old>')`)
 *   8. missing     required / invariant-implied / target-implied elements without a value — reported,
 *                  never invented (no dates, ids, names, numbers)
 *
 * Deterministic: no clock, no random ids; `{ref: key}` → `urn:uuid:` v5 of (contextId, key)
 * (keyToUrn), shared with fhir_assemble_bundle.
 */

import { FINALIZE_UUID_NAMESPACE, uuidV5 } from "../fhirBundleFinalize.js";
import { choiceProperty, fixedPattern, projectElement } from "../fhirSnapshot.js";
import { ensureMetaProfile } from "../fhirAuthoring.js";
import { impliedVitalSignProfile } from "../fhirValidator.js";
import {
  derivationRuleFor,
  nodesAt,
  parseOneOfInvariant,
  projectForRequired,
  requiredElements,
  WORKFLOW_DEFAULTS,
  type ProjectedElement,
} from "../fhirRequiredElements.js";
import { textSim } from "../fhirSuggestions/util.js";
import { UCUM_SYSTEM } from "../fhirUcum.js";
import type { ComposeDeps, ExpandedCoding, NormalizeCandidate } from "./deps.js";
import type { ApplyDefaults, AuthorInput, FieldKind, FieldSpec, Provenance } from "./types.js";
import * as V from "./values.js";

export type { ComposeDeps } from "./deps.js";

// --------------------------------------------------------------------------- //
// Public types
// --------------------------------------------------------------------------- //

export interface ComposeContext {
  /** The authoring context id (128-bit hex) — the namespace of every `{ref: key}` urn. */
  contextId: string;
  /** Keys already stored in the context (a reference to any other key is `pending`); a Set or an array. */
  knownKeys: Iterable<string>;
  /** UTC offset (e.g. "+08:00") completing times given without one — a facility setting, never guessed. */
  timezone?: string | null;
  /** "required" (default): defaults only on required elements; "none": no defaults at all. */
  applyDefaults?: ApplyDefaults | null;
}

export interface ComposeError {
  /** The model-facing field name (null when the error is not attributable to one field). */
  field: string | null;
  /** FHIR instance path (validator form, e.g. `Observation.component[0].valueQuantity`). */
  path: string;
  message: string;
  /** Candidate codings when a text could not be resolved against a required binding. */
  candidates?: unknown[];
}

export interface ComposeOutput {
  resource: Record<string, any>;
  profile: { canonical: string; id: string | null; resourceType: string };
  /** FHIR instance path → who supplied the value. */
  provenance: Record<string, Provenance>;
  missing: Array<{ field: string; why: string }>;
  refs: {
    resolved: string[];
    pending: string[];
    /** The `urn:uuid:` placeholders of pending keys (validation issues naming one are filterable). */
    pendingUrns: string[];
    /** Instance paths of the Reference elements that point at pending keys. */
    pendingPaths: string[];
  };
  /** FHIR instance path → model field name (issue path → field via fieldForPath). */
  fieldMap: Record<string, string>;
  /** Value-grammar / unknown-field / fixed-value conflicts found before validation. */
  errors: ComposeError[];
  /** Corrections made to the model's values (display replaced, single value wrapped into an array). */
  notes: string[];
}

export class ComposeProfileError extends Error {
  constructor(
    readonly code: "ARTIFACT_NOT_FOUND" | "INVALID_ARGUMENT",
    message: string,
  ) {
    super(message);
    this.name = "ComposeProfileError";
  }
}

// --------------------------------------------------------------------------- //
// Deterministic reference urns (shared with fhir_assemble_bundle)
// --------------------------------------------------------------------------- //

/** Namespace of every authoring-context urn: derived from the Bundle finalizer's namespace. */
export const AUTHORING_UUID_NAMESPACE = uuidV5(FINALIZE_UUID_NAMESPACE, "authoring-context");

/** `urn:uuid:` of a context key — the same for the single-resource validation and the assembled Bundle. */
export function keyToUrn(contextId: string, key: string): string {
  return `urn:uuid:${uuidV5(AUTHORING_UUID_NAMESPACE, `${contextId}|${key}`)}`;
}

/** The model field a validator issue path belongs to (longest matching prefix of `fieldMap`), or null. */
export function fieldForPath(fieldMap: Record<string, string>, issuePath: string): string | null {
  const p = String(issuePath || "");
  let best: string | null = null;
  let bestLen = -1;
  for (const [path, field] of Object.entries(fieldMap)) {
    if (p === path || p.startsWith(`${path}.`) || p.startsWith(`${path}[`)) {
      if (path.length > bestLen) {
        best = field;
        bestLen = path.length;
      }
    }
  }
  return best;
}

/** True when a validator issue is about a reference whose target is still pending in the context. */
export function isPendingRefIssue(issue: { path?: unknown; message?: unknown }, refs: ComposeOutput["refs"]): boolean {
  const msg = String(issue.message ?? "");
  if (refs.pendingUrns.some((u) => msg.includes(u))) return true;
  const p = String(issue.path ?? "");
  return refs.pendingPaths.some((pp) => p === pp || p.startsWith(`${pp}.`));
}

// --------------------------------------------------------------------------- //
// Snapshot index
// --------------------------------------------------------------------------- //

type El = Record<string, any>;
const CORE = "http://hl7.org/fhir/StructureDefinition/";
const FHIR_TYPE_EXT = "http://hl7.org/fhir/StructureDefinition/structuredefinition-fhir-type";
const PRIMITIVES = new Set([
  "boolean", "integer", "integer64", "unsignedInt", "positiveInt", "decimal", "string", "markdown", "xhtml", "code", "id",
  "uri", "url", "canonical", "oid", "uuid", "base64Binary", "date", "dateTime", "instant", "time",
]);
/** Codings asked of a ValueSet expansion per compose (the server caps at 2000). */
const EXPANSION_LIMIT = 1000;

function typeCodeOf(t: Record<string, any>): string {
  const code = String(t.code || "");
  for (const ext of t.extension || []) {
    if (ext && ext.url === FHIR_TYPE_EXT) return String(ext.valueUrl ?? ext.valueUri ?? ext.valueString ?? code);
  }
  if (code.startsWith("http://hl7.org/fhirpath/System.")) return "string";
  return code;
}

function maxIsArray(max: unknown): boolean {
  return max === "*" || (/^\d+$/.test(String(max)) && Number(max) > 1);
}

interface Def {
  id: string;
  path: string;
  /** Last id segment without the slice name (`value[x]`, `identifier`). */
  name: string;
  sliceName: string | null;
  parentId: string | null;
  el: El;
  types: string[];
  min: number;
  max: string;
  isArray: boolean;
  fixed: { field: string; value: unknown } | null;
  pattern: { field: string; value: unknown } | null;
  binding: { strength: string; valueSet: string } | null;
  contentReference: string | null;
}

interface Group {
  name: string;
  base: Def | null;
  slices: Def[];
}

class ElIndex {
  readonly type: string;
  readonly root: Def;
  readonly byId = new Map<string, Def>();
  readonly ordered: Def[] = [];
  private readonly groups = new Map<string, Map<string, Group>>();

  constructor(readonly sd: El) {
    this.type = String(sd.type || "");
    const els: El[] = (sd.snapshot || {}).element || [];
    let root: Def | null = null;
    for (const el of els) {
      const id = String(el.id || el.path || "");
      if (!id) continue;
      const segs = id.split(".");
      if (segs.some((s, i) => i < segs.length - 1 && s.includes("/")) || /:[^.]*\//.test(id)) continue; // re-slices are not authored
      const last = segs[segs.length - 1];
      const colon = last.indexOf(":");
      const [fixed, pattern] = fixedPattern(el);
      const def: Def = {
        id,
        path: String(el.path || id),
        name: colon >= 0 ? last.slice(0, colon) : last,
        sliceName: colon >= 0 ? last.slice(colon + 1) : null,
        parentId: segs.length > 1 ? segs.slice(0, -1).join(".") : null,
        el,
        types: [...new Set<string>((el.type || []).map((t: Record<string, any>) => typeCodeOf(t)))],
        min: typeof el.min === "number" ? el.min : 0,
        max: el.max === undefined || el.max === null ? "*" : String(el.max),
        isArray: maxIsArray(el.base && el.base.max !== undefined ? el.base.max : el.max),
        fixed,
        pattern,
        binding: el.binding && el.binding.valueSet ? { strength: String(el.binding.strength || ""), valueSet: String(el.binding.valueSet) } : null,
        contentReference: typeof el.contentReference === "string" ? el.contentReference : null,
      };
      this.byId.set(id, def);
      this.ordered.push(def);
      if (!root) {
        root = def;
        continue;
      }
      let g = this.groups.get(def.parentId!);
      if (!g) {
        g = new Map();
        this.groups.set(def.parentId!, g);
      }
      let grp = g.get(def.name);
      if (!grp) {
        grp = { name: def.name, base: null, slices: [] };
        g.set(def.name, grp);
      }
      if (def.sliceName) grp.slices.push(def);
      else grp.base = def;
    }
    this.root = root || { id: this.type, path: this.type, name: this.type, sliceName: null, parentId: null, el: {}, types: [], min: 0, max: "*", isArray: false, fixed: null, pattern: null, binding: null, contentReference: null };
  }

  children(def: Def): Map<string, Group> | undefined {
    return this.groups.get(def.id);
  }

  hasChildren(def: Def): boolean {
    const g = this.groups.get(def.id);
    return !!g && g.size > 0;
  }

  /** Base child (or a named slice of it) under `def`. */
  child(def: Def, name: string, slice: string | null = null): Def | null {
    const grp = this.groups.get(def.id)?.get(name);
    if (!grp) return null;
    if (slice) return grp.slices.find((s) => s.sliceName === slice) ?? null;
    return grp.base;
  }
}

const indexCache = new WeakMap<object, ElIndex>();
const projectedCache = new WeakMap<object, Map<string, ProjectedElement>>();

function indexOf(sd: El): ElIndex {
  let idx = indexCache.get(sd);
  if (!idx) {
    idx = new ElIndex(sd);
    indexCache.set(sd, idx);
  }
  return idx;
}

function projectedOf(sd: El): Map<string, ProjectedElement> {
  let m = projectedCache.get(sd);
  if (!m) {
    const rows = projectForRequired((sd.snapshot || {}).element || [], projectElement);
    m = new Map(rows.map((r) => [r.id, r]));
    projectedCache.set(sd, m);
  }
  return m;
}

/** A definition and the index it lives in (a datatype's children come from the datatype's own SD). */
interface Node {
  index: ElIndex;
  def: Def;
}

// --------------------------------------------------------------------------- //
// Small helpers
// --------------------------------------------------------------------------- //

function isObject(v: unknown): v is Record<string, any> {
  return V.isObject(v);
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function stableJson(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(stableJson).join(",") + "]";
  if (isObject(v)) return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stableJson(v[k])).join(",") + "}";
  return JSON.stringify(v) ?? "null";
}

function deepEqual(a: unknown, b: unknown): boolean {
  return stableJson(a) === stableJson(b);
}

/** pattern[x] semantics: every property of the pattern is present (arrays: each pattern item matches some item). */
function patternMatches(actual: unknown, pattern: unknown): boolean {
  if (isObject(pattern)) {
    if (!isObject(actual)) return false;
    return Object.entries(pattern).every(([k, v]) => patternMatches(actual[k], v));
  }
  if (Array.isArray(pattern)) {
    const arr = Array.isArray(actual) ? actual : actual === undefined ? [] : [actual];
    return pattern.every((p) => arr.some((a) => patternMatches(a, p)));
  }
  return deepEqual(actual, pattern);
}

function stripVersion(u: string): string {
  return String(u || "").split("|")[0];
}

function stripSlices(id: string): string {
  return id.replace(/:[^.]+/g, "");
}

/** Values reached from `node` by a simple dotted path (choice stems match typed keys; arrays flattened). */
function valuesAt(node: unknown, rel: string): unknown[] {
  let cur: unknown[] = [node];
  for (const raw of rel.split(".").filter(Boolean)) {
    if (raw === "resolve()" || raw.startsWith("ofType(") || raw.startsWith("extension(")) return [];
    const seg = raw;
    const next: unknown[] = [];
    for (const n of cur) {
      if (!isObject(n)) continue;
      const keys = seg in n ? [seg] : Object.keys(n).filter((k) => k.startsWith(seg) && k.length > seg.length && /[A-Z]/.test(k[seg.length]));
      for (const k of keys) {
        const v = n[k];
        if (Array.isArray(v)) next.push(...v);
        else if (v !== undefined && v !== null) next.push(v);
      }
    }
    cur = next;
  }
  return cur;
}

const KIND_OF_TYPE: Record<string, FieldKind> = {
  string: "string", markdown: "string", id: "string", uri: "string", url: "string", canonical: "string", code: "code", boolean: "boolean",
  integer: "integer", positiveInt: "integer", unsignedInt: "integer", decimal: "decimal", date: "date", dateTime: "dateTime", instant: "dateTime",
  Coding: "coding", CodeableConcept: "codeableConcept", Quantity: "quantity", SimpleQuantity: "quantity", Age: "quantity", Duration: "quantity",
  Count: "quantity", Distance: "quantity", Period: "period", Identifier: "identifier", Reference: "reference", Dosage: "dosage", Annotation: "annotation",
  HumanName: "humanName",
};

const FIELD_SKIP = new Set(["id", "meta", "implicitRules", "language", "text", "contained", "extension", "modifierExtension"]);

/**
 * Shallow model-facing field list derived from the snapshot (the stand-in for workstream A's
 * `authoringFields`; the real one is injected through `deps.authoringFields`).
 */
export function fieldSpecsFromSnapshot(sd: El): FieldSpec[] {
  const idx = indexOf(sd);
  const prefix = `${idx.type}.`;
  const out: FieldSpec[] = [];
  for (const def of idx.ordered) {
    if (!def.id.startsWith(prefix) || def.id.slice(prefix.length).includes(".") || def.max === "0") continue;
    const rel = def.id.slice(prefix.length);
    if (FIELD_SKIP.has(def.name)) continue;
    const t = def.types[0] || "";
    const kind: FieldKind = def.name === "component" ? "component" : def.types.length > 1 ? "other" : KIND_OF_TYPE[t] ?? (t === "BackboneElement" ? "other" : "other");
    const spec: FieldSpec = { field: rel, required: def.min >= 1, kind, multiple: def.isArray, source: def.fixed || def.pattern ? "fixed" : "record" };
    if (def.fixed || def.pattern) spec.auto = true;
    if (def.binding) spec.binding = { strength: def.binding.strength, valueSet: def.binding.valueSet };
    out.push(spec);
  }
  return out;
}

// --------------------------------------------------------------------------- //
// Composer
// --------------------------------------------------------------------------- //

interface Hit {
  node: any;
  path: string;
  parent: Record<string, any> | null;
  key: string | null;
}

/** Bookkeeping of one compose call. */
class Composer {
  readonly resource: Record<string, any>;
  readonly index: ElIndex;
  readonly E: Map<string, ProjectedElement>;
  readonly rt: string;
  readonly provenance: Record<string, Provenance> = {};
  readonly fieldMap: Record<string, string> = {};
  readonly errors: ComposeError[] = [];
  readonly notes: string[] = [];
  readonly pending = new Set<string>();
  readonly resolved = new Set<string>();
  readonly pendingPaths: string[] = [];
  /** Array entries the model (or the composer) assigned to a slice: entry → slice element id. */
  readonly entrySlice = new WeakMap<object, string>();
  private readonly datatypeIndexes = new Map<string, Promise<ElIndex | null>>();
  private readonly expansions = new Map<string, Promise<{ codings: ExpandedCoding[]; truncated: boolean } | null>>();
  private readonly displayLookups = new Map<string, Promise<string | null>>();
  private lookupBudget = 40;

  readonly knownKeys: Set<string>;

  constructor(
    readonly sd: El,
    readonly deps: ComposeDeps,
    readonly ctx: ComposeContext,
    readonly ownKey: string,
  ) {
    this.knownKeys = ctx.knownKeys instanceof Set ? ctx.knownKeys : new Set(ctx.knownKeys);
    this.index = indexOf(sd);
    this.E = projectedOf(sd);
    this.rt = this.index.type;
    this.resource = { resourceType: this.rt };
  }

  // ------------------------------------------------------------------ definitions

  private datatypeIndex(type: string): Promise<ElIndex | null> {
    let p = this.datatypeIndexes.get(type);
    if (!p) {
      p = (async () => {
        let sd: El | null = null;
        if (this.deps.fetchStructureDefinition) {
          try {
            sd = await this.deps.fetchStructureDefinition(CORE + type);
          } catch {
            sd = null;
          }
        }
        if (!sd || !((sd.snapshot || {}).element || []).length) sd = V.syntheticDatatypeSd(type);
        return sd ? indexOf(sd) : null;
      })();
      this.datatypeIndexes.set(type, p);
    }
    return p;
  }

  /** The node whose children define `node`'s content (content references and un-expanded datatypes). */
  private async contentNode(node: Node, type: string | null): Promise<Node | null> {
    if (node.index.hasChildren(node.def)) return node;
    if (node.def.contentReference) {
      const target = node.index.byId.get(node.def.contentReference.replace(/^.*#/, ""));
      return target ? { index: node.index, def: target } : null;
    }
    const t = type ?? (node.def.types.length === 1 ? node.def.types[0] : null);
    if (!t || PRIMITIVES.has(t) || t === "BackboneElement" || t === "Element") return null;
    const idx = await this.datatypeIndex(t);
    return idx ? { index: idx, def: idx.root } : null;
  }

  /** Children names (with slices) available under a node, for messages. */
  private async childNames(node: Node, type: string | null): Promise<string[]> {
    const c = await this.contentNode(node, type);
    if (!c) return [];
    const out: string[] = [];
    for (const grp of c.index.children(c.def)?.values() || []) {
      if (FIELD_SKIP.has(grp.name) && c.def.id === c.index.root.id && c.index === this.index) continue;
      if (grp.base && grp.base.max !== "0") out.push(grp.name);
      for (const s of grp.slices) if (s.max !== "0") out.push(`${grp.name}:${s.sliceName}`);
    }
    return out;
  }

  /** Resolve one field segment under `node` (name, `name:slice`, `value`, `valueQuantity`). */
  private async resolveSegment(node: Node, seg: string, type: string | null): Promise<{ node: Node; forcedType?: string } | null> {
    const c = await this.contentNode(node, type);
    if (!c) return null;
    const colon = seg.indexOf(":");
    const name = colon >= 0 ? seg.slice(0, colon) : seg;
    const slice = colon >= 0 ? seg.slice(colon + 1) : null;
    const groups = c.index.children(c.def);
    if (!groups) return null;
    const direct = groups.get(name);
    if (direct) {
      const def = slice ? direct.slices.find((s) => s.sliceName === slice) : direct.base ?? null;
      return def ? { node: { index: c.index, def } } : null;
    }
    if (slice) return null;
    for (const grp of groups.values()) {
      if (!grp.name.endsWith("[x]") || !grp.base) continue;
      const stem = grp.name.slice(0, -3);
      if (name === stem) return { node: { index: c.index, def: grp.base } };
      if (name.startsWith(stem) && name.length > stem.length) {
        const suffix = name.slice(stem.length);
        const t = grp.base.types.find((x) => x[0].toUpperCase() + x.slice(1) === suffix);
        if (t) return { node: { index: c.index, def: grp.base }, forcedType: t };
        // a type slice name used as the field (value[x]:valueQuantity)
        const ts = grp.slices.find((s) => s.sliceName === name);
        if (ts && ts.types.length === 1) return { node: { index: c.index, def: grp.base }, forcedType: ts.types[0] };
      }
    }
    return null;
  }

  // ------------------------------------------------------------------ instance walking

  /** Instance members of a profile element id, with their paths (slice members only). */
  nodesOf(id: string): Hit[] {
    const segs = id.split(".");
    let hits: Hit[] = [{ node: this.resource, path: this.rt, parent: null, key: null }];
    let idSoFar = segs[0];
    for (const seg of segs.slice(1)) {
      idSoFar = `${idSoFar}.${seg}`;
      const colon = seg.indexOf(":");
      const name = colon >= 0 ? seg.slice(0, colon) : seg;
      const sliced = colon >= 0;
      const next: Hit[] = [];
      for (const h of hits) {
        const obj = h.node;
        if (!isObject(obj)) continue;
        const keys = name.endsWith("[x]")
          ? Object.keys(obj).filter((k) => k.startsWith(name.slice(0, -3)) && k.length > name.length - 3 && /[A-Z]/.test(k[name.length - 3]))
          : name in obj
            ? [name]
            : [];
        for (const k of keys) {
          const v = obj[k];
          const items: Array<[unknown, number | null]> = Array.isArray(v) ? v.map((x, i): [unknown, number | null] => [x, i]) : v === null || v === undefined ? [] : [[v, null]];
          for (const [it, i] of items) {
            if (sliced && !this.isMember(it, k, idSoFar)) continue;
            next.push({ node: it, path: `${h.path}.${k}${i === null ? "" : `[${i}]`}`, parent: obj, key: k });
          }
        }
      }
      hits = next;
    }
    return hits;
  }

  private isMember(item: unknown, key: string, sliceId: string): boolean {
    if (isObject(item)) {
      const assigned = this.entrySlice.get(item);
      if (assigned !== undefined) return assigned === sliceId;
    }
    return this.sliceMatch(item, key, sliceId) === true;
  }

  /**
   * Expected discriminator value of `sliceId` at `dpath`: the fixed / pattern value found on the
   * path (also inside a pattern object, e.g. a patternCodeableConcept queried at coding.code), the
   * path being followed through required sub-slices (bp component code.coding:SBPCode.code) as the
   * HL7 validator does; else the required binding at the end of the path.
   */
  private expectedAt(sliceId: string, dpath: string): { kind: "value"; value: unknown } | { kind: "binding"; valueSet: string } | null {
    return this.expectRec(sliceId, dpath === "$this" ? [] : dpath.split("."));
  }

  private ownValue(id: string): unknown {
    const e = this.E.get(id);
    if (!e) return undefined;
    if (e.fixed) return e.fixed.value;
    if (e.pattern) return e.pattern.value;
    return undefined;
  }

  private expectRec(id: string, segs: string[]): { kind: "value"; value: unknown } | { kind: "binding"; valueSet: string } | null {
    const mine = this.ownValue(id);
    if (!segs.length) {
      if (mine !== undefined) return { kind: "value", value: mine };
      const e = this.E.get(id);
      if (e?.binding?.strength === "required" && e.binding.valueSet) return { kind: "binding", valueSet: String(e.binding.valueSet) };
      return null;
    }
    if (mine !== undefined) {
      const inside = valuesAt(mine, segs.join("."));
      if (inside.length) return { kind: "value", value: inside.length === 1 ? inside[0] : inside };
    }
    const [seg, ...rest] = segs;
    if (seg.includes("(")) return null;
    const cands: string[] = [];
    if (this.E.has(`${id}.${seg}`)) cands.push(`${id}.${seg}`);
    for (const k of this.E.keys()) {
      if (k.startsWith(`${id}.${seg}:`) && !k.slice(id.length + seg.length + 2).includes(".") && (this.E.get(k)!.min ?? 0) >= 1) cands.push(k);
    }
    for (const c of cands) {
      const r = this.expectRec(c, rest);
      if (r) return r;
    }
    return null;
  }

  /** true / false, or undefined when the slice cannot be decided locally. */
  sliceMatch(item: unknown, key: string, sliceId: string): boolean | undefined {
    const colon = sliceId.lastIndexOf(":");
    if (colon < 0) return undefined;
    const baseId = sliceId.slice(0, colon);
    const sliceName = sliceId.slice(colon + 1);
    const slice = this.E.get(sliceId);
    if (!slice) return undefined;
    if (baseId.endsWith("[x]")) {
      if (key === sliceName) return true;
      const t = slice.types?.length === 1 ? slice.types[0].code.split(".").pop()! : null;
      return t ? key === choiceProperty(baseId, t) : undefined;
    }
    let discs = this.E.get(baseId)?.slicing?.discriminator ?? null;
    if ((!discs || !discs.length) && /\.(extension|modifierExtension)$/.test(baseId)) discs = [{ type: "value", path: "url" }];
    if (!discs || !discs.length) return undefined;
    let decided = false;
    for (const d of discs) {
      const p = String(d.path || "$this");
      if (d.type === "value" || d.type === "pattern") {
        let exp = this.expectedAt(sliceId, p);
        if (!exp && p === "url" && /\.(extension|modifierExtension)$/.test(baseId)) {
          const prof = slice.types?.[0]?.profile?.[0];
          if (prof) exp = { kind: "value", value: stripVersion(prof) };
        }
        if (!exp) return undefined;
        if (exp.kind === "binding") return undefined;
        decided = true;
        const vals = p === "$this" ? [item] : valuesAt(item, p);
        const expected = exp.value;
        const matches = (v: unknown): boolean => (Array.isArray(expected) ? expected.some((e) => patternMatches(v, e)) : patternMatches(v, expected));
        if (!vals.some(matches)) return false;
      } else if (d.type === "type") {
        const el = p === "$this" ? slice : this.E.get(`${sliceId}.${p}`);
        const types = (el?.types || []).map((t) => t.code.split(".").pop()!);
        if (!types.length) return undefined;
        const vals = p === "$this" ? [item] : valuesAt(item, p);
        const rts = vals.map((v) => (isObject(v) ? v.resourceType : undefined)).filter(Boolean);
        if (!rts.length) return undefined;
        decided = true;
        if (!rts.some((r) => types.includes(String(r)))) return false;
      } else if (d.type === "exists") {
        const el = this.E.get(`${sliceId}.${p}`);
        if (!el) return undefined;
        const want = (el.min ?? 0) >= 1 ? true : el.max === "0" ? false : undefined;
        if (want === undefined) return undefined;
        decided = true;
        if (valuesAt(item, p).length > 0 !== want) return false;
      } else return undefined;
    }
    return decided ? true : undefined;
  }

  /** Partial match: no discriminator value present contradicts the slice, at least one is present and matches. */
  private sliceCompatible(item: unknown, key: string, sliceId: string): boolean {
    const colon = sliceId.lastIndexOf(":");
    if (colon < 0) return false;
    const baseId = sliceId.slice(0, colon);
    if (baseId.endsWith("[x]")) return false;
    const discs = this.E.get(baseId)?.slicing?.discriminator ?? null;
    if (!discs || !discs.length) return false;
    let matched = 0;
    for (const d of discs) {
      if (d.type !== "value" && d.type !== "pattern") return false;
      const p = String(d.path || "$this");
      const exp = this.expectedAt(sliceId, p);
      if (!exp || exp.kind === "binding") return false;
      const vals = p === "$this" ? [item] : valuesAt(item, p);
      if (!vals.length) continue;
      const expected = exp.value;
      const ok = vals.some((v) => (Array.isArray(expected) ? expected.some((e) => patternMatches(v, e)) : patternMatches(v, expected)));
      if (!ok) return false;
      matched++;
    }
    return matched > 0;
  }

  // ------------------------------------------------------------------ errors / provenance

  error(field: string | null, path: string, message: string, candidates?: unknown[]): void {
    const e: ComposeError = { field, path, message };
    if (candidates && candidates.length) e.candidates = candidates;
    this.errors.push(e);
  }

  /** Whether an error was reported at `path` or inside it (a default never replaces a value the model tried to give). */
  private hasError(path: string): boolean {
    return this.errors.some((e) => e.path === path || e.path.startsWith(`${path}.`) || e.path.startsWith(`${path}[`));
  }

  mark(path: string, who: Provenance): void {
    this.provenance[path] = who;
  }

  note(text: string): void {
    if (!this.notes.includes(text)) this.notes.push(text);
  }

  /** The model field a path belongs to (for notes), else the path relative to the resource. */
  private fieldLabel(path: string): string {
    return fieldForPath(this.fieldMap, path) ?? (path.startsWith(`${this.rt}.`) ? path.slice(this.rt.length + 1) : path);
  }

  /** A value moved from `p` to `p[0]`: re-key provenance / field-map paths at or under it. */
  private rekeyWrapped(p: string): void {
    for (const map of [this.provenance, this.fieldMap] as Array<Record<string, unknown>>) {
      for (const k of Object.keys(map)) {
        if (k !== p && !k.startsWith(`${p}.`)) continue;
        const nk = `${p}[0]${k.slice(p.length)}`;
        map[nk] = map[k];
        delete map[k];
      }
    }
  }

  // ------------------------------------------------------------------ placement

  async placeFields(fields: Record<string, unknown>): Promise<void> {
    const specs = await this.fieldSpecs();
    for (const [field, raw] of Object.entries(fields)) {
      if (raw === undefined || raw === null) continue;
      if (field === "resourceType") {
        if (raw !== this.rt) this.error(field, this.rt, `resourceType must be ${this.rt} for this profile`);
        continue;
      }
      await this.placeField(field, raw, specs);
    }
  }

  private fieldSpecCache: Promise<FieldSpec[]> | null = null;

  private fieldSpecs(): Promise<FieldSpec[]> {
    if (!this.fieldSpecCache) {
      this.fieldSpecCache = (async () => {
        if (this.deps.authoringFields) {
          try {
            const got = await this.deps.authoringFields(this.sd);
            if (Array.isArray(got) && got.length) return got;
          } catch {
            // fall back to the snapshot-derived list
          }
        }
        return fieldSpecsFromSnapshot(this.sd);
      })();
    }
    return this.fieldSpecCache;
  }

  private async placeField(field: string, raw: unknown, specs: FieldSpec[]): Promise<void> {
    const segs = field.split(".").map((s) => s.trim()).filter(Boolean);
    if (!segs.length) {
      this.error(field, this.rt, "empty field name");
      return;
    }
    // Resolve every segment first (an unknown segment is reported with the valid names at that level).
    const steps: Array<{ node: Node; forcedType?: string; seg: string }> = [];
    let cur: Node = { index: this.index, def: this.index.root };
    let curType: string | null = null;
    for (let i = 0; i < segs.length; i++) {
      const r = await this.resolveSegment(cur, segs[i], curType);
      if (!r) {
        const names = i === 0 ? specs.map((s) => s.field) : await this.childNames(cur, curType);
        this.unknownField(field, segs[i], names, i === 0 ? this.rt : steps.map((s) => s.seg).join("."));
        return;
      }
      if (r.node.def.max === "0") {
        this.error(field, `${this.rt}.${segs.slice(0, i + 1).join(".")}`, `${segs[i]} is prohibited by the profile (max 0)`);
        return;
      }
      steps.push({ node: r.node, forcedType: r.forcedType, seg: segs[i] });
      cur = r.node;
      curType = r.forcedType ?? null;
    }
    // Walk / create the containers, then place the leaf value.
    let parent: Record<string, any> = this.resource;
    let parentPath = this.rt;
    for (let i = 0; i < steps.length - 1; i++) {
      const { node, forcedType } = steps[i];
      const def = node.def;
      let key = def.name;
      if (def.name.endsWith("[x]")) {
        if (!forcedType) {
          this.error(field, `${parentPath}.${def.name}`, `${def.name} is a choice: name the type in the field (e.g. ${choiceProperty(def.name, def.types[0] || "Quantity")}.${steps[i + 1].seg})`);
          return;
        }
        key = choiceProperty(def.name, forcedType);
      }
      const prefix = `${parentPath}.${key}`;
      if (def.isArray) {
        if (!Array.isArray(parent[key])) {
          if (parent[key] !== undefined && !isObject(parent[key])) {
            this.error(field, prefix, `${key} already holds a value that is not an object`);
            return;
          }
          parent[key] = parent[key] !== undefined ? [parent[key]] : [];
        }
        const arr: unknown[] = parent[key];
        let idx = -1;
        if (def.sliceName) idx = arr.findIndex((e) => isObject(e) && this.entrySlice.get(e) === def.id);
        else idx = arr.findIndex((e) => isObject(e) && !this.entrySlice.has(e)) >= 0 ? arr.findIndex((e) => isObject(e) && !this.entrySlice.has(e)) : arr.length ? 0 : -1;
        if (idx < 0) {
          const entry: Record<string, any> = {};
          arr.push(entry);
          idx = arr.length - 1;
          if (def.sliceName) this.entrySlice.set(entry, def.id);
          this.mark(`${prefix}[${idx}]`, "model");
        }
        if (!isObject(arr[idx])) {
          this.error(field, `${prefix}[${idx}]`, `${key} holds a value that is not an object`);
          return;
        }
        parent = arr[idx] as Record<string, any>;
        parentPath = `${prefix}[${idx}]`;
      } else {
        if (parent[key] === undefined) {
          parent[key] = {};
          this.mark(prefix, "model");
        } else if (!isObject(parent[key])) {
          this.error(field, prefix, `${key} already holds a value that is not an object`);
          return;
        }
        parent = parent[key];
        parentPath = prefix;
      }
      if (!(parentPath in this.fieldMap)) this.fieldMap[parentPath] = field;
    }
    const leaf = steps[steps.length - 1];
    await this.placeValue(leaf.node, leaf.forcedType ?? null, raw, field, parent, parentPath);
  }

  private unknownField(field: string, seg: string, names: string[], at: string): void {
    const ranked = [...new Set(names)]
      .map((n) => ({ n, s: textSim(seg, n) }))
      .sort((a, b) => b.s - a.s || (a.n < b.n ? -1 : 1));
    const near = ranked.filter((r) => r.s >= 0.5).slice(0, 3).map((r) => r.n);
    const list = [...new Set(names)].slice(0, 40);
    this.error(
      field,
      at,
      `unknown field '${seg}'${at !== this.rt ? ` under ${at}` : ""}` +
        (near.length ? ` — did you mean ${near.map((n) => `'${n}'`).join(" / ")}?` : "") +
        (list.length ? ` Valid fields: ${list.join(", ")}${names.length > list.length ? ", …" : ""}` : ""),
    );
  }

  /**
   * Place a parsed value for `node` under `parent[key]` (arrays and choice keys decided here).
   * `nested`: the value is a key of a FHIR-shaped object the model wrote (not a top-level field,
   * where one value for a repeating field is the documented grammar) — wrapping a single value of
   * a repeating element into an array is then reported as a note.
   */
  async placeValue(node: Node, forcedType: string | null, raw: unknown, field: string, parent: Record<string, any>, parentPath: string, nested = false): Promise<void> {
    const def = node.def;
    const types = forcedType ? [forcedType] : def.types.length ? def.types : def.contentReference ? ["BackboneElement"] : [];
    const choice = def.name.endsWith("[x]");
    let items: unknown[];
    if (def.isArray) {
      items = Array.isArray(raw) ? raw : [raw];
      if (nested && !Array.isArray(raw) && raw !== null && raw !== undefined && !choice) this.note(`wrapped ${parentPath}.${def.name} into an array`);
    }
    else if (Array.isArray(raw)) {
      if (types.length === 1 && types[0] === "CodeableConcept") items = [raw];
      else {
        this.error(field, `${parentPath}.${def.name}`, `${def.name} does not repeat (max ${def.max}); give one value, not an array`);
        return;
      }
    } else items = [raw];
    if (def.isArray && def.max !== "*" && items.length > Number(def.max)) {
      this.error(field, `${parentPath}.${def.name}`, `${def.name}${def.sliceName ? ` (slice ${def.sliceName})` : ""} allows at most ${def.max} value(s), got ${items.length}`);
      return;
    }
    for (const item of items) {
      if (item === null || item === undefined) continue;
      const type = V.shapeType(item, types) ?? (types.length === 1 ? types[0] : null);
      if (!type) {
        this.error(field, `${parentPath}.${def.name}`, `the value (${V.describe(item)}) fits none of the allowed types ${types.join(" | ")}`);
        continue;
      }
      const key = choice ? choiceProperty(def.name, type) : def.name;
      if (choice) {
        const stem = def.name.slice(0, -3);
        const other = Object.keys(parent).find((k) => k !== key && k.startsWith(stem) && k.length > stem.length && /[A-Z]/.test(k[stem.length]) && def.types.some((t) => choiceProperty(def.name, t) === k));
        if (other) {
          this.error(field, `${parentPath}.${key}`, `${def.name} already has ${other}; a choice element takes exactly one type`);
          continue;
        }
      }
      const itemPath = def.isArray ? `${parentPath}.${key}[${Array.isArray(parent[key]) ? parent[key].length : 0}]` : `${parentPath}.${key}`;
      if (!def.isArray && parent[key] !== undefined) {
        this.error(field, itemPath, `${key} was already given (duplicate field)`);
        continue;
      }
      const built = await this.buildValue(node, type, item, field, itemPath);
      if (!built.ok) {
        this.error(field, itemPath, built.message, built.candidates);
        continue;
      }
      if (def.isArray) {
        if (!Array.isArray(parent[key])) parent[key] = [];
        parent[key].push(built.value);
        if (def.sliceName && isObject(built.value)) this.entrySlice.set(built.value, def.id);
      } else parent[key] = built.value;
      this.mark(itemPath, "model");
      this.fieldMap[itemPath] = field;
    }
  }

  // ------------------------------------------------------------------ value building

  private async buildValue(node: Node, type: string, item: unknown, field: string, path: string): Promise<V.Parsed<unknown>> {
    const def = node.def;
    if (PRIMITIVES.has(type)) return this.buildPrimitive(node, type, item);
    switch (type) {
      case "Quantity":
      case "SimpleQuantity":
      case "Age":
      case "Duration":
      case "Count":
      case "Distance":
      case "MoneyQuantity":
        return this.buildQuantity(item, path);
      case "Coding":
        return this.buildCoding(item, this.effectiveBinding(node), path);
      case "CodeableConcept":
        return this.buildCodeableConcept(item, this.effectiveBinding(node), path);
      case "Identifier":
        return this.buildIdentifier(node, item, field, path);
      case "Period":
        return this.buildPeriod(item);
      case "Range":
        return this.buildRange(item, path);
      case "Ratio":
        return this.buildRatio(item, path);
      case "Reference":
        return this.buildReference(item, path);
      case "HumanName":
        return V.parseHumanNameValue(item);
      case "Dosage":
        return this.buildDosage(node, item, field, path);
      case "Timing":
        return this.buildTiming(node, item, field, path);
      case "Annotation":
        return this.buildAnnotation(item);
      case "ContactPoint":
        if (typeof item === "string") return item.trim() ? { ok: true, value: { value: item.trim() } } : V.fail("empty contact point");
        return this.buildObject(node, type, item, field, path);
      case "Address":
        if (typeof item === "string") return item.trim() ? { ok: true, value: { text: item.trim() } } : V.fail("empty address");
        return this.buildObject(node, type, item, field, path);
      case "Narrative":
        if (typeof item === "string") return { ok: true, value: { status: "additional", div: item } };
        return this.buildObject(node, type, item, field, path);
      case "Extension":
        return this.buildExtension(node, item, field, path);
      case "Resource":
      case "DomainResource":
      case "Meta":
      case "Attachment":
      case "SampledData":
      case "Signature":
      case "Money":
        return isObject(item) ? { ok: true, value: clone(item) } : V.fail(`${def.name} expects a ${type} object, got ${V.describe(item)}`);
      case "BackboneElement":
      case "Element":
        return this.buildObject(node, type, item, field, path);
      default:
        // Other complex types (ContactDetail, UsageContext …): an object with children of the type.
        return this.buildObject(node, type, item, field, path);
    }
  }

  /**
   * An extension slice from a value: `{value}` (or the bare value — `{ref: key}`, `{system, code}`,
   * a string …) becomes `{url, value[x]}` typed by the extension's definition (the profile's own
   * expanded children when the snapshot has them, else the StructureDefinition named by
   * `type.profile`); a complex extension takes `{<sub-extension>: value, …}`. An item that already
   * carries `url` is taken as written FHIR JSON.
   */
  private async buildExtension(node: Node, item: unknown, field: string, path: string): Promise<V.Parsed<unknown>> {
    if (!isObject(item)) return V.fail(`${node.def.name} expects an object ({value: …} or the extension's sub-fields), got ${V.describe(item)}`);
    if (typeof item.url === "string") return { ok: true, value: clone(item) };
    const prof = (node.def.el.type || []).find((t: Record<string, any>) => typeCodeOf(t) === "Extension")?.profile?.[0];
    let idx: ElIndex | null = null;
    let def: Def | null = null;
    let url: string | null = null;
    if (node.index.hasChildren(node.def)) {
      idx = node.index;
      def = node.def;
    }
    if (prof) {
      let sd: El | null = null;
      if (this.deps.fetchStructureDefinition) {
        try {
          sd = await this.deps.fetchStructureDefinition(String(prof));
        } catch {
          sd = null;
        }
      }
      if (sd && ((sd.snapshot || {}).element || []).length) {
        url = typeof sd.url === "string" ? sd.url : stripVersion(String(prof));
        if (!idx) {
          idx = indexOf(sd);
          def = idx.root;
        }
      } else url = stripVersion(String(prof));
    }
    if (!idx || !def) return V.fail(`${node.def.name}: the extension's definition is not available — write it as FHIR JSON {url, value<Type>}`);
    return this.buildExtensionFrom(idx, def, url, item, field, path);
  }

  private async buildExtensionFrom(idx: ElIndex, def: Def, url: string | null, item: Record<string, any>, field: string, path: string): Promise<V.Parsed<unknown>> {
    const groups = idx.children(def);
    const urlDef = groups?.get("url")?.base ?? null;
    const pinnedUrl = urlDef?.fixed?.value ?? urlDef?.pattern?.value;
    const out: Record<string, any> = { url: typeof pinnedUrl === "string" ? pinnedUrl : url };
    if (typeof out.url !== "string") return V.fail(`${def.name}: the extension has no url (write it as FHIR JSON {url, value<Type>})`);
    const valueGrp = groups?.get("value[x]");
    const valueDef = valueGrp?.base ?? null;
    const subSlices = groups?.get("extension")?.slices ?? [];
    const subNames = new Set(subSlices.map((s) => s.sliceName!));
    const simple = !!valueDef && valueDef.max !== "0";
    const keys = Object.keys(item).filter((k) => item[k] !== undefined && item[k] !== null);
    const asSub = keys.filter((k) => subNames.has(k));
    if (asSub.length && asSub.length === keys.length) {
      const subs: unknown[] = [];
      for (const k of asSub) {
        const sub = subSlices.find((s) => s.sliceName === k)!;
        const raw = item[k];
        const r = await this.buildExtensionFrom(idx, sub, k, isObject(raw) && (raw.value !== undefined || Object.keys(raw).some((x) => idx.children(sub)?.get("extension")?.slices.some((s) => s.sliceName === x))) ? raw : { value: raw }, `${field}.${k}`, `${path}.extension[${subs.length}]`);
        if (!r.ok) return r;
        subs.push(r.value);
      }
      out.extension = subs;
      return { ok: true, value: out };
    }
    if (!simple) {
      return V.fail(`${def.name} is a complex extension: give an object of its sub-extensions${subNames.size ? ` (${[...subNames].join(", ")})` : ""}`);
    }
    const raw = item.value !== undefined ? item.value : keys.length ? item : undefined;
    if (raw === undefined) return V.fail(`${def.name}: give {value: …}`);
    // allowed value types: the type slices of value[x] when the definition names some, else the element's own
    const sliceTypes = (valueGrp?.slices ?? []).filter((s) => s.max !== "0").flatMap((s) => s.types);
    const types = sliceTypes.length ? [...new Set(sliceTypes)] : valueDef!.types;
    const type = types.length === 1 ? types[0] : V.shapeType(raw, types);
    if (!type) return V.fail(`${def.name}: the value's shape does not pick one of the extension's value types (${types.join(" | ")}); give {value: …} in that type's grammar`);
    const built = await this.buildValue({ index: idx, def: valueDef! }, type, raw, field, `${path}.${choiceProperty("value[x]", type)}`);
    if (!built.ok) return built;
    out[choiceProperty("value[x]", type)] = built.value;
    return { ok: true, value: out };
  }

  private async buildPrimitive(node: Node, type: string, item: unknown): Promise<V.Parsed<unknown>> {
    switch (type) {
      case "boolean":
        return V.parseBoolean(item);
      case "integer":
      case "integer64":
        return V.parseInteger(item, "integer");
      case "positiveInt":
        return V.parseInteger(item, "positiveInt");
      case "unsignedInt":
        return V.parseInteger(item, "unsignedInt");
      case "decimal":
        return V.parseNumber(item);
      case "date":
      case "dateTime":
      case "instant": {
        const p = V.parseDateValue(item);
        if (!p.ok) return p;
        return V.fitDate(p.value, type, this.ctx.timezone);
      }
      case "time":
        return V.parseTimeValue(item);
      case "code":
        return this.buildCode(node, item);
      default: {
        if (typeof item === "string") return item === "" ? V.fail("empty string") : { ok: true, value: item };
        if (type === "string" && (V.isNumberLike(item) || typeof item === "boolean")) return { ok: true, value: String(Number(item)) };
        return V.fail(`${node.def.name} expects a ${type} string, got ${V.describe(item)}`);
      }
    }
  }

  /** A `code` value: the string (or {code} / {system, code}); a required binding resolves labels to codes. */
  private async buildCode(node: Node, item: unknown): Promise<V.Parsed<unknown>> {
    let text: string;
    if (typeof item === "string") text = item.trim();
    else if (isObject(item) && typeof item.code === "string") text = item.code.trim();
    else if (V.isNumberLike(item)) text = String(Number(item));
    else return V.fail(`${node.def.name} expects a code string, got ${V.describe(item)}`);
    if (!text) return V.fail("empty code");
    const b = node.def.binding;
    if (!b || b.strength !== "required" || /\s/.test(text) === false && (await this.inValueSet(b.valueSet, null, text)) === true) return { ok: true, value: text };
    const r = await this.resolveBound(text, b.valueSet);
    if (r.ok) return { ok: true, value: r.value.code };
    // Nothing decided it locally: keep the model's code (validation judges it); a known miss is an error.
    return r.candidates ? V.fail(r.message, r.candidates) : r.decided ? V.fail(r.message) : { ok: true, value: text };
  }

  private async buildQuantity(item: unknown, path: string): Promise<V.Parsed<unknown>> {
    const q = V.parseQuantityValue(item);
    if (!q.ok) return q;
    if (q.value.codeResolved) {
      this.mark(`${path}.code`, "lookup");
      this.mark(`${path}.system`, "lookup");
    }
    return { ok: true, value: V.quantityJson(q.value) };
  }

  private async buildPeriod(item: unknown): Promise<V.Parsed<unknown>> {
    const p = V.parsePeriodValue(item);
    if (!p.ok) return p;
    const out: Record<string, unknown> = {};
    for (const k of ["start", "end"] as const) {
      const d = p.value[k];
      if (!d) continue;
      const f = V.fitDate(d, "dateTime", this.ctx.timezone);
      if (!f.ok) return V.fail(`period.${k}: ${f.message}`);
      out[k] = f.value;
    }
    if (typeof out.start === "string" && typeof out.end === "string" && out.start > out.end && out.start.slice(0, out.end.length) !== out.end) {
      return V.fail(`period end (${out.end}) is before its start (${out.start})`);
    }
    return { ok: true, value: out };
  }

  private async buildRange(item: unknown, path: string): Promise<V.Parsed<unknown>> {
    if (!isObject(item)) return V.fail(`a range needs {low, high}, got ${V.describe(item)}`);
    const out: Record<string, unknown> = {};
    for (const k of ["low", "high"]) {
      if (item[k] === undefined || item[k] === null) continue;
      const q = await this.buildQuantity(item[k], `${path}.${k}`);
      if (!q.ok) return V.fail(`${k}: ${q.message}`);
      out[k] = q.value;
    }
    if (!Object.keys(out).length) return V.fail("a range needs a low or a high");
    return { ok: true, value: out };
  }

  private async buildRatio(item: unknown, path: string): Promise<V.Parsed<unknown>> {
    if (!isObject(item)) return V.fail(`a ratio needs {numerator, denominator}, got ${V.describe(item)}`);
    const out: Record<string, unknown> = {};
    for (const k of ["numerator", "denominator"]) {
      if (item[k] === undefined || item[k] === null) continue;
      const q = await this.buildQuantity(item[k], `${path}.${k}`);
      if (!q.ok) return V.fail(`${k}: ${q.message}`);
      out[k] = q.value;
    }
    if (!Object.keys(out).length) return V.fail("a ratio needs a numerator or a denominator");
    return { ok: true, value: out };
  }

  private async buildReference(item: unknown, path: string): Promise<V.Parsed<unknown>> {
    const r = V.classifyReference(item);
    if (r.kind === "error") return V.fail(r.message);
    if (r.kind === "external") return { ok: true, value: r.reference };
    const out: Record<string, unknown> = { reference: keyToUrn(this.ctx.contextId, r.key) };
    if (r.display) out.display = r.display;
    if (r.key === this.ownKey || this.knownKeys.has(r.key)) this.resolved.add(r.key);
    else {
      this.pending.add(r.key);
      this.pendingPaths.push(path);
    }
    return { ok: true, value: out };
  }

  private async buildAnnotation(item: unknown): Promise<V.Parsed<unknown>> {
    if (typeof item === "string") return item.trim() ? { ok: true, value: { text: item.trim() } } : V.fail("empty note");
    if (!isObject(item)) return V.fail(`a note needs text, got ${V.describe(item)}`);
    const out: Record<string, unknown> = {};
    if (typeof item.text === "string" && item.text.trim()) out.text = item.text.trim();
    else return V.fail("a note needs text");
    if (item.time !== undefined) {
      const d = V.parseDateValue(item.time);
      if (!d.ok) return V.fail(`note time: ${d.message}`);
      const f = V.fitDate(d.value, "dateTime", this.ctx.timezone);
      if (!f.ok) return V.fail(`note time: ${f.message}`);
      out.time = f.value;
    }
    if (typeof item.author === "string") out.authorString = item.author;
    else if (isObject(item.author)) {
      const ref = await this.buildReference(item.author, "");
      if (ref.ok) out.authorReference = ref.value;
    }
    if (typeof item.authorString === "string") out.authorString = item.authorString;
    if (isObject(item.authorReference)) out.authorReference = item.authorReference;
    return { ok: true, value: out };
  }

  private async buildIdentifier(node: Node, item: unknown, field: string, path: string): Promise<V.Parsed<unknown>> {
    if (typeof item === "string" || V.isNumberLike(item)) {
      const v = String(V.isNumberLike(item) ? Number(item) : item).trim();
      return v ? { ok: true, value: { value: v } } : V.fail("empty identifier");
    }
    if (!isObject(item)) return V.fail(`an identifier needs {value, system?, type?}, got ${V.describe(item)}`);
    const out: Record<string, unknown> = {};
    if (item.value !== undefined && item.value !== null) {
      if (typeof item.value !== "string" && !V.isNumberLike(item.value)) return V.fail("identifier value must be a string");
      out.value = String(V.isNumberLike(item.value) ? Number(item.value) : item.value).trim();
    }
    if (item.system !== undefined && item.system !== null) {
      if (typeof item.system !== "string" || !item.system.trim()) return V.fail("identifier system must be a URI string");
      out.system = item.system.trim();
    }
    if (item.use !== undefined && item.use !== null) {
      const useNode = await this.childNode(node, "Identifier", "use");
      const u = useNode ? await this.buildCode(useNode, item.use) : typeof item.use === "string" ? { ok: true as const, value: item.use } : V.fail("identifier use must be a code");
      if (!u.ok) return V.fail(`identifier use: ${u.message}`);
      out.use = u.value;
    }
    if (item.type !== undefined && item.type !== null) {
      const typeNode = await this.childNode(node, "Identifier", "type");
      const binding = typeNode ? this.effectiveBinding(typeNode) : { strength: "extensible", valueSet: "http://hl7.org/fhir/ValueSet/identifier-type" };
      const t = await this.buildCodeableConcept(item.type, binding, `${path}.type`, { allowBareCode: true });
      if (!t.ok) return V.fail(`identifier type: ${t.message}`, t.candidates);
      out.type = t.value;
    }
    if (item.period !== undefined && item.period !== null) {
      const p = await this.buildPeriod(item.period);
      if (!p.ok) return V.fail(`identifier period: ${p.message}`);
      out.period = p.value;
    }
    if (item.assigner !== undefined && item.assigner !== null) {
      if (typeof item.assigner === "string" && !/^(urn:|https?:|#|[A-Z][A-Za-z]+\/)/.test(item.assigner.trim()) && !this.knownKeys.has(item.assigner.trim())) {
        out.assigner = { display: item.assigner.trim() };
      } else {
        const r = await this.buildReference(item.assigner, `${path}.assigner`);
        if (!r.ok) return V.fail(`identifier assigner: ${r.message}`);
        out.assigner = r.value;
      }
    }
    if (!Object.keys(out).length) return V.fail("an identifier needs at least a value");
    if (out.value === undefined) return V.fail("an identifier needs a value");
    void field;
    return { ok: true, value: out };
  }

  /** The child definition `name` of a complex-typed node (profile-expanded, else from the datatype). */
  private async childNode(node: Node, type: string, name: string): Promise<Node | null> {
    const r = await this.resolveSegment(node, name, type);
    return r ? r.node : null;
  }

  /**
   * Object value of a backbone element / datatype: every key is a child field of the element
   * (slices and choice forms allowed), placed recursively.
   */
  private async buildObject(node: Node, type: string, item: unknown, field: string, path: string): Promise<V.Parsed<unknown>> {
    if (!isObject(item)) {
      const names = await this.childNames(node, type);
      return V.fail(`${node.def.name} expects an object${names.length ? ` with fields ${names.slice(0, 12).join(", ")}${names.length > 12 ? ", …" : ""}` : ""}, got ${V.describe(item)}`);
    }
    const out: Record<string, any> = {};
    const before = this.errors.length;
    for (const [k, v] of Object.entries(item)) {
      if (v === undefined || v === null) continue;
      const r = await this.resolveSegment(node, k, type);
      if (!r) {
        const names = await this.childNames(node, type);
        this.unknownField(`${field}.${k}`, k, names, path);
        continue;
      }
      if (r.node.def.max === "0") {
        this.error(`${field}.${k}`, `${path}.${k}`, `${k} is prohibited by the profile (max 0)`);
        continue;
      }
      await this.placeValue(r.node, r.forcedType ?? null, v, `${field}.${k}`, out, path, true);
    }
    if (this.errors.length > before && !Object.keys(out).length) return V.fail("no usable field in the object (see the errors reported for its fields)");
    if (!Object.keys(out).length) return V.fail(`${node.def.name}: empty object`);
    return { ok: true, value: out };
  }

  // ------------------------------------------------------------------ coded values

  /** The binding to resolve labels against: the element's own, else its `.coding` child's when stronger. */
  private effectiveBinding(node: Node): { strength: string; valueSet: string } | null {
    const own = node.def.binding;
    const rank = (s: string | undefined): number => ({ required: 3, extensible: 2, preferred: 1 })[s || ""] ?? 0;
    const coding = node.index.child(node.def, "coding");
    const child = coding?.binding ?? null;
    if (child && rank(child.strength) > rank(own?.strength)) return child;
    return own;
  }

  /** Local expansion of a ValueSet (codings + whether it was cut at the limit); null when not expandable. */
  private expansion(valueSet: string): Promise<{ codings: ExpandedCoding[]; truncated: boolean } | null> {
    const key = valueSet;
    let p = this.expansions.get(key);
    if (!p) {
      p = this.deps.expandValueSet
        ? this.deps
            .expandValueSet(valueSet, EXPANSION_LIMIT)
            .then((r) => (r ? { codings: r.codings, truncated: r.truncated } : null))
            .catch(() => null)
        : Promise.resolve(null);
      this.expansions.set(key, p);
    }
    return p;
  }

  private async inValueSet(valueSet: string, system: string | null, code: string): Promise<boolean | undefined> {
    const exp = await this.expansion(valueSet);
    if (exp && exp.codings.some((c) => c.code === code && (system === null || c.system === system))) return true;
    if (this.deps.valueSetContains) {
      try {
        const r = await this.deps.valueSetContains(valueSet, system, code);
        if (r !== undefined) return r;
      } catch {
        // undecided
      }
    }
    if (!exp || exp.truncated) return undefined;
    return false;
  }

  /**
   * The coding of a ValueSet with this code: from the expansion, or — when the expansion is cut
   * at the limit — by membership of the code under one of the expansion's systems.
   */
  private async findInValueSet(valueSet: string, code: string, caseInsensitive = false): Promise<ExpandedCoding | null> {
    const exp = await this.expansion(valueSet);
    if (!exp) return null;
    const lower = code.toLowerCase();
    const hit = exp.codings.find((c) => c.code === code) ?? (caseInsensitive ? exp.codings.find((c) => c.code.toLowerCase() === lower) : undefined);
    if (hit) return hit;
    if (!exp.truncated || !this.deps.valueSetContains) return null;
    for (const system of [...new Set(exp.codings.map((c) => c.system).filter((x): x is string => !!x))]) {
      try {
        if ((await this.deps.valueSetContains(valueSet, system, code)) === true) return { system, code, display: null };
      } catch {
        // undecided
      }
    }
    return null;
  }

  /**
   * A label / code text → one coding of the bound ValueSet: an exact code or display of the local
   * expansion, else an `exact` candidate of fhir_normalize_code. Otherwise the candidates are
   * returned for the error (the composer never picks a fuzzy match).
   */
  private async resolveBound(
    text: string,
    valueSet: string,
  ): Promise<({ ok: true; value: { system: string | null; code: string; display: string | null } }) | { ok: false; message: string; candidates?: unknown[]; decided: boolean }> {
    const exp = await this.expansion(valueSet);
    const lower = text.toLowerCase();
    const byCode = await this.findInValueSet(valueSet, text, true);
    if (byCode) return { ok: true, value: byCode };
    if (exp) {
      const byDisplay = exp.codings.find((c) => (c.display || "").toLowerCase() === lower);
      if (byDisplay) return { ok: true, value: byDisplay };
    }
    let candidates: NormalizeCandidate[] = [];
    if (this.deps.normalize) {
      try {
        candidates = await this.deps.normalize(text, { valueSet: stripVersion(valueSet) }, 5);
      } catch {
        candidates = [];
      }
      // An exact hit is taken only when it is a member of this ValueSet (normalize may answer from a
      // sibling CodeSystem of the same IG); without any local way to decide, the exact hit stands.
      for (const c of candidates.filter((x) => x.exact)) {
        const member = c.system ? await this.inValueSet(valueSet, c.system, c.code) : undefined;
        if (member !== false) return { ok: true, value: { system: c.system, code: c.code, display: c.display } };
      }
    }
    const shown = candidates.slice(0, 5).map((c) => ({ system: c.system, code: c.code, display: c.display }));
    const vsName = stripVersion(valueSet).split("/").pop();
    return {
      ok: false,
      message: `'${text}' is not a code of the required ValueSet ${vsName}${shown.length ? "; pick one of the candidates and give {system, code}" : exp ? "" : " (no local expansion to check against; give {system, code})"}`,
      candidates: shown,
      decided: !!exp || candidates.length > 0,
    };
  }

  /** A code without a system: the binding's expansion decides it when every code of the set has the same system. */
  private async inferSystem(code: string, binding: { strength: string; valueSet: string } | null): Promise<string | null> {
    if (!binding) return null;
    const found = await this.findInValueSet(binding.valueSet, code);
    if (found?.system) return found.system;
    const exp = await this.expansion(binding.valueSet);
    if (!exp) return null;
    const systems = new Set(exp.codings.filter((c) => c.system).map((c) => c.system));
    return systems.size === 1 ? [...systems][0] : null;
  }

  private async buildCoding(item: unknown, binding: { strength: string; valueSet: string } | null, path: string, opts: { allowBareCode?: boolean } = {}): Promise<V.Parsed<Record<string, unknown>>> {
    if (typeof item === "string" || V.isNumberLike(item)) {
      const text = String(V.isNumberLike(item) ? Number(item) : item).trim();
      if (!text) return V.fail("empty coding");
      if (binding) {
        const r = await this.resolveBound(text, binding.valueSet);
        if (r.ok) {
          const out: Record<string, unknown> = { code: r.value.code };
          if (r.value.system) {
            out.system = r.value.system;
            this.mark(`${path}.system`, "lookup");
          }
          if (r.value.display) {
            out.display = r.value.display;
            this.mark(`${path}.display`, "lookup");
          }
          return { ok: true, value: out };
        }
        if (binding.strength === "required" && (r.decided || !opts.allowBareCode)) return V.fail(r.message, r.candidates);
      }
      if (opts.allowBareCode && !/\s/.test(text)) return { ok: true, value: { code: text } };
      return V.fail(`a Coding needs {system, code} (got the text ${JSON.stringify(text)})`);
    }
    if (!isObject(item)) return V.fail(`a Coding needs {system, code, display?}, got ${V.describe(item)}`);
    const out: Record<string, unknown> = {};
    for (const k of ["system", "version", "code", "display"]) {
      if (item[k] === undefined || item[k] === null) continue;
      if (typeof item[k] !== "string" && !(k === "code" && V.isNumberLike(item[k]))) return V.fail(`coding.${k} must be a string`);
      out[k] = String(V.isNumberLike(item[k]) ? Number(item[k]) : item[k]).trim();
    }
    if (typeof item.userSelected === "boolean") out.userSelected = item.userSelected;
    if (out.code === undefined) return V.fail("a Coding needs a code");
    if (out.system === undefined) {
      const sys = await this.inferSystem(String(out.code), binding);
      if (sys) {
        out.system = sys;
        this.mark(`${path}.system`, "lookup");
      }
    }
    return { ok: true, value: out };
  }

  private async buildCodeableConcept(
    item: unknown,
    binding: { strength: string; valueSet: string } | null,
    path: string,
    opts: { allowBareCode?: boolean } = {},
  ): Promise<V.Parsed<Record<string, unknown>>> {
    if (typeof item === "string" || V.isNumberLike(item)) {
      const text = String(V.isNumberLike(item) ? Number(item) : item).trim();
      if (!text) return V.fail("empty value");
      const required = binding?.strength === "required";
      if (binding) {
        const r = await this.resolveBound(text, binding.valueSet);
        if (r.ok) {
          const coding: Record<string, unknown> = { code: r.value.code };
          if (r.value.system) coding.system = r.value.system;
          if (r.value.display) coding.display = r.value.display;
          this.mark(`${path}.coding[0]`, "lookup");
          const out: Record<string, unknown> = { coding: [coding] };
          // the model's label stays as text unless it is the code / display itself
          const lower = text.toLowerCase();
          if (lower !== r.value.code.toLowerCase() && lower !== (r.value.display || "").toLowerCase()) out.text = text;
          return { ok: true, value: out };
        }
        if (required) {
          if (opts.allowBareCode && !r.decided && !/\s/.test(text)) return { ok: true, value: { coding: [{ code: text }] } };
          return V.fail(r.message, r.candidates);
        }
      }
      if (opts.allowBareCode && !/\s/.test(text) && !required) return { ok: true, value: { coding: [{ code: text }] } };
      return { ok: true, value: { text } };
    }
    if (Array.isArray(item)) {
      const codings: unknown[] = [];
      for (let i = 0; i < item.length; i++) {
        const c = await this.buildCoding(item[i], binding, `${path}.coding[${i}]`, opts);
        if (!c.ok) return V.fail(`coding ${i + 1}: ${c.message}`, c.candidates);
        codings.push(c.value);
      }
      return codings.length ? { ok: true, value: { coding: codings } } : V.fail("empty list of codings");
    }
    if (!isObject(item)) return V.fail(`expected {system, code, display?}, {text}, or a list of codings, got ${V.describe(item)}`);
    const out: Record<string, unknown> = {};
    let codingList: unknown[] | null = Array.isArray(item.coding) ? item.coding : null;
    if (!codingList && isObject(item.coding)) {
      // FHIR shape with a single Coding object where FHIR wants an array (coding is 0..*)
      codingList = [item.coding];
      this.note(`wrapped ${path}.coding into an array`);
    }
    if (codingList) {
      const codings: unknown[] = [];
      for (let i = 0; i < codingList.length; i++) {
        const c = await this.buildCoding(codingList[i], binding, `${path}.coding[${i}]`, opts);
        if (!c.ok) return V.fail(`coding ${i + 1}: ${c.message}`, c.candidates);
        codings.push(c.value);
      }
      if (codings.length) out.coding = codings;
    } else if (item.code !== undefined || item.system !== undefined) {
      const c = await this.buildCoding(item, binding, `${path}.coding[0]`, opts);
      if (!c.ok) return c;
      out.coding = [c.value];
    }
    if (typeof item.text === "string" && item.text.trim()) out.text = item.text.trim();
    if (!Object.keys(out).length) return V.fail("a CodeableConcept needs codings or text");
    return { ok: true, value: out };
  }

  // ------------------------------------------------------------------ dosage / timing

  private async buildDosage(node: Node, item: unknown, field: string, path: string): Promise<V.Parsed<unknown>> {
    if (typeof item === "string") return item.trim() ? { ok: true, value: { text: item.trim() } } : V.fail("empty dosage");
    if (!isObject(item)) return V.fail(`a dosage needs {text?, route?, dose?, frequency?, period?, asNeeded?}, got ${V.describe(item)}`);
    const out: Record<string, any> = {};
    const errs: string[] = [];
    let candidates: unknown[] | undefined;
    const rest: Record<string, unknown> = { ...item };
    const take = (k: string): unknown => {
      const v = rest[k];
      delete rest[k];
      return v === null ? undefined : v;
    };
    const text = take("text");
    if (text !== undefined) {
      if (typeof text !== "string") errs.push("text must be a string");
      else if (text.trim()) out.text = text.trim();
    }
    const patientInstruction = take("patientInstruction");
    if (typeof patientInstruction === "string" && patientInstruction.trim()) out.patientInstruction = patientInstruction.trim();
    const sequence = take("sequence");
    if (sequence !== undefined) {
      const n = V.parseInteger(sequence);
      if (n.ok) out.sequence = n.value;
      else errs.push(`sequence: ${n.message}`);
    }
    for (const k of ["route", "site", "method"]) {
      const v = take(k);
      if (v === undefined) continue;
      const child = await this.childNode(node, "Dosage", k);
      const r = await this.buildCodeableConcept(v, child ? this.effectiveBinding(child) : null, `${path}.${k}`);
      if (r.ok) out[k] = r.value;
      else {
        errs.push(`${k}: ${r.message}`);
        candidates = candidates ?? r.candidates;
      }
    }
    const additional = take("additionalInstruction");
    if (additional !== undefined) {
      const child = await this.childNode(node, "Dosage", "additionalInstruction");
      const list = Array.isArray(additional) ? additional : [additional];
      const built: unknown[] = [];
      for (let i = 0; i < list.length; i++) {
        const r = await this.buildCodeableConcept(list[i], child ? this.effectiveBinding(child) : null, `${path}.additionalInstruction[${i}]`);
        if (r.ok) built.push(r.value);
        else errs.push(`additionalInstruction: ${r.message}`);
      }
      if (built.length) out.additionalInstruction = built;
    }
    // dose / rate → doseAndRate[0]
    const dose = take("dose") ?? take("doseQuantity");
    const doseRange = take("doseRange");
    const rate = take("rate") ?? take("rateQuantity");
    const rateRatio = take("rateRatio");
    const dar: Record<string, unknown> = {};
    if (dose !== undefined) {
      if (isObject(dose) && (dose.low !== undefined || dose.high !== undefined)) {
        const r = await this.buildRange(dose, `${path}.doseAndRate[0].doseRange`);
        if (r.ok) dar.doseRange = r.value;
        else errs.push(`dose: ${r.message}`);
      } else {
        const q = await this.buildQuantity(dose, `${path}.doseAndRate[0].doseQuantity`);
        if (q.ok) dar.doseQuantity = q.value;
        else errs.push(`dose: ${q.message}`);
      }
    }
    if (doseRange !== undefined) {
      const r = await this.buildRange(doseRange, `${path}.doseAndRate[0].doseRange`);
      if (r.ok) dar.doseRange = r.value;
      else errs.push(`doseRange: ${r.message}`);
    }
    if (rate !== undefined) {
      if (isObject(rate) && (rate.numerator !== undefined || rate.denominator !== undefined)) {
        const r = await this.buildRatio(rate, `${path}.doseAndRate[0].rateRatio`);
        if (r.ok) dar.rateRatio = r.value;
        else errs.push(`rate: ${r.message}`);
      } else {
        const q = await this.buildQuantity(rate, `${path}.doseAndRate[0].rateQuantity`);
        if (q.ok) dar.rateQuantity = q.value;
        else errs.push(`rate: ${q.message}`);
      }
    }
    if (rateRatio !== undefined) {
      const r = await this.buildRatio(rateRatio, `${path}.doseAndRate[0].rateRatio`);
      if (r.ok) dar.rateRatio = r.value;
      else errs.push(`rateRatio: ${r.message}`);
    }
    const darType = take("doseType");
    if (darType !== undefined) {
      const r = await this.buildCodeableConcept(darType, { strength: "example", valueSet: "http://hl7.org/fhir/ValueSet/dose-rate-type" }, `${path}.doseAndRate[0].type`);
      if (r.ok) dar.type = r.value;
    }
    const doseAndRate = take("doseAndRate");
    if (isObject(doseAndRate)) {
      out.doseAndRate = [clone(doseAndRate)];
      this.note(`wrapped ${path}.doseAndRate into an array`);
    } else if (Array.isArray(doseAndRate) && doseAndRate.length) out.doseAndRate = clone(doseAndRate);
    else if (Object.keys(dar).length) out.doseAndRate = [dar];
    // frequency / timing / period
    const timingNode = await this.childNode(node, "Dosage", "timing");
    const frequency = take("frequency") ?? take("timing");
    const period = take("period");
    const timing: Record<string, any> = {};
    if (frequency !== undefined) {
      if (isObject(frequency) && (frequency.repeat !== undefined || frequency.event !== undefined || frequency.code !== undefined)) {
        const t = await this.buildTiming(timingNode ?? node, frequency, `${field}.timing`, `${path}.timing`);
        if (t.ok) Object.assign(timing, t.value as Record<string, unknown>);
        else errs.push(`timing: ${t.message}`);
      } else {
        const f = V.parseFrequency(frequency);
        if (!f) errs.push(`frequency not understood: ${JSON.stringify(frequency)} (use e.g. "BID", "q8h", "3 times a day", "每天三次", or {frequency, period, periodUnit})`);
        else {
          timing.repeat = f.repeat;
          if (f.asNeeded && rest.asNeeded === undefined) rest.asNeeded = true;
          if (f.abbreviation && timingNode) {
            const code = await this.timingCode(timingNode, f.abbreviation);
            if (code) {
              timing.code = code;
              this.mark(`${path}.timing.code`, "lookup");
            }
          }
        }
      }
    }
    if (period !== undefined) {
      const bounds = await this.buildBounds(period, `${path}.timing.repeat`);
      if (!bounds.ok) errs.push(`period: ${bounds.message}`);
      else {
        timing.repeat = { ...(timing.repeat || {}), ...bounds.value };
      }
    }
    if (Object.keys(timing).length) out.timing = timing;
    const asNeeded = take("asNeeded") ?? take("asNeededBoolean") ?? take("asNeededCodeableConcept") ?? take("prn");
    if (asNeeded !== undefined) {
      const b = V.parseBoolean(asNeeded);
      if (b.ok) out.asNeededBoolean = b.value;
      else {
        const child = await this.childNode(node, "Dosage", "asNeeded[x]");
        const r = await this.buildCodeableConcept(asNeeded, child ? this.effectiveBinding(child) : null, `${path}.asNeededCodeableConcept`);
        if (r.ok) out.asNeededCodeableConcept = r.value;
        else errs.push(`asNeeded: ${r.message}`);
      }
    }
    for (const k of ["maxDosePerPeriod"]) {
      const v = take(k);
      if (v === undefined) continue;
      const r = await this.buildRatio(v, `${path}.${k}`);
      if (r.ok) out[k] = r.value;
      else errs.push(`${k}: ${r.message}`);
    }
    for (const k of ["maxDosePerAdministration", "maxDosePerLifetime"]) {
      const v = take(k);
      if (v === undefined) continue;
      const r = await this.buildQuantity(v, `${path}.${k}`);
      if (r.ok) out[k] = r.value;
      else errs.push(`${k}: ${r.message}`);
    }
    const unknown = Object.keys(rest).filter((k) => rest[k] !== undefined);
    if (unknown.length) errs.push(`unknown dosage field(s) ${unknown.join(", ")}; valid: text, route, dose, doseRange, rate, frequency (or timing), period, asNeeded, site, method, additionalInstruction, patientInstruction, sequence, maxDosePerPeriod, maxDosePerAdministration, maxDosePerLifetime`);
    if (errs.length) return V.fail(errs.join("; "), candidates);
    if (!Object.keys(out).length) return V.fail("empty dosage");
    return { ok: true, value: out };
  }

  /** Timing.code for a frequency abbreviation when the element's bound ValueSet (not example) holds that code. */
  private async timingCode(timingNode: Node, abbreviation: string): Promise<Record<string, unknown> | null> {
    const codeNode = await this.childNode(timingNode, "Timing", "code");
    const binding = codeNode ? this.effectiveBinding(codeNode) : null;
    if (!binding || binding.strength === "example") return null;
    const hit = await this.findInValueSet(binding.valueSet, abbreviation.toUpperCase(), true);
    if (!hit || !hit.system) return null;
    const coding: Record<string, unknown> = { system: hit.system, code: hit.code };
    if (hit.display) coding.display = hit.display;
    return { coding: [coding] };
  }

  /** A dosage `period`: `{start, end}` → boundsPeriod; "7 days" / {value, unit} → boundsDuration. */
  private async buildBounds(raw: unknown, path: string): Promise<V.Parsed<Record<string, unknown>>> {
    if (isObject(raw) && (raw.start !== undefined || raw.end !== undefined)) {
      const p = await this.buildPeriod(raw);
      return p.ok ? { ok: true, value: { boundsPeriod: p.value } } : p;
    }
    if (typeof raw === "string" && V.parseDateValue(raw).ok) {
      const p = await this.buildPeriod(raw);
      return p.ok ? { ok: true, value: { boundsPeriod: p.value } } : p;
    }
    if (isObject(raw) && (raw.low !== undefined || raw.high !== undefined)) {
      const r = await this.buildRange(raw, `${path}.boundsRange`);
      return r.ok ? { ok: true, value: { boundsRange: r.value } } : r;
    }
    const q = V.parseQuantityValue(raw);
    if (!q.ok) return V.fail(`${q.message}; a dosage period is {start, end} or a duration such as "7 days"`);
    const unitWord = q.value.unit ? V.timeUnitCode(q.value.unit) : null;
    const dur: Record<string, unknown> = { value: q.value.value };
    if (unitWord) {
      dur.unit = q.value.unit;
      dur.system = UCUM_SYSTEM;
      dur.code = unitWord;
      this.mark(`${path}.boundsDuration.code`, "lookup");
    } else if (q.value.code) {
      dur.unit = q.value.unit;
      dur.system = q.value.system;
      dur.code = q.value.code;
    } else if (q.value.unit) dur.unit = q.value.unit;
    return { ok: true, value: { boundsDuration: dur } };
  }

  private async buildTiming(node: Node, item: unknown, field: string, path: string): Promise<V.Parsed<unknown>> {
    if (typeof item === "string") {
      const f = V.parseFrequency(item);
      if (!f) return V.fail(`frequency not understood: ${JSON.stringify(item)} (use e.g. "BID", "q8h", "3 times a day", "每天三次", or {frequency, period, periodUnit})`);
      const out: Record<string, unknown> = { repeat: f.repeat };
      if (f.abbreviation) {
        const code = await this.timingCode(node, f.abbreviation);
        if (code) {
          out.code = code;
          this.mark(`${path}.code`, "lookup");
        }
      }
      return { ok: true, value: out };
    }
    if (!isObject(item)) return V.fail(`a timing needs a frequency text or {repeat: {frequency, period, periodUnit}}, got ${V.describe(item)}`);
    if (item.repeat === undefined && item.event === undefined && item.code === undefined) {
      const f = V.parseFrequency(item);
      if (!f) return V.fail("timing not understood: give {frequency, period, periodUnit} or a frequency text");
      return { ok: true, value: { repeat: f.repeat } };
    }
    const out: Record<string, unknown> = {};
    if (item.repeat !== undefined) {
      const f = V.parseFrequency(item.repeat);
      if (!f) return V.fail("timing.repeat not understood: give {frequency, period, periodUnit}");
      out.repeat = f.repeat;
    }
    if (item.event !== undefined) {
      const list = Array.isArray(item.event) ? item.event : [item.event];
      const events: string[] = [];
      for (const e of list) {
        const d = V.parseDateValue(e);
        if (!d.ok) return V.fail(`timing event: ${d.message}`);
        const fit = V.fitDate(d.value, "dateTime", this.ctx.timezone);
        if (!fit.ok) return V.fail(`timing event: ${fit.message}`);
        events.push(fit.value);
      }
      out.event = events;
    }
    if (item.code !== undefined) {
      const codeNode = await this.childNode(node, "Timing", "code");
      const r = await this.buildCodeableConcept(item.code, codeNode ? this.effectiveBinding(codeNode) : null, `${path}.code`);
      if (!r.ok) return V.fail(`timing code: ${r.message}`, r.candidates);
      out.code = r.value;
    }
    void field;
    return { ok: true, value: out };
  }

  // ------------------------------------------------------------------ arrays

  /**
   * Every element with max > 1 that holds a single object / scalar is wrapped into a one-item
   * array, at any depth, by the element definitions (profile, then the datatype's own SD). This
   * catches the raw FHIR shapes the composer keeps as written (an extension given with its url,
   * Meta, Attachment, doseAndRate …); the value-grammar paths already place arrays themselves.
   */
  async wrapArrays(): Promise<void> {
    const extIndex = async (): Promise<Node | null> => {
      const idx = await this.datatypeIndex("Extension");
      return idx ? { index: idx, def: idx.root } : null;
    };
    const walk = async (node: Node, type: string | null, obj: Record<string, any>, path: string, depth: number): Promise<void> => {
      if (depth > 24) return;
      for (const k of Object.keys(obj)) {
        const v = obj[k];
        if (v === undefined || v === null || k === "resourceType") continue;
        let child: Node | null = null;
        let childType: string | null = null;
        let isArray: boolean;
        const r = await this.resolveSegment(node, k, type);
        if (r && !r.node.def.name.endsWith("[x]")) {
          child = r.node;
          isArray = r.node.def.isArray;
          childType = r.forcedType ?? (r.node.def.types.length === 1 ? r.node.def.types[0] : r.node.def.contentReference ? "BackboneElement" : null);
        } else if (r) {
          child = r.node;
          isArray = false;
          childType = r.forcedType ?? null;
        } else if (k === "extension" || k === "modifierExtension") {
          child = await extIndex();
          isArray = true;
          childType = "Extension";
        } else continue;
        const p = `${path}.${k}`;
        if (isArray && !Array.isArray(v)) {
          this.rekeyWrapped(p);
          obj[k] = [v];
          this.note(`wrapped ${p} into an array`);
        }
        if (!child || !childType || PRIMITIVES.has(childType) || childType === "Resource" || childType === "DomainResource") continue;
        const cur = obj[k];
        const items: Array<[unknown, string]> = Array.isArray(cur) ? cur.map((x, i): [unknown, string] => [x, `${p}[${i}]`]) : [[cur, p]];
        for (const [it, ip] of items) {
          if (!isObject(it)) continue;
          await walk(child, childType === "BackboneElement" || childType === "Element" ? null : childType, it, ip, depth + 1);
        }
      }
    };
    await walk({ index: this.index, def: this.index.root }, null, this.resource, this.rt, 0);
  }

  // ------------------------------------------------------------------ slices

  /** Entries of sliced elements the model did not name: assign the one slice they satisfy. */
  assignSlices(): void {
    for (const def of this.index.ordered) {
      if (def.sliceName || !def.el.slicing) continue;
      const g = this.index.children(this.index.byId.get(def.parentId!) ?? this.index.root)?.get(def.name);
      if (!g || !g.slices.length) continue;
      for (const h of this.nodesOf(def.id)) {
        if (!isObject(h.node) || this.entrySlice.has(h.node) || !h.key) continue;
        const live = g.slices.filter((s) => s.max !== "0");
        const hits = live.filter((s) => this.sliceMatch(h.node, h.key!, s.id) === true);
        if (hits.length === 1) {
          this.entrySlice.set(h.node, hits[0].id);
          continue;
        }
        if (hits.length) continue;
        // Every discriminator value the entry carries fits exactly one slice and the ones it lacks are
        // fixed / pattern values the profile supplies (e.g. an identifier given with its type code but
        // not the type system): assign it, pinning completes the entry.
        const partial = live.filter((s) => this.sliceCompatible(h.node, h.key!, s.id));
        if (partial.length === 1) this.entrySlice.set(h.node, partial[0].id);
      }
    }
  }

  // ------------------------------------------------------------------ determined content

  private determinedCache = new Map<string, boolean>();

  /** Required children (base elements and required slices) of a definition. */
  private requiredChildren(def: Def): Def[] {
    const out: Def[] = [];
    for (const grp of this.index.children(def)?.values() || []) {
      if (grp.base && grp.base.min >= 1 && grp.base.max !== "0") out.push(grp.base);
      for (const s of grp.slices) if (s.min >= 1 && s.max !== "0") out.push(s);
    }
    return out;
  }

  private hasDarInvariant(def: Def): boolean {
    return (def.el.constraint || []).some((c: any) => {
      if (c.severity && c.severity !== "error") return false;
      const inv = parseOneOfInvariant(c.expression);
      return !!inv && inv.terms.includes("dataAbsentReason");
    });
  }

  /** Whether the profile fully decides the content of `def` (fixed / pattern, or required children it decides). */
  private determined(def: Def): boolean {
    const hit = this.determinedCache.get(def.id);
    if (hit !== undefined) return hit;
    let out: boolean;
    if (def.fixed || def.pattern) out = true;
    else if (def.types.length === 1 && PRIMITIVES.has(def.types[0])) out = false;
    else if (this.hasDarInvariant(def)) out = false;
    else {
      const kids = this.requiredChildren(def);
      // A sliced base child counts when one of its required slices is determined.
      const bases = kids.filter((k) => !k.sliceName);
      const slices = kids.filter((k) => k.sliceName);
      out =
        kids.length > 0 &&
        bases.every((b) => this.determined(b) || slices.some((s) => s.name === b.name && this.determined(s))) &&
        slices.every((s) => this.determined(s));
    }
    this.determinedCache.set(def.id, out);
    return out;
  }

  /** Build the JSON of a determined definition (its fixed / pattern value plus determined required children). */
  private materialize(def: Def, path: string): unknown {
    let value: any = def.fixed ? clone(def.fixed.value) : def.pattern ? clone(def.pattern.value) : {};
    if (!isObject(value)) return value;
    for (const grp of this.index.children(def)?.values() || []) {
      const kids = [...(grp.base && grp.base.min >= 1 && grp.base.max !== "0" && this.determined(grp.base) ? [grp.base] : []), ...grp.slices.filter((s) => s.min >= 1 && s.max !== "0" && this.determined(s))];
      if (!kids.length) continue;
      const base = grp.base ?? kids[0];
      const key = base.name.endsWith("[x]") ? choiceProperty(base.name, (kids[0].fixed || kids[0].pattern ? (kids[0].fixed || kids[0].pattern)!.field.replace(/^(fixed|pattern)/, "") : base.types[0]) || base.types[0]) : base.name;
      // the pattern of the parent may already provide this child
      if (value[key] !== undefined && !base.isArray) continue;
      const items = kids.filter((k) => k.sliceName || !grp.slices.some((s) => s.min >= 1 && this.determined(s)));
      for (const k of items) {
        const built = this.materialize(k, `${path}.${key}`);
        if (base.isArray) {
          if (!Array.isArray(value[key])) value[key] = [];
          if (k.sliceName && value[key].some((x: unknown) => patternMatches(x, built))) continue; // the parent's pattern already holds it
          value[key].push(built);
          if (k.sliceName && isObject(built)) this.entrySlice.set(built, k.id);
          this.mark(`${path}.${key}[${value[key].length - 1}]`, "fixed");
        } else {
          value[key] = built;
          this.mark(`${path}.${key}`, "fixed");
        }
      }
    }
    return value;
  }

  /**
   * Create required content the profile decides, where the required chain reaches it; inside
   * every existing member (model-given entries, slice members) the same rule applies to its
   * required children.
   */
  createDetermined(): void {
    const visit = (def: Def, parents: Hit[], depth: number): void => {
      if (depth > 30) return;
      for (const grp of this.index.children(def)?.values() || []) {
        const base = grp.base;
        const slices = grp.slices.filter((s) => s.min >= 1 && s.max !== "0");
        const baseRequired = !!base && base.min >= 1 && base.max !== "0";
        for (const p of parents) {
          if (!isObject(p.node)) continue;
          // existing members: their own required children (per slice, then per base definition)
          if (base) {
            for (const m of this.nodesOf(base.id).filter((h) => h.parent === p.node)) {
              if (!isObject(m.node)) continue;
              const sliceId = this.entrySlice.get(m.node) ?? grp.slices.find((s) => s.max !== "0" && this.sliceMatch(m.node, m.key!, s.id) === true)?.id;
              const sliceDef = sliceId ? this.index.byId.get(sliceId) : undefined;
              if (sliceDef) visit(sliceDef, [m], depth + 1);
              visit(base, [m], depth + 1);
            }
          }
          if (!baseRequired && !slices.length) continue;
          const kids: Def[] = [];
          if (baseRequired && !slices.length) kids.push(base!);
          kids.push(...slices);
          for (const kid of kids) {
            const members = this.nodesOf(kid.id).filter((h) => h.parent === p.node);
            if (members.length) continue;
            if (!this.determined(kid)) continue;
            const key = kid.name.endsWith("[x]") ? choiceProperty(kid.name, (kid.fixed || kid.pattern ? (kid.fixed || kid.pattern)!.field.replace(/^(fixed|pattern)/, "") : kid.types[0]) || kid.types[0]) : kid.name;
            const isArray = (base ?? kid).isArray;
            const built = this.materialize(kid, isArray ? `${p.path}.${key}[${Array.isArray(p.node[key]) ? p.node[key].length : 0}]` : `${p.path}.${key}`);
            if (isArray) {
              if (!Array.isArray(p.node[key])) p.node[key] = [];
              p.node[key].push(built);
              if (kid.sliceName && isObject(built)) this.entrySlice.set(built, kid.id);
              this.mark(`${p.path}.${key}[${p.node[key].length - 1}]`, "fixed");
            } else {
              if (p.node[key] !== undefined) continue;
              p.node[key] = built;
              this.mark(`${p.path}.${key}`, "fixed");
            }
          }
        }
      }
    };
    visit(this.index.root, [{ node: this.resource, path: this.rt, parent: null, key: null }], 0);
  }

  // ------------------------------------------------------------------ fixed / pattern pinning

  pinFixedPattern(): void {
    for (const def of this.index.ordered) {
      if (!def.fixed && !def.pattern) continue;
      if (def.max === "0" || !def.parentId) continue;
      const pin = (def.fixed || def.pattern)!;
      const isFixed = !!def.fixed;
      const key = def.name.endsWith("[x]") ? choiceProperty(def.name, pin.field.replace(/^(fixed|pattern)/, "")) : def.name;
      if (def.sliceName) {
        // the slice's own value applies to its members
        for (const h of this.nodesOf(def.id)) this.pinOn(h.parent!, h.key!, Array.isArray(h.parent![h.key!]) ? h.node : undefined, pin.value, isFixed, h.path, def);
        continue;
      }
      for (const p of this.nodesOf(def.parentId)) {
        if (!isObject(p.node)) continue;
        const cur = p.node[key];
        if (Array.isArray(cur)) {
          cur.forEach((item, i) => this.pinOn(p.node, key, item, pin.value, isFixed, `${p.path}.${key}[${i}]`, def));
        } else if (cur === undefined) {
          if (def.isArray && def.min < 1) continue; // never invent an optional repeating item
          if (def.isArray) {
            p.node[key] = [clone(pin.value)];
            this.mark(`${p.path}.${key}[0]`, "fixed");
          } else {
            p.node[key] = clone(pin.value);
            this.mark(`${p.path}.${key}`, "fixed");
          }
        } else this.pinOn(p.node, key, undefined, pin.value, isFixed, `${p.path}.${key}`, def);
      }
    }
  }

  /** Merge a fixed / pattern value into an existing value (array item when `item` is given). */
  private pinOn(parent: Record<string, any>, key: string, item: unknown, expected: unknown, isFixed: boolean, path: string, def: Def): void {
    const current = item !== undefined ? item : parent[key];
    const field = fieldForPath(this.fieldMap, path);
    if (isFixed) {
      if (deepEqual(current, expected)) return;
      if (isObject(current) && isObject(expected) && Object.keys(expected).every((k) => current[k] === undefined || deepEqual(current[k], expected[k]))) {
        for (const k of Object.keys(expected)) {
          if (current[k] === undefined) {
            current[k] = clone(expected[k]);
            this.mark(`${path}.${k}`, "fixed");
          }
        }
        return;
      }
      this.error(field, path, `the profile fixes ${def.id.replace(/^[^.]+\./, "")} to ${JSON.stringify(expected)}; the given value ${JSON.stringify(current)} contradicts it`);
      return;
    }
    if (patternMatches(current, expected)) return;
    if (isObject(current) && isObject(expected)) {
      this.mergePattern(current, expected, path, field, def);
      return;
    }
    this.error(field, path, `the profile requires ${def.id.replace(/^[^.]+\./, "")} to match ${JSON.stringify(expected)}; the given value ${JSON.stringify(current)} does not`);
  }

  private mergePattern(current: Record<string, any>, pattern: Record<string, any>, path: string, field: string | null, def: Def): void {
    for (const [k, v] of Object.entries(pattern)) {
      const cur = current[k];
      if (cur === undefined || cur === null) {
        current[k] = clone(v);
        this.mark(`${path}.${k}`, "fixed");
      } else if (Array.isArray(v)) {
        const arr = Array.isArray(cur) ? cur : [cur];
        if (!Array.isArray(cur)) current[k] = arr;
        for (const pv of v) {
          if (arr.some((a) => patternMatches(a, pv))) continue;
          // a single scalar-less item that only lacks the pattern's keys is completed, else the pattern item is added
          const fillable = isObject(pv) ? arr.find((a) => isObject(a) && Object.keys(pv).every((pk) => a[pk] === undefined || patternMatches(a[pk], pv[pk]))) : undefined;
          if (fillable) this.mergePattern(fillable, pv, `${path}.${k}[${arr.indexOf(fillable)}]`, field, def);
          else {
            arr.push(clone(pv));
            this.mark(`${path}.${k}[${arr.length - 1}]`, "fixed");
          }
        }
      } else if (isObject(v) && isObject(cur)) this.mergePattern(cur, v, `${path}.${k}`, field, def);
      else if (!patternMatches(cur, v)) {
        this.error(field, `${path}.${k}`, `the profile requires ${def.id.replace(/^[^.]+\./, "")}.${k} to be ${JSON.stringify(v)}; the given value ${JSON.stringify(cur)} contradicts it`);
      }
    }
  }

  // ------------------------------------------------------------------ defaults / derived

  /**
   * defaultValue[x] / workflow defaults, only on elements the profile requires (min >= 1 — a
   * required slice included) whose parent exists; an optional element (Patient.active,
   * Immunization.primarySource …) is never filled, whatever its mustSupport flag. Nothing at all
   * with `applyDefaults: "none"` (the required ones are then reported in `missing`).
   */
  async applyDefaults(): Promise<void> {
    if (this.ctx.applyDefaults === "none") return;
    for (const def of this.index.ordered) {
      if (!def.parentId || def.max === "0" || def.name.endsWith("[x]")) continue;
      if (def.min < 1) continue;
      const gp = stripSlices(def.path);
      let value: unknown;
      const dv = Object.keys(def.el).find((k) => /^defaultValue[A-Z]/.test(k));
      if (dv !== undefined) value = def.el[dv];
      else if (gp in WORKFLOW_DEFAULTS) value = WORKFLOW_DEFAULTS[gp][0];
      else continue;
      for (const p of this.nodesOf(def.parentId)) {
        if (!isObject(p.node) || p.node[def.name] !== undefined) continue;
        if (this.hasError(`${p.path}.${def.name}`)) continue;
        let out: unknown = value;
        const t = def.types[0];
        if (t === "CodeableConcept" || t === "Coding") {
          if (typeof value !== "string") continue;
          const hit = def.binding ? await this.findInValueSet(def.binding.valueSet, value) : null;
          if (!hit || !hit.system) continue; // the system of a default code is never guessed
          const coding: Record<string, unknown> = { system: hit.system, code: hit.code };
          if (hit.display) coding.display = hit.display;
          out = t === "Coding" ? coding : { coding: [coding] };
        } else if (t === "code" && def.binding?.strength === "required" && typeof value === "string") {
          if ((await this.inValueSet(def.binding.valueSet, null, value)) === false) continue;
        }
        const path = `${p.path}.${def.name}${def.isArray ? "[0]" : ""}`;
        p.node[def.name] = def.isArray ? [out] : out;
        this.mark(path, "default");
      }
    }
  }

  /**
   * Computable derivations (fhirRequiredElements DERIVATION_RULES is the LLM-facing text; these are
   * the two that follow from other filled values alone). Applied only to a required / mustSupport
   * element the model left empty whose binding is the one the rule describes.
   */
  async applyDerived(): Promise<void> {
    const rules: Array<[string, (r: Record<string, any>) => string | null]> = [
      ["Condition.category", (r) => (isObject(r.encounter) && typeof r.encounter.reference === "string" ? "encounter-diagnosis" : null)],
      ["Observation.category", (r) => (impliedVitalSignProfile(r.code) ? "vital-signs" : null)],
    ];
    for (const [gp, derive] of rules) {
      const def = this.index.byId.get(gp);
      if (!def || def.max === "0" || (def.min < 1 && !def.el.mustSupport)) continue;
      if (!derivationRuleFor(def.path, def.binding)) continue;
      if (this.resource[def.name] !== undefined) continue;
      const code = derive(this.resource);
      if (!code) continue;
      const hit = def.binding ? await this.findInValueSet(def.binding.valueSet, code) : null;
      if (!hit || !hit.system) continue;
      const coding: Record<string, unknown> = { system: hit.system, code: hit.code };
      if (hit.display) coding.display = hit.display;
      const value = def.types[0] === "Coding" ? coding : { coding: [coding] };
      this.resource[def.name] = def.isArray ? [value] : value;
      this.mark(`${this.rt}.${def.name}${def.isArray ? "[0]" : ""}`, "derived");
    }
  }

  // ------------------------------------------------------------------ lookups

  /**
   * A display is derived from the code, not clinical content: every model-written display of a
   * Coding whose system|code resolves is checked with the validator's terminology rule; one the
   * validator would reject is replaced by the code's display (provenance `lookup`, a note). The
   * model's wording is kept as CodeableConcept.text when that is empty (provenance `model`). A
   * case-only difference is valid as written; a whitespace-only one takes the valid spelling
   * without a note. The code / system are never changed; an unresolvable code keeps its display.
   * Displays the profile pins (fixed / pattern) or the MCP looked up are not touched.
   */
  async checkDisplays(): Promise<void> {
    if (!this.deps.checkDisplay) return;
    interface Job { coding: Record<string, any>; path: string; cc: Record<string, any> | null; ccPath: string | null }
    const jobs: Job[] = [];
    const auto = (p: string): boolean => this.provenance[p] === "fixed" || this.provenance[p] === "lookup";
    const walk = (node: unknown, path: string, skip: boolean, cc: Record<string, any> | null, ccPath: string | null): void => {
      if (Array.isArray(node)) {
        node.forEach((x, i) => walk(x, `${path}[${i}]`, skip, cc, ccPath));
        return;
      }
      if (!isObject(node)) return;
      const skipHere = skip || auto(path);
      if (
        !skipHere &&
        typeof node.system === "string" && typeof node.code === "string" && typeof node.display === "string" && node.display.trim() &&
        node.value === undefined && node.unit === undefined && node.system !== UCUM_SYSTEM && !auto(`${path}.display`)
      ) {
        jobs.push({ coding: node, path, cc, ccPath });
      }
      const isCC = Array.isArray(node.coding);
      for (const [k, v] of Object.entries(node)) {
        if (k === "coding" && isCC) walk(v, `${path}.coding`, skipHere, node, path);
        else walk(v, `${path}.${k}`, skipHere, null, null);
      }
    };
    walk(this.resource, this.rt, false, null, null);
    const ws = (x: string): string => x.replace(/\s+/g, " ").trim().toLowerCase();
    let budget = 40;
    for (const job of jobs) {
      if (budget-- <= 0) break;
      const { coding, path } = job;
      const old: string = coding.display;
      let verdict: { status: string; valid: string[] };
      try {
        verdict = await this.deps.checkDisplay(coding.system, coding.code, old, typeof coding.version === "string" ? coding.version : null);
      } catch {
        continue;
      }
      if (!verdict || verdict.status !== "invalid-display") continue;
      const valid = (verdict.valid || []).filter((d) => typeof d === "string" && d.trim());
      const same = valid.find((d) => ws(d) === ws(old));
      if (same) {
        // whitespace-only difference: the same display, spelled as the terminology does
        coding.display = same;
        this.mark(`${path}.display`, "lookup");
        continue;
      }
      let canonical: string | null = null;
      if (this.deps.lookupDisplay) {
        try {
          canonical = await this.deps.lookupDisplay(coding.system, coding.code);
        } catch {
          canonical = null;
        }
      }
      if (canonical && valid.length && !valid.some((d) => d.toLowerCase() === canonical!.toLowerCase())) canonical = null;
      canonical = canonical ?? valid[0] ?? null;
      if (!canonical || ws(canonical) === ws(old)) continue;
      coding.display = canonical;
      this.mark(`${path}.display`, "lookup");
      this.note(`display replaced for ${this.fieldLabel(path)} (was '${old}')`);
      if (job.cc && job.ccPath && job.cc.text === undefined) {
        job.cc.text = old;
        this.mark(`${job.ccPath}.text`, "model");
      }
    }
  }

  /** Display of every Coding without one (bounded; a failed lookup leaves the coding as it is). */
  async lookupDisplays(): Promise<void> {
    if (!this.deps.lookupDisplay) return;
    const jobs: Array<Promise<void>> = [];
    const walk = (node: unknown, path: string): void => {
      if (Array.isArray(node)) {
        node.forEach((x, i) => walk(x, `${path}[${i}]`));
        return;
      }
      if (!isObject(node)) return;
      if (typeof node.system === "string" && typeof node.code === "string" && node.display === undefined && node.value === undefined && node.unit === undefined && node.system !== UCUM_SYSTEM) {
        if (this.lookupBudget-- > 0) {
          const key = `${node.system}|${node.code}`;
          let p = this.displayLookups.get(key);
          if (!p) {
            p = this.deps.lookupDisplay!(node.system, node.code).catch(() => null);
            this.displayLookups.set(key, p);
          }
          jobs.push(
            p.then((d) => {
              if (d && node.display === undefined) {
                node.display = d;
                this.mark(`${path}.display`, "lookup");
              }
            }),
          );
        }
      }
      for (const [k, v] of Object.entries(node)) walk(v, `${path}.${k}`);
    };
    walk(this.resource, this.rt);
    await Promise.all(jobs);
  }

  // ------------------------------------------------------------------ missing

  missing(profileId: string): Array<{ field: string; why: string }> {
    const rows = requiredElements(profileId, [...this.E.values()], { instance: this.resource, includeTargetImplied: true, includeMustSupport: false });
    const out: Array<{ field: string; why: string }> = [];
    const seen = new Set<string>();
    const erroredFields = new Set(this.errors.map((e) => e.field).filter((f): f is string => !!f));
    for (const row of rows.elements) {
      if (row.optional) continue;
      const rel = row.id.replace(/^[^.]+\./, "");
      if (!rel || rel === row.id) continue;
      if (seen.has(rel)) continue;
      // a parent already reported as missing covers its children
      if ([...seen].some((s) => rel.startsWith(`${s}.`))) continue;
      const top = rel.split(".")[0];
      if (erroredFields.has(rel) || erroredFields.has(top) || [...erroredFields].some((f) => f.startsWith(`${rel}.`) || f.startsWith(`${rel}:`))) continue;
      // per parent item: every member of a repeating parent needs its own required children
      const dot = row.id.lastIndexOf(".");
      const parentId = row.id.slice(0, dot);
      const last = row.id.slice(dot + 1).replace(/:.*$/, "").replace(/\[x\]$/, "");
      const parents = this.nodesOf(parentId).map((h) => h.node);
      if (!parents.length) {
        if (!this.nodesOf(row.id).length) {
          seen.add(rel);
          out.push({ field: rel, why: whyOf(row.required_by, row.condition) + this.derivedNote(row.id) });
        }
        continue;
      }
      const sliced = /:[^.]+$/.test(row.id);
      const members = sliced ? this.nodesOf(row.id) : [];
      const lacking = parents.filter((p) => {
        if (!isObject(p)) return false;
        if (sliced) return !members.some((m) => m.parent === p);
        return valuesAt(p, last).length === 0;
      });
      if (!lacking.length) continue;
      seen.add(rel);
      const where = parents.length > 1 ? ` (${lacking.length === parents.length ? "every" : `${lacking.length} of ${parents.length}`} ${parentId.replace(/^[^.]+\./, "")} item${parents.length > 1 ? "s" : ""})` : "";
      out.push({ field: rel, why: whyOf(row.required_by, row.condition) + where + this.derivedNote(row.id) });
    }
    return out;
  }

  /** For a derivable element the composer could not derive from the given values: say so, and what to give instead. */
  private derivedNote(id: string): string {
    const def = this.index.byId.get(id);
    const rule = def ? derivationRuleFor(def.path, def.binding) : null;
    if (!rule) return "";
    const clip = (t: string, n: number): string => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
    return `; not derivable from the values given (the MCP derives it only from other filled elements) — give the code: ${clip(rule.rule, 200)}`;
  }
}

function whyOf(requiredBy: string, condition?: string): string {
  let why: string;
  if (requiredBy.startsWith("profile")) why = `required by profile${requiredBy.includes("(") ? " " + requiredBy.slice(requiredBy.indexOf("(")) : ""}`;
  else if (requiredBy.startsWith("slice:")) why = `required by profile (${requiredBy.replace(/ \(.*$/, "")})`;
  else if (requiredBy.startsWith("invariant:")) why = `required by ${requiredBy}`;
  else if (requiredBy.startsWith("target-implied")) why = `expected: ${/\((.*)\)/.exec(requiredBy)?.[1] ?? "the entry is meaningless without it"}`;
  else if (requiredBy.startsWith("datatype:")) why = `required by ${requiredBy}`;
  else why = requiredBy;
  return condition ? `${why}; ${condition}` : why;
}

// --------------------------------------------------------------------------- //
// Entry point
// --------------------------------------------------------------------------- //

/**
 * Compose a profile-conformant resource from the model's field values. Throws
 * ComposeProfileError when the profile cannot be resolved; every other problem is reported in
 * `errors` / `missing` and the (partial) resource is still returned.
 */
export async function composeResource(input: AuthorInput, deps: ComposeDeps, ctx: ComposeContext): Promise<ComposeOutput> {
  if (!input || typeof input.profile !== "string" || !input.profile.trim()) throw new ComposeProfileError("INVALID_ARGUMENT", "profile is required");
  const fields = input.fields;
  if (!isObject(fields)) throw new ComposeProfileError("INVALID_ARGUMENT", "fields must be an object of field path → value");
  const resolved = await deps.resolveProfile(input.profile.trim());
  if (!resolved || !resolved.sd || !((resolved.sd.snapshot || {}).element || []).length) {
    throw new ComposeProfileError("ARTIFACT_NOT_FOUND", `profile not found (or has no snapshot): ${input.profile}`);
  }
  const c = new Composer(resolved.sd, deps, ctx, String(input.key ?? ""));
  await c.placeFields(fields);
  await c.wrapArrays();
  if (ensureMetaProfile(c.resource, resolved.canonical)) c.mark(`${c.rt}.meta.profile[0]`, "fixed");
  c.assignSlices();
  c.createDetermined();
  c.pinFixedPattern();
  await c.applyDefaults();
  await c.applyDerived();
  await c.checkDisplays();
  await c.lookupDisplays();
  const profileId = resolved.id || String(resolved.sd.id || resolved.canonical);
  const missing = c.missing(profileId);
  const pending = [...c.pending].sort();
  return {
    resource: c.resource,
    profile: { canonical: resolved.canonical, id: resolved.id ?? null, resourceType: c.rt },
    provenance: c.provenance,
    missing,
    refs: {
      resolved: [...c.resolved].sort(),
      pending,
      pendingUrns: pending.map((k) => keyToUrn(ctx.contextId, k)),
      pendingPaths: [...c.pendingPaths].sort(),
    },
    fieldMap: c.fieldMap,
    errors: c.errors,
    notes: c.notes,
  };
}
