/**
 * FHIR IG package registry helpers — multi-IG foundation.
 * Faithful port of `src/fhir_ig.py`. Resolves which `fhir.*` package a request
 * targets and walks a package's declared dependencies (closure / canonical
 * resolution). Dependency-free apart from the pg pool.
 */

import { query } from "./db.js";

export class IGNotFoundError extends Error {
  code = "IG_NOT_FOUND";
  constructor(message: string) {
    super(message);
    this.name = "IGNotFoundError";
  }
}

type SemverPart = [number, number, string];

/** Best-effort semver sort key (mirror `_semver_key`). */
function semverKey(version: string): SemverPart[] {
  const parts: SemverPart[] = [];
  for (const chunk of String(version || "").replace(/-/g, ".").replace(/\+/g, ".").split(".")) {
    if (chunk.length > 0 && /^\d+$/.test(chunk)) {
      parts.push([1, parseInt(chunk, 10), ""]);
    } else {
      parts.push([0, 0, chunk]);
    }
  }
  return parts;
}

/** Compare two semver keys (mirror Python tuple comparison). Returns >0 if a>b. */
function cmpSemver(a: SemverPart[], b: SemverPart[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? [0, 0, ""];
    const y = b[i] ?? [0, 0, ""];
    if (x[0] !== y[0]) return x[0] - y[0];
    if (x[1] !== y[1]) return x[1] - y[1];
    if (x[2] !== y[2]) return x[2] < y[2] ? -1 : 1;
  }
  return 0;
}

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

/** Resolve an IG selector to a concrete `[package_id, version]`. */
export async function resolvePackage(ig?: IGSelector | null): Promise<[string, string]> {
  if (ig) {
    const packageId = ig.packageId ?? ig.package_id;
    const version = ig.version;
    if (!packageId) throw new IGNotFoundError("ig.packageId is required");
    if (version) {
      const r = await query<{ package_id: string; version: string }>(
        "SELECT package_id, version FROM fhir.ig_packages WHERE package_id = $1 AND version = $2",
        [packageId, version],
      );
      if (r.rows.length === 0) {
        throw new IGNotFoundError(`IG package not found: ${packageId}#${version}`);
      }
      return [r.rows[0].package_id, r.rows[0].version];
    }
    const rows = (
      await query<{ version: string; is_default: boolean }>(
        "SELECT version, is_default FROM fhir.ig_packages WHERE package_id = $1",
        [packageId],
      )
    ).rows;
    if (rows.length === 0) throw new IGNotFoundError(`IG package not found: ${packageId}`);
    const best = [...rows].sort((a, b) => {
      // reverse=True over (bool(is_default), semverKey(version))
      const da = a.is_default ? 1 : 0;
      const db = b.is_default ? 1 : 0;
      if (da !== db) return db - da;
      return cmpSemver(semverKey(b.version), semverKey(a.version));
    })[0];
    return [packageId, best.version];
  }

  const r = await query<{ package_id: string; version: string }>(
    "SELECT package_id, version FROM fhir.ig_packages ORDER BY is_default DESC, imported_at DESC LIMIT 1",
  );
  if (r.rows.length === 0) throw new IGNotFoundError("no IG packages installed");
  return [r.rows[0].package_id, r.rows[0].version];
}

export async function resolveDefaultPackage(): Promise<[string, string] | null> {
  try {
    return await resolvePackage(null);
  } catch (e) {
    if (e instanceof IGNotFoundError) return null;
    throw e;
  }
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
  _closure?: Array<[string, string]>;
  [key: string]: unknown;
}

/** Resolve a canonical URL to an artifact row across the dependency closure. */
export async function resolveCanonical(
  url: string,
  packageId: string,
  packageVersion: string,
): Promise<Record<string, unknown> | null> {
  const seen = new Set<string>();
  const queue: Array<[string, string]> = [[packageId, packageVersion]];
  while (queue.length) {
    const [pid, pver] = queue.shift()!;
    const seenKey = `${pid} ${pver}`;
    if (seen.has(seenKey)) continue;
    seen.add(seenKey);
    const row = (
      await query<Record<string, unknown>>(
        "SELECT * FROM fhir.artifacts WHERE package_id = $1 AND package_version = $2 AND canonical_url = $3 LIMIT 1",
        [pid, pver, url],
      )
    ).rows[0];
    if (row) return row;
    const depRow = (
      await query<{ dependencies: unknown }>(
        "SELECT dependencies FROM fhir.ig_packages WHERE package_id = $1 AND version = $2",
        [pid, pver],
      )
    ).rows[0];
    if (depRow) {
      for (const [depId, depVer] of Object.entries(normalizeDependencies(depRow.dependencies))) {
        if (!seen.has(`${depId} ${depVer}`)) queue.push([depId, depVer]);
      }
    }
  }
  return null;
}

/** Target package + transitive declared dependencies, breadth-first (target first). */
export async function packageClosure(
  packageId: string,
  packageVersion: string,
): Promise<Array<[string, string]>> {
  const seen = new Set<string>();
  const ordered: Array<[string, string]> = [];
  const queue: Array<[string, string]> = [[packageId, packageVersion]];
  while (queue.length) {
    const [pid, pver] = queue.shift()!;
    const seenKey = `${pid} ${pver}`;
    if (seen.has(seenKey)) continue;
    seen.add(seenKey);
    ordered.push([pid, pver]);
    const depRow = (
      await query<{ dependencies: unknown }>(
        "SELECT dependencies FROM fhir.ig_packages WHERE package_id = $1 AND version = $2",
        [pid, pver],
      )
    ).rows[0];
    if (depRow) {
      for (const [depId, depVer] of Object.entries(normalizeDependencies(depRow.dependencies))) {
        if (!seen.has(`${depId} ${depVer}`)) queue.push([depId, depVer]);
      }
    }
  }
  return ordered;
}

/** All installed IG packages (registry rows), default first. */
export async function listPackages(): Promise<PackageRow[]> {
  const rows = (
    await query<PackageRow>(
      "SELECT package_id, version, canonical, fhir_version, title, status, " +
        "is_default, dependencies, imported_at FROM fhir.ig_packages " +
        "ORDER BY is_default DESC, package_id, version",
    )
  ).rows;
  return rows.map((row) => ({ ...row, dependencies: normalizeDependencies(row.dependencies) }));
}

/** One IG package registry row (version=null → default/highest). */
export async function getPackage(
  packageId: string,
  version?: string | null,
): Promise<PackageRow | null> {
  let pid: string;
  let ver: string;
  try {
    [pid, ver] = await resolvePackage({ packageId, version });
  } catch (e) {
    if (e instanceof IGNotFoundError) return null;
    throw e;
  }
  const row = (
    await query<PackageRow>(
      "SELECT package_id, version, canonical, fhir_version, title, status, " +
        "is_default, dependencies, imported_at FROM fhir.ig_packages WHERE package_id = $1 AND version = $2",
      [pid, ver],
    )
  ).rows[0];
  if (!row) return null;
  return { ...row, dependencies: normalizeDependencies(row.dependencies) };
}
