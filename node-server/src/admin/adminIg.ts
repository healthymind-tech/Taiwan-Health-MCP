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
import { tsStrExpr, tsIsoExpr, pyIso, parseJsonb, createJob } from "./adminJobs.js";
import * as minioService from "../minioService.js";
import { canonicalDependencyVersion } from "../loaders/igRegistry.js";
import {
  directDependents,
  parseInstallOrigin,
  parseInstalledFor,
  type IgCoordinate,
  type InstallOrigin,
} from "./igOrigin.js";
import {
  computeMissingDependencies,
  type IgJobLite,
  type MissingDependency,
} from "./igDependencies.js";
import {
  defaultCandidates,
  dependentsOf,
  LOCKED_PACKAGES_SQL,
  orphanedBy,
  planRemoval,
  removeIgPackages,
  rowToInstalled,
  unusedDependencies,
  type InstalledIg,
  type RemovalDeps,
  type RemovalResult,
  type TxClient,
} from "./igRemoval.js";
import { logWarning } from "../logger.js";

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

interface OriginRow {
  install_origin: InstallOrigin | null;
  installed_for: IgCoordinate | null;
}

/**
 * install_origin / installed_for per package. Tolerates a database the
 * 20261019_ig_install_origin migration has not been applied to yet (origin
 * reported as null = unknown) so the list keeps working during a rollout.
 */
async function originMap(): Promise<Map<string, OriginRow>> {
  const out = new Map<string, OriginRow>();
  try {
    const res = await query<{ package_id: string; version: string; install_origin: unknown; installed_for: unknown }>(
      "SELECT package_id, version, install_origin, installed_for FROM fhir.ig_packages",
    );
    for (const r of res.rows) {
      out.set(key(r.package_id, r.version), {
        install_origin: parseInstallOrigin(r.install_origin),
        installed_for: parseInstalledFor(r.installed_for),
      });
    }
  } catch (exc) {
    if ((exc as { code?: string }).code !== "42703") throw exc; // undefined_column → migration pending
  }
  return out;
}

/** Artifact totals and `package/example/*` resources per package (one scan). */
async function artifactCountsByPackage(): Promise<{ all: Map<string, number>; examples: Map<string, number> }> {
  const res = await query<{ package_id: string; package_version: string; n: number | string; ex: number | string }>(
    `SELECT package_id, package_version, COUNT(*) AS n,
            COUNT(*) FILTER (WHERE package_path LIKE 'package/example/%') AS ex
       FROM fhir.artifacts GROUP BY package_id, package_version`,
  );
  const all = new Map<string, number>();
  const examples = new Map<string, number>();
  for (const r of res.rows) {
    all.set(key(r.package_id, r.package_version), Number(r.n));
    examples.set(key(r.package_id, r.package_version), Number(r.ex));
  }
  return { all, examples };
}

/** Description of each package's ImplementationGuide resource (searchable in the list). */
async function descriptionMap(): Promise<Map<string, string>> {
  const res = await query<{ package_id: string; package_version: string; description: string | null }>(
    `SELECT DISTINCT ON (package_id, package_version) package_id, package_version, LEFT(description, 500) AS description
       FROM fhir.artifacts
      WHERE resource_type = 'ImplementationGuide' AND description IS NOT NULL AND description <> ''
      ORDER BY package_id, package_version, artifact_key`,
  );
  const out = new Map<string, string>();
  for (const r of res.rows) if (r.description) out.set(key(r.package_id, r.package_version), r.description);
  return out;
}

/** Faithful port of `admin_ig.list_igs`, plus install origin, dependents, description and example counts. */
export async function listIgs(): Promise<Record<string, unknown>[]> {
  const packages = await listPackages();
  const installed = await installedSet();
  const { all: artCounts, examples: exampleCounts } = await artifactCountsByPackage();
  const csCounts = await countsByPackage("fhir.codesystems");
  const conceptCounts = await countsByPackage("fhir.concepts");
  const importedAt = await importedAtMap();
  const origins = await originMap();
  const descriptions = await descriptionMap();
  const dependentsOf = directDependents(
    packages.map((p) => ({ package_id: p.package_id, version: p.version, dependencies: normalizeDependencies(p.dependencies) })),
  );
  const titles = new Map(packages.map((p) => [key(p.package_id, p.version), p.title || p.package_id]));
  const withTitle = (c: IgCoordinate | null) =>
    c ? { ...c, title: titles.get(key(c.package_id, c.version)) ?? null, installed: titles.has(key(c.package_id, c.version)) } : null;

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
        examples: exampleCounts.get(k) ?? 0,
      },
      deps_total: Object.keys(deps).length,
      deps_missing: missing,
      description: descriptions.get(k) ?? null,
      install_origin: origins.get(k)?.install_origin ?? null,
      installed_for: withTitle(origins.get(k)?.installed_for ?? null),
      required_by: dependentsOf.get(`${pid}@${pver}`) ?? [],
    });
  }
  return out;
}

/** Installed IGs that declare `packageId@version` directly (core 4.0.0 declarations count as 4.0.1). */
async function dependents(packageId: string, version: string): Promise<{ package_id: string; version: string }[]> {
  const packages = await loadInstalled();
  return dependentsOf(packages, [{ package_id: packageId, version }])
    .filter((d) => d.direct)
    .map((d) => ({ package_id: d.package_id, version: d.version }));
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

  const dependencyTree = Object.entries(deps).map(([depId, depVer]) => {
    const resolved = canonicalDependencyVersion(depId, String(depVer));
    return {
      package_id: depId,
      version: depVer,
      // Declared version that was never published → also report the one actually used.
      ...(resolved !== depVer ? { resolved_version: resolved } : {}),
      installed: installed.has(key(depId, resolved)),
    };
  });

  const missing = await closureMissing(pid, pver, installed);
  const importedAt = await importedAtMap();
  const k = key(pid, pver);
  const origin = (await originMap()).get(k) ?? null;
  let installedFor: Record<string, unknown> | null = null;
  if (origin?.installed_for) {
    const via = await getPackage(origin.installed_for.package_id, origin.installed_for.version).catch(() => null);
    const viaInstalled = via !== null && via.version === origin.installed_for.version;
    installedFor = { ...origin.installed_for, title: viaInstalled ? via.title || via.package_id : null, installed: viaInstalled };
  }

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
    install_origin: origin?.install_origin ?? null,
    installed_for: installedFor,
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

// ── Removal (dependency- and default-aware) ────────────────────────────────

async function loadInstalled(): Promise<InstalledIg[]> {
  // Same projection as the locked read inside the removal transaction, minus the lock.
  const res = await query<Record<string, unknown>>(LOCKED_PACKAGES_SQL.replace(/ FOR UPDATE$/, ""));
  return res.rows.map(rowToInstalled);
}

const removalDeps: RemovalDeps = {
  transaction: (fn) => withTransaction((client) => fn(client as unknown as TxClient)),
  removeArchive: async (t) => {
    if (minioService.enabled()) await minioService.removeObject(`ig-packages/${t.package_id}/${t.version}/package.tgz`);
  },
  onForced: ({ removedBy, targets, broken, removesDefault }) =>
    logWarning("Forced IG removal", {
      removed_by: removedBy,
      packages: targets.map((t) => `${t.package_id}@${t.version}`),
      broken_dependents: broken.map((d) => `${d.package_id}@${d.version}`),
      removed_default: removesDefault,
    }),
};

/**
 * Remove one IG package (cascades to its CodeSystems/concepts/artifacts),
 * audit-log it and best-effort remove its archived tarball. Refused with
 * IG_HAS_DEPENDENTS / IG_IS_DEFAULT unless `force` (or `newDefault` for the
 * default IG); see igRemoval.ts.
 */
export async function removeIg(opts: {
  packageId: string;
  version: string;
  removedBy: string;
  force?: boolean;
  newDefault?: IgCoordinate | null;
}): Promise<RemovalResult> {
  return removeIgPackages(removalDeps, {
    targets: [{ package_id: opts.packageId, version: opts.version }],
    removedBy: opts.removedBy,
    force: opts.force,
    newDefault: opts.newDefault ?? null,
  });
}

/** What removing one IG would break — read-only preview for the delete dialog. */
export async function removalImpact(packageId: string, version: string): Promise<Record<string, unknown> | null> {
  const packages = await loadInstalled();
  const target = packages.find((p) => p.package_id === packageId && p.version === version);
  if (!target) return null;
  const targets = [{ package_id: packageId, version }];
  const plan = planRemoval(packages, targets);
  const counts = await query<{ artifacts: string | number; codesystems: string | number; concepts: string | number }>(
    `SELECT (SELECT COUNT(*) FROM fhir.artifacts WHERE package_id = $1 AND package_version = $2) AS artifacts,
            (SELECT COUNT(*) FROM fhir.codesystems WHERE package_id = $1 AND package_version = $2) AS codesystems,
            (SELECT COUNT(*) FROM fhir.concepts WHERE package_id = $1 AND package_version = $2) AS concepts`,
    [packageId, version],
  );
  const c = counts.rows[0];
  return {
    target: {
      package_id: packageId,
      version,
      title: target.title || packageId,
      is_default: target.is_default,
      install_origin: target.install_origin,
      counts: { artifacts: Number(c?.artifacts ?? 0), codesystems: Number(c?.codesystems ?? 0), concepts: Number(c?.concepts ?? 0) },
    },
    allowed: plan.ok,
    blockers: plan.ok ? [] : plan.blockers,
    dependents: dependentsOf(packages, targets),
    removes_default: target.is_default,
    default_candidates: target.is_default ? defaultCandidates(packages, targets) : [],
    orphaned: orphanedBy(packages, targets),
  };
}

/** Dependency installs that no installed root IG needs any more. */
export async function listUnusedDependencies(): Promise<Record<string, unknown>[]> {
  const packages = await loadInstalled();
  const unused = unusedDependencies(packages);
  if (unused.length === 0) return [];
  const artCounts = await countsByPackage("fhir.artifacts");
  const conceptCounts = await countsByPackage("fhir.concepts");
  const origins = await originMap();
  return unused.map((u) => {
    const kk = key(u.package_id, u.version);
    return {
      ...u,
      installed_for: origins.get(kk)?.installed_for ?? null,
      counts: { artifacts: artCounts.get(kk) ?? 0, concepts: conceptCounts.get(kk) ?? 0 },
    };
  });
}

/**
 * Remove unused dependency installs as one set (default: all of them). Each
 * named package must still be unused when the transaction runs, else the
 * whole request is refused with IG_DEPENDENCY_IN_USE. Never forced.
 */
export async function removeUnusedDependencies(opts: {
  packages: IgCoordinate[] | null;
  removedBy: string;
}): Promise<RemovalResult | { ok: true; removed: false; packages: [] }> {
  let targets = opts.packages;
  if (targets === null) {
    targets = (await loadInstalled().then(unusedDependencies)).map(({ package_id, version }) => ({ package_id, version }));
    if (targets.length === 0) return { ok: true, removed: false, packages: [] };
  }
  return removeIgPackages(removalDeps, { targets, removedBy: opts.removedBy, requireUnused: true, reason: "unused_dependency_cleanup" });
}

// ── Missing dependencies (download / upload / bulk fill) ─────────────────────

/** Recent `ig_import` jobs, newest first, in the shape `computeMissingDependencies` reads. */
async function recentIgJobs(limit = 200): Promise<IgJobLite[]> {
  const res = await query<{
    job_id: string;
    status: string | null;
    current_step: string | null;
    progress_current: number | string | null;
    progress_total: number | string | null;
    created_iso: string | null;
    finished_iso: string | null;
    last_error_code: string | null;
    last_error_message: string | null;
    job_options_json: unknown;
    result_summary_json: unknown;
  }>(
    `SELECT job_id, status, current_step, progress_current, progress_total,
            ${tsIsoExpr("created_at")} AS created_iso, ${tsIsoExpr("finished_at")} AS finished_iso,
            last_error_code, last_error_message, job_options_json, result_summary_json
       FROM admin.import_jobs
      WHERE job_type = 'ig_import'
      ORDER BY created_at DESC
      LIMIT $1`,
    [limit],
  );
  return res.rows.map((r) => ({
    job_id: String(r.job_id),
    status: r.status || "",
    current_step: r.current_step || "",
    progress_current: Number(r.progress_current || 0),
    progress_total: Number(r.progress_total || 0),
    created_at: r.created_iso ? pyIso(r.created_iso) : "",
    finished_at: r.finished_iso ? pyIso(r.finished_iso) : "",
    last_error_code: r.last_error_code || "",
    last_error_message: r.last_error_message || "",
    job_options: parseJsonb(r.job_options_json),
    result_summary: parseJsonb(r.result_summary_json),
  }));
}

/** GET /admin/api/igs/dependencies — every missing dependency with its download state. */
export async function listMissingDependencies(): Promise<MissingDependency[]> {
  const packages = await listPackages();
  const jobs = await recentIgJobs();
  return computeMissingDependencies(
    packages.map((p) => ({
      package_id: p.package_id,
      version: p.version,
      dependencies: normalizeDependencies(p.dependencies),
    })),
    jobs,
  );
}

export async function isInstalled(packageId: string, version: string): Promise<boolean> {
  const res = await query("SELECT 1 FROM fhir.ig_packages WHERE package_id = $1 AND version = $2", [packageId, version]);
  return res.rows.length > 0;
}

/**
 * Queue one dependency-only `ig_import` job fetching `packages` (exact
 * versions) and whatever they depend on that is missing. Packages that an
 * active job already targets are left out; when nothing remains, the active
 * job is returned instead of a new one.
 */
export async function queueDependencyImport(opts: {
  packages: { package_id: string; version: string }[];
  requestedBy: string;
  requestedFor?: { package_id: string; version: string } | null;
}): Promise<{ job: Record<string, unknown> | null; packages: { package_id: string; version: string }[]; already_queued: string[] }> {
  const deps = await listMissingDependencies();
  const activeByKey = new Map<string, string>();
  for (const d of deps) if (d.active_job) activeByKey.set(`${d.package_id}@${d.version}`, d.active_job.job_id);
  const fresh: { package_id: string; version: string }[] = [];
  const alreadyQueued: string[] = [];
  let existingJobId: string | null = null;
  for (const p of opts.packages) {
    const k = `${p.package_id}@${p.version}`;
    const jid = activeByKey.get(k);
    if (jid) {
      alreadyQueued.push(k);
      existingJobId = existingJobId ?? jid;
    } else if (!fresh.some((f) => f.package_id === p.package_id && f.version === p.version)) {
      fresh.push(p);
    }
  }
  if (fresh.length === 0) {
    let job: Record<string, unknown> | null = null;
    if (existingJobId) {
      const { getJob } = await import("./adminJobs.js");
      job = await getJob(existingJobId);
    }
    return { job, packages: [], already_queued: alreadyQueued };
  }
  const job = await createJob({
    moduleKey: "ig",
    jobType: "ig_import",
    requestedBy: opts.requestedBy,
    jobOptions: {
      ig_source: "dependencies",
      packages: fresh,
      ...(opts.requestedFor ? { requested_for: opts.requestedFor } : {}),
    },
  });
  return { job, packages: fresh, already_queued: alreadyQueued };
}

/** Missing dependencies in one installed IG's closure (for "fill this IG's dependencies"). */
export async function missingForIg(packageId: string, version: string): Promise<MissingDependency[] | null> {
  const pkg = await getPackage(packageId, version);
  if (pkg === null || pkg.version !== version) return null;
  const deps = await listMissingDependencies();
  return deps.filter((d) => d.required_by.some((r) => r.package_id === packageId && r.version === version));
}

/**
 * Read the identity (package.json) of an uploaded IG tarball without importing
 * it, so the admin UI can check it is the package it was uploaded for.
 */
export async function inspectUploadedIg(uploadedFileId: string): Promise<
  | { ok: true; package_id: string; version: string; title: string; fhir_version: string; dependencies: Record<string, string> }
  | { ok: false; status: number; error: string; detail?: string }
> {
  const row = await query<{ object_key: string }>(
    "SELECT object_key FROM admin.uploaded_files WHERE uploaded_file_id = $1::uuid AND module_key = 'ig'",
    [uploadedFileId],
  ).catch(() => ({ rows: [] as { object_key: string }[] }));
  if (row.rows.length === 0) return { ok: false, status: 404, error: "Uploaded IG file not found" };
  if (!minioService.enabled()) return { ok: false, status: 503, error: "MinIO is required to read the uploaded IG package" };
  const fsp = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { readIgPackageIdentity } = await import("../loaders/ig.js");
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "admin-ig-inspect-"));
  try {
    const data = await minioService.downloadBytes(row.rows[0].object_key);
    // parseIdentity falls back to the file name when package.json has no name;
    // a sentinel name makes that fallback detectable.
    const UNNAMED = "__unnamed_package__";
    const file = path.join(dir, `${UNNAMED}.tgz`);
    await fsp.writeFile(file, data);
    let ident;
    try {
      ident = readIgPackageIdentity(file);
    } catch (exc) {
      return { ok: false, status: 422, error: "Not a readable FHIR package (.tgz with package/package.json)", detail: String((exc as Error).message) };
    }
    if (!ident.package_id || ident.package_id === UNNAMED || !ident.version) {
      return { ok: false, status: 422, error: "The package has no name/version in package/package.json" };
    }
    return {
      ok: true,
      package_id: ident.package_id,
      version: ident.version,
      title: ident.title,
      fhir_version: ident.fhir_version,
      dependencies: ident.dependencies ?? {},
    };
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
