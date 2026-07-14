import { timingSafeEqual } from "node:crypto";

export type PublicToolsAuthMode = "none" | "bearer";

export interface PublicToolsSecurity {
  authMode: PublicToolsAuthMode;
  bearerToken: string;
  corsOrigins: string[];
}

export function resolvePublicToolsSecurity(
  modeSetting: string,
  bearerToken: string,
  corsOriginsSetting: string,
): PublicToolsSecurity {
  const mode = (modeSetting.trim().toLowerCase() || "none") as PublicToolsAuthMode;
  if (mode !== "none" && mode !== "bearer") {
    throw new Error("PUBLIC_TOOLS_AUTH_MODE must be none or bearer");
  }

  const token = bearerToken.trim();
  if (mode === "bearer" && !token) {
    throw new Error("PUBLIC_TOOLS_BEARER_TOKEN is required when PUBLIC_TOOLS_AUTH_MODE=bearer");
  }

  const configuredOrigins = corsOriginsSetting
    .split(",")
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  const corsOrigins = configuredOrigins.length > 0 ? [...new Set(configuredOrigins)] : mode === "none" ? ["*"] : [];
  if (mode === "bearer" && corsOrigins.includes("*")) {
    throw new Error("PUBLIC_TOOLS_CORS_ORIGINS cannot contain * when bearer authentication is enabled");
  }
  return { authMode: mode, bearerToken: token, corsOrigins };
}

export function bearerTokenMatches(authorization: string | undefined, expectedToken: string): boolean {
  if (!authorization || !expectedToken) return false;
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  if (!match) return false;
  const actual = Buffer.from(match[1], "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function allowedCorsOrigin(requestOrigin: string, allowedOrigins: string[]): string | null {
  const origin = requestOrigin.trim().replace(/\/+$/, "");
  if (!origin) return null;
  if (allowedOrigins.includes("*")) return "*";
  return allowedOrigins.includes(origin) ? origin : null;
}
