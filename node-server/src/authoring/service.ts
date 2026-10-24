/**
 * Authoring service (workstream C): glues the composer (B) → the profile validator → the context
 * store, and assembles the final Bundle from stored resources.
 *
 * Every collaborator is injected (`AuthoringDeps`) so the service is unit-testable with a fake
 * composer and fake validators; `productionDeps()` adapts FHIRIGService's public, string-returning
 * tool methods (validateResource / finalizeBundle / validateBundle + grounding).
 *
 * Clinical content is never logged — only ids, counts and byte sizes.
 */

import { createHash } from "node:crypto";
import { BUNDLE_TYPES, FINALIZE_UUID_NAMESPACE, bundleRules, uuidV5, type FinalizeChange, type FinalizeUnresolved } from "../fhirBundleFinalize.js";
import type { FHIRIGService } from "../fhirIgService.js";
import { addBundleGrounding, type GroundingToolDeps } from "../groundingTools.js";
import { logDebug, logError } from "../logger.js";
import { hasRaw, parseLossless, toPlain } from "../losslessJson.js";
import { nodeAt } from "../fhirSuggestions/util.js";
import { fitDate, parseDateValue } from "./values.js";
import { ContextExpiredError, type ContextEntry, type ContextRecord, type ContextStorageKind, type ContextStore } from "./contextStore.js";
import type { AuthorInput, AuthorIssue, AuthorResult, AuthorStatus, IssueSeverity, Provenance } from "./types.js";

// --------------------------------------------------------------------------- //
// Collaborator contracts
// --------------------------------------------------------------------------- //

/** What `composeResource` (B) returns; adapted here so the service does not depend on B's deps type. */
export interface ComposeOutput {
  resource: Record<string, unknown>;
  provenance: Record<string, Provenance>;
  missing: Array<{ field: string; why: string }>;
  refs: { resolved: string[]; pending: string[] };
  /** FHIR path (with or without the resource-type prefix, indexes optional) → model field name. */
  fieldMap: Record<string, string>;
  /** Problems with the given values (a conflict with a fixed value, an unparseable date …). */
  errors: Array<{ field: string | null; path?: string; message: string; severity?: IssueSeverity }>;
}

export interface ComposeContext {
  contextId: string;
  /** Keys already in the context (resolved references) — the batch's own keys included. */
  knownKeys: string[];
  /** UTC offset (e.g. "+08:00") completing times given without one — a facility setting, never guessed. */
  timezone?: string | null;
}

export type Composer = (input: AuthorInput, ctx: ComposeContext) => Promise<ComposeOutput>;

/** The parsed `fhir_validate_resource` / `fhir_validate_bundle` data block. */
export interface ValidationData {
  valid: boolean;
  issues: Array<Record<string, unknown>>;
  profile?: string | null;
  checked_fully?: boolean;
  [k: string]: unknown;
}

export interface ToolEnvelope<T> {
  ok: boolean;
  data: T | null;
  warnings?: unknown[];
  provenance?: Record<string, unknown> | null;
  error?: { code: string; message: string; [k: string]: unknown };
}

export interface FinalizeData {
  bundle: Record<string, unknown>;
  changes: FinalizeChange[];
  unresolved: FinalizeUnresolved[];
  notes: string[];
  id_map?: Record<string, string>;
}

export interface AuthoringDeps {
  store: ContextStore;
  compose: Composer;
  /** `(contextId, key) → urn:uuid:…` — B's mapping; the Bundle's fullUrls use the same one. */
  keyToUrn: (contextId: string, key: string) => string;
  validate: (resource: Record<string, unknown>, profile: string, packageId: string | null, version: string | null) => Promise<ToolEnvelope<ValidationData>>;
  finalizeBundle: (
    bundle: Record<string, unknown>,
    opts: { packageId: string | null; version: string | null; bundleProfile: string | null; bundleType: string },
  ) => Promise<ToolEnvelope<FinalizeData>>;
  validateBundle: (bundle: Record<string, unknown>, opts: { packageId: string | null; version: string | null; sourceText: string | null }) => Promise<ToolEnvelope<ValidationData>>;
  /** Fields a document's Composition needs when none was authored (R3: reported, never invented). */
  compositionRequirements?: (opts: { bundleProfile: string | null; packageId: string | null; version: string | null }) => Promise<{ profile: string; fields: Array<{ field: string; why: string }> }>;
  now?: () => number;
}

// --------------------------------------------------------------------------- //
// Results
// --------------------------------------------------------------------------- //

export interface AuthorBatchResult {
  context_id: string;
  storage: ContextStorageKind;
  results: AuthorResult[];
  summary: { total: number; valid: number; invalid: number; refs_pending: number; pending_keys: string[] };
  warnings: string[];
}

export interface RefusedItem {
  key: string;
  field: string | null;
  reason: string;
  ref_key?: string;
}

export type AssembleRefusal =
  | { code: "KEY_NOT_FOUND"; refused: RefusedItem[] }
  | { code: "UNRESOLVED_REFERENCE"; refused: RefusedItem[] }
  | { code: "INVALID_RESOURCE"; refused: RefusedItem[] }
  | { code: "MISSING_COMPOSITION"; refused: RefusedItem[]; missing: { resourceType: "Composition"; profile: string | null; fields: Array<{ field: string; why: string }> } };

export interface AssembleBundleResult {
  context_id: string;
  storage: ContextStorageKind;
  bundle: Record<string, unknown>;
  /** Entry order of the final Bundle: key per entry. */
  keys: string[];
  validation: ValidationData & { issues: Array<Record<string, unknown> & { key?: string | null; field?: string | null }> };
  changes: FinalizeChange[];
  unresolved: FinalizeUnresolved[];
  notes: string[];
  /** Keys assembled although their stored status is invalid (allow_invalid). */
  included_invalid: string[];
  warnings: string[];
  provenance: Record<string, unknown> | null;
}

export class AssembleRefusedError extends Error {
  readonly refusal: AssembleRefusal;
  constructor(refusal: AssembleRefusal) {
    super(`assembly refused: ${refusal.code}`);
    this.name = "AssembleRefusedError";
    this.refusal = refusal;
  }
}

export class AuthoringArgumentError extends Error {
  readonly code = "INVALID_ARGUMENT";
  readonly extra: Record<string, unknown>;
  constructor(message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.name = "AuthoringArgumentError";
    this.extra = extra;
  }
}

export const MAX_BATCH = 50;
export const MAX_KEY_LENGTH = 128;

// --------------------------------------------------------------------------- //
// Helpers
// --------------------------------------------------------------------------- //

/**
 * Default key → urn mapping (UUID v5 over the finalizer namespace, seeded by context id + key).
 * B's `keyToUrn` replaces it at integration; any deterministic, context-scoped function satisfies
 * the contract as long as the composer and the assembler share it.
 */
export function defaultKeyToUrn(contextId: string, key: string): string {
  return `urn:uuid:${uuidV5(FINALIZE_UUID_NAMESPACE, `authoring\u0000${contextId}\u0000${key}`)}`;
}

function sizeOf(v: unknown): number {
  return JSON.stringify(v).length;
}

function stripIndexes(p: string): string {
  return p.replace(/\[\d+\]/g, "");
}

function stripType(p: string, resourceType: string | null): string {
  if (resourceType && p.startsWith(`${resourceType}.`)) return p.slice(resourceType.length + 1);
  if (p === resourceType) return "";
  return p;
}

/**
 * Model field for a validator path, through the composer's field map (R7). Exact path first,
 * then without indexes, then each ancestor; finally the first segment when it is an input field.
 */
export function fieldForPath(path: string, fieldMap: Record<string, string>, inputFields: Record<string, unknown>, resourceType: string | null): string | null {
  const rel = stripType(path, resourceType);
  if (!rel) return null;
  const map = new Map<string, string>();
  for (const [k, v] of Object.entries(fieldMap)) {
    map.set(k, v);
    map.set(stripType(k, resourceType), v);
    map.set(stripIndexes(stripType(k, resourceType)), v);
  }
  const candidates: string[] = [];
  let cur = rel;
  while (cur) {
    candidates.push(cur, stripIndexes(cur));
    const i = cur.lastIndexOf(".");
    cur = i > 0 ? cur.slice(0, i) : "";
  }
  for (const c of candidates) {
    const hit = map.get(c);
    if (hit) return hit;
  }
  // Last resort: the input field whose first segment names the path's first element (slice names `identifier:mrn` included).
  const head = stripIndexes(rel.split(".")[0]).split(":")[0];
  if (head in inputFields) return head;
  for (const f of Object.keys(inputFields)) if (stripIndexes(f.split(".")[0]).split(":")[0] === head) return f;
  return null;
}

/** Reference strings found anywhere in a resource (for the "which field references key X" lookup). */
function fieldsReferencing(input: AuthorInput, refKey: string): string[] {
  const out: string[] = [];
  const walk = (v: unknown): boolean => {
    if (Array.isArray(v)) return v.some(walk);
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (o.ref === refKey) return true;
      return Object.values(o).some(walk);
    }
    return false;
  };
  for (const [field, value] of Object.entries(input.fields || {})) if (walk(value)) out.push(field);
  return out;
}

/** True when the issue is only about a reference whose target lives in the context (checked again at assembly). */
function aboutContextReference(issue: Record<string, unknown>, resource: Record<string, unknown>, urns: Set<string>): boolean {
  if (!urns.size) return false;
  const msg = String(issue.message ?? "");
  for (const u of urns) if (msg.includes(u)) return true;
  const path = String(issue.path ?? "");
  if (!path) return false;
  try {
    const node = nodeAt(resource, path) as unknown;
    const ref = node && typeof node === "object" ? (node as Record<string, unknown>).reference : node;
    return typeof ref === "string" && urns.has(ref);
  } catch {
    return false;
  }
}

function severityOf(v: unknown): IssueSeverity {
  return v === "fatal" || v === "error" || v === "warning" ? v : "information";
}

function statusFrom(issues: AuthorIssue[], pending: string[]): AuthorStatus {
  if (issues.some((i) => i.severity === "error" || i.severity === "fatal")) return "invalid";
  return pending.length ? "refs_pending" : "valid";
}

function mergeFields(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k]; // null = remove this field
    else out[k] = v;
  }
  return out;
}

// --------------------------------------------------------------------------- //
// Service
// --------------------------------------------------------------------------- //

export interface AuthorOptions {
  /** Create a new context when `contextId` is undefined (always true for the tool). */
  create?: boolean;
  /** UTC offset for times without one; remembered on the context for later calls (merge) of the task. */
  timezone?: string | null;
}

export interface AssembleOptions {
  bundleProfile?: string | null;
  packageId?: string | null;
  version?: string | null;
  sourceText?: string | null;
  allowInvalid?: boolean;
  /** Bundle.identifier from the record / facility (a document needs one, bdl-9); never invented. */
  identifier?: { system?: string | null; value?: string | null } | null;
  /** Bundle.timestamp (instant; a document needs one, bdl-10) in the value grammar's date forms; never invented. */
  timestamp?: string | null;
}

export class AuthoringService {
  private readonly deps: AuthoringDeps;

  constructor(deps: AuthoringDeps) {
    this.deps = deps;
  }

  get store(): ContextStore {
    return this.deps.store;
  }

  // ---- fhir_author_resources ---------------------------------------------- //

  async authorResources(contextId: string | undefined | null, inputs: AuthorInput[], opts: AuthorOptions = {}): Promise<AuthorBatchResult> {
    this.checkBatch(inputs);
    const warnings: string[] = [];
    let cid: string;
    let ctx: ContextRecord;
    if (contextId) {
      cid = contextId;
      ctx = await this.deps.store.get(cid); // throws ContextExpiredError
    } else {
      if (opts.create === false) throw new AuthoringArgumentError("context_id is required");
      cid = await this.deps.store.create();
      ctx = await this.deps.store.get(cid);
    }
    const storage = this.deps.store.kind;
    if (storage === "memory") warnings.push("storage is in-process memory (Redis unavailable): the context is lost when the server restarts — finish the task promptly");

    const t0 = performance.now();
    const batchKeys = inputs.map((i) => i.key);
    const knownKeys = [...new Set([...Object.keys(ctx.entries), ...batchKeys])];
    const timezone = opts.timezone ?? ctx.timezone ?? null;
    // Compose + validate every input concurrently (independent; the store write is one atomic batch).
    const entries = await Promise.all(inputs.map((input) => this.authorOne(cid, ctx, input, knownKeys, timezone, warnings)));
    await this.deps.store.update(cid, (c) => {
      for (const e of entries) c.entries[e.key] = e;
      if (opts.timezone) c.timezone = opts.timezone;
    });
    const results = entries.map((e) => toResult(e));
    const pending = [...new Set(entries.flatMap((e) => e.refs.pending))].sort();
    logDebug("authoring: batch stored", {
      contextId: cid,
      storage,
      count: entries.length,
      bytes: entries.reduce((n, e) => n + sizeOf(e.resource), 0),
      ms: Math.round(performance.now() - t0),
    });
    return {
      context_id: cid,
      storage,
      results,
      summary: {
        total: results.length,
        valid: results.filter((r) => r.status === "valid").length,
        invalid: results.filter((r) => r.status === "invalid").length,
        refs_pending: results.filter((r) => r.status === "refs_pending").length,
        pending_keys: pending,
      },
      warnings,
    };
  }

  private checkBatch(inputs: AuthorInput[]): void {
    if (!Array.isArray(inputs) || !inputs.length) throw new AuthoringArgumentError("resources must be a non-empty array of {key, profile, fields}");
    if (inputs.length > MAX_BATCH) throw new AuthoringArgumentError(`at most ${MAX_BATCH} resources per call (got ${inputs.length})`, { max: MAX_BATCH });
    const seen = new Set<string>();
    for (const [i, inp] of inputs.entries()) {
      if (!inp || typeof inp !== "object") throw new AuthoringArgumentError(`resources[${i}] must be an object`);
      if (typeof inp.key !== "string" || !inp.key.trim()) throw new AuthoringArgumentError(`resources[${i}].key is required (a label unique within the context, e.g. "patient-1")`);
      if (inp.key.length > MAX_KEY_LENGTH) throw new AuthoringArgumentError(`resources[${i}].key is longer than ${MAX_KEY_LENGTH} characters`);
      if (seen.has(inp.key)) throw new AuthoringArgumentError(`duplicate key "${inp.key}" in the same call`, { key: inp.key });
      seen.add(inp.key);
      if (!inp.merge && (typeof inp.profile !== "string" || !inp.profile.trim())) throw new AuthoringArgumentError(`resources[${i}].profile is required (profile id or canonical URL)`, { key: inp.key });
      if (inp.fields !== undefined && (inp.fields === null || typeof inp.fields !== "object" || Array.isArray(inp.fields))) {
        throw new AuthoringArgumentError(`resources[${i}].fields must be an object of field → value`, { key: inp.key });
      }
    }
  }

  private async authorOne(cid: string, ctx: ContextRecord, given: AuthorInput, knownKeys: string[], timezone: string | null, warnings: string[]): Promise<ContextEntry> {
    const prev = ctx.entries[given.key];
    let input: AuthorInput;
    if (given.merge) {
      if (prev) {
        input = {
          key: given.key,
          profile: given.profile?.trim() || prev.input.profile,
          package_id: given.package_id ?? prev.input.package_id,
          version: given.version ?? prev.input.version,
          fields: mergeFields(prev.input.fields || {}, given.fields || {}),
        };
      } else {
        if (!given.profile?.trim()) {
          return this.failedEntry(given, [{ field: null, path: "", message: `merge requested but key "${given.key}" is not in the context and no profile was given`, severity: "fatal" }]);
        }
        warnings.push(`key "${given.key}": merge requested but nothing stored yet — created`);
        input = { key: given.key, profile: given.profile.trim(), package_id: given.package_id, version: given.version, fields: { ...(given.fields || {}) } };
      }
    } else {
      input = { key: given.key, profile: given.profile.trim(), package_id: given.package_id, version: given.version, fields: { ...(given.fields || {}) } };
    }

    let composed: ComposeOutput;
    try {
      composed = await this.deps.compose(input, { contextId: cid, knownKeys, timezone });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // The message may quote a field value: log the error class only.
      logError("authoring: compose failed", { contextId: cid, error: e instanceof Error ? e.name : "Error", bytes: msg.length });
      return this.failedEntry(input, [{ field: null, path: "", message: `could not compose the resource: ${msg.slice(0, 300)}`, severity: "fatal" }]);
    }
    const resource = composed.resource || {};
    const resourceType = typeof resource.resourceType === "string" ? resource.resourceType : null;
    const issues: AuthorIssue[] = composed.errors.map((e) => ({
      key: input.key,
      field: e.field ?? (e.path ? fieldForPath(e.path, composed.fieldMap, input.fields, resourceType) : null),
      path: e.path ?? "",
      severity: e.severity ?? "error",
      message: e.message,
    }));

    // Validate against the profile; the suggestion layer rides along in each issue's `suggestions`.
    const packageId = input.package_id ?? null;
    const version = input.version ?? null;
    let env: ToolEnvelope<ValidationData>;
    try {
      env = await this.deps.validate(resource, input.profile, packageId, version);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logError("authoring: validation failed", { contextId: cid, error: e instanceof Error ? e.name : "Error", bytes: msg.length });
      env = { ok: false, data: null, error: { code: "VALIDATION_FAILED", message: msg.slice(0, 300) } };
    }
    const urns = new Set([...composed.refs.resolved, ...composed.refs.pending].map((k) => this.deps.keyToUrn(cid, k)));
    if (env.ok && env.data) {
      for (const raw of env.data.issues || []) {
        if (aboutContextReference(raw, resource, urns)) continue;
        issues.push({
          key: input.key,
          field: fieldForPath(String(raw.path ?? ""), composed.fieldMap, input.fields, resourceType),
          path: String(raw.path ?? ""),
          severity: severityOf(raw.severity),
          message: String(raw.message ?? ""),
          ...(Array.isArray(raw.suggestions) ? { suggestions: raw.suggestions } : {}),
          ...(raw.code !== undefined ? { code: raw.code } : {}),
        } as AuthorIssue);
      }
      if (env.data.checked_fully === false) warnings.push(`key "${input.key}": validation was not complete (checked_fully=false) — see the validator's profiles_unchecked / valuesets_unchecked`);
    } else {
      const err = env.error ?? { code: "VALIDATION_FAILED", message: "validation returned no result" };
      issues.push({ key: input.key, field: null, path: "", severity: "fatal", message: `${err.code}: ${err.message}`, ...(err.hint ? { hint: err.hint } : {}) } as AuthorIssue);
    }
    const pending = [...composed.refs.pending].sort();
    return {
      key: input.key,
      input,
      resource,
      status: statusFrom(issues, pending),
      provenance: composed.provenance || {},
      missing: composed.missing || [],
      refs: { resolved: [...composed.refs.resolved].sort(), pending },
      issues,
      fieldMap: composed.fieldMap || {},
      updated_at: new Date((this.deps.now ?? Date.now)()).toISOString(),
    };
  }

  private failedEntry(input: AuthorInput, errors: Array<{ field: string | null; path: string; message: string; severity: IssueSeverity }>): ContextEntry {
    return {
      key: input.key,
      input: { key: input.key, profile: input.profile ?? "", package_id: input.package_id, version: input.version, fields: { ...(input.fields || {}) } },
      resource: {},
      status: "invalid",
      provenance: {},
      missing: [],
      refs: { resolved: [], pending: [] },
      issues: errors.map((e) => ({ key: input.key, ...e })),
      fieldMap: {},
      updated_at: new Date((this.deps.now ?? Date.now)()).toISOString(),
    };
  }

  // ---- fhir_context -------------------------------------------------------- //

  async getEntry(contextId: string, key: string): Promise<AuthorResult | null> {
    const ctx = await this.deps.store.get(contextId);
    const e = ctx.entries[key];
    return e ? toResult(e, ctx) : null;
  }

  async listEntries(contextId: string): Promise<Array<{ key: string; resourceType: string | null; profile: string; status: AuthorStatus; refs: ContextEntry["refs"]; missing: number; errors: number; warnings: number; updated_at: string }>> {
    const ctx = await this.deps.store.get(contextId);
    return Object.values(ctx.entries).map((e) => ({
      key: e.key,
      resourceType: typeof e.resource.resourceType === "string" ? e.resource.resourceType : null,
      profile: e.input.profile,
      status: toResult(e, ctx).status,
      refs: toResult(e, ctx).refs,
      missing: e.missing.length,
      errors: e.issues.filter((i) => i.severity === "error" || i.severity === "fatal").length,
      warnings: e.issues.filter((i) => i.severity === "warning").length,
      updated_at: e.updated_at,
    }));
  }

  async deleteEntry(contextId: string, key: string): Promise<boolean> {
    let existed = false;
    await this.deps.store.update(contextId, (ctx) => {
      existed = key in ctx.entries;
      delete ctx.entries[key];
    });
    return existed;
  }

  async deleteContext(contextId: string): Promise<boolean> {
    return this.deps.store.delete(contextId);
  }

  // ---- fhir_assemble_bundle ------------------------------------------------ //

  async assembleBundle(contextId: string, keys: string[], bundleType: string, opts: AssembleOptions = {}): Promise<AssembleBundleResult> {
    if (!Array.isArray(keys) || !keys.length) throw new AuthoringArgumentError("keys must be a non-empty array of context keys, in the entry order you want");
    if (!(BUNDLE_TYPES as readonly string[]).includes(bundleType)) {
      throw new AuthoringArgumentError(`bundle_type must be one of ${BUNDLE_TYPES.join(" | ")}`, { parameter: "bundle_type", allowed: [...BUNDLE_TYPES] });
    }
    const dup = keys.find((k, i) => keys.indexOf(k) !== i);
    if (dup !== undefined) throw new AuthoringArgumentError(`duplicate key "${dup}" in keys`, { key: dup });
    const ctx = await this.deps.store.get(contextId); // throws ContextExpiredError
    const storage = this.deps.store.kind;
    const warnings: string[] = [];
    const t0 = performance.now();

    // 1. Every key must be stored.
    const notFound = keys.filter((k) => !(k in ctx.entries));
    if (notFound.length) {
      throw new AssembleRefusedError({ code: "KEY_NOT_FOUND", refused: notFound.map((k) => ({ key: k, field: null, reason: `key "${k}" is not in context ${contextId} (fhir_context action=list shows the stored keys)` })) });
    }
    const entries = keys.map((k) => ctx.entries[k]);

    // 2. Every reference must point at a key in the list (R6: never guessed, never dropped).
    const inList = new Set(keys);
    const unresolved: RefusedItem[] = [];
    for (const e of entries) {
      for (const refKey of [...e.refs.resolved, ...e.refs.pending]) {
        if (inList.has(refKey)) continue;
        const fields = fieldsReferencing(e.input, refKey);
        const where = refKey in ctx.entries ? "is in the context but not in keys — add it to keys" : "is not in the context — author it first (fhir_author_resources) or change the field";
        if (!fields.length) unresolved.push({ key: e.key, field: null, ref_key: refKey, reason: `references key "${refKey}", which ${where}` });
        for (const f of fields) unresolved.push({ key: e.key, field: f, ref_key: refKey, reason: `${f} references key "${refKey}", which ${where}` });
      }
    }
    if (unresolved.length) throw new AssembleRefusedError({ code: "UNRESOLVED_REFERENCE", refused: unresolved });

    // 3. Invalid resources are refused unless allow_invalid.
    const invalid = entries.filter((e) => e.status === "invalid");
    if (invalid.length && !opts.allowInvalid) {
      const refused: RefusedItem[] = [];
      for (const e of invalid) {
        const errs = e.issues.filter((i) => i.severity === "error" || i.severity === "fatal");
        if (!errs.length) refused.push({ key: e.key, field: null, reason: "stored status is invalid" });
        const seen = new Set<string>();
        for (const i of errs) {
          const tag = `${i.field}|${i.message}`;
          if (seen.has(tag)) continue;
          seen.add(tag);
          refused.push({ key: e.key, field: i.field, reason: i.message });
        }
      }
      throw new AssembleRefusedError({ code: "INVALID_RESOURCE", refused });
    }
    if (invalid.length) warnings.push(`assembled with ${invalid.length} invalid resource(s) (allow_invalid=true): ${invalid.map((e) => e.key).join(", ")}`);

    // 4. document: a Composition must have been authored — never invented (R3).
    if (bundleType === "document" && !entries.some((e) => e.resource.resourceType === "Composition")) {
      let req: { profile: string | null; fields: Array<{ field: string; why: string }> } = { profile: null, fields: [] };
      if (this.deps.compositionRequirements) {
        try {
          req = await this.deps.compositionRequirements({ bundleProfile: opts.bundleProfile ?? null, packageId: opts.packageId ?? null, version: opts.version ?? null });
        } catch (e) {
          logError("authoring: composition requirements lookup failed", { error: e instanceof Error ? e.name : "Error" });
        }
      }
      throw new AssembleRefusedError({
        code: "MISSING_COMPOSITION",
        refused: [{ key: "Composition", field: null, reason: "a document Bundle needs a Composition as its first entry; none of the given keys is a Composition" }],
        missing: { resourceType: "Composition", profile: req.profile, fields: req.fields },
      });
    }

    // 5. Build: fullUrl = keyToUrn(contextId, key) — the same urn the composer wrote into references.
    const urnToKey = new Map<string, string>();
    const entryList = entries.map((e) => {
      const fullUrl = this.deps.keyToUrn(contextId, e.key);
      urnToKey.set(fullUrl, e.key);
      const be: Record<string, unknown> = { fullUrl, resource: e.resource };
      if (bundleType === "transaction" || bundleType === "batch") be.request = { method: "POST", url: String(e.resource.resourceType ?? "") };
      return be;
    });
    const draft: Record<string, unknown> = { resourceType: "Bundle" };
    if (opts.identifier && (opts.identifier.value || opts.identifier.system)) {
      if (!opts.identifier.value) throw new AuthoringArgumentError("identifier needs a value (and a system for a document Bundle)", { parameter: "identifier" });
      draft.identifier = { ...(opts.identifier.system ? { system: opts.identifier.system } : {}), value: opts.identifier.value };
    }
    draft.type = bundleType;
    if (opts.timestamp) {
      const parsed = parseDateValue(opts.timestamp);
      const fit = parsed.ok ? fitDate(parsed.value, "instant", ctx.timezone ?? null) : parsed;
      if (!fit.ok) throw new AuthoringArgumentError(`timestamp: ${fit.message}`, { parameter: "timestamp" });
      draft.timestamp = fit.value;
    }
    draft.entry = entryList;

    // 6. Finalize (deterministic ids / references / document order / profile-fixed type) + validate (+ grounding).
    const packageId = opts.packageId ?? null;
    const version = opts.version ?? null;
    const fin = await this.deps.finalizeBundle(draft, { packageId, version, bundleProfile: opts.bundleProfile ?? null, bundleType });
    if (!fin.ok || !fin.data) throw new AuthoringArgumentError(`${fin.error?.code ?? "FINALIZE_FAILED"}: ${fin.error?.message ?? "finalize returned no result"}`, { ...(fin.error ?? {}) });
    const bundle = fin.data.bundle;
    for (const w of fin.warnings ?? []) if (typeof w === "string") warnings.push(w);
    const val = await this.deps.validateBundle(bundle, { packageId, version, sourceText: opts.sourceText ?? null });
    if (!val.ok || !val.data) throw new AuthoringArgumentError(`${val.error?.code ?? "VALIDATION_FAILED"}: ${val.error?.message ?? "validation returned no result"}`, { ...(val.error ?? {}) });
    for (const w of val.warnings ?? []) if (typeof w === "string") warnings.push(w);

    // 7. Every Bundle issue carries the key + model field of the entry it is about (R7).
    // fhir_validate_bundle splits issues into Bundle-level `issues` + per-entry `entries[i].issues`;
    // the model gets one flat list, every item tagged with the entry's key and model field.
    const orderedKeys = (Array.isArray(bundle.entry) ? (bundle.entry as Array<Record<string, unknown>>) : []).map((be) => urnToKey.get(String(be.fullUrl ?? "")) ?? null);
    const tag = (raw: Record<string, unknown>): Record<string, unknown> & { key: string | null; field: string | null } => {
      const path = String(raw.path ?? "");
      const m = /^Bundle\.entry\[(\d+)\](?:\.resource(?:\.(.*))?)?$/.exec(path);
      if (!m) return { ...raw, key: null, field: null };
      const key = orderedKeys[Number(m[1])] ?? null;
      const e = key ? ctx.entries[key] : undefined;
      const rt = e && typeof e.resource.resourceType === "string" ? e.resource.resourceType : null;
      const field = e && m[2] ? fieldForPath(`${rt ?? ""}.${m[2]}`, e.fieldMap, e.input.fields, rt) : null;
      return { ...raw, key, field };
    };
    const entryRows = Array.isArray(val.data.entries) ? (val.data.entries as Array<Record<string, unknown>>) : [];
    const issues = [...(val.data.issues || []).map(tag), ...entryRows.flatMap((row) => (Array.isArray(row.issues) ? (row.issues as Array<Record<string, unknown>>).map(tag) : []))];
    const entryResults = entryRows.map((row, i) => ({ key: orderedKeys[i] ?? null, ...row, issues: Array.isArray(row.issues) ? (row.issues as Array<Record<string, unknown>>).map(tag) : [] }));
    logDebug("authoring: bundle assembled", {
      contextId,
      entries: entryList.length,
      bytes: sizeOf(bundle),
      issues: issues.length,
      changes: fin.data.changes.length,
      sourceSha256: opts.sourceText ? createHash("sha256").update(opts.sourceText).digest("hex").slice(0, 16) : null,
      ms: Math.round(performance.now() - t0),
    });
    await this.deps.store.touch(contextId).catch(() => undefined);
    return {
      context_id: contextId,
      storage,
      bundle,
      keys: orderedKeys.map((k) => k ?? ""),
      validation: { ...val.data, issues, ...(entryRows.length ? { entries: entryResults } : {}) },
      changes: fin.data.changes,
      unresolved: fin.data.unresolved,
      notes: fin.data.notes,
      included_invalid: invalid.map((e) => e.key),
      warnings,
      provenance: val.provenance ?? fin.provenance ?? null,
    };
  }
}

/**
 * The stored entry as the model sees it. A key that was pending when the entry was composed
 * but has been authored since counts as resolved (the stored resource already carries its urn),
 * so `refs_pending` clears without re-authoring the referencing resource.
 */
export function toResult(e: ContextEntry, ctx?: ContextRecord): AuthorResult {
  let refs = e.refs;
  let status = e.status;
  if (ctx && e.refs.pending.length) {
    const stillPending = e.refs.pending.filter((k) => !(k in ctx.entries));
    if (stillPending.length !== e.refs.pending.length) {
      refs = { resolved: [...new Set([...e.refs.resolved, ...e.refs.pending.filter((k) => k in ctx.entries)])].sort(), pending: stillPending };
      if (status === "refs_pending" && !stillPending.length) status = "valid";
    }
  }
  return { key: e.key, status, resource: e.resource, provenance: e.provenance, missing: e.missing, refs, issues: e.issues };
}

export { ContextExpiredError };

// --------------------------------------------------------------------------- //
// Production adapter
// --------------------------------------------------------------------------- //

function parseEnvelope<T>(text: string): ToolEnvelope<T> {
  return JSON.parse(text) as ToolEnvelope<T>;
}

/**
 * Collaborators backed by FHIRIGService's public tool methods (validate / finalize / validate
 * bundle with the suggestion layer, grounding through groundingTools when source_text is given).
 * `compose` and `keyToUrn` come from B's compose module (index.ts wires them in).
 */
export function productionDeps(
  svc: FHIRIGService,
  store: ContextStore,
  compose: Composer,
  grounding: GroundingToolDeps,
  keyToUrn: (contextId: string, key: string) => string = defaultKeyToUrn,
): AuthoringDeps {
  return {
    store,
    compose,
    keyToUrn,
    // Composed resources may hold RawNumber spellings (losslessJson): the validator and the
    // finalizer run on the plain tree; the finalizer restores the spellings into the Bundle it
    // returns (parsed losslessly here), so the assembled Bundle keeps every number as written.
    validate: async (resource, profile, packageId, version) =>
      parseEnvelope<ValidationData>(await svc.validateResource(toPlain(resource) as Record<string, any>, profile, packageId, version)),
    finalizeBundle: async (bundle, o) => {
      const raw = hasRaw(bundle);
      const text = await svc.finalizeBundle(toPlain(bundle) as Record<string, any>, o.packageId, o.version, o.bundleProfile, { bundleType: o.bundleType, lossless: raw ? bundle : undefined });
      return (raw ? parseLossless(text) : JSON.parse(text)) as ToolEnvelope<FinalizeData>;
    },
    validateBundle: async (bundle, o) => {
      const plain = toPlain(bundle) as Record<string, unknown>;
      const text = await svc.validateBundle(plain as Record<string, any>, o.packageId, o.version, false);
      if (!o.sourceText) return parseEnvelope<ValidationData>(text);
      return parseEnvelope<ValidationData>(await addBundleGrounding(text, plain, { source_text: o.sourceText, package_id: o.packageId, version: o.version }, grounding));
    },
    compositionRequirements: async ({ bundleProfile, packageId, version }) => compositionRequirementsOf(svc, bundleProfile, packageId, version),
  };
}

/**
 * Fields the document's Composition needs: the Composition profile the Bundle profile's required
 * `composition` entry slice names (else core Composition), read through the required-elements engine.
 */
async function compositionRequirementsOf(svc: FHIRIGService, bundleProfile: string | null, packageId: string | null, version: string | null): Promise<{ profile: string; fields: Array<{ field: string; why: string }> }> {
  let profile = "http://hl7.org/fhir/StructureDefinition/Composition";
  if (bundleProfile) {
    try {
      // A profile id (Bundle-twcore) → its canonical, which is what the finalizer's resolver fetches by.
      let canonical = bundleProfile;
      if (!bundleProfile.includes("/") && !bundleProfile.includes(":")) {
        const prof = parseEnvelope<{ canonical?: string | null }>(await svc.getProfile(bundleProfile, packageId, version));
        if (prof.ok && prof.data?.canonical) canonical = prof.data.canonical;
      }
      const { deps } = await svc.bundleFinalizeDeps(null, canonical);
      const sd = deps ? await deps.fetchStructureDefinition(canonical) : null;
      for (const re of bundleRules(sd).required_entries) {
        if (!re.profile) continue;
        const target = deps ? await deps.fetchStructureDefinition(re.profile) : null;
        if ((target && target.type === "Composition") || /composition/i.test(re.slice)) {
          profile = re.profile;
          break;
        }
      }
    } catch {
      // fall through to the core Composition
    }
  }
  const env = parseEnvelope<{ elements?: Array<Record<string, unknown>> }>(await svc.getProfileRequiredElements(profile, packageId, version, null, true, false, "compact"));
  const fields: Array<{ field: string; why: string }> = [];
  for (const row of env.data?.elements ?? []) {
    const id = String(row.id ?? "");
    if (!id.startsWith("Composition.") || row.optional === true || row.value !== undefined || row.grounding_class === "auto") continue;
    const field = id.slice("Composition.".length);
    if (fields.some((f) => field.startsWith(`${f.field}.`))) continue; // children of a listed element
    fields.push({ field, why: `required by ${String(row.required_by ?? "profile")}` });
  }
  return { profile, fields };
}
