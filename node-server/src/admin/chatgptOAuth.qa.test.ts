/**
 * QA: "Sign in with ChatGPT" — ID-token verification against a fake JWKS, and
 * the access-token refresh under a row lock, run against a fake pg pool that
 * models BEGIN/COMMIT/ROLLBACK and SELECT … FOR UPDATE. No network, no Postgres.
 */

process.env.DATABASE_URL ??= "postgresql://qa:qa@127.0.0.1:1/qa";

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { initPool } from "../db.js";
import { getChatgptAccessToken, verifyIdToken, type ChatgptCredential } from "./chatgptOAuth.js";
import { setProfileStatsEnabled } from "./llmProfileStats.js";
import { callAnalysisLlm } from "../analysisLlmClient.js";
import { resetBreakers, type LlmProfile } from "./llmProfiles.js";

setProfileStatsEnabled(false);

const ISSUER = "https://auth.openai.com";
const CLIENT = "oaiapp_test";
const NONCE = "n0nce";

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...(publicKey.export({ format: "jwk" }) as Record<string, string>), kid: "k1", alg: "RS256", use: "sig" };

const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function jwt(claims: Record<string, unknown>, header: Record<string, unknown> = { alg: "RS256", kid: "k1" }, key = privateKey): string {
  const h = b64u(JSON.stringify(header));
  const p = b64u(JSON.stringify(claims));
  const sig = header.alg === "none" ? "" : b64u(crypto.sign("RSA-SHA256", Buffer.from(`${h}.${p}`), key));
  return `${h}.${p}.${sig}`;
}
const good = (over: Record<string, unknown> = {}) => ({ iss: ISSUER, aud: CLIENT, exp: Math.floor(Date.now() / 1000) + 600, nonce: NONCE, sub: "u1", email: "a@b.c", ...over });

const realFetch = globalThis.fetch;
let tokenEndpoint: (form: URLSearchParams) => Promise<Response> = async () => new Response("{}", { status: 500 });
let jwksFetches = 0;
let tokenCalls = 0;
let chatBodies: Record<string, unknown>[] = [];
let chatReply: () => Response = () => new Response("", { status: 500 });
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  if (url.endsWith("/.well-known/jwks.json")) {
    jwksFetches += 1;
    return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
  }
  if (url.endsWith("/oauth/token")) {
    tokenCalls += 1;
    return tokenEndpoint(new URLSearchParams(String(init?.body)));
  }
  if (url.endsWith("/v1/responses")) {
    chatBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return chatReply();
  }
  return realFetch(input, init);
}) as typeof fetch;

// ── verifyIdToken ────────────────────────────────────────────────────────────

test("verifyIdToken: a valid RS256 token passes; aud may be an array", async () => {
  assert.equal((await verifyIdToken(jwt(good()), CLIENT, NONCE)).sub, "u1");
  assert.equal((await verifyIdToken(jwt(good({ aud: ["other", CLIENT] })), CLIENT, NONCE)).sub, "u1");
});

test("verifyIdToken: alg none / HS256 rejected before any key lookup", async () => {
  await assert.rejects(verifyIdToken(jwt(good(), { alg: "none", kid: "k1" }), CLIENT, NONCE), /Unexpected ID token algorithm: none/);
  await assert.rejects(verifyIdToken(jwt(good(), { alg: "HS256", kid: "k1" }), CLIENT, NONCE), /HS256/);
});

test("verifyIdToken: missing / unknown kid → refetch JWKS once, then 'unknown key'", async () => {
  await verifyIdToken(jwt(good()), CLIENT, NONCE); // warm cache
  const before = jwksFetches;
  await assert.rejects(verifyIdToken(jwt(good(), { alg: "RS256" }), CLIENT, NONCE), /unknown key/);
  assert.equal(jwksFetches - before, 1, "forced refresh on a cache miss");
});

test("verifyIdToken: wrong signature key, wrong issuer, wrong audience, nonce mismatch, expired", async () => {
  const other = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  await assert.rejects(verifyIdToken(jwt(good(), undefined, other), CLIENT, NONCE), /signature is invalid/);
  await assert.rejects(verifyIdToken(jwt(good({ iss: "https://evil" })), CLIENT, NONCE), /issuer mismatch/);
  await assert.rejects(verifyIdToken(jwt(good({ aud: ["x", "y"] })), CLIENT, NONCE), /audience/);
  await assert.rejects(verifyIdToken(jwt(good({ nonce: "zzz" })), CLIENT, NONCE), /nonce/);
  await assert.rejects(verifyIdToken(jwt(good({ exp: Math.floor(Date.now() / 1000) - 120 })), CLIENT, NONCE), /expired/);
  await assert.rejects(verifyIdToken(jwt(good({ exp: String(Math.floor(Date.now() / 1000) + 600) })), CLIENT, NONCE), /expired/, "string exp rejected");
});

test("verifyIdToken: 60 s clock-skew leeway on exp", async () => {
  await verifyIdToken(jwt(good({ exp: Math.floor(Date.now() / 1000) - 30 })), CLIENT, NONCE);
});

test("verifyIdToken: malformed token (2 parts / bad base64 JSON) is rejected", async () => {
  await assert.rejects(verifyIdToken("a.b", CLIENT, NONCE), /malformed/);
  await assert.rejects(verifyIdToken("!!!.b.c", CLIENT, NONCE));
});

// ── fake pool with row-lock + transaction semantics ─────────────────────────

const row: { provider: string; oauth: ChatgptCredential | null } = { provider: "chatgpt", oauth: null };
let lock: Promise<void> | null = null;
const lockWaits: number[] = [];
const pool = initPool();
(pool as unknown as { query: unknown }).query = async (sql: string) => {
  if (/SELECT oauth, provider FROM admin\.llm_providers/.test(sql)) return { rows: [{ oauth: structuredClone(row.oauth), provider: row.provider }] };
  return { rows: [] };
};
(pool as unknown as { connect: unknown }).connect = async () => {
  let pending: ChatgptCredential | null = null;
  let release: (() => void) | null = null;
  return {
    async query(sql: string, params: unknown[] = []) {
      if (sql === "BEGIN") return { rows: [] };
      if (/FOR UPDATE/.test(sql)) {
        const t0 = Date.now();
        while (lock) await lock;
        lockWaits.push(Date.now() - t0);
        let r!: () => void;
        lock = new Promise<void>((res) => (r = res));
        release = () => {
          lock = null;
          r();
        };
        return { rows: [{ oauth: structuredClone(row.oauth) }] };
      }
      if (/^UPDATE admin\.llm_providers SET oauth/.test(sql)) {
        pending = JSON.parse(String(params[1])) as ChatgptCredential;
        return { rows: [] };
      }
      if (sql === "COMMIT") {
        if (pending) row.oauth = pending;
        release?.();
        return { rows: [] };
      }
      if (sql === "ROLLBACK") {
        pending = null;
        release?.();
        return { rows: [] };
      }
      return { rows: [] };
    },
    release() {},
  };
};

function cred(over: Partial<ChatgptCredential> = {}): ChatgptCredential {
  return {
    client_id: CLIENT, host_id: "urn:uuid:x", id_token: "", access_token: "at-old", refresh_token: "rt-1", expires_at: Date.now() - 1000,
    scope: "chatgpt.tokens.use.direct", sub: "u1", email: "a@b.c", connected_by: "admin", connected_at: "", status: "ok", ...over,
  };
}

beforeEach(() => {
  tokenCalls = 0;
  lock = null;
  lockWaits.length = 0;
  chatBodies = [];
  resetBreakers();
});
afterEach(() => {
  tokenEndpoint = async () => new Response("{}", { status: 500 });
});

test("access token: still fresh → returned without any refresh", async () => {
  row.oauth = cred({ expires_at: Date.now() + 3_600_000, access_token: "at-fresh" });
  assert.equal(await getChatgptAccessToken(1), "at-fresh");
  assert.equal(tokenCalls, 0);
});

test("access token: expired → refresh, rotated refresh_token persisted", async () => {
  row.oauth = cred();
  tokenEndpoint = async (f) => {
    assert.equal(f.get("refresh_token"), "rt-1");
    return new Response(JSON.stringify({ access_token: "at-2", refresh_token: "rt-2", expires_in: 3600 }), { status: 200 });
  };
  assert.equal(await getChatgptAccessToken(1), "at-2");
  assert.equal(row.oauth!.refresh_token, "rt-2");
  assert.equal(row.oauth!.status, "ok");
});

test("access token: two concurrent callers → exactly one refresh (in-process single flight)", async () => {
  row.oauth = cred();
  tokenEndpoint = async () => {
    await new Promise((r) => setTimeout(r, 150));
    return new Response(JSON.stringify({ access_token: "at-3", refresh_token: "rt-3", expires_in: 3600 }), { status: 200 });
  };
  const [a, b] = await Promise.all([getChatgptAccessToken(1), getChatgptAccessToken(1)]);
  assert.deepEqual([a, b], ["at-3", "at-3"]);
  assert.equal(tokenCalls, 1, "refresh token rotated once — no reuse");
  // The second caller shares the in-flight refresh instead of queueing a pooled
  // connection on the row lock for the whole HTTP call.
  assert.equal(lockWaits.length, 1, `row lock taken ${lockWaits.length}×`);
});

test(
  "a terminal refresh error (invalid_grant) persists status=reauth_required",
  async () => {
    row.oauth = cred();
    tokenEndpoint = async () => new Response(JSON.stringify({ error: "invalid_grant", error_description: "revoked" }), { status: 400 });
    await assert.rejects(getChatgptAccessToken(1), /no longer valid \(invalid_grant\)/);
    assert.equal(row.oauth!.status, "reauth_required", `status after terminal error: ${row.oauth!.status}`);
    await assert.rejects(getChatgptAccessToken(1));
    assert.equal(tokenCalls, 1, `token endpoint hit ${tokenCalls}× with a revoked refresh token`);
  },
);

test("access token: transient refresh failure (HTTP 503 HTML) keeps the credential unchanged", async () => {
  row.oauth = cred();
  tokenEndpoint = async () => new Response("<html>503</html>", { status: 503 });
  await assert.rejects(getChatgptAccessToken(1), /http_503/);
  assert.equal(row.oauth!.refresh_token, "rt-1");
  assert.equal(row.oauth!.status, "ok");
});

test(
  "a refresh reply without access_token is rejected instead of storing/returning an empty bearer",
  async () => {
    row.oauth = cred();
    tokenEndpoint = async () => new Response(JSON.stringify({ refresh_token: "rt-9", expires_in: 3600 }), { status: 200 });
    const t = await getChatgptAccessToken(1).catch(() => "rejected");
    assert.notEqual(t, "", "empty access token returned");
    assert.equal(row.oauth!.access_token, "at-old", "no empty bearer stored");
    assert.equal(row.oauth!.refresh_token, "rt-9", "the rotated refresh token is kept (the old one is spent)");
  },
);

test("not signed in / reauth_required → clear errors without a token call", async () => {
  row.oauth = null;
  await assert.rejects(getChatgptAccessToken(1), /not signed in/);
  row.oauth = cred({ status: "reauth_required" });
  await assert.rejects(getChatgptAccessToken(1), /sign in again/);
  assert.equal(tokenCalls, 0);
});

// ── ChatGPT through the analysis client ──────────────────────────────────────

test(
  "ChatGPT 'incomplete' replies are not re-sent with an identical body by budget escalation",
  async () => {
    row.oauth = cred({ expires_at: Date.now() + 3_600_000 });
    chatReply = () =>
      new Response(`data: ${JSON.stringify({ type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" }, usage: {} } })}\n\n`, { status: 200 });
    const p: LlmProfile = { id: 501, kind: "analysis", name: "cg", provider: "chatgpt", base_url: "https://api.openai.com/v1", api_key: "", model: "gpt-6-luna", enabled: true, priority: 0, weight: 1, params: {}, account_id: 1 };
    await callAnalysisLlm([p], [{ role: "user", content: "x" }]).catch(() => undefined);
    const distinct = new Set(chatBodies.map((b) => JSON.stringify(b))).size;
    assert.equal(chatBodies.length, distinct, `${chatBodies.length} calls, ${distinct} distinct bodies`);
  },
);
