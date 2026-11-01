/**
 * parity v3, area loader-snapshot-ucum (REVIEW_port_2 G6 / G33 / G12 / G31 / G32 / G8 / G9): load-time package
 * fixes (PackageHackerRN), snapshot-failure semantics (ContextUtilities / ProfileUtilities / InstanceValidator),
 * slices without a slicer, logical models on Base, and the ucum-java grammar + UCUM display check. Synthetic only.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { fixPackageResource } from "./fhirPackageHacker.js";
import { generateSnapshotAsync, makeBaseDefinition, SnapshotGenerator } from "./fhirSnapshotGenerator.js";
import { checkUcumCode, ucumDisplayIssue, ucumDisplays } from "./fhirUcum.js";
import { completenessOf, InstanceValidator, type Issue } from "./fhirValidator.js";
import { CORE, FakeResolver, SDS, el, sd } from "./fhirTestKit.test.js";

type Json = Record<string, any>;
const errors = (issues: Issue[]): Issue[] => issues.filter((i) => i.severity === "error" || i.severity === "fatal");

// ------------------------------------------------------------------------------------------- G6 / G33 PackageHackerRN

const UCUM_VC = "http://hl7.org/fhir/ValueSet/ucum-vitals-common|4.0.1";
function vitalsLike(url: string, base: string, version = "4.0.1"): Json {
  const comp = (): Json => ({ id: "Observation.component.value[x]", path: "Observation.component.value[x]", binding: { strength: "required", valueSet: UCUM_VC } });
  return { resourceType: "StructureDefinition", url, version, type: "Observation", baseDefinition: base, snapshot: { element: [comp()] }, differential: { element: [comp()] } };
}

test("G6 PHR:120-135: core R4 vitalsigns and its direct children get an extensible ucum-vitals-common binding", () => {
  for (const url of [CORE + "vitalsigns", CORE + "bodyweight"]) {
    const r = fixPackageResource(vitalsLike(url, url.endsWith("vitalsigns") ? CORE + "Observation" : CORE + "vitalsigns"), "hl7.fhir.r4.core");
    assert.equal(r.snapshot.element[0].binding.strength, "extensible", url);
    assert.equal(r.differential.element[0].binding.strength, "extensible", url);
  }
  // not core (IG profile on vitalsigns), not 4.0.1, or a grandchild: unchanged, as in Java
  for (const s of [vitalsLike("http://ex.org/StructureDefinition/bw", CORE + "vitalsigns"), vitalsLike(CORE + "vitalsigns", CORE + "Observation", "5.0.0"), vitalsLike(CORE + "bmi-x", CORE + "bodyweight")]) {
    assert.equal(fixPackageResource(s, "hl7.fhir.r4.core").snapshot.element[0].binding.strength, "required", s.url);
  }
});

test("G6 end to end: a component.valueString is not checked against the backed-off binding", async () => {
  const OBS_VS = vitalsLike(CORE + "vitalsigns-g6", CORE + "Observation");
  OBS_VS.url = CORE + "vitalsigns";
  const prof = sd(CORE + "vitalsigns", "Observation", "resource", [
    ...SDS[CORE + "Observation"].snapshot.element.filter((e: Json) => !String(e.path).startsWith("Observation.component")),
    el("Observation.component", 0, "*", ["BackboneElement"]),
    el("Observation.component.code", 1, "1", ["CodeableConcept"]),
    el("Observation.component.value[x]", 0, "1", ["Quantity", "string"], { binding: { strength: "required", valueSet: UCUM_VC } }),
  ]);
  prof.version = "4.0.1";
  prof.baseDefinition = CORE + "Observation";
  class R extends FakeResolver {
    constructor(private readonly p: Json) {
      super();
    }
    async fetchStructureDefinition(url: string): Promise<Json | null> {
      return url.split("|")[0] === CORE + "vitalsigns" ? this.p : super.fetchStructureDefinition(url);
    }
    async fetchValueSet(url: string): Promise<Json | null> {
      return url.startsWith("http://hl7.org/fhir/ValueSet/ucum-vitals-common")
        ? { resourceType: "ValueSet", url: "http://hl7.org/fhir/ValueSet/ucum-vitals-common", version: "4.0.1", compose: { include: [{ system: "http://unitsofmeasure.org", concept: [{ code: "kg" }] }] } }
        : super.fetchValueSet(url);
    }
    async valueSetContains(url: string, system: string | null, code: string): Promise<boolean | undefined> {
      if (url.startsWith("http://hl7.org/fhir/ValueSet/ucum-vitals-common")) return system === "http://unitsofmeasure.org" && code === "kg";
      return super.valueSetContains(url, system, code);
    }
  }
  const obs = {
    resourceType: "Observation",
    meta: { profile: [CORE + "vitalsigns"] },
    status: "final",
    code: { text: "x" },
    component: [{ code: { text: "c" }, valueString: "abc" }],
  };
  const bindingErrors = (issues: Issue[]): Issue[] => errors(issues).filter((i) => /value provided|not found in the value set|None of the codings/.test(i.message));
  const before = await new InstanceValidator(new R(JSON.parse(JSON.stringify(prof)))).validate(obs);
  assert.ok(bindingErrors(before).length > 0, "required binding reported before the fix");
  const after = await new InstanceValidator(new R(fixPackageResource(JSON.parse(JSON.stringify(prof)), "hl7.fhir.r4.core"))).validate(obs);
  assert.deepEqual(bindingErrors(after), []);
});

test("G33 PHR:47-89,147-169: versioned THO urls, nullFlavor binding, extensions.r4 types, confidenceInterval sub-extension urls", () => {
  const cs = fixPackageResource({ resourceType: "CodeSystem", url: "http://terminology.hl7.org/CodeSystem/v2-0391|2.6", version: "x" }, "hl7.fhir.r4.core");
  assert.deepEqual([cs.url, cs.version], ["http://terminology.hl7.org/CodeSystem/v2-0391-2.6", "2.6"]);
  assert.equal(fixPackageResource({ resourceType: "ValueSet", url: "http://hl7.org/fhir/ValueSet/languages", experimental: true }, "x").experimental, false);

  const nf = fixPackageResource(
    { resourceType: "StructureDefinition", url: CORE + "iso21090-nullFlavor", version: "4.0.1", snapshot: { element: [{ path: "Extension.value[x]", binding: { valueSet: "http://terminology.hl7.org/ValueSet/v3-NullFlavor|4.0.1" } }] } },
    "hl7.fhir.r4.core",
  );
  assert.equal(nf.snapshot.element[0].binding.valueSet, "http://terminology.hl7.org/ValueSet/v3-NullFlavor");

  const ext = (): Json => ({
    resourceType: "StructureDefinition",
    url: CORE + "some-ext",
    snapshot: { element: [{ path: "Extension.value[x]", type: [{ code: "integer64" }, { code: "string" }, { code: "CodeableReference" }] }, { path: "Extension.extension.value[x]", type: [{ code: "RatioRange" }] }] },
  });
  const fixed = fixPackageResource(ext(), "hl7.fhir.uv.extensions.r4");
  assert.deepEqual(fixed.snapshot.element[0].type, [{ code: "string" }]);
  assert.equal(fixed.snapshot.element[1].type, undefined, "an emptied type list is no type");
  assert.equal(fixPackageResource(ext(), "hl7.fhir.uv.extensions").snapshot.element[0].type.length, 3, "only the .r4 package is fixed");

  const ci = fixPackageResource(
    {
      resourceType: "StructureDefinition",
      url: CORE + "quantity-confidenceInterval",
      differential: { element: [{ id: "Extension.extension:confidence", path: "Extension.extension" }, { id: "Extension.extension:interval", path: "Extension.extension" }, { id: "Extension.extension:interval.url", path: "Extension.extension.url", fixedUri: "interval" }] },
      snapshot: { element: [{ id: "Extension.extension:confidence.url", path: "Extension.extension.url" }] },
    },
    "hl7.fhir.uv.extensions.r4",
  );
  assert.deepEqual(ci.differential.element.map((e: Json) => e.id), ["Extension.extension:confidence", "Extension.extension:confidence.url", "Extension.extension:interval", "Extension.extension:interval.url"]);
  assert.equal(ci.differential.element[1].fixedUri, "confidence");
  assert.equal(ci.snapshot.element[0].fixedUri, "confidence");
});

// ------------------------------------------------------------------------------------------- G12 snapshot failure

const C = CORE;
function mini(type: string, kind: string, elements: Json[], extra: Json = {}): Json {
  return { resourceType: "StructureDefinition", url: C + type, name: type, type, kind, abstract: false, derivation: "specialization", baseDefinition: C + "Element", snapshot: { element: elements }, ...extra };
}
function e(id: string, min: number, max: string, type?: string[] | null, extra: Json = {}): Json {
  const x: Json = { id, path: id, min, max, base: { path: id, min, max } };
  if (type) x.type = type.map((code) => ({ code }));
  return { ...x, ...extra };
}
const MINI: Json[] = [
  mini("Element", "complex-type", [e("Element", 0, "*")], { abstract: true, baseDefinition: undefined }),
  mini("Resource", "resource", [e("Resource", 0, "*")], { abstract: true, baseDefinition: undefined }),
  mini("DomainResource", "resource", [e("DomainResource", 0, "*")], { abstract: true, baseDefinition: C + "Resource" }),
  ...["string", "date", "boolean"].map((t) => mini(t, "primitive-type", [e(t, 0, "*")])),
  mini("Reference", "complex-type", [e("Reference", 0, "*"), e("Reference.reference", 0, "1", ["string"])]),
  mini("Patient", "resource", [e("Patient", 0, "*"), e("Patient.birthDate", 0, "1", ["date"]), e("Patient.link", 0, "*", null), e("Patient.link.other", 1, "1", null, { type: [{ code: "Reference", targetProfile: [C + "Patient", C + "RelatedPerson"] }] })], { baseDefinition: C + "DomainResource" }),
  mini("Bundle", "resource", [e("Bundle", 0, "*"), e("Bundle.entry", 0, "*", null), e("Bundle.entry.resource", 0, "1", ["Resource"])], { baseDefinition: C + "Resource" }),
];
const fetchMini = (extra: Json[] = []) => (u: string): Json | null => [...MINI, ...extra].find((s) => s.url === u.split("|")[0]) ?? null;
function profile(url: string, type: string, diff: Json[], extra: Json = {}): Json {
  return { resourceType: "StructureDefinition", url, name: "P", type, kind: "resource", derivation: "constraint", baseDefinition: C + type, differential: { element: diff }, ...extra };
}

test("G12 PU:3473-3526: a derived type that is not one of the base types throws (no snapshot)", () => {
  const bad = profile("http://ex.org/p-badtype", "Patient", [{ id: "Patient", path: "Patient" }, { id: "Patient.birthDate", path: "Patient.birthDate", type: [{ code: "string" }] }]);
  const g = new SnapshotGenerator({ fetch: fetchMini() });
  assert.equal(g.ensure(bad), null);
  assert.ok(g.messages.some((m) => m.level === "error" && /invalid constrained type string from date/.test(m.message)), JSON.stringify(g.messages));
});

test("G12 checkTypeDerivation: abstract base types and conforming target profiles still generate", () => {
  const myPat = profile("http://ex.org/my-patient", "Patient", [{ id: "Patient", path: "Patient" }]);
  const ok1 = profile("http://ex.org/p-target", "Patient", [{ id: "Patient", path: "Patient" }, { id: "Patient.link.other", path: "Patient.link.other", type: [{ code: "Reference", targetProfile: ["http://ex.org/my-patient"] }] }]);
  const g = new SnapshotGenerator({ fetch: fetchMini([myPat]) });
  assert.ok(g.ensure(ok1), JSON.stringify(g.messages));
  const ok2 = profile("http://ex.org/b", "Bundle", [{ id: "Bundle", path: "Bundle" }, { id: "Bundle.entry.resource", path: "Bundle.entry.resource", type: [{ code: "Patient" }] }]);
  const g2 = new SnapshotGenerator({ fetch: fetchMini() });
  assert.ok(g2.ensure(ok2), JSON.stringify(g2.messages));
  // CoreVersionPinner: a pinned base target (Patient|4.0.1) accepts a profile whose base is the unversioned Patient
  const pinned = profile("http://ex.org/p-pinned", "Patient", [{ id: "Patient", path: "Patient" }, { id: "Patient.link.other", path: "Patient.link.other", type: [{ code: "Reference", targetProfile: ["http://ex.org/my-patient"] }] }]);
  const pinnedBase = JSON.parse(JSON.stringify(MINI.find((s) => s.type === "Patient")));
  pinnedBase.snapshot.element[3].type[0].targetProfile = [C + "Patient|4.0.1"];
  const g4 = new SnapshotGenerator({ fetch: (u) => (u.split("|")[0] === C + "Patient" ? pinnedBase : fetchMini([myPat])(u)) });
  assert.ok(g4.ensure(pinned), JSON.stringify(g4.messages));
  // a target profile that does not derive from a base target: an error message, and the type throws (ok stays false)
  const bad = profile("http://ex.org/p-badtarget", "Patient", [{ id: "Patient", path: "Patient" }, { id: "Patient.link.other", path: "Patient.link.other", type: [{ code: "Reference", targetProfile: [C + "Bundle"] }] }]);
  const g3 = new SnapshotGenerator({ fetch: fetchMini() });
  assert.equal(g3.ensure(bad), null);
  assert.ok(g3.messages.some((m) => /not a valid constraint on the base/.test(m.message)));
});

test("G12 IV:7164 + CTU:265: a profile without a (generatable) snapshot is an error and the run is incomplete", async () => {
  const P = "http://ex.org/StructureDefinition/no-snap";
  class R extends FakeResolver {
    async fetchStructureDefinition(url: string): Promise<Json | null> {
      if (url.split("|")[0] === P) return { resourceType: "StructureDefinition", url: P, version: "1.0", type: "Patient", derivation: "constraint", baseDefinition: "http://ex.org/missing", differential: { element: [{ path: "Patient" }] } };
      return super.fetchStructureDefinition(url);
    }
  }
  const issues = await new InstanceValidator(new R()).validate({ resourceType: "Patient", meta: { profile: [P] } });
  const err = errors(issues).find((i) => /has no snapshot/.test(i.message));
  assert.ok(err, JSON.stringify(issues));
  assert.equal(err!.message, `StructureDefinition ${P}|1.0 has no snapshot - validation is against the snapshot, so it must be provided`);
  const c = completenessOf(issues);
  assert.equal(c.checked_fully, false);
  assert.deepEqual(c.profiles_unchecked, [P]);
  // an unknown profile stays the Validation_VAL_Profile_Unknown warning
  const unk = await new InstanceValidator(new R()).validate({ resourceType: "Patient", meta: { profile: ["http://ex.org/none"] } });
  assert.deepEqual(errors(unk), []);
});

// ------------------------------------------------------------------------------------------- G31 slice without slicer

test("G31 PU:1100-1103 + IV:8642-8673 / 8370: slices without a slicer are still evaluated", async () => {
  const P = "http://ex.org/StructureDefinition/sliceless";
  const base = SDS[CORE + "Patient"].snapshot.element as Json[];
  const prof = sd(P, "Patient", "resource", [
    ...base.filter((x) => !String(x.path).startsWith("Patient.identifier")),
    el("Patient.identifier", 0, "*", ["Identifier"], { base: { path: "Patient.identifier", min: 0, max: "*" } }),
    el("Patient.identifier:x", 1, "1", ["Identifier"], { sliceName: "x", base: { path: "Patient.identifier", min: 0, max: "*" } }),
  ]);
  class R extends FakeResolver {
    async fetchStructureDefinition(url: string): Promise<Json | null> {
      return url.split("|")[0] === P ? prof : super.fetchStructureDefinition(url);
    }
  }
  const none = errors(await new InstanceValidator(new R()).validate({ resourceType: "Patient", meta: { profile: [P] } }));
  assert.ok(none.some((i) => i.message === `Slice 'Patient.identifier:x': a matching slice is required, but not found (from ${P}). Note that other slices are allowed in addition to this required slice`), JSON.stringify(none));
  const one = errors(await new InstanceValidator(new R()).validate({ resourceType: "Patient", meta: { profile: [P] }, identifier: [{ system: "http://ex.org", value: "1" }] }));
  assert.ok(one.some((i) => i.message === `Profile ${P}, Element matches more than one slice - , x`), JSON.stringify(one));
});

test("G31 [x]: type slices without a slicer — every item lands on the last slice (IV:8642-8673 + checkCardinalities)", async () => {
  const P = "http://ex.org/StructureDefinition/choice-sliceless";
  const base = SDS[CORE + "Observation"].snapshot.element as Json[];
  const prof = sd(P, "Observation", "resource", [
    ...base.filter((x) => !String(x.path).startsWith("Observation.value")),
    el("Observation.value[x]", 0, "1", ["Quantity", "string"]),
    el("Observation.value[x]:valueQuantity", 1, "1", ["Quantity"], { sliceName: "valueQuantity" }),
    el("Observation.value[x]:valueString", 0, "1", ["string"], { sliceName: "valueString" }),
  ]);
  class R extends FakeResolver {
    async fetchStructureDefinition(url: string): Promise<Json | null> {
      return url.split("|")[0] === P ? prof : super.fetchStructureDefinition(url);
    }
  }
  const obs = (v: Json): Json => ({ resourceType: "Observation", meta: { profile: [P] }, status: "final", code: { text: "x" }, ...v });
  const q = errors(await new InstanceValidator(new R()).validate(obs({ valueQuantity: { value: 1 } })));
  assert.ok(q.some((i) => i.message === `The Profile '${P}' definition allows for the type string but found type Quantity`), JSON.stringify(q));
  assert.ok(q.some((i) => /Slice 'Observation.value\[x\]:valueQuantity': a matching slice is required/.test(i.message)), JSON.stringify(q));
  const str = errors(await new InstanceValidator(new R()).validate(obs({ valueString: "a" })));
  assert.ok(!str.some((i) => /allows for the type/.test(i.message)), JSON.stringify(str));
  assert.ok(str.some((i) => /valueQuantity': a matching slice is required/.test(i.message)), JSON.stringify(str));
});

// ------------------------------------------------------------------------------------------- G32 logical model on Base

test("G32 CTU:268-270 + PU:5025: a differential-only logical model on Base gets a snapshot", async () => {
  const lm = {
    resourceType: "StructureDefinition",
    url: "http://ex.org/StructureDefinition/LM",
    name: "LM",
    type: "http://ex.org/StructureDefinition/LM",
    kind: "logical",
    abstract: false,
    derivation: "specialization",
    baseDefinition: C + "Base",
    differential: { element: [{ id: "LM", path: "LM" }, { id: "LM.a", path: "LM.a", min: 0, max: "1", type: [{ code: "string" }] }] },
  };
  assert.equal(makeBaseDefinition("4.0.1").snapshot.element[0].path, "Base");
  const out = await generateSnapshotAsync(lm, async (u) => fetchMini()(u));
  assert.ok(out, "snapshot generated");
  assert.deepEqual(out!.snapshot.element.map((x: Json) => x.path), ["LM", "LM.a"]);
});

// ------------------------------------------------------------------------------------------- G8 / G9 UCUM

test("G8 UCUM grammar = ucum-java (review G8 table, validator_cli 7.0.1 + tx.fhir.org)", () => {
  const table: Array<[string, "valid" | "invalid"]> = [
    // official invalid, ucum-lhc valid: non-metric unit with a prefix (ExpressionParser.parseSymbol)
    ["k[in_i]", "invalid"],
    ["k[lb_av]", "invalid"],
    // official invalid, ucum-lhc "error" (was passed): Lexer errors
    ["{", "invalid"],
    ["}", "invalid"],
    ["()", "invalid"],
    ["m{中}", "invalid"],
    // official valid, ucum-lhc invalid: implicit multiplication by an annotation, empty term after '/', spaces in
    // an annotation, a bare prefix (tx.fhir.org)
    ["M", "valid"],
    ["m{a}{b}", "valid"],
    ["{a}{b}", "valid"],
    ["m//s", "valid"],
    ["{a b}", "valid"],
    // the same on both sides
    ["mg", "valid"],
    ["mg/dL", "valid"],
    ["kg/m2", "valid"],
    ["10*3/uL", "valid"],
    ["mL/min/{1.73_m2}", "valid"],
    ["ug/(kg.h)", "valid"],
    ["%", "valid"],
    ["[pH]", "valid"],
    ["cm[H2O]", "valid"],
    ["/min", "valid"],
    ["{beats}/min", "valid"],
    ["Cel", "valid"],
    ["m-1", "valid"],
    ["ka", "invalid"],
    ["a b", "invalid"],
    ["mg dL", "invalid"],
    ["", "invalid"],
    ["xyz", "invalid"],
    ["m[", "invalid"],
    ["]", "invalid"],
    ["+", "invalid"],
  ];
  for (const [code, want] of table) assert.equal(checkUcumCode(code), want, JSON.stringify(code));
});

test("G9 UCUM Coding display: the code or its formal structure", () => {
  assert.deepEqual(ucumDisplays("mg"), ["mg", "(milligram)"]);
  assert.deepEqual(ucumDisplays("kg/m2"), ["kg/m2", "(kilogram) / (meter ^ 2)"]);
  for (const ok of ["mg", "MG", "(milligram)", "milligram"]) assert.equal(ucumDisplayIssue("mg", ok), null, ok);
  assert.equal(ucumDisplayIssue("mg", "totally wrong"), "Wrong Display Name 'totally wrong' for http://unitsofmeasure.org#mg. Valid display is one of 2 choices: 'mg', '(milligram)'");
  // compound / annotated / bracketed units: FormalStructureComposer (ucum-java 1.0.10) — annotations compose to the
  // factor 1, a bracketed sub-term is written without brackets, an empty term after '/' leaves a doubled space
  assert.deepEqual(ucumDisplays("{a}/d"), ["{a}/d", "1 / (day)"]);
  assert.deepEqual(ucumDisplays("ug/(kg.h)"), ["ug/(kg.h)", "(microgram) / (kilogram) * (hour)"]);
  assert.deepEqual(ucumDisplays("m{a}{b}"), ["m{a}{b}", "(meter) * 1 * 1"]);
  assert.deepEqual(ucumDisplays("10*3/uL"), ["10*3/uL", "(the number ten for arbitrary powers ^ 3) / (microliter)"]);
  assert.equal(ucumDisplays("M"), null, "bare prefix (tx.fhir.org quirk): no formal structure, display not judged");
  assert.equal(ucumDisplayIssue("{a}/d", "1 / (day)"), null);
  assert.match(ucumDisplayIssue("{a}/d", "per day")!, /Valid display is one of 2 choices: '\{a\}\/d', '1 \/ \(day\)'/);
  assert.equal(ucumDisplayIssue("mg/dL", "(milligram) / (deciliter)"), null);
  assert.ok(ucumDisplayIssue("mg/dL", "milligram per deciliter"));
});

test("UCUM lexer = ucum-java 1.0.10 Lexer: '.' only inside brackets, finished() = index == length", () => {
  assert.equal(checkUcumCode("[ft_i].[lbf_av]"), "valid");
  assert.equal(checkUcumCode("m)"), "valid", "Lexer.finished() is true once the trailing ')' is read (ucum-java quirk)");
  assert.equal(checkUcumCode("(m"), "invalid");
  assert.equal(checkUcumCode("m."), "invalid");
  assert.equal(checkUcumCode("m2.s-1"), "valid");
  assert.equal(checkUcumCode("10*99999999999"), "invalid", "Integer.parseInt overflow");
  assert.equal(checkUcumCode("{\u0001}"), "invalid", "annotation characters must be printable ASCII");
});

test("G9 end to end: Coding display is checked, Quantity.unit is not", async () => {
  const v = new InstanceValidator(new FakeResolver());
  const obs = (extra: Json): Json => ({ resourceType: "Observation", status: "final", code: { coding: [{ system: "http://unitsofmeasure.org", code: "mg", display: "totally wrong" }] }, ...extra });
  const issues = errors(await v.validate(obs({ valueQuantity: { value: 1, unit: "also wrong", system: "http://unitsofmeasure.org", code: "mg" } })));
  const disp = issues.filter((i) => /Wrong Display Name/.test(i.message));
  assert.equal(disp.length, 1, JSON.stringify(issues));
  assert.equal(disp[0].path, "Observation.code.coding[0].display");
});

// ------------------------------------------------------------------------------------------- reference target match

test("checkReference target match = validateResource (IV:5376-5385, start IV:6872-7010): the target's own meta.profile errors count", async () => {
  const LOOSE = "http://ex.org/StructureDefinition/patient-loose";
  const OBS_P = "http://ex.org/StructureDefinition/obs-ref";
  const loose = { ...SDS[CORE + "Patient"], url: LOOSE, derivation: "constraint" };
  const obsBase = SDS[CORE + "Observation"].snapshot.element as Json[];
  const obsP = sd(OBS_P, "Observation", "resource", [
    ...obsBase.filter((x) => x.path !== "Observation.subject"),
    el("Observation.subject", 0, "1", [], { type: [{ code: "Reference", targetProfile: [LOOSE, CORE + "Group"] }] }),
  ]);
  class R extends FakeResolver {
    async fetchStructureDefinition(url: string): Promise<Json | null> {
      const u = url.split("|")[0];
      return u === LOOSE ? loose : u === OBS_P ? obsP : super.fetchStructureDefinition(url);
    }
  }
  const bundle = (patMeta: Json): Json => ({
    resourceType: "Bundle",
    type: "collection",
    entry: [
      { fullUrl: "http://ex.org/fhir/Observation/o1", resource: { resourceType: "Observation", id: "o1", meta: { profile: [OBS_P] }, status: "final", code: { text: "x" }, subject: { reference: "Patient/p1" } } },
      { fullUrl: "http://ex.org/fhir/Patient/p1", resource: { resourceType: "Patient", id: "p1", ...patMeta } },
    ],
  });
  const msg = `Unable to find a profile match for Patient/p1 among choices: ${LOOSE}, ${CORE}Group`;
  // no own profile: the loose profile matches
  const ok = errors(await new InstanceValidator(new R()).validate(bundle({})));
  assert.ok(!ok.some((i) => /Unable to find a profile match/.test(i.message)), JSON.stringify(ok));
  // the declared PAT_PROFILE requires an identifier: its error fails the match; the choices are every target profile, sorted
  const bad = errors(await new InstanceValidator(new R()).validate(bundle({ meta: { profile: ["http://example.tw/fhir/StructureDefinition/pat"] } })));
  assert.ok(bad.some((i) => i.message === msg && i.path === "Bundle.entry[0].resource.subject"), JSON.stringify(bad));
});

test("NotSlice details: each failed conformsTo() adds 'Details for <parent> matching against profile <url|ver>' (IV:6518-6527)", async () => {
  const B = "http://example.tw/fhir/StructureDefinition/bundle";
  const P = "http://example.tw/fhir/StructureDefinition/pat";
  const b = { resourceType: "Bundle", meta: { profile: [B] }, type: "collection", entry: [{ fullUrl: "http://ex.org/fhir/Patient/p1", resource: { resourceType: "Patient", id: "p1" } }] };
  const issues = errors(await new InstanceValidator(new FakeResolver()).validate(b));
  const ns = issues.find((i) => /does not match any known slice/.test(i.message));
  assert.ok(ns, JSON.stringify(issues));
  assert.match(ns!.message, new RegExp(`Bundle\\.entry\\[0\\]: Does not match slice 'patient' \\(discriminator: resource\\.conformsTo\\('${P.replace(/[.]/g, "\\.")}'\\)\\), Bundle\\.entry\\[0\\]: Details for Bundle matching against profile ${P.replace(/[.]/g, "\\.")}$`));
});
