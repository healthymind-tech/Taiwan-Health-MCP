/**
 * MeasureValidator port (validator_cli 7.0.1). Expected texts are Messages.properties entries, including the call that
 * leaves `{2}` unfilled; the cases follow fhir-test-cases mr-m-simple, mr-single-* and measure-report-ihe.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateMeasure, validateMeasureReport, type MeasureDeps } from "./fhirMeasureRules.js";

const URL = "http://acme-test.fhir.test/Measure/m";
const population = (code: string): Record<string, any> => ({ code: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/measure-population", code }] } });
const measure = {
  scoring: { coding: [{ code: "proportion" }] },
  group: [{ id: "g", population: [population("initial-population"), population("numerator")], stratifier: [{ code: { text: "ages" } }] }],
};
const deps: MeasureDeps = {
  fetchMeasure: async (u) => (u === URL ? measure : null),
  fetchLibrary: async () => null,
  resolveSubject: async () => null,
  isResourceName: (n) => n === "Patient",
};
const report = async (r: Record<string, any>): Promise<string[]> =>
  (await validateMeasureReport({ measure: URL, type: "summary", ...r }, "MeasureReport", deps)).filter((i) => i.severity === "error").map((i) => `${i.path}: ${i.message}`);

test("MeasureReport: a score is required, populations are matched, the stratifier call leaves {2} unfilled", async () => {
  const got = await report({ group: [{ id: "g", population: [{ ...population("initial-population"), count: 1 }], stratifier: [{ code: { text: "ages" } }] }] });
  assert.deepEqual(got, [
    "MeasureReport.group[0]: The MeasureReport does not include a population for the population with linkId '' and code 'http://terminology.hl7.org/CodeSystem/measure-population#numerator'",
    "MeasureReport.group[0]: A measureScore is required when the Measure.scoring=proportion",
    "MeasureReport.group[0].stratifier[0]: The linkId ''ages'' links this group stratifier to a measure group that has a different code (''ages'' vs '{2}')",
  ]);
});

test("MeasureReport: a proportion score is unitless, between 0 and 1", async () => {
  const pops = [population("initial-population"), population("numerator")];
  const got = await report({ group: [{ population: pops.map((p) => ({ ...p, count: 1 })), measureScore: { value: 2, unit: "%" } }] });
  assert.ok(got.includes("MeasureReport.group[0].measureScore.unit: A measureScore for this Measure Scoring (proportion) should not have units"), got.join("\n"));
  assert.ok(got.includes("MeasureReport.group[0].measureScore.value: The value is invalid - it must be between 0 and 1"), got.join("\n"));
});

test("MeasureReport: subjects belong to subject-list reports, whose count must match", async () => {
  const pops = [population("initial-population"), population("numerator")];
  const subject = { subjectResults: { reference: "Patient/1" } };
  const listed = await report({ type: "subject-list", group: [{ population: pops.map((p) => ({ ...p, ...subject, count: 500 })), measureScore: { value: 1 } }] });
  assert.ok(listed.includes("MeasureReport.group[0].population[0]: Mismatch between count 500 and number of subjects 1"), listed.join("\n"));
  const summary = await report({ group: [{ population: pops.map((p) => ({ ...p, ...subject, count: 1 })), measureScore: { value: 1 } }] });
  assert.ok(summary.includes("MeasureReport.group[0].population[0]: Reports where type is not 'subject-list' don't have subjects listed"), summary.join("\n"));
});

test("Measure: a CQL criteria needs a library, the namespace to match, and the function in the ELM", async () => {
  const cql = (expression: string): Record<string, any> => ({ group: [{ population: [{ criteria: { language: "text/cql", expression } }] }] });
  const noLib = await validateMeasure(cql("X"), "Measure", deps);
  assert.ok(noLib.some((i) => i.severity === "error" && i.message === "No CQL Libraries found on this Measure"));
  const elm = Buffer.from('<library xmlns="urn:hl7-org:elm:r1"><statements><def name="Here"/></statements></library>').toString("base64");
  const withLib: MeasureDeps = { ...deps, fetchLibrary: async () => ({ url: "http://l", name: "Lib", content: [{ contentType: "application/elm+xml", data: elm }] }) };
  const errors = async (expr: string): Promise<string[]> => (await validateMeasure({ library: ["http://l"], ...cql(expr) }, "Measure", withLib)).filter((i) => i.severity === "error").map((i) => i.message);
  assert.deepEqual(await errors("Lib.Here"), []);
  assert.deepEqual(await errors("Lib.Gone"), ["The function Gone does not exist in the library http://l"]);
  assert.deepEqual(await errors("Other.Here"), ["No matching Library found for the namespace Other"]);
  const broken: MeasureDeps = { ...deps, fetchLibrary: async () => ({ url: "http://l", name: "Lib", content: [{ contentType: "application/elm+xml", data: Buffer.from("<library><open></library>").toString("base64") }] }) };
  const bad = (await validateMeasure({ library: ["http://l"], ...cql("Lib.Here") }, "Measure", broken)).filter((i) => i.severity === "error");
  assert.equal(bad.length, 1);
  assert.match(bad[0].message, /^Error in http:\/\/l: '/);
});
