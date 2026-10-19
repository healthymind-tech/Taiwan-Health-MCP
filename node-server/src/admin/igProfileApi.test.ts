import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bareCanonical,
  buildElementRows,
  clearProfileCache,
  collectCanonicals,
  envelopeError,
  extensionInfo,
  handleIgProfileApi,
  immediateParent,
  nearestParent,
  pickLinks,
  walkBaseChain,
  type ProfileApiDeps,
  type ProfileToolService,
} from "./igProfileApi.js";

const SD = {
  resourceType: "StructureDefinition",
  url: "https://example.org/StructureDefinition/Patient-x",
  type: "Patient",
  baseDefinition: "http://hl7.org/fhir/StructureDefinition/Patient",
  derivation: "constraint",
  snapshot: {
    element: [
      { id: "Patient", path: "Patient", min: 0, max: "*", base: { path: "Patient", min: 0, max: "*" } },
      {
        id: "Patient.identifier",
        path: "Patient.identifier",
        min: 1,
        max: "*",
        base: { path: "Patient.identifier", min: 0, max: "*" },
        mustSupport: true,
        type: [{ code: "Identifier" }],
        slicing: { discriminator: [{ type: "value", path: "system" }], rules: "open" },
        constraint: [{ key: "ele-1", severity: "error", expression: "hasValue()" }],
      },
      { id: "Patient.identifier.system", path: "Patient.identifier.system", min: 0, max: "1", base: { path: "Identifier.system", min: 0, max: "1" }, type: [{ code: "uri" }] },
      {
        id: "Patient.identifier:idCard",
        path: "Patient.identifier",
        sliceName: "idCard",
        min: 0,
        max: "1",
        base: { path: "Patient.identifier", min: 0, max: "*" },
        type: [{ code: "Identifier" }],
        constraint: [
          { key: "ele-1", severity: "error" },
          { key: "id-card", severity: "error", human: "ten chars", expression: "value.matches('^[A-Z][0-9]{9}$')" },
        ],
      },
      { id: "Patient.identifier:idCard.system", path: "Patient.identifier.system", min: 1, max: "1", fixedUri: "http://www.moi.gov.tw", type: [{ code: "uri" }] },
      {
        id: "Patient.managingOrganization",
        path: "Patient.managingOrganization",
        min: 0,
        max: "1",
        type: [{ code: "Reference", targetProfile: ["https://example.org/StructureDefinition/Organization-x"] }],
      },
      {
        id: "Patient.gender",
        path: "Patient.gender",
        min: 1,
        max: "1",
        type: [{ code: "code" }],
        binding: { strength: "required", valueSet: "http://hl7.org/fhir/ValueSet/administrative-gender|4.0.1" },
      },
    ],
  },
  differential: {
    element: [
      { id: "Patient.identifier", path: "Patient.identifier", min: 1, mustSupport: true },
      { id: "Patient.identifier:idCard", path: "Patient.identifier", sliceName: "idCard", max: "1" },
      { id: "Patient.identifier:idCard.system", path: "Patient.identifier.system", min: 1, fixedUri: "http://www.moi.gov.tw" },
    ],
  },
};

test("immediateParent: slices hang under the sliced element, re-slices under the slice", () => {
  assert.equal(immediateParent("Patient"), null);
  assert.equal(immediateParent("Patient.identifier"), "Patient");
  assert.equal(immediateParent("Patient.identifier:idCard"), "Patient.identifier");
  assert.equal(immediateParent("Patient.identifier:idCard.system"), "Patient.identifier:idCard");
  assert.equal(immediateParent("Observation.value[x]:valueQuantity"), "Observation.value[x]");
  assert.equal(immediateParent("Patient.extension:a/b"), "Patient.extension:a");
});

test("nearestParent skips levels a differential leaves out", () => {
  const known = new Set(["Patient", "Patient.identifier:idCard.system"]);
  assert.equal(nearestParent("Patient.identifier:idCard.system", known), "Patient");
});

test("buildElementRows: tree shape, differential flags, cardinality change, constraints", () => {
  const { rows, source, differentialCount } = buildElementRows(SD);
  assert.equal(source, "snapshot");
  assert.equal(differentialCount, 3);
  const by = new Map(rows.map((r) => [r.id, r]));
  assert.equal(by.get("Patient")!.depth, 0);
  assert.equal(by.get("Patient")!.hasChildren, true);
  const ident = by.get("Patient.identifier")!;
  assert.equal(ident.depth, 1);
  assert.equal(ident.cardChanged, true);
  assert.equal(ident.inDiff, true);
  assert.deepEqual(ident.diffKeys, ["min", "mustSupport"]);
  assert.equal(ident.constraintCount, 0);
  assert.deepEqual(ident.slicing?.discriminator, [{ type: "value", path: "system" }]);
  const slice = by.get("Patient.identifier:idCard")!;
  assert.equal(slice.parent, "Patient.identifier");
  assert.equal(slice.name, "identifier");
  assert.equal(slice.sliceName, "idCard");
  assert.equal(slice.depth, 2);
  assert.equal(slice.constraintCount, 1);
  const sys = by.get("Patient.identifier:idCard.system")!;
  assert.equal(sys.parent, "Patient.identifier:idCard");
  assert.deepEqual(sys.fixed, { field: "fixedUri", value: "http://www.moi.gov.tw" });
  assert.equal(sys.cardChanged, false, "no base → not flagged");
  assert.equal(by.get("Patient.gender")!.inDiff, false);
  assert.equal(by.get("Patient.gender")!.binding?.strength, "required");
});

test("buildElementRows falls back to the differential when there is no snapshot", () => {
  const { rows, source } = buildElementRows({ ...SD, snapshot: undefined });
  assert.equal(source, "differential");
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.inDiff));
  assert.equal(rows[0].parent, null);
  assert.equal(rows[2].parent, "Patient.identifier:idCard");
  assert.equal(buildElementRows({}).source, "none");
});

test("collectCanonicals: profiles, targets, bindings (unversioned) and core complex types", () => {
  const { rows } = buildElementRows(SD);
  assert.deepEqual(collectCanonicals(rows), [
    "http://hl7.org/fhir/StructureDefinition/Identifier",
    "http://hl7.org/fhir/StructureDefinition/Reference",
    "http://hl7.org/fhir/ValueSet/administrative-gender",
    "https://example.org/StructureDefinition/Organization-x",
  ]);
  assert.equal(bareCanonical("http://x/y|1.0"), "http://x/y");
});

test("pickLinks prefers the owner earliest in the closure", () => {
  const rows = [
    { canonical_url: "http://a", package_id: "other", package_version: "1", artifact_id: "a", resource_type: "StructureDefinition", title: "Other" },
    { canonical_url: "http://a", package_id: "dep", package_version: "2", artifact_id: "a", resource_type: "StructureDefinition", title: "Dep" },
    { canonical_url: "http://a", package_id: "me", package_version: "1", artifact_id: "a", resource_type: "StructureDefinition", title: null, name: "Mine" },
  ];
  const links = pickLinks(rows, [["me", "1"], ["dep", "2"]]);
  assert.equal(links["http://a"].package_id, "me");
  assert.equal(links["http://a"].title, "Mine");
  assert.equal(pickLinks(rows.slice(0, 2), [["me", "1"], ["dep", "2"]])["http://a"].package_id, "dep");
});

test("walkBaseChain: root first, stops at a missing definition and on cycles", async () => {
  const defs: Record<string, any> = {
    "http://hl7.org/fhir/StructureDefinition/Patient": {
      artifact_id: "Patient",
      package_id: "core",
      package_version: "4.0.1",
      derivation: "specialization",
      raw_json: { name: "Patient", baseDefinition: "http://hl7.org/fhir/StructureDefinition/DomainResource" },
    },
  };
  const chain = await walkBaseChain(
    { canonical: SD.url, artifact_id: "Patient-x", package_id: "me", version: "1", title: "X", derivation: "constraint", kind: "resource", baseDefinition: SD.baseDefinition + "|4.0.1" },
    async (u) => defs[u] ?? null,
  );
  assert.deepEqual(
    chain.map((c) => [c.title, c.installed]),
    [
      ["DomainResource", false],
      ["Patient", true],
      ["X", true],
    ],
  );
  const loop = await walkBaseChain(
    { canonical: "http://a", artifact_id: "a", package_id: "p", version: "1", title: "A", derivation: null, kind: null, baseDefinition: "http://b" },
    async (u) => ({ artifact_id: u, raw_json: { baseDefinition: u === "http://b" ? "http://a" : null } }),
  );
  assert.equal(loop.length, 2);
});

test("extensionInfo: simple and complex extensions", () => {
  const simple = {
    type: "Extension",
    context: [{ type: "element", expression: "Patient" }],
    snapshot: {
      element: [
        { id: "Extension", path: "Extension" },
        { id: "Extension.extension", path: "Extension.extension", max: "0" },
        { id: "Extension.url", path: "Extension.url", fixedUri: "http://x/age" },
        { id: "Extension.value[x]", path: "Extension.value[x]", min: 1, max: "1", type: [{ code: "Age" }] },
      ],
    },
  };
  const s = extensionInfo(simple, buildElementRows(simple).rows)!;
  assert.deepEqual(s.context, [{ type: "element", expression: "Patient" }]);
  assert.deepEqual(s.valueTypes.map((t) => t.code), ["Age"]);
  assert.equal(s.complex, false);

  const complex = {
    type: "Extension",
    snapshot: {
      element: [
        { id: "Extension", path: "Extension" },
        { id: "Extension.extension", path: "Extension.extension" },
        { id: "Extension.extension:code", path: "Extension.extension", sliceName: "code", min: 1, max: "1", short: "the code" },
        { id: "Extension.extension:code.url", path: "Extension.extension.url", fixedUri: "code" },
        { id: "Extension.extension:code.value[x]", path: "Extension.extension.value[x]", type: [{ code: "CodeableConcept" }] },
        { id: "Extension.value[x]", path: "Extension.value[x]", max: "0", type: [{ code: "string" }] },
      ],
    },
  };
  const c = extensionInfo(complex, buildElementRows(complex).rows)!;
  assert.equal(c.complex, true);
  assert.deepEqual(c.subExtensions, [{ sliceName: "code", url: "code", min: 1, max: "1", short: "the code", valueTypes: ["CodeableConcept"] }]);
  assert.equal(extensionInfo(SD, []), null);
});

test("envelopeError maps tool codes to admin error bodies", () => {
  const r = envelopeError({ ok: false, error: { code: "INVALID_ARGUMENT", message: "x is not a StructureDefinition with a snapshot" } });
  assert.equal(r.status, 422);
  assert.equal((r.body as any).code, "PROFILE_NO_SNAPSHOT");
  assert.ok((r.body as any).message_zh);
  assert.equal(envelopeError({ ok: false, error: { code: "ARTIFACT_NOT_FOUND", message: "m" } }).status, 404);
});

function fakeDeps(calls: string[]): ProfileApiDeps {
  const env = (data: unknown) => JSON.stringify({ ok: true, data, warnings: [], provenance: { packageId: "me", version: "1" } });
  const svc: ProfileToolService = {
    getProfile: async (id) => (calls.push(`getProfile ${id}`), env({ artifactId: "Patient-x", canonical: id })),
    getProfileElements: async (p, _a, _b, view) => (calls.push(`elements ${view}`), env({ count: 0, examples: [] })),
    getProfileRequiredElements: async (p, pid, ver, inst, ti, ms, verb) => (calls.push(`required ${p} ${pid} ${ver} ${ms} ${verb}`), env({ elements: [] })),
    getResourceSkeleton: async (p) => (calls.push(`skeleton ${p}`), env({ fields: [] })),
    expandValueset: async (u, _p, _v, limit) => (calls.push(`expand ${u} ${limit}`), JSON.stringify({ ok: false, error: { code: "VALUESET_NOT_FOUND", message: "nope" } })),
  };
  return {
    query: async (sql) => {
      if (sql.includes("AND (artifact_id = $3 OR canonical_url = $3)")) {
        return { rows: [{ package_id: "me", package_version: "1", artifact_id: "Patient-x", canonical_url: SD.url, title: "X", base_type: "Patient", raw_json: SD }] };
      }
      return { rows: [] };
    },
    service: async () => svc,
    closure: async () => [["me", "1"]],
  };
}

test("handleIgProfileApi: routes reuse the tool methods with the profile canonical", async () => {
  clearProfileCache();
  const calls: string[] = [];
  const deps = fakeDeps(calls);
  const q = { package_id: "me", version: "1", artifact_id: "Patient-x" };
  assert.equal(await handleIgProfileApi(deps, "GET", "/admin/api/igs/other", q), null);
  assert.equal((await handleIgProfileApi(deps, "POST", "/admin/api/igs/profile", q))!.status, 405);
  assert.equal((await handleIgProfileApi(deps, "GET", "/admin/api/igs/profile", { package_id: "me" }))!.status, 400);

  const view = await handleIgProfileApi(deps, "GET", "/admin/api/igs/profile", q);
  assert.equal(view!.status, 200);
  const body = view!.body as any;
  assert.equal(body.elements.length, 7);
  assert.equal(body.base_chain.at(-1).artifact_id, "Patient-x");
  assert.equal(body.base_chain[0].installed, false);
  // cached: a second call does not touch the service again
  const before = calls.length;
  await handleIgProfileApi(deps, "GET", "/admin/api/igs/profile", q);
  assert.equal(calls.length, before);

  await handleIgProfileApi(deps, "GET", "/admin/api/igs/profile/required", { ...q, verbosity: "full", include_mustsupport: "true" });
  assert.ok(calls.includes(`required ${SD.url} me 1 true full`));
  await handleIgProfileApi(deps, "GET", "/admin/api/igs/profile/skeleton", q);
  assert.ok(calls.includes(`skeleton ${SD.url}`));
  const vs = await handleIgProfileApi(deps, "GET", "/admin/api/igs/profile/valueset", { package_id: "me", version: "1", url: "http://vs", limit: "500" });
  assert.equal(vs!.status, 404);
  assert.ok(calls.includes("expand http://vs 200"));
  const ex = await handleIgProfileApi(deps, "GET", "/admin/api/igs/profile/example", { ...q, artifact_id: "nope" });
  assert.equal(ex!.status, 404);
});
