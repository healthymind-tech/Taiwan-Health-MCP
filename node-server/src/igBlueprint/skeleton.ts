/**
 * `fhir_get_minimal_skeleton` (ISSUES_v16 R2): the minimal legal instance of a profile plus, for
 * EVERY required element, where its value comes from — so a model knows which "required" fields
 * are NOT clinical facts of the record and does not refuse because the record "lacks" them.
 *
 * Required set: fhirRequiredElements (min>=1 with every ancestor required, required slices,
 * value-or-dataAbsentReason invariants), profiled extensions expanded from their definitions
 * (url + value per ext-1, required sub-extensions, depth <= 3), plus conditional rows parsed from
 * profile invariants of the shape `<guard> implies (a.exists() and b.exists() …)`.
 *
 * value_source (all data-driven, IG-agnostic):
 *   ig-constant   fixed[x] / pattern[x] of the profile (also extension urls), or a value that is
 *                 IDENTICAL in every one of the IG's own example instances of the profile (>= 2
 *                 instances; never a value that varies) and is eligible:
 *                   - administrative entity resources (Organization, Location, HealthcareService,
 *                     Endpoint, OrganizationAffiliation — not persons): any element, when the IG
 *                     reuses the same entity in all its examples (e.g. the payer agency);
 *                   - any other resource: only workflow / derived codes (status-like elements with a
 *                     required or extensible binding, booleans) constant across >= 2 DISTINCT
 *                     instances — never source facts (dates, values, names, identifiers, gender)
 *                     and never the primary clinical codes;
 *   code-lookup   a coded element whose binding is required (or whose coding is required): small
 *                 bindings list their codes, large ones name the ValueSet to search;
 *   text-allowed  a CodeableConcept whose binding is not required and whose coding is optional —
 *                 {text} alone is legal (a code is still better when one fits);
 *   derivable     computable without a record fact: references (the target entry's fullUrl),
 *                 sequence / rank numbering, workflow defaults (fhirRequiredElements
 *                 WORKFLOW_DEFAULTS), curated derivation rules (DERIVATION_RULES), the system of a
 *                 bound unit, and workflow dates (the date a request / record was written — the
 *                 record's own date for it, else the visit / document date);
 *   record        everything else: a clinical / administrative fact the record must state.
 */

import { pinnedFragment } from "../fhirAuthoring.js";
import { projectElement } from "../fhirSnapshot.js";
import {
  classifyElement,
  derivationRuleFor,
  nodesAt,
  PRIMARY_CONTENT,
  profileFixesCode,
  projectForRequired,
  requiredElements,
  WORKFLOW_DEFAULTS,
  type ProfileInvariant,
  type ProjectedElement,
  type RequiredElementRow,
} from "../fhirRequiredElements.js";
import {
  BlueprintError,
  compactProvenance,
  choiceProperty,
  clip,
  isObject,
  measureResponse,
  RESPONSE_MARGIN,
  shortType,
  SKELETON_BUDGET,
  stripSlices,
  stripVersion,
  tail,
  type BlueprintDeps,
  type ExampleInstance,
  type LoadedProfile,
} from "./common.js";

export type ValueSource = "ig-constant" | "code-lookup" | "record" | "derivable" | "text-allowed";
export const VALUE_SOURCES: ValueSource[] = ["ig-constant", "code-lookup", "record", "derivable", "text-allowed"];

export interface SkeletonRequest {
  profile: string;
  package_id?: string | null;
  version?: string | null;
  envelope_provenance?: Record<string, unknown>;
}

export interface SkeletonResult {
  data: Record<string, unknown>;
  warnings: string[];
  provenance: Record<string, unknown>;
}

/** One table row (before serialisation). */
export interface SkeletonItem {
  id: string;
  path: string;
  source: ValueSource;
  how: string;
  /** Codes of a small binding ("code=display"), when listed. */
  codes?: Array<{ code: string; display: string | null; system: string | null }>;
  codesMore?: number;
  valueSet?: string;
  /** Pinned by the profile (grouped into one row on the wire). */
  pinned?: boolean;
  condition?: string;
  /** Value placed into the skeleton. */
  placeholder?: unknown;
  /** Example-derived constant: value + basis. */
  exampleBasis?: string;
}

/** Administrative entities (FHIR R4 "Entities"), not persons: their example instances may be IG-level constants. */
export const CONSTANT_ENTITY_TYPES = new Set(["Organization", "Location", "HealthcareService", "Endpoint", "OrganizationAffiliation"]);
/** Grounding classes whose coded value may be an example constant (workflow conventions, derived codes). */
const CONSTANT_CODE_CLASSES = new Set(["workflow_default", "derived"]);
/** Codes listed inline for a binding with at most this many codes. */
export const CODES_CAP = 12;
const EXPAND_LIMIT = 40;
const MAX_EXT_DEPTH = 3;

/**
 * Workflow dates (base FHIR paths): the date a request / record was written, not a clinical
 * fact of its own — derivable from the record's date for it, else the visit / document date.
 */
export const WORKFLOW_DATES = new Set([
  "Claim.created",
  "ClaimResponse.created",
  "ExplanationOfBenefit.created",
  "CoverageEligibilityRequest.created",
  "MedicationRequest.authoredOn",
  "ServiceRequest.authoredOn",
  "DeviceRequest.authoredOn",
  "Condition.recordedDate",
  "AllergyIntolerance.recordedDate",
  "Composition.date",
  "DocumentReference.date",
  "ClinicalImpression.date",
  "CarePlan.created",
  "Consent.dateTime",
  "DiagnosticReport.issued",
  "Observation.issued",
]);
/** Base-FHIR elements with a workflow value (path → [value, explanation]). */
export const WORKFLOW_VALUES: Record<string, [unknown, string]> = {
  "Claim.insurance.focal": [true, "true for the coverage the request is for"],
  "ExplanationOfBenefit.insurance.focal": [true, "true for the coverage the claim was adjudicated against"],
  "CoverageEligibilityRequest.insurance.focal": [true, "true for the coverage being checked"],
};
/** Extension definitions named like a recording date (name / id token), when their value is a date. */
const RECORDED_DATE_NAME = /(recorded|recording|authored|created|entered)[-_ ]?(date|time|on)|date[-_ ]?(recorded|entered)/i;

const PRIMARY_PATHS = new Set(Object.values(PRIMARY_CONTENT).flatMap((l) => l.map(([p]) => p)));

/** Strip one or more outer parentheses that wrap the whole expression. */
function stripParensExpr(s: string): string {
  let t = s.trim();
  while (t.startsWith("(") && t.endsWith(")")) {
    let depth = 0;
    let wraps = true;
    for (let i = 0; i < t.length; i++) {
      if (t[i] === "(") depth++;
      else if (t[i] === ")") depth--;
      if (depth === 0 && i < t.length - 1) {
        wraps = false;
        break;
      }
    }
    if (!wraps) break;
    t = t.slice(1, -1).trim();
  }
  return t;
}

function fixedOrPattern(el: { fixed?: { value: unknown } | null; pattern?: { value: unknown } | null } | undefined | null): unknown {
  if (!el) return undefined;
  if (el.fixed) return el.fixed.value;
  if (el.pattern) return el.pattern.value;
  return undefined;
}

function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (isObject(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

/** Example content without identity / narrative / reference spellings (distinct-instance key). */
function normalizedInstance(r: Record<string, unknown>): string {
  const walk = (v: unknown, key: string): unknown => {
    if (Array.isArray(v)) return v.map((x) => walk(x, key));
    if (isObject(v)) {
      const o: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) {
        if (key === "" && (k === "id" || k === "text" || k === "meta")) continue;
        if (k === "reference" && typeof x === "string") continue;
        o[k] = walk(x, k);
      }
      return o;
    }
    return v;
  };
  return stable(walk(r, ""));
}

/** Element id with choice type slices folded into the choice (`value[x]:valueQuantity.code` → `value[x].code`). */
export function choiceNorm(id: string): string {
  return id.replace(/\[x\]:[^.]+/g, "[x]");
}

function repeats(id: string, E: Map<string, ProjectedElement>): boolean {
  const own = E.get(id);
  const m = own?.baseMax ?? null;
  if (m !== null && m !== undefined) return m !== "1" && m !== "0";
  const last = id.split(".").pop() || "";
  if (last.includes(":") && !last.split(":")[0].endsWith("[x]")) return true;
  const base = E.get(stripSlices(id)) ?? own;
  const bm = base?.baseMax ?? base?.max ?? "1";
  return bm !== "1" && bm !== "0";
}

/** Allowed type codes of an element (type slices with max 0 removed). */
function allowedTypes(id: string, E: Map<string, ProjectedElement>): string[] {
  const el = E.get(id);
  const types = [...new Set((el?.types || []).map((t) => shortType(t.code)).filter(Boolean))];
  if (!id.endsWith("[x]")) return types;
  const forbidden = new Set<string>();
  for (const [k, s] of E) {
    if (!k.startsWith(`${id}:`) || k.slice(id.length + 1).includes(".")) continue;
    if (s.max === "0") for (const t of (s.types || []).map((x) => shortType(x.code))) forbidden.add(t);
  }
  return types.filter((t) => !forbidden.has(t));
}

/** JSON property name of one id segment (`value[x]` → `valueQuantity`, `value[x]:valueQuantity` → `valueQuantity`). */
function jsonKey(seg: string, idSoFar: string, E: Map<string, ProjectedElement>): string {
  const [name, slice] = seg.split(":");
  if (!name.endsWith("[x]")) return name;
  if (slice && /^[a-z]+[A-Z]/.test(slice) && slice.startsWith(name.slice(0, -3))) return slice;
  const baseId = slice ? idSoFar.slice(0, idSoFar.length - slice.length - 1) : idSoFar;
  const types = allowedTypes(slice ? idSoFar : baseId, E);
  const t = types[0] ?? allowedTypes(baseId, E)[0];
  return t ? choiceProperty(name, t) : name;
}

/** Display path relative to the resource: ids with `[x]` written as the JSON property when the type is decided. */
function displayPath(id: string, rt: string, E: Map<string, ProjectedElement>): string {
  const segs = id.split(".");
  const out: string[] = [];
  let so = segs[0];
  for (const seg of segs.slice(1)) {
    so = `${so}.${seg}`;
    const [name, slice] = seg.split(":");
    if (name.endsWith("[x]")) {
      const types = allowedTypes(slice ? so : so, E);
      const k = jsonKey(seg, so, E);
      out.push(types.length > 1 && !slice ? name : k);
    } else out.push(seg);
  }
  return out.join(".") || rt;
}

// --------------------------------------------------------------------------- //
// Extension expansion (definitions not expanded in the snapshot)              //
// --------------------------------------------------------------------------- //

interface ExpandCtx {
  deps: BlueprintDeps;
  loaded: LoadedProfile;
  cache: Map<string, Record<string, any> | null>;
  invariants: ProfileInvariant[];
  missing: string[];
}

async function fetchSd(ctx: ExpandCtx, url: string): Promise<Record<string, any> | null> {
  const key = stripVersion(url);
  if (!ctx.cache.has(key)) ctx.cache.set(key, await ctx.deps.fetchStructureDefinition(ctx.loaded, url).catch(() => null));
  return ctx.cache.get(key) ?? null;
}

async function expandExtensions(rows: RequiredElementRow[], E: Map<string, ProjectedElement>, ctx: ExpandCtx, depth: number): Promise<RequiredElementRow[]> {
  if (depth >= MAX_EXT_DEPTH) return rows;
  const out: RequiredElementRow[] = [];
  const ids = new Set(rows.map((r) => r.id));
  for (const r of rows) {
    out.push(r);
    const el = E.get(r.id);
    const t = el?.types?.length === 1 ? el.types[0] : null;
    const url = t && shortType(t.code) === "Extension" ? t.profile?.[0] : undefined;
    if (!url) continue;
    if ([...E.keys()].some((k) => k.startsWith(`${r.id}.value`) || k.startsWith(`${r.id}.extension:`))) continue; // expanded in place
    const ext = await fetchSd(ctx, url);
    if (!ext || ext.type !== "Extension" || !((ext.snapshot || {}).element || []).length) {
      ctx.missing.push(stripVersion(url));
      const id = `${r.id}.url`;
      if (!ids.has(id)) {
        ids.add(id);
        E.set(id, { id, path: `${r.path}.url`, min: 1, max: "1", types: [{ code: "uri" }], fixed: { field: "fixedUri", value: stripVersion(url) }, pattern: null, baseMax: "1" });
        out.push({ id, path: `${r.path}.url`, min: 1, max: "1", types: ["uri"], binding: null, fixed: { field: "fixedUri", value: stripVersion(url) }, pattern: null, mustSupport: false, required_by: "extension (definition not installed)", grounding_class: "auto" });
      }
      continue;
    }
    const xEls = projectForRequired(ext.snapshot.element, projectElement);
    const xE = new Map(xEls.map((e) => [e.id, e]));
    const sub = requiredElements(String(ext.id ?? tail(url)), xEls, { includeTargetImplied: false });
    const subRows = await expandExtensions(sub.elements, xE, ctx, depth + 1);
    for (const inv of sub.invariants) {
      if (!ctx.invariants.some((i) => i.key === inv.key && i.expression === inv.expression)) {
        ctx.invariants.push({ ...inv, on: inv.on.map((o) => `${r.id}${o.slice("Extension".length)}`) });
      }
    }
    for (const x of subRows) {
      const id = `${r.id}${x.id.slice("Extension".length)}`;
      if (ids.has(id)) continue;
      ids.add(id);
      const path = `${r.path}${x.path.slice("Extension".length)}`;
      const xe = xE.get(x.id);
      if (xe) E.set(id, { ...xe, id, path });
      out.push({ ...x, id, path, required_by: `extension:${tail(url)}` });
    }
    // the extension's own definition name (recording-date heuristic for its value)
    const vId = `${r.id}.value[x]`;
    const ve = E.get(vId);
    if (ve) (ve as ProjectedElement & { extName?: string }).extName = `${ext.name ?? ""} ${ext.id ?? ""} ${tail(url)}`;
  }
  return out;
}

// --------------------------------------------------------------------------- //
// Conditional rows from profile invariants                                     //
// --------------------------------------------------------------------------- //

interface ConditionalTerm {
  /** Element id the term resolves to (an existing snapshot id when one matches). */
  id: string;
  /** Invariant key (its text is listed once under `conditions`). */
  condition: string;
  text: string;
}

/** Terms of `<guard> implies (a.exists() and b.exists() …)`; null when the shape is not that. */
export function parseImpliesExists(expression: string): { guard: string; terms: string[] } | null {
  const expr = String(expression ?? "").replace(/\s+/g, " ").trim();
  const idx = expr.indexOf(" implies ");
  if (idx < 0) return null;
  const guard = stripParensExpr(expr.slice(0, idx));
  const body = stripParensExpr(expr.slice(idx + " implies ".length));
  if (/ or /.test(body)) return null;
  const terms: string[] = [];
  for (const part of body.split(" and ")) {
    const m = /^(.+)\.exists\(\)$/.exec(stripParensExpr(part));
    if (!m) return null;
    terms.push(m[1].trim());
  }
  return terms.length ? { guard, terms } : null;
}

function conditionalTerms(invs: ProfileInvariant[], rt: string, E: Map<string, ProjectedElement>, requiredIds: Set<string>): ConditionalTerm[] {
  const out: ConditionalTerm[] = [];
  for (const inv of invs) {
    const p = parseImpliesExists(inv.expression);
    if (!p) continue;
    for (const owner of inv.on) {
      // only on the root or a required element (an optional owner is a choice of the author)
      if (owner !== rt && !requiredIds.has(owner)) continue;
      for (const term of p.terms) {
        let id: string | null = null;
        const ext = /^extension\.where\(url ?= ?'([^']+)'\)(\.value(\.ofType\((\w+)\))?)?$/.exec(term);
        if (ext) {
          const url = ext[1];
          for (const [k, e] of E) {
            if (!k.startsWith(`${owner}.extension:`) || k.slice(owner.length + 11).includes(".")) continue;
            const prof = e.types?.[0]?.profile?.[0];
            if (prof && stripVersion(prof) === url) {
              id = ext[2] ? `${k}.value[x]` : k;
              break;
            }
          }
        } else if (/^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*)*$/.test(term)) {
          let cur = owner;
          for (const seg of term.split(".")) {
            cur = E.has(`${cur}.${seg}`) ? `${cur}.${seg}` : E.has(`${cur}.${seg}[x]`) ? `${cur}.${seg}[x]` : `${cur}.${seg}`;
          }
          id = cur;
        }
        if (!id || requiredIds.has(id)) continue;
        if (!out.some((o) => o.id === id)) out.push({ id, condition: inv.key, text: clip(inv.human || p.guard, 90) });
      }
    }
  }
  return out;
}

// --------------------------------------------------------------------------- //
// Classification                                                              //
// --------------------------------------------------------------------------- //

const CODED = new Set(["CodeableConcept", "Coding", "code"]);
/** Types whose value is one unit in the skeleton (children rows folded into it). */
const ATOMIC = new Set(["CodeableConcept", "Coding", "Reference", "code"]);

interface ClassifyCtx {
  rt: string;
  E: Map<string, ProjectedElement>;
  rowsById: Map<string, RequiredElementRow>;
  codeFixed: boolean;
  instances: ExampleInstance[];
  distinct: number;
  deps: BlueprintDeps;
  loaded: LoadedProfile;
  vsCache: Map<string, { codes: Array<{ code: string; display: string | null; system: string | null }>; total: number; truncated: boolean } | null>;
}

async function bindingCodes(ctx: ClassifyCtx, vs: string): Promise<{ codes: Array<{ code: string; display: string | null; system: string | null }>; total: number; truncated: boolean } | null> {
  const key = stripVersion(vs);
  if (!ctx.vsCache.has(key)) {
    let v: { codes: Array<{ code: string; display: string | null; system: string | null }>; total: number; truncated: boolean } | null = null;
    try {
      const exp = await ctx.deps.expandValueSet(ctx.loaded, key, EXPAND_LIMIT);
      if (exp) v = { codes: exp.codings.map((c) => ({ code: String(c.code), display: c.display ?? null, system: c.system ?? null })), total: exp.codings.length, truncated: exp.truncated };
    } catch {
      v = null;
    }
    ctx.vsCache.set(key, v);
  }
  return ctx.vsCache.get(key) ?? null;
}

/** Value at `id` identical in every example instance (>= 2), or undefined. */
function exampleConstant(ctx: ClassifyCtx, id: string): { value: unknown; n: number } | undefined {
  if (ctx.instances.length < 2) return undefined;
  let first: string | null = null;
  let value: unknown;
  for (const inst of ctx.instances) {
    const vals = nodesAt(inst.resource, id, ctx.E);
    if (!vals.length) return undefined;
    const s = stable(vals);
    if (first === null) {
      first = s;
      value = repeats(id, ctx.E) ? vals : vals[0];
    } else if (s !== first) return undefined;
  }
  return { value, n: ctx.instances.length };
}

function referenceTargets(el: ProjectedElement | undefined): string[] {
  return [...new Set((el?.types || []).flatMap((t) => (t.targetProfile || []).map((u) => tail(u))))];
}

function isWorkflowDate(ctx: ClassifyCtx, row: RequiredElementRow): boolean {
  const types = row.types.map(shortType);
  if (!types.some((t) => t === "date" || t === "dateTime" || t === "instant")) return false;
  if (WORKFLOW_DATES.has(stripSlices(row.path))) return true;
  const extName = (ctx.E.get(row.id) as (ProjectedElement & { extName?: string }) | undefined)?.extName;
  return Boolean(extName && RECORDED_DATE_NAME.test(extName));
}

function codesText(codes: Array<{ code: string; display: string | null; system: string | null }>, more: number, displayLen: number): string {
  const systems = new Set(codes.map((c) => c.system));
  const multi = systems.size > 1;
  const parts = codes.map((c) => {
    const code = multi && c.system ? `${tail(c.system)}|${c.code}` : c.code;
    return displayLen > 0 && c.display && c.display.toLowerCase() !== c.code.toLowerCase() ? `${code}=${clip(c.display, displayLen)}` : code;
  });
  return parts.join(" | ") + (more > 0 ? ` (+${more} more: fhir_expand_valueset)` : "");
}

async function classify(ctx: ClassifyCtx, row: RequiredElementRow, inheritedBinding: { strength?: string; valueSet?: string } | null): Promise<SkeletonItem> {
  const { rt, E } = ctx;
  const el = E.get(row.id);
  const types = row.types.length ? row.types.map(shortType) : allowedTypes(row.id, E);
  const path = displayPath(row.id, rt, E);
  const gp = stripSlices(row.path);
  const item: SkeletonItem = { id: row.id, path, source: "record", how: "" };
  const own = fixedOrPattern(row);
  if (own !== undefined || row.grounding_class === "auto") {
    item.source = "ig-constant";
    item.pinned = true;
    item.how = row.fixed ? "fixed by the profile" : "pattern by the profile";
    item.placeholder = clone(own);
    return item;
  }
  const binding = row.binding?.valueSet ? row.binding : inheritedBinding;
  const isRef = types.length === 1 && types[0] === "Reference";
  const coded = types.some((t) => CODED.has(t)) && !isRef;
  const cls = classifyElement(rt, el ?? { id: row.id, path: row.path, min: row.min, max: row.max }, ctx.codeFixed);

  // Example constants (>= 2 instances, identical values; eligibility per resource kind).
  if (!isRef) {
    const entity = CONSTANT_ENTITY_TYPES.has(rt);
    const strength = binding?.strength;
    const codeEligible =
      !entity &&
      ctx.distinct >= 2 &&
      !PRIMARY_PATHS.has(gp) &&
      ((coded && CONSTANT_CODE_CLASSES.has(cls) && (strength === "required" || strength === "extensible")) || (types.length === 1 && types[0] === "boolean" && cls !== "source_fact"));
    if (entity || codeEligible) {
      const c = exampleConstant(ctx, row.id);
      if (c !== undefined) {
        item.source = "ig-constant";
        item.placeholder = clone(c.value);
        item.exampleBasis = `identical in ${c.n}/${c.n} IG example instances (${ctx.distinct} distinct)`;
        item.how = entity
          ? `${item.exampleBasis}: the IG reuses this ${rt} in every example — copy it unless the record or site_config names a different ${rt.toLowerCase()}`
          : `${item.exampleBasis} — copy it unless the record says otherwise`;
        return item;
      }
    }
  }

  if (isRef) {
    const targets = referenceTargets(el);
    item.source = "derivable";
    item.how = `fullUrl of the ${targets.length ? targets.slice(0, 3).join(" | ") : "target"} entry`;
    item.placeholder = { reference: `<fullUrl of ${targets[0] ?? "target"}>` };
    return item;
  }
  const lastName = (row.id.split(".").pop() || "").split(":")[0];
  if ((lastName === "sequence" || lastName === "rank") && types.some((t) => t === "positiveInt" || t === "unsignedInt" || t === "integer")) {
    item.source = "derivable";
    item.how = "1, 2, 3 ... in order";
    item.placeholder = 1;
    return item;
  }
  if (isWorkflowDate(ctx, row)) {
    item.source = "derivable";
    item.how = "date written: the record's date for it, else the visit / document date";
    item.placeholder = "<date>";
    return item;
  }
  if (WORKFLOW_VALUES[gp]) {
    item.source = "derivable";
    item.how = WORKFLOW_VALUES[gp][1];
    item.placeholder = clone(WORKFLOW_VALUES[gp][0]);
    return item;
  }
  if (cls === "workflow_default" && WORKFLOW_DEFAULTS[gp]) {
    item.source = "derivable";
    const dv = WORKFLOW_DEFAULTS[gp][0];
    item.how = `workflow default ${JSON.stringify(dv)} unless the record says otherwise`;
    item.placeholder = clone(dv);
    if (typeof dv === "string" && (types.includes("CodeableConcept") || types.includes("Coding"))) {
      // a coded element: the default code with the system its binding gives it
      const b = binding?.valueSet ? await bindingCodes(ctx, binding.valueSet) : null;
      const sys = b?.codes.find((c) => c.code === dv)?.system ?? null;
      const coding = { system: sys ?? "<system>", code: dv };
      item.placeholder = types.includes("CodeableConcept") ? { coding: [coding] } : coding;
    }
    return item;
  }
  const rule = cls === "derived" ? derivationRuleFor(row.path, row.binding) : null;
  // Quantity.system of a bound Quantity: the system of the chosen unit code.
  const parent = row.id.slice(0, row.id.lastIndexOf("."));
  const parentTypes = (E.get(parent)?.types || []).map((t) => shortType(t.code));
  if (lastName === "system" && parentTypes.some((t) => /Quantity$|^Age$|^Duration$|^Count$|^Distance$/.test(t)) && inheritedBinding?.valueSet) {
    const b = await bindingCodes(ctx, inheritedBinding.valueSet);
    const systems = b && !b.truncated ? [...new Set(b.codes.map((c) => c.system).filter(Boolean))] : [];
    item.source = "derivable";
    item.how = `system of the unit code${systems.length === 1 ? ` (${systems[0]})` : ""}`;
    item.placeholder = systems.length === 1 ? systems[0] : "<system>";
    return item;
  }

  if (coded || rule) {
    const cc = types.includes("CodeableConcept");
    const ownId = choiceNorm(row.id);
    const below = [...ctx.rowsById.keys()].filter((k) => choiceNorm(k).startsWith(`${ownId}.coding`));
    const codingRequired = below.some((k) => !fixedOrPattern(ctx.rowsById.get(k)) && k.endsWith(".code"));
    const codingRowPresent = below.length > 0;
    const pinnedSystems = [...new Set(below.filter((k) => k.endsWith(".system")).map((k) => fixedOrPattern(ctx.rowsById.get(k))).filter((v): v is string => typeof v === "string"))];
    const strength = binding?.strength;
    let b: Awaited<ReturnType<typeof bindingCodes>> = null;
    if (binding?.valueSet) {
      item.valueSet = tail(binding.valueSet);
      b = await bindingCodes(ctx, binding.valueSet);
    }
    const small = b && !b.truncated && b.total > 0 && b.total <= CODES_CAP;
    if (small) item.codes = b!.codes;
    else if (b && b.total > CODES_CAP && !b.truncated && b.total <= 20) {
      item.codes = b.codes.slice(0, CODES_CAP);
      item.codesMore = b.total - CODES_CAP;
    }
    const binds = strength === "required" || strength === "extensible";
    // a preferred / example binding's codes are illustrations, not the list to pick from
    if (!binds) delete item.codes, delete item.codesMore;
    const vsSystem = b && !b.truncated && new Set(b.codes.map((c) => c.system)).size === 1 ? b.codes[0]?.system ?? null : null;
    const system = pinnedSystems.length === 1 ? pinnedSystems[0] : vsSystem;
    const lookup = !binding?.valueSet
      ? system
        ? `a code of ${system}: fhir_normalize_code(text, system)`
        : "no binding: a code of the system the record / IG uses"
      : item.codes
        ? `${strength ?? ""} ValueSet ${tail(binding.valueSet)}`
        : binds
          ? `${strength} ValueSet ${tail(binding.valueSet)}: fhir_normalize_code(text, system) / fhir_expand_valueset`
          : `a code${system ? ` of ${system}` : ""} (${strength ?? ""} ValueSet ${tail(binding.valueSet)} is only illustrative): fhir_normalize_code(text, system)`;
    const shape = (code: string): unknown => (cc ? { coding: [{ ...(system ? { system } : { system: "<system>" }), code }] } : types.includes("Coding") ? { ...(system ? { system } : { system: "<system>" }), code } : code);
    if (rule) {
      item.source = "derivable";
      item.how = `derive: ${clip(rule.rule, 140)}`;
      item.placeholder = shape("<code>");
      return item;
    }
    if (cc && strength !== "required" && !codingRequired && !codingRowPresent) {
      item.source = "text-allowed";
      item.how = `{text} alone is valid (${strength ?? "no"} binding${binding?.valueSet ? ` ${tail(binding.valueSet)}` : ""}); a coding only if a code fits`;
      item.placeholder = { text: "<text>" };
      return item;
    }
    item.source = "code-lookup";
    item.how = lookup.trim();
    item.placeholder = shape("<code>");
    return item;
  }

  // Record facts (incl. identifiers / facility namespaces).
  if (cls === "site") {
    item.how = "namespace URI of the issuing organisation (site config)";
    item.placeholder = "<system>";
    return item;
  }
  const t = types[0] ?? "value";
  item.how = types.length > 1 ? `choice: ${types.slice(0, 4).join(" | ")}` : t;
  item.placeholder = recordPlaceholder(types);
  return item;
}

function recordPlaceholder(types: string[]): unknown {
  const t = types[0];
  switch (t) {
    case "Identifier":
      return { system: "<system>", value: "<record>" };
    case "HumanName":
      return { text: "<record>" };
    case "Period":
      return { start: "<record>" };
    case "Quantity":
    case "SimpleQuantity":
    case "Age":
    case "Duration":
      return { value: "<record>", unit: "<unit>" };
    case "Annotation":
      return { text: "<record>" };
    case "Attachment":
      return { contentType: "<record>", data: "<record>" };
    case "ContactPoint":
      return { system: "<system>", value: "<record>" };
    case "Address":
      return { text: "<record>" };
    default:
      return "<record>";
  }
}

// --------------------------------------------------------------------------- //
// Skeleton JSON                                                               //
// --------------------------------------------------------------------------- //

function deepMerge(target: Record<string, any>, src: Record<string, any>): void {
  for (const [k, v] of Object.entries(src)) {
    if (isObject(v) && isObject(target[k])) deepMerge(target[k], v);
    else if (Array.isArray(v) && Array.isArray(target[k]) && v.length && isObject(v[0]) && isObject(target[k][0])) {
      v.forEach((x, i) => {
        if (isObject(x) && isObject(target[k][i])) deepMerge(target[k][i], x);
        else if (target[k][i] === undefined) target[k][i] = clone(x);
      });
    } else if (target[k] === undefined || typeof target[k] === "string") target[k] = clone(v);
  }
}

class SkeletonBuilder {
  readonly root: Record<string, any>;
  private sliceItems = new WeakMap<unknown[], Map<string, Record<string, any>>>();
  constructor(
    rt: string,
    canonical: string | null,
    private E: Map<string, ProjectedElement>,
  ) {
    this.root = { resourceType: rt };
    if (canonical) this.root.meta = { profile: [canonical] };
  }

  /** Place `value` (or an empty node when undefined) at element id `id`. */
  place(id: string, value: unknown): void {
    const segs = id.split(".");
    let node: Record<string, any> = this.root;
    let so = segs[0];
    for (let i = 1; i < segs.length; i++) {
      const seg = segs[i];
      so = `${so}.${seg}`;
      const last = i === segs.length - 1;
      const key = jsonKey(seg, so, this.E);
      const slice = seg.includes(":") && !seg.split(":")[0].endsWith("[x]") ? seg.split(":")[1] : "";
      const arr = repeats(so, this.E);
      if (arr) {
        if (!Array.isArray(node[key])) node[key] = node[key] === undefined ? [] : [node[key]];
        const list = node[key] as unknown[];
        let tags = this.sliceItems.get(list);
        if (!tags) this.sliceItems.set(list, (tags = new Map()));
        if (last && value !== undefined && !isObject(value)) {
          // primitive array item (meta.profile, given, line …)
          if (Array.isArray(value)) for (const v of value) list.includes(v) || list.push(v);
          else if (!list.includes(value)) list.push(value);
          return;
        }
        let item = tags.get(slice);
        if (!item && slice === "") {
          const taken = new Set(tags.values());
          const free = list.find((x) => isObject(x) && !taken.has(x as Record<string, any>)) as Record<string, any> | undefined;
          if (free) tags.set("", (item = free));
        }
        if (!item) {
          if (Array.isArray(value) && last) {
            // a repeating value given as a list (example constants)
            for (const v of value) list.push(clone(v));
            return;
          }
          item = {};
          list.push(item);
          tags.set(slice, item);
        }
        if (last && isObject(value)) deepMerge(item, value);
        node = item;
      } else {
        if (last) {
          if (value === undefined) {
            if (node[key] === undefined) node[key] = {};
          } else if (isObject(value) && isObject(node[key])) deepMerge(node[key], value);
          else if (node[key] === undefined || typeof node[key] === "string" || !isObject(value)) node[key] = clone(value);
          return;
        }
        if (!isObject(node[key])) node[key] = {};
        node = node[key];
      }
    }
  }
}

/** Sequence / rank placeholders of the items of one array: 1, 2, 3 … instead of all 1. */
function renumber(node: unknown, _ids: Set<string>): void {
  if (Array.isArray(node)) {
    const objs = node.filter(isObject);
    if (objs.length > 1) {
      for (const k of ["sequence", "rank"]) {
        if (objs.every((o) => o[k] === 1)) objs.forEach((o, i) => (o[k] = i + 1));
      }
    }
    node.forEach((x) => renumber(x, _ids));
  } else if (isObject(node)) for (const v of Object.values(node)) renumber(v, _ids);
}

// --------------------------------------------------------------------------- //
// Main                                                                        //
// --------------------------------------------------------------------------- //

const LEGEND =
  "copy `skeleton`, replace each <...>. table [path, value_source, how]: only `record` rows need the record; ig-constant (already filled), " +
  "code-lookup, text-allowed and derivable values are never a reason to refuse. `conditional` rows apply only when their condition holds.";

export async function minimalSkeleton(req: SkeletonRequest, deps: BlueprintDeps): Promise<SkeletonResult> {
  const ident = String(req.profile ?? "").trim();
  if (!ident) throw new BlueprintError("INVALID_ARGUMENT", "profile is required");
  const loaded = await deps.loadProfile(ident, req.package_id ?? null, req.version ?? null);
  const sd = loaded.sd;
  const snap: Array<Record<string, any>> = (sd?.snapshot || {}).element || [];
  if (!sd || sd.resourceType !== "StructureDefinition" || !snap.length) throw new BlueprintError("INVALID_ARGUMENT", `${ident} is not a StructureDefinition with a snapshot`);
  const rt = String(sd.type || snap[0].path.split(".")[0]);
  const els = projectForRequired(snap, projectElement);
  const E = new Map(els.map((e) => [e.id, e]));
  const base = requiredElements(loaded.profileId, els, { includeTargetImplied: false });
  const ectx: ExpandCtx = { deps, loaded, cache: new Map(), invariants: [...base.invariants], missing: [] };
  const rows = await expandExtensions(base.elements, E, ectx, 0);
  const rowsById = new Map(rows.map((r) => [r.id, r]));
  const requiredIds = new Set(rows.map((r) => r.id));
  const warnings = [...(loaded.warnings || [])];
  if (ectx.missing.length) warnings.push(`extension definition(s) not installed: ${[...new Set(ectx.missing)].slice(0, 4).join(", ")} — only their url is listed`);

  const canonical = loaded.canonical ?? (sd.url ? String(sd.url) : null);
  let instances: ExampleInstance[] = [];
  if (canonical) {
    try {
      instances = (await deps.exampleInstances(loaded, stripVersion(canonical))).filter((x) =>
        (((x.resource.meta as Record<string, unknown> | undefined)?.profile as unknown[]) || []).some((u) => stripVersion(String(u)) === stripVersion(canonical)),
      );
    } catch {
      instances = [];
    }
  }
  const distinct = new Set(instances.map((x) => normalizedInstance(x.resource))).size;
  const cctx: ClassifyCtx = { rt, E, rowsById, codeFixed: profileFixesCode(rt, els), instances, distinct, deps, loaded, vsCache: new Map() };

  // Rows that are not their own value: folded into an atomic ancestor, or the unsliced base of a sliced array.
  const atomicIds = new Set<string>();
  const builder = new SkeletonBuilder(rt, canonical, E);
  const items: SkeletonItem[] = [];
  const isSlicedBase = (id: string): boolean => {
    const segs = id.split(".");
    let so = segs[0];
    for (const seg of segs.slice(1)) {
      so = `${so}.${seg}`;
      if (seg.includes(":") || so.endsWith("[x]") || !repeats(so, E)) continue;
      if (rows.some((r) => r.id.startsWith(`${so}:`))) return true;
    }
    return false;
  };
  for (const row of rows) {
    if (row.id === `${rt}.meta.profile` || row.id === `${rt}.meta`) continue; // always in the skeleton (slice matching needs it)
    if (isSlicedBase(row.id)) continue;
    // a choice whose type slice is listed: the slice row carries it
    if (row.id.endsWith("[x]") && rows.some((r) => r.id.startsWith(`${row.id}:`))) continue;
    const anc = [...atomicIds].find((a) => choiceNorm(row.id).startsWith(`${choiceNorm(a)}.`));
    if (anc) {
      // pinned parts of an atomic value (coding.system, a coding slice's code …) go into the skeleton only
      const v = fixedOrPattern(row);
      if (v !== undefined) builder.place(row.id, clone(v));
      continue;
    }
    const types = row.types.length ? row.types.map(shortType) : allowedTypes(row.id, E);
    const hasChildRows = rows.some((r) => r.id.startsWith(`${row.id}.`));
    const atomic = types.length === 1 && ATOMIC.has(types[0]);
    const pinnedValue = fixedOrPattern(row);
    if (!atomic && hasChildRows && pinnedValue === undefined && row.grounding_class !== "auto") {
      builder.place(row.id, undefined); // container: its children carry the values
      continue;
    }
    if (atomic || pinnedValue !== undefined || row.grounding_class === "auto") atomicIds.add(row.id);
    // inherited binding: a bound Quantity / CodeableConcept parent (unit code, coding.code)
    const parent = row.id.slice(0, row.id.lastIndexOf("."));
    const pRow = rowsById.get(parent);
    const inherited = pRow?.binding?.valueSet ? pRow.binding : null;
    const item = await classify(cctx, row, inherited);
    if (row.grounding_class === "auto" && pinnedValue === undefined) {
      // pinned through its children: assemble them (placed as they come)
      item.placeholder = undefined;
    }
    // parts the profile pins below a value the author fills (Quantity unit system / code, identifier system …)
    const rowTypes = row.types.map(shortType);
    if (!item.pinned && isObject(item.placeholder) && !rowTypes.some((t) => CODED.has(t)) && item.source === "record") {
      const pins = pinnedFragment(row.id, E);
      if (pins && isObject(pins)) {
        deepMerge(item.placeholder as Record<string, any>, pins);
        const ph = item.placeholder as Record<string, any>;
        if (ph.unit === "<unit>" && typeof pins.code === "string") ph.unit = pins.code;
      }
    }
    items.push(item);
    builder.place(row.id, item.placeholder);
  }

  // Administrative entity reused in every IG example: its other shared top-level values (optional
  // elements such as identifier / name of a payer agency) are IG constants too.
  if (CONSTANT_ENTITY_TYPES.has(rt) && instances.length >= 2) {
    const first = instances[0].resource;
    const hasRef = (v: unknown): boolean => (Array.isArray(v) ? v.some(hasRef) : isObject(v) ? "reference" in v || Object.values(v).some(hasRef) : false);
    for (const [k, v] of Object.entries(first)) {
      if (["resourceType", "id", "meta", "text", "contained", "implicitRules", "language"].includes(k) || k in builder.root || hasRef(v)) continue;
      const elId = `${rt}.${k}`;
      if (E.get(elId)?.max === "0") continue;
      const key = stable(v);
      if (!instances.every((x) => stable(x.resource[k]) === key)) continue;
      builder.root[k] = clone(v);
      items.push({
        id: elId,
        path: k,
        source: "ig-constant",
        how: `optional; identical in ${instances.length}/${instances.length} IG example instances (${distinct} distinct): the IG's own ${rt} — keep it unless the record or site_config names another`,
        placeholder: v,
        exampleBasis: `identical in ${instances.length}/${instances.length} IG example instances (${distinct} distinct)`,
      });
    }
  }

  // Administrative entity reused in every IG example (the payer agency, …): its optional top-level
  // values that are identical in all instances are IG constants too (listed, and put in the skeleton).
  if (CONSTANT_ENTITY_TYPES.has(rt) && instances.length >= 2) {
    const listed = new Set(items.map((i) => i.id));
    for (const e of els) {
      const segs = e.id.split(".");
      if (segs.length !== 2 || e.max === "0" || listed.has(e.id) || requiredIds.has(e.id)) continue;
      if (["id", "meta", "text", "implicitRules", "language", "contained", "extension", "modifierExtension"].includes(segs[1])) continue;
      if ((e.types || []).some((t) => shortType(t.code) === "Reference")) continue;
      const c = exampleConstant(cctx, e.id);
      if (c === undefined) continue;
      const basis = `identical in ${c.n}/${c.n} IG example instances (${distinct} distinct)`;
      items.push({
        id: e.id,
        path: displayPath(e.id, rt, E),
        source: "ig-constant",
        how: `optional; ${basis}: the IG uses this ${rt} in every example — copy it unless the record or site_config names a different one`,
        placeholder: clone(c.value),
        exampleBasis: basis,
      });
      builder.place(e.id, clone(c.value));
    }
  }

  // Conditional rows (invariants: `<guard> implies (x.exists() and …)`).
  const conditional: SkeletonItem[] = [];
  const conditionText: Record<string, string> = {};
  for (const term of conditionalTerms(ectx.invariants, rt, E, requiredIds)) {
    conditionText[term.condition] = term.text;
    const valueOfExt = term.id.endsWith(".value[x]") && !E.has(term.id) ? term.id.slice(0, -".value[x]".length) : null;
    const el = E.get(valueOfExt ?? term.id);
    const pseudo: RequiredElementRow = {
      id: term.id,
      path: el?.path ?? stripSlices(term.id),
      min: 1,
      max: el?.max ?? "1",
      types: (el?.types || []).map((t) => String(t.code)),
      binding: el?.binding ?? null,
      fixed: el?.fixed ?? null,
      pattern: el?.pattern ?? null,
      mustSupport: Boolean(el?.mustSupport),
      required_by: "invariant",
      grounding_class: el ? classifyElement(rt, el, cctx.codeFixed) : "source_fact",
    };
    // an extension slice: classify its value from the definition
    let it: SkeletonItem;
    const prof = el?.types?.length === 1 && shortType(el.types[0].code) === "Extension" ? el.types[0].profile?.[0] : undefined;
    if (prof) {
      const ext = await fetchSd(ectx, prof);
      const v = ext ? ((ext.snapshot || {}).element || []).find((x: any) => x.id === "Extension.value[x]") : null;
      const vTypes = v ? (v.type || []).map((t: any) => String(t.code)) : [];
      const vid = valueOfExt ? term.id : `${term.id}.value[x]`;
      if (v && !E.has(vid)) E.set(vid, { ...(projectForRequired([v], projectElement)[0]), id: vid, path: `${pseudo.path}.value[x]`, baseMax: "1" });
      const ve = E.get(vid) as (ProjectedElement & { extName?: string }) | undefined;
      if (ve && ext) ve.extName = `${ext.name ?? ""} ${ext.id ?? ""} ${tail(prof)}`;
      it = await classify(cctx, { ...pseudo, id: vid, path: `${stripSlices(valueOfExt ?? term.id)}.value[x]`, types: vTypes, binding: ve?.binding ?? null, fixed: null, pattern: null, grounding_class: "source_fact" }, null);
      it.how = `extension ${tail(prof)}${ext ? "" : " (definition not installed)"}: ${it.how}`;
    } else it = await classify(cctx, pseudo, null);
    it.condition = term.condition;
    conditional.push(it);
  }

  const skeleton = builder.root;
  renumber(skeleton, new Set(items.filter((i) => i.placeholder === 1 && /(^|\.)(sequence|rank)$/.test(i.path)).map((i) => i.id)));
  const summary = Object.fromEntries(VALUE_SOURCES.map((s) => [s, items.filter((i) => i.source === s).length]));
  const rules = ectx.invariants.filter((i) => !parseImpliesExists(i.expression) || !conditional.length);
  const prov = compactProvenance({ ...(loaded.provenance || {}), ...(req.envelope_provenance || {}) });

  let withSkeleton = true as boolean;
  interface Level {
    pinnedList: boolean;
    displayLen: number;
    codesCap: number;
    rules: number;
    ruleLen: number;
    howLen: number;
    rows: number;
  }
  const build = (lv: Level): Record<string, unknown> => {
    const pinnedPaths = items.filter((i) => i.pinned).map((i) => i.path);
    const tableRows: Array<[string, ValueSource, string]> = [];
    if (pinnedPaths.length) {
      tableRows.push(
        lv.pinnedList
          ? [pinnedPaths.join(", "), "ig-constant", "fixed / pattern by the profile - already in skeleton, copy as is"]
          : [`${pinnedPaths.length} elements`, "ig-constant", "every non-<...> value in the skeleton: fixed / pattern, copy as is"],
      );
    }
    const rowOf = (i: SkeletonItem): [string, ValueSource, string] => {
      let how = clip(i.how, lv.howLen);
      if (i.codes && i.codes.length) {
        const shown = i.codes.slice(0, lv.codesCap);
        const more = i.codes.length - shown.length + (i.codesMore ?? 0);
        how = `${how}: ${codesText(shown, more, lv.displayLen)}`;
      }
      if (i.condition) how = `${how} (when rule ${i.condition} applies)`;
      return [i.path, i.source, how];
    };
    for (const i of items) if (!i.pinned) tableRows.push(rowOf(i));
    const shown = tableRows.slice(0, lv.rows);
    const data: Record<string, unknown> = {
      profile: { id: loaded.profileId, canonical, resourceType: rt },
      skeleton: withSkeleton ? skeleton : null,
      table_columns: ["path", "value_source", "how"],
      table: shown,
      summary,
    };
    if (conditional.length) {
      data.conditional = conditional.map(rowOf);
      data.conditions = Object.fromEntries(Object.entries(conditionText).map(([k, t]) => [k, clip(t, lv.ruleLen || 60)]));
    }
    if (lv.rules > 0 && rules.length) {
      data.rules = rules.slice(0, lv.rules).map((r) => `${r.key}: ${clip(r.human || r.expression, lv.ruleLen)}`);
      if (rules.length > lv.rules) data.more_rules = rules.slice(lv.rules).map((r) => r.key);
    } else if (rules.length) data.more_rules = rules.map((r) => r.key);
    data.examples = { instances: instances.length, distinct };
    data.legend = LEGEND;
    data.omitted = tableRows.length - shown.length;
    if ((loaded.depsMissing || []).length) data.deps_missing = loaded.depsMissing;
    return data;
  };
  const limit = SKELETON_BUDGET - RESPONSE_MARGIN;
  const levels: Level[] = [
    { pinnedList: true, displayLen: 24, codesCap: CODES_CAP, rules: 8, ruleLen: 140, howLen: 200, rows: Infinity },
    { pinnedList: true, displayLen: 14, codesCap: CODES_CAP, rules: 6, ruleLen: 100, howLen: 160, rows: Infinity },
    { pinnedList: false, displayLen: 14, codesCap: CODES_CAP, rules: 4, ruleLen: 90, howLen: 140, rows: Infinity },
    { pinnedList: false, displayLen: 10, codesCap: CODES_CAP, rules: 2, ruleLen: 80, howLen: 120, rows: Infinity },
    { pinnedList: false, displayLen: 8, codesCap: 10, rules: 0, ruleLen: 70, howLen: 100, rows: Infinity },
    { pinnedList: false, displayLen: 6, codesCap: 8, rules: 0, ruleLen: 60, howLen: 90, rows: Infinity },
    { pinnedList: false, displayLen: 0, codesCap: 8, rules: 0, ruleLen: 60, howLen: 80, rows: Infinity },
    { pinnedList: false, displayLen: 0, codesCap: 6, rules: 0, ruleLen: 50, howLen: 70, rows: Infinity },
  ];
  const total = items.filter((i) => !i.pinned).length + 1;
  for (let n = total - 1; n >= 1; n--) levels.push({ pinnedList: false, displayLen: 0, codesCap: 4, rules: 0, ruleLen: 0, howLen: 70, rows: n });
  let data = build(levels[0]);
  let fitted = false;
  for (const lv of levels) {
    data = build(lv);
    if (measureResponse(data, warnings, prov) <= limit) {
      fitted = true;
      break;
    }
  }
  if (!fitted) {
    // the skeleton alone exceeds the budget: send the table (never silently: skeleton_omitted)
    withSkeleton = false;
    for (const lv of levels) {
      data = build(lv);
      if (measureResponse({ ...data, skeleton_omitted: true }, warnings, prov) <= limit) break;
    }
    data.skeleton_omitted = "the skeleton exceeds the size budget: build it from `table` (every row is a required element)";
  }
  data.response_chars = measureResponse(data, warnings, prov);
  return { data, warnings, provenance: prov };
}

export const _internal = { normalizedInstance, displayPath, SkeletonBuilder };
