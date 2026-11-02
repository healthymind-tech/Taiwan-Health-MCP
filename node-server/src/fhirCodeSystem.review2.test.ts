/**
 * REVIEW_port_2 G19 / G21 / G25 / G26 / G27 / G28 — fhirCodeSystem membership / expansion as the standalone
 * ValueSetValidator / ValueSetExpander / CodeSystemUtilities of validator 7.0.1 behave.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyFilter, codeInFilter, composeContains, conceptInactive, expandComposeWith, findConcept, indexCodeSystem, type TerminologyDeps } from "./fhirCodeSystem.js";
import { txValidateCode } from "./fhirTxValidate.js";
import { judgeHeldCodeSystem } from "./fhirValidationResolver.js";

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

test("G21: an unlisted code of a system nobody knows is undecidable, not a failure (VSV:2136-2150)", async () => {
  const compose = { include: [{ system: "http://nowhere/cs", concept: [{ code: "A" }] }] };
  assert.equal(await composeContains(compose, "http://nowhere/cs", "Z", depsWith(null, { systemUnknown: async () => true })), undefined);
  assert.equal(await composeContains(compose, "http://nowhere/cs", "Z", depsWith(null, { systemUnknown: async () => false })), false);
  assert.equal(await composeContains(compose, "http://nowhere/cs", "A", depsWith(null, { systemUnknown: async () => true })), true);
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
