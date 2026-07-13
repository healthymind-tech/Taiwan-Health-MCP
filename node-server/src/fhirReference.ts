/**
 * FHIR reference-context store + Bundle assembly. IG-agnostic, pure (no DB).
 * Faithful port of `src/fhir_reference.py`. The reference context is a urn
 * allocator: `(context_id, key) → urn:uuid`. Process-global, TTL-evicted.
 */

import { randomUUID } from "node:crypto";

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

/** Assemble inline resource entries into a FHIR Bundle. */
export function buildBundle(
  entries: BundleEntryInput[],
  bundleType = "transaction",
  contextId: string | null | undefined = null,
): { bundle: Record<string, any>; referenceMap: Record<string, string>; unresolved: any[] } {
  const keyToUrn: Record<string, string> = {};
  const prepared: Array<{ resource: Record<string, any>; fullUrl: string; request: any }> = [];

  for (const entry of entries || []) {
    const resource = entry.resource || {};
    const key = entry.key;
    let fullUrl = entry.fullUrl;
    if (!fullUrl) {
      if (key !== undefined && key !== null) {
        [contextId, fullUrl] = mint(contextId, String(key));
      } else {
        fullUrl = `urn:uuid:${randomUUID()}`;
      }
    }
    if (key !== undefined && key !== null) {
      keyToUrn[String(key)] = fullUrl;
    }
    prepared.push({ resource, fullUrl, request: entry.request });
  }

  const fullUrls = new Set(prepared.map((p) => p.fullUrl));

  const bundleEntries: any[] = [];
  const unresolved: any[] = [];
  for (const p of prepared) {
    const resource = p.resource;
    rewriteReferences(resource, keyToUrn);
    const refs: string[] = [];
    collectReferences(resource, refs);
    for (const ref of refs) {
      if (ref.startsWith("urn:uuid:") && !fullUrls.has(ref)) {
        unresolved.push({ resourceType: resource.resourceType, reference: ref });
      }
    }
    const be: Record<string, any> = { fullUrl: p.fullUrl, resource };
    let request = p.request;
    if (bundleType === "transaction" && !request) {
      request = { method: "POST", url: resource.resourceType || "" };
    }
    if (request) be.request = request;
    bundleEntries.push(be);
  }

  const bundle = { resourceType: "Bundle", type: bundleType, entry: bundleEntries };
  return { bundle, referenceMap: keyToUrn, unresolved };
}
