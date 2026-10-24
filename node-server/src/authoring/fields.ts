/**
 * Authoring field list — workstream A of the authoring layer (see README.md).
 *
 * `authoringFields(profile, deps)` turns a profile's StructureDefinition snapshot into the
 * WRITING form an LLM fills with values (FieldSpec[], value grammar in README.md): which
 * elements to give, how (kind / format / example), where the value comes from (source) and
 * which ones the MCP fills by itself (auto: fixed / pattern / workflow default / curated
 * derivation). Three tiers keep the output within a size budget:
 *   - tier 1, fully described: required elements (fhirRequiredElements: min >= 1 chains,
 *     required slices, value-or-dataAbsentReason invariants), target-implied content, and
 *     elements "commonly expected" = present in >= 50% of the IG package's own examples of
 *     the profile (falling back to every example of the resource type when the package has
 *     fewer than 3 examples for the profile);
 *   - tier 1 also: record links (v1.2) — an optional backbone element with a required
 *     Reference child whose target profiles include a profile of the same IG (same canonical
 *     base) of a record resource type (not an actor / master-data entity, ENTITY_TYPES), e.g.
 *     Encounter.diagnosis {condition → Condition-twcore, use, rank}: such a backbone exists to
 *     link resources authored together, so it is listed with all its children and an example
 *     `{condition: {ref: key}}` even when the IG neither marks it mustSupport nor uses it in
 *     its examples;
 *   - tier 2, `more`: the remaining mustSupport elements as {field, kind}, plus the direct
 *     record links (an optional Reference element with such a target, e.g.
 *     Encounter.reasonReference) as {field, kind: "reference", targets};
 *   - everything else is not listed (optional and unsupported by the IG).
 * Nothing is truncated silently: fields dropped for the budget are counted in `omitted`. The
 * budget (SIZE_BUDGET) applies to the WHOLE tool response (envelope, warnings and provenance
 * included, non-ASCII counted as \uXXXX escapes) minus RESPONSE_MARGIN, as `response_chars`.
 *
 * IG-agnostic: everything is read from the snapshot, the package's ValueSets and examples;
 * the only curated tables are the generic ones of fhirRequiredElements (workflow defaults,
 * derivation rules), keyed on base FHIR paths. Pure apart from the injected `deps`.
 *
 * Field paths are the FHIR element ids relative to the resource (`identifier:mrn`,
 * `value[x]`, `component:SystolicBP`), so the compose engine can map them back to the
 * snapshot one-to-one.
 */

import { projectElement } from "../fhirSnapshot.js";
import { pinnedFragment } from "../fhirAuthoring.js";
import {
  classifyElement,
  derivationRuleFor,
  isProfileConstraint,
  nodesAt,
  parseOneOfInvariant,
  profileFixesCode,
  projectForRequired,
  requiredElements,
  WORKFLOW_DEFAULTS,
  type GroundingClass,
  type ProjectedElement,
  type RequiredElementRow,
} from "../fhirRequiredElements.js";
import type { FieldBindingCode, FieldKind, FieldSource, FieldSpec } from "./types.js";

// --------------------------------------------------------------------------- //
// Contract with the data layer (fieldsTool.ts provides the DB-backed deps)    //
// --------------------------------------------------------------------------- //

export interface LoadedProfile {
  /** The StructureDefinition (with snapshot). */
  sd: Record<string, any>;
  profileId: string;
  canonical: string | null;
  /** Package that owns the StructureDefinition (its examples are the statistics basis). */
  packageId: string;
  packageVersion: string;
  /** Opaque handle the deps pass back on later calls (e.g. the resolved package row + closure). */
  handle?: unknown;
  /** Envelope provenance of the resolution (resolved_by, closure_versions, ...). */
  provenance?: Record<string, unknown>;
  warnings?: string[];
  depsMissing?: unknown[];
}

export interface ExpandedCodes {
  codings: Array<{ system: string | null; code: string; display: string | null }>;
  truncated: boolean;
}

export interface FieldsDeps {
  /** Resolve + load the profile; throws AuthoringFieldsError (IG_NOT_FOUND / ARTIFACT_NOT_FOUND / INVALID_ARGUMENT). */
  loadProfile(profile: string, packageId: string | null, version: string | null): Promise<LoadedProfile>;
  /** Example resources (raw JSON) of the owning package whose resourceType is `resourceType`. */
  loadExamples(p: LoadedProfile, resourceType: string): Promise<Array<Record<string, unknown>>>;
  /** Expansion of a ValueSet canonical (|version stripped) within the profile's closure; null when not held. */
  expandValueSet(p: LoadedProfile, valueSet: string, limit: number): Promise<ExpandedCodes | null>;
  /** Resource type of each StructureDefinition canonical (reference targets); absent when unknown. */
  resourceTypes(p: LoadedProfile, canonicals: string[]): Promise<Map<string, string>>;
}

export class AuthoringFieldsError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "AuthoringFieldsError";
  }
}

export interface AuthoringFieldsRequest {
  profile: string;
  package_id?: string | null;
  version?: string | null;
  /** Default true: list the remaining mustSupport fields compactly under `more`. */
  include_more?: boolean;
  /** "full" (compose engine): every tier-1 and tier-2 field fully described, no size budget. */
  detail?: "budget" | "full";
  /** Provenance keys the tool envelope adds (tool, toolVersion) — measured into `response_chars`. */
  envelope_provenance?: Record<string, unknown>;
}

export interface AuthoringFieldsResult {
  profile: { id: string; canonical: string | null; resourceType: string; package_id: string; version: string };
  fields: FieldSpec[];
  /** Remaining mustSupport fields (absent when include_more=false; `more_count` still says how many). */
  more?: MoreField[];
  more_count: number;
  /** Fields dropped to meet the size budget (never silent). */
  omitted: number;
  examples: { basis: "profile" | "resource_type" | "none"; count: number };
  /** Characters of the JSON the tool returns in `data`. */
  size_chars: number;
  /**
   * Characters of the whole tool response (`{ok, data, warnings, provenance}`, the text the MCP
   * client receives), counting every non-ASCII character as its 6-character \uXXXX escape — the
   * measure the size budget applies to (SIZE_BUDGET - RESPONSE_MARGIN).
   */
  response_chars: number;
  warnings: string[];
  provenance?: Record<string, unknown>;
  deps_missing?: unknown[];
}

/** `more` entry: a field listed compactly (record links carry their reference targets). */
export interface MoreField {
  field: string;
  kind: FieldKind;
  targets?: string[];
}

/** Size budget (characters of the whole serialised tool response) for the default (tiered) output. */
export const SIZE_BUDGET = 6000;
/**
 * Head-room kept under SIZE_BUDGET for what a client adds when it measures the response
 * (its own re-serialisation, a different provenance resolution): the tiers are trimmed until
 * response_chars <= SIZE_BUDGET - RESPONSE_MARGIN.
 */
export const RESPONSE_MARGIN = 150;
/** Children listed for a record-link backbone (all of them, up to this many). */
const LINK_CHILDREN = 6;
/**
 * Actor / master-data resource types (FHIR R4 Administration — Individuals and Entities):
 * references to them are who / where, not resources of the record authored together.
 */
const ENTITY_TYPES = new Set([
  "Patient", "Practitioner", "PractitionerRole", "RelatedPerson", "Person", "Group", "Organization", "OrganizationAffiliation",
  "HealthcareService", "Endpoint", "Location", "Substance", "BiologicallyDerivedProduct", "Device", "DeviceMetric",
]);
/** A binding's codes are listed inline only when its expansion has at most this many codes. */
export const SMALL_BINDING = 20;
/** An element is "commonly expected" when present in at least this share of the examples. */
export const COMMON_PERCENT = 50;
/** Fewer profile examples than this → statistics over every example of the resource type. */
export const MIN_PROFILE_EXAMPLES = 3;

// --------------------------------------------------------------------------- //
// Helpers                                                                     //
// --------------------------------------------------------------------------- //

const KIND_BY_TYPE: Record<string, FieldKind> = {
  string: "string", uri: "string", url: "string", canonical: "string", markdown: "string", id: "string", oid: "string",
  uuid: "string", base64Binary: "string", time: "string", xhtml: "string", String: "string",
  code: "code", Coding: "coding", CodeableConcept: "codeableConcept",
  Quantity: "quantity", SimpleQuantity: "quantity", Age: "quantity", Duration: "quantity", Count: "quantity", Distance: "quantity", Money: "quantity", MoneyQuantity: "quantity",
  date: "date", dateTime: "dateTime", instant: "dateTime",
  Period: "period", Identifier: "identifier", Reference: "reference", boolean: "boolean",
  integer: "integer", positiveInt: "integer", unsignedInt: "integer", integer64: "integer", decimal: "decimal",
  Dosage: "dosage", Annotation: "annotation", HumanName: "humanName",
};

/** Value grammar hints for datatypes without a FieldKind of their own. */
const OTHER_GRAMMAR: Record<string, string> = {
  ContactPoint: "{system: phone | email | fax | url | sms | other, value, use?}",
  Address: "{text} or {line[], city, district?, postalCode?, country?}",
  Attachment: "{contentType, url | data, title?}",
  Range: "{low: {value, unit}, high: {value, unit}}",
  Ratio: "{numerator: {value, unit}, denominator: {value, unit}}",
  Timing: "frequency text (e.g. 'TID', 'q8h') or {code | repeat}",
  ContactDetail: "{name?, telecom[]}",
  Money: "{value, currency}",
  Coding: "{system, code, display?}",
};

const SKIP_TOP = new Set(["id", "meta", "implicitRules", "language", "text", "contained", "extension", "modifierExtension"]);
const SKIP_CHILD = new Set(["id", "extension", "modifierExtension"]);
/** Reference targets that are facility master data rather than record content. */
const FACILITY_TARGETS = new Set(["Organization", "Location"]);

function shortType(code: string): string {
  const parts = String(code).split(".");
  return parts[parts.length - 1].split("/").pop() || "";
}

function stripSlices(id: string): string {
  return id.replace(/:[^.]+/g, "");
}

function lastSeg(id: string): string {
  return id.split(".").pop() || "";
}

function sliceNameOf(id: string): string | null {
  const m = /:([^.]+)$/.exec(id);
  return m ? m[1] : null;
}

function tail(url: string): string {
  return String(url).split("|")[0].replace(/\/+$/, "").split("/").pop() || String(url);
}

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function isArrayElement(el: ProjectedElement | undefined): boolean {
  if (!el) return false;
  const m = el.baseMax ?? el.max;
  return m !== null && m !== undefined && m !== "1" && m !== "0";
}

/** Allowed type codes of an element; type slices with max 0 remove their type from a choice. */
function allowedTypes(el: ProjectedElement, E: Map<string, ProjectedElement>): string[] {
  const types = [...new Set((el.types || []).map((t) => shortType(t.code)).filter(Boolean))];
  if (!lastSeg(el.id).endsWith("[x]")) return types;
  const forbidden = new Set<string>();
  for (const [id, s] of E) {
    if (!id.startsWith(`${el.id}:`) || id.slice(el.id.length + 1).includes(".")) continue;
    if (s.max === "0") for (const t of (s.types || []).map((x) => shortType(x.code))) forbidden.add(t);
  }
  return types.filter((t) => !forbidden.has(t));
}

function kindOfType(t: string): FieldKind {
  return KIND_BY_TYPE[t] ?? "other";
}

function kindOf(rt: string, el: ProjectedElement, types: string[]): FieldKind {
  if (types.length === 1 && types[0] === "BackboneElement") {
    return rt === "Observation" && stripSlices(el.path || el.id) === "Observation.component" ? "component" : "other";
  }
  if (!types.length) return "other";
  return kindOfType(types[0]);
}

function fixedOrPattern(el: ProjectedElement | undefined): unknown {
  if (!el) return undefined;
  if (el.fixed) return el.fixed.value;
  if (el.pattern) return el.pattern.value;
  return undefined;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

/** `{system, code}` pairs a pinned fragment carries as codings (Quantity system/code pairs excluded). */
function pinnedCodes(pins: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown, key: string): void => {
    if (Array.isArray(v)) v.forEach((x) => walk(x, key));
    else if (isPlainObject(v)) {
      const quantity = /quantity$/i.test(key) || "unit" in v || "value" in v;
      if (!quantity && typeof v.code === "string" && !("coding" in v)) out.push(typeof v.system === "string" ? `${tail(v.system)}|${v.code}` : String(v.code));
      for (const [k, x] of Object.entries(v)) if (k !== "code" && k !== "system") walk(x, k);
    }
  };
  walk(pins, "");
  return out;
}

/** Short description of a slice's discriminator and the values that select it. */
function sliceDescription(sliceId: string, E: Map<string, ProjectedElement>): string | null {
  const name = sliceNameOf(sliceId);
  if (!name) return null;
  const baseId = sliceId.slice(0, sliceId.length - name.length - 1);
  const base = E.get(baseId);
  const slice = E.get(sliceId);
  const extUrl = slice?.types?.find((t) => shortType(t.code) === "Extension")?.profile?.[0];
  if (extUrl) return `extension ${String(extUrl).split("|")[0]} (value per its definition)`;
  const discs = base?.slicing?.discriminator || [];
  const parts: string[] = [];
  for (const d of discs) {
    const p = String(d.path || "$this");
    if (d.type === "type") {
      parts.push(p === "$this" ? "by type" : `${p} by type`);
      continue;
    }
    if (d.type === "value" || d.type === "pattern") {
      const direct = p === "$this" ? slice : E.get(`${sliceId}.${p}`);
      let exp = fixedOrPattern(direct);
      if (exp === undefined && p !== "$this") {
        // the discriminator path runs through a nested slice (code.coding.code -> code.coding:X.code)
        const want = `${sliceId}.${p}`;
        for (const [id, e] of E) {
          if (!id.startsWith(`${sliceId}.`) || stripSlices(id) !== stripSlices(want) || id === want) continue;
          const v = fixedOrPattern(e);
          if (v !== undefined) { exp = v; break; }
        }
      }
      if (exp !== undefined) {
        const s = isPlainObject(exp) ? pinnedCodes(exp).join(",") || JSON.stringify(exp) : typeof exp === "string" ? (/^https?:/.test(exp) ? tail(exp) : exp) : JSON.stringify(exp);
        parts.push(`${p === "$this" ? "value" : p}=${clip(s, 60)}`);
      } else if (direct?.binding?.valueSet) {
        parts.push(`${p === "$this" ? "code" : p} in ValueSet ${tail(String(direct.binding.valueSet))}`);
      } else parts.push(`${p} (see profile)`);
      continue;
    }
    if (d.type === "profile") parts.push(`${p} by profile`);
    else if (d.type === "exists") parts.push(`${p} exists`);
  }
  return parts.length ? `slice ${name}: ${parts.join(", ")}` : `slice ${name}`;
}

/** Profile-defined error invariants on an element (value-or-dataAbsentReason ones are rows already). */
function ruleTexts(el: ProjectedElement | undefined): string[] {
  const out: string[] = [];
  for (const c of el?.constraints || []) {
    if (!c.key || (c.severity && c.severity !== "error") || !isProfileConstraint(c)) continue;
    const inv = parseOneOfInvariant(c.expression);
    if (inv && inv.terms.includes("dataAbsentReason")) continue;
    const text = c.human || c.expression || "";
    if (text) out.push(`rule ${c.key}: ${clip(text, 90)}`);
  }
  return out.slice(0, 2);
}

// --------------------------------------------------------------------------- //
// Field building                                                              //
// --------------------------------------------------------------------------- //

interface Candidate {
  id: string;
  el: ProjectedElement;
  spec: FieldSpec;
  required: boolean;
  expected: boolean; // target-implied primary content
  mustSupport: boolean;
  common: number | null; // percentage when known
  binding: { strength: string; valueSet: string } | null;
  /** List the binding's codes (small expansions) — not for pinned / default fields. */
  listCodes: boolean;
  targetCanonicals: string[];
  children?: Candidate[];
  /** Every child of a top-level backbone (record links list them all). */
  allChildren?: Candidate[];
  /** Record link (v1.2): "backbone" = tier 1 with all children, "reference" = tier 2 with targets. */
  link?: { kind: "backbone" | "reference"; child: string | null; targets: string[] };
}

interface BuildCtx {
  rt: string;
  E: Map<string, ProjectedElement>;
  rows: Map<string, RequiredElementRow>;
  codeFixed: boolean;
  deps: FieldsDeps;
  loaded: LoadedProfile;
  examples: Array<Record<string, unknown>>;
}

function rowReason(row: RequiredElementRow | undefined): { required: boolean; expected: boolean; why: string | null } {
  if (!row || row.optional) return { required: false, expected: false, why: null };
  const by = row.required_by;
  const head = by.split(" ")[0];
  if (head === "profile") return { required: true, expected: false, why: "required by profile" };
  if (head.startsWith("slice:")) return { required: true, expected: false, why: "required slice" };
  if (head.startsWith("invariant:")) {
    const key = head.slice("invariant:".length);
    const m = /\(([^)]*)\)/.exec(by);
    const what = m ? clip(m[1].replace(/; dataAbsentReason satisfies.*$/, ""), 60) : "";
    return { required: true, expected: false, why: `invariant ${key}${what ? ` (${what})` : ""}${row.condition ? `, ${row.condition}` : ""}` };
  }
  if (head.startsWith("target-implied")) {
    const m = /^target-implied \((.*)\)$/.exec(by);
    return { required: false, expected: true, why: `expected: ${m ? clip(m[1], 80) : "the entry is meaningless without it"}` };
  }
  return { required: true, expected: false, why: `required (${head})` };
}

function presencePercent(ctx: BuildCtx, id: string): number | null {
  if (!ctx.examples.length) return null;
  let n = 0;
  for (const ex of ctx.examples) if (nodesAt(ex, id, ctx.E).length) n++;
  return Math.round((100 * n) / ctx.examples.length);
}

/** Build one field (and, for backbone / dosage / humanName fields, its shallow children). */
function buildCandidate(ctx: BuildCtx, el: ProjectedElement, depth: number): Candidate | null {
  const { rt, E } = ctx;
  const id = el.id;
  const types = allowedTypes(el, E);
  if (lastSeg(id).endsWith("[x]") && !types.length) return null; // every choice type forbidden
  const kind = kindOf(rt, el, types);
  const slice = sliceNameOf(id);
  const row = ctx.rows.get(id);
  const reason = rowReason(row);
  const cls: GroundingClass = row?.grounding_class ?? classifyElement(rt, el, ctx.codeFixed);
  const gp = stripSlices(el.path || id);
  const pins = pinnedFragment(id, E);
  const ownPin = fixedOrPattern(el);
  const multiple = slice ? el.max !== "1" && el.max !== "0" : isArrayElement(el);

  // Fully pinned: the element's own value is fixed, or every required leaf under it is pinned
  // (a leaf = a required row with no required row below it; containers and slice roots whose
  // children carry the pins are not leaves).
  const below = [...ctx.rows.values()].filter((r) => r.id.startsWith(`${id}.`) && !r.optional && !r.required_by.startsWith("target-implied"));
  const reqLeaves = below.filter((r) => r.grounding_class !== "container" && !below.some((o) => o.id.startsWith(`${r.id}.`) || o.id.startsWith(`${r.id}:`)));
  const fullyPinned =
    ownPin !== undefined && !isPlainObject(ownPin)
      ? true
      : reqLeaves.length
        ? reqLeaves.every((r) => r.fixed || r.pattern)
        : Boolean(ownPin) && (kind === "codeableConcept" || kind === "coding" || kind === "code" || kind === "identifier");

  const format: string[] = [];
  let source: FieldSource = "record";
  let auto: true | undefined;
  let value: unknown;
  let example: unknown;

  if (slice) {
    const d = sliceDescription(id, E);
    if (d) format.push(d);
  }
  if (types.length > 1) format.push(`choice: ${[...new Set(types.map((t) => (kindOfType(t) === "other" ? t : kindOfType(t))))].join(" | ")}`);

  const dflt = WORKFLOW_DEFAULTS[gp];
  const rule = cls === "derived" ? derivationRuleFor(el.path || id, el.binding) : null;
  const unitCode = isPlainObject(pins) && typeof pins.code === "string" && typeof pins.system === "string" ? String(pins.code) : null;
  if (fullyPinned || cls === "auto") {
    source = "fixed";
    auto = true;
    value = ownPin !== undefined && !isPlainObject(ownPin) ? ownPin : pins;
    format.push("pinned by the profile (MCP fills it)");
  } else if (dflt && !ownPin && reason.required) {
    // workflow defaults apply only to elements the profile requires (fhir_author_resources apply_defaults)
    source = "default";
    auto = true;
    value = dflt[0];
    format.push(`default ${JSON.stringify(dflt[0])} (MCP fills it unless the record says otherwise)`);
  } else if (rule) {
    source = "derived";
    auto = true;
    format.push(`MCP derives it: ${clip(rule.rule, 160)}`);
  } else if (kind === "reference") {
    source = "record"; // refined to facility once the target types are known
  } else if (kind === "identifier") {
    source = "record";
    format.push(pins?.system ? "give {value}" : "give {value}; system = facility namespace unless the record gives one");
  } else if (cls === "coding" || ((kind === "code" || kind === "coding" || kind === "codeableConcept") && el.binding?.valueSet)) {
    source = "code";
  } else if (cls === "site") {
    source = "facility";
  } else if (cls === "derived") {
    source = "code";
    format.push("pick the code that fits the record");
  } else {
    source = "record";
  }

  // Kind-specific grammar hints (the tool description carries the general grammar).
  switch (kind) {
    case "quantity":
      if (unitCode) format.push(`unit ${unitCode} (UCUM, MCP sets system/code)`);
      if (source !== "fixed") example = { value: 12.5, unit: unitCode ?? "<unit>" };
      break;
    case "date":
      format.push("YYYY-MM-DD or ROC YYY/MM/DD");
      break;
    case "dateTime":
      format.push("ISO or ROC date-time, precision as recorded");
      break;
    case "period":
      format.push("{start, end?}");
      break;
    case "humanName":
      format.push("{text} or {family, given[]}");
      break;
    case "annotation":
      format.push("{text} or string");
      break;
    case "dosage":
      format.push("{text?, route?, dose?, frequency?, period?, asNeeded?}");
      break;
    case "other": {
      const g = types.length === 1 ? OTHER_GRAMMAR[types[0]] : undefined;
      if (g) format.push(g);
      break;
    }
    case "component": {
      if (slice) {
        const vq = isPlainObject(pins?.valueQuantity) ? (pins!.valueQuantity as Record<string, unknown>) : null;
        const vEl = E.get(`${id}.value[x]`);
        const vTypes = vEl ? allowedTypes(vEl, E) : [];
        const vk = vTypes.length ? kindOfType(vTypes[0]) : "quantity";
        const unit = vq && typeof vq.code === "string" ? String(vq.code) : null;
        format.push(`one component (code pinned); give {value} as ${vk}${vTypes.length > 1 ? ` (or ${[...new Set(vTypes.slice(1, 4).map(kindOfType))].join(" | ")})` : ""}${unit ? `, unit ${unit}` : ""}`);
        if (vk === "quantity") example = { value: { value: 12.5, unit: unit ?? "<unit>" } };
      } else format.push("[{code, value}] per component");
      break;
    }
    default:
      break;
  }
  if ((kind === "codeableConcept" || kind === "coding") && source !== "fixed") {
    // coding slices under the field (one per code system) — named, not listed as fields
    const names: string[] = [];
    for (const [cid, ce] of E) {
      if (!cid.startsWith(`${id}.coding:`) || cid.slice(id.length + 8).includes(".") || ce.max === "0") continue;
      names.push(sliceNameOf(cid)!);
    }
    if (names.length) format.push(`coding slices by system: ${names.slice(0, 8).join(" | ")}${names.length > 8 ? ` (+${names.length - 8})` : ""}`);
  }
  if (dflt && !ownPin && !auto) {
    // optional element with a conventional value: a hint only — the MCP never fills an optional default
    format.push(`optional; conventional value ${JSON.stringify(dflt[0])} — give it only when the record states it (not auto-filled)`);
    if (example === undefined) example = dflt[0];
  }
  if (depth === 0) format.push(...ruleTexts(el));

  const binding = el.binding?.valueSet && source !== "fixed" ? { strength: String(el.binding.strength ?? ""), valueSet: String(el.binding.valueSet).split("|")[0] } : null;
  const targetCanonicals = kind === "reference" ? [...new Set((el.types || []).flatMap((t) => t.targetProfile || []).map((u) => String(u).split("|")[0]))] : [];

  const spec: FieldSpec = { field: id.slice(rt.length + 1), required: reason.required, kind, multiple, source };
  if (auto) spec.auto = true;
  if (value !== undefined) spec.value = value;
  if (pins && !auto) spec.pins = pins;
  if (format.length) spec.format = format.join("; ");
  if (example !== undefined) spec.example = example;

  const cand: Candidate = {
    id, el, spec,
    required: reason.required,
    expected: reason.expected,
    mustSupport: Boolean(el.mustSupport),
    common: null,
    binding,
    listCodes: Boolean(binding) && source !== "default" && (kind === "code" || kind === "coding" || kind === "codeableConcept") && (depth === 0 || reason.required),
    targetCanonicals,
  };
  const whyParts: string[] = [];
  if (reason.why) whyParts.push(reason.why);
  const pct = presencePercent(ctx, id);
  cand.common = pct;
  if (pct !== null && pct >= COMMON_PERCENT && !reason.required) whyParts.push(`in ${pct}% of IG examples`);
  else if (!reason.why && cand.mustSupport) whyParts.push("mustSupport");
  if (whyParts.length) spec.why = whyParts.join("; ");

  // Shallow children for backbone / dosage / humanName fields.
  if (depth === 0 && (types[0] === "BackboneElement" || kind === "dosage" || kind === "humanName")) {
    const kids: Candidate[] = [];
    const all: Candidate[] = [];
    for (const ce of E.values()) {
      if (!ce.id.startsWith(`${id}.`) || ce.max === "0") continue;
      const rel = ce.id.slice(id.length + 1);
      if (rel.includes(".")) continue;
      const name = rel.split(":")[0];
      if (SKIP_CHILD.has(name) || (name.endsWith("[x]") && rel.includes(":"))) continue;
      const kc = buildCandidate(ctx, ce, depth + 1);
      if (!kc) continue;
      // Pinned children are already in the parent's `pins` / `value`.
      if (kc.spec.auto && (pins || auto)) continue;
      all.push(kc);
      if (kc.required || kc.expected || kc.mustSupport || Boolean(fixedOrPattern(ce)) || (kc.common !== null && kc.common >= COMMON_PERCENT)) {
        if (pins) delete kc.spec.pins;
        kids.push(kc);
      }
    }
    if (kids.length) {
      cand.children = kids;
      spec.children = kids.map((k) => k.spec);
    }
    if (types[0] === "BackboneElement") cand.allChildren = all;
  }
  return cand;
}

/** Canonical base of a profile URL (`https://x/ig/y` of `https://x/ig/y/StructureDefinition/z`), or null. */
function canonicalBase(url: string | null | undefined): string | null {
  if (!url) return null;
  const u = String(url).split("|")[0];
  const i = u.lastIndexOf("/StructureDefinition/");
  return i > 0 ? u.slice(0, i) : null;
}

function referenceTargets(el: ProjectedElement): string[] {
  return [...new Set((el.types || []).filter((t) => shortType(t.code) === "Reference").flatMap((t) => t.targetProfile || []).map((u) => String(u).split("|")[0]))];
}

/**
 * Record links (v1.2, see the header): optional top-level elements not otherwise listed that link
 * the resource to another resource of the record — a Reference (or a backbone whose required
 * Reference child is one) whose target profiles include a profile of the same IG (same canonical
 * base as the profile) of a non-entity resource type. Data-driven: snapshot + target types only.
 */
async function markRecordLinks(ctx: BuildCtx, cands: Candidate[], listed: (c: Candidate) => boolean): Promise<void> {
  const base = canonicalBase(ctx.loaded.canonical);
  if (!base) return;
  interface Probe { c: Candidate; kind: "backbone" | "reference"; child: string | null; canonicals: string[] }
  const probes: Probe[] = [];
  for (const c of cands) {
    if (c.required || c.expected || c.spec.auto || listed(c) || sliceNameOf(c.id)) continue;
    if (c.spec.kind === "reference") {
      probes.push({ c, kind: "reference", child: null, canonicals: referenceTargets(c.el) });
      continue;
    }
    if (!c.allChildren) continue;
    for (const k of c.allChildren) {
      if (k.spec.kind !== "reference" || (k.el.min ?? 0) < 1) continue;
      probes.push({ c, kind: "backbone", child: lastSeg(k.id), canonicals: referenceTargets(k.el) });
      break;
    }
  }
  const own = [...new Set(probes.flatMap((p) => p.canonicals).filter((u) => canonicalBase(u) === base))];
  if (!own.length) return;
  let types = new Map<string, string>();
  try {
    types = await ctx.deps.resourceTypes(ctx.loaded, own);
  } catch {
    return;
  }
  for (const p of probes) {
    const targets = [...new Set(p.canonicals.filter((u) => canonicalBase(u) === base).map((u) => types.get(u)).filter((t): t is string => !!t && !ENTITY_TYPES.has(t)))];
    if (!targets.length) continue;
    p.c.link = { kind: p.kind, child: p.child, targets };
    if (p.kind === "backbone") {
      const kids = (p.c.allChildren || []).slice(0, LINK_CHILDREN);
      p.c.children = kids;
      p.c.spec.children = kids.map((k) => k.spec);
      const key = targets[0].charAt(0).toLowerCase() + targets[0].slice(1);
      p.c.spec.example = { [p.child!]: { ref: key } };
      p.c.spec.why = `links to ${targets.join(" / ")} of this IG (record link)`;
      p.c.spec.format = [p.c.spec.format, `give ${p.child} as {ref: '<key of that resource in the context>'}`].filter(Boolean).join("; ");
    }
  }
}

async function attachBindings(ctx: BuildCtx, cands: Candidate[]): Promise<void> {
  const cache = new Map<string, ExpandedCodes | null>();
  const all = cands.flatMap((c) => [c, ...(c.children || [])]);
  for (const c of all) {
    if (!c.binding) continue;
    const b: FieldSpec["binding"] = { strength: c.binding.strength, valueSet: c.binding.valueSet };
    c.spec.binding = b;
    if (!c.listCodes) continue;
    let exp = cache.get(c.binding.valueSet);
    if (exp === undefined) {
      try {
        exp = await ctx.deps.expandValueSet(ctx.loaded, c.binding.valueSet, SMALL_BINDING + 1);
      } catch {
        exp = null;
      }
      cache.set(c.binding.valueSet, exp);
    }
    if (exp && !exp.truncated && exp.codings.length > 0 && exp.codings.length <= SMALL_BINDING) {
      const systems = new Set(exp.codings.map((x) => x.system).filter(Boolean));
      const single = systems.size === 1 ? ([...systems][0] as string) : null;
      b.codes = exp.codings.map((x) => {
        const code: FieldBindingCode = { code: x.code };
        if (x.display && x.display.toLowerCase() !== x.code.toLowerCase()) code.display = clip(x.display, 40);
        if (!single && x.system) code.system = x.system;
        return code;
      });
      if (single && c.spec.kind !== "code") c.spec.format = [c.spec.format, `system ${single}`].filter(Boolean).join("; ");
    } else {
      const n = exp && exp.codings.length ? (exp.truncated ? `more than ${SMALL_BINDING}` : String(exp.codings.length)) : "many";
      const hint = `${c.binding.strength} binding, ${n} codes: pick with fhir_normalize_code(text, value_set) or fhir_expand_valueset`;
      c.spec.format = [c.spec.format, hint].filter(Boolean).join("; ");
    }
  }
}

async function attachTargets(ctx: BuildCtx, cands: Candidate[]): Promise<void> {
  const all = cands.flatMap((c) => [c, ...(c.children || [])]).filter((c) => c.spec.kind === "reference");
  if (!all.length) return;
  const canonicals = [...new Set(all.flatMap((c) => c.targetCanonicals))];
  let types = new Map<string, string>();
  try {
    if (canonicals.length) types = await ctx.deps.resourceTypes(ctx.loaded, canonicals);
  } catch {
    types = new Map();
  }
  for (const c of all) {
    const targets = [...new Set(c.targetCanonicals.map((u) => types.get(u) ?? tail(u)))];
    if (targets.length) c.spec.targets = targets;
    if (c.spec.source === "record" && targets.length && targets.every((t) => FACILITY_TARGETS.has(t))) c.spec.source = "facility";
    const key = targets[0] ? targets[0].charAt(0).toLowerCase() + targets[0].slice(1) : "key";
    c.spec.example = { ref: key };
    const profs = c.targetCanonicals.map(tail).filter((p) => !targets.includes(p));
    if (profs.length) c.spec.format = [c.spec.format, `profile ${profs.slice(0, 3).join(" | ")}`].filter(Boolean).join("; ");
  }
}

/**
 * A sliced base element is redundant when its slices are the entry points: an optional base
 * with a listed slice, or a required base whose required slices already cover its minimum.
 */
function baseCoveredBySlices(c: Candidate, listedIds: Set<string>, all: Candidate[]): boolean {
  if (!c.el.slicing || c.spec.pins) return false;
  const slices = all.filter((s) => s.id.startsWith(`${c.id}:`) && !s.id.slice(c.id.length + 1).includes("."));
  if (!slices.length) return false;
  const min = c.el.min ?? 0;
  if (min < 1) return slices.some((s) => listedIds.has(s.id));
  const covered = slices.filter((s) => s.required).reduce((n, s) => n + (s.el.min ?? 0), 0);
  return covered >= min;
}

// --------------------------------------------------------------------------- //
// Main                                                                        //
// --------------------------------------------------------------------------- //

type Core = Omit<AuthoringFieldsResult, "size_chars" | "response_chars" | "warnings" | "provenance">;

function dataBlock(res: Core): Record<string, unknown> {
  const d: Record<string, unknown> = { profile: res.profile, fields: res.fields };
  if (res.more) d.more = res.more;
  d.more_count = res.more_count;
  d.omitted = res.omitted;
  d.examples = res.examples;
  if (res.deps_missing) d.deps_missing = res.deps_missing;
  return d;
}

function measure(res: Core): number {
  return JSON.stringify(dataBlock(res)).length;
}

/** JSON length with every non-ASCII UTF-16 unit counted as its 6-character \\uXXXX escape. */
function escapedLength(v: unknown): number {
  const s = JSON.stringify(v);
  let n = s.length;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0x7e) n += 5;
  return n;
}

/** Default envelope provenance keys when the caller does not pass its own (tool name + a version). */
const DEFAULT_ENVELOPE = { tool: "fhir_get_authoring_fields", toolVersion: "00.00.00" };

/**
 * Characters of the whole tool response as fieldsTool's handler builds it:
 * `{ok, data: {...data, size_chars, response_chars}, warnings, provenance: {...provenance, tool, toolVersion}}`.
 */
function measureResponse(res: Core, warnings: string[], provenance: Record<string, unknown> | undefined, envelope: Record<string, unknown>): number {
  const data = { ...dataBlock(res), size_chars: measure(res), response_chars: 0 };
  const env = (n: number): unknown => ({ ok: true, data: { ...data, response_chars: n }, warnings, provenance: { ...(provenance || {}), ...envelope } });
  let n = escapedLength(env(0));
  for (let i = 0; i < 3; i++) {
    const next = escapedLength(env(n));
    if (next === n) break;
    n = next;
  }
  return n;
}

function stripDisplays(fields: FieldSpec[]): void {
  for (const f of fields) {
    if (f.binding?.codes) for (const c of f.binding.codes) delete c.display;
    if (f.children) stripDisplays(f.children);
  }
}

function compactChildren(fields: FieldSpec[]): void {
  for (const f of fields) {
    for (const c of f.children || []) {
      delete c.binding;
      delete c.example;
      if (c.format && c.format.length > 60) c.format = clip(c.format, 60);
    }
  }
}

export async function authoringFields(req: string | AuthoringFieldsRequest, deps: FieldsDeps): Promise<AuthoringFieldsResult> {
  const r: AuthoringFieldsRequest = typeof req === "string" ? { profile: req } : req;
  if (!r.profile || !String(r.profile).trim()) throw new AuthoringFieldsError("INVALID_ARGUMENT", "profile is required");
  const loaded = await deps.loadProfile(String(r.profile).trim(), r.package_id ?? null, r.version ?? null);
  const sd = loaded.sd;
  const snap: Array<Record<string, any>> = (sd?.snapshot || {}).element || [];
  if (!sd || sd.resourceType !== "StructureDefinition" || !snap.length) {
    throw new AuthoringFieldsError("INVALID_ARGUMENT", `${r.profile} is not a StructureDefinition with a snapshot`);
  }
  const rt = String(sd.type || snap[0].path.split(".")[0]);
  const els = projectForRequired(snap, projectElement);
  const E = new Map(els.map((e) => [e.id, e]));
  const required = requiredElements(loaded.profileId, els, { includeTargetImplied: true, includeMustSupport: true });
  const rows = new Map(required.elements.map((x) => [x.id, x]));

  // Example statistics: the package's examples of this profile, else of the resource type.
  const warnings: string[] = [...(loaded.warnings || [])];
  let examples: Array<Record<string, unknown>> = [];
  let basis: AuthoringFieldsResult["examples"]["basis"] = "none";
  try {
    const all = (await deps.loadExamples(loaded, rt)).filter((x) => isPlainObject(x) && x.resourceType === rt);
    const canon = loaded.canonical;
    const own = canon
      ? all.filter((x) => {
          const prof = (x.meta as Record<string, unknown> | undefined)?.profile;
          return Array.isArray(prof) && prof.some((p) => String(p).split("|")[0] === canon);
        })
      : [];
    if (own.length >= MIN_PROFILE_EXAMPLES) {
      examples = own;
      basis = "profile";
    } else if (all.length) {
      examples = all;
      basis = "resource_type";
    }
  } catch (e) {
    warnings.push(`example statistics unavailable: ${String((e as Error).message)}`);
  }

  const ctx: BuildCtx = { rt, E, rows, codeFixed: profileFixesCode(rt, els), deps, loaded, examples };
  const cands: Candidate[] = [];
  for (const e of els) {
    if (!e.id.includes(".") || e.max === "0") continue;
    const rel = e.id.slice(rt.length + 1);
    if (rel.includes(".")) continue; // deeper elements fold into their top-level field
    const name = rel.split(":")[0];
    if (name.endsWith("[x]") && rel.includes(":")) continue; // type slice of a choice: folded into the choice
    if (SKIP_TOP.has(name) && !rel.includes(":")) continue;
    const c = buildCandidate(ctx, e, 0);
    if (c) cands.push(c);
  }

  const isCommonTier1 = (c: Candidate): boolean => c.required || c.expected || (c.common !== null && c.common >= COMMON_PERCENT);
  await markRecordLinks(ctx, cands, (c) => isCommonTier1(c) || c.mustSupport);
  const isTier1 = (c: Candidate): boolean => isCommonTier1(c) || c.link?.kind === "backbone";
  const isTier2 = (c: Candidate): boolean => c.mustSupport || c.link?.kind === "reference";
  const full = r.detail === "full";
  const listedIds = new Set(cands.filter((c) => isTier1(c) || (full && isTier2(c))).map((c) => c.id));
  const kept = cands.filter((c) => !baseCoveredBySlices(c, listedIds, cands));
  const tier1 = kept.filter(isTier1);
  const tier2 = kept.filter((c) => !isTier1(c) && isTier2(c));
  const listed = full ? [...tier1, ...tier2] : tier1;
  await attachBindings(ctx, listed);
  await attachTargets(ctx, listed);

  const res: Core = {
    profile: { id: loaded.profileId, canonical: loaded.canonical, resourceType: rt, package_id: loaded.packageId, version: loaded.packageVersion },
    fields: listed.map((c) => c.spec),
    more_count: full ? 0 : tier2.length,
    omitted: 0,
    examples: { basis, count: examples.length },
  };
  if (!full && r.include_more !== false) {
    res.more = tier2.map((c): MoreField => (c.link?.kind === "reference" ? { field: c.spec.field, kind: c.spec.kind, targets: c.link.targets } : { field: c.spec.field, kind: c.spec.kind }));
  }
  if (loaded.depsMissing?.length) res.deps_missing = loaded.depsMissing;

  const envelope = r.envelope_provenance ?? DEFAULT_ENVELOPE;
  const respSize = (x: Core): number => measureResponse(x, warnings, loaded.provenance, envelope);
  if (!full) {
    // Budget (whole response): trim decorations first, then move common-only fields to `more`
    // (record links last), then drop from `more` (only when that gets the output under the
    // budget — otherwise the list stays and a warning says so).
    const limit = SIZE_BUDGET - RESPONSE_MARGIN;
    let size = respSize(res);
    if (size > limit) {
      stripDisplays(res.fields);
      size = respSize(res);
    }
    if (size > limit) {
      compactChildren(res.fields);
      size = respSize(res);
    }
    const linkIds = new Set(tier1.filter((c) => c.link).map((c) => c.spec.field));
    while (size > limit) {
      const order = res.fields.map((f, idx) => ({ f, idx })).reverse().filter(({ f }) => !f.required && !(f.why || "").startsWith("expected"));
      const i = order.find(({ f }) => !linkIds.has(f.field)) ?? order[0];
      if (!i) break;
      const [moved] = res.fields.splice(i.idx, 1);
      if (res.more) res.more.push({ field: moved.field, kind: moved.kind });
      res.more_count++;
      size = respSize(res);
    }
    if (size > limit && res.more && res.more.length) {
      const without = respSize({ ...res, more: [] });
      if (without <= limit) {
        while (size > limit && res.more.length) {
          res.more.pop();
          res.omitted++;
          size = respSize(res);
        }
      }
    }
    if (size > limit) warnings.push(`output exceeds the ${limit}-character budget (${size} chars): every listed field is required by the profile`);
  }

  const out: AuthoringFieldsResult = { ...res, size_chars: measure(res), response_chars: respSize(res), warnings };
  if (loaded.provenance) out.provenance = loaded.provenance;
  return out;
}

/** The `data` block of the tool envelope (what `size_chars` measures). */
export function authoringFieldsData(res: AuthoringFieldsResult): Record<string, unknown> {
  const d = dataBlock(res);
  d.size_chars = res.size_chars;
  d.response_chars = res.response_chars;
  return d;
}
