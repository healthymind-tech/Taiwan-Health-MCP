# Turning your data into FHIR — how the authoring flow works

> **Status:** describes the *designed* FHIR-IG authoring toolset (the `fhir_*` tools). For the engineering spec and design decisions, see [`fhir-ig-mcp-toolset-assessment.md`](./fhir-ig-mcp-toolset-assessment.md). This page is the **user-facing walkthrough**.

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

1. **Deployment default** — most installations are bound to one IG (e.g. a Taiwan hospital → TW Core). One package is marked the default; the LLM doesn't choose.
2. **Explicit instruction** — the calling app or the user says "produce TW Core FHIR". Every tool takes an `ig = {packageId, version}` argument, so the choice is always explicit.
3. **Informed choice** — if several IGs are installed and none is specified, the LLM calls `fhir_list_igs` (which returns each package's `title`, `jurisdiction`, and default flag) and matches it to the user's intent and content hints (Chinese text, ROC national ID, NHI billing → `jurisdiction = TW`).
4. **If still ambiguous → ask.** The system asks the user rather than guessing.

Because every IG-scoped tool takes `ig`, you can target **any imported IG** explicitly: `fhir_get_profile(ig=US-Core, "Patient")` and `fhir_get_profile(ig=TW-Core, "Patient")` return different profiles. Adding a new country's IG is just importing its package — no new tools.

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

Per the rules above. In a TW-bound deployment this is just "TW Core 1.0.0". If unsure: **[MCP] `fhir_list_igs`** → pick by `jurisdiction`/intent → ask if ambiguous.

### Stage 2 — Decide the profiles

- **[MCP] `fhir_list_resource_profiles(ig)`** → returns the IG's profiles: `Patient-twcore`, `Condition-twcore`, `Encounter-twcore`, …
- **[MCP] `fhir_rank_resource_profiles(ig, facts)`** *(optional)* → feeds the diagnosis facts in; the server ranks candidates (`Condition-twcore` top, with matching-field evidence). **It only suggests** — **[LLM]** makes the final pick.

### Stage 3 — Build each resource (Patient first, because Condition references it)

#### 3A · Patient

1. **[MCP] `fhir_get_resource_skeleton(ig, Patient-twcore)`** → a *blank, annotated fill-form* derived live from the profile:
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
3. **[MCP] `fhir_finalize_resource(ig, Patient-twcore, draft, refCtx)`** → the server pins the **mechanical** fields (`identifier.system` for the national-ID slice, `identifier.type`, `meta.profile`), runs the validator, and returns `{ resource, validation: pass }`. The Patient is registered in the *reference context* (`refCtx`) so other resources can point to it.

#### 3B · Condition

1. **[MCP] `fhir_get_resource_skeleton(ig, Condition-twcore)`** →
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
   - **[MCP] `fhir_normalize_code(input="流行性感冒", target = Condition.code's ValueSet)`** → returns **candidate codes** by semantic match, e.g. SNOMED `6142004 | Influenza`.
   - **[MCP] `fhir_validate_code`** → confirms that code really is a member of the bound ValueSet → the LLM writes it into `code`.
   - *(The LLM must not invent a code here — always normalize, then validate.)*
4. **Wire the reference:** **[MCP] `fhir_resolve_reference(refCtx, target=Patient, source=王小明)`** → returns `urn:uuid:…` → written into `subject.reference`.
5. **[MCP] `fhir_finalize_resource(ig, Condition-twcore, draft, refCtx)`** → suppose the validator finds **`category` is required but missing**. The server **does not fix it for you** — it returns `{ resource, issues: [category missing] }`.
6. **[LLM]** reads the issue, checks the allowed values with **[MCP] `fhir_get_profile_elements(ig, Condition-twcore, view="binding", path="Condition.category")`**, sets `category="encounter-diagnosis"`, and **calls `fhir_finalize_resource` again** → this time it **passes**.

### Stage 4 — Assemble & validate the whole thing

- **[MCP] `fhir_build_bundle([Patient, Condition], type="transaction", refCtx)`** → wraps both into a Bundle, rewrites references to `urn:uuid:`, returns the bundle + a reference map.
- **[MCP] `fhir_validate_bundle(bundle)`** → checks every entry **and** internal reference integrity (Condition.subject really points to the Patient in the bundle) → passes.

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
  │
  ├─ for each resource:
  │     [MCP] get_resource_skeleton     ← blanks + allowed values + candidate codes
  │       └─[LLM] fill the semantic blanks
  │            ├─[MCP] normalize_code → validate_code     (free text → standard code)
  │            └─[MCP] resolve_reference                  (link to other resources)
  │     [MCP] finalize_resource         ← pin mechanical fields + validate
  │       └─ failed? returns issues → [LLM] fixes → finalize again
  │
  └─[MCP] build_bundle → validate_bundle ──▶ final Bundle file
```

---

## Why it's built this way

- **No mapping templates to maintain.** Older systems needed a hand-written "field A → field B" rule file because software couldn't understand meaning. With an LLM, the model does the semantic mapping live against the skeleton the server hands it — nothing to author or version.
- **The LLM can't drift into invalid FHIR.** It only fills semantic values; the server pins the mechanical parts and the validator gates the result. Anything the server can't verify locally comes back as a *warning*, never a silent "valid".
- **A pre-flight check, not the final authority.** When you submit the Bundle to a real FHIR server, *that* server does the authoritative validation. This flow's job is to catch the great majority of mistakes early, with clear, fixable feedback.
- **One toolset, many IGs.** Every tool takes an `ig` selector, so the same flow works for TW Core today and any IG you import tomorrow — no new tools.

---

## Quick tool reference

| Stage | Tool | Does |
|---|---|---|
| IG | `fhir_list_igs` / `fhir_get_ig` | list installed IGs (title, jurisdiction, default) / one IG's details |
| Discover | `fhir_list_artifacts` / `fhir_search_artifacts` | browse / search an IG's profiles, ValueSets, etc. |
| Profile | `fhir_list_resource_profiles` / `fhir_rank_resource_profiles` / `fhir_get_profile` | list selectable profiles / rank candidates for your data / profile summary |
| Structure | `fhir_get_profile_elements(view=…)` | one tool, many views: `elements`, `element`, `slices`, `choices`, `binding`, `examples` |
| Terminology | `fhir_get_valueset` / `fhir_expand_valueset` / `fhir_lookup_code` / `fhir_validate_code` / `fhir_normalize_code` | inspect/expand a ValueSet, look up or validate a code, map free text → candidate codes |
| Author | `fhir_get_resource_skeleton` / `fhir_finalize_resource` | get the annotated fill-form / pin mechanical fields + validate |
| Assemble | `fhir_resolve_reference` / `fhir_build_bundle` | link resources / package into a Bundle |
| Validate | `fhir_validate_resource` / `fhir_validate_bundle` | conformance check a resource / a whole bundle |
