/**
 * FHIR Servers service — registry of admin-configured external FHIR servers,
 * exposed by the always-on MCP tools `list_fhir_servers`,
 * `get_fhir_server_status`, and `crud_fhir_server`.
 *
 * Faithful port of the MCP-facing surface of `src/fhir_server_service.py`:
 *   - listRegisteredFhirServers / getFhirServer (read transforms: serverPublic
 *     + serverMcpSummary + attachOauthStatus)
 *   - performFhirCrud (guard chain + outbound call)
 *
 * Scope note: the outbound CRUD path is implemented for No-Auth servers. OAuth2
 * (client_credentials / authorization_code), private_key_jwt, and the admin
 * registration/discovery pipeline are NOT ported here yet — an OAuth server call
 * raises a clear error. The MCP parity surface (no servers configured) only
 * exercises the empty-list / not-found paths, which are fully faithful.
 */

import { query } from "./db.js";
import { logInfo } from "./logger.js";

const AUTH_NONE = "none";
const AUTH_OAUTH2_CC = "oauth2_client_credentials";
const AUTH_OAUTH2_AC = "oauth2_authorization_code";
const OAUTH2_AUTH_TYPES = new Set([AUTH_OAUTH2_CC, AUTH_OAUTH2_AC]);
const AUTH_PROFILE_NONE = "none";
const TOKEN_AUTH_BASIC = "client_secret_basic";

const DEFAULT_OPERATIONS = ["metadata", "read", "search"];
const READ_OPERATIONS = new Set(["metadata", "read", "search"]);
const WRITE_OPERATIONS = new Set(["create", "update", "patch", "delete"]);
const ALLOWED_OPERATIONS = new Set([...READ_OPERATIONS, ...WRITE_OPERATIONS]);

const TOKEN_STRATEGY_FRESH = "fresh";
const TOKEN_STRATEGY_CACHED = "cached";
const TOKEN_STRATEGY_AUTO = "auto";
const TOKEN_STRATEGY_DEFAULTS = new Set([TOKEN_STRATEGY_FRESH, TOKEN_STRATEGY_CACHED]);
const DEFAULT_TOKEN_STRATEGY = TOKEN_STRATEGY_FRESH;

const RESOURCE_TYPE_RE = /^[A-Z][A-Za-z0-9]{0,63}$/;
const RESOURCE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/;
const MAX_RESPONSE_CHARS = 300_000;

type Json = Record<string, unknown>;

function jsonValue(value: unknown, fallback: unknown): unknown {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") {
    if (!value) return fallback;
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }
  return value;
}

function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function cleanText(value: unknown): string {
  return String(value ?? "").trim();
}

function resolveTokenStrategy(requested: string | null, serverDefault: string | null): string {
  const req = (requested || TOKEN_STRATEGY_AUTO).trim().toLowerCase();
  if (TOKEN_STRATEGY_DEFAULTS.has(req)) return req;
  const sd = (serverDefault || "").trim().toLowerCase();
  if (TOKEN_STRATEGY_DEFAULTS.has(sd)) return sd;
  return DEFAULT_TOKEN_STRATEGY;
}

/** Mirror of `_server_public` (DB row → non-sensitive record). */
export function serverPublic(row: Json): Json {
  return {
    fhir_server_id: String(row.fhir_server_id),
    server_key: row.server_key,
    name: row.name,
    display_name: row.display_name || "",
    environment: row.environment || "",
    tags: jsonValue(row.tags, []),
    description: row.description || "",
    base_url: row.base_url,
    test_path: row.test_path || "",
    default_token_strategy: row.default_token_strategy || "",
    enabled: Boolean(row.enabled),
    is_default: Boolean(row.is_default),
    auth_type: row.auth_type,
    auth_profile: row.auth_profile || AUTH_PROFILE_NONE,
    auth_server_url: row.auth_server_url || "",
    metadata_url: row.metadata_url || "",
    authorization_endpoint: row.authorization_endpoint || "",
    token_endpoint: row.token_endpoint || "",
    use_metadata: Boolean(row.use_metadata),
    client_id: row.client_id || "",
    client_secret_configured: Boolean(row.client_secret_configured),
    token_auth_method: row.token_auth_method || TOKEN_AUTH_BASIC,
    client_private_key_configured: Boolean(row.client_private_key_configured),
    jwt_signing_alg: row.jwt_signing_alg || "",
    jwt_kid: row.jwt_kid || "",
    client_public_jwk_configured: Boolean(row.client_public_jwk_json),
    scope: row.scope || "",
    resource: row.resource || "",
    requested_token_type: row.requested_token_type || "",
    metadata_headers_json: jsonValue(row.metadata_headers_json, {}),
    token_headers_json: jsonValue(row.token_headers_json, {}),
    resource_headers_json: jsonValue(row.resource_headers_json, {}),
    verify_tls: Boolean(row.verify_tls),
    timeout_seconds: Number(row.timeout_seconds),
    allowed_resource_types: jsonValue(row.allowed_resource_types, []),
    allowed_operations: jsonValue(row.allowed_operations, DEFAULT_OPERATIONS),
    last_probe_status: row.last_probe_status || "",
    last_probe_at: toIso(row.last_probe_at),
    last_probe_error: row.last_probe_error || "",
    capability_summary: jsonValue(row.capability_summary_json, {}),
    created_by: row.created_by || "",
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

/** Mirror of `server_mcp_summary` (LLM-facing projection; secrets never included). */
export function serverMcpSummary(server: Json): Json {
  const capability = (server.capability_summary as Json) || {};
  const supportedResources = (capability.supported_resources as unknown[]) || [];
  const authType = (server.auth_type as string) || AUTH_NONE;
  const isOauth = OAUTH2_AUTH_TYPES.has(authType);
  const auth: Json = {
    required: authType !== AUTH_NONE,
    type: authType,
    profile: server.auth_profile || AUTH_PROFILE_NONE,
  };
  if (isOauth) {
    auth.token_auth_method = server.token_auth_method || TOKEN_AUTH_BASIC;
    auth.uses_metadata = Boolean(server.use_metadata);
    auth.scopes = server.scope || "";
  }
  if (authType === AUTH_OAUTH2_CC) {
    auth.token_strategy_default = resolveTokenStrategy(
      TOKEN_STRATEGY_AUTO,
      (server.default_token_strategy as string) || null,
    );
  }
  if (authType === AUTH_OAUTH2_AC) {
    const status = ((server.oauth_status as Json)?.status as string) || "not_authorized";
    auth.authorization_status = status;
    auth.authorized = status === "authorized";
  }
  const lastStatus = (server.last_probe_status as string) || "";
  return {
    server_key: server.server_key,
    name: server.name,
    description: server.description || "",
    base_url: server.base_url,
    enabled: Boolean(server.enabled),
    default: Boolean(server.is_default),
    allowed_resource_types: server.allowed_resource_types || [],
    allowed_operations: server.allowed_operations || DEFAULT_OPERATIONS,
    fhir_version: (capability.fhirVersion as string) || "",
    supported_resources: supportedResources
      .filter((item): item is Json => typeof item === "object" && item !== null && Boolean((item as Json).type))
      .map((item) => item.type),
    auth,
    test_path: server.test_path || "",
    probe: {
      status: lastStatus || "unknown",
      ok: lastStatus === "ok",
      checked_at: server.last_probe_at || null,
      error: String(server.last_probe_error || "").slice(0, 300),
    },
  };
}

const SELECT_COLS = `*,
  (client_secret_ciphertext IS NOT NULL) AS client_secret_configured,
  (client_private_key_ciphertext IS NOT NULL) AS client_private_key_configured`;

/** Mirror of `attach_oauth_status` — enrich OAuth servers with their stored grant status. */
export async function attachOauthStatus(servers: Json[]): Promise<void> {
  for (const server of servers) {
    if (!OAUTH2_AUTH_TYPES.has(server.auth_type as string)) continue;
    const fallback = {
      status: "not_authorized",
      access_expires_at: null,
      refresh_expires_at: null,
      has_refresh: false,
      scope: "",
    };
    try {
      const r = await query<Json>(
        `SELECT access_token_expires_at, refresh_token_expires_at,
                (refresh_token_ciphertext IS NOT NULL) AS has_refresh, scope
         FROM admin.fhir_server_oauth_tokens
         WHERE fhir_server_id = $1`,
        [server.fhir_server_id],
      );
      const t = r.rows[0];
      if (!t) {
        server.oauth_status = fallback;
        continue;
      }
      const accessExp = t.access_token_expires_at ? new Date(t.access_token_expires_at as string) : null;
      const authorized = accessExp ? accessExp.getTime() > Date.now() : false;
      server.oauth_status = {
        status: authorized ? "authorized" : "expired",
        access_expires_at: toIso(t.access_token_expires_at),
        refresh_expires_at: toIso(t.refresh_token_expires_at),
        has_refresh: Boolean(t.has_refresh),
        scope: t.scope || "",
      };
    } catch {
      server.oauth_status = fallback;
    }
  }
}

export class FHIRServerService {
  async initialize(): Promise<void> {
    logInfo("FHIR Server Service initialized");
  }

  /** Mirror of `list_fhir_servers` (service-level). */
  private async listRegistered(includeDisabled: boolean): Promise<Json[]> {
    const where = includeDisabled ? "" : "WHERE enabled = TRUE";
    const r = await query<Json>(
      `SELECT ${SELECT_COLS} FROM admin.fhir_servers ${where}
       ORDER BY is_default DESC, server_key ASC`,
    );
    return r.rows.map((row) => serverPublic(row));
  }

  /** Mirror of `_fetch_server_row` + `get_fhir_server` (no secret decryption needed). */
  private async fetchServer(identifier: string, includeDisabled = true): Promise<Json | null> {
    const disabledSql = includeDisabled ? "" : "AND enabled = TRUE";
    if (identifier.trim().toLowerCase() === "default") {
      const r = await query<Json>(
        `SELECT ${SELECT_COLS} FROM admin.fhir_servers
         WHERE is_default = TRUE ${disabledSql} LIMIT 1`,
      );
      return r.rows[0] ? serverPublic(r.rows[0]) : null;
    }
    const r = await query<Json>(
      `SELECT ${SELECT_COLS} FROM admin.fhir_servers
       WHERE (fhir_server_id::text = $1 OR server_key = lower($1) OR lower(name) = lower($1))
       ${disabledSql}`,
      [identifier],
    );
    return r.rows[0] ? serverPublic(r.rows[0]) : null;
  }

  /** Tool: `list_fhir_servers`. */
  async listFhirServers(includeDisabled: boolean): Promise<Json> {
    const servers = await this.listRegistered(includeDisabled);
    await attachOauthStatus(servers);
    return { count: servers.length, servers: servers.map((s) => serverMcpSummary(s)) };
  }

  /** Tool: `get_fhir_server_status`. */
  async getFhirServerStatus(serverKey: string): Promise<Json> {
    const server = await this.fetchServer(serverKey);
    if (!server) {
      return { error: "FHIR server not found", detail: `No server matches '${serverKey}'.` };
    }
    await attachOauthStatus([server]);
    return serverMcpSummary(server);
  }

  /** Tool: `crud_fhir_server` — faithful guard chain + No-Auth outbound. */
  async crudFhirServer(args: {
    server_key: string;
    operation: string;
    resource_type: string;
    resource_id: string;
    query_json: string;
    resource_json: string;
    patch_json: string;
    confirm_write: boolean;
    token_strategy: string;
  }): Promise<Json> {
    try {
      const server = await this.fetchServer(args.server_key, false);
      if (!server) {
        // Mirror perform_fhir_crud's ValueError → _json_error(str(exc)).
        return { error: "FHIR server not found or disabled" };
      }

      const op = args.operation.trim().toLowerCase();
      const allowedOps = new Set(
        ((server.allowed_operations as string[]) || DEFAULT_OPERATIONS),
      );
      if (!allowedOps.has(op)) {
        return { error: `Operation '${op}' is not allowed for server '${server.server_key}'` };
      }
      if (WRITE_OPERATIONS.has(op) && !args.confirm_write) {
        return { error: "Write operations require confirm_write=true" };
      }
      if (op !== "metadata") {
        const rt = this.validateResourceType(args.resource_type);
        const allowedTypes = new Set((server.allowed_resource_types as string[]) || []);
        if (allowedTypes.size > 0 && !allowedTypes.has(rt)) {
          return { error: `Resource type '${rt}' is not allowed for server '${server.server_key}'` };
        }
      }

      if (server.auth_type !== AUTH_NONE) {
        // OAuth token machinery (CC/AC, private_key_jwt) is not ported to the Node
        // backend yet; surface a clear, non-silent error instead of a wrong call.
        return {
          error:
            "OAuth-authenticated FHIR server calls are not yet supported by the Node backend",
          detail: `auth_type='${server.auth_type as string}'`,
        };
      }

      const effectiveStrategy = resolveTokenStrategy(
        args.token_strategy,
        (server.default_token_strategy as string) || null,
      );
      return await this.callFhir(server, {
        operation: op,
        resourceType: args.resource_type,
        resourceId: args.resource_id,
        query: args.query_json,
        resource: args.resource_json,
        patch: args.patch_json,
        tokenStrategy: effectiveStrategy,
      });
    } catch (exc) {
      const msg = String((exc as Error).message);
      // ValueError-equivalents (validation) surface as plain {error}; everything
      // else mirrors the generic catch in the Python tool.
      if ((exc as { isValidation?: boolean }).isValidation) return { error: msg };
      return { error: "FHIR CRUD request failed", detail: msg };
    }
  }

  // ── crud helpers (mirror the Python privates) ──────────────────────────

  private validateResourceType(resourceType: string): string {
    const value = cleanText(resourceType);
    if (!RESOURCE_TYPE_RE.test(value)) {
      throw Object.assign(new Error("resource_type must be a valid FHIR ResourceType"), {
        isValidation: true,
      });
    }
    return value;
  }

  private validateResourceId(resourceId: string): string {
    const value = cleanText(resourceId);
    if (!RESOURCE_ID_RE.test(value)) {
      throw Object.assign(new Error("resource_id must be a valid FHIR logical id"), {
        isValidation: true,
      });
    }
    return value;
  }

  private normalizeQuery(q: unknown): Record<string, string> {
    if (q === null || q === undefined || q === "") return {};
    const raw = jsonValue(q, q);
    if (typeof raw === "string") {
      const out: Record<string, string> = {};
      for (const [k, v] of new URLSearchParams(raw.replace(/^\?/, "")).entries()) out[k] = v;
      return out;
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw Object.assign(new Error("query must be a JSON object or query string"), {
        isValidation: true,
      });
    }
    const result: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw as Json)) {
      if (v === null || v === undefined) continue;
      result[String(k)] = String(v);
    }
    return result;
  }

  private normalizeJsonBody(value: unknown, label: string): unknown {
    if (value === null || value === undefined || value === "") return null;
    if (typeof value === "string") {
      try {
        return JSON.parse(value);
      } catch {
        throw Object.assign(new Error(`${label} must be valid JSON`), { isValidation: true });
      }
    }
    return value;
  }

  private operationToRequest(
    operation: string,
    resourceType: string,
    resourceId: string,
    queryArg: unknown,
    resource: unknown,
    patch: unknown,
  ): { method: string; path: string; queryParams: Record<string, string>; body: unknown; contentType: string } {
    const op = operation.trim().toLowerCase();
    if (!ALLOWED_OPERATIONS.has(op)) {
      throw Object.assign(
        new Error(`operation must be one of: ${[...ALLOWED_OPERATIONS].sort().join(", ")}`),
        { isValidation: true },
      );
    }
    const queryParams = this.normalizeQuery(queryArg);
    let contentType = "application/fhir+json";

    if (op === "metadata") return { method: "GET", path: "metadata", queryParams: {}, body: null, contentType };
    const rt = this.validateResourceType(resourceType);
    if (op === "read") {
      const rid = this.validateResourceId(resourceId);
      return { method: "GET", path: `${rt}/${rid}`, queryParams: {}, body: null, contentType };
    }
    if (op === "search") {
      if (!("_count" in queryParams)) queryParams._count = "50";
      return { method: "GET", path: rt, queryParams, body: null, contentType };
    }
    if (op === "create") {
      const body = this.normalizeJsonBody(resource, "resource_json");
      if (body === null) throw Object.assign(new Error("resource_json is required for create"), { isValidation: true });
      return { method: "POST", path: rt, queryParams: {}, body, contentType };
    }
    if (op === "update") {
      const rid = this.validateResourceId(resourceId);
      const body = this.normalizeJsonBody(resource, "resource_json");
      if (body === null) throw Object.assign(new Error("resource_json is required for update"), { isValidation: true });
      return { method: "PUT", path: `${rt}/${rid}`, queryParams: {}, body, contentType };
    }
    if (op === "patch") {
      const rid = this.validateResourceId(resourceId);
      const body = this.normalizeJsonBody(patch, "patch_json");
      if (body === null) throw Object.assign(new Error("patch_json is required for patch"), { isValidation: true });
      if (Array.isArray(body)) contentType = "application/json-patch+json";
      return { method: "PATCH", path: `${rt}/${rid}`, queryParams: {}, body, contentType };
    }
    if (op === "delete") {
      const rid = this.validateResourceId(resourceId);
      return { method: "DELETE", path: `${rt}/${rid}`, queryParams: {}, body: null, contentType };
    }
    throw Object.assign(new Error(`Unsupported operation: ${operation}`), { isValidation: true });
  }

  private fhirUrl(server: Json, path: string): string {
    return `${String(server.base_url).replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
  }

  private httpErrorExplanation(statusCode: number): string | null {
    if (statusCode === 401) {
      return "401 Unauthorized: token may be expired, invalid, scoped to the wrong audience/resource, or rejected by server policy.";
    }
    if (statusCode === 403) {
      return "403 Forbidden: token is valid but not authorized for this FHIR operation.";
    }
    return null;
  }

  /** Mirror of `_call_fhir` for No-Auth servers (token always empty). */
  private async callFhir(
    server: Json,
    opts: {
      operation: string;
      resourceType: string;
      resourceId: string;
      query: unknown;
      resource: unknown;
      patch: unknown;
      tokenStrategy: string;
    },
  ): Promise<Json> {
    const { method, path, queryParams, body, contentType } = this.operationToRequest(
      opts.operation,
      opts.resourceType,
      opts.resourceId,
      opts.query,
      opts.resource,
      opts.patch,
    );
    let url = this.fhirUrl(server, path);
    const qs = new URLSearchParams(queryParams).toString();
    if (qs) url += `?${qs}`;

    const headers: Record<string, string> = { Accept: "application/fhir+json, application/json" };
    const resourceHeaders = jsonValue(server.resource_headers_json, {}) as Json;
    for (const [k, v] of Object.entries(resourceHeaders)) {
      if (k.toLowerCase() === "authorization") continue;
      headers[k] = String(v);
    }
    if (body !== null) headers["Content-Type"] = contentType;

    const start = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Number(server.timeout_seconds) * 1000);
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: body !== null ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    const durationMs = Date.now() - start;
    const rawText = await response.text();
    const truncated = rawText.length > MAX_RESPONSE_CHARS;
    let parsedJson: unknown = null;
    if (!truncated) {
      try {
        parsedJson = JSON.parse(rawText);
      } catch {
        parsedJson = null;
      }
    }
    const result: Json = {
      ok: response.status >= 200 && response.status < 300,
      operation: opts.operation,
      method,
      url: response.url,
      status_code: response.status,
      reason: response.statusText,
      duration_ms: durationMs,
      content_type: response.headers.get("content-type") || "",
      truncated,
      explanation: this.httpErrorExplanation(response.status),
    };
    if (parsedJson !== null) result.json = parsedJson;
    else result.text = rawText.slice(0, MAX_RESPONSE_CHARS);
    return result;
  }
}
