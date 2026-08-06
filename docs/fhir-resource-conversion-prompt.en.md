# FHIR Resource Conversion Prompt (LLM decides the resourceType)

This prompt demonstrates how to have a language model use this project's `fhir_*` MCP tools (the Taiwan Health MCP FHIR-IG toolset) to turn a flat JSON record into a "conformant and complete" TW Core FHIR resource.

**The key point**: the prompt **does not specify** `resourceType` up front (it is not necessarily `Patient`). Which resource type, which profile, and even **how many** resources a single source record should become are all decided by the LLM **observing the shape of the source fields itself** and verifying with the MCP tools.

> **Prerequisites**: this prompt assumes the LLM is connected to this project's `fhir_*` tools (the FHIR-IG toolset). You must have deployed it first: rebuild the `fhir.*` schema, import the TW Core IG (the validator is built into the backend, no extra installation required), and restart app + admin-worker.

---

## The prompt (copy as-is)

````markdown
You are a FHIR data conversion assistant with access to a set of `fhir_*` MCP tools (the Taiwan Health MCP FHIR-IG toolset).
Your task: convert the flat JSON below into a "conformant and complete" TW Core FHIR resource.

**Note: the source data does not tell you which kind of FHIR resource it is, nor how many resources to produce. Which `resourceType`s, which profile for each, and how many resources in total are entirely for you to decide by observing the fields and verifying with the tools — do not assume it must be a `Patient`, and do not assume there will be only one resource.**

# Source data to convert
```json
{
  "id": "1",
  "idSystem": "https://www.tph.mohw.gov.tw",
  "idNumber": "L253579698",
  "active": true,
  "name": "楊柏晴",
  "telecomSystem": "phone",
  "telecomUse": "mobile",
  "telecomValue": "0976600490",
  "gender": "female",
  "birthDate": "1935-02-03",
  "address": "臺南市東區崇學路121號10樓",
  "organization": "1"
}
```

# Core principles (must be followed)
1. **Do not assume the resource type, nor the count**: `resourceType` and "how many resources to produce" must be inferred by you from the source fields, then confirmed with the tools as actually having a corresponding profile in the IG. Do not start filling values before you have found the matching profile.
2. **One source record may map to several resources**: for example when it carries both "person" fields and "organization" fields, or contains a referenced code/subject — then produce each resource separately and link them with references.
3. **Division of labour**: you are responsible only for filling in "semantic values" (name, sex, birth date, phone, address, diagnosis code, lab value, which code to use, …). Every "mechanical field" — `meta.profile`, `fixed`/`pattern`, a code's `system` URL, a reference's urn — is pinned by `fhir_finalize_resource`. **Never invent them yourself.**
4. **No hallucination**: any canonical URL, CodeSystem system URL, or SNOMED/code display must come from a tool. If you cannot find it, report that — do not guess.
5. **Always normalize before validate for codes**: for any field that needs a code (a field bound to a ValueSet), first get candidates with `fhir_normalize_code`, then confirm membership of that binding with `fhir_validate_code`, and only then write it in.
6. **Honesty**: when a tool returns `unverifiable` / `warning` / `found:false`, handle it truthfully — do not treat it as a pass.
7. At every step, first explain "what you are about to do and why", then call the tool, and summarise the key content the tool returned.

# Execute in order

**Step 0 — Confirm the IG**
- Call `fhir_list_igs`. Confirm the default IG is TW Core (`tw.gov.mohw.twcore`). Use this default IG for every subsequent tool call (no need to pass package_id each time).

**Step 1 — Infer which resources to produce (types + count) and choose profiles**
- First **analyse the source fields yourself** to judge what this record describes and which resources are needed. Some field-shape hints (indicative only; the tools are the authority):
  - `name` / `gender` / `birthDate` / `telecom` / `address` (belonging to a person) → likely a resource describing a person.
  - `name` / `type` / `address` (belonging to an organisation) → likely an Organization.
  - `code` / `subject` / `onset` / `clinicalStatus` → likely a Condition.
  - `code` / `value` / `effective` / `subject` → likely an Observation.
  - `medication` / `subject` / `dosage` → likely a MedicationRequest/Statement.
  - A field pointing at another record (like `organization` in this example) → means there is another **referenced resource** to produce alongside, or to hold a place for with a reference.
- Call `fhir_list_resource_profiles()` (**without base_type**) to see which base resource types and profiles this IG provides, narrowing the candidates.
- Call `fhir_rank_resource_profiles(keys=[<the source field names you listed>])` (**again without base_type**) to have the tool rank the best-matching profiles across all resource types. Note the returned `selectionRequired:true` — it **only suggests**; the final decision is yours.
- List **every** resource you decide to produce: each one's `resourceType`, the specific profile chosen (for example `Patient-twcore`, `Organization-twcore`), and a stable key of your own choosing (used later for references). **Spell out your reasoning**: why these types, why this profile for each, and why this count.

> Steps 2–5 below are performed once for **each** resource you decided to produce.

**Step 2 — Get the fill-in form**
- For that resource, call `fhir_get_resource_skeleton(profile=<the profile you chose>)`.
- Read the returned `fields` carefully: which are required, which are arrays, whether there is slicing, each field's `binding` (including candidateCodes), and any field marked `autoPinned` (**do not touch those** — leave them to finalize).
- Against the source data, list the value you intend to fill into each field. If a source field has no reasonable counterpart in the skeleton, or a required skeleton field has no source value, **say so truthfully** rather than forcing something in.

**Step 3 — Fill in semantic values field by field (general rules; look codes up when needed)**
- General approach: map the **semantic value** of each source field to the FHIR element the skeleton indicates; fill values only, never touch mechanical fields.
  - **Plain value fields** (string / date / boolean, such as name, birth date, address, `active`, a lab value): fill in directly per the skeleton's type and structure (splitting into family/given, city/line, and so on when the skeleton requires it).
  - **Coded fields** (any field bound to a ValueSet, such as `gender`, `telecom.system/use`, Condition.code, Observation.code, status fields): always `fhir_normalize_code(text=<source text>, value_set=<that field's binding valueSet>)` for candidates → `fhir_validate_code` to confirm membership → only then write it in. display/system are decided by the tool or by finalize — **never invent them**.
  - **identifier**: fill in the `value`; use the skeleton's identifier slicing to judge which slice it belongs to. An identifier's **system and type.coding are usually the slice's fixed/pattern → marked autoPinned; do not fill them yourself**, leave them to finalize (a source `idSystem`, if present, is indicative only — the IG's pinned value governs).
  - **reference fields**: see Step 4.
- For reference (illustration only, **not implying the source must be that type**):
  - If you judge it to be a resource describing a person: `name`=「楊柏晴」, `gender`=`female` (a coded field — go through normalize→validate), `birthDate`=`1935-02-03`, `telecom` (system/use go through normalize→validate if bound; value=the phone number), `address`=the address, `identifier`=`L253579698`, `active`=`true`.
  - If you judge it to be a Condition: `code` (the diagnosis, normalize→validate), `subject` (reference), `clinicalStatus`/`verificationStatus` (coded fields), `onset*`.
  - If you judge it to be an Organization: `name`, `type` (coded field), `address`, `identifier`.
- The principle is constant: **you fill semantic values, mechanical fields are left to finalize**.

**Step 4 — Handle references**
- For every field pointing at another resource (like `organization: "1"` here), first establish a reference context: call `fhir_resolve_reference(key="org-1", resource_type="Organization")` and note the returned `contextId` and `reference` (a urn). **Resources that must reference each other in one batch should share the same `contextId`**, each with its own fixed key.
- In the draft, write the corresponding reference field as `"<ResourceType>/<key>"` (for example `"Organization/org-1"`); finalize rewrites it into a urn according to the context.
- If you also intend to produce the referenced resource (that Organization, say), run it through Steps 2–5 too, using **the same key and the same contextId**.

**Step 5 — Finalize (pin mechanical fields + validate)**
- Hand your completed draft (semantic values only — no meta.profile, identifier.system, or fixed fields) to:
  `fhir_finalize_resource(profile=<the profile you chose>, draft=<your draft>, context_id=<the contextId from Step 4>, key=<that resource's key>)`
- Read the returned `validation`:
  - If `valid: true` → that resource is done.
  - If `valid: false` → **do not refill everything**; fix your draft only for each entry in `issues` (look at `path` and `code`). To look up allowed values use `fhir_get_profile_elements(profile=<profile>, view="binding", path=<that path>)` or `fhir_expand_valueset`; to look up a code, normalize→validate. Once fixed, **call `fhir_finalize_resource` again**. Repeat until `valid: true`.

**Step 6 — Build a Bundle when there are several resources**
- If you produced only one resource, skip this step.
- If you produced several: using the same `contextId`, call `fhir_build_bundle(...)` to assemble all finalized resources into a `transaction` Bundle, then validate it with `fhir_validate_bundle`; if there are issues, go back to the relevant resource, fix it, and reassemble.

**Step 7 — Deliver**
- Output the final resource JSON with `valid: true`; if there are several, output the validated Bundle.
- Attach a short explanation: which `resourceType`s and profiles you decided on (with reasoning and count), which FHIR element each source field mapped to, which values you filled semantically, and which mechanical fields finalize pinned (especially identifier.system / type, meta.profile, and the reference urns).

Begin with Step 0.
````

---

## Design points

- **Both the resourceType and the count are decided by the LLM**: the prompt specifies no type and does not assume a single resource.
  `fhir_list_resource_profiles()` and `fhir_rank_resource_profiles(keys=...)` can both be called
  **without `base_type`**, letting the model observe and rank across all resource types before deciding which
  profiles to produce — demonstrating "data-driven" type selection rather than a hardcoded Patient.
- **Step 3 uses general rules**: it categorises handling as "plain value vs coded vs identifier vs reference"
  rather than hardcoding Patient fields; Patient / Condition / Organization appear as parallel illustrations, favouring none.
- **One-to-many support**: one source record can split into several resources (person + organisation, say), cross-referencing
  through a shared `contextId` plus individual keys, and optionally assembled into a Bundle with `fhir_build_bundle` / `fhir_validate_bundle`.
- **identifier's `system`/`type` are deliberately withheld from the LLM**: TW Core identifiers commonly use slicing +
  fixed/pattern, which is exactly the kind of mechanical field `fhir_finalize_resource` should pin — demonstrating the
  "LLM fills semantics, MCP pins mechanics" division of labour.
- **Coded fields go through `normalize → validate`**: this prevents hallucinating codes that are not in the binding.
