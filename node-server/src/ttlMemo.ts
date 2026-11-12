/**
 * TtlMemo: a process-wide, bounded, TTL-expiring memo of async lookups keyed by
 * string. The promise itself is cached, so concurrent callers of the same key
 * share one in-flight lookup; a rejected lookup is evicted at once (a transient
 * database error is never remembered). Eviction beyond `max` entries — and, when
 * `maxBytes` is given, beyond that estimated size of the settled values
 * (memSize.estimateBytes) — is least-recently-used.
 *
 * Used for read paths whose answer is a pure function of immutable data (an IG
 * package version's artifacts, a terminology edition) for the TTL's duration —
 * the same staleness contract as the caches in fhirTerminology.ts.
 *
 * Inside a validation snapshot (fhirValidationSnapshot.ts) every read is pinned: the request keeps
 * the value it saw first, whatever the shared memo evicts. A rejected lookup is unpinned too.
 */
import { cacheLimits, currentSnapshot } from "./fhirValidationSnapshot.js";
import { estimateBytes, trackCache } from "./memSize.js";

interface Entry<V> {
  at: number;
  value: Promise<V>;
  /** estimated size once settled (only with a byte budget) */
  bytes: number;
}

export class TtlMemo<V> {
  private readonly map = new Map<string, Entry<V>>();
  private bytes = 0;

  constructor(
    private readonly ttlMs: number,
    private readonly max: number,
    private readonly maxBytes = Infinity,
  ) {
    trackCache(this, { stats: (m) => ({ entries: m.map.size, bytes: m.bytes }), shed: (m, f) => m.shed(f) });
  }

  private get ttl(): number {
    return cacheLimits().ttlMs ?? this.ttlMs;
  }

  private drop(key: string): void {
    const hit = this.map.get(key);
    if (!hit) return;
    this.bytes -= hit.bytes;
    this.map.delete(key);
  }

  /** a hit becomes the most recently used */
  private touch(key: string, hit: Entry<V>): void {
    this.map.delete(key);
    this.map.set(key, hit);
  }

  private store(key: string, entry: Entry<V>): void {
    const max = cacheLimits().maxEntries ?? this.max;
    while (this.map.size && this.map.size >= max) {
      const first = this.map.keys().next().value;
      if (first === undefined) break;
      this.drop(first);
    }
    if (max <= 0) return;
    this.map.set(key, entry);
    if (this.maxBytes !== Infinity) {
      entry.value.then(
        (v) => {
          if (this.map.get(key) !== entry) return; // replaced or evicted meanwhile
          entry.bytes = 64 + estimateBytes(v);
          this.bytes += entry.bytes;
          this.shrink(key);
        },
        () => undefined,
      );
    }
  }

  /** Evict least-recently-used entries until the settled values fit `maxBytes` (one larger than the budget is not held). */
  private shrink(newest: string): void {
    while (this.bytes > this.maxBytes && this.map.size) {
      const first = this.map.keys().next().value;
      if (first === undefined) break;
      this.drop(first);
      if (first === newest) break;
    }
  }

  /** The memoised value for `key`, computing it with `compute` on a miss / after expiry. */
  get(key: string, compute: () => Promise<V>): Promise<V> {
    const snap = currentSnapshot();
    if (snap?.has(this, key)) return snap.get(this, key) as Promise<V>;
    const now = Date.now();
    const hit = this.map.get(key);
    if (hit && now - hit.at < this.ttl) {
      this.touch(key, hit);
      snap?.pin(this, key, hit.value);
      return hit.value;
    }
    if (hit) this.drop(key);
    const value = compute();
    this.store(key, { at: now, value, bytes: 0 });
    snap?.pin(this, key, value);
    value.catch(() => {
      // Only drop our own entry (a later, fresher one for the same key must stay).
      if (this.map.get(key)?.value === value) this.drop(key);
      snap?.unpin(this, key);
    });
    return value;
  }

  /** The held (fresh) value for `key` without computing it, else undefined. */
  peek(key: string): Promise<V> | undefined {
    const snap = currentSnapshot();
    if (snap?.has(this, key)) return snap.get(this, key) as Promise<V>;
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (Date.now() - hit.at >= this.ttl) {
      this.drop(key);
      return undefined;
    }
    this.touch(key, hit);
    snap?.pin(this, key, hit.value);
    return hit.value;
  }

  /** Store an already computed value for `key` (same bound and TTL as `get`). */
  set(key: string, value: V): void {
    this.drop(key);
    const held = Promise.resolve(value);
    this.store(key, { at: Date.now(), value: held, bytes: 0 });
    currentSnapshot()?.pin(this, key, held);
  }

  /** Whether `key` is held (fresh) — for tests and diagnostics. */
  has(key: string): boolean {
    const hit = this.map.get(key);
    return !!hit && Date.now() - hit.at < this.ttl;
  }

  get size(): number {
    return this.map.size;
  }

  /** Drop about `fraction` of the entries, least recently used first (memory pressure; a request keeps what it pinned). */
  shed(fraction: number): void {
    let n = Math.ceil(this.map.size * fraction);
    for (const key of [...this.map.keys()]) {
      if (n-- <= 0) break;
      this.drop(key);
    }
  }

  /** Estimated size of the settled values (0 without a byte budget). */
  get weight(): number {
    return this.bytes;
  }

  clear(): void {
    this.map.clear();
    this.bytes = 0;
  }
}
