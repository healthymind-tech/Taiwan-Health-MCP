/**
 * CodeSystem / ValueSet resources as validated resources: CodeSystemValidator / ValueSetValidator (instance/type, tag 7.0.1).
 * Expected texts are the official test outputs (fhir-test-cases validator/: supplement-2, cs-bad-props, cs-meta-profile,
 * vs-canonical-*, vs-filter-property-bad*, vs-params-*, vs-bad-props).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateCodeSystemResource, type CodeSystemResourceDeps } from "./fhirCodeSystemResource.js";
import { validateValueSetResource, type ValueSetResourceDeps } from "./fhirValueSetResource.js";

type Json = Record<string, any>;
const P = "http://hl7.org/fhir/concept-properties#";
const csDeps = (known: Set<string> = new Set()): CodeSystemResourceDeps => ({
  fetchCodeSystem: async () => null,
  codeStatus: async (s, c) => (known.has(`${s}#${c}`) ? { status: "ok" } : { status: "invalid", message: `Unknown code '${c}'` }),
});
const vsDeps = (over: Partial<ValueSetResourceDeps> = {}): ValueSetResourceDeps => ({
  fetchCodeSystem: async () => null,
  fetchValueSet: async () => null,
  codeStatus: async (_s, c) => (c.startsWith("bad") ? { status: "invalid", message: `Unknown code '${c}'` } : { status: "ok" }),
  allowExamples: true,
  isExampleUrl: (u) => u.includes("example.org"),
  ...over,
});
const errors = (l: Array<{ severity: string; path: string; message: string }>): string[] => l.filter((i) => i.severity === "error").map((i) => `${i.path} | ${i.message}`);

test("CodeSystem count, supplement content and concepts", async () => {
  const count = await validateCodeSystemResource({ resourceType: "CodeSystem", content: "complete", count: 10, concept: [{ code: "a" }, { code: "b", concept: [{ code: "c" }] }] }, "CodeSystem", csDeps());
  assert.deepEqual(errors(count), ["CodeSystem.count | The code system is complete, but the number of concepts (3) does not match the stated total number (10)"]);
  const supp = await validateCodeSystemResource({ resourceType: "CodeSystem", supplements: "http://loinc.org", content: "complete", concept: [{ code: "test" }] }, "CodeSystem", csDeps());
  assert.deepEqual(errors(supp), [
    "CodeSystem.content | CodeSystem Supplements SHALL have a content value of 'supplement'",
    "CodeSystem.concept[0] | The code 'test' is not declared in the base CodeSystem http://loinc.org so is not valid in the supplement",
  ]);
  const dup = await validateCodeSystemResource({ resourceType: "CodeSystem", content: "complete", concept: [{ code: "a" }, { code: "a" }] }, "CodeSystem", csDeps());
  assert.deepEqual(errors(dup), ["CodeSystem.concept[1] | The code 'a' has already been defined"]);
  const np = await validateCodeSystemResource({ resourceType: "CodeSystem", content: "not-present", concept: [{ code: "a" }] }, "CodeSystem", csDeps());
  assert.deepEqual(errors(np), ["CodeSystem.concept[0] | The code system says it has no content present, but concepts are found"]);
});

test("CodeSystem property definitions and values", async () => {
  const cs: Json = {
    resourceType: "CodeSystem",
    url: "http://x/cs",
    content: "complete",
    property: [
      { uri: `${P}notSelectable`, code: "notSelectable", type: "dateTime" },
      { code: "notSelectable", type: "boolean" },
      { uri: `${P}inactive`, code: "deprecationDate", type: "boolean" },
      { uri: `${P}order`, code: "order", type: "decimal" },
    ],
    concept: [{ code: "a", property: [{ code: "notSelectable", valueBoolean: true }, { code: "other", valueString: "x" }, { code: "order" }] }],
  };
  assert.deepEqual(errors(await validateCodeSystemResource(cs, "CodeSystem", csDeps())), [
    `CodeSystem.property[0] | Wrong type 'dateTime': The URI '${P}notSelectable' identifies a property that has the type 'boolean'`,
    "CodeSystem.property[1] | A property is already defined with the code 'notSelectable'",
    `CodeSystem.property[2] | The URI '${P}inactive' is normally assigned the code 'inactive'. Using the code 'deprecationDate' will usually create confusion in ValueSet filters etc`,
    `CodeSystem.property[3] | Unknown CodeSystem Property '${P}order'. If you are creating your own property, do not create it in the HL7 namespace`,
    "CodeSystem.concept[0].property[0] | The property 'notSelectable' has the invalid type 'boolean', when it is defined to have the type 'dateTime'",
    "CodeSystem.concept[0].property[2] | The property 'order' has no value, and cannot be understood",
  ]);
});

test("ValueSet include.system: canonical syntax, relative, contained, value set as a system", async () => {
  const frag = await validateValueSetResource({ resourceType: "ValueSet", compose: { include: [{ system: "#c1" }] }, contained: [{ resourceType: "CodeSystem", id: "c1" }] }, "ValueSet", vsDeps());
  assert.equal(errors(frag).length, 1);
  assert.match(errors(frag)[0], /^ValueSet\.compose\.include\[0\] \| URI values in ValueSet\.compose\.include\.system must be absolute\. To reference a contained code system/);
  const missing = await validateValueSetResource({ resourceType: "ValueSet", compose: { include: [{ system: "#nope" }] } }, "ValueSet", vsDeps());
  assert.ok(errors(missing).some((e) => /No matching contained code system found for system '#nope'/.test(e)));
  const piped = await validateValueSetResource({ resourceType: "ValueSet", compose: { include: [{ system: "http://x/cs|1.0" }] } }, "ValueSet", vsDeps());
  assert.ok(errors(piped).some((e) => /must not use the canonical version syntax/.test(e)));
  const asVs = await validateValueSetResource({ resourceType: "ValueSet", compose: { include: [{ system: "http://x/vs" }] } }, "ValueSet", vsDeps({ fetchValueSet: async () => ({ compose: { include: [{ system: "http://x/cs" }] } }) }));
  assert.ok(errors(asVs).some((e) => /is actually a value set, which itself refers to the system 'http:\/\/x\/cs'/.test(e)));
});

test("ValueSet concepts and filters", async () => {
  const concept = await validateValueSetResource({ resourceType: "ValueSet", compose: { include: [{ system: "http://snomed.info/sct", concept: [{ code: "ok1" }, { code: "bad1" }] }] } }, "ValueSet", vsDeps());
  assert.deepEqual(errors(concept), ["ValueSet.compose.include[0].concept[1] | The code 'bad1' is not valid in the system http://snomed.info/sct (Unknown code 'bad1')"]);
  const cs = { url: "http://x/cs", content: "complete", property: [{ code: "myproperty", type: "Coding" }] };
  const flt = (value: string): Json => ({ resourceType: "ValueSet", compose: { include: [{ system: "http://x/cs", filter: [{ property: "myproperty", op: "=", value }] }] } });
  const d = vsDeps({ fetchCodeSystem: async () => cs });
  assert.deepEqual(errors(await validateValueSetResource(flt("code-r-3"), "ValueSet", d)), ["ValueSet.compose.include[0].filter[0] | The value for a filter based on property 'myproperty' must be in the format system(|version)#code, not 'code-r-3'"]);
  assert.deepEqual(errors(await validateValueSetResource(flt("http://x/cs#bad3"), "ValueSet", d)), ["ValueSet.compose.include[0].filter[0] | The value for a filter based on property 'myproperty' is 'http://x/cs#bad3' which is not a valid code (Unknown code 'bad3')"]);
  const snomed = { resourceType: "ValueSet", compose: { include: [{ system: "http://snomed.info/sct", filter: [{ property: "1142143009", op: "not-in", value: "1" }, { property: "concept", op: "is-a", value: "bad" }] }] } };
  assert.deepEqual(errors(await validateValueSetResource(snomed, "ValueSet", vsDeps())), [
    "ValueSet.compose.include[0].filter[0] | The operation 'not-in' is not allowed for property '1142143009' in system 'http://snomed.info/sct'. Allowed ops: =,in",
    "ValueSet.compose.include[0].filter[1] | The value for a filter based on property 'concept' must be a valid code from the system 'http://snomed.info/sct', and 'bad' is not (Unknown code 'bad')",
  ]);
});

test("ValueSet filter expressions and parameters", async () => {
  const vs = (expression: string, language = "text/fhirpath"): Json => ({
    resourceType: "ValueSet",
    extension: [{ url: "http://hl7.org/fhir/tools/StructureDefinition/valueset-parameter", extension: [{ url: "name", valueCode: "p-inactive" }] }],
    compose: { include: [{ system: "http://snomed.info/sct", filter: [{ property: "inactive", op: "=", _value: { extension: [{ url: "http://hl7.org/fhir/StructureDefinition/cqf-expression", valueExpression: { language, expression } }] } }] }] },
  });
  const at = "ValueSet.compose.include[0].filter[0].extension[0].valueExpression";
  assert.deepEqual(errors(await validateValueSetResource(vs("%p-inactive"), "ValueSet", vsDeps())), []);
  assert.deepEqual(errors(await validateValueSetResource(vs("%p-inactive3"), "ValueSet", vsDeps())), [`${at} | The filter parameter expression '%p-inactive3' refers to the unknown parameter 'p-inactive3'`]);
  assert.deepEqual(errors(await validateValueSetResource(vs("$ and %p-inactive"), "ValueSet", vsDeps())), [`${at} | The value of the expression '$ and %p-inactive' is not a valid FHIRPath: Error @1, 6: Found $ expecting a valid token name`]);
  assert.deepEqual(errors(await validateValueSetResource(vs("x", "text/cql"), "ValueSet", vsDeps())), [`${at} | A ValueSet expression language must be 'text/fhirpath' not 'text/cql'`]);
});

test("a SNOMED filter property outside SnomedCTChecker.listPropertyNames gets no rules: only a known attribute's op is judged", async () => {
  const vs = { resourceType: "ValueSet", compose: { include: [{ system: "http://snomed.info/sct", filter: [{ property: "2342342123", op: "not-in", value: "734137005" }, { property: "1142143009", op: "not-in", value: "734137005" }] }] } };
  assert.deepEqual(errors(await validateValueSetResource(vs, "ValueSet", vsDeps())), [
    "ValueSet.compose.include[0].filter[1] | The operation 'not-in' is not allowed for property '1142143009' in system 'http://snomed.info/sct'. Allowed ops: =,in",
  ]);
});
