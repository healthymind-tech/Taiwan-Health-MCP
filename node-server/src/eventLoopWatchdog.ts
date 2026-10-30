/**
 * Event-loop watchdog (2026-10-30 outage): a synchronous loop in one request (an endless path walk)
 * blocked the main thread for two hours — every client timed out, health checks failed, and Docker
 * does not restart an unhealthy container, only an exited one. A worker thread watches a heartbeat
 * the main thread bumps every second; when it stops for EVENT_LOOP_STALL_SECONDS (default 120; 0 = off)
 * the worker logs to stderr and kills the process, so the restart policy brings the service back in
 * about a minute instead of never. The worker never touches request data.
 */

import { Worker } from "node:worker_threads";

const WORKER_SOURCE = `
const { workerData } = require("node:worker_threads");
const fs = require("node:fs");
const beat = new Int32Array(workerData.buffer);
const stallMs = workerData.stallMs;
let last = Atomics.load(beat, 0);
let lastChange = Date.now();
setInterval(() => {
  const now = Date.now();
  const v = Atomics.load(beat, 0);
  if (v !== last) { last = v; lastChange = now; return; }
  if (now - lastChange >= stallMs) {
    const line = JSON.stringify({ ts: new Date(now).toISOString().slice(0, 19), level: "ERROR", logger: "taiwan_health_mcp", msg: "event loop blocked; exiting so the container restarts", blocked_ms: now - lastChange, stall_threshold_ms: stallMs });
    try { fs.writeSync(2, line + "\\n"); } catch {}
    process.kill(workerData.pid, "SIGKILL");
  }
}, Math.min(5000, Math.max(250, Math.floor(stallMs / 4))));
`;

export interface WatchdogHandle {
  stop(): Promise<void>;
}

/** Start the watchdog (no-op when the threshold is 0). Safe to call once per process. */
export function startEventLoopWatchdog(stallSeconds: number = Number(process.env.EVENT_LOOP_STALL_SECONDS ?? 120)): WatchdogHandle | null {
  const stallMs = Math.round((Number.isFinite(stallSeconds) ? stallSeconds : 120) * 1000);
  if (stallMs <= 0) return null;
  const buffer = new SharedArrayBuffer(4);
  const beat = new Int32Array(buffer);
  const tick = setInterval(() => Atomics.add(beat, 0, 1), 1000);
  tick.unref();
  const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { buffer, stallMs, pid: process.pid } });
  worker.unref();
  return {
    async stop(): Promise<void> {
      clearInterval(tick);
      await worker.terminate();
    },
  };
}
