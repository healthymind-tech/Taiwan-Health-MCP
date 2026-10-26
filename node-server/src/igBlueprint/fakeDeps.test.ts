/**
 * In-memory BlueprintDeps for the synthetic igBlueprint tests: StructureDefinitions by url / id,
 * example resources (filtered by meta.profile) and ValueSet expansions.
 *
 * (Named *.test.ts so the build excludes it; it declares no tests itself.)
 */

import type { BlueprintDeps, ExampleInstance, LoadedProfile } from "./common.js";

type R = Record<string, any>;

export function fakeDeps(sds: R[], opts: { examples?: R[]; valueSets?: Record<string, Array<{ system: string; code: string; display?: string }>>; truncated?: string[] } = {}): BlueprintDeps {
  const byKey = new Map<string, R>();
  for (const s of sds) {
    byKey.set(s.url, s);
    if (s.id) byKey.set(s.id, s);
  }
  return {
    async loadProfile(profile) {
      const s = byKey.get(profile.split("|")[0]);
      if (!s) throw new Error(`no profile ${profile}`);
      return { sd: s, profileId: String(s.id ?? s.url), canonical: s.url, packageId: "example.ig", packageVersion: "1.0.0", provenance: { packageId: "example.ig", version: "1.0.0" } } satisfies LoadedProfile;
    },
    async fetchStructureDefinition(_p, url) {
      return byKey.get(url.split("|")[0]) ?? null;
    },
    async exampleInstances(_p, canonical) {
      return (opts.examples ?? []).map((r, i): ExampleInstance => ({ source: `ex${i}`, resource: r })).filter((x) => (x.resource.meta?.profile ?? []).includes(canonical));
    },
    async expandValueSet(_p, vs, limit) {
      const codes = opts.valueSets?.[vs];
      if (!codes) return null;
      return { codings: codes.slice(0, limit).map((c) => ({ system: c.system, code: c.code, display: c.display ?? null })), truncated: (opts.truncated ?? []).includes(vs) || codes.length > limit };
    },
  };
}

