/**
 * FHIR reference-context store + Bundle assembly. IG-agnostic.
 *
 * The reference context is a urn allocator: `(context_id, key) → urn:uuid`,
 * process-global, TTL-evicted (fhir_resolve_reference / fhir_finalize_resource).
 * Bundle assembly (fhir_build_bundle) runs the deterministic Bundle finalizer
 * (fhirBundleFinalize.ts): keys become UUID v5 fullUrls, and every reference written
 * as `key`, `urn:uuid:key` or `Type/key` is rewired to the generated fullUrl.
 */

import { randomUUID } from "node:crypto";
import { finalizeBundle, losslessFinalizedBundle, type FinalizeChange, type FinalizeDeps, type FinalizeUnresolved } from "./fhirBundleFinalize.js";

interface Ctx {
  created_at: number;
  touched_at: number;
  map: Record<string, string>;
}

const CONTEXTS: Map<string, Ctx> = new Map();
const CONTEXT_TTL_SECONDS = 3600.0;

/** Monotonic seconds (mirror time.monotonic). */
function now(): number {
  return Number(process.hrtime.bigint()) / 1e9;
}

function sweep(): void {
  const cutoff = now() - CONTEXT_TTL_SECONDS;
  for (const [cid, ctx] of CONTEXTS.entries()) {
    if (ctx.touched_at < cutoff) CONTEXTS.delete(cid);
  }
}

function uuidHex(): string {
  return randomUUID().replace(/-/g, "");
}

export function newContext(): string {
  sweep();
  const contextId = uuidHex();
  CONTEXTS.set(contextId, { created_at: now(), touched_at: now(), map: {} });
  return contextId;
}

function ensure(contextId: string | null | undefined): string {
  sweep();
  if (!contextId || !CONTEXTS.has(contextId)) {
    const cid = contextId || uuidHex();
    CONTEXTS.set(cid, { created_at: now(), touched_at: now(), map: {} });
    return cid;
  }
  CONTEXTS.get(contextId)!.touched_at = now();
  return contextId;
}

/** Return `[context_id, urn]` for `key`, stable per (context_id, key). */
export function mint(contextId: string | null | undefined, key: string): [string, string] {
  const cid = ensure(contextId);
  const cmap = CONTEXTS.get(cid)!.map;
  if (!(key in cmap)) {
    cmap[key] = `urn:uuid:${randomUUID()}`;
  }
  return [cid, cmap[key]];
}

export function getMap(contextId: string | null | undefined): Record<string, string> {
  if (!contextId || !CONTEXTS.has(contextId)) return {};
  CONTEXTS.get(contextId)!.touched_at = now();
  return { ...CONTEXTS.get(contextId)!.map };
}

/** Recursively rewrite `{reference: "<key>"|"<Type>/<key>"}` to minted urn, in place. */
export function rewriteReferences(node: any, keyToUrn: Record<string, string>): void {
  if (node && typeof node === "object" && !Array.isArray(node)) {
    const ref = node.reference;
    if (typeof ref === "string" && !ref.startsWith("urn:uuid:")) {
      let cand = ref;
      if (!(cand in keyToUrn) && cand.includes("/")) {
        cand = cand.split("/").slice(1).join("/");
      }
      if (cand in keyToUrn) {
        node.reference = keyToUrn[cand];
      }
    }
    for (const value of Object.values(node)) {
      rewriteReferences(value, keyToUrn);
    }
  } else if (Array.isArray(node)) {
    for (const item of node) rewriteReferences(item, keyToUrn);
  }
}

export function collectReferences(node: any, out: string[]): void {
  if (node && typeof node === "object" && !Array.isArray(node)) {
    const ref = node.reference;
    if (typeof ref === "string") out.push(ref);
    for (const value of Object.values(node)) collectReferences(value, out);
  } else if (Array.isArray(node)) {
    for (const item of node) collectReferences(item, out);
  }
}

export interface BundleEntryInput {
  resource?: Record<string, any>;
  key?: any;
  fullUrl?: string;
  request?: any;
}

export interface BuiltBundle {
  bundle: Record<string, any>;
  /** key → fullUrl of the entry it names. */
  referenceMap: Record<string, string>;
  unresolved: FinalizeUnresolved[];
  changes: FinalizeChange[];
  notes: string[];
  /** The reference context the keys were recorded in (null when none was given). */
  contextId: string | null;
}

/**
 * Assemble inline resource entries into a FHIR Bundle. A given fullUrl is kept when
 * valid and normalised otherwise (rule fullUrl-uuid); an entry without one gets a
 * deterministic UUID v5 fullUrl (the key is its label); references to a key in any
 * form (`key`, `urn:uuid:key`, `Type/key`) are rewired. With a context_id, keys already
 * minted by fhir_resolve_reference keep their urn and new keys are recorded in it.
 */
export async function buildBundle(
  entries: BundleEntryInput[],
  bundleType = "transaction",
  contextId: string | null | undefined = null,
  deps: FinalizeDeps | null = null,
  /** The `entries` argument as the request wrote it (losslessJson.parseLossless): numbers keep their spelling. */
  losslessEntries: unknown = undefined,
): Promise<BuiltBundle> {
  const cid = contextId ? ensure(contextId) : null;
  const ctxMap = cid ? CONTEXTS.get(cid)!.map : null;
  const aliases = new Map<number, string[]>();
  const keys: Array<string | null> = [];
  const built: Array<Record<string, any>> = [];
  (entries || []).forEach((entry, i) => {
    const resource = entry.resource || {};
    const key = entry.key !== undefined && entry.key !== null ? String(entry.key) : null;
    let fullUrl: unknown = entry.fullUrl;
    if (!fullUrl && key && ctxMap && key in ctxMap) fullUrl = ctxMap[key];
    if (!fullUrl && key) fullUrl = key; // label: the finalizer mints its UUID
    if (key) aliases.set(i, [key]);
    keys.push(key);
    const be: Record<string, any> = {};
    if (fullUrl !== undefined && fullUrl !== null && fullUrl !== "") be.fullUrl = fullUrl;
    be.resource = resource;
    let request = entry.request;
    if (bundleType === "transaction" && !request) {
      request = { method: "POST", url: resource.resourceType || "" };
    }
    if (request) be.request = request;
    built.push(be);
  });
  const fin = await finalizeBundle({ resourceType: "Bundle", type: bundleType, entry: built }, deps, { aliases });
  const referenceMap: Record<string, string> = {};
  keys.forEach((key, i) => {
    const fu = fin.bundle.entry[i]?.fullUrl;
    if (!key || typeof fu !== "string") return;
    referenceMap[key] = fu;
    if (ctxMap) ctxMap[key] = fu;
  });
  const bundle = (Array.isArray(losslessEntries) && losslessFinalizedBundle(fin.bundle, fin.changes, { entry: losslessEntries })) || fin.bundle;
  return { bundle, referenceMap, unresolved: fin.unresolved, changes: fin.changes, notes: fin.notes, contextId: cid };
}
