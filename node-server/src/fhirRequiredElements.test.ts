/**
 * Unit tests for fhirRequiredElements (fhir_get_profile_required_elements).
 *
 * T5 parity: the 24 TW Core fixtures in mcp_proposal/fixtures/required_elements
 * (input = live `fhir_get_profile_elements(view=elements)` response, expected =
 * Python reference output). Compared on the (id, required_by first token,
 * grounding_class) multiset, exactly like reference/run_tests.py::t5.
 *
 * Documented deviations (KNOWN_DEVIATIONS below) are asserted explicitly so a
 * silent change in either direction fails the suite.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyElement,
  compactView,
  nodesAt,
  sliceMatches,
  effectiveRequiredPaths,
  parseOneOfInvariant,
  populatedIn,
  profileFixesCode,
  requiredElements,
  type ProjectedElement,
} from "./fhirRequiredElements.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FX = join(HERE, "../../mcp_proposal/fixtures/required_elements");

type Triple = [string, string, string];

/**
 * Rows the reference emits that this implementation intentionally drops.
 * Observation-bloodPressure-twcore: vs-2 is guarded by
 * `(component.empty() and hasMember.empty())`, and the profile makes
 * `component` 1..*, so the guard can never hold — value[x] is never required
 * (the systolic/diastolic component values are, via vs-3). Listing it would
 * steer an LLM into inventing a top-level value for a BP panel.
 */
const KNOWN_DEVIATIONS: Record<string, { missing: Triple[]; extra: Triple[] }> = {
  "Observation-bloodPressure-twcore": {
    missing: [["Observation.value[x]", "invariant:vs-2", "source_fact"]],
    extra: [],
  },
};

function triples(rows: Array<{ id: string; required_by: string; grounding_class: string }>): Triple[] {
  return rows
    .map((r) => [r.id, r.required_by.split(" ")[0], r.grounding_class] as Triple)
    .sort((a, b) => (a.join("\u0000") < b.join("\u0000") ? -1 : a.join("\u0000") > b.join("\u0000") ? 1 : 0));
}

function diff(a: Triple[], b: Triple[]): Triple[] {
  const rest = [...b.map((t) => t.join("\u0000"))];
  const out: Triple[] = [];
  for (const t of a) {
    const i = rest.indexOf(t.join("\u0000"));
    if (i >= 0) rest.splice(i, 1);
    else out.push(t);
  }
  return out;
}

const fixtureFiles = existsSync(FX) ? readdirSync(FX).filter((f) => f.endsWith(".expected.json")).sort() : [];

test("T5 fixtures are present (24 TW Core profiles)", { skip: fixtureFiles.length === 0 && "mcp_proposal fixtures not available" }, () => {
  assert.equal(fixtureFiles.length, 24);
});

for (const f of fixtureFiles) {
  const name = f.replace(".expected.json", "");
  test(`T5 parity: ${name}`, () => {
    const exp = JSON.parse(readFileSync(join(FX, f), "utf8"));
    const ev = JSON.parse(readFileSync(join(FX, `${name}.elements.json`), "utf8"));
    const out = requiredElements(ev.profile, ev.elements as ProjectedElement[]);
    const got = triples(out.elements);
    const want = (exp.assert as Triple[]).map((t) => [...t] as Triple);
    const dev = KNOWN_DEVIATIONS[name] || { missing: [], extra: [] };
    assert.deepEqual(diff(want, got), dev.missing, `${name}: reference rows missing from output`);
    assert.deepEqual(diff(got, want), dev.extra, `${name}: rows not in reference`);
    assert.equal(out.count, out.elements.length);
    const sum = Object.values(out.summary).reduce((a, b) => a + b, 0);
    assert.equal(sum, out.count);
  });
}

function loadElements(name: string): ProjectedElement[] {
  return JSON.parse(readFileSync(join(FX, `${name}.elements.json`), "utf8")).elements;
}

test("Patient: optional telecom does not make telecom.system required", { skip: fixtureFiles.length === 0 }, () => {
  const out = requiredElements("Patient-twcore", loadElements("Patient-twcore"));
  const ids = out.elements.map((e) => e.id);
  assert.ok(!ids.some((i) => i.startsWith("Patient.telecom")));
  assert.ok(ids.includes("Patient.identifier.system"));
});

test("instance: populated optional parent pulls in its min>=1 children", { skip: fixtureFiles.length === 0 }, () => {
  const els = loadElements("Patient-twcore");
  const base = requiredElements("Patient-twcore", els);
  const withTel = requiredElements("Patient-twcore", els, { instance: { resourceType: "Patient", telecom: [{ value: "02-1234" }] } });
  const added = withTel.elements.filter((e) => !base.elements.some((b) => b.id === e.id));
  const telecomRequired = els.filter((e) => e.id.startsWith("Patient.telecom.") && !e.id.slice(16).includes(".") && (e.min ?? 0) >= 1);
  assert.equal(added.length, telecomRequired.length);
  for (const a of added) assert.match(a.required_by, /^profile \(parent Patient\.telecom populated\)$/);
});

test("Bundle: entry.request.method is not required when entry.request is optional", { skip: fixtureFiles.length === 0 }, () => {
  const out = requiredElements("Bundle-twcore", loadElements("Bundle-twcore"));
  assert.deepEqual(out.elements.map((e) => e.id), ["Bundle.type"]);
});

test("blood pressure: component values via vs-3, no top-level value[x]", { skip: fixtureFiles.length === 0 }, () => {
  const out = requiredElements("Observation-bloodPressure-twcore", loadElements("Observation-bloodPressure-twcore"));
  const ids = out.elements.map((e) => e.id);
  assert.ok(ids.includes("Observation.component:SystolicBP.value[x]"));
  assert.ok(ids.includes("Observation.component:DiastolicBP.value[x]"));
  assert.ok(!ids.includes("Observation.value[x]"));
  const sys = out.elements.find((e) => e.id === "Observation.component:SystolicBP.value[x]")!;
  assert.ok(sys.choices && sys.choices.includes("valueQuantity"));
  assert.match(sys.hint || "", /dataAbsentReason/);
  const code = out.elements.find((e) => e.id === "Observation.code.coding:BPCode.code")!;
  assert.equal(code.fixed?.value, "85354-9");
  assert.equal(code.grounding_class, "auto");
});

test("lab result: tw-core-4 row is conditional on component/hasMember being empty", { skip: fixtureFiles.length === 0 }, () => {
  const els = loadElements("Observation-laboratoryResult-twcore");
  const out = requiredElements("Observation-laboratoryResult-twcore", els);
  const v = out.elements.find((e) => e.id === "Observation.value[x]")!;
  assert.match(v.required_by, /^invariant:tw-core-4 /);
  assert.equal(v.condition, "only while component and hasMember are empty");
  // A draft that already uses components makes the guard false.
  const withComp = requiredElements("Observation-laboratoryResult-twcore", els, {
    instance: { resourceType: "Observation", component: [{ code: { text: "x" } }] },
    includeTargetImplied: false,
  });
  assert.ok(!withComp.elements.some((e) => e.id === "Observation.value[x]"));
});

test("include_target_implied=false drops target-implied rows", { skip: fixtureFiles.length === 0 }, () => {
  const out = requiredElements("Condition-twcore", loadElements("Condition-twcore"), { includeTargetImplied: false });
  assert.ok(!out.elements.some((e) => e.required_by.startsWith("target-implied")));
});

test("include_mustsupport=true adds mustSupport-only rows", { skip: fixtureFiles.length === 0 }, () => {
  const out = requiredElements("Patient-twcore", loadElements("Patient-twcore"), { includeMustSupport: true });
  const ms = out.elements.filter((e) => e.required_by === "mustSupport-only");
  assert.ok(ms.length > 0);
  assert.ok(ms.every((e) => e.mustSupport));
});

test("parseOneOfInvariant recognises guarded and plain value-or-DAR invariants", () => {
  assert.deepEqual(parseOneOfInvariant("(component.empty() and hasMember.empty()) implies (dataAbsentReason.exists() or value.exists())"), {
    terms: ["dataAbsentReason", "value"],
    guardEmpty: ["component", "hasMember"],
    guardOpaque: false,
  });
  assert.deepEqual(parseOneOfInvariant("value.exists() or dataAbsentReason.exists()"), {
    terms: ["value", "dataAbsentReason"],
    guardEmpty: null,
    guardOpaque: false,
  });
  assert.equal(parseOneOfInvariant("dataAbsentReason.empty() or value.empty()"), null);
  assert.equal(parseOneOfInvariant("contained.contained.empty()"), null);
});

test("generic IG: synthetic profile with a DAR invariant under a required backbone", () => {
  const els: ProjectedElement[] = [
    { id: "Claim", path: "Claim", min: 0, max: "*", types: [] },
    { id: "Claim.status", path: "Claim.status", min: 1, max: "1", types: [{ code: "code" }], binding: { strength: "required", valueSet: "http://hl7.org/fhir/ValueSet/fm-status|4.0.1" } },
    { id: "Claim.patient", path: "Claim.patient", min: 1, max: "1", types: [{ code: "Reference", targetProfile: ["http://x/StructureDefinition/pas-beneficiary"] }] },
    {
      id: "Claim.item",
      path: "Claim.item",
      min: 1,
      max: "*",
      types: [{ code: "BackboneElement" }],
      constraints: [{ key: "x-1", severity: "error", expression: "quantity.exists() or dataAbsentReason.exists()" }],
    },
    { id: "Claim.item.sequence", path: "Claim.item.sequence", min: 1, max: "1", types: [{ code: "positiveInt" }] },
    { id: "Claim.item.quantity", path: "Claim.item.quantity", min: 0, max: "1", types: [{ code: "Quantity" }] },
    { id: "Claim.insurance", path: "Claim.insurance", min: 0, max: "*", types: [{ code: "BackboneElement" }] },
    { id: "Claim.insurance.focal", path: "Claim.insurance.focal", min: 1, max: "1", types: [{ code: "boolean" }] },
  ];
  const out = requiredElements("pas-claim", els, { includeTargetImplied: true });
  const byId = Object.fromEntries(out.elements.map((e) => [e.id, e]));
  assert.equal(byId["Claim.status"].grounding_class, "coding");
  assert.equal(byId["Claim.patient"].grounding_class, "structural");
  assert.match(byId["Claim.patient"].hint || "", /pas-beneficiary/);
  assert.equal(byId["Claim.item"].grounding_class, "container");
  assert.ok(byId["Claim.item.sequence"]);
  assert.match(byId["Claim.item.quantity"].required_by, /^invariant:x-1 /);
  assert.ok(!byId["Claim.insurance.focal"], "child of optional backbone must not be required");
});

test("profileFixesCode + classifyElement: lab profile code is not pinned", { skip: fixtureFiles.length === 0 }, () => {
  const lab = loadElements("Observation-laboratoryResult-twcore");
  assert.equal(profileFixesCode("Observation", lab), false);
  const hr = loadElements("Observation-heart-rate-twcore");
  assert.equal(profileFixesCode("Observation", hr), true);
  const code = hr.find((e) => e.id === "Observation.code")!;
  assert.equal(classifyElement("Observation", code, true), "auto");
});

test("populatedIn handles choice types and arrays", () => {
  const inst = { resourceType: "Observation", valueQuantity: { value: 1 }, component: [{ code: {} }, {}] };
  assert.equal(populatedIn(inst, "Observation.value[x]"), true);
  assert.equal(populatedIn(inst, "Observation.component:SBP.code"), true);
  assert.equal(populatedIn(inst, "Observation.effective[x]"), false);
  assert.equal(populatedIn(null, "Observation.value[x]"), false);
});

test("effectiveRequiredPaths ignores children of optional parents", () => {
  const set = effectiveRequiredPaths([
    { id: "Patient", path: "Patient", min: 0 },
    { id: "Patient.telecom", path: "Patient.telecom", min: 0 },
    { id: "Patient.telecom.system", path: "Patient.telecom.system", min: 1 },
    { id: "Patient.identifier", path: "Patient.identifier", min: 1 },
    { id: "Patient.identifier.value", path: "Patient.identifier.value", min: 1 },
    { id: "Patient.identifier:nid", path: "Patient.identifier", min: 0 },
  ]);
  assert.deepEqual([...set].sort(), ["Patient.identifier", "Patient.identifier.value"]);
});

// --------------------------------------------------------------------------- //
// PAS 1.2.7 (tw.gov.mohw.nhi.pas) — fixtures projected with projectForRequired //
// (slicing / baseMax / constraint source), instances are the IG's own examples. //
// --------------------------------------------------------------------------- //

const PAS = join(HERE, "../../mcp_proposal/fixtures/required_elements_pas");
const hasPas = existsSync(join(PAS, "Claim-twpas.elements.json"));
function pasEls(name: string): ProjectedElement[] {
  return JSON.parse(readFileSync(join(PAS, `${name}.elements.json`), "utf8")).elements;
}
function pasInst(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(PAS, `${name}.instance.json`), "utf8"));
}

test("PAS Claim: absent supportingInfo / coding slices do not pull in their children (slice-aware instance)", { skip: !hasPas }, () => {
  const out = requiredElements("Claim-twpas", pasEls("Claim-twpas"), { instance: pasInst("Claim-cla-1") });
  const ids = out.elements.map((e) => e.id);
  // cla-1 has no blood-group / opd / allergy supportingInfo and no ICD-10-CM 2014 / PCS 2014 codings
  for (const bad of [
    "Claim.supportingInfo:bloodgroup.value[x]",
    "Claim.supportingInfo:opd.category",
    "Claim.diagnosis.diagnosis[x].coding:icd10-cm-2014.code",
    "Claim.procedure.procedure[x].coding:icd10-pcs-2014.system",
  ]) {
    assert.ok(!ids.includes(bad), `${bad} must not be required`);
  }
  // ... while slices it does contain are still expanded
  assert.ok(ids.includes("Claim.supportingInfo:weight.value[x]"));
  assert.ok(ids.some((i) => i.startsWith("Claim.diagnosis.diagnosis[x].coding:icd10-cm-2023")));
});

test("sliceMatches: value discriminator on category, url on extensions, unknown -> true", { skip: !hasPas }, () => {
  const E = new Map(pasEls("Claim-twpas").map((e) => [e.id, e]));
  const weight = { sequence: 1, category: { coding: [{ system: "https://nhicore.nhi.gov.tw/pas/CodeSystem/nhi-supporting-info-type", code: "weight" }] } };
  assert.equal(sliceMatches(weight, "supportingInfo", "Claim.supportingInfo:weight", E), true);
  assert.equal(sliceMatches(weight, "supportingInfo", "Claim.supportingInfo:height", E), false);
  assert.equal(sliceMatches({ url: "https://nhicore.nhi.gov.tw/pas/StructureDefinition/extension-claim-encounter" }, "extension", "Claim.extension:encounter", E), true);
  assert.equal(sliceMatches({ url: "http://x" }, "extension", "Claim.extension:encounter", E), false);
  assert.equal(sliceMatches({}, "x", "Claim.nope:x", null), true);
  assert.equal(nodesAt({ resourceType: "Claim", supportingInfo: [weight, { category: { coding: [{ code: "height" }] } }] }, "Claim.supportingInfo:weight", E).length, 1);
});

test("PAS Claim: profile invariants are listed, base FHIR ones are not", { skip: !hasPas }, () => {
  const out = requiredElements("Claim-twpas", pasEls("Claim-twpas"));
  const keys = out.invariants.map((i) => i.key);
  for (const k of ["sequence-1", "applType", "diagnosis", "pas-1"]) assert.ok(keys.includes(k), k);
  assert.ok(!keys.some((k) => k === "ele-1" || k === "ext-1" || /^(dom|clm)-\d+$/.test(k)));
  const htwt = out.invariants.find((i) => i.key === "HTWT")!;
  assert.deepEqual(htwt.on.sort(), ["Claim.supportingInfo:height", "Claim.supportingInfo:weight"]);
});

test("ext-1: a simple extension whose value[x] is 0..1 still needs it", () => {
  const els: ProjectedElement[] = [
    { id: "Extension", path: "Extension", min: 0, max: "*", types: [] },
    { id: "Extension.extension", path: "Extension.extension", min: 0, max: "0", types: [{ code: "Extension" }] },
    { id: "Extension.url", path: "Extension.url", min: 1, max: "1", types: [{ code: "uri" }], fixed: { field: "fixedUri", value: "http://x/ext" } },
    { id: "Extension.value[x]", path: "Extension.value[x]", min: 0, max: "1", types: [{ code: "Reference", targetProfile: ["http://x/Encounter-x"] }] },
  ];
  const out = requiredElements("ext", els);
  const v = out.elements.find((e) => e.id === "Extension.value[x]")!;
  assert.match(v.required_by, /^invariant:ext-1/);
  assert.equal(v.min, 1);
  assert.doesNotMatch(v.hint || "", /dataAbsentReason/);
  // complex extension (nested extension allowed, value[x] prohibited): no value row
  const cx = requiredElements("ext", [els[0], { ...els[1], max: "*" }, els[2], { ...els[3], max: "0" }]);
  assert.ok(!cx.elements.some((e) => e.id === "Extension.value[x]"));
});

test("PAS extension definition: claimResponse requestor value is an Identifier with pinned system", { skip: !hasPas }, () => {
  const out = requiredElements("extension-claimResponse-requestor", pasEls("extension-claimResponse-requestor"));
  const byId = Object.fromEntries(out.elements.map((e) => [e.id, e]));
  assert.equal(byId["Extension.value[x]"].required_by, "profile");
  assert.ok(byId["Extension.value[x].system"], "Identifier.system pinned by the extension");
  assert.ok(byId["Extension.value[x].value"]);
  assert.equal(byId["Extension.url"].grounding_class, "auto");
  assert.doesNotMatch(byId["Extension.value[x]"].hint || "", /dataAbsentReason/);
});

test("datatype children: populated text needs Narrative.status + div", { skip: !hasPas }, () => {
  const inst = pasInst("Claim-cla-1");
  const out = requiredElements("Claim-twpas", pasEls("Claim-twpas"), { instance: { ...inst, text: { status: "generated", div: "<div/>" } } });
  const ids = out.elements.map((e) => e.id);
  assert.ok(ids.includes("Claim.text.status") && ids.includes("Claim.text.div"));
  const without = requiredElements("Claim-twpas", pasEls("Claim-twpas"), { instance: { ...inst, text: undefined } });
  assert.ok(!without.elements.some((e) => e.id.startsWith("Claim.text.")));
});

test("PAS Bundle: entry slices are matched by meta.profile and name the entry profile", { skip: !hasPas }, () => {
  const els = pasEls("Bundle-twpas");
  const out = requiredElements("Bundle-twpas", els, { instance: pasInst("Bundle-bun-1") });
  const claim = out.elements.find((e) => e.id === "Bundle.entry:claim.resource")!;
  assert.match(claim.hint || "", /Claim-twpas/);
  const E = new Map(els.map((e) => [e.id, e]));
  const claimEntry = { resource: { resourceType: "Claim", meta: { profile: ["https://nhicore.nhi.gov.tw/pas/StructureDefinition/Claim-twpas"] } } };
  assert.equal(sliceMatches(claimEntry, "entry", "Bundle.entry:claim", E), true);
  assert.equal(sliceMatches(claimEntry, "entry", "Bundle.entry:patient", E), false);
});

test("compact view: pinned subtrees fold into one value; shapes follow base cardinality", { skip: !hasPas || fixtureFiles.length === 0 }, () => {
  const els = loadElements("Observation-bloodPressure-twcore");
  const out = requiredElements("Observation-bloodPressure-twcore", els);
  const rows = compactView(out.elements, new Map(els.map((e) => [e.id, e])));
  const code = rows.find((r) => r.id === "Observation.code")!;
  assert.deepEqual(code.value, { coding: [{ system: "http://loinc.org", code: "85354-9" }] });
  assert.ok(!rows.some((r) => r.id === "Observation.code.coding:BPCode.code"), "folded descendants are not repeated");
  const sbp = rows.find((r) => r.id === "Observation.component:SystolicBP.code")!;
  assert.deepEqual(sbp.value, { coding: [{ system: "http://loinc.org", code: "8480-6" }] });
  for (const r of rows) {
    assert.ok(!("types" in r) && !("min" in r) && !("mustSupport" in r));
  }
  // a pinned base element without any pinned leaf is not folded into an empty object
  assert.ok(!("value" in rows.find((r) => r.id === "Observation.component.code")!));
});

test("compact view: PAS Claim stays under 10k and keeps every row id that is not folded", { skip: !hasPas }, () => {
  const els = pasEls("Claim-twpas");
  const out = requiredElements("Claim-twpas", els);
  const rows = compactView(out.elements, new Map(els.map((e) => [e.id, e])));
  assert.ok(JSON.stringify(rows).length < 10000, `compact size ${JSON.stringify(rows).length}`);
  const kept = new Set(rows.map((r) => r.id));
  for (const r of out.elements) {
    if (!kept.has(r.id)) assert.ok(rows.some((k) => r.id.startsWith(`${k.id}.`) && "value" in k), `${r.id} dropped without fold`);
  }
});

test("PAS Claim: closed slicing names the allowed slices (and their code systems)", { skip: !hasPas }, () => {
  const out = requiredElements("Claim-twpas", pasEls("Claim-twpas"));
  const si = out.elements.find((e) => e.id === "Claim.supportingInfo")!;
  assert.match(si.hint || "", /closed slicing: each item must match one of .*weight/);
  const dx = out.elements.find((e) => e.id === "Claim.diagnosis.diagnosis[x]")!;
  assert.ok(dx);
});
