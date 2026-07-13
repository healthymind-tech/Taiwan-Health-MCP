/**
 * admin/adminWs.ts — WebSocket broadcaster for the admin console.
 *
 * Faithful port of `src/admin_ws.py`. Events flow through a Redis pub/sub
 * channel ("admin:ws:events") so the admin-worker process can push real-time
 * updates to browser clients connected to the server process:
 *
 *   worker/server ──broadcast()──► Redis pub/sub ──relay──► clients ──► browser
 *
 * - `broadcast()` serialises `{type, data}` and publishes it to Redis. It is
 *   fire-and-forget: a Redis hiccup falls back to direct in-process delivery
 *   and never throws to the caller.
 * - `startWsRelay()` subscribes to the channel and fans messages out to every
 *   connected client, reconnecting with exponential back-off.
 * - `handleAdminWsConnection()` registers a per-client socket, drains broadcast
 *   messages to it, and answers `ping` with `{"type":"pong"}`.
 *
 * Event types emitted by the backend: job_status_changed / job_log_line /
 * job_step_updated / worker_heartbeat (worker) and maintenance_changed /
 * module_changed / module_cleared (REST write paths).
 */

import { createClient, type RedisClientType } from "redis";
import type { WebSocket } from "ws";
import { logInfo, logWarning, logDebug } from "../logger.js";

const CHANNEL = "admin:ws:events";

// ── Client registry (server process only) ───────────────────────────────────
const clients = new Set<WebSocket>();

// ── Redis publisher (both server and worker processes) ───────────────────────
let redisPublisher: RedisClientType | null = null;

/**
 * Initialise the persistent Redis publisher. Call once at startup in both the
 * server and worker process. A single long-lived client avoids per-broadcast
 * connection overhead. Mirrors `init_broadcast`.
 */
export function initBroadcast(redisUrl: string): void {
  const client: RedisClientType = createClient({ url: redisUrl });
  // node-redis throws on 'error' if no listener is attached; swallow so a Redis
  // outage degrades to the direct-delivery fallback instead of crashing.
  client.on("error", () => {});
  redisPublisher = client;
  void client.connect().catch(() => {
    // leave redisPublisher set; publish() failures fall back to direct delivery
  });
}

/**
 * Publish a typed event to all connected admin WebSocket clients. Serialises
 * `{type, data}` and publishes to Redis; falls back to direct in-process
 * delivery when Redis is unavailable. Mirrors `broadcast` (fire-and-forget).
 */
export async function broadcast(eventType: string, data: Record<string, unknown>): Promise<void> {
  const message = JSON.stringify({ type: eventType, data });
  if (redisPublisher !== null) {
    try {
      await redisPublisher.publish(CHANNEL, message);
      return;
    } catch (exc) {
      logDebug("admin_ws.broadcast: Redis publish failed — falling back to direct delivery", {
        error: String((exc as Error).message),
      });
    }
  }
  deliver(message);
}

/** Push a serialised message to every connected client. Mirrors `_deliver`. */
function deliver(message: string): void {
  for (const ws of [...clients]) {
    try {
      // ws.OPEN === 1
      if (ws.readyState === 1) ws.send(message);
      else clients.delete(ws);
    } catch {
      clients.delete(ws);
    }
  }
}

/**
 * Subscribe to the Redis pub/sub channel and relay events to WS clients. Runs
 * for the lifetime of the server process; reconnects with exponential back-off.
 * Mirrors `start_ws_relay`.
 */
export async function startWsRelay(redisUrl: string): Promise<void> {
  let backoff = 1.0;
  for (;;) {
    let sub: RedisClientType | null = null;
    try {
      sub = createClient({ url: redisUrl });
      sub.on("error", () => {});
      await sub.connect();
      await sub.subscribe(CHANNEL, (message: string) => deliver(message));
      logInfo(`admin_ws relay: subscribed to ${CHANNEL}`);
      backoff = 1.0;
      // node-redis delivers messages via the subscribe callback; park until the
      // connection drops, then fall through to reconnect.
      await new Promise<void>((resolve) => {
        sub!.on("end", () => resolve());
        sub!.on("error", () => resolve());
      });
    } catch (exc) {
      logWarning(`admin_ws relay: connection error (${String((exc as Error).message)}) — retrying in ${backoff.toFixed(0)}s`);
    } finally {
      try {
        if (sub) await sub.quit();
      } catch {
        // ignore teardown errors
      }
    }
    await new Promise((r) => setTimeout(r, backoff * 1000));
    backoff = Math.min(backoff * 2, 30.0);
  }
}

/**
 * Register an accepted WebSocket client and wire up ping/pong + cleanup.
 * Mirrors `handle_admin_websocket` (the upgrade/accept is performed by the
 * caller in server.ts).
 */
export function handleAdminWsConnection(ws: WebSocket): void {
  clients.add(ws);
  logDebug(`admin_ws: client connected (total=${clients.size})`);

  ws.on("message", (raw: Buffer | string) => {
    const text = (typeof raw === "string" ? raw : raw.toString("utf-8")).trim();
    if (text === "ping") {
      try {
        if (ws.readyState === 1) ws.send('{"type":"pong"}');
      } catch {
        // ignore send failure
      }
    }
  });

  const cleanup = (): void => {
    if (clients.delete(ws)) {
      logDebug(`admin_ws: client disconnected (total=${clients.size})`);
    }
  };
  ws.on("close", cleanup);
  ws.on("error", cleanup);
}

/** Number of currently-connected admin WS clients (test/diagnostics helper). */
export function wsClientCount(): number {
  return clients.size;
}
