import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateConstraint, fhirPathBase, narrativeHtmlOk, primitiveValueAlias, type FhirPathEnv } from "./fhirPath.js";

const env = (resource: Record<string, any>, extra: Partial<FhirPathEnv> = {}): FhirPathEnv => ({ resource, rootResource: resource, ...extra });

test("`value` resolves to value[x] on typed nodes (resource root and backbone)", () => {
  const obs = { resourceType: "Observation", valueQuantity: { value: 1 }, component: [{ valueString: "x" }] };
  assert.deepEqual(evaluateConstraint(obs, "Observation", "value.exists()", env(obs)), { status: "pass" });
  assert.deepEqual(evaluateConstraint(obs.component[0], "Observation.component", "value.exists()", env(obs)), { status: "pass" });
  assert.deepEqual(evaluateConstraint(obs, "Observation", "value.is(Quantity) and value.ofType(Quantity).value = 1", env(obs)), { status: "pass" });
  assert.deepEqual(evaluateConstraint({ resourceType: "Observation" }, "Observation", "value.exists()", env(obs)), { status: "fail" });
});

test("datatype base: Extension value[x] and Quantity", () => {
  const ext = { url: "u", valueString: "s" };
  assert.deepEqual(evaluateConstraint(ext, "Extension", "extension.exists() != value.exists()", env({ resourceType: "Patient" })), { status: "pass" });
  const both = { url: "u", valueString: "s", extension: [{ url: "a", valueString: "b" }] };
  assert.deepEqual(evaluateConstraint(both, "Extension", "extension.exists() != value.exists()", env({ resourceType: "Patient" })), { status: "fail" });
});

test("fhirPathBase picks a typed base path", () => {
  assert.equal(fhirPathBase("Observation.value[x]", "Quantity"), "Observation.valueQuantity");
  assert.equal(fhirPathBase("Quantity", "Quantity").length > 0, true);
  assert.equal(fhirPathBase("Observation.effective[x]", "dateTime"), "Observation.effectiveDateTime");
  assert.equal(fhirPathBase("Observation.component", "BackboneElement"), "Observation.component");
  assert.equal(fhirPathBase("Observation", "Observation"), "Observation");
});

test("vs-1 style `$this as dateTime` works on a primitive choice value", () => {
  const r = { resourceType: "Observation", effectiveDateTime: "2023-01-02" };
  assert.deepEqual(
    evaluateConstraint("2023-01-02", "Observation.effectiveDateTime", "($this as dateTime).toString().length() >= 8", env(r)),
    { status: "pass" },
  );
});

test("primitiveValueAlias rewrites a bare `value` only", () => {
  assert.equal(primitiveValueAlias("value.matches('^x$')"), "$this.matches('^x$')");
  assert.equal(primitiveValueAlias("a.value.exists() or value.exists()"), "a.value.exists() or $this.exists()");
  assert.equal(primitiveValueAlias("'value' = x"), "'value' = x");
});

test("resolve() uses the supplied resolver; is() works on the result", () => {
  const target = { resourceType: "Practitioner", id: "1", name: [{ text: "Dr" }] };
  const prov = { resourceType: "Provenance", agent: [{ who: { reference: "Practitioner/1" } }] };
  const e = env(prov, { resolveReference: (ref) => (ref === "Practitioner/1" ? target : null) });
  assert.deepEqual(evaluateConstraint(prov.agent[0], "Provenance.agent", "who.resolve() is Practitioner", e), { status: "pass" });
  assert.deepEqual(evaluateConstraint(prov.agent[0], "Provenance.agent", "who.resolve().name.text = 'Dr'", e), { status: "pass" });
});

test("%resource / %rootResource and lenient as() (dom-3)", () => {
  const dom3 =
    "contained.where((('#'+id in (%resource.descendants().reference | %resource.descendants().as(canonical) | %resource.descendants().as(uri) | %resource.descendants().as(url))) or descendants().where(reference = '#').exists() or descendants().where(as(canonical) = '#').exists() or descendants().where(as(canonical) = '#').exists()).not()).trace('unmatched', id).empty()";
  const ok = { resourceType: "Patient", contained: [{ resourceType: "Organization", id: "o1" }], managingOrganization: { reference: "#o1" } };
  assert.deepEqual(evaluateConstraint(ok, "Patient", dom3, env(ok)), { status: "pass" });
  const orphan = { resourceType: "Patient", contained: [{ resourceType: "Organization", id: "o1" }] };
  assert.deepEqual(evaluateConstraint(orphan, "Patient", dom3, env(orphan)), { status: "fail" });
});

test("string functions on empty input are false (HL7 Java engine), e.g. ref-1", () => {
  const ref1 = "reference.startsWith('#').not() or (reference.substring(1).trace('url') in %rootResource.contained.id.trace('ids'))";
  const r = { resourceType: "Condition" };
  assert.deepEqual(evaluateConstraint({ display: "x" }, "Reference", ref1, env(r)), { status: "pass" });
  assert.deepEqual(evaluateConstraint({ reference: "#missing" }, "Reference", ref1, env(r)), { status: "fail" });
});

test("unsupported functions are unevaluable, not failures", () => {
  const r = { resourceType: "Patient" };
  assert.equal(evaluateConstraint(r, "Patient", "conformsTo('http://x')", env(r)).status, "unevaluable");
  assert.equal(evaluateConstraint({ coding: [{ code: "a" }] }, "CodeableConcept", "memberOf('http://vs')", env(r)).status, "unevaluable");
  assert.equal(
    evaluateConstraint({ coding: [{ code: "a" }] }, "CodeableConcept", "memberOf('http://vs')", env(r, { memberOf: () => true })).status,
    "pass",
  );
});

test("htmlChecks: xhtml div ok, script rejected", () => {
  assert.equal(narrativeHtmlOk('<div xmlns="http://www.w3.org/1999/xhtml"><p>x</p></div>'), true);
  assert.equal(narrativeHtmlOk('<div xmlns="http://www.w3.org/1999/xhtml"><script>x</script></div>'), false);
  assert.equal(narrativeHtmlOk("<div>no namespace</div>"), false);
  const r = { resourceType: "Patient" };
  assert.deepEqual(
    evaluateConstraint('<div xmlns="http://www.w3.org/1999/xhtml">x</div>', "Narrative.div", "htmlChecks()", env(r)),
    { status: "pass" },
  );
});
