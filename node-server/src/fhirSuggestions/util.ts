/** Shared helpers of the suggestion layer: string similarity, instance paths, ordering. */

import type { Suggestion } from "./types.js";

export function levenshtein(a: string, b: string, max = Infinity): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  // Optimal string alignment distance (Damerau: an adjacent transposition costs 1).
  let pp: number[] = new Array(b.length + 1).fill(0);
  let prev: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur: number[] = new Array(b.length + 1);
    cur[0] = i;
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      let d = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, pp[j - 2] + 1);
      cur[j] = d;
      if (d < rowMin) rowMin = d;
    }
    if (rowMin > max) return max + 1;
    pp = prev;
    prev = cur;
  }
  return prev[b.length];
}

/** Normalised edit similarity in [0, 1] (1 = equal). */
export function editSim(a: string, b: string): number {
  const n = Math.max(a.length, b.length);
  if (!n) return 1;
  return 1 - levenshtein(a, b) / n;
}

/** Word tokens: camelCase / kebab / snake / punctuation boundaries, lower-cased. */
export function tokens(s: string): string[] {
  return String(s || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9㐀-鿿]+/)
    .filter((t) => t !== "");
}

export function jaccard(a: string[], b: string[]): number {
  if (!a.length && !b.length) return 1;
  const A = new Set(a);
  const B = new Set(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Similarity of two short labels (names, codes, displays): best of edit and token overlap. */
export function textSim(a: string, b: string): number {
  const x = String(a || "").toLowerCase().trim();
  const y = String(b || "").toLowerCase().trim();
  if (!x || !y) return 0;
  if (x === y) return 1;
  const e = editSim(x, y);
  const j = jaccard(tokens(a), tokens(b));
  const contain = x.length >= 3 && y.length >= 3 && (x.includes(y) || y.includes(x)) ? 0.75 : 0;
  return Math.max(e, j * 0.95, contain);
}

export function round2(x: number): number {
  return Math.round(Math.max(0, Math.min(1, x)) * 100) / 100;
}

/** Stable order: confidence desc, then kind, then value. Duplicates (kind+system+value) collapse to the best. */
export function rankSuggestions(list: Suggestion[], max: number): Suggestion[] {
  const best = new Map<string, Suggestion>();
  for (const s of list) {
    const k = `${s.kind}\u0000${s.system ?? ""}\u0000${s.value}`;
    const cur = best.get(k);
    if (!cur || s.confidence > cur.confidence) best.set(k, { ...s, confidence: round2(s.confidence) });
  }
  return [...best.values()]
    .sort((a, b) => b.confidence - a.confidence || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0) || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0))
    .slice(0, max);
}

// --------------------------------------------------------------------------- //
// Instance paths (the validator's dotted form: Bundle.entry[0].resource.code.coding[1])
// --------------------------------------------------------------------------- //

export interface PathSegment {
  name: string;
  index: number | null;
}

/** Split a validator path into segments; `[url='...']` qualifiers are dropped (URLs contain dots). */
export function parsePath(path: string): PathSegment[] {
  const out: PathSegment[] = [];
  let buf = "";
  let depth = 0;
  const raw: string[] = [];
  for (const ch of String(path || "")) {
    if (ch === "[") depth++;
    if (ch === "]") depth = Math.max(0, depth - 1);
    if (ch === "." && depth === 0) {
      raw.push(buf);
      buf = "";
    } else buf += ch;
  }
  if (buf !== "") raw.push(buf);
  for (const r of raw) {
    const m = /^([^[]*)((?:\[[^\]]*\])*)$/.exec(r);
    if (!m) {
      out.push({ name: r, index: null });
      continue;
    }
    let index: number | null = null;
    for (const q of m[2].match(/\[[^\]]*\]/g) || []) {
      if (/^\[\d+\]$/.test(q)) index = Number(q.slice(1, -1));
    }
    out.push({ name: m[1], index });
  }
  return out;
}

/** The instance value at a validator path (first segment = the root's resourceType). undefined = absent. */
export function nodeAt(root: any, path: string): any {
  const segs = parsePath(path);
  if (!segs.length) return undefined;
  let node = root;
  for (let i = 1; i < segs.length; i++) {
    const s = segs[i];
    if (!node || typeof node !== "object") return undefined;
    node = node[s.name];
    if (Array.isArray(node)) node = node[s.index ?? 0];
    else if (s.index !== null && s.index > 0) return undefined;
  }
  return node;
}

/** Parent path and last segment name of a validator path. */
export function splitLast(path: string): { parent: string; last: string } {
  const segs = parsePath(path);
  if (segs.length < 2) return { parent: "", last: path };
  let depth = 0;
  for (let i = path.length - 1; i >= 0; i--) {
    const ch = path[i];
    if (ch === "]") depth++;
    else if (ch === "[") depth--;
    else if (ch === "." && depth === 0) return { parent: path.slice(0, i), last: segs[segs.length - 1].name };
  }
  return { parent: "", last: path };
}

export function isObject(v: unknown): v is Record<string, any> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
