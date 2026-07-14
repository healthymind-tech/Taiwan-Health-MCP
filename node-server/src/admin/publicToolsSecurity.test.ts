import assert from "node:assert/strict";
import test from "node:test";
import {
  allowedCorsOrigin,
  bearerTokenMatches,
  resolvePublicToolsSecurity,
} from "../publicToolsSecurity.js";

test("public tools security preserves open local defaults", () => {
  assert.deepEqual(resolvePublicToolsSecurity("", "", ""), {
    authMode: "none",
    bearerToken: "",
    corsOrigins: ["*"],
  });
});

test("bearer mode requires a token and explicit CORS origins", () => {
  assert.throws(() => resolvePublicToolsSecurity("bearer", "", ""));
  assert.throws(() => resolvePublicToolsSecurity("bearer", "secret", "*"));
  assert.deepEqual(resolvePublicToolsSecurity("bearer", "secret", "https://one.example, https://two.example/"), {
    authMode: "bearer",
    bearerToken: "secret",
    corsOrigins: ["https://one.example", "https://two.example"],
  });
});

test("bearer and CORS checks match only exact configured values", () => {
  assert.equal(bearerTokenMatches("Bearer secret", "secret"), true);
  assert.equal(bearerTokenMatches("bearer wrong", "secret"), false);
  assert.equal(bearerTokenMatches(undefined, "secret"), false);
  assert.equal(allowedCorsOrigin("https://one.example/", ["https://one.example"]), "https://one.example");
  assert.equal(allowedCorsOrigin("https://other.example", ["https://one.example"]), null);
});
