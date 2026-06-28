/**
 * Admin-console data layer for the Implementation Guides module (read path).
 *
 * Faithful port of `src/admin_ig.py` `list_igs` + its helpers (`_installed_set`,
 * `_counts_by_package`, `_closure_missing`). Reuses the already-verified
 * `fhirIg.listPackages` / `fhirIg.packageClosure` so the dependency-closure
 * logic matches the terminology resolver, exactly as the Python module reuses
 * `fhir_ig`. Mutations (set-default / import / remove) belong to the write chunk.
 *
 * `imported_at` is serialized by the endpoint via `json.dumps(default=str)`, i.e.
 * Python `str(datetime)` (space-separated, microsecond, `+00:00`), so it goes
 * through `tsStrExpr` + `pyIso` rather than the `T`-separated isoformat.
 */

import { query, withTransaction } from "../db.js";
import { listPackages, packageClosure, getPackage, normalizeDependencies } from "../fhirIg.js";
import { tsStrExpr, pyIso } from "./adminJobs.js";
import * as minioService from "../minioService.js";

function key(pid: string, ver: string): string {
  return `${pid}\t${ver}`;
}

async function installedSet(): Promise<Set<string>> {
  const res = await query<{ package_id: string; version: string }>(
    "SELECT package_id, version FROM fhir.ig_packages",
  );
  const out = new Set<string>();
  for (const r of res.rows) out.add(key(r.package_id, r.version));
  return out;
}

async function countsByPackage(table: string): Promise<Map<string, number>> {
  const res = await query<{ package_id: string; package_version: string; n: number | string }>(
    `SELECT package_id, package_version, COUNT(*) AS n FROM ${table} GROUP BY package_id, package_version`,
  );
  const out = new Map<string, number>();
  for (const r of res.rows) out.set(key(r.package_id, r.package_version), Number(r.n));
  return out;
}

/** Transitive deps reachable from this IG that are not installed (excludes self). */
async function closureMissing(
  packageId: string,
  version: string,
  installed: Set<string>,
): Promise<{ package_id: string; version: string }[]> {
  const closure = await packageClosure(packageId, version);
  const missing: { package_id: string; version: string }[] = [];
  for (const [pid, pver] of closure) {
    if (pid === packageId && pver === version) continue;
    if (!installed.has(key(pid, pver))) missing.push({ package_id: pid, version: pver });
  }
  return missing;
}

async function importedAtMap(): Promise<Map<string, string>> {
  const res = await query<{ package_id: string; version: string; imported_str: string | null }>(
    `SELECT package_id, version, ${tsStrExpr("imported_at")} AS imported_str FROM fhir.ig_packages`,
  );
  const out = new Map<string, string>();
  for (const r of res.rows) {
    if (r.imported_str !== null && r.imported_str !== undefined) out.set(key(r.package_id, r.version), pyIso(r.imported_str));
  }
  return out;
}

/** Faithful port of `admin_ig.list_igs`. */
export async function listIgs(): Promise<Record<string, unknown>[]> {
  const packages = await listPackages();
  const installed = await installedSet();
  const artCounts = await countsByPackage("fhir.artifacts");
  const csCounts = await countsByPackage("fhir.codesystems");
  const conceptCounts = await countsByPackage("fhir.concepts");
  const importedAt = await importedAtMap();

  const out: Record<string, unknown>[] = [];
  for (const pkg of packages) {
    const pid = pkg.package_id;
    const pver = pkg.version;
    const k = key(pid, pver);
    const deps = (pkg.dependencies as Record<string, unknown>) ?? {};
    const missing = await closureMissing(pid, pver, installed);
    out.push({
      package_id: pid,
      version: pver,
      title: pkg.title || pid,
      canonical: pkg.canonical ?? null,
      fhir_version: pkg.fhir_version ?? null,
      status: pkg.status ?? null,
      is_default: Boolean(pkg.is_default),
      imported_at: importedAt.get(k) ?? null,
      dependencies: deps,
      counts: {
        artifacts: artCounts.get(k) ?? 0,
        codesystems: csCounts.get(k) ?? 0,
        concepts: conceptCounts.get(k) ?? 0,
      },
      deps_total: Object.keys(deps).length,
      deps_missing: missing,
    });
  }
  return out;
}

/** IGs that declare a dependency on `packageId@version` (faithful port of `_dependents`). */
async function dependents(packageId: string, version: string): Promise<{ package_id: string; version: string }[]> {
  const res = await query<{ package_id: string; version: string; dependencies: unknown }>(
    "SELECT package_id, version, dependencies FROM fhir.ig_packages",
  );
  const out: { package_id: string; version: string }[] = [];
  for (const r of res.rows) {
    if (r.package_id === packageId && r.version === version) continue;
    const deps = normalizeDependencies(r.dependencies);
    if (deps[packageId] === version) out.push({ package_id: r.package_id, version: r.version });
  }
  return out;
}

/**
 * Distinct code systems referenced by this IG's ValueSet includes that are not
 * one of its own CodeSystems (faithful port of `_external_systems`). node-pg
 * parses jsonb to objects, so `raw_json` is already an object here.
 */
async function externalSystems(
  packageId: string,
  version: string,
  localCsIds: Set<string>,
): Promise<string[]> {
  const res = await query<{ raw_json: unknown }>(
    "SELECT raw_json FROM fhir.artifacts WHERE package_id = $1 AND package_version = $2 AND resource_type = 'ValueSet'",
    [packageId, version],
  );
  const systems = new Set<string>();
  for (const r of res.rows) {
    let raw = r.raw_json;
    if (typeof raw === "string") {
      try {
        raw = JSON.parse(raw);
      } catch {
        continue;
      }
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const compose = (raw as Record<string, unknown>).compose;
    const include = compose && typeof compose === "object" ? (compose as Record<string, unknown>).include : null;
    if (!Array.isArray(include)) continue;
    for (const inc of include) {
      const sysUrl = inc && typeof inc === "object" ? (inc as Record<string, unknown>).system : null;
      if (!sysUrl) continue;
      const sysStr = String(sysUrl);
      const tail = sysStr.replace(/\/+$/, "").split("/").pop() ?? "";
      if (localCsIds.has(tail)) continue;
      systems.add(sysStr);
    }
  }
  // Python sorted() over ASCII URLs == JS default lexicographic sort.
  return Array.from(systems).sort();
}

/** Faithful port of `admin_ig.get_ig_detail`. Returns null when the IG is absent. */
export async function getIgDetail(packageId: string, version?: string | null): Promise<Record<string, unknown> | null> {
  const pkg = await getPackage(packageId, version);
  if (pkg === null) return null;
  const pid = pkg.package_id;
  const pver = pkg.version;
  const deps = normalizeDependencies(pkg.dependencies);

  const installed = await installedSet();
  const artCounts = await countsByPackage("fhir.artifacts");
  const csCounts = await countsByPackage("fhir.codesystems");
  const conceptCounts = await countsByPackage("fhir.concepts");

  const csRes = await query<{ cs_id: string; name: string | null; concept_count: number | string }>(
    "SELECT cs_id, name, COALESCE(concept_count, 0) AS concept_count FROM fhir.codesystems " +
      "WHERE package_id = $1 AND package_version = $2 ORDER BY name NULLS LAST, cs_id",
    [pid, pver],
  );
  const localCsIds = new Set<string>(csRes.rows.map((r) => r.cs_id));
  const extSystems = await externalSystems(pid, pver, localCsIds);
  const deps_dependents = await dependents(pid, pver);

  const dependencyTree = Object.entries(deps).map(([depId, depVer]) => ({
    package_id: depId,
    version: depVer,
    installed: installed.has(key(depId, depVer)),
  }));

  const missing = await closureMissing(pid, pver, installed);
  const importedAt = await importedAtMap();
  const k = key(pid, pver);

  return {
    package_id: pid,
    version: pver,
    title: pkg.title || pid,
    canonical: pkg.canonical ?? null,
    fhir_version: pkg.fhir_version ?? null,
    status: pkg.status ?? null,
    is_default: Boolean(pkg.is_default),
    imported_at: importedAt.get(k) ?? null,
    counts: {
      artifacts: artCounts.get(k) ?? 0,
      codesystems: csCounts.get(k) ?? 0,
      concepts: conceptCounts.get(k) ?? 0,
    },
    dependencies: dependencyTree,
    deps_missing: missing,
    dependents: deps_dependents,
    codesystems: csRes.rows.map((r) => ({
      cs_id: r.cs_id,
      name: r.name || r.cs_id,
      concept_count: Number(r.concept_count),
    })),
    external_systems: extSystems,
  };
}

/**
 * Faithful port of `admin_ig.set_default`: make `packageId@version` the single
 * default IG. Returns false when the package is absent. Clears all defaults
 * first so the partial unique index (one default) never conflicts.
 */
export async function setDefault(packageId: string, version: string): Promise<boolean> {
  const exists = await query(
    "SELECT 1 FROM fhir.ig_packages WHERE package_id = $1 AND version = $2",
    [packageId, version],
  );
  if (exists.rows.length === 0) return false;
  await withTransaction(async (client) => {
    await client.query("UPDATE fhir.ig_packages SET is_default = FALSE WHERE is_default");
    await client.query(
      "UPDATE fhir.ig_packages SET is_default = TRUE WHERE package_id = $1 AND version = $2",
      [packageId, version],
    );
  });
  return true;
}

/**
 * Faithful port of `admin_ig.remove_ig`: delete one IG package (cascades to its
 * CodeSystems/concepts/artifacts), audit-log it, and best-effort remove the
 * archived tarball from MinIO. Returns a summary including installed dependents.
 */
export async function removeIg(opts: {
  packageId: string;
  version: string;
  removedBy: string;
}): Promise<Record<string, unknown>> {
  const { packageId, version, removedBy } = opts;
  const row = await query<{ package_id: string; version: string; is_default: boolean }>(
    "SELECT package_id, version, is_default FROM fhir.ig_packages WHERE package_id = $1 AND version = $2",
    [packageId, version],
  );
  if (row.rows.length === 0) return { removed: false, reason: "not_found" };
  const deps = await dependents(packageId, version);
  await withTransaction(async (client) => {
    await client.query("DELETE FROM fhir.ig_packages WHERE package_id = $1 AND version = $2", [packageId, version]);
    await client.query(
      `INSERT INTO admin.admin_audit_log
         (admin_user, action, target_type, target_id, payload_json)
       VALUES ($1, 'remove_ig', 'ig_package', $2, $3::jsonb)`,
      [removedBy, `${packageId}@${version}`, JSON.stringify({ dependents: deps })],
    );
  });
  if (minioService.enabled()) {
    try {
      await minioService.removeObject(`ig-packages/${packageId}/${version}/package.tgz`);
    } catch {
      // best-effort: a missing tarball must not fail the removal
    }
  }
  return {
    removed: true,
    package_id: packageId,
    version,
    was_default: Boolean(row.rows[0].is_default),
    dependents: deps,
  };
}
