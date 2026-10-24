/**
 * Collaborators of the authoring composer (workstream B). Every member is read-only and,
 * except `resolveProfile`, optional: a missing collaborator only means fewer automatic
 * fills (no display lookup, no text → code normalisation, no ValueSet candidates).
 *
 * Production wiring (workstream C) builds these from FHIRIGService / fhirTerminology for
 * the resolved package; tests use small in-memory fakes.
 */

import type { ExpandedCoding, NormalizeCandidate } from "../fhirSuggestions/types.js";
import type { FieldSpec } from "./types.js";

export type { ExpandedCoding, NormalizeCandidate };

export interface ResolvedProfile {
  /** The StructureDefinition (with `snapshot.element`). */
  sd: Record<string, any>;
  /** Canonical URL (with `|version` when the identifier pinned one) for `meta.profile`. */
  canonical: string;
  /** Artifact id (display only). */
  id?: string | null;
}

export interface ComposeDeps {
  /** Profile by canonical URL or artifact id (`|version` honoured); null when not installed. */
  resolveProfile(identifier: string): Promise<ResolvedProfile | null>;
  /**
   * StructureDefinition by canonical (core datatypes `http://hl7.org/fhir/StructureDefinition/<Type>`,
   * type profiles named by `type.profile`). Without it the composer falls back to its built-in
   * R4 datatype table (values.ts `R4_DATATYPES`).
   */
  fetchStructureDefinition?(url: string): Promise<Record<string, any> | null>;
  /** Display of a code in its CodeSystem (fhir_lookup_code); null when unknown. */
  lookupDisplay?(system: string, code: string): Promise<string | null>;
  /** Free text → candidate codes of a ValueSet / CodeSystem (fhir_normalize_code). */
  normalize?(text: string, target: { system?: string; valueSet?: string }, limit: number): Promise<NormalizeCandidate[]>;
  /** Expansion of a ValueSet (null = not expandable locally). */
  expandValueSet?(url: string, limit: number): Promise<{ codings: ExpandedCoding[]; total: number; truncated: boolean } | null>;
  /** Membership as the validator decides it (undefined = cannot be decided locally). */
  valueSetContains?(url: string, system: string | null, code: string): Promise<boolean | undefined>;
  /**
   * Injection point for workstream A's `authoringFields(profile, deps)`: the model-facing field
   * list of a profile (unknown-field messages list and rank these names). Without it the
   * composer derives a shallow field list from the snapshot itself.
   */
  authoringFields?(sd: Record<string, any>): FieldSpec[] | Promise<FieldSpec[]>;
}
