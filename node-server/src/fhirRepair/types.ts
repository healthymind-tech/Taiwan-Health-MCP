/**
 * Shared content-repair layer (ISSUES_v14): deterministic corrections of FHIR resources whose
 * fix is uniquely determined by the StructureDefinitions, the terminologies and FHIR R4 core.
 * Used by fhir_finalize_bundle / fhir_finalize_resource (repair: "content"), fhir_validate_bundle
 * (normalize_ids + repair: "content") and the authoring composer (fhir_author_resources /
 * fhir_assemble_bundle), so one input gets one verdict and one repair in every tool.
 *
 * Nothing that is not uniquely determined is changed: such a value is left as written and
 * reported (`issues`, with candidates); the validator's own error stays.
 */

import type { CodeAlternatives, ExpandedCoding, ImplicitProfiles, NormalizeCandidate } from "../fhirSuggestions/types.js";

export type { CodeAlternatives, ExpandedCoding, ImplicitProfiles, NormalizeCandidate };

/**
 * Rule names in `changes[].rule` (in the order the phases run). v14.1: `empty` (ele-1: an empty
 * element removed, shape phase), `fixed-slice` (a required coding slice fully determined by the
 * profile's fixed / pattern values added, slices phase), `timezone` (the site timezone added to a
 * date-time written without a UTC offset, dates phase).
 */
export type RepairRule = "shape" | "empty" | "system" | "fixed-slice" | "alt-coding" | "ucum" | "roc-date" | "timezone" | "code" | "display";

/** v15.2: `alt-coding` (an excerpt CodeSystem's unknown code → the one accepted coding of another system it links to, alternatives phase). */
export const ALL_RULES: readonly RepairRule[] = ["shape", "empty", "system", "fixed-slice", "alt-coding", "ucum", "roc-date", "timezone", "code", "display"];

export type RepairPhase = "shape" | "systems" | "slices" | "alternatives" | "units" | "dates" | "codes" | "displays";

export const ALL_PHASES: RepairPhase[] = ["shape", "systems", "slices", "alternatives", "units", "dates", "codes", "displays"];

export interface RepairChange {
  /** Instance path in the validator's dotted form (`Bundle.entry[2].resource.code.coding[0].display`). */
  path: string;
  /** The value before (null = absent). */
  from: unknown;
  /** The value after (null = removed). */
  to: unknown;
  rule: RepairRule;
  /** Why the correction is unique (the evidence). */
  reason: string;
}

/** A value the layer looked at but could not correct uniquely: left as written, with candidates. */
export interface RepairIssue {
  path: string;
  rule: RepairRule;
  /** Machine-readable kind of a few issues (e.g. `quantity-code-not-ucum`, `timezone-required`). */
  code?: string;
  severity: "error" | "warning" | "information";
  message: string;
  candidates?: unknown[];
}

export interface DisplayVerdict {
  status: "ok" | "invalid-display" | "unknown";
  /** Valid displays of the code (validator order: the code's own display first), when invalid. */
  valid: string[];
}

/**
 * How a Coding.system URL resolves:
 *   codesystem  a CodeSystem of the closure or a terminology the validator knows — never touched;
 *   valueset    the URL (or its `/CodeSystem/` → `/ValueSet/` twin) is a ValueSet of an installed package;
 *   unknown     no definition anywhere, by the validator's URL rules; `codeSystemTwin` = the
 *               `/ValueSet/` → `/CodeSystem/` twin when that is a CodeSystem;
 *   other       defined somewhere else (another package's CodeSystem, a NamingSystem …) — left as written.
 */
export type SystemResolution =
  | { kind: "codesystem" }
  | { kind: "valueset"; valueSet: string }
  | { kind: "unknown"; codeSystemTwin?: string | null }
  | { kind: "other" };

/** One known CodeSystem and the names it may be written as (R4 / R5 directory). */
export interface CodeSystemEntry {
  url: string;
  /** Names / titles / ids / identifiers (OIDs) / the URL's last path segment, as written in the source. */
  names: string[];
}

/**
 * Collaborators. Every member is read-only and optional except `fetchStructureDefinition`; a
 * missing one only disables the rules that need it (never a guess in its place).
 */
export interface RepairDeps {
  /** StructureDefinition by canonical (`|version` honoured; core: http://hl7.org/fhir/StructureDefinition/<Type>). */
  fetchStructureDefinition(url: string): Promise<Record<string, any> | null>;
  /** Display of a code in its CodeSystem; null when unknown. */
  lookupDisplay?(system: string, code: string): Promise<string | null>;
  /** The validator's verdict on a Coding display (the same terminology check fhir_validate_resource runs). */
  checkDisplay?(system: string, code: string, display: string, version: string | null): Promise<DisplayVerdict>;
  /** Free text → candidate codes of a ValueSet / CodeSystem (fhir_normalize_code). */
  normalize?(text: string, target: { system?: string; valueSet?: string }, limit: number): Promise<NormalizeCandidate[]>;
  /** Expansion of a ValueSet (null = not expandable locally); `incomplete` = a part could not be enumerated. */
  expandValueSet?(url: string, limit: number): Promise<{ codings: ExpandedCoding[]; total: number; truncated: boolean; incomplete?: boolean } | null>;
  /** Membership as the validator decides it (undefined = cannot be decided locally). */
  valueSetContains?(url: string, system: string | null, code: string): Promise<boolean | undefined>;
  /** How a Coding.system URL resolves (the code helps decide a known terminology). */
  resolveSystem?(url: string, code: string): Promise<SystemResolution>;
  /** CodeSystems a ValueSet's compose draws from (include.system, one level of include.valueSet). */
  valueSetSystems?(url: string): Promise<string[]>;
  /** Is `code` a code of CodeSystem `system` (the validator's code check; undefined = cannot tell). */
  codeInSystem?(system: string, code: string): Promise<boolean | undefined>;
  /** Installed CodeSystems of the closure with their names (R4 / R5); the static external list is added by the layer. */
  codeSystemDirectory?(): Promise<CodeSystemEntry[]>;
  /** CodeSystems of the closure that define `code` (an abstract THO code such as `_ActMedicalServiceCode`). */
  codeSystemsWithCode?(code: string): Promise<string[]>;
  /**
   * The validator's issues for a resource (stand-alone, against `profiles` + its meta.profile). When
   * given, every repair is verified: a change after which the resource has an error it did not have
   * before (a new error, or one the old shape hid) is not applied (repairResource: verify).
   */
  validate?(resource: Record<string, any>, profiles: string[]): Promise<Array<{ severity?: string; path?: string; message?: string }>>;
  /**
   * v15.2: a code's concept in any installed copy of its IG CodeSystem, with the codings of other
   * systems it links to and the validator's verdict on each (null = no copy defines it).
   */
  codeAlternatives?(system: string, code: string): Promise<CodeAlternatives | null>;
  /**
   * v15.2.1: the IG profiles of `resourceType` for a resource that declares no profile (the closure
   * package owning `system`, else the validated one) — read for the alt-coding binding only, never
   * to validate (null = unavailable / not an IG CodeSystem).
   */
  implicitProfiles?(resourceType: string, system: string): Promise<ImplicitProfiles | null>;
}

export interface RepairOptions {
  /** Path prefix that replaces the resource type in reported paths (`Bundle.entry[2].resource`). */
  rootPath?: string;
  /** Profiles the resource is checked against besides its meta.profile (finalize_resource / compose). */
  profiles?: string[];
  /**
   * The site timezone completing date-times written without a UTC offset (ROC or Gregorian): a UTC
   * offset ("+08:00") or an IANA zone name ("Asia/Taipei", resolved at each value's local time).
   * A facility / context setting (the `timezone` argument or a site_config line) — never guessed.
   */
  timezone?: string | null;
  /** Where `timezone` came from (reported in the change reasons), e.g. "timezone argument", "site_config". */
  timezoneSource?: string | null;
  /** Rule / path pairs (blockKey form) not to apply — set by the Bundle-level verification (repairBundle). */
  blocked?: Set<string>;
  /** Phases to run (default all, in ALL_PHASES order). */
  phases?: RepairPhase[];
  /**
   * Values not to touch (FHIR path relative to the resource, e.g. `Observation.code.coding[0].display`,
   * and the rule): the composer protects what the profile pinned / what it looked up itself.
   */
  skip?(path: string, rule: RepairRule): boolean;
  /** Shared caches / budgets across several resources of one call (repairBundle passes one). */
  session?: unknown;
}

export interface RepairResult {
  changes: RepairChange[];
  issues: RepairIssue[];
}
