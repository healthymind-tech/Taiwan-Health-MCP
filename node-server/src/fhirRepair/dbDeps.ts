/**
 * Production collaborators of the repair layer for one package closure — the same read-only
 * data layer the validator uses (DbValidatorResolver, fhirTerminology, fhirUriRules), plus
 * FHIRIGService.normalizeCode for text → code. Shared by the finalize tools and the authoring
 * composer (authoring/composeDeps.ts builds its ComposeDeps on top of these).
 */

import { query } from "../db.js";
import type * as fhirIg from "../fhirIg.js";
import * as terminology from "../fhirTerminology.js";
import { DbValidatorResolver } from "../fhirValidationResolver.js";
import { InstanceValidator } from "../fhirValidator.js";
import { parseValidDisplays } from "../fhirSuggestions/codes.js";
import type { NormalizeCandidate } from "../fhirSuggestions/types.js";
import { hl7UrlMustResolve, isKnownSpace } from "../fhirUriRules.js";
import type { CodeSystemEntry, RepairDeps, SystemResolution } from "./types.js";

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

/** A ValueSet by canonical: the closure's copy, else any installed package's (newest load order). */
export async function loadValueSetAnywhere(pkg: fhirIg.PackageRow, url: string): Promise<Record<string, any> | null> {
  const u = url.split("|")[0];
  const own = await terminology.loadValueSet(u, pkg);
  if (own) return own;
  const r = await query<{ raw_json: unknown }>(
    "SELECT raw_json FROM fhir.artifacts WHERE resource_type = 'ValueSet' AND canonical_url = $1 ORDER BY package_id, package_version DESC LIMIT 1",
    [u],
  );
  return r.rows.length ? jsonValue(r.rows[0].raw_json) : null;
}

/** `/A/` → `/B/` in the last occurrence (canonical twins: …/CodeSystem/x ↔ …/ValueSet/x). */
export function twinUrl(url: string, from: string, to: string): string | null {
  const i = url.lastIndexOf(from);
  return i > 0 && i + from.length < url.length ? `${url.slice(0, i)}${to}${url.slice(i + from.length)}` : null;
}

/** fhir_normalize_code as the tool answers it (JSON envelope) — the service hook. */
export type NormalizeHook = (text: string, valueSet: string | null, system: string | null, limit: number) => Promise<string>;

/** CodeSystem directory per closure (name / title / id / identifiers), cached 10 min. */
const directoryCache = new Map<string, { at: number; rows: Promise<CodeSystemEntry[]> }>();

function codeSystemDirectory(pkg: fhirIg.PackageRow): Promise<CodeSystemEntry[]> {
  const key = terminology.closureKey(pkg);
  const hit = directoryCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.rows;
  const [pids, pvers] = terminology.closureArrays(pkg);
  const rows = query<{ url: string; name: string | null; title: string | null; id: string | null; ids: unknown }>(
    "SELECT DISTINCT ON (a.canonical_url) a.canonical_url AS url, a.raw_json ->> 'name' AS name, a.raw_json ->> 'title' AS title, a.artifact_id AS id, " +
      "a.raw_json -> 'identifier' AS ids FROM fhir.artifacts a " +
      "JOIN unnest($1::text[], $2::text[]) WITH ORDINALITY AS dep(pid, pver, ord) ON a.package_id = dep.pid AND a.package_version = dep.pver " +
      "WHERE a.resource_type = 'CodeSystem' AND a.canonical_url IS NOT NULL ORDER BY a.canonical_url, dep.ord",
    [pids, pvers],
  ).then((r) =>
    r.rows.map((x) => {
      const names: string[] = [];
      for (const n of [x.name, x.title, x.id]) if (typeof n === "string" && n.trim()) names.push(n);
      const ids = Array.isArray(x.ids) ? x.ids : x.ids && typeof x.ids === "object" ? [x.ids] : [];
      for (const i of ids) if (i && typeof i === "object" && typeof (i as any).value === "string") names.push(String((i as any).value).replace(/^urn:oid:/i, ""));
      return { url: x.url, names };
    }),
  );
  if (directoryCache.size > 20) directoryCache.clear();
  directoryCache.set(key, { at: Date.now(), rows });
  rows.catch(() => directoryCache.delete(key));
  return rows;
}

export function repairDepsFor(pkg: fhirIg.PackageRow, normalize: NormalizeHook | null, resolver: DbValidatorResolver = new DbValidatorResolver(pkg)): RepairDeps {
  return {
    fetchStructureDefinition: (url) => resolver.fetchStructureDefinition(url),
    lookupDisplay: async (system, code) => {
      const found = await terminology.lookup(system, code, pkg);
      return found && typeof found.display === "string" ? found.display : null;
    },
    // The validator's own display rule (DbValidatorResolver.checkCode, the call fhir_validate_resource makes).
    checkDisplay: async (system, code, display, version) => {
      const r = await resolver.checkCode(system, code, display, version);
      if (r.status === "ok") return { status: "ok", valid: [] };
      if (r.status === "invalid-display") {
        return r.severity === "information" ? { status: "ok", valid: [] } : { status: "invalid-display", valid: parseValidDisplays(r.message) };
      }
      return { status: "unknown", valid: [] };
    },
    normalize: normalize
      ? async (text, target, limit) => {
          const unversioned = (u: string | undefined): string | null => (u ? u.split("|")[0] : null);
          const env = JSON.parse(await normalize(text, unversioned(target.valueSet), unversioned(target.system), limit));
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
        }
      : undefined,
    expandValueSet: async (url, limit) => {
      const vs = await loadValueSetAnywhere(pkg, url);
      if (!vs) return null;
      const exp = await terminology.expandCompose(vs.compose || {}, pkg, limit);
      // `unresolved` = parts not enumerable locally (filters on external terminologies, missing imports).
      return { codings: exp.codings, total: exp.total, truncated: exp.truncated, ...(exp.unresolved.length ? { incomplete: true } : {}) };
    },
    valueSetContains: (url, system, code) => resolver.valueSetContains(url, system, code),
    resolveSystem: async (url, code): Promise<SystemResolution> => {
      const u = url.split("|")[0];
      if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) return { kind: "other" };
      if (await terminology.loadArtifactByCanonical("CodeSystem", u, pkg)) return { kind: "codesystem" };
      if (await loadValueSetAnywhere(pkg, u)) return { kind: "valueset", valueSet: u };
      const vsTwin = twinUrl(u, "/CodeSystem/", "/ValueSet/");
      if (vsTwin && (await loadValueSetAnywhere(pkg, vsTwin))) return { kind: "valueset", valueSet: vsTwin };
      // v14.1: an HL7 core ValueSet written without its /ValueSet/ segment (http://hl7.org/fhir/condition-code).
      const core = /^http:\/\/hl7\.org\/fhir\/([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(u);
      if (core && (await loadValueSetAnywhere(pkg, `http://hl7.org/fhir/ValueSet/${core[1]}`))) return { kind: "valueset", valueSet: `http://hl7.org/fhir/ValueSet/${core[1]}` };
      const check = await resolver.checkCode(u, code, null);
      if (check.status !== "unknown-system") return { kind: "codesystem" };
      if (await resolver.definitionExists(u)) return { kind: "other" };
      // HL7 spaces: only what the HL7 validator itself rejects ("No definition could be found for URL value").
      if (isKnownSpace(u) && !hl7UrlMustResolve(u)) return { kind: "other" };
      const csTwin = twinUrl(u, "/ValueSet/", "/CodeSystem/");
      const twinHeld = csTwin ? await terminology.loadArtifactByCanonical("CodeSystem", csTwin, pkg) : null;
      return { kind: "unknown", codeSystemTwin: twinHeld ? csTwin : null };
    },
    valueSetSystems: async (url) => {
      const out = new Set<string>();
      const visit = async (u: string, depth: number): Promise<void> => {
        const vs = await loadValueSetAnywhere(pkg, u);
        const incs = vs && vs.compose && Array.isArray(vs.compose.include) ? vs.compose.include : [];
        for (const inc of incs) {
          if (inc && typeof inc.system === "string" && inc.system) out.add(inc.system.split("|")[0]);
          else if (inc && depth < 1 && Array.isArray(inc.valueSet)) for (const v of inc.valueSet.slice(0, 3)) if (typeof v === "string") await visit(v, depth + 1);
        }
      };
      await visit(url, 0);
      return [...out];
    },
    codeInSystem: async (system, code) => {
      const r = await resolver.checkCode(system, code, null);
      if (r.status === "ok" || r.status === "invalid-display") return true;
      if (r.status === "invalid-code") return false;
      return undefined;
    },
    codeSystemDirectory: () => codeSystemDirectory(pkg),
    validate: async (resource, profiles) => (await new InstanceValidator(resolver).validate(resource, { profiles })) as Array<Record<string, any>>,
    codeSystemsWithCode: async (code) => {
      const [pids, pvers] = terminology.closureArrays(pkg);
      const r = await query<{ url: string }>(
        "SELECT DISTINCT a.canonical_url AS url FROM fhir.concepts c " +
          "JOIN unnest($1::text[], $2::text[]) AS dep(pid, pver) ON c.package_id = dep.pid AND c.package_version = dep.pver " +
          "JOIN fhir.artifacts a ON a.package_id = c.package_id AND a.package_version = c.package_version AND a.resource_type = 'CodeSystem' AND a.artifact_id = c.cs_id " +
          "WHERE c.code = $3 AND a.canonical_url IS NOT NULL LIMIT 5",
        [pids, pvers, code],
      );
      return r.rows.map((x) => x.url);
    },
  };
}
