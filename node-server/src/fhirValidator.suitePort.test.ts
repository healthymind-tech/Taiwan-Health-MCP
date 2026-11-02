/**
 * Ports found by comparing the official validator tests with validator_cli 7.0.1 (parity v3): versioned extension urls,
 * primitive `value` children, duration min / maxValue on dates, invariant trace logs and executed-invariant sharing,
 * extension context paths. Expected texts are Messages.properties entries.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { completenessOf, InstanceValidator, type Issue } from "./fhirValidator.js";
import { CORE, FakeResolver, el, sd } from "./fhirTestKit.test.js";

const EXT = "http://acme-test.fhir.test/StructureDefinition/ext";
const CTX = "http://acme-test.fhir.test/StructureDefinition/ctx";
const AGED = "http://acme-test.fhir.test/StructureDefinition/aged";
const FUTURE = "http://acme-test.fhir.test/StructureDefinition/future";
const P_ONE = "http://acme-test.fhir.test/StructureDefinition/one";
const P_TWO = "http://acme-test.fhir.test/StructureDefinition/two";
const P_BOTH = "http://acme-test.fhir.test/StructureDefinition/both";
const TRACE = "http://acme-test.fhir.test/StructureDefinition/trace";

const year = (n: number): Record<string, any> => ({ value: n, unit: "a", system: "http://unitsofmeasure.org", code: "a" });
const named = (url: string, name: string, key: string): Record<string, any> =>
  sd(url, "HumanName", "complex-type", [
    el("HumanName", 0, "*"),
    el("HumanName.family", 0, "1", ["string"], { constraint: [{ key, severity: "error", human: "Always fail", expression: "false" }] }),
  ], { name, version: "0.1.0", baseDefinition: CORE + "HumanName", derivation: "constraint" });
const HUMAN_NAME = sd(CORE + "HumanName", "HumanName", "complex-type", [el("HumanName", 0, "*"), el("HumanName.family", 0, "1", ["string"])]);
const patientWith = (url: string, change: (e: Record<string, any>) => Record<string, any>): Record<string, any> =>
  sd(url, "Patient", "resource", [
    el("Patient", 0, "*"),
    change(el("Patient.birthDate", 0, "1", ["date"])),
    el("Patient.name", 0, "*", ["HumanName"], url === P_BOTH ? { type: [{ code: "HumanName", profile: [P_ONE, P_TWO] }] } : {}),
  ], { baseDefinition: CORE + "Patient", derivation: "constraint" });
const DEFS: Record<string, Record<string, any>> = {
  [EXT]: sd(EXT, "Extension", "complex-type", [
    el("Extension", 0, "*"),
    el("Extension.url", 1, "1", ["uri"], { fixedUri: EXT }),
    el("Extension.value[x]", 1, "1", ["string"]),
  ], { version: "2.0.0", context: [{ type: "element", expression: "Element" }] }),
  [CTX]: sd(CTX, "Extension", "complex-type", [
    el("Extension", 0, "*"),
    el("Extension.url", 1, "1", ["uri"], { fixedUri: CTX }),
    el("Extension.value[x]", 1, "1", ["string"]),
  ], { context: [{ type: "element", expression: "Patient" }, { type: "extension", expression: "http://other.example/x" }] }),
  [AGED]: patientWith(AGED, (e) => ({ ...e, minValueDuration: year(100) })),
  [FUTURE]: patientWith(FUTURE, (e) => ({ ...e, maxValueQuantity: year(10) })),
  [P_ONE]: named(P_ONE, "One", "t1"),
  [P_TWO]: named(P_TWO, "Two", "t1"),
  [P_BOTH]: patientWith(P_BOTH, (e) => e),
  [CORE + "HumanName"]: HUMAN_NAME,
  [TRACE]: patientWith(TRACE, (e) => ({ ...e, constraint: [{ key: "tr-1", severity: "error", human: "Traced", expression: "$this.trace('seen').empty()" }] })),
};

class Resolver extends FakeResolver {
  override async fetchStructureDefinition(url: string): Promise<Record<string, any> | null> {
    return DEFS[url.split("|")[0]] ?? super.fetchStructureDefinition(url);
  }
}
async function run(resource: Record<string, any>, profiles: string[] = [], relativeDatePlaceHolder?: string): Promise<Issue[]> {
  return new InstanceValidator(new Resolver()).validate(resource, { profiles, relativeDatePlaceHolder });
}
const errors = (issues: Issue[]): string[] => issues.filter((i) => i.severity === "error").map((i) => i.message);

test("checkExtension: a version in the extension url is judged, the definition is found without it", async () => {
  const other = await run({ resourceType: "Patient", extension: [{ url: `${EXT}|1.0.0`, valueString: "x" }] });
  assert.ok(errors(other).includes("The extension URL must not contain a version. The extension was validated against version 2.0.0 of the extension"), errors(other).join("\n"));
  const same = await run({ resourceType: "Patient", extension: [{ url: `${EXT}|2.0.0`, valueString: "x" }] });
  assert.ok(errors(same).includes("The extension URL must not contain a version"), errors(same).join("\n"));
  const unknown = await run({ resourceType: "Patient", extension: [{ url: "http://acme-test.fhir.test/none|1.0.0", valueString: "x" }] });
  assert.ok(unknown.some((i) => i.severity === "warning" && i.message.startsWith("Extension URLs don't have versions.")));
});

test("checkExtensionContext: a choice is `value.ofType(t)`, [x] is stripped, and a failed extension context shows the url last", async () => {
  const issues = await run({
    resourceType: "Patient",
    extension: [{ url: EXT, valueString: "x", _valueString: { extension: [{ url: CTX, valueString: "y" }] } }],
  });
  const m = errors(issues).find((e) => e.includes("is not allowed to be used at this point"));
  assert.ok(m, errors(issues).join("\n"));
  assert.ok(m.includes(`[Extension.value, Extension.value.ofType(string), Extension.valuestring, Patient.extension.value, Patient.extension.value.ofType(string), Patient.extension.valuestring, string, ${EXT}]`), m);
});

test("checkPrimitive: a `value` in the shadow object is a child: ILLEGAL_PROPERTY, and neither ele-1 nor 'unrecognized'", async () => {
  const got = errors(await run({ resourceType: "Patient", _birthDate: { value: "1990" } }));
  assert.deepEqual(got, ["The property 'value' is invalid"]);
});

test("checkMinMaxValueDate: a duration before / after now, the limit printed unless the advisor has a placeholder", async () => {
  assert.deepEqual(errors(await run({ resourceType: "Patient", birthDate: "2020-01-01" }, [AGED], "XXX")), []);
  const old = errors(await run({ resourceType: "Patient", birthDate: "1850-01-01" }, [AGED], "XXX"));
  assert.deepEqual(old, ["The date/time value 'DateTimeType[1850-01-01]' is not legal: minValue is 100a before now (which is XXX)"]);
  const late = errors(await run({ resourceType: "Patient", birthDate: "2100-01" }, [FUTURE], "XXX"));
  assert.deepEqual(late, ["The date/time value '2100-01-01' is not legal: maxValue is 10a after now (which is XXX)"]);
  const shown = errors(await run({ resourceType: "Patient", birthDate: "2100-01-01" }, [FUTURE]));
  assert.match(shown[0], /\(which is \d{4}-\d{2}-\d{2}\)$/);
});

test("checkInvariant: fpe.forLog follows a failed invariant (trace())", async () => {
  const got = errors(await run({ resourceType: "Patient", birthDate: "1990-01-01" }, [TRACE]));
  assert.ok(got.some((m) => m.startsWith("Constraint failed: tr-1: 'Traced'") && m.endsWith(" (seen: 1990-01-01) (log:  (seen: 1990-01-01))")), got.join("\n"));
});

test("a signature the jar would verify marks the run: rules_unchecked, checked_fully false", async () => {
  const header = Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url");
  const bundle = { resourceType: "Bundle", type: "collection", signature: { sigFormat: "application/jose", data: Buffer.from(`${header}..sig`).toString("base64") } };
  const c = completenessOf(await run(bundle));
  assert.equal(c.checked_fully, false);
  assert.deepEqual(c.rules_unchecked, ["BundleValidator.validateSignatureJose"]);
  const image = completenessOf(await run({ ...bundle, signature: { sigFormat: "image/png", data: "AAAA" } }));
  assert.equal(image.rules_unchecked, undefined);
});

test("checkInvariants: profiles sharing an expression share the message object, which collects both tags", async () => {
  const got = errors(await run({ resourceType: "Patient", name: [{ family: "x" }] }, [P_BOTH]));
  const tagged = got.filter((m) => m.startsWith("Constraint failed: t1"));
  assert.equal(tagged.length, 1, got.join("\n"));
  assert.match(tagged[0], /validating against .*one\|0\.1\.0 \[One\]/);
  assert.match(tagged[0], /validating against .*two\|0\.1\.0 \[Two\]/);
});

