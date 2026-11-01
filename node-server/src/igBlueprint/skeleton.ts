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
 *                 instances; never a value that varies) and is eligible (1.6.0, ISSUES_v17.4: never
 *                 for identity resources — IDENTITY_TYPES — nor for name / telecom / address /
 *                 identifier / contact of any resource, which are `record`):
 *                   - a national payer / authority Organization profile (nationalOrgs.ts: type
 *                     pinned to govt / pay / ins, or the only target of the IG's payer / insurer
 *                     references — e.g. TWPAS Coverage.payor -> Organization-govt-twcore): any
 *                     element, when the IG reuses the same agency in all its examples;
 *                   - administrative entity resources that do not identify a site (HealthcareService,
 *                     Endpoint, OrganizationAffiliation): any non-identity element;
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
 *                 record's own date for it, else the visit / document date); and (ISSUES_v20 R5)
 *                 the record-derivable elements of recordDerivable.ts (Condition.verificationStatus
 *                 from the diagnosis field, Observation.interpretation from the value's flag /
 *                 reference range, MedicationRequest.category from the order's setting) — a record
 *                 fact the record determines without writing the code: `how` = "derive from the
 *                 record: <rule>; record cue: <cue>" and `derive` = {rule, cue}; checked like any
 *                 record fact by the content coverage (with source_text);
 *   record        everything else: a clinical / administrative fact the record must state.
 */

import { pinnedFragment } from "../fhirAuthoring.js";
import { elementsById, LITERAL_NOTE, placeholderLiterals, sliceRequirements, slicingOf, type Slicing } from "../fhirSliceMatch.js";
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
import { derivableCodes, derivableText, recordDerivableRule } from "../recordDerivable.js";
import { nationalOrganizationBasis } from "./nationalOrgs.js";
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
  /** (v17.2) Every ig-constant value of the profile (path + value), not on the wire: grounding exempts them (igValues.ts). */
  igConstants?: Array<{ path: string; value: unknown }>;
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
  /** Shorter how for the compact levels (shared by similar rows, which then merge into one). */
  compactHow?: string;
  /** RFC 6901 pointer (relative to the resource root) of the node holding the value (skeletonModel). */
  pointer?: string;
  /** FHIR type codes of the element (short names). */
  types?: string[];
  /** First code of a binding too large to list (an example of a legal code). */
  exampleCode?: { code: string; display: string | null; system: string | null };
  /** Conditional extension rows: the extension slice id + url (placed with the value). */
  extSlice?: { id: string; url: string };
  /** (ISSUES_v20 R5) A record-derivable element: the derivation rule and the record cue (recordDerivable.ts). */
  derive?: { rule: string; cue: string };
}

/** Administrative entities (FHIR R4 "Entities"), not persons: their example instances may be IG-level constants. */
export const CONSTANT_ENTITY_TYPES = new Set(["Organization", "Location", "HealthcareService", "Endpoint", "OrganizationAffiliation"]);
/**
 * (form v1.1) Resources that identify a person, a place or a site: with `strictExamples` NO value of
 * theirs is taken from the IG's example instances (an example clinic / patient / doctor is one of
 * many — copying it is fabrication). Only fixed / pattern values of the profiles stay prefilled; a
 * nationally unique organization is therefore one whose identity the profiles themselves pin.
 */
export const IDENTITY_TYPES = new Set(["Organization", "Location", "Practitioner", "PractitionerRole", "Patient", "RelatedPerson", "Person", "Group"]);
/** Identity / contact elements (any resource, any depth): never prefilled from examples under `strictExamples`. */
export const IDENTITY_ELEMENTS = new Set(["name", "telecom", "address", "identifier", "contact", "alias", "photo"]);
/** True when an example-derived value of `path` (element id / path, `Type.a.b`) of a resource of type `rt` may be prefilled. */
export function exampleValueAllowed(rt: string, path: string, strict: boolean): boolean {
  if (!strict) return true;
  if (IDENTITY_TYPES.has(rt)) return false;
  return !path
    .split(".")
    .slice(1)
    .some((seg) => IDENTITY_ELEMENTS.has(seg.split(":")[0]));
}
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

/**
 * The type a choice is written as in the skeleton: the coded type when one is allowed (the value
 * is then classified as a code / text, which is what the placeholder shape is), else the first.
 */
function preferredChoiceType(types: string[]): string | undefined {
  return types.find((t) => t === "CodeableConcept") ?? types.find((t) => t === "Coding") ?? types[0];
}

/** JSON property name of one id segment (`value[x]` → `valueQuantity`, `value[x]:valueQuantity` → `valueQuantity`). */
function jsonKey(seg: string, idSoFar: string, E: Map<string, ProjectedElement>): string {
  const [name, slice] = seg.split(":");
  if (!name.endsWith("[x]")) return name;
  if (slice && /^[a-z]+[A-Z]/.test(slice) && slice.startsWith(name.slice(0, -3))) return slice;
  const baseId = slice ? idSoFar.slice(0, idSoFar.length - slice.length - 1) : idSoFar;
  const types = allowedTypes(slice ? idSoFar : baseId, E);
  const t = preferredChoiceType(types) ?? preferredChoiceType(allowedTypes(baseId, E));
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

/** Top-level ` or ` operands of an expression (parentheses / quotes respected). */
function splitOr(expr: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = false;
  let start = 0;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (ch === "'") quote = !quote;
    if (quote) continue;
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (depth === 0 && expr.startsWith(" or ", i)) {
      out.push(expr.slice(start, i));
      start = i + 4;
      i += 3;
    }
  }
  out.push(expr.slice(start));
  return out.map((x) => stripParensExpr(x));
}

/**
 * `A or b.exists()` (b required unless A holds) / `a.exists() or b.exists()` (one of them): the
 * exists() operands as alternative terms (the caller places the first that resolves), or null.
 */
export function parseOrExists(expression: string): { guard: string; terms: string[]; others?: string[] } | null {
  const expr = String(expression ?? "").replace(/\s+/g, " ").trim();
  if (expr.includes(" implies ")) return null;
  const parts = splitOr(stripParensExpr(expr));
  if (parts.length < 2) return null;
  const terms: string[] = [];
  const others: string[] = [];
  for (const part of parts) {
    const m = /^([A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*)*)\.exists\(\)$/.exec(part);
    if (m) terms.push(m[1]);
    else others.push(part);
  }
  return terms.length ? { guard: others.length ? `unless ${others.join(" or ")}` : "one of them", terms, others } : null;
}

/** Error constraints of the base resource (not listed as profile invariants) on the root / required elements. */
function baseConditionalInvariants(els: ProjectedElement[], rt: string, requiredIds: Set<string>, known: ProfileInvariant[]): ProfileInvariant[] {
  const out: ProfileInvariant[] = [];
  for (const e of els) {
    if (e.id !== rt && !requiredIds.has(e.id)) continue;
    for (const c of (e as ProjectedElement & { constraints?: Array<{ key?: string; severity?: string; human?: string; expression?: string }> }).constraints || []) {
      if (!c.key || c.severity !== "error" || !c.expression) continue;
      if (known.some((k) => k.key === c.key) || out.some((k) => k.key === c.key)) continue;
      if (!parseImpliesExists(c.expression) && !parseOrExists(c.expression)) continue;
      out.push({ key: c.key, on: [e.id], human: c.human ?? "", expression: c.expression });
    }
  }
  return out;
}

function conditionalTerms(invs: ProfileInvariant[], rt: string, E: Map<string, ProjectedElement>, requiredIds: Set<string>, orShapes = false): ConditionalTerm[] {
  const out: ConditionalTerm[] = [];
  for (const inv of invs) {
    const implied = parseImpliesExists(inv.expression);
    const p = implied ?? (orShapes ? parseOrExists(inv.expression) : null);
    if (!p) continue;
    const oneOf = !implied;
    // `x.empty() or y.exists()` (y required when x is present): only when x is in the skeleton
    const emptyGuards = oneOf ? ((p as { others?: string[] }).others || []).map((o) => /^([A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*)*)\.empty\(\)$/.exec(o)?.[1]).filter((x): x is string => Boolean(x)) : [];
    if (oneOf && emptyGuards.length && !inv.on.some((owner) => emptyGuards.every((g) => requiredIds.has(`${owner}.${g}`) || requiredIds.has(`${owner}.${g}[x]`)))) continue;
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
        if (oneOf && id) {
          const el = E.get(id);
          if (!el || (el.types || []).every((t) => shortType(t.code) === "Reference")) continue; // prefer a value over a reference
          if (requiredIds.has(id)) break; // already satisfied by a required element
        }
        if (!id || requiredIds.has(id)) continue;
        if (!out.some((o) => o.id === id)) out.push({ id, condition: inv.key, text: clip(inv.human || p.guard, 90) });
        if (oneOf) break;
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
  /** SkeletonModelOptions.strictExamples (false for a national payer / authority organization). */
  strictExamples?: boolean;
  /** nationalOrgs.ts basis when the profile is a national payer / authority organization. */
  nationalBasis?: string | null;
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

  // ISSUES_v20 R5: record-derivable elements (before example constants and workflow defaults: the record
  // decides them — an IG that writes "confirmed" in every example does not make a hedged diagnosis confirmed)
  const rd = coded ? recordDerivableRule(gp) : null;
  if (rd) {
    const vs = binding?.valueSet ?? null;
    const b = vs ? await bindingCodes(ctx, vs) : null;
    const dc = derivableCodes(rd, vs, b && b.codes.length ? b.codes : null);
    if (dc) {
      const cc = types.includes("CodeableConcept");
      const first = [...dc.values()][0];
      item.source = "derivable";
      item.how = derivableText(rd, dc, 240);
      item.compactHow = `derive from the record (${rd.cue})`;
      item.derive = { rule: rd.rule, cue: rd.cue };
      if (vs) item.valueSet = tail(vs);
      if (b && !b.truncated && b.total > 0 && b.total <= CODES_CAP) item.codes = b.codes;
      const coding = { system: first.system ?? "<system>", code: "<code>" };
      item.placeholder = cc ? { coding: [coding] } : types.includes("Coding") ? coding : "<code>";
      return item;
    }
  }

  // Example constants (>= 2 instances, identical values; eligibility per resource kind).
  if (!isRef && exampleValueAllowed(rt, gp, Boolean(ctx.strictExamples))) {
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
        item.how = ctx.nationalBasis
          ? `${item.exampleBasis}: the IG's national payer / authority organization (${ctx.nationalBasis}) — copy it unless the record names a different one`
          : entity
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
    item.compactHow = "fullUrl of the target entry (named in the skeleton)";
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
    // a required coding slice bound on its own (slice by ValueSet): its binding decides the codes
    const sliceBinding =
      below
        .map((k) => ctx.rowsById.get(k))
        .find((r) => r && /\.coding:[^.]+$/.test(choiceNorm(r.id)) && r.binding?.valueSet && (r.binding.strength === "required" || r.binding.strength === "extensible"))?.binding ?? null;
    const bnd = sliceBinding ?? binding;
    const strength = bnd?.strength;
    let b: Awaited<ReturnType<typeof bindingCodes>> = null;
    if (bnd?.valueSet) {
      item.valueSet = tail(bnd.valueSet);
      b = await bindingCodes(ctx, bnd.valueSet);
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
    const vsSystem =
      b && b.codes.length && new Set(b.codes.map((c) => c.system)).size === 1 && (!b.truncated || sliceBinding) ? b.codes[0]?.system ?? null : null;
    if (b && b.codes.length && !item.codes) item.exampleCode = { system: b.codes[0].system, code: b.codes[0].code, display: b.codes[0].display };
    const system = pinnedSystems.length === 1 ? pinnedSystems[0] : vsSystem;
    // ISSUES_v16.1 R4: a coding slice with a required binding (a coding of that system must be in the ValueSet)
    const codingSlice = [...E.entries()].find(
      ([k, e]) => k.startsWith(`${row.id}.coding:`) && !k.slice(row.id.length + 8).includes(".") && e.max !== "0" && e.binding?.strength === "required" && !!e.binding.valueSet,
    );
    const lookup = !bnd?.valueSet
      ? system
        ? `a code of ${system}: fhir_normalize_code(text, system)`
        : "no binding: a code of the system the record / IG uses"
      : item.codes
        ? `${strength ?? ""} ValueSet ${tail(bnd.valueSet)}`
        : binds
          ? `${strength} ValueSet ${tail(bnd.valueSet)}: fhir_normalize_code(text, value_set=${stripVersion(bnd.valueSet)}) returns only its codes`
          : codingSlice
            ? `coding slice ${codingSlice[0].split(":").pop()}: required ValueSet; fhir_normalize_code(text, value_set=${stripVersion(codingSlice[1].binding!.valueSet!)})`
            : `a code${system ? ` of ${system}` : ""} (${strength ?? ""} ValueSet ${tail(bnd.valueSet)} is only illustrative): fhir_normalize_code(text, system)`;
    const shape = (code: string): unknown => (cc ? { coding: [{ ...(system ? { system } : { system: "<system>" }), code }] } : types.includes("Coding") ? { ...(system ? { system } : { system: "<system>" }), code } : code);
    if (rule) {
      item.source = "derivable";
      item.how = `derive: ${clip(rule.rule, 140)}`;
      item.placeholder = shape("<code>");
      return item;
    }
    if (cc && strength !== "required" && !codingRequired && !codingRowPresent) {
      item.source = "text-allowed";
      item.how = `{text} alone is valid (${strength ?? "no"} binding${bnd?.valueSet ? ` ${tail(bnd.valueSet)}` : ""}); a coding only if a code fits`;
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
    case "Narrative":
      return { status: "generated", div: "<record>" };
    default:
      return "<record>";
  }
}

// --------------------------------------------------------------------------- //
// Skeleton JSON                                                               //
// --------------------------------------------------------------------------- //

/** Every string leaf is a `<...>` placeholder (no value of its own yet). */
function onlyTokens(v: unknown): boolean {
  if (typeof v === "string") return /^<[^<>]*>$/.test(v);
  if (Array.isArray(v)) return v.every(onlyTokens);
  if (isObject(v)) return Object.values(v).every(onlyTokens);
  return false;
}

/**
 * `v` holds only placeholders, except (at `path`) `value` itself: an item a slice's pinned value
 * can complete without contradicting it.
 */
function tokensOr(v: unknown, path: string[], value: unknown): boolean {
  if (!path.length) return onlyTokens(v) || (value !== undefined && stable(v) === stable(value));
  if (Array.isArray(v)) return v.every((x) => tokensOr(x, path, value));
  if (isObject(v)) return Object.entries(v).every(([k, x]) => (k === path[0] ? tokensOr(x, path.slice(1), value) : onlyTokens(x)));
  return onlyTokens(v);
}

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

  /**
   * Place `value` (or an empty node when undefined) at element id `id`; returns the RFC 6901
   * pointer (relative to the resource root) of the node that holds it.
   */
  place(id: string, value: unknown): string {
    const segs = id.split(".");
    let node: Record<string, any> = this.root;
    let ptr = "";
    let so = segs[0];
    for (let i = 1; i < segs.length; i++) {
      const seg = segs[i];
      so = `${so}.${seg}`;
      const last = i === segs.length - 1;
      const key = jsonKey(seg, so, this.E);
      const slice = seg.includes(":") && !seg.split(":")[0].endsWith("[x]") ? seg.split(":")[1] : "";
      const arr = repeats(so, this.E);
      ptr = `${ptr}/${key}`;
      if (arr) {
        if (!Array.isArray(node[key])) node[key] = node[key] === undefined ? [] : [node[key]];
        const list = node[key] as unknown[];
        let tags = this.sliceItems.get(list);
        if (!tags) this.sliceItems.set(list, (tags = new Map()));
        if (last && value !== undefined && !isObject(value)) {
          // primitive array item (meta.profile, given, line …)
          if (Array.isArray(value)) {
            for (const v of value) list.includes(v) || list.push(v);
            return ptr;
          }
          if (!list.includes(value)) list.push(value);
          return `${ptr}/${list.indexOf(value)}`;
        }
        let item = tags.get(slice);
        if (!item && slice === "") {
          const taken = new Set(tags.values());
          const free = list.find((x) => isObject(x) && !taken.has(x as Record<string, any>)) as Record<string, any> | undefined;
          if (free) tags.set("", (item = free));
        }
        if (!item && slice !== "") {
          // the pinned parts of a slice complete an untagged placeholder item (a coded value's
          // `coding: [{system: <system>, code: <code>}]` + the slice's system) instead of a second item
          const taken = new Set([...tags.entries()].filter(([k]) => k !== "").map(([, v]) => v));
          const rest = segs.slice(i + 1).map((x) => x.split(":")[0]);
          const free = list.find((x) => isObject(x) && !taken.has(x as Record<string, any>) && tokensOr(x, rest, value)) as Record<string, any> | undefined;
          if (free) {
            for (const [k, v] of tags) if (v === free) tags.delete(k);
            tags.set(slice, (item = free));
          }
        }
        if (!item) {
          if (Array.isArray(value) && last) {
            // a repeating value given as a list (example constants)
            for (const v of value) list.push(clone(v));
            return ptr;
          }
          item = {};
          list.push(item);
          tags.set(slice, item);
        }
        if (last && isObject(value)) deepMerge(item, value);
        ptr = `${ptr}/${list.indexOf(item)}`;
        node = item;
      } else {
        if (last) {
          if (value === undefined) {
            if (node[key] === undefined) node[key] = {};
          } else if (isObject(value) && isObject(node[key])) deepMerge(node[key], value);
          else if (node[key] === undefined || typeof node[key] === "string" || !isObject(value)) node[key] = clone(value);
          return ptr;
        }
        if (!isObject(node[key])) node[key] = {};
        node = node[key];
      }
    }
    return ptr;
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
// Slicing in the skeleton (ISSUES_v16.1 R1 / R2)                              //
// --------------------------------------------------------------------------- //

/** One slice a sliced skeleton element may take. */
interface SliceOption {
  name: string;
  card: string;
  /** Discriminator → required value (fhirSliceMatch.sliceRequirements). */
  requires: Record<string, unknown>;
  /** Template item: the slice's fixed / pattern values plus <…> for what the author fills. */
  item: unknown;
  /** How to find the code of a slice told apart by a binding. */
  lookup?: string;
}

/** A sliced element of the skeleton: its slicing and every allowed slice. */
interface SliceGroup {
  id: string;
  path: string;
  rules: string;
  by: string[];
  options: SliceOption[];
  /** Ids of the slices listed as required rows (min >= 1). */
  required: string[];
}

const NO_FILL = new Set(["id", "extension", "modifierExtension"]);

/** Template of one slice: pinned values, then a <…> for each child the author fills (min >= 1 or mustSupport). */
function sliceTemplate(sliceId: string, E: Map<string, ProjectedElement>): unknown {
  const frag = pinnedFragment(sliceId, E);
  const types = (E.get(sliceId)?.types || []).map((t) => shortType(t.code));
  const item: Record<string, any> = isObject(frag) ? clone(frag) : {};
  if (!isObject(frag) && frag !== undefined) return clone(frag);
  for (const [id, el] of E) {
    if (!id.startsWith(`${sliceId}.`) || id.slice(sliceId.length + 1).includes(".")) continue;
    const seg = id.slice(sliceId.length + 1);
    if (NO_FILL.has(seg.split(":")[0]) || el.max === "0") continue;
    if (!((el.min ?? 0) >= 1 || el.mustSupport)) continue;
    const key = jsonKey(seg, id, E);
    if (item[key] !== undefined) continue;
    const ct = (el.types || []).map((t) => shortType(t.code));
    if (ct.includes("CodeableConcept")) item[key] = { coding: [{ system: "<system>", code: "<code>" }] };
    else if (ct.includes("Coding")) item[key] = { system: "<system>", code: "<code>" };
    else if (ct.includes("Reference")) item[key] = { reference: "<fullUrl of target>" };
    else if (seg === "system" && ct.includes("uri")) item[key] = "<system>";
    else item[key] = recordPlaceholder(ct);
    if (repeats(id, E) && !Array.isArray(item[key])) item[key] = [item[key]];
  }
  return Object.keys(item).length ? item : types.length === 1 ? recordPlaceholder(types) : {};
}

/**
 * (v17 R3) Slices told apart by a required binding (Condition.code.coding:icd10-cm-2023 — no fixed value): their
 * template is a Coding of the bound ValueSet's system with the code to look up, not a bare "<record>".
 */
async function bindSliceTemplates(groups: SliceGroup[], E: Map<string, ProjectedElement>, ctx: ClassifyCtx): Promise<void> {
  for (const g of groups) {
    for (const o of g.options) {
      const vs = Object.values(o.requires).find((v) => isObject(v) && typeof (v as Record<string, unknown>).valueSet === "string") as { valueSet: string } | undefined;
      if (!vs || (isObject(o.item) && Object.keys(o.item as object).some((k) => k !== "code" && k !== "system"))) continue;
      const sliceId = `${g.id}:${o.name}`;
      const types = (E.get(sliceId)?.types || E.get(g.id)?.types || []).map((t) => shortType(t.code));
      const b = await bindingCodes(ctx, vs.valueSet);
      const systems = b ? [...new Set(b.codes.map((c) => c.system).filter(Boolean))] : [];
      const coding = { system: systems.length === 1 ? systems[0] : "<system>", code: `<code from ${tail(vs.valueSet)}>` };
      o.item = types.includes("CodeableConcept") ? { coding: [coding] } : types.includes("Coding") || g.path.endsWith("coding") ? coding : `<code from ${tail(vs.valueSet)}>`;
      o.lookup = `fhir_normalize_code(text, value_set=${stripVersion(vs.valueSet)})`;
    }
  }
}

/**
 * Sliced elements of the skeleton (the element is required, or one of its slices is): CLOSED slicing
 * always (every item must match a slice), OPEN slicing when the IG makes one of its slices required.
 * Extension slicing by url only is the implicit one (left to the extension rows); Bundle.entry is
 * the blueprint's (fhir_get_bundle_blueprint).
 */
function sliceGroups(rt: string, sd: Record<string, any>, E: Map<string, ProjectedElement>, rows: RequiredElementRow[], requiredIds: Set<string>): SliceGroup[] {
  const raw = elementsById(sd);
  const out: SliceGroup[] = [];
  for (const [id, el] of E) {
    if (!el.slicing || el.max === "0") continue;
    if (rt === "Bundle" && id === "Bundle.entry") continue;
    // inside the skeleton: the element itself is required, or a slice of it is
    const sliceRows = rows.filter((r) => r.id.startsWith(`${id}:`) && !r.id.slice(id.length + 1).includes("."));
    if (!requiredIds.has(id) && !sliceRows.length) continue;
    const slicing: Slicing | null = slicingOf(raw, id);
    if (!slicing) continue;
    const closed = slicing.rules === "closed";
    if (!closed && !slicing.slices.some((x) => x.min >= 1)) continue;
    if (!closed && slicing.discriminators.every((d) => d.path === "url")) continue;
    const options: SliceOption[] = [];
    for (const sl of slicing.slices) {
      if (sl.max === "0") continue;
      options.push({ name: sl.name, card: `${sl.min}..${sl.max}`, requires: sliceRequirements(raw, slicing, sl), item: sliceTemplate(sl.id, E) });
    }
    if (!options.length) continue;
    out.push({
      id,
      path: displayPath(id, rt, E),
      rules: slicing.rules,
      by: slicing.discriminators.map((d) => (d.type === "value" || d.type === "pattern" ? d.path : `${d.type}:${d.path}`)),
      options,
      required: sliceRows.map((r) => r.id),
    });
  }
  return out;
}

/** Placeholder-like IG literals (`NNxxx`) of the pinned values and slice requirements, as notes. */
function literalNotes(items: SkeletonItem[], groups: SliceGroup[]): string[] {
  const notes: string[] = [];
  const add = (v: unknown, where: string): void => {
    for (const lit of placeholderLiterals(v)) {
      const n = `"${lit}" (${where}): ${LITERAL_NOTE}`;
      if (!notes.includes(n)) notes.push(n);
    }
  };
  for (const i of items) if (i.source === "ig-constant") add(i.placeholder, i.path);
  for (const g of groups) for (const o of g.options) add(o.requires, `${g.path}:${o.name}`);
  return notes;
}

// --------------------------------------------------------------------------- //
// Main                                                                        //
// --------------------------------------------------------------------------- //

const LEGEND =
  "copy `skeleton`, replace each <...>. table [path, value_source, how]: only `record` rows need the record; ig-constant (already filled), " +
  "code-lookup, text-allowed and derivable values are never a reason to refuse ('derive from the record' rows: take the value from the " +
  "record cue named). `conditional` rows apply only when their condition holds.";
const LEGEND_SLICES = " `slices`: every item of a sliced element matches one listed slice (copy its values).";
const LEGEND_LITERALS = " `literals`: IG values to copy verbatim even if they look like placeholders.";

export interface SkeletonModelOptions {
  /**
   * Element ids treated as required (min >= 1, with every ancestor) although the profile makes
   * them optional — e.g. an optional Composition section a planned entry belongs to.
   */
  forceRequired?: string[];
  /** A profile already loaded by the caller (skips deps.loadProfile). */
  loaded?: LoadedProfile;
  /**
   * A required element with CLOSED slicing and no required slice gets its first allowed slice
   * (an instance of the unsliced element matches no slice).
   */
  closedSlices?: boolean;
  /** Place the conditional rows into the skeleton too (with a pointer each). */
  placeConditional?: boolean;
  /**
   * (fhir_get_bundle_form v1.1; fhir_get_minimal_skeleton 1.6.0) Never take a value from the IG's
   * example instances for identity resources (IDENTITY_TYPES) or identity / contact elements
   * (IDENTITY_ELEMENTS) — only fixed / pattern values of the profiles (and, with
   * `nationalOrganizations`, the example identity of a national payer / authority organization).
   */
  strictExamples?: boolean;
  /**
   * (ISSUES_v17.4, fhir_get_minimal_skeleton) A national payer / authority Organization profile
   * (nationalOrgs.ts) is exempt from `strictExamples`: the IG's examples of it are the one agency.
   */
  nationalOrganizations?: boolean;
}

/** The skeleton before serialisation (shared by fhir_get_minimal_skeleton and fhir_get_bundle_form). */
export interface SkeletonModel {
  loaded: LoadedProfile;
  rt: string;
  canonical: string | null;
  skeleton: Record<string, any>;
  items: SkeletonItem[];
  conditional: SkeletonItem[];
  conditionText: Record<string, string>;
  invariants: ProfileInvariant[];
  instances: ExampleInstance[];
  distinct: number;
  E: Map<string, ProjectedElement>;
  warnings: string[];
  /** Sliced elements of the skeleton (ISSUES_v16.1 `slices`). */
  groups: SliceGroup[];
}

/** Snapshot with `ids` (and their ancestors) made min >= 1. */
function forceMin(snap: Array<Record<string, any>>, ids: string[]): Array<Record<string, any>> {
  if (!ids.length) return snap;
  const want = new Set<string>();
  for (const id of ids) {
    const segs = id.split(".");
    for (let i = 2; i <= segs.length; i++) want.add(segs.slice(0, i).join("."));
  }
  return snap.map((e) => (want.has(String(e.id)) && (e.min ?? 0) < 1 ? { ...e, min: 1 } : e));
}

/**
 * Element ids of the value / pattern discriminators of every slice with min >= 1 (all of its
 * ancestors too), when the discriminated element (or one below it) carries a fixed / pattern value.
 */
export function discriminatorElements(snap: Array<Record<string, any>>): string[] {
  const byId = new Map(snap.map((e) => [String(e.id), e]));
  const out: string[] = [];
  const required = (id: string): boolean => {
    const segs = id.split(".");
    for (let i = 2; i <= segs.length; i++) if ((byId.get(segs.slice(0, i).join("."))?.min ?? 0) < 1) return false;
    return true;
  };
  const pinned = (el: Record<string, any> | undefined): boolean => Boolean(el && Object.keys(el).some((k) => /^(fixed|pattern)[A-Z]/.test(k)));
  for (const e of snap) {
    const id = String(e.id || "");
    const last = id.split(".").pop() || "";
    if (!last.includes(":") || last.split(":")[0].endsWith("[x]") || !required(id)) continue;
    const base = byId.get(`${id.slice(0, id.lastIndexOf("."))}.${last.split(":")[0]}`);
    for (const d of (base?.slicing?.discriminator || []) as Array<{ type: string; path: string }>) {
      if ((d.type !== "value" && d.type !== "pattern") || !/^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*)*$/.test(String(d.path || ""))) continue;
      const target = `${id}.${d.path}`;
      if (required(target)) continue;
      if (pinned(byId.get(target)) || snap.some((x) => String(x.id || "").startsWith(`${target}.`) && pinned(x))) out.push(target);
      // a pin below the discriminated element (path code, pattern on code.coding.code): those too
      for (const x of snap) {
        const xid = String(x.id || "");
        if (xid.startsWith(`${target}.`) && pinned(x)) out.push(xid);
      }
    }
  }
  return [...new Set(out)];
}

/** First allowed slice of every required element whose slicing is CLOSED and has no required slice. */
export function closedSliceChoices(snap: Array<Record<string, any>>, pick: (sliceIds: string[]) => string = (ids) => ids[0]): string[] {
  const byId = new Map(snap.map((e) => [String(e.id), e]));
  const required = (id: string): boolean => {
    const segs = id.split(".");
    for (let i = 2; i <= segs.length; i++) if ((byId.get(segs.slice(0, i).join("."))?.min ?? 0) < 1) return false;
    return true;
  };
  const out: string[] = [];
  for (const e of snap) {
    const id = String(e.id || "");
    if (e.slicing?.rules !== "closed" || !id.includes(".") || id.endsWith("[x]") || !required(id)) continue;
    const slices = snap.filter((x) => {
      const xid = String(x.id || "");
      return xid.startsWith(`${id}:`) && !xid.slice(id.length + 1).includes(".") && x.max !== "0";
    });
    if (!slices.length || slices.some((x) => (x.min ?? 0) >= 1)) continue;
    out.push(pick(slices.map((x) => String(x.id))));
  }
  return out;
}

/**
 * Children of slices whose unsliced counterpart is required (`section:s.text` when
 * `section.text` is 1..1): an instance is checked against both, so they are required too.
 */
export function inheritedSliceMins(snap: Array<Record<string, any>>): string[] {
  const byId = new Map(snap.map((e) => [String(e.id), e]));
  const out: string[] = [];
  for (const e of snap) {
    const id = String(e.id || "");
    const segs = id.split(".");
    if (segs.length < 3 || (e.min ?? 0) >= 1 || e.max === "0") continue;
    const parentSliced = segs.slice(0, -1).some((x) => x.includes(":") && !x.split(":")[0].endsWith("[x]"));
    if (!parentSliced || segs[segs.length - 1].includes(":")) continue;
    const base = segs.map((x, i) => (i < segs.length - 1 && x.includes(":") && !x.split(":")[0].endsWith("[x]") ? x.split(":")[0] : x)).join(".");
    if ((byId.get(base)?.min ?? 0) >= 1) out.push(id);
  }
  return out;
}

/** `ids` made min >= 1 (not their ancestors: they apply only when the parent is present). */
function forceMinOwn(snap: Array<Record<string, any>>, ids: string[]): Array<Record<string, any>> {
  if (!ids.length) return snap;
  const want = new Set(ids);
  return snap.map((e) => (want.has(String(e.id)) && (e.min ?? 0) < 1 ? { ...e, min: 1 } : e));
}

export async function skeletonModel(req: SkeletonRequest, deps: BlueprintDeps, opts: SkeletonModelOptions = {}): Promise<SkeletonModel> {
  const ident = String(req.profile ?? "").trim();
  if (!ident && !opts.loaded) throw new BlueprintError("INVALID_ARGUMENT", "profile is required");
  const loaded = opts.loaded ?? (await deps.loadProfile(ident, req.package_id ?? null, req.version ?? null));
  const sd = loaded.sd;
  const snap0: Array<Record<string, any>> = (sd?.snapshot || {}).element || [];
  if (!sd || sd.resourceType !== "StructureDefinition" || !snap0.length) throw new BlueprintError("INVALID_ARGUMENT", `${ident} is not a StructureDefinition with a snapshot`);
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
  let snap = forceMin(snap0, opts.forceRequired ?? []);
  // closed-slice choice: the slice the IG's own examples use most (else the first)
  const examplePick = (cands: string[]): string => {
    if (instances.length === 0 || cands.length < 2) return cands[0];
    const pE = new Map(projectForRequired(snap, projectElement).map((e) => [e.id, e]));
    let best = cands[0];
    let bestN = 0;
    for (const c of cands) {
      const n = instances.filter((x) => nodesAt(x.resource, c, pE).length > 0).length;
      if (n > bestN) [best, bestN] = [c, n];
    }
    return best;
  };
  // the value / pattern discriminator elements of every required slice (optional in the profile,
  // but an instance without them matches no slice); twice for slices nested in required slices
  for (let i = 0; i < 2; i++) {
    if (opts.closedSlices) snap = forceMin(snap, closedSliceChoices(snap, examplePick));
    snap = forceMinOwn(snap, inheritedSliceMins(snap));
    snap = forceMin(snap, discriminatorElements(snap));
  }
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

  const distinct = new Set(instances.map((x) => normalizedInstance(x.resource))).size;
  const nationalBasis = opts.nationalOrganizations && rt === "Organization" ? await nationalOrganizationBasis(loaded, deps).catch(() => null) : null;
  const strict = Boolean(opts.strictExamples) && !nationalBasis;
  const cctx: ClassifyCtx = { rt, E, rowsById, codeFixed: profileFixesCode(rt, els), instances, distinct, deps, loaded, vsCache: new Map(), strictExamples: strict, nationalBasis };
  const groups = sliceGroups(rt, sd, E, rows, requiredIds);
  await bindSliceTemplates(groups, E, cctx);
  const groupById = new Map(groups.map((g) => [g.id, g]));

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
    const group = groupById.get(row.id);
    if (group && group.rules === "closed" && !group.required.length && !row.id.endsWith("[x]")) {
      // closed slicing and no required slice: a generic item matches no slice — template the first one
      // (not for a choice's type slices: the value is already written as one allowed type)
      const first = group.options[0];
      item.placeholder = clone(first.item);
      item.how = `closed slicing (by ${group.by.join(", ")}): every item must be one of slices.${group.path} — the skeleton holds '${first.name}'; another kind of ${tail(group.path)} takes that slice's item`;
    } else if (group && group.rules === "closed") {
      item.how = `${item.how}; closed slicing: every item must be one of slices.${group.path}`;
    }
    // (v17 R3) a closed slicing INSIDE this value (Condition.code → code.coding): the value's own template must use an
    // allowed slice (a coding of a max-0 slice's system matches nothing) — the first allowed slice's item
    for (const g of groups) {
      if (g.rules !== "closed" || g.required.length || !g.id.startsWith(`${row.id}.`) || !isObject(item.placeholder)) continue;
      const rel = g.id.slice(row.id.length + 1);
      if (rel.includes(".") || rel.includes(":")) continue;
      const first = g.options[0];
      (item.placeholder as Record<string, unknown>)[rel] = repeats(g.id, E) ? [clone(first.item)] : clone(first.item);
      item.how = `${first.lookup ? `slice ${first.name}: ${first.lookup}` : item.how}; ${rel}: closed slicing, one of slices.${g.path}`;
    }
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
    item.types = rowTypes.length ? rowTypes : allowedTypes(row.id, E);
    items.push(item);
    item.pointer = builder.place(row.id, item.placeholder);
  }

  // Administrative entity reused in every IG example: its other shared top-level values (optional
  // elements such as identifier / name of a payer agency) are IG constants too.
  if (CONSTANT_ENTITY_TYPES.has(rt) && instances.length >= 2) {
    const first = instances[0].resource;
    const hasRef = (v: unknown): boolean => (Array.isArray(v) ? v.some(hasRef) : isObject(v) ? "reference" in v || Object.values(v).some(hasRef) : false);
    for (const [k, v] of Object.entries(first)) {
      if (["resourceType", "id", "meta", "text", "contained", "implicitRules", "language"].includes(k) || k in builder.root || hasRef(v)) continue;
      const elId = `${rt}.${k}`;
      if (E.get(elId)?.max === "0" || !exampleValueAllowed(rt, elId, strict)) continue;
      const key = stable(v);
      if (!instances.every((x) => stable(x.resource[k]) === key)) continue;
      builder.root[k] = clone(v);
      items.push({
        pointer: `/${k}`,
        id: elId,
        path: k,
        source: "ig-constant",
        how: nationalBasis
          ? `optional; identical in ${instances.length}/${instances.length} IG example instances (${distinct} distinct): the IG's national payer / authority organization (${nationalBasis}) — keep it unless the record names another`
          : `optional; identical in ${instances.length}/${instances.length} IG example instances (${distinct} distinct): the IG's own ${rt} — keep it unless the record or site_config names another`,
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
      if ((e.types || []).some((t) => shortType(t.code) === "Reference") || !exampleValueAllowed(rt, e.id, strict)) continue;
      const c = exampleConstant(cctx, e.id);
      if (c === undefined) continue;
      const basis = `identical in ${c.n}/${c.n} IG example instances (${distinct} distinct)`;
      items.push({
        id: e.id,
        path: displayPath(e.id, rt, E),
        source: "ig-constant",
        how: nationalBasis
          ? `optional; ${basis}: the IG's national payer / authority organization (${nationalBasis}) — copy it unless the record names a different one`
          : `optional; ${basis}: the IG uses this ${rt} in every example — copy it unless the record or site_config names a different one`,
        placeholder: clone(c.value),
        exampleBasis: basis,
        pointer: builder.place(e.id, clone(c.value)),
      });
    }
  }

  // Conditional rows (invariants: `<guard> implies (x.exists() and …)`).
  const conditional: SkeletonItem[] = [];
  const conditionText: Record<string, string> = {};
  const condInvariants = opts.placeConditional ? [...ectx.invariants, ...baseConditionalInvariants(els, rt, requiredIds, ectx.invariants)] : ectx.invariants;
  for (const term of conditionalTerms(condInvariants, rt, E, requiredIds, Boolean(opts.placeConditional))) {
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
      it.extSlice = { id: valueOfExt ?? term.id, url: stripVersion(prof) };
    } else it = await classify(cctx, pseudo, null);
    it.condition = term.condition;
    conditional.push(it);
  }

  if (opts.placeConditional) {
    for (const it of conditional) {
      if (it.extSlice) builder.place(`${it.extSlice.id}.url`, it.extSlice.url);
      if (it.placeholder !== undefined) it.pointer = builder.place(it.id, it.placeholder);
      it.types = it.types ?? allowedTypes(it.id, E);
    }
  }
  for (const inv of condInvariants) if (!(inv.key in conditionText) && conditional.some((c) => c.condition === inv.key)) conditionText[inv.key] = clip(inv.human, 90);
  const skeleton = builder.root;
  renumber(skeleton, new Set(items.filter((i) => i.placeholder === 1 && /(^|\.)(sequence|rank)$/.test(i.path)).map((i) => i.id)));
  return { loaded, rt, canonical, skeleton, items, conditional, conditionText, invariants: ectx.invariants, instances, distinct, E, warnings, groups };
}

export async function minimalSkeleton(req: SkeletonRequest, deps: BlueprintDeps): Promise<SkeletonResult> {
  const { loaded, rt, canonical, skeleton, items, conditional, conditionText, invariants, instances, distinct, warnings, groups } = await skeletonModel(req, deps, { strictExamples: true, nationalOrganizations: true });
  const ectx = { invariants };
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
    /** Slice detail: 2 = template items, 1 = discriminator requirements, 0 = names only. */
    slices: number;
    /** List the keys of the rules not shown (`more_rules`). */
    moreRules?: boolean;
  }
  const literals = literalNotes(items, groups);
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
      let how = clip(!lv.pinnedList && i.compactHow ? i.compactHow : i.how, lv.howLen);
      if (i.codes && i.codes.length) {
        const shown = i.codes.slice(0, lv.codesCap);
        const more = i.codes.length - shown.length + (i.codesMore ?? 0);
        how = `${how}: ${codesText(shown, more, lv.displayLen)}`;
      }
      if (i.condition) how = `${how} (when rule ${i.condition} applies)`;
      return [i.path, i.source, how];
    };
    if (lv.pinnedList) {
      for (const i of items) if (!i.pinned) tableRows.push(rowOf(i));
    } else {
      // compact levels: rows with the same source and how share one row (paths joined)
      const merged = new Map<string, [string, ValueSource, string]>();
      for (const i of items) {
        if (i.pinned) continue;
        const r = rowOf(i);
        const k = `${r[1]}\u0000${r[2]}`;
        const m = merged.get(k);
        if (m) m[0] = `${m[0]}, ${r[0]}`;
        else merged.set(k, r);
      }
      tableRows.push(...merged.values());
    }
    const shown = tableRows.slice(0, lv.rows);
    const data: Record<string, unknown> = {
      profile: { id: loaded.profileId, canonical, resourceType: rt },
      skeleton: withSkeleton ? skeleton : null,
      table_columns: ["path", "value_source", "how"],
      table: shown,
      summary,
    };
    if (groups.length) {
      data.slices = Object.fromEntries(
        groups.map((g) => [
          g.path,
          {
            rules: g.rules,
            by: g.by,
            ...(lv.slices >= 2
              ? {
                  note:
                    g.rules === "closed"
                      ? `every ${tail(g.path)} must match one of these slices: copy its item exactly and replace <...> from the record`
                      : "the listed slices are the IG's; required ones are in the skeleton",
                }
              : {}),
            options:
              lv.slices >= 1
                ? g.options.map((o) => (lv.slices >= 2 ? [o.name, o.card, o.item, ...(o.lookup ? [o.lookup] : [])] : [o.name, o.card, o.requires]))
                : g.options.map((o) => (o.card.startsWith("0..") ? o.name : `${o.name} ${o.card}`)).join(", "),
          },
        ]),
      );
    }
    if (literals.length) data.literals = literals;
    if (conditional.length) {
      data.conditional = conditional.map(rowOf);
      data.conditions = Object.fromEntries(Object.entries(conditionText).map(([k, t]) => [k, clip(t, lv.ruleLen || 60)]));
    }
    if (lv.rules > 0 && rules.length) {
      data.rules = rules.slice(0, lv.rules).map((r) => `${r.key}: ${clip(r.human || r.expression, lv.ruleLen)}`);
      if (rules.length > lv.rules && lv.moreRules !== false) data.more_rules = rules.slice(lv.rules).map((r) => r.key);
    } else if (rules.length && lv.moreRules !== false) data.more_rules = rules.map((r) => r.key);
    data.examples = { instances: instances.length, distinct };
    data.legend = LEGEND + (groups.length && lv.slices > 0 ? LEGEND_SLICES : "") + (literals.length ? LEGEND_LITERALS : "");
    data.omitted = tableRows.length - shown.length;
    if ((loaded.depsMissing || []).length) data.deps_missing = loaded.depsMissing;
    return data;
  };
  const limit = SKELETON_BUDGET - RESPONSE_MARGIN;
  const levels: Level[] = [
    { pinnedList: true, displayLen: 24, codesCap: CODES_CAP, rules: 8, ruleLen: 140, howLen: 200, rows: Infinity, slices: 2 },
    { pinnedList: true, displayLen: 14, codesCap: CODES_CAP, rules: 6, ruleLen: 100, howLen: 160, rows: Infinity, slices: 2 },
    { pinnedList: false, displayLen: 14, codesCap: CODES_CAP, rules: 4, ruleLen: 90, howLen: 140, rows: Infinity, slices: 2 },
    { pinnedList: false, displayLen: 10, codesCap: CODES_CAP, rules: 2, ruleLen: 80, howLen: 120, rows: Infinity, slices: 2 },
    { pinnedList: false, displayLen: 8, codesCap: 10, rules: 0, ruleLen: 70, howLen: 100, rows: Infinity, slices: 2 },
    { pinnedList: false, displayLen: 8, codesCap: 10, rules: 0, ruleLen: 70, howLen: 100, rows: Infinity, slices: 1 },
    { pinnedList: false, displayLen: 8, codesCap: 8, rules: 0, ruleLen: 60, howLen: 90, rows: Infinity, slices: 1 },
    { pinnedList: false, displayLen: 8, codesCap: 8, rules: 0, ruleLen: 60, howLen: 80, rows: Infinity, slices: 1 },
    { pinnedList: false, displayLen: 8, codesCap: 6, rules: 0, ruleLen: 50, howLen: 70, rows: Infinity, slices: 1 },
    { pinnedList: false, displayLen: 8, codesCap: 6, rules: 0, ruleLen: 50, howLen: 70, rows: Infinity, slices: 0 },
    { pinnedList: false, displayLen: 8, codesCap: 6, rules: 0, ruleLen: 50, howLen: 70, rows: Infinity, slices: 0, moreRules: false },
  ];
  const total = items.filter((i) => !i.pinned).length + 1;
  for (let n = total - 1; n >= 1; n--) levels.push({ pinnedList: false, displayLen: 8, codesCap: 4, rules: 0, ruleLen: 0, howLen: 70, rows: n, slices: 0, moreRules: false });
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
  const igConstants = [...items, ...conditional].filter((i) => i.source === "ig-constant" && i.placeholder !== undefined).map((i) => ({ path: i.path, value: i.placeholder }));
  return { data, warnings, provenance: prov, igConstants };
}

export const _internal = { normalizedInstance, displayPath, SkeletonBuilder };
