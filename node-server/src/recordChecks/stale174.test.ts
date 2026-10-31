/**
 * ISSUES_v17.4 — the two missed fabrications: an old / no-longer-valid value taken as this time's value
 * (stale-value), and "not established" written as text into the required primary diagnosis
 * (unconfirmed-as-confirmed) — plus the controls that must stay silent.
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
const patient: Json = { resourceType: "Patient", name: [{ text: "王小明" }] };
const claimWeight = (kg: number): Json => ({ resourceType: "Claim", status: "active", supportingInfo: [{ sequence: 1, category: { text: "weight" }, valueQuantity: { value: kg, unit: "kg", system: "http://unitsofmeasure.org", code: "kg" } }] });
const issues = (b: Json, rec: string | null, code: string): Json[] => (runRecordChecks(b, rec ? { sourceText: rec } : {}).issues as Json[]).filter((i) => i.code === code);

test("stale-value: a weight the record marks as not applicable is not this time's value", () => {
  const rec = "病人：王小明\nO: 體重 本次未測量（輪椅就診，待補；112/10 移植前體重 63 kg 已不適用）";
  const hits = issues(bundle(patient, claimWeight(63)), rec, "stale-value");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].severity, "error");
  assert.match(hits[0].message_zh, /insufficient_information/);
  assert.match(hits[0].message_zh, /已不適用|移植前/);
});

test("stale-value controls: the current value next to an old one, and a plain value, stay silent", () => {
  assert.deepEqual(issues(bundle(patient, claimWeight(65)), "O: 體重 65 kg（前次 63 kg）", "stale-value"), []);
  assert.deepEqual(issues(bundle(patient, claimWeight(63)), "O: 體重 63 kg，身高 170 cm", "stale-value"), []);
  // the same number also stated currently elsewhere
  assert.deepEqual(issues(bundle(patient, claimWeight(63)), "O: 體重 63 kg\n移植前體重 63 kg 已不適用", "stale-value"), []);
  assert.deepEqual(issues(bundle(patient, claimWeight(70)), "78 years old, weight 70 kg", "stale-value"), []);
});

test("unconfirmed-as-confirmed: a not-established primary diagnosis written as Claim.diagnosis text", () => {
  const claim = (text: string, coding?: Json[]): Json => ({ resourceType: "Claim", status: "active", diagnosis: [{ sequence: 1, diagnosisCodeableConcept: { ...(coding ? { coding } : {}), text } }] });
  const hit = issues(bundle(patient, claim("左肺上葉肺腫塊，疑原發性肺癌（組織型態與 ALK 狀態待病理報告確認），主診斷尚未確立")), "組織型態與 ALK 狀態待病理報告確認", "unconfirmed-as-confirmed");
  assert.equal(hit.length, 1);
  assert.equal(hit[0].path, "Bundle.entry[1].resource.diagnosis[0].diagnosisCodeableConcept");
  // a hedge only, text-only → error; a hedge with a real code → silent
  assert.equal(issues(bundle(patient, claim("疑似肺癌")), null, "unconfirmed-as-confirmed").length, 1);
  assert.deepEqual(issues(bundle(patient, claim("疑似肺癌", [{ system: "http://hl7.org/fhir/sid/icd-10-cm", code: "C34.12" }])), null, "unconfirmed-as-confirmed"), []);
});

test("unconfirmed-as-confirmed controls: established diagnoses, diagnosis names with such words, a provisional Condition", () => {
  const claim = (text: string): Json => ({ resourceType: "Claim", status: "active", diagnosis: [{ sequence: 1, diagnosisCodeableConcept: { text } }] });
  for (const t of ["左上葉肺腺癌，EGFR exon 19 deletion", "不明原因發燒", "PSA 升高（未確立惡性腫瘤）", "Carcinoma of unknown primary", "Monoclonal gammopathy of undetermined significance"]) {
    assert.deepEqual(issues(bundle(patient, claim(t)), null, "unconfirmed-as-confirmed"), [], t);
  }
  const cond: Json = { resourceType: "Condition", verificationStatus: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-ver-status", code: "provisional" }] }, code: { text: "疑似肺炎" } };
  assert.deepEqual(issues(bundle(patient, cond), null, "unconfirmed-as-confirmed").filter((i) => i.path.endsWith(".code")), []);
});
