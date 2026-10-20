/**
 * Equivalence of the validator / suggestion-layer performance work (shared
 * StructureDefinition indexes, process-wide lookup memos, per-call collaborator
 * dedupe): the output for a fixture is byte-identical whether every lookup is fresh
 * or served from a cache, across repeated runs, and the suggestion layer issues no
 * collaborator call at all when a validation has no issue it handles.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { probeQueryFailures, query, trackQueryFailures } from "./db.js";
import { InstanceValidator, type CodeCheck, type ValidatorResolver } from "./fhirValidator.js";
import { attachSuggestions } from "./fhirSuggestions/index.js";
import { dedupedDeps } from "./fhirSuggestions/dbDeps.js";
import type { SuggestionDeps } from "./fhirSuggestions/types.js";
import { COND_PROFILE, CORE, FakeResolver, PAT_PROFILE, SDS, VITAL } from "./fhirTestKit.test.js";

const THO = "http://terminology.hl7.org/CodeSystem/";

/** Fixtures: clean and faulty resources over the test-kit profiles (no DB). */
const FIXTURES: Array<{ id: string; resource: Record<string, any>; profile?: string }> = [
  {
    id: "patient-clean",
    profile: PAT_PROFILE,
    resource: { resourceType: "Patient", identifier: [{ system: "http://example.tw/id", value: "A123456789" }], gender: "male", birthDate: "1990-01-01", active: true },
  },
  {
    id: "patient-bad-gender-and-id",
    profile: PAT_PROFILE,
    resource: { resourceType: "Patient", identifier: [{ system: "http://example.tw/id", value: "x" }], gender: "M", birthdate: "1990-01-01" },
  },
  {
    id: "condition-unknown-code",
    profile: COND_PROFILE,
    resource: {
      resourceType: "Condition",
      subject: { reference: "Patient/p1" },
      clinicalStatus: { coding: [{ system: THO + "condition-clinical", code: "activ" }] },
      category: [{ coding: [{ system: THO + "condition-category", code: "encounter-diagnosis" }] }],
      code: { coding: [{ system: "http://hl7.org/fhir/sid/icd-10-cm", code: "E11.9" }] },
    },
  },
  {
    id: "vital-ucum-and-property",
    profile: VITAL,
    resource: {
      resourceType: "Observation",
      status: "final",
      category: [{ coding: [{ system: THO + "observation-category", code: "vital-signs" }] }],
      code: { coding: [{ system: "http://loinc.org", code: "8867-4" }] },
      subject: { reference: "Patient/p1" },
      valueQuantity: { value: 72, system: "http://unitsofmeasure.org", code: "/min", units: "bpm" },
    },
  },
  {
    id: "bundle-mixed",
    resource: {
      resourceType: "Bundle",
      type: "collection",
      entry: [
        { fullUrl: "urn:uuid:11111111-1111-4111-8111-111111111111", resource: { resourceType: "Patient", meta: { profile: [PAT_PROFILE] }, identifier: [{ system: "http://example.tw/id", value: "A123456789" }], gender: "female" } },
        { fullUrl: "urn:uuid:22222222-2222-4222-8222-222222222222", resource: { resourceType: "Condition", meta: { profile: [COND_PROFILE] }, subject: { reference: "urn:uuid:11111111-1111-4111-8111-111111111111" }, category: [{ text: "x" }], clinicalStatus: { coding: [{ system: THO + "condition-clinical", code: "active" }] } } },
      ],
    },
  },
];

/** A resolver that hands out a fresh deep copy of every definition (no shared objects, no shared index). */
class FreshCopyResolver extends FakeResolver {
  calls = 0;
  override async fetchStructureDefinition(url: string): Promise<Record<string, any> | null> {
    this.calls++;
    const sd = await super.fetchStructureDefinition(url);
    return sd ? JSON.parse(JSON.stringify(sd)) : null;
  }
}

function countingDeps(base: SuggestionDeps): { deps: SuggestionDeps; calls: Record<string, number> } {
  const calls: Record<string, number> = {};
  const deps: Record<string, any> = {};
  for (const [k, fn] of Object.entries(base)) {
    deps[k] = (...a: unknown[]) => {
      calls[k] = (calls[k] ?? 0) + 1;
      return (fn as (...x: unknown[]) => unknown)(...a);
    };
  }
  return { deps: deps as SuggestionDeps, calls };
}

function fakeSuggestionDeps(resolver: ValidatorResolver): SuggestionDeps {
  return {
    fetchStructureDefinition: (u) => resolver.fetchStructureDefinition(u),
    checkCode: (s, c, d) => resolver.checkCode(s, c, d),
    loadValueSet: (u) => resolver.fetchValueSet(u),
    valueSetContains: (u, s, c) => resolver.valueSetContains(u, s, c),
    expandValueSet: async (u) => {
      const vs = await resolver.fetchValueSet(u);
      if (!vs) return null;
      const codings = ((vs.compose?.include || []) as any[]).flatMap((i) => (i.concept || []).map((c: any) => ({ system: i.system ?? null, code: String(c.code), display: c.display ?? null })));
      return { codings, total: codings.length, truncated: false };
    },
    normalize: async (text, target) => (text.toLowerCase() === "activ" ? [{ system: target.system ?? null, code: "active", display: "Active", exact: true }] : []),
    nearCodes: async () => [],
    canonicalsUnder: async (prefix) => Object.keys(SDS).filter((u) => u.startsWith(prefix)),
    validateAgainst: async (r, p) => (await new InstanceValidator(resolver).validate(r, { profiles: [p] })) as Array<Record<string, any>>,
    resourceElementPaths: async () => null,
  };
}

async function run(resolver: ValidatorResolver, deps: SuggestionDeps, f: (typeof FIXTURES)[number]): Promise<string> {
  const resource = JSON.parse(JSON.stringify(f.resource));
  const issues = (await new InstanceValidator(resolver).validate(resource, { profiles: f.profile ? [f.profile] : [] })) as Array<Record<string, any>>;
  await attachSuggestions(issues, resource, deps);
  return JSON.stringify(issues);
}

test("equivalence: shared StructureDefinition indexes give the same output as fresh copies, run after run", async () => {
  const shared = new FakeResolver();
  const fresh = new FreshCopyResolver();
  let issues = 0;
  for (const f of FIXTURES) {
    const a = await run(shared, fakeSuggestionDeps(shared), f);
    const b = await run(shared, fakeSuggestionDeps(shared), f);
    const c = await run(fresh, fakeSuggestionDeps(fresh), f);
    assert.equal(b, a, `${f.id}: second run (indexes now cached) identical`);
    assert.equal(c, a, `${f.id}: fresh definition objects (new indexes) identical`);
    issues += JSON.parse(a).length;
  }
  assert.ok(fresh.calls > 0);
  assert.ok(issues >= 5, "the fixtures exercise the validator");
  // The faulty fixtures do carry suggestions, so the equality above covers the suggestion layer too.
  const faulty = JSON.parse(await run(shared, fakeSuggestionDeps(shared), FIXTURES[1]));
  assert.ok(faulty.some((i: any) => Array.isArray(i.suggestions) && i.suggestions.length > 0));
});

test("no handled issue → the suggestion layer calls no collaborator (zero extra lookups on a clean validation)", async () => {
  const resolver = new FakeResolver();
  for (const f of [FIXTURES[0]]) {
    const resource = JSON.parse(JSON.stringify(f.resource));
    const issues = (await new InstanceValidator(resolver).validate(resource, { profiles: [f.profile!] })) as Array<Record<string, any>>;
    assert.equal(issues.filter((i) => i.severity === "error" || i.severity === "warning").length, 0, `${f.id} is clean`);
    const { deps, calls } = countingDeps(fakeSuggestionDeps(resolver));
    await attachSuggestions(issues, resource, deps);
    assert.deepEqual(calls, {}, "no collaborator touched");
  }
  // Issues the layer does not handle (invariants, cardinality, information) are skipped without a lookup.
  const { deps, calls } = countingDeps(fakeSuggestionDeps(resolver));
  const issues = [
    { severity: "error", path: "Patient", code: "invariant", message: "Constraint failed: pat-1" },
    { severity: "error", path: "Patient.identifier", code: "required", message: "Patient.identifier: minimum required = 1, but only found 0" },
    { severity: "information", path: "Patient.x", code: "structure", message: "Unrecognized property 'x'" },
  ];
  await attachSuggestions(issues, { resourceType: "Patient" }, deps);
  assert.deepEqual(calls, {});
  assert.ok(issues.every((i) => !("suggestions" in i)));
});

test("per-validation dedupe of collaborator calls: identical questions are asked once, answers unchanged", async () => {
  const resolver = new FakeResolver();
  const { deps: counted, calls } = countingDeps(fakeSuggestionDeps(resolver));
  const deduped = dedupedDeps(counted);
  const plain = fakeSuggestionDeps(resolver);
  const a = await deduped.normalize!("activ", { system: THO + "condition-clinical" }, 5);
  const b = await deduped.normalize!("activ", { system: THO + "condition-clinical" }, 5);
  const c = await deduped.normalize!("activ", { valueSet: "http://hl7.org/fhir/ValueSet/condition-clinical" }, 5);
  assert.deepEqual(a, await plain.normalize!("activ", { system: THO + "condition-clinical" }, 5));
  assert.deepEqual(b, a);
  assert.equal(calls.normalize, 2, "same (text, target, limit) once; a different target is a different question");
  assert.deepEqual(c, await plain.normalize!("activ", { valueSet: "http://hl7.org/fhir/ValueSet/condition-clinical" }, 5));
  await deduped.expandValueSet!("http://hl7.org/fhir/ValueSet/condition-clinical", 500);
  await deduped.expandValueSet!("http://hl7.org/fhir/ValueSet/condition-clinical", 500);
  await deduped.canonicalsUnder!(CORE, ["StructureDefinition"]);
  await deduped.canonicalsUnder!(CORE, ["StructureDefinition"]);
  assert.equal(calls.expandValueSet, 1);
  assert.equal(calls.canonicalsUnder, 1);
  // A rejected call is not remembered: the next identical question is asked again.
  let n = 0;
  const flaky = dedupedDeps({
    ...plain,
    normalize: async () => {
      n++;
      if (n === 1) throw new Error("down");
      return [];
    },
  });
  await assert.rejects(flaky.normalize!("x", { system: "s" }, 1));
  assert.deepEqual(await flaky.normalize!("x", { system: "s" }, 1), []);
  assert.equal(n, 2);
  // The whole fixture set gives the same output with and without the dedupe.
  for (const f of FIXTURES) {
    assert.equal(await run(resolver, dedupedDeps(fakeSuggestionDeps(resolver)), f), await run(resolver, fakeSuggestionDeps(resolver), f), f.id);
  }
});

test("probeQueryFailures: reports failures of its own scope and still counts them in the enclosing scope", async () => {
  // No pool is initialised in unit tests: every query() fails, which is exactly what is probed.
  const outer = await trackQueryFailures(async () => {
    const clean = await probeQueryFailures(async () => 1);
    const bad = await probeQueryFailures(async () => {
      await query("SELECT 1").catch(() => undefined);
      await query("SELECT 2").catch(() => undefined);
      return 2;
    });
    return { clean, bad };
  });
  assert.deepEqual(outer.result.clean, { result: 1, failed: 0 });
  assert.deepEqual(outer.result.bad, { result: 2, failed: 2 });
  assert.equal(outer.total, 2, "propagated to the enclosing trackQueryFailures scope");
  assert.equal(outer.failures.length, 2);
  // Without an enclosing scope the probe stands alone.
  const alone = await probeQueryFailures(async () => {
    await query("SELECT 3").catch(() => undefined);
    return 3;
  });
  assert.deepEqual(alone, { result: 3, failed: 1 });
});
