/**
 * Missing IG dependency bookkeeping for the admin console (pure, no I/O).
 *
 * Given the installed `fhir.ig_packages` rows and the recent `ig_import` jobs,
 * works out which declared dependencies are not installed, which installed IGs
 * need each one, whether a job is already fetching it, and why the last attempt
 * failed. Kept free of database access so it can be unit-tested directly; the
 * queries live in adminIg.ts.
 */

import { canonicalDependencyVersion, classifyRegistryFailure, type RegistryFailureKind } from "../loaders/igRegistry.js";

export interface InstalledPackage {
  package_id: string;
  version: string;
  dependencies: Record<string, string>;
}

/** The subset of an `admin.import_jobs` row this module reads. */
export interface IgJobLite {
  job_id: string;
  status: string;
  current_step: string;
  progress_current: number;
  progress_total: number;
  created_at: string;
  finished_at: string;
  last_error_code: string;
  last_error_message: string;
  job_options: Record<string, unknown>;
  result_summary: Record<string, unknown>;
}

export type MissingDependencyStatus = "missing" | "queued" | "downloading" | "failed";

export interface MissingDependency {
  package_id: string;
  /** Version that would be installed (aliases resolved: core 4.0.0 → 4.0.1). */
  version: string;
  /** Versions as declared by the IGs that need it (differs from `version` only for aliases). */
  declared_versions: string[];
  /** Set when some IG declares a never-published version that resolves to `version`. */
  alias: { declared: string; resolved: string } | null;
  /** Installed IGs whose dependency closure needs it; `direct` = declared in its own package.json. */
  required_by: { package_id: string; version: string; direct: boolean }[];
  status: MissingDependencyStatus;
  active_job: {
    job_id: string;
    status: string;
    current_step: string;
    progress_current: number;
    progress_total: number;
  } | null;
  last_failure: {
    reason: string;
    reason_code: RegistryFailureKind;
    job_id: string;
    at: string;
  } | null;
}

export const ACTIVE_JOB_STATUSES: ReadonlySet<string> = new Set(["queued", "running", "paused"]);
const FAILED_JOB_STATUSES: ReadonlySet<string> = new Set(["retryable_failed", "permanent_failed"]);

/** FHIR package ids: npm-ish, e.g. `hl7.fhir.r4.core`, `tw.gov.mohw.twcore`. */
export const PACKAGE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
/** Exact versions only (no ranges): `4.0.1`, `3.0.0-ballot`, `2022.4.20221006`. */
export const PACKAGE_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$/;

function key(pid: string, ver: string): string {
  return `${pid}\t${ver}`;
}

/** Packages an `ig_import` job will install by name (beyond whatever transitive deps it finds). */
export function jobTargets(job: Pick<IgJobLite, "job_options">): { package_id: string; version: string }[] {
  const opts = job.job_options ?? {};
  const src = String(opts.ig_source ?? "");
  const out: { package_id: string; version: string }[] = [];
  const push = (pid: unknown, ver: unknown): void => {
    const p = String(pid ?? "").trim();
    const v = String(ver ?? "").trim();
    if (p && v) out.push({ package_id: p, version: canonicalDependencyVersion(p, v) });
  };
  if (src === "dependencies" && Array.isArray(opts.packages)) {
    for (const item of opts.packages) {
      if (item && typeof item === "object") push((item as Record<string, unknown>).package_id, (item as Record<string, unknown>).version);
    }
  } else if (src === "registry") {
    push(opts.package_id, opts.version);
  } else if (src === "upload") {
    const exp = opts.expected_package;
    if (exp && typeof exp === "object") push((exp as Record<string, unknown>).package_id, (exp as Record<string, unknown>).version);
  }
  return out;
}

/** Per-package failure reasons a finished job recorded (`result_summary.missing_dependencies`, or its error). */
function jobFailures(job: IgJobLite): Map<string, { reason: string; reason_code: RegistryFailureKind }> {
  const out = new Map<string, { reason: string; reason_code: RegistryFailureKind }>();
  const md = job.result_summary?.missing_dependencies;
  if (Array.isArray(md)) {
    for (const m of md) {
      if (!m || typeof m !== "object") continue;
      const r = m as Record<string, unknown>;
      const pid = String(r.package_id ?? "");
      const ver = String(r.version ?? "");
      if (!pid || !ver) continue;
      const reason = String(r.reason ?? "");
      const code = typeof r.reason_code === "string" && r.reason_code ? (r.reason_code as RegistryFailureKind) : classifyRegistryFailure(reason);
      out.set(key(pid, canonicalDependencyVersion(pid, ver)), { reason, reason_code: code });
    }
  }
  // A failed job that named its target but recorded no per-package reason
  // (registry root import that 404'd, worker crash) still counts as a failure.
  if (FAILED_JOB_STATUSES.has(job.status)) {
    for (const t of jobTargets(job)) {
      const k = key(t.package_id, t.version);
      if (!out.has(k)) {
        const reason = job.last_error_message || job.last_error_code || job.status;
        out.set(k, { reason, reason_code: classifyRegistryFailure(reason) });
      }
    }
  }
  return out;
}

/**
 * Every dependency (transitively, through installed packages) that is not
 * installed, with who needs it and its download state. `jobs` must be newest
 * first (as `admin.import_jobs ORDER BY created_at DESC`).
 */
export function computeMissingDependencies(packages: InstalledPackage[], jobs: IgJobLite[]): MissingDependency[] {
  const installed = new Map<string, InstalledPackage>();
  for (const p of packages) installed.set(key(p.package_id, p.version), p);

  interface Acc {
    package_id: string;
    version: string;
    declared: Set<string>;
    requiredBy: Map<string, { package_id: string; version: string; direct: boolean }>;
  }
  const acc = new Map<string, Acc>();

  for (const ig of packages) {
    // BFS over the installed closure of `ig`; uninstalled deps are leaves.
    const seen = new Set<string>([key(ig.package_id, ig.version)]);
    const queue: { pkg: InstalledPackage; depth: number }[] = [{ pkg: ig, depth: 0 }];
    while (queue.length) {
      const { pkg, depth } = queue.shift()!;
      for (const [depId, rawVer] of Object.entries(pkg.dependencies ?? {})) {
        const declared = String(rawVer);
        const ver = canonicalDependencyVersion(depId, declared);
        const k = key(depId, ver);
        const inst = installed.get(k);
        if (inst) {
          if (!seen.has(k)) {
            seen.add(k);
            queue.push({ pkg: inst, depth: depth + 1 });
          }
          continue;
        }
        let a = acc.get(k);
        if (!a) {
          a = { package_id: depId, version: ver, declared: new Set(), requiredBy: new Map() };
          acc.set(k, a);
        }
        a.declared.add(declared);
        const igKey = key(ig.package_id, ig.version);
        const prev = a.requiredBy.get(igKey);
        const direct = depth === 0;
        if (!prev) a.requiredBy.set(igKey, { package_id: ig.package_id, version: ig.version, direct });
        else if (direct) prev.direct = true;
      }
    }
  }

  const out: MissingDependency[] = [];
  for (const [k, a] of acc) {
    let activeJob: MissingDependency["active_job"] = null;
    let lastFailure: MissingDependency["last_failure"] = null;
    for (const job of jobs) {
      if (ACTIVE_JOB_STATUSES.has(job.status)) {
        if (!activeJob && jobTargets(job).some((t) => key(t.package_id, t.version) === k)) {
          activeJob = {
            job_id: job.job_id,
            status: job.status,
            current_step: job.current_step,
            progress_current: job.progress_current,
            progress_total: job.progress_total,
          };
        }
        continue;
      }
      if (!lastFailure) {
        const f = jobFailures(job).get(k);
        if (f) lastFailure = { ...f, job_id: job.job_id, at: job.finished_at || job.created_at };
      }
      if (activeJob && lastFailure) break;
    }
    const declared = Array.from(a.declared).sort();
    const aliasFrom = declared.find((d) => d !== a.version) ?? null;
    out.push({
      package_id: a.package_id,
      version: a.version,
      declared_versions: declared,
      alias: aliasFrom ? { declared: aliasFrom, resolved: a.version } : null,
      required_by: Array.from(a.requiredBy.values()).sort(
        (x, y) => Number(y.direct) - Number(x.direct) || x.package_id.localeCompare(y.package_id) || x.version.localeCompare(y.version),
      ),
      status: activeJob ? (activeJob.status === "queued" ? "queued" : "downloading") : lastFailure ? "failed" : "missing",
      active_job: activeJob,
      last_failure: lastFailure,
    });
  }
  // Most-needed first, then by name.
  out.sort((x, y) => y.required_by.length - x.required_by.length || x.package_id.localeCompare(y.package_id) || x.version.localeCompare(y.version));
  return out;
}

/** Validate + canonicalize a `{package_id, version}` request body. Returns an error string on bad input. */
export function parseDependencyRequest(body: unknown): { package_id: string; version: string } | { error: string } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const pid = String(b.package_id ?? "").trim();
  const ver = String(b.version ?? "").trim();
  if (!pid) return { error: "package_id is required" };
  if (!PACKAGE_ID_RE.test(pid)) return { error: "package_id may contain only letters, digits, '.', '_' and '-'" };
  if (!ver) return { error: "version is required (dependencies are fetched at an exact version)" };
  if (!PACKAGE_VERSION_RE.test(ver)) return { error: "version must be an exact version such as 4.0.1" };
  return { package_id: pid, version: canonicalDependencyVersion(pid, ver) };
}
