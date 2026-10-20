/**
 * TtlMemo: a process-wide, bounded, TTL-expiring memo of async lookups keyed by
 * string. The promise itself is cached, so concurrent callers of the same key
 * share one in-flight lookup; a rejected lookup is evicted at once (a transient
 * database error is never remembered). Eviction beyond `max` entries is FIFO.
 *
 * Used for read paths whose answer is a pure function of immutable data (an IG
 * package version's artifacts, a terminology edition) for the TTL's duration —
 * the same staleness contract as the caches in fhirTerminology.ts.
 */
export class TtlMemo<V> {
  private readonly map = new Map<string, { at: number; value: Promise<V> }>();

  constructor(
    private readonly ttlMs: number,
    private readonly max: number,
  ) {}

  /** The memoised value for `key`, computing it with `compute` on a miss / after expiry. */
  get(key: string, compute: () => Promise<V>): Promise<V> {
    const now = Date.now();
    const hit = this.map.get(key);
    if (hit && now - hit.at < this.ttlMs) return hit.value;
    if (hit) this.map.delete(key);
    const value = compute();
    if (this.map.size >= this.max) {
      const first = this.map.keys().next().value;
      if (first !== undefined) this.map.delete(first);
    }
    this.map.set(key, { at: now, value });
    value.catch(() => {
      // Only drop our own entry (a later, fresher one for the same key must stay).
      if (this.map.get(key)?.value === value) this.map.delete(key);
    });
    return value;
  }

  /** The held (fresh) value for `key` without computing it, else undefined. */
  peek(key: string): Promise<V> | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (Date.now() - hit.at >= this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    return hit.value;
  }

  /** Store an already computed value for `key` (same bound and TTL as `get`). */
  set(key: string, value: V): void {
    this.map.delete(key);
    if (this.map.size >= this.max) {
      const first = this.map.keys().next().value;
      if (first !== undefined) this.map.delete(first);
    }
    this.map.set(key, { at: Date.now(), value: Promise.resolve(value) });
  }

  /** Whether `key` is held (fresh) — for tests and diagnostics. */
  has(key: string): boolean {
    const hit = this.map.get(key);
    return !!hit && Date.now() - hit.at < this.ttlMs;
  }

  get size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }
}
