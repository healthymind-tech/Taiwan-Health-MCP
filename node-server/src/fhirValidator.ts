/**
 * In-process FHIR validator — pre-flight conformance checks. Faithful port of
 * `src/fhir_validator.py`. Pure structural checks + FHIRPath invariants.
 *
 * FHIRPath parity: Python uses `fhirpathpy`, which does NOT implement several
 * functions (`hasValue`, `htmlChecks`, `memberOf`, `resolve`) and throws
 * "Not implemented" when one is *reached* at runtime — counted as an
 * "unevaluable" invariant. We reproduce this exactly by overriding those four
 * functions in the `fhirpath` (npm) engine to throw on invocation (lazy, so an
 * unreached branch — e.g. inside `.where()` over an empty collection — does not
 * throw), matching fhirpathpy's behaviour.
 */

import fhirpath from "fhirpath";
import { fixedPattern, isSliceMember } from "./fhirSnapshot.js";

export const SOURCE = "builtin";

export function issue(severity: string, path: string, code: string, message: string): Record<string, any> {
  return { severity, path, code, message };
}

function elements(sd: Record<string, any>): Array<Record<string, any>> {
  return (sd.snapshot || {}).element || [];
}

export function relPath(path: string, root: string): string | null {
  if (path === root) return "";
  const prefix = root + ".";
  return path.startsWith(prefix) ? path.slice(prefix.length) : null;
}

/** Flat list of values at a dotted element path relative to `node`. */
export function getAtPath(node: any, rel: string): any[] {
  if (rel === "") return [node];
  let current: any[] = [node];
  for (const seg of rel.split(".")) {
    const nxt: any[] = [];
    const choice = seg.endsWith("[x]");
    const stem = choice ? seg.slice(0, -3) : seg;
    for (const item of current) {
      if (!(item && typeof item === "object" && !Array.isArray(item))) continue;
      if (choice) {
        for (const [key, val] of Object.entries(item)) {
          if (key.startsWith(stem) && key !== stem && /[A-Z]/.test(key[stem.length] || "")) {
            if (Array.isArray(val)) nxt.push(...val);
            else nxt.push(val);
          }
        }
      } else if (seg in item) {
        const val = item[seg];
        if (Array.isArray(val)) nxt.push(...val);
        else nxt.push(val);
      }
    }
    current = nxt;
    if (current.length === 0) break;
  }
  return current.filter((v) => v !== null && v !== undefined);
}

function choicePropsPresent(node: Record<string, any>, stem: string): string[] {
  const out: string[] = [];
  for (const key of Object.keys(node)) {
    if (key.startsWith(stem) && key !== stem && /[A-Z]/.test(key.slice(stem.length, stem.length + 1))) {
      out.push(key);
    }
  }
  return out;
}

function deepEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

/** pattern[x]: deep subset match. */
function patternMatches(actual: any, pattern: any): boolean {
  if (pattern && typeof pattern === "object" && !Array.isArray(pattern)) {
    if (!(actual && typeof actual === "object" && !Array.isArray(actual))) return false;
    return Object.entries(pattern).every(([k, v]) => patternMatches(actual[k], v));
  }
  if (Array.isArray(pattern)) {
    if (!Array.isArray(actual)) return false;
    return pattern.every((p) => actual.some((a) => patternMatches(a, p)));
  }
  return deepEqual(actual, pattern);
}

export function validateStructure(sd: Record<string, any>, resource: Record<string, any>): Array<Record<string, any>> {
  const root = sd.type || resource.resourceType || "";
  const issues: Array<Record<string, any>> = [];
  for (const el of elements(sd)) {
    if (isSliceMember(el)) continue;
    const path = el.path || "";
    const rel = relPath(path, root);
    if (rel === null || rel === "") continue;
    if (rel.includes(".") && getAtPath(resource, rel.split(".").slice(0, -1).join(".")).length === 0) {
      continue;
    }
    const minCard = el.min;
    const maxCard = el.max;
    const isChoice = rel.endsWith("[x]");
    const values = getAtPath(resource, rel);

    if (typeof minCard === "number" && minCard >= 1 && values.length === 0) {
      issues.push(issue("error", path, "required", `${path} is required (min=${minCard}) but missing`));
    }
    if (maxCard !== null && maxCard !== undefined && maxCard !== "*") {
      if (/^\d+$/.test(String(maxCard))) {
        const cap = parseInt(String(maxCard), 10);
        if (values.length > cap) {
          issues.push(issue("error", path, "cardinality", `${path} occurs ${values.length} times (max=${cap})`));
        }
      }
    }

    if (isChoice && !rel.includes(".")) {
      const stem = rel.slice(0, -3);
      const present = choicePropsPresent(resource, stem);
      if (present.length > 1) {
        issues.push(issue("error", path, "choice", `${path}: only one of ${pyList(present)} may be present`));
      }
    }

    const [fixed, pattern] = fixedPattern(el);
    if (fixed !== null) {
      for (const v of values) {
        if (!deepEqual(v, fixed.value)) {
          issues.push(issue("error", path, "fixed", `${path} must equal fixed value`));
          break;
        }
      }
    }
    if (pattern !== null) {
      for (const v of values) {
        if (!patternMatches(v, pattern.value)) {
          issues.push(issue("error", path, "pattern", `${path} must match the required pattern`));
          break;
        }
      }
    }

    const maxLen = el.maxLength;
    if (typeof maxLen === "number") {
      for (const v of values) {
        if (typeof v === "string" && v.length > maxLen) {
          issues.push(issue("error", path, "maxLength", `${path} exceeds maxLength ${maxLen}`));
          break;
        }
      }
    }
  }
  return issues;
}

/** Render a JS array the way Python prints a list: ['a', 'b']. */
function pyList(items: string[]): string {
  return "[" + items.map((s) => `'${s}'`).join(", ") + "]";
}

function valueAt(node: any, dotted: string): any {
  let cur = node;
  for (const seg of dotted.split(".")) {
    if (Array.isArray(cur)) cur = cur.length ? cur[0] : null;
    if (!(cur && typeof cur === "object" && !Array.isArray(cur))) return null;
    cur = cur[seg];
  }
  if (Array.isArray(cur)) return cur.length ? cur[0] : null;
  return cur;
}

function sliceDiscriminatorValues(els: Array<Record<string, any>>, basePath: string, sliceName: string, disc: any[]): Record<string, any> {
  const out: Record<string, any> = {};
  for (const d of disc) {
    const dpath = d.path;
    if (!dpath) continue;
    const childIdA = `${basePath}:${sliceName}.${dpath}`;
    for (const el of els) {
      if (el.id === childIdA || (el.path === `${basePath}.${dpath}` && el.sliceName === sliceName)) {
        const [fixed, pattern] = fixedPattern(el);
        if (fixed !== null) out[dpath] = fixed.value;
        else if (pattern !== null) out[dpath] = pattern.value;
        break;
      }
    }
  }
  return out;
}

export function validateSlicing(sd: Record<string, any>, resource: Record<string, any>): Array<Record<string, any>> {
  const root = sd.type || resource.resourceType || "";
  const els = elements(sd);
  const issues: Array<Record<string, any>> = [];
  for (const head of els) {
    const slicing = head.slicing;
    if (!slicing || head.sliceName) continue;
    const disc = slicing.discriminator || [];
    if (!disc.length || disc.some((d: any) => !["value", "pattern"].includes(d.type))) continue;
    const path = head.path || "";
    const rel = relPath(path, root);
    if (!rel) continue;
    const entries = getAtPath(resource, rel);
    const slices = els.filter((e) => e.path === path && e.sliceName);
    for (const sl of slices) {
      const name = sl.sliceName;
      const expected = sliceDiscriminatorValues(els, path, name, disc);
      if (Object.keys(expected).length === 0) continue;
      const matched = entries.filter((e) =>
        Object.keys(expected).every((dp) => expected[dp] !== null && expected[dp] !== undefined && deepEqual(valueAt(e, dp), expected[dp])),
      );
      const smin = sl.min;
      if (typeof smin === "number" && smin >= 1 && matched.length < smin) {
        issues.push(issue("error", `${path}:${name}`, "slice-cardinality", `slice '${name}' requires at least ${smin} matching entr(y/ies)`));
      }
    }
  }
  return issues;
}

// FHIRPath functions fhirpathpy does not implement — throw on invocation to
// reproduce its "unevaluable" behaviour exactly.
const notImplemented = (name: string) => () => {
  throw new Error("Not implemented: " + name);
};
const FHIRPATH_OPTIONS: any = {
  userInvocationTable: {
    hasValue: { fn: notImplemented("hasValue"), arity: { 0: [] } },
    htmlChecks: { fn: notImplemented("htmlChecks"), arity: { 0: [] } },
    memberOf: { fn: notImplemented("memberOf"), arity: { 1: ["String"] } },
    resolve: { fn: notImplemented("resolve"), arity: { 0: [] } },
  },
};

export function evaluateInvariants(sd: Record<string, any>, resource: Record<string, any>): Array<Record<string, any>> {
  const root = sd.type || resource.resourceType || "";
  const issues: Array<Record<string, any>> = [];
  let unevaluable = 0;
  for (const el of elements(sd)) {
    if (isSliceMember(el)) continue;
    const path = el.path || "";
    const rel = relPath(path, root);
    if (rel === null) continue;
    const nodes = getAtPath(resource, rel);
    for (const c of el.constraint || []) {
      const expr = c.expression;
      if (!expr) continue;
      const key = c.key || "invariant";
      const severity = c.severity || "error";
      const human = c.human || expr;
      for (const node of nodes) {
        let result: any;
        try {
          result = fhirpath.evaluate(node, expr, undefined, undefined, FHIRPATH_OPTIONS);
        } catch {
          unevaluable += 1;
          continue;
        }
        const satisfied = Boolean(result && result.length) && !(result.length === 1 && result[0] === false);
        if (!satisfied) {
          issues.push(issue(severity, path, key, human));
          break;
        }
      }
    }
  }
  if (unevaluable) {
    issues.push(
      issue(
        "information",
        "",
        "invariant-unevaluated",
        `${unevaluable} invariant expression(s) could not be evaluated locally ` +
          `(unsupported FHIRPath function); not a conformance failure`,
      ),
    );
  }
  return issues;
}

export function isValid(issues: Array<Record<string, any>>): boolean {
  return !issues.some((i) => i.severity === "error");
}
