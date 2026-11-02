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

test("empty object: 'Object must have some content' + ele-1, a choice element at the parser's [x] path, and its required children are still checked", async () => {
  // fhir-test-cases validator/outcomes/java/R5.list-empty1-json-base.json (List.entry[0] = {}): OBJECT_MUST_HAVE_SOME_CONTENT,
  // ele-1 and List.entry.item min 1 on the same element; a choice element `{}` too: validator_cli 7.0.1 single runs
  // (empd Bundle-bun-ds__legacy__037) and the corpus report `...dose[x]` + ele-1 at `dose.ofType(Quantity)`
  const e = await errs(obs({ valueQuantity: {}, component: [{}] }));
  assert.ok(e.some(([p, m]) => p === "Observation.value[x]" && m === "Object must have some content"), JSON.stringify(e));
  assert.ok(e.some(([p, m]) => p === "Observation.component[0]" && m === "Object must have some content"));
  assert.ok(e.some(([p, m]) => p === "Observation.component[0]" && /component\.code: minimum required = 1/u.test(m)), "validation continues into the empty element");
  assert.ok(e.some(([p, m]) => p === "Observation.component[0]" && /^Constraint failed: ele-1/u.test(m)), "ele-1 on the empty component");
  assert.ok(e.some(([p, m]) => p === "Observation.valueQuantity" && /ele-1/u.test(m)), "ele-1 on the empty choice element");
  // one ele-1 per element, not one per profile pass
  assert.equal(e.filter(([p, m]) => p === "Observation.component[0]" && /ele-1/u.test(m)).length, 1);
});

test("wrong JSON type: the parse error plus the type's value error (validation goes on)", async () => {
  const e = await errs(obs({ valueQuantity: { value: "notatype" } }));
  // JsonParser reports at its npath: a choice element by its property name (parseChildPrimitiveInstance, logError npath)
  assert.ok(e.some(([p, m]) => p === "Observation.value[x].value" && m === "Error parsing JSON: the primitive value must be a number"), JSON.stringify(e));
  assert.ok(e.some(([p, m]) => p === "Observation.valueQuantity.value" && m === "The value 'notatype' is not a valid decimal"));
  // a number where a string is expected is read as its text
  const s = await errs(obs({ code: { text: 5 } }));
  assert.deepEqual(s.filter(([p]) => p === "Observation.code.text").map(([, m]) => m), ["Error parsing JSON: the primitive value must be a string"]);
});

test("meta.profile with an unresolved example URL: TYPE_SPECIFIC_CHECKS_DT_URL_EXAMPLE (validateReference canonical branch)", async () => {
  // InstanceValidator.checkPrimitive l. 3412-3418 → validateReference l. 3986-3998; the profile is also unknown (warning)
  // the kit has no Meta datatype: a minimal one (Meta.profile: canonical)
  class WithMeta extends FakeResolver {
    override async fetchStructureDefinition(url: string): Promise<Record<string, any> | null> {
      if (url.split("|")[0] !== "http://hl7.org/fhir/StructureDefinition/Meta") return super.fetchStructureDefinition(url);
      const el = (path: string, max: string, type?: string): Record<string, any> => ({ id: path, path, min: 0, max, base: { path, min: 0, max }, ...(type ? { type: [{ code: type }] } : {}) });
      return { resourceType: "StructureDefinition", url, name: "Meta", type: "Meta", kind: "complex-type", derivation: "specialization", snapshot: { element: [el("Meta", "*"), el("Meta.profile", "*", "canonical")] } };
    }
  }
  const errsMeta = async (r: Record<string, any>): Promise<Array<[string, string]>> =>
    (await new InstanceValidator(new WithMeta()).validate(r, { profiles: [] })).filter((i: Issue) => i.severity === "error").map((i: Issue) => [i.path, i.message]);
  const e = await errsMeta(obs({ meta: { profile: ["http://example.org/fhir/StructureDefinition/unknown"] } }));
  assert.ok(e.some(([p, m]) => p === "Observation.meta.profile[0]" && m === "Example URLs are not allowed in this context (http://example.org/fhir/StructureDefinition/unknown)"), JSON.stringify(e));
  // a non-example unknown profile stays a warning only
  const f = await errsMeta(obs({ meta: { profile: ["http://other.org/fhir/StructureDefinition/unknown"] } }));
  assert.ok(!f.some(([p]) => p === "Observation.meta.profile[0]"), JSON.stringify(f));

  // A repeating primitive item without a value whose shadow holds only an id: ele-1 (hasValue() false, the id is the
  // only child). Evaluator corpus, validator_cli 7.0.1: name.prefix [x, null] + _prefix [null, {id}] → ele-1 at
  // prefix[1]; on meta.profile validator_cli throws (official-crash) — an error is required all the same.
  const g = await errsMeta(obs({ meta: { profile: ["http://other.org/p", null], _profile: [null, { id: "x1" }] } }));
  assert.deepEqual(
    g.filter(([p]) => p === "Observation.meta.profile[1]").map(([, m]) => m),
    ["Constraint failed: ele-1: 'All FHIR elements must have a @value or children' (defined in http://hl7.org/fhir/StructureDefinition/Element)"],
    JSON.stringify(g),
  );
  // a shadow with an extension is a legal value-less primitive
  const h = await errsMeta(obs({ meta: { profile: ["http://other.org/p", null], _profile: [null, { extension: [{ url: "http://hl7.org/fhir/StructureDefinition/data-absent-reason", valueCode: "unknown" }] }] } }));
  assert.ok(!h.some(([p, m]) => p === "Observation.meta.profile[1]" && /ele-1/u.test(m)), JSON.stringify(h));
});

test("a primitive choice of the wrong JSON type: the parser's path names value[x], the validator's the typed element", async () => {
  const e = await errs(obs({ valueBoolean: "notatype" }));
  assert.ok(e.some(([p, m]) => p === "Observation.value[x]" && m === "Error parsing JSON: the primitive value must be a boolean"), JSON.stringify(e));
  assert.ok(!e.some(([p, m]) => p === "Observation.valueBoolean" && m.startsWith("Error parsing JSON")), JSON.stringify(e));
});
