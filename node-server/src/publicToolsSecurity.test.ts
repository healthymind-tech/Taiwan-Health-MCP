import { test } from "node:test";
import assert from "node:assert/strict";
import { publicOrigin } from "./publicToolsSecurity.js";

test("publicOrigin prefers PUBLIC_BASE_URL (trailing slash trimmed)", () => {
  assert.equal(publicOrigin("https://mcp.example.org/", { host: "internal:8000", "x-forwarded-proto": "http" }, "http"), "https://mcp.example.org");
});

test("publicOrigin falls back to forwarded proto + Host", () => {
  assert.equal(publicOrigin("", { host: "mcp.example.org", "x-forwarded-proto": "https, http" }, "http"), "https://mcp.example.org");
  assert.equal(publicOrigin("  ", { host: "localhost:8080" }, "http"), "http://localhost:8080");
  assert.equal(publicOrigin("", {}, "http"), "");
});
