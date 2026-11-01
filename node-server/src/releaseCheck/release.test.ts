import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOLS_VERSION } from "../toolVersions.js";
import { releaseCheck, type ReleaseDeps, type ReleaseInput } from "./release.js";

// Synthetic record / Bundles; the validation envelope is injected (no DB, no validator).
const RECORD = "就診日期：114/06/02\n診斷：高血壓\n體溫 38.5°C\n否認藥物過敏";

const entry = (n: number, resource: Record<string, unknown>) => ({ fullUrl: `urn:uuid:00000000-0000-4000-8000-00000000000${n}`, resource });
const PATIENT = { resourceType: "Patient", meta: { profile: ["https://example.org/StructureDefinition/Patient-x"] }, gender: "male" };
const ENCOUNTER = { resourceType: "Encounter", status: "finished", period: { start: "2025-06-02" } };
const CONDITION = { resourceType: "Condition", code: { coding: [{ system: "http://hl7.org/fhir/sid/icd-10-cm", code: "I10", display: "Essential (primary) hypertension" }] } };
const TEMP = {
  resourceType: "Observation",
  status: "final",
  code: { coding: [{ system: "http://loinc.org", code: "8310-5", display: "Body temperature" }] },
  valueQuantity: { value: 38.5, unit: "°C", system: "http://unitsofmeasure.org", code: "Cel" },
};
const FULL = { resourceType: "Bundle", type: "collection", entry: [entry(1, PATIENT), entry(2, ENCOUNTER), entry(3, CONDITION), entry(4, TEMP)] };
const ONLY_CONDITION = { resourceType: "Bundle", type: "collection", entry: [entry(3, CONDITION)] };

type Data = Record<string, unknown>;
const officialOk = (extra: Data = {}): Data => ({ valid: true, source: "hl7-validator_cli-7.0.1", engine: "hl7-official", official_verdict: true, issues: [], entries: [], ...extra });

function deps(data: Data | null, more: Partial<ReleaseDeps> = {}): ReleaseDeps & { calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    validate: async (args) => {
      calls.push(args as unknown as Record<string, unknown>);
      return JSON.stringify(data ? { ok: true, data, warnings: [], provenance: null } : { ok: false, error: { code: "IG_NOT_FOUND", message: "no IG" } });
    },
    ...more,
  };
}

const base = (bundle: Record<string, unknown>, extra: Partial<ReleaseInput> = {}): ReleaseInput => ({ bundle, source_text: RECORD, ...extra });

test("release: official 0 errors, no content errors, facts covered, targets present → send", async () => {
  const d = deps(officialOk());
  const r = await releaseCheck(
    base(FULL, {
      facts: [
        { item: "體溫", attribute: "數值", value: "38.5°C", quote: "體溫 38.5°C" },
        { item: "就診", attribute: "日期", value: "114/06/02", quote: "114/06/02" },
      ],
      targets: [{ resourceType: "Patient" }, { resourceType: "Encounter" }, { resourceType: "Condition" }, { resourceType: "Observation", what: "體溫", code: { system: "http://loinc.org", code: "8310-5" } }],
      site_config: "timezone: +08:00",
      bundle_profile: "https://example.org/StructureDefinition/Bundle-x",
    }),
    d,
  );
  assert.equal(r.release, true, JSON.stringify(r.reasons));
  assert.equal(r.next, "send");
  assert.deepEqual(r.reasons, []);
  assert.equal(r.validation.officially_verified, true);
  assert.equal((r.facts as Record<string, unknown>).covered, 2);
  assert.equal(d.calls[0].source_text, RECORD, "the pipeline gets source_text (grounding + record checks)");
  assert.equal(d.calls[0].bundle_profile, "https://example.org/StructureDefinition/Bundle-x");
});

test("empty Bundle: targets Patient, Encounter, Condition, Observation-temperature; only Condition → missing-target ×3", async () => {
  const r = await releaseCheck(
    base(ONLY_CONDITION, {
      targets: [
        { resourceType: "Patient", what: "病人" },
        { resourceType: "Encounter", what: "就診" },
        { resourceType: "Condition", what: "診斷" },
        { resourceType: "Observation", what: "體溫", code: { system: "http://loinc.org", code: "8310-5" } },
      ],
    }),
    deps(officialOk()),
  );
  assert.equal(r.release, false);
  assert.equal(r.next, "fix");
  const missing = r.reasons.filter((x) => x.code === "missing-target");
  assert.equal(missing.length, 3);
  assert.ok(missing.every((x) => x.count === 1 && x.check === "completeness"));
  assert.deepEqual((r.completeness.targets as Array<Record<string, unknown>>).map((t) => t.ok), [false, false, true, false]);
});

test("validator errors → validation-error reasons with pointers", async () => {
  const data = officialOk({
    valid: false,
    entries: [{ resourceType: "Condition", valid: false, issues: [{ severity: "error", message: "Condition.subject: minimum required = 1, but only found 0", pointer: "/entry/0/resource" }] }],
  });
  const r = await releaseCheck(base(ONLY_CONDITION), deps(data));
  assert.equal(r.release, false);
  const v = r.reasons.find((x) => x.code === "validation-error")!;
  assert.equal(v.pointer, "/entry/0/resource");
  assert.equal(r.validation.errors, 1);
  assert.equal(r.next, "fix");
});

test("MCP fallback / no official engine / unchecked → not-officially-verified (require_official=false accepts)", async () => {
  const fallback = await releaseCheck(base(FULL), deps(officialOk({ engine: "mcp-fallback", official_verdict: false, checked_fully: false, fallback_reason: "official validator timed out", source: "builtin" })));
  assert.ok(fallback.reasons.some((x) => x.code === "not-officially-verified" && /fallback/.test(x.message)));
  assert.equal(fallback.release, false);
  const none = await releaseCheck(base(FULL), deps({ valid: true, source: "builtin", issues: [], entries: [] }));
  assert.ok(none.reasons.some((x) => x.code === "not-officially-verified" && /no official validator/.test(x.message)));
  const unchecked = await releaseCheck(base(FULL), deps(officialOk({ checked_fully: false, unverified: [{ system: "x", code: "y" }] })));
  assert.ok(unchecked.reasons.some((x) => x.code === "not-officially-verified"));
  const optOut = await releaseCheck(base(FULL, { require_official: false, targets: [{ resourceType: "Patient" }] }), deps({ valid: true, source: "builtin", issues: [], entries: [] }));
  assert.equal(optOut.release, true);
  assert.match(String(optOut.validation.note), /require_official=false/);
});

test("validation that does not complete → validation-failed", async () => {
  const r = await releaseCheck(base(FULL), deps(null));
  assert.equal(r.release, false);
  assert.equal(r.reasons[0].code, "validation-failed");
  assert.match(r.reasons[0].message, /IG_NOT_FOUND/);
});

test("grounding and record-check errors → grounding-error / record-check-error; warnings do not block", async () => {
  const data = officialOk({
    issues: [{ severity: "warning", source: "grounding", rule: "G-X", message: "a warning" }],
    entries: [
      {
        resourceType: "Condition",
        issues: [
          { severity: "error", source: "grounding", rule: "G-UNGROUNDED", message: "not in record", pointer: "/entry/0/resource/onsetDateTime", path: "Bundle.entry[0].resource.onsetDateTime", gate: "blocking" },
          { severity: "error", source: "record-checks", code: "unconfirmed-as-confirmed", message: "unconfirmed", gate: "blocking" },
        ],
      },
    ],
  });
  const r = await releaseCheck(base(ONLY_CONDITION, { targets: [{ resourceType: "Condition" }] }), deps(data));
  assert.deepEqual(r.reasons.map((x) => x.code).sort(), ["grounding-error", "record-check-error"]);
  assert.equal(r.content.grounding_errors, 1);
  assert.equal(r.content.record_check_errors, 1);
  assert.equal(r.content.warnings, 1);
});

test("v20.1: only BLOCKING content errors stop the release; advisory errors are counted and returned", async () => {
  const data = officialOk({
    entries: [
      {
        resourceType: "Condition",
        issues: [
          { severity: "error", source: "grounding", rule: "G-CONTEXT-LABEL", message: "label", path: "Bundle.entry[0].resource.code", gate: "advisory" },
          { severity: "error", source: "record-checks", code: "stale-value", message: "stale", gate: "advisory" },
          // no stamped gate (older pipeline) → the registry decides: a heuristic rule is advisory
          { severity: "error", source: "record-checks", code: "negated-item-present", message: "negated" },
        ],
      },
    ],
  });
  const r = await releaseCheck(base(ONLY_CONDITION, { targets: [{ resourceType: "Condition" }] }), deps(data));
  assert.equal(r.release, true, JSON.stringify(r.reasons));
  assert.equal(r.content.grounding_errors, 0);
  assert.equal(r.content.record_check_errors, 0);
  assert.equal(r.content.advisory_errors, 3);
  assert.deepEqual(r.content.advisory_rules, ["G-CONTEXT-LABEL", "negated-item-present", "stale-value"]);
  // an unstamped unconfirmed-as-confirmed error is blocking by the registry
  const blocking = officialOk({ entries: [{ resourceType: "Condition", issues: [{ severity: "error", source: "record-checks", code: "unconfirmed-as-confirmed", message: "r/o" }] }] });
  const b = await releaseCheck(base(ONLY_CONDITION, { targets: [{ resourceType: "Condition" }] }), deps(blocking));
  assert.equal(b.release, false);
  assert.deepEqual(b.reasons.map((x) => x.code), ["record-check-error"]);
});

test("v20.1: neither targets nor facts → incomplete-input, never released", async () => {
  const r = await releaseCheck(base(FULL), deps(officialOk()));
  assert.equal(r.release, false);
  assert.equal(r.next, "fix");
  assert.deepEqual(r.reasons.map((x) => x.code), ["incomplete-input"]);
  assert.equal(r.reasons[0].check, "completeness");
  assert.equal(r.completeness.incomplete_input, true);
  // empty targets / facts arrays count as not given
  const e = await releaseCheck(base(FULL, { targets: [], facts: [] }), deps(officialOk()));
  assert.deepEqual(e.reasons.map((x) => x.code), ["incomplete-input"]);
  // targets alone are enough to judge completeness
  const t = await releaseCheck(base(FULL, { targets: [{ resourceType: "Patient" }] }), deps(officialOk()));
  assert.equal(t.release, true, JSON.stringify(t.reasons));
});

test("facts: missing, quote-not-in-record, unusable fact written", async () => {
  const bundle = { ...FULL, entry: [...FULL.entry, entry(5, { resourceType: "AllergyIntolerance", code: { coding: [{ system: "http://snomed.info/sct", code: "416098002", display: "Drug allergy" }] } })] };
  const r = await releaseCheck(
    base(bundle, {
      facts: [
        { item: "病人", attribute: "性別", value: "女", quote: "診斷" },
        { item: "診斷", attribute: "名稱", value: "糖尿病", quote: "糖尿病" },
        { item: "過敏", attribute: "過敏原", value: "drug allergy", quote: "藥物過敏" },
      ],
    }),
    deps(officialOk()),
  );
  const codes = r.reasons.map((x) => x.code);
  assert.ok(codes.includes("fact-missing"), codes.join());
  assert.ok(codes.includes("quote-not-in-record"));
  assert.ok(codes.includes("unusable-fact-written"));
  assert.equal(r.next, "fix");
});

test("a missing target whose facts are all unusable → insufficient_information", async () => {
  const r = await releaseCheck(
    base(ONLY_CONDITION, {
      facts: [{ item: "過敏", attribute: "過敏原", value: "藥物過敏", quote: "藥物過敏" }],
      targets: [{ resourceType: "Condition" }, { resourceType: "AllergyIntolerance", what: "過敏" }],
    }),
    deps(officialOk()),
  );
  assert.equal(r.release, false);
  assert.equal(r.next, "insufficient_information");
  assert.ok(r.reasons.some((x) => x.code === "insufficient-information"));
  assert.ok(!r.reasons.some((x) => x.code === "missing-target"));
});

test("without targets: required entry slices of the Bundle profile and the suspected empty Bundle", async () => {
  const bundle = { ...ONLY_CONDITION, meta: { profile: ["https://example.org/StructureDefinition/Bundle-x"] } };
  const r = await releaseCheck(
    base(bundle, {
      facts: [
        { item: "診斷", attribute: "名稱", value: "I10", quote: "高血壓" },
        { item: "體溫", attribute: "數值", value: "38.5°C", quote: "體溫 38.5°C" },
        { item: "就診", attribute: "日期", value: "114/06/02", quote: "114/06/02" },
      ],
    }),
    deps(officialOk(), {
      entrySlices: async (p) => {
        assert.equal(p, "https://example.org/StructureDefinition/Bundle-x");
        return [
          { name: "patient", min: 1, types: ["Patient"], profiles: ["https://example.org/StructureDefinition/Patient-x"] },
          { name: "condition", min: 0, types: ["Condition"], profiles: [] },
        ];
      },
    }),
  );
  const codes = r.reasons.map((x) => x.code);
  assert.ok(codes.includes("missing-entry-slice"));
  assert.ok(codes.includes("suspected-empty-bundle"));
  assert.equal(r.completeness.suspected_empty, true);
  assert.deepEqual(r.completeness.fact_resource_types, ["Condition", "Observation", "Encounter"]);
});

test("no source_text → no-source-text", async () => {
  const r = await releaseCheck({ bundle: FULL, source_text: "" }, deps(officialOk()));
  assert.ok(r.reasons.some((x) => x.code === "no-source-text"));
  assert.equal(r.release, false);
});

test("tool layer: envelope, provenance, INVALID_ARGUMENT, entrySlicesOf", async () => {
  const { runReleaseCheckTool, runFactCoverageTool, entrySlicesOf } = await import("./tools.js");
  const d = {
    terminology: () => null,
    fields: async () => null,
    entrySlices: async () => null,
    validate: async () => JSON.stringify({ ok: true, data: officialOk(), warnings: [], provenance: null }),
  };
  const env = (await runReleaseCheckTool({ bundle: FULL, source_text: RECORD, targets: [{ resourceType: "Patient" }] }, d)) as Record<string, any>;
  assert.equal(env.ok, true);
  assert.equal(env.data.release, true);
  assert.equal(env.provenance.tool, "fhir_release_check");
  assert.equal(env.provenance.toolVersion, TOOLS_VERSION.fhir_release_check);
  const bad = (await runFactCoverageTool({ bundle: { resourceType: "Patient" }, source_text: RECORD, facts: [] }, d)) as Record<string, any>;
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, "INVALID_ARGUMENT");
  const cov = (await runFactCoverageTool({ bundle: FULL, source_text: RECORD, facts: [{ item: "體溫", attribute: "數值", value: "38.5°C", quote: "體溫 38.5°C" }] }, d)) as Record<string, any>;
  assert.equal(cov.data.summary.covered, 1);
  assert.equal(cov.provenance.tool, "fhir_check_fact_coverage");
  const sd = {
    type: "Bundle",
    snapshot: {
      element: [
        { id: "Bundle.entry", min: 1, max: "*" },
        { id: "Bundle.entry:composition", min: 1, max: "1" },
        { id: "Bundle.entry:composition.resource", type: [{ code: "Composition", profile: ["https://example.org/StructureDefinition/Composition-x"] }] },
        { id: "Bundle.entry:observation", min: 0, max: "*" },
        { id: "Bundle.entry:observation.resource", type: [{ code: "Observation" }] },
      ],
    },
  };
  assert.deepEqual(entrySlicesOf(sd), [{ name: "composition", min: 1, types: ["Composition"], profiles: ["https://example.org/StructureDefinition/Composition-x"] }]);
});

test("evaluator decision: a missing target that no fact names is a model omission → missing-target, next fix", async () => {
  const r = await releaseCheck(
    base(ONLY_CONDITION, {
      facts: [{ item: "診斷", attribute: "名稱", value: "糖尿病", quote: "糖尿病" }],
      targets: [{ resourceType: "Condition" }, { resourceType: "Encounter", what: "就診" }],
    }),
    deps(officialOk()),
  );
  assert.equal(r.release, false);
  assert.equal(r.next, "fix");
  assert.ok(r.reasons.some((x) => x.code === "missing-target" && /Encounter/u.test(x.message)));
  assert.ok(!r.reasons.some((x) => x.code === "insufficient-information"));
});
