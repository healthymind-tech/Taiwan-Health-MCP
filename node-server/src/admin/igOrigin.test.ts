import { test } from "node:test";
import assert from "node:assert/strict";
import {
  directDependents,
  originForImportedPackage,
  parseInstallOrigin,
  parseInstalledFor,
  ORIGIN_UPSERT_SQL,
} from "./igOrigin.js";

const ROOT = { package_id: "tw.gov.mohw.twcore", version: "1.0.0" };

test("origin: registry/upload root is manual, the rest are dependencies of the root", () => {
  for (const igSource of ["registry", "upload", "cli"]) {
    assert.deepEqual(originForImportedPackage({ igSource, index: 0, jobOptions: {}, root: ROOT }), {
      origin: "manual",
      installed_for: null,
    });
    assert.deepEqual(originForImportedPackage({ igSource, index: 3, jobOptions: {}, root: ROOT }), {
      origin: "dependency",
      installed_for: ROOT,
    });
  }
});

test("origin: dependency-only jobs mark every package as a dependency of requested_for", () => {
  const requested_for = { package_id: "hl7.fhir.us.davinci-crd", version: "2.2.1" };
  for (const index of [0, 1]) {
    assert.deepEqual(
      originForImportedPackage({ igSource: "dependencies", index, jobOptions: { requested_for }, root: null }),
      { origin: "dependency", installed_for: requested_for },
    );
  }
  // download-all: no single IG to credit
  assert.deepEqual(originForImportedPackage({ igSource: "dependencies", index: 0, jobOptions: {}, root: null }), {
    origin: "dependency",
    installed_for: null,
  });
});

test("origin: an upload that supplies a missing dependency is a dependency, not manual", () => {
  const jobOptions = {
    ig_source: "upload",
    expected_package: { package_id: "hl7.fhir.us.udap-security", version: "0.1.0" },
    requested_for: { package_id: "hl7.fhir.us.davinci-hrex", version: "1.2.0" },
  };
  const root = { package_id: "hl7.fhir.us.udap-security", version: "0.1.0" };
  assert.deepEqual(originForImportedPackage({ igSource: "upload", index: 0, jobOptions, root }), {
    origin: "dependency",
    installed_for: jobOptions.requested_for,
  });
  // its own dependencies are credited to the uploaded package
  assert.deepEqual(originForImportedPackage({ igSource: "upload", index: 1, jobOptions, root }), {
    origin: "dependency",
    installed_for: root,
  });
  // malformed requested_for is ignored, not stored
  assert.deepEqual(
    originForImportedPackage({ igSource: "upload", index: 0, jobOptions: { ...jobOptions, requested_for: { package_id: "x" } }, root }),
    { origin: "dependency", installed_for: null },
  );
});

test("origin upsert keeps manual sticky", () => {
  assert.match(ORIGIN_UPSERT_SQL, /fhir\.ig_packages\.install_origin = 'manual' OR EXCLUDED\.install_origin = 'manual' THEN 'manual'/);
  assert.match(ORIGIN_UPSERT_SQL, /COALESCE\(fhir\.ig_packages\.installed_for, EXCLUDED\.installed_for\)/);
});

test("parse stored origin values", () => {
  assert.equal(parseInstallOrigin("manual"), "manual");
  assert.equal(parseInstallOrigin("dependency"), "dependency");
  assert.equal(parseInstallOrigin(null), null);
  assert.equal(parseInstallOrigin("other"), null);
  assert.deepEqual(parseInstalledFor({ package_id: "a", version: "1" }), { package_id: "a", version: "1" });
  assert.deepEqual(parseInstalledFor('{"package_id":"a","version":"1"}'), { package_id: "a", version: "1" });
  assert.equal(parseInstalledFor("not json"), null);
  assert.equal(parseInstalledFor({ package_id: "a" }), null);
  assert.equal(parseInstalledFor(null), null);
});

test("direct dependents resolve version aliases and skip self references", () => {
  const map = directDependents([
    { package_id: "tw.gov.mohw.twcore", version: "1.0.0", dependencies: { "hl7.fhir.r4.core": "4.0.0", "hl7.fhir.uv.ips": "1.1.0" } },
    { package_id: "hl7.fhir.uv.ips", version: "1.1.0", dependencies: { "hl7.fhir.r4.core": "4.0.1" } },
    { package_id: "weird", version: "1", dependencies: { weird: "1" } },
  ]);
  assert.deepEqual(map.get("hl7.fhir.r4.core@4.0.1"), [
    { package_id: "tw.gov.mohw.twcore", version: "1.0.0" },
    { package_id: "hl7.fhir.uv.ips", version: "1.1.0" },
  ]);
  assert.deepEqual(map.get("hl7.fhir.uv.ips@1.1.0"), [{ package_id: "tw.gov.mohw.twcore", version: "1.0.0" }]);
  assert.equal(map.get("hl7.fhir.r4.core@4.0.0"), undefined);
  assert.equal(map.get("weird@1"), undefined);
});
