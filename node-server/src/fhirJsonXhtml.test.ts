/**
 * parity v3 (json-xhtml): validator_cli's JSON reader (utilities JsonLexer / JsonParser in JSON5 mode + the syntax
 * checks of the r5 element-model JsonParser), the number-spelling / duplicate-name side channel (review F4), and the
 * Narrative XHTML ports (XhtmlParser, XhtmlValidator, checkReferences schemes, htmlChecks, checkNarrative controls).
 * Expected texts are the Messages.properties templates / the Java exception texts; cases follow fhir-test-cases
 * validator json-comments-*, json-comma-bad-*, json-no-quotes-*, bad-json-close-*, xml-bad-entities, xhtml-ctrl-*.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { InstanceValidator, type Issue } from "./fhirValidator.js";
import { CORE, FakeResolver, el, sd } from "./fhirTestKit.test.js";
import { jsonSyntaxIssues, parseFhirJsonText, JsonSyntaxError, toPlain } from "./fhirJsonParser.js";
import { duplicateKeys, numberText, registerLosslessLiterals } from "./fhirJsonLiterals.js";
import { parseLossless } from "./losslessJson.js";
import { checkHtmlNames, javaHashSetOrder, narrativeControlIssues, parseXhtml, validateXhtml, xhtmlHrefIssues } from "./fhirXhtml.js";

const syntax = (text: string, allowComments = false): string[] => {
  const root = parseFhirJsonText(text);
  return jsonSyntaxIssues(root, "Patient", allowComments).map((i) => `${i.path} | ${i.message}`).sort();
};
const fatal = (text: string): string => {
  try {
    parseFhirJsonText(text);
  } catch (e) {
    assert.ok(e instanceof JsonSyntaxError);
    return (e as Error).message;
  }
  return "";
};

test("JSON5 reader: comments are attached to the next element (json-comments-2)", () => {
  const text = '{\n "resourceType" : "Patient",\n // c1\n "id" : "x",\n "name" : [ { "given" : [ "S" ]\n // c2\n } ],\n "gender" : "female"\n}';
  assert.deepEqual(syntax(text), ["Patient.gender | Comments are not allowed in JSON", "Patient.id | Comments are not allowed in JSON"]);
  assert.deepEqual(syntax(text, true), []);
  assert.deepEqual(syntax("// lead\n{ \"resourceType\": \"Patient\" }"), ["Patient | Comments are not allowed in JSON"]);
});

test("JSON5 reader: missing / extra commas and unquoted names / values (json-comma-bad-2, json-no-quotes-2)", () => {
  assert.deepEqual(syntax('{ "resourceType": "Patient", "name": [ { "given": [ "S", ] } ], "address": [ { "line": [ "l" ] "city": "c", } ] }'), [
    "Patient.address[0] | A Comma is missing in the JSON",
    "Patient.address[0] | There is an extra comma at the end of the Object in the JSON",
    "Patient.name[0].given | There is an extra comma at the end of the Array in the JSON",
  ]);
  assert.deepEqual(syntax('{ "resourceType": "Patient", "name": [ { "given": [ Sarah ] } ], "address": [ { line: [ "l" ], "city": Strahan } ] }'), [
    "Patient.address[0] | The JSON property 'city' has no quotes around the value of the property 'Strahan'",
    "Patient.address[0] | The JSON property 'line' has no quotes around the name of the property",
    "Patient.name[0].given[0] | The JSON property 'item' has no quotes around the value of the property 'Sarah'",
  ]);
});

test("JSON5 reader: duplicates keep the first value; resourceType is read last-wins", () => {
  const root = parseFhirJsonText('{ "resourceType": "Patient", "gender": "male", "gender": "female" }');
  assert.deepEqual(syntax('{ "resourceType": "Patient", "gender": "male", "gender": "female" }'), ["Patient | The JSON property 'gender' is a duplicate and will be ignored"]);
  assert.equal((toPlain(root) as Record<string, unknown>).gender, "male");
});

test("JSON5 reader: fatal errors carry Java's text, line and lexer path", () => {
  assert.equal(fatal('{ "a": [ "x" } }'), "Error parsing JSON source: Unexpected close marker '}'. Expected ']' at Line 1 (path=[//a[]x])");
  assert.equal(fatal("[ 1 ]"), "Error parsing JSON source: Unexpected content at start of JSON: OpenArray at Line 1 (path=[null])");
  assert.equal(fatal("{\n  'a': 1 }"), "Error parsing JSON source: Unexpected content ''' in json format at Line 2 (path=[null])");
  assert.equal(fatal('{ "a": "x'), "Error parsing JSON source: Unclosed string at Line 1 (path=[/a])");
  assert.equal(fatal("﻿{ \"a\": 1 }"), "");
});

const PATIENT = sd(CORE + "Patient", "Patient", "resource", [
  el("Patient", 0, "*"),
  el("Patient.id", 0, "1", ["string"], { base: { path: "Resource.id", min: 0, max: "1" } }),
  el("Patient.gender", 0, "1", ["code"]),
  el("Patient.multipleBirth[x]", 0, "1", ["boolean", "integer"]),
]);
class Resolver extends FakeResolver {
  override async fetchStructureDefinition(url: string): Promise<Record<string, any> | null> {
    if (url.split("|")[0] === CORE + "Patient") return PATIENT;
    return super.fetchStructureDefinition(url);
  }
}
const errs = (issues: Issue[]): string[] => issues.filter((i) => i.severity === "error" || i.severity === "fatal").map((i) => `${i.path} | ${i.message}`).sort();

test("validateText: syntax issues next to the instance's issues; unrecognised properties drop their value marks", async () => {
  const v = new InstanceValidator(new Resolver());
  assert.deepEqual(errs(await v.validateText('{ "resourceType": "Patient", "x": NaN, "gender": "male", }')), [
    "Patient | There is an extra comma at the end of the Object in the JSON",
    "Patient | Unrecognized property 'x'",
  ]);
  assert.deepEqual(errs(await v.validateText("{}")), ["$ | Unable to find resourceType property"]);
  assert.deepEqual(errs(await v.validateText("[]")), [" | Error parsing JSON: Error parsing JSON source: Unexpected content at start of JSON: OpenArray at Line 1 (path=[null])"]);
});

test("F4: a number's source spelling is validated (1.0 is not an integer) — raw text and lossless request tree", async () => {
  const v = new InstanceValidator(new Resolver());
  const expected = ["Patient.multipleBirthInteger | The value '1.0' is not a valid integer"];
  assert.deepEqual(errs(await v.validateText('{ "resourceType": "Patient", "multipleBirthInteger": 1.0 }')), expected);
  const text = '{ "resourceType": "Patient", "multipleBirthInteger": 1.0, "gender": "male", "gender": "female" }';
  const plain = JSON.parse(text);
  registerLosslessLiterals(plain, parseLossless(text));
  assert.equal(numberText(plain, "multipleBirthInteger"), "1.0");
  assert.deepEqual(duplicateKeys(plain), ["gender"]);
  assert.deepEqual(errs(await new InstanceValidator(new Resolver()).validate(plain)), [...expected, "Patient | The JSON property 'gender' is a duplicate and will be ignored"].sort());
  // without the side channel the parsed value is all the validator sees
  assert.deepEqual(errs(await new InstanceValidator(new Resolver()).validate(JSON.parse('{ "resourceType": "Patient", "multipleBirthInteger": 1.0 }'))), []);
});

const NS = 'xmlns="http://www.w3.org/1999/xhtml"';
const xv = (div: string): string[] => {
  const p = parseXhtml(div);
  if (p.error) return [`parse: ${p.error}`];
  return [...p.issues, ...validateXhtml(p.div!).filter((i) => i.severity === "error").map((i) => i.message), ...xhtmlHrefIssues(p.div!).filter((i) => i.severity === "error").map((i) => i.message)];
};

test("XhtmlParser (xml mode): Java's FHIRFormatError texts; entity rule", () => {
  assert.deepEqual(xv("plain text"), ["parse: Unable to Parse HTML - does not start with tag. Found 'p'  at line 1 column 0"]);
  assert.deepEqual(xv(""), ["parse: Unable to Parse HTML - does not start with tag. Found '￿'  at line 1 column 0"]);
  assert.deepEqual(xv(`<div ${NS}><p>x</div>`), ['parse: Malformed XHTML: Found "</div>" expecting "</p>" at line 1 column 53']);
  assert.deepEqual(xv(`<div ${NS}>&foo;</div>`), ["parse: unable to parse character reference 'foo'' (last text = '' at line 1 column 48"]);
  assert.deepEqual(xv(`<div ${NS}>&reg; &amp;</div>`), ["Invalid entity in the XHTML ('&reg;')"]);
});

test("XhtmlValidator: namespace, root name, element / attribute names, structure, schemes", () => {
  assert.deepEqual(xv("<div>x</div>"), ["Wrong namespace on the XHTML ('null', should be 'http://www.w3.org/1999/xhtml')"]);
  assert.deepEqual(xv(`<p ${NS}>x</p>`), ["Wrong name on the XHTML ('p') - must start with div"]);
  assert.deepEqual(xv(`<div ${NS}><p onclick="x">a</p><blink>b</blink></div>`), ["Invalid attribute name in the XHTML ('onclick' on 'p')", "Invalid element name in the XHTML ('blink')"]);
  assert.deepEqual(xv(`<div ${NS}><p><div>x</div></p></div>`), [
    "Invalid element name inside a paragraph in the XHTML ('div')",
    "Found block structures inside a paragraph/text element p at div/p: p/div",
  ]);
  assert.deepEqual(xv(`<div ${NS}><table><p>x</p></table></div>`), ["Elements of type table at div/table cannot have the following children: p"]);
  assert.deepEqual(xv(`<div ${NS}><a href="javascript:alert(1)">x</a></div>`), [
    "Hyperlink scheme 'javascript' in 'javascript:alert(1)' at 'div/a' for 'x' has active content, which is a security risk and not allowed",
  ]);
  assert.ok(checkHtmlNames(parseXhtml(`<div ${NS}><p>ok</p></div>`).div!));
  assert.ok(!checkHtmlNames(parseXhtml(`<div ${NS}><script>x</script></div>`).div!));
});

test("checkNarrative: narrative-language-control / -source-control (xhtml-ctrl-*)", () => {
  const def = (code: string): Record<string, any> => ({ extension: [{ url: "http://hl7.org/fhir/StructureDefinition/narrative-language-control", valueCode: code }] });
  const two = { div: `<div ${NS}><div xml:lang="en" lang="en">a</div><div xml:lang="de" lang="de">b</div></div>` };
  assert.deepEqual(narrativeControlIssues(two, def("_no"), null, "http://x/p").map((i) => i.message), [
    "The xhtml has some language sections (de, en), but language sections are prohibited in this context by the profile StructureDefinition[http://x/p]",
  ]);
  assert.deepEqual(narrativeControlIssues(two, def("_yes"), null, "http://x/p"), []);
  assert.deepEqual(javaHashSetOrder(["en", "pt", "de"]), ["de", "pt", "en"]);
  const src = { extension: [{ url: "http://hl7.org/fhir/StructureDefinition/narrative-source-control", valueCode: "error" }] };
  assert.deepEqual(narrativeControlIssues({ div: `<div ${NS}><p class="generated">a</p><p>Text without container</p></div>` }, src, null, "http://x/p").map((i) => `${i.severity} ${i.message}`), [
    "error The xhtml node at 'Text without container' does not have a class attribute to indicate its source (boilerplate, generated, or original) and this is required by the profile StructureDefinition[http://x/p]",
  ]);
});

const PATIENT2 = sd(CORE + "Patient", "Patient", "resource", [
  el("Patient", 0, "*"),
  el("Patient.meta", 0, "1", ["Meta"]),
  el("Patient.identifier", 0, "*", ["Identifier"]),
  // validateContains (IV:7533) checks contained ids only for an element typed Resource
  el("Patient.contained", 0, "*", ["Resource"]),
]);
const IDENTIFIER = sd(CORE + "Identifier", "Identifier", "complex-type", [el("Identifier", 0, "*"), el("Identifier.system", 0, "1", ["uri"]), el("Identifier.value", 0, "1", ["string"])]);
const META = sd(CORE + "Meta", "Meta", "complex-type", [el("Meta", 0, "*"), el("Meta.security", 0, "*", ["Coding"])]);
const CODING = sd(CORE + "Coding", "Coding", "complex-type", [el("Coding", 0, "*"), el("Coding.system", 0, "1", ["uri"]), el("Coding.code", 0, "1", ["code"])]);
class Resolver2 extends FakeResolver {
  override async fetchStructureDefinition(url: string): Promise<Record<string, any> | null> {
    const u = url.split("|")[0];
    const m: Record<string, Record<string, any>> = { [CORE + "Patient"]: PATIENT2, [CORE + "Identifier"]: IDENTIFIER, [CORE + "Meta"]: META, [CORE + "Coding"]: CODING };
    return m[u] ?? super.fetchStructureDefinition(url);
  }
  async definitionExists(url: string): Promise<boolean> {
    return url === "http://example.org/fhir/NamingSystem/known";
  }
}

test("F23: an example URL is an error only when it does not resolve", async () => {
  const v = (system: string): Promise<Issue[]> => new InstanceValidator(new Resolver2()).validate({ resourceType: "Patient", identifier: [{ system, value: "1" }] });
  assert.deepEqual(errs(await v("http://example.org/ids")), ["Patient.identifier[0].system | Example URLs are not allowed in this context (http://example.org/ids)"]);
  assert.deepEqual(errs(await v("http://example.org/fhir/NamingSystem/known")), []);
});

test("F18: duplicate meta.security labels (reported at .meta.profile[i], as Java does)", async () => {
  const issues = await new InstanceValidator(new Resolver2()).validate({
    resourceType: "Patient",
    meta: { security: [{ system: "http://s", code: "R" }, { system: "http://s", code: "N" }, { system: "http://s", code: "R" }] },
  });
  assert.deepEqual(errs(issues).filter((m) => /Security/.test(m)), ["Patient.meta.profile[2] | Duplicate Security Label http://s#R"]);
});

test("DUPLICATE_ID / RESOURCE_DUPLICATE_CONTAINED_ID: ids unique per resource scope", async () => {
  const issues = await new InstanceValidator(new Resolver2()).validate({
    resourceType: "Patient",
    id: "p",
    identifier: [{ id: "x", value: "1" }, { id: "x", value: "2" }, { id: "p", value: "3" }],
    contained: [{ resourceType: "Patient", id: "c", identifier: [{ id: "x" }] }, { resourceType: "Patient", id: "c" }],
  });
  assert.deepEqual(errs(issues).filter((m) => /Duplicate/.test(m)), ["Patient.contained[1] | Duplicate ID for contained resource: c", "Patient.identifier[1] | Duplicate id value 'x'"]);
});
