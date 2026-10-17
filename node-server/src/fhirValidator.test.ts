import { test } from "node:test";
import assert from "node:assert/strict";
import { InstanceValidator, isValid, type Issue } from "./fhirValidator.js";
import { BUNDLE_PROFILE, COND_PROFILE, CORE, FakeResolver, PAT_PROFILE, VITAL } from "./fhirTestKit.test.js";

async function run(resource: Record<string, any>, profiles: string[] = []): Promise<Issue[]> {
  return new InstanceValidator(new FakeResolver()).validate(resource, { profiles });
}

const errors = (issues: Issue[]): Issue[] => issues.filter((i) => i.severity === "error" || i.severity === "fatal");
const has = (issues: Issue[], re: RegExp): boolean => errors(issues).some((i) => re.test(i.message) || re.test(i.path));

const vital = (extra: Record<string, any> = {}): Record<string, any> => ({
  resourceType: "Observation",
  meta: { profile: [VITAL] },
  status: "final",
  category: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category", code: "vital-signs" }] }],
  code: { text: "Body temperature" },
  subject: { reference: "Patient/p1" },
  ...extra,
});

// ---- Claim 1: FHIRPath choice types -------------------------------------------

test("vs-2: valueQuantity satisfies `value.exists()` (choice type resolution)", async () => {
  const issues = await run(vital({ valueQuantity: { value: 36.5, system: "http://unitsofmeasure.org", code: "Cel" } }));
  assert.deepEqual(errors(issues), []);
});

test("vs-2: dataAbsentReason instead of a value is valid", async () => {
  const issues = await run(vital({ dataAbsentReason: { text: "not measured" } }));
  assert.deepEqual(errors(issues), []);
});

test("vs-2: no value, no dataAbsentReason, no component → vs-2 error", async () => {
  const issues = await run(vital());
  assert.ok(has(issues, /vs-2/), JSON.stringify(issues));
});

test("vs-3 is evaluated per component instance with its own value[x]", async () => {
  const ok = await run({
    resourceType: "Observation",
    status: "final",
    code: { text: "bp" },
    component: [
      { code: { text: "sys" }, valueQuantity: { value: 120 } },
      { code: { text: "dia" }, valueString: "80" },
    ],
  });
  assert.deepEqual(errors(ok), []);
  const bad = await run({
    resourceType: "Observation",
    status: "final",
    code: { text: "bp" },
    component: [{ code: { text: "sys" }, valueQuantity: { value: 120 } }, { code: { text: "dia" } }],
  });
  const vs3 = errors(bad).filter((i) => /vs-3/.test(i.message));
  assert.equal(vs3.length, 1);
  assert.equal(vs3[0].path, "Observation.component[1]");
});

test("ext-1: an extension with value[x] and child extensions fails; value only passes", async () => {
  const bad = await run({
    resourceType: "Patient",
    extension: [{ url: CORE + "patient-birthPlace", valueAddress: { city: "Taipei" }, extension: [{ url: "a", valueString: "b" }] }],
  });
  assert.ok(has(bad, /ext-1/), JSON.stringify(bad));
  const ok = await run({ resourceType: "Patient", extension: [{ url: CORE + "patient-birthPlace", valueAddress: { city: "Taipei" } }] });
  assert.deepEqual(errors(ok), []);
});

test("choice type not allowed by the profile is an error; a second choice value is unrecognized", async () => {
  const wrongType = await run(vital({ valueString: "36.5" }));
  assert.ok(has(wrongType, /type 'string' is not allowed/), JSON.stringify(wrongType));
  const two = await run({ resourceType: "Observation", status: "final", code: { text: "x" }, valueString: "a", valueBoolean: true });
  assert.ok(has(two, /Unrecognized property 'valueBoolean'/), JSON.stringify(two));
});

test("primitive invariants may use `value` for the primitive itself (HL7 engine semantics)", async () => {
  const ok = await run({ resourceType: "Patient", identifier: [{ system: "http://www.moi.gov.tw", value: "A123456789" }] }, [PAT_PROFILE]);
  assert.deepEqual(errors(ok), []);
  const bad = await run({ resourceType: "Patient", identifier: [{ system: "http://www.moi.gov.tw", value: "123" }] }, [PAT_PROFILE]);
  assert.ok(has(bad, /id-card/));
});

test("ref-1 passes for a Reference without .reference (Java startsWith on empty is false)", async () => {
  const issues = await run({ resourceType: "Condition", subject: { display: "someone" } });
  assert.deepEqual(errors(issues), []);
});

test("an invariant using an unsupported function is information, never an error", async () => {
  const resolver = new FakeResolver();
  const orig = resolver.fetchStructureDefinition.bind(resolver);
  resolver.fetchStructureDefinition = async (url: string) => {
    const s = await orig(url);
    if (s && url === CORE + "Organization") {
      const copy = JSON.parse(JSON.stringify(s));
      copy.snapshot.element[0].constraint = [{ key: "x-1", severity: "error", human: "x", expression: "conformsTo('http://x')" }];
      return copy;
    }
    return s;
  };
  const issues = await new InstanceValidator(resolver).validate({ resourceType: "Organization", name: "a" });
  assert.deepEqual(errors(issues), []);
  assert.ok(issues.some((i) => i.severity === "information" && i.code === "invariant-unevaluated"));
});

// ---- Claim 2: per-instance cardinality + slicing -------------------------------

test("cardinality is counted per parent instance: two identifiers each with one `use`", async () => {
  const issues = await run(
    {
      resourceType: "Patient",
      identifier: [
        { use: "official", system: "http://www.moi.gov.tw", value: "A123456789" },
        { use: "usual", system: "http://www.moi.gov.tw", value: "B123456789" },
      ],
    },
    [PAT_PROFILE],
  );
  assert.deepEqual(errors(issues), []);
});

test("an identifier carrying two `system` values (array) is a structural error", async () => {
  const issues = await run({ resourceType: "Patient", identifier: [{ system: ["http://a.org/x", "http://b.org/y"], value: "1" }] });
  assert.ok(has(issues, /must be a simple value, not an Array/), JSON.stringify(issues));
});

test("array/object shape errors: object for a repeating element", async () => {
  const issues = await run({ resourceType: "Patient", identifier: { system: "http://a.org", value: "1" } });
  assert.ok(has(issues, /must be a JSON Array/));
});

test("required element missing in one repeat only is reported for that repeat", async () => {
  const issues = await run(
    { resourceType: "Patient", identifier: [{ system: "http://www.moi.gov.tw", value: "A123456789" }, { value: "B123456789" }] },
    [PAT_PROFILE],
  );
  const e = errors(issues).filter((i) => /identifier\.system: minimum required = 1/.test(i.message));
  assert.equal(e.length, 1);
  assert.equal(e[0].path, "Patient.identifier[1]");
});

test("required pattern slice: present → ok, missing → slice error", async () => {
  const ok = await run(vital({ valueQuantity: { value: 1, system: "http://unitsofmeasure.org", code: "Cel" } }));
  assert.deepEqual(errors(ok), []);
  const missing = await run(
    vital({
      valueQuantity: { value: 1, system: "http://unitsofmeasure.org", code: "Cel" },
      category: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category", code: "laboratory" }] }],
    }),
  );
  assert.ok(has(missing, /Slice 'Observation.category:VSCat': a matching slice is required/), JSON.stringify(missing));
});

test("type-sliced value[x]: slice children (fixed system) apply", async () => {
  const issues = await run(vital({ valueQuantity: { value: 1, system: "http://other.org", code: "Cel" } }));
  assert.ok(has(issues, /must be 'http:\/\/unitsofmeasure.org'/), JSON.stringify(issues));
});

test("closed slicing by required binding: member matches; non-member is rejected", async () => {
  const base = { resourceType: "Condition", category: [{ text: "x" }], subject: { reference: "Patient/1" } };
  const ok = await run({ ...base, code: { coding: [{ system: "http://example.tw/CodeSystem/icd", code: "I10" }] } }, [COND_PROFILE]);
  assert.deepEqual(errors(ok), []);
  const bad = await run({ ...base, code: { coding: [{ system: "http://other.org/cs", code: "X" }] } }, [COND_PROFILE]);
  assert.ok(has(bad, /slicing is CLOSED/), JSON.stringify(bad));
});

test("Bundle entries are sliced by resource profile and validated against it", async () => {
  const pat = { resourceType: "Patient", id: "p1", identifier: [{ system: "http://www.moi.gov.tw", value: "A123456789" }] };
  const ok = await run({ resourceType: "Bundle", type: "collection", entry: [{ fullUrl: "urn:uuid:00000001-0000-4000-8000-000000000000", resource: pat }] }, [BUNDLE_PROFILE]);
  assert.deepEqual(errors(ok), []);
  const badPat = { resourceType: "Patient", id: "p1", identifier: [{ system: "http://www.moi.gov.tw", value: "nope" }] };
  const bad = await run({ resourceType: "Bundle", type: "collection", entry: [{ fullUrl: "urn:uuid:00000001-0000-4000-8000-000000000000", resource: badPat }] }, [BUNDLE_PROFILE]);
  assert.ok(has(bad, /Bundle.entry:patient': a matching slice is required/), JSON.stringify(bad));
});

// ---- Claim 3: terminology --------------------------------------------------------

test("required binding: nested CodeSystem code 'resolved' is valid, 'foo' is an error", async () => {
  const mk = (code: string): Record<string, any> => ({
    resourceType: "Condition",
    subject: { reference: "Patient/1" },
    clinicalStatus: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-clinical", code }] },
  });
  for (const code of ["resolved", "remission", "relapse", "active"]) assert.deepEqual(errors(await run(mk(code))), [], code);
  const bad = await run(mk("foo"));
  assert.ok(has(bad, /None of the codings provided are in the value set/));
  assert.ok(has(bad, /Unknown code 'foo'/));
});

test("required CodeableConcept binding with text only is an error", async () => {
  const issues = await run({ resourceType: "Condition", subject: { reference: "Patient/1" }, clinicalStatus: { text: "active" } });
  assert.ok(has(issues, /No code provided/));
});

test("required binding on a bare code", async () => {
  assert.deepEqual(errors(await run({ resourceType: "Patient", gender: "female" })), []);
  assert.ok(has(await run({ resourceType: "Patient", gender: "xyz" }), /was not found in the value set/));
});

test("wrong display for a held code system is an error; a designation is accepted", async () => {
  const mk = (display: string): Record<string, any> => ({
    resourceType: "Condition",
    subject: { reference: "Patient/1" },
    category: [{ coding: [{ system: "http://example.tw/CodeSystem/icd", code: "I10", display }] }],
  });
  assert.deepEqual(errors(await run(mk("原發性高血壓"))), []);
  assert.ok(has(await run(mk("Wrong")), /Wrong Display Name/));
});

// ---- other structural checks ------------------------------------------------------

test("TW-style profile: required element missing → error", async () => {
  const issues = await run({ resourceType: "Condition", subject: { reference: "Patient/1" } }, [COND_PROFILE]);
  assert.ok(has(issues, /Condition.category: minimum required = 1/));
});

test("unknown properties, bad primitives and empty strings", async () => {
  assert.ok(has(await run({ resourceType: "Patient", foo: 1 }), /Unrecognized property 'foo'/));
  assert.ok(has(await run({ resourceType: "Patient", active: "true" }), /must be a boolean/));
  assert.ok(has(await run({ resourceType: "Patient", birthDate: "1990-02-30" }), /Not a valid date/));
  assert.ok(has(await run({ resourceType: "Patient", birthDate: "1990-13-01" }), /Not a valid date/));
  assert.ok(has(await run({ resourceType: "Patient", id: "a b" }), /Invalid Resource id/));
  assert.ok(has(await run({ resourceType: "Patient", identifier: [{ system: "http://a.org", value: "" }] }), /cannot be empty/));
  assert.deepEqual(errors(await run({ resourceType: "Patient", birthDate: "1990-02-28", active: true })), []);
});

test("extensions: unknown URL and wrong value type are errors", async () => {
  assert.ok(has(await run({ resourceType: "Patient", extension: [{ url: "http://foo.org/ext", valueString: "a" }] }), /could not be found/));
  const wrong = await run({ resourceType: "Patient", extension: [{ url: CORE + "patient-birthPlace", valueString: "a" }] });
  assert.ok(has(wrong, /type 'string' is not allowed/), JSON.stringify(wrong));
});

test("example URLs in Identifier.system are rejected like the HL7 validator", async () => {
  assert.ok(has(await run({ resourceType: "Patient", identifier: [{ system: "http://example.org/ids", value: "1" }] }), /Example URLs/));
  assert.deepEqual(errors(await run({ resourceType: "Patient", identifier: [{ system: "http://example.org.tw/ids", value: "1" }] })), []);
});

test("local reference to a missing contained resource is an error; existing one is fine", async () => {
  const bad = await run({ resourceType: "Patient", managingOrganization: { reference: "#nope" } });
  assert.ok(has(bad, /Unable to resolve resource with reference '#nope'/));
  const ok = await run({
    resourceType: "Patient",
    contained: [{ resourceType: "Organization", id: "o1", name: "x" }],
    managingOrganization: { reference: "#o1" },
  });
  assert.deepEqual(errors(ok), []);
});

test("reference target type is checked when the target resolves inside a Bundle", async () => {
  const bundle = {
    resourceType: "Bundle",
    type: "collection",
    entry: [
      { fullUrl: "urn:uuid:0000000a-0000-4000-8000-000000000000", resource: { resourceType: "Patient", managingOrganization: { reference: "urn:uuid:0000000b-0000-4000-8000-000000000000" } } },
      { fullUrl: "urn:uuid:0000000b-0000-4000-8000-000000000000", resource: { resourceType: "Patient" } },
    ],
  };
  assert.ok(has(await run(bundle), /is not a valid Target/));
});

// ---- Bundle reference resolution (HL7 resolveInBundle semantics) ---------------
// Each case mirrors a probe verified against validator.dicom.tw (HL7 validator);
// see scripts/validator-audit/REPORT.md.

const U = (n: number): string => `urn:uuid:${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
const P = (id = "p1", extra: Record<string, any> = {}): Record<string, any> => ({ resourceType: "Patient", id, ...extra });
const O = (id = "o1"): Record<string, any> => ({ resourceType: "Organization", id, name: "x" });
const B = (type: string, entry: any[]): Record<string, any> => ({ resourceType: "Bundle", type, entry });
const warns = (issues: Issue[]): Issue[] => issues.filter((i) => i.severity === "warning");
const comp = (extra: Record<string, any> = {}): Record<string, any> => ({
  resourceType: "Composition",
  id: "c1",
  status: "final",
  type: { text: "x" },
  subject: { reference: U(1) },
  date: "2024-01-01",
  author: [{ reference: U(1) }],
  title: "t",
  ...extra,
});

test("collection/transaction: a dangling urn:uuid reference is a warning, not an error", async () => {
  for (const type of ["collection", "transaction"]) {
    const issues = await run(B(type, [{ fullUrl: U(1), resource: P() }, { fullUrl: U(2), resource: P("p2", { managingOrganization: { reference: U(7) } }) }]));
    assert.deepEqual(errors(issues), [], type);
    assert.ok(warns(issues).some((i) => /URN reference is not locally contained within the bundle/.test(i.message) && i.path === "Bundle.entry[1].resource.managingOrganization"), type);
  }
});

test("collection: dangling relative and absolute references are not errors", async () => {
  const rel = await run(B("collection", [{ fullUrl: "http://ex.org/fhir/Patient/p1", resource: P("p1", { managingOrganization: { reference: "Organization/zz" } }) }]));
  assert.deepEqual(errors(rel), []);
  const abs = await run(B("collection", [{ fullUrl: "http://ex.org/fhir/Patient/p1", resource: P("p1", { managingOrganization: { reference: "http://other.org/fhir/Organization/zz" } }) }]));
  assert.deepEqual(errors(abs), []);
});

test("relative reference resolves against the entry's RESTful fullUrl (and is then type-checked)", async () => {
  const bundle = (fu: string) =>
    B("collection", [
      { fullUrl: fu + "Patient/p1", resource: P("p1", { managingOrganization: { reference: "Patient/p2" } }) },
      { fullUrl: fu + "Patient/p2", resource: P("p2") },
    ]);
  // Resolves → Patient is not a valid Organization target.
  assert.ok(has(await run(bundle("http://ex.org/fhir/")), /is not a valid Target/));
});

test("relative reference does NOT resolve by type/id when fullUrls are urn:uuid (HL7: warning hint only)", async () => {
  const issues = await run(
    B("collection", [
      { fullUrl: U(1), resource: P("p1", { managingOrganization: { reference: "Patient/p2" } }) },
      { fullUrl: U(2), resource: P("p2") },
    ]),
  );
  assert.deepEqual(errors(issues), []);
  assert.ok(warns(issues).some((i) => /matches the reference Patient\/p2 by type and id but its fullUrl/.test(i.message)));
});

test("version-specific reference resolves only to an entry with that meta.versionId", async () => {
  const mk = (versionId?: string) =>
    B("document", [
      { fullUrl: "http://ex.org/fhir/Composition/c1", resource: comp({ subject: { reference: "Patient/p1/_history/2" }, author: [{ reference: "Patient/p1" }] }) },
      { fullUrl: "http://ex.org/fhir/Patient/p1", resource: P("p1", versionId ? { meta: { versionId } } : {}) },
    ]);
  assert.deepEqual(errors(await run(mk("2"))), []);
  assert.ok(has(await run(mk()), /Can't find 'Patient\/p1\/_history\/2' in the bundle \(Composition.subject\)/));
});

test("entries need fullUrl except in transaction/batch (and their responses)", async () => {
  const c = await run(B("collection", [{ resource: P() }, { resource: O() }]));
  assert.equal(errors(c).filter((i) => /each entry in a Bundle must have a fullUrl/.test(i.message)).length, 2);
  assert.ok(has(await run(B("history", [{ resource: P() }])), /must have a fullUrl/));
  for (const type of ["transaction", "batch", "transaction-response", "batch-response"]) {
    assert.deepEqual(errors(await run(B(type, [{ resource: P() }]))), [], type);
  }
});

test("entry without fullUrl: relative references are errors; urn references are not", async () => {
  const issues = await run(B("transaction", [{ resource: P("p1", { managingOrganization: { reference: "Organization/o1" } }) }]));
  assert.ok(has(issues, /Bundle entry missing fullUrl/));
  assert.ok(errors(issues).some((i) => /Relative Reference appears inside Bundle whose entry is missing a fullUrl/.test(i.message) && i.path === "Bundle.entry[0].resource.managingOrganization"));
  const urn = await run(B("transaction", [{ resource: P("p1", { managingOrganization: { reference: U(9) } }) }]));
  assert.ok(!has(urn, /Relative Reference/));
  const containedOnly = await run(B("transaction", [{ resource: P("p1", { contained: [O("o")], managingOrganization: { reference: "#o" } }) }]));
  assert.deepEqual(errors(containedOnly), []);
});

test("a RESTful fullUrl must end with the entry's type/id", async () => {
  assert.ok(has(await run(B("collection", [{ fullUrl: "http://ex.org/fhir/Patient/p9", resource: P("p1") }])), /must end with the correct type and id \(\/Patient\/p1\)/));
  assert.deepEqual(errors(await run(B("collection", [{ fullUrl: "http://ex.org/fhir/Patient/p1", resource: P("p1") }]))), []);
});

test("document: Composition references must resolve inside the bundle", async () => {
  const ok = await run(B("document", [{ fullUrl: U(3), resource: comp() }, { fullUrl: U(1), resource: P() }]));
  assert.deepEqual(errors(ok), []);
  const cases: Array<[Record<string, any>, RegExp]> = [
    [{ subject: { reference: U(7) } }, /Can't find 'urn:uuid:00000007.*\(Composition.subject\)/],
    [{ subject: { reference: "Patient/zz" } }, /Can't find 'Patient\/zz' in the bundle \(Composition.subject\)/],
    [{ author: [{ reference: U(9) }] }, /\(Composition.author\)/],
    [{ encounter: { reference: U(9) } }, /\(Composition.encounter\)/],
    [{ custodian: { reference: U(9) } }, /\(Composition.custodian\)/],
    [{ attester: [{ mode: "legal", party: { reference: U(9) } }] }, /\(Composition.attester.party\)/],
    [{ section: [{ title: "s", entry: [{ reference: U(9) }] }] }, /\(Section Entry\)/],
    [{ section: [{ title: "s", section: [{ title: "s2", entry: [{ reference: U(9) }] }] }] }, /\(Section Entry\)/],
  ];
  for (const [extra, re] of cases) {
    const issues = await run(B("document", [{ fullUrl: U(3), resource: comp(extra) }, { fullUrl: U(1), resource: P() }]));
    assert.ok(has(issues, re), `${JSON.stringify(extra)} → ${JSON.stringify(errors(issues))}`);
  }
  // A relative reference from a urn:uuid Composition cannot resolve (no base URL).
  const urnBase = await run(B("document", [{ fullUrl: U(3), resource: comp({ subject: { reference: "Patient/p1" } }) }, { fullUrl: U(1), resource: P() }]));
  assert.ok(has(urnBase, /Can't find 'Patient\/p1' in the bundle/));
  // ...but does from a RESTful one.
  const abs = await run(
    B("document", [
      { fullUrl: "http://ex.org/fhir/Composition/c1", resource: comp({ subject: { reference: "Patient/p1" }, author: [{ reference: "Patient/p1" }] }) },
      { fullUrl: "http://ex.org/fhir/Patient/p1", resource: P() },
    ]),
  );
  assert.deepEqual(errors(abs), []);
});

test("document: orphan entries are errors; backward-only links warn; Provenance is fine", async () => {
  const orphan = await run(B("document", [{ fullUrl: U(3), resource: comp() }, { fullUrl: U(1), resource: P() }, { fullUrl: U(4), resource: O("o4") }]));
  assert.ok(errors(orphan).some((i) => i.path === "Bundle.entry[2]" && /isn't reachable by traversing links \(forward or backward\) from the Composition/.test(i.message)));
  const backLinked = await run(
    B("document", [{ fullUrl: U(3), resource: comp() }, { fullUrl: U(1), resource: O("o1") }, { fullUrl: U(4), resource: P("p4", { managingOrganization: { reference: U(1) } }) }]),
  );
  assert.ok(!has(backLinked, /isn't reachable/), JSON.stringify(errors(backLinked)));
  assert.ok(warns(backLinked).some((i) => /isn't reachable by traversing forwards from the Composition/.test(i.message)));
  const prov = await run(
    B("document", [
      { fullUrl: U(3), resource: comp() },
      { fullUrl: U(1), resource: P() },
      { fullUrl: U(5), resource: { resourceType: "Provenance", id: "pv", target: [{ reference: U(3) }], recorded: "2024-01-01T00:00:00Z" } },
    ]),
  );
  assert.deepEqual(errors(prov), []);
  assert.ok(!warns(prov).some((i) => /traversing/.test(i.message)));
});

test("collection bundles have no orphan rule", async () => {
  assert.deepEqual(errors(await run(B("collection", [{ fullUrl: U(1), resource: P() }, { fullUrl: U(4), resource: O("o4") }]))), []);
});

test("resource id syntax is checked even when the base snapshot types Resource.id as string (R4 core)", async () => {
  // The kit's Patient.id mirrors R4 core: fhir-type "string", base path Resource.id.
  assert.ok(has(await run({ resourceType: "Patient", id: "bad id!" }), /Invalid Resource id: Invalid Characters \('bad id!'\)/));
  assert.deepEqual(errors(await run({ resourceType: "Patient", id: "pat-1.A" })), []);
});

test("isValid ignores warnings and information", () => {
  assert.equal(isValid([{ severity: "warning" }, { severity: "information" }]), true);
  assert.equal(isValid([{ severity: "error" }]), false);
});
