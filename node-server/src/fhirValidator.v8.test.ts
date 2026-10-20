/**
 * v8 (evaluation report v6): unresolvable HL7-space code systems are errors on
 * every element (SIDUtilities-aligned `/sid/` list, "Unknown Code System"),
 * whitespace in a reference, RxNorm displays that denote a different drug, and
 * "never a clean pass while lookups fail" (query-failure tracking → `exception`
 * issue, `checked_fully: false`). Behaviour confirmed with validator_cli 7.0.1
 * + tx.fhir.org (scripts/validator-audit, corpus v8 probes).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { InstanceValidator, LOOKUP_FAILURE_CODE, completenessOf, isValid, lookupFailureIssue, type CodeCheck, type Issue } from "./fhirValidator.js";
import { hl7UrlMustResolve, isKnownSid, isKnownSidCodeSystem } from "./fhirUriRules.js";
import { RXNORM, displayDenotesDifferentDrug, judgeRxnorm, rxDrugWords } from "./fhirExternalTerminology.js";
import { query, trackQueryFailures } from "./db.js";
import { CORE, FakeResolver } from "./fhirTestKit.test.js";

const ICD10PCS = "http://hl7.org/fhir/sid/icd-10-pcs";
const BAD_THO = "http://terminology.hl7.org/CodeSystem/v3-ActEncounterCode";

/** The test-kit resolver plus the HL7 "does this URL resolve?" lookup (nothing outside the kit resolves). */
class UrlResolver extends FakeResolver {
  async definitionExists(url: string): Promise<boolean> {
    const u = url.split("|")[0];
    return u.startsWith(CORE) || u.startsWith("http://hl7.org/fhir/ValueSet/condition-clinical");
  }
  override async checkCode(system: string, code: string, display: string | null): Promise<CodeCheck> {
    return super.checkCode(system, code, display);
  }
}

function condition(coding: Record<string, any>, extra: Record<string, any> = {}): Record<string, any> {
  return { resourceType: "Condition", id: "c1", subject: { reference: "Patient/p1" }, code: { coding: [coding] }, ...extra };
}

const errors = (issues: Issue[]): string[] => issues.filter((i) => i.severity === "error" || i.severity === "fatal").map((i) => i.message);

// --------------------------------------------------------------------------- //
// 1. Unresolvable code-system URLs
// --------------------------------------------------------------------------- //

test("SIDUtilities alignment: icd-10-pcs / us-mbi / bare eui-48 are not known SIDs; the real list and passport SIDs are", () => {
  assert.equal(isKnownSid(ICD10PCS), false);
  assert.equal(isKnownSid("http://hl7.org/fhir/sid/us-mbi"), false);
  assert.equal(isKnownSid("http://hl7.org/fhir/sid/eui-48"), false);
  assert.equal(isKnownSid("http://hl7.org/fhir/sid/eui-48/bluetooth"), true);
  assert.equal(isKnownSid("http://hl7.org/fhir/sid/icd-10-cm"), true);
  assert.equal(isKnownSid("http://hl7.org/fhir/sid/us-npi"), true);
  assert.equal(isKnownSid("http://hl7.org/fhir/sid/passport-TWN"), true);
  assert.equal(isKnownSidCodeSystem("http://hl7.org/fhir/sid/cvx"), true);
  assert.equal(isKnownSidCodeSystem("http://hl7.org/fhir/sid/us-npi"), false); // an id system, not a code system
  // The URL-resolution rule now fails icd-10-pcs (validator_cli: "No definition could be found for URL value").
  assert.equal(hl7UrlMustResolve(ICD10PCS), true);
  assert.equal(hl7UrlMustResolve("http://hl7.org/fhir/sid/icd-10-cm"), false);
  assert.equal(hl7UrlMustResolve("http://hl7.org/fhir/sid/passport-TWN"), false);
});

test("Coding.system http://hl7.org/fhir/sid/icd-10-pcs: URL resolution error (any element) + unknown-system warning, as validator_cli", async () => {
  const v = new InstanceValidator(new UrlResolver());
  const issues = await v.validate(condition({ system: ICD10PCS, code: "0DB64Z3" }));
  const errs = errors(issues);
  assert.deepEqual(errs, [`No definition could be found for URL value '${ICD10PCS}'`]);
  assert.ok(issues.some((i) => i.severity === "warning" && i.path === "Condition.code.coding[0].system" && i.message.startsWith(`A definition for CodeSystem '${ICD10PCS}' could not be found`)));
  // The same Coding inside the value of an (unknown) extension is judged the same way.
  const inExt = await v.validate(
    condition({ system: "http://snomed.info/sct", code: "1" }, { extension: [{ url: "http://example.tw/fhir/StructureDefinition/unknown-ext", valueCodeableConcept: { coding: [{ system: ICD10PCS, code: "X" }] } }] }),
  );
  assert.ok(errors(inExt).includes(`No definition could be found for URL value '${ICD10PCS}'`), errors(inExt).join("\n"));
  assert.ok(inExt.some((i) => i.path === "Condition.extension[0].valueCodeableConcept.coding[0].system" && i.message.startsWith("No definition could be found")));
});

test("Unknown systems outside the hl7.org/fhir space stay a warning; THO URLs only fail URL resolution", async () => {
  const v = new InstanceValidator(new UrlResolver());
  const ig = await v.validate(condition({ system: "https://twcore.mohw.gov.tw/ig/twcore/CodeSystem/made-up", code: "x" }));
  assert.deepEqual(errors(ig), []);
  assert.ok(ig.some((i) => i.severity === "warning" && i.message.startsWith("A definition for CodeSystem")));
  const tho = await v.validate(condition({ system: BAD_THO, code: "AMB" }));
  assert.deepEqual(errors(tho), [`No definition could be found for URL value '${BAD_THO}'`]);
});

// --------------------------------------------------------------------------- //
// 2. References
// --------------------------------------------------------------------------- //

test("a reference containing whitespace is REFERENCE_REF_INVALID_REF (error)", async () => {
  const v = new InstanceValidator(new UrlResolver());
  const bad = await v.validate({ resourceType: "Condition", id: "c1", subject: { reference: "Patient/ p1" } });
  assert.ok(errors(bad).includes("The reference 'Patient/ p1' is not a valid reference"), errors(bad).join("\n"));
  const trailing = await v.validate({ resourceType: "Condition", id: "c1", subject: { reference: "Patient/p1 " } });
  assert.ok(errors(trailing).includes("The reference 'Patient/p1 ' is not a valid reference"));
  const ok = await v.validate({ resourceType: "Condition", id: "c1", subject: { reference: "Patient/p1" } });
  assert.ok(!ok.some((i) => i.message.includes("is not a valid reference")));
});

// --------------------------------------------------------------------------- //
// 3. RxNorm: display denoting a different drug
// --------------------------------------------------------------------------- //

test("rxDrugWords keeps ingredient / brand words only", () => {
  assert.deepEqual([...rxDrugWords("Clopidogrel 75 MG Oral Tablet [Plavix]")], ["clopidogrel", "plavix"]);
  assert.deepEqual([...rxDrugWords("metformin hydrochloride 500 MG Extended Release Oral Tablet")], ["metformin"]);
  assert.deepEqual([...rxDrugWords("75 MG Oral Tablet")], []);
  assert.deepEqual([...rxDrugWords("amlodipine besylate 5 mg/ml")].sort(), ["amlodipine"]);
  assert.ok(rxDrugWords("Sulfamethoxazole / Trimethoprim").has("trimethoprim"));
});

test("displayDenotesDifferentDrug: different ingredient → reason; same drug in another form / salt / brand → null", () => {
  const names = ["thyroglobulin 100 MG Oral Tablet", "thyroglobulin 100 MG Oral Tablet [Proloid]"];
  assert.match(displayDenotesDifferentDrug("Clopidogrel 75 MG Oral Tablet", names) ?? "", /different concept.*clopidogrel/);
  assert.equal(displayDenotesDifferentDrug("Thyroglobulin tablet", names), null);
  assert.equal(displayDenotesDifferentDrug("Proloid", names), null);
  assert.equal(displayDenotesDifferentDrug("100 MG Oral Tablet", names), null); // nothing to judge
  assert.equal(displayDenotesDifferentDrug("metformin", ["metformin hydrochloride 500 MG Oral Tablet"]), null);
  assert.equal(displayDenotesDifferentDrug("Metformin HCl 500mg tab", ["metformin hydrochloride 500 MG Oral Tablet"]), null);
  assert.match(displayDenotesDifferentDrug("保栓通膜衣錠", names) ?? "", /no Latin letters/);
  // Stems: a ≥5-letter prefix match counts as the same word.
  assert.equal(displayDenotesDifferentDrug("ibuprofeno 400 mg", ["ibuprofen 400 MG Oral Tablet"]), null);
});

test("judgeRxnorm: a display naming another drug is an error even with only the preferred name held; a synonym stays a warning", () => {
  const preferredOnly = { name: "thyroglobulin 100 MG Oral Tablet", altNames: null };
  const wrong = judgeRxnorm("313375", "Clopidogrel 75 MG Oral Tablet", preferredOnly, false, "06032024");
  assert.equal(wrong.status, "invalid-display");
  assert.equal((wrong as { severity: string }).severity, "error");
  const msg = (wrong as { message: string }).message;
  assert.ok(msg.startsWith("Wrong Display Name 'Clopidogrel 75 MG Oral Tablet' for " + RXNORM + "#313375. Valid display is 'thyroglobulin 100 MG Oral Tablet'"), msg);
  assert.match(msg, /denotes a different concept/);
  assert.ok(!/'[^']*'$/.test(msg.split("; ")[1]), "the reason carries no quoted strings (suggestion-layer display parsing)");
  // Same drug, other wording: cannot rule out a PSN / SY atom → warning.
  const syn = judgeRxnorm("313375", "Thyroglobulin 100 mg tablet", preferredOnly, false, "06032024");
  assert.equal((syn as { severity: string }).severity, "warning");
  // CJK display: never an RxNorm name → error.
  const cjk = judgeRxnorm("313375", "甲狀腺球蛋白錠", preferredOnly, false, "06032024");
  assert.equal((cjk as { severity: string }).severity, "error");
  // With alt names loaded a matching alt name is fine; anything else is already an error.
  const full = { name: "thyroglobulin 100 MG Oral Tablet", altNames: ["Thyroglobulin 100 MG Oral Tablet [Proloid]"] };
  assert.equal(judgeRxnorm("313375", "thyroglobulin 100 mg oral tablet [proloid]", full, false, null).status, "ok");
  const fullWrong = judgeRxnorm("313375", "Clopidogrel 75 MG Oral Tablet", full, false, null);
  assert.equal((fullWrong as { severity: string }).severity, "error");
  assert.ok(!/different concept/.test((fullWrong as { message: string }).message), "tx.fhir.org wording kept when alt names are held");
  assert.equal(judgeRxnorm("313375", null, preferredOnly, false, null).status, "ok");
});

// --------------------------------------------------------------------------- //
// 4. Lookup failures are never a clean pass
// --------------------------------------------------------------------------- //

test("trackQueryFailures counts failed queries (no pool here) and lookupFailureIssue makes the run invalid and incomplete", async () => {
  const t = await trackQueryFailures(async () => {
    try {
      await query("SELECT 1");
    } catch {
      /* the caller degrades gracefully, as the validator resolver does */
    }
    return "done";
  });
  assert.equal(t.result, "done");
  assert.equal(t.total, 1);
  assert.equal(t.failures.length, 1);
  assert.equal(t.failures[0].code, null);
  const issue = lookupFailureIssue(t.total, t.failures);
  assert.equal(issue.severity, "error");
  assert.equal(issue.code, LOOKUP_FAILURE_CODE);
  assert.match(issue.message, /^Validation incomplete: 1 definition \/ terminology lookup failed/);
  const issues: Array<Record<string, any>> = [{ severity: "warning", path: "", code: "x", message: "w" }, issue];
  assert.equal(isValid(issues), false);
  const c = completenessOf(issues);
  assert.equal(c.checked_fully, false);
  assert.equal(c.lookups_failed, 1);
  assert.deepEqual(c.profiles_unchecked, []);
  // Without failures nothing changes (no lookups_failed field).
  assert.deepEqual(completenessOf([]), { checked_fully: true, profiles_unchecked: [], valuesets_unchecked: [] });
  // Queries outside a tracking scope are not recorded anywhere (no scope → no store).
  const outside = await trackQueryFailures(async () => 1);
  assert.equal(outside.total, 0);
});
