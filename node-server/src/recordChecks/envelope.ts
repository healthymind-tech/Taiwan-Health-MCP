/**
 * Tool-layer integration of the record checks: takes a tool's finished JSON envelope (validate /
 * finalize), runs runRecordChecks on the instance the verdict is about and returns the envelope
 * with the record-check issues appended. The envelope is re-read losslessly (losslessJson) so every
 * number the caller wrote (normalized_bundle / bundle) keeps its spelling; nothing else in it changes
 * apart from `valid` (false when a record-check error was added), the appended issues,
 * `record_checks` and three provenance fields.
 *
 * Validation envelopes (fhir_validate_bundle / fhir_validate_resource, also behind
 * fhir_author_resources / fhir_assemble_bundle): issues go where the validator's would — a Bundle's
 * entry issues into `entries[i].issues` (entries[i].valid too), Bundle-level ones into `issues`.
 * Finalize envelopes (fhir_finalize_bundle): `record_issues` + `record_checks` (the Bundle itself is
 * never changed — report only); fhir_finalize_resource: into its `validation` block, as fhir_validate_resource.
 *
 * Grounding issues the validating tools return are annotated, never re-run: R6 date corrections, and (ISSUES_v15.3 R3)
 * coded-element G-UNGROUNDED / G-VALUE-MISMATCH rewritten to say what was compared, with the closest record phrase
 * and a warning instead of an error unless the record clearly states something else (codeGrounding.ts).
 *
 * Byte-identity: without source_text and without any finding the envelope is returned UNCHANGED (no
 * `record_checks`, no provenance fields), so a clean call's output is exactly what it was before the
 * layer existed. `record_checks` appears when source_text is given or at least one issue was found.
 */
import { parseLossless, stringifyLossless, toPlain } from "../losslessJson.js";
import { recordChecksProvenance, runRecordChecks } from "./index.js";
import { RecordValues } from "./recordValues.js";
import { withDateCorrections } from "./valueGrounding.js";
import { annotateGroundingCodes } from "./codeGrounding.js";
import type { RecordCheckOptions, RecordCheckResult, RecordIssue } from "./types.js";

type Json = Record<string, any>;
const isObj = (x: unknown): x is Json => !!x && typeof x === "object" && !Array.isArray(x);

function parse(text: string): Json | null {
  try {
    const env = parseLossless(text);
    return isObj(env) && env.ok === true && isObj(env.data) ? env : null;
  } catch {
    return null;
  }
}

/** Whether the layer leaves its trace on the envelope (see "Byte-identity" above). */
function emits(result: RecordCheckResult): boolean {
  return result.summary.source_text || result.issues.length > 0 || !!result.summary.notes?.length;
}

function provenance(env: Json): void {
  env.provenance = { ...(isObj(env.provenance) ? env.provenance : {}), ...recordChecksProvenance() };
}

/** Distribute issues onto a validation data block (in place); returns the summary. */
export function mergeRecordIssues(data: Json, target: Json, result: RecordCheckResult): void {
  const errors = (xs: RecordIssue[]): boolean => xs.some((i) => i.severity === "error");
  if (target.resourceType === "Bundle" && Array.isArray(data.entries)) {
    // entries[] lists the Bundle entries that have a resource (in order); map entry index → row.
    const rowOf = new Map<number, number>();
    let j = 0;
    (Array.isArray(target.entry) ? target.entry : []).forEach((e: unknown, i: number) => {
      if (isObj(e) && isObj(e.resource) && typeof e.resource.resourceType === "string") rowOf.set(i, j++);
    });
    const bundleLevel: RecordIssue[] = [];
    for (const iss of result.issues) {
      const m = /^Bundle\.entry\[(\d+)\]/u.exec(iss.path);
      const row = m ? rowOf.get(Number(m[1])) : undefined;
      const entry = row !== undefined ? data.entries[row] : undefined;
      if (isObj(entry)) {
        if (!Array.isArray(entry.issues)) entry.issues = [];
        entry.issues.push(iss);
        if (iss.severity === "error") entry.valid = false;
      } else bundleLevel.push(iss);
    }
    if (bundleLevel.length) data.issues = [...(Array.isArray(data.issues) ? data.issues : []), ...bundleLevel];
  } else {
    data.issues = [...(Array.isArray(data.issues) ? data.issues : []), ...result.issues];
  }
  if (errors(result.issues)) data.valid = false;
  data.record_checks = result.summary;
}

const RE_TOKEN = /([^.[\]]+)(?:\[(\d+)\])?/gu;
const RE_FHIR_DATE = /^\d{4}(-\d{2}(-\d{2}(T.*)?)?)?$/u;
const UNGROUNDED_RULES = new Set(["G-UNGROUNDED", "G-VALUE-MISMATCH"]);

/** Value at an issue path (Bundle.entry[0].resource.birthDate / Patient.birthDate) and its generic path. */
function valueAt(target: Json, path: string): { value: unknown; gpath: string } | null {
  const toks = [...path.matchAll(RE_TOKEN)].map((m) => [m[1], m[2] === undefined ? null : Number(m[2])] as const);
  if (!toks.length || toks[0][0] !== target.resourceType) return null;
  let node: unknown = target;
  let rt = String(target.resourceType);
  let gparts: string[] = [];
  for (const [k, i] of toks.slice(1)) {
    if (!isObj(node)) return null;
    node = node[k];
    if (i !== null) node = Array.isArray(node) ? node[i] : undefined;
    if (k === "resource" && isObj(node) && typeof node.resourceType === "string") {
      rt = node.resourceType;
      gparts = [];
    } else if (!(target.resourceType === "Bundle" && gparts.length === 0 && k === "entry")) gparts.push(k);
  }
  return { value: node, gpath: [rt, ...gparts].join(".") };
}

/**
 * ISSUES_v15.1 R6 on the grounding issues the validating tools return: a G-UNGROUNDED / G-VALUE-MISMATCH date
 * whose month / day the record states with another year gets the record's date as a replace_value
 * suggestion. fhir_check_grounding itself is never touched (its output is compared with the reference).
 */
function annotateGroundingDates(data: Json, target: Json, opts: RecordCheckOptions): void {
  if (typeof opts.sourceText !== "string" || !opts.sourceText.trim()) return;
  let rv: RecordValues | null = null;
  const fix = (list: unknown): void => {
    if (!Array.isArray(list)) return;
    list.forEach((iss, k) => {
      if (!isObj(iss) || iss.source !== "grounding" || !UNGROUNDED_RULES.has(String(iss.rule)) || typeof iss.path !== "string") return;
      const at = valueAt(target, iss.path);
      if (!at || typeof at.value !== "string" || !RE_FHIR_DATE.test(at.value)) return;
      rv ??= new RecordValues(opts.sourceText as string, opts.siteConfig ?? null);
      const out = withDateCorrections(iss as { message: string; suggestions?: never[] }, at.value, iss.path, at.gpath, rv);
      if (out !== iss) list[k] = out;
    });
  };
  fix(data.issues);
  for (const e of Array.isArray(data.entries) ? data.entries : []) if (isObj(e)) fix(e.issues);
}

/**
 * fhir_validate_bundle / fhir_validate_resource envelope + record checks. `instance` is the Bundle /
 * resource as given; a Bundle validated after normalize_ids is checked as `data.normalized_bundle`
 * (the one the entries describe). Returns `text` unchanged when it is not a successful envelope.
 */
export function addRecordChecksToValidation(text: string, instance: Json, opts: RecordCheckOptions = {}): string {
  const env = parse(text);
  if (!env) return text;
  const data = env.data as Json;
  const target = (data.normalized_bundle !== undefined ? toPlain(data.normalized_bundle) : instance) as Json;
  if (!isObj(target)) return text;
  const result = runRecordChecks(target, opts);
  if (!emits(result)) return text;
  mergeRecordIssues(data, target, result);
  try {
    annotateGroundingDates(data, target, opts);
  } catch {
    // fail-open: the suggestions are additive
  }
  try {
    // ISSUES_v15.3 R3: coded-element G-UNGROUNDED / G-VALUE-MISMATCH — what was compared, the closest record phrase, and
    // a warning instead of an error unless the record clearly names something else (codeGrounding.ts)
    if (typeof opts.sourceText === "string" && opts.sourceText.trim()) {
      const st = annotateGroundingCodes(data, target, opts.sourceText, opts.siteConfig ?? null, opts.codeNames ?? null);
      if (st && isObj(data.record_checks)) data.record_checks = { ...data.record_checks, grounding_codes: st };
    }
  } catch {
    // fail-open: the grounding issues keep their original form
  }
  provenance(env);
  return stringifyLossless(env);
}

/** fhir_finalize_bundle envelope + record checks on the finalized Bundle (data.record_issues / data.record_checks). */
export function addRecordChecksToFinalize(text: string, opts: RecordCheckOptions = {}): string {
  const env = parse(text);
  if (!env) return text;
  const data = env.data as Json;
  const bundle = toPlain(data.bundle) as Json;
  if (!isObj(bundle)) return text;
  const result = runRecordChecks(bundle, opts);
  if (!emits(result)) return text;
  data.record_issues = result.issues;
  data.record_checks = result.summary;
  if (result.summary.errors) {
    env.warnings = [
      ...(Array.isArray(env.warnings) ? env.warnings : []),
      `${result.summary.errors} record-check error(s) (data.record_issues): values the record does not actually provide — not corrected; report insufficient_information if the task needs them`,
    ];
  }
  provenance(env);
  return stringifyLossless(env);
}

/** fhir_finalize_resource envelope + record checks on the finalized resource, merged into `data.validation`. */
export function addRecordChecksToFinalizeResource(text: string, opts: RecordCheckOptions = {}): string {
  const env = parse(text);
  if (!env) return text;
  const data = env.data as Json;
  const resource = toPlain(data.resource) as Json;
  if (!isObj(resource) || !isObj(data.validation)) return text;
  const result = runRecordChecks(resource, opts);
  if (!emits(result)) return text;
  const wasValid = data.validation.valid === true;
  mergeRecordIssues(data.validation, resource, result);
  if (wasValid && data.validation.valid === false) {
    env.warnings = [...(Array.isArray(env.warnings) ? env.warnings : []), "validation found errors — fix the draft and call finalize again"];
  }
  provenance(env);
  return stringifyLossless(env);
}
