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

import { evaluateConstraint, fhirPathBase, invariantExpression, primitiveValueAlias, type FhirPathEnv } from "./fhirPath.js";
import { fixedPattern } from "./fhirSnapshot.js";
import { pushAll } from "./arrayUtils.js";
import { UCUM_SYSTEM, checkUcumCode, ucumUnknownCodeMessage } from "./fhirUcum.js";
import { hl7UrlMustResolve, uriResolutionExempt, urlResolveMessage, urnSyntaxIssue } from "./fhirUriRules.js";
import { codingVersionIssue } from "./fhirExternalTerminology.js";

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
   */
  unchecked?: { kind: "profile" | "valueSet"; canonical: string };
}

export function issue(severity: string, path: string, code: string, message: string, extra: Partial<Issue> = {}): Record<string, any> {
  return { severity, path, code, message, ...extra };
}

export function isValid(issues: Array<Record<string, any>>): boolean {
  return !issues.some((i) => i.severity === "error" || i.severity === "fatal");
}

/** Machine-readable completeness of one validation run (see completenessOf). */
export interface Completeness {
  /** false when a declared profile / required binding could not be checked, or IG dependencies are missing. */
  checked_fully: boolean;
  /** Canonicals (as written, `|version` kept) of profiles that were not checked. */
  profiles_unchecked: string[];
  /** Required-binding ValueSets (as written) that could not be resolved, so the binding was not checked. */
  valuesets_unchecked: string[];
  /**
   * Number of definition / terminology lookups that failed while validating
   * (database trouble; v8). Present only when > 0: the run then also carries
   * an error issue with code `exception` and `checked_fully` is false.
   */
  lookups_failed?: number;
}

/** Issue code of the "validation incomplete: lookups failed" error (v8). */
export const LOOKUP_FAILURE_CODE = "exception";

/**
 * The error issue reported when definition / terminology lookups failed during
 * a validation (v8). HL7 validator_cli reports an internal failure as a fatal
 * `exception` issue rather than passing the resource; a verdict reached while
 * lookups were failing is likewise never a clean pass: the issue makes `valid`
 * false and `checked_fully` false, and names the first failures.
 */
export function lookupFailureIssue(total: number, samples: Array<{ code: string | null; message: string }>): Issue {
  const detail = samples
    .slice(0, 3)
    .map((f) => `${f.code ? `[${f.code}] ` : ""}${f.message}`)
    .join("; ");
  return {
    severity: "error",
    path: "",
    code: LOOKUP_FAILURE_CODE,
    message:
      `Validation incomplete: ${total} definition / terminology lookup${total === 1 ? "" : "s"} failed during validation (${detail}); ` +
      "profiles, code systems or references could not be checked, so this verdict is not reliable — retry the call once the database is reachable",
  };
}

/**
 * Completeness of a validation from its issues (+ the IG closure's missing
 * dependencies). Decision (v6): `valid` keeps HL7 validator_cli semantics —
 * an unresolvable profile is a warning (Validation_VAL_Profile_Unknown), so a
 * resource can be `valid: true` without that profile having been checked —
 * and the incompleteness is reported separately: `checked_fully: false` plus
 * the canonicals in `profiles_unchecked` / `valuesets_unchecked`.
 */
export function completenessOf(issues: Array<Record<string, any>>, depsMissing: unknown[] = []): Completeness {
  const profiles = new Set<string>();
  const valueSets = new Set<string>();
  let lookupsFailed = 0;
  for (const i of issues) {
    if (i && i.code === LOOKUP_FAILURE_CODE) {
      const m = /^Validation incomplete: (\d+) /.exec(String(i.message || ""));
      lookupsFailed += m ? Number(m[1]) : 1;
    }
    const u = i && i.unchecked;
    if (!u || typeof u.canonical !== "string") continue;
    (u.kind === "valueSet" ? valueSets : profiles).add(u.canonical);
  }
  return {
    checked_fully: profiles.size === 0 && valueSets.size === 0 && lookupsFailed === 0 && !(Array.isArray(depsMissing) && depsMissing.length),
    profiles_unchecked: [...profiles],
    valuesets_unchecked: [...valueSets],
    ...(lookupsFailed > 0 ? { lookups_failed: lookupsFailed } : {}),
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
}

export type CodeCheck = (
  | { status: "ok" }
  /** The system is not known locally (HL7: warning UNKNOWN_CODESYSTEM). */
  | { status: "unknown-system" }
  /** Known-but-unchecked system (e.g. UCUM, BCP-47): say nothing. */
  | { status: "silent" }
  | { status: "invalid-code"; severity: "error" | "warning"; message: string }
  | { status: "invalid-display"; severity: "error" | "warning" | "information"; message: string }
  /** A display was given but there is no local terminology to check it against (default severity information). */
  | { status: "display-unchecked"; message: string; severity?: "warning" | "information" }
) &
  CodeCheckExtra;

export interface ValidatorResolver {
  /**
   * StructureDefinition by canonical URL. The URL may carry `|version`: the
   * resolver must then return only a definition of that version (HL7
   * CanonicalResourceManager.getByPackage rules, see pickCanonicalVersion), or
   * null when that version is not installed in the package closure.
   */
  fetchStructureDefinition(url: string): Promise<Record<string, any> | null>;
  /** ValueSet header (url/title) or null when the ValueSet is not held (`|version` honoured as above). */
  fetchValueSet(url: string): Promise<Record<string, any> | null>;
  /** Membership; system null for bare `code` values. undefined = cannot decide locally. `|version` honoured. */
  valueSetContains(url: string, system: string | null, code: string): Promise<boolean | undefined>;
  /** Existence / display check of a code in its CodeSystem (Coding.version when given). */
  checkCode(system: string, code: string, display: string | null, version?: string | null): Promise<CodeCheck>;
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
  /** (v17.5) Is `version` an installed version of the definition `url`? Absent = not checked (fail-open). */
  definitionVersionExists?(url: string, version: string): Promise<boolean>;
}

export interface ValidateOptions {
  /** Extra profiles (canonical URLs) to validate the root resource against. */
  profiles?: string[];
}

// --------------------------------------------------------------------------- //
// Type knowledge
// --------------------------------------------------------------------------- //

const CORE = "http://hl7.org/fhir/StructureDefinition/";
const FHIR_TYPE_EXT = "http://hl7.org/fhir/StructureDefinition/structuredefinition-fhir-type";
const BEST_PRACTICE_EXT = "http://hl7.org/fhir/StructureDefinition/elementdefinition-bestpractice";

const YEAR = "([0-9]([0-9]([0-9][1-9]|[1-9]0)|[1-9]00)|[1-9]000)";
const MONTH = "(0[1-9]|1[0-2])";
const DAY = "(0[1-9]|[1-2][0-9]|3[0-1])";
const TIME = "([01][0-9]|2[0-3]):[0-5][0-9]:([0-5][0-9]|60)(\\.[0-9]+)?";
const TZ = "(Z|(\\+|-)((0[0-9]|1[0-3]):[0-5][0-9]|14:00))";

interface PrimitiveSpec {
  json: "string" | "number" | "boolean";
  regex?: RegExp;
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
  base64Binary: { json: "string", regex: /^(\s*([0-9a-zA-Z+/=]){4}\s*)+$/ },
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

const EXAMPLE_HOST = /(^|\.)(example\.(org|com|net)|acme\.(com|org))$/i;

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
      if (segs.slice(0, -1).some((s) => s.includes("/"))) continue; // inside a re-slice
      const parentId = segs.slice(0, -1).join(".");
      const colon = last.indexOf(":");
      const name = colon >= 0 ? last.slice(0, colon) : last;
      const sliceName = colon >= 0 ? last.slice(colon + 1) : null;
      if (sliceName && sliceName.includes("/")) continue; // re-slices are not evaluated
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
}

/** Bundle types whose entries may omit fullUrl (HL7: "Except for transactions and batches"). */
const FULLURL_OPTIONAL_BUNDLE_TYPES = ["transaction", "batch", "transaction-response", "batch-response"];
const ABSOLUTE_URL = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const RESTFUL_REF = /^([A-Z][A-Za-z]+)\/([A-Za-z0-9\-.]{1,64})(?:\/_history\/([A-Za-z0-9\-.]{1,64}))?$/;

interface Item {
  value: any;
  ext: any;
  /** (parity v1) An item of a repeating element (its JSON shape errors say "must be an Array"). */
  inList?: boolean;
  /** (parity v1) Validated as the profile's single type although written as another (Extension_PROF_Type). */
  profileType?: boolean;
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
  /** Url of the Extension this item is the value[x] of (HL7: context type "extension"). */
  parentExtUrl?: string;
  /** For an extension item: the element that holds it (its context). */
  host?: ExtensionHost;
}

/** The element an extension sits on, as InstanceValidator.checkExtensionContext sees it. */
interface ExtensionHost {
  path: string;
  value: any;
  /** Literal path (indexes stripped) + logical paths, sorted, de-duplicated. */
  plist: string[];
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

/** Port of NodeStack.isRealPath (7.0.1): which children of an abstract logical path are real. */
function isRealPath(lp: string, name: string): boolean {
  if (lp === "Element") return name === "id" || name === "extension";
  if (lp === "BackboneElement" || lp === "BackboneType") return name === "modifierExtension";
  if (lp === "Resource") return ["id", "meta", "implicitRules", "language"].includes(name);
  if (lp === "DomainResource") return ["text", "contained", "extension", "modifierExtension"].includes(name);
  return true;
}

function stripIndexes(path: string): string {
  return path.replace(/\[[^\]]*\]/g, "");
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
  const complex = !isPrimitive(typeCode) && typeCode !== "BackboneElement" && typeCode !== "Element" && !def.contentReference;
  for (const lp of parent || []) {
    if (complex) {
      if (!isRealPath(lp, tail)) continue;
      out.add(`${lp}.${tail}`);
      if (tail.endsWith("[x]")) out.add(`${lp}.${key}`);
    } else {
      if (!isRealPath(lp, key) && !isRealPath(lp, tail)) continue;
      out.add(`${lp}.${key}`);
      if (tail !== key) out.add(`${lp}.${tail}`);
    }
  }
  if (complex) out.add(typeCode);
  else if (def.contentReference) out.add(String(def.contentReference).slice(String(def.contentReference).indexOf("#") + 1));
  else for (const t of def.type || []) out.add(typeCodeOf(t));
  if (!complex && !(def.type || []).length && !def.contentReference) out.add(typeCode);
  return [...out];
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

/** HL7 core / THO ValueSets: tx.fhir.org knows them server-side, so they are a ValueSet as system in any context. */
/** Marker on a pending IG-ValueSet-as-system issue (removed by settleVsSystems before validate() returns). */
const VS_SYSTEM = "__vsSystem";

function isHl7ValueSetUrl(url: string): boolean {
  return url.startsWith("http://hl7.org/fhir/ValueSet/") || url.startsWith("http://terminology.hl7.org/ValueSet/");
}

export class InstanceValidator {
  private sdCache = new Map<string, Promise<SdIndex | null>>();
  private conformCache = new WeakMap<object, Map<string, Promise<Issue[]>>>();
  private inProgress = new WeakMap<object, Set<string>>();
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
  private codeCache = new Map<string, Promise<CodeCheck>>();
  /** Values that matched a slice (their url / discriminators are known to the slice definition). */
  private sliceMatched = new WeakSet<object>();

  constructor(private readonly resolver: ValidatorResolver) {}

  // ------------------------------------------------------------------ public

  async validate(resource: Record<string, any>, opts: ValidateOptions = {}): Promise<Issue[]> {
    const issues: Issue[] = [];
    if (!isObject(resource) || typeof resource.resourceType !== "string") {
      return [{ severity: "fatal", path: "", code: "structure", message: "resource must be a JSON object with a resourceType" }];
    }
    const bundle = resource.resourceType === "Bundle" ? this.bundleCtx(resource) : null;
    const rctx: ResourceCtx = { resource, container: null, root: resource, bundle, entry: null };
    // `|version` is kept: HL7 resolves a versioned canonical to that version only.
    const extra = (opts.profiles || []).map((p) => String(p || "").trim()).filter((p) => p !== "");
    this.boundValueSets = new Set();
    this.pendingVsSystems = false;
    await this.validateResource(rctx, resource.resourceType, extra, issues, 0);
    if (bundle) this.validateBundleRules(bundle, resource.resourceType, issues);
    await this.structuralPass(resource, resource.resourceType, issues, 0);
    await this.settleVsSystems(issues);
    return dedupe(issues);
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
    const visit = async (url: string, depth: number): Promise<void> => {
      const u = stripVersion(url);
      if (loaded.has(u) || depth > 4) return;
      loaded.add(u);
      let vs: Record<string, any> | null = null;
      try {
        vs = await this.vsHeader(url);
      } catch {
        vs = null;
      }
      const incs = vs && isObject(vs.compose) && Array.isArray(vs.compose.include) ? vs.compose.include : [];
      for (const inc of incs) if (isObject(inc) && Array.isArray(inc.valueSet)) for (const v of inc.valueSet) if (typeof v === "string" && v) await visit(v, depth + 1);
    };
    for (const u of this.boundValueSets) await visit(u, 0);
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
    const key = `${system}|${code}|${display}|${version}`;
    let p = this.codeCache.get(key);
    if (!p) {
      p = this.resolver.checkCode(system, code, display, version);
      this.codeCache.set(key, p);
    }
    return p;
  }

  private bundleCtx(bundle: Record<string, any>): BundleCtx {
    const entries: BundleEntryCtx[] = [];
    const byFullUrl = new Map<string, BundleEntryCtx[]>();
    const entryOf = new Map<object, BundleEntryCtx>();
    (Array.isArray(bundle.entry) ? bundle.entry : []).forEach((e: any, index: number) => {
      const r = isObject(e) ? e.resource : null;
      if (!isObject(r)) return;
      const fullUrl = typeof e.fullUrl === "string" && e.fullUrl ? e.fullUrl : null;
      const ent: BundleEntryCtx = { index, fullUrl, resource: r };
      entries.push(ent);
      entryOf.set(r, ent);
      if (fullUrl) {
        const list = byFullUrl.get(fullUrl) || [];
        list.push(ent);
        byFullUrl.set(fullUrl, list);
      }
    });
    return { bundle, type: typeof bundle.type === "string" ? bundle.type : "", entries, byFullUrl, entryOf };
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
      if (d > 30 || !n || typeof n !== "object") return;
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
   * Resolve a reference inside a Bundle the way the HL7 validator does
   * (resolveInBundle): absolute references (urn:uuid:, http(s)://...) match an
   * entry's fullUrl exactly; relative references (`Type/id[/_history/v]`) are
   * made absolute against the referring entry's RESTful fullUrl and then matched
   * the same way. There is no type/id fallback: an entry whose fullUrl does not
   * match is NOT the target (the HL7 validator only hints at the near-miss).
   */
  private resolveInBundle(ref: string, b: BundleCtx, from: BundleEntryCtx | null): BundleEntryCtx | null {
    let url: string | null = null;
    if (ABSOLUTE_URL.test(ref)) url = ref;
    else {
      const m = RESTFUL_REF.exec(ref);
      const fu = from?.fullUrl;
      const self = from ? `${from.resource.resourceType}/${from.resource.id}` : null;
      if (m && fu && self && /^https?:\/\//.test(fu) && fu.endsWith("/" + self)) {
        url = fu.slice(0, fu.length - self.length) + ref;
      }
    }
    if (!url) return null;
    const hit = b.byFullUrl.get(url);
    if (hit && hit.length) return hit[0];
    // Version-specific reference: fullUrl without the version + matching meta.versionId.
    const v = /^(.*)\/_history\/([^/]+)$/.exec(url);
    if (v) {
      for (const e of b.byFullUrl.get(v[1]) || []) {
        if (isObject(e.resource.meta) && String(e.resource.meta.versionId) === v[2]) return e;
      }
    }
    return null;
  }

  /** Resolve a reference string from `from` (contained siblings, then the Bundle). */
  private resolveRef(ref: string, rctx: ResourceCtx): Record<string, any> | null {
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
    return this.resolveInBundle(ref, b, rctx.entry ?? null)?.resource ?? null;
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
      for (const be of bundle.entry) {
        const res = isObject(be) && isObject(be.resource) ? be.resource : null;
        if (!res) continue;
        if (ref === be.fullUrl || ref === `${res.resourceType}/${res.id}`) return res;
      }
      return null;
    };
    return scan(rctx.resource) ?? (rctx.bundle ? this.resolveInBundleByTypeId(ref, rctx.bundle) : null);
  }

  private resolveInBundleByTypeId(ref: string, b: BundleCtx): Record<string, any> | null {
    for (const e of b.entries) if (ref === e.fullUrl || ref === `${e.resource.resourceType}/${e.resource.id}`) return e.resource;
    return null;
  }

  /** Entry whose fullUrl/type/id match a relative reference by type and id only (near-miss hint). */
  private typeIdNearMiss(ref: string, b: BundleCtx): BundleEntryCtx | null {
    const m = RESTFUL_REF.exec(ref);
    if (!m) return null;
    return b.entries.find((e) => e.resource.resourceType === m[1] && e.resource.id === m[2]) ?? null;
  }

  /**
   * Bundle-level rules of the HL7 BundleValidator that are not expressed as
   * FHIRPath invariants: entry fullUrl presence, document / message reference
   * closure, and orphan entries.
   */
  private validateBundleRules(b: BundleCtx, path: string, issues: Issue[]): void {
    const type = b.type;
    for (const e of b.entries) {
      const epath = `${path}.entry[${e.index}]`;
      if (e.fullUrl) {
        const m = /^https?:\/\/.+\/([A-Z][A-Za-z]+)\/([A-Za-z0-9\-.]{1,64})(?:\/_history\/[^/]+)?$/.exec(e.fullUrl);
        const rt = e.resource.resourceType;
        const id = e.resource.id;
        if (m && typeof id === "string" && id && (m[1] !== rt || m[2] !== id)) {
          issues.push({
            severity: "error",
            path: epath,
            code: "invalid",
            message: `The fullUrl '${e.fullUrl}' looks like a RESTful server URL, so it must end with the correct type and id (/${rt}/${id})`,
          });
        }
        continue;
      }
      if (!FULLURL_OPTIONAL_BUNDLE_TYPES.includes(type)) {
        issues.push({
          severity: "error",
          path: epath,
          code: "structure",
          message: "Except for transactions and batches, each entry in a Bundle must have a fullUrl which is the identity of the resource in the entry",
        });
      }
      const refs: Array<{ ref: string; path: string }> = [];
      collectRefPaths(e.resource, `${epath}.resource`, refs);
      if (refs.some((r) => !r.ref.startsWith("#"))) {
        issues.push({ severity: "error", path: epath, code: "structure", message: "Bundle entry missing fullUrl" });
      }
    }
    if (type !== "document" && type !== "message") return;
    const first = b.entries.find((e) => e.index === 0);
    if (!first) return;
    const head = first.resource;
    const hpath = `${path}.entry[0].resource`;
    const checkRef = (v: any, p: string, name: string): void => {
      const ref = isObject(v) ? v.reference : null;
      if (typeof ref !== "string" || !ref || ref.startsWith("#")) return;
      if (this.resolveInBundle(ref, b, first)) return;
      issues.push({ severity: "error", path: p, code: "not-found", message: `Can't find '${ref}' in the bundle (${name})` });
    };
    const list = (v: any): any[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);
    if (type === "document" && head.resourceType === "Composition") {
      checkRef(head.subject, `${hpath}.subject`, "Composition.subject");
      list(head.author).forEach((a, i) => checkRef(a, `${hpath}.author[${i}]`, "Composition.author"));
      checkRef(head.encounter, `${hpath}.encounter`, "Composition.encounter");
      checkRef(head.custodian, `${hpath}.custodian`, "Composition.custodian");
      list(head.attester).forEach((a, i) => checkRef(isObject(a) ? a.party : null, `${hpath}.attester[${i}].party`, "Composition.attester.party"));
      const sections = (secs: any, p: string): void => {
        list(secs).forEach((s, i) => {
          if (!isObject(s)) return;
          list(s.entry).forEach((x, j) => checkRef(x, `${p}[${i}].entry[${j}]`, "Section Entry"));
          sections(s.section, `${p}[${i}].section`);
        });
      };
      sections(head.section, `${hpath}.section`);
    } else if (type === "message" && head.resourceType === "MessageHeader") {
      list(head.focus).forEach((f, i) => checkRef(f, `${hpath}.focus[${i}]`, "MessageHeader Data"));
    } else if (type === "document") {
      // (parity v1) BundleValidator.validateDocument (Bundle_BUNDLE_Entry_Document): the first resource is not a
      // Composition — reported, and checkAllInterlinked still runs from entry 0 (BundleValidator.validateBundle)
      issues.push({ severity: "error", path: hpath, code: "invalid", message: "The first entry in a document must be a composition" });
    } else {
      return; // bdl-12 reports the wrong first resource of a message
    }
    // Orphans: every entry must be reachable from the first one, following
    // references forwards (and, failing that, backwards).
    const targets = new Map<BundleEntryCtx, BundleEntryCtx[]>();
    for (const e of b.entries) {
      const refs: Array<{ ref: string; path: string }> = [];
      collectRefPaths(e.resource, "", refs);
      const out: BundleEntryCtx[] = [];
      for (const r of refs) {
        if (r.ref.startsWith("#")) continue;
        const t = this.resolveInBundle(r.ref, b, e);
        if (t && t !== e) out.push(t);
      }
      targets.set(e, out);
    }
    const forward = new Set<BundleEntryCtx>();
    const visit = (e: BundleEntryCtx, set: Set<BundleEntryCtx>): void => {
      if (set.has(e)) return;
      set.add(e);
      for (const t of targets.get(e) || []) visit(t, set);
    };
    visit(first, forward);
    const reached = new Set(forward);
    let grew = true;
    while (grew) {
      grew = false;
      for (const e of b.entries) {
        if (reached.has(e)) continue;
        if ((targets.get(e) || []).some((t) => reached.has(t))) {
          visit(e, reached);
          grew = true;
        }
      }
    }
    const what = type === "document" ? "Composition" : "MessageHeader";
    // (v17.5, BundleValidator.checkAllInterlinked) relative references of the other entries resolved inside a
    // document / message Bundle: a near miss is an error, reported on the Bundle
    // with its source (choice elements named as the validator names them: medication[x]); a resource of the
    // same type and id whose fullUrl does not match the relative-reference rule is named in a note.
    for (const e of b.entries) {
      if (e === first) continue;
      const refs: Array<{ ref: string; path: string }> = [];
      collectRefPaths(e.resource, `${path}.entry[${e.index}].resource`, refs);
      for (const r of refs) {
        // relative references only: an unresolved urn: / absolute one is the element-level warning (validator_cli)
        if (r.ref.startsWith("#") || ABSOLUTE_URL.test(r.ref)) continue;
        if (this.resolveInBundle(r.ref, b, e)) continue;
        const near = this.typeIdNearMiss(r.ref, b);
        // (parity v2) checkAllInterlinked passes isWarning=true: a reference that matches no entry at all is only a
        // hint there (BaseValidator.resolveInBundle → hintOrError(!isWarning, BUNDLE_BUNDLE_ENTRY_NOTFOUND)); the
        // error is the near miss — an entry of the same type and id whose fullUrl breaks the relative-reference rule
        // (rulePlural BUNDLE_BUNDLE_ENTRY_NOTFOUND_APPARENT / _CANNOT)
        if (!near) continue;
        const source = r.path.replace(/\.([a-z][A-Za-z]*?)Reference(?=$|[.[])/gu, ".$1[x]");
        issues.push({
          severity: "error",
          path,
          code: "not-found",
          message:
            `Can't find '${r.ref}' in the bundle (${source})` +
            (near ? `. Note that there is a resource in the bundle with the same type and id, but it does not match because of the fullUrl based rules around matching relative references. Must be \`${near.fullUrl ?? ""}\`` : ""),
        });
      }
    }
    for (const e of b.entries) {
      const label = e.fullUrl ?? `${e.resource.resourceType}/${e.resource.id}`;
      if (!reached.has(e)) {
        issues.push({
          severity: type === "document" ? "error" : "warning",
          path: `${path}.entry[${e.index}]`,
          code: "informational",
          message: `Entry '${label}' isn't reachable by traversing links (forward or backward) from the ${what}`,
        });
      } else if (type === "document" && !forward.has(e) && e.resource.resourceType !== "Provenance") {
        issues.push({
          severity: "warning",
          path: `${path}.entry[${e.index}]`,
          code: "informational",
          message: `Entry '${label}' isn't reachable by traversing forwards from the Composition. Only Provenance is approved to be used this way (R4 rule)`,
        });
      }
    }
  }

  // ------------------------------------------------------------------ resources

  private async validateResource(
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
    const profiles: string[] = [];
    const metaProfiles = isObject(resource.meta) && Array.isArray(resource.meta.profile) ? resource.meta.profile : [];
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
    pushAll(issues, await this.conformance(rctx, CORE + rt, path, depth));
    for (const p of profiles) {
      if (p === CORE + rt) continue;
      const sdx = await this.sdx(p);
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
        issues.push({
          severity: "error",
          path,
          code: "structure",
          message: `Profile '${p}' is for type ${sdx.type}, but the resource is a ${rt}`,
        });
        continue;
      }
      pushAll(issues, await this.conformance(rctx, p, path, depth));
    }
  }

  /** Issues of `rctx.resource` against one StructureDefinition (memoised per resource object). */
  private conformance(rctx: ResourceCtx, url: string, path: string, depth: number): Promise<Issue[]> {
    let byUrl = this.conformCache.get(rctx.resource);
    if (!byUrl) {
      byUrl = new Map();
      this.conformCache.set(rctx.resource, byUrl);
    }
    let p = byUrl.get(url);
    if (p && this.inProgress.get(rctx.resource)?.has(url)) {
      // Re-entrant request (reference cycle): assume conformance for the inner check.
      return Promise.resolve([]);
    }
    if (!p) {
      let running = this.inProgress.get(rctx.resource);
      if (!running) {
        running = new Set();
        this.inProgress.set(rctx.resource, running);
      }
      running.add(url);
      const done = running;
      p = (async () => {
        const sdx = await this.sdx(url);
        const out: Issue[] = [];
        if (!sdx) return out;
        // (v17.5) local hyperlinks of the narrative must resolve (the HL7 validator's XHTML check) — part of every
        // conformance check of the resource, so a profile match (slice by resolve() profile) sees it too
        const res0 = rctx.resource;
        if (isObject(res0.text) && typeof res0.text.div === "string") {
          for (const m of narrativeLinkProblems(res0.text.div, this.narrativeAnchors(rctx))) {
            out.push({ severity: "error", path: `${ROOT_TOKEN}.text.div`, code: "invalid", message: `Hyperlink '${m.href}' at '${m.at}' for '${m.text}' does not resolve` });
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
          rctx,
          out,
          depth + 1,
          true,
        );
        return out;
      })().finally(() => done.delete(url));
      byUrl.set(url, p);
    }
    // Results are cached with a root token so the same resource reached by
    // another route (e.g. through a reference) reports at its real location.
    return p.then((list) =>
      list.map((i) => {
        // Messages that quote their location (parser-stage "(at …)" / "(key at …)") carry the token too.
        const message = i.message.includes(ROOT_TOKEN) ? i.message.split(ROOT_TOKEN).join(path) : i.message;
        return i.path.startsWith(ROOT_TOKEN) ? { ...i, path: path + i.path.slice(ROOT_TOKEN.length), message } : message === i.message ? i : { ...i, message };
      }),
    );
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
      issues.push({ severity: "warning", path: item.path, code: "too-deep", message: "Validation depth limit reached" });
      return;
    }
    const v = item.value;

    if (isPrimitive(typeCode)) {
      this.checkPrimitive(v, item, typeCode, el, issues);
      if (item.ext !== undefined && item.ext !== null) await this.validatePrimitiveExtensions(item, rctx, issues, depth);
      if (v === null || v === undefined) {
        await this.checkConstraints(sdx, el, item, typeCode, rctx, issues);
        return;
      }
      if (typeof v === "string") await this.checkUri(v, item, typeCode, el, issues);
      this.checkFixedPattern(el, v, item, sdx, issues);
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
      const profiles: string[] = [];
      for (const t of el.type || []) for (const p of t.profile || []) if (typeof p === "string" && p) profiles.push(p);
      const isContained = /\.contained$/.test(String(el.path || ""));
      const child: ResourceCtx = {
        resource: v,
        container: isContained ? rctx.resource : null,
        root: rctx.root,
        bundle: rctx.bundle,
        entry: this.entryFor(v, rctx, true),
      };
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
      await this.validateResource(child, item.path, profiles, issues, depth);
      return;
    }

    if (!isObject(v)) {
      // a value the parser accepted as its own (base) type, validated as the profile's type: no JSON shape error here
      if (item.profileType) return;
      issues.push({
        severity: "error",
        path: item.path,
        code: "structure",
        message: `The property ${item.key} must be ${item.inList ? "an Array" : "an Object"}, not ${describeJson(v)} (at ${item.path})`,
      });
      return;
    }
    if (Object.keys(v).length === 0 && !isResourceRoot) {
      // (parity v2) JsonParser.checkObject (7.0.1): OBJECT_MUST_HAVE_SOME_CONTENT, and the (empty) element is kept —
      // validation goes on, so its required children are reported as missing; no ele-1 on top
      issues.push({ severity: "error", path: item.path, code: "invalid", message: "Object must have some content" });
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
      await this.validateItemAgainst(sdx, { ...el, type: [{ ...el.type[0], profile: undefined }] }, item, typeCode, rctx, bare, depth);
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
      const tagged = async (p: string, list: Issue[]): Promise<Issue[]> => {
        const psdx = await this.sdx(p);
        const tag = ` (validating against ${psdx?.url ?? p}${psdx?.sd?.version ? `|${psdx.sd.version}` : ""} [${psdx?.sd?.name ?? ""}])`;
        return list.map((i) => (own.has(key(i)) ? i : { ...i, message: i.message + tag }));
      };
      if (good.length === 1) {
        issues.push(...good[0][1]);
      } else if (good.length === 0) {
        issues.push({ severity: "error", path: item.path, code: "structure", message: `Unable to find a match for the specified profile among choices: ${[...typeProfiles].sort().join(", ")}` });
        for (const [p, list] of bad) issues.push(...(await tagged(p, list)));
      } else {
        const n = good.length;
        issues.push({ severity: "warning", path: item.path, code: "structure", message: `Found multiple matching profiles among ${n} choice${n === 1 ? "" : "s"}: ${good.map(([p]) => p).sort().join(", ")}` });
        for (const [p, list] of good) issues.push(...(await tagged(p, list)));
      }
      return;
    }

    // Which definition supplies the children?
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
          tsdx = typeProfile ? await this.sdx(typeProfile) : null;
          if (typeProfile && !tsdx && splitCanonicalVersion(typeProfile).version !== null) {
            // Port of InstanceValidator.checkChildByDefinition (7.0.1): a type profile
            // that cannot be resolved is Validation_VAL_Unknown_Profile (error); here a
            // `|version` that is not installed. The value is still checked against the
            // core datatype.
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
          childEl = tsdx.root;
          typeRootConstraints.push([tsdx, tsdx.root]);
          if (typeCode === "Extension" && item.host && tsdx.type === "Extension" && tsdx.url !== CORE + "Extension") {
            await this.checkExtensionContext(tsdx, item.host, rctx, issues, item.value);
          }
        }
      }
    } else if (!isResourceRoot && /^[A-Z]/.test(typeCode) && typeCode !== "BackboneElement" && typeCode !== "Element") {
      // Profile defines the children; datatype-level invariants still apply (ref-1, per-1 ...).
      const tsdx = await this.sdx(CORE + typeCode);
      if (tsdx) typeRootConstraints.push([tsdx, tsdx.root]);
    }

    // InstanceValidator.validateElement (7.0.1): a choice element whose profile constrains its children (e.g. only an
    // extension of effective[x]) while several types stay open — the actual type's children are merged in
    let merge: { sdx: SdIndex; el: Record<string, any> } | null = null;
    if (childEl === el && sdx.hasChildren(el) && (el.type || []).length > 1 && /^[A-Z]/.test(typeCode) && !isResourceRoot) {
      const tsdx = await this.sdx(CORE + typeCode);
      if (tsdx) merge = { sdx: tsdx, el: tsdx.root };
    }
    await this.walkChildren(childSdx, childEl, item, rctx, issues, depth, isResourceRoot, merge);

    if (!isResourceRoot) this.checkFixedPattern(el, v, item, sdx, issues);
    await this.checkBinding(el, v, typeCode, item, issues, null);
    await this.checkLanguageDisplay(el, v, typeCode, item, rctx, issues);
    if (typeCode === "Coding") await this.checkCoding(v, item, issues, el);
    if (QUANTITY_TYPES.includes(typeCode)) await this.checkQuantity(v, item, issues);
    if (typeCode === "Reference") await this.checkReference(el, v, item, rctx, issues, depth);
    await this.checkConstraints(sdx, el, item, typeCode, rctx, issues);
    for (const [tsdx, troot] of typeRootConstraints) {
      if (tsdx === sdx && troot === el) continue;
      await this.checkConstraints(tsdx, troot, item, typeCode, rctx, issues);
    }
  }

  private datatypeCache = new Map<string, Promise<boolean>>();

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
      issues.push({ severity: "error", path: item.path, code: "required", message: "Extension.url is required" });
      return this.sdx(CORE + "Extension");
    }
    const absolute = /^[a-z][a-z0-9+.-]*:/i.test(url);
    if (absolute) {
      const ext = await this.sdx(url);
      if (ext) return ext;
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
        message: `Sub-extension url '${url}' is not defined by the Extension ${parentSdx.url}`,
      });
    } else if (!insideDefinedExtension || absolute) {
      issues.push({
        severity: "error",
        path: item.path,
        code: "structure",
        message: `The extension ${url} could not be found so is not allowed here`,
      });
    }
    return this.sdx(CORE + "Extension");
  }

  private async validatePrimitiveExtensions(item: Item, rctx: ResourceCtx, issues: Issue[], depth: number): Promise<void> {
    const ext = item.ext;
    const path = item.path;
    if (!isObject(ext)) {
      issues.push({ severity: "error", path, code: "structure", message: `The property _${item.key} must be a JSON object` });
      return;
    }
    for (const k of Object.keys(ext)) {
      if (k !== "id" && k !== "extension" && k !== "fhir_comments") {
        issues.push({ severity: "error", path, code: "structure", message: `Unrecognized property '${k}'` });
      }
    }
    const list = ext.extension;
    if (list === undefined) return;
    if (!Array.isArray(list)) {
      issues.push({ severity: "error", path, code: "structure", message: "The property extension must be a JSON Array" });
      return;
    }
    const extSdx = await this.sdx(CORE + "Extension");
    if (!extSdx) return;
    const literal = stripIndexes(path.startsWith(ROOT_TOKEN) ? rctx.resource.resourceType + path.slice(ROOT_TOKEN.length) : path);
    const host: ExtensionHost = {
      path,
      value: item.value,
      plist: [...new Set([literal, ...(item.lp || [])])].sort(),
      isResource: false,
      extUrl: null,
      typeCode: item.typeCode || "",
      defPath: "",
      modifier: false,
    };
    const extLp = (item.lp || []).filter((lp) => isRealPath(lp, "extension")).map((lp) => `${lp}.extension`).concat(["Extension"]);
    for (let i = 0; i < list.length; i++) {
      await this.validateItemAgainst(
        extSdx,
        { id: "Element.extension", path: "Element.extension", min: 0, max: "*", type: [{ code: "Extension" }] },
        { value: list[i], ext: undefined, key: "extension", path: `${path}.extension[${i}]`, typeCode: "Extension", lp: extLp, host },
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
    const hostOf = (modifier: boolean): ExtensionHost => {
      if (!hostCache) {
        const literal = stripIndexes(item.path.startsWith(ROOT_TOKEN) ? rctx.resource.resourceType + item.path.slice(ROOT_TOKEN.length) : item.path);
        const plist = [...new Set([literal, ...(item.lp || [])])].sort();
        const typeCode = item.typeCode || "";
        hostCache = {
          path: item.path,
          value: node,
          plist,
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
    used.add("fhir_comments");

    for (const [gsdx, grp] of groupList) {
      const def = grp.base || grp.slices[0];
      if (!def) continue;
      const name = grp.name;
      const items: Item[] = [];
      const allowedTypes: string[] = (def.type || []).map(typeCodeOf);
      const typedItems: Array<{ item: Item; type: string }> = [];
      const profileTypeKeys = new Set<string>();

      const collect = (key: string, typeCode: string): void => {
        used.add(key);
        used.add("_" + key);
        const lp = childLogicalPaths(item.lp, def, key, typeCode);
        const parentExtUrl = item.typeCode === "Extension" && key.startsWith("value") && typeof node.url === "string" ? node.url : undefined;
        const host = name === "extension" || name === "modifierExtension" ? hostOf(name === "modifierExtension") : undefined;
        const baseMax0 = String((def.base && def.base.max) ?? def.max ?? "*");
        const mk = (value: any, ext: any, p: string): Item => ({ value, ext, key, path: p, typeCode, lp, parentExtUrl, host, inList: baseMax0 !== "1" && baseMax0 !== "0", profileType: profileTypeKeys.has(key) });
        const raw = node[key];
        const rawExt = node["_" + key];
        const baseMax = String((def.base && def.base.max) ?? def.max ?? "*");
        const expectArray = baseMax !== "1" && baseMax !== "0";
        const path = `${item.path}.${key}`;
        // (parity v1) JsonParser.parseChildPrimitive / parseChildComplex (7.0.1, r5 elementmodel): shape errors judged by
        // the base property; a primitive of the wrong shape is dropped, a complex value is still parsed
        const primitiveType = isPrimitive(typeCode);
        if (raw !== undefined && expectArray && !Array.isArray(raw)) {
          issues.push({ severity: "error", path, code: "structure", message: `The property ${key} must be a JSON Array, not ${describeJson(raw)} (at ${item.path})` });
          if (primitiveType) return;
          const it = mk(raw, Array.isArray(rawExt) ? rawExt[0] : rawExt, path);
          items.push(it);
          typedItems.push({ item: it, type: typeCode });
          return;
        }
        if (raw !== undefined && !expectArray && Array.isArray(raw)) {
          issues.push({
            severity: "error",
            path,
            code: "structure",
            message: primitiveType ? `This property must be a simple value, not an Array (${key} at ${path})` : `The property ${key} must be an Object, not an Array (at ${path})`,
          });
          return;
        }
        if (Array.isArray(raw) || (raw === undefined && Array.isArray(rawExt))) {
          const arr = Array.isArray(raw) ? raw : [];
          const exts = Array.isArray(rawExt) ? rawExt : [];
          if (arr.length === 0 && exts.length === 0 && raw !== undefined) {
            issues.push({ severity: "error", path, code: "structure", message: `Array cannot be empty - the property should not be present if it has no values` });
            return;
          }
          const n = Math.max(arr.length, exts.length);
          for (let i = 0; i < n; i++) {
            const val = arr[i] === undefined ? null : arr[i];
            const ex = exts[i] === undefined ? null : exts[i];
            if (val === null && ex === null) {
              issues.push({ severity: "error", path: `${path}[${i}]`, code: "structure", message: "Array entries cannot be null" });
              continue;
            }
            const it = mk(val, ex ?? undefined, `${path}[${i}]`);
            items.push(it);
            typedItems.push({ item: it, type: typeCode });
          }
          return;
        }
        if (raw === undefined && rawExt === undefined) return;
        if (raw === null && rawExt === undefined) {
          issues.push({ severity: "error", path, code: "structure", message: `The property ${key} cannot be null` });
          return;
        }
        const it = mk(raw === undefined ? null : raw, rawExt, path);
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
            if (allowedTypes.length === 1 && !["Element", "BackboneElement", "*"].includes(allowedTypes[0])) {
              accepted++;
              if (accepted > 1) continue;
              issues.push(
                gsdx.type === "Extension" && def.path === "Extension.value[x]"
                  ? {
                      // InstanceValidator.checkExtension (Extension_EXT_Type): an extension's value of a type its definition does not allow
                      severity: "error",
                      path: `${item.path}.${stem}.ofType(${actual})`,
                      code: "structure",
                      message: `The Extension '${gsdx.url}' definition allows for the types ${allowedTypes.join(", ")} but found type ${actual}`,
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
              profileTypeKeys.add(key);
              collect(key, allowedTypes[0]);
              continue;
            }
          }
          if (!t) {
            if (KNOWN_TYPE_SUFFIX.has(suffix)) {
              used.add(key);
              used.add("_" + key);
              issues.push({
                severity: "error",
                path: `${item.path}.${key}`,
                code: "structure",
                message: `The type '${KNOWN_TYPE_SUFFIX.get(suffix)}' is not allowed for ${def.path} (allowed: ${allowedTypes.join(", ")})${gsdx.url !== CORE + gsdx.type ? ` by profile ${gsdx.url}` : ""}`,
                element: def.id,
              });
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

      // Cardinality (per parent instance) against the base definition of this group.
      if (grp.base) this.checkCardinality(grp.base, items.length, item, gsdx, issues);

      if (grp.slices.length && grp.base && grp.base.slicing) {
        await this.validateSliced(gsdx, grp, typedItems, item, rctx, issues, depth);
      } else {
        for (const { item: it, type } of typedItems) {
          await this.validateItemAgainst(gsdx, def, it, type, rctx, issues, depth + 1);
        }
      }
    }

    for (const key of Object.keys(node)) {
      if (used.has(key)) continue;
      if (item.profileType && item.typeCode) {
        // a value written as another type, validated as the profile's: its children are not in that type
        // (Validation_VAL_Profile_NotAllowed against the type's definition)
        const tsdx = await this.sdx(CORE + item.typeCode);
        issues.push({ severity: "error", path: `${item.path}.${key}`, code: "structure", message: `This element is not allowed by the profile ${CORE}${item.typeCode}${tsdx?.sd?.version ? `|${tsdx.sd.version}` : ""}` });
        continue;
      }
      issues.push({ severity: "error", path: item.path, code: "structure", message: `Unrecognized property '${key}'` });
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
    if (count < min) {
      issues.push({
        severity: "error",
        path: parent.path,
        code: "required",
        message: `${def.id || def.path}: minimum required = ${min}, but only found ${count} (from ${from})`,
        element: def.id,
        profile: from,
      });
    }
    if (max !== "*" && /^\d+$/.test(max) && count > Number(max)) {
      issues.push({
        severity: "error",
        path: parent.path,
        code: "cardinality",
        message: `${def.id || def.path}: max allowed = ${max}, but found ${count} (from ${from})`,
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

    for (let idx = 0; idx < typedItems.length; idx++) {
      const { item: it, type } = typedItems[idx];
      let matched: Record<string, any> | null = null;
      let undecided = false;
      let failedHere = false;
      const sliceInfo: string[] = [];
      for (const s of grp.slices) {
        let r: SliceMatch;
        try {
          r = await this.sliceMatches(sdx, base, grp.slices, s, discs, it, type, idx, rctx, depth);
        } catch (e) {
          if (!(e instanceof SlicingDefinitionError)) throw e;
          // matchSlice: FHIRException → SLICING_CANNOT_BE_EVALUATED, unsupportedSlicing
          issues.push({ severity: "error", path: it.path, code: "processing", message: `Slicing cannot be evaluated: ${e.message}`, element: s.id, profile: sdx.url });
          unsupported = true;
          failedHere = true;
          continue;
        }
        if (r.match === undefined) {
          indeterminate.add(s);
          undecided = true;
          continue;
        }
        if (!r.match) {
          sliceInfo.push(`${it.path}: Does not match slice '${sliceNameOf(s)}' (discriminator: ${r.expression})`);
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
      if (indeterminate.has(s)) continue;
      const n = counts.get(s) || 0;
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
      for (const prof of t.profile || []) {
        const psdx = await this.sdx(String(prof));
        if (!psdx) continue;
        const el = this.elementAt(psdx, psdx.root, p);
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
            and(await this.conformsToAny(it, dpath, profs, rctx, depth));
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
    return { match: result, expression: clauses.join(" and ") };
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

  /** `<path>.conformsTo(p1) or …`: the value at the path validates against one of the profiles without errors. */
  private async conformsToAny(it: Item, dpath: string, profs: string[], rctx: ResourceCtx, depth: number): Promise<boolean> {
    const target = dpath === "$this" ? [it.value] : this.discriminatorValues(it.value, dpath, rctx);
    if (target.length !== 1) return false;
    const r = target[0];
    if (!isObject(r)) return false;
    if (!r.resourceType) {
      // a datatype value (Coding, Identifier …) against a datatype profile
      for (const p of profs) {
        const psdx = await this.sdx(p);
        if (!psdx) continue;
        const trial: Issue[] = [];
        const sub: Item = { value: r, ext: undefined, key: dpath.split(".").pop() || it.key, path: this.pathOf(it, dpath) };
        await this.validateItemAgainst(psdx, psdx.root, sub, psdx.type, rctx, trial, depth + 1);
        if (isValid(trial.filter((i) => !isParseIssue(i)))) return true;
      }
      return false;
    }
    for (const p of profs) {
      const psdx = await this.sdx(p);
      if (!psdx) continue;
      if (psdx.type !== r.resourceType && !["Resource", "DomainResource"].includes(psdx.type)) continue;
      const ctx: ResourceCtx = { resource: r, container: null, root: rctx.root, bundle: rctx.bundle, entry: this.entryFor(r, rctx, false) };
      const res = await this.conformance(ctx, p, this.pathOf(it, dpath), depth + 1);
      if (isValid(res.filter((i) => !isParseIssue(i)))) return true;
    }
    return false;
  }

  /** `(<path> memberOf '<vs>')` answered with the local terminology (undefined when it cannot decide). */
  private async bindingClause(valueSet: string, actual: any[]): Promise<boolean | undefined> {
    let hit = false;
    let unknown = false;
    for (const a of actual) {
      if (await this.codelessCodingMember(valueSet, a)) {
        hit = true;
        continue;
      }
      for (const [system, code] of codingsOf(a)) {
        if (!code) continue;
        const m = await this.member(valueSet, system, code);
        if (m === true) hit = true;
        // Port of InstanceValidator.sliceMatches → evaluateSlicingExpression
        // (7.0.1): a required-binding discriminator becomes
        // `memberOf('<vs>')`, answered by the terminology layer; a code system
        // neither the package closure nor tx.fhir.org can resolve is "not a
        // member" (PAS Condition coding with TW Core 0.3.2's
        // …/CodeSystem/icd-10-cm-2023-tw, published under its ValueSet URL →
        // no slice matches).
        if (m === undefined && (system === null || (await this.systemResolvable(system)))) unknown = true;
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
            const r = this.resolveRef(ref, rctx);
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

  private checkPrimitive(v: any, item: Item, typeCode: string, el: Record<string, any>, issues: Issue[]): void {
    // R4 core snapshots type Resource.id as System.String with fhir-type
    // "string"; the HL7 validator still checks a resource id against the `id`
    // syntax (Resource_RES_ID_Malformed), with or without a profile.
    if (typeCode === "string" && isObject(el.base) && el.base.path === "Resource.id") typeCode = "id";
    const spec = PRIMITIVES[typeCode];
    const path = item.path;
    if (v === null || v === undefined) {
      if (item.ext === undefined || item.ext === null) {
        issues.push({ severity: "error", path, code: "structure", message: `The property ${item.key} has no value` });
      }
      return;
    }
    if (isObject(v) || Array.isArray(v)) {
      issues.push({ severity: "error", path, code: "structure", message: `This property must be a simple value, not ${describeJson(v)} (${item.key} at ${path})` });
      return;
    }
    if (item.profileType) {
      // (parity v1) validated as the profile's type, not its own (Extension_PROF_Type was reported): only the
      // InstanceValidator's value checks of that type apply, the parser checked the JSON shape against the base type
      if (typeCode === "boolean" && String(v) !== "true" && String(v) !== "false") {
        issues.push({ severity: "error", path, code: "invalid", message: "Boolean values must be 'true' or 'false'" });
      }
      return;
    }
    if (typeof v !== spec.json) {
      issues.push({ severity: "error", path, code: "structure", message: `Error parsing JSON: the primitive value must be a ${spec.json}` });
      // (parity v2) JsonParser.parseChildPrimitiveInstance keeps the value (as its string) and the InstanceValidator then
      // checks it as the element's type — those value errors take part in slice / profile matching like any other
      const sv = String(v);
      if (spec.json === "boolean") {
        if (sv !== "true" && sv !== "false") issues.push({ severity: "error", path, code: "invalid", message: "Boolean values must be 'true' or 'false'" });
        return;
      }
      if (spec.json === "number") {
        if (typeCode === "decimal") {
          if (!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/u.test(sv)) issues.push({ severity: "error", path, code: "invalid", message: `The value '${sv}' is not a valid decimal` });
        } else if (!/^[+-]?[0-9]+$/u.test(sv)) {
          issues.push({ severity: "error", path, code: "invalid", message: `The value '${sv}' is not a valid integer` });
        }
        return;
      }
      // a number / boolean where a string-like type is expected: its text is checked as that type below
      v = sv;
    }
    if (spec.json === "number") {
      if (!Number.isFinite(v)) {
        issues.push({ severity: "error", path, code: "value", message: `The value '${v}' is not a valid ${typeCode}` });
        return;
      }
      if (typeCode === "integer" || typeCode === "unsignedInt" || typeCode === "positiveInt") {
        if (!Number.isInteger(v)) {
          issues.push({ severity: "error", path, code: "value", message: `The value '${v}' is not a valid integer` });
          return;
        }
        if (v > 2147483647 || v < -2147483648) {
          issues.push({ severity: "error", path, code: "value", message: `The value '${v}' is outside the range of an integer` });
        }
        if (typeCode === "unsignedInt" && v < 0) issues.push({ severity: "error", path, code: "value", message: `The value '${v}' must be >= 0` });
        if (typeCode === "positiveInt" && v < 1) issues.push({ severity: "error", path, code: "value", message: `The value '${v}' must be >= 1` });
      }
      this.checkMinMaxValue(el, v, path, issues);
      return;
    }
    if (spec.json === "boolean") return;
    const s = v as string;
    if (s.length === 0) {
      issues.push({ severity: "error", path, code: "invalid", message: "@value cannot be empty" });
      return;
    }
    if (typeCode === "string" || typeCode === "markdown") {
      if (/^\s|\s$/.test(s) && typeCode === "string") {
        issues.push({ severity: "warning", path, code: "invalid", message: `value should not start or finish with whitespace '${short(s)}'` });
      }
      if (s.length > 1048576) issues.push({ severity: "error", path, code: "invalid", message: "value is longer than permitted maximum length of 1 MB" });
    } else if (spec.regex && !spec.regex.test(s)) {
      if (typeCode === "id" && /\.id$/.test(path) && path.split(".").length <= 3) {
        issues.push({ severity: "error", path, code: "invalid", message: `Invalid Resource id: Invalid Characters ('${short(s)}')` });
      } else if (typeCode === "code") {
        issues.push({ severity: "error", path, code: "invalid", message: `The code '${short(s)}' is not valid (whitespace rules)` });
      } else if (typeCode === "uri" || typeCode === "url" || typeCode === "canonical") {
        issues.push({ severity: "error", path, code: "invalid", message: `URI values cannot have whitespace('${short(s)}')` });
      } else if (typeCode === "dateTime" && /T/.test(s) && !new RegExp(`${TZ}$`).test(s) && new RegExp(`^${YEAR}-${MONTH}-${DAY}T${TIME}$`).test(s)) {
        issues.push({ severity: "error", path, code: "invalid", message: "If a date has a time, it must have a timezone" });
      } else {
        issues.push({ severity: "error", path, code: "invalid", message: `Not a valid ${typeCode} format: '${short(s)}'` });
      }
      return;
    }
    if ((typeCode === "date" || typeCode === "dateTime" || typeCode === "instant") && !validCalendarDate(s)) {
      issues.push({ severity: "error", path, code: "invalid", message: `Not a valid date format: '${short(s)}'` });
      return;
    }
    if (typeCode === "uri" || typeCode === "url" || typeCode === "canonical") {
      const host = /^https?:\/\/([^/:?#]+)/i.exec(s)?.[1];
      if (host && EXAMPLE_HOST.test(host) && !this.inExampleExemptContext(path)) {
        issues.push({ severity: "error", path, code: "invalid", message: `Example URLs are not allowed in this context (${short(s)})` });
      }
    }
    const maxLen = el.maxLength;
    if (typeof maxLen === "number" && s.length > maxLen) {
      issues.push({ severity: "error", path, code: "invalid", message: `value is longer than permitted maximum length of ${maxLen}` });
    }
  }

  private inExampleExemptContext(path: string): boolean {
    // The HL7 validator exempts canonical references to definitions (meta.profile etc.).
    return /\.meta\.profile\[\d+\]$/.test(path) || /\.(implicitRules)$/.test(path);
  }

  private checkMinMaxValue(el: Record<string, any>, v: number, path: string, issues: Issue[]): void {
    for (const [k, lim] of Object.entries(el)) {
      if (k.startsWith("minValue") && typeof lim === "number" && v < lim) {
        issues.push({ severity: "error", path, code: "value", message: `The value ${v} is below the minimum of ${lim}` });
      }
      if (k.startsWith("maxValue") && typeof lim === "number" && v > lim) {
        issues.push({ severity: "error", path, code: "value", message: `The value ${v} is above the maximum of ${lim}` });
      }
    }
  }

  /**
   * Port of InstanceValidator.checkFixedValue (7.0.1) for an element's fixed[x] / pattern[x]: primitives compared by
   * their string value (_DT_Fixed_Wrong, context = <profile|version>#<element id>); complex types field by field
   * (Profile_VAL_MissingElement / Profile_VAL_NotAllowed — the latter for a fixed value only); a CodeableConcept pattern
   * needs each pattern coding matched by one coding of the instance (TYPE_CHECKS_PATTERN_CC), a fixed one the same
   * codings in order; a fixed value without extensions bans extensions on the instance (Extension_EXT_Fixed_Banned).
   */
  private checkFixedPattern(el: Record<string, any>, v: any, item: Item, sdx: SdIndex, issues: Issue[]): void {
    const [fixed, pattern] = fixedPattern(el);
    const source = `${sdx.url}${sdx.sd?.version ? `|${sdx.sd.version}` : ""}`;
    const context = `${source}#${el.id ?? el.path}`;
    const tag = (list: Issue[]): void => {
      for (const i of list) issues.push({ ...i, element: el.id, profile: sdx.url });
    };
    if (fixed) {
      const out: Issue[] = [];
      this.fixedValuePort(out, item.path, v, fixed.value, fixed.field.replace(/^fixed/u, ""), source, String(el.sliceName ?? ""), false, context);
      tag(out);
    }
    if (pattern) {
      const out: Issue[] = [];
      this.fixedValuePort(out, item.path, v, pattern.value, pattern.field.replace(/^pattern/u, ""), source, String(el.sliceName ?? ""), true, context);
      tag(out);
    }
  }

  private fixedValuePort(issues: Issue[], path: string, focus: any, fixed: any, type: string, source: string, propName: string, pattern: boolean, context: string): void {
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
              const list = `[${all.map((x) => x.message).join(", ")}]`;
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
  private async inferCodeSystems(vs: Record<string, any>, code: string): Promise<number | null> {
    const includes = isObject(vs.compose) && Array.isArray(vs.compose.include) ? vs.compose.include : [];
    if (!includes.length) return null;
    const found = new Set<string>();
    for (const inc of includes) {
      if (!isObject(inc)) continue;
      if (Array.isArray(inc.valueSet) && inc.valueSet.length) return null;
      const system = typeof inc.system === "string" ? inc.system : null;
      if (!system) return null;
      if (Array.isArray(inc.filter) && inc.filter.length) return null;
      if (Array.isArray(inc.concept) && inc.concept.length) {
        if (inc.concept.some((c: any) => isObject(c) && c.code === code)) found.add(system);
        continue;
      }
      const r = await this.codeCheck(system, code, null, null);
      if (r.status === "unknown-system") return null;
      if (r.status !== "invalid-code") found.add(system);
    }
    return found.size;
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
    const strength = b.strength;
    if (typeCode !== "Coding" && (strength === "required" || strength === "extensible" || strength === "preferred")) this.boundValueSets.add(stripVersion(String(b.valueSet)));
    if ((strength === "required" || strength === "extensible" || strength === "preferred") && (typeCode === "Coding" || typeCode === "CodeableConcept")) {
      await this.checkCodingVersions(b.valueSet, v, typeCode, item, issues);
    }
    if (strength !== "required" && strength !== "extensible") return;
    if (!["code", "Coding", "CodeableConcept", "Quantity", "string", "uri", "CodeableReference"].includes(typeCode)) return;
    // UCUM quantities are judged by UCUM unit semantics in the HL7 validator
    // (e.g. L/min accepted against ucum-vitals-common); we cannot reproduce that
    // offline, so only non-UCUM coded quantities are checked against the binding.
    if (typeCode === "Quantity" && (!isObject(v) || v.code === undefined || v.system === "http://unitsofmeasure.org")) return;
    // The binding's ValueSet canonical is used as written: `|version` pins that
    // version (BaseValidator.resolveBindingReference → findTxResource → fetchResource).
    const url = String(b.valueSet);
    const vs = await this.vsHeader(url);
    const label = vs ? `'${vs.title || vs.name || url}' (${url})` : `'${url}'`;
    if (!vs) {
      if (strength === "required") {
        // Terminology_TX_ValueSet_NotFound (warning): the binding is not checked.
        issues.push({
          severity: "warning",
          path: item.path,
          code: "not-found",
          message: `ValueSet ${url} not found; the binding could not be checked`,
          unchecked: { kind: "valueSet", canonical: url },
        });
      }
      return;
    }
    let codings: Array<[string | null, string | null]>;
    if (typeCode === "code" || typeCode === "string" || typeCode === "uri") codings = [[null, String(v)]];
    else if (typeCode === "Quantity") codings = [[typeof v.system === "string" ? v.system : null, String(v.code)]];
    else if (typeCode === "CodeableReference") codings = isObject(v) && isObject(v.concept) ? codingsOf(v.concept) : [];
    else codings = codingsOf(v);
    codings = codings.filter(([, c]) => c !== null && c !== "");
    if (!codings.length) {
      if (typeCode === "CodeableConcept" && strength === "required") {
        issues.push({ severity: "error", path: item.path, code: "code-invalid", message: `No code provided, and a code is required from the value set ${label}` });
      }
      return;
    }
    let anyMember = false;
    let anyUnknown = false;
    // (parity v1) tx $validate-code checks the display too (ValueSetValidator: a wrong display makes the result not ok):
    // a member whose display the terminology rejects does not satisfy the binding
    let wrongDisplay: { system: string; code: string; message: string; index: number } | null = null;
    const list: any[] = typeCode === "Coding" ? [v] : isObject(v) && Array.isArray(v.coding) ? v.coding : [];
    for (const [system, code] of codings) {
      const m = await this.member(url, system, code!);
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
      } else if (m === undefined) anyUnknown = true;
    }
    if (anyMember) return;
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
    if (anyUnknown) {
      issues.push({
        severity: strength === "required" ? "warning" : "information",
        path: item.path,
        code: "code-invalid",
        message: `The code(s) ${shown} could not be confirmed as members of the value set ${label} (not fully expandable locally)`,
      });
      return;
    }
    if (strength === "required" && typeCode === "code") {
      // Port of ValueSetValidator.systemForCodeInValueSet (7.0.1, r5): a bare code is validated by first inferring its
      // system from the ValueSet; when no include's CodeSystem has the code, UNABLE_TO_INFER_CODESYSTEM is reported
      // (an error, besides the not-in-value-set one below).
      const inferred = await this.inferCodeSystems(vs, String(codings[0][1]));
      if (inferred === 0) {
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
    if (strength === "required") {
      issues.push({
        severity: "error",
        path: item.path,
        code: "code-invalid",
        message:
          typeCode === "CodeableConcept"
            ? `None of the codings provided are in the value set ${label}, and a coding from this value set is required (codes = ${shown})`
            : `The value provided ('${shown}') was not found in the value set ${label}, and a code is required from this value set`,
      });
    } else {
      issues.push({
        severity: "warning",
        path: item.path,
        code: "code-invalid",
        message: `None of the codings provided are in the value set ${label}, and a coding should come from this value set unless it has no suitable code (codes = ${shown})`,
      });
    }
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
      const msg = codingVersionIssue(vs, c.system, c.version);
      if (!msg) continue;
      const at = `${path}.version`;
      if (issues.some((i) => i.path === at && i.message === msg)) continue;
      issues.push({ severity: "error", path: at, code: "invalid", message: msg });
    }
  }

  private resolvableCache = new Map<string, Promise<boolean>>();

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
  private async checkUri(v: string, item: Item, typeCode: string, el: Record<string, any>, issues: Issue[]): Promise<void> {
    if (!["uri", "url", "canonical", "oid", "uuid"].includes(typeCode)) return;
    const syn = urnSyntaxIssue(v, typeCode);
    if (syn) issues.push({ severity: "error", path: item.path, code: "invalid", message: syn });
    // canonical: the HL7 validator only hints when a canonical does not resolve.
    if (typeCode !== "uri" && typeCode !== "url") return;
    const basePath = isObject(el.base) && typeof el.base.path === "string" ? el.base.path : String(el.path || "");
    if (uriResolutionExempt(basePath)) return;
    if (!this.resolver.definitionExists || !hl7UrlMustResolve(v)) return;
    const u = v.includes("|") ? v.slice(0, v.lastIndexOf("|")) : v;
    if (await this.defExists(u)) {
      // (v17.5) `url|version`: the HL7 validator resolves that version (Coding.system 'http://…/v2-0360|2.7' → not found)
      if (!v.includes("|") || !this.resolver.definitionVersionExists) return;
      const ver = v.slice(v.lastIndexOf("|") + 1);
      if (!ver || (await this.resolver.definitionVersionExists(u, ver).catch(() => true))) return;
    }
    issues.push({ severity: "error", path: item.path, code: "invalid", message: urlResolveMessage(v) });
  }

  private async checkCoding(v: Record<string, any>, item: Item, issues: Issue[], el: Record<string, any> | null = null): Promise<void> {
    const system = v.system;
    const code = v.code;
    if (typeof system === "string" && system) {
      if (!/^[a-z][a-z0-9+.-]*:/i.test(system)) {
        issues.push({ severity: "error", path: `${item.path}.system`, code: "code-invalid", message: "Coding.system must be an absolute reference, not a local reference" });
        return;
      }
    }
    if (typeof system !== "string" || typeof code !== "string" || !code) return;
    // UCUM: tx.fhir.org parses the expression (Unknown_Code_in_Version on failure).
    if (system === UCUM_SYSTEM) {
      if (checkUcumCode(code) === "invalid") {
        issues.push({ severity: "error", path: `${item.path}.code`, code: "code-invalid", message: ucumUnknownCodeMessage(code) });
      }
      return;
    }
    const display = typeof v.display === "string" ? v.display : null;
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
      issues.push({
        severity: "warning",
        path: `${item.path}.system`,
        code: "not-found",
        message: `A definition for CodeSystem '${system}' could not be found, so the code cannot be validated`,
      });
    } else if (r.status === "invalid-code") {
      issues.push({ severity: r.severity, path: `${item.path}.code`, code: "code-invalid", message: r.message });
    } else if (r.status === "invalid-display") {
      issues.push({ severity: r.severity, path: `${item.path}.display`, code: "code-invalid", message: r.message });
    } else if (r.status === "display-unchecked") {
      issues.push({ severity: r.severity ?? "information", path: `${item.path}.display`, code: "informational", message: r.message });
    }
  }

  /**
   * Port of InstanceValidator.checkQuantity → checkCodedElement (7.0.1): the unit
   * code is validated against its system (UCUM via the terminology server, here
   * ucum-lhc); a ValueSet URL as system is Terminology_TX_System_ValueSet2.
   */
  private async checkQuantity(v: Record<string, any>, item: Item, issues: Issue[]): Promise<void> {
    const system = v.system;
    const code = v.code;
    if (typeof system !== "string" || !system || typeof code !== "string" || !code) return;
    if (system === UCUM_SYSTEM) {
      if (checkUcumCode(code) === "invalid") {
        issues.push({ severity: "error", path: `${item.path}.code`, code: "code-invalid", message: ucumUnknownCodeMessage(code) });
      }
      return;
    }
    if (await this.isValueSetUrl(system)) {
      issues.push({
        severity: "error",
        path: item.path,
        code: "code-invalid",
        message: `The Coding references a value set, not a code system ('${system}')`,
      });
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
    if (typeof ref !== "string" || !ref) return;
    // Port of InstanceValidator.checkReference (7.0.1): a reference containing
    // whitespace is REFERENCE_REF_INVALID_REF (error, rule 2025-05-07) — the JSON
    // parser keeps it, so "Patient/ 123" or "Patient/p1 " is not just unresolved.
    if (!/^\S+$/.test(ref)) {
      issues.push({ severity: "error", path: item.path, code: "invalid", message: `The reference '${ref}' is not a valid reference` });
    }
    const target = this.resolveRef(ref, rctx);
    if (!target) {
      if (ref.startsWith("#")) {
        issues.push({ severity: "error", path: item.path, code: "structure", message: `Unable to resolve resource with reference '${ref}'` });
      } else if (rctx.bundle) {
        // Unresolved references inside a Bundle are not errors by themselves
        // (the target may live on a server); the HL7 validator reports
        // urn: references as warnings and relative references from an entry
        // without fullUrl as errors. Document/message closure is checked in
        // validateBundleRules.
        const absolute = ABSOLUTE_URL.test(ref);
        if (!absolute && rctx.entry && !rctx.entry.fullUrl) {
          issues.push({ severity: "error", path: item.path, code: "structure", message: "Relative Reference appears inside Bundle whose entry is missing a fullUrl" });
        } else if (ref.startsWith("urn:")) {
          issues.push({ severity: "warning", path: item.path, code: "not-found", message: `URN reference is not locally contained within the bundle ${ref}` });
        } else if (!absolute) {
          const near = this.typeIdNearMiss(ref, rctx.bundle);
          if (near) {
            issues.push({
              severity: "warning",
              path: item.path,
              code: "not-found",
              message: `Entry ${near.index} matches the reference ${ref} by type and id but its fullUrl ${near.fullUrl ?? "(none)"} does not match the full target URL`,
            });
          }
        }
      }
      return;
    }
    const targetProfiles: string[] = [];
    for (const t of el.type || []) if (typeCodeOf(t) === "Reference") for (const p of t.targetProfile || []) if (typeof p === "string" && p) targetProfiles.push(p);
    if (!targetProfiles.length) return;
    const rt = target.resourceType;
    const candidates: SdIndex[] = [];
    let anyType = false;
    for (const p of targetProfiles) {
      const psdx = await this.sdx(p);
      if (!psdx) {
        if (splitCanonicalVersion(p).version !== null) {
          // Port of InstanceValidator.checkReference (7.0.1): a target profile that
          // cannot be resolved is Reference_REF_CantResolveProfile (error); a
          // `|version` that is not installed is exactly that case.
          issues.push({
            severity: "error",
            path: item.path,
            code: "not-found",
            message: `Unable to resolve the profile reference '${p}'`,
            unchecked: { kind: "profile", canonical: p },
          });
          continue;
        }
        // Unversioned and unknown (not in the closure): not judged (unchanged), but reported.
        issues.push({
          severity: "information",
          path: item.path,
          code: "not-found",
          message: `Target profile '${p}' could not be found, so the reference target was not checked against it`,
          unchecked: { kind: "profile", canonical: p },
        });
        anyType = true;
        continue;
      }
      if (psdx.type === "Resource" || psdx.type === "DomainResource") anyType = true;
      if (psdx.type === rt) candidates.push(psdx);
    }
    if (!candidates.length) {
      if (anyType) return;
      issues.push({
        severity: "error",
        path: item.path,
        code: "structure",
        message: `The type '${rt}' implied by the reference URL ${ref} is not a valid Target for this element (must be one of [${targetProfiles.map((p) => stripVersion(p).split("/").pop()).join(", ")}])`,
      });
      return;
    }
    if (candidates.some((c) => c.url === CORE + rt) || anyType) return;
    if (target === rctx.resource || target === rctx.root) return;
    const tctx: ResourceCtx = {
      resource: target,
      container: ref.startsWith("#") ? rctx.container || rctx.resource : null,
      root: rctx.root,
      bundle: rctx.bundle,
      entry: this.entryFor(target, rctx, ref.startsWith("#")),
    };
    for (const c of candidates) {
      const res = await this.conformance(tctx, c.url, `${item.path}.resolve()`, depth + 1);
      if (isValid(res.filter((i) => !isParseIssue(i)))) return;
    }
    issues.push({
      severity: "error",
      path: item.path,
      code: "structure",
      message: `Unable to find a profile match for ${ref} among choices: ${candidates.map((c) => c.url).join(", ")}`,
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
    const plist = host.plist;
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
        else if (pu !== null) ok = true; // profile-scoped context: conformance to that profile not checked here
        else ok = await this.contextByBaseType(plist, en);
      } else if (c.type === "extension") {
        shown.push(`x:${expr}`);
        if (host.extUrl !== null && stripVersion(expr) === stripVersion(host.extUrl)) ok = true;
      } else {
        if (c.type === "fhirpath") shown.push(`p:${expr}`);
        ok = true; // fhirpath (or unknown) context: not evaluated locally
      }
    }
    if (!ok) {
      const allowed = shown.join(", ");
      const elementIs = `[${plist.join(", ")}]`;
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
  private async structuralPass(resource: Record<string, any>, path: string, issues: Issue[], depth: number): Promise<void> {
    if (depth > MAX_DEPTH || typeof resource.resourceType !== "string") return;
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
  ): Promise<void> {
    if (depth > MAX_DEPTH) return;
    const groups = sdx.children(el);
    if (!groups || groups.size === 0) return;
    const unknown = (key: string): void => {
      issues.push({ severity: "error", path, code: "structure", message: `Unrecognized property '${key}'` });
    };
    const choiceSeen = new Map<string, string>();
    // (parity v1) children the parser keeps: ele-1 is evaluated on the element model after unknown properties and
    // values of the wrong JSON shape were dropped — an element holding only those (or only an id) has no children
    let kept = 0;
    for (const key of Object.keys(node)) {
      if (key === "fhir_comments" || (isRoot && key === "resourceType")) continue;
      const primExt = key.startsWith("_");
      const name = primExt ? key.slice(1) : key;
      let def: Record<string, any> | null = null;
      let typeCode = "";
      let baseRejects = false;
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
      const childPath = `${path}.${name}`;
      {
        const bm = String((def.base && def.base.max) ?? def.max ?? "*");
        const arr = bm !== "1" && bm !== "0";
        // a primitive is kept only as a JSON primitive (an object / array there is dropped: "must be a simple value")
        const primOk = (x: unknown): boolean => x === null || typeof x !== "object";
        const shapeOk = isPrimitive(typeCode) ? (arr ? Array.isArray(raw) && raw.some(primOk) : primOk(raw)) : arr === Array.isArray(raw);
        if (name !== "id" && (primExt || shapeOk)) kept++;
      }
      if (primExt) {
        const list = Array.isArray(raw) ? raw : [raw];
        for (let i = 0; i < list.length; i++) {
          const pe = list[i];
          if (!isObject(pe)) continue;
          const pp = Array.isArray(raw) ? `${childPath}[${i}]` : childPath;
          for (const k of Object.keys(pe)) {
            if (k !== "id" && k !== "extension" && k !== "fhir_comments") {
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
      const values: Array<[any, string]> = Array.isArray(raw) ? raw.map((v, i) => [v, `${childPath}[${i}]`]) : [[raw, childPath]];
      for (const [v, p] of values) {
        if (!isObject(v)) continue;
        if (typeCode === "Resource" || typeCode === "DomainResource" || (typeof v.resourceType === "string" && !COMPLEX_TYPES.includes(typeCode) && !(await this.isDatatype(typeCode)))) {
          await this.structuralPass(v, p, issues, depth + 1);
        } else if (def.contentReference) {
          const target = sdx.byId.get(String(def.contentReference).replace(/^.*#/, ""));
          if (target) await this.structObject(sdx, target, v, p, issues, depth + 1, false);
        } else if (sdx.hasChildren(def)) {
          await this.structObject(sdx, def, v, p, issues, depth + 1, false);
        } else {
          const tsdx = await this.sdx(CORE + typeCode);
          if (tsdx) await this.structObject(tsdx, tsdx.root, v, p, issues, depth + 1, false);
        }
      }
    }
    if (!isRoot && kept === 0 && Object.keys(node).some((k) => k !== "fhir_comments")) {
      issues.push({ severity: "error", path, code: "invariant", message: "Constraint failed: ele-1: 'All FHIR elements must have a @value or children'" });
    }
  }

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
      resource: rctx.resource,
      rootResource: rctx.container || rctx.resource,
      resolveReference: (ref: string) => this.resolveRefForFhirPath(ref, rctx),
    };
    const base = fhirPathBase(String(el.path || sdx.type), typeCode);
    for (const c of constraints) {
      if (!c.expression || c.key === "ele-1") continue;
      // InstanceValidator.checkInvariant evaluates FHIRPathExpressionFixer.fixExpr(expression, key)
      const fixed = invariantExpression(String(c.expression), c.key);
      const expr = isPrimitive(typeCode) ? primitiveValueAlias(fixed) : fixed;
      const outcome = evaluateConstraint(item.value, base, expr, env);
      if (outcome.status === "pass") continue;
      const bestPractice = (c.extension || []).some((e: any) => e.url === BEST_PRACTICE_EXT && e.valueBoolean === true);
      if (outcome.status === "unevaluable") {
        issues.push({
          severity: "information",
          path: item.path,
          code: "invariant-unevaluated",
          message: `Invariant ${c.key} could not be evaluated locally (${outcome.reason}); not a conformance failure`,
          element: el.id,
          profile: sdx.url,
        });
        continue;
      }
      const severity = bestPractice || c.severity === "warning" ? "warning" : "error";
      issues.push({
        severity,
        path: item.path,
        code: "invariant",
        message: `Constraint failed: ${c.key}: '${c.human || c.expression}'${c.source ? ` (defined in ${stripVersion(c.source)})` : ""}`,
        element: el.id,
        profile: sdx.url,
      });
    }
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
const PARSE_ISSUE = /^Unrecognized property '|^The property \S+ must be (?:a JSON Array|an Array|an Object), not |^This property must be a simple value, not |^Error parsing JSON: |^Array cannot be empty|^Array entries cannot be null/u;
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
