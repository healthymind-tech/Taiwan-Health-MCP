/**
 * QuestionnaireValidator / EnableWhenEvaluator ports (validator_cli 7.0.1). Expected texts are Messages.properties
 * entries; the cases follow fhir-test-cases questionnaire-enableWhen-*, qr and the questionnaire/brianpos set.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateQuestionnaire, validateQuestionnaireResponse, type QuestionnaireDeps } from "./fhirQuestionnaireRules.js";

const URL = "http://acme-test.fhir.test/Questionnaire/q";
const deps = (q: Record<string, any>): QuestionnaireDeps => ({
  fetchQuestionnaire: async (u) => (u === URL ? q : null),
  valueSetKnown: async () => true,
  member: async () => undefined,
  evaluate: () => undefined,
  ucumCanonical: () => null,
  assumeValidRestReferences: false,
  isResourceName: (n) => n === "Patient",
});
const run = async (q: Record<string, any>, qr: Record<string, any>): Promise<string[]> =>
  (await validateQuestionnaireResponse({ resourceType: "QuestionnaireResponse", questionnaire: URL, status: "completed", ...qr }, "QuestionnaireResponse", deps(q))).filter((i) => i.severity === "error").map((i) => `${i.path}: ${i.message}`);

test("Questionnaire: an enableWhen cannot point inside its own item, at nothing, or at itself", async () => {
  const q = {
    item: [
      { linkId: "a", type: "group", enableWhen: [{ question: "a1" }], item: [{ linkId: "a1", type: "string" }] },
      { linkId: "b", type: "string", enableWhen: [{ question: "none" }] },
      { linkId: "c", type: "string", enableWhen: [{ question: "c" }] },
      { linkId: "d", type: "string", enableWhen: [{ question: "e" }] },
      { linkId: "e", type: "string" },
    ],
  };
  const got = await validateQuestionnaire(q, "Questionnaire", { fetchQuestionnaire: async () => null, fetchValueSet: async () => null });
  assert.deepEqual(
    got.map((i) => [i.severity, i.path, i.message]),
    [
      ["error", "Questionnaire.item[0]", "Questions with an enableWhen cannot refer to an inner question for its enableWhen condition"],
      ["error", "Questionnaire.item[1]", "Unable to find an item with the linkId 'none' which is referenced in the enableWhen for 'b'"],
      ["error", "Questionnaire.item[2]", "Target for this question enableWhen can't reference itself"],
      ["warning", "Questionnaire.item[3]", "The target of this enableWhen rule (e) comes after the question itself"],
    ],
  );
});

test("a linkId the questionnaire does not have, and an answer of the wrong type", async () => {
  const q = { item: [{ linkId: "1", type: "boolean" }] };
  assert.deepEqual(await run(q, { item: [{ linkId: "9" }, { linkId: "1", answer: [{ valueString: "x" }] }] }), [
    "QuestionnaireResponse: LinkId '9' not found in questionnaire",
    "QuestionnaireResponse.item[1].answer[0].valueString: Answer value must be of the type boolean not string",
  ]);
});

test("enableWhen: an answer to a disabled item, and a required item once enabled", async () => {
  const q = {
    item: [
      { linkId: "c", type: "boolean" },
      { linkId: "t", type: "string", required: true, enableWhen: [{ question: "c", operator: "=", answerBoolean: true }] },
    ],
  };
  assert.deepEqual(await run(q, { item: [{ linkId: "c", answer: [{ valueBoolean: false }] }, { linkId: "t", answer: [{ valueString: "x" }] }] }), [
    "QuestionnaireResponse.item[1]: Item has answer, even though it is not enabled (item id = 't')",
  ]);
  assert.deepEqual(await run(q, { item: [{ linkId: "c", answer: [{ valueBoolean: true }] }] }), ["QuestionnaireResponse: No response answer found for required item 't'"]);
  assert.deepEqual(await run(q, { item: [{ linkId: "c", answer: [{ valueBoolean: false }] }] }), []);
});

test("items of an answer are reported on the item's path, and a status other than completed only warns", async () => {
  const q = { item: [{ linkId: "1", type: "string", item: [{ linkId: "2", type: "boolean", required: true }] }] };
  assert.deepEqual(await run(q, { item: [{ linkId: "1", answer: [{ valueString: "x" }] }] }), ["QuestionnaireResponse.item[0]: No response answer found for required item '2'"]);
  assert.deepEqual(await run(q, { status: "in-progress", item: [{ linkId: "1", answer: [{ valueString: "x" }] }] }), []);
});

test("options: an open-choice string needs no match, a choice string needs a string option", async () => {
  const choice = { item: [{ linkId: "1", type: "choice", answerOption: [{ valueCoding: { system: "http://s", code: "a" } }] }] };
  assert.deepEqual(await run(choice, { item: [{ linkId: "1", answer: [{ valueString: "free" }] }] }), ["QuestionnaireResponse.item[0].answer[0]: Option list has no option values of type string"]);
  const open = { item: [{ ...choice.item[0], type: "open-choice" }] };
  assert.deepEqual(await run(open, { item: [{ linkId: "1", answer: [{ valueString: "free" }] }] }), []);
  assert.deepEqual(await run(choice, { item: [{ linkId: "1", answer: [{ valueCoding: { system: "http://s", code: "b" } }] }] }), ["QuestionnaireResponse.item[0].answer[0]: The code http://s::b is not in the set of permitted values"]);
});

test("maxDecimalPlaces on decimal and Quantity answers; repeats; occurs", async () => {
  const places = { url: "http://hl7.org/fhir/StructureDefinition/maxDecimalPlaces", valueInteger: 2 };
  const q = {
    item: [
      { linkId: "d", type: "decimal", extension: [places] },
      { linkId: "q", type: "quantity", extension: [places] },
      { linkId: "s", type: "string", repeats: true, extension: [{ url: "http://hl7.org/fhir/StructureDefinition/questionnaire-maxOccurs", valueInteger: 1 }] },
      { linkId: "n", type: "string" },
    ],
  };
  const got = await run(q, {
    item: [
      { linkId: "d", answer: [{ valueDecimal: 1.666 }] },
      { linkId: "q", answer: [{ valueQuantity: { value: 1.666 } }] },
      { linkId: "s", answer: [{ valueString: "a" }, { valueString: "b" }] },
      { linkId: "n", answer: [{ valueString: "a" }, { valueString: "b" }] },
    ],
  });
  assert.deepEqual(got, [
    "QuestionnaireResponse.item[0].answer[0].valueDecimal: The value 1.666 has too many decimal places (limit = 2)",
    "QuestionnaireResponse.item[1].answer[0].valueQuantity: The value 1.666 has too many decimal places (limit = 2)",
    "QuestionnaireResponse.item[2]: The maximum number of answers is 1 but this has 2 answers",
    "QuestionnaireResponse.item[3]: Only one response answer item with this linkId allowed",
  ]);
});

test("Questionnaire: derivedFrom marks the run only when the items would be compared", async () => {
  const parent = { url: URL };
  const statics = { fetchQuestionnaire: async (u: string) => (u === URL ? parent : null), fetchValueSet: async () => null };
  const derivation = (code: string): Record<string, any> => ({ extension: [{ url: "http://hl7.org/fhir/StructureDefinition/questionnaire-derivationType", valueCoding: { system: "http://hl7.org/fhir/questionnaire-derivationType", code } }] });
  const unchecked = async (q: Record<string, any>): Promise<unknown[]> => (await validateQuestionnaire(q, "Questionnaire", statics)).filter((i) => i.unchecked).map((i) => i.unchecked?.canonical);
  assert.deepEqual(await unchecked({ derivedFrom: [URL], _derivedFrom: [derivation("extends")] }), ["QuestionnaireValidator.validateQuestionnaireElementDerivation"]);
  assert.deepEqual(await unchecked({ derivedFrom: [URL], _derivedFrom: [derivation("inspiredBy")] }), []);
  assert.deepEqual(await unchecked({ derivedFrom: ["http://acme-test.fhir.test/none"] }), []);
});

test("Questionnaire: answerValueSet parameters against the ValueSet's", async () => {
  const vs = { url: "http://acme-test.fhir.test/vs", version: "1", extension: [{ url: "http://hl7.org/fhir/tools/StructureDefinition/valueset-parameter", extension: [{ url: "name", valueCode: "p" }] }] };
  const statics = { fetchQuestionnaire: async () => null, fetchValueSet: async () => vs };
  const got = await validateQuestionnaire({ item: [{ linkId: "1", type: "choice", answerValueSet: vs.url }] }, "Questionnaire", statics);
  assert.deepEqual(got.map((i) => [i.severity, i.message]), [["error", "The ValueSet 'http://acme-test.fhir.test/vs|1' has a parameter 'p' but there is no matching binding parameter"]]);
});

test("enableWhenExpression: a variable nobody supplies warns as Java does; a declared one marks the run", async () => {
  const expr = { url: "http://hl7.org/fhir/uv/sdc/StructureDefinition/sdc-questionnaire-enableWhenExpression", valueExpression: { language: "text/fhirpath", expression: "%patient.gender = 'female'" } };
  const q = { item: [{ linkId: "1", type: "boolean", extension: [expr] }] };
  const qr = { resourceType: "QuestionnaireResponse", questionnaire: URL, status: "completed", item: [{ linkId: "1", answer: [{ valueBoolean: true }] }] };
  const out = await validateQuestionnaireResponse(qr, "QuestionnaireResponse", deps(q));
  assert.deepEqual(out.map((i) => [i.severity, i.message]), [["warning", "The enableWhen expression for the item 1 could not be evaluated (it refers to %patient, which is not available when validating a QuestionnaireResponse on its own), so the item is treated as enabled, and its answers have not been checked against it"]]);
  const declared = { ...q, extension: [{ url: "http://hl7.org/fhir/StructureDefinition/variable", valueExpression: { name: "patient" } }] };
  const marked = await validateQuestionnaireResponse(qr, "QuestionnaireResponse", deps(declared));
  assert.deepEqual(marked.map((i) => i.unchecked?.canonical), ["EnableWhenEvaluator.collectVariables"]);
});

test("a value set answer local terminology cannot decide marks the run", async () => {
  const q = { item: [{ linkId: "1", type: "choice", answerValueSet: "http://acme-test.fhir.test/vs" }] };
  const out = await validateQuestionnaireResponse({ questionnaire: URL, status: "completed", item: [{ linkId: "1", answer: [{ valueCoding: { system: "http://s", code: "a" } }] }] }, "QuestionnaireResponse", deps(q));
  assert.deepEqual(out.map((i) => i.unchecked), [{ kind: "code", canonical: "http://acme-test.fhir.test/vs" }]);
});

test("the authored date outside the Questionnaire's period warns, with a text that is not the jar's", async () => {
  const q = { effectivePeriod: { end: "2020-01-01" }, item: [] };
  const out = await validateQuestionnaireResponse({ questionnaire: URL, status: "completed", authored: "2021-01-01" }, "QuestionnaireResponse", deps(q));
  assert.deepEqual(out.map((i) => [i.severity, i.unchecked?.canonical]), [["warning", "QuestionnaireValidator.checkAuthoringDate"]]);
});

test("an unresolved questionnaire stops the check: a warning, a hint for example.org", async () => {
  const out = await validateQuestionnaireResponse({ questionnaire: "http://acme-test.fhir.test/none", item: [{ linkId: "1" }] }, "QuestionnaireResponse", deps({}));
  assert.deepEqual(out.map((i) => i.severity), ["warning"]);
  const ex = await validateQuestionnaireResponse({ questionnaire: "http://example.org/none" }, "QuestionnaireResponse", deps({}));
  assert.deepEqual(ex.map((i) => i.severity), ["information"]);
});
