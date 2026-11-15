/**
 * csRows / CodeSystemIndexBuilder: an index built from flat pre-order rows, finished in slices, equals indexCodeSystem
 * of the whole resource; the Slicer yields only when its time slice is used up. (The database flattening itself is
 * checked against every stored CodeSystem by scripts, not here: no database in unit tests.)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CodeSystemIndexBuilder, indexCodeSystem, isIndexedConcept } from "./fhirCodeSystem.js";
import { Slicer } from "./csRows.js";

const CS = {
  resourceType: "CodeSystem",
  url: "http://example.org/cs",
  version: "1",
  content: "complete",
  caseSensitive: false,
  property: [{ code: "parent", uri: "http://hl7.org/fhir/concept-properties#parent", type: "code" }, { code: "alternateCode", type: "code" }],
  concept: [
    { code: "A", display: "Alpha", concept: [{ code: "A1", display: "Alpha one", designation: [{ language: "zh", value: "甲一" }] }, { display: "no code: skipped with its children", concept: [{ code: "LOST" }] }, { code: "A2", concept: [{ code: "A2a" }] }] },
    null,
    { code: "B", property: [{ code: "parent", valueCode: "A" }, { code: "alternateCode", valueCode: "bee" }] },
    { code: "C", extension: [{ url: "http://hl7.org/fhir/StructureDefinition/structuredefinition-standards-status", valueCode: "withdrawn" }] },
  ],
};

/** The rows the database flattening yields: pre-order, without `concept`, with the parent's code. */
function rows(cs: Record<string, any>): Array<{ node: Record<string, any>; parent: string | null }> {
  const out: Array<{ node: Record<string, any>; parent: string | null }> = [];
  const visit = (list: any[], parent: string | null): void => {
    for (const raw of list || []) {
      if (!isIndexedConcept(raw)) continue;
      const { concept, ...node } = raw;
      out.push({ node, parent });
      if (Array.isArray(concept)) visit(concept, String(raw.code));
    }
  };
  visit(cs.concept, null);
  return out;
}

const ser = (idx: ReturnType<typeof indexCodeSystem>): string =>
  JSON.stringify({ ...idx, propertyCodes: [...(idx.propertyCodes ?? [])], lower: [...idx.lower], concepts: [...idx.concepts].map(([k, c]) => [k, { ...c, parents: [...c.parents], children: [...c.children], properties: [...c.properties] }]) });

test("an index built from flat rows and finished in slices equals indexCodeSystem of the resource", async () => {
  const { concept: _c, ...head } = CS;
  const b = new CodeSystemIndexBuilder();
  for (const r of rows(CS)) b.add(r.node, r.parent);
  let pauses = 0;
  const idx = await b.finishAsync(head, () => {
    pauses++;
    return undefined;
  });
  assert.equal(ser(idx), ser(indexCodeSystem(CS)));
  assert.ok(pauses > 0);
  assert.ok(!idx.concepts.has("LOST"), "a code-less entry is skipped with its descendants");
  assert.deepEqual([...idx.concepts.get("A")!.children], ["A1", "A2", "B"], "nested children, then the parent-property child");
});

test("Slicer yields only once its time slice is used up", async () => {
  const s = new Slicer(1000);
  let yielded = 0;
  for (let i = 0; i < 1000; i++) if (s.tick()) yielded++;
  assert.equal(yielded, 0, "within the slice: no yield");
  const t = new Slicer(0);
  let y2 = 0;
  for (let i = 0; i < 64; i++) {
    const p = t.tick();
    if (p) {
      y2++;
      await p;
    }
  }
  assert.ok(y2 >= 1, "an exhausted slice yields (checked every 32 ticks)");
});
