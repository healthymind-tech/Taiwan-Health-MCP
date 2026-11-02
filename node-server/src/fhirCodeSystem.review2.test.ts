/**
 * REVIEW_port_2 G19 / G21 / G25 / G26 / G27 / G28 — fhirCodeSystem membership / expansion as the standalone
 * ValueSetValidator / ValueSetExpander / CodeSystemUtilities of validator 7.0.1 behave.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyFilter, codeInFilter, composeContains, conceptInactive, expandComposeWith, findConcept, indexCodeSystem, type TerminologyDeps } from "./fhirCodeSystem.js";
import { externalFilterMatches } from "./fhirTerminology.js";
import { txValidateCode } from "./fhirTxValidate.js";
import { serverPrefers } from "./fhirSpecialSystems.js";
import { judgeHeldCodeSystem, nameSystemAsWritten } from "./fhirValidationResolver.js";

type Json = Record<string, any>;
function depsWith(cs: Json | null, extra: Partial<TerminologyDeps> = {}): TerminologyDeps {
  const idx = cs ? indexCodeSystem(cs) : null;
  return {
    loadValueSet: async () => null,
    loadCodeSystem: async (u) => (idx && u.split("|")[0] === idx.url ? idx : null),
    lookupExternal: async () => null,
    externalSystemHeld: async () => false,
    ...extra,
  };
}
const CS = { resourceType: "CodeSystem", url: "http://x/cs", content: "complete", concept: [{ code: "A", display: "a" }, { code: "B", display: "b" }] };

test("G19: an enumerated code the complete CodeSystem does not define is not a member (VSV:2211); G28: nor expanded (VSE:1714)", async () => {
  const compose = { include: [{ system: "http://x/cs", concept: [{ code: "A" }, { code: "GHOST" }] }] };
  assert.equal(await composeContains(compose, "http://x/cs", "GHOST", depsWith(CS)), false);
  assert.equal(await composeContains(compose, "http://x/cs", "A", depsWith(CS)), true);
  const ex = await expandComposeWith(compose, depsWith(CS));
  assert.deepEqual(ex.codings.map((c) => c.code), ["A"]);
});

test("a system nobody knows: listed at face value, otherwise neither member nor not (VSV:2136-2150, jar on the G21 input)", async () => {
  const unknown = depsWith(null, { systemUnknown: async () => true });
  const listed = { include: [{ system: "http://nowhere/cs", concept: [{ code: "A" }] }] };
  assert.equal(await composeContains(listed, "http://nowhere/cs", "Z", unknown), undefined);
  assert.equal(await composeContains(listed, "http://nowhere/cs", "Z", depsWith(null, { systemUnknown: async () => false })), false);
  assert.equal(await composeContains(listed, "http://nowhere/cs", "A", unknown), true);
});

test("UCUM as a whole-system include: decided by the unit grammar", async () => {
  const ucum = { include: [{ system: "http://unitsofmeasure.org" }] };
  assert.equal(await composeContains(ucum, null, "mg/dL", depsWith(null)), true);
  assert.equal(await composeContains(ucum, null, "notaunit!", depsWith(null)), false);
});

test("G25: hierarchy only through the property with the concept-properties#parent URI (CodeSystemUtilities.crossLinkCodeSystem)", () => {
  const withUri = indexCodeSystem({ ...CS, property: [{ code: "p", uri: "http://hl7.org/fhir/concept-properties#parent", type: "code" }], concept: [{ code: "A" }, { code: "B", property: [{ code: "p", valueCode: "A" }] }] });
  assert.deepEqual([...applyFilter(withUri, { property: "concept", op: "is-a", value: "A" })!].sort(), ["A", "B"]);
  const noUri = indexCodeSystem({ ...CS, property: [{ code: "subsumedBy", type: "code" }], concept: [{ code: "A" }, { code: "B", property: [{ code: "subsumedBy", valueCode: "A" }] }] });
  assert.deepEqual([...applyFilter(noUri, { property: "concept", op: "is-a", value: "A" })!], ["A"]);
  // an unknown root is not an empty set (G28, VSE:1770 throws)
  assert.equal(applyFilter(noUri, { property: "concept", op: "is-a", value: "NOPE" }), null);
});

test("G26: a value set with an expansion is checked against the expansion only (VSV:1804)", async () => {
  const compose = { include: [{ system: "http://x/cs" }] };
  const expansion = { contains: [{ system: "http://x/cs", code: "B" }] };
  assert.equal(await composeContains(compose, "http://x/cs", "A", depsWith(CS), 0, new Set(), expansion), false);
  assert.equal(await composeContains(compose, "http://x/cs", "B", depsWith(CS), 0, new Set(), expansion), true);
});

test("G27: alternateCode names its concept; a deprecated designation is INACTIVE_DISPLAY_FOUND (error)", () => {
  const cs = indexCodeSystem({
    ...CS,
    concept: [
      {
        code: "A",
        display: "Alpha",
        property: [{ code: "alternateCode", valueCode: "AA" }],
        designation: [{ value: "Old Alpha", extension: [{ url: "http://hl7.org/fhir/StructureDefinition/structuredefinition-standards-status", valueCode: "deprecated" }] }],
      },
    ],
  });
  assert.equal(findConcept(cs, "AA")?.code, "A");
  const r = judgeHeldCodeSystem(cs, cs.url, "A", "Old Alpha");
  assert.equal(r && "message" in r ? r.message : "", "'Old Alpha' is no longer considered a correct display for code 'A' (status = deprecated). The correct display is 'Alpha'");
});

test("G28: an exclude that cannot be expanded leaves the expansion incomplete (unresolved, VSE:712-726)", async () => {
  const compose = { include: [{ system: "http://x/cs" }], exclude: [{ system: "http://x/cs", filter: [{ property: "concept", op: "is-a", value: "NOPE" }] }] };
  const ex = await expandComposeWith(compose, depsWith(CS));
  assert.ok(ex.unresolved.length > 0, JSON.stringify(ex));
});

test("G24: membership filters as ValueSetValidator.codeInFilter (VSV:2235-2438), Java quirks kept", () => {
  const cs = indexCodeSystem({
    ...CS,
    property: [{ code: "kind", type: "code" }],
    concept: [
      { code: "A", display: "a", property: [{ code: "kind", valueCode: "x" }, { code: "kind", valueCode: "y" }] },
      { code: "B", display: "b" },
    ],
  });
  const a = findConcept(cs, "A")!;
  const b = findConcept(cs, "B")!;
  // `concept` / `code` with = read a property of that name: no match
  assert.equal(codeInFilter(cs, { property: "concept", op: "=", value: "A" }, a), false);
  assert.equal(codeInFilter(cs, { property: "code", op: "=", value: "A" }, a), false);
  // the first value only
  assert.equal(codeInFilter(cs, { property: "kind", op: "=", value: "x" }, a), true);
  assert.equal(codeInFilter(cs, { property: "kind", op: "=", value: "y" }, a), false);
  assert.equal(codeInFilter(cs, { property: "kind", op: "in", value: "y,z" }, a), false);
  // exists ignores the filter value
  assert.equal(codeInFilter(cs, { property: "kind", op: "exists", value: "false" }, a), true);
  assert.equal(codeInFilter(cs, { property: "kind", op: "exists", value: "false" }, b), false);
  // handed to the terminology server by Java
  assert.equal(codeInFilter(cs, { property: "display", op: "=", value: "a" }, a), undefined);
  assert.equal(codeInFilter(cs, { property: "concept", op: "generalizes", value: "A" }, a), undefined);
  assert.equal(codeInFilter(cs, { property: "undeclared", op: "=", value: "a" }, a), undefined);
  // a code regex, and is-a with an unknown root (false, VSV:2433)
  assert.equal(codeInFilter(cs, { property: "code", op: "regex", value: "[AB]" }, a), true);
  assert.equal(codeInFilter(cs, { property: "concept", op: "is-a", value: "NOPE" }, a), false);
});

test("G27: a withdrawn concept is inactive (CodeSystemUtilities.isInactive, standards-status)", () => {
  const cs = indexCodeSystem({ ...CS, concept: [{ code: "W", extension: [{ url: "http://hl7.org/fhir/StructureDefinition/structuredefinition-standards-status", valueCode: "withdrawn" }] }, { code: "A" }] });
  assert.equal(conceptInactive(findConcept(cs, "W")!), true);
  assert.equal(conceptInactive(findConcept(cs, "A")!), false);
});

test("G30: tx adapter — no language accepts any display language; ValueSet.language and inferSystem", async () => {
  const cs = { resourceType: "CodeSystem", url: "http://x/l", content: "complete", concept: [{ code: "a", display: "Alpha", designation: [{ language: "nl", value: "Alfa" }] }] };
  const deps = depsWith(cs);
  const vs = { resourceType: "ValueSet", url: "http://x/vs", compose: { include: [{ system: "http://x/l" }] } };
  const coding = { system: "http://x/l", code: "a", display: "Alfa" };
  assert.equal((await txValidateCode({ mode: "valueset", valueSet: vs, coding, params: {} }, deps)).result, true);
  assert.equal((await txValidateCode({ mode: "valueset", valueSet: { ...vs, language: "en" }, coding, params: {} }, deps)).result, false);
  assert.equal((await txValidateCode({ mode: "valueset", valueSet: vs, coding, params: { acceptLanguage: "en, en-AU; q=0.4" } }, deps)).result, false);
  const inferred = await txValidateCode({ mode: "valueset", valueSet: vs, code: "a", params: { inferSystem: true } }, deps);
  assert.equal(inferred.result, true);
});

test("concept in / not-in needs no terminology, on a system nobody holds", async () => {
  const inc = (op: string) => ({ include: [{ system: "http://nowhere/cs", filter: [{ property: "concept", op, value: "A, B" }] }] });
  assert.equal(await composeContains(inc("in"), "http://nowhere/cs", "B", depsWith(null)), true);
  assert.equal(await composeContains(inc("in"), "http://nowhere/cs", "C", depsWith(null)), false);
  assert.equal(await composeContains(inc("not-in"), "http://nowhere/cs", "C", depsWith(null)), true);
});

test("another SNOMED CT edition: the International hierarchy cannot say no", async () => {
  const inc = (version?: string) => ({ include: [{ system: "http://snomed.info/sct", ...(version ? { version } : {}), filter: [{ property: "concept", op: "is-a", value: "111111" }] }] });
  const d = depsWith(null, { snomedSubsumedBy: async () => false });
  assert.equal(await composeContains(inc(), "http://snomed.info/sct", "222222", d), false);
  assert.equal(await composeContains(inc("http://snomed.info/sct/900000000000207008/version/20250201"), "http://snomed.info/sct", "222222", d), false);
  assert.equal(await composeContains(inc("http://snomed.info/sct/731000124108"), "http://snomed.info/sct", "222222", d), undefined);
});

test("ISO 3166 regex filters: the shape, then the table", async () => {
  const f = (value: string) => ({ property: "code", op: "regex", value });
  assert.equal(await externalFilterMatches("urn:iso:std:iso:3166", f("[A-Z]{2}"), "NL"), true);
  assert.equal(await externalFilterMatches("urn:iso:std:iso:3166", f("[A-Z]{2}"), "NLD"), false);
  assert.equal(await externalFilterMatches("urn:iso:std:iso:3166", f("[A-Z]{3}"), "NLD"), true);
  assert.equal(await externalFilterMatches("urn:iso:std:iso:3166", f("[A-Z]{2}"), "QQ"), true);
  assert.equal(await externalFilterMatches("urn:iso:std:iso:3166", f("[A-Z]{2}"), "JJ"), false);
});

test("a not-present CodeSystem stub defines nothing: the code is answered as for a system not held", async () => {
  const stub = { ...CS, url: "urn:iso:std:iso:3166", content: "not-present", concept: [] };
  const filtered = { include: [{ system: "urn:iso:std:iso:3166", filter: [{ property: "code", op: "regex", value: "[A-Z]{2}" }] }] };
  const d = depsWith(stub, { externalFilter: async (_s, _f, c) => c === "NL" });
  assert.equal(await composeContains(filtered, "urn:iso:std:iso:3166", "NL", d), true);
  assert.equal(await composeContains(filtered, "urn:iso:std:iso:3166", "XX", d), false);
});

test("CVX and ISO 3166 as whole-system includes: decided by the bundled tables", async () => {
  const cvx = { include: [{ system: "http://hl7.org/fhir/sid/cvx" }] };
  assert.equal(await composeContains(cvx, "http://hl7.org/fhir/sid/cvx", "207", depsWith(null)), true);
  assert.equal(await composeContains(cvx, "http://hl7.org/fhir/sid/cvx", "9999", depsWith(null)), false);
  const iso = { include: [{ system: "urn:iso:std:iso:3166" }] };
  assert.equal(await composeContains(iso, "urn:iso:std:iso:3166", "TW", depsWith(null)), true);
});

test("a Coding.system spelled url|version: the messages name it as written (official Unknown_Code_in_Version)", () => {
  const base = "http://terminology.hl7.org/CodeSystem/v2-0360";
  const r = nameSystemAsWritten({ status: "invalid-code", severity: "error", message: `Unknown code 'ZZZ-9' in the CodeSystem '${base}' version '2.7'` }, base, `${base}|2.7`);
  assert.equal("message" in r && r.message, `Unknown code 'ZZZ-9' in the CodeSystem '${base}|2.7' version '2.7'`);
  assert.deepEqual(nameSystemAsWritten({ status: "ok" }, base, `${base}|2.7`), { status: "ok" });
});

test("preferServerSide: SERVER_SIDE_LIST, then the capability list", () => {
  assert.equal(serverPrefers("urn:oid:1.2.36.1.2001.1005.17"), true); // in the list of the code, not in the server's
  for (const c of ["http://standardterms.edqm.eu", "http://terminology.hl7.org/CodeSystem/icd-o-3", "http://id.who.int/icd/release/11/mms"]) assert.equal(serverPrefers(c), true, c);
  assert.equal(serverPrefers("http://hospital.example/cs"), false);
});

test("ROUND 11: Unknown code names the CodeSystem's own url; a string property filters by its value (USE = 1)", () => {
  const cs = { ...CS, url: "http://x/ValueSet/own-url", version: "2", property: [{ code: "USE", type: "string" }], concept: [{ code: "A", property: [{ code: "USE", valueString: "0" }] }, { code: "B", property: [{ code: "USE", valueString: "1" }] }] };
  const idx = indexCodeSystem(cs);
  const r = judgeHeldCodeSystem(idx, "http://x/CodeSystem/index-url", "Z", null);
  assert.equal(r && "message" in r && r.message, "Unknown code 'Z' in the CodeSystem 'http://x/ValueSet/own-url' version '2'");
  const f = { property: "USE", op: "=", value: "1" };
  assert.equal(codeInFilter(idx, f, findConcept(idx, "B")!), true);
  assert.equal(codeInFilter(idx, f, findConcept(idx, "A")!), false);
});
