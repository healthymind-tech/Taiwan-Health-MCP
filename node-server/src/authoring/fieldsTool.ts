/**
 * `fhir_get_authoring_fields` — tool spec + the DB-backed deps of `authoringFields`
 * (workstream A). The spec is registered by `index.ts`; nothing here touches mcp.ts.
 */

import { z } from "zod";
import { query } from "../db.js";
import * as fhirIg from "../fhirIg.js";
import type { PackageRow } from "../fhirIg.js";
import * as terminology from "../fhirTerminology.js";
import { TtlMemo } from "../ttlMemo.js";
import { toolVersion } from "../toolVersions.js";
import { IG_ERROR_HINTS } from "../fhirIgService.js";
import { authoringFields, authoringFieldsData, AuthoringFieldsError, type FieldsDeps, type LoadedProfile } from "./fields.js";
import type { AuthoringToolSpec } from "./types.js";

export const FIELDS_TOOL_NAME = "fhir_get_authoring_fields";

/** Example resources per (package version, resource type); package content is immutable per version. */
const examplesMemo = new TtlMemo<Array<Record<string, unknown>>>(10 * 60_000, 64);
const EXAMPLES_CAP = 400;

function jsonValue(raw: unknown): Record<string, any> {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return (raw as Record<string, any>) || {};
}

function pkgOf(p: LoadedProfile): PackageRow {
  return p.handle as PackageRow;
}

/** Deps over the live `fhir.*` store (read-only queries through the shared pool). */
export function dbFieldsDeps(): FieldsDeps {
  return {
    async loadProfile(profile, packageId, version) {
      let target: fhirIg.ResolvedTarget;
      try {
        target = await fhirIg.resolveTarget({ packageId: packageId || null, version: packageId ? version ?? null : null, canonicals: [profile] });
      } catch (e) {
        if (e instanceof fhirIg.IGNotFoundError) {
          let installed: string[] = [];
          try {
            installed = (await fhirIg.listPackages()).map((p) => `${p.package_id}#${p.version}${p.is_default ? " (default)" : ""}`);
          } catch {
            installed = [];
          }
          throw new AuthoringFieldsError(e.code, e.message, { installed_igs: installed.slice(0, 50) });
        }
        throw e;
      }
      const pkg: PackageRow = { ...target.pkg, _closure: target.closure };
      let row: Record<string, any> | null = null;
      if (profile.includes("|")) {
        row = (await fhirIg.resolveCanonicalVersioned(profile, pkg)) as Record<string, any> | null;
      } else {
        row =
          (
            await query<Record<string, any>>(
              `SELECT package_id, package_version, artifact_id, canonical_url, resource_type, raw_json
               FROM fhir.artifacts
               WHERE package_id = $1 AND package_version = $2
                 AND (artifact_id = $3 OR canonical_url = $3 OR artifact_key = $3)
               ORDER BY (artifact_id = $3) DESC
               LIMIT 1`,
              [pkg.package_id, pkg.version, profile],
            )
          ).rows[0] ?? null;
        if (!row) row = (await fhirIg.resolveCanonical(profile, pkg.package_id, pkg.version)) as Record<string, any> | null;
      }
      if (!row) throw new AuthoringFieldsError("ARTIFACT_NOT_FOUND", `profile not found: ${profile}`);
      const sd = jsonValue(row.raw_json);
      if (sd.resourceType !== "StructureDefinition" || !((sd.snapshot || {}).element || []).length) {
        throw new AuthoringFieldsError("INVALID_ARGUMENT", `${profile} is not a StructureDefinition with a snapshot`);
      }
      const provenance: Record<string, unknown> = {
        packageId: pkg.package_id,
        version: pkg.version,
        fhirVersion: pkg.fhir_version ?? null,
        source: "ig",
        resolved_by: target.resolvedBy,
      };
      if (target.closureVersions) provenance.closure_versions = target.closureVersions;
      return {
        sd,
        profileId: String(row.artifact_id ?? sd.id ?? profile),
        canonical: (row.canonical_url ?? sd.url ?? null) as string | null,
        packageId: String(row.package_id),
        packageVersion: String(row.package_version),
        handle: pkg,
        provenance,
        warnings: target.notes,
        depsMissing: target.depsMissing.length ? target.depsMissing : undefined,
      };
    },

    loadExamples(p, resourceType) {
      const key = `${p.packageId}#${p.packageVersion}|${resourceType}`;
      return examplesMemo.get(key, async () => {
        const rows = (
          await query<{ raw_json: unknown }>(
            `SELECT raw_json FROM fhir.artifacts
             WHERE package_id = $1 AND package_version = $2 AND grouping_id = 'examples' AND resource_type = $3
             ORDER BY artifact_id LIMIT ${EXAMPLES_CAP}`,
            [p.packageId, p.packageVersion, resourceType],
          )
        ).rows;
        return rows.map((r) => jsonValue(r.raw_json));
      });
    },

    async expandValueSet(p, valueSet, limit) {
      const vs = await terminology.loadValueSet(valueSet, pkgOf(p));
      if (!vs) return null;
      const exp = await terminology.expandCompose(vs.compose || {}, pkgOf(p), limit);
      return { codings: exp.codings, truncated: exp.truncated };
    },

    async resourceTypes(p, canonicals) {
      const [pids, pvers] = terminology.closureArrays(pkgOf(p));
      const rows = (
        await query<{ canonical_url: string; type: string | null }>(
          "SELECT DISTINCT ON (a.canonical_url) a.canonical_url, COALESCE(a.raw_json ->> 'type', a.base_type) AS type FROM fhir.artifacts a " +
            "JOIN unnest($1::text[], $2::text[]) WITH ORDINALITY AS dep(pid, pver, ord) ON a.package_id = dep.pid AND a.package_version = dep.pver " +
            "WHERE a.resource_type = 'StructureDefinition' AND a.canonical_url = ANY($3::text[]) ORDER BY a.canonical_url, dep.ord",
          [pids, pvers, canonicals],
        )
      ).rows;
      const out = new Map<string, string>();
      for (const r of rows) if (r.type) out.set(r.canonical_url, r.type);
      return out;
    },
  };
}

export const FIELDS_TOOL_DESCRIPTION =
  "The WRITING form of a profile: which fields to give fhir_author_resources, how, and which ones the MCP fills itself. " +
  "Returns `fields` (required / expected / commonly used in the IG's own examples — see `why`), `more` ({field, kind} of the remaining " +
  "mustSupport fields; include_more=false omits it) and `omitted` (fields dropped for size, never silent). Each field: `field` = FHIR " +
  "element path relative to the resource ('identifier:mrn' = slice, 'value[x]' = choice, 'component:SystolicBP' = one component); " +
  "`kind` + `format` say how to write the value; `source` says where it comes from (record / facility / code / fixed / default / derived); " +
  "`binding.codes` lists small code sets (larger ones: fhir_normalize_code / fhir_expand_valueset); `targets` = reference types; " +
  "`children` = sub-fields of components / dosage / names. Fields with `auto: true` (fixed, default, derived) need NOT be filled — the MCP " +
  "supplies them (`value` shows what); `pins` shows the parts the profile fixes inside a field you still fill (identifier system, " +
  "component code, unit). Defaults are auto only on REQUIRED elements (e.g. Observation.status → final); an optional element with a " +
  "conventional value (Patient.active, Immunization.primarySource …) is listed as a normal optional field whose `format` / `example` " +
  "show that value — give it only when the record states it (fhir_author_resources never fills it; apply_defaults=\"none\" turns the " +
  "required ones off too). A display you write for a code is checked and replaced by the code's own display when the terminology " +
  "rejects it; a single object where a field repeats is wrapped into an array (fhir_author_resources results[].notes). Never invent values: give only what the record states; a missing required value is reported as `missing`, not " +
  "guessed. Value grammar (fields object of fhir_author_resources): scalars as JSON; codeableConcept/coding {system, code, display?} or " +
  "[{...}] or {text}; quantity {value, unit} or '95 mg/dL'; date/dateTime ISO (2026-06-15, 2026-06-15T06:00) or ROC (115/06/15); period " +
  "{start, end?}; identifier {value, system?}; reference {ref: '<key of another resource in the context>'} or {reference: 'Type/id'}; " +
  "choice value[x] → give `value`, its shape picks the type; component:<slice> {value: ...}; humanName {text} or {family, given[]}; dosage " +
  "{text?, route?, dose?, frequency?, period?, asNeeded?}. Example: {\"profile\": \"Observation-bloodPressure-twcore\"} → fields such as " +
  "{field: 'component:SystolicBP', kind: 'component', required: true, source: 'record', example: {value: {value: 12.5, unit: 'mm[Hg]'}}}. " +
  "Examples illustrate the shape only. profile = id or canonical (|version honoured); package_id / version pick the IG as in the other fhir_* tools.";

export const fieldsInputShape = {
  profile: z.string(),
  package_id: z.string().nullish().default(null),
  version: z.string().nullish().default(null),
  include_more: z.boolean().default(true),
};

/** Build the tool spec over any deps (tests inject fakes; the default export uses the DB). */
export function makeFieldsTool(deps: FieldsDeps): AuthoringToolSpec {
  return {
    name: FIELDS_TOOL_NAME,
    description: FIELDS_TOOL_DESCRIPTION,
    inputShape: fieldsInputShape,
    async handler(args: Record<string, unknown>): Promise<unknown> {
      const profile = typeof args.profile === "string" ? args.profile : "";
      const packageId = typeof args.package_id === "string" && args.package_id ? args.package_id : null;
      const version = typeof args.version === "string" && args.version ? args.version : null;
      const includeMore = args.include_more !== false;
      try {
        const res = await authoringFields({ profile, package_id: packageId, version, include_more: includeMore }, deps);
        return {
          ok: true,
          data: authoringFieldsData(res),
          warnings: res.warnings,
          provenance: { ...(res.provenance || {}), tool: FIELDS_TOOL_NAME, toolVersion: toolVersion(FIELDS_TOOL_NAME) },
        };
      } catch (e) {
        if (e instanceof AuthoringFieldsError) {
          const hint = IG_ERROR_HINTS[e.code];
          return { ok: false, data: null, warnings: [], error: { code: e.code, message: e.message, ...(hint ? { hint } : {}), ...e.extra } };
        }
        throw e;
      }
    },
  };
}

let dbTool: AuthoringToolSpec | null = null;
/** The production tool spec (lazy: builds the DB deps on first use). */
export function fieldsTool(): AuthoringToolSpec {
  return (dbTool ??= makeFieldsTool(dbFieldsDeps()));
}
