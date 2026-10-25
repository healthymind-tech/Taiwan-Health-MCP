/**
 * Record checks (ISSUES_v15): "does the record actually provide this information?" — a
 * post-validation layer over fhir_validate_bundle / fhir_validate_resource / fhir_author_resources /
 * fhir_assemble_bundle / fhir_finalize_bundle. It never changes the validator (InstanceValidator)
 * output: its issues are appended to the issue lists with `source: "record-checks"`.
 */

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
  | "symptom-for-unconfirmed-diagnosis";

export type RecordRule = "R1" | "R2" | "R3" | "R4";

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
}

export interface RecordCheckSummary {
  /** false when any record-check error was found (the tool's `valid` is then false). */
  ok: boolean;
  errors: number;
  warnings: number;
  /** Rules that ran: R1 and R2 always; R3 and R4 only with source_text. */
  rules: RecordRule[];
  source_text: boolean;
  notes?: string[];
}

export interface RecordCheckOptions {
  /** The clinical record text (R3 / R4 run only with it). Never logged. */
  sourceText?: string | null;
  /** Facility settings text: `identifier-format <system> <format>` lines (R2). Never logged. */
  siteConfig?: string | null;
}

export interface RecordCheckResult {
  issues: RecordIssue[];
  summary: RecordCheckSummary;
}
