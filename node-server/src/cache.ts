/**
 * Redis cache layer.
 *
 * Counterpart of `src/cache.py`. The cache key scheme is kept byte-identical so
 * a warmed Redis is interchangeable between the Python and Node runtimes:
 *   key = `mcp:{ns}:{sha256(JSON({a,k}))[:16]}`
 * Cache failures are fail-open — the wrapped function always runs.
 */

import { createHash } from "node:crypto";
import { createClient, type RedisClientType } from "redis";
import { config } from "./config.js";
import { recordCacheOp } from "./metrics.js";

let _client: RedisClientType | null = null;

/** Create (or return the existing) Redis client and verify connectivity. Idempotent. */
export async function initClient(url?: string): Promise<RedisClientType> {
  if (_client !== null) return _client;
  const client: RedisClientType = createClient({
    url: url ?? config().redisUrl,
    socket: {
      // Bound the *initial* connect so an unreachable Redis fails fast at boot
      // (Python pings once and raises -> caught -> fail-open). After a few
      // retries the strategy returns an Error, rejecting connect().
      // TODO(parity): revisit runtime reconnect policy when porting cache use.
      connectTimeout: 3000,
      reconnectStrategy: (retries: number) =>
        retries >= 5 ? new Error("redis unavailable") : Math.min(retries * 100, 500),
    },
  });
  client.on("error", () => {
    // Swallow — callers treat Redis as best-effort (fail-open).
  });
  await client.connect();
  await client.ping();
  _client = client;
  return _client;
}

export function getClient(): RedisClientType {
  if (_client === null) {
    throw new Error("Redis client not initialized — call initClient() first");
  }
  return _client;
}

export async function closeClient(): Promise<void> {
  if (_client !== null) {
    const old = _client;
    _client = null;
    await old.quit();
  }
}

function cacheKey(ns: string, args: unknown[], kwargs: Record<string, unknown>): string {
  // Mirror Python: json.dumps({"a": args, "k": kwargs}, sort_keys=True).
  const keyData = stableStringify({ a: args, k: kwargs });
  const digest = createHash("sha256").update(keyData).digest("hex").slice(0, 16);
  return `mcp:${ns}:${digest}`;
}

/** JSON with sorted object keys, matching Python's `sort_keys=True`. */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );
    }
    return v;
  });
}

/**
 * Wrap an async function with Redis-backed caching + hit/miss/error metrics.
 * Returns a string result (the cached representation). Fail-open on any error.
 */
export function cached<A extends unknown[]>(
  fn: (...args: A) => Promise<string>,
  opts: { ttl?: number; prefix: string },
): (...args: A) => Promise<string> {
  const { ttl = 3600, prefix } = opts;
  return async (...args: A): Promise<string> => {
    const key = cacheKey(prefix, args, {});
    try {
      const client = getClient();
      const hit = await client.get(key);
      if (hit !== null) {
        recordCacheOp(prefix, "hit");
        return hit;
      }
      const result = await fn(...args);
      if (result !== null && result !== undefined) {
        await client.setEx(key, ttl, result);
      }
      recordCacheOp(prefix, "miss");
      return result;
    } catch {
      recordCacheOp(prefix, "error");
      return fn(...args);
    }
  };
}
