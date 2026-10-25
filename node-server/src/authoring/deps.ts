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

// DisplayVerdict / SystemResolution moved to the shared repair layer (fhirRepair/types.ts, ISSUES_v14).
export type { CodeSystemEntry, DisplayVerdict, RepairDeps, SystemResolution } from "../fhirRepair/types.js";
import type { RepairDeps } from "../fhirRepair/types.js";

export interface ResolvedProfile {
  /** The StructureDefinition (with `snapshot.element`). */
  sd: Record<string, any>;
  /** Canonical URL (with `|version` when the identifier pinned one) for `meta.profile`. */
  canonical: string;
  /** Artifact id (display only). */
  id?: string | null;
}

/**
 * The composer's collaborators: the shared repair layer's (fhirRepair/types.ts RepairDeps —
 * displays, terminology search, expansions, membership, system resolution, code checks, the
 * CodeSystem directory) plus profile resolution and the model-facing field list.
 */
export interface ComposeDeps extends Partial<RepairDeps> {
  /** Profile by canonical URL or artifact id (`|version` honoured); null when not installed. */
  resolveProfile(identifier: string): Promise<ResolvedProfile | null>;
  /**
   * StructureDefinition by canonical (core datatypes `http://hl7.org/fhir/StructureDefinition/<Type>`,
   * type profiles named by `type.profile`). Without it the composer falls back to its built-in
   * R4 datatype table (values.ts `R4_DATATYPES`) and the repair layer is skipped.
   */
  fetchStructureDefinition?(url: string): Promise<Record<string, any> | null>;
  /**
   * Injection point for workstream A's `authoringFields(profile, deps)`: the model-facing field
   * list of a profile (unknown-field messages list and rank these names). Without it the
   * composer derives a shallow field list from the snapshot itself.
   */
  authoringFields?(sd: Record<string, any>): FieldSpec[] | Promise<FieldSpec[]>;
}
