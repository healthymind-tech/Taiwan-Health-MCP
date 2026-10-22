/**
 * fhirBundleFinalize against real IG packages (ISSUES_v9 §5): TW Core 1.0.0, TWPAS 1.2.7 and
 * FHIR R4 core only. StructureDefinitions are read from a local FHIR package cache
 * (FHIR_PACKAGE_CACHE, default ~/.fhir/packages); the TWPAS example Bundles from
 * FHIR_EXAMPLES_DIR or the package's example folder. Every case is skipped when the data is
 * not present, so the suite stays green on a bare checkout. Bundles here are synthetic or the
 * IG's own published examples (never private fixtures).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { finalizeBundle, type FinalizeDeps } from "./fhirBundleFinalize.js";

const CACHE = process.env.FHIR_PACKAGE_CACHE || join(homedir(), ".fhir", "packages");
const CORE_PKG = "hl7.fhir.r4.core#4.0.1";
const TWCORE_PKG = "tw.gov.mohw.twcore#1.0.0";
const PAS_PKG = "tw.gov.mohw.nhi.pas#1.2.7";
const TWCORE = "https://twcore.mohw.gov.tw/ig/twcore/StructureDefinition";
const UUID = /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function pkgDir(spec: string): string | null {
  const dir = join(CACHE, spec, "package");
  return existsSync(join(dir, ".index.json")) ? dir : null;
}

/** StructureDefinition lookup over a closure of package dirs (first package wins, like a closure order). */
function fileDeps(specs: string[]): FinalizeDeps | null {
  const dirs = specs.map(pkgDir);
  if (dirs.some((d) => d === null)) return null;
  const files = new Map<string, string>();
  for (const dir of dirs as string[]) {
    const index = JSON.parse(readFileSync(join(dir, ".index.json"), "utf8")) as { files: Array<{ filename: string; resourceType: string; url?: string }> };
    for (const f of index.files) {
      if (f.resourceType === "StructureDefinition" && f.url && !files.has(f.url)) files.set(f.url, join(dir, f.filename));
    }
  }
  const cache = new Map<string, Record<string, any> | null>();
  return {
    fetchStructureDefinition: async (url) => {
      const key = url.split("|")[0];
      if (!cache.has(key)) {
        const p = files.get(key);
        cache.set(key, p ? (JSON.parse(readFileSync(p, "utf8")) as Record<string, any>) : null);
      }
      return cache.get(key) ?? null;
    },
  };
}

function exampleBundles(): Array<[string, Record<string, any>]> {
  const dirs = [process.env.FHIR_EXAMPLES_DIR, pkgDir(PAS_PKG) ? join(pkgDir(PAS_PKG)!, "example") : null].filter((d): d is string => !!d && existsSync(d));
  const out: Array<[string, Record<string, any>]> = [];
  for (const dir of dirs) {
    for (const f of readdirSync(dir).filter((n) => /^Bundle-.*\.json$/.test(n)).sort()) {
      const b = JSON.parse(readFileSync(join(dir, f), "utf8")) as Record<string, any>;
      if (b.resourceType === "Bundle" && Array.isArray(b.entry) && String((b.meta?.profile ?? [])[0] ?? "").includes("nhicore.nhi.gov.tw")) out.push([f, b]);
    }
    if (out.length) break;
  }
  return out;
}

// ---- helpers shared by the IG cases -------------------------------------------------------

const strip = (x: unknown): unknown => JSON.parse(JSON.stringify(x, (k, v) => (k === "fullUrl" || k === "reference" || k === "id" ? undefined : v)));

/**
 * (source entry index, path, target entry index) for every reference that names an entry.
 * loose: by any form the model may use (fullUrl, case-different, last segment, Type/id, bare id);
 * strict: the way the HL7 validator resolves (exact fullUrl, or Type/id against the source entry's RESTful base).
 */
function graph(b: Record<string, any>, strict = false): Set<string> {
  const look = new Map<string, number>();
  b.entry.forEach((e: any, i: number) => {
    if (typeof e.fullUrl === "string") {
      look.set(e.fullUrl, i);
      if (!strict) {
        look.set(e.fullUrl.toLowerCase(), i);
        look.set(e.fullUrl.split(/[:/]/).pop()!, i);
      }
    }
    const r = e.resource;
    if (!strict && r?.id !== undefined) {
      look.set(`${r.resourceType}/${r.id}`, i);
      look.set(String(r.id), i);
    }
  });
  const edges = new Set<string>();
  const walk = (x: unknown, path: string, src: number): void => {
    if (Array.isArray(x)) x.forEach((v) => walk(v, path, src));
    else if (x && typeof x === "object") {
      for (const [k, v] of Object.entries(x as Record<string, unknown>)) {
        if (k === "reference" && typeof v === "string") {
          const base = v.replace(/\/_history\/[^/]+$/, "");
          let t = look.get(base);
          if (t === undefined && strict && /^[A-Z][A-Za-z]+\/[^/]+$/.test(base)) {
            const fu = String(b.entry[src].fullUrl ?? "");
            const self = `${b.entry[src].resource.resourceType}/${b.entry[src].resource.id}`;
            if (/^https?:\/\//.test(fu) && fu.endsWith("/" + self)) t = look.get(fu.slice(0, fu.length - self.length) + base);
          }
          if (t === undefined && !strict) t = look.get(base.toLowerCase()) ?? look.get(base.split(/[:/]/).pop()!);
          if (t !== undefined && !v.startsWith("#")) edges.add(`${src} ${path}.${k} ${t}`);
        } else walk(v, `${path}.${k}`, src);
      }
    }
  };
  b.entry.forEach((e: any, i: number) => walk(e.resource, "", i));
  return edges;
}

/** The five corruptions of ISSUES_v9 §6 T4 (port of check_issues_v9.corrupt). */
function corrupt(input: Record<string, any>, kind: "readable" | "upper" | "type_id" | "no_fullurl" | "bundle_id"): Record<string, any> {
  const b = JSON.parse(JSON.stringify(input)) as Record<string, any>;
  const map = new Map<string, string>();
  b.entry.forEach((e: any, n: number) => {
    const old: string | undefined = e.fullUrl;
    const rt = String(e.resource?.resourceType ?? "X");
    if (kind === "readable") map.set(old!, `urn:uuid:${rt.toLowerCase()}-${n + 1}`);
    else if (kind === "upper") map.set(old!, "urn:uuid:" + old!.split(":").pop()!.toUpperCase());
    else if (kind === "type_id" || kind === "no_fullurl") {
      e.resource.id = `${rt.toLowerCase()}${n + 1}`;
      map.set(old!, `${rt}/${rt.toLowerCase()}${n + 1}`);
    }
  });
  let s = JSON.stringify(b);
  for (const [o, nw] of [...map.entries()].sort((a, c) => c[0].length - a[0].length)) if (o) s = s.split(JSON.stringify(o)).join(JSON.stringify(nw));
  const out = JSON.parse(s) as Record<string, any>;
  if (kind === "type_id") out.entry.forEach((e: any, i: number) => (e.fullUrl = input.entry[i].fullUrl));
  if (kind === "no_fullurl") out.entry.forEach((e: any) => delete e.fullUrl);
  if (kind === "bundle_id") out.id = "urn:uuid:" + "0123456789abcdef0123456789abcdef".replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
  return out;
}

function assertFinalized(name: string, original: Record<string, any>, corrupted: Record<string, any>, r: Awaited<ReturnType<typeof finalizeBundle>>): void {
  const fullUrls = new Set<string>(r.bundle.entry.map((e: any) => e.fullUrl));
  for (const fu of fullUrls) assert.match(fu, /^(urn:uuid:[0-9a-f-]{36}|https?:\/\/\S+|urn:oid:[0-9.]+)$/, `${name}: fullUrl ${fu}`);
  assert.equal(fullUrls.size, r.bundle.entry.length, `${name}: unique fullUrls`);
  assert.deepEqual(strip(r.bundle), strip(corrupted), `${name}: only fullUrl / reference / id changed`);
  // Every reference that named an entry in the published example (loosely) must resolve the HL7 way in the output.
  const g0 = graph(original);
  const g1 = graph(r.bundle, true);
  for (const edge of g0) assert.ok(g1.has(edge), `${name}: edge ${edge} resolves strictly after finalize`);
  // Only references that were dangling in the published example may stay unresolved.
  const dangling0 = graph(original).size;
  for (const u of r.unresolved) {
    const edgeOf = [...graph(corrupted)].find((e) => e.startsWith(`${u.path.replace(/^Bundle\.entry\[(\d+)\]\.resource/, "$1 ")}`));
    assert.equal(edgeOf, undefined, `${name}: ${u.path} ${u.reference} was resolvable (${edgeOf}) but left unresolved`);
  }
  assert.ok(dangling0 >= 0);
  if (typeof r.bundle.id === "string") assert.match(r.bundle.id, /^[A-Za-z0-9\-.]{1,64}$/);
}

// ---- 1. TW Core 1.0.0 ---------------------------------------------------------------------

const twcoreDeps = fileDeps([TWCORE_PKG, CORE_PKG]);

/** Synthetic TW Core document: Composition (not first), Encounter with a Reference-valued core extension, Condition. */
function twcoreDocument(): Record<string, any> {
  return {
    resourceType: "Bundle",
    id: "urn:uuid:doc-1",
    meta: { profile: [`${TWCORE}/Bundle-document-twcore`] },
    type: "collection",
    entry: [
      { fullUrl: "urn:uuid:patient-1", resource: { resourceType: "Patient", id: "patient-1", meta: { profile: [`${TWCORE}/Patient-twcore`] }, name: [{ text: "王大明" }], gender: "male" } },
      {
        fullUrl: "urn:uuid:encounter-1",
        resource: {
          resourceType: "Encounter",
          id: "encounter-1",
          meta: { profile: [`${TWCORE}/Encounter-twcore`] },
          extension: [{ url: "http://hl7.org/fhir/StructureDefinition/encounter-associatedEncounter", valueReference: { reference: "Encounter/encounter-2" } }],
          status: "finished",
          class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "AMB" },
          subject: { reference: "Patient/patient-1" },
        },
      },
      { fullUrl: "urn:uuid:ENCOUNTER-2", resource: { resourceType: "Encounter", id: "encounter-2", status: "finished", class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "AMB" }, subject: { reference: "patient-1" } } },
      {
        fullUrl: "urn:uuid:condition-1",
        resource: {
          resourceType: "Condition",
          meta: { profile: [`${TWCORE}/Condition-twcore`] },
          clinicalStatus: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-clinical", code: "active" }] },
          code: { text: "x" },
          subject: { reference: "urn:uuid:patient-1" },
          encounter: { reference: "encounter-1" },
          asserter: { reference: "Practitioner/pr-1" },
        },
      },
      {
        fullUrl: "urn:uuid:composition-1",
        resource: {
          resourceType: "Composition",
          meta: { profile: [`${TWCORE}/Composition-twcore`] },
          status: "final",
          type: { text: "t" },
          date: "2024-01-01",
          title: "x",
          subject: { reference: "patient-1" },
          encounter: { reference: "urn:uuid:encounter-1" },
          author: [{ reference: "Practitioner/pr-1" }],
          section: [{ title: "s", entry: [{ reference: "condition-1" }] }],
        },
      },
      { fullUrl: "urn:uuid:pr-1", resource: { resourceType: "Practitioner", id: "pr-1", meta: { profile: [`${TWCORE}/Practitioner-twcore`] }, name: [{ text: "Dr" }] } },
    ],
  };
}

test("TW Core 1.0.0: labels, extension references, document type + order from Bundle-document-twcore", { skip: !twcoreDeps && "package cache not available" }, async () => {
  const b = twcoreDocument();
  const r = await finalizeBundle(b, twcoreDeps);
  assert.equal(r.bundle.type, "document", "patternCode document applied from the profile");
  assert.equal(r.bundle.entry[0].resource.resourceType, "Composition");
  const fuOf = (rt: string, id?: string): string => r.bundle.entry.find((e: any) => e.resource.resourceType === rt && (id === undefined || e.resource.id === id))!.fullUrl;
  for (const e of r.bundle.entry) assert.match(e.fullUrl, UUID);
  const enc1 = r.bundle.entry.find((e: any) => e.resource.id === "encounter-1")!.resource;
  assert.equal(enc1.extension[0].valueReference.reference, fuOf("Encounter", "encounter-2"), "core extension valueReference found through the Extension definition");
  assert.equal(enc1.subject.reference, fuOf("Patient"));
  const cond = r.bundle.entry.find((e: any) => e.resource.resourceType === "Condition")!.resource;
  assert.equal(cond.encounter.reference, fuOf("Encounter", "encounter-1"));
  assert.equal(cond.asserter.reference, fuOf("Practitioner"));
  const comp = r.bundle.entry[0].resource;
  assert.equal(comp.section[0].entry[0].reference, fuOf("Condition"));
  assert.equal(comp.author[0].reference, fuOf("Practitioner"));
  assert.deepEqual(r.unresolved, []);
  assert.equal(r.bundle.id, "doc-1");
  assert.ok(r.notes.some((n) => n.startsWith("Bundle.identifier is required by")));
  assert.ok(r.changes.some((c) => c.rule === "bundle-type") && r.changes.some((c) => c.rule === "document-order"));
  const again = await finalizeBundle(r.bundle, twcoreDeps);
  assert.deepEqual(again.changes, []);
  assert.deepEqual(again.bundle, r.bundle);
  const same = await finalizeBundle(twcoreDocument(), twcoreDeps);
  assert.deepEqual(same.bundle, r.bundle, "deterministic");
});

// ---- 2. TWPAS 1.2.7: the package's example Bundles with the five T4 corruptions ------------

const pasDeps = fileDeps([PAS_PKG, TWCORE_PKG, CORE_PKG]);
const pasExamples = pasDeps ? exampleBundles() : [];

test("TWPAS 1.2.7 examples are already valid: returned unchanged", { skip: !pasExamples.length && "TWPAS examples not available" }, async () => {
  for (const [name, b] of pasExamples) {
    const r = await finalizeBundle(b, pasDeps);
    assert.deepEqual(r.changes, [], name);
    assert.deepEqual(r.bundle, b, name);
  }
});

for (const kind of ["readable", "upper", "type_id", "no_fullurl", "bundle_id"] as const) {
  test(`TWPAS 1.2.7 examples, corruption '${kind}': finalized to valid fullUrls with every reference rewired and content preserved`, { skip: !pasExamples.length && "TWPAS examples not available" }, async () => {
    let n = 0;
    for (const [name, b] of pasExamples) {
      // upper / type_id / no_fullurl need urn:uuid fullUrls (RESTful fullUrls are left as they are by design).
      if (kind !== "readable" && kind !== "bundle_id" && !b.entry.every((e: any) => UUID.test(String(e.fullUrl)))) continue;
      const c = corrupt(b, kind);
      const r = await finalizeBundle(c, pasDeps);
      assertFinalized(`${name}#${kind}`, b, c, r);
      if (kind === "bundle_id") assert.equal(r.bundle.id, "01234567-89ab-cdef-0123-456789abcdef");
      if (kind === "upper") assert.deepEqual(r.bundle.entry.map((e: any) => e.fullUrl), b.entry.map((e: any) => e.fullUrl), "uppercase UUIDs are only lowercased");
      const again = await finalizeBundle(r.bundle, pasDeps);
      assert.deepEqual(again.changes, [], `${name}#${kind} idempotent`);
      n++;
    }
    assert.ok(n > 0, "at least one example exercised");
  });
}

// ---- 3. No IG: FHIR R4 core definitions only ------------------------------------------------

const coreDeps = fileDeps([CORE_PKG]);

test("core only (no IG): the same rules from hl7.fhir.r4.core alone; unknown profiles fall back to the base type", { skip: !coreDeps && "package cache not available" }, async () => {
  const b = twcoreDocument();
  for (const e of b.entry) delete e.resource.meta;
  delete b.meta;
  const r = await finalizeBundle(b, coreDeps);
  assert.equal(r.bundle.type, "collection", "no profile: Bundle.type untouched");
  for (const e of r.bundle.entry) assert.match(e.fullUrl, UUID);
  const fuOf = (rt: string, id?: string): string => r.bundle.entry.find((e: any) => e.resource.resourceType === rt && (id === undefined || e.resource.id === id))!.fullUrl;
  const enc1 = r.bundle.entry.find((e: any) => e.resource.id === "encounter-1")!.resource;
  assert.equal(enc1.extension[0].valueReference.reference, fuOf("Encounter", "encounter-2"));
  const comp = r.bundle.entry.find((e: any) => e.resource.resourceType === "Composition")!.resource;
  assert.equal(comp.section[0].entry[0].reference, fuOf("Condition"));
  assert.deepEqual(r.unresolved, []);
  assert.ok(!r.notes.some((n) => /property name/.test(n)), "definitions were available");
  // With the TW Core meta.profile but only core definitions held, the profile is unresolvable → core type is used.
  const b2 = twcoreDocument();
  const r2 = await finalizeBundle(b2, coreDeps);
  assert.equal(r2.bundle.type, "collection", "unresolvable Bundle profile: type untouched");
  assert.deepEqual(r2.unresolved, []);
});
