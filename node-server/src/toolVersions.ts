/**
 * Server + per-tool version registry (MCP_GROUNDING_SPEC §6.3).
 *
 * Single source of truth for:
 *   - SERVER_VERSION: MCP `initialize` serverInfo.version and health_check.version;
 *   - BUILD: git sha baked in at image build time (env BUILD_SHA / GIT_SHA), "dev" otherwise;
 *   - TOOLS_VERSION: versions of tools whose behaviour is pinned by fixtures.
 *     Bump a tool's entry whenever its output for the same input changes.
 *
 * Other tool implementers edit TOOLS_VERSION here (keep it one exported constant).
 */

export const SERVER_VERSION = "1.1.0";

export const BUILD: string = (process.env.BUILD_SHA || process.env.GIT_SHA || "").trim() || "dev";

export const TOOLS_VERSION: Record<string, string> = {
  // 1.1.1: description is edition-agnostic (was "ICD-10-CM/PCS 2025"); output unchanged.
  search_medical_codes: "1.1.1",
  // 1.2.0: version-aware package resolution (fhirIg.resolveTarget): provenance.resolved_by /
  // closure_versions, data.deps_missing, "|version" honoured (no silent fallback to another version).
  fhir_get_profile_required_elements: "1.2.0",
  // 1.1.0 (lexicon tw-lexicon 0.3.0, issues v1): time-only evidence takes the date in force at its line;
  // whole-label stated-absent concepts (出生地 is not the birth date) and no stated-absent when the record states
  // the patient field; zh/en department / setting aliases with whole-token short forms (ED / ER / OPD / ICU);
  // the 【轉換目標】 line never joins another line's window; zh->en bridges for Chinese-only NHI displays.
  fhir_check_grounding: "1.1.0",
  // 1.1.0: stated absences by whole-label matching (shared with fhir_check_grounding, lexicon 0.3.0).
  // 1.1.1: instruction / site-config lines never join a value or duration window, even when no blank line
  // separates them from the item line (a value on the 【轉換目標】 line was reported as found).
  fhir_check_completeness: "1.1.1",
  // 1.1.0: optional source_text / site_config / evidence_map / grounding (spec §2.4). Without them the
  // output is unchanged; builtin validator: a code-less Coding matches every required-binding slice (HL7 7.0.1).
  // 1.2.0: without package_id the package owning meta.profile is used (was: always the default IG);
  // provenance.resolved_by / closure_versions, data.deps_missing.
  // 1.3.0 (builtin validator v6): "|version" canonicals in meta.profile / binding / targetProfile / type
  // profile / extension url resolved like HL7 7.0.1 (CanonicalResourceManager.getByPackage); slice members
  // also checked against the slicing base element; not-checked profiles carry `unchecked` (completenessOf →
  // checked_fully / profiles_unchecked / valuesets_unchecked); partial-CodeSystem information hint.
  // 1.4.0: the optional source_text grounding follows fhir_check_grounding 1.1.0 (output without source_text unchanged).
  fhir_validate_bundle: "1.4.0",
  fhir_validate_resource: "1.4.0",
  // 1.2.0 (all below): provenance.resolved_by / closure_versions; canonical arguments resolve to their
  // owning package when package_id is omitted; "|version" honoured; list/search: all_packages + zero-hit hint;
  // NO_DEFAULT_IG instead of an arbitrary package when no default IG is set.
  fhir_list_igs: "1.2.0",
  fhir_get_ig: "1.2.0",
  fhir_list_artifacts: "1.2.0",
  fhir_search_artifacts: "1.2.0",
  fhir_list_resource_profiles: "1.2.0",
  fhir_rank_resource_profiles: "1.2.0",
  fhir_get_profile: "1.2.0",
  fhir_get_profile_elements: "1.2.0",
  fhir_get_valueset: "1.2.0",
  fhir_expand_valueset: "1.2.0",
  fhir_lookup_code: "1.2.0",
  fhir_validate_code: "1.2.0",
  fhir_normalize_code: "1.2.0",
  fhir_get_resource_skeleton: "1.2.0",
  fhir_finalize_resource: "1.2.0",
};

/** Version for one tool (falls back to the server version). */
export function toolVersion(name: string): string {
  return TOOLS_VERSION[name] ?? SERVER_VERSION;
}
