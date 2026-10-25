/**
 * ISSUES_v15.2 — search and validation agree (synthetic data, no DB):
 *   - relatedness of concepts (conceptSearch/related.ts) and the ConceptIndex helpers it reads;
 *   - acceptance verdicts (codeAcceptance.ts) and the bundled terminology-server tables (txCodeTables.ts);
 *   - the Unknown-code suggestion gate (no unrelated replacement) and the accepted alternative coding;
 *   - the finalize repair rule alt-coding (fhirRepair/alternatives.ts).
 */

import fs from "node:fs";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { ConceptIndex } from "./conceptSearch/engine.js";
import { conceptProfile, relatedness, strengths, textProfile } from "./conceptSearch/related.js";
import { acceptanceOf, confirmCoding } from "./codeAcceptance.js";
import { setTxCodeTablesForTest, txCodeVerdict } from "./txCodeTables.js";
import type { PackageRow } from "./fhirIg.js";
import type { CodeCheck } from "./fhirValidator.js";
import { suggestUnknownCode } from "./fhirSuggestions/codes.js";
import { suggestAlternativeCoding } from "./fhirSuggestions/bindings.js";
import type { CodeAlternatives, SuggestionDeps } from "./fhirSuggestions/types.js";
import { repairResource, type RepairDeps } from "./fhirRepair/index.js";
import { syntheticDatatypeSd } from "./authoring/values.js";

type El = Record<string, any>;
const CS = "http://example.org/fhir/CodeSystem/drug";
const ALT = "http://example.org/fhir/CodeSystem/substance";
const CORE = "http://hl7.org/fhir/StructureDefinition/";
const PROFILE = "http://example.org/fhir/StructureDefinition/DrugOrder";
const VS_DRUG = "http://example.org/fhir/ValueSet/drug";
const VS_ALT = "http://example.org/fhir/ValueSet/substance";

/** A synthetic drug CodeSystem: names with dose forms everywhere, a few substances, a linked substance code each. */
function drugIndex(): ConceptIndex {
  const rows: Array<[string, string, string, string]> = [
    ["D001", "Zorvanil Tablets 5mg", "ZORVANIL 5 MG", "S01"],
    ["D002", "Zorvanil Tablets 10mg", "ZORVANIL 10 MG", "S01"],
    ["D003", "Qelmarin Tablets 5mg", "QELMARIN 5 MG", "S02"],
    ["D004", "Pexadrol Capsules 500mg", "PEXADROL 500 MG", "S03"],
    ["D005", "Zorvanil + Qelmarin Tablets 5mg/5mg", "ZORVANIL 5 MG + QELMARIN 5 MG", "S09"],
  ];
  // Filler concepts so that dose-form words are common and substances rare.
  for (let i = 0; i < 300; i++) rows.push([`F${i}`, `Filler${i} Tablets ${i % 7}mg`, `FILLER${i}`, `S${100 + i}`]);
  return new ConceptIndex(
    rows.map(([code, display, ingredient, sub]) => ({
      code,
      display,
      terms: [
        { text: display, lang: "en", kind: "display" as const },
        { text: ingredient, lang: null, kind: "property" as const },
      ],
      info: { links: [{ system: ALT, code: sub }] },
    })),
  );
}

test("ConceptIndex: terms of a concept and concept frequency of a word", () => {
  const idx = drugIndex();
  const ci = idx.indexOf("D001")!;
  assert.ok(idx.termsOf(ci).some((t) => t.text === "ZORVANIL 5 MG" && t.kind === "property"));
  assert.equal(idx.conceptFrequency("zorvanil"), 3);
  assert.ok(idx.conceptFrequency("tablet") > 250, "dose form words are common");
  assert.equal(idx.conceptFrequency("nosuchword"), 0);
});

test("related: same linked code + strength → related; another linked code, another strength, only a dose form → not", () => {
  const idx = drugIndex();
  const p = (code: string, label: string | null = null) => conceptProfile(idx, code, [label])!;
  assert.equal(relatedness(p("D001"), p("D001"), idx).related, true);
  const other = relatedness(p("D001"), p("D003"), idx);
  assert.equal(other.related, false, "a different substance");
  assert.match(other.why, /different/);
  assert.equal(relatedness(p("D001"), p("D002"), idx).related, false, "same substance, different strength");
  assert.equal(relatedness(p("D001"), p("D005"), idx).related, false, "a combination has another linked code");
  // Text only (no linked codes): a shared rare word relates, a shared dose form does not.
  assert.equal(relatedness(textProfile("Zorvanil 5mg"), textProfile("ZORVANIL TABLETS 5MG"), idx).related, true);
  assert.equal(relatedness(textProfile("Zorvanil 5mg"), textProfile("Pexadrol Tablets 5mg"), idx).related, false);
  assert.equal(relatedness(textProfile("Zorvanil 5mg"), textProfile("Zorvanil 10mg"), idx).related, false);
  assert.deepEqual([...strengths(["0.5 g", "500mg", "100 U/mL"])].sort(), ["100u", "500mg"]);
});

test("acceptance: the validator's code check → accepted / rejected / undecided", () => {
  assert.equal(acceptanceOf({ status: "ok" }, "p#1").accepted, true);
  const bad = acceptanceOf({ status: "invalid-code", severity: "error", message: "Unknown code 'X' in the CodeSystem 'S'" }, "p#1");
  assert.equal(bad.accepted, false);
  assert.match(String(bad.reason), /Unknown code 'X'.*p#1/);
  assert.equal(acceptanceOf({ status: "invalid-code", severity: "warning", message: "w" }, "p#1").accepted, true);
  assert.equal(acceptanceOf({ status: "silent" }, "p#1").accepted, null);
});

test("terminology-server table: known / unknown / not covered; confirmCoding uses it for a system not held", async () => {
  setTxCodeTablesForTest({ [ALT]: { edition: "2099", known: ["S01"], unknown: ["S77"], displayVerified: [] } });
  try {
    assert.deepEqual(txCodeVerdict(ALT, "S01"), { known: true, edition: "2099", displayVerified: false });
    assert.equal(txCodeVerdict(ALT, "S77")?.known, false);
    assert.equal(txCodeVerdict(ALT, "S99"), null);
    const pkg = { package_id: "p", version: "1" } as unknown as PackageRow;
    const silent = async (): Promise<CodeCheck> => ({ status: "silent" });
    assert.equal((await confirmCoding(silent, pkg, ALT, "S01", "p#1")).accepted, true);
    const rejected = await confirmCoding(silent, pkg, ALT, "S77", "p#1");
    assert.equal(rejected.accepted, false);
    assert.match(String(rejected.reason), /version '2099'/);
    assert.equal((await confirmCoding(silent, pkg, ALT, "S99", "p#1")).accepted, null, "no evidence → undecided, never accepted");
  } finally {
    setTxCodeTablesForTest(null);
  }
});

test("bundled terminology-server table: well formed (known and unknown disjoint), read through the accessor", () => {
  const file = fileURLToPath(new URL("../data/terminology/atc-tx-check.json.gz", import.meta.url));
  const t = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString("utf8"));
  assert.equal(t.system, "http://www.whocc.no/atc");
  assert.ok(t.known.length > 1000 && t.unknown.length > 0);
  const known = new Set(t.known);
  assert.ok(!t.unknown.some((c: string) => known.has(c)));
  assert.ok(t.display_verified.every((c: string) => known.has(c)));
  setTxCodeTablesForTest(null);
  assert.equal(txCodeVerdict(t.system, t.known[0])?.known, true);
  assert.equal(txCodeVerdict(t.system, t.unknown[0])?.known, false);
  assert.equal(txCodeVerdict(t.system, "__no_such_code__"), null);
});

// --------------------------------------------------------------------------- suggestions

function el(id: string, min: number, max: string, types: string[] = [], extra: El = {}): El {
  const path = id.replace(/:[^.]+/g, "");
  return { id, path, min, max, base: { path, min, max }, ...(types.length ? { type: types.map((code) => ({ code })) } : {}), ...extra };
}

const SDS: Record<string, El> = {
  [CORE + "MedicationRequest"]: {
    resourceType: "StructureDefinition", url: CORE + "MedicationRequest", type: "MedicationRequest", kind: "resource", derivation: "specialization",
    snapshot: { element: [el("MedicationRequest", 0, "*"), el("MedicationRequest.id", 0, "1", ["id"]), el("MedicationRequest.meta", 0, "1", ["Meta"]), el("MedicationRequest.status", 1, "1", ["code"]), el("MedicationRequest.medication[x]", 1, "1", ["CodeableConcept", "Reference"])] },
  },
  [PROFILE]: {
    resourceType: "StructureDefinition", url: PROFILE, type: "MedicationRequest", kind: "resource", derivation: "constraint",
    snapshot: {
      element: [
        el("MedicationRequest", 0, "*"),
        el("MedicationRequest.id", 0, "1", ["id"]),
        el("MedicationRequest.meta", 0, "1", ["Meta"]),
        el("MedicationRequest.status", 1, "1", ["code"]),
        el("MedicationRequest.medication[x]", 1, "1", ["CodeableConcept", "Reference"], { slicing: { discriminator: [{ type: "type", path: "$this" }], rules: "closed" } }),
        el("MedicationRequest.medication[x]:medicationCodeableConcept", 0, "1", ["CodeableConcept"], { sliceName: "medicationCodeableConcept" }),
        el("MedicationRequest.medication[x]:medicationCodeableConcept.coding", 0, "*", ["Coding"], { slicing: { discriminator: [{ type: "pattern", path: "$this" }], rules: "open" } }),
        el("MedicationRequest.medication[x]:medicationCodeableConcept.coding:drug", 0, "1", ["Coding"], { sliceName: "drug", binding: { strength: "required", valueSet: VS_DRUG } }),
        el("MedicationRequest.medication[x]:medicationCodeableConcept.coding:substance", 0, "1", ["Coding"], { sliceName: "substance", binding: { strength: "required", valueSet: VS_ALT } }),
        el("MedicationRequest.medication[x]:medicationCodeableConcept.text", 0, "1", ["string"]),
      ],
    },
  },
};

/** The validated copy holds D003 / D004 only (an excerpt); D001 is defined in a fuller copy. */
const EXCERPT = new Set(["D003", "D004"]);
const known: Record<string, CodeAlternatives> = {
  D001: { display: "Zorvanil Tablets 5mg", definedIn: "ex.full#2", inValidatedCopy: false, alternatives: [{ system: ALT, code: "S01", display: "zorvanil", accepted: true }] },
  D009: { display: "Mixed product", definedIn: "ex.full#2", inValidatedCopy: false, alternatives: [{ system: ALT, code: "S01", display: "zorvanil", accepted: true }, { system: ALT, code: "S02", display: "qelmarin", accepted: true }] },
};

function sdeps(over: Partial<SuggestionDeps> = {}): SuggestionDeps {
  const idx = drugIndex();
  return {
    fetchStructureDefinition: async (url) => SDS[url.split("|")[0]] ?? (url.startsWith(CORE) ? syntheticDatatypeSd(url.slice(CORE.length)) : null),
    checkCode: async (system, code) => (system === CS && EXCERPT.has(code)) || (system === ALT && code === "S01") ? { status: "ok" } : { status: "invalid-code", severity: "error", message: `Unknown code '${code}' in the CodeSystem '${system}'` },
    loadValueSet: async (url) =>
      url === VS_DRUG ? { url, compose: { include: [{ system: CS }] } } : url === VS_ALT ? { url, compose: { include: [{ system: ALT, concept: [{ code: "S01" }, { code: "S02" }] }] } } : null,
    valueSetContains: async (url, system, code) => (url === VS_ALT ? system === ALT && ["S01", "S02"].includes(code) : url === VS_DRUG ? system === CS && EXCERPT.has(code) : undefined),
    // The excerpt search answers with whatever is there: unrelated drugs sharing only dose form / strength.
    normalize: async () => [
      { system: CS, code: "D003", display: "Qelmarin Tablets 5mg", accepted: true },
      { system: CS, code: "D004", display: "Pexadrol Capsules 500mg", accepted: true },
    ],
    nearCodes: async () => [{ code: "D003", display: "Qelmarin Tablets 5mg" }],
    relatedCodes: async (_s, original, cands) => {
      const a = original.code && idx.indexOf(original.code) !== undefined ? conceptProfile(idx, original.code, [original.label])! : textProfile(original.label);
      return cands.map((c) => relatedness(a, conceptProfile(idx, c.code) ?? textProfile(c.display), idx));
    },
    codeAlternatives: async (system, code) => (system === CS ? known[code] ?? null : null),
    ...over,
  };
}

const order = (coding: El, text: string | null = "Zorvanil 5mg"): El => ({
  resourceType: "MedicationRequest",
  meta: { profile: [PROFILE] },
  status: "active",
  medicationCodeableConcept: { coding: [coding], ...(text ? { text } : {}) },
});

test("unknown code: no unrelated replacement; the accepted linked coding of another bound system instead", async () => {
  const deps = sdeps();
  const mr = order({ system: CS, code: "D001", display: "Zorvanil Tablets 5mg" });
  const path = "MedicationRequest.medicationCodeableConcept.coding[0].code";
  const plain = await suggestUnknownCode(deps, mr, path, CS, "D001", { left: 4 });
  assert.deepEqual(plain.filter((s) => s.kind === "replace_code"), [], "unrelated excerpt codes are never suggested");
  const alt = await suggestAlternativeCoding(deps, mr, path, CS, "D001");
  assert.equal(alt.length, 1);
  assert.equal(alt[0].kind, "replace_coding");
  assert.equal(alt[0].value, "S01");
  assert.deepEqual(alt[0].patch, { op: "replace", path: "MedicationRequest.medicationCodeableConcept.coding[0]", value: { system: ALT, code: "S01", display: "zorvanil" } });
  assert.match(alt[0].reason, /keep the name in CodeableConcept.text/);
  // Already carried → drop the unknown coding.
  const both: El = order({ system: CS, code: "D001" });
  both.medicationCodeableConcept.coding.push({ system: ALT, code: "S01" });
  const rm = await suggestAlternativeCoding(deps, both, path, CS, "D001");
  assert.equal(rm[0].kind, "remove_coding");
  assert.deepEqual(rm[0].patch, { op: "remove", path: "MedicationRequest.medicationCodeableConcept.coding[0]" });
  // A related excerpt code is still suggested.
  const rel = await suggestUnknownCode(
    sdeps({ normalize: async () => [{ system: CS, code: "D003", display: "Qelmarin Tablets 5mg", accepted: true }] }),
    order({ system: CS, code: "D0O3", display: "Qelmarin Tablets 5mg" }, null),
    path,
    CS,
    "D0O3",
    { left: 4 },
  );
  assert.equal(rel.find((s) => s.kind === "replace_code")?.value, "D003");
  // Not an IG CodeSystem (no gate): the earlier behaviour.
  const ungated = await suggestUnknownCode(sdeps({ relatedCodes: async () => null, codeAlternatives: async () => null }), mr, path, CS, "D001", { left: 4 });
  assert.ok(ungated.some((s) => s.kind === "replace_code"));
});

test("unknown code: a typo without any name keeps its spelling hypotheses; a code defined elsewhere does not", async () => {
  const path = "MedicationRequest.medicationCodeableConcept.coding[0].code";
  const typo = await suggestUnknownCode(sdeps({ normalize: async () => [] }), order({ system: CS, code: "D0003" }, null), path, CS, "D0003", { left: 4 });
  assert.equal(typo[0]?.value, "D003");
  const elsewhere = await suggestUnknownCode(sdeps({ normalize: async () => [] }), order({ system: CS, code: "D001" }, null), path, CS, "D001", { left: 4 });
  assert.deepEqual(elsewhere, []);
});

// --------------------------------------------------------------------------- repair

function rdeps(over: Partial<RepairDeps> = {}): RepairDeps {
  const s = sdeps();
  return {
    fetchStructureDefinition: s.fetchStructureDefinition,
    valueSetContains: s.valueSetContains,
    codeInSystem: async (system, code) => (system === CS ? EXCERPT.has(code) : system === ALT ? ["S01", "S02"].includes(code) : undefined),
    codeAlternatives: s.codeAlternatives,
    ...over,
  };
}

test("repair alt-coding: unique accepted alternative replaces the unknown coding, the name is kept; ambiguous → reported", async () => {
  const mr = order({ system: CS, code: "D001", display: "Zorvanil Tablets 5mg" }, null);
  const r = await repairResource(mr, rdeps());
  assert.deepEqual(mr.medicationCodeableConcept, { coding: [{ system: ALT, code: "S01", display: "zorvanil" }], text: "Zorvanil Tablets 5mg" });
  assert.deepEqual(r.changes.map((c) => [c.rule, c.path]), [
    ["alt-coding", "MedicationRequest.medicationCodeableConcept.coding[0]"],
    ["alt-coding", "MedicationRequest.medicationCodeableConcept.text"],
  ]);
  assert.deepEqual((await repairResource(mr, rdeps())).changes, [], "idempotent");
  const withText = order({ system: CS, code: "D001" });
  await repairResource(withText, rdeps());
  assert.equal(withText.medicationCodeableConcept.text, "Zorvanil 5mg", "the written text stays");
  const both: El = order({ system: CS, code: "D001" });
  both.medicationCodeableConcept.coding.push({ system: ALT, code: "S01" });
  const rb = await repairResource(both, rdeps());
  assert.deepEqual(both.medicationCodeableConcept.coding, [{ system: ALT, code: "S01" }]);
  assert.equal(rb.changes[0].to, null);
  const amb = order({ system: CS, code: "D009" });
  const ra = await repairResource(amb, rdeps());
  assert.deepEqual(amb.medicationCodeableConcept.coding, [{ system: CS, code: "D009" }], "ambiguous: unchanged");
  assert.equal(ra.issues[0].rule, "alt-coding");
  assert.equal((ra.issues[0].candidates || []).length, 2);
  const inExcerpt = order({ system: CS, code: "D003" });
  assert.deepEqual((await repairResource(inExcerpt, rdeps({ codeAlternatives: async () => ({ display: null, definedIn: "ex#1", inValidatedCopy: true, alternatives: [] }) }))).changes, []);
});

// --------------------------------------------------------------------------- v15.2.1 implicit profile

const PROFILE2 = "http://example.org/fhir/StructureDefinition/DrugOrderOutpatient";
const PROFILE3 = "http://example.org/fhir/StructureDefinition/DrugOrderOther";
const VS_OTHER = "http://example.org/fhir/ValueSet/other-substance";
// PROFILE2 binds the coding slices exactly as PROFILE; PROFILE3 binds the substance slice to another ValueSet.
SDS[PROFILE2] = { ...SDS[PROFILE], url: PROFILE2 };
SDS[PROFILE3] = {
  ...SDS[PROFILE],
  url: PROFILE3,
  snapshot: {
    element: SDS[PROFILE].snapshot.element.map((e: El) =>
      e.id === "MedicationRequest.medication[x]:medicationCodeableConcept.coding:substance" ? { ...e, binding: { strength: "required", valueSet: VS_OTHER } } : e,
    ),
  },
};

/** A resource without meta.profile; implicitProfiles answers `profiles` (and counts its calls). */
function implicitDeps(profiles: string[] | null): { calls: Array<[string, string]>; fn: NonNullable<SuggestionDeps["implicitProfiles"]> } {
  const calls: Array<[string, string]> = [];
  return {
    calls,
    fn: async (resourceType, system) => {
      calls.push([resourceType, system]);
      return profiles && system === CS && resourceType === "MedicationRequest" ? { ig: "ex.ig#1.0.0", profiles } : null;
    },
  };
}

const bare = (coding: El, text: string | null = null): El => ({ resourceType: "MedicationRequest", status: "active", medicationCodeableConcept: { coding: [coding], ...(text ? { text } : {}) } });
const ALT_PATH = "MedicationRequest.medicationCodeableConcept.coding[0].code";

test("implicit profile: no meta.profile + one IG profile → the alternative coding is suggested and repaired, the profile named", async () => {
  // Without the collaborator: the core definition's bindings only → nothing (the v15.2 behaviour).
  assert.deepEqual(await suggestAlternativeCoding(sdeps(), bare({ system: CS, code: "D001" }), ALT_PATH, CS, "D001"), []);
  const none = bare({ system: CS, code: "D001" });
  assert.deepEqual((await repairResource(none, rdeps())).changes, []);
  assert.deepEqual(none.medicationCodeableConcept.coding, [{ system: CS, code: "D001" }]);

  const imp = implicitDeps([PROFILE]);
  const s = await suggestAlternativeCoding(sdeps({ implicitProfiles: imp.fn }), bare({ system: CS, code: "D001" }), ALT_PATH, CS, "D001");
  assert.equal(s.length, 1);
  assert.equal(s[0].kind, "replace_coding");
  assert.equal(s[0].value, "S01");
  assert.ok(s[0].reason.includes(`the binding is from ex.ig#1.0.0's profile "${PROFILE}" because the resource declares no profile`), s[0].reason);
  assert.deepEqual(imp.calls, [["MedicationRequest", CS]]);

  const mr = bare({ system: CS, code: "D001", display: "Zorvanil Tablets 5mg" });
  const r = await repairResource(mr, rdeps({ implicitProfiles: implicitDeps([PROFILE]).fn }));
  assert.deepEqual(mr.medicationCodeableConcept, { coding: [{ system: ALT, code: "S01", display: "zorvanil" }], text: "Zorvanil Tablets 5mg" });
  assert.equal(r.changes[0].rule, "alt-coding");
  assert.ok(r.changes[0].reason.includes(`profile "${PROFILE}" because the resource declares no profile`), r.changes[0].reason);
  assert.equal(mr.meta, undefined, "no profile is added to the resource");
});

test("implicit profile: several profiles that bind the element the same way → used; disagreeing / unreadable → nothing", async () => {
  const agree = await suggestAlternativeCoding(sdeps({ implicitProfiles: implicitDeps([PROFILE, PROFILE2]).fn }), bare({ system: CS, code: "D001" }), ALT_PATH, CS, "D001");
  assert.equal(agree.length, 1);
  assert.match(agree[0].reason, /profiles ".*DrugOrder", ".*DrugOrderOutpatient" \(all 2 bind this element the same way\)/);
  const mr = bare({ system: CS, code: "D001" });
  const ra = await repairResource(mr, rdeps({ implicitProfiles: implicitDeps([PROFILE, PROFILE2]).fn }));
  assert.equal(mr.medicationCodeableConcept.coding[0].system, ALT);
  assert.match(ra.changes[0].reason, /all 2 bind this element the same way/);

  for (const profiles of [[PROFILE, PROFILE3], [PROFILE, "http://example.org/fhir/StructureDefinition/Missing"], []]) {
    assert.deepEqual(await suggestAlternativeCoding(sdeps({ implicitProfiles: implicitDeps(profiles).fn }), bare({ system: CS, code: "D001" }), ALT_PATH, CS, "D001"), [], profiles.join());
    const x = bare({ system: CS, code: "D001" });
    const rx = await repairResource(x, rdeps({ implicitProfiles: implicitDeps(profiles).fn }));
    assert.deepEqual(rx.changes, [], profiles.join());
    assert.deepEqual(x.medicationCodeableConcept.coding, [{ system: CS, code: "D001" }]);
  }
});

test("implicit profile: a declared profile (meta.profile / caller profile) keeps the v15.2 behaviour, the lookup is not made", async () => {
  const imp = implicitDeps([PROFILE3]);
  const s = await suggestAlternativeCoding(sdeps({ implicitProfiles: imp.fn }), order({ system: CS, code: "D001" }), ALT_PATH, CS, "D001");
  assert.equal(s.length, 1);
  assert.doesNotMatch(s[0].reason, /declares no profile/);
  const mr = order({ system: CS, code: "D001" });
  const r = await repairResource(mr, rdeps({ implicitProfiles: imp.fn }));
  assert.equal(mr.medicationCodeableConcept.coding[0].system, ALT);
  assert.doesNotMatch(r.changes[0].reason, /declares no profile/);
  // A caller profile counts as declared too (fhir_finalize_resource): its binding, no implicit lookup.
  const viaCaller = bare({ system: CS, code: "D001" });
  await repairResource(viaCaller, rdeps({ implicitProfiles: imp.fn }), { profiles: [PROFILE] });
  assert.equal(viaCaller.medicationCodeableConcept.coding[0].system, ALT);
  const sc = await suggestAlternativeCoding(sdeps({ implicitProfiles: imp.fn }), bare({ system: CS, code: "D001" }), ALT_PATH, CS, "D001", { profiles: [PROFILE] });
  assert.equal(sc.length, 1);
  assert.deepEqual(imp.calls, [], "implicitProfiles never consulted for a declared profile");
});
