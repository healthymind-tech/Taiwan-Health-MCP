import assert from "node:assert/strict";
import { test } from "node:test";
import { validateConceptMapResource, type ConceptMapResourceDeps } from "./fhirConceptMapResource.js";

const CS = { resourceType: "CodeSystem", url: "http://x/cs", content: "complete", concept: [{ code: "a", concept: [{ code: "b" }] }, { code: "c" }] };
const VS = { resourceType: "ValueSet", url: "http://x/vs", version: "1.0", compose: { include: [{ system: "http://x/cs", concept: [{ code: "a" }] }] } };
const deps = (over: Partial<ConceptMapResourceDeps> = {}): ConceptMapResourceDeps => ({
  fetchCodeSystem: async (u) => (u === "http://x/cs" ? CS : u === "http://x/frag" ? { ...CS, url: u, content: "fragment" } : u === "http://x/sup" ? { ...CS, url: u, content: "supplement" } : null),
  fetchValueSet: async (u) => (u === "http://x/vs" ? VS : null),
  member: async (_v, _s, c) => c === "a",
  ...over,
});
const out = (l: Array<{ severity: string; path: string; message: string }>): string[] => l.map((i) => `${i.severity} ${i.path} | ${i.message}`);
const cm = (group: object, top: object = {}): Record<string, unknown> => ({ resourceType: "ConceptMap", ...top, group: [group] });

test("ConceptMap: a held code outside the scope value set, and one the code system does not define (validateGroupElement)", async () => {
  const r = await validateConceptMapResource(cm({ source: "http://x/cs", element: [{ code: "a" }, { code: "c" }, { code: "zz" }] }, { sourceCanonical: "http://x/vs" }), "ConceptMap", deps());
  assert.deepEqual(out(r), [
    "error ConceptMap.group[0].element[1].code | The source code 'c' is not valid in the value set http://x/vs|1.0",
    "error ConceptMap.group[0].element[2].code | The source code 'zz' is not valid in the code system http://x/cs",
  ]);
});

test("ConceptMap: target codes, nested concepts count", async () => {
  const r = await validateConceptMapResource(cm({ target: "http://x/cs", element: [{ code: "s", target: [{ code: "b" }, { code: "zz" }] }] }), "ConceptMap", deps());
  assert.deepEqual(out(r), ["error ConceptMap.group[0].element[0].target[1].code | The target code 'zz' is not valid in the code system http://x/cs"]);
});

test("ConceptMap: an undecidable value set, a fragment, SNOMED and an unknown system are not judged; a non-complete system only warns", async () => {
  const g = { source: "http://x/cs", element: [{ code: "c" }] };
  assert.deepEqual(await validateConceptMapResource(cm(g, { sourceUri: "http://x/vs" }), "ConceptMap", deps({ member: async () => undefined })), []);
  assert.deepEqual(await validateConceptMapResource(cm({ source: "http://x/frag", element: [{ code: "zz" }] }), "ConceptMap", deps()), []);
  assert.deepEqual(await validateConceptMapResource(cm({ source: "http://snomed.info/sct", element: [{ code: "zz" }] }), "ConceptMap", deps({ fetchCodeSystem: async () => CS })), []);
  assert.deepEqual(await validateConceptMapResource(cm({ source: "http://nope", element: [{ code: "zz" }] }), "ConceptMap", deps()), []);
  assert.deepEqual(out(await validateConceptMapResource(cm({ source: "http://x/sup", element: [{ code: "zz" }] }), "ConceptMap", deps())), [
    "warning ConceptMap.group[0].element[0].code | The source code 'zz' is not valid in the code system http://x/sup",
  ]);
});

test("ConceptMap: the group's version comes from sourceVersion, the canonical or the scope value set's include", async () => {
  const asked: string[] = [];
  const d = deps({ fetchCodeSystem: async (u) => (asked.push(u), null), fetchValueSet: async () => ({ ...VS, compose: { include: [{ system: "http://x/cs", version: "9" }] } }) });
  await validateConceptMapResource(cm({ source: "http://x/cs", element: [] }, { sourceCanonical: "http://x/vs" }), "ConceptMap", d);
  await validateConceptMapResource(cm({ source: "http://x/cs", sourceVersion: "2", element: [] }), "ConceptMap", d);
  await validateConceptMapResource(cm({ source: "http://x/cs|3", element: [] }), "ConceptMap", d);
  assert.deepEqual(asked.filter((u) => u.includes("|")), ["http://x/cs|9", "http://x/cs|2", "http://x/cs|3"]);
});

test("ConceptMap: a scope pointing at a CodeSystem (readVSReference)", async () => {
  assert.deepEqual(out(await validateConceptMapResource(cm({}, { targetCanonical: "http://x/cs" }), "ConceptMap", deps())), ["error ConceptMap.target | Reference must be to a ValueSet, but found a CodeSystem instead"]);
});
