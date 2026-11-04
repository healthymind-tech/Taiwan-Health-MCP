/**
 * Items the corpus release simulation found the jar rejecting and the TS validator releasing (0 errors, fully checked),
 * and what that showed about neighbouring classes.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { InstanceValidator, completenessOf, type Issue } from "./fhirValidator.js";
import { FakeResolver, PAT_PROFILE } from "./fhirTestKit.test.js";

const errs = async (r: Record<string, any>, resolver: FakeResolver = new FakeResolver()): Promise<Array<[string, string]>> =>
  (await new InstanceValidator(resolver).validate(r, { profiles: [] }))
    .filter((i: Issue) => i.severity === "error" || i.severity === "fatal")
    .map((i: Issue) => [i.path, i.message]);
const obs = (extra: Record<string, any>): Record<string, any> => ({ resourceType: "Observation", status: "final", code: { text: "x" }, subject: { reference: "Patient/p" }, ...extra });

test("a JSON null beside a shadow is the parser's error, no element (JsonParser.parseChildPrimitiveInstance l. 712-714)", async () => {
  const e = await errs(obs({ status: null, _status: { extension: [{ url: "http://hl7.org/fhir/StructureDefinition/data-absent-reason", valueCode: "unknown" }] } }));
  assert.ok(e.some(([p, m]) => p === "Observation.status" && m === "This property must be a simple value, not a Null (status at Observation.status)"), JSON.stringify(e));
});

test("example URLs: only absolute ones (validator_cli 7.0.1, evaluator corpus)", async () => {
  const id = (system: string): Record<string, any> => ({ resourceType: "Patient", identifier: [{ system, value: "1" }] });
  assert.ok((await errs(id("http://example.org/ids"))).some(([, m]) => m.startsWith("Example URLs are not allowed")));
  assert.ok(!(await errs(id("www.example.org"))).some(([, m]) => m.startsWith("Example URLs are not allowed")));
});

// ROUND 9 (evaluator): the jar only warns, so checked_fully stays true; extended_findings counts it as no-local-data.
test("a code system neither held nor on the server's list: the jar's warning, fully checked", async () => {
  const r = obs({ code: { coding: [{ system: "http://other.org/cs", code: "x", display: "y" }] } });
  const issues = (await new InstanceValidator(new FakeResolver()).validate(r, { profiles: [] })) as unknown as Array<Record<string, any>>;
  assert.ok(issues.some((i) => i.severity === "warning" && i.message === "A definition for CodeSystem 'http://other.org/cs' could not be found, so the code cannot be validated"));
  assert.equal(completenessOf(issues).codes_unchecked, undefined);
});

// StandAloneValidatorFetcher.resolveURL l. 220-225: a url under the canonical of a loaded package resolves only through
// what is loaded
test("a uri under a loaded package's canonical that nothing loaded defines: No definition could be found", async () => {
  class Owned extends FakeResolver {
    async definitionExists(): Promise<boolean> {
      return true;
    }
    async closureOwnedUrl(url: string): Promise<boolean | null> {
      return url.startsWith("http://hl7.org/fhir/uv/ig1/") ? url.endsWith("/CodeSystem/held") : null;
    }
  }
  const pat = (system: string): Record<string, any> => ({ resourceType: "Patient", identifier: [{ system, value: "1" }] });
  const missing = await errs(pat("http://hl7.org/fhir/uv/ig1/CodeSystem/example-only"), new Owned());
  assert.ok(missing.some(([p, m]) => p === "Patient.identifier[0].system" && m === "No definition could be found for URL value 'http://hl7.org/fhir/uv/ig1/CodeSystem/example-only'"), JSON.stringify(missing));
  assert.deepEqual(await errs(pat("http://hl7.org/fhir/uv/ig1/CodeSystem/held"), new Owned()), []);
  assert.deepEqual(await errs(pat("http://hl7.org/fhir/uv/other/CodeSystem/x"), new Owned()), []);
});

// validateResource l. 9002-9012 + checkContainedReferences l. 9062-9095: a Bundle validated against a profile of its first
// entry's type, that entry with contained resources — validator_cli 7.0.1 throws (official-crash), so never a pass
test("Bundle validated as its first entry's profile, the entry holding contained resources: the jar's crash is an error", async () => {
  const b = {
    resourceType: "Bundle",
    type: "collection",
    entry: [{ fullUrl: "urn:uuid:7f3c2a8e-0d1b-4c55-9a51-2b6f0e4d9c10", resource: { resourceType: "Patient", contained: [{ resourceType: "Organization", id: "o1", name: "x" }], managingOrganization: { reference: "#o1" } } }],
  };
  const issues = await new InstanceValidator(new FakeResolver()).validate(b, { profiles: [PAT_PROFILE] });
  assert.ok(issues.some((i) => i.severity === "error" && i.message === 'Cannot invoke "java.util.Set.contains(Object)" because "baseRefs" is null'), JSON.stringify(issues));
  const plain = { ...b, entry: [{ ...b.entry[0], resource: { resourceType: "Patient" } }] };
  assert.ok(!(await new InstanceValidator(new FakeResolver()).validate(plain, { profiles: [PAT_PROFILE] })).some((i) => i.message.includes("baseRefs")));
});

// checkContainedReferences l. 9062-9081: element.getChildrenByName("contained") — a Bundle has no such element (the
// parser drops the property as unrecognized), so there is no dom-3 check on it
test("a contained array on a Bundle is no contained resource (no dom-3 orphan error)", async () => {
  const b = { resourceType: "Bundle", type: "collection", contained: [{ resourceType: "Organization", id: "o1", name: "x" }] };
  const issues = await new InstanceValidator(new FakeResolver()).validate(b, { profiles: [] });
  assert.ok(!issues.some((i) => i.message.includes("is not referenced to from elsewhere")), JSON.stringify(issues));
  const p = { resourceType: "Patient", contained: [{ resourceType: "Organization", id: "o1", name: "x" }] };
  assert.ok((await new InstanceValidator(new FakeResolver()).validate(p, { profiles: [] })).some((i) => i.message.includes("is not referenced to from elsewhere")));
});

// InstanceValidator.checkSpecials l. 7249-7250: the jar runs StructureMapValidator on every StructureMap; not ported here
test("a StructureMap is never fully checked (StructureMapValidator is not ported)", async () => {
  const SM = "http://hl7.org/fhir/StructureDefinition/StructureMap";
  class WithMap extends FakeResolver {
    override async fetchStructureDefinition(url: string): Promise<Record<string, any> | null> {
      if (url.split("|")[0] !== SM) return super.fetchStructureDefinition(url);
      const e = (id: string, min: number, max: string, code?: string): Record<string, any> => ({ id, path: id, min, max, base: { path: id, min, max }, ...(code ? { type: [{ code }] } : {}) });
      return { resourceType: "StructureDefinition", url: SM, type: "StructureMap", kind: "resource", snapshot: { element: [e("StructureMap", 0, "*"), e("StructureMap.status", 1, "1", "code")] } };
    }
  }
  const issues = (await new InstanceValidator(new WithMap()).validate({ resourceType: "StructureMap", status: "draft" }, { profiles: [] })) as unknown as Array<Record<string, any>>;
  assert.deepEqual(completenessOf(issues).rules_unchecked, ["StructureMapValidator"]);
});

// ParametersValidator.validateParameter l. 186-191: PARAM_RULES (Map.ofEntries).get(null) throws for a parameter without
// a name value — validator_cli 7.0.1 crashes (official-crash), so never a pass
test("a Parameters resource with an unnamed parameter: the jar's crash is an error", async () => {
  const PM = "http://hl7.org/fhir/StructureDefinition/Parameters";
  class WithParams extends FakeResolver {
    override async fetchStructureDefinition(url: string): Promise<Record<string, any> | null> {
      if (url.split("|")[0] !== PM) return super.fetchStructureDefinition(url);
      const e = (id: string, min: number, max: string, code?: string): Record<string, any> => ({ id, path: id, min, max, base: { path: id, min, max }, ...(code ? { type: [{ code }] } : {}) });
      return { resourceType: "StructureDefinition", url: PM, type: "Parameters", kind: "resource", snapshot: { element: [e("Parameters", 0, "*"), e("Parameters.parameter", 0, "*", "BackboneElement"), e("Parameters.parameter.name", 1, "1", "string"), e("Parameters.parameter.value[x]", 0, "1", "string")] } };
    }
  }
  const msg = 'Cannot invoke "Object.hashCode()" because "pk" is null';
  const v = async (p: any[]): Promise<string[]> => (await new InstanceValidator(new WithParams()).validate({ resourceType: "Parameters", parameter: p }, { profiles: [] })).map((i) => i.message);
  assert.ok((await v([{ valueString: "x", _name: { extension: [{ url: "http://hl7.org/fhir/StructureDefinition/data-absent-reason", valueCode: "unknown" }] } }])).includes(msg));
  assert.ok(!(await v([{ name: "a", valueString: "x" }])).includes(msg));
});

// checkCodeOnServer passes the working language: a display the server would judge in that language and the resolver
// cannot is a rules_unchecked note (never a pass on the English names)
test("a display the resolver cannot judge in the working language is rules_unchecked", async () => {
  class Lang extends FakeResolver {
    override async checkCode(system: string, code: string, display: string | null, _v?: string | null, langs?: string[]): Promise<any> {
      if (system === "http://loinc.org") return langs && langs[0] === "de-CH" && display !== null ? { status: "display-unchecked", message: "x", rule: "tx: http://loinc.org display in de-CH" } : { status: "ok" };
      return super.checkCode(system, code, display);
    }
  }
  const r = obs({ language: "de-CH", code: { coding: [{ system: "http://loinc.org", code: "8867-4", display: "Heart rate" }] } });
  const issues = (await new InstanceValidator(new Lang()).validate(r, { profiles: [] })) as unknown as Array<Record<string, any>>;
  assert.deepEqual(completenessOf(issues).rules_unchecked, ["tx: http://loinc.org display in de-CH"]);
});
