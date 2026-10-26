/**
 * Tool specs + DB-backed deps of the IG structure tools (ISSUES_v16 R1 / R2):
 * `fhir_get_bundle_blueprint` (blueprint.ts) and `fhir_get_minimal_skeleton` (skeleton.ts).
 * Read-only queries through the shared pool; package content is immutable per version, so
 * StructureDefinitions and example sets are memoised per closure / package.
 */

import { z } from "zod";
import { query } from "../db.js";
import * as fhirIg from "../fhirIg.js";
import type { PackageRow } from "../fhirIg.js";
import * as terminology from "../fhirTerminology.js";
import { TtlMemo } from "../ttlMemo.js";
import { toolVersion } from "../toolVersions.js";
import { IG_ERROR_HINTS } from "../fhirIgService.js";
import { AuthoringFieldsError } from "../authoring/fields.js";
import { dbFieldsDeps } from "../authoring/fieldsTool.js";
import type { AuthoringToolSpec } from "../authoring/types.js";
import { bundleBlueprint } from "./blueprint.js";
import { minimalSkeleton } from "./skeleton.js";
import { BlueprintError, isObject, stripVersion, type BlueprintDeps, type ExampleInstance, type LoadedProfile } from "./common.js";

export const BLUEPRINT_TOOL_NAME = "fhir_get_bundle_blueprint";
export const SKELETON_TOOL_NAME = "fhir_get_minimal_skeleton";

const sdMemo = new TtlMemo<Record<string, any> | null>(10 * 60_000, 600);
const examplesMemo = new TtlMemo<ExampleInstance[]>(10 * 60_000, 16);
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

/** Example resources of one package: standalone examples + the entries of its example Bundles. */
function packageExamples(packageId: string, version: string): Promise<ExampleInstance[]> {
  return examplesMemo.get(`${packageId}#${version}`, async () => {
    const rows = (
      await query<{ artifact_id: string | null; raw_json: unknown }>(
        `SELECT artifact_id, raw_json FROM fhir.artifacts
         WHERE package_id = $1 AND package_version = $2 AND grouping_id = 'examples'
         ORDER BY artifact_id LIMIT ${EXAMPLES_CAP}`,
        [packageId, version],
      )
    ).rows;
    const out: ExampleInstance[] = [];
    for (const r of rows) {
      const res = jsonValue(r.raw_json);
      if (typeof res.resourceType !== "string") continue;
      const id = String(r.artifact_id ?? res.id ?? "");
      out.push({ source: id, resource: res });
      if (res.resourceType === "Bundle" && Array.isArray(res.entry)) {
        res.entry.forEach((e: unknown, i: number) => {
          if (isObject(e) && isObject(e.resource)) out.push({ source: `${id}#${i}`, resource: e.resource });
        });
      }
    }
    return out;
  });
}

/** Deps over the live `fhir.*` store. */
export function dbBlueprintDeps(): BlueprintDeps {
  const fields = dbFieldsDeps();
  return {
    loadProfile: (profile, packageId, version) => fields.loadProfile(profile, packageId, version),

    fetchStructureDefinition(p, url) {
      const pkg = pkgOf(p);
      return sdMemo.get(`${terminology.closureKey(pkg)}|${url}`, async () => {
        const row = url.includes("|")
          ? await fhirIg.resolveCanonicalVersioned(url, pkg, { resourceType: "StructureDefinition" })
          : await fhirIg.resolveCanonical(stripVersion(url), pkg.package_id, pkg.version);
        const sd = row ? jsonValue((row as Record<string, unknown>).raw_json) : null;
        return sd && sd.resourceType === "StructureDefinition" ? sd : null;
      });
    },

    async exampleInstances(p, canonical) {
      const has = (x: ExampleInstance): boolean =>
        (((x.resource.meta as Record<string, unknown> | undefined)?.profile as unknown[]) || []).some((u) => stripVersion(String(u)) === canonical);
      // The IG being written for first (the requested package); the profile's owner when it has none.
      const pkg = pkgOf(p);
      const target = (await packageExamples(pkg.package_id, pkg.version)).filter(has);
      if (target.length || (pkg.package_id === p.packageId && pkg.version === p.packageVersion)) return target;
      return (await packageExamples(p.packageId, p.packageVersion)).filter(has);
    },

    async expandValueSet(p, valueSet, limit) {
      const vs = await terminology.loadValueSet(valueSet, pkgOf(p));
      if (!vs) return null;
      const exp = await terminology.expandCompose(vs.compose || {}, pkgOf(p), limit);
      // a partial expansion (unresolved includes, undecidable filters) is reported as truncated
      return { codings: exp.codings, truncated: exp.truncated || (exp.unresolved || []).length > 0 || (exp.warnings || []).length > 0 };
    },
  };
}

export const BLUEPRINT_TOOL_DESCRIPTION =
  "STEP 1 for writing a Bundle that must conform to a Bundle profile (e.g. a prior-authorization / claim / document Bundle of an IG): the " +
  "profile's BLUEPRINT in <= 4,000 characters. Returns `slices` (every entry slice: name, min..max, the resource profile it requires — " +
  "the profile canonical is profile_base + the name shown), `entry.slicing` (discriminator and whether slicing is CLOSED — then an entry " +
  "matching no slice is an error — or open / ordered), `type` (Bundle.type when fixed), `references` (the references between slices the " +
  "slice profiles require, also inside extensions and sliced backbones, e.g. 'claim: extension:encounter.valueReference -> encounter', " +
  "'coverage: payor -> organizationOrg'; 'if X used' = required when that optional part is present) and `recipe` (how to write it: set " +
  "every entry's resource.meta.profile to its slice's profile, include every required slice, fullUrl = urn:uuid, references = the target " +
  "entry's fullUrl). view='references' lists every reference line when `omitted.references` > 0. FLOW: blueprint -> fhir_get_minimal_skeleton(profile, " +
  "package_id) for each slice profile you need (which required values come from the record and which do not) -> write the resources " +
  "(your own JSON, or fhir_author_resources + fhir_assemble_bundle) -> fhir_finalize_bundle / fhir_validate_bundle with bundle_profile. " +
  "bundle_profile = id or canonical (|version honoured); package_id / version pick the IG as in the other fhir_* tools.";

export const SKELETON_TOOL_DESCRIPTION =
  "The MINIMAL LEGAL instance of a profile plus WHERE EACH REQUIRED VALUE COMES FROM — call it before writing a resource, especially " +
  "for profiles with many required elements. Returns `skeleton` (JSON with every required element, recursively: required slices, " +
  "extensions (url + value), fixed / pattern values already filled in, meta.profile set; replace each <...> placeholder) and `table` " +
  "rows [path, value_source, how]. value_source: ig-constant = fixed / pattern of the profile, or a value IDENTICAL in every one of the " +
  "IG's own example instances (>= 2; e.g. the national payer agency's identifier, a workflow status the IG always uses) — copy it; " +
  "code-lookup = pick a code (small bindings list their codes, larger ones name the ValueSet: fhir_normalize_code / fhir_expand_valueset); " +
  "text-allowed = {text} alone is valid (the binding is not required and coding is optional); derivable = computed without a record fact " +
  "(a reference = the target entry's fullUrl, 1-2-3 numbering, a workflow default, a derivation rule, the date a request was written = " +
  "the record's date for it, else the visit / document date); record = a fact the record must state. ONLY `record` rows need the record: " +
  "a missing ig-constant / code-lookup / text-allowed / derivable value is never a reason to refuse. `conditional` rows are required when " +
  "the profile rule in `conditions` applies (e.g. 'sequence=1 implies ...'); `rules` / `more_rules` are the profile's other invariants. " +
  "Elements not in the skeleton are optional. <= 6,000 characters (`omitted` counts rows dropped for size). FLOW: fhir_get_bundle_blueprint " +
  "(for a Bundle) -> this tool per profile -> write the resource -> fhir_finalize_resource / fhir_validate_resource (or fhir_finalize_bundle " +
  "for the Bundle). profile = id or canonical (|version honoured); pass the package_id of the IG you write for (its examples are the basis " +
  "of the example constants).";

const common = {
  package_id: z.string().nullish().default(null),
  version: z.string().nullish().default(null),
};

export const blueprintInputShape = {
  bundle_profile: z.string(),
  ...common,
  view: z.enum(["summary", "references"]).default("summary"),
};

export const skeletonInputShape = {
  profile: z.string(),
  ...common,
};

function errorEnvelope(e: unknown): Record<string, unknown> | null {
  if (e instanceof AuthoringFieldsError || e instanceof BlueprintError) {
    const hint = IG_ERROR_HINTS[e.code];
    return { ok: false, data: null, warnings: [], error: { code: e.code, message: e.message, ...(hint ? { hint } : {}), ...e.extra } };
  }
  return null;
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

export function makeBlueprintTools(deps: BlueprintDeps): AuthoringToolSpec[] {
  return [
    {
      name: BLUEPRINT_TOOL_NAME,
      description: BLUEPRINT_TOOL_DESCRIPTION,
      inputShape: blueprintInputShape,
      async handler(args) {
        const envelope = { tool: BLUEPRINT_TOOL_NAME, toolVersion: toolVersion(BLUEPRINT_TOOL_NAME) };
        try {
          const r = await bundleBlueprint(
            { bundle_profile: String(args.bundle_profile ?? ""), package_id: str(args.package_id), version: str(args.package_id) ? str(args.version) : null, view: args.view === "references" ? "references" : "summary", envelope_provenance: envelope },
            deps,
          );
          return { ok: true, data: r.data, warnings: r.warnings, provenance: r.provenance };
        } catch (e) {
          const env = errorEnvelope(e);
          if (env) return env;
          throw e;
        }
      },
    },
    {
      name: SKELETON_TOOL_NAME,
      description: SKELETON_TOOL_DESCRIPTION,
      inputShape: skeletonInputShape,
      async handler(args) {
        const envelope = { tool: SKELETON_TOOL_NAME, toolVersion: toolVersion(SKELETON_TOOL_NAME) };
        try {
          const r = await minimalSkeleton(
            { profile: String(args.profile ?? ""), package_id: str(args.package_id), version: str(args.package_id) ? str(args.version) : null, envelope_provenance: envelope },
            deps,
          );
          return { ok: true, data: r.data, warnings: r.warnings, provenance: r.provenance };
        } catch (e) {
          const env = errorEnvelope(e);
          if (env) return env;
          throw e;
        }
      },
    },
  ];
}

let dbTools: AuthoringToolSpec[] | null = null;
/** The production tool specs (lazy: the DB deps are built on first use). */
export function blueprintTools(): AuthoringToolSpec[] {
  return (dbTools ??= makeBlueprintTools(dbBlueprintDeps()));
}
