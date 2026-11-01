/**
 * fhir_get_bundle_form v1.2: profile invariants (resource-level constraints of every entry's
 * profile and of the Bundle profile) turned into form structure + placeholder hints, derived only
 * from the FHIRPath expression (IG-agnostic — no per-IG strings, no per-key code):
 *
 *   - choose-one: `a.exists() or b.exists() …` none of which the form holds, or one `x.where(p)
 *     .exists()` that several slices of x satisfy -> ONE option (the first) is placed, its
 *     placeholders carry `choose_one` (the rule + every option);
 *   - conditional required: `G implies (x.exists() and …)`, `A or (x.exists() and …)`,
 *     `X.where(C).all(y.exists())` -> when the condition reads a placeholder the record fills, the
 *     required elements are placed with `required_if` (required=false, `when` = the condition as
 *     FHIRPath + its context, `element` = what to delete when it does not hold); a condition the
 *     prefilled values decide makes them plainly required (or not placed at all);
 *   - format: `x.matches('re')`, `x.all(code.matches('re'))`, `x.all(toString().matches('re'))` ->
 *     `format` (+ `format_rule`) on the placeholders of x;
 *   - Bundle-level rules relating entries (`entry.resource.ofType(X).where(c).exists() implies
 *     entry.resource.ofType(Y).y.exists()`) -> the element in the Y entry, `required_if` evaluated on
 *     the Bundle.
 *
 * Elements are materialised from the snapshot (slices whose pattern satisfies a `where()` first,
 * else the `where()` equalities), with their fixed / pattern / required children; on a clone, kept
 * only when every step resolved (never half an element). An expression it cannot parse confidently
 * is attached raw (`rules`) to the placeholder(s) it reads — no guessing.
 */

import { evaluateConstraint, fhirPathBase } from "../fhirPath.js";
import { splitTop, unwrap } from "../fhirSuggestions/invariants.js";
import type { SkeletonItem } from "./skeleton.js";
import { clip, isObject, shortType, stripSlices, stripVersion } from "./common.js";

type R = Record<string, any>;

const SKELETON_TOKEN = /^<[^<>]*>$/;
const BASE_SD = "http://hl7.org/fhir/StructureDefinition/";
const PRIMITIVES = new Set([
  "boolean", "integer", "string", "decimal", "uri", "url", "canonical", "base64Binary", "instant", "date", "dateTime", "time",
  "code", "oid", "id", "markdown", "unsignedInt", "positiveInt", "uuid", "xhtml", "integer64",
]);
/** Datatypes whose primitive children form one value (their placeholders are one item). */
const VALUE_TYPES = new Set([
  "Coding", "Identifier", "Quantity", "SimpleQuantity", "Age", "Duration", "Distance", "Count", "MoneyQuantity", "Money",
  "ContactPoint", "Period", "HumanName", "Address", "Range", "Ratio", "Attachment", "Annotation",
]);
/** Leaf content of a datatype a rule requires (merged under its fixed / required children). */
const LEAF_SHAPES: Record<string, R> = {
  Quantity: { value: "<record>", unit: "<record>" },
  SimpleQuantity: { value: "<record>", unit: "<record>" },
  Age: { value: "<record>", unit: "<record>" },
  Duration: { value: "<record>", unit: "<record>" },
  Distance: { value: "<record>", unit: "<record>" },
  Count: { value: "<record>" },
  Period: { start: "<record>" },
  CodeableConcept: { text: "<record>" },
  Coding: { system: "<system>", code: "<code>" },
  Identifier: { system: "<system>", value: "<record>" },
  HumanName: { text: "<record>" },
  Address: { text: "<record>" },
  ContactPoint: { system: "<code>", value: "<record>" },
  Annotation: { text: "<record>" },
};
const MAX_PASSES = 3;
const FUNCS = new Set(["where", "exists", "all", "ofType", "matches", "first", "empty", "not", "toString", "count", "and", "or", "implies", "true", "false", "resolve", "is", "as"]);

export interface RuleRef {
  key: string;
  human: string;
}
export interface ChooseOne {
  rule: RuleRef;
  options: Array<{ path: string; what: string; chosen?: boolean }>;
  note: string;
}
export interface RequiredIf {
  rule: RuleRef;
  /** The condition, as text. */
  condition: string;
  /** FHIRPath that is true when the element is required, evaluated on `context` (a JSON Pointer of the form: "" = the Bundle, /entry/<i>/resource). */
  when: { expression: string; context: string; depends_on: string[] };
  /** JSON Pointer of the element the rule added: delete it when `when` is false. */
  element: string;
}

export interface RuleTarget {
  /** JSON Pointer of the resource in the form (`/entry/<i>/resource`). */
  root: string;
  rt: string;
  resource: R;
  /** Snapshot elements of the entry's profile. */
  els: R[];
  /** Constraint keys another layer already places (skeleton conditional rows). */
  skip: Set<string>;
}

export interface RuleDeps {
  /** A core datatype's StructureDefinition (`http://hl7.org/fhir/StructureDefinition/<type>`). */
  sd(url: string): Promise<R | null>;
  /** Codes of a small ValueSet (null when large / not held). */
  codes?(vs: string): Promise<Array<{ system?: string; code: string; display?: string }> | null>;
}

export interface RuleResult {
  /** Items the form emits before the skeleton's own (by target root). */
  extra: Map<string, SkeletonItem[]>;
  chooseOne: Map<string, ChooseOne>;
  requiredIf: Map<string, RequiredIf>;
  formats: Map<string, { format: string; rule: RuleRef }>;
  /** Raw rules (`key: human`) by placeholder pointer: expressions not parsed confidently. */
  rawRules: Map<string, string[]>;
  notes: string[];
  /** Constraint keys handled, by shape (summary / tests). */
  handled: Array<{ key: string; shape: "choose-one" | "required-if" | "required" | "format" | "raw" }>;
}

// --------------------------------------------------------------------------- //
// Expression parsing                                                           //
// --------------------------------------------------------------------------- //

type Step = { kind: "name"; name: string } | { kind: "ofType"; type: string } | { kind: "where"; pred: string } | { kind: "first" };
interface Chain {
  steps: Step[];
  terminal: { kind: "exists" } | { kind: "all"; inner: string } | { kind: "matches"; re: string } | { kind: "none" };
}
type Term =
  | { kind: "exists"; steps: Step[]; text: string }
  | { kind: "format"; steps: Step[]; leaf: string[]; re: string; text: string }
  | { kind: "allExists"; steps: Step[]; whereCond: string | null; inner: Step[]; text: string };

/** Top-level `.`-separated segments (parentheses / quotes respected). */
function dotSegments(expr: string): string[] | null {
  const out: string[] = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === "'" || ch === "`") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "." && depth === 0) {
      out.push(expr.slice(start, i).trim());
      start = i + 1;
    }
  }
  if (depth !== 0 || quote) return null;
  out.push(expr.slice(start).trim());
  return out;
}

function unquote(s: string): string | null {
  const m = /^'((?:[^'\\]|\\.)*)'$/.exec(s.trim());
  return m ? m[1].replace(/\\\\/g, "\\").replace(/\\'/g, "'") : null;
}

export function parseChain(expr: string): Chain | null {
  const segs = dotSegments(unwrap(expr));
  if (!segs || !segs.length) return null;
  const steps: Step[] = [];
  let terminal: Chain["terminal"] = { kind: "none" };
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const last = i === segs.length - 1;
    if (/^\$this$/.test(s) && i === 0) continue;
    if (/^[A-Za-z][A-Za-z0-9]*$/.test(s) && !FUNCS.has(s)) {
      steps.push({ kind: "name", name: s });
      continue;
    }
    const f = /^([A-Za-z]+)\(([\s\S]*)\)$/.exec(s);
    if (!f) return null;
    const [, fn, arg] = f;
    if (fn === "ofType" && /^[A-Za-z]+$/.test(arg.trim())) steps.push({ kind: "ofType", type: arg.trim() });
    else if (fn === "where" && arg.trim()) steps.push({ kind: "where", pred: arg.trim() });
    else if (fn === "first" && !arg.trim()) steps.push({ kind: "first" });
    else if (last && fn === "exists" && !arg.trim()) terminal = { kind: "exists" };
    else if (last && fn === "all" && arg.trim()) terminal = { kind: "all", inner: arg.trim() };
    else if (last && fn === "matches" && unquote(arg) !== null) terminal = { kind: "matches", re: unquote(arg)! };
    else return null;
  }
  return { steps, terminal };
}

/** One requirement term (an exists / format / all(exists) test), or null. */
export function parseTerm(text: string): Term | null {
  const t = unwrap(text);
  // `x.exists(cond)` -> `x.where(cond).exists()`
  const ex = /^([\s\S]+)\.exists\(([\s\S]+)\)$/.exec(t);
  const c = ex && dotSegments(ex[1]) ? parseChain(`${ex[1]}.where(${ex[2]}).exists()`) : parseChain(t);
  if (!c || !c.steps.some((s) => s.kind === "name")) return null;
  if (c.terminal.kind === "exists") return { kind: "exists", steps: c.steps, text: t };
  if (c.terminal.kind === "matches") {
    const names = c.steps;
    return { kind: "format", steps: names, leaf: [], re: c.terminal.re, text: t };
  }
  if (c.terminal.kind === "all") {
    const inner = unwrap(c.terminal.inner);
    const m = /^(?:([\s\S]+)\.)?(?:toString\(\)\.)?matches\(('(?:[^'\\]|\\.)*')\)$/.exec(inner);
    if (m) {
      const leaf = m[1] && !/^toString\(\)$/.test(m[1]) ? parseChain(m[1]) : null;
      if (m[1] && !/^toString\(\)$/.test(m[1]) && (!leaf || leaf.terminal.kind !== "none" || leaf.steps.some((s) => s.kind !== "name"))) return null;
      return { kind: "format", steps: c.steps, leaf: leaf ? leaf.steps.map((s) => (s as { name: string }).name) : [], re: unquote(m[2])!, text: t };
    }
    const ic = parseChain(inner);
    if (ic && ic.terminal.kind === "exists" && ic.steps.length && ic.steps.every((s) => s.kind !== "first")) {
      const lastWhere = c.steps.length && c.steps[c.steps.length - 1].kind === "where" ? (c.steps[c.steps.length - 1] as { pred: string }).pred : null;
      return { kind: "allExists", steps: c.steps, whereCond: lastWhere, inner: ic.steps, text: t };
    }
  }
  return null;
}

function parseConj(text: string): Term[] | null {
  const parts = splitTop(unwrap(text), "and");
  const out: Term[] = [];
  for (const p of parts) {
    const t = parseTerm(p);
    if (!t) return null;
    out.push(t);
  }
  return out.length ? out : null;
}

function chainText(steps: Step[]): string {
  return steps.map((s) => (s.kind === "name" ? s.name : s.kind === "ofType" ? `ofType(${s.type})` : s.kind === "where" ? `where(${s.pred})` : "first()")).join(".");
}

/** Identifiers an expression navigates (string literals removed). */
function identifiers(expr: string): Set<string> {
  const bare = expr.replace(/'(?:[^'\\]|\\.)*'/g, "''");
  return new Set((bare.match(/[A-Za-z_][A-Za-z0-9_]*/g) || []).filter((x) => !FUNCS.has(x)));
}

// --------------------------------------------------------------------------- //
// JSON helpers                                                                 //
// --------------------------------------------------------------------------- //

function esc(seg: string): string {
  return seg.replace(/~/g, "~0").replace(/\//g, "~1");
}
function segsOf(ptr: string): string[] {
  return ptr === "" ? [] : ptr.slice(1).split("/").map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
}
function getAt(root: unknown, ptr: string): unknown {
  let cur: unknown = root;
  for (const s of segsOf(ptr)) {
    if (Array.isArray(cur)) cur = cur[Number(s)];
    else if (isObject(cur)) cur = cur[s];
    else return undefined;
  }
  return cur;
}
function tokenLeaves(node: unknown, sub = ""): string[] {
  if (typeof node === "string") return SKELETON_TOKEN.test(node) ? [sub] : [];
  if (Array.isArray(node)) return node.flatMap((x, i) => tokenLeaves(x, `${sub}/${i}`));
  if (isObject(node)) return Object.entries(node).flatMap(([k, v]) => tokenLeaves(v, `${sub}/${esc(k)}`));
  return [];
}
function onlyTokens(node: unknown): boolean {
  if (typeof node === "string") return SKELETON_TOKEN.test(node);
  if (Array.isArray(node)) return node.every(onlyTokens);
  if (isObject(node)) return Object.values(node).every(onlyTokens);
  return false;
}
function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const maxNum = (m: unknown): number => (m === "*" || m === undefined || m === null ? Infinity : Number(m));
const choiceStem = (k: string): string => /^([a-z][a-z0-9]*?)[A-Z]\w*$/.exec(k)?.[1] ?? k;
function fixedOrPattern(el: R | undefined): unknown {
  if (!el) return undefined;
  for (const [k, v] of Object.entries(el)) if ((k.startsWith("fixed") || k.startsWith("pattern")) && k.length > 5 && k !== "pattern") return v;
  return undefined;
}

// --------------------------------------------------------------------------- //
// Engine                                                                       //
// --------------------------------------------------------------------------- //

interface Meta {
  id: string;
  type: string;
  binding: string | null;
  bindingStrength: string | null;
}

interface Ctx {
  target: RuleTarget;
  byId: Map<string, R>;
}

interface Child {
  key: string;
  id: string;
  type: string;
  isArray: boolean;
  el: R | null;
}

export async function applyProfileRules(targets: RuleTarget[], bundle: { resource: R; els: R[] }, deps: RuleDeps): Promise<RuleResult> {
  const res: RuleResult = { extra: new Map(), chooseOne: new Map(), requiredIf: new Map(), formats: new Map(), rawRules: new Map(), notes: [], handled: [] };
  const ctxs = new Map<string, Ctx>(targets.map((t) => [t.root, { target: t, byId: new Map(t.els.map((e) => [String(e.id), e])) }]));
  const dtCache = new Map<string, R | null>();
  const dtEl = async (type: string, name: string): Promise<R | null> => {
    const k = `${type}.${name}`;
    if (!dtCache.has(k)) {
      const dsd = await deps.sd(`${BASE_SD}${type}`).catch(() => null);
      const els = ((dsd?.snapshot?.element || []) as R[]);
      dtCache.set(k, els.find((e) => e.id === k) ?? els.find((e) => e.id === `${k}[x]`) ?? null);
    }
    return dtCache.get(k) ?? null;
  };
  const typeOf = (el: R | null, pick: string | null): string => {
    const types = ((el?.type || []) as R[]).map((t) => String(t.code ?? ""));
    const code = pick && types.some((t) => shortType(t).toLowerCase() === pick.toLowerCase()) ? types.find((t) => shortType(t).toLowerCase() === pick.toLowerCase())! : types[0] ?? "string";
    return code.startsWith("http://hl7.org/fhirpath/System.") ? "string" : shortType(code);
  };

  /** The child `name` of a node of element `id` / type `type` (profile snapshot first, else the core datatype). */
  const childOf = async (ctx: Ctx, id: string, type: string, node: R, name: string, ofType: string | null): Promise<Child | null> => {
    let el = ctx.byId.get(`${id}.${name}`) ?? null;
    let choice = false;
    if (!el) {
      el = ctx.byId.get(`${id}.${name}[x]`) ?? null;
      choice = Boolean(el);
    }
    let cid = el ? String(el.id) : `${id}.${name}`;
    if (!el) {
      el = await dtEl(type, name);
      choice = Boolean(el && String(el.id).endsWith("[x]"));
      if (choice) cid = `${id}.${name}[x]`;
    }
    if (!el || el.max === "0") return null;
    if (!choice) {
      if (ofType && typeOf(el, ofType).toLowerCase() !== ofType.toLowerCase() && !(el.type || []).some((t: R) => shortType(String(t.code)) === ofType)) return null;
      return { key: name, id: cid, type: ofType ?? typeOf(el, null), isArray: maxNum(el.base?.max ?? el.max) > 1, el };
    }
    const present = Object.keys(node).find((k) => k.startsWith(name) && /^[A-Z]/.test(k.slice(name.length)));
    const t = ofType ? typeOf(el, ofType) : present ? typeOf(el, present.slice(name.length)) : typeOf(el, null);
    if (ofType && !(el.type || []).some((x: R) => shortType(String(x.code)).toLowerCase() === ofType.toLowerCase())) return null;
    const key = `${name}${cap(t)}`;
    const sliceId = `${cid}:${key}`;
    return { key, id: ctx.byId.has(sliceId) ? sliceId : cid, type: t, isArray: false, el: ctx.byId.get(sliceId) ?? el };
  };

  const bindingOf = (el: R | null): { vs: string | null; strength: string | null } => {
    const b = el?.binding;
    return b && typeof b.valueSet === "string" ? { vs: stripVersion(b.valueSet), strength: String(b.strength ?? "") } : { vs: null, strength: null };
  };

  /** A new node for element `id` of `type`: pattern / fixed values, required + fixed children; `leaf` adds the datatype's value shape. */
  const buildNode = async (ctx: Ctx, id: string, type: string, el: R | null, leaf: boolean, meta: Map<string, Meta>, ptr: string, depth = 0): Promise<unknown> => {
    const b = bindingOf(el);
    meta.set(ptr, { id, type, binding: b.vs, bindingStrength: b.strength });
    const own = fixedOrPattern(el ?? undefined);
    if (PRIMITIVES.has(type)) return own !== undefined ? own : type === "code" ? "<code>" : "<record>";
    const node: R = isObject(own) ? clone(own) : {};
    if (depth < 4) {
      for (const [cid, c] of ctx.byId) {
        if (!cid.startsWith(`${id}.`)) continue;
        const rest = cid.slice(id.length + 1);
        if (rest.includes(".") || rest.includes(":") || c.max === "0" || ["id", "extension", "modifierExtension"].includes(rest)) continue;
        const v = fixedOrPattern(c);
        const key = rest.endsWith("[x]") ? null : rest;
        if (!key) continue;
        if (v !== undefined && node[key] === undefined) {
          node[key] = maxNum(c.base?.max ?? c.max) > 1 && !Array.isArray(v) ? [clone(v)] : clone(v);
          continue;
        }
        if ((c.min ?? 0) >= 1 && node[key] === undefined) {
          const ct = typeOf(c, null);
          const isArr = maxNum(c.base?.max ?? c.max) > 1;
          const cptr = `${ptr}/${esc(key)}${isArr ? "/0" : ""}`;
          const v2 = await buildNode(ctx, cid, ct, c, true, meta, cptr, depth + 1);
          node[key] = isArr ? [v2] : v2;
        }
      }
    }
    if (leaf || type === "Coding") {
      let shape = LEAF_SHAPES[type];
      if (type === "CodeableConcept") shape = Object.keys(node).length ? {} : b.strength === "required" ? { coding: [{ system: "<system>", code: "<code>" }] } : shape;
      if (type === "Coding" && !leaf) shape = { system: "<system>" };
      for (const [k, v] of Object.entries(shape || {})) {
        if (node[k] !== undefined) continue;
        node[k] = clone(v);
        const kp = `${ptr}/${esc(k)}`;
        if (k === "coding") meta.set(`${kp}/0`, { id: `${id}.coding`, type: "Coding", binding: b.vs, bindingStrength: b.strength });
      }
    }
    return node;
  };

  /** Slices of element `id` (direct), with their template (pattern / fixed / required children + value shape). */
  const slicesOf = async (ctx: Ctx, id: string, type: string): Promise<Array<{ id: string; name: string; el: R; template: R; meta: Map<string, Meta>; ms: boolean }>> => {
    const out: Array<{ id: string; name: string; el: R; template: R; meta: Map<string, Meta>; ms: boolean }> = [];
    for (const [sid, el] of ctx.byId) {
      const m = sid.startsWith(`${id}:`) ? /^([^.:]+)$/.exec(sid.slice(id.length + 1)) : null;
      if (!m || el.max === "0") continue;
      const meta = new Map<string, Meta>();
      const t = await buildNode(ctx, sid, type, el, true, meta, "");
      if (!isObject(t)) continue;
      out.push({ id: sid, name: m[1], el, template: t, meta, ms: Boolean(el.mustSupport) });
    }
    return out;
  };

  const holds = (node: unknown, base: string, expr: string, env: R): boolean => evaluateConstraint(node, base, expr, { resource: env, rootResource: env }).status === "pass";

  /** Build a node satisfying `pred` from its equalities (`k = 'v'`, `k.where(p).exists()`), or null. */
  const solvePred = (pred: string): R | null => {
    const node: R = {};
    for (const part of splitTop(unwrap(pred), "and")) {
      const eq = /^([a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)*)\s*=\s*('(?:[^'\\]|\\.)*')$/.exec(unwrap(part));
      if (!eq) return null;
      const path = eq[1].split(".");
      let cur = node;
      for (const k of path.slice(0, -1)) cur = isObject(cur[k]) ? cur[k] : (cur[k] = {});
      cur[path[path.length - 1]] = unquote(eq[2]);
    }
    return node;
  };

  interface Placed {
    /** Pointers (relative to the resource) of the nodes created. */
    created: string[];
    meta: Map<string, Meta>;
    choose: { at: string; options: Array<{ path: string; what: string }> } | null;
  }

  /** Materialise `steps` (+ an exists() terminal) in `resource` (in place); null when a step does not resolve. */
  const place = async (ctx: Ctx, resource: R, steps: Step[]): Promise<Placed | null> => {
    const created: string[] = [];
    const meta = new Map<string, Meta>();
    let choose: Placed["choose"] = null;
    let node: R = resource;
    let id = ctx.target.rt;
    let type = ctx.target.rt;
    let ptr = "";
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      if (s.kind === "first") continue;
      if (s.kind !== "name") return null;
      let j = i + 1;
      const ofType = steps[j]?.kind === "ofType" ? (steps[j++] as { type: string }).type : null;
      const where = steps[j]?.kind === "where" ? (steps[j++] as { pred: string }).pred : null;
      i = j - 1;
      const lastName = !steps.slice(j).some((x) => x.kind === "name");
      const ch = await childOf(ctx, id, type, node, s.name, ofType);
      if (!ch) return null;
      const cur = node[ch.key];
      const base = fhirPathBase(stripSlices(ch.id), ch.type);
      if (where) {
        const list: unknown[] = Array.isArray(cur) ? cur : cur !== undefined ? [cur] : [];
        let idx = list.findIndex((x) => isObject(x) && holds(x, base, where, resource));
        let item: R | null = idx >= 0 ? (list[idx] as R) : null;
        let itemId = ch.id;
        let pickMeta = new Map<string, Meta>();
        if (!item) {
          const fits = (await slicesOf(ctx, ch.id, ch.type)).filter((sl) => holds(sl.template, base, where, resource));
          if (fits.length) {
            const pick = fits.find((f) => f.ms) ?? fits[0];
            item = pick.template;
            itemId = pick.id;
            if (fits.length > 1) choose = { at: "", options: fits.map((f) => ({ path: f.id, what: describe(f.template) })) };
            pickMeta = pick.meta;
          } else {
            const solved = solvePred(where);
            if (!solved || !holds(solved, base, where, resource)) return null;
            const m2 = new Map<string, Meta>();
            const built = await buildNode(ctx, ch.id, ch.type, ch.el, lastName, m2, "");
            item = isObject(built) ? { ...solved, ...built, ...solved } : solved;
            pickMeta = m2;
          }
          if (ch.isArray) {
            const arr: unknown[] = Array.isArray(cur) ? cur : [];
            const reuse = arr.findIndex((x) => onlyTokens(x));
            idx = reuse >= 0 ? reuse : arr.length;
            arr[idx] = item;
            node[ch.key] = arr;
          } else {
            if (cur !== undefined) return null;
            node[ch.key] = item;
            idx = 0;
          }
          const ip = ch.isArray ? `${ptr}/${esc(ch.key)}/${idx}` : `${ptr}/${esc(ch.key)}`;
          created.push(ip);
          if (choose && !choose.at) choose.at = ip;
          for (const [k, v] of pickMeta) meta.set(`${ip}${k}`, v);
          meta.set(ip, { ...(meta.get(ip) ?? { binding: null, bindingStrength: null }), id: itemId, type: ch.type });
        }
        ptr = ch.isArray ? `${ptr}/${esc(ch.key)}/${idx}` : `${ptr}/${esc(ch.key)}`;
        node = item;
        id = itemId;
        type = ch.type;
        continue;
      }
      const cp = `${ptr}/${esc(ch.key)}${ch.isArray ? "/0" : ""}`;
      if (cur === undefined || (Array.isArray(cur) && !cur.length)) {
        const v = await buildNode(ctx, ch.id, ch.type, ch.el, lastName, meta, cp);
        node[ch.key] = ch.isArray ? [v] : v;
        created.push(`${ptr}/${esc(ch.key)}`);
      }
      const nxt = ch.isArray ? (node[ch.key] as unknown[])[0] : node[ch.key];
      if (lastName) {
        ptr = cp;
        break;
      }
      if (!isObject(nxt)) return null;
      node = nxt;
      ptr = cp;
      id = ch.id;
      type = ch.type;
    }
    return { created, meta, choose };
  };

  /** Pointers (relative) of the nodes `steps` select in `resource`. */
  const select = async (ctx: Ctx, resource: R, steps: Step[], leaf: string[]): Promise<string[]> => {
    let cur: Array<{ node: unknown; ptr: string; id: string; type: string }> = [{ node: resource, ptr: "", id: ctx.target.rt, type: ctx.target.rt }];
    const all = [...steps, ...leaf.map((name): Step => ({ kind: "name", name }))];
    for (let i = 0; i < all.length; i++) {
      const s = all[i];
      if (s.kind === "first") {
        cur = cur.slice(0, 1);
        continue;
      }
      if (s.kind !== "name") return [];
      const ofType = all[i + 1]?.kind === "ofType" ? (all[++i] as { type: string }).type : null;
      const where = all[i + 1]?.kind === "where" ? (all[++i] as { pred: string }).pred : null;
      const next: typeof cur = [];
      for (const c of cur) {
        if (!isObject(c.node)) continue;
        // a key the form holds although no definition is at hand (a datatype SD not installed): read-only use
        const ch = (await childOf(ctxs.get(ctx.target.root)!, c.id, c.type, c.node, s.name, ofType)) ?? (!ofType && s.name in c.node ? { key: s.name, id: `${c.id}.${s.name}`, type: "string", isArray: Array.isArray(c.node[s.name]), el: null } : null);
        if (!ch) continue;
        const v = c.node[ch.key];
        const list: unknown[] = Array.isArray(v) ? v : v === undefined ? [] : [v];
        list.forEach((x, k) => {
          const p = Array.isArray(v) ? `${c.ptr}/${esc(ch.key)}/${k}` : `${c.ptr}/${esc(ch.key)}`;
          if (where && !(isObject(x) && holds(x, fhirPathBase(stripSlices(ch.id), ch.type), where, resource))) return;
          next.push({ node: x, ptr: p, id: ch.id, type: ch.type });
        });
      }
      cur = next;
    }
    return cur.map((c) => c.ptr);
  };

  /** Token leaves (relative pointers) of `resource` the expression reads (every navigated segment named in it). */
  const dependsOn = (expr: string, rt: string, resource: R, bundleLevel: boolean): string[] => {
    const ids = identifiers(expr);
    if (bundleLevel) {
      const types = [...expr.matchAll(/ofType\(([A-Z][A-Za-z]+)\)/g)].map((m) => m[1]);
      if (!ids.has("entry") || !ids.has("resource") || (types.length && !types.includes(rt))) return [];
    }
    return tokenLeaves(resource).filter((p) => {
      const segs = segsOf(p).filter((x) => !/^\d+$/.test(x));
      return segs.length > 0 && segs.every((x) => ids.has(x) || ids.has(choiceStem(x)));
    });
  };

  const addItems = async (ctx: Ctx, placed: Placed, how: string): Promise<void> => {
    const resource = ctx.target.resource;
    const items = res.extra.get(ctx.target.root) ?? [];
    const seen = new Set(items.map((i) => i.pointer));
    for (const root of placed.created) {
      for (const sub of tokenLeaves(getAt(resource, root))) {
        const leaf = `${root}${sub}`;
        const segs = segsOf(leaf);
        // the value node: the leaf's parent when that is a one-value datatype (Coding, Quantity, Identifier …)
        let at = leaf;
        const parent = `/${segs.slice(0, -1).map(esc).join("/")}`;
        const parentNoIdx = /\/\d+$/.test(leaf) ? `/${segs.slice(0, -2).map(esc).join("/")}` : parent;
        const pm = placed.meta.get(/\/\d+$/.test(leaf) ? parentNoIdx : parent);
        if (pm && VALUE_TYPES.has(pm.type) && !/\/\d+$/.test(leaf)) at = parent;
        if (seen.has(at)) continue;
        seen.add(at);
        const m = placed.meta.get(at) ?? placed.meta.get(at.replace(/\/\d+$/, ""));
        const segsAt = segsOf(at).filter((x) => !/^\d+$/.test(x));
        const id = m?.id ?? `${ctx.target.rt}.${segsAt.join(".")}`;
        const type = m?.type ?? "string";
        const binding = m?.binding ?? (pm && at === parent ? pm.binding : null);
        // a coded value whose ValueSet is small: its codes (of the system the element fixes, when it does)
        let codes: SkeletonItem["codes"];
        const node = getAt(resource, at);
        if (binding && deps.codes && (type === "Coding" || type === "code")) {
          const fixedSystem = isObject(node) && typeof node.system === "string" && !SKELETON_TOKEN.test(node.system) ? node.system : null;
          const cs = (await deps.codes(binding).catch(() => null))?.filter((c) => !fixedSystem || c.system === fixedSystem);
          if (cs?.length) codes = cs.map((c) => ({ code: c.code, display: c.display ?? null, system: c.system ?? null }));
        }
        items.push({
          id,
          path: id.startsWith(`${ctx.target.rt}.`) ? id.slice(ctx.target.rt.length + 1) : id,
          source: binding && (m?.bindingStrength === "required" || pm?.bindingStrength === "required") ? "code-lookup" : "record",
          how: clip(how, 160),
          pointer: at,
          types: [type],
          ...(binding ? { valueSet: binding } : {}),
          ...(codes ? { codes } : {}),
        });
      }
    }
    res.extra.set(ctx.target.root, items);
  };

  const ruleOf = (c: R): RuleRef => ({ key: String(c.key), human: clip(String(c.human ?? c.expression ?? ""), 200) });

  const addRaw = (root: string, ptrs: string[], rule: RuleRef): void => {
    const txt = `${rule.key}: ${clip(rule.human, 160)}`;
    for (const p of ptrs) {
      const full = `${root}${p}`;
      const list = res.rawRules.get(full) ?? [];
      if (!list.includes(txt)) list.push(txt);
      res.rawRules.set(full, list);
    }
    if (!res.handled.some((h) => h.key === rule.key)) res.handled.push({ key: rule.key, shape: "raw" });
  };

  const attachFormat = async (ctx: Ctx, term: Extract<Term, { kind: "format" }>, rule: RuleRef): Promise<void> => {
    for (const p of await select(ctx, ctx.target.resource, term.steps, term.leaf)) {
      const v = getAt(ctx.target.resource, p);
      if (typeof v !== "string" || !SKELETON_TOKEN.test(v)) continue;
      const full = `${ctx.target.root}${p}`;
      if (!res.formats.has(full)) res.formats.set(full, { format: term.re, rule });
      if (!res.handled.some((h) => h.key === rule.key && h.shape === "format")) res.handled.push({ key: rule.key, shape: "format" });
    }
  };

  /**
   * Place the exists() terms of a requirement in `ctx` (on a clone, kept only when all resolve).
   * `cond` = null -> required; else required_if.
   */
  const require = async (ctx: Ctx, terms: Term[], rule: RuleRef, cond: { expression: string; text: string; context: string; depends: string[] } | null, chooseNote?: ChooseOne): Promise<boolean> => {
    const resource = ctx.target.resource;
    const work = clone(resource);
    const placed: Placed[] = [];
    for (const t of terms) {
      if (t.kind === "format") continue;
      if (t.kind === "allExists") return false;
      if (holds(work, ctx.target.rt, `${chainText(t.steps)}.exists()`, work)) continue;
      const p = await place(ctx, work, t.steps);
      if (!p) return false;
      placed.push(p);
    }
    if (!placed.length) {
      for (const t of terms) if (t.kind === "format") await attachFormat(ctx, t, rule);
      return true;
    }
    for (const k of Object.keys(resource)) delete resource[k];
    Object.assign(resource, work);
    const how = cond ? `required when ${cond.text} (rule ${rule.key}: ${rule.human})` : `required by rule ${rule.key}: ${rule.human}`;
    for (const p of placed) {
      await addItems(ctx, p, how);
      if (cond) {
        // the outermost nodes the rule added (deleting one removes what it holds)
        for (const c of p.created.filter((x) => !p.created.some((y) => y !== x && x.startsWith(`${y}/`)))) {
          const full = `${ctx.target.root}${c}`;
          res.requiredIf.set(full, { rule, condition: cond.text, when: { expression: cond.expression, context: cond.context, depends_on: cond.depends }, element: full });
        }
      }
      if (p.choose) {
        res.chooseOne.set(`${ctx.target.root}${p.choose.at}`, {
          rule,
          options: p.choose.options.map((o) => (o.path === getMetaId(p, p.choose!.at) ? { ...o, chosen: true } : o)),
          note: `the rule needs ONE of the options: the form holds the chosen one at this element — to use another, replace the element with that option's values (and fill its value); never several`,
        });
      }
      if (chooseNote) {
        for (const c of p.created) res.chooseOne.set(`${ctx.target.root}${c}`, chooseNote);
      }
    }
    for (const t of terms) if (t.kind === "format") await attachFormat(ctx, t, rule);
    const shape = chooseNote || placed.some((p) => p.choose) ? "choose-one" : cond ? "required-if" : "required";
    if (!res.handled.some((h) => h.key === rule.key && h.shape === shape)) res.handled.push({ key: rule.key, shape });
    placedNow = true;
    return true;
  };
  /** Rules that placed elements (per context): later passes leave them alone (their own placeholders now satisfy them). */
  const done = new Set<string>();
  let placedNow = false;
  const getMetaId = (p: Placed, at: string): string => p.meta.get(at)?.id ?? "";

  // --- one constraint on one context ----------------------------------------------------------
  const handle = async (c: R, ctx: Ctx | null, bundleLevel: boolean): Promise<void> => {
    const expr = String(c.expression ?? "").replace(/\s+/g, " ").trim();
    const rule = ruleOf(c);
    const root = bundleLevel ? "" : ctx!.target.root;
    const node = bundleLevel ? bundle.resource : ctx!.target.resource;
    const rt = bundleLevel ? "Bundle" : ctx!.target.rt;
    const doneKey = `${bundleLevel ? "#bundle" : root}|${rule.key}`;
    if (done.has(doneKey)) return;
    placedNow = false;
    try {
      await handleIn();
    } finally {
      if (placedNow) done.add(doneKey);
    }
    async function handleIn(): Promise<void> {
      const deps0 = (e: string): Array<{ root: string; ptr: string }> =>
        bundleLevel
          ? targets.flatMap((t) => dependsOn(e, t.rt, t.resource, true).map((ptr) => ({ root: t.root, ptr })))
          : dependsOn(e, rt, node, false).map((ptr) => ({ root, ptr }));
      const passes = holds(node, rt, expr, node);
      const allDeps = deps0(expr);
      if (passes && !allDeps.length) return;

      /** Requirement terms of the Bundle are placed in the entries they name (`entry.resource.ofType(X).…`). */
      const placeIn = async (terms: Term[], cond: { expression: string; text: string; depends: Array<{ root: string; ptr: string }> } | null, choose?: ChooseOne): Promise<boolean> => {
        const condCtx = cond ? { expression: cond.expression, text: cond.text, context: bundleLevel ? "" : root, depends: cond.depends.map((d) => `${d.root}${d.ptr}`) } : null;
        if (!bundleLevel) return require(ctx!, terms, rule, condCtx, choose);
        const byTarget = new Map<string, Term[]>();
        for (const t of terms) {
          const s = t.steps;
          if (!(s[0]?.kind === "name" && s[0].name === "entry" && s[1]?.kind === "name" && s[1].name === "resource" && s[2]?.kind === "ofType")) return false;
          const want = s[2].type;
          const hits = targets.filter((x) => x.rt === want);
          if (!hits.length) return false;
          for (const h of hits) byTarget.set(h.root, [...(byTarget.get(h.root) ?? []), { ...t, steps: s.slice(3) } as Term]);
        }
        let ok = true;
        for (const [r, ts] of byTarget) ok = (await require(ctxs.get(r)!, ts, rule, condCtx, choose)) && ok;
        return ok;
      };
      const condText = (e: string, negate: boolean, depends: Array<{ root: string; ptr: string }>): string =>
        `${negate ? "NOT " : ""}${clip(e, 110)}${depends.length ? " (the value of the placeholder(s) in `when.depends_on`)" : ""}`;
      const rawAt = (ds: Array<{ root: string; ptr: string }>): void => {
        if (ds.length) for (const d of ds) addRaw(d.root, [d.ptr], rule);
        else if (!passes) res.notes.push(`rule ${rule.key} (${clip(rule.human, 80)}) not parsed: check it when filling`);
      };

      // implies
      const imp = splitTop(unwrap(expr), "implies");
      if (imp.length === 2) {
        const terms = parseConj(imp[1]);
        if (!terms || terms.some((t) => t.kind === "allExists")) return rawAt(deps0(imp[0]).length ? deps0(imp[0]) : allDeps);
        const d = deps0(imp[0]);
        if (d.length) {
          if (!(await placeIn(terms, { expression: imp[0], text: condText(imp[0], false, d), depends: d }))) rawAt(d);
          return;
        }
        if (!holds(node, rt, imp[0], node)) return;
        if (!(await placeIn(terms, null))) rawAt(allDeps);
        return;
      }
      // or
      const ors = splitTop(unwrap(expr), "or");
      if (ors.length >= 2) {
        const parsed = ors.map((o) => ({ text: o, terms: parseConj(o) }));
        // a disjunct that tests what the form already holds (or that is not a requirement) is a condition
        const isCond = (p: (typeof parsed)[number]): boolean => {
          if (!p.terms) return true;
          if (deps0(p.text).length) return true;
          // a disjunct of tests only (no exists() term to place) is a condition too
          return !p.terms.some((t) => t.kind === "exists");
        };
        const conds = parsed.filter(isCond);
        const reqs = parsed.filter((p) => !isCond(p));
        if (!conds.length && reqs.length >= 2) {
          if (passes) return;
          const options = reqs.map((r) => ({ path: chainText((r.terms![0] as { steps: Step[] }).steps), what: clip(r.text, 120) }));
          for (let i = 0; i < reqs.length; i++) {
            const note: ChooseOne = {
              rule,
              options: options.map((o, k) => (k === i ? { ...o, chosen: true } : o)),
              note: "the rule needs ONE of the options: the form holds the chosen one — to use another, delete this element and add that option instead; never several",
            };
            if (await placeIn(reqs[i].terms!, null, note)) return;
          }
          return rawAt(allDeps);
        }
        if (reqs.length === 1 && conds.length) {
          const ce = conds.map((x) => x.text).join(" or ");
          const d = deps0(ce);
          const when = `(${ce}).not()`;
          if (d.length) {
            if (!(await placeIn(reqs[0].terms!, { expression: when, text: condText(ce, true, d), depends: d }))) rawAt(d);
            return;
          }
          if (passes || holds(node, rt, ce, node)) return;
          if (!(await placeIn(reqs[0].terms!, null))) rawAt(allDeps);
          return;
        }
        return rawAt(allDeps);
      }
      // a conjunction of terms
      const terms = parseConj(expr);
      if (!terms) return rawAt(allDeps);
      for (const t of terms) {
        if (t.kind === "format") {
          if (bundleLevel) continue;
          await attachFormat(ctx!, t, rule);
        } else if (t.kind === "allExists") {
          // X.where(C).all(Y.exists()): Y required on the X items C selects
          const steps = t.steps;
          const prefix = t.whereCond ? steps.slice(0, -1) : steps;
          const condE = t.whereCond ? `${chainText(steps)}.exists()` : null;
          const req: Term = { kind: "exists", steps: [...prefix, ...t.inner], text: t.text };
          const d = condE ? deps0(condE) : [];
          if (!condE) {
            if (!bundleLevel && !passes && (await select(ctx!, node, prefix, [])).length && !(await placeIn([req], null))) rawAt(allDeps);
            continue;
          }
          if (d.length) {
            if (!(await placeIn([req], { expression: condE, text: condText(condE, false, d), depends: d }))) rawAt(d);
          } else if (holds(node, rt, condE, node) && !passes) {
            if (!(await placeIn([req], null))) rawAt(allDeps);
          }
        }
      }
      const ex = terms.filter((t) => t.kind === "exists");
      if (ex.length && !passes) {
        if (!(await placeIn(ex, null))) rawAt(allDeps);
      }
    }
  };

  const constraintsOf = (els: R[], rt: string): R[] =>
    (((els.find((e) => e.id === rt) ?? els[0])?.constraint || []) as R[]).filter((c) => c.key && c.expression && (!c.severity || c.severity === "error") && !/^(ele|ext|dom|txt)-\d+$/.test(String(c.key)));

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const before = JSON.stringify(targets.map((t) => t.resource));
    for (const t of targets) for (const c of constraintsOf(t.els, t.rt)) if (!t.skip.has(String(c.key))) await handle(c, ctxs.get(t.root)!, false);
    for (const c of constraintsOf(bundle.els, "Bundle")) if (!/^bdl-\d+$/.test(String(c.key))) await handle(c, null, true);
    if (JSON.stringify(targets.map((t) => t.resource)) === before) break;
  }
  return res;
}

/** Short text of a slice template's fixed values (`type.coding.code=PPN, system=…`). */
function describe(t: R): string {
  const out: string[] = [];
  const walk = (n: unknown, path: string): void => {
    if (Array.isArray(n)) n.forEach((x) => walk(x, path));
    else if (isObject(n)) for (const [k, v] of Object.entries(n)) walk(v, path ? `${path}.${k}` : k);
    else if (!(typeof n === "string" && SKELETON_TOKEN.test(n))) out.push(`${path}=${String(n)}`);
  };
  walk(t, "");
  return clip(out.join(", "), 140);
}

export const _internal = { parseChain, parseTerm, dotSegments, identifiers };
