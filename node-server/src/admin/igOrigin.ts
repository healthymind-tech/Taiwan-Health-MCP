/**
 * How an installed FHIR IG package got there: picked by an operator ("manual")
 * or fetched to satisfy another IG's dependencies ("dependency").
 *
 * Stored on `fhir.ig_packages.install_origin` / `installed_for` (migration
 * 20261019_ig_install_origin.sql). Pure helpers — no DB access — so the import
 * job, the CLI loader and the admin list endpoint share one definition.
 */

import { canonicalDependencyVersion } from "../loaders/igRegistry.js";

export type InstallOrigin = "manual" | "dependency";

export interface IgCoordinate {
  package_id: string;
  version: string;
}

export interface InstallOriginInfo {
  origin: InstallOrigin;
  /** The IG whose install pulled this package in (dependency installs only, when known). */
  installed_for: IgCoordinate | null;
}

function coordinate(value: unknown): IgCoordinate | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const pid = typeof v.package_id === "string" ? v.package_id.trim() : "";
  const ver = typeof v.version === "string" ? v.version.trim() : "";
  return pid && ver ? { package_id: pid, version: ver } : null;
}

/**
 * Origin of the package at position `index` of an `ig_import` job's package list.
 *
 * - `ig_source: "dependencies"` (download-missing-dependency jobs): every package
 *   is a dependency, installed for `job_options.requested_for` when the job was
 *   started from one IG.
 * - registry / upload: the first package is the root the operator chose →
 *   manual, unless the upload was made to supply a missing dependency
 *   (`expected_package`) → dependency. Every further package was fetched while
 *   walking the root's dependencies → dependency, installed for the root.
 */
export function originForImportedPackage(opts: {
  igSource: string;
  index: number;
  jobOptions: Record<string, unknown>;
  root: IgCoordinate | null;
}): InstallOriginInfo {
  const { igSource, index, jobOptions, root } = opts;
  const requestedFor = coordinate(jobOptions.requested_for);
  if (igSource === "dependencies") return { origin: "dependency", installed_for: requestedFor };
  if (index === 0) {
    if (coordinate(jobOptions.expected_package)) return { origin: "dependency", installed_for: requestedFor };
    return { origin: "manual", installed_for: null };
  }
  return { origin: "dependency", installed_for: root };
}

/**
 * Upsert fragment for `fhir.ig_packages`: "manual" is sticky — a package an
 * operator ever imported directly stays manual when it is re-fetched, while a
 * dependency that is later imported directly becomes manual. A dependency keeps
 * the IG that first pulled it in.
 */
export const ORIGIN_UPSERT_SQL = `install_origin = CASE
             WHEN fhir.ig_packages.install_origin = 'manual' OR EXCLUDED.install_origin = 'manual' THEN 'manual'
             ELSE 'dependency' END,
           installed_for = CASE
             WHEN fhir.ig_packages.install_origin = 'manual' OR EXCLUDED.install_origin = 'manual' THEN NULL
             ELSE COALESCE(fhir.ig_packages.installed_for, EXCLUDED.installed_for) END`;

/** Normalize a stored `install_origin` value (NULL / unknown → null). */
export function parseInstallOrigin(value: unknown): InstallOrigin | null {
  return value === "manual" || value === "dependency" ? value : null;
}

/** Normalize a stored `installed_for` JSONB value. */
export function parseInstalledFor(value: unknown): IgCoordinate | null {
  if (typeof value === "string") {
    try {
      return coordinate(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return coordinate(value);
}

/**
 * Installed packages that declare `target` as a direct dependency. Declared
 * versions are resolved through the registry aliases (core 4.0.0 → 4.0.1),
 * so twcore (declares core 4.0.0) counts as requiring core 4.0.1.
 */
export function directDependents(
  packages: { package_id: string; version: string; dependencies: Record<string, string> }[],
): Map<string, IgCoordinate[]> {
  const out = new Map<string, IgCoordinate[]>();
  for (const p of packages) {
    for (const [depId, depVer] of Object.entries(p.dependencies)) {
      const k = `${depId}@${canonicalDependencyVersion(depId, String(depVer))}`;
      if (depId === p.package_id) continue;
      const list = out.get(k) ?? [];
      if (!list.some((x) => x.package_id === p.package_id && x.version === p.version)) {
        list.push({ package_id: p.package_id, version: p.version });
      }
      out.set(k, list);
    }
  }
  return out;
}
