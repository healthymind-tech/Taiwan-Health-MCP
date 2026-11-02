/**
 * Offline FHIR package access for the parity harnesses (no network, no DB): finds `id#version` in the local package
 * caches, extracts `.tgz` packages named by path, reads a package's conformance resources and walks its dependency
 * closure. Used by scripts/parity/testcases/run.ts (official validator test suite) and the differential-corpus runner.
 *
 * Cache directories (first hit wins), override with PARITY_PACKAGE_DIRS (colon separated):
 *   /home/brian/tools/validator-cli/fhircache/packages, ~/.fhir/packages, ~/ref/fhir-test-cases/validator/packages
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";

export type Res = Record<string, any>;

export const PACKAGE_DIRS: string[] = (process.env.PARITY_PACKAGE_DIRS
  ? process.env.PARITY_PACKAGE_DIRS.split(":")
  : [join(homedir(), "tools", "validator-cli", "fhircache", "packages"), join(homedir(), ".fhir", "packages"), join(homedir(), "ref", "fhir-test-cases", "validator", "packages")]
).filter((d) => d && existsSync(d));

/** Where `.tgz` packages are unpacked (one dir per archive hash). */
const TGZ_CACHE = process.env.PARITY_TGZ_CACHE || join(tmpdir(), "parity-tgz-cache");

export interface PackageRef {
  id: string;
  version: string;
  /** The `package/` directory. */
  dir: string;
  fhirVersions: string[];
  dependencies: Record<string, string>;
}

function readJson(p: string): Res | null {
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Res;
  } catch {
    return null;
  }
}

/** Dotted version compare (numeric parts numerically; a pre-release suffix sorts before the release). */
export function cmpVersion(a: string, b: string): number {
  const [ma, pa = ""] = a.split("-", 2);
  const [mb, pb = ""] = b.split("-", 2);
  const xa = ma.split(".");
  const xb = mb.split(".");
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    const na = Number(xa[i] ?? 0);
    const nb = Number(xb[i] ?? 0);
    if (!Number.isNaN(na) && !Number.isNaN(nb) && na !== nb) return na - nb;
    if ((Number.isNaN(na) || Number.isNaN(nb)) && (xa[i] ?? "") !== (xb[i] ?? "")) return (xa[i] ?? "") < (xb[i] ?? "") ? -1 : 1;
  }
  if (pa === pb) return 0;
  if (pa === "") return 1;
  if (pb === "") return -1;
  return pa < pb ? -1 : 1;
}

export function refOf(dir: string): PackageRef | null {
  const pj = readJson(join(dir, "package.json"));
  if (!pj) return null;
  return {
    id: String(pj.name ?? ""),
    version: String(pj.version ?? ""),
    dir,
    fhirVersions: Array.isArray(pj.fhirVersions) ? pj.fhirVersions.map(String) : pj["fhir-version-list"] ?? [],
    dependencies: pj.dependencies && typeof pj.dependencies === "object" ? pj.dependencies : {},
  };
}

/** All cached versions of a package id, over every cache dir. */
function cachedVersions(id: string): Array<{ version: string; dir: string }> {
  const out: Array<{ version: string; dir: string }> = [];
  const seen = new Set<string>();
  for (const root of PACKAGE_DIRS) {
    let names: string[] = [];
    try {
      names = readdirSync(root);
    } catch {
      continue;
    }
    for (const n of names) {
      if (!n.startsWith(id + "#")) continue;
      const v = n.slice(id.length + 1);
      const dir = join(root, n, "package");
      if (seen.has(v) || !existsSync(join(dir, "package.json"))) continue;
      seen.add(v);
      out.push({ version: v, dir });
    }
  }
  return out;
}

/**
 * `id#version` → a cached package. No version / `current` / `dev` → the highest cached version; an exact version
 * first, else the highest version that starts with the requested one (5.3.0-ballot → 5.3.0-ballot-tc1), else (for
 * a major.minor request, as NPM ranges in package.json) the highest of that major.minor. null = not cached.
 */
export function findPackage(spec: string): PackageRef | null {
  const [id, version] = spec.split("#", 2) as [string, string | undefined];
  const all = cachedVersions(id);
  if (!all.length) return null;
  const sorted = [...all].sort((a, b) => cmpVersion(b.version, a.version));
  let hit: { version: string; dir: string } | undefined;
  if (!version || version === "current" || version === "dev" || version === "latest") hit = sorted.find((x) => !x.version.includes("-")) ?? sorted[0];
  else hit = all.find((x) => x.version === version) ?? sorted.find((x) => x.version.startsWith(version)) ?? (/^\d+\.\d+$/.test(version) ? sorted.find((x) => x.version.startsWith(version + ".")) : undefined);
  return hit ? refOf(hit.dir) : null;
}

/** Unpack a package `.tgz` (once per archive content) and return its `package/` dir. */
export function extractTgz(file: string): PackageRef | null {
  if (!existsSync(file)) return null;
  const h = createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 16);
  const out = join(TGZ_CACHE, `${basename(file).replace(/[^A-Za-z0-9#._-]/g, "_")}-${h}`);
  if (!existsSync(join(out, "package", "package.json"))) {
    mkdirSync(out, { recursive: true });
    const r = spawnSync("tar", ["-xzf", file, "-C", out, "--no-same-owner", "--no-same-permissions"], { stdio: "ignore" });
    if (r.status !== 0) return null;
  }
  return refOf(join(out, "package"));
}

const resourceCache = new Map<string, Res[]>();

/** Every top-level JSON resource of a package dir (index-free; examples are not loaded). */
export function packageResources(ref: PackageRef): Res[] {
  const hit = resourceCache.get(ref.dir);
  if (hit) return hit;
  const out: Res[] = [];
  for (const f of readdirSync(ref.dir)) {
    if (!f.endsWith(".json") || f === "package.json" || f.startsWith(".")) continue;
    const p = join(ref.dir, f);
    try {
      if (!statSync(p).isFile()) continue;
    } catch {
      continue;
    }
    const r = readJson(p);
    if (r && typeof r.resourceType === "string") out.push(r);
  }
  resourceCache.set(ref.dir, out);
  return out;
}

/**
 * R5-named dependencies an R4 package may carry, as the HL7 validator loads them for R4 (the `.r4` builds).
 * Core packages of other FHIR versions are not loaded (they are reported as `foreign`).
 */
function r4Equivalent(id: string): string | null {
  if (id === "hl7.fhir.uv.extensions") return "hl7.fhir.uv.extensions.r4";
  if (id === "hl7.terminology") return "hl7.terminology.r4";
  if (id === "hl7.fhir.uv.tools") return "hl7.fhir.uv.tools.r4";
  if (/^hl7\.fhir\.r(2|3|4b|5|6)\.(core|expansions|examples)$/.test(id) || id === "hl7.fhir.core") return null;
  return id;
}

export interface Closure {
  packages: PackageRef[];
  /** `id#version` specs that are not cached (dependencies included). */
  missing: string[];
  /** Dependencies skipped because they are core packages of another FHIR version. */
  foreign: string[];
}

/**
 * The dependency closure of `specs` (each `id#version` or a path to a `.tgz`; `relDir` resolves relative `.tgz`
 * paths), roots first then dependencies breadth-first; `skip` ids are not loaded (e.g. the base packages already in
 * the base layer). One version per package id (the first reached).
 */
export function packageClosure(specs: string[], opts: { relDir?: string; skip?: Set<string> } = {}): Closure {
  const packages: PackageRef[] = [];
  const missing: string[] = [];
  const foreign: string[] = [];
  const ids = new Set<string>(opts.skip ?? []);
  const queue: string[] = [...specs];
  while (queue.length) {
    const spec = queue.shift()!;
    let ref: PackageRef | null;
    if (spec.endsWith(".tgz")) {
      ref = extractTgz(opts.relDir && !spec.startsWith("/") ? join(opts.relDir, spec) : spec);
      if (!ref) {
        missing.push(spec);
        continue;
      }
    } else {
      const [rawId, ver] = spec.split("#", 2);
      const id = r4Equivalent(rawId);
      if (id === null) {
        foreign.push(spec);
        continue;
      }
      if (ids.has(id)) continue;
      ref = findPackage(ver ? `${id}#${ver}` : id);
      if (!ref) {
        missing.push(ver ? `${id}#${ver}` : id);
        ids.add(id);
        continue;
      }
    }
    if (ids.has(ref.id) && !spec.endsWith(".tgz")) continue;
    ids.add(ref.id);
    packages.push(ref);
    for (const [d, v] of Object.entries(ref.dependencies)) queue.push(`${d}#${v}`);
  }
  return { packages, missing, foreign };
}
