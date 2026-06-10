import "dotenv/config";

export type TransportMode = "stdio" | "streamable-http";

export interface AppConfig {
  transport: TransportMode;
  host: string;
  port: number;
  mcpPath: string;
  metricsPath: string;
  databaseUrl: string;
  redisUrl: string;
  logLevel: string;
}

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function transportFromEnv(): TransportMode {
  const raw = (process.env.NODE_TRANSPORT ?? "streamable-http").trim();
  if (raw === "stdio" || raw === "streamable-http") return raw;
  throw new Error(`Unsupported NODE_TRANSPORT '${raw}'`);
}

export const config: AppConfig = {
  transport: transportFromEnv(),
  host: process.env.NODE_HOST ?? "0.0.0.0",
  port: intFromEnv("NODE_PORT", 8010),
  mcpPath: process.env.NODE_MCP_PATH ?? "/mcp",
  metricsPath: process.env.NODE_METRICS_PATH ?? "/metrics",
  databaseUrl:
    process.env.DATABASE_URL ??
    "postgresql://mcp:change-me@localhost:5432/taiwan_health",
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379/0",
  logLevel: process.env.LOG_LEVEL ?? "info"
};
