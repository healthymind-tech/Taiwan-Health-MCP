# FHIR Bundle Conversion Prompt (many resources, cross-references, dependency-ordered Bundle)

This prompt demonstrates how to have a language model use this project's `fhir_*` MCP tools (the Taiwan Health MCP FHIR-IG toolset) to convert **a whole package of flat JSON** (several lists, each list one resource type, cross-referencing each other by foreign key) step by step into a "conformant and complete" TW Core FHIR **Bundle**.

Differences from the [single-resource version](fhir-resource-conversion-prompt.md):
- There are **many** resources of **several** types at once, and they **reference each other**.
- Conversion order is **referenced-first**: handle resources that reference nobody (such as Organization) first, then the resources that reference them, and finally the ones that reference the most (such as Observation / Encounter).
- It closes with `fhir_build_bundle` + `fhir_validate_bundle` to assemble and validate the whole Bundle.

> **Prerequisites**: the LLM is connected to this project's `fhir_*` tools (the FHIR-IG toolset). You must have deployed it first: rebuild the `fhir.*` schema, import the TW Core IG (the validator is built into the backend, no extra installation required), and restart app + admin-worker.

---

## The prompt (copy as-is)

````markdown
You are a FHIR data conversion assistant with access to a set of `fhir_*` MCP tools (the Taiwan Health MCP FHIR-IG toolset).
Your task: convert the whole package of flat JSON below (many resources, cross-referencing each other) into one "conformant and complete" TW Core FHIR **Bundle** (using type `collection`).

**Important: no field tells you directly which `resourceType` a record is, and there are no ready-made urns. Resource types, profiles, and cross-resource references are all for you to decide by observing the fields and verifying with the tools.**

# Source data to convert
```json
{
  "patients": [
    { "id": "1", "idSystem": "https://www.tph.mohw.gov.tw", "idNumber": "H225602126", "active": true, "name": "陳佳豪", "telecomSystem": "phone", "telecomUse": "mobile", "telecomValue": "0989174087", "gender": "female", "birthDate": "1956-03-11", "address": "桃園市桃園區復興路102巷32弄41號", "organization": "1" }
  ],
  "organizations": [
    { "id": "1", "identifierValue": "0132010014", "idSystem": "https://twcore.mohw.gov.tw/ig/twcore/CodeSystem/organization-identifier-tw", "active": true, "type": "prov", "name": "臺北市立聯合醫院", "telecomSystem": "phone", "telecomUse": "work", "telecomValue": "02-2555-3000", "address": "臺北市信義區莊敬路270號" }
  ],
  "encounters": [
    { "id": "1", "idSystem": "https://www.tph.mohw.gov.tw/fhir/encounter", "status": "finished", "class": "EMER", "type": "EMER", "reasonCode": "Cond-0019", "serviceType": "emergency", "serviceTypeText": "急診", "patientId": "1", "periodStart": "2026-06-01T08:22:15.238Z", "periodEnd": "2026-06-01T08:47:15.238Z", "serviceProviderId": "1", "participantType": "ATND", "practitionerId": "1", "conditionId": "1", "diagnosisUse": "AD", "admitSource": "emd" }
  ],
  "practitionerroles": [
    { "id": "1", "identifierValue": "KP00018", "idSystem": "https://www.tph.mohw.gov.tw", "active": true, "practitionerId": "1", "organizationId": "1", "roleCode": "PR-0008", "roleText": "急診醫師", "specialtyCode": "Spec-0004", "periodStart": "2024-01-01T08:00:00+08:00", "periodEnd": "2026-12-31T17:00:00+08:00", "telecomSystem": "phone", "telecomUse": "work", "telecomValue": "02-2312-3456" }
  ],
  "practitioners": [
    { "id": "1", "medicalLicenseNumber": "醫字第045678號", "medicalLicenseSystem": "https://www.tph.mohw.gov.tw/fhir/practitioner-license", "active": true, "name": "陳冠辰", "telecomSystem": "phone", "telecomUse": "work", "telecomValue": "0907960949", "address": "新北市板橋區民生路3段276號7樓", "gender": "male", "birthday": "1966-02-17", "qualificationCode": "Qual-0001", "qualificationIssuer": "1" }
  ],
  "conditions": [
    { "id": "1", "clinicalStatus": "active", "verificationStatus": "confirmed", "category": "encounter-diagnosis", "severity": "24484000", "conditionCode": "Cond-0023", "conditionText": "突發胸痛", "patientId": "1", "onsetDate": "2026-06-01T08:22:15.238Z", "asserterId": "1", "recorderId": "1", "note": "突發胸痛，伴隨冒冷汗。" }
  ],
  "observationVitalSigns": [
    { "id": "1", "status": "final", "categoryCode": "vital-signs", "observationCode": "VS-0006", "patientId": "1", "encounterId": "1", "effectiveDate": "2026-06-01T08:22:15.238Z", "performerId": "1", "valueQuantity": 92, "valueUnit": "/min", "rangeLow": 60, "rangeHigh": 100 },
    { "id": "2", "status": "final", "categoryCode": "vital-signs", "observationCode": "VS-0012", "patientId": "1", "encounterId": "1", "effectiveDate": "2026-06-01T08:22:15.238Z", "performerId": "1", "valueQuantity": 94, "valueUnit": "%", "rangeLow": 95, "rangeHigh": 100 }
  ]
}
```

# Core principles (must be followed)
1. **Do not assume the resource type**: infer each record's `resourceType` from its fields, then confirm with the tools that the IG has a corresponding profile.
2. **Division of labour**: you fill in "semantic values" only. Every "mechanical field" — `meta.profile`, `fixed`/`pattern`, a code's `system` URL, a reference's urn — is pinned by `fhir_finalize_resource`. **Never invent them yourself.**
3. **A reference's type comes from semantics, not from the id**: the same id in different fields may point at resources of different types (for example an `asserterId` pointing at the patient while `recorderId` points at a practitioner, with identical values). Which type each foreign key targets is decided by **the semantics of the FHIR element it is being filled into**; when it is ambiguous, **state your assumption explicitly**.
4. **The source's internal codes are not FHIR codes**: opaque codes such as `Cond-0023`, `VS-0006`, `PR-0008`, `Spec-0004`, `Qual-0001`, and `serviceType:"emergency"` must be resolved by taking the **accompanying human-readable text** (`conditionText`, `serviceTypeText`, `roleText`, …) to `fhir_normalize_code` to find the real SNOMED/LOINC/HL7 code, then confirming with `fhir_validate_code`. **If there is only an opaque code, no text, and no mapping to be found** → report `unverifiable` truthfully; do not fabricate a code.
5. **No hallucination**: every canonical URL, system URL, and code display comes from a tool; if you cannot find it, report that.
6. **Honesty**: when a tool returns `unverifiable` / `warning` / `found:false`, handle it truthfully — do not treat it as a pass.
7. At every step, first explain "what you are about to do and why", then call the tool, and summarise the key content it returned.

---

# Phase 1 — Inventory, resolve references, order, pre-mint urns

**Step 0 — Confirm the IG**
- Call `fhir_list_igs` and confirm the default IG is TW Core (`tw.gov.mohw.twcore`). No need to pass package_id thereafter.

**Step 1 — Inventory every resource and give each a stable key**
- Walk every top-level list; **each element = one resource**.
- Assign each one a key that is unique across the whole package and encodes its type: `<type>-<local id>`, for example `org-1`, `practitioner-1`, `patient-1`, `practitionerrole-1`, `condition-1`, `encounter-1`, `observation-1`, `observation-2`.
- Produce a table: `key | source list | your provisional resourceType`. The type must still be confirmed with the tools in Phase 2.

**Step 2 — Resolve each record's cross-resource references (foreign key → (type, key))**
- Record by record, find every field pointing at another resource and resolve it to a target `(resourceType, key)`. The mapping for this example (which you must derive yourself and validate against FHIR semantics):
  - patients.`organization` → Organization (`managingOrganization`)
  - practitioners.`qualificationIssuer` → Organization (`qualification.issuer`)
  - practitionerroles.`practitionerId` → Practitioner, `organizationId` → Organization
  - conditions.`patientId` → Patient (`subject`), `recorderId` → Practitioner (`recorder`), `asserterId` → **decide by semantics** (in this example, treated as the patient themselves → Patient). **`recorderId` and `asserterId` have the same value here but different types — keep them distinct.**
  - encounters.`patientId` → Patient (`subject`), `practitionerId` → Practitioner (`participant.individual`), `conditionId` → Condition (`diagnosis.condition`), `serviceProviderId` → Organization (`serviceProvider`)
  - observationVitalSigns.`patientId` → Patient (`subject`), `encounterId` → Encounter (`encounter`), `performerId` → **decide by semantics** (a practitioner here → Practitioner)
- For any foreign key whose type you cannot determine confidently, **flag it and state the assumption you adopted** — do not guess silently.

**Step 3 — Build the dependency graph and topologically sort (referenced-first)**
- Use the Step 2 result to draw "who references whom". Conversion order starts from **resources that reference nobody** and works upward. The typical order for this example:
  `Organization → Practitioner → Patient → PractitionerRole → Condition → Encounter → Observation(VS-0006) → Observation(VS-0012)`.
- If you detect a cycle (A references B and B references A), do not get stuck — the next step's pre-minted urns exist to break cycles, after which order affects only readability, not correctness.

**Step 4 — Pre-mint a urn for every key inside one build context**
- For the **first** key, call `fhir_resolve_reference(key="org-1", resource_type="Organization")` (without context_id) → note the returned `contextId` and pass it every time thereafter.
- For **every remaining** key, call `fhir_resolve_reference(key=<that key>, resource_type=<type>, context_id=<contextId>)` once to obtain its own stable urn.
- Every resource now has a urn before it is created, so **forward references and cycles are both non-issues**. When filling references in Phase 2, always write `"<Type>/<key>"` (for example `"Patient/patient-1"`); finalize rewrites it into a urn according to the context.

---

# Phase 2 — Convert one at a time (in the Step 3 order)

For each resource in the sorted order, repeat a–e below. **Efficiency tip**: the skeleton for a given profile only needs fetching once; later records of the same type reuse it.

- **a. Choose a profile**: for that record, call `fhir_rank_resource_profiles(keys=[<that record's field names>])` (without base_type), combined with `fhir_list_resource_profiles()` when necessary; select one specific profile and explain why.
  - **Observations must be chosen record by record**: different `observationCode` values map to different profiles (heart rate → `Observation-heart-rate-twcore`, oxygen saturation → `Observation-pulse-oximetry-twcore`). Decide from that record's code/text; do not apply one profile to all of them.
- **b. Get the skeleton**: `fhir_get_resource_skeleton(profile=<the chosen profile>)`. Read required / arrays / slicing / each field's binding (including candidateCodes) / `autoPinned` (do not touch).
- **c. Fill semantic values**: against that source record.
  - Reference fields take `"<Type>/<key>"` (for example `subject` = `"Patient/patient-1"`, `encounter` = `"Encounter/encounter-1"`).
  - Fields needing a code go through `fhir_normalize_code` (using the human-readable text) → `fhir_validate_code`; handle opaque internal codes per core principle 4.
  - Mechanical fields such as an identifier's system/type and a code's system are **left to finalize** (never fill anything the skeleton marks `autoPinned`).
  - Measurement units (such as `/min` or `%`) go into `valueQuantity`; confirm UCUM's `system`/`code` with the tools if the skeleton requires them.
- **d. Finalize**: `fhir_finalize_resource(profile=<the chosen profile>, draft=<your draft>, context_id=<contextId>, key=<that record's key>)`.
  - `valid: true` → take the returned `resource` (stash it in a list along with its key).
  - `valid: false` → fix **only** what `issues` reports (use `fhir_get_profile_elements(view="binding")` / `fhir_expand_valueset` for allowed values, and normalize→validate for codes), then finalize again until `valid: true`.
- **e.** Move on to the next record, until every resource has finalized successfully.

---

# Phase 3 — Build the Bundle, validate, deliver

**Step 5 — Assemble**
- Combine each `resource` collected in Phase 2 with its key into entries and call:
  `fhir_build_bundle(entries=[{"resource": <resource>, "key": "<key>"}, …], bundle_type="collection", context_id=<contextId>)`
- Read the returned `unresolved`: **it must be empty**. An unresolved reference means some `"<Type>/<key>"` matched no entry → go back and fix it (usually a misspelled key or a record you forgot to convert), then reassemble.

**Step 6 — Validate the whole package**
- `fhir_validate_bundle(bundle=<the bundle from the previous step>)`. Read each entry's `valid` and `referenceIssues`.
  - All valid with no referenceIssues → done.
  - Otherwise fix only the problematic records (return to Phase 2 and finalize those), then rebuild and revalidate.

**Step 7 — Deliver**
- Output the final valid Bundle JSON (the one returned by `fhir_build_bundle` that passed `fhir_validate_bundle`).
- Attach a mapping explanation: each resource's `key → urn`, how the cross-resource references link up (which field points at which key), which codes you looked up (and their source ValueSets), which mechanical fields finalize pinned, and anywhere you flagged `unverifiable` or adopted an assumption.

Begin with Step 0.
````

---

## Design points

- **"Referenced-first" + pre-minted urns**: `fhir_resolve_reference` mints a stable urn from a `key`,
  letting a resource be referenced before it exists. Pre-minting all keys in one pass and then converting in
  topological order means **forward references** and **cyclic references** (Encounter↔Condition is common in FHIR)
  both stop being blockers — at that point the topological order affects only readability, not correctness.
- **A reference's "type" comes from semantics, not from the id**: flat data uses per-list local ids, so the same id value
  in different fields may point at different types (for example `recorderId` → Practitioner and `asserterId` → Patient,
  both with the value `"1"`). Keys must therefore encode the type (`patient-1` / `practitioner-1`), and each foreign key's
  target type is decided by the semantics of the element it fills.
- **Opaque internal codes ≠ FHIR codes**: `Cond-xxxx`/`VS-xxxx`/`PR-xxxx`/`Spec-xxxx`/`Qual-xxxx` must be translated into
  real codes through `normalize → validate` using the accompanying human-readable text; **when there is only a code, no text,
  and no mapping to be found, report `unverifiable` rather than fabricating one** — avoiding the "conjured a SNOMED code out of
  nowhere" hallucination seen in some demos.
- **Profiles are chosen per record (especially for Observation)**: vital signs route to different profiles by what is measured;
  a skeleton for a given profile can be cached and reused, cutting tool calls on large datasets.
- **It closes with `collection`**: `fhir_build_bundle(bundle_type="collection")` adds no `request`; `unresolved` must be empty,
  and `fhir_validate_bundle` then checks entry conformance and internal reference integrity.
