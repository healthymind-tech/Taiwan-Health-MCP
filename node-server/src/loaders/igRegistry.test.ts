/**
 * Registry download fallbacks: packages2.fhir.org serves versions the primary
 * registry lacks, but only via its own per-version metadata (dist.tarball).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { gzipSync } from "node:zlib";
import { canonicalDependencyVersion, classifyRegistryFailure, downloadTarball, fetchPackage, RegistryError } from "./igRegistry.js";

test("missing version on the primary registry is fetched via packages2 per-version metadata", async () => {
  const tgz = gzipSync(Buffer.from("package"));
  const sha = crypto.createHash("sha1").update(tgz).digest("hex");
  const seen: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    seen.push(String(url));
    if (url === "https://p2.test/packages/us.nlm.vsac/0.19.0") {
      return new Response(JSON.stringify({ dist: { tarball: "https://p2.test/web/us.nlm.vsac-0.19.0.tgz", shasum: sha } }), { status: 200 });
    }
    if (url === "https://p2.test/web/us.nlm.vsac-0.19.0.tgz") return new Response(tgz, { status: 200 });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  try {
    const data = await downloadTarball("https://p1.test", "us.nlm.vsac", "0.19.0", { meta: {}, fallback: "https://p2.test" });
    assert.deepEqual(data, tgz);
    assert.deepEqual(seen, [
      "https://p1.test/us.nlm.vsac/0.19.0",
      "https://p2.test/us.nlm.vsac/0.19.0",
      "https://p2.test/packages/us.nlm.vsac/0.19.0",
      "https://p2.test/web/us.nlm.vsac-0.19.0.tgz",
    ]);
  } finally {
    globalThis.fetch = original;
  }
});

test("packages2 tarball with a wrong shasum is rejected", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    if (String(url).endsWith("/packages/x/1.0.0")) {
      return new Response(JSON.stringify({ dist: { tarball: "https://p2.test/web/x.tgz", shasum: "deadbeef" } }), { status: 200 });
    }
    if (String(url).endsWith("/web/x.tgz")) return new Response(gzipSync(Buffer.from("x")), { status: 200 });
    return new Response("", { status: 404 });
  }) as typeof fetch;
  try {
    await assert.rejects(downloadTarball("https://p1.test", "x", "1.0.0", { meta: {}, fallback: "https://p2.test" }), /shasum mismatch/);
  } finally {
    globalThis.fetch = original;
  }
});

test("never-published core 4.0.0 resolves to 4.0.1; others unchanged", () => {
  assert.equal(canonicalDependencyVersion("hl7.fhir.r4.core", "4.0.0"), "4.0.1");
  assert.equal(canonicalDependencyVersion("hl7.fhir.r4.core", "4.0.1"), "4.0.1");
  assert.equal(canonicalDependencyVersion("us.nlm.vsac", "0.19.0"), "0.19.0");
});

test("fetchPackage: primary metadata 404 still tries the tarball endpoints and packages2", async () => {
  const tgz = gzipSync(Buffer.from("pkg"));
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    if (url === "https://p2.test/only.on.p2/1.2.3") return new Response(tgz, { status: 200 });
    return new Response("", { status: 404 });
  }) as typeof fetch;
  try {
    const out = await fetchPackage("https://p1.test", "only.on.p2", "1.2.3", { fallback: "https://p2.test" });
    assert.equal(out.version, "1.2.3");
    assert.deepEqual(out.data, tgz);
  } finally {
    globalThis.fetch = original;
  }
});

test("fetchPackage: without metadata a version-less request fails with the metadata error", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response("", { status: 404 })) as typeof fetch;
  try {
    await assert.rejects(fetchPackage("https://p1.test", "nope", null, { fallback: null }), (e: unknown) => {
      assert.ok(e instanceof RegistryError);
      assert.match((e as Error).message, /HTTP 404/);
      return true;
    });
  } finally {
    globalThis.fetch = original;
  }
});

test("download failure lists every attempt and is classified", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    if (String(url).startsWith("https://p1.test")) throw new TypeError("fetch failed");
    return new Response("", { status: 404 });
  }) as typeof fetch;
  try {
    await assert.rejects(downloadTarball("https://p1.test", "x", "1.0.0", { meta: {}, fallback: "https://p2.test" }), (e: unknown) => {
      const msg = (e as Error).message;
      assert.match(msg, /network error from https:\/\/p1\.test\/x\/1\.0\.0/);
      assert.match(msg, /HTTP 404 from https:\/\/p2\.test\/x\/1\.0\.0/);
      // A reachable 404 does not hide that the primary was unreachable.
      assert.equal(classifyRegistryFailure(msg), "network");
      return true;
    });
  } finally {
    globalThis.fetch = original;
  }
});

test("classifyRegistryFailure maps old and new messages to stable codes", () => {
  assert.equal(classifyRegistryFailure("could not download a@1: empty/non-200 from https://packages2.fhir.org/a/1"), "not_found");
  assert.equal(classifyRegistryFailure("could not download a@1: HTTP 404 from https://x/a/1; HTTP 404 from https://y/a/1"), "not_found");
  assert.equal(classifyRegistryFailure("registry metadata for 'a' returned HTTP 404"), "not_found");
  assert.equal(classifyRegistryFailure("registry unreachable for 'a': AbortError: aborted"), "network");
  assert.equal(classifyRegistryFailure("could not download a@1: HTTP 503 from https://x"), "network");
  assert.equal(classifyRegistryFailure("could not download a@1: shasum mismatch from https://x"), "checksum");
  assert.equal(classifyRegistryFailure("could not download a@1: non-gzip payload from https://x"), "invalid_package");
  assert.equal(classifyRegistryFailure("Maximum call stack size exceeded"), "unknown");
  assert.equal(classifyRegistryFailure(""), "unknown");
});

test("searchWithFallback: primary registry down → packages2 catalog, de-duplicated per package", async () => {
  const { searchWithFallback } = await import("./igRegistry.js");
  const calls: string[] = [];
  const fake = async (url: string): Promise<Response> => {
    calls.push(url);
    if (url.includes("packages.fhir.org/catalog")) throw new Error("fetch failed");
    return new Response(
      JSON.stringify([
        { name: "tw.gov.mohw.twcore", version: "1.0.0", fhirVersion: "4.0.1", description: "TW Core" },
        { name: "tw.gov.mohw.twcore", version: "0.3.2", fhirVersion: "4.0.1", description: "TW Core" },
      ]),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const out = await searchWithFallback("https://packages.fhir.org", "twcore", fake);
  assert.equal(out.fallback_used, true);
  assert.deepEqual(out.results.map((r) => r.name), ["tw.gov.mohw.twcore"]);
  assert.match(calls[1], /packages2\.fhir\.org\/packages\/catalog\?name=twcore/);
});

test("searchWithFallback: every registry failing throws instead of returning an empty list", async () => {
  const { searchWithFallback } = await import("./igRegistry.js");
  const fake = async (): Promise<Response> => new Response("nope", { status: 503 });
  await assert.rejects(() => searchWithFallback("https://packages.fhir.org", "x", fake), /Registry search failed: HTTP 503/);
});
