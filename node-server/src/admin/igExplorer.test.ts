import { test } from "node:test";
import assert from "node:assert/strict";
import type { Q, Row } from "./termViz/common.js";
import {
  buildDependencyTree,
  canonicalTail,
  categoryOf,
  closureOf,
  conceptMatches,
  directDependentsOf,
  flattenConcepts,
  handleIgExplorerApi,
  levelStats,
  parseDeps,
  pickDefinitions,
  shapeCategories,
  shapeDigest,
  shapeItem,
  systemSupport,
  type InstalledPackage,
} from "./igExplorer.js";

/** Fake query runner: the first matcher whose substring occurs in the SQL answers. */
function fakeQ(matchers: [string, (params: unknown[]) => Row[]][]): Q & { calls: { sql: string; params: unknown[] }[] } {
  const calls: { sql: string; params: unknown[] }[] = [];
  const q = (async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    for (const [needle, fn] of matchers) if (sql.includes(needle)) return { rows: fn(params) };
    throw new Error(`unexpected SQL: ${sql.slice(0, 80)}`);
  }) as Q & { calls: { sql: string; params: unknown[] }[] };
  q.calls = calls;
  return q;
}

test("categoryOf separates profiles, extensions, data types, logical models and the rest", () => {
  const sd = (kind: string, derivation: string, type: string) => ({ resource_type: "StructureDefinition", kind, derivation, type, base_type: type });
  assert.equal(categoryOf(sd("resource", "constraint", "Patient")), "profile");
  assert.equal(categoryOf(sd("complex-type", "constraint", "Extension")), "extension");
  assert.equal(categoryOf(sd("complex-type", "constraint", "Address")), "datatype");
  assert.equal(categoryOf(sd("logical", "specialization", "https://x/StructureDefinition/TWPatient")), "logical");
  assert.equal(categoryOf(sd("resource", "specialization", "Patient")), "base");
  assert.equal(categoryOf({ resource_type: "ValueSet" }), "terminology");
  assert.equal(categoryOf({ resource_type: "ConceptMap" }), "terminology");
  assert.equal(categoryOf({ resource_type: "SearchParameter" }), "search");
  assert.equal(categoryOf({ resource_type: "OperationDefinition" }), "capability");
  assert.equal(categoryOf({ resource_type: "ImplementationGuide" }), "capability");
  assert.equal(categoryOf({ resource_type: "Observation" }), "example");
});

test("canonicalTail drops trailing slashes and |version", () => {
  assert.equal(canonicalTail("https://x/StructureDefinition/TWPatient|1.0.0"), "TWPatient");
  assert.equal(canonicalTail("http://hl7.org/fhir/StructureDefinition/Extension/"), "Extension");
  assert.equal(canonicalTail("Patient"), "Patient");
});

test("shapeDigest: extension value type prefers the snapshot and detects complex extensions", () => {
  const simple = shapeDigest("StructureDefinition", "extension", {
    type: "Extension",
    base_definition: "http://hl7.org/fhir/StructureDefinition/Extension",
    context: [{ type: "element", expression: "Address" }],
    differential: 5,
    must_support: 0,
    required: 0,
    value_types_snapshot: ["string"],
    value_types_differential: ["code"],
    value_prohibited: false,
    sub_extensions: [],
  });
  assert.deepEqual(simple.value_types, ["string"]);
  assert.equal(simple.complex, false);
  assert.deepEqual(simple.contexts, [{ type: "element", expression: "Address" }]);
  assert.equal(simple.base_name, "Extension");

  const complex = shapeDigest("StructureDefinition", "extension", {
    type: "Extension",
    value_types_snapshot: [],
    value_types_differential: ["string"],
    value_prohibited: true,
    sub_extensions: ["part", "part", "text"],
  });
  assert.equal(complex.complex, true);
  assert.deepEqual(complex.value_types, []);
  assert.deepEqual(complex.sub_extensions, ["part", "text"]);
});

test("shapeDigest: logical model type URL is reduced to its tail; profiles carry no extension fields", () => {
  const d = shapeDigest("StructureDefinition", "logical", { type: "https://twcore/StructureDefinition/TWPatient", differential: 9, required: 2 });
  assert.equal(d.type, "TWPatient");
  assert.equal(d.required, 2);
  assert.equal("value_types" in d, false);
});

test("shapeDigest: ValueSet compose summary", () => {
  const d = shapeDigest("ValueSet", "terminology", {
    include: [
      { system: "http://loinc.org", concepts: 3, filters: [], value_sets: null },
      { system: "http://snomed.info/sct", concepts: 0, filters: [{ property: "concept", op: "is-a", value: "404684003" }] },
      { system: null, concepts: 0, filters: [], value_sets: ["http://x/ValueSet/a"] },
      { system: "http://loinc.org", concepts: 2 },
    ],
    exclude: 1,
    expansion_total: null,
    expansion_contains: 0,
  });
  assert.deepEqual(d.systems, ["http://loinc.org", "http://snomed.info/sct"]);
  assert.equal(d.enumerated, 5);
  assert.equal(d.exclude, 1);
  assert.equal(d.expansion_total, null);
  assert.deepEqual((d.include as Row[])[1].filters, ["concept is-a 404684003"]);
  assert.deepEqual((d.include as Row[])[2].value_sets, ["http://x/ValueSet/a"]);
});

test("shapeDigest: ConceptMap groups, SearchParameter and example meta.profile", () => {
  const cm = shapeDigest("ConceptMap", "terminology", { source: "a", target: "b", groups: [{ source: "s", target: "t", elements: 4, targets: 5 }, { elements: 2 }] });
  assert.equal(cm.elements, 6);
  const sp = shapeDigest("SearchParameter", "search", { code: "identifier", type: "token", base: ["Patient"], expression: "Patient.identifier" });
  assert.deepEqual(sp.base, ["Patient"]);
  assert.deepEqual(sp.target, []);
  const ex = shapeDigest("Observation", "example", { profiles: ["https://x/StructureDefinition/BMI|1.0"], coding: { system: "http://loinc.org", code: "39156-5", display: "BMI" } });
  assert.deepEqual(ex.profiles, ["https://x/StructureDefinition/BMI|1.0"]);
  assert.deepEqual(ex.coding, { system: "http://loinc.org", code: "39156-5", display: "BMI" });
  assert.equal(shapeDigest("Patient", "example", { profiles: null }).coding, null);
});

test("shapeItem never uses an example's HumanName repr as its title", () => {
  const item = shapeItem({
    artifact_key: "Patient/pat-example",
    resource_type: "Patient",
    artifact_id: "pat-example",
    title: "[{'use': 'official', 'text': '陳加玲'}]",
    name: "[{'use': 'official', 'text': '陳加玲'}]",
    category: "example",
    grp: "Patient",
    digest: { profiles: [] },
  });
  assert.equal(item.title, "pat-example");
  assert.equal(item.name, null);
  const sd = shapeItem({ artifact_key: "StructureDefinition/p", resource_type: "StructureDefinition", artifact_id: "p", title: "", name: "TWPatient", category: "profile", grp: "Patient", example_count: "3", digest: {} });
  assert.equal(sd.title, "TWPatient");
  assert.equal(sd.example_count, 3);
});

test("shapeCategories orders categories and sorts groups by count", () => {
  const out = shapeCategories([
    { category: "search", grp: "Patient", n: 2 },
    { category: "profile", grp: "Patient", n: 1 },
    { category: "profile", grp: "Observation", n: 26 },
    { category: "unknown", grp: "", n: 9 },
  ]);
  assert.deepEqual(
    out.map((c) => [c.key, c.count]),
    [
      ["profile", 27],
      ["search", 2],
    ],
  );
  assert.deepEqual(out[0].groups.map((g) => g.key), ["Observation", "Patient"]);
});

test("systemSupport maps external systems to modules or built-in tables", () => {
  assert.equal(systemSupport("http://snomed.info/sct")?.module, "snomed");
  assert.equal(systemSupport("http://loinc.org")?.module, "loinc");
  assert.equal(systemSupport("http://hl7.org/fhir/sid/icd-10-cm")?.module, "icd");
  assert.equal(systemSupport("http://www.nlm.nih.gov/research/umls/rxnorm")?.module, "rxnorm");
  assert.equal(systemSupport("http://unitsofmeasure.org")?.builtin, true);
  assert.equal(systemSupport("http://terminology.hl7.org/CodeSystem/v2-0203"), null);
});

const PKGS: InstalledPackage[] = [
  { package_id: "tw.core", version: "1.0.0", title: "TW Core", dependencies: { "hl7.fhir.r4.core": "4.0.1", "hl7.ext": "5.2.0", "missing.pkg": "1.0.0" } },
  { package_id: "hl7.fhir.r4.core", version: "4.0.1", title: "Core", dependencies: {} },
  { package_id: "hl7.ext", version: "5.2.0", title: "Ext", dependencies: { "hl7.fhir.r4.core": "4.0.0" } },
  { package_id: "tw.pas", version: "1.2.7", title: "PAS", dependencies: { "tw.core": "1.0.0" } },
  { package_id: "cyc.a", version: "1", title: null, dependencies: { "cyc.b": "1" } },
  { package_id: "cyc.b", version: "1", title: null, dependencies: { "cyc.a": "1" } },
];

test("buildDependencyTree marks installed / missing / repeated and applies version aliases", () => {
  const t = buildDependencyTree(PKGS, "tw.core", "1.0.0");
  assert.equal(t.installed, true);
  assert.deepEqual(t.children.map((c) => [c.package_id, c.installed, c.repeated]), [
    ["hl7.ext", true, false],
    ["hl7.fhir.r4.core", true, false],
    ["missing.pkg", false, false],
  ]);
  // hl7.ext declares core 4.0.0, which resolves to the installed 4.0.1 and was already shown.
  const viaExt = t.children[0].children[0];
  assert.equal(viaExt.version, "4.0.1");
  assert.equal(viaExt.declared_version, "4.0.0");
  assert.equal(viaExt.repeated, true);
  assert.deepEqual(closureOf(t).map((c) => `${c.package_id}@${c.version}:${c.depth}`), ["hl7.ext@5.2.0:1", "hl7.fhir.r4.core@4.0.1:1", "missing.pkg@1.0.0:1"]);
});

test("buildDependencyTree terminates on cycles", () => {
  const t = buildDependencyTree(PKGS, "cyc.a", "1");
  assert.equal(t.children[0].package_id, "cyc.b");
  assert.equal(t.children[0].children[0].repeated, true);
  assert.deepEqual(t.children[0].children[0].children, []);
});

test("directDependentsOf and parseDeps", () => {
  assert.deepEqual(directDependentsOf(PKGS, "tw.core", "1.0.0").map((d) => d.package_id), ["tw.pas"]);
  assert.deepEqual(directDependentsOf(PKGS, "hl7.fhir.r4.core", "4.0.1").map((d) => d.package_id), ["hl7.ext", "tw.core"]);
  assert.deepEqual(parseDeps('{"a":"1"}'), { a: "1" });
  assert.deepEqual(parseDeps("not json"), {});
  assert.deepEqual(parseDeps(null), {});
});

test("pickDefinitions prefers the IG's closure, then complete content", () => {
  const rows = [
    { canonical_url: "u", package_id: "other", package_version: "1", content: "complete", concept_count: 99 },
    { canonical_url: "u", package_id: "dep", package_version: "2", content: "not-present", concept_count: 0 },
    { canonical_url: "v", package_id: "a", package_version: "1", content: "fragment", concept_count: 5 },
    { canonical_url: "v", package_id: "b", package_version: "1", content: "complete", concept_count: 3 },
  ];
  const m = pickDefinitions(rows, new Set(["dep@2"]));
  assert.equal(m.get("u")?.package_id, "dep");
  assert.equal(m.get("u")?.in_closure, true);
  assert.equal(m.get("v")?.package_id, "b");
  assert.equal(m.get("v")?.in_closure, false);
});

test("flattenConcepts is pre-order with depth and parent; conceptMatches searches designations", () => {
  const flat = flattenConcepts({
    concept: [
      { code: "A", display: "Alpha", concept: [{ code: "A1", display: "Alpha one", designation: [{ language: "zh-TW", value: "甲一" }] }] },
      { code: "B", display: "Beta" },
    ],
  });
  assert.deepEqual(flat.map((c) => [c.code, c.depth, c.parent]), [
    ["A", 1, null],
    ["A1", 2, "A"],
    ["B", 1, null],
  ]);
  assert.equal(flat[0].child_count, 1);
  assert.equal(conceptMatches(flat[1], "甲"), true);
  assert.equal(conceptMatches(flat[1], "beta"), false);
  assert.equal(conceptMatches(flat[2], ""), true);
});

test("levelStats derives total and depth from per-level counts", () => {
  assert.deepEqual(levelStats([5, 0, 0, 0, 0, 0]), { total: 5, depth: 1, deeper: false });
  assert.deepEqual(levelStats([10, 40, 3, 0, 0, 0]), { total: 53, depth: 3, deeper: false });
  assert.deepEqual(levelStats([1, 1, 1, 1, 1, 1]), { total: 6, depth: 6, deeper: true });
  assert.deepEqual(levelStats([0, 0, 0, 0, 0, 0]), { total: 0, depth: 0, deeper: false });
});

test("router: unknown routes, non-GET, missing params and uninstalled packages", async () => {
  const q = fakeQ([["FROM fhir.ig_packages WHERE package_id = $1 AND version = $2", () => []]]);
  assert.equal(await handleIgExplorerApi(q, "GET", "/admin/api/igs", {}), null);
  assert.equal((await handleIgExplorerApi(q, "GET", "/admin/api/ig-explorer/nope", {}))?.status, 404);
  assert.equal((await handleIgExplorerApi(q, "POST", "/admin/api/ig-explorer/overview", {}))?.status, 405);
  assert.equal((await handleIgExplorerApi(q, "GET", "/admin/api/ig-explorer/overview", { package_id: "x" }))?.status, 400);
  const r = await handleIgExplorerApi(q, "GET", "/admin/api/ig-explorer/overview", { package_id: "x", version: "1" });
  assert.equal(r?.status, 404);
});

test("artifacts: scoped to package + version, filters by category / group, search is a LIKE parameter", async () => {
  const q = fakeQ([
    ["FROM fhir.ig_packages WHERE package_id = $1 AND version = $2", () => [{ package_id: "p", version: "1", imported_at: "t" }]],
    [
      "GROUP BY 1, 2",
      () => [
        { category: "profile", grp: "Patient", n: 1 },
        { category: "profile", grp: "Observation", n: 2 },
        { category: "search", grp: "Patient", n: 4 },
      ],
    ],
    [
      "LIMIT $",
      () => [{ artifact_key: "StructureDefinition/o", resource_type: "StructureDefinition", artifact_id: "o", title: "Obs", category: "profile", grp: "Observation", example_count: 2, digest: { type: "Observation", differential: 3 } }],
    ],
  ]);
  const r = await handleIgExplorerApi(q, "GET", "/admin/api/ig-explorer/artifacts", { package_id: "p", version: "1", category: "profile", group: "Observation", q: "50%_" });
  assert.equal(r?.status, 200);
  const body = r!.body as Row;
  assert.equal(body.total, 2);
  assert.deepEqual((body.groups as Row[]).map((g) => g.key), ["Observation", "Patient"]);
  assert.equal(((body.items as Row[])[0].digest as Row).type, "Observation");
  const list = q.calls.find((c) => c.sql.includes("LIMIT $"))!;
  assert.deepEqual(list.params.slice(0, 5), ["p", "1", "%50\\%\\_%", "profile", "Observation"]);
  assert.match(list.sql, /a\.package_id = \$1 AND a\.package_version = \$2/);
  // Unknown categories are rejected before any data query.
  const bad = await handleIgExplorerApi(q, "GET", "/admin/api/ig-explorer/artifacts", { package_id: "p", version: "1", category: "drop table" });
  assert.equal(bad?.status, 400);
});
