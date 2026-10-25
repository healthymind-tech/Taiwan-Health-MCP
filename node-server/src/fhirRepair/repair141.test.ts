/**
 * ISSUES_v14.1 rules of the shared repair layer, over synthetic StructureDefinitions and in-memory
 * collaborators (no DB): site timezone (argument / site_config, IANA), UCUM equivalence /
 * annotation / micro sign / LOINC-as-unit, ValueSet-named and renamed system URLs, R6 shapes
 * (wrapped Coding, code as CodeableConcept, choice-container and up-from-item moves, empty
 * elements), required fixed slices, the Bundle envelope (resourceType, numbered entries, duplicate
 * fullUrls, entry properties) and the Bundle-level verification.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { syntheticDatatypeSd } from "../authoring/values.js";
import { bundleEnvelopeProblem, cloneTree, repairBundle, repairBundleEnvelope, repairResource, siteConfigTimezone, siteTimezone, type RepairDeps } from "./index.js";
import { offsetFor, parseTimezone } from "./timezone.js";
import { resolveUnit, ucumEquivalent } from "./ucumUnits.js";
import { nameSimilarity } from "./systems.js";

type El = Record<string, any>;
const CORE = "http://hl7.org/fhir/StructureDefinition/";
const UCUM = "http://unitsofmeasure.org";
const LOINC = "http://loinc.org";
const SCT = "http://snomed.info/sct";
const THO = "http://terminology.hl7.org/CodeSystem/";
const EX = "http://example.org/fhir/";

function el(id: string, min: number, max: string, types: string[] = [], extra: El = {}): El {
  const path = id.replace(/:[^.]+/g, "");
  return { id, path, min, max, base: { path, min, max: extra.baseMax ?? max }, ...(types.length ? { type: types.map((code) => ({ code })) } : {}), ...extra };
}
function sd(url: string, type: string, elements: El[], kind = "resource"): El {
  return { resourceType: "StructureDefinition", url, type, kind, snapshot: { element: elements } };
}
const domain = (rt: string): El[] => [el(`${rt}.id`, 0, "1", ["id"]), el(`${rt}.meta`, 0, "1", ["Meta"]), el(`${rt}.text`, 0, "1", ["Narrative"])];

const obsCore = (url: string, extra: El[] = []): El =>
  sd(url, "Observation", [
    el("Observation", 0, "*"),
    ...domain("Observation"),
    el("Observation.status", 1, "1", ["code"]),
    el("Observation.category", 0, "*", ["CodeableConcept"]),
    el("Observation.code", 1, "1", ["CodeableConcept"]),
    el("Observation.effective[x]", 0, "1", ["dateTime", "Period"]),
    el("Observation.issued", 0, "1", ["instant"]),
    el("Observation.value[x]", 0, "1", ["Quantity", "CodeableConcept", "string"]),
    ...extra,
  ]);

const SDS: Record<string, El> = {
  [CORE + "Observation"]: obsCore(CORE + "Observation"),
  [CORE + "Patient"]: sd(CORE + "Patient", "Patient", [el("Patient", 0, "*"), ...domain("Patient"), el("Patient.gender", 0, "1", ["code"]), el("Patient.birthDate", 0, "1", ["date"])]),
  [CORE + "Encounter"]: sd(CORE + "Encounter", "Encounter", [
    el("Encounter", 0, "*"),
    ...domain("Encounter"),
    el("Encounter.status", 1, "1", ["code"]),
    el("Encounter.class", 1, "1", ["Coding"]),
    el("Encounter.type", 0, "*", ["CodeableConcept"]),
    el("Encounter.period", 0, "1", ["Period"]),
    el("Encounter.hospitalization", 0, "1", ["BackboneElement"]),
    el("Encounter.hospitalization.admitSource", 0, "1", ["CodeableConcept"]),
  ]),
  [CORE + "AllergyIntolerance"]: sd(CORE + "AllergyIntolerance", "AllergyIntolerance", [
    el("AllergyIntolerance", 0, "*"),
    ...domain("AllergyIntolerance"),
    el("AllergyIntolerance.reaction", 0, "*", ["BackboneElement"]),
    el("AllergyIntolerance.reaction.severity", 0, "1", ["code"], { binding: { strength: "required", valueSet: "http://hl7.org/fhir/ValueSet/reaction-event-severity|4.0.1" } }),
  ]),
  [CORE + "MedicationRequest"]: sd(CORE + "MedicationRequest", "MedicationRequest", [
    el("MedicationRequest", 0, "*"),
    ...domain("MedicationRequest"),
    el("MedicationRequest.status", 1, "1", ["code"]),
    el("MedicationRequest.dosageInstruction", 0, "*", ["Dosage"]),
  ]),
  [CORE + "Bundle"]: sd(CORE + "Bundle", "Bundle", [
    el("Bundle", 0, "*"),
    el("Bundle.id", 0, "1", ["id"]),
    el("Bundle.type", 1, "1", ["code"]),
    el("Bundle.entry", 0, "*", ["BackboneElement"]),
    el("Bundle.entry.fullUrl", 0, "1", ["uri"]),
    el("Bundle.entry.resource", 0, "1", ["Resource"]),
    el("Bundle.entry.request", 0, "1", ["BackboneElement"]),
    el("Bundle.entry.request.method", 1, "1", ["code"]),
    el("Bundle.entry.request.url", 1, "1", ["uri"]),
  ]),
  [EX + "RespRate"]: obsCore(EX + "RespRate", [
    el("Observation.value[x]:valueQuantity", 0, "1", ["Quantity"], { sliceName: "valueQuantity" }),
    el("Observation.value[x]:valueQuantity.system", 1, "1", ["uri"], { fixedUri: UCUM }),
    el("Observation.value[x]:valueQuantity.code", 1, "1", ["code"], { fixedCode: "/min" }),
  ]),
  // Two required codings in code.coding, each fixed by its children (like a pulse-oximetry profile).
  [EX + "PulseOx"]: obsCore(EX + "PulseOx", [
    el("Observation.code.coding", 0, "*", ["Coding"], { slicing: { discriminator: [{ type: "value", path: "code" }, { type: "value", path: "system" }], rules: "open" } }),
    el("Observation.code.coding:SatCode", 1, "1", ["Coding"], { sliceName: "SatCode" }),
    el("Observation.code.coding:SatCode.system", 1, "1", ["uri"], { fixedUri: LOINC }),
    el("Observation.code.coding:SatCode.code", 1, "1", ["code"], { fixedCode: "2708-6" }),
    el("Observation.code.coding:PulseOx", 1, "1", ["Coding"], { sliceName: "PulseOx" }),
    el("Observation.code.coding:PulseOx.system", 1, "1", ["uri"], { fixedUri: LOINC }),
    el("Observation.code.coding:PulseOx.code", 1, "1", ["code"], { fixedCode: "59408-5" }),
    // a required slice that is NOT fully determined (no code fixed): never added
    el("Observation.code.coding:Other", 0, "1", ["Coding"], { sliceName: "Other" }),
  ]),
};
// Slices of the PulseOx profile need the base element in the snapshot order (code before its coding).
SDS[EX + "PulseOx"].snapshot.element.sort((a: El, b: El) => (a.id.startsWith("Observation.code.coding") ? 1 : 0) - (b.id.startsWith("Observation.code.coding") ? 1 : 0));

const CODES: Record<string, Record<string, string[]>> = {
  [LOINC]: { "8310-5": ["Body temperature"], "9279-1": ["Respiratory rate"], "2708-6": ["Oxygen saturation in Arterial blood"], "59408-5": ["Oxygen saturation in Arterial blood by Pulse oximetry"] },
  [SCT]: { "44054006": ["Diabetes mellitus type 2"] },
  [THO + "admit-source"]: { emd: ["From accident/emergency department"] },
  [THO + "v3-GTSAbbreviation"]: { BID: ["BID"] },
  [THO + "v3-ActCode"]: { AMB: ["ambulatory"] },
  [THO + "condition-clinical"]: { active: ["Active"] },
  [THO + "allergyintolerance-clinical"]: { active: ["Active"] },
};

function deps(extra: Partial<RepairDeps> = {}): RepairDeps {
  return {
    fetchStructureDefinition: async (url) => {
      const u = url.split("|")[0];
      if (SDS[u]) return SDS[u];
      return u.startsWith(CORE) ? syntheticDatatypeSd(u.slice(CORE.length)) : null;
    },
    lookupDisplay: async (system, code) => CODES[system]?.[code]?.[0] ?? null,
    checkDisplay: async () => ({ status: "ok", valid: [] }),
    expandValueSet: async (url) => {
      const u = url.split("|")[0];
      if (u === "http://hl7.org/fhir/ValueSet/reaction-event-severity")
        return { codings: ["mild", "moderate", "severe"].map((c) => ({ system: "http://hl7.org/fhir/reaction-event-severity", code: c, display: c[0].toUpperCase() + c.slice(1) })), total: 3, truncated: false };
      if (u === "http://hl7.org/fhir/ValueSet/condition-code") return { codings: [], total: 0, truncated: true, incomplete: true };
      return null;
    },
    valueSetContains: async (url, system, code) => (url.split("|")[0] === "http://hl7.org/fhir/ValueSet/condition-code" ? system === SCT && code in CODES[SCT] : undefined),
    valueSetSystems: async (url) => (url.split("|")[0] === "http://hl7.org/fhir/ValueSet/condition-code" ? [SCT] : []),
    resolveSystem: async (url) => {
      if (CODES[url] || url === UCUM) return { kind: "codesystem" };
      if (url === "http://hl7.org/fhir/condition-code" || url === "http://hl7.org/fhir/ValueSet/condition-code") return { kind: "valueset", valueSet: "http://hl7.org/fhir/ValueSet/condition-code" };
      return /^https?:\/\/(hl7\.org|terminology\.hl7\.org)\//.test(url) ? { kind: "unknown", codeSystemTwin: null } : { kind: "other" };
    },
    codeInSystem: async (system, code) => (CODES[system] ? code in CODES[system] : undefined),
    codeSystemDirectory: async () =>
      Object.keys(CODES)
        .filter((u) => u.startsWith(THO))
        .map((u) => ({ url: u, names: [u.slice(THO.length)] })),
    codeSystemsWithCode: async (code) => Object.keys(CODES).filter((s) => code in CODES[s]),
    ...extra,
  };
}

const obs = (more: El): El => ({ resourceType: "Observation", status: "final", code: { coding: [{ system: LOINC, code: "8310-5" }] }, ...more });

test("timezone: argument / site_config / source_text site section; offsets and IANA zones; never guessed", () => {
  assert.deepEqual(parseTimezone("+8"), { kind: "offset", value: "+08:00" });
  assert.deepEqual(parseTimezone("UTC+08:00"), { kind: "offset", value: "+08:00" });
  assert.deepEqual(parseTimezone("Asia/Taipei"), { kind: "iana", value: "Asia/Taipei" });
  assert.equal(parseTimezone("Taipei"), null);
  assert.equal(offsetFor({ kind: "iana", value: "Asia/Taipei" }, "2026-10-03T16:05:00"), "+08:00");
  assert.equal(offsetFor({ kind: "iana", value: "America/New_York" }, "2026-07-01T12:00:00"), "-04:00");
  assert.equal(offsetFor({ kind: "iana", value: "America/New_York" }, "2026-03-08T02:30:00"), null, "a wall time skipped by DST does not exist");
  assert.equal(offsetFor({ kind: "iana", value: "America/New_York" }, "2026-11-01T01:30:00"), null, "a repeated wall time is ambiguous");
  assert.deepEqual(siteConfigTimezone("院所設定\n- 本院病歷號 identifier.system：https://h.example.tw/mrn\n- 時區：+08:00（台灣）"), { timezone: "+08:00", source: "site_config" });
  assert.equal(siteConfigTimezone("timezone: Asia/Taipei").timezone, "Asia/Taipei");
  assert.match(String(siteConfigTimezone("時區：+08:00\ntimezone: +09:00").problem), /several timezones/);
  assert.equal(siteConfigTimezone("病歷號 system: https://h.example.tw/mrn").timezone, null);
  assert.equal(siteTimezone({ timezone: "+09:00", siteConfig: "時區：+08:00" }).timezone, "+09:00", "the argument wins");
  assert.equal(siteTimezone({ sourceText: "主訴：發燒\n時區：+05:00\n【院所設定】\n- 時區：+08:00\n【病歷】…" }).timezone, "+08:00", "only the site-config section of source_text counts");
  assert.match(String(siteTimezone({ timezone: "Mars/Olympus" }).problem), /not a UTC offset/);
});

test("R3 / item 5: ROC and Gregorian date-times without an offset take the site timezone (rule timezone); else reported", async () => {
  const roc = obs({ effectiveDateTime: "115-10-03T16:05:00", issued: "2026-10-03T17:00" });
  const r = await repairResource(roc, deps(), { timezone: "Asia/Taipei", timezoneSource: "site_config" });
  assert.equal(roc.effectiveDateTime, "2026-10-03T16:05:00+08:00");
  assert.equal(roc.issued, "2026-10-03T17:00:00+08:00");
  assert.deepEqual(r.changes.map((c) => c.rule), ["roc-date", "timezone"]);
  assert.match(r.changes[1].reason, /site timezone Asia\/Taipei \(site_config\)/);
  const none = obs({ effectiveDateTime: "2026-10-03T16:05:00", issued: "115-10-03T17:00:00" });
  const r2 = await repairResource(none, deps());
  assert.deepEqual(r2.changes, []);
  assert.equal(none.effectiveDateTime, "2026-10-03T16:05:00");
  assert.deepEqual(r2.issues.map((i) => [i.rule, i.code]), [["timezone", "timezone-required"], ["roc-date", "timezone-required"]]);
  assert.match(r2.issues[0].message, /site_config line `timezone: \+08:00`/);
  // a valid value and a date-only value are untouched; an offset written stays
  const ok = obs({ effectiveDateTime: "2026-10-03T16:05:00-05:00" });
  assert.deepEqual((await repairResource(ok, deps(), { timezone: "+08:00" })).changes, []);
  const p: El = { resourceType: "Patient", birthDate: "2026-10-03" };
  assert.deepEqual((await repairResource(p, deps(), { timezone: "+08:00" })).changes, []);
});

test("R2: UCUM equivalents, body-surface annotation, micro sign, LOINC code without a unit", async () => {
  assert.equal(resolveUnit("mL/min/1.73m2")?.code, "mL/min/{1.73_m2}");
  assert.equal(resolveUnit("mL/min/1.73 m²")?.code, "mL/min/{1.73_m2}");
  assert.equal(resolveUnit("μIU/mL")?.code, "u[IU]/mL");
  assert.equal(resolveUnit("µg/dL")?.code, "ug/dL");
  assert.equal(resolveUnit("mg/24h")?.code, "mg/(24.h)");
  assert.ok(ucumEquivalent("1/min", "/min") && ucumEquivalent("{beats}/min", "/min"));
  assert.ok(!ucumEquivalent("Cel", "K") && !ucumEquivalent("g", "kg"));
  const rr = obs({ meta: { profile: [EX + "RespRate"] }, code: { coding: [{ system: LOINC, code: "9279-1" }] }, valueQuantity: { value: 18, unit: "breaths/min", system: UCUM, code: "1/min" } });
  const r = await repairResource(rr, deps());
  assert.equal(rr.valueQuantity.code, "/min");
  assert.match(r.changes[0].reason, /same UCUM unit as '\/min' \(conversion factor 1\)/);
  const free = obs({ valueQuantity: { value: 1, unit: "1/min", system: UCUM, code: "1/min" } });
  assert.deepEqual((await repairResource(free, deps())).changes, [], "unconstrained: a valid code stays");
  const egfr = obs({ valueQuantity: { value: 78, unit: "mL/min/1.73m2" } });
  await repairResource(egfr, deps());
  assert.deepEqual(egfr.valueQuantity, { value: 78, unit: "mL/min/1.73m2", system: UCUM, code: "mL/min/{1.73_m2}" });
  const loinc = obs({ valueQuantity: { value: 37.2, system: UCUM, code: "8310-5" } });
  const rl = await repairResource(loinc, deps());
  assert.deepEqual(rl.changes, []);
  assert.equal(rl.issues[0].code, "quantity-code-not-ucum");
  assert.match(rl.issues[0].message, /valueQuantity\.code .* holds a LOINC code \('8310-5'\), not a UCUM unit, and no unit is given; give the unit/);
  const fixed = obs({ meta: { profile: [EX + "RespRate"] }, valueQuantity: { value: 18, code: "9279-1" } });
  const rf = await repairResource(fixed, deps());
  assert.equal(fixed.valueQuantity.code, "/min", "the profile fixes the only unit allowed");
  assert.match(rf.changes[0].reason, /LOINC code, not a unit; the profile fixes the unit/);
});

test("R5: ValueSet URLs without /ValueSet/, ValueSet-named and renamed CodeSystem URLs (unique holder only)", async () => {
  assert.equal(nameSimilarity("admitsource", "admitsource"), 1);
  assert.equal(nameSimilarity("gts", "gtsabbreviation"), 0.85);
  const vs: El = { resourceType: "Observation", status: "final", code: { coding: [{ system: "http://hl7.org/fhir/condition-code", code: "44054006" }] } };
  await repairResource(vs, deps());
  assert.equal(vs.code.coding[0].system, SCT);
  const admit: El = { resourceType: "Encounter", status: "finished", class: { system: THO + "v3-ActCode", code: "AMB" }, hospitalization: { admitSource: { coding: [{ system: THO + "v3-AdmitSource", code: "emd" }] } } };
  const ra = await repairResource(admit, deps());
  assert.equal(admit.hospitalization.admitSource.coding[0].system, THO + "admit-source");
  assert.match(ra.changes[0].reason, /renamed \/ retired name/);
  const gts: El = { resourceType: "Encounter", status: "finished", class: { system: THO + "v3-ActCode", code: "AMB" }, type: [{ coding: [{ system: THO + "v3-GTS", code: "BID" }] }] };
  await repairResource(gts, deps());
  assert.equal(gts.type[0].coding[0].system, THO + "v3-GTSAbbreviation");
  // two similarly named CodeSystems hold the code: not decidable
  const two: El = { resourceType: "Encounter", status: "finished", class: { system: THO + "v3-ActCode", code: "AMB" }, type: [{ coding: [{ system: THO + "clinical", code: "active" }] }] };
  const d = deps({ codeSystemDirectory: async () => [{ url: THO + "condition-clinical", names: ["clinical"] }, { url: THO + "allergyintolerance-clinical", names: ["clinical"] }] });
  const rt = await repairResource(two, d);
  assert.equal(two.type[0].coding[0].system, THO + "clinical");
  assert.deepEqual(rt.changes, []);
  // the code is not in the similarly named CodeSystem: not changed
  const miss: El = { resourceType: "Encounter", status: "finished", class: { system: THO + "v3-ActCode", code: "AMB" }, type: [{ coding: [{ system: THO + "v3-AdmitSource", code: "zzz" }] }] };
  assert.deepEqual((await repairResource(miss, deps())).changes, []);
});

test("R6: wrapped Coding, code as CodeableConcept, choice-container / up-from-item moves, empty elements", async () => {
  const e: El = { resourceType: "Encounter", status: "finished", class: { type: { coding: [{ system: THO + "v3-ActCode", code: "AMB", display: "ambulatory" }] } }, period: {}, hospitalization: { admitSource: {} } };
  const r = await repairResource(e, deps());
  assert.deepEqual(e, { resourceType: "Encounter", status: "finished", class: { system: THO + "v3-ActCode", code: "AMB", display: "ambulatory" } });
  assert.deepEqual(r.changes.map((c) => c.rule).sort(), ["empty", "empty", "empty", "shape"]);
  const a: El = { resourceType: "AllergyIntolerance", reaction: [{ severity: { coding: [{ system: "http://hl7.org/fhir/reaction-event-severity", code: "moderate", display: "Moderate" }] } }] };
  await repairResource(a, deps());
  assert.equal(a.reaction[0].severity, "moderate");
  const lossy: El = { resourceType: "AllergyIntolerance", reaction: [{ severity: { coding: [{ code: "moderate" }], text: "rather bad" } }] };
  const rl = await repairResource(lossy, deps());
  assert.deepEqual(rl.changes, []);
  assert.match(rl.issues[0].message, /is a code .*'rather bad' would be lost/);
  const notIn: El = { resourceType: "AllergyIntolerance", reaction: [{ severity: { coding: [{ code: "fatal" }] } }] };
  assert.deepEqual((await repairResource(notIn, deps())).changes, []);
  const mr: El = { resourceType: "MedicationRequest", status: "active", dosageInstruction: [{ doseAndRate: [{ doseQuantity: { value: 1 }, unit: "tab", timing: { repeat: { frequency: 2, period: 1, periodUnit: "d" } } }] }] };
  const rm = await repairResource(mr, deps());
  assert.deepEqual(mr.dosageInstruction[0].timing, { repeat: { frequency: 2, period: 1, periodUnit: "d" } });
  assert.equal(mr.dosageInstruction[0].doseAndRate[0].doseQuantity.unit, "tab");
  assert.ok(rm.changes.some((c) => c.path === "MedicationRequest.dosageInstruction[0].doseAndRate[0].doseQuantity.unit"));
  const nulls: El = { resourceType: "Patient", gender: "", birthDate: null, _birthDate: { extension: [{ url: EX + "x", valueString: "kept" }] } };
  await repairResource(nulls, deps());
  assert.deepEqual(nulls, { resourceType: "Patient", birthDate: null, _birthDate: { extension: [{ url: EX + "x", valueString: "kept" }] } }, "a null with its _x extensions is kept");
});

test("fixed-slice: a required coding slice the profile fully fixes is added; undetermined slices never", async () => {
  const o = obs({ meta: { profile: [EX + "PulseOx"] }, code: { coding: [{ system: LOINC, code: "2708-6" }] } });
  const r = await repairResource(o, deps());
  assert.deepEqual(o.code.coding, [{ system: LOINC, code: "2708-6" }, { system: LOINC, code: "59408-5" }]);
  assert.equal(r.changes.length, 1);
  assert.equal(r.changes[0].rule, "fixed-slice");
  assert.equal(r.changes[0].path, "Observation.code.coding[1]");
  const again = await repairResource(o, deps());
  assert.deepEqual(again.changes, [], "idempotent");
});

test("Bundle envelope: missing resourceType, numbered entry keys, duplicate fullUrls, entry properties", async () => {
  const p = (g: string): El => ({ resourceType: "Patient", gender: g });
  const noRt: El = { type: "collection", entry: [{ fullUrl: "urn:uuid:11111111-1111-4111-8111-111111111111", resource: p("male") }] };
  assert.match(String(bundleEnvelopeProblem(noRt)), /no resourceType \(at resourceType\)/);
  assert.match(String(bundleEnvelopeProblem({ resourceType: "Patient" })), /its resourceType is "Patient"/);
  assert.equal(repairBundleEnvelope(noRt).changes[0].path, "Bundle.resourceType");
  assert.equal(noRt.resourceType, "Bundle");
  const notBundle: El = { entry: [{ item: { reference: "Patient/1" } }] };
  repairBundleEnvelope(notBundle);
  assert.equal(notBundle.resourceType, undefined, "List-like entries do not make a Bundle");
  const numbered: El = { resourceType: "Bundle", type: "collection", "entry[2]": { resource: p("female") }, "entry[1]": { resource: p("male") } };
  const rn = await repairBundle(numbered, deps());
  assert.deepEqual(numbered.entry.map((x: El) => x.resource.gender), ["male", "female"]);
  assert.ok(!("entry[1]" in numbered));
  assert.equal(rn.changes.filter((c) => c.rule === "shape").length, 2);
  const clash: El = { resourceType: "Bundle", type: "collection", entry: [{ resource: p("male") }], entry0: { resource: p("female") } };
  const rc = await repairBundle(clash, deps());
  assert.ok("entry0" in clash);
  assert.match(rc.issues[0].message, /falls inside the existing entry array/);
  const url = "urn:uuid:11111111-1111-4111-8111-111111111111";
  const dupe: El = { resourceType: "Bundle", type: "collection", entry: [{ fullUrl: url, resource: p("male") }, { fullUrl: url, resource: p("male") }] };
  const rd = await repairBundle(dupe, deps());
  assert.equal(dupe.entry.length, 1);
  assert.match(rd.changes[0].reason, /deep-equal/);
  const differ: El = { resourceType: "Bundle", type: "collection", entry: [{ fullUrl: url, resource: p("male") }, { fullUrl: url, resource: p("female") }] };
  const rdf = await repairBundle(differ, deps());
  assert.equal(differ.entry.length, 2);
  assert.match(rdf.issues[0].message, /resources differ \(bdl-7\); not merged/);
  const req: El = { resourceType: "Bundle", type: "transaction", entry: [{ fullUrl: url, resource: { ...p("male"), request: { method: "POST", url: "Patient" } } }] };
  await repairBundle(req, deps());
  assert.deepEqual(req.entry[0], { fullUrl: url, resource: p("male"), request: { method: "POST", url: "Patient" } });
});

test("Bundle-level verification: a change that adds an error only the Bundle context shows is withdrawn", async () => {
  // Fake validator: stand-alone resources are clean; the Bundle gets a (reference-style) error when
  // entry[1]'s Observation has the timezone added (as a Bundle-only rule would report it).
  const validate = async (res: El): Promise<Array<{ severity: string; path: string; message: string }>> => {
    if (res.resourceType !== "Bundle") return [];
    const o = res.entry?.[1]?.resource;
    return o && /\+08:00$/.test(String(o.effectiveDateTime)) ? [{ severity: "error", path: "Bundle.entry[0].resource", message: "Bundle-only rule broken by entry[1]" }] : [];
  };
  const b: El = {
    resourceType: "Bundle",
    type: "collection",
    entry: [
      { fullUrl: "urn:uuid:11111111-1111-4111-8111-111111111111", resource: { resourceType: "Patient", gender: "male", birthDate: "115/10/03" } },
      { fullUrl: "urn:uuid:22222222-2222-4222-8222-222222222222", resource: obs({ effectiveDateTime: "2026-10-03T16:05:00" }) },
    ],
  };
  const r = await repairBundle(b, deps({ validate }), { timezone: "+08:00" });
  assert.equal(b.entry[1].resource.effectiveDateTime, "2026-10-03T16:05:00", "withdrawn");
  assert.equal(b.entry[0].resource.birthDate, "2026-10-03", "the unrelated repair stays");
  assert.ok(r.issues.some((i) => /not applied: .*would leave the Bundle with an error.*Bundle-only rule/.test(i.message)), JSON.stringify(r.issues));
  const again = cloneTree(b);
  assert.deepEqual((await repairBundle(again, deps({ validate }), { timezone: "+08:00" })).changes, [], "idempotent once withdrawn");
});
