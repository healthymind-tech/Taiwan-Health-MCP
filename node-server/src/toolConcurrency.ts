/**
 * ops-v1 O4 — a concurrency cap for the heavy tools (whole-Bundle validation, finalisation,
 * authoring / assembly, grounding against record text). Each of these builds snapshots, walks
 * every element and may hold several MB per call; dozens in parallel exhaust the host's memory.
 *
 * One process-wide gate: at most `limit` heavy calls run at once; further calls wait FIFO for at
 * most `queueTimeoutMs` (and at most `maxQueue` wait at all). A call that cannot start in time
 * gets an isError result with `error.code = "BUSY"` and `retry_after_s` instead of piling up.
 * Light tools never wait. Settings: MCP_HEAVY_TOOL_CONCURRENCY (default 4; 0 = no cap),
 * MCP_HEAVY_TOOL_QUEUE_TIMEOUT_MS (default 60000), MCP_HEAVY_TOOL_MAX_QUEUE (default 32).
 *
 * Memory guard: a heavy call that holds a slot still does not start while the LIVE heap — the V8 heap as the
 * last major (mark-compact) collection left it — is above MCP_HEAVY_TOOL_HEAP_RATIO of the heap limit (default
 * 0.8; 0 = off), and answers BUSY (`reason: "memory"`) instead, so a burst of large Bundles is turned away call by
 * call rather than taking the whole process down with "JavaScript heap out of memory" (staging, 2026-11-07: 11
 * restarts → 502s at the front door). The plain used size is not a measure: V8 collects the old space only under
 * pressure, so a big heap fills with garbage long before it is full (staging 2026-11-08: 91 % "used" at idle with
 * ~2 GB live), and a forced GC would stop every request for seconds. Every other tool is guarded the same way at
 * MCP_TOOL_HEAP_RATIO (default 0.9; 0 = off): a light call allocates little, so it keeps working a little longer,
 * but no call starts on a heap that is about to run out (staging 2026-11-09: the fatal allocation was a JSON.parse
 * outside any heavy tool).
 */

import { PerformanceObserver, constants as perfConstants } from "node:perf_hooks";
import v8 from "node:v8";

export const BUSY_CODE = "BUSY";

/** Tools the gate applies to (CPU / memory heavy per call). */
export const HEAVY_TOOLS: ReadonlySet<string> = new Set([
  "fhir_validate_bundle",
  "fhir_validate_resource",
  "fhir_finalize_bundle",
  "fhir_finalize_resource",
  "fhir_author_resources",
  "fhir_assemble_bundle",
  "fhir_check_grounding",
  "fhir_check_completeness",
  // ISSUES_v18 R3 / R4: fact coverage walks the whole Bundle; the release gate runs the full fhir_validate_bundle pipeline
  "fhir_check_fact_coverage",
  "fhir_release_check",
]);

export interface GateOptions {
  limit: number;
  queueTimeoutMs: number;
  maxQueue: number;
  /** used / limit of the V8 heap above which a heavy call does not start; 0 = no memory guard */
  heapRatio?: number;
  /** the same for every other tool; 0 / absent = no memory guard */
  lightHeapRatio?: number;
}

let liveAfterMajorGc = 0;
let gcObserver: PerformanceObserver | null = null;

/** live / limit of this process's V8 heap: the used size right after the last major GC (0 before the first one). */
export function heapUsedRatio(): number {
  if (!gcObserver) {
    gcObserver = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if ((e as unknown as { detail?: { kind?: number } }).detail?.kind === perfConstants.NODE_PERFORMANCE_GC_MAJOR) {
          liveAfterMajorGc = v8.getHeapStatistics().used_heap_size;
        }
      }
    });
    gcObserver.observe({ entryTypes: ["gc"] });
  }
  const limit = v8.getHeapStatistics().heap_size_limit;
  return limit > 0 ? liveAfterMajorGc / limit : 0;
}

function envInt(name: string, fallback: number): number {
  const v = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

function envRatio(name: string, fallback: number): number {
  const v = Number.parseFloat(process.env[name] ?? "");
  return Number.isFinite(v) && v >= 0 && v < 1 ? v : fallback;
}

export function gateOptionsFromEnv(): GateOptions {
  return {
    limit: envInt("MCP_HEAVY_TOOL_CONCURRENCY", 4),
    queueTimeoutMs: envInt("MCP_HEAVY_TOOL_QUEUE_TIMEOUT_MS", 60_000),
    maxQueue: envInt("MCP_HEAVY_TOOL_MAX_QUEUE", 32),
    heapRatio: envRatio("MCP_HEAVY_TOOL_HEAP_RATIO", 0.8),
    lightHeapRatio: envRatio("MCP_TOOL_HEAP_RATIO", 0.9),
  };
}

interface Waiter {
  resolve: (ok: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** FIFO counting semaphore with a bounded, timed queue. */
export class ToolGate {
  private running = 0;
  private readonly queue: Waiter[] = [];

  constructor(readonly opts: GateOptions) {}

  /** Snapshot for health / metrics. */
  stats(): { running: number; queued: number; limit: number } {
    return { running: this.running, queued: this.queue.length, limit: this.opts.limit };
  }

  /** Resolves true when a slot is held (call release()), false on queue overflow / timeout. */
  acquire(): Promise<boolean> {
    if (this.opts.limit <= 0) return Promise.resolve(true);
    if (this.running < this.opts.limit && !this.queue.length) {
      this.running++;
      return Promise.resolve(true);
    }
    if (this.queue.length >= this.opts.maxQueue) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const w: Waiter = {
        resolve,
        timer: setTimeout(() => {
          const i = this.queue.indexOf(w);
          if (i >= 0) this.queue.splice(i, 1);
          resolve(false);
        }, this.opts.queueTimeoutMs),
      };
      this.queue.push(w);
    });
  }

  release(): void {
    if (this.opts.limit <= 0) return;
    const next = this.queue.shift();
    if (next) {
      clearTimeout(next.timer);
      next.resolve(true); // the slot passes to the next waiter
    } else this.running = Math.max(0, this.running - 1);
  }
}

/** The isError result of a heavy call refused because the heap is near its limit. */
export function memoryBusyToolResult(tool: string, ratio: number): { content: Array<{ type: "text"; text: string }>; isError: true } {
  const retryAfter = 15;
  const pct = Math.round(ratio * 100);
  const body = {
    ok: false,
    data: null,
    warnings: [],
    error: {
      code: BUSY_CODE,
      tool,
      reason: "memory",
      retryable: true,
      retry_after_s: retryAfter,
      message: `The server's memory is near its limit (${pct}% of the heap still live after the last collection), so ${tool} did not start. Retry after ${retryAfter} s; nothing was processed.`,
      message_zh: `伺服器記憶體接近上限（上次回收後仍有 ${pct}% heap 在使用），${tool} 未開始執行。請 ${retryAfter} 秒後重試；本次沒有處理任何內容。`,
    },
  };
  return { content: [{ type: "text", text: JSON.stringify(body) }], isError: true };
}

/** The isError result of a call that could not start (same envelope as the other tool errors). */
export function busyToolResult(tool: string, gate: ToolGate): { content: Array<{ type: "text"; text: string }>; isError: true } {
  const { limit } = gate.stats();
  const retryAfter = Math.max(5, Math.ceil(gate.opts.queueTimeoutMs / 4000));
  const body = {
    ok: false,
    data: null,
    warnings: [],
    error: {
      code: BUSY_CODE,
      tool,
      retryable: true,
      retry_after_s: retryAfter,
      concurrency_limit: limit,
      message: `The server is at its limit of ${limit} concurrent heavy calls (validation / finalisation / authoring / grounding) and ${tool} could not start in time. Retry after ${retryAfter} s, and keep at most ${limit} such calls in flight.`,
      message_zh: `伺服器同時處理的重負載呼叫（驗證、定稿、撰寫、grounding）已達上限 ${limit}，${tool} 未能及時開始。請 ${retryAfter} 秒後重試，並將同時進行的此類呼叫控制在 ${limit} 個以內。`,
    },
  };
  return { content: [{ type: "text", text: JSON.stringify(body) }], isError: true };
}

let shared: ToolGate | null = null;
/** The process-wide gate (settings read once from env). */
export function heavyToolGate(): ToolGate {
  return (shared ??= new ToolGate(gateOptionsFromEnv()));
}

/** Wrap a handler: heavy tools wait for a slot (or answer BUSY); other tools only pass the memory guard. */
export function withConcurrencyLimit<A extends unknown[], R>(
  name: string,
  handler: (...args: A) => Promise<R> | R,
  gate: () => ToolGate = heavyToolGate,
  heavy: ReadonlySet<string> = HEAVY_TOOLS,
  heap: { ratio: () => number } = { ratio: heapUsedRatio },
): (...args: A) => Promise<R> {
  if (!heavy.has(name)) {
    return async (...args: A): Promise<R> => {
      const limit = gate().opts.lightHeapRatio ?? 0;
      if (limit > 0) {
        const r = heap.ratio();
        if (r > limit) return memoryBusyToolResult(name, r) as unknown as R;
      }
      return handler(...args);
    };
  }
  return async (...args: A): Promise<R> => {
    const g = gate();
    if (!(await g.acquire())) return busyToolResult(name, g) as unknown as R;
    try {
      const limit = g.opts.heapRatio ?? 0;
      if (limit > 0) {
        const r = heap.ratio();
        if (r > limit) return memoryBusyToolResult(name, r) as unknown as R;
      }
      return await handler(...args);
    } finally {
      g.release();
    }
  };
}
