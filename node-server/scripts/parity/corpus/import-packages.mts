/**
 * Import FHIR packages into the measurement database through the normal loader (indexPackages), with their dependency
 * closure, from package tgz files. Refuses any database but the measurement one (port 55432), so production stays untouched.
 *
 *   DATABASE_URL=postgresql://…:55432/taiwan_health node --max-old-space-size=2800 --import tsx \
 *     scripts/parity/corpus/import-packages.mts [--dry-run] [--search dir[,dir]] [--download dir] <package.tgz>...
 *
 * Dependencies are looked up as <dir>/<id>#<version>.tgz or <dir>/<id>#<version>/package in the --search dirs (default: the
 * jar oracle's package cache, then ~/.fhir/packages); a dependency already in fhir.ig_packages is skipped; a missing one
 * is listed and nothing is imported, unless --download names a directory: then it is fetched from packages.fhir.org
 * (the original tgz; a `x` wildcard version resolves to the highest matching release) into that directory. Each package's .index.json is reported: index-version, and files whose index url
 * differs from their own url (the lookup follows the index, as NpmPackage does).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import pg from "pg";
import { indexPackages } from "../../../src/loaders/ig.js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const searchArg = args.includes("--search") ? args[args.indexOf("--search") + 1] : null;
const downloadDir = args.includes("--download") ? args[args.indexOf("--download") + 1] : null;
const tgzs = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--search" && args[i - 1] !== "--download");
const search = [...(searchArg?.split(",") ?? [join(homedir(), "tools/validator-oracle/home/.fhir/packages"), join(homedir(), ".fhir/packages")]), ...(downloadDir ? [downloadDir] : [])];
const url = process.env.DATABASE_URL ?? "";
if (!/:55432\//.test(url)) {
  console.error("refusing: DATABASE_URL must be the measurement database (port 55432)");
  process.exit(2);
}

const CORE_PACKAGES = new Set(["hl7.fhir.core", "hl7.fhir.r2.core", "hl7.fhir.r2b.core", "hl7.fhir.r3.core", "hl7.fhir.r4.core", "hl7.fhir.r4b.core", "hl7.fhir.r5.core", "hl7.fhir.r6.core"]);

/** A package as a directory holding package/package.json. */
function unpack(tgz: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pkg-"));
  execFileSync("tar", ["-xzf", tgz, "-C", dir, "--wildcards", "package/*.json"], { stdio: ["ignore", "ignore", "ignore"] });
  return dir;
}

function indexReport(dir: string): string {
  const p = join(dir, "package", ".index.json");
  if (!existsSync(p)) return "NO .index.json (the jar rebuilds it from the files)";
  const ix = JSON.parse(readFileSync(p, "utf8")) as { "index-version"?: number; files?: Array<{ filename: string; url?: string }> };
  const differ: string[] = [];
  for (const f of ix.files ?? []) {
    try {
      const own = (JSON.parse(readFileSync(join(dir, "package", f.filename), "utf8")) as { url?: string }).url;
      if (f.url && own && f.url !== own) differ.push(`${f.filename}: index ${f.url} file ${own}`);
    } catch {
      /* unreadable entries are the loader's business */
    }
  }
  return `index-version ${ix["index-version"]}, ${ix.files?.length ?? 0} files, ${differ.length} url differences${differ.length ? `\n    ${differ.join("\n    ")}` : ""}`;
}

/** Highest released version matching a `3.3.x` style pattern (the registry's version list). */
function resolveVersion(id: string, version: string): string {
  if (!/(^|\.)x$/.test(version)) return version;
  const list = JSON.parse(execFileSync("curl", ["-sfL", "-m", "60", `https://packages.fhir.org/${id}`], { encoding: "utf8" })) as { versions?: Record<string, unknown> };
  const prefix = version.slice(0, -1);
  const num = (v: string): number[] => v.split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : -1));
  const hits = Object.keys(list.versions ?? {}).filter((v) => v.startsWith(prefix) && /^[\d.]+$/.test(v));
  hits.sort((a, b) => { const x = num(a), y = num(b); for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0); return 0; });
  if (!hits.length) throw new Error(`no release of ${id} matches ${version}`);
  return hits[hits.length - 1];
}

function download(id: string, version: string): string | null {
  if (!downloadDir) return null;
  const out = join(downloadDir, `${id}#${version}.tgz`);
  execFileSync("mkdir", ["-p", downloadDir]);
  execFileSync("curl", ["-sfL", "-m", "300", "-o", out, `https://packages.fhir.org/${id}/${version}`]);
  console.log(`downloaded ${id}#${version} -> ${out}`);
  return out;
}

function findDep(id: string, version: string): string | null {
  for (const d of search) {
    const tgz = join(d, `${id}#${version}.tgz`);
    if (existsSync(tgz)) return tgz;
    if (existsSync(join(d, `${id}#${version}`, "package", "package.json"))) return join(d, `${id}#${version}`);
  }
  return null;
}

function toTgz(path: string): string {
  if (path.endsWith(".tgz")) return path;
  const out = join(mkdtempSync(join(tmpdir(), "pkg-")), "package.tgz");
  execFileSync("tar", ["-C", path, "-czf", out, "package"]);
  return out;
}

const pool = new pg.Pool({ connectionString: url, max: 4 });
const installed = new Set((await pool.query<{ k: string }>("SELECT package_id || '#' || version AS k FROM fhir.ig_packages")).rows.map((r) => r.k));
const order: Array<{ key: string; path: string }> = [];
const seen = new Set<string>();
const missing: string[] = [];

function visit(path: string): void {
  const dir = path.endsWith(".tgz") ? unpack(path) : path;
  const m = JSON.parse(readFileSync(join(dir, "package", "package.json"), "utf8")) as { name: string; version: string; dependencies?: Record<string, string> };
  const key = `${m.name}#${m.version}`;
  const report = seen.has(key) ? "" : indexReport(dir);
  // the unpacked copy is only read here; the import re-reads the tgz
  if (dir !== path) rmSync(dir, { recursive: true, force: true });
  if (seen.has(key)) return;
  seen.add(key);
  console.log(`${key}${installed.has(key) ? " (installed)" : ""}: ${report}`);
  for (const [id, wanted] of Object.entries(m.dependencies ?? {})) {
    // validator_cli never loads a core package as a dependency (IgLoader l. 150 / 576, VersionUtilities.isCorePackage)
    if (CORE_PACKAGES.has(id)) continue;
    const version = resolveVersion(id, wanted);
    const dep = `${id}#${version}`;
    if (seen.has(dep)) continue;
    if (installed.has(dep)) {
      seen.add(dep);
      continue;
    }
    const found = findDep(id, version) ?? download(id, version);
    if (found) visit(found);
    else if (!missing.includes(dep)) missing.push(`${dep} (needed by ${key})`);
  }
  if (!installed.has(key)) order.push({ key, path });
}

for (const t of tgzs) visit(t);
if (missing.length) {
  console.error(`missing, nothing imported:\n  ${missing.join("\n  ")}`);
  await pool.end();
  process.exit(3);
}
console.log(`to import (dependencies first): ${order.map((o) => o.key).join(", ") || "nothing"}`);
if (!dryRun) {
  // one call per package: a default-IG decision is the loader's, the existing default stays
  for (const o of order) {
    const tgz = toTgz(o.path);
    await indexPackages(pool, [tgz]);
    if (tgz !== o.path) rmSync(dirname(tgz), { recursive: true, force: true });
  }
  console.log("imported");
}
await pool.end();
