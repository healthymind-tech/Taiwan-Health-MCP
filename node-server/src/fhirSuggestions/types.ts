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
  | "remove_property"
  | "choose_code"
  | "replace_display"
  // Bundle identity (fhirSuggestions/ids.ts, fhir_validate_bundle 1.7.0): the finalizer's deterministic repairs.
  | "replace_fullurl"
  | "replace_reference"
  | "replace_id"
  | "replace_bundle_type"
  | "move_entry"
  // Document / message Bundles without their head resource (fhirSuggestions/bundleType.ts, fhir_validate_bundle 1.8.0):
  // a Bundle.type the entries' shape supports, or the missing Composition / MessageHeader as a new first entry.
  | "replace_value"
  | "add_resource"
  // Binding-aware repairs (fhirSuggestions/bindings.ts, ISSUES_v10 A): a whole Coding {system, code, display}
  // from the element's bound ValueSet(s) for an unknown CodeSystem URL; a value that is not in the
  // element's ValueSet but a valid code of another bound element of the same resource (patch: move).
  | "replace_coding"
  | "move_value"
  // ISSUES_v15.2 R3: an unknown code whose concept links to a coding of another system the element's
  // bound ValueSets accept (a drug's ATC code) — replace the Coding with it (replace_coding), or drop the
  // unknown Coding when the CodeableConcept already carries that coding (remove_coding).
  | "remove_coding";

/** A minimal edit, addressed with the validator's dotted instance paths (e.g. `Observation.code.coding[0].code`). */
export interface SuggestionPatch {
  op: "replace" | "move" | "add" | "remove";
  path: string;
  /** move: the current location of the value. */
  from?: string;
  value?: unknown;
}

export interface Suggestion {
  /** The proposed replacement (a code, system URL, property name, display ...); remove_property: the property removed. */
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
  /** The engine's relevance score (fhir_normalize_code `score`), when it reports one. */
  score?: number;
  /** fhir_normalize_code `accepted_by_validator` (v15.2), when it reports one. */
  accepted?: boolean;
}

/** Relatedness of a candidate code to the code / label it would replace (conceptSearch/related.ts). */
export interface CodeRelatedness {
  related: boolean;
  why: string;
}

/** A code's concept found in an installed copy of its CodeSystem, and the codings of other systems it links to. */
export interface CodeAlternatives {
  display: string | null;
  /** `package#version` of the copy that defines the code (null = none does). */
  definedIn: string | null;
  /** The copy that defines it is the one the validation uses (the code is not unknown there). */
  inValidatedCopy: boolean;
  alternatives: Array<{ system: string; code: string; display: string | null; accepted: boolean | null }>;
}

/**
 * v15.2.1: the profiles an IG defines for a resource type (StructureDefinitions, derivation
 * constraint, kind resource, type = the resource type), looked up for a resource that declares no
 * profile: the IG is the closure package owning the Coding's CodeSystem, else the validated
 * (resolved / default) package. Used only to read an element's binding for the alternative-coding
 * suggestion / repair — never to validate.
 */
export interface ImplicitProfiles {
  /** `package#version` of the IG the profiles come from. */
  ig: string;
  /** Profile canonicals (sorted); empty = the IG defines none for the type. */
  profiles: string[];
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
  /**
   * Snapshot element paths of every base resource StructureDefinition (kind `resource`,
   * derivation `specialization`) in the closure — which resource types carry an element of a
   * given name (remove_property reasons). Small and cacheable; null = unavailable.
   */
  resourceElementPaths?(): Promise<Array<{ type: string; paths: string[] }> | null>;
  /**
   * Semantic similarity of `text` to each candidate label (embedding cosine, one per candidate;
   * null = unavailable). Used to rank the codes of a small ValueSet that no lexical match orders.
   */
  similarity?(text: string, candidates: string[]): Promise<number[] | null>;
  /**
   * v15.2 R2: which candidate codes of an IG CodeSystem are related to the original code / label
   * (same linked code, a shared rare word, same strength — conceptSearch/related.ts); null = not
   * an IG CodeSystem (no gate).
   */
  relatedCodes?(system: string, original: { code: string | null; label: string | null }, candidates: Array<{ code: string; display: string | null }>): Promise<CodeRelatedness[] | null>;
  /** v15.2 R3: the code's concept in any installed copy of its IG CodeSystem and its linked codings (null = not found / not an IG CodeSystem). */
  codeAlternatives?(system: string, code: string): Promise<CodeAlternatives | null>;
  /** v15.2.1: the IG profiles of `resourceType` for a resource that declares none (null = unavailable / `system` is not an IG CodeSystem). */
  implicitProfiles?(resourceType: string, system: string): Promise<ImplicitProfiles | null>;
}

export interface SuggestOptions {
  /** Issues considered per call (in order); the rest get no suggestions. */
  maxIssues?: number;
  /**
   * Calls to the expensive collaborators (normalize / similarity / validateAgainst) per validation
   * (default 20), handed out in issue order: 1 per code / binding / display issue, 2 per unknown
   * Coding system and reference chain, until the pool is spent. ValueSet expansion is local and
   * not counted.
   */
  maxRemoteCalls?: number;
  /** Suggestions kept per issue. */
  maxSuggestions?: number;
  /** Profiles the validation was asked for (besides the instance's meta.profile): element bindings are read from them. */
  profiles?: string[];
}
