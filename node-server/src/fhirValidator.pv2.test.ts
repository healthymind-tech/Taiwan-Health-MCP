/**
 * parity v2 (held-out mutations vs validator_cli 7.0.1) on the built-in fallback validator: an empty object
 * (JsonParser.checkObject) and a primitive of the wrong JSON type (JsonParser.parseChildPrimitiveInstance keeps the
 * value; the InstanceValidator checks it as the element's type).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { InstanceValidator, type Issue } from "./fhirValidator.js";
import { FakeResolver } from "./fhirTestKit.test.js";

const errs = async (r: Record<string, any>): Promise<Array<[string, string]>> =>
  (await new InstanceValidator(new FakeResolver()).validate(r, { profiles: [] }))
    .filter((i: Issue) => i.severity === "error" || i.severity === "fatal")
    .map((i: Issue) => [i.path, i.message]);
const obs = (extra: Record<string, any>): Record<string, any> => ({ resourceType: "Observation", status: "final", code: { text: "x" }, subject: { reference: "Patient/p" }, ...extra });

test("empty object: 'Object must have some content', no ele-1, and its required children are still checked", async () => {
  const e = await errs(obs({ valueQuantity: {}, component: [{}] }));
  assert.ok(e.some(([p, m]) => p === "Observation.valueQuantity" && m === "Object must have some content"), JSON.stringify(e));
  assert.ok(e.some(([p, m]) => p === "Observation.component[0]" && m === "Object must have some content"));
  assert.ok(e.some(([p, m]) => p === "Observation.component[0]" && /component\.code: minimum required = 1/u.test(m)), "validation continues into the empty element");
  assert.ok(!e.some(([, m]) => /ele-1/u.test(m)), "no ele-1 on top");
});

test("wrong JSON type: the parse error plus the type's value error (validation goes on)", async () => {
  const e = await errs(obs({ valueQuantity: { value: "notatype" } }));
  assert.ok(e.some(([p, m]) => p === "Observation.valueQuantity.value" && m === "Error parsing JSON: the primitive value must be a number"), JSON.stringify(e));
  assert.ok(e.some(([p, m]) => p === "Observation.valueQuantity.value" && m === "The value 'notatype' is not a valid decimal"));
  // a number where a string is expected is read as its text
  const s = await errs(obs({ code: { text: 5 } }));
  assert.deepEqual(s.filter(([p]) => p === "Observation.code.text").map(([, m]) => m), ["Error parsing JSON: the primitive value must be a string"]);
});
