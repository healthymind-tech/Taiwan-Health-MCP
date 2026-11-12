/**
 * The open MCP streamable-http sessions of this process, closed when idle.
 *
 * Every session holds its own McpServer with every tool registered (~1 MB of heap, measured on Node 20 with the
 * production registry) until the client sends DELETE — and agent clients do not: staging 2026-11-12 saw 314 sessions
 * initialised in 8.5 h and not one DELETE, so the sessions alone grew the heap without bound. A session not used for
 * MCP_SESSION_IDLE_MS (default 60 min; 0 = never) is closed, and beyond MCP_MAX_SESSIONS (default 500; 0 = no cap)
 * the least recently used one is closed to admit a new one. A closed session's id answers 404, so the client
 * initialises a new session (MCP streamable-http: "the client MUST start a new session" on 404).
 */

export interface ClosableSession {
  close(): Promise<void> | void;
}

interface Held<T> {
  session: T;
  lastSeen: number;
}

export interface SessionLimits {
  idleMs: number;
  maxSessions: number;
}

function envInt(name: string, fallback: number): number {
  const v = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

export function sessionLimitsFromEnv(): SessionLimits {
  return { idleMs: envInt("MCP_SESSION_IDLE_MS", 60 * 60_000), maxSessions: envInt("MCP_MAX_SESSIONS", 500) };
}

export class SessionRegistry<T extends ClosableSession> {
  /** insertion order = least recently used first (a use moves the session to the end) */
  private readonly held = new Map<string, Held<T>>();

  constructor(
    private readonly limits: SessionLimits,
    private readonly now: () => number = Date.now,
  ) {}

  get size(): number {
    return this.held.size;
  }

  /** The session for `id`, marked as used now; undefined when unknown or already closed. */
  get(id: string): T | undefined {
    const h = this.held.get(id);
    if (!h) return undefined;
    h.lastSeen = this.now();
    this.held.delete(id);
    this.held.set(id, h);
    return h.session;
  }

  /** Register a new session; over the cap, the least recently used sessions are closed first. */
  add(id: string, session: T): void {
    if (this.limits.maxSessions > 0) {
      while (this.held.size >= this.limits.maxSessions) {
        const oldest = this.held.keys().next().value;
        if (oldest === undefined) break;
        this.close(oldest);
      }
    }
    this.held.set(id, { session, lastSeen: this.now() });
  }

  /** Forget a session the transport closed itself (DELETE / connection end). */
  delete(id: string): void {
    this.held.delete(id);
  }

  /** Close every session idle for longer than the limit; returns how many were closed. */
  sweep(): number {
    if (this.limits.idleMs <= 0) return 0;
    const cutoff = this.now() - this.limits.idleMs;
    let closed = 0;
    for (const [id, h] of this.held) {
      if (h.lastSeen >= cutoff) break; // least recently used first: the rest are newer
      this.close(id);
      closed++;
    }
    return closed;
  }

  private close(id: string): void {
    const h = this.held.get(id);
    this.held.delete(id);
    if (!h) return;
    try {
      void Promise.resolve(h.session.close()).catch(() => undefined);
    } catch {
      // a transport that fails to close is dropped all the same
    }
  }
}
