/**
 * Offline judgements for external code systems the HL7 validator (validator_cli
 * 7.0.1) sends to its terminology server, tx.fhir.org: LOINC non-term codes
 * (LA / LP / LL / LG), SNOMED CT (inactive content, edition emulation), CVX and
 * WHO ICD-10, plus the Coding.version / ValueSet include version rule.
 *
 * Pure functions over rows the caller loads (fhirTerminology.ts) — no DB here,
 * so every rule is unit-testable. Each rule cites the HL7 / tx.fhir.org
 * behaviour it reproduces; the verdicts were confirmed one by one against
 * validator_cli 7.0.1 + tx.fhir.org (scripts/validator-audit, REPORT.md §v4).
 */

import type { CodeCheck } from "./fhirValidator.js";
import { CVX_CODES, CVX_VERSION } from "./fhirCvx.js";

export type CodeCheckNote = { severity: "warning" | "information"; message: string };

// --------------------------------------------------------------------------- //
// Editions tx.fhir.org serves to validator_cli 7.0.1 (2026-10). A local edition
// is only "strict" (unknown code → error) when it can answer for these.
// --------------------------------------------------------------------------- //

/** LOINC version tx.fhir.org serves ("Unknown code … version '2.82'"). */
export const LOINC_TX_VERSION = "2.82";
/** SNOMED CT International edition tx.fhir.org serves by default. */
export const SNOMED_INT_MODULE = "900000000000207008";
export const SNOMED_INT_EDITION_URI = `http://snomed.info/sct/${SNOMED_INT_MODULE}`;
export const SNOMED_TX_EDITION_DATE = "2025-02-01";
export const SNOMED_TX_VERSION = `${SNOMED_INT_EDITION_URI}/version/${SNOMED_TX_EDITION_DATE.replace(/-/g, "")}`;
/** WHO ICD-10 edition tx.fhir.org serves (http://hl7.org/fhir/sid/icd-10). */
export const ICD10_WHO_TX_EDITION = "2019-covid-expanded";

export const LOINC = "http://loinc.org";
export const SNOMED = "http://snomed.info/sct";
export const CVX = "http://hl7.org/fhir/sid/cvx";
export const ICD10_WHO = "http://hl7.org/fhir/sid/icd-10";

/** Compare dotted numeric versions ('2.80' < '2.82', '2.9' < '2.10'). */
export function compareDotted(a: string, b: string): number {
  const pa = a.split(".").map((x) => parseInt(x, 10) || 0);
  const pb = b.split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

// --------------------------------------------------------------------------- //
// Display rule shared by all external systems
// --------------------------------------------------------------------------- //

/**
 * tx.fhir.org display check (validator_cli 7.0.1, CodeSystemProvider display
 * validation as relayed in Display_Name_for__should_be_one_of__instead_of /
 * Display_Name_WS_for__…): equal ignoring case only; whitespace is significant.
 * `accepted` are all valid displays, `listed` what the message names.
 */
export function judgeExternalDisplay(
  system: string,
  code: string,
  display: string,
  accepted: string[],
  listed: string[],
  suffix = " (for the language(s) 'en')",
): CodeCheck | null {
  const valid = accepted.filter((v) => typeof v === "string" && v !== "");
  if (!valid.length) return null;
  const want = display.toLowerCase();
  if (valid.some((v) => v.toLowerCase() === want)) return null;
  const norm = (x: string): string => x.replace(/\s+/g, " ").trim().toLowerCase();
  const ws = valid.some((v) => norm(v) === norm(display));
  const names = [...new Set(listed.length ? listed : valid)];
  const choices = names.length === 1 ? `'${names[0]}'` : `one of ${names.length} choices: ${names.map((d) => `'${d}'`).join(", ")}`;
  return {
    status: "invalid-display",
    severity: "error",
    message: `${ws ? "Wrong whitespace in Display Name" : "Wrong Display Name"} '${display}' for ${system}#${code}. Valid display is ${choices}${suffix}`,
  };
}

// --------------------------------------------------------------------------- //
// LOINC non-term codes (LA answers, LP parts, LL answer lists, LG groups)
// --------------------------------------------------------------------------- //

/**
 * LOINC Mod-10 check digit of the non-term identifiers. LOINC computes it over
 * the prefix letters plus the number; the prefix contributes a constant that
 * depends only on the parity of the number's length. The offsets below hold for
 * every LA / LL / LP / LG / parent-group code in the LOINC 2.80 release
 * (104,575 codes, no exception). A code failing it exists in no LOINC edition, so
 * tx.fhir.org reports it as an Unknown code.
 */
const NON_TERM_OFFSET: Record<string, [number, number]> = {
  // [even-length number, odd-length number]
  LA: [5, 2],
  LL: [1, 1],
  LP: [2, 7],
  LG: [2, 6],
};

function luhnMod10(digits: string): number {
  let sum = 0;
  let double = true;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d = Math.floor(d / 10) + (d % 10);
    }
    sum += d;
    double = !double;
  }
  return (10 - (sum % 10)) % 10;
}

export function loincNonTermCheckDigitValid(code: string): boolean {
  const m = /^(L[APLG])(\d{1,8})-(\d)$/.exec(code);
  if (!m) return false;
  const off = NON_TERM_OFFSET[m[1]][m[2].length % 2];
  return (luhnMod10(m[2]) + off) % 10 === Number(m[3]);
}

export interface LoincOtherRow {
  kind: string; // answer | part | answer_list | group | parent_group
  display: string | null;
  altDisplay: string | null;
  status: string | null;
}

export function loincUnknownMessage(code: string): string {
  return `Unknown code '${code}' in the CodeSystem '${LOINC}' version '${LOINC_TX_VERSION}'`;
}

/**
 * LA / LP / LL / LG code check, as tx.fhir.org (LOINC 2.82) answers it
 * (validator_cli 7.0.1 InstanceValidator.checkCodeOnServer relays the server's
 * Unknown_Code_in_Version / Display_Name_for__… / DEPRECATED_CONCEPT_FOUND):
 *  - LG group / parent-group codes are not part of tx.fhir.org's LOINC content:
 *    always Unknown_Code_in_Version (confirmed for 6 group codes);
 *  - a failed check digit is unknown in any edition → error;
 *  - a code missing locally is an error only when the local LOINC release is at
 *    least the tx.fhir.org version (`strict`), otherwise a warning;
 *  - display: LA → DisplayText; LL → AnswerListName; LP → PartName or
 *    PartDisplayName (both accepted, message names the first);
 *  - a DEPRECATED part is a warning (DEPRECATED_CONCEPT_FOUND).
 */
export function judgeLoincOther(
  code: string,
  display: string | null,
  row: LoincOtherRow | null,
  strict: boolean,
): CodeCheck {
  if (code.startsWith("LG") || !loincNonTermCheckDigitValid(code)) {
    return { status: "invalid-code", severity: "error", message: loincUnknownMessage(code) };
  }
  if (!row || row.kind === "group" || row.kind === "parent_group") {
    return strict
      ? { status: "invalid-code", severity: "error", message: loincUnknownMessage(code) }
      : {
          status: "invalid-code",
          severity: "warning",
          message: `Code '${code}' was not found in the locally held LOINC release of '${LOINC}'; it may exist in the version used by the terminology server (${LOINC_TX_VERSION})`,
        };
  }
  const notes: CodeCheckNote[] = [];
  if (row.status && row.status.toUpperCase() === "DEPRECATED") {
    notes.push({ severity: "warning", message: `The concept '${code}' is deprecated and its use should be reviewed` });
  }
  if (display !== null) {
    const accepted = [row.display, row.altDisplay].filter((x): x is string => !!x);
    // LP: tx names PartName (alt) and also accepts PartDisplayName.
    const listed = row.kind === "part" ? [row.altDisplay ?? row.display ?? ""] : [row.display ?? ""];
    const bad = judgeExternalDisplay(LOINC, code, display, accepted, listed);
    if (bad) return { ...bad, extra: notes };
  }
  return { status: "ok", extra: notes };
}

// --------------------------------------------------------------------------- //
// SNOMED CT
// --------------------------------------------------------------------------- //

export interface SnomedEditionInfo {
  moduleId: string;
  versionDate: string; // YYYY-MM-DD
  includesInactive: boolean;
}

export interface SnomedConceptRow {
  active: boolean;
  /** Inactivation date for inactive concepts (RF2 effectiveTime), else null/any. */
  effectiveTime: string | null;
  firstReleased: string | null;
}

export interface SnomedDescriptionRow {
  term: string;
  active: boolean;
  /** For inactive rows: the inactivation date. */
  effectiveTime: string | null;
  firstReleased: string | null;
}

/**
 * Whether the local SNOMED CT tables can answer for the edition tx.fhir.org
 * serves: International edition with inactive content, released on or after
 * the tx.fhir.org edition (a newer release holds every older component).
 * A Coding.version naming another edition (US, NL, …) is never strict: those
 * editions carry extension content and may be based on a newer International
 * release.
 */
export function snomedStrict(edition: SnomedEditionInfo | null, codingVersion: string | null): boolean {
  if (!edition || !edition.includesInactive || edition.moduleId !== SNOMED_INT_MODULE) return false;
  if (edition.versionDate < SNOMED_TX_EDITION_DATE) return false;
  if (codingVersion && !codingVersion.startsWith(SNOMED_INT_EDITION_URI)) return false;
  return true;
}

/**
 * SNOMED CT code + display, answered as the tx.fhir.org edition
 * (SNOMED_TX_EDITION_DATE) from a local release that is the same or newer
 * (validator_cli 7.0.1 InstanceValidator.checkCodeOnServer relays the server
 * issues Unknown_Code_in_Version / INACTIVE_CONCEPT_FOUND /
 * INACTIVE_DISPLAY_FOUND / Display_Name_for__should_be_one_of__instead_of):
 *  - a concept first released after the tx edition did not exist there →
 *    Unknown_Code_in_Version (strict only);
 *  - unknown concept: error when strict, else warning;
 *  - concept inactive at the tx edition: warning INACTIVE_CONCEPT_FOUND;
 *  - valid displays = English FSN / synonyms active at the tx edition (released
 *    by then, and active now or inactivated after it);
 *  - a display matching a description that was inactive at the tx edition:
 *    error INACTIVE_DISPLAY_FOUND ("… is no longer considered a correct display");
 *  - anything else: Display_Name_for__should_be_one_of__instead_of (error).
 */
export function judgeSnomed(
  code: string,
  display: string | null,
  concept: SnomedConceptRow | null,
  descriptions: SnomedDescriptionRow[],
  strict: boolean,
): CodeCheck {
  const T = SNOMED_TX_EDITION_DATE;
  const existedAtTx = (first: string | null): boolean => !strict || first === null || first <= T;
  if (!concept || !existedAtTx(concept.firstReleased)) {
    return strict
      ? {
          status: "invalid-code",
          severity: "error",
          message: `Unknown code '${code}' in the CodeSystem '${SNOMED}' version '${SNOMED_TX_VERSION}' (International Edition)`,
        }
      : {
          status: "invalid-code",
          severity: "warning",
          message: `Code '${code}' was not found in the locally held SNOMED CT release of '${SNOMED}'`,
        };
  }
  const notes: CodeCheckNote[] = [];
  const inactiveAtTx = !concept.active && (!strict || concept.effectiveTime === null || concept.effectiveTime <= T);
  if (inactiveAtTx) notes.push({ severity: "warning", message: `The concept '${code}' has a status of inactive and its use should be reviewed` });
  if (display !== null) {
    const known = descriptions.filter((d) => existedAtTx(d.firstReleased));
    const activeAtTx = (d: SnomedDescriptionRow): boolean =>
      d.active || (strict && d.effectiveTime !== null && d.effectiveTime > T);
    const valid = known.filter(activeAtTx).map((d) => d.term);
    const want = display.toLowerCase();
    if (!valid.some((t) => t.toLowerCase() === want)) {
      if (known.some((d) => !activeAtTx(d) && d.term.toLowerCase() === want)) {
        return {
          status: "invalid-display",
          severity: "error",
          message: `'${display}' is no longer considered a correct display for code '${code}' (status = inactive). The correct display is one of ${valid.join(",")}`,
          extra: notes,
        };
      }
      const bad = judgeExternalDisplay(SNOMED, code, display, valid, valid);
      if (bad) return { ...bad, extra: notes };
      if (!valid.length) {
        return { status: "invalid-display", severity: "error", message: `Wrong Display Name '${display}' for ${SNOMED}#${code}: the concept has no valid English display`, extra: notes };
      }
    }
  }
  return { status: "ok", extra: notes };
}

// --------------------------------------------------------------------------- //
// CVX (bundled tx.fhir.org table)
// --------------------------------------------------------------------------- //

/**
 * CVX as tx.fhir.org serves it (version CVX_VERSION): codes are exact strings
 * ('08' valid, '8' unknown); display = CDC short description, the long
 * description designation is also accepted; the message names the short one.
 */
export function judgeCvx(code: string, display: string | null): CodeCheck {
  const row = CVX_CODES[code];
  if (!row) {
    return { status: "invalid-code", severity: "error", message: `Unknown code '${code}' in the CodeSystem '${CVX}' version '${CVX_VERSION}'` };
  }
  if (display !== null) {
    const bad = judgeExternalDisplay(CVX, code, display, [row[0], row[1] ?? ""], [row[0]]);
    if (bad) return bad;
  }
  return { status: "ok" };
}

// --------------------------------------------------------------------------- //
// WHO ICD-10
// --------------------------------------------------------------------------- //

export interface Icd10WhoRow {
  display: string;
  altDisplays: string[];
}

/** Strict when the loaded WHO ICD-10 is exactly the edition tx.fhir.org serves. */
export function icd10WhoStrict(edition: { edition: string; complete: boolean } | null): boolean {
  return !!edition && edition.complete && edition.edition === ICD10_WHO_TX_EDITION;
}

/**
 * WHO ICD-10 as tx.fhir.org serves it (ICD10_WHO_TX_EDITION): case-sensitive
 * codes ('a09' unknown), chapters ('I') and blocks ('A00-A09') are codes;
 * display = title, the long-description designation is also accepted.
 */
export function judgeIcd10Who(code: string, display: string | null, row: Icd10WhoRow | null, edition: string | null, strict: boolean): CodeCheck {
  if (!row) {
    return strict
      ? { status: "invalid-code", severity: "error", message: `Unknown code '${code}' in the CodeSystem '${ICD10_WHO}' version '${edition}'` }
      : { status: "invalid-code", severity: "warning", message: `Code '${code}' was not found in the locally held WHO ICD-10 edition (${edition ?? "unknown"})` };
  }
  if (display !== null) {
    const bad = judgeExternalDisplay(ICD10_WHO, code, display, [row.display, ...row.altDisplays], [row.display]);
    if (bad) return bad;
  }
  return { status: "ok" };
}

// --------------------------------------------------------------------------- //
// Coding.version vs the ValueSet include version
// --------------------------------------------------------------------------- //

/**
 * Port of ValueSetValidator.determineVersion (org.hl7.fhir.core 7.0.1, the
 * version branch tx.fhir.org applies when a Coding with a version is checked
 * against a ValueSet), for SNOMED CT — the only system whose default version
 * tx.fhir.org resolves without the ValueSet naming one:
 *  - versionVS = the single version the ValueSet's includes give the system
 *    (none → the server default, the International edition URI);
 *  - versionIsMoreDetailed(result, versionCoding) = versionCoding starts with
 *    the resolved version → fine (e.g. '…/900000000000207008/version/20250201');
 *  - otherwise, resolved from the default → VALUESET_VALUE_MISMATCH_CHANGED;
 *    resolved from the include version → VALUESET_VALUE_MISMATCH. Both errors,
 *    whatever the binding strength (tx issue, not a binding-strength issue).
 * Returns the error message, or null. Only the ValueSet's own compose is read
 * (as determineVersion does).
 */
export function codingVersionIssue(vs: Record<string, any> | null, system: string, versionCoding: string): string | null {
  if (system !== SNOMED || !vs || !versionCoding) return null;
  const includes: any[] = Array.isArray(vs.compose?.include) ? vs.compose.include : [];
  const forSystem = includes.filter((i) => i && i.system === system);
  if (!forSystem.length) return null;
  const versions = new Set(forSystem.filter((i) => typeof i.version === "string" && i.version).map((i) => String(i.version)));
  const versionVS = versions.size === 1 ? [...versions][0] : null;
  const result = versionVS ?? SNOMED_INT_EDITION_URI;
  if (versionCoding === result || versionCoding.startsWith(result)) return null;
  if (versionVS === null) {
    return `The code system '${system}' version '${result}' resulting from the version '' in the ValueSet include is different to the one in the value ('${versionCoding}')`;
  }
  return `The code system '${system}' version '${versionVS}' in the ValueSet include is different to the one in the value ('${versionCoding}')`;
}
