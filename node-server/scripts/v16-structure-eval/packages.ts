/**
 * ISSUES_v16 R3 / R4 / R5 evaluation helpers: file-backed package closures (TWPAS 1.2.7 and
 * TW Core 1.0.0 from a local FHIR package cache, ~/.fhir/packages layout) on the suggestion
 * evaluation's FilePackages, with external terminologies (LOINC / SNOMED CT / ICD-10-CM / RxNorm)
 * accepted as-is — the IG examples' codes are then not "unknown" and only structure is measured.
 * The Bundles are the IG packages' own published examples (no private data).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { FilePackages } from "../suggestions-eval/fileDeps.js";

export const CACHE = process.env.FHIR_PACKAGE_CACHE || join(homedir(), ".fhir", "packages");
export const CLOSURES: Record<string, string[]> = {
  pas: ["tw.gov.mohw.nhi.pas#1.2.7", "tw.gov.mohw.twcore#0.3.2", "hl7.fhir.us.davinci-pas#2.2.1", "hl7.fhir.uv.extensions.r4#5.3.0", "hl7.terminology.r4#7.4.0", "hl7.fhir.r4.core#4.0.1"],
  twcore: ["tw.gov.mohw.twcore#1.0.0", "hl7.fhir.uv.extensions.r4#5.2.0", "hl7.terminology.r4#7.0.0", "hl7.fhir.r4.core#4.0.1"],
};
const EXTERNAL = new Set(["http://loinc.org", "http://snomed.info/sct", "http://hl7.org/fhir/sid/icd-10-cm", "http://www.nlm.nih.gov/research/umls/rxnorm", "http://hl7.org/fhir/sid/icd-10"]);

export class LenientPackages extends FilePackages {
  async checkCode(system: string, code: string, display: string | null): Promise<any> {
    if (EXTERNAL.has(system)) return { status: "ok" };
    return super.checkCode(system, code, display);
  }
}

export function available(ig: string): boolean {
  return (CLOSURES[ig] ?? []).every((p) => existsSync(join(CACHE, p, "package")));
}

const loaded = new Map<string, LenientPackages>();

/** The closure of `ig` (loaded once per process). */
export function packages(ig: string): LenientPackages {
  if (!loaded.has(ig)) loaded.set(ig, new LenientPackages(CACHE, CLOSURES[ig]));
  return loaded.get(ig)!;
}

/** The IG package's example Bundles with at least `minEntries` entries (file name order). */
export function exampleBundles(ig: string, minEntries = 2): Array<[string, Record<string, any>]> {
  const base = join(CACHE, CLOSURES[ig][0], "package");
  const dir = existsSync(join(base, "example")) ? join(base, "example") : base;
  return readdirSync(dir)
    .filter((n) => /^Bundle-.*\.json$/.test(n))
    .sort()
    .map((n): [string, Record<string, any>] => [n, JSON.parse(readFileSync(join(dir, n), "utf8"))])
    .filter(([, b]) => b.resourceType === "Bundle" && Array.isArray(b.entry) && b.entry.length >= minEntries);
}
