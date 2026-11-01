/**
 * ISSUES_v19 R3: machine-applicable addresses and fixes for validation issues.
 *
 * Every issue of fhir_validate_bundle / fhir_validate_resource gets
 *   - `pointer`: an RFC 6901 JSON Pointer into the instance EXACTLY AS THE CALLER SENT IT
 *     (`/entry/3/resource/code/coding/0/display`). The validator's dotted path
 *     (`Bundle.entry[3].resource.code.coding[0].display`, HL7 forms such as
 *     `.value.ofType(string)`, `value[x]`, `[url='…']`, `extension('…')`, `/*Type/id*\/`
 *     comments) is walked over the validated tree; when the leaf does not exist (a missing
 *     element) the pointer is the nearest existing ancestor — the object to add it to;
 *     `pointer_kind` says which ("element" | "ancestor").
 *   - `patches` (errors only): RFC 6902 JSON Patch candidates `{ops, reason, kind, confidence}`
 *     converted from the issue's `suggestions[].patch` (validator paths) plus a few
 *     deterministic shape fixes read from the message. Every candidate is applied to a deep
 *     copy of the sent instance before it is returned; one that does not apply is dropped.
 *
 * With normalize_ids=true the verdict is about `normalized_bundle`, whose entries the finalizer
 * may have reordered (document: Composition first). Entry positions are mapped back through the
 * finalizer's permutation (fhirBundleFinalize.entryOrderOf) and checked against the entry's
 * fullUrl (renamed fullUrls followed back through id_changes), so a pointer never names another
 * entry. `entries[i].pointer` is the sent position of each entry row.
 *
 * Additive and fail-open: issue set, severities, messages, `path`, `suggestions` and `valid` are
 * never changed; any error leaves the envelope (or the issue) as it was. IG-agnostic.
 */

import { entryOrderOf, type FinalizeChange } from "../fhirBundleFinalize.js";
import { cloneJson, formatPointer, jsonEqual, patchApplies, resolvePointer, type JsonPatchOp } from "../jsonPatch.js";
import { parseLossless, stringifyLossless, toPlain } from "../losslessJson.js";

type Json = Record<string, any>;
const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

/** FHIR R4 datatype suffixes of choice elements (value[x] → valueString …). */
const CHOICE_TYPES = new Set(
  (
    "Base64Binary Boolean Canonical Code Date DateTime Decimal Id Instant Integer Integer64 Markdown Oid PositiveInt String Time " +
    "UnsignedInt Uri Url Uuid Address Age Annotation Attachment CodeableConcept CodeableReference Coding ContactPoint Count Distance " +
    "Duration HumanName Identifier Money Period Quantity Range Ratio RatioRange Reference SampledData Signature Timing ContactDetail " +
    "Contributor DataRequirement Expression ParameterDefinition RelatedArtifact TriggerDefinition UsageContext Dosage Meta"
  ).split(" "),
);

// --------------------------------------------------------------------------- //
// Validator path → JSON tokens
// --------------------------------------------------------------------------- //

export interface FhirPathSegment {
  /** Element name (choice stem without `[x]`); "" for a function segment. */
  name: string;
  /** `value[x]`: the JSON property is `<name><Type>`. */
  choice: boolean;
  index: number | null;
  /** `[url='…']` qualifier (extensions). */
  url: string | null;
  /** Function segment: ofType / resolve / extension / where … */
  fn: string | null;
  arg: string | null;
}

/** Split a validator path at top-level dots (not inside [], () or quotes); `/* … *\/` comments removed. */
function splitTopLevel(path: string): string[] {
  const s = String(path || "").replace(/\/\*[\s\S]*?\*\//g, "");
  const out: string[] = [];
  let buf = "";
  let depth = 0;
  let quote: string | null = null;
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = null;
      buf += ch;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "[" || ch === "(") depth++;
    else if (ch === "]" || ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "." && depth === 0) {
      out.push(buf);
      buf = "";
    } else buf += ch;
  }
  if (buf !== "") out.push(buf);
  return out.map((x) => x.trim()).filter((x) => x !== "");
}

const unquote = (s: string): string => s.trim().replace(/^(['"])([\s\S]*)\1$/, "$2");

/** Parse a validator instance path into segments (the first one is the root's type, when present). */
export function parseFhirPath(path: string): FhirPathSegment[] {
  return splitTopLevel(path).map((raw) => {
    const fm = /^([A-Za-z_]\w*)\(([\s\S]*)\)$/.exec(raw);
    if (fm) return { name: "", choice: false, index: null, url: null, fn: fm[1], arg: fm[2] };
    const b = raw.indexOf("[");
    let name = b < 0 ? raw : raw.slice(0, b);
    const colon = name.indexOf(":");
    if (colon >= 0) name = name.slice(0, colon); // element-id slice names (component:systolic)
    let choice = false;
    let index: number | null = null;
    let url: string | null = null;
    for (const m of (b < 0 ? "" : raw.slice(b)).matchAll(/\[([^\]]*)\]/g)) {
      const q = m[1].trim();
      if (q === "x") choice = true;
      else if (/^\d+$/.test(q)) index = Number(q);
      else {
        const um = /^url\s*=\s*([\s\S]+)$/.exec(q);
        if (um) url = unquote(um[1]);
      }
    }
    return { name, choice, index, url, fn: null, arg: null };
  });
}

/** The JSON property of a choice element `stem` present on `node` (valueQuantity …), or null. */
function choiceKey(node: Json, stem: string): string | null {
  for (const k of Object.keys(node)) {
    if (k.length > stem.length && k.startsWith(stem) && CHOICE_TYPES.has(k.slice(stem.length))) return k;
  }
  return null;
}

const cap = (t: string): string => (t ? t[0].toUpperCase() + t.slice(1) : t);

export type WalkStop = "done" | "missing" | "index" | "unsupported" | "not-container";

export interface WalkResult {
  /** JSON tokens of the deepest node the path reaches in the tree. */
  tokens: string[];
  /** The whole path was resolved. */
  exact: boolean;
  stop: WalkStop;
  /** Segments not consumed (rest[0] is the one that failed). */
  rest: FhirPathSegment[];
}

/**
 * Walk a validator path over `root` (the instance it was reported on). A stand-alone resource's
 * path starts with its resourceType (`Patient.name[0]`), a Bundle's with `Bundle`; an empty path
 * is the root itself.
 */
export function walkFhirPath(root: unknown, path: string): WalkResult {
  const segs = parseFhirPath(path);
  const tokens: string[] = [];
  let node: unknown = root;
  let i = 0;
  if (segs.length && !segs[0].fn && isObj(root) && (root.resourceType === segs[0].name || !(segs[0].name in root))) i = 1;
  const stop = (why: WalkStop, at: number): WalkResult => ({ tokens, exact: false, stop: why, rest: segs.slice(at) });
  for (; i < segs.length; i++) {
    const seg = segs[i];
    if (seg.fn) {
      if (seg.fn === "ofType") continue; // a type assertion on a node already reached (ofType(Patient) on a resource)
      if (seg.fn === "extension" && isObj(node) && Array.isArray(node.extension)) {
        const url = unquote(seg.arg || "");
        const k = node.extension.findIndex((e: unknown) => isObj(e) && e.url === url);
        if (k < 0) return stop("missing", i);
        tokens.push("extension", String(k));
        node = node.extension[k];
        continue;
      }
      return stop(seg.fn === "extension" ? "missing" : "unsupported", i);
    }
    if (!isObj(node)) return stop("not-container", i);
    let key: string | null = null;
    const next = segs[i + 1];
    if (seg.choice) key = choiceKey(node, seg.name);
    else if (Object.prototype.hasOwnProperty.call(node, seg.name)) key = seg.name;
    else if (next && next.fn === "ofType" && next.arg && Object.prototype.hasOwnProperty.call(node, seg.name + cap(next.arg.trim()))) {
      key = seg.name + cap(next.arg.trim());
      i++; // the ofType segment is consumed
    } else if (next && next.fn === "ofType" && next.arg) key = null; // value.ofType(Quantity) with no valueQuantity: missing
    else if (seg.name) key = choiceKey(node, seg.name) ?? (Object.prototype.hasOwnProperty.call(node, "_" + seg.name) ? "_" + seg.name : null);
    if (key === null) return stop("missing", i);
    const at = i;
    tokens.push(key);
    node = node[key];
    if (Array.isArray(node)) {
      let idx = seg.index;
      if (seg.url !== null) {
        const k = node.findIndex((e: unknown) => isObj(e) && e.url === seg.url);
        if (k < 0) return stop("index", at);
        idx = k;
      }
      if (idx === null) {
        if (i === segs.length - 1) break; // the array itself
        if (node.length === 1) idx = 0;
        else return stop("index", at + 1);
      }
      if (idx >= node.length) return stop("index", at);
      tokens.push(String(idx));
      node = node[idx];
    } else if (seg.index !== null && seg.index > 0) {
      return stop("index", at);
    }
  }
  return { tokens, exact: true, stop: "done", rest: [] };
}

// --------------------------------------------------------------------------- //
// Suggestion patch (validator paths) → JSON Patch (tokens of the validated tree)
// --------------------------------------------------------------------------- //

/** Value for missing segments `segs` below an existing node, with `leaf` at the end. */
function nest(segs: FhirPathSegment[], leaf: unknown): unknown {
  if (!segs.length) return leaf;
  const [s, ...more] = segs;
  const inner = nest(more, leaf);
  return { [s.name]: s.index !== null ? [inner] : inner };
}

/**
 * Where a value addressed by `path` goes: `add` with this pointer + value puts it there
 * (missing containers created along the way). Null when the location cannot be expressed
 * (a choice element that does not exist, a function, a non-container parent).
 */
function placement(root: unknown, path: string, value: unknown): { tokens: string[]; value: unknown; existed: boolean } | null {
  const w = walkFhirPath(root, path);
  if (w.exact) return { tokens: w.tokens, value, existed: true };
  if (w.rest.some((s) => s.fn || s.choice || !s.name)) return null;
  const at = resolvePointer(root, w.tokens);
  if (!at.found) return null;
  if (w.stop === "missing" && isObj(at.value)) {
    const [first, ...more] = w.rest;
    const inner = nest(more, value);
    return { tokens: [...w.tokens, first.name], value: first.index !== null ? [inner] : inner, existed: false };
  }
  if (w.stop === "index" && Array.isArray(at.value)) {
    const [first, ...more] = w.rest;
    // the out-of-range element (rest[0] is that segment) is appended
    if (first && first.index !== null && first.index >= at.value.length) return { tokens: [...w.tokens, "-"], value: nest(more, value), existed: false };
  }
  return null;
}

export interface PatchSource {
  op: string;
  path: string;
  from?: string;
  value?: unknown;
}

/** One suggestion patch → JSON Patch ops over the validated tree (null = not expressible). */
export function suggestionPatchOps(root: unknown, p: PatchSource): JsonPatchOp[] | null {
  if (!p || typeof p.path !== "string") return null;
  switch (p.op) {
    case "replace":
    case "add": {
      const pl = placement(root, p.path, p.value);
      if (!pl) return null;
      const ptr = formatPointer(pl.tokens);
      if (pl.existed && p.op === "replace") return [{ op: "replace", path: ptr, value: pl.value }];
      return [{ op: "add", path: ptr, value: pl.value }];
    }
    case "remove": {
      const w = walkFhirPath(root, p.path);
      return w.exact && w.tokens.length ? [{ op: "remove", path: formatPointer(w.tokens) }] : null;
    }
    case "move": {
      if (typeof p.from !== "string") return null;
      const f = walkFhirPath(root, p.from);
      if (!f.exact || !f.tokens.length) return null;
      const from = formatPointer(f.tokens);
      const moved = resolvePointer(root, f.tokens).value;
      const pl = placement(root, p.path, moved);
      if (!pl) return null;
      const to = formatPointer(pl.tokens);
      if (pl.existed || pl.value === moved) return [{ op: "move", from, path: to }];
      // The destination's containers do not exist yet: write them with the value, then remove the original.
      if (to.startsWith(from + "/") || from.startsWith(to + "/")) return null;
      return [
        { op: "add", path: to, value: cloneJson(pl.value) },
        { op: "remove", path: from },
      ];
    }
    default:
      return null;
  }
}

// --------------------------------------------------------------------------- //
// Deterministic shape fixes read from the validator message (issues with one correct edit)
// --------------------------------------------------------------------------- //

interface Candidate {
  ops: JsonPatchOp[];
  reason: string;
  kind: string;
  confidence: number;
  /** Ops already in sent-tree pointers, appended after `ops` are mapped (fullUrl + its references). */
  extraSent?: JsonPatchOp[];
}

function messageCandidates(issue: Json, root: unknown, w: WalkResult): Candidate[] {
  const msg = String(issue.message || "");
  if (!w.exact || !w.tokens.length) {
    return [];
  }
  const ptr = formatPointer(w.tokens);
  const v = resolvePointer(root, w.tokens).value;
  const out: Candidate[] = [];
  if (/^The property \S+ must be a JSON Array, not (an Object|a primitive property)/.test(msg) && v !== undefined && !Array.isArray(v)) {
    out.push({ ops: [{ op: "replace", path: ptr, value: [v] }], reason: "the element repeats: wrap the value in an array", kind: "wrap_array", confidence: 0.95 });
  }
  if ((/^This property must be a simple value, not an Array/.test(msg) || /^The property \S+ must be a JSON Object, not an Array/.test(msg)) && Array.isArray(v) && v.length === 1) {
    out.push({ ops: [{ op: "replace", path: ptr, value: v[0] }], reason: "the element does not repeat: write its only item without the array", kind: "unwrap_array", confidence: 0.95 });
  }
  if (/^Array cannot be empty/.test(msg) || /^The property \S+ cannot be null$/.test(msg) || /^Array entries cannot be null$/.test(msg)) {
    out.push({ ops: [{ op: "remove", path: ptr }], reason: "empty / null values are not allowed in FHIR JSON: remove it", kind: "remove_empty", confidence: 0.95 });
  }
  if (/^Constraint failed: ele-1:/.test(msg) && ((isObj(v) && !Object.keys(v).length) || (Array.isArray(v) && !v.length) || v === "")) {
    out.push({ ops: [{ op: "remove", path: ptr }], reason: "an element must have a value or children (ele-1): remove the empty element", kind: "remove_empty", confidence: 0.9 });
  }
  if (/^@value cannot be empty$/.test(msg) && v === "") {
    out.push({ ops: [{ op: "remove", path: ptr }], reason: "an empty string is not a FHIR value: remove it (or write the real value)", kind: "remove_empty", confidence: 0.6 });
  }
  const fixed = /^Value is '[\s\S]*' but must be '([\s\S]*)' \(fixed by [^()]*\)$/.exec(msg);
  if (fixed && typeof v === "string" && !fixed[1].endsWith("...") && fixed[1] !== v) {
    out.push({ ops: [{ op: "replace", path: ptr, value: fixed[1] }], reason: "the profile fixes this value", kind: "replace_value", confidence: 0.9 });
  }
  return out;
}

// --------------------------------------------------------------------------- //
// Issue decoration
// --------------------------------------------------------------------------- //

export interface PointerContext {
  /** The instance as the caller sent it (plain JSON). */
  sent: unknown;
  /** The instance the issue paths refer to (= sent, or normalized_bundle). */
  validated: unknown;
  /** validated entry position → sent entry position (null = identity). */
  entryMap: Map<number, number | null> | null;
  /** Both trees differ (normalize_ids): values touched by a patch must be the same in both. */
  normalized: boolean;
  /** Default mode: new fullUrl → the reference rewrites that must go with it (sent-tree pointers). */
  refOps?: Map<string, JsonPatchOp[]>;
  maxPatches?: number;
}

/** Map validated-tree tokens to sent-tree tokens (entry position); null = the entry has no sent counterpart. */
function toSent(tokens: string[], ctx: PointerContext): string[] | null {
  if (!ctx.entryMap || tokens[0] !== "entry" || tokens.length < 2 || !/^\d+$/.test(tokens[1])) return tokens;
  const k = Number(tokens[1]);
  if (!ctx.entryMap.has(k)) return tokens;
  const s = ctx.entryMap.get(k);
  return s === null || s === undefined ? null : ["entry", String(s), ...tokens.slice(2)];
}

/** The longest prefix of `tokens` that exists in `doc`. */
function existingPrefix(doc: unknown, tokens: string[]): string[] {
  let n = tokens.length;
  while (n > 0 && !resolvePointer(doc, tokens.slice(0, n)).found) n--;
  return tokens.slice(0, n);
}

const pointerTokens = (p: string): string[] => (p === "" ? [] : p.slice(1).split("/").map((t) => t.replace(/~1/g, "/").replace(/~0/g, "~")));

/** Rewrite one op's pointers into the sent tree; null when it cannot be (or touches a value that differs there). */
function opToSent(op: JsonPatchOp, ctx: PointerContext): JsonPatchOp | null {
  const map = (p: string, mustMatch: boolean): string | null => {
    const vt = pointerTokens(p);
    const st = toSent(vt, ctx);
    if (!st) return null;
    if (mustMatch && ctx.normalized) {
      const a = resolvePointer(ctx.validated, vt);
      const b = resolvePointer(ctx.sent, st);
      if (!a.found || !b.found || !jsonEqual(a.value, b.value)) return null;
    }
    return formatPointer(st);
  };
  const path = map(op.path, op.op === "replace" || op.op === "remove" || op.op === "test");
  if (path === null) return null;
  if (op.op === "move" || op.op === "copy") {
    const from = map(op.from, true);
    return from === null ? null : { ...op, from, path };
  }
  return { ...op, path } as JsonPatchOp;
}

const ERRORS = new Set(["error", "fatal"]);

/**
 * Add `pointer` / `pointer_kind` (every issue) and `patches` (errors with at least one candidate
 * that applies to the sent instance) to one issue, in place. Never throws.
 */
export function decorateIssue(issue: Json, ctx: PointerContext): void {
  try {
    if (!isObj(issue)) return;
    const w = walkFhirPath(ctx.validated, String(issue.path ?? ""));
    const mapped = toSent(w.tokens, ctx);
    if (!mapped) return;
    const sentTokens = existingPrefix(ctx.sent, mapped);
    issue.pointer = formatPointer(sentTokens);
    issue.pointer_kind = w.exact && sentTokens.length === mapped.length ? "element" : "ancestor";
    if (!ERRORS.has(String(issue.severity))) return;
    const cands: Candidate[] = [];
    for (const s of Array.isArray(issue.suggestions) ? issue.suggestions : []) {
      if (!isObj(s) || !isObj(s.patch)) continue;
      const ops = suggestionPatchOps(ctx.validated, s.patch as PatchSource);
      if (!ops) continue;
      const extra = s.kind === "replace_fullurl" && ctx.refOps ? ctx.refOps.get(String(s.value)) ?? [] : [];
      cands.push({
        ops,
        extraSent: extra,
        reason: shortReason(String(s.reason || s.kind || "suggested fix"), extra.length),
        kind: String(s.kind || "suggestion"),
        confidence: typeof s.confidence === "number" ? s.confidence : 0.5,
      });
    }
    cands.push(...messageCandidates(issue, ctx.validated, w));
    if (!cands.length && /^Unrecognized property '([^']+)'$/.test(String(issue.message || "")) && w.exact) {
      const key = /^Unrecognized property '([^']+)'$/.exec(String(issue.message))![1];
      if (resolvePointer(ctx.validated, [...w.tokens, key]).found) {
        cands.push({ ops: [{ op: "remove", path: formatPointer([...w.tokens, key]) }], reason: `'${key}' is not defined here: remove it (its content is dropped)`, kind: "remove_property", confidence: 0.3 });
      }
    }
    const patches: Candidate[] = [];
    const seen = new Set<string>();
    for (const c of cands) {
      const ops: JsonPatchOp[] = [];
      let ok = true;
      for (const op of c.ops) {
        const o = opToSent(op, ctx);
        if (!o) {
          ok = false;
          break;
        }
        ops.push(o);
      }
      if (!ok) continue;
      ops.push(...((c.extraSent ?? []).filter((x) => !ops.some((o) => o.path === x.path))));
      const key = JSON.stringify(ops);
      if (seen.has(key) || !patchApplies(ctx.sent, ops)) continue;
      seen.add(key);
      patches.push({ ops, reason: c.reason, kind: c.kind, confidence: c.confidence });
      if (patches.length >= (ctx.maxPatches ?? 8)) break;
    }
    if (patches.length) issue.patches = patches;
  } catch {
    // fail-open: the issue keeps whatever it had
  }
}

function shortReason(reason: string, refs: number): string {
  const r = reason.length > 240 ? reason.slice(0, 237) + "..." : reason;
  return refs ? `${r} (with the ${refs} reference(s) that name it)` : r;
}

// --------------------------------------------------------------------------- //
// Errors explained by another issue's fix (second pass, sent-tree pointers)
// --------------------------------------------------------------------------- //

const RE_MIN_CARD = /^(\S+): minimum required = \d+, but only found \d+/;
const RE_UNRECOGNIZED_PROP = /^Unrecognized property '([^']+)'$/;

/** The pointer an op writes to (add / replace / move / copy). */
const writes = (op: JsonPatchOp): string | null => (op.op === "add" || op.op === "replace" || op.op === "move" || op.op === "copy" ? op.path : null);

const SIMPLE_REL = /^[A-Za-z]\w*(\.[A-Za-z]\w*)*$/;
const isPrimitive = (v: unknown): boolean => typeof v === "string" || typeof v === "number" || typeof v === "boolean";

/** Ops that set primitive values at simple relative paths below `base` (replace / add; null if a parent is missing). */
function setValues(sent: unknown, base: string, values: Record<string, unknown>): JsonPatchOp[] | null {
  const ops: JsonPatchOp[] = [];
  const baseTokens = pointerTokens(base);
  for (const [rel, value] of Object.entries(values)) {
    if (!SIMPLE_REL.test(rel) || !isPrimitive(value)) return null;
    const tokens = [...baseTokens, ...rel.split(".")];
    const at = resolvePointer(sent, tokens);
    if (at.found) {
      if (at.value === value) continue;
      if (!isPrimitive(at.value)) return null;
      ops.push({ op: "replace", path: formatPointer(tokens), value });
    } else {
      const parent = resolvePointer(sent, tokens.slice(0, -1));
      if (!parent.found || !isObj(parent.value)) return null;
      ops.push({ op: "add", path: formatPointer(tokens), value });
    }
  }
  return ops.length ? ops : null;
}

/**
 * A closed-slice item that matches no slice only because of primitive discriminator values
 * (a Coding.system, a code …): set the values a slice requires — the closest slice's failed
 * ones, else each option's — so the item becomes that slice. IG constants only, never record values.
 */
function sliceValueCandidates(sm: Json, P: string, sent: unknown): Candidate[] {
  if (sm.slice !== undefined) return []; // a missing-slice issue: nothing to edit in place
  const out: Candidate[] = [];
  const failed: Json[] = Array.isArray(sm.failed) ? sm.failed : [];
  if (isObj(sm.closest) && failed.length && failed.every((f) => (f.reason === "pattern-differs" || f.reason === "value-missing") && typeof f.path === "string")) {
    const ops = setValues(sent, P, Object.fromEntries(failed.map((f) => [f.path, f.expected])));
    if (ops) out.push({ ops, reason: `set the value(s) slice '${sm.closest.slice}' requires (${failed.map((f) => f.path).join(", ")})`, kind: "set_slice_values", confidence: 0.6 });
  }
  if (!out.length && Array.isArray(sm.options)) {
    for (const o of sm.options as Json[]) {
      if (!isObj(o) || !isObj(o.requires)) continue;
      const ops = setValues(sent, P, o.requires);
      if (ops) out.push({ ops, reason: `to make it slice '${o.slice}' (${o.card ?? ""}): set ${Object.keys(o.requires).join(", ")} as the slice requires`, kind: "set_slice_values", confidence: 0.5 });
      if (out.length >= 3) break;
    }
  }
  return out;
}

/**
 * Errors whose fix is another issue's fix, with no candidate of their own:
 *   - "minimum required" for element N of the object at `pointer`, while another issue's candidate
 *     writes N there (a misspelt / misplaced property renamed or moved into place);
 *   - ele-1 on an object whose every child is unrecognised (the parser drops them, so it is empty):
 *     the top candidates of those Unrecognized-property issues at the same pointer, together.
 * Candidates are re-verified against the sent instance. In place; never throws.
 */
export function linkRelatedPatches(issues: Json[], sent: unknown): void {
  try {
    const withPatches = issues.filter((i) => isObj(i) && Array.isArray(i.patches) && i.patches.length && typeof i.pointer === "string");
    const byKey = new Map<string, Json>();
    for (const i of withPatches) if (!byKey.has(`${i.path}\u0000${i.message}`)) byKey.set(`${i.path}\u0000${i.message}`, i);
    for (const issue of issues) {
      if (!isObj(issue) || !ERRORS.has(String(issue.severity)) || typeof issue.pointer !== "string" || (Array.isArray(issue.patches) && issue.patches.length)) continue;
      const P = issue.pointer;
      const msg = String(issue.message || "");
      const out: Candidate[] = [];
      const min = RE_MIN_CARD.exec(msg);
      if (min) {
        const last = min[1].split(".").pop() || "";
        const name = last.replace(/:.*$/, "").replace(/\[x\]$/, "");
        const choice = /\[x\]$/.test(last.replace(/:.*$/, ""));
        const hits = (ptr: string | null): boolean => {
          if (!ptr || !ptr.startsWith(P + "/")) return false;
          const tok = ptr.slice(P.length + 1).split("/")[0];
          return choice ? tok.length > name.length && tok.startsWith(name) && CHOICE_TYPES.has(tok.slice(name.length)) : tok === name;
        };
        for (const src of withPatches) {
          if (src === issue) continue;
          const c = (src.patches as Candidate[]).find((p) => p.ops.some((op) => hits(writes(op))));
          if (c) out.push({ ops: c.ops, reason: `${String(name)} is required here; this fix of a related issue (${String(src.message).slice(0, 80)}) puts it in place`, kind: c.kind, confidence: Math.min(c.confidence, 0.9) });
          if (out.length >= 3) break;
        }
      }
      const match = isObj(issue.slice_match) ? issue.slice_match : isObj(issue.profile_match) ? issue.profile_match : null;
      if (match && Array.isArray(match.blocking) && match.blocking.length && (match.blocking_total ?? match.blocking.length) === match.blocking.length) {
        // A slice / profile match blocked only by errors that all have a candidate: those candidates together.
        const parts: JsonPatchOp[][] = [];
        for (const b of match.blocking as Json[]) {
          const src = byKey.get(`${b.path}\u0000${b.message}`);
          if (!src || src === issue) break;
          parts.push((src.patches as Candidate[])[0].ops);
        }
        if (parts.length === match.blocking.length) {
          const seenOp = new Set<string>();
          const ops = parts.flat().filter((op) => !seenOp.has(JSON.stringify(op)) && !!seenOp.add(JSON.stringify(op)));
          const target = isObj(match.closest) ? match.closest.profile ?? match.closest.slice : null;
          out.push({ ops, reason: `fixes the ${parts.length} error(s) that keep it from matching ${target ?? "the closest profile"} (see blocking)`, kind: "fix_blocking", confidence: 0.7 });
        }
      }
      if (isObj(issue.slice_match) && !out.length) out.push(...sliceValueCandidates(issue.slice_match, P, sent));
      if (/^Constraint failed: ele-1:/.test(msg)) {
        const node = resolvePointer(sent, P).value;
        const srcs = withPatches.filter((s) => s.pointer === P && RE_UNRECOGNIZED_PROP.test(String(s.message || "")));
        const keys = new Set(srcs.map((s) => RE_UNRECOGNIZED_PROP.exec(String(s.message))![1]));
        if (isObj(node) && srcs.length && Object.keys(node).every((k) => keys.has(k) || k === "id")) {
          const ops = srcs.flatMap((s) => (s.patches as Candidate[])[0].ops);
          out.push({ ops, reason: "the element is empty because none of its properties is recognised; fix them (see the Unrecognized property issues at this pointer)", kind: "fix_children", confidence: 0.8 });
        }
      }
      const patches: Candidate[] = [];
      const seen = new Set<string>();
      for (const c of out) {
        const key = JSON.stringify(c.ops);
        if (seen.has(key) || !patchApplies(sent, c.ops)) continue;
        seen.add(key);
        patches.push(c);
      }
      if (patches.length) issue.patches = patches;
    }
  } catch {
    // fail-open
  }
}

// --------------------------------------------------------------------------- //
// Envelope (fhir_validate_bundle / fhir_validate_resource)
// --------------------------------------------------------------------------- //

/** `Bundle.entry[k]…` (finalizer output position) → the input position, through `order` (output → input). */
function pathToInput(path: string, order: number[]): string {
  return path.replace(/^Bundle\.entry\[(\d+)\]/, (m, k) => (Number(k) < order.length ? `Bundle.entry[${order[Number(k)]}]` : m));
}

const isIdentity = (order: number[]): boolean => order.every((v, i) => v === i);

/**
 * validated entry index → sent entry index for every validated entry: the finalizer's
 * permutation, checked against the entry's fullUrl (followed back through fullUrl changes) and
 * resourceType; a mismatch is re-located by fullUrl, else the entry gets null (no pointers).
 */
export function entryMapping(sent: Json, validated: Json, changes: FinalizeChange[], normalized: boolean): Map<number, number | null> {
  const vEntries: unknown[] = Array.isArray(validated.entry) ? validated.entry : [];
  const sEntries: unknown[] = Array.isArray(sent.entry) ? sent.entry : [];
  const order = normalized ? entryOrderOf(changes, vEntries.length) : vEntries.map((_, i) => i);
  const back = new Map<string, unknown>();
  if (normalized) {
    for (const c of changes) if (c.rule === "fullUrl-uuid" && typeof c.to === "string") back.set(c.to, c.from ?? null);
  }
  const fu = (e: unknown): unknown => (isObj(e) && typeof e.fullUrl === "string" ? e.fullUrl : null);
  const rt = (e: unknown): unknown => (isObj(e) && isObj(e.resource) ? e.resource.resourceType ?? null : null);
  const map = new Map<number, number | null>();
  vEntries.forEach((ve, k) => {
    const vf = fu(ve);
    const expected = vf !== null && back.has(vf as string) ? back.get(vf as string) ?? null : vf;
    const same = (j: number): boolean => j >= 0 && j < sEntries.length && (fu(sEntries[j]) ?? null) === (expected ?? null) && rt(sEntries[j]) === rt(ve);
    const j = order[k] ?? k;
    if (same(j)) {
      map.set(k, j);
      return;
    }
    const hits = expected === null ? [] : sEntries.map((_, x) => x).filter(same);
    map.set(k, hits.length === 1 ? hits[0] : null);
  });
  return map;
}

/**
 * Add pointers / patches to a validation envelope (JSON text; lossless numbers kept).
 * `sent` is the `bundle` / `resource` argument as the caller sent it. Returns `text` unchanged
 * when it is not a successful validation envelope, has no issue, or on any error.
 */
export function addValidationPointers(text: string, sent: unknown): string {
  try {
    const env = parseLossless(text);
    if (!isObj(env) || env.ok !== true || !isObj(env.data)) return text;
    const data = env.data as Json;
    const S = toPlain(sent);
    if (!isObj(S)) return text;
    const normalized = data.normalized_bundle !== undefined;
    const V = normalized ? toPlain(data.normalized_bundle) : S;
    if (!isObj(V)) return text;
    const changes: FinalizeChange[] = Array.isArray(data.id_changes) ? (toPlain(data.id_changes) as FinalizeChange[]) : [];
    const bundle = V.resourceType === "Bundle" && Array.isArray(V.entry);
    const entryMap = bundle && Array.isArray(S.entry) ? entryMapping(S, V, changes, normalized) : null;
    const ctx: PointerContext = { sent: S, validated: V, entryMap, normalized };
    if (!normalized && bundle && changes.length) {
      // Default mode: a fullUrl replacement goes together with every reference the finalizer rewires to it.
      const order = entryOrderOf(changes, (V.entry as unknown[]).length);
      const refOps = new Map<string, JsonPatchOp[]>();
      for (const c of changes) {
        if (c.rule !== "reference-rewire" || typeof c.to !== "string") continue;
        const w = walkFhirPath(S, isIdentity(order) ? c.path : pathToInput(c.path, order));
        if (!w.exact) continue;
        const list = refOps.get(c.to) ?? [];
        list.push({ op: "replace", path: formatPointer(w.tokens), value: c.to });
        refOps.set(c.to, list);
      }
      ctx.refOps = refOps;
    }
    let touched = false;
    const run = (list: unknown): void => {
      if (!Array.isArray(list)) return;
      for (const i of list) {
        if (!isObj(i)) continue;
        decorateIssue(i, ctx);
        touched = true;
      }
    };
    run(data.issues);
    if (Array.isArray(data.entries) && bundle) {
      // entries[] rows are the validated entries that carry a resource, in order.
      const rows: number[] = [];
      (V.entry as unknown[]).forEach((e, k) => {
        if (isObj(e) && isObj(e.resource) && e.resource.resourceType) rows.push(k);
      });
      data.entries.forEach((row: unknown, r: number) => {
        if (!isObj(row)) return;
        const k = rows[r];
        const s = k === undefined ? null : entryMap ? entryMap.get(k) ?? null : k;
        if (s !== null && s !== undefined) {
          row.pointer = formatPointer(["entry", String(s)]);
          touched = true;
        }
        if (!Array.isArray(row.issues)) return;
        for (const i of row.issues) {
          if (!isObj(i)) continue;
          decorateIssue(i, ctx);
          touched = true;
          // An issue of this row must point into this row's entry.
          if (typeof i.pointer === "string" && typeof row.pointer === "string" && !(i.pointer === row.pointer || i.pointer.startsWith(row.pointer + "/"))) {
            i.pointer = row.pointer;
            i.pointer_kind = "ancestor";
          }
        }
      });
    }
    if (touched) {
      const all: Json[] = [...(Array.isArray(data.issues) ? data.issues : [])];
      for (const row of Array.isArray(data.entries) ? data.entries : []) if (isObj(row) && Array.isArray(row.issues)) all.push(...row.issues);
      linkRelatedPatches(all, S);
    }
    return touched ? stringifyLossless(env) : text;
  } catch {
    return text;
  }
}
