/**
 * ISSUES_v17.1 R1 / R2 — document Bundle completion and narrative repair (document.ts) over a synthetic
 * Composition profile: identifier / timestamp, subject / author, entries placed into the one section that takes
 * them (with code display, title and generated text), required sections reported, nothing invented.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { completeDocument, repairNarrative, repairNarratives } from "./document.js";

type Json = Record<string, any>;
const LOINC = "http://loinc.org";
const CP = "http://x/StructureDefinition/Composition-x";
const BP = "http://x/StructureDefinition/Bundle-x";
const sec = (name: string, min: number, code: string, display: string, targets: string[]): Json[] => [
  { id: `Composition.section:${name}`, path: "Composition.section", min, max: "1" },
  { id: `Composition.section:${name}.title`, path: "Composition.section.title", min: 1, max: "1" },
  { id: `Composition.section:${name}.code`, path: "Composition.section.code", min: 1, max: "1", patternCodeableConcept: { coding: [{ system: LOINC, code, display }] } },
  { id: `Composition.section:${name}.text`, path: "Composition.section.text", min: 1, max: "1" },
  { id: `Composition.section:${name}.entry`, path: "Composition.section.entry", min: 0, max: "*", type: [{ code: "Reference", targetProfile: targets }] },
];
const SDS: Record<string, Json> = {
  [CP]: {
    url: CP, type: "Composition",
    snapshot: { element: [{ id: "Composition", path: "Composition" }, ...sec("meds", 1, "10160-0", "History of Medication use Narrative", ["http://hl7.org/fhir/StructureDefinition/MedicationStatement"]), ...sec("allergies", 1, "48765-2", "Allergies and adverse reactions Document", ["http://hl7.org/fhir/StructureDefinition/AllergyIntolerance"])] },
  },
  [BP]: {
    url: BP, type: "Bundle",
    snapshot: { element: [{ id: "Bundle.type", path: "Bundle.type", fixedCode: "document" }, { id: "Bundle.entry:composition.resource", path: "Bundle.entry.resource", type: [{ code: "Composition", profile: [CP] }] }] },
  },
};
const deps = { fetchStructureDefinition: async (u: string) => SDS[u.split("|")[0]] ?? (/StructureDefinition\/([A-Z]\w+)$/.exec(u) ? { url: u, type: /StructureDefinition\/([A-Z]\w+)$/.exec(u)![1] } : null) };
const u = (n: number): string => `urn:uuid:00000000-0000-4000-8000-00000000000${n}`;

function doc(comp: Json, ...rest: Json[]): Json {
  return { resourceType: "Bundle", meta: { profile: [BP] }, type: "document", entry: [{ fullUrl: u(0), resource: comp }, ...rest.map((r, i) => ({ fullUrl: u(i + 1), resource: r }))] };
}

test("identifier / timestamp / subject / author / meta.profile completed; sections built from the profile's slices", async () => {
  const b = doc(
    { resourceType: "Composition", status: "final", type: { coding: [{ system: LOINC, code: "60591-5" }] }, date: "2024-05-01T10:30+08:00", title: "Summary" },
    { resourceType: "Patient", name: [{ text: "王小明" }] },
    { resourceType: "Practitioner", name: [{ text: "李醫師" }] },
    { resourceType: "MedicationStatement", status: "active", subject: { reference: u(1) }, medicationCodeableConcept: { text: "Metformin 500 mg" } },
  );
  const r = await completeDocument(b, deps);
  const comp = b.entry[0].resource;
  assert.match(b.identifier.value, /^urn:uuid:[0-9a-f-]{36}$/);
  assert.equal(b.identifier.system, "urn:ietf:rfc:3986");
  assert.equal(b.timestamp, "2024-05-01T10:30:00+08:00");
  assert.deepEqual(comp.subject, { reference: u(1) });
  assert.deepEqual(comp.author, [{ reference: u(2) }]);
  assert.deepEqual(comp.meta.profile, [CP]);
  const meds = comp.section.find((s: Json) => s.code.coding[0].code === "10160-0");
  assert.equal(meds.title, "History of Medication use Narrative");
  assert.deepEqual(meds.entry, [{ reference: u(3) }]);
  assert.match(meds.text.div, /^<div xmlns="http:\/\/www\.w3\.org\/1999\/xhtml"><ul><li>Metformin 500 mg<\/li><\/ul><\/div>$/);
  // the required allergies section has nothing to take: reported, not invented
  assert.ok(r.issues.some((i) => /required section 'allergies'/.test(i.message) && /emptyReason/.test(i.message)));
  assert.equal(comp.section.length, 1);
  // same input → same identifier
  const b2 = doc(
    { resourceType: "Composition", status: "final", type: { coding: [{ system: LOINC, code: "60591-5" }] }, date: "2024-05-01T10:30+08:00", title: "Summary" },
    { resourceType: "Patient", name: [{ text: "王小明" }] },
    { resourceType: "Practitioner", name: [{ text: "李醫師" }] },
    { resourceType: "MedicationStatement", status: "active", subject: { reference: u(1) }, medicationCodeableConcept: { text: "Metformin 500 mg" } },
  );
  await completeDocument(b2, deps);
  assert.equal(b2.identifier.value, b.identifier.value);
});

test("a date without a time gives no timestamp (reported); several patients → subject reported; not a document → untouched", async () => {
  const b = doc({ resourceType: "Composition", status: "final", date: "2024-05-01" }, { resourceType: "Patient" }, { resourceType: "Patient" });
  const r = await completeDocument(b, deps);
  assert.equal(b.timestamp, undefined);
  assert.ok(r.issues.some((i) => i.path === "Bundle.timestamp"));
  assert.equal(b.entry[0].resource.subject, undefined);
  const c = { resourceType: "Bundle", type: "collection", entry: [{ fullUrl: u(0), resource: { resourceType: "Composition", status: "final" } }] };
  const rc = await completeDocument(c, deps);
  assert.deepEqual([rc.changes, rc.issues], [[], []]);
  assert.equal((c as Json).identifier, undefined);
});

test("narratives: string-less / namespace-less / wrong status / text in another property", () => {
  const h: Json = { text: { status: "final", div: "<div>Hi</div>" } };
  assert.ok(repairNarrative(h, "text"));
  assert.deepEqual(h.text, { status: "generated", div: '<div xmlns="http://www.w3.org/1999/xhtml">Hi</div>' });
  const h2: Json = { text: { status: "generated", text: "a < b" } };
  repairNarrative(h2, "text");
  assert.equal(h2.text.div, '<div xmlns="http://www.w3.org/1999/xhtml">a &lt; b</div>');
  const h3: Json = { text: { status: "generated" } };
  repairNarrative(h3, "text");
  assert.equal(h3.text, undefined, "only a status: removed");
  const ok: Json = { text: { status: "generated", div: '<div xmlns="http://www.w3.org/1999/xhtml">x</div>' } };
  assert.equal(repairNarrative(ok, "text"), null);
  const b = doc({ resourceType: "Composition", section: [{ title: "t", text: { status: "final", div: "<div>s</div>" } }] });
  const ch = repairNarratives(b);
  assert.deepEqual(ch.map((c) => c.path), ["Bundle.entry[0].resource.section[0].text"]);
});
