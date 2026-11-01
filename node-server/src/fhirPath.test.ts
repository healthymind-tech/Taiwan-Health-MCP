import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateConstraint,
  evaluateExpression,
  fhirPathBase,
  fixInvariantExpression,
  invariantExpression,
  narrativeHasContent,
  narrativeHtmlOk,
  primitiveValueAlias,
  type FhirPathEnv,
} from "./fhirPath.js";

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

// dom-3 goes through invariantExpression(): Java's checkInvariant never evaluates it (InstanceValidator.java 7.0.1
// l. 8868-8872, enforced in code by checkContainedReferences) and Java's as() rejects a collection
// (FHIRPathEngine.funcAs l. 5597, FHIRPATH_AS_COLLECTION), so the published expression is evaluated with ofType().
test("%resource / %rootResource and dom-3 (as() read as ofType())", () => {
  const dom3 =
    "contained.where((('#'+id in (%resource.descendants().reference | %resource.descendants().as(canonical) | %resource.descendants().as(uri) | %resource.descendants().as(url))) or descendants().where(reference = '#').exists() or descendants().where(as(canonical) = '#').exists() or descendants().where(as(canonical) = '#').exists()).not()).trace('unmatched', id).empty()";
  const ok = { resourceType: "Patient", contained: [{ resourceType: "Organization", id: "o1" }], managingOrganization: { reference: "#o1" } };
  const expr = invariantExpression(dom3, "dom-3");
  assert.deepEqual(evaluateConstraint(ok, "Patient", expr, env(ok)), { status: "pass" });
  const orphan = { resourceType: "Patient", contained: [{ resourceType: "Organization", id: "o1" }] };
  assert.deepEqual(evaluateConstraint(orphan, "Patient", expr, env(orphan)), { status: "fail" });
  // the raw expression hits the Java singleton rule of as(): an exception Java raises too, so the invariant FAILS
  // with that message (InstanceValidator.checkInvariant l. 8896-8898)
  const raw = evaluateConstraint(ok, "Patient", dom3, env(ok));
  assert.equal(raw.status, "fail");
  assert.match(raw.status === "fail" ? raw.error ?? "" : "", /^Attempt to use 'as\(\)' on more than one item/);
});

// Java 7.0.1 string functions return EMPTY on an empty focus (FHIRPathEngine.funcStartsWith l. 6216-6236);
// ref-1 passes for a Reference without .reference because the validator evaluates the FHIRPathExpressionFixer
// rewrite `reference.exists() implies (…)` (FHIRPathExpressionFixer.java l. 48-50, InstanceValidator l. 8877).
test("ref-1: fixed expression (FHIRPathExpressionFixer) with Java string-function semantics", () => {
  const ref1 = "reference.startsWith('#').not() or (reference.substring(1).trace('url') in %rootResource.contained.id.trace('ids'))";
  const fixed = invariantExpression(ref1, "ref-1");
  assert.notEqual(fixed, ref1);
  const r = { resourceType: "Condition", contained: [{ resourceType: "Patient", id: "p" }] };
  assert.deepEqual(evaluateConstraint({ display: "x" }, "Reference", fixed, env(r)), { status: "pass" });
  assert.deepEqual(evaluateConstraint({ reference: "#missing" }, "Reference", fixed, env(r)), { status: "fail" });
  assert.deepEqual(evaluateConstraint({ reference: "#p" }, "Reference", fixed, env(r)), { status: "pass" });
  assert.deepEqual(evaluateConstraint({ reference: "#" }, "Reference", fixed, env(r)), { status: "pass" });
  assert.deepEqual(evaluateConstraint({ reference: "Patient/1" }, "Reference", fixed, env(r)), { status: "pass" });
  // unfixed: empty focus gives an empty (false) result, like Java
  assert.deepEqual(evaluateConstraint({ display: "x" }, "Reference", ref1, env(r)), { status: "fail" });
});

test("Java string functions: empty focus → empty, non-string types → empty, '' prefix → true", () => {
  const r = { resourceType: "Patient", birthDate: "1974-12-25", name: [{ family: "Chalmers" }] };
  const ev = (e: string): any[] => evaluateExpression(r, "Patient", e, env(r));
  assert.deepEqual(ev("{}.startsWith('a')"), []);
  assert.deepEqual(ev("{}.contains('a')"), []);
  assert.deepEqual(ev("{}.matches('a')"), []);
  assert.deepEqual(ev("name.family.startsWith('')"), [true]);
  assert.deepEqual(ev("name.family.startsWith('Chal')"), [true]);
  assert.deepEqual(ev("name.family.endsWith('ers')"), [true]);
  assert.deepEqual(ev("name.family.contains('alm')"), [true]);
  assert.deepEqual(ev("name.family.matches('^C.*s$')"), [true]);
  assert.deepEqual(ev("birthDate.startsWith('19')"), []); // date is not one of FHIR_TYPES_STRING
  assert.deepEqual(ev("name.family.length()"), [8]);
});

test("fixInvariantExpression ports FHIRPathExpressionFixer", () => {
  assert.equal(fixInvariantExpression("htmlChecks()", "txt-2"), "htmlChecks2()");
  assert.equal(fixInvariantExpression("fullUrl.contains('/_history/').not()", "bld-8"), "fullUrl.exists() implies fullUrl.contains('/_history/').not()");
  assert.equal(
    fixInvariantExpression("offset.empty() or (when.exists() and ((when in ('C' | 'CM' | 'CD' | 'CV')).not()))", "tim-9"),
    "offset.empty() or (when.exists() and when.select($this in ('C' | 'CM' | 'CD' | 'CV')).allFalse())",
  );
  assert.equal(fixInvariantExpression("a.exists()", "x-1"), "a.exists()");
  assert.ok(fixInvariantExpression("x", "eld-19").startsWith("path.matches('^[^\\\\s\\\\.,:;"));
});

test("Java constants: %sct %loinc %ucum %`vs-…` %`ext-…`", () => {
  const r = { resourceType: "Patient" };
  const ev = (e: string): any[] => evaluateExpression(r, "Patient", e, env(r));
  assert.deepEqual(ev("%sct"), ["http://snomed.info/sct"]);
  assert.deepEqual(ev("%loinc"), ["http://loinc.org"]);
  assert.deepEqual(ev("%ucum"), ["http://unitsofmeasure.org"]);
  assert.deepEqual(ev("%`vs-administrative-gender`"), ["http://hl7.org/fhir/ValueSet/administrative-gender"]);
  assert.deepEqual(ev("%`ext-patient-birthTime`"), ["http://hl7.org/fhir/StructureDefinition/patient-birthTime"]);
});

test("Java ofType()/as(): primitives have no supertype, as() is singleton", () => {
  const r = { resourceType: "Patient", gender: "male", name: [{ family: "a" }, { family: "b" }] };
  const ev = (e: string): any[] => evaluateExpression(r, "Patient", e, env(r));
  assert.deepEqual(ev("gender.ofType(string)"), []);
  assert.deepEqual(ev("gender.ofType(code)"), ["male"]);
  assert.deepEqual(ev("gender.as(code)"), ["male"]);
  assert.equal(ev("$this.ofType(DomainResource)").length, 1);
  assert.throws(() => ev("name.as(HumanName)"));
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

// InstanceValidator.checkInvariant l. 8896-8898: an evaluation exception FAILS the invariant — only for exceptions the
// Java FHIRPathEngine raises too (asBool on a collection l. 7346-7356, funcIif l. 5436-5440, unknown function names at
// parse l. 1256-1265); where Java evaluates (short-circuit preOperate l. 1661-1676, comparisons of collections → empty
// l. 2590ff, unknown %constants → empty via ValidatorHostServices.resolveConstant l. 213-226) there is no exception.
test("Java exception semantics of invariant evaluation", () => {
  const r = { resourceType: "Patient", name: [{ family: "a" }, { family: "b" }], active: true };
  const st = (e: string) => evaluateConstraint(r, "Patient", e, env(r));
  assert.deepEqual(st("false and name.family"), { status: "fail" });
  assert.deepEqual(st("true or name.family"), { status: "pass" });
  assert.deepEqual(st("name.empty() implies name.family"), { status: "pass" });
  assert.equal((st("true and name.family") as any).error, "Unable to evaluate as a boolean: a,b");
  assert.equal((st("name.family.not()") as any).error, "Unable to evaluate as a boolean: a,b");
  assert.equal(st("name.where(family).exists()").status, "pass");
  assert.equal(st("name.family.iif(true, 1, 2) = 1").status, "fail");
  assert.match((st("name.family.iif(true, 1, 2) = 1") as any).error, /iif/);
  assert.deepEqual(st("name.family < 'z'"), { status: "fail" }); // empty, not an exception
  assert.deepEqual(st("%undefinedThing.empty()"), { status: "pass" });
  const unknown = st("name.frobnicate()") as any;
  assert.equal(unknown.status, "fail");
  assert.equal(unknown.parse, true);
  // convertToBoolean: a non-empty collection is true, whatever its items
  assert.deepEqual(st("name.family.select($this = 'zz')"), { status: "pass" });
});

test("numeric root nodes (integer / decimal elements) evaluate", () => {
  const r = { resourceType: "RiskAssessment", prediction: [{ probabilityDecimal: 150 }] };
  assert.deepEqual(evaluateConstraint(150, "RiskAssessment.prediction.probabilityDecimal", "$this <= 100", env(r)), { status: "fail" });
  assert.deepEqual(evaluateConstraint(50, "RiskAssessment.prediction.probabilityDecimal", "low.empty()", env(r)), { status: "pass" });
});

// FHIRPathEngine.dateAdd l. 2929-2986 (the value's own zone and precision), BaseDateTimeType.equalsUsingFhirPathRules
// l. 1102-1143 (one side without a zone), opEquivalent l. 2544-2563 (order-insensitive)
test("date arithmetic keeps the zone and precision; mixed-zone equality; ~ on collections", () => {
  const r = { resourceType: "Patient" };
  const ev = (e: string): any[] => evaluateExpression(r, "Patient", e, env(r));
  assert.deepEqual(ev("(@1973-12-25T00:00:00.000+10:00 + 7 days).toString()"), ["1974-01-01T00:00:00.000+10:00"]);
  assert.deepEqual(ev("(@1973-12-25T00:00:00.000+10:00 + 1 'h').toString()"), ["1973-12-25T01:00:00.000+10:00"]);
  assert.deepEqual(ev("(@2014-01-31 + 1 month).toString()"), ["2014-02-28"]);
  assert.deepEqual(ev("(@1974-12-25 - 1 'month').toString()"), ["1974-11-25"]);
  assert.throws(() => ev("@1974-12-25 + 1 'mo'"), /definite quantity duration/);
  assert.deepEqual(ev("@2012-04-15T15:00:00Z = @2012-04-15T10:00:00"), []);
  assert.deepEqual(ev("@2012-04-15T15:00:00Z = @2012-04-18T10:00:00"), [false]);
  assert.deepEqual(ev("@2012-04-15T15:00:00Z != @2012-04-15T10:00:00"), []);
  assert.deepEqual(ev("(1 | 2 | 3) ~ (3 | 2 | 1)"), [true]);
  assert.deepEqual(ev("(1 | 2 | 3) !~ (3 | 2 | 1)"), [false]);
  assert.deepEqual(ev("'abc'.replaceMatches('', 'x')"), ["abc"]);
});

// htmlChecks() = FHIRPathEngine.funcHtmlChecks1 → checkHtmlNames (l. 5032-5079): element / attribute names only;
// the xhtml namespace is the XHTML parser's concern, not this function's.
test("htmlChecks: xhtml div ok, script rejected", () => {
  assert.equal(narrativeHtmlOk('<div xmlns="http://www.w3.org/1999/xhtml"><p>x</p></div>'), true);
  assert.equal(narrativeHtmlOk('<div xmlns="http://www.w3.org/1999/xhtml"><script>x</script></div>'), false);
  assert.equal(narrativeHtmlOk('<div xmlns="http://www.w3.org/1999/xhtml"><p onclick="x()">x</p></div>'), false);
  assert.equal(narrativeHtmlOk('<div xmlns="http://www.w3.org/1999/xhtml"><a href="#x" title="t">x</a><img src="a.png" alt=""/></div>'), true);
  assert.equal(narrativeHtmlOk("<div>no namespace</div>"), true);
  // htmlChecks2() (txt-2 after the fixer) = checkForContent: non-blank text or an img
  assert.equal(narrativeHasContent('<div xmlns="http://www.w3.org/1999/xhtml"><p> </p></div>'), false);
  assert.equal(narrativeHasContent('<div xmlns="http://www.w3.org/1999/xhtml"><!-- c --></div>'), false);
  assert.equal(narrativeHasContent('<div xmlns="http://www.w3.org/1999/xhtml"><p>x</p></div>'), true);
  assert.equal(narrativeHasContent('<div xmlns="http://www.w3.org/1999/xhtml"><img src="a.png"/></div>'), true);
  const r = { resourceType: "Patient" };
  assert.deepEqual(
    evaluateConstraint('<div xmlns="http://www.w3.org/1999/xhtml">x</div>', "Narrative.div", "htmlChecks()", env(r)),
    { status: "pass" },
  );
});
