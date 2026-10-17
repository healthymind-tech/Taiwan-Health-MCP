/**
 * Safe removal of installed FHIR IG packages.
 *
 * Removing a package that another installed IG depends on (directly or
 * transitively) silently breaks that IG's validation and ValueSet expansion,
 * and removing the default IG leaves every MCP tool call without an explicit
 * `ig` on an arbitrary fallback. Both are therefore refused unless the caller
 * asks for `force` (recorded in the audit log) or, for the default IG, names a
 * replacement default.
 *
 * Pure planning helpers + a transactional executor that takes its DB runner by
 * injection, so the rules are unit-testable without Postgres.
 */

import { canonicalDependencyVersion } from "../loaders/igRegistry.js";
import { parseInstallOrigin, type IgCoordinate, type InstallOrigin } from "./igOrigin.js";

export interface InstalledIg {
  package_id: string;
  version: string;
  title?: string | null;
  is_default: boolean;
  install_origin: InstallOrigin | null;
  /** Declared dependencies (raw declared versions; aliases resolved here). */
  dependencies: Record<string, string>;
}

export interface IgRefWithTitle extends IgCoordinate {
  title: string;
}

export interface DependentInfo extends IgRefWithTitle {
  /** Declares one of the removed packages as a direct dependency. */
  direct: boolean;
  /** The package it needs that disappears (direct: a removed package; transitive: the next hop). */
  via: IgCoordinate;
  is_default: boolean;
  install_origin: InstallOrigin | null;
}

/** Stable error codes returned to the admin UI. */
export const IG_REMOVAL_CODES = {
  notFound: "IG_NOT_FOUND",
  hasDependents: "IG_HAS_DEPENDENTS",
  isDefault: "IG_IS_DEFAULT",
  invalidNewDefault: "IG_INVALID_NEW_DEFAULT",
  inUse: "IG_DEPENDENCY_IN_USE",
  noTargets: "IG_NO_TARGETS",
} as const;
export type IgRemovalCode = (typeof IG_REMOVAL_CODES)[keyof typeof IG_REMOVAL_CODES];

const k = (pid: string, ver: string): string => `${pid}@${ver}`;
const kc = (c: IgCoordinate): string => k(c.package_id, c.version);
const titled = (p: InstalledIg): IgRefWithTitle => ({ package_id: p.package_id, version: p.version, title: p.title || p.package_id });

/** Declared dependencies of `p` as installed-package keys (core 4.0.0 → 4.0.1), self-references dropped. */
function depKeys(p: InstalledIg): string[] {
  const out: string[] = [];
  for (const [depId, depVer] of Object.entries(p.dependencies ?? {})) {
    if (depId === p.package_id) continue;
    out.push(k(depId, canonicalDependencyVersion(depId, String(depVer))));
  }
  return out;
}

/**
 * Installed packages outside `targets` that need any of `targets`, directly or
 * through other installed packages. Breadth-first over reverse dependency
 * edges, so `via` is the nearest package on the path to a removed one.
 */
export function dependentsOf(packages: InstalledIg[], targets: IgCoordinate[]): DependentInfo[] {
  const byKey = new Map(packages.map((p) => [kc(p), p]));
  const targetKeys = new Set(targets.map(kc));
  const reverse = new Map<string, string[]>();
  for (const p of packages) {
    for (const d of depKeys(p)) {
      const list = reverse.get(d) ?? [];
      list.push(kc(p));
      reverse.set(d, list);
    }
  }
  const seen = new Set<string>(targetKeys);
  const out: DependentInfo[] = [];
  let frontier = [...targetKeys];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const cur of frontier) {
      for (const depender of reverse.get(cur) ?? []) {
        if (seen.has(depender)) continue;
        seen.add(depender);
        const p = byKey.get(depender);
        if (!p) continue;
        const [vid, vver] = splitKey(cur);
        out.push({
          ...titled(p),
          direct: targetKeys.has(cur),
          via: { package_id: vid, version: vver },
          is_default: Boolean(p.is_default),
          install_origin: p.install_origin,
        });
        next.push(depender);
      }
    }
    frontier = next;
  }
  // Direct dependents first, then by id for a stable list.
  return out.sort((a, b) => Number(b.direct) - Number(a.direct) || kc(a).localeCompare(kc(b)));
}

function splitKey(key: string): [string, string] {
  const at = key.lastIndexOf("@");
  return [key.slice(0, at), key.slice(at + 1)];
}

export interface UnusedDependency extends IgRefWithTitle {
  /** Other unused packages that still declare it (they go away together). */
  needed_only_by: IgCoordinate[];
}

/**
 * Packages installed as dependencies (`install_origin = 'dependency'`) that no
 * remaining root needs. Roots are every package not known to be a dependency
 * install (manual, or origin unknown — never guess those away) plus the
 * default IG. Everything reachable from a root through installed packages is
 * in use; the rest is safe to remove as one set.
 */
export function unusedDependencies(packages: InstalledIg[]): UnusedDependency[] {
  const byKey = new Map(packages.map((p) => [kc(p), p]));
  const used = new Set<string>();
  let frontier = packages.filter((p) => p.install_origin !== "dependency" || p.is_default).map(kc);
  for (const r of frontier) used.add(r);
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const cur of frontier) {
      const p = byKey.get(cur);
      if (!p) continue;
      for (const d of depKeys(p)) {
        if (used.has(d) || !byKey.has(d)) continue;
        used.add(d);
        next.push(d);
      }
    }
    frontier = next;
  }
  const unused = packages.filter((p) => !used.has(kc(p)));
  const unusedKeys = new Set(unused.map(kc));
  return unused
    .map((p) => ({
      ...titled(p),
      needed_only_by: unused
        .filter((q) => q !== p && depKeys(q).includes(kc(p)) && unusedKeys.has(kc(q)))
        .map((q) => ({ package_id: q.package_id, version: q.version })),
    }))
    .sort((a, b) => kc(a).localeCompare(kc(b)));
}

export interface RemovalOptions {
  force?: boolean;
  /** Replacement default when a removed package is the default IG. */
  newDefault?: IgCoordinate | null;
  /** Bulk cleanup: every target must currently be an unused dependency. */
  requireUnused?: boolean;
}

export type RemovalPlan =
  | {
      ok: true;
      targets: (IgRefWithTitle & { is_default: boolean })[];
      /** Dependents that will break (non-empty only when forced). */
      broken: DependentInfo[];
      removes_default: boolean;
      new_default: IgCoordinate | null;
      forced: boolean;
    }
  | {
      ok: false;
      status: number;
      code: IgRemovalCode;
      error: string;
      /** Every blocking code, in priority order (code === blockers[0]). */
      blockers: IgRemovalCode[];
      dependents: DependentInfo[];
      removes_default: boolean;
      default_candidates: IgRefWithTitle[];
      not_found?: IgCoordinate[];
      in_use?: IgCoordinate[];
    };

/** Installed packages that could take over as default when `targets` go away (manual first). */
export function defaultCandidates(packages: InstalledIg[], targets: IgCoordinate[]): IgRefWithTitle[] {
  const t = new Set(targets.map(kc));
  return packages
    .filter((p) => !t.has(kc(p)))
    .sort((a, b) => Number(b.install_origin === "manual") - Number(a.install_origin === "manual") || kc(a).localeCompare(kc(b)))
    .map(titled);
}

/** Decide whether removing `targets` (as one set) is allowed, and what it breaks. */
export function planRemoval(packages: InstalledIg[], targets: IgCoordinate[], opts: RemovalOptions = {}): RemovalPlan {
  const force = opts.force === true;
  const byKey = new Map(packages.map((p) => [kc(p), p]));
  const uniq = [...new Map(targets.map((t) => [kc(t), t])).values()];
  const fail = (
    status: number,
    code: IgRemovalCode,
    error: string,
    extra: Partial<Extract<RemovalPlan, { ok: false }>> = {},
  ): RemovalPlan => ({
    ok: false,
    status,
    code,
    error,
    blockers: [code],
    dependents: [],
    removes_default: false,
    default_candidates: [],
    ...extra,
  });

  if (uniq.length === 0) return fail(400, IG_REMOVAL_CODES.noTargets, "No IG packages to remove");
  const notFound = uniq.filter((t) => !byKey.has(kc(t)));
  if (notFound.length > 0) {
    return fail(404, IG_REMOVAL_CODES.notFound, `IG not installed: ${notFound.map(kc).join(", ")}`, { not_found: notFound });
  }
  if (opts.requireUnused) {
    const unused = new Set(unusedDependencies(packages).map(kc));
    const inUse = uniq.filter((t) => !unused.has(kc(t)));
    if (inUse.length > 0) {
      return fail(
        409,
        IG_REMOVAL_CODES.inUse,
        `Not an unused dependency (still needed, installed manually, or the default IG): ${inUse.map(kc).join(", ")}`,
        { in_use: inUse },
      );
    }
  }

  const targetRows = uniq.map((t) => byKey.get(kc(t))!);
  const removesDefault = targetRows.some((p) => p.is_default);
  const candidates = removesDefault ? defaultCandidates(packages, uniq) : [];

  let newDefault: IgCoordinate | null = null;
  if (opts.newDefault) {
    const nd = opts.newDefault;
    if (!byKey.has(kc(nd)) || uniq.some((t) => kc(t) === kc(nd))) {
      return fail(400, IG_REMOVAL_CODES.invalidNewDefault, `new_default ${kc(nd)} must be an installed IG that is not being removed`, {
        removes_default: removesDefault,
        default_candidates: candidates,
      });
    }
    if (removesDefault) newDefault = { package_id: nd.package_id, version: nd.version };
  }

  const dependents = dependentsOf(packages, uniq);
  const blockers: IgRemovalCode[] = [];
  if (dependents.length > 0) blockers.push(IG_REMOVAL_CODES.hasDependents);
  if (removesDefault && !newDefault && candidates.length > 0) blockers.push(IG_REMOVAL_CODES.isDefault);

  if (blockers.length > 0 && !force) {
    const label = uniq.map(kc).join(", ");
    const error =
      blockers[0] === IG_REMOVAL_CODES.hasDependents
        ? `${label} is required by ${dependents.length} installed IG(s): ${dependents.map(kc).join(", ")}. Pass force=true to remove anyway.`
        : `${label} is the default IG. Choose another default (new_default) or pass force=true.`;
    return {
      ok: false,
      status: 409,
      code: blockers[0],
      error,
      blockers,
      dependents,
      removes_default: removesDefault,
      default_candidates: candidates,
    };
  }

  return {
    ok: true,
    targets: targetRows.map((p) => ({ ...titled(p), is_default: Boolean(p.is_default) })),
    broken: dependents,
    removes_default: removesDefault,
    new_default: newDefault,
    forced: force && blockers.length > 0,
  };
}

/**
 * Packages that become unused dependencies once `targets` are removed (they
 * were only kept alive by the removed packages). Shown as a cleanup hint.
 */
export function orphanedBy(packages: InstalledIg[], targets: IgCoordinate[]): IgRefWithTitle[] {
  const t = new Set(targets.map(kc));
  const before = new Set(unusedDependencies(packages).map(kc));
  return unusedDependencies(packages.filter((p) => !t.has(kc(p))))
    .filter((u) => !before.has(kc(u)))
    .map(({ package_id, version, title }) => ({ package_id, version, title }));
}

// ── Transactional executor ──────────────────────────────────────────────────

export interface TxClient {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface RemovalDeps {
  transaction: <T>(fn: (client: TxClient) => Promise<T>) => Promise<T>;
  /** Best-effort archive cleanup (MinIO), called after commit. */
  removeArchive?: (pkg: IgCoordinate) => Promise<void>;
  /** Called after commit when a forced removal broke dependents or dropped the default. */
  onForced?: (info: { removedBy: string; targets: IgCoordinate[]; broken: DependentInfo[]; removesDefault: boolean }) => void;
}

/**
 * Locks the package table, reads its current state and plans against it, so a
 * concurrent import cannot slip a new dependent in between check and delete.
 * `to_jsonb(g)->>'install_origin'` keeps this working on a database the
 * 20261019 migration has not reached yet (origin then reads as unknown).
 */
export const LOCKED_PACKAGES_SQL =
  "SELECT package_id, version, title, is_default, dependencies, to_jsonb(g)->>'install_origin' AS install_origin " +
  "FROM fhir.ig_packages g ORDER BY package_id, version FOR UPDATE";

export function rowToInstalled(r: Record<string, unknown>): InstalledIg {
  let deps: unknown = r.dependencies;
  if (typeof deps === "string") {
    try {
      deps = JSON.parse(deps);
    } catch {
      deps = {};
    }
  }
  const dependencies: Record<string, string> = {};
  if (deps && typeof deps === "object" && !Array.isArray(deps)) {
    for (const [dk, dv] of Object.entries(deps as Record<string, unknown>)) {
      if (dk && dv !== null && dv !== undefined && String(dv)) dependencies[dk] = String(dv);
    }
  }
  return {
    package_id: String(r.package_id),
    version: String(r.version),
    title: r.title === null || r.title === undefined ? null : String(r.title),
    is_default: Boolean(r.is_default),
    install_origin: parseInstallOrigin(r.install_origin),
    dependencies,
  };
}

export type RemovalResult =
  | (Extract<RemovalPlan, { ok: false }> & { removed: false })
  | {
      ok: true;
      removed: true;
      packages: (IgRefWithTitle & { is_default: boolean })[];
      /** Single-package compatibility fields. */
      package_id: string;
      version: string;
      was_default: boolean;
      new_default: IgCoordinate | null;
      forced: boolean;
      dependents: DependentInfo[];
    };

export async function removeIgPackages(
  deps: RemovalDeps,
  opts: RemovalOptions & { targets: IgCoordinate[]; removedBy: string; reason?: string },
): Promise<RemovalResult> {
  const outcome = await deps.transaction(async (client) => {
    const rows = await client.query(LOCKED_PACKAGES_SQL);
    const packages = rows.rows.map(rowToInstalled);
    const plan = planRemoval(packages, opts.targets, opts);
    if (!plan.ok) return plan;
    for (const t of plan.targets) {
      await client.query("DELETE FROM fhir.ig_packages WHERE package_id = $1 AND version = $2", [t.package_id, t.version]);
    }
    if (plan.new_default) {
      await client.query("UPDATE fhir.ig_packages SET is_default = FALSE WHERE is_default");
      await client.query("UPDATE fhir.ig_packages SET is_default = TRUE WHERE package_id = $1 AND version = $2", [
        plan.new_default.package_id,
        plan.new_default.version,
      ]);
    }
    for (const t of plan.targets) {
      await client.query(
        `INSERT INTO admin.admin_audit_log (admin_user, action, target_type, target_id, payload_json)
         VALUES ($1, $2, 'ig_package', $3, $4::jsonb)`,
        [
          opts.removedBy,
          plan.forced ? "remove_ig_forced" : "remove_ig",
          kc(t),
          JSON.stringify({
            forced: plan.forced,
            ...(plan.forced ? { forced_by: opts.removedBy } : {}),
            reason: opts.reason ?? "manual",
            batch: plan.targets.length > 1 ? plan.targets.map(kc) : undefined,
            was_default: t.is_default,
            new_default: plan.new_default ? kc(plan.new_default) : null,
            dependents: plan.broken.map((d) => ({ package_id: d.package_id, version: d.version, direct: d.direct })),
          }),
        ],
      );
    }
    return plan;
  });

  if (!outcome.ok) return { ...outcome, removed: false };
  if (deps.removeArchive) {
    for (const t of outcome.targets) {
      try {
        await deps.removeArchive(t);
      } catch {
        // best-effort: a missing tarball must not fail the removal
      }
    }
  }
  if (outcome.forced && deps.onForced) {
    deps.onForced({ removedBy: opts.removedBy, targets: outcome.targets, broken: outcome.broken, removesDefault: outcome.removes_default });
  }
  const first = outcome.targets[0];
  return {
    ok: true,
    removed: true,
    packages: outcome.targets,
    package_id: first.package_id,
    version: first.version,
    was_default: outcome.removes_default,
    new_default: outcome.new_default,
    forced: outcome.forced,
    dependents: outcome.broken,
  };
}
