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

/** GET a binary payload; on failure, say why (HTTP status vs network) so callers can classify it. */
async function getBytes(url: string): Promise<{ data: Buffer | null; failure: string | null }> {
  let resp: Response;
  try {
    resp = await fetchWithTimeout(url, "application/gzip, */*");
  } catch (exc) {
    return { data: null, failure: `network error from ${url}: ${(exc as Error)?.message ?? exc}` };
  }
  if (resp.status !== 200) return { data: null, failure: `HTTP ${resp.status} from ${url}` };
  const data = Buffer.from(await resp.arrayBuffer());
  return data.length === 0 ? { data: null, failure: `empty payload from ${url}` } : { data, failure: null };
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
  const metaSha = shasumFromMeta(meta, version);
  type Candidate = { url: string; sha: string | null };
  const candidates: (Candidate | (() => Promise<Candidate | null>))[] = [{ url: `${base}/${packageId}/${version}`, sha: metaSha }];
  const metaTarball = tarballFromMeta(meta, version);
  if (metaTarball) candidates.push({ url: metaTarball, sha: metaSha });
  if (fallback) {
    const fb = normalizeBase(fallback);
    candidates.push({ url: `${fb}/${packageId}/${version}`, sha: metaSha });
    // packages2.fhir.org speaks a different API: per-version metadata lives at
    // /packages/{id}/{version} and the tarball under /web/…, and it carries
    // versions the primary registry never got (e.g. us.nlm.vsac ≥ 0.18.0).
    // Looked up only when everything above has failed.
    candidates.push(async () => {
      const fbMeta = await getVersionMetadata(fb, packageId, version);
      return fbMeta ? { url: fbMeta.tarball, sha: fbMeta.shasum } : null;
    });
  }

  // Every attempt's outcome is kept: the last one alone ("404 from the
  // fallback") hides that the primary was merely unreachable.
  const failures: string[] = [];
  for (const entry of candidates) {
    const candidate = typeof entry === "function" ? await entry() : entry;
    if (!candidate) continue;
    const { url, sha: expectedSha } = candidate;
    const { data, failure } = await getBytes(url);
    if (!data) {
      failures.push(failure ?? `no data from ${url}`);
      continue;
    }
    if (data[0] !== GZIP_MAGIC_0 || data[1] !== GZIP_MAGIC_1) {
      failures.push(`non-gzip payload from ${url}`);
      continue;
    }
    if (expectedSha) {
      const actual = crypto.createHash("sha1").update(data).digest("hex");
      if (actual.toLowerCase() !== expectedSha.toLowerCase()) {
        failures.push(`shasum mismatch from ${url}`);
        continue;
      }
    }
    return data;
  }
  throw new RegistryError(
    `could not download ${packageId}@${version}: ${failures.length ? failures.join("; ") : "no source returned data"}`,
  );
}

/**
 * Fetch one exact package `packageId@version` (or the latest when version is
 * null) through the whole fallback chain. Unlike `getMetadata` + `downloadTarball`,
 * a primary registry that has never heard of the package (metadata 404) does
 * not stop the attempt: the tarball endpoints and packages2 are still tried,
 * since packages2 carries packages the primary lacks.
 */
export async function fetchPackage(
  base: string,
  packageId: string,
  version: string | null,
  opts: { fallback?: string | null } = {},
): Promise<{ data: Buffer; version: string }> {
  let meta: any = {};
  let metaError: RegistryError | null = null;
  try {
    meta = await getMetadata(base, packageId);
  } catch (exc) {
    if (!(exc instanceof RegistryError)) throw exc;
    metaError = exc;
  }
  // Without metadata only an explicit version can be fetched.
  if (metaError && !version) throw metaError;
  const resolved = resolveVersion(meta, version);
  try {
    const data = await downloadTarball(base, packageId, resolved, { meta, fallback: opts.fallback });
    return { data, version: resolved };
  } catch (exc) {
    if (exc instanceof RegistryError && metaError) {
      throw new RegistryError(`${exc.message}; ${metaError.message}`);
    }
    throw exc;
  }
}

/** Why a registry download failed, as a stable code the admin UI can act on. */
export type RegistryFailureKind = "not_found" | "network" | "checksum" | "invalid_package" | "unknown";

/**
 * Classify a registry failure message (from `RegistryError`, possibly stored in
 * an older job's result summary). Integrity problems win over transport ones,
 * and any network error wins over "not found": a 404 from the fallback says
 * nothing about a primary registry that could not be reached.
 */
export function classifyRegistryFailure(reason: string | null | undefined): RegistryFailureKind {
  const text = String(reason ?? "");
  if (!text) return "unknown";
  if (/shasum mismatch/i.test(text)) return "checksum";
  if (/non-gzip|not a valid|package\.json|invalid package/i.test(text)) return "invalid_package";
  if (/network error|unreachable|aborted|timed? ?out|ECONN|ENOTFOUND|EAI_AGAIN|fetch failed|HTTP 5\d\d/i.test(text)) return "network";
  if (/HTTP 404|HTTP 410|empty\/non-200|empty payload|returned HTTP 4\d\d|no version resolvable/i.test(text)) return "not_found";
  return "unknown";
}

/** packages2-style per-version metadata: GET {base}/packages/{id}/{version}. Best-effort. */
async function getVersionMetadata(
  base: string,
  packageId: string,
  version: string,
): Promise<{ tarball: string; shasum: string | null } | null> {
  try {
    const resp = await fetchWithTimeout(`${base}/packages/${packageId}/${version}`, "application/json");
    if (resp.status !== 200) return null;
    const data = (await resp.json()) as { dist?: { tarball?: unknown; shasum?: unknown }; url?: unknown };
    const tarball = typeof data.dist?.tarball === "string" ? data.dist.tarball : typeof data.url === "string" ? data.url : "";
    if (!tarball) return null;
    return { tarball, shasum: typeof data.dist?.shasum === "string" ? data.dist.shasum : null };
  } catch {
    return null;
  }
}

/**
 * Dependency versions that were never published under the declared number.
 * FHIR R4 shipped as 4.0.1 (a technical correction of 4.0.0) and no 4.0.0 core
 * package exists; the IG Publisher and validators resolve 4.0.0 to 4.0.1 too.
 */
const DEPENDENCY_VERSION_ALIASES: Record<string, Record<string, string>> = {
  "hl7.fhir.r4.core": { "4.0.0": "4.0.1" },
};

export function canonicalDependencyVersion(packageId: string, version: string): string {
  return DEPENDENCY_VERSION_ALIASES[packageId]?.[version] ?? version;
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
