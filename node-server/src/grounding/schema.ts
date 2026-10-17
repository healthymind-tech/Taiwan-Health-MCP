/**
 * zod input shape for `fhir_check_grounding` (spec §2.2.1) and the grounding parameters that
 * `fhir_validate_bundle` gains (spec §2.4). Raw shapes (not z.object) so they plug into `server.registerTool`.
 */
import { z } from "zod";

const quoteList = z.array(z.string());

export const evidenceItemSchema = z
  .object({
    path: z.string().describe("Element path: canonical `Bundle.entry[2].resource.code`, `entry[2].code`, `<fullUrl>|code`, `entry[2].Condition.code`, list index optional, `value[x]` allowed"),
    quote: z.string().optional().describe("Verbatim record text supporting the value ('…' separates ordered fragments)"),
    quotes: quoteList.optional(),
    source: z.enum(["record", "site_config"]).optional(),
    note: z.string().optional(),
  })
  .passthrough();

export const evidenceMapSchema = z.union([z.array(evidenceItemSchema), z.record(z.union([z.string(), quoteList]))]);

const severityOverride = z.enum(["error", "warning", "information", "off"]);

export const groundingPolicySchema = z
  .object({ data_absent: z.enum(["error", "warning"]).optional() })
  .catchall(severityOverride)
  .describe('Severity overrides, e.g. {"data_absent": "warning"} or {"G-CATEGORY": "error"}; "off" drops a rule');

export const groundingInputShape = {
  bundle: z.record(z.any()).describe("FHIR Bundle to check"),
  source_text: z.string().describe("Full clinical record text (instruction lines such as 【轉換目標】 are recognised and never count as evidence)"),
  site_config: z.string().nullish().default(null).describe("Site configuration text (only evidence for identifier.system)"),
  evidence_map: evidenceMapSchema.nullish().default(null).describe("Optional evidence map: array of {path, quote|quotes} or {path: quote}"),
  mode: z.enum(["auto", "strict"]).nullish().describe("Default: strict when evidence_map is given, else auto (the tool locates supporting text itself)"),
  verbosity: z.enum(["errors", "warnings", "all"]).nullish().default("warnings"),
  policy: groundingPolicySchema.nullish().default({}),
  instruction_markers: z.array(z.string()).nullish().describe('Line prefixes marking conversion instructions (default ["【轉換目標】"])'),
  package_id: z.string().nullish().default(null),
  version: z.string().nullish().default(null),
};

export const groundingInputSchema = z.object(groundingInputShape);

/** Optional parameters `fhir_validate_bundle` accepts to run grounding in the same call (spec §2.4). */
export const validateBundleGroundingShape = {
  source_text: z.string().nullish().default(null),
  site_config: z.string().nullish().default(null),
  evidence_map: evidenceMapSchema.nullish().default(null),
  grounding: z.enum(["off", "auto", "strict"]).nullish().describe("Default: off without source_text; else auto (strict with evidence_map)"),
  grounding_verbosity: z.enum(["errors", "warnings", "all"]).nullish().default("warnings"),
};
