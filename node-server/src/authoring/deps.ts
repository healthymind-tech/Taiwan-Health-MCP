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

export interface DisplayVerdict {
  status: "ok" | "invalid-display" | "unknown";
  /** Valid displays of the code (validator order: the code's own display first), when invalid. */
  valid: string[];
}

/**
 * How a Coding.system URL resolves (v1.2 system correction, compose.ts `correctSystems`):
 *   codesystem  a CodeSystem of the closure or a terminology the validator knows — never touched;
 *   valueset    the URL (or its `/CodeSystem/` → `/ValueSet/` twin) is a ValueSet of an installed
 *               package — the code's real CodeSystem is taken from that ValueSet when unique;
 *   unknown     no definition anywhere, by the validator's URL rules (an HL7-space URL only when
 *               the HL7 validator reports "No definition could be found for URL value");
 *               `codeSystemTwin` = the `/ValueSet/` → `/CodeSystem/` twin when that is a CodeSystem;
 *   other       defined somewhere else (another package's CodeSystem, a NamingSystem, an HL7 IG
 *               the validator cannot judge) — left as written.
 */
export type SystemResolution =
  | { kind: "codesystem" }
  | { kind: "valueset"; valueSet: string }
  | { kind: "unknown"; codeSystemTwin?: string | null }
  | { kind: "other" };

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
  /**
   * The validator's verdict on a display the model wrote for system|code (the same terminology
   * check fhir_validate_resource runs): `ok` (a valid display, case-insensitive), `invalid-display`
   * with the valid displays the validator names, or `unknown` (code not resolvable / no local
   * terminology — the display is then kept as written).
   */
  checkDisplay?(system: string, code: string, display: string, version: string | null): Promise<DisplayVerdict>;
  /** Free text → candidate codes of a ValueSet / CodeSystem (fhir_normalize_code). */
  normalize?(text: string, target: { system?: string; valueSet?: string }, limit: number): Promise<NormalizeCandidate[]>;
  /**
   * Expansion of a ValueSet (null = not expandable locally). `incomplete` (v1.3): some part of the
   * compose could not be enumerated locally (e.g. a LOINC property filter next to an enumerated
   * include) — the codings are then only part of the ValueSet and, like a truncated expansion,
   * never prove that a code is not a member.
   */
  expandValueSet?(url: string, limit: number): Promise<{ codings: ExpandedCoding[]; total: number; truncated: boolean; incomplete?: boolean } | null>;
  /** Membership as the validator decides it (undefined = cannot be decided locally). */
  valueSetContains?(url: string, system: string | null, code: string): Promise<boolean | undefined>;
  /**
   * Injection point for workstream A's `authoringFields(profile, deps)`: the model-facing field
   * list of a profile (unknown-field messages list and rank these names). Without it the
   * composer derives a shallow field list from the snapshot itself.
   */
  authoringFields?(sd: Record<string, any>): FieldSpec[] | Promise<FieldSpec[]>;
  /** Appended (v1.2): how a Coding.system URL resolves (the code helps decide a known terminology). */
  resolveSystem?(url: string, code: string): Promise<SystemResolution>;
  /** Appended (v1.2): CodeSystems a ValueSet's compose draws from (include.system, one level of include.valueSet). */
  valueSetSystems?(url: string): Promise<string[]>;
  /** Appended (v1.2): is `code` a code of CodeSystem `system` (the validator's code check; undefined = cannot tell). */
  codeInSystem?(system: string, code: string): Promise<boolean | undefined>;
}
