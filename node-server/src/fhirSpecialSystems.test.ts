import assert from "node:assert/strict";
import { test } from "node:test";
import { composeContains, type TerminologyDeps } from "./fhirCodeSystem.js";
import { judgeLanguageTag, specialSystemMember } from "./fhirSpecialSystems.js";
import { judgeSpecialSystem } from "./fhirValidationResolver.js";

// Expectations: HL7 terminology ecosystem tests (fhir-tx-ecosystem-ig tests/langcodes, validate-lang-*).
test("BCP-47 tags valid as tx.fhir.org answers them", () => {
  for (const code of ["en", "en-US", "zh-Hans", "zh-Hans-CN", "en-QM", "i-klingon", "EN", "en-us", "ZH-hans-cn", "zh-TW", "de-1901", "zh-cmn-Hans-CN", "en-x-private", "en-US-u-ca-gregory"]) {
    assert.deepEqual(judgeLanguageTag(code), { valid: true }, code);
  }
});

test("BCP-47 tags invalid with the tx.fhir.org reason", () => {
  const cases: Array<[string, string]> = [
    ["zz", "The language 'zz' in the code 'zz' is not valid"],
    ["en-AB", "The region 'AB' in the code 'en-AB' is not valid"],
    ["en-Abcd", "The script 'Abcd' in the code 'en-Abcd' is not valid"],
    ["en-cmn", "The extLanguage 'cmn' in the code 'en-cmn' may only be used with 'zh', not with 'en'"],
    ["en-1901", "The variant '1901' in the code 'en-1901' may only be used with 'de', not with 'en'"],
  ];
  for (const [code, reason] of cases) assert.deepEqual(judgeLanguageTag(code), { valid: false, reason }, code);
  const r = judgeLanguageTag("xx-nonsense-zz");
  assert.equal(r?.valid, false);
});

test("judgeSpecialSystem: Unknown_Code_in error for an invalid language tag / MIME type, silent when valid", () => {
  const bad = judgeSpecialSystem("urn:ietf:bcp:47", "en-AB", null);
  assert.equal(bad?.status, "invalid-code");
  assert.equal(bad && "message" in bad ? bad.message : "", "Unknown code 'en-AB' in the CodeSystem 'urn:ietf:bcp:47'");
  assert.equal(judgeSpecialSystem("urn:ietf:bcp:47", "en-US", null)?.status, "silent");
  assert.equal(judgeSpecialSystem("urn:ietf:bcp:13", "pdf", null)?.status, "invalid-code");
  assert.equal(judgeSpecialSystem("urn:ietf:bcp:13", "application/pdf", null)?.status, "silent");
  assert.equal(judgeSpecialSystem("urn:ietf:bcp:13", "text/plain; charset=utf-8", null)?.status, "silent");
  assert.equal(judgeSpecialSystem("http://loinc.org", "1-8", null), null);
  // UN M49: three digits; anything else is the server's Unknown_Code_in_Version (no version), a 3-digit code needs the list
  const m49 = "http://unstats.un.org/unsd/methods/m49/m49.htm";
  const z = judgeSpecialSystem(m49, "ZZZ-9", null);
  assert.equal(z && "message" in z ? z.message : "", `Unknown code 'ZZZ-9' in the CodeSystem '${m49}'`);
  assert.equal(judgeSpecialSystem(m49, "001", null), null);
});

test("whole-system include of BCP-47 / BCP-13 decides membership by validity", async () => {
  const deps: TerminologyDeps = {
    loadValueSet: async () => null,
    loadCodeSystem: async () => null,
    lookupExternal: async () => null,
    externalSystemHeld: async () => false,
  };
  const mime = { include: [{ system: "urn:ietf:bcp:13" }] };
  assert.equal(await composeContains(mime, null, "pdf", deps, 0, new Set()), false);
  assert.equal(await composeContains(mime, null, "application/pdf", deps, 0, new Set()), true);
  assert.equal(specialSystemMember("urn:ietf:bcp:13", "json"), true);
  const langs = { include: [{ system: "urn:ietf:bcp:47" }] };
  assert.equal(await composeContains(langs, "urn:ietf:bcp:47", "en-AB", deps, 0, new Set()), false);
  assert.equal(await composeContains(langs, "urn:ietf:bcp:47", "zh-TW", deps, 0, new Set()), true);
});
