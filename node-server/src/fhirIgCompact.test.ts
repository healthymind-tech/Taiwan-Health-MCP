/** Compact list rendering of the FHIR IG list tools (compact: true). Pure unit tests. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ARTIFACTS_COMPACT,
  canonicalBaseOf,
  compactArtifactGroup,
  compactByPackage,
  compactIgList,
  PROFILES_COMPACT,
} from "./fhirIgService.js";

const TW = "https://twcore.mohw.gov.tw/ig/twcore";

const sd = (id: string, base: string, title: string, extra: Record<string, unknown> = {}) => ({
  resource_type: "StructureDefinition",
  artifact_id: id,
  canonical_url: `${TW}/StructureDefinition/${id}`,
  name: id.replace(/-/g, ""),
  title,
  base_type: base,
  status: "active",
  ...extra,
});

test("canonicalBaseOf: the base most rows follow; null when none does", () => {
  assert.equal(
    canonicalBaseOf([sd("Patient-twcore", "Patient", "P"), sd("Condition-twcore", "Condition", "C"), { ...sd("x", "Patient", "X"), canonical_url: "http://other.org/StructureDefinition/x" }]),
    TW,
  );
  assert.equal(canonicalBaseOf([{ resource_type: "Patient", artifact_id: "pat-example", canonical_url: "" }]), null);
  assert.equal(canonicalBaseOf([]), null);
});

test("profiles: id → title per base type, canonical base once, only exceptions spelled out", () => {
  const rows = [
    sd("Observation-bmi-twcore", "Observation", "TW Core Observation BMI"),
    sd("Observation-bodyHeight-twcore", "Observation", "TW Core Observation Body Height", { status: "draft" }),
    sd("Patient-twcore", "Patient", ""),
    { ...sd("Patient-ext", "Patient", "Elsewhere"), canonical_url: "http://example.org/fhir/StructureDefinition/patient-ext" },
  ];
  const out = compactArtifactGroup(rows, PROFILES_COMPACT);
  assert.equal(out.canonical_base, TW);
  assert.deepEqual(out.byResourceType, {
    Observation: { "Observation-bmi-twcore": "TW Core Observation BMI", "Observation-bodyHeight-twcore": "TW Core Observation Body Height" },
    // No title → the name.
    Patient: { "Patient-twcore": "Patienttwcore", "Patient-ext": "Elsewhere" },
  });
  assert.deepEqual(out.canonicals, { "Patient-ext": "http://example.org/fhir/StructureDefinition/patient-ext" });
  assert.deepEqual(out.status, { "Observation-bodyHeight-twcore": "draft" });
  assert.match(out.compact, /canonical_base \+ '\/StructureDefinition\/' \+ id/);
});

test("profiles: no exceptions → no canonicals / status keys", () => {
  const out = compactArtifactGroup([sd("Condition-twcore", "Condition", "TW Core Condition")], PROFILES_COMPACT);
  assert.equal("canonicals" in out, false);
  assert.equal("status" in out, false);
});

test("artifacts: grouped by resource type, exceptions keyed ResourceType/id, examples have no canonical", () => {
  const rows = [
    { artifact_key: "ValueSet/vs-a", resource_type: "ValueSet", artifact_id: "vs-a", canonical_url: `${TW}/ValueSet/vs-a`, name: "VsA", title: "VS A", status: "active" },
    { artifact_key: "CodeSystem/vs-a", resource_type: "CodeSystem", artifact_id: "vs-a", canonical_url: "http://loinc.org", name: "LOINC", title: "", status: "draft" },
    { artifact_key: "Patient/pat-example", resource_type: "Patient", artifact_id: "pat-example", canonical_url: "", name: "", title: "", status: "" },
    { artifact_key: "Bundle/0", resource_type: "Bundle", artifact_id: "", canonical_url: "", name: "", title: "", status: "" },
  ];
  const out = compactArtifactGroup(rows, ARTIFACTS_COMPACT);
  assert.equal(out.canonical_base, TW);
  assert.deepEqual(out.byResourceType, {
    ValueSet: { "vs-a": "VS A" },
    CodeSystem: { "vs-a": "LOINC" },
    Patient: { "pat-example": "" },
    Bundle: { "Bundle/0": "" },
  });
  assert.deepEqual(out.canonicals, { "CodeSystem/vs-a": "http://loinc.org" });
  assert.equal("status" in out, false); // artifacts: status not reported
});

test("all_packages: one group per packageId#version, legend once", () => {
  const rows = [
    { ...sd("Patient-twcore", "Patient", "TW Core Patient"), package_id: "tw.gov.mohw.twcore", package_version: "1.0.0" },
    {
      resource_type: "StructureDefinition",
      artifact_id: "Claim-pas",
      canonical_url: "https://nhicore.nhi.gov.tw/pas/StructureDefinition/Claim-pas",
      title: "PAS Claim",
      base_type: "Claim",
      status: "active",
      package_id: "tw.gov.mohw.nhi.pas",
      package_version: "1.2.7",
    },
  ];
  const out = compactByPackage(rows, PROFILES_COMPACT);
  assert.deepEqual(Object.keys(out.packages), ["tw.gov.mohw.twcore#1.0.0", "tw.gov.mohw.nhi.pas#1.2.7"]);
  assert.equal(out.packages["tw.gov.mohw.nhi.pas#1.2.7"].canonical_base, "https://nhicore.nhi.gov.tw/pas");
  assert.equal("compact" in out.packages["tw.gov.mohw.twcore#1.0.0"], false);
  assert.match(out.compact, /^packages maps packageId#version/);
});

test("compactIgList: by install origin, default named, title blank when it is the package id", () => {
  const out = compactIgList([
    { package_id: "tw.gov.mohw.twcore", version: "1.0.0", title: "TW Core IG", is_default: true, install_origin: "manual" },
    { package_id: "fhir.dicom", version: "2022.4.20221006", title: "fhir.dicom", is_default: false, install_origin: "dependency" },
    { package_id: "x.y", version: "0.1.0", title: null, is_default: false, install_origin: null },
  ]);
  assert.equal(out.count, 3);
  assert.equal(out.default, "tw.gov.mohw.twcore#1.0.0");
  assert.deepEqual(out.manual, { "tw.gov.mohw.twcore#1.0.0": "TW Core IG" });
  assert.deepEqual(out.dependency, { "fhir.dicom#2022.4.20221006": "" });
  assert.deepEqual(out.unknown, { "x.y#0.1.0": "" });
});
