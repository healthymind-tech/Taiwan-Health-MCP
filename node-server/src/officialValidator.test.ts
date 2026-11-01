/**
 * v18 R1 / parity v2 — the resident official validator client (officialValidator.ts): configuration, OperationOutcome
 * mapping, request shape, concurrency limit and the down-marking that lets callers fall back quickly.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { OFFICIAL_SOURCE, OfficialUnavailable, OfficialValidator, issuesFromOutcome, parseOfficialConfig } from "./officialValidator.js";

const OO = {
  resourceType: "OperationOutcome",
  issue: [
    {
      extension: [{ url: "http://hl7.org/fhir/StructureDefinition/operationoutcome-message-id", valueCode: "Unrecognized_property" }],
      severity: "error",
      code: "structure",
      details: { text: "Unrecognized property 'valueCodeableConcept'" },
      expression: ["Bundle.entry[6].resource.supportingInfo[2]"],
    },
    { severity: "warning", code: "invalid", diagnostics: "a warning", location: ["Bundle"] },
  ],
};

test("config: package[#version]=url list; mode defaults to prefer with endpoints, off without", () => {
  const c = parseOfficialConfig({ OFFICIAL_VALIDATOR_URLS: "tw.gov.mohw.nhi.pas#1.2.7=http://v-pas:18081/, hl7.fhir.uv.ips=http://v-ips:18082" });
  assert.deepEqual(c.endpoints, [
    { packageId: "tw.gov.mohw.nhi.pas", version: "1.2.7", url: "http://v-pas:18081" },
    { packageId: "hl7.fhir.uv.ips", version: null, url: "http://v-ips:18082" },
  ]);
  assert.equal(c.mode, "prefer");
  assert.equal(parseOfficialConfig({}).mode, "off");
  assert.equal(parseOfficialConfig({ OFFICIAL_VALIDATOR_URLS: "a=http://x", OFFICIAL_VALIDATOR_MODE: "require" }).mode, "require");
  const v = new OfficialValidator(c);
  assert.equal(v.endpointFor("tw.gov.mohw.nhi.pas", "1.2.7"), "http://v-pas:18081");
  assert.equal(v.endpointFor("tw.gov.mohw.nhi.pas", "1.2.6"), null, "a pinned version serves only that version");
  assert.equal(v.endpointFor("hl7.fhir.uv.ips", "2.0.0"), "http://v-ips:18082");
  assert.equal(new OfficialValidator(parseOfficialConfig({ OFFICIAL_VALIDATOR_URLS: "a=http://x", OFFICIAL_VALIDATOR_MODE: "off" })).endpointFor("a", "1"), null);
});

test("OperationOutcome → MCP issues (first expression as path, message id kept)", () => {
  assert.deepEqual(issuesFromOutcome(OO), [
    { severity: "error", path: "Bundle.entry[6].resource.supportingInfo[2]", code: "structure", message: "Unrecognized property 'valueCodeableConcept'", message_id: "Unrecognized_property", source: OFFICIAL_SOURCE },
    { severity: "warning", path: "Bundle", code: "invalid", message: "a warning", source: OFFICIAL_SOURCE },
  ]);
  assert.throws(() => issuesFromOutcome({ resourceType: "Bundle" }));
});

test("request: POST /validateResource?profile=… with the resource as FHIR JSON", async () => {
  const seen: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
  const v = new OfficialValidator(parseOfficialConfig({ OFFICIAL_VALIDATOR_URLS: "p=http://v:1" }), async (url, init) => {
    seen.push({ url, body: init.body, headers: init.headers });
    return { ok: true, status: 200, json: async () => OO };
  });
  const issues = await v.validate("http://v:1", { resourceType: "Bundle" }, "http://x/StructureDefinition/B");
  assert.equal(issues.length, 2);
  assert.equal(seen[0].url, "http://v:1/validateResource?profile=http%3A%2F%2Fx%2FStructureDefinition%2FB");
  assert.equal(seen[0].body, '{"resourceType":"Bundle"}');
  assert.equal(seen[0].headers["Content-Type"], "application/fhir+json");
});

test("a failing validator is marked down for 30 s (fast fallback), then tried again", async () => {
  let t = 1_000;
  let calls = 0;
  const v = new OfficialValidator(
    parseOfficialConfig({ OFFICIAL_VALIDATOR_URLS: "p=http://v:1" }),
    async () => {
      calls++;
      return { ok: false, status: 500, json: async () => ({}) };
    },
    () => t,
  );
  await assert.rejects(v.validate("http://v:1", {}, null), OfficialUnavailable);
  await assert.rejects(v.validate("http://v:1", {}, null), /marked down/);
  assert.equal(calls, 1);
  t += 31_000;
  await assert.rejects(v.validate("http://v:1", {}, null), /HTTP 500/);
  assert.equal(calls, 2);
});

test("at most `concurrency` requests in flight per validator", async () => {
  let inflight = 0;
  let peak = 0;
  const v = new OfficialValidator(parseOfficialConfig({ OFFICIAL_VALIDATOR_URLS: "p=http://v:1", OFFICIAL_VALIDATOR_CONCURRENCY: "2" }), async () => {
    inflight++;
    peak = Math.max(peak, inflight);
    await new Promise((r) => setTimeout(r, 10));
    inflight--;
    return { ok: true, status: 200, json: async () => OO };
  });
  await Promise.all([1, 2, 3, 4, 5].map(() => v.validate("http://v:1", {}, null)));
  assert.equal(peak, 2);
});
