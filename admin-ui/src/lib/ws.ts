// Single shared WebSocket connection to /admin/ws.
//
// Mirrors the behaviour of the old admin_html_shell.py client:
//   • same-origin connect (cookie auth flows automatically)
//   • 20s ping keepalive, server replies {"type":"pong"}
//   • exponential reconnect backoff capped at 30s
//
// Consumers subscribe via subscribe()/onStatus(); the React layer wires these
// into a QueryClient (see wsInvalidation.ts) and an indicator component.

import type { WsEnvelope } from "./types";

type EventHandler = (evt: WsEnvelope) => void;
type StatusHandler = (connected: boolean) => void;

const PING_INTERVAL_MS = 20_000;
const MAX_BACKOFF_MS = 30_000;

class AdminWebSocket {
  private ws: WebSocket | null = null;
  private eventHandlers = new Set<EventHandler>();
  private statusHandlers = new Set<StatusHandler>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoff = 1_000;
  private started = false;
  private connected = false;

  start(): void {
    if (this.started) return;
    this.started = true;
    this.connect();
  }

  private wsUrl(): string {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${window.location.host}/admin/ws`;
  }

  private connect = (): void => {
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.wsUrl());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = socket;

    socket.onopen = () => {
      this.backoff = 1_000;
      this.setConnected(true);
      this.pingTimer = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send("ping");
      }, PING_INTERVAL_MS);
    };

    socket.onmessage = (e: MessageEvent<string>) => {
      let msg: WsEnvelope;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.type === "pong") return;
      this.eventHandlers.forEach((h) => h(msg));
    };

    const onDown = () => {
      this.setConnected(false);
      if (this.pingTimer) {
        clearInterval(this.pingTimer);
        this.pingTimer = null;
      }
      this.ws = null;
      this.scheduleReconnect();
    };
    socket.onclose = onDown;
    socket.onerror = onDown;
  };

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.backoff);
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
  }

  private setConnected(value: boolean): void {
    if (this.connected === value) return;
    this.connected = value;
    this.statusHandlers.forEach((h) => h(value));
  }

  isConnected(): boolean {
    return this.connected;
  }

  subscribe(handler: EventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  onStatus(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler);
    // Push current state immediately so late subscribers render correctly.
    handler(this.connected);
    return () => this.statusHandlers.delete(handler);
  }
}

export const adminWs = new AdminWebSocket();
