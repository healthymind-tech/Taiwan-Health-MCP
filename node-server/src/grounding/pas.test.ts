/**
 * TW PAS (tw.gov.mohw.nhi.pas 1.2.7) grounding tests, reported separately from TW Core.
 *  1. Generated set: the 15 PAS example Bundles (package examples + generated collection/transaction Bundles) with a
 *     synthetic Taiwanese record stating every source fact -> 0 errors; negative variants must be detected.
 *  2. Hand-written record for a compact PAS Bundle -> 0 errors; hand-made negatives -> the expected rule.
 * Terminology: static snapshot of the staging DB names for every PAS coding (__fixtures__/pas_terminology.json).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { checkGrounding, type GroundingResult } from "./checkGrounding.js";
import { evaluatePas, loadPasBundles, pasTerminology } from "./pasEval.js";
import { HAND_RECORDS, handBundle } from "./pasHandRecords.js";

const terminology = pasTerminology();

test("PAS generated set: supported records have no errors; altered / removed / negated / historical facts are detected", async () => {
  const r = await evaluatePas(terminology, 5);
  assert.equal(r.bundles, 15);
  assert.deepStrictEqual(r.supported.errors, [], "false positives on supported PAS records");
  const rate = (k: keyof typeof r.byKind): number => r.byKind[k].detected / Math.max(r.byKind[k].total, 1);
  assert.ok(rate("bundle_value") >= 0.95, `bundle_value ${rate("bundle_value")}`);
  assert.ok(rate("record_negated") >= 0.95, `negated ${rate("record_negated")}`);
  assert.ok(rate("record_historical") >= 0.95, `historical ${rate("record_historical")}`);
  const rm = r.byKind.record_removed;
  const flagged = (rm.detected + (rm.warned ?? 0) + (rm.derived ?? 0)) / rm.total;
  assert.ok(flagged >= 0.9, `removed facts flagged (error/warning/derived) ${flagged}`);
  assert.equal(r.adminTimestamps.detected, 0, "record-keeping timestamps must stay warnings");
});

const H = HAND_RECORDS[0];
const hb = handBundle(loadPasBundles(), H);
const run = (bundle: object, text: string): Promise<GroundingResult> =>
  checkGrounding({ bundle: bundle as any, source_text: text, site_config: H.site, mode: "auto", verbosity: "warnings" }, { terminology });
const errAt = (r: GroundingResult, path: string): string[] =>
  r.entries.flatMap((e) => e.issues).filter((i) => i.severity === "error" && i.path.startsWith(path)).map((i) => i.rule);

test("PAS hand-written record: 0 errors", async () => {
  const out = await run(hb, H.text);
  assert.equal(out.valid, true, JSON.stringify(out.entries.flatMap((e) => e.issues.filter((i) => i.severity === "error"))));
  assert.ok(out.grounding.units_checked > 50);
});

const HAND_NEGATIVES: Array<[string, (t: string) => string, string, string[] | null]> = [
  ["WBC removed from the CBC line", (t) => t.replace("WBC 3.6 x10^3/uL (3.9-10.6)、", ""), "Bundle.entry[5].resource.component[0].valueQuantity", null],
  ["weight changed in the record", (t) => t.replace("體重 59.65 kg", "體重 69.65 kg"), "Bundle.entry[0].resource.supportingInfo[0].valueQuantity", null],
  ["diagnosis only as rule-out", (t) => t.replace("1. 慢性右心臟衰竭", "1. r/o 慢性右心臟衰竭"), "Bundle.entry[0].resource.diagnosis[0].diagnosisCodeableConcept", ["G-CONTEXT-NEGATED"]],
  ["diagnosis only in past history", (t) => t.replace("Dx：\n1. 慢性右心臟衰竭", "PMH：慢性右心臟衰竭"), "Bundle.entry[0].resource.diagnosis[0].diagnosisCodeableConcept", ["G-CONTEXT-SECTION"]],
  ["CBC was a previous result", (t) => t.replace("CBC panel（113/01/01）", "上次 CBC panel（113/01/01）"), "Bundle.entry[5].resource.effectiveDateTime", ["G-CONTEXT-HISTORICAL"]],
  ["frequency changed in the record", (t) => t.replace("75 mg/m2 PO QD AC1H", "75 mg/m2 PO BID AC1H"), "Bundle.entry[6].resource.dosageInstruction[0].timing", null],
  ["Herzuma dose changed in the record", (t) => t.replace("Herzuma Inj. 440mg 200 mg/m2", "Herzuma Inj. 440mg 250 mg/m2"), "Bundle.entry[7].resource.dosageInstruction[0].doseAndRate[0].doseQuantity", null],
  ["national ID missing", (t) => t.replace("身分證字號 A123456789　", ""), "Bundle.entry[2].resource.identifier[0]", null],
  ["requested quantity missing", (t) => t.replace("Alunbrig 52 粒，", "Alunbrig，"), "Bundle.entry[0].resource.item[0].quantity", null],
  ["line of therapy stated as unknown", (t) => t.replace("申請項目二：Herzuma 70 粒，初次使用、第一線治療", "申請項目二：Herzuma 70 粒，初次使用"), "Bundle.entry[0].resource.item[1].modifier[1]", null],
];

for (const [name, edit, path, rules] of HAND_NEGATIVES) {
  test(`PAS hand-written negative: ${name}`, async () => {
    const text = edit(H.text);
    assert.notEqual(text, H.text, "edit did not apply");
    const at = errAt(await run(hb, text), path);
    assert.ok(at.length > 0 && (!rules || at.some((r) => rules.includes(r))), `${path}: got ${JSON.stringify(at)}`);
  });
}

test("PAS hand-written negative: Bundle value altered (claim quantity 52 -> 62)", async () => {
  const b = structuredClone(hb) as any;
  b.entry[0].resource.item[0].quantity.value = 62;
  assert.ok(errAt(await run(b, H.text), "Bundle.entry[0].resource.item[0].quantity").length > 0);
});
