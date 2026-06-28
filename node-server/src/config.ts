/**
 * Application configuration.
 *
 * Mirrors `src/config.py` (`AppConfig.from_env`) field-for-field so the Node
 * runtime reads the exact same environment variables with the exact same
 * defaults. Keep this in lockstep with the Python side — any divergence is a
 * parity bug.
 */

import "dotenv/config";

export type TransportType = "stdio" | "streamable-http" | "sse";

export interface AppConfig {
  // MCP transport
  transport: TransportType;
  host: string;
  port: number;
  path: string;

  // Database
  databaseUrl: string;

  // Redis
  redisUrl: string;

  // App
  logLevel: string;
  adminEnabled: boolean;
  adminUsername: string;
  adminPasswordHash: string;
  adminSessionSecret: string;
  adminSessionTtlMinutes: number;
  adminMaxUploadMb: number;
  // Public origin (scheme://host) used to build the OAuth2 Authorization Code
  // redirect_uri. Blank -> derive from the request Host header.
  publicBaseUrl: string;

  // Prometheus metrics port (Python: metrics.start_metrics_server -> METRICS_PORT)
  metricsPort: number;
}

function env(name: string, fallback = ""): string {
  const v = process.env[name];
  return v === undefined ? fallback : v;
}

export function loadConfig(): AppConfig {
  let transport = env("MCP_TRANSPORT", "stdio").toLowerCase();
  if (!["stdio", "sse", "streamable-http"].includes(transport)) {
    transport = "stdio";
  }

  const databaseUrl = env("DATABASE_URL", "");
  if (!databaseUrl) {
    throw new Error("DATABASE_URL environment variable is required");
  }

  return {
    transport: transport as TransportType,
    host: env("MCP_HOST", "0.0.0.0"),
    port: Number.parseInt(env("MCP_PORT", "8000"), 10),
    path: env("MCP_PATH", "/mcp"),
    databaseUrl,
    redisUrl: env("REDIS_URL", "redis://localhost:6379/0"),
    logLevel: env("LOG_LEVEL", "INFO").toUpperCase(),
    adminEnabled: env("ADMIN_ENABLED", "false").toLowerCase() === "true",
    adminUsername: env("ADMIN_USERNAME").trim(),
    adminPasswordHash: env("ADMIN_PASSWORD_HASH").trim(),
    adminSessionSecret: env("ADMIN_SESSION_SECRET").trim(),
    adminSessionTtlMinutes: Number.parseInt(env("ADMIN_SESSION_TTL_MINUTES", "240"), 10),
    adminMaxUploadMb: Number.parseInt(env("ADMIN_MAX_UPLOAD_MB", "512"), 10),
    publicBaseUrl: env("PUBLIC_BASE_URL").trim().replace(/\/+$/, ""),
    metricsPort: Number.parseInt(env("METRICS_PORT", "9090"), 10),
  };
}

export function adminReady(c: AppConfig): boolean {
  return (
    c.adminEnabled &&
    Boolean(c.adminUsername) &&
    Boolean(c.adminPasswordHash) &&
    Boolean(c.adminSessionSecret)
  );
}

let _config: AppConfig | null = null;

/** Process-wide singleton, parsed once. */
export function config(): AppConfig {
  if (_config === null) {
    _config = loadConfig();
  }
  return _config;
}
