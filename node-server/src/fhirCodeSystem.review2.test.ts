/**
 * REVIEW_port_2 G19 / G21 / G25 / G26 / G27 / G28 — fhirCodeSystem membership / expansion as the standalone
 * ValueSetValidator / ValueSetExpander / CodeSystemUtilities of validator 7.0.1 behave.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyFilter, composeContains, expandComposeWith, findConcept, indexCodeSystem, type TerminologyDeps } from "./fhirCodeSystem.js";
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
