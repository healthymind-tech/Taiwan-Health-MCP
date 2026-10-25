/**
 * "Would the validator accept this code?" — one rule shared by the search tools
 * (fhir_normalize_code, search_medical_codes(system=…), fhir_lookup_code), the suggestion layer
 * and the content repair (ISSUES_v15.2 R1 / R3): a code a tool recommends must be one
 * fhir_validate_* accepts for the package the caller validates against.
 *
 *   acceptanceOf(check)     the validator's own code check (DbValidatorResolver.checkCode, the
 *                           call validation makes) → accepted / rejected / undecided;
 *   confirmCoding(...)      the same, and for a terminology not held locally (e.g. WHO ATC) the
 *                           evidence that the validator's reference server knows the code: the
 *                           bundled server table (txCodeTables.ts), else a ValueSet of the
 *                           package closure that lists the code — never a guess;
 *   enumeratedCodes(...)    codes a closure ValueSet lists for a system (compose.include.concept),
 *                           with their display (for such systems the only local names).
 */

import { query } from "./db.js";
import type { PackageRow } from "./fhirIg.js";
import * as terminology from "./fhirTerminology.js";
import type { CodeCheck } from "./fhirValidator.js";
import { TtlMemo } from "./ttlMemo.js";
import { txCodeVerdict } from "./txCodeTables.js";

export interface Acceptance {
  /** true: the validator accepts the code; false: it reports it (error); null: not decidable locally. */
  accepted: boolean | null;
  reason?: string;
}

/** The validator's code check (no display given) as an acceptance verdict. */
export function acceptanceOf(check: CodeCheck | null | undefined, where: string): Acceptance {
  if (!check) return { accepted: null, reason: "the code could not be checked" };
  switch (check.status) {
    case "ok":
      return { accepted: true };
    case "invalid-display":
      return check.severity === "error" ? { accepted: true, reason: "the code is valid; check its display" } : { accepted: true };
    case "invalid-code":
      return check.severity === "error"
        ? { accepted: false, reason: `${check.message} — fhir_validate_* (${where}) reports this code as an error` }
        : { accepted: true, reason: `accepted with a warning: ${check.message}` };
    default:
      return { accepted: null, reason: "the terminology is not held locally, so the code cannot be confirmed here" };
  }
}

export interface EnumeratedCode {
  display: string | null;
  valueSets: string[];
}

const ENUM_TTL_MS = 10 * 60_000;
const enumMemo = new TtlMemo<Map<string, EnumeratedCode>>(ENUM_TTL_MS, 200);

/** Codes the ValueSets of `pkg`'s closure list (compose.include.concept) under `system`. */
export function enumeratedCodes(system: string, pkg: PackageRow): Promise<Map<string, EnumeratedCode>> {
  return enumMemo.get(`${terminology.closureKey(pkg)}|${system}`, async () => {
    const [pids, pvers] = terminology.closureArrays(pkg);
    const rows = (
      await query<{ url: string | null; inc: unknown }>(
        "SELECT a.canonical_url AS url, a.raw_json -> 'compose' -> 'include' AS inc FROM fhir.artifacts a " +
          "JOIN unnest($1::text[], $2::text[]) AS dep(pid, pver) ON a.package_id = dep.pid AND a.package_version = dep.pver " +
          "WHERE a.resource_type = 'ValueSet' AND a.raw_json -> 'compose' -> 'include' @> jsonb_build_array(jsonb_build_object('system', $3::text))",
        [pids, pvers, system],
      )
    ).rows;
    const out = new Map<string, EnumeratedCode>();
    for (const r of rows) {
      const incs: any[] = Array.isArray(r.inc) ? r.inc : [];
      for (const inc of incs) {
        if (!inc || inc.system !== system || !Array.isArray(inc.concept)) continue;
        for (const c of inc.concept) {
          if (!c || typeof c.code !== "string" || !c.code) continue;
          const cur: EnumeratedCode = out.get(c.code) ?? { display: typeof c.display === "string" && c.display ? c.display : null, valueSets: [] };
          if (r.url && !cur.valueSets.includes(r.url)) cur.valueSets.push(r.url);
          out.set(c.code, cur);
        }
      }
    }
    return out;
  });
}

export interface ConfirmedCoding extends Acceptance {
  system: string;
  code: string;
  /** A display the validator accepts for the code (omitted when none is known locally). */
  display: string | null;
  /** Closure ValueSets that list the code (e.g. the ValueSet a coding slice is bound to). */
  valueSets?: string[];
}

/**
 * Would the validator (for `pkg`) accept a Coding {system, code}? `checkCode` is the validator's
 * check (DbValidatorResolver.checkCode) — it decides every terminology held locally. For one that
 * is not (status silent / unknown-system), the reference server's verdict decides when bundled
 * (txCodeTables), else a closure ValueSet listing the code counts as evidence that it exists.
 */
export async function confirmCoding(
  checkCode: (system: string, code: string, display: string | null) => Promise<CodeCheck>,
  pkg: PackageRow,
  system: string,
  code: string,
  where: string,
): Promise<ConfirmedCoding> {
  let check: CodeCheck | null = null;
  try {
    check = await checkCode(system, code, null);
  } catch {
    check = null;
  }
  const acc = acceptanceOf(check, where);
  let listed: EnumeratedCode | undefined;
  try {
    listed = (await enumeratedCodes(system, pkg)).get(code);
  } catch {
    listed = undefined;
  }
  const vsInfo = listed?.valueSets.length ? { valueSets: listed.valueSets } : {};
  const tx = txCodeVerdict(system, code);
  if (acc.accepted !== null) {
    let display: string | null = null;
    if (acc.accepted) {
      try {
        display = (await terminology.lookup(system, code, pkg))?.display ?? null;
      } catch {
        display = null;
      }
      // Not held locally but covered by the server table: the ValueSet display it verified.
      if (display === null && tx?.known && tx.displayVerified && listed?.display) display = listed.display;
    }
    return { system, code, display, ...acc, ...vsInfo };
  }
  if (tx && !tx.known) {
    return { system, code, display: null, accepted: false, reason: `Unknown code '${code}' in the CodeSystem '${system}' version '${tx.edition}' (the terminology server the validator uses does not have it)`, ...vsInfo };
  }
  if (tx && tx.known) {
    return { system, code, display: tx.displayVerified && listed?.display ? listed.display : null, accepted: true, reason: `a code of ${system} (edition ${tx.edition} of the validator's terminology server)`, ...vsInfo };
  }
  if (listed) {
    return { system, code, display: listed.display, accepted: true, reason: `listed by ${listed.valueSets[0] ?? "a ValueSet of the package"}`, ...vsInfo };
  }
  return { system, code, display: null, accepted: null, reason: acc.reason };
}
