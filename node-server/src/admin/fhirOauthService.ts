/**
 * fhirOauthService.ts — OAuth2 Authorization Code (+ PKCE) flow for external
 * FHIR servers. Faithful port of `src/fhir_oauth_service.py`.
 *
 * Authorization Code: a human logs in at the external authorization server via
 * the browser; the resulting access+refresh pair is an end-user delegation,
 * stored encrypted (pgcrypto, same key as client_secret) and refreshed over
 * time. Client Credentials "Authorize" stores a token too (no refresh → renew
 * re-runs the grant). PKCE is mandatory (S256).
 *
 * Shared token/HTTP/endpoint helpers come from `adminFhirServers.ts` (mirrors
 * the Python module's `import fhir_server_service as fss`).
 */

import crypto from "node:crypto";
import { query } from "../db.js";
import { tsIsoExpr, pyIso } from "./adminJobs.js";
import {
  fetchServerRow,
  serverPrivate,
  fetchMetadata,
  deriveTokenEndpoint,
  applyClientAuth,
  tokenRequestForm,
  parseHeaders,
  rawRequest,
  popCcTokenCache,
  runTokenSingleFlight,
  OAUTH2_AUTH_TYPES,
  AUTH_OAUTH2_CC,
  AUTH_OAUTH2_AC,
  AUTH_PROFILE_SMART,
  TOKEN_CACHE_SKEW_SECONDS,
} from "./adminFhirServers.js";

type Json = Record<string, unknown>;

const CODE_VERIFIER_BYTES = 64;
const CODE_CHALLENGE_METHOD = "S256";
const PENDING_STATE_TTL_SECONDS = 600;
const ACCESS_REFRESH_SKEW_SECONDS = TOKEN_CACHE_SKEW_SECONDS;
const REFRESH_TOKEN_RENEW_SKEW_SECONDS = 86_400;

/** Base OAuth error (ValueError-equivalent → HTTP 400). */
export class OAuthError extends Error {}
/** No usable stored grant — operator must click Authorize. */
export class OAuthNotAuthorizedError extends OAuthError {}
/** Refresh token rejected — re-authorization required. */
export class OAuthRefreshFailedError extends OAuthError {}

// ── PKCE helpers ──────────────────────────────────────────────────────────────
export function generatePkcePair(): [string, string] {
  const verifier = crypto.randomBytes(CODE_VERIFIER_BYTES).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier, "ascii").digest("base64url");
  return [verifier, challenge];
}
export function generateStateNonce(): string {
  return crypto.randomBytes(32).toString("base64url");
}
function now(): Date {
  return new Date();
}

// ── discovery / endpoint resolution ──────────────────────────────────────────
async function discover(server: Json): Promise<Json> {
  if (server.use_metadata && (server.metadata_url || server.auth_server_url)) {
    try {
      return await fetchMetadata({
        auth_server_url: String(server.auth_server_url || ""),
        metadata_url: String(server.metadata_url || ""),
        base_url: String(server.base_url || ""),
        auth_profile: String(server.auth_profile || "none"),
        verify_tls: Boolean(server.verify_tls),
        timeout_seconds: Number(server.timeout_seconds),
        metadata_headers_json: server.metadata_headers_json,
      });
    } catch {
      return {};
    }
  }
  return {};
}
function resolveAuthorizationEndpoint(server: Json, metadata: Json): string {
  return String(server.authorization_endpoint || metadata.authorization_endpoint || "");
}
function resolveTokenEndpoint(server: Json, metadata: Json): string {
  return String(server.token_endpoint || metadata.token_endpoint || deriveTokenEndpoint(String(server.auth_server_url || ""), ""));
}
function scopeForAuthorize(server: Json): string {
  const scopes = String(server.scope || "").split(/\s+/).filter(Boolean);
  if (server.auth_profile === AUTH_PROFILE_SMART && !scopes.includes("offline_access")) scopes.push("offline_access");
  return scopes.join(" ");
}

// ── token endpoint POST ───────────────────────────────────────────────────────
async function postToken(server: Json, tokenEndpoint: string, form: Record<string, string>): Promise<Json> {
  const headers: Record<string, string> = { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" };
  Object.assign(headers, parseHeaders(server.token_headers_json, false));
  const basicAuth = applyClientAuth(server, form, tokenEndpoint);
  const response = await rawRequest({
    method: "POST",
    url: tokenEndpoint,
    headers,
    body: new URLSearchParams(form).toString(),
    timeoutSeconds: Number(server.timeout_seconds),
    verifyTls: Boolean(server.verify_tls),
    basicAuth,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Token endpoint returned HTTP ${response.status}: ${response.text.slice(0, 500)}`);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(response.text);
  } catch {
    throw new Error("Token endpoint returned non-JSON response");
  }
  if (typeof payload !== "object" || payload === null || !(payload as Json).access_token) {
    throw new Error("Token response is missing access_token");
  }
  const tokenType = String((payload as Json).token_type || "Bearer");
  if (tokenType.toLowerCase() !== "bearer") {
    throw new Error(`Token response token_type is '${tokenType}'; expected Bearer`);
  }
  return payload as Json;
}

/** Mirror `_expiry_from`: lifetime → absolute Date, with refresh skew; ≤0 → null. */
function expiryFrom(payload: Json, key: string): Date | null {
  const raw = payload[key];
  if (raw === null || raw === undefined || raw === "") return null;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || Number.isNaN(seconds)) return null;
  if (seconds <= 0) return null;
  return new Date(Date.now() + Math.max(1, seconds - ACCESS_REFRESH_SKEW_SECONDS) * 1000);
}

const TOKEN_ROW_SELECT = `
  SELECT fhir_server_id, admin_user, state_nonce, code_verifier, redirect_uri,
         requested_scope, pending_created_at,
         (access_token_ciphertext IS NOT NULL) AS has_access,
         (refresh_token_ciphertext IS NOT NULL) AS has_refresh,
         CASE WHEN access_token_ciphertext IS NULL THEN NULL
              ELSE pgp_sym_decrypt(access_token_ciphertext, $2) END AS access_token,
         CASE WHEN refresh_token_ciphertext IS NULL THEN NULL
              ELSE pgp_sym_decrypt(refresh_token_ciphertext, $2) END AS refresh_token,
         token_type, granted_scope,
         access_token_expires_at, refresh_token_expires_at, obtained_at
  FROM admin.fhir_server_oauth_tokens`;

async function loadActiveTokenRow(fhirServerId: string, secretKey: string): Promise<Json | null> {
  const r = await query<Json>(
    `${TOKEN_ROW_SELECT}
     WHERE fhir_server_id = $1::uuid AND access_token_ciphertext IS NOT NULL
     ORDER BY obtained_at DESC NULLS LAST LIMIT 1`,
    [fhirServerId, secretKey],
  );
  return r.rows[0] ?? null;
}

/** Mirror `_store_tokens`: encrypt + persist a token response, clear pending state. */
async function storeTokens(
  fhirServerId: string,
  adminUser: string,
  payload: Json,
  opts: { secretKey: string; fallbackScope?: string; keepRefreshIfAbsent?: boolean; currentRefresh?: string | null },
): Promise<void> {
  const accessToken = String(payload.access_token);
  let refreshToken = payload.refresh_token as string | undefined;
  if (!refreshToken && opts.keepRefreshIfAbsent) refreshToken = opts.currentRefresh ?? undefined;
  const tokenType = String(payload.token_type || "Bearer");
  const grantedScope = String(payload.scope || opts.fallbackScope || "");
  const accessExpires = expiryFrom(payload, "expires_in");
  const refreshExpires = expiryFrom(payload, "refresh_expires_in");
  await query(
    `INSERT INTO admin.fhir_server_oauth_tokens AS t (
       fhir_server_id, admin_user,
       access_token_ciphertext, refresh_token_ciphertext,
       token_type, granted_scope,
       access_token_expires_at, refresh_token_expires_at,
       obtained_at, updated_at,
       state_nonce, code_verifier, redirect_uri, pending_created_at
     )
     VALUES (
       $1::uuid, $2,
       pgp_sym_encrypt($3, $9),
       CASE WHEN $4::text IS NULL OR $4 = '' THEN NULL ELSE pgp_sym_encrypt($4, $9) END,
       $5, $6, $7, $8, NOW(), NOW(), NULL, NULL, NULL, NULL
     )
     ON CONFLICT (fhir_server_id, admin_user) DO UPDATE SET
       access_token_ciphertext = pgp_sym_encrypt($3, $9),
       refresh_token_ciphertext = CASE WHEN $4::text IS NULL OR $4 = '' THEN NULL ELSE pgp_sym_encrypt($4, $9) END,
       token_type = $5, granted_scope = $6,
       access_token_expires_at = $7, refresh_token_expires_at = $8,
       obtained_at = NOW(), updated_at = NOW(),
       state_nonce = NULL, code_verifier = NULL, redirect_uri = NULL, pending_created_at = NULL`,
    [fhirServerId, adminUser, accessToken, refreshToken || "", tokenType, grantedScope, accessExpires, refreshExpires, opts.secretKey],
  );
}

async function acquireAndStoreClientCredentials(server: Json, opts: { adminUser: string; secretKey: string }): Promise<string> {
  const metadata = await discover(server);
  const tokenEndpoint = resolveTokenEndpoint(server, metadata);
  if (!tokenEndpoint) throw new OAuthError("Could not resolve the token endpoint");
  const form = tokenRequestForm(server);
  let payload: Json;
  try {
    payload = await postToken(server, tokenEndpoint, form);
  } catch (exc) {
    throw new OAuthError(`Token request failed: ${String((exc as Error).message)}`);
  }
  await storeTokens(String(server.fhir_server_id), opts.adminUser, payload, { secretKey: opts.secretKey, fallbackScope: String(server.scope || "") });
  return String(payload.access_token);
}

export async function authorizeClientCredentials(identifier: string, opts: { adminUser: string; secretKey: string }): Promise<Json> {
  const row = await fetchServerRow(identifier, opts.secretKey);
  if (!row) throw new OAuthError("FHIR server not found");
  const server = serverPrivate(row);
  if (server.auth_type !== AUTH_OAUTH2_CC) throw new OAuthError("Server is not configured for OAuth2 Client Credentials");
  await acquireAndStoreClientCredentials(server, opts);
  popCcTokenCache(String(server.fhir_server_id));
  return { ok: true, server_key: server.server_key, oauth_status: await getOauthStatus(String(server.fhir_server_id)) };
}

export async function startAuthorization(identifier: string, opts: { adminUser: string; redirectUri: string; secretKey: string }): Promise<Json> {
  const row = await fetchServerRow(identifier, null);
  if (!row) throw new OAuthError("FHIR server not found");
  const authType = row.auth_type;
  if (authType === AUTH_OAUTH2_CC) {
    const result = await authorizeClientCredentials(identifier, { adminUser: opts.adminUser, secretKey: opts.secretKey });
    result.authorized = true;
    return result;
  }
  if (authType === AUTH_OAUTH2_AC) {
    return beginAuthorization(identifier, opts);
  }
  throw new OAuthError("Server does not use OAuth2; nothing to authorize");
}

export async function beginAuthorization(identifier: string, opts: { adminUser: string; redirectUri: string; secretKey: string }): Promise<Json> {
  const row = await fetchServerRow(identifier, opts.secretKey);
  if (!row) throw new OAuthError("FHIR server not found");
  const server = serverPrivate(row);
  if (server.auth_type !== AUTH_OAUTH2_AC) throw new OAuthError("Server is not configured for OAuth2 Authorization Code");
  const metadata = await discover(server);
  const authorizationEndpoint = resolveAuthorizationEndpoint(server, metadata);
  if (!authorizationEndpoint) {
    throw new OAuthError("Could not resolve the authorization endpoint — set authorization_endpoint or enable metadata discovery");
  }
  if (!resolveTokenEndpoint(server, metadata)) throw new OAuthError("Could not resolve the token endpoint");

  const [verifier, challenge] = generatePkcePair();
  const state = generateStateNonce();
  const scope = scopeForAuthorize(server);
  await query(
    `INSERT INTO admin.fhir_server_oauth_tokens (
       fhir_server_id, admin_user, state_nonce, code_verifier, redirect_uri, requested_scope, pending_created_at, updated_at
     ) VALUES ($1::uuid, $2, $3, $4, $5, $6, NOW(), NOW())
     ON CONFLICT (fhir_server_id, admin_user) DO UPDATE SET
       state_nonce = $3, code_verifier = $4, redirect_uri = $5, requested_scope = $6,
       pending_created_at = NOW(), updated_at = NOW()`,
    [server.fhir_server_id, opts.adminUser, state, verifier, opts.redirectUri, scope],
  );

  const params = new URLSearchParams({
    response_type: "code",
    client_id: String(server.client_id || ""),
    redirect_uri: opts.redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: CODE_CHALLENGE_METHOD,
    prompt: "login",
  });
  if (scope) params.set("scope", scope);
  if (server.auth_profile === AUTH_PROFILE_SMART) params.set("aud", String(server.base_url || ""));
  return { authorization_uri: `${authorizationEndpoint}?${params.toString()}`, state };
}

export async function completeAuthorization(opts: { code: string; state: string; secretKey: string }): Promise<Json> {
  if (!opts.code || !opts.state) throw new OAuthError("Missing authorization code or state");
  const pendingRes = await query<Json>(
    `SELECT fhir_server_id, admin_user, code_verifier, redirect_uri, requested_scope, pending_created_at
     FROM admin.fhir_server_oauth_tokens WHERE state_nonce = $1`,
    [opts.state],
  );
  const pending = pendingRes.rows[0];
  if (!pending) throw new OAuthError("Invalid or expired authorization state");
  const created = pending.pending_created_at ? new Date(pending.pending_created_at as string) : null;
  if (created === null || created.getTime() < Date.now() - PENDING_STATE_TTL_SECONDS * 1000) {
    await query(
      `UPDATE admin.fhir_server_oauth_tokens SET state_nonce = NULL, code_verifier = NULL, pending_created_at = NULL, updated_at = NOW() WHERE state_nonce = $1`,
      [opts.state],
    );
    throw new OAuthError("Authorization state has expired — please retry");
  }
  const fhirServerId = String(pending.fhir_server_id);
  const row = await fetchServerRow(fhirServerId, opts.secretKey);
  if (!row) throw new OAuthError("FHIR server not found");
  const server = serverPrivate(row);
  const metadata = await discover(server);
  const tokenEndpoint = resolveTokenEndpoint(server, metadata);
  if (!tokenEndpoint) throw new OAuthError("Could not resolve the token endpoint");
  const form: Record<string, string> = {
    grant_type: "authorization_code",
    code: opts.code,
    redirect_uri: String(pending.redirect_uri || ""),
    code_verifier: String(pending.code_verifier || ""),
  };
  let payload: Json;
  try {
    payload = await postToken(server, tokenEndpoint, form);
  } catch (exc) {
    throw new OAuthError(`Token exchange failed: ${String((exc as Error).message)}`);
  }
  await storeTokens(fhirServerId, String(pending.admin_user), payload, { secretKey: opts.secretKey, fallbackScope: String(pending.requested_scope || "") });
  popCcTokenCache(fhirServerId);
  return { ok: true, server_key: server.server_key };
}

async function refreshAccessToken(server: Json, tokenRow: Json, secretKey: string): Promise<string> {
  const refreshToken = tokenRow.refresh_token as string | null;
  if (!refreshToken) {
    if (server.auth_type === AUTH_OAUTH2_CC) {
      return acquireAndStoreClientCredentials(server, { adminUser: String(tokenRow.admin_user), secretKey });
    }
    throw new OAuthNotAuthorizedError("Access token expired and no refresh token is stored — re-authorize the server in the admin console");
  }
  const metadata = await discover(server);
  const tokenEndpoint = resolveTokenEndpoint(server, metadata);
  if (!tokenEndpoint) throw new OAuthRefreshFailedError("Could not resolve the token endpoint");
  const form: Record<string, string> = { grant_type: "refresh_token", refresh_token: refreshToken };
  const grantedScope = String(tokenRow.granted_scope || "");
  if (grantedScope) form.scope = grantedScope;
  const fhirServerId = String(server.fhir_server_id);
  let payload: Json;
  try {
    payload = await postToken(server, tokenEndpoint, form);
  } catch (exc) {
    await query(
      `UPDATE admin.fhir_server_oauth_tokens SET access_token_ciphertext = NULL, refresh_token_ciphertext = NULL,
         access_token_expires_at = NULL, refresh_token_expires_at = NULL, updated_at = NOW() WHERE fhir_server_id = $1::uuid`,
      [fhirServerId],
    );
    popCcTokenCache(fhirServerId);
    throw new OAuthRefreshFailedError(`Refresh token rejected (${String((exc as Error).message)}) — re-authorize the server`);
  }
  await storeTokens(fhirServerId, String(tokenRow.admin_user), payload, {
    secretKey,
    fallbackScope: grantedScope,
    keepRefreshIfAbsent: true,
    currentRefresh: refreshToken,
  });
  return String(payload.access_token);
}

function needsRefresh(tokenRow: Json): boolean {
  const n = Date.now();
  const accessExp = tokenRow.access_token_expires_at ? new Date(tokenRow.access_token_expires_at as string).getTime() : null;
  if (accessExp === null || accessExp <= n + ACCESS_REFRESH_SKEW_SECONDS * 1000) return true;
  const refreshExp = tokenRow.refresh_token_expires_at ? new Date(tokenRow.refresh_token_expires_at as string).getTime() : null;
  if (refreshExp !== null && refreshExp <= n + REFRESH_TOKEN_RENEW_SKEW_SECONDS * 1000) return true;
  return false;
}

export async function getValidUserAccessToken(server: Json, secretKey: string): Promise<string> {
  const fhirServerId = String(server.fhir_server_id);
  let row = await loadActiveTokenRow(fhirServerId, secretKey);
  if (!row) throw new OAuthNotAuthorizedError("Server not authorized — click Authorize in the admin console to complete the OAuth2 login");
  if (!needsRefresh(row)) return String(row.access_token);
  return runTokenSingleFlight(`ac:${fhirServerId}`, async () => {
    row = await loadActiveTokenRow(fhirServerId, secretKey);
    if (!row) throw new OAuthNotAuthorizedError("Server not authorized — click Authorize in the admin console");
    if (!needsRefresh(row)) return String(row.access_token);
    return refreshAccessToken(server, row, secretKey);
  });
}

export async function refreshTokenNow(identifier: string, secretKey: string): Promise<Json> {
  const row = await fetchServerRow(identifier, secretKey);
  if (!row) throw new OAuthError("FHIR server not found");
  const server = serverPrivate(row);
  const fhirServerId = String(server.fhir_server_id);
  await runTokenSingleFlight(`ac:${fhirServerId}`, async () => {
    const tokenRow = await loadActiveTokenRow(fhirServerId, secretKey);
    if (!tokenRow) throw new OAuthNotAuthorizedError("Server not authorized — nothing to refresh");
    if (!tokenRow.refresh_token) throw new OAuthError("No refresh token is stored for this server");
    await refreshAccessToken(server, tokenRow, secretKey);
  });
  return { ok: true, oauth_status: await getOauthStatus(fhirServerId) };
}

export async function clearOauthState(identifier: string): Promise<Json> {
  const row = await fetchServerRow(identifier, null);
  if (!row) throw new OAuthError("FHIR server not found");
  const fhirServerId = String(row.fhir_server_id);
  await query("DELETE FROM admin.fhir_server_oauth_tokens WHERE fhir_server_id = $1::uuid", [fhirServerId]);
  popCcTokenCache(fhirServerId);
  return { cleared: true, fhir_server_id: fhirServerId };
}

/** Mirror `_status_from_row`. */
function statusFromRow(row: Json | null): Json {
  const n = Date.now();
  const hasAccess = row ? Boolean(row.has_access) : false;
  const hasRefresh = row ? Boolean(row.has_refresh) : false;
  const accessExp = row && row.access_token_expires_at ? new Date(row.access_token_expires_at as string).getTime() : null;
  const refreshExp = row && row.refresh_token_expires_at ? new Date(row.refresh_token_expires_at as string).getTime() : null;
  const pending = Boolean(row && row.state_nonce);
  const pendingCreated = row && row.pending_created_at ? new Date(row.pending_created_at as string).getTime() : null;
  const pendingFresh = pending && pendingCreated !== null && pendingCreated >= n - PENDING_STATE_TTL_SECONDS * 1000;

  let status: string;
  if (hasAccess) {
    const refreshable = hasRefresh && (refreshExp === null || refreshExp > n);
    status = refreshable || accessExp === null || accessExp > n ? "authorized" : "expired";
  } else if (pendingFresh) {
    status = "pending";
  } else {
    status = "not_authorized";
  }
  const accessIso = row ? (row.access_iso as string | null) : null;
  const refreshIso = row ? (row.refresh_iso as string | null) : null;
  return {
    status,
    access_expires_at: accessIso ? pyIso(accessIso) : null,
    refresh_expires_at: refreshIso ? pyIso(refreshIso) : null,
    has_refresh: hasRefresh,
    scope: (row ? row.granted_scope : "") || "",
  };
}

export async function getOauthStatus(serverId: string): Promise<Json> {
  const r = await query<Json>(
    `SELECT state_nonce, pending_created_at,
            (access_token_ciphertext IS NOT NULL) AS has_access,
            (refresh_token_ciphertext IS NOT NULL) AS has_refresh,
            token_type, granted_scope,
            access_token_expires_at, refresh_token_expires_at,
            ${tsIsoExpr("access_token_expires_at")} AS access_iso,
            ${tsIsoExpr("refresh_token_expires_at")} AS refresh_iso
     FROM admin.fhir_server_oauth_tokens
     WHERE fhir_server_id = $1::uuid
     ORDER BY obtained_at DESC NULLS LAST LIMIT 1`,
    [serverId],
  );
  return statusFromRow(r.rows[0] ?? null);
}

/** Mirror `attach_oauth_status`. */
export async function attachOauthStatus(servers: Json[]): Promise<Json[]> {
  for (const server of servers) {
    if (OAUTH2_AUTH_TYPES.has(server.auth_type as string)) {
      try {
        server.oauth_status = await getOauthStatus(String(server.fhir_server_id));
      } catch {
        server.oauth_status = { status: "not_authorized", access_expires_at: null, refresh_expires_at: null, has_refresh: false, scope: "" };
      }
    }
  }
  return servers;
}

/** Mirror `sweep_expiring_tokens` (used by the worker chunk). */
export async function sweepExpiringTokens(secretKey: string): Promise<number> {
  const n = now();
  const r = await query<Json>(
    `SELECT fhir_server_id FROM admin.fhir_server_oauth_tokens
     WHERE access_token_ciphertext IS NOT NULL
       AND (access_token_expires_at IS NULL OR access_token_expires_at <= $1
            OR (refresh_token_expires_at IS NOT NULL AND refresh_token_expires_at <= $2))`,
    [new Date(n.getTime() + ACCESS_REFRESH_SKEW_SECONDS * 1000), new Date(n.getTime() + REFRESH_TOKEN_RENEW_SKEW_SECONDS * 1000)],
  );
  let refreshed = 0;
  for (const row of r.rows) {
    const fhirServerId = String(row.fhir_server_id);
    try {
      const serverRow = await fetchServerRow(fhirServerId, secretKey);
      if (!serverRow) continue;
      const server = serverPrivate(serverRow);
      if (!OAUTH2_AUTH_TYPES.has(server.auth_type as string)) continue;
      await getValidUserAccessToken(server, secretKey);
      refreshed += 1;
    } catch {
      continue;
    }
  }
  return refreshed;
}
