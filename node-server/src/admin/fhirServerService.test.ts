import assert from "node:assert/strict";
import test from "node:test";
import { buildFhirRequestHeaders, resolveFhirServerAuth } from "../fhirServerService.js";

test("FHIR request headers add server-side bearer auth and reject configured overrides", () => {
  const headers = buildFhirRequestHeaders(
    {
      resource_headers_json: {
        Authorization: "Basic attacker-controlled",
        "X-Tenant": "hospital-a",
      },
    },
    "application/fhir+json",
    "oauth-token",
  );

  assert.equal(headers.Authorization, "Bearer oauth-token");
  assert.equal(headers["X-Tenant"], "hospital-a");
  assert.equal(headers["Content-Type"], "application/fhir+json");
});

test("FHIR request headers omit Authorization for no-auth servers", () => {
  const headers = buildFhirRequestHeaders({ resource_headers_json: {} }, "", "");
  assert.equal(headers.Authorization, undefined);
  assert.equal(headers["Content-Type"], undefined);
});

test("FHIR OAuth auth resolution uses the configured grant flow", async () => {
  const calls: string[] = [];
  const dependencies = {
    fetchPrivateServer: async (_id: string, _secret: string) => ({
      fhir_server_id: "server-id",
      auth_type: "oauth2_client_credentials",
      client_secret: "decrypted",
    }),
    clientCredentialsToken: async (_server: Record<string, unknown>, strategy: string) => {
      calls.push(`cc:${strategy}`);
      return "cc-token";
    },
    userAccessToken: async (_server: Record<string, unknown>, secret: string) => {
      calls.push(`ac:${secret}`);
      return "ac-token";
    },
  };

  const cc = await resolveFhirServerAuth(
    { fhir_server_id: "server-id", auth_type: "oauth2_client_credentials" },
    "cached",
    "key",
    dependencies,
  );
  assert.equal(cc.accessToken, "cc-token");

  const ac = await resolveFhirServerAuth(
    { fhir_server_id: "server-id", auth_type: "oauth2_authorization_code" },
    "fresh",
    "key",
    dependencies,
  );
  assert.equal(ac.accessToken, "ac-token");
  assert.deepEqual(calls, ["cc:cached", "ac:key"]);
});
