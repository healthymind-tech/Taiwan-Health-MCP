/**
 * Regression tests for the external acceptance report "issues v2" (2026-10-19): an as-needed (PRN) dosage whose
 * Timing carries free text ('as needed', '需要時使用' …) was reported G-UNGROUNDED when the record writes the same
 * meaning in another phrasing ('PO PRN'). Hand-written synthetic records (the reporter's files are not in this repo),
 * each with negative tests proving the fix does not open a hole. Pure: a small static terminology table.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { checkGrounding, type GroundingInput, type GroundingResult } from "./checkGrounding.js";
import { LEXICON_VERSION, statesPrn } from "./lexicon.js";
import { staticTerminologyNames } from "./terminologyNames.js";

const P = "https://twcore.mohw.gov.tw/ig/twcore/StructureDefinition/";
const NHI_FREQ = "https://twcore.mohw.gov.tw/ig/twcore/CodeSystem/medication-frequency-nhi-tw";
const PT_URL = "urn:uuid:00000000-0000-4000-8000-000000000001";
const APAP = "http://snomed.info/sct|322236009";

const terminology = staticTerminologyNames({
  codes: {
    [APAP]: { found: true, names: ["Acetaminophen 500 mg oral tablet", "Product containing precisely paracetamol 500 milligram/1 each conventional release oral tablet (clinical drug)"] },
    "http://snomed.info/sct|26643006": { found: true, names: ["Oral route", "Oral route (qualifier value)"] },
    [`${NHI_FREQ}|PRN`]: { found: true, names: ["需要時使用"] },
    [`${NHI_FREQ}|BID`]: { found: true, names: ["每日二次"] },
  },
});

const record = (medLine: string): string =>
  [
    "家醫科門診紀錄",
    "病人：王大明　男　出生日期：1960/03/02",
    "門診日期：2026-09-20",
    "A：Tension-type headache",
    "P：",
    `1. ${medLine}`,
    "【轉換目標】請將本次開立的藥品轉換為 Patient 與 MedicationRequest",
  ].join("\n");

const bundle = (dosage: Record<string, unknown>): Record<string, unknown> => ({
  resourceType: "Bundle",
  type: "collection",
  meta: { profile: [P + "Bundle-twcore"] },
  entry: [
    {
      fullUrl: PT_URL,
      resource: { resourceType: "Patient", meta: { profile: [P + "Patient-twcore"] }, name: [{ text: "王大明" }], gender: "male", birthDate: "1960-03-02" },
    },
    {
      fullUrl: "urn:uuid:00000000-0000-4000-8000-000000000002",
      resource: {
        resourceType: "MedicationRequest",
        meta: { profile: [P + "MedicationRequest-twcore"] },
        status: "active",
        intent: "order",
        medicationCodeableConcept: { coding: [{ system: "http://snomed.info/sct", code: "322236009" }], text: "Acetaminophen 500 mg" },
        subject: { reference: PT_URL },
        dosageInstruction: [
          {
            route: { coding: [{ system: "http://snomed.info/sct", code: "26643006", display: "Oral route" }] },
            doseAndRate: [{ doseQuantity: { value: 1, unit: "tab", system: "http://unitsofmeasure.org", code: "{tbl}" } }],
            ...dosage,
          },
        ],
      },
    },
  ],
});

async function run(medLine: string, dosage: Record<string, unknown>, extra: Partial<GroundingInput> = {}): Promise<GroundingResult> {
  return checkGrounding({ bundle: bundle(dosage), source_text: record(medLine), verbosity: "all", ...extra } as GroundingInput, { terminology });
}
const errorsAt = (out: GroundingResult, pathTail: string): string[] =>
  out.entries.flatMap((e) => e.issues).filter((i) => i.severity === "error" && i.path.endsWith(pathTail)).map((i) => i.rule);
const allErrors = (out: GroundingResult): string[] =>
  out.entries.flatMap((e) => e.issues).filter((i) => i.severity === "error").map((i) => `${i.rule} ${i.path}`);

const PRN_LINE = "Acetaminophen 500 mg 1 tab PO PRN（頭痛時服用，每日最多 4 次），開 10 錠";

test("issues v2: lexicon version", () => {
  assert.equal(LEXICON_VERSION, "tw-lexicon 0.4.0");
});

test("issues v2: free-text as-needed timing is grounded by a record that writes PRN (auto mode)", async () => {
  for (const text of ["as needed", "As needed for headache", "需要時使用", "必要時", "p.r.n.", "When needed"]) {
    const out = await run(PRN_LINE, { asNeededBoolean: true, timing: { code: { text } } });
    assert.deepStrictEqual(allErrors(out), [], text);
  }
});

test("issues v2: NHI frequency code PRN is grounded by any as-needed phrasing in the record", async () => {
  const timing = { code: { coding: [{ system: NHI_FREQ, code: "PRN" }] } };
  for (const line of [PRN_LINE, "Acetaminophen 500 mg 1 tab PO 視需要服用", "Acetaminophen 500 mg 1 tab PO as needed for pain"]) {
    const out = await run(line, { asNeededBoolean: true, timing });
    assert.deepStrictEqual(errorsAt(out, "timing"), [], line);
    assert.deepStrictEqual(errorsAt(out, "asNeededBoolean"), [], line);
  }
});

test("issues v2: strict mode with the medication line as evidence accepts an as-needed timing text", async () => {
  const evidence_map = [
    { path: "Bundle.entry[1].resource.dosageInstruction[0].timing", quote: PRN_LINE },
    { path: "Bundle.entry[1].resource.dosageInstruction[0].asNeededBoolean", quote: PRN_LINE },
  ];
  const out = await run(PRN_LINE, { asNeededBoolean: true, timing: { code: { text: "as needed" } } }, { evidence_map, mode: "strict" });
  assert.deepStrictEqual(errorsAt(out, "timing"), []);
  assert.deepStrictEqual(errorsAt(out, "asNeededBoolean"), []);
});

test("issues v2 negative: an as-needed timing on a scheduled (BID) order is still not grounded", async () => {
  const line = "Acetaminophen 500 mg 1 tab PO BID，開 14 錠";
  for (const timing of [{ code: { text: "as needed" } }, { code: { coding: [{ system: NHI_FREQ, code: "PRN" }] } }]) {
    const out = await run(line, { timing });
    assert.deepStrictEqual(errorsAt(out, "timing"), ["G-UNGROUNDED"], JSON.stringify(timing));
  }
  // strict: the quoted line does not say as-needed
  const strict = await run(line, { timing: { code: { text: "as needed" } } }, {
    evidence_map: [{ path: "Bundle.entry[1].resource.dosageInstruction[0].timing", quote: line }],
    mode: "strict",
  });
  assert.deepStrictEqual(errorsAt(strict, "timing"), ["G-VALUE-MISMATCH"]);
  // a fabricated asNeededBoolean on the same order stays an error
  const prn = await run(line, { asNeededBoolean: true });
  assert.deepStrictEqual(errorsAt(prn, "asNeededBoolean"), ["G-UNGROUNDED"]);
});

test("issues v2 negative: a frequency written with PRN must match the record", async () => {
  // record states PRN without an interval: 'q4h PRN' adds an interval the record does not state
  const out = await run(PRN_LINE, { asNeededBoolean: true, timing: { code: { text: "q4h PRN" } } });
  assert.deepStrictEqual(errorsAt(out, "timing"), ["G-UNGROUNDED"]);
  // record states 'q6h PRN': q6h PRN is grounded, q4h PRN is not
  const q6 = "Acetaminophen 500 mg 1 tab PO q6h PRN，開 10 錠";
  assert.deepStrictEqual(errorsAt(await run(q6, { asNeededBoolean: true, timing: { code: { text: "q6h PRN" } } }), "timing"), []);
  assert.deepStrictEqual(errorsAt(await run(q6, { asNeededBoolean: true, timing: { code: { text: "q4h PRN" } } }), "timing"), ["G-UNGROUNDED"]);
});

test("issues v2 negative: non-PRN frequency codes without a per-day signature still need their own wording", async () => {
  const out = await run(PRN_LINE, { timing: { code: { text: "1W3D" } } });
  assert.deepStrictEqual(errorsAt(out, "timing"), ["G-UNGROUNDED"]);
});

test("issues v2: PRN lexicon phrasings", () => {
  for (const s of ["1 tab PO PRN", "需要時使用", "必要時服用", "視需要服用", "胸痛發作時舌下含服", "as needed", "as required", "when needed", "on demand", "p.r.n."]) assert.ok(statesPrn(s), s);
  for (const s of ["1 tab PO BID", "每日三次飯後", "sprnkl", "required dose", "demanding", "需要", "if needed, return to clinic"]) assert.ok(!statesPrn(s), s);
});
