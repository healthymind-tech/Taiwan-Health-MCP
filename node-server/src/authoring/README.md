# Authoring layer — contract between the four workstreams

Goal (evaluation requirement v11): the LLM supplies **field values**, the MCP composes the
FHIR resource for a profile, keeps it in a per-task **context**, and assembles the Bundle from
a list of keys. Everything is IG-agnostic: rules come from the resolved package's
StructureDefinitions / ValueSets and FHIR R4 core. No profile-specific special cases.

## Files and ownership

| File | Owner | Purpose |
|---|---|---|
| `fields.ts` (+ `.test.ts`) | A | `authoringFields(profile, deps)` → `FieldSpec[]`; the `fhir_get_authoring_fields` tool spec (`fieldsTool.ts`) |
| `compose.ts` (+ `.test.ts`), `values.ts` | B | `composeResource(input, deps)` — values → profile-conformant resource, provenance, missing, pending refs |
| `contextStore.ts` (+ `.test.ts`), `contextTools.ts`, `assembleTool.ts`, `authorTool.ts` | C | Redis context store (in-memory fallback for tests), `fhir_author_resources`, `fhir_context`, `fhir_assemble_bundle` tool specs |
| `index.ts` | coordinator | `registerAuthoringTools()` — imports the four tool specs; wired into `mcp.ts` last |

Each tool spec module exports `{ name, description, inputShape (zod raw shape), handler }` and nothing
else touches `mcp.ts`, `toolVersions.ts`, docs or `mcpToolExamples.ts` (coordinator does that).

## Shared types (`types.ts`, owned by the coordinator — extend only by appending)

```ts
export type Provenance = "model" | "fixed" | "default" | "derived" | "lookup";  // lookup also marks a corrected Coding.system (v1.2)

export interface FieldSpec {
  field: string;            // dotted FHIR path relative to the resource, slices as `identifier:mrn`, choice as `value[x]`
  required: boolean;        // min >= 1 on the profile (or implied by an invariant / required slice)
  why?: string;             // "required by profile", "mustSupport", "common in IG examples (72%)"
  kind: "string" | "code" | "coding" | "codeableConcept" | "quantity" | "date" | "dateTime" | "period" |
        "identifier" | "reference" | "boolean" | "integer" | "decimal" | "component" | "dosage" | "annotation" | "humanName" | "other";
  multiple: boolean;        // max > 1 → the model may give an array
  source: "record" | "facility" | "code" | "fixed" | "default" | "derived";  // where the value comes from
  auto?: true;              // set by the MCP (fixed / default / derived) — the model need not fill it
  format?: string;          // e.g. "YYYY-MM-DD or 民國 YYY/MM/DD", "number + unit", "{system, code} or [{...}]"
  example?: unknown;        // a filled example value in the value grammar below
  binding?: { strength: string; valueSet: string; codes?: Array<{ code: string; display?: string; system?: string }> }; // codes only when the set is small
  targets?: string[];       // reference target resource types
  children?: FieldSpec[];   // for component / dosage / humanName etc. (kept shallow)
}

/** What the model sends for one resource. */
export interface AuthorInput {
  key: string;                      // model-chosen label, unique within the context
  profile: string;                  // canonical URL or profile id (resolved like the other fhir_* tools)
  package_id?: string; version?: string;
  fields: Record<string, unknown>;  // field path → value (value grammar below)
  merge?: boolean;                  // true = update only the given fields of the stored resource
}

export interface AuthorIssue {
  key: string; field: string | null; path: string;   // field = model-facing name, path = FHIR path
  severity: "fatal" | "error" | "warning" | "information";
  message: string; suggestions?: unknown[];
}

export interface AuthorResult {
  key: string;
  status: "valid" | "invalid" | "refs_pending";
  resource: Record<string, unknown>;        // full composed resource (always returned)
  provenance: Record<string, Provenance>;   // FHIR path → who supplied it
  missing: Array<{ field: string; why: string }>;    // required / expected values the model did not give — NEVER invented
  refs: { resolved: string[]; pending: string[] };   // keys referenced
  issues: AuthorIssue[];
}
```

## Value grammar (what the model may put in `fields[path]`)

| Kind | Accepted forms |
|---|---|
| string / code / boolean / integer / decimal | the JSON scalar |
| coding / codeableConcept | `{system, code, display?}`; several codes → array; text only → `{text}` or a plain string when the element has no required binding |
| quantity | `{value, unit}` (unit text or UCUM; UCUM code looked up by the MCP), or the string `"95 mg/dL"` |
| date / dateTime / instant | ISO `2026-06-15`, `2026-06-15T06:00`, or ROC `115/06/15`, `115/06/15 06:00` (converted; precision kept) |
| period | `{start, end?}` with the date forms above |
| identifier | `{value, system?, type?}`; several → array; `system` may name a facility setting alias (see fields `source: facility`) |
| reference | `{ref: "<key>"}` (another resource in the same context) or `{reference: "<absolute or Type/id>"}` for external |
| choice `value[x]` etc. | give `value` with the kind decided by the value's shape (quantity → valueQuantity, `{system,code}` → valueCodeableConcept, string date → valueDateTime …) |
| component | array of `{code, value}` using the forms above (e.g. blood pressure) |
| dosage | `{text?, route?, dose?, frequency?/timing?, period?, asNeeded?}` composed into Dosage by B |

Rules: model values always win (fixed/pattern values are the only override, and a conflicting
model value is reported as an error); nothing that must come from the record or the facility is
ever invented (dates, numbers, identifiers, names, doses → `missing`); display / UCUM / ROC
dates / `meta.profile` / fixed / pattern / defaults / derived codes are supplied by the MCP and
marked in `provenance`.

v1.1 corrections (reported in `AuthorResult.notes`, append-only field):

- a model display that the validator's terminology rule rejects for a resolvable code is replaced
  by the code's display (`lookup`); the model wording moves to `CodeableConcept.text` when empty;
  code / system never change; an unresolvable code keeps the model display (`ComposeDeps.checkDisplay`);
- an element with max > 1 given a single object / scalar is wrapped into a one-item array at any
  depth, raw FHIR shapes included (`code: {coding: {…}}`);
- workflow defaults / `defaultValue[x]` only on required elements (min >= 1); `apply_defaults:
  "none"` (stored on the context) fills none — required ones then appear in `missing`;
- `site_config` (facility settings text, fhir_check_grounding format) is stored on the context,
  merged line by line, and passed to the grounding engine at assembly (with `source_text`).

v1.2 (evaluation v12):

- `Coding.system` correction (compose.ts `correctSystems`, step 1c, before slices / pinning; notes
  `system corrected for <field>: …`, provenance `lookup` on `…coding[i].system` — and `.code` when
  the spelling / display match changed it). Only model codings; only when the answer is unique:
  - the system is a ValueSet URL (any installed package; or the `/CodeSystem/` ↔ `/ValueSet/`
    twin) → the CodeSystem the code has in that ValueSet (expansion, else `valueSetContains` per
    compose system, else — membership undecidable, e.g. a LOINC property filter — the one compose
    system that holds the code). Several → compose error at `…system` with `candidates`; not a
    member → unchanged;
  - the system resolves to nothing (`ComposeDeps.resolveSystem`: no closure CodeSystem / ValueSet /
    twin, the validator's code check says unknown-system, no conformance resource of that URL in
    any package, and for HL7-space URLs `hl7UrlMustResolve` — the "No definition could be found
    for URL value" rule) → the one CodeSystem of the element's bound ValueSets (bindings.ts
    `elementBindings`: slices, `.coding` child, max / additional bindings) holding the code: exact
    code, else case-insensitive, else an exact display; ambiguous / none / a binding that draws
    from that very URL → unchanged (validator error + v10 suggestions).
  New optional deps: `resolveSystem`, `valueSetSystems`, `codeInSystem` (deps.ts).
- `fhir_get_authoring_fields`: record links (fields.ts `markRecordLinks`) — an optional top-level
  backbone with a required Reference child whose targets include a profile of the same IG (same
  canonical base) of a non-entity resource type (`ENTITY_TYPES`: Patient, Practitioner,
  Organization, Location, Device …) is a tier-1 field with all its children and a
  `{<child>: {ref: key}}` example (Encounter.diagnosis); a direct Reference of that kind is a
  `more` entry `{field, kind, targets}`. The size budget applies to the whole tool response
  (`response_chars`: envelope + warnings + provenance, non-ASCII counted as `\uXXXX`) and keeps a
  150-character margin under 6,000; record links are moved to `more` only after the common-only
  fields.

## References and the context

- `{ref: key}` becomes `reference: urn:uuid:<v5(contextId, key)>` — deterministic per context, the
  same mapping `fhir_assemble_bundle` uses, so single-resource validation and the final Bundle agree.
- A reference to a key not (yet) in the context does not fail the create: status `refs_pending`,
  listed in `refs.pending`; resolved again at assembly.
- Context ids: 128-bit random (hex); stored in Redis under `authoring:ctx:<id>` with idle TTL
  60 min (touched on every access). Unknown/expired → error code `CONTEXT_EXPIRED` (never empty
  results). Clinical content is never logged (log sizes/hashes only).
