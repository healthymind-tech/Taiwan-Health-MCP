/**
 * SSRF-hardened server-side fetch of an admin-supplied URL — used by the
 * "import guideline PDF by URL" flow, the one place in the admin console where
 * a fully free-text URL (not an admin-configured service endpoint, not a
 * hardcoded government source) is fetched server-side. Kept in its own file,
 * separate from `adminSchedule.ts`'s older `downloadUrl` (https-only + timeout
 * only, no IP filtering), so this stricter check is easy to find and reuse.
 *
 * Guards, in order: HTTPS-only scheme, hostname resolves only to public IPs
 * (rejects loopback/private/link-local/reserved ranges — blocks the common
 * "paste http://169.254.169.254/..." or internal-service SSRF attempts),
 * redirects are refused outright (a redirect could point at an internal
 * target even once the original URL passed the IP check), and the response
 * body is capped while streaming rather than buffered-then-checked.
 *
 * This is a best-effort check, not resolution-pinned: there is a narrow
 * DNS-rebinding TOCTOU gap between our `dns.lookup` and `fetch`'s own
 * resolution. Acceptable here because this is an authenticated-admin-only
 * internal tool, not a public multi-tenant surface.
 */

import dns from "node:dns/promises";
import net from "node:net";

export class UrlFetchError extends Error {}

const PRIVATE_V4_RANGES: [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

function ipToInt(ip: string): number {
  return ip.split(".").reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

function isPrivateV4(ip: string): boolean {
  const target = ipToInt(ip);
  return PRIVATE_V4_RANGES.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (target & mask) === (ipToInt(base) & mask);
  });
}

export function isPrivateOrReservedIp(ip: string): boolean {
  const type = net.isIP(ip);
  if (type === 4) return isPrivateV4(ip);
  if (type === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    if (lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd")) return true;
    const v4Mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (v4Mapped) return isPrivateV4(v4Mapped[1]);
    return false;
  }
  return true; // not a recognizable literal IP -> treat as unsafe
}

export interface SafeFetchResult {
  data: Buffer;
  contentType: string;
  filename: string;
}

export async function fetchUrlSafely(
  url: string,
  opts: { maxBytes: number; timeoutMs?: number },
): Promise<SafeFetchResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UrlFetchError("Not a valid URL");
  }
  if (parsed.protocol !== "https:") {
    throw new UrlFetchError("URL must use HTTPS");
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  const ipType = net.isIP(hostname);
  const addresses = ipType
    ? [hostname]
    : (await dns.lookup(hostname, { all: true }).catch(() => [])).map((entry) => entry.address);
  if (addresses.length === 0 || addresses.some((ip) => isPrivateOrReservedIp(ip))) {
    throw new UrlFetchError(
      "URL could not be resolved, or resolves to a private/loopback/reserved address and cannot be fetched",
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 60_000);
  let response: Response;
  try {
    response = await fetch(url, { redirect: "manual", signal: controller.signal });
  } catch (err) {
    throw new UrlFetchError(`Failed to fetch URL: ${err instanceof Error ? err.message : err}`);
  } finally {
    clearTimeout(timer);
  }

  if (response.status >= 300 && response.status < 400) {
    throw new UrlFetchError("The URL responded with a redirect — paste the final, direct URL instead");
  }
  if (!response.ok) {
    throw new UrlFetchError(`HTTP ${response.status} fetching URL`);
  }

  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (declaredLength > opts.maxBytes) {
    throw new UrlFetchError(`File is too large (max ${Math.floor(opts.maxBytes / (1024 * 1024))} MB)`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new UrlFetchError("Empty response body");
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > opts.maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new UrlFetchError(`File is too large (max ${Math.floor(opts.maxBytes / (1024 * 1024))} MB)`);
    }
    chunks.push(value);
  }
  const data = Buffer.concat(chunks);
  if (data.length === 0) throw new UrlFetchError("Downloaded file is empty");

  let filename: string | null = null;
  const cd = response.headers.get("content-disposition") ?? "";
  if (cd.includes("filename=")) {
    for (const rawPart of cd.split(";")) {
      const part = rawPart.trim();
      if (part.toLowerCase().startsWith("filename=")) {
        filename = part.slice(9).trim().replace(/^["']|["']$/g, "");
        break;
      }
    }
  }
  if (!filename) {
    filename = parsed.pathname.replace(/\/+$/, "").split("/").pop() || "download";
  }

  return {
    data,
    contentType: response.headers.get("content-type") ?? "application/octet-stream",
    filename,
  };
}
