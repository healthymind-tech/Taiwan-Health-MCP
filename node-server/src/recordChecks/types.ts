/**
 * Record checks (ISSUES_v15): "does the record actually provide this information?" — a
 * post-validation layer over fhir_validate_bundle / fhir_validate_resource / fhir_author_resources /
 * fhir_assemble_bundle / fhir_finalize_bundle. It never changes the validator (InstanceValidator)
 * output: its issues are appended to the issue lists with `source: "record-checks"`.
 */

import type { Suggestion } from "../fhirSuggestions/types.js";

import type { IgDefinedValues } from "../grounding/igDefined.js";

export type RecordCheckCode =
  /** R1: the value describes the absence of the information (未取號, unknown, pending …). */
  | "information-absent"
  /** R2: the identifier does not have the format of its system (or is a sentence). */
  | "identifier-format"
  /** R3: a date / dateTime coarser than the element needs (year or year-month for an event time). */
  | "insufficient-precision"
  /** R3: a value that cannot be used as written (Quantity without value; medicine text without code or dose). */
  | "incomplete-value"
  /** R4: a diagnosis written as confirmed while the record says it is not established. */
  | "unconfirmed-as-confirmed"
  /** R4: a symptom code where the record's main diagnosis is still to be ruled out. */
  | "symptom-for-unconfirmed-diagnosis"
  /**
   * R5 (ISSUES_v15.1 R1): an identifier / date / dateTime / Quantity value that the record (or
   * site_config) does not state — neither verbatim, nor normalised (ROC → Gregorian, full-width,
   * separators, units), nor derivable (入院第3天 + the admission date, POD#2, 3 天前 …).
   */
  | "ungrounded-value"
  /** R5 (ISSUES_v15.1 R4): the value is in the record but belongs to another time point / event. */
  | "value-from-other-event"
  /** R5 (ISSUES_v17.4): the value is in the record only as an old / no-longer-valid / pending value (已不適用, 前次, 待補). */
  | "stale-value"
  /** R6 (ISSUES_v17 R2-3): an item the record negates / cancels / defers (or the conversion target excludes) written as done or active. */
  | "negated-item-present"
  /** R6 (ISSUES_v17 R2-4): an entry that repeats another (same content apart from ids, or the same thing). */
  | "duplicate-entry"
  /** R6 (ISSUES_v17 R2-1): a fact (dose, frequency, route, duration …) written only in a text field while its structured element is empty. */
  | "text-only-fact"
  /** R6 (ISSUES_v17 R2-2): a fact the record states clearly, for a field the profile marks mustSupport / required, left empty. */
  | "record-fact-missing"
  /** R5 (ISSUES_v20 R3): an identifier value that is only a fragment of the identifier the record states (醫字第035190號 → 035190). */
  | "identifier-truncated"
  /**
   * R7 (ISSUES_v20 R2): a coding whose syntax and ValueSet membership are fine but whose meaning differs from the record
   * phrase it stands for (a LOINC code of another test, an ICD code of another diagnosis, another medicine / procedure).
   */
  | "code-meaning-mismatch"
  /** R7 (ISSUES_v20.1 item 3): a generic class code (Hormone therapy, Chemotherapy) for an item the record does not name. */
  | "generic-code-for-unknown-item";

/**
 * R1 information-absent · R2 identifier-format · R3 precision / completeness · R4 unconfirmed
 * diagnoses (incl. the primary diagnosis slot, ISSUES_v15.1 R3) · R5 value grounding (ISSUES_v15.1
 * R1 / R4: every identifier, date and quantity value must come from the record).
 */
export type RecordRule = "R1" | "R2" | "R3" | "R4" | "R5" | "R6" | "R7";

/** ISSUES_v20 R3: a profile's constraint on an identifier value (read from the StructureDefinition). */
export interface IdentifierRule {
  /** Unversioned profile canonical (null = any). */
  profile: string | null;
  resourceType: string | null;
  /** The identifier slice's fixed / pattern system (null = every identifier of the profile). */
  system: string | null;
  /** The value element is constrained to digits only (regex / pattern / a matches('^[0-9]+$')-like invariant). */
  digitsOnly: boolean;
}

/** ISSUES_v20 R2: a candidate code of the element's system / bound ValueSet for a record phrase (fhir_normalize_code). */
export interface MeaningCandidate {
  system: string | null;
  code: string;
  display: string | null;
  score?: number;
}

export interface RecordIssue {
  severity: "error" | "warning";
  code: RecordCheckCode;
  path: string;
  /** Chinese + English in one line (the tools' issue `message`). */
  message: string;
  message_zh: string;
  message_en: string;
  rule: RecordRule;
  source: "record-checks";
  /** The basis of the verdict: what was examined and how the record was searched. */
  evidence: string;
  /** Record text the verdict rests on (R3 / R4), when there is some. */
  located_quotes?: string[];
  /**
   * ISSUES_v15.1 R6: corrections the record itself determines (an ungrounded date whose month / day the record
   * states with another year — a wrong ROC ↔ Gregorian conversion): kind replace_value with a patch. Never applied.
   */
  suggestions?: Suggestion[];
  /** ISSUES_v20 R2 (code-meaning-mismatch): the record phrase the coding stands for. */
  record_phrase?: string;
  /** ISSUES_v20 R2 (code-meaning-mismatch): the coding's official name (terminology table, not the model's display). */
  code_display?: string;
}

export interface RecordCheckSummary {
  /** false when any record-check error was found (the tool's `valid` is then false). */
  ok: boolean;
  errors: number;
  warnings: number;
  /** Rules that ran: R1 and R2 always; R3, R4 and R5 only with source_text. */
  rules: RecordRule[];
  source_text: boolean;
  notes?: string[];
  /**
   * ISSUES_v15.3 R3 (validating tools only): coded-element G-UNGROUNDED / G-VALUE-MISMATCH grounding issues annotated —
   * how many, and how many are warnings / errors after the rule (codeGrounding.ts).
   */
  grounding_codes?: { examined: number; warnings: number; errors: number };
}

export interface RecordCheckOptions {
  /** The clinical record text (R3 / R4 run only with it). Never logged. */
  sourceText?: string | null;
  /** Facility settings text: `identifier-format <system> <format>` lines (R2). Never logged. */
  siteConfig?: string | null;
  /**
   * ISSUES_v15.3 R1: LOINC axes (PROPERTY / SCALE_TYP) of the instance's Observation codes, keyed
   * `http://loinc.org|<code>` — whether an Observation needs a quantitative result (quantitative.ts).
   * Optional: without it the decision falls back to the LOINC name, vital-sign codes and the resource.
   */
  codeAxes?: ReadonlyMap<string, { property?: string | null; scale?: string | null }> | null;
  /**
   * ISSUES_v15.3 R3: terminology names by `system|code` (the names grounding compared) — the validating tools' rewrite
   * of coded-element G-UNGROUNDED issues compares them with the record too (codeGrounding.ts). Optional.
   */
  codeNames?: ReadonlyMap<string, readonly string[]> | null;
  /**
   * ISSUES_v15.3 R3 follow-up: Chinese names of SNOMED codings by `system|code` with source and confidence
   * (grounding/snomedChinese.ts) — read only by the coded-element grounding comparison (codeGrounding.ts). Optional.
   */
  codeNamesZh?: ReadonlyMap<string, readonly { name: string; source: string; confidence: number; icd?: string }[]> | null;
  /**
   * ISSUES_v15.3 R3 follow-up (hierarchy guard): per SNOMED coding key, the diagnosis-slot item texts naming the same, a
   * broader or a narrower SNOMED concept (snomed.concept_ancestors) — such an item is never "something else". Optional.
   */
  codeSlotRelations?: ReadonlyMap<string, ReadonlySet<string>> | null;
  /**
   * ISSUES_v17 R2: severity of the content-coverage findings that are not safety issues (text-only facts; facts the record
   * states but the instance leaves out) — "warning" (default) or "error" (an evaluator feeds them back as errors).
   * Negated items written as done and duplicate entries are always errors.
   */
  coverageSeverity?: "warning" | "error" | null;
  /**
   * ISSUES_v17 R2-2: per declared profile (meta.profile, unversioned), the element paths it marks mustSupport / requires
   * (base form) — the IG's commonly used fields (record-fact-missing looks only at those). Optional.
   */
  profileElements?: ReadonlyMap<string, { mustSupport: ReadonlySet<string>; required: ReadonlySet<string>; common?: ReadonlySet<string>; prohibited?: ReadonlySet<string> }> | null;
  /**
   * ISSUES_v17.2: values the IG defines (grounding/igDefined.ts: fixed / pattern, skeleton ig-constants, invariant
   * literals) — never record facts: their slots are not checked and no value issue is reported on them. Optional.
   */
  igDefined?: IgDefinedValues | null;
  /**
   * ISSUES_v20 R6 / R2: abbreviation expansions by lower-cased token (grounding/abbreviations.ts; fhir.term_thesaurus +
   * fhir.abbreviation_lexicon) — a record label written as an abbreviation still names its code. Optional.
   */
  abbreviations?: ReadonlyMap<string, readonly string[]> | null;
  /** ISSUES_v20 R3: profile constraints on identifier values (digits only). Optional. */
  identifierRules?: readonly IdentifierRule[] | null;
  /**
   * ISSUES_v20 R2: fhir_normalize_code candidates for the record phrases of suspect codings (codeMeaning.ts
   * meaningTargets), keyed `<instance path>\u0000<record phrase>`. A coding is reported only when its candidates confirm
   * that the phrase names another code; without them there is no finding (never a guess). Optional.
   */
  meaningCandidates?: ReadonlyMap<string, readonly MeaningCandidate[]> | null;
}

export interface RecordCheckResult {
  issues: RecordIssue[];
  summary: RecordCheckSummary;
}
