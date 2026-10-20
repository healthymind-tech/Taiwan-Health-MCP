# FHIR IG Tools

A general, IG-scoped toolset built on the multi-IG `fhir.*` store, used to explore Implementation Guides, read profiles and terminology, perform terminology validation, and produce and validate FHIR R4 resources through skeleton-fill authoring.

> **Maintenance mode**: while the admin console has the `ig` module in maintenance mode, all 22 tools of this group (including `fhir_check_grounding` / `fhir_check_completeness`) calls return an `isError` result immediately with error code `MODULE_MAINTENANCE` (`error.message` in English, `error.message_zh` in Traditional Chinese, `error.module` the module key), effective within about 5 seconds; the tools stay in `tools/list`. See the [API reference](../api/index.md#maintenance).

## Shared conventions
- Every tool accepts an optional `package_id` + `version`. When `package_id` is omitted, the target package is chosen by this precedence, and `provenance.resolved_by` says which rule applied:
    1. `explicit_version` — a canonical argument or `meta.profile` pinned as `url|version` → the package holding that version;
    2. `package_arg` / `latest` — `package_id` was given (with `version`, that version; without it, the default IG's version, else the highest release — pre-releases only when no release exists);
    3. `meta_profile` / `canonical_owner` — the package that owns the `meta.profile` or the canonical argument (profile / ValueSet / system), manually-installed IGs first;
    4. `default_ig` — the default IG (`isDefault`);
    5. `sole_manual_ig` — no default IG and exactly one manually-installed IG.
    If none applies the call fails with `NO_DEFAULT_IG` (no arbitrary package is picked).
- A `|version` is always honoured: a version that is not installed returns `ARTIFACT_NOT_FOUND` (the message lists the installed versions) — never a silent fallback to another version.
- Responses use a shared envelope: `{ok, data, warnings, provenance, error?}`. `provenance` carries `packageId` / `version` / `fhirVersion` / `source` plus `resolved_by`; when the dependency closure holds several versions of one package it also carries `closure_versions` (which version canonical lookups use).
- When declared dependencies of the target IG are not installed, `data.deps_missing` lists them as `{package_id, version, required_by}` (incomplete closure — results may be missing content).
- List / search tools (`fhir_list_artifacts`, `fhir_search_artifacts`, `fhir_list_resource_profiles`) query only the default IG when `package_id` is omitted; `all_packages=true` queries every installed package instead (rows carry `package_id` / `package_version`; `package_id` is then ignored). Zero hits come with `data.hint` naming the other packages that match.
- **Compact output `compact=true`** (`fhir_list_igs`, `fhir_list_artifacts`, `fhir_search_artifacts`, `fhir_list_resource_profiles`; default `false`, and the default output is unchanged) is for LLMs with a tight tool-output budget. Each type becomes an `{id: title}` map, the common canonical prefix is written once (`canonical_base`; canonical = `canonical_base/<ResourceType>/<id>`), and only canonicals that break that rule are listed in `canonicals`; profiles also list non-active ones in `status`; `data.compact` is a one-line reading guide. With `all_packages=true` the groups sit under `packages` (`packageId#version` → that package's group). `fhir_list_igs` returns `default` plus `manual` / `dependency` maps by install origin (`packageId#version` → title). Measured on TW Core: `fhir_list_resource_profiles` 12.9k → 4.8k characters, `fhir_list_artifacts` (50 rows) 19.9k → 2.8k, `fhir_search_artifacts` (20 rows) 8.6k → 1.5k, `fhir_list_igs` (58 packages) 19.6k → 3.7k.
- For the module concepts and the suggested workflow, see [FHIR IG Service](../modules/fhir-ig-service.md).

## IG discovery
| Tool | Description | Key parameters |
| :--- | :--- | :--- |
| `fhir_list_igs` | List installed IG packages (packageId / version / title / canonical / fhirVersion / status / isDefault / `installOrigin` (`manual` = installed by an operator, `dependency` = fetched for another IG's dependencies) / dependencies) | `compact` |
| `fhir_get_ig` | Details for a single IG: dependencies and artifact counts per resource type; `data.deps_missing` lists uninstalled dependencies | `package_id`, `version` |
| `fhir_list_artifacts` | List a summary of the IG's conformance artifacts | `resource_type`, `grouping_id`, `all_packages`, `limit` (50 by default, 200 maximum), `compact` |
| `fhir_search_artifacts` | Full-text search over artifacts by id / canonical / name / title / description | `keyword`, `resource_type`, `all_packages`, `limit` (20 by default, 100 maximum), `compact` |

## Profile selection and reading
| Tool | Description | Key parameters |
| :--- | :--- | :--- |
| `fhir_list_resource_profiles` | List selectable resource profiles, grouped by the base resource type they constrain | `base_type`, `all_packages`, `compact` |
| `fhir_rank_resource_profiles` | Rank by how well source field keys match profile element paths (advisory only, `selectionRequired:true`) | `keys`, `base_type`, `limit` (5 by default, 20 maximum) |
| `fhir_get_profile` | Summary of a single profile (identity / base / derivation / element count), resolvable by id, canonical, or key; a canonical may be pinned as `url|version` (an uninstalled version is `ARTIFACT_NOT_FOUND`) | `identifier` |
| `fhir_get_profile_elements` | Read the profile snapshot; `view` = `elements` / `element` / `slices` / `choices` / `binding` / `examples` | `profile`, `view`, `path`, `slice_name`, `limit` |
| `fhir_get_profile_required_elements` | List the elements a profile *effectively* requires: required only when the whole parent chain is required, required slices, choice types, invariant-implied value[x]-or-dataAbsentReason (vs-2 / vs-3 / tw-core-4 style, detected from the expression), and target-implied primary content; each row carries `grounding_class` (auto / coding / source_fact / workflow_default …), `required_by`, `allowedCodes` for small required bindings and a fill `hint`; `derived` rows (e.g. `Condition.category`) also carry the binding's `allowedCodes` (extensible / preferred too, up to 20 codes) and a derivation rule (see "Derived elements and Must Support" below). Profiled extensions are expanded from their definitions (url, value[x] via ext-1, required sub-extensions), base-datatype children of populated elements are added (Narrative.div, Extension.url …), and profile-specific error invariants are listed under `invariants`. With `instance`, slices are matched by their discriminators, so absent slices add nothing | `profile`, `instance` (draft: populated optional parents add their required children), `include_target_implied` (`true` by default), `include_mustsupport` (`false` by default; `"defaults"` = only the mustSupport elements with a fixed / default / derivable value; `true` = every mustSupport element; added rows carry `optional: true`), `verbosity` (`compact` by default: id / required_by / grounding_class / fixed·pattern·value / choices / allowedCodes / hint, profile-pinned subtrees folded into one copyable `value`; `full` adds min / max / types / binding / mustSupport) |

### Derived elements and Must Support {#derived-and-mustsupport}

Elements with `grounding_class: "derived"` are not copied from the record but follow from other filled values. For well-known derived elements, `hint` starts with `derive:` and states the rule (each rule paraphrases the published definitions of the codes it names; the citation is `derivation_source` in `verbosity="full"`). A rule applies only when the element's binding is the ValueSet the rule describes:

| Element | Rule (summary) | Source |
| :--- | :--- | :--- |
| `Condition.category` | diagnosed or assessed in this visit (outpatient, admission, discharge) → `encounter-diagnosis` (and point `Condition.encounter` at that encounter); an entry of the longitudinal problem list kept across visits → `problem-list-item`; a diagnosis written in a visit note is `encounter-diagnosis` even when the disease is chronic | FHIR R4 condition-category; US Core Condition Encounter Diagnosis / Problems and Health Concerns |
| `Observation.category` | by what was measured: lab test → `laboratory`, BP / heart rate / temperature / height / weight … → `vital-signs`, imaging, exam, survey, social history … | FHIR R4 observation-category; R4 Vital Signs profile |
| `Encounter.diagnosis.use` / `.rank` | admission AD, discharge DD, chief complaint CC, comorbidity CM …; principal diagnosis rank 1, the rest in record order | FHIR R4 diagnosis-role; Encounter.diagnosis.rank |
| `MedicationRequest.category` / `MedicationStatement.category` / `courseOfTherapyType` | by the setting of the order (inpatient / outpatient / community / discharge); long-term `continuous`, short course `acute` | FHIR R4 code systems |
| `AllergyIntolerance.category` / `.type` / `.criticality`, `Observation.interpretation` | by the substance; immune vs non-immune reaction; life-threatening → `high`; against the reference range N / H / L / HH / LL | FHIR R4 code systems |

Derived elements without a rule get the CodeSystem definitions of the binding's codes in `hint` (`pick the code whose meaning fits the record: …`).

**mustSupport is not required.** `include_mustsupport="defaults"` adds only the mustSupport elements that need no source fact (a profile fixed value / pattern, a conventional default such as `verificationStatus`, a derivable value from the table above) and whose parents are all listed; `true` adds every mustSupport element. Rows added either way carry `optional: true` and a "may be left out, never refuse over it" hint, and `guide` says the same. The default (`false`) output is unchanged except for the derived rows.

## Terminology / ValueSet
| Tool | Description | Key parameters |
| :--- | :--- | :--- |
| `fhir_get_valueset` | ValueSet definition summary | `identifier` |
| `fhir_expand_valueset` | Expand a ValueSet and list its member codes (resolved locally where possible; whole large external code systems are not enumerated — `TOO_BROAD`) | `identifier`, `limit` (500 by default, 2000 maximum) |
| `fhir_lookup_code` | Look up a single code's display name and properties in a CodeSystem (RxNorm from the local `rxnorm.concepts`); when the code is not found, `hint` (use `fhir_normalize_code`) and `near_codes` (similar codes of an IG CodeSystem) | `system`, `code` |
| `fhir_validate_code` | Validate whether a `system`+`code` belongs to a given ValueSet; returns `valid` / `invalid` / `unverifiable`; `value_set` may be pinned as `url|version` | `system`, `code`, `value_set` |
| `fhir_normalize_code` | Free text (Chinese or English, abbreviations, chart wording) → candidate codes: SNOMED CT / LOINC / ICD-10 and any CodeSystem of an installed IG (e.g. the NHI payment codes `medical-service-payment-tw`, see [IG Concept Search](../modules/ig-concept-search.md)). IG candidates carry `matched_term`, `matched_language`, `group`/`siblings` and `linked` (codes of other systems the concept links to, e.g. a drug's ATC code); `system` may be a canonical, id or alias (`nhi_payment`). **Drugs**: Taiwan NHI drug codes are supported — `system="medication-nhi-tw"` (TW Core) or `"nhi-medication"` (TWPAS), text = brand or generic name in English or Chinese (`Glucophage 500mg`, `脈優錠 5mg`); when the default IG ships only an excerpt of a CodeSystem (TW Core 1.0.0 `medication-nhi-tw`: 35 codes) and another installed package holds the full list (TW Core 0.3.2: 44,709 codes), the full copy is searched unless `package_id` / `version` is given (noted in `warnings` and `data.codesystem_copies`). **ATC**: no searchable WHO ATC is held (TW Core `medcation-atc-tw` has only 27 Taiwan-specific codes) — look up the NHI drug; its candidate's `linked` is its ATC code (from the bundled NHI medication supplement) | `text`, `value_set`, `system`, `limit` (10 by default) |

## Authoring, assembly, and validation
| Tool | Description | Key parameters |
| :--- | :--- | :--- |
| `fhir_get_resource_skeleton` | Generate an empty draft from a profile containing only required / mustSupport structure; `required` is the element's own min≥1, `effectiveRequired` also requires every ancestor to be required | `profile`, `candidate_limit` (20 by default, capped at 100), `include_examples` (`true` by default) |
| `fhir_finalize_resource` | Finalise a draft against its profile and return the complete resource | `profile`, `draft`, `context_id`, `key`, `generate_narrative` (`true` by default) |
| `fhir_resolve_reference` | Resolve resource references by temporary key (for linking inside a Bundle) | `key`, `resource_type`, `context_id`, `display` |
| `fhir_build_bundle` | Assemble several resources into a Bundle | `entries`, `bundle_type` (`transaction` by default), `context_id` |
| `fhir_validate_resource` | Validate a single resource (structure + terminology bindings); falls back to `meta.profile` when `profile` is omitted. An optional `source_text` adds a grounding check (see below) | `resource`, `profile`, `source_text`, `site_config`, `evidence_map`, `grounding`, `grounding_verbosity` |
| `fhir_validate_bundle` | Validate an entire Bundle (each entry against its `meta.profile`, plus reference integrity inside the Bundle). An optional `source_text` adds a grounding check and merges the results (see below) | `bundle`, `source_text`, `site_config`, `evidence_map`, `grounding`, `grounding_verbosity` |

`fhir_validate_resource` / `fhir_validate_bundle` also report whether validation was complete: `checked_fully` (`true` when every profile and ValueSet was checked and the dependency closure is complete), `profiles_unchecked`, `valuesets_unchecked`. `valid` keeps HL7 semantics (an unresolvable profile is only a warning), so `valid: true` with `checked_fully: false` means part of the content was not checked. When definition / terminology lookups failed during the run because of database trouble, `lookups_failed` (the count) is added; such a run always carries an error issue with `code: "exception"` and `valid` is `false` (1.6.1). `|version` canonicals (`meta.profile`, binding, targetProfile, type profile, extension url) are resolved like HL7 validator_cli 7.0.1.

The builtin validator also checks, like HL7 validator_cli 7.0.1 (same release, 1.6.0):

- **Where an extension may be used**: the extension definition's `context` (element / extension types; contexts restricted to other FHIR versions by `version-specific-use` are skipped) and `contextInvariant`. A violation is an error at the host element: `The extension <url> v<version> is not allowed to be used at this point (this element is [...]; allowed for this version = e:...)` or `... (based on context invariant '...')`. fhirpath contexts are not evaluated locally (never an error).
- An unversioned StructureDefinition resolves to the highest-version copy in the closure (e.g. the `hl7.fhir.uv.extensions.r4` extension over the R4 core one with the same URL), so the extension's own invariants (e.g. var-1 of `variable`) are checked too.
- **`Unrecognized property`** is judged against the core definitions for the whole resource (as the HL7 JSON parser does), including below a choice type the profile does not allow and inside the value of an unknown extension; like HL7, nothing is checked below an element with the wrong JSON shape (an array for a single element).
- **RxNorm**: code and display are checked against `rxnorm.concepts` (tx.fhir.org accepts every SAB=RXNORM name of the RXCUI, case-insensitively): `Wrong Display Name '...' for http://www.nlm.nih.gov/research/umls/rxnorm#<code>. Valid display is '...'`. An unknown code is an error only when the local RxNorm release is not older than tx.fhir.org's (03022026), otherwise a warning; when only the preferred name is held (imported before migration 20261030) a display mismatch is a warning; without RxNorm loaded: warning `Display not checked (RxNorm)`.
- `Unknown code` in an IG CodeSystem with `content = complete` stays an error; when another installed package has a fuller copy of the same CodeSystem containing the code (e.g. TW Core 0.3.2 `medication-nhi-tw`), an information issue names that package and version.
- A Coding element bound directly to a ValueSet (e.g. `Encounter.class`) whose system is a ValueSet URL only gets the binding warning, no `The Coding references a value set` error (as HL7).

New in 1.6.1 (validator v8, evaluation report v6):

- **An unresolvable CodeSystem URL is an error on every element**: a `Coding.system` / `Quantity.system` in the HL7 spaces (`http://hl7.org/fhir…`, `http://terminology.hl7.org/…`) that no installed package defines gets `No definition could be found for URL value '…'` at the `system` element (Coding, CodeableConcept, Encounter.class, Identifier.type, Meta.tag, extension values, contained resources and nested Bundles alike). Under `http://hl7.org/fhir/sid/…` only the HL7 validator's `SIDUtilities` list is known (ndc, icpc-2, icd-9, icd-10, cvx, srt, icd-10-cm, icd-9-cm, dsm5 …); `icd-10-pcs`, `us-mbi` etc. are not, so they get this URL error on any element (1.6.0 treated them as known and missed them). The code itself keeps the warning `A definition for CodeSystem '…' could not be found` (HL7 `UNKNOWN_CODESYSTEM`); an unknown system outside the HL7 spaces (an IG's own URLs …) also only gets that warning, as in validator_cli.
- **Whitespace in a reference** (`Patient/ 123`, a trailing blank): error `The reference '…' is not a valid reference` (HL7 `REFERENCE_REF_INVALID_REF`).
- **An RxNorm display naming another drug**: when the display shares no drug-name word with any known name of the RXCUI (preferred name + alt_names; strengths, units, dose forms, routes, salts and function words are stripped first, a ≥5-letter common prefix counts as the same word), or contains no Latin letters at all (a Chinese brand name), it is an **error** even when only the preferred name is held locally: `Wrong Display Name '…' for …#<code>. Valid display is '…'; the display denotes a different concept: …`. Another wording of the same drug (synonym, salt, form) stays a warning until `rxnorm_import` has loaded alt_names, after which it is an error as at tx.fhir.org. SNOMED / LOINC / ICD / CVX displays were already errors (validator_cli too) and are unchanged.
- **Failed lookups are never a pass**: when any definition / terminology lookup fails during a validation because of database trouble (connection lost, recovery mode, timeouts; missing tables / columns excepted), the result carries an extra error issue (`code: "exception"`, `Validation incomplete: N … lookups failed …`), `valid: false`, `checked_fully: false` and `lookups_failed`; an exception inside the validator itself now returns a normal result with a fatal `exception` issue instead of a failed tool call.
- `fhir_validate_bundle`: an entry without a usable resource (written as an array, no `resourceType`) has no `entries` row; its issues (e.g. `must be a simple value, not an Array`) are now listed in the Bundle-level `issues` instead of being lost.

### Fix suggestions (suggestions / caused_by) {#validation-suggestions}

Besides saying what is wrong, validation issues carry, where possible, "what to change it to": `suggestions` is a list of candidates ordered by `confidence` (at most 5 per issue; up to 12 for a binding error on a small ValueSet), and reference-chain errors get `caused_by`. Both are **additive** — the set of issues, their severity and message, and `valid` are unchanged; the field is absent when there is no suggestion.

```json
{"severity": "error", "path": "MedicationRequest.dosageInstruction[0].timing.repeat", "message": "Unrecognized property 'periodUnits'",
 "suggestions": [{"value": "periodUnit", "kind": "rename_property", "confidence": 0.82, "reason": "closest element name at this level: 'periodUnit'",
                  "patch": {"op": "move", "from": "MedicationRequest.dosageInstruction[0].timing.repeat.periodUnits", "path": "MedicationRequest.dosageInstruction[0].timing.repeat.periodUnit"}}]}
```

| Error | `kind` | Suggestion |
| :--- | :--- | :--- |
| `Unknown code 'X' in the CodeSystem 'http://unitsofmeasure.org'` | `replace_code` | The closest valid UCUM: case (UCUM is case-sensitive), square brackets (`[U]` → `U`, `[UI]/mL` → `[iU]/mL`), prefix + unit from the UCUM table, common clinical spellings (`mcg` → `ug`, `mmHg` → `mm[Hg]`), and an annotation for dose-form words that are not units (`tab` → `{tablet}`); every candidate is checked with the same UCUM parser the validator uses |
| `No definition could be found for URL value 'U'`, `A definition for CodeSystem 'S' could not be found`, `The Coding references a value set, not a code system` | `replace_system` | The CodeSystem(s) the misused ValueSet (or the ValueSet of that name) draws from (`…/CodeSystem/v3-ActEncounterCode` → `…/CodeSystem/v3-ActCode`), and the closest canonical in the package closure; when the Coding has a code, systems that hold it rank first |
| `Unrecognized property 'p'` | `rename_property` / `move_property` / `remove_property` | In order: the closest element name at the same level (case, spelling; datatype children and typed names of choice elements included, e.g. `value` → `valueQuantity`); the level of this resource where an element of that name actually lives (ancestors, descendants up to three levels including datatype children, sibling backbones / datatypes of an ancestor; `timing.periodUnit` → `timing.repeat.periodUnit`, `dosageInstruction[0].note` → `MedicationRequest.note`, `Patient.city` → `Patient.address[0].city`); a sibling that means the same and whose type fits the value (lower confidence; evidence from the FHIR element's `alias` / `short` and a small table of FHIR-generic synonyms: `every: 8` next to `periodUnit` → `period`, `upperLimit` in a Range → `high`, `zip` → `postalCode`, `comment` → `note`); only when none of these exists, removal (`patch.op = remove`), with a `reason` that lists the level's element names (capped at 14) and the other resource types that carry the name (`reasonCode` on an Observation → "an element of Encounter, Procedure …") |
| `The type 'date' is not allowed for Condition.onset[x]` | `rename_property` | The typed name of an allowed type that fits the value (`onsetDate` → `onsetDateTime`) |
| Value not in a required / extensible ValueSet | `choose_code` | Codes of the expanded ValueSet: all of them, ranked by similarity, for a small ValueSet; the closest to the given code / display (incl. `fhir_normalize_code`) for a large one |
| `Unknown code` in other CodeSystems | `replace_code` / `replace_system` | Spelling repairs the validator accepts (case, ICD dot, LOINC hyphen), codes whose name matches the display / text (`fhir_normalize_code`), near codes of an IG CodeSystem, and another terminology whose code shape fits (a LOINC code under the SNOMED system) |
| `Wrong Display Name` | `replace_display` (+ `replace_code`) | The valid display(s) the validator names (uniform across terminologies); if the written display is the name of another code, also a code change |
| `Unable to find a profile match for urn:uuid:X` | `caused_by` | The referenced resource's own errors (`fullUrl`, `entry`, `path`, `message`); when it has none, its errors against the profile the reference requires (with `profile`) |

`patch` uses the validator's dotted paths (`op`: `replace` / `move` / `remove`; `move` also has `from`; a move into a repeating element that does not exist yet carries `[0]`). `confidence` is a heuristic score, not a probability, but the bands per `kind` are fixed: exact / case rename > move > semantic rename > remove; suggestions are an aid — validate again after applying one. Suggestions are deterministic for the same input; if computing one fails, that issue simply has none and the validation result is unaffected. Evaluation method and figures: `node-server/scripts/suggestions-eval/`.

> In-process validation is based on profile snapshots and terminology bindings, benchmarked against HL7 validator_cli 7.0.1 (method and results in `node-server/scripts/validator-audit/`). It is not equivalent to conformance certification by the official HL7 FHIR Validator.

## Checking against the source record (grounding / completeness)

Conformance-valid is not the same as faithful: a model can fill in a diagnosis code, date or dose the record never states, and the validator still passes.
These tools compare a Bundle with the clinical record using **deterministic rules** (no LLM, no embeddings, no randomness). Code names are looked up in the local database only (ICD-10-CM / PCS, LOINC, SNOMED CT, RxNorm, CVX, IG CodeSystems); no external terminology server is called.

| Tool | Description | Key parameters |
| :--- | :--- | :--- |
| `fhir_check_grounding` | Check that every clinical fact and code in a Bundle is supported by record text (evidence map or auto-locate), with date / number / unit / ID number / dose / frequency normalisation and section, negation and history rules. The output has the `fhir_validate_bundle` shape (`entries[].issues`, `issues`) plus a `grounding` summary (units_checked, coverage …) | `bundle`, `source_text` (required), `site_config`, `evidence_map`, `mode`, `verbosity` (`warnings` by default), `policy`, `instruction_markers` |
| `fhir_check_completeness` | Gap report: for caller-supplied structured `targets` (resourceType, item, aliases, codes, date rule), decide whether the record states each required fact; returns found / missing / stated_absent / unknown, the missing list, a template follow-up question and a ready `abstention` object (insufficient_information) | `targets`, `source_text` (required), `site_config`, `extracted_facts` (facts the model claims; verified, not trusted), `instruction_markers` |

**Modes** (`fhir_check_grounding.mode`; `grounding` on `fhir_validate_*`)

| Mode | Elements with evidence | Elements without evidence |
| :--- | :--- | :--- |
| `strict` | The quote is verified (must occur verbatim in the record, value matches, section and context are right) | error `G-UNGROUNDED` |
| `auto` | Same | The tool locates supporting record text itself: information `G-AUTO-LOCATED` when found, an error when not found or found only in the wrong context |

Default: `strict` when an `evidence_map` is given, otherwise `auto`. `evidence_map` is `[{path, quote}]` or `{path: quote}`; a path may be `Bundle.entry[2].resource.code`, `entry[2].code`, `<fullUrl>|code`, omit list indices, or use `value[x]`.
Every issue carries `rule` and `source:"grounding"`, and its `message` starts with `[grounding:<RULE>]`. Instruction lines such as `【轉換目標】` (`instruction_markers`) never count as evidence; `site_config` can only support `identifier.system`.

**Grounding parameters of `fhir_validate_bundle` / `fhir_validate_resource`** (backward compatible)

- No `source_text`, or `grounding="off"`: the output is **byte-identical** to the pre-extension version.
- With `source_text`: the conformance check runs first, then grounding, and the results are merged:
  `data.conformanceValid` (the original `valid`), `data.groundingValid`, `data.valid = conformanceValid ∧ groundingValid`,
  grounding issues appended per entry to `entries[i].issues` (Bundle-level ones to `issues`), `entries[i].valid` updated,
  the `data.grounding` summary, `data.source = "builtin+grounding"` and `provenance.groundingVersion`.
- Callers should check for `data.groundingValid` in the response; if it is absent the server does not support grounding and the result must not be treated as checked.
- `fhir_validate_resource` checks the resource as the only entry of a Bundle and reports issue paths rooted at the resource (e.g. `Condition.code`); references cannot be followed, so rules that need other resources see no context.

**Versions and privacy**

- `provenance` carries `tool`, `toolVersion`, `lexiconVersion` / `lexiconSha256`, `terminologyVersion` and `sourceSha256` (first 16 hex chars of the record's SHA-256). `health_check` reports `tools_version`, `lexicon_version` and `lexicon_sha256`.
- The record text (`source_text`) and the site configuration are never written to logs, metric labels or provenance — only `sourceSha256`; malformed JSON request bodies are not logged either.

> The rules and the lexicon (`tw-lexicon`) follow Taiwanese clinical writing; `fhir_check_completeness` needs the caller to read the conversion target and pass `targets` — it does not parse natural-language targets. Results support review; they do not replace a clinician.

## Tool versions {#tool-versions}

Tools whose behaviour is pinned by fixtures carry their own version (`node-server/src/toolVersions.ts`), bumped whenever their output for the same input changes. `health_check` reports the current values under `tools_version`; every other tool uses the server version (`version`, currently `1.1.0`).

| Tool | Version |
| :--- | :--- |
| `fhir_validate_resource`, `fhir_validate_bundle` | 1.6.1 (validator v8: unknown HL7-space CodeSystems always errors, whitespace in references, RxNorm displays naming another drug, `exception` issues for failed lookups / crashes; 1.6.0: issue `suggestions` / `caused_by`) |
| `fhir_get_profile_required_elements` | 1.3.0 (derived rows: allowedCodes + derivation rule; `include_mustsupport="defaults"`; `optional`) |
| `fhir_list_igs`, `fhir_list_artifacts`, `fhir_search_artifacts`, `fhir_list_resource_profiles` (new `compact`) | 1.3.0 |
| `fhir_get_ig`, `fhir_rank_resource_profiles`, `fhir_get_profile`, `fhir_get_profile_elements`, `fhir_get_valueset`, `fhir_expand_valueset`, `fhir_validate_code`, `fhir_get_resource_skeleton` | 1.2.0 |
| `fhir_finalize_resource` | 1.3.1 (validation rules as `fhir_validate_resource` 1.6.1; 1.3.0: validation issue `suggestions` / `caused_by`) |
| `fhir_lookup_code` | 1.3.2 (RxNorm codes) |
| `fhir_normalize_code` | 1.8.0 (excerpt CodeSystems → the installed full copy, candidate `linked`, aliases resolved outside the default IG) |
| `fhir_check_grounding` | 1.1.0 |
| `fhir_check_completeness` | 1.1.1 |
