import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "./config.js";

/**
 * Guards the NaN class of misconfiguration.
 *
 * `Number.parseInt("abc")` is NaN, and NaN slips through the two guards that
 * look like they would stop it: `??` only catches null/undefined, and
 * `Math.max(NaN, 1)` returns NaN rather than the floor. A bad integer therefore
 * used to reach runtime and break something unrelated — a non-numeric
 * ADMIN_SESSION_TTL_MINUTES made the session token's `exp` serialise as invalid
 * JSON, so login returned 200 and every later request was silently
 * unauthenticated. These tests pin the loud-failure behaviour instead.
 */

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(vars)) {
    saved.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const BASE = { DATABASE_URL: "postgresql://u@localhost:5432/db" };

test("integer settings reject non-numeric values instead of yielding NaN", () => {
  for (const name of [
    "ADMIN_SESSION_TTL_MINUTES",
    "ADMIN_MAX_UPLOAD_MB",
    "METRICS_PORT",
    "MCP_PORT",
  ]) {
    assert.throws(
      () => withEnv({ ...BASE, [name]: "abc" }, loadConfig),
      new RegExp(`${name} must be an integer`),
      `${name} should refuse a non-numeric value`,
    );
  }
});

test("integer settings reject fractional and out-of-range values", () => {
  assert.throws(
    () => withEnv({ ...BASE, ADMIN_MAX_UPLOAD_MB: "1.5" }, loadConfig),
    /ADMIN_MAX_UPLOAD_MB must be an integer/,
  );
  assert.throws(
    () => withEnv({ ...BASE, ADMIN_SESSION_TTL_MINUTES: "0" }, loadConfig),
    /ADMIN_SESSION_TTL_MINUTES must be >= 1/,
  );
});

test("blank or unset integer settings fall back to their defaults", () => {
  const unset = withEnv(
    {
      ...BASE,
      ADMIN_SESSION_TTL_MINUTES: undefined,
      ADMIN_MAX_UPLOAD_MB: undefined,
      METRICS_PORT: undefined,
      MCP_PORT: undefined,
    },
    loadConfig,
  );
  assert.equal(unset.adminSessionTtlMinutes, 240);
  assert.equal(unset.adminMaxUploadMb, 512);
  assert.equal(unset.metricsPort, 9090);
  assert.equal(unset.port, 8000);

  const blank = withEnv({ ...BASE, ADMIN_SESSION_TTL_MINUTES: "  " }, loadConfig);
  assert.equal(blank.adminSessionTtlMinutes, 240);
});

test("ADMIN_ENABLED accepts the usual boolean spellings and rejects junk", () => {
  for (const on of ["true", "TRUE", "1", "yes", "on", " True "]) {
    assert.equal(withEnv({ ...BASE, ADMIN_ENABLED: on }, loadConfig).adminEnabled, true, on);
  }
  for (const off of ["false", "0", "no", "off"]) {
    assert.equal(withEnv({ ...BASE, ADMIN_ENABLED: off }, loadConfig).adminEnabled, false, off);
  }
  assert.throws(
    () => withEnv({ ...BASE, ADMIN_ENABLED: "maybe" }, loadConfig),
    /ADMIN_ENABLED must be a boolean/,
  );
});

test("the admin console is on by default", () => {
  // A fresh install must be able to reach /admin: it is the only way to import
  // any data. Credentials are still required — adminReady() gates that
  // separately, so defaulting to on cannot open an unauthenticated console.
  const cfg = withEnv({ ...BASE, ADMIN_ENABLED: undefined }, loadConfig);
  assert.equal(cfg.adminEnabled, true);
});

test("the served transport is fixed, not taken from the environment", () => {
  // main() starts the HTTP listener unconditionally, so MCP_TRANSPORT never
  // selected anything. It must not silently downgrade the reported transport.
  const cfg = withEnv({ ...BASE, MCP_TRANSPORT: "stdio" }, loadConfig);
  assert.equal(cfg.transport, "streamable-http");
});
