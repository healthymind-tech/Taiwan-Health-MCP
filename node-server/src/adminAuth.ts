/**
 * Admin console auth/session helpers.
 *
 * Faithful port of the auth surface in `src/admin_html_shell.py`:
 * `verify_admin_password`, `build_admin_session_token`,
 * `parse_admin_session_token`, `build_admin_session_cookie`,
 * `clear_admin_session_cookie`. The session token format and signature must be
 * **byte-identical** to the Python implementation so existing browser sessions
 * remain valid across the cutover.
 *
 * Token layout: `<b64url(json_payload)>.<hex_hmac_sha256(b64url, secret)>`
 * where payload = `{"u": username, "exp": <unix_seconds>}` serialized with
 * Python `json.dumps(..., ensure_ascii=False, separators=(",", ":"))`.
 */

import crypto from "node:crypto";

export const SESSION_COOKIE_NAME = "tw_health_admin_session";

/** base64url without padding (mirrors Python `base64.urlsafe_b64encode().rstrip("=")`). */
function b64urlEncode(data: Buffer): string {
  return data.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Inverse of `b64urlEncode` — re-pads before decoding. */
function b64urlDecode(data: string): Buffer {
  const pad = "=".repeat((4 - (data.length % 4)) % 4);
  const std = data.replace(/-/g, "+").replace(/_/g, "/") + pad;
  return Buffer.from(std, "base64");
}

/** Constant-time hex/string compare, mirroring `hmac.compare_digest`. */
function compareDigest(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf-8");
  const bb = Buffer.from(b, "utf-8");
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * Verify an admin password against a supported stored-hash format.
 * Supported:
 *   - `sha256$<hex_digest>`
 *   - `pbkdf2_sha256$<iterations>$<salt>$<hex_digest>`
 */
export function verifyAdminPassword(password: string, storedHash: string): boolean {
  if (!storedHash) return false;
  if (storedHash.startsWith("sha256$")) {
    const expected = storedHash.slice("sha256$".length).trim().toLowerCase();
    const actual = crypto.createHash("sha256").update(password, "utf-8").digest("hex").toLowerCase();
    return compareDigest(actual, expected);
  }
  if (storedHash.startsWith("pbkdf2_sha256$")) {
    // Python: stored_hash.split("$", 3) → exactly 4 parts (digest may contain no "$").
    const parts = storedHash.split("$");
    if (parts.length !== 4) return false;
    const iterationsText = parts[1];
    const salt = parts[2];
    const expected = parts[3];
    // Python int(iterations_text): strict integer parse, else ValueError → False.
    if (!/^[+-]?\d+$/.test(iterationsText.trim())) return false;
    const iterations = Number.parseInt(iterationsText, 10);
    const derived = crypto
      .pbkdf2Sync(Buffer.from(password, "utf-8"), Buffer.from(salt, "utf-8"), iterations, 32, "sha256")
      .toString("hex");
    return compareDigest(derived.toLowerCase(), expected.trim().toLowerCase());
  }
  return false;
}

/** Serialize a payload object the way Python `json.dumps(..., separators=(",", ":"))` does. */
function compactJson(payload: { u: string; exp: number }): string {
  // Keys are emitted in insertion order (u, then exp), matching the Python dict literal.
  return `{"u":${JSON.stringify(payload.u)},"exp":${payload.exp}}`;
}

function hmacHex(secret: string, message: string): string {
  return crypto.createHmac("sha256", Buffer.from(secret, "utf-8")).update(message, "utf-8").digest("hex");
}

/** Build a signed admin session token. */
export function buildAdminSessionToken(
  username: string,
  secret: string,
  opts: { now?: Date; ttlMinutes?: number } = {},
): string {
  const now = opts.now ?? new Date();
  const ttlMinutes = opts.ttlMinutes ?? 240;
  const exp = Math.trunc(now.getTime() / 1000 + ttlMinutes * 60);
  const encoded = b64urlEncode(Buffer.from(compactJson({ u: username, exp }), "utf-8"));
  const signature = hmacHex(secret, encoded);
  return `${encoded}.${signature}`;
}

/** Return the authenticated admin username if the token is valid, else null. */
export function parseAdminSessionToken(
  token: string | null | undefined,
  secret: string,
  opts: { now?: Date } = {},
): string | null {
  if (!token || !token.includes(".")) return null;
  // Python: encoded, signature = token.rsplit(".", 1)
  const idx = token.lastIndexOf(".");
  const encoded = token.slice(0, idx);
  const signature = token.slice(idx + 1);
  const expected = hmacHex(secret, encoded);
  if (!compareDigest(signature, expected)) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(b64urlDecode(encoded).toString("utf-8"));
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) return null;
  const exp = (payload as Record<string, unknown>).exp;
  const username = (payload as Record<string, unknown>).u;
  // Python: isinstance(exp, int). JSON booleans are not numbers in JS, so the
  // integer check below is sufficient.
  if (typeof exp !== "number" || !Number.isInteger(exp) || typeof username !== "string") return null;
  const now = opts.now ?? new Date();
  if (now.getTime() / 1000 >= exp) return null;
  return username;
}

/** Set-Cookie header value for the admin session. */
export function buildAdminSessionCookie(
  token: string,
  maxAgeSeconds: number,
  secure = false,
): string {
  return `${SESSION_COOKIE_NAME}=${token}; Path=/admin; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

/** Set-Cookie header value that removes the admin session. */
export function clearAdminSessionCookie(secure = false): string {
  return `${SESSION_COOKIE_NAME}=; Path=/admin; Max-Age=0; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

/** Parse a Cookie request header into a name→value map. */
export function parseCookieHeader(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name) out[name] = value;
  }
  return out;
}
