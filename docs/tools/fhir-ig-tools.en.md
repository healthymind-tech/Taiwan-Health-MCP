# FHIR IG Tools

A general, IG-scoped toolset built on the multi-IG `fhir.*` store, used to explore Implementation Guides, read profiles and terminology, perform terminology validation, and produce and validate FHIR R4 resources through skeleton-fill authoring.

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
- For the module concepts and the suggested workflow, see [FHIR IG Service](../modules/fhir-ig-service.md).

## IG discovery
| Tool | Description | Key parameters |
| :--- | :--- | :--- |
| `fhir_list_igs` | List installed IG packages (packageId / version / title / canonical / fhirVersion / status / isDefault / `installOrigin` (`manual` = installed by an operator, `dependency` = fetched for another IG's dependencies) / dependencies) | — |
| `fhir_get_ig` | Details for a single IG: dependencies and artifact counts per resource type; `data.deps_missing` lists uninstalled dependencies | `package_id`, `version` |
| `fhir_list_artifacts` | List a summary of the IG's conformance artifacts | `resource_type`, `grouping_id`, `all_packages`, `limit` (50 by default, 200 maximum) |
| `fhir_search_artifacts` | Full-text search over artifacts by id / canonical / name / title / description | `keyword`, `resource_type`, `all_packages`, `limit` (20 by default, 100 maximum) |

## Profile selection and reading
| Tool | Description | Key parameters |
| :--- | :--- | :--- |
| `fhir_list_resource_profiles` | List selectable resource profiles, grouped by the base resource type they constrain | `base_type`, `all_packages` |
| `fhir_rank_resource_profiles` | Rank by how well source field keys match profile element paths (advisory only, `selectionRequired:true`) | `keys`, `base_type`, `limit` (5 by default, 20 maximum) |
| `fhir_get_profile` | Summary of a single profile (identity / base / derivation / element count), resolvable by id, canonical, or key; a canonical may be pinned as `url|version` (an uninstalled version is `ARTIFACT_NOT_FOUND`) | `identifier` |
| `fhir_get_profile_elements` | Read the profile snapshot; `view` = `elements` / `element` / `slices` / `choices` / `binding` / `examples` | `profile`, `view`, `path`, `slice_name`, `limit` |
| `fhir_get_profile_required_elements` | List the elements a profile *effectively* requires: required only when the whole parent chain is required, required slices, choice types, invariant-implied value[x]-or-dataAbsentReason (vs-2 / vs-3 / tw-core-4 style, detected from the expression), and target-implied primary content; each row carries `grounding_class` (auto / coding / source_fact / workflow_default …), `required_by`, `allowedCodes` for small required bindings and a fill `hint`. Profiled extensions are expanded from their definitions (url, value[x] via ext-1, required sub-extensions), base-datatype children of populated elements are added (Narrative.div, Extension.url …), and profile-specific error invariants are listed under `invariants`. With `instance`, slices are matched by their discriminators, so absent slices add nothing | `profile`, `instance` (draft: populated optional parents add their required children), `include_target_implied` (`true` by default), `include_mustsupport` (`false` by default), `verbosity` (`compact` by default: id / required_by / grounding_class / fixed·pattern·value / choices / allowedCodes / hint, profile-pinned subtrees folded into one copyable `value`; `full` adds min / max / types / binding / mustSupport) |

## Terminology / ValueSet
| Tool | Description | Key parameters |
| :--- | :--- | :--- |
| `fhir_get_valueset` | ValueSet definition summary | `identifier` |
| `fhir_expand_valueset` | Expand a ValueSet and list its member codes (resolved locally where possible; whole large external code systems are not enumerated — `TOO_BROAD`) | `identifier`, `limit` (500 by default, 2000 maximum) |
| `fhir_lookup_code` | Look up a single code's display name and properties in a CodeSystem | `system`, `code` |
| `fhir_validate_code` | Validate whether a `system`+`code` belongs to a given ValueSet; returns `valid` / `invalid` / `unverifiable`; `value_set` may be pinned as `url|version` | `system`, `code`, `value_set` |
| `fhir_normalize_code` | Match free text against a ValueSet and return the most appropriate standard code | `text`, `value_set`, `system`, `limit` (10 by default) |

## Authoring, assembly, and validation
| Tool | Description | Key parameters |
| :--- | :--- | :--- |
| `fhir_get_resource_skeleton` | Generate an empty draft from a profile containing only required / mustSupport structure; `required` is the element's own min≥1, `effectiveRequired` also requires every ancestor to be required | `profile`, `candidate_limit` (20 by default, capped at 100), `include_examples` (`true` by default) |
| `fhir_finalize_resource` | Finalise a draft against its profile and return the complete resource | `profile`, `draft`, `context_id`, `key`, `generate_narrative` (`true` by default) |
| `fhir_resolve_reference` | Resolve resource references by temporary key (for linking inside a Bundle) | `key`, `resource_type`, `context_id`, `display` |
| `fhir_build_bundle` | Assemble several resources into a Bundle | `entries`, `bundle_type` (`transaction` by default), `context_id` |
| `fhir_validate_resource` | Validate a single resource (structure + terminology bindings); falls back to `meta.profile` when `profile` is omitted. An optional `source_text` adds a grounding check (see below) | `resource`, `profile`, `source_text`, `site_config`, `evidence_map`, `grounding`, `grounding_verbosity` |
| `fhir_validate_bundle` | Validate an entire Bundle (each entry against its `meta.profile`, plus reference integrity inside the Bundle). An optional `source_text` adds a grounding check and merges the results (see below) | `bundle`, `source_text`, `site_config`, `evidence_map`, `grounding`, `grounding_verbosity` |

`fhir_validate_resource` / `fhir_validate_bundle` also report whether validation was complete: `checked_fully` (`true` when every profile and ValueSet was checked and the dependency closure is complete), `profiles_unchecked`, `valuesets_unchecked`. `valid` keeps HL7 semantics (an unresolvable profile is only a warning), so `valid: true` with `checked_fully: false` means part of the content was not checked. `|version` canonicals (`meta.profile`, binding, targetProfile, type profile, extension url) are resolved like HL7 validator_cli 7.0.1.

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
| `fhir_validate_resource`, `fhir_validate_bundle` | 1.4.0 |
| `fhir_get_profile_required_elements` | 1.2.0 |
| `fhir_list_igs`, `fhir_get_ig`, `fhir_list_artifacts`, `fhir_search_artifacts`, `fhir_list_resource_profiles`, `fhir_rank_resource_profiles`, `fhir_get_profile`, `fhir_get_profile_elements`, `fhir_get_valueset`, `fhir_expand_valueset`, `fhir_lookup_code`, `fhir_validate_code`, `fhir_normalize_code`, `fhir_get_resource_skeleton`, `fhir_finalize_resource` | 1.2.0 |
| `fhir_check_grounding`, `fhir_check_completeness` | 1.1.0 |
