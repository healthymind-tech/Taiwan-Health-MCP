/**
 * parity v3 (review-structure): REVIEW_port_1 findings ported from InstanceValidator (HL7 validator 7.0.1). Each test
 * reproduces the review's case with synthetic definitions; expected texts are the Messages.properties templates.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { InstanceValidator, type Issue } from "./fhirValidator.js";
import { CORE, FakeResolver, SDS, el, sd } from "./fhirTestKit.test.js";

type Json = Record<string, any>;
const EXTRA: Record<string, Json> = {};
class Resolver extends FakeResolver {
  override async fetchStructureDefinition(url: string): Promise<Json | null> {
    return EXTRA[url.split("|")[0]] ?? super.fetchStructureDefinition(url);
  }
}
async function run(resource: Json, profiles: string[] = []): Promise<Issue[]> {
  return new InstanceValidator(new Resolver()).validate(resource, { profiles });
}
const errs = (issues: Issue[], sev = "error"): Array<[string, string]> => issues.filter((i) => i.severity === sev).map((i) => [i.path, i.message]);
const DAR = "http://hl7.org/fhir/StructureDefinition/data-absent-reason";
EXTRA[DAR] = sd(DAR, "Extension", "complex-type", [
  el("Extension", 0, "*"),
  el("Extension.extension", 0, "0", ["Extension"]),
  el("Extension.url", 1, "1", ["uri"], { fixedUri: DAR }),
  el("Extension.value[x]", 1, "1", ["code"]),
], { context: [{ type: "element", expression: "Element" }] });

test("F1 checkPrimitive: no value + required binding → Terminology_TX_Code_ValueSet_MISSING (IV l. 3245-3253)", async () => {
  const issues = await run({ resourceType: "Patient", _gender: { extension: [{ url: DAR, valueCode: "unknown" }] } });
  assert.deepEqual(errs(issues), [["Patient.gender", "No code provided, and a code is required from the value set"]]);
  // blank string: same branch (plus NOTEMPTY when there are no children)
  const blank = await run({ resourceType: "Patient", gender: "", _gender: { extension: [{ url: DAR, valueCode: "unknown" }] } });
  assert.deepEqual(errs(blank), [["Patient.gender", "No code provided, and a code is required from the value set"]]);
  // a cross-version extension carrying the code: a warning instead (Terminology_TX_Code_ValueSet_XVER_SOURCE)
  const xv = "http://hl7.org/fhir/5.0/StructureDefinition/extension-Patient.gender";
  const xi = await run({ resourceType: "Patient", _gender: { extension: [{ url: xv, valueCode: "other" }] } });
  assert.ok(!errs(xi).some(([, m]) => m.startsWith("No code provided")), JSON.stringify(errs(xi)));
  assert.ok(errs(xi, "warning").some(([, m]) => m.startsWith("Though a code is required, no code has been provided; instead, an alternative code 'other' is provided in the cross-version extension")));
});

test("F1 checkPrimitive: no value + mustHaveValue / valueAlternatives", async () => {
  const P = "http://example.org/fhir/StructureDefinition/pat-mhv";
  EXTRA[P] = sd(P, "Patient", "resource", [
    ...SDS[CORE + "Patient"].snapshot.element.filter((e: Json) => e.path !== "Patient.birthDate" && e.path !== "Patient.active"),
    el("Patient.birthDate", 0, "1", ["date"], { mustHaveValue: true }),
    el("Patient.active", 0, "1", ["boolean"], { valueAlternatives: [DAR] }),
  ], { baseDefinition: CORE + "Patient", derivation: "constraint", version: "1.0" });
  const other = "http://example.org/x/StructureDefinition/other";
  const issues = await run({ resourceType: "Patient", _birthDate: { id: "a" }, _active: { extension: [{ url: other, valueString: "x" }] } }, [P]);
  const m = errs(issues).map(([p, x]) => `${p}: ${x}`);
  assert.ok(m.includes(`Patient.birthDate: The element definition \`\`Patient.birthDate\`\` in the profile '${P}|1.0' requires that a value be present in this element`), JSON.stringify(m));
  // rulePlural shifts the arguments: (count, element id, profile) — validator_cli prints it this way (fhir-test-cases R4.patient-value-alternative-bad-profile)
  assert.ok(m.includes(`Patient.active: The element definition \`\`1\`\` in the profile 'Patient.active' requires that if a value is not present, the extension '${P}|1.0' must be present`), JSON.stringify(m));
});

test("F7 inline children of a primitive (`_x.extension`) are validated against the profile's slices (IV l. 8164-8176)", async () => {
  const SUF = "http://acme-test.fhir.test/StructureDefinition/suffix";
  EXTRA[SUF] = sd(SUF, "Extension", "complex-type", [
    el("Extension", 0, "*"),
    el("Extension.extension", 0, "0", ["Extension"]),
    el("Extension.url", 1, "1", ["uri"], { fixedUri: SUF }),
    el("Extension.value[x]", 1, "1", ["string"]),
  ], { context: [{ type: "element", expression: "Element" }] });
  const P = "http://example.org/fhir/StructureDefinition/pat-inline";
  const slicing = { discriminator: [{ type: "value", path: "url" }], rules: "open" };
  EXTRA[P] = sd(P, "Patient", "resource", [
    ...SDS[CORE + "Patient"].snapshot.element.filter((e: Json) => e.path !== "Patient.birthDate" && e.path !== "Patient.gender"),
    el("Patient.gender", 0, "1", ["code"], { binding: { strength: "required", valueSet: "http://hl7.org/fhir/ValueSet/administrative-gender|4.0.1" } }),
    el("Patient.gender.id", 0, "1", ["string"]),
    el("Patient.gender.extension", 0, "*", ["Extension"], { slicing }),
    el("Patient.gender.extension:sfx", 0, "1", [], { type: [{ code: "Extension", profile: [SUF] }], sliceName: "sfx" }),
    el("Patient.gender.value", 0, "1", []),
    el("Patient.birthDate", 0, "1", ["date"]),
    el("Patient.birthDate.id", 0, "1", ["string"]),
    el("Patient.birthDate.extension", 0, "*", ["Extension"], { slicing }),
    el("Patient.birthDate.extension:bt", 1, "1", [], { type: [{ code: "Extension", profile: [SUF] }], sliceName: "bt" }),
    el("Patient.birthDate.value", 0, "1", []),
  ], { baseDefinition: CORE + "Patient", derivation: "constraint" });
  const two = { extension: [{ url: SUF, valueString: "a" }, { url: SUF, valueString: "b" }] };
  const res = { resourceType: "Patient", gender: "male", _gender: two, birthDate: "2000-01-01", _birthDate: { id: "x" } };
  const m = errs(await run(res, [P])).map(([p, x]) => `${p}: ${x}`);
  assert.ok(m.includes(`Patient.gender: Patient.gender.extension:sfx: max allowed = 1, but found 2 (from ${P})`), JSON.stringify(m));
  assert.ok(m.includes(`Patient.birthDate: Slice 'Patient.birthDate.extension:bt' for extension '${SUF}': a matching slice is required, but not found (from ${P}). Note that other slices are allowed in addition to this required slice`), JSON.stringify(m));
  // without the profile: no slice errors
  assert.deepEqual(errs(await run(res)), []);
});

test("F3 DUPLICATE_ID: element ids within one resource (IV l. 7711-7718)", async () => {
  const dup = await run({ resourceType: "Patient", identifier: [{ id: "x", value: "1" }, { id: "x", value: "2" }] });
  assert.deepEqual(errs(dup), [["Patient.identifier[1]", "Duplicate id value 'x'"]]);
  // a primitive's id (`_x.id`) is in the same scope; the resource id is not (a reset point)
  const prim = await run({ resourceType: "Patient", id: "x", identifier: [{ id: "y", value: "1" }], birthDate: "2000-01-01", _birthDate: { id: "y" } });
  assert.deepEqual(errs(prim), [["Patient.birthDate", "Duplicate id value 'y'"]]);
  assert.deepEqual(errs(await run({ resourceType: "Patient", id: "x", identifier: [{ id: "x", value: "1" }] })), []);
  // the same element validated against a profile and the base is not a duplicate
  assert.deepEqual(errs(await run({ resourceType: "Patient", identifier: [{ id: "x", value: "1" }] }, [CORE + "Patient"])), []);
});

test("F3 contained: RESOURCE_DUPLICATE_CONTAINED_ID (IV l. 7533-7545) and RESOURCE_RES_ID_MISSING (IV l. 9017)", async () => {
  const issues = await run({
    resourceType: "Patient",
    contained: [{ resourceType: "Organization", id: "o", name: "a" }, { resourceType: "Organization", id: "o", name: "b" }],
    managingOrganization: { reference: "#o" },
  });
  assert.ok(errs(issues).some(([p, m]) => p === "Patient.contained[1]" && m === "Duplicate ID for contained resource: o"), JSON.stringify(errs(issues)));
  const noId = await run({ resourceType: "Patient", contained: [{ resourceType: "Organization", name: "a" }] });
  assert.ok(errs(noId).some(([p, m]) => p === "Patient.contained[0]" && m === "Resource requires an id, but none is present"), JSON.stringify(errs(noId)));
  // the ids of different contained resources' elements are separate scopes
  const sep = await run({
    resourceType: "Patient",
    identifier: [{ id: "i", value: "1" }],
    contained: [{ resourceType: "Organization", id: "o", name: "a", _name: { id: "i" } }],
    managingOrganization: { reference: "#o" },
  });
  assert.ok(!errs(sep).some(([, m]) => m.startsWith("Duplicate")), JSON.stringify(errs(sep)));
});

test("F8 checkQuantity: coded unit, required UCUM binding, min / maxValue Quantity (IV l. 4618-4712)", async () => {
  const BW = "http://example.org/fhir/ValueSet/ucum-bw";
  const vs = { resourceType: "ValueSet", url: BW, version: "1", title: "BW", compose: { include: [{ system: "http://unitsofmeasure.org", concept: [{ code: "kg" }, { code: "g" }] }] } };
  class R2 extends Resolver {
    override async fetchValueSet(url: string): Promise<Json | null> {
      return url.split("|")[0] === BW ? vs : super.fetchValueSet(url);
    }
  }
  const P = "http://example.org/fhir/StructureDefinition/obs-qty";
  EXTRA[P] = sd(P, "Observation", "resource", [
    ...SDS[CORE + "Observation"].snapshot.element.filter((e: Json) => e.path !== "Observation.value[x]" && e.path !== "Observation.component.value[x]"),
    el("Observation.value[x]", 0, "1", ["Quantity"], { binding: { strength: "required", valueSet: BW }, minValueQuantity: { value: 10, system: "http://unitsofmeasure.org", code: "kg" } }),
    el("Observation.component.value[x]", 0, "1", ["Quantity"], { maxValueQuantity: { value: 5, system: "http://unitsofmeasure.org", code: "kg" } }),
  ], { baseDefinition: CORE + "Observation", derivation: "constraint" });
  const obs = (q: Json, comp?: Json): Json => ({
    resourceType: "Observation", status: "final", code: { text: "x" }, valueQuantity: q,
    ...(comp ? { component: [{ code: { text: "c" }, valueQuantity: comp }] } : {}),
  });
  const v = (r: Json, profiles: string[] = []): Promise<Issue[]> => new InstanceValidator(new R2()).validate(r, { profiles });
  const U = "http://unitsofmeasure.org";
  // non-UCUM system, no binding: the code is checked in its CodeSystem
  const cs = "http://terminology.hl7.org/CodeSystem/observation-category";
  const e1 = errs(await v(obs({ value: 1, system: cs, code: "NOTACODE" })));
  assert.ok(e1.some(([, m]) => m === `Unknown code 'NOTACODE' in the CodeSystem '${cs}'`), JSON.stringify(e1));
  // required UCUM binding (enumerated) → TERMINOLOGY_TX_CONFIRM_4a
  const e2 = errs(await v(obs({ value: 20, system: U, code: "mm" }), [P])).map(([, m]) => m);
  assert.ok(e2.some((m) => m.startsWith(`The code provided (${U}#mm) was not found in the value set 'BW' (${BW}|1), and a code from this value set is required`)), JSON.stringify(e2));
  // minValue, same unit: literal {2} / {3} (Java passes the arguments as {0} / {1})
  const e3 = errs(await v(obs({ value: 1, system: U, code: "kg" }), [P])).map(([, m]) => m);
  assert.deepEqual(e3, ["The value in the instance ({2}) is less than the specified minimum value ({3})"]);
  // minValue after UCUM conversion; maxValue on the component
  const e4 = errs(await v(obs({ value: 900, system: U, code: "g" }, { value: 11000, system: U, code: "g" }), [P])).map(([, m]) => m);
  assert.deepEqual(e4.sort(), [
    "The value in the instance (11000 g) is greater than the specified maxValue (5 kg) after UCUM conversion",
    "The value in the instance (900 g) is less than the specified minValue (10 kg) after UCUM conversion",
  ]);
  assert.deepEqual(errs(await v(obs({ value: 12000, system: U, code: "g" }), [P])), []);
});

test("F11 unresolvable unversioned type profile / target profile are errors (IV l. 8113, l. 5361-5371)", async () => {
  const P = "http://example.org/fhir/StructureDefinition/pat-nope";
  const NOPE = "http://acme-test.fhir.test/nope/TypeProfile";
  const NOPE_T = "http://acme-test.fhir.test/nope/OrgProfile";
  EXTRA[P] = sd(P, "Patient", "resource", [
    ...SDS[CORE + "Patient"].snapshot.element.filter((e: Json) => e.path !== "Patient.identifier" && e.path !== "Patient.managingOrganization"),
    el("Patient.identifier", 0, "*", [], { type: [{ code: "Identifier", profile: [NOPE] }] }),
    el("Patient.managingOrganization", 0, "1", [], { type: [{ code: "Reference", targetProfile: [NOPE_T] }] }),
  ], { baseDefinition: CORE + "Patient", derivation: "constraint" });
  const m = errs(await run({
    resourceType: "Patient",
    identifier: [{ value: "1" }],
    contained: [{ resourceType: "Organization", id: "o", name: "x" }],
    managingOrganization: { reference: "#o" },
  }, [P]));
  assert.ok(m.some(([p, x]) => p === "Patient.identifier[0]" && x === `Unknown profile ${NOPE}`), JSON.stringify(m));
  assert.ok(m.some(([p, x]) => p === "Patient.managingOrganization" && x === `Unable to resolve the profile reference '${NOPE_T}'`), JSON.stringify(m));
  assert.ok(m.some(([p, x]) => p === "Patient.managingOrganization" && x.startsWith("Invalid Resource target type. Found Organization")), JSON.stringify(m));
});

test("F12 resource type restrictions of Resource-typed elements (IV l. 7502-7519, 7633-7648, 7876-7895)", async () => {
  const P = "http://example.org/fhir/StructureDefinition/pat-contained-type";
  const ORGP = "http://example.org/fhir/StructureDefinition/org-p";
  EXTRA[ORGP] = { ...SDS[CORE + "Organization"], url: ORGP, baseDefinition: CORE + "Organization", derivation: "constraint" };
  EXTRA[P] = sd(P, "Patient", "resource", [
    ...SDS[CORE + "Patient"].snapshot.element.filter((e: Json) => e.path !== "Patient.contained"),
    el("Patient.contained", 0, "*", ["Practitioner"]),
  ], { baseDefinition: CORE + "Patient", derivation: "constraint", version: "1" });
  const res = { resourceType: "Patient", contained: [{ resourceType: "Organization", id: "o", name: "x" }], managingOrganization: { reference: "#o" } };
  const m = errs(await run(res, [P]));
  assert.ok(m.some(([p, x]) => p === "Patient.contained[0]" && x === "The type 'Organization' is not valid - no resources allowed here (allowed = Practitioner)"), JSON.stringify(m));
  assert.ok(m.some(([p, x]) => p === "Patient.contained[0]" && x === `The Profile '${P}|1' definition allows for the type Practitioner but found type Organization`), JSON.stringify(m));
  // Resource with a profile of another type → BUNDLE_BUNDLE_ENTRY_TYPE2 (Java leaves {2} unformatted)
  const P2 = "http://example.org/fhir/StructureDefinition/pat-contained-prof";
  EXTRA[P2] = sd(P2, "Patient", "resource", [
    ...SDS[CORE + "Patient"].snapshot.element.filter((e: Json) => e.path !== "Patient.contained"),
    el("Patient.contained", 0, "*", [], { type: [{ code: "Resource", profile: [ORGP] }] }),
  ], { baseDefinition: CORE + "Patient", derivation: "constraint" });
  const m2 = errs(await run({ resourceType: "Patient", contained: [{ resourceType: "Patient", id: "o" }], managingOrganization: { reference: "#o" } }, [P2]));
  assert.ok(m2.some(([p, x]) => p === "Patient.contained[0]" && x === "The type 'Patient' is not valid - must be Organization (allowed = {2})"), JSON.stringify(m2));
  // the right type passes
  const ok = errs(await run(res, [P2]));
  assert.ok(!ok.some(([, x]) => x.startsWith("The type 'Organization' is not valid")), JSON.stringify(ok));
});

test("F25 several types, none matching: Reference first → validated as Reference, else VALIDATION_VAL_PROFILE_NOTYPE (IV l. 7950-7956)", async () => {
  const P = "http://example.org/fhir/StructureDefinition/obs-notype";
  const P2 = "http://example.org/fhir/StructureDefinition/obs-notype-ref";
  const base = SDS[CORE + "Observation"].snapshot.element.filter((e: Json) => e.path !== "Observation.value[x]");
  EXTRA[P] = sd(P, "Observation", "resource", [...base, el("Observation.value[x]", 0, "1", ["Quantity", "CodeableConcept"])], { baseDefinition: CORE + "Observation", derivation: "constraint" });
  EXTRA[P2] = sd(P2, "Observation", "resource", [...base, el("Observation.value[x]", 0, "1", ["Reference", "Quantity"])], { baseDefinition: CORE + "Observation", derivation: "constraint" });
  const obs = { resourceType: "Observation", status: "final", code: { text: "x" }, valueString: "s" };
  const m = errs(await run(obs, [P]));
  assert.ok(m.some(([p, x]) => p === "Observation" && x === "The type of element valueString is not known - it could not be determined from the information available. Valid types at this point are Quantity, CodeableConcept"), JSON.stringify(m));
  assert.deepEqual(errs(await run(obs, [P2])), []);
});

test("F13 '#' internal URLs must resolve (IV validateReference l. 3946-3984)", async () => {
  EXTRA[CORE + "Basic"] = sd(CORE + "Basic", "Basic", "resource", [
    el("Basic", 0, "*"),
    el("Basic.id", 0, "1", ["string"], { base: { path: "Resource.id", min: 0, max: "1" } }),
    el("Basic.implicitRules", 0, "1", ["uri"], { base: { path: "Resource.implicitRules", min: 0, max: "1" } }),
    el("Basic.text", 0, "1", ["Narrative"]),
    el("Basic.contained", 0, "*", ["Resource"]),
    el("Basic.extension", 0, "*", ["Extension"]),
    el("Basic.modifierExtension", 0, "*", ["Extension"]),
    el("Basic.code", 0, "1", ["CodeableConcept"]),
    el("Basic.canonX", 0, "*", ["canonical"], { base: { path: "Basic.canonX", min: 0, max: "*" } }),
  ]);
  const r = (x: Json): Json => ({ resourceType: "Basic", code: { text: "c" }, ...x });
  const e1 = await run(r({ canonX: ["#nope"] }));
  assert.ok(errs(e1).some(([p, m]) => p === "Basic.canonX[0]" && m === "The URL value '#nope' is invalid because there is no matching target"), JSON.stringify(errs(e1)));
  // a uri: only a warning (TYPE_SPECIFIC_CHECKS_DT_URL_INTERNAL_WARN)
  const e2 = await run(r({ implicitRules: "#nope" }));
  assert.ok(!errs(e2).some(([, m]) => m.includes("#nope")), JSON.stringify(errs(e2)));
  assert.ok(errs(e2, "warning").some(([p, m]) => p === "Basic.implicitRules" && m.startsWith("The URL value '#nope' might be wrong")));
  // a matching element id resolves
  const e3 = await run(r({ canonX: ["#c1"], code: { id: "c1", text: "c" } }));
  assert.ok(!errs(e3).some(([, m]) => m.includes("#c1")), JSON.stringify(errs(e3)));
  delete EXTRA[CORE + "Basic"];
});

test("F14 re-slices are kept and counted (IV matchSlice l. 8667-8690, checkCardinalities l. 8334-8370)", async () => {
  const P = "http://example.org/fhir/StructureDefinition/pat-reslice";
  EXTRA[P] = sd(P, "Patient", "resource", [
    ...SDS[CORE + "Patient"].snapshot.element.filter((e: Json) => !e.path.startsWith("Patient.identifier")),
    el("Patient.identifier", 0, "*", ["Identifier"], { slicing: { discriminator: [{ type: "value", path: "system" }], rules: "open" } }),
    el("Patient.identifier:a", 0, "*", ["Identifier"], { sliceName: "a" }),
    el("Patient.identifier:a.system", 1, "1", ["uri"], { fixedUri: "http://acme-test.fhir.test/a" }),
    el("Patient.identifier:a.value", 0, "1", ["string"]),
    el("Patient.identifier:a/b", 1, "1", ["Identifier"], { sliceName: "a/b" }),
    el("Patient.identifier:a/b.system", 1, "1", ["uri"], { fixedUri: "http://acme-test.fhir.test/b" }),
    el("Patient.identifier:a/b.value", 0, "1", ["string"]),
  ], { baseDefinition: CORE + "Patient", derivation: "constraint" });
  const m = errs(await run({ resourceType: "Patient", identifier: [{ system: "http://acme-test.fhir.test/a", value: "1" }] }, [P]));
  assert.ok(m.some(([p, x]) => p === "Patient" && x === `Slice 'Patient.identifier:a/b': a matching slice is required, but not found (from ${P}). Note that other slices are allowed in addition to this required slice`), JSON.stringify(m));
  assert.deepEqual(errs(await run({ resourceType: "Patient", identifier: [{ system: "http://acme-test.fhir.test/b", value: "1" }] }, [P])), []);
});

test("F16 structuredefinition-imposeProfile (IV validateResource l. 6916-6936, 6982-6998)", async () => {
  const IMP = "http://example.org/fhir/StructureDefinition/pat-imposed";
  const P = "http://example.org/fhir/StructureDefinition/pat-imposing";
  const MISSING = "http://acme-test.fhir.test/StructureDefinition/missing";
  EXTRA[IMP] = sd(IMP, "Patient", "resource", [
    ...SDS[CORE + "Patient"].snapshot.element.filter((e: Json) => e.path !== "Patient.birthDate"),
    el("Patient.birthDate", 1, "1", ["date"]),
  ], { baseDefinition: CORE + "Patient", derivation: "constraint" });
  const ext = (u: string): Json => ({ url: "http://hl7.org/fhir/StructureDefinition/structuredefinition-imposeProfile", valueCanonical: u });
  EXTRA[P] = { ...SDS[CORE + "Patient"], url: P, baseDefinition: CORE + "Patient", derivation: "constraint", version: "2", extension: [ext(IMP), ext(MISSING)] };
  const issues = await run({ resourceType: "Patient", meta: { profile: [P] } });
  assert.ok(errs(issues).some(([p, m]) => p === "Patient" && m === `Patient.birthDate: minimum required = 1, but only found 0 (from ${IMP})`), JSON.stringify(errs(issues)));
  assert.ok(errs(issues, "warning").some(([p, m]) => p === "Patient.meta.profile[0]" && m.startsWith(`Profile ${P}|2 identifies ${MISSING} as a dependency`)), JSON.stringify(errs(issues, "warning")));
});

test("F17 extension context: fhirpath and profile#path contexts are evaluated (IV l. 2785-2858, 2973-3001)", async () => {
  const mk = (url: string, context: Json[]): Json =>
    sd(url, "Extension", "complex-type", [
      el("Extension", 0, "*"),
      el("Extension.extension", 0, "0", ["Extension"]),
      el("Extension.url", 1, "1", ["uri"], { fixedUri: url }),
      el("Extension.value[x]", 1, "1", ["string"]),
    ], { context });
  const FP = "http://acme-test.fhir.test/StructureDefinition/ctx-fhirpath";
  const PR = "http://acme-test.fhir.test/StructureDefinition/ctx-profile";
  const NOPE = "http://acme-test.fhir.test/StructureDefinition/no-such-profile";
  EXTRA[FP] = mk(FP, [{ type: "fhirpath", expression: "name" }]);
  EXTRA[PR] = mk(PR, [{ type: "element", expression: `${NOPE}#Patient` }]);
  const onRoot = errs(await run({ resourceType: "Patient", extension: [{ url: FP, valueString: "x" }] }));
  assert.ok(onRoot.some(([p, m]) => p === "Patient" && m.startsWith(`The extension ${FP} is not allowed to be used at this point`) && m.endsWith("allowed for this version = p:name)")), JSON.stringify(onRoot));
  const onName = errs(await run({ resourceType: "Patient", name: [{ family: "f", extension: [{ url: FP, valueString: "x" }] }] }));
  assert.ok(!onName.some(([, m]) => m.includes("not allowed to be used at this point")), JSON.stringify(onName));
  const prof = errs(await run({ resourceType: "Patient", extension: [{ url: PR, valueString: "x" }] }));
  assert.ok(prof.some(([, m]) => m === `The extension ${PR} specifies a context of ${NOPE}#Patient but the validator cannot find that profile`), JSON.stringify(prof));
  assert.ok(prof.some(([, m]) => m.startsWith(`The extension ${PR} is not allowed to be used at this point`)), JSON.stringify(prof));
});

test("F19 fixed / pattern type rules: HumanName list lengths, Address partial compare (IV l. 1171-1221, 3139-3195)", async () => {
  const P = "http://example.org/fhir/StructureDefinition/pat-pattern-name";
  EXTRA[CORE + "HumanName"] ??= sd(CORE + "HumanName", "HumanName", "complex-type", [
    el("HumanName", 0, "*"),
    el("HumanName.family", 0, "1", ["string"]),
    el("HumanName.given", 0, "*", ["string"]),
  ]);
  EXTRA[P] = sd(P, "Patient", "resource", [
    ...SDS[CORE + "Patient"].snapshot.element,
    el("Patient.name", 0, "*", ["HumanName"], { patternHumanName: { given: ["A"] } }),
    el("Patient.address", 0, "*", ["Address"], { patternAddress: { city: "Taipei", district: "X" } }),
  ], { baseDefinition: CORE + "Patient", derivation: "constraint" });
  const m = errs(await run({ resourceType: "Patient", name: [{ given: ["A", "B"] }] }, [P]));
  assert.ok(m.some(([p, x]) => p === "Patient.name[0]" && x === "Expected 1 but found 2 given elements"), JSON.stringify(m));
  assert.ok(!errs(await run({ resourceType: "Patient", name: [{ given: ["A"] }] }, [P])).some(([, x]) => x.includes("given elements")));
  // Address: district is not compared (only use / text / city / state / country / zip / line)
  const a = errs(await run({ resourceType: "Patient", address: [{ city: "Taipei", district: "Y" }] }, [P]));
  assert.ok(!a.some(([, x]) => x.includes("fixed to") || x.startsWith("Missing element")), JSON.stringify(a));
  delete EXTRA[CORE + "HumanName"];
});

test("F15 a type profile and inline children are both validated (IV checkChildByDefinition l. 8094-8176)", async () => {
  const CC = "http://example.org/fhir/StructureDefinition/cc-text";
  EXTRA[CC] = sd(CC, "CodeableConcept", "complex-type", [
    ...SDS[CORE + "CodeableConcept"].snapshot.element.filter((e: Json) => e.path !== "CodeableConcept.text"),
    el("CodeableConcept.text", 1, "1", ["string"]),
  ], { baseDefinition: CORE + "CodeableConcept", derivation: "constraint" });
  const P = "http://example.org/fhir/StructureDefinition/obs-cc-inline";
  EXTRA[P] = sd(P, "Observation", "resource", [
    ...SDS[CORE + "Observation"].snapshot.element.filter((e: Json) => !e.path.startsWith("Observation.code")),
    el("Observation.code", 1, "1", [], { type: [{ code: "CodeableConcept", profile: [CC] }] }),
    el("Observation.code.coding", 0, "*", ["Coding"]),
    el("Observation.code.text", 0, "1", ["string"]),
  ], { baseDefinition: CORE + "Observation", derivation: "constraint" });
  const m = errs(await run({ resourceType: "Observation", status: "final", code: { coding: [{ system: "http://acme-test.fhir.test/cs", code: "x" }] } }, [P]));
  assert.ok(m.some(([p, x]) => p === "Observation.code" && x === `CodeableConcept.text: minimum required = 1, but only found 0 (from ${CC})`), JSON.stringify(m));
});

test("F24 cross-version extensions: generated definitions (XVerExtensionManagerOld, BaseValidator.getXverExt l. 1698-1728)", async () => {
  const X = "http://hl7.org/fhir/5.0/StructureDefinition/extension-Patient.link.type";
  const ok = await run({ resourceType: "Patient", extension: [{ url: X, valueCode: "seealso" }] });
  assert.deepEqual(errs(ok), []);
  // used outside its context (Patient.link): EXTENSION_EXTP_CONTEXT_WRONG_XVER, a warning
  assert.ok(errs(ok, "warning").some(([, m]) => m.startsWith(`The extension ${X} v4.0.1 from FHIR version 5.0 is not allowed to be used at this point`)), JSON.stringify(errs(ok, "warning")));
  const unknown = "http://hl7.org/fhir/5.0/StructureDefinition/extension-Patient.noSuchElement";
  const u = errs(await run({ resourceType: "Patient", extension: [{ url: unknown, valueCode: "x" }] }));
  assert.deepEqual(u, [[`Patient.extension[0][url='${unknown}']`, `Extension url '${unknown}' is not valid (invalid Element id 'Patient.noSuchElement')`]]);
  const badVer = "http://hl7.org/fhir/9.9/StructureDefinition/extension-Patient.link.type";
  const b = errs(await run({ resourceType: "Patient", extension: [{ url: badVer, valueCode: "x" }] }));
  assert.deepEqual(b, [[`Patient.extension[0][url='${badVer}']`, `Extension url '${badVer}' is not valid (invalid Version '9.9')`]]);
});

test("F19 fixed Timing: event count (Bundle_MSG_Event_Count), code not compared (IV checkTiming l. 5663-5675)", async () => {
  const P = "http://example.org/fhir/StructureDefinition/obs-timing";
  EXTRA[CORE + "Timing"] ??= sd(CORE + "Timing", "Timing", "complex-type", [
    el("Timing", 0, "*"),
    el("Timing.event", 0, "*", ["dateTime"]),
    el("Timing.code", 0, "1", ["CodeableConcept"]),
  ]);
  EXTRA[P] = sd(P, "Observation", "resource", [
    ...SDS[CORE + "Observation"].snapshot.element.filter((e: Json) => e.path !== "Observation.effective[x]"),
    el("Observation.effective[x]", 0, "1", ["Timing"], { fixedTiming: { event: ["2020-01-01"], code: { text: "a" } } }),
  ], { baseDefinition: CORE + "Observation", derivation: "constraint" });
  const obs = (t: Json): Json => ({ resourceType: "Observation", status: "final", code: { text: "x" }, effectiveTiming: t });
  const two = errs(await run(obs({ event: ["2020-01-01", "2020-01-02"], code: { text: "a" } }), [P])).map(([, m]) => m);
  assert.ok(two.includes("Expected 1 but found 2 event elements"), JSON.stringify(two));
  const codeless = errs(await run(obs({ event: ["2020-01-01"] }), [P])).map(([, m]) => m);
  assert.ok(!codeless.some((m) => m.includes("code")), JSON.stringify(codeless));
  delete EXTRA[CORE + "Timing"];
});

test("F19 fixed ContactPoint / Attachment compare only Java's fields (IV checkContactPoint l. 2572, checkAttachment l. 1223)", async () => {
  const P = "http://example.org/fhir/StructureDefinition/pat-fixed-cp";
  EXTRA[CORE + "ContactPoint"] ??= sd(CORE + "ContactPoint", "ContactPoint", "complex-type", [
    el("ContactPoint", 0, "*"),
    el("ContactPoint.system", 0, "1", ["code"]),
    el("ContactPoint.value", 0, "1", ["string"]),
    el("ContactPoint.rank", 0, "1", ["positiveInt"]),
  ]);
  EXTRA[P] = sd(P, "Patient", "resource", [
    ...SDS[CORE + "Patient"].snapshot.element,
    el("Patient.telecom", 0, "*", ["ContactPoint"], { fixedContactPoint: { system: "phone" } }),
  ], { baseDefinition: CORE + "Patient", derivation: "constraint" });
  // rank is not compared by checkContactPoint; value is (absent in the fixed value → not allowed)
  const m = errs(await run({ resourceType: "Patient", telecom: [{ system: "phone", rank: 1, value: "1" }] }, [P])).map(([p, x]) => `${p}: ${x}`);
  assert.ok(!m.some((x) => x.includes("rank")), JSON.stringify(m));
  assert.ok(m.some((x) => x.startsWith("Patient.telecom[0].value: The element value is present in the instance but not allowed")), JSON.stringify(m));
  delete EXTRA[CORE + "ContactPoint"];
});

test("F17 fhirpath context on a primitive host: element identity, not value equality (IV l. 2852-2858)", async () => {
  const FP = "http://acme-test.fhir.test/StructureDefinition/ctx-fhirpath-family";
  EXTRA[FP] = sd(FP, "Extension", "complex-type", [
    el("Extension", 0, "*"),
    el("Extension.extension", 0, "0", ["Extension"]),
    el("Extension.url", 1, "1", ["uri"], { fixedUri: FP }),
    el("Extension.value[x]", 1, "1", ["string"]),
  ], { context: [{ type: "fhirpath", expression: "name.family" }] });
  const ext = { extension: [{ url: FP, valueString: "x" }] };
  const onFamily = errs(await run({ resourceType: "Patient", name: [{ family: "A", _family: ext }] }));
  assert.ok(!onFamily.some(([, m]) => m.includes("not allowed to be used at this point")), JSON.stringify(onFamily));
  // gender has the same string value as the selected family, but is another element
  const onGender = errs(await run({ resourceType: "Patient", name: [{ family: "male" }], gender: "male", _gender: ext }));
  assert.ok(onGender.some(([, m]) => m.startsWith(`The extension ${FP} is not allowed to be used at this point`)), JSON.stringify(onGender));
});

test("unparsed embedded resource: JsonParser.parseResource fatal, empty Resource element (RES_ID_MISSING), references find a Resource", async () => {
  const issues = await run({
    resourceType: "Patient",
    contained: [{ resourceType: "coverage", id: "c" }],
    managingOrganization: { reference: "#c" },
  });
  const e = issues.filter((i) => i.severity === "fatal" || i.severity === "error").map((i) => `${i.path} | ${i.message}`);
  assert.ok(e.includes("Patient.contained[0] | Contained resource does not appear to be a FHIR resource (unknown name 'coverage')"), JSON.stringify(e));
  assert.ok(e.includes("Patient.contained[0] | Resource requires an id, but none is present"), JSON.stringify(e));
  assert.ok(!e.some((x) => x.includes("Unknown resource type")), JSON.stringify(e));
});

test("VALIDATION_VAL_PROFILE_MINIMUM / _MAXIMUM name the versioned profile; options: assumeValidRestReferences, bundle rules, IG globals, external references", async () => {
  const P = "http://example.org/fhir/StructureDefinition/pat-name-required";
  EXTRA[P] = sd(P, "Patient", "resource", [
    ...SDS[CORE + "Patient"].snapshot.element.filter((e: Json) => e.path !== "Patient.birthDate"),
    el("Patient.birthDate", 1, "1", ["date"]),
  ], { baseDefinition: CORE + "Patient", derivation: "constraint", version: "3.1" });
  const m = errs(await run({ resourceType: "Patient" }, [P])).map(([, x]) => x);
  assert.ok(m.includes(`Patient.birthDate: minimum required = 1, but only found 0 (from ${P}|3.1)`), JSON.stringify(m));
  // IG global profile
  const ig = { resourceType: "ImplementationGuide", url: "http://example.org/ig", version: "1", global: [{ type: "Patient", profile: P }] };
  const g = await new InstanceValidator(new Resolver()).validate({ resourceType: "Patient" }, { implementationGuides: [ig] });
  assert.ok(g.some((i) => i.message === `Patient.birthDate: minimum required = 1, but only found 0 (from ${P}|3.1)`), JSON.stringify(g));
  // assumeValidRestReferences: the type in an unresolved reference must be a target type
  const r = await new InstanceValidator(new Resolver()).validate({ resourceType: "Patient", managingOrganization: { reference: "Patient/1" } }, { assumeValidRestReferences: true });
  assert.ok(r.some((i) => i.message === "The type 'Patient' implied by the reference URL Patient/1 is not a valid Target for this element (must be one of [Organization])"), JSON.stringify(r));
  // validateReference: an external target fetched and checked
  class R3 extends Resolver {
    async fetchReference(ref: string): Promise<Json | null> {
      return ref === "Organization/o1" ? { resourceType: "Organization", id: "o1", name: 7 } : null;
    }
  }
  const f = await new InstanceValidator(new R3()).validate({ resourceType: "Patient", managingOrganization: { reference: "Organization/o1" } }, { validateReference: "CHECK_VALID" });
  assert.ok(!f.some((i) => i.severity === "error" && i.path === "Patient.managingOrganization" && /not found/.test(i.message)), JSON.stringify(f));
});

test("F10 invariants with memberOf() / conformsTo() are evaluated (FHIRPathEngine.funcMemberOf, funcConformsTo)", async () => {
  const NEED = "http://example.org/fhir/StructureDefinition/pat-need-birth";
  EXTRA[NEED] = sd(NEED, "Patient", "resource", [
    ...SDS[CORE + "Patient"].snapshot.element.filter((e: Json) => e.path !== "Patient.birthDate"),
    el("Patient.birthDate", 1, "1", ["date"]),
  ], { baseDefinition: CORE + "Patient", derivation: "constraint" });
  const P = "http://example.org/fhir/StructureDefinition/pat-inv";
  const root = (constraint: Json[]): Json => el("Patient", 0, "*", [], { constraint });
  EXTRA[P] = sd(P, "Patient", "resource", [
    root([
      { key: "m-1", severity: "error", human: "member", expression: "gender.memberOf('http://hl7.org/fhir/ValueSet/administrative-gender')" },
      { key: "c-1", severity: "error", human: "conforms", expression: `conformsTo('${NEED}')` },
    ]),
    ...SDS[CORE + "Patient"].snapshot.element.slice(1),
  ], { baseDefinition: CORE + "Patient", derivation: "constraint" });
  const bad = errs(await run({ resourceType: "Patient", gender: "nonsense" }, [P])).map(([, m]) => m);
  assert.ok(bad.some((m) => m.startsWith("Constraint failed: m-1: 'member'")), JSON.stringify(bad));
  assert.ok(bad.some((m) => m.startsWith("Constraint failed: c-1: 'conforms'")), JSON.stringify(bad));
  const good = errs(await run({ resourceType: "Patient", gender: "male", birthDate: "2000-01-01" }, [P])).map(([, m]) => m);
  assert.ok(!good.some((m) => m.startsWith("Constraint failed: ")), JSON.stringify(good));
});
