/**
 * Central database health monitor — the single source of truth for whether the
 * PostgreSQL backend is usable.
 *
 * Faithful port of `src/db_health.py` (`DbHealthMonitor`). It runs a lightweight
 * background probe and exposes `isHealthy()` / `snapshot()` so every entry point
 * (MCP tools, admin API, worker) can gate operations while the database is down
 * and surface a clear status to the UI.
 *
 * Design parity with Python:
 * - States: `healthy` / `recovering` / `unreachable`.
 * - Fail-fast: callers that hit a DB connection error call `reportFailure` to
 *   flip the gate immediately instead of waiting for the next probe.
 * - Debounced unlock: after an outage, require N consecutive OK probes plus a
 *   short grace window before resuming (avoids flapping during crash recovery).
 * - On recovery, recycle the connection pool so dead connections are replaced
 *   before traffic is allowed back in.
 *
 * The `snapshot()` keys mirror Python exactly so `health_check.db_health` is
 * value-for-value comparable (timestamp/duration fields are normalized away by
 * the parity runner).
 */

import { healthcheck, resetPool } from "./db.js";
import { logError, logInfo, logWarning } from "./logger.js";

export const STATE_HEALTHY = "healthy";
export const STATE_RECOVERING = "recovering";
export const STATE_UNREACHABLE = "unreachable";

// Debounced unlock: this many consecutive healthy probes AND this grace window
// must both pass before the gate reopens.
const UNLOCK_CONSECUTIVE_OK = 2;
const UNLOCK_GRACE_SECONDS = 3.0;

const PROBE_INTERVAL_HEALTHY = 5.0;
const PROBE_INTERVAL_DOWN = 2.0;

// Substrings that indicate the database connection itself is gone (used by the
// fail-fast hook to distinguish infra failures from ordinary query errors).
const DB_DOWN_MARKERS = [
  "connection was closed",
  "connectiondoesnotexist",
  "the database system is in recovery",
  "is not yet accepting connections",
  "connection refused",
  "connection reset",
  "server closed the connection",
  "underlying connection is closed",
  "connection is closed",
  "cannot connect",
  "pool is closed",
  "too many connections",
  "the database system is starting up",
  "interfaceerror",
];

function looksLikeDbDown(message: string): boolean {
  const lowered = message.toLowerCase();
  return DB_DOWN_MARKERS.some((marker) => lowered.includes(marker));
}

/**
 * Public helper: True when an error/message looks like a DB outage
 * (connection lost / refused / in recovery) rather than an ordinary error.
 */
export function isDbDownError(exc: unknown): boolean {
  return looksLikeDbDown(String(exc));
}

/** Monotonic clock in seconds (parity with Python `time.monotonic()`). */
function monoSeconds(): number {
  return performance.now() / 1000;
}

export interface DbHealthSnapshot {
  state: string;
  healthy: boolean;
  since: string;
  for_seconds: number;
  last_ok_at: string | null;
  last_error: string;
  monitoring: boolean;
}

class DbHealthMonitor {
  // Optimistic at boot so nothing is blocked before the first probe; the probe
  // corrects this within seconds and reportFailure flips it instantly.
  private state = STATE_HEALTHY;
  private since = monoSeconds();
  private sinceWall = new Date();
  private lastOkAt: Date | null = null;
  private lastError = "";
  private consecutiveOk = 0;
  private firstOkAt: number | null = null;
  private running = false;
  private timer: NodeJS.Timeout | null = null;

  // ── public API ────────────────────────────────────────────────────────────
  isHealthy(): boolean {
    return this.state === STATE_HEALTHY;
  }

  snapshot(): DbHealthSnapshot {
    return {
      state: this.state,
      healthy: this.state === STATE_HEALTHY,
      since: this.sinceWall.toISOString(),
      for_seconds: Math.round((monoSeconds() - this.since) * 10) / 10,
      last_ok_at: this.lastOkAt ? this.lastOkAt.toISOString() : null,
      last_error: this.lastError,
      monitoring: this.running,
    };
  }

  /**
   * Flip the gate closed immediately when a real DB connection error is observed
   * by a caller (fail-fast, no need to wait for the next probe).
   */
  reportFailure(exc: unknown): void {
    const message = String(exc);
    if (!looksLikeDbDown(message)) return;
    this.consecutiveOk = 0;
    this.firstOkAt = null;
    if (this.state === STATE_HEALTHY) {
      this.setState(STATE_UNREACHABLE, message);
    }
  }

  /** Start the background probe loop (idempotent). */
  start(): void {
    if (this.running) return;
    this.running = true;
    logInfo("Database health monitor started");
    void this.loop();
  }

  /** Stop the probe loop (used in tests / shutdown). */
  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  // ── internals ───────────────────────────────────────────────────────────────
  private setState(state: string, error = ""): void {
    if (state !== this.state) {
      this.state = state;
      this.since = monoSeconds();
      this.sinceWall = new Date();
      if (state === STATE_HEALTHY) {
        logInfo("Database recovered — operations resumed");
      } else {
        logWarning("Database gated — operations paused", { state, error });
      }
    }
    if (error) {
      this.lastError = error;
    }
  }

  private async probeOnce(): Promise<void> {
    const result = await healthcheck();
    const ok = Boolean(result.ok);
    const inRecovery = Boolean(result.inRecovery);
    const error = String(result.error || "");

    if (ok && !inRecovery) {
      this.lastOkAt = new Date();
      if (this.state === STATE_HEALTHY) return;
      // Debounced unlock after an outage.
      this.consecutiveOk += 1;
      if (this.firstOkAt === null) {
        this.firstOkAt = monoSeconds();
      }
      const gracePassed = monoSeconds() - this.firstOkAt >= UNLOCK_GRACE_SECONDS;
      if (this.consecutiveOk >= UNLOCK_CONSECUTIVE_OK && gracePassed) {
        await this.recyclePool();
        this.setState(STATE_HEALTHY);
        this.consecutiveOk = 0;
        this.firstOkAt = null;
      }
      return;
    }

    // Not healthy.
    this.consecutiveOk = 0;
    this.firstOkAt = null;
    const lowered = error.toLowerCase();
    if (inRecovery || lowered.includes("recovery") || lowered.includes("not yet accepting")) {
      this.setState(STATE_RECOVERING, error || "database in recovery");
    } else {
      this.setState(STATE_UNREACHABLE, error || "database unreachable");
    }
  }

  private async recyclePool(): Promise<void> {
    try {
      await resetPool();
    } catch (exc) {
      logWarning("Pool recycle after recovery failed", { error: String(exc) });
    }
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        await this.probeOnce();
      } catch (exc) {
        logError(`DB health probe error: ${String(exc)}`);
      }
      const interval =
        this.state === STATE_HEALTHY ? PROBE_INTERVAL_HEALTHY : PROBE_INTERVAL_DOWN;
      await new Promise<void>((resolve) => {
        this.timer = setTimeout(resolve, interval * 1000);
      });
    }
  }
}

const _monitor = new DbHealthMonitor();

/** Return the process-wide DB health monitor singleton. */
export function monitor(): DbHealthMonitor {
  return _monitor;
}
