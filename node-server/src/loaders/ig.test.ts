/**
 * Regression: an IG package whose CodeSystems carry hundreds of thousands of
 * concepts (e.g. tw.gov.mohw.twcore 0.3.2) used to crash the import with
 * "Maximum call stack size exceeded" — `concepts.push(...pp.concepts)` spread
 * every concept into one call. Builds a real .tgz and runs the loader on it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { buildIgPackagePayload, fetchIgDependencies, fetchPackageClosure } from "./ig.js";
import type pg from "pg";
import { minOf, pushAll } from "../arrayUtils.js";

/** Minimal ustar writer: the loader's untar reads name, size and type only. */
function tar(files: Record<string, string>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, body] of Object.entries(files)) {
    const data = Buffer.from(body, "utf8");
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, "utf8");
    header.write("0000644\0", 100);
    header.write(data.length.toString(8).padStart(11, "0") + "\0", 124);
    header.write("0", 156);
    header.write("ustar\0" + "00", 257);
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

function writePackage(dir: string, conceptCount: number): string {
  const concept = Array.from({ length: conceptCount }, (_, i) => ({ code: `C${i}`, display: `Concept ${i}` }));
  const file = path.join(dir, "big-ig.tgz");
  fs.writeFileSync(
    file,
    gzipSync(
      tar({
        "package/package.json": JSON.stringify({ name: "test.big.ig", version: "1.0.0", fhirVersions: ["4.0.1"] }),
        "package/CodeSystem-big.json": JSON.stringify({ resourceType: "CodeSystem", id: "big", url: "http://x/big", concept }),
      }),
    ),
  );
  return file;
}

test("IG package with 300k concepts builds without overflowing the call stack", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ig-test-"));
  try {
    const pkg = writePackage(dir, 300_000);
    const payload = buildIgPackagePayload(pkg);
    assert.equal(payload.identity.package_id, "test.big.ig");
    assert.equal(payload.concepts.length, 300_000);
    assert.deepEqual(payload.concepts[0].slice(2, 4), ["big", "C0"]);
    // raw_json is the file's own text (jsonb normalizes it), not a re-serialization.
    const cs = payload.artifacts.find((a) => a[2] === "CodeSystem/big")!;
    assert.equal(JSON.parse(String(cs[cs.length - 1])).concept.length, 300_000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("pushAll / minOf handle arrays far beyond the argument-spread limit", () => {
  const big = Array.from({ length: 500_000 }, (_, i) => i + 1);
  assert.throws(() => [].push(...(big as never[])), RangeError);
  assert.equal(pushAll([0], big).length, 500_001);
  assert.equal(minOf(big), 1);
  assert.equal(minOf([]), Infinity);
});

test("dependencies of an already-installed package are still walked (a failed transitive dep gets retried)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ig-dep-test-"));
  const pkg = (name: string, version: string, deps: Record<string, string>) =>
    gzipSync(tar({ "package/package.json": JSON.stringify({ name, version, fhirVersions: ["4.0.1"], dependencies: deps }) }));
  const root = path.join(dir, "root.tgz");
  fs.writeFileSync(root, pkg("root.ig", "1.0.0", { "installed.ig": "1.0.0", "hl7.fhir.r4.core": "4.0.0" }));
  // installed.ig is in the DB and declares missing.ig, which is not.
  const pool = {
    query: async () => ({
      rows: [
        { package_id: "installed.ig", version: "1.0.0", dependencies: { "missing.ig": "2.0.0" } },
        { package_id: "hl7.fhir.r4.core", version: "4.0.1", dependencies: {} },
      ],
    }),
  } as unknown as pg.Pool;
  const requested: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    requested.push(String(url));
    if (url === "https://reg.test/missing.ig") return new Response(JSON.stringify({ versions: { "2.0.0": {} } }), { status: 200 });
    if (url === "https://reg.test/missing.ig/2.0.0") return new Response(pkg("missing.ig", "2.0.0", {}), { status: 200 });
    return new Response("", { status: 404 });
  }) as typeof fetch;
  try {
    const { depPaths, missing } = await fetchIgDependencies(pool, root, dir, "https://reg.test", null);
    assert.equal(depPaths.length, 1, "missing.ig fetched through the installed parent");
    assert.deepEqual(missing, []);
    assert.ok(!requested.some((u) => u.includes("hl7.fhir.r4.core")), "core 4.0.0 resolves to the installed 4.0.1");
    assert.ok(!requested.some((u) => u.includes("installed.ig")), "installed packages are not re-downloaded");
  } finally {
    globalThis.fetch = original;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("dependency-only fetch: requested packages + their missing deps, failures classified", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ig-dep-only-"));
  const pkg = (name: string, version: string, deps: Record<string, string>) =>
    gzipSync(tar({ "package/package.json": JSON.stringify({ name, version, fhirVersions: ["4.0.1"], dependencies: deps }) }));
  const pool = {
    query: async () => ({ rows: [{ package_id: "hl7.fhir.r4.core", version: "4.0.1", dependencies: {} }] }),
  } as unknown as pg.Pool;
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    // a.ig has no primary metadata at all (only tarball endpoint) and needs b.ig + core.
    if (url === "https://reg.test/a.ig/1.0.0") return new Response(pkg("a.ig", "1.0.0", { "b.ig": "2.0.0", "hl7.fhir.r4.core": "4.0.0" }), { status: 200 });
    if (url === "https://reg.test/b.ig/2.0.0") return new Response(pkg("b.ig", "2.0.0", {}), { status: 200 });
    return new Response("", { status: 404 });
  }) as typeof fetch;
  try {
    const out = await fetchPackageClosure(pool, [["a.ig", "1.0.0"], ["gone.ig", "9.9.9"]], dir, "https://reg.test", null);
    assert.deepEqual(out.fetched, [
      { package_id: "a.ig", version: "1.0.0" },
      { package_id: "b.ig", version: "2.0.0" },
    ]);
    assert.equal(out.depPaths.length, 2);
    assert.equal(out.missing.length, 1);
    assert.equal(out.missing[0].package_id, "gone.ig");
    assert.equal(out.missing[0].reason_code, "not_found");
  } finally {
    globalThis.fetch = original;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
