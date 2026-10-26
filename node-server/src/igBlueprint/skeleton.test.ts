/**
 * fhir_get_minimal_skeleton (ISSUES_v16 R2) over synthetic StructureDefinitions and examples:
 * one case per value_source rule, extension expansion, conditional invariant rows and the budget.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { el, sd } from "../fhirTestKit.test.js";
import { fakeDeps } from "./fakeDeps.test.js";
import { minimalSkeleton, parseImpliesExists } from "./skeleton.js";

const B = "http://example.org/fhir/StructureDefinition/";
type R = Record<string, any>;

const rows = (d: R): Map<string, [string, string]> => new Map((d.table as Array<[string, string, string]>).map(([p, s, h]) => [p, [s, h]]));

test("parseImpliesExists: guard implies a conjunction of exists()", () => {
  assert.deepEqual(parseImpliesExists("sequence=1 implies (type.text.exists() and extension.where(url = 'u').value.ofType(date).exists())"), {
    guard: "sequence=1",
    terms: ["type.text", "extension.where(url = 'u').value.ofType(date)"],
  });
  assert.equal(parseImpliesExists("a.exists() or b.exists()"), null);
  assert.equal(parseImpliesExists("x implies (a.exists() or b.exists())"), null);
});

// ---- a claim-like profile covering every rule ------------------------------------------------

const VS_PRIORITY = "http://example.org/fhir/ValueSet/priority";
const VS_STATUS = "http://hl7.org/fhir/ValueSet/fm-status";
const VS_PROGRAM = "http://example.org/fhir/ValueSet/program";
const VS_DEPT = "http://example.org/fhir/ValueSet/dept";
const EXT_ENC = B + "ext-encounter";
const EXT_REC = B + "ext-recordedDate";

const extEncounter = sd(EXT_ENC, "Extension", "complex-type", [
  el("Extension", 0, "*"),
  el("Extension.extension", 0, "0", ["Extension"]),
  el("Extension.url", 1, "1", ["uri"], { fixedUri: EXT_ENC }),
  el("Extension.value[x]", 0, "1", [], { type: [{ code: "Reference", targetProfile: [B + "Enc"] }] }),
], { id: "ext-encounter", name: "ClaimEncounter" });
const extRecorded = sd(EXT_REC, "Extension", "complex-type", [
  el("Extension", 0, "*"),
  el("Extension.extension", 0, "0", ["Extension"]),
  el("Extension.url", 1, "1", ["uri"], { fixedUri: EXT_REC }),
  el("Extension.value[x]", 0, "1", ["date"]),
], { id: "ext-recordedDate", name: "DiagnosisRecordedDate" });

const claim = sd(B + "Claim-x", "Claim", "resource", [
  el("Claim", 0, "*"),
  el("Claim.extension", 1, "*", ["Extension"], { baseMax: "*", slicing: { discriminator: [{ type: "value", path: "url" }], rules: "open" } }),
  el("Claim.extension:encounter", 1, "1", [], { sliceName: "encounter", baseMax: "*", type: [{ code: "Extension", profile: [EXT_ENC] }] }),
  el("Claim.status", 1, "1", ["code"], { patternCode: "active", binding: { strength: "required", valueSet: VS_STATUS } }),
  el("Claim.priority", 1, "1", ["CodeableConcept"], { binding: { strength: "required", valueSet: VS_PRIORITY } }),
  el("Claim.patient", 1, "1", [], { type: [{ code: "Reference", targetProfile: [B + "Pat"] }] }),
  el("Claim.created", 1, "1", ["dateTime"]),
  el("Claim.diagnosis", 1, "*", ["BackboneElement"], {
    baseMax: "*",
    constraint: [{ key: "dx-1", severity: "error", human: "sequence 1 needs a date and a summary", expression: "sequence=1 implies (extension.where(url = '" + EXT_REC + "').value.ofType(date).exists() and type.text.exists())", source: B + "Claim-x" }],
  }),
  el("Claim.diagnosis.sequence", 1, "1", ["positiveInt"]),
  el("Claim.diagnosis.extension", 0, "*", ["Extension"], { baseMax: "*" }),
  el("Claim.diagnosis.extension:recordedDate", 0, "1", [], { sliceName: "recordedDate", baseMax: "*", type: [{ code: "Extension", profile: [EXT_REC] }] }),
  el("Claim.diagnosis.type", 0, "*", ["CodeableConcept"], { baseMax: "*" }),
  el("Claim.diagnosis.type.text", 0, "1", ["string"]),
  el("Claim.diagnosis.diagnosis[x]", 1, "1", ["CodeableConcept"], { binding: { strength: "preferred", valueSet: VS_DEPT } }),
  el("Claim.item", 1, "*", ["BackboneElement"], { baseMax: "*" }),
  el("Claim.item.sequence", 1, "1", ["positiveInt"]),
  el("Claim.item.programCode", 1, "1", ["CodeableConcept"], { baseMax: "*", binding: { strength: "example", valueSet: VS_PROGRAM } }),
  el("Claim.item.category", 1, "1", ["CodeableConcept"], { binding: { strength: "preferred", valueSet: VS_DEPT } }),
  el("Claim.item.category.coding", 1, "1", ["Coding"], { baseMax: "*" }),
  el("Claim.item.category.coding.system", 1, "1", ["uri"], { patternUri: "http://example.org/dept" }),
  el("Claim.item.category.coding.code", 1, "1", ["code"]),
  el("Claim.item.unitPrice", 1, "1", ["Money"]),
  el("Claim.insurance", 1, "*", ["BackboneElement"], { baseMax: "*" }),
  el("Claim.insurance.focal", 1, "1", ["boolean"]),
], { id: "Claim-x" });

const VALUE_SETS = {
  [VS_PRIORITY]: [
    { system: "http://example.org/prio", code: "1", display: "normal" },
    { system: "http://example.org/prio", code: "2", display: "urgent" },
  ],
  [VS_PROGRAM]: [{ system: "http://example.org/prog", code: "x" }],
  [VS_DEPT]: [{ system: "http://example.org/dept", code: "01", display: "family medicine" }],
};

test("skeleton: every value_source rule on a claim-like profile", async () => {
  const deps = fakeDeps([claim, extEncounter, extRecorded], { valueSets: VALUE_SETS });
  const { data } = await minimalSkeleton({ profile: "Claim-x" }, deps);
  const t = rows(data);
  const sk = data.skeleton as R;
  // fixed / pattern → ig-constant, already in the skeleton; meta.profile always set
  assert.equal(sk.status, "active");
  assert.deepEqual(sk.meta, { profile: [B + "Claim-x"] });
  assert.ok((data.table as string[][])[0][0].includes("status") && (data.table as string[][])[0][1] === "ig-constant");
  // extension expanded from its definition: url (pinned) + valueReference (derivable reference)
  assert.deepEqual(sk.extension, [{ url: EXT_ENC, valueReference: { reference: "<fullUrl of Enc>" } }]);
  assert.equal(t.get("extension:encounter.valueReference")?.[0], "derivable");
  // required small binding → code-lookup with its codes
  assert.equal(t.get("priority")?.[0], "code-lookup");
  assert.match(t.get("priority")![1], /1=normal \| 2=urgent/);
  assert.deepEqual(sk.priority, { coding: [{ system: "http://example.org/prio", code: "<code>" }] });
  // references, numbering, workflow dates, workflow values → derivable
  assert.equal(t.get("patient")?.[0], "derivable");
  assert.equal(t.get("diagnosis.sequence")?.[0], "derivable");
  assert.equal(t.get("created")?.[0], "derivable");
  assert.equal(t.get("insurance.focal")?.[0], "derivable");
  assert.equal(sk.insurance[0].focal, true);
  // CodeableConcept with a non-required binding and optional coding → text-allowed (example codes not listed)
  assert.equal(t.get("item.programCode")?.[0], "text-allowed");
  assert.doesNotMatch(t.get("item.programCode")![1], /x\b.*\|/);
  assert.deepEqual(sk.item[0].programCode, [{ text: "<text>" }]);
  assert.equal(t.get("diagnosis.diagnosisCodeableConcept")?.[0], "text-allowed");
  // non-required binding but a required coding.code → code-lookup, system from the pinned coding.system
  assert.equal(t.get("item.category")?.[0], "code-lookup");
  assert.deepEqual(sk.item[0].category, { coding: [{ system: "http://example.org/dept", code: "<code>" }] });
  // everything else → record
  assert.equal(t.get("item.unitPrice")?.[0], "record");
  // conditional rows from `guard implies (… .exists() and …)` on a required element
  const cond = new Map((data.conditional as string[][]).map(([p, s, h]) => [p, [s, h]]));
  assert.equal(cond.get("diagnosis.extension:recordedDate.valueDate")?.[0], "derivable", `recording-date extension → derivable: ${JSON.stringify(data.conditional)}`);
  assert.equal(cond.get("diagnosis.type.text")?.[0], "record");
  assert.ok((data.conditions as R)["dx-1"]);
  assert.equal(data.omitted, 0);
  assert.ok((data.response_chars as number) <= 6000);
});

test("skeleton: sequence placeholders of sibling slices are numbered 1, 2, …", async () => {
  const p = sd(B + "Seq", "Claim", "resource", [
    el("Claim", 0, "*"),
    el("Claim.supportingInfo", 2, "*", ["BackboneElement"], { baseMax: "*", slicing: { discriminator: [{ type: "pattern", path: "category" }], rules: "open" } }),
    el("Claim.supportingInfo.sequence", 1, "1", ["positiveInt"]),
    el("Claim.supportingInfo:a", 1, "1", ["BackboneElement"], { sliceName: "a", baseMax: "*" }),
    el("Claim.supportingInfo:a.sequence", 1, "1", ["positiveInt"]),
    el("Claim.supportingInfo:a.category", 1, "1", ["CodeableConcept"], { patternCodeableConcept: { coding: [{ system: "s", code: "a" }] } }),
    el("Claim.supportingInfo:b", 1, "1", ["BackboneElement"], { sliceName: "b", baseMax: "*" }),
    el("Claim.supportingInfo:b.sequence", 1, "1", ["positiveInt"]),
    el("Claim.supportingInfo:b.category", 1, "1", ["CodeableConcept"], { patternCodeableConcept: { coding: [{ system: "s", code: "b" }] } }),
  ], { id: "Seq" });
  const { data } = await minimalSkeleton({ profile: "Seq" }, fakeDeps([p]));
  const si = (data.skeleton as R).supportingInfo as R[];
  assert.equal(si.length, 2, "one item per required slice, no extra unsliced item");
  assert.deepEqual(si.map((x) => [x.sequence, x.category.coding[0].code]), [[1, "a"], [2, "b"]]);
});

// ---- example constants -----------------------------------------------------------------------

const ORG = sd(B + "Org-payer", "Organization", "resource", [
  el("Organization", 0, "*"),
  el("Organization.identifier", 0, "*", ["Identifier"], { baseMax: "*", mustSupport: true }),
  el("Organization.type", 1, "*", ["CodeableConcept"], { baseMax: "*", patternCodeableConcept: { coding: [{ system: "t", code: "govt" }] } }),
  el("Organization.name", 0, "1", ["string"], { mustSupport: true }),
], { id: "Org-payer" });
const orgEx = (id: string, value: string, name: string): R => ({
  resourceType: "Organization", id, meta: { profile: [B + "Org-payer"] }, identifier: [{ system: "urn:oid:x", value }], type: [{ coding: [{ system: "t", code: "govt" }] }], name,
});

test("example constants: an administrative entity the IG reuses in every example is an ig-constant", async () => {
  const same = [orgEx("a", "A123", "Agency"), orgEx("b", "A123", "Agency")];
  const { data } = await minimalSkeleton({ profile: "Org-payer" }, fakeDeps([ORG], { examples: same }));
  const t = rows(data);
  assert.equal(t.get("identifier")?.[0], "ig-constant");
  assert.match(t.get("identifier")![1], /identical in 2\/2 IG example instances/);
  assert.deepEqual((data.skeleton as R).identifier, [{ system: "urn:oid:x", value: "A123" }]);
  assert.equal((data.skeleton as R).name, "Agency");
});

test("example constants: values that vary, or a single example, are never constants", async () => {
  const vary = [orgEx("a", "A123", "Agency"), orgEx("b", "B456", "Agency")];
  const { data } = await minimalSkeleton({ profile: "Org-payer" }, fakeDeps([ORG], { examples: vary }));
  const t = rows(data);
  assert.equal(t.get("identifier"), undefined, "varying identifier is not listed (optional, not constant)");
  assert.equal(t.get("name")?.[0], "ig-constant", "the name that is identical in both still is");
  assert.equal((data.skeleton as R).identifier, undefined);
  const one = await minimalSkeleton({ profile: "Org-payer" }, fakeDeps([ORG], { examples: [orgEx("a", "A123", "Agency")] }));
  assert.equal(rows(one.data).get("identifier"), undefined, "one example is not a basis");
});

const PAT = sd(B + "Pat", "Patient", "resource", [
  el("Patient", 0, "*"),
  el("Patient.identifier", 1, "*", ["Identifier"], { baseMax: "*" }),
  el("Patient.gender", 1, "1", ["code"], { binding: { strength: "required", valueSet: "http://hl7.org/fhir/ValueSet/administrative-gender" } }),
  el("Patient.birthDate", 1, "1", ["date"]),
], { id: "Pat" });
const ENC = sd(B + "Enc", "Encounter", "resource", [
  el("Encounter", 0, "*"),
  el("Encounter.status", 1, "1", ["code"], { binding: { strength: "required", valueSet: "http://hl7.org/fhir/ValueSet/encounter-status" } }),
  el("Encounter.class", 1, "1", ["Coding"], { binding: { strength: "extensible", valueSet: "http://example.org/vs/class" } }),
], { id: "Enc" });

test("example constants: person facts never; workflow codes only over >= 2 distinct instances", async () => {
  const pat = (id: string, ident: string): R => ({ resourceType: "Patient", id, meta: { profile: [B + "Pat"] }, identifier: [{ value: ident }], gender: "male", birthDate: "2001-01-01" });
  const vs = { "http://hl7.org/fhir/ValueSet/administrative-gender": ["male", "female", "other", "unknown"].map((code) => ({ system: "http://hl7.org/fhir/administrative-gender", code })) };
  const p = await minimalSkeleton({ profile: "Pat" }, fakeDeps([PAT], { examples: [pat("a", "1"), pat("b", "2")], valueSets: vs }));
  const t = rows(p.data);
  assert.equal(t.get("gender")?.[0], "code-lookup", "same gender in every example is still the patient's fact");
  assert.equal(t.get("birthDate")?.[0], "record");

  const enc = (id: string, cls: string): R => ({ resourceType: "Encounter", id, meta: { profile: [B + "Enc"] }, status: "planned", class: { system: "c", code: cls } });
  const distinct = await minimalSkeleton({ profile: "Enc" }, fakeDeps([ENC], { examples: [enc("a", "AMB"), enc("b", "IMP")] }));
  const td = rows(distinct.data);
  assert.equal(td.get("status")?.[0], "ig-constant", "status identical in 2 distinct examples");
  assert.equal((distinct.data.skeleton as R).status, "planned");
  assert.notEqual(td.get("class")?.[0], "ig-constant", "class varies");
  const copies = await minimalSkeleton({ profile: "Enc" }, fakeDeps([ENC], { examples: [enc("a", "AMB"), enc("b", "AMB")] }));
  assert.equal(rows(copies.data).get("status")?.[0], "derivable", "copies of one example (1 distinct) → the workflow default, not a constant");
});

test("skeleton: the size budget drops rows and counts them in `omitted`", async () => {
  const many = [el("Observation", 0, "*")];
  for (let i = 0; i < 160; i++) many.push(el(`Observation.extension:e${i}`, 1, "1", ["Extension"], { sliceName: `e${i}`, baseMax: "*", type: [{ code: "Extension", profile: [`${B}a-rather-long-extension-definition-name-${i}`] }] }));
  many.splice(1, 0, el("Observation.extension", 1, "*", ["Extension"], { baseMax: "*" }));
  const big = sd(B + "Big", "Observation", "resource", many, { id: "Big" });
  const { data, warnings } = await minimalSkeleton({ profile: "Big" }, fakeDeps([big]));
  assert.ok((data.response_chars as number) <= 6000, String(data.response_chars));
  assert.ok(data.skeleton_omitted || (data.omitted as number) > 0, "what does not fit is reported");
  assert.ok(warnings.some((w) => /not installed/.test(w)));
});
