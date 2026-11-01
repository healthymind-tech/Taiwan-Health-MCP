/**
 * fhir_get_bundle_form (ISSUES_v19 R2) over synthetic Bundle / resource profiles: required slices
 * and planned entries, targets of required references added, references wired (also inside an
 * extension), every placeholder listed with a pointer that resolves to its token, document
 * structure (Composition first, required + planned sections, section.entry, identifier /
 * timestamp), ambiguous references left open with candidates, determinism.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { el, sd } from "../fhirTestKit.test.js";
import { bundleForm, getAt, PLACEHOLDER_TOKEN, type FormPlaceholder } from "./form.js";
import { fakeDeps } from "./fakeDeps.test.js";

const B = "http://example.org/fhir/StructureDefinition/";
const CORE = "http://hl7.org/fhir/StructureDefinition/";
type R = Record<string, any>;

const entrySlice = (name: string, min: number, max: string, type: string, profile: string): R[] => [
  el(`Bundle.entry:${name}`, min, max, [], { sliceName: name, baseMax: "*" }),
  el(`Bundle.entry:${name}.resource`, 1, "1", [], { type: [{ code: type, profile: [profile] }] }),
];

function bundle(id: string, type: string, slices: R[][], rules = "closed", extra: R[] = []): R {
  return sd(B + id, "Bundle", "resource", [
    el("Bundle", 0, "*"),
    el("Bundle.identifier", 0, "1", ["Identifier"]),
    el("Bundle.type", 1, "1", ["code"], { fixedCode: type }),
    el("Bundle.timestamp", 0, "1", ["instant"]),
    el("Bundle.entry", 1, "*", ["BackboneElement"], { baseMax: "*", slicing: { discriminator: [{ type: "profile", path: "resource" }], rules } }),
    el("Bundle.entry.fullUrl", 0, "1", ["uri"]),
    el("Bundle.entry.resource", 0, "1", ["Resource"]),
    ...extra,
    ...slices.flat(),
  ], { id });
}

const EXT = B + "ext-enc";
const ext = sd(EXT, "Extension", "complex-type", [
  el("Extension", 0, "*"),
  el("Extension.extension", 0, "0", ["Extension"]),
  el("Extension.url", 1, "1", ["uri"], { fixedUri: EXT }),
  el("Extension.value[x]", 0, "1", [], { type: [{ code: "Reference", targetProfile: [B + "Enc"] }] }),
], { id: "ext-enc" });
const claim = sd(B + "Claim-x", "Claim", "resource", [
  el("Claim", 0, "*"),
  el("Claim.extension", 1, "*", ["Extension"], { baseMax: "*" }),
  el("Claim.extension:encounter", 1, "1", [], { sliceName: "encounter", baseMax: "*", type: [{ code: "Extension", profile: [EXT] }] }),
  el("Claim.status", 1, "1", ["code"], { fixedCode: "active" }),
  el("Claim.created", 1, "1", ["dateTime"]),
  el("Claim.patient", 1, "1", [], { type: [{ code: "Reference", targetProfile: [B + "Pat"] }] }),
  el("Claim.insurance", 1, "*", ["BackboneElement"], { baseMax: "*" }),
  el("Claim.insurance.sequence", 1, "1", ["positiveInt"]),
  el("Claim.insurance.coverage", 1, "1", [], { type: [{ code: "Reference", targetProfile: [B + "Cov"] }] }),
], { id: "Claim-x" });
const cov = sd(B + "Cov", "Coverage", "resource", [
  el("Coverage", 0, "*"),
  el("Coverage.payor", 1, "*", [], { type: [{ code: "Reference", targetProfile: [B + "Org-payer"] }], baseMax: "*" }),
  el("Coverage.beneficiary", 1, "1", [], { type: [{ code: "Reference", targetProfile: [B + "Pat"] }] }),
], { id: "Cov" });
const pat = sd(B + "Pat", "Patient", "resource", [
  el("Patient", 0, "*"),
  el("Patient.identifier", 1, "*", ["Identifier"], { baseMax: "*" }),
  el("Patient.birthDate", 1, "1", ["date"]),
], { id: "Pat" });
const simple = (id: string, type: string, base?: string, els: R[] = []): R => sd(B + id, type, "resource", [el(type, 0, "*"), ...els], { id, ...(base ? { baseDefinition: base } : {}) });
const obs = simple("Obs-lab", "Observation", CORE + "Observation", [
  el("Observation.status", 1, "1", ["code"], { fixedCode: "final" }),
  el("Observation.subject", 1, "1", [], { type: [{ code: "Reference", targetProfile: [B + "Pat"] }] }),
  el("Observation.performer", 1, "*", [], { baseMax: "*", type: [{ code: "Reference", targetProfile: [CORE + "Practitioner", CORE + "Organization"] }] }),
]);

const COLLECTION = bundle("Bundle-c", "collection", [
  entrySlice("claim", 1, "1", "Claim", B + "Claim-x"),
  entrySlice("encounter", 1, "1", "Encounter", B + "Enc"),
  entrySlice("patient", 1, "1", "Patient", B + "Pat"),
  entrySlice("coverage", 0, "1", "Coverage", B + "Cov"),
  entrySlice("payer", 0, "1", "Organization", B + "Org-payer"),
  entrySlice("lab", 0, "*", "Observation", B + "Obs-lab"),
  entrySlice("org", 0, "*", "Organization", CORE + "Organization"),
]);
const ALL = [ext, claim, cov, pat, simple("Enc", "Encounter"), simple("Org-payer", "Organization", CORE + "Organization"), obs, simple("Organization", "Organization")];
ALL[ALL.length - 1].url = CORE + "Organization";

function checkPlaceholders(data: R): FormPlaceholder[] {
  const ph = data.placeholders as FormPlaceholder[];
  ph.forEach((p, i) => {
    assert.ok(p.type && p.what && p.value_source, `placeholder ${i} has type / what / value_source`);
    const v = getAt(data.bundle, p.pointer);
    const m = typeof v === "string" ? PLACEHOLDER_TOKEN.exec(v) : null;
    assert.ok(m && Number(m[1]) === i && m[2] === p.value_source, `placeholder ${i} at ${p.pointer} resolves to its token (got ${JSON.stringify(v)})`);
  });
  const leaves: string[] = [];
  const walk = (n: unknown): void => {
    if (typeof n === "string") leaves.push(n);
    else if (Array.isArray(n)) n.forEach(walk);
    else if (n && typeof n === "object") Object.values(n).forEach(walk);
  };
  walk(data.bundle);
  assert.equal(leaves.filter((s) => /^<<P\d+:/.test(s)).length, ph.length, "every token in the bundle is listed");
  assert.equal(leaves.filter((s) => /^<[^<>]*>$/.test(s)).length, 0, "no raw skeleton token left");
  return ph;
}

test("form: required slices + planned entries + reference targets, all references wired", async () => {
  const { data } = await bundleForm({ bundle_profile: "Bundle-c", entries: [{ profile: "Obs-lab", count: 2 }] }, fakeDeps([COLLECTION, ...ALL]));
  const b = data.bundle as R;
  assert.equal(b.type, "collection");
  assert.deepEqual(b.meta.profile, [B + "Bundle-c"]);
  const entries = data.entries as R[];
  assert.deepEqual(
    entries.map((e) => e.slice).sort(),
    ["claim", "encounter", "patient", "lab", "lab", "org", "coverage", "payer"].sort(),
    "required slices, planned x2, then the targets required references need",
  );
  const url = (slice: string): string => entries.find((e) => e.slice === slice)!.fullUrl;
  for (const e of b.entry as R[]) assert.match(e.fullUrl, /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const claimRes = (b.entry as R[])[0].resource;
  assert.equal(claimRes.patient.reference, url("patient"));
  assert.equal(claimRes.extension[0].url, EXT);
  assert.equal(claimRes.extension[0].valueReference.reference, url("encounter"), "reference inside an extension");
  assert.equal(claimRes.insurance[0].coverage.reference, url("coverage"));
  assert.equal(claimRes.status, "active", "fixed value");
  const covRes = (b.entry as R[]).find((e) => e.resource.resourceType === "Coverage")!.resource;
  assert.equal(covRes.payor[0].reference, url("payer"));
  assert.equal(covRes.beneficiary.reference, url("patient"));
  const lab = (b.entry as R[])[3].resource;
  assert.equal(lab.subject.reference, url("patient"));
  const ph = checkPlaceholders(data);
  // performer: Practitioner | Organization — two Organization entries exist: left open with the candidates
  const perf = ph.find((p) => p.pointer === "/entry/3/resource/performer/0")!;
  assert.equal(perf.type, "Reference");
  assert.equal(perf.allowed!.length, 2);
  assert.deepEqual(perf.target, ["Practitioner", "Organization"]);
  const birth = ph.find((p) => p.pointer.endsWith("/birthDate"))!;
  assert.deepEqual([birth.type, birth.value_source, birth.required], ["date", "record", true]);
  const idSystem = ph.find((p) => p.pointer === "/entry/2/resource/identifier/0/system")!;
  assert.equal(idSystem.type, "uri");
  assert.ok(ph.some((p) => p.pointer === "/entry/0/resource/created" && p.type === "dateTime" && p.value_source === "derivable"));
  // deterministic
  const again = await bundleForm({ bundle_profile: "Bundle-c", entries: [{ profile: "Obs-lab", count: 2 }] }, fakeDeps([COLLECTION, ...ALL]));
  assert.equal(JSON.stringify(again.data.bundle), JSON.stringify(data.bundle));
});

test("form: a planned entry that matches no slice of a CLOSED Bundle is not added (warning)", async () => {
  const other = simple("Other", "Basic");
  const { data, warnings } = await bundleForm({ bundle_profile: "Bundle-c", entries: [{ profile: "Other" }] }, fakeDeps([COLLECTION, ...ALL, other]));
  assert.ok(!(data.entries as R[]).some((e) => e.resourceType === "Basic"));
  assert.ok(warnings.some((w) => /CLOSED/.test(w)));
});

const LOINC = "http://loinc.org";
const comp = sd(B + "Comp-x", "Composition", "resource", [
  el("Composition", 0, "*"),
  el("Composition.status", 1, "1", ["code"], { binding: { strength: "required", valueSet: "http://hl7.org/fhir/ValueSet/composition-status" } }),
  el("Composition.type", 1, "1", ["CodeableConcept"], { patternCodeableConcept: { coding: [{ system: LOINC, code: "60591-5" }] } }),
  el("Composition.subject", 1, "1", [], { type: [{ code: "Reference", targetProfile: [B + "Pat"] }] }),
  el("Composition.date", 1, "1", ["dateTime"]),
  el("Composition.title", 1, "1", ["string"]),
  el("Composition.section", 1, "*", ["BackboneElement"], { baseMax: "*", slicing: { discriminator: [{ type: "pattern", path: "code" }], rules: "open" } }),
  el("Composition.section.code", 0, "1", ["CodeableConcept"]),
  el("Composition.section.text", 1, "1", ["Narrative"]),
  el("Composition.section.entry", 0, "*", [], { baseMax: "*", type: [{ code: "Reference", targetProfile: [CORE + "Resource"] }] }),
  el("Composition.section:probs", 1, "1", ["BackboneElement"], { sliceName: "probs", baseMax: "*" }),
  el("Composition.section:probs.title", 1, "1", ["string"]),
  el("Composition.section:probs.code", 0, "1", ["CodeableConcept"], { patternCodeableConcept: { coding: [{ system: LOINC, code: "11450-4" }] } }),
  el("Composition.section:probs.text", 0, "1", ["Narrative"]),
  el("Composition.section:probs.entry", 1, "*", [], { baseMax: "*", type: [{ code: "Reference", targetProfile: [B + "Cond"] }] }),
  el("Composition.section:labs", 0, "1", ["BackboneElement"], { sliceName: "labs", baseMax: "*" }),
  el("Composition.section:labs.title", 1, "1", ["string"]),
  el("Composition.section:labs.code", 0, "1", ["CodeableConcept"], { patternCodeableConcept: { coding: [{ system: LOINC, code: "30954-2" }] } }),
  el("Composition.section:labs.text", 0, "1", ["Narrative"]),
  el("Composition.section:labs.entry", 0, "*", [], { baseMax: "*", type: [{ code: "Reference", targetProfile: [B + "Obs-lab"] }] }),
], { id: "Comp-x" });
const cond = simple("Cond", "Condition", undefined, [
  el("Condition.subject", 1, "1", [], { type: [{ code: "Reference", targetProfile: [B + "Pat"] }] }),
  el("Condition.code", 1, "1", ["CodeableConcept"]),
]);
const narrative = sd(CORE + "Narrative", "Narrative", "complex-type", [
  el("Narrative", 0, "*"),
  el("Narrative.status", 1, "1", ["code"], { binding: { strength: "required", valueSet: "http://hl7.org/fhir/ValueSet/narrative-status" } }),
  el("Narrative.div", 1, "1", ["xhtml"]),
]);
const DOC = bundle("Bundle-d", "document", [entrySlice("composition", 1, "1", "Composition", B + "Comp-x"), entrySlice("patient", 1, "1", "Patient", B + "Pat")], "open");

test("form: document Bundle — Composition first, sections with their codes, section.entry wired, identifier / timestamp", async () => {
  const deps = fakeDeps([DOC, comp, cond, pat, obs, narrative, ...ALL.filter((x) => x !== pat && x !== obs)], {
    valueSets: {
      "http://hl7.org/fhir/ValueSet/composition-status": [{ system: "http://hl7.org/fhir/composition-status", code: "final" }, { system: "http://hl7.org/fhir/composition-status", code: "preliminary" }],
      "http://hl7.org/fhir/ValueSet/narrative-status": [{ system: "http://hl7.org/fhir/narrative-status", code: "generated" }, { system: "http://hl7.org/fhir/narrative-status", code: "additional" }],
    },
  });
  const { data, warnings } = await bundleForm({ bundle_profile: "Bundle-d", entries: [{ profile: "Cond" }, { profile: "Obs-lab" }] }, deps);
  const b = data.bundle as R;
  assert.equal(b.type, "document");
  assert.equal(b.entry[0].resource.resourceType, "Composition", "Composition first");
  const ph = checkPlaceholders(data);
  assert.ok(ph.some((p) => p.pointer === "/identifier/value" && p.type === "string"));
  assert.ok(ph.some((p) => p.pointer === "/timestamp" && p.type === "instant"));
  const entries = data.entries as R[];
  const url = (rt: string): string => entries.find((e) => e.resourceType === rt)!.fullUrl;
  const c = b.entry[0].resource;
  assert.equal(c.subject.reference, url("Patient"));
  assert.deepEqual(c.type.coding[0], { system: LOINC, code: "60591-5" });
  const probs = c.section.find((s: R) => s.code?.coding?.[0]?.code === "11450-4");
  assert.ok(probs, "the required section carries its discriminating code (optional in the profile)");
  assert.deepEqual(probs.entry, [{ reference: url("Condition") }]);
  const labs = c.section.find((s: R) => s.code?.coding?.[0]?.code === "30954-2");
  assert.ok(labs, "the optional section the planned Observation belongs to is added");
  assert.deepEqual(labs.entry, [{ reference: url("Observation") }]);
  // section.text: required by the unsliced Composition.section.text — a Narrative with status + div
  const div = ph.find((p) => p.pointer.endsWith("/section/0/text/div"))!;
  assert.equal(div.type, "xhtml");
  const status = ph.find((p) => p.pointer.endsWith("/section/0/text/status"));
  if (status) assert.equal(status.type, "code");
  // the added section is optional: its placeholders say so
  const labsIdx = c.section.indexOf(labs);
  const labTitle = ph.find((p) => p.pointer === `/entry/0/resource/section/${labsIdx}/title`)!;
  assert.equal(labTitle.required, false);
  assert.match(labTitle.if_empty!, /delete/);
  const st = ph.find((p) => p.pointer === "/entry/0/resource/status")!;
  assert.deepEqual((st.allowed as R[]).map((a) => a.code), ["final", "preliminary"]);
  assert.ok(!warnings.some((w) => /not reachable/.test(w)), warnings.join("; "));
});

test("form: errors — not a Bundle profile, empty bundle_profile", async () => {
  await assert.rejects(bundleForm({ bundle_profile: "Pat" }, fakeDeps([pat])), /not a Bundle profile/);
  await assert.rejects(bundleForm({ bundle_profile: "" }, fakeDeps([pat])), /bundle_profile is required/);
});
