/**
 * Tool specs + DB-backed deps of the IG structure tools (ISSUES_v16 R1 / R2):
 * `fhir_get_bundle_blueprint` (blueprint.ts) and `fhir_get_minimal_skeleton` (skeleton.ts).
 * Read-only queries through the shared pool; package content is immutable per version, so
 * StructureDefinitions and example sets are memoised per closure / package.
 */

import { envBudgetBytes } from "../memSize.js";
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
import { bundleForm, type FormEntryPlan } from "./form.js";
import { igDefinedValues } from "./igValues.js";
import { knownDefects } from "../igKnownDefects.js";
import type { IgDefinedValues } from "../grounding/igDefined.js";
import { BlueprintError, isObject, stripVersion, type BlueprintDeps, type ExampleInstance, type LoadedProfile } from "./common.js";

export const BLUEPRINT_TOOL_NAME = "fhir_get_bundle_blueprint";
export const SKELETON_TOOL_NAME = "fhir_get_minimal_skeleton";
export const FORM_TOOL_NAME = "fhir_get_bundle_form";

const sdMemo = new TtlMemo<Record<string, any> | null>(10 * 60_000, 600, envBudgetBytes("BLUEPRINT_SD_CACHE_MB", 128));
const examplesMemo = new TtlMemo<ExampleInstance[]>(10 * 60_000, 16, envBudgetBytes("BLUEPRINT_EXAMPLES_CACHE_MB", 64));
const profilesMemo = new TtlMemo<Record<string, any>[]>(10 * 60_000, 16, envBudgetBytes("BLUEPRINT_PROFILES_CACHE_MB", 64));
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

    igProfiles(p) {
      const pkg = pkgOf(p);
      return profilesMemo.get(`${pkg.package_id}#${pkg.version}`, async () =>
        (
          await query<{ raw_json: unknown }>(
            `SELECT raw_json FROM fhir.artifacts
             WHERE package_id = $1 AND package_version = $2 AND resource_type = 'StructureDefinition' AND derivation = 'constraint'
             ORDER BY artifact_key LIMIT 2000`,
            [pkg.package_id, pkg.version],
          )
        ).rows
          .map((r) => jsonValue(r.raw_json))
          .filter((sd) => sd.resourceType === "StructureDefinition"),
      );
    },

    knownDefects(p) {
      const pkg = pkgOf(p);
      return knownDefects((pkg._closure ?? [[pkg.package_id, pkg.version]]).map(([id, v]) => ({ package_id: id, version: v })));
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
  "IG's own example instances (>= 2): a workflow status the IG always uses, or the identity of a NATIONAL payer / authority organization " +
  "(an Organization profile the IG's payor / insurer references target, or typed govt / pay / ins) — copy it; an example hospital, clinic, " +
  "lab, practitioner or patient is never ig-constant (its name / identifier / telecom / address are `record`); " +
  "code-lookup = pick a code (small bindings list their codes, larger ones name the ValueSet: fhir_normalize_code / fhir_expand_valueset); " +
  "text-allowed = {text} alone is valid (the binding is not required and coding is optional); derivable = computed without a record fact " +
  "(a reference = the target entry's fullUrl, 1-2-3 numbering, a workflow default, a derivation rule, the date a request was written = " +
  "the record's date for it, else the visit / document date) — or a value the record determines without writing it ('derive from the " +
  "record: …' rows: Condition.verificationStatus from the diagnosis field, Observation.interpretation from the value's H / L flag or " +
  "reference range, MedicationRequest.category from 出院帶藥 / 門診 / 住院: write it from that cue); record = a fact the record must state. ONLY `record` rows need the record: " +
  "a missing ig-constant / code-lookup / text-allowed / derivable value is never a reason to refuse. `conditional` rows are required when " +
  "the profile rule in `conditions` applies (e.g. 'sequence=1 implies ...'); `rules` / `more_rules` are the profile's other invariants. " +
  "Elements not in the skeleton are optional. <= 6,000 characters (`omitted` counts rows dropped for size). FLOW: fhir_get_bundle_blueprint " +
  "(for a Bundle) -> this tool per profile -> write the resource -> fhir_finalize_resource / fhir_validate_resource (or fhir_finalize_bundle " +
  "for the Bundle). profile = id or canonical (|version honoured); pass the package_id of the IG you write for (its examples are the basis " +
  "of the example constants).";

export const FORM_TOOL_DESCRIPTION =
  "A PREFILLED FORM of a Bundle profile: a skeleton Bundle whose STRUCTURE IS ALREADY CORRECT — fill the values, do not restructure. " +
  "Holds every required entry slice plus your planned `entries` (profile id / canonical, `count`), each entry a complete resource " +
  "(meta.profile, required elements, fixed / pattern values, required extensions and slices), Bundle.type / meta.profile, fullUrls " +
  "(urn:uuid) and every internal reference wired (also inside extensions; entries a required reference needs are added); a document " +
  "Bundle has the Composition first, its required sections (+ the section a planned entry belongs to) and section.entry wired, and " +
  "identifier / timestamp. Every value the record (or a code lookup) must give is a token \"<<P<n>:<value_source>>>\" at " +
  "placeholders[n].pointer (RFC 6901 into `bundle`) with `type` (FHIR datatype: replace the token with a JSON value of it; Reference = " +
  "{\"reference\": an entry fullUrl}), `what`, `value_source` (record | code-lookup | text-allowed | derivable), `required`, optional " +
  "`allowed` (pick one; a code: also its system), `target`, `example` (an IG example value / a code of the binding — never copy it as " +
  "a record fact), `format` (regex), `rules` (profile rules the value triggers; an allowed code with `triggers` needs more content). " +
  "required=false = delete it when the record has no value (see if_empty). `prefilled` = defaults already set (change only if the record " +
  "says otherwise). Then fhir_finalize_bundle / fhir_validate_bundle with bundle_profile. bundle_profile = id or canonical; package_id / " +
  "version pick the IG as in the other fhir_* tools; bundle_type only when the profile does not fix Bundle.type.";

const common = {
  package_id: z.string().nullish().default(null),
  version: z.string().nullish().default(null),
};

export const blueprintInputShape = {
  bundle_profile: z.string(),
  ...common,
  view: z.enum(["summary", "references"]).default("summary"),
};

export const formInputShape = {
  bundle_profile: z.string(),
  ...common,
  entries: z
    .array(z.object({ profile: z.string(), count: z.number().int().min(1).max(5).nullish() }))
    .max(30)
    .nullish()
    .default(null),
  bundle_type: z.enum(["document", "message", "transaction", "batch", "collection", "history", "searchset"]).nullish().default(null),
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
    {
      name: FORM_TOOL_NAME,
      description: FORM_TOOL_DESCRIPTION,
      inputShape: formInputShape,
      async handler(args) {
        const envelope = { tool: FORM_TOOL_NAME, toolVersion: toolVersion(FORM_TOOL_NAME) };
        try {
          const entries = Array.isArray(args.entries)
            ? (args.entries as unknown[]).filter(isObject).map((e): FormEntryPlan => ({ profile: String(e.profile ?? ""), count: typeof e.count === "number" ? e.count : null }))
            : null;
          const r = await bundleForm(
            { bundle_profile: String(args.bundle_profile ?? ""), package_id: str(args.package_id), version: str(args.package_id) ? str(args.version) : null, entries, bundle_type: str(args.bundle_type), envelope_provenance: envelope },
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

let dbDeps: BlueprintDeps | null = null;

/**
 * ISSUES_v17.2: IG-defined values (igValues.ts) of an instance over the live store — the package resolved as the
 * validator resolves it (package_id / meta.profile owner / default IG). null when nothing resolves (fail-open).
 */
export async function dbIgDefinedValues(root: Record<string, any>, packageId: string | null, version: string | null): Promise<IgDefinedValues | null> {
  const resources: Array<Record<string, any>> = root?.resourceType === "Bundle" ? (Array.isArray(root.entry) ? root.entry.map((e: any) => e?.resource).filter(isObject) : []) : [root];
  const metaProfiles = [...new Set([root, ...resources].flatMap((r) => (Array.isArray(r?.meta?.profile) ? r.meta.profile : []).filter((u: unknown) => typeof u === "string")))] as string[];
  if (!metaProfiles.length) return null;
  let pkg: PackageRow;
  try {
    pkg = (await fhirIg.resolveTarget({ packageId: packageId || null, version: packageId ? version ?? null : null, metaProfiles })).pkg;
  } catch {
    return null;
  }
  const exampleProfiles = async (types: string[]): Promise<string[]> => {
    const want = new Set(types);
    const out = new Set<string>();
    for (const x of await packageExamples(pkg.package_id, pkg.version)) {
      if (!want.has(String(x.resource.resourceType ?? ""))) continue;
      for (const u of ((x.resource.meta as Record<string, unknown> | undefined)?.profile as unknown[]) || []) if (typeof u === "string") out.add(u);
    }
    return [...out];
  };
  return igDefinedValues(root, (dbDeps ??= dbBlueprintDeps()), { packageId: pkg.package_id, version: pkg.version, exampleProfiles, cacheKey: `${pkg.package_id}#${pkg.version}` });
}

let dbTools: AuthoringToolSpec[] | null = null;
/** The production tool specs (lazy: the DB deps are built on first use). */
export function blueprintTools(): AuthoringToolSpec[] {
  return (dbTools ??= makeBlueprintTools(dbBlueprintDeps()));
}
