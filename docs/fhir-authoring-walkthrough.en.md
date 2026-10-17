# Turning your data into FHIR — how the authoring flow works

> **Status:** describes the shipped FHIR-IG authoring toolset (22 `fhir_*` tools; checked against the code 2026-10). For each tool's parameters see [FHIR IG Tools](tools/fhir-ig-tools.md); the original design-decision record is [`fhir-ig-mcp-toolset-assessment.md`](./fhir-ig-mcp-toolset-assessment.md). This page is the **user-facing walkthrough**.

This MCP server lets a language model (LLM) turn your source data — a structured hospital record **or a free-text clinical note** — into a valid FHIR resource that conforms to an Implementation Guide (IG) such as TW Core, US Core, or IPS. This page walks through exactly how that happens, step by step, with a concrete example.

---

## The one idea to hold onto: who does what

The conversion is a partnership. The boundary never moves:

| | Responsibility |
|---|---|
| **The LLM** | **Meaning & semantics** — reads/understands the source, decides which resource to build, picks the right code for "influenza", fills the *value* of each field. |
| **The MCP server** | **Structure, terminology, mechanics & conformance** — tells the LLM *which fields exist and what's allowed*, supplies the legal code lists, pins the *mechanical* fields the LLM must not invent (fixed values, profile URLs, system URLs, references), and validates the result. |

**The LLM never invents** canonical URLs, code-system URLs, a SNOMED display, or a `meta.profile`. Those come from the server. The LLM fills the *semantic* blanks; the server pins the *mechanical* ones.

---

## Before you start: which IG?

A FHIR resource is only meaningful against a target IG. The **same** clinical facts (a patient, an influenza diagnosis) can be mapped to TW Core, US Core, or IPS depending on **where the data is going** — the data itself doesn't tell you. So the IG is chosen by *context*, not guessed from the content, in this order:

1. **Deployment default** — most installations are bound to one IG (e.g. a Taiwan hospital → TW Core). One package is marked the default in the admin console (IG packages); the LLM doesn't choose.
2. **Explicit instruction** — the calling app or the user says "produce TW Core FHIR". Every IG-scoped tool takes a `package_id` (+ optional `version`) argument, so the choice can always be explicit.
3. **Informed choice** — if several IGs are installed and none is specified, the LLM calls `fhir_list_igs` (which returns each package's `packageId`, `version`, `title`, `canonical`, `isDefault`, `installOrigin` and dependencies) and matches it to the user's intent and content hints (Chinese text, ROC national ID, NHI billing → a `tw.gov.mohw.*` package).
4. **If still ambiguous → ask.** The system asks the user rather than guessing.

When `package_id` is omitted the server resolves the target package in a fixed order: a canonical argument or `meta.profile` pinned with `|version` → the package holding that version; otherwise → the package that owns the canonical / `meta.profile` (manually installed IGs first); otherwise → the default IG; otherwise → the only manually installed IG. Every response's `provenance.resolved_by` says which rule applied. With no default IG and no owner, the call fails with `NO_DEFAULT_IG` instead of picking an arbitrary package.

Because every IG-scoped tool takes `package_id`, you can target **any imported IG** explicitly: `fhir_get_profile(identifier="Patient", package_id="hl7.fhir.us.core")` and `fhir_get_profile(identifier="Patient-twcore", package_id="tw.gov.mohw.twcore")` return different profiles; a canonical may also be written `url|version` to pin a version (an uninstalled version returns `ARTIFACT_NOT_FOUND` — there is no silent fallback to another version). Adding a new country's IG is just importing its package — no new tools.

---

## Worked example

**Input — an unstructured clinical note (free text):**

> 「病人王小明,男性,生日 1985年3月12日,身分證 A123456789。因急性發燒至門診就醫,經醫師確診為**流行性感冒**,2026/6/1 發病,目前持續追蹤中。」

**Goal:** produce TW-Core-conformant FHIR — a `Patient` and a `Condition`, packaged in a Bundle.

Legend: **[LLM]** = the model reasons on its own (no tool call) · **[MCP]** = a tool call.

### Stage 0 — Understand the text *(no tool calls)*

**[LLM]** reads the note and extracts the clinical facts:

```
Patient:   name=王小明, sex=male, birth=1985-03-12, national-id=A123456789
Diagnosis: influenza, clinical status=active, verification=confirmed, onset=2026-06-01
```

It also decides it needs a **Patient** + a **Condition**. It does *not* yet know which FHIR fields or codes to use — that's what the server is for.

### Stage 1 — Resolve the IG

Per the rules above. In a TW-bound deployment this is just "TW Core 1.0.0". If unsure: **[MCP] `fhir_list_igs`** → pick by `packageId` / `title` and intent → ask if ambiguous.

### Stage 2 — Decide the profiles

- **[MCP] `fhir_list_resource_profiles()`** → returns the IG's profiles: `Patient-twcore`, `Condition-twcore`, `Encounter-twcore`, … (pass `all_packages=true` to look across every installed package; zero rows come with a `data.hint` naming other packages that match).
- **[MCP] `fhir_rank_resource_profiles(keys=[…])`** *(optional)* → feeds the source field names (keys) in; the server ranks candidates by how many keys match each profile's element paths (`Condition-twcore` top). It returns `selectionRequired:true` — **it only suggests**, **[LLM]** makes the final pick.
- **[MCP] `fhir_get_profile_required_elements(profile)`** *(recommended)* → once a profile is chosen, get the complete list of what it *effectively* requires (`min≥1` with required ancestors, required slices, choice types, invariant-implied value-or-dataAbsentReason), each row classified by where its value comes from: `auto` (pinned by the server), `coding` (look up a code), `source_fact` (from the source) or `workflow_default`.

### Stage 3 — Build each resource (Patient first, because Condition references it)

#### 3A · Patient

1. **[MCP] `fhir_get_resource_skeleton(profile="Patient-twcore")`** → a *blank, annotated fill-form* derived live from the profile:
   ```
   identifier  (1..*, required; sliced — national ID uses slice "NN";
                system is auto-pinned, you only supply value)
   name        (1..*, required: family / given)
   gender      (0..1; allowed: male | female | other | unknown)
   birthDate   (0..1; date)
   [meta.profile → auto-filled by the server; do not touch]
   ```
2. **[LLM]** fills the **semantic** blanks from Stage 0:
   ```
   identifier[0].value = "A123456789"
   name = { family: "王", given: ["小明"] }
   gender = "male"          ← taken from the allowed list in the skeleton
   birthDate = "1985-03-12"
   ```
   For coded fields it may double-check with **[MCP] `fhir_validate_code`**.
3. **[MCP] `fhir_finalize_resource(profile="Patient-twcore", draft, context_id, key="patient-1")`** → the server pins the **mechanical** fields (`identifier.system` for the national-ID slice, `identifier.type`, `meta.profile`), runs the validator, and returns `{ resource, validation }` (`validation.valid: true`). The Patient is registered under its `key` in the *reference context* (`context_id`) so other resources can point to it.

#### 3B · Condition

1. **[MCP] `fhir_get_resource_skeleton(profile="Condition-twcore")`** →
   ```
   clinicalStatus     (allowed: active | recurrence | ...)
   verificationStatus (allowed: confirmed | provisional | ...)
   category           (allowed: encounter-diagnosis | problem-list-item)
   code               (1..1, required; bound to a SNOMED diagnosis ValueSet)
   subject            (1..1, required; Reference → Patient-twcore)
   onset[x]           (choice; use onsetDateTime for a date)
   ```
2. **[LLM]** fills the easy semantic blanks: `clinicalStatus=active`, `verificationStatus=confirmed`, `onsetDateTime=2026-06-01`.
3. **The key step — turn free text "流行性感冒" into a standard code:**
   - **[MCP] `fhir_normalize_code(text="流行性感冒", value_set = Condition.code's ValueSet)`** → returns **candidate codes** by semantic match, e.g. SNOMED `6142004 | Influenza`.
   - **[MCP] `fhir_validate_code`** → confirms that code really is a member of the bound ValueSet → the LLM writes it into `code`.
   - *(The LLM must not invent a code here — always normalize, then validate.)*
4. **Wire the reference:** **[MCP] `fhir_resolve_reference(key="patient-1", resource_type="Patient", context_id)`** → returns `urn:uuid:…`; the draft says `subject = "Patient/patient-1"` and finalize rewrites it to that urn.
5. **[MCP] `fhir_finalize_resource(profile="Condition-twcore", draft, context_id, key="condition-1")`** → suppose the validator finds **`category` is required but missing**. The server **does not fix it for you** (no auto-loop) — it returns `validation.valid: false` with `issues: [category missing]`.
6. **[LLM]** reads the issue, checks the allowed values with **[MCP] `fhir_get_profile_elements(profile="Condition-twcore", view="binding", path="Condition.category")`**, sets `category="encounter-diagnosis"`, and **calls `fhir_finalize_resource` again** → this time it **passes**.

### Stage 4 — Assemble & validate the whole thing

- **[MCP] `fhir_build_bundle(entries=[{resource, key}, …], bundle_type="transaction", context_id)`** → wraps both into a Bundle, rewrites references to `urn:uuid:`, returns the bundle + the list of unresolved references (`unresolved` should be empty).
- **[MCP] `fhir_validate_bundle(bundle)`** → checks every entry **and** internal reference integrity (Condition.subject really points to the Patient in the bundle) → passes. Also read `checked_fully`: `valid` keeps HL7 validator semantics (an unresolvable profile is only a warning), so when `checked_fully: false`, `profiles_unchecked` / `valuesets_unchecked` list the canonicals that could not be checked and `data.deps_missing` lists missing dependency packages.

**Optional — check against the source record (grounding):** when the source is free text, pass `source_text` (plus optional `site_config`, `evidence_map`, `grounding`) to the same `fhir_validate_bundle` / `fhir_validate_resource` call and the server additionally checks, with deterministic rules (no LLM), that every populated value is actually stated in the record; the response gains `conformanceValid`, `groundingValid` and grounding issues. Without `source_text` the output is unchanged. `fhir_check_grounding(bundle, source_text)` runs the same check on its own, and `fhir_check_completeness(targets, source_text)` compares — before you write anything — the facts the conversion targets require with what the record states, returning missing items, the record lines that state absence, a ready clarification question (or an `insufficient_information` object).

**The validated Bundle is your output file.**

---

## The flow at a glance

```
free-text / source data
  │
  ├─[LLM]  understand it, extract facts, decide which resources are needed
  │
  ├─ resolve IG  (deployment default ▸ explicit ▸ informed choice ▸ ask)
  │
  ├─[MCP] list / rank profiles ──▶ [LLM] pick the profile
  ├─[MCP] get_profile_required_elements   ← what the profile really requires
  │
  ├─ for each resource:
  │     [MCP] get_resource_skeleton     ← blanks + allowed values + candidate codes
  │       └─[LLM] fill the semantic blanks
  │            ├─[MCP] normalize_code → validate_code     (free text → standard code)
  │            └─[MCP] resolve_reference                  (link to other resources)
  │     [MCP] finalize_resource         ← pin mechanical fields + validate
  │       └─ failed? returns issues → [LLM] fixes → finalize again
  │
  └─[MCP] build_bundle → validate_bundle (+ optional source_text grounding) ──▶ final Bundle file
```

---

## Why it's built this way

- **No mapping templates to maintain.** Older systems needed a hand-written "field A → field B" rule file because software couldn't understand meaning. With an LLM, the model does the semantic mapping live against the skeleton the server hands it — nothing to author or version.
- **The LLM can't drift into invalid FHIR.** It only fills semantic values; the server pins the mechanical parts and the validator gates the result. Anything the server can't verify locally comes back as a *warning*, never a silent "valid".
- **A pre-flight check, not the final authority.** When you submit the Bundle to a real FHIR server, *that* server does the authoritative validation. This flow's job is to catch the great majority of mistakes early, with clear, fixable feedback.
- **One toolset, many IGs.** Every IG-scoped tool takes `package_id` (auto-resolved when omitted), so the same flow works for TW Core today and any IG you import tomorrow — no new tools.

---

## Quick tool reference

| Stage | Tool | Does |
|---|---|---|
| IG | `fhir_list_igs` / `fhir_get_ig` | list installed IGs (title, canonical, default, installOrigin) / one IG's details (incl. `data.deps_missing`) |
| Discover | `fhir_list_artifacts` / `fhir_search_artifacts` | browse / search an IG's profiles, ValueSets, etc. |
| Profile | `fhir_list_resource_profiles` / `fhir_rank_resource_profiles` / `fhir_get_profile` | list selectable profiles / rank candidates for your data / profile summary |
| Structure | `fhir_get_profile_elements(view=…)` | one tool, many views: `elements`, `element`, `slices`, `choices`, `binding`, `examples` |
| Required | `fhir_get_profile_required_elements` | the profile's complete effective required list, each row tagged with its value source (auto / coding / source_fact / workflow_default) |
| Terminology | `fhir_get_valueset` / `fhir_expand_valueset` / `fhir_lookup_code` / `fhir_validate_code` / `fhir_normalize_code` | inspect/expand a ValueSet, look up or validate a code, map free text → candidate codes |
| Author | `fhir_get_resource_skeleton` / `fhir_finalize_resource` | get the annotated fill-form / pin mechanical fields + validate |
| Assemble | `fhir_resolve_reference` / `fhir_build_bundle` | link resources / package into a Bundle |
| Validate | `fhir_validate_resource` / `fhir_validate_bundle` | conformance check a resource / a whole bundle (plus grounding when `source_text` is given) |
| Faithfulness | `fhir_check_grounding` / `fhir_check_completeness` | is every value supported by the record / does the record state the facts the targets require (both deterministic, no LLM) |
