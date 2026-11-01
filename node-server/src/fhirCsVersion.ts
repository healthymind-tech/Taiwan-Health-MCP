/**
 * CodeSystem version rules of the HL7 terminology validator (standalone ValueSetValidator, tag 7.0.1):
 * versionIsMoreDetailed, VersionUtilities.versionMatches / isThisOrLater, presentVersionList,
 * getCodeSystemVersionFromValueSet and determineVersion (phase 3 / 4) — shared by the InstanceValidator's
 * binding check (fhirValidator.checkCodingVersions) and the tx adapter (fhirTxValidate). Pure, no imports.
 */

/** VersionUtilities.versionMatches: semver wildcards (1.x, 1.0.x) or equality. */
export function versionMatches(criteria: string, candidate: string): boolean {
  if (criteria === candidate) return true;
  if (/(^|\.)[x*](\.|$)/u.test(criteria)) {
    const c = criteria.split(".");
    const v = candidate.split(".");
    for (let i = 0; i < c.length; i++) {
      if (c[i] === "x" || c[i] === "*") continue;
      if (c[i] !== v[i]) return false;
    }
    return true;
  }
  return false;
}

/** ValueSetValidator.versionIsMoreDetailed(va = guessFormat(candidate), criteria, candidate) (VSV:1946). */
export function versionIsMoreDetailed(criteria: string | null, candidate: string | null): boolean {
  if (!criteria || !candidate) return false;
  if (/^\d+\.\d+\.\d+([-+].*)?$/u.test(candidate)) {
    return /^(\d+|[x*])\.(\d+|[x*])(\.(\d+|[x*]))?([-+].*)?$/u.test(criteria) && versionMatches(criteria, candidate);
  }
  return candidate.startsWith(criteria);
}

/** Loose version order (numeric parts numerically). */
export function cmpVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/u);
  const pb = b.split(/[.-]/u);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? "";
    const y = pb[i] ?? "";
    const nx = Number(x);
    const ny = Number(y);
    const c = x !== "" && y !== "" && !Number.isNaN(nx) && !Number.isNaN(ny) ? nx - ny : x.localeCompare(y);
    if (c) return c;
  }
  return 0;
}

/** ValueSetProcessBase.presentVersionList: sorted, "a", "a or b", "a, b or c". */
export function presentVersionList(versions: Iterable<string>): string {
  const list = [...new Set(versions)].sort();
  if (list.length <= 1) return list[0] ?? "";
  return `${list.slice(0, -1).join(", ")} or ${list[list.length - 1]}`;
}

export interface VersionIssue {
  severity: "error" | "warning";
  /** "version" (Coding.version) or "system" (UNKNOWN_CODESYSTEM_VERSION). */
  at: "version" | "system";
  id: "VALUESET_VALUE_MISMATCH" | "VALUESET_VALUE_MISMATCH_CHANGED" | "VALUESET_VALUE_MISMATCH_DEFAULT" | "UNKNOWN_CODESYSTEM_VERSION";
  message: string;
}

/**
 * getCodeSystemVersionFromValueSet (VSV:1043) without the code / display refinement among several pinned versions
 * of the same system (the highest pinned version is taken), then determineVersion phase 3 / 4 (VSV:1878-1937) for a
 * Coding with a version, against the CodeSystem versions `held` locally (the validator's context). Returns the
 * issues the validator reports; `unknownVersionHeld` = the Coding's own version is not held (UNKNOWN_CODESYSTEM_VERSION
 * is reported only when the caller allows it — the terminology server may hold that version).
 */
export function codingVersionIssues(
  includes: Array<Record<string, any>>,
  system: string,
  versionCoding: string,
  held: string[],
  opts: { reportUnknownVersion: boolean } = { reportUnknownVersion: true },
): { issues: VersionIssue[]; unknownVersion: boolean } {
  const issues: VersionIssue[] = [];
  let versionVS: string | null = null;
  if (includes.some((i) => i && i.version === versionCoding)) versionVS = versionCoding;
  else {
    for (const inc of includes) {
      if (!inc || inc.system !== system || typeof inc.version !== "string" || !inc.version) continue;
      if (versionVS === null || cmpVersions(inc.version, versionVS) >= 0) versionVS = inc.version;
    }
  }
  let result = versionVS;
  if (versionIsMoreDetailed(result, versionCoding)) result = versionCoding;
  const pick = (want: string): string | null => {
    if (held.includes(want)) return want;
    const hits = held.filter((h) => versionIsMoreDetailed(want, h) || versionMatches(want, h));
    return hits.length ? hits.sort(cmpVersions)[hits.length - 1] : null;
  };
  const latest = held.length ? [...held].sort(cmpVersions)[held.length - 1] : null;
  const csVersion = result === null ? latest : pick(result);
  const csFound = result === null ? held.length > 0 : csVersion !== null;
  let unknownVersion = false;
  if (csFound) {
    if (!(versionCoding === csVersion || versionIsMoreDetailed(versionCoding, csVersion))) {
      if (result === null) {
        if (csVersion !== null) {
          issues.push({ severity: "warning", at: "version", id: "VALUESET_VALUE_MISMATCH_DEFAULT", message: `The code system '${system}' version '${csVersion}' for the versionless include in the ValueSet include is different to the one in the value ('${versionCoding}')` });
        }
      } else if (result !== versionVS) {
        issues.push({ severity: "error", at: "version", id: "VALUESET_VALUE_MISMATCH_CHANGED", message: `The code system '${system}' version '${result}' resulting from the version '${versionVS ?? ""}' in the ValueSet include is different to the one in the value ('${versionCoding}')` });
      } else if ((versionVS ?? "") !== versionCoding) {
        issues.push({ severity: "error", at: "version", id: "VALUESET_VALUE_MISMATCH", message: `The code system '${system}' version '${versionVS ?? ""}' in the ValueSet include is different to the one in the value ('${versionCoding}')` });
      }
      if (pick(versionCoding) === null) {
        unknownVersion = true;
        if (opts.reportUnknownVersion && held.length) {
          issues.push({
            severity: "error",
            at: "system",
            id: "UNKNOWN_CODESYSTEM_VERSION",
            message: `A definition for CodeSystem '${system}' version '${versionCoding}' could not be found, so the code cannot be validated. Valid versions: ${presentVersionList(held)}`,
          });
        }
      }
    }
  } else if (result !== null && versionCoding !== result) {
    issues.push({ severity: "error", at: "version", id: "VALUESET_VALUE_MISMATCH", message: `The code system '${system}' version '${result}' in the ValueSet include is different to the one in the value ('${versionCoding}')` });
  }
  return { issues, unknownVersion };
}
