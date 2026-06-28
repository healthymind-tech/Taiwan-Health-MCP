/**
 * HTTP entry point (B1 + B2 stub).
 *
 * - `GET /health`            -> 200 liveness (B1 acceptance criterion)
 * - `POST|GET|DELETE /mcp`   -> MCP streamable-http transport (B2)
 *
 * Startup mirrors the Python `server.py` lifespan's graceful degradation: a
 * failing DB or Redis does not abort boot — services simply report unavailable.
 */

import express, { type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { config, adminReady } from "./config.js";
import { configureLogLevel, logError, logInfo } from "./logger.js";
import { WebSocketServer } from "ws";
import { parseCookieHeader, parseAdminSessionToken, SESSION_COOKIE_NAME } from "./adminAuth.js";
import { initBroadcast, startWsRelay, handleAdminWsConnection } from "./admin/adminWs.js";
import { initPool, getPool, closePool } from "./db.js";
import { monitor as dbHealthMonitor } from "./dbHealth.js";
import { initClient, closeClient } from "./cache.js";
import { startDbStatsCollector, startMetricsServer } from "./metrics.js";
import { buildMcpServer } from "./mcp.js";
import { adminHandler } from "./admin/adminApp.js";
import { getFhirServerJwks, fhirServerSecretKey } from "./admin/adminFhirServers.js";
import { completeAuthorization, OAuthError } from "./admin/fhirOauthService.js";
import * as minioService from "./minioService.js";

const OAUTH_CALLBACK_PATH = "/fhir-oauth/callback";

async function bootstrapResources(): Promise<void> {
  const cfg = config();
  configureLogLevel(cfg.logLevel);

  try {
    initPool();
    startDbStatsCollector(() => getPool());
    logInfo("Database pool initialized");
  } catch (err) {
    logError("Database pool init failed — continuing degraded", {
      error: String((err as Error).message),
    });
  }

  // Start the DB health monitor (mirrors Python lifespan db_health.monitor().start()).
  // Idempotent; runs regardless of pool init so `monitoring` reflects a live probe loop.
  dbHealthMonitor().start();

  try {
    await initClient();
    logInfo("Redis client initialized");
  } catch (err) {
    logError("Redis init failed — continuing without cache", {
      error: String((err as Error).message),
    });
  }

  // MinIO probe (mirrors Python lifespan MinioService init). Fail-open — a
  // missing/unreachable MinIO leaves the service disabled, never aborts startup.
  try {
    await minioService.initialize();
  } catch (err) {
    logError("MinIO init failed — continuing without object storage", {
      error: String((err as Error).message),
    });
  }

  startMetricsServer();
}

function buildApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: "4mb" }));
  app.use(express.urlencoded({ extended: false, limit: "4mb" }));

  // B1: liveness probe.
  app.get("/health", (_req: Request, res: Response) => {
    res.status(200).json({ status: "ok" });
  });

  // Public per-server JWKS (private_key_jwt). Server-to-server, no admin session;
  // the server-id UUID is the capability and only public keys are exposed.
  app.get("/fhir-client/:id/jwks.json", (req: Request, res: Response) => {
    void (async () => {
      try {
        const jwks = await getFhirServerJwks(req.params.id);
        if (jwks === null) {
          res.status(404).json({ error: "not_found" });
          return;
        }
        res.status(200).json(jwks);
      } catch {
        res.status(503).json({ error: "jwks_unavailable" });
      }
    })();
  });

  // Public OAuth2 Authorization Code callback. No admin session — the single-use
  // unguessable `state` nonce is the capability. Redirects back to the admin SPA.
  app.get(OAUTH_CALLBACK_PATH, (req: Request, res: Response) => {
    void (async () => {
      const fhirTab = "/admin/modules/fhir-servers";
      const err = String(req.query.error ?? "");
      if (err) {
        const reason = encodeURIComponent(String(req.query.error_description || err).slice(0, 200));
        res.redirect(303, `${fhirTab}?oauth=error&reason=${reason}`);
        return;
      }
      try {
        const result = await completeAuthorization({
          code: String(req.query.code ?? ""),
          state: String(req.query.state ?? ""),
          secretKey: fhirServerSecretKey(config().adminSessionSecret),
        });
        const serverKey = encodeURIComponent(String(result.server_key ?? ""));
        res.redirect(303, `${fhirTab}?oauth=success&server=${serverKey}`);
      } catch (exc) {
        if (exc instanceof OAuthError) {
          res.redirect(303, `${fhirTab}?oauth=error&reason=${encodeURIComponent(exc.message.slice(0, 200))}`);
        } else {
          res.redirect(303, `${fhirTab}?oauth=error&reason=token_exchange_failed`);
        }
      }
    })();
  });

  // Admin console gate + REST (mirrors the inline /admin dispatcher in server.py).
  app.use((req, res, next) => {
    void adminHandler(req, res, next);
  });

  // B2: MCP streamable-http with per-session transports.
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const mcpPath = config().path;

  app.post(mcpPath, async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let transport = sessionId ? transports.get(sessionId) : undefined;

    if (!transport && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid: string) => {
          transports.set(sid, transport as StreamableHTTPServerTransport);
        },
      });
      transport.onclose = () => {
        if (transport?.sessionId) transports.delete(transport.sessionId);
      };
      const server = await buildMcpServer();
      await server.connect(transport);
    }

    if (!transport) {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: no valid session" },
        id: null,
      });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  });

  const handleSessionRequest = async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }
    await transport.handleRequest(req, res);
  };

  app.get(mcpPath, handleSessionRequest);
  app.delete(mcpPath, handleSessionRequest);

  return app;
}

async function main(): Promise<void> {
  const cfg = config();
  await bootstrapResources();

  const app = buildApp();
  const server = app.listen(cfg.port, cfg.host, () => {
    logInfo(`Node MCP server listening on http://${cfg.host}:${cfg.port}${cfg.path}`);
  });

  // ── Admin WebSocket (/admin/ws) ────────────────────────────────────────────
  // Mirror server.py: init the Redis publisher + start the pub/sub relay, then
  // gate the upgrade on admin-enabled + admin-ready + a valid session cookie.
  initBroadcast(cfg.redisUrl);
  void startWsRelay(cfg.redisUrl);
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    let pathname = "";
    try {
      pathname = new URL(req.url ?? "", "http://localhost").pathname;
    } catch {
      pathname = req.url ?? "";
    }
    if (pathname !== "/admin/ws") {
      socket.destroy();
      return;
    }
    // Auth gate mirrors the Python /admin/ws handler (reject ⇒ close 1008).
    const cookies = parseCookieHeader(req.headers.cookie);
    const username = adminReady(cfg)
      ? parseAdminSessionToken(cookies[SESSION_COOKIE_NAME], cfg.adminSessionSecret)
      : null;
    if (!adminReady(cfg) || !username) {
      // Mirror the Python /admin/ws gate: a pre-accept reject surfaces to the
      // client as an HTTP 403 during the upgrade handshake.
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      handleAdminWsConnection(ws);
    });
  });

  const shutdown = async (signal: string) => {
    logInfo(`Received ${signal}, shutting down`);
    server.close();
    dbHealthMonitor().stop();
    await Promise.allSettled([closePool(), closeClient()]);
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  logError("Fatal startup error", { error: String((err as Error).message) });
  process.exit(1);
});
