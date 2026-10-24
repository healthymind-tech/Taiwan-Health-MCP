/**
 * Unit tests for the authoring field list (fields.ts / fieldsTool.ts): synthetic
 * StructureDefinitions from fhirTestKit plus fake deps — no DB.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { CORE, COND_PROFILE, PAT_PROFILE, SDS, VITAL, el, fakeDeps, sd } from "../fhirTestKit.test.js";
import { expandComposeWith } from "../fhirCodeSystem.js";
import { AuthoringFieldsError, RESPONSE_MARGIN, SIZE_BUDGET, authoringFields, type FieldsDeps, type LoadedProfile } from "./fields.js";
import { makeFieldsTool } from "./fieldsTool.js";
import type { FieldSpec } from "./types.js";

type Res = Record<string, any>;

/** Fake deps over the test kit: profiles by canonical / id, examples per resource type, kit terminology. */
function deps(examples: Res[] = [], extraSds: Record<string, Res> = {}): FieldsDeps {
  const all = { ...SDS, ...extraSds };
  return {
    async loadProfile(profile): Promise<LoadedProfile> {
      const hit = all[profile.split("|")[0]] ?? Object.values(all).find((s) => s.id === profile);
      if (!hit) throw new AuthoringFieldsError("ARTIFACT_NOT_FOUND", `profile not found: ${profile}`);
      return { sd: hit, profileId: hit.id ?? hit.url.split("/").pop(), canonical: hit.url, packageId: "test.pkg", packageVersion: "1.0.0", provenance: { packageId: "test.pkg", version: "1.0.0", resolved_by: "package_arg" } };
    },
    async loadExamples(_p, rt) {
      return examples.filter((x) => x.resourceType === rt);
    },
    async expandValueSet(_p, vs, limit) {
      const v = fakeDeps();
      const vset = await v.loadValueSet(vs);
      if (!vset) return null;
      const exp = await expandComposeWith(vset.compose || {}, v, limit);
      return { codings: exp.codings, truncated: exp.truncated };
    },
    async resourceTypes(_p, canonicals) {
      const out = new Map<string, string>();
      for (const c of canonicals) if (all[c]?.type) out.set(c, all[c].type);
      return out;
    },
  };
}

const byField = (fields: FieldSpec[]): Record<string, FieldSpec> => Object.fromEntries(fields.map((f) => [f.field, f]));

const vitalExample = (extra: Res = {}): Res => ({
  resourceType: "Observation",
  meta: { profile: [VITAL] },
  status: "final",
  category: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category", code: "vital-signs" }] }],
  code: { coding: [{ system: "http://loinc.org", code: "8310-5" }] },
  subject: { reference: "Patient/1" },
  effectiveDateTime: "2024-01-01",
  valueQuantity: { value: 37, unit: "Cel", system: "http://unitsofmeasure.org", code: "Cel" },
  ...extra,
});

test("vital-sign profile: required / pinned / default / invariant fields with FHIR element-id paths", async () => {
  const res = await authoringFields({ profile: VITAL }, deps([vitalExample(), vitalExample(), vitalExample()]));
  assert.equal(res.profile.resourceType, "Observation");
  assert.equal(res.examples.basis, "profile");
  assert.equal(res.examples.count, 3);
  const f = byField(res.fields);
  // workflow default: auto, value, no code list
  assert.equal(f.status.source, "default");
  assert.equal(f.status.auto, true);
  assert.equal(f.status.value, "final");
  assert.equal(f.status.required, true);
  assert.ok(!f.status.binding?.codes);
  // the sliced base is covered by its required, fully pinned slice
  assert.ok(!f.category, "base category is redundant");
  assert.equal(f["category:VSCat"].source, "fixed");
  assert.equal(f["category:VSCat"].auto, true);
  assert.deepEqual(f["category:VSCat"].value, { coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category", code: "vital-signs" }] });
  assert.match(f["category:VSCat"].format || "", /^slice VSCat: value=observation-category\|vital-signs/);
  // code: required, from the record's coding
  assert.equal(f.code.required, true);
  assert.equal(f.code.source, "code");
  assert.equal(f.code.kind, "codeableConcept");
  // value[x]: invariant-implied, quantity, UCUM system pinned
  assert.equal(f["value[x]"].kind, "quantity");
  assert.equal(f["value[x]"].required, true);
  assert.match(f["value[x]"].why || "", /^invariant vs-2 .*only while component and hasMember are empty/);
  assert.deepEqual(f["value[x]"].pins, { system: "http://unitsofmeasure.org" });
  assert.deepEqual(f["value[x]"].example, { value: 12.5, unit: "<unit>" });
  // common-in-examples fields (not required in the profile)
  assert.equal(f.subject.required, false);
  assert.match(f.subject.why || "", /in 100% of IG examples/);
  assert.equal(f.subject.kind, "reference");
  assert.deepEqual(f.subject.example, { ref: "key" });
  assert.equal(f["effective[x]"].kind, "dateTime");
  // nothing is mustSupport in the kit profile
  assert.equal(res.more_count, 0);
  assert.equal(res.omitted, 0);
  assert.ok(res.size_chars <= SIZE_BUDGET);
});

test("fewer than 3 profile examples: statistics fall back to every example of the resource type", async () => {
  const other = vitalExample({ meta: { profile: ["http://example.tw/other"] }, subject: undefined });
  const res = await authoringFields({ profile: VITAL }, deps([vitalExample(), other, other, other]));
  assert.equal(res.examples.basis, "resource_type");
  assert.equal(res.examples.count, 4);
  const f = byField(res.fields);
  assert.ok(!f.subject, "subject is in 1 of 4 examples (25%) — not common");
  assert.ok(f["effective[x]"], "effective[x] is in every example");
});

test("patient profile: extension slice, small required binding, reference targets and facility source", async () => {
  const pat = (extra: Res = {}): Res => ({
    resourceType: "Patient",
    meta: { profile: [PAT_PROFILE] },
    identifier: [{ system: "http://moi.gov.tw", value: "A123456789" }],
    gender: "female",
    birthDate: "1990-01-01",
    managingOrganization: { reference: "Organization/1" },
    ...extra,
  });
  const bp = { extension: [{ url: CORE + "patient-birthPlace", valueAddress: { city: "Taipei" } }] };
  const res = await authoringFields({ profile: PAT_PROFILE }, deps([pat(bp), pat(bp), pat()]));
  const f = byField(res.fields);
  assert.equal(f.identifier.required, true);
  assert.equal(f.identifier.kind, "identifier");
  assert.equal(f.identifier.multiple, true);
  assert.match(f.identifier.format || "", /facility namespace/);
  assert.equal(f.gender.kind, "code");
  assert.equal(f.gender.source, "code");
  assert.deepEqual(
    f.gender.binding?.codes?.map((c) => c.code),
    ["male", "female", "other", "unknown"],
  );
  assert.equal(f.birthDate.kind, "date");
  assert.match(f.birthDate.format || "", /ROC/);
  assert.equal(f["extension:birthPlace"].kind, "other");
  assert.match(f["extension:birthPlace"].format || "", /^extension http:\/\/hl7\.org\/fhir\/StructureDefinition\/patient-birthPlace/);
  assert.match(f["extension:birthPlace"].why || "", /in 67% of IG examples/);
  assert.deepEqual(f.managingOrganization.targets, ["Organization"]);
  assert.equal(f.managingOrganization.source, "facility");
  assert.deepEqual(f.managingOrganization.example, { ref: "organization" });
});

test("condition profile: an optional workflow-default field is a hint, not auto; derived category; coding slices named", async () => {
  const ex: Res = { resourceType: "Condition", meta: { profile: [COND_PROFILE] }, clinicalStatus: { coding: [{ code: "active" }] }, subject: { reference: "Patient/1" } };
  const res = await authoringFields({ profile: COND_PROFILE }, deps([ex, ex, ex]));
  const f = byField(res.fields);
  // clinicalStatus is 0..1: the conventional value is shown, never filled by the MCP
  assert.equal(f.clinicalStatus.required, false);
  assert.equal(f.clinicalStatus.auto, undefined);
  assert.equal(f.clinicalStatus.value, undefined);
  assert.notEqual(f.clinicalStatus.source, "default");
  assert.match(f.clinicalStatus.format || "", /optional; conventional value "active" — give it only when the record states it \(not auto-filled\)/);
  assert.equal(f.clinicalStatus.example, "active");
  assert.equal(f.clinicalStatus.binding?.valueSet, "http://hl7.org/fhir/ValueSet/condition-clinical");
  assert.equal(f.category.source, "derived");
  assert.equal(f.category.auto, true);
  assert.match(f.category.format || "", /^MCP derives it: encounter-diagnosis/);
  assert.equal(f.code.required, false);
  assert.match(f.code.why || "", /^expected: the diagnosis itself/);
  assert.match(f.code.format || "", /coding slices by system: icd/);
  assert.equal(f.subject.required, true);
  assert.equal(res.examples.basis, "profile");
  const none = await authoringFields({ profile: COND_PROFILE }, deps());
  assert.equal(none.examples.basis, "none");
  assert.ok(!byField(none.fields).clinicalStatus, "neither required nor mustSupport nor common: not listed");
});

/** A profile with many mustSupport string elements, to exercise tiers and the size budget. */
const WIDE = "http://example.tw/fhir/StructureDefinition/wide";
const wideSd = (): Res => {
  const els = [el("Basic", 0, "*"), el("Basic.id", 0, "1", ["string"]), el("Basic.code", 1, "1", ["CodeableConcept"], { mustSupport: true })];
  for (let i = 1; i <= 70; i++) els.push(el(`Basic.f${String(i).padStart(2, "0")}`, 0, "1", ["string"], { mustSupport: true }));
  return { ...sd(WIDE, "Basic", "resource", els), id: "wide" };
};

test("tiers: mustSupport-only fields go to `more` ({field, kind}); include_more=false keeps the count only", async () => {
  const d = deps([], { [WIDE]: wideSd() });
  const res = await authoringFields({ profile: WIDE }, d);
  assert.deepEqual(res.fields.map((f) => f.field), ["code"]);
  assert.equal(res.more_count, 70);
  assert.equal(res.more?.length, 70);
  assert.deepEqual(res.more?.[0], { field: "f01", kind: "string" });
  const without = await authoringFields({ profile: WIDE, include_more: false }, d);
  assert.equal(without.more, undefined);
  assert.equal(without.more_count, 70);
});

test("size budget: common fields are moved to `more` until the output fits; nothing is dropped silently", async () => {
  const ex: Res = { resourceType: "Basic", meta: { profile: [WIDE] }, code: { text: "x" } };
  for (let i = 1; i <= 70; i++) ex[`f${String(i).padStart(2, "0")}`] = "v";
  const res = await authoringFields({ profile: WIDE }, deps([ex, ex, ex], { [WIDE]: wideSd() }));
  assert.ok(res.size_chars <= SIZE_BUDGET, `size ${res.size_chars}`);
  assert.ok(res.fields.length > 1, "some common fields stay fully described");
  assert.ok(res.fields.length < 71, "the rest moved to more");
  assert.equal(res.fields.length - 1 + (res.more?.length ?? 0) + res.omitted, 70);
  assert.equal(res.more_count, (res.more?.length ?? 0) + res.omitted);
  assert.equal(JSON.stringify({ profile: res.profile, fields: res.fields, more: res.more, more_count: res.more_count, omitted: res.omitted, examples: res.examples }).length, res.size_chars);
});

test("detail=full (compose engine): every tier-1 and tier-2 field fully described, no budget", async () => {
  const res = await authoringFields({ profile: WIDE, detail: "full" }, deps([], { [WIDE]: wideSd() }));
  assert.equal(res.fields.length, 71);
  assert.equal(res.more_count, 0);
  assert.equal(res.more, undefined);
  assert.ok(res.fields.every((f) => f.kind === "string" || f.kind === "codeableConcept"));
  assert.ok(res.fields.slice(1).every((f) => f.why === "mustSupport" && !f.required));
});

test("blood-pressure style slices: component slices carry pins, children and a shaped example; the base component is dropped", async () => {
  const BP = "http://example.tw/fhir/StructureDefinition/bp";
  const comp = (name: string, code: string): Res[] => [
    el(`Observation.component:${name}`, 1, "1", ["BackboneElement"], { mustSupport: true, constraint: [{ key: "vs-3", severity: "error", expression: "value.exists() or dataAbsentReason.exists()" }] }),
    el(`Observation.component:${name}.code`, 1, "1", ["CodeableConcept"]),
    el(`Observation.component:${name}.code.coding`, 1, "*", ["Coding"], { slicing: { discriminator: [{ type: "value", path: "code" }, { type: "value", path: "system" }], rules: "open" } }),
    el(`Observation.component:${name}.code.coding:Code`, 1, "1", ["Coding"]),
    el(`Observation.component:${name}.code.coding:Code.system`, 1, "1", ["uri"], { fixedUri: "http://loinc.org" }),
    el(`Observation.component:${name}.code.coding:Code.code`, 1, "1", ["code"], { fixedCode: code }),
    el(`Observation.component:${name}.value[x]`, 0, "1", ["Quantity"], { mustSupport: true }),
    el(`Observation.component:${name}.value[x].value`, 1, "1", ["decimal"]),
    el(`Observation.component:${name}.value[x].unit`, 1, "1", ["string"]),
    el(`Observation.component:${name}.value[x].system`, 1, "1", ["uri"], { fixedUri: "http://unitsofmeasure.org" }),
    el(`Observation.component:${name}.value[x].code`, 1, "1", ["code"], { fixedCode: "mm[Hg]" }),
    el(`Observation.component:${name}.dataAbsentReason`, 0, "1", ["CodeableConcept"], { mustSupport: true }),
  ];
  const bp = sd(BP, "Observation", "resource", [
    el("Observation", 0, "*"),
    el("Observation.status", 1, "1", ["code"]),
    el("Observation.code", 1, "1", ["CodeableConcept"]),
    el("Observation.subject", 1, "1", [], { type: [{ code: "Reference", targetProfile: [CORE + "Patient"] }] }),
    el("Observation.component", 2, "*", ["BackboneElement"], {
      mustSupport: true,
      slicing: { discriminator: [{ type: "value", path: "code.coding.code" }, { type: "value", path: "code.coding.system" }], rules: "open" },
    }),
    el("Observation.component.code", 1, "1", ["CodeableConcept"]),
    el("Observation.component.value[x]", 0, "1", ["Quantity", "string"]),
    ...comp("SystolicBP", "8480-6"),
    ...comp("DiastolicBP", "8462-4"),
  ]);
  const res = await authoringFields({ profile: BP }, deps([], { [BP]: { ...bp, id: "bp" } }));
  const f = byField(res.fields);
  assert.ok(!f.component, "base component covered by the two required slices");
  const s = f["component:SystolicBP"];
  assert.equal(s.kind, "component");
  assert.equal(s.required, true);
  assert.equal(s.why, "required slice");
  assert.deepEqual(s.pins, { code: { coding: [{ system: "http://loinc.org", code: "8480-6" }] }, valueQuantity: { system: "http://unitsofmeasure.org", code: "mm[Hg]" } });
  assert.match(s.format || "", /^slice SystolicBP: code\.coding\.code=8480-6, code\.coding\.system=loinc\.org; one component \(code pinned\); give \{value\} as quantity, unit mm\[Hg\]/);
  assert.deepEqual(s.example, { value: { value: 12.5, unit: "mm[Hg]" } });
  assert.deepEqual(
    s.children?.map((c) => [c.field, c.kind, c.required]),
    [
      ["component:SystolicBP.value[x]", "quantity", true],
      ["component:SystolicBP.dataAbsentReason", "codeableConcept", false],
    ],
  );
  assert.ok(!s.children?.[0].pins, "children of a pinned field carry no pins of their own");
  assert.deepEqual(f.subject.targets, ["Patient"]);
  assert.equal(f.subject.source, "record");
});

test("tool spec: envelope with size_chars + tool provenance; IG errors become error envelopes with hints", async () => {
  const tool = makeFieldsTool(deps([vitalExample(), vitalExample(), vitalExample()]));
  assert.equal(tool.name, "fhir_get_authoring_fields");
  assert.match(tool.description, /auto/);
  const ok = (await tool.handler({ profile: VITAL })) as Res;
  assert.equal(ok.ok, true);
  assert.equal(typeof ok.data.size_chars, "number");
  assert.equal(ok.data.size_chars, JSON.stringify({ ...ok.data, size_chars: undefined, response_chars: undefined }).length);
  assert.equal(ok.data.response_chars, JSON.stringify(ok).length);
  assert.equal(ok.provenance.tool, "fhir_get_authoring_fields");
  assert.equal(ok.provenance.resolved_by, "package_arg");
  assert.ok(Array.isArray(ok.data.more));
  const bad = (await tool.handler({ profile: "http://example.tw/nope" })) as Res;
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, "ARTIFACT_NOT_FOUND");
  assert.match(bad.error.hint, /fhir_list_resource_profiles/);
  const empty = (await tool.handler({ profile: "" })) as Res;
  assert.equal(empty.error.code, "INVALID_ARGUMENT");
});

// --------------------------------------------------------------------------- //
// v1.2: record links (R3) and the whole-response size budget (R4)
// --------------------------------------------------------------------------- //

const IGB = "http://example.tw/fhir/StructureDefinition/";
const ENC_LINK = `${IGB}enc-link`;
const encLinkSds = (): Record<string, Res> => ({
  [ENC_LINK]: {
    ...sd(ENC_LINK, "Encounter", "resource", [
      el("Encounter", 0, "*"),
      el("Encounter.id", 0, "1", ["string"]),
      el("Encounter.status", 1, "1", ["code"], { mustSupport: true }),
      el("Encounter.subject", 0, "1", [], { type: [{ code: "Reference", targetProfile: [`${IGB}pat-link`] }], mustSupport: true }),
      el("Encounter.participant", 0, "*", ["BackboneElement"]),
      el("Encounter.participant.individual", 1, "1", [], { type: [{ code: "Reference", targetProfile: [`${IGB}prac-link`] }] }),
      el("Encounter.reasonReference", 0, "*", [], { type: [{ code: "Reference", targetProfile: [`${IGB}cond-link`, `${CORE}Observation`] }] }),
      el("Encounter.diagnosis", 0, "*", ["BackboneElement"]),
      el("Encounter.diagnosis.id", 0, "1", ["string"]),
      el("Encounter.diagnosis.condition", 1, "1", [], { type: [{ code: "Reference", targetProfile: [`${IGB}cond-link`, `${CORE}Procedure`] }] }),
      el("Encounter.diagnosis.use", 0, "1", ["CodeableConcept"]),
      el("Encounter.diagnosis.rank", 0, "1", ["positiveInt"]),
      el("Encounter.account", 0, "*", [], { type: [{ code: "Reference", targetProfile: [`${CORE}Account`] }] }),
    ]),
    id: "enc-link",
  },
  [`${IGB}cond-link`]: sd(`${IGB}cond-link`, "Condition", "resource", [el("Condition", 0, "*")]),
  [`${IGB}pat-link`]: sd(`${IGB}pat-link`, "Patient", "resource", [el("Patient", 0, "*")]),
  [`${IGB}prac-link`]: sd(`${IGB}prac-link`, "Practitioner", "resource", [el("Practitioner", 0, "*")]),
  [`${CORE}Account`]: sd(`${CORE}Account`, "Account", "resource", [el("Account", 0, "*")]),
});

test("record links: a backbone whose required Reference child targets a record profile of the same IG is a field with children + {ref} example", async () => {
  const res = await authoringFields({ profile: ENC_LINK }, deps([], encLinkSds()));
  const f = byField(res.fields);
  assert.ok(f.diagnosis, "diagnosis listed although neither mustSupport nor in examples");
  assert.deepEqual(f.diagnosis.children?.map((c) => c.field), ["diagnosis.condition", "diagnosis.use", "diagnosis.rank"]);
  assert.deepEqual(f.diagnosis.example, { condition: { ref: "condition" } });
  assert.match(f.diagnosis.why ?? "", /links to Condition of this IG/);
  assert.deepEqual(byField(f.diagnosis.children!)["diagnosis.condition"].targets, ["Condition", "Procedure"]);
  // a backbone linking only actors (Practitioner) is not a record link; core-only targets (Account) neither
  assert.ok(!f.participant && !(res.more ?? []).some((m) => m.field === "participant"));
  assert.ok(!(res.more ?? []).some((m) => m.field === "account"));
  // a direct reference to a record profile of the IG is a `more` entry with its targets
  assert.deepEqual(res.more?.find((m) => m.field === "reasonReference"), { field: "reasonReference", kind: "reference", targets: ["Condition"] });
  // detail=full (compose engine) lists both fully
  const full = await authoringFields({ profile: ENC_LINK, detail: "full" }, deps([], encLinkSds()));
  assert.ok(byField(full.fields).diagnosis && byField(full.fields).reasonReference);
});

test("size budget: the WHOLE response (envelope, warnings, provenance; non-ASCII as \\uXXXX) stays under the budget", async () => {
  const ex: Res = { resourceType: "Basic", meta: { profile: [WIDE] }, code: { text: "x" } };
  for (let i = 1; i <= 70; i++) ex[`f${String(i).padStart(2, "0")}`] = "v";
  const tool = makeFieldsTool(deps([ex, ex, ex], { [WIDE]: wideSd() }));
  const out = (await tool.handler({ profile: WIDE })) as Res;
  const text = JSON.stringify(out);
  const escaped = text.length + 5 * [...text].filter((ch) => ch.charCodeAt(0) > 0x7e).length;
  assert.equal(out.data.response_chars, escaped, "response_chars measures the full response");
  assert.ok(escaped <= SIZE_BUDGET - RESPONSE_MARGIN, `response ${escaped}`);
  assert.ok(out.data.more_count > 0, "the rest moved to more / omitted");
  // non-ASCII content (here: resolution warnings in Chinese) counts as 6-char escapes and is budgeted too
  const d = deps([ex, ex, ex], { [WIDE]: wideSd() });
  const load = d.loadProfile;
  d.loadProfile = async (...a) => ({ ...(await load(...a)), warnings: ["套件解析備註：".repeat(40)] });
  const out2 = (await makeFieldsTool(d).handler({ profile: WIDE })) as Res;
  const text2 = JSON.stringify(out2);
  const escaped2 = text2.length + 5 * [...text2].filter((ch) => ch.charCodeAt(0) > 0x7e).length;
  assert.equal(out2.data.response_chars, escaped2);
  assert.ok(escaped2 <= SIZE_BUDGET - RESPONSE_MARGIN, `response ${escaped2}`);
  assert.ok(out2.data.fields.length < out.data.fields.length, "the warnings' size moved more fields out");
});
