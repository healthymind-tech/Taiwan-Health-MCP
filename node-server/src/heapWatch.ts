/**
 * The heap safety net (v22 G3): an alert while the live heap stays high, and a graceful self-rotation when it stays
 * too high after the caches have shed (toolConcurrency.maybeShedCaches at 0.7).
 *
 * Every MCP_HEAP_WATCH_INTERVAL_MS (30 s) the live heap ratio (the used size after the last major GC / the limit,
 * toolConcurrency.heapUsedRatio) is sampled:
 *  - alert: above MCP_HEAP_ALERT_RATIO (0.75) for MCP_HEAP_ALERT_MINUTES (10) → one error log line and gauge
 *    mcp_heap_alert = 1 (back to 0, with an info line, once the ratio falls below it);
 *  - rotate: above MCP_HEAP_ROTATE_RATIO (0.85) for MCP_HEAP_ROTATE_MINUTES (5) → `rotate()`: the server stops
 *    accepting new sessions and calls (503 + Retry-After), lets the requests in flight finish for at most
 *    MCP_ROTATE_DRAIN_MS (330 s: longer than the official validator's 300 s request limit), then exits with
 *    ROTATE_EXIT_CODE so the container's restart policy starts a fresh process (staging 2026-11-11: hours of BUSY
 *    instead). A ratio of 0 turns either off.
 * Pure over its clock and sampler (tests); the server wires `onRotate`.
 */

import { logError, logInfo, logWarning } from "./logger.js";

export const ROTATE_EXIT_CODE = 75; // EX_TEMPFAIL: a planned restart, not a crash

export interface HeapWatchOptions {
  alertRatio: number;
  alertMs: number;
  rotateRatio: number;
  rotateMs: number;
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
  };
}

export class HeapWatch {
  private aboveAlertSince: number | null = null;
  private aboveRotateSince: number | null = null;
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
    const { alertRatio, alertMs, rotateRatio, rotateMs } = this.opts;
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
    if (rotateRatio > 0 && ratio > rotateRatio) {
      this.aboveRotateSince ??= now;
      if (!this.rotating && now - this.aboveRotateSince >= rotateMs) {
        this.rotating = true;
        logWarning("heap rotation: the live heap stayed above the rotation ratio after cache shedding; draining and restarting", {
          live_ratio: round3(ratio),
          rotate_ratio: rotateRatio,
        });
        this.onRotate(ratio);
      }
    } else {
      this.aboveRotateSince = null;
    }
  }
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
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
