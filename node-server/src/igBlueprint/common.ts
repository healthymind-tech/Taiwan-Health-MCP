/**
 * Shared contract + helpers of the IG structure tools (ISSUES_v16 R1 / R2):
 * `fhir_get_bundle_blueprint` (blueprint.ts) and `fhir_get_minimal_skeleton` (skeleton.ts).
 *
 * Both are pure over injected deps (tools.ts provides the DB-backed ones, the tests file-backed
 * ones over a local FHIR package cache), and IG-agnostic: everything comes from the
 * StructureDefinition snapshots, the package's ValueSets and the IG's own example instances.
 */

import type { ExpandedCodes, LoadedProfile } from "../authoring/fields.js";

export type { ExpandedCodes, LoadedProfile };

export interface BlueprintDeps {
  /** Resolve + load a profile (throws AuthoringFieldsError IG_NOT_FOUND / ARTIFACT_NOT_FOUND / INVALID_ARGUMENT). */
  loadProfile(profile: string, packageId: string | null, version: string | null): Promise<LoadedProfile>;
  /** StructureDefinition by canonical (|version honoured when present) within the profile's closure; null when not held. */
  fetchStructureDefinition(p: LoadedProfile, url: string): Promise<Record<string, any> | null>;
  /**
   * Example instances of the IG being written for (the requested package; the profile's owning
   * package when the requested one has none of this profile): every standalone example resource
   * plus every entry resource of the example Bundles, each with a `source` label (artifact id,
   * `#<entry index>` for Bundle entries). Only resources declaring `canonical` in meta.profile.
   */
  exampleInstances(p: LoadedProfile, canonical: string): Promise<ExampleInstance[]>;
  /** Expansion of a ValueSet canonical within the profile's closure; null when not held. */
  expandValueSet(p: LoadedProfile, valueSet: string, limit: number): Promise<ExpandedCodes | null>;
}

export interface ExampleInstance {
  source: string;
  resource: Record<string, unknown>;
}

export class BlueprintError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "BlueprintError";
  }
}

/** Size budgets of the whole tool response (characters, non-ASCII counted as \uXXXX escapes). */
export const BLUEPRINT_BUDGET = 4000;
export const SKELETON_BUDGET = 6000;
/** Head-room kept under each budget for a client's own re-serialisation. */
export const RESPONSE_MARGIN = 150;

export function isObject(v: unknown): v is Record<string, any> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

export function stripVersion(url: string): string {
  return String(url ?? "").split("|")[0];
}

/** Last path segment of a canonical (`…/StructureDefinition/Claim-twpas` → `Claim-twpas`). */
export function tail(url: string): string {
  return stripVersion(url).replace(/\/+$/, "").split("/").pop() || String(url);
}

export function clip(s: string, n: number): string {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

export function shortType(code: string): string {
  const parts = String(code ?? "").split(".");
  return parts[parts.length - 1].split("/").pop() || "";
}

export function stripSlices(id: string): string {
  return id.replace(/:[^.]+/g, "");
}

export function parentId(id: string): string | null {
  const i = id.lastIndexOf(".");
  return i >= 0 ? id.slice(0, i) : null;
}

/** `value[x]` + `Quantity` → `valueQuantity`. */
export function choiceProperty(segment: string, typeCode: string): string {
  const stem = segment.endsWith("[x]") ? segment.slice(0, -3) : segment;
  const t = shortType(typeCode);
  return stem + t.slice(0, 1).toUpperCase() + t.slice(1);
}

/** JSON length with every non-ASCII UTF-16 unit counted as its 6-character \uXXXX escape. */
export function escapedLength(v: unknown): number {
  const s = JSON.stringify(v);
  let n = s.length;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0x7e) n += 5;
  return n;
}

/**
 * Characters of the whole tool response `{ok, data: {...data, response_chars}, warnings, provenance}`
 * (fixpoint over the self-referential `response_chars`).
 */
export function measureResponse(data: Record<string, unknown>, warnings: string[], provenance: Record<string, unknown>): number {
  const env = (n: number): unknown => ({ ok: true, data: { ...data, response_chars: n }, warnings, provenance });
  let n = escapedLength(env(0));
  for (let i = 0; i < 4; i++) {
    const next = escapedLength(env(n));
    if (next === n) break;
    n = next;
  }
  return n;
}

/** Canonical base (`https://x/ig/StructureDefinition/`) of a profile URL, or null. */
export function canonicalDir(url: string): string | null {
  const u = stripVersion(url);
  const i = u.lastIndexOf("/StructureDefinition/");
  return i > 0 ? u.slice(0, i + "/StructureDefinition/".length) : null;
}

/**
 * Envelope provenance for the size-budgeted tools: `closure_versions` (which version of each
 * multi-version package the closure uses — up to ~1.5k characters on a large closure) is reduced
 * to `{package: used version}`; everything else is kept.
 */
export function compactProvenance(prov: Record<string, unknown>): Record<string, unknown> {
  const cv = prov.closure_versions;
  if (!isObject(cv)) return prov;
  const used: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(cv)) used[k] = isObject(v) && "used" in v ? v.used : v;
  return { ...prov, closure_versions: used };
}
