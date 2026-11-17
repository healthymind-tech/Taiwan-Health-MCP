/**
 * The heap safety net (v22 G3): an alert while the live heap stays high, and a graceful self-rotation when it stays
 * too high after the caches have shed (toolConcurrency.maybeShedCaches at 0.7).
 *
 * The live heap ratio (the used size after a major GC / the limit, toolConcurrency.heapUsedRatio) is sampled after
 * every major GC and every MCP_HEAP_WATCH_INTERVAL_MS (30 s):
 *  - alert: above MCP_HEAP_ALERT_RATIO (0.75) for MCP_HEAP_ALERT_MINUTES (10) → one error log line and gauge
 *    mcp_heap_alert = 1 (back to 0, with an info line, once the ratio falls below it);
 *  - rotate: the ratio has stayed above the alert ratio for MCP_HEAP_ROTATE_MINUTES (5) and is now above
 *    MCP_HEAP_ROTATE_RATIO (0.85) — dips between the two do not restart the clock (local soak 2026-11-15: a heap
 *    swinging 0.85–0.92 never stayed above 0.85 for 5 min and ran out) — or it is above MCP_HEAP_EMERGENCY_RATIO
 *    (0.95) at all → `rotate()`: the caches are emptied (room for the drain), the server stops
 *    accepting new sessions and calls (503 + Retry-After), lets the requests in flight finish for at most
 *    MCP_ROTATE_DRAIN_MS (330 s: longer than the official validator's 300 s request limit), then exits with
 *    ROTATE_EXIT_CODE so the container's restart policy starts a fresh process (staging 2026-11-11: hours of BUSY
 *    instead). A ratio of 0 turns either off.
 * Pure over its clock and sampler (tests); the server wires `onRotate`.
 */

import { monitorEventLoopDelay } from "node:perf_hooks";
import { logError, logInfo, logWarning } from "./logger.js";

export const ROTATE_EXIT_CODE = 75; // EX_TEMPFAIL: a planned restart, not a crash

export interface HeapWatchOptions {
  alertRatio: number;
  alertMs: number;
  rotateRatio: number;
  rotateMs: number;
  /** rotate at once above this ratio (0 = off) */
  emergencyRatio: number;
}

function envNum(name: string, fallback: number, max = Infinity): number {
  const v = Number.parseFloat(process.env[name] ?? "");
  return Number.isFinite(v) && v >= 0 && v <= max ? v : fallback;
}

export function heapWatchOptionsFromEnv(): HeapWatchOptions {
  return {
    alertRatio: envNum("MCP_HEAP_ALERT_RATIO", 0.75, 1),
    alertMs: envNum("MCP_HEAP_ALERT_MINUTES", 10) * 60_000,
    rotateRatio: envNum("MCP_HEAP_ROTATE_RATIO", 0.85, 1),
    rotateMs: envNum("MCP_HEAP_ROTATE_MINUTES", 5) * 60_000,
    emergencyRatio: envNum("MCP_HEAP_EMERGENCY_RATIO", 0.95, 1),
  };
}

export class HeapWatch {
  private aboveAlertSince: number | null = null;
  private alerting = false;
  private rotating = false;

  constructor(
    private readonly opts: HeapWatchOptions,
    private readonly onRotate: (ratio: number) => void,
  ) {}

  /** 1 while the alert holds (gauge mcp_heap_alert). */
  get alert(): number {
    return this.alerting ? 1 : 0;
  }

  /** One sample of the live heap ratio at time `now`. */
  sample(ratio: number, now: number): void {
    const { alertRatio, alertMs, rotateRatio, rotateMs, emergencyRatio } = this.opts;
    if (alertRatio > 0 && ratio > alertRatio) {
      this.aboveAlertSince ??= now;
      if (!this.alerting && now - this.aboveAlertSince >= alertMs) {
        this.alerting = true;
        logError("heap alert: the live heap has stayed above the alert ratio", {
          live_ratio: round3(ratio),
          alert_ratio: alertRatio,
          minutes: Math.round((now - this.aboveAlertSince) / 60_000),
        });
      }
    } else {
      this.aboveAlertSince = null;
      if (this.alerting) {
        this.alerting = false;
        logInfo("heap alert cleared", { live_ratio: round3(ratio) });
      }
    }
    if (this.rotating) return;
    const emergency = emergencyRatio > 0 && ratio > emergencyRatio;
    const sustained = rotateRatio > 0 && ratio > rotateRatio && this.aboveAlertSince !== null && now - this.aboveAlertSince >= rotateMs;
    if (emergency || sustained) {
      this.rotating = true;
      logWarning("heap rotation: the live heap stays high after cache shedding; draining and restarting", {
        live_ratio: round3(ratio),
        rotate_ratio: rotateRatio,
        emergency,
      });
      this.onRotate(ratio);
    }
  }
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

/**
 * Event-loop lag alert (v22 G6, a monitored metric, not a gate): the longest event-loop delay of each watch interval;
 * above MCP_EVENT_LOOP_ALERT_MS (10 s; 0 = off) a warning line and gauge mcp_event_loop_lag_alert = 1 for that interval.
 * Below EVENT_LOOP_STALL_SECONDS (the watchdog that kills a hung loop) by design: slow, not hung.
 */
export class LagWatch {
  private readonly h = monitorEventLoopDelay({ resolution: 20 });
  private alerting = false;

  constructor(private readonly alertMs: number) {
    if (alertMs > 0) this.h.enable();
  }

  get alert(): number {
    return this.alerting ? 1 : 0;
  }

  /** The longest delay since the last sample (ms), checked against the alert threshold; the histogram restarts. */
  sample(): number {
    if (this.alertMs <= 0) return 0;
    const maxMs = this.h.max / 1e6;
    this.h.reset();
    this.check(maxMs);
    return maxMs;
  }

  /** (tests) one interval's longest delay */
  check(maxMs: number): void {
    const was = this.alerting;
    this.alerting = maxMs > this.alertMs;
    if (this.alerting) logWarning("event loop lag alert: the event loop was blocked longer than the alert threshold", { lag_max_ms: Math.round(maxMs), alert_ms: this.alertMs });
    else if (was) logInfo("event loop lag alert cleared", { lag_max_ms: Math.round(maxMs) });
  }
}

export function lagAlertMsFromEnv(): number {
  return envNum("MCP_EVENT_LOOP_ALERT_MS", 10_000);
}

/**
 * Requests in flight on the public surface, and the drain: once `startDrain()` is called new requests are refused
 * (the caller answers 503) and `drained()` resolves when the last one in flight finished or the bound passed.
 */
export class Drain {
  private inflight = 0;
  private draining = false;
  private waiters: Array<() => void> = [];

  get active(): number {
    return this.inflight;
  }

  get isDraining(): boolean {
    return this.draining;
  }

  /** Count a request in; false = draining, refuse it. Pair a true with `leave()`. */
  enter(): boolean {
    if (this.draining) return false;
    this.inflight++;
    return true;
  }

  leave(): void {
    this.inflight = Math.max(0, this.inflight - 1);
    if (this.inflight === 0) for (const w of this.waiters.splice(0)) w();
  }

  startDrain(): void {
    this.draining = true;
  }

  /** Resolves true when nothing is in flight, false when `boundMs` passed first. */
  drained(boundMs: number): Promise<boolean> {
    if (this.inflight === 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== done);
        resolve(false);
      }, boundMs);
      const done = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      this.waiters.push(done);
    });
  }
}
