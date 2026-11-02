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
import { FHIRLexerError, parseFhirPathJava } from "./fhirPathJavaParser.js";
import { duplicateKeys, numberText, registerLosslessLiterals } from "./fhirJsonLiterals.js";
import { parseLossless } from "./losslessJson.js";
import { checkHtmlNames, checkValidUrl, javaHashSetOrder, languageXhtmlIssues, narrativeControlIssues, parseXhtml, textLinkIssues, validateXhtml, xhtmlHrefIssues } from "./fhirXhtml.js";

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
  // the element model binds the first of repeated names (JSON.parse kept the last)
  assert.equal(plain.gender, "male");
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

test("textLink (TEXT_LINK_*), Language_XHTML_*, data: URL mime types", () => {
  const tl = (data: string | null, htmlid: string): Record<string, any> => ({
    url: "http://hl7.org/fhir/StructureDefinition/textLink",
    extension: [{ url: "htmlid", valueString: htmlid }, ...(data === null ? [] : [{ url: "data", valueUri: data }])],
  });
  const res = { resourceType: "Patient", name: [{ id: "n1", family: "x" }] };
  const narr = (ext: Record<string, any>[]): Record<string, any> => ({ div: `<div ${NS}><p id="h1">x</p></div>`, extension: ext });
  assert.deepEqual(textLinkIssues(narr([tl("#n1", "h1")]), res, null), []);
  assert.deepEqual(textLinkIssues(narr([tl("#n2", "h2"), tl(null, "h1")]), res, null).map((i) => i.message), [
    "The html id 'h2' was not found in the xhtml",
    "The target of the textLink data reference '#n2' was not found in the resource",
    "No data element was found in the textLink extension",
  ]);
  const bad = { url: "http://hl7.org/fhir/StructureDefinition/textLink", extension: [{ url: "data", valueUri: "#n1" }, { url: "selector", valueString: "a.(" }] };
  assert.deepEqual(textLinkIssues(narr([bad]), res, null).map((i) => i.message), ["The textLink selector 'a.(' is invalid: Error @1, 4: Expression terminated unexpectedly"]);
  assert.deepEqual(languageXhtmlIssues("en", `<div ${NS} lang="de" xml:lang="de">x</div>`).map((i) => i.message), [
    // (sic) Java: no Different2 when xml:lang equals lang
    "Resource has a language (en), and the XHTML has a lang (de), but they differ",
  ]);
  assert.deepEqual(languageXhtmlIssues("en", `<div ${NS}><div lang="en" xml:lang="en">x</div></div>`), []);
  assert.equal(checkValidUrl("data:text/plain;base64,SGk="), null);
  assert.equal(checkValidUrl("data:bad mime;base64,SGk="), "The mimetype portion of the data: URL is not valid (Mime type invalid) in URL: data:bad mime;base64,SGk=");
});

test("markdown with an unescaped HTML tag: warning by default, error with htmlInMarkdown error (bad-markdown-no-html)", async () => {
  const MD = sd(CORE + "Basic", "Basic", "resource", [el("Basic", 0, "*"), el("Basic.text2", 0, "1", ["markdown"])]);
  class R extends FakeResolver {
    override async fetchStructureDefinition(url: string): Promise<Record<string, any> | null> {
      return url.split("|")[0] === CORE + "Basic" ? MD : super.fetchStructureDefinition(url);
    }
  }
  const msg = "Basic.text2 | The markdown contains content that appears to be an embedded HTML tag starting at '<r'. This will (or SHOULD) be escaped by the presentation layer. The content should be checked to confirm that this is the desired behaviour";
  const res = { resourceType: "Basic", text2: "a <rule> here" };
  const w = (await new InstanceValidator(new R()).validate(res)).filter((i) => i.severity === "warning").map((i) => `${i.path} | ${i.message}`);
  assert.ok(w.includes(msg), JSON.stringify(w));
  assert.deepEqual(errs(await new InstanceValidator(new R()).validate(res, { htmlInMarkdown: "error" })), [msg]);
});

test("JsonParser wording for primitives: _x shadows, null entries / scalars, empty arrays (evaluator corpus primitive-ext, null-in-array)", async () => {
  const BASIC = sd(CORE + "Basic", "Basic", "resource", [
    el("Basic", 0, "*"),
    el("Basic.one", 0, "1", ["string"]),
    el("Basic.many", 0, "*", ["string"]),
    el("Basic.choice[x]", 0, "1", ["string", "boolean"]),
    el("Basic.items", 0, "*", ["Coding"]),
  ]);
  class R extends FakeResolver {
    override async fetchStructureDefinition(url: string): Promise<Record<string, any> | null> {
      return url.split("|")[0] === CORE + "Basic" ? BASIC : super.fetchStructureDefinition(url);
    }
  }
  const run = async (f: Record<string, any>): Promise<string[]> => errs(await new InstanceValidator(new R()).validate({ resourceType: "Basic", ...f }));
  // an empty shadow, at the parser's path ([x] name of a choice)
  assert.deepEqual(await run({ one: "a", _one: {} }), ["Basic.one | Object must have some content"]);
  assert.deepEqual(await run({ choiceString: "a", _choiceString: {} }), ["Basic.choice[x] | Object must have some content"]);
  // a shadow that is not an object drops the whole property
  assert.deepEqual(await run({ one: "a", _one: "x" }), ["Basic.one | This property must be an object, not a Primitive property (one at Basic.one)"]);
  assert.deepEqual(await run({ one: "a", _one: ["x"] }), ["Basic.one | This property must be an object, not an Array (one at Basic.one)"]);
  // null scalars and entries
  assert.deepEqual(await run({ one: null }), ["Basic.one | This property must be a simple value, not a Null (one at Basic.one)"]);
  assert.deepEqual(await run({ many: ["a", null] }), ["Basic.many | The JSON array for '1' is invalid at index {1} - must have at least one valid value"]);
  assert.ok((await run({ items: [null, { code: "a" }] })).includes("Basic.items[0] | The property items must be an Array, not a Null (at Basic.items[0])"));
  // a list: an item whose shadow is not an object is not built, a shadow that is not an array loses the property
  assert.deepEqual(await run({ many: ["a", "b"], _many: [null, "x"] }), ["Basic.many | This property must be an object, not a Primitive property (many at Basic.many)"]);
  assert.deepEqual(await run({ many: ["a"], _many: {} }), ["Basic.many | This base property must be an Array, not an Array"]);
  // ARRAY_CANNOT_BE_EMPTY is parseChildComplex only
  assert.deepEqual(await run({ many: [] }), []);
  assert.deepEqual(await run({ items: [] }), ["Basic.items | Array cannot be empty - the property should not be present if it has no values"]);
});

test("invariants see the tree the parser built: a dropped value is gone, an object it emptied does not exist", async () => {
  const EXISTS = { key: "tst-1", severity: "error", human: "items or note", expression: "items.exists() or note.exists()" };
  const BASIC = sd(CORE + "Basic", "Basic", "resource", [
    el("Basic", 0, "*", [], { constraint: [EXISTS] }),
    el("Basic.note", 0, "1", ["string"]),
    el("Basic.items", 0, "*", ["Identifier"]),
    el("Basic.value[x]", 0, "1", ["Identifier", "string"]),
  ]);
  const ID = sd(CORE + "Identifier", "Identifier", "complex-type", [el("Identifier", 0, "*"), el("Identifier.value", 0, "1", ["string"])]);
  class R extends FakeResolver {
    override async fetchStructureDefinition(url: string): Promise<Record<string, any> | null> {
      const u = url.split("|")[0];
      return u === CORE + "Basic" ? BASIC : u === CORE + "Identifier" ? ID : super.fetchStructureDefinition(url);
    }
  }
  const v = await new InstanceValidator(new R()).validate({ resourceType: "Basic", items: [{ value: "a", _value: "bad" }] });
  const m = errs(v);
  assert.ok(m.includes("Basic.items[0].value | This property must be an object, not a Primitive property (value at Basic.items[0].value)"), JSON.stringify(m));
  assert.ok(m.some((x) => /^Basic \| Constraint failed: tst-1/.test(x)), JSON.stringify(m));
  assert.ok(!m.some((x) => /Object must have some content/.test(x)), JSON.stringify(m));
  assert.ok(m.some((x) => /^Basic.items\[0\] \| Constraint failed: ele-1/.test(x)), JSON.stringify(m));
  // the same emptied object on a choice element: no checkObject message, ele-1 as for a source `{}` there (jar, single run:
  // valueQuantity {value: "a", _value: "bad"} gives the object error and ele-1 at value.ofType(Quantity))
  const c = errs(await new InstanceValidator(new R()).validate({ resourceType: "Basic", note: "n", valueIdentifier: { value: "a", _value: "bad" } }));
  assert.ok(c.includes("Basic.value[x].value | This property must be an object, not a Primitive property (value at Basic.value[x].value)"), JSON.stringify(c));
  assert.ok(!c.some((x) => /Object must have some content/.test(x)), JSON.stringify(c));
  assert.ok(c.some((x) => /ele-1/.test(x)), JSON.stringify(c));
});

test("fixed values: a blank primitive is not compared (checkPrimitive returns first), the pattern's Issues list prints ValidationMessage", async () => {
  const P = "http://example.org/fhir/StructureDefinition/basic-fx";
  const CC = sd(CORE + "CodeableConcept", "CodeableConcept", "complex-type", [el("CodeableConcept", 0, "*"), el("CodeableConcept.coding", 0, "*", ["Coding"])]);
  const CD = sd(CORE + "Coding", "Coding", "complex-type", [el("Coding", 0, "*"), el("Coding.system", 0, "1", ["uri"]), el("Coding.code", 0, "1", ["code"])]);
  const B = sd(CORE + "Basic", "Basic", "resource", [el("Basic", 0, "*"), el("Basic.status", 0, "1", ["code"]), el("Basic.cat", 0, "1", ["CodeableConcept"])]);
  const PR = sd(P, "Basic", "resource", [
    el("Basic", 0, "*"),
    el("Basic.status", 0, "1", ["code"], { fixedCode: "final" }),
    el("Basic.cat", 0, "1", ["CodeableConcept"], { patternCodeableConcept: { coding: [{ system: "http://s", code: "A" }] } }),
  ], { baseDefinition: CORE + "Basic", derivation: "constraint", version: "1.0.0" });
  class R extends FakeResolver {
    override async fetchStructureDefinition(url: string): Promise<Record<string, any> | null> {
      const m: Record<string, Record<string, any>> = { [CORE + "Basic"]: B, [CORE + "CodeableConcept"]: CC, [CORE + "Coding"]: CD, [P]: PR };
      return m[url.split("|")[0]] ?? super.fetchStructureDefinition(url);
    }
  }
  const run = async (f: Record<string, any>): Promise<string[]> => errs(await new InstanceValidator(new R()).validate({ resourceType: "Basic", ...f }, { profiles: [P] }));
  assert.ok(!(await run({ status: "" })).some((m) => /but is fixed/.test(m)));
  assert.ok((await run({ status: "other" })).some((m) => m.includes("Value is 'other' but is fixed to 'final' in the profile " + P + "|1.0.0#Basic.status")));
  const got = await run({ cat: { coding: [{ system: "http://s", code: "" }] } });
  assert.ok(
    got.some((m) => m.includes("Issues: [ValidationMessage[level=ERROR,type=VALUE,location=Basic.cat.coding.code,message=Value is '' but is fixed to 'A' in the profile " + P + "|1.0.0#Basic]]")),
    JSON.stringify(got),
  );
});

test("validator_contained_Id (IV:7533) + the profile tracker (IV:7157-7165): the duplicate stays in the first validation's profile", async () => {
  // validator_cli: a Bundle profile's conformsTo() slice sees the entry first; the message is in that profile's outcomes
  const B = "http://example.tw/fhir/StructureDefinition/bundle";
  const P = "http://example.tw/fhir/StructureDefinition/pat";
  const pat = (meta: Record<string, any>): Record<string, any> => ({
    resourceType: "Patient",
    id: "p1",
    ...meta,
    contained: [{ resourceType: "Basic", id: "c" }, { resourceType: "Basic", id: "c" }],
  });
  const dup = async (profiles: string[], patMeta: Record<string, any>): Promise<number> => {
    const b = { resourceType: "Bundle", type: "collection", entry: [{ fullUrl: "http://ex.org/fhir/Patient/p1", resource: pat(patMeta) }] };
    return (await new InstanceValidator(new FakeResolver()).validate(b, { profiles })).filter((i) => i.message === "Duplicate ID for contained resource: c").length;
  };
  assert.equal(await dup([], {}), 1); // no trial: the real pass
  assert.equal(await dup([B], {}), 0); // only the trial against P saw it, and the entry is not validated against P
  assert.equal(await dup([B], { meta: { profile: [P] } }), 1); // the real pass against P returns the trial's outcomes
});

test("checkFixedPattern: a blank primitive is compared only with inline children (validator_cli, fixed + Patient.gender.extension)", async () => {
  // jar: `gender: ""` gives no fixed message; when the profile defines Patient.gender.extension, "Value is '' but is fixed to 'male'"
  const B = sd(CORE + "Basic", "Basic", "resource", [el("Basic", 0, "*"), el("Basic.status", 0, "1", ["code"])]);
  const P = "http://example.tw/fhir/StructureDefinition/fx-inline";
  const profile = (inline: boolean): Record<string, any> =>
    sd(P, "Basic", "resource", [el("Basic", 0, "*"), el("Basic.status", 0, "1", ["code"], { fixedCode: "final" }), ...(inline ? [el("Basic.status.extension", 0, "*", ["Extension"])] : [])], {
      baseDefinition: CORE + "Basic",
      derivation: "constraint",
      version: "1.0.0",
    });
  const fixed = async (inline: boolean): Promise<string[]> => {
    class R extends FakeResolver {
      override async fetchStructureDefinition(url: string): Promise<Record<string, any> | null> {
        const m: Record<string, Record<string, any>> = { [CORE + "Basic"]: B, [P]: profile(inline) };
        return m[url.split("|")[0]] ?? super.fetchStructureDefinition(url);
      }
    }
    return (await new InstanceValidator(new R()).validate({ resourceType: "Basic", status: "" }, { profiles: [P] })).map((i) => i.message).filter((m) => /but is fixed/.test(m));
  };
  assert.deepEqual(await fixed(false), []);
  assert.deepEqual(await fixed(true), [`Value is '' but is fixed to 'final' in the profile ${P}|1.0.0#Basic.status`]);
});

test("FHIRPathEngine.parse: FHIRLexer's wording and Java's NullPointerException text", () => {
  const msg = (p: string): string => {
    try {
      parseFhirPathJava(p);
    } catch (e) {
      return e instanceof FHIRLexerError ? e.message : `other: ${(e as Error).message}`;
    }
    return "";
  };
  assert.equal(msg("name.given"), "");
  assert.equal(msg("a.("), "Error @1, 4: Expression terminated unexpectedly");
  assert.match(msg("given[0"), /Cannot invoke "String\.equals\(Object\)" because the return value of "org\.hl7\.fhir\.services\.fhirpath\.FHIRLexer\.getCurrent\(\)" is null/);
});

test("checkPrimitive l. 3417: Bundle.entry.fullUrl is not a reference, an example.org one gets no TYPE_SPECIFIC_CHECKS_DT_URL_EXAMPLE", async () => {
  const b = { resourceType: "Bundle", type: "collection", entry: [{ fullUrl: "http://example.org/fhir/Patient/p1", resource: { resourceType: "Patient", id: "p1" } }] };
  const issues = await new InstanceValidator(new FakeResolver()).validate(b);
  assert.deepEqual(issues.filter((i) => /Example URLs/.test(i.message)), []);
});
