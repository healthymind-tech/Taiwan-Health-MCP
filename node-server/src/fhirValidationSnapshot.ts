/**
 * Request-scoped snapshot of everything one validation resolves (parity v3, large-Bundle non-determinism; the class of
 * failure of hapi-fhir #6505, a profile cache expiring in the middle of a $validate).
 *
 * The process-wide caches (TtlCache, TtlMemo) evict by age, count and weight. Without a pin, a definition evicted while a
 * Bundle is being validated is loaded again and may answer differently (a re-import, a transient failure, a fresh object
 * identity): one Bundle would be judged against two states of the data. Inside `withValidationSnapshot` every cache read
 * is pinned: the first value the request sees is the one it keeps seeing, whatever happens to the shared cache. Expiry and
 * eviction only affect the next request. The pin holds what the request used and dies with it.
 *
 * Transient failures are never pinned or cached anywhere: only values are.
 *
 * Also the switch for tiny quotas (`FHIR_CACHE_MAX_ENTRIES`, `FHIR_CACHE_MAX_WEIGHT`, `FHIR_CACHE_TTL_MS`, or
 * `setCacheLimits`): the determinism regression forces every cache to evict and expire constantly.
 */
import { AsyncLocalStorage } from "node:async_hooks";

/** A definition / terminology lookup that failed for an infrastructure reason (no answer, as opposed to "not found"). */
export class TransientLookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransientLookupError";
  }
}

export class ValidationSnapshot {
  private readonly pins = new Map<object, Map<string, unknown>>();

  /** The pinned value, or undefined when this request has not resolved `key` from `cache` yet. */
  get(cache: object, key: string): unknown {
    return this.pins.get(cache)?.get(key);
  }

  has(cache: object, key: string): boolean {
    return this.pins.get(cache)?.has(key) ?? false;
  }

  /** First value wins: a later store of the same key does not change what the request sees. */
  pin(cache: object, key: string, value: unknown): void {
    let m = this.pins.get(cache);
    if (!m) {
      m = new Map();
      this.pins.set(cache, m);
    }
    if (!m.has(key)) m.set(key, value);
  }

  unpin(cache: object, key: string): void {
    this.pins.get(cache)?.delete(key);
  }

  get size(): number {
    let n = 0;
    for (const m of this.pins.values()) n += m.size;
    return n;
  }
}

const scope = new AsyncLocalStorage<ValidationSnapshot>();

export function currentSnapshot(): ValidationSnapshot | undefined {
  return scope.getStore();
}

/** Runs `fn` under a snapshot; nested calls join the enclosing one (a request has one snapshot). */
export function withValidationSnapshot<T>(fn: () => Promise<T>): Promise<T> {
  return scope.getStore() ? fn() : scope.run(new ValidationSnapshot(), fn);
}

export interface CacheLimits {
  /** Overrides every cache's entry bound. */
  maxEntries?: number;
  /** Overrides every cache's weight bound (e.g. CS_CACHE_CONCEPTS). */
  maxWeight?: number;
  /** Overrides every cache's TTL. */
  ttlMs?: number;
}

function envLimit(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

let limits: CacheLimits = {
  maxEntries: envLimit("FHIR_CACHE_MAX_ENTRIES"),
  maxWeight: envLimit("FHIR_CACHE_MAX_WEIGHT"),
  ttlMs: envLimit("FHIR_CACHE_TTL_MS"),
};

export function cacheLimits(): CacheLimits {
  return limits;
}

/** Test / regression hook: replaces the overrides (empty = the caches' own bounds). */
export function setCacheLimits(next: CacheLimits): void {
  limits = next;
}
