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

test("a code system nothing here holds: the jar's warning, and not fully checked unless an installed IG owns the namespace", async () => {
  class Ns extends FakeResolver {
    constructor(private readonly own: boolean) {
      super();
    }
    async systemInIgNamespace(): Promise<boolean> {
      return this.own;
    }
  }
  const r = obs({ code: { coding: [{ system: "http://other.org/cs", code: "x", display: "y" }] } });
  const run = async (own: boolean): Promise<string[] | undefined> => completenessOf((await new InstanceValidator(new Ns(own)).validate(r, { profiles: [] })) as unknown as Array<Record<string, any>>).codes_unchecked;
  assert.deepEqual(await run(false), ["http://other.org/cs"]);
  assert.equal(await run(true), undefined);
});
