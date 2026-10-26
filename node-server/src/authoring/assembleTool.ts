/**
 * fhir_assemble_bundle — build the final Bundle from the resources stored in a context (R6).
 */

import { z } from "zod";
import { BUNDLE_TYPES } from "../fhirBundleFinalize.js";
import type { AuthoringService } from "./service.js";
import { authoringErrorEnvelope, okEnvelope } from "./toolEnvelope.js";
import type { AuthoringToolSpec } from "./types.js";

export const ASSEMBLE_TOOL_NAME = "fhir_assemble_bundle";

export const assembleToolDescription =
  "Build the final Bundle from resources authored with fhir_author_resources: pass the context_id and the keys in the entry order you " +
  "want. Each entry gets fullUrl = the deterministic urn:uuid of its key (the same urn the stored references already use), the Bundle is " +
  "finalised like fhir_finalize_bundle with repair=\"content\" (ids, references, document → Composition first, a Bundle.type fixed by " +
  "bundle_profile wins, plus the uniquely-determined content repairs — listed in changes, undecidable ones in repair_issues) and " +
  "validated like fhir_validate_bundle; with source_text it is also grounded against the record (fhir_check_grounding rules). " +
  "With bundle_profile, entries are placed into the profile's entry slices BEFORE validation (meta.profile completed for a resource " +
  "authored for its slice's profile; slice order when the slicing is ordered) and bundle_slices reports the placement, `missing` required " +
  "slices (author them — never invented), `excess` and `unmatched` (closed slicing). " +
  "Same context + same keys → byte-identical Bundle. REFUSES (ok=false, no Bundle) when: a key is not stored (KEY_NOT_FOUND); a stored " +
  "resource references a key that is not in keys or not in the context (UNRESOLVED_REFERENCE — error.refused lists key, field, ref_key); " +
  "a stored resource is invalid (INVALID_RESOURCE — error.refused lists key + field + error; fix with fhir_author_resources merge=true, " +
  "or pass allow_invalid=true only if the user accepts an invalid Bundle); bundle_type=document without an authored Composition " +
  "(MISSING_COMPOSITION — error.missing.fields lists what the Composition needs; author it, it is never invented). A document also needs " +
  "Bundle.identifier and Bundle.timestamp (bdl-9 / bdl-10): pass `identifier` {system, value} and `timestamp` from the record — never invented. " +
  "site_config (facility settings text, as fhir_check_grounding / fhir_author_resources take it) is merged with the context's and used by " +
  "the grounding (with source_text): identifier systems named in it (e.g. \"病歷號 system: https://hospital.example.tw/mrn\") and organisation " +
  "values stated in it are grounded as site_config instead of being flagged. Never logged. " +
  "Returns {context_id, bundle, keys (final entry order), bundle_slices?, validation: {valid, issues: [{key, field, path, severity, message, " +
  "suggestions?}], checked_fully …}, changes, unresolved, notes, included_invalid}. Example: {\"context_id\": \"<id>\", \"keys\": " +
  "[\"composition-1\", \"patient-1\", \"enc-1\", \"cond-1\"], \"bundle_type\": \"document\", \"bundle_profile\": \"Bundle-twcore\"}. " +
  "Fix validation issues by resending only the changed fields of the named key with fhir_author_resources(merge=true), then assemble " +
  "again. An unknown / expired context_id (60-min idle TTL) returns CONTEXT_EXPIRED: start over with fhir_author_resources without context_id.";

export const assembleInputShape = {
  context_id: z.string().regex(/^[0-9a-f]{32}$/, "context_id is the 32-hex id returned by fhir_author_resources").describe("The task's context id (data.context_id of fhir_author_resources)."),
  keys: z.array(z.string().min(1).max(128)).min(1).max(500).describe("Keys of the stored resources to include, in entry order (a document's Composition first)."),
  bundle_type: z.enum(BUNDLE_TYPES).describe("Bundle.type (FHIR R4): document | message | transaction | batch | collection … A type fixed by bundle_profile wins."),
  bundle_profile: z.string().nullish().default(null).describe("Canonical URL or id of the target Bundle profile (e.g. Bundle-twcore); its fixed type / entry rules apply."),
  package_id: z.string().nullish().default(null).describe("IG package id for validation (omit to auto-resolve from the profiles)."),
  version: z.string().nullish().default(null).describe("IG package version (with package_id)."),
  source_text: z.string().nullish().default(null).describe("The clinical record text the resources were authored from: adds grounding checks to the validation. Never logged."),
  site_config: z
    .string()
    .max(20000)
    .nullish()
    .default(null)
    .describe("Facility settings text (fhir_check_grounding's site_config), merged with the one stored on the context: evidence for identifier systems / organisation values when source_text is given. Never logged."),
  allow_invalid: z.boolean().default(false).describe("true: assemble even if a stored resource has validation errors (they are reported in validation.issues)."),
  identifier: z
    .object({ system: z.string().nullish(), value: z.string().min(1) })
    .nullish()
    .default(null)
    .describe("Bundle.identifier {system, value} from the record / facility (a document Bundle needs one: bdl-9). Never invented — omit when the record gives none."),
  timestamp: z
    .string()
    .nullish()
    .default(null)
    .describe("Bundle.timestamp (instant: 2026-06-15T11:00:00+08:00; a time without offset uses the context's timezone). A document Bundle needs one (bdl-10). Never invented."),
};

export function createAssembleTool(service: AuthoringService): AuthoringToolSpec {
  return {
    name: ASSEMBLE_TOOL_NAME,
    description: assembleToolDescription,
    inputShape: assembleInputShape,
    handler: async (args: Record<string, unknown>) => {
      const contextId = String(args.context_id ?? "");
      const keys = (Array.isArray(args.keys) ? args.keys : []).map(String);
      const bundleType = String(args.bundle_type ?? "");
      const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
      try {
        const r = await service.assembleBundle(contextId, keys, bundleType, {
          bundleProfile: str(args.bundle_profile),
          packageId: str(args.package_id),
          version: str(args.version),
          sourceText: typeof args.source_text === "string" && args.source_text ? args.source_text : null,
          siteConfig: typeof args.site_config === "string" && args.site_config.trim() ? args.site_config : null,
          allowInvalid: args.allow_invalid === true,
          identifier: args.identifier && typeof args.identifier === "object" ? (args.identifier as { system?: string | null; value?: string | null }) : null,
          timestamp: str(args.timestamp),
        });
        const { warnings, provenance, ...data } = r;
        return okEnvelope(ASSEMBLE_TOOL_NAME, data, warnings, provenance);
      } catch (e) {
        const env = authoringErrorEnvelope(e);
        if (env) return env;
        throw e;
      }
    },
  };
}
