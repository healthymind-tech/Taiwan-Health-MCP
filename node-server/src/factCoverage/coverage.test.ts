import { test } from "node:test";
import assert from "node:assert/strict";
import { checkFactCoverage, type Fact } from "./coverage.js";
import { findQuote, clauseMarkers } from "./markers.js";
import type { FieldSpec } from "../authoring/types.js";
import type { TerminologyNames } from "../grounding/terminologyNames.js";

// Synthetic record and Bundle (no real patient data).
const RECORD = [
  "門診日期：114/06/02",
  "Dx: 1. 高血壓 2. r/o 糖尿病",
  "否認藥物過敏",
  "體重 65 kg（前次 63 kg）",
  "HbA1c：待補",
  "Rx: Amlodipine 5 mg 1# PO BID x 28 天",
  "體溫 38.5°C",
  "Metformin 0.5 g PO QD",
  "身分證字號：A123456789",
].join("\n");

const urn = (n: number): string => `urn:uuid:00000000-0000-4000-8000-00000000000${n}`;

const BUNDLE = {
  resourceType: "Bundle",
  type: "collection",
  entry: [
    {
      fullUrl: urn(1),
      resource: {
        resourceType: "Patient",
        meta: { profile: ["https://example.org/StructureDefinition/Patient-x"] },
        identifier: [{ system: "http://example.org/id", value: "A123456789" }],
      },
    },
    {
      fullUrl: urn(2),
      resource: {
        resourceType: "Encounter",
        status: "finished",
        period: { start: "2025-06-02" },
      },
    },
    {
      fullUrl: urn(3),
      resource: {
        resourceType: "Condition",
        meta: { profile: ["https://example.org/StructureDefinition/Condition-x"] },
        text: { status: "generated", div: "<div xmlns=\"http://www.w3.org/1999/xhtml\">高血壓</div>" },
        code: { coding: [{ system: "http://hl7.org/fhir/sid/icd-10-cm", code: "I10", display: "Essential (primary) hypertension" }], text: "高血壓" },
      },
    },
    {
      fullUrl: urn(4),
      resource: {
        resourceType: "MedicationRequest",
        meta: { profile: ["https://example.org/StructureDefinition/MedicationRequest-x"] },
        status: "active",
        intent: "order",
        medicationCodeableConcept: { text: "Amlodipine 5 mg" },
        dosageInstruction: [
          {
            text: "1# PO BID",
            route: { coding: [{ system: "http://snomed.info/sct", code: "26643006", display: "Oral route" }] },
            timing: { repeat: { frequency: 2, period: 1, periodUnit: "d" } },
            doseAndRate: [{ doseQuantity: { value: 5, unit: "mg", system: "http://unitsofmeasure.org", code: "mg" } }],
          },
        ],
      },
    },
    {
      fullUrl: urn(5),
      resource: {
        resourceType: "MedicationRequest",
        status: "active",
        intent: "order",
        medicationCodeableConcept: { text: "Metformin" },
        dosageInstruction: [{ timing: { code: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation", code: "QD" }] } }, doseAndRate: [{ doseQuantity: { value: 500, unit: "mg", system: "http://unitsofmeasure.org", code: "mg" } }] }],
      },
    },
    {
      fullUrl: urn(6),
      resource: {
        resourceType: "Observation",
        status: "final",
        code: { coding: [{ system: "http://loinc.org", code: "8310-5", display: "Body temperature" }] },
        valueQuantity: { value: 38.5, unit: "°C", system: "http://unitsofmeasure.org", code: "Cel" },
        note: [{ text: "體重 65 kg" }],
      },
    },
  ],
};

const fact = (item: string, attribute: string, value: string, quote: string): Fact => ({ item, attribute, value, quote });

async function run(facts: Fact[], deps = {}) {
  return checkFactCoverage({ bundle: BUNDLE, source_text: RECORD, facts }, deps);
}

test("quote must be a substring of the record (whitespace / full-width normalised)", async () => {
  assert.ok(findQuote(RECORD, "Amlodipine  5 mg"));
  assert.ok(findQuote(RECORD, "ＨｂＡ１ｃ"));
  const r = await run([fact("用藥", "劑量", "10 mg", "Amlodipine 10 mg")]);
  assert.equal(r.facts[0].status, "quote_not_in_record");
  assert.equal(r.facts[0].reason_code, "quote-not-in-record");
  assert.equal(r.summary.complete, false);
});

test("route PO is covered by SNOMED 26643006", async () => {
  const r = await run([fact("用藥 Amlodipine", "途徑", "PO", "PO BID")]);
  assert.equal(r.facts[0].status, "covered", r.facts[0].reason);
  assert.ok(r.facts[0].found_at!.some((f) => f.pointer === "/entry/3/resource/dosageInstruction/0/route/coding/0" && f.how === "route code"));
});

test("frequency BID is covered by Timing.repeat frequency 2 / period 1 d; QD by timing.code", async () => {
  const r = await run([fact("用藥 Amlodipine", "頻次", "BID", "PO BID"), fact("用藥 Metformin", "頻次", "QD", "PO QD")]);
  assert.equal(r.facts[0].status, "covered");
  assert.ok(r.facts[0].found_at!.some((f) => f.path === "MedicationRequest.dosageInstruction.timing" && f.how === "timing repeat"));
  assert.equal(r.facts[1].status, "covered");
  assert.ok(r.facts[1].found_at!.some((f) => f.how === "timing code"));
});

test("ROC date is covered by the ISO date", async () => {
  const r = await run([fact("就診", "日期", "114/06/02", "門診日期：114/06/02")]);
  assert.equal(r.facts[0].status, "covered");
  assert.equal(r.facts[0].found_at![0].pointer, "/entry/1/resource/period/start");
  assert.equal(r.facts[0].found_at![0].path, "Encounter.period.start");
});

test("unit conversion: 0.5 g is covered by 500 mg; 38.5°C by 38.5 Cel", async () => {
  const r = await run([fact("用藥 Metformin", "劑量", "0.5 g", "Metformin 0.5 g"), fact("體溫", "數值", "38.5°C", "體溫 38.5°C")]);
  assert.equal(r.facts[0].status, "covered", r.facts[0].reason);
  assert.match(r.facts[0].found_at![0].how, /unit conversion/);
  assert.equal(r.facts[1].status, "covered");
});

test("codes: by code, by display, by terminology synonym; the text of an uncoded concept and narrative do not count", async () => {
  const terminology: TerminologyNames = {
    version: () => "test",
    lookup: async (keys) => new Map(keys.filter((k) => k === "http://hl7.org/fhir/sid/icd-10-cm|I10").map((k) => [k, { found: true, names: ["Essential hypertension", "原發性高血壓"] }])),
  };
  const byCode = await run([fact("診斷", "代碼", "I10", "高血壓")]);
  assert.equal(byCode.facts[0].status, "covered");
  assert.equal(byCode.facts[0].found_at![0].how, "code");
  // v20.1: CodeableConcept.text of a coded concept (I10 + text 高血壓) is the record wording of that concept
  const codedText = await run([fact("診斷", "名稱", "高血壓", "高血壓")]);
  assert.equal(codedText.facts[0].status, "covered");
  assert.ok(codedText.facts[0].found_at!.some((f) => f.how === "coded concept text" && f.path === "Condition.code.text"));
  // an uncoded concept's text (medicationCodeableConcept {text: Metformin}) is free text
  const uncoded = await run([fact("用藥", "藥名", "Metformin", "Metformin 0.5 g")]);
  assert.equal(uncoded.facts[0].status, "missing", "text of an uncoded CodeableConcept is not structured");
  const withNames = await run([fact("診斷", "名稱", "原發性高血壓", "高血壓")], { terminology });
  assert.equal(withNames.facts[0].status, "covered");
  assert.equal(withNames.facts[0].found_at![0].how, "coding display / terminology name");
  const byDisplay = await run([fact("檢驗", "項目", "body temperature", "體溫")]);
  assert.equal(byDisplay.facts[0].status, "covered");
});

test("identifier verbatim; a value only in a note is missing", async () => {
  const r = await run([fact("病人", "身分證字號", "A123456789", "A123456789"), fact("體重", "數值", "65 kg", "體重 65 kg")]);
  assert.equal(r.facts[0].status, "covered");
  assert.equal(r.facts[1].status, "missing", "Observation.note is free text");
});

test("not usable: negated, rule-out, old value, pending", async () => {
  const r = await run([
    fact("過敏", "藥物過敏", "藥物過敏", "藥物過敏"),
    fact("診斷", "名稱", "糖尿病", "糖尿病"),
    fact("體重", "數值", "63 kg", "63 kg"),
    fact("檢驗 HbA1c", "數值", "HbA1c", "HbA1c"),
  ]);
  assert.deepEqual(r.facts.map((x) => x.status), ["not_usable", "not_usable", "not_usable", "not_usable"]);
  assert.ok(r.facts[0].markers!.some((m) => m.cls === "negated"));
  assert.ok(r.facts[1].markers!.some((m) => m.cls === "unconfirmed"));
  assert.ok(r.facts[2].markers!.some((m) => m.cls === "stale"));
  assert.ok(r.facts[3].markers!.some((m) => m.cls === "pending"));
  assert.equal(r.summary.not_usable, 4);
  assert.equal(r.summary.coverage, null);
});

test("a marker the fact itself states keeps the fact usable; an enumerated item is not governed by another item's cue", async () => {
  const hit = findQuote(RECORD, "否認藥物過敏")!;
  assert.deepEqual(clauseMarkers(RECORD, hit, "無", "藥物過敏").markers, []);
  const htn = findQuote(RECORD, "高血壓")!;
  assert.deepEqual(clauseMarkers(RECORD, htn, "高血壓", "診斷").markers, []);
  const w = findQuote(RECORD, "體重 65 kg")!;
  assert.deepEqual(clauseMarkers(RECORD, w, "65 kg", "體重").markers, [], "前次 is in the bracket, not the clause of 65 kg");
});

test("value only in another resource type → missing / found-in-other-resource", async () => {
  // 38.5 is an Observation value; claimed as a medication dose it is in the wrong resource
  const r = await run([fact("用藥", "劑量", "38.5", "38.5")]);
  assert.equal(r.facts[0].status, "missing");
  assert.equal(r.facts[0].reason_code, "found-in-other-resource");
  assert.equal(r.facts[0].found_elsewhere![0].path, "Observation.valueQuantity");
});

test("suggested paths come from the entry profile's authoring fields", async () => {
  const fields: FieldSpec[] = [
    { field: "status", required: true, kind: "code", multiple: false, source: "default" },
    { field: "intent", required: true, kind: "code", multiple: false, source: "fixed", auto: true },
    {
      field: "dosageInstruction",
      required: false,
      kind: "dosage",
      multiple: true,
      source: "record",
      children: [
        { field: "route", required: false, kind: "codeableConcept", multiple: false, source: "record" },
        { field: "timing", required: false, kind: "other", multiple: false, source: "record" },
      ],
    },
    { field: "dispenseRequest", required: false, kind: "other", multiple: false, source: "record", children: [{ field: "expectedSupplyDuration", required: false, kind: "quantity", multiple: false, source: "record" }] },
  ];
  const seen: string[] = [];
  const r = await run([fact("用藥 Amlodipine", "天數", "28 天", "x 28 天")], {
    fields: async (p: string) => {
      seen.push(p);
      return fields;
    },
  });
  assert.equal(r.facts[0].status, "missing");
  assert.equal(r.facts[0].suggested_paths![0], "MedicationRequest.dispenseRequest.expectedSupplyDuration");
  assert.deepEqual(seen, ["https://example.org/StructureDefinition/MedicationRequest-x"]);
  // no entry of the type: base element names
  const allergy = await run([fact("過敏", "反應", "皮疹", "藥物過敏")]);
  assert.equal(allergy.facts[0].status, "not_usable");
});

test("no entry of the fact's type: suggested base paths and a reason naming the type", async () => {
  const bundle = { resourceType: "Bundle", type: "collection", entry: [BUNDLE.entry[2]] };
  const r = await checkFactCoverage({ bundle, source_text: RECORD, facts: [fact("體溫", "數值", "38.5°C", "體溫 38.5°C")] });
  assert.equal(r.facts[0].status, "missing");
  assert.match(r.facts[0].reason, /no Observation \/ DiagnosticReport entry/);
  assert.ok(r.facts[0].suggested_paths!.some((p) => p.startsWith("Observation.value")));
});

test("summary counts and coverage", async () => {
  const r = await run([fact("用藥 Amlodipine", "途徑", "PO", "PO BID"), fact("體重", "數值", "65 kg", "體重 65 kg"), fact("x", "y", "z", "not in record")]);
  assert.deepEqual(r.summary, { total: 3, covered: 1, missing: 1, quote_not_in_record: 1, not_usable: 0, coverage: 0.333, complete: false });
});
