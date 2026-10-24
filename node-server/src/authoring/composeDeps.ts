/**
 * Production collaborators of the composer (workstream B's `ComposeDeps`, deps.ts), built from
 * the same read-only data layer the validator uses: the resolved package closure
 * (fhirIg.resolveTarget), DbValidatorResolver for StructureDefinitions / ValueSet membership,
 * fhirTerminology for displays and expansions, FHIRIGService.normalizeCode for text → code, and
 * workstream A's authoringFields for the model-facing field list.
 *
 * `makeComposer(svc, composeResource)` adapts B's `composeResource(input, deps, ctx)` to the
 * service's `Composer` — index.ts passes B's function in, so this file never imports compose.ts.
 */

import { query } from "../db.js";
import * as fhirIg from "../fhirIg.js";
import type { FHIRIGService } from "../fhirIgService.js";
import { splitCanonical } from "../fhirIg.js";
import * as terminology from "../fhirTerminology.js";
import { DbValidatorResolver } from "../fhirValidationResolver.js";
import type { NormalizeCandidate } from "../fhirSuggestions/types.js";
import type { ComposeDeps, ResolvedProfile } from "./deps.js";
import { authoringFields, type FieldsDeps } from "./fields.js";
import { dbFieldsDeps } from "./fieldsTool.js";
import type { ComposeContext, ComposeOutput, Composer } from "./service.js";
import type { AuthorInput, FieldSpec } from "./types.js";

export interface PackageSelector {
  packageId?: string | null;
  version?: string | null;
  /** Profile argument (id or canonical, `|version` honoured) — a resolution hint. */
  profile?: string | null;
}

function jsonValue(raw: unknown): Record<string, any> | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as Record<string, any>;
    } catch {
      return null;
    }
  }
  return typeof raw === "object" ? (raw as Record<string, any>) : null;
}

/** The package closure a request names, as FHIRIGService.resolve() builds it (public API only). */
export async function resolvePackageFor(sel: PackageSelector): Promise<fhirIg.PackageRow> {
  const t = await fhirIg.resolveTarget({
    packageId: sel.packageId || null,
    version: sel.packageId ? sel.version ?? null : null,
    canonicals: [sel.profile ?? null],
  });
  return { ...t.pkg, _closure: t.closure, _resolvedBy: t.resolvedBy, _closureVersions: t.closureVersions, _depsMissing: t.depsMissing, _notes: t.notes };
}

/** Artifact row by id / canonical / key within the closure (first package in closure order; exact id preferred). */
async function loadArtifact(pkg: fhirIg.PackageRow, identifier: string): Promise<Record<string, any> | null> {
  if (identifier.includes("|")) return (await fhirIg.resolveCanonicalVersioned(identifier, pkg)) as Record<string, any> | null;
  const [pids, pvers] = terminology.closureArrays(pkg);
  const r = await query<Record<string, any>>(
    "SELECT a.artifact_id, a.canonical_url, a.raw_json FROM fhir.artifacts a " +
      "JOIN unnest($1::text[], $2::text[]) WITH ORDINALITY AS dep(pid, pver, ord) ON a.package_id = dep.pid AND a.package_version = dep.pver " +
      "WHERE a.resource_type = 'StructureDefinition' AND (a.artifact_id = $3 OR a.canonical_url = $3 OR a.artifact_key = $3) " +
      "ORDER BY (a.artifact_id = $3) DESC, dep.ord LIMIT 1",
    [pids, pvers, identifier],
  );
  return r.rows[0] ?? null;
}

/**
 * ComposeDeps bound to one package closure. Cheap to build (one resolution); the
 * StructureDefinition / ValueSet lookups behind it are memoised by the shared resolver.
 */
export function composeDepsFor(svc: FHIRIGService, pkg: fhirIg.PackageRow, fieldsDeps: FieldsDeps = dbFieldsDeps()): ComposeDeps {
  const resolver = new DbValidatorResolver(pkg);
  return {
    async resolveProfile(identifier: string): Promise<ResolvedProfile | null> {
      const id = identifier.trim();
      if (!id) return null;
      const row = await loadArtifact(pkg, id);
      const sd = row ? jsonValue(row.raw_json) : null;
      if (!row || !sd) return null;
      const { version } = splitCanonical(id);
      const canonical: string = sd.url || row.canonical_url;
      return { sd, canonical: version ? `${canonical}|${version}` : canonical, id: row.artifact_id ?? null };
    },
    fetchStructureDefinition: (url) => resolver.fetchStructureDefinition(url),
    lookupDisplay: async (system, code) => {
      const found = await terminology.lookup(system, code, pkg);
      return found && typeof found.display === "string" ? found.display : null;
    },
    normalize: async (text, target, limit) => {
      const unversioned = (u: string | undefined): string | null => (u ? u.split("|")[0] : null);
      const raw = await svc.normalizeCode(text, unversioned(target.valueSet), unversioned(target.system), pkg.package_id, pkg.version, limit);
      const env = JSON.parse(raw);
      const cands: any[] = env && env.ok && env.data && Array.isArray(env.data.candidates) ? env.data.candidates : [];
      return cands
        .filter((c) => c && typeof c.code === "string" && c.code)
        .map(
          (c): NormalizeCandidate => ({
            system: c.system ?? null,
            code: c.code,
            display: typeof c.display === "string" ? c.display : null,
            ...(c.exact ? { exact: true } : {}),
            ...(typeof c.score === "number" && Number.isFinite(c.score) ? { score: c.score } : {}),
          }),
        );
    },
    expandValueSet: async (url, limit) => {
      const vs = await terminology.loadValueSet(url.split("|")[0], pkg);
      if (!vs) return null;
      const exp = await terminology.expandCompose(vs.compose || {}, pkg, limit);
      return { codings: exp.codings, total: exp.total, truncated: exp.truncated };
    },
    valueSetContains: (url, system, code) => resolver.valueSetContains(url, system, code),
    authoringFields: async (sd: Record<string, any>): Promise<FieldSpec[]> => {
      const profile = typeof sd.url === "string" && sd.url ? sd.url : typeof sd.id === "string" ? sd.id : null;
      if (!profile) return [];
      const res = await authoringFields({ profile, package_id: pkg.package_id, version: pkg.version, include_more: false, detail: "full" }, fieldsDeps);
      return res.fields;
    },
  };
}

/** B's composeResource signature (deps.ts); typed here so this module does not import compose.ts. */
export type ComposeResourceFn = (input: AuthorInput, deps: ComposeDeps, ctx: ComposeContext) => Promise<ComposeOutput>;

/** The service's Composer over B's composeResource: resolve the input's package, build its deps, compose. */
export function makeComposer(svc: FHIRIGService, composeResource: ComposeResourceFn, fieldsDeps: FieldsDeps = dbFieldsDeps()): Composer {
  return async (input, ctx) => {
    const pkg = await resolvePackageFor({ packageId: input.package_id ?? null, version: input.version ?? null, profile: input.profile });
    return composeResource(input, composeDepsFor(svc, pkg, fieldsDeps), ctx);
  };
}
