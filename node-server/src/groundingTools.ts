/**
 * MCP tool layer for the grounding (faithfulness) and completeness engines
 * (mcp_proposal/MCP_GROUNDING_SPEC.md §2.0, §2.2–§2.4):
 *
 *   fhir_check_grounding     -> runCheckGroundingTool
 *   fhir_check_completeness  -> runCheckCompletenessTool
 *   fhir_validate_bundle     -> addBundleGrounding   (optional source_text; spec §2.4)
 *   fhir_validate_resource   -> addResourceGrounding (same parameters, single resource)
 *
 * Every function returns the common FHIR-tool envelope as a JSON string
 * `{ok, data, warnings, provenance, error?}`. Without grounding the validate
 * helpers return the conformance text they were given unchanged (same string),
 * so the conformance-only output stays byte-identical.
 *
 * Privacy (spec §6.7): the record text (`source_text`) and the site
 * configuration are never logged, never put in metric labels and never echoed
 * in provenance — only the first 16 hex chars of its SHA-256 (`sourceSha256`).
 *
 * Collaborators are injected (`GroundingToolDeps`) so the module is unit
 * testable without Postgres; `defaultGroundingDeps()` wires the production
 * DB-backed terminology provider.
 */
import { query as dbQuery } from "./db.js";
import {
  GROUNDING_REFERENCE_VERSION,
  LEXICON_SHA256,
  LEXICON_VERSION,
  checkGrounding,
  createDbTerminologyNames,
  mergeGroundingIntoValidation,
  resolveValidateGrounding,
  sourceSha256Prefix,
  type ConformanceData,
  type EvidenceMap,
  type GroundingIssue,
  type GroundingLogger,
  type GroundingPolicy,
  type GroundingResult,
  type GroundingVerbosity,
  type TerminologyNames,
} from "./grounding/index.js";
import { COMPLETENESS_TOOL_VERSION, checkCompleteness, type CompletenessInput } from "./grounding/completeness/index.js";
import { logDebug, logError } from "./logger.js";
import { toolVersion } from "./toolVersions.js";

type Json = Record<string, unknown>;

export interface GroundingToolDeps {
  terminology: TerminologyNames;
  /**
   * Envelope provenance of the requested IG package ({packageId, version, fhirVersion, source}),
   * or null when it cannot be resolved. Grounding itself does not depend on the IG.
   */
  packageProvenance?: (packageId: string | null, version: string | null) => Promise<Json | null>;
  logger?: GroundingLogger;
}

let dbTerminology: TerminologyNames | null = null;

/** Production terminology provider (local Postgres tables only; LRU-cached per process). */
export function dbTerminologyNames(): TerminologyNames {
  dbTerminology ??= createDbTerminologyNames({
    query: async (sql, params) => ({ rows: (await dbQuery(sql, params)).rows as Array<Record<string, unknown>> }),
    logger: { warn: (msg, meta) => logError(msg, meta ?? {}) },
  });
  return dbTerminology;
}

/** Debug-level logger for the engines; they only ever pass sourceSha256 + counters, never record text. */
export const groundingLogger: GroundingLogger = {
  debug: (msg, meta) => logDebug(msg, meta ?? {}),
};

// ----------------------------------------------------------------------------------------- envelope helpers

function errorEnvelope(code: string, message: string): string {
  return JSON.stringify({ ok: false, data: null, warnings: [], error: { code, message } });
}

function isBundle(x: unknown): x is Json {
  return !!x && typeof x === "object" && !Array.isArray(x) && (x as Json).resourceType === "Bundle";
}

async function packageBlock(deps: GroundingToolDeps, packageId: string | null | undefined, version: string | null | undefined): Promise<{ block: Json; warnings: string[] }> {
  const pid = packageId ?? null;
  const ver = version ?? null;
  let prov: Json | null = null;
  try {
    prov = deps.packageProvenance ? await deps.packageProvenance(pid, ver) : null;
  } catch {
    prov = null;
  }
  if (prov) return { block: prov, warnings: [] };
  const warnings = pid ? [`IG package ${pid}${ver ? `#${ver}` : ""} is not installed; grounding does not depend on it`] : [];
  return { block: { packageId: pid, version: ver, fhirVersion: "4.0.1", source: "ig" }, warnings };
}

async function terminologyVersion(t: TerminologyNames): Promise<string> {
  try {
    return String(await t.version());
  } catch {
    return "unavailable";
  }
}

/** Grounding fields of the provenance block (spec §2.0); `sourceSha256` is the only trace of the record. */
async function groundingFields(deps: GroundingToolDeps, sourceText: string | null | undefined): Promise<Json> {
  return {
    groundingVersion: toolVersion("fhir_check_grounding"),
    referenceVersion: GROUNDING_REFERENCE_VERSION,
    lexiconVersion: LEXICON_VERSION,
    lexiconSha256: LEXICON_SHA256,
    terminologyVersion: await terminologyVersion(deps.terminology),
    sourceSha256: sourceSha256Prefix(sourceText),
  };
}

function failure(tool: string, err: unknown, sourceText: string | null | undefined): string {
  // Log the failure class only — never the arguments (they hold the clinical record).
  const name = err instanceof Error ? err.name : "Error";
  logError("grounding tool failed", { tool, error: name, sourceSha256: sourceSha256Prefix(sourceText) });
  return errorEnvelope("GROUNDING_FAILED", `${tool}: internal error (${name})`);
}

// ----------------------------------------------------------------------------------------- fhir_check_grounding

export interface CheckGroundingArgs {
  bundle: Json;
  source_text: string;
  site_config?: string | null;
  evidence_map?: EvidenceMap | null;
  mode?: "auto" | "strict" | null;
  verbosity?: GroundingVerbosity | null;
  policy?: GroundingPolicy | null;
  instruction_markers?: string[] | null;
  package_id?: string | null;
  version?: string | null;
}

export async function runCheckGroundingTool(args: CheckGroundingArgs, deps: GroundingToolDeps): Promise<string> {
  if (!isBundle(args.bundle)) return errorEnvelope("INVALID_ARGUMENT", "bundle must be a FHIR Bundle resource");
  if (typeof args.source_text !== "string") return errorEnvelope("INVALID_ARGUMENT", "source_text must be a string");
  try {
    const data = await checkGrounding(
      {
        bundle: args.bundle,
        source_text: args.source_text,
        site_config: args.site_config ?? null,
        evidence_map: args.evidence_map ?? null,
        mode: args.mode ?? null,
        verbosity: args.verbosity ?? "warnings",
        policy: args.policy ?? {},
        instruction_markers: args.instruction_markers ?? null,
        package_id: args.package_id ?? null,
        version: args.version ?? null,
      },
      { terminology: deps.terminology, logger: deps.logger },
    );
    const pkg = await packageBlock(deps, args.package_id, args.version);
    const g = await groundingFields(deps, args.source_text);
    const { groundingVersion: _gv, ...rest } = g;
    return JSON.stringify({
      ok: true,
      data,
      warnings: pkg.warnings,
      provenance: { ...pkg.block, tool: "fhir_check_grounding", toolVersion: toolVersion("fhir_check_grounding"), ...rest },
    });
  } catch (e) {
    return failure("fhir_check_grounding", e, args.source_text);
  }
}

// ----------------------------------------------------------------------------------------- fhir_check_completeness

export async function runCheckCompletenessTool(args: CompletenessInput, deps: GroundingToolDeps): Promise<string> {
  try {
    const r = await checkCompleteness(args, { terminology: deps.terminology });
    const pkg = await packageBlock(deps, args.package_id, args.version);
    return JSON.stringify({
      ok: true,
      data: r.data,
      warnings: [...r.warnings, ...pkg.warnings],
      provenance: {
        ...pkg.block,
        tool: "fhir_check_completeness",
        toolVersion: toolVersion("fhir_check_completeness"),
        engineVersion: COMPLETENESS_TOOL_VERSION,
        lexiconVersion: LEXICON_VERSION,
        lexiconSha256: LEXICON_SHA256,
        terminologyVersion: await terminologyVersion(deps.terminology),
        sourceSha256: sourceSha256Prefix(args.source_text),
      },
    });
  } catch (e) {
    return failure("fhir_check_completeness", e, args.source_text);
  }
}

// ----------------------------------------------------------------------------------------- fhir_validate_* + grounding

export interface ValidateGroundingArgs {
  source_text?: string | null;
  site_config?: string | null;
  evidence_map?: EvidenceMap | null;
  grounding?: "off" | "auto" | "strict" | null;
  grounding_verbosity?: GroundingVerbosity | null;
  package_id?: string | null;
  version?: string | null;
}

/**
 * fhir_validate_bundle + grounding (spec §2.4). Returns `conformanceText` itself (byte-identical)
 * when grounding is off (no source_text, or grounding="off") or the conformance call failed.
 */
export async function addBundleGrounding(conformanceText: string, bundle: Json, args: ValidateGroundingArgs, deps: GroundingToolDeps): Promise<string> {
  const mode = resolveValidateGrounding(args.grounding, args.source_text, args.evidence_map);
  if (mode === null) return conformanceText;
  let env: Json;
  try {
    env = JSON.parse(conformanceText) as Json;
  } catch {
    return conformanceText;
  }
  if (env.ok !== true || !env.data || typeof env.data !== "object") return conformanceText;
  try {
    const g = await checkGrounding(
      {
        bundle,
        source_text: args.source_text as string,
        site_config: args.site_config ?? null,
        evidence_map: args.evidence_map ?? null,
        mode,
        verbosity: args.grounding_verbosity ?? "warnings",
      },
      { terminology: deps.terminology, logger: deps.logger },
    );
    const merged = mergeGroundingIntoValidation(env.data as ConformanceData, g);
    return JSON.stringify({
      ...env,
      data: merged,
      provenance: {
        ...((env.provenance as Json | null) ?? {}),
        tool: "fhir_validate_bundle",
        toolVersion: toolVersion("fhir_validate_bundle"),
        ...(await groundingFields(deps, args.source_text)),
      },
    });
  } catch (e) {
    return failure("fhir_validate_bundle", e, args.source_text);
  }
}

const RE_ENTRY_PATH = /^(?:Bundle\.)?entry\[/u;

/** Map evidence-map paths written against a lone resource (`code`, `Condition.code`) onto entry 0 of the wrapper Bundle. */
function resourceEvidence(map: EvidenceMap | null | undefined): { mapped: EvidenceMap | null; back: Map<string, string> } {
  const back = new Map<string, string>();
  const to = (p: string): string => {
    const q = RE_ENTRY_PATH.test(p) ? p : `entry[0].${p}`;
    back.set(q, p);
    return q;
  };
  if (!map) return { mapped: null, back };
  if (Array.isArray(map)) return { mapped: map.map((it) => (it && typeof it.path === "string" ? { ...it, path: to(it.path) } : it)), back };
  const out: Record<string, string | string[]> = {};
  for (const [p, q] of Object.entries(map)) out[to(p)] = q;
  return { mapped: out, back };
}

/** Rewrite wrapper-Bundle paths (`Bundle.entry[0].resource.code`) to resource paths (`Condition.code`). */
function resourcePath(path: string, rt: string, back: Map<string, string>): string {
  if (back.has(path)) return back.get(path)!;
  if (path.startsWith("Bundle.entry[0].resource.")) return `${rt}.${path.slice("Bundle.entry[0].resource.".length)}`;
  if (path === "Bundle" || path === "Bundle.entry[0]" || path === "Bundle.entry[0].resource") return rt;
  return path;
}

/**
 * fhir_validate_resource + grounding: the resource is checked as entry 0 of a collection Bundle
 * (references to other resources cannot be followed, so Bundle-context rules see only this one).
 * Issue paths are reported against the resource; the data block gains the same fields as §2.4.
 */
export async function addResourceGrounding(conformanceText: string, resource: Json, args: ValidateGroundingArgs, deps: GroundingToolDeps): Promise<string> {
  const mode = resolveValidateGrounding(args.grounding, args.source_text, args.evidence_map);
  if (mode === null) return conformanceText;
  let env: Json;
  try {
    env = JSON.parse(conformanceText) as Json;
  } catch {
    return conformanceText;
  }
  if (env.ok !== true || !env.data || typeof env.data !== "object") return conformanceText;
  try {
    const rt = String(resource.resourceType ?? "Resource");
    const { mapped, back } = resourceEvidence(args.evidence_map);
    const g: GroundingResult = await checkGrounding(
      {
        bundle: { resourceType: "Bundle", type: "collection", entry: [{ resource }] },
        source_text: args.source_text as string,
        site_config: args.site_config ?? null,
        evidence_map: mapped,
        mode,
        verbosity: args.grounding_verbosity ?? "warnings",
      },
      { terminology: deps.terminology, logger: deps.logger },
    );
    const fix = (i: GroundingIssue): GroundingIssue => ({ ...i, path: resourcePath(i.path, rt, back) });
    const gIssues = [...(g.entries[0]?.issues ?? []), ...g.issues].map(fix);
    const data = env.data as Json;
    const conformanceValid = data.valid === true;
    const merged = {
      ...data,
      valid: conformanceValid && g.valid,
      source: "builtin+grounding",
      issues: [...((data.issues as unknown[]) ?? []), ...gIssues],
      conformanceValid,
      groundingValid: g.valid,
      grounding: g.grounding,
      groundingMode: g.mode,
    };
    return JSON.stringify({
      ...env,
      data: merged,
      provenance: {
        ...((env.provenance as Json | null) ?? {}),
        tool: "fhir_validate_resource",
        toolVersion: toolVersion("fhir_validate_resource"),
        ...(await groundingFields(deps, args.source_text)),
      },
    });
  } catch (e) {
    return failure("fhir_validate_resource", e, args.source_text);
  }
}

// ----------------------------------------------------------------------------------------- tool descriptions

/**
 * MCP tool descriptions (mcp_proposal/reference/check_roles.py). They must classify as V
 * (verification) under CARVE's tool-role rules: no R patterns (search, semantic, keyword,
 * recommend profile, expand value set, skeleton) and no X patterns (status, health, drug,
 * medication, interpret, infer, conflict, create, update, delete). groundingTools.test.ts checks this.
 */
export const TOOL_DESCRIPTIONS = {
  fhir_check_grounding:
    "Deterministic faithfulness check of a Bundle against the source clinical record: every populated clinical fact and code must be " +
    "supported by record text (evidence map or auto-locate), with date/number/unit/identifier/dose/frequency normalisation and section, " +
    "negation and history rules. Returns issues in the fhir_validate_bundle shape. No LLM.",
  fhir_check_completeness:
    "Gap report: compare the facts that the conversion targets require (profile-required plus target-implied elements) with what the " +
    "record states, and return the missing items, the record lines that state absence, a template clarification question and a ready " +
    "insufficient_information object. Deterministic, no LLM.",
  fhir_validate_bundle:
    "Validate a FHIR Bundle in-process: each entry's resource against its meta.profile plus internal reference integrity. Optional " +
    "source_text/site_config/evidence_map add grounding issues (is each value stated in the record). Without package_id the IG " +
    "owning the meta.profile canonicals is used ('|version' pins a version; provenance.resolved_by). Issues may carry ranked " +
    "suggestions [{value, kind, confidence, reason, patch}] (what to change the value to) and, for reference-chain errors, caused_by. " +
    "fullUrl / reference / id errors (UUIDs must be valid, unresolved reference, bdl-7, invalid id) get the deterministic fix as suggestions plus " +
    "a Bundle-level id_map / id_changes; normalize_ids=true applies that normalisation first (fhir_finalize_bundle) and validates the result " +
    "(normalized_bundle, id_changes). Clinical content is never changed.",
  fhir_validate_resource:
    "Validate a FHIR resource against an IG profile, in-process (source:builtin). Pre-flight only. Optional source_text/site_config/" +
    "evidence_map add grounding issues for this resource (is each value stated in the record). Without package_id the IG owning " +
    "its meta.profile is used ('|version' pins a version; provenance.resolved_by). Issues may carry ranked suggestions " +
    "[{value, kind, confidence, reason, patch}] (what to change the value to).",
} as const;
