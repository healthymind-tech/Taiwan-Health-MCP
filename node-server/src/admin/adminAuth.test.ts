import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAdminSessionCookie,
  clearAdminSessionCookie,
  hashAdminPassword,
  verifyAdminPassword,
} from "../adminAuth.js";
import { resolveAdminCookieSecure } from "../config.js";

test("admin session cookies include Secure when enabled", () => {
  assert.match(buildAdminSessionCookie("token", 60, true), /; Secure$/);
  assert.match(clearAdminSessionCookie(true), /; Secure$/);
  assert.doesNotMatch(buildAdminSessionCookie("token", 60), /; Secure/);
});

test("admin cookie security defaults from the public origin", () => {
  assert.equal(resolveAdminCookieSecure("", "https://example.com"), true);
  assert.equal(resolveAdminCookieSecure("", "http://localhost:8080"), false);
  assert.equal(resolveAdminCookieSecure("false", "https://example.com"), false);
  assert.equal(resolveAdminCookieSecure("true", "http://localhost:8080"), true);
  assert.throws(() => resolveAdminCookieSecure("maybe", "https://example.com"));
});

test("admin password hashes round-trip without storing the plaintext", () => {
  const hash = hashAdminPassword("a sufficiently long password");
  assert.match(hash, /^pbkdf2_sha256\$310000\$/);
  assert.equal(hash.includes("sufficiently long"), false);
  assert.equal(verifyAdminPassword("a sufficiently long password", hash), true);
  assert.equal(verifyAdminPassword("wrong password", hash), false);
});

test("session cookie name: default, override, and invalid characters rejected", async () => {
  const { resolveSessionCookieName } = await import("../adminAuth.js");
  assert.equal(resolveSessionCookieName(undefined), "tw_health_admin_session");
  assert.equal(resolveSessionCookieName("  "), "tw_health_admin_session");
  assert.equal(resolveSessionCookieName("tw_health_admin_session_staging"), "tw_health_admin_session_staging");
  assert.throws(() => resolveSessionCookieName("bad name;"), /ADMIN_SESSION_COOKIE/);
});
