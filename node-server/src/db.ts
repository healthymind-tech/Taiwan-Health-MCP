/**
 * PostgreSQL connection pool (node-postgres `pg`).
 *
 * Counterpart of `src/database.py`. node-postgres does NOT use server-side
 * named prepared statements unless a query is given a `name`, so it is already
 * safe behind pgBouncer in transaction mode — the equivalent of asyncpg's
 * `statement_cache_size=0`. We never name queries.
 *
 * Call `initPool()` once at startup; use `query()` / `getPool()` anywhere.
 */

import pg from "pg";
import { config } from "./config.js";
import { logError } from "./logger.js";

const { Pool } = pg;

let _pool: pg.Pool | null = null;

export interface InitPoolOptions {
  minSize?: number;
  maxSize?: number;
}

/** Create (or return the existing) pool. Idempotent. */
export function initPool(opts: InitPoolOptions = {}): pg.Pool {
  if (_pool !== null) return _pool;
  const { maxSize = 20 } = opts;
  _pool = new Pool({
    connectionString: config().databaseUrl,
    max: maxSize,
    // Keep statements unnamed -> pgBouncer transaction-mode safe.
  });
  _pool.on("error", (err: Error) => {
    // Idle client errors must never crash the process.
    logError("pg pool idle client error", { error: String(err.message) });
  });
  return _pool;
}

export function getPool(): pg.Pool {
  if (_pool === null) {
    throw new Error("Database pool not initialized — call initPool() first");
  }
  return _pool;
}

/**
 * Run a query against the pool.
 *
 * @param text  SQL text (unnamed; never pass a `name`).
 * @param params  Positional parameters ($1, $2, ...).
 * @param _label  Optional caller label (parity with the Python audit label;
 *                currently advisory only).
 */
export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
  _label?: string,
): Promise<pg.QueryResult<T>> {
  return getPool().query<T>(text, params as never[]);
}

/**
 * Run `fn` inside a single transaction on a dedicated pooled client (mirrors
 * `async with pool.acquire() as conn: async with conn.transaction():`).
 * Commits on success, rolls back on any thrown error, always releases.
 */
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore rollback failure */
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Probe DB liveness without throwing. Mirrors `database.healthcheck`. */
export async function healthcheck(): Promise<{ ok: boolean; inRecovery: boolean; error: string }> {
  try {
    const res = await query<{ in_recovery: boolean }>(
      "SELECT pg_is_in_recovery() AS in_recovery",
    );
    return { ok: true, inRecovery: Boolean(res.rows[0]?.in_recovery), error: "" };
  } catch (err) {
    return { ok: false, inRecovery: false, error: String((err as Error).message).slice(0, 300) };
  }
}

export async function closePool(): Promise<void> {
  if (_pool !== null) {
    const old = _pool;
    _pool = null;
    await old.end();
  }
}

/**
 * Recreate the pool, replacing dead connections after a DB outage.
 * Mirrors `database.reset_pool` — used by the DB health monitor on recovery.
 */
export async function resetPool(): Promise<pg.Pool> {
  await closePool();
  return initPool();
}
