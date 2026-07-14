/**
 * Application configuration.
 *
 * Mirrors `src/config.py` (`AppConfig.from_env`) field-for-field so the Node
 * runtime reads the exact same environment variables with the exact same
 * defaults. Keep this in lockstep with the Python side — any divergence is a
 * parity bug.
 */

import "dotenv/config";
import {
  resolvePublicToolsSecurity,
  type PublicToolsAuthMode,
} from "./publicToolsSecurity.js";

export type TransportType = "stdio" | "streamable-http" | "sse";

export interface AppConfig {
  // MCP transport
  transport: TransportType;
  host: string;
  port: number;
  path: string;
  publicToolsAuthMode: PublicToolsAuthMode;
  publicToolsBearerToken: string;
  publicToolsCorsOrigins: string[];

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
  adminCookieSecure: boolean;
  adminMaxUploadMb: number;
  // Public origin (scheme://host) used to build the OAuth2 Authorization Code
  // redirect_uri. Blank -> derive from the request Host header.
  publicBaseUrl: string;

  // Prometheus metrics port (Python: metrics.start_metrics_server -> METRICS_PORT)
  metricsPort: number;

  // WebAuthn / passkey (Node-only feature — no Python counterpart). The RP ID is
  // the registrable domain the admin console is served from; passkeys are scoped
  // to it and only usable over HTTPS on that origin (or localhost for dev).
  webauthnRpId: string;
  webauthnRpName: string;
  webauthnOrigins: string[];
}

/**
 * Best-effort host extraction from a `scheme://host[:port]/…` URL. Returns "" on
 * a blank/invalid input so callers can fall back to a hard default.
 */
function hostOf(url: string): string {
  if (!url) return "";
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
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

  const publicBaseUrl = env("PUBLIC_BASE_URL").trim().replace(/\/+$/, "");
  const publicTools = resolvePublicToolsSecurity(
    env("PUBLIC_TOOLS_AUTH_MODE"),
    env("PUBLIC_TOOLS_BEARER_TOKEN"),
    env("PUBLIC_TOOLS_CORS_ORIGINS"),
  );

  return {
    transport: transport as TransportType,
    host: env("MCP_HOST", "0.0.0.0"),
    port: Number.parseInt(env("MCP_PORT", "8000"), 10),
    path: env("MCP_PATH", "/mcp"),
    publicToolsAuthMode: publicTools.authMode,
    publicToolsBearerToken: publicTools.bearerToken,
    publicToolsCorsOrigins: publicTools.corsOrigins,
    databaseUrl,
    redisUrl: env("REDIS_URL", "redis://localhost:6379/0"),
    logLevel: env("LOG_LEVEL", "INFO").toUpperCase(),
    adminEnabled: env("ADMIN_ENABLED", "false").toLowerCase() === "true",
    adminUsername: env("ADMIN_USERNAME").trim(),
    adminPasswordHash: env("ADMIN_PASSWORD_HASH").trim(),
    adminSessionSecret: env("ADMIN_SESSION_SECRET").trim(),
    adminSessionTtlMinutes: Number.parseInt(env("ADMIN_SESSION_TTL_MINUTES", "240"), 10),
    adminCookieSecure: resolveAdminCookieSecure(env("ADMIN_COOKIE_SECURE"), publicBaseUrl),
    adminMaxUploadMb: Number.parseInt(env("ADMIN_MAX_UPLOAD_MB", "512"), 10),
    publicBaseUrl,
    metricsPort: Number.parseInt(env("METRICS_PORT", "9090"), 10),
    ...webauthnFromEnv(publicBaseUrl),
  };
}

export function resolveAdminCookieSecure(setting: string, publicBaseUrl: string): boolean {
  const normalized = setting.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  if (normalized) throw new Error("ADMIN_COOKIE_SECURE must be true or false");
  return publicBaseUrl.toLowerCase().startsWith("https://");
}

/**
 * Resolve the WebAuthn relying-party config. Defaults are derived so a standard
 * deployment needs no extra env: RP ID falls back to the PUBLIC_BASE_URL host,
 * then to the production domain; the expected origin(s) default to
 * `https://<rpId>`. WEBAUTHN_ORIGIN may be a comma-separated allow-list (e.g. to
 * add `http://localhost:3000` for local dev) and is passed verbatim to the
 * verify calls as `expectedOrigin`.
 */
function webauthnFromEnv(publicBaseUrl: string): {
  webauthnRpId: string;
  webauthnRpName: string;
  webauthnOrigins: string[];
} {
  const rpId =
    env("WEBAUTHN_RP_ID").trim() || hostOf(publicBaseUrl) || "taiwan-health-mcp.gugulu.tw";
  const rpName = env("WEBAUTHN_RP_NAME").trim() || "Taiwan Health MCP — Admin";
  const originsRaw = env("WEBAUTHN_ORIGIN").trim();
  const origins = originsRaw
    ? originsRaw.split(",").map((o) => o.trim()).filter(Boolean)
    : [`https://${rpId}`];
  return { webauthnRpId: rpId, webauthnRpName: rpName, webauthnOrigins: origins };
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
