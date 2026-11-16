/**
 * FHIR terminology resolver — DB layer. ValueSet expansion / membership and
 * code lookup over the IG packages held in `fhir.*` plus the SNOMED / LOINC /
 * ICD tables. The rule logic (nested CodeSystem hierarchies, filters,
 * membership) lives in the pure `fhirCodeSystem.ts`; this module only supplies
 * DB-backed `TerminologyDeps`. Honesty contract: when a system cannot be
 * resolved from data we hold, say so (`unresolved` / `found:null` /
 * membership `undefined`) — never fabricate a display or a verdict.
 */

import { createHash } from "node:crypto";
import { envBudgetBytes, estimateBytes, estimateBytesAsync, trackCache } from "./memSize.js";
import { txDisplays } from "./txCodeTables.js";
import { query } from "./db.js";
import { Slicer, codeSystemConceptRows, codeSystemHead } from "./csRows.js";
import { oneAtATime } from "./toolConcurrency.js";
import { pickCanonicalVersion } from "./fhirValidator.js";
import { languageTagParts, terminologyServerKnows } from "./fhirSpecialSystems.js";
import type { PackageRow } from "./fhirIg.js";
import {
  type CodeSystemIndex,
  type ComposeFilter,
  type ExpandResult,
  type TerminologyDeps,
  expandComposeWith,
  CodeSystemIndexBuilder,
  findConcept,
  indexCodeSystem,
  valueSetContains,
} from "./fhirCodeSystem.js";

export type { Coding, ExpandResult } from "./fhirCodeSystem.js";
import type { Icd10WhoRow, LoincOtherRow, SnomedConceptRow, SnomedDescriptionRow, SnomedEditionInfo } from "./fhirExternalTerminology.js";
import { LOINC_TX_VERSION } from "./fhirExternalTerminology.js";
import { CVX_CODES } from "./fhirCvx.js";
import { ISO3166_DISPLAY } from "./fhirIso3166.js";
import { parseSimpleEcl, simpleEclContains } from "./fhirSimpleEcl.js";
import { cacheLimits, currentSnapshot } from "./fhirValidationSnapshot.js";
import { TtlMemo } from "./ttlMemo.js";

export const SNOMED_SYSTEM = "http://snomed.info/sct";
export const LOINC_SYSTEM = "http://loinc.org";
export const RXNORM_SYSTEM = "http://www.nlm.nih.gov/research/umls/rxnorm";
export const SNOMED_IS_A = 116680003;

export const DEFAULT_EXPAND_LIMIT = 500;

export function canonicalTail(url: string | null | undefined): string {
  if (!url) return "";
  return url.replace(/\/+$/, "").split("/").pop()!.split("|")[0];
}

/** Parallel `(package_ids, package_versions)` arrays for the dependency closure. */
export function closureArrays(pkg: PackageRow): [string[], string[]] {
  const closure = pkg._closure || [[pkg.package_id, pkg.version]];
  const pids = closure.map((c) => c[0]);
  const pvers = closure.map((c) => c[1]);
  return [pids, pvers];
}

export type SystemKind = "ig" | "snomed" | "loinc" | "icd_dx" | "icd_pcs" | "external";

/** Map a code system (and/or CodeSystem id) to a local backing store. */
export function routeSystem(system: string | null | undefined, csId: string | null = null): SystemKind {
  if (system === SNOMED_SYSTEM) return "snomed";
  if (system === LOINC_SYSTEM) return "loinc";
  const tail = csId || canonicalTail(system);
  if (tail.startsWith("icd-10-pcs") || tail.startsWith("icd-9-pcs")) return "icd_pcs";
  if (tail.startsWith("icd-10-cm") || tail.startsWith("icd-9-cm")) return "icd_dx";
  if (csId || (system && system.includes("/CodeSystem/"))) return "ig";
  return "external";
}

export interface LookupResult {
  display: string | null;
  definition: string | null;
}

function isDigits(s: any): boolean {
  return /^\d+$/.test(String(s));
}

// --------------------------------------------------------------------------- //
// Process-wide caches (IG package versions are immutable once imported; a TTL
// still bounds staleness after a re-import of the same version).
// --------------------------------------------------------------------------- //

const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_MAX = 400;

/** Weight charged for a key whose value another key already pays for (TtlCache `shared`). */
const SHARED_ENTRY_WEIGHT = 64;

export class TtlCache<V> {
  private map = new Map<string, { at: number; value: V; weight: number; full: number; share: object | null }>();
  private total = 0;
  /** per shared object: how many keys hold it */
  private holders = new Map<object, number>();
  /**
   * `maxWeight` bounds the summed weight of the held values — for the CodeSystem indexes and ValueSets their estimated
   * size in bytes (memSize.estimateBytes): a few large CodeSystems (tens of thousands of codes, hundreds of MB once
   * indexed) must not pin the heap (release v1, the staging OOM of 2026-11-01; the 2026-11-08 heap profile: ~1 GB of
   * CodeSystem indexes under a 150k-concept bound). Eviction is least-recently-used, by count (CACHE_MAX) and by weight.
   * Inside a validation snapshot (fhirValidationSnapshot.ts) reads and writes are pinned: the request keeps the value it
   * saw first, also one evicted or too heavy to be held here. Expiry and eviction only affect the next request.
   *
   * `shared` names the object a value shares with other keys (the CodeSystem index of identical content, reached through
   * several IG closures): it is weighed once — the first key holding it pays its full weight, the others a nominal 64
   * bytes, and when the paying key goes another holder takes the weight over. Weighed per key, five closures holding
   * one 185 MB ICD-10-CM index counted 925 MB, the budget filled with copies of the same index and the evictions
   * reloaded CodeSystems (2–3.5 s of CPU each) all day (staging 2026-11-15: event-loop lag up to 14 s).
   */
  constructor(
    private readonly maxWeight = Infinity,
    private readonly maxEntries = CACHE_MAX,
    private readonly shared: ((value: V) => object | null) | null = null,
  ) {
    // weight is estimated bytes for a byte-bounded cache, 1 per entry otherwise
    trackCache(this, { stats: (c) => ({ entries: c.map.size, bytes: c.maxWeight === Infinity ? 0 : c.total }), shed: (c, f) => c.shed(f) });
  }
  get(key: string): V | undefined {
    const snap = currentSnapshot();
    if (snap?.has(this, key)) return snap.get(this, key) as V;
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (Date.now() - hit.at > (cacheLimits().ttlMs ?? CACHE_TTL_MS)) {
      this.drop(key);
      return undefined;
    }
    // least recently used first out: a hit moves to the end of the insertion order
    this.map.delete(key);
    this.map.set(key, hit);
    snap?.pin(this, key, hit.value);
    return hit.value;
  }
  set(key: string, value: V, weight = 1): void {
    currentSnapshot()?.pin(this, key, value);
    this.drop(key);
    const limit = cacheLimits();
    const maxWeight = limit.maxWeight ?? this.maxWeight;
    const maxEntries = limit.maxEntries ?? this.maxEntries;
    if (weight > maxWeight || maxEntries <= 0) return; // larger than the whole budget: not held
    const share = this.shared && value !== null && value !== undefined ? this.shared(value) : null;
    const charged = share && (this.holders.get(share) ?? 0) > 0 ? Math.min(weight, SHARED_ENTRY_WEIGHT) : weight;
    while (this.map.size && (this.map.size >= maxEntries || this.total + charged > maxWeight)) {
      const first = this.map.keys().next().value;
      if (first === undefined) break;
      this.drop(first);
    }
    // the eviction may have dropped the payer of `share`: then this key pays
    const weightNow = share && (this.holders.get(share) ?? 0) > 0 ? Math.min(weight, SHARED_ENTRY_WEIGHT) : weight;
    this.map.set(key, { at: Date.now(), value, weight: weightNow, full: weight, share });
    this.total += weightNow;
    if (share) this.holders.set(share, (this.holders.get(share) ?? 0) + 1);
  }
  get size(): number {
    return this.map.size;
  }
  get weight(): number {
    return this.total;
  }
  /** Drop about `fraction` of the entries, least recently used first (memory pressure; a request keeps what it pinned). */
  shed(fraction: number): void {
    let n = Math.ceil(this.map.size * fraction);
    for (const key of [...this.map.keys()]) {
      if (n-- <= 0) break;
      this.drop(key);
    }
  }
  private drop(key: string): void {
    const hit = this.map.get(key);
    if (!hit) return;
    this.total -= hit.weight;
    this.map.delete(key);
    if (!hit.share) return;
    const left = (this.holders.get(hit.share) ?? 1) - 1;
    if (left <= 0) {
      this.holders.delete(hit.share);
      return;
    }
    this.holders.set(hit.share, left);
    if (hit.weight === hit.full) {
      // the payer went: another holder of the same object takes the full weight over
      for (const e of this.map.values()) {
        if (e.share === hit.share) {
          this.total += e.full - e.weight;
          e.weight = e.full;
          break;
        }
      }
    }
  }
}

// CodeSystem indexes, bounded by their estimated size (CS_CACHE_MB, default 1280 MB); ValueSets likewise (VS_CACHE_MB, 128 MB)
// v22 G6: 1280 MB (was 512): with PAS (TW Core 0.3.2) and 15 other IGs the working set alone — ICD-10-CM 2023 185 MB,
// ICD-10-PCS 151, FDA devices 109, … ≈ 740 MB estimated — outgrew 512, every eviction reloaded a CodeSystem (2–3.5 s
// of CPU each) and the event loop lagged up to 14 s
// Up to 4000 keys (not CACHE_MAX 400): one key per closure × canonical, most of them small or sharing an index (64 bytes
// each); at 400 the count, not the bytes, evicted the large indexes on the 16-IG soak and they were reloaded (v22 G6)
const csCache = new TtlCache<CodeSystemIndex | null>(envBudgetBytes("CS_CACHE_MB", 1280), 4000, (idx) => idx);
const csLoading = new Map<string, Promise<CodeSystemIndex | null>>();

/**
 * One index per CodeSystem content. csCache is keyed by the lookup (closure + canonical + exact / version), so the same
 * CodeSystem resolved from several IG closures, exactly and by id, or for the THO current edition was indexed once per
 * key — each copy ~80-160 MB for the TW Core ICD-10 / FDA code systems, and every request pinning its own. A CodeSystem
 * of identical JSON now gets the same (immutable) index object while any holder still has it.
 */
const sharedIndexes = new Map<string, WeakRef<CodeSystemIndex>>();
const sharedGone = new FinalizationRegistry<string>((h) => {
  if (!sharedIndexes.get(h)?.deref()) sharedIndexes.delete(h);
});
function sharedCodeSystemIndex(cs: Record<string, any>): CodeSystemIndex {
  const h = createHash("sha1").update(JSON.stringify(cs)).digest("hex");
  const hit = sharedIndexes.get(h)?.deref();
  if (hit) return hit;
  const idx = indexCodeSystem(cs);
  sharedIndexes.set(h, new WeakRef(idx));
  sharedGone.register(idx, h);
  return idx;
}
const vsCache = new TtlCache<Record<string, any> | null>(envBudgetBytes("VS_CACHE_MB", 128));
const heldCache = new TtlCache<boolean>();

export function closureKey(pkg: PackageRow): string {
  const [pids, pvers] = closureArrays(pkg);
  return pids.map((p, i) => `${p}#${pvers[i]}`).join(",");
}

function jsonOf(raw: any): Record<string, any> | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return raw;
}

/**
 * The extension pack validator_cli loads into every non-R5 validation itself, whatever the IG declares:
 * ValidationService.loadIgsAndExtensions (validation 7.0.1, l. 745-749) → IgLoader.loadIg("hl7.fhir.uv.extensions"),
 * no version = the newest one (an R5 build, e.g. 5.4.0). Its definitions take part in the context like any other loaded
 * package (CanonicalResourceManager: highest resource version answers an unversioned canonical), so it is not one of the
 * "other FHIR release" packages ranked last; its core dependency (hl7.fhir.r5.core) is never loaded (loadIg skips core
 * packages).
 */
export const VALIDATOR_EXTENSIONS_PACKAGE = "hl7.fhir.uv.extensions";

export function cmpVersion(a: string | null | undefined, b: string | null | undefined): number {
  const pa = String(a || "").split(/[.\-]/);
  const pb = String(b || "").split(/[.\-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? "";
    const y = pb[i] ?? "";
    const nx = /^\d+$/.test(x) ? Number(x) : NaN;
    const ny = /^\d+$/.test(y) ? Number(y) : NaN;
    if (!Number.isNaN(nx) && !Number.isNaN(ny)) {
      if (nx !== ny) return nx - ny;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

export interface ArtifactCandidate {
  packageId: string;
  packageVersion: string;
  fhirVersion: string | null;
  /** 1-based position in the dependency closure (target package first). */
  ord: number;
}

/**
 * Order candidate packages holding the same canonical, best first:
 *  1. packages for another FHIR major release (R5 cores / R5 terminology pulled
 *     in transitively) go last — this validator validates R4 content;
 *  2. `http://terminology.hl7.org/...` canonicals prefer the newest
 *     `hl7.terminology.*` package (THO supersedes the copies frozen in core);
 *  3. otherwise the dependency-closure order (the IG itself, then its deps).
 */
export function rankCandidates<T extends ArtifactCandidate>(canonical: string, rows: T[]): T[] {
  const foreign = (r: T): number => {
    if (r.packageId === VALIDATOR_EXTENSIONS_PACKAGE) return 0;
    const fv = r.fhirVersion || "";
    const r5 = /\.r5(\.|$)/.test(r.packageId) || (fv !== "" && !fv.startsWith("4"));
    return r5 ? 1 : 0;
  };
  const tho = canonical.startsWith("http://terminology.hl7.org/");
  return [...rows].sort((a, b) => {
    const fa = foreign(a) - foreign(b);
    if (fa !== 0) return fa;
    if (tho) {
      const ta = a.packageId.startsWith("hl7.terminology") ? 0 : 1;
      const tb = b.packageId.startsWith("hl7.terminology") ? 0 : 1;
      if (ta !== tb) return ta - tb;
      if (ta === 0) {
        const c = cmpVersion(b.packageVersion, a.packageVersion);
        if (c !== 0) return c;
      }
    }
    return a.ord - b.ord;
  });
}

/** HL7 VersionUtilities.getMajMin-like key of a resource version (null when not semver-shaped). */
function majMinParts(v: string | null | undefined): [number, number] | null {
  const m = /^(\d+)\.(\d+)/.exec(String(v ?? ""));
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/**
 * Port of CanonicalResourceManager's "current" resource for an unversioned
 * canonical (org.hl7.fhir.r5 context, validator_cli 7.0.1): every loaded copy of
 * a canonical is kept sorted by MetadataResourceVersionComparator (major.minor of
 * the resource's own `version`; a resource without a version sorts first; equal
 * keys keep load order) and the last one answers `fetchResource(url)`. So an
 * extension that both R4 core (version 4.0.1) and hl7.fhir.uv.extensions.r4
 * (5.2.0) define resolves to the extensions-pack copy — the one carrying e.g.
 * var-1 and the current contexts (confirmed with validator_cli: v5.x messages).
 * Applied after rankCandidates' rules (other FHIR major releases last, THO
 * packages first for terminology.hl7.org canonicals); ties keep closure order.
 */
export function rankHl7Current<T extends ArtifactCandidate & { version?: string | null }>(canonical: string, rows: T[], resourceOf?: (row: T) => Record<string, any> | null | undefined): T[] {
  const ranked = rankCandidates(canonical, rows);
  if (canonical.startsWith("http://terminology.hl7.org/")) return ranked;
  // CanonicalResourceManager.see l. 294-300 + get l. 624-630: the master package's CodeSystems, ValueSets and
  // specialization StructureDefinitions answer an unversioned canonical whatever else is loaded
  const master = (r: T): boolean => {
    if (r.packageId !== "hl7.fhir.r4.core") return false;
    const res = resourceOf?.(r);
    return !!res && (res.resourceType === "CodeSystem" || res.resourceType === "ValueSet" || (res.resourceType === "StructureDefinition" && res.derivation === "specialization"));
  };
  const foreign = (r: T): boolean => {
    if (r.packageId === VALIDATOR_EXTENSIONS_PACKAGE) return false;
    const fv = r.fhirVersion || "";
    return /\.r5(\.|$)/.test(r.packageId) || (fv !== "" && !fv.startsWith("4"));
  };
  const pos = new Map(ranked.map((r, i) => [r, i]));
  const cmp = (a: T, b: T): number => {
    const ma0 = Number(master(b)) - Number(master(a));
    if (ma0 !== 0) return ma0;
    const fa = Number(foreign(a)) - Number(foreign(b));
    if (fa !== 0) return fa;
    const va = a.version ?? null;
    const vb = b.version ?? null;
    if (va !== vb) {
      if (va === null) return 1;
      if (vb === null) return -1;
      const ma = majMinParts(va);
      const mb = majMinParts(vb);
      if (ma && mb) {
        if (ma[0] !== mb[0]) return mb[0] - ma[0];
        if (ma[1] !== mb[1]) return mb[1] - ma[1];
      } else if (!ma && !mb && va !== vb) {
        return va < vb ? 1 : -1;
      }
    }
    return pos.get(a)! - pos.get(b)!;
  };
  return [...ranked].sort(cmp);
}

interface HolderRow {
  package_id: string;
  package_version: string;
  version: string | null;
  ord: number;
}
const holderMemo = new TtlMemo<HolderRow[]>(CACHE_TTL_MS, 4000);

/** The version `url` has in the first package of `source`'s own dependency closure that holds it (populatePVList). */
export async function packageScopedVersion(
  resourceType: string,
  url: string,
  source: Record<string, any>,
  pkg: PackageRow,
  closureOf: (packageId: string, version: string) => Promise<Array<[string, string]>>,
): Promise<string | null> {
  if (typeof source.url !== "string") return null;
  const [pids, pvers] = closureArrays(pkg);
  // memoised per (closure, type, canonical) and pinned per request: every source profile asks for the same holders
  const holders = (type: string, canonical: string): Promise<HolderRow[]> =>
    holderMemo.get(`${closureKey(pkg)}\0${type}\0${canonical}`, () =>
      query<HolderRow>(
        "SELECT a.package_id, a.package_version, a.raw_json->>'version' AS version, dep.ord FROM fhir.artifacts a " +
          "JOIN unnest($1::text[], $2::text[]) WITH ORDINALITY AS dep(pid, pver, ord) ON a.package_id = dep.pid AND a.package_version = dep.pver " +
          "WHERE a.resource_type = $3 AND a.canonical_url = $4 ORDER BY dep.ord",
        [pids, pvers, type, canonical],
      ).then((r) => r.rows),
    );
  const own = (await holders(String(source.resourceType), source.url)).find((r) => (r.version ?? null) === (source.version ?? null));
  if (!own || isCorePackage(own.package_id)) return null;
  // CanonicalResourceManager.see l. 262-274: loading a hl7.terminology package drops the core copies of its canonicals
  const all = await holders(resourceType, url);
  const rows = all.some((r) => r.package_id.startsWith("hl7.terminology")) ? all.filter((r) => !isCorePackage(r.package_id)) : all;
  if (!rows.length) return null;
  for (const [pid, pver] of await closureOf(own.package_id, own.package_version)) {
    const hit = rows.find((r) => r.package_id === pid && r.package_version === pver);
    if (hit) return hit.version ?? null;
  }
  return null;
}

/** VersionUtilities.isCorePackage (7.0.1, l. 365-373). */
export function isCorePackage(id: string): boolean {
  return ["hl7.fhir.core", "hl7.fhir.r2.core", "hl7.fhir.r2b.core", "hl7.fhir.r3.core", "hl7.fhir.r4.core", "hl7.fhir.r4b.core", "hl7.fhir.r5.core", "hl7.fhir.r6.core"].includes(id);
}

/** Load a conformance/terminology resource by canonical across the package closure (best candidate). */
/** The closure's copies of a canonical artifact, best first (as loadArtifactByCanonical picks), metadata only. */
async function rankedArtifacts(resourceType: string, url: string, pkg: PackageRow, hl7Current: boolean): Promise<Array<{ package_id: string; package_version: string }>> {
  const [pids, pvers] = closureArrays(pkg);
  const canonical = url.split("|")[0];
  // version / derivation straight from the stored JSON (string values only, as the code reads them): the ranking needs
  // nothing else, so no copy's JSON is fetched to rank (v22 G6: every copy of a large StructureDefinition / ValueSet /
  // CodeSystem was fetched and parsed on the event loop to keep the first)
  const rows = (
    await query<{ ord: number; package_id: string; package_version: string; fhir_version: string | null; version: string | null; derivation: string | null }>(
      "SELECT dep.ord, a.package_id, a.package_version, p.fhir_version, " +
        "CASE WHEN jsonb_typeof(a.raw_json->'version') = 'string' THEN a.raw_json->>'version' END AS version, " +
        "a.raw_json->>'derivation' AS derivation FROM fhir.artifacts a " +
        "JOIN unnest($1::text[], $2::text[]) WITH ORDINALITY AS dep(pid, pver, ord) " +
        "  ON a.package_id = dep.pid AND a.package_version = dep.pver " +
        "JOIN fhir.ig_packages p ON p.package_id = a.package_id AND p.version = a.package_version " +
        "WHERE a.resource_type = $3 AND a.canonical_url = $4 AND a.raw_json IS NOT NULL",
      [pids, pvers, resourceType, canonical],
    )
  ).rows;
  const cands = rows.map((r) => ({ ...r, packageId: r.package_id, packageVersion: r.package_version, fhirVersion: r.fhir_version, ord: Number(r.ord) }));
  if (hl7Current) return rankHl7Current(canonical, cands, (r) => ({ resourceType, derivation: r.derivation }));
  return rankCandidates(canonical, cands);
}

/** Does the closure hold this canonical artifact at all? (metadata only — never fetches the resource) */
export async function hasArtifactByCanonical(resourceType: string, url: string, pkg: PackageRow): Promise<boolean> {
  return (await rankedArtifacts(resourceType, url, pkg, false)).length > 0;
}

export async function loadArtifactByCanonical(
  resourceType: string,
  url: string,
  pkg: PackageRow,
  opts: { hl7Current?: boolean; packageFix?: (json: Record<string, any>, packageId: string) => Record<string, any> } = {},
): Promise<Record<string, any> | null> {
  const canonical = url.split("|")[0];
  for (const r of await rankedArtifacts(resourceType, url, pkg, !!opts.hl7Current)) {
    const row = (
      await query<{ raw_json: any }>(
        "SELECT raw_json FROM fhir.artifacts WHERE resource_type = $1 AND package_id = $2 AND package_version = $3 AND canonical_url = $4 AND raw_json IS NOT NULL LIMIT 1",
        [resourceType, r.package_id, r.package_version, canonical],
      )
    ).rows[0];
    const json = row ? jsonOf(row.raw_json) : null;
    if (json) return opts.packageFix ? opts.packageFix(json, r.package_id) : json;
  }
  return null;
}

async function loadByCanonical(
  resourceType: "CodeSystem" | "ValueSet",
  url: string,
  pkg: PackageRow,
  exact = false,
): Promise<Record<string, any> | null> {
  const hit = await loadArtifactByCanonical(resourceType, url, pkg);
  if (hit || exact) return hit;
  // Fallback by resource id = canonical tail. Covers bare ids passed by tool
  // callers, and packages that published a resource under a wrong `url`
  // (e.g. TW Core 0.3.2 CodeSystem/icd-10-cm-2023-tw declares the ValueSet URL).
  const [pids, pvers] = closureArrays(pkg);
  const row = (
    await query<{ raw_json: any }>(
      "SELECT a.raw_json FROM fhir.artifacts a " +
        "JOIN unnest($1::text[], $2::text[]) WITH ORDINALITY AS dep(pid, pver, ord) " +
        "  ON a.package_id = dep.pid AND a.package_version = dep.pver " +
        "WHERE a.resource_type = $3 AND a.artifact_id = $4 ORDER BY dep.ord LIMIT 1",
      [pids, pvers, resourceType, canonicalTail(url)],
    )
  ).rows[0];
  if (!row) return null;
  const json = jsonOf(row.raw_json);
  if (!json) return null;
  if (resourceType === "CodeSystem" && url.includes("/")) {
    // Only accept the id match when the path differs at most in the resource-type segment.
    const want = url.split("|")[0].replace(/\/(CodeSystem|ValueSet)\//, "/");
    const got = String(json.url || "").replace(/\/(CodeSystem|ValueSet)\//, "/");
    if (want !== got) return null;
  }
  return json;
}

/**
 * CodeSystem index by canonical across the package closure. `exact` (the
 * validator) disables the id fallback: the HL7 validator resolves a
 * Coding.system / include.system by its exact canonical only.
 */
export async function loadCodeSystemIndex(url: string, pkg: PackageRow, exact = false): Promise<CodeSystemIndex | null> {
  const bar = url.indexOf("|");
  const version = bar >= 0 ? url.slice(bar + 1) : "";
  const key = closureKey(pkg) + "|" + url.split("|")[0] + (version ? `|v=${version}` : "") + (exact ? "|exact" : "");
  const cached = csCache.get(key);
  if (cached !== undefined) return cached;
  // One load at a time per key: concurrent requests pin one index, not one copy each (a large IG's indexes are hundreds of MB)
  let loading = csLoading.get(key);
  if (!loading) {
    loading = loadCodeSystemIndexUncached(url, pkg, exact, key, bar, version).finally(() => csLoading.delete(key));
    csLoading.set(key, loading);
  }
  const idx = await loading;
  currentSnapshot()?.pin(csCache, key, idx);
  return idx;
}

/**
 * CodeSystem indexes by the artifact they were built from (package#version|canonical) and by content (md5 of the stored
 * JSON, computed by Postgres), held weakly: the same artifact reached through another IG's closure, or the same content
 * in another package, reuses the index without loading anything.
 */
const indexByArtifact = new Map<string, WeakRef<CodeSystemIndex>>();
const indexByContent = new Map<string, WeakRef<CodeSystemIndex>>();
const indexGone = new FinalizationRegistry<{ map: Map<string, WeakRef<CodeSystemIndex>>; key: string }>(({ map, key }) => {
  if (!map.get(key)?.deref()) map.delete(key);
});
function remember(map: Map<string, WeakRef<CodeSystemIndex>>, key: string, idx: CodeSystemIndex): void {
  map.set(key, new WeakRef(idx));
  indexGone.register(idx, { map, key });
}

/** The artifact a CodeSystem lookup resolved to (no JSON loaded yet). */
interface CsArtifact {
  packageId: string;
  packageVersion: string;
  canonical: string;
}

/**
 * The index of one stored CodeSystem without ever parsing its whole JSON on the event loop (v22 G6: a 30 MB ICD-10-CM
 * JSON was one ~1.4 s JSON.parse, plus a 0.5 s hash of its re-serialisation, per load; with the lag those caused the
 * staging health checks timed out). Postgres hands over the CodeSystem without its concepts and a content md5, then the
 * concepts flattened — one row per concept, in the depth-first pre-order of the nested lists, with its parent's code —
 * and the builder takes them INDEX_ROWS_PER_SLICE at a time. Same index as indexCodeSystem(resource) (test: rows vs
 * resource). undefined when the database cannot flatten it (the caller loads the resource whole, as before).
 */
export async function indexFromRows(a: CsArtifact): Promise<{ index: CodeSystemIndex | null } | undefined> {
  const artifact = `${a.packageId}#${a.packageVersion}|${a.canonical}`;
  const known = indexByArtifact.get(artifact)?.deref();
  if (known) return { index: known };
  const params = [a.packageId, a.packageVersion, a.canonical];
  const where = "resource_type = 'CodeSystem' AND package_id = $1 AND package_version = $2 AND canonical_url = $3";
  const head = await codeSystemHead(where, params);
  if (!head) return undefined;
  const cs = head.head;
  // `not-present` stubs (e.g. SNOMED / LOINC in core) carry no concepts: treat as not held.
  if (cs.content === "supplement" || cs.content === "not-present") return { index: null };
  const same = indexByContent.get(head.md5)?.deref();
  if (same) {
    remember(indexByArtifact, artifact, same);
    return { index: same };
  }
  const rows = await codeSystemConceptRows(where, params);
  if (!rows) return undefined;
  // built in time slices, one large build at a time across the process (oneAtATime, shared with the concept indexes)
  const idx = await oneAtATime(async () => {
    const again = indexByContent.get(head.md5)?.deref(); // built meanwhile by a build queued before this one
    if (again) return again;
    const b = new CodeSystemIndexBuilder();
    const slice = new Slicer();
    for (const r of rows) {
      b.add(r.node, r.parent);
      await slice.tick();
    }
    await slice.next();
    return b.finishAsync(cs, () => slice.tick());
  });
  remember(indexByArtifact, artifact, idx);
  remember(indexByContent, head.md5, idx);
  return { index: idx };
}

/**
 * The closure's CodeSystem by exact canonical, as loadArtifactByCanonical picks it (rankCandidates reads only package
 * metadata): its artifact, without loading it. undefined = no copy in the closure (the caller falls back as before).
 */
async function closureCodeSystem(url: string, pkg: PackageRow): Promise<CsArtifact | undefined> {
  const [pids, pvers] = closureArrays(pkg);
  const canonical = url.split("|")[0];
  const rows = (
    await query<{ ord: number; package_id: string; package_version: string; fhir_version: string | null }>(
      "SELECT dep.ord, a.package_id, a.package_version, p.fhir_version FROM fhir.artifacts a " +
        "JOIN unnest($1::text[], $2::text[]) WITH ORDINALITY AS dep(pid, pver, ord) " +
        "  ON a.package_id = dep.pid AND a.package_version = dep.pver " +
        "JOIN fhir.ig_packages p ON p.package_id = a.package_id AND p.version = a.package_version " +
        "WHERE a.resource_type = 'CodeSystem' AND a.canonical_url = $3 AND a.raw_json IS NOT NULL",
      [pids, pvers, canonical],
    )
  ).rows;
  const best = rankCandidates(
    canonical,
    rows.map((r) => ({ ...r, packageId: r.package_id, packageVersion: r.package_version, fhirVersion: r.fhir_version, ord: Number(r.ord) })),
  )[0];
  return best ? { packageId: best.package_id, packageVersion: best.package_version, canonical } : undefined;
}

/**
 * The CodeSystem of exactly `version` as loadCodeSystemVersion picks it (pickCanonicalVersion reads only the version):
 * its artifact, without loading it — the versions come from the database (raw_json->>'version', string only, as the
 * code reads them). Before, every copy of the canonical in every installed package was parsed to pick one (ICD-10-CM
 * 2023: several 30 MB JSONs per Coding.version lookup; staging 2026-11-15). undefined = no copy of that version.
 */
async function versionedCodeSystem(canonical: string, version: string, pkg: PackageRow): Promise<CsArtifact | undefined> {
  const [pids, pvers] = closureArrays(pkg);
  const rows = (
    await query<{ package_id: string; package_version: string; version: string | null; in_closure: boolean }>(
      "SELECT a.package_id, a.package_version, " +
        "CASE WHEN jsonb_typeof(a.raw_json->'version') = 'string' THEN a.raw_json->>'version' END AS version, " +
        "(dep.pid IS NOT NULL) AS in_closure FROM fhir.artifacts a " +
        "LEFT JOIN unnest($1::text[], $2::text[]) AS dep(pid, pver) ON a.package_id = dep.pid AND a.package_version = dep.pver " +
        "WHERE a.resource_type = 'CodeSystem' AND a.canonical_url = $3 AND a.raw_json IS NOT NULL",
      [pids, pvers, canonical],
    )
  ).rows;
  const pick = pickCanonicalVersion(rows.filter((r) => r.in_closure), version) ?? pickCanonicalVersion(rows, version);
  return pick ? { packageId: pick.package_id, packageVersion: pick.package_version, canonical } : undefined;
}

async function loadCodeSystemIndexUncached(url: string, pkg: PackageRow, exact: boolean, key: string, bar: number, version: string): Promise<CodeSystemIndex | null> {
  const found = version ? await versionedCodeSystem(url.slice(0, bar), version, pkg) : await closureCodeSystem(url, pkg);
  if (found) {
    const built = await indexFromRows(found);
    if (built) {
      csCache.set(key, built.index, 64 + (built.index ? await indexBytes(built.index) : 0));
      return built.index;
    }
  }
  // REVIEW_port_2 G3 (ValueSetValidator.resolveCodeSystem(system, version), tag 7.0.1:654): `url|version` is that
  // version of the CodeSystem — never the closure's other copy
  const cs = version ? await loadCodeSystemVersion(url.slice(0, bar), version, pkg) : await loadByCanonical("CodeSystem", url, pkg, exact);
  // `not-present` stubs (e.g. SNOMED / LOINC in core) carry no concepts: treat as not held.
  const idx = cs && cs.content !== "supplement" && cs.content !== "not-present" ? sharedCodeSystemIndex(cs) : null;
  csCache.set(key, idx, 64 + (idx ? await indexBytes(idx) : 0));
  return idx;
}

/** Estimated size of a (shared, immutable) CodeSystem index: walked once per index, in slices (up to a second each). */
const indexSizes = new WeakMap<CodeSystemIndex, number>();
async function indexBytes(idx: CodeSystemIndex): Promise<number> {
  const known = indexSizes.get(idx);
  if (known !== undefined) return known;
  const bytes = await estimateBytesAsync(idx);
  indexSizes.set(idx, bytes);
  return bytes;
}

/**
 * A CodeSystem of exactly `version` (CanonicalResourceManager version rules, fhirValidator.pickCanonicalVersion):
 * the closure's copies first, then any installed package (the validator's terminology server serves the other
 * published versions of HL7 / IG code systems). null when no installed package holds that version.
 */
async function loadCodeSystemVersion(canonical: string, version: string, pkg: PackageRow): Promise<Record<string, any> | null> {
  const [pids, pvers] = closureArrays(pkg);
  const rows = (
    await query<{ raw_json: any; in_closure: boolean }>(
      "SELECT a.raw_json, (dep.pid IS NOT NULL) AS in_closure FROM fhir.artifacts a " +
        "LEFT JOIN unnest($1::text[], $2::text[]) AS dep(pid, pver) ON a.package_id = dep.pid AND a.package_version = dep.pver " +
        "WHERE a.resource_type = 'CodeSystem' AND a.canonical_url = $3",
      [pids, pvers, canonical],
    )
  ).rows;
  const cands = rows
    .map((r) => ({ json: jsonOf(r.raw_json), inClosure: r.in_closure }))
    .filter((r): r is { json: Record<string, any>; inClosure: boolean } => !!r.json)
    .map((r) => ({ ...r, version: typeof r.json.version === "string" ? (r.json.version as string) : null }));
  const pick = pickCanonicalVersion(cands.filter((c) => c.inClosure), version) ?? pickCanonicalVersion(cands, version);
  if (pick) return pick.json;
  // R4 core publishes its v2 tables with the version inside the url ("…/v2-0360|2.7", version "0360")
  const literal = (await query<{ raw_json: any }>("SELECT a.raw_json FROM fhir.artifacts a WHERE a.resource_type = 'CodeSystem' AND a.canonical_url = $1 LIMIT 1", [`${canonical}|${version}`])).rows[0];
  const json = literal ? jsonOf(literal.raw_json) : null;
  return json ? { ...json, url: canonical, version } : null;
}

/**
 * The current edition of a THO CodeSystem: validator_cli answers terminology.hl7.org codes from the terminology server
 * (official corpus: "Unknown code … version '4.0.0'" in an IG whose closure holds v3-RoleCode 2.2.0), which serves the
 * latest hl7.terminology release — the newest copy any installed package holds. null when none is installed.
 */
export async function loadThoCurrentIndex(canonical: string): Promise<CodeSystemIndex | null> {
  const key = `tho-current|${canonical}`;
  const cached = csCache.get(key);
  if (cached !== undefined) return cached;
  const rows = (
    await query<{ raw_json: any; package_id: string; package_version: string; fhir_version: string | null }>(
      "SELECT a.raw_json, a.package_id, a.package_version, p.fhir_version FROM fhir.artifacts a " +
        "JOIN fhir.ig_packages p ON p.package_id = a.package_id AND p.version = a.package_version " +
        "WHERE a.resource_type = 'CodeSystem' AND a.canonical_url = $1 AND a.package_id LIKE 'hl7.terminology%'",
      [canonical],
    )
  ).rows;
  const cands = rows.map((r, i) => ({ ...r, packageId: r.package_id, packageVersion: r.package_version, fhirVersion: r.fhir_version, ord: i }));
  const best = rankCandidates(canonical, cands)[0];
  const cs = best ? jsonOf(best.raw_json) : null;
  const idx = cs && cs.content === "complete" ? sharedCodeSystemIndex(cs) : null;
  csCache.set(key, idx, 64 + (idx ? await indexBytes(idx) : 0));
  return idx;
}

/** Versions of the CodeSystem `canonical` held in the package closure (UNKNOWN_CODESYSTEM_VERSION's "Valid versions"). */
export async function codeSystemVersionsInClosure(canonical: string, pkg: PackageRow): Promise<string[]> {
  const [pids, pvers] = closureArrays(pkg);
  const rows = (
    await query<{ v: string | null }>(
      "SELECT DISTINCT a.raw_json->>'version' AS v FROM fhir.artifacts a " +
        "JOIN unnest($1::text[], $2::text[]) AS dep(pid, pver) ON a.package_id = dep.pid AND a.package_version = dep.pver " +
        "WHERE a.resource_type = 'CodeSystem' AND a.canonical_url = $3",
      [pids, pvers, canonical],
    )
  ).rows;
  return rows.map((r) => r.v).filter((v): v is string => typeof v === "string" && v !== "");
}

export async function loadValueSet(url: string, pkg: PackageRow): Promise<Record<string, any> | null> {
  const key = closureKey(pkg) + "|" + url.split("|")[0];
  const cached = vsCache.get(key);
  if (cached !== undefined) return cached;
  const vs = (await loadByCanonical("ValueSet", url, pkg)) ?? (await implicitLoincAnswerList(url.split("|")[0]));
  vsCache.set(key, vs, 64 + (vs ? estimateBytes(vs) : 0));
  return vs;
}

/** The implicit ValueSet tx.fhir.org serves for LOINC answer list `ll`, from its answers in list order; null without answers. */
export function loincAnswerListValueSet(ll: string, rows: Array<{ answer_code: string; display: string | null }>): Record<string, any> | null {
  if (!rows.length) return null;
  return {
    resourceType: "ValueSet",
    url: `http://loinc.org/vs/${ll}`,
    name: `LOINC_Answer_Codes_for_${ll.replace(/-/g, "_")}`,
    title: `LOINC Answer Codes for ${ll}`,
    status: "active",
    // not a resource of any package: only the terminology server has it, so its answers are the server's (no local
    // ValueSetValidator rules such as accepting a system-less Coding at face value)
    implicitAtServer: true,
    compose: { include: [{ system: "http://loinc.org", concept: rows.map((r) => (r.display ? { code: r.answer_code, display: r.display } : { code: r.answer_code })) }] },
  };
}

/**
 * The implicit ValueSet of a LOINC answer list (http://loinc.org/vs/LL…): tx.fhir.org serves it as 'LOINC Answer Codes for
 * <LL>' (official corpus: 1355 + 109 + … messages, no version in the reference) with the list's answers. Built from
 * loinc.answer_list_items only when the local LOINC release is the one the terminology server uses (LOINC_TX_VERSION), so
 * the answers are the server's; otherwise null (the ValueSet stays with the terminology server).
 */
async function implicitLoincAnswerList(url: string): Promise<Record<string, any> | null> {
  const m = /^http:\/\/loinc\.org\/vs\/(LL\d+-\d)$/.exec(url);
  if (!m) return null;
  try {
    if ((await loincEdition())?.version !== LOINC_TX_VERSION) return null;
    const rows = (await query<{ answer_code: string; display: string | null }>("SELECT answer_code, display FROM loinc.answer_list_items WHERE list_id = $1 ORDER BY seq", [m[1]])).rows;
    return loincAnswerListValueSet(m[1], rows);
  } catch (e) {
    if (schemaMissing(e)) return null;
    throw e;
  }
}

/** A permanent "this table / column is not on this database" (a migration not applied), as opposed to a transient failure. */
function schemaMissing(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code;
  return code === "42P01" || code === "42703" || code === "3F000";
}

async function tableHasRows(table: string): Promise<boolean> {
  const cached = heldCache.get(table);
  if (cached !== undefined) return cached;
  let held = false;
  try {
    held = (await query(`SELECT 1 FROM ${table} LIMIT 1`)).rows.length > 0;
  } catch (e) {
    // A missing table (42P01) is permanent; any other (transient) DB error is not
    // cached, so it cannot turn a terminology "not held" (checks silently skipped)
    // for the cache lifetime.
    if ((e as { code?: string } | null)?.code === "42P01") heldCache.set(table, false);
    return false;
  }
  heldCache.set(table, held);
  return held;
}

/** Whether an external (non-IG) system is backed by populated local tables. */
const BCP13 = "urn:ietf:bcp:13";
const BCP47 = "urn:ietf:bcp:47";
const MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}(\s*;\s*[a-z0-9!#$&^_.+-]+=("[^"]*"|[^;\s]+))*$/i;
const LANG_RE = /^[a-z]{2,3}(-[A-Za-z]{4})?(-([A-Z]{2}|\d{3}))?(-[A-Za-z0-9]{5,8})*$/;

/** Grammar-backed systems: membership of a well-formed code can be asserted without tables. */
function grammarLookup(system: string, code: string): LookupResult | null | undefined {
  if (system === BCP13) return MIME_RE.test(code) ? { display: null, definition: null } : null;
  if (system === BCP47) return LANG_RE.test(code) ? { display: null, definition: null } : null;
  return undefined;
}

export async function externalSystemHeld(system: string): Promise<boolean> {
  if (system === BCP13 || system === BCP47) return true;
  const kind = routeSystem(system);
  if (kind === "snomed") return tableHasRows("snomed.concepts");
  if (kind === "loinc") return tableHasRows("loinc.concepts");
  return false;
}

/**
 * LOINC properties a ValueSet compose filters on (FHIR LOINC CodeSystem property codes) →
 * loinc.concepts columns. CLASSTYPE is an integer in the table; filters give it as the
 * number or as its name (LOINC 2.77+ ValueSets write "Laboratory class").
 */
const LOINC_FILTER_COLUMNS: Record<string, string> = {
  STATUS: "status",
  CLASS: "class",
  CLASSTYPE: "classtype",
  COMPONENT: "component",
  PROPERTY: "property",
  TIME_ASPCT: "time_aspect",
  SYSTEM: "system",
  SCALE_TYP: "scale_type",
  METHOD_TYP: "method_type",
};
const LOINC_CLASSTYPES: Record<string, number> = { "laboratory class": 1, "clinical class": 2, "claims attachments": 3, surveys: 4 };

type LoincFilterRow = Record<string, string | number | null>;
const loincFilterRows = new TtlMemo<LoincFilterRow | null>(CACHE_TTL_MS, 5000);

/** DB errors are not cached (TtlMemo drops a rejected lookup): a transient failure must not decide later checks. */
function loincFilterRow(code: string): Promise<LoincFilterRow | null> {
  return loincFilterRows.get(code, () =>
    query<LoincFilterRow>(
      "SELECT status, class, classtype, component, property, time_aspect, system, scale_type, method_type FROM loinc.concepts WHERE loinc_num = $1",
      [code],
    ).then((r) => r.rows[0] ?? null),
  );
}

/** One `=` / `in` value against a LOINC column value: true / false, undefined when only the case differs. */
function loincValueMatches(column: string, actual: string | number, wanted: string): boolean | undefined {
  if (column === "classtype") {
    const w = wanted.trim();
    const n = /^\d+$/.test(w) ? Number(w) : LOINC_CLASSTYPES[w.toLowerCase()];
    return n === undefined ? undefined : Number(actual) === n;
  }
  const a = String(actual);
  if (a === wanted) return true;
  return a.toLowerCase() === wanted.toLowerCase() ? undefined : false;
}

/**
 * (v13) A compose filter on LOINC evaluated for one code from loinc.concepts: `=` / `in` on the
 * properties above, `concept in`. undefined for anything else (regex, is-a, parent …), for a
 * code that is not a LOINC term held locally, and for a NULL column.
 */
export async function externalFilterMatches(system: string, f: ComposeFilter, code: string): Promise<boolean | undefined> {
  const prop = String(f.property ?? "");
  const op = String(f.op ?? "");
  const value = String(f.value ?? "");
  if (routeSystem(system) === "snomed") return snomedFilterMatches(prop, op, value, code);
  if (system === "urn:iso:std:iso:3166") return iso3166FilterMatches(prop, op, value, code);
  if (system === "urn:ietf:bcp:47" && op === "exists" && (value === "true" || value === "false")) {
    // the terminology server's BCP-47 filters: `<part> exists true|false` on the parsed tag (us-core simple-language)
    const parts = languageTagParts(code);
    if (!parts || !(prop in parts)) return undefined;
    return parts[prop as keyof typeof parts] === (value === "true");
  }
  if (system === ICD10CM_URL) return icd10cmFilterMatches(prop, op, value, code);
  if (system === RXNORM_URL) return rxnormFilterMatches(prop, op, value, code);
  if (routeSystem(system) !== "loinc") return undefined;
  if (op === "regex") {
    // jar + tx.fhir.org: a find, not a full-string match (CLASS regex PATH holds PATH, PATH.PROTOCOLS.GENER and MOLPATH.MUT, not HEM/BC)
    const col = LOINC_FILTER_COLUMNS[prop];
    if (!col) return undefined;
    let re: RegExp;
    try {
      re = new RegExp(value);
    } catch {
      return undefined;
    }
    try {
      const v = (await loincFilterRow(code))?.[col];
      return v === null || v === undefined ? undefined : re.test(String(v));
    } catch {
      return undefined;
    }
  }
  if (op !== "=" && op !== "in") return undefined;
  const wanted = op === "in" ? value.split(",").map((v) => v.trim()).filter((v) => v !== "") : [value];
  if (!wanted.length) return undefined;
  if (prop === "concept" || prop === "code") return wanted.includes(code);
  const column = LOINC_FILTER_COLUMNS[prop.toUpperCase()];
  if (!column || prop !== prop.toUpperCase()) return undefined;
  let row: LoincFilterRow | null;
  try {
    row = await loincFilterRow(code);
  } catch {
    return undefined;
  }
  const actual = row ? row[column] : null;
  if (actual === null || actual === undefined) return undefined;
  let undecided = false;
  for (const w of wanted) {
    // A LOINC Part code as the value (SCALE_TYP = LP32888-7 "Doc", as tx.fhir.org accepts): compared by
    // the part's name. Axis parts (scale, property, time, system, method, class) are named exactly like
    // the LoincTable axis values; a component part names only the analyte, so it never decides "no".
    if (/^LP\d+-\d$/.test(w)) {
      const part = await loincOtherCode(w);
      const name = part && part.kind === "part" && typeof part.display === "string" && part.display ? part.display : null;
      const m = name === null ? undefined : loincValueMatches(column, actual, name);
      if (m === true) return true;
      if (m === undefined || column === "component" || column === "classtype") undecided = true;
      continue;
    }
    const m = loincValueMatches(column, actual, w);
    if (m === true) return true;
    if (m === undefined) undecided = true;
  }
  return undecided ? undefined : false;
}

const ICD10CM_URL = "http://hl7.org/fhir/sid/icd-10-cm";
const RXNORM_URL = "http://www.nlm.nih.gov/research/umls/rxnorm";

/** SNOMED CT `constraint` (the ECL local hierarchy can answer, fhirSimpleEcl.ts) and `concept is-not-a`. */
async function snomedFilterMatches(prop: string, op: string, value: string, code: string): Promise<boolean | undefined> {
  if (prop === "constraint" && op === "=") {
    const ecl = parseSimpleEcl(value);
    return ecl ? simpleEclContains(ecl, code, snomedSubsumedBy) : undefined;
  }
  if (prop === "concept" && op === "is-not-a") {
    const sub = await snomedSubsumedBy(code, value);
    return sub === undefined ? undefined : !sub;
  }
  return undefined;
}

/** ISO 3166: the alpha-2 / alpha-3 / numeric value sets are regex filters over the bundled tx.fhir.org table. */
function iso3166FilterMatches(prop: string, op: string, value: string, code: string): boolean | undefined {
  if ((prop !== "code" && prop !== "concept") || op !== "regex") return undefined;
  let re: RegExp;
  try {
    re = new RegExp(`^(?:${value})$`, "u");
  } catch {
    return undefined;
  }
  return re.test(code) && Object.hasOwn(ISO3166_DISPLAY, code);
}

/** ICD-10-CM hierarchy: a code's ancestors are its prefixes (category, subcategories, the 7th-character parent). */
async function icd10cmFilterMatches(prop: string, op: string, value: string, code: string): Promise<boolean | undefined> {
  if (prop !== "concept" || (op !== "is-a" && op !== "descendent-of")) return undefined;
  const r = await query<{ code: string }>("SELECT code FROM icd.diagnoses WHERE code = ANY($1::text[])", [[code, value]]);
  const held = new Set(r.rows.map((x) => x.code));
  if (!held.has(code) || !held.has(value)) return undefined;
  if (code === value) return op === "is-a";
  return code.startsWith(value);
}

/** RxNorm term type of a concept held locally. */
async function rxnormFilterMatches(prop: string, op: string, value: string, code: string): Promise<boolean | undefined> {
  if ((prop !== "TTY" && prop !== "tty") || (op !== "=" && op !== "in")) return undefined;
  if (!/^\d{1,15}$/.test(code)) return undefined;
  const r = await query<{ tty: string }>("SELECT tty FROM rxnorm.concepts WHERE rxcui = $1", [code]);
  if (!r.rows.length) return undefined;
  const wanted = op === "in" ? value.split(",").map((v) => v.trim()) : [value];
  return r.rows.some((x) => wanted.includes(x.tty));
}

async function lookupExternalTables(system: string | null | undefined, code: string): Promise<LookupResult | null> {
  if (system) {
    const g = grammarLookup(system, code);
    if (g !== undefined) return g;
  }
  const kind = routeSystem(system);
  if (kind === "snomed") {
    if (!isDigits(code)) return null;
    const row = (
      await query<{ term: string }>(
        "SELECT term FROM snomed.descriptions WHERE concept_id = $1 AND active = TRUE " +
          "ORDER BY us_preferred DESC NULLS LAST LIMIT 1",
        [code],
      )
    ).rows[0];
    return row ? { display: row.term, definition: null } : null;
  }
  if (kind === "loinc") {
    const row = (
      await query<{ long_common_name: string; shortname: string }>(
        "SELECT long_common_name, shortname FROM loinc.concepts WHERE loinc_num = $1",
        [code],
      )
    ).rows[0];
    if (row) {
      const tx = txDisplays("http://loinc.org", code, (await loincEdition())?.version ?? null);
      return { display: tx ? tx.displays[0] : row.long_common_name, definition: row.shortname };
    }
    // LA / LP / LL codes (not LG: tx.fhir.org does not serve LOINC groups).
    if (/^L[APL]\d+-\d$/.test(code)) {
      const other = await loincOtherCode(code);
      if (other && other.display) return { display: other.display, definition: other.altDisplay };
    }
    return null;
  }
  if (system === "http://hl7.org/fhir/sid/cvx") {
    const row = CVX_CODES[code];
    return row ? { display: row[0], definition: row[1] } : null;
  }
  if (system === "http://hl7.org/fhir/sid/icd-10") {
    const row = await icd10WhoRow(code);
    return row ? { display: row.display, definition: row.altDisplays[0] ?? null } : null;
  }
  if (kind === "icd_dx" && system === "http://hl7.org/fhir/sid/icd-10-cm") {
    const row = await icd10cmRow(code);
    return row ? { display: row.name_en, definition: row.name_zh } : null;
  }
  if (kind === "icd_dx" || kind === "icd_pcs") {
    const table = kind === "icd_dx" ? "icd.diagnoses" : "icd.procedures";
    const row = (
      await query<{ name_en: string; name_zh: string }>(`SELECT name_en, name_zh FROM ${table} WHERE code = $1`, [code])
    ).rows[0];
    return row ? { display: row.name_en, definition: row.name_zh } : null;
  }
  return null;
}

/**
 * Display strings a code may legitimately carry in an external system, as the
 * HL7 terminology server (tx.fhir.org) accepts them for Coding.display:
 *  - LOINC: LONG_COMMON_NAME and SHORTNAME (not the consumer / display name,
 *    not linguistic variants) — confirmed against validator_cli 7.0.1;
 *  - SNOMED CT: every *active* English FSN / synonym of the concept. tx.fhir.org
 *    (as used by validator_cli 7.0.1) rejects inactive descriptions ("is no
 *    longer considered a correct display ... (status = inactive)");
 *  - ICD-10-CM: the single tabular description.
 * null = code not held locally.
 */
export async function externalDisplays(
  system: string,
  code: string,
): Promise<{ displays: string[] } | null> {
  const kind = routeSystem(system);
  if (kind === "snomed") {
    if (!isDigits(code)) return null;
    const rows = (
      await query<{ term: string }>("SELECT term FROM snomed.descriptions WHERE concept_id = $1 AND active = TRUE", [code])
    ).rows;
    if (!rows.length) return null;
    return { displays: rows.map((r) => r.term) };
  }
  if (kind === "loinc") {
    const row = (
      await query<{ long_common_name: string | null; shortname: string | null }>(
        "SELECT long_common_name, shortname FROM loinc.concepts WHERE loinc_num = $1",
        [code],
      )
    ).rows[0];
    if (!row) return null;
    // ISSUES_v17.5: the reference server's displays when the local release is older (renamed codes, DisplayName)
    const tx = txDisplays(system, code, (await loincEdition())?.version ?? null);
    if (tx) return { displays: tx.displays };
    const out: string[] = [];
    for (const v of [row.long_common_name, row.shortname]) if (typeof v === "string" && v) out.push(v);
    return { displays: out };
  }
  if (kind === "icd_dx" && system === "http://hl7.org/fhir/sid/icd-10-cm") {
    const row = await icd10cmRow(code);
    if (!row) return null;
    // tx.fhir.org: display = CMS long title; the CMS short title is an English
    // synonym designation and also accepted as Coding.display.
    const displays: string[] = [];
    for (const v of [row.name_en, row.short_name_en]) if (typeof v === "string" && v) displays.push(v);
    return { displays };
  }
  return null;
}

/** Whether the local ICD-10-CM diagnosis table is populated. */
export async function icd10cmHeld(): Promise<boolean> {
  return tableHasRows("icd.diagnoses");
}

/**
 * ICD-10-CM row by code. tx.fhir.org matches ICD-10-CM codes case-insensitively
 * (`s93.411a` validates as S93.411A), so an exact miss retries upper-cased.
 * `short_name_en` is absent on databases without the 20261017 migration.
 */
async function icd10cmRow(
  code: string,
): Promise<{ code: string; name_en: string | null; name_zh: string | null; short_name_en: string | null } | null> {
  const run = async (sql: string): Promise<any | null> => {
    const exact = (await query(sql, [code])).rows[0];
    if (exact || code.toUpperCase() === code) return exact ?? null;
    return (await query(sql, [code.toUpperCase()])).rows[0] ?? null;
  };
  try {
    return await run("SELECT code, name_en, name_zh, short_name_en FROM icd.diagnoses WHERE code = $1");
  } catch {
    const row = await run("SELECT code, name_en, name_zh FROM icd.diagnoses WHERE code = $1");
    return row ? { ...row, short_name_en: null } : null;
  }
}

/** Loaded ICD-10-CM edition (icd.editions), or null when not recorded. */
export interface Icd10cmEditionInfo {
  edition: string;
  sourceFormat: string;
  complete: boolean;
  codeCount: number;
}

const editionCache = new TtlCache<Icd10cmEditionInfo | null>();

export async function icd10cmEdition(): Promise<Icd10cmEditionInfo | null> {
  const hit = editionCache.get("icd-10-cm");
  if (hit !== undefined) return hit;
  let info: Icd10cmEditionInfo | null = null;
  try {
    const row = (
      await query<{ edition: string; source_format: string; complete: boolean; code_count: number }>(
        "SELECT edition, source_format, complete, code_count FROM icd.editions WHERE code_system = 'icd-10-cm'",
      )
    ).rows[0];
    if (row) {
      info = { edition: row.edition, sourceFormat: row.source_format, complete: row.complete === true, codeCount: Number(row.code_count) };
    }
  } catch (e) {
    // table missing (migration 20261017 not applied) → treated as incomplete; a transient failure is not remembered
    if (!schemaMissing(e)) return null;
    info = null;
  }
  editionCache.set("icd-10-cm", info);
  return info;
}

// --------------------------------------------------------------------------- //
// Validator lookups for LOINC non-term codes, SNOMED CT inactive content and
// WHO ICD-10 (tables from db/migrations/20261018_terminology_completeness_v4.sql).
// Every function degrades to "not held" when those tables / columns are absent.
// --------------------------------------------------------------------------- //

const loincEditionCache = new TtlCache<{ version: string } | null>();
const snomedEditionCache = new TtlCache<SnomedEditionInfo | null>();
const whoEditionCache = new TtlCache<{ edition: string; complete: boolean } | null>();

/** LA / LP / LL / LG row from loinc.other_codes, or null. */
export async function loincOtherCode(code: string): Promise<LoincOtherRow | null> {
  try {
    const row = (
      await query<{ kind: string; display: string | null; alt_display: string | null; status: string | null }>(
        "SELECT kind, display, alt_display, status FROM loinc.other_codes WHERE code = $1",
        [code],
      )
    ).rows[0];
    return row ? { kind: row.kind, display: row.display, altDisplay: row.alt_display, status: row.status } : null;
  } catch {
    return null;
  }
}

/** Whether loinc.other_codes is populated (the answer / part files were imported). */
export async function loincOtherCodesHeld(): Promise<boolean> {
  return tableHasRows("loinc.other_codes");
}

/** Loaded LOINC version (loinc.editions), or null. */
export async function loincEdition(): Promise<{ version: string } | null> {
  const hit = loincEditionCache.get("loinc");
  if (hit !== undefined) return hit;
  let info: { version: string } | null = null;
  try {
    const row = (await query<{ version: string }>("SELECT version FROM loinc.editions WHERE code_system = 'loinc'")).rows[0];
    info = row ? { version: row.version } : null;
  } catch (e) {
    if (!schemaMissing(e)) return null; // transient: answered as unknown, not remembered
    info = null;
  }
  loincEditionCache.set("loinc", info);
  return info;
}

/** Loaded SNOMED CT edition (snomed.editions), or null. */
export async function snomedEdition(): Promise<SnomedEditionInfo | null> {
  const hit = snomedEditionCache.get("snomed");
  if (hit !== undefined) return hit;
  let info: SnomedEditionInfo | null = null;
  try {
    const row = (
      await query<{ module_id: string; version_date: string; includes_inactive: boolean }>(
        "SELECT module_id, to_char(version_date, 'YYYY-MM-DD') AS version_date, includes_inactive FROM snomed.editions WHERE code_system = 'snomed'",
      )
    ).rows[0];
    info = row ? { moduleId: String(row.module_id), versionDate: row.version_date, includesInactive: row.includes_inactive === true } : null;
  } catch (e) {
    if (!schemaMissing(e)) return null; // transient: answered as unknown, not remembered
    info = null;
  }
  snomedEditionCache.set("snomed", info);
  return info;
}

const DATE = (col: string): string => `to_char(${col}, 'YYYY-MM-DD')`;

/** SNOMED CT concept (active table first, then snomed.inactive_concepts), or null. */
export async function snomedConcept(code: string): Promise<SnomedConceptRow | null> {
  if (!isDigits(code)) return null;
  try {
    const a = (
      await query<{ first_released: string | null }>(
        `SELECT ${DATE("first_released")} AS first_released FROM snomed.concepts WHERE concept_id = $1`,
        [code],
      )
    ).rows[0];
    if (a) return { active: true, effectiveTime: null, firstReleased: a.first_released };
    const i = (
      await query<{ effective_time: string | null; first_released: string | null }>(
        `SELECT ${DATE("effective_time")} AS effective_time, ${DATE("first_released")} AS first_released FROM snomed.inactive_concepts WHERE concept_id = $1`,
        [code],
      )
    ).rows[0];
    return i ? { active: false, effectiveTime: i.effective_time, firstReleased: i.first_released } : null;
  } catch {
    // Pre-20261018 database: active concepts only, no release dates.
    try {
      const a = (await query("SELECT 1 FROM snomed.concepts WHERE concept_id = $1", [code])).rows[0];
      return a ? { active: true, effectiveTime: null, firstReleased: null } : null;
    } catch {
      return null;
    }
  }
}

/**
 * Every English FSN / synonym of a concept: snomed.descriptions + snomed.inactive_descriptions, in the order tx.fhir.org
 * lists a concept's displays — the preferred term (US-preferred synonym) first, then by description id (official corpus:
 * 'Malignant neoplasm of ovary, Malignant tumour of ovary, …, Malignant neoplasm of ovary (disorder)', 'Penicillin,
 * Substance with penicillin structure (substance), Substance with penicillin structure').
 */
export async function snomedConceptDescriptions(code: string): Promise<SnomedDescriptionRow[]> {
  if (!isDigits(code)) return [];
  try {
    return (
      await query<{ term: string; active: boolean; effective_time: string | null; first_released: string | null }>(
        `SELECT term, active, effective_time, first_released FROM (
           SELECT term, active, NULL::text AS effective_time, ${DATE("first_released")} AS first_released,
                  (type_id = 900000000000013009 AND us_preferred) AS pt, description_id
             FROM snomed.descriptions WHERE concept_id = $1 AND active = TRUE
           UNION ALL
           SELECT term, active, ${DATE("effective_time")}, ${DATE("first_released")}, FALSE, description_id
             FROM snomed.inactive_descriptions WHERE concept_id = $1
         ) d ORDER BY pt DESC, description_id`,
        [code],
      )
    ).rows.map((r) => ({ term: r.term, active: r.active === true, effectiveTime: r.effective_time, firstReleased: r.first_released }));
  } catch {
    try {
      return (
        await query<{ term: string }>("SELECT term FROM snomed.descriptions WHERE concept_id = $1 AND active = TRUE", [code])
      ).rows.map((r) => ({ term: r.term, active: true, effectiveTime: null, firstReleased: null }));
    } catch {
      return [];
    }
  }
}

/** WHO ICD-10 row (case-sensitive, as tx.fhir.org), or null. */
export async function icd10WhoRow(code: string): Promise<Icd10WhoRow | null> {
  try {
    const row = (
      await query<{ display: string; alt_displays: string[] | null }>("SELECT display, alt_displays FROM icd.icd10_who WHERE code = $1", [code])
    ).rows[0];
    return row ? { display: row.display, altDisplays: row.alt_displays ?? [] } : null;
  } catch {
    return null;
  }
}

/** Whether a WHO ICD-10 table is loaded. */
export async function icd10WhoHeld(): Promise<boolean> {
  return tableHasRows("icd.icd10_who");
}

export async function icd10WhoEdition(): Promise<{ edition: string; complete: boolean } | null> {
  const hit = whoEditionCache.get("icd-10");
  if (hit !== undefined) return hit;
  let info: { edition: string; complete: boolean } | null = null;
  try {
    const row = (
      await query<{ edition: string; complete: boolean }>("SELECT edition, complete FROM icd.editions WHERE code_system = 'icd-10'")
    ).rows[0];
    info = row ? { edition: row.edition, complete: row.complete === true } : null;
  } catch (e) {
    if (!schemaMissing(e)) return null; // transient: answered as unknown, not remembered
    info = null;
  }
  whoEditionCache.set("icd-10", info);
  return info;
}

// --------------------------------------------------------------------------- //
// RxNorm (rxnorm.concepts: one row per RXCUI, SAB=RXNORM; alt_names = the other
// RXNORM atom strings, filled by the RxNorm import since migration 20261030).
// --------------------------------------------------------------------------- //

export interface RxnormRow {
  name: string;
  /** Other SAB=RXNORM atom strings of the RXCUI; null on a database imported before 20261030. */
  altNames: string[] | null;
  tty: string | null;
  suppress: string | null;
}

/** RxNorm concept by RXCUI, or null (also when the table / column is missing). */
export async function rxnormConcept(code: string): Promise<RxnormRow | null> {
  if (!isDigits(code)) return null;
  try {
    const row = (
      await query<{ name: string; alt_names: string[] | null; tty: string | null; suppress: string | null }>(
        "SELECT name, alt_names, tty, suppress FROM rxnorm.concepts WHERE rxcui = $1",
        [code],
      )
    ).rows[0];
    return row ? { name: row.name, altNames: row.alt_names ?? null, tty: row.tty, suppress: row.suppress } : null;
  } catch {
    try {
      const row = (await query<{ name: string; tty: string | null; suppress: string | null }>("SELECT name, tty, suppress FROM rxnorm.concepts WHERE rxcui = $1", [code])).rows[0];
      return row ? { name: row.name, altNames: null, tty: row.tty, suppress: row.suppress } : null;
    } catch {
      return null;
    }
  }
}

/** Whether rxnorm.concepts is populated. */
export async function rxnormHeld(): Promise<boolean> {
  return tableHasRows("rxnorm.concepts");
}

const rxnormEditionCache = new TtlCache<{ version: string; releaseDate: string | null } | null>();

/** Loaded RxNorm release (rxnorm.editions, migration 20261030), or null. */
export async function rxnormEdition(): Promise<{ version: string; releaseDate: string | null } | null> {
  const hit = rxnormEditionCache.get("rxnorm");
  if (hit !== undefined) return hit;
  let info: { version: string; releaseDate: string | null } | null = null;
  try {
    const row = (
      await query<{ version: string; release_date: string | null }>(
        "SELECT version, to_char(release_date, 'YYYY-MM-DD') AS release_date FROM rxnorm.editions WHERE code_system = 'rxnorm'",
      )
    ).rows[0];
    info = row ? { version: row.version, releaseDate: row.release_date } : null;
  } catch (e) {
    if (!schemaMissing(e)) return null; // transient: answered as unknown, not remembered
    info = null;
  }
  rxnormEditionCache.set("rxnorm", info);
  return info;
}

/** Resolve a `(system, code)` to `{display, definition}` from local data, or null. */
export async function lookup(
  system: string | null | undefined,
  code: string,
  pkg: PackageRow,
  csId: string | null = null,
): Promise<LookupResult | null> {
  const kind = routeSystem(system, csId);
  if (kind === "snomed" || kind === "loinc") return lookupExternalTables(system, code);
  if (system === "http://hl7.org/fhir/sid/cvx" || system === "http://hl7.org/fhir/sid/icd-10") return lookupExternalTables(system, code);
  if (system === RXNORM_SYSTEM) {
    // RxNorm (concept-only reference table): preferred name of the RXCUI.
    const row = await rxnormConcept(code);
    return row ? { display: row.name, definition: null } : null;
  }
  if (system) {
    // Prefer the IG-held CodeSystem (full nested hierarchy).
    const idx = await loadCodeSystemIndex(system, pkg);
    if (idx) {
      const c = findConcept(idx, code);
      if (c) return { display: c.display, definition: null };
      if (idx.content === "complete") return null;
    }
  }
  if (kind === "icd_dx" || kind === "icd_pcs") {
    const hit = await lookupExternalTables(system, code);
    if (hit) return hit;
  }
  const tail = csId || canonicalTail(system);
  if (!tail) return null;
  const [pids, pvers] = closureArrays(pkg);
  const row = (
    await query<{ display: string; definition: string }>(
      "SELECT c.display, c.definition FROM fhir.concepts c " +
        "JOIN unnest($1::text[], $2::text[]) AS dep(pid, pver) " +
        "  ON c.package_id = dep.pid AND c.package_version = dep.pver " +
        "WHERE c.cs_id = $3 AND c.code = $4 LIMIT 1",
      [pids, pvers, tail, code],
    )
  ).rows[0];
  return row ? { display: row.display, definition: row.definition } : null;
}

/** Concept ids that are `is-a` descendants of `code` (inclusive), capped. */
export async function snomedDescendants(code: string, limit: number): Promise<number[]> {
  if (!isDigits(code)) return [];
  const rows = (
    await query<{ concept_id: number }>(
      `
      WITH RECURSIVE descendants AS (
          SELECT concept_id FROM snomed.concepts WHERE concept_id = $1
          UNION
          SELECT r.source_id
          FROM snomed.relationships r
          JOIN descendants d ON r.destination_id = d.concept_id
          WHERE r.type_id = $2 AND r.active = TRUE
      )
      SELECT concept_id FROM descendants LIMIT $3
      `,
      [code, SNOMED_IS_A, limit],
    )
  ).rows;
  return rows.map((r) => r.concept_id);
}

/** Is SNOMED `code` equal to or an is-a descendant of `ancestor`? (walks upward — cheap). */
export async function snomedSubsumedBy(code: string, ancestor: string): Promise<boolean | undefined> {
  if (!isDigits(code) || !isDigits(ancestor)) return undefined;
  if (code === ancestor) return true;
  if (!(await tableHasRows("snomed.relationships"))) return undefined;
  const rows = (
    await query<{ hit: number }>(
      `
      WITH RECURSIVE ancestors AS (
          SELECT destination_id AS id FROM snomed.relationships
          WHERE source_id = $1 AND type_id = $3 AND active = TRUE
          UNION
          SELECT r.destination_id FROM snomed.relationships r
          JOIN ancestors a ON r.source_id = a.id
          WHERE r.type_id = $3 AND r.active = TRUE
      )
      SELECT 1 AS hit FROM ancestors WHERE id = $2 LIMIT 1
      `,
      [code, ancestor, SNOMED_IS_A],
    )
  ).rows;
  if (rows.length) return true;
  // an inactive concept is known too: it has no active is-a, so it is in no hierarchy (official: not in the value set)
  return (await snomedConcept(code)) ? false : undefined;
}

export async function snomedDisplays(ids: Array<number | string>): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (!ids.length) return out;
  const rows = (
    await query<{ concept_id: number; term: string }>(
      `
      SELECT DISTINCT ON (concept_id) concept_id, term
      FROM snomed.descriptions
      WHERE concept_id = ANY($1::bigint[]) AND active = TRUE
      ORDER BY concept_id, us_preferred DESC NULLS LAST
      `,
      [ids],
    )
  ).rows;
  for (const r of rows) out.set(Number(r.concept_id), r.term);
  return out;
}

/**
 * DB-backed dependencies for the pure terminology core, scoped to a package
 * closure. `exactCodeSystems` (FHIR validation) resolves CodeSystems by exact
 * canonical only, like the HL7 validator.
 */
export function dbTerminologyDeps(pkg: PackageRow, exactCodeSystems = false): TerminologyDeps {
  return {
    loadValueSet: (url) => loadValueSet(url, pkg),
    loadCodeSystem: (url) => loadCodeSystemIndex(url, pkg, exactCodeSystems),
    lookupExternal: (system, code) => lookupExternalTables(system, code),
    externalSystemHeld: (system) => externalSystemHeld(system),
    externalFilter: (system, f, code) => externalFilterMatches(system, f, code),
    systemUnknown: async (system) => !terminologyServerKnows(system) && !(await externalSystemHeld(system)),
    snomedSubsumedBy: (code, ancestor) => snomedSubsumedBy(code, ancestor),
    snomedDescendants: async (code, limit) => (await snomedDescendants(code, limit)).map(String),
    snomedDisplays: async (codes) => {
      const m = await snomedDisplays(codes);
      const out = new Map<string, string>();
      for (const [k, v] of m) out.set(String(k), v);
      return out;
    },
  };
}

/** Tiered expansion of a ValueSet `compose` block (nested hierarchies included). */
export async function expandCompose(
  compose: Record<string, any>,
  pkg: PackageRow,
  limit: number = DEFAULT_EXPAND_LIMIT,
): Promise<ExpandResult> {
  return expandComposeWith(compose || {}, dbTerminologyDeps(pkg), limit);
}

/** Rule-based membership (no expansion cap). undefined = cannot be decided locally. */
export async function valueSetMembership(
  vsUrl: string,
  system: string | null,
  code: string,
  pkg: PackageRow,
  exactCodeSystems = false,
): Promise<boolean | undefined> {
  return valueSetContains(vsUrl, system, code, dbTerminologyDeps(pkg, exactCodeSystems));
}

/** Does the package closure hold a CodeSystem with exactly this canonical (any content mode)? */
export async function codeSystemInClosure(url: string, pkg: PackageRow): Promise<boolean> {
  return hasArtifactByCanonical("CodeSystem", url, pkg);
}
