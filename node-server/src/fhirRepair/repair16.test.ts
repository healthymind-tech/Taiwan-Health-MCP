/**
 * ISSUES_v16 R4 — generic structure repairs of fhir_finalize_bundle (repair="content"):
 * exposedByShape (errors a lossless reshape makes visible are not regressions) synthetic, and the
 * IG example Bundles of TWPAS 1.2.7 / TW Core 1.0.0 with typical corruptions applied generically
 * (local FHIR package cache; skipped when absent): the repaired Bundle has no more errors than the
 * published example.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { expandComposeWith } from "../fhirCodeSystem.js";
import { InstanceValidator } from "../fhirValidator.js";
import { available, exampleBundles, packages } from "../../scripts/v16-structure-eval/packages.js";
import { exposedByShape, repairBundle, type RepairChange, type RepairDeps } from "./index.js";

test("exposedByShape: errors inside a reshaped value / a re-declared profile's resource are hidden ones", () => {
  const shape = (path: string, from: unknown = null): RepairChange => ({ path, from, to: null, rule: "shape", reason: "" });
  const changes = [shape("Bundle.entry[2].resource.identifier[0].system"), shape("Bundle.entry[4].resource.meta.profile")];
  const bundle = { resourceType: "Bundle", entry: [{}, {}, {}, {}, { fullUrl: "urn:uuid:4" }] };
  // under the reshaped element, and its parent's cardinality naming it
  assert.equal(exposedByShape({ path: "Bundle.entry[2].resource.identifier[0].system", message: "Example URLs are not allowed" }, changes, bundle), true);
  assert.equal(exposedByShape({ path: "Bundle.entry[2].resource.identifier[0]", message: "Encounter.identifier.system: minimum required = 1, but only found 0" }, changes, bundle), true);
  // meta.profile repaired: the resource is now checked against its profile; references to it too
  assert.equal(exposedByShape({ path: "Bundle.entry[4].resource.status", message: "x: minimum required = 1" }, changes, bundle), true);
  assert.equal(exposedByShape({ path: "Bundle.entry[0].resource.subject", message: "Unable to find a profile match for urn:uuid:4 among choices: P" }, changes, bundle), true);
  // elsewhere: a real regression
  assert.equal(exposedByShape({ path: "Bundle.entry[2].resource.status", message: "Unknown code 'x'" }, changes, bundle), false);
  assert.equal(exposedByShape({ path: "Bundle.entry[3].resource", message: "Unrecognized property 'y'" }, changes, bundle), false);
  // non-shape rules never excuse
  assert.equal(exposedByShape({ path: "Bundle.entry[1].resource.code", message: "e" }, [{ path: "Bundle.entry[1].resource.code", from: 1, to: 2, rule: "system", reason: "" }], bundle), false);
});

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

const CORRUPT: Record<string, (res: any, entry: any, maxOf: (t: string, k: string) => string | null) => boolean> = {
  "meta.profile string": (res) => (Array.isArray(res.meta?.profile) ? ((res.meta.profile = res.meta.profile[0]), true) : false),
  "repeating element as a single value": (res, _e, maxOf) => {
    for (const k of Object.keys(res)) if (Array.isArray(res[k]) && res[k].length === 1 && k !== "contained" && maxOf(res.resourceType, k) === "*") return (res[k] = res[k][0]), true;
    return false;
  },
  "single element as an array": (res, _e, maxOf) => {
    for (const k of Object.keys(res)) if (!["resourceType", "id", "meta"].includes(k) && !Array.isArray(res[k]) && maxOf(res.resourceType, k) === "1") return (res[k] = [res[k]]), true;
    return false;
  },
  "no resourceType, meta.profile string": (res) => (Array.isArray(res.meta?.profile) ? (delete res.resourceType, (res.meta.profile = res.meta.profile[0]), true) : false),
  "empty elements": (res) => {
    if (!res.extension) res.extension = [];
    res.modifierExtension = [];
    res.implicitRules = "";
    return true;
  },
  "meta one level up": (res, entry) => (res.meta ? ((entry.meta = res.meta), delete res.meta, true) : false),
};

for (const ig of ["pas", "twcore"]) {
  test(`R4 ${ig}: corrupted example Bundles are repaired back to the published error count`, { skip: !available(ig), timeout: 600_000 }, async () => {
    const pk = packages(ig);
    const r = pk.resolver();
    const errors = async (b: unknown): Promise<number> => ((await new InstanceValidator(r).validate(clone(b) as any, {})) as any[]).filter((i) => i.severity === "error" || i.severity === "fatal").length;
    const deps: RepairDeps = {
      fetchStructureDefinition: (u) => r.fetchStructureDefinition(u),
      valueSetContains: (u, s, c) => r.valueSetContains(u, s, c),
      expandValueSet: async (u, limit) => {
        const vs = pk.get(u, "ValueSet");
        if (!vs) return null;
        const e = await expandComposeWith(vs.compose || {}, pk.termDeps(), limit);
        return { codings: e.codings, total: e.total, truncated: e.truncated };
      },
      validate: async (res, profiles) => (await new InstanceValidator(r).validate(clone(res), { profiles })) as any[],
    };
    const maxOf = (type: string, key: string): string | null => {
      const e = pk.get(`http://hl7.org/fhir/StructureDefinition/${type}`, "StructureDefinition")?.snapshot?.element?.find((x: any) => x.path === `${type}.${key}`);
      return e ? String(e.base?.max ?? e.max) : null;
    };
    const [name, b0] = exampleBundles(ig, 5)[0];
    const base = await errors(b0);
    for (const [what, fn] of Object.entries(CORRUPT)) {
      const b = clone(b0);
      let n = 0;
      for (const e of b.entry) if (e.resource && fn(e.resource, e, maxOf)) n++;
      if (!n) continue;
      const broken = await errors(b);
      assert.ok(broken > base, `${name} ${what}: the corruption is detected`);
      await repairBundle(b, deps, {});
      const fixed = await errors(b);
      assert.ok(fixed <= base, `${name} ${what}: ${broken} → ${fixed} errors (published ${base})`);
    }
  });
}
