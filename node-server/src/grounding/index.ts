/**
 * Grounding (faithfulness) engine — public API for the MCP integration layer.
 *
 *   checkGrounding(input, { terminology })      -> GroundingResult   (fhir_check_grounding data block)
 *   groundingInputShape                          zod raw shape for registerTool
 *   mergeGroundingIntoValidation(conf, ground)   fhir_validate_bundle + grounding (spec §2.4)
 *   createDbTerminologyNames({ query })          production terminology provider (Postgres)
 *   staticTerminologyNames(cache)                fixed table provider (tests / offline)
 */
export {
  GROUNDING_PATH_TABLE,
  GROUNDING_REFERENCE_VERSION,
  GROUNDING_TOOL_VERSION,
  checkGrounding,
  checkGroundingSync,
  collectCodingKeys,
  groundingProvenance,
  normalizeEvidencePath,
  resolveMode,
  sourceSha256Prefix,
  type EvidenceItem,
  type EvidenceMap,
  type GroundingDeps,
  type GroundingEntryResult,
  type GroundingInput,
  type GroundingIssue,
  type GroundingLogger,
  type GroundingMode,
  type GroundingPolicy,
  type GroundingProvenance,
  type GroundingResult,
  type GroundingSummary,
  type GroundingVerbosity,
  type Severity,
} from "./checkGrounding.js";
export { evidenceMapSchema, groundingInputSchema, groundingInputShape, groundingPolicySchema, validateBundleGroundingShape } from "./schema.js";
export {
  groundingProvenanceFields,
  mergeGroundingIntoValidation,
  resolveValidateGrounding,
  type ConformanceData,
  type ConformanceEntry,
  type MergedValidationData,
} from "./merge.js";
export {
  emptyTerminologyNames,
  loadTerminologyCacheFile,
  namesFor,
  staticTerminologyNames,
  termKey,
  type CodingRef,
  type TermRecord,
  type TerminologyCacheFile,
  type TerminologyNames,
} from "./terminologyNames.js";
export { createDbTerminologyNames, routeSystem, type DbTerminologyNames, type DbTerminologyOptions, type QueryFn } from "./terminologyDb.js";
export { DEFAULT_INSTRUCTION_MARKERS, LEXICON_SHA256, LEXICON_VERSION } from "./lexicon.js";
