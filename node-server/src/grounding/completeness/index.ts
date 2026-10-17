/** Public API of the fhir_check_completeness engine. */
export { checkCompleteness, computeCompleteness, COMPLETENESS_TOOL_VERSION, type CompletenessDeps } from "./checkCompleteness.js";
export {
  completenessInputSchema,
  completenessInputShape,
  type CompletenessData,
  type CompletenessInput,
  type CompletenessResult,
  type CompletenessTarget,
  type ExtractedFact,
  type FactRow,
  type FactStatus,
} from "./types.js";
export { FACT_TABLE, defaultFacts, type FactSpec } from "./factTable.js";
export { DEFAULT_INSTRUCTION_MARKERS } from "./sourceIndex.js";
