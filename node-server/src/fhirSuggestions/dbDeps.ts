/**
 * DB-backed collaborators of the suggestion layer for one validation (one package closure).
 * Read-only: package-closure lookups through fhirTerminology, the validator's own resolver,
 * and callbacks into FHIRIGService for normalize / near codes.
 */

import { query } from "../db.js";
import type { PackageRow } from "../fhirIg.js";
import * as terminology from "../fhirTerminology.js";
import { InstanceValidator, type ValidatorResolver } from "../fhirValidator.js";
import type { NormalizeCandidate, SuggestionDeps } from "./types.js";

export interface ServiceHooks {
  /** fhir_normalize_code (the tool's JSON envelope) for this package. */
  normalize?(text: string, valueSet: string | null, system: string | null, limit: number): Promise<string>;
  nearCodes?(system: string, code: string, limit: number): Promise<Array<{ code: string; display: string | null }>>;
}

/** canonical lists per (closure, prefix, types): small, shared across calls, bounded. */
const canonicalCache = new Map<string, { at: number; urls: Promise<string[]> }>();
const CANONICAL_TTL_MS = 10 * 60 * 1000;
const CANONICAL_CACHE_MAX = 200;
const CANONICAL_ROWS_MAX = 5000;

function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (c) => "\\" + c);
}

export function dbSuggestionDeps(pkg: PackageRow, resolver: ValidatorResolver, hooks: ServiceHooks = {}): SuggestionDeps {
  return {
    fetchStructureDefinition: (url) => resolver.fetchStructureDefinition(url),
    checkCode: (system, code, display) => resolver.checkCode(system, code, display),
    loadValueSet: (url) => terminology.loadValueSet(url, pkg),
    valueSetContains: (url, system, code) => resolver.valueSetContains(url, system, code),
    expandValueSet: async (url, limit) => {
      const vs = await terminology.loadValueSet(url, pkg);
      if (!vs) return null;
      const exp = await terminology.expandCompose(vs.compose || {}, pkg, limit);
      return { codings: exp.codings, total: exp.total, truncated: exp.truncated };
    },
    normalize: hooks.normalize
      ? async (text, target, limit) => {
          // The package is pinned by the hook; a "|version" suffix (binding messages) would re-route resolution.
          const unversioned = (u: string | undefined): string | null => (u ? u.split("|")[0] : null);
          const raw = await hooks.normalize!(text, unversioned(target.valueSet), unversioned(target.system), limit);
          const env = JSON.parse(raw);
          const cands: any[] = env && env.ok && env.data && Array.isArray(env.data.candidates) ? env.data.candidates : [];
          return cands
            .filter((c) => c && typeof c.code === "string" && c.code)
            .map((c): NormalizeCandidate => ({ system: c.system ?? null, code: c.code, display: typeof c.display === "string" ? c.display : null, ...(c.exact ? { exact: true } : {}) }));
        }
      : undefined,
    nearCodes: hooks.nearCodes,
    canonicalsUnder: (prefix, resourceTypes) => {
      const key = `${terminology.closureKey(pkg)}|${prefix}|${resourceTypes.join(",")}`;
      const hit = canonicalCache.get(key);
      if (hit && Date.now() - hit.at < CANONICAL_TTL_MS) return hit.urls;
      const [pids, pvers] = terminology.closureArrays(pkg);
      const urls = query<{ canonical_url: string }>(
        "SELECT DISTINCT a.canonical_url FROM fhir.artifacts a " +
          "JOIN unnest($1::text[], $2::text[]) AS dep(pid, pver) ON a.package_id = dep.pid AND a.package_version = dep.pver " +
          "WHERE a.resource_type = ANY($3::text[]) AND a.canonical_url LIKE $4 ESCAPE '\\' ORDER BY 1 LIMIT " + CANONICAL_ROWS_MAX,
        [pids, pvers, resourceTypes, likeEscape(prefix) + "%"],
      ).then((r) => r.rows.map((x) => x.canonical_url));
      if (canonicalCache.size >= CANONICAL_CACHE_MAX) {
        const first = canonicalCache.keys().next().value;
        if (first !== undefined) canonicalCache.delete(first);
      }
      canonicalCache.set(key, { at: Date.now(), urls });
      urls.catch(() => canonicalCache.delete(key));
      return urls;
    },
    validateAgainst: async (resource, profile) => (await new InstanceValidator(resolver).validate(resource, { profiles: [profile] })) as Array<Record<string, any>>,
  };
}
