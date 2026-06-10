import express from "express";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { closeRedis, connectRedis, redisHealth } from "./cache.js";
import { config } from "./config.js";
import { closeDb, dbHealth } from "./db.js";
import { logger } from "./logger.js";
import { metricsContentType, metricsText } from "./metrics.js";
import { createMcpServer } from "./tools.js";

async function runStdio(): Promise<void> {
  await connectRedis().catch(() => undefined);
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("Node MCP gateway running on stdio");
}

async function runHttp(): Promise<void> {
  await connectRedis().catch(() => undefined);

  const app = express();
  app.use(express.json({ limit: "5mb" }));

  app.get("/healthz", async (_req, res) => {
    const [database, cache] = await Promise.all([dbHealth(), redisHealth()]);
    res.status(database ? 200 : 503).json({
      status: database ? "ok" : "degraded",
      database: database ? "ok" : "error",
      cache: cache ? "ok" : "error",
      gateway: "node"
    });
  });

  app.get(config.metricsPath, async (_req, res) => {
    res.setHeader("Content-Type", metricsContentType());
    res.send(await metricsText());
  });

  app.post(config.mcpPath, async (req, res) => {
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined
    });
    res.on("close", () => {
      transport.close().catch((error) => {
        logger.warn("Failed to close MCP HTTP transport", {
          error: String(error)
        });
      });
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  app.get(config.mcpPath, (_req, res) => {
    res.status(405).json({
      error: "method_not_allowed",
      message: "Use POST for stateless streamable HTTP MCP requests."
    });
  });

  const httpServer = app.listen(config.port, config.host, () => {
    logger.info("Node MCP gateway running on HTTP", {
      host: config.host,
      port: config.port,
      mcpPath: config.mcpPath,
      metricsPath: config.metricsPath
    });
  });

  const shutdown = async () => {
    logger.info("Node MCP gateway shutting down");
    httpServer.close();
    await Promise.allSettled([closeRedis(), closeDb()]);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (config.transport === "stdio") {
  await runStdio();
} else {
  await runHttp();
}
