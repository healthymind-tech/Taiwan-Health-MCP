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

import { evaluateConstraint, fhirPathBase, primitiveValueAlias, type FhirPathEnv } from "./fhirPath.js";
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
  for (const i of issues) {
    const u = i && i.unchecked;
    if (!u || typeof u.canonical !== "string") continue;
    (u.kind === "valueSet" ? valueSets : profiles).add(u.canonical);
  }
  return {
    checked_fully: profiles.size === 0 && valueSets.size === 0 && !(Array.isArray(depsMissing) && depsMissing.length),
    profiles_unchecked: [...profiles],
    valuesets_unchecked: [...valueSets],
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

export class InstanceValidator {
  private sdCache = new Map<string, Promise<SdIndex | null>>();
  private conformCache = new WeakMap<object, Map<string, Promise<Issue[]>>>();
  private inProgress = new WeakMap<object, Set<string>>();
  private vsHeaderCache = new Map<string, Promise<Record<string, any> | null>>();
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
    await this.validateResource(rctx, resource.resourceType, extra, issues, 0);
    if (bundle) this.validateBundleRules(bundle, resource.resourceType, issues);
    await this.structuralPass(resource, resource.resourceType, issues, 0);
    return dedupe(issues);
  }

  // ------------------------------------------------------------------ helpers

  /** StructureDefinition index by canonical; a `|version` suffix is honoured by the resolver. */
  private sdx(url: string): Promise<SdIndex | null> {
    const key = String(url || "").trim();
    let p = this.sdCache.get(key);
    if (!p) {
      p = this.resolver.fetchStructureDefinition(key).then((sd) => (sd && sd.snapshot ? new SdIndex(sd) : null));
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
    } else {
      return; // bdl-11 / bdl-12 report the wrong first resource
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
      list.map((i) => (i.path.startsWith(ROOT_TOKEN) ? { ...i, path: path + i.path.slice(ROOT_TOKEN.length) } : i)),
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
      await this.validateResource(child, item.path, profiles, issues, depth);
      return;
    }

    if (!isObject(v)) {
      issues.push({
        severity: "error",
        path: item.path,
        code: "structure",
        message: `The property ${item.key} must be a JSON Object, not ${Array.isArray(v) ? "an Array" : "a primitive property"}`,
      });
      return;
    }
    if (Object.keys(v).length === 0 && !isResourceRoot) {
      issues.push({ severity: "error", path: item.path, code: "invariant", message: "Constraint failed: ele-1: 'All FHIR elements must have a @value or children'" });
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

    await this.walkChildren(childSdx, childEl, item, rctx, issues, depth, isResourceRoot);

    if (!isResourceRoot) this.checkFixedPattern(el, v, item, sdx, issues);
    await this.checkBinding(el, v, typeCode, item, issues, null);
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
  ): Promise<void> {
    const node = item.value as Record<string, any>;
    const groups = sdx.children(el);
    if (!groups || groups.size === 0) return; // nothing known about the children
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

    for (const grp of groups.values()) {
      const def = grp.base || grp.slices[0];
      if (!def) continue;
      const name = grp.name;
      const items: Item[] = [];
      const allowedTypes: string[] = (def.type || []).map(typeCodeOf);
      const typedItems: Array<{ item: Item; type: string }> = [];

      const collect = (key: string, typeCode: string): void => {
        used.add(key);
        used.add("_" + key);
        const lp = childLogicalPaths(item.lp, def, key, typeCode);
        const parentExtUrl = item.typeCode === "Extension" && key.startsWith("value") && typeof node.url === "string" ? node.url : undefined;
        const host = name === "extension" || name === "modifierExtension" ? hostOf(name === "modifierExtension") : undefined;
        const mk = (value: any, ext: any, p: string): Item => ({ value, ext, key, path: p, typeCode, lp, parentExtUrl, host });
        const raw = node[key];
        const rawExt = node["_" + key];
        const baseMax = String((def.base && def.base.max) ?? def.max ?? "*");
        const expectArray = baseMax !== "1" && baseMax !== "0";
        const path = `${item.path}.${key}`;
        if (raw !== undefined && expectArray && !Array.isArray(raw)) {
          issues.push({ severity: "error", path, code: "structure", message: `The property ${key} must be a JSON Array, not ${isObject(raw) ? "an Object" : "a primitive property"} (at ${item.path})` });
          const it = mk(raw, Array.isArray(rawExt) ? rawExt[0] : rawExt, path);
          items.push(it);
          typedItems.push({ item: it, type: typeCode });
          return;
        }
        if (raw !== undefined && !expectArray && Array.isArray(raw)) {
          issues.push({ severity: "error", path, code: "structure", message: `This property must be a simple value, not an Array (${key} at ${path})` });
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
          if (!t) {
            if (KNOWN_TYPE_SUFFIX.has(suffix)) {
              used.add(key);
              used.add("_" + key);
              issues.push({
                severity: "error",
                path: `${item.path}.${key}`,
                code: "structure",
                message: `The type '${KNOWN_TYPE_SUFFIX.get(suffix)}' is not allowed for ${def.path} (allowed: ${allowedTypes.join(", ")})${sdx.url !== CORE + sdx.type ? ` by profile ${sdx.url}` : ""}`,
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
      if (grp.base) this.checkCardinality(grp.base, items.length, item, sdx, issues);

      if (grp.slices.length && grp.base && grp.base.slicing) {
        await this.validateSliced(sdx, grp, typedItems, item, rctx, issues, depth);
      } else {
        for (const { item: it, type } of typedItems) {
          await this.validateItemAgainst(sdx, def, it, type, rctx, issues, depth + 1);
        }
      }
    }

    for (const key of Object.keys(node)) {
      if (used.has(key)) continue;
      issues.push({ severity: "error", path: item.path, code: "structure", message: `Unrecognized property '${key}'` });
    }
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
    const counts = new Map<Record<string, any>, number>();
    const indeterminate = new Set<Record<string, any>>();
    for (const s of grp.slices) counts.set(s, 0);

    for (const { item: it, type } of typedItems) {
      let matched: Record<string, any> | null = null;
      let undecided = false;
      // Port of InstanceValidator.matchSlice (7.0.1): every slice is tested; an
      // element that definitely matches more than one slice is an error
      // (Validation_VAL_Profile_MatchMultiple).
      const hits: Array<Record<string, any>> = [];
      for (const s of grp.slices) {
        const r = await this.sliceMatches(sdx, s, discs, it, type, rctx, depth);
        if (r === undefined) {
          indeterminate.add(s);
          undecided = true;
          continue;
        }
        if (r) hits.push(s);
      }
      if (hits.length) matched = hits[0];
      // HL7 keeps the first matching slice and reports every later match against it
      // (one Validation_VAL_Profile_MatchMultiple per extra slice); a re-slice of the
      // kept slice (`name/sub`) replaces it instead of being an error.
      for (const other of hits.slice(1)) {
        const first = sliceNameOf(matched!);
        const name = sliceNameOf(other);
        if (first && name.startsWith(`${first}/`)) {
          matched = other;
          continue;
        }
        if (first && first.startsWith(`${name}/`)) continue;
        issues.push({
          severity: "error",
          path: it.path,
          code: "structure",
          message: `Profile ${sdx.url}, Element matches more than one slice - ${first}, ${name}`,
          element: base.id,
          profile: sdx.url,
        });
      }
      if (matched) {
        counts.set(matched, (counts.get(matched) || 0) + 1);
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
            code: "structure",
            message: `This element does not match any known slice defined in the profile ${sdx.url} and slicing is CLOSED`,
            element: base.id,
            profile: sdx.url,
          });
        }
        await this.validateItemAgainst(sdx, base, it, type, rctx, issues, depth + 1);
      }
    }
    for (const s of grp.slices) {
      if (indeterminate.has(s)) continue;
      const n = counts.get(s) || 0;
      const min = typeof s.min === "number" ? s.min : 0;
      const max = s.max === undefined ? "*" : String(s.max);
      if (n < min) {
        issues.push({
          severity: "error",
          path: parent.path,
          code: "required",
          message: `Slice '${s.id}': a matching slice is required, but not found (from ${sdx.url})`,
          element: s.id,
          profile: sdx.url,
        });
      }
      if (max !== "*" && /^\d+$/.test(max) && n > Number(max)) {
        issues.push({
          severity: "error",
          path: parent.path,
          code: "cardinality",
          message: `Slice '${s.id}': max allowed = ${max}, but found ${n} (from ${sdx.url})`,
          element: s.id,
          profile: sdx.url,
        });
      }
    }
  }

  private sliceType(slice: Record<string, any>, itemType: string): string {
    const types: string[] = (slice.type || []).map(typeCodeOf);
    if (types.includes(itemType) || !types.length) return itemType;
    return itemType;
  }

  /** true / false, or undefined when the slice cannot be discriminated with local knowledge. */
  private async sliceMatches(
    sdx: SdIndex,
    slice: Record<string, any>,
    discs: Array<Record<string, any>>,
    it: Item,
    itemType: string,
    rctx: ResourceCtx,
    depth: number,
  ): Promise<boolean | undefined> {
    if (!discs.length) return undefined;
    for (const d of discs) {
      const dtype = d.type || "value";
      const dpath = String(d.path || "$this");
      if (dtype === "type") {
        const sliceTypes: string[] = (slice.type || []).map(typeCodeOf);
        let actual: string[];
        if (dpath === "$this") actual = [itemType === "Resource" && isObject(it.value) ? it.value.resourceType : itemType];
        else {
          const vals = this.discriminatorValues(it.value, dpath, rctx);
          actual = vals.map((x) => (isObject(x) && x.resourceType ? x.resourceType : typeof x));
        }
        if (!actual.some((a) => sliceTypes.includes(a))) return false;
        continue;
      }
      if (dtype === "profile") {
        const target = dpath === "$this" ? [it.value] : this.discriminatorValues(it.value, dpath, rctx);
        const el = dpath === "$this" ? slice : this.elementAt(sdx, slice, dpath.replace(/\.?resolve\(\)$/, ""));
        const profs: string[] = [];
        for (const t of (el || slice).type || []) {
          for (const p of t.profile || []) profs.push(String(p));
          for (const p of t.targetProfile || []) profs.push(String(p));
        }
        if (!profs.length) return undefined;
        let ok = false;
        for (const r of target) {
          if (!isObject(r) || !r.resourceType) continue;
          for (const p of profs) {
            const psdx = await this.sdx(p);
            if (!psdx) continue;
            if (psdx.type !== r.resourceType) continue;
            const ctx: ResourceCtx = { resource: r, container: null, root: rctx.root, bundle: rctx.bundle, entry: this.entryFor(r, rctx, false) };
            const res = await this.conformance(ctx, p, this.pathOf(it, dpath), depth + 1);
            if (isValid(res)) {
              ok = true;
              break;
            }
          }
          if (ok) break;
        }
        if (!ok) return false;
        continue;
      }
      if (dtype === "exists") {
        const el = this.elementAt(sdx, slice, dpath);
        if (!el) return undefined;
        const has = this.discriminatorValues(it.value, dpath, rctx).length > 0;
        const want = (el.min ?? 0) >= 1 ? true : String(el.max) === "0" ? false : undefined;
        if (want === undefined) return undefined;
        if (has !== want) return false;
        continue;
      }
      // value / pattern
      const exp = await this.discriminatorExpectation(sdx, slice, dpath);
      if (!exp) return undefined;
      const actual = this.discriminatorValues(it.value, dpath, rctx);
      if (exp.kind === "binding") {
        let hit = false;
        let unknown = false;
        for (const a of actual) {
          if (await this.codelessCodingMember(exp.valueSet, a)) {
            hit = true;
            continue;
          }
          for (const [system, code] of codingsOf(a)) {
            if (!code) continue;
            const m = await this.member(exp.valueSet, system, code);
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
        continue;
      }
      if (exp.kind === "fixed") {
        if (!actual.some((a) => exp.values.some((e) => deepEqual(a, e)))) return false;
      } else if (!actual.some((a) => exp.values.some((e) => patternMatches(a, e)))) {
        return false;
      }
    }
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
    for (const raw of path.split(".")) {
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
              if (k.startsWith(raw) && k.length > raw.length && /[A-Z]/.test(k[raw.length])) {
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
    if (typeof v !== spec.json) {
      issues.push({ severity: "error", path, code: "structure", message: `Error parsing JSON: the primitive value must be a ${spec.json}` });
      return;
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

  private checkFixedPattern(el: Record<string, any>, v: any, item: Item, sdx: SdIndex, issues: Issue[]): void {
    const [fixed, pattern] = fixedPattern(el);
    if (fixed) {
      const ok = isObject(fixed.value) ? patternMatches(v, fixed.value) : deepEqual(v, fixed.value);
      if (!ok) {
        issues.push({
          severity: "error",
          path: item.path,
          code: "value",
          message: `Value is '${short(v)}' but must be '${short(fixed.value)}' (fixed by ${sdx.url})`,
          element: el.id,
          profile: sdx.url,
        });
      }
    }
    if (pattern && !patternMatches(v, pattern.value)) {
      issues.push({
        severity: "error",
        path: item.path,
        code: "value",
        message: `The value does not match the required pattern ${short(pattern.value)} (from ${sdx.url})`,
        element: el.id,
        profile: sdx.url,
      });
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
    const strength = b.strength;
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
    for (const [system, code] of codings) {
      const m = await this.member(url, system, code!);
      if (m === true) anyMember = true;
      else if (m === undefined) anyUnknown = true;
    }
    if (anyMember) return;
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
   * Is `url` exactly the canonical of a ValueSet we hold (Coding.system pointing
   * at a value set)? Only HL7 core / THO value sets count: tx.fhir.org knows
   * those server-side and rejects them as a system in any context, whereas an
   * IG-local value set used as a system only yields "unknown CodeSystem"
   * (confirmed: TW Core ValueSet/medication-path-tw in Observation.method passes).
   */
  private async isValueSetUrl(url: string): Promise<boolean> {
    if (!url.startsWith("http://hl7.org/fhir/ValueSet/") && !url.startsWith("http://terminology.hl7.org/ValueSet/")) return false;
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
    if (await this.defExists(u)) return;
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
      const isVs = await this.isValueSetUrl(system);
      // A Coding element bound directly (e.g. Encounter.class, extensible) goes through
      // checkCoding → checkCodedElement: the binding check answers (warning
      // "not in the value set") and neither Terminology_TX_System_ValueSet2 nor
      // UNKNOWN_CODESYSTEM is reported (validator_cli, probe v7 A-class-vs).
      const b = el && isObject(el.binding) ? el.binding : null;
      if (isVs && b && b.valueSet && ["required", "extensible", "preferred"].includes(b.strength)) return;
      if (isVs) {
        issues.push({
          severity: "error",
          path: `${item.path}.system`,
          code: "code-invalid",
          message: `The Coding references a value set, not a code system ('${system}')`,
        });
        return;
      }
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
      if (isValid(res)) return;
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
      resolveReference: (ref: string) => this.resolveRef(ref, rctx),
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
    for (const key of Object.keys(node)) {
      if (key === "fhir_comments" || (isRoot && key === "resourceType")) continue;
      const primExt = key.startsWith("_");
      const name = primExt ? key.slice(1) : key;
      let def: Record<string, any> | null = null;
      let typeCode = "";
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
        if (stemHit && !def) continue; // type not allowed / second choice value: reported by the profile walk
      }
      if (!def) {
        unknown(key);
        continue;
      }
      const raw = node[key];
      const childPath = `${path}.${name}`;
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
      resolveReference: (ref: string) => this.resolveRef(ref, rctx),
    };
    const base = fhirPathBase(String(el.path || sdx.type), typeCode);
    for (const c of constraints) {
      if (!c.expression || c.key === "ele-1") continue;
      const expr = isPrimitive(typeCode) ? primitiveValueAlias(String(c.expression)) : String(c.expression);
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
    const msgKey = i.code === "invariant" ? i.message.replace(/ \(defined in [^)]*\)$/, "") : i.message.replace(/ \(from [^)]*\)$/, "");
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
