/**
 * parity v3 (msgids-structure): port of InstanceValidator.checkPrimitive (HL7 validator 7.0.1) — every
 * Type_Specific_Checks_DT_* message the JSON path can produce, in Java's wording and severity. Expected texts are the
 * Messages.properties templates; the cases follow fhir-test-cases validator/primitive-bad.xml.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { InstanceValidator, type Issue } from "./fhirValidator.js";
import { CORE, FakeResolver, el, sd } from "./fhirTestKit.test.js";

const PRIMS = ["boolean", "integer", "unsignedInt", "positiveInt", "decimal", "string", "uri", "canonical", "oid", "uuid", "id", "code", "date", "dateTime", "instant", "time", "base64Binary", "integer64"];
const fields = (p: string): Record<string, any>[] => PRIMS.map((t) => el(`${p}.${t}X`, 0, "1", [t]));
/** A core-like resource with one element per primitive type, plus an IG profile of it (isCoreDefinition = false). */
const BASIC = sd(CORE + "Basic", "Basic", "resource", [
  el("Basic", 0, "*"),
  el("Basic.id", 0, "1", ["string"], { base: { path: "Resource.id", min: 0, max: "1" } }),
  el("Basic.extension", 0, "*", ["Extension"]),
  el("Basic.modifierExtension", 0, "*", ["Extension"]),
  el("Basic.identifierX", 0, "1", ["Identifier"]),
  el("Basic.attachmentX", 0, "1", ["Attachment"]),
  ...fields("Basic"),
]);
const ATTACHMENT = sd(CORE + "Attachment", "Attachment", "complex-type", [
  el("Attachment", 0, "*"),
  ...["contentType:code", "language:code", "data:base64Binary", "url:url", "size:unsignedInt", "hash:base64Binary", "title:string"].map((x) => el(`Attachment.${x.split(":")[0]}`, 0, "1", [x.split(":")[1]])),
]);
const extSd = (url: string, modifier: boolean): Record<string, any> =>
  sd(url, "Extension", "complex-type", [
    el("Extension", 0, "*", [], { isModifier: modifier }),
    el("Extension.extension", 0, "0", ["Extension"]),
    el("Extension.url", 1, "1", ["uri"], { fixedUri: url }),
    el("Extension.value[x]", 1, "1", ["string"]),
  ], { context: [{ type: "element", expression: "Element" }] });
const MOD_EXT = "http://acme-test.fhir.test/StructureDefinition/mod-ext";
const REG_EXT = "http://acme-test.fhir.test/StructureDefinition/reg-ext";
const IG = "http://example.org/fhir/StructureDefinition/basic-ig";
const BASIC_IG = sd(IG, "Basic", "resource", [
  el("Basic", 0, "*"),
  ...fields("Basic"),
  el("Basic.stringX", 0, "1", ["string"], { maxLength: 3, extension: [{ url: "http://hl7.org/fhir/StructureDefinition/regex", valueString: "[a-z]+" }] }),
  el("Basic.integerX", 0, "1", ["integer"], { minValueInteger: 2, maxValueInteger: 5 }),
], { baseDefinition: CORE + "Basic", derivation: "constraint" });

class Resolver extends FakeResolver {
  override async fetchStructureDefinition(url: string): Promise<Record<string, any> | null> {
    const u = url.split("|")[0];
    if (u === CORE + "Basic") return BASIC;
    if (u === IG) return BASIC_IG;
    if (u === CORE + "Attachment") return ATTACHMENT;
    if (u === MOD_EXT) return extSd(MOD_EXT, true);
    if (u === REG_EXT) return extSd(REG_EXT, false);
    return super.fetchStructureDefinition(url);
  }
}
async function run(fieldsIn: Record<string, any>, profiles: string[] = []): Promise<Issue[]> {
  return new InstanceValidator(new Resolver()).validate({ resourceType: "Basic", ...fieldsIn }, { profiles });
}
const msgs = (issues: Issue[], sev = "error"): string[] => issues.filter((i) => i.severity === sev).map((i) => i.message);
const only = async (f: Record<string, any>, expected: string[], sev = "error", profiles: string[] = []): Promise<void> => {
  const got = msgs(await run(f, profiles), sev);
  assert.deepEqual(got.sort(), [...expected].sort(), JSON.stringify(got));
};

test("checkPrimitive: boolean / integer family (TYPE_SPECIFIC_CHECKS_DT_BOOLEAN_VALUE, _INTEGER_VALID, _INTEGER_LT0 / LT1)", async () => {
  await only({ booleanX: "yes" }, ["Error parsing JSON: the primitive value must be a boolean", "Boolean values must be 'true' or 'false'"]);
  await only({ integerX: 1.5 }, ["The value '1.5' is not a valid integer"]);
  await only({ integerX: 34534536346 }, ["The value '34534536346' is not a valid integer"]);
  await only({ unsignedIntX: -1 }, ["value is less than permitted minimum value of 0"]);
  await only({ positiveIntX: 0 }, ["value is less than permitted minimum value of 1"]);
});

test("checkPrimitive: decimal (Utilities.checkDecimal) and min / max value", async () => {
  await only({ decimalX: "00.1" }, ["Error parsing JSON: the primitive value must be a number", "The value '00.1' is not a valid decimal"]);
  await only({ decimalX: 1234567890.123456789 }, []);
  await only({ integerX: 7 }, ["integer value is greater than permitted maximum value of 5"], "error", [IG]);
  await only({ integerX: 1 }, ["integer value is less than permitted minimum value of 2"], "error", [IG]);
});

test("checkPrimitive: uri family (URI_OID / URI_UUID / URI_WS / OID_START / UUID_STRAT / CANONICAL_ABSOLUTE)", async () => {
  await only({ uriX: "not a valid uri" }, ["URI values cannot have whitespace('not a valid uri')"]);
  await only({ oidX: "oid:1.2.3.4" }, ["URI values cannot start with oid:", "OIDs must start with urn:oid:"]);
  await only({ uuidX: "uuid:abc" }, ["URI values cannot start with uuid:", "UUIDs must start with urn:uuid:"]);
  await only({ canonicalX: "StructureDefinition/x" }, ["Canonical URLs must be absolute URLs if they are not fragment references (StructureDefinition/x)"]);
  await only({ canonicalX: "#frag" }, []);
});

test("checkPrimitive: id / code / string whitespace rules", async () => {
  await only({ idX: "12123/23" }, ["id value '12123/23' is not valid"]);
  await only({ codeX: "asd  asd" }, ["The code 'asd  asd' is not valid (whitespace rules)"]);
  await only({ stringX: "" }, ["value cannot be empty"]);
  await only({ stringX: " \t " }, ["Primitive types should not only be whitespace"], "warning");
  await only({ stringX: " a" }, ["value should not start or finish with whitespace ' a'"], "warning");
  await only({ stringX: "a\u0001" }, ["This content includes the character [1] (hex value). This character is illegal in the XML version of FHIR, and there is generally no valid use for such characters"], "warning");
});

test("checkPrimitive: Resource.id (RESOURCE_RES_ID_MALFORMED_CHARS / _LENGTH)", async () => {
  await only({ id: "a b" }, ["Invalid Resource id: Invalid Characters ('a b')"]);
  await only({ id: "a".repeat(65) }, ["Invalid Resource id: Too long (65 chars)"]);
});

test("checkPrimitive: dates — DATE_VALID, DATETIME_VALID, DATETIME_REGEX (instant), TIME_VALID, DATETIME_REASONABLE", async () => {
  await only({ dateX: "1900-02-29" }, ["Not a valid date format: '1900-02-29'"]);
  await only({ dateX: "2013-04-31" }, ["Not a valid date format: '2013-04-31'"]);
  await only({ dateTimeX: "-0001-01-01" }, ["Not a valid date/time format: '-0001-01-01'"]);
  await only({ dateTimeX: "2013-01-01T12:32:45+13:33.00" }, ["Not a valid date/time format: '2013-01-01T12:32:45+13:33.00'"]);
  await only({ instantX: "1983-01-01T12:32:45" }, ["Not a valid instant format: '1983-01-01T12:32:45'"]);
  await only({ timeX: "24:00:00" }, ["The time '24:00:00' is not a valid time"]);
  await only({ dateX: "1700-01-01" }, ["The value '1700-01-01' is outside the range of reasonable years - check for data entry error"], "warning");
});

test("checkPrimitive: time zone rule only for core definitions; else the type regex (PRIMITIVE_REGEX_TYPE)", async () => {
  await only({ dateTimeX: "2020-01-01T10:00:00" }, ["If a date has a time, it must have a timezone"]);
  const ig = msgs(await run({ meta: { profile: [IG] }, dateTimeX: "2020-01-01T10:00:00" }));
  assert.ok(ig.some((m) => m.startsWith("Element value '2020-01-01T10:00:00' does not meet dateTime regex '")), JSON.stringify(ig));
  // instant year 0000 passes the instant check, fails the type regex
  const inst = msgs(await run({ instantX: "0000-01-01T12:32:45Z" }));
  assert.ok(inst.some((m) => m.startsWith("Element value '0000-01-01T12:32:45Z' does not meet instant regex '")), JSON.stringify(inst));
});

test("checkPrimitive: profile regex extension and maxLength (PRIMITIVE_REGEX, PRIMITIVE_LENGTH)", async () => {
  await only({ stringX: "AB" }, ["Element value 'AB' does not meet regex '[a-z]+'"], "error", [IG]);
  await only({ stringX: "abcd" }, ["value is longer than permitted maximum length of 3"], "error", [IG]);
});

test("checkPrimitive: base64Binary (Base64Util.isValidBase64, BASE64_NO_WS_WARNING)", async () => {
  await only({ base64BinaryX: "YXNhcs2Rhc2Q=" }, ["The value 'YXNhcs2Rhc2Q=' is not a valid Base64 value"]);
  await only({ base64BinaryX: "YXNk YXNk" }, ["Base64 encoded values SHOULD not contain any whitespace (per RFC 4648). Note that non-validating readers are encouraged to accept whitespace anyway"], "warning");
});

test("checkIdentifier: system must be absolute; urn:ietf:rfc:3986 needs a full URI value (TYPE_SPECIFIC_CHECKS_DT_IDENTIFIER_*)", async () => {
  await only({ identifierX: { system: "local-ids", value: "1" } }, ["Identifier.system must be an absolute reference, not a local reference"]);
  await only({ identifierX: { system: "urn:ietf:rfc:3986", value: "1234" } }, ["if identifier.system is 'urn:ietf:rfc:3986', then the identifier.value must be a full URI (e.g. start with a scheme), not '1234'"]);
  await only({ identifierX: { system: "urn:ietf:rfc:3986", value: "urn:oid:1.2.3.4.5" } }, []);
  await only({ identifierX: { system: "https://tools.ietf.org/html/rfc4122", value: "abc" } }, ["The URL 'https://tools.ietf.org/html/rfc4122' is not correct for the identifier 'abc'"]);
});

test("checkAttachment: stated size and hash against inline data; no-content warning (TYPE_SPECIFIC_CHECKS_DT_ATT_*)", async () => {
  const data = Buffer.from("hello").toString("base64");
  await only({ attachmentX: { contentType: "text/plain", data, size: 5 } }, []);
  await only({ attachmentX: { contentType: "text/plain", data, size: 7 } }, ["Stated Attachment Size 7 does not match actual attachment size 5"]);
  await only({ attachmentX: { contentType: "text/plain", data, hash: Buffer.from("x").toString("base64") } }, [
    `The hash of the data did not match the data (stated: 'eA==', actual: 'qvTGHdzF6KLavt4PO0gs2a6pQ00=')`,
  ]);
  await only({ attachmentX: { title: "t" } }, ["Attachments have data and/or url, or else SHOULD have either contentType and/or language"], "warning");
});

test("checkExtension: url required / absolute, modifier use (EXTENSION_EXT_URL_NOTFOUND / _URL_ABSOLUTE / _MODIFIER_Y / _N)", async () => {
  assert.ok(msgs(await run({ extension: [{ valueString: "a" }] })).includes("Extension.url is required in order to identify, use and validate the extension"));
  assert.ok(msgs(await run({ extension: [{ url: "local", valueString: "a" }] })).includes("Extension.url must be an absolute URL"));
  await only({ extension: [{ url: MOD_EXT, valueString: "a" }] }, [`The Extension '${MOD_EXT}' must not be used as an extension (it's a modifierExtension)`]);
  await only({ modifierExtension: [{ url: REG_EXT, valueString: "a" }] }, [`The Extension '${REG_EXT}' must not be used as a modifierExtension (it's a regular extension)`]);
  await only({ modifierExtension: [{ url: MOD_EXT, valueString: "a" }], extension: [{ url: REG_EXT, valueString: "a" }] }, []);
});
