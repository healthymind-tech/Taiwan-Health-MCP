/**
 * ISSUES_v20 R5 — record-derivable elements in fhir_get_minimal_skeleton (value_source "derivable" with a
 * derive rule + record cue) and fhir_get_authoring_fields (source "derived", never auto), over synthetic
 * StructureDefinitions: base bindings, an IG ValueSet whose codes match by display, and one without such
 * codes (stays a coded element).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { el, sd } from "../fhirTestKit.test.js";
import { fakeDeps } from "./fakeDeps.test.js";
import { minimalSkeleton, skeletonModel } from "./skeleton.js";
import { authoringFields, AuthoringFieldsError, type FieldsDeps, type LoadedProfile } from "../authoring/fields.js";
import { derivableCodes, RECORD_DERIVABLE } from "../recordDerivable.js";

type R = Record<string, any>;
const B = "http://example.org/fhir/StructureDefinition/";
const VS_VER = "http://hl7.org/fhir/ValueSet/condition-ver-status";
const VS_INTERP = "http://hl7.org/fhir/ValueSet/observation-interpretation";
const VS_MRCAT = "http://hl7.org/fhir/ValueSet/medicationrequest-category";
const VS_IG_CAT = "http://example.org/fhir/ValueSet/rx-setting";
const VS_IG_OTHER = "http://example.org/fhir/ValueSet/rx-kind";

const rows = (d: R): Map<string, [string, string]> => new Map((d.table as Array<[string, string, string]>).map(([p, s, h]) => [p, [s, h]]));

const cond = sd(B + "Cond-r", "Condition", "resource", [
  el("Condition", 0, "*"),
  el("Condition.verificationStatus", 1, "1", ["CodeableConcept"], { binding: { strength: "required", valueSet: VS_VER + "|4.0.1" } }),
  el("Condition.code", 1, "1", ["CodeableConcept"]),
  el("Condition.subject", 1, "1", [], { type: [{ code: "Reference", targetProfile: [B + "Pat"] }] }),
], { id: "Cond-r" });
const obs = sd(B + "Obs-r", "Observation", "resource", [
  el("Observation", 0, "*"),
  el("Observation.status", 1, "1", ["code"]),
  el("Observation.code", 1, "1", ["CodeableConcept"]),
  el("Observation.interpretation", 1, "*", ["CodeableConcept"], { binding: { strength: "extensible", valueSet: VS_INTERP } }),
], { id: "Obs-r" });
const mrIg = sd(B + "MR-ig", "MedicationRequest", "resource", [
  el("MedicationRequest", 0, "*"),
  el("MedicationRequest.category", 1, "*", ["CodeableConcept"], { binding: { strength: "required", valueSet: VS_IG_CAT } }),
], { id: "MR-ig" });
const mrOther = sd(B + "MR-other", "MedicationRequest", "resource", [
  el("MedicationRequest", 0, "*"),
  el("MedicationRequest.category", 1, "*", ["CodeableConcept"], { binding: { strength: "required", valueSet: VS_IG_OTHER } }),
], { id: "MR-other" });

const VALUE_SETS = {
  [VS_VER]: ["confirmed", "provisional", "differential", "unconfirmed", "refuted", "entered-in-error"].map((code) => ({ system: "http://terminology.hl7.org/CodeSystem/condition-ver-status", code })),
  [VS_IG_CAT]: [
    { system: "http://example.org/cs/rx-setting", code: "OPD", display: "門診處方" },
    { system: "http://example.org/cs/rx-setting", code: "DIS", display: "出院帶藥" },
  ],
  [VS_IG_OTHER]: [
    { system: "http://example.org/cs/rx-kind", code: "chronic", display: "慢性病連續處方" },
    { system: "http://example.org/cs/rx-kind", code: "normal", display: "一般處方" },
  ],
};
// every example writes "confirmed": still derivable from the record, never an example constant
const condEx = (i: number): R => ({ resourceType: "Condition", id: `c${i}`, meta: { profile: [B + "Cond-r"] }, verificationStatus: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-ver-status", code: "confirmed" }] }, code: { text: `dx${i}` } });

test("R5 skeleton: verificationStatus / interpretation / an IG category ValueSet are derivable with rule + cue", async () => {
  const deps = fakeDeps([cond, obs, mrIg, mrOther], { valueSets: VALUE_SETS, examples: [condEx(1), condEx(2), condEx(3)] });
  const c = rows((await minimalSkeleton({ profile: "Cond-r" }, deps)).data);
  assert.equal(c.get("verificationStatus")?.[0], "derivable", "the record's diagnosis field decides it, not the IG's examples");
  assert.match(c.get("verificationStatus")![1], /^derive from the record: confirmed if the diagnosis field/);
  assert.match(c.get("verificationStatus")![1], /provisional if hedged/);
  assert.match(c.get("verificationStatus")![1], /\(record cue: the diagnosis field\)/);
  const model = await skeletonModel({ profile: "Cond-r" }, deps);
  const it = model.items.find((x) => x.path === "verificationStatus")!;
  assert.equal(it.derive?.cue, RECORD_DERIVABLE["Condition.verificationStatus"].cue);

  const o = rows((await minimalSkeleton({ profile: "Obs-r" }, deps)).data);
  assert.equal(o.get("interpretation")?.[0], "derivable");
  assert.match(o.get("interpretation")![1], /H \/ ↑ \/ \(H\) = H/);
  assert.match(o.get("interpretation")![1], /inside = N\)/);

  // an IG ValueSet: its codes matched by display (門診 → OPD, 出院 → DIS), named in the rule
  const m = rows((await minimalSkeleton({ profile: "MR-ig" }, deps)).data);
  assert.equal(m.get("category")?.[0], "derivable");
  assert.match(m.get("category")![1], /this binding's codes: discharge = DIS, outpatient = OPD/);
  // a category ValueSet without a setting code: not derivable (a plain code-lookup)
  const n = rows((await minimalSkeleton({ profile: "MR-other" }, deps)).data);
  assert.equal(n.get("category")?.[0], "code-lookup");
});

test("R5 derivableCodes: base binding, IG display matches, none", () => {
  const rd = RECORD_DERIVABLE["MedicationRequest.category"];
  assert.deepEqual([...derivableCodes(rd, VS_MRCAT + "|4.0.1", null)!.keys()], ["discharge", "outpatient", "inpatient"]);
  assert.equal(derivableCodes(rd, VS_IG_CAT, VALUE_SETS[VS_IG_CAT])!.get("discharge")!.code, "DIS");
  assert.equal(derivableCodes(rd, VS_IG_CAT, null), null, "an IG ValueSet that cannot be expanded is not assumed");
  assert.equal(derivableCodes(rd, VS_IG_OTHER, VALUE_SETS[VS_IG_OTHER]), null);
});

// ---- authoring fields ---------------------------------------------------------------------------

const CORE_VS: Record<string, R> = {};
function fieldsDeps(sds: R[]): FieldsDeps {
  return {
    async loadProfile(profile): Promise<LoadedProfile> {
      const hit = sds.find((s) => s.url === profile || s.id === profile);
      if (!hit) throw new AuthoringFieldsError("ARTIFACT_NOT_FOUND", profile);
      return { sd: hit, profileId: hit.id, canonical: hit.url, packageId: "t", packageVersion: "1" };
    },
    async loadExamples() {
      return [];
    },
    async expandValueSet(_p, vs) {
      const codes = (VALUE_SETS as Record<string, Array<{ system: string; code: string; display?: string }>>)[vs.split("|")[0]] ?? CORE_VS[vs];
      return codes ? { codings: codes.map((c) => ({ system: c.system, code: c.code, display: c.display ?? null })), truncated: false } : null;
    },
    async resourceTypes() {
      return new Map();
    },
  };
}

const condOpt = sd(B + "Cond-o", "Condition", "resource", [
  el("Condition", 0, "*"),
  el("Condition.clinicalStatus", 0, "1", ["CodeableConcept"], { mustSupport: true, binding: { strength: "required", valueSet: "http://hl7.org/fhir/ValueSet/condition-clinical" } }),
  el("Condition.verificationStatus", 0, "1", ["CodeableConcept"], { mustSupport: true, binding: { strength: "required", valueSet: VS_VER } }),
  el("Condition.code", 1, "1", ["CodeableConcept"]),
], { id: "Cond-o" });
const obsOpt = sd(B + "Obs-o", "Observation", "resource", [
  el("Observation", 0, "*"),
  el("Observation.status", 1, "1", ["code"]),
  el("Observation.code", 1, "1", ["CodeableConcept"]),
  el("Observation.interpretation", 0, "*", ["CodeableConcept"], { mustSupport: true, binding: { strength: "extensible", valueSet: VS_INTERP } }),
], { id: "Obs-o" });
const mrOpt = sd(B + "MR-o", "MedicationRequest", "resource", [
  el("MedicationRequest", 0, "*"),
  el("MedicationRequest.category", 0, "*", ["CodeableConcept"], { mustSupport: true, binding: { strength: "example", valueSet: VS_MRCAT } }),
  el("MedicationRequest.courseOfTherapyType", 0, "1", ["CodeableConcept"], { mustSupport: true, binding: { strength: "example", valueSet: "http://hl7.org/fhir/ValueSet/medicationrequest-course-of-therapy" } }),
], { id: "MR-o" });

test("R5 authoring fields: record-derivable fields are source 'derived' without auto, listed in tier 1, with the derive rule", async () => {
  const d = fieldsDeps([condOpt, obsOpt, mrOpt, cond, mrOther]);
  const cr = await authoringFields({ profile: "Cond-o" }, d);
  const f = Object.fromEntries(cr.fields.map((x) => [x.field, x]));
  assert.equal(f.verificationStatus.source, "derived");
  assert.equal(f.verificationStatus.auto, undefined, "never auto-filled: the model writes it from the record");
  assert.match(f.verificationStatus.format || "", /^derive from the record: confirmed if the diagnosis field/);
  assert.match(f.verificationStatus.format || "", /give it whenever the record carries the cue \(not auto-filled\)/);
  assert.doesNotMatch(f.verificationStatus.format || "", /only when the record states it/);
  assert.equal(f.verificationStatus.example, "confirmed");
  // clinicalStatus (mustSupport too) is not record-derivable: it stays a tier-2 `more` field
  assert.ok(!f.clinicalStatus && cr.more?.some((x) => x.field === "clinicalStatus"));
  const full = Object.fromEntries((await authoringFields({ profile: "Cond-o", detail: "full" }, d)).fields.map((x) => [x.field, x]));
  assert.match(full.clinicalStatus.format || "", /give it only when the record states it/);

  const o = Object.fromEntries((await authoringFields({ profile: "Obs-o" }, d)).fields.map((x) => [x.field, x]));
  assert.equal(o.interpretation.source, "derived");
  assert.equal(o.interpretation.auto, undefined, "previously auto ('MCP derives it') although the composer never derived it");
  assert.match(o.interpretation.format || "", /the record's reference range \(above = H, below = L, inside = N\)/);

  const m = await authoringFields({ profile: "MR-o" }, d);
  const mf = Object.fromEntries(m.fields.map((x) => [x.field, x]));
  assert.equal(mf.category.source, "derived");
  assert.match(mf.category.format || "", /出院帶藥 .*= discharge; 門診 \/ OPD = outpatient.*\(record cue: the heading the medication is listed under, else the visit setting\)/);
  // another curated derivation (not record-derivable) is unchanged: mustSupport only → `more`
  assert.ok(!mf.courseOfTherapyType && m.more?.some((x) => x.field === "courseOfTherapyType"));

  // required + workflow default: the default stays the MCP's fallback, the derive rule is added
  const r = Object.fromEntries((await authoringFields({ profile: "Cond-r" }, d)).fields.map((x) => [x.field, x]));
  assert.equal(r.verificationStatus.source, "default");
  assert.equal(r.verificationStatus.auto, true);
  assert.match(r.verificationStatus.format || "", /^derive from the record: .*\(the default applies only when you give nothing\)/);

  // neither mustSupport nor common: still listed (the profile allows it, any cardinality), with why
  const plain = sd(B + "Obs-p", "Observation", "resource", [
    el("Observation", 0, "*"),
    el("Observation.code", 1, "1", ["CodeableConcept"]),
    el("Observation.interpretation", 0, "*", ["CodeableConcept"], { binding: { strength: "extensible", valueSet: VS_INTERP } }),
    el("Observation.note", 0, "*", ["Annotation"]),
  ], { id: "Obs-p" });
  const p = Object.fromEntries((await authoringFields({ profile: "Obs-p" }, fieldsDeps([plain]))).fields.map((x) => [x.field, x]));
  assert.equal(p.interpretation?.source, "derived");
  assert.match(p.interpretation?.why || "", /record-derivable/);
  assert.ok(!p.note, "other optional elements stay unlisted");

  // a binding without a setting code: a plain coded field
  const n = Object.fromEntries((await authoringFields({ profile: "MR-other" }, d)).fields.map((x) => [x.field, x]));
  assert.equal(n.category.source, "code");
  assert.doesNotMatch(n.category.format || "", /derive from the record/);
});
