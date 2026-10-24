/**
 * fhir_author_resources — the model supplies field values, the MCP composes profile-conformant
 * resources, validates them and keeps them in a per-task context (authoring contract R5–R9).
 */

import { z } from "zod";
import { restoreNumbers } from "../losslessJson.js";
import { losslessToolArgument } from "../requestContext.js";
import type { AuthoringService } from "./service.js";
import { authoringErrorEnvelope, okEnvelope } from "./toolEnvelope.js";
import type { AuthorInput, AuthoringToolSpec } from "./types.js";

export const AUTHOR_TOOL_NAME = "fhir_author_resources";

export const authorToolDescription =
  "Author FHIR resources from FIELD VALUES — you give {key, profile, fields}, the MCP composes each resource for its profile " +
  "(meta.profile, fixed / pattern values, displays, UCUM units, ROC dates → ISO), validates it and stores it in a per-task " +
  "context so fhir_assemble_bundle can build the Bundle later. Never write raw FHIR JSON yourself; never invent values: anything " +
  "the record does not give is reported in data.results[].missing. " +
  "WORKFLOW: (1) plan one key per resource (patient-1, enc-1, cond-1, obs-bp …); (2) call fhir_get_authoring_fields(profile) once per " +
  "profile to see the fields, kinds, bindings and value grammar; (3) call this tool WITHOUT context_id for the first batch — up to " +
  "8+ resources per call — and keep data.context_id; (4) cross references are {ref: \"<key>\"} (another key of the same context, " +
  "even one not authored yet: status refs_pending, resolved at assembly; cycles such as Encounter.diagnosis ↔ Condition.encounter " +
  "are fine); (5) fix a result with status invalid by resending ONLY the changed fields with the same key and merge=true — the " +
  "issues carry key, field (your field name), path (FHIR path) and suggestions; (6) fhir_assemble_bundle(context_id, keys, bundle_type). " +
  "VALUE GRAMMAR: scalars as JSON; code / coding / codeableConcept as {system, code, display?} (array for several; {text} when no " +
  "required binding); quantity as {value, unit} or \"95 mg/dL\"; dates ISO 2026-06-15 / 2026-06-15T06:00 or ROC 115/06/15; period " +
  "{start, end?}; identifier {value, system?, type?}; reference {ref: \"key\"} or {reference: \"Patient/123\"} for external; " +
  "value[x] as `value` (the kind follows the shape); component as [{code, value}]; dosage {text?, route?, dose?, timing?}. " +
  "Example: {\"resources\": [{\"key\": \"patient-1\", \"profile\": \"Patient-twcore\", \"fields\": {\"identifier\": {\"value\": " +
  "\"A123456789\", \"type\": \"NNxxx\"}, \"name\": {\"text\": \"王小明\"}, \"gender\": \"male\", \"birthDate\": \"80/03/15\"}}, " +
  "{\"key\": \"obs-glucose\", \"profile\": \"Observation-laboratory-result-twcore\", \"fields\": {\"status\": \"final\", \"code\": " +
  "{\"system\": \"http://loinc.org\", \"code\": \"2345-7\"}, \"subject\": {\"ref\": \"patient-1\"}, \"effectiveDateTime\": " +
  "\"2026-06-15T06:00\", \"value\": \"95 mg/dL\"}}]} → {context_id, storage, results: [{key, status: valid | invalid | refs_pending, " +
  "resource (full), provenance (path → model | fixed | default | derived | lookup), missing: [{field, why}], refs: {resolved, pending}, " +
  "issues: [{key, field, path, severity, message, suggestions?}], notes: [string]}], summary, settings: {timezone, apply_defaults, " +
  "site_config_lines}}. " +
  "Contexts expire after 60 min idle (every call refreshes); an unknown / expired context_id returns error.code CONTEXT_EXPIRED — then " +
  "start over without context_id and re-author everything. storage=\"memory\" means Redis is unavailable and a server restart loses the " +
  "context. A time without a UTC offset (2026-06-15T06:00) is an error unless `timezone` (e.g. \"+08:00\", the facility's offset — remembered " +
  "on the context) is given; an offset is never guessed. Numbers keep the spelling you wrote (12.50 stays 12.50). " +
  "CORRECTIONS (listed in results[].notes): a display is derived from the code — a display you wrote that the terminology rejects for " +
  "a known code is replaced by the code's display (provenance lookup; your wording moves to CodeableConcept.text when that is empty; " +
  "the code is kept); a Coding.system that is a ValueSet URL (e.g. …/ValueSet/loinc-type-doc-code, or its /CodeSystem/ twin) gets the " +
  "CodeSystem the code has in that ValueSet (http://loinc.org) when it is exactly one — several → an error with candidates; a system URL " +
  "that resolves to nothing (e.g. http://terminology.hl7.org/CodeSystem/route) gets the one CodeSystem of the element's bound ValueSets " +
  "(slices / additional bindings included) that holds the code (exact, else case-insensitive, else an exact display) — ambiguous or not " +
  "found → left as written, the validation error carries suggestions; never guessed (provenance lookup, note \"system corrected for …\"); a single object / value given where FHIR repeats (e.g. code: {coding: {system, code}}) is " +
  "wrapped into an array. DEFAULTS: apply_defaults=\"required\" (default) fills the conventional value (Observation.status final, " +
  "Encounter.status finished …) or the profile's defaultValue only for elements the profile REQUIRES; optional ones (Patient.active, " +
  "Immunization.primarySource …) are never auto-filled — give them when the record states them; apply_defaults=\"none\" fills no " +
  "default (required ones then show in missing). Remembered on the context. site_config: the facility settings text (the same text " +
  "fhir_check_grounding takes, e.g. \"病歷號 system: https://hospital.example.tw/mrn\\n機構: 範例醫院 醫事機構代碼 0123456789\"): every " +
  "http(s) URL in it is an accepted identifier system and its lines ground organisation / practitioner identifier values; stored on " +
  "the context (passing it again adds new lines) and used by fhir_assemble_bundle's grounding (source_text). Never logged, never echoed. " +
  "Read-only apart from the context; the profile is resolved like every other fhir_* tool (package_id / version optional).";

const fieldValue = z.any();

export const authorInputShape = {
  context_id: z
    .string()
    .regex(/^[0-9a-f]{32}$/, "context_id is the 32-hex id returned by a previous fhir_author_resources call")
    .nullish()
    .default(null)
    .describe("Context of this task, from a previous call's data.context_id. Omit on the first call: a new context is created and returned."),
  resources: z
    .array(
      z.object({
        key: z.string().min(1).max(128).describe("Your label for the resource, unique within the context (patient-1, cond-1 …); other resources reference it as {ref: key}."),
        profile: z.string().min(1).optional().describe("Profile id or canonical URL (e.g. Patient-twcore). Required unless merge=true and the key is stored."),
        package_id: z.string().nullish().describe("IG package id when the profile is ambiguous or not in the default IG."),
        version: z.string().nullish().describe("IG package version (with package_id)."),
        fields: z.record(fieldValue).default({}).describe("field path → value in the value grammar (see fhir_get_authoring_fields). With merge=true: only the fields to change; null removes a field."),
        merge: z.boolean().default(false).describe("true: update the stored resource of this key with only the given fields (the rest is kept) and re-validate."),
      }),
    )
    .min(1)
    .max(50)
    .describe("Resources to author in this call (batches of 8 or more are fine)."),
  timezone: z
    .string()
    .regex(/^(Z|[+-]\d{2}:\d{2})$/, "timezone is a UTC offset such as +08:00")
    .nullish()
    .default(null)
    .describe("UTC offset completing dateTimes given without one (e.g. \"+08:00\" for a Taiwan facility). Remembered on the context for later calls. Without it a time lacking an offset is reported as an error — never guessed."),
  apply_defaults: z
    .enum(["required", "none"])
    .nullish()
    .default(null)
    .describe("\"required\" (default): workflow defaults / defaultValue only on elements the profile requires (optional ones such as Patient.active are never filled); \"none\": no defaults (required ones are then reported in missing). Remembered on the context."),
  site_config: z
    .string()
    .max(20000)
    .nullish()
    .default(null)
    .describe("Facility settings text, as fhir_check_grounding's site_config (e.g. \"病歷號 system: https://hospital.example.tw/mrn\"): its URLs are accepted identifier systems, its lines ground organisation values at assembly. Stored on the context; passing it again adds new lines. Never logged."),
};

export function createAuthorTool(service: AuthoringService): AuthoringToolSpec {
  return {
    name: AUTHOR_TOOL_NAME,
    description: authorToolDescription,
    inputShape: authorInputShape,
    handler: async (args: Record<string, unknown>, extra?: { requestId?: string | number | null }) => {
      const contextId = typeof args.context_id === "string" && args.context_id ? args.context_id : undefined;
      const inputs = (Array.isArray(args.resources) ? args.resources : []) as AuthorInput[];
      // The request text re-read losslessly (requestContext.ts): a value written 12.50 is composed as 12.50.
      const raw = losslessToolArgument(AUTHOR_TOOL_NAME, "resources", extra?.requestId);
      if (Array.isArray(raw)) {
        for (let i = 0; i < inputs.length; i++) {
          const src = raw[i];
          if (inputs[i] && inputs[i].fields && src && typeof src === "object" && (src as Record<string, unknown>).fields) {
            inputs[i] = { ...inputs[i], fields: restoreNumbers(inputs[i].fields, (src as Record<string, unknown>).fields) as Record<string, unknown> };
          }
        }
      }
      const timezone = typeof args.timezone === "string" && args.timezone ? args.timezone : null;
      const applyDefaults = args.apply_defaults === "required" || args.apply_defaults === "none" ? args.apply_defaults : null;
      const siteConfig = typeof args.site_config === "string" && args.site_config.trim() ? args.site_config : null;
      try {
        const r = await service.authorResources(contextId, inputs, { timezone, applyDefaults, siteConfig });
        return okEnvelope(AUTHOR_TOOL_NAME, { context_id: r.context_id, storage: r.storage, results: r.results, summary: r.summary, settings: r.settings }, r.warnings);
      } catch (e) {
        const env = authoringErrorEnvelope(e);
        if (env) return env;
        throw e;
      }
    },
  };
}
