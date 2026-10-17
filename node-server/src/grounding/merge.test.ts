/**
 * T6: merge of grounding into fhir_validate_bundle results (spec §2.4), against the two combined fixtures whose
 * conformance part is a live MCP response (2026-10-16). The combined fixtures are private CARVE-TW data
 * (src/grounding/__fixtures__/private/, git-ignored): those tests skip when absent; the synthetic merge tests below
 * and groundingTools.test.ts run without them.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { checkGrounding } from "./checkGrounding.js";
import { groundingProvenanceFields, mergeGroundingIntoValidation, resolveValidateGrounding, type ConformanceData } from "./merge.js";
import { firstDiff, loadPrivateFixture, privateSkip, referenceTerminology } from "./testkit.js";

const skip = privateSkip("validate_bundle_combined.json", "terminology_cache.json");
const FX = loadPrivateFixture<Record<string, any>>("validate_bundle_combined.json", {});
const terminology = referenceTerminology();

// Two combined fixtures, addressed by position ("combined#1", "combined#2"); their keys stay private.
for (const idx of [0, 1]) {
  const label = `combined#${idx + 1}`;
  test(`T6 combined validate ${label}: valid = conformanceValid ∧ groundingValid, entries merged by index`, { skip }, async () => {
    const fx = FX[Object.keys(FX)[idx]];
    const mode = resolveValidateGrounding(fx.input.grounding, fx.input.source_text, fx.input.evidence_map);
    assert.equal(mode, "auto");
    const g = await checkGrounding(
      { bundle: fx.input.bundle, source_text: fx.input.source_text, site_config: fx.input.site_config, mode, verbosity: "warnings" },
      { terminology },
    );
    const conf = fx.conformance.data as ConformanceData;
    const before = JSON.stringify(conf);
    const merged = mergeGroundingIntoValidation(conf, g);
    assert.equal(JSON.stringify(conf), before, "input mutated");
    for (const [k, v] of Object.entries(fx.assert)) assert.equal((merged as any)[k], v, k);
    const { groundingMode, ...rest } = merged;
    assert.equal(groundingMode, "auto");
    assert.equal(firstDiff(rest, fx.expected.data), null);
  });
}

test("grounding parameter resolution (off / no source_text keeps conformance-only output)", () => {
  assert.equal(resolveValidateGrounding(undefined, null, null), null);
  assert.equal(resolveValidateGrounding("auto", undefined, null), null);
  assert.equal(resolveValidateGrounding("off", "text", null), null);
  assert.equal(resolveValidateGrounding(undefined, "text", null), "auto");
  assert.equal(resolveValidateGrounding(undefined, "text", [{ path: "x", quote: "y" }]), "strict");
  assert.equal(resolveValidateGrounding(undefined, "text", []), "auto");
  assert.equal(resolveValidateGrounding("auto", "text", [{ path: "x" }]), "auto");
  assert.match(groundingProvenanceFields().lexiconSha256, /^[0-9a-f]{64}$/);
});

test("Bundle-level grounding issues are appended to data.issues; unmatched grounding entries are appended", () => {
  const conf: ConformanceData = { valid: true, issues: [], entries: [{ fullUrl: "urn:a", valid: true, issues: [] }] };
  const g = {
    valid: false,
    source: "grounding" as const,
    mode: "strict" as const,
    profile: "",
    issues: [{ severity: "warning" as const, code: "not-found", path: "x", message: "[grounding:G-EVIDENCE-PATH] m", rule: "G-EVIDENCE-PATH", source: "grounding" as const }],
    entries: [
      { fullUrl: "urn:a", resourceType: "Patient", valid: true, profile: "", issues: [] },
      { fullUrl: "urn:b", resourceType: "Condition", valid: false, profile: "", issues: [] },
    ],
    referenceIssues: [],
    grounding: {} as any,
    elapsed_ms: 1,
  };
  const m = mergeGroundingIntoValidation(conf, g);
  assert.equal(m.valid, false);
  assert.equal(m.conformanceValid, true);
  assert.equal(m.groundingValid, false);
  assert.equal(m.issues.length, 1);
  assert.equal(m.entries.length, 2);
  assert.equal(m.entries[1].valid, false);
});
