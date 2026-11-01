/**
 * ISSUES_v20.1: content gates (blocking | advisory), the evaluator's false positives, unconfirmed diagnoses written as
 * established codes, generic codes for unnamed items — synthetic data only, no DB.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { abbreviationMatch } from "../grounding/abbreviations.js";
import { checkGroundingSync } from "../grounding/checkGrounding.js";
import { canonUnit, parseDates } from "../grounding/lexicon.js";
import { RecordText } from "../grounding/recordText.js";
import { bundledLexicon, createDbTerminologyNames } from "../grounding/terminologyDb.js";
import { contentGateOf, GROUNDING_GATES, RECORD_GATES, stampValidationGates } from "./contentGates.js";
import { diagnosisSlots } from "./diagnosisSlot.js";
import { addRecordChecksToValidation } from "./envelope.js";
import { runRecordChecks } from "./index.js";

type Json = Record<string, any>;
const P = "urn:uuid:5a1e0d52-0000-4000-8000-000000000001";
const LOINC = "http://loinc.org";
const UCUM = "http://unitsofmeasure.org";
const ICD = "http://hl7.org/fhir/sid/icd-10-cm";
const VER = "http://terminology.hl7.org/CodeSystem/condition-ver-status";

function bundle(...resources: Json[]): Json {
  return {
    resourceType: "Bundle",
    type: "collection",
    entry: [
      { fullUrl: P, resource: { resourceType: "Patient", name: [{ text: "林美華" }], gender: "female", birthDate: "1962-05-06" } },
      ...resources.map((r, i) => ({ fullUrl: `urn:uuid:5a1e0d52-0000-4000-8000-00000000010${i}`, resource: r })),
    ],
  };
}
const obs = (code: string, display: string, value: number, unit: string, ucum: string, text: string): Json => ({
  resourceType: "Observation",
  status: "final",
  code: { coding: [{ system: LOINC, code, display }], text },
  subject: { reference: P },
  effectiveDateTime: "2026-10-20",
  valueQuantity: { value, unit, system: UCUM, code: ucum },
});
const cond = (code: string, display: string, extra: Json = {}): Json => ({
  resourceType: "Condition",
  clinicalStatus: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-clinical", code: "active" }] },
  code: { coding: [{ system: ICD, code, display }] },
  subject: { reference: P },
  ...extra,
});
const rec = (b: Json, src: string, opts: Json = {}): Array<[string, string, string]> => runRecordChecks(b, { sourceText: src, ...opts }).issues.map((i) => [i.severity, i.code, i.path]);

// ------------------------------------------------------------------------------------------------ gates

test("gate registry: value grounding on value paths and unconfirmed-as-confirmed block; heuristics are advisory; warnings never block", () => {
  const e = (x: Json): Json => ({ severity: "error", ...x });
  assert.equal(contentGateOf(e({ source: "grounding", rule: "G-UNGROUNDED", path: "Bundle.entry[1].resource.valueQuantity" })), "blocking");
  assert.equal(contentGateOf(e({ source: "grounding", rule: "G-UNGROUNDED", path: "Bundle.entry[1].resource.effectiveDateTime" })), "blocking");
  assert.equal(contentGateOf(e({ source: "grounding", rule: "G-UNGROUNDED", path: "Bundle.entry[1].resource.code" })), "advisory", "a coded element is a lexical name match");
  assert.equal(contentGateOf(e({ source: "grounding", rule: "G-CONTEXT-LABEL", path: "Bundle.entry[1].resource.valueQuantity" })), "advisory");
  // v20.2 (evaluator decision): semantic → advisory; G-UNGROUNDED blocks only structured numbers / dates / identifiers
  assert.equal(contentGateOf(e({ source: "record-checks", code: "unconfirmed-as-confirmed" })), "advisory");
  assert.equal(contentGateOf(e({ source: "grounding", rule: "G-UNGROUNDED", path: "Bundle.entry[1].resource.valueString" })), "advisory", "free text");
  assert.equal(contentGateOf(e({ source: "grounding", rule: "G-UNGROUNDED", path: "Bundle.entry[1].resource.note[0].text" })), "advisory", "free text");
  assert.equal(contentGateOf(e({ source: "grounding", rule: "G-UNGROUNDED", path: "Bundle.entry[0].resource.identifier[0].value" })), "blocking");
  assert.equal(contentGateOf(e({ source: "grounding", rule: "G-UNGROUNDED", path: "Bundle.entry[2].resource.dosageInstruction[0].doseAndRate[0].doseQuantity.value" })), "blocking");
  for (const c of ["ungrounded-value", "negated-item-present", "code-meaning-mismatch", "stale-value", "information-absent", "generic-code-for-unknown-item"]) {
    assert.equal(contentGateOf(e({ source: "record-checks", code: c })), "advisory", c);
  }
  assert.equal(contentGateOf({ severity: "warning", source: "record-checks", code: "unconfirmed-as-confirmed" }), "advisory");
  assert.equal(contentGateOf({ severity: "error", source: "record-checks", code: "some-future-code" }), "advisory", "unknown rules default to advisory");
  assert.equal(contentGateOf({ severity: "error", message: "validator" }), null, "validator issues carry no gate");
  // every registered rule is either gate
  for (const row of [...Object.values(GROUNDING_GATES), ...Object.values(RECORD_GATES)]) assert.ok(row.gate === "blocking" || row.gate === "advisory");
  const data: Json = { issues: [{ severity: "error", message: "x" }], entries: [{ issues: [{ severity: "error", source: "grounding", rule: "G-CONTEXT-SECTION", path: "a" }] }] };
  stampValidationGates(data);
  assert.equal(data.issues[0].gate, undefined);
  assert.equal(data.entries[0].issues[0].gate, "advisory");
});

test("gate field: stamped on every content issue with source_text; output without source_text unchanged", () => {
  const b = bundle(cond("C34.11", "Malignant neoplasm of upper lobe, right bronchus or lung"));
  const env = JSON.stringify({ ok: true, data: { valid: true, issues: [], entries: b.entry.map(() => ({ valid: true, issues: [] })) } });
  const src = "病人：林美華 女\n主診斷：r/o 右上肺惡性腫瘤（尚未確立）";
  const names = new Map([[`${ICD}|C34.11`, ["Malignant neoplasm of upper lobe, right bronchus or lung", "右上葉肺惡性腫瘤"]]]);
  const out = JSON.parse(addRecordChecksToValidation(env, b, { sourceText: src, codeNames: names }));
  const issues = out.data.entries.flatMap((e: Json) => e.issues);
  assert.ok(issues.length > 0);
  for (const i of issues) assert.ok(i.gate === "blocking" || i.gate === "advisory", JSON.stringify(i));
  const u = issues.find((i: Json) => i.code === "unconfirmed-as-confirmed");
  assert.equal(u?.gate, "advisory");
  assert.equal(u?.severity, "warning", "an advisory finding informs, it does not make the Bundle invalid");
  assert.equal(u?.advisory_from, "error");
  // without source_text: byte-identical
  assert.equal(addRecordChecksToValidation(env, b, {}), env);
});

// ------------------------------------------------------------------------------------------------ item 3: must block

test("item 3: the record's primary diagnosis r/o / 尚未確立 / 疑似 / 待確認, the Bundle an established code → blocking error", () => {
  const names = new Map([[`${ICD}|C34.11`, ["Malignant neoplasm of upper lobe, right bronchus or lung", "右上葉肺惡性腫瘤", "肺癌"]]]);
  const records = [
    "病人：林美華 女 64歲\n主診斷：r/o 右上肺惡性腫瘤（尚未確立，待切片）\n處置：安排支氣管鏡切片",
    "病人：林美華 女 64歲\n【主診斷】\n右上肺腫瘤，疑似肺癌，尚未確立\n【計畫】\nCT guided biopsy",
    "病人：林美華 女 64歲\n診斷：Right upper lobe lung mass, r/o lung cancer\nPlan: bronchoscopy",
    "病人：林美華 女 64歲\n診斷：右上肺肺癌（待確認）",
  ];
  for (const src of records) {
    for (const ver of [null, "confirmed"]) {
      const c = cond("C34.11", "Malignant neoplasm of upper lobe, right bronchus or lung", ver ? { verificationStatus: { coding: [{ system: VER, code: ver }] } } : {});
      // identifiers completed: the finding does not depend on them
      const b = bundle(c);
      b.entry[0].resource.identifier = [{ system: "http://www.moi.gov.tw", value: "A123456789" }];
      const r = runRecordChecks(b, { sourceText: src, codeNames: names });
      const u = r.issues.find((i) => i.code === "unconfirmed-as-confirmed");
      assert.ok(u, `${src.split("\n")[1]} / ${ver}: ${JSON.stringify(r.issues.map((i) => i.code))}`);
      assert.equal(u!.severity, "error");
      assert.equal(contentGateOf(u as unknown as Json), "advisory", "v20.2: semantic → advisory (the evaluator's model verifier decides)");
    }
  }
  // provisional is the right way to write it → nothing
  const prov = bundle(cond("C34.11", "Malignant neoplasm of upper lobe, right bronchus or lung", { verificationStatus: { coding: [{ system: VER, code: "provisional" }] } }));
  assert.ok(!runRecordChecks(prov, { sourceText: records[0], codeNames: names }).issues.some((i) => i.code === "unconfirmed-as-confirmed"));
  // an established primary diagnosis is not reported
  const ok = "病人：林美華 女 64歲\n主診斷：右上肺肺癌（病理證實）";
  assert.ok(!runRecordChecks(bundle(cond("C34.11", "Malignant neoplasm of upper lobe, right bronchus or lung")), { sourceText: ok, codeNames: names }).issues.some((i) => i.code === "unconfirmed-as-confirmed"));
  // 可能 / possible stays a warning (advisory)
  const maybe = runRecordChecks(bundle(cond("C34.11", "Malignant neoplasm of upper lobe, right bronchus or lung")), { sourceText: "病人：林美華 女\n診斷：可能為肺癌", codeNames: names }).issues.find((i) => i.code === "unconfirmed-as-confirmed");
  if (maybe) assert.equal((maybe.advisory_from ?? maybe.severity), "warning");
});

test("item 3: a generic class code (Hormone therapy) for a medicine the record does not name → generic-code-for-unknown-item (advisory)", () => {
  const mr = {
    resourceType: "MedicationStatement",
    status: "completed",
    subject: { reference: P },
    medicationCodeableConcept: { coding: [{ system: "http://snomed.info/sct", code: "169413002", display: "Hormone therapy (procedure)" }] },
  };
  const src = "病人：林美華 女\n過去病史：乳癌術後曾接受荷爾蒙治療五年（藥名不詳）";
  const r = runRecordChecks(bundle(mr), { sourceText: src });
  const g = r.issues.find((i) => i.code === "generic-code-for-unknown-item");
  assert.ok(g, JSON.stringify(r.issues.map((i) => i.code)));
  assert.equal(g!.path, "Bundle.entry[1].resource.medicationCodeableConcept");
  assert.equal(contentGateOf(g as unknown as Json), "advisory");
  // the record names the medicine → no finding
  assert.ok(!runRecordChecks(bundle(mr), { sourceText: "過去病史：乳癌術後 Tamoxifen 荷爾蒙治療五年" }).issues.some((i) => i.code === "generic-code-for-unknown-item"));
  // a specific code → no finding even when another item's name is unknown
  const tam = { ...mr, medicationCodeableConcept: { coding: [{ system: "http://snomed.info/sct", code: "75959001", display: "Tamoxifen" }] } };
  assert.ok(!runRecordChecks(bundle(tam), { sourceText: src }).issues.some((i) => i.code === "generic-code-for-unknown-item"));
});

// ------------------------------------------------------------------------------------------------ false positives

test("FP: PEFR ~ PEF through the bundled LRABR lexicon when the database has no fhir.abbreviation_lexicon", async () => {
  const lex = bundledLexicon();
  assert.ok(lex && lex.size > 1000);
  const pick = new Map([["pefr", lex!.get("pefr") ?? []], ["pef", lex!.get("pef") ?? []]]);
  assert.ok(abbreviationMatch("PEFR 410 L/min", "PEF Airway PFM", pick));
  // the provider: a failing lexicon query falls back to the bundled file, the thesaurus query still counts
  const t = createDbTerminologyNames({
    query: async (sql: string) => {
      if (/abbreviation_lexicon/u.test(sql)) throw new Error('relation "fhir.abbreviation_lexicon" does not exist');
      return { rows: [] };
    },
  });
  const m = await t.abbreviations(["PEFR", "PEF"]);
  assert.ok((m.get("pefr") ?? []).some((x) => /peak expiratory flow/iu.test(x)), JSON.stringify([...m]));
  assert.ok((m.get("pef") ?? []).some((x) => /peak expiratory flow/iu.test(x)));
});

test("FP: ROC range with a full-width ～ and spaces, ROC year-month 113/08 (blood pressures are no dates)", () => {
  assert.deepEqual(parseDates("療程 115/10/26 ～ 115/12/07"), [["day", [2026, 10, 26]], ["day", [2026, 12, 7]]]);
  assert.deepEqual(parseDates("113/08 診斷"), [["month", [2024, 8, null]]]);
  assert.deepEqual(parseDates("民國113年8月確診"), [["month", [2024, 8, null]]]);
  assert.deepEqual(parseDates("113/08/15"), [["day", [2024, 8, 15]]]);
  assert.deepEqual(parseDates("BP 120/80 mmHg"), []);
  const src = "病人：林美華 女\n診斷：乳癌（左側），113/08 診斷\n處方：Tamoxifen 20 mg PO QD，處方期間 115/10/26 ～ 115/12/07";
  const b = bundle(
    cond("C50.912", "Malignant neoplasm of unspecified site of left female breast", { onsetDateTime: "2024-08", code: { coding: [{ system: ICD, code: "C50.912", display: "Malignant neoplasm of unspecified site of left female breast" }], text: "乳癌（左側）" } }),
    { resourceType: "MedicationRequest", status: "active", intent: "order", subject: { reference: P }, medicationCodeableConcept: { text: "Tamoxifen 20 mg" }, dispenseRequest: { validityPeriod: { start: "2026-10-26", end: "2026-12-07" } } },
  );
  const issues = rec(b, src);
  assert.ok(!issues.some(([, c, p]) => c === "ungrounded-value" && /onsetDateTime|validityPeriod/u.test(p)), JSON.stringify(issues));
  const g = checkGroundingSync({ bundle: b, source_text: src } as any, new Map(), {});
  assert.ok(!g.entries.flatMap((e) => e.issues).some((i) => (i.advisory_from ?? i.severity) === "error" && /onsetDateTime|validityPeriod/u.test(i.path)));
});

test("FP: CA 15-3：12.4 (hyphenated analyte + full-width colon), thousands separator 28,640, UCUM [IU]/mL", () => {
  assert.equal(canonUnit("[IU]/mL"), "iu/ml");
  assert.equal(canonUnit("uIU/mL"), "uiu/ml");
  const src = "病人：林美華 女\n115/10/20 檢驗：CA 15-3：12.4；Anti-HBs 12.3 IU/mL；WBC 28,640 /uL";
  const b = bundle(
    obs("6875-9", "Cancer Ag 15-3 [Units/volume] in Serum or Plasma", 12.4, "U/mL", "U/mL", "CA 15-3"),
    obs("22322-2", "Hepatitis B virus surface Ab [Units/volume] in Serum", 12.3, "IU/mL", "[IU]/mL", "Anti-HBs"),
    obs("6690-2", "Leukocytes [#/volume] in Blood by Automated count", 28640, "/uL", "/uL", "WBC"),
  );
  const issues = rec(b, src);
  const onObs = ([s, c, p]: [string, string, string]): boolean => s === "error" && (c === "ungrounded-value" || c === "value-from-other-event") && !p.startsWith("Bundle.entry[0]");
  assert.ok(!issues.some(onObs), JSON.stringify(issues));
  // a value that is NOT in the record is still found
  const wrong = bundle(obs("6875-9", "Cancer Ag 15-3 [Units/volume] in Serum or Plasma", 21.4, "U/mL", "U/mL", "CA 15-3"));
  assert.ok(rec(wrong, src).some(onObs));
});

test("FP: a stop cue (停藥 / 暫停) is about a medicine — no status change for a body-weight Observation", () => {
  const w = obs("29463-7", "Body weight", 58, "kg", "kg", "體重");
  const src = "病人：林美華 女\n115/10/20 體重 58 kg，化療暫停";
  const neg = rec(bundle(w), src).filter(([, c]) => c === "negated-item-present");
  assert.deepEqual(neg, []);
  // a medicine stopped in the record, written active, is still reported
  const mr = { resourceType: "MedicationRequest", status: "active", intent: "order", subject: { reference: P }, medicationCodeableConcept: { text: "Aspirin" } };
  assert.ok(rec(bundle(mr), "病人：林美華 女\n用藥：Aspirin 已停藥").some(([, c]) => c === "negated-item-present"));
});

test("FP: 【診斷】 section header holds the diagnosis items; 「張淑芬，女」 is an identity line", () => {
  const rt = new RecordText("【病人資料】\n林美華，女，民國51年5月6日生\n【主訴】\n咳嗽兩週\n【診斷】\n1. 社區型肺炎\n2. 高血壓\n【計畫】\n抗生素治療", null);
  const s = diagnosisSlots(rt);
  assert.ok(s.some((x) => x.kind === "primary" && x.items.length === 2 && !x.empty), JSON.stringify(s.map((x) => [x.kind, x.items.map((i) => i.core)])));
  const src = "門診病歷\n就診日期：115/10/20\n科別：家醫科\n醫師：陳醫師\n張淑芬，女，65歲\n主訴：咳嗽";
  const b = { resourceType: "Bundle", type: "collection", entry: [{ fullUrl: P, resource: { resourceType: "Patient", name: [{ text: "張淑芬" }], gender: "female" } }] };
  const g = checkGroundingSync({ bundle: b, source_text: src } as any, new Map(), {});
  assert.ok(!g.entries.flatMap((e) => e.issues).some((i) => i.rule === "G-CONTEXT-LABEL" && /gender/u.test(i.path)), JSON.stringify(g.entries.flatMap((e) => e.issues)));
});

test("FP: an item the conversion target lists is never 'excluded by the target', whichever target line excludes", () => {
  const src = [
    "【轉換目標】請轉換病人資料與 CA 15-3 檢驗結果",
    "【轉換目標】其餘檢驗不需轉換",
    "病人：林美華 女",
    "115/10/20 CA 15-3：12.4；CEA 3.1",
  ].join("\n");
  const ca = obs("6875-9", "Cancer Ag 15-3 [Units/volume] in Serum or Plasma", 12.4, "U/mL", "U/mL", "CA 15-3");
  const cea = obs("2039-6", "Carcinoembryonic Ag [Mass/volume] in Serum or Plasma", 3.1, "ng/mL", "ng/mL", "CEA");
  const issues = runRecordChecks(bundle(ca, cea), { sourceText: src }).issues.filter((i) => i.code === "negated-item-present");
  assert.ok(!issues.some((i) => i.path.startsWith("Bundle.entry[1]")), JSON.stringify(issues.map((i) => i.path)));
});
