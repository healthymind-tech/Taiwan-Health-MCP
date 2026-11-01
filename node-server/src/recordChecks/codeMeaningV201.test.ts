/**
 * ISSUES_v20.1 item 5 — code meaning (code-meaning-mismatch): fewer false positives (like with like, generic codes)
 * and scale / instrument / timing confusions. Synthetic names and records only, no DB.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { codeMeaningChecks, codeTiming, instrumentTokens, isGenericCode, meaningKey, meaningTargets, recordTiming, type MeaningTarget } from "./codeMeaning.js";
import type { MeaningCandidate } from "./types.js";

type Json = Record<string, any>;
const P = "urn:uuid:3f0c2a10-0000-4000-8000-000000000001";
const LOINC = "http://loinc.org";

function bundle(...resources: Json[]): Json {
  return {
    resourceType: "Bundle",
    type: "collection",
    entry: [
      { fullUrl: P, resource: { resourceType: "Patient", name: [{ text: "測試" }] } },
      ...resources.map((r, i) => ({ fullUrl: `urn:uuid:3f0c2a10-0000-4000-8000-0000000001${String(i).padStart(2, "0")}`, resource: r })),
    ],
  };
}
const obsQ = (code: string, value: number, unit: string, text?: string): Json => ({
  resourceType: "Observation",
  status: "final",
  code: { coding: [{ system: LOINC, code }], ...(text ? { text } : {}) },
  subject: { reference: P },
  valueQuantity: { value, unit },
});
const obsI = (code: string, value: number, text?: string): Json => ({
  resourceType: "Observation",
  status: "final",
  code: { coding: [{ system: LOINC, code }], ...(text ? { text } : {}) },
  subject: { reference: P },
  valueInteger: value,
});

// synthetic terminology names (shaped like LOINC long / short / component names)
const N: Record<string, string[]> = {
  "T-ALT": ["Alanine aminotransferase activity in Serum", "ALT Ser-cCnc", "Alanine aminotransferase"],
  "T-BMI": ["Body mass index (BMI) [Ratio]", "BMI", "Body mass index"],
  "T-GLU": ["Glucose [Mass/volume] in Serum", "Glucose Ser-mCnc", "Glucose"],
  "T-GLU-F": ["Fasting glucose [Mass/volume] in Serum", "Glucose p fast Ser-mCnc", "Glucose^post CFst", "空腹血糖"],
  "T-GLU-PC": ["Glucose [Mass/volume] in Serum --2 hours post meal", "Glucose 2h p meal Ser-mCnc", "Glucose^2H post meal"],
  "T-ECOG": ["ECOG Performance Status score", "ECOG Perform Status score", "Performance status"],
  "T-KPS": ["Karnofsky Performance Status score", "KPS score", "Performance status"],
  "T-NYHA": ["Functional capacity NYHA", "Functional capacity"],
  "T-IMG": ["Diagnostic imaging study", "Diagnostic imaging study"],
  "T-HB": ["Hemoglobin [Mass/volume] in Blood", "Hgb Bld-mCnc", "Hemoglobin"],
};
const names = new Map(Object.entries(N).map(([k, v]) => [`${LOINC}|${k}`, v]));
const C = (code: string): MeaningCandidate => ({ system: LOINC, code, display: N[code][0] });
/** Candidates per target as a stub fhir_normalize_code would return them (lookups.ts asks once per target phrase). */
const candidatesFor = (targets: MeaningTarget[], pick: (t: MeaningTarget) => MeaningCandidate[]): Map<string, MeaningCandidate[]> =>
  new Map(targets.map((t) => [meaningKey(t.path, t.phrase), pick(t)]));
const run = (b: Json, src: string, pick: (t: MeaningTarget) => MeaningCandidate[]): ReturnType<typeof codeMeaningChecks> => {
  const t = meaningTargets(b, src, null, names, null, null);
  return codeMeaningChecks(b, src, null, names, null, null, candidatesFor(t, pick), new Set());
};
const ALL = (): MeaningCandidate[] => Object.keys(N).map(C);

test("v20.1 helpers: generic codes, instrument tokens, timing axes", () => {
  assert.ok(isGenericCode(N["T-IMG"]));
  assert.ok(isGenericCode(["Consult note", "Consult Note"]));
  assert.ok(isGenericCode(["Cancer stage"]));
  assert.ok(!isGenericCode(N["T-GLU"]));
  assert.ok(!isGenericCode(N["T-ECOG"]));
  assert.deepEqual(instrumentTokens("ECOG PS 1, NYHA II, DAS28-ESR, VectraDA, SerPl-mCnc, HbA1c"), ["ECOG", "NYHA", "DAS28", "ESR", "VectraDA"]);
  assert.equal(codeTiming(N["T-GLU-F"]), "fasting");
  assert.equal(codeTiming(N["T-GLU-PC"]), "post-meal");
  assert.equal(codeTiming(N["T-GLU"]), null);
  assert.equal(recordTiming("Glucose AC"), "fasting");
  assert.equal(recordTiming("空腹血糖"), "fasting");
  assert.equal(recordTiming("飯後血糖"), "post-meal");
  assert.equal(recordTiming("Glucose PC"), "post-meal");
  assert.equal(recordTiming("AC joint"), "fasting"); // a cue only ever counts against a code that states another timing
  assert.equal(recordTiming("Glucose"), null);
  assert.equal(recordTiming("Glucose ac"), null, "AC / PC only as upper-case tokens");
});

test("like with like: a value label naming another coding with the same value is never this coding's (ALT vs BMI)", () => {
  // the ALT value sits in 「30/24」 (no label); the only labelled 24 is the BMI's
  const src = "AST/ALT 30/24 U/L\n身高 160 cm，BMI 24";
  const b = bundle(obsQ("T-ALT", 24, "U/L"), obsQ("T-BMI", 24, "kg/m2"));
  assert.deepEqual(run(b, src, ALL), []);
  // without the unlabeled occurrence and without the BMI Observation the label is still another item's → not judged
  const b2 = bundle(obsQ("T-ALT", 24, "U/L"), obsQ("T-BMI", 24, "kg/m2"));
  assert.deepEqual(run(b2, "BMI 24，ALT 24 U/L", ALL), []);
  // the resource's own stated text agrees with the code: value labels are not consulted
  const b3 = bundle(obsQ("T-ALT", 24, "U/L", "ALT"));
  assert.deepEqual(meaningTargets(b3, "ALT 24 U/L；BMI 24", null, names, null, null).filter((t) => t.source === "value-label"), []);
});

test("generic / document codes are never judged by similarity (Diagnostic imaging study for 胸部X光 / Chest CT)", () => {
  const dr = (text: string): Json => ({ resourceType: "DiagnosticReport", status: "final", code: { coding: [{ system: LOINC, code: "T-IMG" }], text }, subject: { reference: P } });
  for (const [text, src] of [["Chest CT", "Chest CT: no mass"], ["胸部X光", "胸部X光：無明顯異常"]]) {
    assert.deepEqual(meaningTargets(bundle(dr(text)), src, null, names, null, null), [], text);
  }
});

test("instrument tier: ECOG coded with a NYHA / Karnofsky code → finding with the ECOG candidate", () => {
  // the model's text names ECOG (not verbatim in the record, the record states 「ECOG：1」)
  const b = bundle(obsI("T-NYHA", 1, "ECOG performance status"));
  const r = run(b, "體能狀態 ECOG：1", ALL);
  assert.equal(r.length, 1);
  assert.equal(r[0].code, "code-meaning-mismatch");
  assert.equal((r[0] as Json).gate, "advisory");
  assert.equal(r[0].suggestions?.[0].value, "T-ECOG");
  assert.match(r[0].message_en, /instrument/u);
  // value label 「ECOG PS 1」 on a Karnofsky code; the normalizer also returns the coded KPS code first — still a finding
  const k = run(bundle(obsQ("T-KPS", 1, "{score}")), "ECOG PS 1，肺腺癌", () => [C("T-KPS"), C("T-ECOG")]);
  assert.deepEqual(k.map((x) => x.suggestions?.[0].value), ["T-ECOG"]);
  // the right code, and a record that names both instruments → nothing
  assert.deepEqual(run(bundle(obsI("T-ECOG", 1, "ECOG")), "ECOG：1", ALL), []);
  assert.deepEqual(run(bundle(obsI("T-NYHA", 1, "ECOG performance status")), "ECOG 1，NYHA 1", ALL), []);
});

test("instrument tier: no candidate naming the record's instrument → no finding (only when a more precise code exists)", () => {
  const b = bundle(obsI("T-NYHA", 1, "ECOG performance status"));
  assert.deepEqual(run(b, "ECOG：1", () => [C("T-KPS"), C("T-NYHA")]), []);
});

test("timing tier: fasting vs post-meal glucose, both directions; the query is the analyte + English cue", () => {
  const pc = bundle(obsQ("T-GLU-PC", 110, "mg/dL"));
  const t = meaningTargets(pc, "Glucose AC 110 mg/dL", null, names, null, null);
  // the timing target first (the most specific); a similarity target of the same phrase may follow
  assert.deepEqual([t[0].tier, t[0].phrase, t[0].recordPhrase], ["timing", "Glucose fasting", "Glucose AC"]);
  const r = run(pc, "Glucose AC 110 mg/dL", ALL);
  assert.deepEqual(r.map((x) => [x.suggestions?.[0].value, x.record_phrase]), [["T-GLU-F", "Glucose AC"]]);
  assert.match(r[0].message_zh, /採檢時機/u);
  assert.deepEqual(run(bundle(obsQ("T-GLU-F", 180, "mg/dL")), "飯後血糖 180 mg/dL", ALL).map((x) => x.suggestions?.[0].value), ["T-GLU-PC"]);
  // the right timing, a code without timing (generic), a record without a cue → nothing
  assert.deepEqual(run(bundle(obsQ("T-GLU-F", 110, "mg/dL")), "空腹血糖 110 mg/dL", ALL), []);
  assert.deepEqual(run(bundle(obsQ("T-GLU", 110, "mg/dL")), "Glucose AC 110 mg/dL", ALL), []);
  assert.deepEqual(run(bundle(obsQ("T-GLU-PC", 110, "mg/dL")), "Glucose 110 mg/dL", ALL), []);
  // candidates of the record's timing are required
  assert.deepEqual(run(pc, "Glucose AC 110 mg/dL", () => [C("T-GLU"), C("T-GLU-PC")]), []);
});

test("unrelated tier still reports a plainly wrong analyte (Hb coded as glucose); a candidate is required", () => {
  const r = run(bundle(obsQ("T-GLU", 10.2, "g/dL")), "Hb 10.2 g/dL", () => [C("T-HB")]);
  assert.deepEqual(r.map((x) => [x.suggestions?.[0].value, x.record_phrase, (x as Json).gate]), [["T-HB", "Hb", "advisory"]]);
  assert.deepEqual(run(bundle(obsQ("T-GLU", 10.2, "g/dL")), "Hb 10.2 g/dL", () => []), []);
});

test("instrument / timing tiers never judge medicines (upper-case brand vs generic names)", () => {
  const NHI = "https://example.org/nhi-drug";
  const drugNames = new Map([[`${NHI}|D2`, ["GLUCOPHAGE TABLETS 500MG"]]]);
  const mr = { resourceType: "MedicationRequest", status: "active", intent: "order", subject: { reference: P }, medicationCodeableConcept: { coding: [{ system: NHI, code: "D2" }], text: "ASPIRIN" } };
  const t = meaningTargets(bundle(mr), "出院帶藥：ASPIRIN 100MG QD", null, drugNames, null, null);
  assert.deepEqual(t.filter((x) => x.tier === "instrument" || x.tier === "timing"), []);
});
