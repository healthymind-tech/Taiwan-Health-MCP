import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { dbHealth } from "./db.js";
import { redisHealth } from "./cache.js";
import { toolDuration, toolRequests } from "./metrics.js";
import { searchMedicalCodes } from "./services/icdService.js";

async function measuredTool<T>(tool: string, fn: () => Promise<T>): Promise<T> {
  const end = toolDuration.labels(tool).startTimer();
  try {
    const result = await fn();
    toolRequests.labels(tool, "success").inc();
    end();
    return result;
  } catch (error) {
    toolRequests.labels(tool, "error").inc();
    end();
    throw error;
  }
}

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "taiwanHealthMcpNodeGateway",
    version: "0.1.0"
  });

  server.tool("health_check", {}, async () =>
    measuredTool("health_check", async () => {
      const [database, cache] = await Promise.all([dbHealth(), redisHealth()]);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                status: database ? "ok" : "degraded",
                database: database ? "ok" : "error",
                cache: cache ? "ok" : "error",
                gateway: "node"
              },
              null,
              2
            )
          }
        ]
      };
    })
  );

  server.tool(
    "search_medical_codes",
    {
      keyword: z.string().min(1),
      type: z.enum(["diagnosis", "procedure", "all"]).default("all"),
      limit: z.number().int().min(1).max(10).default(3)
    },
    async ({ keyword, type, limit }) =>
      measuredTool("search_medical_codes", async () => {
        const result = await searchMedicalCodes(keyword, type, limit);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      })
  );

  return server;
}
