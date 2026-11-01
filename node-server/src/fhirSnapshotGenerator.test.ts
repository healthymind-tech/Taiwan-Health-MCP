/**
 * Snapshot generation (port of ProfileUtilities / ProfilePathProcessor) over a synthetic mini core, plus a check
 * against published TW Core snapshots when the package cache is present (FHIR_PACKAGE_CACHE, default ~/.fhir/packages;
 * skipped when absent).
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { generateSnapshotAsync, SnapshotGenerator } from "./fhirSnapshotGenerator.js";

type Json = Record<string, any>;
const C = "http://hl7.org/fhir/StructureDefinition/";

function el(id: string, min: number, max: string, type?: string[] | null, extra: Json = {}): Json {
  const e: Json = { id, path: id, min, max, base: { path: id, min, max } };
  if (type) e.type = type.map((code) => ({ code }));
  return { ...e, ...extra };
}
const ele1 = { key: "ele-1", severity: "error", human: "All FHIR elements must have a @value or children", expression: "hasValue() or (children().count() > id.count())", source: C + "Element" };

function sd(type: string, kind: string, elements: Json[], extra: Json = {}): Json {
  return { resourceType: "StructureDefinition", url: C + type, name: type, type, kind, abstract: false, derivation: "specialization", baseDefinition: C + "Element", snapshot: { element: elements }, ...extra };
}

const core: Json[] = [
  sd("Quantity", "complex-type", [el("Quantity", 0, "*", null, { constraint: [ele1] }), el("Quantity.value", 0, "1", ["decimal"]), el("Quantity.unit", 0, "1", ["string"]), el("Quantity.system", 0, "1", ["uri"]), el("Quantity.code", 0, "1", ["code"])]),
  sd("Coding", "complex-type", [el("Coding", 0, "*"), el("Coding.system", 0, "1", ["uri"]), el("Coding.code", 0, "1", ["code"]), el("Coding.display", 0, "1", ["string"])]),
  sd("CodeableConcept", "complex-type", [el("CodeableConcept", 0, "*"), el("CodeableConcept.coding", 0, "*", ["Coding"]), el("CodeableConcept.text", 0, "1", ["string"])]),
  sd("Extension", "complex-type", [
    el("Extension", 0, "*"),
    el("Extension.extension", 0, "*", ["Extension"], { slicing: { discriminator: [{ type: "value", path: "url" }], rules: "open" } }),
    el("Extension.url", 1, "1", ["uri"]),
    el("Extension.value[x]", 0, "1", ["string", "boolean", "Quantity", "CodeableConcept"]),
  ]),
  ...["decimal", "string", "uri", "code", "boolean"].map((t) => sd(t, "primitive-type", [el(t, 0, "*")])),
  sd(
    "Observation",
    "resource",
    [
      el("Observation", 0, "*", null, { constraint: [{ key: "obs-6", severity: "error", human: "x", expression: "true", source: C + "Observation" }] }),
      el("Observation.extension", 0, "*", ["Extension"]),
      el("Observation.status", 1, "1", ["code"], { binding: { strength: "required", valueSet: "http://hl7.org/fhir/ValueSet/observation-status|4.0.1" } }),
      el("Observation.code", 1, "1", ["CodeableConcept"]),
      el("Observation.value[x]", 0, "1", ["Quantity", "CodeableConcept", "string"]),
      el("Observation.component", 0, "*", ["BackboneElement"]),
      el("Observation.component.code", 1, "1", ["CodeableConcept"]),
      el("Observation.component.value[x]", 0, "1", ["Quantity", "string"]),
    ],
    { baseDefinition: C + "DomainResource" },
  ),
];
const ext = {
  resourceType: "StructureDefinition",
  url: "http://ex.org/ext",
  name: "Ext",
  type: "Extension",
  kind: "complex-type",
  derivation: "constraint",
  baseDefinition: C + "Extension",
  differential: { element: [{ id: "Extension", path: "Extension", max: "1" }, { id: "Extension.url", path: "Extension.url", fixedUri: "http://ex.org/ext" }, { id: "Extension.value[x]", path: "Extension.value[x]", type: [{ code: "boolean" }] }] },
};

function store(extra: Json[] = []): Map<string, Json> {
  const m = new Map<string, Json>();
  for (const s of [...core, ext, ...extra]) m.set(s.url, s);
  return m;
}
const gen = (m: Map<string, Json>): SnapshotGenerator => new SnapshotGenerator({ fetch: (u) => m.get(u.split("|")[0]) ?? null });
const byId = (s: Json): Map<string, Json> => new Map(s.snapshot.element.map((e: Json) => [e.id, e]));

function profile(url: string, elements: Json[], base = C + "Observation"): Json {
  return { resourceType: "StructureDefinition", url, name: url.split("/").pop(), type: "Observation", kind: "resource", derivation: "constraint", baseDefinition: base, differential: { element: elements } };
}

test("differential merge: cardinality, binding, mustSupport, constraints (cumulative, source stamped), order and base", () => {
  const p = profile("http://ex.org/P1", [
    { id: "Observation.code", path: "Observation.code", mustSupport: true, binding: { strength: "extensible", valueSet: "http://ex.org/vs" } },
    { id: "Observation.value[x]", path: "Observation.value[x]", min: 1, constraint: [{ key: "p-1", severity: "error", human: "y", expression: "true" }] },
  ]);
  const g = gen(store());
  const s = g.generate(p);
  const ids = s.snapshot.element.map((e: Json) => e.id);
  assert.deepEqual(ids, ["Observation", "Observation.extension", "Observation.status", "Observation.code", "Observation.value[x]", "Observation.component", "Observation.component.code", "Observation.component.value[x]"]);
  const m = byId(s);
  assert.equal(m.get("Observation.code").mustSupport, true);
  assert.deepEqual(m.get("Observation.code").binding, { strength: "extensible", valueSet: "http://ex.org/vs" });
  assert.equal(m.get("Observation.value[x]").min, 1);
  assert.deepEqual(m.get("Observation.value[x]").base, { path: "Observation.value[x]", min: 0, max: "1" });
  assert.deepEqual(
    m.get("Observation.value[x]").constraint.map((c: Json) => c.key),
    ["p-1"],
  );
  assert.equal(m.get("Observation").constraint[0].source, C + "Observation");
  // the base SD is not modified
  assert.equal(core.find((x) => x.type === "Observation")!.snapshot.element[4].min, 0);
});

test("choice rename: valueQuantity restricts value[x] (validator: newSlicingProcessing=false) and walks into Quantity", () => {
  const p = profile("http://ex.org/P2", [
    { id: "Observation.valueQuantity", path: "Observation.valueQuantity", min: 1 },
    { id: "Observation.valueQuantity.unit", path: "Observation.valueQuantity.unit", min: 1 },
  ]);
  const s = gen(store()).generate(p);
  const m = byId(s);
  const vx = m.get("Observation.value[x]");
  assert.deepEqual(vx.type, [{ code: "Quantity" }]);
  assert.equal(vx.slicing.rules, "closed");
  assert.equal(vx.min, 1); // the only type slice has min 1
  const slice = m.get("Observation.value[x]:valueQuantity");
  assert.equal(slice.sliceName, "valueQuantity");
  assert.equal(slice.min, 1);
  assert.equal(m.get("Observation.value[x]:valueQuantity.unit").min, 1);
  assert.equal(m.get("Observation.value[x]:valueQuantity.code").min, 0);
  // the IG publisher mode (newSlicingProcessing) keeps every type on the slicer (unless a type slice is required) and
  // adds implied type slices for the others
  const p2 = profile("http://ex.org/P2b", [{ id: "Observation.valueQuantity", path: "Observation.valueQuantity" }]);
  const s2 = new SnapshotGenerator({ fetch: (u) => store().get(u.split("|")[0]) ?? null, newSlicingProcessing: true }).generate(p2);
  const m2 = byId(s2);
  assert.equal(m2.get("Observation.value[x]").type.length, 3);
  assert.ok(m2.get("Observation.value[x]:valueString"));
});

test("extension slices: implicit url slicing, profile on the slice, cardinality from the extension definition", () => {
  const p = profile("http://ex.org/P3", [{ id: "Observation.extension:flag", path: "Observation.extension", sliceName: "flag", type: [{ code: "Extension", profile: ["http://ex.org/ext"] }] }]);
  const s = gen(store()).generate(p);
  const m = byId(s);
  assert.deepEqual(m.get("Observation.extension").slicing, { discriminator: [{ type: "value", path: "url" }], ordered: false, rules: "open" });
  const sl = m.get("Observation.extension:flag");
  assert.equal(sl.min, 0);
  assert.equal(sl.max, "1"); // the extension's root max
  assert.deepEqual(sl.type, [{ code: "Extension", profile: ["http://ex.org/ext"] }]);
});

test("new slices with children, and a derived-from-derived profile constraining an inherited slice (bases generated recursively)", () => {
  const a = profile("http://ex.org/A", [
    { id: "Observation.component", path: "Observation.component", slicing: { discriminator: [{ type: "pattern", path: "code" }], rules: "open" } },
    { id: "Observation.component:sys", path: "Observation.component", sliceName: "sys", min: 1, max: "1" },
    { id: "Observation.component:sys.code", path: "Observation.component.code", patternCodeableConcept: { coding: [{ system: "http://loinc.org", code: "8480-6" }] } },
    { id: "Observation.component:sys.value[x]", path: "Observation.component.value[x]", type: [{ code: "Quantity" }] },
  ]);
  const b = profile(
    "http://ex.org/B",
    [
      { id: "Observation.component:sys", path: "Observation.component", sliceName: "sys" },
      { id: "Observation.component:sys.value[x]", path: "Observation.component.value[x]", mustSupport: true },
      { id: "Observation.component:dia", path: "Observation.component", sliceName: "dia", max: "1" },
    ],
    "http://ex.org/A",
  );
  const s = gen(store([a, b])).ensure(b)!;
  assert.ok(s);
  const ids = s.snapshot.element.map((e: Json) => e.id);
  const i = (x: string): number => ids.indexOf(x);
  assert.ok(i("Observation.component") < i("Observation.component:sys") && i("Observation.component:sys") < i("Observation.component:sys.code") && i("Observation.component:sys.value[x]") < i("Observation.component:dia"));
  const m = byId(s);
  assert.deepEqual(m.get("Observation.component").slicing.discriminator, [{ type: "pattern", path: "code" }]);
  assert.equal(m.get("Observation.component:sys").min, 1);
  assert.deepEqual(m.get("Observation.component:sys.code").patternCodeableConcept, { coding: [{ system: "http://loinc.org", code: "8480-6" }] });
  assert.deepEqual(m.get("Observation.component:sys.value[x]").type, [{ code: "Quantity" }]);
  assert.equal(m.get("Observation.component:sys.value[x]").mustSupport, true);
  assert.equal(m.get("Observation.component:dia").min, 0);
  // a new slice on an inherited slicing gets only its root unless the differential walks into it
  // (ProfilePathProcessor.processPathWithSlicedBaseDefault)
  assert.equal(m.get("Observation.component:dia.code"), undefined);
});

test("generateSnapshotAsync loads definitions on demand", async () => {
  const m = store();
  const fetched: string[] = [];
  const p = profile("http://ex.org/P5", [{ id: "Observation.valueQuantity", path: "Observation.valueQuantity" }]);
  const s = await generateSnapshotAsync(p, async (u) => {
    fetched.push(u);
    return m.get(u.split("|")[0]) ?? null;
  });
  assert.ok(s && s.snapshot.element.length > 8);
  assert.ok(fetched.includes(C + "Observation"));
  assert.ok(fetched.includes(C + "Quantity"));
});

// --------------------------------------------------------------------------- published TW Core snapshots

const CACHE = process.env.FHIR_PACKAGE_CACHE || join(homedir(), ".fhir", "packages");
const TWCORE = join(CACHE, "tw.gov.mohw.twcore#1.0.0", "package");
const R4 = join(CACHE, "hl7.fhir.r4.core#4.0.1", "package");

test("TW Core 1.0.0: regenerated snapshots match the published ones (ids, cardinality, types, slicing)", { skip: !existsSync(TWCORE) || !existsSync(R4) }, () => {
  const m = new Map<string, Json>();
  for (const dir of [R4, TWCORE]) {
    for (const f of readdirSync(dir)) {
      if (!f.startsWith("StructureDefinition-") || !f.endsWith(".json")) continue;
      const j = JSON.parse(readFileSync(join(dir, f), "utf8"));
      if (j.url) m.set(j.url, j);
    }
  }
  const norm = (u: string): string => u.split("|")[0];
  const sig = (e: Json): string =>
    JSON.stringify([e.id, e.min, e.max, (e.type || []).map((t: Json) => [t.code, (t.profile || []).map(norm), (t.targetProfile || []).map(norm)]), e.slicing ? (e.slicing.discriminator || []).map((d: Json) => d.type + d.path) : null]);
  const names = ["Encounter-twcore", "Condition-twcore", "MedicationRequest-twcore", "Observation-laboratoryResult-twcore", "Composition-twcore", "Bundle-twcore", "Address-tw"];
  for (const n of names) {
    const pub = JSON.parse(readFileSync(join(TWCORE, `StructureDefinition-${n}.json`), "utf8"));
    const input = { ...pub };
    delete input.snapshot;
    const g = new SnapshotGenerator({ fetch: (u) => m.get(norm(u)) ?? null, newSlicingProcessing: true });
    const out = g.generate(input);
    const a = pub.snapshot.element.map(sig);
    const b = out.snapshot.element.filter((e: Json) => !(e.extension || []).some((x: Json) => x.url.endsWith("implied-type-slice"))).map(sig);
    assert.deepEqual(b, a, n);
  }
});
