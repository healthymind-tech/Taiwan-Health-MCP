/**
 * Approximate retained size of a value (bytes), for caches bounded by memory rather than by entry count (staging heap
 * profile 2026-11-08: the CodeSystem indexes and the concept-search indexes, bounded by concept / term counts, held
 * ~2 GB between them). The estimate follows V8's layout roughly — object header + slots, a string's characters (two
 * bytes each, the worst case), Map / Set entries — and counts a shared object once per walk. It is an upper-bound guess,
 * cheap enough to run once when a value enters a cache; never used for anything a result depends on.
 */

const OBJECT = 24;
const SLOT = 8;
const STRING = 16;
const MAP_ENTRY = 40;
const ARRAY = 32;
/**
 * The walk above undercounts V8's real layout (hidden classes, hash-table slack, array growth): measured on the
 * TW Core ICD-10-CM CodeSystems (92k-97k concepts, --expose-gc heap deltas) the CodeSystem index is 1.2-1.5x and the
 * ConceptIndex 1.2-1.5x the raw walk, so the estimate is scaled up to stay on the safe side.
 */
const CALIBRATION = 1.5;

export function estimateBytes(value: unknown, limit = Infinity): number {
  const seen = new WeakSet<object>();
  const stack: unknown[] = [value];
  let total = 0;
  while (stack.length) {
    const v = stack.pop();
    if (v === null || v === undefined) continue;
    switch (typeof v) {
      case "string":
        total += STRING + 2 * v.length;
        break;
      case "number":
      case "bigint":
        total += SLOT;
        break;
      case "boolean":
        break;
      case "object": {
        const o = v as object;
        if (seen.has(o)) break;
        seen.add(o);
        if (Array.isArray(o)) {
          total += ARRAY + SLOT * o.length;
          for (const x of o) if (x !== null && (typeof x === "object" || typeof x === "string")) stack.push(x);
        } else if (o instanceof Map) {
          total += OBJECT + MAP_ENTRY * o.size;
          for (const [k, x] of o) {
            if (typeof k === "string" || (k !== null && typeof k === "object")) stack.push(k);
            if (x !== null && (typeof x === "object" || typeof x === "string")) stack.push(x);
          }
        } else if (o instanceof Set) {
          total += OBJECT + MAP_ENTRY * o.size;
          for (const x of o) if (x !== null && (typeof x === "object" || typeof x === "string")) stack.push(x);
        } else if (ArrayBuffer.isView(o)) {
          total += OBJECT + (o as ArrayBufferView).byteLength;
        } else if (!(o instanceof Promise) && !(o instanceof WeakMap) && !(o instanceof WeakSet)) {
          const keys = Object.keys(o);
          total += OBJECT + SLOT * keys.length;
          for (const k of keys) {
            const x = (o as Record<string, unknown>)[k];
            if (x !== null && (typeof x === "object" || typeof x === "string")) stack.push(x);
            else if (typeof x === "number") total += SLOT;
          }
        }
        break;
      }
      default:
        break;
    }
    if (total * CALIBRATION > limit) return Math.round(total * CALIBRATION);
  }
  return Math.round(total * CALIBRATION);
}

/** A positive byte budget from the environment (MB), else the default (MB). */
export function envBudgetBytes(name: string, defaultMb: number): number {
  const raw = Number(process.env[name]);
  return (Number.isFinite(raw) && raw > 0 ? raw : defaultMb) * 1048576;
}

export interface CacheStats {
  entries: number;
  /** estimated bytes held (memSize.estimateBytes); 0 for a cache bounded by count only */
  bytes: number;
}

const tracked: Array<{ name: string; ref: WeakRef<object>; stats: (o: object) => CacheStats }> = [];

/** `file.js:line` of the code that constructed the cache (above creationSite, trackCache and the constructor), for metric labels. */
function creationSite(): string {
  const frames = String(new Error().stack ?? "").split("\n").slice(1);
  const frame = frames[3] ?? frames[frames.length - 1] ?? "";
  const m = /([^/\\(\s]+\.[cm]?[jt]s):(\d+):\d+\)?\s*$/.exec(frame);
  return m ? `${m[1]}:${m[2]}` : "unknown";
}

/**
 * Register a cross-request cache for the mcp_cache_* gauges (metrics.ts). Call it from the cache's constructor; the
 * cache is held weakly, `stats` reads its current entry count and estimated size.
 */
export function trackCache<T extends object>(cache: T, stats: (c: T) => CacheStats, name: string = creationSite()): void {
  tracked.push({ name, ref: new WeakRef(cache), stats: stats as (o: object) => CacheStats });
}

/** Every live tracked cache, summed per name (two caches built at the same line share a label). */
export function trackedCacheStats(): Array<{ name: string } & CacheStats> {
  const by = new Map<string, CacheStats>();
  for (let i = tracked.length - 1; i >= 0; i--) {
    const t = tracked[i];
    const c = t.ref.deref();
    if (!c) {
      tracked.splice(i, 1);
      continue;
    }
    const s = t.stats(c);
    const sum = by.get(t.name) ?? { entries: 0, bytes: 0 };
    by.set(t.name, { entries: sum.entries + s.entries, bytes: sum.bytes + s.bytes });
  }
  return [...by].map(([name, s]) => ({ name, ...s }));
}
