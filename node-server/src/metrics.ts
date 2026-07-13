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
import { Counter, Gauge, Histogram, register } from "prom-client";
import { config } from "./config.js";
import { logError, logInfo } from "./logger.js";

export const toolRequests = new Counter({
  name: "mcp_tool_requests_total",
  help: "Total MCP tool invocations",
  labelNames: ["tool", "status"] as const,
});

export const toolDuration = new Histogram({
  name: "mcp_tool_duration_seconds",
  help: "MCP tool execution latency",
  labelNames: ["tool"] as const,
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0],
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
