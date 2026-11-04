/**
 * Items the corpus release simulation found the jar rejecting and the TS validator releasing (0 errors, fully checked),
 * and what that showed about neighbouring classes.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { InstanceValidator, completenessOf, type Issue } from "./fhirValidator.js";
import { FakeResolver } from "./fhirTestKit.test.js";

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
// what is loaded — an IG example (package/example, never loaded) does not count
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
