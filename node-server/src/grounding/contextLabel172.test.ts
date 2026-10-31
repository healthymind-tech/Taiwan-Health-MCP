/**
 * ISSUES_v17.2 R3 — G-CONTEXT-LABEL on medication evidence: a dose / frequency quote that is a fragment of a
 * record line listing several medicines belongs to the medicine named before it on that line — no error when
 * that is this resource's medicine, an error when it is another one.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { checkGrounding } from "./checkGrounding.js";
import { syntheticTerminology } from "./testkit.js";

type Json = Record<string, any>;
const subj = { reference: "urn:uuid:00000000-0000-4000-8000-000000000000" };
const med = (text: string, dose: number, freq: string): Json => ({
  resourceType: "MedicationRequest",
  status: "active",
  intent: "order",
  subject: subj,
  medicationCodeableConcept: { text },
  dosageInstruction: [{ timing: { code: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation", code: freq }] } }, doseAndRate: [{ doseQuantity: { value: dose, unit: "mg", system: "http://unitsofmeasure.org", code: "mg" } }] }],
});
const bundle = (...r: Json[]): Json => ({
  resourceType: "Bundle",
  type: "collection",
  entry: [{ fullUrl: subj.reference, resource: { resourceType: "Patient", name: [{ text: "王小明" }] } }, ...r.map((x, i) => ({ fullUrl: `urn:uuid:00000000-0000-4000-8000-00000000001${i}`, resource: x }))],
});
const REC = "病人：王小明\nP: Amlodipine 5mg QD, Metformin 500mg BID, Atorvastatin 10mg HS";
const ev = (entry: number): Json[] => [
  { path: `entry[${entry}].resource.medicationCodeableConcept`, quote: "Metformin" },
  { path: `entry[${entry}].resource.dosageInstruction[0].doseAndRate[0].doseQuantity`, quote: "500mg BID" },
  { path: `entry[${entry}].resource.dosageInstruction[0].timing`, quote: "BID" },
];
const contextLabels = async (b: Json, evidence: Json[]): Promise<string[]> => {
  const g = await checkGrounding({ bundle: b, source_text: REC, mode: "strict", evidence_map: evidence }, { terminology: syntheticTerminology() });
  return g.entries.flatMap((e) => e.issues).filter((i) => i.rule === "G-CONTEXT-LABEL").map((i) => i.path);
};

test("a dose fragment quoted from a several-medicine line is grounded on its own medicine", async () => {
  const b = bundle(med("Amlodipine", 5, "QD"), med("Metformin", 500, "BID"), med("Atorvastatin", 10, "HS"));
  assert.deepEqual(await contextLabels(b, ev(2)), []);
});

test("the same fragment for another medicine is still a context error", async () => {
  const b = bundle(med("Amlodipine", 500, "BID"), med("Metformin", 500, "BID"));
  const evidence = ev(1).map((e) => (e.quote === "Metformin" ? { ...e, quote: "Amlodipine" } : e));
  const paths = await contextLabels(b, evidence);
  assert.ok(paths.some((p) => p.endsWith("doseQuantity")), JSON.stringify(paths));
});
