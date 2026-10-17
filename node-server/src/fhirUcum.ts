/**
 * UCUM unit-code validation (system `http://unitsofmeasure.org`) for the
 * in-process FHIR validator, backed by the NLM `@lhncbc/ucum-lhc` library.
 *
 * The HL7 validator sends UCUM codes to its terminology server, which parses
 * them with a UCUM grammar (ucum-java, UCUM essence 2.2); an unparseable code
 * is an error: "Unknown code '<c>' in the CodeSystem 'http://unitsofmeasure.org'
 * version '2.2'". ucum-lhc implements the same essence grammar offline.
 *
 * Fail-open: if the library cannot be loaded or throws, the code is reported
 * as "unchecked" (never as invalid), so a library problem can never turn into
 * a false rejection.
 */

import { createRequire } from "node:module";

export const UCUM_SYSTEM = "http://unitsofmeasure.org";
export const UCUM_VERSION = "2.2";

export type UcumVerdict = "valid" | "invalid" | "unchecked";

interface UcumUtils {
  validateUnitString(code: string, suggest?: boolean, valConv?: string): { status: string };
}

let utils: UcumUtils | null | undefined;

function ucum(): UcumUtils | null {
  if (utils !== undefined) return utils;
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("@lhncbc/ucum-lhc");
    utils = pkg.UcumLhcUtils.getInstance() as UcumUtils;
  } catch {
    utils = null;
  }
  return utils;
}

const cache = new Map<string, UcumVerdict>();
const CACHE_MAX = 5000;

/** Is `code` a syntactically and semantically valid UCUM expression? */
export function checkUcumCode(code: string): UcumVerdict {
  const hit = cache.get(code);
  if (hit) return hit;
  let verdict: UcumVerdict;
  const u = ucum();
  if (!u) verdict = "unchecked";
  else if (code === "" || /\s/.test(code)) verdict = "invalid";
  else {
    try {
      const r = u.validateUnitString(code, false);
      verdict = r && r.status === "valid" ? "valid" : r && r.status === "invalid" ? "invalid" : "unchecked";
    } catch {
      verdict = "unchecked";
    }
  }
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(code, verdict);
  return verdict;
}

export function ucumUnknownCodeMessage(code: string): string {
  return `Unknown code '${code}' in the CodeSystem '${UCUM_SYSTEM}' version '${UCUM_VERSION}'`;
}
