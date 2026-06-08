# FHIR IG MCP Toolset — Data-Readiness Assessment & Multi-IG Design

**Status:** assessment / planning (no code changes yet)
**Date:** 2026-06-07
**Scope:** the 25-tool FHIR-IG-driven MCP server spec (IG Discovery → Profile Selection → StructureDefinition → Terminology → Mapping → Reference/Bundle → Validation), evaluated against what this repo currently stores, with the raw source at `fhir-code/twcoreig/v1.0.0/package.tgz` as the fallback truth.
**Forward constraint:** the platform will import **multiple IG packages** in future. Every tool below is designed IG-scoped from day one (`ig = {packageId, version}` selector), not hardcoded to TW Core.

---

## 0. TL;DR verdict

The raw data we need is **almost entirely already in the database**. The TWCore admin import (`src/admin_jobs.py` → `twcore.artifacts`) ingests **every `.json` resource** in `package.tgz` and stores the **complete FHIR JSON in `twcore.artifacts.raw_json` (JSONB)** — StructureDefinitions *with their full `snapshot.element`* (bindings, slicing, choice types), ValueSets *with `compose`*, CodeSystems, ConceptMaps, SearchParameters, the ImplementationGuide, CapabilityStatements, and all 98 examples. CodeSystem concepts are additionally parsed into `twcore.concepts`.

So for **17 of 25 tools the data is fully present** — they need parsing/serving code, not new data. After the design decisions below, **no external service is required** and there is **no stored-mapping gap**:

| Gap | Tools affected | Why | In `package.tgz`? |
|---|---|---|---|
| **A built-in validator** (in-process Python) | 24, 25 | Conformance checking (structure + terminology + FHIRPath invariants + slicing) — written natively in Python, **no Java sidecar, no external service** (see §3 Gap 1). All inputs (snapshot, constraint expressions, slicing rules, extension defs) are already in `raw_json`; FHIRPath is handled in-process via the pure-Python `fhirpathpy` library. | ✅ Data present; only serving code to write |
| **ValueSet expansion of external/filtered content** | 15, 16, 17 | Many TWCore ValueSets are `filter`-based over `http://snomed.info/sct` or reference HL7 THO systems, not inline enumerations. Inline + locally-held systems (we have SNOMED/LOINC/ICD schemas) expand fine; the rest need an imported dependency package or an external terminology server. | ⚠️ Partial — design already returns `TERMINOLOGY_SERVER_REQUIRED` |

**No stored mapping templates.** The original spec's tools 19–21 (`get_mapping_template` / `plan_mapping` / `apply_mapping`) assumed a deterministic, pre-approved source→FHIR rule store — a pre-LLM construct. We **replace** that with **schema-guided fill** (§3 Gap 2): the server emits a blanked, annotated skeleton derived live from the profile's snapshot, the LLM fills the *semantic* blanks, and the system deterministically pins the *mechanical* ones + validates. This **erases the only "no source data anywhere" gap** — no new mapping schema, no admin authoring UI. Everything else is a parsing/serving exercise over data we already hold.

---

## 1. What we actually store today (data inventory)

### 1.1 `twcore.artifacts` — the goldmine
`src/admin_jobs.py` (the TWCore import) walks every `package/*.json` member, and for each resource with a `resourceType` writes one row:

```
twcore.artifacts(
  artifact_key PK,            -- "{resourceType}/{id}"  ← NOTE: not package-scoped (multi-IG problem, §4)
  resource_type, artifact_id, canonical_url, name, title, status,
  kind, base_type, derivation,
  grouping_id, grouping_name, -- from the IG's definition.grouping
  description, package_path,
  child_count, concept_count,
  raw_json JSONB,             -- ★ the COMPLETE FHIR resource
  imported_at
)
```

Verified against `package.tgz`:
- **StructureDefinition-Condition-twcore**: `raw_json` carries `snapshot.element` (47 elements) and `differential.element` (35). Bindings (`element.binding.strength` + `valueSet`), slicing (`element.slicing.discriminator/rules`), and choice types (`Condition.onset[x]` → `[dateTime, Age, Period, Range, string]`) are all inside that snapshot. → **Tools 7–13 are fully backed.**
- **ValueSets** are stored as artifacts → `raw_json.compose`. → Tools 14 backed; 15/16/17 partial (see §3).
- **98 examples** are stored as artifacts too (their `resource_type` is the instance type, e.g. `AllergyIntolerance`, `Bundle`, `Condition`; they carry `meta.profile`). → **Tool 12 backed** by matching `raw_json.meta.profile`.
- **ImplementationGuide**, **CapabilityStatement**, **SearchParameter**, **OperationDefinition**, **ConceptMap (×6)** — all present as artifacts with full raw_json.
- FTS GIN index already exists on `artifact_id|canonical_url|name|title|...`.

### 1.2 `twcore.codesystems` + `twcore.concepts` — parsed terminology
```
twcore.codesystems(cs_id PK, name, category, fetched_at, concept_count)
twcore.concepts(id, cs_id FK, code, display, definition)   -- GIN FTS on code+display
```
Populated for IG-defined CodeSystems (e.g. `category-code-tw`, the NHI/SNOMED-TW systems). → Tools 16 (lookup), 14/15 inline expansion backed for IG-internal systems.

### 1.3 Already-shipped service methods (`src/twcore_service.py`)
`list_codesystems`, `search_code`, `lookup_code`, `search_artifacts`, `get_artifact(include_raw)`. These already cover the *substrate* for tools 3, 4, 14, 16 and the discovery half of 7.

### 1.4 Cross-domain terminology we hold elsewhere (matters for expansion/lookup)
Separate schemas `snomed.*`, `loinc.*`, `icd.*` hold full SNOMED CT / LOINC / ICD content. Because many TWCore ValueSets filter over SNOMED, **we can do more local expansion than a naïve "IG-only" reading suggests** — if we wire the ValueSet filter executor to those schemas.

---

## 2. Per-tool readiness matrix (25 tools)

Legend: ✅ data fully present (needs serving code only) · 🟡 partial / needs derived logic or optional dependency package · 🔴 needs new storage or an external engine (data not in the IG).

### A. IG Discovery
| # | Tool | Status | Data source / gap |
|---|---|---|---|
| 1 | `fhir_list_igs` | 🟡 | Identity (packageId/version/canonical/fhirVersion) lives in `package.json` + the ImplementationGuide raw_json, but there is **no IG registry table** and no package columns yet. Needs `fhir.ig_packages` (§4). |
| 2 | `fhir_get_ig` | 🟡 | `dependencies` + `fhirVersion` from ImplementationGuide raw_json; `artifactCounts` = `GROUP BY resource_type`. Needs the registry. |
| 3 | `fhir_list_artifacts` | ✅ | `twcore.artifacts` directly. Largely = existing `search_artifacts(list mode)`. |
| 4 | `fhir_search_artifacts` | ✅ | Existing `search_artifacts` + FTS index. |

### B. Profile Selection
| # | Tool | Status | Data source / gap |
|---|---|---|---|
| 5 | `fhir_list_resource_profiles` | ✅ | `WHERE resource_type='StructureDefinition' AND kind='resource' AND derivation='constraint'`, group by `base_type`. All columns present. |
| 6 | `fhir_rank_resource_profiles` | 🟡 | New scoring logic: match input keys against profile element paths (parsed from snapshot). No external data; pure derivation. Must return candidates + `selectionRequired:true`, never auto-map. |
| 7 | `fhir_get_profile` | ✅ | artifact columns + `raw_json.meta`. |

### C. StructureDefinition — **consolidated into one tool with a `view` param** (all parse `raw_json.snapshot.element`, data 100% present)
**Decided:** spec tools 8–13 (the six snapshot readers, including `get_element_binding` from group D) collapse into a single `fhir_get_profile_elements(profile, view, path?)`. This sets the **toolset-wide granularity rule: multiple read-views of the same underlying data fold behind a `view`/`mode` param** to keep `tools/list` lean (it stacks on the existing 29 tools). Each spec tool becomes a `view` value:
| `view` | replaces spec tool | returns |
|---|---|---|
| `elements` (default) | 8 `get_profile_elements` | full LLM-friendly element projection (min/max/types/mustSupport/binding/fixed/pattern/constraints) |
| `element` | 9 `get_element` | single element by `path` (+ `sliceName`) |
| `slices` | 10 `get_element_slices` | `element.slicing` + slice children (verified, e.g. `Condition.code.extension`) |
| `choices` | 11 `get_choice_types` | `[x]` element types + `jsonProperty` + input-type recommendation (verified `Condition.onset[x]`) |
| `binding` | 13 `get_element_binding` | `element.binding` strength + valueSet |
| `examples` | 12 `get_profile_examples` | example artifacts where `raw_json.meta.profile` contains the canonical |

`path` is required for `element`/`slices`/`choices`/`binding`; omitted for `elements`/`examples`. All ✅ — data fully present.

### D. Terminology
| # | Tool | Status | Data source / gap |
|---|---|---|---|
| 13 | ~~`fhir_get_element_binding`~~ → `view:"binding"` | ✅ | Folded into the consolidated `fhir_get_profile_elements` (group C). |
| 14 | `fhir_get_valueset` | ✅ | ValueSet artifact `raw_json.compose`. |
| 15 | `fhir_expand_valueset` | 🟡 | Inline `compose.include.concept` → ✅. SNOMED `filter` (is-a etc.) → executable against `snomed.*` with new filter logic. HL7 THO / external → only if the dependency package is imported (optional source roles `twcore_tho`, `twcore_fhir_core` already exist), else return `TERMINOLOGY_SERVER_REQUIRED`. |
| 16 | `fhir_lookup_code` | 🟡 | IG systems → `twcore.concepts`; SNOMED/LOINC/ICD → cross-schema lookup; truly external → `found:null` + warning (must **not** fabricate display). |
| 17 | `fhir_validate_code` | 🟡 | Membership check = expand-then-contains; same coverage profile as #15. |
| 18 | `fhir_normalize_code` | 🟡 | We have embeddings (semantic match) + `twcore.concepts` (alias/display) + 6 ConceptMaps. New recommender logic; output must be re-validated by #17. |

### E. Mapping — **redesigned: schema-guided fill (no stored templates)**
The spec's 19–21 are **dropped** and replaced by two template-free tools (§3 Gap 2). The LLM does the semantic mapping; the system does the mechanical pinning + validation.
| # | Tool | Status | Data source / gap |
|---|---|---|---|
| ~~19~~ | ~~`fhir_get_mapping_template`~~ | ❌ removed | Stored-template concept dropped (pre-LLM construct). |
| ~~20~~ | ~~`fhir_plan_mapping`~~ | ❌ removed | Superseded by skeleton + validator loop. |
| ~~21~~ | ~~`fhir_apply_mapping`~~ | ❌ removed | Superseded by `fhir_finalize_resource`. |
| 19′ | `fhir_get_resource_skeleton` | ✅ | Blanked, annotated fill-form projected live from `snapshot.element` (path, cardinality, type, choice[x] property, required-binding ValueSet **+ candidate codes**, fixed/pattern marked auto-pinned, slicing, mustSupport, short, + official examples as few-shot). Data 100% present. |
| 20′ | `fhir_finalize_resource` | 🟡 | Deterministic step over the LLM-filled draft: pin `fixed`/`pattern`/`meta.profile`, attach validated-code `system` URLs, resolve references (#22), run the built-in validator (#24), return `{resource, validation, trace}`. Pure logic; no stored mapping. |

### F. Reference / Bundle
| # | Tool | Status | Data source / gap |
|---|---|---|---|
| 22 | `fhir_resolve_reference` | 🟡 | Pure logic, but needs an ephemeral **reference-context store** (per build session, keyed by `referenceContextId`). No IG data. |
| 23 | `fhir_build_bundle` | 🟡 | Pure logic (urn:uuid rewrite, reference map). Bundle profiles exist in IG for later validation. Data-wise ✅. |

### G. Validation
| # | Tool | Status | Data source / gap |
|---|---|---|---|
| 24 | `fhir_validate_resource` | 🟡 | Built **in-process in Python** (§3 Gap 2): structure (cardinality/required/type/fixed/pattern) + binding membership + FHIRPath invariants via `fhirpathpy` + common slicing. No Java, no sidecar. All inputs in `raw_json`. Positioned as a pre-flight check; the downstream FHIR server remains the authoritative validator. |
| 25 | `fhir_validate_bundle` | 🟡 | Per-entry = #24; internal-reference integrity = local logic. Same in-process validator. |

**Tally (per spec capability, 24 after the mapping redesign):** ✅ 12 · 🟡 12 · 🔴 0. The old 🔴 mapping trio is gone; `fhir_get_resource_skeleton` (✅) and `fhir_finalize_resource` (🟡) replace it with zero new source data. The validator (24, 25) is 🟡 in-process Python; terminology expansion (15–18) is 🟡 partial breadth — none blocked, none needs an external service.

**Actual registered `fhir_*` tools after consolidation: ~19** (group C's six snapshot readers collapse to one `view`-param tool, §C). Breakdown: A 4 · B 3 · C 1 · D 5 · E 2 · F 2 · G 2. Adding an IG package adds **zero** tools.

---

## 3. The gaps — options

### Gap 1 — Built-in validator (tools 24–25): in-process Python, **no external service**
We write the validator natively in Python and run it inside the MCP process. **No Java sidecar, no `validator_cli.jar`, no extra container, no network hop.** Everything it needs is already in `twcore.artifacts.raw_json` (snapshot, `constraint.expression` FHIRPath strings, `slicing`, and extension definitions — extensions are themselves StructureDefinition artifacts).

The validator runs four checks in one pass over the parsed `snapshot.element`:

| Check | How (all in-process) | Coverage |
|---|---|---|
| **Structure** | walk `snapshot.element` vs the instance: required (`min≥1`), cardinality (`max`), type / `choice[x]` resolution, `fixed[x]` / `pattern[x]`, `maxLength` | ~100% — catches the bulk of authoring errors |
| **Terminology binding** | for `required`-strength bindings, check the coding is a member via the §3 Gap 3 expansion resolver | as broad as expansion allows; unresolvable external VS → **warning, never a false error** |
| **Invariants (FHIRPath)** | evaluate each `constraint.expression` with **`fhirpathpy`** (pure-Python port of fhirpath.js — a `pip install`, **not** a service) | ~85–95% of R4 invariants; expressions needing a terminology server (`memberOf` on external VS) → warning |
| **Slicing / references** | resolve `value` / `pattern` discriminators to assign array entries to slices then validate each; check Bundle internal `reference` ↔ `fullUrl` integrity | common cases full; exotic `type`/`profile` discriminators deferred |

**Why in-process is the right call, not a compromise:** the resource's real destination is a live FHIR server (we already have `list_fhir_servers` / `crud_fhir_server`), and **that server is the authoritative validator**. Our job is a fast, explainable **pre-flight** check that catches 80–95% of mistakes before submit. For that purpose a native validator is fully fit — and it keeps `requirements.txt` as the only thing that changes (one pure-Python dep), with `docker compose` untouched.

**Honesty contract:** responses report `source: "builtin"`. Where a check can't be performed locally (e.g. external VS can't be expanded, or an unsupported FHIRPath function), it emits an `information`/`warning` issue saying so — it must **never** silently return `valid:true`. The `ok` (tool ran) vs `valid` (resource conforms) distinction from the spec is preserved.

*Not pursued:* a Java HL7-Validator sidecar. It would add a container, a JVM, and a network round-trip to gain exhaustive edge-case conformance we don't need given the downstream server is authoritative. If a future requirement demands official-grade conformance offline, it can be added later behind a setting without changing any tool's contract.

### Gap 2 — Mapping, redesigned: schema-guided fill (replaces tools 19–21, **no stored templates**)
The original spec stored a deterministic source→FHIR rule set (`get_mapping_template` → `plan_mapping` → `apply_mapping`). That is a **pre-LLM construct**: deterministic rule stores (FHIR Mapping Language / StructureMap / hand-coded ETL) exist precisely because a non-intelligent system can't infer that a source field `conditionCode` *means* `Condition.code`. With an LLM in the loop, the semantic mapping is the LLM's job. So we drop the stored template entirely and replace it with two template-free tools.

**Division of labour — the one rule that survives from the template era:** the LLM fills the *semantic* blanks; the system deterministically pins the *mechanical* ones. The LLM must **never** be asked to produce `fixed`/`pattern` values, `meta.profile`, code `system` URLs, or reference wiring — those are hallucination-prone and are pinned by code.

**1. `fhir_get_resource_skeleton(profile)` — the annotated fill-form (✅ data present).** Projected live from the chosen profile's `snapshot.element`. For every element the LLM may/must fill it provides: path, cardinality (required? array?), type, the `choice[x]` JSON property to use, the required-binding ValueSet **with candidate codes** (via Gap 3 expansion), `mustSupport`, a short description, and any `fixed`/`pattern` value **marked as auto-pinned ("system fills this, don't touch")**. Official IG examples (tool 12) are attached as few-shot. This is essentially a generation-oriented view of the same snapshot data tools 8–13 already read.

**2. `fhir_finalize_resource(profile, draft, referenceContextId)` — deterministic close-out (🟡 pure logic).** Takes the LLM-filled draft and: pins `fixed`/`pattern`, attaches `meta.profile`, fills validated-code `system` URLs, resolves references (#22), runs the built-in validator (#1 above / tools 24–25), and returns `{resource, validation, trace}`. If validation fails, the issues feed back to the LLM to fix, then re-finalize. No stored mapping, no `fhir.mapping_*` schema, **no admin authoring UI**.

**Workflow:**
```
list/rank profiles (5,6) → LLM picks profile
  → get_resource_skeleton → LLM fills semantic blanks
     (using terminology tools 13–18 to choose/validate codes)
  → finalize_resource → system pins fixed/pattern/meta.profile, resolves refs, validates
  → on failure: feed validator issues back → LLM fixes → re-finalize
  → build_bundle (23) + validate_bundle (25)
```

**Trade-off the team is accepting consciously:** stored templates are deterministic (same input → same output, compile-once, zero per-record inference) and suit unattended million-row registry loads. LLM-fill is stochastic (an ambiguous term may resolve to a different code across runs) and costs one inference per record — ideal for **interactive / human-in-the-loop / small-to-mid volume** (the MCP's actual use). The mechanical-pinning step + validator gate recover most of the governance/reproducibility guarantees; residual code-choice non-determinism is contained with low temperature + the validator. If a future unattended-batch requirement appears, a compiled template path can be added later **without changing these tools' contracts**.

### Gap 3 — ValueSet expansion breadth (tools 15–17)
Tiered expansion resolver:
1. inline `compose.include.concept` → from raw_json (always works).
2. `compose.include.system` pointing at a locally-held system (`twcore.concepts`, `snomed`, `loinc`, `icd`) → expand/lookup locally, **including** simple `filter` execution (`is-a`, `=`) against `snomed.*`.
3. dependency-package systems (HL7 THO, base FHIR) → expand if that package was imported (the `twcore_tho` / `twcore_fhir_core` source roles already feed `twcore.artifacts`/`concepts`).
4. otherwise → `TERMINOLOGY_SERVER_REQUIRED` (or delegate to configured external TS). The spec's response shapes already accommodate this.

---

## 4. Multi-IG architecture (design from day one)

**Today the data model assumes a single IG.** Concrete single-IG couplings to remove:
- Schema is literally named `twcore`; `artifact_key = "{resourceType}/{id}"` and `cs_id` are **not package-scoped** → two IGs defining `StructureDefinition/Patient` or a CodeSystem with the same id would **collide**.
- No registry of installed packages; `list_codesystems` falls back to a hardcoded registry.
- Canonical-URL resolution is implicitly "within the one IG".

### 4.1 Generalize the schema (logical rename `twcore` → `fhir`)
Introduce a package registry and add package identity to every artifact/terminology row:
```
fhir.ig_packages(
  package_id, version,            -- PK (package_id, version)
  canonical, fhir_version, title, status,
  is_default BOOL, dependencies JSONB,   -- [{packageId, version}]
  imported_at)

fhir.artifacts(
  package_id, package_version,    -- ← NEW, part of PK
  artifact_key, ... raw_json,     -- PK (package_id, package_version, artifact_key)
  ...)
fhir.codesystems(package_id, package_version, cs_id, ...)   -- PK (..., cs_id)
fhir.concepts(package_id, package_version, cs_id, code, ...)
```
Migration path: keep `twcore.*` as the physical home for now and add the package columns (default `tw.gov.mohw.twcore` / `1.0.0`), OR introduce `fhir.*` and have the import write package-scoped rows. The user has stated **they will re-import**, so a clean `fhir.*` schema with package keys is preferred over in-place migration; `db/schema.sql` is authoritative, no migration file required (mirror the existing project convention).

### 4.2 The IG selector (every tool)
All IG-scoped tools accept:
```json
{ "ig": { "packageId": "tw.gov.mohw.twcore", "version": "1.0.0" } }
```
- `version` optional → resolve to the package marked `is_default` (or highest semver) in `fhir.ig_packages`.
- Reject ambiguous bare `"twcore"`; require a real `packageId`.
- Provenance block on every response echoes the resolved `packageId/version/fhirVersion` so callers can detect drift after an IG upgrade.

### 4.3 Canonical resolver across dependencies
A profile in TW Core references base-FHIR R4 elements and HL7 THO ValueSets. The resolver, given a canonical URL + an originating package, searches: **(a)** the target package, then **(b)** its `dependencies` (transitively) in `fhir.ig_packages`. This is the generalization of today's optional `twcore_tho` / `twcore_fhir_core` side-loading. If unresolved → explicit `ARTIFACT_NOT_FOUND` / `VALUESET_NOT_FOUND`, never a guess.

### 4.4 MCP tool shape
- One generic toolset (`fhir_*`) parameterized by `ig`, **not** per-IG tools. Adding an IG = importing a package; no new tools.
- **Granularity rule (decided):** multiple read-views of the same underlying data fold behind a `view`/`mode` param rather than separate tools — keeps `tools/list` lean on top of the existing 29 tools. First application: group C's six snapshot readers → one `fhir_get_profile_elements(profile, view, path?)`. ~19 registered `fhir_*` tools result.
- Reuse the existing common envelope (`{ok,data,warnings,provenance}`) + the error-code enum from the spec.
- Register under a new `_TOOL_GROUPS["fhir_ig"]` group; gate visibility on `fhir.ig_packages` being non-empty (consistent with `ModuleStatusManager` dynamic show/hide).

---

## 5. Phased roadmap (data-first, lowest-risk first)

**Phase 0 — Multi-IG foundation (enables everything).** `fhir.ig_packages` registry + package columns on artifacts/codesystems/concepts; update the import to write package-scoped rows + register the package; IG selector + canonical resolver helpers. Tools 1, 2 fall out for free.

**Phase 1 — Discovery & StructureDefinition (all ✅ data).** Tools 3–13: serve from `artifacts` + a `snapshot.element` projector. Highest value, zero new data, no external deps. This is the "LLM can explore any imported IG and read every profile/element/binding" milestone.

**Phase 2 — Terminology (🟡).** Tools 14–18: tiered expansion resolver (§3 Gap 3), lookup across local schemas, normalize via embeddings + ConceptMaps. Ship inline+local first; THO/external behind the resolver tiers.

**Phase 3 — Reference/Bundle (🟡, pure logic).** Tools 22, 23 + ephemeral reference-context store. Independent of mapping; can land alongside Phase 1/2.

**Phase 4 — Validation (🟡, in-process Python).** Tools 24/25: built-in validator (§3 Gap 2) — structure + binding + FHIRPath invariants (`fhirpathpy`) + common slicing, all in-process. Only new dependency is one pure-Python pip package; no container/infra change.

**Phase 5 — Schema-guided fill (🟡, no stored templates).** `fhir_get_resource_skeleton` (a generation-oriented projection of the Phase 1 snapshot reader + Gap 3 candidate codes + tool-12 examples) and `fhir_finalize_resource` (deterministic pin + reference resolve + validate). **No `fhir.mapping_*` schema, no admin authoring UI.** Last only because it composes everything before it — Phase 1 (element/skeleton), 2 (code choice/validation), 3 (reference resolution), 4 (validate output) — not because it needs new data.

---

## 6. Open decisions (need user input before building)

1. **Schema strategy:** clean new `fhir.*` package-scoped schema (preferred, given planned re-import) vs. add package columns onto existing `twcore.*`?
2. **Validator scope (decided → in-process Python, no sidecar):** ship the full built-in validator (structure + binding + FHIRPath invariants via `fhirpathpy` + common slicing). Remaining sub-choice: include `value`/`pattern` slicing discriminators in the first cut, or defer all slicing to a follow-up?
3. **Mapping (decided → no stored templates):** dropped `get_mapping_template`/`plan_mapping`/`apply_mapping` in favour of schema-guided fill (`fhir_get_resource_skeleton` + `fhir_finalize_resource`). No mapping schema, no authoring UI. **Decided:** `finalize_resource` does **not** auto-loop — it validates and returns `{resource, validation issues}`; the LLM fixes the draft and re-calls. Tool only validates/pins; the LLM owns semantic fixes.
4. **Tool granularity (decided → consolidate):** the StructureDefinition readers (8–13) collapse into one `fhir_get_profile_elements(profile, view, path?)`; the `view`/`mode`-param rule is the toolset-wide style. Result: ~19 registered `fhir_*` tools. (Optional follow-up: the terminology group D could later fold the same way, but is kept discrete for now since each verb is semantically distinct.)

---

## 7. Bottom line

- **Data:** ~70% of the spec is already sitting in `twcore.artifacts.raw_json` + `twcore.concepts`; `package.tgz` confirms nothing is missing for the StructureDefinition/Terminology/Profile/Example tools. We do **not** need to re-fetch the IG for those.
- **Genuine new build:** (1) a multi-IG package registry + package-scoped keys, (2) **schema-guided fill** (`fhir_get_resource_skeleton` + `fhir_finalize_resource`) replacing stored mapping templates — no mapping schema, no authoring UI, (3) an **in-process Python validator** (structure + binding + FHIRPath via `fhirpathpy` + value/pattern slicing — **no external service**), (4) ValueSet-expansion breadth for external systems.
- **No external services, no stored mappings:** the only new runtime dependency is one pure-Python pip package (`fhirpathpy`). `docker compose` is untouched; the LLM does semantic field mapping against a live annotated skeleton while the system pins mechanical fields and the validator gates output; the downstream FHIR server stays the authoritative validator, ours is the pre-flight check.
- **Design rule honored:** one generic `fhir_*` toolset parameterized by `{packageId, version}`, with a dependency-aware canonical resolver — so importing the next IG package costs zero new tools.
