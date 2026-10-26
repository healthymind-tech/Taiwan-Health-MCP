/**
 * igBlueprint against the real IG packages (ISSUES_v16 acceptance runs on both IGs): TW Core
 * 1.0.0 and TWPAS 1.2.7 from a local FHIR package cache (FHIR_PACKAGE_CACHE, default
 * ~/.fhir/packages), examples from each package's example folder. Every case is skipped when the
 * packages are not cached, so the suite stays green on a bare checkout.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { bundleBlueprint } from "./blueprint.js";
import { minimalSkeleton } from "./skeleton.js";
import { availableClosure, fileBlueprintDeps, pkgDir, TWCORE_CLOSURE, TWPAS_CLOSURE } from "./fileDeps.test.js";
import type { BlueprintDeps } from "./common.js";

type R = Record<string, any>;

const PAS = availableClosure(TWPAS_CLOSURE);
const TWC = availableClosure(TWCORE_CLOSURE);
const pasDeps = PAS ? fileBlueprintDeps(PAS) : null;
const twcDeps = TWC ? fileBlueprintDeps(TWC) : null;

function constraintProfiles(spec: string, bundles: boolean): string[] {
  const dir = pkgDir(spec);
  if (!dir) return [];
  return readdirSync(dir)
    .filter((f) => f.startsWith("StructureDefinition-") && f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as R)
    .filter((sd) => sd.kind === "resource" && sd.derivation === "constraint" && (sd.type === "Bundle") === bundles)
    .map((sd) => String(sd.id))
    .sort();
}

const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined ? [] : [v]);

/**
 * Every example-derived ig-constant on a top-level element must equal that element in EVERY example
 * instance of the profile (and there must be >= 2 of them) — checked independently of the engine.
 */
async function checkExampleConstants(deps: BlueprintDeps, profile: string, data: R): Promise<number> {
  const p = await deps.loadProfile(profile, null, null);
  const inst = await deps.exampleInstances(p, String(p.canonical));
  let checked = 0;
  for (const [path, src, how] of data.table as Array<[string, string, string]>) {
    if (src !== "ig-constant" || !/identical in (\d+)\/\1 IG example instances/.test(how)) continue;
    const n = Number(/identical in (\d+)\//.exec(how)![1]);
    assert.ok(n >= 2, `${profile} ${path}: basis of ${n} example(s)`);
    assert.equal(n, inst.length, `${profile} ${path}: basis = every example instance`);
    if (path.includes(".") || path.includes(":")) continue;
    const want = JSON.stringify(asList((data.skeleton as R)[path]));
    for (const x of inst) assert.equal(JSON.stringify(asList(x.resource[path])), want, `${profile} ${path}: differs in ${x.source}`);
    checked++;
  }
  return checked;
}

test("TWPAS: every resource profile's skeleton fits 6,000 characters; example constants are identical in all examples", { skip: !pasDeps }, async () => {
  let constants = 0;
  for (const profile of constraintProfiles(PAS![0], false)) {
    const { data } = await minimalSkeleton({ profile, envelope_provenance: { tool: "fhir_get_minimal_skeleton", toolVersion: "1.0.0" } }, pasDeps!);
    assert.ok((data.response_chars as number) <= 6000, `${profile}: ${data.response_chars}`);
    assert.equal(data.omitted, 0, `${profile}: rows omitted`);
    constants += await checkExampleConstants(pasDeps!, profile, data);
  }
  assert.ok(constants > 0);
});

test("TWPAS: the refusal cases of ISSUES_v16 get a non-record value source", { skip: !pasDeps }, async () => {
  const t = async (profile: string): Promise<Map<string, [string, string]>> => {
    const { data } = await minimalSkeleton({ profile }, pasDeps!);
    return new Map((data.table as Array<[string, string, string]>).map(([p, s, h]) => [p, [s, h]]));
  };
  const claim = await t("Claim-twpas");
  assert.equal(claim.get("item.programCode")?.[0], "text-allowed");
  assert.equal(claim.get("item.productOrService")?.[0], "code-lookup");
  assert.equal(claim.get("subType")?.[0], "code-lookup");
  assert.equal(claim.get("priority")?.[0], "code-lookup");
  const enc = await t("Encounter-twpas");
  assert.ok(![...enc.values()].some(([s]) => s === "record"), "Encounter-twpas needs no record fact (class + serviceType are codes)");
  const govt = await minimalSkeleton({ profile: "https://twcore.mohw.gov.tw/ig/twcore/StructureDefinition/Organization-govt-twcore" }, pasDeps!);
  const ids = ((govt.data.skeleton as R).identifier ?? []) as R[];
  assert.equal(ids.length, 1, "the payer agency the IG uses in every example");
});

test("TWPAS: Bundle blueprints fit 4,000 characters and carry the required references", { skip: !pasDeps }, async () => {
  for (const b of constraintProfiles(PAS![0], true)) {
    const { data } = await bundleBlueprint({ bundle_profile: b, envelope_provenance: { tool: "fhir_get_bundle_blueprint", toolVersion: "1.0.0" } }, pasDeps!);
    assert.ok((data.response_chars as number) <= 4000, `${b}: ${data.response_chars}`);
  }
  const { data } = await bundleBlueprint({ bundle_profile: "Bundle-twpas" }, pasDeps!);
  assert.equal((data.entry as R).slicing.rules, "closed");
  assert.ok((data.slices as string[]).some((s) => s.startsWith("claim 1..1 Claim-twpas")));
  const refs = data.references as string[];
  assert.ok(refs.includes("claim: extension:encounter.valueReference -> encounter"), refs.join("\n"));
  assert.ok(refs.includes("coverage: payor -> organizationOrg"), refs.join("\n"));
  const all = await bundleBlueprint({ bundle_profile: "Bundle-immunologic-agent-twpas", view: "references" }, pasDeps!);
  assert.ok((all.data.references as string[]).some((r) => r.startsWith("claim: supportingInfo:<slice>")));
});

test("TW Core: every resource profile's skeleton fits 6,000 characters; Bundle blueprints fit 4,000", { skip: !twcDeps }, async () => {
  for (const profile of constraintProfiles(TWC![0], false)) {
    const { data } = await minimalSkeleton({ profile, envelope_provenance: { tool: "fhir_get_minimal_skeleton", toolVersion: "1.0.0" } }, twcDeps!);
    assert.ok((data.response_chars as number) <= 6000, `${profile}: ${data.response_chars}`);
    assert.equal(data.omitted, 0, `${profile}: rows omitted`);
    await checkExampleConstants(twcDeps!, profile, data);
  }
  for (const b of constraintProfiles(TWC![0], true)) {
    const { data } = await bundleBlueprint({ bundle_profile: b, envelope_provenance: { tool: "fhir_get_bundle_blueprint", toolVersion: "1.0.0" } }, twcDeps!);
    assert.ok((data.response_chars as number) <= 4000, `${b}: ${data.response_chars}`);
  }
  const doc = await bundleBlueprint({ bundle_profile: "Bundle-document-twcore" }, twcDeps!);
  assert.match((doc.data.recipe as string[]).join("\n"), /entry\[0\] = the Composition/);
});
