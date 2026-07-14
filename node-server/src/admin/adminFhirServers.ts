/**
 * admin/adminFhirServers.ts — admin REST data layer for the external FHIR
 * server registry (sub-step A: CRUD + pgcrypto + JWKS key material).
 *
 * Faithful port of the admin-facing surface of `src/fhir_server_service.py`:
 * `fhir_server_secret_key`, the private_key_jwt key helpers (`generate_keypair`
 * / `jwk_thumbprint` / `derive_public_jwk` / `generate_client_key` /
 * `_resolve_public_jwk`), the payload validator (`_validate_server_payload` and
 * friends), `_server_private`, `_admin_audit`, and the CRUD functions
 * (`_fetch_server_row` / `list_fhir_servers` / `get_fhir_server` /
 * `export_fhir_servers` / `get_fhir_server_jwks` / `create_fhir_server` /
 * `update_fhir_server` / `delete_fhir_server` / `set_default_fhir_server`).
 *
 * Secrets (`client_secret`, `client_private_key`) are encrypted at rest with
 * pgcrypto `pgp_sym_encrypt(<plain>, <key>)` and only ever decrypted server-side
 * via `pgp_sym_decrypt`. The symmetric key is `fhir_server_secret_key()`.
 *
 * Discovery / connection-test / OAuth flows are NOT in this file (sub-steps B/C).
 * Schema migration (`ensure_fhir_server_schema`) is omitted — the table already
 * exists via db/schema.sql.
 */

import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import { URL as NodeURL } from "node:url";
import { query, withTransaction } from "../db.js";
import { serverPublic } from "../fhirServerService.js";

type Json = Record<string, unknown>;

/** Raised on payload validation failures (mirrors Python ValueError → HTTP 400). */
export class FhirServerValueError extends Error {}

// ── constants (mirror fhir_server_service.py) ────────────────────────────────
const AUTH_NONE = "none";
const AUTH_OAUTH2_CC = "oauth2_client_credentials";
const AUTH_OAUTH2_AC = "oauth2_authorization_code";

const AUTH_PROFILE_NONE = "none";
const AUTH_PROFILE_IUA = "iua";
const AUTH_PROFILE_SMART = "smart";
const AUTH_PROFILES = new Set([AUTH_PROFILE_NONE, AUTH_PROFILE_IUA, AUTH_PROFILE_SMART]);

const FHIR_ENVIRONMENTS = new Set(["development", "testing", "staging", "production", "custom"]);

const TOKEN_AUTH_BASIC = "client_secret_basic";
const TOKEN_AUTH_POST = "client_secret_post";
const TOKEN_AUTH_SECRET_JWT = "client_secret_jwt";
const TOKEN_AUTH_PRIVATE_KEY_JWT = "private_key_jwt";
const TOKEN_AUTH_METHODS = new Set([TOKEN_AUTH_BASIC, TOKEN_AUTH_POST, TOKEN_AUTH_SECRET_JWT, TOKEN_AUTH_PRIVATE_KEY_JWT]);
const TOKEN_AUTH_JWT_METHODS = new Set([TOKEN_AUTH_SECRET_JWT, TOKEN_AUTH_PRIVATE_KEY_JWT]);

const HMAC_SIGNING_ALGS = new Set(["HS256", "HS384", "HS512"]);
const ASYMMETRIC_SIGNING_ALGS = new Set(["RS256", "RS384", "RS512", "ES256", "ES384", "ES512", "PS256", "PS384", "PS512"]);
const DEFAULT_SECRET_JWT_ALG = "HS384";
const DEFAULT_PRIVATE_KEY_JWT_ALG = "RS384";

const READ_OPERATIONS = new Set(["metadata", "read", "search"]);
const WRITE_OPERATIONS = new Set(["create", "update", "patch", "delete"]);
const ALLOWED_OPERATIONS = new Set([...READ_OPERATIONS, ...WRITE_OPERATIONS]);
const DEFAULT_OPERATIONS = ["metadata", "read", "search"];
const DEFAULT_RESOURCE_TYPES = [
  "Patient", "Observation", "Condition", "Medication", "MedicationRequest",
  "MedicationAdministration", "AllergyIntolerance", "DiagnosticReport",
  "DocumentReference", "Encounter", "Practitioner", "Organization",
];
const IUA_JWT_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:jwt";

const TOKEN_STRATEGY_DEFAULTS = new Set(["fresh", "cached"]);

const SERVER_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{1,63}$/;
const RESOURCE_TYPE_RE = /^[A-Z][A-Za-z0-9]{0,63}$/;

const RSA_ALGS = new Set(["RS256", "RS384", "RS512", "PS256", "PS384", "PS512"]);
const EC_CURVES: Record<string, string> = { ES256: "P-256", ES384: "P-384", ES512: "P-521" };
const DEFAULT_RSA_KEY_BITS = 2048;

// ── small helpers (mirror the Python privates) ───────────────────────────────
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
function cleanText(value: unknown): string {
  return String(value ?? "").trim();
}
function boolValue(value: unknown, def = false): boolean {
  if (value === null || value === undefined) return def;
  if (typeof value === "boolean") return value;
  return new Set(["1", "true", "yes", "on"]).has(String(value).trim().toLowerCase());
}
function parseHeaders(value: unknown, allowAuthorization = false): Record<string, string> {
  const raw = jsonValue(value, {});
  if (raw === "" || raw === null || raw === undefined) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new FhirServerValueError("headers must be a JSON object");
  const headers: Record<string, string> = {};
  for (const [key, val] of Object.entries(raw as Json)) {
    const k = String(key).trim();
    if (!k) continue;
    if (k.toLowerCase() === "authorization" && !allowAuthorization) {
      throw new FhirServerValueError("custom headers cannot set Authorization");
    }
    headers[k] = String(val);
  }
  return headers;
}
function parseStrList(value: unknown, def: string[]): string[] {
  let raw = jsonValue(value, null);
  if (raw === null || raw === undefined || raw === "") return [...def];
  if (typeof raw === "string") raw = raw.split(",").map((p) => p.trim()).filter(Boolean);
  if (!Array.isArray(raw)) throw new FhirServerValueError("value must be an array of strings");
  const result: string[] = [];
  for (const item of raw) {
    const text = String(item).trim();
    if (text && !result.includes(text)) result.push(text);
  }
  return result;
}

// ── pgcrypto key + private_key_jwt material ──────────────────────────────────

/** Mirror `fhir_server_secret_key`: env override else the supplied fallback. */
export function fhirServerSecretKey(fallback = ""): string {
  return (process.env.FHIR_SERVER_SECRET_KEY ?? "").trim() || fallback;
}

/** Mirror `generate_keypair`: PKCS#8 PEM private key for the signing alg. */
function generateKeypair(alg: string, rsaBits = DEFAULT_RSA_KEY_BITS): string {
  const a = (alg || "").toUpperCase();
  let privateKey: crypto.KeyObject;
  if (RSA_ALGS.has(a)) {
    ({ privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: rsaBits }));
  } else if (a in EC_CURVES) {
    ({ privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: EC_CURVES[a] }));
  } else {
    throw new FhirServerValueError(
      "Unsupported algorithm for key generation: must be one of " + [...ASYMMETRIC_SIGNING_ALGS].sort().join(", "),
    );
  }
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

/** Mirror `jwk_thumbprint`: RFC 7638 base64url SHA-256 of the canonical members. */
function jwkThumbprint(jwk: Json): string {
  const kty = jwk.kty;
  let members: string[];
  if (kty === "RSA") members = ["e", "kty", "n"];
  else if (kty === "EC") members = ["crv", "kty", "x", "y"];
  else if (kty === "oct") members = ["k", "kty"];
  else throw new FhirServerValueError(`Cannot compute thumbprint for kty=${JSON.stringify(kty)}`);
  // JSON.stringify with sorted keys == Python json.dumps(sort_keys=True, separators=(",", ":")).
  const canonical: Record<string, unknown> = {};
  for (const name of [...members].sort()) canonical[name] = jwk[name];
  const data = JSON.stringify(canonical);
  return crypto.createHash("sha256").update(data, "utf-8").digest("base64url");
}

/** Mirror `derive_public_jwk`: `(public_jwk, kid)` for a PEM private key + alg. */
function derivePublicJwk(privatePem: string, alg: string, kid?: string | null): [Json, string] {
  const a = (alg || "").toUpperCase();
  const pub = crypto.createPublicKey(privatePem);
  const jwk = pub.export({ format: "jwk" }) as Json;
  if (!RSA_ALGS.has(a) && !(a in EC_CURVES)) {
    throw new FhirServerValueError(`Unsupported algorithm for JWK export: ${JSON.stringify(a)}`);
  }
  delete jwk.key_ops;
  jwk.use = "sig";
  jwk.alg = a;
  jwk.kid = kid || jwkThumbprint(jwk);
  return [jwk, jwk.kid as string];
}

/** Mirror `generate_client_key`: keypair material for the admin UI. */
export function generateClientKey(alg: string): Json {
  const a = (alg || DEFAULT_PRIVATE_KEY_JWT_ALG).toUpperCase();
  if (!ASYMMETRIC_SIGNING_ALGS.has(a)) {
    throw new FhirServerValueError("alg must be one of: " + [...ASYMMETRIC_SIGNING_ALGS].sort().join(", "));
  }
  const privatePem = generateKeypair(a);
  const [publicJwk, kid] = derivePublicJwk(privatePem, a);
  return { private_key_pem: privatePem, public_jwk: publicJwk, jwks: { keys: [publicJwk] }, kid, alg: a };
}

/** Mirror `_public_jwks_from_json`: wrap a stored JWK string into `{keys:[...]}`. */
function publicJwksFromJson(publicJwkJson: string | null | undefined): Json | null {
  if (!publicJwkJson) return null;
  let jwk: unknown;
  try {
    jwk = JSON.parse(publicJwkJson);
  } catch {
    return null;
  }
  if (typeof jwk !== "object" || jwk === null || Array.isArray(jwk) || Object.keys(jwk).length === 0) return null;
  return { keys: [jwk] };
}

/** Mirror `_coerce_uuid`: canonical lowercase UUID string or null. */
function coerceUuid(value: unknown): string | null {
  const text = cleanText(value);
  if (!text) return null;
  // Accept the standard 8-4-4-4-12 hex form (with optional urn:/braces), as
  // Python's uuid.UUID() does for the formats the UI emits.
  const hex = text.toLowerCase().replace(/^urn:uuid:/, "").replace(/[{}]/g, "").replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/.test(hex)) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Mirror `_resolve_public_jwk`: stored public-JWK JSON + effective kid. */
function resolvePublicJwk(
  tokenAuthMethod: string,
  privateKey: string | null,
  alg: string | null,
  jwtKid: string | null,
): [string | null, string | null] {
  if (tokenAuthMethod !== TOKEN_AUTH_PRIVATE_KEY_JWT || !privateKey) {
    return [null, jwtKid || null];
  }
  const [jwk, kid] = derivePublicJwk(privateKey, alg || DEFAULT_PRIVATE_KEY_JWT_ALG, jwtKid || null);
  return [JSON.stringify(jwk), kid];
}

// ── URL validation ───────────────────────────────────────────────────────────
function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}
function validateBaseUrl(value: string): string {
  const p = parseUrl(value);
  if (!p || (p.protocol !== "http:" && p.protocol !== "https:") || !p.host) {
    throw new FhirServerValueError("base_url must be an absolute HTTP(S) URL");
  }
  if (p.search || p.hash) throw new FhirServerValueError("base_url cannot include query string or fragment");
  return value.replace(/\/+$/, "");
}
function validateOptionalUrl(value: string, label: string): string {
  if (!value) return "";
  const p = parseUrl(value);
  if (!p || (p.protocol !== "http:" && p.protocol !== "https:") || !p.host) {
    throw new FhirServerValueError(`${label} must be an absolute HTTP(S) URL`);
  }
  if (p.hash) throw new FhirServerValueError(`${label} cannot include a fragment`);
  return value;
}
function validateResourceType(resourceType: string): string {
  const value = cleanText(resourceType);
  if (!RESOURCE_TYPE_RE.test(value)) throw new FhirServerValueError("resource_type must be a valid FHIR ResourceType");
  return value;
}

/** int()-like coercion mirroring `int(merged.get("timeout_seconds") or 30)`. */
function toIntStrict(value: unknown): number {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") {
    if (!Number.isInteger(value)) throw new FhirServerValueError("timeout_seconds must be an integer");
    return value;
  }
  const s = String(value).trim();
  if (!/^[+-]?\d+$/.test(s)) throw new FhirServerValueError("timeout_seconds must be an integer");
  return parseInt(s, 10);
}

/**
 * Faithful port of `_validate_server_payload`. Merges `existing` (on update)
 * with non-null `payload` fields, validates, and returns the normalised record.
 */
function validateServerPayload(payload: Json, existing: Json | null = null): Json {
  const merged: Json = { ...(existing ?? {}) };
  for (const [k, v] of Object.entries(payload)) if (v !== null && v !== undefined) merged[k] = v;

  const serverKey = cleanText(merged.server_key).toLowerCase();
  if (!SERVER_KEY_RE.test(serverKey)) {
    throw new FhirServerValueError("server_key must be 2-64 chars: letters, numbers, dot, underscore, or hyphen");
  }
  const name = cleanText(merged.name);
  if (!name) throw new FhirServerValueError("name is required");
  const baseUrl = validateBaseUrl(cleanText(merged.base_url));

  const authType = cleanText(merged.auth_type || AUTH_NONE);
  if (![AUTH_NONE, AUTH_OAUTH2_CC, AUTH_OAUTH2_AC].includes(authType)) {
    throw new FhirServerValueError("auth_type must be none, oauth2_client_credentials, or oauth2_authorization_code");
  }

  let allowedOperations = parseStrList(merged.allowed_operations, DEFAULT_OPERATIONS);
  const invalidOps = [...new Set(allowedOperations.filter((o) => !ALLOWED_OPERATIONS.has(o)))].sort();
  if (invalidOps.length) throw new FhirServerValueError(`Unsupported operations: ${invalidOps.join(", ")}`);
  if (allowedOperations.length === 0) allowedOperations = [...DEFAULT_OPERATIONS];

  const allowedResourceTypes = parseStrList(merged.allowed_resource_types, DEFAULT_RESOURCE_TYPES);
  for (const rt of allowedResourceTypes) validateResourceType(rt);

  const rawProfile = merged.auth_profile;
  let authProfile: string;
  if (rawProfile === null || rawProfile === undefined || rawProfile === "") {
    authProfile = boolValue(merged.enable_iua, false) ? AUTH_PROFILE_IUA : AUTH_PROFILE_NONE;
  } else {
    authProfile = cleanText(rawProfile).toLowerCase();
  }
  if (!AUTH_PROFILES.has(authProfile)) throw new FhirServerValueError("auth_profile must be one of: none, iua, smart");

  let authServerUrl = validateOptionalUrl(cleanText(merged.auth_server_url), "auth_server_url");
  let metadataUrl = validateOptionalUrl(cleanText(merged.metadata_url), "metadata_url");
  let tokenEndpoint = validateOptionalUrl(cleanText(merged.token_endpoint), "token_endpoint");
  let authorizationEndpoint = validateOptionalUrl(cleanText(merged.authorization_endpoint), "authorization_endpoint");

  let clientId = cleanText(merged.client_id);
  const clientSecret = cleanText(payload.client_secret);
  const secretConfigured = Boolean(merged.client_secret_configured);
  let clientPrivateKey = cleanText(payload.client_private_key);
  const privateKeyConfigured = Boolean(merged.client_private_key_configured);

  let tokenAuthMethod = cleanText(merged.token_auth_method || TOKEN_AUTH_BASIC).toLowerCase();
  if (!TOKEN_AUTH_METHODS.has(tokenAuthMethod)) {
    throw new FhirServerValueError("token_auth_method must be one of: " + [...TOKEN_AUTH_METHODS].sort().join(", "));
  }
  let jwtSigningAlg = cleanText(merged.jwt_signing_alg).toUpperCase();
  let jwtKid = cleanText(merged.jwt_kid);

  if (authType === AUTH_OAUTH2_CC && authProfile === AUTH_PROFILE_SMART && !TOKEN_AUTH_JWT_METHODS.has(tokenAuthMethod)) {
    tokenAuthMethod = TOKEN_AUTH_PRIVATE_KEY_JWT;
  }

  if (authType === AUTH_OAUTH2_CC) {
    if (!clientId) throw new FhirServerValueError("client_id is required for OAuth2 Client Credentials");
    if (!(tokenEndpoint || metadataUrl || authServerUrl)) {
      throw new FhirServerValueError("Provide token_endpoint, metadata_url, or auth_server_url for OAuth2");
    }
    if (tokenAuthMethod === TOKEN_AUTH_PRIVATE_KEY_JWT) {
      if (!clientPrivateKey && !privateKeyConfigured) {
        throw new FhirServerValueError("client_private_key (PEM) is required for private_key_jwt");
      }
      if (!jwtSigningAlg) jwtSigningAlg = DEFAULT_PRIVATE_KEY_JWT_ALG;
      if (!ASYMMETRIC_SIGNING_ALGS.has(jwtSigningAlg)) {
        throw new FhirServerValueError(
          "jwt_signing_alg for private_key_jwt must be one of: " + [...ASYMMETRIC_SIGNING_ALGS].sort().join(", "),
        );
      }
    } else {
      if (!clientSecret && !secretConfigured) {
        throw new FhirServerValueError(`client_secret is required for ${tokenAuthMethod}`);
      }
      clientPrivateKey = "";
      if (tokenAuthMethod === TOKEN_AUTH_SECRET_JWT) {
        if (!jwtSigningAlg) jwtSigningAlg = DEFAULT_SECRET_JWT_ALG;
        if (!HMAC_SIGNING_ALGS.has(jwtSigningAlg)) {
          throw new FhirServerValueError(
            "jwt_signing_alg for client_secret_jwt must be one of: " + [...HMAC_SIGNING_ALGS].sort().join(", "),
          );
        }
      } else {
        jwtSigningAlg = "";
        jwtKid = "";
      }
    }
  } else if (authType === AUTH_OAUTH2_AC) {
    if (!clientId) throw new FhirServerValueError("client_id is required for OAuth2 Authorization Code");
    if (!(authorizationEndpoint || metadataUrl || authServerUrl)) {
      throw new FhirServerValueError(
        "Provide authorization_endpoint, metadata_url, or auth_server_url for OAuth2 Authorization Code",
      );
    }
    if (!(tokenEndpoint || metadataUrl || authServerUrl)) {
      throw new FhirServerValueError("Provide token_endpoint, metadata_url, or auth_server_url for OAuth2");
    }
    tokenAuthMethod = TOKEN_AUTH_BASIC;
    clientPrivateKey = "";
    jwtSigningAlg = "";
    jwtKid = "";
    if (authProfile === AUTH_PROFILE_IUA && !(clientSecret || secretConfigured)) {
      throw new FhirServerValueError("client_secret is required for the IUA profile");
    }
  } else {
    authProfile = AUTH_PROFILE_NONE;
    authServerUrl = "";
    metadataUrl = "";
    authorizationEndpoint = "";
    tokenEndpoint = "";
    clientId = "";
    tokenAuthMethod = TOKEN_AUTH_BASIC;
    clientPrivateKey = "";
    jwtSigningAlg = "";
    jwtKid = "";
  }

  let requestedTokenType = cleanText(merged.requested_token_type);
  if (authType === AUTH_OAUTH2_CC && authProfile === AUTH_PROFILE_IUA && !requestedTokenType) {
    requestedTokenType = IUA_JWT_TOKEN_TYPE;
  }
  if (authProfile === AUTH_PROFILE_SMART) requestedTokenType = "";

  let timeoutSeconds = merged.timeout_seconds ? toIntStrict(merged.timeout_seconds) : 30;
  timeoutSeconds = Math.max(1, Math.min(timeoutSeconds, 120));
  const enabled = boolValue(merged.enabled, true);
  const isDefault = boolValue(merged.is_default, false);
  if (isDefault && !enabled) throw new FhirServerValueError("default FHIR server must be enabled");

  const testPath = cleanText(merged.test_path);
  if (testPath && testPath.includes("://")) {
    throw new FhirServerValueError("test_path must be a path relative to the base URL, not an absolute URL");
  }

  const defaultTokenStrategy = cleanText(merged.default_token_strategy).toLowerCase();
  if (defaultTokenStrategy && !TOKEN_STRATEGY_DEFAULTS.has(defaultTokenStrategy)) {
    throw new FhirServerValueError("default_token_strategy must be one of: " + [...TOKEN_STRATEGY_DEFAULTS].sort().join(", "));
  }

  const environment = cleanText(merged.environment).toLowerCase();
  if (environment && !FHIR_ENVIRONMENTS.has(environment)) {
    throw new FhirServerValueError("environment must be one of: " + [...FHIR_ENVIRONMENTS].sort().join(", "));
  }
  const displayName = cleanText(merged.display_name);
  const tags = parseStrList(merged.tags, []);

  return {
    environment: environment || null,
    display_name: displayName || null,
    tags,
    server_key: serverKey,
    name,
    description: cleanText(merged.description),
    base_url: baseUrl,
    test_path: testPath || null,
    default_token_strategy: defaultTokenStrategy || null,
    enabled,
    is_default: isDefault,
    auth_type: authType,
    auth_profile: authProfile,
    auth_server_url: authServerUrl || null,
    metadata_url: metadataUrl || null,
    authorization_endpoint: authorizationEndpoint || null,
    token_endpoint: tokenEndpoint || null,
    use_metadata: boolValue(merged.use_metadata, true),
    client_id: clientId || null,
    client_secret: clientSecret || null,
    token_auth_method: tokenAuthMethod,
    client_private_key: clientPrivateKey || null,
    jwt_signing_alg: jwtSigningAlg || null,
    jwt_kid: jwtKid || null,
    scope: cleanText(merged.scope) || null,
    resource: cleanText(merged.resource) || null,
    requested_token_type: requestedTokenType || null,
    metadata_headers_json: parseHeaders(merged.metadata_headers_json),
    token_headers_json: parseHeaders(merged.token_headers_json),
    resource_headers_json: parseHeaders(merged.resource_headers_json),
    verify_tls: boolValue(merged.verify_tls, true),
    timeout_seconds: timeoutSeconds,
    allowed_resource_types: allowedResourceTypes,
    allowed_operations: allowedOperations,
  };
}

/** Mirror `_server_private`: public view + decrypted secrets. */
function serverPrivate(row: Json): Json {
  const data = serverPublic(row);
  data.client_secret = row.client_secret || "";
  data.client_private_key = row.client_private_key || "";
  return data;
}

/** Mirror `_admin_audit`: redacted audit row (secrets never persisted). */
async function adminAudit(
  client: { query: (sql: string, params: unknown[]) => Promise<unknown> },
  opts: { adminUser: string; action: string; targetId: string; payload: Json },
): Promise<void> {
  const redacted = { ...opts.payload };
  delete redacted.client_secret;
  delete redacted.client_private_key;
  await client.query(
    `INSERT INTO admin.admin_audit_log (admin_user, action, target_type, target_id, payload_json)
     VALUES ($1, $2, 'fhir_server', $3, $4::jsonb)`,
    [opts.adminUser, opts.action, opts.targetId, JSON.stringify(redacted)],
  );
}

const PUBLIC_SELECT = `*,
  (client_secret_ciphertext IS NOT NULL) AS client_secret_configured,
  (client_private_key_ciphertext IS NOT NULL) AS client_private_key_configured`;

function decryptSelect(param: string): string {
  return `${PUBLIC_SELECT},
    CASE WHEN client_secret_ciphertext IS NULL THEN NULL
         ELSE pgp_sym_decrypt(client_secret_ciphertext, ${param}) END AS client_secret,
    CASE WHEN client_private_key_ciphertext IS NULL THEN NULL
         ELSE pgp_sym_decrypt(client_private_key_ciphertext, ${param}) END AS client_private_key`;
}

/** Mirror `_fetch_server_row`. Decrypts secrets when secretKey is provided. */
async function fetchServerRow(
  identifier: string,
  secretKey: string | null,
  includeDisabled = true,
): Promise<Json | null> {
  const disabledSql = includeDisabled ? "" : "AND enabled = TRUE";
  if (identifier.trim().toLowerCase() === "default") {
    const sql = secretKey
      ? `SELECT ${decryptSelect("$1")} FROM admin.fhir_servers WHERE is_default = TRUE ${disabledSql} LIMIT 1`
      : `SELECT ${PUBLIC_SELECT} FROM admin.fhir_servers WHERE is_default = TRUE ${disabledSql} LIMIT 1`;
    const r = await query<Json>(sql, secretKey ? [secretKey] : []);
    return r.rows[0] ?? null;
  }
  const where = `(fhir_server_id::text = $1 OR server_key = lower($1) OR lower(name) = lower($1)) ${disabledSql}`;
  const sql = secretKey
    ? `SELECT ${decryptSelect("$2")} FROM admin.fhir_servers WHERE ${where}`
    : `SELECT ${PUBLIC_SELECT} FROM admin.fhir_servers WHERE ${where}`;
  const r = await query<Json>(sql, secretKey ? [identifier, secretKey] : [identifier]);
  return r.rows[0] ?? null;
}

/** Mirror `list_fhir_servers` (admin variant). */
export async function listFhirServers(includeDisabled = false): Promise<Json[]> {
  const where = includeDisabled ? "" : "WHERE enabled = TRUE";
  const r = await query<Json>(
    `SELECT ${PUBLIC_SELECT} FROM admin.fhir_servers ${where} ORDER BY is_default DESC, server_key ASC`,
  );
  return r.rows.map((row) => serverPublic(row));
}

/** Mirror `get_fhir_server`. */
export async function getFhirServer(identifier: string): Promise<Json | null> {
  const row = await fetchServerRow(identifier, null);
  return row ? serverPublic(row) : null;
}

/** Mirror `export_fhir_servers` (decrypts secrets). */
export async function exportFhirServers(secretKey: string, includeDisabled = true): Promise<Json[]> {
  const where = includeDisabled ? "" : "WHERE enabled = TRUE";
  const r = await query<Json>(
    `SELECT ${decryptSelect("$1")} FROM admin.fhir_servers ${where} ORDER BY is_default DESC, server_key ASC`,
    [secretKey],
  );
  return r.rows.map((row) => serverPrivate(row));
}

/** Mirror `get_fhir_server_jwks`. */
export async function getFhirServerJwks(serverId: string): Promise<Json | null> {
  const r = await query<Json>(
    "SELECT client_public_jwk_json, token_auth_method FROM admin.fhir_servers WHERE fhir_server_id::text = $1",
    [serverId],
  );
  const row = r.rows[0];
  if (!row) return null;
  if ((row.token_auth_method || "") !== TOKEN_AUTH_PRIVATE_KEY_JWT) return null;
  return publicJwksFromJson(row.client_public_jwk_json as string | null);
}

/** Mirror `create_fhir_server`. */
export async function createFhirServer(
  payload: Json,
  opts: { adminUser: string; secretKey: string },
): Promise<Json> {
  const data = validateServerPayload(payload);
  const [publicJwkJson, kid] = resolvePublicJwk(
    data.token_auth_method as string,
    data.client_private_key as string | null,
    data.jwt_signing_alg as string | null,
    data.jwt_kid as string | null,
  );
  data.jwt_kid = kid;
  let importId = coerceUuid(payload.fhir_server_id);

  return withTransaction(async (client) => {
    if (importId !== null) {
      const clash = await client.query("SELECT 1 FROM admin.fhir_servers WHERE fhir_server_id = $1::uuid", [importId]);
      if (clash.rows.length > 0) importId = null;
    }
    if (data.is_default) await client.query("UPDATE admin.fhir_servers SET is_default = FALSE");
    const res = await client.query(
      `INSERT INTO admin.fhir_servers (
         fhir_server_id,
         server_key, name, description, base_url, enabled, is_default,
         auth_type, auth_profile, auth_server_url, metadata_url,
         authorization_endpoint,
         token_endpoint, use_metadata, client_id, client_secret_ciphertext,
         token_auth_method, client_private_key_ciphertext,
         jwt_signing_alg, jwt_kid, client_public_jwk_json,
         scope, resource, requested_token_type, token_headers_json,
         resource_headers_json, verify_tls, timeout_seconds,
         allowed_resource_types, allowed_operations, created_by, test_path,
         default_token_strategy, metadata_headers_json,
         environment, display_name, tags
       )
       VALUES (
         COALESCE($34::uuid, gen_random_uuid()),
         $1, $2, $3, $4, $5, $6,
         $7, $8, $9, $10,
         $35,
         $11, $12, $13,
         CASE WHEN $14::text IS NULL OR $14 = '' THEN NULL ELSE pgp_sym_encrypt($14, $15) END,
         $16,
         CASE WHEN $17::text IS NULL OR $17 = '' THEN NULL ELSE pgp_sym_encrypt($17, $15) END,
         $18, $19, $30,
         $20, $21, $22, $23::jsonb,
         $24::jsonb, $25, $26,
         $27::jsonb, $28::jsonb, $29, $31, $32, $33::jsonb,
         $36, $37, $38::jsonb
       )
       RETURNING *, (client_secret_ciphertext IS NOT NULL) AS client_secret_configured`,
      [
        data.server_key, data.name, data.description, data.base_url, data.enabled, data.is_default,
        data.auth_type, data.auth_profile, data.auth_server_url, data.metadata_url,
        data.token_endpoint, data.use_metadata, data.client_id, data.client_secret,
        opts.secretKey, data.token_auth_method, data.client_private_key, data.jwt_signing_alg,
        data.jwt_kid, data.scope, data.resource, data.requested_token_type,
        JSON.stringify(data.token_headers_json), JSON.stringify(data.resource_headers_json),
        data.verify_tls, data.timeout_seconds,
        JSON.stringify(data.allowed_resource_types), JSON.stringify(data.allowed_operations),
        opts.adminUser, publicJwkJson, data.test_path, data.default_token_strategy,
        JSON.stringify(data.metadata_headers_json), importId, data.authorization_endpoint,
        data.environment, data.display_name, JSON.stringify(data.tags),
      ],
    );
    const row = res.rows[0] as Json;
    await adminAudit(client, {
      adminUser: opts.adminUser,
      action: "create_fhir_server",
      targetId: String(row.fhir_server_id),
      payload: data,
    });
    return serverPublic(row);
  });
}

/** Mirror `update_fhir_server`. */
export async function updateFhirServer(
  identifier: string,
  payload: Json,
  opts: { adminUser: string; secretKey: string },
): Promise<Json> {
  const existingRow = await fetchServerRow(identifier, opts.secretKey);
  if (!existingRow) throw new FhirServerValueError("FHIR server not found");
  const existing = serverPublic(existingRow);
  const data = validateServerPayload(payload, existing);
  const newSecret = cleanText(payload.client_secret);
  const keepSecret = !newSecret && data.auth_type === AUTH_OAUTH2_CC;
  const newPrivateKey = cleanText(payload.client_private_key);
  const keepPrivateKey =
    !newPrivateKey && data.auth_type === AUTH_OAUTH2_CC && data.token_auth_method === TOKEN_AUTH_PRIVATE_KEY_JWT;
  const effectivePrivateKey = newPrivateKey || (keepPrivateKey ? String(existingRow.client_private_key || "") : "");
  const [publicJwkJson, kid] = resolvePublicJwk(
    data.token_auth_method as string,
    effectivePrivateKey,
    data.jwt_signing_alg as string | null,
    data.jwt_kid as string | null,
  );
  data.jwt_kid = kid;

  return withTransaction(async (client) => {
    if (data.is_default) {
      await client.query("UPDATE admin.fhir_servers SET is_default = FALSE WHERE fhir_server_id <> $1", [
        existing.fhir_server_id,
      ]);
    }
    const res = await client.query(
      `UPDATE admin.fhir_servers SET
         server_key = $2, name = $3, description = $4, base_url = $5, enabled = $6, is_default = $7,
         auth_type = $8, auth_profile = $9, auth_server_url = $10, metadata_url = $11,
         authorization_endpoint = $36, token_endpoint = $12, use_metadata = $13, client_id = $14,
         client_secret_ciphertext = CASE
             WHEN $15::boolean THEN client_secret_ciphertext
             WHEN $16::text IS NULL OR $16 = '' THEN NULL
             ELSE pgp_sym_encrypt($16, $17) END,
         token_auth_method = $18,
         client_private_key_ciphertext = CASE
             WHEN $19::boolean THEN client_private_key_ciphertext
             WHEN $20::text IS NULL OR $20 = '' THEN NULL
             ELSE pgp_sym_encrypt($20, $17) END,
         jwt_signing_alg = $21, jwt_kid = $22, scope = $23, resource = $24, requested_token_type = $25,
         token_headers_json = $26::jsonb, resource_headers_json = $27::jsonb, verify_tls = $28,
         timeout_seconds = $29, allowed_resource_types = $30::jsonb, allowed_operations = $31::jsonb,
         client_public_jwk_json = $32, test_path = $33, default_token_strategy = $34,
         metadata_headers_json = $35::jsonb, environment = $37, display_name = $38, tags = $39::jsonb,
         updated_at = NOW()
       WHERE fhir_server_id = $1
       RETURNING *, (client_secret_ciphertext IS NOT NULL) AS client_secret_configured`,
      [
        existing.fhir_server_id, data.server_key, data.name, data.description, data.base_url,
        data.enabled, data.is_default, data.auth_type, data.auth_profile, data.auth_server_url,
        data.metadata_url, data.token_endpoint, data.use_metadata, data.client_id, keepSecret,
        data.client_secret, opts.secretKey, data.token_auth_method, keepPrivateKey,
        data.client_private_key, data.jwt_signing_alg, data.jwt_kid, data.scope, data.resource,
        data.requested_token_type, JSON.stringify(data.token_headers_json),
        JSON.stringify(data.resource_headers_json), data.verify_tls, data.timeout_seconds,
        JSON.stringify(data.allowed_resource_types), JSON.stringify(data.allowed_operations),
        publicJwkJson, data.test_path, data.default_token_strategy,
        JSON.stringify(data.metadata_headers_json), data.authorization_endpoint, data.environment,
        data.display_name, JSON.stringify(data.tags),
      ],
    );
    const row = res.rows[0] as Json;
    await adminAudit(client, {
      adminUser: opts.adminUser,
      action: "update_fhir_server",
      targetId: String(row.fhir_server_id),
      payload: data,
    });
    return serverPublic(row);
  });
}

/** Mirror `delete_fhir_server`. */
export async function deleteFhirServer(identifier: string, opts: { adminUser: string }): Promise<Json> {
  return withTransaction(async (client) => {
    const existing = await fetchServerRow(identifier, null);
    if (!existing) throw new FhirServerValueError("FHIR server not found");
    const res = await client.query(
      `DELETE FROM admin.fhir_servers WHERE fhir_server_id = $1
       RETURNING *, (client_secret_ciphertext IS NOT NULL) AS client_secret_configured`,
      [existing.fhir_server_id],
    );
    const row = res.rows[0] as Json;
    await adminAudit(client, {
      adminUser: opts.adminUser,
      action: "delete_fhir_server",
      targetId: String(row.fhir_server_id),
      payload: { server_key: row.server_key, name: row.name },
    });
    return serverPublic(row);
  });
}

// ── discovery (sub-step B1: OAuth2/SMART metadata discovery) ──────────────────

/** Mirror `_derive_metadata_url`. */
function deriveMetadataUrl(authServerUrl: string, metadataUrl: string, authProfile: string, baseUrl: string): string {
  if (metadataUrl) return metadataUrl;
  if (authProfile === AUTH_PROFILE_SMART) {
    const base = (baseUrl || authServerUrl).replace(/\/+$/, "");
    if (!base) return "";
    return `${base}/.well-known/smart-configuration`;
  }
  if (!authServerUrl) return "";
  return `${authServerUrl.replace(/\/+$/, "")}/.well-known/oauth-authorization-server`;
}

/** Mirror `_metadata_str_list`: dedup, trim, drop non-strings/empties. */
function metadataStrList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    const text = String(item).trim();
    if (text && !result.includes(text)) result.push(text);
  }
  return result;
}

/** Recursively key-sorted compact JSON == Python `json.dumps(sort_keys=True, separators=(",",":"))`. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value as Json).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Json)[k])}`).join(",")}}`;
}

/** Minimal GET via node:http(s) honoring timeout + TLS verification. */
function rawGet(
  url: string,
  headers: Record<string, string>,
  timeoutSeconds: number,
  verifyTls: boolean,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    let parsed: NodeURL;
    try {
      parsed = new NodeURL(url);
    } catch {
      reject(new Error(`Invalid metadata URL: ${url}`));
      return;
    }
    const isHttps = parsed.protocol === "https:";
    const lib = isHttps ? https : http;
    const req = lib.request(
      parsed,
      { method: "GET", headers, ...(isHttps ? { rejectUnauthorized: verifyTls } : {}) },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf-8") }));
      },
    );
    req.setTimeout(timeoutSeconds * 1000, () => req.destroy(new Error("metadata request timed out")));
    req.on("error", reject);
    req.end();
  });
}

/** Mirror `_fetch_metadata`: GET the discovery doc honoring timeout + verify_tls. */
async function fetchMetadata(server: {
  auth_server_url: string;
  metadata_url: string;
  base_url: string;
  auth_profile: string;
  verify_tls: boolean;
  timeout_seconds: number;
  metadata_headers_json?: unknown;
}): Promise<Json> {
  const metadataUrl = deriveMetadataUrl(server.auth_server_url, server.metadata_url, server.auth_profile, server.base_url);
  if (!metadataUrl.replace(/\//g, "")) return {};
  const headers: Record<string, string> = { Accept: "application/json" };
  Object.assign(headers, parseHeaders(server.metadata_headers_json ?? {}, false));
  const response = await rawGet(metadataUrl, headers, server.timeout_seconds, server.verify_tls);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Authorization metadata returned HTTP ${response.status}: ${response.text.slice(0, 500)}`);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(response.text);
  } catch {
    throw new Error("Authorization metadata returned non-JSON response");
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("Authorization metadata JSON must be an object");
  }
  return payload as Json;
}

/**
 * Faithful port of `discover_fhir_metadata`. Throws `FhirServerValueError` when
 * no metadata URL can be derived (→ HTTP 400); throws Error on fetch/parse
 * failure (the route maps that to `{ok:false, error}` with status 200).
 */
export async function discoverFhirMetadata(payload: Json): Promise<Json> {
  let authProfile = cleanText(payload.auth_profile || AUTH_PROFILE_NONE).toLowerCase();
  if (!AUTH_PROFILES.has(authProfile)) authProfile = AUTH_PROFILE_NONE;
  const server = {
    auth_server_url: validateOptionalUrl(cleanText(payload.auth_server_url), "auth_server_url"),
    metadata_url: validateOptionalUrl(cleanText(payload.metadata_url), "metadata_url"),
    base_url: validateOptionalUrl(cleanText(payload.base_url), "base_url"),
    auth_profile: authProfile,
    verify_tls: boolValue(payload.verify_tls, true),
    timeout_seconds: Math.max(1, Math.min(payload.timeout_seconds ? toIntStrict(payload.timeout_seconds) : 30, 120)),
    metadata_headers_json: payload.metadata_headers_json,
  };
  const metadataUrl = deriveMetadataUrl(server.auth_server_url, server.metadata_url, authProfile, server.base_url);
  if (!metadataUrl.replace(/\//g, "")) throw new FhirServerValueError("Provide a metadata URL or auth server URL first");

  const metadata = await fetchMetadata(server);
  const responseHash = crypto.createHash("sha256").update(canonicalJson(metadata), "utf-8").digest("hex");
  const endpoint = (key: string): string => String(metadata[key] ?? "");

  return {
    metadata_url: metadataUrl,
    fetched_at: new Date().toISOString().replace(/\.(\d{3})Z$/, ".$1000+00:00"),
    response_hash: responseHash,
    scopes_supported: metadataStrList(metadata.scopes_supported),
    token_endpoint_auth_methods_supported: metadataStrList(metadata.token_endpoint_auth_methods_supported),
    grant_types_supported: metadataStrList(metadata.grant_types_supported),
    response_types_supported: metadataStrList(metadata.response_types_supported),
    code_challenge_methods_supported: metadataStrList(metadata.code_challenge_methods_supported),
    smart_capabilities: metadataStrList(metadata.capabilities),
    issuer: endpoint("issuer"),
    token_endpoint: endpoint("token_endpoint"),
    authorization_endpoint: endpoint("authorization_endpoint"),
    jwks_uri: endpoint("jwks_uri"),
    registration_endpoint: endpoint("registration_endpoint"),
    introspection_endpoint: endpoint("introspection_endpoint"),
    revocation_endpoint: endpoint("revocation_endpoint"),
  };
}

// ════════════════════════════════════════════════════════════════════════════
// sub-step B2: token machinery + connection workflow + probe / test / test-request
// ════════════════════════════════════════════════════════════════════════════

const RESOURCE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/;
const MAX_RESPONSE_CHARS = 300_000;
const CLIENT_ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
const CLIENT_ASSERTION_LIFETIME_SECONDS = 300;
const TOKEN_CACHE_SKEW_SECONDS = 60;
const TOKEN_STRATEGY_FRESH = "fresh";
const TOKEN_STRATEGY_CACHED = "cached";
const DEFAULT_TOKEN_STRATEGY = TOKEN_STRATEGY_FRESH;
const TEST_REQUEST_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

// Shared per-server token cache + single-flight locks (used only by 'cached').
const tokenCache = new Map<string, { exp: number; token: string }>();
const tokenLocks = new Map<string, Promise<void>>();

function nowSeconds(): number {
  return Date.now() / 1000;
}

/** Mirror `_normalize_query`. */
function normalizeQuery(q: unknown): Record<string, string> {
  if (q === null || q === undefined || q === "") return {};
  const raw = jsonValue(q, q);
  if (typeof raw === "string") {
    const out: Record<string, string> = {};
    for (const [k, v] of new URLSearchParams(raw.replace(/^\?/, "")).entries()) out[k] = v;
    return out;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new FhirServerValueError("query must be a JSON object or query string");
  }
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Json)) {
    if (v === null || v === undefined) continue;
    result[String(k)] = String(v);
  }
  return result;
}

/** Mirror `_normalize_json_body`. */
function normalizeJsonBody(value: unknown, label: string): unknown {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      throw new FhirServerValueError(`${label} must be valid JSON`);
    }
  }
  return value;
}

/** Mirror `_validate_resource_id`. */
function validateResourceId(resourceId: string): string {
  const value = cleanText(resourceId);
  if (!RESOURCE_ID_RE.test(value)) throw new FhirServerValueError("resource_id must be a valid FHIR logical id");
  return value;
}

/** Mirror `resolve_token_strategy`. */
function resolveTokenStrategy(requested: string | null, serverDefault: string | null): string {
  const req = (requested || "auto").trim().toLowerCase();
  if (TOKEN_STRATEGY_DEFAULTS.has(req)) return req;
  const sd = (serverDefault || "").trim().toLowerCase();
  if (TOKEN_STRATEGY_DEFAULTS.has(sd)) return sd;
  return DEFAULT_TOKEN_STRATEGY;
}

/** Mirror `_derive_token_endpoint`. */
function deriveTokenEndpoint(authServerUrl: string, tokenEndpoint: string): string {
  if (tokenEndpoint) return tokenEndpoint;
  if (!authServerUrl) return "";
  return `${authServerUrl.replace(/\/+$/, "")}/token`;
}

function fhirUrl(server: Json, path: string): string {
  return `${String(server.base_url).replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function httpErrorExplanation(statusCode: number): string | null {
  if (statusCode === 401) {
    return "401 Unauthorized: token may be expired, invalid, scoped to the wrong audience/resource, or rejected by server policy.";
  }
  if (statusCode === 403) {
    return "403 Forbidden: token is valid but not authorized for this FHIR operation.";
  }
  return null;
}

/** General request via node:http(s) (mirrors httpx call surface used here). */
function rawRequest(opts: {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string | null;
  timeoutSeconds: number;
  verifyTls: boolean;
  basicAuth?: { user: string; pass: string } | null;
}): Promise<{ status: number; statusText: string; text: string; contentType: string }> {
  return new Promise((resolve, reject) => {
    let parsed: NodeURL;
    try {
      parsed = new NodeURL(opts.url);
    } catch {
      reject(new Error(`Invalid URL: ${opts.url}`));
      return;
    }
    const isHttps = parsed.protocol === "https:";
    const lib = isHttps ? https : http;
    const headers = { ...opts.headers };
    if (opts.basicAuth) {
      headers.Authorization = "Basic " + Buffer.from(`${opts.basicAuth.user}:${opts.basicAuth.pass}`).toString("base64");
    }
    if (opts.body !== null && opts.body !== undefined) headers["Content-Length"] = String(Buffer.byteLength(opts.body));
    const req = lib.request(
      parsed,
      { method: opts.method, headers, ...(isHttps ? { rejectUnauthorized: opts.verifyTls } : {}) },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            statusText: res.statusMessage ?? "",
            text: Buffer.concat(chunks).toString("utf-8"),
            contentType: String(res.headers["content-type"] ?? ""),
          }),
        );
      },
    );
    req.setTimeout(opts.timeoutSeconds * 1000, () => req.destroy(new Error("request timed out")));
    req.on("error", reject);
    if (opts.body !== null && opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

/** Mirror `_operation_to_request`. */
function operationToRequest(
  operation: string,
  args: { resourceType: string; resourceId: string; query: unknown; resource: unknown; patch: unknown },
): { method: string; path: string; queryParams: Record<string, string>; body: unknown; contentType: string } {
  const op = operation.trim().toLowerCase();
  if (!ALLOWED_OPERATIONS.has(op)) {
    throw new FhirServerValueError(`operation must be one of: ${[...ALLOWED_OPERATIONS].sort().join(", ")}`);
  }
  const queryParams = normalizeQuery(args.query);
  let contentType = "application/fhir+json";
  if (op === "metadata") return { method: "GET", path: "metadata", queryParams: {}, body: null, contentType };
  const rt = validateResourceType(args.resourceType);
  if (op === "read") {
    const rid = validateResourceId(args.resourceId);
    return { method: "GET", path: `${rt}/${rid}`, queryParams: {}, body: null, contentType };
  }
  if (op === "search") {
    if (!("_count" in queryParams)) queryParams._count = "50";
    return { method: "GET", path: rt, queryParams, body: null, contentType };
  }
  if (op === "create") {
    const body = normalizeJsonBody(args.resource, "resource_json");
    if (body === null) throw new FhirServerValueError("resource_json is required for create");
    return { method: "POST", path: rt, queryParams: {}, body, contentType };
  }
  if (op === "update") {
    const rid = validateResourceId(args.resourceId);
    const body = normalizeJsonBody(args.resource, "resource_json");
    if (body === null) throw new FhirServerValueError("resource_json is required for update");
    return { method: "PUT", path: `${rt}/${rid}`, queryParams: {}, body, contentType };
  }
  if (op === "patch") {
    const rid = validateResourceId(args.resourceId);
    const body = normalizeJsonBody(args.patch, "patch_json");
    if (body === null) throw new FhirServerValueError("patch_json is required for patch");
    if (Array.isArray(body)) contentType = "application/json-patch+json";
    return { method: "PATCH", path: `${rt}/${rid}`, queryParams: {}, body, contentType };
  }
  if (op === "delete") {
    const rid = validateResourceId(args.resourceId);
    return { method: "DELETE", path: `${rt}/${rid}`, queryParams: {}, body: null, contentType };
  }
  throw new FhirServerValueError(`Unsupported operation: ${operation}`);
}

/** Mirror `_capability_summary`. */
function capabilitySummary(payload: unknown): Json {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return {};
  const p = payload as Json;
  const rest = p.rest;
  const resources: Json[] = [];
  if (Array.isArray(rest)) {
    for (const restItem of rest) {
      if (typeof restItem !== "object" || restItem === null) continue;
      for (const res of ((restItem as Json).resource as unknown[]) ?? []) {
        if (typeof res !== "object" || res === null || !(res as Json).type) continue;
        const interactions: string[] = [];
        for (const i of ((res as Json).interaction as unknown[]) ?? []) {
          if (typeof i === "object" && i !== null && (i as Json).code) interactions.push(String((i as Json).code));
        }
        resources.push({ type: String((res as Json).type), profile: (res as Json).profile ?? "", interactions });
      }
    }
  }
  resources.sort((a, b) => String(a.type).localeCompare(String(b.type)));
  return {
    resourceType: p.resourceType ?? "",
    fhirVersion: p.fhirVersion ?? "",
    software: p.software ?? {},
    implementation: p.implementation ?? {},
    supported_resource_count: resources.length,
    supported_resources: resources,
  };
}

// ── JWT client assertion (client_secret_jwt / private_key_jwt) ────────────────
function b64urlJson(o: unknown): string {
  return Buffer.from(JSON.stringify(o)).toString("base64url");
}
function signJwt(claims: Json, key: string, alg: string, extraHeaders: Json): string {
  const header = { alg, typ: "JWT", ...extraHeaders };
  const signingInput = `${b64urlJson(header)}.${b64urlJson(claims)}`;
  let sig: string;
  if (alg.startsWith("HS")) {
    sig = crypto.createHmac(`sha${alg.slice(2)}`, key).update(signingInput).digest("base64url");
  } else if (alg.startsWith("RS")) {
    sig = crypto.createSign(`SHA${alg.slice(2)}`).update(signingInput).sign(key, "base64url");
  } else if (alg.startsWith("PS")) {
    sig = crypto
      .createSign(`SHA${alg.slice(2)}`)
      .update(signingInput)
      .sign({ key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST }, "base64url");
  } else if (alg.startsWith("ES")) {
    sig = crypto.createSign(`SHA${alg.slice(2)}`).update(signingInput).sign({ key, dsaEncoding: "ieee-p1363" }, "base64url");
  } else {
    throw new Error(`Unsupported JWT alg: ${alg}`);
  }
  return `${signingInput}.${sig}`;
}

/** Mirror `_build_client_assertion`. */
function buildClientAssertion(server: Json, tokenEndpoint: string): string {
  const clientId = String(server.client_id || "");
  if (!clientId) throw new Error("client_id is required to build a client assertion");
  const method = String(server.token_auth_method || TOKEN_AUTH_BASIC);
  const now = Math.floor(Date.now() / 1000);
  const claims: Json = {
    iss: clientId,
    sub: clientId,
    aud: tokenEndpoint,
    jti: crypto.randomBytes(24).toString("base64url"),
    iat: now,
    exp: now + CLIENT_ASSERTION_LIFETIME_SECONDS,
  };
  const headers: Json = {};
  if (server.jwt_kid) headers.kid = server.jwt_kid;
  if (method === TOKEN_AUTH_PRIVATE_KEY_JWT) {
    const privateKey = String(server.client_private_key || "");
    if (!privateKey) throw new Error("private key is required for private_key_jwt");
    const alg = String(server.jwt_signing_alg || DEFAULT_PRIVATE_KEY_JWT_ALG);
    try {
      return signJwt(claims, privateKey, alg, headers);
    } catch (exc) {
      throw new Error(`Failed to sign private_key_jwt assertion: ${String((exc as Error).message)}`);
    }
  }
  const secret = String(server.client_secret || "");
  if (!secret) throw new Error("client_secret is required for client_secret_jwt");
  const alg = String(server.jwt_signing_alg || DEFAULT_SECRET_JWT_ALG);
  return signJwt(claims, secret, alg, headers);
}

/** Mirror `_token_request_form`. */
function tokenRequestForm(server: Json): Record<string, string> {
  const authProfile = String(server.auth_profile || AUTH_PROFILE_NONE);
  const form: Record<string, string> = { grant_type: "client_credentials" };
  if (server.scope) form.scope = String(server.scope);
  if (authProfile !== AUTH_PROFILE_SMART) {
    if (server.resource) form.resource = String(server.resource);
    if (server.requested_token_type) form.requested_token_type = String(server.requested_token_type);
  }
  return form;
}

/** Mirror `apply_client_auth`: mutate form, return optional Basic auth. */
function applyClientAuth(server: Json, form: Record<string, string>, tokenEndpoint: string): { user: string; pass: string } | null {
  const method = String(server.token_auth_method || TOKEN_AUTH_BASIC);
  if (TOKEN_AUTH_JWT_METHODS.has(method)) {
    if (server.client_id) form.client_id = String(server.client_id);
    form.client_assertion_type = CLIENT_ASSERTION_TYPE;
    form.client_assertion = buildClientAssertion(server, tokenEndpoint);
    return null;
  }
  if (method === TOKEN_AUTH_POST) {
    form.client_id = String(server.client_id || "");
    form.client_secret = String(server.client_secret || "");
    return null;
  }
  const clientId = String(server.client_id || "");
  const clientSecret = String(server.client_secret || "");
  if (!clientSecret) {
    if (clientId) form.client_id = clientId;
    return null;
  }
  return { user: clientId, pass: clientSecret };
}

/** Mirror `_fetch_token`: client_credentials token request → [token, ttl]. */
async function fetchToken(server: Json, metadata: Json | null = null): Promise<[string, number]> {
  let meta = metadata ?? {};
  if (
    Object.keys(meta).length === 0 &&
    server.use_metadata &&
    (server.metadata_url || server.auth_server_url)
  ) {
    meta = await fetchMetadata({
      auth_server_url: String(server.auth_server_url || ""),
      metadata_url: String(server.metadata_url || ""),
      base_url: String(server.base_url || ""),
      auth_profile: String(server.auth_profile || AUTH_PROFILE_NONE),
      verify_tls: Boolean(server.verify_tls),
      timeout_seconds: Number(server.timeout_seconds),
      metadata_headers_json: server.metadata_headers_json,
    });
  }
  const tokenEndpoint = String(server.token_endpoint || meta.token_endpoint || deriveTokenEndpoint(String(server.auth_server_url || ""), ""));
  if (!tokenEndpoint) throw new Error("OAuth2 token endpoint is not configured");

  const headers: Record<string, string> = { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" };
  Object.assign(headers, parseHeaders(server.token_headers_json, false));
  const form = tokenRequestForm(server);
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
  if (tokenType.toLowerCase() !== "bearer") throw new Error(`Token response token_type is '${tokenType}'; expected Bearer`);
  const accessToken = String((payload as Json).access_token);
  const expiresIn = Number((payload as Json).expires_in || 300);
  const ttl = Math.max(30, expiresIn - TOKEN_CACHE_SKEW_SECONDS);
  return [accessToken, ttl];
}

/** Mirror `_access_token`: strategy-driven token (fresh isolated / cached single-flight). */
async function accessToken(server: Json, metadata: Json | null = null, strategy: string = DEFAULT_TOKEN_STRATEGY): Promise<string> {
  if (server.auth_type !== AUTH_OAUTH2_CC) return "";
  if (strategy !== TOKEN_STRATEGY_CACHED) {
    const [token] = await fetchToken(server, metadata);
    return token;
  }
  const cacheKey = String(server.fhir_server_id);
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.exp > nowSeconds()) return cached.token;
  // Single-flight: serialize fetches per server key.
  while (tokenLocks.has(cacheKey)) await tokenLocks.get(cacheKey);
  const again = tokenCache.get(cacheKey);
  if (again && again.exp > nowSeconds()) return again.token;
  let release!: () => void;
  tokenLocks.set(cacheKey, new Promise<void>((r) => (release = r)));
  try {
    const [token, ttl] = await fetchToken(server, metadata);
    tokenCache.set(cacheKey, { exp: nowSeconds() + ttl, token });
    return token;
  } finally {
    tokenLocks.delete(cacheKey);
    release();
  }
}

/** Acquire a Client Credentials token for MCP/runtime callers. */
export async function getClientCredentialsAccessToken(server: Json, strategy: string): Promise<string> {
  return accessToken(server, null, resolveTokenStrategy(strategy, String(server.default_token_strategy || "")));
}

/** Mirror `_call_fhir`. */
async function callFhir(
  server: Json,
  args: { operation: string; resourceType?: string; resourceId?: string; query?: unknown; resource?: unknown; patch?: unknown; tokenStrategy?: string; token?: string | null },
): Promise<Json> {
  const { method, path, queryParams, body, contentType } = operationToRequest(args.operation, {
    resourceType: args.resourceType ?? "",
    resourceId: args.resourceId ?? "",
    query: args.query,
    resource: args.resource,
    patch: args.patch,
  });
  let url = fhirUrl(server, path);
  const qs = new URLSearchParams(queryParams).toString();
  if (qs) url += `?${qs}`;
  const headers: Record<string, string> = { Accept: "application/fhir+json, application/json" };
  Object.assign(headers, parseHeaders(server.resource_headers_json, false));
  if (body !== null) headers["Content-Type"] = contentType;
  let token = args.token ?? null;
  if (token === null) token = await accessToken(server, null, args.tokenStrategy ?? DEFAULT_TOKEN_STRATEGY);
  if (token) headers.Authorization = `Bearer ${token}`;

  const start = Date.now();
  const response = await rawRequest({
    method,
    url,
    headers,
    body: body !== null ? JSON.stringify(body) : null,
    timeoutSeconds: Number(server.timeout_seconds),
    verifyTls: Boolean(server.verify_tls),
  });
  const durationMs = Date.now() - start;
  const truncated = response.text.length > MAX_RESPONSE_CHARS;
  let parsedJson: unknown = null;
  if (!truncated) {
    try {
      parsedJson = JSON.parse(response.text);
    } catch {
      parsedJson = null;
    }
  }
  const result: Json = {
    ok: response.status >= 200 && response.status < 300,
    operation: args.operation,
    method,
    url,
    status_code: response.status,
    reason: response.statusText,
    duration_ms: durationMs,
    content_type: response.contentType,
    truncated,
    explanation: httpErrorExplanation(response.status),
  };
  if (parsedJson !== null) result.json = parsedJson;
  else result.text = response.text.slice(0, MAX_RESPONSE_CHARS);
  return result;
}

/** Mirror `_probe_test_path`. */
async function probeTestPath(server: Json, testPath: string, token: string | null = null): Promise<Json> {
  const url = fhirUrl(server, testPath);
  const headers: Record<string, string> = { Accept: "application/fhir+json, application/json" };
  Object.assign(headers, parseHeaders(server.resource_headers_json, false));
  let tok = token;
  if (tok === null) tok = await accessToken(server, null, TOKEN_STRATEGY_FRESH);
  if (tok) headers.Authorization = `Bearer ${tok}`;
  const start = Date.now();
  const response = await rawRequest({
    method: "GET",
    url,
    headers,
    timeoutSeconds: Number(server.timeout_seconds),
    verifyTls: Boolean(server.verify_tls),
  });
  return {
    ok: response.status >= 200 && response.status < 300,
    url,
    status_code: response.status,
    reason: response.statusText,
    duration_ms: Date.now() - start,
    explanation: httpErrorExplanation(response.status),
  };
}

/** Mirror `_workflow_step`. */
function workflowStep(name: string, status: string, extra: { durationMs?: number; message?: string; details?: Json } = {}): Json {
  const payload: Json = { name, status, message: extra.message ?? "" };
  if (extra.durationMs !== undefined) payload.duration_ms = extra.durationMs;
  if (extra.details) payload.details = extra.details;
  return payload;
}

/**
 * Mirror `_run_connection_workflow`: metadata discovery → token → FHIR /metadata
 * (or configured test_path). For AC servers a pre-resolved user token/error is
 * supplied by the caller.
 */
async function runConnectionWorkflow(server: Json, userToken: string | null = null, userTokenError = ""): Promise<Json> {
  const started = Date.now();
  const steps: Json[] = [];
  let metadataPayload: Json | null = null;
  let result: Json | null = null;
  let accessTok: string | null = null;

  try {
    const authType = String(server.auth_type);
    if ((authType === AUTH_OAUTH2_CC || authType === AUTH_OAUTH2_AC) && (userToken !== null || userTokenError)) {
      if (userToken) {
        accessTok = userToken;
        steps.push(workflowStep("oauth_token", "ok", { message: "Using stored access token", details: { auth_type: authType, auth_profile: server.auth_profile || AUTH_PROFILE_NONE } }));
      } else {
        const message = userTokenError || "Server not authorized — click Authorize in the admin console";
        steps.push(workflowStep("oauth_token", "error", { message }));
        throw new Error(message);
      }
    } else if (authType === AUTH_OAUTH2_CC) {
      if (server.use_metadata && (server.metadata_url || server.auth_server_url)) {
        const stepStarted = Date.now();
        try {
          metadataPayload = await fetchMetadata({
            auth_server_url: String(server.auth_server_url || ""),
            metadata_url: String(server.metadata_url || ""),
            base_url: String(server.base_url || ""),
            auth_profile: String(server.auth_profile || AUTH_PROFILE_NONE),
            verify_tls: Boolean(server.verify_tls),
            timeout_seconds: Number(server.timeout_seconds),
            metadata_headers_json: server.metadata_headers_json,
          });
          const grantTypes = metadataPayload.grant_types_supported;
          steps.push(workflowStep("oauth_metadata", "ok", {
            durationMs: Date.now() - stepStarted,
            message: "Authorization metadata discovered",
            details: {
              token_endpoint_present: Boolean(metadataPayload.token_endpoint),
              client_credentials_supported: Array.isArray(grantTypes) ? grantTypes.includes("client_credentials") : null,
            },
          }));
        } catch (exc) {
          steps.push(workflowStep("oauth_metadata", "error", { durationMs: Date.now() - stepStarted, message: String((exc as Error).message) }));
          throw exc;
        }
      } else {
        steps.push(workflowStep("oauth_metadata", "skipped", { message: "Metadata discovery disabled or not configured" }));
      }
      const stepStarted = Date.now();
      try {
        accessTok = await accessToken(server, metadataPayload, TOKEN_STRATEGY_FRESH);
        steps.push(workflowStep("oauth_token", "ok", {
          durationMs: Date.now() - stepStarted,
          message: "Client Credentials access token acquired",
          details: { auth_method: server.token_auth_method || TOKEN_AUTH_BASIC, auth_profile: server.auth_profile || AUTH_PROFILE_NONE },
        }));
      } catch (exc) {
        steps.push(workflowStep("oauth_token", "error", { durationMs: Date.now() - stepStarted, message: String((exc as Error).message) }));
        throw exc;
      }
    } else {
      steps.push(workflowStep("oauth", "skipped", { message: "OAuth2 is disabled for this server" }));
    }

    const testPath = String(server.test_path || "").trim();
    const stepStarted = Date.now();
    let ok: boolean;
    let capability: Json = {};
    if (testPath) {
      result = await probeTestPath(server, testPath, accessTok);
      ok = Boolean(result.ok);
      steps.push(workflowStep("fhir_test_path", ok ? "ok" : "error", {
        durationMs: Date.now() - stepStarted,
        message: ok ? `Test path reachable (HTTP ${result.status_code})` : `Test path HTTP ${result.status_code}`,
        details: { path: testPath, url: result.url, status_code: result.status_code, reason: result.reason, explanation: result.explanation },
      }));
    } else {
      result = await callFhir(server, { operation: "metadata", tokenStrategy: TOKEN_STRATEGY_FRESH, token: accessTok });
      ok = Boolean(result.ok);
      steps.push(workflowStep("fhir_metadata", ok ? "ok" : "error", {
        durationMs: Date.now() - stepStarted,
        message: ok ? "FHIR CapabilityStatement reachable" : `FHIR metadata HTTP ${result.status_code}`,
        details: { status_code: result.status_code, reason: result.reason, explanation: result.explanation },
      }));
      capability = capabilitySummary(result.json);
    }

    return {
      ok,
      probe: {
        status: ok ? "ok" : "error",
        message: ok ? "Full connection workflow succeeded" : `FHIR ${testPath ? "test path" : "metadata"} HTTP ${result.status_code}`,
        latency_ms: Date.now() - started,
        details: { steps },
      },
      capability_summary: capability,
      raw_result: ok ? null : result,
    };
  } catch (exc) {
    const msg = String((exc as Error).message);
    return {
      ok: false,
      probe: { status: "error", message: msg, latency_ms: Date.now() - started, details: { steps, error: msg } },
      capability_summary: {},
      raw_result: result || { ok: false, error: msg },
    };
  }
}

/**
 * Mirror `_resolve_user_token_for_probe`. For non-OAuth → (null, ""). AC servers
 * need the stored interactive token (sub-step C); until C is wired, surface a
 * clean reason rather than a hard failure.
 */
async function resolveUserTokenForProbe(server: Json, secretKey: string): Promise<[string | null, string]> {
  const authType = String(server.auth_type);
  if (authType !== AUTH_OAUTH2_CC && authType !== AUTH_OAUTH2_AC) return [null, ""];
  if (String(server.fhir_server_id || "").startsWith("draft:")) {
    return [null, "Save the server and click Authorize before probing"];
  }
  // Lazy import to avoid the adminFhirServers ↔ fhirOauthService import cycle
  // (mirrors Python's in-function `import fhir_oauth_service`).
  const oauth = await import("./fhirOauthService.js");
  try {
    const token = await oauth.getValidUserAccessToken(server, secretKey);
    return [token, ""];
  } catch (exc) {
    if (exc instanceof oauth.OAuthError) return [null, exc.message];
    throw exc;
  }
}

/** Mirror `probe_fhir_server`. */
export async function probeFhirServer(identifier: string, secretKey: string): Promise<Json> {
  const row = await fetchServerRow(identifier, secretKey);
  if (!row) throw new FhirServerValueError("FHIR server not found");
  const server = serverPrivate(row);

  const [userToken, userTokenError] = await resolveUserTokenForProbe(server, secretKey);
  const wf = await runConnectionWorkflow(server, userToken, userTokenError);
  const probe = wf.probe as Json;
  const status = String(probe.status);
  const message = String(probe.message);
  const latencyMs = Number(probe.latency_ms);
  const details = (probe.details as Json) || {};
  const summary = (wf.capability_summary as Json) || {};
  const error = wf.ok ? "" : message;

  const refreshed = await withTransaction(async (client) => {
    await client.query(
      `UPDATE admin.fhir_servers SET last_probe_status = $2, last_probe_at = NOW(),
         last_probe_error = $3, capability_summary_json = $4::jsonb, updated_at = NOW()
       WHERE fhir_server_id = $1`,
      [server.fhir_server_id, status, error, JSON.stringify(summary)],
    );
    await client.query(
      `INSERT INTO admin.fhir_server_probe_history
         (fhir_server_id, status, endpoint, latency_ms, message, details_json)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [server.fhir_server_id, status, server.base_url, latencyMs, message, JSON.stringify(details)],
    );
    const r = await client.query(
      `SELECT ${PUBLIC_SELECT} FROM admin.fhir_servers WHERE fhir_server_id = $1`,
      [server.fhir_server_id],
    );
    return r.rows[0] as Json;
  });

  return {
    ...wf,
    ok: status === "ok",
    server: serverPublic(refreshed),
    probe: { status, message, latency_ms: latencyMs, details },
    capability_summary: summary,
  };
}

/** Mirror `_build_draft_server`: validate a draft payload into a runtime server dict. */
async function buildDraftServer(payload: Json, secretKey: string): Promise<[Json, string, Json | null]> {
  const existingIdentifier = cleanText(payload.fhir_server_id || payload.existing_id || payload.server_id);
  let existingPublic: Json | null = null;
  let existingSecret = "";
  let existingPrivateKey = "";
  if (existingIdentifier) {
    const row = await fetchServerRow(existingIdentifier, secretKey);
    if (!row) throw new FhirServerValueError("FHIR server not found");
    existingPublic = serverPublic(row);
    const priv = serverPrivate(row);
    existingSecret = String(priv.client_secret || "");
    existingPrivateKey = String(priv.client_private_key || "");
  }
  const data = validateServerPayload(payload, existingPublic);
  const clientSecret = (data.client_secret as string | null) || existingSecret;
  const clientPrivateKey = (data.client_private_key as string | null) || existingPrivateKey;
  const server: Json = {
    fhir_server_id: `draft:${process.hrtime.bigint()}`,
    server_key: data.server_key,
    name: data.name,
    description: data.description,
    base_url: data.base_url,
    test_path: data.test_path || "",
    default_token_strategy: data.default_token_strategy || "",
    enabled: data.enabled,
    is_default: data.is_default,
    auth_type: data.auth_type,
    auth_profile: data.auth_profile,
    auth_server_url: data.auth_server_url || "",
    metadata_url: data.metadata_url || "",
    token_endpoint: data.token_endpoint || "",
    use_metadata: data.use_metadata,
    client_id: data.client_id || "",
    client_secret: clientSecret || "",
    client_secret_configured: Boolean(clientSecret),
    token_auth_method: data.token_auth_method,
    client_private_key: clientPrivateKey || "",
    client_private_key_configured: Boolean(clientPrivateKey),
    jwt_signing_alg: data.jwt_signing_alg || "",
    jwt_kid: data.jwt_kid || "",
    scope: data.scope || "",
    resource: data.resource || "",
    requested_token_type: data.requested_token_type || "",
    metadata_headers_json: data.metadata_headers_json,
    token_headers_json: data.token_headers_json,
    resource_headers_json: data.resource_headers_json,
    verify_tls: data.verify_tls,
    timeout_seconds: data.timeout_seconds,
    allowed_resource_types: data.allowed_resource_types,
    allowed_operations: data.allowed_operations,
    last_probe_status: "",
    last_probe_at: null,
    last_probe_error: "",
    capability_summary_json: {},
    created_by: "",
    created_at: null,
    updated_at: null,
  };
  return [server, existingIdentifier, existingPublic];
}

/** Mirror `test_fhir_server_config`. */
export async function testFhirServerConfig(payload: Json, secretKey: string): Promise<Json> {
  const [server, existingIdentifier, existingPublic] = await buildDraftServer(payload, secretKey);
  let userToken: string | null = null;
  let userTokenError = "";
  if (server.auth_type === AUTH_OAUTH2_AC) {
    if (existingIdentifier && existingPublic) {
      const probeServer = { ...server, fhir_server_id: existingPublic.fhir_server_id };
      [userToken, userTokenError] = await resolveUserTokenForProbe(probeServer, secretKey);
    } else {
      userTokenError = "Save the server and click Authorize before testing Authorization Code connectivity";
    }
  }
  try {
    const result = await runConnectionWorkflow(server, userToken, userTokenError);
    result.server_preview = serverPublic(server);
    return result;
  } finally {
    tokenCache.delete(String(server.fhir_server_id));
  }
}

/** Mirror `_normalize_expected_statuses`. */
function normalizeExpectedStatuses(value: unknown): number[] {
  if (value === null || value === undefined || value === "") return [];
  let parts: unknown[];
  if (typeof value === "string") parts = value.trim().split(/[,\s]+/);
  else if (Array.isArray(value)) parts = value;
  else return [];
  const out = new Set<number>();
  for (const part of parts) {
    const code = parseInt(String(part).trim(), 10);
    if (!Number.isNaN(code) && code >= 100 && code <= 599) out.add(code);
  }
  return [...out].sort((a, b) => a - b);
}

/** Mirror `_send_test_request`. */
async function sendTestRequest(
  server: Json,
  args: { method: string; path: string; query: Record<string, string>; extraHeaders: Record<string, string>; body: unknown; expectedStatuses: number[]; token?: string | null },
): Promise<Json> {
  let url = fhirUrl(server, args.path);
  if (Object.keys(args.query).length > 0) url += (url.includes("?") ? "&" : "?") + new URLSearchParams(args.query).toString();
  const headers: Record<string, string> = { Accept: "application/fhir+json, application/json" };
  Object.assign(headers, parseHeaders(server.resource_headers_json, false));
  Object.assign(headers, args.extraHeaders);
  let token = args.token ?? null;
  if (token === null && (server.auth_type === AUTH_OAUTH2_CC || server.auth_type === AUTH_OAUTH2_AC)) {
    token = await accessToken(server, null, TOKEN_STRATEGY_FRESH);
  }
  if (token) headers.Authorization = `Bearer ${token}`;
  let content: string | null = null;
  if (args.body !== null && args.body !== undefined && ["POST", "PUT", "PATCH"].includes(args.method)) {
    content = typeof args.body === "string" ? args.body : JSON.stringify(args.body);
    if (!("Content-Type" in headers)) headers["Content-Type"] = "application/fhir+json";
  }
  const start = Date.now();
  const response = await rawRequest({
    method: args.method,
    url,
    headers,
    body: content,
    timeoutSeconds: Number(server.timeout_seconds),
    verifyTls: Boolean(server.verify_tls),
  });
  const ok = args.expectedStatuses.length ? args.expectedStatuses.includes(response.status) : response.status >= 200 && response.status < 300;
  return {
    ok,
    method: args.method,
    url,
    status_code: response.status,
    reason: response.statusText,
    duration_ms: Date.now() - start,
    expected_statuses: [...args.expectedStatuses].sort((a, b) => a - b),
    explanation: httpErrorExplanation(response.status),
    body_preview: response.text.slice(0, 2000),
  };
}

/** Mirror `run_fhir_test_request`. */
export async function runFhirTestRequest(payload: Json, secretKey: string): Promise<Json> {
  let [server, existingIdentifier, existingPublic] = await buildDraftServer(payload, secretKey);
  const test = payload.test;
  if (typeof test !== "object" || test === null || Array.isArray(test)) throw new FhirServerValueError("test object is required");
  const t = test as Json;
  const method = cleanText(t.method || "GET").toUpperCase();
  if (!TEST_REQUEST_METHODS.has(method)) throw new FhirServerValueError("method must be one of: " + [...TEST_REQUEST_METHODS].sort().join(", "));
  const path = cleanText(t.path || "/metadata") || "/metadata";
  const query = normalizeQuery(t.query);
  const extraHeaders = parseHeaders(t.headers, false);
  const body = normalizeJsonBody(t.body, "test.body");
  const expectedStatuses = normalizeExpectedStatuses(t.expected_statuses !== undefined ? t.expected_statuses : t.expectedStatuses);
  let rawTimeout = t.timeout_seconds;
  if (rawTimeout === null || rawTimeout === undefined) rawTimeout = t.timeoutSeconds;
  if (rawTimeout !== null && rawTimeout !== undefined && rawTimeout !== "") {
    server = { ...server, timeout_seconds: Math.max(1, Math.min(toIntStrict(rawTimeout), 120)) };
  }

  let userToken: string | null = null;
  if (server.auth_type === AUTH_OAUTH2_AC) {
    if (existingIdentifier && existingPublic) {
      const probeServer = { ...server, fhir_server_id: existingPublic.fhir_server_id };
      const [tok, err] = await resolveUserTokenForProbe(probeServer, secretKey);
      if (err) return { ok: false, error: err, server_preview: serverPublic(server) };
      userToken = tok;
    } else {
      return {
        ok: false,
        error: "Save the server and click Authorize before testing Authorization Code connectivity",
        server_preview: serverPublic(server),
      };
    }
  }
  try {
    const result = await sendTestRequest(server, { method, path, query, extraHeaders, body, expectedStatuses, token: userToken });
    result.server_preview = serverPublic(server);
    return result;
  } finally {
    tokenCache.delete(String(server.fhir_server_id));
  }
}

/** Mirror `set_default_fhir_server`. */
export async function setDefaultFhirServer(identifier: string, opts: { adminUser: string }): Promise<Json> {
  return withTransaction(async (client) => {
    const existing = await fetchServerRow(identifier, null);
    if (!existing) throw new FhirServerValueError("FHIR server not found");
    if (!existing.enabled) throw new FhirServerValueError("default FHIR server must be enabled");
    await client.query("UPDATE admin.fhir_servers SET is_default = FALSE");
    const res = await client.query(
      `UPDATE admin.fhir_servers SET is_default = TRUE, updated_at = NOW() WHERE fhir_server_id = $1
       RETURNING *, (client_secret_ciphertext IS NOT NULL) AS client_secret_configured`,
      [existing.fhir_server_id],
    );
    const row = res.rows[0] as Json;
    await adminAudit(client, {
      adminUser: opts.adminUser,
      action: "set_default_fhir_server",
      targetId: String(row.fhir_server_id),
      payload: { server_key: row.server_key },
    });
    return serverPublic(row);
  });
}

// ── exports for fhirOauthService.ts (mirrors `import fhir_server_service as fss`) ──
export const OAUTH2_AUTH_TYPES = new Set([AUTH_OAUTH2_CC, AUTH_OAUTH2_AC]);

/** Evict the CC client-credentials token cache entry for a server. */
export function popCcTokenCache(key: string): void {
  tokenCache.delete(key);
}

/** Run `fn` under the shared per-key single-flight lock (mirrors `fss._token_lock`). */
export async function runTokenSingleFlight<T>(key: string, fn: () => Promise<T>): Promise<T> {
  while (tokenLocks.has(key)) await tokenLocks.get(key);
  let release!: () => void;
  tokenLocks.set(key, new Promise<void>((r) => (release = r)));
  try {
    return await fn();
  } finally {
    tokenLocks.delete(key);
    release();
  }
}

export {
  fetchServerRow,
  serverPrivate,
  fetchMetadata,
  deriveTokenEndpoint,
  applyClientAuth,
  tokenRequestForm,
  parseHeaders,
  rawRequest,
  AUTH_OAUTH2_CC,
  AUTH_OAUTH2_AC,
  AUTH_PROFILE_SMART,
  TOKEN_CACHE_SKEW_SECONDS,
};
