/**
 * The official validator test suite (fhir-test-cases validator/manifest.json) as runs: one `base` run per case
 * (instance validated against the core spec + its meta.profile) and one `profile` run when the case names a
 * `profile` step — the two validations org.hl7.fhir.validation ValidationTests performs, each with its own `java`
 * expectation (an outcomes/ file name, an inline {outcome} or the old inline {errorCount, output}).
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { issuesOfOutcome, issuesOfOutputLines, type SimpleIssue } from "../lib/compare.js";
import type { Res } from "../lib/packages.js";

export const SUITE_DIR = process.env.FHIR_TEST_CASES ? join(process.env.FHIR_TEST_CASES, "validator") : join(homedir(), "ref", "fhir-test-cases", "validator");

export interface Expectation {
  issues: SimpleIssue[];
  /** errorCount stated by the expectation (old format), else null. */
  errorCount: number | null;
  source: string;
}

export interface TestRun {
  /** `<case name>` for the base run, `<case name>#profile` for the profile step. */
  id: string;
  name: string;
  module: string;
  step: "base" | "profile";
  file: string;
  version: string | null;
  /** Packages to load (id#version or a .tgz path relative to the suite dir). */
  packages: string[];
  /** Loose files to load (relative to the suite dir). */
  supporting: string[];
  /** Profile step: the profile file validated against. */
  profileSource: string | null;
  expectation: Expectation | null;
  /** Why the run cannot be executed here (null = runnable). */
  skip: string | null;
  /** Manifest flags that change validator_cli settings the TS validator has no switch for. */
  options: string[];
  raw: Res;
}

const R4 = new Set(["4.0", "4.0.1"]);

export function isR4Case(t: Res): boolean {
  if (t.version !== undefined && t.version !== null) return R4.has(String(t.version));
  // no version = R5 per the manifest documentation, unless the expected output is an R4 run
  const j = t.java;
  return typeof j === "string" && /(^|\/)R4\./.test(j);
}

function expectation(j: unknown, suite: string): Expectation | null {
  if (typeof j === "string") {
    const p = join(suite, "outcomes", j);
    if (!existsSync(p)) return null;
    try {
      return { issues: issuesOfOutcome(JSON.parse(readFileSync(p, "utf8"))), errorCount: null, source: j };
    } catch {
      return null;
    }
  }
  if (j && typeof j === "object") {
    const o = j as Res;
    if (o.outcome) return { issues: issuesOfOutcome(o.outcome), errorCount: typeof o.errorCount === "number" ? o.errorCount : null, source: "inline" };
    if (Array.isArray(o.output)) return { issues: issuesOfOutputLines(o.output.map(String)), errorCount: typeof o.errorCount === "number" ? o.errorCount : null, source: "inline-lines" };
    if (typeof o.errorCount === "number") return { issues: [], errorCount: o.errorCount, source: "inline-count" };
  }
  return null;
}

const OPTION_KEYS = [
  "assumeValidRestReferences",
  "allowed-extension-domain",
  "best-practice",
  "language",
  "launch-context",
  "usage",
  "bundle-param",
  "examples",
  "security-checks",
  "for-publication",
  "validateReference",
  "validateContains",
  "no-tx",
  "fetcher",
  "logical",
  "crumb-trail",
  "suppress",
  "wrong-displays",
  "enforceAggregationOutsideBundles",
  "allow-comments",
  "noHtmlInMarkdown",
  "no-experimental-content",
  "new-xver-mode",
  "r5-bundle-relative-reference-policy",
  "certificate",
  "default-version",
  "package-map",
];

const asList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === "string" ? [v] : []);

export function loadRuns(suite = SUITE_DIR): TestRun[] {
  const manifest = JSON.parse(readFileSync(join(suite, "manifest.json"), "utf8")) as Res;
  const runs: TestRun[] = [];
  for (const t of manifest["test-cases"] as Res[]) {
    if (!isR4Case(t)) continue;
    const file = String(t.file);
    const ext = file.split(".").pop()!.toLowerCase();
    const options = OPTION_KEYS.filter((k) => t[k] !== undefined && t[k] !== false);
    const baseSkip =
      t["use-test"] === false ? "use-test=false" : ext === "xml" ? "xml" : ext !== "json" ? `format:${ext}` : t.logical ? "logical" : null;
    const supporting = [...asList(t.supporting), ...asList(t.profiles), ...asList(t.supporting5)];
    const packages = asList(t.packages);
    const common = { name: String(t.name), module: String(t.module ?? "none"), file, version: t.version ?? null, options, raw: t };
    const exp = expectation(t.java, suite);
    runs.push({ ...common, id: String(t.name), step: "base", packages, supporting, profileSource: null, expectation: exp, skip: baseSkip ?? (exp ? null : "no-java-expectation") });
    if (t.profile && typeof t.profile === "object") {
      const p = t.profile as Res;
      const src = typeof p.source === "string" ? p.source : null;
      const pexp = expectation(p.java, suite);
      const pSkip = baseSkip ?? (!src ? "profile-without-source" : /\.json$/i.test(src) ? (pexp ? null : "no-java-expectation") : "profile-xml");
      runs.push({
        ...common,
        id: `${t.name}#profile`,
        step: "profile",
        packages: [...packages, ...asList(p.packages)],
        supporting: [...supporting, ...asList(p.supporting)],
        profileSource: src,
        expectation: pexp,
        skip: pSkip,
      });
    }
  }
  return runs;
}
