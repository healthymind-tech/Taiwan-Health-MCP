/**
 * DB-backed `ValidatorResolver` for the in-process FHIR validator: resolves
 * StructureDefinitions / ValueSets / CodeSystems from the target IG package's
 * dependency closure in `fhir.artifacts`, and SNOMED / LOINC codes from the
 * local terminology tables.
 *
 * Code checks mirror the HL7 validator's verdicts where local data is
 * authoritative (an IG CodeSystem with `content = complete`, a failed LOINC /
 * SNOMED check digit, an ICD-10-CM table loaded from the complete CMS order
 * file of the edition tx.fhir.org serves) and degrade to warnings where it is
 * not (a code missing from the local SNOMED / LOINC release, or from an older /
 * incomplete ICD-10-CM table, may exist in the server's edition).
 *
 * Coding.display is checked like tx.fhir.org does (case-insensitive, whitespace
 * significant) against: IG / THO CodeSystem displays + designations, LOINC long
 * common name + short name and the LA / LP / LL answer / part / list names,
 * SNOMED CT English descriptions (with inactive content, answered as the
 * edition tx.fhir.org serves), the ICD-10-CM title, WHO ICD-10, and the bundled
 * ISO 3166 / CVX tables. Systems without local data get an information
 * "display not checked", never an error.
 */

import type { PackageRow } from "./fhirIg.js";
import { pickCanonicalVersion, splitCanonicalVersion, type CodeCheck, type ValidatorResolver } from "./fhirValidator.js";
import { conceptInactive, conceptStatus, findConcept, type CodeSystemIndex, type CsConcept, loincCheckDigitValid, snomedCheckDigitValid, valueSetContains } from "./fhirCodeSystem.js";
import * as terminology from "./fhirTerminology.js";
import { BCP13, BCP47, RFC3986, isAbsoluteUrl, judgeLanguageTag, mimeTypeShapeOk, terminologyServerKnows } from "./fhirSpecialSystems.js";
import { ISO3166_DISPLAY, ISO3166_VERSION, iso3166UserAssigned } from "./fhirIso3166.js";
import {
  CVX,
  ICD10_WHO,
  LOINC_TX_VERSION,
  compareDotted,
  icd10WhoStrict,
  judgeCvx,
  judgeIcd10Who,
  judgeLoincOther,
  judgeRxnorm,
  judgeSnomed,
  RXNORM,
  rxnormStrict,
  loincNonTermCheckDigitValid,
  loincUnknownMessage,
  SNOMED_TX_VERSION,
  snomedStrict,
} from "./fhirExternalTerminology.js";
import { probeQueryFailures, query } from "./db.js";
import { TtlMemo } from "./ttlMemo.js";
import { TransientLookupError, currentSnapshot } from "./fhirValidationSnapshot.js";
import { generateSnapshotAsync } from "./fhirSnapshotGenerator.js";
import { fixPackageResource } from "./fhirPackageHacker.js";
import { logWarning } from "./logger.js";
import { txCodeVerdict, type TxCodeVerdict } from "./txCodeTables.js";
import { enumeratedCodes, installedEnumeratedDisplay } from "./codeAcceptance.js";

const SD_TTL_MS = 30 * 60 * 1000;
const SD_CACHE_MAX = 1500;
const sdCache = new terminology.TtlCache<Record<string, any> | null>(Infinity, SD_CACHE_MAX);
const defCache = new terminology.TtlCache<boolean>(Infinity, SD_CACHE_MAX);

/**
 * Systems the HL7 validator knows natively that we cannot check offline (or
 * check elsewhere): say nothing about the code. UCUM is judged by fhirUcum.ts.
 */
const SILENT_SYSTEMS = [
  "urn:ietf:bcp:47",
  "urn:ietf:bcp:13",
  "urn:ietf:rfc:3986",
  "urn:iso:std:iso:3166:-2",
  "urn:iso:std:iso:4217",
  "urn:iso:std:iso:11073:10101",
  "http://hl7.org/fhir/sid/icd-9-cm",
  "http://hl7.org/fhir/sid/ndc",
  "http://www.whocc.no/atc",
];

/**
 * External terminologies that packages ship as `complete` CodeSystems but whose
 * live edition (tx.fhir.org) may be newer: displays are checked, an unknown
 * code is only a warning.
 */

const ICD10CM = "http://hl7.org/fhir/sid/icd-10-cm";
const ISO3166 = "urn:iso:std:iso:3166";

/** ICD-10-CM code shape (category, optional dot + up to 4 characters). */
const ICD10CM_SHAPE = /^[A-TV-Z][0-9A-Z][0-9A-Z](\.[0-9A-Z]{1,4})?$/i;

/**
 * Oldest local ICD-10-CM edition for which an unknown code is an error: the
 * edition tx.fhir.org serves to validator_cli 7.0.1 ('2026-04-01' as of
 * 2026-10). An older complete edition lacks codes added since, so it stays
 * warning-only. "FYyyyy" (October release) counts as (yyyy-1)-10-01.
 */
export const ICD10CM_STRICT_MIN_EDITION = "2026-04-01";

function editionDate(edition: string): string | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(edition)) return edition;
  const fy = /^FY(\d{4})$/.exec(edition);
  return fy ? `${Number(fy[1]) - 1}-10-01` : null;
}

/** Whether unknown ICD-10-CM codes are reported as errors (complete, current local edition). */
export function icd10cmStrict(edition: { edition: string; complete: boolean } | null): boolean {
  if (!edition || !edition.complete) return false;
  const d = editionDate(edition.edition);
  return d !== null && d >= ICD10CM_STRICT_MIN_EDITION;
}

/**
 * HL7 display rule (validator_cli 7.0.1 + tx.fhir.org, confirmed with probes):
 * the display must equal one of the valid displays ignoring case only —
 * whitespace is significant ("Wrong whitespace in Display Name"); the
 * resource language does not relax it. Returns null when the display is fine.
 */
export function judgeDisplay(
  system: string,
  code: string,
  display: string,
  valid: string[],
  severity: "error" | "warning" | "information",
): CodeCheck | null {
  const uniq = [...new Set(valid.filter((v) => typeof v === "string" && v !== ""))];
  if (!uniq.length) return null;
  const want = display.toLowerCase();
  if (uniq.some((d) => d.toLowerCase() === want)) return null;
  const ws = (x: string): string => x.replace(/\s+/g, " ").trim().toLowerCase();
  const wsOnly = uniq.some((d) => ws(d) === ws(display));
  const choices = uniq.length === 1 ? `'${uniq[0]}'` : `one of ${uniq.length} choices: ${uniq.map((d) => `'${d}'`).join(", ")}`;
  const message = `${wsOnly ? "Wrong whitespace in Display Name" : "Wrong Display Name"} '${display}' for ${system}#${code}. Valid display is ${choices}`;
  return { status: "invalid-display", severity, message };
}

/** Utilities.normalize: collapse whitespace runs and trim (whitespace-insensitive compare). */
function hl7Normalize(x: string): string {
  return x.replace(/\s+/g, " ").trim();
}

/**
 * ValueSetValidator.isOkLanguage (7.0.1) with englishOk (the default): a display / designation
 * without a language is always acceptable; otherwise LanguageUtils.langsMatch(requested, language),
 * i.e. a requested language starts with the designation's language ("en-US" accepts "en", "en"
 * does not accept "en-US"), or the requested language is "*".
 */
export function isOkLanguage(langs: readonly string[], language: string | null): boolean {
  if (!langs.length || language === null) return true;
  return langs.some((x) => x === "*" || x.startsWith(language));
}

/**
 * Port of ValueSetValidator.validateCode display section (org.hl7.fhir.core
 * 7.0.1, standalone terminology validator) for CodeSystems held locally.
 * Requested languages = 'en' (the CLI default when the resource has no
 * language): a display is valid when it equals, ignoring case, the concept
 * display (if CodeSystem.language is unset or English) or a designation whose
 * language is unset or English. A match only against a non-English display /
 * designation of the CodeSystem's own language is information
 * (NO_VALID_DISPLAY_FOUND_NONE_FOR_LANG_OK); otherwise Display_Name_for… /
 * Display_Name_WS_for… with severity error (dispWarning(), no warning mode).
 */
export function judgeCodeSystemDisplay(
  system: string,
  code: string,
  display: string,
  concept: { display: string | null; designationList: Array<{ language: string | null; value: string; status?: string }> },
  csLanguage: string | null,
  langs: string[] = ["en"],
): CodeCheck | null {
  const okLang = (l: string | null): boolean => isOkLanguage(langs, l);
  const langList = langs.join(",");
  const want = display.toLowerCase();
  const choices: string[] = [];
  let ws = false;
  let isDefaultLang = false;
  if (concept.display !== null && okLang(csLanguage)) {
    choices.push(`'${concept.display}'${csLanguage ? ` (${csLanguage})` : ""}`);
    if (concept.display.toLowerCase() === want) return null;
    if (hl7Normalize(display) === hl7Normalize(concept.display)) ws = true;
  } else if (concept.display !== null && concept.display.toLowerCase() === want) {
    isDefaultLang = true;
  }
  for (const ds of concept.designationList) {
    if (!okLang(ds.language) && (ds.language === null || ds.language === csLanguage) && ds.value.toLowerCase() === want) isDefaultLang = true;
    if (!okLang(ds.language)) continue;
    choices.push(`'${ds.value}' (${ds.language})`);
    if (ds.value.toLowerCase() === want) {
      if (ds.status) {
        // INACTIVE_DISPLAY_FOUND (standalone ValueSetValidator.java:1347, tag 7.0.1; REVIEW_port_2 G27): the Java loop
        // tests the matched designation, so the "correct" list is the concept display only
        return {
          status: "invalid-display",
          severity: "error",
          message: `'${display}' is no longer considered a correct display for code '${code}' (status = ${ds.status}). The correct display is '${concept.display}'`,
        };
      }
      return null;
    }
    if (hl7Normalize(display).toLowerCase() === hl7Normalize(ds.value).toLowerCase()) ws = true;
  }
  if (choices.length) {
    const list = choices.length === 1 ? choices[0] : `one of ${choices.length} choices: ${choices.slice(0, -1).join(", ")} or ${choices[choices.length - 1]}`;
    return {
      status: "invalid-display",
      severity: "error",
      message: `${ws ? "Wrong whitespace in Display Name" : "Wrong Display Name"} '${display}' for ${system}#${code}. Valid display is ${list} (for the language(s) '${langList}')`,
    };
  }
  if (isDefaultLang) {
    // NO_VALID_DISPLAY_FOUND_NONE_FOR_LANG_OK (Messages.properties 7.0.1:563)
    return {
      status: "invalid-display",
      severity: "information",
      message: `There are no valid display names found for the code ${system}#${code} for language(s) '${langList}'. The display is '${display}' which is a valid display for the default language`,
    };
  }
  // standalone ValueSetValidator.java:1413 (tag 7.0.1): vc.getDisplay() = getPreferredDisplay(cc, cs) — null when the
  // concept has no display, so any display is then NO_VALID_DISPLAY_FOUND_NONE_FOR_LANG_ERR ("Default display is 'null'")
  const preferred = preferredDisplay(concept, csLanguage, langs);
  if (display !== preferred) {
    return {
      status: "invalid-display",
      severity: "error",
      message: `Wrong Display Name '${display}' for ${system}#${code}. There are no valid display names found for language(s) '${langList}'. Default display is '${preferred}'`,
    };
  }
  // ValueSetValidator.java:1417: NO_VALID_DISPLAY_FOUND (warning; the template's {4} is not filled by the caller)
  return { status: "invalid-display", severity: "warning", message: `No valid Display Names found for ${code}#${display} in the language${langs.length === 1 ? "" : "s"} {4}` };
}

/** ValueSetValidator.getPreferredDisplay(ConceptDefinitionComponent, CodeSystem) (standalone, tag 7.0.1:2520-2542). */
function preferredDisplay(concept: { display: string | null; designationList: Array<{ language: string | null; value: string }> }, csLanguage: string | null, langs: string[]): string | null {
  if (!langs.length) return concept.display;
  const match = (l: string | null): boolean => langs.some((x) => x === "*" || (l === null ? x === "en" || x.startsWith("en-") : x.startsWith(l) || l === "*"));
  if (csLanguage !== null && match(csLanguage)) return concept.display;
  const summary = langs.join(",");
  if (csLanguage === null && (summary.includes("en") || summary.includes("en-US"))) return concept.display;
  // designations: without use first (use is not indexed — the first matching one), then any
  for (const d of concept.designationList) if (match(d.language)) return d.value;
  return concept.display;
}

/**
 * Verdict for a code of a CodeSystem held locally (IG / THO package copy), without DB hints:
 * content complete → Unknown code (error), fragment /
 * example → warning, a known concept → its display judged (judgeCodeSystemDisplay). null when
 * the CodeSystem carries no content (not-present / supplement): the caller falls through.
 */
export function judgeHeldCodeSystem(idx: CodeSystemIndex, system: string, code: string, display: string | null, langs: string[] = ["en"]): CodeCheck | null {
  // ValueSetValidator.validateCode(path, Coding): a supplement cannot be a Coding.system (CODESYSTEM_CS_NO_SUPPLEMENT)
  if (idx.content === "supplement" || idx.supplements) {
    const vurl = idx.version ? `${idx.url}|${idx.version}` : idx.url;
    return { status: "invalid-code", severity: "error", at: "system", message: `CodeSystem ${vurl} is a supplement, so can't be used as a value in Coding.system` };
  }
  const c = findConcept(idx, code) ?? findSpecialConcept(system, code);
  const ver = idx.version ? ` version '${idx.version}'` : "";
  if (!c) {
    if (idx.content === "complete") {
      // REVIEW_port_2 G11: the validator judges a held complete CodeSystem (DICOM included) locally — an error
      return { status: "invalid-code", severity: "error", message: `Unknown code '${code}' in the CodeSystem '${system}'${ver}` };
    }
    // ValueSetValidator l. 1266-1270 UNKNOWN_CODE_IN_FRAGMENT
    if (idx.content === "fragment") {
      return { status: "invalid-code", severity: "warning", message: `Unknown Code '${code}' in the CodeSystem '${system}' version '${idx.version ?? "null"}' - note that the code system is labeled as a fragment, so the code may be valid in some other fragment` };
    }
    // ValueSetValidator l. 864-888: not judged on example content, the exception's warningMessage
    if (idx.content === "example") {
      return { status: "invalid-code", severity: "warning", undecided: true, message: `Resolved system ${system}${idx.version ? ` (v${idx.version})` : ""}, but the definition only has example content, so the code has not been validated` };
    }
    return null;
  }
  // ValueSetValidator.validateCode (7.0.1): an inactive concept → INACTIVE_CONCEPT_FOUND(_ADD),
  // a deprecated one → DEPRECATED_CONCEPT_FOUND (warnings; the code stays valid).
  const extra: Array<{ severity: "warning"; message: string }> = [];
  const status = conceptStatus(c);
  if (conceptInactive(c)) {
    extra.push({
      severity: "warning",
      message: status === "retired" ? `The concept '${c.code}' has a status of retired and inactive and its use should be reviewed` : `The concept '${c.code}' has a status of inactive and its use should be reviewed`,
    });
  } else if (status !== null && status.toLowerCase() === "deprecated") {
    extra.push({ severity: "warning", message: `The concept '${c.code}' is deprecated and its use should be reviewed` });
  }
  let out: CodeCheck = { status: "ok" };
  if (display !== null) {
    const bad = judgeCodeSystemDisplay(system, code, display, c, idx.language, langs);
    if (bad) out = bad;
  }
  const notes: Array<{ severity: "warning" | "information"; message: string }> = [...extra];
  if (c.code !== code) {
    // ValueSetValidator.java validateCode: CODE_CASE_DIFFERENCE (information) for a case-insensitive match
    const vurl = idx.version ? `${idx.url}|${idx.version}` : idx.url;
    notes.push({ severity: "information", message: `The code '${code}' differs from the correct code '${c.code}' by case. Although the code system '${vurl}' is case insensitive, implementers are strongly encouraged to use the correct case anyway` });
  }
  if (notes.length) out.extra = [...notes, ...(out.extra ?? [])];
  return out;
}

/**
 * A Coding.version that no installed package holds (ValueSetValidator.getUnknownCodeSystemMessage, tag 7.0.1:543):
 * the code is not checked. validator_cli relays the terminology server's answer as a warning — for an IG code system
 * the server knows no version of (UNKNOWN_CODESYSTEM_VERSION_NONE); HL7 / THO systems, whose other versions the server
 * holds, stay undecided.
 */
export function unknownCodeSystemVersion(system: string, version: string, display: string | null, held: CodeSystemIndex | null = null, code: string | null = null): CodeCheck {
  const base = { ...noLocalDisplay(system, display), undecided: true as const };
  if (/^https?:\/\/(terminology\.)?hl7\.org\//.test(system)) {
    // the server holds that (older) version of an HL7 / THO code system: a code the held copy does not define either is
    // reported as unknown in that version (codes are deprecated, not removed); a known code stays undecided there
    if (held && code !== null && held.content === "complete" && !findConcept(held, code) && !findSpecialConcept(system, code)) {
      return { status: "invalid-code", severity: "error", message: `Unknown code '${code}' in the CodeSystem '${system}' version '${version}'` };
    }
    return base;
  }
  return {
    ...base,
    extra: [{ severity: "warning", message: `A definition for CodeSystem '${system}' version '${version}' could not be found, so the code cannot be validated. No versions of this code system are known` }],
  };
}

/**
 * standalone ValueSetValidator.SERVER_SIDE_LIST (tag 7.0.1:1131) — systems validated on the terminology server even
 * without a local CodeSystem — plus CPT (tx.fhir.org reports unknown CPT codes as errors; licensed, never held here).
 */
export const SERVER_SIDE_SYSTEMS = new Set([
  "http://fdasis.nlm.nih.gov",
  "http://hl7.org/fhir/sid/ndc",
  "http://loinc.org",
  "http://snomed.info/sct",
  "http://unitsofmeasure.org",
  "http://unstats.un.org/unsd/methods/m49/m49.htm",
  "http://varnomen.hgvs.org",
  "http://www.nlm.nih.gov/research/umls/rxnorm",
  "https://www.usps.com/",
  "urn:ietf:bcp:13",
  "urn:ietf:bcp:47",
  "urn:ietf:rfc:3986",
  "urn:iso:std:iso:3166",
  "urn:iso:std:iso:4217",
  "urn:oid:1.2.36.1.2001.1005.17",
  "http://www.ama-assn.org/go/cpt",
]);

export function serverSideSystem(system: string): boolean {
  return SERVER_SIDE_SYSTEMS.has(system);
}

/**
 * Code checks for the systems fhirSpecialSystems.ts decides locally (BCP-47 language tags, BCP-13 MIME types):
 * an invalid code is Unknown_Code_in (error) with the reason as information; a valid one is ok (a display is not
 * checked — the server's display rules for these systems are not reproduced). null = not decidable here.
 */
export function judgeSpecialSystem(system: string, code: string, display: string | null): CodeCheck | null {
  let reason: string | null = null;
  if (system === BCP47) {
    const r = judgeLanguageTag(code);
    if (r === null) return null;
    if (!r.valid) reason = r.reason;
  } else if (system === BCP13) {
    if (["xml", "json", "ttl"].includes(code)) return null; // R4 mimetypes value set quirk: decided by the binding
    if (!mimeTypeShapeOk(code)) reason = `The code '${code}' is not a valid MIME type (type/subtype)`;
  } else if (system === RFC3986) {
    // URICodeSystem: the display is the Coding's own display → never a display issue
    return isAbsoluteUrl(code) ? { status: "silent" } : { status: "invalid-code", severity: "error", message: `Unknown code '${code}' in the CodeSystem '${system}'` };
  } else return null;
  if (reason !== null) {
    return { status: "invalid-code", severity: "error", message: `Unknown code '${code}' in the CodeSystem '${system}'`, extra: [{ severity: "information", message: reason }] };
  }
  // a display is judged by the terminology server's rules for these systems (not reproduced): undecided
  return display === null ? noLocalDisplay(system, display) : { ...noLocalDisplay(system, display), undecided: true };
}

/**
 * ValueSetValidator.findSpecialConcept (7.0.1): v2-0203 national identifier types NN<country> (ISO 3166 code,
 * alpha-2 or alpha-3) are valid codes with the display "National Identifier for <country>".
 */
export function findSpecialConcept(system: string, code: string): CsConcept | null {
  if (system !== "http://terminology.hl7.org/CodeSystem/v2-0203" || !code.startsWith("NN") || code.length <= 3) return null;
  const country = ISO3166_DISPLAY[code.slice(2)];
  if (!country) return null;
  const display = `National Identifier for ${country}`;
  return { code, display, designations: [display], designationList: [], parents: new Set(), children: new Set(), properties: new Map() };
}

function noLocalDisplay(system: string, display: string | null): CodeCheck {
  return display === null
    ? { status: "silent" }
    : { status: "display-unchecked", message: `Display not checked: no local terminology for ${system}` };
}

/**
 * Code systems tx.fhir.org serves (or the HL7 validator knows natively) even
 * though no package in the closure defines them as a CodeSystem resource.
 */
function txKnownSystem(system: string): boolean {
  if (SILENT_SYSTEMS.includes(system)) return true;
  if ([ISO3166, ICD10CM, CVX, ICD10_WHO, RXNORM, "http://snomed.info/sct", "http://loinc.org", "http://unitsofmeasure.org"].includes(system)) return true;
  if (system.startsWith("urn:")) return true;
  return /^https?:\/\/(terminology\.)?hl7\.org\//.test(system) || system.startsWith("http://snomed.info/") || system.startsWith("http://dicom.nema.org/");
}

/** LOINC strict mode: the local release is at least the version tx.fhir.org serves. */
export function loincStrict(edition: { version: string } | null): boolean {
  return !!edition && compareDotted(edition.version, LOINC_TX_VERSION) >= 0;
}

/**
 * Partial-content hint for an IG CodeSystem that declares `content: complete`
 * but says (in its description) that only part of the codes are published, or
 * whose declared `count` exceeds the concepts it carries. TW Core 1.0.0 ships
 * 14 such CodeSystems ("…此處僅擷取部分代碼，完整代碼可至全國專門術語服務平臺…").
 * The HL7 validator trusts `content` and reports Unknown code (error); we keep
 * that verdict and only add this hint. Returns null when nothing indicates a
 * partial list.
 */
export function partialCodeSystemHint(cs: Record<string, any> | null): string | null {
  if (!cs || cs.content !== "complete") return null;
  const desc = typeof cs.description === "string" ? cs.description : "";
  let held = 0;
  const walk = (list: any): void => {
    if (!Array.isArray(list)) return;
    for (const c of list) {
      held++;
      walk(c && c.concept);
    }
  };
  walk(cs.concept);
  const declared = typeof cs.count === "number" ? cs.count : null;
  const partialText = /僅擷取部分|僅列出部分|部分代碼|partial list|subset of (the )?codes|only (a )?(part|subset|sample) of/i.test(desc);
  if (!partialText && !(declared !== null && declared > held)) return null;
  const where = /\[([^\]]*術語服務平臺[^\]]*)\]\((https?:[^)]+)\)/.exec(desc);
  const more = where ? ` The full code list is published at ${where[2]}.` : "";
  const why = partialText
    ? "its description states that only part of the codes are included"
    : `it declares count ${declared} but carries ${held} concepts`;
  return (
    `CodeSystem '${cs.url}'${cs.version ? ` version '${cs.version}'` : ""} declares content 'complete', but ${why}; ` +
    `a valid code may be missing from this package copy (the HL7 validator also reports it as unknown).${more}`
  );
}

interface VersionedRow {
  raw_json: any;
  ord: number;
  package_id: string;
  package_version: string;
  fhir_version: string | null;
}

/**
 * `url|version` lookups, process-wide (keyed by closure): the resource of exactly that
 * version in a package closure is immutable, and the same versioned bindings
 * (identifier-type|4.0.1 …) recur on every validation.
 */
const versionedMemo = new TtlMemo<Record<string, any> | null>(SD_TTL_MS, SD_CACHE_MAX);

/**
 * Code checks and ValueSet membership, process-wide (keyed by closure): a verdict is a
 * pure function of the installed packages and terminology editions, which change only
 * through an import job (the same staleness bound as the edition / held caches). A
 * verdict reached while a lookup failed (fail-open degradation) is never memoised.
 */
const VERDICT_TTL_MS = 10 * 60 * 1000;
const VERDICT_CACHE_MAX = 20000;
const codeCheckMemo = new TtlMemo<CodeCheck>(VERDICT_TTL_MS, VERDICT_CACHE_MAX);
const membershipMemo = new TtlMemo<boolean | undefined>(VERDICT_TTL_MS, VERDICT_CACHE_MAX);

async function memoised<V>(memo: TtlMemo<V>, key: string, compute: () => Promise<V>): Promise<V> {
  const hit = memo.peek(key);
  if (hit) return hit;
  const { result, failed } = await probeQueryFailures(compute);
  if (failed === 0) memo.set(key, result);
  else throwInSnapshot(failed);
  return result;
}

/**
 * Inside a validation snapshot a lookup that failed has no answer: its fail-open result ("not found", "no such code")
 * must not become a finding, so the failure reaches InstanceValidator, which reports the check as unverified. Outside
 * one (the suggestion / repair / tool callers) the resolver keeps degrading gracefully.
 */
function throwInSnapshot(failed: number): void {
  if (failed > 0 && currentSnapshot()) throw new TransientLookupError(`${failed} database lookup${failed === 1 ? "" : "s"} failed`);
}

/** Runs a fail-open lookup; see throwInSnapshot. */
async function guarded<V>(compute: () => Promise<V>): Promise<V> {
  if (!currentSnapshot()) return compute();
  const { result, failed } = await probeQueryFailures(compute);
  throwInSnapshot(failed);
  return result;
}

export class DbValidatorResolver implements ValidatorResolver {
  private readonly closure: string;

  constructor(private readonly pkg: PackageRow) {
    this.closure = terminology.closureKey(pkg);
  }

  /**
   * `url|version` → the closure's definition of exactly that version, ported from
   * CanonicalResourceManager.getByPackage (validator_cli 7.0.1; see
   * fhirValidator.pickCanonicalVersion). The candidates are every closure package
   * holding the canonical, in fhirTerminology.rankCandidates order; the version
   * compared is the resource's own `version`. null = not installed at that
   * version (the HL7 validator then reports the reference as not found).
   */
  private loadVersioned(resourceType: string, canonical: string, version: string): Promise<Record<string, any> | null> {
    const key = `${this.closure}|${resourceType}|${canonical}|${version}`;
    return versionedMemo.get(key, async () => {
      const [pids, pvers] = terminology.closureArrays(this.pkg);
      const rows = (
        await query<VersionedRow>(
          "SELECT a.raw_json, dep.ord, a.package_id, a.package_version, p.fhir_version FROM fhir.artifacts a " +
            "JOIN unnest($1::text[], $2::text[]) WITH ORDINALITY AS dep(pid, pver, ord) " +
            "  ON a.package_id = dep.pid AND a.package_version = dep.pver " +
            "JOIN fhir.ig_packages p ON p.package_id = a.package_id AND p.version = a.package_version " +
            "WHERE a.resource_type = $3 AND a.canonical_url = $4",
          [pids, pvers, resourceType, canonical],
        )
      ).rows;
      const ranked = terminology.rankCandidates(
        canonical,
        rows.map((r) => ({ ...r, packageId: r.package_id, packageVersion: r.package_version, fhirVersion: r.fhir_version, ord: Number(r.ord) })),
      );
      const cands = ranked
        .map((r) => {
          const json = typeof r.raw_json === "string" ? safeJson(r.raw_json) : r.raw_json;
          // PackageHackerRN.fixRegisteredResource runs when a package resource is registered (BaseWorkerContext:424)
          if (json && typeof json === "object") fixPackageResource(json, r.package_id);
          return json && typeof json === "object" ? { json, version: typeof json.version === "string" ? json.version : null } : null;
        })
        .filter((c): c is { json: Record<string, any>; version: string | null } => c !== null);
      return pickCanonicalVersion(cands, version)?.json ?? null;
    });
  }

  fetchStructureDefinition(url: string): Promise<Record<string, any> | null> {
    return this.loadStructureDefinition(url, []);
  }

  /**
   * `chain`: the definitions whose snapshot this call is generating. A base cycle stops there and is per call chain:
   * a process-wide "in flight" mark made a concurrent validation of the same differential see it without a snapshot.
   */
  private async loadStructureDefinition(url: string, chain: readonly string[]): Promise<Record<string, any> | null> {
    const { url: canonical, version } = splitCanonicalVersion(url);
    const key = this.closure + "|" + canonical + (version !== null ? "|" + version : "");
    const hit = sdCache.get(key);
    if (hit !== undefined) return hit;
    let sd =
      version !== null
        ? await this.loadVersioned("StructureDefinition", canonical, version)
        : // Unversioned: the closure's "current" copy as HL7 picks it (highest
          // major.minor, e.g. the hl7.fhir.uv.extensions.r4 copy of a core extension).
          await terminology.loadArtifactByCanonical("StructureDefinition", canonical, this.pkg, { hl7Current: true, packageFix: fixPackageResource });
    // A differential-only definition gets its snapshot generated, as the HL7 context does when it loads one
    // (ContextUtilities.generateSnapshot → ProfileUtilities); a cycle or a failure leaves it as stored.
    if (sd && !(Array.isArray(sd.snapshot?.element) && sd.snapshot.element.length)) {
      if (chain.includes(key)) return sd; // a cycle: as stored, and not remembered (the outer call stores the result)
      const generating = sd;
      let lookupFailed = false;
      const { result, failed } = await probeQueryFailures(async () => {
        try {
          const fetchBase = (u: string): Promise<Record<string, any> | null> =>
            this.loadStructureDefinition(u, [...chain, key]).catch((e) => {
              lookupFailed = true; // also a failure of another request's in-flight lookup, which no probe here counts
              throw e;
            });
          return (await generateSnapshotAsync(generating, fetchBase)) ?? generating;
        } catch (e) {
          logWarning("snapshot generation failed", { url: canonical, error: (e as Error).message });
          return generating;
        }
      });
      // A generation that hit a transient failure says nothing about the definition: not remembered as snapshot-less.
      if (failed > 0 || lookupFailed) {
        throwInSnapshot(Math.max(failed, 1));
        return result;
      }
      sd = result;
    }
    sdCache.set(key, sd);
    return sd;
  }

  fetchValueSet(url: string): Promise<Record<string, any> | null> {
    const { url: canonical, version } = splitCanonicalVersion(url);
    return guarded(() => (version === null ? terminology.loadValueSet(url, this.pkg) : this.loadVersioned("ValueSet", canonical, version)));
  }

  valueSetContains(url: string, system: string | null, code: string): Promise<boolean | undefined> {
    return memoised(membershipMemo, `${this.closure}\0${url}\0${system}\0${code}`, () => this.valueSetContainsUncached(url, system, code));
  }

  private async valueSetContainsUncached(url: string, system: string | null, code: string): Promise<boolean | undefined> {
    const { url: canonical, version } = splitCanonicalVersion(url);
    // Exact canonicals only (HL7 resolves include.system by canonical, no id fallback).
    if (version === null) return terminology.valueSetMembership(url, system, code, this.pkg, true);
    // Versioned binding: membership is decided on that version of the ValueSet;
    // nested include.valueSet references resolve as before.
    const pinned = await this.loadVersioned("ValueSet", canonical, version);
    if (!pinned) return undefined;
    const deps = terminology.dbTerminologyDeps(this.pkg, true);
    return valueSetContains(canonical, system, code, {
      ...deps,
      loadValueSet: (u: string) => (u.split("|")[0] === canonical ? Promise.resolve(pinned) : deps.loadValueSet(u)),
    });
  }

  async codeSystemResolvable(system: string): Promise<boolean> {
    if (txKnownSystem(system)) return true;
    return guarded(async () => {
      try {
        return await terminology.codeSystemInClosure(system, this.pkg);
      } catch {
        return true; // never invent a verdict on DB trouble
      }
    });
  }

  /** Versions of the CodeSystem in the closure (G3 determineVersion); [] on DB trouble (no version issue invented). */
  async codeSystemVersions(system: string): Promise<string[]> {
    return guarded(async () => {
      try {
        return await terminology.codeSystemVersionsInClosure(system, this.pkg);
      } catch {
        return [];
      }
    });
  }

  /** The CodeSystem resource of a canonical (closure; `|version` honoured); null on DB trouble. */
  async fetchCodeSystem(url: string): Promise<Record<string, any> | null> {
    try {
      const { url: canonical, version } = splitCanonicalVersion(url);
      return version === null ? await terminology.loadArtifactByCanonical("CodeSystem", canonical, this.pkg) : await this.loadVersioned("CodeSystem", canonical, version);
    } catch {
      return null;
    }
  }

  async fetchSearchParameter(url: string): Promise<Record<string, any> | null> {
    return terminology.loadArtifactByCanonical("SearchParameter", splitCanonicalVersion(url).url, this.pkg, { hl7Current: true });
  }

  async fetchCanonical(resourceType: "Measure" | "Library", url: string): Promise<Record<string, any> | null> {
    const { url: canonical, version } = splitCanonicalVersion(url);
    return version === null ? terminology.loadArtifactByCanonical(resourceType, canonical, this.pkg, { hl7Current: true }) : this.loadVersioned(resourceType, canonical, version);
  }

  async fetchQuestionnaire(url: string): Promise<Record<string, any> | null> {
    const { url: canonical, version } = splitCanonicalVersion(url);
    return version === null ? terminology.loadArtifactByCanonical("Questionnaire", canonical, this.pkg, { hl7Current: true }) : this.loadVersioned("Questionnaire", canonical, version);
  }

  /** A CodeSystem with this canonical in the closure (binding → CodeSystem URL); false on DB trouble (no invented error). */
  async codeSystemExists(url: string): Promise<boolean> {
    return guarded(async () => {
      try {
        return await terminology.codeSystemInClosure(url.split("|")[0], this.pkg);
      } catch {
        return false;
      }
    });
  }

  async codeSystemLocal(system: string): Promise<boolean> {
    if (txKnownSystem(system)) return false; // validated server-side by the HL7 validator
    return guarded(async () => {
      try {
        const cs = await terminology.loadArtifactByCanonical("CodeSystem", system, this.pkg);
        return !!cs && (cs.content === "complete" || cs.content === "fragment");
      } catch {
        return false; // DB trouble: keep the "no match" verdict
      }
    });
  }

  /** Does any loaded package (any version) define a conformance resource with this canonical URL? */
  /** (v17.5) A definition of `url` with exactly `version` installed (any package); fail-open on DB trouble. */
  async definitionVersionExists(url: string, version: string): Promise<boolean> {
    return guarded(async () => {
      try {
        return (await query("SELECT 1 FROM fhir.artifacts WHERE canonical_url = $1 AND raw_json->>'version' = $2 LIMIT 1", [url, version])).rows.length > 0;
      } catch {
        return true;
      }
    });
  }

  async definitionExists(url: string): Promise<boolean> {
    const canonical = url.split("|")[0];
    const hit = defCache.get(canonical);
    if (hit !== undefined) return hit;
    return guarded(async () => {
      let ok = true; // fail-open on DB trouble: never invent a resolution error
      try {
        ok = (await query("SELECT 1 FROM fhir.artifacts WHERE canonical_url = $1 LIMIT 1", [canonical])).rows.length > 0;
      } catch {
        // Not cached: a transient DB error must not suppress the check for the next
        // 30 minutes (the "reported in some rounds only" nondeterminism).
        return true;
      }
      defCache.set(canonical, ok);
      return ok;
    });
  }

  checkCode(system: string, code: string, display: string | null, version: string | null = null, langs?: string[]): Promise<CodeCheck> {
    const lk = langs && langs.length ? langs.join(",") : "";
    return memoised(codeCheckMemo, `${this.closure}\0${system}\0${code}\0${display}\0${version}\0${lk}`, async () => {
      const r = await this.checkCodeUncached(system, code, display, version, langs);
      return version && (await this.versionUnknownHere(system, version)) && (r.status === "ok" || r.status === "silent" || r.status === "display-unchecked") ? { ...r, undecided: true } : r;
    });
  }

  /**
   * REVIEW_port_2 G1 / G3: a Coding.version of a terminology answered from local tables (LOINC, SNOMED CT, ISO 3166,
   * RFC 3986, BCP-47 / 13) that is not the edition held here: validator_cli resolves that version at the terminology
   * server (UNKNOWN_CODESYSTEM_VERSION when it has none) — the local verdict does not settle it.
   */
  private async versionUnknownHere(system: string, version: string): Promise<boolean> {
    if (system === "http://loinc.org") return version !== ((await terminology.loincEdition())?.version ?? null);
    if (system === "http://snomed.info/sct") return !/^http:\/\/snomed\.info\/sct\/\d+(\/version\/\d{8})?$/.test(version);
    if (system === ISO3166) return version !== ISO3166_VERSION;
    return system === "urn:ietf:rfc:3986" || system === "urn:ietf:bcp:47" || system === "urn:ietf:bcp:13";
  }

  private async checkCodeUncached(system: string, code: string, display: string | null, version: string | null = null, langs?: string[]): Promise<CodeCheck> {
    if (system === ISO3166) return this.checkIso3166(code, display);
    // CVX: bundled tx.fhir.org table (fhirCvx.ts).
    if (system === CVX) return judgeCvx(code, display, langs);
    if (system === ICD10_WHO) return this.checkIcd10Who(code, display);
    if (system === RXNORM) return this.checkRxnorm(code, display);
    if (SILENT_SYSTEMS.includes(system)) {
      const special = judgeSpecialSystem(system, code, display);
      if (special) return special;
      // A terminology not held locally (WHO ATC): the bundled verdicts of the validator's
      // reference server (txCodeTables.ts, ISSUES_v15.2) for the codes the installed data carries.
      const tx = txCodeVerdict(system, code);
      if (tx) return this.checkTxTable(system, code, display, tx);
      return { ...noLocalDisplay(system, display), undecided: true };
    }
    let idx = await terminology.loadCodeSystemIndex(system, this.pkg, true);
    // REVIEW_port_2 G10: a urn:oid / urn:uuid CodeSystem in the closure is judged like any other (ValueSetValidator.java:654)
    if ((system.startsWith("urn:oid:") || system.startsWith("urn:uuid:")) && !(idx && idx.url && idx.url.split("|")[0] === system)) {
      // An OID no package holds is unknown to the terminology server as well: a definite UNKNOWN_CODESYSTEM, nothing left
      // undecided (official corpus: every urn:oid system without a package, ips / twcore)
      return terminologyServerKnows(system) ? noLocalDisplay(system, display) : { status: "unknown-system" };
    }
    // The terminology loader falls back to a CodeSystem with the same id (for
    // bare ids from tool callers); a Coding.system must match the canonical
    // exactly — e.g. a ValueSet URL is not its CodeSystem (HL7:
    // "The Coding references a value set, not a code system").
    // (No exception for TW Core 0.3.2's icd-10-*-2023-tw, published under its
    // ValueSet URL: validator_cli 7.0.1 does not resolve it either and only warns
    // "A definition for CodeSystem ... could not be found".)
    if (idx && idx.url && idx.url.split("|")[0] !== system) idx = null;
    if (idx && !version && idx.url.startsWith("http://terminology.hl7.org/CodeSystem/")) idx = (await terminology.loadThoCurrentIndex(system)) ?? idx;
    if (idx && version && idx.version !== version) {
      // REVIEW_port_2 G3: Coding.version names the CodeSystem version to check against (resolveCodeSystem(system, version))
      const vidx = await terminology.loadCodeSystemIndex(`${system}|${version}`, this.pkg, true);
      if (vidx) idx = vidx;
      else return unknownCodeSystemVersion(system, version, display, idx, code);
    }
    if (idx) {
      const base = judgeHeldCodeSystem(idx, system, code, display, langs && langs.length ? langs : undefined);
      if (base && base.status === "invalid-code" && idx.content === "complete") {
        // Verdict as HL7 (content = complete → Unknown code); add a hint when the
        // CodeSystem itself says it is a partial list, and when another installed
        // package holds a fuller copy of the same CodeSystem that has the code.
        const hints: Array<{ severity: "information"; message: string }> = [];
        const hint = await this.partialHint(system);
        if (hint) hints.push({ severity: "information", message: hint });
        const fuller = await this.fullerCopyHint(system, code, idx.concepts.size);
        if (fuller) hints.push({ severity: "information", message: fuller });
        if (hints.length) base.extra = hints;
      }
      if (base) return base;
      // content = not-present: fall through to external tables / silent.
    }
    const kind = terminology.routeSystem(system);
    // LOINC answer / part / answer-list / group codes (loinc.other_codes).
    if (kind === "loinc" && /^L[APGL]\d+-\d$/.test(code)) {
      const strict = loincStrict(await terminology.loincEdition());
      if (code.startsWith("LG") || !loincNonTermCheckDigitValid(code) || (await terminology.loincOtherCodesHeld())) {
        return judgeLoincOther(code, display, await terminology.loincOtherCode(code), strict);
      }
      return { ...noLocalDisplay(system, display), undecided: true };
    }
    if (kind === "snomed") {
      if (!snomedCheckDigitValid(code)) {
        return { status: "invalid-code", severity: "error", message: `Unknown code '${code}' in the CodeSystem '${system}' version '${SNOMED_TX_VERSION}' (International Edition)` };
      }
      if (!(await terminology.externalSystemHeld(system))) return { ...noLocalDisplay(system, display), undecided: true };
      const strict = snomedStrict(await terminology.snomedEdition(), version);
      // A Coding.version naming another edition (US, NL, …) only relaxes the
      // unknown-code verdict (snomedStrict); displays of International concepts
      // are still judged (validator_cli: US-edition coding, wrong display → error).
      return judgeSnomed(code, display, await terminology.snomedConcept(code), await terminology.snomedConceptDescriptions(code), strict);
    }
    if (kind === "loinc") {
      if (!loincCheckDigitValid(code)) {
        return { status: "invalid-code", severity: "error", message: loincUnknownMessage(code) };
      }
      if (!(await terminology.externalSystemHeld(system))) return { ...noLocalDisplay(system, display), undecided: true };
      const held = await terminology.externalDisplays(system, code);
      if (!held) {
        // tx.fhir.org: Unknown_Code_in_Version. Only an error when the local
        // release is at least the version the server uses (newer codes exist there).
        return loincStrict(await terminology.loincEdition())
          ? { status: "invalid-code", severity: "error", message: loincUnknownMessage(code) }
          : { status: "invalid-code", severity: "information", undecided: true, message: `Code '${code}' was not found in the locally held LOINC release of '${system}'` };
      }
      if (display !== null) {
        const bad = judgeDisplay(system, code, display, held.displays, "error");
        // tx.fhir.org names LOINC displays as designations: the display, the long common name again, then the others,
        // each '(en-US)', for the request's language (validator_cli corpus: "one of 3 choices: 'A' (en-US), 'A' (en-US)
        // or 'B' (en-US) (for the language(s) 'en')")
        if (bad && bad.status === "invalid-display" && held.displays.length) {
          const names = [held.displays[0], ...new Set(held.displays)].map((d) => `'${d}' (en-US)`);
          const list = `one of ${names.length} choices: ${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
          return { ...bad, message: `${bad.message.split(". Valid display is ")[0]}. Valid display is ${list} (for the language(s) '${(langs && langs.length ? langs : ["en"]).join(",")}')` };
        }
        if (bad) return bad;
      }
      return { status: "ok" };
    }
    if (system === ICD10CM) {
      if (!(await terminology.icd10cmHeld())) return { ...noLocalDisplay(system, display), undecided: true };
      const held = await terminology.externalDisplays(system, code);
      if (!held) {
        const edition = await terminology.icd10cmEdition();
        if (icd10cmStrict(edition)) {
          // tx.fhir.org (via validator_cli 7.0.1 checkCodeOnServer →
          // TerminologyServiceErrorClass / UNKNOWN_CODE_IN_VERSION):
          // "Unknown code '<c>' in the CodeSystem '<url>' version '<v>'", error.
          return {
            status: "invalid-code",
            severity: "error",
            message: `Unknown code '${code}' in the CodeSystem '${system}' version '${edition!.edition}'`,
          };
        }
        // Local table is not the complete current CMS code set (older edition,
        // or tabular XML without the order file): an unknown code may exist at
        // tx.fhir.org — an incompleteness note, never a false reject.
        const ed = edition ? ` (${edition.edition}, ${edition.complete ? "complete" : "incomplete"})` : "";
        return {
          status: "invalid-code",
          severity: "information",
          undecided: true,
          message: ICD10CM_SHAPE.test(code)
            ? `Code '${code}' was not found in the locally held ICD-10-CM edition${ed}; it may exist in the edition used by the terminology server`
            : `Code '${code}' does not look like an ICD-10-CM code`,
        };
      }
      if (display !== null) {
        // tx.fhir.org accepts the long title or the CMS short title but names
        // only the long title in the message.
        const ok = held.displays.some((d) => d.toLowerCase() === display.toLowerCase());
        const bad = ok ? null : judgeDisplay(system, code, display, held.displays.slice(0, 1), "error");
        if (bad) return bad;
      }
      return { status: "ok" };
    }
    if (idx) return { ...noLocalDisplay(system, display), undecided: true };
    // REVIEW_port_2 G1: a system the validator's terminology server answers but that is not held here is undecided
    // (an error there for a bad code), not UNKNOWN_CODESYSTEM
    if (serverSideSystem(system)) return { ...noLocalDisplay(system, display), undecided: true };
    return { status: "unknown-system" };
  }

  /**
   * Another installed package (outside this closure, or another version) holding a
   * larger copy of the same CodeSystem (same canonical, or TW Core 0.3.2's copy
   * published under the ValueSet URL) that does contain `code`, e.g. TW Core 1.0.0
   * medication-nhi-tw (35 example codes, content complete) vs TW Core 0.3.2 (the
   * full list). The verdict stays the HL7 one (Unknown code); this only says where
   * the code is defined so the caller can choose that package.
   */
  private async fullerCopyHint(system: string, code: string, held: number): Promise<string | null> {
    const csId = terminology.canonicalTail(system);
    if (!csId) return null;
    try {
      const rows = (
        await query<{ package_id: string; package_version: string; concept_count: number | null; url: string | null }>(
          "SELECT c.package_id, c.package_version, cs.concept_count, a.canonical_url AS url FROM fhir.concepts c " +
            "JOIN fhir.codesystems cs ON cs.package_id = c.package_id AND cs.package_version = c.package_version AND cs.cs_id = c.cs_id " +
            "JOIN fhir.artifacts a ON a.package_id = c.package_id AND a.package_version = c.package_version " +
            "  AND a.resource_type = 'CodeSystem' AND a.artifact_id = c.cs_id " +
            "WHERE c.cs_id = $1 AND c.code = $2 ORDER BY cs.concept_count DESC NULLS LAST LIMIT 5",
          [csId, code],
        )
      ).rows;
      const want = system.replace(/\/(CodeSystem|ValueSet)\//, "/");
      const [pids, pvers] = terminology.closureArrays(this.pkg);
      const inClosure = (r: { package_id: string; package_version: string }): boolean =>
        pids.some((p, i) => p === r.package_id && pvers[i] === r.package_version);
      const hit = rows.find(
        (r) => !inClosure(r) && String(r.url || "").replace(/\/(CodeSystem|ValueSet)\//, "/") === want && Number(r.concept_count ?? 0) > held,
      );
      if (!hit) return null;
      return (
        `Code '${code}' is defined in a fuller copy of this CodeSystem installed from ${hit.package_id}#${hit.package_version} ` +
        `(${hit.concept_count} concepts, canonical '${hit.url}'); the package validated against (${this.pkg.package_id}#${this.pkg.version}) carries ${held}. ` +
        `Validate with package_id='${hit.package_id}' version='${hit.package_version}' if that release is intended.`
      );
    } catch {
      return null;
    }
  }

  /**
   * A code covered by a bundled terminology-server table (txCodeTables.ts): unknown to the server
   * → validator_cli's error ("Unknown code 'X' in the CodeSystem 'S' version 'E'"); known → the
   * display is judged only against a ValueSet display the table verified as the server's (case-
   * insensitive, like the server); otherwise it stays unchecked, as for any terminology not held.
   */
  private async checkTxTable(system: string, code: string, display: string | null, tx: TxCodeVerdict): Promise<CodeCheck> {
    if (!tx.known) return { status: "invalid-code", severity: "error", message: `Unknown code '${code}' in the CodeSystem '${system}' version '${tx.edition}'` };
    if (display === null) return { status: "ok" };
    if (tx.displayVerified) {
      let listed: string | null = null;
      try {
        listed = (await enumeratedCodes(system, this.pkg)).get(code)?.display ?? (await installedEnumeratedDisplay(system, code));
      } catch {
        listed = null;
      }
      if (listed) return judgeCodeSystemDisplay(system, code, display, { display: listed, designationList: [] }, null) ?? { status: "ok" };
    }
    return noLocalDisplay(system, display);
  }

  /** RxNorm from rxnorm.concepts (concept-only reference terminology); a warning when not loaded. */
  private async checkRxnorm(code: string, display: string | null): Promise<CodeCheck> {
    if (!(await terminology.rxnormHeld())) {
      return display === null
        ? { status: "silent" }
        : { status: "display-unchecked", message: `Display not checked (RxNorm): no local RxNorm terminology is loaded for ${RXNORM}` };
    }
    const edition = await terminology.rxnormEdition();
    return judgeRxnorm(code, display, await terminology.rxnormConcept(code), rxnormStrict(edition), edition?.version ?? null);
  }

  private async partialHint(system: string): Promise<string | null> {
    try {
      return partialCodeSystemHint(await terminology.loadArtifactByCanonical("CodeSystem", system, this.pkg));
    } catch {
      return null;
    }
  }

  /** WHO ICD-10 from icd.icd10_who (optional ICD source); silent when not loaded. */
  private async checkIcd10Who(code: string, display: string | null): Promise<CodeCheck> {
    if (!(await terminology.icd10WhoHeld())) return noLocalDisplay(ICD10_WHO, display);
    const edition = await terminology.icd10WhoEdition();
    return judgeIcd10Who(code, display, await terminology.icd10WhoRow(code), edition?.edition ?? null, icd10WhoStrict(edition));
  }

  /** ISO 3166-1 from the bundled tx.fhir.org table (alpha-2 / alpha-3 / numeric). */
  private checkIso3166(code: string, display: string | null): CodeCheck {
    const valid = ISO3166_DISPLAY[code];
    if (valid === undefined) {
      return { status: "invalid-code", severity: "error", message: `Unknown code '${code}' in the CodeSystem '${ISO3166}' version '${ISO3166_VERSION}'` };
    }
    if (display !== null) {
      const bad = judgeDisplay(ISO3166, code, display, [valid], iso3166UserAssigned(code) ? "warning" : "error");
      if (bad) return bad;
    }
    return { status: "ok" };
  }
}

function safeJson(raw: string): Record<string, any> | null {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
