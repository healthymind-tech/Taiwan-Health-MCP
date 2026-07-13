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
import { buildMcpServer, buildOpenApiSpec, invokeRegisteredTool, toolRegistryReady } from "./mcp.js";
import { STATUS_DATA_JSON } from "./statusData.js";
import { seedIfEmpty } from "./admin/adminSettings.js";
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

  // Seed admin.app_settings from env/defaults on first boot (mirrors Python
  // lifespan seed_if_empty). Idempotent; must run before services read settings
  // (MinIO/embedding). Fail-open — a seed error degrades to env-only behavior.
  try {
    await seedIfEmpty();
  } catch (err) {
    logError("Settings seed skipped", { error: String((err as Error).message) });
  }

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

  // Warm the OpenAPI tool registry (mirrors Python registering tools at startup),
  // so GET /openapi.json + POST /tools/<name> work before the first MCP session.
  try {
    await buildMcpServer();
  } catch (err) {
    logError("Tool registry warm-up skipped", { error: String((err as Error).message) });
  }
}

function buildApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: "4mb" }));
  app.use(express.urlencoded({ extended: false, limit: "4mb" }));

  // B1: liveness probe.
  app.get("/health", (_req: Request, res: Response) => {
    res.status(200).json({ status: "ok" });
  });

  // Data-only payload for the Next.js status page (mirrors Python GET /status.json:
  // serve the static tool catalog verbatim).
  app.get("/status.json", (_req: Request, res: Response) => {
    res.type("application/json").send(STATUS_DATA_JSON);
  });

  // ── OpenAPI bridge (for OpenAPI tool clients, e.g. Open WebUI) ───────────────
  // GET /openapi.json → spec of the registered tools; POST /tools/<name> → invoke.
  // Mirrors the Python ASGI dispatcher's openapi/tools handling, incl. CORS.
  const ensureRegistryWarm = async (): Promise<void> => {
    // buildMcpServer runs per MCP session; warm the registry on demand so the
    // bridge works before any /mcp session exists. Idempotent (registry cleared+rebuilt).
    if (!toolRegistryReady()) await buildMcpServer();
  };
  const originFrom = (req: Request): string => {
    const host = String(req.headers["host"] ?? "").trim();
    if (!host) return "";
    const fwd = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim();
    const scheme = fwd || req.protocol || "http";
    return `${scheme}://${host}`;
  };

  app.options("/openapi.json", (_req: Request, res: Response) => {
    res
      .status(204)
      .set({
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type",
      })
      .end();
  });
  app.get("/openapi.json", (req: Request, res: Response) => {
    void (async () => {
      try {
        await ensureRegistryWarm();
        const spec = buildOpenApiSpec(originFrom(req));
        res.set("access-control-allow-origin", "*").json(spec);
      } catch (exc) {
        res.status(500).json({ error: "openapi_unavailable", detail: String((exc as Error).message) });
      }
    })();
  });

  app.options("/tools/:name", (_req: Request, res: Response) => {
    res
      .status(204)
      .set({
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "content-type",
      })
      .end();
  });
  app.post("/tools/:name", (req: Request, res: Response) => {
    void (async () => {
      const args = req.body;
      if (args !== undefined && args !== null && (typeof args !== "object" || Array.isArray(args))) {
        res.status(400).json({ error: "body_must_be_a_json_object" });
        return;
      }
      try {
        await ensureRegistryWarm();
      } catch (exc) {
        res.status(503).json({ error: "server_not_ready", detail: String((exc as Error).message) });
        return;
      }
      try {
        const text = await invokeRegisteredTool(req.params.name, (args ?? {}) as Record<string, unknown>);
        let bodyObj: unknown;
        try {
          bodyObj = JSON.parse(text);
        } catch {
          bodyObj = { result: text };
        }
        res.set("access-control-allow-origin", "*").json(bodyObj);
      } catch (exc) {
        res.status(400).json({
          error: "tool_call_failed",
          tool: req.params.name,
          detail: String((exc as Error).message),
        });
      }
    })();
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
