import assert from "node:assert/strict";
import { test } from "node:test";
import { parseFhirXml, parseXmlDocument, XmlSyntaxError } from "./fhirXml.js";

type Json = Record<string, any>;
const SYS = "http://hl7.org/fhirpath/System.";

/** A minimal snapshot: [path, types, max, extra]. */
function sd(type: string, kind: string, rows: Array<[string, string[], string, Json?]>): Json {
  return {
    resourceType: "StructureDefinition",
    url: `http://hl7.org/fhir/StructureDefinition/${type}`,
    version: "4.0.1",
    type,
    kind,
    derivation: "specialization",
    snapshot: {
      element: [{ path: type, min: 0, max: "*" }, ...rows.map(([path, types, max, extra]) => ({ path, max, base: { path, max }, type: types.map((code) => ({ code })), ...(extra ?? {}) }))],
    },
  };
}
const attr = { representation: ["xmlAttr"] };
const primitive = (t: string, sys: string): Json =>
  sd(t, "primitive-type", [
    [`${t}.id`, [`${SYS}String`], "1", attr],
    [`${t}.extension`, ["Extension"], "*"],
    [`${t}.value`, [`${SYS}${sys}`], "1", attr],
  ]);
const DEFS: Record<string, Json> = {
  boolean: primitive("boolean", "Boolean"),
  string: primitive("string", "String"),
  code: primitive("code", "String"),
  integer: primitive("integer", "Integer"),
  Extension: sd("Extension", "complex-type", [
    ["Extension.id", [`${SYS}String`], "1", attr],
    ["Extension.extension", ["Extension"], "*"],
    ["Extension.url", [`${SYS}String`], "1", attr],
    ["Extension.value[x]", ["boolean", "string", "integer"], "1"],
  ]),
  HumanName: sd("HumanName", "complex-type", [
    ["HumanName.id", [`${SYS}String`], "1", attr],
    ["HumanName.extension", ["Extension"], "*"],
    ["HumanName.family", ["string"], "1"],
    ["HumanName.given", ["string"], "*"],
  ]),
  Narrative: sd("Narrative", "complex-type", [
    ["Narrative.id", [`${SYS}String`], "1", attr],
    ["Narrative.extension", ["Extension"], "*"],
    ["Narrative.status", ["code"], "1"],
    ["Narrative.div", ["xhtml"], "1"],
  ]),
  Patient: sd("Patient", "resource", [
    ["Patient.id", [`${SYS}String`], "1"],
    ["Patient.text", ["Narrative"], "1"],
    ["Patient.contained", ["Resource"], "*"],
    ["Patient.extension", ["Extension"], "*"],
    ["Patient.active", ["boolean"], "1"],
    ["Patient.name", ["HumanName"], "*"],
    ["Patient.gender", ["code"], "1"],
    ["Patient.multipleBirth[x]", ["boolean", "integer"], "1"],
    ["Patient.contact", ["BackboneElement"], "*"],
    ["Patient.contact.id", [`${SYS}String`], "1", attr],
    ["Patient.contact.name", ["HumanName"], "1"],
    ["Patient.contact.gender", ["code"], "1"],
  ]),
};
const resolver = {
  async fetchStructureDefinition(url: string): Promise<Json | null> {
    return DEFS[url.replace("http://hl7.org/fhir/StructureDefinition/", "")] ?? null;
  },
};
const parse = (xml: string) => parseFhirXml(xml, resolver);
const msgs = (r: { issues: Array<{ path: string; message: string }> }): string[] => r.issues.map((i) => `${i.path} | ${i.message}`);

test("element model: cardinality, primitives, _primitive, choice, backbone, contained, xhtml", async () => {
  const r = await parse(`<?xml version="1.0" encoding="UTF-8"?>
<Patient xmlns="http://hl7.org/fhir">
  <id value="p1"/>
  <text><status value="generated"/><div xmlns="http://www.w3.org/1999/xhtml"><p class="x">a &amp; b<br/></p></div></text>
  <contained><Patient><id value="c1"/></Patient></contained>
  <extension url="http://example.org/e"><valueInteger value="5"/></extension>
  <active value="true"/>
  <name><family value="Chalmers"/><given value="Peter"/><given id="g2"><extension url="http://example.org/x"><valueBoolean value="false"/></extension></given></name>
  <gender id="gid" value="male"/>
  <multipleBirthInteger value="2"/>
  <contact><name><family value="X"/></name></contact>
</Patient>`);
  assert.deepEqual(msgs(r), []);
  assert.deepEqual(r.resource, {
    resourceType: "Patient",
    id: "p1",
    text: { status: "generated", div: '<div xmlns="http://www.w3.org/1999/xhtml"><p class="x">a &amp; b<br/></p></div>' },
    contained: [{ resourceType: "Patient", id: "c1" }],
    extension: [{ url: "http://example.org/e", valueInteger: 5 }],
    active: true,
    name: [{ family: "Chalmers", given: ["Peter", null], _given: [null, { id: "g2", extension: [{ url: "http://example.org/x", valueBoolean: false }] }] }],
    gender: "male",
    _gender: { id: "gid" },
    multipleBirthInteger: 2,
    contact: [{ name: { family: "X" } }],
  });
});

test("XmlParser parse errors: undefined element / attribute, text, empty element, namespace, order", async () => {
  const r = await parse(`<Patient xmlns="http://hl7.org/fhir" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="x">
  stray text
  <active value="true" something="1"/>
  <id value="p1"/>
  <name><family value="a"/><bogus value="1"/></name>
  <gender/>
  <contained><Foo/></contained>
</Patient>`);
  assert.deepEqual(msgs(r), [
    "/f:Patient | Text should not be present ('stray text')",
    "/f:Patient | Undefined attribute '@xsi:schemaLocation' on Patient for type Patient",
    "/f:Patient/f:active | Undefined attribute '@something' on active for type boolean",
    "Patient.id | As specified by profile http://hl7.org/fhir/StructureDefinition/Patient|4.0.1, Element 'id' is out of order (found after active)",
    "/f:Patient/f:name | Undefined element 'bogus' at /f:Patient/f:name",
    "/f:Patient/f:gender | Element must have some content",
    "Patient.contained[0] | As specified by profile http://hl7.org/fhir/StructureDefinition/Patient|4.0.1, Element 'contained' is out of order (found after gender)",
    "/f:Patient/f:contained | Contained resource does not appear to be a FHIR resource (unknown name 'Foo')",
  ]);
  // the out-of-order element is still read
  assert.equal(r.resource?.id, "p1");
});

test("contained resources report with the resource name as XML path (XmlParser.parseResource)", async () => {
  const r = await parse(`<Patient xmlns="http://hl7.org/fhir"><contained><Patient><id value="c"/><foo value="1"/></Patient></contained></Patient>`);
  assert.deepEqual(msgs(r), ["Patient | Undefined element 'foo' at Patient"]);
});

test("root element: no namespace, unknown name, well-formedness, DOCTYPE, entities, PI", async () => {
  assert.deepEqual(msgs(await parse(`<Patient/>`)), ["Patient | This 'Patient' cannot be parsed (no namespace on the XML Root element)"]);
  assert.deepEqual(msgs(await parse(`<Foo xmlns="http://hl7.org/fhir"/>`)), ["Foo | This content cannot be parsed (unknown or unrecognized XML Root element namespace/name 'http://hl7.org/fhir::Foo')"]);
  assert.deepEqual(msgs(await parse(`<Patient xmlns="http://hl7.org/fhir"><active value="&reg;"/></Patient>`)), ['(xml) | The entity "reg" was referenced, but not declared.']);
  assert.match(msgs(await parse(`<!DOCTYPE x><Patient xmlns="http://hl7.org/fhir"/>`))[0], /^\(xml\) \| DOCTYPE is disallowed/);
  assert.deepEqual(msgs(await parse(`<Patient xmlns="http://hl7.org/fhir"><active value="true"></Patient>`)), ['(xml) | The element type "active" must be terminated by the matching end-tag "</active>".']);
  const pi = await parse(`<?xml version="1.0" encoding="UTF-8"?><?xml-stylesheet href="a"?><Patient xmlns="http://hl7.org/fhir"><active value="true"/><![CDATA[x]]></Patient>`);
  assert.deepEqual(msgs(pi), ["(document) | No processing instructions allowed in resources", "/f:Patient | CDATA is not allowed"]);
});

test("checkHeader: non UTF-8 encoding", async () => {
  const r = await parse(`<?xml version="1.0" encoding="ISO-8859-1"?><Patient xmlns="http://hl7.org/fhir"><active value="true"/></Patient>`);
  assert.deepEqual(msgs(r), ["XML | The XML encoding is invalid (must be UTF-8, not 'ISO-8')"]);
});

test("XML reader: namespaces, attribute normalisation, char references", () => {
  const d = parseXmlDocument(`<f:a xmlns:f="urn:x" b="1&#10;2\n3"><f:c/>t&lt;</f:a>`);
  assert.equal(d.root.local, "a");
  assert.equal(d.root.ns, "urn:x");
  assert.equal(d.root.attrs.find((a) => a.local === "b")?.value, "1\n2 3");
  assert.throws(() => parseXmlDocument(`<a:b/>`), (e: unknown) => e instanceof XmlSyntaxError && /prefix "a"/.test(e.message));
});
