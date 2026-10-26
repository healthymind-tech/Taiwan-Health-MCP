/**
 * File-backed BlueprintDeps over a local FHIR package cache (FHIR_PACKAGE_CACHE, default
 * ~/.fhir/packages): StructureDefinitions / ValueSets / CodeSystems of a closure of package dirs
 * (first package wins, like a closure order) and the target package's example folder. Used by the
 * IG tests and scripts/ig-blueprint-sizes.ts; no DB.
 *
 * (Named *.test.ts so the build excludes it; it declares no tests itself.)
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { expandComposeWith, indexCodeSystem, type TerminologyDeps } from "../fhirCodeSystem.js";
import { AuthoringFieldsError } from "../authoring/fields.js";
import type { BlueprintDeps, ExampleInstance, LoadedProfile } from "./common.js";

export const CACHE = process.env.FHIR_PACKAGE_CACHE || join(homedir(), ".fhir", "packages");

export function pkgDir(spec: string): string | null {
  const dir = join(CACHE, spec, "package");
  return existsSync(join(dir, "package.json")) ? dir : null;
}

type Res = Record<string, any>;

function readJson(p: string): Res | null {
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Res;
  } catch {
    return null;
  }
}

/** Every top-level *.json resource of a package dir (index-free: works without .index.json). */
function packageResources(dir: string): Array<[string, Res]> {
  const out: Array<[string, Res]> = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json") || f === "package.json" || f.startsWith(".")) continue;
    const r = readJson(join(dir, f));
    if (r && typeof r.resourceType === "string") out.push([f, r]);
  }
  return out;
}

function exampleResources(dir: string): ExampleInstance[] {
  const ex = join(dir, "example");
  if (!existsSync(ex)) return [];
  const out: ExampleInstance[] = [];
  for (const f of readdirSync(ex).sort()) {
    if (!f.endsWith(".json")) continue;
    const r = readJson(join(ex, f));
    if (!r || typeof r.resourceType !== "string") continue;
    const id = String(r.id ?? f.replace(/\.json$/, ""));
    out.push({ source: id, resource: r });
    if (r.resourceType === "Bundle" && Array.isArray(r.entry)) {
      r.entry.forEach((e: Res, i: number) => {
        if (e && typeof e.resource === "object" && e.resource) out.push({ source: `${id}#${i}`, resource: e.resource });
      });
    }
  }
  return out;
}

/**
 * Deps over the closure `specs` (package#version, first = the IG written for). Null when a
 * package of the closure is not in the cache.
 */
export function fileBlueprintDeps(specs: string[]): BlueprintDeps | null {
  const dirs = specs.map(pkgDir);
  if (dirs.some((d) => d === null)) return null;
  const byUrl = new Map<string, { res: Res; pkg: string }>();
  const byId = new Map<string, { res: Res; pkg: string }>();
  for (let i = 0; i < specs.length; i++) {
    for (const [, r] of packageResources(dirs[i]!)) {
      if (typeof r.url === "string" && !byUrl.has(r.url)) byUrl.set(r.url, { res: r, pkg: specs[i] });
      if (r.resourceType === "StructureDefinition" && typeof r.id === "string" && !byId.has(r.id)) byId.set(r.id, { res: r, pkg: specs[i] });
    }
  }
  const examples = new Map<string, ExampleInstance[]>();
  const examplesOf = (spec: string): ExampleInstance[] => {
    if (!examples.has(spec)) examples.set(spec, exampleResources(pkgDir(spec)!));
    return examples.get(spec)!;
  };
  const term: TerminologyDeps = {
    loadValueSet: async (url) => {
      const r = byUrl.get(url.split("|")[0])?.res;
      return r && r.resourceType === "ValueSet" ? r : null;
    },
    loadCodeSystem: async (url) => {
      const r = byUrl.get(url.split("|")[0])?.res;
      return r && r.resourceType === "CodeSystem" ? indexCodeSystem(r) : null;
    },
    lookupExternal: async () => null,
    externalSystemHeld: async () => false,
  };
  return {
    async loadProfile(profile) {
      const key = profile.split("|")[0];
      const hit = byUrl.get(key) ?? byId.get(key);
      if (!hit || hit.res.resourceType !== "StructureDefinition") throw new AuthoringFieldsError("ARTIFACT_NOT_FOUND", `profile not found: ${profile}`);
      const [pid, ver] = hit.pkg.split("#");
      const [tpid, tver] = specs[0].split("#");
      return {
        sd: hit.res,
        profileId: String(hit.res.id ?? key),
        canonical: String(hit.res.url ?? ""),
        packageId: pid,
        packageVersion: ver,
        handle: specs[0],
        provenance: { packageId: tpid, version: tver, source: "ig" },
      } satisfies LoadedProfile;
    },
    async fetchStructureDefinition(_p, url) {
      const r = byUrl.get(url.split("|")[0])?.res;
      return r && r.resourceType === "StructureDefinition" ? r : null;
    },
    async exampleInstances(p, canonical) {
      const has = (x: ExampleInstance): boolean => ((x.resource.meta as Res | undefined)?.profile || []).some((u: string) => String(u).split("|")[0] === canonical);
      const target = examplesOf(specs[0]).filter(has);
      if (target.length) return target;
      const owner = specs.find((s) => s === `${p.packageId}#${p.packageVersion}`);
      return owner ? examplesOf(owner).filter(has) : [];
    },
    async expandValueSet(_p, valueSet, limit) {
      const vs = await term.loadValueSet(valueSet);
      if (!vs) return null;
      const exp = await expandComposeWith(vs.compose || {}, term, limit);
      // partial (unresolved includes, e.g. UCUM / an external system) counts as truncated
      return { codings: exp.codings, truncated: exp.truncated || exp.unresolved.length > 0 || exp.warnings.length > 0 };
    },
  };
}

/** The closures the IG tests use (null entries when a package is missing). */
export const TWCORE_CLOSURE = ["tw.gov.mohw.twcore#1.0.0", "hl7.terminology.r4#6.2.0", "hl7.fhir.uv.extensions.r4#5.2.0", "hl7.fhir.r4.core#4.0.1"];
export const TWPAS_CLOSURE = [
  "tw.gov.mohw.nhi.pas#1.2.7",
  "tw.gov.mohw.twcore#1.0.0",
  "hl7.fhir.us.davinci-pas#2.2.1",
  "hl7.terminology.r4#7.4.0",
  "hl7.fhir.uv.extensions.r4#5.3.0",
  "hl7.fhir.r4.core#4.0.1",
];

/** The closure, dropping optional packages that are not cached (the first and the core one are mandatory). */
export function availableClosure(specs: string[]): string[] | null {
  if (!pkgDir(specs[0]) || !pkgDir(specs[specs.length - 1])) return null;
  return specs.filter((s) => pkgDir(s) !== null);
}
