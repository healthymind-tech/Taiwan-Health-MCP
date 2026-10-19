/**
 * Suggestion layer for validator issues (fhir_validate_resource / fhir_validate_bundle /
 * fhir_finalize_resource): "what to change it to", ranked, attached additively to issues
 * after validation. The validator's verdict (issue set, severities, messages) is never
 * changed — this layer only adds `suggestions` / `caused_by` fields.
 */

import type { CodeCheck } from "../fhirValidator.js";

export type SuggestionKind =
  | "replace_code"
  | "replace_system"
  | "rename_property"
  | "move_property"
  | "choose_code"
  | "replace_display";

/** A minimal edit, addressed with the validator's dotted instance paths (e.g. `Observation.code.coding[0].code`). */
export interface SuggestionPatch {
  op: "replace" | "move" | "add" | "remove";
  path: string;
  /** move: the current location of the value. */
  from?: string;
  value?: unknown;
}

export interface Suggestion {
  /** The proposed replacement (a code, system URL, property name, display ...). */
  value: string;
  kind: SuggestionKind;
  /** Heuristic confidence in [0, 1] (2 decimals). Higher first; the list is ordered by it. */
  confidence: number;
  reason: string;
  /** For codes: the system the suggested code belongs to, and its display. */
  system?: string;
  display?: string;
  patch?: SuggestionPatch;
}

/** One issue of a referenced resource that explains a reference-chain error. */
export interface CausedBy {
  /** fullUrl of the referenced Bundle entry (or the contained reference, '#id'). */
  fullUrl: string | null;
  /** Bundle entry index when the target is a Bundle entry. */
  entry?: number;
  severity: string;
  path: string;
  message: string;
  /** Set when the cause was found by validating the target against this profile (it does not declare it). */
  profile?: string;
}

export interface ExpandedCoding {
  system: string | null;
  code: string;
  display: string | null;
}

export interface NormalizeCandidate {
  system: string | null;
  code: string;
  display: string | null;
  exact?: boolean;
}

/**
 * Collaborators. Every member is optional except the structure / code lookups; a missing
 * collaborator just means fewer candidates. All of them must be read-only.
 */
export interface SuggestionDeps {
  /** StructureDefinition by canonical (core types: http://hl7.org/fhir/StructureDefinition/<type>). */
  fetchStructureDefinition(url: string): Promise<Record<string, any> | null>;
  /** The validator's own code check (same resolver), so a suggested code is one the validator accepts. */
  checkCode(system: string, code: string, display: string | null): Promise<CodeCheck>;
  /** Full ValueSet JSON (compose) by canonical, or null. */
  loadValueSet?(url: string): Promise<Record<string, any> | null>;
  /** Membership as the validator decides it (undefined = cannot be decided). */
  valueSetContains?(url: string, system: string | null, code: string): Promise<boolean | undefined>;
  /** Expansion of a ValueSet (null = not expandable locally). */
  expandValueSet?(url: string, limit: number): Promise<{ codings: ExpandedCoding[]; total: number; truncated: boolean } | null>;
  /** Free text → codes of a system or ValueSet (fhir_normalize_code). */
  normalize?(text: string, target: { system?: string; valueSet?: string }, limit: number): Promise<NormalizeCandidate[]>;
  /** Existing codes that look like `code` in an IG CodeSystem. */
  nearCodes?(system: string, code: string, limit: number): Promise<Array<{ code: string; display: string | null }>>;
  /** Canonical URLs of the given resource types that start with `prefix` (package closure). */
  canonicalsUnder?(prefix: string, resourceTypes: string[]): Promise<string[]>;
  /** Errors of `resource` validated stand-alone against `profile` (reference-chain causes). */
  validateAgainst?(resource: Record<string, any>, profile: string): Promise<Array<Record<string, any>>>;
}

export interface SuggestOptions {
  /** Issues considered per call (in order); the rest get no suggestions. */
  maxIssues?: number;
  /**
   * Calls to the expensive collaborators (normalize / validateAgainst / expand) per validation (default 20):
   * the first maxRemoteCalls / 2 issues that need them get 2 calls each, in issue order.
   */
  maxRemoteCalls?: number;
  /** Suggestions kept per issue. */
  maxSuggestions?: number;
}
