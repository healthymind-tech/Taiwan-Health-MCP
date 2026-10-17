/**
 * v6: `|version` canonicals (HL7 CanonicalResourceManager.getByPackage semantics),
 * completeness reporting, slice members vs base-element rules, and the partial
 * CodeSystem hint. Behaviour confirmed with validator_cli 7.0.1 (corpus v6_probes).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  InstanceValidator,
  completenessOf,
  isValid,
  pickCanonicalVersion,
  splitCanonicalVersion,
  type Issue,
} from "./fhirValidator.js";
import { partialCodeSystemHint } from "./fhirValidationResolver.js";
import { CORE, FakeResolver, el, sd } from "./fhirTestKit.test.js";

const PV = "http://example.tw/fhir/StructureDefinition/patv";
const SLICED = "http://example.tw/fhir/StructureDefinition/pat-sliced";
const REFP = "http://example.tw/fhir/StructureDefinition/pat-ref";

const patBase = (): Array<Record<string, any>> => [
  el("Patient", 0, "*"),
  el("Patient.id", 0, "1", ["id"]),
  el("Patient.meta", 0, "1", ["Meta"]),
  el("Patient.contained", 0, "*", ["Resource"]),
  el("Patient.extension", 0, "*", ["Extension"]),
];

/** Two versions of one profile: 1.0.0 requires identifier.system, 2.0.0 requires birthDate. */
const PV_VERSIONS = [
  sd(PV, "Patient", "resource", [...patBase(), el("Patient.identifier", 0, "*", ["Identifier"]), el("Patient.identifier.system", 1, "1", ["uri"]), el("Patient.identifier.value", 0, "1", ["string"]), el("Patient.birthDate", 0, "1", ["date"])], { version: "1.0.0" }),
  sd(PV, "Patient", "resource", [...patBase(), el("Patient.identifier", 0, "*", ["Identifier"]), el("Patient.birthDate", 1, "1", ["date"])], { version: "2.0.0" }),
];

/** Identifier slice that does not repeat the base element's `system` 1..1 (TW Core 0.3.2 shape). */
const SLICED_SD = sd(SLICED, "Patient", "resource", [
  ...patBase(),
  el("Patient.identifier", 0, "*", ["Identifier"], { slicing: { discriminator: [{ type: "value", path: "use" }], rules: "open" } }),
  el("Patient.identifier.use", 0, "1", ["code"]),
  el("Patient.identifier.system", 1, "1", ["uri"]),
  el("Patient.identifier.value", 0, "1", ["string"]),
  el("Patient.identifier:official", 0, "1", ["Identifier"]),
  el("Patient.identifier:official.use", 1, "1", ["code"], { fixedCode: "official" }),
  el("Patient.identifier:official.system", 0, "1", ["uri"]),
  el("Patient.identifier:official.value", 1, "1", ["string"]),
]);

const refProfile = (target: string[], typeProfile: string | null, vs: string | null): Record<string, any> =>
  sd(REFP, "Patient", "resource", [
    ...patBase(),
    el("Patient.identifier", 0, "*", [], { type: [{ code: "Identifier", ...(typeProfile ? { profile: [typeProfile] } : {}) }] }),
    el("Patient.gender", 0, "1", ["code"], vs ? { binding: { strength: "required", valueSet: vs } } : {}),
    el("Patient.managingOrganization", 0, "1", [], { type: [{ code: "Reference", targetProfile: target }] }),
  ]);

/** FakeResolver plus versioned StructureDefinitions / ValueSets resolved with pickCanonicalVersion. */
class VersionedResolver extends FakeResolver {
  constructor(private readonly extra: Array<Record<string, any>> = []) {
    super();
  }
  /** Extra resources by canonical; the testkit fakes count as version 4.0.1 (R4 core). */
  private async resolve(kind: string, url: string, fallback: (u: string) => Promise<Record<string, any> | null>): Promise<Record<string, any> | null> {
    const { url: canonical, version } = splitCanonicalVersion(url);
    const local = this.extra.filter((r) => r.url === canonical && r.resourceType === kind);
    if (local.length) return version === null ? local[local.length - 1] : pickCanonicalVersion(local, version);
    if (version !== null && !pickCanonicalVersion([{ version: "4.0.1" }], version)) return null;
    return fallback(canonical);
  }
  override fetchStructureDefinition(url: string): Promise<Record<string, any> | null> {
    return this.resolve("StructureDefinition", url, (u) => super.fetchStructureDefinition(u));
  }
  override fetchValueSet(url: string): Promise<Record<string, any> | null> {
    return this.resolve("ValueSet", url, (u) => super.fetchValueSet(u));
  }
}

async function run(resource: Record<string, any>, extra: Array<Record<string, any>> = []): Promise<Issue[]> {
  return new InstanceValidator(new VersionedResolver(extra)).validate(resource);
}
const errs = (issues: Issue[]): Issue[] => issues.filter((i) => i.severity === "error" || i.severity === "fatal");

// ---- pure version helpers -------------------------------------------------------

test("splitCanonicalVersion splits at the last '|'", () => {
  assert.deepEqual(splitCanonicalVersion("http://x/SD/a|1.0.0"), { url: "http://x/SD/a", version: "1.0.0" });
  assert.deepEqual(splitCanonicalVersion("http://x/SD/a"), { url: "http://x/SD/a", version: null });
  assert.deepEqual(splitCanonicalVersion("http://x/SD/a|"), { url: "http://x/SD/a", version: null });
});

test("pickCanonicalVersion ports CanonicalResourceManager.getByPackage", () => {
  const c = [{ version: "1.0.0" }, { version: "1.0.3" }, { version: "1.1.0" }, { version: "2.0.0-ballot" }, { version: null }];
  assert.equal(pickCanonicalVersion(c, "1.0.0")?.version, "1.0.0"); // exact
  assert.equal(pickCanonicalVersion(c, "1.0")?.version, "1.0.3"); // maj.min → newest of the line
  assert.equal(pickCanonicalVersion(c, "1.0.9")?.version, "1.0.3"); // nonexistent patch → maj.min index
  assert.equal(pickCanonicalVersion(c, "1.x")?.version, "1.1.0"); // wildcard
  assert.equal(pickCanonicalVersion(c, "2.0.0")?.version, "2.0.0-ballot"); // labels removed for maj.min
  assert.equal(pickCanonicalVersion(c, "1"), null); // major only: not maj.min-shaped
  assert.equal(pickCanonicalVersion(c, "9.9.9"), null);
  assert.equal(pickCanonicalVersion([{ version: "2022-07-29" }], "2022-07-29")?.version, "2022-07-29");
  assert.equal(pickCanonicalVersion([{ version: "2022-07-29" }], "2022-07-30"), null);
});

// ---- meta.profile |version --------------------------------------------------------

const patNoSystem = (profile: string): Record<string, any> => ({ resourceType: "Patient", meta: { profile: [profile] }, identifier: [{ value: "A1" }] });

test("meta.profile |version is checked against that version only", async () => {
  const v1 = await run(patNoSystem(`${PV}|1.0.0`), PV_VERSIONS);
  assert.ok(errs(v1).some((i) => /identifier\.system: minimum required = 1/.test(i.message)), JSON.stringify(v1));
  assert.ok(!errs(v1).some((i) => /birthDate/.test(i.message)));
  const v2 = await run(patNoSystem(`${PV}|2.0.0`), PV_VERSIONS);
  assert.ok(errs(v2).some((i) => /birthDate: minimum required = 1/.test(i.message)), JSON.stringify(v2));
  assert.ok(!errs(v2).some((i) => /identifier\.system/.test(i.message)));
  // maj.min release line resolves (HL7 index url|maj.min)
  assert.ok(errs(await run(patNoSystem(`${PV}|1.0.7`), PV_VERSIONS)).some((i) => /identifier\.system/.test(i.message)));
});

test("meta.profile at a version that is not installed: warning, not checked, completeness says so", async () => {
  const issues = await run(patNoSystem(`${PV}|9.9.9`), PV_VERSIONS);
  assert.ok(isValid(issues), JSON.stringify(issues)); // HL7: Validation_VAL_Profile_Unknown is a warning
  const w = issues.find((i) => i.path === "Patient.meta.profile[0]");
  assert.equal(w?.severity, "warning");
  assert.equal(w?.message, `Profile reference '${PV}|9.9.9' has not been checked because it could not be found`);
  assert.deepEqual(completenessOf(issues), { checked_fully: false, profiles_unchecked: [`${PV}|9.9.9`], valuesets_unchecked: [] });
  assert.deepEqual(completenessOf(await run(patNoSystem(`${PV}|1.0.0`), PV_VERSIONS)).profiles_unchecked, []);
  assert.equal(completenessOf([], [{ package_id: "x", version: "1" }]).checked_fully, false);
});

// ---- slice members also satisfy the base element ------------------------------------------

test("a slice member is checked against the slicing base element too (InstanceValidator.checkChild)", async () => {
  const bad = await run({ resourceType: "Patient", meta: { profile: [SLICED] }, identifier: [{ use: "official", value: "A123456789" }] }, [SLICED_SD]);
  const e = errs(bad).filter((i) => /Patient\.identifier\.system: minimum required = 1/.test(i.message));
  assert.equal(e.length, 1, JSON.stringify(bad));
  assert.equal(e[0].path, "Patient.identifier[0]");
  const ok = await run({ resourceType: "Patient", meta: { profile: [SLICED] }, identifier: [{ use: "official", system: "http://www.moi.gov.tw", value: "A123456789" }] }, [SLICED_SD]);
  assert.deepEqual(errs(ok), []);
  // slice-only rule still applies (value 1..1 on the slice)
  const noValue = await run({ resourceType: "Patient", meta: { profile: [SLICED] }, identifier: [{ use: "official", system: "http://www.moi.gov.tw" }] }, [SLICED_SD]);
  assert.ok(errs(noValue).some((i) => /identifier:official\.value: minimum required = 1/.test(i.message)));
});

// ---- target profile / type profile / binding ValueSet with |version ------------------------

const withOrg = (profile: string): Record<string, any> => ({
  resourceType: "Patient",
  meta: { profile: [profile] },
  contained: [{ resourceType: "Organization", id: "o1", name: "x" }],
  managingOrganization: { reference: "#o1" },
});

test("targetProfile |version: installed → fine; not installed → Reference_REF_CantResolveProfile (error)", async () => {
  assert.deepEqual(errs(await run(withOrg(REFP), [refProfile([`${CORE}Organization|4.0.1`], null, null)])), []);
  const bad = await run(withOrg(REFP), [refProfile([`${CORE}Organization|9.9.9`], null, null)]);
  assert.ok(errs(bad).some((i) => i.message === `Unable to resolve the profile reference '${CORE}Organization|9.9.9'`), JSON.stringify(bad));
  assert.deepEqual(completenessOf(bad).profiles_unchecked, [`${CORE}Organization|9.9.9`]);
});

test("type profile |version not installed → Validation_VAL_Unknown_Profile (error)", async () => {
  const r = { resourceType: "Patient", meta: { profile: [REFP] }, identifier: [{ system: "http://x", value: "1" }] };
  assert.deepEqual(errs(await run(r, [refProfile([], `${CORE}Identifier|4.0.1`, null)])), []);
  const bad = await run(r, [refProfile([], `${CORE}Identifier|9.9.9`, null)]);
  assert.ok(errs(bad).some((i) => i.message === `Unknown profile ${CORE}Identifier|9.9.9`), JSON.stringify(bad));
});

test("required binding to a ValueSet version that is not installed: warning + valuesets_unchecked", async () => {
  const r = { resourceType: "Patient", meta: { profile: [REFP] }, gender: "bogus" };
  const pinned = await run(r, [refProfile([], null, "http://hl7.org/fhir/ValueSet/administrative-gender|4.0.1")]);
  assert.ok(errs(pinned).some((i) => /administrative-gender\|4\.0\.1/.test(i.message)), JSON.stringify(pinned));
  const missing = await run({ resourceType: "Patient", meta: { profile: [REFP] }, gender: "male" }, [refProfile([], null, "http://hl7.org/fhir/ValueSet/administrative-gender|9.9.9")]);
  assert.ok(isValid(missing), JSON.stringify(missing));
  assert.deepEqual(completenessOf(missing).valuesets_unchecked, ["http://hl7.org/fhir/ValueSet/administrative-gender|9.9.9"]);
});

// ---- partial CodeSystem hint ----------------------------------------------------------

test("partialCodeSystemHint: description says partial, or count exceeds the concepts held", () => {
  const desc = "臺灣健保署用藥品項代碼。因代碼量較大會使載入頁面時間較長，為方便使用者瀏覽，此處僅擷取部分代碼，完整代碼可至[全國專門術語服務平臺－代碼系統(Code System)](https://fhir.mohw.gov.tw/ts/codesystem.jsp)查閱";
  const h = partialCodeSystemHint({ url: "https://twcore/CodeSystem/x", version: "2025-04-30", content: "complete", description: desc, concept: [{ code: "A" }] });
  assert.match(h!, /only part of the codes/);
  assert.match(h!, /https:\/\/fhir\.mohw\.gov\.tw\/ts\/codesystem\.jsp/);
  assert.match(partialCodeSystemHint({ url: "u", content: "complete", count: 10, concept: [{ code: "A", concept: [{ code: "B" }] }] })!, /count 10 but carries 2/);
  assert.equal(partialCodeSystemHint({ url: "u", content: "complete", count: 2, concept: [{ code: "A" }, { code: "B" }] }), null);
  assert.equal(partialCodeSystemHint({ url: "u", content: "fragment", description: desc }), null);
});
