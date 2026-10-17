/**
 * "Sign in with ChatGPT" — OpenAI's official plan-usage flow for open-source /
 * self-hosted apps (preview). https://developers.openai.com/siwc/token-sharing-open-source
 *
 * Flow: PKCE authorization against auth.openai.com with dynamic client
 * registration (`dynamic_agent_client` → an issued `oaiapp_…` id), a loopback
 * redirect (http://127.0.0.1:1455/auth/callback — the only kind OpenAI allows).
 * This server is remote, so the browser's redirect cannot reach it: the operator
 * pastes the final URL back and we finish the exchange here.
 *
 * Tokens live in admin.llm_providers.oauth and never leave the server. Access
 * tokens last an hour; refresh tokens ROTATE and a reused one revokes the whole
 * sign-in, so refreshes are serialized with a row lock — the app and the worker
 * are separate processes and may both need a fresh token at once.
 */

import crypto from "node:crypto";
import { query, withTransaction } from "../db.js";
import { logInfo, logWarning } from "../logger.js";
import { invalidateRoutingCache } from "./llmRouting.js";
import { ProfileValidationError } from "./llmProfiles.js";

const ISSUER = "https://auth.openai.com";
const AUTHORIZE_URL = `${ISSUER}/api/accounts/authorize`;
const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;
const RESOURCE = "https://api.openai.com/v1";
const REDIRECT_URI = "http://127.0.0.1:1455/auth/callback";
const SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const PLAN_SCOPE = "chatgpt.tokens.use.direct";
const APP_NAME = "Taiwan Health MCP";
const PENDING_TTL_MS = 15 * 60_000;
/** Refresh this long before expiry. */
const REFRESH_SKEW_MS = 120_000;

export const CHATGPT_PROVIDER_ID = "chatgpt";

export interface ChatgptCredential {
  client_id: string;
  host_id: string;
  id_token: string;
  access_token: string;
  refresh_token: string;
  expires_at: number;
  scope: string;
  sub: string;
  email: string;
  connected_by: string;
  connected_at: string;
  /** "ok" | "reauth_required" */
  status: string;
  last_error?: string;
}

/** What the admin UI may see about a sign-in — never the tokens. */
export function credentialSummary(raw: unknown): Record<string, unknown> | null {
  const c = raw as Partial<ChatgptCredential> | null;
  if (!c || !c.client_id) return null;
  return {
    email: c.email ?? "",
    status: c.status ?? "ok",
    expires_at: c.expires_at ? new Date(c.expires_at).toISOString() : null,
    connected_by: c.connected_by ?? "",
    connected_at: c.connected_at ?? null,
    last_error: c.last_error ?? null,
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/** One host id per installation, persisted (OpenAI: "distinct for each host", reused). */
async function hostId(): Promise<string> {
  const existing = await query<{ value: string }>("SELECT value FROM admin.app_settings WHERE group_key = 'oauth' AND key = 'chatgpt_host_id'");
  if (existing.rows[0]?.value) return existing.rows[0].value;
  const id = `urn:uuid:${crypto.randomUUID()}`;
  await query(
    `INSERT INTO admin.app_settings (group_key, key, value, updated_at, updated_by) VALUES ('oauth', 'chatgpt_host_id', $1, NOW(), 'system')
     ON CONFLICT DO NOTHING`,
    [id],
  );
  const again = await query<{ value: string }>("SELECT value FROM admin.app_settings WHERE group_key = 'oauth' AND key = 'chatgpt_host_id'");
  return again.rows[0]?.value ?? id;
}

async function postForm(url: string, form: Record<string, string>, timeoutMs = 30_000): Promise<Record<string, unknown>> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await r.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* non-JSON error page */
  }
  if (!r.ok) {
    const code = String(json.error ?? `http_${r.status}`);
    const err = new Error(`${code}: ${String(json.error_description ?? text.slice(0, 200))}`) as Error & { code?: string };
    err.code = code;
    throw err;
  }
  return json;
}

// ── ID token validation (RS256 against OpenAI's JWKS) ────────────────────────

let jwksCache: { at: number; keys: Array<Record<string, string>> } | null = null;

async function jwks(force = false): Promise<Array<Record<string, string>>> {
  if (!force && jwksCache && Date.now() - jwksCache.at < 3600_000) return jwksCache.keys;
  const r = await fetch(JWKS_URL, { signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`Could not fetch OpenAI signing keys (HTTP ${r.status})`);
  const j = (await r.json()) as { keys?: Array<Record<string, string>> };
  jwksCache = { at: Date.now(), keys: j.keys ?? [] };
  return jwksCache.keys;
}

export async function verifyIdToken(idToken: string, clientId: string, nonce: string): Promise<Record<string, unknown>> {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("ID token is malformed.");
  const header = JSON.parse(b64urlDecode(parts[0]).toString("utf8")) as { alg?: string; kid?: string };
  if (header.alg !== "RS256") throw new Error(`Unexpected ID token algorithm: ${header.alg}`);
  let key = (await jwks()).find((k) => k.kid === header.kid);
  if (!key) key = (await jwks(true)).find((k) => k.kid === header.kid);
  if (!key) throw new Error("ID token is signed with an unknown key.");
  const publicKey = crypto.createPublicKey({ key: key as crypto.JsonWebKey, format: "jwk" });
  const ok = crypto.verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, b64urlDecode(parts[2]));
  if (!ok) throw new Error("ID token signature is invalid.");
  const claims = JSON.parse(b64urlDecode(parts[1]).toString("utf8")) as Record<string, unknown>;
  if (claims.iss !== ISSUER) throw new Error(`ID token issuer mismatch: ${String(claims.iss)}`);
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(clientId)) throw new Error("ID token audience does not match the issued client id.");
  if (typeof claims.exp !== "number" || claims.exp * 1000 < Date.now() - 60_000) throw new Error("ID token has expired.");
  if (claims.nonce !== nonce) throw new Error("ID token nonce mismatch.");
  return claims;
}

// ── sign-in ──────────────────────────────────────────────────────────────────

interface Pending {
  verifier: string;
  nonce: string;
  name: string;
  accountId: number | null;
  clientId: string;
  dynamic: boolean;
  allowRoleUse: boolean;
  user: string;
  createdAt: number;
}

const pending = new Map<string, Pending>();

function prunePending(): void {
  const now = Date.now();
  for (const [k, v] of pending) if (now - v.createdAt > PENDING_TTL_MS) pending.delete(k);
}

async function loadCredential(accountId: number): Promise<ChatgptCredential | null> {
  const r = await query<{ oauth: ChatgptCredential | null; provider: string }>("SELECT oauth, provider FROM admin.llm_providers WHERE id = $1", [accountId]);
  if (!r.rows[0] || r.rows[0].provider !== CHATGPT_PROVIDER_ID) return null;
  const c = r.rows[0].oauth;
  return c && c.client_id ? c : null;
}

/** Begin a sign-in: returns the URL to open in the operator's browser. */
export async function startChatgptLogin(opts: { name: string; accountId?: number | null; allowRoleUse?: boolean; user: string }): Promise<{ authorize_url: string; state: string; redirect_uri: string }> {
  prunePending();
  const name = String(opts.name ?? "").trim();
  if (!name && !opts.accountId) throw new ProfileValidationError("Account name is required.");
  const existing = opts.accountId ? await loadCredential(opts.accountId) : null;
  const host = existing?.host_id ?? (await hostId());
  const verifier = b64url(crypto.randomBytes(48));
  const state = b64url(crypto.randomBytes(24));
  const nonce = b64url(crypto.randomBytes(24));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const dynamic = !existing;
  const params = new URLSearchParams({
    client_id: existing?.client_id ?? "dynamic_agent_client",
    ext_agent_host_id: host,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    resource: RESOURCE,
    state,
    nonce,
    code_challenge_method: "S256",
    code_challenge: challenge,
  });
  if (dynamic) params.set("agent_name_hint", APP_NAME);
  if (existing?.id_token) params.set("id_token_hint", existing.id_token);
  if (existing?.email) params.set("login_hint", existing.email);
  pending.set(state, {
    verifier,
    nonce,
    name,
    accountId: opts.accountId ?? null,
    clientId: existing?.client_id ?? "",
    dynamic,
    allowRoleUse: Boolean(opts.allowRoleUse),
    user: opts.user,
    createdAt: Date.now(),
  });
  return { authorize_url: `${AUTHORIZE_URL}?${params.toString()}`, state, redirect_uri: REDIRECT_URI };
}

/** Finish a sign-in from the pasted redirect URL; creates or updates the account. */
export async function completeChatgptLogin(opts: { callbackUrl: string; user: string }): Promise<{ account_id: number; email: string }> {
  prunePending();
  let url: URL;
  try {
    url = new URL(String(opts.callbackUrl ?? "").trim());
  } catch {
    throw new ProfileValidationError("That is not a URL. Paste the full address from the browser after signing in (it starts with http://127.0.0.1:1455/auth/callback).");
  }
  const err = url.searchParams.get("error");
  if (err) throw new ProfileValidationError(`ChatGPT sign-in was not completed: ${err} ${url.searchParams.get("error_description") ?? ""}`.trim());
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? "";
  const p = pending.get(state);
  if (!p) throw new ProfileValidationError("This sign-in link has expired or was already used. Start the ChatGPT sign-in again.");
  if (!code) throw new ProfileValidationError("The pasted URL has no authorization code.");
  pending.delete(state);

  const issued = url.searchParams.get("client_id") ?? "";
  const clientId = p.dynamic ? issued : p.clientId || issued;
  if (!clientId || clientId === "dynamic_agent_client") {
    throw new ProfileValidationError("OpenAI did not issue a client id for this app (registration incomplete). Start the sign-in again.");
  }

  let tokens: Record<string, unknown>;
  try {
    tokens = await postForm(TOKEN_URL, {
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: p.verifier,
      redirect_uri: REDIRECT_URI,
      resource: RESOURCE,
    });
  } catch (exc) {
    throw new ProfileValidationError(`Token exchange failed: ${(exc as Error).message}. Start the sign-in again.`);
  }
  const idToken = String(tokens.id_token ?? "");
  const claims = await verifyIdToken(idToken, clientId, p.nonce).catch((e: Error) => {
    throw new ProfileValidationError(`ChatGPT identity could not be verified: ${e.message}`);
  });
  const scope = String(tokens.scope ?? url.searchParams.get("scope") ?? "");
  if (!scope.split(/[\s+]+/).includes(PLAN_SCOPE)) {
    throw new ProfileValidationError("Plan usage was not granted (chatgpt.tokens.use.direct missing). Sign in again and allow ChatGPT plan usage.");
  }
  const host = (p.accountId ? (await loadCredential(p.accountId))?.host_id : undefined) ?? (await hostId());
  const cred: ChatgptCredential = {
    client_id: clientId,
    host_id: host,
    id_token: idToken,
    access_token: String(tokens.access_token ?? ""),
    refresh_token: String(tokens.refresh_token ?? ""),
    expires_at: Date.now() + Number(tokens.expires_in ?? 3600) * 1000,
    scope,
    sub: String(claims.sub ?? ""),
    email: String(claims.email ?? ""),
    connected_by: p.user,
    connected_at: new Date().toISOString(),
    status: "ok",
  };
  if (!cred.access_token || !cred.refresh_token) throw new ProfileValidationError("OpenAI returned no usable tokens.");

  let accountId = p.accountId;
  if (accountId) {
    await query("UPDATE admin.llm_providers SET oauth = $2::jsonb, auth_type = 'oauth', updated_at = NOW() WHERE id = $1", [accountId, JSON.stringify(cred)]);
  } else {
    try {
      const r = await query<{ id: string }>(
        `INSERT INTO admin.llm_providers (name, provider, base_url, auth_type, api_key, oauth, enabled, params)
         VALUES ($1, $2, $3, 'oauth', '', $4::jsonb, TRUE, $5::jsonb) RETURNING id`,
        [p.name, CHATGPT_PROVIDER_ID, RESOURCE, JSON.stringify(cred), JSON.stringify({ allow_role_use: p.allowRoleUse })],
      );
      accountId = Number(r.rows[0].id);
    } catch (exc) {
      if ((exc as { code?: string }).code === "23505") throw new ProfileValidationError(`An account named '${p.name}' already exists.`);
      throw exc;
    }
  }
  await query(
    `INSERT INTO admin.admin_audit_log (admin_user, action, target_type, target_id, payload_json) VALUES ($1, 'chatgpt_sign_in', 'llm_provider', $2, $3::jsonb)`,
    [p.user, String(accountId), JSON.stringify({ email: cred.email })],
  );
  invalidateRoutingCache();
  logInfo("chatgpt_sign_in", { account_id: accountId, by: p.user });
  return { account_id: accountId!, email: cred.email };
}

// ── access tokens for calls ──────────────────────────────────────────────────

const TERMINAL = ["invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused", "invalid_client"];

/** Refresh-token POST timeout: the row lock (and a pooled connection) is held meanwhile. */
const REFRESH_TIMEOUT_MS = 15_000;
/** How long to wait for another process's refresh row lock before re-reading. */
const REFRESH_LOCK_TIMEOUT = "3s";
/** Total time to keep re-reading while another process holds the refresh lock. */
const REFRESH_LOCK_WAIT_MS = REFRESH_TIMEOUT_MS + 5_000;

/** In-process single flight: concurrent callers share one refresh per account. */
const refreshing = new Map<number, Promise<string>>();

type RefreshOutcome =
  | { kind: "token"; token: string }
  | { kind: "terminal"; code: string }
  | { kind: "no_access_token" };

/**
 * A valid access token for the account, refreshing (and persisting the rotated
 * refresh token) when it is about to expire.
 *
 * Refreshes are single-flighted inside the process and serialized across
 * processes by a row lock taken with a short `lock_timeout`; a process that
 * cannot get the lock re-reads the credential (the holder is refreshing it)
 * instead of queueing a pooled connection behind a slow HTTP call.
 */
export async function getChatgptAccessToken(accountId: number): Promise<string> {
  const cur = await loadCredential(accountId);
  if (!cur) throw new Error("This ChatGPT account is not signed in.");
  if (cur.status === "reauth_required") throw new Error("ChatGPT sign-in expired or was revoked; sign in again from Provider accounts.");
  if (cur.access_token && cur.expires_at - REFRESH_SKEW_MS > Date.now()) return cur.access_token;

  let inflight = refreshing.get(accountId);
  if (!inflight) {
    inflight = refreshWithLock(accountId).finally(() => refreshing.delete(accountId));
    refreshing.set(accountId, inflight);
  }
  return inflight;
}

function isLockTimeout(exc: unknown): boolean {
  return (exc as { code?: string } | null)?.code === "55P03";
}

async function refreshWithLock(accountId: number): Promise<string> {
  const deadline = Date.now() + REFRESH_LOCK_WAIT_MS;
  for (;;) {
    let outcome: RefreshOutcome;
    try {
      outcome = await refreshOnce(accountId);
    } catch (exc) {
      if (!isLockTimeout(exc) || Date.now() > deadline) throw exc;
      // Another process holds the lock while it refreshes: see whether it has
      // finished before trying for the lock again.
      const c = await loadCredential(accountId);
      if (c?.status === "reauth_required") throw new Error("ChatGPT sign-in expired or was revoked; sign in again from Provider accounts.");
      if (c?.access_token && c.expires_at - REFRESH_SKEW_MS > Date.now()) return c.access_token;
      await new Promise((resolve) => setTimeout(resolve, 500));
      continue;
    }
    // Errors are raised only after the transaction committed, so the status
    // written alongside them is kept.
    if (outcome.kind === "token") return outcome.token;
    if (outcome.kind === "terminal") {
      logWarning("chatgpt_reauth_required", { account_id: accountId, error: outcome.code });
      throw new Error(`ChatGPT sign-in is no longer valid (${outcome.code}); sign in again from Provider accounts.`);
    }
    logWarning("chatgpt_refresh_without_access_token", { account_id: accountId });
    throw new Error("ChatGPT token refresh returned no access token; try again shortly.");
  }
}

async function refreshOnce(accountId: number): Promise<RefreshOutcome> {
  return withTransaction(async (client): Promise<RefreshOutcome> => {
    await client.query(`SET LOCAL lock_timeout = '${REFRESH_LOCK_TIMEOUT}'`);
    const r = await client.query<{ oauth: ChatgptCredential }>("SELECT oauth FROM admin.llm_providers WHERE id = $1 FOR UPDATE", [accountId]);
    const c = r.rows[0]?.oauth;
    if (!c?.refresh_token) throw new Error("This ChatGPT account is not signed in.");
    if (c.status === "reauth_required") return { kind: "terminal", code: c.last_error || "reauth_required" };
    // Another process may have refreshed while we waited for the lock.
    if (c.access_token && c.expires_at - REFRESH_SKEW_MS > Date.now()) return { kind: "token", token: c.access_token };
    let t: Record<string, unknown>;
    try {
      t = await postForm(TOKEN_URL, { grant_type: "refresh_token", refresh_token: c.refresh_token, client_id: c.client_id, resource: RESOURCE }, REFRESH_TIMEOUT_MS);
    } catch (exc) {
      const code = (exc as { code?: string }).code ?? "";
      if (TERMINAL.includes(code)) {
        // Persisted by returning (COMMIT), not by throwing (ROLLBACK).
        await client.query("UPDATE admin.llm_providers SET oauth = $2::jsonb WHERE id = $1", [accountId, JSON.stringify({ ...c, status: "reauth_required", last_error: code })]);
        return { kind: "terminal", code };
      }
      // Network / transient: keep the credential (OpenAI: never erase on temporary failures).
      throw exc;
    }
    const accessToken = typeof t.access_token === "string" ? t.access_token.trim() : "";
    const rotated = typeof t.refresh_token === "string" && t.refresh_token ? t.refresh_token : c.refresh_token;
    if (!accessToken) {
      // Keep a rotated refresh token (the old one is now spent — reusing it
      // would revoke the sign-in) but never store or hand out an empty bearer:
      // the credential stays expired so the next call refreshes again.
      await client.query("UPDATE admin.llm_providers SET oauth = $2::jsonb WHERE id = $1", [
        accountId,
        JSON.stringify({ ...c, refresh_token: rotated, expires_at: 0, last_error: "refresh_without_access_token" }),
      ]);
      return { kind: "no_access_token" };
    }
    const next: ChatgptCredential = {
      ...c,
      access_token: accessToken,
      refresh_token: rotated,
      id_token: String(t.id_token ?? c.id_token),
      expires_at: Date.now() + (Number(t.expires_in) > 0 ? Number(t.expires_in) : 3600) * 1000,
      scope: String(t.scope ?? c.scope),
      status: "ok",
      last_error: undefined,
    };
    await client.query("UPDATE admin.llm_providers SET oauth = $2::jsonb WHERE id = $1", [accountId, JSON.stringify(next)]);
    return { kind: "token", token: next.access_token };
  });
}
