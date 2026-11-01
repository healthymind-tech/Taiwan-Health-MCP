// ISSUES_v20.1 item 4: fact-coverage agreement fixes (synthetic record / Bundle — no real patient data).
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkFactCoverage, type Fact } from "./coverage.js";
import { attributeClass } from "./infer.js";
import { unitOnly } from "./match.js";
import type { FieldSpec } from "../authoring/types.js";

const RECORD = [
  "ID No.: Q100000001　Chart No.: CH0001",
  "主治醫師：王小明　電話：(02)2345-6789",
  "地址：台北市測試路 1 號",
  "Lot No. LT-778 疫苗接種",
  "PR 82 次/分，BT 36.8 度，Glucose 105 mg/dL",
  "Anti-HBs 12.5 IU/mL",
  "處方疑義：無　Metformin 500 mg 1 tab PO BID",
  "Dx: Type 2 diabetes mellitus without complications",
  "Impression: 竇性心律，無 ST 變化",
  "無發燒",
  "Dx2: r/o 肺炎",
  "胸痛 尚未確立",
  "HbA1c：待補",
  "Aspirin 1 tab QD",
  "Ferritin 5.6",
].join("\n");

const urn = (n: number): string => `urn:uuid:00000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;
const ucum = "http://unitsofmeasure.org";

const BUNDLE = {
  resourceType: "Bundle",
  type: "collection",
  entry: [
    {
      fullUrl: urn(1),
      resource: {
        resourceType: "Patient",
        identifier: [
          { system: "http://example.org/national-id", value: "Q100000001" },
          { system: "http://example.org/mrn", value: "CH0001" },
        ],
        address: [{ text: "台北市測試路 1 號" }],
      },
    },
    {
      fullUrl: urn(2),
      resource: {
        resourceType: "Practitioner",
        meta: { profile: ["https://example.org/StructureDefinition/Practitioner-x"] },
        name: [{ use: "official", text: "王小明" }],
        telecom: [{ system: "phone", value: "02-2345-6789" }],
      },
    },
    {
      fullUrl: urn(3),
      resource: {
        resourceType: "Observation",
        status: "final",
        code: { coding: [{ system: "http://loinc.org", code: "8867-4", display: "Heart rate" }] },
        valueQuantity: { value: 82, unit: "beats/minute", system: ucum, code: "/min" },
      },
    },
    {
      fullUrl: urn(4),
      resource: {
        resourceType: "Observation",
        status: "final",
        code: { coding: [{ system: "http://loinc.org", code: "2345-7", display: "Glucose" }] },
        valueQuantity: { value: 105, unit: "mg/dL", system: ucum, code: "mg/dL" },
      },
    },
    {
      fullUrl: urn(5),
      resource: {
        resourceType: "Observation",
        status: "final",
        code: { coding: [{ system: "http://loinc.org", code: "5193-8", display: "Hepatitis B virus surface Ab" }] },
        valueQuantity: { value: 12.5, unit: "IU/mL", system: ucum, code: "[IU]/mL" },
      },
    },
    {
      fullUrl: urn(6),
      resource: {
        resourceType: "DiagnosticReport",
        status: "final",
        code: { coding: [{ system: "http://loinc.org", code: "11524-6", display: "EKG study" }] },
        conclusion: "竇性心律，無 ST 變化",
      },
    },
    {
      fullUrl: urn(7),
      resource: {
        resourceType: "MedicationRequest",
        status: "active",
        intent: "order",
        medicationCodeableConcept: { coding: [{ system: "http://example.org/drug", code: "D1", display: "Aspirin" }] },
        dosageInstruction: [{ sequence: 1, timing: { code: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation", code: "QD" }] } } }],
      },
    },
    {
      fullUrl: urn(8),
      resource: {
        resourceType: "Condition",
        code: { coding: [{ system: "http://hl7.org/fhir/sid/icd-10-cm", code: "E11.9", display: "Type 2 diabetes mellitus without complications" }] },
      },
    },
    {
      fullUrl: urn(9),
      resource: {
        resourceType: "Observation",
        status: "final",
        code: { coding: [{ system: "http://loinc.org", code: "2276-4", display: "Ferritin" }] },
        referenceRange: [{ high: { value: 5.6, unit: "ng/mL" } }],
      },
    },
  ],
};

const fact = (item: string, attribute: string, value: string, quote: string, resource_type?: string): Fact => ({ item, attribute, value, quote, ...(resource_type ? { resource_type } : {}) });
const run = (facts: Fact[], deps = {}) => checkFactCoverage({ bundle: BUNDLE, source_text: RECORD, facts }, deps);

test("HumanName.text / Address.text, DiagnosticReport.conclusion and ContactPoint.value are structured", async () => {
  const r = await run([
    fact("醫師", "姓名", "王小明", "主治醫師：王小明"),
    fact("病人", "地址", "台北市測試路 1 號", "地址：台北市測試路 1 號"),
    fact("心電圖報告", "結論", "竇性心律，無 ST 變化", "竇性心律，無 ST 變化", "DiagnosticReport"),
    fact("醫師", "電話", "(02)2345-6789", "電話：(02)2345-6789"),
  ]);
  assert.deepEqual(r.facts.map((f) => f.status), ["covered", "covered", "covered", "covered"], JSON.stringify(r.facts.map((f) => [f.status, f.reason, f.markers])));
  assert.equal(r.facts[0].found_at![0].path, "Practitioner.name.text");
  assert.equal(r.facts[1].found_at![0].path, "Patient.address.text");
  assert.equal(r.facts[2].found_at![0].path, "DiagnosticReport.conclusion");
  assert.equal(r.facts[3].found_at![0].how, "telecom (digits)");
});

test("suggested paths join a child field relative to the resource (Practitioner.name.text, never name.name.text)", async () => {
  const bundle = { resourceType: "Bundle", type: "collection", entry: [{ fullUrl: urn(1), resource: { resourceType: "Practitioner", meta: { profile: ["https://example.org/StructureDefinition/Practitioner-x"] } } }] };
  const fields: FieldSpec[] = [
    { field: "identifier", required: false, kind: "identifier", multiple: true, source: "record" },
    { field: "name", required: true, kind: "humanName", multiple: true, source: "record", children: [{ field: "name.text", required: false, kind: "string", multiple: false, source: "record" }] },
  ];
  const r = await checkFactCoverage({ bundle, source_text: RECORD, facts: [fact("醫師", "姓名", "王小明", "主治醫師：王小明")] }, { fields: async () => fields });
  assert.equal(r.facts[0].status, "missing");
  assert.ok(r.facts[0].suggested_paths!.includes("Practitioner.name.text"), JSON.stringify(r.facts[0].suggested_paths));
  assert.ok(!r.facts[0].suggested_paths!.some((p) => p.includes("name.name")));
});

test("units: value and unit compared separately; record spellings vs UCUM code and human unit", async () => {
  const r = await run([
    fact("心跳", "數值", "82 次/分", "PR 82 次/分"),
    fact("心跳", "數值", "82/min", "PR 82 次/分"),
    fact("血糖", "單位", "mg/dL", "Glucose 105 mg/dL"),
    fact("Anti-HBs", "數值", "12.5 IU/mL", "Anti-HBs 12.5 IU/mL"),
    fact("Anti-HBs", "單位", "IU/mL", "Anti-HBs 12.5 IU/mL"),
  ]);
  assert.deepEqual(r.facts.map((f) => f.status), ["covered", "covered", "covered", "covered", "covered"], JSON.stringify(r.facts.map((f) => f.reason)));
  assert.equal(r.facts[2].found_at![0].how, "quantity unit");
  assert.equal(unitOnly("次/分"), "/min");
  assert.equal(unitOnly("高血壓"), null);
  assert.equal(unitOnly("5 mg"), null);
});

test("not_usable: 'No.' is a number abbreviation, 疑 in a field label is no cue, a label separates a cue from the value", async () => {
  const r = await run([
    fact("病人", "身分證", "Q100000001", "ID No.: Q100000001"),
    fact("病人", "病歷號", "CH0001", "Chart No.: CH0001"),
    fact("用藥 Metformin", "劑量", "500 mg", "處方疑義：無　Metformin 500 mg"),
    fact("診斷", "代碼", "E11.9", "Type 2 diabetes mellitus without complications"),
    fact("心電圖報告", "結論", "竇性心律", "竇性心律，無 ST 變化", "DiagnosticReport"),
  ]);
  for (const f of r.facts) assert.notEqual(f.status, "not_usable", `${f.index}: ${JSON.stringify(f.markers)}`);
  assert.deepEqual(r.facts.map((f) => f.status).slice(0, 4), ["covered", "covered", "missing", "covered"]);
});

test("not_usable: real negation / uncertainty / pending cues that govern the value are still detected", async () => {
  const r = await run([
    fact("症狀", "名稱", "發燒", "無發燒"),
    fact("診斷", "名稱", "肺炎", "r/o 肺炎"),
    fact("診斷", "名稱", "胸痛", "胸痛 尚未確立"),
    fact("檢驗 HbA1c", "數值", "HbA1c", "HbA1c：待補"),
    fact("診斷", "代碼", "J18.9", "r/o 肺炎"),
  ]);
  assert.deepEqual(r.facts.map((f) => f.status), ["not_usable", "not_usable", "not_usable", "not_usable", "not_usable"], JSON.stringify(r.facts.map((f) => f.markers)));
  assert.equal(r.facts[0].markers![0].cls, "negated");
  assert.equal(r.facts[1].markers![0].cls, "unconfirmed");
  assert.equal(r.facts[2].markers![0].cls, "unconfirmed");
  assert.equal(r.facts[3].markers![0].cls, "pending");
});

test("numbers only in elements of the attribute's class: dose 1 never matches Dosage.sequence 1; a reference range is not the value", async () => {
  const r = await run([fact("用藥 Aspirin", "劑量", "1", "Aspirin 1 tab"), fact("Ferritin", "數值", "5.6", "Ferritin 5.6")]);
  assert.equal(r.facts[0].status, "missing", JSON.stringify(r.facts[0].found_at));
  assert.equal(r.facts[1].status, "missing", JSON.stringify(r.facts[1].found_at));
  assert.equal(r.facts[1].reason_code, "found-in-other-element");
  assert.equal(r.facts[1].found_elsewhere![0].path, "Observation.referenceRange.high");
  // with a dose quantity the same fact is covered
  const withDose = structuredClone(BUNDLE) as any;
  withDose.entry[6].resource.dosageInstruction[0].doseAndRate = [{ doseQuantity: { value: 1, unit: "tab", system: ucum, code: "{tbl}" } }];
  const c = await checkFactCoverage({ bundle: withDose, source_text: RECORD, facts: [fact("用藥 Aspirin", "劑量", "1", "Aspirin 1 tab")] });
  assert.equal(c.facts[0].status, "covered");
  assert.match(c.facts[0].found_at![0].path, /doseAndRate\.doseQuantity$/u);
});

test("attributeClass: FHIR element names are exact, Chinese attribute words map to their element family", () => {
  const dose = attributeClass("劑量")!;
  assert.ok(dose("MedicationRequest.dosageInstruction.doseAndRate.doseQuantity"));
  assert.ok(!dose("MedicationRequest.dosageInstruction.sequence"));
  const start = attributeClass("start")!;
  assert.ok(start("Encounter.period.start"));
  assert.ok(!start("Encounter.period.end"));
  const st = attributeClass("serviceType", "Encounter")!;
  assert.ok(st("Encounter.serviceType.coding"));
  assert.ok(!st("Encounter.class"), "serviceType is not `type`");
  assert.equal(attributeClass("顏色", "其他"), null);
});
