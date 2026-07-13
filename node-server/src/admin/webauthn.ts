/**
 * WebAuthn / passkey support for admin login (additional to the password).
 *
 * Encapsulates the full FIDO2 ceremony + credential storage using
 * `@simplewebauthn/server` (v13). Passkeys are scoped to the configured RP ID
 * (`config().webauthnRpId`) and only usable over HTTPS on that origin (or
 * localhost for dev) — the browser enforces the secure-context requirement.
 *
 * Storage: `admin.webauthn_credentials` (created idempotently on first use).
 *
 * Challenge handling is stateless: `generate*Options` signs the ceremony
 * challenge into a short-lived HttpOnly cookie (`tw_health_admin_webauthn`)
 * using the same HMAC construction as the session token in `adminAuth.ts`, and
 * `finish*` reads it back. No server-side challenge store is needed.
 */

import crypto from "node:crypto";
import type { Request } from "express";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
} from "@simplewebauthn/server";

import { config } from "../config.js";
import { query, withTransaction } from "../db.js";
import { parseCookieHeader } from "../adminAuth.js";

export const CHALLENGE_COOKIE_NAME = "tw_health_admin_webauthn";
const CHALLENGE_TTL_SECONDS = 300;

// ── Types ────────────────────────────────────────────────────────────────────

export interface StoredCredentialRow {
  credential_id: string;
  public_key: Buffer;
  counter: string | number;
  transports: string[] | null;
}

export interface CredentialSummary {
  id: string;
  label: string | null;
  created_at: string;
  last_used_at: string | null;
}

type ChallengeType = "reg" | "auth";
interface ChallengePayload {
  c: string; // base64url challenge
  t: ChallengeType;
  u: string; // username the ceremony is bound to
  exp: number; // unix seconds
}

// ── Challenge cookie (stateless, HMAC-signed) ─────────────────────────────────

function b64urlEncode(data: Buffer): string {
  return data.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(data: string): Buffer {
  const pad = "=".repeat((4 - (data.length % 4)) % 4);
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}
function hmacHex(secret: string, message: string): string {
  return crypto.createHmac("sha256", Buffer.from(secret, "utf-8")).update(message, "utf-8").digest("hex");
}
function compareDigest(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf-8");
  const bb = Buffer.from(b, "utf-8");
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** Set-Cookie value carrying the signed ceremony challenge. */
export function buildChallengeCookie(payload: Omit<ChallengePayload, "exp">): string {
  const secret = config().adminSessionSecret;
  const full: ChallengePayload = { ...payload, exp: Math.trunc(Date.now() / 1000) + CHALLENGE_TTL_SECONDS };
  const encoded = b64urlEncode(Buffer.from(JSON.stringify(full), "utf-8"));
  const token = `${encoded}.${hmacHex(secret, encoded)}`;
  return `${CHALLENGE_COOKIE_NAME}=${token}; Path=/admin; Max-Age=${CHALLENGE_TTL_SECONDS}; HttpOnly; SameSite=Lax`;
}

/** Set-Cookie value that clears the challenge cookie (single-use ceremonies). */
export function clearChallengeCookie(): string {
  return `${CHALLENGE_COOKIE_NAME}=; Path=/admin; Max-Age=0; HttpOnly; SameSite=Lax`;
}

/** Verify + decode the challenge cookie, enforcing type and expiry. */
export function readChallengeCookie(
  req: Request,
  expectType: ChallengeType,
): ChallengePayload | null {
  const raw = parseCookieHeader(req.headers.cookie)[CHALLENGE_COOKIE_NAME];
  if (!raw || !raw.includes(".")) return null;
  const idx = raw.lastIndexOf(".");
  const encoded = raw.slice(0, idx);
  const signature = raw.slice(idx + 1);
  if (!compareDigest(signature, hmacHex(config().adminSessionSecret, encoded))) return null;
  let payload: ChallengePayload;
  try {
    payload = JSON.parse(b64urlDecode(encoded).toString("utf-8")) as ChallengePayload;
  } catch {
    return null;
  }
  if (!payload || typeof payload.c !== "string" || payload.t !== expectType) return null;
  if (typeof payload.exp !== "number" || Date.now() / 1000 >= payload.exp) return null;
  return payload;
}

// ── Storage ───────────────────────────────────────────────────────────────────

/** Create the credential table if it does not exist (schema.sql only runs on a fresh DB). */
export async function ensureCredentialTable(): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS admin.webauthn_credentials (
          credential_id  TEXT PRIMARY KEY,
          username       TEXT NOT NULL,
          public_key     BYTEA NOT NULL,
          counter        BIGINT NOT NULL DEFAULT 0,
          transports     TEXT[],
          label          TEXT,
          created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_used_at   TIMESTAMPTZ
      )
    `);
    await client.query(
      "CREATE INDEX IF NOT EXISTS idx_admin_webauthn_credentials_user ON admin.webauthn_credentials (username)",
    );
  });
}

async function storedCredentials(username: string): Promise<StoredCredentialRow[]> {
  const res = await query<StoredCredentialRow>(
    "SELECT credential_id, public_key, counter, transports FROM admin.webauthn_credentials WHERE username = $1",
    [username],
  );
  return res.rows;
}

/** Public list for the Settings page (no key material). */
export async function listCredentials(username: string): Promise<CredentialSummary[]> {
  await ensureCredentialTable();
  const res = await query<CredentialSummary>(
    `SELECT credential_id AS id, label,
            to_char(created_at,   'YYYY-MM-DD"T"HH24:MI:SSOF') AS created_at,
            to_char(last_used_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') AS last_used_at
       FROM admin.webauthn_credentials
      WHERE username = $1
      ORDER BY created_at DESC`,
    [username],
  );
  return res.rows;
}

/** Delete one credential owned by `username`. Returns true if a row was removed. */
export async function deleteCredential(username: string, credentialId: string): Promise<boolean> {
  await ensureCredentialTable();
  const res = await query(
    "DELETE FROM admin.webauthn_credentials WHERE username = $1 AND credential_id = $2",
    [username, credentialId],
  );
  return (res.rowCount ?? 0) > 0;
}

// ── Registration ceremony ─────────────────────────────────────────────────────

export async function beginRegistration(
  username: string,
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  await ensureCredentialTable();
  const cfg = config();
  const existing = await storedCredentials(username);
  return generateRegistrationOptions({
    rpName: cfg.webauthnRpName,
    rpID: cfg.webauthnRpId,
    userName: username,
    userID: new Uint8Array(Buffer.from(username, "utf-8")),
    attestationType: "none",
    excludeCredentials: existing.map((c) => ({
      id: c.credential_id,
      transports: (c.transports ?? undefined) as AuthenticatorTransportFuture[] | undefined,
    })),
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "preferred",
    },
  });
}

export async function finishRegistration(
  username: string,
  response: RegistrationResponseJSON,
  expectedChallenge: string,
  label: string | null,
): Promise<CredentialSummary> {
  const cfg = config();
  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: cfg.webauthnOrigins,
    expectedRPID: cfg.webauthnRpId,
    requireUserVerification: false,
  });
  if (!verification.verified || !verification.registrationInfo) {
    throw new Error("Passkey registration could not be verified.");
  }
  const { credential } = verification.registrationInfo;
  await query(
    `INSERT INTO admin.webauthn_credentials
        (credential_id, username, public_key, counter, transports, label)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (credential_id) DO UPDATE
        SET public_key = EXCLUDED.public_key,
            counter    = EXCLUDED.counter,
            transports = EXCLUDED.transports`,
    [
      credential.id,
      username,
      Buffer.from(credential.publicKey),
      credential.counter,
      credential.transports ?? null,
      (label && label.trim()) || null,
    ],
  );
  const [summary] = await listCredentials(username);
  return summary;
}

// ── Authentication ceremony ───────────────────────────────────────────────────

export async function beginAuthentication(
  username: string,
): Promise<PublicKeyCredentialRequestOptionsJSON> {
  await ensureCredentialTable();
  const cfg = config();
  const existing = await storedCredentials(username);
  return generateAuthenticationOptions({
    rpID: cfg.webauthnRpId,
    userVerification: "preferred",
    allowCredentials: existing.map((c) => ({
      id: c.credential_id,
      transports: (c.transports ?? undefined) as AuthenticatorTransportFuture[] | undefined,
    })),
  });
}

/**
 * Verify an authentication assertion for `username`, bumping the stored counter
 * on success. Returns true when the passkey is valid.
 */
export async function finishAuthentication(
  username: string,
  response: AuthenticationResponseJSON,
  expectedChallenge: string,
): Promise<boolean> {
  const cfg = config();
  const rows = await storedCredentials(username);
  const match = rows.find((r) => r.credential_id === response.id);
  if (!match) return false;

  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: cfg.webauthnOrigins,
    expectedRPID: cfg.webauthnRpId,
    requireUserVerification: false,
    credential: {
      id: match.credential_id,
      publicKey: new Uint8Array(match.public_key),
      counter: Number(match.counter),
      transports: (match.transports ?? undefined) as AuthenticatorTransportFuture[] | undefined,
    },
  });
  if (!verification.verified) return false;

  await query(
    "UPDATE admin.webauthn_credentials SET counter = $1, last_used_at = NOW() WHERE credential_id = $2",
    [verification.authenticationInfo.newCounter, match.credential_id],
  );
  return true;
}
