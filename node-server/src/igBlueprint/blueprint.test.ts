/**
 * fhir_get_bundle_blueprint (ISSUES_v16 R1) over synthetic Bundle / resource profiles: slices,
 * discriminator and closed slicing, required references (direct, inside an extension, through a
 * derived target profile, "if used"), implied-required targets, Bundle.type and the size budget.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { el, sd } from "../fhirTestKit.test.js";
import { bundleBlueprint } from "./blueprint.js";
import { fakeDeps } from "./fakeDeps.test.js";

const B = "http://example.org/fhir/StructureDefinition/";
type R = Record<string, any>;

const entrySlice = (name: string, min: number, max: string, type: string, profile: string): R[] => [
  el(`Bundle.entry:${name}`, min, max, [], { sliceName: name, baseMax: "*" }),
  el(`Bundle.entry:${name}.resource`, 1, "1", [], { type: [{ code: type, profile: [profile] }] }),
];

function bundle(slices: R[][], rules = "closed"): R {
  return sd(B + "Bundle-x", "Bundle", "resource", [
    el("Bundle", 0, "*"),
    el("Bundle.type", 1, "1", ["code"], { patternCode: "collection" }),
    el("Bundle.timestamp", 1, "1", ["instant"]),
    el("Bundle.entry", 2, "*", ["BackboneElement"], { baseMax: "*", slicing: { discriminator: [{ type: "profile", path: "resource" }], rules } }),
    el("Bundle.entry.resource", 0, "1", ["Resource"]),
    ...slices.flat(),
  ], { id: "Bundle-x" });
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
  el("Claim.extension:encounter", 1, "1", [], { sliceName: "encounter", type: [{ code: "Extension", profile: [EXT] }] }),
  el("Claim.patient", 1, "1", [], { type: [{ code: "Reference", targetProfile: [B + "Pat"] }] }),
  el("Claim.insurer", 0, "1", [], { type: [{ code: "Reference", targetProfile: ["http://hl7.org/fhir/StructureDefinition/Organization"] }] }),
  el("Claim.supportingInfo", 0, "*", ["BackboneElement"], { baseMax: "*" }),
  el("Claim.supportingInfo:lab", 0, "1", ["BackboneElement"], { sliceName: "lab", mustSupport: true }),
  el("Claim.supportingInfo:lab.value[x]", 1, "1", [], { type: [{ code: "Reference", targetProfile: [B + "Obs-base"] }] }),
  el("Claim.insurance", 1, "*", ["BackboneElement"], { baseMax: "*" }),
  el("Claim.insurance.coverage", 1, "1", [], { type: [{ code: "Reference", targetProfile: [B + "Cov"] }] }),
], { id: "Claim-x" });
const cov = sd(B + "Cov", "Coverage", "resource", [
  el("Coverage", 0, "*"),
  el("Coverage.payor", 1, "*", [], { type: [{ code: "Reference", targetProfile: [B + "Org-payer"] }] }),
  el("Coverage.beneficiary", 1, "1", [], { type: [{ code: "Reference", targetProfile: [B + "Pat"] }] }),
], { id: "Cov" });
const simple = (id: string, type: string, base?: string): R => sd(B + id, type, "resource", [el(type, 0, "*")], { id, ...(base ? { baseDefinition: base } : {}) });
const obsLab = simple("Obs-lab", "Observation", B + "Obs-base");
const obsBase = simple("Obs-base", "Observation");

const ALL = [ext, claim, cov, simple("Enc", "Encounter"), simple("Pat", "Patient"), simple("Org-payer", "Organization"), obsLab, obsBase];
const SLICES = [
  entrySlice("claim", 1, "1", "Claim", B + "Claim-x"),
  entrySlice("encounter", 1, "1", "Encounter", B + "Enc"),
  entrySlice("patient", 1, "1", "Patient", B + "Pat"),
  entrySlice("coverage", 0, "1", "Coverage", B + "Cov"),
  entrySlice("payer", 0, "1", "Organization", B + "Org-payer"),
  entrySlice("lab", 0, "*", "Observation", B + "Obs-lab"),
];

test("blueprint: slices, closed profile slicing, Bundle-level rules", async () => {
  const { data } = await bundleBlueprint({ bundle_profile: "Bundle-x" }, fakeDeps([bundle(SLICES), ...ALL]));
  assert.equal(data.type, "collection");
  assert.deepEqual((data.entry as R).slicing, { rules: "closed", ordered: false, discriminator: ["profile:resource"] });
  assert.equal(data.profile_base, B);
  assert.deepEqual((data.slices as string[]).slice(0, 4), ["claim 1..1 Claim-x", "encounter 1..1 Enc (Encounter)", "patient 1..1 Pat (Patient)", "coverage 0..1 Cov (Coverage)"]);
  assert.equal((data.slices as string[])[5], "lab Obs-lab (Observation)", "0..* is implied");
  const recipe = (data.recipe as string[]).join("\n");
  assert.match(recipe, /required: timestamp/);
  assert.match(recipe, /meta\.profile = \[its slice's profile\]/);
  assert.match(recipe, /CLOSED/);
  assert.ok((data.response_chars as number) <= 4000);
});

test("blueprint: required references between slices (direct, extension value, derived target, if used)", async () => {
  const { data } = await bundleBlueprint({ bundle_profile: "Bundle-x" }, fakeDeps([bundle(SLICES), ...ALL]));
  const refs = data.references as string[];
  assert.ok(refs.includes("claim: extension:encounter.valueReference -> encounter"), refs.join("\n"));
  assert.ok(refs.includes("claim: patient -> patient"));
  assert.ok(refs.includes("claim: insurance.coverage -> coverage"));
  assert.ok(refs.includes("coverage: payor -> payer"));
  assert.ok(refs.includes("coverage: beneficiary -> patient"));
  // Obs-lab derives from Obs-base: a reference to Obs-base is satisfied by the lab slice
  assert.ok(refs.some((r) => /^claim: supportingInfo:<slice>\.valueReference \(when that slice is used\): lab->lab$/.test(r)), refs.join("\n"));
  assert.ok(!refs.some((r) => r.includes("insurer")), "a base-resource target matches no slice");
  // coverage is 0..1 but a required reference of a required slice points to it
  assert.match((data.recipe as string[]).join("\n"), /plus coverage \(a required reference points to it\)/);
});

test("blueprint: open slicing and no slices; not a Bundle profile is INVALID_ARGUMENT", async () => {
  const open = await bundleBlueprint({ bundle_profile: "Bundle-x" }, fakeDeps([bundle(SLICES, "open"), ...ALL]));
  assert.match((open.data.recipe as string[]).join("\n"), /slicing open/);
  const none = await bundleBlueprint({ bundle_profile: "Bundle-x" }, fakeDeps([bundle([]), ...ALL]));
  assert.deepEqual(none.data.slices, []);
  assert.match((none.data.recipe as string[]).join("\n"), /no entry slices/);
  await assert.rejects(bundleBlueprint({ bundle_profile: "Cov" }, fakeDeps(ALL)), (e: Error & { code?: string }) => e.code === "INVALID_ARGUMENT");
});

test("blueprint: the size budget keeps <= 4,000 characters and counts what it drops", async () => {
  const slices: R[][] = [];
  const sds: R[] = [];
  for (let i = 0; i < 60; i++) {
    slices.push(entrySlice(`slice${i}`, i < 3 ? 1 : 0, "*", "Observation", `${B}Observation-profile-${i}`));
    sds.push(sd(`${B}Observation-profile-${i}`, "Observation", "resource", [el("Observation", 0, "*"), el("Observation.subject", 1, "1", [], { type: [{ code: "Reference", targetProfile: [`${B}Observation-profile-${(i + 1) % 60}`] }] })], { id: `Observation-profile-${i}` }));
  }
  const { data } = await bundleBlueprint({ bundle_profile: "Bundle-x" }, fakeDeps([bundle(slices), ...sds]));
  assert.ok((data.response_chars as number) <= 4000, String(data.response_chars));
  const om = data.omitted as R;
  assert.ok(om.references > 0 || om.slices > 0);
  const refs = await bundleBlueprint({ bundle_profile: "Bundle-x", view: "references" }, fakeDeps([bundle(slices), ...sds]));
  assert.ok((refs.data.references as string[]).length > (data.references as string[]).length);
  assert.ok((refs.data.response_chars as number) <= 4000);
});
