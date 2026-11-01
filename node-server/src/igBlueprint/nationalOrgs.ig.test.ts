/**
 * ISSUES_v17.4 on the real packages (TWPAS 1.2.7 / TW Core 1.0.0 from FHIR_PACKAGE_CACHE; skipped when absent):
 * which Organization profiles are national payer / authority organizations, what fhir_get_minimal_skeleton
 * takes from the IG's examples for them, and the narrowed grounding exemption.
 *
 * Why the NHI agency (衛生福利部中央健康保險署) stays exempt for TWPAS — derived, not hard-coded:
 *   - TW Core Organization-govt-twcore pins Organization.type = organization-type#govt (rule a), and
 *   - TWPAS Coverage-twpas `Coverage.payor` and ClaimResponse-twpas `ClaimResponse.insurer` target
 *     Organization-govt-twcore and no other TWPAS element does (rule b);
 *   TWPAS's examples declare Organization-govt-twcore for the agency in all 6 instances, identically.
 * The example hospital (Organization-twpas: author / provider / requestor / serviceProvider) and TW Core's
 * generic Organization-twcore (Coverage-twcore.payor, but also custodian, performer, assigner …) are not national.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { minimalSkeleton } from "./skeleton.js";
import { igDefinedValues } from "./igValues.js";
import { nationalOrganizationBasis, nationalTypeOf, payerTargetProfiles } from "./nationalOrgs.js";
import { availableClosure, fileBlueprintDeps, pkgDir, TWCORE_CLOSURE, TWPAS_CLOSURE } from "./fileDeps.test.js";
import type { BlueprintDeps } from "./common.js";
import { checkGrounding } from "../grounding/checkGrounding.js";
import { isIgDefined } from "../grounding/igDefined.js";
import { runRecordChecks } from "../recordChecks/index.js";
import { syntheticTerminology } from "../grounding/testkit.js";

type R = Record<string, any>;

const PAS = availableClosure(TWPAS_CLOSURE);
const TWC = availableClosure(TWCORE_CLOSURE);
const pasDeps = PAS ? fileBlueprintDeps(PAS) : null;
const twcDeps = TWC ? fileBlueprintDeps(TWC) : null;

const TWC_SD = "https://twcore.mohw.gov.tw/ig/twcore/StructureDefinition/";
const PAS_SD = "https://nhicore.nhi.gov.tw/pas/StructureDefinition/";
const GOVT = `${TWC_SD}Organization-govt-twcore`;
const HOSP_PAS = `${PAS_SD}Organization-twpas`;
const RECORD = "門診病歷\n就診醫院：臺大醫院\n主訴：頭痛三天。\n診斷：緊張型頭痛。\nP: Acetaminophen 500mg 1# PO QID 3 天。";

function constraintSds(spec: string): R[] {
  const dir = pkgDir(spec)!;
  return readdirSync(dir)
    .filter((f) => f.startsWith("StructureDefinition-") && f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as R)
    .filter((s) => s.derivation === "constraint");
}

function exampleOrganizations(spec: string): R[] {
  const ex = join(pkgDir(spec)!, "example");
  if (!existsSync(ex)) return [];
  const out: R[] = [];
  for (const f of readdirSync(ex).sort()) {
    if (!f.endsWith(".json")) continue;
    const r = JSON.parse(readFileSync(join(ex, f), "utf8")) as R;
    for (const x of r.resourceType === "Bundle" ? (r.entry || []).map((e: R) => e.resource) : [r]) if (x?.resourceType === "Organization") out.push(x);
  }
  return out;
}

const declares = (r: R, url: string): boolean => ((r.meta?.profile as string[]) || []).some((u) => u.split("|")[0] === url);

/** exampleProfiles over the package's examples, as tools.ts dbIgDefinedValues does over the store. */
const exampleProfilesOf =
  (spec: string) =>
  async (types: string[]): Promise<string[]> =>
    types.includes("Organization") ? [...new Set(exampleOrganizations(spec).flatMap((o) => (o.meta?.profile as string[]) || []))] : [];

const bundleOf = (...resources: R[]): R => ({
  resourceType: "Bundle",
  type: "collection",
  entry: resources.map((r, i) => ({ fullUrl: `urn:uuid:00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, resource: r })),
});

test("TWPAS: Organization-govt-twcore is the national payer (Coverage.payor / ClaimResponse.insurer, type govt); hospitals are not", { skip: !pasDeps }, async () => {
  const targets = payerTargetProfiles(constraintSds(PAS![0]));
  assert.deepEqual([...targets.keys()], [GOVT]);
  assert.deepEqual([...new Set(targets.get(GOVT)!.map((u) => u.element))].sort(), ["ClaimResponse.insurer", "Coverage.payor"]);
  const deps = pasDeps as BlueprintDeps;
  const govt = await deps.loadProfile(GOVT, null, null);
  assert.equal(nationalTypeOf(govt.sd), "govt");
  assert.ok(await nationalOrganizationBasis(govt, deps));
  for (const u of [HOSP_PAS, `${PAS_SD}Organization-genetic-testing-twpas`, `${TWC_SD}Organization-twcore`]) {
    assert.equal(await nationalOrganizationBasis(await deps.loadProfile(u, null, null), deps), null, u);
  }
});

test("TW Core: only Organization-govt-twcore (type govt) is national; Coverage-twcore.payor's generic Organization-twcore is not", { skip: !twcDeps }, async () => {
  assert.equal(payerTargetProfiles(constraintSds(TWC![0])).size, 0, "Organization-twcore is also custodian / performer / assigner …");
  const deps = twcDeps as BlueprintDeps;
  const national: string[] = [];
  for (const id of ["Organization-twcore", "Organization-govt-twcore", "Organization-hosp-twcore", "Organization-co-twcore"]) {
    if (await nationalOrganizationBasis(await deps.loadProfile(TWC_SD + id, null, null), deps)) national.push(id);
  }
  assert.deepEqual(national, ["Organization-govt-twcore"]);
});

test("TWPAS skeleton: the example hospital's name / identifier are record; the NHI agency's are ig-constant; patterns stay", { skip: !pasDeps }, async () => {
  const rowsOf = (d: R): Map<string, [string, string]> =>
    new Map((d.table as Array<[string, string, string]>).flatMap(([p, s, h]) => p.split(", ").map((x): [string, [string, string]] => [x, [s, h]])));
  const hosp = await minimalSkeleton({ profile: HOSP_PAS }, pasDeps!);
  const ht = rowsOf(hosp.data);
  assert.equal(ht.get("identifier.value")?.[0], "record", "was ig-constant (identical in 6/6 examples) before v17.4");
  assert.equal(ht.get("name"), undefined, "the example hospital's name is not prefilled");
  assert.equal(ht.get("type"), undefined, "nor its type");
  const ex = exampleOrganizations(PAS![0]).find((o) => declares(o, HOSP_PAS))!;
  const leaves = JSON.stringify(hosp.igConstants ?? []);
  assert.ok(!leaves.includes(JSON.stringify(ex.name)), "example hospital name not an ig-constant");
  for (const i of ex.identifier || []) assert.ok(!leaves.includes(JSON.stringify(i.value)), "example hospital identifier not an ig-constant");
  assert.ok(leaves.includes("https://nhicore.nhi.gov.tw/pas/CodeSystem/organization-identifier-tw"), "the identifier.system pattern stays ig-constant");

  const govt = await minimalSkeleton({ profile: GOVT }, pasDeps!);
  const gt = rowsOf(govt.data);
  assert.equal(gt.get("name")?.[0], "ig-constant");
  assert.match(gt.get("name")![1], /national payer \/ authority organization/);
  assert.equal(gt.get("identifier")?.[0], "ig-constant");
  const nhi = exampleOrganizations(PAS![0]).find((o) => declares(o, GOVT))!;
  assert.equal((govt.data.skeleton as R).name, nhi.name);
});

test("TWPAS grounding: the IG example hospital with a record naming 臺大醫院 is reported; the NHI payer is exempt", { skip: !pasDeps }, async () => {
  const orgs = exampleOrganizations(PAS![0]);
  const strip = (o: R): R => ({ resourceType: "Organization", meta: o.meta, identifier: o.identifier, type: o.type, name: o.name });
  const hosp = strip(orgs.find((o) => declares(o, HOSP_PAS))!);
  const nhi = strip(orgs.find((o) => declares(o, GOVT))!);
  const bundle = bundleOf(hosp, nhi);
  const defs = await igDefinedValues(bundle, pasDeps!, { packageId: null, version: null, cacheKey: "v174-pas", exampleProfiles: exampleProfilesOf(PAS![0]) });
  assert.ok(!isIgDefined(hosp.name, defs), "example hospital name was exempt before v17.4");
  assert.ok(isIgDefined(nhi.name, defs));
  for (const i of nhi.identifier) assert.ok(isIgDefined(i, defs), `NHI identifier ${i.system} exempt`);

  const g = await checkGrounding({ bundle, source_text: RECORD, ig_defined: defs }, { terminology: syntheticTerminology() });
  const errors = g.entries.flatMap((e) => e.issues).filter((i) => i.severity === "error").map((i) => i.path);
  assert.ok(errors.some((p) => p.startsWith("Bundle.entry[0].resource.name")), `hospital name reported: ${errors.join(", ")}`);
  assert.ok(!errors.some((p) => p.startsWith("Bundle.entry[1].resource.name") || p.startsWith("Bundle.entry[1].resource.identifier")), `NHI exempt: ${errors.join(", ")}`);

  const rc = runRecordChecks(bundle, { sourceText: RECORD, igDefined: defs }).issues.filter((i) => i.code === "ungrounded-value").map((i) => i.path);
  assert.ok(rc.some((p) => p.startsWith("Bundle.entry[0].resource.identifier")), `hospital identifier reported: ${rc.join(", ")}`);
  assert.ok(!rc.some((p) => p.startsWith("Bundle.entry[1].resource.name") || p.startsWith("Bundle.entry[1].resource.identifier")), `NHI exempt: ${rc.join(", ")}`);
});
