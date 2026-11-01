/**
 * fhir_get_bundle_form v1.2 over synthetic profiles: profile invariants turned into form structure
 * from their FHIRPath alone — choose-one (slices a `where()` admits / `a or b or c` alternatives),
 * conditional required (`A or (x and y)` whose condition reads a placeholder -> required_if), a
 * rule the prefilled values decide (`x implies …` -> required) with `format` from `all(matches())`,
 * a Bundle-level rule relating two entries, and an unparsed rule attached raw.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { el, sd } from "../fhirTestKit.test.js";
import { evaluateConstraint } from "../fhirPath.js";
import { bundleForm, getAt, type FormPlaceholder } from "./form.js";
import { fakeDeps } from "./fakeDeps.test.js";
import { _internal } from "./formRules.js";

const B = "http://example.org/fhir/StructureDefinition/";
type R = Record<string, any>;

const idSlice = (n: string, code: string, sys: string, extra: R = {}): R[] => [
  el(`Patient.identifier:${n}`, 0, "1", ["Identifier"], { sliceName: n, baseMax: "*", mustSupport: true, ...extra }),
  el(`Patient.identifier:${n}.type`, 1, "1", ["CodeableConcept"]),
  el(`Patient.identifier:${n}.type.coding`, 1, "*", ["Coding"], { baseMax: "*" }),
  el(`Patient.identifier:${n}.type.coding.system`, 1, "1", ["uri"], { patternUri: "http://x/idtype" }),
  el(`Patient.identifier:${n}.type.coding.code`, 1, "1", ["code"], { patternCode: code }),
  el(`Patient.identifier:${n}.system`, 0, "1", ["uri"], { patternUri: sys }),
  el(`Patient.identifier:${n}.value`, 0, "1", ["string"]),
];
const PAT = sd(B + "Pat", "Patient", "resource", [
  el("Patient", 0, "*", [], {
    constraint: [
      { key: "pid-1", severity: "error", human: "a national id or a passport number", expression: "identifier.where(type.coding.where(system = 'http://x/idtype' and (code = 'NI' or code = 'PP')).exists()).exists()" },
      { key: "pc-1", severity: "error", human: "a way to reach the patient", expression: "telecom.exists() or address.exists() or contact.exists()" },
    ],
  }),
  el("Patient.identifier", 1, "*", ["Identifier"], { baseMax: "*", slicing: { discriminator: [{ type: "value", path: "type.coding.code" }], rules: "open" } }),
  el("Patient.identifier.system", 0, "1", ["uri"]),
  el("Patient.identifier.value", 0, "1", ["string"]),
  ...idSlice("nid", "NI", "http://x/nid", { constraint: [{ key: "nid-1", severity: "error", human: "1 letter + 9 digits", expression: "value.matches('^[A-Z][0-9]{9}$')" }] }),
  ...idSlice("pp", "PP", "http://x/pp"),
  el("Patient.telecom", 0, "*", ["ContactPoint"], { baseMax: "*" }),
  el("Patient.address", 0, "*", ["Address"], { baseMax: "*" }),
  el("Patient.contact", 0, "*", ["BackboneElement"], { baseMax: "*" }),
], { id: "Pat" });

const MR = sd(B + "MR", "MedicationRequest", "resource", [
  el("MedicationRequest", 0, "*", [], {
    constraint: [
      { key: "ord-1", severity: "error", human: "dose text and supply duration unless the order is a material (3)", expression: "category.coding.where(system = 'http://x/ot' and code = '3').exists() or (dosageInstruction.text.exists() and dispenseRequest.expectedSupplyDuration.exists())" },
      { key: "mat-1", severity: "error", human: "material code: M + 3 digits", expression: "medication.ofType(CodeableConcept).exists() implies (medication.ofType(CodeableConcept).coding.where(system = 'http://x/mat').exists() and medication.ofType(CodeableConcept).coding.where(system = 'http://x/mat').all(code.matches('^M[0-9]{3}$')))" },
      { key: "raw-1", severity: "error", human: "an unparsed rule", expression: "category.coding.code.exists() implies subject.resolve().is(Patient)" },
    ],
  }),
  el("MedicationRequest.status", 1, "1", ["code"], { fixedCode: "active" }),
  el("MedicationRequest.category", 1, "1", ["CodeableConcept"], { baseMax: "*" }),
  el("MedicationRequest.category.coding", 1, "1", ["Coding"], { baseMax: "*" }),
  el("MedicationRequest.category.coding.system", 1, "1", ["uri"], { fixedUri: "http://x/ot" }),
  el("MedicationRequest.category.coding.code", 1, "1", ["code"], { binding: { strength: "required", valueSet: "http://x/vs/ot" } }),
  el("MedicationRequest.medication[x]", 1, "1", ["CodeableConcept"]),
  el("MedicationRequest.medication[x].coding", 0, "*", ["Coding"], { baseMax: "*" }),
  el("MedicationRequest.medication[x].text", 1, "1", ["string"]),
  el("MedicationRequest.subject", 1, "1", [], { type: [{ code: "Reference", targetProfile: [B + "Pat"] }] }),
  el("MedicationRequest.dosageInstruction", 0, "*", ["Dosage"], { baseMax: "*" }),
  el("MedicationRequest.dosageInstruction.text", 0, "1", ["string"]),
  el("MedicationRequest.dispenseRequest", 0, "1", ["BackboneElement"]),
  el("MedicationRequest.dispenseRequest.expectedSupplyDuration", 0, "1", ["Duration"]),
  el("MedicationRequest.dispenseRequest.expectedSupplyDuration.system", 0, "1", ["uri"], { patternUri: "http://unitsofmeasure.org" }),
  el("MedicationRequest.dispenseRequest.expectedSupplyDuration.code", 0, "1", ["code"], { patternCode: "d" }),
], { id: "MR" });

const COV = sd(B + "Cov", "Coverage", "resource", [
  el("Coverage", 0, "*"),
  el("Coverage.status", 1, "1", ["code"], { fixedCode: "active" }),
  el("Coverage.type", 1, "1", ["CodeableConcept"]),
  el("Coverage.type.coding", 1, "1", ["Coding"], { baseMax: "*" }),
  el("Coverage.type.coding.system", 1, "1", ["uri"], { fixedUri: "http://x/cov" }),
  el("Coverage.type.coding.code", 1, "1", ["code"], { binding: { strength: "required", valueSet: "http://x/vs/cov" } }),
  el("Coverage.beneficiary", 1, "1", [], { type: [{ code: "Reference", targetProfile: [B + "Pat"] }] }),
], { id: "Cov" });

const ENC = sd(B + "Enc", "Encounter", "resource", [
  el("Encounter", 0, "*"),
  el("Encounter.status", 1, "1", ["code"], { fixedCode: "finished" }),
  el("Encounter.class", 1, "1", ["Coding"], { patternCoding: { system: "http://x/cls", code: "AMB" } }),
  el("Encounter.subject", 1, "1", [], { type: [{ code: "Reference", targetProfile: [B + "Pat"] }] }),
  el("Encounter.identifier", 0, "*", ["Identifier"], { baseMax: "*", slicing: { discriminator: [{ type: "value", path: "system" }], rules: "open" } }),
  el("Encounter.identifier:seq", 0, "1", ["Identifier"], { sliceName: "seq", baseMax: "*" }),
  el("Encounter.identifier:seq.system", 1, "1", ["uri"], { patternUri: "http://x/seq" }),
  el("Encounter.identifier:seq.value", 1, "1", ["string"], { maxLength: 4 }),
], { id: "Enc" });

const entrySlice = (name: string, type: string, profile: string): R[] => [
  el(`Bundle.entry:${name}`, 1, "1", [], { sliceName: name, baseMax: "*" }),
  el(`Bundle.entry:${name}.resource`, 1, "1", [], { type: [{ code: type, profile: [profile] }] }),
];
const BUNDLE = sd(B + "Bundle-rules", "Bundle", "resource", [
  el("Bundle", 0, "*", [], {
    constraint: [
      { key: "bnd-1", severity: "error", human: "an NHI coverage needs the visit sequence number", expression: "entry.resource.ofType(Coverage).where(type.coding.where(code = 'NHI').exists()).exists() implies entry.resource.ofType(Encounter).identifier.where(system = 'http://x/seq').exists()" },
    ],
  }),
  el("Bundle.type", 1, "1", ["code"], { fixedCode: "collection" }),
  el("Bundle.entry", 1, "*", ["BackboneElement"], { baseMax: "*", slicing: { discriminator: [{ type: "profile", path: "resource" }], rules: "closed" } }),
  el("Bundle.entry.fullUrl", 0, "1", ["uri"]),
  el("Bundle.entry.resource", 0, "1", ["Resource"]),
  ...entrySlice("pat", "Patient", B + "Pat"),
  ...entrySlice("mr", "MedicationRequest", B + "MR"),
  ...entrySlice("cov", "Coverage", B + "Cov"),
  ...entrySlice("enc", "Encounter", B + "Enc"),
], { id: "Bundle-rules" });

const VALUE_SETS = {
  "http://x/vs/ot": ["1", "3"].map((code) => ({ system: "http://x/ot", code })),
  "http://x/vs/cov": ["NHI", "SELF"].map((code) => ({ system: "http://x/cov", code })),
};
const deps = (): ReturnType<typeof fakeDeps> => fakeDeps([BUNDLE, PAT, MR, COV, ENC], { valueSets: VALUE_SETS });

async function form(): Promise<{ data: R; entries: R[]; ph: FormPlaceholder[]; idx: (rt: string) => number }> {
  const { data } = await bundleForm({ bundle_profile: "Bundle-rules" }, deps());
  const entries = (data.bundle as R).entry as R[];
  return { data, entries, ph: data.placeholders as FormPlaceholder[], idx: (rt) => entries.findIndex((e) => e.resource.resourceType === rt) };
}

test("v1.2 parser: chains, terms (exists / all(matches) / toString().matches / all(exists))", () => {
  const t1 = _internal.parseTerm("dosageInstruction.doseAndRate.dose.ofType(Quantity).value.all(toString().matches('^[0-9]{1,8}$'))")!;
  assert.equal(t1.kind, "format");
  const t2 = _internal.parseTerm("coding.where(system = 'x').all(code.matches('^a$'))")!;
  assert.equal(t2.kind, "format");
  assert.deepEqual((t2 as { leaf: string[] }).leaf, ["code"]);
  const t3 = _internal.parseTerm("dosageInstruction.where(timing.code.coding.where(code = 'X').exists()).all(method.exists())")!;
  assert.equal(t3.kind, "allExists");
  assert.equal(_internal.parseTerm("subject.resolve().is(Patient)"), null, "not a requirement term");
  assert.equal(_internal.parseTerm("category.exists(coding.code = 'x')")!.kind, "exists");
});

test("v1.2 choose-one: one of the slices a where() admits is placed, with every option listed", async () => {
  const { entries, ph, idx } = await form();
  const i = idx("Patient");
  const ids = entries[i].resource.identifier as R[];
  assert.equal(ids.length, 1, "never more than one option (the generic placeholder identifier is replaced)");
  assert.equal(ids[0].type.coding[0].code, "NI");
  assert.equal(ids[0].system, "http://x/nid");
  const value = ph.find((p) => p.pointer === `/entry/${i}/resource/identifier/0/value`)!;
  assert.ok(value.choose_one, "the option's placeholder carries choose_one");
  assert.equal(value.choose_one!.rule.key, "pid-1");
  assert.equal(value.choose_one!.rule.human, "a national id or a passport number");
  assert.deepEqual(value.choose_one!.options.map((o) => [o.path, Boolean(o.chosen)]), [["Patient.identifier:nid", true], ["Patient.identifier:pp", false]]);
  assert.equal(value.format, "^[A-Z][0-9]{9}$", "the slice's own matches() rule");
});

test("v1.2 choose-one: `a.exists() or b.exists() or c.exists()` — the first alternative placed, the others named", async () => {
  const { entries, ph, idx } = await form();
  const i = idx("Patient");
  const pat = entries[i].resource;
  assert.ok(Array.isArray(pat.telecom) && pat.telecom.length === 1);
  assert.equal(pat.address, undefined);
  assert.equal(pat.contact, undefined);
  const tel = ph.filter((p) => p.pointer.startsWith(`/entry/${i}/resource/telecom/0`));
  assert.ok(tel.length >= 1);
  for (const p of tel) {
    assert.equal(p.choose_one?.rule.key, "pc-1");
    assert.deepEqual(p.choose_one!.options.map((o) => o.path), ["telecom", "address", "contact"]);
    assert.equal(p.choose_one!.options.find((o) => o.chosen)?.path, "telecom");
  }
});

test("v1.2 conditional: `A or (x and y)` whose A reads a placeholder -> required_if (required=false, when, element, if_empty)", async () => {
  const { entries, ph, idx } = await form();
  const i = idx("MedicationRequest");
  const mr = entries[i].resource;
  const text = ph.find((p) => p.pointer === `/entry/${i}/resource/dosageInstruction/0/text`)!;
  const dur = ph.filter((p) => p.pointer.startsWith(`/entry/${i}/resource/dispenseRequest/expectedSupplyDuration`));
  assert.ok(text && dur.length, "both required elements placed");
  assert.equal(mr.dispenseRequest.expectedSupplyDuration.system, "http://unitsofmeasure.org", "pattern children of the added element");
  for (const p of [text, ...dur]) {
    assert.equal(p.required, false);
    assert.ok(p.if_empty);
    assert.equal(p.required_if!.rule.key, "ord-1");
    assert.equal(p.required_if!.when.context, `/entry/${i}/resource`);
  }
  assert.equal(text.required_if!.element, `/entry/${i}/resource/dosageInstruction`);
  const catCode = ph.findIndex((p) => p.pointer === `/entry/${i}/resource/category/0/coding/0/code`);
  assert.ok(text.required_if!.placeholders!.includes(catCode), "the condition's placeholder is named");
  // the condition decided by the filled value
  const filled = JSON.parse(JSON.stringify(mr));
  const holds = (code: string): string => {
    filled.category[0].coding[0].code = code;
    return evaluateConstraint(filled, "MedicationRequest", text.required_if!.when.expression, { resource: filled, rootResource: filled }).status;
  };
  assert.equal(holds("1"), "pass");
  assert.equal(holds("3"), "fail");
});

test("v1.2 decided by the form + format: `CC.exists() implies (coding.where(system=S).exists() and …all(code.matches(re)))`", async () => {
  const { entries, ph, idx } = await form();
  const i = idx("MedicationRequest");
  const cc = entries[i].resource.medicationCodeableConcept;
  assert.equal(cc.coding.length, 1);
  assert.equal(cc.coding[0].system, "http://x/mat", "the system the where() equality names");
  const code = ph.find((p) => p.pointer === `/entry/${i}/resource/medicationCodeableConcept/coding/0/code`)!;
  assert.equal(code.required, true, "the condition (a CodeableConcept) holds in the form: plainly required");
  assert.equal(code.required_if, undefined);
  assert.equal(code.format, "^M[0-9]{3}$");
  assert.deepEqual(code.format_rule, { key: "mat-1", human: "material code: M + 3 digits" });
});

test("v1.2 Bundle-level rule: the target entry gets the element, required_if evaluated on the Bundle", async () => {
  const { data, entries, ph, idx } = await form();
  const e = idx("Encounter");
  const c = idx("Coverage");
  const ids = entries[e].resource.identifier as R[];
  const k = ids.findIndex((x) => x.system === "http://x/seq");
  assert.ok(k >= 0, "the slice the where() admits");
  const v = ph.find((p) => p.pointer === `/entry/${e}/resource/identifier/${k}/value`)!;
  assert.equal(v.required, false);
  assert.equal(v.max_length, 4);
  assert.equal(v.required_if!.rule.key, "bnd-1");
  assert.equal(v.required_if!.when.context, "");
  assert.equal(v.required_if!.element, `/entry/${e}/resource/identifier/${k}`);
  const covCode = ph.findIndex((p) => p.pointer === `/entry/${c}/resource/type/coding/0/code`);
  assert.deepEqual(v.required_if!.placeholders, [covCode]);
  const filled = JSON.parse(JSON.stringify(data.bundle));
  for (const [code, want] of [["NHI", "pass"], ["SELF", "fail"]]) {
    filled.entry[c].resource.type.coding[0].code = code;
    assert.equal(evaluateConstraint(filled, "Bundle", v.required_if!.when.expression, { resource: filled, rootResource: filled }).status, want, code);
  }
  assert.deepEqual(data.self_check, { ok: true });
});

test("v1.2 an expression not parsed confidently is attached raw to the placeholder it reads", async () => {
  const { ph, idx } = await form();
  const i = idx("MedicationRequest");
  const cat = ph.find((p) => p.pointer === `/entry/${i}/resource/category/0/coding/0/code`)!;
  assert.ok((cat.rules || []).some((r) => r.startsWith("raw-1: ")), JSON.stringify(cat.rules));
  assert.ok(getAt({ a: [1] }, "/a/0") === 1);
});
