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
    assert.equal((h.advisory_from ?? h.severity), "error");
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
  // v20.2: never tells the model to delete content — no remove suggestion, the message asks to verify
  assert.ok(hits.every((h) => !h.suggestions?.some((s: { kind?: string }) => /^remove/u.test(String(s.kind)))));
  assert.ok(hits.every((h) => /確認|Verify/u.test(String(h.message))));
});

test("duplicate-entry: same content apart from ids, and the same thing; different items stay silent", () => {
  const dx = (id: string, code: string): Json => ({ resourceType: "Condition", id, subject, code: { coding: [{ system: "http://hl7.org/fhir/sid/icd-10-cm", code }] } });
  const b = bundle(patient, dx("a", "E11.9"), dx("b", "E11.9"), dx("c", "I10"), med("Metformin", { id: "m1" }), med("Metformin", { id: "m2", note: [{ text: "x" }] }));
  const hits = codes(run(b, "Dx: E11.9 第二型糖尿病；I10 高血壓。Metformin 500mg BID。"), "duplicate-entry");
  assert.deepEqual(hits.map((h) => h.path), ["Bundle.entry[2].resource", "Bundle.entry[5].resource"]);
  assert.ok(hits.every((h) => (h.advisory_from ?? h.severity) === "error"));
});

test("text-only-fact: dose, frequency, route and duration only in Dosage.text; configurable severity; structured ones stay silent", () => {
  const rec = "P: Metformin 500 mg 1# PO BID，28 天。";
  const b = bundle(patient, med("Metformin", { dosageInstruction: [{ text: "500 mg 1# PO BID，28 天" }] }));
  const w = codes(run(b, rec), "text-only-fact");
  const fields = w.map((h) => h.path.replace(/^Bundle\.entry\[1\]\.resource\./u, ""));
  assert.deepEqual(fields.sort(), ["dispenseRequest.expectedSupplyDuration", "dosageInstruction[0].doseAndRate[0].doseQuantity", "dosageInstruction[0].route", "dosageInstruction[0].timing.code"].sort());
  assert.ok(w.every((h) => (h.advisory_from ?? h.severity) === "warning"));
  const timing = w.find((h) => h.path.endsWith("timing.code"))!;
  assert.match(String(timing.suggestions[0].value), /BID/);
  const dur = w.find((h) => h.path.endsWith("expectedSupplyDuration"))!;
  assert.deepEqual(dur.suggestions[0].patch.value, { value: 28, unit: "days", system: "http://unitsofmeasure.org", code: "d" });
  assert.ok(codes(run(b, rec, { coverageSeverity: "error" }), "text-only-fact").every((h) => (h.advisory_from ?? h.severity) === "error"));
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

// ---- ISSUES_v20 R5: record-derivable facts (category 2: a record fact missing from the Bundle) ----------------

const prof = (url: string, extra: Json = {}): [string, Json] => [url, { mustSupport: new Set<string>(), required: new Set<string>(), common: new Set<string>(), prohibited: new Set<string>(), ...extra }];
const PE = new Map([prof("http://x/Condition"), prof("http://x/Observation"), prof("http://x/MedicationRequest")]);
const cond = (name: string): Json => ({ resourceType: "Condition", meta: { profile: ["http://x/Condition"] }, subject, clinicalStatus: { coding: [{ code: "active" }] }, code: { text: name } });
const lab = (name: string, value: number, unit: string, extra: Json = {}): Json => ({ resourceType: "Observation", meta: { profile: ["http://x/Observation"] }, status: "final", subject, code: { text: name }, valueQuantity: { value, unit }, ...extra });
const rx = (name: string): Json => med(name, { meta: { profile: ["http://x/MedicationRequest"] } });
const derivable = (b: Json, record: string | undefined, pe: unknown = PE, sev?: string): Json[] =>
  (runRecordChecks(b, { ...(record !== undefined ? { sourceText: record } : {}), profileElements: pe as never, ...(sev ? { coverageSeverity: sev } : {}) }).issues as Json[]).filter((i) => i.code === "record-fact-missing");
const valueAt = (hits: Json[], suffix: string): string | undefined => hits.find((h) => h.path.endsWith(suffix))?.suggestions?.[0]?.value;

test("R5 verificationStatus: the diagnosis field states it → confirmed; hedged → provisional; r/o → differential; no field → nothing", () => {
  const b = bundle(patient, cond("第二型糖尿病"), cond("肺炎"), cond("肺結核"), cond("高血壓"));
  const rec = "S: 咳嗽三天。\nA: 1. 第二型糖尿病 2. 疑似肺炎 3. r/o 肺結核\n過去病史：高血壓";
  const hits = derivable(b, rec);
  const at = (i: number): string | undefined => valueAt(hits.filter((h) => h.path.startsWith(`Bundle.entry[${i}]`)), ".verificationStatus");
  assert.match(at(1) ?? "", /"code":"confirmed"/);
  assert.match(at(2) ?? "", /"code":"provisional"/);
  assert.match(at(3) ?? "", /"code":"differential"/);
  assert.equal(at(4), undefined, "a past-history mention is not the diagnosis field: not derivable");
  assert.ok(hits.every((h) => (h.advisory_from ?? h.severity) === "warning"), "severity follows content_checks_severity (default warning)");
  assert.match(hits[0].message, /可由病歷推得/);
  // already written, or the profile prohibits the element: silent
  const written = bundle(patient, { ...cond("第二型糖尿病"), verificationStatus: { coding: [{ code: "confirmed" }] } });
  assert.deepEqual(derivable(written, rec), []);
  const prohibited = new Map([prof("http://x/Condition", { prohibited: new Set(["Condition.verificationStatus"]) })]);
  assert.deepEqual(derivable(bundle(patient, cond("第二型糖尿病")), rec, prohibited), []);
  // with content_checks_severity=error the finding is an error
  assert.ok(derivable(bundle(patient, cond("第二型糖尿病")), rec, PE, "error").every((h) => (h.advisory_from ?? h.severity) === "error"));
});

test("R5 interpretation: H / L / HH / LL / ↑ / ↓ / * flags and reference ranges (N inside); no cue → nothing", () => {
  const rec = "Lab: K 6.9 mmol/L HH，Hb 10.2 g/dL ↓，Glucose 95 mg/dL (70-99)，CRP 3.2 mg/dL *，Na 140 mmol/L，ALT 88 U/L (H)";
  const b = bundle(patient, lab("K", 6.9, "mmol/L"), lab("Hb", 10.2, "g/dL"), lab("Glucose", 95, "mg/dL"), lab("CRP", 3.2, "mg/dL"), lab("Na", 140, "mmol/L"), lab("ALT", 88, "U/L"));
  const hits = derivable(b, rec);
  const at = (i: number): string | undefined => valueAt(hits.filter((h) => h.path.startsWith(`Bundle.entry[${i}]`)), ".interpretation");
  assert.match(at(1) ?? "", /v3-ObservationInterpretation","code":"HH"/);
  assert.match(at(2) ?? "", /"code":"L"/);
  assert.match(at(3) ?? "", /"code":"N"/, "95 inside the record's range 70-99");
  assert.match(at(4) ?? "", /"code":"A"/, "a direction-less * without a range");
  assert.equal(at(5), undefined, "no flag, no range");
  assert.match(at(6) ?? "", /"code":"H"/);
  // the resource's own referenceRange decides when the record line has no flag
  const rr = bundle(patient, lab("Na", 128, "mmol/L", { referenceRange: [{ low: { value: 135 }, high: { value: 145 } }] }));
  assert.match(valueAt(derivable(rr, "Na 128 mmol/L"), ".interpretation") ?? "", /"code":"L"/);
  // an IG binding without the codes: nothing
  const noCodes = new Map([prof("http://x/Observation", { bindings: new Map([["Observation.interpretation", { valueSet: "http://x/vs/other", codes: [{ system: "http://x/cs", code: "pos", display: "Positive" }] }]]) })]);
  assert.deepEqual(derivable(bundle(patient, lab("ALT", 88, "U/L")), rec, noCodes), []);
});

test("R5 MedicationRequest.category: 出院帶藥 / 門診處方 / 住院醫囑 headings, the record's single visit setting, the IG's own codes", () => {
  const dis = "出院帶藥：\nAmlodipine 5 mg 1# QD x 7 days";
  assert.match(valueAt(derivable(bundle(patient, rx("Amlodipine")), dis), ".category") ?? "", /medicationrequest-category","code":"discharge"/);
  const opd = "門診處方：\nMetformin 500 mg 1# BID";
  assert.match(valueAt(derivable(bundle(patient, rx("Metformin")), opd), ".category") ?? "", /"code":"outpatient"/);
  const ipd = "住院醫囑：\nCefazolin 1 g IV Q8H";
  assert.match(valueAt(derivable(bundle(patient, rx("Cefazolin")), ipd), ".category") ?? "", /"code":"inpatient"/);
  const visit = "門診病歷 2025/06/02 家醫科\nP: Metformin 500 mg 1# BID 28天";
  assert.match(valueAt(derivable(bundle(patient, rx("Metformin")), visit), ".category") ?? "", /"code":"outpatient"/);
  // no setting cue (門診追蹤 is a follow-up plan, not the setting) → nothing
  assert.equal(valueAt(derivable(bundle(patient, rx("Metformin")), "P: Metformin 500 mg 1# BID，兩週後門診追蹤"), ".category"), undefined);
  // the IG binds its own ValueSet: its code whose display names the setting
  const ig = new Map([prof("http://x/MedicationRequest", { bindings: new Map([["MedicationRequest.category", { valueSet: "http://x/vs/rx", codes: [{ system: "http://x/cs/rx", code: "DIS", display: "出院帶藥" }, { system: "http://x/cs/rx", code: "OPD", display: "門診處方" }] }]]) })]);
  assert.match(valueAt(derivable(bundle(patient, rx("Amlodipine")), dis, ig), ".category") ?? "", /"system":"http:\/\/x\/cs\/rx","code":"DIS"/);
  // a binding holding no setting code: nothing
  const none = new Map([prof("http://x/MedicationRequest", { bindings: new Map([["MedicationRequest.category", { valueSet: "http://x/vs/kind", codes: [{ system: "http://x/cs/k", code: "chronic", display: "慢性病連續處方" }] }]]) })]);
  assert.equal(valueAt(derivable(bundle(patient, rx("Amlodipine")), dis, none), ".category"), undefined);
});

test("R5 record-derivable facts need source_text: without it nothing is reported", () => {
  const b = bundle(patient, cond("第二型糖尿病"), lab("K", 6.9, "mmol/L"), rx("Amlodipine"));
  assert.deepEqual(derivable(b, undefined), []);
  assert.ok(derivable(b, "A: 第二型糖尿病\nK 6.9 mmol/L HH\n出院帶藥：\nAmlodipine 5 mg QD").length >= 3);
});
