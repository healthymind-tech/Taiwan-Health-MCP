/**
 * parity v3 — slicing port (InstanceValidator.sliceMatches / matchSlice / checkCardinalities, 7.0.1). The expected
 * wording follows Messages.properties; cases mirror fhir-test-cases outcomes (obs-quantity-us, type-slicing-multipleb).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { InstanceValidator, type Issue } from "./fhirValidator.js";
import { CORE, FakeResolver, SDS, el, sd } from "./fhirTestKit.test.js";

const P = "http://example.tw/fhir/StructureDefinition/slicing-port";
const run = (r: Record<string, any>): Promise<Issue[]> => new InstanceValidator(new FakeResolver()).validate(r, { profiles: [P] });
const errs = (i: Issue[]): string[] => i.filter((x) => x.severity === "error").map((x) => x.message);
const obs = (extra: Record<string, any>): Record<string, any> => ({ resourceType: "Observation", status: "final", code: { text: "x" }, ...extra });

function define(elements: Array<Record<string, any>>, version?: string): void {
  SDS[P] = sd(P, "Observation", "resource", [el("Observation", 0, "*"), el("Observation.status", 1, "1", ["code"]), el("Observation.code", 1, "1", ["CodeableConcept"]), ...elements], {
    baseDefinition: CORE + "Observation",
    ...(version ? { version } : {}),
  });
}

test("slice max = 0 is `$this.empty()`: a value never matches it, closed slicing → NotSlice with the reason", async () => {
  define([
    el("Observation.value[x]", 0, "1", ["Quantity", "string"], { slicing: { discriminator: [{ type: "type", path: "$this" }], rules: "closed" } }),
    el("Observation.value[x]:valueQuantity", 0, "0", ["Quantity"]),
  ], "1.0.0");
  try {
    const m = errs(await run(obs({ valueQuantity: { value: 1 } })));
    assert.ok(
      m.some((x) => x.startsWith(`This element does not match any known slice defined in the profile ${P}|1.0.0 and slicing is CLOSED: `) && x.includes("Does not match slice 'valueQuantity' (discriminator: $this.empty())")),
      m.join("\n"),
    );
    assert.ok(!m.some((x) => /max allowed/.test(x)), m.join("\n"));
  } finally {
    delete SDS[P];
  }
});

test("slice cardinality wording: required slice (one / other), max by element id, versioned profile", async () => {
  define([
    el("Observation.category", 0, "*", ["CodeableConcept"], { slicing: { discriminator: [{ type: "pattern", path: "$this" }], rules: "open" } }),
    el("Observation.category:a", 1, "1", ["CodeableConcept"], { patternCodeableConcept: { coding: [{ system: "http://s", code: "a" }] } }),
    el("Observation.category:b", 2, "*", ["CodeableConcept"], { patternCodeableConcept: { coding: [{ system: "http://s", code: "b" }] } }),
    el("Observation.category:c", 0, "1", ["CodeableConcept"], { patternCodeableConcept: { coding: [{ system: "http://s", code: "c" }] } }),
  ], "2.0.0");
  try {
    const c = { coding: [{ system: "http://s", code: "c" }] };
    const m = errs(await run(obs({ category: [c, c, { coding: [{ system: "http://s", code: "b" }] }] })));
    assert.ok(m.includes(`Slice 'Observation.category:a': a matching slice is required, but not found (from ${P}|2.0.0). Note that other slices are allowed in addition to this required slice`), m.join("\n"));
    assert.ok(m.includes(`Slice 'Observation.category:b': minimum required = 2, but only found 1 (from ${P}|2.0.0)`), m.join("\n"));
    assert.ok(m.includes(`Observation.category:c: max allowed = 1, but found 2 (from ${P}|2.0.0)`), m.join("\n"));
  } finally {
    delete SDS[P];
  }
});

test("open slicing: an unmatched item is a hint; a CodeableConcept pattern with text cannot be evaluated", async () => {
  define([
    el("Observation.category", 0, "*", ["CodeableConcept"], { slicing: { discriminator: [{ type: "pattern", path: "$this" }], rules: "open" } }),
    el("Observation.category:a", 0, "1", ["CodeableConcept"], { patternCodeableConcept: { coding: [{ system: "http://s", code: "a" }] } }),
  ]);
  try {
    const issues = await run(obs({ category: [{ coding: [{ system: "http://s", code: "z" }] }] }));
    assert.ok(!errs(issues).some((x) => /slice|slicing/i.test(x)), errs(issues).join("\n"));
    assert.ok(issues.some((i) => i.severity === "information" && /does not match any known slice defined in the profile .* \(this may not be a problem/.test(i.message)));
  } finally {
    delete SDS[P];
  }
  define([
    el("Observation.category", 0, "*", ["CodeableConcept"], { slicing: { discriminator: [{ type: "pattern", path: "$this" }], rules: "closed" } }),
    el("Observation.category:a", 0, "1", ["CodeableConcept"], { patternCodeableConcept: { text: "t", coding: [{ system: "http://s", code: "a" }] } }),
  ]);
  try {
    const m = errs(await run(obs({ category: [{ coding: [{ system: "http://s", code: "a" }] }] })));
    assert.ok(m.some((x) => x === "Slicing cannot be evaluated: Unsupported CodeableConcept pattern - using text - for discriminator ($this) for slice Observation.category:a"), m.join("\n"));
    assert.ok(!m.some((x) => /slicing is CLOSED/.test(x)), m.join("\n"));
  } finally {
    delete SDS[P];
  }
});

test("exists discriminator on a slice with neither min ≥ 1 nor max = 0 → SLICING_CANNOT_BE_EVALUATED", async () => {
  define([
    el("Observation.component", 0, "*", ["BackboneElement"], { slicing: { discriminator: [{ type: "exists", path: "valueString" }], rules: "open" } }),
    el("Observation.component.code", 1, "1", ["CodeableConcept"]),
    el("Observation.component.value[x]", 0, "1", ["string", "Quantity"]),
    el("Observation.component:s", 0, "1", ["BackboneElement"]),
    el("Observation.component:s.code", 1, "1", ["CodeableConcept"]),
    el("Observation.component:s.value[x]", 0, "1", ["string"]),
  ]);
  try {
    const m = errs(await run(obs({ component: [{ code: { text: "c" }, valueString: "v" }] })));
    assert.ok(m.some((x) => /^Slicing cannot be evaluated: Discriminator \(valueString\) is based on element existence, but slice Observation.component:s neither sets min>=1 or max=0$/.test(x)), m.join("\n"));
  } finally {
    delete SDS[P];
  }
});

test("memberOf slicing on a Coding with only _system: an NPE for a CodeableConcept focus, no member for a Coding focus (jar)", async () => {
  const VS = "http://hl7.org/fhir/ValueSet/administrative-gender";
  const bySlice = { slicing: { discriminator: [{ type: "value", path: "$this" }], rules: "open" } };
  define([
    el("Observation.category", 0, "*", ["CodeableConcept"], bySlice),
    el("Observation.category:g", 0, "1", ["CodeableConcept"], { binding: { strength: "required", valueSet: VS } }),
    el("Observation.code.coding", 0, "*", ["Coding"], bySlice),
    el("Observation.code.coding:g", 0, "1", ["Coding"], { binding: { strength: "required", valueSet: VS } }),
  ]);
  const shadow = { code: "male", _system: { extension: [{ url: "http://hl7.org/fhir/StructureDefinition/data-absent-reason", valueCode: "unknown" }] } };
  try {
    const cc = errs(await run(obs({ category: [{ coding: [shadow] }] })));
    assert.ok(cc.some((x) => x.startsWith("Slicing cannot be evaluated: Problem evaluating slicing expression") && x.endsWith('Cannot invoke "String.lastIndexOf(int)" because "system" is null')), cc.join("\n"));
    const coding = errs(await run(obs({ code: { coding: [shadow] } })));
    assert.ok(!coding.some((x) => x.startsWith("Slicing cannot be evaluated")), coding.join("\n"));
  } finally {
    delete SDS[P];
  }
});

// FHIRPathEngine.evaluateDefinition 7.0.1:7180-7197 / fetchStructureByType: an extension slice without children whose
// type profile is not resolvable cannot be evaluated (IPS 2.0.0 Patient-uv-ips: genderIdentity|5.3.0-ballot-tc1)
test("an extension slice whose type profile cannot be resolved: Problem with use of resolve(), for every extension", async () => {
  const missing = "http://example.tw/fhir/StructureDefinition/not-loaded|9.9.9";
  SDS[P] = sd(P, "Patient", "resource", [
    el("Patient", 0, "*"),
    el("Patient.extension", 0, "*", ["Extension"], { slicing: { discriminator: [{ type: "value", path: "url" }], rules: "open" } }),
    el("Patient.extension:gone", 0, "1", [], { type: [{ code: "Extension", profile: [missing] }] }),
  ], { baseDefinition: CORE + "Patient" });
  try {
    const ext = (u: string): Record<string, any> => ({ url: u, valueString: "x" });
    const issues = await run({ resourceType: "Patient", extension: [ext("http://a.org/x"), ext("http://a.org/y")] });
    const msg = `Slicing cannot be evaluated: Problem with use of resolve() - profile [CanonicalType[${missing}]] on Patient.extension:gone could not be resolved (@char 1)`;
    assert.deepEqual(issues.filter((i) => i.message === msg).map((i) => i.path), ["Patient.extension[0]", "Patient.extension[1]"]);
    assert.deepEqual(errs(await run({ resourceType: "Patient" })), []);
  } finally {
    delete SDS[P];
  }
});
