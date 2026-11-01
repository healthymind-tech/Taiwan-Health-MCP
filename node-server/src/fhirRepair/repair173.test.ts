/**
 * ISSUES_v17.3 finding 2 — finalize repairs (repair="content") on synthetic resources over the R4 core package
 * (local FHIR package cache; skipped when absent): a string for a complex element (Dosage / Annotation → {text},
 * Narrative → generated XHTML div), a string note one level too deep moved up as an Annotation, and an unknown
 * code whose display names exactly one code.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { available, packages } from "../../scripts/v16-structure-eval/packages.js";
import { repairBundle, type RepairDeps } from "./index.js";

const subj = { reference: "urn:uuid:00000000-0000-4000-8000-000000000001" };
const bundleOf = (r: Record<string, any>): Record<string, any> => ({
  resourceType: "Bundle",
  type: "collection",
  entry: [
    { fullUrl: subj.reference, resource: { resourceType: "Patient", name: [{ text: "王小明" }] } },
    { fullUrl: "urn:uuid:00000000-0000-4000-8000-000000000002", resource: r },
  ],
});

function depsFor(extra: Partial<RepairDeps> = {}): RepairDeps {
  const r = packages("twcore").resolver();
  return { fetchStructureDefinition: (u) => r.fetchStructureDefinition(u), ...extra };
}

test("a string for Dosage / Annotation / Narrative becomes the datatype's text / generated div", { skip: !available("twcore") }, async () => {
  const b = bundleOf({
    resourceType: "MedicationRequest", status: "active", intent: "order", subject: subj, medicationCodeableConcept: { text: "Metformin" },
    text: "Metformin <500 mg> BID", dosageInstruction: "500 mg PO BID", note: "飯後服用",
  });
  await repairBundle(b, depsFor(), {});
  const r = b.entry[1].resource;
  assert.deepEqual(r.dosageInstruction, [{ text: "500 mg PO BID" }]);
  assert.deepEqual(r.note, [{ text: "飯後服用" }]);
  assert.deepEqual(r.text, { status: "generated", div: '<div xmlns="http://www.w3.org/1999/xhtml">Metformin &lt;500 mg&gt; BID</div>' });
});

test("release v1: a string ITEM of a Dosage array is reported as that item (string → {text}), never as a no-op of the whole array", { skip: !available("twcore") }, async () => {
  const b = bundleOf({
    resourceType: "MedicationRequest", status: "active", intent: "order", subject: subj, medicationCodeableConcept: { text: "Metformin" },
    dosageInstruction: [{ text: "500 mg PO BID" }, "1 tab at bedtime"],
  });
  const r = await repairBundle(b, depsFor(), {});
  assert.deepEqual(b.entry[1].resource.dosageInstruction, [{ text: "500 mg PO BID" }, { text: "1 tab at bedtime" }]);
  const c = r.changes.find((x) => x.path === "Bundle.entry[1].resource.dosageInstruction[1]")!;
  assert.ok(c, JSON.stringify(r.changes));
  assert.equal(c.from, "1 tab at bedtime");
  assert.deepEqual(c.to, { text: "1 tab at bedtime" });
  for (const x of r.changes) assert.notDeepEqual(x.from, x.to, `no-op change ${JSON.stringify(x)}`);
});

test("a string note inside Dosage moves up to MedicationRequest.note as an Annotation", { skip: !available("twcore") }, async () => {
  const b = bundleOf({ resourceType: "MedicationRequest", status: "active", intent: "order", subject: subj, medicationCodeableConcept: { text: "Metformin" }, dosageInstruction: [{ text: "500 mg BID", note: "飯後服用" }] });
  await repairBundle(b, depsFor(), {});
  const r = b.entry[1].resource;
  assert.deepEqual(r.dosageInstruction, [{ text: "500 mg BID" }]);
  assert.deepEqual(r.note, [{ text: "飯後服用" }]);
});

test("an unknown code whose display names exactly one code is corrected; several exact names → unchanged", { skip: !available("twcore") }, async () => {
  const obs = (code: string, display: string): Record<string, any> => ({ resourceType: "Observation", status: "final", subject: subj, code: { coding: [{ system: "http://loinc.org", code, display }] } });
  const names: Record<string, Array<{ code: string; display: string }>> = {
    "Hemoglobin A1c/Hemoglobin.total in Blood": [{ code: "4548-4", display: "Hemoglobin A1c/Hemoglobin.total in Blood" }, { code: "17856-6", display: "Hemoglobin A1c/Hemoglobin.total in Blood by HPLC" }],
    Glucose: [{ code: "2345-7", display: "Glucose" }, { code: "2339-0", display: "Glucose" }],
  };
  const deps = depsFor({
    codeInSystem: async (_s, c) => ["4548-4", "17856-6", "2345-7", "2339-0"].includes(c),
    normalize: async (text) => (names[text] ?? []).map((x) => ({ system: "http://loinc.org", code: x.code, display: x.display, exact: x.display === text })),
  });
  const a = bundleOf(obs("4548-5", "Hemoglobin A1c/Hemoglobin.total in Blood"));
  const ra = await repairBundle(a, deps, {});
  assert.equal(a.entry[1].resource.code.coding[0].code, "4548-4");
  assert.ok(ra.changes.some((c) => c.rule === "code" && c.to === "4548-4"));
  const g = bundleOf(obs("2345-0", "Glucose"));
  await repairBundle(g, deps, {});
  assert.equal(g.entry[1].resource.code.coding[0].code, "2345-0", "two codes are named exactly 'Glucose': not decidable");
});

test("v17.1 R4: STU3 elements R4 renamed are renamed (vaccineProtocol → protocolApplied with its children, date → occurrenceDateTime, comment → note); removed ones are reported, kept", { skip: !available("twcore") }, async () => {
  const b = bundleOf({
    resourceType: "Immunization", status: "completed", patient: subj, vaccineCode: { text: "Influenza" },
    date: "2024-10-01", notGiven: false,
    vaccineProtocol: [{ doseSequence: 1, seriesDoses: 2, targetDisease: [{ text: "Influenza" }] }],
  });
  const r = await repairBundle(b, depsFor(), {});
  const imm = b.entry[1].resource;
  assert.equal(imm.occurrenceDateTime, "2024-10-01");
  assert.equal(imm.date, undefined);
  assert.deepEqual(imm.protocolApplied, [{ doseNumberPositiveInt: 1, seriesDosesPositiveInt: 2, targetDisease: [{ text: "Influenza" }] }]);
  assert.equal(imm.notGiven, false, "removed in R4: reported, not deleted");
  assert.ok(r.issues.some((i) => /notGiven/.test(i.message) && /not-done/.test(i.message)));
  const o = bundleOf({ resourceType: "Observation", status: "final", subject: subj, code: { text: "BP" }, comment: "坐姿量測" });
  await repairBundle(o, depsFor(), {});
  assert.deepEqual(o.entry[1].resource.note, [{ text: "坐姿量測" }]);
});
