/**
 * FHIR package registry client — Node port of `src/fhir_registry.py`.
 *
 * Resolves Implementation Guide packages from an npm-style FHIR package registry
 * (default `packages.fhir.org`) so the IG import can pull a package by
 * `packageId@version` and recursively fetch its declared dependency IGs.
 *
 * Verified registry shape (identical to the Python client):
 *   - GET {base}/{packageId}           → npm metadata
 *       { name, "dist-tags": {latest}, versions: { "x.y.z": {version, fhirVersion,
 *         dist: {shasum, tarball}} } }
 *   - GET {base}/{packageId}/{version} → the package `.tgz` (gzip)
 *   - GET {base}/catalog?op=find&name= → [{Name, Description, FhirVersion}, …]
 *
 * The authoritative dependency list lives inside each tarball's
 * `package/package.json` (parsed in ig.ts), NOT in this registry metadata.
 *
 * Honesty contract: a package that cannot be fetched throws `RegistryError`
 * (never a fabricated package). `search` is best-effort and returns [] on failure.
 */

import crypto from "crypto";

export const DEFAULT_REGISTRY = "https://packages.fhir.org";
export const FALLBACK_REGISTRY = "https://packages2.fhir.org";

const TIMEOUT_MS = 30000;
const GZIP_MAGIC_0 = 0x1f;
const GZIP_MAGIC_1 = 0x8b;

export class RegistryError extends Error {
  code = "REGISTRY_ERROR";
  constructor(message: string) {
    super(message);
    this.name = "RegistryError";
  }
}

/** Coerce a configured registry base into a clean `https://host` (no slash). */
export function normalizeBase(base?: string | null): string {
  let cleaned = (base || DEFAULT_REGISTRY).trim().replace(/\/+$/, "");
  if (!cleaned) return DEFAULT_REGISTRY;
  if (!cleaned.startsWith("http://") && !cleaned.startsWith("https://")) {
    cleaned = "https://" + cleaned;
  }
  return cleaned;
}

/** Split a user-typed `packageId@version` (version optional) → [id, ver|null]. */
export function parseCoordinate(text: string): [string, string | null] {
  const raw = (text || "").trim();
  if (raw.includes("@")) {
    const at = raw.lastIndexOf("@");
    const pid = raw.slice(0, at).trim();
    const ver = raw.slice(at + 1).trim();
    return [pid, ver || null];
  }
  return [raw, null];
}

async function fetchWithTimeout(url: string, accept: string): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, {
      headers: { Accept: accept },
      redirect: "follow",
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch npm-style package metadata. Throws RegistryError on 404/network. */
export async function getMetadata(base: string, packageId: string): Promise<any> {
  base = normalizeBase(base);
  const url = `${base}/${packageId}`;
  let resp: Response;
  try {
    resp = await fetchWithTimeout(url, "application/json");
  } catch (exc) {
    throw new RegistryError(`registry unreachable for '${packageId}': ${exc}`);
  }
  if (resp.status !== 200) {
    throw new RegistryError(
      `registry metadata for '${packageId}' returned HTTP ${resp.status}`,
    );
  }
  let data: any;
  try {
    data = await resp.json();
  } catch (exc) {
    throw new RegistryError(`registry metadata for '${packageId}' was not valid JSON`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new RegistryError(`registry metadata for '${packageId}' was not an object`);
  }
  return data;
}

/** Resolve an explicit version, else the `dist-tags.latest` from metadata. */
export function resolveVersion(meta: any, version: string | null): string {
  const versions = meta.versions || {};
  if (version) {
    // Accept the requested version even if metadata omits it — the tarball
    // endpoint may still serve it (mirrors the Python client).
    return version;
  }
  const latest = (meta["dist-tags"] || {}).latest;
  if (typeof latest === "string" && latest) return latest;
  const keys = Object.keys(versions);
  if (keys.length) return keys.sort()[keys.length - 1];
  throw new RegistryError(`no version resolvable for package '${meta.name || "?"}'`);
}

function tarballFromMeta(meta: any, version: string): string | null {
  const entry = (meta.versions || {})[version] || {};
  const dist = entry.dist || {};
  const tarball = dist.tarball;
  return typeof tarball === "string" && tarball ? tarball : null;
}

function shasumFromMeta(meta: any, version: string): string | null {
  const entry = (meta.versions || {})[version] || {};
  const dist = entry.dist || {};
  const shasum = dist.shasum;
  return typeof shasum === "string" && shasum ? shasum : null;
}

async function getBytes(url: string): Promise<Buffer | null> {
  let resp: Response;
  try {
    resp = await fetchWithTimeout(url, "application/gzip, */*");
  } catch {
    return null;
  }
  if (resp.status !== 200) return null;
  return Buffer.from(await resp.arrayBuffer());
}

/**
 * Download a package `.tgz`, trying in order:
 *   1. {base}/{id}/{version}
 *   2. the dist.tarball URL from meta (often packages.simplifier.net)
 *   3. {fallback}/{id}/{version}
 * Verifies the SHA-1 `shasum` from meta when present, and that the payload is
 * gzip. Throws RegistryError when every source fails.
 */
export async function downloadTarball(
  base: string,
  packageId: string,
  version: string,
  opts: { meta?: any; fallback?: string | null } = {},
): Promise<Buffer> {
  base = normalizeBase(base);
  const meta = opts.meta || {};
  const fallback = opts.fallback === undefined ? FALLBACK_REGISTRY : opts.fallback;
  const candidates = [`${base}/${packageId}/${version}`];
  const metaTarball = tarballFromMeta(meta, version);
  if (metaTarball) candidates.push(metaTarball);
  if (fallback) candidates.push(`${normalizeBase(fallback)}/${packageId}/${version}`);

  const expectedSha = shasumFromMeta(meta, version);
  let lastReason = "no source returned data";
  for (const url of candidates) {
    const data = await getBytes(url);
    if (!data || data.length === 0) {
      lastReason = `empty/non-200 from ${url}`;
      continue;
    }
    if (data[0] !== GZIP_MAGIC_0 || data[1] !== GZIP_MAGIC_1) {
      lastReason = `non-gzip payload from ${url}`;
      continue;
    }
    if (expectedSha) {
      const actual = crypto.createHash("sha1").update(data).digest("hex");
      if (actual.toLowerCase() !== expectedSha.toLowerCase()) {
        lastReason = `shasum mismatch from ${url}`;
        continue;
      }
    }
    return data;
  }
  throw new RegistryError(`could not download ${packageId}@${version}: ${lastReason}`);
}

/** Autocomplete search via GET {base}/catalog?op=find&name={q}. Best-effort. */
export async function search(base: string, query: string): Promise<
  { name: string; description: string; fhirVersion: string }[]
> {
  const q = (query || "").trim();
  if (!q) return [];
  base = normalizeBase(base);
  let data: any;
  try {
    const url = `${base}/catalog?op=find&name=${encodeURIComponent(q)}`;
    const resp = await fetchWithTimeout(url, "application/json");
    if (resp.status !== 200) return [];
    data = await resp.json();
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const out: { name: string; description: string; fhirVersion: string }[] = [];
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const name = item.Name || item.name;
    if (!name) continue;
    out.push({
      name: String(name),
      description: String(item.Description || item.description || ""),
      fhirVersion: String(item.FhirVersion || item.fhirVersion || ""),
    });
  }
  return out;
}
