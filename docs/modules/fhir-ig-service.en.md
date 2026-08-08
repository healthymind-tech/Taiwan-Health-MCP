# FHIR IG Service

## Overview
The FHIR IG service is a general, IG-scoped toolset built on top of the multi-IG `fhir.*` data store. It lets an LLM explore installed Implementation Guides, read profiles (StructureDefinition) and terminology (ValueSet / CodeSystem), perform terminology validation, and produce and validate profile-conformant FHIR R4 resources through a "skeleton-fill" approach. The default IG is TWCore v1.0.0, but multiple IGs can be installed and switched between.

Every tool accepts an optional `package_id` + `version` (omitting both pins it to the default IG), and responses use a shared envelope: `{ok, data, warnings, provenance, error?}`.

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
- **`fhir_get_profile_elements`**: reads the structural truth of a profile snapshot (cardinality, types, bindings, slicing, choice[x], constraints). One tool offers several `view` values: `elements`, `element`, `slices`, `choices`, `binding`, `examples`.

### 3. Terminology / ValueSet
- **`fhir_get_valueset`**: retrieve a ValueSet definition summary.
- **`fhir_expand_valueset`**: expand a ValueSet and list the actual member codes.
- **`fhir_lookup_code`**: look up a single code's display name and properties in a given CodeSystem.
- **`fhir_validate_code`**: validate whether a `system`+`code` belongs to a given ValueSet.
- **`fhir_normalize_code`**: match free text (for example「流行性感冒」/ influenza) against a ValueSet and return the most appropriate standard code.

### 4. Authoring, assembly, and validation
- **`fhir_get_resource_skeleton`**: generate a "skeleton" resource from a profile — an empty draft containing only required / mustSupport structure, for filling in step by step.
- **`fhir_finalize_resource`**: finalise a draft against its profile, completing the structure and returning the full resource.
- **`fhir_resolve_reference`**: resolve resource references by temporary key, so resources can link to each other inside a Bundle.
- **`fhir_build_bundle`**: assemble several resources into a Bundle of type `transaction`, `collection`, and so on.
- **`fhir_validate_resource`**: validate a single resource against the profile named in `meta.profile` (structure + terminology bindings).
- **`fhir_validate_bundle`**: validate an entire Bundle.

## Technical architecture
- **Data source**: FHIR IG packages (`package.tgz`), imported through the admin console (Admin → Modules / IG, import stage `ig_import`). Dependency packages (such as `hl7.terminology.r4` and `hl7.fhir.r4.core`) can be bound additionally and are each indexed as package-scoped IGs, so cross-system ValueSet bindings expand to real codes.
- **Database**: the `fhir` schema — `ig_packages`, `codesystems`, `concepts`, and `artifacts` (all package-scoped, supporting multiple IGs).
- **Validation engine**: `fhirValidator.ts` / `fhirTerminology.ts` / `fhirSnapshot.ts` / `fhirReference.ts` / `fhirAuthoring.ts` perform snapshot generation, terminology binding checks, reference resolution, and skeleton-fill authoring in process.

## Suggested authoring workflow
1. `fhir_list_igs` → select the target IG (when necessary).
2. `fhir_list_resource_profiles` / `fhir_rank_resource_profiles` → pick a profile.
3. `fhir_get_profile_elements` (`choices` / `binding` / `slices`) → understand the structure and terminology constraints.
4. `fhir_get_resource_skeleton` → get the skeleton and fill fields in step by step (use `fhir_normalize_code` / `fhir_validate_code` for coding as needed).
5. `fhir_finalize_resource` → finalise; assemble multiple resources with `fhir_resolve_reference` + `fhir_build_bundle`.
6. `fhir_validate_resource` / `fhir_validate_bundle` → validate.

## Key limitations
- In-process validation is based on profile snapshots and terminology bindings. It is **not** equivalent to conformance certification by the official HL7 FHIR Validator.
- The tools offer suggestions and structural assistance only; profile selection and final content remain the caller's responsibility.

> For an in-depth walkthrough see [FHIR Authoring Walkthrough](../fhir-authoring-walkthrough.md).
