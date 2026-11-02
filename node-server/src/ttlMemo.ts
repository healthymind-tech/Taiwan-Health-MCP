/**
 * TtlMemo: a process-wide, bounded, TTL-expiring memo of async lookups keyed by
 * string. The promise itself is cached, so concurrent callers of the same key
 * share one in-flight lookup; a rejected lookup is evicted at once (a transient
 * database error is never remembered). Eviction beyond `max` entries is FIFO.
 *
 * Used for read paths whose answer is a pure function of immutable data (an IG
 * package version's artifacts, a terminology edition) for the TTL's duration —
 * the same staleness contract as the caches in fhirTerminology.ts.
 *
 * Inside a validation snapshot (fhirValidationSnapshot.ts) every read is pinned: the request keeps
 * the value it saw first, whatever the shared memo evicts. A rejected lookup is unpinned too.
 */
import { cacheLimits, currentSnapshot } from "./fhirValidationSnapshot.js";

export class TtlMemo<V> {
  private readonly map = new Map<string, { at: number; value: Promise<V> }>();

  constructor(
    private readonly ttlMs: number,
    private readonly max: number,
  ) {}

  private get ttl(): number {
    return cacheLimits().ttlMs ?? this.ttlMs;
  }

  private store(key: string, entry: { at: number; value: Promise<V> }): void {
    const max = cacheLimits().maxEntries ?? this.max;
    while (this.map.size && this.map.size >= max) {
      const first = this.map.keys().next().value;
      if (first === undefined) break;
      this.map.delete(first);
    }
    if (max > 0) this.map.set(key, entry);
  }

  /** The memoised value for `key`, computing it with `compute` on a miss / after expiry. */
  get(key: string, compute: () => Promise<V>): Promise<V> {
    const snap = currentSnapshot();
    if (snap?.has(this, key)) return snap.get(this, key) as Promise<V>;
    const now = Date.now();
    const hit = this.map.get(key);
    if (hit && now - hit.at < this.ttl) {
      snap?.pin(this, key, hit.value);
      return hit.value;
    }
    if (hit) this.map.delete(key);
    const value = compute();
    this.store(key, { at: now, value });
    snap?.pin(this, key, value);
    value.catch(() => {
      // Only drop our own entry (a later, fresher one for the same key must stay).
      if (this.map.get(key)?.value === value) this.map.delete(key);
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
      this.map.delete(key);
      return undefined;
    }
    snap?.pin(this, key, hit.value);
    return hit.value;
  }

  /** Store an already computed value for `key` (same bound and TTL as `get`). */
  set(key: string, value: V): void {
    this.map.delete(key);
    const held = Promise.resolve(value);
    this.store(key, { at: Date.now(), value: held });
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

  clear(): void {
    this.map.clear();
  }
}
