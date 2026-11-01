/**
 * ISSUES_v19 R1 — layer 1 of fhir_finalize_bundle: every structural error with exactly ONE correct fix is fixed by
 * the MCP, every change is reported against the Bundle AS SENT, what has several possible fixes is reported as
 * `ambiguous` (with RFC 6902 candidates where they can be written), and finalize never adds an error.
 *
 *   errorCategory / changeCategory   the R1 categories (shape, narrative, display, unrecognized_property,
 *                                    system_code, ids_references, document_structure, fixed_pattern);
 *   autoFixBundle                    validator-driven fixes on the content-repaired Bundle (a value the profile
 *                                    fixes, the display of a code the profile pins, a choice type the profile
 *                                    narrows to one, a required section narrative from the section's entries);
 *   EntryMap / annotateChanges       RFC 6901 pointers relative to the Bundle as sent (entries the finalizer
 *                                    reordered, dropped duplicates and entries moved in from Bundle level mapped
 *                                    back), with before / after / category;
 *   guardNoNewErrors                 validates the Bundle as sent and as finalized; an error the finalized Bundle
 *                                    has that the sent one does not (multiset by message, entry order and minted
 *                                    UUIDs ignored) withdraws the change(s) it is owed to and the pipeline runs
 *                                    again without them (≤ 3 rounds, then nothing is applied);
 *   buildAmbiguous                   the not-uniquely-fixable items (withdrawn changes, repair issues with
 *                                    candidates, unresolved references, remaining R1-category errors).
 * Everything is read from StructureDefinitions / the validator's own messages (validator_cli wording) — no IG strings.
 * Nothing clinical is invented: values come from the profile (fixed / pattern / pinned code displays) or from the
 * Bundle itself (section narratives list the section's own entries).
 */

import { entryOrderOf, type FinalizeChange, type FinalizeUnresolved } from "../fhirBundleFinalize.js";
import { toPlain } from "../losslessJson.js";
import { nameOf } from "./document.js";
import { fitPrimitive } from "./shape.js";
import type { RepairChange, RepairIssue, RepairRule } from "./types.js";

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
  return out;
}

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
export async function guardNoNewErrors<R extends PipelineResult>(
  sent: Json,
  run: (d: Disabled) => Promise<R>,
  validate: (bundle: Json) => Promise<ValidatorIssue[] | null>,
  rounds = 3,
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
    const fresh = newErrors(before, post);
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
}

export interface AmbiguousItem {
  pointer: string;
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
}): AmbiguousItem[] {
  const out: AmbiguousItem[] = [];
  const seen = new Set<string>();
  const push = (it: AmbiguousItem): void => {
    const k = `${it.pointer}\u0000${it.message}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(it);
  };
  for (const w of args.withdrawn) {
    const patch = changePatch(w.change, args.sent);
    push({
      pointer: w.change.pointer,
      message: `not applied: ${w.change.reason ?? w.change.rule} — with it the Bundle has an error it does not have now (${w.error.slice(0, 200)})`,
      category: w.change.category,
      candidates: [{ description: "apply this change, then fix the error it exposes", ...(patch ? { patch } : {}) }, { description: "leave as written" }],
    });
  }
  for (const i of args.repairIssues) {
    if (i.severity !== "error") continue;
    const pointer = args.map.pointer(i.path, "content", args.sent);
    push({ pointer, message: i.message, category: changeCategory({ rule: i.rule, path: i.path }), candidates: issueCandidates(i, pointer, args.sent) });
  }
  const back = new Map<string, string>();
  for (const [o, n] of Object.entries(args.idMap)) back.set(n, o);
  for (const u of args.unresolved) {
    const pointer = args.map.pointer(u.path, "final", args.sent);
    const target = resolvePointer(args.sent, pointer).found ? pointer : null;
    push({
      pointer,
      message: `reference '${u.reference}': ${u.reason}`,
      category: "ids_references",
      candidates: u.candidates.slice(0, 6).map((f) => {
        const sentUrl = back.get(f) ?? f;
        const ops: PatchOp[] = [{ op: "replace", path: target ?? pointer, value: sentUrl }];
        return { description: `point it at ${sentUrl}`, ...(target && applyPatch(args.sent, ops) !== null ? { patch: ops } : {}) };
      }),
    });
  }
  for (const e of errorsOf(args.remaining)) {
    const category = errorCategory(String(e.message));
    if (!category) continue;
    const pointer = args.map.pointer(String(e.path ?? "Bundle"), "final", args.sent);
    if (out.some((x) => x.pointer === pointer || (x.pointer.startsWith(`${pointer}/`) && x.category === category))) continue;
    push({ pointer, message: `${String(e.message).slice(0, 400)} — more than one fix is possible (or the record must say which); not changed`, category, candidates: [] });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ validator-driven fixes

export interface AutoFixDeps {
  fetchStructureDefinition(url: string): Promise<Json | null>;
  /** The validator's issues for the whole Bundle (the finalize target profile included). */
  validate(bundle: Json): Promise<ValidatorIssue[]>;
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
      loc.holder[loc.key] = value;
      done.add(path);
      changes.push({ path, from: was, to: value, rule: "fixed-value", reason: `the profile fixes ${id} to '${fixedText}' (${profile.split("|")[0]})` });
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
      if (!pinned) continue;
      target.display = valid;
      done.add(path);
      changes.push({ path: `${codingPath}.display`, from: given, to: valid, rule: "display", reason: `the profile pins ${system}#${code} at ${parentPath}: the code is determined, its display is '${valid}'` });
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
