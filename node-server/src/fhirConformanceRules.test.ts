/**
 * SearchParameterValidator / ImplementationGuideValidator ports (validator_cli 7.0.1). Expected texts are the
 * Messages.properties entries; the SearchParameter cases follow fhir-test-cases sp-diff-type / sp-diff-base.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateImplementationGuide, validateSearchParameter, type ConformanceRuleDeps } from "./fhirConformanceRules.js";

const ORG_NAME = "http://hl7.org/fhir/SearchParameter/Organization-name";
const deps: ConformanceRuleDeps = {
  fetchSearchParameter: async (u) => (u === ORG_NAME ? { url: u, base: ["Organization"], type: "string", expression: "Organization.name" } : null),
  parentType: async (t) => ({ Patient: "DomainResource", Organization: "DomainResource", DomainResource: "Resource" })[t] ?? null,
};

test("derivedFrom: the base must be listed by the parent and the type must match", async () => {
  const out = await validateSearchParameter({ code: "x", base: ["Patient"], type: "token", derivedFrom: ORG_NAME }, "SearchParameter", deps);
  assert.deepEqual(
    out.map((i) => [i.severity, i.message]),
    [
      ["error", `The resource type Patient is not listed as a base in the SearchParameter this is derived from (${ORG_NAME})`],
      ["error", `The type string is different to the type ${ORG_NAME} in the derivedFrom SearchParameter`],
    ],
  );
});

test("expression: a type name opening a union leg must be a base or an ancestor of one", async () => {
  const bad = await validateSearchParameter({ base: ["Patient"], type: "string", expression: "Organization.name | Organization.alias" }, "SearchParameter", deps);
  assert.equal(bad.length, 1);
  assert.equal(bad[0].path, "SearchParameter.expression");
  assert.equal(
    bad[0].message,
    "Error in search expression 'Organization.name | Organization.alias': Error evaluating FHIRPath expression: The name 'Organization' is not valid for any of the possible types: [http://hl7.org/fhir/StructureDefinition/Patient] (@char 1)",
  );
  const second = await validateSearchParameter({ base: ["Patient"], type: "string", expression: "Patient.name | Organization.alias" }, "SearchParameter", deps);
  assert.match(second[0].message, /\(@char 16\)$/);
  assert.deepEqual(await validateSearchParameter({ base: ["Patient"], type: "string", expression: "Patient.name | (DomainResource.id) | name.where(use = 'a|b')" }, "SearchParameter", deps), []);
});

test("an unknown derivedFrom is a warning, a composite needs two components", async () => {
  const out = await validateSearchParameter({ base: ["Patient"], type: "composite", component: [{}], derivedFrom: "http://example.org/none" }, "SearchParameter", deps);
  assert.deepEqual(out.map((i) => i.severity), ["warning", "error"]);
});

test("a base for another FHIR version is skipped", async () => {
  const out = await validateSearchParameter(
    {
      base: ["Patient", "DeviceUsage"],
      _base: [null, { extension: [{ url: "http://hl7.org/fhir/StructureDefinition/version-specific-use", extension: [{ url: "startFhirVersion", valueCode: "5.0" }] }] }],
      type: "string",
      expression: "Patient.name",
    },
    "SearchParameter",
    deps,
  );
  assert.deepEqual(out, []);
});

test("HL7 implementation guides state their status and workgroup; other guides do not have to", () => {
  const hl7 = validateImplementationGuide({ url: "http://hl7.org/fhir/uv/x/ImplementationGuide/x", fhirVersion: ["4.0.1"] }, "ImplementationGuide");
  assert.deepEqual(hl7.map((i) => i.severity), ["error", "error", "warning"]);
  assert.deepEqual(validateImplementationGuide({ url: "http://example.org/ig", fhirVersion: ["4.0.1"] }, "ImplementationGuide"), []);
});

test("dependsOn: the rules that read only the resource", () => {
  const out = validateImplementationGuide(
    { url: "http://example.org/ig", fhirVersion: ["4.0.1"], dependsOn: [{ uri: "http://example.org/x|1.0.0", version: "2.0.0", packageId: "bad" }] },
    "ImplementationGuide",
  );
  assert.ok(out.every((i) => i.path === "ImplementationGuide.dependsOn[0]"));
  assert.deepEqual(
    out.map((i) => i.message.split(" ").slice(0, 3).join(" ")),
    ["The canonical URL", "The URL should", "The packageId bad"],
  );
});
