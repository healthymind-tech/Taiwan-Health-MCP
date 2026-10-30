/**
 * v17 (ISSUES_v17 R1 self-check of newly installed IGs): (1) a `type` discriminator with a path
 * (Bundle.entry sliced by type:resource) is matched on the type of the element the path names
 * (entry:x.resource), not the sliced element's own BackboneElement type; (2) an embedded resource
 * whose element lists several type profiles conforms when it meets ONE of them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { InstanceValidator } from "./fhirValidator.js";
import { FakeResolver, SDS, el, sd } from "./fhirTestKit.test.js";

const EX = "http://example.tw/fhir/StructureDefinition/";
const BUNDLE = `${EX}msg-bundle`;
const ORG_A = `${EX}org-a`;
const ORG_B = `${EX}org-b`;
const ORG = "http://hl7.org/fhir/StructureDefinition/Organization";

const org = (url: string, name: string): Record<string, any> =>
  sd(url, "Organization", "resource", [el("Organization", 0, "*"), el("Organization.id", 0, "1", ["id"]), el("Organization.meta", 0, "1", ["Meta"]), el("Organization.name", 1, "1", ["string"], { patternString: name })], { baseDefinition: ORG });
SDS[ORG_A] = org(ORG_A, "A");
SDS[ORG_B] = org(ORG_B, "B");
SDS[BUNDLE] = sd(BUNDLE, "Bundle", "resource", [
  el("Bundle", 0, "*"),
  el("Bundle.id", 0, "1", ["id"]),
  el("Bundle.meta", 0, "1", ["Meta"]),
  el("Bundle.type", 1, "1", ["code"]),
  el("Bundle.entry", 2, "*", ["BackboneElement"], { slicing: { discriminator: [{ type: "type", path: "resource" }], rules: "closed" } }),
  el("Bundle.entry.fullUrl", 0, "1", ["uri"]),
  el("Bundle.entry.resource", 0, "1", ["Resource"]),
  el("Bundle.entry:patient", 1, "1", ["BackboneElement"]),
  el("Bundle.entry:patient.fullUrl", 0, "1", ["uri"]),
  el("Bundle.entry:patient.resource", 1, "1", [], { type: [{ code: "Patient" }] }),
  el("Bundle.entry:org", 1, "1", ["BackboneElement"]),
  el("Bundle.entry:org.fullUrl", 0, "1", ["uri"]),
  el("Bundle.entry:org.resource", 1, "1", [], { type: [{ code: "Organization", profile: [ORG_A, ORG_B] }] }),
], { baseDefinition: "http://hl7.org/fhir/StructureDefinition/Bundle" });

const bundle = (orgName: string): Record<string, any> => ({
  resourceType: "Bundle",
  meta: { profile: [BUNDLE] },
  type: "collection",
  entry: [
    { fullUrl: "urn:uuid:00000000-0000-4000-8000-000000000001", resource: { resourceType: "Patient" } },
    { fullUrl: "urn:uuid:00000000-0000-4000-8000-000000000002", resource: { resourceType: "Organization", name: orgName } },
  ],
});
const errors = async (b: Record<string, any>): Promise<string[]> =>
  ((await new InstanceValidator(new FakeResolver()).validate(b, { profiles: [BUNDLE] })) as any[]).filter((i) => i.severity === "error").map((i) => `${i.path} | ${i.message}`);

test("v17: entries sliced by type:resource match on the resource type; a resource meeting one of several type profiles conforms", async () => {
  assert.deepEqual(await errors(bundle("A")), []);
  assert.deepEqual(await errors(bundle("B")), [], "org-b is one of the choices");
  const bad = await errors(bundle("C"));
  assert.ok(bad.length > 0 && bad.every((e) => !/a matching slice is required/.test(e)), bad.join("\n"));
});
