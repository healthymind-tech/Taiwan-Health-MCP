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
 *  - `htmlChecks()`— a basic XHTML narrative safety check.
 *  - `as(T)`       — the function form is lenient over collections (like the
 *                    HL7 Java engine), which the R4 dom-3 invariant relies on.
 *
 * Evaluation is synchronous; per-call context is held in a module-level slot
 * for the duration of one evaluation (JS is single-threaded, so this is safe).
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fhirpath: any = require("fhirpath");
const r4Model: any = require("fhirpath/fhir-context/r4");
const fpFiltering: any = require("fhirpath/src/filtering");
const fpUtil: any = require("fhirpath/src/utilities");
const fpStrings: any = require("fhirpath/src/strings");

/**
 * HL7 Java engine semantics for string tests on an empty input: `false`
 * instead of the spec's empty collection. Invariants are written against the
 * Java engine — e.g. ref-1 `reference.startsWith('#').not() or …` passes for a
 * Reference without `.reference` only under this reading.
 */
function javaEmptyFalse(fn: (...a: any[]) => any): (...a: any[]) => any {
  return function (this: any, coll: any[], ...rest: any[]): any {
    if (!coll || coll.length === 0) return [false];
    return fn.call(this, coll, ...rest);
  };
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

/** Basic XHTML narrative check (txt-1/txt-2 style): xhtml div, no active content. */
export function narrativeHtmlOk(div: unknown): boolean {
  if (typeof div !== "string") return false;
  const s = div.trim();
  if (!/^<div[\s>]/i.test(s) || !/<\/div>\s*$/i.test(s)) return false;
  if (!/xmlns\s*=\s*["']http:\/\/www\.w3\.org\/1999\/xhtml["']/.test(s)) return false;
  if (/<\s*(script|object|applet|embed|form|input|iframe|frame|frameset|head|body|html|base|link|meta|style)\b/i.test(s)) return false;
  if (/\son[a-z]+\s*=/i.test(s)) return false;
  return true;
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
      const answer = env?.memberOf ? env.memberOf(fpUtil.valData(coll[0]), url) : undefined;
      if (answer === undefined) throw new Unevaluable(`memberOf('${url}') not resolvable locally`);
      return [answer];
    },
  },
  htmlChecks: {
    internalStructures: true,
    fn: function (coll: any[]): any[] {
      if (!coll || coll.length === 0) return [];
      return [coll.every((n: any) => narrativeHtmlOk(fpUtil.valData(n)))];
    },
  },
  as: { internalStructures: true, fn: fpFiltering.ofTypeFn, arity: { 1: ["TypeSpecifier"] } },
  startsWith: { internalStructures: true, fn: javaEmptyFalse(fpStrings.startsWith), arity: { 1: ["String"] } },
  endsWith: { internalStructures: true, fn: javaEmptyFalse(fpStrings.endsWith), arity: { 1: ["String"] } },
  contains: { internalStructures: true, fn: javaEmptyFalse(fpStrings.containsFn), arity: { 1: ["String"] } },
  matches: { internalStructures: true, fn: javaEmptyFalse(fpStrings.matches), arity: { 1: ["String"], 2: ["String", "String"] } },
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

/** Evaluate an invariant expression against one node. */
export function evaluateConstraint(
  node: any,
  base: string,
  expression: string,
  env: FhirPathEnv,
  extraVars: Record<string, any> = {},
): ConstraintOutcome {
  const prev = current;
  current = env;
  try {
    const fn = compile(base, expression);
    const vars = { ...extraVars, resource: typedNode(env.resource)[0], rootResource: typedNode(env.rootResource)[0] };
    const result = fn(node, vars);
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
  } finally {
    current = prev;
  }
}

/** Test seam: number of compiled expressions held. */
export function compiledCount(): number {
  return compiled.size;
}
