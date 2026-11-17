/**
 * Prometheus metrics (prom-client).
 *
 * Counterpart of `src/metrics.py`. Metric names, label sets and histogram
 * buckets are kept identical so existing dashboards/alerts work unchanged:
 *   mcp_tool_requests_total{tool,status}        Counter
 *   mcp_tool_duration_seconds{tool}             Histogram
 *   mcp_cache_operations_total{prefix,result}   Counter
 *   mcp_db_pool_size                            Gauge
 *   mcp_db_pool_checked_out                     Gauge
 *
 * Exposed on METRICS_PORT (default 9090) at /metrics, like the Python side.
 */

import http from "node:http";
import { collectDefaultMetrics, Counter, Gauge, Histogram, register } from "prom-client";
import { config } from "./config.js";
import { logError, logInfo } from "./logger.js";
import { heapUsedRatio, heavyToolGate } from "./toolConcurrency.js";
import { trackedCacheStats } from "./memSize.js";

// ops-v1 O6: process memory / CPU / event-loop lag / GC (nodejs_heap_size_used_bytes, process_resident_memory_bytes, …)
collectDefaultMetrics();

export const toolRequests = new Counter({
  name: "mcp_tool_requests_total",
  help: "Total MCP tool invocations",
  labelNames: ["tool", "status"] as const,
});

export const toolDuration = new Histogram({
  name: "mcp_tool_duration_seconds",
  help: "MCP tool execution latency",
  labelNames: ["tool"] as const,
  // ops-v1 O6: up to 2 min — Bundle validation / finalisation under load runs past 10 s
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 20.0, 30.0, 60.0, 120.0],
});

/** ops-v1 O4 / O6: the heavy-tool gate (toolConcurrency.ts), read at scrape time. */
export const heavyToolsRunning = new Gauge({
  name: "mcp_heavy_tools_running",
  help: "Heavy tool calls holding a concurrency slot",
  collect() {
    this.set(heavyToolGate().stats().running);
  },
});

export const heavyToolsQueued = new Gauge({
  name: "mcp_heavy_tools_queued",
  help: "Heavy tool calls waiting for a concurrency slot",
  collect() {
    this.set(heavyToolGate().stats().queued);
  },
});

let openSessions: () => number = () => 0;
/** server.ts registers how to count its open MCP sessions. */
export function countOpenSessionsWith(fn: () => number): void {
  openSessions = fn;
}

let heapAlert: () => number = () => 0;
/** server.ts registers the heap watch's alert state. */
export function reportHeapAlertWith(fn: () => number): void {
  heapAlert = fn;
}

let lagAlert: () => number = () => 0;
/** server.ts registers the event-loop lag alert state. */
export function reportLagAlertWith(fn: () => number): void {
  lagAlert = fn;
}

export const lagAlertGauge = new Gauge({
  name: "mcp_event_loop_lag_alert",
  help: "1 while the last watch interval's longest event-loop delay was above MCP_EVENT_LOOP_ALERT_MS (heapWatch.ts)",
  collect() {
    this.set(lagAlert());
  },
});

export const heapAlertGauge = new Gauge({
  name: "mcp_heap_alert",
  help: "1 while the live heap has stayed above MCP_HEAP_ALERT_RATIO for MCP_HEAP_ALERT_MINUTES (heapWatch.ts)",
  collect() {
    this.set(heapAlert());
  },
});

export const mcpSessionsOpen = new Gauge({
  name: "mcp_sessions_open",
  help: "Open MCP streamable-http sessions (each holds a server instance until DELETE or idle close)",
  collect() {
    this.set(openSessions());
  },
});

export const heapLiveRatio = new Gauge({
  name: "mcp_heap_live_ratio",
  help: "V8 heap still live after the last major GC, as a fraction of the heap limit (what the memory guard reads)",
  collect() {
    this.set(heapUsedRatio());
  },
});

export const cacheEstimatedBytes = new Gauge({
  name: "mcp_cache_estimated_bytes",
  help: "Estimated bytes held by each cross-request cache (memSize.estimateBytes; 0 = bounded by count only), by construction site",
  labelNames: ["cache"],
  collect() {
    this.reset();
    for (const c of trackedCacheStats()) this.set({ cache: c.name }, c.bytes);
  },
});

export const cacheEntries = new Gauge({
  name: "mcp_cache_entries",
  help: "Entries held by each cross-request cache, by construction site",
  labelNames: ["cache"],
  collect() {
    this.reset();
    for (const c of trackedCacheStats()) this.set({ cache: c.name }, c.entries);
  },
});

export const cacheOps = new Counter({
  name: "mcp_cache_operations_total",
  help: "Redis cache hit/miss counts",
  labelNames: ["prefix", "result"] as const,
});

export const dbPoolSize = new Gauge({
  name: "mcp_db_pool_size",
  help: "Total connections in the pg pool",
});

export const dbPoolCheckedOut = new Gauge({
  name: "mcp_db_pool_checked_out",
  help: "Connections currently checked out from the pg pool",
});

/** Increment request counter and record latency for one tool invocation. */
export function recordToolCall(tool: string, status: string, durationS: number): void {
  toolRequests.labels(tool, status).inc();
  toolDuration.labels(tool).observe(durationS);
}

/** Increment the cache operations counter. result: "hit" | "miss" | "error". */
export function recordCacheOp(prefix: string, result: string): void {
  cacheOps.labels(prefix, result).inc();
}

/** Refresh DB pool gauges from a live pg Pool (totalCount / idleCount). */
export function updateDbPoolStats(pool: { totalCount: number; idleCount: number }): void {
  try {
    dbPoolSize.set(pool.totalCount);
    dbPoolCheckedOut.set(pool.totalCount - pool.idleCount);
  } catch {
    // ignore
  }
}

let _metricsServer: http.Server | null = null;

/** Start the Prometheus HTTP server. Idempotent (one bind per process). */
export function startMetricsServer(port?: number): number {
  const p = port ?? config().metricsPort;
  if (_metricsServer !== null) return p;
  const server = http.createServer(async (req, res) => {
    if (req.url === "/metrics") {
      try {
        const body = await register.metrics();
        res.writeHead(200, { "Content-Type": register.contentType });
        res.end(body);
      } catch (err) {
        res.writeHead(500);
        res.end(String((err as Error).message));
      }
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.on("error", (err: Error) => {
    logError(`Could not start metrics server on :${p}: ${err.message}`);
  });
  server.listen(p, () => {
    logInfo(`Prometheus metrics server started on :${p}/metrics`);
  });
  _metricsServer = server;
  return p;
}

/** Poll a pg-pool-shaped object and refresh gauges every `intervalMs`. */
export function startDbStatsCollector(
  getPool: () => { totalCount: number; idleCount: number },
  intervalMs = 15_000,
): NodeJS.Timeout {
  const timer = setInterval(() => {
    try {
      updateDbPoolStats(getPool());
    } catch {
      // ignore
    }
  }, intervalMs);
  timer.unref();
  return timer;
}
