/**
 * ISSUES_v20: R2 code meaning (code-meaning-mismatch), R3 identifiers verbatim (identifier-truncated), R6 false positives
 * (abbreviation labels, ROC date ranges, medication stop vs allergy) — synthetic data only, no DB.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { checkGroundingSync } from "../grounding/checkGrounding.js";
import { abbreviationMatch } from "../grounding/abbreviations.js";
import { parseDates } from "../grounding/lexicon.js";
import { abbreviationTokens } from "../grounding/terminologyNames.js";
import { labelBefore, meaningKey, meaningTargets } from "./codeMeaning.js";
import { identifierInRecord } from "./identifierVerbatim.js";
import { runRecordChecks } from "./index.js";

type Json = Record<string, any>;
const P = "urn:uuid:7c1e0d52-0000-4000-8000-000000000001";
const LOINC = "http://loinc.org";
const SRC = `姓名：王小明，男，1960/01/02 出生
醫師：陳大文 醫字第035190號
就診日期：114/06/02
PEFR 410 L/min
Allergy: Penicillin（皮疹），已停藥
處方期間 114/06/02–115/08/31`;

function bundle(...resources: Json[]): Json {
  return {
    resourceType: "Bundle",
    type: "collection",
    entry: [
      { fullUrl: P, resource: { resourceType: "Patient", name: [{ text: "王小明" }], gender: "male", birthDate: "1960-01-02" } },
      ...resources.map((r, i) => ({ fullUrl: `urn:uuid:7c1e0d52-0000-4000-8000-00000000010${i}`, resource: r })),
    ],
  };
}
const practitioner = (value: string, extra: Json = {}): Json => ({ resourceType: "Practitioner", identifier: [{ system: "https://example.org/license", value }], name: [{ text: "陳大文" }], ...extra });
const obs = (code: string, display: string): Json => ({
  resourceType: "Observation",
  status: "final",
  code: { coding: [{ system: LOINC, code, display }] },
  subject: { reference: P },
  effectiveDateTime: "2025-06-02",
  valueQuantity: { value: 410, unit: "L/min", system: "http://unitsofmeasure.org", code: "L/min" },
});
const codes = (b: Json, src: string | null, opts: Json = {}): string[] => runRecordChecks(b, { sourceText: src, ...opts }).issues.filter((i) => i.rule !== "R6").map((i) => `${i.severity}:${i.code}`);

const PEF_NAMES = ["Maximum expiratory gas flow Respiratory system airway by Peak flow meter", "PEF Airway PFM", "Expiratory gas flow.max"];
const GLU_NAMES = ["Glucose [Mass/volume] in Serum or Plasma", "Glucose SerPl-mCnc", "Glucose", "血糖"];
const ABBR = new Map<string, string[]>([["pefr", ["Peak expiratory flow rate"]], ["pef", ["Peak expiratory flow rate", "pulmonary edema fluid"]]]);

// ------------------------------------------------------------------------------------------------ R3 identifiers verbatim

test("R3: a value cut out of 醫字第035190號 is identifier-truncated (error) with the full record fragment as replace_value", () => {
  const r = runRecordChecks(bundle(practitioner("035190")), { sourceText: SRC });
  const i = r.issues.find((x) => x.code === "identifier-truncated");
  assert.ok(i, JSON.stringify(r.issues.map((x) => x.code)));
  assert.equal(i!.severity, "error");
  assert.equal(i!.path, "Bundle.entry[1].resource.identifier[0].value");
  assert.equal(i!.suggestions?.[0].value, "醫字第035190號");
  assert.equal(i!.suggestions?.[0].kind, "replace_value");
});

test("R3: the whole identifier, a labelled number, and undecidable neighbours give no finding", () => {
  assert.ok(!codes(bundle(practitioner("醫字第035190號")), SRC).includes("error:identifier-truncated"));
  // a field label is not part of the identifier
  assert.deepEqual(identifierInRecord("12345678", "病歷號12345678，就診"), { complete: true, truncatedFrom: null });
  assert.deepEqual(identifierInRecord("12345678", "病歷號碼：12345678"), { complete: true, truncatedFrom: null });
  assert.deepEqual(identifierInRecord("112", "床號 112號"), { complete: true, truncatedFrom: null });
  // a CJK word right after the value (身分證A123456789男) cannot be decided
  assert.deepEqual(identifierInRecord("A123456789", "身分證A123456789男60歲"), { complete: true, truncatedFrom: null });
  // a fragment of a date / phone number on a line without an identifier label is no identifier
  assert.deepEqual(identifierInRecord("0602", "就診 2025-0602-1"), { complete: true, truncatedFrom: null });
  // Latin / digit extensions are
  assert.equal(identifierInRecord("035190", "證號：A035190")?.truncatedFrom?.fragment, "A035190");
  assert.equal(identifierInRecord("1234", "MRN 1234-5")?.truncatedFrom?.fragment, "1234-5");
  // not in the record: not this rule's business (R5 value grounding reports it)
  assert.equal(identifierInRecord("999999", SRC), null);
});

test("R3: a profile that restricts the value to digits accepts the digit part", () => {
  const p = practitioner("035190", { meta: { profile: ["https://example.org/StructureDefinition/prac"] } });
  const rules = [{ profile: "https://example.org/StructureDefinition/prac", resourceType: "Practitioner", system: "https://example.org/license", digitsOnly: true }];
  assert.ok(!codes(bundle(p), SRC, { identifierRules: rules }).includes("error:identifier-truncated"));
  // another system's digits-only rule does not apply
  const other = [{ ...rules[0], system: "https://example.org/other" }];
  assert.ok(codes(bundle(p), SRC, { identifierRules: other }).includes("error:identifier-truncated"));
});

test("R3: no source_text → no identifier-truncated (pure validation unchanged)", () => {
  assert.ok(!codes(bundle(practitioner("035190")), null).some((c) => c.endsWith("identifier-truncated")));
});

// ------------------------------------------------------------------------------------------------ R2 code meaning

test("R2: a LOINC code of another test than the record's label → code-meaning-mismatch with normalize candidates", () => {
  const b = bundle(obs("2345-7", "Glucose [Mass/volume] in Serum or Plasma"));
  const codeNames = new Map([[`${LOINC}|2345-7`, GLU_NAMES]]);
  const t = meaningTargets(b, SRC, null, codeNames, null, ABBR);
  assert.equal(t.length, 1);
  assert.equal(t[0].phrase, "PEFR");
  const cands = new Map([[meaningKey(t[0].path, t[0].phrase), [{ system: LOINC, code: "19935-6", display: "PEF Airway PFM" }]]]);
  const r = runRecordChecks(b, { sourceText: SRC, codeNames, abbreviations: ABBR, meaningCandidates: cands });
  const i = r.issues.find((x) => x.code === "code-meaning-mismatch");
  assert.ok(i);
  assert.equal(i!.severity, "error");
  assert.equal(i!.rule, "R7");
  assert.equal(i!.record_phrase, "PEFR");
  assert.equal(i!.code_display, GLU_NAMES[0]);
  assert.equal(i!.suggestions?.[0].value, "19935-6");
  assert.equal(i!.suggestions?.[0].kind, "replace_code");
});

test("R2: never without confirmation — right code, abbreviation label, no candidates, candidates with this code, unknown abbreviation", () => {
  // the right code: the label PEFR and the LOINC short name PEF share a thesaurus expansion
  const right = bundle(obs("19935-6", PEF_NAMES[0]));
  assert.equal(meaningTargets(right, SRC, null, new Map([[`${LOINC}|19935-6`, PEF_NAMES]]), null, ABBR).length, 0);
  // a wrong code but no candidates (no normalize hook) → no finding
  const wrong = bundle(obs("2345-7", GLU_NAMES[0]));
  const codeNames = new Map([[`${LOINC}|2345-7`, GLU_NAMES]]);
  assert.ok(!codes(wrong, SRC, { codeNames, abbreviations: ABBR }).includes("error:code-meaning-mismatch"));
  // the normalizer returns this very code for the phrase → no finding
  const t = meaningTargets(wrong, SRC, null, codeNames, null, ABBR);
  const withOwn = new Map([[meaningKey(t[0].path, t[0].phrase), [{ system: LOINC, code: "19935-6", display: "PEF Airway PFM" }, { system: LOINC, code: "2345-7", display: "Glucose" }]]]);
  assert.ok(!codes(wrong, SRC, { codeNames, abbreviations: ABBR, meaningCandidates: withOwn }).includes("error:code-meaning-mismatch"));
  // candidates that do not name the phrase → no finding
  const unrelated = new Map([[meaningKey(t[0].path, t[0].phrase), [{ system: LOINC, code: "718-7", display: "Hemoglobin [Mass/volume] in Blood" }]]]);
  assert.ok(!codes(wrong, SRC, { codeNames, abbreviations: ABBR, meaningCandidates: unrelated }).includes("error:code-meaning-mismatch"));
  // an abbreviation no table expands cannot be compared
  assert.equal(meaningTargets(wrong, SRC.replace("PEFR", "XQZT"), null, codeNames, null, null).length, 0);
});

test("R2: Chinese record name vs the code's Chinese name; ICD parent / child is never another diagnosis", () => {
  const ICD = "http://hl7.org/fhir/sid/icd-10-cm";
  const src = "診斷：急性闌尾炎\n就診日期：114/06/02";
  const cond = (code: string): Json => bundle({ resourceType: "Condition", code: { coding: [{ system: ICD, code }], text: "急性闌尾炎" }, subject: { reference: P } });
  const names = new Map([
    [`${ICD}|J00`, ["Acute nasopharyngitis [common cold]", "急性鼻咽炎（感冒）"]],
    [`${ICD}|K35.80`, ["Unspecified acute appendicitis", "急性闌尾炎"]],
  ]);
  const wrong = cond("J00");
  const t = meaningTargets(wrong, src, null, names, null, null);
  assert.equal(t.length, 1);
  const cands = new Map([[meaningKey(t[0].path, t[0].phrase), [{ system: ICD, code: "K35.80", display: "急性闌尾炎" }]]]);
  assert.ok(codes(wrong, src, { codeNames: names, meaningCandidates: cands }).includes("error:code-meaning-mismatch"));
  // the right code
  assert.equal(meaningTargets(cond("K35.80"), src, null, names, null, null).length, 0);
  // a candidate that is only a parent / child of the coding is not "another diagnosis"
  const parentOnly = new Map([[meaningKey(t[0].path, t[0].phrase), [{ system: ICD, code: "J00.0", display: "急性闌尾炎" }]]]);
  assert.ok(!codes(wrong, src, { codeNames: names, meaningCandidates: parentOnly }).includes("error:code-meaning-mismatch"));
});

test("R2: the label before a value", () => {
  assert.equal(labelBefore("Hb "), "Hb");
  assert.equal(labelBefore("血液檢查：血糖 "), "血糖");
  assert.equal(labelBefore("BP 120/80 HR "), "HR");
  assert.equal(labelBefore("檢驗：Oxygen saturation in Arterial blood by Pulse oximetry "), "Oxygen saturation in Arterial blood by Pulse oximetry");
  assert.equal(labelBefore("Cigarette pack-years (observable entity) "), "Cigarette pack-years");
  assert.equal(labelBefore("12 "), null);
});

// ------------------------------------------------------------------------------------------------ R6 false positives

test("R6: abbreviation equivalence through the thesaurus (PEFR ~ PEF), never between unrelated abbreviations", () => {
  assert.ok(abbreviationMatch("PEFR 410 L/min", "PEF Airway PFM", ABBR));
  assert.equal(abbreviationMatch("PEFR 410 L/min", "Glucose SerPl-mCnc", ABBR), null);
  assert.equal(abbreviationMatch("PEFR 410 L/min", "PEF Airway PFM", null), null);
  assert.deepEqual(abbreviationTokens(["PEFR 410 L/min，Hb 10.2，hemoglobin"]), ["pefr", "l", "min", "hb"].filter((t) => t.length >= 2));
});

test("R6 G-CONTEXT-LABEL: 「PEFR 410 L/min」 labels a peak-flow Observation once the abbreviations are known", () => {
  const b = bundle(obs("19935-6", PEF_NAMES[0]));
  const terms = new Map([[`${LOINC}|19935-6`, { found: true, names: PEF_NAMES }]]);
  const label = (abbreviations: Map<string, string[]> | null): string[] =>
    checkGroundingSync({ bundle: b, source_text: SRC } as any, terms, { abbreviations })
      .entries.flatMap((e) => e.issues)
      .filter((i) => i.rule === "G-CONTEXT-LABEL")
      .map((i) => i.path);
  assert.deepEqual(label(null), ["Bundle.entry[1].resource.valueQuantity"]); // literal matching: as before
  assert.deepEqual(label(ABBR), []);
  // a wrong analyte stays a context error even with the abbreviations
  const glu = bundle(obs("2345-7", GLU_NAMES[0]));
  const gterms = new Map([[`${LOINC}|2345-7`, { found: true, names: GLU_NAMES }]]);
  const errs = checkGroundingSync({ bundle: glu, source_text: SRC } as any, gterms, { abbreviations: ABBR }).entries.flatMap((e) => e.issues).filter((i) => i.rule === "G-CONTEXT-LABEL");
  assert.equal(errs.length, 1);
});

test("R6 ROC date ranges: both ends of 114/06/02–115/08/31 (– - ~ 至 到, with times)", () => {
  const both = [["day", [2025, 6, 2]], ["day", [2026, 8, 31]]];
  for (const s of ["114/06/02–115/08/31", "114/06/02-115/08/31", "114/06/02 ~ 115/08/31", "114/06/02至115/08/31", "114/06/02到115/08/31", "114.06.02 – 115.08.31"]) assert.deepEqual(parseDates(s), both, s);
  assert.deepEqual(parseDates("114/06/02 08:00–115/08/31 17:30"), both);
  const mr = { resourceType: "MedicationRequest", status: "active", intent: "order", subject: { reference: P }, medicationCodeableConcept: { text: "Ventolin" }, dispenseRequest: { validityPeriod: { start: "2025-06-02", end: "2026-08-31" } } };
  const r = runRecordChecks(bundle(mr), { sourceText: SRC });
  assert.ok(!r.issues.some((i) => i.code === "ungrounded-value" && i.path.endsWith("validityPeriod.end")), JSON.stringify(r.issues.map((i) => [i.code, i.path])));
});

test("R6 allergy: 停藥 never suggests clinicalStatus inactive; explicit resolution wording still does", () => {
  const allergy: Json = {
    resourceType: "AllergyIntolerance",
    clinicalStatus: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical", code: "active" }] },
    code: { coding: [{ system: "http://snomed.info/sct", code: "764146007", display: "Penicillin" }], text: "Penicillin" },
    patient: { reference: P },
  };
  const neg = (src: string): string[] => runRecordChecks(bundle(allergy), { sourceText: src }).issues.filter((i) => i.code === "negated-item-present").map((i) => i.path);
  assert.deepEqual(neg(SRC), []);
  assert.deepEqual(neg("Allergy: Penicillin discontinued after rash"), []);
});
