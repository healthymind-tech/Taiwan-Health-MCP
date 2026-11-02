/**
 * In-process FHIR R4 instance validator (source: "builtin").
 *
 * Walks a resource instance against StructureDefinition snapshots the way the
 * HL7 Java validator does:
 *
 *  - every resource is validated against its base definition, each
 *    `meta.profile`, any profile the caller names, and the profiles a parent
 *    element requires (Bundle entry slices, contained resources, references);
 *  - cardinality is counted per parent instance (not across repeats);
 *  - slicing assigns each repeat to a slice by its discriminators (value,
 *    pattern, type, profile, exists), then checks per-slice cardinality and
 *    closed slicing;
 *  - choice elements (`value[x]`) are typed by their JSON property name;
 *  - datatypes without children in the profile are validated against the
 *    datatype's own StructureDefinition (or the `type.profile`), so datatype
 *    invariants (ref-1, per-1, qty-3, ext-1 …) run too;
 *  - extensions are resolved by URL and validated against their definitions;
 *  - primitives are checked for JSON type, regex, empty values and calendar
 *    validity; fixed / pattern / maxLength are enforced;
 *  - bindings: required → error, extensible → warning; codes from held
 *    CodeSystems are checked for existence and display;
 *  - URIs: urn:oid / urn:uuid syntax, and URLs in the HL7 spaces must resolve
 *    to a known definition (fhirUriRules.ts); a ValueSet URL used as a code
 *    system is an error; Quantity UCUM codes are parsed (fhirUcum.ts);
 *  - slicing: an element matching more than one slice is an error; R4
 *    vital-sign profiles are implied from Observation.code like the HL7
 *    validator (incl. its alternative LOINC / SNOMED codes);
 *  - invariants are evaluated with a type-aware FHIRPath engine. An invariant
 *    that cannot be evaluated locally is reported as `information`, never as
 *    an error.
 *
 * The engine is pure: every StructureDefinition / terminology lookup goes
 * through the injected `ValidatorResolver`.
 */

import { createHash } from "node:crypto";
import { evaluateConstraint, evaluateExpression, fhirPathBase, invariantExpression, primitiveValueAlias, type FhirPathEnv } from "./fhirPath.js";
import { fixedPattern } from "./fhirSnapshot.js";
import { generateSnapshotAsync } from "./fhirSnapshotGenerator.js";
import { validateStructureDefinition } from "./fhirSdValidator.js";
import { pushAll } from "./arrayUtils.js";
import { UCUM_SYSTEM, checkUcumCode, convertUcum, ucumDisplayIssue, ucumUnknownCodeMessage } from "./fhirUcum.js";
import { XVER_SOURCE, xverDefinition, xverElementId, xverMatchingUrl, xverStatus, xverVersion } from "./fhirXver.js";
import { CANONICAL_RESOURCES, hl7UrlMustResolve, uriResolutionExempt, urlResolveMessage, urnSyntaxIssue } from "./fhirUriRules.js";
import { codingVersionIssue } from "./fhirExternalTerminology.js";
import { codingVersionIssues } from "./fhirCsVersion.js";
import { isAbsoluteUrl, serverPrefers } from "./fhirSpecialSystems.js";
import { validateCodeSystemResource } from "./fhirCodeSystemResource.js";
import { validateConceptMapResource } from "./fhirConceptMapResource.js";
import { validateValueSetResource } from "./fhirValueSetResource.js";
import { checkFhirPathJava, PathEngineError } from "./fhirPathJavaCheck.js";
import { languageXhtmlIssues, narrativeControlIssues, parseXhtml, textLinkIssues, validateXhtml, xhtmlHrefIssues, type TextLinkSelector } from "./fhirXhtml.js";
import { copyLiterals, duplicateKeys, numberText } from "./fhirJsonLiterals.js";
import { dropUnprocessed, JsonSyntaxError, jsonSyntaxIssues, parseFhirJsonText, toPlain, type JObject } from "./fhirJsonParser.js";
import { withValidationSnapshot } from "./fhirValidationSnapshot.js";
import { LookupSession, sessionResolver } from "./fhirValidatorSession.js";
import { validateImplementationGuide, validateSearchParameter } from "./fhirConformanceRules.js";
import { validateQuestionnaire, validateQuestionnaireResponse } from "./fhirQuestionnaireRules.js";
import { validateMeasure, validateMeasureReport } from "./fhirMeasureRules.js";
import { ucumCanonicalForm } from "./fhirUcum.js";

export const SOURCE = "builtin";

export interface Issue {
  severity: "fatal" | "error" | "warning" | "information";
  /** Instance location, e.g. `Patient.identifier[1].system`. */
  path: string;
  code: string;
  message: string;
  /** ElementDefinition id the issue was raised against (when applicable). */
  element?: string;
  /** StructureDefinition canonical the issue comes from (when applicable). */
  profile?: string;
  /**
   * Set on the issue that reports a definition the validator could not check
   * (profile / required-binding ValueSet not resolvable, e.g. a `|version`
   * that is not installed). Feeds `completenessOf()`; never changes severity.
   * `code`: a code / binding membership local terminology cannot decide (canonical = ValueSet or system);
   * `slice`: slice membership / cardinality that could not be decided (canonical = profile#element id);
   * `limit`: a validator limit stopped a check (canonical = the limit's name, see VALIDATOR_LIMITS);
   * `invariant`: an invariant that could not be evaluated (canonical = profile#key);
   * `lookup`: definition / terminology lookups failed, some checks are unverified (canonical = the first failed lookup);
   * `run`: a definition could not be loaded, so the run has no verdict at all;
   * `rule`: the input reached a check of validator_cli that is not ported (canonical = the Java rule).
   */
  /** `causes`: what could not be decided, as `system|valueSet` (a slicing or a binding names the terminology behind it). */
  unchecked?: { kind: "profile" | "valueSet" | "code" | "slice" | "limit" | "invariant" | "lookup" | "run" | "rule"; canonical: string; causes?: string[] };
}

/** The validator's checking limits (`unchecked.kind: "limit"`): exceeding one reports it and `checked_fully: false`. */
export const VALIDATOR_LIMITS = { elementDepth: "element-depth", regex: "element-regex" } as const;

export function issue(severity: string, path: string, code: string, message: string, extra: Partial<Issue> = {}): Record<string, any> {
  return { severity, path, code, message, ...extra };
}

export function isValid(issues: Array<Record<string, any>>): boolean {
  return !issues.some((i) => i.severity === "error" || i.severity === "fatal");
}

/** Machine-readable completeness of one validation run (see completenessOf). */
export interface Completeness {
  /**
   * Parity layer (ROUND 9): true when every check validator_cli would do was done here. A profile it cannot resolve
   * either (it only warns) does not lower it; a missing IG dependency, an undecided code / slice / invariant, a failed
   * lookup or an unresolved required ValueSet (the validator asks its terminology server for it) do.
   */
  checked_fully: boolean;
  /** Canonicals (as written, `|version` kept) of profiles that were not checked: reported, validator_cli warns on them too. */
  profiles_unchecked: string[];
  /** Required-binding ValueSets (as written) that could not be resolved, so the binding was not checked. */
  valuesets_unchecked: string[];
  /**
   * Number of definition / terminology lookups that failed while validating
   * (database trouble; v8). Present only when > 0: the run then also carries
   * a warning issue with code `exception` and `checked_fully` is false.
   */
  lookups_failed?: number;
  /**
   * (parity v3, REVIEW F5) ValueSets / code systems whose membership or codes local terminology could not decide
   * (the HL7 validator asks its terminology server). Present only when non-empty; `checked_fully` is then false.
   */
  codes_unchecked?: string[];
  /** (parity v3, REVIEW F5) Slicings (profile#element) whose membership / cardinality could not be decided. */
  slices_unchecked?: string[];
  /** (parity v3) Validator limits that stopped a check (VALIDATOR_LIMITS). Present only when non-empty. */
  limits_exceeded?: string[];
  /** (parity v3) Invariants (profile#key) that could not be evaluated. Present only when non-empty. */
  invariants_unchecked?: string[];
  /** Rules of validator_cli this input reached that are not ported. Present only when non-empty; `checked_fully` is then false. */
  rules_unchecked?: string[];
  /** What the undecided codes and slices depended on: `system|valueSet` (an empty system: a bare code). */
  undecided_causes?: string[];
}

/** Issue code of the "validation incomplete: lookups failed" error (v8). */
export const LOOKUP_FAILURE_CODE = "exception";

/**
 * The issue reported when definition / terminology lookups failed during a validation. A transient failure says nothing
 * about the resource, so it is not an error (InstanceValidator.java:1796-1798, tag 7.0.1: an infrastructure failure of the
 * terminology service is a txWarning, TERMINOLOGY_TX_CONFIRM_*, never a binding error); it is never a clean pass either:
 * `checked_fully` is false, `lookups_failed` counts the failures and the checks are unverified. `noVerdict`: a definition
 * could not be loaded, so nothing else in the run counts (see hasNoVerdict).
 */
export function lookupFailureIssue(total: number, samples: Array<{ code: string | null; message: string }>, noVerdict = false): Issue {
  const detail = samples
    .slice(0, 3)
    .map((f) => `${f.code ? `[${f.code}] ` : ""}${f.message}`)
    .join("; ");
  return {
    severity: "warning",
    path: "",
    code: LOOKUP_FAILURE_CODE,
    message:
      `Validation incomplete: ${total} definition / terminology lookup${total === 1 ? "" : "s"} failed during validation (${detail}); ` +
      (noVerdict
        ? "a definition could not be loaded, so the resource was not judged — validate again once the database is reachable"
        : "the checks that needed them are unverified — validate again once the database is reachable"),
    unchecked: { kind: noVerdict ? "run" : "lookup", canonical: samples[0]?.message ?? "lookup" },
  };
}

/** The run ended without a verdict (a definition could not be loaded): `valid` is then null, neither pass nor fail. */
export function hasNoVerdict(issues: Array<Record<string, any>>): boolean {
  return issues.some((i) => i && i.unchecked?.kind === "run");
}

/**
 * Completeness of a validation from its issues (+ the IG closure's missing
 * dependencies). `valid` keeps HL7 validator_cli semantics, and `checked_fully`
 * means exactly: every check the validator would do was done (evaluator, ROUND 9).
 * An unresolvable profile is a warning there too (Validation_VAL_Profile_Unknown),
 * so it stays listed in `profiles_unchecked` without lowering `checked_fully`;
 * extended_findings (extendedFindings/) judges it. A ValueSet not found locally does
 * lower it: the validator asks its terminology server (BaseWorkerContext.findTxResource,
 * standalone tag 7.0.1:3948-3950), and the server's ValueSets are not known here.
 */
export function completenessOf(issues: Array<Record<string, any>>, depsMissing: unknown[] = []): Completeness {
  const profiles = new Set<string>();
  const valueSets = new Set<string>();
  const codes = new Set<string>();
  const slices = new Set<string>();
  const limits = new Set<string>();
  const invariants = new Set<string>();
  const rules = new Set<string>();
  const causes = new Set<string>();
  let lookupsFailed = 0;
  for (const i of issues) {
    if (i && i.code === LOOKUP_FAILURE_CODE) {
      const m = /^Validation incomplete: (\d+) /.exec(String(i.message || ""));
      lookupsFailed += m ? Number(m[1]) : 1;
    }
    const u = i && i.unchecked;
    if (!u || typeof u.canonical !== "string" || u.kind === "lookup" || u.kind === "run") continue;
    for (const c of Array.isArray(u.causes) ? u.causes : []) causes.add(String(c));
    (u.kind === "rule" ? rules : u.kind === "valueSet" ? valueSets : u.kind === "code" ? codes : u.kind === "slice" ? slices : u.kind === "limit" ? limits : u.kind === "invariant" ? invariants : profiles).add(u.canonical);
  }
  return {
    checked_fully: valueSets.size === 0 && codes.size === 0 && slices.size === 0 && limits.size === 0 && invariants.size === 0 && rules.size === 0 && lookupsFailed === 0 && !(Array.isArray(depsMissing) && depsMissing.length),
    profiles_unchecked: [...profiles],
    valuesets_unchecked: [...valueSets],
    ...(lookupsFailed > 0 ? { lookups_failed: lookupsFailed } : {}),
    ...(codes.size ? { codes_unchecked: [...codes] } : {}),
    ...(slices.size ? { slices_unchecked: [...slices] } : {}),
    ...(limits.size ? { limits_exceeded: [...limits] } : {}),
    ...(invariants.size ? { invariants_unchecked: [...invariants] } : {}),
    ...(rules.size ? { rules_unchecked: [...rules] } : {}),
    ...(causes.size ? { undecided_causes: [...causes].sort() } : {}),
  };
}

export function relPath(path: string, root: string): string | null {
  if (path === root) return "";
  const prefix = root + ".";
  return path.startsWith(prefix) ? path.slice(prefix.length) : null;
}

/** Flat list of values at a dotted element path relative to `node` (choice `[x]` aware). */
export function getAtPath(node: any, rel: string): any[] {
  if (rel === "") return [node];
  let current: any[] = [node];
  for (const seg of rel.split(".")) {
    const nxt: any[] = [];
    const choice = seg.endsWith("[x]");
    const stem = choice ? seg.slice(0, -3) : seg;
    for (const item of current) {
      if (!(item && typeof item === "object" && !Array.isArray(item))) continue;
      if (choice) {
        for (const [key, val] of Object.entries(item)) {
          if (key.startsWith(stem) && key !== stem && /[A-Z]/.test(key[stem.length] || "")) {
            if (Array.isArray(val)) pushAll(nxt, val);
            else nxt.push(val);
          }
        }
      } else if (seg in item) {
        const val = item[seg];
        if (Array.isArray(val)) pushAll(nxt, val);
        else nxt.push(val);
      }
    }
    current = nxt;
    if (current.length === 0) break;
  }
  return current.filter((v) => v !== null && v !== undefined);
}

// --------------------------------------------------------------------------- //
// Resolver contract
// --------------------------------------------------------------------------- //

/** Extra issues a code check reports alongside its verdict (e.g. HL7 INACTIVE_CONCEPT_FOUND). */
export interface CodeCheckExtra {
  extra?: Array<{ severity: "warning" | "information"; message: string }>;
  /** The code could not be checked with local data although the HL7 validator's terminology server would (REVIEW F5). */
  undecided?: boolean;
}

export type CodeCheck = (
  | { status: "ok" }
  /** The system is not known locally (HL7: warning UNKNOWN_CODESYSTEM). */
  | { status: "unknown-system" }
  /** Known-but-unchecked system (e.g. UCUM, BCP-47): say nothing. */
  | { status: "silent" }
  /** `at: "system"`: the finding is about Coding.system (e.g. CODESYSTEM_CS_NO_SUPPLEMENT), not the code. */
  | { status: "invalid-code"; severity: "error" | "warning" | "information"; message: string; at?: "system" }
  | { status: "invalid-display"; severity: "error" | "warning" | "information"; message: string }
  /** A display was given but there is no local terminology to check it against: an information note, always `unchecked`. */
  | { status: "display-unchecked"; message: string }
) &
  CodeCheckExtra;

/**
 * Contract for every lookup: a rejected promise means "no answer" (database / network / timeout trouble), a real "not
 * found" is the method's null / undefined / false. A rejection is never a finding (fhirValidatorSession.ts).
 */
export interface ValidatorResolver {
  /**
   * StructureDefinition by canonical URL. The URL may carry `|version`: the
   * resolver must then return only a definition of that version (HL7
   * CanonicalResourceManager.getByPackage rules, see pickCanonicalVersion), or
   * null when that version is not installed in the package closure.
   */
  fetchStructureDefinition(url: string): Promise<Record<string, any> | null>;
  /**
   * BaseWorkerContext.fetchResource with a sourceForReference (l. 2531-2533, populatePVList l. 2685-2702): the version of
   * `url` seen from the package of `source`: that package, then its dependencies breadth-first. Null when none of them holds
   * it, or `source` comes from no package, or from a core one (ProfileUtilities.findProfile "switch the extension pack in").
   */
  scopedDefinitionVersion?(url: string, source: Record<string, any>): Promise<string | null>;
  /** ValueSet header (url/title) or null when the ValueSet is not held (`|version` honoured as above). */
  fetchValueSet(url: string): Promise<Record<string, any> | null>;
  /** Membership; system null for bare `code` values. undefined = cannot decide locally. `|version` honoured. */
  valueSetContains(url: string, system: string | null, code: string): Promise<boolean | undefined>;
  /**
   * Existence / display check of a code in its CodeSystem (Coding.version when given). `langs`: the requested
   * display languages (ValidationOptions languages; default ['en']).
   */
  checkCode(system: string, code: string, display: string | null, version?: string | null, langs?: string[]): Promise<CodeCheck>;
  /**
   * Can the HL7 validator resolve this code system at all (a CodeSystem with
   * this exact canonical in the package closure, or one tx.fhir.org serves)?
   * Optional; without it every system counts as resolvable.
   */
  codeSystemResolvable?(system: string): Promise<boolean>;
  /**
   * Does the package closure hold this code system as a CodeSystem resource with
   * content complete / fragment that the HL7 validator checks locally (i.e. not a
   * system it hands to the terminology server, such as LOINC or SNOMED CT)?
   * Optional; without it a code-less Coding never matches a binding slice.
   */
  codeSystemLocal?(system: string): Promise<boolean>;
  /**
   * Does a conformance resource with this canonical URL exist in any loaded
   * package? Used for the HL7 "No definition could be found for URL value"
   * check. Optional: without it URL resolution is not checked.
   */
  definitionExists?(url: string): Promise<boolean>;
  /** Versions of the CodeSystem `system` held in the closure ([] = not held). Optional (G3 version checks). */
  codeSystemVersions?(system: string): Promise<string[]>;
  /** The CodeSystem resource of a canonical (`|version` honoured), null when not held. Optional (CodeSystem / ValueSet resource checks). */
  fetchCodeSystem?(url: string): Promise<Record<string, any> | null>;
  /** Is there a CodeSystem with exactly this canonical (Terminology_TX_ValueSet_NotFound_CS)? Optional. */
  codeSystemExists?(url: string): Promise<boolean>;
  /** (v17.5) Is `version` an installed version of the definition `url`? Absent = not checked (fail-open). */
  definitionVersionExists?(url: string, version: string): Promise<boolean>;
  /**
   * IValidatorResourceFetcher.fetch: the resource an external reference points at (used only with
   * ValidateOptions.validateReference). Absent = external references are never fetched.
   */
  fetchReference?(ref: string): Promise<Record<string, any> | null>;
  /** A SearchParameter by canonical URL (SearchParameterValidator: derivedFrom). */
  fetchSearchParameter?(url: string): Promise<Record<string, any> | null>;
  /** A Questionnaire by canonical URL (QuestionnaireValidator). */
  fetchQuestionnaire?(url: string): Promise<Record<string, any> | null>;
  /** A Measure or Library by canonical URL (MeasureValidator). */
  fetchCanonical?(resourceType: "Measure" | "Library", url: string): Promise<Record<string, any> | null>;
}

export interface ValidateOptions {
  /** Extra profiles (canonical URLs) to validate the root resource against. */
  profiles?: string[];
  /**
   * Source format of the instance (default json). "xml" = FHIR JSON produced by fhirXml.ts from an XML document:
   * the JSON-parser shape errors that XML cannot produce (empty object, null value) are reported the way
   * InstanceValidator reports the corresponding XML element model (ele-1, Type_Specific_Checks_DT_Primitive_ValueExt).
   */
  format?: "json" | "xml";
  /**
   * Display languages for code checks (InstanceValidator.getValidationOptionsLanguage → ValidationOptions
   * languages; the "for the language(s) '…'" of the display messages). Default ['en'] — what validator_cli
   * reports in production; the HL7 test runner's locale gives 'en-US'.
   */
  languages?: string[];
  /**
   * ValidatorSettings.allowExamples (validator_cli -allow-example-urls; default false): example.org / acme.com
   * URLs are accepted (no TYPE_SPECIFIC_CHECKS_DT_URL_EXAMPLE, references / canonicals / extensions there pass).
   */
  allowExamples?: boolean;
  /** InstanceValidator.matchetypeStatus (default disallowed). */
  matchetypeStatus?: "disallowed" | "required" | "optional";
  /** IValidationPolicyAdvisor.relativeDatePlaceHolder: printed instead of the limit of a duration min/maxValue. */
  relativeDatePlaceHolder?: string;
  /**
   * ValidatorSettings.displayWarningMode (validator_cli -display-issues-are-warnings; default false): a wrong
   * display (tx-issue-type invalid-display) is a warning instead of an error, and does not fail a binding.
   */
  displayWarnings?: boolean;
  /** validateText only: JSON `//` comments are accepted (validator_cli -allow-json-comments; default false). */
  allowJsonComments?: boolean;
  /** ValidatorSettings.isAssumeValidRestReferences (-assumeValidRestReferences): the type in an unresolved RESTful reference is trusted. */
  assumeValidRestReferences?: boolean;
  /**
   * ValidatorSettings.getBundleValidationRules (-bundle <rule> <profile>): entries matching `rule` (`Type`, `Type:n` —
   * the n-th entry of that type, from 0 — or `n`, the n-th entry) are also validated against `profile`.
   */
  bundleRules?: Array<{ rule: string; profile: string }>;
  /** InstanceValidator.extensionDomains (validator_cli -allowed-extension-domain): unknown extensions under these prefixes are allowed. */
  extensionDomains?: string[];
  /** ImplementationGuides the validator knows (InstanceValidator.igs): their `global` profiles apply to every resource of that type. */
  implementationGuides?: Array<Record<string, any>>;
  /**
   * IValidationPolicyAdvisor.policyForReference for external references (validator_cli default IGNORE): fetch the
   * target through ValidatorResolver.fetchReference and check that it exists / its type / that it is valid.
   */
  validateReference?: "CHECK_EXISTS" | "CHECK_EXISTS_AND_TYPE" | "CHECK_VALID";
  /**
   * InstanceValidatorParameters.htmlInMarkdownCheck (validator_cli -html-in-markdown; default "warning"): what an
   * unescaped HTML tag in a markdown value is (TYPE_SPECIFIC_CHECKS_DT_MARKDOWN_HTML).
   */
  htmlInMarkdown?: "none" | "warning" | "error";
}

// validator_cli 7.0.1 wording: the invariant's source is appended (checkInvariant, "(defined in <source>)")
const ELE1_MESSAGE = "Constraint failed: ele-1: 'All FHIR elements must have a @value or children' (defined in http://hl7.org/fhir/StructureDefinition/Element)";
const PRIMITIVE_VALUEEXT_MESSAGE = "Primitive types must have a value or must have child extensions";

// --------------------------------------------------------------------------- //
// Type knowledge
// --------------------------------------------------------------------------- //

const CORE = "http://hl7.org/fhir/StructureDefinition/";
const FHIR_TYPE_EXT = "http://hl7.org/fhir/StructureDefinition/structuredefinition-fhir-type";
const BEST_PRACTICE_EXT = "http://hl7.org/fhir/StructureDefinition/elementdefinition-bestpractice";
const MAX_VALUESET_EXT = "http://hl7.org/fhir/StructureDefinition/elementdefinition-maxValueSet";

const YEAR = "([0-9]([0-9]([0-9][1-9]|[1-9]0)|[1-9]00)|[1-9]000)";
const MONTH = "(0[1-9]|1[0-2])";
const DAY = "(0[1-9]|[1-2][0-9]|3[0-1])";
const TIME = "([01][0-9]|2[0-3]):[0-5][0-9]:([0-5][0-9]|60)(\\.[0-9]+)?";
const TZ = "(Z|(\\+|-)((0[0-9]|1[0-3]):[0-5][0-9]|14:00))";

interface PrimitiveSpec {
  json: "string" | "number" | "boolean";
  regex?: { test(s: string): boolean };
}

/** (\s*([0-9a-zA-Z+/=]){4}\s*)+ without backtracking: whitespace-separated runs of base64 characters, each a multiple of 4. */
function isBase64Text(s: string): boolean {
  let run = 0;
  let groups = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const ws = c === 32 || (c >= 9 && c <= 13);
    if (ws) {
      if (run % 4 !== 0) return false;
      run = 0;
      continue;
    }
    const ok = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 43 || c === 47 || c === 61;
    if (!ok) return false;
    run++;
    if (run % 4 === 0) groups++;
  }
  return run % 4 === 0 && groups > 0;
}

const PRIMITIVES: Record<string, PrimitiveSpec> = {
  boolean: { json: "boolean" },
  integer: { json: "number", regex: /^-?([0]|([1-9][0-9]*))$/ },
  integer64: { json: "string", regex: /^-?([0]|([1-9][0-9]*))$/ },
  unsignedInt: { json: "number", regex: /^([0]|([1-9][0-9]*))$/ },
  positiveInt: { json: "number", regex: /^\+?[1-9][0-9]*$/ },
  decimal: { json: "number" },
  string: { json: "string" },
  markdown: { json: "string" },
  xhtml: { json: "string" },
  code: { json: "string", regex: /^[^\s]+( [^\s]+)*$/ },
  id: { json: "string", regex: /^[A-Za-z0-9\-.]{1,64}$/ },
  uri: { json: "string", regex: /^\S*$/ },
  url: { json: "string", regex: /^\S*$/ },
  canonical: { json: "string", regex: /^\S*$/ },
  oid: { json: "string", regex: /^urn:oid:[0-2](\.(0|[1-9][0-9]*))+$/ },
  uuid: { json: "string", regex: /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/ },
  // same language as the R4 regex (\s*([0-9a-zA-Z+/=]){4}\s*)+, checked linearly: a backtracking regex overflows the
  // stack on multi-MB attachments (fhir-test-cases library-fhir-model-definition: 4.6 MB of base64)
  base64Binary: { json: "string", regex: { test: isBase64Text } },
  date: { json: "string", regex: new RegExp(`^${YEAR}(-${MONTH}(-${DAY})?)?$`) },
  dateTime: { json: "string", regex: new RegExp(`^${YEAR}(-${MONTH}(-${DAY}(T${TIME}${TZ})?)?)?$`) },
  instant: { json: "string", regex: new RegExp(`^${YEAR}-${MONTH}-${DAY}T${TIME}${TZ}$`) },
  time: { json: "string", regex: new RegExp(`^${TIME}$`) },
};

/**
 * Does `v` satisfy the JSON type and lexical rule of FHIR R4 primitive `typeCode` (the same
 * PRIMITIVES table the validator applies)? Unknown types answer true. Used by the repair layer
 * (fhirRepair) to decide that a moved / rewritten value introduces no new error.
 */
export function primitiveOk(typeCode: string, v: unknown): boolean {
  const spec = PRIMITIVES[typeCode];
  if (!spec) return true;
  const raw = v !== null && typeof v === "object" && typeof (v as { valueOf?: unknown }).valueOf === "function" && "text" in (v as object) ? Number((v as { text: string }).text) : v;
  if (typeof raw !== spec.json) return false;
  if (spec.regex && !spec.regex.test(String(raw))) return false;
  if (typeCode === "date" || typeCode === "dateTime" || typeCode === "instant") return validCalendarDate(String(raw));
  return true;
}

const COMPLEX_TYPES = [
  "Address", "Age", "Annotation", "Attachment", "CodeableConcept", "Coding", "ContactPoint", "Count",
  "Distance", "Duration", "HumanName", "Identifier", "Money", "MoneyQuantity", "Period", "Quantity", "Range",
  "Ratio", "Reference", "SampledData", "Signature", "SimpleQuantity", "Timing", "ContactDetail", "Contributor",
  "DataRequirement", "Expression", "ParameterDefinition", "RelatedArtifact", "TriggerDefinition",
  "UsageContext", "Dosage", "Meta", "Narrative", "Extension", "ElementDefinition", "MarketingStatus",
  "Population", "ProdCharacteristic", "ProductShelfLife", "SubstanceAmount", "BackboneElement", "Element",
];
const KNOWN_TYPE_SUFFIX = new Map<string, string>();
for (const t of [...Object.keys(PRIMITIVES), ...COMPLEX_TYPES]) KNOWN_TYPE_SUFFIX.set(t[0].toUpperCase() + t.slice(1), t);

/**
 * Implied R4 vital-sign profiles, copied from the HL7 validator
 * (BasePolicyAdvisorForFullValidation.getImpliedProfilesForObservation,
 * validator_cli 7.0.1): the first group whose codes appear in Observation.code
 * (LOINC groups first, then SNOMED CT) selects ONE core profile.
 */
const VITAL_SIGN_GROUPS: Array<[string, string, string[]]> = [
  ["http://loinc.org", "vitalspanel", ["85353-1"]],
  ["http://loinc.org", "resprate", ["9279-1", "76170-0", "76172-6", "76171-8", "19840-8", "33438-3", "76270-8", "11291-2"]],
  ["http://loinc.org", "heartrate", ["60978-4", "73795-7", "73799-9", "76476-1", "76477-9", "8867-4", "8889-8", "8890-6", "8891-4", "8892-2", "8893-0", "40443-4", "55425-3", "68999-2", "11328-2", "69000-8", "8886-4"]],
  ["http://loinc.org", "oxygensat", ["2708-6", "19224-5", "20564-1", "2709-4", "2710-2", "2713-6", "51733-4", "59408-5", "59417-6", "89276-0", "97549-0"]],
  ["http://loinc.org", "bodytemp", ["8310-5", "60834-9", "60835-6", "60836-4", "60838-0", "60955-2", "61009-7", "75539-7", "75987-8", "76010-8", "76011-6", "76278-1", "8309-7", "8328-7", "8329-5", "8330-3", "8331-1", "8332-9", "8333-7", "8334-5", "91371-5", "98657-0", "98663-8"]],
  ["http://loinc.org", "bodyheight", ["8302-2", "3137-7", "3138-5", "8306-3", "8308-9"]],
  ["http://loinc.org", "headcircum", ["9843-4", "8287-5"]],
  ["http://loinc.org", "bodyweight", ["29463-7", "3141-9", "3142-7", "75292-3", "79348-9", "8350-1", "8351-9"]],
  ["http://loinc.org", "bmi", ["39156-5", "89270-3"]],
  ["http://loinc.org", "bp", ["85354-9", "35094-2", "8459-0", "76534-7", "55284-4", "8480-6"]],
  ["http://snomed.info/sct", "vitalspanel", ["46680005"]],
  ["http://snomed.info/sct", "resprate", ["86290005", "271625008", "271306003"]],
  ["http://snomed.info/sct", "heartrate", ["271306003", "249043002", "444981005", "399017001", "251670001", "429525003", "429614003"]],
  ["http://snomed.info/sct", "oxygensat", ["442476006", "431314004"]],
  ["http://snomed.info/sct", "bodytemp", ["386725007", "276885007", "300076005", "1222808002", "364246006", "307047009", "708499008", "431598003", "698831002", "698832009", "415882003", "415974002", "415929009", "415945006"]],
  ["http://snomed.info/sct", "bodyheight", ["1153637007", "1162419008", "50373000", "1162418000", "1230278008", "1162392001", "1162417005"]],
  ["http://snomed.info/sct", "headcircum", ["363812007", "169876006", "1269262007", "363811000"]],
  ["http://snomed.info/sct", "bodyweight", ["735395000", "425024002", "424927000", "784399000", "1162416001", "1162415002"]],
  ["http://snomed.info/sct", "bmi", ["60621009"]],
  ["http://snomed.info/sct", "bp", ["251076008", "163033001", "163035008", "386534000", "386536003", "271649006", "271650006", "407556006", "407554009", "716579001", "399304008"]],
];

/** The core vital-signs profile the HL7 validator implies for an Observation.code (or null). */
export function impliedVitalSignProfile(code: any): string | null {
  const codings: any[] = isObject(code) && Array.isArray(code.coding) ? code.coding : [];
  for (const [system, profile, codes] of VITAL_SIGN_GROUPS) {
    if (codings.some((c) => isObject(c) && c.system === system && codes.includes(c.code))) return CORE + profile;
  }
  return null;
}

/**
 * Types whose coded unit is checked (UCUM grammar / ValueSet-as-system). The
 * HL7 validator runs checkQuantity only for type code "Quantity" (profiles such
 * as SimpleQuantity / MoneyQuantity keep that code); Age, Duration, Distance and
 * Count values are not terminology-checked (confirmed: Age.code 'years' passes).
 */
const QUANTITY_TYPES = ["Quantity"];

/**
 * ValueSetValidator.inComponent (standalone tag 7.0.1:2102, `only && system == null`): a Coding without a system is a
 * member only of a value set with a single include that enumerates its code ("we'll accept the stated codes at face
 * value" — official corpus: IPS Observation.code under an enumerated LOINC include, no error; PAS Observation.code under
 * a whole-system include, NoValid_1_CC).
 */
function faceValueMember(vs: Record<string, any> | null, code: string): boolean {
  const includes: any[] = vs && isObject(vs.compose) && Array.isArray(vs.compose.include) ? vs.compose.include : [];
  return includes.length === 1 && isObject(includes[0]) && Array.isArray(includes[0].concept) && includes[0].concept.some((c: any) => isObject(c) && c.code === code);
}

/** BaseValidator.isExampleUrl (7.0.1). */
export function isExampleUrl(url: string): boolean {
  const hosts = ["example.org", "acme.com", "acme.org", "example.com", "example.net"];
  return hosts.some((h) => url.includes(`${h}/`) || url.endsWith(h)) || url.startsWith("urn:oid:1.3.6.1.4.1.32473.") || url.startsWith("urn:oid:2.999.");
}

function isPrimitive(t: string): boolean {
  return t in PRIMITIVES;
}

function isObject(v: any): v is Record<string, any> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function stripVersion(url: string): string {
  return String(url || "").split("|")[0];
}

/** `url|version` → {url, version} (version null when absent; split at the last '|', like HL7). */
export function splitCanonicalVersion(canonical: string): { url: string; version: string | null } {
  const s = String(canonical || "");
  const i = s.lastIndexOf("|");
  if (i < 0) return { url: s, version: null };
  const v = s.slice(i + 1);
  return { url: s.slice(0, i), version: v === "" ? null : v };
}

/** VersionUtilities.removeLabels (7.0.1): drop `+build` then `-label`. */
function removeLabels(v: string): string {
  let x = v;
  if (x.includes("+")) x = x.slice(0, x.indexOf("+"));
  if (x.includes("-")) x = x.slice(0, x.indexOf("-"));
  return x;
}

const SEMVER_WILD = /^(\d+)\.(\d+|[xX*])(?:\.(\d+|[xX*]))?$/;

/** VersionUtilities.getMajMin (7.0.1): "major.minor" of a (wildcard) semver, else null. */
export function hl7MajMin(version: string | null | undefined): string | null {
  if (!version) return null;
  const m = SEMVER_WILD.exec(removeLabels(version));
  return m ? `${m[1]}.${m[2]}` : null;
}

function semverParts(v: string): number[] | null {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(removeLabels(v));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}

function cmpSemverLoose(a: string, b: string): number {
  const pa = semverParts(a);
  const pb = semverParts(b);
  if (!pa || !pb) return a < b ? -1 : a > b ? 1 : 0;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  // a release sorts above its pre-releases
  const la = a.includes("-") ? 0 : 1;
  const lb = b.includes("-") ? 0 : 1;
  return la - lb;
}

/**
 * Pick the definition a versioned canonical reference resolves to, porting
 * CanonicalResourceManager.getByPackage(url, version, pvlist) (org.hl7.fhir.r5
 * context, validator_cli 7.0.1), which BaseWorkerContext.fetchResource uses for
 * every `url|version` (meta.profile, type / target profiles, binding ValueSets,
 * extension URLs):
 *   1. a resource whose own `version` equals the requested one;
 *   2. else, when the request is major.minor-shaped, the highest-version resource of
 *      that release line (index `url|maj.min` — so `|1.0.9` resolves to 1.0.0 and `|1.0`
 *      to the newest 1.0.x);
 *   3. else, for wildcard requests (`1.x`, `1.0.*`), the highest matching version;
 *   4. else null — "not installed at that version".
 * `candidates` are in preference order (closure ranking); ties keep that order.
 */
export function pickCanonicalVersion<T extends { version: string | null | undefined }>(candidates: T[], requested: string): T | null {
  const exact = candidates.find((c) => c.version === requested);
  if (exact) return exact;
  const best = (list: T[]): T | null => {
    let out: T | null = null;
    for (const c of list) if (!out || cmpSemverLoose(String(c.version), String(out.version)) > 0) out = c;
    return out;
  };
  const mm = hl7MajMin(requested);
  if (mm) {
    const line = candidates.filter((c) => typeof c.version === "string" && hl7MajMin(c.version) === mm);
    if (line.length) return best(line);
  }
  const w = SEMVER_WILD.exec(removeLabels(requested));
  if (w && /[xX*]/.test(requested)) {
    const want = [w[1], w[2], w[3]];
    const hits = candidates.filter((c) => {
      const p = typeof c.version === "string" ? semverParts(c.version) : null;
      if (!p) return false;
      return want.every((x, i) => x === undefined || /[xX*]/.test(x) || Number(x) === p[i]);
    });
    if (hits.length) return best(hits);
  }
  return null;
}

/** Effective type code of an ElementDefinition.type entry (handles System.String + fhir-type ext). */
function typeCodeOf(t: Record<string, any>): string {
  const code = String(t.code || "");
  for (const ext of t.extension || []) {
    if (ext.url === FHIR_TYPE_EXT) return String(ext.valueUrl ?? ext.valueUri ?? ext.valueString ?? code);
  }
  if (code.startsWith("http://hl7.org/fhirpath/System.")) {
    const sys = code.slice("http://hl7.org/fhirpath/System.".length);
    if (sys === "String") return "string";
    if (sys === "Boolean") return "boolean";
    if (sys === "Integer") return "integer";
    if (sys === "Decimal") return "decimal";
    if (sys === "Date") return "date";
    if (sys === "DateTime") return "dateTime";
    if (sys === "Time") return "time";
    return "string";
  }
  return code;
}

function deepEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") return a === b;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

/** pattern[x]: every property of the pattern is present (arrays: each pattern item matches some instance item). */
export function patternMatches(actual: any, pattern: any): boolean {
  if (isObject(pattern)) {
    if (!isObject(actual)) return false;
    return Object.entries(pattern).every(([k, v]) => patternMatches(actual[k], v));
  }
  if (Array.isArray(pattern)) {
    const arr = Array.isArray(actual) ? actual : actual === undefined ? [] : [actual];
    return pattern.every((p) => arr.some((a) => patternMatches(a, p)));
  }
  return deepEqual(actual, pattern);
}

function validCalendarDate(v: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  if (!m) return true;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const days = [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return mo >= 1 && mo <= 12 && d >= 1 && d <= days[mo - 1];
}

// ---- helpers of the InstanceValidator.checkPrimitive port (validator 7.0.1; Utilities / FormatUtilities / Base64Util)
const REGEX_EXT = "http://hl7.org/fhir/StructureDefinition/regex";
const DATE_RULES_EXT = "http://hl7.org/fhir/StructureDefinition/elementdefinition-date-rules";
/** RegexConstants.ID_REGEX */
const ID_RE = /^[A-Za-z0-9\-.]{1,64}$/;
/** The dateTime / instant patterns InstanceValidator.checkPrimitive matches before the type regex (time zone optional). */
const DATETIME_JAVA_RE = new RegExp(`^${YEAR}(-${MONTH}(-${DAY}(T${TIME}${TZ}?)?)?)?$`);
const INSTANT_JAVA_RE = new RegExp(`^-?[0-9]{4}-${MONTH}-${DAY}T${TIME}${TZ}$`);
/**
 * The `regex` extension of each R4 primitive type's `.value` element (hl7.fhir.r4.core 4.0.1), after
 * FHIRPathExpressionFixer.fixRegex (`[ \r\n\t\S]+` → `^[\s\S]+$`) — InstanceValidator.getRegexFromType.
 */
const R4_TYPE_REGEX: Record<string, string> = {
  boolean: "true|false",
  integer: "-?([0]|([1-9][0-9]*))",
  string: "^[\\s\\S]+$",
  decimal: "-?(0|[1-9][0-9]*)(\\.[0-9]+)?([eE][+-]?[0-9]+)?",
  uri: "\\S*",
  url: "\\S*",
  canonical: "\\S*",
  instant: "([0-9]([0-9]([0-9][1-9]|[1-9]0)|[1-9]00)|[1-9]000)-(0[1-9]|1[0-2])-(0[1-9]|[1-2][0-9]|3[0-1])T([01][0-9]|2[0-3]):[0-5][0-9]:([0-5][0-9]|60)(\\.[0-9]+)?(Z|(\\+|-)((0[0-9]|1[0-3]):[0-5][0-9]|14:00))",
  date: "([0-9]([0-9]([0-9][1-9]|[1-9]0)|[1-9]00)|[1-9]000)(-(0[1-9]|1[0-2])(-(0[1-9]|[1-2][0-9]|3[0-1]))?)?",
  dateTime: "([0-9]([0-9]([0-9][1-9]|[1-9]0)|[1-9]00)|[1-9]000)(-(0[1-9]|1[0-2])(-(0[1-9]|[1-2][0-9]|3[0-1])(T([01][0-9]|2[0-3]):[0-5][0-9]:([0-5][0-9]|60)(\\.[0-9]+)?(Z|(\\+|-)((0[0-9]|1[0-3]):[0-5][0-9]|14:00)))?)?)?",
  time: "([01][0-9]|2[0-3]):[0-5][0-9]:([0-5][0-9]|60)(\\.[0-9]+)?",
  code: "[^\\s]+(\\s[^\\s]+)*",
  oid: "urn:oid:[0-2](\\.(0|[1-9][0-9]*))+",
  unsignedInt: "[0]|([1-9][0-9]*)",
  positiveInt: "[1-9][0-9]*",
  uuid: "urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
};
const javaRegexCache = new Map<string, RegExp | null>();
/** A Java regex as String.matches applies it (whole value); null when JavaScript cannot compile it. */
function javaFullRegex(regex: string): RegExp | null {
  if (!javaRegexCache.has(regex)) {
    let re: RegExp | null = null;
    try {
      re = new RegExp(`^(?:${regex})$`, "u");
    } catch {
      try {
        re = new RegExp(`^(?:${regex})$`);
      } catch {
        re = null;
      }
    }
    javaRegexCache.set(regex, re);
  }
  return javaRegexCache.get(regex)!;
}
function extOf(node: any, url: string): Record<string, any> | null {
  for (const e of Array.isArray(node?.extension) ? node.extension : []) if (isObject(e) && e.url === url) return e;
  return null;
}
function extString(node: any, url: string): string | null {
  const e = extOf(node, url);
  if (!e) return null;
  for (const [k, v] of Object.entries(e)) if (k.startsWith("value") && (typeof v === "string" || typeof v === "number")) return String(v);
  return null;
}
function extInt(node: any, url: string): number | null {
  const v = extString(node, url);
  return v !== null && /^-?\d+$/.test(v) ? Number(v) : null;
}
/** Utilities.isWhitespace */
const javaWs = (c: string): boolean => /\s/u.test(c);
/** StringUtils.isBlank */
function isJavaBlank(s: string): boolean {
  return [...s].every(javaWs);
}
function isJavaAllWhitespace(s: string): boolean {
  return s === "" || [...s].every(javaWs);
}
/** Utilities.trimWS */
function javaTrimWS(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && javaWs(s[a])) a++;
  while (b > a && javaWs(s[b - 1])) b--;
  return s.slice(a, b);
}
/** Utilities.isAbsoluteUrl */
function javaIsAbsoluteUrl(ref: string): boolean {
  if (!ref.includes(":")) return false;
  const scheme = ref.slice(0, ref.indexOf(":"));
  const details = ref.slice(ref.indexOf(":") + 1);
  const token = /^[\p{L}][\p{L}\p{Nd}_[\]]*$/u.test(scheme);
  return (
    (["http", "https", "urn", "file:"].includes(scheme) || (token && scheme === scheme.toLowerCase()) ||
      ["urn:iso:", "urn:iso-iec:", "urn:iso-cie:", "urn:iso-astm:", "urn:iso-ieee:", "urn:iec:"].some((p) => ref.startsWith(p))) &&
    details.length > 0 &&
    !details.includes(" ")
  );
}
/**
 * InstanceValidator.allowUnknownExtension (7.0.1, settings.allowExamples off, no extension domains): extensions the
 * validator accepts without a definition (no Extension_EXT_Unknown_NotHere).
 */
function allowUnknownExtension(url: string, allowExamples = false, domains: string[] = []): boolean {
  return domains.some((d) => url.startsWith(d)) || (allowExamples && (url.includes("example.org") || url.includes("acme.com"))) || url.includes("nema.org") || url.startsWith("http://hl7.org/fhir/tools/StructureDefinition/") || url === "http://hl7.org/fhir/StructureDefinition/structuredefinition-expression";
}
/**
 * Utilities.decodeBase64(value, false) = ASCII whitespace dropped, then java.util.Base64.getDecoder().decode — ported
 * with the JDK decoder's exception messages (TYPE_SPECIFIC_CHECKS_DT_ATT_B64_DECODE_FAIL shows them).
 */
function javaDecodeBase64(value: string): { bytes: Buffer } | { error: string } {
  const src: number[] = [];
  for (const ch of value) {
    const c = ch.codePointAt(0)!;
    if (c === 0x20 || (c >= 0x09 && c <= 0x0d)) continue;
    src.push(c < 0x80 ? c : 0x3f);
  }
  const sl = src.length;
  if (sl === 0) return { bytes: Buffer.alloc(0) };
  if (sl < 2) return { error: "Input byte[] should at least have 2 bytes for base64 bytes" };
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const val = (b: number): number => (b === 0x3d ? -2 : A.indexOf(String.fromCharCode(b)));
  const out: number[] = [];
  let sp = 0;
  let bits = 0;
  let shiftto = 18;
  while (sp < sl) {
    const raw = src[sp++];
    const b = val(raw);
    if (b < 0) {
      if (b === -2) {
        if ((shiftto === 6 && (sp === sl || src[sp++] !== 0x3d)) || shiftto === 18) return { error: "Input byte array has wrong 4-byte ending unit" };
        break;
      }
      return { error: `Illegal base64 character ${raw.toString(16)}` };
    }
    bits |= b << shiftto;
    shiftto -= 6;
    if (shiftto < 0) {
      out.push((bits >> 16) & 0xff, (bits >> 8) & 0xff, bits & 0xff);
      shiftto = 18;
      bits = 0;
    }
  }
  if (shiftto === 6) out.push((bits >> 16) & 0xff);
  else if (shiftto === 0) out.push((bits >> 16) & 0xff, (bits >> 8) & 0xff);
  else if (shiftto === 12) return { error: "Last unit does not have enough valid bits" };
  if (sp < sl) return { error: `Input byte array has incorrect ending byte at ${sp}` };
  return { bytes: Buffer.from(out) };
}
/** minValueDate / minValueDateTime / minValueInstant of an element definition (checkMinMaxValueDate[Time]). */
function dateMin(el: Record<string, any>): string | null {
  for (const k of ["minValueDateTime", "minValueDate", "minValueInstant"]) if (typeof el[k] === "string") return el[k];
  return null;
}
/** The instant a FHIR date / dateTime starts at (DateTimeType value), for before / after comparisons. */
function dateStartMs(v: string): number {
  const m = /^(-?\d{4})(?:-(\d{2}))?(?:-(\d{2}))?(T.*)?$/.exec(v);
  if (!m) return NaN;
  const base = `${m[1]}-${m[2] ?? "01"}-${m[3] ?? "01"}`;
  const t = m[4] ? (/(Z|[+-]\d{2}:\d{2})$/.test(m[4]) ? m[4] : m[4] + "Z") : "T00:00:00Z";
  return Date.parse(base + t);
}
/**
 * checkMinMaxValueDate / checkMinMaxValueDateTime: the min rule (min.after(v) → TYPE_SPECIFIC_CHECKS_DT_DT_LT). Their
 * max rules test `max.hasValue() || !max.before(v)`, which always passes for a stated max — ported as such (no check).
 */
function dateMinOk(el: Record<string, any>, v: string): boolean {
  const min = dateMin(el);
  if (min === null) return true;
  const a = dateStartMs(min);
  const b = dateStartMs(v);
  return Number.isNaN(a) || Number.isNaN(b) || !(a > b);
}
/** min/maxValue[x] of a Quantity kind (ElementDefinition.hasMinValueQuantity: Duration, Age … extend Quantity). */
function dateQuantityBound(el: Record<string, any>, which: "min" | "max"): Record<string, any> | null {
  for (const t of ["Quantity", "Duration", "Age", "Distance", "Count"]) if (isObject(el[`${which}Value${t}`])) return el[`${which}Value${t}`];
  return null;
}
/** Quantity.isExactTime (Quantity.java:728). */
function quantityIsExactTime(q: Record<string, any>): boolean {
  if (typeof q.value !== "number" || typeof q.code !== "string" || q.system !== "http://unitsofmeasure.org") return false;
  if (["a", "mo", "ms"].includes(q.code)) return Number.isInteger(q.value);
  return ["wk", "d", "h", "min", "s"].includes(q.code);
}
/** BaseDateTimeType.add / subtract(Quantity) from now: years and months by the calendar, the rest in whole milliseconds. */
function nowShifted(q: Record<string, any>, sign: 1 | -1): Date {
  const d = new Date();
  const v = sign * Number(q.value);
  if (q.code === "a" || q.code === "mo") {
    const day = d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + (q.code === "a" ? 12 * v : v));
    // Calendar.add keeps the day, or the month's last one
    d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
    return d;
  }
  const unit: Record<string, number> = { wk: 604_800_000, d: 86_400_000, h: 3_600_000, min: 60_000, s: 1_000, ms: 1 };
  return new Date(d.getTime() + Math.trunc(v * unit[q.code]));
}
/** getValueAsString(DAY) in the JVM's zone, as the message prints the limit. */
function localDay(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${String(d.getFullYear()).padStart(4, "0")}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
/** getValueAsString(MILLI). */
function localMilli(d: Date): string {
  const off = -d.getTimezoneOffset();
  const p = (n: number, w = 2): string => String(Math.trunc(Math.abs(n))).padStart(w, "0");
  const zone = off === 0 ? "Z" : `${off < 0 ? "-" : "+"}${p(off / 60)}:${p(off % 60)}`;
  return `${localDay(d)}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}${zone}`;
}
/** InstanceValidator.isAbsolute (Identifier value for urn:ietf:rfc:3986) */
function javaIsAbsolute(uri: string): boolean {
  if (!uri.includes(":")) return false;
  const protocol = uri.slice(0, uri.indexOf(":"));
  const tail = uri.slice(uri.indexOf(":") + 1);
  if (!/^[\p{L}][\p{L}\p{Nd}_[\]]*$/u.test(protocol)) return false;
  return protocol === "file" ? tail.startsWith("/") || tail.includes(":") : true;
}
/** InstanceValidator.prepWSPresentation = Utilities.escapeJson */
function prepWSPresentation(s: string): string {
  let out = "";
  for (const c of s) {
    if (c === "\r") out += "\\r";
    else if (c === "\n") out += "\\n";
    else if (c === "\t") out += "\\t";
    else if (c === '"') out += '\\"';
    else if (c === "\\") out += "\\\\";
    else if (c === " ") out += " ";
    else if (javaWs(c) || c.charCodeAt(0) < 32) out += "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0");
    else out += c;
  }
  return out;
}
/** InstanceValidator.yearIsValid (1800 .. this year + 80) */
function yearIsValid(v: string): boolean {
  const y = Number.parseInt(v.slice(0, 4), 10);
  return /^[+-]?\d+$/.test(v.slice(0, 4)) && y >= 1800 && y <= new Date().getFullYear() + 80;
}
/** Base64Util.isValidBase64: the base64 characters (whitespace skipped) must come in groups of four */
function isBase64Valid(s: string): boolean {
  let n = 0;
  for (const c of s) {
    if (javaWs(c)) continue;
    if (/[\p{L}\p{Nd}]/u.test(c) || c === "/" || c === "=" || c === "+") n++;
  }
  return !(n > 0 && n % 4 !== 0);
}
/** Utilities.isInteger (32-bit; the sign-less bound comparison of the Java source kept as is) */
function isJavaInteger(s: string): boolean {
  if (isJavaBlank(s)) return false;
  const value = s.startsWith("-") ? s.slice(1) : s;
  if (value === "" || !/^\p{Nd}+$/u.test(value) || value.length > 10) return false;
  if (s.startsWith("-")) return !(value.length === 10 && s > "2147483648");
  return !(value.length === 10 && s > "2147483647");
}
/** Utilities.isLong */
function isJavaLong(s: string): boolean {
  if (isJavaBlank(s)) return false;
  const value = s.startsWith("-") ? s.slice(1) : s;
  if (!/^\p{Nd}*$/u.test(value) || value.length > 20) return false;
  if (s.startsWith("-")) return !(value.length === 20 && s > "9223372036854775808");
  return !(value.length === 20 && s > "9223372036854775807");
}
/** Utilities.checkDecimal(value, allowExponent = true, allowLeadingZero = false) */
function javaCheckDecimal(value: string): "ok" | "range" | "syntax" | "blank" {
  if (isJavaBlank(value)) return "blank";
  for (const sign of ["", "-", "+"]) {
    if (value.startsWith(sign + "0") && value !== sign + "0" && !value.startsWith(sign + "0.")) return "syntax";
  }
  if (value.endsWith(".")) return "syntax";
  let havePeriod = false;
  let haveExponent = false;
  let haveSign = false;
  let haveDigits = false;
  let pre = 0;
  let post = 0;
  let exp = 0;
  let length = 0;
  for (const c of value) {
    if (c === ".") {
      if (!haveDigits || havePeriod || haveExponent) return "syntax";
      havePeriod = true;
      pre = length;
      length = 0;
    } else if (c === "-" || c === "+") {
      if (haveDigits || haveSign) return "syntax";
      haveSign = true;
    } else if (c === "e" || c === "E") {
      if (!haveDigits || haveExponent) return "syntax";
      haveExponent = true;
      haveSign = false;
      haveDigits = false;
      if (havePeriod) post = length;
      else pre = length;
      length = 0;
    } else if (!/\p{Nd}/u.test(c)) {
      return "syntax";
    } else {
      haveDigits = true;
      length++;
    }
  }
  if (haveExponent && !haveDigits) return "syntax";
  if (haveExponent) exp = length;
  else if (havePeriod) post = length;
  else pre = length;
  if (exp > 4) return "range";
  if (pre + post > 18) return "range";
  return "ok";
}
/** InstanceValidator.passesCodeWhitespaceRules */
function passesCodeWhitespaceRules(v: string): boolean {
  if (javaTrimWS(v) !== v) return false;
  let lastWasSpace = true;
  for (const c of v) {
    if (c === " ") {
      if (lastWasSpace) return false;
      lastWasSpace = true;
    } else if (javaWs(c)) return false;
    else lastWasSpace = false;
  }
  return true;
}

function short(v: any): string {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 120 ? s.slice(0, 117) + "..." : s;
}

// --------------------------------------------------------------------------- //
// StructureDefinition index
// --------------------------------------------------------------------------- //

interface ChildGroup {
  name: string;
  base: Record<string, any> | null;
  slices: Array<Record<string, any>>;
}

class SdIndex {
  readonly url: string;
  readonly type: string;
  readonly root: Record<string, any>;
  readonly byId = new Map<string, Record<string, any>>();
  private readonly groups = new Map<string, Map<string, ChildGroup>>();

  constructor(readonly sd: Record<string, any>) {
    this.url = stripVersion(sd.url || "");
    this.type = sd.type || "";
    const els: Array<Record<string, any>> = (sd.snapshot || {}).element || [];
    this.root = els[0] || { id: this.type, path: this.type };
    for (const el of els) {
      const id = String(el.id || el.path || "");
      this.byId.set(id, el);
      if (el === els[0]) continue;
      const segs = id.split(".");
      const last = segs[segs.length - 1];
      // (re-slices — `identifier:a/b` — stay in their element's slice list, in definition order, and their children
      // are indexed under the re-slice's own id: InstanceValidator iterates every child definition of the path)
      const parentId = segs.slice(0, -1).join(".");
      const colon = last.indexOf(":");
      const name = colon >= 0 ? last.slice(0, colon) : last;
      const sliceName = colon >= 0 ? last.slice(colon + 1) : null;
      let g = this.groups.get(parentId);
      if (!g) {
        g = new Map();
        this.groups.set(parentId, g);
      }
      let grp = g.get(name);
      if (!grp) {
        grp = { name, base: null, slices: [] };
        g.set(name, grp);
      }
      if (sliceName) grp.slices.push(el);
      else grp.base = el;
    }
  }

  children(el: Record<string, any>): Map<string, ChildGroup> | undefined {
    return this.groups.get(String(el.id || el.path || ""));
  }

  hasChildren(el: Record<string, any>): boolean {
    const g = this.children(el);
    return !!g && g.size > 0;
  }

  /** Child ElementDefinition (base, not slice) named `name` under `el`. */
  child(el: Record<string, any>, name: string): Record<string, any> | null {
    const g = this.children(el);
    if (!g) return null;
    const direct = g.get(name);
    if (direct?.base) return direct.base;
    for (const grp of g.values()) {
      if (grp.name.endsWith("[x]") && name.startsWith(grp.name.slice(0, -3)) && grp.base) return grp.base;
    }
    return null;
  }
}

/**
 * One SdIndex per StructureDefinition object: the index is read-only and the resolver
 * hands out the same (cached) definition object to every validation, so the element
 * groups are built once per definition instead of once per validation.
 */
const sdIndexes = new WeakMap<object, SdIndex>();

function indexOf(sd: Record<string, any>): SdIndex {
  let idx = sdIndexes.get(sd);
  if (!idx) {
    idx = new SdIndex(sd);
    sdIndexes.set(sd, idx);
  }
  return idx;
}

// --------------------------------------------------------------------------- //
// Validation context
// --------------------------------------------------------------------------- //

interface ResourceCtx {
  resource: Record<string, any>;
  /** The resource whose `contained` holds this one (null for top-level / bundle entries). */
  container: Record<string, any> | null;
  /** Outermost resource (for %rootResource / Bundle lookups). */
  root: Record<string, any>;
  /** Bundle the resource lives in (the root bundle) — for reference resolution. */
  bundle: BundleCtx | null;
  /** Bundle entry the resource belongs to (contained resources inherit their container's). */
  entry?: BundleEntryCtx | null;
  /**
   * NodeStack.getIds (7.0.1): element ids seen in this validation pass of the resource (DUPLICATE_ID), and contained
   * resource ids as "!"+id (RESOURCE_DUPLICATE_CONTAINED_ID). A fresh map per pass (stack.resetIds()).
   */
  ids?: Map<string, object>;
}

interface BundleEntryCtx {
  index: number;
  fullUrl: string | null;
  resource: Record<string, any>;
}

interface BundleCtx {
  bundle: Record<string, any>;
  type: string;
  entries: BundleEntryCtx[];
  byFullUrl: Map<string, BundleEntryCtx[]>;
  entryOf: Map<object, BundleEntryCtx>;
  /** Every Bundle.entry (also those without a resource), in order — what BundleValidator iterates. */
  raw: RawBundleEntry[];
  /** BaseValidator.resolveInBundle maps: fullUrl (null for none; `/_history/v` added for meta.versionId) → entries, Type/id → entries. */
  map: Map<string | null, RawBundleEntry[]>;
  relMap: Map<string, RawBundleEntry[]>;
  /** First entry per `Type/id` as the template literal spells it (an id-less resource is `Type/undefined`). */
  typeId: Map<string, RawBundleEntry>;
  /** Path of the Bundle (the root, or a nested Bundle inside an entry / contained). */
  path: string;
}

interface RawBundleEntry {
  index: number;
  entry: Record<string, any>;
  fullUrl: string | null;
  resource: Record<string, any> | null;
}

/** Bundle types whose entries may omit fullUrl (HL7: "Except for transactions and batches"). */
const FULLURL_OPTIONAL_BUNDLE_TYPES = ["transaction", "batch", "transaction-response", "batch-response"];
const ABSOLUTE_URL = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const RESTFUL_REF = /^([A-Z][A-Za-z]+)\/([A-Za-z0-9\-.]{1,64})(?:\/_history\/([A-Za-z0-9\-.]{1,64}))?$/;

/** R4 resource type names (IWorkerContext.getResourceNames for hl7.fhir.r4.core 4.0.1). */
const R4_RESOURCE_NAMES = new Set(
  (
    "Account ActivityDefinition AdverseEvent AllergyIntolerance Appointment AppointmentResponse AuditEvent Basic Binary " +
    "BiologicallyDerivedProduct BodyStructure Bundle CapabilityStatement CarePlan CareTeam CatalogEntry ChargeItem " +
    "ChargeItemDefinition Claim ClaimResponse ClinicalImpression CodeSystem Communication CommunicationRequest " +
    "CompartmentDefinition Composition ConceptMap Condition Consent Contract Coverage CoverageEligibilityRequest " +
    "CoverageEligibilityResponse DetectedIssue Device DeviceDefinition DeviceMetric DeviceRequest DeviceUseStatement " +
    "DiagnosticReport DocumentManifest DocumentReference EffectEvidenceSynthesis Encounter Endpoint EnrollmentRequest " +
    "EnrollmentResponse EpisodeOfCare EventDefinition Evidence EvidenceVariable ExampleScenario ExplanationOfBenefit " +
    "FamilyMemberHistory Flag Goal GraphDefinition Group GuidanceResponse HealthcareService ImagingStudy Immunization " +
    "ImmunizationEvaluation ImmunizationRecommendation ImplementationGuide InsurancePlan Invoice Library Linkage List " +
    "Location Measure MeasureReport Media Medication MedicationAdministration MedicationDispense MedicationKnowledge " +
    "MedicationRequest MedicationStatement MedicinalProduct MedicinalProductAuthorization MedicinalProductContraindication " +
    "MedicinalProductIndication MedicinalProductIngredient MedicinalProductInteraction MedicinalProductManufactured " +
    "MedicinalProductPackaged MedicinalProductPharmaceutical MedicinalProductUndesirableEffect MessageDefinition " +
    "MessageHeader MolecularSequence NamingSystem NutritionOrder Observation ObservationDefinition OperationDefinition " +
    "OperationOutcome Organization OrganizationAffiliation Parameters Patient PaymentNotice PaymentReconciliation Person " +
    "PlanDefinition Practitioner PractitionerRole Procedure Provenance Questionnaire QuestionnaireResponse RelatedPerson " +
    "RequestGroup ResearchDefinition ResearchElementDefinition ResearchStudy ResearchSubject RiskAssessment " +
    "RiskEvidenceSynthesis Schedule SearchParameter ServiceRequest Slot Specimen SpecimenDefinition StructureDefinition " +
    "StructureMap Subscription Substance SubstanceNucleicAcid SubstancePolymer SubstanceProtein " +
    "SubstanceReferenceInformation SubstanceSourceMaterial SubstanceSpecification SupplyDelivery SupplyRequest Task " +
    "TerminologyCapabilities TestReport TestScript ValueSet VerificationResult VisionPrescription"
  ).split(" "),
);

/**
 * PackageHackerR5 (7.0.1, l. 119-133): in the R4 core (4.0.1) vital-signs profiles the ucum-vitals-common binding of
 * Observation.component.value[x] is backed off to extensible when the package is loaded ("the R4 profile wrongly
 * applies this value set to all types").
 */
function vitalsUnitsHack(sdx: SdIndex | null, el: Record<string, any>): boolean {
  const sd = sdx?.sd;
  if (!sd || typeof sd.url !== "string" || !sd.url.startsWith(CORE) || sd.version !== "4.0.1" || sd.type !== "Observation") return false;
  const vitals = CORE + "vitalsigns";
  if (sd.url !== vitals && sd.baseDefinition !== vitals) return false;
  return el.path === "Observation.component.value[x]" && isObject(el.binding) && el.binding.valueSet === "http://hl7.org/fhir/ValueSet/ucum-vitals-common|4.0.1";
}

/** The fields InstanceValidator.checkFixedValue compares per complex datatype (7.0.1), with their types. */
const FIXED_TYPE_FIELDS: Record<string, Array<[string, string]>> = {
  ContactPoint: [["system", ""], ["value", ""], ["use", ""], ["period", "Period"]],
  Identifier: [["use", ""], ["type", "CodeableConcept"], ["system", ""], ["value", ""], ["period", "Period"], ["assigner", "Reference"]],
  Attachment: [["contentType", ""], ["language", ""], ["data", ""], ["url", ""], ["size", ""], ["hash", ""], ["title", ""]],
  Reference: [["reference", ""], ["type", ""], ["identifier", "Identifier"], ["display", ""]],
  Range: [["low", "Quantity"], ["high", "Quantity"]],
  Ratio: [["numerator", "Quantity"], ["denominator", "Quantity"]],
  Period: [["start", ""], ["end", ""]],
  SampledData: [["origin", "Quantity"], ["period", ""], ["factor", ""], ["lowerLimit", ""], ["upperLimit", ""], ["dimensions", ""], ["data", ""]],
  Coding: [["system", ""], ["version", ""], ["code", ""], ["display", ""], ["userSelected", ""]],
  Quantity: [["value", ""], ["comparator", ""], ["unit", ""], ["system", ""], ["code", ""]],
};
for (const t of ["Age", "Count", "Distance", "Duration", "MoneyQuantity", "SimpleQuantity"]) FIXED_TYPE_FIELDS[t] = FIXED_TYPE_FIELDS.Quantity;

/** The element a type's profile `i` points at: its elementdefinition-profile-element extension, else the profile's root. */
function profileElementOf(typeRef: Record<string, any>, i: number, psdx: SdIndex): Record<string, any> {
  const exts: any[] = Array.isArray(typeRef._profile) && isObject(typeRef._profile[i]) && Array.isArray(typeRef._profile[i].extension) ? typeRef._profile[i].extension : [];
  const id = exts.find((x) => isObject(x) && x.url === "http://hl7.org/fhir/StructureDefinition/elementdefinition-profile-element")?.valueString;
  return (typeof id === "string" && psdx.byId.get(id)) || psdx.root;
}

/** valueXxx whose type is complex (a primitive type's JSON value is never an object). */
function isComplexChoiceValue(key: string): boolean {
  const t = KNOWN_TYPE_SUFFIX.get(key.slice("value".length));
  return !!t && !(t in PRIMITIVES);
}

/** A Reference type's target profiles, without those a version-specific-use extension confines to other FHIR versions. */
function targetProfilesForR4(typeRef: Record<string, any> | null): string[] {
  if (!typeRef) return [];
  const list: any[] = typeRef.targetProfile || [];
  const meta: any[] = Array.isArray(typeRef._targetProfile) ? typeRef._targetProfile : [];
  return list.filter((p, i) => typeof p === "string" && (!isObject(meta[i]) || appliesToR4(meta[i])));
}

/**
 * The UCUM codes a ValueSet enumerates, when its compose is only `include`s of http://unitsofmeasure.org with a
 * concept list (no filter, no imported value set, no exclude) — membership is then a plain lookup. Null otherwise
 * (tx.fhir.org decides; not reproduced locally).
 */
function ucumEnumeration(vs: Record<string, any>): Set<string> | null {
  const c = isObject(vs.compose) ? vs.compose : null;
  if (!c || !Array.isArray(c.include) || !c.include.length || (Array.isArray(c.exclude) && c.exclude.length)) return null;
  const out = new Set<string>();
  for (const inc of c.include) {
    if (!isObject(inc) || inc.system !== UCUM_SYSTEM || inc.valueSet || inc.filter || !Array.isArray(inc.concept) || !inc.concept.length) return null;
    for (const cc of inc.concept) if (isObject(cc) && typeof cc.code === "string") out.add(cc.code);
  }
  return out;
}

/** JsonParser's JSON type names (JsonElementType.toName) for RESOURCETYPE_PROPERTY_WRONG_TYPE. */
function describeJsonType(v: unknown): string {
  if (v === null) return "Null";
  if (Array.isArray(v)) return "Array";
  if (typeof v === "object") return "Object";
  if (typeof v === "number") return "Number";
  if (typeof v === "boolean") return "Boolean";
  return "String";
}

/**
 * context.fetchResource(StructureDefinition, sdNs(name)): any core type name parses (a datatype name too — as a resource
 * it stays "Unknown resource type"); only names without a definition are unparsed.
 */
function isCoreTypeName(rt: string): boolean {
  return R4_RESOURCE_NAMES.has(rt) || rt === "Resource" || rt === "DomainResource" || COMPLEX_TYPES.includes(rt) || rt in PRIMITIVES;
}

/** Embedded resources (contained / Bundle entry resource and response outcome / Parameters resource) JsonParser cannot parse. */
/** A shallow copy of a parsed object that keeps its source literals (fhirJsonLiterals). */
function copyNode(node: Record<string, any>): Record<string, any> {
  const c = { ...node };
  copyLiterals(node, c);
  return c;
}

/** Element.isEmpty for an object the parser emptied: every value is gone or itself emptied. */
function hasNoContent(o: Record<string, any>, emptied: WeakSet<object>): boolean {
  return Object.values(o).every((v) => (Array.isArray(v) ? v.every((x) => isObject(x) && emptied.has(x)) : isObject(v) && emptied.has(v)));
}

function unparsedResources(root: Record<string, any>): Set<object> {
  const out = new Set<object>();
  const known = (rt: unknown): boolean => typeof rt === "string" && isCoreTypeName(rt);
  const visit = (r: any, depth: number): void => {
    if (!isObject(r) || depth > 30) return;
    const embedded: any[] = [];
    if (Array.isArray(r.contained)) embedded.push(...r.contained);
    if (r.resourceType === "Bundle" && Array.isArray(r.entry)) {
      for (const e of r.entry) {
        if (!isObject(e)) continue;
        if (e.resource !== undefined) embedded.push(e.resource);
        if (isObject(e.response) && e.response.outcome !== undefined) embedded.push(e.response.outcome);
      }
    }
    if (r.resourceType === "Parameters") {
      const params = (list: any): void => {
        for (const p of Array.isArray(list) ? list : []) {
          if (!isObject(p)) continue;
          if (p.resource !== undefined) embedded.push(p.resource);
          params(p.part);
        }
      };
      params(r.parameter);
    }
    for (const x of embedded) {
      if (!isObject(x)) continue;
      if (known(x.resourceType)) visit(x, depth + 1);
      else out.add(x);
    }
  };
  visit(root, 0);
  return out;
}

const IMPOSE_PROFILE_EXT = "http://hl7.org/fhir/StructureDefinition/structuredefinition-imposeProfile";

/** BaseValidator.urlRegex (URI_REGEX_XVER with the R4 resource names), matched as a whole (String.matches). */
const BUNDLE_URL_REGEX = new RegExp(
  `^((http|https):\\/\\/([A-Za-z0-9\\\\.:%$\\-_]*\\/)*?)?(${[...R4_RESOURCE_NAMES].join("|")})\\/[A-Za-z0-9\\-.]{1,64}(\\/_history\\/[A-Za-z0-9\\-.]{1,64})?$`,
  "u",
);

/** Utilities.isAbsoluteUrl (7.0.1). */
function isAbsoluteUrlJava(ref: string | null | undefined): boolean {
  if (typeof ref !== "string" || !ref.includes(":")) return false;
  const scheme = ref.slice(0, ref.indexOf(":"));
  const details = ref.slice(ref.indexOf(":") + 1);
  const token = /^[A-Za-z][A-Za-z0-9_[\]]*$/u.test(scheme);
  return (
    (["http", "https", "urn", "file:"].includes(scheme) || (token && scheme === scheme.toLowerCase()) || /^urn:(iso|iso-iec|iso-cie|iso-astm|iso-ieee|iec):/u.test(ref)) &&
    details.length > 0 &&
    !details.includes(" ")
  );
}

/** Utilities.isValidId. */
function isValidIdJava(id: string | undefined): boolean {
  return typeof id === "string" && /^[A-Za-z0-9\-.]{1,64}$/u.test(id);
}

/** java.lang.String.hashCode. */
function javaStringHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

/** HashSet<String>.toString() iteration order (default capacity 16, load factor 0.75, insertion order within a bucket). */
function javaHashSetToString(values: string[]): string {
  return `[${javaHashOrder(values).join(", ")}]`;
}

/** Iteration order of a java.util.HashSet / HashMap keyed by these strings (default capacity, insertion order per bucket). */
function javaHashOrder(values: string[]): string[] {
  const uniq: string[] = [];
  for (const v of values) if (!uniq.includes(v)) uniq.push(v);
  let cap = 16;
  while (uniq.length > cap * 0.75) cap *= 2;
  const bucket = (s: string): number => {
    const h = javaStringHash(s);
    return (h ^ (h >>> 16)) & (cap - 1);
  };
  return uniq.map((v, i) => ({ v, i, b: bucket(v) })).sort((a, b) => a.b - b.b || a.i - b.i).map((x) => x.v);
}

/** Java String.split(regex) on a literal one-char separator: trailing empty strings removed. */
function javaSplit(s: string, sep: string): string[] {
  const parts = s.split(sep);
  while (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

interface Item {
  value: any;
  ext: any;
  /** (parity v1) An item of a repeating element (its JSON shape errors say "must be an Array"). */
  inList?: boolean;
  /** (parity v1) Validated as the profile's single type although written as another (Extension_PROF_Type). */
  profileType?: boolean;
  /** With profileType: the type the value is written as (the parser's), `typeCode` being the one the profile wants. */
  actualType?: string;
  /** A primitive validated as the complex type of its profile (`value` is then an empty object). */
  primitiveValue?: unknown;
  /** VALIDATION_VAL_PROFILE_NOTYPE was reported: the value has no definition to be validated against. */
  typeUnknown?: boolean;
  /** `value` is already what the parser kept of a value validated as another type. */
  parsedValue?: boolean;
  /** JSON property the item came from (choice elements: e.g. valueQuantity). */
  key: string;
  path: string;
  /** Type the item is validated as (set by walkChildren). */
  typeCode?: string;
  /**
   * HL7 NodeStack logical paths of the item (validator_cli 7.0.1
   * NodeStack.pushInternal): the parent's logical paths extended by the element
   * name, plus the type name(s). Used for extension context checks.
   */
  lp?: string[];
  /** NodeStack.literalPath without indexes (a choice is `value.ofType(boolean)`); roots: derived from `path`. */
  lit?: string;
  /** Url of the Extension this item is the value[x] of (HL7: context type "extension"). */
  parentExtUrl?: string;
  /** For an extension item: the element that holds it (its context). */
  host?: ExtensionHost;
  /** (parity v3) Source spelling of a JSON number value when it differs from String(value) (fhirJsonLiterals). */
  numText?: string;
  /** (parity v3) The JSON parser's path of a primitive property (choice: the [x] name; arrays: no index). */
  parserPath?: string;
  /** (parity v3) The element model path (JsonParser npath: choice elements by their [x] name, arrays indexed). */
  jpath?: string;
  /** (parity v3) The object holding the property (NodeStack parent). */
  parent?: Record<string, any>;
}

/** The element an extension sits on, as InstanceValidator.checkExtensionContext sees it. */
interface ExtensionHost {
  path: string;
  value: any;
  /** For a primitive host: its `_x` object (the element's identity in a FHIRPath result). */
  primitiveExt?: Record<string, any>;
  /** Literal path (indexes stripped) + logical paths, sorted, de-duplicated. */
  plist: string[];
  /** The literal path (NodeStack, indexes stripped): the first entry of the plist before the logical paths. */
  literal: string;
  isResource: boolean;
  /** Url of the host when it is itself an Extension (or the value[x] of one). */
  extUrl: string | null;
  typeCode: string;
  defPath: string;
  modifier: boolean;
}

/** R4 canonical resource types (HL7 VersionUtilities.getExtendedCanonicalResourceNames, R4 subset). */
const CANONICAL_RESOURCE_TYPES = new Set(
  (
    "ActivityDefinition CapabilityStatement ChargeItemDefinition CodeSystem CompartmentDefinition ConceptMap EffectEvidenceSynthesis " +
    "EventDefinition Evidence EvidenceVariable ExampleScenario GraphDefinition ImplementationGuide Library Measure MessageDefinition " +
    "NamingSystem OperationDefinition PlanDefinition Questionnaire ResearchDefinition ResearchElementDefinition RiskEvidenceSynthesis " +
    "SearchParameter StructureDefinition StructureMap TerminologyCapabilities TestScript ValueSet"
  ).split(" "),
);

/** java.util.HashMap<String, ?> iteration order of keys put in this order (table size 16, doubled past load 0.75). */
function javaHashMapOrder(keys: string[]): string[] {
  let n = 16;
  while (keys.length > n * 0.75) n *= 2;
  const hash = (k: string): number => {
    let h = 0;
    for (let i = 0; i < k.length; i++) h = (Math.imul(31, h) + k.charCodeAt(i)) | 0;
    return (h ^ (h >>> 16)) & (n - 1);
  };
  return keys.map((k, i) => ({ k, b: hash(k), i })).sort((a, b) => a.b - b.b || a.i - b.i).map((x) => x.k);
}

/** Port of NodeStack.isRealPath (7.0.1): which children of an abstract logical path are real. */
function isRealPath(lp: string, name: string): boolean {
  if (lp === "Element") return name === "id" || name === "extension";
  if (lp === "BackboneElement" || lp === "BackboneType") return name === "modifierExtension";
  if (lp === "Resource") return ["id", "meta", "implicitRules", "language"].includes(name);
  if (lp === "DomainResource") return ["text", "contained", "extension", "modifierExtension"].includes(name);
  return true;
}

/**
 * ExpressionNode.toString of the parsed `true and <expr>` minus its prefix (InstanceValidator l. 6520): the parser groups
 * what binds tighter than the operator beside it, so `x is T` next to the `and` and each `a = b` of an `and` get brackets.
 */
function groupedExpression(expr: string): string {
  if (/^\S+ is \S+$/u.test(expr)) return `(${expr})`;
  return expr.replace(/where\(([^()]*)\)/gu, (whole, inner: string) => {
    const parts = inner.split(/(?<=') and /u);
    return parts.length > 1 ? `where(${parts.map((x) => `(${x})`).join(" and ")})` : whole;
  });
}

/** A profile narrows a choice; only a base definition tells what the parser accepts. */
function isConstraintDefinition(s: SdIndex): boolean {
  return s.sd?.derivation === "constraint";
}

function stripIndexes(path: string): string {
  return path.replace(/\[[^\]]*\]/g, "");
}

/** One embedding level of a PLIST_TOKEN list: `path` is where the resource sits, the list is rendered once it is absolute. */
function expandPlist(message: string, path: string, comment: string): string {
  return message.replace(new RegExp(`${PLIST_TOKEN}(.*?)${PLIST_TOKEN}`, "u"), (_, json: string) => {
    const relative = path.startsWith(ROOT_TOKEN);
    const list = (JSON.parse(json) as string[]).map((e) => {
      if (e.startsWith(ROOT_TOKEN)) return path + e.slice(1);
      if (e.startsWith(LITERAL_ROOT_TOKEN)) return (relative ? LITERAL_ROOT_TOKEN + path.slice(1) : path) + comment + e.slice(1);
      return e;
    });
    if (relative) return PLIST_TOKEN + JSON.stringify(list) + PLIST_TOKEN;
    const tail = list.filter((e) => e.startsWith(PLIST_TAIL)).map((e) => e.slice(1));
    const sorted = [...new Set(list.filter((e) => !e.startsWith(PLIST_TAIL)).map(stripIndexes))].sort();
    return `[${[...sorted, ...tail].join(", ")}]`;
  });
}

/**
 * Logical paths of a child item (port of NodeStack.pushInternal, 7.0.1). Complex
 * datatypes (validated against their type definition): parent paths + "." +
 * the element name of the definition, plus the type name. Primitives / backbone
 * elements: parent paths + "." + the JSON name, plus the definition's type names
 * (or the contentReference target).
 */
function childLogicalPaths(parent: string[] | undefined, def: Record<string, any>, key: string, typeCode: string): string[] {
  const out = new Set<string>();
  const defPath = String(def.path || "");
  const tail = defPath.slice(defPath.lastIndexOf(".") + 1) || key;
  // NodeStack.pushInternal l. 160-176: every element with a resolved type, primitives too (IV:7988 resolveType)
  const typed = typeCode !== "BackboneElement" && typeCode !== "Element" && !def.contentReference;
  for (const lp of parent || []) {
    if (typed) {
      if (!isRealPath(lp, tail)) continue;
      out.add(`${lp}.${tail}`);
      if (tail.endsWith("[x]")) {
        const base = tail.slice(0, -3);
        out.add(`${lp}.${base}.ofType(${typeCode})`);
        out.add(`${lp}.${base}${typeCode}`);
      }
    } else {
      if (!isRealPath(lp, key) && !isRealPath(lp, tail)) continue;
      out.add(`${lp}.${key}`);
      if (tail !== key) out.add(`${lp}.${tail}`);
    }
  }
  if (typed) out.add(typeCode);
  else if (def.contentReference) out.add(String(def.contentReference).slice(String(def.contentReference).indexOf("#") + 1));
  else for (const t of def.type || []) out.add(typeCodeOf(t));
  if (!typed && !(def.type || []).length && !def.contentReference) out.add(typeCode);
  return [...out];
}

/** NodeStack.pushInternal l. 141-156 without indexes: a choice element's literal path is `<name>.ofType(<type>)`. */
function childLiteralPath(parent: string, def: Record<string, any>, key: string): string {
  const defPath = String(def.path || "");
  const tail = defPath.slice(defPath.lastIndexOf(".") + 1);
  if (!tail.endsWith("[x]") || !key.startsWith(tail.slice(0, -3))) return `${parent}.${key}`;
  const base = tail.slice(0, -3);
  const t = key.slice(base.length);
  const lower = t.charAt(0).toLowerCase() + t.slice(1);
  return `${parent}.${base}.ofType(${isPrimitive(lower) ? lower : t})`;
}

/** checkExtensionContext l. 2738-2748: literal path + logical paths, indexes stripped (`value[x]` -> `value`), sorted. */
function extensionPlist(literal: string, lp: string[] | undefined): string[] {
  return [...new Set([literal, ...(lp || []).map(stripIndexes)])].sort();
}

/** Port of InstanceValidator.hasElementName (7.0.1): segment-wise match, `x[x]` matching a typed choice name. */
function hasElementName(plist: string[], en: string): boolean {
  const ep = en.split(".");
  for (const p of plist) {
    if (p === en) return true;
    const sp = p.split(".");
    if (sp.length !== ep.length) continue;
    let ok = true;
    for (let i = 0; i < sp.length && ok; i++) {
      if (sp[i] === ep[i] || ep[i] === "*") continue;
      if (ep[i].endsWith("[x]") && sp[i].startsWith(ep[i].slice(0, -3))) continue;
      ok = false;
    }
    if (ok) return true;
  }
  return false;
}

/** Does a context (or the definition) apply to FHIR R4 (version-specific-use start/endFhirVersion)? */
function appliesToR4(node: Record<string, any>): boolean {
  for (const e of node.extension || []) {
    if (!isObject(e) || e.url !== "http://hl7.org/fhir/StructureDefinition/version-specific-use") continue;
    for (const sub of e.extension || []) {
      const v = typeof sub?.valueCode === "string" ? sub.valueCode : typeof sub?.valueString === "string" ? sub.valueString : null;
      const mm = v ? /^(\d+)\.(\d+)/.exec(v) : null;
      if (!mm) continue;
      const n = Number(mm[1]) * 100 + Number(mm[2]);
      if (sub.url === "startFhirVersion" && n > 400) return false;
      if (sub.url === "endFhirVersion" && n < 400) return false;
    }
  }
  return true;
}

const MAX_DEPTH = 60;
const ROOT_TOKEN = "\u0001";
/** In a message: the resource root as NodeStack.getLiteralPath shows it (with validateContains' path comment). */
const LITERAL_ROOT_TOKEN = "\u0002";
/**
 * Wraps the plist of EXTENSION_EXTP_CONTEXT_WRONG while it is relative to the resource (conformance results are cached per
 * resource): checkExtensionContext l. 2740-2749 lists the literal path (with the embedding's pathComment) and the logical
 * paths, of which NodeStack keeps the embedding one (`Bundle.entry.resource.x`) beside the resource's own (`Patient.x`).
 */
const PLIST_TOKEN = "\u0003";
/** Marks a plist entry added after the sort (l. 2854 `plist.add(ext)`): it stays last. */
const PLIST_TAIL = "\u0004";

/** Nesting past MAX_DEPTH is not walked: reported as not checked, never a pass. */
function tooDeep(path: string): Issue {
  return {
    severity: "warning",
    path,
    code: "too-deep",
    message: `Validation depth limit reached (${MAX_DEPTH} levels): the content below this element was not checked`,
    unchecked: { kind: "limit", canonical: VALIDATOR_LIMITS.elementDepth },
  };
}

/** HL7 core / THO ValueSets: tx.fhir.org knows them server-side, so they are a ValueSet as system in any context. */
/** Marker on a pending IG-ValueSet-as-system issue (removed by settleVsSystems before validate() returns). */
const VS_SYSTEM = "__vsSystem";
/** The contained resource a RESOURCE_DUPLICATE_CONTAINED_ID issue is about (settled at the end of validate()). */

function isHl7ValueSetUrl(url: string): boolean {
  return url.startsWith("http://hl7.org/fhir/ValueSet/") || url.startsWith("http://terminology.hl7.org/ValueSet/");
}

export class InstanceValidator {
  private sdCache = new Map<string, Promise<SdIndex | null>>();
  private conformCache = new WeakMap<object, Map<string, Promise<Issue[]>>>();
  private inProgress = new WeakMap<object, Set<string>>();
  private viewSource = new WeakMap<object, object>();
  /** InstanceValidator.fetchCache (l. 555): fetched targets by reference, seeded with the root (clearInternalState l. 1118). */
  private fetchCache = new Map<string, Record<string, any>>();
  /** ValidationContext.INTERNAL_REFERENCES_NAME: the '#…' references met while validating each resource (dom-3). */
  private internalRefs = new WeakMap<object, Set<string>>();
  private vsHeaderCache = new Map<string, Promise<Record<string, any> | null>>();
  /**
   * (v13) ValueSets validator_cli has loaded while validating this instance: those of element
   * bindings it checks against the terminology server (any element type but a bare Coding,
   * required / extensible / preferred, value present), plus the ValueSets they include.
   */
  private boundValueSets = new Set<string>();
  /** (v13) Any IG ValueSet canonical written as a Coding.system (issues carry VS_SYSTEM) — decided at the end of validate(). */
  private pendingVsSystems = false;
  private memberCache = new Map<string, Promise<boolean | undefined>>();
  /** While a slicing is evaluated: the `system|valueSet` pairs its discriminators could not decide. */
  private undecidedCauses: Set<string> | null = null;
  private codeCache = new Map<string, Promise<CodeCheck>>();
  /** Values that matched a slice (their url / discriminators are known to the slice definition). */
  private sliceMatched = new WeakSet<object>();
  /** Reference elements a Bundle resolution message was already reported for (UserDataNames.validation_bundle_error). */
  private bundleErrorFlag = new WeakSet<object>();
  /** The instance came from an XML document (ValidateOptions.format). */
  private xmlSource = false;
  private assumeValidRestReferences = false;
  private bundleRules: Array<{ rule: string; profile: string }> = [];
  private igs: Array<Record<string, any>> = [];
  private extensionDomains: string[] = [];
  private referencePolicy: ValidateOptions["validateReference"] | null = null;
  /**
   * Embedded resources (entry.resource, contained, parameter.resource, response.outcome) whose resourceType is
   * missing or not a resource: JsonParser.parseResource (7.0.1, l. 770-786) reports them and keeps an empty element of
   * type Resource — no id, no children (FHIRPath sees nothing there; a reference to it finds a `Resource`).
   */
  private unparsed = new Set<object>();
  /** Objects with content in the source that lost all of it in the parser (dropBadPrimitivesIn). */
  private parserEmptied = new WeakSet<object>();
  private parserEmptiedAny = false;
  /** > 0 while a slice discriminator's conformsTo validates a resource (its messages are discarded). */
  /** validator_contained_Id (IV:7533): the contained resources whose id has been checked in this run */
  private containedIdChecked = new WeakSet<object>();
  private strippedCache = new WeakMap<object, any>();
  private emptiedCache = new WeakMap<object, Promise<boolean>>();

  /** The StructureDefinitions fpe.check reads. */
  private readonly pathCheckDeps = {
    fetch: (url: string): Promise<Record<string, any> | null> => this.resolver.fetchStructureDefinition(url),
    primitiveTypes: new Set(Object.keys(PRIMITIVES)),
    allTypes: [...R4_RESOURCE_NAMES, "Resource", "DomainResource", ...COMPLEX_TYPES, ...Object.keys(PRIMITIVES)],
  };

  /** element.fhirType() of `target`, an object inside `resource` (or a resource): by the definitions, null when not found. */
  private async typeOfObjectIn(resource: Record<string, any>, target: unknown): Promise<string | null> {
    if (!isObject(target)) return null;
    if (typeof target.resourceType === "string") return target.resourceType;
    const walk = async (node: any, sdx: SdIndex, el: Record<string, any>, depth: number): Promise<string | null> => {
      if (depth > 40 || !isObject(node)) return null;
      const groups = sdx.children(el);
      if (!groups) return null;
      for (const [k, v] of Object.entries(node)) {
        if (k.startsWith("_") || v === null || typeof v !== "object") continue;
        let def: Record<string, any> | null = groups.get(k)?.base ?? null;
        let code = def ? typeCodeOf((def.type ?? [])[0] ?? {}) : "";
        if (!def) {
          for (const g of groups.values()) {
            if (!g.name.endsWith("[x]") || !k.startsWith(g.name.slice(0, -3))) continue;
            def = g.base;
            code = k.charAt(g.name.length - 3).toLowerCase() + k.slice(g.name.length - 2);
            code = (def?.type ?? []).map(typeCodeOf).find((c: string) => c.toLowerCase() === code.toLowerCase()) ?? "";
          }
        }
        if (!def || !code) continue;
        for (const x of Array.isArray(v) ? v : [v]) {
          if (!isObject(x)) continue;
          if (x === target) return code;
          if (typeof x.resourceType === "string") continue;
          const inline = sdx.hasChildren(def);
          const tsdx = inline ? sdx : await this.sdx(CORE + code);
          const r = tsdx ? await walk(x, tsdx, inline ? def : tsdx.root, depth + 1) : null;
          if (r !== null) return r;
        }
      }
      return null;
    };
    const root = await this.sdx(CORE + String(resource.resourceType));
    return root ? walk(resource, root, root.root, 0) : null;
  }

  /**
   * The FHIRPath view of a value: what has no content in the element model is removed — unparsed embedded resources,
   * objects the parser emptied (Element.isEmpty: FHIRPathEngine.funcExists does not count them; cmp-1 on a section whose
   * only entry lost its reference).
   */
  /** The element a view stands for: every view of one Element is that Element (ResourceValidationTracker, conformsToProfile). */
  private sourceOf(v: object): object {
    let cur = v;
    for (let next = this.viewSource.get(cur); next; next = this.viewSource.get(cur)) cur = next;
    return cur;
  }

  private fhirPathView(v: any): any {
    if ((!this.unparsed.size && !this.parserEmptiedAny) || v === null || typeof v !== "object") return v;
    const hit = this.strippedCache.get(v);
    if (hit !== undefined) return hit;
    let out: any;
    if (Array.isArray(v)) {
      const mapped = v.map((x) => this.fhirPathView(x));
      out = mapped.some((x, i) => x !== v[i]) ? mapped : v;
    } else {
      let changed = false;
      const o: Record<string, any> = {};
      for (const [k, x] of Object.entries(v)) {
        if (isObject(x) && (this.unparsed.has(x) || this.parserEmptied.has(x))) {
          changed = true;
          continue;
        }
        if (Array.isArray(x) && x.some((y) => isObject(y) && (this.unparsed.has(y) || this.parserEmptied.has(y)))) {
          changed = true;
          const kept = x.filter((y) => !(isObject(y) && (this.unparsed.has(y) || this.parserEmptied.has(y)))).map((y) => this.fhirPathView(y));
          if (kept.length) o[k] = kept;
          continue;
        }
        const y = this.fhirPathView(x);
        if (y !== x) changed = true;
        o[k] = y;
      }
      if (changed) copyLiterals(v, o);
      out = changed ? o : v;
    }
    if (out !== v) this.viewSource.set(out, v);
    this.strippedCache.set(v, out);
    return out;
  }

  /** The type a resource object has in the element model (`Resource` for an unparsed one). */
  private typeOfResource(r: Record<string, any>): string {
    return this.unparsed.has(r) ? "Resource" : String(r.resourceType);
  }

  /**
   * InstanceValidator.idStatusForEntry (7.0.1, l. 8730-8768) for an unparsed embedded resource (its element has no
   * `special`, so validateContains keeps this status): is an id required?
   */
  private idRequiredForUnparsed(el: Record<string, any>, v: Record<string, any>, rctx: ResourceCtx): boolean {
    const exp = extString(el, "http://hl7.org/fhir/StructureDefinition/structuredefinition-id-expectation");
    if (exp !== null) return exp === "required";
    const p = String(el.path || "");
    if (/(^|\.)entry\.resource$/.test(p) && rctx.resource.resourceType === "Bundle") {
      const entries: any[] = Array.isArray(rctx.resource.entry) ? rctx.resource.entry : [];
      const known = rctx.bundle?.bundle === rctx.resource ? rctx.bundle.entryOf.get(v) : undefined;
      const ep = known ? entries[known.index] : entries.find((e) => isObject(e) && e.resource === v);
      if (!ep) return true;
      if (ep.response !== undefined) return false;
      const method = isObject(ep.request) ? ep.request.method : undefined;
      const url = isObject(ep.request) ? ep.request.url : undefined;
      if (method === undefined || method === null) {
        if (typeof ep.fullUrl !== "string") return true;
        return !(ep.fullUrl.startsWith("urn:uuid:") || ep.fullUrl.startsWith("urn:oid:"));
      }
      if (method === "PUT") return url === undefined || url === null;
      return false;
    }
    if (/(^|\.)parameter\.resource$/.test(p) || /(^|\.)response\.outcome$/.test(p)) return false;
    return true;
  }


  constructor(private readonly resolver: ValidatorResolver) {}

  /** ValidateOptions.languages of the running validation. */
  private languages: string[] = ["en"];
  /** Canonical urls of the contained resources in scope (a url they define resolves, vs-canonical-good). */
  private containedUrls = new Set<string>();
  /** Working language of the resource being validated (its `language`), null = ValidateOptions.languages. */
  private workingLang: string[] | null = null;
  private matchetypeStatus: "disallowed" | "required" | "optional" = "disallowed";
  private relativeDatePlaceHolder: string | null = null;
  /** ValidationContext.isMatchetype of the resource being validated. */
  private inMatchetype = false;
  /** ValidateOptions.allowExamples of the running validation. */
  private allowExamples = false;
  /** ValidateOptions.displayWarnings of the running validation. */
  private displayWarnings = false;
  /** ValidateOptions.htmlInMarkdown of the running validation. */
  private htmlInMarkdown: "none" | "warning" | "error" = "warning";

  // ------------------------------------------------------------------ public

  /**
   * One validation. Every run works on its own engine (all the fields above are per run, so concurrent validate() calls
   * on one instance share nothing mutable) over a pinned view of the resolver, inside the request's snapshot
   * (fhirValidationSnapshot.ts). A lookup that failed is reported apart from the findings: see fhirValidatorSession.ts.
   */
  async validate(resource: Record<string, any>, opts: ValidateOptions = {}): Promise<Issue[]> {
    const session = new LookupSession();
    const run = new InstanceValidator(sessionResolver(this.resolver, session));
    let issues: Issue[];
    try {
      issues = await withValidationSnapshot(() => run.validateRun(resource, opts));
    } catch (e) {
      if (!session.noVerdict) throw e;
      issues = [];
    }
    if (session.noVerdict) return [lookupFailureIssue(session.total, session.samples, true)];
    return session.total ? [...issues, lookupFailureIssue(session.total, session.samples)] : issues;
  }

  private async validateRun(resource0: Record<string, any>, opts: ValidateOptions): Promise<Issue[]> {
    const issues: Issue[] = [];
    if (!isObject(resource0)) {
      return [{ severity: "fatal", path: "", code: "structure", message: "resource must be a JSON object with a resourceType" }];
    }
    // JsonParser.parse (7.0.1, l. 224-235) + ParserBase.getDefinition: the root's type decides whether there is anything to validate
    const rootType: unknown = resource0.resourceType;
    if (rootType === undefined || rootType === null) return [{ severity: "fatal", path: "$", code: "invalid", message: "Unable to find resourceType property" }];
    if (typeof rootType !== "string") return [{ severity: "fatal", path: "$", code: "invalid", message: `The JSON element 'resourceType' has the wrong JSON type: ${describeJsonType(rootType)}` }];
    if (!isCoreTypeName(rootType)) return [{ severity: "fatal", path: rootType, code: "structure", message: `This content cannot be parsed (unknown or unrecognized resource name '${rootType}')` }];
    this.xmlSource = opts.format === "xml";
    this.parserEmptied = new WeakSet();
    this.parserEmptiedAny = false;
    this.containedIdChecked = new WeakSet();
    const resource = await this.dropBadPrimitiveValues(resource0, rootType, issues, 0);
    const bundle = resource.resourceType === "Bundle" ? this.bundleCtx(resource) : null;
    // clearInternalState l. 1117-1118: a reference back to the root is that element, not a fresh fetch
    this.fetchCache.clear();
    this.fetchCache.set(`${resource.resourceType}/${resource.id ?? null}`, resource);
    const rctx: ResourceCtx = { resource, container: null, root: resource, bundle, entry: null };
    // `|version` is kept: HL7 resolves a versioned canonical to that version only.
    const extra = (opts.profiles || []).map((p) => String(p || "").trim()).filter((p) => p !== "");
    const langs = (opts.languages ?? []).map((l) => String(l || "").trim()).filter((l) => l !== "");
    this.languages = langs.length ? langs : ["en"];
    this.allowExamples = opts.allowExamples === true;
    this.matchetypeStatus = opts.matchetypeStatus ?? "disallowed";
    this.relativeDatePlaceHolder = opts.relativeDatePlaceHolder ?? null;
    this.displayWarnings = opts.displayWarnings === true;
    this.htmlInMarkdown = opts.htmlInMarkdown ?? "warning";
    this.workingLang = null;
    this.boundValueSets = new Set();
    this.pendingVsSystems = false;
    this.bundleErrorFlag = new WeakSet();
    this.xmlSource = opts.format === "xml";
    this.assumeValidRestReferences = opts.assumeValidRestReferences === true;
    this.bundleRules = Array.isArray(opts.bundleRules) ? opts.bundleRules : [];
    this.igs = Array.isArray(opts.implementationGuides) ? opts.implementationGuides.filter(isObject) : [];
    this.extensionDomains = Array.isArray(opts.extensionDomains) ? opts.extensionDomains : [];
    this.referencePolicy = opts.validateReference ?? null;
    this.unparsed = unparsedResources(resource);
    this.strippedCache = new WeakMap();
    this.emptiedCache = new WeakMap();
    await this.validateResource(rctx, resource.resourceType, extra, issues, 0);
    if (bundle) await this.validateBundleRules(bundle, resource.resourceType, issues);
    await this.structuralPass(resource, resource.resourceType, issues, 0);
    await this.settleVsSystems(issues);
    return dedupe(issues);
  }

  /**
   * (parity v3) Validates JSON source text the way validator_cli reads a .json file: the Java JSON5-mode lexer /
   * parser (fhirJsonParser.ts) — a syntax error is the single fatal "Error parsing JSON: …"; comments, unquoted
   * names / values, missing / extra commas and duplicate names are error issues next to the instance's own issues
   * (elementmodel.JsonParser). validate() on an already-parsed value is unchanged.
   */
  async validateText(text: string, opts: ValidateOptions = {}): Promise<Issue[]> {
    let root: JObject;
    try {
      root = parseFhirJsonText(text);
    } catch (e) {
      if (!(e instanceof JsonSyntaxError)) throw e;
      return [{ severity: "fatal", path: "", code: "invalid", message: `Error parsing JSON: ${e.message}` }];
    }
    // JsonObject.get(): the last of duplicated names (propMap); the element model binds the first (getJsonPropertyByName)
    const rtProps = root.props.filter((p) => p.name === "resourceType");
    const rt = rtProps[rtProps.length - 1]?.value;
    if (!rt) return [{ severity: "fatal", path: "$", code: "invalid", message: "Unable to find resourceType property" }];
    if (rt.kind !== "string") {
      const name = { object: "Object", array: "Array", number: "Number", boolean: "Boolean", null: "Null" }[rt.kind];
      return [{ severity: "fatal", path: "$", code: "invalid", message: `The JSON element 'resourceType' has the wrong JSON type: ${name}` }];
    }
    const resource = toPlain(root) as Record<string, any>;
    resource.resourceType = rt.value;
    const issues = await this.validate(resource, opts);
    const unrecognised: Array<{ path: string; name: string }> = [];
    for (const i of issues) {
      const m = /^Unrecognized property '(.*)'$/su.exec(i.message);
      if (m) unrecognised.push({ path: i.path, name: m[1] });
    }
    const syntax = dropUnprocessed(jsonSyntaxIssues(root, rt.value, !!opts.allowJsonComments), unrecognised).map((s): Issue => ({ severity: s.severity, path: s.path, code: s.code, message: s.message }));
    // one issue per (path, message): the official outcome lists a repeated mark once (three "id" names → one duplicate)
    return dedupe([...syntax, ...issues]);
  }

  /**
   * (v13) Terminology_TX_System_ValueSet2 for IG ValueSets. validator_cli 7.0.1 / 7.0.3 knows an
   * IG ValueSet as such only once it has loaded it, i.e. after checking a binding to it (or to a
   * ValueSet including it) — the same Observation.code coding with system = …/ValueSet/
   * laboratory-code-tw is an error when the resource / Bundle / batch checks laboratory-code-tw
   * as a binding, and only the UNKNOWN_CODESYSTEM warning when nothing does (Coding-level slice
   * bindings — MedicationRequest.medication[x].coding — never load it). The CLI's order
   * dependence (first use in a JVM is only a warning) is dropped: a ValueSet bound anywhere in
   * the validated instance counts, wherever the binding sits.
   */
  private async settleVsSystems(issues: Issue[]): Promise<void> {
    if (!this.pendingVsSystems) return;
    const marked = issues.filter((i) => typeof (i as any)[VS_SYSTEM] === "string");
    if (!marked.length) return;
    const loaded = new Set<string>();
    const visit = async (url: string): Promise<void> => {
      const u = stripVersion(url);
      if (loaded.has(u)) return;
      loaded.add(u);
      let vs: Record<string, any> | null = null;
      try {
        vs = await this.vsHeader(url);
      } catch {
        vs = null;
      }
      const incs = vs && isObject(vs.compose) && Array.isArray(vs.compose.include) ? vs.compose.include : [];
      for (const inc of incs) if (isObject(inc) && Array.isArray(inc.valueSet)) for (const v of inc.valueSet) if (typeof v === "string" && v) await visit(v);
    };
    for (const u of this.boundValueSets) await visit(u);
    for (const issue of marked) {
      const url = String((issue as any)[VS_SYSTEM]);
      delete (issue as any)[VS_SYSTEM];
      if (!loaded.has(stripVersion(url))) continue;
      issue.severity = "error";
      issue.code = "code-invalid";
      issue.message = `The Coding references a value set, not a code system ('${url}')`;
    }
  }

  // ------------------------------------------------------------------ helpers

  /** StructureDefinition index by canonical; a `|version` suffix is honoured by the resolver. */
  private sdx(url: string): Promise<SdIndex | null> {
    const key = String(url || "").trim();
    let p = this.sdCache.get(key);
    if (!p) {
      p = this.resolver.fetchStructureDefinition(key).then((sd) => (sd && sd.snapshot ? indexOf(sd) : null));
      this.sdCache.set(key, p);
    }
    return p;
  }

  /** ProfileUtilities.findProfile(url, source): an unversioned reference made by a profile resolves in its package first. */
  private async scopedSdx(url: string, from: SdIndex): Promise<SdIndex | null> {
    if (url.includes("|") || !this.resolver.scopedDefinitionVersion) return this.sdx(url);
    const version = await this.resolver.scopedDefinitionVersion(url, from.sd);
    return version ? ((await this.sdx(`${url}|${version}`)) ?? this.sdx(url)) : this.sdx(url);
  }

  /** The installed StructureDefinition for `url` when it exists but has no (generated) snapshot, else null. */
  private async snapshotless(url: string): Promise<Record<string, any> | null> {
    const sd = await this.resolver.fetchStructureDefinition(String(url || "").trim());
    return sd && typeof sd.url === "string" && !(Array.isArray(sd.snapshot?.element) && sd.snapshot.element.length) ? sd : null;
  }

  private vsHeader(url: string): Promise<Record<string, any> | null> {
    const key = String(url || "").trim();
    let p = this.vsHeaderCache.get(key);
    if (!p) {
      p = this.resolver.fetchValueSet(key);
      this.vsHeaderCache.set(key, p);
    }
    return p;
  }

  private member(url: string, system: string | null, code: string): Promise<boolean | undefined> {
    const key = `${url}\u0000${system}\u0000${code}`;
    let p = this.memberCache.get(key);
    if (!p) {
      p = this.resolver.valueSetContains(url, system, code);
      this.memberCache.set(key, p);
    }
    return p;
  }

  private codeCheck(system: string, code: string, display: string | null, version: string | null = null): Promise<CodeCheck> {
    const eff = this.workingLang ?? this.languages;
    const key = `${system}|${code}|${display}|${version}|${eff.join(",")}|${this.displayWarnings}`;
    let p = this.codeCache.get(key);
    if (!p) {
      // the default languages are not passed, so resolvers without the parameter keep their behaviour
      const langs = eff.length === 1 && eff[0] === "en" ? undefined : eff;
      p = langs ? this.resolver.checkCode(system, code, display, version, langs) : this.resolver.checkCode(system, code, display, version);
      // InstanceValidator.processTxIssues (7.0.1): displayWarningMode turns an invalid-display error into a warning
      if (this.displayWarnings) p = p.then((r) => (r.status === "invalid-display" && r.severity === "error" ? { ...r, severity: "warning" } : r));
      this.codeCache.set(key, p);
    }
    return p;
  }

  private bundleCtx(bundle: Record<string, any>, path = "Bundle"): BundleCtx {
    const entries: BundleEntryCtx[] = [];
    const byFullUrl = new Map<string, BundleEntryCtx[]>();
    const entryOf = new Map<object, BundleEntryCtx>();
    const raw: RawBundleEntry[] = [];
    const map = new Map<string | null, RawBundleEntry[]>();
    const relMap = new Map<string, RawBundleEntry[]>();
    const typeId = new Map<string, RawBundleEntry>();
    const add = <K,>(m: Map<K, RawBundleEntry[]>, k: K, v: RawBundleEntry): void => {
      const l = m.get(k);
      if (l) l.push(v);
      else m.set(k, [v]);
    };
    (Array.isArray(bundle.entry) ? bundle.entry : []).forEach((e: any, index: number) => {
      if (!isObject(e)) return;
      // BaseValidator.resolveInBundle: fullUrl → entries, Type/id → entries, plus `/_history/<meta.versionId>` keys
      const fu = typeof e.fullUrl === "string" ? e.fullUrl : null;
      const res = isObject(e.resource) ? e.resource : null;
      const re: RawBundleEntry = { index, entry: e, fullUrl: fu, resource: res };
      raw.push(re);
      add(map, fu, re);
      if (res) {
        const tid = `${res.resourceType}/${res.id}`;
        if (!typeId.has(tid)) typeId.set(tid, re);
        const rl = typeof res.id === "string" ? `${res.resourceType}/${res.id}` : null;
        if (rl) add(relMap, rl, re);
        const vid = isObject(res.meta) && (typeof res.meta.versionId === "string" || typeof res.meta.versionId === "number") ? String(res.meta.versionId) : null;
        if (vid) {
          add(map, `${fu}/_history/${vid}`, re);
          if (rl) add(relMap, `${rl}/_history/${vid}`, re);
        }
      }
    });
    (Array.isArray(bundle.entry) ? bundle.entry : []).forEach((e: any, index: number) => {
      const r = isObject(e) ? e.resource : null;
      if (!isObject(r)) return;
      // element.getNamedChildValue("fullUrl"): a "" is a value, not a missing fullUrl (Bundle_BUNDLE_Entry_NoFullUrl,
      // Bundle_BUNDLE_FullUrl_Missing test `fullUrl != null` / `fullUrl == null`)
      const fullUrl = typeof e.fullUrl === "string" ? e.fullUrl : null;
      const ent: BundleEntryCtx = { index, fullUrl, resource: r };
      entries.push(ent);
      entryOf.set(r, ent);
      if (fullUrl) {
        const list = byFullUrl.get(fullUrl) || [];
        list.push(ent);
        byFullUrl.set(fullUrl, list);
      }
    });
    return { bundle, type: typeof bundle.type === "string" ? bundle.type : "", entries, byFullUrl, entryOf, raw, map, relMap, typeId, path };
  }

  private anchorCache = new WeakMap<object, Set<string>>();

  /**
   * Anchors a narrative link may point at: id / name attributes of every narrative in the Bundle (or of the
   * resource outside a Bundle) and the ids of contained resources. Whole-Bundle scope is the lenient reading.
   */
  private narrativeAnchors(rctx: ResourceCtx): Set<string> {
    const scope: Record<string, any> = rctx.bundle?.bundle ?? rctx.root ?? rctx.resource;
    const hit = this.anchorCache.get(scope);
    if (hit) return hit;
    const out = new Set<string>();
    const walk = (n: unknown, d: number): void => {
      if (d > 2 * MAX_DEPTH + 2 || !n || typeof n !== "object") return; // past the element depth limit, which is reported
      if (Array.isArray(n)) return void n.forEach((x) => walk(x, d + 1));
      const o = n as Record<string, any>;
      if (typeof o.div === "string") for (const m of o.div.matchAll(/\s(?:id|name)\s*=\s*["']([^"']+)["']/gu)) out.add(m[1]);
      if (typeof o.resourceType === "string" && typeof o.id === "string") out.add(o.id);
      for (const v of Object.values(o)) if (v && typeof v === "object") walk(v, d + 1);
    };
    walk(scope, 0);
    this.anchorCache.set(scope, out);
    return out;
  }

  /** Bundle entry a (possibly contained / nested) resource belongs to. */
  private entryFor(r: Record<string, any>, rctx: ResourceCtx, inherit: boolean): BundleEntryCtx | null {
    return rctx.bundle?.entryOf.get(r) ?? (inherit ? rctx.entry ?? null : null);
  }

  /**
   * Port of BaseValidator.resolveInBundle(bundle, entries, ref, fullUrl, type, id, stack, errors, name, source,
   * isWarning, isNLLink) (7.0.1) — the resolution BundleValidator uses (document / message references,
   * checkAllInterlinked): absolute references match a fullUrl exactly; relative ones are made absolute against the
   * source entry's RESTful fullUrl (urlRegex + ends with type/id); otherwise the fullUrl-less entries are the
   * candidates (map key null, as in Java). Messages are reported once per source element (validation_bundle_error).
   */
  private async resolveInBundle(
    b: BundleCtx,
    ref: string,
    fullUrl: string | null,
    type: string,
    id: string | null,
    path: string | null,
    issues: Issue[] | null,
    name: string,
    source: object | null,
    isWarning: boolean,
    isNLLink: boolean,
  ): Promise<RawBundleEntry | null> {
    const canReport = (): boolean => path !== null && issues !== null && !(source && this.bundleErrorFlag.has(source));
    const flag = (): void => {
      if (source) this.bundleErrorFlag.add(source);
    };
    const report = (severity: Issue["severity"], code: string, message: string): void => {
      issues!.push({ severity, path: path!, code, message });
    };
    let fragment: string | null = null;
    if (ref.includes("#")) {
      fragment = ref.slice(ref.indexOf("#") + 1);
      ref = ref.slice(0, ref.indexOf("#"));
    }
    if (isAbsoluteUrlJava(ref)) {
      const el = b.map.get(ref);
      if (!el) {
        // not a complaint when the URL is a known conformance resource, or a RESTful URL of a canonical resource type
        let ok = !!this.resolver.definitionExists && (await this.resolver.definitionExists(ref).catch(() => false));
        if (!ok && BUNDLE_URL_REGEX.test(ref)) {
          const p = javaSplit(ref, "/");
          ok = CANONICAL_RESOURCE_TYPES.has(p[p.length - 2]);
        }
        if (!ok && canReport()) {
          flag();
          report(isWarning ? "information" : "error", "not-found", `Can't find '${ref}' in the bundle (${name})`);
        }
        return null;
      } else if (el.length === 1) {
        if (fragment !== null && issues && path !== null) {
          const n = countFragmentMatches(el[0].entry, fragment);
          if (n === 0) {
            flag();
            report(isNLLink ? "information" : "error", "not-found", `Can't find '${ref}' in the bundle (${fragment})`);
          } else if (n > 1) {
            flag();
            report("error", "invalid", `Found ${n} matches for fragment ${fragment} in resource '${ref}' in the bundle (${name})`);
          }
        }
        return el[0];
      } else {
        if (canReport()) {
          flag();
          report("error", "invalid", `Found ${el.length} matches for '${ref}' in the bundle (${name})`);
        }
        return null;
      }
    }
    let u: string | null = null;
    if (fullUrl !== null && BUNDLE_URL_REGEX.test(fullUrl) && fullUrl.endsWith(`${type}/${id}`)) {
      u = fullUrl.slice(0, fullUrl.length - `${type}/${id}`.length) + ref;
    }
    let el = b.map.get(u);
    if (el && el.length > 0) {
      if (el.length === 1) return el[0];
      if (canReport()) {
        flag();
        report("error", "invalid", `Found ${el.length} matches for '${ref}' in the bundle (${name})`);
      }
      return null;
    }
    const parts = javaSplit(ref, "/");
    if (parts.length >= 2 && R4_RESOURCE_NAMES.has(parts[0])) {
      el = b.relMap.get(`${parts[0]}/${parts[1]}`);
      if (el) {
        if (canReport()) {
          // (ALLOW_TRANSIENT_BASE_REFERENCES is false in 7.0.1)
          flag();
          const tl = [...new Set(el.map((e) => e.fullUrl ?? "<missing>"))].sort().join(",");
          const one = el.length === 1;
          const msg =
            u === null
              ? one
                ? `Can't find '${ref}' in the bundle (${name}). Note that there is a resource in the bundle with the same type and id, but it does not match because of the fullUrl based rules around matching relative references. Found '${tl}', but it doesn't match because of the source fullUrl '${fullUrl}'`
                : `Can't find '${ref}' in the bundle (${name}). Note that there are ${el.length} resources in the bundle with the same type and id, but they do not match because of the fullUrl based rules around matching relative references. Found '${tl}', but none of them match because of the source fullUrl '${fullUrl}'`
              : one
                ? `Can't find '${ref}' in the bundle (${name}). Note that there is a resource in the bundle with the same type and id, but it does not match because of the fullUrl based rules around matching relative references (must be '${u}', but found '${tl}')`
                : `Can't find '${ref}' in the bundle (${name}). Note that there are ${el.length} resources in the bundle with the same type and id, but they do not match because of the fullUrl based rules around matching relative references (must be '${u}', but found these: ${tl})`;
          report("error", "invalid", msg);
        }
      } else if (canReport()) {
        flag();
        report(isWarning ? "information" : "error", "not-found", `Can't find '${ref}' in the bundle (${name})`);
      }
    }
    return null;
  }

  /**
   * Port of BaseValidator.getFromBundle (7.0.1) — the resolution InstanceValidator.checkReference uses (via
   * localResolve) for a reference inside a Bundle entry: the target URL is the reference itself when absolute, else
   * the source fullUrl's base (all but its last two `/` segments, or a `urn:…:` prefix) + the reference; an entry
   * matches on fullUrl (and meta.versionId for `/_history/`). Messages only when `issues` is given.
   */
  private getFromBundle(
    b: BundleCtx,
    ref: string,
    fullUrl: string | null,
    issues: Issue[] | null,
    path: string,
  ): RawBundleEntry | null {
    const type = b.type;
    const isTransaction = type === "transaction" || type === "batch";
    const push = (severity: Issue["severity"], code: string, message: string): void => {
      if (issues) issues.push({ severity, path, code, message });
    };
    let targetUrl: string;
    let version = "";
    let resourceType: string | null = null;
    if (ref.startsWith("http:") || ref.startsWith("urn:") || isAbsoluteUrlJava(ref)) {
      if (ref.includes("/_history/")) {
        // (sic) Java takes one character less than the base URL here, so a versioned absolute reference never matches
        targetUrl = ref.slice(0, ref.indexOf("/_history/") - 1);
        version = ref.slice(ref.indexOf("/_history/") + 10);
      } else targetUrl = ref;
    } else if (fullUrl === null) {
      if (!(type === "batch-response" || type === "transaction-response" || path.startsWith("Bundle.signature") || (b.path === "Bundle" && path.startsWith(`${ROOT_TOKEN}.signature`)))) {
        push("error", "required", "Relative Reference appears inside Bundle whose entry is missing a fullUrl");
      }
      return null;
    } else if ((ref.match(/\//gu)?.length ?? 0) !== 1 && (ref.match(/\//gu)?.length ?? 0) !== 3) {
      if (isTransaction) {
        if (!isSearchUrl(ref)) push("error", "invalid", `Relative URLs must be of the format [ResourceName]/[id], or a search URL is allowed ([type]?parameters. Encountered ${ref})`);
      } else {
        push("error", "invalid", `Relative URLs must be of the format [ResourceName]/[id]. Encountered ${ref}`);
      }
      return null;
    } else {
      let base = "";
      if (fullUrl.startsWith("urn")) {
        const parts = javaSplit(fullUrl, ":");
        for (let i = 0; i < parts.length - 1; i++) base = base + parts[i] + ":";
      } else {
        const parts = javaSplit(fullUrl, "/");
        for (let i = 0; i < parts.length - 2; i++) base = base + parts[i] + "/";
      }
      if (ref.includes("/_history/")) {
        version = ref.slice(ref.indexOf("/_history/") + 10);
        const rb = javaSplit(ref.slice(0, ref.indexOf("/_history/")), "/");
        if (rb.length < 2) {
          // refBaseParts[1] (l. 1519-1521) throws in Java (validation fails): reported, never passed
          push("error", "invalid", `Relative URLs must be of the format [ResourceName]/[id]. Encountered ${ref}`);
          return null;
        }
        resourceType = rb[0];
        targetUrl = base + rb[0] + "/" + rb[1];
      } else if (base.startsWith("urn")) {
        const rp = javaSplit(ref, "/");
        if (rp.length < 2) {
          // `Type/` (no id) under a urn fullUrl: refParts[1] (l. 1526-1528) throws ArrayIndexOutOfBoundsException and
          // validator_cli fails the whole validation (evaluator corpus: official-crash). The resource must not pass:
          // the reference is reported with the relative-URL format message (Reference_REF_Format2).
          push("error", "invalid", `Relative URLs must be of the format [ResourceName]/[id]. Encountered ${ref}`);
          return null;
        }
        resourceType = rp[0];
        targetUrl = base + rp[1];
      } else {
        targetUrl = base + ref;
      }
    }
    let match: RawBundleEntry | null = null;
    // the entries with this fullUrl, in order (the map also holds `/_history/` keys)
    for (const we of b.map.get(targetUrl) ?? []) {
      if (targetUrl !== we.fullUrl) continue;
      const r = we.resource;
      if (version === "") {
        if (match !== null) push("error", "forbidden", `Multiple matches in bundle for reference ${ref}`);
        match = we;
      } else if (r) {
        const meta = isObject(r.meta) ? r.meta : null;
        if (!meta) {
          // getChildren(META).get(0) throws: the catch reports the missing versionId
          push("warning", "required", `Entries matching fullURL ${targetUrl} should declare meta/versionId because there are version-specific references`);
        } else if (meta.versionId !== undefined && version === String(meta.versionId)) {
          if (match !== null) push("error", "forbidden", `Multiple matches in bundle for reference ${ref}`);
          match = we;
        }
      }
    }
    if (match && resourceType !== null && match.resource && this.typeOfResource(match.resource) !== resourceType) {
      push("error", "required", `Matching reference for reference ${ref} has resourceType ${this.typeOfResource(match.resource)}`);
    }
    if (match === null) {
      if (ref.startsWith("urn")) push("warning", "required", `URN reference is not locally contained within the bundle ${ref}`);
      if (!isAbsoluteUrlJava(ref)) {
        const p = javaSplit(ref, "/");
        const ml: RawBundleEntry[] = [];
        if (p.length >= 2 && R4_RESOURCE_NAMES.has(p[0]) && isValidIdJava(p[1])) {
          for (const we of b.relMap.get(`${p[0]}/${p[1]}`) ?? []) if (we.resource && we.resource.resourceType === p[0] && we.resource.id === p[1]) ml.push(we);
        }
        if (ml.length > 1) {
          push("warning", "required", `The bundle contains no match for ${targetUrl} by the rules of Bundle reference resolution, but it has multiple resources that match ${ref} by resource type and id`);
        }
        for (const e of ml) {
          push(
            "warning",
            "required",
            e.fullUrl === null
              ? `Entry ${e.index} matches the reference ${ref} by type and id but it does not match the full target URL ${targetUrl} by Bundle resolution rules`
              : `Entry ${e.index} matches the reference ${ref} by type and id but its fullUrl ${e.fullUrl} does not match the full target URL ${targetUrl} by Bundle resolution rules`,
          );
        }
      }
    }
    return match;
  }

  /**
   * Port of InstanceValidator.localResolve (7.0.1, R4: no R5 relative-reference policy): `#id` against the
   * container's contained resources; anything else through the enclosing Bundle (getFromBundle with the entry's
   * fullUrl; an entry without fullUrl reports Bundle_BUNDLE_Entry_NoFullUrl outside batch / transaction responses).
   * Messages only when `issues` / `path` are given.
   */
  private localResolve(ref: string, rctx: ResourceCtx, path: string | null, issues: Issue[] | null): Record<string, any> | null {
    if (ref.startsWith("#")) {
      const container = rctx.container || rctx.resource;
      if (ref === "#") return container;
      const id = ref.slice(1);
      for (const c of Array.isArray(container.contained) ? container.contained : []) {
        if (isObject(c) && c.id === id) return c;
      }
      return null;
    }
    const b = rctx.bundle;
    if (!b) return null;
    const entry = rctx.entry ?? null;
    const fullUrl = entry ? entry.fullUrl : null;
    if (entry && fullUrl === null && issues && path !== null && b.type !== "batch-response" && b.type !== "transaction-response") {
      issues.push({ severity: "error", path: `${b.path}.entry[${entry.index}]`, code: "required", message: "Bundle entry missing fullUrl" });
    }
    return this.getFromBundle(b, ref, fullUrl, issues, path ?? "")?.resource ?? null;
  }

  /** Resolve a reference string from `rctx` without reporting (contained siblings, then the Bundle). */
  private resolveRef(ref: string, rctx: ResourceCtx): Record<string, any> | null {
    return this.localResolve(ref, rctx, null, null);
  }

  /**
   * FHIRPath resolve() (InstanceValidator's host resolveReference, 7.0.1): the reference rules of validation first,
   * then BaseValidator.resolveInBundle(url, bundle) over the enclosing Bundle and — for an invariant on the Bundle
   * itself — the resource being validated: an entry matches when the url equals its fullUrl or `Type/id`.
   */
  private resolveRefForFhirPath(ref: string, rctx: ResourceCtx): Record<string, any> | null {
    const hit = this.resolveRef(ref, rctx);
    if (hit || ref.startsWith("#")) return hit;
    const scan = (bundle: any): Record<string, any> | null => {
      if (!isObject(bundle) || bundle.resourceType !== "Bundle" || !Array.isArray(bundle.entry)) return null;
      return this.entryIndex(bundle).get(ref) ?? null;
    };
    return scan(rctx.resource) ?? (rctx.bundle ? this.entryIndex(rctx.bundle.bundle).get(ref) ?? null : null);
  }

  private entryIndexes = new WeakMap<object, Map<string, Record<string, any>>>();

  /** First entry resource by fullUrl or `Type/id`, whichever comes first in entry order. */
  private entryIndex(bundle: Record<string, any>): Map<string, Record<string, any>> {
    let idx = this.entryIndexes.get(bundle);
    if (!idx) {
      idx = new Map();
      for (const be of Array.isArray(bundle.entry) ? bundle.entry : []) {
        const res = isObject(be) && isObject(be.resource) ? be.resource : null;
        if (!res) continue;
        if (typeof be.fullUrl === "string" && !idx.has(be.fullUrl)) idx.set(be.fullUrl, res);
        const tid = `${res.resourceType}/${res.id}`;
        if (!idx.has(tid)) idx.set(tid, res);
      }
      this.entryIndexes.set(bundle, idx);
    }
    return idx;
  }

  /**
   * Port of BundleValidator.validateBundle (7.0.1, R4; signatures and -bundle rules not ported): Bundle.link rules
   * per Bundle type, document / message first entry and references (validateDocument / validateMessage →
   * resolveInBundle), checkAllInterlinked, searchset rules, and per entry the fullUrl rules (BUNDLE_ENTRY_URL_*,
   * canonical url vs fullUrl, fullUrl required). Paths are the official ones, including validator_cli's quirks
   * (the first entry is pushed with index 1, `entry[0]` for the fullUrl rules, `entry[i+1]` for reachability);
   * officialValidator.relocateBundleIssues names the real element for the MCP output.
   */
  private async validateBundleRules(b: BundleCtx, path: string, issues: Issue[]): Promise<void> {
    const type = b.type;
    const entries = b.raw;
    const links: any[] = Array.isArray(b.bundle.link) ? b.bundle.link : [];
    links.forEach((l, i) => {
      if (isObject(l)) this.validateBundleLink(b, links, l, `${path}.link[${i}]`, type, issues);
    });
    if (entries.length === 0) {
      if (type === "document" || type === "message") {
        issues.push({ severity: "error", path, code: "invalid", message: "Documents or Messages must contain at least one entry" });
      }
    } else {
      const first = entries[0];
      const firstPath = `${path}.entry[1]`; // (sic) stack.push(firstEntry, 1, …)
      const fullUrl = first.fullUrl;
      if (type === "document") {
        if (!first.resource) issues.push({ severity: "error", path: `${path}.entry[0]`, code: "invalid", message: "No resource on first entry" });
        else await this.validateDocument(b, first.resource, `${firstPath}.resource`, fullUrl, issues);
        await this.checkAllInterlinked(b, path, false, issues);
      } else if (type === "message") {
        if (!first.resource) issues.push({ severity: "error", path: `${path}.entry[0]`, code: "invalid", message: "No resource on first entry" });
        else {
          await this.validateMessage(b, first.resource, `${firstPath}.resource`, fullUrl, issues);
          await this.checkAllInterlinked(b, path, true, issues);
        }
      } else if (type === "searchset") {
        this.checkSearchSet(b, path, links, issues);
      }
    }
    const fullUrlOptional = FULLURL_OPTIONAL_BUNDLE_TYPES.includes(type);
    const counter = new Map<string, number>();
    let count = 0;
    for (const e of entries) {
      const fullUrl = e.fullUrl;
      const res = e.resource;
      const url = res && typeof res.url === "string" ? res.url : null;
      const id = res && typeof res.id === "string" && !this.unparsed.has(res) ? res.id : null;
      const rtype = res ? this.typeOfResource(res) : null;
      const p0 = `${path}.entry[0]`; // (sic) stack.addToLiteralPath(ENTRY, PATH_ARG)
      if (fullUrl) {
        if (isAbsoluteUrlJava(fullUrl)) {
          if (rtype !== null && BUNDLE_URL_REGEX.test(fullUrl)) {
            if (id === null) {
              issues.push({ severity: "error", path: p0, code: "invalid", message: `The fullUrl '${fullUrl}' looks like a RESTful server URL, but the resource has no id` });
            } else if (!fullUrl.endsWith(`/${rtype}/${id}`)) {
              issues.push({ severity: "error", path: p0, code: "invalid", message: `The fullUrl '${fullUrl}' looks like a RESTful server URL, so it must end with the correct type and id (/${rtype}/${id})` });
            }
          }
        } else {
          issues.push({ severity: "error", path: p0, code: "invalid", message: `The fullUrl must be an absolute URL (not '${fullUrl}')` });
        }
      }
      if (url !== null) {
        const v2v3 = url.startsWith("http://hl7.org/fhir/v3/") || url.startsWith("http://hl7.org/fhir/v2/");
        if (url === fullUrl && !(BUNDLE_URL_REGEX.test(url) && url.endsWith(`/${id}`)) && !v2v3) {
          issues.push({ severity: "error", path: p0, code: "invalid", message: `The canonical URL (${url}) cannot match the fullUrl (${fullUrl}) unless the resource id (${id}) also matches` });
        }
        // Bundle_BUNDLE_Entry_Canonical needs a server base (none configured)
      }
      if (!fullUrlOptional && fullUrl === null) {
        issues.push({
          severity: "error",
          path: `${path}.entry[${e.index}]`,
          code: "invalid",
          message: "Except for transactions and batches, each entry in a Bundle must have a fullUrl which is the identity of the resource in the entry",
        });
      }
      // BundleValidator.validateBundle l. 217-240 + meetsRule l. 959-985: bundle validation rules
      if (rtype !== null && isObject(res)) {
        const rcount = counter.has(rtype) ? counter.get(rtype)! + 1 : 0;
        counter.set(rtype, rcount);
        for (const bvr of this.bundleRules) {
          const rule = bvr.rule;
          const t = rule.includes(":") ? rule.slice(0, rule.indexOf(":")) : /^-?\d+$/.test(rule) ? null : rule;
          const index = rule.includes(":") ? rule.slice(rule.indexOf(":") + 1) : /^-?\d+$/.test(rule) ? rule : null;
          const meets = t === null ? String(count) === index : index === null ? t === rtype : t === rtype && String(rcount) === index;
          if (!meets || !(await this.sdx(bvr.profile))) continue;
          const ectx: ResourceCtx = { resource: res, container: null, root: b.bundle, bundle: b, entry: b.entryOf.get(res) ?? null };
          pushAll(issues, await this.conformance(ectx, bvr.profile, `${path}.entry[${e.index}].resource`, 0));
        }
      }
      count++;
    }
    if (isObject(b.bundle.signature)) this.checkSignatureData(b.bundle.signature, path, issues);
    // l. 247-258, ElementModelUtilities.findSignatures: the R6 form, a Provenance with target `#/`
    for (const e of entries) {
      const res = isObject(e?.resource) ? e.resource : null;
      if (res?.resourceType !== "Provenance" || !(Array.isArray(res.target) ? res.target : []).some((t: any) => t?.reference === "#/")) continue;
      for (const sig of Array.isArray(res.signature) ? res.signature : []) {
        if (isObject(sig) && typeof sig.data === "string" && (sig.sigFormat === "application/jose" || sig.sigFormat === "application/pkcs7-signature")) this.checkSignatureData(sig, path, issues);
      }
    }
  }

  /**
   * BundleValidator.validateSignature l. 1009-1088, the shape of Signature.data only. validateSignatureJose /
   * DigSig (the signed bytes, the canonical form, the certificate) are not ported: no signature is verified here, and
   * a signature the jar would verify marks the run `rules_unchecked`.
   */
  private checkSignatureData(sig: Record<string, any>, path: string, issues: Issue[]): void {
    const data = sig.data;
    if (typeof data !== "string") return;
    // org.hl7.fhir.utilities.Base64.isBase64: the commons-codec alphabet (url-safe too), '=' and white space
    const base64 = /^[A-Za-z0-9+/=\-_\t\n\r ]*$/.test(data);
    let format = typeof sig.sigFormat === "string" && sig.sigFormat ? sig.sigFormat : null;
    if (format === null) {
      try {
        const text = Buffer.from(data, "base64").toString();
        const header = text.split(".").length === 3 ? Buffer.from(text.split(".")[0], "base64").toString() : text;
        if ("alg" in JSON.parse(header)) format = "application/jose";
      } catch {
        // l. 1035: "nothing"
      }
    }
    let verified: string | null = null;
    if (format === "application/pkcs7-signature") {
      if (base64) verified = "BundleValidator.validateSignatureDigSig";
      else issues.push({ severity: "warning", path, code: "invalid", message: "The signature data is not valid base64 content, so the signature cannot be checked" });
    } else if (format === "application/jose") {
      const jws = data.split(".").length === 3;
      if (base64 || jws) verified = "BundleValidator.validateSignatureJose";
      if (!base64) issues.push({ severity: "error", path, code: "invalid", message: jws ? "The signature data is not valid base64 content, but it looks like native application/jose, so it will be checked anyway" : "The signature data is not valid base64 content, so the signature cannot be checked" });
    }
    if (verified) issues.push({ severity: "information", path, code: "rule-unchecked", message: `The ${format} signature was not verified: ${verified} is not ported; not a conformance failure`, unchecked: { kind: "rule", canonical: verified } });
  }

  /** Port of BundleValidator.validateLink and its per-type variants (7.0.1). */
  private validateBundleLink(b: BundleCtx, links: any[], link: Record<string, any>, lpath: string, type: string, issues: Issue[]): void {
    const unique = (rel: string): boolean => {
      for (const l of links) {
        if (l === link) return true; // only complain once: look above this one
        if (isObject(l) && l.relation === rel) return false;
      }
      return true;
    };
    if (type === "history" || type === "searchset") {
      const rel = typeof link.relation === "string" ? link.relation : "";
      if (["first", "previous", "next", "last", "self"].includes(rel) && !unique(rel)) {
        issues.push({ severity: "error", path: lpath, code: "invalid", message: `The link relationship type '${rel}' can only occur once` });
      }
      return;
    }
    if (!["document", "message", "collection", "subscription-notification", "transaction", "transaction-response", "batch", "batch-response"].includes(type)) return;
    if (link.relation === undefined) return;
    const rel = typeof link.relation === "string" ? link.relation : "";
    const rpath = `${lpath}.relation`;
    if (["first", "previous", "next", "last"].includes(rel)) {
      issues.push({ severity: "error", path: rpath, code: "invalid", message: `The link relationship type '${rel}' used in search sets is prohibited in this context` });
    }
    if (rel === "self" && !unique(rel)) {
      issues.push({ severity: "error", path: rpath, code: "invalid", message: `The link relationship type '${rel}' can only occur once` });
    }
    if (type === "document" && rel === "stylesheet" && typeof link.url === "string") {
      const url = link.url;
      const upath = `${lpath}.url`;
      if (isAbsoluteUrlJava(url)) {
        if (url !== "https://hl7.org/fhir/fhir.css") {
          issues.push({ severity: "warning", path: upath, code: "business-rule", message: "External Stylesheets other than https://hl7.org/fhir/fhir.css SHOULD not be used" });
          if (url.startsWith("http://")) issues.push({ severity: "warning", path: upath, code: "business-rule", message: "The stylesheet reference is not secure" });
          const scheme = url.slice(0, url.indexOf(":"));
          const details = url.slice(url.indexOf(":") + 1);
          if (!(["http", "https", "ftp"].includes(scheme) && details.length > 0 && !details.includes(" "))) {
            issues.push({ severity: "warning", path: upath, code: "business-rule", message: "The stylesheet reference is not a resolvable link" });
          }
        }
      } else if (!b.typeId.has(url)) {
        issues.push({ severity: "error", path: upath, code: "not-found", message: "The stylesheet reference could not be resolved in this bundle" });
      }
    }
  }

  /** Port of BundleValidator.checkSearchSet (7.0.1). */
  private checkSearchSet(b: BundleCtx, path: string, links: any[], issues: Issue[]): void {
    const self = links.find((l) => isObject(l) && l.relation === "self");
    const types: string[] = [];
    if (!self) {
      issues.push({ severity: "warning", path, code: "invalid", message: "SearchSet Bundles should have a self link that specifies what the search was" });
    } else {
      const ref = typeof self.url === "string" ? self.url : null;
      if (ref !== null) {
        const q = ref.indexOf("?");
        const head = javaSplit(q >= 0 ? ref.slice(0, q) : ref, "/");
        const tail = q >= 0 ? javaSplit(ref.slice(q + 1), "&") : null;
        if (head.length && R4_RESOURCE_NAMES.has(head[head.length - 1])) types.push(head[head.length - 1]);
        else if (tail) for (const s of tail) if (s.startsWith("_type=")) types.push(...javaSplit(s.slice(6), ","));
      }
      if (!types.length) {
        issues.push({ severity: "information", path, code: "invalid", message: "No types could be determined from the search string, so the types can't be checked" });
      }
    }
    const typesStr = `[${types.join(", ")}]`;
    const check = (rt: string): boolean | null => (types.length === 0 ? null : types.includes(rt));
    const modeOf = (e: RawBundleEntry): string | null => (isObject(e.entry.search) && typeof e.entry.search.mode === "string" ? e.entry.search.mode : null);
    const all = b.raw.every((e) => modeOf(e) !== null);
    const any = b.raw.some((e) => modeOf(e) !== null);
    const searchMode: boolean | null = all ? true : any ? null : false;
    if (searchMode === false) {
      let typeProblem = false;
      let rtype: string | null = null;
      for (const e of b.raw) {
        const epath = `${path}.entry[${e.index}]`;
        const res = e.resource;
        if (!res) {
          issues.push({ severity: "error", path: epath, code: "invalid", message: "SearchSet Bundle Entries must have resources" });
          continue;
        }
        const rpath = `${epath}.resource`;
        const rt = String(res.resourceType);
        const ok = check(rt);
        if (ok === null) {
          typeProblem = true;
          if (!self) issues.push({ severity: "information", path: rpath, code: "invalid", message: "Unable to determine if this resource is a valid resource type for this search" });
          if (!(typeof res.id === "string" || rt === "OperationOutcome")) issues.push({ severity: "warning", path: rpath, code: "invalid", message: "Search results must have ids" });
        } else if (ok) {
          if (rt !== "OperationOutcome") {
            if (typeof res.id !== "string") issues.push({ severity: "warning", path: rpath, code: "invalid", message: "Search results must have ids" });
            if (rtype !== null && rt !== rtype) typeProblem = true;
            else if (rtype === null) rtype = rt;
          }
        } else {
          typeProblem = true;
          issues.push({ severity: "warning", path: epath, code: "invalid", message: `This is not a matching resource type for the specified search (is a search mode needed?) (${rt} expecting ${typesStr})` });
        }
      }
      issues.push({ severity: typeProblem ? "warning" : "information", path, code: "invalid", message: "SearchSet bundles should have search modes on the entries" });
    } else {
      for (const e of b.raw) {
        const epath = `${path}.entry[${e.index}]`;
        const sm = modeOf(e);
        if (sm === null) issues.push({ severity: "warning", path: epath, code: "invalid", message: "SearchSet bundles should have search modes on the entries" });
        const res = e.resource;
        if (!res) {
          issues.push({ severity: "error", path: epath, code: "invalid", message: "SearchSet Bundle Entries must have resources" });
          continue;
        }
        const rpath = `${epath}.resource`;
        const rt = String(res.resourceType);
        const hasId = typeof res.id === "string";
        if (sm === "match") {
          if (!hasId) issues.push({ severity: "error", path: rpath, code: "invalid", message: "Search results must have ids" });
          if (!(types.length === 0 || check(rt))) issues.push({ severity: "error", path: rpath, code: "invalid", message: `This is not a matching resource type for the specified search (${rt} expecting ${typesStr})` });
        } else if (sm === "include") {
          if (!hasId) issues.push({ severity: "error", path: rpath, code: "invalid", message: "Search results must have ids" });
        } else if (sm !== null) {
          if (rt !== "OperationOutcome") issues.push({ severity: "error", path: rpath, code: "invalid", message: `This is not an OperationOutcome (${rt})` });
        }
      }
    }
  }

  /** Port of BundleValidator.validateDocument / validateSections / validateDocumentReference (7.0.1). */
  private async validateDocument(b: BundleCtx, comp: Record<string, any>, cpath: string, fullUrl: string | null, issues: Issue[]): Promise<void> {
    if (comp.resourceType !== "Composition") {
      issues.push({ severity: "error", path: cpath, code: "invalid", message: "The first entry in a document must be a composition" });
      return;
    }
    const id = typeof comp.id === "string" ? comp.id : null;
    const ref = async (elem: any, p: string, name: string): Promise<void> => {
      const r = isObject(elem) ? elem.reference : null;
      if (typeof r !== "string" || !r || r.startsWith("#")) return;
      await this.resolveInBundle(b, r, fullUrl, "Composition", id, p, issues, name, elem, false, false);
    };
    const list = (v: any): any[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);
    // validateDocumentReference: a repeating element is pushed with 1-based indexes, a single one without
    const docRef = async (focus: Record<string, any>, stack: string, prop: string, repeats: boolean, title: string): Promise<void> => {
      const l = list(focus[prop]);
      if (repeats) {
        for (let i = 0; i < l.length; i++) await ref(l[i], `${stack}.${prop}[${i + 1}]`, `${title}.${prop}`);
      } else if (l.length) {
        await ref(l[0], `${stack}.${prop}`, `${title}.${prop}`);
      }
    };
    await docRef(comp, cpath, "subject", false, "Composition");
    await docRef(comp, cpath, "author", true, "Composition");
    await docRef(comp, cpath, "encounter", false, "Composition");
    await docRef(comp, cpath, "custodian", false, "Composition");
    const sub = async (parent: string, repeats: boolean, prop: string): Promise<void> => {
      const l = list(comp[parent]);
      for (let i = 0; i < l.length; i++) if (isObject(l[i])) await docRef(l[i], `${cpath}.${parent}[${i + 1}]`, prop, repeats, `Composition.${parent}`);
    };
    await sub("attester", false, "party");
    await sub("event", true, "detail");
    const sections = async (focus: Record<string, any>, stack: string): Promise<void> => {
      const l = list(focus.section);
      for (let i = 0; i < l.length; i++) {
        const s = l[i];
        if (!isObject(s)) continue;
        const local = `${stack}.section[${i + 1}]`;
        // (sic) the section's author / focus are reported against the parent's stack
        await docRef(s, stack, "author", true, "Section");
        await docRef(s, stack, "focus", false, "Section");
        const se = list(s.entry);
        for (let j = 0; j < se.length; j++) await ref(se[j], `${local}.entry[${j + 1}]`, "Section Entry");
        await sections(s, local);
      }
    };
    await sections(comp, cpath);
  }

  /** Port of BundleValidator.validateMessage (7.0.1). */
  private async validateMessage(b: BundleCtx, mh: Record<string, any>, mpath: string, fullUrl: string | null, issues: Issue[]): Promise<void> {
    if (mh.resourceType !== "MessageHeader") {
      issues.push({ severity: "error", path: mpath, code: "invalid", message: "The first entry in a message must be a MessageHeader" });
      return;
    }
    const id = typeof mh.id === "string" ? mh.id : null;
    for (const f of Array.isArray(mh.focus) ? mh.focus : mh.focus !== undefined ? [mh.focus] : []) {
      const r = isObject(f) ? f.reference : null;
      if (typeof r !== "string" || !r || r.startsWith("#")) continue;
      // push(elem, -1) on a list element: always `focus[0]`
      await this.resolveInBundle(b, r, fullUrl, "MessageHeader", id, `${mpath}.focus[0]`, issues, "MessageHeader Data", f, false, false);
    }
  }

  /**
   * Port of BundleValidator.checkAllInterlinked (7.0.1, R4): every entry's references (Reference.reference, and
   * url / uri values — here extension value[x] url / uri) resolved with resolveInBundle as warnings-only, then
   * reachability from the first entry (forwards, stylesheet links, then backwards). Paths are validator_cli's
   * (`entry[N+1]` after the scan for reverse links, `entry[i+1]` for orphans).
   */
  /**
   * The source path BundleValidator names in BUNDLE_BUNDLE_ENTRY_NOTFOUND_* (Element.getPath): a choice element appears
   * as `x[x]` (subjectReference → subject[x]); an element really called …Reference (reasonReference) keeps its name.
   */
  private async bundleRefName(path: string, res: Record<string, any>): Promise<string> {
    const own = typeof res.resourceType === "string" ? await this.sdx(CORE + res.resourceType) : null;
    const m = /^(.*?\.resource)((?:\.[^.]+)*)$/u.exec(path);
    if (!own || !m) return path.replace(/\.([a-z][A-Za-z]*?)Reference(?=$|[.[])/gu, ".$1[x]");
    let def: string | null = own.type;
    const out: string[] = [];
    for (const seg of m[2].split(".").slice(1)) {
      const mm = /^([^[]+)(.*)$/u.exec(seg)!;
      const n = mm[1];
      const ch = n.endsWith("Reference") ? n.slice(0, -"Reference".length) : null;
      if (def && own.byId.has(`${def}.${n}`)) {
        def = `${def}.${n}`;
        out.push(seg);
      } else if (ch) {
        out.push(`${ch}[x]${mm[2]}`);
        def = null;
      } else {
        out.push(seg);
        def = null;
      }
    }
    return `${m[1]}.${out.join(".")}`;
  }

  private async checkAllInterlinked(b: BundleCtx, path: string, isMessage: boolean, issues: Issue[]): Promise<void> {
    const list = b.raw.filter((e) => e.resource !== null);
    const position = new Map(list.map((e, i) => [e, i]));
    const targets = new Map<RawBundleEntry, RawBundleEntry[]>();
    for (const e of list) {
      const refs: Array<{ ref: string; path: string; source: object; nl: boolean }> = [];
      // the references the element model has: the resource's own type's properties only (JsonParser dropped the rest)
      let entryView: any = this.fhirPathView(e.entry);
      const er = e.resource;
      if (isObject(er) && !this.unparsed.has(er) && isObject(entryView) && entryView.resource === er) {
        const eb = await this.sdx(CORE + String(er.resourceType));
        if (eb) entryView = { ...entryView, resource: await this.parsedView(er, eb) };
      }
      collectBundleRefs(entryView, `${path}.entry[${e.index}]`, refs, null);
      const seen = new Set<string>();
      const out: RawBundleEntry[] = [];
      for (const r of refs) {
        if (r.ref.startsWith("#") || seen.has(r.ref)) continue;
        seen.add(r.ref);
        const name = await this.bundleRefName(r.path, e.resource!);
        const res = e.resource!;
        const tgt = await this.resolveInBundle(b, r.ref, e.fullUrl, this.typeOfResource(res), typeof res.id === "string" && !this.unparsed.has(res) ? res.id : null, path, issues, name, r.source, true, r.nl);
        if (tgt && tgt.resource && tgt !== e && position.has(tgt)) out.push(tgt);
      }
      targets.set(e, out);
    }
    const edges = list.map((e) => (targets.get(e) ?? []).map((t) => position.get(t)!));
    const seeds: number[] = [];
    if (list.length) seeds.push(0);
    const visited = new Set<number>();
    forwardClosure(seeds, edges, visited);
    for (const l of Array.isArray(b.bundle.link) ? b.bundle.link : []) {
      if (!isObject(l) || l.relation !== "stylesheet" || typeof l.url !== "string") continue;
      const hit = b.typeId.get(l.url);
      if (hit) visited.add(position.get(hit)!);
    }
    const label = (e: RawBundleEntry): string => (e.fullUrl !== null ? `'${e.fullUrl}'` : "");
    const afterScan = `${path}.entry[${b.raw.length + 1}]`; // (sic) i is the entry count here
    for (const at of backwardScan(edges, visited)) {
      const e = list[at];
      if (e.resource!.resourceType !== "Provenance") {
        if (isMessage) {
          issues.push({ severity: "information", path: afterScan, code: "informational", message: `Entry ${label(e)} isn't reachable by traversing forwards from the MessageHeader. Check that this is meant to be included (needed to process the message)` });
        } else {
          issues.push({ severity: "warning", path: afterScan, code: "invalid", message: `Entry ${label(e)} isn't reachable by traversing forwards from the Composition. Only Provenance is approved to be used this way (R4 section 3.3.1)` });
        }
      }
    }
    list.forEach((e, i) => {
      if (visited.has(i)) return;
      const p = `${path}.entry[${i + 1}]`; // (sic)
      if (isMessage) {
        issues.push({ severity: "warning", path: p, code: "informational", message: `Entry ${label(e)} isn't reachable by traversing links (forward or backward) from the MessageHeader, so its presence should be reviewed (is it needed to process the message?)` });
      } else {
        issues.push({ severity: "error", path: p, code: "informational", message: `Entry ${label(e)} isn't reachable by traversing links (forward or backward) from the Composition` });
      }
    });
  }

  // ------------------------------------------------------------------ resources

  /**
   * InstanceValidator.checkLang (IV:7380) + getValidationOptionsLanguage (IV:9296, tag 7.0.1): a resource's `language`
   * becomes the working language of its subtree (contained resources / Bundle entries inherit it unless they state
   * their own); it is the display language of code checks, ahead of ValidateOptions.languages (REVIEW_port_2 G4).
   */
  private async validateResource(rctx: ResourceCtx, path: string, extraProfiles: string[], issues: Issue[], depth: number): Promise<void> {
    const saved = this.workingLang;
    const savedUrls = this.containedUrls;
    const lang = typeof rctx.resource?.language === "string" ? rctx.resource.language.trim() : "";
    if (lang) this.workingLang = [lang];
    // validateResource, IV:9034-9042: the matchetype extension and its status
    const savedMt = this.inMatchetype;
    const mt = (Array.isArray(rctx.resource?.extension) ? rctx.resource.extension : []).find((x: any) => isObject(x) && x.url === "http://hl7.org/fhir/tools/StructureDefinition/matchetype");
    if (mt) {
      const mv = mt.valueCode ?? mt.valueString ?? mt.valueBoolean;
      this.inMatchetype = ["partial", "complete", "true", true].includes(mv);
      if (this.matchetypeStatus === "disallowed") {
        issues.push({ severity: "error", path, code: "invalid", message: "This resource is not allowed to be a matchetype resource (extension http://hl7.org/fhir/tools/StructureDefinition/matchetype is true)" });
      }
    } else {
      this.inMatchetype = false;
      if (this.matchetypeStatus === "required") {
        issues.push({ severity: "error", path, code: "invalid", message: "This resource is required to be a matchetype resource (extension http://hl7.org/fhir/tools/StructureDefinition/matchetype must be true)" });
      }
    }
    const contained = Array.isArray(rctx.resource?.contained) ? rctx.resource.contained : [];
    if (contained.length) this.containedUrls = new Set([...savedUrls, ...contained.map((c: any) => (isObject(c) && typeof c.url === "string" ? c.url : "")).filter(Boolean)]);
    try {
      await this.validateResourceBody(rctx, path, extraProfiles, issues, depth);
      // checkSpecials: StructureDefinitionValidator (InstanceValidator l. 7252)
      if (rctx.resource?.resourceType === "StructureDefinition") {
        const sdDeps = { fetch: (u: string) => this.resolver.fetchStructureDefinition(u), hashSet: javaHashSetToString };
        pushAll(issues, (await validateStructureDefinition(rctx.resource, path, sdDeps)) as Issue[]);
      }
    } finally {
      this.workingLang = saved;
      this.inMatchetype = savedMt;
      this.containedUrls = savedUrls;
    }
  }

  private async validateResourceBody(
    rctx: ResourceCtx,
    path: string,
    extraProfiles: string[],
    issues: Issue[],
    depth: number,
  ): Promise<void> {
    const resource = rctx.resource;
    const rt = resource.resourceType;
    if (typeof rt !== "string" || !rt) {
      issues.push({ severity: "error", path, code: "structure", message: "Resource has no resourceType" });
      return;
    }
    const base = await this.sdx(CORE + rt);
    if (!base) {
      issues.push({ severity: "error", path, code: "structure", message: `Unknown resource type '${rt}'` });
      return;
    }
    // InstanceValidator.checkPrimitive → isCanonicalURLElement (IV tag 7.0.1:3412): the defining url of a canonical resource
    if (CANONICAL_RESOURCES.has(rt) && typeof resource.url === "string" && resource.url !== "" && !isAbsoluteUrl(resource.url)) {
      const m = rctx.container ? `Canonical URLs in contained resources must be absolute URLs if present (${resource.url})` : `Canonical URLs must be absolute URLs if they are not fragment references (${resource.url})`;
      issues.push({ severity: "error", path: `${path}.url`, code: "invalid", message: m });
    }
    // InstanceValidator.checkSpecials (IV tag 7.0.1:7239 / 7251): CodeSystemValidator / ValueSetValidator
    if (rt === "CodeSystem" || rt === "ValueSet") {
      const deps = {
        fetchCodeSystem: async (u: string) => (this.resolver.fetchCodeSystem ? await this.resolver.fetchCodeSystem(u).catch(() => null) : null),
        fetchValueSet: (u: string) => this.vsHeader(u),
        codeStatus: async (system: string, code: string, version: string | null) => {
          const r = await this.codeCheck(system, code, null, version);
          if (r.status === "unknown-system") return { status: "unsupported" as const };
          return r.status === "invalid-code" && r.severity === "error" ? { status: "invalid" as const, message: r.message } : { status: "ok" as const };
        },
        allowExamples: this.allowExamples,
        isExampleUrl,
      };
      for (const x of rt === "CodeSystem" ? await validateCodeSystemResource(resource, path, deps) : await validateValueSetResource(resource, path, deps)) issues.push(x);
    }
    // InstanceValidator.checkSpecials: ConceptMapValidator
    if (rt === "ConceptMap") {
      const deps = {
        fetchCodeSystem: async (u: string) => (this.resolver.fetchCodeSystem ? await this.resolver.fetchCodeSystem(u).catch(() => null) : null),
        fetchValueSet: (u: string) => this.vsHeader(u),
        member: (vs: string, system: string, code: string) => this.member(vs, system, code),
      };
      for (const x of await validateConceptMapResource(resource, path, deps)) issues.push(x);
    }
    // InstanceValidator.checkSpecials l. 7247, 7257
    if (rt === "SearchParameter") {
      const deps = {
        fetchSearchParameter: async (u: string) => (this.resolver.fetchSearchParameter ? await this.resolver.fetchSearchParameter(u) : null),
        parentType: async (type: string) => {
          const baseUrl = (await this.sdx(CORE + type))?.sd?.baseDefinition;
          return typeof baseUrl === "string" ? baseUrl.slice(baseUrl.lastIndexOf("/") + 1) : null;
        },
      };
      for (const x of await validateSearchParameter(resource, path, deps)) issues.push(x);
    }
    if (rt === "ImplementationGuide") for (const x of validateImplementationGuide(resource, path)) issues.push(x);
    // InstanceValidator.checkSpecials l. 7233-7236
    if (rt === "Measure" || rt === "MeasureReport") {
      const fetchCanonical = async (t: "Measure" | "Library", u: string): Promise<Record<string, any> | null> => (this.resolver.fetchCanonical ? await this.resolver.fetchCanonical(t, u) : null);
      const deps = {
        fetchMeasure: (u: string) => fetchCanonical("Measure", u),
        fetchLibrary: (u: string) => fetchCanonical("Library", u),
        resolveSubject: async (ref: string) => this.resolveRefForFhirPath(ref, rctx) ?? (this.resolver.fetchReference ? await this.resolver.fetchReference(ref) : null),
        isResourceName: isCoreTypeName,
      };
      for (const x of await (rt === "Measure" ? validateMeasure(resource, path, deps) : validateMeasureReport(resource, path, deps))) issues.push(x);
    }
    // InstanceValidator.checkSpecials l. 7229-7232
    if (rt === "Questionnaire") {
      const deps = {
        fetchQuestionnaire: async (u: string) => (this.resolver.fetchQuestionnaire ? await this.resolver.fetchQuestionnaire(u) : null),
        fetchValueSet: (u: string) => this.vsHeader(u),
      };
      for (const x of await validateQuestionnaire(resource, path, deps)) issues.push(x);
    }
    if (rt === "QuestionnaireResponse") {
      const deps = {
        fetchQuestionnaire: async (u: string) => (this.resolver.fetchQuestionnaire ? await this.resolver.fetchQuestionnaire(u) : null),
        valueSetKnown: async (u: string) => !!(await this.vsHeader(u)),
        member: (vs: string, system: string | null, code: string) => this.member(vs, system, code),
        evaluate: (expression: string, response: Record<string, any>) => {
          const outcome = evaluateConstraint(response, "QuestionnaireResponse", expression, { resource: response, rootResource: response });
          return outcome.status === "pass" ? true : outcome.status === "fail" && !outcome.error ? false : undefined;
        },
        ucumCanonical: ucumCanonicalForm,
        assumeValidRestReferences: this.assumeValidRestReferences,
        isResourceName: isCoreTypeName,
      };
      for (const x of await validateQuestionnaireResponse(resource, path, deps)) issues.push(x);
    }
    // (parity v3) InstanceValidator.validateResourceRules: Language_XHTML_* warnings (resource language vs text.div)
    if (typeof resource.language === "string" && isObject(resource.text)) {
      for (const x of languageXhtmlIssues(resource.language, resource.text.div)) issues.push({ severity: x.severity, path, code: "business-rule", message: x.message });
    }
    // (parity v3, F18) InstanceValidator.validateResourceRules: security labels are a set (system#code); (sic) Java
    // reports at `.meta.profile[i]`
    if (isObject(resource.meta) && Array.isArray(resource.meta.security)) {
      const tags = new Set<string>();
      resource.meta.security.forEach((e: any, i: number) => {
        const s = `${isObject(e) && typeof e.system === "string" ? e.system : null}#${isObject(e) && typeof e.code === "string" ? e.code : null}`;
        if (tags.has(s)) issues.push({ severity: "error", path: `${path}.meta.profile[${i}]`, code: "business-rule", message: `Duplicate Security Label ${s}` });
        tags.add(s);
      });
    }
    const profiles: string[] = [];
    const metaProfiles = base.sd.kind === "resource" && isObject(resource.meta) && Array.isArray(resource.meta.profile) ? resource.meta.profile : [];
    for (const p of extraProfiles) if (p && !profiles.includes(p)) profiles.push(p);
    // Port of InstanceValidator.validateResource / startInner (meta.profile loop, 7.0.1):
    // each meta.profile is fetched as written — `url|version` resolves to that version
    // only (BaseWorkerContext.fetchResourceWithExceptionByVersion →
    // CanonicalResourceManager.getByPackage); the version is no longer stripped.
    metaProfiles.forEach((p: any) => {
      if (typeof p === "string" && p && !profiles.includes(p)) profiles.push(p);
    });
    if (rt === "Observation") {
      const url = impliedVitalSignProfile(resource.code);
      if (url && !profiles.includes(url)) profiles.push(url);
    }
    // InstanceValidator.validateResource(…, defn, …) (7.0.1, l. 6880-6910): the resource is validated against `defn` —
    // the requested profile (-profile / the element's type profile) when there is one, otherwise the core definition —
    // then against each meta.profile; the core definition is not a separate pass when a profile is requested
    const requested = extraProfiles.length ? await this.sdx(extraProfiles[0]) : null;
    if (requested && requested.type !== rt && requested.type.split("/").pop() !== rt) {
      // l. 9045-9050 (checkResourceName): VALIDATION_VAL_PROFILE_WRONGTYPE — and the resource is not validated at all
      issues.push({ severity: "error", path, code: "invalid", message: `Specified profile type was '${requested.type}' in profile '${this.versionedUrl(requested)}', but found type '${rt}'` });
      // the parser has run: its shape errors stand
      pushAll(issues, (await this.conformance(rctx, CORE + rt, path, depth)).filter(isParseIssue));
      return;
    }
    const defn = requested ? extraProfiles[0] : CORE + rt;
    if (base.sd.kind !== "resource") {
      // a datatype name parsed as the type: no children left but an id → ele-1 fails on the element
      const view = await this.parsedView(resource, base);
      if (!Object.keys(view).some((k) => k !== "resourceType" && k !== "id")) issues.push({ severity: "error", path, code: "invariant", message: ELE1_MESSAGE });
    }
    pushAll(issues, await this.conformance(rctx, defn, path, depth));
    for (const p of profiles) {
      if (p === CORE + rt || p === defn) continue;
      const sdx = await this.sdx(p);
      const noSnap = sdx ? null : await this.snapshotless(p);
      if (noSnap) {
        // The profile is installed but has no snapshot — differential only and the snapshot generation failed
        // (ContextUtilities.generateSnapshot throws, CTU:265-311, so the SD stays without one). startInner then
        // reports Validation_VAL_Profile_NoSnapshot as an error and does not validate against it (IV:7164-7180).
        issues.push({
          severity: "error",
          path,
          code: "structure",
          message: `StructureDefinition ${typeof noSnap.version === "string" && noSnap.version ? `${noSnap.url}|${noSnap.version}` : noSnap.url} has no snapshot - validation is against the snapshot, so it must be provided`,
          unchecked: { kind: "profile", canonical: p },
        });
        continue;
      }
      if (!sdx) {
        // Validation_VAL_Profile_Unknown (warning): the profile — or that version of
        // it — is not installed in the closure, so it is not checked. Marked
        // `unchecked` so the result can say the validation is incomplete.
        const idx = metaProfiles.findIndex((m: any) => m === p);
        issues.push({
          severity: "warning",
          path: idx >= 0 ? `${path}.meta.profile[${idx}]` : path,
          code: "not-found",
          message: `Profile reference '${p}' has not been checked because it could not be found`,
          unchecked: { kind: "profile", canonical: p },
        });
        continue;
      }
      // `Patient|4.0.1` is the base definition again (already checked above).
      if (sdx.sd === base.sd || (sdx.url === CORE + rt && sdx.sd.version === base.sd.version)) continue;
      if (sdx.type !== rt) {
        // validateResource / startInner (7.0.1) do not compare the profile's type with the resource's: the element model
        // (the properties the resource's own type defines — the parser dropped the others as unrecognized) is walked
        // against the profile
        pushAll(issues, await this.conformance({ ...rctx, resource: await this.parsedView(resource, base) }, p, path, depth));
        continue;
      }
      pushAll(issues, await this.conformance(rctx, p, path, depth));
      // validateResource l. 6916-6936 / 6982-6998: a profile's structuredefinition-imposeProfile extensions name
      // further profiles the resource is validated against (one level); one that cannot be resolved is
      // VALIDATION_VAL_PROFILE_DEPENDS_NOT_RESOLVED (warning)
      const exts: any[] = Array.isArray(sdx.sd.extension) ? sdx.sd.extension : [];
      for (const x of exts) {
        if (!isObject(x) || x.url !== IMPOSE_PROFILE_EXT) continue;
        const ip = typeof x.valueCanonical === "string" ? x.valueCanonical : typeof x.valueUri === "string" ? x.valueUri : null;
        if (!ip) continue;
        const isdx = await this.sdx(ip);
        if (!isdx) {
          const idx = metaProfiles.findIndex((m: any) => m === p);
          issues.push({
            severity: "warning",
            path: idx >= 0 ? `${path}.meta.profile[${idx}]` : path,
            code: "business-rule",
            message: `Profile ${this.versionedUrl(sdx)} identifies ${ip} as a dependency (using the extension http://hl7.org/fhir/StructureDefinition/structuredefinition-dependencies), but this profile could not be found`,
            unchecked: { kind: "profile", canonical: ip },
          });
          continue;
        }
        pushAll(issues, await this.conformance(rctx, ip, path, depth));
      }
    }
    // start l. 6946-6949: VersionUtilities.parseVersionUrl(null) throws for a meta.profile without a value, and
    // validator_cli gives no outcome for such a resource. It is not accepted here either.
    // NON-OFFICIAL TEXT: the JVM's NullPointerException message, not a Messages.properties entry.
    const shadow = isObject(resource.meta) && Array.isArray(resource.meta._profile) ? resource.meta._profile : [];
    shadow.forEach((x: unknown, i: number) => {
      const own = Array.isArray(resource.meta.profile) ? resource.meta.profile[i] : undefined;
      // (a shadow with only an id already fails ele-1)
      if (isObject(x) && Array.isArray(x.extension) && x.extension.length && (own === null || own === undefined)) issues.push({ severity: "error", path: `${path}.meta.profile[${i}]`, code: "exception", message: `Cannot invoke "String.length()" because "url" is null` });
    });
    // validateResource l. 7022-7040: the `global` profiles of the known ImplementationGuides for this resource type
    for (const ig of this.igs) {
      const vig = `${ig.url}${typeof ig.version === "string" && ig.version ? `|${ig.version}` : ""}`;
      for (const gl of Array.isArray(ig.global) ? ig.global : []) {
        if (!isObject(gl) || gl.type !== rt || typeof gl.profile !== "string") continue;
        if (!(await this.sdx(gl.profile))) {
          issues.push({ severity: "warning", path, code: "structure", message: `Global Profile reference '${gl.profile}' from IG ${vig} could not be resolved, so has not been checked` });
          continue;
        }
        pushAll(issues, await this.conformance(rctx, gl.profile, path, depth));
      }
    }
  }

  private parsedViews = new WeakMap<object, Record<string, any>>();
  private constraintViews = new WeakMap<object, Map<string, Record<string, any>>>();

  /** The properties of `resource` its own core definition knows (JsonParser keeps only those). */
  private async parsedView(resource: Record<string, any>, base: SdIndex): Promise<Record<string, any>> {
    const hit = this.parsedViews.get(resource);
    if (hit) return hit;
    const groups = base.children(base.root);
    const list = groups ? [...groups.values()] : [];
    // JsonParser: an unknown property is dropped, and so is an array where the (base) element is single
    const keep = (k: string, v: unknown): boolean => {
      const n = k.startsWith("_") ? k.slice(1) : k;
      if (n === "resourceType") return true;
      const g = list.find((x) => (x.name.endsWith("[x]") ? n.startsWith(x.name.slice(0, -3)) && n.length > x.name.length - 3 : x.name === n));
      if (!g) return false;
      const d = g.base || g.slices[0];
      const max = String((d?.base && d.base.max) ?? d?.max ?? "*");
      if (Array.isArray(v) && (max === "1" || max === "0")) return false;
      // JsonParser.parseChildItem l. 384-400: a choice is read through the base element's types, anything else is unknown
      if (g.name.endsWith("[x]") && !isConstraintDefinition(base)) {
        const suffix = n.slice(g.name.length - 3);
        const allowed: string[] = (d?.type || []).map(typeCodeOf);
        if (allowed.length && !allowed.includes("*") && !allowed.some((a) => a[0].toUpperCase() + a.slice(1) === suffix)) return false;
      }
      if (k.startsWith("_")) return true;
      const choiceType = g.name.endsWith("[x]") ? KNOWN_TYPE_SUFFIX.get(n.slice(g.name.length - 3)) : undefined;
      const types: string[] = choiceType ? [choiceType] : (d?.type || []).map(typeCodeOf);
      if (types.length === 1 && !isPrimitive(types[0]) && v !== null && typeof v !== "object") return false; // parseChildComplexInstance: no element
      return !(types.length === 1 && isPrimitive(types[0]) && (isObject(v) || (Array.isArray(v) && v.some(isObject))));
    };
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(resource)) if (keep(k, v)) out[k] = v;
    this.viewSource.set(out, resource);
    this.parsedViews.set(resource, out);
    return out;
  }

  /**
   * The element model of a complex node for FHIRPath, at any depth: what JsonParser dropped (an unknown property, an array
   * where the base element is single, an object for a primitive) is not there for an invariant. The same node when nothing
   * was dropped. Resources inside it have their own views; a contentReference element is not descended.
   */
  private async constraintView(node: Record<string, any>, sdx: SdIndex, el: Record<string, any>, typeCode: string): Promise<Record<string, any>> {
    let memo = this.constraintViews.get(node);
    if (!memo) this.constraintViews.set(node, (memo = new Map()));
    const hit = memo.get(typeCode);
    if (hit) return hit;
    let owner = sdx;
    let groups = sdx.children(el);
    if (!groups) {
      const own = isPrimitive(typeCode) || !typeCode ? null : await this.sdx(CORE + typeCode);
      if (!own) return node;
      owner = own;
      groups = own.children(own.root);
    }
    const list = groups ? [...groups.values()] : [];
    if (!list.length) return node;
    const out: Record<string, any> = {};
    let changed = false;
    for (const [k, v] of Object.entries(node)) {
      if (k === "resourceType") {
        out[k] = v;
        continue;
      }
      const n = k.startsWith("_") ? k.slice(1) : k;
      const g = list.find((x) => (x.name.endsWith("[x]") ? n.startsWith(x.name.slice(0, -3)) && n.length > x.name.length - 3 : x.name === n));
      if (!g) {
        changed = true;
        continue;
      }
      const d = g.base || g.slices[0];
      const max = String((d?.base && d.base.max) ?? d?.max ?? "*");
      if (Array.isArray(v) && (max === "1" || max === "0")) {
        changed = true;
        continue;
      }
      const choiceType = g.name.endsWith("[x]") ? KNOWN_TYPE_SUFFIX.get(n.slice(g.name.length - 3)) : undefined;
      const types: string[] = choiceType ? [choiceType] : (d?.type || []).map(typeCodeOf);
      if (!k.startsWith("_") && types.length === 1 && isPrimitive(types[0]) && (isObject(v) || (Array.isArray(v) && v.some(isObject)))) {
        changed = true;
        continue;
      }
      if (!k.startsWith("_") && types.length === 1 && !isPrimitive(types[0]) && v !== null && typeof v !== "object") {
        changed = true; // parseChildComplexInstance: THIS_PROPERTY_MUST_BE__NOT_, no element
        continue;
      }
      if (k.startsWith("_") || !d || d.contentReference || types.length !== 1 || isPrimitive(types[0])) {
        out[k] = v;
        continue;
      }
      // a value of a type the element does not have is its own type's element, not one of the profile's inline children
      const inline = !choiceType || ((d.type || []) as any[]).some((t) => typeCodeOf(t) === choiceType);
      const child = async (x: unknown): Promise<unknown> => (isObject(x) && typeof x.resourceType !== "string" ? this.constraintView(x, owner, inline ? d : { id: "", path: "" }, types[0]) : x);
      const y = Array.isArray(v) ? await Promise.all(v.map(child)) : await child(v);
      if (Array.isArray(v) ? (y as unknown[]).some((e, i) => e !== v[i]) : y !== v) changed = true;
      out[k] = y;
    }
    const view = changed ? out : node;
    if (changed) this.viewSource.set(out, node);
    memo.set(typeCode, view);
    return view;
  }

  /** Issues of `rctx.resource` against one StructureDefinition (memoised per resource object). */
  private conformance(rctx: ResourceCtx, url: string, path: string, depth: number): Promise<Issue[]> {
    let byUrl = this.conformCache.get(rctx.resource);
    if (!byUrl) {
      byUrl = new Map();
      this.conformCache.set(rctx.resource, byUrl);
    }
    let p = byUrl.get(url);
    // startInner l. 7153-7165: the tracker belongs to the Element, whichever view of it this is
    const element = this.sourceOf(rctx.resource);
    if (this.inProgress.get(element)?.has(url)) {
      // Re-entrant request (reference cycle): assume conformance for the inner check.
      return Promise.resolve([]);
    }
    if (!p) {
      let running = this.inProgress.get(element);
      if (!running) {
        running = new Set();
        this.inProgress.set(element, running);
      }
      running.add(url);
      const done = running;
      // validateResource / startInner: stack.resetIds() before each profile pass — element ids are tracked per pass
      const passCtx: ResourceCtx = { ...rctx, ids: new Map() };
      p = (async () => {
        const sdx = await this.sdx(url);
        const out: Issue[] = [];
        if (!sdx) return out;
        // (v17.5) local hyperlinks of the narrative must resolve (the HL7 validator's XHTML check) — part of every
        // conformance check of the resource, so a profile match (slice by resolve() profile) sees it too
        const res0 = rctx.resource;
        if (isObject(res0.text) && typeof res0.text.div === "string") {
          // (parity v3) JsonParser.parseChildPrimitiveInstance reads the div with XhtmlParser (xml mode): a parse
          // failure is ERROR_PARSING_XHTML_ and leaves no xhtml node (no XhtmlValidator / link checks); then
          // InstanceValidator.checkXhtml: XhtmlValidator.validate + checkReferences
          // (the parse / XhtmlValidator issues are reported for every Narrative by the Narrative type check)
          const divPath = `${ROOT_TOKEN}.text.div`;
          const px = parseXhtml(res0.text.div);
          if (px.div) {
            for (const m of narrativeLinkProblems(res0.text.div, this.narrativeAnchors(rctx))) {
              out.push({ severity: "error", path: divPath, code: "invalid", message: `Hyperlink '${m.href}' at '${m.at}' for '${m.text}' does not resolve` });
            }
          }
        }
        await this.validateItemAgainst(
          sdx,
          sdx.root,
          {
            value: rctx.resource,
            ext: undefined,
            key: rctx.resource.resourceType,
            path: ROOT_TOKEN,
            typeCode: rctx.resource.resourceType,
            lp: [rctx.resource.resourceType],
          },
          rctx.resource.resourceType,
          passCtx,
          out,
          depth + 1,
          true,
        );
        if (rctx.container === null) this.checkContainedReferences(rctx.resource, out); // once per validateResource, whatever defn is
        return out;
      })().finally(() => done.delete(url));
      byUrl.set(url, p);
    }
    // Results are cached with a root token so the same resource reached by
    // another route (e.g. through a reference) reports at its real location.
    return p.then((list) =>
      list.map((i) => {
        // Messages that quote their location (parser-stage "(at …)" / "(key at …)") carry the token too.
        let message = i.message.includes(ROOT_TOKEN) ? i.message.split(ROOT_TOKEN).join(path) : i.message;
        // validateContains l. 7516: stack.pathComment(type/id) on an embedded resource
        const r = rctx.resource;
        const comment = path.includes(".") ? `/*${this.typeOfResource(r)}/${typeof r.id === "string" ? r.id : "null"}*/` : "";
        if (message.includes(PLIST_TOKEN)) message = expandPlist(message, path, comment);
        if (message.includes(LITERAL_ROOT_TOKEN)) {
          const outer = path.startsWith(ROOT_TOKEN) ? LITERAL_ROOT_TOKEN + path.slice(ROOT_TOKEN.length) : path;
          message = message.split(LITERAL_ROOT_TOKEN).join(outer + comment);
        }
        return i.path.startsWith(ROOT_TOKEN) ? { ...i, path: path + i.path.slice(ROOT_TOKEN.length), message } : message === i.message ? i : { ...i, message };
      }),
    );
  }

  /** Records a '#…' reference made from `rctx.resource` (its INTERNAL_REFERENCES_NAME set). */
  private noteInternalRef(rctx: ResourceCtx, ref: string): void {
    if (!ref.startsWith("#")) return;
    let set = this.internalRefs.get(rctx.resource);
    if (!set) {
      set = new Set();
      this.internalRefs.set(rctx.resource, set);
    }
    set.add(ref.slice(1));
  }

  /**
   * The internal references of a resource: those met by the walk, plus the narrative's a/@href (not '#') and
   * img/@src (InstanceValidator.checkReferences / checkImageSources, l. 4307-4315 / 5240-5251).
   */
  private internalRefsOf(resource: Record<string, any>): Set<string> {
    const out = new Set(this.internalRefs.get(resource) ?? []);
    const divs: string[] = [];
    // checkReferences / checkImageSources run on every xhtml element of the resource, not only Resource.text
    const scan = (o: unknown): void => {
      if (Array.isArray(o)) o.forEach(scan);
      else if (isObject(o) && (o === resource || typeof o.resourceType !== "string")) for (const [k, x] of Object.entries(o)) typeof x === "string" ? k === "div" && divs.push(x) : scan(x);
    };
    scan(resource);
    for (const m of divs.join(" ").matchAll(/<(a|img)\b[^>]*?\s(href|src)\s*=\s*("([^"]*)"|'([^']*)')/gi)) {
      const v = m[4] ?? m[5] ?? "";
      if (!v.startsWith("#")) continue;
      if (m[1].toLowerCase() === "a" && v === "#") continue;
      out.add(v.slice(1));
    }
    return out;
  }

  /**
   * InstanceValidator.checkContainedReferences (7.0.1, l. 9062-9113): the validator never evaluates dom-3
   * (checkInvariant l. 8868-8872) but enforces it in code once the resource is validated — every contained
   * resource must be referenced from the container (directly, or through other contained resources that are), or
   * itself refer to the container ('#'). CONTAINED_ORPHAN_DOM3, at the contained resource.
   */
  private checkContainedReferences(resource: Record<string, any>, out: Issue[]): void {
    const contained: any[] = Array.isArray(resource.contained) ? resource.contained : [];
    if (!contained.length || !contained.every((c) => isObject(c) && typeof c.resourceType === "string")) return; // allDone
    const baseRefs = this.internalRefsOf(resource);
    const refs = contained.map((c) => this.internalRefsOf(c));
    const referenced = (i: number, ignore: Set<number>): boolean => {
      const id = contained[i].id;
      if (typeof id === "string" && baseRefs.has(id)) return true;
      if (refs[i].has("")) return true;
      for (let j = 0; j < contained.length; j++) {
        if (j === i || ignore.has(j)) continue;
        if (typeof id === "string" && refs[j].has(id) && referenced(j, new Set([...ignore, j]))) return true;
      }
      return false;
    };
    for (let i = 0; i < contained.length; i++) {
      if (referenced(i, new Set())) continue;
      out.push({
        severity: "error",
        path: `${ROOT_TOKEN}.contained[${i}]`,
        code: "invalid",
        message: `The contained resource '${contained[i].id ?? "null"}' is not referenced to from elsewhere in the containing resource nor does it refer to the containing resource (dom-3)`,
      });
    }
  }

  // ------------------------------------------------------------------ elements

  /**
   * Validate one value (`item`) against element `el` of `sdx`, as type `typeCode`.
   * `isResourceRoot` marks the root element of a resource definition.
   */
  private async validateItemAgainst(
    sdx: SdIndex,
    el: Record<string, any>,
    item: Item,
    typeCode: string,
    rctx: ResourceCtx,
    issues: Issue[],
    depth: number,
    isResourceRoot = false,
  ): Promise<void> {
    if (depth > MAX_DEPTH) {
      issues.push(tooDeep(item.path));
      return;
    }
    if (item.typeUnknown) return;
    if (item.profileType && !item.parsedValue && item.actualType && !isPrimitive(item.actualType) && !isPrimitive(typeCode) && isObject(item.value)) {
      // what the profile's type is checked against is the parser's tree of the written type: `value` in a CodeableConcept is not there
      const own = await this.sdx(CORE + item.actualType);
      const value = own ? await this.constraintView(item.value, own, own.root, item.actualType) : item.value;
      await this.validateItemAgainst(sdx, el, { ...item, value, parsedValue: true }, typeCode, rctx, issues, depth, isResourceRoot);
      return;
    }
    if (item.profileType && !isPrimitive(typeCode) && item.value !== null && item.value !== undefined && typeof item.value !== "object") {
      // a primitive written where the profile wants a complex type: an element with a value and no children of that type,
      // so the required ones are missing and the type's invariants see that value
      this.parsedPrimitiveShape(item.value, item, item.jpath ?? item.path, issues);
      await this.validateItemAgainst(sdx, el, { ...item, value: {}, primitiveValue: item.value }, typeCode, rctx, issues, depth, isResourceRoot);
      // the core Extension pass of checkExtension sees value[x] as the type it is written as
      if (item.actualType && isPrimitive(item.actualType) && String(el.path) === "Extension.value[x]") this.checkPrimitiveValue(item.numText ?? String(item.value), item, item.actualType, {}, sdx.sd, issues);
      return;
    }
    const v = item.value;

    // InstanceValidator.validateElement l. 7711-7722: DUPLICATE_ID — an element id already used by another element of
    // the resource in this pass (a reset point, the resource root, is not recorded); StructureDefinition.snapshot
    // starts a new id scope (ids are duplicated in snapshot and differential)
    // An embedded resource (contained, Bundle.entry.resource …) is validated on a reset stack (validateContains
    // l. 7547 / checkChildByDefinition l. 8169: stack.resetIds()): its own id is neither checked nor recorded.
    const idHolder = isObject(v) ? (typeof v.resourceType === "string" || this.unparsed.has(v) ? null : v) : isPrimitive(typeCode) && isObject(item.ext) ? item.ext : null;
    if (idHolder && typeof idHolder.id === "string" && idHolder.id !== "" && rctx.ids) {
      const seen = rctx.ids.get(idHolder.id);
      if (seen !== undefined && seen !== idHolder) {
        issues.push({ severity: "error", path: item.path, code: "business-rule", message: `Duplicate id value '${idHolder.id}'` });
      }
      if (!isResourceRoot) rctx.ids.set(idHolder.id, idHolder);
    }
    if (el.path === "StructureDefinition.snapshot" && rctx.ids) rctx = { ...rctx, ids: new Map() };

    if (isPrimitive(typeCode)) {
      if (item.profileType && isObject(v)) await this.complexAsPrimitive(v, item, typeCode, issues);
      else this.checkPrimitive(v, item, typeCode, el, issues, sdx.sd);
      if (item.ext !== undefined && item.ext !== null) {
        await this.validatePrimitiveExtensions(item, el, rctx, issues, depth);
        // InstanceValidator.checkChildByDefinition l. 8164-8176: when the profile constrains the element's children
        // inline (extension slices on a primitive …) the element is validated against those too, after its type
        if (sdx.hasChildren(el) && isObject(item.ext)) {
          await this.walkChildren(sdx, el, { ...item, value: item.ext, ext: undefined }, rctx, issues, depth, false, null, true);
        }
      }
      if (v === null || v === undefined) {
        // (parity v3 round 5) no value and a shadow holding no extension (`[…, null]` + `_x: [null, {"id": …}]`):
        // ele-1 `hasValue() or (children().count() > id.count())` fails — the id is the only child (evaluator corpus:
        // Practitioner.name.prefix[1], Patient.name.given[1] …; for meta.profile validator_cli 7.0.1 throws instead
        // (InstanceValidator.validateResource reads the null url), where an error is required all the same)
        const ext = item.ext;
        // xhtml has no extension element: an extension on `_div` is not a child of the element
        const xhtml = typeCode === "xhtml";
        // XML: an element with only an id attribute is the same element (patient-id-only)
        if (isObject(ext) && (!this.xmlSource || typeof ext.id === "string")) {
          // a `value` the JSON parser took as a child counts as one (ILLEGAL_PROPERTY, validatePrimitiveExtensions)
          const hasExtensions = !xhtml && ((Array.isArray(ext.extension) && ext.extension.length > 0) || ext.value !== undefined);
          if (!hasExtensions) issues.push({ severity: "error", path: item.path, code: "invariant", message: ELE1_MESSAGE });
          // checkPrimitive l. 3238 (TYPE_SPECIFIC_CHECKS_DT_PRIMITIVE_VALUEEXT): e.hasChildren() — an id is a child
          if (!hasExtensions && typeof ext.id !== "string") issues.push({ severity: "error", path: item.path, code: "invalid", message: PRIMITIVE_VALUEEXT_MESSAGE });
          // IV:9029: isValidId(null) is false; the message prints the null
          if (isObject(el.base) && el.base.path === "Resource.id") issues.push({ severity: "error", path: item.path, code: "invalid", message: "Invalid Resource id: Invalid Characters ('null')" });
        }
        // funcHtmlChecks1 / 2 on an element without an xhtml node: both fail (txt-1, txt-2); "" parses to no node
        await this.checkConstraints(sdx, el, xhtml ? { ...item, value: "" } : item, typeCode, rctx, issues);
        return;
      }
      if (typeof v === "string") {
        // InstanceValidator.checkPrimitive l. 3369-3418 → validateReference l. 3946-3947: a '#…' uri / url / canonical
        // / oid / uuid (not a defining canonical url, not Bundle.entry.fullUrl) is an internal reference
        const p = String(el.path || "");
        if (["uri", "url", "canonical", "oid", "uuid"].includes(typeCode) && p !== "Bundle.entry.fullUrl" && !/^[A-Z][A-Za-z]*\.url$/.test(p)) {
          this.noteInternalRef(rctx, v);
          if (v.startsWith("#") && typeCode !== "uuid") this.checkInternalUrl(v, item, typeCode, el, rctx, issues);
        }
        await this.checkUri(v, item, typeCode, el, issues);
      }
      this.checkFixedPattern(el, v, item, sdx, issues, true);
      await this.checkBinding(el, v, typeCode, item, issues, null);
      await this.checkConstraints(sdx, el, item, typeCode, rctx, issues);
      return;
    }

    // Embedded resource (contained, Bundle.entry.resource, Parameters.parameter.resource ...)
    if (!isResourceRoot && (typeCode === "Resource" || typeCode === "DomainResource" || /^[A-Z]/.test(typeCode) && !COMPLEX_TYPES.includes(typeCode) && !(await this.isDatatype(typeCode)))) {
      if (!isObject(v)) {
        issues.push({ severity: "error", path: item.path, code: "structure", message: "The value must be a JSON object (a resource)" });
        return;
      }
      if (this.unparsed.has(v)) {
        // JsonParser.parseResource l. 770-786 (fatal), then validateContains / validateResource of an empty `Resource`
        // element: Resource_RES_ID_Missing when the entry's id status is REQUIRED; nothing else (no children)
        const rtv = v.resourceType;
        issues.push({
          severity: "fatal",
          path: item.path,
          code: "invalid",
          message:
            rtv === undefined
              ? "Unable to find resourceType property"
              : typeof rtv !== "string"
                ? `The JSON element 'resourceType' has the wrong JSON type: ${describeJsonType(rtv)}`
                : `Contained resource does not appear to be a FHIR resource (unknown name '${rtv}')`,
        });
        if (this.idRequiredForUnparsed(el, v, rctx)) issues.push({ severity: "error", path: item.path, code: "invalid", message: "Resource requires an id, but none is present" });
        return;
      }
      // Port of InstanceValidator.validateContains l. 7502-7519 / 7633-7648 (+ checkChildByDefinition l. 7876-7895):
      // the type the resource is validated as is the first of the element's types that is Resource or the
      // resource's own type, and only its profiles apply
      const resourceName = typeof v.resourceType === "string" ? v.resourceType : "";
      const elTypes: any[] = Array.isArray(el.type) ? el.type : [];
      let typeForResource: any = null;
      const bt: string[] = [];
      for (const t of elTypes) {
        const c = typeCodeOf(t);
        bt.push(c);
        if (c === "Resource" || c === resourceName) {
          typeForResource = t;
          break;
        }
      }
      if (resourceName && elTypes.length && !isResourceRoot) {
        if (elTypes.length === 1 && typeCodeOf(elTypes[0]) !== resourceName && !(await this.isAbstractType(typeCodeOf(elTypes[0])))) {
          // EXTENSION_PROF_TYPE (checkChildByDefinition, one non-abstract type)
          issues.push({
            severity: "error",
            path: item.path,
            code: "structure",
            message: `The Profile '${sdx.url}${sdx.sd?.version ? `|${sdx.sd.version}` : ""}' definition allows for the type ${typeCodeOf(elTypes[0])} but found type ${resourceName}`,
          });
        }
        if (!typeForResource) {
          issues.push({ severity: "error", path: item.path, code: "informational", message: `The type '${resourceName}' is not valid - no resources allowed here (allowed = ${bt.join(", ")})` });
          return;
        }
        if (!(await this.isValidResourceType(resourceName, typeForResource))) {
          const types: string[] = [];
          for (const u of typeForResource.profile || []) {
            const t = await this.sdx(String(u));
            if (t && !types.includes(t.type)) types.push(t.type);
          }
          issues.push({
            severity: "error",
            path: item.path,
            code: "informational",
            message:
              types.length === 1
                ? `The type '${resourceName}' is not valid - must be ${types[0]} (allowed = {2})`
                : `The type '${resourceName}' is not valid - must be one of ${types.length} types: [${types.join(", ")}]`,
          });
          return;
        }
      }
      const profiles: string[] = [];
      for (const t of typeForResource ? [typeForResource] : elTypes) for (const p of t.profile || []) if (typeof p === "string" && p) profiles.push(p);
      const isContained = /\.contained$/.test(String(el.path || ""));
      if (isContained) {
        // InstanceValidator.validateContains l. 7533-7545: RESOURCE_DUPLICATE_CONTAINED_ID, in the container's id scope,
        // once per contained resource in the whole run (validator_contained_Id): only the first validation of the
        // container sees it, and the message stays in that profile's outcomes (startInner's tracker, IV:7157-7165 =
        // conformance()). It is reported when the resource is validated against that same profile for real, and stays
        // in a slice / reference trial against any other. validateResource l. 9017: a contained resource's id is
        // REQUIRED (RESOURCE_RES_ID_MISSING)
        const cid = v.id;
        if (rctx.ids && !this.containedIdChecked.has(v)) {
          this.containedIdChecked.add(v);
          if (typeof cid === "string") {
            if (rctx.ids.has("!" + cid)) issues.push({ severity: "error", path: item.path, code: "duplicate", message: `Duplicate ID for contained resource: ${cid}` });
            rctx.ids.set("!" + cid, v);
          }
        }
        if (v.id === undefined && v._id === undefined) issues.push({ severity: "error", path: item.path, code: "invalid", message: "Resource requires an id, but none is present" });
      }
      // a nested Bundle (entry / contained / parameter) resolves its own entries' references and gets the
      // BundleValidator rules at its path (InstanceValidator.checkSpecials → BundleValidator.validateBundle)
      const nested = v.resourceType === "Bundle" ? this.bundleCtx(v, item.path) : null;
      const child: ResourceCtx = {
        resource: v,
        container: isContained ? rctx.resource : null,
        root: rctx.root,
        bundle: nested ?? rctx.bundle,
        entry: nested ? null : this.entryFor(v, rctx, true),
      };
      if (nested) {
        await this.validateResource(child, item.path, profiles, issues, depth);
        await this.validateBundleRules(nested, item.path, issues);
        return;
      }
      if (profiles.length > 1) {
        // Port of InstanceValidator.validateContains (7.0.1), several type profiles: the resource has to conform to
        // one of them. Each is validated alone; the per-profile issues are not reported — none matching is
        // BUNDLE_BUNDLE_ENTRY_MULTIPLE_PROFILES_NO_MATCH (+ one _NO_MATCH_REASON hint per profile), more than one
        // matching is the _MULTIPLE_MATCHES hint.
        const ep = String(el.path || "");
        const special = isContained ? "contained" : /\.entry\.resource$/.test(ep) ? "entry" : /\.response\.outcome$/.test(ep) ? "outcome" : /\.parameter\.resource$/.test(ep) ? "parameter" : "??";
        const typeRef = (el.type || []).find((t: any) => typeCodeOf(t) === "Resource" || typeCodeOf(t) === v.resourceType) ?? (el.type || [])[0];
        const trials: Issue[][] = [];
        const matchedUrls: string[] = [];
        for (const p of profiles) {
          if (!(await this.sdx(p))) {
            issues.push({ severity: "error", path: item.path, code: "invalid", message: `No profile found for ${special} resource of type '${p}'` });
            trials.push([]);
            continue;
          }
          const trial: Issue[] = [];
          await this.validateResource({ ...child }, item.path, [p], trial, depth);
          trials.push(trial);
          if (!trial.some((i) => i.severity === "error" || i.severity === "fatal")) matchedUrls.push(p);
        }
        if (matchedUrls.length === 0) {
          issues.push({
            severity: "error",
            path: item.path,
            code: "invalid",
            message: `The ${special} resource did not match any of the allowed profiles (Type ${typeRef ? typeCodeOf(typeRef) : "Resource"}: ${profiles.join(", ")})`,
          });
          profiles.forEach((p, i) => {
            const errs = trials[i].filter((x) => x.severity === "error" || x.severity === "fatal").map((x) => x.message);
            const reason = errs.length > 1 ? `${errs.slice(0, -1).join(", ")} and ${errs[errs.length - 1]}` : errs.join("");
            issues.push({ severity: "information", path: item.path, code: "invalid", message: `The ${special} resource did not match the profile ${p} because: ${reason}` });
          });
        } else if (matchedUrls.length > 1) {
          issues.push({ severity: "information", path: item.path, code: "invalid", message: `The ${special} resource matched more than one of the allowed profiles (${matchedUrls.join(", ")})` });
        }
        return;
      }
      if (profiles.length === 1 && !(await this.sdx(profiles[0]))) {
        // Port of InstanceValidator.checkChildByDefinition (Validation_VAL_Unknown_Profile) + validateContains
        // (Bundle_BUNDLE_Entry_NoProfile_EXPL, 7.0.1): the one type profile cannot be resolved — both errors, and the
        // resource is not validated further
        const ep = String(el.path || "");
        const special = isContained ? "contained" : /\.entry\.resource$/.test(ep) ? "entry" : /\.response\.outcome$/.test(ep) ? "outcome" : /\.parameter\.resource$/.test(ep) ? "parameter" : "??";
        issues.push({ severity: "error", path: item.path, code: "structure", message: `Unknown profile ${profiles[0]}`, unchecked: { kind: "profile", canonical: profiles[0] } });
        issues.push({ severity: "error", path: item.path, code: "invalid", message: `Specified profile ${profiles[0]} not found for ${special} resource of type '${special}'` });
        return;
      }
      await this.validateResource(child, item.path, profiles, issues, depth);
      return;
    }

    if (!isObject(v)) {
      // a value the parser accepted as its own (base) type, validated as the profile's type: no JSON shape error here, and
      // to that type it has no content (jar alone: No code provided on a valueInteger bound as a CodeableConcept)
      if (item.profileType) {
        await this.checkBinding(el, {}, typeCode, item, issues, null);
        return;
      }
      issues.push({
        severity: "error",
        path: item.jpath ?? item.path,
        code: "structure",
        message: `The property ${item.key} must be ${item.inList ? "an Array" : "an Object"}, not ${describeJson(v)} (at ${item.jpath ?? item.path})`,
      });
      return;
    }
    if (Object.keys(v).length === 0 && !isResourceRoot && item.primitiveValue === undefined) {
      // (parity v2) JsonParser.checkObject (7.0.1): OBJECT_MUST_HAVE_SOME_CONTENT, and the (empty) element is kept —
      // validation goes on, so its required children are reported as missing.
      // XML: XmlParser keeps the empty element (its parse error, if any, comes from fhirXml.ts) and ele-1 fails.
      // (parity v3 round 5) JSON: ele-1 (`hasValue() or (children().count() > id.count())`) fails on the kept empty
      // element as well — except for a choice element: JsonParser.parseChildItem (l. 400-408) builds it on the [x]
      // property, and FHIRPathEngine.funcHasValue (l. 6208) reads such an element as having a value. Evaluator
      // corpus: every non-choice `{}` (extension, meta, text, code, subject, category[n] …) carries ele-1 in
      // validator_cli 7.0.1, no `value[x]` / `dose[x]` / `effective[x]` `{}` does.
      // An object the parser emptied (dropBadPrimitivesIn) had content in the source: checkObject stays quiet, the
      // element is the same empty element for ele-1.
      if (!this.xmlSource && !this.parserEmptied.has(v)) issues.push({ severity: "error", path: item.path, code: "invalid", message: "Object must have some content" });
      if (this.xmlSource || !/\[x\]$/u.test(String(el.path ?? ""))) issues.push({ severity: "error", path: item.path, code: "invariant", message: ELE1_MESSAGE });
    }

    // Port of InstanceValidator.checkChildByDefinition (7.0.1), several profiles on the element's one type: the
    // value is validated against each; one without errors → its issues; none → Validation_VAL_Profile_NoMatch and
    // every profile's issues; several → Validation_VAL_Profile_MultipleMatches (warning) and the matching ones'.
    // Issues on the element itself that do not depend on the profile (its binding, fixed value …) are not profile
    // errors, so they are taken from a run against the bare type.
    const typeProfiles: string[] =
      (el.type || []).length === 1 && !isResourceRoot && !sdx.hasChildren(el) && typeCode !== "Extension" ? ((el.type[0].profile || []) as unknown[]).map(String) : [];
    if (typeProfiles.length > 1) {
      const key = (i: Issue): string => `${i.severity}|${i.path}|${i.message}`;
      const bare: Issue[] = [];
      this.noInvariantMemo++;
      await this.validateItemAgainst(sdx, { ...el, type: [{ ...el.type[0], profile: undefined }] }, item, typeCode, rctx, bare, depth);
      this.noInvariantMemo--;
      const own = new Set(bare.filter((i) => i.path === item.path).map(key));
      const good: Array<[string, Issue[]]> = [];
      const bad: Array<[string, Issue[]]> = [];
      for (const p of typeProfiles) {
        if (!(await this.sdx(p))) {
          issues.push({ severity: "error", path: item.path, code: "structure", message: `Unknown profile ${p}`, unchecked: { kind: "profile", canonical: p } });
          continue;
        }
        const trial: Issue[] = [];
        await this.validateItemAgainst(sdx, { ...el, type: [{ ...el.type[0], profile: [p] }] }, item, typeCode, rctx, trial, depth);
        const errs = trial.filter((i) => (i.severity === "error" || i.severity === "fatal") && !own.has(key(i)));
        (errs.length ? bad : good).push([p, trial]);
      }
      // l. 8144-8158: setMessage on the message object, over the HashMap's key order: an object two profiles share
      // (an executed invariant) collects both tags
      const tagged = async (p: string, list: Issue[]): Promise<Issue[]> => {
        const psdx = await this.sdx(p);
        const tag = ` (validating against ${psdx?.url ?? p}${psdx?.sd?.version ? `|${psdx.sd.version}` : ""} [${psdx?.sd?.name ?? ""}])`;
        for (const i of list) if (!own.has(key(i))) i.message += tag;
        return list;
      };
      if (good.length === 1) {
        issues.push(...good[0][1]);
      } else if (good.length === 0) {
        issues.push({ severity: "error", path: item.path, code: "structure", message: `Unable to find a match for the specified profile among choices: ${[...typeProfiles].sort().join(", ")}` });
        for (const p of javaHashMapOrder(bad.map(([u]) => u))) issues.push(...(await tagged(p, bad.find(([u]) => u === p)![1])));
      } else {
        const n = good.length;
        issues.push({ severity: "warning", path: item.path, code: "structure", message: `Found multiple matching profiles among ${n} choice${n === 1 ? "" : "s"}: ${good.map(([p]) => p).sort().join(", ")}` });
        for (const p of javaHashMapOrder(good.map(([u]) => u))) issues.push(...(await tagged(p, good.find(([u]) => u === p)![1])));
      }
      return;
    }

    // Which definition supplies the children?
    let typeProfilePass: SdIndex | null = null;
    let typeProfilePassEl: Record<string, any> | null = null;
    let childSdx = sdx;
    let childEl: Record<string, any> = el;
    const typeRootConstraints: Array<[SdIndex, Record<string, any>]> = [];
    if (!sdx.hasChildren(el)) {
      if (el.contentReference) {
        const target = sdx.byId.get(String(el.contentReference).replace(/^.*#/, ""));
        if (target) childEl = target;
      } else if (!isResourceRoot) {
        const typeProfile = this.typeProfileFor(el, typeCode);
        let tsdx: SdIndex | null = null;
        if (typeCode === "Extension" && !typeProfile) {
          tsdx = await this.extensionDefinition(sdx, item, issues);
        } else {
          tsdx = typeProfile ? await this.scopedSdx(typeProfile, sdx) : null;
          if (typeProfile && !tsdx) {
            // Port of InstanceValidator.checkChildByDefinition (7.0.1) l. 8104-8113: a type profile that cannot be
            // resolved — with or without a version — is Validation_VAL_Unknown_Profile (error). The value is still
            // checked against the core datatype.
            issues.push({
              severity: "error",
              path: item.path,
              code: "structure",
              message: `Unknown profile ${typeProfile}`,
              unchecked: { kind: "profile", canonical: typeProfile },
            });
          }
          if (!tsdx) tsdx = await this.sdx(CORE + typeCode);
        }
        if (tsdx) {
          childSdx = tsdx;
          // checkChildByDefinition l. 7966-7972: `profile#element` (EXT_PROFILE_ELEMENT) validates against that element
          const typeRef = (el.type || []).find((t: any) => typeCodeOf(t) === typeCode);
          childEl = typeProfile && typeRef ? profileElementOf(typeRef, 0, tsdx) : tsdx.root;
          typeRootConstraints.push([tsdx, childEl]);
          if (typeCode === "Extension" && item.host && tsdx.type === "Extension" && tsdx.url !== CORE + "Extension") {
            await this.checkExtensionContext(tsdx, item.host, rctx, issues, item.value);
            // InstanceValidator.checkExtension: EXTENSION_EXT_MODIFIER_Y / _N (the extension definition's root isModifier)
            const asModifier = /(^|\.)modifierExtension(\[\d+\])?$/.test(item.path);
            const defModifier = tsdx.root?.isModifier === true;
            const url = isObject(item.value) ? String(item.value.url) : "";
            if (asModifier && !defModifier) {
              issues.push({ severity: "error", path: `${item.path}[url='${url}']`, code: "structure", message: `The Extension '${url}' must not be used as a modifierExtension (it's a regular extension)` });
            } else if (!asModifier && defModifier) {
              issues.push({ severity: "error", path: `${item.path}[url='${url}']`, code: "structure", message: `The Extension '${url}' must not be used as an extension (it's a modifierExtension)` });
            }
          }
        }
      }
    } else if (!isResourceRoot && /^[A-Z]/.test(typeCode) && typeCode !== "BackboneElement" && typeCode !== "Element") {
      // Profile defines the children; datatype-level invariants still apply (ref-1, per-1 ...).
      const tsdx = await this.sdx(CORE + typeCode);
      if (tsdx) typeRootConstraints.push([tsdx, tsdx.root]);
      // InstanceValidator.checkChildByDefinition l. 7880-7900 / 8094-8113 / 8160-8176: a type profile is validated as
      // well as the inline children (one profile of the element's single type, or of the matched choice type
      // except Reference); an unresolvable one is Validation_VAL_Unknown_Profile
      const tr = (el.type || []).find((t: any) => typeCodeOf(t) === typeCode);
      const profs: string[] = tr && Array.isArray(tr.profile) ? tr.profile.map(String) : [];
      if (profs.length === 1 && !((el.type || []).length > 1 && typeCode === "Reference")) {
        const psdx = await this.scopedSdx(profs[0], sdx);
        if (!psdx) {
          issues.push({ severity: "error", path: item.path, code: "structure", message: `Unknown profile ${profs[0]}`, unchecked: { kind: "profile", canonical: profs[0] } });
        } else {
          typeProfilePass = psdx;
          typeRootConstraints.push([psdx, psdx.root]);
        }
      } else if (tsdx && !profs.length && typeCode !== "Extension" && (el.type || []).length <= 1) {
        // checkChildByDefinition l. 8094 + 8165-8171: p = the type's definition is validated (validateElement) and then
        // the inline children (l. 8174-8182), both: Narrative.div's cardinality and txt-1 / txt-2 under a profile that
        // constrains `text.div`
        typeProfilePass = tsdx;
      }
    }

    if (sdx.hasChildren(el) && !isResourceRoot && (typeCode === "BackboneElement" || typeCode === "Element") && (el.type || []).length === 1 && (el.type[0].profile || []).length) {
      // checkChildByDefinition l. 7965-7973: an abstract-typed element's profile (`profile#element`) applies as well
      const psdx = await this.sdx(String(el.type[0].profile[0]));
      if (psdx) {
        typeProfilePass = psdx;
        typeProfilePassEl = profileElementOf(el.type[0], 0, psdx);
      }
    }

    // InstanceValidator.validateElement (7.0.1): a choice element whose profile constrains its children (e.g. only an
    // extension of effective[x]) while several types stay open — the actual type's children are merged in
    let merge: { sdx: SdIndex; el: Record<string, any> } | null = null;
    if (childEl === el && sdx.hasChildren(el) && (el.type || []).length > 1 && /^[A-Z]/.test(typeCode) && !isResourceRoot) {
      const tsdx = await this.sdx(CORE + typeCode);
      if (tsdx) merge = { sdx: tsdx, el: tsdx.root };
    }
    if (typeProfilePass) await this.walkChildren(typeProfilePass, typeProfilePassEl ?? typeProfilePass.root, item, rctx, issues, depth, false, null);
    await this.walkChildren(childSdx, childEl, item, rctx, issues, depth, isResourceRoot, merge);
    if (typeCode === "Extension" && childSdx.type === "Extension" && childSdx.url !== CORE + "Extension") {
      // checkExtension l. 2655-2669: a simple extension (value[x] min > 0) with no parsed value
      const ved = childSdx.byId.get("Extension.value[x]");
      const hasValue = Object.keys(v).some((k) => /^_value[A-Z]/.test(k) || (/^value[A-Z]/.test(k) && KNOWN_TYPE_SUFFIX.has(k.slice("value".length)) && (typeof v[k] === "object" ? isComplexChoiceValue(k) : !isComplexChoiceValue(k))));
      if (ved && String(ved.max ?? "*") === "0" && v.url === childSdx.url) {
        const key = Object.keys(v).find((k) => /^value[A-Z]/.test(k));
        const actual = key ? KNOWN_TYPE_SUFFIX.get(key.slice("value".length)) : undefined;
        if (actual) issues.push({ severity: "error", path: item.path, code: "structure", message: `The Extension '${String(v.url ?? "")}' definition allows for the types [] but found type ${actual}` });
      }
      if (ved && String(ved.max ?? "*") !== "0" && (ved.type || []).length && !hasValue) {
        const url = String(v.url ?? "");
        if (!Array.isArray(v.extension) || !v.extension.length) {
          issues.push({ severity: "error", path: item.path, code: "structure", message: `The Extension '${url}' definition is for a simple extension, so it must contain a value` });
        } else if ((ved.min ?? 0) > 0) {
          issues.push({ severity: "error", path: item.path, code: "structure", message: `The Extension '${url}' definition is for a simple extension, so it must contain a value, not extensions` });
        }
      }
    }

    if (!isResourceRoot) this.checkFixedPattern(el, v, item, sdx, issues);
    await this.checkBinding(el, v, typeCode, item, issues, null);
    await this.checkLanguageDisplay(el, v, typeCode, item, rctx, issues);
    if (typeCode === "Coding") await this.checkCoding(v, item, issues, el);
    if (QUANTITY_TYPES.includes(typeCode)) await this.checkQuantity(v, item, issues, el, sdx);
    if (typeCode === "Identifier") this.checkIdentifier(v, item, issues);
    if (typeCode === "Attachment") this.checkAttachment(v, el, item, issues);
    if (typeCode === "Narrative" && isObject(v) && typeof v.div === "string") {
      // JsonParser.parseChildPrimitiveInstance (XhtmlParser, xml mode) + InstanceValidator.checkXhtml (XhtmlValidator,
      // checkReferences schemes) for the div of every Narrative (resource text, Composition.section.text …)
      const divPath = `${item.path}.div`;
      const px = parseXhtml(v.div);
      if (px.error !== null) issues.push({ severity: "error", path: divPath, code: "invalid", message: `Error parsing XHTML: ${px.error}` });
      for (const m of px.issues) issues.push({ severity: "error", path: divPath, code: "invalid", message: m });
      if (px.div) for (const x of [...validateXhtml(px.div), ...xhtmlHrefIssues(px.div)]) issues.push({ severity: x.severity, path: divPath, code: "invalid", message: x.message });
    }
    if (typeCode === "Narrative" && isObject(v)) {
      // InstanceValidator.checkNarrative: narrative-source-control / narrative-language-control of the definition
      const lang = typeof rctx.resource?.language === "string" ? rctx.resource.language : null;
      for (const x of narrativeControlIssues(v, el, lang, sdx.url)) issues.push({ severity: x.severity, path: item.path, code: "business-rule", message: x.message });
      // textLink extensions (TEXT_LINK_*): the Bundle the resource sits in (getElementBundle), when it is an entry
      const inBundle = rctx.root !== rctx.resource && rctx.root?.resourceType === "Bundle" && Array.isArray(rctx.root.entry) && !rctx.container;
      const selectors: TextLinkSelector[] = [];
      for (const x of textLinkIssues(v, rctx.resource, inBundle ? rctx.root.entry : null, selectors)) issues.push({ severity: x.severity, path: item.path, code: "structure", message: x.message });
      for (const s of selectors) {
        const type = await this.typeOfObjectIn(rctx.resource, s.target);
        if (type === null) continue;
        try {
          await checkFhirPathJava(s.expr, String(rctx.resource.resourceType), type, this.pathCheckDeps);
        } catch (e) {
          if (!(e instanceof PathEngineError)) throw e;
          issues.push({ severity: "error", path: item.path, code: "invalid", message: `The textLink selector '${s.selector}' is invalid: ${e.message}` });
        }
      }
    }
    if (typeCode === "Reference") await this.checkReference(el, v, item, rctx, issues, depth);
    await this.checkConstraints(sdx, el, item, typeCode, rctx, issues);
    for (const [tsdx, troot] of typeRootConstraints) {
      if (tsdx === sdx && troot === el) continue;
      await this.checkConstraints(tsdx, troot, item, typeCode, rctx, issues);
    }
  }

  private datatypeCache = new Map<string, Promise<boolean>>();
  private xverCache = new Map<string, Promise<SdIndex | null>>();

  /** A generated cross-version extension definition (fhirXver.ts) with its snapshot (ContextUtilities.generateSnapshot). */
  private xverSdx(url: string): Promise<SdIndex | null> {
    let p = this.xverCache.get(url);
    if (!p) {
      p = (async () => {
        const sd = xverDefinition(url, (n) => R4_RESOURCE_NAMES.has(n));
        if (!sd) return null;
        const full = await generateSnapshotAsync(sd, (u) => this.resolver.fetchStructureDefinition(u));
        return full && Array.isArray(full.snapshot?.element) && full.snapshot.element.length ? indexOf(full) : null;
      })();
      this.xverCache.set(url, p);
    }
    return p;
  }

  /** InstanceValidator.isAbstractType: the type's definition is abstract. */
  private async isAbstractType(type: string): Promise<boolean> {
    const t = await this.sdx(/^[a-z][a-z0-9+.-]*:/i.test(type) ? type : CORE + type);
    return !!t && t.sd.abstract === true;
  }

  /** Port of InstanceValidator.isValidResourceType (7.0.1, l. 7661-7690). */
  private async isValidResourceType(type: string, def: Record<string, any>): Promise<boolean> {
    const code = typeCodeOf(def);
    const profs: string[] = Array.isArray(def.profile) ? def.profile.map(String) : [];
    if (!profs.length && code === "Resource") return true;
    if (code === type) return true;
    const list: SdIndex[] = [];
    for (const u of profs) {
      const t = await this.sdx(u);
      if (t) list.push(t);
    }
    let sdt = await this.sdx(CORE + type);
    const seen = new Set<string>();
    while (sdt && !seen.has(sdt.url)) {
      seen.add(sdt.url);
      if (code === "Resource") {
        for (const sd of list) if (sd.url === sdt.url || sd.type === sdt.type) return true;
      }
      sdt = typeof sdt.sd.baseDefinition === "string" ? await this.sdx(sdt.sd.baseDefinition) : null;
    }
    return false;
  }

  private isDatatype(typeCode: string): Promise<boolean> {
    let p = this.datatypeCache.get(typeCode);
    if (!p) {
      p = this.sdx(CORE + typeCode).then((s) => !!s && s.sd.kind !== "resource");
      this.datatypeCache.set(typeCode, p);
    }
    return p;
  }

  private typeProfileFor(el: Record<string, any>, typeCode: string): string | null {
    for (const t of el.type || []) {
      if (typeCodeOf(t) === typeCode && Array.isArray(t.profile) && t.profile.length) return String(t.profile[0]);
    }
    return null;
  }

  /**
   * Resolve the definition of an extension instance by its url. Reports unknown
   * extensions the way the HL7 validator does. Returns null when the item cannot
   * be validated further (unknown).
   */
  private async extensionDefinition(parentSdx: SdIndex, item: Item, issues: Issue[]): Promise<SdIndex | null> {
    const url = isObject(item.value) ? item.value.url : undefined;
    if (typeof url !== "string" || !url) {
      // InstanceValidator.validateElement: EXTENSION_EXT_URL_NOTFOUND
      issues.push({ severity: "error", path: item.path, code: "invalid", message: "Extension.url is required in order to identify, use and validate the extension" });
      return this.sdx(CORE + "Extension");
    }
    const absolute = /^[a-z][a-z0-9+.-]*:/i.test(url);
    // checkChildByDefinition l. 8045-8051: `extensionUrl` is the url of any enclosing extension (known or not), so a
    // relative url is accepted anywhere inside an extension
    // (thisExtension is set from any url element, "" too: l. 8048-8049)
    const inExtension = (parentSdx.type === "Extension" && parentSdx.url !== CORE + "Extension") || typeof item.host?.extUrl === "string";
    if (!inExtension && !javaIsAbsoluteUrl(url)) {
      // EXTENSION_EXT_URL_ABSOLUTE (outside an extension); checkExtension is then not run
      issues.push({ severity: "error", path: item.path, code: "invalid", message: "Extension.url must be an absolute URL" });
      return this.sdx(CORE + "Extension");
    }
    if (absolute) {
      // checkExtension l. 2584-2618: the definition is looked up without the version; a '|' in the url is then judged
      const pipe = url.indexOf("|");
      const unversioned = await this.scopedSdx(pipe >= 0 ? url.slice(0, pipe) : url, parentSdx);
      if (unversioned) {
        if (pipe >= 0) {
          const at = `${item.path}[url='${url}']`;
          if (url === unversioned.sd.url) issues.push({ severity: "warning", path: at, code: "invalid", message: "The extension URL contains a '|' which makes it look like a versioned URL, but it's not, and this is confusing for implementers" });
          else if (url === `${unversioned.sd.url}|${unversioned.sd.version}`) issues.push({ severity: "error", path: at, code: "invalid", message: "The extension URL must not contain a version" });
          else issues.push({ severity: "error", path: at, code: "invalid", message: `The extension URL must not contain a version. The extension was validated against version ${unversioned.sd.version} of the extension` });
        }
        return unversioned;
      }
      if (pipe >= 0 && !xverMatchingUrl(url)) {
        const ext = await this.sdx(url);
        const at = `${item.path}[url='${url}']`;
        if (ext) {
          issues.push({ severity: "error", path: at, code: "invalid", message: "Extension URLs don't have versions. The validator has ignored the version and processed the extension anyway" });
          return ext;
        }
        issues.push({ severity: "warning", path: at, code: "invalid", message: "Extension URLs don't have versions. The validator wasn't able to resolve this URL with or without version-based resolution" });
      }
      if (xverMatchingUrl(url)) {
        // BaseValidator.getXverExt (7.0.1, l. 1698-1728): a cross-version extension url — generated definition, or
        // the reason it is not valid (and no "unknown extension" error)
        const at = `${item.path}[url='${url}']`;
        const st = xverStatus(url);
        if (st === "Valid") {
          const x = await this.xverSdx(url);
          if (x) return x;
          issues.push({ severity: "error", path: at, code: "invalid", message: `Extension url '${url}' evaluation state invalid` });
        } else if (st === "BadVersion") {
          issues.push({ severity: "error", path: at, code: "invalid", message: `Extension url '${url}' is not valid (invalid Version '${xverVersion(url)}')` });
        } else if (st === "Unknown") {
          issues.push({ severity: "error", path: at, code: "invalid", message: `Extension url '${url}' is not valid (invalid Element id '${xverElementId(url)}')` });
        } else {
          issues.push({ severity: "error", path: at, code: "invalid", message: `Extension url '${url}' is not valid (Element id '${xverElementId(url)}' is valid, but cannot be used in a cross-version paradigm because there has been no changes across the relevant versions)` });
        }
        return this.sdx(CORE + "Extension");
      }
    }
    const insideDefinedExtension = parentSdx.type === "Extension" && parentSdx.url !== CORE + "Extension";
    // Base-element pass of a sub-extension that already matched a slice of the
    // defined extension (InstanceValidator.checkChild second pass): its relative url
    // is defined by that slice, so it is not "unknown" here.
    if (insideDefinedExtension && !absolute && isObject(item.value) && this.sliceMatched.has(item.value)) {
      return this.sdx(CORE + "Extension");
    }
    // Port of InstanceValidator.checkExtension (7.0.1): an absolute URL is always
    // an extension reference (also as a child of a complex extension); unknown →
    // Extension_EXT_Unknown_NotHere "could not be found so is not allowed here".
    if (insideDefinedExtension && !absolute) {
      issues.push({
        severity: "error",
        path: `${item.path}[url='${url}']`,
        code: "structure",
        message: `Sub-extension url '${url}' is not defined by the Extension ${this.versionedUrl(parentSdx)}` /* EXTENSION_EXT_SUBEXTENSION_INVALID: profile.getVersionedUrl() */,
      });
    } else if (allowUnknownExtension(url, this.allowExamples, this.extensionDomains)) {
      // InstanceValidator.allowUnknownExtension: tools / nema.org / structuredefinition-expression need no definition
    } else if (!inExtension || absolute) {
      // (checkExtension l. 2619-2623: a relative url inside an extension other than the defining one is not reported)
      issues.push({
        severity: "error",
        path: item.path,
        code: "structure",
        message: `The extension ${url} could not be found so is not allowed here`,
      });
    }
    return this.sdx(CORE + "Extension");
  }

  private async validatePrimitiveExtensions(item: Item, el: Record<string, any>, rctx: ResourceCtx, issues: Issue[], depth: number): Promise<void> {
    const ext = item.ext;
    const path = item.path;
    if (!isObject(ext)) {
      // JsonParser (parse time): "This property must be an object, not an Array (value at …)"
      issues.push({ severity: "error", path, code: "structure", message: `This property must be an object, not ${describeJson(ext)} (${item.key} at ${path})` });
      return;
    }
    // JsonParser.parseChildPrimitiveInstance → checkObject(fork): OBJECT_MUST_HAVE_SOME_CONTENT for an empty `_x`
    if (Object.keys(ext).length === 0 && !this.xmlSource) issues.push({ severity: "error", path: item.parserPath ?? path, code: "invalid", message: "Object must have some content" });
    // xhtml has no extension element: an extension on `_div` is an unknown property
    const xhtml = item.typeCode === "xhtml";
    for (const k of Object.keys(ext)) {
      // checkPrimitive l. 3230-3233: `value` is a property of the primitive's definition, so the parser keeps it
      if (k === "value" && !xhtml) issues.push({ severity: "error", path, code: "invalid", message: "The property 'value' is invalid" });
      else if (k !== "id" && (k !== "extension" || xhtml)) {
        issues.push({ severity: "error", path, code: "structure", message: `Unrecognized property '${k}'` });
      }
    }
    if (xhtml) return;
    const list = ext.extension;
    if (list === undefined) return;
    if (!Array.isArray(list)) {
      issues.push({ severity: "error", path, code: "structure", message: "The property extension must be a JSON Array" });
      return;
    }
    // checkExtension l. 2733: FHIR_RESOURCE_ID_CANT_BE_EXTENDED, per extension, at the id
    if (isObject(el.base) && el.base.path === "Resource.id") {
      for (const x of list) if (isObject(x) && typeof x.url === "string") issues.push({ severity: "error", path, code: "business-rule", message: `Extensions are not allowed on Resource.id ('${x.url}')` });
    }
    const extSdx = await this.sdx(CORE + "Extension");
    if (!extSdx) return;
    const literal = item.lit ?? stripIndexes(path.startsWith(ROOT_TOKEN) ? rctx.resource.resourceType + path.slice(ROOT_TOKEN.length) : path);
    const host: ExtensionHost = {
      path,
      value: item.value,
      plist: extensionPlist(literal, item.lp),
      literal,
      isResource: false,
      // checkExtensionContext l. 2838-2846: the value[x] of an extension is that extension for an `extension` context
      extUrl: item.parentExtUrl ?? null,
      primitiveExt: isObject(ext) ? ext : undefined,
      typeCode: item.typeCode || "",
      defPath: "",
      modifier: false,
    };
    const extLp = (item.lp || []).filter((lp) => isRealPath(lp, "extension")).map((lp) => `${lp}.extension`).concat(["Extension"]);
    for (let i = 0; i < list.length; i++) {
      await this.validateItemAgainst(
        extSdx,
        { id: "Element.extension", path: "Element.extension", min: 0, max: "*", type: [{ code: "Extension" }] },
        { value: list[i], ext: undefined, key: "extension", path: `${path}.extension[${i}]`, jpath: `${item.parserPath ?? path}.extension[${i}]`, inList: true, typeCode: "Extension", lp: extLp, host },
        "Extension",
        rctx,
        issues,
        depth + 1,
      );
    }
  }

  /** Walk an object's properties against the child definitions of `el`. */
  private async walkChildren(
    sdx: SdIndex,
    el: Record<string, any>,
    item: Item,
    rctx: ResourceCtx,
    issues: Issue[],
    depth: number,
    isResourceRoot: boolean,
    /** (parity v1) Children of the actual type merged in (InstanceValidator.mergeChildLists). */
    merge: { sdx: SdIndex; el: Record<string, any> } | null = null,
    /** The `_x` object of a primitive (its id / extension); the definition's `value` child is the JSON value itself. */
    primitiveInline = false,
  ): Promise<void> {
    const node = item.value as Record<string, any>;
    const groups = sdx.children(el);
    if (!groups || groups.size === 0) return; // nothing known about the children
    // profile-defined children first; the actual type's children the profile does not define are added
    const groupList: Array<[SdIndex, ReturnType<SdIndex["children"]> extends Map<string, infer G> | null | undefined ? G : never]> = [...groups.values()].map((g) => [sdx, g]);
    if (merge) {
      const extra = merge.sdx.children(merge.el);
      if (extra) for (const g of extra.values()) if (!groups.has(g.name)) groupList.push([merge.sdx, g]);
    }
    // Context of extensions held by this element (InstanceValidator.checkExtensionContext).
    let hostCache: Omit<ExtensionHost, "modifier"> | null = null;
    const rootedLit = item.lit ?? stripIndexes(item.path.startsWith(ROOT_TOKEN) ? rctx.resource.resourceType + item.path.slice(ROOT_TOKEN.length) : item.path);
    const hostOf = (modifier: boolean): ExtensionHost => {
      if (!hostCache) {
        const plist = extensionPlist(rootedLit, item.lp);
        const typeCode = item.typeCode || "";
        hostCache = {
          path: item.path,
          value: node,
          plist,
          literal: rootedLit,
          isResource: isResourceRoot,
          extUrl: typeCode === "Extension" && typeof node.url === "string" ? node.url : item.parentExtUrl ?? null,
          typeCode,
          defPath: String(el.path || typeCode),
        };
      }
      return { ...hostCache, modifier };
    };
    const used = new Set<string>();
    if (isResourceRoot) used.add("resourceType");
    // (parity v3) fhir_comments is a property only in DSTU2 (elementmodel JsonParser.checkNotProcessed: R2 / R2B)

    for (const [gsdx, grp] of groupList) {
      const def = grp.base || grp.slices[0];
      if (!def) continue;
      const name = grp.name;
      if (primitiveInline && name === "value") continue;
      const items: Item[] = [];
      const allowedTypes: string[] = (def.type || []).map(typeCodeOf);
      const typedItems: Array<{ item: Item; type: string }> = [];
      const profileTypeKeys = new Map<string, string>();

      const collect = (key: string, typeCode: string): void => {
        used.add(key);
        used.add("_" + key);
        const lp = childLogicalPaths(item.lp, def, key, typeCode);
        const lit = childLiteralPath(rootedLit, def, key);
        const parentExtUrl = item.typeCode === "Extension" && key.startsWith("value") && typeof node.url === "string" ? node.url : undefined;
        const host = name === "extension" || name === "modifierExtension" ? hostOf(name === "modifierExtension") : undefined;
        const baseMax0 = String((def.base && def.base.max) ?? def.max ?? "*");
        const jbase = `${item.jpath ?? item.path}.${name}`;
        const mk = (value: any, ext: any, p: string): Item => {
          const idx = /\[(\d+)\]$/.exec(p);
          const jpath = idx && p !== path ? `${jbase}[${idx[1]}]` : jbase;
          return { value, ext, key, path: p, jpath, parent: node, typeCode, lp, lit, parentExtUrl, host, inList: baseMax0 !== "1" && baseMax0 !== "0", profileType: profileTypeKeys.has(key), actualType: profileTypeKeys.get(key) };
        };
        const raw = node[key];
        const rawExt = node["_" + key];
        const baseMax = String((def.base && def.base.max) ?? def.max ?? "*");
        const expectArray = baseMax !== "1" && baseMax !== "0";
        const path = `${item.path}.${key}`;
        // JsonParser's npath: `<parent npath>.<property name>`, `value[x]` for a choice element
        const parentNp = item.jpath ?? item.path;
        const npath = jbase;
        // (parity v1) JsonParser.parseChildPrimitive / parseChildComplex (7.0.1, r5 elementmodel): shape errors judged by
        // the base property; a primitive of the wrong shape is dropped, a complex value is still parsed
        const primitiveType = isPrimitive(typeCode);
        if (raw !== undefined && expectArray && !Array.isArray(raw)) {
          issues.push({ severity: "error", path: npath, code: "structure", message: `The property ${key} must be a JSON Array, not ${describeJson(raw)} (at ${parentNp})` });
          if (primitiveType) return;
          const it = mk(raw, Array.isArray(rawExt) ? rawExt[0] : rawExt, path);
          items.push(it);
          typedItems.push({ item: it, type: typeCode });
          return;
        }
        if (raw !== undefined && !expectArray && Array.isArray(raw)) {
          issues.push({
            severity: "error",
            path: npath,
            code: "structure",
            message: primitiveType ? `This property must be a simple value, not an Array (${key} at ${npath})` : `The property ${key} must be an Object, not an Array (at ${npath})`,
          });
          return;
        }
        // (parity v3) JsonParser.parseChildPrimitive: issues about the `_x` fork are reported at the property path
        // (path + "." + property name: the [x] name of a choice, no index)
        const notObject = (v: unknown): string => `This property must be an object, not ${describeJson(v)} (${key} at ${npath})`;
        if (primitiveType && !this.xmlSource && expectArray && rawExt !== undefined && rawExt !== null && !Array.isArray(rawExt)) {
          // THIS_BASE_PROPERTY_MUST_BE_AN_ARRAY_NOT_ ((sic) describes the main value); nothing of the property is kept
          issues.push({ severity: "error", path: npath, code: "invalid", message: `This base property must be an Array, not ${describeJson(raw === undefined ? rawExt : raw)}` });
          return;
        }
        if (Array.isArray(raw) || (raw === undefined && Array.isArray(rawExt))) {
          const arr = Array.isArray(raw) ? raw : [];
          const exts = Array.isArray(rawExt) ? rawExt : [];
          if (arr.length === 0 && exts.length === 0 && raw !== undefined) {
            // ARRAY_CANNOT_BE_EMPTY is JsonParser.parseChildComplex only: an empty primitive array is silently no element
            if (!primitiveType || this.xmlSource) issues.push({ severity: "error", path: npath, code: "structure", message: `Array cannot be empty - the property should not be present if it has no values` });
            return;
          }
          const n = Math.max(arr.length, exts.length);
          for (let i = 0; i < n; i++) {
            const val = arr[i] === undefined ? null : arr[i];
            const ex = exts[i] === undefined ? null : exts[i];
            if (val === null && ex === null) {
              if (this.xmlSource) {
                // XML: an element without value or children (InstanceValidator.checkPrimitive + ele-1)
                issues.push({ severity: "error", path: `${path}[${i}]`, code: "invalid", message: PRIMITIVE_VALUEEXT_MESSAGE });
                issues.push({ severity: "error", path: `${path}[${i}]`, code: "invariant", message: ELE1_MESSAGE });
              } else if (primitiveType) {
                // JSON_PROPERTY_INVALID_ARRAY ((sic) formatted with the index only: {1} stays literal)
                issues.push({ severity: "error", path, code: "invalid", message: `The JSON array for '${i}' is invalid at index {1} - must have at least one valid value` });
              } else {
                // parseChildComplexInstance on a JsonNull: THIS_PROPERTY_MUST_BE__NOT_
                issues.push({ severity: "error", path: `${npath}[${i}]`, code: "structure", message: `The property ${key} must be an Array, not a Null (at ${npath}[${i}])` });
              }
              continue;
            }
            if (primitiveType && !this.xmlSource && ex !== null && !isObject(ex) && !(val !== null && (isObject(val) || Array.isArray(val)))) {
              issues.push({ severity: "error", path: npath, code: "invalid", message: notObject(ex) });
              continue;
            }
            const it = mk(val, ex ?? undefined, `${path}[${i}]`);
            if (primitiveType) it.parserPath = npath;
            const nt = numberText(arr, i);
            if (nt !== undefined) it.numText = nt;
            items.push(it);
            typedItems.push({ item: it, type: typeCode });
          }
          return;
        }
        if (raw === undefined && rawExt === undefined) return;
        // JsonParser.parseChildPrimitiveInstance l. 712-714: a JsonNull main value is an error whether or not `_x` is
        // there, and no element is created (only array items may be null beside their shadow)
        if (raw === null && (rawExt === undefined || (primitiveType && !this.xmlSource))) {
          if (this.xmlSource) {
            // XML: an element without value or children (InstanceValidator.checkPrimitive + ele-1)
            issues.push({ severity: "error", path, code: "invalid", message: PRIMITIVE_VALUEEXT_MESSAGE });
            issues.push({ severity: "error", path, code: "invariant", message: ELE1_MESSAGE });
          } else if (primitiveType) {
            // parseChildPrimitiveInstance on a JsonNull: THIS_PROPERTY_MUST_BE_AN_SIMPLE_VALUE_NOT_
            issues.push({ severity: "error", path: npath, code: "structure", message: `This property must be a simple value, not a Null (${key} at ${npath})` });
          } else {
            // parseChildComplexInstance on a JsonNull: THIS_PROPERTY_MUST_BE__NOT_
            issues.push({ severity: "error", path: npath, code: "structure", message: `The property ${key} must be an Object, not a Null (at ${npath})` });
          }
          return;
        }
        if (primitiveType && !this.xmlSource && rawExt !== undefined && rawExt !== null && !isObject(rawExt) && !(raw !== undefined && raw !== null && (isObject(raw) || Array.isArray(raw)))) {
          // parseChildPrimitiveInstance: a `_x` that is not an object — the element (value too) is not created
          issues.push({ severity: "error", path: npath, code: "invalid", message: notObject(rawExt) });
          return;
        }
        const it = mk(raw === undefined ? null : raw, rawExt, path);
        if (primitiveType) it.parserPath = npath;
        const nt = numberText(node, key);
        if (nt !== undefined) it.numText = nt;
        items.push(it);
        typedItems.push({ item: it, type: typeCode });
      };

      if (name.endsWith("[x]")) {
        const stem = name.slice(0, -3);
        const present = Object.keys(node)
          .map((k) => k.replace(/^_/, ""))
          .filter((k) => k.startsWith(stem) && k.length > stem.length && /[A-Z]/.test(k[stem.length]) && !groups.has(k));
        const presentNames = new Set(present);
        const keys = [...presentNames];
        let accepted = 0;
        for (const key of keys) {
          const suffix = key.slice(stem.length);
          const t = allowedTypes.find((a) => a[0].toUpperCase() + a.slice(1) === suffix);
          if (!t && KNOWN_TYPE_SUFFIX.has(suffix)) {
            // (parity v1) InstanceValidator.checkChildByDefinition (7.0.1): a type the BASE element does not allow was
            // dropped by the parser (Unrecognized property, structural pass); a type the base allows but a profile that
            // fixes ONE type does not → Extension_PROF_Type, and the value is validated as the profile's type
            const baseTypes = await this.baseElementTypes(def);
            const actual = KNOWN_TYPE_SUFFIX.get(suffix)!;
            if (baseTypes && !baseTypes.includes(actual)) {
              used.add(key);
              used.add("_" + key);
              continue;
            }
            const rawValue = node[key];
            if (!isPrimitive(actual) && rawValue !== undefined && rawValue !== null && typeof rawValue !== "object") {
              // parseChildComplexInstance judges the property by the base type: no element, so nothing of the profile's type either
              const at = `${item.jpath ?? item.path}.${name}`;
              issues.push({ severity: "error", path: at, code: "structure", message: `The property ${key} must be an Object, not ${describeJson(rawValue)} (at ${at})` });
              used.add(key);
              used.add("_" + key);
              continue;
            }
            if (allowedTypes.length === 1 && !["Element", "BackboneElement", "*"].includes(allowedTypes[0])) {
              accepted++;
              if (accepted > 1) continue;
              issues.push(
                gsdx.type === "Extension" && def.path === "Extension.value[x]"
                  ? {
                      // InstanceValidator.checkExtension (Extension_EXT_Type): an extension's value of a type its definition does not allow
                      severity: "error",
                      path: item.path, // checkExtension reports at the extension, the allowed types as a Java Set
                      code: "structure",
                      message: `The Extension '${gsdx.url}' definition allows for the types ${javaHashSetToString(allowedTypes)} but found type ${actual}`,
                      element: def.id,
                    }
                  : {
                      severity: "error",
                      path: `${item.path}.${stem}.ofType(${actual})`,
                      code: "structure",
                      message: `The Profile '${gsdx.url}${gsdx.sd?.version ? `|${gsdx.sd.version}` : ""}' definition allows for the type ${allowedTypes[0]} but found type ${actual}`,
                      element: def.id,
                    },
              );
              profileTypeKeys.set(key, actual);
              collect(key, allowedTypes[0]);
              continue;
            }
          }
          if (!t) {
            if (KNOWN_TYPE_SUFFIX.has(suffix)) {
              // InstanceValidator.checkChildByDefinition l. 7950-7956 (several types, none matching the name): when
              // the first type is Reference the value is validated as a Reference, otherwise
              // VALIDATION_VAL_PROFILE_NOTYPE
              if (allowedTypes[0] === "Reference") {
                accepted++;
                if (accepted > 1) continue;
                profileTypeKeys.set(key, KNOWN_TYPE_SUFFIX.get(suffix)!);
                collect(key, "Reference");
                continue;
              }
              used.add(key);
              used.add("_" + key);
              // reported on the parent's stack (stack.getLiteralPath()); the element matched its definition, so it counts
              issues.push({
                severity: "error",
                path: item.path,
                code: "structure",
                message: `The type of element ${key} is not known - it could not be determined from the information available. Valid types at this point are ${allowedTypes.join(", ")}`,
                element: def.id,
              });
              const it: Item = { value: node[key], ext: undefined, key, path: `${item.path}.${key}`, typeUnknown: true, actualType: KNOWN_TYPE_SUFFIX.get(suffix) };
              items.push(it);
              // type slices still judge the element (jar: NotSlice beside the unknown type); nothing else validates it
              if (grp.base?.slicing && grp.slices.length) typedItems.push({ item: it, type: it.actualType! });
            }
            continue;
          }
          accepted++;
          if (accepted > 1) {
            // A second value for a single choice element: the HL7 validator calls it unrecognized.
            continue;
          }
          collect(key, t);
        }
      } else {
        if (!(name in node) && !(("_" + name) in node)) {
          // nothing present
        } else {
          const t = allowedTypes.length === 1 ? allowedTypes[0] : allowedTypes[0] || (def.contentReference ? "BackboneElement" : "");
          collect(name, t || "BackboneElement");
        }
      }

      // A choice element with type slices but no slicer: every item ends up on the last slice (see choiceSlicesWithoutSlicer)
      const choiceNoSlicer = grp.slices.length > 0 && !!grp.base && !grp.base.slicing && grp.name.endsWith("[x]");
      // Cardinality (per parent instance) against the base definition of this group.
      if (grp.base) this.checkCardinality(grp.base, choiceNoSlicer ? 0 : items.length, item, gsdx, issues);

      if (grp.slices.length && grp.base && grp.base.slicing) {
        await this.validateSliced(gsdx, grp, typedItems, item, rctx, issues, depth);
      } else if (choiceNoSlicer) {
        await this.choiceSlicesWithoutSlicer(gsdx, grp, typedItems, item, rctx, issues, depth);
      } else {
        for (const { item: it, type } of typedItems) {
          await this.validateItemAgainst(gsdx, def, it, type, rctx, issues, depth + 1);
        }
        if (grp.slices.length && grp.base && !grp.name.endsWith("[x]")) this.slicesWithoutSlicer(gsdx, grp, typedItems.map((t) => t.item), item, issues);
      }
    }

    for (const key of Object.keys(node)) {
      if (used.has(key)) continue;
      if (item.profileType && item.typeCode) {
        // a value written as another type, validated as the profile's: its children are not in that type
        // (Validation_VAL_Profile_NotAllowed against the type's definition)
        const tsdx = await this.sdx(CORE + item.typeCode);
        issues.push({ severity: "error", path: `${item.path}.${key}`, code: "structure", message: `This element is not allowed by the profile ${CORE}${item.typeCode}${tsdx?.sd?.version ? `|${tsdx.sd.version}` : ""}` });
        // checkChildByDefinition walks the profile's inline children of the element first, then the type (l. 8085-8090)
        if (sdx !== tsdx && sdx.hasChildren(el)) issues.push({ severity: "error", path: `${item.path}.${key}`, code: "structure", message: `This element is not allowed by the profile ${this.versionedUrl(sdx)}` });
        continue;
      }
      issues.push({ severity: "error", path: item.jpath ?? item.path, code: "structure", message: `Unrecognized property '${key}'` });
    }
  }

  /** Types of the base (core) element of a profile element (null when unknown). */
  private async baseElementTypes(def: Record<string, any>): Promise<string[] | null> {
    const bp = isObject(def.base) && typeof def.base.path === "string" ? def.base.path : null;
    if (!bp) return null;
    const rt = bp.split(".")[0];
    const core = await this.sdx(CORE + rt);
    const el = core?.byId.get(bp);
    if (!el) return null;
    return ((el.type || []) as any[]).map(typeCodeOf);
  }

  private checkCardinality(def: Record<string, any>, count: number, parent: Item, sdx: SdIndex, issues: Issue[]): void {
    const min = typeof def.min === "number" ? def.min : 0;
    const max = def.max === undefined || def.max === null ? "*" : String(def.max);
    const from = sdx.url;
    // VALIDATION_VAL_PROFILE_MINIMUM / _MAXIMUM: (from profile.getVersionedUrl())
    const vfrom = this.versionedUrl(sdx);
    if (count < min) {
      issues.push({
        severity: "error",
        path: parent.path,
        code: "required",
        message: `${def.id || def.path}: minimum required = ${min}, but only found ${count} (from ${vfrom})`,
        element: def.id,
        profile: from,
      });
    }
    if (max !== "*" && /^\d+$/.test(max) && count > Number(max)) {
      issues.push({
        severity: "error",
        path: parent.path,
        code: "cardinality",
        message: `${def.id || def.path}: max allowed = ${max}, but found ${count} (from ${vfrom})`,
        element: def.id,
        profile: from,
      });
    }
  }

  // ------------------------------------------------------------------ slicing

  /** HL7 StructureDefinition.getVersionedUrl(): the canonical with `|version` when the definition has one. */
  private versionedUrl(sdx: SdIndex): string {
    return sdx.sd?.version ? `${sdx.url}|${sdx.sd.version}` : sdx.url;
  }

  /**
   * Port of InstanceValidator.assignChildren / matchSlice / checkCardinalities (7.0.1) for one sliced element
   * group: every item is tested against every slice in definition order (sliceMatches); the first match is kept,
   * a later match is Validation_VAL_Profile_MatchMultiple unless one is a re-slice of the other; an item no slice
   * takes is an additional slice — a hint (THIS_ELEMENT_DOES_NOT_MATCH_ANY_KNOWN_SLICE_) for open / openAtEnd
   * slicing, Validation_VAL_Profile_NotSlice (with the per-slice reasons) for closed; slicing that cannot be
   * evaluated is SLICING_CANNOT_BE_EVALUATED and turns the slice cardinalities into NoCheckMin / NoCheckMax hints;
   * ordered slicing checks Validation_VAL_Profile_SliceOrder; then the slice cardinalities
   * (Validation_VAL_Profile_Minimum_SLICE[_EXT], VALIDATION_VAL_PROFILE_MINIMUM_MAGIC, Validation_VAL_Profile_Maximum).
   * Locally undecidable membership (terminology the host cannot answer) keeps the slice out of the counts.
   */
  private async validateSliced(
    sdx: SdIndex,
    grp: ChildGroup,
    typedItems: Array<{ item: Item; type: string }>,
    parent: Item,
    rctx: ResourceCtx,
    issues: Issue[],
    depth: number,
  ): Promise<void> {
    const base = grp.base!;
    const slicing = base.slicing || {};
    const discs: Array<Record<string, any>> = slicing.discriminator || [];
    const rules = slicing.rules || "open";
    const vurl = this.versionedUrl(sdx);
    const counts = new Map<Record<string, any>, number>();
    const indeterminate = new Set<Record<string, any>>();
    let unsupported = false;
    for (const s of grp.slices) counts.set(s, 0);
    let lastSlice = -1;

    const groupCauses = new Set<string>();
    for (let idx = 0; idx < typedItems.length; idx++) {
      const { item: it, type } = typedItems[idx];
      let matched: Record<string, any> | null = null;
      let undecided = false;
      let failedHere = false;
      const sliceInfo: string[] = [];
      for (const s of grp.slices) {
        let r: SliceMatch;
        const outerCauses = this.undecidedCauses;
        this.undecidedCauses = groupCauses;
        try {
          r = await this.sliceMatches(sdx, base, grp.slices, s, discs, it, it.actualType ?? type, idx, rctx, depth);
        } catch (e) {
          this.undecidedCauses = outerCauses;
          if (!(e instanceof SlicingDefinitionError)) throw e;
          // matchSlice: FHIRException → SLICING_CANNOT_BE_EVALUATED, unsupportedSlicing
          issues.push({ severity: "error", path: it.path, code: "processing", message: `Slicing cannot be evaluated: ${e.message}`, element: s.id, profile: sdx.url });
          unsupported = true;
          failedHere = true;
          continue;
        }
        this.undecidedCauses = outerCauses;
        if (r.match === undefined) {
          indeterminate.add(s);
          undecided = true;
          continue;
        }
        if (!r.match) {
          // NodeStack literal path: a choice element is `<stem>.ofType(<type>)`
          const literal = (x: string): string => (x.startsWith(ROOT_TOKEN) ? LITERAL_ROOT_TOKEN + x.slice(ROOT_TOKEN.length) : x);
          const lit = literal(String(base.path).endsWith("[x]") && it.path.endsWith(`.${it.key}`) ? `${it.path.slice(0, -it.key.length - 1)}.${String(base.path).split(".").pop()!.slice(0, -3)}.ofType(${it.actualType ?? type})` : it.path);
          sliceInfo.push(`${lit}: Does not match slice '${sliceNameOf(s)}' (discriminator: ${groupedExpression(r.expression)})`);
          // IV:6518-6527: a DETAILS_FOR__MATCHING_AGAINST_PROFILE_ hint per failed conformsTo() profile (HashMap order)
          for (const u of javaHashOrder(r.notes ?? [])) {
            const sdt = await this.sdx(u);
            sliceInfo.push(`${lit}: Details for ${literal(parent.path)} matching against profile ${sdt ? this.versionedUrl(sdt) : u}`);
          }
          continue;
        }
        if (!matched) {
          matched = s;
          continue;
        }
        const first = sliceNameOf(matched);
        const name = sliceNameOf(s);
        if (first && name.startsWith(`${first}/`)) {
          matched = s;
          continue;
        }
        if (first && first.startsWith(`${name}/`)) continue;
        issues.push({
          severity: "error",
          path: it.path,
          code: "invalid",
          message: `Profile ${vurl}, Element matches more than one slice - ${first}, ${name}`,
          element: base.id,
          profile: sdx.url,
        });
      }
      if (matched) {
        counts.set(matched, (counts.get(matched) || 0) + 1);
        const si = grp.slices.indexOf(matched);
        if (slicing.ordered === true && si < lastSlice) {
          issues.push({
            severity: "error",
            path: it.path,
            code: "invalid",
            message: `As specified by profile ${vurl}, Element '${it.key}' is out of order in ordered slice`,
            element: matched.id,
            profile: sdx.url,
          });
        }
        lastSlice = si;
        const t = this.sliceType(matched, type);
        await this.validateItemAgainst(sdx, matched, it, t, rctx, issues, depth + 1);
        // Port of InstanceValidator.checkChild (7.0.1): a slice member is checked
        // against BOTH definitions — ei.definition (the slice) and ei.slice (the
        // slicing entry / base element) — with the full checkChildByDefinition, so
        // the base element's child cardinalities, fixed / pattern values, bindings
        // and invariants apply to slice members too (a snapshot need not copy them
        // onto the slice: TW Core 0.3.2 Patient.identifier.system is min 1 on the
        // base only). Identical issues from the two passes are merged by dedupe().
        if (isObject(it.value)) this.sliceMatched.add(it.value);
        await this.validateItemAgainst(sdx, base, it, type, rctx, issues, depth + 1);
      } else {
        lastSlice = -1;
        if (!unsupported && !failedHere) {
          if (rules === "closed" && undecided) {
            issues.push({
              severity: "information",
              path: it.path,
              code: "informational",
              message: `Slice membership could not be decided with local terminology (slicing is CLOSED in ${sdx.url})`,
              unchecked: { kind: "slice", canonical: `${sdx.url}#${base.id ?? base.path}`, causes: [...groupCauses] },
            });
          } else if (undecided) {
            // REVIEW F5: the element may belong to a slice whose constraints were not applied
            issues.push({
              severity: "information",
              path: it.path,
              code: "informational",
              message: `Slice membership could not be decided with local terminology (${sdx.url}#${base.id ?? base.path})`,
              unchecked: { kind: "slice", canonical: `${sdx.url}#${base.id ?? base.path}`, causes: [...groupCauses] },
            });
          } else if (rules === "closed") {
            issues.push({
              severity: "error",
              path: it.path,
              code: "invalid",
              message: `This element does not match any known slice defined in the profile ${vurl} and slicing is CLOSED: ${sliceInfo.join(", ")}`,
              element: base.id,
              profile: sdx.url,
            });
          } else if (!undecided && !(sdx.url.startsWith(CORE) && base.path === "Observation.code.coding")) {
            // ignoreSlicingHint: core profiles' Observation.code.coding
            issues.push({
              severity: "information",
              path: it.path,
              code: "informational",
              message: `This element does not match any known slice defined in the profile ${vurl} (this may not be a problem, but you should check that it's not intended to match a slice)`,
              element: base.id,
              profile: sdx.url,
            });
          }
        }
        await this.validateItemAgainst(sdx, base, it, type, rctx, issues, depth + 1);
      }
    }
    for (const s of grp.slices) {
      if (indeterminate.has(s)) {
        // REVIEW F5: the cardinality cannot be checked when undecided elements may be members
        const n0 = counts.get(s) || 0;
        const min0 = typeof s.min === "number" ? s.min : 0;
        const max0 = s.max === undefined || s.max === "*" ? Infinity : Number(s.max);
        // the decided members alone already exceed the maximum: that error is certain (checked below)
        if (!(n0 > max0)) {
          if (n0 < min0 || Number.isFinite(max0)) {
            issues.push({
              severity: "information",
              path: parent.path,
              code: "informational",
              message: `Cardinality of slice ${String(s.id ?? s.path)} could not be checked: slice membership undecidable with local terminology (from ${vurl})`,
              unchecked: { kind: "slice", canonical: `${sdx.url}#${String(s.id ?? s.path)}`, causes: [...groupCauses] },
            });
          }
          continue;
        }
      }
      // checkCardinalities l. 8334-8350: a slice that re-slices (has its own slicing) also counts the members of its
      // re-slices (ProfileUtilities.getSliceList)
      let n = counts.get(s) || 0;
      if (s.slicing && sliceNameOf(s)) {
        for (const r of grp.slices) if (r !== s && sliceNameOf(r).startsWith(`${sliceNameOf(s)}/`)) n += counts.get(r) || 0;
      }
      const min = typeof s.min === "number" ? s.min : 0;
      const max = s.max === undefined ? "*" : String(s.max);
      const id = String(s.id ?? s.path);
      if (unsupported) {
        // problematicPaths: VALIDATION_VAL_PROFILE_NOCHECKMIN / NOCHECKMAX hints
        if (min > 0 && n < min) {
          issues.push({ severity: "information", path: parent.path, code: "not-supported", message: `${id}: Found ${n} match${n === 1 ? "" : "es"}, but unable to check minimum required (${s.path}) due to lack of slicing validation (from ${vurl})`, element: s.id, profile: sdx.url });
        }
        if (max !== "*" && /^\d+$/.test(max) && n > Number(max)) {
          issues.push({ severity: "information", path: parent.path, code: "not-supported", message: `${id}: Found ${n} match${n === 1 ? "" : "es"}, but unable to check max allowed (${s.path}) due to lack of slicing validation (from ${vurl})`, element: s.id, profile: sdx.url });
        }
        continue;
      }
      if (n < min) {
        let message: string;
        if (sdx.url.startsWith(CORE) && s.path === "Observation.code.coding") {
          message = `${sliceNameOf(s)}: magic LOINC code ${this.fixedLoincCode(sdx, s)} required, but not found (from ${vurl}). Note that other Observation codes are allowed in addition to this required magic code`;
        } else {
          const extProfile = (s.type || []).length && typeCodeOf(s.type[0]) === "Extension" ? (s.type[0].profile || [])[0] : undefined;
          let extUrl: string | null = null;
          if (typeof extProfile === "string") {
            extUrl = extProfile;
            const esdx = await this.sdx(extProfile);
            const fixedUrl = esdx ? [...esdx.byId.values()].find((e) => e.path === "Extension.url")?.fixedUri : undefined;
            if (typeof fixedUrl === "string") extUrl = fixedUrl;
          }
          const forExt = extUrl !== null ? ` for extension '${extUrl}'` : "";
          message =
            min === 1
              ? `Slice '${id}'${forExt}: a matching slice is required, but not found (from ${vurl}). Note that other slices are allowed in addition to this required slice`
              : `Slice '${id}'${forExt}: minimum required = ${min}, but only found ${n} (from ${vurl})`;
        }
        issues.push({ severity: "error", path: parent.path, code: "structure", message, element: s.id, profile: sdx.url });
      }
      if (max !== "*" && /^\d+$/.test(max) && n > Number(max)) {
        issues.push({
          severity: "error",
          path: parent.path,
          code: "structure",
          message: `${id}: max allowed = ${max}, but found ${n} (from ${vurl})`,
          element: s.id,
          profile: sdx.url,
        });
      }
    }
  }

  /**
   * Slices whose element has no slicer (a profile that "launches straight into slicing": ProfileUtilities only adds
   * an ignorable error, PU:1100-1103, and keeps the slice in the snapshot). InstanceValidator.assignChildren then
   * has no slicer (IV:8458-8486), so matchSlice matches every slice element by name alone (IV:8642-8649): an item
   * already assigned to the unsliced base element fails Validation_VAL_Profile_MatchMultiple (IV:8673) and stays on
   * the base; the slices count nothing, so checkCardinalities reports each required slice
   * (Validation_VAL_Profile_Minimum_SLICE, IV:8370).
   */
  private slicesWithoutSlicer(sdx: SdIndex, grp: ChildGroup, items: Item[], parent: Item, issues: Issue[]): void {
    const vurl = this.versionedUrl(sdx);
    for (const it of items) {
      for (const s of grp.slices) {
        issues.push({ severity: "error", path: it.path, code: "invalid", message: `Profile ${vurl}, Element matches more than one slice - , ${sliceNameOf(s)}` });
      }
    }
    for (const s of grp.slices) {
      const min = typeof s.min === "number" ? s.min : 0;
      if (min <= 0) continue;
      const id = String(s.id ?? s.path);
      const message =
        min === 1
          ? `Slice '${id}': a matching slice is required, but not found (from ${vurl}). Note that other slices are allowed in addition to this required slice`
          : `Slice '${id}': minimum required = ${min}, but only found 0 (from ${vurl})`;
      issues.push({ severity: "error", path: parent.path, code: "structure", message, element: s.id, profile: sdx.url });
    }
  }

  /**
   * The `[x]` case of slices without a slicer. matchSlice (IV:8642-8673) matches every slice element by name
   * (nameMatches: `value[x]` takes any `value*`), and because the element already assigned is a `[x]` element whose
   * path the slice continues, the match is accepted and replaces the assignment — so each item ends on the LAST slice
   * element of the group, whatever its own type, and is validated against it; checkCardinalities (IV:8334-8380) then
   * counts the base element 0, that slice n, the other slices 0.
   */
  private async choiceSlicesWithoutSlicer(
    sdx: SdIndex,
    grp: ChildGroup,
    typedItems: Array<{ item: Item; type: string }>,
    parent: Item,
    rctx: ResourceCtx,
    issues: Issue[],
    depth: number,
  ): Promise<void> {
    const last = grp.slices[grp.slices.length - 1];
    const allowed = (last.type || []).map((t: Record<string, any>) => typeCodeOf(t));
    const vurl = this.versionedUrl(sdx);
    for (const { item: it, type } of typedItems) {
      if (allowed.length && !allowed.includes(type)) {
        // checkChildByDefinition: the value's type is not one of the assigned element's types
        issues.push(
          allowed.length === 1
            ? { severity: "error", path: it.path, code: "structure", message: `The Profile '${vurl}' definition allows for the type ${allowed[0]} but found type ${type}`, element: last.id }
            : { severity: "error", path: it.path, code: "structure", message: `The type of element ${it.key} is not known - it could not be determined from the information available. Valid types at this point are ${allowed.join(", ")}`, element: last.id },
        );
        continue;
      }
      await this.validateItemAgainst(sdx, last, it, type, rctx, issues, depth + 1);
    }
    for (const s of grp.slices) {
      const n = s === last ? typedItems.length : 0;
      const min = typeof s.min === "number" ? s.min : 0;
      const max = s.max === undefined ? "*" : String(s.max);
      const id = String(s.id ?? s.path);
      if (n < min) {
        const message =
          min === 1
            ? `Slice '${id}': a matching slice is required, but not found (from ${vurl}). Note that other slices are allowed in addition to this required slice`
            : `Slice '${id}': minimum required = ${min}, but only found ${n} (from ${vurl})`;
        issues.push({ severity: "error", path: parent.path, code: "structure", message, element: s.id, profile: sdx.url });
      }
      if (max !== "*" && /^\d+$/.test(max) && n > Number(max)) {
        issues.push({ severity: "error", path: parent.path, code: "structure", message: `${id}: max allowed = ${max}, but found ${n} (from ${vurl})`, element: s.id, profile: sdx.url });
      }
    }
  }

  /** InstanceValidator.getFixedLOINCCode: the fixed LOINC code of a core vital-signs code.coding slice. */
  private fixedLoincCode(sdx: SdIndex, slice: Record<string, any>): string {
    if (isObject(slice.fixedCoding) && slice.fixedCoding.system === "http://loinc.org") return String(slice.fixedCoding.code);
    for (const g of sdx.children(slice)?.values() || []) {
      const e = g.base;
      if (e && String(e.path).endsWith(".code")) {
        const [f] = fixedPattern(e);
        if (f && (typeof f.value === "string" || typeof f.value === "number")) return String(f.value);
      }
    }
    return "??";
  }

  private sliceType(slice: Record<string, any>, itemType: string): string {
    const types: string[] = (slice.type || []).map(typeCodeOf);
    if (types.includes(itemType) || !types.length) return itemType;
    return itemType;
  }

  /**
   * Port of InstanceValidator.getCriteriaForDiscriminator (7.0.1): the element definitions that carry a
   * discriminator's criteria for one slice — the element the path names inside the slice, then the same path in
   * each profile of the slice's type (an extension slice's url lives in the extension definition). `removeResolve`
   * (profile discriminators): a trailing resolve() is not followed — the profile is on the reference.
   */
  private async sliceCriteria(sdx: SdIndex, slice: Record<string, any>, path: string, removeResolve: boolean): Promise<Array<Record<string, any>>> {
    const out: Array<Record<string, any>> = [];
    if (path === "value" && fixedPattern(slice)[0]) return [slice];
    let p = path;
    if (removeResolve) {
      if (p === "resolve()") return [slice];
      if (p.endsWith(".resolve()")) p = p.slice(0, -".resolve()".length);
    }
    const own = this.elementAt(sdx, slice, p);
    if (own) out.push(own);
    for (const t of slice.type || []) {
      for (let pi = 0; pi < (t.profile || []).length; pi++) {
        const psdx = await this.sdx(String(t.profile[pi]));
        if (!psdx) continue;
        // getCriteriaForDiscriminator l. 5815-5832: EXT_PROFILE_ELEMENT names the element of the profile to start from
        const from = profileElementOf(t, pi, psdx);
        const el = this.elementAt(psdx, from, p);
        if (el && !out.includes(el)) out.push(el);
      }
    }
    return out;
  }

  /**
   * Port of InstanceValidator.sliceMatches (7.0.1). Java builds one FHIRPath expression per slice from the
   * discriminators and evaluates it; here each clause is evaluated directly on the instance: max = 0 →
   * `.empty()`; type → `is T` (FHIRPath type hierarchy); profile → `conformsTo()` (a profile-less criteria
   * element adds no clause); exists → `.exists()` / `.exists().not()`; position; fixed / pattern (CodeableConcept,
   * Coding, Identifier, HumanName, Address, primitives — the Java `.where(…).exists()` forms over all values at the
   * path); required binding → `memberOf`. Definition problems Java throws as FHIRException
   * (DISCRIMINATOR__IS_BASED_ON_ELEMENT_EXISTENCE…, Could_not_match_discriminator_for_slice_in_profile, Unsupported
   * … pattern) are thrown as SlicingDefinitionError (→ SLICING_CANNOT_BE_EVALUATED). `match` undefined: membership
   * the local terminology cannot decide, or a path our definitions cannot follow.
   */
  private async sliceMatches(
    sdx: SdIndex,
    slicer: Record<string, any>,
    slices: Array<Record<string, any>>,
    slice: Record<string, any>,
    discs: Array<Record<string, any>>,
    it: Item,
    itemType: string,
    position: number,
    rctx: ResourceCtx,
    depth: number,
  ): Promise<SliceMatch> {
    if (!discs.length) return { match: false, expression: "" };
    const vurl = this.versionedUrl(sdx);
    const clauses: string[] = [];
    const notes: string[] = [];
    let result: boolean | undefined = true;
    let anyFound = false;
    let anyUnlocated = false;
    const discNames = discs.map((d) => String(d.path || "$this"));
    const and = (r: boolean | undefined): void => {
      if (r === false) result = false;
      else if (r === undefined && result !== false) result = undefined;
    };
    for (const d of discs) {
      const dtype: string = d.type || "value";
      const rawPath = String(d.path || "$this");
      const dpath = rawPath.startsWith("$this.") ? rawPath.slice(6) : rawPath;
      if (dtype === "position") {
        // position: only as the sole discriminator; every earlier slice must have a fixed count (min = max)
        if (discs.length !== 1) throw new SlicingDefinitionError(couldNotMatch(discs.length, discNames, slice.id, vurl));
        let offset = 0;
        for (const ts of slices) {
          if (ts === slice) break;
          if (String(ts.max) !== String(ts.min ?? 0)) throw new SlicingDefinitionError(couldNotMatch(discs.length, discNames, slice.id, vurl));
          offset += typeof ts.min === "number" ? ts.min : 0;
        }
        const maxPos = String(slice.max) === "*" ? Number.MAX_SAFE_INTEGER : offset + Number(slice.max);
        const pos = /\[(\d+)\]$/.exec(it.path) ? Number(/\[(\d+)\]$/.exec(it.path)![1]) : position;
        return { match: pos >= offset && pos < maxPos, expression: `position ${offset}..${maxPos}` };
      }
      const criteria = await this.sliceCriteria(sdx, slice, dpath, dtype === "profile");
      if (!criteria.length) anyUnlocated = true;
      let found = false;
      for (const c of criteria) {
        found = true;
        if (String(c.max) === "0") {
          clauses.push(`${rawPath}.empty()`);
          and(this.discriminatorValues(it.value, dpath, rctx).length === 0);
        } else if (dtype === "type") {
          const r = await this.typeClause(sdx, slice, c, rawPath, dpath, it, itemType, rctx);
          clauses.push(r.expression);
          and(r.match);
        } else if (dtype === "profile") {
          if (!(c.type || []).length) throw new SlicingDefinitionError(`Profile based discriminators must have a type (${c.id} in profile ${vurl})`);
          const ref = rawPath.endsWith(".resolve()") || rawPath === "resolve()";
          const profs: string[] = [];
          for (const t of c.type || []) for (const p of (ref ? t.targetProfile : t.profile) || []) profs.push(String(p));
          if (!profs.length) {
            // "we don't have to find something": no clause
          } else {
            clauses.push(profs.length > 1 ? `(${profs.map((p) => `${rawPath}.conformsTo('${p}')`).join(" or ")})` : `${rawPath}.conformsTo('${profs[0]}')`);
            // FHIRPath `and` short-circuits on false: a conformsTo() after a failed clause is never evaluated
            if ((result as boolean | undefined) !== false) and(await this.conformsToAny(it, dpath, profs, rctx, depth, notes));
          }
        } else if (dtype === "exists") {
          if (typeof c.min === "number" && c.min >= 1) {
            clauses.push(`(${rawPath}.exists())`);
            and(this.discriminatorValues(it.value, dpath, rctx).length > 0);
          } else if (String(c.max) === "0") {
            clauses.push(`(${rawPath}.exists().not())`);
            and(this.discriminatorValues(it.value, dpath, rctx).length === 0);
          } else {
            throw new SlicingDefinitionError(`Discriminator (${rawPath}) is based on element existence, but slice ${slice.id} neither sets min>=1 or max=0`);
          }
        } else {
          const [fixed, pattern] = fixedPattern(c);
          const values = this.discriminatorValues(it.value, dpath, rctx);
          if (fixed) {
            const r = fixedClause(rawPath, fixed.value, valueTypeOf(fixed.field.slice(5)), String(slice.id), values);
            clauses.push(r.expression);
            and(r.match);
          } else if (pattern) {
            const r = patternClause(rawPath, pattern.value, valueTypeOf(pattern.field.slice(7)), String(slice.id), values);
            clauses.push(r.expression);
            and(r.match);
          } else if (c.binding && c.binding.strength === "required" && c.binding.valueSet) {
            clauses.push(`(${rawPath} memberOf '${c.binding.valueSet}')`);
            and(await this.bindingClause(String(c.binding.valueSet), values));
          } else {
            found = false;
          }
        }
        if (found) break;
      }
      if (!found && (dtype === "value" || dtype === "pattern")) {
        // required sub-slices on the path carry the criteria (bp component:SystolicBP code.coding.code: the fixed
        // 8480-6 sits on code.coding:SBPCode.code) — FHIRPathEngine.evaluateDefinition follows them
        const exp = await this.discriminatorExpectation(sdx, slice, dpath);
        if (exp) {
          found = true;
          const values = this.discriminatorValues(it.value, dpath, rctx);
          if (exp.kind === "binding") {
            clauses.push(`(${rawPath} memberOf '${exp.valueSet}')`);
            and(await this.bindingClause(exp.valueSet, values));
          } else {
            clauses.push(`${rawPath} = ${JSON.stringify(exp.values[0])}`);
            and(exp.kind === "fixed" ? values.some((a) => exp.values.some((e) => deepEqual(a, e))) : values.some((a) => exp.values.some((e) => patternMatches(a, e))));
          }
        }
      }
      if (found) anyFound = true;
    }
    if (!anyFound) {
      // Java: Could_not_match_discriminator_for_slice_in_profile — only when every criteria element was located
      // (a path our snapshot walk cannot follow stays undecided instead of an error)
      if (anyUnlocated) return { match: undefined, expression: clauses.join(" and ") };
      throw new SlicingDefinitionError(couldNotMatch(discs.length, discNames, slice.id, vurl));
    }
    return { match: result, expression: clauses.join(" and "), ...(notes.length ? { notes } : {}) };
  }

  /** The type clause of InstanceValidator.sliceMatches (`<path> is <type>`, or any of several types). */
  private async typeClause(
    sdx: SdIndex,
    slice: Record<string, any>,
    c: Record<string, any>,
    rawPath: string,
    dpath: string,
    it: Item,
    itemType: string,
    rctx: ResourceCtx,
  ): Promise<{ match: boolean; expression: string }> {
    let want: string[];
    let disc = rawPath.includes("[") ? rawPath.slice(0, rawPath.indexOf("[")) : rawPath;
    const viaResolve = /(^|\.)resolve\(\)$/.test(dpath);
    if (viaResolve) {
      // evaluateDefinition follows the reference into its target profile: the criteria element is that
      // profile's root, typed by the resource type it constrains
      want = [];
      for (const t of c.type || []) {
        for (const p of t.targetProfile || []) {
          const psdx = await this.sdx(String(p));
          if (psdx?.type) want.push(String(psdx.type));
        }
      }
      if (!want.length) want = (c.type || []).map(typeCodeOf);
    } else if (!(c.type || []).length) {
      if (String(c.path).includes(".")) throw new SlicingDefinitionError(`Discriminator (${disc}) is based on type, but slice ${slice.id} in ${this.versionedUrl(sdx)} has no types`);
      want = [String(c.path)];
    } else {
      want = (c.type || []).map(typeCodeOf);
    }
    want = want.map(fhirPathTypeName);
    void disc;
    const actual = this.discriminatorTypes(it, itemType, dpath, rctx);
    const match = actual.length > 0 && actual.some((a) => want.some((w) => typeIs(a, w)));
    disc = rawPath.includes("[") ? rawPath.slice(0, rawPath.indexOf("[")) : rawPath;
    const expression = want.length > 1 ? `(${want.map((w) => `${disc} is ${w}`).join(" or ")})` : `${disc} is ${want[0]}`;
    // FHIRPath `is` on a collection of more than one item is an error in Java; treat as no match
    return { match: actual.length === 1 ? match : actual.length > 1 ? false : false, expression };
  }

  /** Types of the values a type discriminator path reaches (resource types, choice suffixes, the item type for $this). */
  private discriminatorTypes(it: Item, itemType: string, dpath: string, rctx: ResourceCtx): string[] {
    if (dpath === "$this") {
      if (isObject(it.value) && typeof it.value.resourceType === "string" && (itemType === "Resource" || itemType === "DomainResource" || !itemType)) return [it.value.resourceType];
      return [itemType];
    }
    const segs = dpath.split(".");
    const last = segs[segs.length - 1];
    const holderPath = segs.slice(0, -1).join(".") || "$this";
    const out: string[] = [];
    if (last === "resolve()" || segs.some((s) => s === "resolve()")) {
      for (const v of this.discriminatorValues(it.value, dpath, rctx)) if (isObject(v) && typeof v.resourceType === "string") out.push(v.resourceType);
      return out;
    }
    const holders = holderPath === "$this" ? [it.value] : this.discriminatorValues(it.value, holderPath, rctx);
    for (const h of holders) {
      if (!isObject(h)) continue;
      if (last in h) {
        const vals = Array.isArray(h[last]) ? h[last] : [h[last]];
        for (const v of vals) out.push(isObject(v) && typeof v.resourceType === "string" ? v.resourceType : jsonTypeName(v));
        continue;
      }
      for (const k of Object.keys(h)) {
        if (k.startsWith(last) && k.length > last.length && /[A-Z]/.test(k[last.length])) {
          const suffix = k.slice(last.length);
          const t = KNOWN_TYPE_SUFFIX.get(suffix) ?? suffix;
          const vals = Array.isArray(h[k]) ? h[k] : [h[k]];
          for (let i = 0; i < vals.length; i++) out.push(t);
        }
      }
    }
    return out;
  }

  /**
   * Does the resource conform to `url`, as the sub-validations of InstanceValidator decide it — checkReference's
   * target-profile choice (IV:5376-5385) and FHIRPath conformsTo() in slice discriminators (conformsToProfile,
   * IV:431-471) both call validateResource(…, sd, …) and count every error / fatal message (hasErrors /
   * isError()). validateResource → start (IV:6872-7010) runs startInner for `url` AND for every resolvable meta.profile
   * of the resource other than `url` (startInner hands back a profile's cached outcomes, IV:7157-7165), so an error
   * against one of the resource's own declared profiles also makes the match fail. Parse-time issues are not part of
   * it (the parser reported them once).
   */
  private async resourceConforms(ctx: ResourceCtx, url: string, path: string, depth: number, checkSpecials = false, forReference = false): Promise<boolean> {
    // conformsTo() and a reference into the Bundle validate on a new NodeStack, whose workingLang is the validation
    // language (NodeStack:41, 75), not the language inherited from the Bundle; a contained target stays on the stack
    if (ctx.container !== null) return this.resourceConformsOn(ctx, url, path, depth, checkSpecials, forReference);
    const saved = this.workingLang;
    const own = typeof ctx.resource?.language === "string" ? ctx.resource.language.trim() : "";
    this.workingLang = own ? [own] : null; // checkLang (IV:7380) on the new stack
    try {
      return await this.resourceConformsOn(ctx, url, path, depth, checkSpecials, forReference);
    } finally {
      this.workingLang = saved;
    }
  }

  private async resourceConformsOn(ctx: ResourceCtx, url: string, path: string, depth: number, checkSpecials: boolean, forReference: boolean): Promise<boolean> {
    // validateResource(forReference = true): checkContainedReferences is skipped (IV:9051)
    const counted = (i: Issue): boolean => !isParseIssue(i) && !(forReference && / \(dom-3\)$/u.test(i.message));
    // start (IV:6905-7001) never stops at a failure: `ok = startInner(…) && ok` for defn, its dependencies and every
    // meta.profile. Order matters: what each of them visits fills the tracker and validator_contained_Id for later ones
    const passes = async (u: string): Promise<boolean> => {
      let ok = isValid((await this.conformance(ctx, u, path, depth)).filter(counted));
      // start, IV:6917-6937 / 6981-7001: the profile's imposeProfile dependencies (one level); an unresolved one is a warning
      const sdx = await this.sdx(u);
      for (const x of Array.isArray(sdx?.sd.extension) ? sdx!.sd.extension : []) {
        if (!isObject(x) || x.url !== IMPOSE_PROFILE_EXT) continue;
        const ip = typeof x.valueCanonical === "string" ? x.valueCanonical : typeof x.valueUri === "string" ? x.valueUri : null;
        if (!ip || !(await this.sdx(ip))) continue;
        if (!isValid((await this.conformance(ctx, ip, path, depth)).filter(counted))) ok = false;
      }
      return ok;
    };
    let ok = await passes(url);
    if (await this.emptiedByParser(ctx.resource)) ok = false;
    const meta = isObject(ctx.resource.meta) && Array.isArray(ctx.resource.meta.profile) ? ctx.resource.meta.profile : [];
    for (const mp of meta) {
      if (typeof mp !== "string" || !mp || mp === url) continue;
      if (!(await this.sdx(mp))) continue; // Validation_VAL_Profile_Unknown: a warning
      if (!(await passes(mp))) ok = false;
    }
    if (checkSpecials) {
      // startInner with checkSpecials (IV:7181-7184): conformsTo() runs in a new ValidationContext, where it is on
      // (a reference target's forLocalReference context has it off, ValidationContext:196). The specials this
      // validator can fail on here: ObservationValidator's vital-signs profile, validateResourceRules' security labels.
      if (ctx.resource.resourceType === "Observation") {
        const vs = impliedVitalSignProfile(ctx.resource.code);
        if (vs && vs !== url && !meta.includes(vs) && (await this.sdx(vs)) && !(await passes(vs))) ok = false;
      }
      if (Array.isArray(ctx.resource.meta?.security)) {
        const tags = new Set<string>();
        for (const e of ctx.resource.meta.security) {
          const t = `${isObject(e) && typeof e.system === "string" ? e.system : null}#${isObject(e) && typeof e.code === "string" ? e.code : null}`;
          if (tags.has(t)) ok = false; // duplicate security label
          tags.add(t);
        }
      }
    }
    return ok;
  }

  /**
   * ele-1 on an element the parser emptied (only dropped content inside, e.g. `meta` with a scalar `profile`) is an
   * error of every profile pass in Java — validation runs on the element model; ours comes from the structural pass,
   * which runs once at the end, so a sub-validation asks for it here. Memoised per resource for this validation.
   */
  private async emptiedByParser(resource: Record<string, any>): Promise<boolean> {
    let p = this.emptiedCache.get(resource);
    if (p === undefined) {
      p = (async () => {
        const found: Issue[] = [];
        await this.structuralPass(resource, resource.resourceType, found, 0);
        return found.some((i) => i.message === ELE1_MESSAGE);
      })();
      this.emptiedCache.set(resource, p);
    }
    return p;
  }

  /** FHIRPath memberOf() on a code / Coding / CodeableConcept: null = empty (funcMemberOf l. 5181-5183, no ValueSet); undefined = the terminology server may hold it. */
  private async hostMemberOf(value: any, url: string): Promise<boolean | null | undefined> {
    if (!(await this.vsHeader(url))) return (await this.valueSetMayBeAtServer(url)) ? undefined : null;
    if (typeof value === "string") return this.member(url, null, value);
    return this.bindingClause(url, [value]);
  }

  /** FHIRPath conformsTo() (InstanceValidator.conformsToProfile, l. 430-475). */
  private async hostConformsTo(value: any, url: string, item: Item, rctx: ResourceCtx): Promise<boolean | null | undefined> {
    const psdx = await this.sdx(url);
    if (!psdx) return null;
    if (!isObject(value)) return undefined;
    if (typeof value.resourceType === "string") {
      const same = this.sourceOf(value) === this.sourceOf(rctx.resource);
      const ctx: ResourceCtx = same ? rctx : { resource: value, container: null, root: rctx.root, bundle: rctx.bundle, entry: this.entryFor(value, rctx, false) };
      return this.resourceConforms(ctx, url, item.path, 0, true);
    }
    const trial: Issue[] = [];
    await this.validateItemAgainst(psdx, psdx.root, { value, ext: undefined, key: item.key, path: item.path }, psdx.type, { ...rctx, ids: new Map() }, trial, 0);
    return isValid(trial.filter((i) => !isParseIssue(i)));
  }

  /** `<path>.conformsTo(p1) or …`: the value at the path validates against one of the profiles without errors. */
  private async conformsToAny(it: Item, dpath: string, profs: string[], rctx: ResourceCtx, depth: number, notes: string[] = []): Promise<boolean> {
    const target = dpath === "$this" ? [it.value] : this.discriminatorValues(it.value, dpath, rctx);
    if (target.length !== 1) return false;
    const r = target[0];
    if (r === null || r === undefined) return false;
    if (!isObject(r) || !r.resourceType) {
      // a datatype value (Coding, Identifier …, or a primitive: conformsToProfile l. 449-457 takes any Element) against a datatype profile
      for (const p of profs) {
        const psdx = await this.sdx(p);
        if (!psdx) continue;
        const trial: Issue[] = [];
        const sub: Item = { value: r, ext: undefined, key: dpath.split(".").pop() || it.key, path: this.pathOf(it, dpath) };
        // FHIRPath conformsTo (InstanceValidator.conformsToProfile): a new NodeStack, so a fresh id scope
        await this.validateItemAgainst(psdx, psdx.root, sub, psdx.type, { ...rctx, ids: new Map() }, trial, depth + 1);
        if (isValid(trial.filter((i) => !isParseIssue(i)))) return true;
        notes.push(p);
      }
      return false;
    }
    // FHIRPath `or` short-circuits on true; each conformsTo() that fails records its errors (IV:460-470, sliceNotes)
    for (const p of profs) {
      const psdx = await this.sdx(p);
      if (!psdx) continue;
      if (psdx.type !== r.resourceType && !["Resource", "DomainResource"].includes(psdx.type)) {
        notes.push(p); // validateResource: Validation_VAL_Profile_WrongType
        continue;
      }
      const ctx: ResourceCtx = { resource: r, container: null, root: rctx.root, bundle: rctx.bundle, entry: this.entryFor(r, rctx, false) };
      if (await this.resourceConforms(ctx, p, this.pathOf(it, dpath), depth + 1, true)) return true;
      notes.push(p);
    }
    return false;
  }

  /** `(<path> memberOf '<vs>')` answered with the local terminology (undefined when it cannot decide). */
  private async bindingClause(valueSet: string, actual: any[]): Promise<boolean | undefined> {
    if (!(await this.vsHeader(valueSet)) && !(await this.valueSetMayBeAtServer(valueSet))) return false; // the slicing clause is the operator: opMemberOf l. 2793-2817, no ValueSet → false (funcMemberOf: empty)
    let hit = false;
    let unknown = false;
    for (const a of actual) {
      if (await this.codelessCodingMember(valueSet, a)) {
        hit = true;
        continue;
      }
      const list: any[] = isObject(a) ? (Array.isArray(a.coding) ? a.coding : [a]) : [];
      for (const [system, code] of codingsOf(a)) {
        if (!code) continue;
        // a Coding without a system is never valid in a value set (ValueSetValidator: Coding_has_no_system__cannot_validate);
        // only a bare code (code / string / uri) infers its system
        if (system === null && isObject(a)) {
          if (faceValueMember(await this.vsHeader(valueSet), code)) hit = true;
          continue;
        }
        const m = await this.member(valueSet, system, code);
        if (m === true) {
          // FHIRPathEngine.opMemberOf (services, tag 7.0.1:2792): validateCode(…).isOk() — a wrong display (error) of
          // the member coding makes it not ok (REVIEW_port_1 F9; the operator form is "any value", not size == 1)
          const c = list.find((x) => isObject(x) && x.code === code && (x.system ?? null) === system);
          if (system && c && typeof c.display === "string" && c.display) {
            const r = await this.codeCheck(system, code, c.display, typeof c.version === "string" ? c.version : null);
            if (r.status === "invalid-display" && r.severity === "error") continue;
          }
          hit = true;
        }
        // Port of InstanceValidator.sliceMatches → evaluateSlicingExpression
        // (7.0.1): a required-binding discriminator becomes
        // `memberOf('<vs>')`, answered by the terminology layer; a code system
        // neither the package closure nor tx.fhir.org can resolve is "not a
        // member" (PAS Condition coding with TW Core 0.3.2's
        // …/CodeSystem/icd-10-cm-2023-tw, published under its ValueSet URL →
        // no slice matches).
        if (m === undefined && (system === null || (await this.systemResolvable(system)))) {
          unknown = true;
          this.undecidedCauses?.add(`${system ?? ""}|${valueSet}`);
        }
      }
    }
    if (!hit) return unknown ? undefined : false;
    return true;
  }

  /**
   * `$this memberOf '<vs>'` for a Coding without a code (absent or "", which the HL7
   * parser drops). Port of FHIRPathEngine.funcMemberOf → BaseWorkerContext.validateCode
   * → ValueSetValidator.validateCode (7.0.1): value-set membership is only tested when
   * the Coding has a code, so the result is the code system check alone — a warning
   * (isOk) when the Coding has no system either, or when its system is a CodeSystem
   * the closure holds and validates locally. Such a Coding therefore matches every
   * required-binding slice whose ValueSet resolves, and two or more matches are
   * "Element matches more than one slice" (validator_cli: DiagnosticReport-twcore
   * code.coding after deleting the code). Systems HL7 sends to the terminology
   * server (LOINC, SNOMED CT …) or cannot resolve stay "no match" (not decided here).
   */
  private async codelessCodingMember(valueSet: string, value: any): Promise<boolean> {
    if (!isObject(value) || Array.isArray(value.coding)) return false;
    if (typeof value.code === "string" && value.code !== "") return false;
    if (value.code !== undefined && typeof value.code !== "string") return false;
    if (!(await this.vsHeader(valueSet))) return false;
    const system = value.system;
    if (system === undefined) return true;
    if (typeof system !== "string" || !system || !this.resolver.codeSystemLocal) return false;
    return this.resolver.codeSystemLocal(system).catch(() => false);
  }

  private pathOf(it: Item, dpath: string): string {
    if (dpath === "$this") return it.path;
    return `${it.path}.${dpath.replace(/\.?resolve\(\)$/, "")}`;
  }

  /** Element definition reached from `start` by a simple dotted path (slice-local first). */
  private elementAt(sdx: SdIndex, start: Record<string, any>, path: string): Record<string, any> | null {
    if (path === "$this" || path === "") return start;
    let cur: Record<string, any> | null = start;
    for (const raw of path.split(".")) {
      if (!cur) return null;
      const seg = raw.replace(/\(.*\)$/, "");
      if (raw.startsWith("ofType(") || raw === "resolve()") continue;
      if (raw.startsWith("extension(")) {
        const url = /extension\('([^']+)'\)/.exec(raw)?.[1];
        const g: ChildGroup | undefined = sdx.children(cur)?.get("extension");
        const sl: Record<string, any> | undefined = g?.slices.find((s: Record<string, any>) =>
          (s.type || []).some((t: any) => (t.profile || []).map(stripVersion).includes(url)),
        );
        cur = sl || null;
        continue;
      }
      cur = sdx.child(cur, seg);
    }
    return cur;
  }

  /** Expected discriminator value(s) for a slice at `path`. */
  private async discriminatorExpectation(
    sdx: SdIndex,
    slice: Record<string, any>,
    path: string,
  ): Promise<{ kind: "fixed" | "pattern"; values: any[] } | { kind: "binding"; valueSet: string } | null> {
    const segs = path === "$this" ? [] : path.split(".");
    let cur: Record<string, any> | null = slice;
    let carried: { kind: "fixed" | "pattern"; values: any[] } | null = null;
    const own = (el: Record<string, any>): { kind: "fixed" | "pattern"; values: any[] } | null => {
      const [f, p] = fixedPattern(el);
      if (f) return { kind: "fixed", values: [f.value] };
      if (p) return { kind: "pattern", values: [p.value] };
      return null;
    };
    carried = own(slice);
    // Extension slices discriminated by url: the url comes from the type profile.
    if (segs.length === 1 && segs[0] === "url") {
      const urlChild = sdx.child(slice, "url");
      const fx = urlChild ? own(urlChild) : null;
      if (fx) return fx;
      for (const t of slice.type || []) {
        if (typeCodeOf(t) === "Extension" && Array.isArray(t.profile) && t.profile.length) {
          return { kind: "fixed", values: [stripVersion(t.profile[0])] };
        }
      }
    }
    let lastEl: Record<string, any> | null = slice;
    for (const raw of segs) {
      if (raw === "resolve()" || raw.startsWith("ofType(")) return null;
      const seg = raw;
      if (carried) {
        const next: any[] = [];
        for (const v of carried.values) {
          if (!isObject(v)) continue;
          const x = v[seg];
          if (Array.isArray(x)) pushAll(next, x);
          else if (x !== undefined) next.push(x);
        }
        carried = next.length ? { kind: carried.kind, values: next } : null;
      }
      cur = cur ? sdx.child(cur, seg) : null;
      if (cur) {
        const mine = own(cur);
        if (mine) carried = mine;
        lastEl = cur;
      } else {
        lastEl = null;
      }
    }
    if (carried) return carried;
    if (lastEl && lastEl.binding && lastEl.binding.strength === "required" && lastEl.binding.valueSet) {
      return { kind: "binding", valueSet: String(lastEl.binding.valueSet) };
    }
    // Port of InstanceValidator.getCriteriaForDiscriminator (7.0.1): it also looks inside required sub-slices on
    // the path (e.g. bp component:SystolicBP discriminated by code.coding.code,
    // where the fixed 8480-6 sits on code.coding:SBPCode.code).
    let at: Record<string, any> = slice;
    for (let i = 0; i < segs.length; i++) {
      const g = sdx.children(at)?.get(segs[i]);
      for (const s of g?.slices || []) {
        if ((typeof s.min === "number" ? s.min : 0) < 1) continue;
        const rest = segs.slice(i + 1).join(".") || "$this";
        const e = await this.discriminatorExpectation(sdx, s, rest);
        if (e) return e;
      }
      const nx = sdx.child(at, segs[i]);
      if (!nx) break;
      at = nx;
    }
    return null;
  }

  /** Values at a discriminator path inside an instance value. */
  private discriminatorValues(value: any, path: string, rctx: ResourceCtx): any[] {
    let cur: any[] = [value];
    if (path === "$this") return cur;
    const segs = (path.startsWith("$this.") ? path.slice(6) : path).split(".");
    for (let si = 0; si < segs.length; si++) {
      const raw = segs[si];
      // `value.ofType(Quantity)`: only the choice property of that type
      const ofType = /^ofType\(([^)]+)\)$/.exec(segs[si + 1] ?? "")?.[1];
      const next: any[] = [];
      if (raw === "resolve()") {
        for (const c of cur) {
          const ref = isObject(c) ? c.reference : typeof c === "string" ? c : null;
          if (typeof ref === "string") {
            // the slice discriminator is a FHIRPath resolve(): host resolveReference, not the fullUrl rules (IV:385-409)
            const r = this.resolveRefForFhirPath(ref, rctx);
            if (r) next.push(r);
          }
        }
      } else if (raw.startsWith("extension(")) {
        const url = /extension\('([^']+)'\)/.exec(raw)?.[1];
        for (const c of cur) if (isObject(c)) for (const e of c.extension || []) if (isObject(e) && e.url === url) next.push(e);
      } else if (raw.startsWith("ofType(")) {
        const t = /ofType\(([^)]+)\)/.exec(raw)?.[1] || "";
        for (const c of cur) next.push(c); // type was already chosen by the choice key
        void t;
      } else {
        for (const c of cur) {
          if (!isObject(c)) continue;
          if (raw in c) {
            const x = c[raw];
            if (Array.isArray(x)) pushAll(next, x);
            else if (x !== undefined && x !== null) next.push(x);
          } else {
            // choice element addressed by its stem (e.g. `value` → valueCodeableConcept)
            for (const k of Object.keys(c)) {
              if (k.startsWith(raw) && k.length > raw.length && /[A-Z]/.test(k[raw.length]) && (!ofType || k === raw + ofType[0].toUpperCase() + ofType.slice(1))) {
                const x = c[k];
                if (Array.isArray(x)) pushAll(next, x);
                else if (x !== undefined && x !== null) next.push(x);
              }
            }
          }
        }
      }
      cur = next;
      if (!cur.length) break;
    }
    return cur;
  }

  // ------------------------------------------------------------------ value checks

  private checkPrimitive(v: any, item: Item, typeCode: string, el: Record<string, any>, issues: Issue[], profile: Record<string, any> | null = null): void {
    // R4 core snapshots type Resource.id as System.String with fhir-type
    // "string"; the HL7 validator still checks a resource id against the `id`
    // syntax (Resource_RES_ID_Malformed), with or without a profile.
    if (typeCode === "string" && isObject(el.base) && el.base.path === "Resource.id") typeCode = "id";
    const spec = PRIMITIVES[typeCode];
    const path = item.path;
    if (v === null || v === undefined) {
      if (item.ext === undefined || item.ext === null) {
        issues.push({ severity: "error", path, code: "structure", message: `The property ${item.key} has no value` });
        return;
      }
      // InstanceValidator.checkPrimitive l. 3235-3256: an element with no value (only `_x` with id / extensions) still
      // gets the blank-value checks — required binding, mustHaveValue, valueAlternatives
      this.checkBlankPrimitive(item, el, profile, issues);
      return;
    }
    // JsonParser.parseChildPrimitive l. 620: the parser's npath is the property name, value[x] for a choice — unlike the validator's paths
    const npath = item.parserPath ?? (typeof el.path === "string" && el.path.endsWith("[x]") ? path.replace(/\.[^.]*$/, `.${el.path.split(".").pop()}`) : path);
    if (isObject(v) || Array.isArray(v)) {
      issues.push({ severity: "error", path: npath, code: "structure", message: `This property must be a simple value, not ${describeJson(v)} (${item.key} at ${npath})` });
      return;
    }
    if (item.profileType) {
      this.parsedPrimitiveShape(v, item, npath, issues);
      // (parity v1) validated as the profile's type, not its own (Extension_PROF_Type was reported): only the
      // InstanceValidator's value checks of that type apply, the parser checked the JSON shape against the base type
      const before = issues.length;
      this.valueAsDeclaredType(String(item.numText ?? v), item, path, typeCode, el, profile, issues);
      const declaredOk = issues.length === before;
      // checkExtension validates the extension against its definition, then the element against core Extension, where
      // value[x] is the type the value is written as
      if (item.actualType && isPrimitive(item.actualType)) {
        const text = item.numText ?? String(v);
        // checkPrimitive l. 3665-3679: the regex is the element's own type's (e.fhirType()), whatever type is being checked
        const regext = ["id", "base64Binary", "markdown"].includes(item.actualType) ? undefined : R4_TYPE_REGEX[item.actualType];
        const own: Issue[] = [];
        // (a bound element fails checkPrimitiveBinding first when the value is not in the set)
        if (declaredOk && !el.binding && regext && !javaFullRegex(regext)!.test(text)) own.push({ severity: "error", path, code: "invalid", message: `Element value '${text}' does not meet ${item.actualType} regex '${regext}'` });
        if (String(el.path) === "Extension.value[x]") this.checkPrimitiveValue(text, item, item.actualType, {}, profile, own);
        for (const i of own) if (!own.slice(0, own.indexOf(i)).some((x) => x.message === i.message)) issues.push(i);
      }
      return;
    }
    if (typeof v !== spec.json) {
      issues.push({ severity: "error", path: npath, code: "structure", message: `Error parsing JSON: the primitive value must be a ${spec.json}` });
      // (parity v2) JsonParser.parseChildPrimitiveInstance keeps the value (as its string) and the InstanceValidator then
      // checks it as the element's type — those value errors take part in slice / profile matching like any other
    } else if (spec.json === "boolean") return;
    // (parity v3, F4) the element model keeps a JSON number's source text (JsonNumber.asString)
    this.checkPrimitiveValue(item.numText ?? String(v), item, typeCode, el, profile, issues);
  }

  /**
   * InstanceValidator.checkPrimitive (7.0.1) l. 3245-3264, the part of the blank-value branch that does not depend on
   * how the value is blank (no value at all / "" / whitespace): a required binding with no code is
   * Terminology_TX_Code_ValueSet_MISSING (a warning, Terminology_TX_Code_ValueSet_XVER_SOURCE, when a cross-version
   * extension — XVerExtensionManager.matchingUrl — is present), then PRIMITIVE_MUSTHAVEVALUE_MESSAGE and
   * PRIMITIVE_VALUE_ALTERNATIVES_MESSAGE.
   */
  private checkBlankPrimitive(item: Item, el: Record<string, any>, profile: Record<string, any> | null, issues: Issue[]): void {
    const path = item.path;
    const exts: any[] = isObject(item.ext) && Array.isArray(item.ext.extension) ? item.ext.extension : [];
    if (isObject(el.binding) && el.binding.strength === "required") {
      const xver = exts.find((x) => isObject(x) && xverMatchingUrl(x.url));
      if (xver) {
        // ex.getNamedChildValue("value"): the value[x] primitive
        const val = Object.keys(xver).find((k) => k.startsWith("value"));
        const shown = val && !isObject(xver[val]) && !Array.isArray(xver[val]) ? String(xver[val]) : "null";
        issues.push({
          severity: "warning",
          path,
          code: "code-invalid",
          message: `Though a code is required, no code has been provided; instead, an alternative code '${shown}' is provided in the cross-version extension '${xver.url}'. Many systems will not support this extension, or may not understand or support the alternative code`,
        });
      } else {
        issues.push({ severity: "error", path, code: "code-invalid", message: "No code provided, and a code is required from the value set" });
      }
    }
    const versioned = profile ? (profile.version ? `${profile.url}|${profile.version}` : String(profile.url ?? "")) : "";
    // R4 carries the R5 ElementDefinition.mustHaveValue / valueAlternatives as cross-version extensions
    // (VersionConvertor_40_50 reads them into the R5 model the validator works on)
    const edExt = (name: string): any[] =>
      (Array.isArray(el.extension) ? el.extension : []).filter((x: any) => isObject(x) && x.url === `http://hl7.org/fhir/5.0/StructureDefinition/extension-ElementDefinition.${name}`);
    const mustHaveValue = el.mustHaveValue === true || edExt("mustHaveValue").some((x) => x.valueBoolean === true);
    if (mustHaveValue) {
      issues.push({ severity: "error", path, code: "invalid", message: `The element definition \`\`${el.id}\`\` in the profile '${versioned}' requires that a value be present in this element` });
    }
    const alts: string[] = Array.isArray(el.valueAlternatives)
      ? el.valueAlternatives.map(String)
      : edExt("valueAlternatives").map((x) => x.valueCanonical ?? x.valueUri).filter((x): x is string => typeof x === "string");
    if (alts.length && !alts.some((u) => exts.some((x) => isObject(x) && x.url === u))) {
      // rulePlural prepends the count, so the template's {0} / {1} / {2} are (count, element id, profile) — the
      // ValueSet list argument is not shown (PRIMITIVE_VALUE_ALTERNATIVES_MESSAGE as validator_cli prints it)
      issues.push({
        severity: "error",
        path,
        code: "invalid",
        message:
          alts.length === 1
            ? `The element definition \`\`${alts.length}\`\` in the profile '${el.id}' requires that if a value is not present, the extension '${versioned}' must be present`
            : `The element definition \`\`${alts.length}\`\` in the profile '${el.id}' requires that if a value is not present, one of the extensions '${versioned}' must be present`,
      });
    }
  }

  /**
   * Port of InstanceValidator.checkPrimitive (validator 7.0.1) for a primitive written as a JSON string: the checks
   * in Java's order, each with its message id's wording. The binding, fixed / pattern, URL-resolution and xhtml
   * checks of that method run elsewhere (checkBinding, checkFixedPattern, checkUri, the narrative checks); `ok`
   * mirrors Java's flag that gates the final type-regex check (TYPE_SPECIFIC_CHECKS_DT_PRIMITIVE_REGEX_TYPE).
   * `profile` is the StructureDefinition the element definition comes from (isCoreDefinition).
   */
  private checkPrimitiveValue(s: string, item: Item, typeCode: string, el: Record<string, any>, profile: Record<string, any> | null, issues: Issue[]): void {
    if (this.inMatchetype && s.startsWith("$")) return; // checkPrimitive, IV:3284: a matchetype placeholder
    const path = item.path;
    const hasChildren = item.ext !== undefined && item.ext !== null;
    const rule = (pass: boolean, message: string, code = "invalid"): boolean => {
      if (!pass) issues.push({ severity: "error", path, code, message });
      return pass;
    };
    const warning = (pass: boolean, message: string, code = "invalid"): boolean => {
      if (!pass) issues.push({ severity: "warning", path, code, message });
      return pass;
    };
    const maxLen = typeof el.maxLength === "number" && el.maxLength > 0 ? (el.maxLength as number) : null;
    // TYPE_SPECIFIC_CHECKS_DT_PRIMITIVE_LENGTH
    const lengthOk = (): boolean => rule(maxLen === null || s.length <= maxLen, `value is longer than permitted maximum length of ${maxLen}`);
    // isCoreDefinition(profile)
    const coreProfile = !!profile && String(profile.url ?? "").startsWith(CORE) && profile.kind !== "logical";
    const dateRules = extString(el, DATE_RULES_EXT);
    const versioned = profile ? (profile.version ? `${profile.url}|${profile.version}` : String(profile.url ?? "")) : "";

    // Resource.id is checked by InstanceValidator.validateResource (RESOURCE_RES_ID_MALFORMED_LENGTH / _CHARS) and
    // not as an `id` here (checkPrimitive: type == id && base path != Resource.id)
    const isResourceId = isObject(el.base) && el.base.path === "Resource.id";
    // (parity v3) "" too: FormatUtilities.isValidId("") is false (IV:9029; corpus empty-string id items)
    if (isResourceId) {
      if (s.length > 64) rule(false, `Invalid Resource id: Too long (${s.length} chars)`);
      else rule(ID_RE.test(s), `Invalid Resource id: Invalid Characters ('${s}')`);
      if (typeCode === "id") typeCode = "string";
    }

    if (isJavaBlank(s)) {
      if (s.length === 0) {
        rule(hasChildren, "value cannot be empty"); // TYPE_SPECIFIC_CHECKS_DT_PRIMITIVE_NOTEMPTY
        // value "" (XML value="", JSON ""): FHIRPathEngine.funcHasValue (l. 6208) — Utilities.noString("") — is false,
        // so ele-1 fails too (parity v3 round 5: the evaluator corpus shows ele-1 with every JSON "" without children)
        if (!hasChildren) issues.push({ severity: "error", path: item.path, code: "invariant", message: ELE1_MESSAGE });
      }
      else warning(hasChildren, "Primitive types should not only be whitespace"); // TYPE_SPECIFIC_CHECKS_DT_PRIMITIVE_WS
      this.checkBlankPrimitive(item, el, profile, issues);
      return;
    }
    // UNICODE_XML_BAD_CHARS (plural)
    const badChars = new Set<string>();
    for (const ch of s) {
      const c = ch.charCodeAt(0);
      if (c < 32 && !(ch === "\r" || ch === "\n" || ch === "\t")) badChars.add(c.toString(16));
    }
    if (badChars.size === 1) warning(false, `This content includes the character [${[...badChars].join(", ")}] (hex value). This character is illegal in the XML version of FHIR, and there is generally no valid use for such characters`);
    else if (badChars.size > 1) warning(false, `This content includes the characters [${[...badChars].join(", ")}] (hex values). These characters are illegal in the XML version of FHIR, and there is generally no valid use for such characters`);

    let ok = true;
    const minLen = extInt(el, "http://hl7.org/fhir/StructureDefinition/minLength");
    if (minLen !== null) ok = rule(s.length >= minLen, `Value '${s.length}' is shorter than permitted minimum length of ${minLen}`) && ok; // PRIMITIVE_TOO_SHORT
    let regex = extString(el, REGEX_EXT);
    if (regex !== null) {
      for (const tr of Array.isArray(el.type) ? el.type : []) {
        const r = extString(tr, REGEX_EXT);
        if (r !== null) {
          regex = r;
          break;
        }
      }
      const re = javaFullRegex(regex);
      if (re) ok = rule(re.test(s), `Element value '${s}' does not meet regex '${regex}'`) && ok; // TYPE_SPECIFIC_CHECKS_DT_PRIMITIVE_REGEX
      else issues.push({ severity: "information", path, code: "informational", message: `The regex '${regex}' of this element could not be compiled, so it was not checked`, unchecked: { kind: "limit", canonical: VALIDATOR_LIMITS.regex } });
    }

    if (typeCode === "boolean") ok = rule(s === "true" || s === "false", "Boolean values must be 'true' or 'false'") && ok;
    if (typeCode === "uri" || typeCode === "oid" || typeCode === "uuid" || typeCode === "url" || typeCode === "canonical") {
      const url = s;
      ok = rule(!url.startsWith("oid:"), "URI values cannot start with oid:") && ok;
      ok = rule(!url.startsWith("uuid:"), "URI values cannot start with uuid:") && ok;
      ok = rule(url === javaTrimWS(url).replace(/ /g, "") || url === "http://www.acme.com/identifiers/patient or urn:ietf:rfc:3986 if the Identifier.value itself is a full uri", `URI values cannot have whitespace('${url}')`) && ok;
      ok = lengthOk() && ok;
      if (typeCode === "oid") ok = rule(url.startsWith("urn:oid:"), "OIDs must start with urn:oid:") && ok;
      if (typeCode === "uuid") ok = rule(url.startsWith("urn:uuid:"), "UUIDs must start with urn:uuid:") && ok;
      if (typeCode === "canonical") ok = rule(url.startsWith("#") || javaIsAbsoluteUrl(url), `Canonical URLs must be absolute URLs if they are not fragment references (${url})`) && ok;
      // TYPE_SPECIFIC_CHECKS_DT_UUID_VALID / _OID_VALID and URL resolution (validateReference) are reported by checkUri;
      // they still clear Java's `ok`
      const syn = urnSyntaxIssue(url, typeCode);
      if (syn && !/^URI values cannot start with/.test(syn)) ok = false;
      // TYPE_SPECIFIC_CHECKS_DT_URL_EXAMPLE: reported by checkUri, only for a URL that does not resolve (review F23)
    }
    if (typeCode === "id" && el.path !== "ElementDefinition.id") ok = rule(ID_RE.test(s), `id value '${s}' is not valid`) && ok;
    if (typeCode === "string") {
      if (rule(s.length > 0, "value cannot be empty")) {
        if (warning(!isJavaAllWhitespace(s), `value should not be all whitespace '${prepWSPresentation(s)}'`)) {
          warning(javaTrimWS(s) === s, `value should not start or finish with whitespace '${prepWSPresentation(s)}'`);
        }
        if (rule(s.length <= 1048576, "value is longer than permitted maximum length of 1 MB (1048576 bytes)")) ok = lengthOk() && ok;
        else ok = false;
      } else ok = false;
    }
    // IV:3632: not the comment of an ElementDefinition describing a narrative div (`.comment` next to a path `….text.div`)
    const divComment = path.endsWith(".comment") && typeof item.parent?.path === "string" && item.parent.path.endsWith(".text.div");
    if (typeCode === "markdown" && this.htmlInMarkdown !== "none" && !divComment) {
      // TYPE_SPECIFIC_CHECKS_DT_MARKDOWN_HTML: MarkDownProcessor.preProcess escapes the HTML-looking tags; the first
      // changed position is quoted (two characters).
      const processed = s.replace(/(?<!\\)<(\/)?([A-Za-z][A-Za-z0-9-]*[\s>])/g, "\\<$1$2").replace(/<(!|\?)/g, "\\<$1");
      if (processed !== s) {
        let i = 0;
        while (i < s.length && s.charAt(i) === processed.charAt(i)) i++;
        const at = i < s.length - 1 ? s.slice(i, i + 2) : s;
        const message = `The markdown contains content that appears to be an embedded HTML tag starting at '${at}'. This will (or SHOULD) be escaped by the presentation layer. The content should be checked to confirm that this is the desired behaviour`;
        if (this.htmlInMarkdown === "error") ok = rule(false, message) && ok;
        else warning(false, message);
      }
    }
    // checkMinMaxValueDate[Time] l. 3715-3726, 3738-3749: a duration before / after now (the date message prints the
    // limit by day, the dateTime one to the millisecond; the max message prints the value by day, the min one toString())
    const dateQuantityRules = (value: string, showLimit: (d: Date) => string): boolean => {
      let good = true;
      for (const which of ["max", "min"] as const) {
        const q = dateQuantityBound(el, which);
        if (!q) continue;
        const qty = `${q.comparator ?? ""}${q.value}${q.system === "http://unitsofmeasure.org" ? "" : ` ${q.system}#`}${q.code}`;
        if (!rule(q.comparator === undefined, `Comparators are not supported for min/maxValue when restricting date/time values with a Duration ('${qty}')`) || !rule(quantityIsExactTime(q), `The quantity value '${qty}' is not supported for min/maxValue when restricting date/time values with a Duration`)) {
          good = false;
          continue;
        }
        const limit = nowShifted(q, which === "max" ? 1 : -1);
        const at = dateStartMs(value);
        const shown = this.relativeDatePlaceHolder ?? showLimit(limit);
        if (which === "max") {
          const day = /^(-?\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/.exec(value);
          good = rule(!(limit.getTime() < at), `The date/time value '${day ? `${day[1]}-${day[2] ?? "01"}-${day[3] ?? "01"}` : value}' is not legal: maxValue is ${qty} after now (which is ${shown})`) && good;
        } else {
          good = rule(!(limit.getTime() > at), `The date/time value 'DateTimeType[${value}]' is not legal: minValue is ${qty} before now (which is ${shown})`) && good;
        }
      }
      return good;
    };
    if (typeCode === "dateTime") {
      let dok = (ok = rule(DATETIME_JAVA_RE.test(s), `Not a valid date/time format: '${s}'`) && ok);
      if (coreProfile || (dateRules ?? "").includes("tz-for-time")) {
        dok = rule(!s.includes("T") || (s.length > 10 && /[-+Z]/.test(s.slice(10))), "If a date has a time, it must have a timezone") && dok;
      }
      // checkMinMaxValueDateTime: an unreadable date/time is TYPE_SPECIFIC_CHECKS_DT_DATETIME_VALID
      if (dok) dok = rule(validCalendarDate(s), `Not a valid date/time format: '${s}'`) && dok;
      if (dok) dok = rule(dateMinOk(el, s), `date/time value is less than permitted minimum value of ${dateMin(el)}`) && dok;
      if (dok) dok = dateQuantityRules(s, localMilli) && dok;
      dok = lengthOk() && dok;
      if (dok && (coreProfile || dateRules === null || dateRules.includes("year-valid"))) {
        warning(yearIsValid(s), `The value '${s}' is outside the range of reasonable years - check for data entry error`);
      }
      ok = ok && dok;
    }
    if (typeCode === "time") {
      ok = rule(/^([01][0-9]|2[0-3]):[0-5][0-9]:([0-5][0-9]|60)$/.test(s), `The time '${s}' is not a valid time`) && ok;
      if (ok) {
        // TYPE_SPECIFIC_CHECKS_DT_DT_GT / _LT (maxValueTime / minValueTime)
        if (typeof el.maxValueTime === "string") ok = rule(!(el.maxValueTime < s), `date/time value is greater than permitted maximum value of ${el.maxValueTime}`) && ok;
        if (typeof el.minValueTime === "string") ok = rule(!(el.minValueTime > s), `date/time value is less than permitted minimum value of ${el.minValueTime}`) && ok;
      }
    }
    if (typeCode === "date") {
      let dok = rule(new RegExp(`^${YEAR}(-${MONTH}(-${DAY})?)?$`).test(s), `Not a valid date format: '${s}'`);
      // checkMinMaxValueDate: an unreadable date is TYPE_SPECIFIC_CHECKS_DT_DATE_VALID
      if (dok) dok = rule(validCalendarDate(s), `Not a valid date format: '${s}'`) && dok;
      if (dok) dok = rule(dateMinOk(el, s), `date/time value is less than permitted minimum value of ${dateMin(el)}`) && dok;
      if (dok) dok = dateQuantityRules(s, localDay) && dok;
      dok = lengthOk() && dok;
      if (dok && (coreProfile || (dateRules ?? "").includes("year-valid"))) {
        warning(yearIsValid(s), `The value '${s}' is outside the range of reasonable years - check for data entry error`);
      }
      ok = ok && dok;
    }
    if (typeCode === "base64Binary") {
      if (!isBase64Valid(s)) {
        ok = rule(false, `The value '${s.length < 100 ? s : "(snip)"}' is not a valid Base64 value`) && ok;
      } else {
        warning(!/\s/.test(s), "Base64 encoded values SHOULD not contain any whitespace (per RFC 4648). Note that non-validating readers are encouraged to accept whitespace anyway");
      }
    }
    if (typeCode === "integer" || typeCode === "unsignedInt" || typeCode === "positiveInt") {
      if (rule(isJavaInteger(s), `The value '${s}' is not a valid integer`)) {
        const n = Number(s);
        this.checkMinMaxValue(el, n, path, issues);
        if (typeCode === "unsignedInt") ok = rule(n >= 0, "value is less than permitted minimum value of 0") && ok;
        if (typeCode === "positiveInt") ok = rule(n > 0, "value is less than permitted minimum value of 1") && ok;
      } else ok = false;
    }
    if (typeCode === "integer64") {
      if (!rule(isJavaLong(s), `The value '${s}' is not a valid integer64`)) ok = false;
    }
    if (typeCode === "decimal") {
      const ds = javaCheckDecimal(s);
      if (rule(ds === "ok" || ds === "range", `The value '${s}' is not a valid decimal`)) {
        warning(ds !== "range", `The value '${s}' is outside the range of commonly/reasonably supported decimals`, "value");
        this.checkMinMaxValue(el, Number(s), path, issues, "decimal");
      } else ok = false;
    }
    if (typeCode === "instant") {
      let dok = rule(INSTANT_JAVA_RE.test(s), `Not a valid instant format: '${s}'`);
      if (dok) dok = rule(validCalendarDate(s.replace(/^-/, "")), `Not a valid date/time format: '${s}'`) && dok;
      if (dok) dok = rule(dateMinOk(el, s), `date/time value is less than permitted minimum value of ${dateMin(el)}`) && dok;
      if (dok) dok = dateQuantityRules(s, localMilli) && dok;
      if (dok && (coreProfile || (dateRules ?? "").includes("year-valid"))) {
        warning(yearIsValid(s), `The value '${s}' is outside the range of reasonable years - check for data entry error`);
      }
      ok = ok && dok;
    }
    if (typeCode === "code") {
      ok = rule(passesCodeWhitespaceRules(s), `The code '${s}' is not valid (whitespace rules)`) && ok;
      ok = lengthOk() && ok;
    }
    // ID_EXEMPT_LIST = id, base64Binary, markdown; regex from the type's StructureDefinition (FHIRPathExpressionFixer.fixRegex)
    if (ok && !["id", "base64Binary", "markdown"].includes(typeCode)) {
      const regext = R4_TYPE_REGEX[typeCode];
      if (regext && !javaFullRegex(regext)!.test(s)) {
        rule(false, `Element value '${s}' does not meet ${typeCode} regex '${regext}'`);
      }
    }
  }

  private inExampleExemptContext(path: string): boolean {
    // (parity v3 round 5) meta.profile is NOT exempt: InstanceValidator.checkPrimitive (l. 3412-3418) sends every
    // canonical but Bundle.entry.fullUrl / a defining url to validateReference, whose canonical branch (l. 3986-3998)
    // reports TYPE_SPECIFIC_CHECKS_DT_URL_EXAMPLE for an unresolved example URL (evaluator corpus: meta.profile[n]
    // 'http://example.org/fhir/StructureDefinition/unknown' → error in validator_cli 7.0.1)
    return /\.(implicitRules)$/.test(path);
  }

  /**
   * InstanceValidator.checkPrimitive min / max value rules: TYPE_SPECIFIC_CHECKS_DT_INTEGER_GT / _LT (integer types:
   * maxValueInteger / minValueInteger) and TYPE_SPECIFIC_CHECKS_DT_DECIMAL_GT / _LT (decimal: maxValueDecimal, else
   * maxValueInteger).
   */
  private checkMinMaxValue(el: Record<string, any>, v: number, path: string, issues: Issue[], typeCode = "integer"): void {
    const dec = typeCode === "decimal";
    const lim = (kind: "max" | "min"): number | null => {
      const d = el[`${kind}ValueDecimal`];
      const i = el[`${kind}ValueInteger`];
      if (dec && typeof d === "number") return d;
      return typeof i === "number" ? i : null;
    };
    const label = dec ? "decimal" : "integer";
    const max = lim("max");
    const min = lim("min");
    // the decimal branch passes the DecimalType / IntegerType itself, so the message shows PrimitiveType.toString()
    const show = (kind: "max" | "min", n: number): string =>
      !dec ? String(n) : typeof el[`${kind}ValueDecimal`] === "number" ? `DecimalType[${n}]` : `IntegerType[${n}]`;
    if (max !== null && v > max) issues.push({ severity: "error", path, code: "invalid", message: `${label} value is greater than permitted maximum value of ${show("max", max)}` });
    if (min !== null && v < min) issues.push({ severity: "error", path, code: "invalid", message: `${label} value is less than permitted minimum value of ${show("min", min)}` });
  }

  /**
   * Port of InstanceValidator.checkFixedValue (7.0.1) for an element's fixed[x] / pattern[x]: primitives compared by
   * their string value (_DT_Fixed_Wrong, context = <profile|version>#<element id>); complex types field by field
   * (Profile_VAL_MissingElement / Profile_VAL_NotAllowed — the latter for a fixed value only); a CodeableConcept pattern
   * needs each pattern coding matched by one coding of the instance (TYPE_CHECKS_PATTERN_CC), a fixed one the same
   * codings in order; a fixed value without extensions bans extensions on the instance (Extension_EXT_Fixed_Banned).
   */
  /**
   * The fixed / pattern check of one element. A primitive: checkPrimitive l. 3658 — after the blank-value return of
   * l. 3236, so a blank value is not compared — with `#<its id>`; with inline children validateElement l. 7725 runs
   * too and does compare it (validator_cli: `Value is ' ' but is fixed to …`, only when the profile has
   * Patient.gender.extension). A complex element: checkChildByDefinition l. 8021,
   * with `#<the parent definition's id>` (`definition` there). Primitives inside a complex fixed value are compared
   * by the complex check, blank or not (checkCoding → checkFixedValue).
   */
  private checkFixedPattern(el: Record<string, any>, v: any, item: Item, sdx: SdIndex, issues: Issue[], primitive = false): void {
    if (primitive && typeof v === "string" && isJavaBlank(v) && !sdx.hasChildren(el)) return;
    const [fixed, pattern] = fixedPattern(el);
    if (fixed && isPrimitive(String(fixed.field.replace(/^fixed/u, "")).replace(/^./u, (c: string) => c.toLowerCase())) && isObject(item.ext) && Array.isArray(item.ext.extension) && item.ext.extension.length) {
      // checkFixedValue l. 3120-3122: EXTENSION_EXT_FIXED_BANNED also for a primitive's extensions
      issues.push({ severity: "error", path: item.path, code: "value", message: "No extensions allowed, as the specified fixed value doesn't contain any extensions", element: el.id, profile: sdx.url });
    }
    const source = `${sdx.url}${sdx.sd?.version ? `|${sdx.sd.version}` : ""}`;
    const ownId = String(el.id ?? el.path);
    const context = `${source}#${primitive ? ownId : ownId.replace(/\.[^.]*$/u, "")}`;
    const tag = (list: Issue[]): void => {
      for (const i of list) issues.push({ ...i, element: el.id, profile: sdx.url });
    };
    if (fixed) {
      const out: Issue[] = [];
      this.fixedValuePort(out, item.path, v, fixed.value, fixed.field.replace(/^fixed/u, ""), source, String(el.sliceName ?? ""), false, context, isObject(item.ext) ? item.ext : undefined);
      tag(out);
    }
    if (pattern) {
      const out: Issue[] = [];
      this.fixedValuePort(out, item.path, v, pattern.value, pattern.field.replace(/^pattern/u, ""), source, String(el.sliceName ?? ""), true, context);
      tag(out);
    }
  }

  private fixedValuePort(issues: Issue[], path: string, focus: any, fixed: any, type: string, source: string, propName: string, pattern: boolean, context: string, shadow?: any): void {
    const empty = (x: any): boolean => x === undefined || x === null || (isObject(x) && Object.keys(x).length === 0) || (Array.isArray(x) && x.length === 0);
    if (empty(fixed) && (focus === undefined || focus === null)) return;
    if (empty(fixed)) {
      if (!pattern) issues.push({ severity: "error", path, code: "value", message: `The element ${propName} is present in the instance but not allowed in the applicable fixed value specified in profile` });
      return;
    }
    if (focus === undefined || focus === null) {
      issues.push({ severity: "error", path, code: "value", message: `Missing element '${propName}' - required by fixed value assigned in profile ${source}` });
      return;
    }
    if (!isObject(fixed)) {
      const value = isObject(focus) || Array.isArray(focus) ? null : String(focus);
      if (value !== String(fixed)) issues.push({ severity: "error", path, code: "value", message: `Value is '${value ?? ""}' but is fixed to '${String(fixed)}' in the profile ${context}` });
      // checkFixedValue, end: a primitive's extensions (its `_x` shadow), which a primitive fixed value here never has
      if (shadow && Array.isArray(shadow.extension) && shadow.extension.length > 0 && !pattern) {
        issues.push({ severity: "error", path, code: "value", message: "No extensions allowed, as the specified fixed value doesn't contain any extensions" });
      }
      return;
    }
    if (!isObject(focus)) {
      issues.push({ severity: "error", path, code: "value", message: `Missing element '${propName}' - required by fixed value assigned in profile ${source}` });
      return;
    }
    if (type === "CodeableConcept") {
      this.fixedValuePort(issues, `${path}.text`, focus.text, fixed.text, "string", source, "text", pattern, context);
      const codings: any[] = Array.isArray(focus.coding) ? focus.coding : [];
      const fixedCodings: any[] = Array.isArray(fixed.coding) ? fixed.coding : [];
      if (pattern) {
        if (codings.length < fixedCodings.length) {
          issues.push({ severity: "error", path, code: "value", message: `Expected ${fixedCodings.length} but found ${codings.length} coding elements` });
        } else {
          for (const fc of fixedCodings) {
            const all: Issue[] = [];
            let found = false;
            for (const c of codings) {
              const e: Issue[] = [];
              this.fixedValuePort(e, `${path}.coding`, c, fc, "Coding", source, "coding", true, context);
              if (!e.some((x) => x.severity === "error")) {
                found = true;
                break;
              }
              all.push(...e.filter((x) => x.severity === "error"));
            }
            if (!found) {
              const us = isObject(fc) && fc.userSelected !== undefined;
              // List<ValidationMessage>.toString(): ValidationMessage.toString (ToStringStyle.SHORT_PREFIX_STYLE)
              const list = `[${all.map((x) => `ValidationMessage[level=ERROR,type=VALUE,location=${x.path},message=${x.message}]`).join(", ")}]`;
              issues.push({
                severity: "error",
                path,
                code: "value",
                message: us
                  ? `The pattern [system ${fc.system ?? null}, code ${fc.code ?? null}, display '${fc.display ?? null}' and userSelected ${fc.userSelected}] defined in the profile ${source} not found. Issues: ${list}`
                  : `The pattern [system ${fc.system ?? null}, code ${fc.code ?? null}, and display '${fc.display ?? null}'] defined in the profile ${source} not found. Issues: ${list}`,
              });
            }
          }
        }
      } else if (codings.length !== fixedCodings.length) {
        issues.push({ severity: "error", path, code: "value", message: `Expected ${fixedCodings.length} but found ${codings.length} coding elements` });
      } else {
        codings.forEach((c, i) => this.fixedValuePort(issues, `${path}.coding`, c, fixedCodings[i], "Coding", source, "coding", false, context));
      }
    } else if (type === "HumanName") {
      // InstanceValidator.checkHumanName (7.0.1, l. 3139-3195): use / text / period, then family / given / prefix / suffix
      // counted into ONE list (Element.getNamedChildren appends — the counts include the earlier parts) and compared
      // with the fixed list's length, items pairwise
      const sub = (k: string): void => this.fixedValuePort(issues, `${path}.${k}`, focus[k], fixed[k], k === "period" ? "Period" : "", source, k, pattern, context);
      sub("use");
      sub("text");
      sub("period");
      const kids = (k: string): any[] => (Array.isArray(focus[k]) ? focus[k] : focus[k] === undefined || focus[k] === null ? [] : [focus[k]]);
      const parts: any[] = [];
      if (!pattern || fixed.family !== undefined) {
        parts.push(...kids("family"));
        const has = fixed.family !== undefined && fixed.family !== null;
        if ((parts.length > 0) === has) {
          for (const x of parts) this.fixedValuePort(issues, `${path}.family`, x, fixed.family, "", source, "family", pattern, context);
        } else issues.push({ severity: "error", path, code: "value", message: `Expected ${has ? "1" : "0"} but found ${parts.length} family elements` });
      }
      for (const k of ["given", "prefix", "suffix"]) {
        const fl: any[] = Array.isArray(fixed[k]) ? fixed[k] : [];
        if (pattern && !fl.length) continue;
        parts.push(...kids(k));
        if (parts.length === fl.length) {
          parts.forEach((x, i) => this.fixedValuePort(issues, `${path}.${k}`, x, fl[i], "", source, k, pattern, context));
        } else issues.push({ severity: "error", path, code: "value", message: `Expected ${fl.length} but found ${parts.length} ${k} elements` });
      }
    } else if (type === "Timing") {
      // InstanceValidator.checkTiming (7.0.1, l. 5663-5675): repeat (reported as 'value'), then the events pairwise after
      // a count check (Bundle_MSG_Event_Count); Timing.code is not compared
      this.fixedValuePort(issues, `${path}.repeat`, focus.repeat, fixed.repeat, "", source, "value", pattern, context);
      const ev: any[] = Array.isArray(focus.event) ? focus.event : [];
      const fe: any[] = Array.isArray(fixed.event) ? fixed.event : [];
      if (ev.length === fe.length) ev.forEach((x, i) => this.fixedValuePort(issues, `${path}.event`, x, fe[i], "", source, "event", pattern, context));
      else issues.push({ severity: "error", path, code: "value", message: `Expected ${fe.length} but found ${ev.length} event elements` });
    } else if (type === "Address") {
      // InstanceValidator.checkAddress (7.0.1, l. 1171-1221): use / text / city / state / country; postalCode is read from a
      // `zip` child (never present — a fixed postalCode is reported missing); district / type / period are not compared;
      // a pattern's unmatched line is recorded in a discarded list (not reported)
      for (const k of ["use", "text", "city", "state", "country"]) this.fixedValuePort(issues, `${path}.${k}`, focus[k], fixed[k], "", source, k, pattern, context);
      this.fixedValuePort(issues, `${path}.zip`, focus.zip, fixed.postalCode, "", source, "postalCode", pattern, context);
      const lines: any[] = Array.isArray(focus.line) ? focus.line : [];
      const fl: any[] = Array.isArray(fixed.line) ? fixed.line : [];
      if (pattern ? lines.length >= fl.length : lines.length === fl.length) {
        if (!pattern) lines.forEach((x, i) => this.fixedValuePort(issues, `${path}.line`, x, fl[i], "", source, "line", false, context));
      } else issues.push({ severity: "error", path, code: "value", message: `Expected ${fl.length} but found ${lines.length} line elements` });
    } else if (FIXED_TYPE_FIELDS[type]) {
      // InstanceValidator.checkContactPoint / checkIdentifier / checkAttachment / checkReference / checkRange /
      // checkRatio / checkPeriod / checkSampledData / checkCoding / checkQuantity (fixed) (7.0.1): exactly these fields,
      // each through checkFixedValue with the field's own type; getNamedChild → the first value of a list
      const first = (x: any): any => (Array.isArray(x) ? x[0] : x);
      for (const [k, sub] of FIXED_TYPE_FIELDS[type]) {
        this.fixedValuePort(issues, `${path}.${k}`, first(focus[k]), first(fixed[k]), sub, source, k, pattern, context);
      }
    } else {
      // every other datatype: its fields one by one (lists: each fixed item matched — by any item for a pattern, in order
      // for a fixed value)
      const keys = new Set([...Object.keys(fixed), ...(pattern ? [] : Object.keys(focus))]);
      for (const k of keys) {
        if (k === "extension" || k === "id" || k.startsWith("_")) continue;
        const fv = fixed[k];
        const iv = focus[k];
        if (Array.isArray(fv) || Array.isArray(iv)) {
          const fl: any[] = Array.isArray(fv) ? fv : fv === undefined ? [] : [fv];
          const il: any[] = Array.isArray(iv) ? iv : iv === undefined ? [] : [iv];
          if (pattern) {
            for (const f of fl) {
              const ok = il.some((x) => {
                const e: Issue[] = [];
                this.fixedValuePort(e, `${path}.${k}`, x, f, "", source, k, true, context);
                return !e.length;
              });
              if (!ok) this.fixedValuePort(issues, `${path}.${k}`, il[0], f, "", source, k, true, context);
            }
          } else {
            const n = Math.max(fl.length, il.length);
            for (let i = 0; i < n; i++) this.fixedValuePort(issues, `${path}.${k}`, il[i], fl[i], "", source, k, false, context);
          }
          continue;
        }
        this.fixedValuePort(issues, `${path}.${k}`, iv, fv, k === "coding" ? "Coding" : "", source, k, pattern, context);
      }
    }
    const fixedExt = Array.isArray(fixed.extension) ? fixed.extension : [];
    const ext = Array.isArray(focus.extension) ? focus.extension : [];
    if (!fixedExt.length && ext.length && !pattern) issues.push({ severity: "error", path, code: "value", message: "No extensions allowed, as the specified fixed value doesn't contain any extensions" });
  }


  /**
   * (v17.5) tx.fhir.org validates a coding against a bound ValueSet in the resource's language: when that language is
   * not English and the terminology has no designation in it (SNOMED CT International, LOINC here), the only valid
   * display is the one the ValueSet itself lists for the code (an enumerated include.concept display — e.g. IPS
   * target-diseases-uv-ips 'Pertussis (disorder)'); validator_cli then reports any other display as an error
   * (probed: language zh-TW / fr-LU → error, en-US / none → no error; intensional ValueSets are not affected).
   */
  private async checkLanguageDisplay(el: Record<string, any>, v: any, typeCode: string, item: Item, rctx: ResourceCtx, issues: Issue[]): Promise<void> {
    const lang = typeof rctx.resource?.language === "string" ? rctx.resource.language.trim() : "";
    if (!lang || /^en(?:-|$)/iu.test(lang)) return;
    const b = el.binding;
    if (!b || !b.valueSet || !["required", "extensible", "preferred"].includes(b.strength)) return;
    if (typeCode !== "Coding" && typeCode !== "CodeableConcept") return;
    const vs = await this.vsHeader(String(b.valueSet));
    if (!vs) return;
    const list: any[] = typeCode === "Coding" ? [v] : isObject(v) && Array.isArray(v.coding) ? v.coding : [];
    const primary = lang.split("-")[0].toLowerCase();
    list.forEach((c, k) => {
      if (!isObject(c) || typeof c.display !== "string" || !c.display || typeof c.code !== "string") return;
      if (c.system !== "http://snomed.info/sct" && c.system !== "http://loinc.org") return;
      let listed: string | null = null;
      let inLanguage = false;
      for (const inc of (isObject(vs.compose) && Array.isArray(vs.compose.include) ? vs.compose.include : []) as any[]) {
        if (!isObject(inc) || inc.system !== c.system) continue;
        for (const cc of Array.isArray(inc.concept) ? inc.concept : []) {
          if (!isObject(cc) || cc.code !== c.code) continue;
          if (typeof cc.display === "string" && cc.display) listed = cc.display;
          for (const d of Array.isArray(cc.designation) ? cc.designation : []) {
            if (isObject(d) && typeof d.language === "string" && d.language.split("-")[0].toLowerCase() === primary) inLanguage = true;
          }
        }
      }
      if (!listed || inLanguage || c.display.trim().toLowerCase() === listed.trim().toLowerCase()) return;
      issues.push({
        severity: "error",
        path: typeCode === "Coding" ? `${item.path}.display` : `${item.path}.coding[${k}].display`,
        code: "invalid",
        message: `Wrong Display Name '${c.display}' for ${c.system}#${c.code}. Valid display is '${listed}' (for the language(s) '${lang}')`,
      });
    });
  }

  /**
   * ValueSetValidator.scanForCodeInValueSet (7.0.1): the number of include systems that define `code` — enumerated
   * includes by their concept list, whole-system includes by the CodeSystem. null when undecidable here (imports,
   * filters, an unknown CodeSystem: the HL7 validator reports other messages for those, which are not reproduced).
   */
  /**
   * A value set pinning the version of a system validates the code in that version (determineVersion): the message names
   * it — instead of the unbound one for a coding of a CodeableConcept, besides it for a Coding element, which the
   * validator also checks on its own (official corpus: v3-RoleCode '3.0.0', Encounter.class v3-ActCode '9.0.0' and '11.0.0').
   */
  private async pinnedUnknownCode(vs: Record<string, any>, list: any[], typeCode: string, item: Item, issues: Issue[]): Promise<void> {
    if (typeCode !== "Coding" && typeCode !== "CodeableConcept") return;
    const includes: any[] = isObject(vs.compose) && Array.isArray(vs.compose.include) ? vs.compose.include : [];
    for (const [i, c] of list.entries()) {
      if (!isObject(c) || typeof c.system !== "string" || typeof c.code !== "string" || !c.code || c.version) continue;
      const pins = new Set(includes.filter((x) => isObject(x) && x.system === c.system && typeof x.version === "string" && x.version).map((x) => String(x.version)));
      if (pins.size !== 1) continue;
      const r = await this.codeCheck(c.system, c.code, null, null);
      if (r.status !== "invalid-code" || r.severity !== "error" || !r.message.startsWith("Unknown code") || c.system === "http://snomed.info/sct" || c.system === "http://loinc.org") continue;
      const message = `Unknown code '${c.code}' in the CodeSystem '${c.system}' version '${[...pins][0]}'`;
      const at = typeCode === "Coding" ? `${item.path}.code` : `${item.path}.coding[${i}].code`;
      const held = issues.find((x) => x.path === at && x.message === r.message);
      if (held && typeCode === "CodeableConcept") held.message = message;
      else if (!issues.some((x) => x.path === at && x.message === message)) issues.push({ severity: "error", path: at, code: "code-invalid", message });
    }
  }

  /** The issue of an invalid-code answer; one local data could not decide carries `unchecked` (F5). */
  private invalidCodeIssue(r: Extract<CodeCheck, { status: "invalid-code" }>, path: string, system: string): Issue {
    const note = r.severity === "information";
    return { severity: r.severity, path, code: note ? "informational" : "code-invalid", message: r.message, ...(r.undecided ? { unchecked: { kind: "code" as const, canonical: system } } : {}) };
  }

  /** "; <code system message>" for a Coding its CodeSystem rejects (the {1} of Terminology_TX_NoValid_12). */
  private async codeProblem(c: any): Promise<string> {
    if (!isObject(c) || typeof c.system !== "string" || typeof c.code !== "string") return "";
    const r = await this.codeCheck(c.system, c.code, null, typeof c.version === "string" ? c.version : null);
    return r.status === "invalid-code" && !r.undecided ? `; ${r.message}` : "";
  }

  private async inferCodeSystems(vs: Record<string, any>, code: string): Promise<Set<string> | null> {
    const includes = isObject(vs.compose) && Array.isArray(vs.compose.include) ? vs.compose.include : [];
    if (!includes.length) return null;
    // SystemWithVersion: system|version when the include pins one
    const found = new Set<string>();
    for (const inc of includes) {
      if (!isObject(inc)) continue;
      if (Array.isArray(inc.valueSet) && inc.valueSet.length) return null;
      const system = typeof inc.system === "string" ? inc.system : null;
      if (!system) return null;
      if (Array.isArray(inc.filter) && inc.filter.length) return null;
      const key = typeof inc.version === "string" && inc.version ? `${system}|${inc.version}` : system;
      if (Array.isArray(inc.concept) && inc.concept.length) {
        if (inc.concept.some((c: any) => isObject(c) && c.code === code)) found.add(key);
        continue;
      }
      const r = await this.codeCheck(system, code, null, null);
      if (r.status === "unknown-system" || r.undecided) return null;
      if (r.status !== "invalid-code") found.add(key);
    }
    return found;
  }

  /** parseChildPrimitiveInstance: the JSON type a primitive needs is the one of the type its property names. */
  private parsedPrimitiveShape(v: unknown, item: Item, npath: string, issues: Issue[]): void {
    const spec = item.actualType ? PRIMITIVES[item.actualType] : undefined;
    if (spec && typeof v !== spec.json) issues.push({ severity: "error", path: npath, code: "structure", message: `Error parsing JSON: the primitive value must be a ${spec.json}` });
  }

  /** checkPrimitive with `type` on a value of another type: the type's own value rules, not its regex (that one is e.fhirType()'s, l. 3665). */
  private valueAsDeclaredType(text: string, item: Item, path: string, type: string, el: Record<string, any>, profile: Record<string, any> | null | undefined, issues: Issue[]): void {
    if (type === "boolean") {
      if (text !== "true" && text !== "false") issues.push({ severity: "error", path, code: "invalid", message: "Boolean values must be 'true' or 'false'" });
      return;
    }
    const own: Issue[] = [];
    this.checkPrimitiveValue(text, { ...item, path }, type, el, profile ?? null, own);
    for (const i of own) if (!i.message.includes(`does not meet ${type} regex '`)) issues.push(i);
  }

  /**
   * checkChildByDefinition on a complex value whose profile wants primitive `typeCode` (the parser built it as its base
   * type): the element is walked against the primitive's definition, so `value` is checkPrimitive's ILLEGAL_PROPERTY and
   * an Extension_PROF_Type, anything but id / extension is Validation_VAL_Profile_NotAllowed.
   */
  private async complexAsPrimitive(v: Record<string, any>, item: Item, typeCode: string, issues: Issue[]): Promise<void> {
    const tsdx = await this.sdx(CORE + typeCode);
    const vurl = `${CORE}${typeCode}${tsdx?.sd?.version ? `|${tsdx.sd.version}` : ""}`;
    const own = item.actualType ? await this.sdx(CORE + item.actualType) : null;
    const childType = (key: string): string | null => {
      const g = own?.children(own.root)?.get(key);
      const d = g?.base || g?.slices[0];
      return d?.type?.length === 1 ? typeCodeOf(d.type[0]) : null;
    };
    for (const key of Object.keys(v)) {
      if (key.startsWith("_") || key === "id" || key === "extension") continue;
      if (key !== "value") {
        issues.push({ severity: "error", path: `${item.path}.${key}`, code: "structure", message: `This element is not allowed by the profile ${vurl}` });
        continue;
      }
      issues.push({ severity: "error", path: item.path, code: "invalid", message: "The property 'value' is invalid" });
      // the primitive's `value` element: TypeRefComponent.getWorkingCode is its structuredefinition-fhir-type extension
      const vd = tsdx?.children(tsdx.root)?.get("value");
      const vt = (vd?.base || vd?.slices[0])?.type?.[0];
      const working = (Array.isArray(vt?.extension) ? vt.extension : []).find((x: any) => isObject(x) && x.url === FHIR_TYPE_EXT)?.valueUrl;
      const declared = typeof working === "string" ? working : typeCode;
      const found = childType("value");
      if (found && found !== declared) issues.push({ severity: "error", path: `${item.path}.value`, code: "structure", message: `The Profile '${vurl}' definition allows for the type ${declared} but found type ${found}` });
      this.valueAsDeclaredType(String(v.value), item, `${item.path}.value`, declared, {}, null, issues);
    }
  }

  private async checkBinding(
    el: Record<string, any>,
    v: any,
    typeCode: string,
    item: Item,
    issues: Issue[],
    _unused: null,
  ): Promise<void> {
    const b = el.binding;
    if (!b || !b.valueSet) return;
    // a value of another type validated as a primitive of the profile (Extension_EXT_Type): checkPrimitive's blank value
    // (IV:3250 Terminology_TX_Code_ValueSet_MISSING), its children are not in that type (Validation_VAL_Profile_NotAllowed)
    if (item.profileType && ["code", "string", "uri", "url", "canonical"].includes(typeCode) && isObject(v)) {
      if (b.strength === "required") issues.push({ severity: "error", path: item.path, code: "code-invalid", message: "No code provided, and a code is required from the value set" });
      return;
    }
    // the parser reports `coding` not being an array and keeps the value
    if (typeCode === "CodeableConcept" && isObject(v) && isObject(v.coding)) v = { ...v, coding: [v.coding] };
    const strength = b.strength;
    if (typeCode !== "Coding" && (strength === "required" || strength === "extensible" || strength === "preferred")) this.boundValueSets.add(stripVersion(String(b.valueSet)));
    if ((strength === "required" || strength === "extensible" || strength === "preferred") && (typeCode === "Coding" || typeCode === "CodeableConcept")) {
      await this.checkCodingVersions(b.valueSet, v, typeCode, item, issues);
    }
    // checkPrimitiveBinding / checkBindings (7.0.1): a binding whose ValueSet cannot be resolved but names a CodeSystem
    // is Terminology_TX_ValueSet_NotFound_CS (error), whatever the strength
    if (strength && ["code", "Coding", "CodeableConcept", "Quantity", "string", "uri", "url", "canonical", "CodeableReference"].includes(typeCode) && this.resolver.codeSystemExists) {
      const ref = String(b.valueSet);
      if (!(await this.vsHeader(ref)) && (await this.resolver.codeSystemExists(ref).catch(() => false))) {
        issues.push({ severity: "error", path: item.path, code: "code-invalid", message: `Found a reference to a CodeSystem '${ref}' where a ValueSet belongs` });
        return;
      }
    }
    if (typeCode === "CodeableConcept" && strength && strength !== "example" && (await this.codelessCodingIssues(v, item, issues))) return;
    if (strength !== "required" && strength !== "extensible") return;
    // checkPrimitiveBinding: code, string, uri, url, canonical
    if (!["code", "Coding", "CodeableConcept", "Quantity", "string", "uri", "url", "canonical", "CodeableReference"].includes(typeCode)) return;
    // UCUM quantities are judged by UCUM unit semantics in the HL7 validator
    // (e.g. L/min accepted against ucum-vitals-common); we cannot reproduce that
    // offline, so only non-UCUM coded quantities are checked against the binding.
    if (typeCode === "Quantity" && (!isObject(v) || v.code === undefined || v.system === "http://unitsofmeasure.org")) return;
    // The binding's ValueSet canonical is used as written: `|version` pins that
    // version (BaseValidator.resolveBindingReference → findTxResource → fetchResource).
    const url = String(b.valueSet);
    const vs = await this.vsHeader(url);
    const label = vs ? `'${vs.title || vs.name || url}' (${vs.version && !url.includes("|") ? `${url}|${vs.version}` : url})` : `'${url}'`;
    if (!vs) {
      if (strength === "required") {
        // Terminology_TX_ValueSet_NotFound (warning): the binding is not checked.
        issues.push({
          severity: "warning",
          path: item.path,
          code: "not-found",
          message: `ValueSet '${url}' not found`,
          ...((await this.valueSetMayBeAtServer(url)) ? { unchecked: { kind: "valueSet" as const, canonical: url } } : {}),
        });
      }
      return;
    }
    let codings: Array<[string | null, string | null]>;
    if (typeCode === "code" || typeCode === "string" || typeCode === "uri" || typeCode === "url" || typeCode === "canonical") codings = [[null, String(v)]];
    else if (typeCode === "Quantity") codings = [[typeof v.system === "string" ? v.system : null, String(v.code)]];
    else if (typeCode === "CodeableReference") codings = isObject(v) && isObject(v.concept) ? codingsOf(v.concept) : [];
    else codings = codingsOf(v);
    codings = codings.filter(([, c]) => c !== null && c !== "");
    if (!codings.length) {
      // checkTerminologyCodeableConcept l. 1754 cc.hasCoding(): a coding without a code is still a coding, so the value set answers
      const noCode: any[] = typeCode === "CodeableConcept" && isObject(v) && Array.isArray(v.coding) ? v.coding.filter((c: any) => isObject(c) && Object.keys(c).length > 0) : [];
      if (noCode.length) {
        const desc = `'${vs.title || vs.name || url}' (${vs.url}${vs.version ? `|${vs.version}` : ""})`;
        const shown = noCode.map((c) => `${typeof c.system === "string" ? c.system : "null"}#${typeof c.code === "string" ? c.code : "null"}`).join(", ");
        if (strength === "required") issues.push({ severity: "error", path: item.path, code: "code-invalid", message: `None of the codings provided are in the value set ${desc}, and a coding from this value set is required) (codes = ${shown})` });
        else if (strength === "extensible") issues.push({ severity: "warning", path: item.path, code: "code-invalid", message: `None of the codings provided are in the value set ${desc}, and a coding should come from this value set unless it has no suitable code (note that the validator cannot judge what is suitable) (codes = ${shown})` });
        else if (strength === "preferred") issues.push({ severity: "warning", path: item.path, code: "code-invalid", message: `None of the codings provided are in the value set ${desc}, and a coding is recommended to come from this value set (codes = ${shown})` });
        return;
      }
      // checkPrimitive l. 3250: an empty value of a bound primitive
      if (v === "" && strength === "required" && ["code", "string", "uri", "url", "canonical"].includes(typeCode) && !issues.some((i) => i.path === item.path && i.message === "No code provided, and a code is required from the value set")) {
        issues.push({ severity: "error", path: item.path, code: "code-invalid", message: "No code provided, and a code is required from the value set" });
      }
      if (typeCode === "CodeableConcept" && strength === "required") {
        issues.push({ severity: "error", path: item.path, code: "code-invalid", message: `No code provided, and a code is required from the value set '${vs.title || vs.name || url}' (${vs.url}${vs.version ? `|${vs.version}` : ""})` });
      }
      return;
    }
    // checkCodedElement (IV:2405, tag 7.0.1): a Coding is checked against its binding only with both system and code
    if ((typeCode === "Coding" || typeCode === "Quantity") && codings[0][0] === null) return;
    if ((strength === "required" || strength === "extensible") && ["code", "string", "uri", "url", "canonical"].includes(typeCode)) {
      // REVIEW_port_2 G20 — ValueSetValidator.systemForCodeInValueSet (standalone, tag 7.0.1:1603): a bare code that
      // more than one include defines cannot be given a system (UNABLE_TO_RESOLVE_SYSTEM__VALUE_SET_HAS_MULTIPLE_MATCHES)
      const inferred = await this.inferCodeSystems(vs, String(codings[0][1]));
      if (inferred !== null && inferred.size > 1) {
        const vsv = `${vs.url}${vs.version ? `|${vs.version}` : ""}`;
        const multi = `The System URI could not be determined for the code '${codings[0][1]}' in the ValueSet '${vsv}': value set expansion has multiple matches: ${[...inferred].sort().join(",")}`;
        const sev = strength === "required" ? "error" : "warning";
        issues.push({ severity: sev, path: item.path, code: "code-invalid", message: multi });
        issues.push({
          severity: sev,
          path: item.path,
          code: "code-invalid",
          message:
            strength === "required"
              ? `The value provided ('${codings[0][1]}') was not found in the value set ${label}, and a code is required from this value set  (error message = ${multi})`
              : `The value provided ('${codings[0][1]}') was not found in the value set ${label}, and a code should come from this value set unless it has no suitable code (note that the validator cannot judge what is suitable)  (error message = ${multi})`,
        });
        return;
      }
    }
    let anyMember = false;
    let anyUnknown = false;
    let unknownSystemMember = false;
    let otherMiss = false;
    // (parity v1) tx $validate-code checks the display too (ValueSetValidator: a wrong display makes the result not ok):
    // a member whose display the terminology rejects does not satisfy the binding
    let wrongDisplay: { system: string; code: string; message: string; index: number } | null = null;
    const list: any[] = typeCode === "Coding" ? [v] : isObject(v) && Array.isArray(v.coding) ? v.coding : [];
    for (const [system, code] of codings) {
      // ValueSetValidator: a Coding without a system cannot be validated (Coding_has_no_system__cannot_validate) and is
      // never a member — only bare primitive codes infer their system from the value set
      const m = system === null && typeCode !== "code" && typeCode !== "string" && typeCode !== "uri" && typeCode !== "url" && typeCode !== "canonical" ? faceValueMember(vs, code!) : await this.member(url, system, code!);
      if (m === true) {
        const idx = list.findIndex((c) => isObject(c) && c.code === code && (c.system ?? null) === system);
        const c = idx >= 0 ? list[idx] : null;
        if (system && c && typeof c.display === "string" && c.display && (typeCode === "Coding" || typeCode === "CodeableConcept")) {
          const r = await this.codeCheck(system, code!, c.display, typeof c.version === "string" ? c.version : null);
          if (r.status === "invalid-display" && r.severity === "error") {
            wrongDisplay ??= { system, code: code!, message: r.message, index: idx };
            continue;
          }
        }
        anyMember = true;
      } else if (m === undefined) {
        // a code its CodeSystem rejects is in no value set, whatever the (undecidable) filters say
        const r = system && (typeCode === "Coding" || typeCode === "CodeableConcept") ? await this.codeCheck(system, code!, null, null) : null;
        // A system neither held nor on the terminology server, included by the value set: the validator's check ends in
        // UNKNOWN_CODESYSTEM and that is decided (see below).
        if (r && r.status === "unknown-system") unknownSystemMember = true;
        else if (!(r && r.status === "invalid-code" && r.severity === "error")) anyUnknown = true;
      } else if (m === false) {
        otherMiss = true;
      }
    }
    // ValueSetValidator.validateCode(CodeableConcept) (standalone tag 7.0.1:458 `info.hasErrors()`): any coding with an
    // error (unknown code, wrong display) fails the CodeableConcept even when another coding is in the value set
    let codingError: string | null = null;
    if (typeCode === "CodeableConcept") {
      for (const c of list) {
        if (!isObject(c) || typeof c.system !== "string" || typeof c.code !== "string" || !c.code) continue;
        const r = await this.codeCheck(c.system, c.code, typeof c.display === "string" ? c.display : null, typeof c.version === "string" ? c.version : null);
        if ((r.status === "invalid-code" || r.status === "invalid-display") && r.severity === "error") {
          codingError = r.message;
          break;
        }
      }
    }
    await this.pinnedUnknownCode(vs, list, typeCode, item, issues);
    if (anyMember && codingError === null) return;
    // TerminologyServiceErrorClass.CODESYSTEM_UNSUPPORTED ("we've already handled the warnings / errors", IV tag 7.0.1:1800):
    // the server's unknown system is all the validator reports, whatever the binding's strength (jar oracle: CodeableConcept
    // required / extensible, Coding required: UNKNOWN_CODESYSTEM alone). Only an extensible Coding adds Terminology_TX_Confirm_5.
    if (unknownSystemMember && !otherMiss && !anyUnknown && !wrongDisplay && codingError === null && (typeCode === "CodeableConcept" || (typeCode === "Coding" && strength === "required"))) return;
    if (wrongDisplay && strength === "required") {
      const vsDesc = `'${vs.title || vs.name || url}' (${vs.url}${vs.version ? `|${vs.version}` : ""})`;
      issues.push(
        typeCode === "Coding"
          ? { severity: "error", path: item.path, code: "code-invalid", message: `The code provided (${wrongDisplay.system}#${wrongDisplay.code}) was not found in the value set ${vsDesc}, and a code from this value set is required: ${wrongDisplay.message}` }
          : { severity: "error", path: item.path, code: "code-invalid", message: `None of the codings provided are in the value set ${vsDesc}, and a coding from this value set is required) (codes = ${codings.map(([s2, c2]) => (s2 ? `${s2}#${c2}` : c2)).join(", ")})` },
      );
      return;
    }
    const shown = codings.map(([s, c]) => (s ? `${s}#${c}` : c)).join(", ");
    // InstanceValidator.describeReference(vsRef, valueset) / ccSummary (IV:5698 / 2368, tag 7.0.1)
    const vsRef = `'${vs.title || vs.name || url}' (${vs.url}${vs.version ? `|${vs.version}` : ""})`;
    const ccSummary = (typeCode === "CodeableConcept" && isObject(v) && Array.isArray(v.coding) ? v.coding : [])
      .filter((c: any) => isObject(c))
      .map((c: any) => `${typeof c.system === "string" ? c.system : "null"}#${typeof c.code === "string" ? c.code : "null"}`)
      .join(", ");
    if (anyUnknown && codingError === null) {
      issues.push({
        severity: "information",
        path: item.path,
        code: "informational",
        message: `The code(s) ${shown} could not be confirmed as members of the value set ${label} (not fully expandable locally)`,
        unchecked: { kind: "code", canonical: url, causes: [...new Set(codings.map(([s]) => `${s ?? ""}|${url}`))] },
      });
      return;
    }
    if (strength === "required" && typeCode === "code") {
      // Port of ValueSetValidator.systemForCodeInValueSet (7.0.1, r5): a bare code is validated by first inferring its
      // system from the ValueSet; when no include's CodeSystem has the code, UNABLE_TO_INFER_CODESYSTEM is reported
      // (an error, besides the not-in-value-set one below).
      const inferred = await this.inferCodeSystems(vs, String(codings[0][1]));
      if (inferred !== null && inferred.size === 0) {
        const vsv = `${vs.url}${vs.version ? `|${vs.version}` : ""}`;
        const infer = `The System URI could not be determined for the code '${codings[0][1]}' in the ValueSet '${vsv}'`;
        issues.push({ severity: "error", path: item.path, code: "code-invalid", message: infer });
        // Terminology_TX_NoValid_16 carries the server's messages as its {2}
        issues.push({
          severity: "error",
          path: item.path,
          code: "code-invalid",
          message: `The value provided ('${shown}') was not found in the value set ${label}, and a code is required from this value set  (error message = ${infer}; The provided code '#${codings[0][1]}' was not found in the value set '${vsv}')`,
        });
        return;
      }
    }
    let problem = typeCode === "Coding" ? await this.codeProblem(list[0]) : "";
    let unknownInVs = "";
    if (typeCode === "Coding" && strength === "required" && isObject(list[0]) && typeof list[0].system === "string") {
      const r = await this.codeCheck(list[0].system, String(list[0].code), null, null);
      if (r.status === "unknown-system") {
        // A coding of a CodeableConcept (validateBindingTerminologyCoding): only UNKNOWN_CODESYSTEM from checkCoding, the
        // CodeableConcept's own binding answers (empd Coverage.type.coding). A Coding element (validateBindingCodedElement,
        // IV tag 7.0.1:2497-2512): Terminology_TX_Confirm_4a, an error (official corpus: Encounter.class, mimic)
        if (isObject(el.base) ? el.base.path === "CodeableConcept.coding" : String(el.path ?? "").endsWith(".coding")) return;
        unknownInVs = `A definition for CodeSystem '${list[0].system}' could not be found, so the code cannot be validated; `;
        problem = "";
      }
    }
    if (strength === "required") {
      issues.push({
        severity: "error",
        path: item.path,
        code: "code-invalid",
        message:
          typeCode === "CodeableConcept"
            ? // Terminology_TX_NoValid_1_CC: describeReference (versioned url) + ccSummary (every coding as system#code)
              `None of the codings provided are in the value set ${vsRef}, and a coding from this value set is required) (codes = ${ccSummary})`
            : typeCode === "Coding"
              ? // validateBindingCodedElement / validateBindingTerminologyCoding with the server's messages (official corpus
                // text)
                (() => {
                  const c0 = isObject(list[0]) ? list[0] : {};
                  const provided = `${unknownInVs}The provided code '${shown}${typeof c0.display === "string" && c0.display ? ` ('${c0.display}')` : ""}' was not found in the value set '${vs.url}${vs.version ? `|${vs.version}` : ""}'${problem}`;
                  // Terminology_TX_Confirm_4a when the server answered with an error class (SNOMED CT, LOINC, an unknown system);
                  // Terminology_TX_NoValid_12 for a CodeSystem validated locally (official corpus, unknown-code family)
                  const server = !!unknownInVs || c0.system === "http://snomed.info/sct" || c0.system === "http://loinc.org";
                  return !server
                    ? `The Coding provided (${shown}) was not found in the value set ${vsRef}, and a code is required from this value set.  (error message = ${provided})`
                    : `The code provided (${shown}) was not found in the value set ${vsRef}, and a code from this value set is required: ${provided}`;
                })()
              : `The value provided ('${shown}') was not found in the value set ${label}, and a code is required from this value set`,
      });
    } else {
      const maxExt = Array.isArray(b.extension) ? b.extension.find((e: any) => isObject(e) && e.url === MAX_VALUESET_EXT) : null;
      const maxUrl = maxExt ? String(maxExt.valueCanonical ?? maxExt.valueUri ?? maxExt.valueUrl ?? "") : "";
      // checkBindings / checkPrimitiveBinding (7.0.1): with a maxValueSet a Coding / code is judged against it instead
      // of the extensible warning; a CodeableConcept gets both
      if (!maxUrl || typeCode === "CodeableConcept") {
        issues.push({
          severity: "warning",
          path: item.path,
          code: "code-invalid",
          message:
            typeCode === "CodeableConcept"
              ? `None of the codings provided are in the value set ${vsRef}, and a coding should come from this value set unless it has no suitable code (note that the validator cannot judge what is suitable) (codes = ${ccSummary})`
              : unknownSystemMember && typeCode === "Coding"
                ? // Terminology_TX_Confirm_5 (validateBindingTerminologyCoding, IV tag 7.0.1:2518)
                  `The code provided (${shown}) is not in the value set ${vsRef}, and a code should come from this value set unless it has no suitable code (the validator cannot judge what is suitable)`
                : `None of the codings provided are in the value set ${label}, and a coding should come from this value set unless it has no suitable code (codes = ${shown})`,
        });
      }
      if (maxUrl) await this.checkMaxValueSet(maxUrl, codings, typeCode, item, issues);
    }
  }

  /**
   * InstanceValidator.checkMaxValueSet (IV:2267 / 2306 / 2337, tag 7.0.1; REVIEW_port_1 F20): an extensible binding's
   * elementdefinition-maxValueSet must hold the code — Terminology_TX_NoValid_8 (CodeableConcept) / _10 (Coding) /
   * _11 (code), errors; an unresolvable max value set is Terminology_TX_ValueSet_NotFound(_CS); undecidable membership
   * is unchecked, never a pass.
   */
  /**
   * validateBindingCodeableConcept (IV l. 1769-1787): under any binding but example the concept goes to the terminology
   * server, whose issues are reported as they come (calculateSeverityForTxIssuesAndUpdateErrors). For codings without a
   * code tx.fhir.org answers a warning on the concept and an error on the coding (the wording is the server's, not
   * Messages.properties; evaluator corpus). A CodeSystem of the closure is validated locally by the jar and gets the
   * ordinary binding path. Returns true when it reported.
   */
  private async codelessCodingIssues(v: any, item: Item, issues: Issue[]): Promise<boolean> {
    const list: any[] = isObject(v) && Array.isArray(v.coding) ? v.coding : [];
    if (!list.length || list.some((c) => isObject(c) && typeof c.code === "string" && c.code !== "")) return false;
    // a `code` written as null or with a shadow is the parser's error, not this one
    const i = list.findIndex((c) => isObject(c) && typeof c.system === "string" && c.system !== "" && c.code === undefined && c._code === undefined);
    if (i < 0) return false;
    const system = String(list[i].system);
    // checkCoding reports it (codelessCoding); a system nobody answers has nothing to report
    return !(await this.heldCodeSystem(list[i], system)) && (await this.systemResolvable(system));
  }

  /** A CodeSystem the validator judges itself (ValueSetValidator l. 279): complete, fragment or supplement content. */
  private async heldCodeSystem(v: Record<string, any>, system: string): Promise<Record<string, any> | null> {
    const version = typeof v.version === "string" && v.version ? v.version : null;
    const cs = this.resolver.fetchCodeSystem ? await this.resolver.fetchCodeSystem(version ? `${system}|${version}` : system).catch(() => null) : null;
    return cs && ["complete", "fragment", "supplement"].includes(String(cs.content)) ? cs : null;
  }

  private async checkMaxValueSet(maxUrl: string, codings: Array<[string | null, string | null]>, typeCode: string, item: Item, issues: Issue[]): Promise<void> {
    const mvs = await this.vsHeader(maxUrl);
    if (!mvs) {
      if (this.resolver.codeSystemExists && (await this.resolver.codeSystemExists(maxUrl).catch(() => false))) {
        issues.push({ severity: "error", path: item.path, code: "code-invalid", message: `Found a reference to a CodeSystem '${maxUrl}' where a ValueSet belongs` });
      } else {
        issues.push({ severity: "warning", path: item.path, code: "code-invalid", message: `ValueSet '${maxUrl}' not found`, ...((await this.valueSetMayBeAtServer(maxUrl)) ? { unchecked: { kind: "valueSet" as const, canonical: maxUrl } } : {}) });
      }
      return;
    }
    let unknown = false;
    for (const [system, code] of codings) {
      if (system === null && typeCode !== "code" && typeCode !== "string" && typeCode !== "uri" && typeCode !== "url" && typeCode !== "canonical") continue;
      const m = await this.member(maxUrl, system, code!);
      if (m === true) return;
      if (m === undefined) unknown = true;
    }
    if (unknown) {
      issues.push({ severity: "information", path: item.path, code: "informational", message: `Membership in the maximum value set ${maxUrl} could not be decided with local terminology`, unchecked: { kind: "code", canonical: maxUrl } });
      return;
    }
    const desc = `'${mvs.title || mvs.name || maxUrl}' (${mvs.url}${mvs.version ? `|${mvs.version}` : ""})`;
    const shown = codings.map(([s, c]) => `${s ?? "null"}#${c}`).join(", ");
    let message: string;
    if (typeCode === "CodeableConcept" || typeCode === "CodeableReference") {
      message = `None of the codes provided are in the maximum value set ${desc} specified in the max binding, and a code from this value set is required) (codes = ${shown})`;
    } else if (typeCode === "Coding" || typeCode === "Quantity") {
      message = `The code provided is not in the maximum value set ${desc} specified in the max binding, and a code from this value set is required) (code = ${shown})`;
    } else {
      // Terminology_TX_NoValid_11 (IV tag 7.0.1:2358): {1} is the literal null, {3} is vr.getMessage() — the ValueSetValidator
      // answer for a code with no system; the inference failure is also an issue of its own (calculateSeverityForTxIssuesAndUpdateErrors)
      const value = String(codings[0]?.[1] ?? "");
      const vsv = `${mvs.url}${mvs.version ? `|${mvs.version}` : ""}`;
      const inferred = await this.inferCodeSystems(mvs, value);
      const notFound = (sys: string): string => `The provided code '${sys}#${value}' was not found in the value set '${vsv}'`;
      let error = notFound("");
      if (inferred !== null && inferred.size === 0) {
        const infer = `The System URI could not be determined for the code '${value}' in the ValueSet '${vsv}'`;
        issues.push({ severity: "error", path: item.path, code: "code-invalid", message: infer });
        error = `${infer}; ${error}`;
      } else if (inferred !== null && inferred.size > 1) {
        error = `The System URI could not be determined for the code '${value}' in the ValueSet '${vsv}': value set expansion has multiple matches: ${[...inferred].sort().join(",")}`;
        issues.push({ severity: "error", path: item.path, code: "code-invalid", message: error });
      } else if (inferred !== null) {
        error = notFound([...inferred][0].split("|")[0]);
      }
      message = `The code provided is not in the maximum value set ${desc}, and a code from this value set is required) (code = null#${value}), error = ${error})`;
    }
    issues.push({ severity: "error", path: item.path, code: "code-invalid", message });
  }

  /**
   * Port of InstanceValidator.checkCodeOnServer → ValueSetValidator.determineVersion
   * (7.0.1) for Coding.version: tx.fhir.org compares the version the ValueSet
   * implies for the system with the one in the Coding and reports
   * VALUESET_VALUE_MISMATCH(_CHANGED) as an error for every non-example binding
   * strength (calculateSeverityForTxIssuesAndUpdateErrors keeps the tx severity).
   */
  private async checkCodingVersions(vsUrl: string, v: any, typeCode: string, item: Item, issues: Issue[]): Promise<void> {
    const codings: Array<[Record<string, any>, string]> = [];
    if (typeCode === "Coding" && isObject(v)) codings.push([v, item.path]);
    if (typeCode === "CodeableConcept" && isObject(v) && Array.isArray(v.coding)) {
      v.coding.forEach((c: any, i: number) => {
        if (isObject(c)) codings.push([c, `${item.path}.coding[${i}]`]);
      });
    }
    const relevant = codings.filter(([c]) => typeof c.version === "string" && c.version && typeof c.system === "string");
    if (!relevant.length) return;
    const vs = await this.vsHeader(vsUrl);
    for (const [c, path] of relevant) {
      if (c.system !== "http://snomed.info/sct" && this.resolver.codeSystemVersions) {
        // REVIEW_port_2 G3: determineVersion (standalone ValueSetValidator.java:1878, tag 7.0.1) for every held CodeSystem
        const held = await this.resolver.codeSystemVersions(c.system).catch(() => [] as string[]);
        if (!held.length || !vs) continue;
        const includes: any[] = Array.isArray(vs.compose?.include) ? vs.compose.include : [];
        // the terminology server holds the other published versions of HL7 / THO code systems: an unknown one there is undecided here
        const hl7 = /^https?:\/\/(terminology\.)?hl7\.org\//.test(c.system);
        const { issues: vi, unknownVersion } = codingVersionIssues(includes, c.system, c.version, held, { reportUnknownVersion: !hl7 });
        for (const x of vi) {
          const at = `${path}.${x.at}`;
          if (issues.some((i) => i.path === at && i.message === x.message)) continue;
          issues.push({ severity: x.severity, path: at, code: x.at === "system" ? "not-found" : "invalid", message: x.message });
        }
        if (unknownVersion && hl7) {
          issues.push({ severity: "information", path: `${path}.version`, code: "informational", message: `CodeSystem '${c.system}' version '${c.version}' is not held locally; the code was not checked against it`, unchecked: { kind: "code", canonical: `${c.system}|${c.version}` } });
        }
        continue;
      }
      const msg = codingVersionIssue(vs, c.system, c.version);
      if (!msg) continue;
      const at = `${path}.version`;
      if (issues.some((i) => i.path === at && i.message === msg)) continue;
      issues.push({ severity: "error", path: at, code: "invalid", message: msg });
    }
  }

  private resolvableCache = new Map<string, Promise<boolean>>();

  /**
   * A ValueSet outside the closure: the terminology server may hold it (jar: IPS vaccines-uv-ips answered, us-core birthsex,
   * TW Core medcation-atc-tw and RadLex "not found"). Which ones cannot be told offline: an HL7-space or installed canonical
   * stays undecided, anything else is a definite not found. An inference from jar probes, not a rule of the validator.
   */
  private async valueSetMayBeAtServer(url: string): Promise<boolean> {
    if (/^https?:\/\/(terminology\.)?hl7\.org\//.test(url) || url.includes("?fhir_vs") || url.startsWith("http://snomed.info/") || url.startsWith("http://loinc.org")) return true;
    return this.resolver.definitionExists ? this.defExists(url.split("|")[0]) : true;
  }

  private systemResolvable(system: string): Promise<boolean> {
    let p = this.resolvableCache.get(system);
    if (!p) {
      const fn = this.resolver.codeSystemResolvable;
      p = fn ? fn.call(this.resolver, system).catch(() => true) : Promise.resolve(true);
      this.resolvableCache.set(system, p);
    }
    return p;
  }

  private defExistsCache = new Map<string, Promise<boolean>>();

  private defExists(url: string): Promise<boolean> {
    let p = this.defExistsCache.get(url);
    if (!p) {
      const fn = this.resolver.definitionExists;
      p = fn ? fn.call(this.resolver, url).catch(() => true) : Promise.resolve(true);
      this.defExistsCache.set(url, p);
    }
    return p;
  }

  /**
   * Is `url` exactly the canonical of a ValueSet of the validation closure (Coding.system
   * pointing at a value set — Terminology_TX_System_ValueSet2)? `hl7Only`: only HL7 core / THO
   * ValueSets, which tx.fhir.org rejects as a system in any context (Quantity.system). An IG
   * ValueSet is an error only when the instance also checks a binding to it (v13,
   * settleVsSystems); otherwise HL7 only warns "A definition for CodeSystem … could not be found"
   * (TW Core medication-path-tw / medication-nhi-tw as a system pass validator_cli, also batched).
   */
  private async isValueSetUrl(url: string, hl7Only = true): Promise<boolean> {
    if (hl7Only && !isHl7ValueSetUrl(url)) return false;
    const vs = await this.vsHeader(url);
    return !!vs && stripVersion(String(vs.url || "")) === stripVersion(url);
  }

  /**
   * HL7 URI checks on uri / url / canonical / oid / uuid primitives: OID / UUID
   * URN syntax, and resolution of URLs in the HL7 spaces (validator_cli:
   * "No definition could be found for URL value").
   */
  // Port of InstanceValidator.checkPrimitive (uri/url/canonical/oid/uuid branch)
  // + validateReference/resolveUrl (7.0.1); see fhirUriRules.ts.
  /**
   * InstanceValidator.validateReference (7.0.1) l. 3946-3984 for a '#…' url: the fragment must match an element id,
   * an xhtml id or a/@name in the root resource (countTargetMatches; then the whole Bundle). Unmatched:
   * TYPE_SPECIFIC_CHECKS_DT_URL_INTERNAL (error) for canonical / Reference, ValueSet.compose.include|exclude.system and
   * textLink extensions; a hint for Meta.source; otherwise TYPE_SPECIFIC_CHECKS_DT_URL_INTERNAL_WARN (warning).
   */
  private checkInternalUrl(v: string, item: Item, typeCode: string, el: Record<string, any>, rctx: ResourceCtx, issues: Issue[]): void {
    const frag = v.slice(1);
    let count = fragmentMatches(rctx.container ?? rctx.resource, frag);
    if (count === 0 && rctx.bundle) count = fragmentMatches(rctx.bundle.bundle, frag);
    if (count > 0) return;
    const basePath = isObject(el.base) && typeof el.base.path === "string" ? el.base.path : String(el.path || "");
    const extMatters = item.parentExtUrl === "http://hl7.org/fhir/StructureDefinition/textLink";
    const warnMsg = `The URL value '${v}' might be wrong because it appears to point to an internal target, but there is no matching target`;
    if (basePath === "Meta.source" && (typeCode === "uri" || typeCode === "url") && !extMatters) {
      issues.push({ severity: "information", path: item.path, code: "invalid", message: warnMsg });
    } else if (typeCode === "canonical" || typeCode === "Reference" || basePath === "ValueSet.compose.include.system" || basePath === "ValueSet.compose.exclude.system" || extMatters) {
      issues.push({ severity: "error", path: item.path, code: "invalid", message: `The URL value '${v}' is invalid because there is no matching target` });
    } else {
      issues.push({ severity: "warning", path: item.path, code: "invalid", message: warnMsg });
    }
  }

  private async checkUri(v: string, item: Item, typeCode: string, el: Record<string, any>, issues: Issue[]): Promise<void> {
    if (!["uri", "url", "canonical", "oid", "uuid"].includes(typeCode)) return;
    const syn = urnSyntaxIssue(v, typeCode);
    if (syn) issues.push({ severity: "error", path: item.path, code: "invalid", message: syn });
    // (parity v3, F23) InstanceValidator.validateReference (IV:3986-4011): an example URL is an error only when it
    // does not resolve (a definition loaded from an example.org namespace is fine) and the path is not exempt
    // checkPrimitive l. 3417: Bundle.entry.fullUrl never reaches validateReference (validator_cli: no message on an example.org fullUrl)
    // only an absolute URL: validator_cli 7.0.1 reports no example URL for `www.example.org` or ' http://example.org/x'
    // (evaluator corpus: all 5649 official URL_EXAMPLE errors are absolute URLs)
    if (typeCode !== "oid" && typeCode !== "uuid" && !v.startsWith("#") && el.path !== "Bundle.entry.fullUrl" && isAbsoluteUrlJava(v) && isExampleUrl(v) && !this.inExampleExemptContext(item.path)) {
      const u = v.includes("|") ? v.slice(0, v.lastIndexOf("|")) : v;
      const found = !!this.resolver.definitionExists && (await this.defExists(u));
      // settings.isAllowExamples(): "nothing - these do need to resolve"
      // a value with whitespace has failed the URI rule (validateElement: the URL checks run on a good value only)
      if (!found && !this.allowExamples && !/\s/.test(v)) issues.push({ severity: "error", path: item.path, code: "invalid", message: `Example URLs are not allowed in this context (${short(v)})` });
    }
    // canonical: the HL7 validator only hints when a canonical does not resolve.
    if (typeCode !== "uri" && typeCode !== "url") return;
    const basePath = isObject(el.base) && typeof el.base.path === "string" ? el.base.path : String(el.path || "");
    if (uriResolutionExempt(basePath)) return;
    if (!this.resolver.definitionExists || !hl7UrlMustResolve(v)) return;
    const u = (v.includes("|") ? v.slice(0, v.lastIndexOf("|")) : v).replace(/#.*$/, "");
    if (this.containedUrls.has(u)) return;
    if (await this.defExists(u)) {
      // (v17.5) `url|version`: the HL7 validator resolves that version (Coding.system 'http://…/v2-0360|2.7' → not found)
      if (!v.includes("|") || !this.resolver.definitionVersionExists) return;
      const ver = v.slice(v.lastIndexOf("|") + 1);
      if (!ver || (await this.resolver.definitionVersionExists(u, ver).catch(() => true))) return;
    }
    issues.push({ severity: "error", path: item.path, code: "invalid", message: urlResolveMessage(v) });
  }

  /**
   * A coding of a CodeableConcept with a system and no code still goes to validateCode (checkCodeableConcept l. 1519): a CodeSystem
   * judged here answers NO_CODE_PROVIDED(_VERSION) (ValueSetValidator l. 1256), the terminology server its own error on the
   * coding, reported as a warning on the CodeableConcept too (official corpus: v2-0360|2.7, BCP-47, ISO 3166).
   */
  private async codelessCoding(v: Record<string, any>, system: string, item: Item, issues: Issue[]): Promise<void> {
    const cs = await this.heldCodeSystem(v, system);
    if (cs) {
      const message = cs.version ? `No code provided for CodeSystem '${system}' version '${cs.version}'` : `No code provided for CodeSystem '${system}'`;
      issues.push({ severity: "warning", path: item.path, code: "code-invalid", message });
    } else if (await this.systemResolvable(system)) {
      const message = `Coding has no code for system ${system} and cannot be validated`;
      issues.push({ severity: "error", path: item.path, code: "code-invalid", message });
      issues.push({ severity: "warning", path: item.path.replace(/\.coding\[\d+\]$/, ""), code: "code-invalid", message });
    }
  }

  private async checkCoding(v: Record<string, any>, item: Item, issues: Issue[], el: Record<string, any> | null = null): Promise<void> {
    const system = v.system;
    const code = v.code;
    // InstanceValidator.checkCoding (7.0.1): outside a CodeableConcept, or with a binding of its own, a code without a
    // system is TERMINOLOGY_TX_SYSTEM_NO_CODE (warning)
    const inCC = !!el && ((isObject(el.base) && el.base.path === "CodeableConcept.coding") || el.path === "CodeableConcept.coding");
    if (typeof code === "string" && code && (system === undefined || system === null) && (!inCC || (el && isObject(el.binding)))) {
      issues.push({ severity: "warning", path: item.path, code: "code-invalid", message: "A code with no system has no defined meaning, and it cannot be validated. A system should be provided" });
    }
    // isSystemReferenceValid; a value with whitespace only gets the URI rule (official corpus), a number is read as its text
    const written = typeof system === "number" || typeof system === "boolean" ? String(system) : system;
    // checkCodedElement l. 2447-2448, only when no binding check ran: a Coding on its own reports it on itself, whatever the
    // value (jar alone: ImagingStudy…sopClass, its value set is not found; official corpus: Encounter.class, bound, has none)
    const bindingRan = !!el && isObject(el.binding) && !!el.binding.valueSet && el.binding.strength !== "example" && !!(await this.vsHeader(String(el.binding.valueSet)));
    if (!inCC && typeof written === "string" && !bindingRan) {
      if (!/^(?:https?|urn):/.test(written)) {
        issues.push({ severity: "error", path: item.path, code: "code-invalid", message: "Coding.system must be an absolute reference, not a local reference" });
        return;
      }
    } else if (typeof written === "string" && written && !/\s/.test(written)) {
      if (!/^[a-z][a-z0-9+.-]*:/i.test(written)) {
        issues.push({ severity: "error", path: `${item.path}.system`, code: "code-invalid", message: "Coding.system must be an absolute reference, not a local reference" });
        return;
      }
    }
    if (inCC && typeof system === "string" && system && !/\s/.test(system) && (typeof code !== "string" || !code)) await this.codelessCoding(v, system, item, issues);
    if (typeof system !== "string" || typeof code !== "string" || !code) return;
    // UCUM: tx.fhir.org parses the expression (Unknown_Code_in_Version on failure) and checks the display against
    // the code and its formal structure (Display_Name_for__should_be_one_of__instead_of; review G9).
    if (system === UCUM_SYSTEM) {
      if (checkUcumCode(code) === "invalid") {
        issues.push({ severity: "error", path: `${item.path}.code`, code: "code-invalid", message: ucumUnknownCodeMessage(code) });
      } else if (typeof v.display === "string" && v.display) {
        const msg = ucumDisplayIssue(code, v.display);
        if (msg) issues.push({ severity: "error", path: `${item.path}.display`, code: "code-invalid", message: msg });
      }
      return;
    }
    // Coding.setDisplay: Utilities.noString(value) → display = null (the Coding sent to validation has no display)
    const display = typeof v.display === "string" && v.display !== "" ? v.display : null;
    const version = typeof v.version === "string" && v.version ? v.version : null;
    const r = await this.codeCheck(system, code, display, version);
    for (const n of r.extra ?? []) {
      // e.g. INACTIVE_CONCEPT_FOUND / DEPRECATED_CONCEPT_FOUND (tx.fhir.org warnings)
      issues.push({ severity: n.severity, path: item.path, code: "business-rule", message: n.message });
    }
    if (r.status === "unknown-system") {
      // Port of InstanceValidator.checkTerminologyCoding → isValueSet (7.0.1).
      const isVs = await this.isValueSetUrl(system, false);
      // A Coding element bound directly (e.g. Encounter.class, extensible) goes through
      // checkCoding → checkCodedElement: the binding check answers (warning
      // "not in the value set") and neither Terminology_TX_System_ValueSet2 nor
      // UNKNOWN_CODESYSTEM is reported (validator_cli, probe v7 A-class-vs).
      const b = el && isObject(el.binding) ? el.binding : null;
      if (isVs && b && b.valueSet && ["required", "extensible", "preferred"].includes(b.strength)) return;
      if (isVs && isHl7ValueSetUrl(system)) {
        issues.push({
          severity: "error",
          path: `${item.path}.system`,
          code: "code-invalid",
          message: `The Coding references a value set, not a code system ('${system}')`,
        });
        return;
      }
      if (isVs) {
        // IG ValueSet: an error when the instance loads it through a binding (settleVsSystems), else this warning.
        const issue: Issue = {
          severity: "warning",
          path: `${item.path}.system`,
          code: "not-found",
          message: `A definition for CodeSystem '${system}' could not be found, so the code cannot be validated`,
        };
        (issue as any)[VS_SYSTEM] = system;
        issues.push(issue);
        this.pendingVsSystems = true;
        return;
      }
      // An unknown system is only this warning (UNKNOWN_CODESYSTEM) — also in the
      // hl7.org/fhir space: validator_cli 7.0.1 + tx.fhir.org answers
      // http://hl7.org/fhir/sid/icd-10-pcs with this warning plus the URL-resolution
      // error from checkUri (v8 probes P-*), not Terminology_TX_System_Unknown.
      // ROUND 9: the server does not list it and nothing holds it, so the warning is all the validator does: fully checked.
      // extended_findings counts it (no-local-data). A resolver saying this of a system the server lists has not checked it.
      issues.push({
        severity: "warning",
        path: `${item.path}.system`,
        code: "not-found",
        message: `A definition for CodeSystem '${system}' could not be found, so the code cannot be validated`,
        ...(serverPrefers(system) === true ? { unchecked: { kind: "code" as const, canonical: system } } : {}),
      });
    } else if (r.status === "invalid-code") {
      issues.push(this.invalidCodeIssue(r, `${item.path}.${r.at ?? "code"}`, system));
    } else if (r.status === "invalid-display") {
      issues.push({ severity: r.severity, path: `${item.path}.display`, code: "code-invalid", message: r.message });
    } else if (r.status === "display-unchecked") {
      issues.push({ severity: "information", path: `${item.path}.display`, code: "informational", message: r.message, unchecked: { kind: "code", canonical: system } });
    } else if ((r.status === "silent" || r.status === "ok") && r.undecided) {
      issues.push({ severity: "information", path: `${item.path}.code`, code: "informational", message: version ? `Code '${code}' not checked: version '${version}' of ${system} is not held locally` : `Code '${code}' not checked: no local terminology for ${system}`, unchecked: { kind: "code", canonical: version ? `${system}|${version}` : system } });
    }
  }

  /**
   * Port of InstanceValidator.checkQuantity → checkCodedElement (7.0.1): the unit
   * code is validated against its system (UCUM via the terminology server, here
   * ucum-lhc); a ValueSet URL as system is Terminology_TX_System_ValueSet2.
   */
  /** Port of InstanceValidator.checkIdentifier (validator 7.0.1). */
  private checkIdentifier(v: any, item: Item, issues: Issue[]): void {
    if (!isObject(v)) return;
    const path = item.path;
    const system = typeof v.system === "string" ? v.system : null;
    const value = typeof v.value === "string" ? v.value : null;
    // isIdentifierSystemReferenceValid
    if (system !== null && !(system.startsWith("http:") || system.startsWith("https:") || system.startsWith("urn:") || system.startsWith("ldap:"))) {
      issues.push({ severity: "error", path, code: "code-invalid", message: "Identifier.system must be an absolute reference, not a local reference" });
    }
    if (system === "urn:ietf:rfc:3986" && value !== null && !javaIsAbsolute(value)) {
      issues.push({ severity: "error", path, code: "code-invalid", message: `if identifier.system is 'urn:ietf:rfc:3986', then the identifier.value must be a full URI (e.g. start with a scheme), not '${value}'` });
    }
    if (system === "https://tools.ietf.org/html/rfc4122" && value !== null) {
      const u = "The URL 'https://tools.ietf.org/html/rfc4122'";
      if (value.startsWith("urn:uuid:")) {
        issues.push({ severity: "warning", path, code: "code-invalid", message: `${u} should not be used with the UUID '${value}'. Use the system value 'urn:ietf:rfc:3986' instead` });
      } else if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) {
        issues.push({ severity: "warning", path, code: "code-invalid", message: `${u} should not be used with the UUID '${value}'. Prefix the value with 'urn:uuid:' and use the system value 'urn:ietf:rfc:3986' instead` });
      } else {
        issues.push({ severity: "error", path, code: "code-invalid", message: `${u} is not correct for the identifier '${value}'` });
      }
    }
  }

  /**
   * Port of InstanceValidator.checkAttachment (validator 7.0.1) for inline data (Attachment.url content is not
   * fetched — the HL7 validator only fetches with a configured fetcher): stated size (TYPE_SPECIFIC_CHECKS_DT_ATT_SIZE_*),
   * maxSize extension, SHA-1 hash, and the no-content warning.
   */
  private checkAttachment(v: any, el: Record<string, any>, item: Item, issues: Issue[]): void {
    if (!isObject(v)) return;
    const path = item.path;
    const err = (message: string): void => void issues.push({ severity: "error", path, code: "structure", message });
    let size = -1;
    let max = -1;
    let hash: Buffer | null = null;
    const hash64 = typeof v.hash === "string" ? v.hash : null;
    if (v.size !== undefined && v.size !== null) {
      const sz = String(v.size);
      if (isJavaLong(sz)) {
        size = Number(sz);
        if (size < 0) err(`Stated Attachment Size ${sz} is not valid`);
      } else err(`Stated Attachment Size ${sz} is not valid`);
    }
    if (hash64 !== null) {
      const h = javaDecodeBase64(hash64);
      if ("error" in h) err(`The base64 content in the hash element is not valid base64: ${h.error}`);
      else hash = h.bytes;
    }
    const maxExt = extString(el, "http://hl7.org/fhir/StructureDefinition/maxSize");
    if (maxExt !== null && /^-?\d+$/.test(maxExt)) max = Number(maxExt);
    const data = typeof v.data === "string" ? v.data : null;
    // getAttachmentContent: data that passes Base64Util.isValidBase64 is decoded (its own base64Binary check reports
    // the rest); a decoder failure is TYPE_SPECIFIC_CHECKS_DT_ATT_B64_DECODE_FAIL and leaves no content to compare
    let bytes: Buffer | null = null;
    if (data !== null && isBase64Valid(data)) {
      const d = javaDecodeBase64(data);
      if ("error" in d) err(`The base64 content in the data element is not valid base64: ${d.error}`);
      else bytes = d.bytes;
    }
    if (!(v.data !== undefined || v.url !== undefined || v.contentType !== undefined || v.language !== undefined)) {
      issues.push({ severity: "warning", path, code: "structure", message: "Attachments have data and/or url, or else SHOULD have either contentType and/or language" });
    }
    if (max > -1 && bytes) {
      if (bytes.length > max) err(`Attachment size is ${bytes.length} bytes which exceeds the stated limit of ${max} bytes`);
    }
    if (size > -1 && bytes) {
      // MessageFormat prints the numeric arguments with grouping
      if (bytes.length !== size) err(`Stated Attachment Size ${size.toLocaleString("en-US")} does not match actual attachment size ${bytes.length.toLocaleString("en-US")}`);
    }
    if (hash !== null && bytes) {
      const sha1 = createHash("sha1").update(bytes).digest();
      if (!sha1.equals(hash)) err(`The hash of the data did not match the data (stated: '${hash64}', actual: '${sha1.toString("base64")}')`);
    }
  }

  /**
   * Port of InstanceValidator.checkQuantity (7.0.1, l. 4618-4712): maxDecimalPlaces (TYPE_SPECIFIC_CHECKS_DT_DECIMAL_CHARS);
   * the coded part through checkCodedElement (l. 2400-2452) — a non-example binding to a resolvable ValueSet is the
   * check (non-UCUM units: checkBinding; UCUM units here, decided locally only for a ValueSet that enumerates its UCUM
   * codes: TERMINOLOGY_TX_CONFIRM_4a), otherwise the system / code themselves (TERMINOLOGY_TX_SYSTEM_RELATIVE,
   * TERMINOLOGY_TX_SYSTEM_VALUESET2, checkCode: UCUM validity, the CodeSystem's codes); then minValue / maxValue
   * Quantity with UCUM conversion. Messages keep Java's argument quirks ({2} / {3} left unformatted).
   */
  private async checkQuantity(v: Record<string, any>, item: Item, issues: Issue[], el: Record<string, any> | null = null, sdx: SdIndex | null = null): Promise<void> {
    const path = item.path;
    const prim = (x: unknown): string | null => (x === undefined || x === null || isObject(x) || Array.isArray(x) ? null : String(x));
    const value = prim(v.value);
    const unit = prim(v.unit);
    const system = prim(v.system);
    const code = prim(v.code);
    const err = (message: string, code0 = "invalid"): void => void issues.push({ severity: "error", path, code: code0, message });
    const warn = (pass: boolean, message: string): boolean => {
      if (!pass) issues.push({ severity: "warning", path, code: "invalid", message });
      return pass;
    };
    const maxDp = el ? extString(el, "http://hl7.org/fhir/StructureDefinition/maxDecimalPlaces") : null;
    if (value !== null && value !== "" && maxDp !== null && /^-?\d+$/.test(maxDp)) {
      const dp = value.includes(".") ? value.slice(value.indexOf(".") + 1).length : 0;
      if (dp > Number(maxDp)) issues.push({ severity: "error", path, code: "structure", message: `Found ${dp} decimal places which exceeds the stated limit of ${maxDp} digits` });
    }

    // jar alone: `.system` as well as the Quantity itself when the unit check runs
    if (system !== null && !/\s/.test(system) && !/^(?:https?|urn):/.test(system)) issues.push({ severity: "error", path: `${path}.system`, code: "code-invalid", message: "Coding.system must be an absolute reference, not a local reference" });
    if (system && code === "") {
      // the server's answer to a unit without a code; Terminology_PassThrough_TX_Message names system#code
      const message = `Coding has no code for system ${system} and cannot be validated`;
      warn(false, message);
      err(`${message} (for '${system}#')`, "code-invalid");
    } else if (system !== null && code !== null) {
      let checked = false;
      const b = el && isObject(el.binding) ? el.binding : null;
      if (b && typeof b.valueSet === "string" && b.valueSet) {
        const vs = await this.vsHeader(b.valueSet);
        if (vs && b.strength !== "example") {
          checked = true;
          // validateBindingCodedElement l. 2486-2516: the effective strength (PackageHackerR5 backs the R4 vital-signs units
          // binding off to extensible); required → TERMINOLOGY_TX_CONFIRM_4a, extensible → TERMINOLOGY_TX_CONFIRM_5 (warning)
          const strength = b.strength === "required" && vitalsUnitsHack(sdx, el!) ? "extensible" : b.strength;
          const listed = system === UCUM_SYSTEM && (strength === "required" || strength === "extensible") ? ucumEnumeration(vs) : null;
          if (listed && !listed.has(code)) {
            const vsv = `${vs.url}${vs.version ? `|${vs.version}` : ""}`;
            const desc = `'${vs.title || vs.name || b.valueSet}' (${vsv})`;
            if (strength === "required") {
              const why = checkUcumCode(code) === "invalid" ? `; ${ucumUnknownCodeMessage(code)}` : "";
              err(`The code provided (${system}#${code}) was not found in the value set ${desc}, and a code from this value set is required: The provided code '${system}#${code}' was not found in the value set '${vsv}'${why}`, "code-invalid");
            } else {
              issues.push({ severity: "warning", path, code: "code-invalid", message: `The code provided (${system}#${code}) is not in the value set ${desc}, and a code should come from this value set unless it has no suitable code (the validator cannot judge what is suitable)` });
            }
          }
        }
      }
      if (!checked) {
        let ok = true;
        if (!/^[a-z][a-z0-9+.-]*:/i.test(system)) {
          issues.push({ severity: "error", path, code: "code-invalid", message: "Coding.system must be an absolute reference, not a local reference" });
          ok = false;
        }
        if (system !== UCUM_SYSTEM && (await this.isValueSetUrl(system))) {
          issues.push({ severity: "error", path, code: "code-invalid", message: `The Coding references a value set, not a code system ('${system}')` });
          ok = false;
        }
        if (ok && code !== "") {
          if (system === UCUM_SYSTEM) {
            if (checkUcumCode(code) === "invalid") issues.push({ severity: "error", path: `${path}.code`, code: "code-invalid", message: ucumUnknownCodeMessage(code) });
          } else {
            const r = await this.codeCheck(system, code, null, null);
            if (r.status === "invalid-code") issues.push(this.invalidCodeIssue(r, `${path}.code`, system));
            else if (r.status === "unknown-system") {
              issues.push({ severity: "warning", path: `${path}.system`, code: "not-found", message: `A definition for CodeSystem '${system}' could not be found, so the code cannot be validated` });
            }
          }
        }
      }
    }

    if (!el) return;
    for (const which of ["min", "max"] as const) {
      const key = Object.keys(el).find((k) => k.startsWith(`${which}Value`) && k.length > `${which}Value`.length);
      if (!key) continue;
      const label = which === "min" ? "minValue" : "maxValue";
      const word = which === "min" ? "minimum" : "maximum";
      if (!warn(value !== null && value !== "", `The quantity doesn't have an actual value, so the ${word} value can't be checked`)) continue;
      if (key !== `${which}ValueQuantity`) {
        const t = key.slice(`${which}Value`.length);
        // getMinValue().fhirType(): every other minValue[x] type is a primitive (integer, decimal, date …)
        err(`Found ${t.charAt(0).toLowerCase() + t.slice(1)} of type {2} in the profile validating a Quantity (so it must be a Quantity)`);
        continue;
      }
      const lim = isObject(el[key]) ? el[key] : {};
      const lsys = prim(lim.system);
      const lcode = prim(lim.code);
      if (
        !(
          warn(lsys !== null && lsys !== "", `The ${label} in the profile has no system so the ${word} value cannot be checked`) &&
          warn(system !== null && system !== "", `The value has no system so the ${word} value cannot be checked`) &&
          warn(system === lsys, `The ${label} in the profile has a system of ${system} which is different to the system in the value ${lsys} so the ${word} value cannot be checked`) &&
          warn(lcode !== null && lcode !== "", `The ${label} in the profile has no code so the ${word} value cannot be checked`) &&
          warn(code !== null && code !== "", `The value has no code so the ${word} value cannot be checked`)
        )
      ) continue;
      const lval = prim(lim.value);
      if (lval === null) {
        err(`The ${label} in the profile doesn't have an actual value, so the ${word} value can't be checked`);
        continue;
      }
      const cmp = (a: number, b0: number): boolean => (which === "min" ? a >= b0 : a <= b0);
      if (code === lcode) {
        if (!cmp(Number(value), Number(lval))) err(`The value in the instance ({2}) is ${which === "min" ? "less" : "greater"} than the specified ${word} value ({3})`);
      } else if (system === UCUM_SYSTEM) {
        const conv = convertUcum(Number(value), code!, lcode!);
        if (conv === null) err(`Unable to convert value ${value} from unit ${code} to ${label} unit ${lcode} based on UCUM definitions; ${word} value is not valid`);
        else if (!cmp(conv, Number(lval))) err(`The value in the instance (${value} ${code}) is ${which === "min" ? "less" : "greater"} than the specified ${label} (${lval} ${lcode}) after UCUM conversion`);
      } else {
        warn(false, `The ${label} in the profile has a system code of ${code} which is different to the system code in the value ${lcode} so the ${word} value cannot be checked`);
      }
    }
  }

  private async checkReference(
    el: Record<string, any>,
    v: Record<string, any>,
    item: Item,
    rctx: ResourceCtx,
    issues: Issue[],
    depth: number,
  ): Promise<void> {
    const ref = v.reference;
    if (typeof ref !== "string" || !ref) {
      // InstanceValidator.checkReference: REFERENCE_REF_NODISPLAY (not for patterns)
      const ident = isObject(v.identifier) ? v.identifier : {};
      if (ref === undefined && !ident.system && !ident.value && !(typeof v.display === "string" && v.display) && !String(item.path || "").includes("element.pattern")) {
        issues.push({ severity: "warning", path: item.path, code: "structure", message: "A Reference without an actual reference or identifier should have a display" });
      }
      return;
    }
    this.noteInternalRef(rctx, ref); // InstanceValidator.checkReference l. 5250-5251
    if (ref === "http://tools.ietf.org/html/bcp47") return;
    // Port of InstanceValidator.checkReference (7.0.1): a reference containing
    // whitespace is REFERENCE_REF_INVALID_REF (error, rule 2025-05-07) — the JSON
    // parser keeps it, so "Patient/ 123" or "Patient/p1 " is not just unresolved.
    if (!/^\S+$/.test(ref)) {
      issues.push({ severity: "error", path: item.path, code: "invalid", message: `The reference '${ref}' is not a valid reference` });
    }
    // localResolve → getFromBundle (BaseValidator, 7.0.1) reports the Bundle resolution messages at this element
    let target = this.localResolve(ref, rctx, item.path, issues);
    const refType = ref.startsWith("#") ? "contained" : target ? "internal" : "external";
    // checkReference l. 5261-5300: an external reference is fetched when the policy checks existence
    // (internal / contained ones are always CHECK_VALID)
    const policy = refType === "external" ? this.referencePolicy : "CHECK_VALID";
    let fetched = false;
    if (!target && refType === "external" && policy && (this.fetchCache.has(ref) || this.resolver.fetchReference) && !(ref.includes("?") && R4_RESOURCE_NAMES.has(ref.slice(0, ref.indexOf("?"))))) {
      const f = this.fetchCache.get(ref) ?? (await this.resolver.fetchReference?.(ref).catch(() => null));
      if (isObject(f) && typeof f.resourceType === "string") {
        this.fetchCache.set(ref, f);
        target = f;
        fetched = true;
      }
    }
    const conditional = ref.includes("?") && R4_RESOURCE_NAMES.has(ref.slice(0, ref.indexOf("?")));
    if (conditional) {
      if (!isSearchUrl(ref)) issues.push({ severity: "error", path: item.path, code: "invalid", message: `The query part of the conditional reference is not a valid query string (${ref})` });
      const grouping = rctx.bundle?.bundle ?? (rctx.root.resourceType === "Bundle" ? rctx.root : null);
      if (!(grouping && grouping.type === "transaction")) {
        issues.push({ severity: "error", path: item.path, code: "invalid", message: `The reference '${ref}' is a conditional reference, and conditional references are only valid inside a transaction Bundle` });
      }
    } else if (!target && ref.startsWith("#")) {
      issues.push({ severity: "error", path: item.path, code: "structure", message: `Unable to resolve resource with reference '${ref}'` });
    }
    const refTypeDef = (el.type || []).find((t: any) => typeCodeOf(t) === "Reference") ?? null;
    const aggregation: string[] = refTypeDef && Array.isArray(refTypeDef.aggregation) ? refTypeDef.aggregation.map(String) : [];
    // Reference.type (R4): must be a target of the element and agree with the reference's own type
    if (typeof v.type === "string" && v.type) {
      const ft = target ? this.typeOfResource(target) : conditional ? ref.slice(0, ref.indexOf("?")) : tryParseRefType(ref);
      const tu = /^[a-z][a-z0-9+.-]*:/iu.test(v.type) ? v.type : CORE + v.type;
      const tps: string[] = targetProfilesForR4(refTypeDef);
      if (tps.length && !tps.includes(tu) && !tps.includes(CORE + "Resource")) {
        let matching = false;
        for (const tp of tps) {
          const psdx = await this.sdx(tp);
          if (!psdx) {
            issues.push({ severity: "error", path: item.path, code: "not-found", message: `Unable to resolve the profile reference '${tp}'` });
            continue;
          }
          if (CORE + psdx.type === tu) {
            matching = true;
            break;
          }
        }
        if (!matching) {
          const listed = tps.map((tp) => `CanonicalType[${tp.startsWith(CORE) && !tp.includes("|") ? `${tp}|4.0.1` : tp}]`).join(", ");
          issues.push({ severity: "error", path: item.path, code: "structure", message: `The type '${v.type}' is not a valid Target for this element (must be one of [${listed}])` });
        }
      }
      if (!(ft === null || ft === v.type)) {
        issues.push({ severity: "error", path: item.path, code: "structure", message: `Invalid Resource target type. Found ${v.type}, but expected one of (${ft})` });
      }
    }
    if (!target) {
      if (aggregation.length && !aggregation.includes("referenced")) {
        issues.push({ severity: "error", path: item.path, code: "required", message: `Bundled or contained reference not found within the bundle/resource ${ref}` });
      }
      // InstanceValidator.checkReference l. 5478-5500: with assumeValidRestReferences the type in the url is checked
      // against the target profiles (its type or a base type) — REFERENCE_REF_BADTARGETTYPE2
      const fti = conditional ? null : tryParseRefType(ref);
      if (this.assumeValidRestReferences && fti) {
        const tps: string[] = targetProfilesForR4(refTypeDef);
        const types: string[] = [];
        let rok = false;
        const ftSd = await this.sdx(CORE + fti);
        for (const tp of tps) {
          const tsd = await this.sdx(tp);
          if (!tsd) continue;
          if (!types.includes(tsd.type)) types.push(tsd.type);
          for (let cur: SdIndex | null = ftSd, g = 0; cur && g < 20; g++) {
            if (cur.type === tsd.type) {
              rok = true;
              break;
            }
            cur = typeof cur.sd.baseDefinition === "string" ? await this.sdx(cur.sd.baseDefinition) : null;
          }
        }
        if (types.length && !rok) {
          issues.push({ severity: "error", path: item.path, code: "structure", message: `The type '${fti}' implied by the reference URL ${ref} is not a valid Target for this element (must be one of ${javaHashSetToString(types)})` });
        }
      }
      return;
    }
    if (fetched && policy === "CHECK_EXISTS") return; // pol.checkType() false
    if (aggregation.length) {
      let modeOk = false;
      for (const m of aggregation) {
        if (m === "contained" && refType === "contained") modeOk = true;
        else if (m === "bundled" && refType === "internal") modeOk = true; // R4: aggregation enforced (enforceAggregationOutsideBundles defaults to !R5)
        else if (m === "referenced" && refType !== "contained") modeOk = true;
      }
      if (!modeOk) {
        issues.push({ severity: "error", path: item.path, code: "structure", message: `Reference is ${refType} which isn't supported by the specified aggregation mode(s) for the reference (${aggregation.join(", ")})` });
      }
    }
    // getReferenceTypeRef (IV:5597): the first Reference type of the element
    const refTypeRef = (el.type || []).find((t: Record<string, any>) => typeCodeOf(t) === "Reference");
    const targetProfiles: string[] = [];
    for (const p of targetProfilesForR4(refTypeRef ?? null)) if (p) targetProfiles.push(p);
    if (!targetProfiles.length) return;
    const rt = this.typeOfResource(target);
    const candidates: SdIndex[] = [];
    const types: string[] = [];
    let anyType = false;
    for (const p of targetProfiles) {
      const psdx = await this.sdx(p);
      if (!psdx) {
        // Port of InstanceValidator.checkReference (7.0.1) l. 5361-5371: a target profile that cannot be resolved —
        // with or without a version — is Reference_REF_CantResolveProfile (error), and does not add a target type
        issues.push({
          severity: "error",
          path: item.path,
          code: "not-found",
          message: `Unable to resolve the profile reference '${p}'`,
          unchecked: { kind: "profile", canonical: p },
        });
        continue;
      }
      if (psdx.type === "Resource" || psdx.type === "DomainResource") anyType = true;
      types.push(String(psdx.type));
      if (psdx.type === rt) candidates.push(psdx);
    }
    if (!candidates.length) {
      if (anyType) return;
      // InstanceValidator.checkReference (7.0.1): Reference_REF_BadTargetType with the target types as a HashSet
      issues.push({
        severity: "error",
        path: item.path,
        code: "structure",
        message: `Invalid Resource target type. Found ${rt}, but expected one of (${javaHashSetToString(types)})`,
      });
      return;
    }
    if (anyType) return;
    if (fetched && policy !== "CHECK_VALID") return; // pol.checkValid() false
    const tctx: ResourceCtx = {
      resource: target,
      container: ref.startsWith("#") ? rctx.container || rctx.resource : null,
      root: rctx.root,
      bundle: rctx.bundle,
      entry: this.entryFor(target, rctx, ref.startsWith("#")),
    };
    // Port of InstanceValidator.checkReference (7.0.1): every target profile of the target's type is tried; none
    // valid → Reference_REF_CantMatchChoice unless all are base (core) profiles; more than one valid →
    // Reference_REF_MultipleMatches (warning, versioned urls sorted)
    const good: SdIndex[] = [];
    for (const c of candidates) {
      if (await this.resourceConforms(tctx, c.url, `${item.path}.resolve()`, depth + 1, false, true)) good.push(c);
    }
    if (good.length > 1) {
      issues.push({
        severity: "warning",
        path: item.path,
        code: "structure",
        message: `Found multiple matching profiles for ${ref} among choices: ${good.map((g) => this.versionedUrl(g)).sort().join(", ")}`,
      });
      return;
    }
    if (good.length === 1 || candidates.every((c) => c.url.startsWith(CORE))) return;
    issues.push({
      severity: "error",
      path: item.path,
      code: "structure",
      // asList(type.getTargetProfileList()) (IV:5406, 5546): every target profile as written, CanonicalTypeSorter order
      message: `Unable to find a profile match for ${ref} among choices: ${[...targetProfiles].sort().join(", ")}`,
    });
  }

  /**
   * Port of InstanceValidator.checkExtensionContext (validator_cli 7.0.1): an
   * extension may only be used where its StructureDefinition.context allows it.
   *  - element contexts: `Element` / `Any` anywhere; `Resource` on a resource root;
   *    `CanonicalResource` on a canonical resource; otherwise the host's literal
   *    path (indexes stripped) or one of its logical paths (NodeStack) must match
   *    the expression segment-wise, or after replacing the leading type by one of
   *    its base types (Observation → DomainResource → Resource);
   *  - extension contexts: the host is that extension (or its value[x]);
   *  - fhirpath contexts and `profile#path` element contexts are not evaluated
   *    here and count as allowed (never a false error);
   *  - contexts restricted to other FHIR versions (version-specific-use) are skipped.
   * Failing all: Extension_EXTP_Context_Wrong(_VER) / Extension_EXTM_Context_Wrong,
   * error at the host element. When allowed, each StructureDefinition.contextInvariant
   * must hold on the host (Profile_EXT_Not_Here); an invariant that cannot be
   * evaluated locally is skipped.
   */
  private async checkExtensionContext(ext: SdIndex, host: ExtensionHost, rctx: ResourceCtx, issues: Issue[], extValue: any): Promise<void> {
    const sd = ext.sd;
    const contexts: Array<Record<string, any>> = Array.isArray(sd.context) ? sd.context.filter(isObject) : [];
    if (!contexts.length) return;
    const label = `${ext.url}${typeof sd.version === "string" && sd.version ? ` v${sd.version}` : ""}`;
    const plist = [...host.plist];
    const shown: string[] = [];
    let skippedForVersion = false;
    let ok = false;
    for (const c of contexts) {
      if (ok) break;
      if (!appliesToR4(c)) {
        skippedForVersion = true;
        continue;
      }
      const expr = String(c.expression ?? "");
      if (c.type === "element") {
        shown.push(`e:${expr}`);
        let en = expr;
        let pu: string | null = null;
        if (en.includes("#")) {
          pu = en.slice(0, en.indexOf("#"));
          en = en.slice(en.indexOf("#") + 1);
        }
        if (en === "Element" || en === "Any") ok = true;
        else if (en === "Resource" && host.isResource) ok = true;
        else if (en === "CanonicalResource" && plist.some((p) => CANONICAL_RESOURCE_TYPES.has(p))) ok = true;
        else if (pu === null && hasElementName(plist, en)) ok = true;
        // checkConformsToProfile (l. 2973-3001) gates the path match of a `profile#path` context
        else if (pu === null || (await this.contextProfileConforms(pu, expr, ext.url, host, rctx, issues))) ok = await this.contextByBaseType(plist, en);
      } else if (c.type === "extension") {
        shown.push(`x:${expr}`);
        // l. 2848-2852: `plist.add(ext)`: shown after the sorted paths, and matched by the contexts that follow
        if (host.extUrl !== null && expr === host.extUrl) ok = true;
        else if (host.extUrl !== null) plist.push(host.extUrl);
      } else if (c.type === "fhirpath") {
        shown.push(`p:${expr}`);
        // l. 2852-2858: the context is every element the expression selects from the resource
        try {
          const env: FhirPathEnv = { resource: rctx.resource, rootResource: rctx.container || rctx.resource, resolveReference: (ref: string) => this.resolveRefForFhirPath(ref, rctx) };
          // res.contains(container): element identity — fhirpath.js nodes carry the JSON value (`data`) and, for a
          // primitive, its `_x` object (`_data`), which identifies the host primitive
          const res = evaluateExpression(rctx.resource, String(rctx.resource.resourceType), expr, env, {}, { internal: true });
          const isHost = (r: any): boolean => {
            const d = isObject(r) && "data" in r ? r.data : r;
            if (host.primitiveExt) return d === host.value && isObject(r) && r._data === host.primitiveExt;
            return d === host.value;
          };
          if (res.some(isHost)) ok = true;
        } catch {
          ok = true; // not evaluable locally: not judged, and said so
          issues.push({
            severity: "information",
            path: host.path,
            code: "invariant-unevaluated",
            message: `Extension context '${expr}' of ${ext.url} could not be evaluated locally; not a conformance failure`,
            unchecked: { kind: "invariant", canonical: `${ext.url}#context` },
          });
        }
      } else {
        ok = true; // unknown context type
      }
    }
    if (!ok) {
      const allowed = shown.join(", ");
      const rootType = String(rctx.resource.resourceType);
      const rel = host.literal.startsWith(rootType) ? host.literal.slice(rootType.length) : stripIndexes(host.path.slice(1));
      const elementIs = host.path.startsWith(ROOT_TOKEN)
        ? PLIST_TOKEN + JSON.stringify([...host.plist, ...plist.slice(host.plist.length).map((x) => PLIST_TAIL + x), ROOT_TOKEN + rel, LITERAL_ROOT_TOKEN + rel]) + PLIST_TOKEN
        : `[${plist.join(", ")}]`;
      if (typeof sd[XVER_SOURCE] === "string") {
        // EXTENSION_EXTP / EXTM_CONTEXT_WRONG_XVER: a warning for a cross-version extension
        issues.push({
          severity: "warning",
          path: host.path,
          code: "structure",
          message: `The ${host.modifier ? "modifier extension" : "extension"} ${label} from FHIR version ${sd[XVER_SOURCE]} is not allowed to be used at this point (this element is ${elementIs}; allowed for this version = ${allowed}; this is a warning since contexts may be renamed between FHIR versions)`,
          profile: ext.url,
        });
        return;
      }
      issues.push({
        severity: "error",
        path: host.path,
        code: "structure",
        message: host.modifier
          ? `The modifier extension ${label} is not allowed to be used at this point (this element is ${elementIs}; ${skippedForVersion ? "allowed for this version" : "allowed"} = ${allowed})`
          : `The extension ${label} is not allowed to be used at this point (this element is ${elementIs}; allowed for this version = ${allowed})`,
        profile: ext.url,
      });
      return;
    }
    const invariants: string[] = Array.isArray(sd.contextInvariant) ? sd.contextInvariant.filter((x: any) => typeof x === "string" && x) : [];
    if (!invariants.length || host.value === null || typeof host.value !== "object") return;
    const env: FhirPathEnv = {
      resource: rctx.resource,
      rootResource: rctx.container || rctx.resource,
      resolveReference: (ref: string) => this.resolveRefForFhirPath(ref, rctx),
    };
    const base = fhirPathBase(host.defPath || host.typeCode, host.typeCode || null);
    for (const inv of invariants) {
      const outcome = evaluateConstraint(host.value, base, inv, env, { extension: extValue });
      if (outcome.status !== "fail") continue;
      issues.push({
        severity: "error",
        path: host.path,
        code: "business-rule",
        message: `The extension ${label} is not allowed to be used at this point (based on context invariant '${inv}')`,
        profile: ext.url,
      });
      return;
    }
  }

  /**
   * InstanceValidator.checkConformsToProfile (7.0.1, l. 2973-3001) for a `profile#path` element context: the
   * resource's own core type passes; an unknown profile is EXTENSION_CONTEXT_UNABLE_TO_FIND_PROFILE (error, fails);
   * a profile of the resource's type must validate without errors; another type cannot be checked (warning, passes).
   */
  private async contextProfileConforms(pu: string, expression: string, extUrl: string, host: ExtensionHost, rctx: ResourceCtx, issues: Issue[]): Promise<boolean> {
    const rt = String(rctx.resource.resourceType ?? "");
    if (pu === CORE + rt) return true;
    const psdx = await this.sdx(pu);
    if (!psdx) {
      issues.push({ severity: "error", path: host.path, code: "unknown", message: `The extension ${extUrl} specifies a context of ${expression} but the validator cannot find that profile` });
      return false;
    }
    if (psdx.type === rt) {
      const res = await this.conformance({ ...rctx }, pu, ROOT_TOKEN, 0);
      return !res.some((i) => i.severity === "error" || i.severity === "fatal");
    }
    issues.push({ severity: "warning", path: host.path, code: "unknown", message: `The extension ${extUrl} specifies a context of ${expression} but the validator cannot check whether the profile is valid or not at this time` });
    return true;
  }

  /** checkExtensionContext's fallback: `<Type><rest>` where Type is the path's leading type or one of its bases. */
  private async contextByBaseType(plist: string[], en: string): Promise<boolean> {
    for (const p of plist) {
      const dot = p.indexOf(".");
      const pn = dot >= 0 ? p.slice(0, dot) : p;
      const pt = dot >= 0 ? p.slice(dot) : "";
      if (!/^[A-Za-z][A-Za-z0-9]*$/.test(pn)) continue;
      let cur = await this.sdx(CORE + pn);
      for (let guard = 0; cur && guard < 10; guard++) {
        if (cur.type + pt === en) return true;
        const baseDef = typeof cur.sd.baseDefinition === "string" ? cur.sd.baseDefinition : null;
        cur = baseDef ? await this.sdx(baseDef) : null;
      }
    }
    return false;
  }

  // ------------------------------------------------------------------ structure

  /**
   * "Unrecognized property" anywhere in the instance, judged against the core
   * definitions like the HL7 JSON parser (org.hl7.fhir.r5.elementmodel.JsonParser,
   * 7.0.1), which runs before — and independently of — profile validation. The
   * profile walk already reports unknown properties where it descends; this pass
   * covers what it does not reach (a choice type the profile does not allow, the
   * content of an unknown extension …). Like the parser it does not descend into a
   * value of the wrong JSON shape (array for a single element, object for a
   * primitive) nor into a second value of the same choice element.
   */
  /**
   * The tree the JSON parser builds, before validation (copy-on-write, walking the base definitions), so cardinality,
   * slicing, invariants and every sub-validation see it. JsonParser.parseChildPrimitive(Instance), reported at the
   * parser's path (`value[x]` for a choice, no index in a list):
   *  - a non-repeating primitive whose JSON value is an object or an array: THIS_PROPERTY_MUST_BE_AN_SIMPLE_VALUE_NOT_;
   *  - a `_x` that is not an object (scalar, or an item of a list): THIS_PROPERTY_MUST_BE_AN_OBJECT_NOT_;
   *  - a `_x` of a list that is not an array: THIS_BASE_PROPERTY_MUST_BE_AN_ARRAY_NOT_ ((sic) describes the main value);
   *  - each creates no element: the value goes too. An empty `_x` next to a value: OBJECT_MUST_HAVE_SOME_CONTENT, the
   *    element stays.
   * An object left without content this way is no "empty object" of the source: it is remembered (parserEmptied).
   */
  private async dropBadPrimitiveValues(resource: Record<string, any>, path: string, issues: Issue[], depth: number): Promise<Record<string, any>> {
    if (depth > MAX_DEPTH || typeof resource.resourceType !== "string") return resource;
    const sdx = await this.sdx(CORE + resource.resourceType);
    return sdx ? this.dropBadPrimitivesIn(sdx, sdx.root, resource, path, issues, depth) : resource;
  }

  private async dropBadPrimitivesIn(sdx: SdIndex, el: Record<string, any>, node: Record<string, any>, path: string, issues: Issue[], depth: number): Promise<Record<string, any>> {
    const groups = sdx.children(el);
    if (depth > MAX_DEPTH || !groups || groups.size === 0) return node;
    let out: Record<string, any> | null = null;
    for (const key of Object.keys(node)) {
      if (key.startsWith("_") || key === "resourceType") continue;
      let def: Record<string, any> | null = null;
      let typeCode = "";
      let propName = key;
      const direct = groups.get(key);
      if (direct && !key.endsWith("[x]")) {
        def = direct.base || direct.slices[0] || null;
        const types: string[] = (def?.type || []).map(typeCodeOf);
        typeCode = types.length === 1 ? types[0] : types[0] || "BackboneElement";
      } else {
        for (const g of groups.values()) {
          if (!g.name.endsWith("[x]")) continue;
          const stem = g.name.slice(0, -3);
          if (!(key.startsWith(stem) && key.length > stem.length && /[A-Z]/.test(key[stem.length]))) continue;
          const d = g.base || g.slices[0];
          const suffix = key.slice(stem.length);
          const t = ((d?.type || []) as any[]).map(typeCodeOf).find((a: string) => a[0].toUpperCase() + a.slice(1) === suffix);
          if (d && t) {
            def = d;
            typeCode = t;
            propName = g.name;
          }
          break;
        }
      }
      if (!def) continue;
      const raw = node[key];
      const baseMax = String((def.base && def.base.max) ?? def.max ?? "*");
      const expectArray = baseMax !== "1" && baseMax !== "0";
      if (isPrimitive(typeCode)) {
        const at = `${path}.${propName}`;
        const fork = node[`_${key}`];
        const drop = (): void => {
          out ??= copyNode(node);
          delete out[key];
          delete out[`_${key}`];
        };
        const notObject = (v: unknown): void => {
          issues.push({ severity: "error", path: at, code: "structure", message: `This property must be an object, not ${describeJson(v)} (${key} at ${at})` });
        };
        const emptyFork = (): void => {
          issues.push({ severity: "error", path: at, code: "invalid", message: "Object must have some content" });
        };
        if (this.xmlSource) continue;
        if (!expectArray) {
          if (raw !== null && typeof raw === "object") {
            issues.push({ severity: "error", path: at, code: "structure", message: `This property must be a simple value, not ${describeJson(raw)} (${key} at ${at})` });
            drop();
          } else if (fork !== undefined && fork !== null && !isObject(fork)) {
            notObject(fork);
            drop();
          } else if (isObject(fork) && !Object.keys(fork).length && raw !== null) {
            emptyFork();
            (out ??= copyNode(node));
            delete out[`_${key}`];
          }
        } else if (Array.isArray(raw) && fork !== undefined && fork !== null) {
          if (!Array.isArray(fork)) {
            issues.push({ severity: "error", path: at, code: "invalid", message: `This base property must be an Array, not ${describeJson(raw)}` });
            drop();
          } else {
            const n = Math.max(raw.length, fork.length);
            const main: any[] = [];
            const shadow: any[] = [];
            let changed = false;
            for (let i = 0; i < n; i++) {
              const m = raw[i] ?? null;
              const f = fork[i] ?? null;
              if (f !== null && !isObject(f)) {
                notObject(f);
                changed = true;
                continue;
              }
              main.push(m);
              if (isObject(f) && !Object.keys(f).length && m !== null) {
                emptyFork();
                changed = true;
                shadow.push(null);
              } else shadow.push(f);
            }
            if (changed) {
              out ??= copyNode(node);
              out[key] = main;
              out[`_${key}`] = shadow;
            }
          }
        }
        continue;
      }
      if (expectArray !== Array.isArray(raw)) continue;
      const one = async (v: any, p: string): Promise<any> => {
        if (!isObject(v)) return v;
        if (typeCode === "Resource" || typeCode === "DomainResource" || (typeof v.resourceType === "string" && !COMPLEX_TYPES.includes(typeCode) && !(await this.isDatatype(typeCode)))) {
          return this.dropBadPrimitiveValues(v, p, issues, depth + 1);
        }
        if (def!.contentReference) {
          const target = sdx.byId.get(String(def!.contentReference).replace(/^.*#/, ""));
          return target ? this.dropBadPrimitivesIn(sdx, target, v, p, issues, depth + 1) : v;
        }
        if (sdx.hasChildren(def!)) return this.dropBadPrimitivesIn(sdx, def!, v, p, issues, depth + 1);
        const tsdx = await this.sdx(CORE + typeCode);
        return tsdx ? this.dropBadPrimitivesIn(tsdx, tsdx.root, v, p, issues, depth + 1) : v;
      };
      if (Array.isArray(raw)) {
        let arr: any[] | null = null;
        for (let i = 0; i < raw.length; i++) {
          const r = await one(raw[i], `${path}.${propName}[${i}]`);
          if (r !== raw[i]) (arr ??= [...raw])[i] = r;
        }
        if (arr) (out ??= copyNode(node))[key] = arr;
      } else {
        const r = await one(raw, `${path}.${propName}`);
        if (r !== raw) (out ??= copyNode(node))[key] = r;
      }
    }
    if (!out) return node;
    if (hasNoContent(out, this.parserEmptied)) {
      this.parserEmptied.add(out);
      this.parserEmptiedAny = true;
    }
    return out;
  }

  private async structuralPass(resource: Record<string, any>, path: string, issues: Issue[], depth: number): Promise<void> {
    if (depth > MAX_DEPTH) {
      issues.push(tooDeep(path));
      return;
    }
    if (typeof resource.resourceType !== "string") return;
    const sdx = await this.sdx(CORE + resource.resourceType);
    if (!sdx) return;
    await this.structObject(sdx, sdx.root, resource, path, issues, depth, true);
  }

  private async structObject(
    sdx: SdIndex,
    el: Record<string, any>,
    node: Record<string, any>,
    path: string,
    issues: Issue[],
    depth: number,
    isRoot: boolean,
    elementPath: string = path,
  ): Promise<void> {
    if (depth > MAX_DEPTH) {
      issues.push(tooDeep(path));
      return;
    }
    const groups = sdx.children(el);
    if (!groups || groups.size === 0) return;
    const unknown = (key: string): void => {
      issues.push({ severity: "error", path, code: "structure", message: `Unrecognized property '${key}'` });
    };
    const choiceSeen = new Map<string, string>();
    // (parity v1) children the parser keeps: ele-1 is evaluated on the element model after unknown properties and
    // values of the wrong JSON shape were dropped — an element holding only those (or only an id) has no children
    let kept = 0;
    // (parity v3, F4) JsonParser.checkNotProcessed: a repeated property name (first one bound, the rest ignored)
    for (const k of duplicateKeys(node)) {
      if (isRoot && k === "resourceType") continue;
      issues.push({ severity: "error", path, code: "invalid", message: `The JSON property '${k}' is a duplicate and will be ignored` });
    }
    for (const key of Object.keys(node)) {
      if (isRoot && key === "resourceType") continue;
      const primExt = key.startsWith("_");
      const name = primExt ? key.slice(1) : key;
      let def: Record<string, any> | null = null;
      let typeCode = "";
      let baseRejects = false;
      let choiceName: string | undefined;
      const direct = groups.get(name);
      if (direct && !name.endsWith("[x]")) {
        def = direct.base || direct.slices[0] || null;
        const types: string[] = (def?.type || []).map(typeCodeOf);
        typeCode = types.length === 1 ? types[0] : types[0] || "BackboneElement";
      } else {
        let stemHit = false;
        for (const g of groups.values()) {
          if (!g.name.endsWith("[x]")) continue;
          const stem = g.name.slice(0, -3);
          if (!(name.startsWith(stem) && name.length > stem.length && /[A-Z]/.test(name[stem.length]))) continue;
          stemHit = true;
          choiceName = g.name;
          const d = g.base || g.slices[0];
          const suffix = name.slice(stem.length);
          const t = ((d?.type || []) as any[]).map(typeCodeOf).find((a: string) => a[0].toUpperCase() + a.slice(1) === suffix);
          if (d && !t) baseRejects = true; // the base element does not have this type: the parser drops it (Unrecognized)
          if (d && t) {
            const prev = choiceSeen.get(stem);
            if (prev !== undefined && prev !== name) {
              def = null; // a second value of this choice: reported by the profile walk
              typeCode = "";
            } else {
              choiceSeen.set(stem, name);
              def = d;
              typeCode = t;
            }
          }
          break;
        }
        if (stemHit && !def && !baseRejects) continue; // second choice value: reported by the profile walk
      }
      if (!def) {
        unknown(key);
        continue;
      }
      const raw = node[key];
      const childPath = `${path}.${choiceName ?? name}`; // JsonParser's npath: `value[x]` for a choice
      {
        const bm = String((def.base && def.base.max) ?? def.max ?? "*");
        const arr = bm !== "1" && bm !== "0";
        // a primitive is kept only as a JSON primitive (an object / array there is dropped: "must be a simple value")
        const primOk = (x: unknown): boolean => x === null || typeof x !== "object";
        // (parity v3) an empty array / an array of nulls creates no element (ARRAY_CANNOT_BE_EMPTY, null entries)
        const shapeOk = isPrimitive(typeCode)
          ? arr
            ? Array.isArray(raw) && raw.some((x) => x !== null && primOk(x))
            : raw !== null && primOk(raw)
          : arr
            ? Array.isArray(raw) && raw.some((x) => x !== null)
            : raw !== null && !Array.isArray(raw);
        // (parity v3) a `_x` shadow that is not an object (scalar property) drops the whole property in
        // JsonParser.parseChildPrimitiveInstance: neither the value nor the shadow is a child
        const shadow = node["_" + name];
        const shadowDrops = isPrimitive(typeCode) && !arr && shadow !== undefined && shadow !== null && !isObject(shadow);
        if (name !== "id" && !shadowDrops && ((primExt && (isObject(raw) || (Array.isArray(raw) && raw.some(isObject)))) || (!primExt && shapeOk))) kept++;
      }
      if (primExt) {
        const list = Array.isArray(raw) ? raw : [raw];
        for (let i = 0; i < list.length; i++) {
          const pe = list[i];
          if (!isObject(pe)) continue;
          const pp = Array.isArray(raw) ? `${childPath}[${i}]` : childPath;
          for (const k of Object.keys(pe)) {
            // `value` is kept by the parser (ILLEGAL_PROPERTY, validatePrimitiveExtensions)
            if (k !== "id" && k !== "extension" && !(k === "value" && typeCode !== "xhtml" && isPrimitive(typeCode))) {
              issues.push({ severity: "error", path: pp, code: "structure", message: `Unrecognized property '${k}'` });
            }
          }
          if (Array.isArray(pe.extension)) {
            const extSdx = await this.sdx(CORE + "Extension");
            if (!extSdx) continue;
            for (let j = 0; j < pe.extension.length; j++) {
              if (isObject(pe.extension[j])) await this.structObject(extSdx, extSdx.root, pe.extension[j], `${pp}.extension[${j}]`, issues, depth + 1, false);
            }
          }
        }
        continue;
      }
      if (isPrimitive(typeCode)) continue;
      const baseMax = String((def.base && def.base.max) ?? def.max ?? "*");
      const expectArray = baseMax !== "1" && baseMax !== "0";
      if (expectArray !== Array.isArray(raw)) continue; // wrong JSON shape: the parser drops it
      const childElement = `${elementPath}.${name}`;
      const values: Array<[any, string, string]> = Array.isArray(raw) ? raw.map((v, i) => [v, `${childPath}[${i}]`, `${childElement}[${i}]`]) : [[raw, childPath, childElement]];
      for (const [v, p, ep] of values) {
        if (!isObject(v)) continue;
        if (typeCode === "Resource" || typeCode === "DomainResource" || (typeof v.resourceType === "string" && !COMPLEX_TYPES.includes(typeCode) && !(await this.isDatatype(typeCode)))) {
          await this.structuralPass(v, p, issues, depth + 1);
        } else if (def.contentReference) {
          const target = sdx.byId.get(String(def.contentReference).replace(/^.*#/, ""));
          if (target) await this.structObject(sdx, target, v, p, issues, depth + 1, false, ep);
        } else if (sdx.hasChildren(def)) {
          await this.structObject(sdx, def, v, p, issues, depth + 1, false, ep);
        } else {
          const tsdx = await this.sdx(CORE + typeCode);
          if (tsdx) await this.structObject(tsdx, tsdx.root, v, p, issues, depth + 1, false, ep);
        }
      }
    }
    if (!isRoot && kept === 0 && Object.keys(node).length > 0) {
      issues.push({ severity: "error", path: elementPath, code: "invariant", message: ELE1_MESSAGE });
    }
  }

  /** InstanceValidator.determineId (l. 8948-8966): INV_FAILED_ID's ` at <id>` of a StructureDefinition element / SearchParameter. */
  private invariantId(path: string, rctx: ResourceCtx): string {
    if (rctx.root !== rctx.resource) return ""; // determineId matches the literal path of a root resource
    const r = rctx.resource;
    const rel = path.startsWith(ROOT_TOKEN) ? path.slice(ROOT_TOKEN.length) : path.replace(/^[A-Z][A-Za-z]+/, "");
    const m = r?.resourceType === "StructureDefinition" ? /^\.(snapshot|differential)\.element\[(\d+)\]/.exec(rel) : null;
    if (m) {
      const p = r[m[1]]?.element?.[Number(m[2])]?.path;
      return typeof p === "string" ? ` at ${p}` : "";
    }
    return r?.resourceType === "SearchParameter" && typeof r.code === "string" ? ` at ${r.code}` : "";
  }

  /** InstanceValidator.EXECUTED_CONSTRAINT_LIST: per element, the message list of each executed invariant. */
  private invariantMemo = new WeakMap<object, Map<string, Issue[]>>();
  /** > 0 during the bare pass of a multi-profile element, which has no Java counterpart. */
  private noInvariantMemo = 0;

  private async checkConstraints(
    sdx: SdIndex,
    el: Record<string, any>,
    item: Item,
    typeCode: string,
    rctx: ResourceCtx,
    issues: Issue[],
  ): Promise<void> {
    const constraints: Array<Record<string, any>> = el.constraint || [];
    if (!constraints.length) return;
    if (item.value === null || item.value === undefined) return;
    const env: FhirPathEnv = {
      resource: this.fhirPathView(rctx.resource),
      rootResource: this.fhirPathView(rctx.container || rctx.resource),
      resolveReference: (ref: string) => this.resolveRefForFhirPath(ref, rctx),
    };
    const answers = new Map<string, boolean | null | undefined>();
    const pendingHost = new Map<string, { key: string; fetch: () => Promise<boolean | null | undefined> }>();
    const ask = (kind: string, value: any, url: string, fetch: () => Promise<boolean | null | undefined>): boolean | null | undefined => {
      const key = `${kind}\u0000${url}\u0000${JSON.stringify(value)}`;
      if (answers.has(key)) return answers.get(key);
      pendingHost.set(key, { key, fetch });
      return undefined;
    };
    env.memberOf = (value, url) => ask("member", value, url, () => this.hostMemberOf(value, url));
    env.conformsTo = (value, url) => ask("conforms", value, url, () => this.hostConformsTo(value, url, item, rctx));
    const base = fhirPathBase(String(el.path || sdx.type), item.actualType && isPrimitive(typeCode) ? item.actualType : typeCode);
    // the element model: a resource's dropped properties are not there for FHIRPath (bdl-9 on an `identifier` array …)
    let constraintNode = item.primitiveValue !== undefined ? { value: item.primitiveValue } : this.fhirPathView(item.value);
    if (item.value === rctx.resource && isObject(item.value) && typeof item.value.resourceType === "string") {
      const own = await this.sdx(CORE + item.value.resourceType);
      if (own) constraintNode = await this.constraintView(await this.parsedView(this.fhirPathView(item.value), own), own, own.root, item.value.resourceType);
    } else if (typeCode === "Extension" && isObject(item.value)) {
      // ext-1: a value the parser dropped is no value
      const own = await this.sdx(CORE + "Extension");
      if (own) constraintNode = await this.constraintView(await this.parsedView(this.fhirPathView(item.value), own), own, own.root, "Extension");
    } else if (isObject(constraintNode) && typeof constraintNode.resourceType !== "string" && !item.profileType) {
      constraintNode = await this.constraintView(constraintNode, sdx, el, typeCode);
    }
    for (const c of constraints) {
      // ele-1: structural pass; dom-3: never evaluated (checkInvariant l. 8868-8872) — checkContainedReferences
      if (!c.expression || c.key === "ele-1" || c.key === "dom-3") continue;
      // InstanceValidator.checkInvariant evaluates FHIRPathExpressionFixer.fixExpr(expression, key)
      const fixed = invariantExpression(String(c.expression), c.key);
      // checkInvariants l. 8806-8823: one evaluation per element, keyed by the fixed expression and severity, whichever
      // definition asks; a later definition gets the first one's message objects
      const memoHost = isObject(item.value) ? item.value : item.parent;
      const memoKey = `${isObject(item.value) ? "" : item.path}\u0000${c.severity}\u0000${fixed}`;
      let memo = memoHost && !this.noInvariantMemo ? this.invariantMemo.get(memoHost) : undefined;
      if (memoHost && !this.noInvariantMemo && !memo) this.invariantMemo.set(memoHost, (memo = new Map()));
      const executed = memo?.get(memoKey);
      if (executed) {
        issues.push(...executed);
        continue;
      }
      const invErrors: Issue[] = [];
      memo?.set(memoKey, invErrors);
      const evaluate = async (issues: Issue[]): Promise<void> => {
        const expr = isPrimitive(typeCode) ? primitiveValueAlias(fixed) : fixed;
        // FHIRPathEngine.funcMemberOf / funcConformsTo (l. 5173, 6417) are synchronous there, asynchronous here: the
        // evaluation asks, the answers are fetched, and it runs again with them
        let outcome = evaluateConstraint(constraintNode, base, expr, env);
        for (let round = 0; round < 6 && pendingHost.size; round++) {
          const asks = [...pendingHost.values()];
          pendingHost.clear();
          for (const a of asks) answers.set(a.key, await a.fetch());
          outcome = evaluateConstraint(constraintNode, base, expr, env);
        }
        if (outcome.status === "pass") return;
        const bestPractice = (c.extension || []).some((e: any) => e.url === BEST_PRACTICE_EXT && e.valueBoolean === true);
        if (outcome.status === "unevaluable") {
          issues.push({
            severity: "information",
            path: item.path,
            code: "invariant-unevaluated",
            message: `Invariant ${c.key} could not be evaluated locally (${outcome.reason}); not a conformance failure`,
            element: el.id,
            profile: sdx.url,
            // REVIEW_port_1 F5: an invariant that was not evaluated is not a pass
            unchecked: { kind: "invariant", canonical: `${sdx.url}#${c.key}` },
          });
          return;
        }
        if (outcome.parse) {
          // InstanceValidator.checkInvariant l. 8876-8881: fpe.parse failed — always an error
          issues.push({
            severity: "error",
            path: item.path,
            code: "invariant",
            message: `Problem processing expression '${c.expression}' in profile '${sdx.url}${sdx.sd?.version ? `|${sdx.sd.version}` : ""}' at path '${item.path}': ${outcome.error}`,
            element: el.id,
            profile: sdx.url,
          });
          return;
        }
        const severity = bestPractice || c.severity === "warning" ? "warning" : "error";
        // checkInvariant l. 8896-8909: an evaluation exception fails the invariant; its message follows the text
        const detail = outcome.error ?? outcome.log;
        const log = detail ? `${detail} (log: ${detail})` : "";
        issues.push({
          severity,
          path: item.path,
          code: "invariant",
          message: `Constraint failed: ${c.key}: '${c.human || c.expression}'${this.invariantId(item.path, rctx)}${c.source ? ` (defined in ${stripVersion(c.source)})` : ""}${log}`,
          element: el.id,
          profile: sdx.url,
        });
      };
      await evaluate(invErrors);
      issues.push(...invErrors);
    }
  }
}

/** `seeds` and everything reachable from them along `edges`, added to `visited` (iterative: a chain can be long). */
export function forwardClosure(seeds: number[], edges: number[][], visited: Set<number>, onVisit?: (at: number) => void): void {
  const stack = [...seeds];
  while (stack.length) {
    const at = stack.pop()!;
    if (visited.has(at)) continue;
    visited.add(at);
    onVisit?.(at);
    for (const t of edges[at]) if (!visited.has(t)) stack.push(t);
  }
}

/** Smallest-first queue of positions. */
class MinHeap {
  private readonly a: number[] = [];
  get size(): number {
    return this.a.length;
  }
  push(v: number): void {
    const a = this.a;
    let i = a.length;
    a.push(v);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p] <= a[i]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): number {
    const a = this.a;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l] < a[m]) m = l;
        if (r < a.length && a[r] < a[m]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

/**
 * BundleValidator.checkAllInterlinked's backwards pass (7.0.1): "repeat: scan the entries in order; an unvisited entry with
 * a visited target is reported and its forward closure visited; until a scan finds nothing". The same order of reports
 * in O((n + e) log n) instead of one scan per report (a chain listed backwards took n scans): positions that become
 * eligible ahead of the scan belong to this scan, the others to the next. Adds to `visited`; returns the reported positions.
 */
export function backwardScan(edges: number[][], visited: Set<number>): number[] {
  const sources: number[][] = edges.map(() => []);
  edges.forEach((ts, from) => {
    for (const t of ts) sources[t].push(from);
  });
  let scan = new MinHeap();
  let later = new MinHeap();
  let cursor = -1;
  const reached = (t: number): void => {
    for (const s of sources[t]) if (!visited.has(s)) (s > cursor ? scan : later).push(s);
  };
  for (const t of visited) reached(t);
  const out: number[] = [];
  for (;;) {
    if (scan.size === 0) {
      if (later.size === 0) return out;
      [scan, later] = [later, scan];
      cursor = -1;
    }
    const at = scan.pop();
    if (visited.has(at)) continue;
    cursor = at;
    out.push(at);
    forwardClosure([at], edges, visited, reached);
  }
}

function sliceNameOf(el: Record<string, any>): string {
  if (typeof el.sliceName === "string") return el.sliceName;
  const id = String(el.id || "");
  return id.includes(":") ? id.slice(id.lastIndexOf(":") + 1) : "";
}

// ------------------------------------------------------------------ slicing helpers (InstanceValidator 7.0.1)

/** A slicing definition problem InstanceValidator throws while building a slice expression (→ SLICING_CANNOT_BE_EVALUATED). */
class SlicingDefinitionError extends Error {}

interface SliceMatch {
  /** undefined: cannot be decided locally */
  match: boolean | undefined;
  /** the discriminator expression (Does_not_match_slice_ detail) */
  expression: string;
  /** conformsTo() profiles that failed with errors (ValidationContext.sliceNotes → DETAILS_FOR__MATCHING_AGAINST_PROFILE_) */
  notes?: string[];
}

/** Could_not_match_discriminator_for_slice_in_profile (one / other). */
function couldNotMatch(n: number, discs: string[], sliceId: string, vurl: string): string {
  return n === 1
    ? `Could not match discriminator (${discs.join("|")}) for slice ${sliceId} in profile ${vurl} - the discriminator [${discs.join(", ")}] does not have fixed value, binding or existence assertions`
    : `Could not match any of the ${n} discriminators for slice ${sliceId} in profile ${vurl} - None of the ${n} discriminators [${discs.join(", ")}] have fixed value, binding or existence assertions`;
}

/** InstanceValidator.makeTypeForFHIRPath: canonical type URLs → their tail. */
function fhirPathTypeName(t: string): string {
  return t.includes("/") ? t.slice(t.lastIndexOf("/") + 1) : t;
}

const NON_DOMAIN_RESOURCES = new Set(["Bundle", "Binary", "Parameters"]);

/** FHIRPath `is`: exact type, or Resource / DomainResource for resource types (upper-case names). */
function typeIs(actual: string, want: string): boolean {
  if (actual === want) return true;
  const isRes = /^[A-Z]/.test(actual) && !KNOWN_TYPE_SUFFIX.has(actual);
  if (want === "Resource") return isRes;
  if (want === "DomainResource") return isRes && !NON_DOMAIN_RESOURCES.has(actual);
  return false;
}

function jsonTypeName(v: unknown): string {
  if (typeof v === "string") return "string";
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "decimal";
  return "Element";
}

const PRIMITIVE_TYPE_NAMES = new Set(Object.keys(PRIMITIVES));
/** Type of a fixed[x] / pattern[x] property suffix (`Code` → code, `CodeableConcept`). */
function valueTypeOf(suffix: string): string {
  const l = suffix[0].toLowerCase() + suffix.slice(1);
  return PRIMITIVE_TYPE_NAMES.has(l) ? l : suffix;
}
const STRING_TYPES = new Set(["string", "code", "id", "markdown"]);
const URI_TYPES = new Set(["uri", "url", "canonical", "oid", "uuid"]);
const INTEGER_TYPES = new Set(["integer", "unsignedInt", "positiveInt"]);
const R5_MODEL = "org.hl7.fhir.r5.model.";

const q = (v: unknown): string => `'${String(v)}'`;
const prim = (v: unknown): string | null => (typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? String(v) : null);

function hasExt(v: any): boolean {
  return isObject(v) && Array.isArray(v.extension) && v.extension.length > 0;
}

/** `.coding.where(system = … and version = … and code = … and display = …).exists()` for each pattern Coding (AND). */
function codeableConceptClause(disc: string, cc: any, sliceId: string, values: any[]): { match: boolean; expression: string } {
  if (typeof cc.text === "string") throw new SlicingDefinitionError(`Unsupported CodeableConcept pattern - using text - for discriminator (${disc}) for slice ${sliceId}`);
  if (!Array.isArray(cc.coding) || !cc.coding.length) throw new SlicingDefinitionError(`Unsupported CodeableConcept pattern - must have at least one coding - for discriminator (${disc}) for slice ${sliceId}`);
  if (hasExt(cc)) throw new SlicingDefinitionError(`Unsupported CodeableConcept pattern - extensions are not allowed - for discriminator (${disc}) for slice ${sliceId}`);
  const parts: string[] = [];
  let match = true;
  const codings: any[] = [];
  for (const v of values) if (isObject(v) && Array.isArray(v.coding)) pushAll(codings, v.coding);
  for (const c of cc.coding) {
    if (hasExt(c)) throw new SlicingDefinitionError(`Unsupported CodeableConcept pattern - extensions are not allowed - for discriminator (${disc}) for slice ${sliceId}`);
    const r = codingWhere(`${disc}.coding`, c, sliceId, codings, "CodeableConcept");
    parts.push(r.expression);
    if (!r.match) match = false;
  }
  return { match, expression: parts.join(" and ") };
}

function codingWhere(disc: string, c: any, sliceId: string, values: any[], fhirType: string): { match: boolean; expression: string } {
  const keys = ["system", "version", "code", "display"].filter((k) => c[k] !== undefined && c[k] !== null);
  if (!keys.length) throw new SlicingDefinitionError(`Unsupported: no properties with values found on type ${fhirType} for pattern for discriminator (${disc}) for slice ${sliceId}`);
  const expression = `${disc}.where(${keys.map((k) => `${k} = ${q(c[k])}`).join(" and ")}).exists()`;
  const match = values.some((v) => isObject(v) && keys.every((k) => prim(v[k]) !== null && prim(v[k]) === prim(c[k])));
  return { match, expression };
}

function identifierClause(disc: string, ii: any, sliceId: string, values: any[]): { match: boolean; expression: string } {
  if (hasExt(ii)) throw new SlicingDefinitionError(`Unsupported Identifier pattern - extensions are not allowed - for discriminator (${disc}) for slice ${sliceId}`);
  const keys = ["system", "value", "use"].filter((k) => ii[k] !== undefined && ii[k] !== null);
  const parts = keys.map((k) => `${k} = ${q(ii[k])}`);
  const hasType = isObject(ii.type);
  if (!keys.length && !hasType) throw new SlicingDefinitionError(`Unsupported: no properties with values found on type Identifier for pattern for discriminator (${disc}) for slice ${sliceId}`);
  let typeExpr = "";
  if (hasType) typeExpr = codeableConceptClause("type", ii.type, sliceId, []).expression;
  if (typeExpr) parts.push(typeExpr);
  const match = values.some((v) => {
    if (!isObject(v)) return false;
    if (!keys.every((k) => prim(v[k]) !== null && prim(v[k]) === prim(ii[k]))) return false;
    return hasType ? codeableConceptClause("type", ii.type, sliceId, [v.type]).match : true;
  });
  return { match, expression: `${disc}.where(${parts.join(" and ")}).exists()` };
}

function namedPartsClause(disc: string, v0: any, sliceId: string, values: any[], fhirType: string, allowed: string[], unsupported: string[]): { match: boolean; expression: string } {
  if (hasExt(v0)) throw new SlicingDefinitionError(`Unsupported Identifier pattern - extensions are not allowed - for discriminator (${disc}) for slice ${sliceId}`);
  const keys = allowed.filter((k) => v0[k] !== undefined && v0[k] !== null);
  for (const u of unsupported) {
    if (v0[u] !== undefined && v0[u] !== null) throw new SlicingDefinitionError(`Unsupported property ${u} on type ${fhirType} for pattern for discriminator (${disc}) for slice ${sliceId}`);
  }
  if (!keys.length) throw new SlicingDefinitionError(`Unsupported: no properties with values found on type ${fhirType} for pattern for discriminator (${disc}) for slice ${sliceId}`);
  const match = values.some((v) => isObject(v) && keys.every((k) => prim(v[k]) !== null && prim(v[k]) === prim(v0[k])));
  return { match, expression: `${disc}.where(${keys.map((k) => `${k} = ${q(v0[k])}`).join(" and ")}).exists()` };
}

/** InstanceValidator.buildPattternExpression. */
function patternClause(disc: string, pattern: any, type: string, sliceId: string, values: any[]): { match: boolean; expression: string } {
  if (type === "CodeableConcept") return codeableConceptClause(disc, pattern, sliceId, values);
  if (type === "Coding") {
    if (hasExt(pattern)) throw new SlicingDefinitionError(`Unsupported CodeableConcept pattern - extensions are not allowed - for discriminator (${disc}) for slice ${sliceId}`);
    return codingWhere(disc, pattern, sliceId, values, "Coding");
  }
  if (PRIMITIVE_TYPE_NAMES.has(type)) {
    const quoted = !(type === "boolean" || INTEGER_TYPES.has(type) || type === "decimal");
    const p = prim(pattern);
    return { match: values.some((v) => prim(v) !== null && prim(v) === p), expression: `${disc}.where(value = ${quoted ? q(p) : p}).exists()` };
  }
  if (type === "Identifier") return identifierClause(disc, pattern, sliceId, values);
  if (type === "HumanName") return namedPartsClause(disc, pattern, sliceId, values, "HumanName", ["use", "text", "family"], ["given", "prefix", "suffix", "period"]);
  if (type === "Address") return namedPartsClause(disc, pattern, sliceId, values, "Address", ["use", "type", "text", "city", "district", "state", "postalCode", "country"], ["line", "period"]);
  throw new SlicingDefinitionError(`Unsupported fixed pattern type for discriminator (${disc}) for slice ${sliceId}: ${type}`);
}

/** InstanceValidator.buildFixedExpression. */
function fixedClause(disc: string, fixed: any, type: string, sliceId: string, values: any[]): { match: boolean; expression: string } {
  if (type === "CodeableConcept") return codeableConceptClause(disc, fixed, sliceId, values);
  if (type === "Identifier") return identifierClause(disc, fixed, sliceId, values);
  if (type === "Coding") {
    if (hasExt(fixed)) throw new SlicingDefinitionError(`Unsupported CodeableConcept pattern - extensions are not allowed - for discriminator (${disc}) for slice ${sliceId}`);
    return codingWhere(disc, fixed, sliceId, values, "Coding");
  }
  const p = prim(fixed);
  if (STRING_TYPES.has(type) || URI_TYPES.has(type)) return { match: values.some((v) => prim(v) === p), expression: `(${q(p)} in ${disc})` };
  if (INTEGER_TYPES.has(type) || type === "decimal" || type === "boolean") return { match: values.some((v) => prim(v) === p), expression: `(${p} in ${disc})` };
  const cls = type[0].toUpperCase() + type.slice(1) + "Type";
  throw new SlicingDefinitionError(`Unsupported fixed value type for discriminator (${disc}) for slice ${sliceId}: ${R5_MODEL}${/^[a-z]/.test(type) ? cls : type}`);
}

/** Extract `(system, code)` pairs from a code / Coding / CodeableConcept value. */
export function codingsOf(node: any): Array<[string | null, string | null]> {
  if (typeof node === "string") return [[null, node]];
  if (!isObject(node)) return [];
  if (Array.isArray(node.coding)) {
    return node.coding
      .filter((c: any) => isObject(c))
      .map((c: any) => [typeof c.system === "string" ? c.system : null, typeof c.code === "string" ? c.code : null] as [string | null, string | null]);
  }
  if ("code" in node || "system" in node) {
    return [[typeof node.system === "string" ? node.system : null, typeof node.code === "string" ? node.code : null]];
  }
  return [];
}

/** All `reference` strings below `node`, with their instance paths. */
/**
 * Local hyperlinks (`<a href="#x">`) of an XHTML div that resolve to no anchor: href, the element path of the
 * link (div/p/a) and its text, as the HL7 validator reports them.
 */
export function narrativeLinkProblems(div: string, anchors: ReadonlySet<string>): Array<{ href: string; at: string; text: string }> {
  const out: Array<{ href: string; at: string; text: string }> = [];
  const stack: string[] = [];
  const re = /<(\/?)([a-zA-Z][\w:-]*)([^>]*?)(\/?)>/gu;
  let m: RegExpExecArray | null;
  let open: { href: string; at: string; start: number } | null = null;
  while ((m = re.exec(div))) {
    const [all, close, tag0, attrs, selfClose] = m;
    const tag = tag0.toLowerCase();
    if (close) {
      const i = stack.lastIndexOf(tag);
      if (i >= 0) stack.length = i;
      if (tag === "a" && open) {
        const text = div.slice(open.start, m.index).replace(/<[^>]*>/gu, "").replace(/\s+/gu, " ").trim();
        if (!anchors.has(open.href.slice(1))) out.push({ href: open.href, at: open.at, text });
        open = null;
      }
      continue;
    }
    if (selfClose) continue;
    stack.push(tag);
    if (tag === "a") {
      const h = /\shref\s*=\s*["']([^"']*)["']/u.exec(attrs);
      if (h && h[1].startsWith("#") && h[1].length > 1) open = { href: h[1], at: stack.join("/"), start: m.index + all.length };
    }
  }
  return out;
}

/**
 * (parity v1) Errors the HL7 JSON parser reports before validation (unknown properties, JSON shape): its conformsTo
 * (InstanceValidator.conformsToProfile, a fresh validateResource on the parsed tree) never sees them, so profile
 * matching — slices by profile, reference target profiles — ignores them here too.
 */
const PARSE_ISSUE = /^Error parsing XHTML: |^Invalid entity in the XHTML \(|^Unrecognized property '|^The property \S+ must be (?:a JSON Array|an Array|an Object), not |^This property must be (?:a simple value|an object), not |^Error parsing JSON: |^Array cannot be empty|^Object must have some content$/u;
function isParseIssue(i: { message?: string }): boolean {
  return PARSE_ISSUE.test(String(i.message ?? ""));
}

/** JsonParser.describe (7.0.1): how the HL7 parser names a JSON value in shape errors. */
function describeJson(v: unknown): string {
  if (Array.isArray(v)) return "an Array";
  if (v === null) return "a Null";
  if (isObject(v)) return "an Object";
  return "a Primitive property";
}

function collectRefPaths(node: any, path: string, out: Array<{ ref: string; path: string }>): void {
  if (Array.isArray(node)) {
    node.forEach((x, i) => collectRefPaths(x, `${path}[${i}]`, out));
    return;
  }
  if (!isObject(node)) return;
  if (typeof node.reference === "string" && node.reference) out.push({ ref: node.reference, path });
  for (const [k, v] of Object.entries(node)) {
    if (k === "reference" || k.startsWith("_")) continue;
    collectRefPaths(v, path ? `${path}.${k}` : k, out);
  }
}

/**
 * BundleValidator.findReferences (7.0.1) over a Bundle entry: every Reference.reference, plus url / uri values that
 * are not systems / profiles / Extension.url (here: extension value[x] url / uri, the type-free reading); a nested
 * Bundle is not entered. `nl` marks a narrativeLink extension value (isNLLink).
 */
function collectBundleRefs(node: any, path: string, out: Array<{ ref: string; path: string; source: object; nl: boolean }>, parent: Record<string, any> | null): void {
  if (Array.isArray(node)) {
    node.forEach((x, i) => collectBundleRefs(x, `${path}[${i}]`, out, parent));
    return;
  }
  if (!isObject(node)) return;
  if (typeof node.reference === "string" && node.reference) out.push({ ref: node.reference, path, source: node, nl: false });
  for (const [k, v] of Object.entries(node)) {
    if (k === "reference" || k.startsWith("_")) continue;
    if ((k === "valueUrl" || k === "valueUri") && typeof v === "string" && typeof node.url === "string") {
      out.push({ ref: v, path: `${path}.value[x]`, source: node, nl: node.url === "http://hl7.org/fhir/StructureDefinition/narrativeLink" });
      continue;
    }
    if (isObject(v) && v.resourceType === "Bundle") continue; // don't walk into a sub-bundle
    collectBundleRefs(v, path ? `${path}.${k}` : k, out, node);
  }
}

/** InstanceValidator.tryParse (7.0.1): the resource type a reference URL names (a known type only). */
function tryParseRefType(ref: string): string | null {
  const parts = javaSplit(ref, "/");
  const known = (t: string | undefined): string | null => (t && t !== "" && R4_RESOURCE_NAMES.has(t) ? t : null);
  if (parts.length === 1) return null;
  if (parts.length === 2) return known(parts[0]);
  if (parts[parts.length - 2] === "_history" && parts.length >= 4) return known(parts[parts.length - 4]);
  return known(parts[parts.length - 2]);
}

/**
 * BaseValidator.findFragmentMatches (7.0.1) count: element ids (resources, datatypes, a primitive's `_x.id`), xhtml
 * id attributes and a/@name anchors anywhere under `node` equal to the fragment.
 */
function fragmentMatches(node: any, fragment: string): number {
  let n = 0;
  const walk = (x: any, d: number): void => {
    if (d > 60 || !x || typeof x !== "object") return;
    if (Array.isArray(x)) return void x.forEach((y) => walk(y, d + 1));
    if (x.id === fragment) n++;
    if (typeof x.div === "string") {
      for (const m of x.div.matchAll(/<([A-Za-z][\w:-]*)\b([^>]*)>/gu)) {
        for (const a of m[2].matchAll(/\s(id|name)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu)) {
          const val = a[2] ?? a[3];
          if (val === fragment && (a[1] === "id" || m[1].toLowerCase() === "a")) n++;
        }
      }
    }
    for (const v of Object.values(x)) if (v && typeof v === "object") walk(v, d + 1);
  };
  walk(node, 0);
  return n;
}

/** BaseValidator.countFragmentMatches: element ids and xhtml id attributes inside an entry equal to the fragment. */
function countFragmentMatches(node: any, fragment: string): number {
  let n = 0;
  const walk = (x: any, d: number): void => {
    if (d > 40 || !x || typeof x !== "object") return;
    if (Array.isArray(x)) return void x.forEach((y) => walk(y, d + 1));
    if (x.id === fragment) n++;
    if (typeof x.div === "string") for (const m of x.div.matchAll(/\sid\s*=\s*["']([^"']+)["']/gu)) if (m[1] === fragment) n++;
    for (const v of Object.values(x)) if (v && typeof v === "object") walk(v, d + 1);
  };
  walk(node, 0);
  return n;
}

/** BaseValidator.isSearchUrl (7.0.1): `[type]?name=value(&name=value)*`. */
function isSearchUrl(ref: string): boolean {
  const q = ref.indexOf("?");
  if (q < 0 || !R4_RESOURCE_NAMES.has(ref.slice(0, q))) return false;
  const pairs = ref
    .slice(q + 1)
    .split(/[&;]/u)
    .filter((s) => s !== "");
  if (!pairs.length) return false;
  for (const p of pairs) {
    const eq = p.indexOf("=");
    const name = eq < 0 ? p : p.slice(0, eq);
    if (!/^[_a-zA-Z][_a-zA-Z0-9.:-]*$/u.test(name)) return false;
    if (eq < 0) return false;
    let value = p.slice(eq + 1);
    try {
      value = decodeURIComponent(value.replace(/\+/gu, " "));
    } catch {
      /* keep raw */
    }
    if (!/^[^=&]*$/u.test(value)) return false;
  }
  return true;
}

function dedupe(issues: Issue[]): Issue[] {
  const seen = new Set<string>();
  const out: Issue[] = [];
  for (const i of issues) {
    // (parity v1) BaseValidator.hasMessage / preciseMatch: the same rule from another profile ("(from X)") is another
    // message; an invariant is evaluated once per element and expression (its "(defined in …)" is not part of the key)
    const msgKey = i.code === "invariant" ? i.message.replace(/ \(defined in [^)]*\)$/, "") : i.message;
    const k = `${i.severity}|${i.path}|${i.code}|${msgKey}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(i);
  }
  return out;
}

/** Validate one resource with a resolver (convenience). */
export async function validateInstance(
  resolver: ValidatorResolver,
  resource: Record<string, any>,
  opts: ValidateOptions = {},
): Promise<Issue[]> {
  return new InstanceValidator(resolver).validate(resource, opts);
}
