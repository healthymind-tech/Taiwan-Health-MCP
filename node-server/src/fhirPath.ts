/**
 * FHIRPath evaluation for StructureDefinition invariants (ElementDefinition.constraint).
 *
 * Wraps the `fhirpath` (npm) engine with the R4 model so that the engine is
 * type-aware: `value` resolves to `value[x]` (valueQuantity, valueString, ...),
 * `ofType()` / `is` / `as` work, and `%resource` / `%rootResource` are typed
 * nodes. Functions the engine cannot run offline are supplied here:
 *
 *  - `resolve()`   — resolves references against the validation context
 *                    (contained resources, Bundle entries) — never the network.
 *  - `memberOf()`  — answered from ValueSet expansions the caller pre-computed;
 *                    an unknown ValueSet makes the invariant "unevaluable".
 *  - `htmlChecks()` / `htmlChecks2()` — FHIRPathEngine.funcHtmlChecks1 / 2.
 *  - `as()` / `ofType()`, `startsWith` / `endsWith` / `contains` / `matches` /
 *    `matchesFull` / `length`, %sct / %loinc / %`vs-…` / %`ext-…` — ported
 *    from the HL7 Java FHIRPathEngine (7.0.1) where fhirpath.js differs.
 *  - fixInvariantExpression — FHIRPathExpressionFixer.fixExpr, applied by the
 *    validator before evaluating an invariant (invariantExpression()).
 *
 * Evaluation is synchronous; per-call context is held in a module-level slot
 * for the duration of one evaluation (JS is single-threaded, so this is safe).
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fhirpath: any = require("fhirpath");
const r4Model: any = require("fhirpath/fhir-context/r4");
const fpUtil: any = require("fhirpath/src/utilities");

const fpTypes: any = require("fhirpath/src/types");

// ---------------------------------------------------------------------------
// HL7 Java FHIRPathEngine (org.hl7.fhir.r5 7.0.1) semantics, ported where they
// differ from fhirpath.js and matter for invariant evaluation.
// ---------------------------------------------------------------------------

/** FHIRPathEngine.FHIR_TYPES_STRING */
const FHIR_TYPES_STRING = new Set(["string", "uri", "code", "oid", "id", "uuid", "sid", "markdown", "base64Binary", "canonical", "url", "xhtml"]);
const SYSTEM_TO_FHIR: Record<string, string> = {
  string: "string", integer: "integer", decimal: "decimal", boolean: "boolean", date: "date", datetime: "dateTime",
  time: "time", quantity: "Quantity", long: "integer64",
};

/** The Java `Base.fhirType()` of an item: the FHIR type for model nodes, the primitive name for literals. */
function javaFhirType(item: any): { type: string; literal: boolean } {
  let ti: any;
  try {
    ti = fpTypes.TypeInfo.fromValue(item);
  } catch {
    return { type: "", literal: true };
  }
  if (ti.namespace === "System" && ti.name === "Object") return { type: "", literal: false }; // an untyped node
  if (ti.namespace === "System" || !ti.namespace) {
    const n = String(ti.name);
    return { type: SYSTEM_TO_FHIR[n.toLowerCase()] ?? n, literal: true };
  }
  return { type: String(ti.name), literal: false };
}

/** convertToString(Base) for one primitive item, or null. */
function itemString(item: any): string | null {
  const v = fpUtil.valData(item);
  if (v === null || v === undefined) return null;
  if (typeof v === "object" && !(v instanceof fpTypes.FP_Type)) return null;
  return String(v);
}

function isStringTyped(item: any): boolean {
  return FHIR_TYPES_STRING.has(javaFhirType(item).type);
}

/** The string a String-typed parameter evaluated to; `undefined` when the parameter collection was empty. */
function paramString(p: any): string | undefined {
  if (p === undefined || p === null) return undefined;
  if (Array.isArray(p)) {
    if (p.length === 0) return undefined;
    return p.map((x) => itemString(x) ?? "").join("");
  }
  return itemString(p) ?? undefined;
}

/** FHIRPathEngine.funcStartsWith */
function javaStartsWith(coll: any[], prefix: any): any[] {
  const sw = paramString(prefix);
  if (!coll || coll.length === 0 || sw === undefined) return [];
  if (sw === "") return [true];
  if (!isStringTyped(coll[0])) return [];
  const s = itemString(coll[0]);
  return [s === null ? false : s.startsWith(sw)];
}

/** FHIRPathEngine.funcEndsWith */
function javaEndsWith(coll: any[], suffix: any): any[] {
  const sw = paramString(suffix);
  if (!coll || coll.length === 0 || sw === undefined) return [];
  if (sw === "") return [true];
  if (!isStringTyped(coll[0])) return [];
  const s = itemString(coll[0]);
  return [coll.length === 1 && s !== null ? s.endsWith(sw) : false];
}

/** FHIRPathEngine.funcContains (the string function) */
function javaContains(coll: any[], sub: any): any[] {
  if (!coll || coll.length !== 1) return [];
  if (Array.isArray(sub) && sub.length !== 1) return [];
  const sw = paramString(sub);
  if (sw === undefined) return [];
  if (sw === "") return [true];
  if (!isStringTyped(coll[0])) return [];
  const st = itemString(coll[0]);
  return [st ? st.includes(sw) : false];
}

/** FHIRPathEngine.funcMatches (`find` with (?s)) / funcMatchesFull (`matches` with (?s)). */
function javaMatches(full: boolean): (coll: any[], regex: any) => any[] {
  return function (coll: any[], regex: any): any[] {
    const sw = paramString(regex);
    if (!full && (!coll || coll.length === 0 || sw === undefined)) return [];
    if (coll && coll.length === 1 && sw) {
      if (!isStringTyped(coll[0])) return [];
      const st = itemString(coll[0]);
      if (!st) return [false];
      return [new RegExp(full ? `^(?:${sw})$` : sw, "s").test(st)];
    }
    return [false];
  };
}

/** FHIRPathEngine.funcLength */
function javaLength(coll: any[]): any[] {
  if (!coll || coll.length !== 1 || !isStringTyped(coll[0])) return [];
  const s = itemString(coll[0]);
  return s === null ? [] : [s.length];
}

/**
 * FHIRPathEngine.funcOfType / funcAs on one item: the exact type or, for complex types and resources, one of
 * its base types; a primitive never matches its supertype (`code` is not `string` here); `System.X` only
 * matches literals.
 */
function javaTypeMatch(item: any, typeInfo: any): boolean {
  const ns: string | null = typeInfo?.namespace ?? null;
  const name = String(typeInfo?.name ?? "");
  const { type, literal } = javaFhirType(item);
  if (ns === "System") return literal && type.toLowerCase() === (SYSTEM_TO_FHIR[name.toLowerCase()] ?? name).toLowerCase();
  if (type === name) return true;
  if (/^[a-z]/.test(type)) return false; // StructureDefinitionKind.PRIMITIVETYPE: no base walk
  let t: string | undefined = type;
  while ((t = r4Model.type2Parent?.[t])) if (t === name) return true;
  return false;
}

// ----------------------------------------------------------------- htmlChecks

const HTML_ELEMENTS = new Set([
  "p", "br", "div", "h1", "h2", "h3", "h4", "h5", "h6", "a", "span", "b", "em", "i", "strong", "small", "big", "tt", "dfn", "q",
  "var", "abbr", "acronym", "cite", "blockquote", "hr", "address", "bdo", "kbd", "sub", "sup", "ul", "ol", "li", "dl", "dt", "dd",
  "pre", "table", "caption", "colgroup", "col", "thead", "tr", "tfoot", "tbody", "th", "td", "code", "samp", "img", "map", "area",
]);
const HTML_ATTRS = new Set([
  "title", "style", "class", "id", "lang", "xml:lang", "xml:space", "dir", "accesskey", "tabindex", "span", "width", "align", "valign",
  "char", "charoff", "abbr", "axis", "headers", "scope", "rowspan", "colspan",
]);
const HTML_ELEMENT_ATTRS = new Set([
  "a.href", "a.name", "img.src", "img.border", "div.xmlns", "blockquote.cite", "q.cite", "a.charset", "a.type", "a.hreflang", "a.rel",
  "a.rev", "a.shape", "a.coords", "img.alt", "img.longdesc", "img.height", "img.width", "img.usemap", "img.ismap", "map.name",
  "area.shape", "area.coords", "area.href", "area.nohref", "area.alt", "table.summary", "table.width", "table.border", "table.frame",
  "table.rules", "table.cellspacing", "table.cellpadding", "pre.space", "td.nowrap",
]);

/**
 * One pass over an XHTML fragment: FHIRPathEngine.checkHtmlNames (`names`; block = true at every depth — the Java
 * recursion compares "p" with a node, so it never switches to the inline list) and checkForContent (`content`:
 * non-blank text or an img).
 */
function scanXhtml(src: string): { names: boolean; content: boolean } {
  let names = true;
  let content = false;
  const blank = (t: string): boolean => !t.replace(/[\u0000- ]+/g, "");
  const re = /<!--([\s\S]*?)-->|<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (m[1] !== undefined) {
      if (m[1].startsWith("DOCTYPE")) names = false;
    } else if (m[2] !== undefined) {
      if (!blank(m[2])) content = true;
    } else if (m[4] !== undefined) {
      if (m[3]) continue;
      const name = m[4].includes(":") ? m[4].slice(m[4].indexOf(":") + 1) : m[4];
      if (name === "img") content = true;
      if (!HTML_ELEMENTS.has(name)) names = false;
      const attrRe = /([^\s=/>]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/g;
      let a: RegExpExecArray | null;
      while ((a = attrRe.exec(m[5] ?? ""))) {
        const an = a[1];
        if (!(an.startsWith("xmlns") || HTML_ATTRS.has(an) || HTML_ELEMENT_ATTRS.has(`${name}.${an}`))) names = false;
      }
    } else if (m[6] !== undefined) {
      // entities decode to characters > U+0020 (Java trim() keeps U+00A0), so any entity is content
      if (!blank(m[6].replace(/&[^;\s]+;/g, "x"))) content = true;
    }
  }
  return { names, content };
}

// ------------------------------------------------------------- expression fixer

/**
 * org.hl7.fhir.validation.instance.utils.FHIRPathExpressionFixer.fixExpr (7.0.1). InstanceValidator.checkInvariant
 * (and the constraint cache key) uses the FIXED expression of every invariant — work-arounds for wrongly
 * published core expressions, e.g. ref-1 / bld-8 guarded by `exists() implies`, txt-2 → htmlChecks2().
 */
export function fixInvariantExpression(expr: string, key: string | null | undefined, fhirVersion = "4.0.1"): string {
  const r5 = /^5\./.test(fhirVersion);
  const r4 = /^4\.(0|3)(\.|$)/.test(fhirVersion);
  if (r5 && key === "opd-3") return "targetProfile.exists() implies (type = 'Reference' or type = 'canonical' or type.memberOf('http://hl7.org/fhir/ValueSet/all-resource-types'))";
  if (r4 && key === "opd-3") return "targetProfile.exists() implies (type = 'Reference' or type = 'canonical' or type.memberOf('http://hl7.org/fhir/ValueSet/resource-types'))";
  const fixed = FIXED_EXPRESSIONS.get(expr);
  if (expr === "probability is decimal implies (probability as decimal) <= 100") return fixed!;
  if (expr === "enableWhen.count() > 2 implies enableBehavior.exists()") return fixed!;
  if (key === "txt-2") return "htmlChecks2()";
  if (key === "que-7") return "operator = 'exists' implies (answer is boolean)";
  if (key === "dom-6") return "(%rootResource != $this) or text.`div`.exists()";
  if (r4 && expr === "offset.empty() or (when.exists() and ((when in ('C' | 'CM' | 'CD' | 'CV')).not()))") {
    return "offset.empty() or (when.exists() and when.select($this in ('C' | 'CM' | 'CD' | 'CV')).allFalse())";
  }
  if (!r5 && key === "eld-19") {
    return String.raw`path.matches('^[^\\s\\.,:;\\\'"\\/|?!@#$%&*()\\[\\]{}]{1,64}(\\.[^\\s\\.,:;\\\'"\\/|?!@#$%&*()\\[\\]{}]{1,64}(\\[x\\])?(\\:[^\\s\\.]+)?)*$')`;
  }
  if (!r5 && key === "eld-20") return String.raw`path.matches('^[A-Za-z][A-Za-z0-9]*(\\.[a-z][A-Za-z0-9]*(\\[x])?)*$')`;
  if (expr === "probability is decimal implies probability.as(decimal) <= 100") {
    return key === "ras-2" ? "probability.empty() or (probability is decimal implies probability.as(decimal) <= 100)" : expr;
  }
  return fixed ?? expr;
}

/**
 * The expression the validator evaluates for an invariant: fixInvariantExpression, except dom-3. InstanceValidator
 * .checkInvariant never runs dom-3 (it enforces the rule in code, checkContainedReferences); we still evaluate it,
 * with `as(T)` read as `ofType(T)` — the published expression applies as() to descendants(), which the Java
 * singleton rule (funcAs → FHIRPATH_AS_COLLECTION) would turn into an exception.
 */
export function invariantExpression(expr: string, key: string | null | undefined, fhirVersion = "4.0.1"): string {
  if (key === "dom-3") return expr.replace(/\.as\(/g, ".ofType(");
  return fixInvariantExpression(expr, key, fhirVersion);
}

const REF1_R5 ="reference.startsWith('#').not() or (reference.substring(1).trace('url') in %rootResource.contained.id.trace('ids')) or (reference='#' and %rootResource!=%resource)";
const REF1_R4 = "reference.startsWith('#').not() or (reference.substring(1).trace('url') in %rootResource.contained.id.trace('ids'))";
const REF1_R3 = "reference.startsWith('#').not() or (reference.substring(1).trace('url') in %resource.contained.id.trace('ids'))";
const SD_PATH_EXPR = String.raw`(%resource.kind = 'logical' or element.first().path.startsWith(%resource.type)) and (element.tail().not() or  element.tail().all(path.startsWith(%resource.differential.element.first().path.replaceMatches('\\..*','')&'.')))`;

/** Expression-keyed rewrites of FHIRPathExpressionFixer.fixExpr (first match wins there; the keys are distinct). */
const FIXED_EXPRESSIONS = new Map<string, string>([
  ["probability is decimal implies (probability as decimal) <= 100", "(probability.exists() and (probability is decimal)) implies ((probability as decimal) <= 100)"],
  ["enableWhen.count() > 2 implies enableBehavior.exists()", "enableWhen.count() >= 2 implies enableBehavior.exists()"],
  ["generated='generated' implies source.empty()", "generation='generated' implies source.empty()"],
  [
    "binding.empty() or type.code.empty() or type.code.contains(\":\") or type.select((code = 'code') or (code = 'Coding') or (code='CodeableConcept') or (code = 'Quantity') or (code = 'string') or (code = 'uri') or (code = 'Duration')).exists()",
    "binding.empty() or type.code.empty() or type.code.contains(':') or type.select((code = 'code') or (code = 'Coding') or (code='CodeableConcept') or (code = 'Quantity') or (code = 'string') or (code = 'uri') or (code = 'Duration')).exists()",
  ],
  [REF1_R5, `reference.exists() implies (${REF1_R5})`],
  [REF1_R4, `reference.exists() implies (reference = '#' or (${REF1_R4}))`],
  [REF1_R3, `reference.exists() implies (reference = '#' or (${REF1_R4}))`],
  ["fullUrl.contains('/_history/').not()", "fullUrl.exists() implies fullUrl.contains('/_history/').not()"],
  ["name.matches('[A-Z]([A-Za-z0-9_]){0,254}')", "name.exists() implies name.matches('^[A-Z]([A-Za-z0-9_]){0,254}$')"],
  [
    "clinicalStatus.exists() or verificationStatus.coding.where(system='http://terminology.hl7.org/CodeSystem/condition-ver-status' and code = 'entered-in-error').exists() or category.select($this='problem-list-item').empty()",
    "(verificationStatus.coding.where(system='http://terminology.hl7.org/CodeSystem/condition-ver-status' and code = 'entered-in-error').exists() and category.coding.exists(system='http://terminology.hl7.org/CodeSystem/condition-category' and code ='problem-list-item').empty()) implies (clinicalStatus.exists())",
  ],
  ["url.matches('([^|#])*')", "$this.matches('([^|#])*')"],
  [
    "((kind in 'resource' | 'complex-type') and (specialization = 'derivation')) implies differential.element.where((min != 0 and min != 1) or (max != '1' and max != '*')).empty()",
    "((kind in 'resource' | 'complex-type') and (derivation = 'specialization')) implies differential.element.where((min.exists() and min != 0 and min != 1) or (max.exists() and max != '1' and max != '*')).empty()",
  ],
  ["(component.empty() and hasMember.empty()) implies (dataAbsentReason or value)", "(component.empty() and hasMember.empty()) implies (dataAbsentReason.exists() or value.exists())"],
  ["isModifier implies isModifierReason.exists()", "(isModifier.exists() and isModifier) implies isModifierReason.exists()"],
  [SD_PATH_EXPR, SD_PATH_EXPR.replace("element.tail().not()", "element.tail().empty()")],
  ["differential.element.all(id) and differential.element.id.trace('ids').isDistinct()", "differential.element.all(id.exists()) and differential.element.id.trace('ids').isDistinct()"],
  ["snapshot.element.all(id) and snapshot.element.id.trace('ids').isDistinct()", "snapshot.element.all(id.exists()) and snapshot.element.id.trace('ids').isDistinct()"],
  ["(code or value.empty()) and (system.empty() or system = 'urn:iso:std:iso:4217')", "(code.exists() or value.empty()) and (system.empty() or system = 'urn:iso:std:iso:4217')"],
  ["value.empty() or code!=component.code", "value.empty() or (code in component.code).not()"],
  [
    "(code or value.empty()) and (system.empty() or system = %ucum) and (value.empty() or value > 0)",
    "(code.exists() or value.empty()) and (system.empty() or system = %ucum) and (value.empty() or value > 0)",
  ],
  ["element.all(definition and min and max)", "element.all(definition.exists() and min.exists() and max.exists())"],
  ["telecom or endpoint", "telecom.exists() or endpoint.exists()"],
  ["searchType implies type = 'string'", "searchType.exists() implies type = 'string'"],
  [
    "abatement.empty() or (abatement as boolean).not()  or clinicalStatus='resolved' or clinicalStatus='remission' or clinicalStatus='inactive'",
    "abatement.empty() or (abatement is boolean).not() or (abatement as boolean).not() or (clinicalStatus = 'resolved') or (clinicalStatus = 'remission') or (clinicalStatus = 'inactive')",
  ],
  ["(component.empty() and related.empty()) implies (dataAbsentReason or value)", "(component.empty() and related.empty()) implies (dataAbsentReason.exists() or value.exists())"],
]);

/**
 * FHIRPathEngine.resolveConstant: %sct / %loinc / %ucum / %us-zip and the %`vs-…` / %`cs-…` / %`ext-…` shorthands
 * (%resource / %rootResource / %context come from the evaluation context).
 */
function javaConstants(expression: string): Record<string, string> {
  const out: Record<string, string> = {
    sct: "http://snomed.info/sct",
    loinc: "http://loinc.org",
    ucum: "http://unitsofmeasure.org",
    "us-zip": "[0-9]{5}(-[0-9]{4}){0,1}",
  };
  for (const m of expression.matchAll(/%`((vs|cs|ext)-([^`]*))`/g)) {
    out[m[1]] = m[2] === "vs" ? `http://hl7.org/fhir/ValueSet/${m[3]}` : m[2] === "cs" ? `http://hl7.org/fhir/${m[3]}` : `http://hl7.org/fhir/StructureDefinition/${m[3]}`;
  }
  return out;
}

export interface FhirPathEnv {
  /** The resource that contains the node (for contained resources: the contained one). */
  resource: Record<string, any>;
  /** The top-level resource (the container / the Bundle being validated). */
  rootResource: Record<string, any>;
  /** Resolve a Reference.reference string seen from `fromResource`; null when not resolvable. */
  resolveReference?: (reference: string, fromResource: Record<string, any>) => Record<string, any> | null;
  /** Membership of a code / Coding / CodeableConcept in a ValueSet; undefined = unknown. */
  memberOf?: (value: any, valueSetUrl: string) => boolean | undefined;
}

export type ConstraintOutcome =
  | { status: "pass" }
  | { status: "fail" }
  | { status: "unevaluable"; reason: string };

class Unevaluable extends Error {}

let current: FhirPathEnv | null = null;

const typedNodes = new WeakMap<object, any[]>();

/** The resource as a typed fhirpath ResourceNode (cached per resource object). */
function typedNode(resource: any): any[] {
  if (!resource || typeof resource !== "object") return [];
  let nodes = typedNodes.get(resource);
  if (!nodes) {
    nodes = fhirpath.evaluate(resource, "$this", null, r4Model, { resolveInternalTypes: false }) as any[];
    typedNodes.set(resource, nodes);
  }
  return nodes;
}

/** Narrative check of the R4 txt-1 invariant: `htmlChecks()` = FHIRPathEngine.funcHtmlChecks1 (checkHtmlNames). */
export function narrativeHtmlOk(div: unknown): boolean {
  if (typeof div !== "string") return false;
  return scanXhtml(div).names;
}

/** txt-2 after FHIRPathExpressionFixer: `htmlChecks2()` = FHIRPathEngine.funcHtmlChecks2 (checkForContent). */
export function narrativeHasContent(div: unknown): boolean {
  if (typeof div !== "string") return false;
  return scanXhtml(div).content;
}

/** The xhtml of a focus item: an xhtml node as is; a string wrapped in a div (funcHtmlChecks1). */
function xhtmlOf(item: any): string | null {
  const v = fpUtil.valData(item);
  if (typeof v !== "string") return null;
  return javaFhirType(item).type === "xhtml" || /^\s*<div[\s>]/.test(v) ? v : `<div xmlns="http://www.w3.org/1999/xhtml">${v}</div>`;
}

const USER_FUNCTIONS: Record<string, any> = {
  resolve: {
    internalStructures: true,
    fn: function (coll: any[]): any[] {
      const env = current;
      if (!env || !env.resolveReference) throw new Unevaluable("resolve() unavailable");
      const out: any[] = [];
      for (const item of coll || []) {
        const v = fpUtil.valData(item);
        let ref: string | null = null;
        if (typeof v === "string") ref = v;
        else if (v && typeof v === "object" && typeof v.reference === "string") ref = v.reference;
        if (!ref) continue;
        const target = env.resolveReference(ref, env.resource);
        if (target) for (const n of typedNode(target)) out.push(n);
      }
      return out;
    },
  },
  memberOf: {
    internalStructures: true,
    arity: { 1: ["String"] },
    fn: function (coll: any[], vsUrl: any): any[] {
      const env = current;
      const url = Array.isArray(vsUrl) ? fpUtil.valData(vsUrl[0]) : vsUrl;
      if (!coll || coll.length !== 1 || typeof url !== "string") return [];
      // FHIRPathEngine.funcMemberOf: only code / string / uri / Coding / CodeableConcept are tested
      const t = javaFhirType(coll[0]).type;
      if (t && !["code", "string", "uri", "Coding", "CodeableConcept"].includes(t)) return [];
      const answer = env?.memberOf ? env.memberOf(fpUtil.valData(coll[0]), url) : undefined;
      if (answer === undefined) throw new Unevaluable(`memberOf('${url}') not resolvable locally`);
      return [answer];
    },
  },
  htmlChecks: {
    internalStructures: true,
    fn: function (coll: any[]): any[] {
      if (!coll || coll.length !== 1) return [];
      const x = xhtmlOf(coll[0]);
      return x === null ? [] : [narrativeHtmlOk(x)];
    },
  },
  htmlChecks2: {
    internalStructures: true,
    fn: function (coll: any[]): any[] {
      if (!coll || coll.length !== 1) return [false];
      const v = fpUtil.valData(coll[0]);
      return [typeof v === "string" && narrativeHasContent(v)];
    },
  },
  // FHIRPathEngine.funcAs: singleton rule (doNotEnforceAsSingletonRule is never set by the validator)
  as: {
    internalStructures: true,
    arity: { 1: ["TypeSpecifier"] },
    fn: function (coll: any[], typeInfo: any): any[] {
      if (coll && coll.length > 1) throw new Error(`Attempt to use as() on more than one item (${coll.length}, 'as(${typeInfo})')`);
      return (coll || []).filter((v) => javaTypeMatch(v, typeInfo));
    },
  },
  ofType: {
    internalStructures: true,
    arity: { 1: ["TypeSpecifier"] },
    fn: function (coll: any[], typeInfo: any): any[] {
      return (coll || []).filter((v) => javaTypeMatch(v, typeInfo));
    },
  },
  startsWith: { internalStructures: true, fn: javaStartsWith, arity: { 1: ["String"] } },
  endsWith: { internalStructures: true, fn: javaEndsWith, arity: { 1: ["String"] } },
  contains: { internalStructures: true, fn: javaContains, arity: { 1: ["String"] } },
  matches: { internalStructures: true, fn: javaMatches(false), arity: { 1: ["String"] } },
  matchesFull: { internalStructures: true, fn: javaMatches(true), arity: { 1: ["String"] } },
  length: { internalStructures: true, fn: javaLength },
  conformsTo: {
    internalStructures: true,
    arity: { 1: ["String"] },
    fn: function (): any[] {
      throw new Unevaluable("conformsTo() not supported");
    },
  },
};

const OPTIONS = { userInvocationTable: USER_FUNCTIONS, traceFn: () => undefined };

const compiled = new Map<string, (data: any, env: any) => any[]>();
const COMPILE_CACHE_MAX = 5000;

/**
 * Pick the base path FHIRPath should use for a node. Resources use their type;
 * complex datatypes use the type name (so choice elements such as
 * `Extension.value` resolve); backbone elements use their element path.
 */
let typeToPath: Map<string, string> | null = null;

/** A model path whose declared type is `typeCode` (so the base node is typed). */
function representativePath(typeCode: string): string | null {
  if (!typeToPath) {
    typeToPath = new Map();
    for (const [p, t] of Object.entries(r4Model.path2Type as Record<string, string>)) {
      if (!typeToPath.has(t) || p.length < typeToPath.get(t)!.length) typeToPath.set(t, p);
    }
  }
  return typeToPath.get(typeCode) ?? null;
}

export function fhirPathBase(elementPath: string, typeCode: string | null): string {
  if (typeCode && typeCode !== "BackboneElement" && typeCode !== "Element" && /^[A-Z]/.test(typeCode)) {
    // Resources: their type name. Datatypes: a path the R4 model types as
    // `typeCode`, so `ofType()` / `is` work on the node itself.
    if (r4Model.type2Parent?.[typeCode] === "DomainResource" || r4Model.type2Parent?.[typeCode] === "Resource") return typeCode;
    const own = elementPath.endsWith("[x]") ? elementPath.slice(0, -3) + typeCode : elementPath;
    if ((r4Model.path2Type as Record<string, string>)[own] === typeCode) return own;
    return representativePath(typeCode) ?? typeCode;
  }
  if (typeCode && elementPath.endsWith("[x]")) {
    // Primitive choice value: `Observation.effective[x]` as dateTime → Observation.effectiveDateTime
    return elementPath.slice(0, -3) + typeCode[0].toUpperCase() + typeCode.slice(1);
  }
  return elementPath.replace(/\[x\]/g, "");
}

/**
 * On a primitive node the HL7 engine lets `value` denote the primitive's own
 * value (invariants such as `value.matches('…')` on string elements rely on it);
 * a FHIR primitive has no JSON child called `value`, so rewriting a bare
 * leading `value` to `$this` is exact.
 */
export function primitiveValueAlias(expression: string): string {
  return expression.replace(/(^|[^.\w$%'"])value\b(?!\s*\()/g, "$1$this");
}

function compile(base: string, expression: string): (data: any, env: any) => any[] {
  const key = base + "\u0000" + expression;
  let fn = compiled.get(key);
  if (!fn) {
    fn = fhirpath.compile({ base, expression }, r4Model, OPTIONS) as (data: any, env: any) => any[];
    if (compiled.size >= COMPILE_CACHE_MAX) compiled.clear();
    compiled.set(key, fn);
  }
  return fn;
}

/**
 * Evaluate an expression against one node with the invariant engine (same
 * model, options, user functions and variables as evaluateConstraint) and
 * return the raw result collection. Throws on syntax / evaluation errors and
 * on `Unevaluable` host functions. `internal: true` keeps fhirpath.js typed
 * nodes (for `fhirpath.types()`), otherwise plain JS values.
 */
export function evaluateExpression(
  node: any,
  base: string,
  expression: string,
  env: FhirPathEnv,
  extraVars: Record<string, any> = {},
  opts: { internal?: boolean } = {},
): any[] {
  const prev = current;
  current = env;
  try {
    const fn = compile(base, expression) as (data: any, env: any, o?: any) => any[];
    const vars = { ...javaConstants(expression), ...extraVars, resource: typedNode(env.resource)[0], rootResource: typedNode(env.rootResource)[0] };
    return opts.internal ? fn(node, vars, { resolveInternalTypes: false }) : fn(node, vars);
  } finally {
    current = prev;
  }
}

/** Exposes fhirpath.js `types()` for results of evaluateExpression(…, { internal: true }). */
export function resultTypes(result: any[]): string[] {
  return fhirpath.types(result) as string[];
}

/** Evaluate an invariant expression against one node. */
export function evaluateConstraint(
  node: any,
  base: string,
  expression: string,
  env: FhirPathEnv,
  extraVars: Record<string, any> = {},
): ConstraintOutcome {
  try {
    const result = evaluateExpression(node, base, expression, env, extraVars);
    if (!Array.isArray(result) || result.length === 0) {
      // Same as the HL7 Java engine (convertToBoolean): an empty result is false.
      return { status: "fail" };
    }
    if (result.length === 1 && typeof result[0] === "boolean") {
      return result[0] ? { status: "pass" } : { status: "fail" };
    }
    // Non-boolean result: HL7 treats a non-empty collection as true.
    return result.every((r: any) => r !== false) ? { status: "pass" } : { status: "fail" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { status: "unevaluable", reason: msg };
  }
}

/** Test seam: number of compiled expressions held. */
export function compiledCount(): number {
  return compiled.size;
}
