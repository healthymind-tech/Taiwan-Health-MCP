/**
 * fhir_get_bundle_form v1.1 (evaluation feedback) over synthetic profiles: example values of
 * identity resources / elements never prefilled (only profile-pinned ones), ContactPoint.system and
 * Age code + UCUM system from the datatype rules, complex placeholders expanded (Ratio), required
 * children of a coded item (form.text), an unreferenced entry linked (repeating Composition.author),
 * and the structural self-check.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { el, sd } from "../fhirTestKit.test.js";
import { bundleForm, formSelfCheck, getAt, type FormPlaceholder } from "./form.js";
import { fakeDeps } from "./fakeDeps.test.js";
import { exampleValueAllowed } from "./skeleton.js";

const B = "http://example.org/fhir/StructureDefinition/";
const CORE = "http://hl7.org/fhir/StructureDefinition/";
type R = Record<string, any>;

const entrySlice = (name: string, min: number, type: string, profile: string): R[] => [
  el(`Bundle.entry:${name}`, min, "1", [], { sliceName: name, baseMax: "*" }),
  el(`Bundle.entry:${name}.resource`, 1, "1", [], { type: [{ code: type, profile: [profile] }] }),
];
function bundle(id: string, type: string | null, slices: R[][]): R {
  return sd(B + id, "Bundle", "resource", [
    el("Bundle", 0, "*"),
    el("Bundle.identifier", 0, "1", ["Identifier"]),
    el("Bundle.type", 1, "1", ["code"], type ? { fixedCode: type } : {}),
    el("Bundle.timestamp", 0, "1", ["instant"]),
    el("Bundle.entry", 1, "*", ["BackboneElement"], { baseMax: "*", slicing: { discriminator: [{ type: "profile", path: "resource" }], rules: "closed" } }),
    el("Bundle.entry.fullUrl", 0, "1", ["uri"]),
    el("Bundle.entry.resource", 0, "1", ["Resource"]),
    ...slices.flat(),
  ], { id });
}

// core datatypes the rules come from (root constraints as in R4)
const AGE = sd(CORE + "Age", "Age", "complex-type", [
  el("Age", 0, "*", [], {
    constraint: [{ key: "age-1", severity: "error", human: "There SHALL be a code if there is a value and it SHALL be an expression of time.  If system is present, it SHALL be UCUM.", expression: "(code.exists() or value.empty()) and (system.empty() or system = %ucum) and (value.empty() or value.hasValue().not() or value > 0)" }],
  }),
  el("Age.value", 0, "1", ["decimal"]),
  el("Age.unit", 0, "1", ["string"]),
  el("Age.system", 0, "1", ["uri"]),
  el("Age.code", 0, "1", ["code"]),
], { id: "Age" });
const CP = sd(CORE + "ContactPoint", "ContactPoint", "complex-type", [
  el("ContactPoint", 0, "*", [], { constraint: [{ key: "cpt-2", severity: "error", human: "A system is required if a value is provided.", expression: "value.empty() or system.exists()" }] }),
  el("ContactPoint.system", 0, "1", ["code"], { binding: { strength: "required", valueSet: "http://hl7.org/fhir/ValueSet/contact-point-system|4.0.1" } }),
  el("ContactPoint.value", 0, "1", ["string"]),
], { id: "ContactPoint" });
const VALUE_SETS = {
  "http://hl7.org/fhir/ValueSet/contact-point-system": ["phone", "fax", "email"].map((code) => ({ system: "http://hl7.org/fhir/contact-point-system", code })),
  "http://hl7.org/fhir/ValueSet/age-units": ["min", "h", "d", "wk", "mo", "a"].map((code) => ({ system: "http://unitsofmeasure.org", code })),
};

const ORG = sd(B + "Org", "Organization", "resource", [
  el("Organization", 0, "*", [], { constraint: [{ key: "org-1", severity: "error", human: "name or identifier", expression: "(identifier.count() + name.count()) > 0" }] }),
  el("Organization.telecom", 1, "*", ["ContactPoint"], { baseMax: "*" }),
  el("Organization.telecom.value", 1, "1", ["string"]),
  el("Organization.name", 0, "1", ["string"]),
  el("Organization.identifier", 0, "*", ["Identifier"], { baseMax: "*" }),
], { id: "Org" });
const PAT = sd(B + "Pat", "Patient", "resource", [
  el("Patient", 0, "*"),
  el("Patient.extension", 1, "*", ["Extension"], { baseMax: "*" }),
  el("Patient.extension:age", 1, "1", [], { sliceName: "age", baseMax: "*", type: [{ code: "Extension", profile: [B + "ext-age"] }] }),
  el("Patient.birthDate", 1, "1", ["date"]),
], { id: "Pat" });
const EXT_AGE = sd(B + "ext-age", "Extension", "complex-type", [
  el("Extension", 0, "*"),
  el("Extension.extension", 0, "0", ["Extension"]),
  el("Extension.url", 1, "1", ["uri"], { fixedUri: B + "ext-age" }),
  el("Extension.value[x]", 1, "1", ["Age"]),
], { id: "ext-age" });
const PRAC = sd(B + "Prac", "Practitioner", "resource", [el("Practitioner", 0, "*")], { id: "Prac" });
const MED = sd(B + "Med", "Medication", "resource", [
  el("Medication", 0, "*"),
  el("Medication.form", 1, "1", ["CodeableConcept"], { binding: { strength: "example", valueSet: "http://example.org/vs/forms" } }),
  el("Medication.form.text", 1, "1", ["string"]),
  el("Medication.ingredient", 1, "*", ["BackboneElement"], { baseMax: "*" }),
  el("Medication.ingredient.item[x]", 1, "1", ["CodeableConcept"]),
  el("Medication.ingredient.strength", 1, "1", ["Ratio"]),
], { id: "Med" });
const COMP = sd(B + "Comp", "Composition", "resource", [
  el("Composition", 0, "*"),
  el("Composition.status", 1, "1", ["code"], { fixedCode: "final" }),
  el("Composition.subject", 1, "1", [], { type: [{ code: "Reference", targetProfile: [B + "Pat"] }] }),
  el("Composition.author", 1, "*", [], { baseMax: "*", type: [{ code: "Reference", targetProfile: [B + "Pat", B + "Prac", B + "Org"] }] }),
  el("Composition.custodian", 1, "1", [], { type: [{ code: "Reference", targetProfile: [B + "Org"] }] }),
  el("Composition.section", 1, "*", ["BackboneElement"], { baseMax: "*" }),
  el("Composition.section.title", 1, "1", ["string"]),
  el("Composition.section.entry", 1, "*", [], { baseMax: "*", type: [{ code: "Reference", targetProfile: [B + "Med"] }] }),
], { id: "Comp" });
const DOC = bundle("Bundle-doc", "document", [
  entrySlice("comp", 1, "Composition", B + "Comp"),
  entrySlice("org", 1, "Organization", B + "Org"),
  entrySlice("pat", 1, "Patient", B + "Pat"),
  entrySlice("prac", 1, "Practitioner", B + "Prac"),
  entrySlice("med", 1, "Medication", B + "Med"),
]);
const ALL = [DOC, COMP, ORG, PAT, EXT_AGE, PRAC, MED, AGE, CP];
// two identical example clinics: identity values a model would copy
const clinic = (): R => ({ resourceType: "Organization", meta: { profile: [B + "Org"] }, name: "Example Clinic", telecom: [{ system: "phone", value: "02-1234567" }], identifier: [{ system: "http://example.org/ids", value: "3531020884" }] });
const deps = (): ReturnType<typeof fakeDeps> => fakeDeps(ALL, { examples: [clinic(), clinic()], valueSets: VALUE_SETS });

test("v1.1: example values of identity resources / elements are never prefilled nor given as examples", async () => {
  const { data } = await bundleForm({ bundle_profile: "Bundle-doc" }, deps());
  const text = JSON.stringify(data);
  for (const v of ["Example Clinic", "02-1234567", "3531020884", "http://example.org/ids"]) assert.ok(!text.includes(v), `${v} not in the form`);
  const org = ((data.bundle as R).entry as R[]).find((e) => e.resource.resourceType === "Organization")!.resource;
  assert.match(org.telecom[0].value, /^<<P\d+:record>>$/);
  assert.match(org.name, /^<<P\d+:record>>$/, "org-1: name or identifier is required -> a name placeholder");
  assert.equal(exampleValueAllowed("Organization", "Organization.type", true), false);
  assert.equal(exampleValueAllowed("Observation", "Observation.performer.identifier", true), false);
  assert.equal(exampleValueAllowed("Observation", "Observation.status", true), true);
  assert.equal(exampleValueAllowed("Organization", "Organization.name", false), true, "the skeleton tool's default is unchanged");
});

test("v1.1: ContactPoint.system with a value (cpt-2), Age code + UCUM system (age-1), Ratio expanded, required form.text", async () => {
  const { data } = await bundleForm({ bundle_profile: "Bundle-doc" }, deps());
  const entries = (data.bundle as R).entry as R[];
  const ph = data.placeholders as FormPlaceholder[];
  const at = (ptr: string): FormPlaceholder => ph.find((p) => p.pointer === ptr)!;
  const iOrg = entries.findIndex((e) => e.resource.resourceType === "Organization");
  const sys = at(`/entry/${iOrg}/resource/telecom/0/system`);
  assert.ok(sys, "telecom system placeholder");
  assert.deepEqual((sys.allowed as R[]).map((a) => a.code), ["phone", "fax", "email"]);
  const iPat = entries.findIndex((e) => e.resource.resourceType === "Patient");
  const age = entries[iPat].resource.extension[0].valueAge;
  assert.equal(age.system, "http://unitsofmeasure.org", "system fixed by the Age datatype rule");
  const code = at(`/entry/${iPat}/resource/extension/0/valueAge/code`);
  assert.deepEqual((code.allowed as R[]).map((a) => a.code), ["min", "h", "d", "wk", "mo", "a"]);
  assert.equal(code.value_source, "code-lookup");
  const iMed = entries.findIndex((e) => e.resource.resourceType === "Medication");
  const med = entries[iMed].resource;
  assert.match(med.form.text, /^<<P\d+:/, "required child of the coded item");
  for (const k of ["numerator", "denominator"]) assert.match(med.ingredient[0].strength[k].value, /^<<P\d+:/, `Ratio.${k} (rat-1)`);
  assert.deepEqual(data.self_check, { ok: true });
});

test("v1.1: an entry nothing references takes the repeating open reference that lists it (Composition.author)", async () => {
  const { data, warnings } = await bundleForm({ bundle_profile: "Bundle-doc" }, deps());
  const entries = (data.bundle as R).entry as R[];
  const prac = entries.find((e) => e.resource.resourceType === "Practitioner")!;
  const comp = entries[0].resource;
  assert.equal(comp.resourceType, "Composition");
  assert.equal(comp.author[0].reference, prac.fullUrl);
  assert.equal(comp.custodian.reference, entries.find((e) => e.resource.resourceType === "Organization")!.fullUrl);
  assert.equal(formSelfCheck(data.bundle as R).length, 0);
  assert.ok(!warnings.some((w) => /self-check|not reachable/.test(w)), warnings.join(" | "));
});

test("v1.1: self-check finds empty values, dangling references, unlinked entries, ContactPoint / Age without system / code", () => {
  const bad = {
    resourceType: "Bundle",
    type: "document",
    entry: [
      { fullUrl: "urn:uuid:1", resource: { resourceType: "Composition", subject: { reference: "urn:uuid:2" }, author: [{ reference: "urn:uuid:9" }], title: "" } },
      { fullUrl: "urn:uuid:2", resource: { resourceType: "Patient", telecom: [{ value: "<<P0:record>>" }], extension: [{ url: "x", valueAge: { value: 3 } }], name: [] } },
      { fullUrl: "urn:uuid:3", resource: { resourceType: "Practitioner", qualification: {} } },
    ],
  };
  const problems = formSelfCheck(bad);
  const has = (re: RegExp): boolean => problems.some((p) => re.test(p));
  assert.ok(has(/title: empty string/));
  assert.ok(has(/name: empty array/));
  assert.ok(has(/qualification: empty object/));
  assert.ok(has(/urn:uuid:9 is not an entry fullUrl/));
  assert.ok(has(/^\/entry\/2: not linked/));
  assert.ok(has(/telecom\/0: ContactPoint value without system/));
  assert.ok(has(/valueAge: valueAge value without system \+ code/));
  assert.ok(!has(/^\/entry\/1: not linked/), "the Patient is linked (referenced by the root)");
  assert.equal(getAt(bad, "/entry/1/resource/telecom/0/value"), "<<P0:record>>");
});
