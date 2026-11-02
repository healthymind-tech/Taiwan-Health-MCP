/** ROUND 9 parity layer: a binding over a system nobody can check is decided, and extended_findings reaches the tool output. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { completenessOf, InstanceValidator, type CodeCheck, type Issue } from "../fhirValidator.js";
import { CORE, FakeResolver } from "../fhirTestKit.test.js";
import { FHIRIGService } from "../fhirIgService.js";

type Json = Record<string, any>;
const P = "http://x/StructureDefinition/obs-ext";
const VS = "http://x/ValueSet/nobody";
const SYS = "http://x/CodeSystem/nobody";

class R extends FakeResolver {
  /** What the terminology answers for SYS: unknown to everyone, or undecided (the server would check it). */
  constructor(private readonly answer: CodeCheck, private readonly strength = "required") {
    super();
  }
  async fetchStructureDefinition(url: string): Promise<Json | null> {
    if (url.split("|")[0] !== P) return super.fetchStructureDefinition(url);
    const base = JSON.parse(JSON.stringify(await super.fetchStructureDefinition(CORE + "Observation")));
    base.url = P;
    base.derivation = "constraint";
    for (const e of base.snapshot.element) if (e.path === "Observation.code") e.binding = { strength: this.strength, valueSet: VS };
    return base;
  }
  async fetchValueSet(url: string): Promise<Json | null> {
    return url.split("|")[0] === VS ? { resourceType: "ValueSet", url: VS, version: "1", name: "Nobody", status: "active", compose: { include: [{ system: SYS }] } } : super.fetchValueSet(url);
  }
  async valueSetContains(url: string, system: string | null, code: string): Promise<boolean | undefined> {
    return url.split("|")[0] === VS ? undefined : super.valueSetContains(url, system, code);
  }
  async checkCode(system: string, code: string, display: string | null): Promise<CodeCheck> {
    return system === SYS ? this.answer : super.checkCode(system, code, display);
  }
}

const obs = { resourceType: "Observation", id: "o", meta: { profile: [P] }, status: "final", code: { coding: [{ system: SYS, code: "x" }] } };

for (const strength of ["required", "extensible"]) test(`a ${strength} binding over a system nobody can check: only UNKNOWN_CODESYSTEM, and every check was done`, async () => {
  const issues: Issue[] = await new InstanceValidator(new R({ status: "unknown-system" }, strength)).validate(obs);
  assert.deepEqual(issues.filter((i) => i.severity === "error" && i.code !== "invariant"), []);
  assert.equal(issues.some((i) => /None of the codings/.test(i.message)), false, "CODESYSTEM_UNSUPPORTED: no binding issue (jar oracle)");
  assert.ok(issues.some((i) => i.path === "Observation.code.coding[0].system" && /A definition for CodeSystem .* could not be found/.test(i.message)), JSON.stringify(issues));
  assert.equal(completenessOf(issues).checked_fully, true);
});

test("the same binding when the validator's server would check the system: unchecked, never a pass", async () => {
  const issues: Issue[] = await new InstanceValidator(new R({ status: "silent", undecided: true })).validate(obs);
  const c = completenessOf(issues);
  assert.equal(c.checked_fully, false);
  assert.ok(c.undecided_causes?.includes(`${SYS}|${VS}`) || c.codes_unchecked?.includes(SYS), JSON.stringify(c));
});

test("completeness: an unknown profile does not lower checked_fully, an unresolved ValueSet does", () => {
  const profile = { severity: "warning", path: "p", code: "not-found", message: "m", unchecked: { kind: "profile", canonical: "http://x/p" } };
  const vs = { severity: "warning", path: "p", code: "not-found", message: "m", unchecked: { kind: "valueSet", canonical: "http://x/vs" } };
  assert.deepEqual(completenessOf([profile]), { checked_fully: true, profiles_unchecked: ["http://x/p"], valuesets_unchecked: [] });
  assert.equal(completenessOf([vs]).checked_fully, false);
  assert.equal(completenessOf([profile], [{ package_id: "x", version: "1" }]).checked_fully, false);
});

function service(): Record<string, any> {
  const svc = new FHIRIGService(null) as unknown as Record<string, any>;
  svc.resolve = async () => ({ package_id: "p", version: "1", fhir_version: "4.0.1" });
  svc.validateCore = async () => ({ valid: true, issues: [], checked_fully: true, profiles_unchecked: [], valuesets_unchecked: [] });
  return svc;
}

const noFindings = { unknownToValidator: async () => false, held: async () => ({ held: "no" }), profileResolves: async () => true, profilesOf: async () => [] };

test("fhir_validate_bundle / _resource: extended_findings beside issues; absent when empty, and the output stays byte-identical", async () => {
  const svc = service();
  const bundle = { resourceType: "Bundle", type: "collection", meta: { profile: ["http://x/none"] } };
  svc.extendedDeps = () => ({ ...noFindings, profileResolves: async () => false, profilesOf: async () => ["http://x/none-at-all"] });
  const env = JSON.parse(await svc.validateBundle(bundle));
  assert.equal(env.data.extended_findings.summary.errors, 1);
  assert.equal(env.data.extended_findings.findings[0].kind, "unresolvable-profile");
  assert.deepEqual(env.data.issues, []);
  assert.equal(env.data.valid, true);
  assert.equal(env.data.checked_fully, true);

  svc.extendedDeps = () => noFindings;
  const clean = await svc.validateBundle(bundle);
  assert.equal(clean.includes("extended_findings"), false);
  const res = await svc.validateResource({ resourceType: "Patient" });
  assert.equal(res.includes("extended_findings"), false);
});

test("no verdict, no findings", async () => {
  const svc = service();
  svc.validateCore = async () => ({ valid: null, issues: [], checked_fully: false, profiles_unchecked: [], valuesets_unchecked: [] });
  svc.extendedDeps = () => {
    throw new Error("must not run");
  };
  assert.equal((await svc.validateResource({ resourceType: "Patient" })).includes("extended_findings"), false);
});
