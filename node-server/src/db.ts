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

import { AsyncLocalStorage } from "node:async_hooks";
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
  // A checked-out client emits 'error' when the server goes away mid-query (e.g. Postgres
  // crash recovery); without a listener Node treats it as an unhandled 'error' event and
  // exits. The pending query still rejects, so callers see the failure normally.
  _pool.on("connect", (client: pg.PoolClient) => {
    client.on("error", (err: Error) => {
      logError("pg client error", { error: String(err.message) });
    });
  });
  return _pool;
}

export function getPool(): pg.Pool {
  if (_pool === null) {
    throw new Error("Database pool not initialized — call initPool() first");
  }
  return _pool;
}

let queriesIssued = 0;

/**
 * Number of `query()` calls issued by this process so far (monotonic). A cheap
 * counter for profiling: the delta across a code path is its DB round-trip count.
 */
export function queryCount(): number {
  return queriesIssued;
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
  queriesIssued++;
  try {
    return await getPool().query<T>(text, params as never[]);
  } catch (err) {
    recordQueryFailure(err);
    throw err;
  }
}

// --------------------------------------------------------------------------- //
// Query-failure tracking (validator v8)
// --------------------------------------------------------------------------- //

/** One failed `query()` inside a `trackQueryFailures` scope. */
export interface QueryFailure {
  /** PostgreSQL SQLSTATE when the server answered (e.g. 57P03 cannot_connect_now), else null. */
  code: string | null;
  message: string;
}

interface FailureStore {
  failures: QueryFailure[];
  total: number;
}

const failureScope = new AsyncLocalStorage<FailureStore>();
const FAILURES_KEPT = 10;

/**
 * SQLSTATEs that mean "this table / column does not exist on this database"
 * (an optional terminology table or a migration not yet applied). Callers handle
 * those by design (fallback query, feature off), so they are not infrastructure
 * failures and are not tracked.
 */
const SCHEMA_MISSING = new Set(["42P01", "42703", "3F000"]);

function recordQueryFailure(err: unknown): void {
  const store = failureScope.getStore();
  if (!store) return;
  const e = err as { code?: unknown; message?: unknown } | null;
  const code = e && typeof e.code === "string" ? e.code : null;
  if (code !== null && SCHEMA_MISSING.has(code)) return;
  store.total++;
  if (store.failures.length < FAILURES_KEPT) {
    store.failures.push({ code, message: String((e && e.message) || err) });
  }
}

/**
 * Run `fn` and report every `query()` that failed while it ran (transient
 * database trouble: connection refused, crash recovery, pool / statement
 * timeouts …), excluding missing-table / missing-column errors. Lets a caller
 * that degrades gracefully on lookup errors (the FHIR validator resolves
 * definitions and terminology fail-open) still tell "checked and fine" from
 * "could not check": a verdict reached while lookups were failing must not be
 * reported as a clean pass.
 */
export async function trackQueryFailures<T>(fn: () => Promise<T>): Promise<{ result: T; failures: QueryFailure[]; total: number }> {
  const store: FailureStore = { failures: [], total: 0 };
  const result = await failureScope.run(store, fn);
  return { result, failures: store.failures, total: store.total };
}

/**
 * Run `fn` and say whether any `query()` failed while it ran — for a caller that
 * wants to memoise a fail-open lookup only when it was answered by the database.
 * The failures still count towards an enclosing `trackQueryFailures` scope.
 */
export async function probeQueryFailures<T>(fn: () => Promise<T>): Promise<{ result: T; failed: number }> {
  const parent = failureScope.getStore();
  const store: FailureStore = { failures: [], total: 0 };
  const result = await failureScope.run(store, fn);
  if (parent && store.total > 0) {
    parent.total += store.total;
    for (const f of store.failures) {
      if (parent.failures.length >= FAILURES_KEPT) break;
      parent.failures.push(f);
    }
  }
  return { result, failed: store.total };
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
