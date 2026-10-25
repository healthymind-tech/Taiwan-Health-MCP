/**
 * Record checks (ISSUES_v15) — synthetic data only.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { parseLossless, stringifyLossless } from "../losslessJson.js";
import { syntheticCases, BASE_BUNDLE, BASE_RECORD } from "../../scripts/record-checks-eval/synthetic.js";
import { addRecordChecksToFinalize, addRecordChecksToFinalizeResource, addRecordChecksToValidation } from "./envelope.js";
import { absenceOf, identifierRegistry, runRecordChecks } from "./index.js";

const codes = (b: object, sourceText: string | null = null, siteConfig: string | null = null): string[] =>
  runRecordChecks(b as Record<string, any>, { sourceText, siteConfig }).issues.map((i) => `${i.severity}:${i.code}`);

test("absence recogniser: the whole value must describe absence (zh / en, morphological variants)", () => {
  for (const v of ["尚未取號", "還沒取號", "取號中", "取號失敗", "建檔失敗，尚未給號", "家屬說證件還沒帶來", "不詳", "待補", "尚在申請", "目前無法提供", "unknown", "Not yet assigned", "pending", "N/A", "to be confirmed"]) {
    assert.ok(absenceOf(v, true), `absent: ${v}`);
  }
  for (const v of ["王不明", "林未央", "Hypertension, unspecified", "A123456789", "無名氏", "2025-03", "pending lab 123", "陰性", "高血壓", "Unknown-origin fever 3 days 100"]) {
    assert.equal(absenceOf(v, true), null, `not absent: ${v}`);
  }
  // nil words only where a structured value is needed
  assert.ok(absenceOf("無", true));
  assert.equal(absenceOf("無", false), null);
  assert.equal(absenceOf("none", false), null);
});

test("identifier registry: ROC national ID / resident certificate check digits, site_config formats", () => {
  const r = identifierRegistry("identifier-format https://h.example/mrn [0-9]{7}\n- identifier-format https://h.example/card tw-nhi-card\nidentifier-format https://h.example/bad ([");
  const nid = r.formatFor("http://www.moi.gov.tw")!;
  assert.equal(nid.check("A223456781").ok, true);
  assert.equal(nid.check("A223456789").checksum, true);
  assert.equal(nid.check("A22345").ok, false);
  assert.equal(nid.check("F800312747").ok, false); // a resident number under the national-ID system
  const res = r.formatFor("http://www.immigration.gov.tw")!;
  assert.equal(res.check("F800312747").ok, true); // new format
  assert.equal(res.check("AA00000009").ok, true); // old format
  assert.equal(res.check("AA00000008").ok, false);
  assert.equal(r.formatFor("https://h.example/mrn")!.check("1234567").ok, true);
  assert.equal(r.formatFor("https://h.example/mrn")!.check("12-345").ok, false);
  assert.equal(r.formatFor("https://h.example/card")!.check("0000 1234 5678").ok, true);
  assert.equal(r.formatFor("https://h.example/bad"), null);
  assert.equal(r.notes.length, 1);
  assert.equal(r.formatFor("https://other.example/mrn"), null);
});

test("synthetic dev set: ≥ 90 % of missing-information variants detected; complete controls get no error", () => {
  const cases = syntheticCases();
  const pos = cases.filter((c) => c.expect);
  assert.ok(pos.length >= 40, `dev set has ${pos.length} variants`);
  const missed: string[] = [];
  for (const c of pos) {
    const r = runRecordChecks(c.bundle, { sourceText: c.source_text, siteConfig: c.site_config ?? null });
    const ok = r.issues.some((i) => i.code === c.expect!.code && (c.expect!.severity === "warning" || i.severity === "error"));
    if (!ok) missed.push(c.id);
  }
  assert.ok(missed.length / pos.length <= 0.1, `missed: ${missed.join(", ")}`);
  for (const c of cases.filter((x) => !x.expect)) {
    const r = runRecordChecks(c.bundle, { sourceText: c.source_text, siteConfig: c.site_config ?? null });
    assert.deepEqual(r.issues.filter((i) => i.severity === "error"), [], c.id);
    assert.equal(r.summary.ok, true);
  }
});

test("R1 is field-scoped: an absence phrase elsewhere in the record never affects another field", () => {
  // BASE_RECORD says 家族史：不詳 — the complete Bundle stays clean, with and without the record
  assert.deepEqual(codes(BASE_BUNDLE(), BASE_RECORD), []);
  assert.deepEqual(codes(BASE_BUNDLE()), []);
  // absence words inside a longer real value are not absence
  const b = BASE_BUNDLE();
  b.entry[2].resource.code.text = "不明原因發燒";
  b.entry[2].resource.code.coding[0].display = "Fever, unspecified";
  assert.deepEqual(codes(b).filter((c) => c.startsWith("error")), []);
});

test("R1 runs without source_text; real HL7 'unknown' codes are not flagged", () => {
  const b = BASE_BUNDLE();
  b.entry[0].resource.identifier[1].value = "尚未取號";
  b.entry[0].resource.gender = "unknown";
  b.entry[0].resource.maritalStatus = { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-NullFlavor", code: "UNK", display: "unknown" }] };
  const r = runRecordChecks(b, {});
  assert.deepEqual(r.issues.map((i) => [i.code, i.path, i.rule, i.source]), [["information-absent", "Bundle.entry[0].resource.identifier[1].value", "R1", "record-checks"]]);
  assert.match(r.issues[0].message, /病歷沒有提供這項資訊/u);
  assert.deepEqual(r.summary, { ok: false, errors: 1, warnings: 0, rules: ["R1", "R2"], source_text: false });
});

test("R3 says whether the record has a more complete value", () => {
  const b = BASE_BUNDLE();
  b.entry[1].resource.period.start = "2025-03";
  const has = runRecordChecks(b, { sourceText: BASE_RECORD }).issues.find((i) => i.code === "insufficient-precision")!;
  assert.match(has.message_zh, /病歷有更完整的值 '2025-03-14'/u);
  const none = runRecordChecks(b, { sourceText: BASE_RECORD.replace("就診日期：2025/03/14 09:20", "就診：三月份") }).issues.find((i) => i.code === "insufficient-precision")!;
  assert.match(none.message_zh, /病歷沒有提供更完整的日期/u);
  assert.match(none.evidence, /found none/u);
  // history-type times (Condition.onsetDateTime) to the year are not insufficient (R3); the year itself must be in the
  // record (R5, ISSUES_v15.1): 2019 is not, 2016 is derivable from 「病史 9 年」 and the 2025 visit
  const c = BASE_BUNDLE();
  c.entry[2].resource.onsetDateTime = "2019";
  assert.deepEqual(codes(c, BASE_RECORD), ["error:ungrounded-value"]);
  c.entry[2].resource.onsetDateTime = "2016";
  assert.deepEqual(codes(c, BASE_RECORD.replace("主訴：咳嗽三天", "主訴：咳嗽三天，氣喘病史 9 年")), []);
});

test("R4: explicit → error, hedged → warning, confirmed / provisional → nothing", () => {
  const dx = (line: string): string => BASE_RECORD.replace("診斷：急性支氣管炎 (J20.9)", line);
  assert.deepEqual(codes(BASE_BUNDLE(), dx("診斷：急性支氣管炎待排除，尚未確立")), ["error:unconfirmed-as-confirmed"]);
  assert.deepEqual(codes(BASE_BUNDLE(), dx("診斷：疑似急性支氣管炎")), ["warning:unconfirmed-as-confirmed"]);
  assert.deepEqual(codes(BASE_BUNDLE(), dx("診斷：急性支氣管炎，已確診")), []);
  assert.deepEqual(codes(BASE_BUNDLE(), dx("診斷：急性支氣管炎；r/o 肺炎")), []);
  const p = BASE_BUNDLE();
  p.entry[2].resource.verificationStatus.coding[0].code = "provisional";
  assert.deepEqual(codes(p, dx("診斷：急性支氣管炎待排除")), []);
});

function validationEnvelope(bundle: Record<string, any>): string {
  const entries = bundle.entry.map((e: any) => ({ fullUrl: e.fullUrl, resourceType: e.resource.resourceType, valid: true, profile: null, issues: [] as unknown[] }));
  entries[0].issues.push({ severity: "warning", code: "informational", path: "Bundle.entry[0].resource", message: "validator issue" });
  return JSON.stringify({ ok: true, data: { valid: true, source: "builtin", issues: [], entries, referenceIssues: [] }, warnings: [], provenance: { tool: "fhir_validate_bundle" } });
}

test("envelope: issues land on the entry, valid turns false, the validator's own issues are untouched", () => {
  const b = BASE_BUNDLE();
  b.entry[0].resource.identifier[0].value = "家屬說身分證還沒帶來";
  const text = validationEnvelope(b);
  const before = JSON.parse(text);
  const out = JSON.parse(addRecordChecksToValidation(text, b, {}));
  assert.equal(out.data.valid, false);
  assert.equal(out.data.entries[0].valid, false);
  assert.deepEqual(out.data.entries[0].issues[0], before.data.entries[0].issues[0]);
  assert.equal(out.data.entries[0].issues[1].code, "information-absent");
  assert.equal(out.data.record_checks.ok, false);
  assert.equal(out.provenance.tool, "fhir_validate_bundle");
  assert.ok(out.provenance.recordChecksVersion);
  // a clean Bundle without source_text: byte-identical (no record_checks, no provenance fields)
  const cleanText = validationEnvelope(BASE_BUNDLE());
  assert.equal(addRecordChecksToValidation(cleanText, BASE_BUNDLE(), {}), cleanText);
  // with source_text the summary is always reported
  const withSrc = JSON.parse(addRecordChecksToValidation(cleanText, BASE_BUNDLE(), { sourceText: BASE_RECORD }));
  assert.equal(withSrc.data.valid, true);
  assert.deepEqual(withSrc.data.record_checks, { ok: true, errors: 0, warnings: 0, rules: ["R1", "R2", "R3", "R4", "R5"], source_text: true });
  // an error envelope passes through byte-identical
  const err = JSON.stringify({ ok: false, data: null, error: { code: "X", message: "y" } });
  assert.equal(addRecordChecksToValidation(err, b, {}), err);
});

test("envelope: normalized_bundle keeps number spellings; finalize gets record_issues without touching the Bundle", () => {
  const b = BASE_BUNDLE();
  b.entry[3].resource.valueQuantity.value = 37.8;
  const raw = `{"ok":true,"data":{"valid":true,"issues":[],"entries":[],"normalized_bundle":${JSON.stringify(b).replace('"value":37.8', '"value":37.80')}},"warnings":[]}`;
  const out = addRecordChecksToValidation(raw, b, {});
  assert.match(out, /"value":37\.80/u);
  const fb = BASE_BUNDLE();
  fb.entry[1].resource.period.start = "2025-03";
  const fin = stringifyLossless({ ok: true, data: { bundle: parseLossless(JSON.stringify(fb)), changes: [] }, warnings: [] });
  const f = JSON.parse(addRecordChecksToFinalize(fin, { sourceText: BASE_RECORD }));
  assert.deepEqual(f.data.bundle, fb);
  assert.deepEqual(f.data.record_issues.map((i: any) => i.code), ["insufficient-precision"]);
  assert.equal(f.data.record_checks.source_text, true);
  assert.equal(f.warnings.length, 1);
});

test("finalize envelopes: clean without source_text → unchanged; fhir_finalize_resource findings go into data.validation", () => {
  const fin = stringifyLossless({ ok: true, data: { bundle: parseLossless(JSON.stringify(BASE_BUNDLE())), changes: [] }, warnings: [] });
  assert.equal(addRecordChecksToFinalize(fin, {}), fin);
  const patient = BASE_BUNDLE().entry[0].resource;
  const env = (r: object): string => JSON.stringify({ ok: true, data: { resource: r, validation: { valid: true, issues: [] }, changes: [] }, warnings: [] });
  assert.equal(addRecordChecksToFinalizeResource(env(patient), {}), env(patient));
  const bad = structuredClone(patient);
  bad.identifier[1].value = "尚未取號";
  const out = JSON.parse(addRecordChecksToFinalizeResource(env(bad), {}));
  assert.equal(out.data.validation.valid, false);
  assert.deepEqual(out.data.validation.issues.map((i: any) => [i.code, i.path]), [["information-absent", "Patient.identifier[1].value"]]);
  assert.equal(out.data.validation.record_checks.errors, 1);
  assert.deepEqual(out.data.resource, bad);
  assert.equal(out.warnings.length, 1);
});
