# FHIR IG Service

## Overview
The FHIR IG service is a general, IG-scoped toolset built on top of the multi-IG `fhir.*` data store. It lets an LLM explore installed Implementation Guides, read profiles (StructureDefinition) and terminology (ValueSet / CodeSystem), perform terminology validation, and produce and validate profile-conformant FHIR R4 resources through a "skeleton-fill" approach. The default IG is TWCore v1.0.0, but multiple IGs can be installed and switched between.

Every tool accepts an optional `package_id` + `version`, and responses use a shared envelope: `{ok, data, warnings, provenance, error?}`.

### How the target package is resolved
When not stated explicitly, a tool picks the IG package in this order and records the outcome in `provenance.resolved_by`:

1. `explicit_version`: a canonical argument (or `meta.profile`) carries `|version` and an installed package holds that version — there is **no** silent fallback to another version;
2. `package_arg`: the caller passed `package_id` (+ `version`); `latest`: `package_id` without a version → that package's highest release;
3. `meta_profile`: no `package_id` — the package owning the resource's `meta.profile` (validation tools);
4. `canonical_owner`: no `package_id` — the package owning a canonical argument (profile / ValueSet / system);
5. `default_ig`: the default IG;
6. `sole_manual_ig`: no default IG is set and exactly one IG was installed manually.

If none applies the error code is `NO_DEFAULT_IG` (no arbitrary package is picked). Versions compare by SemVer 2.0 precedence (FHIR labels such as `-ballot`, `-snapshot1`, `-cibuild` are pre-releases); `|version` matches by the HL7 rule (exact, else the highest of the same major.minor, else a wildcard). Declared dependencies that are not installed are listed in `data.deps_missing`; when one package appears at several versions in a closure, `provenance.closure_versions` shows which one canonical lookup uses.

## Tool groups

### 1. IG discovery
- **`fhir_list_igs`**: lists installed IG packages with `packageId`, `version`, `title`, `canonical`, `fhirVersion`, `status`, `isDefault`, and declared dependencies. Use this first to pick an IG when several coexist.
- **`fhir_get_ig`**: details for a single IG, including identity, dependencies, and artifact counts per resource type.
- **`fhir_list_artifacts`**: lists an IG's conformance artifacts in summary form (StructureDefinition / ValueSet / CodeSystem / examples…), filterable by `resource_type` or `grouping_id`.
- **`fhir_search_artifacts`**: full-text search over artifacts by id, canonical URL, name, title, or description.

### 2. Profile selection and reading
- **`fhir_list_resource_profiles`**: lists the IG's selectable resource profiles (constraint StructureDefinitions), grouped by the base resource type they constrain (for example `Patient` → `Patient-twcore`).
- **`fhir_rank_resource_profiles`**: ranks candidate profiles by how well the source field keys you intend to populate match each profile's element paths. This tool is **advisory only** — the response carries `selectionRequired:true`, and you must still make the final choice; it never maps automatically.
- **`fhir_get_profile`**: summary of a single profile / StructureDefinition (identity, base definition, derivation, element count). Resolvable by artifact id, canonical URL, or artifact_key; canonicals defined by dependency IGs resolve transitively.
- **`fhir_get_profile_required_elements`**: every element the profile effectively requires (min≥1 under required ancestors, required slices, choice types, invariant-implied value-or-dataAbsentReason, plus target-implied primary content), each row classified by where its value comes from (`auto` / `coding` / `source_fact` / `workflow_default`) with a fill hint. `verbosity=compact` (default) or `full`; an optional `instance` (draft) makes the min≥1 children of optional parents it populates required too. Call it before writing a resource so every required field is filled.
- **`fhir_get_profile_elements`**: reads the structural truth of a profile snapshot (cardinality, types, bindings, slicing, choice[x], constraints). One tool offers several `view` values: `elements`, `element`, `slices`, `choices`, `binding`, `examples`.

### 3. Terminology / ValueSet
- **`fhir_get_valueset`**: retrieve a ValueSet definition summary.
- **`fhir_expand_valueset`**: expand a ValueSet and list the actual member codes.
- **`fhir_lookup_code`**: look up a single code's display name and properties in a given CodeSystem.
- **`fhir_validate_code`**: validate whether a `system`+`code` belongs to a given ValueSet.
- **`fhir_normalize_code`**: match free text (for example「流行性感冒」/ influenza) against a ValueSet or code system and return ranked candidate codes. For CodeSystems of installed IGs (e.g. the NHI payment codes) it uses the [IG Concept Search](ig-concept-search.md) engine.

### 4. Authoring, assembly, and validation
- **`fhir_get_resource_skeleton`**: generate a "skeleton" resource from a profile — an empty draft containing only required / mustSupport structure, for filling in step by step.
- **`fhir_finalize_resource`**: finalise a draft against its profile, completing the structure and returning the full resource.
- **`fhir_resolve_reference`**: resolve resource references by temporary key, so resources can link to each other inside a Bundle.
- **`fhir_build_bundle`**: assemble several resources into a Bundle of type `transaction`, `collection`, and so on.
- **`fhir_validate_resource`**: validate a single resource against the profile named in `meta.profile` (structure + terminology bindings).
- **`fhir_validate_bundle`**: validate a whole Bundle (each entry against its `meta.profile`, plus reference integrity inside the Bundle).
- Both validation tools report how complete the check was: `checked_fully`, `profiles_unchecked`, `valuesets_unchecked` (`valid` keeps the HL7 meaning; a profile or ValueSet that could not be checked is flagged rather than silently passed). The optional `source_text` / `site_config` / `evidence_map` parameters add grounding issues; without them the output is identical to the output before grounding existed.

### 5. Record faithfulness (grounding — deterministic, no LLM)
- **`fhir_check_grounding`**: checks a Bundle against the source clinical record text — every populated clinical fact and code must be supported by the record (evidence map or auto-locate), with date / number / unit / identifier / dose / frequency normalisation and section, negation and history rules; issues come back in the `fhir_validate_bundle` shape.
- **`fhir_check_completeness`**: a gap report — compares the facts the conversion targets require (profile-required plus target-implied elements) with what the record states, and returns the missing items, the record lines that state absence, a template clarification question and a ready `insufficient_information` object.

`source_text` is clinical data: the server **never logs its content** (only its SHA-256). Per-tool versions live in `node-server/src/toolVersions.ts` and are reported by `health_check` under `tools_version`.

## Technical architecture
- **Data source**: FHIR IG packages (`package.tgz`), installed from the package registry or uploaded as a tgz on the **FHIR → IG packages** page of the admin console (import stage `ig_import`). Declared dependency IGs (such as `hl7.terminology.r4` and `hl7.fhir.r4.core`) are **downloaded automatically from the FHIR registry** (default `https://packages.fhir.org`, falling back to `https://packages2.fhir.org`; the registry address is set under **Integrations → External services**) and each is indexed as a package-scoped IG, so cross-system ValueSet bindings expand to real codes. Upload a dependency by hand only when the registry cannot supply it.
- **Install origin**: `fhir.ig_packages.install_origin` records whether a package was installed by an operator (`manual`) or fetched to satisfy another IG's dependencies (`dependency`), and `installed_for` records which IG pulled it in (migration `20261019_ig_install_origin.sql`); `manual` is sticky on re-import. The IG page lists missing dependencies and dependencies nothing uses any more.
- **Deletion protection**: removing a package that another installed IG depends on (directly or transitively), or removing the default IG, is refused by default; the operator must name a new default (`new_default`) or pass `force` explicitly (recorded in the audit log).
- **Database**: the `fhir` schema — `ig_packages`, `codesystems`, `concepts`, and `artifacts` (all package-scoped, supporting multiple IGs). The IG detail view in the admin console can browse the concept tree of a CodeSystem inside an IG (`/admin/api/terminology/ig/*`).
- **Validation engine**: `fhirValidator.ts` / `fhirTerminology.ts` / `fhirSnapshot.ts` / `fhirReference.ts` / `fhirAuthoring.ts` perform snapshot generation, terminology binding checks, reference resolution, and skeleton-fill authoring in process. The rules are benchmarked against HL7 `validator_cli` 7.0.1 + tx.fhir.org, compared item by item over a corpus (audit record: `node-server/scripts/validator-audit/REPORT.md`). Offline terminology: ICD-10-CM / WHO ICD-10 (`icd.*`), LOINC (including LA/LP/LL/LG), SNOMED CT (including inactive content), RxNorm, CVX (built in, 287 codes, version 20250715), ISO 3166 (built in, version 2018), and UCUM (grammar check with `@lhncbc/ucum-lhc`; if the library cannot load, the code is reported unchecked, never invalid).

## Suggested authoring workflow
1. `fhir_list_igs` → select the target IG (when necessary).
2. `fhir_list_resource_profiles` / `fhir_rank_resource_profiles` → pick a profile.
3. `fhir_get_profile_elements` (`choices` / `binding` / `slices`) → understand the structure and terminology constraints.
4. `fhir_get_profile_required_elements` → confirm the required elements; `fhir_get_resource_skeleton` → get the skeleton and fill fields in step by step (use `fhir_normalize_code` / `fhir_validate_code` for coding as needed).
5. `fhir_finalize_resource` → finalise; assemble multiple resources with `fhir_resolve_reference` + `fhir_build_bundle`.
6. `fhir_validate_resource` / `fhir_validate_bundle` → validate (pass `source_text` when the source record is available, or call `fhir_check_grounding` / `fhir_check_completeness`).

## Key limitations
- In-process validation is based on profile snapshots and terminology bindings. Although it is benchmarked against HL7 validator_cli 7.0.1, it is **not** equivalent to conformance certification by the official HL7 FHIR Validator.
- The tools offer suggestions and structural assistance only; profile selection and final content remain the caller's responsibility.

> For an in-depth walkthrough see [FHIR Authoring Walkthrough](../fhir-authoring-walkthrough.md).
