/**
 * FHIR IG package registry helpers — multi-IG foundation.
 *
 * Resolves which `fhir.*` package a request targets, walks a package's declared
 * dependencies (closure, with missing dependencies reported), and resolves
 * canonical URLs — optionally pinned to a version — inside a closure.
 * Dependency-free apart from the pg pool.
 *
 * ---------------------------------------------------------------------------
 * PUBLIC CONTRACT (used by fhirIgService.ts and the validator — keep stable)
 * ---------------------------------------------------------------------------
 *
 * Version ordering (SemVer 2.0 precedence; FHIR labels such as -ballot,
 * -snapshot1, -cibuild, -ballot-tc1 are pre-releases):
 *   compareVersions(a: string, b: string): number          // <0 | 0 | >0
 *   isPrerelease(v: string): boolean
 *   latestVersion(versions: string[], opts?: { includePrerelease?: boolean }): string | null
 *       // highest release; a pre-release only when no release exists (or includePrerelease)
 *   versionMatches(requested: string, actual: string | null | undefined): boolean
 *       // HL7 rule (pickCanonicalVersion): exact, else highest of the same major.minor, else wildcard
 *   splitCanonical(canonical: string): { url: string; version: string | null }   // "url|ver"
 *
 * Canonical lookup:
 *   resolveCanonical(url: string, packageId: string, packageVersion: string)
 *       : Promise<Record<string, unknown> | null>
 *       // unchanged legacy lookup: BFS over the closure, first package holding `url` (exact string)
 *   resolveCanonicalVersioned(
 *       url: string,                                   // may carry "|version"
 *       closure: Array<[string, string]> | PackageRow, // closure pairs, or a row with `_closure`
 *       opts?: { version?: string | null; resourceType?: string | null },
 *   ): Promise<Record<string, unknown> | null>
 *       // The fhir.artifacts row (all columns + package_fhir_version) for the canonical in the
 *       // closure. With a version (opts.version wins over "|version" in url) only an artifact whose
 *       // own version (raw_json.version, else its package version) matches is returned; null when
 *       // that version is not in the closure ("profile/version not found"). Without a version the
 *       // pick follows fhirTerminology.rankCandidates (same as the validator's loader).
 *   findPackagesForCanonical(url: string, version?: string | null): Promise<CanonicalOwner[]>
 *       // reverse lookup over ALL installed packages; best owner first
 *       // (manual install > default IG > release > higher version > package_id)
 *
 * Closure:
 *   packageClosure(packageId, packageVersion): Promise<Array<[string, string]>>   // unchanged
 *   packageClosureInfo(packageId, packageVersion): Promise<ClosureInfo>
 *       // { closure, depsMissing: [{package_id, version, required_by}] } (r4.core 4.0.0 → 4.0.1 alias)
 *   closureVersions(closure): Record<string, ClosureVersionUse> | null
 *       // packages present at several versions in the closure, and which one canonical lookup uses
 *
 * Target resolution (every FHIR IG tool):
 *   resolvePackage(ig?: IGSelector | null): Promise<[string, string]>
 *       // null → default IG → the only manually-installed IG → NoDefaultIGError (code NO_DEFAULT_IG)
 *   resolveTarget(opts: ResolveTargetOptions): Promise<ResolvedTarget>
 *       // precedence: explicit |version on a canonical → package_id/version → owner of the
 *       // meta.profile / canonical arguments → default IG → the only manual IG; see ResolvedBy.
 */

import { pickCanonicalVersion } from "./fhirValidator.js";
import { query } from "./db.js";
import { canonicalDependencyVersion } from "./loaders/igRegistry.js";
import { rankCandidates } from "./fhirTerminology.js";

export class IGNotFoundError extends Error {
  code = "IG_NOT_FOUND";
  constructor(message: string) {
    super(message);
    this.name = "IGNotFoundError";
  }
}

/** No package_id was given and no default IG is set (and not exactly one manually-installed IG). */
export class NoDefaultIGError extends IGNotFoundError {
  constructor() {
    super(
      "未設定預設 IG：請在管理介面 (IG 套件) 設定預設 IG，或在呼叫時指定 package_id。 / " +
        "No default IG is set: set a default IG in the admin console (IG packages) or pass package_id.",
    );
    this.code = "NO_DEFAULT_IG";
    this.name = "NoDefaultIGError";
  }
}

// --------------------------------------------------------------------------- //
// Test seam: every DB read of this module goes through runQuery.
// --------------------------------------------------------------------------- //

type QueryFn = (text: string, params?: unknown[]) => Promise<{ rows: any[] }>;
let runQuery: QueryFn = (text, params) => query(text, params ?? []);

/** Replace the query function (unit tests: a fake over in-memory rows). Pass null to restore. */
export function setIgQueryForTests(fn: QueryFn | null): void {
  runQuery = fn ?? ((text, params) => query(text, params ?? []));
  installOriginColumn = null;
}

// --------------------------------------------------------------------------- //
// Version ordering (SemVer 2.0 precedence)
// --------------------------------------------------------------------------- //

interface ParsedVersion {
  core: number[];
  pre: string[] | null;
}

function parseVersion(version: string): ParsedVersion {
  const v = String(version ?? "").trim().replace(/^v(?=\d)/i, "");
  const noBuild = v.split("+")[0];
  const m = /^(\d+(?:\.\d+)*)(?:-(.*))?$/.exec(noBuild);
  if (!m) {
    // Not a dotted number (e.g. "current", "dev"): lowest precedence, a pre-release of 0.
    return { core: [], pre: [noBuild || ""] };
  }
  return {
    core: m[1].split(".").map((x) => parseInt(x, 10)),
    pre: m[2] !== undefined ? m[2].split(".") : null,
  };
}

/** Natural compare of one alphanumeric identifier (digit runs numerically: ballot2 < ballot10). */
function cmpNatural(a: string, b: string): number {
  const ra = a.match(/\d+|\D+/g) || [];
  const rb = b.match(/\d+|\D+/g) || [];
  for (let i = 0; i < Math.max(ra.length, rb.length); i++) {
    const x = ra[i];
    const y = rb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const dx = /^\d/.test(x);
    const dy = /^\d/.test(y);
    if (dx && dy) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d;
    } else if (dx !== dy) {
      return dx ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

function cmpPreIdent(a: string, b: string): number {
  const na = /^\d+$/.test(a);
  const nb = /^\d+$/.test(b);
  if (na && nb) return Number(a) - Number(b);
  if (na !== nb) return na ? -1 : 1; // numeric identifiers have lower precedence
  return cmpNatural(a, b);
}

/**
 * SemVer 2.0 precedence: core numbers compared numerically (missing parts = 0); a
 * pre-release sorts below the release of the same core; pre-release identifiers
 * compare numerically when numeric, else naturally; build metadata is ignored.
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < Math.max(pa.core.length, pb.core.length); i++) {
    const d = (pa.core[i] ?? 0) - (pb.core[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (pa.pre === null && pb.pre === null) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const d = cmpPreIdent(x, y);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export function isPrerelease(version: string): boolean {
  return parseVersion(version).pre !== null;
}

/** Highest release; a pre-release only when no release exists (or includePrerelease). */
export function latestVersion(versions: string[], opts: { includePrerelease?: boolean } = {}): string | null {
  const all = versions.filter((v) => typeof v === "string");
  if (!all.length) return null;
  const releases = all.filter((v) => !isPrerelease(v));
  const pool = opts.includePrerelease || !releases.length ? all : releases;
  return [...pool].sort((x, y) => compareVersions(y, x) || (x < y ? -1 : x > y ? 1 : 0))[0];
}

/**
 * Does an artifact/package version satisfy a requested canonical version? Exact match,
 * or a partial release-line request ("1.0", "1.0.x") matching the same major.minor
 * (FHIR canonical version matching, as the HL7 validator does).
 */
export function versionMatches(requested: string, actual: string | null | undefined): boolean {
  if (actual === null || actual === undefined) return false;
  const req = String(requested).trim();
  const act = String(actual).trim();
  if (req === act) return true;
  const line = /^(\d+)\.(\d+)(?:\.x)?$/.exec(req);
  if (!line) return false;
  const pa = parseVersion(act);
  return pa.pre === null && pa.core[0] === Number(line[1]) && pa.core[1] === Number(line[2]);
}

/**
 * Keep the candidates whose version HL7 would pick for `requested`
 * (CanonicalResourceManager.getByPackage, 7.0.1: exact, else the highest of the
 * same major.minor line, else wildcard) — the same rule the validator applies
 * via pickCanonicalVersion, so "|1.0.9" resolves to 1.0.0 everywhere.
 */
function filterRequestedVersion<T>(items: T[], requested: string, versionOf: (t: T) => string | null | undefined): T[] {
  const versions = [...new Set(items.map(versionOf).filter((v): v is string => typeof v === "string"))];
  const picked = pickCanonicalVersion(versions.map((version) => ({ version })), requested);
  return picked ? items.filter((t) => versionOf(t) === picked.version) : [];
}

/** HL7 same-major.minor fallback for a single candidate (used where a boolean is needed). */
function hl7LineMatch(requested: string, actual: string | null | undefined): boolean {
  return typeof actual === "string" && pickCanonicalVersion([{ version: actual }], requested) !== null;
}

/** "url|version" → {url, version}; version null when absent or empty. */
export function splitCanonical(canonical: string): { url: string; version: string | null } {
  const s = String(canonical ?? "");
  const i = s.indexOf("|");
  if (i < 0) return { url: s, version: null };
  const version = s.slice(i + 1).trim();
  return { url: s.slice(0, i), version: version || null };
}

// --------------------------------------------------------------------------- //
// Registry
// --------------------------------------------------------------------------- //

/** Coerce a stored `dependencies` value into a `{packageId: version}` map. */
export function normalizeDependencies(deps: unknown): Record<string, string> {
  if (!deps) return {};
  let value: unknown = deps;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return {};
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[String(k)] = String(v);
    }
    return out;
  }
  return {};
}

export interface IGSelector {
  packageId?: string | null;
  package_id?: string | null;
  version?: string | null;
}

export interface PackageRow {
  package_id: string;
  version: string;
  canonical?: string | null;
  fhir_version?: string | null;
  title?: string | null;
  status?: string | null;
  is_default?: boolean | null;
  dependencies?: unknown;
  imported_at?: unknown;
  /** 'manual' | 'dependency' (migration 20261019); null when the column is absent. */
  install_origin?: string | null;
  _closure?: Array<[string, string]>;
  [key: string]: unknown;
}

const PACKAGE_COLS =
  "package_id, version, canonical, fhir_version, title, status, is_default, dependencies, imported_at";

/** null = not probed yet; true/false once known (a missing column is re-probed after setIgQueryForTests). */
let installOriginColumn: boolean | null = null;

function isUndefinedColumn(e: unknown): boolean {
  return Boolean(e && typeof e === "object" && (e as { code?: string }).code === "42703");
}

/** Every installed package row (dependencies normalized; install_origin null when the column is absent). */
export async function loadRegistry(): Promise<PackageRow[]> {
  let rows: PackageRow[];
  if (installOriginColumn !== false) {
    try {
      rows = (
        await runQuery(`SELECT ${PACKAGE_COLS}, install_origin FROM fhir.ig_packages ORDER BY is_default DESC, package_id, version`)
      ).rows;
      installOriginColumn = true;
    } catch (e) {
      if (!isUndefinedColumn(e)) throw e;
      installOriginColumn = false;
      rows = (await runQuery(`SELECT ${PACKAGE_COLS} FROM fhir.ig_packages ORDER BY is_default DESC, package_id, version`)).rows;
    }
  } else {
    rows = (await runQuery(`SELECT ${PACKAGE_COLS} FROM fhir.ig_packages ORDER BY is_default DESC, package_id, version`)).rows;
  }
  return rows.map((r) => ({ ...r, install_origin: r.install_origin ?? null, dependencies: normalizeDependencies(r.dependencies) }));
}

/** Pick the version of one package: the default IG's, else the highest release (pre-release only if none). */
function pickPackageVersion(rows: PackageRow[]): PackageRow {
  const def = rows.find((r) => r.is_default);
  if (def) return def;
  const best = latestVersion(rows.map((r) => r.version))!;
  return rows.find((r) => r.version === best)!;
}

/** Manually-installed IGs; null when install_origin is unknown (column absent). */
function manualIgs(registry: PackageRow[]): PackageRow[] | null {
  if (!registry.length || registry.every((r) => r.install_origin === null || r.install_origin === undefined)) return null;
  return registry.filter((r) => r.install_origin === "manual");
}

/** Default target without a package_id: the default IG, else the only manually-installed IG. */
function defaultTarget(registry: PackageRow[]): { row: PackageRow; by: "default_ig" | "sole_manual_ig" } {
  if (!registry.length) throw new IGNotFoundError("no IG packages installed");
  const def = registry.find((r) => r.is_default);
  if (def) return { row: def, by: "default_ig" };
  const manual = manualIgs(registry);
  if (manual && manual.length === 1) return { row: manual[0], by: "sole_manual_ig" };
  throw new NoDefaultIGError();
}

/** Resolve an IG selector to a concrete `[package_id, version]`. */
export async function resolvePackage(ig?: IGSelector | null): Promise<[string, string]> {
  const registry = await loadRegistry();
  if (ig) {
    const packageId = ig.packageId ?? ig.package_id;
    if (!packageId) throw new IGNotFoundError("ig.packageId is required");
    const row = selectPackage(registry, packageId, ig.version ?? null);
    return [row.package_id, row.version];
  }
  const { row } = defaultTarget(registry);
  return [row.package_id, row.version];
}

function selectPackage(registry: PackageRow[], packageId: string, version: string | null): PackageRow {
  const rows = registry.filter((r) => r.package_id === packageId);
  if (version) {
    const hit = rows.find((r) => r.version === version);
    if (!hit) throw new IGNotFoundError(`IG package not found: ${packageId}#${version}`);
    return hit;
  }
  if (!rows.length) throw new IGNotFoundError(`IG package not found: ${packageId}`);
  return pickPackageVersion(rows);
}

export async function resolveDefaultPackage(): Promise<[string, string] | null> {
  try {
    return await resolvePackage(null);
  } catch (e) {
    if (e instanceof IGNotFoundError) return null;
    throw e;
  }
}

// --------------------------------------------------------------------------- //
// Closure
// --------------------------------------------------------------------------- //

export interface DepMissing {
  package_id: string;
  /** Version looked for (after the r4.core 4.0.0 → 4.0.1 alias). */
  version: string;
  /** "package_id#version" of the package that declares the dependency. */
  required_by: string;
}

export interface ClosureInfo {
  /** Target first, then declared dependencies breadth-first (missing ones included, as before). */
  closure: Array<[string, string]>;
  depsMissing: DepMissing[];
}

/** Pure closure walk over registry rows (same order as the historical per-row queries). */
export function computeClosure(registry: PackageRow[], packageId: string, packageVersion: string): ClosureInfo {
  const byKey = new Map(registry.map((r) => [`${r.package_id} ${r.version}`, r]));
  const seen = new Set<string>();
  const closure: Array<[string, string]> = [];
  const depsMissing: DepMissing[] = [];
  const missingSeen = new Set<string>();
  const queue: Array<[string, string]> = [[packageId, packageVersion]];
  while (queue.length) {
    const [pid, pver] = queue.shift()!;
    const key = `${pid} ${pver}`;
    if (seen.has(key)) continue;
    seen.add(key);
    closure.push([pid, pver]);
    const row = byKey.get(key);
    if (!row) continue;
    for (const [depId, rawVer] of Object.entries(normalizeDependencies(row.dependencies))) {
      // A never-published declared version (core 4.0.0) means the one that exists (4.0.1).
      const depVer = canonicalDependencyVersion(depId, rawVer);
      const depKey = `${depId} ${depVer}`;
      if (!byKey.has(depKey) && !missingSeen.has(depKey)) {
        missingSeen.add(depKey);
        depsMissing.push({ package_id: depId, version: depVer, required_by: `${pid}#${pver}` });
      }
      if (!seen.has(depKey)) queue.push([depId, depVer]);
    }
  }
  return { closure, depsMissing };
}

export async function packageClosureInfo(packageId: string, packageVersion: string): Promise<ClosureInfo> {
  return computeClosure(await loadRegistry(), packageId, packageVersion);
}

/** Target package + transitive declared dependencies, breadth-first (target first). */
export async function packageClosure(packageId: string, packageVersion: string): Promise<Array<[string, string]>> {
  return (await packageClosureInfo(packageId, packageVersion)).closure;
}

export interface ClosureVersionUse {
  /** Version canonical lookups prefer when a canonical exists in several of them. */
  used: string;
  /** Every version of this package in the closure, in closure (breadth-first) order. */
  versions: string[];
  rule: "closure_order" | "newest_terminology";
}

/**
 * Packages present at more than one version in the closure, and which version a
 * canonical held by several of them resolves to (fhirTerminology.rankCandidates):
 * hl7.terminology.* → newest (THO canonicals), everything else → first in closure order.
 * null when every package appears once.
 */
export function closureVersions(closure: Array<[string, string]>): Record<string, ClosureVersionUse> | null {
  const by = new Map<string, string[]>();
  for (const [pid, ver] of closure) {
    const list = by.get(pid) ?? [];
    if (!list.includes(ver)) list.push(ver);
    by.set(pid, list);
  }
  const out: Record<string, ClosureVersionUse> = {};
  for (const [pid, versions] of [...by.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (versions.length < 2) continue;
    if (pid.startsWith("hl7.terminology")) {
      const newest = [...versions].sort((x, y) => compareVersions(y, x))[0];
      out[pid] = { used: newest, versions, rule: "newest_terminology" };
    } else {
      out[pid] = { used: versions[0], versions, rule: "closure_order" };
    }
  }
  return Object.keys(out).length ? out : null;
}

// --------------------------------------------------------------------------- //
// Canonical lookup
// --------------------------------------------------------------------------- //

/** Resolve a canonical URL to an artifact row across the dependency closure (legacy, exact url). */
export async function resolveCanonical(
  url: string,
  packageId: string,
  packageVersion: string,
): Promise<Record<string, unknown> | null> {
  const { closure } = await packageClosureInfo(packageId, packageVersion);
  for (const [pid, pver] of closure) {
    const row = (
      await runQuery("SELECT * FROM fhir.artifacts WHERE package_id = $1 AND package_version = $2 AND canonical_url = $3 LIMIT 1", [
        pid,
        pver,
        url,
      ])
    ).rows[0];
    if (row) return row;
  }
  return null;
}

function rawVersionOf(row: Record<string, any>): string | null {
  let raw = row.raw_json;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      raw = null;
    }
  }
  const v = raw && typeof raw === "object" ? raw.version : null;
  return typeof v === "string" && v ? v : null;
}

/** The artifact's own business version (raw_json.version), else its package version. */
export function artifactVersion(row: Record<string, any>): string {
  return row.artifact_version ?? rawVersionOf(row) ?? String(row.package_version);
}

/** See the contract at the top of this file. */
export async function resolveCanonicalVersioned(
  url: string,
  closure: Array<[string, string]> | PackageRow,
  opts: { version?: string | null; resourceType?: string | null } = {},
): Promise<Record<string, unknown> | null> {
  const parsed = splitCanonical(url);
  const version = opts.version ?? parsed.version;
  const pairs: Array<[string, string]> = Array.isArray(closure)
    ? closure
    : (closure._closure ?? [[closure.package_id, closure.version]]);
  if (!pairs.length || !parsed.url) return null;
  const params: unknown[] = [pairs.map((c) => c[0]), pairs.map((c) => c[1]), parsed.url];
  let typeClause = "";
  if (opts.resourceType) {
    params.push(opts.resourceType);
    typeClause = " AND a.resource_type = $4";
  }
  const rows = (
    await runQuery(
      "SELECT a.*, dep.ord, p.fhir_version AS package_fhir_version FROM fhir.artifacts a " +
        "JOIN unnest($1::text[], $2::text[]) WITH ORDINALITY AS dep(pid, pver, ord) " +
        "  ON a.package_id = dep.pid AND a.package_version = dep.pver " +
        "JOIN fhir.ig_packages p ON p.package_id = a.package_id AND p.version = a.package_version " +
        `WHERE a.canonical_url = $3${typeClause}`,
      params,
    )
  ).rows as Record<string, any>[];
  const matching = version ? filterRequestedVersion(rows, version, (r) => artifactVersion(r)) : rows;
  if (!matching.length) return null;
  const ranked = rankCandidates(
    parsed.url,
    matching.map((r) => ({
      row: r,
      packageId: String(r.package_id),
      packageVersion: String(r.package_version),
      fhirVersion: (r.package_fhir_version as string | null) ?? null,
      ord: Number(r.ord),
    })),
  );
  if (version && ranked.length > 1) {
    // Several artifacts satisfy a partial version ("1.0"): prefer the highest one, closure order on ties.
    ranked.sort((a, b) => compareVersions(artifactVersion(b.row), artifactVersion(a.row)) || a.ord - b.ord);
  }
  return ranked[0].row;
}

export interface CanonicalOwner {
  package_id: string;
  package_version: string;
  /** raw_json.version of the artifact, else the package version. */
  artifact_version: string;
  resource_type: string;
  artifact_id: string | null;
  canonical_url: string | null;
  install_origin: string | null;
  is_default: boolean;
}

/** Rank owner/candidate packages: manual > default > release > higher version > package_id (deterministic). */
export function compareOwnerRank(
  a: { package_id: string; version: string; install_origin?: string | null; is_default?: boolean | null },
  b: { package_id: string; version: string; install_origin?: string | null; is_default?: boolean | null },
): number {
  const ma = a.install_origin === "manual" ? 1 : 0;
  const mb = b.install_origin === "manual" ? 1 : 0;
  if (ma !== mb) return mb - ma;
  const da = a.is_default ? 1 : 0;
  const db = b.is_default ? 1 : 0;
  if (da !== db) return db - da;
  const ra = isPrerelease(a.version) ? 0 : 1;
  const rb = isPrerelease(b.version) ? 0 : 1;
  if (ra !== rb) return rb - ra;
  const v = compareVersions(b.version, a.version);
  if (v !== 0) return v;
  if (a.package_id !== b.package_id) return a.package_id < b.package_id ? -1 : 1;
  return a.version < b.version ? -1 : a.version > b.version ? 1 : 0;
}

interface OwnerHit {
  package_id: string;
  package_version: string;
  resource_type: string;
  artifact_id: string | null;
  canonical_url: string | null;
  artifact_version: string;
}

function toHit(r: Record<string, any>): OwnerHit {
  return {
    package_id: String(r.package_id),
    package_version: String(r.package_version),
    resource_type: String(r.resource_type),
    artifact_id: r.artifact_id ?? null,
    canonical_url: r.canonical_url ?? null,
    artifact_version: r.artifact_version || String(r.package_version),
  };
}

const HIT_COLS =
  "a.package_id, a.package_version, a.resource_type, a.artifact_id, a.canonical_url, a.raw_json ->> 'version' AS artifact_version";
const ID_TYPES = "a.resource_type IN ('StructureDefinition', 'ValueSet', 'CodeSystem', 'ConceptMap')";

/**
 * Packages holding the canonical URLs (indexed, all packages) and the bare ids (artifact_id has no
 * index: scoped to `idClosure` when given, all packages otherwise).
 */
async function ownerHits(urls: string[], ids: string[], idClosure: Array<[string, string]> | null = null): Promise<OwnerHit[]> {
  const out: OwnerHit[] = [];
  if (urls.length) {
    const rows = (await runQuery(`SELECT ${HIT_COLS} FROM fhir.artifacts a WHERE a.canonical_url = ANY($1::text[])`, [urls])).rows;
    for (const r of rows) out.push(toHit(r));
  }
  if (ids.length) {
    const rows = idClosure
      ? (
          await runQuery(
            `SELECT ${HIT_COLS} FROM fhir.artifacts a ` +
              "JOIN unnest($2::text[], $3::text[]) AS dep(pid, pver) ON a.package_id = dep.pid AND a.package_version = dep.pver " +
              `WHERE a.artifact_id = ANY($1::text[]) AND ${ID_TYPES}`,
            [ids, idClosure.map((c) => c[0]), idClosure.map((c) => c[1])],
          )
        ).rows
      : (await runQuery(`SELECT ${HIT_COLS} FROM fhir.artifacts a WHERE a.artifact_id = ANY($1::text[]) AND ${ID_TYPES}`, [ids])).rows;
    const seen = new Set(out.map((h) => `${h.package_id} ${h.package_version} ${h.resource_type} ${h.canonical_url} ${h.artifact_id}`));
    for (const r of rows) {
      const h = toHit(r);
      const k = `${h.package_id} ${h.package_version} ${h.resource_type} ${h.canonical_url} ${h.artifact_id}`;
      if (!seen.has(k)) {
        seen.add(k);
        out.push(h);
      }
    }
  }
  return out;
}

/** See the contract at the top of this file. */
export async function findPackagesForCanonical(url: string, version?: string | null): Promise<CanonicalOwner[]> {
  const parsed = splitCanonical(url);
  const want = version ?? parsed.version;
  const [registry, hits] = await Promise.all([loadRegistry(), ownerHits([parsed.url], [])]);
  const reg = new Map(registry.map((r) => [`${r.package_id} ${r.version}`, r]));
  const owners = (want ? filterRequestedVersion(hits, want, (h) => h.artifact_version) : hits)
    .map((h) => {
      const p = reg.get(`${h.package_id} ${h.package_version}`);
      return { ...h, install_origin: p?.install_origin ?? null, is_default: Boolean(p?.is_default) };
    });
  return owners.sort((a, b) =>
    compareOwnerRank({ ...a, version: a.package_version }, { ...b, version: b.package_version }),
  );
}

// --------------------------------------------------------------------------- //
// Target resolution
// --------------------------------------------------------------------------- //

/**
 * How the target package was chosen:
 *  - explicit_version: a canonical carried "|version" and the chosen package holds that version;
 *  - package_arg:      package_id (+ version) given by the caller;
 *  - latest:           package_id given without version → its highest release (no default version of it);
 *  - meta_profile:     no package_id; the package owning the resource's meta.profile canonicals;
 *  - canonical_owner:  no package_id; the package owning a canonical tool argument (profile / ValueSet / system);
 *  - default_ig:       the default IG (it covers the canonicals involved, or there were none);
 *  - sole_manual_ig:   no default IG, exactly one manually-installed IG.
 */
export type ResolvedBy =
  | "explicit_version"
  | "package_arg"
  | "latest"
  | "meta_profile"
  | "canonical_owner"
  | "default_ig"
  | "sole_manual_ig";

export interface ResolveTargetOptions {
  packageId?: string | null;
  version?: string | null;
  /** Canonical / id tool arguments (profile, identifier, value_set, system); may carry "|version". */
  canonicals?: Array<string | null | undefined>;
  /** meta.profile values of the resource(s) being validated; may carry "|version". */
  metaProfiles?: Array<string | null | undefined>;
}

export interface ResolvedTarget {
  pkg: PackageRow;
  resolvedBy: ResolvedBy;
  closure: Array<[string, string]>;
  depsMissing: DepMissing[];
  closureVersions: Record<string, ClosureVersionUse> | null;
  /** Human-readable notes about the resolution (versions not found, partial coverage, overrides). */
  notes: string[];
}

interface Need {
  raw: string;
  url: string;
  version: string | null;
  isId: boolean;
  from: "arg" | "meta";
}

function needsOf(opts: ResolveTargetOptions): Need[] {
  const out: Need[] = [];
  const seen = new Set<string>();
  const add = (raw: string | null | undefined, from: "arg" | "meta"): void => {
    if (typeof raw !== "string" || !raw.trim()) return;
    const s = raw.trim();
    const key = `${from} ${s}`;
    if (seen.has(key)) return;
    seen.add(key);
    const { url, version } = splitCanonical(s);
    if (!url) return;
    const isId = !url.includes("/") && !url.includes(":");
    if (isId && from === "meta") return; // meta.profile is always a canonical URL
    out.push({ raw: s, url, version, isId, from });
  };
  for (const c of opts.canonicals || []) add(c, "arg");
  for (const c of opts.metaProfiles || []) add(c, "meta");
  return out;
}

function hitMatches(h: OwnerHit, n: Need): boolean {
  if (n.isId ? h.artifact_id !== n.url && h.canonical_url !== n.url : h.canonical_url !== n.url) return false;
  return n.version ? versionMatches(n.version, h.artifact_version) || hl7LineMatch(n.version, h.artifact_version) : true;
}

/** Needs covered by a closure (a need is covered when some package of the closure holds it). */
function coveredBy(closure: Array<[string, string]>, needs: Need[], hits: OwnerHit[]): Need[] {
  const inClosure = new Set(closure.map(([p, v]) => `${p} ${v}`));
  return needs.filter((n) => hits.some((h) => inClosure.has(`${h.package_id} ${h.package_version}`) && hitMatches(h, n)));
}

function withClosure(registry: PackageRow[], row: PackageRow, by: ResolvedBy, notes: string[]): ResolvedTarget {
  const info = computeClosure(registry, row.package_id, row.version);
  const pkg: PackageRow = { ...row, _closure: info.closure };
  return { pkg, resolvedBy: by, closure: info.closure, depsMissing: info.depsMissing, closureVersions: closureVersions(info.closure), notes };
}

/** See ResolvedBy for the precedence. Throws IGNotFoundError / NoDefaultIGError. */
export async function resolveTarget(opts: ResolveTargetOptions = {}): Promise<ResolvedTarget> {
  const registry = await loadRegistry();
  if (!registry.length) throw new IGNotFoundError("no IG packages installed");
  const needs = needsOf(opts);
  const notes: string[] = [];
  const urlsOf = (ns: Need[]): string[] => [...new Set(ns.map((n) => n.url))];
  const idsOf = (ns: Need[]): string[] => [...new Set(ns.filter((n) => n.isId).map((n) => n.url))];
  let globalHits: OwnerHit[] | null = null;
  const allHits = async (): Promise<OwnerHit[]> => (globalHits ??= await ownerHits(urlsOf(needs), idsOf(needs)));

  /** Best root package (by coverage, then owner rank) for the needs; null when none is covered. */
  const bestRoot = (subset: Need[], hits: OwnerHit[]): { row: PackageRow; covered: Need[] } | null => {
    if (!subset.length) return null;
    const ownerKeys = new Set(hits.filter((h) => subset.some((n) => hitMatches(h, n))).map((h) => `${h.package_id} ${h.package_version}`));
    if (!ownerKeys.size) return null;
    const manual = manualIgs(registry) ?? [];
    const candidates = registry.filter((r) => ownerKeys.has(`${r.package_id} ${r.version}`) || manual.includes(r) || r.is_default);
    let best: { row: PackageRow; covered: Need[] } | null = null;
    for (const row of candidates) {
      const covered = coveredBy(computeClosure(registry, row.package_id, row.version).closure, subset, hits);
      if (!covered.length) continue;
      if (
        best === null ||
        covered.length > best.covered.length ||
        (covered.length === best.covered.length && compareOwnerRank(row, best.row) < 0)
      ) {
        best = { row, covered };
      }
    }
    return best;
  };

  const versionNote = (n: Need): string => `${n.raw}: no installed package holds version ${n.version} of this canonical`;

  if (opts.packageId) {
    const rows = registry.filter((r) => r.package_id === opts.packageId);
    const row = selectPackage(registry, opts.packageId, opts.version ?? null);
    const by: ResolvedBy = opts.version || rows.length === 1 || row.is_default ? "package_arg" : "latest";
    const target = withClosure(registry, row, by, notes);
    // Explicit |version on a tool argument wins over package_id when package_id's closure lacks it.
    // A pinned meta.profile never overrides package_id (it is only noted when the closure lacks it).
    const versionedAll = needs.filter((n) => n.version);
    if (!versionedAll.length) return target;
    const hits = await ownerHits(urlsOf(versionedAll), idsOf(versionedAll));
    for (const n of versionedAll) {
      if (n.from === "meta" && !coveredBy(target.closure, [n], hits).length) {
        notes.push(`meta.profile ${n.raw}: version ${n.version} is not in the ${row.package_id}#${row.version} closure`);
      }
    }
    const versioned = versionedAll.filter((n) => n.from === "arg");
    const missing = versioned.filter((n) => !coveredBy(target.closure, [n], hits).length);
    if (missing.length) {
      const alt = bestRoot(missing, hits);
      if (alt) {
        notes.push(
          `${missing.map((n) => n.raw).join(", ")} is not in ${row.package_id}#${row.version}; ` +
            `resolved to ${alt.row.package_id}#${alt.row.version} which holds that version`,
        );
        return withClosure(registry, alt.row, "explicit_version", notes);
      }
      for (const n of missing) notes.push(versionNote(n));
    }
    return target;
  }

  let def: { row: PackageRow; by: "default_ig" | "sole_manual_ig" } | null = null;
  let defErr: unknown = null;
  try {
    def = defaultTarget(registry);
  } catch (e) {
    defErr = e;
  }

  if (needs.length) {
    let defCovered: Need[] = [];
    if (def) {
      // Cheap path first: does the default IG's closure already hold everything (ids scoped to it)?
      const defClosure = computeClosure(registry, def.row.package_id, def.row.version).closure;
      const scoped = await ownerHits(urlsOf(needs), idsOf(needs), defClosure);
      globalHits = idsOf(needs).length ? null : scoped; // url hits are global already
      defCovered = coveredBy(defClosure, needs, scoped);
      if (defCovered.length === needs.length) return withClosure(registry, def.row, def.by, notes);
    }
    const hits = await allHits();
    const best = bestRoot(needs, hits);
    if (best && (!def || best.covered.length > defCovered.length)) {
      for (const n of needs.filter((x) => !best.covered.includes(x))) {
        notes.push(
          n.version && hits.every((h) => !hitMatches(h, n))
            ? versionNote(n)
            : `${n.raw}: not in the ${best.row.package_id}#${best.row.version} closure`,
        );
      }
      const by: ResolvedBy = best.covered.some((n) => n.version)
        ? "explicit_version"
        : best.covered.some((n) => n.from === "meta")
          ? "meta_profile"
          : "canonical_owner";
      return withClosure(registry, best.row, by, notes);
    }
    for (const n of needs) {
      if (defCovered.includes(n)) continue;
      if (n.version && hits.every((h) => !hitMatches(h, n))) notes.push(versionNote(n));
    }
  }
  if (!def) throw defErr;
  return withClosure(registry, def.row, def.by, notes);
}

// --------------------------------------------------------------------------- //
// Registry listing
// --------------------------------------------------------------------------- //

/** All installed IG packages (registry rows), default first. */
export async function listPackages(): Promise<PackageRow[]> {
  return loadRegistry();
}

/** One IG package registry row (version=null → default version, else highest release). */
export async function getPackage(packageId: string, version?: string | null): Promise<PackageRow | null> {
  const registry = await loadRegistry();
  try {
    return selectPackage(registry, packageId, version ?? null);
  } catch (e) {
    if (e instanceof IGNotFoundError) return null;
    throw e;
  }
}
