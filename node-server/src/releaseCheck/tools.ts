/**
 * Tool specs of fhir_check_fact_coverage (factCoverage/, ISSUES_v18 R3 = v20 R4) and fhir_release_check
 * (releaseCheck/, ISSUES_v18 R4 + v20 R1). `registerReleaseTools` is called by registerFhirIgTools in mcp.ts, so the
 * FHIR IG group's module gate (ig), metrics, error boundary and heavy-tool gate (toolConcurrency.ts HEAVY_TOOLS) apply
 * as to fhir_validate_bundle. The DB deps are lazy: nothing is touched at registration time (toolCatalog()).
 * Neither tool logs source_text, quotes or fact values.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authoringFields } from "../authoring/fields.js";
import { dbFieldsDeps } from "../authoring/fieldsTool.js";
import { okEnvelope, errorEnvelope, invalidArgumentError } from "../authoring/toolEnvelope.js";
import type { FieldSpec } from "../authoring/types.js";
import { checkFactCoverage, FACT_COVERAGE_VERSION, type FactCoverageDeps, type Fact } from "../factCoverage/coverage.js";
import { LEXICON_VERSION } from "../grounding/lexicon.js";
import type { TerminologyNames } from "../grounding/terminologyNames.js";
import { dbBlueprintDeps } from "../igBlueprint/tools.js";
import { RECORD_CHECKS_LEXICON_VERSION } from "../recordChecks/lexicon.js";
import { RELEASE_CHECK_VERSION, releaseCheck, type EntrySlice, type ReleaseDeps, type ReleaseTarget } from "./release.js";

export const FACT_COVERAGE_TOOL = "fhir_check_fact_coverage";
export const RELEASE_CHECK_TOOL = "fhir_release_check";

const pkgShape = {
  package_id: z.string().nullish().default(null).describe("IG package id; omitted → the package owning meta.profile, else the default IG (as fhir_validate_bundle)"),
  version: z.string().nullish().default(null).describe("Package version (with package_id)"),
};

const sourceText = z
  .string()
  .max(200000, "source_text is limited to 200,000 characters (a clinical record is far shorter); send the record of this case only")
  .describe("The clinical record text the Bundle was converted from. Never logged.");

const factSchema = z.object({
  item: z.string().describe("What the fact is about (藥品 Amlodipine, 體溫, 診斷, 病人 …) — also names the resource type it belongs to"),
  attribute: z.string().nullish().default(null).describe("Which property (劑量, 途徑, 頻次, 日期, 數值, 代碼, 性別 …)"),
  value: z.union([z.string(), z.number(), z.boolean()]).describe("The value as the record states it (PO, BID, 114/06/02, 0.5 g, I10, 高血壓 …)"),
  quote: z.string().describe("The record text the fact comes from — must be a substring of source_text"),
  resource_type: z.string().nullish().default(null).describe("Optional: the resource type the fact belongs to (else inferred from item / attribute)"),
});

export const factCoverageInputShape = {
  bundle: z.record(z.any()).describe("The FHIR Bundle"),
  source_text: sourceText,
  facts: z.array(factSchema).min(1).max(500).describe("The facts the conversion target needs, each with its record quote: [{item, attribute, value, quote}]"),
  ...pkgShape,
};

const targetSchema = z.object({
  resourceType: z.string().nullish().default(null).describe("Resource type the Bundle must contain"),
  profile: z.string().nullish().default(null).describe("Profile (canonical or id) the entry must declare in meta.profile"),
  what: z.string().nullish().default(null).describe("What the item is, for messages (病人, 體溫 …)"),
  code: z.object({ system: z.string().nullish().default(null), code: z.string() }).nullish().default(null).describe("A code the entry must carry (e.g. LOINC 8310-5 for body temperature)"),
  min: z.number().int().min(1).nullish().default(null).describe("Minimum number of such entries (default 1)"),
  facts: z.array(z.number().int().min(0)).nullish().default(null).describe("Indices into `facts` this item needs (default: facts naming its resource type)"),
});

export const releaseCheckInputShape = {
  bundle: z.record(z.any()).describe("The FHIR Bundle to release"),
  source_text: sourceText,
  facts: z.array(factSchema).max(500).nullish().default(null).describe("Optional fact list (as fhir_check_fact_coverage): coverage must be complete to release"),
  targets: z.array(targetSchema).max(200).nullish().default(null).describe("The conversion target's required items: [{resourceType or profile, what, code?, min?}] — each must be in the Bundle"),
  site_config: z.string().nullish().default(null).describe("Facility settings text (as fhir_validate_bundle). Never logged."),
  ...pkgShape,
  bundle_profile: z.string().nullish().default(null).describe("The Bundle profile the Bundle must conform to (as fhir_validate_bundle); also gives the required entry slices when no targets are passed"),
  require_official: z.boolean().nullish().default(true).describe("Default true: only an official validator verdict (0 errors, checked fully) releases. false: accept the MCP validator's verdict (development only)."),
};

export const FACT_COVERAGE_DESCRIPTION =
  "Check a fact list against the record and the Bundle (deterministic, no LLM). Per fact {item, attribute, value, quote}: " +
  "(1) the quote must be a substring of source_text (full-width / whitespace normalised) — else quote_not_in_record (fabricated basis); " +
  "(2) the clause around the quote must not negate it or mark it old / pending / not applicable / not established / not done — else " +
  "not_usable (do not write it; if the conversion target needs it, the case is insufficient_information); (3) the value must be in a " +
  "STRUCTURED element of an entry of the fact's resource type (text, display, note, narrative do not count), compared with terminology " +
  "equivalence: PO ↔ route coding (SNOMED 26643006 or an IG route code naming it), BID ↔ Timing.repeat frequency 2 / period 1 d or " +
  "timing.code, ROC (民國) ↔ ISO dates, unit conversions (0.5 g = 500 mg), number spellings, codes by code or by the coding's display / " +
  "terminology names — else missing (with found_elsewhere when it sits in another resource type); (4) each missing fact gets " +
  "suggested_paths from the entry profile's authoring fields. Returns facts: [{index, status: covered|missing|quote_not_in_record|" +
  "not_usable, reason_code, reason, resource_types, found_at?: [{pointer (RFC 6901), path, value, how}], found_elsewhere?, " +
  "suggested_paths?, markers?, clause?}] and summary {total, covered, missing, quote_not_in_record, not_usable, coverage, complete}. Generic for all IGs.";

export const RELEASE_CHECK_DESCRIPTION =
  "The final release gate for a converted Bundle. release=true only if ALL hold: the official validator reports 0 errors (the " +
  "fhir_validate_bundle pipeline; an MCP fallback, unverified codes or no official engine → not-officially-verified); grounding + record " +
  "checks against source_text report 0 BLOCKING errors (each content finding has gate blocking|advisory; advisory errors are returned in " +
  "content.advisory_errors but do not stop the release); fact coverage is complete when facts are given (fhir_check_fact_coverage); completeness: " +
  "every `targets` item is present (count ≥ min, else missing-target), or without targets the Bundle profile's required entry slices are " +
  "present and a single-entry Bundle is not accepted when the facts name several resource types (suspected-empty-bundle); with neither " +
  "targets nor facts → incomplete-input (never released). Returns " +
  "{release, next: send|fix|insufficient_information, reasons: [{code, message, pointer?, count, check}], validation, content, facts, " +
  "completeness}. Reason codes: validation-failed, validation-error, not-officially-verified, grounding-error, record-check-error, " +
  "no-source-text, fact-missing, fact-in-other-resource, quote-not-in-record, unusable-fact-written, missing-target, insufficient-information, " +
  "missing-entry-slice, suspected-empty-bundle, incomplete-input. next=insufficient_information when a missing target's facts are absent from the record " +
  "or unusable: do not send — the case cannot be converted automatically. Never send a Bundle with release=false.";

function provenance(): Record<string, unknown> {
  return { lexicon: LEXICON_VERSION, recordChecksLexicon: RECORD_CHECKS_LEXICON_VERSION };
}

const isBundle = (b: unknown): b is Record<string, any> => !!b && typeof b === "object" && !Array.isArray(b) && (b as Record<string, unknown>).resourceType === "Bundle";

/** Required entry slices of a Bundle StructureDefinition snapshot (Bundle.entry:<slice> with min ≥ 1). */
export function entrySlicesOf(sd: Record<string, any>): EntrySlice[] {
  const els: Array<Record<string, any>> = sd?.snapshot?.element ?? [];
  const byId = new Map(els.map((e) => [String(e.id), e]));
  const out: EntrySlice[] = [];
  for (const e of els) {
    const m = /^Bundle\.entry:([^.]+)$/u.exec(String(e.id ?? ""));
    if (!m || e.max === "0" || !(Number(e.min ?? 0) >= 1)) continue;
    const res = byId.get(`${e.id}.resource`);
    const types = [...new Set(((res?.type ?? []) as Array<Record<string, any>>).map((t) => String(t.code ?? "")).filter((t) => t && t !== "Resource"))];
    const profiles = [...new Set(((res?.type ?? []) as Array<Record<string, any>>).flatMap((t) => (Array.isArray(t.profile) ? t.profile.map(String) : [])))];
    out.push({ name: m[1], min: Number(e.min), types, profiles });
  }
  return out;
}

export interface ReleaseToolDeps {
  terminology: () => TerminologyNames | null;
  fields: (profile: string, packageId: string | null, version: string | null) => Promise<readonly FieldSpec[] | null>;
  entrySlices: (bundleProfile: string, packageId: string | null, version: string | null) => Promise<EntrySlice[] | null>;
  validate: ReleaseDeps["validate"];
}

/** DB-backed deps (lazy). `validate` is the fhir_validate_bundle pipeline mcp.ts passes in. */
export function dbReleaseToolDeps(validate: ReleaseDeps["validate"], terminology: () => TerminologyNames | null): ReleaseToolDeps {
  return {
    terminology,
    fields: async (profile, packageId, version) => (await authoringFields({ profile, package_id: packageId, version, detail: "full", include_more: false }, dbFieldsDeps())).fields,
    entrySlices: async (bundleProfile, packageId, version) => {
      const loaded = await dbBlueprintDeps().loadProfile(bundleProfile, packageId, version);
      return loaded.sd?.type === "Bundle" ? entrySlicesOf(loaded.sd) : null;
    },
    validate,
  };
}

function coverageDeps(d: ReleaseToolDeps): FactCoverageDeps {
  return { terminology: d.terminology(), fields: d.fields };
}

export async function runFactCoverageTool(args: Record<string, unknown>, d: ReleaseToolDeps): Promise<Record<string, unknown>> {
  if (!isBundle(args.bundle)) return errorEnvelope(invalidArgumentError("bundle must be a FHIR Bundle resource"));
  const res = await checkFactCoverage(
    { bundle: args.bundle, source_text: String(args.source_text ?? ""), facts: (args.facts as Fact[]) ?? [], package_id: (args.package_id as string | null) ?? null, version: (args.version as string | null) ?? null },
    coverageDeps(d),
  );
  return okEnvelope(FACT_COVERAGE_TOOL, res, [], { ...provenance(), factCoverageVersion: FACT_COVERAGE_VERSION });
}

export async function runReleaseCheckTool(args: Record<string, unknown>, d: ReleaseToolDeps): Promise<Record<string, unknown>> {
  if (!isBundle(args.bundle)) return errorEnvelope(invalidArgumentError("bundle must be a FHIR Bundle resource"));
  const res = await releaseCheck(
    {
      bundle: args.bundle,
      source_text: String(args.source_text ?? ""),
      facts: (args.facts as Fact[] | null) ?? null,
      targets: (args.targets as ReleaseTarget[] | null) ?? null,
      site_config: (args.site_config as string | null) ?? null,
      package_id: (args.package_id as string | null) ?? null,
      version: (args.version as string | null) ?? null,
      bundle_profile: (args.bundle_profile as string | null) ?? null,
      require_official: (args.require_official as boolean | null) ?? true,
    },
    { ...coverageDeps(d), validate: d.validate, entrySlices: d.entrySlices },
  );
  return okEnvelope(RELEASE_CHECK_TOOL, res, [], { ...provenance(), releaseCheckVersion: RELEASE_CHECK_VERSION });
}

/** Register both tools (FHIR IG group; called from registerFhirIgTools). */
export function registerReleaseTools(server: McpServer, deps: () => ReleaseToolDeps): void {
  const text = (x: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(x) }] });
  server.registerTool(FACT_COVERAGE_TOOL, { description: FACT_COVERAGE_DESCRIPTION, inputSchema: factCoverageInputShape }, async (args) =>
    text(await runFactCoverageTool(args as Record<string, unknown>, deps())),
  );
  server.registerTool(RELEASE_CHECK_TOOL, { description: RELEASE_CHECK_DESCRIPTION, inputSchema: releaseCheckInputShape }, async (args) =>
    text(await runReleaseCheckTool(args as Record<string, unknown>, deps())),
  );
}
