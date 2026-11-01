/**
 * ISSUES_v19 R1 — layer 1 of fhir_finalize_bundle: every structural error with exactly ONE correct fix is fixed by
 * the MCP, every change is reported against the Bundle AS SENT, what has several possible fixes is reported as
 * `ambiguous` (with RFC 6902 candidates where they can be written), and finalize never adds an error.
 *
 *   errorCategory / changeCategory   the R1 categories (shape, narrative, display, unrecognized_property,
 *                                    system_code, ids_references, document_structure, fixed_pattern);
 *   autoFixBundle                    validator-driven fixes on the content-repaired Bundle (a value the profile
 *                                    fixes, the display of a code the profile pins, a choice type the profile
 *                                    narrows to one, a required section narrative from the section's entries;
 *                                    round 2: the display of a determined code, a Coding's system from the bound
 *                                    ValueSet, a code moved to the one sibling element whose required ValueSet
 *                                    holds it, a string element written as {text});
 *   EntryMap / annotateChanges       RFC 6901 pointers relative to the Bundle as sent (entries the finalizer
 *                                    reordered, dropped duplicates and entries moved in from Bundle level mapped
 *                                    back), with before / after / category;
 *   guardNoNewErrors                 validates the Bundle as sent and as finalized; an error the finalized Bundle
 *                                    has that the sent one does not (multiset by message, entry order and minted
 *                                    UUIDs ignored) withdraws the change(s) it is owed to and the pipeline runs
 *                                    again without them (≤ 3 rounds, then nothing is applied); exposed_errors
 *                                    "allow_under_moved" does not count errors under a renamed / moved value's new
 *                                    location (they were hidden as an unknown property, not added);
 *   buildAmbiguous                   the not-uniquely-fixable items (withdrawn changes, repair issues with
 *                                    candidates, unresolved references, remaining R1-category errors).
 * Everything is read from StructureDefinitions / the validator's own messages (validator_cli wording) — no IG strings.
 * Nothing clinical is invented: values come from the profile (fixed / pattern / pinned code displays) or from the
 * Bundle itself (section narratives list the section's own entries).
 */

import { entryOrderOf, type FinalizeChange, type FinalizeUnresolved } from "../fhirBundleFinalize.js";
import { patchApplies, type JsonPatchOp } from "../jsonPatch.js";
import { toPlain } from "../losslessJson.js";
import { nameOf } from "./document.js";
import { fitPrimitive } from "./shape.js";
import { conflictCandidates, conflictMessage, isStatusElement, sameValue } from "./fixedGuard.js";
import { bag, overlap } from "./displays.js";
import type { ExpandedCoding, NormalizeCandidate, RepairChange, RepairIssue, RepairRule } from "./types.js";

type Json = Record<string, any>;

export const R1_CATEGORIES = ["shape", "narrative", "display", "unrecognized_property", "system_code", "ids_references", "document_structure", "fixed_pattern"] as const;
export type R1Category = (typeof R1_CATEGORIES)[number];

export interface ValidatorIssue {
  severity?: string;
  path?: string;
  message?: string;
  code?: string;
}

const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
const ERROR_SEV = new Set(["error", "fatal"]);
const XHTML_NS = "http://www.w3.org/1999/xhtml";

// ------------------------------------------------------------------------------------------------ categories

/** The R1 category of a validator message (validator_cli wording); null = not a listed category (content, slices …). */
export function errorCategory(message: string): R1Category | null {
  const m = String(message ?? "");
  if (/^Unrecognized property/u.test(m)) return "unrecognized_property";
  if (/Wrong (?:Display Name|whitespace in Display)/u.test(m)) return "display";
  if (/but is fixed to|does not match the fixed value|does not match the (?:required )?pattern|^Value is .* but must be/u.test(m)) return "fixed_pattern";
  if (/first entry in a document must be|\bbdl-(?:9|10|11|12)\b|isn't reachable by traversing|^Bundle\.(?:identifier|timestamp): minimum required|must have a Composition as the first/u.test(m)) return "document_structure";
  if (/^Can't find '|URN reference is not locally contained|UUIDs must be valid|\bfullUrl\b|Relative Reference|Invalid Resource id|\bbdl-[78]\b|implied by the reference URL|matches .* by type and id|Unable to resolve resource|Bundled or contained reference not found|resolves to multiple/u.test(m)) return "ids_references";
  if (/Narrative|XHTML|xhtml|\btxt-[12]\b|The div|html element/u.test(m)) return "narrative";
  if (/must be an Array|must be a simple value, not an Object|must be a JSON (?:Object|Array)|must be an Object, not|Boolean values must be|definition allows for the type .* but found type|is not a valid (?:boolean|integer|decimal|positiveInt|unsignedInt)|Not a valid (?:instant|date|dateTime|time) format|\bele-1\b|Error parsing JSON|Primitive values? must|cannot be empty|must not be empty|This property must be/u.test(m)) return "shape";
  if (/System URI could not be determined|A definition for CodeSystem .* could not be found|is a ValueSet|is a value set|Unknown System|not a valid UCUM|UCUM/u.test(m)) return "system_code";
  return null;
}

/** The R1 category of a change (content-repair rule / finalizer rule). */
export function changeCategory(c: { rule: string; path?: string; from?: unknown; reason?: string }): R1Category {
  switch (c.rule) {
    case "shape":
      return isObj(c.from) && typeof c.from.path === "string" ? "unrecognized_property" : "shape";
    case "empty":
    case "roc-date":
    case "timezone":
      return "shape";
    case "system":
    case "ucum":
    case "code":
    case "alt-coding":
      return "system_code";
    case "fixed-slice":
    case "fixed-value":
      return "fixed_pattern";
    case "display":
      return "display";
    case "narrative":
      return "narrative";
    case "document":
      return /\.code$/u.test(String(c.path ?? "")) && /display/u.test(String(c.reason ?? "")) ? "display" : "document_structure";
    case "fullUrl-uuid":
    case "reference-rewire":
    case "resource-id":
      return "ids_references";
    case "bundle-type":
    case "document-order":
      return "document_structure";
    default:
      return "shape";
  }
}

// ------------------------------------------------------------------------------------------------ JSON Pointer / Patch

/** RFC 6901 reference-token escaping (~ → ~0, / → ~1). */
export function escapeToken(t: string): string {
  return String(t).replace(/~/gu, "~0").replace(/\//gu, "~1");
}

function unescapeToken(t: string): string {
  return t.replace(/~1/gu, "/").replace(/~0/gu, "~");
}

export function pointerTokens(ptr: string): string[] {
  if (ptr === "") return [];
  return ptr.split("/").slice(1).map(unescapeToken);
}

export function tokensToPointer(tokens: Array<string | number>): string {
  return tokens.map((t) => "/" + escapeToken(String(t))).join("");
}

interface Seg {
  key: string;
  index: number | null;
}

/** A validator / repair dotted instance path → its segments after the root (`.value.ofType(string)` → `valueString`). */
export function pathSegments(path: string): Seg[] {
  const p = String(path ?? "")
    .replace(/\/\*[^*]*\*\//gu, "")
    .replace(/\.ofType\(([A-Za-z]+)\)/gu, (_, t: string) => t[0].toUpperCase() + t.slice(1));
  const parts = p.split(".").filter((x) => x !== "");
  const out: Seg[] = [];
  for (const part of parts.slice(1)) {
    const m = /^([^[\]]+)((?:\[\d+\])*)$/u.exec(part);
    if (!m) return out;
    const idx = [...m[2].matchAll(/\[(\d+)\]/gu)].map((x) => Number(x[1]));
    out.push({ key: m[1], index: idx.length ? idx[0] : null });
  }
  return out;
}

/** Value at a pointer (found = every token resolved). */
export function resolvePointer(doc: unknown, ptr: string): { found: boolean; value: unknown } {
  let node: unknown = doc;
  for (const t of pointerTokens(ptr)) {
    if (Array.isArray(node)) {
      if (!/^\d+$/u.test(t) || Number(t) >= node.length) return { found: false, value: undefined };
      node = node[Number(t)];
    } else if (isObj(node)) {
      if (!(t in node)) return { found: false, value: undefined };
      node = node[t];
    } else return { found: false, value: undefined };
  }
  return { found: true, value: node };
}

export interface PatchOp {
  op: "add" | "remove" | "replace" | "move" | "copy" | "test";
  path: string;
  from?: string;
  value?: unknown;
}

const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

/** RFC 6902 applied to a deep copy; null when an operation cannot be applied (missing path, bad index, failed test). */
export function applyPatch(doc: unknown, ops: PatchOp[]): unknown | null {
  let root: unknown = clone(doc);
  const parentOf = (ptr: string): { parent: unknown; key: string } | null => {
    const toks = pointerTokens(ptr);
    if (!toks.length) return null;
    const r = resolvePointer(root, tokensToPointer(toks.slice(0, -1)));
    return r.found ? { parent: r.value, key: toks[toks.length - 1] } : null;
  };
  const remove = (ptr: string): { ok: boolean; value?: unknown } => {
    const pk = parentOf(ptr);
    if (!pk) return { ok: false };
    const { parent, key } = pk;
    if (Array.isArray(parent)) {
      if (!/^\d+$/u.test(key) || Number(key) >= parent.length) return { ok: false };
      return { ok: true, value: parent.splice(Number(key), 1)[0] };
    }
    if (isObj(parent) && key in parent) {
      const v = parent[key];
      delete parent[key];
      return { ok: true, value: v };
    }
    return { ok: false };
  };
  const add = (ptr: string, value: unknown): boolean => {
    if (ptr === "") {
      root = value;
      return true;
    }
    const pk = parentOf(ptr);
    if (!pk) return false;
    const { parent, key } = pk;
    if (Array.isArray(parent)) {
      if (key === "-") parent.push(value);
      else if (/^\d+$/u.test(key) && Number(key) <= parent.length) parent.splice(Number(key), 0, value);
      else return false;
      return true;
    }
    if (isObj(parent)) {
      parent[key] = value;
      return true;
    }
    return false;
  };
  for (const op of ops) {
    switch (op.op) {
      case "add":
        if (!add(op.path, clone(op.value))) return null;
        break;
      case "remove":
        if (!remove(op.path).ok) return null;
        break;
      case "replace": {
        if (op.path === "") {
          root = clone(op.value);
          break;
        }
        if (!resolvePointer(root, op.path).found) return null;
        const pk = parentOf(op.path)!;
        if (Array.isArray(pk.parent)) pk.parent[Number(pk.key)] = clone(op.value);
        else (pk.parent as Json)[pk.key] = clone(op.value);
        break;
      }
      case "move": {
        if (op.from === undefined) return null;
        const r = remove(op.from);
        if (!r.ok || !add(op.path, r.value)) return null;
        break;
      }
      case "copy": {
        if (op.from === undefined) return null;
        const r = resolvePointer(root, op.from);
        if (!r.found || !add(op.path, clone(r.value))) return null;
        break;
      }
      case "test": {
        const r = resolvePointer(root, op.path);
        if (!r.found || JSON.stringify(r.value) !== JSON.stringify(op.value)) return null;
        break;
      }
      default:
        return null;
    }
  }
  return root;
}

// ------------------------------------------------------------------------------------------------ entry index mapping

/**
 * Entry positions across the finalize pipeline: SENT (the caller's Bundle) → CONTENT (after the content repair:
 * exact duplicates dropped, an entry written at Bundle level appended) → FINAL (the finalizer's document order).
 * Content-repair / autofix change paths are in content space, finalizer change paths and the validator's paths on
 * the result are in final space (the document-order change itself names its content position).
 */
export class EntryMap {
  private readonly drops: number[];
  /** Content index of an entry moved in from Bundle level → the sent pointer prefix of its properties (""). */
  private readonly moved = new Map<number, string>();
  private readonly order: number[];

  constructor(
    readonly sentLength: number,
    contentChanges: Array<{ rule: string; path: string; from?: unknown; to?: unknown }>,
    finChanges: FinalizeChange[],
    finalLength: number,
  ) {
    this.drops = contentChanges
      .filter((c) => c.rule === "shape" && c.to === null && /^Bundle\.entry\[\d+\]$/u.test(c.path))
      .map((c) => Number(/\[(\d+)\]/u.exec(c.path)![1]))
      .sort((a, b) => a - b);
    for (const c of contentChanges) {
      const m = /^Bundle\.entry\[(\d+)\]$/u.exec(c.path);
      if (m && c.rule === "shape" && isObj(c.from) && Array.isArray(c.from.keys) && c.to !== null) this.moved.set(Number(m[1]) - this.drops.filter((d) => d < Number(m[1])).length, "");
    }
    this.order = entryOrderOf(finChanges, finalLength);
  }

  /** Content index → sent index (null = the entry did not exist as an entry in the sent Bundle). */
  contentToSent(i: number): number | null {
    if (this.moved.has(i)) return null;
    let k = i;
    for (const d of this.drops) if (d <= k) k++;
    return k < this.sentLength ? k : null;
  }

  finalToContent(i: number): number {
    return i >= 0 && i < this.order.length ? this.order[i] : i;
  }

  /** A dotted path (content or final space) → RFC 6901 pointer relative to the sent Bundle; `doc` (the sent Bundle) resolves unindexed single-item arrays. */
  pointer(path: string, space: "content" | "final", doc?: unknown): string {
    const segs = pathSegments(path);
    const toks: Array<string | number> = [];
    let node: unknown = doc;
    let i = 0;
    if (segs.length && segs[0].key === "entry" && segs[0].index !== null) {
      const c = space === "final" ? this.finalToContent(segs[0].index) : segs[0].index;
      const s = this.contentToSent(c);
      if (s === null && this.moved.has(c)) {
        // an entry moved in from Bundle level: its properties were written on the Bundle itself
        i = 1;
      } else {
        toks.push("entry", s ?? c);
        node = isObj(node) && Array.isArray(node.entry) ? node.entry[s ?? c] : undefined;
        i = 1;
      }
    }
    for (; i < segs.length; i++) {
      const { key, index } = segs[i];
      toks.push(key);
      node = isObj(node) ? node[key] : undefined;
      if (index !== null) {
        toks.push(index);
        node = Array.isArray(node) ? node[index] : undefined;
      } else if (Array.isArray(node) && node.length === 1 && i < segs.length - 1) {
        toks.push(0);
        node = node[0];
      }
    }
    return tokensToPointer(toks);
  }

  /** Content index → final index (the finalizer's document order). */
  contentToFinal(i: number): number {
    const k = this.order.indexOf(i);
    return k >= 0 ? k : i;
  }

  /** A dotted path (content or final space) → RFC 6901 pointer into the RETURNED (finalized) Bundle `out`. */
  outPointer(path: string, space: "content" | "final", out?: unknown): string {
    const segs = pathSegments(path);
    const toks: Array<string | number> = [];
    let node: unknown = out;
    for (let i = 0; i < segs.length; i++) {
      const { key } = segs[i];
      let index = segs[i].index;
      if (i === 0 && key === "entry" && index !== null && space === "content") index = this.contentToFinal(index);
      toks.push(key);
      node = isObj(node) ? node[key] : undefined;
      if (index !== null) {
        toks.push(index);
        node = Array.isArray(node) ? node[index] : undefined;
      } else if (Array.isArray(node) && node.length === 1 && i < segs.length - 1) {
        toks.push(0);
        node = node[0];
      }
    }
    return tokensToPointer(toks);
  }
}

/** The pointer itself when it resolves in `doc`, else its nearest ancestor that does (exact = false). */
export function nearestExisting(doc: unknown, ptr: string): { pointer: string; exact: boolean } {
  const toks = pointerTokens(ptr);
  for (let n = toks.length; n >= 0; n--) {
    const p = tokensToPointer(toks.slice(0, n));
    if (resolvePointer(doc, p).found) return { pointer: p, exact: n === toks.length };
  }
  return { pointer: "", exact: false };
}

// ------------------------------------------------------------------------------------------------ annotated changes

export interface AnnotatedChange {
  path: string;
  from: unknown;
  to: unknown;
  rule: string;
  reason?: string;
  /** RFC 6901 pointer into the Bundle AS SENT: where the change applies (a move / rename: the value's sent location). */
  pointer: string;
  /** Moves / renames: where the value is now (relative to the sent Bundle's structure). */
  moved_to?: string;
  /** The value at `pointer` before (null = absent). */
  before: unknown;
  /** The value after (null = removed). */
  after: unknown;
  category: R1Category;
}

const isMove = (c: { from?: unknown }): boolean => isObj(c.from) && typeof c.from.path === "string";

/** Content-repair / autofix changes (content space) and finalizer changes (final space) with pointers into the sent Bundle. */
export function annotateChanges(contentChanges: RepairChange[], finChanges: FinalizeChange[], map: EntryMap, sent: unknown): AnnotatedChange[] {
  const out: AnnotatedChange[] = [];
  for (const c of contentChanges) {
    const category = changeCategory(c);
    if (isMove(c)) {
      const from = c.from as Json;
      out.push({ ...c, pointer: map.pointer(String(from.path), "content", sent), moved_to: map.pointer(c.path, "content", sent), before: from.value ?? null, after: c.to ?? null, category });
    } else out.push({ ...c, pointer: map.pointer(c.path, "content", sent), before: c.from ?? null, after: c.to ?? null, category });
  }
  for (const c of finChanges) {
    const category = changeCategory(c);
    if (c.rule === "document-order") {
      const k = Number(/\[(\d+)\]/u.exec(c.path)?.[1] ?? 0);
      const s = map.contentToSent(k) ?? k;
      out.push({ ...c, pointer: `/entry/${s}`, moved_to: "/entry/0", before: { entry_index: s }, after: { entry_index: 0 }, category });
    } else out.push({ ...c, pointer: map.pointer(c.path, "final", sent), before: c.from ?? null, after: c.to ?? null, category });
  }
  // release v1: never a no-op — the same value at the same place is no change
  return out.filter((c) => !((c.moved_to === undefined || c.moved_to === c.pointer) && c.rule !== "document-order" && samePlain(c.before, c.after)));
}

const samePlain = (a: unknown, b: unknown): boolean => JSON.stringify(toPlain(a ?? null)) === JSON.stringify(toPlain(b ?? null));

/** RFC 6902 ops that apply one change to the sent Bundle (null when it cannot be written against it). */
export function changePatch(c: AnnotatedChange, sent: unknown): PatchOp[] | null {
  let ops: PatchOp[];
  if (c.rule === "document-order") ops = [{ op: "move", from: c.pointer, path: "/entry/0" }];
  else if (c.moved_to !== undefined) ops = c.moved_to === c.pointer ? [{ op: "replace", path: c.pointer, value: c.after }] : [{ op: "remove", path: c.pointer }, { op: "add", path: c.moved_to, value: c.after }];
  else if (c.after === null || c.after === undefined) ops = [{ op: "remove", path: c.pointer }];
  else ops = [{ op: resolvePointer(sent, c.pointer).found ? "replace" : "add", path: c.pointer, value: toPlain(c.after) }];
  return applyPatch(sent, ops) === null ? null : ops;
}

// ------------------------------------------------------------------------------------------------ no-new-error guard

/** Error identity across the pipeline: message with minted UUIDs and entry positions abstracted. */
export function errorKey(message: string): string {
  return String(message ?? "")
    .replace(/urn:uuid:[0-9a-fA-F-]{36}/gu, "urn:uuid:X")
    .replace(/entry\[\d+\]/gu, "entry[*]");
}

export function errorsOf(issues: ValidatorIssue[]): ValidatorIssue[] {
  return issues.filter((i) => ERROR_SEV.has(String(i.severity)));
}

/** Errors of `after` that `before` does not have (multiset by errorKey). */
export function newErrors(before: ValidatorIssue[], after: ValidatorIssue[]): ValidatorIssue[] {
  const left = new Map<string, number>();
  for (const i of errorsOf(before)) left.set(errorKey(String(i.message)), (left.get(errorKey(String(i.message))) ?? 0) + 1);
  const out: ValidatorIssue[] = [];
  for (const i of errorsOf(after)) {
    const k = errorKey(String(i.message));
    const n = left.get(k) ?? 0;
    if (n > 0) left.set(k, n - 1);
    else out.push(i);
  }
  return out;
}

/** What the pipeline runs without (the guard's rollback state). */
export interface Disabled {
  /** blockKey(rule, path) of content-repair / autofix changes not to apply. */
  blocked: Set<string>;
  /** Whole steps not to run: narrative, system_versions, document (completion), document_order, ids, autofix. */
  steps: Set<string>;
  /** Apply nothing at all (the Bundle as sent). */
  all: boolean;
}

export const noneDisabled = (): Disabled => ({ blocked: new Set(), steps: new Set(), all: false });

/** blockKey of fhirRepair/index.ts (rule + path without a trailing index). */
export function changeBlockKey(rule: string, path: string): string {
  return `${rule}\u0000${path.replace(/\[\d+\]$/u, "")}`;
}

const CONTENT_RULES = new Set<string>(["shape", "empty", "system", "fixed-slice", "alt-coding", "ucum", "roc-date", "timezone", "code", "display", "fixed-value"]);

/** The rollback of one change: a block key (content repair / autofix) or a whole step. */
function disable(c: AnnotatedChange, d: Disabled): void {
  if (c.rule === "narrative") d.steps.add("narrative");
  else if (c.rule === "document") d.steps.add("document");
  else if (c.rule === "fullUrl-uuid" || c.rule === "reference-rewire" || c.rule === "resource-id") d.steps.add("ids");
  else if (c.rule === "bundle-type" || c.rule === "document-order") d.steps.add("document_order");
  else if (CONTENT_RULES.has(c.rule)) {
    d.blocked.add(changeBlockKey(c.rule, c.path));
    if (isObj(c.from) && typeof c.from.path === "string") d.blocked.add(changeBlockKey(c.rule, String(c.from.path)));
    if (c.rule === "system" && /\|/u.test(String(c.from ?? ""))) d.steps.add("system_versions");
  }
}

const tokensOf = (p: string): string[] => pointerTokens(p);
const prefixOf = (a: string[], b: string[]): boolean => a.length <= b.length && a.every((t, i) => t === b[i]);

/** The changes a new error is owed to: at / above / below its location; else in the entries it names or its own; else Bundle-level; else all. */
export function attributeErrors(errors: Array<{ pointer: string; message: string; entryUrls: number[] }>, changes: AnnotatedChange[]): AnnotatedChange[] {
  const out = new Set<AnnotatedChange>();
  for (const e of errors) {
    const et = tokensOf(e.pointer);
    const near = changes.filter((c) => [c.pointer, c.moved_to].some((p) => p !== undefined && (prefixOf(tokensOf(p), et) || prefixOf(et, tokensOf(p))) && (tokensOf(p).length > 2 || et.length <= 2)));
    if (near.length) {
      near.forEach((c) => out.add(c));
      continue;
    }
    const entryOf = (p: string): number | null => {
      const t = tokensOf(p);
      return t[0] === "entry" && /^\d+$/u.test(t[1] ?? "") ? Number(t[1]) : null;
    };
    const own = entryOf(e.pointer);
    const named = new Set<number>(e.entryUrls);
    const inNamed = changes.filter((c) => [c.pointer, c.moved_to].some((p) => p !== undefined && named.has(entryOf(p) ?? -1) && entryOf(p) !== own));
    if (inNamed.length) {
      inNamed.forEach((c) => out.add(c));
      continue;
    }
    const inOwn = own !== null ? changes.filter((c) => [c.pointer, c.moved_to].some((p) => p !== undefined && entryOf(p) === own)) : [];
    if (inOwn.length) {
      inOwn.forEach((c) => out.add(c));
      continue;
    }
    const bundleLevel = changes.filter((c) => !/^\/entry\/\d+\/resource\//u.test(c.pointer));
    (bundleLevel.length ? bundleLevel : changes).forEach((c) => out.add(c));
  }
  return [...out];
}

export interface PipelineResult {
  /** The finalized Bundle (plain JSON). */
  bundle: Json;
  changes: AnnotatedChange[];
  /** Entry mapping of this run. */
  map: EntryMap;
}

export interface GuardOutcome<R extends PipelineResult> {
  result: R;
  /** Changes withdrawn because they added an error, with that error. */
  withdrawn: Array<{ change: AnnotatedChange; error: string }>;
  /** Errors of the sent / finalized Bundle (validator issues, severity error / fatal). */
  before: ValidatorIssue[];
  after: ValidatorIssue[];
  /** true when no attribution worked and nothing was applied. */
  gaveUp: boolean;
  /** false when the validator was not available (the guard did not run). */
  checked: boolean;
}

/**
 * Run the pipeline, validate, and withdraw what adds an error (see the module comment). `run` must honour the
 * Disabled state; `validate` returns the validator's issues of a Bundle (null = unavailable).
 */
/**
 * How the guard counts an error the finalized Bundle has and the sent one does not:
 *   strict             every such error withdraws the change it is owed to (default);
 *   allow_under_moved  an error located at / under the NEW location of a renamed / moved property is not new — the value
 *                      was an unknown property before (the validator could not check it), so the error was hidden, not
 *                      added. The rename stays; the error is reported (ambiguous).
 */
export type ExposedErrorsMode = "strict" | "allow_under_moved";
export const EXPOSED_ERRORS_MODES: readonly ExposedErrorsMode[] = ["strict", "allow_under_moved"];

/** Is the error (pointer relative to the sent Bundle) at / under where a move / rename put a value? */
export function underMoved(pointer: string, changes: AnnotatedChange[]): boolean {
  const et = tokensOf(pointer);
  return changes.some((c) => c.moved_to !== undefined && c.rule !== "document-order" && c.moved_to !== c.pointer && prefixOf(tokensOf(c.moved_to), et));
}

export async function guardNoNewErrors<R extends PipelineResult>(
  sent: Json,
  run: (d: Disabled) => Promise<R>,
  validate: (bundle: Json) => Promise<ValidatorIssue[] | null>,
  rounds = 3,
  exposed: ExposedErrorsMode = "strict",
): Promise<GuardOutcome<R>> {
  const disabled = noneDisabled();
  let result = await run(disabled);
  const before = await validate(sent);
  if (!before) return { result, withdrawn: [], before: [], after: [], gaveUp: false, checked: false };
  const withdrawn: Array<{ change: AnnotatedChange; error: string }> = [];
  let after: ValidatorIssue[] = before;
  for (let round = 0; ; round++) {
    if (!result.changes.length) {
      after = before;
      break;
    }
    const post = await validate(result.bundle);
    if (!post) {
      after = before;
      break;
    }
    after = post;
    let fresh = newErrors(before, post);
    if (exposed === "allow_under_moved") {
      const r = result;
      fresh = fresh.filter((e) => !underMoved(r.map.pointer(String(e.path ?? "Bundle"), "final", sent), r.changes));
    }
    if (!fresh.length) break;
    const located = fresh.map((e) => {
      const urls: number[] = [];
      const entries: Json[] = Array.isArray(result.bundle.entry) ? result.bundle.entry : [];
      for (const [i, en] of entries.entries()) if (isObj(en) && typeof en.fullUrl === "string" && en.fullUrl && String(e.message).includes(en.fullUrl)) urls.push(result.map.contentToSent(result.map.finalToContent(i)) ?? -1);
      return { pointer: result.map.pointer(String(e.path ?? "Bundle"), "final", sent), message: String(e.message), entryUrls: urls };
    });
    const blame = round < rounds ? attributeErrors(located, result.changes) : [];
    if (!blame.length) {
      // not attributable / still failing: nothing is applied
      for (const c of result.changes) withdrawn.push({ change: c, error: String(fresh[0].message) });
      disabled.all = true;
      result = await run(disabled);
      after = before;
      return { result, withdrawn, before: errorsOf(before), after: errorsOf(before), gaveUp: true, checked: true };
    }
    for (const c of blame) {
      const err = located.find((e) => [c.pointer, c.moved_to].some((p) => p !== undefined && (prefixOf(tokensOf(p), tokensOf(e.pointer)) || prefixOf(tokensOf(e.pointer), tokensOf(p))))) ?? located[0];
      withdrawn.push({ change: c, error: err.message });
      disable(c, disabled);
    }
    result = await run(disabled);
  }
  // a withdrawn change that the final run applies anyway (another path / rule produced it) is not withdrawn
  const applied = new Set(result.changes.map((c) => `${c.rule}\u0000${c.pointer}\u0000${JSON.stringify(c.after)}`));
  const really = withdrawn.filter((w) => !applied.has(`${w.change.rule}\u0000${w.change.pointer}\u0000${JSON.stringify(w.change.after)}`));
  return { result, withdrawn: really, before: errorsOf(before), after: errorsOf(after), gaveUp: false, checked: true };
}

// ------------------------------------------------------------------------------------------------ ambiguous

export interface AmbiguousCandidate {
  description: string;
  /** RFC 6902 operations relative to the Bundle as sent (verified to apply). */
  patch?: PatchOp[];
  /** The same fix as RFC 6902 operations on the RETURNED Bundle, when its paths / values differ (verified to apply). */
  patch_out?: PatchOp[];
}

export interface AmbiguousItem {
  /** RFC 6901 pointer into the Bundle as sent (resolves there). */
  pointer: string;
  /** RFC 6901 pointer into the returned (finalized) Bundle, when it differs from `pointer` (resolves there). */
  pointer_out?: string;
  /** Set when a pointer had to name the nearest existing ancestor of the element (it does not exist in that Bundle). */
  pointer_note?: string;
  message: string;
  category: R1Category | null;
  candidates: AmbiguousCandidate[];
}

const stripCoding = (p: string): string => p.replace(/\/display$/u, "");

/** Candidates of a repair issue as patches on the sent Bundle (only those that apply). */
function issueCandidates(i: RepairIssue, pointer: string, sent: unknown): AmbiguousCandidate[] {
  const out: AmbiguousCandidate[] = [];
  const ok = (ops: PatchOp[]): PatchOp[] | undefined => (applyPatch(sent, ops) === null ? undefined : ops);
  if (i.rule === "display") {
    const valid = /\(valid: '([^']*)'\)/u.exec(i.message)?.[1];
    if (valid !== undefined) out.push({ description: `keep the code; use its display '${valid}'`, patch: ok([{ op: "replace", path: pointer, value: valid }]) });
  }
  for (const c of (i.candidates ?? []).slice(0, 6)) {
    if (isObj(c) && typeof c.code === "string") {
      const base = i.rule === "display" ? stripCoding(pointer) : pointer;
      const ops: PatchOp[] = [];
      if (typeof c.system === "string") ops.push({ op: resolvePointer(sent, `${base}/system`).found ? "replace" : "add", path: `${base}/system`, value: c.system });
      ops.push({ op: resolvePointer(sent, `${base}/code`).found ? "replace" : "add", path: `${base}/code`, value: c.code });
      if (typeof c.display === "string") ops.push({ op: resolvePointer(sent, `${base}/display`).found ? "replace" : "add", path: `${base}/display`, value: c.display });
      out.push({ description: `use ${c.system ?? ""}#${c.code}${c.display ? ` '${c.display}'` : ""}`, patch: resolvePointer(sent, base).found ? ok(ops) : undefined });
    } else if (isObj(c) && typeof c.name === "string" && "value" in c) {
      const parent = pointer.slice(0, pointer.lastIndexOf("/"));
      out.push({ description: `rename to '${c.name}'${typeof c.reason === "string" ? ` (${c.reason})` : ""}`, patch: ok([{ op: "remove", path: pointer }, { op: "add", path: `${parent}/${escapeToken(c.name)}`, value: toPlain(c.value) }]) });
    } else if (typeof c === "string") out.push({ description: c });
    else out.push({ description: JSON.stringify(toPlain(c)).slice(0, 300) });
  }
  for (const c of out) if (!c.patch) delete c.patch;
  return out;
}

/**
 * The finalize response's `ambiguous`: withdrawn changes (their patch is a candidate — it also brings the error it
 * added), repair issues that could not be decided (with their candidates), references that resolve to no / several
 * entries, and every remaining error of an R1 category (located; candidates where derivable).
 */
export function buildAmbiguous(args: {
  sent: unknown;
  map: EntryMap;
  withdrawn: Array<{ change: AnnotatedChange; error: string }>;
  repairIssues: RepairIssue[];
  unresolved: FinalizeUnresolved[];
  idMap: Record<string, string>;
  remaining: ValidatorIssue[];
  /** The returned (finalized) Bundle: items gain pointer_out / patch_out into it (release v1). */
  out?: unknown;
}): AmbiguousItem[] {
  const out: AmbiguousItem[] = [];
  const seen = new Set<string>();
  /** Where each item is in the returned Bundle (dotted path + its space), and per candidate the out-side patch override. */
  const where = new Map<AmbiguousItem, ItemSite>();
  const push = (it: AmbiguousItem, path: string, space: "content" | "final", outPatches?: Map<AmbiguousCandidate, PatchOp[]>): void => {
    const k = `${it.pointer}\u0000${it.message}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(it);
    where.set(it, { path, space, outPatches });
  };
  for (const w of args.withdrawn) {
    const patch = changePatch(w.change, args.sent);
    const fin = FINALIZER_RULES.has(w.change.rule);
    const at = isMove(w.change) ? String((w.change.from as Json).path) : w.change.path;
    push(
      {
        pointer: w.change.pointer,
        message: `not applied: ${w.change.reason ?? w.change.rule} — with it the Bundle has an error it does not have now (${w.error.slice(0, 200)})`,
        category: w.change.category,
        candidates: [{ description: "apply this change, then fix the error it exposes", ...(patch ? { patch } : {}) }, { description: "leave as written" }],
      },
      at,
      fin ? "final" : "content",
    );
  }
  for (const i of args.repairIssues) {
    if (i.severity !== "error") continue;
    const pointer = args.map.pointer(i.path, "content", args.sent);
    push({ pointer, message: i.message, category: changeCategory({ rule: i.rule, path: i.path }), candidates: issueCandidates(i, pointer, args.sent) }, i.path, "content");
  }
  const back = new Map<string, string>();
  for (const [o, n] of Object.entries(args.idMap)) back.set(n, o);
  for (const u of args.unresolved) {
    const pointer = args.map.pointer(u.path, "final", args.sent);
    const target = resolvePointer(args.sent, pointer).found ? pointer : null;
    const outPtr = args.out !== undefined ? args.map.outPointer(u.path, "final", args.out) : null;
    const outPatches = new Map<AmbiguousCandidate, PatchOp[]>();
    const candidates = u.candidates.slice(0, 6).map((f) => {
      const sentUrl = back.get(f) ?? f;
      const ops: PatchOp[] = [{ op: "replace", path: target ?? pointer, value: sentUrl }];
      const c: AmbiguousCandidate = { description: `point it at ${sentUrl}`, ...(target && applyPatch(args.sent, ops) !== null ? { patch: ops } : {}) };
      // in the returned Bundle the entry has its finalized fullUrl
      if (outPtr !== null) outPatches.set(c, [{ op: "replace", path: outPtr, value: f }]);
      return c;
    });
    push({ pointer, message: `reference '${u.reference}': ${u.reason}`, category: "ids_references", candidates }, u.path, "final", outPatches);
  }
  for (const e of errorsOf(args.remaining)) {
    const category = errorCategory(String(e.message));
    if (!category) continue;
    const pointer = args.map.pointer(String(e.path ?? "Bundle"), "final", args.sent);
    // already covered: an item of the same category at / under the error's location (one of another category at the
    // same place — a withdrawn rename next to a value error — does not cover it)
    if (out.some((x) => x.category === category && (x.pointer === pointer || x.pointer.startsWith(`${pointer}/`)))) continue;
    push({ pointer, message: `${String(e.message).slice(0, 400)} — more than one fix is possible (or the record must say which); not changed`, category, candidates: [] }, String(e.path ?? "Bundle"), "final");
  }
  return out.map((it) => locateItem(it, where.get(it)!, args));
}

interface ItemSite {
  path: string;
  space: "content" | "final";
  outPatches?: Map<AmbiguousCandidate, PatchOp[]>;
}

/** Changes of the id / document normaliser (their paths are in final space). */
const FINALIZER_RULES = new Set<string>(["fullUrl-uuid", "reference-rewire", "resource-id", "bundle-type", "document-order"]);

/** Rewrite the pointer prefix `from` → `to` in a patch's paths (null when an op is outside `from`). */
function rebase(ops: PatchOp[], from: string, to: string): PatchOp[] | null {
  const re = (p: string): string | null => (p === from || p.startsWith(`${from}/`) ? to + p.slice(from.length) : null);
  const outOps: PatchOp[] = [];
  for (const op of ops) {
    const path = re(op.path);
    const fromP = op.from !== undefined ? re(op.from) : undefined;
    if (path === null || fromP === null) return null;
    outOps.push({ ...op, path, ...(fromP !== undefined ? { from: fromP } : {}) });
  }
  return outOps;
}

/**
 * Both pointers of an item resolve: `pointer` in the sent Bundle, `pointer_out` (when different) in the returned one —
 * an element that does not exist there is named by its nearest existing ancestor (pointer_note says so). Candidate
 * patches stay on the sent Bundle; `patch_out` is added when the returned Bundle needs other paths / values.
 */
function locateItem(it: AmbiguousItem, w: ItemSite, args: { sent: unknown; map: EntryMap; out?: unknown }): AmbiguousItem {
  const notes: string[] = [];
  const exactSent = it.pointer;
  const s = nearestExisting(args.sent, exactSent);
  if (!s.exact) notes.push(`${exactSent} does not exist in the sent Bundle: pointer names its nearest existing ancestor`);
  let pointerOut: string | undefined;
  let candidates = it.candidates;
  if (args.out !== undefined) {
    const exactOut = args.map.outPointer(w.path, w.space, args.out);
    const o = nearestExisting(args.out, exactOut);
    if (!o.exact) notes.push(`${exactOut} does not exist in the returned Bundle: pointer_out names its nearest existing ancestor`);
    if (o.pointer !== s.pointer) pointerOut = o.pointer;
    candidates = it.candidates.map((c) => {
      const given = w.outPatches?.get(c);
      const ops = given ?? (c.patch ? rebase(c.patch, exactSent, exactOut) : null);
      if (!ops || (c.patch && JSON.stringify(ops) === JSON.stringify(c.patch)) || !patchApplies(args.out, ops as unknown as JsonPatchOp[])) return c;
      return { ...c, patch_out: ops };
    });
  }
  return {
    pointer: s.pointer,
    ...(pointerOut !== undefined ? { pointer_out: pointerOut } : {}),
    ...(notes.length ? { pointer_note: notes.join("; ") } : {}),
    message: it.message,
    category: it.category,
    candidates,
  };
}

// ------------------------------------------------------------------------------------------------ validator-driven fixes

export interface AutoFixDeps {
  fetchStructureDefinition(url: string): Promise<Json | null>;
  /** The validator's issues for the whole Bundle (the finalize target profile included). */
  validate(bundle: Json): Promise<ValidatorIssue[]>;
  /** Display of a code in its CodeSystem (the official one among the valid displays). */
  lookupDisplay?(system: string, code: string): Promise<string | null>;
  /** Free text → codes of a CodeSystem (fhir_normalize_code): does another code of the system have exactly this display? */
  normalize?(text: string, target: { system?: string; valueSet?: string }, limit: number): Promise<NormalizeCandidate[]>;
  /** Expansion of a ValueSet (null = not expandable locally). */
  expandValueSet?(url: string, limit: number): Promise<{ codings: ExpandedCoding[]; total: number; truncated: boolean; incomplete?: boolean } | null>;
}

/** The displays a "Wrong Display Name" message lists as valid (one, or "one of N choices: 'a', 'b' …"). */
export function validDisplaysOf(message: string): string[] {
  const m = /Valid display is (?:one of \d+ choices: )?((?:'[^']*'(?: \([a-z-]+\))?(?:, )?)+)/u.exec(message);
  if (!m) return [];
  return [...m[1].matchAll(/'([^']*)'/gu)].map((x) => x[1]).filter((x) => x.trim());
}

/** Node holder / key at a dotted validator path (in the given tree; single-item arrays without an index stepped into). */
function locate(tree: Json, path: string): { holder: Json; key: string; index: number | null; value: unknown } | null {
  const segs = pathSegments(path);
  if (!segs.length) return null;
  let node: unknown = tree;
  for (let i = 0; i < segs.length; i++) {
    const { key, index } = segs[i];
    if (Array.isArray(node) && node.length === 1) node = node[0];
    if (!isObj(node) || !(key in node)) return null;
    if (i === segs.length - 1) {
      const raw = node[key];
      if (index !== null) return Array.isArray(raw) && index < raw.length ? { holder: node, key, index, value: raw[index] } : null;
      return { holder: node, key, index: null, value: raw };
    }
    node = node[key];
    if (index !== null) node = Array.isArray(node) ? node[index] : undefined;
  }
  return null;
}

function resourceAt(tree: Json, path: string): { resource: Json; rel: string } | null {
  const m = /^Bundle\.entry\[(\d+)\]\.resource((?:[.[].*)?)$/u.exec(String(path).replace(/\/\*[^*]*\*\//gu, ""));
  if (!m) return null;
  const r = Array.isArray(tree.entry) ? tree.entry[Number(m[1])]?.resource : null;
  return isObj(r) ? { resource: r, rel: m[2] } : null;
}

const codingsOf = (v: unknown): Json[] => (isObj(v) ? (Array.isArray(v.coding) ? v.coding.filter(isObj) : [v]) : Array.isArray(v) ? v.flatMap(codingsOf) : []);

/** Does an element definition pin {system, code} (fixed / pattern CodeableConcept / Coding / code)? */
function pins(el: Json, system: string, code: string): boolean {
  for (const k of Object.keys(el)) {
    if (!/^(fixed|pattern)(CodeableConcept|Coding|Code)$/u.test(k)) continue;
    const v = el[k];
    if (typeof v === "string") return v === code;
    if (codingsOf(v).some((c) => c.code === code && (!c.system || c.system === system))) return true;
  }
  return false;
}

async function profilesOf(deps: AutoFixDeps, resource: Json): Promise<Json[]> {
  const out: Json[] = [];
  for (const u of Array.isArray(resource.meta?.profile) ? resource.meta.profile : []) {
    if (typeof u !== "string") continue;
    const sd = await deps.fetchStructureDefinition(u).catch(() => null);
    if (sd?.snapshot?.element) out.push(sd);
  }
  return out;
}

const elementPath = (resourceType: string, rel: string): string => (resourceType + rel.replace(/\[\d+\]/gu, "")).replace(/\.ofType\([A-Za-z]+\)/gu, "");

/**
 * The system a wrongly-systemed Coding belongs to: the ValueSet bound to its element (a declared profile, else the core
 * definition) does not hold system#code but holds `code` with exactly the written display under ONE other system.
 */
async function systemByDisplay(deps: AutoFixDeps, resource: Json, elPath: string, system: string, code: string, given: string, sd: (u: string) => Promise<Json | null>): Promise<{ system: string; valueSet: string } | null> {
  if (!deps.expandValueSet) return null;
  const sds: Json[] = await profilesOf(deps, resource);
  const core = await sd(`http://hl7.org/fhir/StructureDefinition/${String(resource.resourceType)}`);
  if (core?.snapshot?.element) sds.push(core);
  const vss = new Set<string>();
  for (const p of sds) for (const el of p.snapshot.element as Json[]) if (el.path === elPath && isObj(el.binding) && typeof el.binding.valueSet === "string") vss.add(el.binding.valueSet);
  const hits = new Map<string, string>();
  for (const vs of vss) {
    const exp = await deps.expandValueSet(vs, 2000).catch(() => null);
    if (!exp || !exp.codings.length) continue;
    if (exp.codings.some((c) => c.code === code && c.system === system)) return null;
    for (const c of exp.codings) if (c.code === code && c.system && c.system !== system && typeof c.display === "string" && c.display.trim().toLowerCase() === given.trim().toLowerCase()) hits.set(c.system, vs);
  }
  if (hits.size !== 1) return null;
  const [[sys, vs]] = [...hits];
  return { system: sys, valueSet: vs };
}

const clonePlain = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/**
 * A fixed / pattern value that is a complete value of its element (filled when the element is absent): a primitive,
 * a Coding with system + code, a CodeableConcept whose codings all have system + code; else undefined.
 */
function filledValue(v: unknown): unknown {
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  const coded = (c: unknown): boolean => isObj(c) && typeof c.system === "string" && typeof c.code === "string";
  if (coded(v)) return v;
  if (isObj(v) && Array.isArray(v.coding) && v.coding.length && v.coding.every(coded)) return v;
  return undefined;
}

/** Properties a model wraps a plain string in. */
const STRING_HOLDERS = new Set(["text", "display", "value", "valueString"]);

/** The type codes of an element (declared profiles, else the core definition of the resource). */
async function elementTypes(deps: AutoFixDeps, resource: Json, elPath: string, sd: (u: string) => Promise<Json | null>): Promise<string[]> {
  const sds: Json[] = await profilesOf(deps, resource);
  const core = await sd(`http://hl7.org/fhir/StructureDefinition/${String(resource.resourceType)}`);
  if (core?.snapshot?.element) sds.push(core);
  for (const p of sds) {
    const el = (p.snapshot.element as Json[]).find((x) => x.path === elPath && !String(x.id ?? "").includes(":"));
    if (el && Array.isArray(el.type)) return el.type.map((t: Json) => String(t.code));
  }
  return [];
}

/** Does a value (code / Coding / CodeableConcept, or an array of them) carry `code` (under `system`, when it has one)? */
function carries(v: unknown, system: string | null, code: string): boolean {
  if (typeof v === "string") return v === code;
  if (Array.isArray(v)) return v.some((x) => carries(x, system, code));
  return codingsOf(v).some((c) => c.code === code && (!system || !c.system || c.system === system));
}

/**
 * A code written in the wrong element (AllergyIntolerance.type = 'medication', criticality = 'unconfirmed'): its own
 * required ValueSet does not hold it, and among the sibling elements (same parent, from the resource's declared
 * profiles + its core definition) exactly ONE has a required binding whose ValueSet holds it (under one system). The
 * value moves there — as a code, Coding or CodeableConcept (system + the ValueSet's display), an array when the target
 * repeats — when the target is absent; when the target already carries that code the misplaced copy is removed.
 * A target holding something else, several / no fitting siblings → left as written.
 */
async function codeToSibling(
  tree: Json,
  path: string,
  code: string,
  deps: AutoFixDeps,
  sd: (u: string) => Promise<Json | null>,
  allow: (rule: RepairRule, path: string) => boolean,
): Promise<RepairChange | null> {
  if (!deps.expandValueSet) return null;
  const loc = locate(tree, path);
  const at = resourceAt(tree, path);
  if (!loc || !at || loc.value !== code) return null;
  const pm = /^(.*)\.([A-Za-z]+)(?:\[\d+\])?$/u.exec(path);
  if (!pm || pm[2] !== loc.key) return null;
  const elPath = elementPath(String(at.resource.resourceType), at.rel);
  const parent = elPath.slice(0, elPath.lastIndexOf("."));
  const sds: Json[] = await profilesOf(deps, at.resource);
  const core = await sd(`http://hl7.org/fhir/StructureDefinition/${String(at.resource.resourceType)}`);
  if (core?.snapshot?.element) sds.push(core);
  const fits = new Map<string, { type: string; max: string; system: string | null; display: string | null; valueSet: string }>();
  const own = new Set<string>();
  for (const p of sds) {
    for (const el of p.snapshot.element as Json[]) {
      const ep = String(el.path ?? "");
      if (ep === elPath && isObj(el.binding) && typeof el.binding.valueSet === "string") own.add(el.binding.valueSet);
      if (!ep.startsWith(`${parent}.`) || ep.slice(parent.length + 1).includes(".") || String(el.id ?? "").includes(":")) continue;
      const name = ep.slice(parent.length + 1);
      if (name === loc.key || !isObj(el.binding) || el.binding.strength !== "required" || typeof el.binding.valueSet !== "string") continue;
      const type = (Array.isArray(el.type) ? el.type : []).map((t: Json) => String(t.code))[0];
      if (!["code", "Coding", "CodeableConcept"].includes(type) || el.max === "0") continue;
      const exp = await deps.expandValueSet(el.binding.valueSet, 500).catch(() => null);
      if (!exp || !exp.codings.length) continue;
      const hits = exp.codings.filter((c) => c.code === code);
      const systems = new Set(hits.map((c) => c.system ?? ""));
      if (!hits.length) continue;
      if (systems.size !== 1) return null;
      const prev = fits.get(name);
      if (prev && prev.valueSet !== el.binding.valueSet) continue;
      fits.set(name, { type, max: String(el.max ?? "1"), system: hits[0].system ?? null, display: hits[0].display ?? null, valueSet: el.binding.valueSet });
    }
  }
  // the element's own required ValueSet must not hold the code (the validator said so; double-check what we can expand)
  for (const vs of own) {
    const exp = await deps.expandValueSet(vs, 500).catch(() => null);
    if (exp && exp.codings.some((c) => c.code === code)) return null;
  }
  if (fits.size !== 1) return null;
  const [[name, t]] = [...fits];
  const holder = loc.holder;
  const targetPath = `${pm[1]}.${name}`;
  if (!allow("code", targetPath) || !allow("code", path)) return null;
  const removeSource = (): void => {
    if (loc.index === null) delete holder[loc.key];
    else {
      (holder[loc.key] as unknown[]).splice(loc.index, 1);
      if (!(holder[loc.key] as unknown[]).length) delete holder[loc.key];
    }
  };
  if (holder[name] !== undefined) {
    if (!carries(holder[name], t.system, code)) return null;
    removeSource();
    return { path: targetPath, from: { path, value: code }, to: toPlain(holder[name]), rule: "code", reason: `'${code}' is not a code of ${loc.key} (required ${[...own][0]?.split("|")[0] ?? "ValueSet"}); it is a code of ${name}, which already carries it: the misplaced copy is removed` };
  }
  const coding: Json = { ...(t.system ? { system: t.system } : {}), code, ...(t.display ? { display: t.display } : {}) };
  const one: unknown = t.type === "code" ? code : t.type === "Coding" ? coding : { coding: [coding] };
  const value = t.max === "1" ? one : [one];
  // keep the property order: the moved value takes the place of the misplaced one
  const entries = Object.entries(holder);
  for (const k of Object.keys(holder)) delete holder[k];
  for (const [k, x] of entries) {
    if (k === loc.key) {
      if (loc.index !== null && Array.isArray(x) && x.length > 1) holder[k] = x.filter((_, i) => i !== loc.index);
      holder[name] = value;
    } else holder[k] = x;
  }
  return { path: targetPath, from: { path, value: code }, to: value, rule: "code", reason: `'${code}' is not a code of ${loc.key}; ${name} is the one sibling element whose required ValueSet ${t.valueSet.split("|")[0]} holds it${t.system ? ` (${t.system})` : ""}: moved` };
}

/**
 * The validator-driven layer-1 fixes, in place on `tree` (content space). One validation of the Bundle; each error
 * whose fix the profile or the Bundle determines is fixed (rule / message):
 *   fixed-value  "Value is 'A' but is fixed to 'B' in the profile <url>#<id>" → B (the definition's fixed / pattern
 *                primitive; the value must still be A);
 *   display      "Wrong Display Name … for <system>#<code> … Valid display is '<d>'" where a profile of the resource
 *                fixes / patterns that code at that element (Composition.type, a section slice's code …) → d;
 *   shape        "The Profile … allows for the type T but found type S" on a choice element whose only allowed type
 *                is T and whose value has a lossless T reading ("true" → true) → renamed `<stem>T`;
 *   document     "Composition.section.text: minimum required = 1" for a section with entries → a generated narrative
 *                listing its entries (their names in the Bundle).
 * Round 2 (v19 R1):
 *   system       "Wrong Display Name" where the bound ValueSet holds the code with exactly that display under one
 *                other system (systemByDisplay) → that system;
 *   display      "Wrong Display Name" of an unpinned code: no other code of the system named so (search: display or
 *                exact designation), ≥ half the words shared with one of its names (or some and the search ranks it
 *                first), no required binding rejecting the code → its display (the wording kept as CC.text);
 *   code         "The System URI could not be determined for the code" of a code element → the one sibling element
 *                whose required ValueSet holds it (codeToSibling);
 *   shape        "This property must be a simple value, not an Object" for a string / markdown element holding one
 *                string property → that string.
 * `blocked` (changeBlockKey) withdraws single fixes (the guard).
 */
export async function autoFixBundle(tree: Json, deps: AutoFixDeps, blocked: ReadonlySet<string> = new Set()): Promise<{ changes: RepairChange[]; issues: RepairIssue[] }> {
  const changes: RepairChange[] = [];
  const issues: RepairIssue[] = [];
  let found: ValidatorIssue[];
  try {
    found = errorsOf(await deps.validate(toPlain(tree) as Json));
  } catch {
    return { changes, issues };
  }
  const allow = (rule: RepairRule, path: string): boolean => !blocked.has(changeBlockKey(rule, path));
  const done = new Set<string>();
  const sdCache = new Map<string, Promise<Json | null>>();
  const sd = (u: string): Promise<Json | null> => {
    if (!sdCache.has(u)) sdCache.set(u, deps.fetchStructureDefinition(u).catch(() => null));
    return sdCache.get(u)!;
  };
  // Codings a required binding rejects ("The code provided (s#c) was not found in the value set … is required")
  const requiredMiss = new Set<string>();
  for (const e of found) {
    if (/^The code provided \(.*\) was not found in the value set .* and a code from this value set is required/su.test(String(e.message ?? ""))) {
      requiredMiss.add(String(e.path ?? "").replace(/\/\*[^*]*\*\//gu, "").replace(/\.display$/u, ""));
    }
  }
  const norms = new Map<string, Promise<NormalizeCandidate[] | null>>();
  const memoNorm = (text: string, system: string): Promise<NormalizeCandidate[] | null> => {
    const k = `${system}\u0000${text}`;
    if (!norms.has(k)) norms.set(k, deps.normalize ? deps.normalize(text, { system }, 8).catch(() => null) : Promise.resolve(null));
    return norms.get(k)!;
  };
  for (const e of found) {
    const path = String(e.path ?? "").replace(/\/\*[^*]*\*\//gu, "");
    const msg = String(e.message ?? "");
    if (done.has(path)) continue;
    // ---- fixed value
    let m = /^Value is '([^']*)' but is fixed to '([^']*)' in the profile (\S+?)#(\S+)$/u.exec(msg);
    if (m) {
      const loc = locate(tree, path);
      const [, was, fixedText, profile, id] = m;
      if (!loc || loc.index !== null || typeof loc.value !== "string" || loc.value !== was || !allow("fixed-value", path)) continue;
      const def = ((await sd(profile))?.snapshot?.element as Json[] | undefined)?.find((x) => x.id === id);
      const key = def ? Object.keys(def).find((k) => /^(fixed|pattern)[A-Z]/u.test(k)) : undefined;
      const value = key !== undefined ? def![key] : fixedText;
      if (value === null || typeof value === "object" || String(value) !== fixedText) continue;
      done.add(path);
      // release v1: an existing value that differs from the fixed one is the record's — never overwritten; only the
      // same value in another representation (whitespace, a URI alias of the same system) is rewritten
      if (!sameValue(was, value)) {
        const status = isStatusElement(loc.key, def);
        issues.push({
          path,
          rule: "fixed-value",
          code: status ? "fixed-status-conflict" : "fixed-value-conflict",
          severity: "error",
          message: conflictMessage({ path, written: was, required: value, where: `the profile (${profile.split("|")[0]}#${id})`, status }),
          candidates: conflictCandidates(value, status),
        });
        continue;
      }
      loc.holder[loc.key] = value;
      changes.push({ path, from: was, to: value, rule: "fixed-value", reason: `the profile fixes ${id} to '${fixedText}' (${profile.split("|")[0]}); '${was}' is the same value written differently` });
      continue;
    }
    // ---- a required element the profile fixes / patterns, absent → filled with that value (release v1: a MISSING
    // fixed value may be filled; an existing one is never overwritten)
    m = /^([A-Z][A-Za-z]+(?:\.[a-z][A-Za-z]*)+): minimum required = \d+, but only found 0 \(from (\S+?)\)$/u.exec(msg);
    if (m && !/\.section\.text$/u.test(m[1])) {
      const [, elPath, profile] = m;
      const holderLoc = path === "Bundle" ? { value: tree } : locate(tree, path);
      const holder = holderLoc && isObj(holderLoc.value) ? holderLoc.value : null;
      const at = resourceAt(tree, path);
      const name = elPath.slice(elPath.lastIndexOf(".") + 1);
      if (!holder || !at || holder[name] !== undefined || holder[`_${name}`] !== undefined) continue;
      if (elementPath(String(at.resource.resourceType), at.rel) !== elPath.slice(0, elPath.lastIndexOf("."))) continue;
      const def = ((await sd(profile))?.snapshot?.element as Json[] | undefined)?.find((x) => x.path === elPath && !String(x.id ?? "").includes(":"));
      const key = def ? Object.keys(def).find((k) => /^(fixed|pattern)[A-Z]/u.test(k)) : undefined;
      if (!def || key === undefined) continue;
      const value = def[key];
      const filled = filledValue(value);
      if (filled === undefined || !allow("fixed-value", `${path}.${name}`)) continue;
      const one = clonePlain(filled);
      holder[name] = String(def.max ?? "1") === "1" ? one : [one];
      changes.push({ path: `${path}.${name}`, from: null, to: holder[name], rule: "fixed-value", reason: `${elPath} is required and absent; the profile ${key.startsWith("fixed") ? "fixes" : "patterns"} it to ${JSON.stringify(value)} (${profile.split("|")[0]}): filled` });
      continue;
    }
    // ---- display of a code the profile pins
    m = /^Wrong Display Name '(.*)' for (\S+?)#(\S+?)\.? (?:-- )?Valid display is (?:one of \d+ choices: )?'([^']*)'/su.exec(msg);
    if (m) {
      const [, given, system, code, valid] = m;
      const at = resourceAt(tree, path);
      if (!at) continue;
      // the validator reports at the Coding (or its display)
      const codingPath = path.replace(/\.display$/u, "");
      const loc = locate(tree, codingPath);
      const coding = loc ? (loc.index !== null ? loc.value : loc.value) : null;
      const target = isObj(coding) && coding.code === code && coding.display === given ? coding : null;
      if (!target || !allow("display", `${codingPath}.display`)) continue;
      const elPath = elementPath(String(at.resource.resourceType), at.rel.replace(/\.display$/u, ""));
      const parentPath = elPath.replace(/\.coding$/u, "");
      let pinned = false;
      for (const p of await profilesOf(deps, at.resource)) {
        for (const el of p.snapshot.element as Json[]) {
          if ((el.path === parentPath || el.path === elPath) && pins(el, system, code)) pinned = true;
          if (el.path === `${elPath}.code` && el.fixedCode === code) pinned = true;
        }
      }
      if (pinned) {
        target.display = valid;
        done.add(path);
        changes.push({ path: `${codingPath}.display`, from: given, to: valid, rule: "display", reason: `the profile pins ${system}#${code} at ${parentPath}: the code is determined, its display is '${valid}'` });
        continue;
      }
      // v19 R1 round 2: a code the bound ValueSet holds under ANOTHER system with exactly this display → that system
      const sw = await systemByDisplay(deps, at.resource, parentPath, system, code, given, sd);
      if (sw && allow("system", `${codingPath}.system`)) {
        target.system = sw.system;
        done.add(path);
        changes.push({ path: `${codingPath}.system`, from: system, to: sw.system, rule: "system", reason: `${system}#${code} is not '${given}'; the bound ValueSet ${sw.valueSet.split("|")[0]} holds ${code} '${given}' only under ${sw.system}` });
        continue;
      }
      // v19 R1 round 2: the code is determined (it exists — the validator knows its displays) and no other code of its
      // system has exactly this display (then the display, not the code, is what is wrong) → the code's display
      const all = validDisplaysOf(msg);
      if (!all.length || !deps.normalize || !allow("display", `${codingPath}.display`)) continue;
      const siblings = loc && loc.index !== null && Array.isArray(loc.holder[loc.key]) ? (loc.holder[loc.key] as unknown[]).filter((c) => isObj(c) && c !== target && c.system === system) : [];
      if (siblings.length) continue;
      const cands = await memoNorm(given, system);
      if (cands === null) continue;
      // another code of the system named exactly so (its display, or a designation the search matched exactly)
      const named = cands.filter((c) => c.code !== code && (c.system ?? system) === system && (c.exact === true || (typeof c.display === "string" && bag(c.display) === bag(given) && bag(given) !== "")));
      if (named.length) continue;
      // a code the required ValueSet rejects is itself wrong: its display is the evidence of what was meant — kept
      if (requiredMiss.has(codingPath)) continue;
      // a display that shares too little with the code's names names another concept (ECOG written on an NYHA code,
      // 'Cancer staging' on a Gleason grade finding): the code, not the display, is in doubt — kept (ambiguous). Enough:
      // half of the words shared with one of its names, or some shared and the terminology search ranks this code first.
      const best = Math.max(0, ...all.map((v) => overlap(given, v)));
      if (!(best >= 0.5 || (best > 0 && cands[0]?.code === code))) continue;
      let official = deps.lookupDisplay ? await deps.lookupDisplay(system, code).catch(() => null) : null;
      if (official && !all.some((d) => d.toLowerCase() === official!.toLowerCase())) official = null;
      const to = official ?? all[0];
      target.display = to;
      done.add(path);
      changes.push({ path: `${codingPath}.display`, from: given, to, rule: "display", reason: `${system}#${code} is a code of its system and no other code of it is named '${given}': the code is determined, its display is '${to}'` });
      const ccPath = codingPath.replace(/\.coding(?:\[\d+\])?$/u, "");
      if (ccPath !== codingPath && loc && loc.key === "coding") {
        const cc = locate(tree, ccPath);
        if (cc && isObj(cc.value) && cc.value.text === undefined) {
          cc.value.text = given;
          changes.push({ path: `${ccPath}.text`, from: null, to: given, rule: "display", reason: "the original wording is kept as CodeableConcept.text" });
        }
      }
      continue;
    }
    // ---- a choice type the profile narrows to one type
    m = /^The Profile '(\S+)' definition allows for the type (\w+) but found type (\w+)$/u.exec(msg);
    if (m) {
      const [, , allowed, foundType] = m;
      const pm = /^(.*)\.([A-Za-z]+)\.ofType\(([A-Za-z]+)\)$/u.exec(String(e.path ?? ""));
      if (!pm || pm[3] !== foundType) continue;
      const stem = pm[2];
      const key = stem + foundType[0].toUpperCase() + foundType.slice(1);
      const holderLoc = pm[1] === "Bundle" ? { value: tree } : locate(tree, pm[1]);
      const holder = holderLoc && isObj(holderLoc.value) ? holderLoc.value : null;
      if (!holder || !(key in holder) || `_${key}` in holder) continue;
      const newKey = stem + allowed[0].toUpperCase() + allowed.slice(1);
      if (newKey in holder) continue;
      const v = fitPrimitive(allowed, holder[key]);
      if (v === undefined || !allow("shape", `${pm[1]}.${newKey}`)) continue;
      const entries = Object.entries(holder);
      for (const k of Object.keys(holder)) delete holder[k];
      for (const [k, x] of entries) holder[k === key ? newKey : k] = k === key ? v : x;
      done.add(path);
      changes.push({ path: `${pm[1]}.${newKey}`, from: { path: `${pm[1]}.${key}`, value: entries.find(([k]) => k === key)![1] }, to: v, rule: "shape", reason: `the profile allows only ${allowed} for ${stem}[x] and the value reads as ${allowed}` });
      continue;
    }
    // ---- a string element written as an object holding just that string ({text: 'Tdap'} for protocolApplied.series)
    if (/^This property must be a simple value, not an Object \(/u.test(msg)) {
      const loc = locate(tree, path);
      const at = resourceAt(tree, path);
      const v = loc?.value;
      const keys = isObj(v) ? Object.keys(v) : [];
      if (!loc || !at || !isObj(v) || keys.length !== 1 || !STRING_HOLDERS.has(keys[0]) || typeof v[keys[0]] !== "string" || !String(v[keys[0]]).trim() || !allow("shape", path)) continue;
      const types = await elementTypes(deps, at.resource, elementPath(String(at.resource.resourceType), at.rel), sd);
      if (types.length !== 1 || !["string", "markdown"].includes(types[0])) continue;
      const text = String(v[keys[0]]);
      if (loc.index === null) loc.holder[loc.key] = text;
      else (loc.holder[loc.key] as unknown[])[loc.index] = text;
      done.add(path);
      changes.push({ path, from: toPlain(v), to: text, rule: "shape", reason: `${loc.key} is a ${types[0]}; the object holds nothing but that text (${keys[0]})` });
      continue;
    }
    // ---- a code its element's required ValueSet lacks, held by exactly ONE sibling element's required ValueSet
    m = /^The System URI could not be determined for the code '([^']*)' in the ValueSet '([^']*)'/u.exec(msg);
    if (m) {
      const moved = await codeToSibling(tree, path, m[1], deps, sd, allow);
      if (moved) {
        done.add(path);
        changes.push(moved);
      }
      continue;
    }
    // ---- a required section narrative from the section's own entries
    if (/^Composition\.section\.text: minimum required = 1, but only found 0/u.test(msg)) {
      const loc = locate(tree, path);
      const sec = loc && isObj(loc.value) ? loc.value : null;
      if (!sec || sec.text !== undefined || !Array.isArray(sec.entry) || !sec.entry.length || !allow("document", `${path}.text`)) continue;
      const index = new Map<string, Json>();
      for (const en of Array.isArray(tree.entry) ? tree.entry : []) {
        if (!isObj(en) || !isObj(en.resource)) continue;
        if (typeof en.fullUrl === "string") index.set(en.fullUrl, en.resource);
        if (en.resource.resourceType && en.resource.id) index.set(`${en.resource.resourceType}/${en.resource.id}`, en.resource);
      }
      const names = (sec.entry as Json[]).map((x) => (isObj(x) && typeof x.reference === "string" && index.has(x.reference) ? nameOf(toPlain(index.get(x.reference)) as Json) : null));
      if (!names.length || names.some((n) => n === null)) continue;
      const esc = (t: string): string => t.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
      sec.text = { status: "generated", div: `<div xmlns="${XHTML_NS}"><ul>${(names as string[]).map((n) => `<li>${esc(n)}</li>`).join("")}</ul></div>` };
      done.add(path);
      changes.push({ path: `${path}.text`, from: null, to: sec.text, rule: "document", reason: "the profile requires a section narrative: generated from the section's entries (their names in this Bundle)" });
      continue;
    }
  }
  return { changes, issues };
}

/** Per-category counts of annotated changes (summary). */
export function countByCategory(changes: Array<{ category: R1Category }>): Record<R1Category, number> {
  const out = Object.fromEntries(R1_CATEGORIES.map((c) => [c, 0])) as Record<R1Category, number>;
  for (const c of changes) out[c.category]++;
  return out;
}
