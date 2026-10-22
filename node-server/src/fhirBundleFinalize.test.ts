/**
 * fhirBundleFinalize: deterministic fullUrl / reference / id normalisation (ISSUES_v9 R1).
 * Synthetic bundles only; StructureDefinitions come from the in-memory test kit.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { BUNDLE_TYPES, bundleRules, bundleSalt, entryOrderOf, finalizeBundle, losslessFinalizedBundle, suggestBundleType, uuidV5, FINALIZE_UUID_NAMESPACE, type FinalizeDeps } from "./fhirBundleFinalize.js";
import { parseLossless, stringifyLossless } from "./losslessJson.js";
import { CORE, FakeResolver, SDS, el, sd } from "./fhirTestKit.test.js";

const UUID = /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const deps: FinalizeDeps = new FakeResolver();

const DOC_PROFILE = "http://example.tw/fhir/StructureDefinition/doc-bundle";
const DOC_SD = sd(DOC_PROFILE, "Bundle", "resource", [
  el("Bundle", 0, "*"),
  el("Bundle.id", 0, "1", ["id"]),
  el("Bundle.identifier", 1, "1", ["Identifier"]),
  el("Bundle.type", 1, "1", ["code"], { patternCode: "document" }),
  el("Bundle.timestamp", 1, "1", ["instant"]),
  el("Bundle.entry", 1, "*", ["BackboneElement"]),
  el("Bundle.entry.fullUrl", 0, "1", ["uri"]),
  el("Bundle.entry.resource", 0, "1", ["Resource"]),
  el("Bundle.entry:composition", 1, "1", ["BackboneElement"]),
  el("Bundle.entry:composition.resource", 1, "1", [], { type: [{ code: "Composition", profile: [CORE + "Composition"] }] }),
]);
const docDeps: FinalizeDeps = {
  fetchStructureDefinition: async (url) => (url.split("|")[0] === DOC_PROFILE ? DOC_SD : SDS[url.split("|")[0]] ?? null),
};

function patient(id: string, extra: Record<string, unknown> = {}): Record<string, any> {
  return { resourceType: "Patient", id, gender: "male", ...extra };
}
function condition(subject: string, extra: Record<string, unknown> = {}): Record<string, any> {
  return { resourceType: "Condition", subject: { reference: subject }, code: { text: "x" }, ...extra };
}
function bundle(entries: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}): Record<string, any> {
  return { resourceType: "Bundle", type: "collection", ...extra, entry: entries };
}

const refsOf = (b: Record<string, any>): string[] => {
  const out: string[] = [];
  const walk = (x: unknown): void => {
    if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === "object") {
      for (const [k, v] of Object.entries(x as Record<string, unknown>)) {
        if (k === "reference" && typeof v === "string") out.push(v);
        else walk(v);
      }
    }
  };
  walk(b);
  return out;
};

test("uuidV5 is RFC 4122 v5 (lowercase, version / variant bits) and stable", () => {
  const a = uuidV5(FINALIZE_UUID_NAMESPACE, "x");
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(a, uuidV5(FINALIZE_UUID_NAMESPACE, "x"));
  assert.notEqual(a, uuidV5(FINALIZE_UUID_NAMESPACE, "y"));
});

test("labels become lowercase UUID v5 fullUrls and every reference form follows (urn label, Type/id, bare id, uppercase UUID)", async () => {
  const b = bundle([
    { fullUrl: "urn:uuid:patient-1", resource: patient("patient-1") },
    { fullUrl: "urn:uuid:condition-1", resource: condition("urn:uuid:patient-1") },
    { fullUrl: "urn:uuid:condition-2", resource: condition("Patient/patient-1") },
    { fullUrl: "urn:uuid:condition-3", resource: condition("patient-1") },
    { fullUrl: "urn:uuid:3F2A9C1E-7B4D-4E8A-9F1C-2D5E6A7B8C9D", resource: patient("p2") },
    { fullUrl: "urn:uuid:condition-4", resource: condition("urn:uuid:3f2a9c1e-7b4d-4e8a-9f1c-2d5e6a7b8c9d") },
  ]);
  const before = JSON.stringify(b);
  const r = await finalizeBundle(b, deps);
  assert.equal(JSON.stringify(b), before, "input not mutated");
  const fus = r.bundle.entry.map((e: any) => e.fullUrl);
  for (const fu of fus) assert.match(fu, UUID);
  assert.equal(fus[4], "urn:uuid:3f2a9c1e-7b4d-4e8a-9f1c-2d5e6a7b8c9d");
  assert.equal(r.bundle.entry[1].resource.subject.reference, fus[0]);
  assert.equal(r.bundle.entry[2].resource.subject.reference, fus[0]);
  assert.equal(r.bundle.entry[3].resource.subject.reference, fus[0]);
  assert.equal(r.bundle.entry[5].resource.subject.reference, fus[4], "already-valid reference to the lowercased entry untouched");
  assert.deepEqual(r.unresolved, []);
  const rules = r.changes.map((c) => c.rule);
  assert.equal(rules.filter((x) => x === "fullUrl-uuid").length, 6);
  assert.equal(rules.filter((x) => x === "reference-rewire").length, 3);
  assert.deepEqual(r.changes[0], { path: "Bundle.entry[0].fullUrl", from: "urn:uuid:patient-1", to: fus[0], rule: "fullUrl-uuid" });
  assert.ok(r.changes.some((c) => c.path === "Bundle.entry[2].resource.subject.reference" && c.from === "Patient/patient-1" && c.to === fus[0]));
  assert.equal(r.id_map["urn:uuid:patient-1"], fus[0]);
  // Only the allowed fields differ.
  const strip = (x: any): any => JSON.parse(JSON.stringify(x, (k, v) => (k === "fullUrl" || k === "reference" ? undefined : v)));
  assert.deepEqual(strip(r.bundle), strip(b));
});

test("deterministic and idempotent: same input → same output, a finalized bundle has no changes", async () => {
  const b = bundle([
    { fullUrl: "urn:uuid:patient-1", resource: patient("patient-1") },
    { resource: condition("patient-1") },
  ]);
  const r1 = await finalizeBundle(b, deps);
  const r2 = await finalizeBundle(JSON.parse(JSON.stringify(b)), deps);
  assert.deepEqual(r1.bundle, r2.bundle);
  assert.deepEqual(r1.changes, r2.changes);
  const r3 = await finalizeBundle(r1.bundle, deps);
  assert.deepEqual(r3.changes, []);
  assert.deepEqual(r3.bundle, r1.bundle);
  // A different bundle (one more clinical fact) gets different UUIDs: the salt covers the content.
  const b2 = bundle([
    { fullUrl: "urn:uuid:patient-1", resource: patient("patient-1", { birthDate: "1970-01-01" }) },
    { resource: condition("patient-1") },
  ]);
  const r4 = await finalizeBundle(b2, deps);
  assert.notEqual(r4.bundle.entry[0].fullUrl, r1.bundle.entry[0].fullUrl);
  assert.notEqual(bundleSalt(b), bundleSalt(b2));
  // The salt ignores the rewritable fields and the entry order.
  assert.equal(bundleSalt(b), bundleSalt(r1.bundle));
});

test("already-valid bundle is returned unchanged with changes = [] (urn:uuid, urn:oid, RESTful http + relative reference, external URL, logical reference)", async () => {
  const b = bundle([
    { fullUrl: "urn:uuid:3f2a9c1e-7b4d-4e8a-9f1c-2d5e6a7b8c9d", resource: patient("p1") },
    { fullUrl: "urn:oid:1.2.3.4", resource: condition("urn:uuid:3f2a9c1e-7b4d-4e8a-9f1c-2d5e6a7b8c9d") },
    { fullUrl: "http://srv.example/fhir/Patient/p9", resource: patient("p9") },
    { fullUrl: "http://srv.example/fhir/Condition/c9", resource: condition("Patient/p9", { id: "c9" }) },
    { fullUrl: "urn:uuid:4f2a9c1e-7b4d-4e8a-9f1c-2d5e6a7b8c9d", resource: condition("http://other.example/Patient/1") },
    { fullUrl: "urn:uuid:5f2a9c1e-7b4d-4e8a-9f1c-2d5e6a7b8c9d", resource: { resourceType: "Condition", subject: { identifier: { system: "urn:x", value: "1" } } } },
  ], { id: "bundle-1" });
  const r = await finalizeBundle(b, deps);
  assert.deepEqual(r.changes, []);
  assert.deepEqual(r.bundle, b);
  assert.deepEqual(r.unresolved, []);
});

test("missing fullUrl is minted; invalid resource.id and urn Bundle.id are repaired (last segment, else generated)", async () => {
  const b = bundle([
    { resource: patient("urn:uuid:patient-1") },
    { fullUrl: "urn:uuid:c1", resource: { ...condition("Patient/urn:uuid:patient-1"), id: "has space!" } },
  ], { id: "urn:uuid:3f2a9c1e-7b4d-4e8a-9f1c-2d5e6a7b8c9d" });
  const r = await finalizeBundle(b, deps);
  assert.equal(r.bundle.id, "3f2a9c1e-7b4d-4e8a-9f1c-2d5e6a7b8c9d");
  assert.equal(r.bundle.entry[0].resource.id, "patient-1");
  assert.match(r.bundle.entry[0].fullUrl, UUID);
  assert.equal(r.bundle.entry[1].resource.subject.reference, r.bundle.entry[0].fullUrl);
  assert.equal(r.bundle.entry[1].resource.id, r.bundle.entry[1].fullUrl.slice("urn:uuid:".length), "unusable id → the entry's UUID");
  assert.ok(r.changes.some((c) => c.rule === "resource-id" && c.path === "Bundle.id"));
  assert.ok(r.changes.some((c) => c.rule === "resource-id" && c.path === "Bundle.entry[0].resource.id" && c.to === "patient-1"));
  assert.ok(r.changes.some((c) => c.path === "Bundle.entry[0].fullUrl" && c.from === null));
  // Bundle.id with no usable segment is generated deterministically.
  const b2 = bundle([{ fullUrl: "urn:uuid:3f2a9c1e-7b4d-4e8a-9f1c-2d5e6a7b8c9d", resource: patient("p") }], { id: "###" });
  const r2 = await finalizeBundle(b2, deps);
  assert.match(r2.bundle.id, /^[0-9a-f-]{36}$/);
  assert.equal(r2.bundle.id, (await finalizeBundle(b2, deps)).bundle.id);
});

test("references are found through StructureDefinitions: extension value, nested extension, contained resource, Composition.section.entry, Provenance.target", async () => {
  const b = bundle([
    { fullUrl: "urn:uuid:patient-1", resource: patient("patient-1") },
    { fullUrl: "urn:uuid:org-1", resource: { resourceType: "Organization", id: "org-1", name: "x" } },
    {
      fullUrl: "urn:uuid:cond-1",
      resource: {
        resourceType: "Condition",
        id: "cond-1",
        subject: { reference: "urn:uuid:patient-1" },
        extension: [
          { url: "http://example.tw/ext-ref", valueReference: { reference: "Organization/org-1" } },
          { url: "http://example.tw/ext-complex", extension: [{ url: "who", valueReference: { reference: "org-1" } }] },
        ],
        contained: [{ resourceType: "Condition", id: "inner", subject: { reference: "patient-1" } }],
        // Unknown property: NOT a Reference element of Condition, left alone.
        foo: { reference: "patient-1" },
      },
    },
    {
      fullUrl: "urn:uuid:comp-1",
      resource: {
        resourceType: "Composition",
        status: "final",
        type: { text: "t" },
        date: "2024-01-01",
        title: "x",
        subject: { reference: "Patient/patient-1" },
        author: [{ reference: "org-1" }],
        section: [{ title: "s", entry: [{ reference: "cond-1" }], section: [{ entry: [{ reference: "Condition/cond-1" }] }] }],
      },
    },
    { fullUrl: "urn:uuid:prov-1", resource: { resourceType: "Provenance", recorded: "2024-01-01T00:00:00Z", target: [{ reference: "comp-1" }, { reference: "#inner" }] } },
  ]);
  const r = await finalizeBundle(b, deps);
  const fu = (i: number): string => r.bundle.entry[i].fullUrl;
  const c = r.bundle.entry[2].resource;
  assert.equal(c.extension[0].valueReference.reference, fu(1));
  assert.equal(c.extension[1].extension[0].valueReference.reference, fu(1));
  assert.equal(c.contained[0].subject.reference, fu(0));
  assert.equal(c.foo.reference, "patient-1", "property not defined by the StructureDefinition is untouched");
  const comp = r.bundle.entry[3].resource;
  assert.equal(comp.subject.reference, fu(0));
  assert.equal(comp.author[0].reference, fu(1));
  assert.equal(comp.section[0].entry[0].reference, fu(2));
  assert.equal(comp.section[0].section[0].entry[0].reference, fu(2));
  assert.deepEqual(r.bundle.entry[4].resource.target.map((t: any) => t.reference), [fu(3), "#inner"]);
  assert.deepEqual(r.unresolved, []);
  assert.ok(r.changes.some((ch) => ch.path === "Bundle.entry[2].resource.extension[1].extension[0].valueReference.reference"));
});

test("ambiguous bare ids are disambiguated by the element's target types; still-ambiguous and missing targets are reported with candidates", async () => {
  const b = bundle([
    { fullUrl: "urn:uuid:a1", resource: patient("1", { managingOrganization: { reference: "1" } }) },
    { fullUrl: "urn:uuid:a2", resource: { resourceType: "Organization", id: "1" } },
    { fullUrl: "urn:uuid:a3", resource: condition("1") }, // Condition.subject has no targetProfile in the kit → ambiguous
    { fullUrl: "urn:uuid:a4", resource: condition("Patient/nobody") },
    { fullUrl: "urn:uuid:a5", resource: condition("urn:uuid:9f2a9c1e-7b4d-4e8a-9f1c-2d5e6a7b8c9d") },
  ]);
  const r = await finalizeBundle(b, deps);
  const fu = (i: number): string => r.bundle.entry[i].fullUrl;
  assert.equal(r.bundle.entry[0].resource.managingOrganization.reference, fu(1), "Patient.managingOrganization targets Organization");
  assert.equal(r.bundle.entry[2].resource.subject.reference, "1", "ambiguous: untouched");
  assert.equal(r.unresolved.length, 3);
  const amb = r.unresolved.find((u) => u.path === "Bundle.entry[2].resource.subject.reference")!;
  assert.deepEqual(amb.candidates, [fu(0), fu(1)]);
  const missing = r.unresolved.find((u) => u.path === "Bundle.entry[3].resource.subject.reference")!;
  assert.deepEqual(missing.candidates, [fu(0)], "candidates = entries of the referenced type");
  const ext = r.unresolved.find((u) => u.path === "Bundle.entry[4].resource.subject.reference")!;
  assert.equal(ext.reference, "urn:uuid:9f2a9c1e-7b4d-4e8a-9f1c-2d5e6a7b8c9d");
  assert.equal(r.bundle.entry[4].resource.subject.reference, ext.reference, "a valid but foreign urn is never rewritten");
});

test("duplicate fullUrls (bdl-7) are reported, never merged; references to a duplicated label list both candidates", async () => {
  const dup = "urn:uuid:3f2a9c1e-7b4d-4e8a-9f1c-2d5e6a7b8c9d";
  const b = bundle([
    { fullUrl: dup, resource: patient("p1") },
    { fullUrl: dup, resource: patient("p2") },
    { fullUrl: "urn:uuid:c1", resource: condition(dup) },
    { fullUrl: "urn:uuid:enc-1", resource: { resourceType: "Organization", id: "o1" } },
    { fullUrl: "urn:uuid:enc-1", resource: { resourceType: "Organization", id: "o2" } },
    { fullUrl: "urn:uuid:c2", resource: patient("p3", { managingOrganization: { reference: "urn:uuid:enc-1" } }) },
  ]);
  const r = await finalizeBundle(b, deps);
  assert.equal(r.bundle.entry[0].fullUrl, dup);
  assert.equal(r.bundle.entry[1].fullUrl, dup);
  assert.ok(r.notes.some((n) => n.startsWith("bdl-7:") && n.includes("[0, 1]")));
  assert.equal(r.bundle.entry[2].resource.subject.reference, dup, "reference to a duplicated valid fullUrl is untouched");
  assert.ok(r.unresolved.some((u) => u.path === "Bundle.entry[2].resource.subject.reference" && /bdl-7/.test(u.reason)));
  assert.notEqual(r.bundle.entry[3].fullUrl, r.bundle.entry[4].fullUrl, "duplicated labels get their own UUIDs");
  const u = r.unresolved.find((x) => x.path === "Bundle.entry[5].resource.managingOrganization.reference")!;
  assert.deepEqual(u.candidates, [r.bundle.entry[3].fullUrl, r.bundle.entry[4].fullUrl]);
  assert.equal(r.bundle.entry[5].resource.managingOrganization.reference, "urn:uuid:enc-1");
  assert.equal(r.id_map["urn:uuid:enc-1"], undefined, "a duplicated original has no single new value");
});

test("_history references resolve and keep their version; whitespace around a reference is tolerated; contained and external references untouched", async () => {
  const b = bundle([
    { fullUrl: "urn:uuid:patient-1", resource: patient("patient-1") },
    { fullUrl: "urn:uuid:c1", resource: condition("Patient/patient-1/_history/2") },
    { fullUrl: "urn:uuid:c2", resource: condition(" urn:uuid:patient-1 ") },
    { fullUrl: "urn:uuid:c3", resource: condition("#x", { contained: [{ resourceType: "Patient", id: "x" }] }) },
    { fullUrl: "urn:uuid:c4", resource: condition("https://example.org/fhir/Patient/patient-1") },
  ]);
  const r = await finalizeBundle(b, deps);
  const p = r.bundle.entry[0].fullUrl;
  assert.equal(r.bundle.entry[1].resource.subject.reference, `${p}/_history/2`);
  assert.equal(r.bundle.entry[2].resource.subject.reference, p);
  assert.equal(r.bundle.entry[3].resource.subject.reference, "#x");
  assert.equal(r.bundle.entry[4].resource.subject.reference, "https://example.org/fhir/Patient/patient-1");
  assert.deepEqual(r.unresolved, []);
  const again = await finalizeBundle(r.bundle, deps);
  assert.deepEqual(again.changes, []);
});

test("Bundle profile: fixed Bundle.type is applied, the Composition moves first in a document, required Bundle elements are only reported", async () => {
  const comp = { resourceType: "Composition", id: "comp", status: "final", type: { text: "t" }, date: "2024-01-01", title: "x", author: [{ reference: "patient-1" }], subject: { reference: "patient-1" } };
  const b = bundle([
    { fullUrl: "urn:uuid:patient-1", resource: patient("patient-1") },
    { fullUrl: "urn:uuid:comp", resource: comp },
  ], { meta: { profile: [DOC_PROFILE] } });
  const r = await finalizeBundle(b, docDeps);
  assert.equal(r.bundle.type, "document");
  assert.equal(r.bundle.entry[0].resource.resourceType, "Composition");
  assert.equal(r.bundle.entry[1].resource.resourceType, "Patient");
  assert.equal(r.bundle.entry[0].resource.subject.reference, r.bundle.entry[1].fullUrl);
  assert.deepEqual(r.changes.filter((c) => c.rule === "bundle-type"), [{ path: "Bundle.type", from: "collection", to: "document", rule: "bundle-type" }]);
  assert.deepEqual(r.changes.filter((c) => c.rule === "document-order"), [{ path: "Bundle.entry[1]", from: "Bundle.entry[1]", to: "Bundle.entry[0]", rule: "document-order" }]);
  assert.ok(r.notes.some((n) => n.startsWith("Bundle.identifier is required by")));
  assert.ok(r.notes.some((n) => n.startsWith("Bundle.timestamp is required by")));
  assert.equal(r.bundle.identifier, undefined, "never generated");
  const again = await finalizeBundle(r.bundle, docDeps, { bundleProfile: DOC_PROFILE });
  assert.deepEqual(again.changes, []);
  // bundle_profile argument wins over meta.profile; a profile without a fixed type leaves Bundle.type alone.
  const r2 = await finalizeBundle(bundle([{ fullUrl: "urn:uuid:p", resource: patient("p") }]), docDeps, { bundleProfile: "http://example.tw/fhir/StructureDefinition/bundle" });
  assert.equal(r2.bundle.type, "collection");
});

test("without any StructureDefinition the engine falls back to property names and says so", async () => {
  const b = bundle([
    { fullUrl: "urn:uuid:patient-1", resource: patient("patient-1") },
    { fullUrl: "urn:uuid:c1", resource: { resourceType: "Unknownium", subject: { reference: "Patient/patient-1" } } },
  ]);
  const r = await finalizeBundle(b, null);
  assert.equal(r.bundle.entry[1].resource.subject.reference, r.bundle.entry[0].fullUrl);
  assert.ok(r.notes.some((n) => /located by property name/.test(n)));
  const r2 = await finalizeBundle(b, deps);
  assert.ok(r2.notes.some((n) => /No StructureDefinition available for Unknownium/.test(n)));
  assert.equal(r2.bundle.entry[1].resource.subject.reference, r2.bundle.entry[0].fullUrl);
});

test("entries without a resource and non-object entries are left alone; aliases (build_bundle keys) resolve", async () => {
  const b = bundle([
    { fullUrl: "urn:uuid:patient-1", resource: patient("x") },
    { request: { method: "DELETE", url: "Patient/9" } },
    { resource: condition("pat") },
  ]);
  const r = await finalizeBundle(b, deps, { aliases: new Map([[0, ["pat"]]]) });
  assert.equal(r.bundle.entry[1].fullUrl, undefined);
  assert.ok(r.notes.some((n) => /entry\[1\] has no resource/.test(n)));
  assert.equal(r.bundle.entry[2].resource.subject.reference, r.bundle.entry[0].fullUrl);
  assert.equal(refsOf(r.bundle).length, 1);
  await assert.rejects(finalizeBundle({ resourceType: "Patient" }, deps), TypeError);
});

test("bundleRules: core rules plus what the StructureDefinition fixes, nothing IG-specific", () => {
  const core = bundleRules(SDS[CORE + "Bundle"]);
  assert.equal(core.fixed_type, null);
  assert.match(core.fullUrl, /lowercase UUID/);
  assert.match(core.fullUrl, /required on every entry except in transaction \/ batch/);
  assert.match(core.references, /target entry's fullUrl/);
  assert.match(core.entry_order ?? "", /bdl-11/);
  assert.deepEqual(core.required_elements, []);
  const doc = bundleRules(DOC_SD);
  assert.equal(doc.fixed_type, "document");
  assert.match(doc.bundle_type, /must be 'document'/);
  assert.deepEqual(doc.required_elements, ["Bundle.identifier", "Bundle.timestamp"]);
  assert.deepEqual(doc.required_entries, [{ slice: "composition", min: 1, max: "1", profile: CORE + "Composition" }]);
  assert.ok(doc.source.includes(DOC_PROFILE));
  const none = bundleRules(null);
  assert.equal(none.fixed_type, null);
  assert.match(none.finalize, /fhir_finalize_bundle/);
});

test("a stray top-level fullUrl / resource beside entry is reported in notes and left untouched", async () => {
  const b = bundle([{ fullUrl: "urn:uuid:patient-1", resource: patient("patient-1") }]);
  b.fullUrl = "urn:uuid:4";
  b.resource = condition("patient-1");
  const r = await finalizeBundle(b, deps);
  assert.ok(r.notes.some((n) => n.includes("'fullUrl' / 'resource' at the top level") && n.includes("move it into Bundle.entry")));
  assert.equal(r.bundle.fullUrl, "urn:uuid:4");
  assert.deepEqual(r.bundle.resource, b.resource);
  assert.ok(!r.changes.some((c) => c.path === "Bundle.fullUrl"));
});

// --------------------------------------------------------------------------- //
// 1.1.0: bundle_type, document hints, lossless numbers (losslessJson.ts)
// --------------------------------------------------------------------------- //

test("determinism regression: a fixed synthetic bundle always gets the same UUIDs (pinned from 1.0.1)", async () => {
  const b = {
    resourceType: "Bundle",
    type: "collection",
    entry: [
      { fullUrl: "urn:uuid:patient-1", resource: { resourceType: "Patient", id: "patient-1", gender: "male", extension: [{ url: "http://example.tw/w", valueDecimal: 10.0 }] } },
      { resource: { resourceType: "Condition", subject: { reference: "patient-1" }, code: { text: "x" }, onsetAge: { value: 1e3, unit: "a" } } },
    ],
    id: "urn:uuid:3f2a9c1e-7b4d-4e8a-9f1c-2d5e6a7b8c9d",
  };
  for (const d of [deps, null]) {
    const r = await finalizeBundle(b, d);
    assert.equal(r.bundle.entry[0].fullUrl, "urn:uuid:01d95a68-5856-551f-bbe1-c8fea2cbaa9f");
    assert.equal(r.bundle.entry[1].fullUrl, "urn:uuid:c43c2139-9ca8-5913-8dfb-c3df3bee8b45");
    assert.equal(r.bundle.entry[1].resource.subject.reference, "urn:uuid:01d95a68-5856-551f-bbe1-c8fea2cbaa9f");
    assert.equal(r.bundle.id, "3f2a9c1e-7b4d-4e8a-9f1c-2d5e6a7b8c9d");
    // bundle_type is not part of the salt: the same UUIDs with a requested type.
    const r2 = await finalizeBundle(b, d, { bundleType: "transaction" });
    assert.equal(r2.bundle.entry[0].fullUrl, r.bundle.entry[0].fullUrl);
    assert.equal(r2.bundle.entry[1].fullUrl, r.bundle.entry[1].fullUrl);
  }
});

test("bundle_type: set deterministically as rule bundle-type (requested by caller), never over a profile-fixed type; document moves the Composition first", async () => {
  const comp = { resourceType: "Composition", id: "comp", status: "final", type: { text: "t" }, date: "2024-01-01", title: "x", author: [{ reference: "patient-1" }], subject: { reference: "patient-1" } };
  const b = bundle([
    { fullUrl: "urn:uuid:patient-1", resource: patient("patient-1") },
    { fullUrl: "urn:uuid:comp", resource: comp },
  ]);
  const r = await finalizeBundle(b, deps, { bundleType: "document" });
  assert.equal(r.bundle.type, "document");
  assert.deepEqual(r.changes.filter((c) => c.rule === "bundle-type"), [{ path: "Bundle.type", from: "collection", to: "document", rule: "bundle-type", reason: "requested by caller (bundle_type)" }]);
  assert.equal(r.bundle.entry[0].resource.resourceType, "Composition", "document → Composition first");
  assert.ok(r.changes.some((c) => c.rule === "document-order"));
  assert.equal(JSON.stringify(b.entry[0].resource.resourceType), '"Patient"', "input untouched");
  // Same type as written: no change.
  const same = await finalizeBundle(b, deps, { bundleType: "collection" });
  assert.ok(!same.changes.some((c) => c.rule === "bundle-type"));
  // Missing Bundle.type: from is null.
  const { type: _t, ...untyped } = b;
  const r3 = await finalizeBundle(untyped, deps, { bundleType: "collection" });
  assert.deepEqual(r3.changes.filter((c) => c.rule === "bundle-type"), [{ path: "Bundle.type", from: null, to: "collection", rule: "bundle-type", reason: "requested by caller (bundle_type)" }]);
  // A profile-fixed type wins; the conflict is a note, not a change.
  const fixed = await finalizeBundle({ ...b, meta: { profile: [DOC_PROFILE] } }, docDeps, { bundleType: "collection" });
  assert.equal(fixed.bundle.type, "document");
  assert.deepEqual(fixed.changes.filter((c) => c.rule === "bundle-type"), [{ path: "Bundle.type", from: "collection", to: "document", rule: "bundle-type" }], "profile-fixed change carries no reason (unchanged from 1.0.1)");
  assert.ok(fixed.notes.some((n) => n.includes("bundle_type 'collection' was requested but") && n.includes("fixes Bundle.type to 'document'")));
  // Requesting the fixed type itself: nothing extra.
  const agree = await finalizeBundle({ ...b, meta: { profile: [DOC_PROFILE] } }, docDeps, { bundleType: "document" });
  assert.ok(!agree.notes.some((n) => n.includes("was requested")));
  // Outside the R4 value set: rejected.
  await assert.rejects(finalizeBundle(b, deps, { bundleType: "documents" }), TypeError);
  assert.deepEqual([...BUNDLE_TYPES], ["document", "message", "transaction", "transaction-response", "batch", "batch-response", "history", "searchset", "collection"]);
});

test("document without a Composition: the note names the alternative (bundle_type from the entries' shape) and suggestBundleType derives it from evidence", async () => {
  const b = bundle([{ fullUrl: "urn:uuid:3f2a9c1e-7b4d-4e8a-9f1c-2d5e6a7b8c9d", resource: patient("p") }], { type: "document" });
  const r = await finalizeBundle(b, deps);
  assert.ok(r.notes.some((n) => n.startsWith("Bundle.type is document but no entry holds a Composition (bdl-11): either set bundle_type=collection (") && n.endsWith("or add a Composition as the first entry")));
  assert.equal(r.bundle.type, "document", "never changed on its own");
  const fixed = await finalizeBundle({ ...b, meta: { profile: [DOC_PROFILE] } }, docDeps);
  assert.ok(fixed.notes.some((n) => n.includes("add a Composition as the first entry (Bundle.type is fixed to document by")));
  const types = (x: Record<string, any>): string[] => suggestBundleType(x).map((c) => c.type);
  assert.deepEqual(types(b), ["collection"]);
  assert.deepEqual(types({ entry: [] }), ["collection"]);
  const req = (res: Record<string, any>, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ resource: res, request: { method: "POST", url: res.resourceType }, ...extra });
  assert.deepEqual(types({ entry: [req(patient("a")), req(patient("b"))] }), ["transaction", "batch"], "requests and no internal reference");
  assert.deepEqual(types({ entry: [req(patient("a")), req(condition("Patient/a"))] }), ["transaction"], "requests and an internal reference");
  assert.deepEqual(types({ entry: [req(patient("a")), { resource: patient("b") }] }), ["transaction", "collection"]);
  assert.deepEqual(types({ entry: [{ resource: patient("a"), search: { mode: "match" } }] }), ["searchset", "collection"]);
  assert.deepEqual(types({ entry: [{ resource: patient("a"), response: { status: "201" } }] }), ["transaction-response", "batch-response"]);
  const c = suggestBundleType({ entry: [req(patient("a")), req(patient("b"))] });
  assert.ok(c[0].confidence > c[1].confidence);
});

const LOSSLESS_TEXT =
  '{"resourceType":"Bundle","id":"urn:uuid:3f2a9c1e-7b4d-4e8a-9f1c-2d5e6a7b8c9d","type":"collection","entry":[' +
  '{"fullUrl":"urn:uuid:patient-1","resource":{"resourceType":"Patient","id":"patient-1","extension":[{"url":"http://example.tw/w","valueDecimal":10.0},{"url":"http://example.tw/n","extension":[{"url":"a","valueDecimal":1e3}]}],"multipleBirthInteger":2}},' +
  '{"resource":{"resourceType":"Observation","status":"final","code":{"text":"x"},"subject":{"reference":"Patient/patient-1"},"valueQuantity":{"value":0.50,"unit":"g"},"referenceRange":[{"low":{"value":-0.0},"high":{"value":12345678901234567890}},{"high":{"value":1.50}}],"component":[{"code":{"text":"c"},"valueInteger":007}]}}' +
  "]}";

test("lossless numbers: the finalized Bundle's text equals the input text except for the rewritten id / fullUrl / reference fields", async () => {
  const text = LOSSLESS_TEXT.replace("007", "7");
  const plain = JSON.parse(text);
  const fin = await finalizeBundle(plain, deps);
  const lossless = losslessFinalizedBundle(fin.bundle, fin.changes, parseLossless(text));
  assert.ok(lossless);
  const out = stringifyLossless(lossless);
  // Expected: apply the change list textually to the input.
  let expected = text
    .replace('"id":"urn:uuid:3f2a9c1e-7b4d-4e8a-9f1c-2d5e6a7b8c9d"', '"id":"3f2a9c1e-7b4d-4e8a-9f1c-2d5e6a7b8c9d"')
    .replace('"fullUrl":"urn:uuid:patient-1"', `"fullUrl":"${fin.bundle.entry[0].fullUrl}"`)
    .replace('"reference":"Patient/patient-1"', `"reference":"${fin.bundle.entry[0].fullUrl}"`);
  // The minted fullUrl of entry[1] is appended (new key last), exactly as the ordinary output does.
  expected = expected.replace(']}}]}', `]},"fullUrl":"${fin.bundle.entry[1].fullUrl}"}]}`);
  assert.equal(out, expected);
  for (const n of ["10.0", "1e3", "0.50", "-0.0", "12345678901234567890", "1.50"]) assert.ok(out.includes(n), n);
  // Same JSON value as the ordinary tree (compared as JSON text: -0.0 parses to -0, which JSON writes as 0); the
  // ordinary tree's own text is unchanged from before.
  assert.equal(JSON.stringify(JSON.parse(out)), JSON.stringify(fin.bundle));
  assert.ok(!JSON.stringify(fin.bundle).includes("10.0"), "the ordinary tree still loses the spelling (JSON.parse semantics)");
  // Idempotent: finalizing the lossless output again changes nothing and keeps the spellings.
  const again = await finalizeBundle(JSON.parse(out), deps);
  assert.deepEqual(again.changes, []);
  assert.equal(stringifyLossless(losslessFinalizedBundle(again.bundle, again.changes, parseLossless(out))), out);
  // Unusable source → null (caller falls back to the ordinary tree).
  assert.equal(losslessFinalizedBundle(fin.bundle, fin.changes, undefined), null);
  assert.equal(losslessFinalizedBundle(fin.bundle, fin.changes, "nope"), null);
  // A mismatching source (another Bundle) never corrupts values.
  const other = parseLossless(text.replace("10.0", "11.0").replace("0.50", "0.75"));
  const mixed = stringifyLossless(losslessFinalizedBundle(fin.bundle, fin.changes, other)!);
  assert.equal(JSON.stringify(JSON.parse(mixed)), JSON.stringify(fin.bundle));
  assert.ok(mixed.includes('"valueDecimal":10}') && mixed.includes('"value":0.5,'), "differing values come from the output");
  assert.ok(mixed.includes("1e3"), "matching values keep the source spelling");
});

test("lossless numbers follow a document reorder (Composition moved first) and the finalizer treats RawNumber as a scalar", async () => {
  const text =
    '{"resourceType":"Bundle","type":"document","entry":[' +
    '{"fullUrl":"urn:uuid:3f2a9c1e-7b4d-4e8a-9f1c-2d5e6a7b8c9d","resource":{"resourceType":"Patient","id":"p","extension":[{"url":"http://example.tw/w","valueDecimal":1.0}]}},' +
    '{"fullUrl":"urn:uuid:4f2a9c1e-7b4d-4e8a-9f1c-2d5e6a7b8c9d","resource":{"resourceType":"Composition","status":"final","type":{"text":"t"},"date":"2024-01-01","title":"x","author":[{"reference":"urn:uuid:3f2a9c1e-7b4d-4e8a-9f1c-2d5e6a7b8c9d"}],"subject":{"reference":"urn:uuid:3f2a9c1e-7b4d-4e8a-9f1c-2d5e6a7b8c9d"},"extension":[{"url":"http://example.tw/w","valueDecimal":2.00}]}}' +
    "]}";
  const fin = await finalizeBundle(JSON.parse(text), deps);
  assert.deepEqual(fin.changes.map((c) => c.rule), ["document-order"]);
  assert.deepEqual(entryOrderOf(fin.changes, 2), [1, 0]);
  assert.deepEqual(entryOrderOf([], 3), [0, 1, 2]);
  const out = stringifyLossless(losslessFinalizedBundle(fin.bundle, fin.changes, parseLossless(text))!);
  assert.ok(out.indexOf('"valueDecimal":2.00') < out.indexOf('"valueDecimal":1.0'), "spellings travel with their entries");
  assert.deepEqual(JSON.parse(out), fin.bundle);
  // The salt / finalizer never descend into a RawNumber (a lossless tree fed in by mistake still works).
  const raw = parseLossless(text) as Record<string, any>;
  assert.equal(bundleSalt(raw), bundleSalt(JSON.parse(text)), "RawNumber hashes as its number");
  const finRaw = await finalizeBundle(raw, deps);
  assert.deepEqual(finRaw.changes, fin.changes);
});
