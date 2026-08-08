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
  // Plaintext bootstrap password (ADMIN_INITIAL_PASSWORD). Seeded only when the
  // DB has no credential row yet; ignored once a password exists.
  adminInitialPassword: string;
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

/**
 * Parse an integer setting, refusing anything that is not one.
 *
 * Failing loudly here matters: `Number.parseInt("abc")` is NaN, and NaN survives
 * both `??` (which only catches null/undefined) and `Math.max(NaN, 1)` (which
 * returns NaN, not the floor). A bad value therefore used to reach runtime
 * intact and break something unrelated — a non-numeric ADMIN_SESSION_TTL_MINUTES
 * produced a session token whose `exp` serialised as invalid JSON, so login
 * succeeded and every later request was silently unauthenticated. A typo should
 * stop the process here instead, naming itself.
 */
function envInt(name: string, fallback: number, opts: { min?: number } = {}): number {
  const raw = env(name).trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new Error(`${name} must be an integer, got ${JSON.stringify(raw)}`);
  }
  const min = opts.min ?? 1;
  if (value < min) {
    throw new Error(`${name} must be >= ${min}, got ${value}`);
  }
  return value;
}

/**
 * Parse a boolean setting, refusing anything ambiguous.
 *
 * The old `=== "true"` comparison quietly read `1`, `yes` and `on` as false, so
 * a deployment that believed the admin console was on got 404s with no clue why.
 */
function envBool(name: string, fallback: boolean): boolean {
  const raw = env(name).trim().toLowerCase();
  if (!raw) return fallback;
  if (["true", "1", "yes", "on"].includes(raw)) return true;
  if (["false", "0", "no", "off"].includes(raw)) return false;
  throw new Error(`${name} must be a boolean (true/false), got ${JSON.stringify(raw)}`);
}

export function loadConfig(): AppConfig {
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
    // Not read from the environment: main() always starts the HTTP listener, so
    // streamable-http is the only transport this server actually serves. It used
    // to come from MCP_TRANSPORT, which silently fell back to "stdio" on a typo
    // and only ever changed what the admin Overview printed.
    transport: "streamable-http",
    host: env("MCP_HOST", "0.0.0.0"),
    port: envInt("MCP_PORT", 8000),
    path: env("MCP_PATH", "/mcp"),
    publicToolsAuthMode: publicTools.authMode,
    publicToolsBearerToken: publicTools.bearerToken,
    publicToolsCorsOrigins: publicTools.corsOrigins,
    databaseUrl,
    redisUrl: env("REDIS_URL", "redis://localhost:6379/0"),
    logLevel: env("LOG_LEVEL", "INFO").toUpperCase(),
    adminEnabled: envBool("ADMIN_ENABLED", true),
    adminUsername: env("ADMIN_USERNAME").trim(),
    adminPasswordHash: env("ADMIN_PASSWORD_HASH").trim(),
    adminInitialPassword: env("ADMIN_INITIAL_PASSWORD").trim(),
    adminSessionSecret: env("ADMIN_SESSION_SECRET").trim(),
    adminSessionTtlMinutes: envInt("ADMIN_SESSION_TTL_MINUTES", 240),
    adminCookieSecure: resolveAdminCookieSecure(env("ADMIN_COOKIE_SECURE"), publicBaseUrl),
    adminMaxUploadMb: envInt("ADMIN_MAX_UPLOAD_MB", 512),
    publicBaseUrl,
    metricsPort: envInt("METRICS_PORT", 9090),
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
    (Boolean(c.adminPasswordHash) || Boolean(c.adminInitialPassword)) &&
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
