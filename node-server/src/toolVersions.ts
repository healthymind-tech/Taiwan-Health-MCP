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
  // 1.6.0 (ISSUES_v15.2 R1 / R3): `system` = IG CodeSystem — an excerpt CodeSystem is searched in its fuller installed copy
  //   (as fhir_normalize_code; data.searched_copy + warning); every result carries `system`, `linked` and
  //   `accepted_by_validator` (+ `reason`) for the package the CodeSystem resolves in; accepted results related to the best
  //   match come first; data.alternatives = accepted codings of other systems the best matches link to (e.g. ATC).
  search_medical_codes: "1.6.0",
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
  // 1.4.1: bundle_rules.bundle_type names fhir_finalize_bundle's bundle_type argument (sets a free type; cannot override a fixed one).
  // 1.4.2 (ISSUES_v16.2 R1): a short artifact id that is not in the IG itself resolves in its dependency packages (one distinct canonical; otherwise not found / AMBIGUOUS_ARTIFACT with the candidates) — previously ARTIFACT_NOT_FOUND.
  fhir_get_profile_required_elements: "1.4.2",
  // 1.1.0 (lexicon tw-lexicon 0.3.0, issues v1): time-only evidence takes the date in force at its line;
  // whole-label stated-absent concepts (出生地 is not the birth date) and no stated-absent when the record states
  // the patient field; zh/en department / setting aliases with whole-token short forms (ED / ER / OPD / ICU);
  // the 【轉換目標】 line never joins another line's window; zh->en bridges for Chinese-only NHI displays.
  // 1.2.0 (lexicon tw-lexicon 0.4.0, issues v2): an as-needed Timing (code PRN, or text such as 'as needed' /
  // 需要時使用) is grounded by any PRN phrasing in the record ('PO PRN', '視需要'); a frequency written with it must
  // still match. New PRN phrasings 視需要 / 發作時 / as required / when needed / on demand (asNeededBoolean too).
  // 1.3.0 (ISSUES_v17.2): values the IG defines are never record facts — fixed / pattern of the declared profiles, every
  // ig-constant fhir_get_minimal_skeleton lists (also those of the profiles the IG's examples use for an administrative
  // entity in the Bundle: the payer agency's name / OID) and the answer literals the profiles' invariants allow for value[x]
  // (pat-ast-value 'class1') are exempt from G-UNGROUNDED / G-CONTEXT-* / G-STATED-ABSENT wherever they appear (summary.exempt);
  // a dose / frequency evidence quote cut from a record line listing several medicines is judged on the segment from the
  // medicine named before it (no G-CONTEXT-LABEL when that is this resource's medicine).
  // 1.4.0 (ISSUES_v17.4): the IG-defined exemption (igBlueprint/igValues.ts) is narrowed: profile fixed / pattern values, invariant answer literals and the example identity (name / identifier …) of a national payer / authority organization (igBlueprint/nationalOrgs.ts: an Organization profile whose type is pinned to govt / pay / ins, or the only target of the IG's payor / insurer / payer / authority references — TWPAS Coverage.payor / ClaimResponse.insurer -> Organization-govt-twcore); an example hospital / clinic / lab / practitioner / patient value is no longer exempt (reported when the record names another), as fhir_get_minimal_skeleton 1.6.0.
  // 1.5.0 (ISSUES_v20 R6): record labels and coded names matched through the data-derived abbreviation thesaurus (fhir.term_thesaurus + fhir.abbreviation_lexicon via the terminology provider: PEFR ↔ LOINC short name PEF — no G-CONTEXT-LABEL / weak coding when both abbreviate the same term); the end of a date range written with a dash after a full date (114/06/02–115/08/31, 114/06/02 08:00-115/08/31) is read as a date. Output for inputs without such abbreviations / ranges unchanged.
  // 1.6.0 (ISSUES_v20.1, with source_text only): every content finding (grounding G-* + record checks) carries `gate: blocking | advisory` (recordChecks/contentGates.ts registry; severity unchanged); the evaluator's false positives — ROC year-months (113/08, 民國113年8月) are dates, a UCUM bracket unit is the unit inside ([IU]/mL = IU/mL, not uIU/mL), a hyphenated analyte name before a full-width colon is no time of day (CA 15-3：12.4), an unlabelled name + sex line (張淑芬，女) is the identity line, a 【診斷】 heading without a colon opens the diagnosis slot, abbreviations come from the bundled LRABR file when the database has no fhir.abbreviation_lexicon (PEFR ~ PEF). Output without source_text unchanged.
  // 1.7.0 (v20.2): gates as fhir_validate_bundle 1.35.0 (advisory → warning + advisory_from; valid / groundingValid from blocking only).
  fhir_check_grounding: "1.7.0",
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
  // 1.8.0 (ISSUES_v10 B + document Bundle.type): `normalized_bundle` keeps every number as the caller wrote it (10.0, 1e3,
  //   0.50, integers beyond 2^53 — losslessJson.ts / requestContext.ts; the request text is re-read losslessly for the
  //   `bundle` argument on /mcp, POST /tools and the admin playground). bdl-11 / bdl-12 (and the document-only bdl-9 /
  //   bdl-10) on a Bundle with no Composition / MessageHeader at all carry suggestions (fhirSuggestions/bundleType.ts):
  //   `replace_value` Bundle.type → a type the entries support (collection; transaction / batch with requests; searchset),
  //   confidence by that evidence, never a type the profile fixes; `add_resource` the head resource as entry[0] with its
  //   required elements. Issue set, severities, messages and valid unchanged.
  //   Same release, binding-aware suggestions (ISSUES_v10 A): replace_system when the code belongs to another
  //   CodeSystem of the bound ValueSet; replace_coding / replace_system from the bound ValueSets for an unknown
  //   Coding.system; small ValueSets (≤ 50) always listed, semantic ranking of ≤ 12-code sets, move_value to a
  //   sibling element that accepts the value; lookup budget 1 call per issue (expansion unbudgeted).
  // 1.9.0 (evaluation v13, validator v13): an IG ValueSet canonical written as Coding.system (CodeableConcept codings and
  //   Codings that are not directly bound) is the error "The Coding references a value set, not a code system"
  //   (Terminology_TX_System_ValueSet2) when the validated resource / Bundle checks a binding to that ValueSet or to one
  //   including it — validator_cli 7.0.1 / 7.0.3 report it once their run has loaded the ValueSet (order-dependent; we
  //   apply it order-independently); otherwise the UNKNOWN_CODESYSTEM warning stays (as the CLI, also batched). HL7 / THO
  //   ValueSets unchanged (error everywhere); directly bound Codings unchanged. Its suggestions normalise the code within
  //   that ValueSet and its CodeSystems (replace_coding) and list its CodeSystems (replace_system). LOINC `=` / `in`
  //   property filters (CLASSTYPE, CLASS, STATUS, SCALE_TYP … incl. LOINC part codes as values) decide ValueSet membership
  //   (was: undecidable) — "could not be confirmed" information on LOINC codes disappears for members.
  // 1.10.0 (ISSUES_v14): new `repair` ("ids" default | "content"), used with normalize_ids=true: "content" first applies
  //   fhir_finalize_bundle's content repairs (fhirRepair: same-concept displays, UCUM, ROC dates, Coding.system, lossless
  //   shapes, bound code spellings; each verified not to add an error) and validates the result; data gains `repair`,
  //   `content_changes`, `repair_issues`, and an issue at a declined value carries `repair` {rule, message, candidates}.
  //   Default (repair "ids" / normalize_ids false) output unchanged.
  // 1.11.0 (ISSUES_v15): record checks (ISSUES_v15, recordChecks/: a post-validation layer, InstanceValidator unchanged) — issues with source "record-checks", a stable code and evidence are appended
  //   to entries[i].issues / issues and make `valid` false when error: information-absent (R1: a value that describes the
  //   absence of the information — 未取號 / 不詳 / unknown / pending …) and identifier-format (R2: ROC national ID / resident
  //   certificate format + check digit by system, site_config `identifier-format` rules, sentence-like identifiers) always;
  //   with source_text also insufficient-precision / incomplete-value (R3) and unconfirmed-as-confirmed /
  //   symptom-for-unconfirmed-diagnosis (R4). data.record_checks {ok, errors, warnings, rules, source_text} and provenance
  //   recordChecksVersion / recordChecksLexicon(Sha256) appear when source_text is given or a finding exists; without
  //   source_text and without findings the output is byte-identical to 1.10.0.
  // 1.11.1 (v14.1 (ISSUES_v14_1, fhirRepair/; patch on top of the ISSUES_v15 bump)): with normalize_ids + repair="content" the content repairs follow
  //   fhir_finalize_bundle 1.3.1 (new rules, Bundle-level verification). Default output unchanged.
  // 1.11.2 (v14.1, evaluator decisions 2026-10-25: (a) a system correction is kept when the only new error is the
  //   display check of that same Coding (an exposed error; the display stays reported with candidates); (b) a Quantity
  //   whose profile allows exactly one unit gets it — LOINC code without unit, or a value without code / unit —
  //   recorded in changes (rule ucum, reason "the profile allows only <unit>").
  // 1.12.0 (ISSUES_v15.1, recordChecks 1.1.0 / lexicon 1.1.0): with source_text the record checks also ground every
  //   Identifier.value, date / dateTime / instant and Quantity.value in the record (R5, new code ungrounded-value:
  //   normalised matches — ROC, full-width, separators, units — or derivations: 入院第N天 / POD#N / N天前 / durations / ages /
  //   BMI / explicit products; a record date + a filled-in T00:00:00 is an error; record-keeping times warn), report values of
  //   another time point / event / field (new code value-from-other-event), identifiers with a system but no value and
  //   stated absences (病歷號：申請中, 採檢日期：無法辨識, 處方：待確認) as information-absent, and check the record's PRIMARY
  //   diagnosis slot (unestablished / differential / "no diagnosis until …" → unconfirmed-as-confirmed error, incl. symptom
  //   codes and code.text copying the list; no diagnosis at all → information-absent); cues are bracket-scoped
  //   (「Elevated PSA（未確立惡性腫瘤）」 no longer flags Elevated PSA). Without source_text the output is unchanged.
  // 1.13.0 (ISSUES_v15.1 R6, recordChecks/dateSuggestions.ts): an ungrounded date whose month / day the record states with another year (a wrong ROC ↔ Gregorian conversion: 民國92年8月25日 → 1983-08-25; +1900 / +1910 / +1912 / the ROC year as Gregorian; or a Gregorian record date) gets the record's date as a replace_value suggestion (patch {op: replace, path, value}; reason quotes the record and the rule 民國 N 年 = 西元 N+1911; one candidate 0.95, several all listed); severity unchanged, never applied — on record-check ungrounded-value issues and on the G-UNGROUNDED / G-VALUE-MISMATCH grounding issues this tool returns (fhir_check_grounding itself unchanged).
  // 1.14.0 (ISSUES_v15.2): (R2) Unknown-code suggestions for IG CodeSystems pass a relatedness gate (same linked code, a
  //   shared rare word, same strength — conceptSearch/related.ts): unrelated codes of an excerpt are no longer proposed (none
  //   rather than an unrelated one); near codes only for codes no installed copy defines; (R3) a code defined only in a
  //   fuller installed copy gets its linked coding of another system that the validator accepts and a bound ValueSet /
  //   coding slice includes as `replace_coding` (patch replaces the Coding; CodeableConcept.text kept) or `remove_coding`
  //   when the CodeableConcept already carries it; (parity) WHO ATC codes are checked against the bundled tx.fhir.org
  //   table — a code ATC 2026 lacks is validator_cli's "Unknown code '…' in the CodeSystem 'http://www.whocc.no/atc'
  //   version '2026'" error, a display is checked when TW Core's ValueSet display is the server's (else unchanged).
  // 1.14.1 (ISSUES_v15.2.1): the R3 alternative coding also for a resource that declares no profile (no meta.profile): the
  //   element's binding is read from the IG's profile(s) of that resource type (the closure package owning the Coding's
  //   CodeSystem, else the validated / default IG; one profile, or several that bind the element the same way — else none);
  //   the reason names the profile ("… because the resource declares no profile"). Validation itself is unchanged.
  // 1.15.0 (ISSUES_v15.3, recordChecks 1.2.0 / lexicon 1.2.0): (R1) information-absent also for text fields — CodeableConcept.text without coding or with placeholder codings only (no code, NullFlavor / data-absent-reason, an absence word as the code), Dosage.text of medication resources, Observation.valueString / note when the code needs a quantitative result (recordChecks/quantitative.ts: LOINC SCALE_TYP Qn / quantity PROPERTY from loinc.concepts via the terminology provider, the LOINC name, vital-sign codes, a vital-signs profile / category, a referenceRange, a sibling valueQuantity) — the whole value must be an absence / pending / not-determined / not-established / being-redrawn statement (暫不下診斷, 待 CT 報告, 未定, 重抽中, 報告未出, pending, to be determined; specimen problems 溶血 / QNS / see report count only in such a result slot); (R2) the primary Condition (Encounter.diagnosis rank / first non-comorbidity entry → category encounter-diagnosis → the only non-comorbidity Condition) written as provisional / differential / unconfirmed or text-only while no primary slot of the record is established and the record says so explicitly → information-absent 「病歷沒有確立的主診斷」 (hedged slots and secondary r/o differentials never); (R3) the G-UNGROUNDED / G-VALUE-MISMATCH grounding issues this tool returns on a coded element say what was compared (the code's text / displays / terminology names vs the record lines), carry closest_record_phrase {text, similarity, section} and grounding_code_check, and are warnings (downgraded_from: "error") unless the primary Condition's code is unrelated to every record phrase (< 0.25) while the record's diagnosis slot names something else comparable (recordChecks/codeGrounding.ts); entries[i].valid / groundingValid / valid / grounding counts recomputed after a downgrade; fhir_check_grounding itself unchanged; data.record_checks.grounding_codes. Without source_text and without findings the output is unchanged.
  // 1.15.1 (ISSUES_v15.3 R3 follow-up, grounding/snomedChinese.ts): the coded-element grounding annotation (R3) also compares a SNOMED code's Chinese names —
  //   IG designations / Chinese ValueSet displays (0.9 / 0.85), the SNOMED → ICD-10 map (group 1, highest-priority
  //   unconditional rule) → ICD-10-CM Chinese name (0.75 / 0.65 child or after conditional rules / 0.6 category), the mined
  //   bilingual thesaurus over the English names (0.8 × coverage × weakest Dice, ≥ 80 % of the words) — so a SNOMED
  //   primary diagnosis unrelated to every name while a Chinese diagnosis slot names something else is "contradicted"
  //   (error) instead of "uncertain": names ≥ 0.6 make the slot comparable; unrelated = < 0.25 to every English / Chinese
  //   name and to every Chinese name of the mapped ICD 3-character category (< 0.15 when only ICD-derived names make it
  //   comparable); a slot ICD code of the mapped category is never different. compared.chinese_names lists them.
  //   fhir_check_grounding unchanged.
  // 1.16.0 (ISSUES_v15.4, recordChecks 1.3.0 / lexicon 1.3.0): (R1) information-absent for EMPTY SHELLS — an Observation
  //   without value[x] / component values (panels with hasMember excluded; or only a valueString that is an absence
  //   statement, a bracketed reference range / detection limit not counting as a result: 「檢體溶血，未發報 (< 14)」), a
  //   MedicationRequest / MedicationStatement without structured dose or timing (doseAndRate / timing.repeat / timing.code),
  //   a Condition without a real coding — whose side fields (dataAbsentReason code + text, note, narrative, valueString,
  //   dosage text / patientInstruction / additionalInstruction, statusReason, code.text) carry an absence clause (dominance
  //   rule, clause by clause; (R2) predicate classes pending-result / rejected-specimen / machine-error / undecided /
  //   indistinguishable / conditional-on-future-result / not-done, lexicon ABSENCE_CLASSES). (R3) error only with
  //   source_text when the record's statement about THIS item (located by its names, the diagnosis slot, or the side text
  //   itself) says the information is absent — message 「這筆資源沒有提供病歷中應有的值；病歷寫的是「…」」 + 「…不要建立空的資源」;
  //   the record says not done → warning; not confirmed → warning; no source_text → warning only when the side text is
  //   itself an absence statement (a dataAbsentReason code alone / not-done → nothing); entered-in-error never, cancelled /
  //   not-taken warning at most. dataAbsentReason is no longer a value slot of R1 (its text is a side field). The v15.3
  //   result-slot note rule skips cancelled / entered-in-error Observations and not-done notes. Diagnosis slots whose
  //   candidates cannot be told apart (尚難區分, cannot differentiate) are unestablished. Without source_text and without
  //   findings the output is unchanged.
  // 1.16.1 (SNOMED Chinese-name verification fixes): (R3, grounding/snomedChinese.ts + codeGrounding.ts) the SNOMED Chinese-name comparison is hardened: ICD Chinese names keep complete noun phrases only (qualifier prefixes such as 其他或未明示之 removed whole, names starting with a function word / bound morpheme and one-character-truncated tails rejected; mined thesaurus pieces trimmed and, unless every piece occurs in an ICD Chinese name of the concept, capped at 0.55 — never comparable); a hierarchy guard: a diagnosis-slot item whose SNOMED concept (from its ICD-10 code via the reverse snomed.icd10_map, or its exact ICD Chinese name) is the coded concept, an ancestor or a descendant of it (snomed.concept_ancestors) is never "something else" (LRTI vs 社區型肺炎 (J18.9): warning); a Chinese item name with no exact ICD name relates through its head-final tail (社區型肺炎 → 肺炎), only to that concept or its ancestors; abbreviation-only slot items are judged on the record's casing; the IG designation table loads in one cheap query (Chinese-language packages only, ~0.6 s), single-flight, refreshed in the background, warmed at startup — a call during the first load waits ≤ 2 s, then runs without IG names with every Chinese name capped below comparability (warning, never a new error); the v15.3 result-slot note rule (an Observation with no value[x] whose note says there is no result while its code needs a quantitative one) is a WARNING without source_text (was an error; consistent with the v15.4 empty-shell rule), still an error with it.
  // 1.17.0 (ISSUES_v16 R3): slice / profile-match explanations (fhirSuggestions/slices.ts, fhirSliceMatch.ts): "does not match any known slice … CLOSED", "Slice 'X': a matching slice is required" and "Unable to find a profile match" issues carry slice_match / profile_match {closest slice / profile, failed discriminators (meta.profile missing / misspelled / other version / a string / another profile, resourceType, fixed / pattern value, required binding), blocking: the ≤ 5 errors of the target against the closest profile (own errors, else a budgeted stand-alone validation, ≤ 12 per call), hint} and set_profile / add_resource suggestions; additive only (issue set, severities, messages, valid unchanged).
  // 1.18.0 (ISSUES_v16.1 R2 / R3): slice_match carries `options` (every allowed slice — max ≠ 0 — with what its
  //   discriminators require) when no slice is close or several are about as close, and `literals`; a fixed / pattern
  //   value that looks like a placeholder (NNxxx, *, <…>) is marked "literal value required by the IG; copy as is" in
  //   failure details and hints. Issue set, severities, messages, valid unchanged.
  // 1.19.0 (ISSUES_v16.2 R3, fhirSuggestions/invariants.ts): a failed profile invariant (`Constraint failed: <key>`)
  //   carries `invariant`: {key, need all | one_of, applies_because (the guard of `guard implies …`), failed: the false
  //   parts with the missing path and — for an extension test — its url, value type and the JSON to write, hint}; also
  //   on the failed-invariant `blocking` errors of slice_match / profile_match (in a Bundle a broken rule of an entry is
  //   often reported only there). Issue set, severities, messages, valid unchanged.
  // 1.20.0: R6 content coverage (ISSUES_v17 R2, recordChecks/coverage.ts; with source_text): negated-item-present (error — an item the record says was not prescribed / not done / cancelled / stopped / denied / is to be scheduled, or the conversion target excludes, present as done / active), duplicate-entry (error — same content apart from ids, or the same thing), text-only-fact (warning, content_checks_severity="error" makes it an error — dose / frequency / route / supply duration only in Dosage.text); new argument content_checks_severity.
  // 1.20.0 also: (v17 R3) invariant explanations recurse into a failing nested rule (`guard implies (a or b)` inside an and-chain: pat-ast-value) and name required values / codes (`x = 'v'`, `x.exists(coding.code = 'v')`).
  // 1.20.0 also: (v17 R2-2) record-fact-missing (warning; content_checks_severity="error" makes it an error) — a fact the record states clearly (department → Encounter.serviceType, a stated / hedged diagnosis → verificationStatus, H / L flags or a stated reference range → interpretation, a discharge-medication header → MedicationRequest.category, 共 28 天 → expectedSupplyDuration, dose / frequency / route on the drug's line, the patient's name) for an element the declared profile marks mustSupport / required or its examples commonly carry (H / L flags: wherever the profile allows interpretation), left empty.
  // 1.20.0 also: (v17 R1 IG self-check) validator — a `type` discriminator with a path (Bundle.entry sliced by type:resource) is matched on the type of the element the path names (entry:x.resource; through resolve(): the target profiles' types), not the sliced element's BackboneElement (every entry was "missing" its slice); an embedded resource whose element lists several type profiles conforms when it meets one of them (the closest one's issues otherwise).
  // 1.20.0 also: (robustness audit) source_text limited to 200,000 characters; site_config timezone / identifier-format lines and the absence-label scan no longer backtrack on long whitespace / label runs; record line lookup by binary search.
  // 1.21.0 (ISSUES_v17.2, with source_text): grounding (fhir_check_grounding 1.3.0) and the record checks (1.4.1: ungrounded-value, information-absent, value-from-other-event, incomplete-value, insufficient-precision) exempt the values the IG defines — fixed / pattern, skeleton ig-constants (the payer agency's name / OID), invariant answer literals for value[x]; medication evidence quotes from several-medicine lines are no longer G-CONTEXT-LABEL.
  // 1.22.0: IG known defects (v17.3, igKnownDefects.ts): an error the IG's own examples of the profile also have (every example fails the same structural rule — ig_selfcheck job) gets `ig_known_defect` {profile, element, examples, failing, total, advice} and a message note naming the optional entry and where its information goes (a CodeableConcept of another entry's profile bound to the same ValueSet); severity / issue set / valid unchanged; suggestions: STU3 renames (rename_property 0.97 / remove_property with the R4 way).
  // 1.22.0 also (ISSUES_v17.4, record checks 1.5.0): stale-value (a value the record states only in clauses marking it old / not applicable / pending) and unconfirmed-as-confirmed for not-established text in diagnosis / required CodeableConcepts.
  // 1.23.0: validator_cli parity on document Bundles (ISSUES_v17.5, IPS): every unresolved reference of a document / message entry is an error on the Bundle ('Can't find … in the bundle (<path>)', with the fullUrl near-miss note); local narrative links that resolve to no anchor are errors (and so fail profile / slice matching); a uri written `url|version` must resolve that version; a coding bound to an enumerated ValueSet in a non-English resource (language zh-TW …) needs the ValueSet's display (SNOMED CT / LOINC); LOINC displays follow the reference server's release (bundled loinc-tx-display, LOINC 2.83) while the local LOINC is older.
  // 1.24.0: validator parity v1 (ported from validator_cli 7.0.1 source): new argument bundle_profile (as -profile); parser stage rules (ele-1 after unknown / wrong-shaped properties are dropped, a choice type the base does not allow is an Unrecognized property, HL7 JSON shape messages); Extension_PROF_Type / Extension_EXT_Type with the value validated as the profile's type; UNABLE_TO_INFER_CODESYSTEM + NoValid_16 for required code bindings; checkFixedValue (_DT_Fixed_Wrong, TYPE_CHECKS_PATTERN_CC …); a member with a wrong display fails a required binding (Confirm_4a / NoValid_1_CC); a multi-type choice merges the actual type's children; profile matching ignores parser errors; the same rule from another profile is kept (dedupe by full message); a document whose first entry is not a Composition reports it and still checks reachability.
  // --- v19 R3 (fhirSuggestions/pointers.ts, jsonPatch.ts) ---
  // 1.25.0 (ISSUES_v19 R3): every issue carries `pointer` (RFC 6901 JSON Pointer into the Bundle AS SENT; a missing element →
  //   the nearest existing ancestor, `pointer_kind`: element | ancestor; normalize_ids' document reorder mapped back through
  //   the finalizer's entry permutation and checked by fullUrl) and every error with a fix `patches`: [{ops (RFC 6902, pointers
  //   into the sent Bundle), reason, kind, confidence}] from suggestions[].patch, shape fixes (wrap / unwrap array, empty / null
  //   values, profile-fixed strings), fixes of related issues (a renamed / moved property that supplies a required element,
  //   ele-1 on an object of unrecognised properties, slice / profile matches blocked only by fixable errors) and slice
  //   discriminator values; each candidate verified to apply to a copy of the sent Bundle. entries[i].pointer = /entry/<sent
  //   index>. replace_fullurl candidates include the references that name the fullUrl. Default-mode ID suggestions on a
  //   reordered document name the sent entry positions (were the finalizer's output positions). Issue set, severities,
  //   messages, path, suggestions and valid unchanged.
  // --- end v19 R3 ---
  // 1.26.0 (ISSUES_v19 R1 round 2): the shared content repairs of fhir_finalize_bundle 1.15.0 (Composition.class → category, performer.reference → performer.actor.reference, STU3 duplicates of a value the R4 element holds removed, a code element written as a CodeableConcept whose system is the THO / core twin of the ValueSet's CodeSystem) (normalize_ids + repair="content"); suggestions as fhir_validate_resource 1.23.0 (Composition.class → category).
  // 1.27.0 (v18 R1 / parity v2, officialValidator.ts): when a resident official HL7 validator serves the package (OFFICIAL_VALIDATOR_URLS), structure / slicing / profile / invariant / document / terminology issues are its OperationOutcome (data.source "hl7-validator_cli-7.0.1", data.engine "hl7-official"; "mcp-fallback" + a warning when it is unavailable); MCP adds suggestions, slice_match, pointers / patches and content checks only. Without one, output unchanged. Record checks without source_text are warnings only (content errors need the record).
  // 1.28.0 (release v1): official engine — terminology-server failures in data.unverified (not errors; checked_fully false; the validator is restarted to drop the cached failure), official_verdict / fallback_reason, a fallback is never checked_fully; reachable / Can't find issues carry location_path (validator_cli's off-by-one entry index) and their pointer / entry follow it.
  // 1.28.0 also (release v1): normalize_ids + repair="content" — the shared content repairs of fhir_finalize_bundle 1.17.0
  //   (a required coding slice is not added next to a coding of its system with another code: reported instead).
  //   Default output unchanged.
  // 1.29.0 (ISSUES_v17.4, with source_text): grounding (fhir_check_grounding 1.4.0) and the record checks — the IG-defined exemption (igBlueprint/igValues.ts) is narrowed: profile fixed / pattern values, invariant answer literals and the example identity (name / identifier …) of a national payer / authority organization (igBlueprint/nationalOrgs.ts: an Organization profile whose type is pinned to govt / pay / ins, or the only target of the IG's payor / insurer / payer / authority references — TWPAS Coverage.payor / ClaimResponse.insurer -> Organization-govt-twcore); an example hospital / clinic / lab / practitioner / patient value is no longer exempt (reported when the record names another), as fhir_get_minimal_skeleton 1.6.0. Output without source_text unchanged.
  // 1.30.0 (release v1): a failed invariant (official or built-in) carries `invariant.expression` / `human` / `literals` (systems, code candidates with displays, values, formats) and, for a coding the rule is about, replace_code / replace_system suggestions → JSON patches; cascades (profile match, entry / reference slices) carry caused_by and `root_causes`.
  // 1.31.0 (ISSUES_v20 R5, with source_text only): content coverage (recordChecks/coverage.ts) counts the record-derivable facts (recordDerivable.ts) as record facts — a missing Condition.verificationStatus (the diagnosis field: plain → confirmed, hedged → provisional, r/o → differential, via the diagnosis-slot parser), Observation.interpretation (H / L / HH / LL / ↑ / ↓ / * flag after the value, or the record's / resource's reference range: outside → H / L, inside → N, * alone → A) and MedicationRequest.category (出院帶藥 / 門診處方 / 住院醫囑 heading, else the record's single visit setting) is a record-fact-missing finding (severity per content_checks_severity) wherever the declared profile has the element (any cardinality, before: mustSupport only) and its binding holds the code (an IG ValueSet: the code whose display names the meaning; profileElementUse now carries those bindings). Output without source_text unchanged.
  // 1.32.0 (ISSUES_v20, with source_text): R2 code meaning — a coding whose official names (terminology tables, never the model's display) are unrelated to the record phrase it stands for (CodeableConcept.text / model display stated in the record, the label before an Observation value) is `code-meaning-mismatch` (error, rule R7, record_phrase / code_display, replace_code suggestions) only when fhir_normalize_code for the phrase (the coding's system) does not return the code and returns one naming the phrase; R3 `identifier-truncated` (error, replace_value with the full record fragment: 醫字第035190號, not 035190) unless the profile restricts the value to digits; R6 false positives — record labels matched to code names through the data-derived abbreviation thesaurus (PEFR ↔ PEF), both ends of ROC date ranges (114/06/02–115/08/31, with times), no AllergyIntolerance inactive suggestion from medication-stop words (停藥). Output without source_text unchanged.
  // 1.33.0 (v20.1 code meaning / invariant patches — code-meaning-mismatch (with source_text) carries `gate: "advisory"`; fewer false positives: a value label counts only when every occurrence of the value has one and it names no other coding with the same value (ALT vs 「BMI 24」), and the resource's own stated text does not already agree; generic / document / panel / class-word codes (Diagnostic imaging study, notes, panels) are never judged by similarity; new instrument tier (the item names an instrument / score acronym the code does not — ECOG vs NYHA / KPS) and timing tier (AC / 空腹 / fasting vs PC / 飯後 / post meal vs random, from the LOINC component / long name), reported only when a candidate of the record's instrument / timing exists. Failed-invariant replace_code patches also set the new code's display (patch ops: replace code + replace / add display, or remove a stale display), an accepted code under another / no system gets the rule's system (+ the display when missing), and an Identifier.system literal the rule tests (identifier.where(system = 'S')) is proposed for the identifier whose type code the rule accepts when exactly one system is accepted.)
  // 1.34.0 (ISSUES_v20.1, with source_text only): every content finding (grounding G-* + record checks) carries `gate: blocking | advisory` (recordChecks/contentGates.ts registry; severity unchanged); unconfirmed-as-confirmed fires for CODED Conditions (terminology names incl. Chinese ones matched with the diagnosis items; cancer ~ malignant neoplasm; an r/o item counts even when another item of the slot is established) and 疑 / 疑似 / 待確認 / suspected / provisional in the diagnosis slot is an error (可能 / possible stays a warning); new advisory warning generic-code-for-unknown-item (a Hormone therapy / Chemotherapy class code while the record says the drug name is unknown); the evaluator's false positives — ROC year-months (113/08, 民國113年8月) are dates, a UCUM bracket unit is the unit inside ([IU]/mL = IU/mL, not uIU/mL), a hyphenated analyte name before a full-width colon is no time of day (CA 15-3：12.4), an unlabelled name + sex line (張淑芬，女) is the identity line, a 【診斷】 heading without a colon opens the diagnosis slot, abbreviations come from the bundled LRABR file when the database has no fhir.abbreviation_lexicon (PEFR ~ PEF), a stop cue (停藥 / 暫停) is about a medicine only (no status change for a body-weight Observation), an item any conversion-target line includes is never excluded by another. Output without source_text unchanged.
  // 1.35.0 (v20.2, with source_text): advisory content findings inform only — severity warning with advisory_from, valid / entries[].valid only from validator + blocking errors, no remove suggestions / patches; G-UNGROUNDED blocking only on structured numbers / dates / identifiers; unconfirmed-as-confirmed advisory. Official requests carry validationTimeout (a timed-out validation → unverified, checked_fully false).
  // 1.36.0 (parity v3 fhirpath): invariants evaluated as validator_cli does — FHIRPathExpressionFixer rewrites (txt-2 → htmlChecks2, ref-1 / bld-8 guards …), Java string functions / ofType / as / htmlChecks, %sct / %`vs-…` constants.
  // 1.37.0 (parity v3 slicing): InstanceValidator sliceMatches / matchSlice / checkCardinalities port (max 0 → empty, type / profile / exists / position clauses, unsupported patterns → SLICING_CANNOT_BE_EVALUATED, NotSlice with reasons, open-slicing hint, ordered slices, slice cardinality wording, versioned profile urls), multiple type profiles (NoMatch / MultipleMatches), entry multiple profiles (NO_MATCH / MULTIPLE_MATCHES), reference target choice (REF_MultipleMatches), unresolved entry profile errors.
  fhir_validate_bundle: "1.37.0",
  // 1.6.2: the binding-aware suggestions above (ISSUES_v10 A) also apply to single-resource validation.
  // 1.7.0: the validator v13 rules above (fhir_validate_bundle 1.9.0).
  // 1.8.0 (ISSUES_v15): the record checks of fhir_validate_bundle 1.11.0 on the resource (data.issues, data.record_checks).
  // 1.9.0 (ISSUES_v15.1): the record checks of fhir_validate_bundle 1.12.0 on the resource (output without source_text unchanged).
  // 1.10.0 (ISSUES_v15.1 R6, recordChecks/dateSuggestions.ts): an ungrounded date whose month / day the record states with another year (a wrong ROC ↔ Gregorian conversion: 民國92年8月25日 → 1983-08-25; +1900 / +1910 / +1912 / the ROC year as Gregorian; or a Gregorian record date) gets the record's date as a replace_value suggestion (patch {op: replace, path, value}; reason quotes the record and the rule 民國 N 年 = 西元 N+1911; one candidate 0.95, several all listed); severity unchanged, never applied — as fhir_validate_bundle 1.13.0.
  // 1.11.0 (ISSUES_v15.2): the suggestion and ATC rules of fhir_validate_bundle 1.14.0.
  // 1.11.1 (ISSUES_v15.2.1): the implicit-profile alternative-coding suggestions of fhir_validate_bundle 1.14.1 (a resource
  //   validated with neither meta.profile nor `profile`); validation unchanged.
  // 1.12.0 (ISSUES_v15.3): the record checks and the coded-element grounding annotation of fhir_validate_bundle 1.15.0.
  // 1.12.1 (ISSUES_v15.3 R3 follow-up, grounding/snomedChinese.ts): the Chinese-name comparison of fhir_validate_bundle 1.15.1 in the coded-element grounding annotation.
  // 1.13.0 (ISSUES_v15.4): the record checks of fhir_validate_bundle 1.16.0 (empty shells, absence predicate classes).
  // 1.13.1: the R3 and result-slot note changes of fhir_validate_bundle 1.16.1.
  // 1.14.0 (ISSUES_v16 R3): the slice / profile-match explanations of fhir_validate_bundle 1.17.0 (slice_match / profile_match, set_profile / add_resource).
  // 1.15.0: the slice_match options / literals of fhir_validate_bundle 1.18.0.
  // 1.16.0: the invariant explanations of fhir_validate_bundle 1.19.0.
  // 1.17.0: the R6 content coverage of fhir_validate_bundle 1.20.0 (content_checks_severity).
  // 1.18.0 (ISSUES_v17.2, with source_text): grounding (fhir_check_grounding 1.3.0) and the record checks (1.4.1: ungrounded-value, information-absent, value-from-other-event, incomplete-value, insufficient-precision) exempt the values the IG defines — fixed / pattern, skeleton ig-constants (the payer agency's name / OID), invariant answer literals for value[x]; medication evidence quotes from several-medicine lines are no longer G-CONTEXT-LABEL.
  // 1.19.0: as fhir_validate_bundle 1.22.0 (IG known defects (v17.3, igKnownDefects.ts); STU3 rename suggestions).
  // 1.20.0: validator_cli parity on document Bundles (ISSUES_v17.5, IPS): every unresolved reference of a document / message entry is an error on the Bundle ('Can't find … in the bundle (<path>)', with the fullUrl near-miss note); local narrative links that resolve to no anchor are errors (and so fail profile / slice matching); a uri written `url|version` must resolve that version; a coding bound to an enumerated ValueSet in a non-English resource (language zh-TW …) needs the ValueSet's display (SNOMED CT / LOINC); LOINC displays follow the reference server's release (bundled loinc-tx-display, LOINC 2.83) while the local LOINC is older.
  // 1.21.0: validation as fhir_validate_bundle 1.24.0 (all but bundle_profile: validator parity v1).
  // --- v19 R3 ---
  // 1.22.0 (ISSUES_v19 R3): `pointer` / `pointer_kind` / `patches` on the issues as fhir_validate_bundle 1.25.0 (pointers into the resource as sent).
  // --- end v19 R3 ---
  // 1.23.0 (ISSUES_v19 R1 round 2): the STU3 rename table (fhirR3Renames.ts) knows Composition.class → category: an "Unrecognized property 'class'" on a Composition gets that rename suggestion.
  // 1.24.0 (v18 R1 / parity v2, officialValidator.ts): when a resident official HL7 validator serves the package (OFFICIAL_VALIDATOR_URLS), structure / slicing / profile / invariant / document / terminology issues are its OperationOutcome (data.source "hl7-validator_cli-7.0.1", data.engine "hl7-official"; "mcp-fallback" + a warning when it is unavailable); MCP adds suggestions, slice_match, pointers / patches and content checks only. Without one, output unchanged. Record checks without source_text are warnings only (content errors need the record).
  // 1.25.0 (release v1): official engine — terminology-server failures in data.unverified (not errors; checked_fully false; the validator is restarted to drop the cached failure), official_verdict / fallback_reason, a fallback is never checked_fully; reachable / Can't find issues carry location_path (validator_cli's off-by-one entry index) and their pointer / entry follow it.
  // 1.26.0 (ISSUES_v17.4, with source_text): as fhir_validate_bundle 1.29.0 (narrowed IG-defined exemption).
  // 1.27.0 (release v1): a failed invariant (official or built-in) carries `invariant.expression` / `human` / `literals` (systems, code candidates with displays, values, formats) and, for a coding the rule is about, replace_code / replace_system suggestions → JSON patches; cascades (profile match, entry / reference slices) carry caused_by and `root_causes`.
  // 1.28.0 (ISSUES_v20 R5, with source_text only): the record-derivable content coverage of fhir_validate_bundle 1.31.0.
  // 1.29.0 (ISSUES_v20, with source_text): R2 code meaning — a coding whose official names (terminology tables, never the model's display) are unrelated to the record phrase it stands for (CodeableConcept.text / model display stated in the record, the label before an Observation value) is `code-meaning-mismatch` (error, rule R7, record_phrase / code_display, replace_code suggestions) only when fhir_normalize_code for the phrase (the coding's system) does not return the code and returns one naming the phrase; R3 `identifier-truncated` (error, replace_value with the full record fragment: 醫字第035190號, not 035190) unless the profile restricts the value to digits; R6 false positives — record labels matched to code names through the data-derived abbreviation thesaurus (PEFR ↔ PEF), both ends of ROC date ranges (114/06/02–115/08/31, with times), no AllergyIntolerance inactive suggestion from medication-stop words (停藥). Output without source_text unchanged.
  // 1.30.0 (v20.1 code meaning / invariant patches): as fhir_validate_bundle 1.33.0.
  // 1.31.0 (ISSUES_v20.1, with source_text only): the content checks of fhir_validate_bundle 1.34.0 (gate field, coded unconfirmed-as-confirmed, generic-code-for-unknown-item, false-positive fixes). Output without source_text unchanged.
  // 1.32.0 (v20.2): as fhir_validate_bundle 1.35.0.
  // 1.33.0 (parity v3 fhirpath): invariant evaluation as fhir_validate_bundle 1.36.0.
  // 1.34.0 (parity v3 slicing): as fhir_validate_bundle 1.37.0.
  fhir_validate_resource: "1.34.0",
  // 1.2.0 (all below): provenance.resolved_by / closure_versions; canonical arguments resolve to their
  // owning package when package_id is omitted; "|version" honoured; list/search: all_packages + zero-hit hint;
  // NO_DEFAULT_IG instead of an arbitrary package when no default IG is set.
  // 1.3.0 (fhir_list_igs / fhir_list_artifacts / fhir_search_artifacts / fhir_list_resource_profiles): opt-in
  // compact=true (id → title per type, canonical base once, only exceptional canonicals). Default output unchanged.
  // 1.4.0 (ISSUES_v17 R1-4, igDiscovery.ts): new `query` — a conversion target / IG name in any language or a short name → the matching installed IGs (title, bracketed short names, package-id segments, ImplementationGuide name / title / description; generic request words ignored), ranked, each with its Bundle profiles.
  fhir_list_igs: "1.4.0",
  fhir_get_ig: "1.2.1",
  fhir_list_artifacts: "1.3.0",
  fhir_search_artifacts: "1.3.0",
  fhir_list_resource_profiles: "1.3.0",
  fhir_rank_resource_profiles: "1.2.1",
  // 1.2.2 (ISSUES_v16.2 R1): a short artifact id that is not in the IG itself resolves in its dependency packages (one distinct canonical; otherwise not found / AMBIGUOUS_ARTIFACT with the candidates) — previously ARTIFACT_NOT_FOUND.
  fhir_get_profile: "1.2.2",
  // 1.2.2 (ISSUES_v16.2 R1): a short artifact id that is not in the IG itself resolves in its dependency packages (one distinct canonical; otherwise not found / AMBIGUOUS_ARTIFACT with the candidates) — previously ARTIFACT_NOT_FOUND.
  fhir_get_profile_elements: "1.2.2",
  // 1.2.2 (ISSUES_v16.2 R1): a short artifact id that is not in the IG itself resolves in its dependency packages (one distinct canonical; otherwise not found / AMBIGUOUS_ARTIFACT with the candidates) — previously ARTIFACT_NOT_FOUND.
  fhir_get_valueset: "1.2.2",
  // 1.2.2 (ISSUES_v16.2 R1): a short artifact id that is not in the IG itself resolves in its dependency packages (one distinct canonical; otherwise not found / AMBIGUOUS_ARTIFACT with the candidates) — previously ARTIFACT_NOT_FOUND.
  fhir_expand_valueset: "1.2.2",
  // 1.3.0: found:false adds `hint` (use fhir_normalize_code with the system) and `near_codes` (IG CodeSystems).
  // 1.3.2: RxNorm codes (http://www.nlm.nih.gov/research/umls/rxnorm) are looked up in rxnorm.concepts (was: not found).
  // 1.4.0 (ISSUES_v15.2 R1 / R3): `accepted_by_validator` (+ `reason`); a code missing from the package's excerpt but defined in a
  //   fuller installed copy gets `defined_in` {package, display}, the reason (fhir_validate_* reports Unknown code) and
  //   `alternatives` (its linked codings the validator accepts, e.g. ATC, with value_sets) instead of spelling-based near_codes;
  //   near_codes (only for codes no copy defines) carry accepted_by_validator.
  fhir_lookup_code: "1.4.0",
  // 1.3.0 (v13): LOINC `=` / `in` property filters decided from loinc.concepts (unverifiable → valid / invalid).
  fhir_validate_code: "1.3.0",
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
  // 1.9.0 (ISSUES_v15.2 R1 / R3): every candidate carries `accepted_by_validator` (+ `reason` when false), decided by the
  //   validator's own code check for the resolved package (codeAcceptance.ts) — fuller-copy codes outside the package's
  //   excerpt stay (they identify the concept) but are flagged false; when the best candidate is not accepted, accepted
  //   candidates related to it (same linked code / rare word / strength — conceptSearch/related.ts) move to the front
  //   (unrelated ones never), and data.alternatives lists the codings of other systems the best matches link to that the
  //   validator accepts ({system, code, display?, accepted_by_validator: true, reason, value_sets}; WHO ATC checked against
  //   the bundled tx.fhir.org table data/terminology/atc-tx-check.json.gz), with a warning naming them.
  // 1.10.0 (ISSUES_v16.1 R4): with value_set, SNOMED CT candidates are limited to the ValueSet's enumerated
  //   concepts as well as its is-a / descendent-of filters (an enumerated-only ValueSet such as a department list was
  //   searched over all of SNOMED CT); an include naming the whole system, or a filter that cannot be scoped, lifts it.
  fhir_normalize_code: "1.10.0",
  // 1.2.2 (ISSUES_v16.2 R1): a short artifact id that is not in the IG itself resolves in its dependency packages (one distinct canonical; otherwise not found / AMBIGUOUS_ARTIFACT with the candidates) — previously ARTIFACT_NOT_FOUND.
  fhir_get_resource_skeleton: "1.2.2",
  // 1.3.0: validation issues carry `suggestions` / `caused_by` (as fhir_validate_resource 1.6.0).
  // 1.3.1: validation as fhir_validate_resource 1.6.1 (unknown hl7.org/fhir code systems, reference whitespace,
  //   RxNorm different-drug displays, lookup-failure / crash issues).
  // 1.3.2 (ISSUES_v10 B): `resource` keeps the draft's number spellings (10.0 stays 10.0; values the tool wraps into a
  //   single-element array too). Same JSON value as 1.3.1.
  // 1.4.0 (authoring layer, A): slice-aware pinning — fixed / pattern values of slice members are pinned where the
  //   discriminators identify the member (bp component unit system / code, identifier slice system / use), `_slice` tags
  //   work at any depth and are always removed (unknown names reported, never left in the resource); still only where the
  //   draft has the parent node — nothing is invented. New description points to fhir_author_resources for values.
  // 1.5.0: validation as fhir_validate_resource 1.7.0 (bound IG ValueSet canonical as Coding.system → error, LOINC filters).
  // 1.6.0 (ISSUES_v14): new `repair` ("content" default | "ids" = 1.5.0) and `timezone`: the draft first gets the shared
  //   content repairs (fhirRepair, same rules as fhir_finalize_bundle 1.2.0), listed in data.changes; undecidable values in
  //   data.repair_issues (and on the validator issue as `repair`). Numbers keep their spelling (repair runs on the lossless draft).
  // 1.7.0 (ISSUES_v15): record checks (recordChecks/, as fhir_validate_resource 1.8.0) merged into data.validation
  //   (issues with source "record-checks"; an error makes validation.valid false); new optional `source_text` adds R3 / R4.
  //   Without source_text and without findings the output is unchanged. (If ISSUES_v14_1 bumps this tool too, the higher
  //   version carries both.)
  // 1.7.1 (v14.1 (ISSUES_v14_1, fhirRepair/; patch on top of the ISSUES_v15 bump)): the content repairs of fhir_finalize_bundle 1.3.1 (site timezone for
  //   date-times without an offset, rule timezone; UCUM equivalents / annotations / micro sign; quantity-code-not-ucum;
  //   ValueSet-named and renamed system URLs; wrapped Coding, code as CodeableConcept, choice / up moves; empty
  //   elements, rule empty; required fixed coding slices, rule fixed-slice). New optional `site_config` (a `timezone:`
  //   line is the site timezone when `timezone` is not passed); `timezone` also takes an IANA zone.
  // 1.7.2 (v14.1, evaluator decisions 2026-10-25: (a) a system correction is kept when the only new error is the
  //   display check of that same Coding (an exposed error; the display stays reported with candidates); (b) a Quantity
  //   whose profile allows exactly one unit gets it — LOINC code without unit, or a value without code / unit —
  //   recorded in changes (rule ucum, reason "the profile allows only <unit>").
  // 1.8.0 (ISSUES_v15.1): data.validation carries the record checks of fhir_validate_resource 1.9.0 when source_text is given
  //   (value grounding, primary diagnosis slot); output without source_text unchanged.
  // 1.8.1 (ISSUES_v15.1 R6, recordChecks/dateSuggestions.ts): an ungrounded date whose month / day the record states with another year (a wrong ROC ↔ Gregorian conversion: 民國92年8月25日 → 1983-08-25; +1900 / +1910 / +1912 / the ROC year as Gregorian; or a Gregorian record date) gets the record's date as a replace_value suggestion (patch {op: replace, path, value}; reason quotes the record and the rule 民國 N 年 = 西元 N+1911; one candidate 0.95, several all listed); severity unchanged, never applied — on the ungrounded-value date issues in data.validation.
  // 1.9.0 (ISSUES_v15.2 R4): content repair rule alt-coding (fhir_finalize_bundle 1.5.0); validation as fhir_validate_resource 1.11.0.
  // 1.9.1 (ISSUES_v15.2.1): repairs and validation as fhir_finalize_bundle 1.5.1 / fhir_validate_resource 1.11.1 (the
  //   implicit-profile binding never applies here in practice: the `profile` argument is a declared profile).
  // 1.10.0 (ISSUES_v15.3): data.validation carries the record checks of fhir_validate_resource 1.12.0 (R1 text fields /
  //   quantitative result slots always; R2 provisional primary diagnosis with source_text); output otherwise unchanged.
  // 1.10.1 (ISSUES_v15.3 R3 follow-up, grounding/snomedChinese.ts): version aligned with fhir_validate_resource 1.12.1 — its validation block has no grounding issues
  //   (no grounding run here), so the output is unchanged.
  // 1.11.0 (ISSUES_v15.4): data.validation carries the record checks of fhir_validate_resource 1.13.0 (empty shells).
  // 1.11.1: data.validation's record checks as fhir_validate_resource 1.13.1 — the v15.3 result-slot note rule (an Observation with no value[x] whose note says there is no result while its code needs a quantitative one) is a WARNING without source_text (was an error; consistent with the v15.4 empty-shell rule), still an error with it.
  // 1.12.0 (ISSUES_v16): R4 content repair: empty arrays removed (ele-1), resourceType inferred from a meta.profile string, errors a lossless reshape only makes visible (a now-readable value / a resource now checked against its declared profile) no longer withdraw the reshape; validation as fhir_validate_resource 1.14.0.
  // 1.13.0: data.validation as fhir_validate_resource 1.15.0 (slice_match options / literals).
  // 1.14.0: data.validation as fhir_validate_resource 1.16.0 (invariant explanations); a short profile id
  //   resolves in the dependency packages (fhir_get_profile 1.2.2).
  // 1.15.0: data.validation with source_text carries the R6 content coverage of fhir_validate_resource 1.17.0.
  // 1.15.0 also: the UCUM repairs of fhir_finalize_bundle 1.9.0.
  // 1.16.0 (ISSUES_v17.2, with source_text): grounding (fhir_check_grounding 1.3.0) and the record checks (1.4.1: ungrounded-value, information-absent, value-from-other-event, incomplete-value, insufficient-precision) exempt the values the IG defines — fixed / pattern, skeleton ig-constants (the payer agency's name / OID), invariant answer literals for value[x]; medication evidence quotes from several-medicine lines are no longer G-CONTEXT-LABEL.
  // 1.17.0: content repairs (v17.3 / v17.1): a string for a complex element (Dosage / Annotation / CodeableConcept … → {text}, Narrative → generated XHTML div), a misplaced string moved as an Annotation, an unknown code whose display names exactly one code of its system → that code, STU3 elements R4 renamed (vaccineProtocol → protocolApplied …, fhirR3Renames.ts) renamed and removed ones reported.
  // 1.18.0: validation as fhir_validate_resource 1.20.0; LOINC display repair to the reference server's release.
  // 1.19.0: validation as fhir_validate_bundle 1.24.0 (validator parity v1).
  // 1.20.0 (ISSUES_v19 R1): content repairs as fhir_finalize_bundle 1.14.0 (near-name renames, MedicationStatement.dosageInstruction → dosage, STU3 children inside protocolApplied).
  // 1.21.0 (ISSUES_v19 R1 round 2): the shared content repairs of fhir_finalize_bundle 1.15.0 (Composition.class → category, performer.reference → performer.actor.reference, STU3 duplicates of a value the R4 element holds removed, a code element written as a CodeableConcept whose system is the THO / core twin of the ValueSet's CodeSystem).
  // 1.22.0 (v18 R1): the no-new-error guard and the reported errors use the official validator when one serves the package (as fhir_validate_bundle 1.27.0).
  // 1.22.1 (release v1): content repairs as fhir_finalize_bundle 1.17.0 (fixed-slice conflict reported, never added).
  // 1.23.0 (ISSUES_v17.4, with source_text): validation as fhir_validate_resource 1.26.0 (narrowed IG-defined exemption).
  // 1.24.0 (ISSUES_v20, with source_text): the record checks of fhir_validate_resource 1.28.0 (as fhir_finalize_bundle 1.19.0).
  // 1.25.0 (ISSUES_v20.1, with source_text only): record_issues / validation carry `gate`; the record checks of fhir_validate_bundle 1.33.0. Output without source_text unchanged.
  fhir_finalize_resource: "1.25.0",
  // 1.0.0 (authoring/, evaluation v11): the model gives field VALUES, the MCP composes the resource for its profile
  //   (fixed / pattern / defaults / derived / displays / UCUM / ROC dates), validates it, keeps it in a Redis context
  //   (`authoring:ctx:*`, 60-min idle TTL) and assembles the Bundle from keys with deterministic urn:uuid fullUrls
  //   (UUID v5 of context id + key, shared by {ref: key} references). Nothing is ever invented: unknown record values
  //   are reported in `missing`. Number spellings are kept end to end.
  // 1.1.0 (evaluation feedback): workflow defaults are `auto` only on REQUIRED elements; an optional element with a
  //   conventional value (Patient.active, Immunization.primarySource, Condition.clinicalStatus 0..1 …) is a plain
  //   optional field whose format / example carry that value as a hint. Description: display replacement, array wrapping.
  // 1.2.0 (evaluation v12): record links — an optional backbone with a required Reference child targeting a profile of
  //   the same IG (same canonical base) of a non-entity type is a tier-1 field with all its children and a {child: {ref}}
  //   example (Encounter.diagnosis); a direct reference to one goes to `more` with `targets` (Encounter.reasonReference,
  //   Condition.encounter, Observation.hasMember …). The size budget applies to the WHOLE response (envelope, warnings,
  //   provenance; non-ASCII counted as \uXXXX) minus a 150-char margin; new data.response_chars.
  // 1.2.1 (ISSUES_v16.2 R1): a short artifact id that is not in the IG itself resolves in its dependency packages (one distinct canonical; otherwise not found / AMBIGUOUS_ARTIFACT with the candidates) — previously ARTIFACT_NOT_FOUND.
  // 1.3.0: warnings carry the IG known defects of the profile (its own examples fail validation: do not create it unless the conversion target requires it).
  // 1.4.0 (ISSUES_v20 R5, recordDerivable.ts): Condition.verificationStatus, Observation.interpretation and MedicationRequest.category are record-derivable — source "derived" WITHOUT auto (before: interpretation / category were auto "MCP derives it" although the composer never derived them, and an optional verificationStatus said "give it only when the record states it"), `format` = "derive from the record: <rule> (record cue: <cue>)", listed in tier 1 wherever the profile allows them (any cardinality) and the binding holds the rule's codes (an IG ValueSet: its codes matched by display, named in the rule; none → a plain coded field); a required one keeps its workflow default as the fallback. Tool description updated.
  fhir_get_authoring_fields: "1.4.0",
  // 1.0.0 (ISSUES_v16 R1, igBlueprint/blueprint.ts): a Bundle profile's blueprint — entry slices (min..max, profile), slicing
  //   discriminator / closed / ordered, Bundle.type, the references between slices that the slice profiles require (also in
  //   extensions and sliced backbones, targets matched through profile derivation) and a recipe; <= 4,000 characters
  //   (`omitted`), view='references' for every reference line. IG-agnostic.
  // 1.0.1 (ISSUES_v16.2 R1): a short artifact id that is not in the IG itself resolves in its dependency packages (one distinct canonical; otherwise not found / AMBIGUOUS_ARTIFACT with the candidates) — previously ARTIFACT_NOT_FOUND.
  // 1.1.0: `known_invalid` (v17.3): slices whose profile the IG's own examples cannot pass, with the reason, examples and where the information goes instead.
  fhir_get_bundle_blueprint: "1.1.0",
  // 1.0.0 (ISSUES_v16 R2, igBlueprint/skeleton.ts): a profile's minimal legal instance (every required element recursively,
  //   required slices, extensions expanded from their definitions, fixed / pattern filled in) and a value_source per required
  //   element (ig-constant: fixed / pattern or identical in >= 2 of the IG's example instances, eligibility by resource kind;
  //   code-lookup; text-allowed; derivable; record) plus conditional rows from `guard implies (x.exists() and …)` invariants;
  //   <= 6,000 characters (`omitted`). IG-agnostic.
  // 1.1.0 (ISSUES_v16.1): (R1) `slices`: every sliced element of the skeleton (CLOSED slicing; OPEN slicing with a
  //   required slice; not Bundle.entry — the blueprint's) with its discriminators and each allowed slice (min..max, a
  //   template item: the slice's fixed / pattern values plus <…> for its required / mustSupport children); a required
  //   CLOSED element without a required slice holds the first slice's template instead of a generic item (which matches
  //   no slice); (R2) `literals`: placeholder-looking IG values (NNxxx) to copy verbatim; (R4) a CodeableConcept with a
  //   required coding slice, and a large required binding, name fhir_normalize_code(text, value_set=<canonical>); compact
  //   levels merge rows with the same source / how (paths joined by ", ") and shorten `slices` (requirements, then names).
  // 1.2.0 (ISSUES_v16.2): (R1) a short profile id resolves in the IG's dependency packages (AMBIGUOUS_ARTIFACT
  //   with candidates when it names several); (R2) the codes of a small binding always carry their display
  //   (`code=display`, clipped to >= 8 characters — never dropped at compact levels); compact levels fold the
  //   reference rows into one ("fullUrl of the target entry (named in the skeleton)").
  // 1.3.0 (ISSUES_v17 R3): a slice told apart by a required binding (no fixed value: Condition.code.coding:icd10-cm-2023)
  //   gets a Coding of the bound ValueSet's system + the lookup (fhir_normalize_code value_set=…) instead of "<record>"; a closed
  //   slicing inside a value (Condition.code → code.coding) templates that value with its first allowed slice (not the base
  //   binding's system, which may belong to a max-0 slice).
  // 1.4.0: warnings carry the IG known defects of the profile (v17.3).
  // 1.5.0 (ISSUES_v19 R2, shared with fhir_get_bundle_form): the value / pattern discriminator element of a required slice
  //   is in the skeleton even when the profile makes it optional (Composition.section:x.code — without it the item
  //   matches no slice); a slice's child is required when the unsliced element is (section:x.text when section.text is
  //   1..1); a Narrative is {status, div}; a choice that allows a coded type is written as that type (the key matched
  //   the first type, e.g. medicationReference holding {text}); a required coding slice with its own required binding
  //   decides the codes / system; a slice's pinned parts complete the coded value's placeholder coding instead of a
  //   second coding; a choice's type slices no longer replace the coded value by the first slice's "<record>".
  // 1.6.0 (ISSUES_v17.4, evaluator decision): example-derived ig-constants follow the strict rule of
  //   fhir_get_bundle_form 1.1.0 — never for identity resources (Organization / Location / Practitioner(Role) / Patient /
  //   RelatedPerson / Person / Group) nor for name / telecom / address / identifier / contact … of any resource (they are
  //   `record`); only profile fixed / pattern values, workflow codes of non-identity resources (unchanged) and the example
  //   identity of a national payer / authority organization (igBlueprint/nationalOrgs.ts: Organization.type pinned to
  //   govt / pay / ins, or the only target of the IG's payor / insurer / payer / authority references, or derived from
  //   one; its `how` names the basis). Before: TWPAS Organization-twpas name / type / identifier.value and TW Core
  //   Organization-hosp-twcore identifier / type / name / telecom were ig-constant (the example hospital). The IG-defined
  //   grounding exemption follows (fhir_check_grounding 1.4.0).
  // 1.7.0 (ISSUES_v20 R5, recordDerivable.ts): a required Condition.verificationStatus / Observation.interpretation / MedicationRequest.category whose binding holds the rule's codes is value_source "derivable" with how = "derive from the record: <rule> (record cue: <cue>)" (skeletonModel items carry `derive` {rule, cue}); it wins over an example constant / workflow default (an IG that writes "confirmed" in every example does not make a hedged diagnosis confirmed). Legend / description name these rows.
  fhir_get_minimal_skeleton: "1.7.0",
  // 1.0.0 (ISSUES_v19 R2, igBlueprint/form.ts): a prefilled form of a Bundle profile — every required entry slice plus
  //   the planned `entries`, each a complete resource skeleton (skeletonModel + closed-slice choice by the IG examples,
  //   conditional rows placed as required=false), entries required references need, deterministic urn:uuid fullUrls,
  //   references wired (one candidate; several = a placeholder with `allowed`), document Composition first with its
  //   required sections + the sections planned entries belong to; `<<P<n>:<value_source>>>` tokens listed in
  //   `placeholders` (RFC 6901 pointer, FHIR type, what, value_source, required, allowed / target / example / format /
  //   rules); <= 30,000 characters (compaction levels; placeholders never dropped).
  // 1.0.1 (release v1): never an empty array in the form's Bundle (ele-1) — without entries `entry` is omitted and a
  //   note says to pass `entries` (was `entry: []`, itself an official error).
  // 1.1.0 (evaluation feedback): (1) no value taken from the IG's example instances for identity resources
  //   (Organization / Location / Practitioner(Role) / Patient / RelatedPerson / Person / Group) or identity elements
  //   (name / telecom / address / identifier / contact …, any resource) — neither prefilled nor as `example`; only
  //   fixed / pattern values of the profiles (skeletonModel strictExamples; fhir_get_minimal_skeleton unchanged);
  //   (2) datatype rules: ContactPoint.system with a value (cpt-2, allowed codes), Age / Duration / Distance / Count
  //   code + the system the rule fixes (age-1 …; time units listed), complex placeholders expanded (Ratio numerator +
  //   denominator, Quantity, Period …), required children of a coded item (form.text), any-of rules (org-1), maxLength
  //   and the ValueSet of a bound string as `max_length` / `value_set`; (3) every entry linked (forward or backward)
  //   to the root / the other entries: an unlinked entry takes a repeating open reference that lists it, else its own
  //   reference to the form's hub, else the one element that can reference it, else it is left out with a note;
  //   (4) `self_check` (no empty value, references resolve, entries linked, ContactPoint / Quantity-like rules);
  //   the `prefilled` list is never dropped by compaction.
  // 1.2.1 (v20 R5): record-derivable elements carry the skeleton's `derive from the record: …` how text.
  fhir_get_bundle_form: "1.2.1",
  // 1.2.0: profile invariants (resource-level constraints of the entries' profiles and of the Bundle profile) turned into
  //   form structure from their FHIRPath alone (formRules.ts): choose-one (`a or b …` none present / one `x.where(p)` several
  //   slices satisfy -> ONE option placed, `choose_one` lists all), conditional required (`G implies …`, `A or (…)`,
  //   `X.where(C).all(y.exists())`: a condition that reads a placeholder -> `required_if` {rule, condition, when, element};
  //   decided by prefilled values -> required / not placed), `format` (+ `format_rule`) from `matches()` / `all(matches())`,
  //   Bundle-level rules relating entries (element added to the target entry, `when` on the Bundle); unparsed rules attached
  //   raw to the placeholder they read (`rules`). Pure one-of conditional rows of the skeleton become `choose_one`
  //   (required). Compaction cites rules by key (`rule_text`, `conditions`) and keeps examples longer; URI examples unclipped.
  // 1.0.0 (ISSUES_v18 R3 = v20 R4, factCoverage/): fact contract check — per fact {item, attribute, value, quote}: quote in
  //   source_text (else quote_not_in_record), clause markers (negated / unconfirmed / stale / pending / not applicable /
  //   not done → not_usable), value in a structured element of the fact's resource type under terminology equivalence
  //   (route codes, Timing, ROC dates, unit conversion, coding names) → covered | missing (+ found_elsewhere), and
  //   suggested_paths from the entry profile's authoring fields.
  // 1.1.0 (ISSUES_v20.1 item 4, agreement 86.3% → target ≥ 95%): HumanName.text / Address.text count whatever the name
  //   parts (a name / address of text only), CodeableConcept.text of a coded concept counts, phrase elements
  //   (DiagnosticReport.conclusion, valueString) contain the value, ContactPoint phone values compare by digits;
  //   Quantity value and unit compared separately (record unit vs UCUM code AND human unit, unit-only facts); numbers and
  //   dates only in elements of the class the attribute names (a dose never matches Dosage.sequence, count / rank /
  //   Timing numbers and reference ranges are never the value → found-in-other-element); negation / uncertainty / stale
  //   cues scoped to the value (prefix before it, postfix after it, never across a field label, never inside a label word
  //   or the "No." abbreviation, mid-phrase "without complications" not a negation of the fact); suggested child paths no
  //   longer double the parent (Practitioner.name.text, not name.name.text); encounter class / department coding
  //   equivalences.
  // 1.2.0 (v20.2): found-in-other-element (another value element of the fact's resource) → covered; counts / sequence / reference ranges only when the attribute names them; FHIR-path attributes.
  fhir_check_fact_coverage: "1.2.0",
  // 1.0.0 (ISSUES_v18 R4 + v20 R1, releaseCheck/): release gate — official validator 0 errors (else not-officially-verified),
  //   grounding + record checks 0 errors, complete fact coverage, completeness (targets → missing-target; without targets the
  //   Bundle profile's required entry slices and suspected-empty-bundle); release / next / reasons / per-check summaries.
  // 1.0.1 (evaluator decision): a missing target that no fact names → missing-target, next "fix" (a model omission is not an absent record fact); insufficient_information only when the facts naming it exist and are all not_usable.
  // 1.1.0 (ISSUES_v20.1): only BLOCKING content errors (gate, recordChecks/contentGates.ts) stop the release and count as
  //   grounding_errors / record_check_errors; advisory errors are counted in content.advisory_errors (+ advisory_rules);
  //   neither targets nor facts → reason incomplete-input (completeness cannot be judged), never released.
  // 1.2.0 (v20.2, evaluator decision): only decidable conditions stop a release (official 0 errors, targets, blocking G-UNGROUNDED on structured values); fact coverage and suspected-empty-bundle → `advisories`; no targets → incomplete-input.
  fhir_release_check: "1.2.0",
  // 1.1.0 (evaluation feedback): (1) a model display the validator's terminology rule rejects for a resolvable code is
  //   replaced by the code's display (provenance lookup; the model wording moves to CodeableConcept.text when empty;
  //   case-only differences are valid, whitespace-only ones take the valid spelling); (2) a single object / scalar where
  //   FHIR repeats is wrapped into a one-item array at any depth, incl. raw FHIR shapes (code: {coding: {…}}); (3) workflow
  //   defaults / defaultValue[x] only on required elements (optional ones never auto-filled), new `apply_defaults`
  //   ("required" | "none", remembered on the context); (4) new `site_config` (facility settings text, merged on the
  //   context, used by assembly grounding). Results gain `notes`, data gains `settings`.
  // 1.2.0 (evaluation v12): Coding.system correction (notes "system corrected for …", provenance lookup): a ValueSet URL
  //   (or its /CodeSystem/ twin) → the CodeSystem the code has in that ValueSet when exactly one (several → error with
  //   candidates; not a member → as before); a URL that resolves to nothing by the validator's URL rules → the one CodeSystem
  //   of the element's bound ValueSets (slices / additional bindings) holding the code (exact, case-insensitive, exact
  //   display — each only when unique); otherwise unchanged (validator error + v10 suggestions).
  // 1.3.0 (evaluation v13): a ValueSet with a filter-defined include (laboratory-code-tw: LOINC CLASSTYPE filter + NHI
  //   payment codes) has a partial local expansion that no longer counts as "not a member": the system is corrected when the
  //   code is a member under exactly one of its CodeSystems (filter decided → note "membership confirmed") or, filter
  //   undecidable, exists in exactly one of them (note "membership unverifiable; the code exists only in <CS> among the
  //   ValueSet's systems"); grammar {system, code} and raw {coding: [...]} alike. An uncorrected ValueSet system is an
  //   error through validation (fhir_validate_resource 1.7.0), so status is invalid.
  // 1.4.0 (ISSUES_v14): the composer's system correction and display check moved to the shared repair layer
  //   (fhirRepair, also used by the finalize tools — same verdict, same repair): a model display is replaced ONLY when it
  //   is the same concept written differently (normalised spelling / designation, or the display searched in the code's
  //   system finds that code first); a display naming another concept is kept with a warning listing the codes it
  //   denotes (was: any rejected display replaced). Raw FHIR values also get the UCUM (rate grammar 次/分 → /min, LOINC
  //   code in Quantity.code, profile-fixed / required UCUM), ROC-date, Coding.system name / unknown-URL and lossless
  //   shape repairs; every repair is verified not to add a validation error (else withdrawn and reported).
  // 1.5.0 (ISSUES_v15): validation as fhir_validate_resource 1.8.0 — record-check issues (code, source "record-checks",
  //   rule, evidence) in results[].issues; an error makes the status invalid. New optional `source_text` (not stored, never
  //   logged) adds the record-dependent checks (R3 / R4) to this call's validation; site_config identifier-format rules apply.
  // 1.5.1 (v14.1 (ISSUES_v14_1, fhirRepair/; patch on top of the ISSUES_v15 bump)): resources get the content repairs of fhir_finalize_bundle 1.3.1; a
  //   `timezone:` line of the context's site_config is the site timezone when none is set.
  // 1.5.2 (v14.1, evaluator decisions 2026-10-25: (a) a system correction is kept when the only new error is the
  //   display check of that same Coding (an exposed error; the display stays reported with candidates); (b) a Quantity
  //   whose profile allows exactly one unit gets it — LOINC code without unit, or a value without code / unit —
  //   recorded in changes (rule ucum, reason "the profile allows only <unit>").
  // 1.6.0 (ISSUES_v15.1): validation as fhir_validate_resource 1.9.0 — with source_text the record checks of
  //   fhir_validate_bundle 1.12.0 (ungrounded-value, value-from-other-event, primary diagnosis slot); without it unchanged.
  // 1.6.1 (ISSUES_v15.1 R6, recordChecks/dateSuggestions.ts): an ungrounded date whose month / day the record states with another year (a wrong ROC ↔ Gregorian conversion: 民國92年8月25日 → 1983-08-25; +1900 / +1910 / +1912 / the ROC year as Gregorian; or a Gregorian record date) gets the record's date as a replace_value suggestion (patch {op: replace, path, value}; reason quotes the record and the rule 民國 N 年 = 西元 N+1911; one candidate 0.95, several all listed); severity unchanged, never applied — on the record-check ungrounded-value date issues of this call's validation.
  // 1.7.0 (ISSUES_v15.2): repairs include rule alt-coding (fhir_finalize_bundle 1.5.0); validation as fhir_validate_resource
  //   1.11.0; lookup candidates in errors carry accepted_by_validator and an exact hit the validator rejects is not taken.
  // 1.8.0 (ISSUES_v15.3): validation as fhir_validate_resource 1.12.0 (record checks R1 text fields / quantitative result
  //   slots, R2 provisional primary diagnosis with source_text).
  // 1.8.1 (ISSUES_v15.3 R3 follow-up, grounding/snomedChinese.ts): version aligned with fhir_validate_resource 1.12.1 —
  //   the per-resource validation here runs no grounding, so the output is unchanged (fhir_assemble_bundle 1.8.1 carries it).
  // 1.9.0 (ISSUES_v15.4): validation as fhir_validate_resource 1.13.0 (record checks: empty shells, absence predicate classes).
  // 1.9.1: validation as fhir_validate_resource 1.13.1 — the v15.3 result-slot note rule (an Observation with no value[x] whose note says there is no result while its code needs a quantitative one) is a WARNING without source_text (was an error; consistent with the v15.4 empty-shell rule), still an error with it.
  // 1.10.0 (ISSUES_v16): validation issues as fhir_validate_resource 1.14.0 (slice_match / profile_match).
  // 1.11.0: validation issues as fhir_validate_resource 1.15.0 (slice_match options / literals).
  // 1.12.0: validation issues as fhir_validate_resource 1.16.0 (invariant explanations).
  // 1.13.0: validation with source_text carries the R6 content coverage of fhir_validate_resource 1.17.0.
  // also (v17 robustness audit): a quantity text with a long whitespace run before a line break no longer backtracks cubically (QUANTITY_TEXT on the trimmed value); source_text is limited to 200,000 characters.
  // 1.14.0 (ISSUES_v17.2, with source_text): grounding (fhir_check_grounding 1.3.0) and the record checks (1.4.1: ungrounded-value, information-absent, value-from-other-event, incomplete-value, insufficient-precision) exempt the values the IG defines — fixed / pattern, skeleton ig-constants (the payer agency's name / OID), invariant answer literals for value[x]; medication evidence quotes from several-medicine lines are no longer G-CONTEXT-LABEL.
  // 1.15.0: validation as fhir_validate_resource 1.19.0; content repairs as fhir_finalize_resource 1.17.0.
  // 1.16.0: validation as fhir_validate_resource 1.20.0.
  // 1.17.0: validation as fhir_validate_bundle 1.24.0 (validator parity v1).
  // 1.18.0 (ISSUES_v19 R1 round 2): the shared content repairs of fhir_finalize_bundle 1.15.0 (Composition.class → category, performer.reference → performer.actor.reference, STU3 duplicates of a value the R4 element holds removed, a code element written as a CodeableConcept whose system is the THO / core twin of the ValueSet's CodeSystem).
  // 1.18.1 (release v1): shared content repairs as fhir_finalize_bundle 1.17.0 (fixed-slice conflict reported, never added).
  // 1.19.0 (ISSUES_v17.4, with source_text): validation as fhir_validate_resource 1.26.0 (narrowed IG-defined exemption).
  // 1.20.0 (ISSUES_v20, with source_text): the content checks of its validation follow fhir_validate_resource 1.28.0 (abbreviations, ROC range ends, identifier-truncated, allergy; code-meaning-mismatch only where normalize candidates are fetched).
  // 1.21.0 (ISSUES_v20.1, with source_text only): the content checks of fhir_validate_bundle 1.33.0 in its validation (gate field, coded unconfirmed-as-confirmed, false-positive fixes). Output without source_text unchanged.
  fhir_author_resources: "1.21.0",
  // 1.0.1: action=get results carry the author result's new `notes` (fhir_author_resources 1.1.0); otherwise unchanged.
  fhir_context: "1.0.1",
  // 1.1.0: new `site_config` (merged with the context's) passed to the grounding engine with source_text, so facility
  //   identifier systems / organisation values are grounded as site_config; resources carry the 1.1.0 composer rules.
  // 1.2.0: resources composed as fhir_author_resources 1.3.0, validation as fhir_validate_bundle 1.9.0.
  // 1.3.0 (ISSUES_v14): resources composed as fhir_author_resources 1.4.0; finalize always with repair="content" (context
  //   timezone for ROC times); data gains `repair_issues`; changes include the content repairs.
  // 1.4.0 (ISSUES_v15): resources as fhir_author_resources 1.5.0; validation as fhir_validate_bundle 1.11.0 (record checks;
  //   R3 / R4 with source_text; site_config identifier-format rules) — record-check issues are tagged with key / field.
  // 1.4.1 (v14.1 (ISSUES_v14_1, fhirRepair/; patch on top of the ISSUES_v15 bump)): resources as fhir_author_resources 1.5.1; finalize as
  //   fhir_finalize_bundle 1.3.1 (site_config timezone line used for date-times without an offset).
  // 1.4.2 (v14.1, evaluator decisions 2026-10-25: (a) a system correction is kept when the only new error is the
  //   display check of that same Coding (an exposed error; the display stays reported with candidates); (b) a Quantity
  //   whose profile allows exactly one unit gets it — LOINC code without unit, or a value without code / unit —
  //   recorded in changes (rule ucum, reason "the profile allows only <unit>").
  // 1.5.0 (ISSUES_v15.1): resources as fhir_author_resources 1.6.0; validation as fhir_validate_bundle 1.12.0 (with
  //   source_text: value grounding, other-event values, primary diagnosis slot); without source_text unchanged.
  // 1.6.0 (ISSUES_v15.1 R6, recordChecks/dateSuggestions.ts): an ungrounded date whose month / day the record states with another year (a wrong ROC ↔ Gregorian conversion: 民國92年8月25日 → 1983-08-25; +1900 / +1910 / +1912 / the ROC year as Gregorian; or a Gregorian record date) gets the record's date as a replace_value suggestion (patch {op: replace, path, value}; reason quotes the record and the rule 民國 N 年 = 西元 N+1911; one candidate 0.95, several all listed); severity unchanged, never applied — validation as fhir_validate_bundle 1.13.0 (record-check and grounding date issues).
  // 1.7.0 (ISSUES_v15.2): resources as fhir_author_resources 1.7.0; finalize as fhir_finalize_bundle 1.5.0; validation as
  //   fhir_validate_bundle 1.14.0.
  // 1.8.0 (ISSUES_v15.3): resources as fhir_author_resources 1.8.0; validation as fhir_validate_bundle 1.15.0 (record
  //   checks R1 / R2 and, with source_text, the coded-element grounding annotation R3).
  // 1.8.1 (ISSUES_v15.3 R3 follow-up, grounding/snomedChinese.ts): validation as fhir_validate_bundle 1.15.1 (with source_text, the R3 grounding annotation compares
  //   SNOMED codes' Chinese names: a wrong SNOMED primary diagnosis vs a Chinese diagnosis slot can be an error).
  // 1.9.0 (ISSUES_v15.4): resources as fhir_author_resources 1.9.0; validation as fhir_validate_bundle 1.16.0 (empty shells).
  // 1.9.1: validation as fhir_validate_bundle 1.16.1 (R3 SNOMED Chinese-name fixes and hierarchy guard; result-slot note
  //   rule a warning without source_text).
  // 1.10.0 (ISSUES_v16 R5, authoring/bundleSlices.ts): with bundle_profile, every stored resource is placed in its entry slice before
  //   validation (declared / authored profile, else the only or clearly closest slice of its type), meta.profile completed for a
  //   resource authored for its slice's profile, entries in slice order when the slicing is ordered; bundle_slices reports the
  //   placement, `missing` required slices (what to author — never invented), `excess` (max) and `unmatched` (closed slicing);
  //   content repairs as fhir_finalize_bundle 1.8.0, validation as fhir_validate_bundle 1.17.0.
  // 1.11.0: validation as fhir_validate_bundle 1.18.0 (slice_match options / literals).
  // 1.12.0: validation as fhir_validate_bundle 1.19.0 (invariant explanations).
  // 1.13.0: validation with source_text carries the R6 content coverage of fhir_validate_bundle 1.20.0 (duplicates, negated / excluded items, text-only facts).
  // 1.14.0 (ISSUES_v17.2, with source_text): grounding (fhir_check_grounding 1.3.0) and the record checks (1.4.1: ungrounded-value, information-absent, value-from-other-event, incomplete-value, insufficient-precision) exempt the values the IG defines — fixed / pattern, skeleton ig-constants (the payer agency's name / OID), invariant answer literals for value[x]; medication evidence quotes from several-medicine lines are no longer G-CONTEXT-LABEL.
  // 1.15.0: finalize as fhir_finalize_bundle 1.11.0 (document completion); validation as fhir_validate_bundle 1.22.0.
  // 1.16.0: finalize as fhir_finalize_bundle 1.12.0; validation as fhir_validate_bundle 1.23.0.
  // 1.17.0: validation as fhir_validate_bundle 1.24.0 (validator parity v1).
  // 1.18.0 (ISSUES_v19 R1 round 2): the shared content repairs of fhir_finalize_bundle 1.15.0 (Composition.class → category, performer.reference → performer.actor.reference, STU3 duplicates of a value the R4 element holds removed, a code element written as a CodeableConcept whose system is the THO / core twin of the ValueSet's CodeSystem) and its document completion (section entries of a type the section slice does not take moved to the one section that takes them).
  // 1.18.1 (release v1): finalize as fhir_finalize_bundle 1.17.0 content repairs (fixed-slice conflict reported, never added).
  // 1.19.0 (ISSUES_v17.4, with source_text): grounding / validation as fhir_validate_bundle 1.29.0 (narrowed IG-defined exemption).
  // 1.20.0 (ISSUES_v20, with source_text): the content checks follow fhir_validate_bundle 1.31.0 (as fhir_author_resources 1.20.0).
  // 1.21.0 (ISSUES_v20.1, with source_text only): the content checks of fhir_validate_bundle 1.33.0 in its validation (gate field, coded unconfirmed-as-confirmed, false-positive fixes). Output without source_text unchanged.
  fhir_assemble_bundle: "1.21.0",
  // 1.0.0 (ISSUES_v9 R1): deterministic Bundle finalizer — fullUrl-uuid / reference-rewire / resource-id (mandatory),
  // bundle-type / document-order (profile-driven); UUID v5 seeded by (resourceType, original fullUrl, resource.id, entry
  // index) + a content salt; references found through StructureDefinition snapshots; duplicates / ambiguity reported.
  // 1.0.1: notes report a stray entry written at Bundle level (fullUrl / resource beside `entry`) — not moved.
  // 1.1.0 (ISSUES_v10 B): `bundle` is returned with every number spelled as the caller wrote it (10.0 stays 10.0; see
  //   fhir_validate_bundle 1.8.0) — same JSON value, same UUIDs and changes as 1.0.1. New optional `bundle_type` (R4
  //   bundle-type code): sets Bundle.type as rule bundle-type with reason "requested by caller (bundle_type)", listed in
  //   changes; a type fixed by the resolved Bundle profile wins and the conflict is a note; document → Composition first.
  //   A document without any Composition notes both ways out (bundle_type=<derived> or add a Composition).
  // 1.2.0 (ISSUES_v14): new `repair` — "content" (DEFAULT_FINALIZE_REPAIR, fhirRepair/index.ts) = ids + the content
  //   repairs whose fix is uniquely determined (rules display / ucum / roc-date / system / shape / code, each change listed
  //   with its reason, verified per entry not to add a validation error, else withdrawn and reported); "ids" = 1.1.0
  //   behaviour exactly. New `timezone` (ROC times), data.repair / repair_issues, summary.content. Lossless numbers kept.
  // 1.3.0 (ISSUES_v15): report-only record checks on the finalized Bundle — data.record_issues + data.record_checks (R1 / R2
  //   always; R3 / R4 with the new optional `source_text`; site_config identifier-format rules), a warning when any is an
  //   error; the Bundle and changes are unchanged (never auto-fixed). (If ISSUES_v14_1 bumps this tool too, the higher
  //   version carries both.)
  // 1.3.1 (v14.1 (ISSUES_v14_1, fhirRepair/; patch on top of the ISSUES_v15 bump)): content repairs extended — rule timezone (a date-time without UTC offset,
  //   ROC or Gregorian, takes the site timezone: `timezone` (UTC offset or IANA zone) > a site_config `timezone:` line >
  //   that line in source_text's 院所設定 section; else reported, code timezone-required); ucum (code ≡ the profile's
  //   code at conversion factor 1, `1/min` → `/min`; `1.73m2` divisor → `{1.73_m2}`; µ / μ → u, IU → [IU]; a LOINC code
  //   as Quantity.code without a unit → error quantity-code-not-ucum, or the profile's single fixed unit); system (HL7
  //   core ValueSet URL without /ValueSet/, a THO / core ValueSet named by the URL's last segment, a renamed / retired
  //   CodeSystem by name similarity — unique holder of the code accepted by the element's constraining binding); shape
  //   (Coding wrapped in {type: …}; a required-bound code given as CodeableConcept / Coding; moves into a present choice
  //   value and up out of a single array item; a resource property of Bundle.entry such as request moved to the entry;
  //   numbered entry keys rebuilt as the entry array; a Bundle without resourceType given one — also before the
  //   INVALID_ARGUMENT check, whose message now names the location; deep-equal duplicate fullUrl entries dropped);
  //   empty (ele-1: {}, [], "", null removed); fixed-slice (required coding slices the profile fully fixes). New:
  //   every change is verified against the whole Bundle's validation (errors only the Bundle context shows), else
  //   withdrawn and reported. New optional `site_config`.
  // 1.3.2 (v14.1, evaluator decisions 2026-10-25: (a) a system correction is kept when the only new error is the
  //   display check of that same Coding (an exposed error; the display stays reported with candidates); (b) a Quantity
  //   whose profile allows exactly one unit gets it — LOINC code without unit, or a value without code / unit —
  //   recorded in changes (rule ucum, reason "the profile allows only <unit>").
  // 1.4.0 (ISSUES_v15.1): data.record_issues with source_text follow fhir_validate_bundle 1.12.0's record checks (value
  //   grounding, other-event values, stated absences, primary diagnosis slot); report only, the Bundle is never changed;
  //   output without source_text unchanged.
  // 1.4.1 (ISSUES_v15.1 R6, recordChecks/dateSuggestions.ts): an ungrounded date whose month / day the record states with another year (a wrong ROC ↔ Gregorian conversion: 民國92年8月25日 → 1983-08-25; +1900 / +1910 / +1912 / the ROC year as Gregorian; or a Gregorian record date) gets the record's date as a replace_value suggestion (patch {op: replace, path, value}; reason quotes the record and the rule 民國 N 年 = 西元 N+1911; one candidate 0.95, several all listed); severity unchanged, never applied — on the ungrounded-value date issues in data.record_issues.
  // 1.5.0 (ISSUES_v15.2 R4): content repair rule alt-coding (fhirRepair/alternatives.ts, phase alternatives): a Coding whose
  //   code is missing from the package's excerpt CodeSystem but defined in a fuller installed copy, whose concept links to
  //   exactly ONE coding of another system the validator accepts and a ValueSet bound to the coding element / a coding slice
  //   contains (e.g. NHI drug → its ATC code, TW Core medcation-atc-tw), is replaced by it — or dropped when the
  //   CodeableConcept already carries it (validator_cli rejects the CodeableConcept while the unknown Coding is present);
  //   CodeableConcept.text is kept, and set to the original display when absent; several → repair_issues with candidates.
  // 1.5.1 (ISSUES_v15.2.1): alt-coding also for an entry resource without meta.profile — the coding element's binding is
  //   read from the IG's profile(s) of the resource type (the closure package owning the Coding's CodeSystem, else the
  //   validated / default IG; one profile, or several that agree — else nothing); the change reason names the profile
  //   ("… because the resource declares no profile"). No meta.profile is added; the verification validates as before.
  // 1.6.0 (ISSUES_v15.3): data.record_issues follow fhir_validate_bundle 1.15.0's record checks (R1 text fields /
  //   quantitative result slots, R2 provisional primary diagnosis); the Bundle and changes are unchanged.
  // 1.6.1 (ISSUES_v15.3 R3 follow-up, grounding/snomedChinese.ts): version aligned with fhir_validate_bundle 1.15.1 — data.record_issues carry no grounding issues, so
  //   the output is unchanged.
  // 1.7.0 (ISSUES_v15.4): data.record_issues follow fhir_validate_bundle 1.16.0's record checks (empty shells); the Bundle
  //   and changes are unchanged.
  // 1.7.1: data.record_issues — the v15.3 result-slot note rule (an Observation with no value[x] whose note says there is no result while its code needs a quantitative one) is a WARNING without source_text (was an error; consistent with the v15.4 empty-shell rule), still an error with it.
  // 1.8.0 (ISSUES_v16 R4): content repair: empty arrays removed (ele-1), resourceType inferred from a meta.profile string, errors a lossless reshape only makes visible (a now-readable value / a resource now checked against its declared profile) no longer withdraw the reshape (an inferred resourceType is withdrawn only by an unknown top-level property).
  // 1.9.0: data.record_issues with source_text carry the R6 content coverage of fhir_validate_bundle 1.20.0.
  // 1.9.0 also: (v17 R3) UCUM repair — a bare count unit (count / counts / 個) → {count}; a required ValueSet that includes UCUM as a whole system (no enumerated UCUM codes) allows every valid UCUM code instead of none.
  // 1.10.0 (ISSUES_v17.2, with source_text): grounding (fhir_check_grounding 1.3.0) and the record checks (1.4.1: ungrounded-value, information-absent, value-from-other-event, incomplete-value, insufficient-precision) exempt the values the IG defines — fixed / pattern, skeleton ig-constants (the payer agency's name / OID), invariant answer literals for value[x]; medication evidence quotes from several-medicine lines are no longer G-CONTEXT-LABEL.
  // 1.11.0: content repairs (v17.3 / v17.1): a string for a complex element (Dosage / Annotation / CodeableConcept … → {text}, Narrative → generated XHTML div), a misplaced string moved as an Annotation, an unknown code whose display names exactly one code of its system → that code, STU3 elements R4 renamed (vaccineProtocol → protocolApplied …, fhirR3Renames.ts) renamed and removed ones reported; document Bundles (v17.1 R1 / R2, fhirRepair/document.ts): identifier (UUID v5 of the Composition), timestamp (Composition.date when an instant), Composition.subject / author (the one candidate), meta.profile from the Bundle profile's composition slice, entries unreachable from the Composition placed into the one fitting section slice (profile > pinned codes / required code binding > type; a required empty section first) with the section's code display, title and generated text; required missing sections and ambiguous entries reported; narratives: missing div / XHTML namespace / invalid status repaired.
  // 1.12.0: finalize (ISSUES_v17.5): dead local narrative links unwrapped (text kept), Coding.system `url|version` → system + version, section codes pinned by the Composition profile get their terminology display, sections with an emptyReason take no entries; LOINC displays repaired to the reference server's release.
  // 1.13.0: validation as fhir_validate_bundle 1.24.0 (validator parity v1).
  // 1.14.0 (ISSUES_v19 R1, layer 1 auto-fix): every change carries pointer (RFC 6901, the Bundle as sent: document reorder / dropped duplicates / entries moved in from Bundle level mapped back), before, after, category (shape / narrative / display / unrecognized_property / system_code / ids_references / document_structure / fixed_pattern) and moved_to for moves; new data.ambiguous [{pointer, message, category, candidates [{description, patch? (RFC 6902 on the sent Bundle)}]}]; no-new-error guard (validate as sent vs finalized, the change an added error is owed to withdrawn and listed in ambiguous); new fixes: near-name renames (choice suffix, bare choice stem, singular / plural, MedicationStatement.dosageInstruction → dosage, STU3 children inside protocolApplied, "1" → 1 for integer types), an entry written at Bundle level moved into entry, profile-fixed values set, displays of profile-pinned codes, a profile-narrowed choice type renamed, required section narratives from their entries; summary.categories / ambiguous / withdrawn / errors_before / errors_after.
  // 1.15.0 (ISSUES_v19 R1 round 2): new layer-1 fixes — the display of a determined code (no other code of its system is named so, the display shares a word with the code's names, no required binding rejects the code; the written wording kept as CodeableConcept.text), a Coding's system from the bound ValueSet that holds the code with exactly the written display under one other system (v3-ActCode#L 'Low' → v3-ObservationInterpretation), a code written in the wrong element moved to the one sibling whose required ValueSet holds it (AllergyIntolerance.type 'medication' → category, criticality 'unconfirmed' → verificationStatus; the copy removed when the sibling already carries it), a string element given as {text: …} → the text, a code element given as a CodeableConcept whose system is the THO / core twin of the ValueSet's CodeSystem, STU3 Composition.class → category, performer.reference → performer.actor.reference, an STU3 / mis-suffixed duplicate of a value its R4 element already holds removed, document section entries of a type the section slice does not take moved to the one section that takes them (or dropped from the section when another entry references them); new argument exposed_errors ("strict" default | "allow_under_moved": errors at / under a renamed or moved property's new location do not withdraw the rename); summary.exposed_errors.
  // 1.16.0 (v18 R1): the no-new-error guard and the reported errors use the official validator when one serves the package (as fhir_validate_bundle 1.27.0).
  // 1.17.0 (release v1, fhirRepair/fixedGuard.ts): a MISSING fixed / pattern value is filled (new: a required element
  //   the profile fixes / patterns, absent → that value), an EXISTING value that differs is never overwritten by any
  //   rule (was: "Value is 'preliminary' but is fixed to 'final'" → final) — only a representation difference
  //   (whitespace, ["x"] / "x", a URI alias of the same system) is rewritten; a conflict is an ambiguous item
  //   (fixed_pattern, description-only candidates; a status adds the insufficient_information hint) and the validator
  //   error stays. A required coding slice is not added next to a coding of its system with another code. No no-op
  //   changes (same value, same place). ambiguous items: `pointer` always resolves in the sent Bundle (else its nearest
  //   existing ancestor + `pointer_note`), new `pointer_out` (the returned Bundle, when different) and candidate
  //   `patch_out` (the returned Bundle, verified to apply, when paths / values differ).
  // 1.18.0 (ISSUES_v17.4, with source_text): data.record_issues as fhir_validate_bundle 1.29.0 (narrowed IG-defined exemption).
  // 1.19.0 (ISSUES_v20, with source_text): the record checks of fhir_validate_bundle 1.31.0 in data.record_issues (identifier-truncated, ROC range ends, no allergy resolution from 停藥; code-meaning-mismatch needs normalize candidates, which finalize does not fetch). Output without source_text unchanged.
  // 1.20.0 (ISSUES_v20.1, with source_text only): record_issues carry `gate`; the record checks of fhir_validate_bundle 1.33.0. Output without source_text unchanged.
  fhir_finalize_bundle: "1.20.0",
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
  // 1.2.0 (R3 "never invent data"): no element is stamped with the current time — Condition.recordedDate and
  //   note.time appear only when the caller supplies them, meta.lastUpdated is never written (was: now()+08:00).
  query_fhir_condition: "1.2.0",
  query_fhir_medication: "1.2.0",
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
  // 1.2.1 (ISSUES_v10 B): entry resources keep the caller's number spellings (as fhir_finalize_bundle 1.1.0); same UUIDs.
  fhir_build_bundle: "1.2.1",
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
