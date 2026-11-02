/** extended_findings: pure layer over faked lookups, plus the system classification against the capability list. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { extendedFindings, mapProfile, repairMetaProfiles, variantsOf, type ExtendedDeps, type HeldVerdict } from "./index.js";
import { attributeErrors, underRepairedProfile, type AnnotatedChange } from "../fhirRepair/autoFix.js";
import { finalizeBundle } from "../fhirBundleFinalize.js";
import { setTxSystemsForTest, txKnowsSystem } from "../txCodeTables.js";
import { terminologyServerKnows } from "../fhirSpecialSystems.js";

const BASE = "https://ig.example/fhir/StructureDefinition";
const PROFILES = [`${BASE}/Patient-ig`, `${BASE}/Patient-ig-lab`, `${BASE}/Observation-ig`];

function deps(over: Partial<ExtendedDeps> = {}, held: Record<string, HeldVerdict> = {}): ExtendedDeps {
  return {
    unknownToValidator: async (system) => system.includes("unknown"),
    held: async (system) => held[system] ?? { held: "no" },
    profileResolves: async (c) => PROFILES.includes(c),
    profilesOf: async (rt) => PROFILES.filter((p) => p.includes(`/${rt}-`)),
    ...over,
  };
}

test("nothing to report: no block at all (the field stays absent)", async () => {
  const r = await extendedFindings({ resourceType: "Patient", meta: { profile: [`${BASE}/Patient-ig`] }, maritalStatus: { coding: [{ system: "http://known", code: "S" }] } }, deps());
  assert.equal(r, null);
});

test("(a) a code a complete held copy lacks is an error; a code it has is nothing", async () => {
  const sys = "https://cs.example/unknown";
  const res = { resourceType: "Condition", code: { coding: [{ system: sys, code: "NOPE" }, { system: `${sys}2`, code: "OK" }] } };
  const r = await extendedFindings(res, deps({}, { [sys]: { held: "absent", heldAs: "http://cs.example/unknown" }, [`${sys}2`]: { held: "found", heldAs: "http://cs.example/unknown2" } }));
  assert.deepEqual(r?.summary, { errors: 1, unverifiable: 0 });
  assert.equal(r?.findings[0].kind, "code-not-in-held-codesystem");
  assert.equal(r?.findings[0].severity, "error");
  assert.equal(r?.findings[0].path, "Condition.code.coding[0]");
  assert.equal(r?.findings[0].held_as, "http://cs.example/unknown");
});

test("edition completeness: an incomplete or out-of-closure copy never yields 'not found'", async () => {
  const res = { resourceType: "Condition", code: { coding: [{ system: "http://unknown/a", code: "X" }, { system: "http://unknown/b", code: "X" }] } };
  const r = await extendedFindings(res, deps({}, { "http://unknown/a": { held: "incomplete", heldAs: "https://unknown/a" }, "http://unknown/b": { held: "outside", heldAs: "https://unknown/b" } }));
  assert.deepEqual(r?.summary, { errors: 0, unverifiable: 2 });
  assert.deepEqual(r?.findings.map((f) => f.reason), ["held-copy-incomplete", "held-outside-closure"]);
});

test("(c) no local data: unverifiable, one finding per system, counted", async () => {
  const res = { resourceType: "Bundle", entry: [{ resource: { resourceType: "Observation", code: { coding: [{ system: "http://unknown/z", code: "1" }] } } }, { resource: { resourceType: "Observation", code: { coding: [{ system: "http://unknown/z", code: "2" }] } } }] };
  const r = await extendedFindings(res, deps());
  assert.deepEqual(r?.summary, { errors: 0, unverifiable: 2 });
  assert.equal(r?.findings.length, 1);
  assert.equal(r?.findings[0].count, 2);
  assert.equal(r?.findings[0].path, "Bundle.entry[0].resource.code.coding[0]");
  assert.equal(r?.findings[0].severity, "unverifiable");
});

test("(b) unresolvable and malformed meta.profile are errors with a fix", async () => {
  const r = await extendedFindings({ resourceType: "Patient", meta: { profile: [`${BASE}/Patient-ig-typo-long-enough-xxxxxxxxxx`, `${BASE}/Patient-ig|9.9.9`, "not a url", ""] } }, deps());
  assert.equal(r?.summary.errors, 4);
  assert.deepEqual(r?.findings.map((f) => f.kind), ["unresolvable-profile", "unresolvable-profile", "malformed-profile", "malformed-profile"]);
  assert.equal(r?.findings[1].fix?.replace_with, `${BASE}/Patient-ig`);
  assert.equal(r?.findings[3].fix?.replace_with, undefined);
  assert.match(String(r?.findings[3].fix?.action), /Remove it/);
});

test("a failing lookup never reads as a pass", async () => {
  const r = await extendedFindings({ resourceType: "Patient", meta: { profile: ["http://x.example/p"] } }, deps({ profileResolves: async () => Promise.reject(new Error("db")) }));
  assert.deepEqual(r?.summary, { errors: 0, unverifiable: 0, incomplete: true });
});

test("mapProfile: version, case, id, near id; a tie is no mapping; never across types", () => {
  const c = [`${BASE}/Patient-ig`, `${BASE}/Patient-ig-lab`];
  assert.equal(mapProfile(`${BASE}/Patient-ig|9.9.9`, c).canonical, c[0]);
  assert.equal(mapProfile(`${BASE.toLowerCase()}/patient-ig`, c).canonical, c[0]);
  assert.equal(mapProfile(`http://ig.example/fhir/StructureDefinition/Patient-ig`, c).canonical, c[0]);
  assert.equal(mapProfile("Patient-ig-lab", c).canonical, c[1]);
  assert.equal(mapProfile(`${BASE}/Patient-ig-lab-typo`, c).canonical, c[1]);
  assert.equal(mapProfile(`${BASE}/Patinet-ig`, c).canonical, c[0]);
  assert.equal(mapProfile(`${BASE}/Patient-ig-la`, [`${BASE}/Patient-ig-lb`, `${BASE}/Patient-ig-lc`]).canonical, null);
  assert.equal(mapProfile(`${BASE}/Totally-different-thing`, c).canonical, null);
  assert.equal(mapProfile("", c).canonical, null);
});

test("variantsOf: scheme and /CodeSystem/ - /ValueSet/ spellings only", () => {
  assert.deepEqual(variantsOf("https://a.example/CodeSystem/x"), ["http://a.example/CodeSystem/x", "https://a.example/ValueSet/x", "http://a.example/ValueSet/x"]);
  assert.deepEqual(variantsOf("urn:oid:1.2"), []);
});

test("repairMetaProfiles replaces in place, reports, and is idempotent", async () => {
  const res: Record<string, any> = { resourceType: "Bundle", entry: [{ resource: { resourceType: "Patient", meta: { profile: [`${BASE}/Patient-ig|9.9.9`] } } }] };
  const map = async (rt: string, p: string): Promise<string | null> => (PROFILES.includes(p) ? null : mapProfile(p, PROFILES.filter((x) => x.includes(`/${rt}-`))).canonical);
  const ch = await repairMetaProfiles(res, map);
  assert.deepEqual(ch.map((c) => [c.path, c.from, c.to, c.rule]), [["Bundle.entry[0].resource.meta.profile[0]", `${BASE}/Patient-ig|9.9.9`, `${BASE}/Patient-ig`, "meta-profile"]]);
  assert.deepEqual(res.entry[0].resource.meta.profile, [`${BASE}/Patient-ig`]);
  assert.deepEqual(await repairMetaProfiles(res, map), []);
});

test("a repaired value already present elsewhere is dropped, not duplicated", async () => {
  const res: Record<string, any> = { resourceType: "Patient", meta: { profile: [`${BASE}/Patient-ig|9.9.9`, `${BASE}/Patient-ig`] } };
  await repairMetaProfiles(res, async (_r, p) => (p.includes("|") ? `${BASE}/Patient-ig` : null));
  assert.deepEqual(res.meta.profile, [`${BASE}/Patient-ig`]);
});

test("finalizeBundle: rule meta-profile only with a mapper, after the document reorder", async () => {
  const b = { resourceType: "Bundle", type: "document", entry: [{ resource: { resourceType: "Patient", meta: { profile: ["x"] } } }, { resource: { resourceType: "Composition" } }] };
  const off = await finalizeBundle(b, null, { skipIds: true });
  assert.equal(off.changes.some((c) => c.rule === "meta-profile"), false);
  const on = await finalizeBundle(b, null, { skipIds: true, profileMapper: async () => `${BASE}/Patient-ig` });
  const ch = on.changes.find((c) => c.rule === "meta-profile");
  assert.equal(ch?.path, "Bundle.entry[1].resource.meta.profile[0]");
  assert.deepEqual(on.bundle.entry[1].resource.meta.profile, [`${BASE}/Patient-ig`]);
});

test("guard: an error inside a resource with a repaired profile was hidden, not added", () => {
  const c = { rule: "meta-profile", pointer: "/entry/2/resource/meta/profile/0" } as unknown as AnnotatedChange;
  assert.equal(underRepairedProfile("/entry/2/resource/name/0", [c]), true);
  assert.equal(underRepairedProfile("/entry/3/resource/name/0", [c]), false);
  const root = { rule: "meta-profile", pointer: "/meta/profile/0" } as unknown as AnnotatedChange;
  assert.equal(underRepairedProfile("/entry/3/resource/name/0", [root]), true);
  assert.equal(typeof attributeErrors, "function");
});

test("the terminology server's published list decides (the bundled file, and a fake)", () => {
  setTxSystemsForTest(undefined);
  assert.equal(txKnowsSystem("http://www.whocc.no/atc"), true);
  assert.equal(txKnowsSystem("http://hl7.org/fhir/sid/ndc"), true);
  assert.equal(txKnowsSystem("http://www.ama-assn.org/go/cpt"), true);
  assert.equal(txKnowsSystem("http://terminology.hl7.org/CodeSystem/v2-0203x"), false);
  assert.equal(txKnowsSystem("https://twcore.mohw.gov.tw/ig/twcore/CodeSystem/icd-10-cm-2023-tw"), false);
  setTxSystemsForTest(["http://only"]);
  assert.equal(terminologyServerKnows("http://only"), true);
  assert.equal(terminologyServerKnows("http://loinc.org"), false);
  setTxSystemsForTest(null);
  assert.equal(txKnowsSystem("http://only"), null);
  assert.equal(terminologyServerKnows("http://loinc.org"), true, "without the list: the built-in rules");
  setTxSystemsForTest(undefined);
});
