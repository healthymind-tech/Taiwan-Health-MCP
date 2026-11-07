/**
 * v18 R1 / parity v2 — the resident official validator client (officialValidator.ts): configuration, OperationOutcome
 * mapping, request shape, concurrency limit and the down-marking that lets callers fall back quickly.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { OFFICIAL_SOURCE, OfficialUnavailable, OfficialValidator, isTransientTxIssue, issuesFromOutcome, parseOfficialConfig } from "./officialValidator.js";

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
  const r = await v.validate("http://v:1", { resourceType: "Bundle" }, "http://x/StructureDefinition/B");
  assert.equal(r.issues.length, 2);
  assert.deepEqual(r.unverified, []);
  // v20.2: validator_cli's own per-request time limit (request timeout − 30 s by default)
  assert.equal(seen[0].url, "http://v:1/validateResource?validationTimeout=90000&profile=http%3A%2F%2Fx%2FStructureDefinition%2FB");
  assert.equal(seen[0].body, '{"resourceType":"Bundle"}');
  assert.equal(seen[0].headers["Content-Type"], "application/fhir+json");
});

test("an unreachable validator is marked down for 15 s (fast fallback); a timeout is not", async () => {
  let t = 1_000;
  let calls = 0;
  const v = new OfficialValidator(
    parseOfficialConfig({ OFFICIAL_VALIDATOR_URLS: "p=http://v:1" }),
    async () => {
      calls++;
      throw new TypeError("fetch failed");
    },
    () => t,
  );
  await assert.rejects(v.validate("http://v:1", {}, null), OfficialUnavailable);
  await assert.rejects(v.validate("http://v:1", {}, null), /not reachable/);
  assert.equal(calls, 1);
  t += 16_000;
  await assert.rejects(v.validate("http://v:1", {}, null), /fetch failed/);
  assert.equal(calls, 2);
  // timeout: explicit error, the validator is not marked down
  let n = 0;
  const slow = new OfficialValidator(parseOfficialConfig({ OFFICIAL_VALIDATOR_URLS: "p=http://v:1", OFFICIAL_VALIDATOR_TIMEOUT_MS: "20" }), (_u, init) => {
    n++;
    return new Promise((_res, rej) => init.signal.addEventListener("abort", () => rej(new Error("This operation was aborted"))));
  });
  await assert.rejects(slow.validate("http://v:1", {}, null), /did not answer within/);
  await assert.rejects(slow.validate("http://v:1", {}, null), /did not answer within/);
  assert.equal(n, 2, "a timeout does not mark the validator down");
});

test("terminology-server failures are returned apart as unverified, and the validator is restarted once (cached failure)", async () => {
  assert.ok(isTransientTxIssue({ message: "Error from https://tx.fhir.org/r4: java.net.SocketTimeoutException: Read timed out" }));
  assert.ok(isTransientTxIssue({ message: "Validation process exceeded maximum allowed time of 90000ms, set by http-query. Returned validation messages may be incomplete or inaccurate." }));
  assert.ok(!isTransientTxIssue({ message: "Unknown code 'ZZZ-9' in the CodeSystem 'http://loinc.org' version '2.81'" }));
  const seen: string[] = [];
  const oo = { resourceType: "OperationOutcome", issue: [...OO.issue, { severity: "error", code: "exception", details: { text: "java.net.SocketTimeoutException: Connect timed out" }, expression: ["Bundle.entry[1].resource.code"] }] };
  let t = 0;
  const v = new OfficialValidator(
    parseOfficialConfig({ OFFICIAL_VALIDATOR_URLS: "p=http://v:1" }),
    async (url) => {
      seen.push(url.replace("http://v:1", ""));
      return { ok: true, status: 200, json: async () => oo };
    },
    () => t,
    async (ms) => {
      t += ms;
    },
  );
  const r = await v.validate("http://v:1", {}, null);
  assert.equal(r.issues.length, 2);
  assert.deepEqual(r.unverified.map((i) => i.path), ["Bundle.entry[1].resource.code"]);
  await v.validate("http://v:1", {}, null); // waits for the restart, no second restart within 10 minutes
  assert.deepEqual(seen.filter((u) => u === "/stop").length, 1);
  assert.ok(seen.indexOf("/version") > seen.indexOf("/stop"), "waited for the validator to answer again");
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

test("validator_cli's off-by-one entry index in reachable / Can't find messages is corrected through the quoted fullUrl / reference", async () => {
  const { relocateBundleIssues } = await import("./officialValidator.js");
  const u = (n: number): string => `urn:uuid:00000000-0000-4000-8000-00000000000${n}`;
  const b = {
    resourceType: "Bundle",
    type: "document",
    entry: [
      { fullUrl: u(0), resource: { resourceType: "Composition" } },
      { fullUrl: u(1), resource: { resourceType: "MedicationStatement", medicationReference: { reference: u(8) }, subject: { reference: u(9) } } },
      { fullUrl: u(2), resource: { resourceType: "AllergyIntolerance", patient: { reference: u(9) } } },
    ],
  };
  const issues: Array<Record<string, any>> = [
    { severity: "error", path: "Bundle.entry[2]", message: `Entry '${u(1)}' isn't reachable by traversing links (forward or backward) from the Composition` },
    { severity: "error", path: "Bundle", message: `Can't find '${u(8)}' in the bundle (Bundle.entry[0].resource.medication[x])` },
    { severity: "error", path: "Bundle", message: `Can't find '${u(9)}' in the bundle (Bundle.entry[1].resource.patient)` },
    { severity: "error", path: "Bundle.entry[1].resource", message: "something else" },
  ];
  relocateBundleIssues(b, issues);
  assert.deepEqual(
    issues.map((i) => i.location_path ?? null),
    ["Bundle.entry[1]", "Bundle.entry[1].resource.medicationReference", "Bundle.entry[2].resource.patient", null],
  );
  assert.equal(issues[0].path, "Bundle.entry[2]", "the official path is kept");
});

test("BundleValidator's fullUrl rules (all reported at Bundle.entry[0]) are located through the quoted fullUrl", async () => {
  const { relocateBundleIssues } = await import("./officialValidator.js");
  const b = {
    resourceType: "Bundle",
    type: "collection",
    entry: [
      { fullUrl: "http://x.org/fhir/Patient/p1", resource: { resourceType: "Patient", id: "p1" } },
      { fullUrl: "Patient/2", resource: { resourceType: "Patient", id: "2" } },
      { fullUrl: "http://x.org/fhir/Patient/p9", resource: { resourceType: "Patient", id: "p3" } },
    ],
  };
  const issues: Array<Record<string, any>> = [
    { severity: "error", path: "Bundle.entry[0]", message: "The fullUrl must be an absolute URL (not 'Patient/2')" },
    { severity: "error", path: "Bundle.entry[0]", message: "The fullUrl 'http://x.org/fhir/Patient/p9' looks like a RESTful server URL, so it must end with the correct type and id (/Patient/p3)" },
    { severity: "warning", path: "Bundle.entry[4]", message: "Entry 'http://x.org/fhir/Patient/p1' isn't reachable by traversing forwards from the Composition. Only Provenance is approved to be used this way (R4 section 3.3.1)" },
  ];
  relocateBundleIssues(b, issues);
  assert.deepEqual(issues.map((i) => i.location_path ?? null), ["Bundle.entry[1]", "Bundle.entry[2]", "Bundle.entry[0]"]);
});

test("routing: an exact package#version first; else the first configured validator whose IG closure holds that package#version (never by id alone)", async () => {
  const c = parseOfficialConfig({
    OFFICIAL_VALIDATOR_URLS: "tw.gov.mohw.twcore#1.0.0=http://v-twcore:18080,tw.gov.mohw.nhi.pas#1.2.7=http://v-pas:18081,tw.gov.mohw.emr.empd#1.0.0=http://v-empd:18083",
  });
  const closures: Record<string, Array<[string, string]>> = {
    "tw.gov.mohw.twcore#1.0.0": [["tw.gov.mohw.twcore", "1.0.0"], ["hl7.fhir.r4.core", "4.0.1"]],
    "tw.gov.mohw.nhi.pas#1.2.7": [["tw.gov.mohw.nhi.pas", "1.2.7"], ["tw.gov.mohw.twcore", "0.3.2"], ["hl7.fhir.r4.core", "4.0.1"]],
    "tw.gov.mohw.emr.empd#1.0.0": [["tw.gov.mohw.emr.empd", "1.0.0"], ["tw.gov.mohw.twcore", "0.3.2"], ["hl7.fhir.r4.core", "4.0.1"]],
  };
  const asked: string[] = [];
  const closureOf = async (id: string, v: string): Promise<Array<[string, string]>> => {
    asked.push(`${id}#${v}`);
    return closures[`${id}#${v}`] ?? [];
  };
  const v = new OfficialValidator(c);
  // exact match: no closure lookup
  assert.deepEqual(await v.routeFor("tw.gov.mohw.twcore", "1.0.0", closureOf), { url: "http://v-twcore:18080", via: null });
  assert.deepEqual(asked, []);
  // twcore 0.3.2 has no validator of its own: PAS (first in configuration order whose closure holds it), not twcore 1.0.0
  assert.deepEqual(await v.routeFor("tw.gov.mohw.twcore", "0.3.2", closureOf), { url: "http://v-pas:18081", via: "tw.gov.mohw.nhi.pas#1.2.7" });
  // a version no closure holds: none (the id alone does not route)
  assert.equal(await v.routeFor("tw.gov.mohw.twcore", "0.2.0", closureOf), null);
  assert.equal(await v.routeFor("hl7.fhir.uv.ips", "1.1.0", closureOf), null);
  // closures are computed once per validator
  assert.equal(asked.filter((x) => x === "tw.gov.mohw.nhi.pas#1.2.7").length, 1, JSON.stringify(asked));
  // reproducible: the same answer again
  assert.deepEqual(await v.routeFor("tw.gov.mohw.twcore", "0.3.2", closureOf), { url: "http://v-pas:18081", via: "tw.gov.mohw.nhi.pas#1.2.7" });
  // a failed closure lookup is skipped and not cached
  let fail = true;
  const flaky = new OfficialValidator(c);
  const flakyOf = async (id: string, ver: string): Promise<Array<[string, string]>> => {
    if (id === "tw.gov.mohw.nhi.pas" && fail) throw new Error("db down");
    return closures[`${id}#${ver}`] ?? [];
  };
  assert.deepEqual(await flaky.routeFor("tw.gov.mohw.twcore", "0.3.2", flakyOf), { url: "http://v-empd:18083", via: "tw.gov.mohw.emr.empd#1.0.0" });
  fail = false;
  assert.deepEqual(await flaky.routeFor("tw.gov.mohw.twcore", "0.3.2", flakyOf), { url: "http://v-pas:18081", via: "tw.gov.mohw.nhi.pas#1.2.7" });
  // mode off: never routed
  assert.equal(await new OfficialValidator({ ...c, mode: "off" }).routeFor("tw.gov.mohw.twcore", "1.0.0", closureOf), null);
});
