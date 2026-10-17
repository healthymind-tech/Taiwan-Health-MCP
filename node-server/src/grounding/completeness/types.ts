import { z } from "zod";

/** zod input shape for fhir_check_completeness (MCP_GROUNDING_SPEC §2.3.2). */
export const completenessTargetSchema = z.object({
  key: z.string().optional().describe("Target key; extracted_facts[].target refers to it"),
  resourceType: z.string().min(1).describe("FHIR resourceType of the entry the conversion target asks for"),
  profile: z.string().optional(),
  item: z.string().optional().describe("Item name, e.g. 'HCO3-', 'Metformin', '社區型肺炎'"),
  aliases: z.array(z.string()).optional(),
  codes: z
    .array(z.object({ system: z.string().optional(), code: z.string().optional() }))
    .optional()
    .describe("Optional codings; the tool expands them to aliases via terminology (LOINC Chinese names, abbreviations, vital-sign labels)"),
  category: z.enum(["encounter-diagnosis", "problem-list-item"]).optional(),
  require: z.array(z.string()).optional().describe("Overrides the default required facts"),
  also_require: z.array(z.string()).optional().describe("e.g. ['route','duration']"),
  optional: z.array(z.string()).optional(),
  date_rule: z.enum(["document", "item", "explicit"]).optional().describe("Default 'document'"),
  date: z.string().optional().describe("Date string when date_rule=explicit, e.g. '2026-04-15 19:45'"),
});

export const extractedFactSchema = z.object({
  target: z.string(),
  fact: z.string(),
  status: z.enum(["stated", "not_stated"]),
  quote: z.string().optional(),
});

export const completenessInputShape = {
  targets: z.array(completenessTargetSchema).max(200).describe("Structured conversion targets read from the conversion instruction"),
  source_text: z.string().max(200_000).describe("The clinical record text"),
  site_config: z.string().nullable().optional(),
  extracted_facts: z.array(extractedFactSchema).max(1000).optional().describe("Model-extracted facts; verified, not trusted"),
  instruction_markers: z
    .array(z.string())
    .optional()
    .describe("Line prefixes that mark instruction lines (excluded from the record); default ['【轉換目標】']"),
  package_id: z.string().nullable().optional(),
  version: z.string().nullable().optional(),
};

export const completenessInputSchema = z.object(completenessInputShape);

export type CompletenessTarget = z.infer<typeof completenessTargetSchema>;
export type ExtractedFact = z.infer<typeof extractedFactSchema>;
export type CompletenessInput = z.infer<typeof completenessInputSchema>;

export type FactStatus = "found" | "missing" | "stated_absent" | "unknown";

export interface FactRow {
  fact: string;
  required_by: string;
  status: FactStatus;
  quote?: string;
  reason?: string;
  model?: string;
  note?: string;
}

export interface TargetReport {
  key: string | null;
  resourceType: string;
  item: string | null;
  facts: FactRow[];
}

export interface Abstention {
  status: "insufficient_information";
  missing: string[];
  question: string | null;
}

export interface CompletenessData {
  status: "complete" | "insufficient_information";
  targets: TargetReport[];
  missing: string[];
  question: string | null;
  abstention?: Abstention;
}

export interface CompletenessResult {
  ok: true;
  data: CompletenessData;
  warnings: string[];
  provenance: {
    tool: "fhir_check_completeness";
    toolVersion: string;
    lexiconVersion: string;
    packageId?: string | null;
    version?: string | null;
    terminologyVersion?: string;
    elapsed_ms?: number;
  };
}
