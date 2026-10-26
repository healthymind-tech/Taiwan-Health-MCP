/**
 * ISSUES_v16 R5 end to end, offline: each IG example Bundle whose profile slices Bundle.entry is
 * decomposed into author inputs (one key per entry, the resource authored for its profile with
 * meta.profile left out, keys in reverse order — a message keeps its MessageHeader first), stored in a context and re-assembled with
 * bundle_profile through AuthoringService — real finalizer, real validator over the local FHIR
 * package cache (FHIR_PACKAGE_CACHE / ~/.fhir/packages; skipped when absent). The re-assembled
 * Bundle must place every entry in its slice, restore meta.profile, and validate with no more
 * errors than the published example; dropping a required entry is reported as `missing`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { finalizeBundle } from "../fhirBundleFinalize.js";
import { InstanceValidator } from "../fhirValidator.js";
import { available, exampleBundles, packages } from "../../scripts/v16-structure-eval/packages.js";
import { MemoryContextStore } from "./contextStore.js";
import { AuthoringService, type AuthoringDeps } from "./service.js";

const IGS = ["pas", "twcore"].filter(available);
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

function serviceFor(ig: string, b0: Record<string, any>): { svc: AuthoringService; keys: string[]; urls: Map<string, string> } {
  const pk = packages(ig);
  const r = pk.resolver();
  const urls = new Map<string, string>();
  const byKey = new Map<string, Record<string, any>>();
  b0.entry.forEach((e: any, i: number) => {
    const key = `e${String(i).padStart(2, "0")}`;
    urls.set(key, e.fullUrl);
    byKey.set(key, e.resource);
  });
  const deps: AuthoringDeps = {
    store: new MemoryContextStore(),
    // The "composer" returns the example resource for the key, without meta.profile (authored for input.profile).
    compose: async (input) => {
      const res = clone(byKey.get(input.key)!);
      if (res.meta) {
        delete res.meta.profile;
        if (!Object.keys(res.meta).length) delete res.meta;
      }
      return { resource: res, provenance: {}, missing: [], refs: { resolved: [], pending: [] }, fieldMap: {}, errors: [] };
    },
    keyToUrn: (_cid, key) => urls.get(key) ?? `urn:uuid:${key}`,
    validate: async (_res, profile) => ({ ok: true, data: { valid: true, issues: [], profile, checked_fully: true } }),
    finalizeBundle: async (bundle, o) => {
      const fin = await finalizeBundle(bundle as Record<string, any>, { fetchStructureDefinition: (u) => r.fetchStructureDefinition(u) }, { bundleType: o.bundleType, bundleProfile: o.bundleProfile });
      return { ok: true, data: { bundle: fin.bundle, changes: fin.changes, unresolved: fin.unresolved, notes: fin.notes, id_map: fin.id_map }, warnings: [] } as never;
    },
    validateBundle: async (bundle) => {
      const issues = (await new InstanceValidator(r).validate(clone(bundle) as Record<string, any>, {})) as Array<Record<string, unknown>>;
      return { ok: true, data: { valid: !issues.some((i) => i.severity === "error" || i.severity === "fatal"), issues, checked_fully: true } };
    },
    bundleSlicing: async ({ bundleProfile }) => {
      const sd = await r.fetchStructureDefinition(bundleProfile);
      return sd ? { sd, fetchStructureDefinition: (u: string) => r.fetchStructureDefinition(u) } : null;
    },
  };
  return { svc: new AuthoringService(deps), keys: [...byKey.keys()], urls };
}

/** Bundle.identifier / timestamp of the example (record values the assembler takes as arguments). */
function envelope(b: Record<string, any>): { identifier?: { system?: string | null; value: string }; timestamp?: string } {
  return { ...(b.identifier?.value ? { identifier: { system: b.identifier.system ?? null, value: b.identifier.value } } : {}), ...(b.timestamp ? { timestamp: b.timestamp } : {}) };
}

async function errorCount(ig: string, b: Record<string, any>): Promise<number> {
  const issues = (await new InstanceValidator(packages(ig).resolver()).validate(clone(b), {})) as Array<Record<string, any>>;
  return issues.filter((i) => i.severity === "error" || i.severity === "fatal").length;
}

for (const ig of ["pas", "twcore"]) {
  test(`R5 ${ig}: example Bundles decomposed into author inputs re-assemble into their entry slices`, { skip: !IGS.includes(ig), timeout: 600_000 }, async () => {
    const pk = packages(ig);
    let checked = 0;
    for (const [name, b0] of exampleBundles(ig, 3)) {
      const bp = b0.meta?.profile?.[0];
      const bsd = bp ? await pk.resolver().fetchStructureDefinition(bp) : null;
      if (!bsd || !bsd.snapshot.element.some((e: any) => e.id === "Bundle.entry" && e.slicing)) continue;
      const { svc, keys } = serviceFor(ig, b0);
      const inputs = keys.map((key, i) => ({ key, profile: String(b0.entry[i].resource.meta?.profile?.[0] ?? b0.entry[i].resource.resourceType), fields: {} }));
      let cid: string | undefined;
      for (let i = 0; i < inputs.length; i += 10) cid = (await svc.authorResources(cid, inputs.slice(i, i + 10))).context_id;
      const asm = await svc.assembleBundle(cid!, b0.type === "message" ? [keys[0], ...keys.slice(1).reverse()] : [...keys].reverse(), String(b0.type), { bundleProfile: bp, allowInvalid: true, ...envelope(b0) });
      const rep = asm.bundle_slices!;
      assert.ok(rep, `${name}: bundle_slices reported`);
      assert.deepEqual(rep.unmatched, [], `${name}: every entry placed`);
      assert.deepEqual(rep.missing, [], `${name}: no required slice missing`);
      // every entry a slice takes is placed in the slice of the profile it was authored for, and gets meta.profile
      const placed = rep.entries.filter((e) => e.slice);
      if (rep.rules === "closed") assert.equal(placed.length, keys.length, `${name}: closed slicing — every entry placed`);
      for (const row of placed) assert.ok(row.by === "authored-profile" || row.by === "only-slice-of-type", `${name} ${row.key}: ${JSON.stringify(row)}`);
      assert.equal(rep.meta_profile_set.length, placed.filter((e) => e.by === "authored-profile").length, `${name}: meta.profile completed for every entry authored for its slice`);
      const before = await errorCount(ig, b0);
      const after = await errorCount(ig, asm.bundle);
      assert.ok(after <= before, `${name}: re-assembled errors ${after} ≤ published ${before}`);
      // drop a required single-entry slice's key (not the document / message head, which is refused) → reported as missing, nothing invented
      const required = rep.entries.find((e) => e.slice && e.resourceType !== "Composition" && e.resourceType !== "MessageHeader" && bsd.snapshot.element.some((x: any) => x.id === `Bundle.entry:${e.slice}` && x.min >= 1 && x.max === "1"));
      if (required) {
        const rest = keys.filter((k) => k !== required.key);
        const a2 = await svc.assembleBundle(cid!, rest, String(b0.type), { bundleProfile: bp, allowInvalid: true, ...envelope(b0) });
        const miss = a2.bundle_slices!.missing.find((m) => m.slice === required.slice);
        assert.ok(miss && miss.found === 0 && /never invented/.test(miss.guidance), `${name}: missing ${required.slice}: ${JSON.stringify(a2.bundle_slices!.missing)}`);
        assert.equal((a2.bundle.entry as unknown[]).length, rest.length, "no entry invented");
      }
      checked++;
    }
    assert.ok(checked > 0, "at least one sliced example Bundle");
  });
}
