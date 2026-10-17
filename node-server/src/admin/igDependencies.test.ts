import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeMissingDependencies,
  jobTargets,
  parseDependencyRequest,
  type IgJobLite,
  type InstalledPackage,
} from "./igDependencies.js";

function job(partial: Partial<IgJobLite>): IgJobLite {
  return {
    job_id: "j",
    status: "success",
    current_step: "",
    progress_current: 0,
    progress_total: 0,
    created_at: "2026-10-01T00:00:00+00:00",
    finished_at: "2026-10-01T00:01:00+00:00",
    last_error_code: "",
    last_error_message: "",
    job_options: {},
    result_summary: {},
    ...partial,
  };
}

const PACKAGES: InstalledPackage[] = [
  // twcore declares core 4.0.0 (never published → 4.0.1) and ips; ips needs dicom.
  { package_id: "tw.gov.mohw.twcore", version: "1.0.0", dependencies: { "hl7.fhir.r4.core": "4.0.0", "hl7.fhir.uv.ips": "1.1.0" } },
  { package_id: "hl7.fhir.uv.ips", version: "1.1.0", dependencies: { "hl7.fhir.r4.core": "4.0.1", "fhir.dicom": "2022.4.20221006" } },
];

test("missing deps: aliases resolved, transitive requirers listed, direct ones first", () => {
  const out = computeMissingDependencies(PACKAGES, []);
  const core = out.find((d) => d.package_id === "hl7.fhir.r4.core")!;
  assert.equal(core.version, "4.0.1");
  assert.deepEqual(core.declared_versions, ["4.0.0", "4.0.1"]);
  assert.deepEqual(core.alias, { declared: "4.0.0", resolved: "4.0.1" });
  assert.deepEqual(
    core.required_by.map((r) => [r.package_id, r.direct]),
    [["hl7.fhir.uv.ips", true], ["tw.gov.mohw.twcore", true]],
  );
  const dicom = out.find((d) => d.package_id === "fhir.dicom")!;
  assert.equal(dicom.alias, null);
  assert.deepEqual(
    dicom.required_by.map((r) => [r.package_id, r.direct]),
    [["hl7.fhir.uv.ips", true], ["tw.gov.mohw.twcore", false]],
  );
  assert.equal(dicom.status, "missing");
  assert.equal(out.length, 2, "installed ips is not reported");
});

test("nothing missing when the closure is installed", () => {
  const all: InstalledPackage[] = [
    ...PACKAGES,
    { package_id: "hl7.fhir.r4.core", version: "4.0.1", dependencies: {} },
    { package_id: "fhir.dicom", version: "2022.4.20221006", dependencies: { "hl7.fhir.r4.core": "4.0.1" } },
  ];
  assert.deepEqual(computeMissingDependencies(all, []), []);
});

test("status: active job wins, else the newest recorded failure", () => {
  const jobs = [
    job({
      job_id: "active",
      status: "running",
      current_step: "staging_ig_packages",
      job_options: { ig_source: "dependencies", packages: [{ package_id: "fhir.dicom", version: "2022.4.20221006" }] },
    }),
    job({
      job_id: "newer-fail",
      status: "permanent_failed",
      last_error_message: "could not download hl7.fhir.r4.core@4.0.1: HTTP 404 from https://x",
      job_options: { ig_source: "dependencies", packages: [{ package_id: "hl7.fhir.r4.core", version: "4.0.1" }] },
    }),
    job({
      job_id: "older",
      status: "success",
      // Older import recorded the declared (alias) version; it must still match 4.0.1.
      result_summary: {
        missing_dependencies: [{ package_id: "hl7.fhir.r4.core", version: "4.0.0", reason: "could not download: network error from https://x" }],
      },
    }),
  ];
  const out = computeMissingDependencies(PACKAGES, jobs);
  const dicom = out.find((d) => d.package_id === "fhir.dicom")!;
  assert.equal(dicom.status, "downloading");
  assert.equal(dicom.active_job?.job_id, "active");
  const core = out.find((d) => d.package_id === "hl7.fhir.r4.core")!;
  assert.equal(core.status, "failed");
  assert.equal(core.last_failure?.job_id, "newer-fail");
  assert.equal(core.last_failure?.reason_code, "not_found");

  const onlyOld = computeMissingDependencies(PACKAGES, [jobs[2]]);
  const core2 = onlyOld.find((d) => d.package_id === "hl7.fhir.r4.core")!;
  assert.equal(core2.last_failure?.job_id, "older");
  assert.equal(core2.last_failure?.reason_code, "network");
});

test("queued job → status queued; upload jobs count via expected_package", () => {
  const jobs = [
    job({
      job_id: "up",
      status: "queued",
      job_options: { ig_source: "upload", object_key: "k", expected_package: { package_id: "fhir.dicom", version: "2022.4.20221006" } },
    }),
  ];
  const dicom = computeMissingDependencies(PACKAGES, jobs).find((d) => d.package_id === "fhir.dicom")!;
  assert.equal(dicom.status, "queued");
});

test("jobTargets: registry with explicit version canonicalized, version-less ignored", () => {
  assert.deepEqual(jobTargets({ job_options: { ig_source: "registry", package_id: "hl7.fhir.r4.core", version: "4.0.0" } }), [
    { package_id: "hl7.fhir.r4.core", version: "4.0.1" },
  ]);
  assert.deepEqual(jobTargets({ job_options: { ig_source: "registry", package_id: "x", version: "" } }), []);
  assert.deepEqual(jobTargets({ job_options: { ig_source: "upload", object_key: "k" } }), []);
});

test("parseDependencyRequest validates and canonicalizes", () => {
  assert.deepEqual(parseDependencyRequest({ package_id: "hl7.fhir.r4.core", version: "4.0.0" }), {
    package_id: "hl7.fhir.r4.core",
    version: "4.0.1",
  });
  assert.ok("error" in parseDependencyRequest({ package_id: "", version: "1" }));
  assert.ok("error" in parseDependencyRequest({ package_id: "../etc", version: "1" }));
  assert.ok("error" in parseDependencyRequest({ package_id: "a.b", version: "" }));
  assert.ok("error" in parseDependencyRequest({ package_id: "a.b", version: "^1.0" }));
  assert.ok("error" in parseDependencyRequest(null));
});
