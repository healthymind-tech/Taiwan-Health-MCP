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
 */

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
]);

export interface GateOptions {
  limit: number;
  queueTimeoutMs: number;
  maxQueue: number;
}

function envInt(name: string, fallback: number): number {
  const v = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

export function gateOptionsFromEnv(): GateOptions {
  return {
    limit: envInt("MCP_HEAVY_TOOL_CONCURRENCY", 4),
    queueTimeoutMs: envInt("MCP_HEAVY_TOOL_QUEUE_TIMEOUT_MS", 60_000),
    maxQueue: envInt("MCP_HEAVY_TOOL_MAX_QUEUE", 32),
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

/** Wrap a handler: heavy tools wait for a slot (or answer BUSY); other tools pass straight through. */
export function withConcurrencyLimit<A extends unknown[], R>(
  name: string,
  handler: (...args: A) => Promise<R> | R,
  gate: () => ToolGate = heavyToolGate,
  heavy: ReadonlySet<string> = HEAVY_TOOLS,
): (...args: A) => Promise<R> {
  if (!heavy.has(name)) return async (...args: A): Promise<R> => handler(...args);
  return async (...args: A): Promise<R> => {
    const g = gate();
    if (!(await g.acquire())) return busyToolResult(name, g) as unknown as R;
    try {
      return await handler(...args);
    } finally {
      g.release();
    }
  };
}
