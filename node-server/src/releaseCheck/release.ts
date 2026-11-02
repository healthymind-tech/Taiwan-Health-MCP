/**
 * fhir_release_check (ISSUES_v18 R4 + v20 R1): the last gate before a converted Bundle is sent. `release: true` only
 * when ALL hold:
 *   1. validation — the official validator's verdict has 0 errors: the result of the fhir_validate_bundle pipeline
 *      (official engine when configured, officialValidator.ts) must carry `official_verdict: true` and not
 *      `checked_fully: false`; an MCP fallback / unverified codes / no official engine → `not-officially-verified`
 *      (unless the caller opts out with require_official=false);
 *   2. content — grounding + record checks (the same pipeline with source_text) report 0 BLOCKING errors (v20.1 item 2:
 *      each content finding carries `gate`, recordChecks/contentGates.ts; advisory errors are counted and returned in
 *      `content.advisory_errors` but never stop the release);
 *   3. facts — when `facts` are given, fact coverage is complete (factCoverage/coverage.ts): no missing fact, no fact
 *      without a record basis, no unusable fact written into the Bundle;
 *   4. completeness (v20 R1) — every `targets` item is in the Bundle (count ≥ min), else `missing-target`; without
 *      targets: the Bundle profile's required entry slices are present, and a single-entry Bundle is not accepted when
 *      the facts name several resource types (`suspected-empty-bundle`, advisory); without targets completeness cannot be
 *      judged → `incomplete-input`, never released.
 *   5. parity v3 (ROUND 9) — the release condition is: parity 0 errors AND checked_fully=true AND extended 0 errors. Whatever
 *      require_official says, `checked_fully: false` stops a release (`not-fully-checked`), and every error of
 *      `extended_findings` does (`extended-error`, check "extended"); `unverifiable` findings are counted, they do not; a
 *      layer that could not finish does (`extended-incomplete`).
 * v20.2 (evaluator decision): only decidable conditions stop a release — the official verdict, the targets, and the
 * blocking content findings (structured numbers / dates / identifiers not in the record). Fact coverage and every
 * semantic content finding are returned in `advisories` / as advisory issues and never stop it.
 * `next`: "send" (released) | "insufficient_information" (the facts a missing target needs exist but the record makes
 * all of them unusable — the case cannot be converted automatically) | "fix" (everything else, incl. a missing target no
 * fact names: a model omission). A case that is not released in the end is reported as not convertible automatically. Pure over injected deps; never
 * logs source_text.
 */
import { checkFactCoverage, type Fact, type FactCoverageDeps, type FactCoverageResult } from "../factCoverage/coverage.js";
import { impliedTypes } from "../factCoverage/infer.js";
import { contentGateOf } from "../recordChecks/contentGates.js";

type Json = Record<string, any>;
const isObj = (x: unknown): x is Json => !!x && typeof x === "object" && !Array.isArray(x);

export const RELEASE_CHECK_VERSION = "1.2.0";

export interface ReleaseTarget {
  /** Resource type the Bundle must contain (Patient, Encounter, Observation …). */
  resourceType?: string | null;
  /** Profile (canonical, |version ignored, or its id) the entry must declare in meta.profile. */
  profile?: string | null;
  /** What the item is, for messages (病人, 體溫 …). */
  what?: string | null;
  /** Optional code the entry must carry (any Coding of the resource with this code, and system when given). */
  code?: { system?: string | null; code: string } | null;
  /** Minimum count (default 1). */
  min?: number | null;
  /** Indices into `facts` the target needs (else: facts whose item / attribute name the target's resource type). */
  facts?: number[] | null;
}

export interface ReleaseInput {
  bundle: Json;
  source_text: string;
  facts?: Fact[] | null;
  targets?: ReleaseTarget[] | null;
  site_config?: string | null;
  package_id?: string | null;
  version?: string | null;
  bundle_profile?: string | null;
  /** Default true: only an official validator verdict releases. */
  require_official?: boolean | null;
}

export interface EntrySlice {
  name: string;
  min: number;
  types: string[];
  profiles: string[];
}

export interface ReleaseDeps extends FactCoverageDeps {
  /** The fhir_validate_bundle pipeline (validator + grounding + record checks) — its JSON envelope text. */
  validate(args: { bundle: Json; source_text: string; site_config: string | null; package_id: string | null; version: string | null; bundle_profile: string | null }): Promise<string>;
  /** Required entry slices (min ≥ 1) of a Bundle profile; null when the profile is unknown. */
  entrySlices?(bundleProfile: string, packageId: string | null, version: string | null): Promise<EntrySlice[] | null>;
}

export interface ReleaseReason {
  code: string;
  message: string;
  pointer?: string;
  count: number;
  /** "validation" | "extended" | "content" | "facts" | "completeness" */
  check: string;
}

export type NextStep = "send" | "fix" | "insufficient_information";

export interface ReleaseResult {
  release: boolean;
  next: NextStep;
  reasons: ReleaseReason[];
  /** v20.2: semantic findings (fact coverage, suspected empty Bundle) — returned for the model, never stop a release */
  advisories: ReleaseReason[];
  validation: Json;
  content: Json;
  facts: Json | null;
  completeness: Json;
}

const MAX_ISSUE_REASONS = 25;
const isError = (i: Json): boolean => i.severity === "error" || i.severity === "fatal";
/** A content error that may stop the release (its stamped gate, else the registry's). */
const isBlocking = (i: Json): boolean => isError(i) && (i.gate === "blocking" || (i.gate === undefined && contentGateOf(i) === "blocking"));
const unver = (p: string): string => p.split("|")[0];
const tail = (p: string): string => unver(p).split("/").pop() ?? p;

type Bucket = "validator" | "grounding" | "record";
function bucketOf(i: Json): Bucket {
  if (i.source === "record-checks") return "record";
  if (i.source === "grounding" || (typeof i.rule === "string" && /^G-/u.test(i.rule))) return "grounding";
  return "validator";
}

/** Every issue of a validation data block: Bundle-level + per entry. */
function allIssues(data: Json): Json[] {
  const out: Json[] = [];
  for (const i of Array.isArray(data.issues) ? data.issues : []) if (isObj(i)) out.push(i);
  for (const e of Array.isArray(data.entries) ? data.entries : []) if (isObj(e)) for (const i of Array.isArray(e.issues) ? e.issues : []) if (isObj(i)) out.push(i);
  return out;
}

function issueReasons(list: Json[], code: string, check: string): ReleaseReason[] {
  const out: ReleaseReason[] = list.slice(0, MAX_ISSUE_REASONS).map((i) => ({
    code,
    message: String(i.message ?? i.diagnostics ?? "").slice(0, 300),
    ...(typeof i.pointer === "string" ? { pointer: i.pointer } : {}),
    count: 1,
    check,
  }));
  if (list.length > MAX_ISSUE_REASONS) out.push({ code, message: `${list.length - MAX_ISSUE_REASONS} more error(s) of this kind (see the fhir_validate_bundle output)`, count: list.length - MAX_ISSUE_REASONS, check });
  return out;
}

function profilesOf(res: Json): string[] {
  return isObj(res.meta) && Array.isArray(res.meta.profile) ? res.meta.profile.filter((p: unknown): p is string => typeof p === "string").map(unver) : [];
}

function hasCode(res: Json, want: { system?: string | null; code: string }): boolean {
  let hit = false;
  const walk = (x: unknown): void => {
    if (hit) return;
    if (Array.isArray(x)) x.forEach(walk);
    else if (isObj(x)) {
      if (x.code === want.code && (!want.system || x.system === want.system)) hit = true;
      for (const v of Object.values(x)) if (typeof v === "object") walk(v);
    }
  };
  walk(res);
  return hit;
}

function matchesTarget(res: Json, t: ReleaseTarget): boolean {
  if (t.resourceType && res.resourceType !== t.resourceType) return false;
  if (t.profile) {
    const want = unver(t.profile);
    const ps = profilesOf(res);
    if (!ps.some((p) => p === want || tail(p) === want || tail(p) === tail(want))) return false;
  }
  if (t.code && t.code.code && !hasCode(res, t.code)) return false;
  return !!(t.resourceType || t.profile || t.code);
}

function targetName(t: ReleaseTarget): string {
  return [t.what, t.resourceType, t.profile ? tail(t.profile) : null, t.code ? `${t.code.system ? t.code.system + "|" : ""}${t.code.code}` : null].filter(Boolean).join(" / ") || "target";
}

export async function releaseCheck(input: ReleaseInput, deps: ReleaseDeps): Promise<ReleaseResult> {
  const bundle = input.bundle;
  const reasons: ReleaseReason[] = [];
  const requireOfficial = input.require_official !== false;
  const bundleProfile = (input.bundle_profile && input.bundle_profile.trim()) || (profilesOf(bundle)[0] ?? null);

  // ---- 1 + 2: the validate pipeline (validator, grounding, record checks)
  let env: Json | null = null;
  try {
    env = JSON.parse(
      await deps.validate({
        bundle,
        source_text: input.source_text,
        site_config: input.site_config ?? null,
        package_id: input.package_id ?? null,
        version: input.version ?? null,
        bundle_profile: input.bundle_profile ?? null,
      }),
    ) as Json;
  } catch {
    env = null;
  }
  const data: Json | null = env && env.ok === true && isObj(env.data) ? env.data : null;
  let validation: Json;
  let content: Json;
  if (!data) {
    const err = env && isObj(env.error) ? env.error : null;
    reasons.push({ code: "validation-failed", message: `Validation did not complete${err ? `: ${err.code ?? ""} ${String(err.message ?? "").slice(0, 200)}` : ""}.`, count: 1, check: "validation" });
    validation = { completed: false, ...(err ? { error: { code: err.code ?? null, message: err.message ?? null } } : {}) };
    content = { completed: false };
  } else {
    const issues = allIssues(data);
    const by = (b: Bucket): Json[] => issues.filter((i) => bucketOf(i) === b);
    const vErr = by("validator").filter(isError);
    const gErr = by("grounding").filter(isBlocking);
    const rErr = by("record").filter(isBlocking);
    const advisory = [...by("grounding"), ...by("record")].filter((i) => isError(i) && !isBlocking(i));
    const official = data.official_verdict === true && data.checked_fully !== false;
    validation = {
      completed: true,
      errors: vErr.length,
      warnings: by("validator").filter((i) => i.severity === "warning").length,
      source: data.source ?? null,
      engine: data.engine ?? null,
      official_verdict: data.official_verdict ?? null,
      checked_fully: data.checked_fully ?? null,
      ...(data.fallback_reason ? { fallback_reason: data.fallback_reason } : {}),
      ...(Array.isArray(data.unverified) && data.unverified.length ? { unverified: data.unverified.length } : {}),
      officially_verified: official,
    };
    reasons.push(...issueReasons(vErr, "validation-error", "validation"));
    if (!official) {
      const why = data.fallback_reason
        ? `the MCP fallback validated it (${String(data.fallback_reason).slice(0, 120)})`
        : data.official_verdict === undefined
          ? "no official validator serves this package"
          : data.checked_fully === false
            ? "the check was not complete (unverified codes or unchecked profiles)"
            : "the official validator did not give a verdict";
      if (requireOfficial) {
        reasons.push({ code: "not-officially-verified", message: `Not released: ${why}. Only an official validator verdict with 0 errors releases a Bundle; retry when it is available.`, count: 1, check: "validation" });
      } else {
        validation.note = `require_official=false: the MCP verdict was accepted (${why}).`;
        if (data.checked_fully === false) reasons.push({ code: "not-fully-checked", message: "Not released: a check validator_cli would do was not done (see codes_unchecked / slices_unchecked / invariants_unchecked / undecided_causes of fhir_validate_bundle).", count: 1, check: "validation" });
      }
    }
    // ROUND 9: the extended layer, independent of the parity verdict
    const ext: Json | null = isObj(data.extended_findings) ? data.extended_findings : null;
    if (ext) {
      const rows: Json[] = (Array.isArray(ext.findings) ? ext.findings : []).filter(isObj);
      const errs = rows.filter((f) => f.severity === "error");
      validation.extended = { errors: errs.length, unverifiable: Number(ext.summary?.unverifiable ?? 0), ...(ext.summary?.incomplete ? { incomplete: true } : {}) };
      reasons.push(...issueReasons(errs.map((f) => ({ message: f.fix?.action ? `${f.message} ${f.fix.action}` : f.message })), "extended-error", "extended"));
      if (ext.summary?.incomplete) reasons.push({ code: "extended-incomplete", message: "The extended checks could not finish; validate again.", count: 1, check: "extended" });
    }
    content = {
      completed: true,
      source_text: !!(input.source_text && input.source_text.trim()),
      grounding_errors: gErr.length,
      record_check_errors: rErr.length,
      advisory_errors: advisory.length,
      ...(advisory.length ? { advisory_rules: [...new Set(advisory.map((i) => String(i.source === "record-checks" ? i.code : i.rule)))].sort() } : {}),
      warnings: [...by("grounding"), ...by("record")].filter((i) => i.severity === "warning").length,
    };
    reasons.push(...issueReasons(gErr, "grounding-error", "content"));
    reasons.push(...issueReasons(rErr, "record-check-error", "content"));
  }
  if (!input.source_text || !input.source_text.trim()) {
    reasons.push({ code: "no-source-text", message: "source_text is required: without the record, grounding and record checks cannot run.", count: 1, check: "content" });
  }

  // ---- 3: fact coverage — v20.2 (evaluator decision): semantic, advisory only (reported in `advisories`, never stops a release)
  const advisories: ReleaseReason[] = [];
  const facts = Array.isArray(input.facts) ? input.facts : null;
  let cov: FactCoverageResult | null = null;
  if (facts && facts.length) {
    cov = await checkFactCoverage({ bundle, source_text: input.source_text, facts, package_id: input.package_id ?? null, version: input.version ?? null }, deps);
    for (const f of cov.facts) {
      const ptr = f.found_at?.[0]?.pointer;
      if (f.status === "missing") {
        advisories.push({ code: f.reason_code === "found-in-other-resource" ? "fact-in-other-resource" : "fact-missing", message: `fact ${f.index}: ${f.reason}${f.suggested_paths?.length ? ` Suggested: ${f.suggested_paths.join(", ")}.` : ""}`, count: 1, check: "facts", ...(f.found_elsewhere?.[0] ? { pointer: f.found_elsewhere[0].pointer } : {}) });
      } else if (f.status === "quote_not_in_record") {
        advisories.push({ code: "quote-not-in-record", message: `fact ${f.index}: ${f.reason}`, count: 1, check: "facts" });
      } else if (f.status === "not_usable" && f.found_at?.length) {
        advisories.push({ code: "unusable-fact-written", message: `fact ${f.index}: ${f.reason}`, count: 1, check: "facts", ...(ptr ? { pointer: ptr } : {}) });
      }
    }
  }

  // ---- 4: completeness (v20 R1)
  const entries: Json[] = (Array.isArray(bundle.entry) ? bundle.entry : []).filter((e: unknown) => isObj(e) && isObj(e.resource)).map((e: Json) => e.resource);
  const completeness: Json = { entries: entries.length };
  let insufficient = false;
  const targets = Array.isArray(input.targets) ? input.targets.filter(isObj) : [];
  if (!targets.length) {
    // v20.2: completeness is decided by the conversion target only (facts are advisory) — without targets it cannot be judged
    completeness.incomplete_input = true;
    reasons.push({
      code: "incomplete-input",
      message: "No `targets` were given: completeness cannot be judged, so the Bundle is not released. Pass the conversion target's required items as `targets` (facts are checked as advice only).",
      count: 1,
      check: "completeness",
    });
  }
  if (targets.length) {
    const rows: Json[] = [];
    for (const t of targets as ReleaseTarget[]) {
      const min = Number.isInteger(t.min) && (t.min as number) > 0 ? (t.min as number) : 1;
      const found = entries.filter((r) => matchesTarget(r, t)).length;
      const row: Json = { target: targetName(t), min, found, ok: found >= min };
      if (found < min) {
        // the facts this target needs: given by index, else by the target's resource type
        let needed: number[] = [];
        if (cov) {
          needed = Array.isArray(t.facts) && t.facts.length
            ? t.facts.filter((i) => Number.isInteger(i) && i >= 0 && i < cov!.facts.length)
            : cov.facts.filter((f) => t.resourceType && f.resource_types.includes(t.resourceType)).map((f) => f.index);
          // evaluator decision (2026-11-01): a target no fact names is a model omission, not an absent record fact → fix;
          // insufficient_information only when the facts that name it exist and the record makes all of them unusable
          const unusable = needed.filter((i) => cov!.facts[i].status === "not_usable");
          if (needed.length && unusable.length === needed.length) {
            insufficient = true;
            row.insufficient_information = true;
            reasons.push({
              code: "insufficient-information",
              message: `${targetName(t)}: the record makes every fact for it unusable (facts ${needed.join(", ")}: negated / not established / pending / not applicable) — the case cannot be converted automatically.`,
              count: min - found,
              check: "completeness",
            });
          }
        }
        if (!row.insufficient_information) {
          reasons.push({ code: "missing-target", message: `The conversion target requires ${targetName(t)} (at least ${min}); the Bundle has ${found}.`, count: min - found, check: "completeness" });
        }
      }
      rows.push(row);
    }
    completeness.targets = rows;
  } else {
    // heuristic minimum: the Bundle profile's required entry slices …
    if (bundleProfile && deps.entrySlices) {
      let slices: EntrySlice[] | null = null;
      try {
        slices = await deps.entrySlices(bundleProfile, input.package_id ?? null, input.version ?? null);
      } catch {
        slices = null;
      }
      if (slices) {
        const rows: Json[] = [];
        for (const s of slices.filter((x) => x.min >= 1)) {
          const found = entries.filter((r) => (!s.types.length || s.types.includes(String(r.resourceType))) && (!s.profiles.length || !profilesOf(r).length || profilesOf(r).some((p) => s.profiles.map(unver).includes(p)))).length;
          rows.push({ slice: s.name, min: s.min, found, ok: found >= s.min });
          if (found < s.min) reasons.push({ code: "missing-entry-slice", message: `The Bundle profile ${tail(bundleProfile)} requires entry slice '${s.name}' (${s.types.join(" | ") || "any"}${s.profiles.length ? `, ${s.profiles.map(tail).join(" | ")}` : ""}) at least ${s.min} time(s); the Bundle has ${found}.`, count: s.min - found, check: "completeness" });
        }
        completeness.entry_slices = rows;
      }
    }
    // … and a single entry while the facts name several resource types
    const factTypes = new Set<string>();
    for (const f of facts ?? []) {
      const ts = impliedTypes(String(f.item ?? ""), String(f.attribute ?? ""), f.resource_type ?? null);
      if (ts.length) factTypes.add(ts[0]);
    }
    completeness.fact_resource_types = [...factTypes];
    const nonComposition = entries.filter((r) => r.resourceType !== "Composition" && r.resourceType !== "MessageHeader");
    if (nonComposition.length <= 1 && factTypes.size >= 2) {
      completeness.suspected_empty = true;
      advisories.push({
        code: "suspected-empty-bundle",
        message: `The Bundle has ${nonComposition.length} content entr${nonComposition.length === 1 ? "y" : "ies"} but the facts name ${factTypes.size} resource types (${[...factTypes].join(", ")}): entries were dropped. Pass the conversion target as \`targets\` for an exact check.`,
        count: factTypes.size - nonComposition.length,
        check: "completeness",
      });
    }
  }

  const release = reasons.length === 0;
  // (the advisories are returned with the result; they do not stop a release)
  const next: NextStep = release ? "send" : insufficient ? "insufficient_information" : "fix";
  return {
    release,
    next,
    reasons,
    advisories,
    validation,
    content,
    facts: cov ? { ...cov.summary, results: cov.facts } : null,
    completeness,
  };
}
