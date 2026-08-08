# FHIR IG Tools

A general, IG-scoped toolset built on the multi-IG `fhir.*` store, used to explore Implementation Guides, read profiles and terminology, perform terminology validation, and produce and validate FHIR R4 resources through skeleton-fill authoring.

## Shared conventions
- Every tool accepts an optional `package_id` + `version`; omitting both pins it to the **default IG** (`isDefault`).
- Responses use a shared envelope: `{ok, data, warnings, provenance, error?}`.
- For the module concepts and the suggested workflow, see [FHIR IG Service](../modules/fhir-ig-service.md).

## IG discovery
| Tool | Description | Key parameters |
| :--- | :--- | :--- |
| `fhir_list_igs` | List installed IG packages (packageId / version / title / canonical / fhirVersion / status / isDefault / dependencies) | — |
| `fhir_get_ig` | Details for a single IG plus artifact counts per resource type | `package_id`, `version` |
| `fhir_list_artifacts` | List a summary of the IG's conformance artifacts | `resource_type`, `grouping_id`, `limit` (50 by default, 200 maximum) |
| `fhir_search_artifacts` | Full-text search over artifacts by id / canonical / name / title / description | `keyword`, `resource_type`, `limit` (20 by default, 100 maximum) |

## Profile selection and reading
| Tool | Description | Key parameters |
| :--- | :--- | :--- |
| `fhir_list_resource_profiles` | List selectable resource profiles, grouped by the base resource type they constrain | `base_type` |
| `fhir_rank_resource_profiles` | Rank by how well source field keys match profile element paths (advisory only, `selectionRequired:true`) | `keys`, `base_type`, `limit` (5 by default, 20 maximum) |
| `fhir_get_profile` | Summary of a single profile (identity / base / derivation / element count), resolvable by id, canonical, or key | `identifier` |
| `fhir_get_profile_elements` | Read the profile snapshot; `view` = `elements` / `element` / `slices` / `choices` / `binding` / `examples` | `profile`, `view`, `path`, `slice_name`, `limit` |

## Terminology / ValueSet
| Tool | Description | Key parameters |
| :--- | :--- | :--- |
| `fhir_get_valueset` | ValueSet definition summary | `identifier` |
| `fhir_expand_valueset` | Expand a ValueSet and list its member codes | `identifier`, `limit` |
| `fhir_lookup_code` | Look up a single code's display name and properties in a CodeSystem | `system`, `code` |
| `fhir_validate_code` | Validate whether a `system`+`code` belongs to a given ValueSet | `system`, `code`, `value_set` |
| `fhir_normalize_code` | Match free text against a ValueSet and return the most appropriate standard code | `text`, `value_set`, `system`, `limit` (10 by default) |

## Authoring, assembly, and validation
| Tool | Description | Key parameters |
| :--- | :--- | :--- |
| `fhir_get_resource_skeleton` | Generate an empty draft from a profile containing only required / mustSupport structure | `profile`, `candidate_limit` (20 by default, capped at 100), `include_examples` (`true` by default) |
| `fhir_finalize_resource` | Finalise a draft against its profile and return the complete resource | `profile`, `draft`, `context_id`, `key`, `generate_narrative` (`true` by default) |
| `fhir_resolve_reference` | Resolve resource references by temporary key (for linking inside a Bundle) | `key`, `resource_type`, `context_id`, `display` |
| `fhir_build_bundle` | Assemble several resources into a Bundle | `entries`, `bundle_type` (`transaction` by default), `context_id` |
| `fhir_validate_resource` | Validate a single resource (structure + terminology bindings); falls back to `meta.profile` when `profile` is omitted | `resource`, `profile` |
| `fhir_validate_bundle` | Validate an entire Bundle | `bundle` |

> In-process validation is based on profile snapshots and terminology bindings. It is not equivalent to conformance certification by the official HL7 FHIR Validator.
