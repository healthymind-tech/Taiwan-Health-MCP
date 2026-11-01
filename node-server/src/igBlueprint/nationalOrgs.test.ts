/**
 * ISSUES_v17.4 — national payer / authority organizations (nationalOrgs.ts) and the narrowed IG-defined
 * exemption (igValues.ts) on synthetic profiles (no DB, no package cache): an example hospital's name /
 * identifier is a record fact (reported when the record names another hospital); the payer agency the IG
 * reuses in its examples is exempt.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { el, sd } from "../fhirTestKit.test.js";
import { fakeDeps } from "./fakeDeps.test.js";
import { nationalTypeOf, payerTargetProfiles } from "./nationalOrgs.js";
import { igDefinedValues } from "./igValues.js";
import { checkGrounding } from "../grounding/checkGrounding.js";
import { isIgDefined } from "../grounding/igDefined.js";
import { runRecordChecks } from "../recordChecks/index.js";
import { syntheticTerminology } from "../grounding/testkit.js";

type R = Record<string, any>;
const B = "http://example.org/fhir/StructureDefinition/";
const ORG_TYPE = "http://terminology.hl7.org/CodeSystem/organization-type";

const ref = (id: string, min: number, max: string, targets: string[]): R => el(id, min, max, [], { baseMax: max, type: [{ code: "Reference", targetProfile: targets.map((t) => B + t) }] });

const HOSP = sd(B + "Org-hosp", "Organization", "resource", [
  el("Organization", 0, "*"),
  el("Organization.identifier", 1, "*", ["Identifier"], { baseMax: "*" }),
  el("Organization.identifier.system", 1, "1", ["uri"], { patternUri: "https://example.org/hospital-id" }),
  el("Organization.identifier.value", 1, "1", ["string"]),
  el("Organization.name", 1, "1", ["string"]),
], { id: "Org-hosp", derivation: "constraint" });
const PAYER = sd(B + "Org-payer", "Organization", "resource", [
  el("Organization", 0, "*"),
  el("Organization.identifier", 0, "*", ["Identifier"], { baseMax: "*" }),
  el("Organization.name", 0, "1", ["string"]),
], { id: "Org-payer", derivation: "constraint" });
const COV = sd(B + "Cov", "Coverage", "resource", [el("Coverage", 0, "*"), el("Coverage.status", 1, "1", ["code"]), ref("Coverage.payor", 1, "*", ["Org-payer"]), ref("Coverage.beneficiary", 1, "1", ["Pat"])], {
  id: "Cov",
  derivation: "constraint",
});
const COMP = sd(B + "Comp", "Composition", "resource", [el("Composition", 0, "*"), ref("Composition.custodian", 0, "1", ["Org-hosp"]), ref("Composition.author", 1, "*", ["Org-hosp"])], {
  id: "Comp",
  derivation: "constraint",
});
const SDS = [HOSP, PAYER, COV, COMP];

const hospEx = (id: string): R => ({ resourceType: "Organization", id, meta: { profile: [B + "Org-hosp"] }, identifier: [{ system: "https://example.org/hospital-id", value: "0101090517" }], name: "範例市立聯合醫院" });
const payerEx = (id: string): R => ({ resourceType: "Organization", id, meta: { profile: [B + "Org-payer"] }, identifier: [{ system: "urn:oid:9.9.9", value: "A21030000I" }], name: "國家保險署" });
const EXAMPLES = [hospEx("h1"), hospEx("h2"), hospEx("h3"), payerEx("p1"), payerEx("p2")];
const exampleProfiles = async (types: string[]): Promise<string[]> => [...new Set(EXAMPLES.filter((x) => types.includes(x.resourceType)).flatMap((x) => x.meta.profile as string[]))];

const RECORD = "門診病歷\n就診醫院：臺大醫院\n主訴：頭痛三天。\n診斷：緊張型頭痛。";

const bundleOf = (...resources: R[]): R => ({
  resourceType: "Bundle",
  type: "collection",
  entry: resources.map((r, i) => ({ fullUrl: `urn:uuid:00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, resource: r })),
});

test("nationalOrgs: type pinned to govt / pay / ins; only-payer targets; generic targets excluded", () => {
  const govt = sd(B + "G", "Organization", "resource", [el("Organization", 0, "*"), el("Organization.type", 1, "*", ["CodeableConcept"], { patternCodeableConcept: { coding: [{ system: ORG_TYPE, code: "govt" }] } })]);
  const prov = sd(B + "P", "Organization", "resource", [el("Organization", 0, "*"), el("Organization.type", 1, "*", ["CodeableConcept"], { patternCodeableConcept: { coding: [{ system: ORG_TYPE, code: "prov" }] } })]);
  const otherSystem = sd(B + "O", "Organization", "resource", [el("Organization", 0, "*"), el("Organization.type", 1, "*", ["CodeableConcept"], { patternCodeableConcept: { coding: [{ system: "urn:x", code: "govt" }] } })]);
  assert.equal(nationalTypeOf(govt), "govt");
  assert.equal(nationalTypeOf(prov), null);
  assert.equal(nationalTypeOf(otherSystem), null, "a code of another system is not the organization-type kind");
  const t = payerTargetProfiles(SDS);
  assert.deepEqual([...t.keys()], [B + "Org-payer"]);
  assert.equal(t.get(B + "Org-payer")![0].element, "Coverage.payor");
  const both = payerTargetProfiles([...SDS, sd(B + "Cl", "Claim", "resource", [el("Claim", 0, "*"), ref("Claim.provider", 1, "1", ["Org-payer"])], { derivation: "constraint" })]);
  assert.equal(both.size, 0, "a profile also used as Claim.provider is not national");
});

test("igDefined (v17.4): the IG's example hospital is not exempt (record names another hospital); the payer agency is", async () => {
  const deps = fakeDeps(SDS, { examples: EXAMPLES });
  const hosp = hospEx("x");
  const payer = payerEx("y");
  const bundle = bundleOf(hosp, payer);
  const defs = await igDefinedValues(bundle, deps, { packageId: null, version: null, cacheKey: "v174-synthetic", exampleProfiles });
  assert.ok(!isIgDefined("範例市立聯合醫院", defs), "example hospital name not IG-defined");
  assert.ok(!isIgDefined(hosp.identifier[0], defs), "example hospital identifier not IG-defined");
  assert.ok(isIgDefined("國家保險署", defs), "payer agency name IG-defined");
  assert.ok(isIgDefined(payer.identifier[0], defs), "payer agency identifier IG-defined");

  const g = await checkGrounding({ bundle, source_text: RECORD, ig_defined: defs }, { terminology: syntheticTerminology() });
  const errors = g.entries.flatMap((e) => e.issues).filter((i) => i.severity === "error").map((i) => i.path);
  assert.ok(errors.some((p) => p.startsWith("Bundle.entry[0].resource.name")), `example hospital name reported: ${errors.join(", ")}`);
  assert.ok(!errors.some((p) => p.startsWith("Bundle.entry[1].")), `payer agency exempt: ${errors.join(", ")}`);

  const rc = runRecordChecks(bundle, { sourceText: RECORD, igDefined: defs }).issues.filter((i) => i.code === "ungrounded-value").map((i) => i.path);
  assert.ok(rc.some((p) => p.startsWith("Bundle.entry[0].resource.identifier")), `example hospital identifier reported: ${rc.join(", ")}`);
  assert.ok(!rc.some((p) => p.startsWith("Bundle.entry[1].")), `payer agency exempt in the record checks: ${rc.join(", ")}`);
});
