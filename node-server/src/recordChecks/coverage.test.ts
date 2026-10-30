/**
 * ISSUES_v17 R2 — content coverage (coverage.ts) on synthetic, rewritten forms: negated / cancelled /
 * deferred / excluded items written as done, duplicate entries, facts only in Dosage.text — and the
 * controls that must stay silent.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { runRecordChecks } from "./index.js";

type Json = Record<string, any>;
const bundle = (...resources: Json[]): Json => ({
  resourceType: "Bundle",
  type: "collection",
  entry: resources.map((r, i) => ({ fullUrl: `urn:uuid:00000000-0000-4000-8000-00000000000${i}`, resource: r })),
});
const patient: Json = { resourceType: "Patient", id: "p", name: [{ text: "王小明" }] };
const subject = { reference: "urn:uuid:00000000-0000-4000-8000-000000000000" };
const med = (name: string, extra: Json = {}): Json => ({
  resourceType: "MedicationRequest",
  status: "active",
  intent: "order",
  subject,
  medicationCodeableConcept: { coding: [{ system: "http://example.org/drugs", code: name.toUpperCase(), display: name }], text: name },
  ...extra,
});
const codes = (issues: Json[], code: string): Json[] => issues.filter((i) => i.code === code);
const run = (b: Json, record: string, extra: Json = {}): Json[] => runRecordChecks(b, { sourceText: record, ...extra }).issues as Json[];

test("negated-item-present: not prescribed this time / stopped / cancelled / denied / deferred items written as done", () => {
  const rec =
    "S: 高血脂追蹤。\nP: Atorvastatin 20mg 1# QD，病人表示家中尚有藥，本次不開立。Metformin 500mg 1# BID 續用。\n" +
    "Aspirin 已停用。否認盤尼西林過敏。大腸鏡檢查待排程。";
  const b = bundle(
    patient,
    med("Atorvastatin 20 mg"),
    med("Metformin 500 mg"),
    { resourceType: "MedicationStatement", status: "active", subject, medicationCodeableConcept: { text: "Aspirin" } },
    { resourceType: "AllergyIntolerance", patient: subject, code: { text: "盤尼西林" }, clinicalStatus: { coding: [{ code: "active" }] } },
    { resourceType: "Procedure", status: "completed", subject, code: { text: "大腸鏡檢查" } },
  );
  const hits = codes(run(b, rec), "negated-item-present");
  const at = (i: number): Json | undefined => hits.find((h) => h.path.startsWith(`Bundle.entry[${i}].resource`));
  assert.ok(at(1), "Atorvastatin not prescribed but active");
  assert.equal(at(2), undefined, "Metformin is continued");
  assert.ok(at(3), "Aspirin stopped but MedicationStatement active");
  assert.ok(at(4), "denied allergy written as an active AllergyIntolerance");
  assert.ok(at(5), "colonoscopy to be scheduled written as completed");
  for (const h of hits) {
    assert.equal(h.severity, "error");
    assert.ok(h.located_quotes?.length, "quotes the record");
    assert.ok(h.suggestions?.length, "suggests a fix");
  }
  assert.match(at(1)!.message_zh, /本次不開立/);
});

test("negated-item-present: statuses that already say so stay silent; a plain mention elsewhere wins", () => {
  const rec = "P: Atorvastatin 本次不開立。Aspirin 已停用。大腸鏡檢查待排程。\n另於出院帶藥開立 Clopidogrel 75mg QD。Aspirin 停用，改用 Clopidogrel。";
  const b = bundle(
    patient,
    med("Atorvastatin", { status: "cancelled" }),
    { resourceType: "MedicationStatement", status: "stopped", subject, medicationCodeableConcept: { text: "Aspirin" } },
    { resourceType: "ServiceRequest", status: "active", intent: "order", subject, code: { text: "大腸鏡檢查" } },
    med("Clopidogrel 75 mg"),
  );
  assert.deepEqual(codes(run(b, rec), "negated-item-present"), []);
});

test("negated-item-present: the conversion target excludes an item or a category", () => {
  const rec = "【轉換目標】轉為 Bundle；過敏史不需轉換，Vitamin C 不用轉換\nP: Vitamin C 500mg QD。對 Penicillin 過敏。";
  const b = bundle(
    patient,
    { resourceType: "AllergyIntolerance", patient: subject, code: { text: "Penicillin" } },
    med("Vitamin C 500 mg"),
  );
  const hits = codes(run(b, rec), "negated-item-present");
  assert.equal(hits.length, 2, JSON.stringify(hits.map((h) => h.path)));
  assert.ok(hits.every((h) => h.suggestions?.[0]?.kind === "remove_entry"));
});

test("duplicate-entry: same content apart from ids, and the same thing; different items stay silent", () => {
  const dx = (id: string, code: string): Json => ({ resourceType: "Condition", id, subject, code: { coding: [{ system: "http://hl7.org/fhir/sid/icd-10-cm", code }] } });
  const b = bundle(patient, dx("a", "E11.9"), dx("b", "E11.9"), dx("c", "I10"), med("Metformin", { id: "m1" }), med("Metformin", { id: "m2", note: [{ text: "x" }] }));
  const hits = codes(run(b, "Dx: E11.9 第二型糖尿病；I10 高血壓。Metformin 500mg BID。"), "duplicate-entry");
  assert.deepEqual(hits.map((h) => h.path), ["Bundle.entry[2].resource", "Bundle.entry[5].resource"]);
  assert.ok(hits.every((h) => h.severity === "error"));
});

test("text-only-fact: dose, frequency, route and duration only in Dosage.text; configurable severity; structured ones stay silent", () => {
  const rec = "P: Metformin 500 mg 1# PO BID，28 天。";
  const b = bundle(patient, med("Metformin", { dosageInstruction: [{ text: "500 mg 1# PO BID，28 天" }] }));
  const w = codes(run(b, rec), "text-only-fact");
  const fields = w.map((h) => h.path.replace(/^Bundle\.entry\[1\]\.resource\./u, ""));
  assert.deepEqual(fields.sort(), ["dispenseRequest.expectedSupplyDuration", "dosageInstruction[0].doseAndRate[0].doseQuantity", "dosageInstruction[0].route", "dosageInstruction[0].timing.code"].sort());
  assert.ok(w.every((h) => h.severity === "warning"));
  const timing = w.find((h) => h.path.endsWith("timing.code"))!;
  assert.match(String(timing.suggestions[0].value), /BID/);
  const dur = w.find((h) => h.path.endsWith("expectedSupplyDuration"))!;
  assert.deepEqual(dur.suggestions[0].patch.value, { value: 28, unit: "days", system: "http://unitsofmeasure.org", code: "d" });
  assert.ok(codes(run(b, rec, { coverageSeverity: "error" }), "text-only-fact").every((h) => h.severity === "error"));
  const full = bundle(patient, med("Metformin", {
    dosageInstruction: [{
      text: "500 mg 1# PO BID，28 天",
      timing: { code: { coding: [{ code: "BID" }] } },
      route: { text: "PO" },
      doseAndRate: [{ doseQuantity: { value: 500, unit: "mg" } }],
    }],
    dispenseRequest: { expectedSupplyDuration: { value: 28, unit: "days" } },
  }));
  assert.deepEqual(codes(run(full, rec), "text-only-fact"), []);
});

test("R6 runs only with source_text", () => {
  const b = bundle(patient, med("Metformin", { dosageInstruction: [{ text: "500 mg BID" }] }), med("Metformin"));
  const r = runRecordChecks(b, {});
  assert.ok(!r.summary.rules.includes("R6"));
  assert.deepEqual(r.issues.filter((i) => i.rule === "R6"), []);
});

test("record-fact-missing: H / L flags after the unit (not inside it), reference ranges in the record; mustSupport fields from the profile", () => {
  const pe = new Map([["http://x/Observation-lab", { mustSupport: new Set<string>(), required: new Set<string>(), common: new Set<string>(), prohibited: new Set<string>() }],
    ["http://x/Encounter", { mustSupport: new Set(["Encounter.serviceType"]), required: new Set<string>() }]]);
  const obs = (name: string, value: number, unit: string): Json => ({ resourceType: "Observation", meta: { profile: ["http://x/Observation-lab"] }, status: "final", subject, code: { text: name }, valueQuantity: { value, unit } });
  const rec = "Lab: TSH 0.02 uIU/mL (L)，Platelet 192 ×10³/μL，HbA1c 7.2 %  (ref 4.0-6.0)，Na 140 mmol/L\n科別：家醫科";
  const b = bundle(patient, obs("TSH", 0.02, "uIU/mL"), obs("Platelet", 192, "10*3/uL"), obs("HbA1c", 7.2, "%"), obs("Na", 140, "mmol/L"),
    { resourceType: "Encounter", meta: { profile: ["http://x/Encounter"] }, status: "finished", class: { code: "AMB" }, subject });
  const hits = runRecordChecks(b, { sourceText: rec, profileElements: pe as never }).issues.filter((i) => i.code === "record-fact-missing");
  const by = (i: number): string | undefined => hits.find((h) => h.path.startsWith(`Bundle.entry[${i}]`))?.suggestions?.[0]?.value;
  assert.match(by(1) ?? "", /"L"/);
  assert.equal(by(2), undefined, "×10³/μL is a unit, not a flag");
  assert.match(by(3) ?? "", /"H"/, "7.2 above the stated range 4.0-6.0");
  assert.equal(by(4), undefined, "no flag, no range");
  assert.match(by(5) ?? "", /家醫科/);
});
