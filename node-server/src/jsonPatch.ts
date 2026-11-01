/**
 * RFC 6901 JSON Pointer and RFC 6902 JSON Patch, small and dependency-free.
 *
 * Used by the validation pointer layer (fhirSuggestions/pointers.ts) to address issues in the
 * instance exactly as the caller sent it and to verify that every proposed patch applies.
 * Pure: `applyPatch` works on the document it is given (clone it first to keep the original).
 */

export type JsonPatchOp =
  | { op: "add"; path: string; value: unknown }
  | { op: "remove"; path: string }
  | { op: "replace"; path: string; value: unknown }
  | { op: "move"; from: string; path: string }
  | { op: "copy"; from: string; path: string }
  | { op: "test"; path: string; value: unknown };

export class JsonPatchError extends Error {
  constructor(
    message: string,
    /** Index of the failing operation in the patch. */
    public readonly opIndex: number = -1,
  ) {
    super(message);
    this.name = "JsonPatchError";
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Escape one reference token (RFC 6901 §3: `~` → `~0`, `/` → `~1`). */
export function escapeToken(token: string): string {
  return token.replace(/~/g, "~0").replace(/\//g, "~1");
}

/** Tokens → JSON Pointer string (`[]` → "" = the whole document). */
export function formatPointer(tokens: Array<string | number>): string {
  return tokens.map((t) => "/" + escapeToken(String(t))).join("");
}

/** JSON Pointer string → tokens. Throws JsonPatchError on a malformed pointer. */
export function parsePointer(pointer: string): string[] {
  if (pointer === "") return [];
  if (typeof pointer !== "string" || pointer[0] !== "/") throw new JsonPatchError(`invalid JSON Pointer '${String(pointer)}'`);
  return pointer
    .slice(1)
    .split("/")
    .map((t) => {
      if (/~(?![01])/.test(t)) throw new JsonPatchError(`invalid escape in JSON Pointer '${pointer}'`);
      return t.replace(/~1/g, "/").replace(/~0/g, "~");
    });
}

/** An array index token: "0" or digits without a leading zero. */
function arrayIndex(token: string): number | null {
  return /^(0|[1-9]\d*)$/.test(token) ? Number(token) : null;
}

/** The value a pointer designates; `found: false` when any step does not exist. */
export function resolvePointer(doc: unknown, pointer: string | string[]): { found: boolean; value?: unknown } {
  let tokens: string[];
  try {
    tokens = Array.isArray(pointer) ? pointer : parsePointer(pointer);
  } catch {
    return { found: false };
  }
  let node: unknown = doc;
  for (const t of tokens) {
    if (Array.isArray(node)) {
      const i = arrayIndex(t);
      if (i === null || i >= node.length) return { found: false };
      node = node[i];
    } else if (isObj(node)) {
      if (!Object.prototype.hasOwnProperty.call(node, t)) return { found: false };
      node = node[t];
    } else return { found: false };
  }
  return { found: true, value: node };
}

/** Structural equality of JSON values (object key order ignored). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => jsonEqual(x, b[i]));
  }
  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && jsonEqual(a[k], b[k]));
  }
  return false;
}

/** Deep copy of a JSON value (plain objects / arrays / primitives only). */
export function cloneJson<T>(v: T): T {
  if (Array.isArray(v)) return v.map((x) => cloneJson(x)) as unknown as T;
  if (isObj(v)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v)) out[k] = cloneJson(v[k]);
    return out as T;
  }
  return v;
}

/** Parent container and last token of a pointer (throws when the parent does not exist). */
function parentOf(doc: unknown, pointer: string, opIndex: number): { parent: unknown; key: string } {
  const tokens = parsePointer(pointer);
  if (!tokens.length) throw new JsonPatchError("the root has no parent", opIndex);
  const key = tokens[tokens.length - 1];
  const r = resolvePointer(doc, tokens.slice(0, -1));
  if (!r.found || !(Array.isArray(r.value) || isObj(r.value))) throw new JsonPatchError(`parent of '${pointer}' does not exist`, opIndex);
  return { parent: r.value, key };
}

function addAt(doc: unknown, pointer: string, value: unknown, opIndex: number): unknown {
  if (pointer === "") return value;
  const { parent, key } = parentOf(doc, pointer, opIndex);
  if (Array.isArray(parent)) {
    const i = key === "-" ? parent.length : arrayIndex(key);
    if (i === null || i > parent.length) throw new JsonPatchError(`array index '${key}' out of range at '${pointer}'`, opIndex);
    parent.splice(i, 0, value);
  } else (parent as Record<string, unknown>)[key] = value;
  return doc;
}

function removeAt(doc: unknown, pointer: string, opIndex: number): { doc: unknown; removed: unknown } {
  if (pointer === "") throw new JsonPatchError("cannot remove the whole document", opIndex);
  const { parent, key } = parentOf(doc, pointer, opIndex);
  if (Array.isArray(parent)) {
    const i = arrayIndex(key);
    if (i === null || i >= parent.length) throw new JsonPatchError(`array index '${key}' out of range at '${pointer}'`, opIndex);
    const [removed] = parent.splice(i, 1);
    return { doc, removed };
  }
  const obj = parent as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(obj, key)) throw new JsonPatchError(`'${pointer}' does not exist`, opIndex);
  const removed = obj[key];
  delete obj[key];
  return { doc, removed };
}

/**
 * Apply an RFC 6902 patch to `doc` (mutated in place where possible) and return the result
 * (a different value only when the root itself is replaced). Throws JsonPatchError on the
 * first operation that does not apply; the document may then be partially modified, so
 * callers that need atomicity pass a clone.
 */
export function applyPatch(doc: unknown, ops: JsonPatchOp[]): unknown {
  let cur = doc;
  ops.forEach((op, i) => {
    if (!op || typeof op !== "object" || typeof (op as { path?: unknown }).path !== "string") throw new JsonPatchError("operation without a path", i);
    switch (op.op) {
      case "add":
        if (!("value" in op)) throw new JsonPatchError("add without a value", i);
        cur = addAt(cur, op.path, cloneJson(op.value), i);
        break;
      case "remove":
        cur = removeAt(cur, op.path, i).doc;
        break;
      case "replace": {
        if (!("value" in op)) throw new JsonPatchError("replace without a value", i);
        if (op.path === "") {
          cur = cloneJson(op.value);
          break;
        }
        if (!resolvePointer(cur, op.path).found) throw new JsonPatchError(`'${op.path}' does not exist`, i);
        const { parent, key } = parentOf(cur, op.path, i);
        if (Array.isArray(parent)) parent[Number(key)] = cloneJson(op.value);
        else (parent as Record<string, unknown>)[key] = cloneJson(op.value);
        break;
      }
      case "move": {
        if (typeof op.from !== "string") throw new JsonPatchError("move without from", i);
        if (op.from === op.path) {
          if (!resolvePointer(cur, op.from).found) throw new JsonPatchError(`'${op.from}' does not exist`, i);
          break;
        }
        if (op.path.startsWith(op.from + "/")) throw new JsonPatchError(`cannot move '${op.from}' into its own child`, i);
        const r = removeAt(cur, op.from, i);
        cur = addAt(r.doc, op.path, r.removed, i);
        break;
      }
      case "copy": {
        if (typeof op.from !== "string") throw new JsonPatchError("copy without from", i);
        const r = resolvePointer(cur, op.from);
        if (!r.found) throw new JsonPatchError(`'${op.from}' does not exist`, i);
        cur = addAt(cur, op.path, cloneJson(r.value), i);
        break;
      }
      case "test": {
        const r = resolvePointer(cur, op.path);
        if (!r.found || !jsonEqual(r.value, op.value)) throw new JsonPatchError(`test failed at '${op.path}'`, i);
        break;
      }
      default:
        throw new JsonPatchError(`unknown op '${String((op as { op?: unknown }).op)}'`, i);
    }
  });
  return cur;
}

/** Whether `ops` applies cleanly to a copy of `doc` (`doc` itself is never modified). */
export function patchApplies(doc: unknown, ops: JsonPatchOp[]): boolean {
  try {
    applyPatch(cloneJson(doc), ops);
    return true;
  } catch {
    return false;
  }
}
