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
  // 1.2.0: optional `system` (icd10cm | icd10pcs | any installed IG CodeSystem canonical / id / alias) routes
  // IG CodeSystems to the concept-search engine (results, clauses, search_mode); calls without `system` are unchanged.
  // 1.3.0 (2026-10-19 hybrid ranking): diagnoses = full-text ∪ nearest vectors ordered by score-aware fusion
  // (terminologyRanking.ts) instead of RRF — a strong semantic match is never pushed out of the top-k, a short
  // query prefers the concept it names over longer sub-concepts (name coverage, ICD code depth); the query
  // vector carries the model's task instruction (Qwen3-Embedding). Output shape unchanged.
  search_medical_codes: "1.3.0",
  // 1.2.0: version-aware package resolution (fhirIg.resolveTarget): provenance.resolved_by /
  // closure_versions, data.deps_missing, "|version" honoured (no silent fallback to another version).
  fhir_get_profile_required_elements: "1.2.1",
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
  fhir_validate_bundle: "1.4.1",
  fhir_validate_resource: "1.4.1",
  // 1.2.0 (all below): provenance.resolved_by / closure_versions; canonical arguments resolve to their
  // owning package when package_id is omitted; "|version" honoured; list/search: all_packages + zero-hit hint;
  // NO_DEFAULT_IG instead of an arbitrary package when no default IG is set.
  fhir_list_igs: "1.2.0",
  fhir_get_ig: "1.2.1",
  fhir_list_artifacts: "1.2.1",
  fhir_search_artifacts: "1.2.1",
  fhir_list_resource_profiles: "1.2.1",
  fhir_rank_resource_profiles: "1.2.1",
  fhir_get_profile: "1.2.1",
  fhir_get_profile_elements: "1.2.1",
  fhir_get_valueset: "1.2.1",
  fhir_expand_valueset: "1.2.1",
  // 1.3.0: found:false adds `hint` (use fhir_normalize_code with the system) and `near_codes` (IG CodeSystems).
  fhir_lookup_code: "1.3.1",
  fhir_validate_code: "1.2.1",
  // 1.3.0: IG CodeSystems use the concept-search engine (designations in any language, supplements, linked
  // names, abbreviation expansion, hybrid lexical + semantic): candidates carry matched_term / matched_language /
  // category / group / siblings; `system` may be a CodeSystem id or alias; search_mode=keyword_only when degraded;
  // `clauses` (best code per clause) for multi-item text; optional UMLS synonyms steer matching (never shown).
  // 1.4.0: SNOMED CT / LOINC / ICD-10-CM targets use the module search tools' hybrid ranking (candidates keep
  // that order; source lexical | semantic | hybrid, score = fused score, exact:true on a verbatim name) instead
  // of ILIKE-first-then-semantic; query vectors carry the model's task instruction (IG concepts: ig_concept).
  fhir_normalize_code: "1.4.0",
  fhir_get_resource_skeleton: "1.2.1",
  fhir_finalize_resource: "1.2.1",
  // ── 2026-10-19 actionable errors (additive fields only; successful outputs unchanged) ──
  // search_medical_codes 1.2.1: IG_UNAVAILABLE adds `hint`.
  // FHIR IG tools above (+.0.1): error envelopes add error.hint; IG_NOT_FOUND / NO_DEFAULT_IG add
  // error.installed_igs / installed_ig_count.
  // The tools below (were SERVER_VERSION 1.1.0) add `hint` / `suggestions` / found-flags on not-found and empty results:
  // ICD: infer_complications / get_nearby_codes (code_found / target_found:false + hint + suggestions for an unknown
  // code), browse_icd_category (hint + suggestions), check_medical_conflict (diagnosis_suggestions + hint; a DB error
  // no longer returns the raw SQL message).
  infer_complications: "1.1.1",
  get_nearby_codes: "1.1.1",
  browse_icd_category: "1.1.1",
  check_medical_conflict: "1.1.1",
  // LOINC: not-found / no-range hints; batch_interpret_lab_results reports items it could not interpret in `skipped`
  // (they used to vanish silently).
  // 1.2.0 (2026-10-19): hybrid ranking as search_medical_codes 1.3.0 with a LOINC prior (COMMON_TEST_RANK,
  // status — needs migration 20261024 + a LOINC re-import; neutral before) and the loinc query instruction.
  search_loinc: "1.2.0",
  query_loinc: "1.1.1",
  interpret_lab_result: "1.1.1",
  batch_interpret_lab_results: "1.1.1",
  // SNOMED: not-found hint; get_snomed_relationships flags an unknown concept (concept_found:false); mapping hints.
  // search_snomed_concept 1.2.0 (2026-10-19): hybrid ranking over every active name of a concept (was RRF whose
  // row LIMIT before the per-concept collapse could return fewer concepts than asked); inactive concepts sink.
  search_snomed_concept: "1.2.0",
  query_snomed_concept: "1.1.1",
  get_snomed_relationships: "1.1.1",
  query_snomed_mapping: "1.1.1",
  // Drug: empty-search / not-found hints; get_drug_details `reason` (unknown_license | cancelled | not_enriched).
  search_drug: "1.1.1",
  identify_unknown_pill: "1.1.1",
  get_drug_details: "1.1.1",
  get_drug_asset_links: "1.1.1",
  // FHIR Condition / Medication: not-found hints; DB errors no longer return the raw message.
  query_fhir_condition: "1.1.1",
  query_fhir_medication: "1.1.1",
  // FHIR servers: unknown server_key → code + available_servers + hint; allow-list errors list what is allowed;
  // transport failures are classified (UPSTREAM_TIMEOUT / _DNS_FAILED / _UNREACHABLE / _TLS_ERROR / _AUTH_FAILED);
  // non-2xx responses carry `hint`.
  list_fhir_servers: "1.1.1",
  get_fhir_server_status: "1.1.1",
  crud_fhir_server: "1.1.1",
  // INVALID_ARGUMENT envelopes add error.hint.
  fhir_resolve_reference: "1.1.1",
  fhir_build_bundle: "1.1.1",
  // 2026-10-19 query-side embedding instructions (Qwen3-Embedding): semantic matches may reorder.
  search_health_supplements: "1.2.0",
  query_food_nutrition: "1.2.0",
  query_food_ingredient: "1.2.0",
  search_foods_by_nutrient: "1.2.0",
  analyze_meal_nutrition: "1.2.0",
  // All tools: invalid arguments (MCP and POST /tools) name the parameter, rule, example and parameter list, and
  // exceptions return a coded message instead of raw SQL / driver text (cross-cutting, see toolErrors.ts).
};

/** Version for one tool (falls back to the server version). */
export function toolVersion(name: string): string {
  return TOOLS_VERSION[name] ?? SERVER_VERSION;
}
