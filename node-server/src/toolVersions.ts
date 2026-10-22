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
  // 1.4.0 (2026-10-20): `system` = IG CodeSystem follows fhir_normalize_code 1.5.0 (usage prior / sibling
  // ordering / stem forms); ICD-10-CM output unchanged.
  // 1.5.0: `system` = IG CodeSystem follows fhir_normalize_code 1.7.0 (noise stripping, abbreviation lexicon);
  // ICD-10-CM output unchanged.
  search_medical_codes: "1.5.0",
  // 1.2.0: version-aware package resolution (fhirIg.resolveTarget): provenance.resolved_by /
  // closure_versions, data.deps_missing, "|version" honoured (no silent fallback to another version).
  // 1.3.0 (2026-10-20, eval v5 R4): `derived` rows carry allowedCodes (binding expansion, extensible / preferred
  // too, cap 20) and a derivation rule in `hint` (curated, cited per rule in `derivation_source` (full view):
  // Condition.category, Observation.category, Encounter.diagnosis.use / rank, MedicationRequest / Statement category,
  // courseOfTherapyType, AllergyIntolerance category / type / criticality, Observation.interpretation), else the
  // codes' CodeSystem definitions. include_mustsupport="defaults" (only mustSupport elements with a fixed /
  // pattern / workflow-default / derivable value); mustSupport-only rows carry optional:true and an optional hint
  // (also with include_mustsupport=true, which no longer lists max=0 elements). Other rows of the default output unchanged.
  // 1.4.0 (ISSUES_v9 R4): a Bundle profile also returns `bundle_rules` (fullUrl format, references = target fullUrl, id
  // format, Bundle.type when the StructureDefinition fixes it, document / message entry order, required Bundle elements and
  // entry slices) generated from the FHIR R4 core rules + the StructureDefinition. Other profiles unchanged.
  fhir_get_profile_required_elements: "1.4.0",
  // 1.1.0 (lexicon tw-lexicon 0.3.0, issues v1): time-only evidence takes the date in force at its line;
  // whole-label stated-absent concepts (出生地 is not the birth date) and no stated-absent when the record states
  // the patient field; zh/en department / setting aliases with whole-token short forms (ED / ER / OPD / ICU);
  // the 【轉換目標】 line never joins another line's window; zh->en bridges for Chinese-only NHI displays.
  // 1.2.0 (lexicon tw-lexicon 0.4.0, issues v2): an as-needed Timing (code PRN, or text such as 'as needed' /
  // 需要時使用) is grounded by any PRN phrasing in the record ('PO PRN', '視需要'); a frequency written with it must
  // still match. New PRN phrasings 視需要 / 發作時 / as required / when needed / on demand (asNeededBoolean too).
  fhir_check_grounding: "1.2.0",
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
  // 1.5.0: the optional source_text grounding follows fhir_check_grounding 1.2.0 (output without source_text unchanged).
  // 1.6.0 (fhirSuggestions/, R1): issues may carry ranked `suggestions` [{value, kind, confidence, reason,
  // system?, display?, patch?}] (UCUM repairs, closest canonical / CodeSystem, rename / move property, allowed
  // codes of the bound ValueSet, codes named like the display, valid displays) and reference-chain errors
  // `caused_by` (the referenced resource's errors). Additive only: issue set, severities, messages, valid unchanged.
  //   Same release, builtin validator v7 (evaluation v5 false negatives): extension context
  //   (StructureDefinition.context + contextInvariant, HL7 checkExtensionContext), unversioned
  //   StructureDefinitions resolve to the highest-version copy (extensions pack over R4 core → var-1),
  //   "Unrecognized property" judged on core definitions everywhere (also below disallowed choice types /
  //   unknown extensions), RxNorm code + display (rxnorm.concepts), fuller-copy hint on Unknown code in an IG
  //   CodeSystem, no ValueSet-as-system error on a directly bound Coding.
  // 1.6.1 (builtin validator v8, evaluation v6): the known-SID list is exactly SIDUtilities (icd-10-pcs / us-mbi /
  //   eui-48 dropped), so http://hl7.org/fhir/sid/icd-10-pcs fails URL resolution on every element
  //   ("No definition could be found for URL value", error; the code keeps the unknown-system warning); whitespace in a reference is
  //   an error (REFERENCE_REF_INVALID_REF); an RxNorm display that names a different drug (no drug-name word in
  //   common with any name of the RXCUI, or no Latin letters) is an error even when only the preferred name is
  //   held; failed definition / terminology lookups (database trouble) add an error issue (code `exception`)
  //   and `lookups_failed` — never a clean pass; a validator crash is a fatal `exception` issue on a well-formed
  //   result instead of a failed call; issues of bundle entries without a usable resource are reported at
  //   Bundle level instead of being dropped.
  //   Same release (fhirSuggestions/properties): "Unrecognized property" issues add `remove_property` (patch.op
  //   "remove"; reason lists the level's element names and the resource types that carry the name), evidence
  //   renames from element alias / short text + FHIR-generic synonyms gated by the value shape, and
  //   whole-resource moves (datatype children, present choice values, sibling backbones); move paths into
  //   absent repeating elements now carry `[0]`.
  // fhir_validate_bundle 1.7.0 (ISSUES_v9 R2, fhirBundleFinalize.ts + fhirSuggestions/ids.ts): new `normalize_ids` (default false).
  //   true → the Bundle is finalized first (fullUrl / reference / id), the normalised Bundle is validated and returned as
  //   `normalized_bundle` with `id_changes` / `id_map` / `id_unresolved`; each applied change is an information issue.
  //   false → ID-class errors (UUIDs must be valid …, unresolved / relative references, missing fullUrl, invalid id, bdl-7 /
  //   bdl-11) carry suggestions (replace_fullurl / replace_reference / replace_id / move_entry / replace_bundle_type) and the
  //   data block gains `id_map` + `id_changes` (every value that must change together) + `id_unresolved`. Bundles without an
  //   ID-class issue are byte-identical to 1.6.1.
  fhir_validate_bundle: "1.7.0",
  fhir_validate_resource: "1.6.1",
  // 1.2.0 (all below): provenance.resolved_by / closure_versions; canonical arguments resolve to their
  // owning package when package_id is omitted; "|version" honoured; list/search: all_packages + zero-hit hint;
  // NO_DEFAULT_IG instead of an arbitrary package when no default IG is set.
  // 1.3.0 (fhir_list_igs / fhir_list_artifacts / fhir_search_artifacts / fhir_list_resource_profiles): opt-in
  // compact=true (id → title per type, canonical base once, only exceptional canonicals). Default output unchanged.
  fhir_list_igs: "1.3.0",
  fhir_get_ig: "1.2.1",
  fhir_list_artifacts: "1.3.0",
  fhir_search_artifacts: "1.3.0",
  fhir_list_resource_profiles: "1.3.0",
  fhir_rank_resource_profiles: "1.2.1",
  fhir_get_profile: "1.2.1",
  fhir_get_profile_elements: "1.2.1",
  fhir_get_valueset: "1.2.1",
  fhir_expand_valueset: "1.2.1",
  // 1.3.0: found:false adds `hint` (use fhir_normalize_code with the system) and `near_codes` (IG CodeSystems).
  // 1.3.2: RxNorm codes (http://www.nlm.nih.gov/research/umls/rxnorm) are looked up in rxnorm.concepts (was: not found).
  fhir_lookup_code: "1.3.2",
  fhir_validate_code: "1.2.1",
  // 1.3.0: IG CodeSystems use the concept-search engine (designations in any language, supplements, linked
  // names, abbreviation expansion, hybrid lexical + semantic): candidates carry matched_term / matched_language /
  // category / group / siblings; `system` may be a CodeSystem id or alias; search_mode=keyword_only when degraded;
  // `clauses` (best code per clause) for multi-item text; optional UMLS synonyms steer matching (never shown).
  // 1.4.0: SNOMED CT / LOINC / ICD-10-CM targets use the module search tools' hybrid ranking (candidates keep
  // that order; source lexical | semantic | hybrid, score = fused score, exact:true on a verbatim name) instead
  // of ILIKE-first-then-semantic; query vectors carry the model's task instruction (IG concepts: ig_concept).
  // 1.5.0 (2026-10-20): IG CodeSystems with a usage property (e.g. the NHI claim-volume supplement) rank by a
  // usage prior and order near-identical siblings the query cannot tell apart (same name, different method /
  // setting) by usage; long English words also match other forms of their stem (recurrent ↔ recurrence).
  // LOINC targets follow search_loinc 1.3.0.
  // 1.6.0: LOINC targets follow search_loinc 1.4.0 (specimen / timing / method words honoured).
  // 1.7.0: IG CodeSystems — dosing frequencies / measured values / doses in the text are noise (q6h, 7.8%,
  // 0.5mg, 28Fr, "Hb 9.1"); shorthand joined by "&" / "/" (I&D, U/A) is one word; an abbreviation in the
  // text's first clause that neither the CodeSystem nor the thesaurus explains is expanded from the optional
  // abbreviation lexicon (SPECIALIST LRABR, loaded with the UMLS store; migration 20261027), its senses
  // ranked by how well the CodeSystem names them. Lexicon strings are never shown.
  // 1.8.0 (eval v5 R3): when the resolved IG holds only an excerpt of a CodeSystem (e.g. TW Core 1.0.0
  // medication-nhi-tw: 35 codes) and another installed package holds a ≥10× larger copy of the same canonical,
  // that copy is searched unless package_id / version is given (warning + data.codesystem_copies; pinned calls
  // only get the warning); IG candidates carry `linked` codings of other systems (≤3, + linked_more), e.g. an NHI
  // drug's ATC code; a CodeSystem resolved from an id / alias outside the default IG's closure (TWPAS
  // nhi-medication) is searched where it was found (was: no candidates).
  fhir_normalize_code: "1.8.0",
  fhir_get_resource_skeleton: "1.2.1",
  // 1.3.0: validation issues carry `suggestions` / `caused_by` (as fhir_validate_resource 1.6.0).
  // 1.3.1: validation as fhir_validate_resource 1.6.1 (unknown hl7.org/fhir code systems, reference whitespace,
  //   RxNorm different-drug displays, lookup-failure / crash issues).
  fhir_finalize_resource: "1.3.1",
  // 1.0.0 (ISSUES_v9 R1): deterministic Bundle finalizer — fullUrl-uuid / reference-rewire / resource-id (mandatory),
  // bundle-type / document-order (profile-driven); UUID v5 seeded by (resourceType, original fullUrl, resource.id, entry
  // index) + a content salt; references found through StructureDefinition snapshots; duplicates / ambiguity reported.
  fhir_finalize_bundle: "1.0.0",
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
  // 1.3.0 (2026-10-20): analyte families — the terms of one analyte the query cannot tell apart (same words
  // matched; specimen / unit / method variants) are ordered by COMMON_TEST_RANK instead of vector noise, the
  // most common terms of every pooled analyte join the pool, a stronger usage prior, panels / ratios sink unless
  // asked for; analyte synonyms from RELATEDNAMES2 + the zh-CN linguistic variant (loinc.component_names,
  // migration 20261025 + LOINC re-import; neutral before) match the query.
  // 1.4.0: axis constraints — specimen / timing / method / property / scale words in the query
  // ("venous", "salivary", "CSF", "24 hour", "random", "dipstick", "HPLC", "%", "titer") are read from LOINC's
  // own part names (loinc.axis_names: Part.csv part + display names, RELATEDNAMES2 synonyms; migration 20261026
  // + LOINC re-import; neutral before); within an analyte family the terms honouring them come before the most
  // common term, and each analyte's most common terms with that specimen / timing join the pool. Also: the plain
  // analyte of a challenge variant joins the pool ("Renin^baseline" → Renin), a name of an analyte no longer
  // matches its ratios unless the query asks for a ratio / %, and the semantic guard never displaces the top two.
  search_loinc: "1.4.0",
  query_loinc: "1.1.1",
  interpret_lab_result: "1.1.1",
  batch_interpret_lab_results: "1.1.1",
  // SNOMED: not-found hint; get_snomed_relationships flags an unknown concept (concept_found:false); mapping hints.
  // search_snomed_concept 1.2.0 (2026-10-19): hybrid ranking over every active name of a concept (was RRF whose
  // row LIMIT before the per-concept collapse could return fewer concepts than asked); inactive concepts sink.
  // 1.3.0: hierarchy_filter over a hierarchy of more than 1,000 concepts takes the vector half from the
  // HNSW walk filtered by membership (snomed.concept_ancestors), bounded — was an exact scan of every
  // member's vector (40–130 s cold); a query far from such a hierarchy can now return fewer results.
  search_snomed_concept: "1.3.0",
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
  // 1.2.0 (ISSUES_v9 R3): shares the Bundle finalizer — invalid fullUrls are normalised, keys become deterministic UUID v5
  // fullUrls (same input → same Bundle), references written as key / urn:uuid:<key> / Type/<key> are rewired instead of
  // listed as unresolved; data adds changes / notes / contextId, unresolved rows carry path + candidates; provenance set.
  fhir_build_bundle: "1.2.0",
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
