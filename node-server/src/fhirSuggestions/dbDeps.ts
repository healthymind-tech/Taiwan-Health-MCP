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
  /** Embeddings of short texts (the embedding role's route); null entries when unavailable. */
  embedBatch?(texts: string[]): Promise<Array<number[] | null>>;
  /** v15.2: relatedness of candidate codes to an original code / label (IG CodeSystems; null = no gate). */
  relatedCodes?: SuggestionDeps["relatedCodes"];
  /** v15.2: a code's concept in any installed copy of its IG CodeSystem and its accepted linked codings. */
  codeAlternatives?: SuggestionDeps["codeAlternatives"];
  /** v15.2.1: the IG profiles of a resource type, for a resource that declares none (alternative-coding bindings only). */
  implicitProfiles?: SuggestionDeps["implicitProfiles"];
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** canonical lists per (closure, prefix, types): small, shared across calls, bounded. */
const canonicalCache = new Map<string, { at: number; urls: Promise<string[]> }>();
const CANONICAL_TTL_MS = 10 * 60 * 1000;
const CANONICAL_CACHE_MAX = 200;
const CANONICAL_ROWS_MAX = 5000;

function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (c) => "\\" + c);
}

/** Element paths of the closure's base resource definitions, per closure (one query, ~150 rows). */
const elementPathCache = new Map<string, { at: number; rows: Promise<Array<{ type: string; paths: string[] }>> }>();
const ELEMENT_PATH_CACHE_MAX = 20;

function resourceElementPaths(pkg: PackageRow): Promise<Array<{ type: string; paths: string[] }>> {
  const key = terminology.closureKey(pkg);
  const hit = elementPathCache.get(key);
  if (hit && Date.now() - hit.at < CANONICAL_TTL_MS) return hit.rows;
  const [pids, pvers] = terminology.closureArrays(pkg);
  const rows = query<{ type: string; paths: string[] | null }>(
    "SELECT DISTINCT ON (a.raw_json ->> 'type') a.raw_json ->> 'type' AS type, " +
      "ARRAY(SELECT e ->> 'path' FROM jsonb_array_elements(a.raw_json -> 'snapshot' -> 'element') AS e) AS paths " +
      "FROM fhir.artifacts a " +
      "JOIN unnest($1::text[], $2::text[]) WITH ORDINALITY AS dep(pid, pver, ord) ON a.package_id = dep.pid AND a.package_version = dep.pver " +
      "WHERE a.resource_type = 'StructureDefinition' AND a.kind = 'resource' AND a.derivation = 'specialization' " +
      "AND a.canonical_url LIKE 'http://hl7.org/fhir/StructureDefinition/%' " +
      "ORDER BY a.raw_json ->> 'type', dep.ord",
    [pids, pvers],
  ).then((r) => r.rows.filter((x) => typeof x.type === "string" && x.type !== "").map((x) => ({ type: x.type, paths: Array.isArray(x.paths) ? x.paths : [] })));
  if (elementPathCache.size >= ELEMENT_PATH_CACHE_MAX) {
    const first = elementPathCache.keys().next().value;
    if (first !== undefined) elementPathCache.delete(first);
  }
  elementPathCache.set(key, { at: Date.now(), rows });
  rows.catch(() => elementPathCache.delete(key));
  return rows;
}

/**
 * Per-validation dedupe of collaborator calls: the same question (same collaborator, same
 * arguments) is asked once and its answer shared — e.g. a profile and its base reporting the
 * same binding, or a versioned and an unversioned binding of one ValueSet, both normalising
 * the same label. Answers are read-only for every suggester, a rejected call is forgotten
 * (asked again next time), and budgets are consumed exactly as before.
 */
export function dedupedDeps(deps: SuggestionDeps): SuggestionDeps {
  const memo = new Map<string, Promise<unknown>>();
  function once<A extends unknown[], R>(name: string, fn: ((...a: A) => Promise<R>) | undefined): ((...a: A) => Promise<R>) | undefined {
    if (!fn) return undefined;
    return (...a: A): Promise<R> => {
      const key = `${name}\0${JSON.stringify(a)}`;
      let p = memo.get(key) as Promise<R> | undefined;
      if (!p) {
        p = fn(...a);
        memo.set(key, p);
        p.catch(() => {
          if (memo.get(key) === p) memo.delete(key);
        });
      }
      return p;
    };
  }
  return {
    fetchStructureDefinition: once("sd", (u: string) => deps.fetchStructureDefinition(u))!,
    checkCode: once("code", (s: string, c: string, d: string | null) => deps.checkCode(s, c, d))!,
    loadValueSet: once("vs", deps.loadValueSet?.bind(deps)),
    valueSetContains: once("member", deps.valueSetContains?.bind(deps)),
    expandValueSet: once("expand", deps.expandValueSet?.bind(deps)),
    normalize: once("normalize", deps.normalize?.bind(deps)),
    nearCodes: once("near", deps.nearCodes?.bind(deps)),
    canonicalsUnder: once("canonicals", deps.canonicalsUnder?.bind(deps)),
    validateAgainst: once("validate", deps.validateAgainst?.bind(deps)),
    resourceElementPaths: once("paths", deps.resourceElementPaths?.bind(deps)),
    similarity: once("similarity", deps.similarity?.bind(deps)),
    relatedCodes: once("related", deps.relatedCodes?.bind(deps)),
    codeAlternatives: once("alternatives", deps.codeAlternatives?.bind(deps)),
    implicitProfiles: once("implicit", deps.implicitProfiles?.bind(deps)),
  };
}

export function dbSuggestionDeps(pkg: PackageRow, resolver: ValidatorResolver, hooks: ServiceHooks = {}): SuggestionDeps {
  return dedupedDeps({
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
            .map(
              (c): NormalizeCandidate => ({
                system: c.system ?? null,
                code: c.code,
                display: typeof c.display === "string" ? c.display : null,
                ...(c.exact ? { exact: true } : {}),
                ...(typeof c.score === "number" && Number.isFinite(c.score) ? { score: c.score } : {}),
                ...(typeof c.accepted_by_validator === "boolean" ? { accepted: c.accepted_by_validator } : {}),
              }),
            );
        }
      : undefined,
    nearCodes: hooks.nearCodes,
    relatedCodes: hooks.relatedCodes,
    codeAlternatives: hooks.codeAlternatives,
    implicitProfiles: hooks.implicitProfiles,
    similarity: hooks.embedBatch
      ? async (text, candidates) => {
          if (!candidates.length) return [];
          const vecs = await hooks.embedBatch!([text, ...candidates]);
          const q = vecs[0];
          if (!q) return null;
          return candidates.map((_, i) => {
            const v = vecs[i + 1];
            return v ? cosine(q, v) : NaN;
          });
        }
      : undefined,
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
    resourceElementPaths: () => resourceElementPaths(pkg),
  });
}
