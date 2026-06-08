"""
admin_ws.py — WebSocket broadcaster for the admin console.

Architecture
------------
• Events flow through a Redis pub/sub channel ("admin:ws:events") so that
  the admin-worker container (a separate process) can push real-time updates
  to browser clients connected to the server container.

  admin-worker  ──broadcast()──►  Redis pub/sub  ──relay task──►  _clients  ──►  browser
  server        ──broadcast()──►  Redis pub/sub  ──relay task──►  _clients  ──►  browser

• broadcast() serialises the event and publishes it to Redis.  It is
  fire-and-forget: failures are logged at DEBUG level and silently swallowed
  so that a Redis hiccup never crashes a job.

• start_ws_relay() must be called once during server startup.  It opens a
  dedicated Redis pub/sub connection, subscribes to the channel, and loops
  forever pushing received messages into every connected client queue.

• handle_admin_websocket() is the raw-ASGI entry point wired up in server.py.
  It registers a per-client asyncio.Queue, runs sender + receiver concurrently,
  then cleans up on disconnect.

Event types emitted by the backend
-----------------------------------
  job_status_changed   – job status / progress update (mark_job_status)
  job_log_line         – single log line appended   (append_job_log)
  job_step_updated     – step upserted              (record_job_step)
  worker_heartbeat     – worker alive signal        (upsert_worker_heartbeat)

The frontend dispatches on event["type"] to update the relevant tab UI.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

import redis.asyncio as aioredis

logger = logging.getLogger(__name__)

_CHANNEL = "admin:ws:events"

# ---------------------------------------------------------------------------
# Client registry (server process only)
# ---------------------------------------------------------------------------

_clients: set[asyncio.Queue[str | None]] = set()

# ---------------------------------------------------------------------------
# Redis publisher (both server and worker processes)
# ---------------------------------------------------------------------------

_redis_publisher: aioredis.Redis | None = None  # persistent publish connection


def init_broadcast(redis_url: str) -> None:
    """Initialise the persistent Redis publisher.

    Call this once at startup in both the server and the worker process.
    A single long-lived client is kept for publish() calls so we don't pay
    connection overhead on every broadcast.
    """
    global _redis_publisher
    _redis_publisher = aioredis.from_url(
        redis_url, encoding="utf-8", decode_responses=True
    )


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


async def broadcast(event_type: str, data: dict[str, Any]) -> None:
    """Publish a typed event to all connected admin WebSocket clients.

    Serialises the event and publishes it to the Redis pub/sub channel.
    The relay task running in the server process receives the message and
    fans it out to every connected browser tab.

    Falls back to direct in-process delivery if Redis is not configured
    (e.g. during local development without Redis).
    """
    message = json.dumps(
        {"type": event_type, "data": data}, ensure_ascii=False, default=str
    )

    if _redis_publisher is not None:
        try:
            await _redis_publisher.publish(_CHANNEL, message)
            return
        except Exception as exc:
            logger.debug(
                "admin_ws.broadcast: Redis publish failed (%s) — falling back to direct delivery",
                exc,
            )

    # Direct delivery fallback (same-process clients, or when Redis is unavailable)
    _deliver(message)


def _deliver(message: str) -> None:
    """Push a serialised message to every registered client queue."""
    dead: list[asyncio.Queue[str | None]] = []
    for q in list(_clients):
        try:
            q.put_nowait(message)
        except (asyncio.QueueFull, Exception):
            dead.append(q)
    for q in dead:
        _clients.discard(q)


# ---------------------------------------------------------------------------
# Relay task — server process only
# ---------------------------------------------------------------------------


async def start_ws_relay(redis_url: str) -> None:
    """Subscribe to the Redis pub/sub channel and relay events to WS clients.

    This coroutine runs for the lifetime of the server process.  It must be
    started as an asyncio.Task during server startup.  Reconnects automatically
    on transient Redis failures with exponential back-off.
    """
    backoff = 1.0
    while True:
        try:
            async with aioredis.from_url(
                redis_url, encoding="utf-8", decode_responses=True
            ) as r:
                pubsub = r.pubsub()
                await pubsub.subscribe(_CHANNEL)
                logger.info("admin_ws relay: subscribed to %s", _CHANNEL)
                backoff = 1.0  # reset on successful connect
                try:
                    async for raw in pubsub.listen():
                        if raw.get("type") != "message":
                            continue
                        data = raw.get("data", "")
                        if isinstance(data, bytes):
                            data = data.decode("utf-8")
                        _deliver(data)
                finally:
                    # Close the listen() async generator and its connection
                    # explicitly so cancellation at shutdown doesn't race the
                    # event loop's async-generator finaliser.
                    await pubsub.aclose()
        except asyncio.CancelledError:
            logger.debug("admin_ws relay: cancelled")
            return
        except Exception as exc:
            logger.warning(
                "admin_ws relay: connection error (%s) — retrying in %.0fs",
                exc,
                backoff,
            )
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30.0)


# ---------------------------------------------------------------------------
# WebSocket handler — server process only
# ---------------------------------------------------------------------------


async def handle_admin_websocket(scope: dict, receive, send) -> None:  # noqa: ANN001
    """Raw-ASGI WebSocket handler for /admin/ws.

    Accepts the upgrade, registers a per-client queue, runs:
      _sender  – dequeues outbound messages and writes them to the socket
      _receiver – reads inbound messages (ping / disconnect) from the socket

    Both coroutines are cancelled cleanly when the client disconnects.
    """
    await send({"type": "websocket.accept"})

    queue: asyncio.Queue[str | None] = asyncio.Queue(maxsize=256)
    _clients.add(queue)
    logger.debug("admin_ws: client connected (total=%d)", len(_clients))

    async def _sender() -> None:
        try:
            while True:
                msg = await queue.get()
                if msg is None:
                    break
                await send({"type": "websocket.send", "text": msg})
        except Exception:
            pass

    async def _receiver() -> None:
        try:
            while True:
                event = await receive()
                kind = event.get("type", "")
                if kind == "websocket.disconnect":
                    break
                if kind == "websocket.receive":
                    text = event.get("text") or ""
                    if text.strip() == "ping":
                        try:
                            queue.put_nowait('{"type":"pong"}')
                        except asyncio.QueueFull:
                            pass
        except Exception:
            pass
        finally:
            try:
                queue.put_nowait(None)
            except asyncio.QueueFull:
                pass

    sender_task = asyncio.create_task(_sender())
    try:
        await _receiver()
    finally:
        await sender_task
        _clients.discard(queue)
        logger.debug("admin_ws: client disconnected (total=%d)", len(_clients))
