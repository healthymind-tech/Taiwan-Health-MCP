/**
 * Tool-layer tests for fhir_check_grounding / fhir_check_completeness / the grounding extension of
 * fhir_validate_bundle and fhir_validate_resource (groundingTools.ts), plus the privacy guarantees
 * (MCP_GROUNDING_SPEC §6.7: no record text in logs, metrics or provenance). Pure: static terminology,
 * no Postgres.
 *
 * Inputs are the hand-written playground records (admin/mcpToolExampleFixtures.ts), except the two §2.4 merge tests
 * (T6), whose combined fixtures are private CARVE-TW data (src/grounding/__fixtures__/private/) and skip when absent.
 */
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express from "express";

import {
  TOOL_DESCRIPTIONS,
  addBundleGrounding,
  addResourceGrounding,
  groundingLogger,
  runCheckCompletenessTool,
  runCheckGroundingTool,
  type GroundingToolDeps,
} from "./groundingTools.js";
import {
  COMPLETENESS_INSUFFICIENT_INPUT,
  GROUNDING_FABRICATED_INPUT,
  GROUNDING_VALID_INPUT,
} from "./admin/mcpToolExampleFixtures.js";
import { loadPrivateFixture, privateSkip, referenceTerminology, syntheticTerminology } from "./grounding/testkit.js";
import { sourceSha256Prefix } from "./grounding/index.js";
import { finalErrorHandler } from "./httpErrors.js";
import { configureLogLevel } from "./logger.js";
import { TOOLS_VERSION } from "./toolVersions.js";

const skipT6 = privateSkip("validate_bundle_combined.json", "terminology_cache.json");
const FX = loadPrivateFixture<Record<string, any>>("validate_bundle_combined.json", {});
const PKG = { packageId: "tw.gov.mohw.twcore", version: "1.0.0", fhirVersion: "4.0.1", source: "ig" };
const deps: GroundingToolDeps = { terminology: syntheticTerminology(), packageProvenance: async () => PKG, logger: groundingLogger };
const refDeps: GroundingToolDeps = { ...deps, terminology: referenceTerminology() };

/** Fictional playground records (strict valid / auto with one invented diagnosis). */
const VALID = GROUNDING_VALID_INPUT as any;
const FAB = GROUNDING_FABRICATED_INPUT as any;
/** A conformance-only fhir_validate_bundle response for a Bundle (every entry valid). */
const conformanceOf = (bundle: any): any => ({
  ok: true,
  data: { valid: true, profile: "Bundle-twcore", source: "builtin", issues: [], entries: bundle.entry.map((e: any) => ({ fullUrl: e.fullUrl, valid: true, issues: [] })) },
  warnings: [],
  provenance: PKG,
});

/** Capture everything written to stderr / console while `fn` runs. */
async function captureOutput(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  const origErr = console.error;
  const origLog = console.log;
  const origWarn = console.warn;
  (process.stderr as any).write = (c: unknown, ...rest: unknown[]) => {
    chunks.push(String(c));
    const cb = rest.find((r) => typeof r === "function") as (() => void) | undefined;
    cb?.();
    return true;
  };
  console.error = console.log = console.warn = (...a: unknown[]) => void chunks.push(a.map(String).join(" "));
  try {
    await fn();
  } finally {
    (process.stderr as any).write = origWrite;
    console.error = origErr;
    console.log = origLog;
    console.warn = origWarn;
  }
  return chunks.join("");
}

// ------------------------------------------------------------------------------------------- byte identity

test("validate_* without source_text / grounding=off returns the conformance text itself", async () => {
  const bundle = FAB.bundle;
  const conf = JSON.stringify(conformanceOf(bundle));
  for (const args of [{}, { source_text: null }, { grounding: "off" as const, source_text: "x" }, { grounding: "auto" as const }, { evidence_map: [{ path: "a", quote: "b" }] }]) {
    assert.equal(await addBundleGrounding(conf, bundle, args, deps), conf);
    assert.equal(await addResourceGrounding(conf, bundle.entry[0].resource, args, deps), conf);
  }
  // A failed conformance call (ok:false) is passed through untouched as well.
  const failed = JSON.stringify({ ok: false, data: null, warnings: [], error: { code: "IG_NOT_FOUND", message: "x" } });
  assert.equal(await addBundleGrounding(failed, bundle, { source_text: "x" }, deps), failed);
});

// ------------------------------------------------------------------------------------------- §2.4 merge (T6)

// Two combined fixtures, addressed by position ("combined#1", "combined#2"); their keys stay private.
for (const idx of [0, 1]) {
  const label = `combined#${idx + 1}`;
  test(`fhir_validate_bundle + grounding ${label}: flags, entry merge, provenance`, { skip: skipT6 }, async () => {
    const fx = FX[Object.keys(FX)[idx]];
    const out = JSON.parse(
      await addBundleGrounding(JSON.stringify(fx.conformance), fx.input.bundle, { source_text: fx.input.source_text, site_config: fx.input.site_config, grounding: fx.input.grounding }, refDeps),
    );
    assert.equal(out.ok, true);
    for (const [k, v] of Object.entries(fx.assert)) assert.equal(out.data[k], v, k);
    assert.equal(out.data.source, "builtin+grounding");
    assert.equal(out.data.valid, out.data.conformanceValid && out.data.groundingValid);
    assert.equal(out.data.entries.length, fx.conformance.data.entries.length);
    assert.ok(out.data.grounding.units_checked > 0);
    assert.equal(out.provenance.packageId, "tw.gov.mohw.twcore");
    assert.equal(out.provenance.toolVersion, TOOLS_VERSION.fhir_validate_bundle);
    assert.equal(out.provenance.groundingVersion, TOOLS_VERSION.fhir_check_grounding);
    assert.equal(out.provenance.sourceSha256, sourceSha256Prefix(fx.input.source_text));
    assert.match(out.provenance.lexiconSha256, /^[0-9a-f]{64}$/);
    for (const e of out.data.entries)
      for (const i of e.issues) if (i.source === "grounding") assert.match(i.message, /^\[grounding:G-[A-Z-]+\]/);
  });
}

test("fhir_validate_bundle + grounding (synthetic): flags, entry merge, provenance", async () => {
  for (const [input, groundingValid] of [[VALID, true], [FAB, false]] as const) {
    const conf = conformanceOf(input.bundle);
    const out = JSON.parse(
      await addBundleGrounding(JSON.stringify(conf), input.bundle, { source_text: input.source_text, site_config: input.site_config, evidence_map: input.evidence_map }, deps),
    );
    assert.equal(out.ok, true);
    assert.equal(out.data.source, "builtin+grounding");
    assert.equal(out.data.conformanceValid, true);
    assert.equal(out.data.groundingValid, groundingValid);
    assert.equal(out.data.valid, groundingValid);
    assert.equal(out.data.groundingMode, input.evidence_map ? "strict" : "auto");
    assert.equal(out.data.entries.length, input.bundle.entry.length);
    assert.ok(out.data.grounding.units_checked > 0);
    assert.equal(out.provenance.toolVersion, TOOLS_VERSION.fhir_validate_bundle);
    assert.equal(out.provenance.groundingVersion, TOOLS_VERSION.fhir_check_grounding);
    assert.equal(out.provenance.sourceSha256, sourceSha256Prefix(input.source_text));
    for (const e of out.data.entries)
      for (const i of e.issues) if (i.source === "grounding") assert.match(i.message, /^\[grounding:G-[A-Z-]+\]/);
  }
});

test("fhir_validate_resource + grounding: paths are reported against the resource", async () => {
  const fx = { input: FAB };
  // the invented type 2 diabetes Condition (not stated in the record)
  const cond = fx.input.bundle.entry.find((e: any) => e.resource.code?.coding?.[0]?.code === "E11.9").resource;
  const conf = JSON.stringify({ ok: true, data: { valid: true, profile: "Condition-twcore", source: "builtin", issues: [] }, warnings: [], provenance: PKG });
  const out = JSON.parse(await addResourceGrounding(conf, cond, { source_text: fx.input.source_text, site_config: fx.input.site_config }, deps));
  assert.equal(out.data.conformanceValid, true);
  assert.equal(typeof out.data.groundingValid, "boolean");
  assert.equal(out.data.valid, out.data.groundingValid);
  assert.equal(out.data.source, "builtin+grounding");
  assert.ok(out.data.issues.length > 0);
  for (const i of out.data.issues) assert.ok(i.path.startsWith("Condition"), i.path);
  assert.equal(out.provenance.tool, "fhir_validate_resource");
  // Evidence-map paths may be written against the resource; issues about them echo the path as given.
  const strict = JSON.parse(
    await addResourceGrounding(conf, cond, {
        source_text: fx.input.source_text,
        evidence_map: [{ path: "Condition.code", quote: "急性支氣管炎" }, { path: "nope.x", quote: "q" }],
        grounding_verbosity: "all",
      },
      deps,
    ),
  );
  assert.equal(strict.data.groundingMode, "strict");
  assert.ok(strict.data.issues.some((i: any) => i.rule === "G-EVIDENCE-PATH" && i.path === "nope.x"));
});

// ------------------------------------------------------------------------------------------- tools

test("fhir_check_grounding envelope: data shape, provenance (§2.0), argument errors", async () => {
  const fx = { input: FAB };
  const out = JSON.parse(await runCheckGroundingTool({ bundle: fx.input.bundle, source_text: fx.input.source_text, site_config: fx.input.site_config }, deps));
  assert.equal(out.ok, true);
  assert.equal(out.data.valid, false);
  assert.equal(out.data.source, "grounding");
  assert.equal(out.data.mode, "auto");
  assert.ok(Array.isArray(out.data.entries) && out.data.entries.length === 4);
  const p = out.provenance;
  assert.deepEqual(
    [p.packageId, p.version, p.fhirVersion, p.source, p.tool, p.toolVersion],
    ["tw.gov.mohw.twcore", "1.0.0", "4.0.1", "ig", "fhir_check_grounding", TOOLS_VERSION.fhir_check_grounding],
  );
  assert.match(p.lexiconVersion, /^tw-lexicon /);
  assert.equal(p.sourceSha256, sourceSha256Prefix(fx.input.source_text));
  assert.equal(typeof p.terminologyVersion, "string");
  // verbosity=warnings (default) never returns information issues
  for (const e of out.data.entries) for (const i of e.issues) assert.notEqual(i.severity, "information");
  assert.equal(JSON.parse(await runCheckGroundingTool({ bundle: { resourceType: "Patient" }, source_text: "x" }, deps)).error.code, "INVALID_ARGUMENT");
  // Unknown IG: grounding still runs, the provenance keeps the requested ids and a warning says so.
  const noIg = JSON.parse(
    await runCheckGroundingTool({ bundle: fx.input.bundle, source_text: fx.input.source_text, package_id: "x.y", version: "9" }, { ...deps, packageProvenance: async () => null }),
  );
  assert.equal(noIg.ok, true);
  assert.equal(noIg.provenance.packageId, "x.y");
  assert.equal(noIg.warnings.length, 1);
});

test("fhir_check_completeness envelope (playground example: insufficient_information)", async () => {
  const input = COMPLETENESS_INSUFFICIENT_INPUT as any;
  const out = JSON.parse(await runCheckCompletenessTool(input, deps));
  assert.equal(out.ok, true);
  assert.equal(out.data.status, "insufficient_information");
  assert.deepEqual(out.data.missing, ["HbA1c 數值", "Metformin 劑量", "Metformin 頻次"]);
  assert.equal(out.provenance.tool, "fhir_check_completeness");
  assert.equal(out.provenance.toolVersion, TOOLS_VERSION.fhir_check_completeness);
  assert.equal(out.provenance.sourceSha256, sourceSha256Prefix(input.source_text));
});

test("tool descriptions classify as V under the CARVE role rules (reference/check_roles.py)", () => {
  // R desc patterns and X name/desc patterns from config/tool_roles.rules.yaml (MCP_GROUNDING_SPEC §3.2).
  const forbidden = [
    /search/i, /semantic/i, /keyword/i, /recommend profile/i, /expand value set/i, /skeleton/i,
    /status/i, /health/i, /drug/i, /medication/i, /interpret/i, /infer/i, /conflict/i, /create/i, /update/i, /delete/i,
  ];
  for (const [name, desc] of Object.entries(TOOL_DESCRIPTIONS)) {
    for (const re of forbidden) {
      assert.ok(!re.test(desc), `${name} description matches ${re}`);
      assert.ok(!re.test(name), `${name} name matches ${re}`);
    }
    assert.match(name, /check|validate/, `${name} must hit a V name pattern`);
  }
});

// ------------------------------------------------------------------------------------------- privacy (§6.7)

test("privacy: record text never reaches stderr/console — tools, engine debug logs, failures, malformed HTTP bodies", async () => {
  const SENTINEL = "機密病歷內容SENTINEL7f3a";
  const fx = { input: FAB, conformance: conformanceOf(FAB.bundle) };
  const text = `${fx.input.source_text}\n${SENTINEL}`;
  const failingTerminology = {
    version: () => "x",
    lookup: async () => {
      throw new Error(`lookup failed for ${SENTINEL}`);
    },
  };
  configureLogLevel("DEBUG");
  let httpStatus = 0;
  let httpBody = "";
  const captured = await captureOutput(async () => {
    await runCheckGroundingTool({ bundle: fx.input.bundle, source_text: text, site_config: SENTINEL }, deps);
    await addBundleGrounding(JSON.stringify(fx.conformance), fx.input.bundle, { source_text: text, site_config: SENTINEL }, deps);
    await runCheckCompletenessTool({ targets: [{ resourceType: "Condition" }], source_text: text, site_config: SENTINEL }, deps);
    // Engine failure path: logged by error class only.
    const failed = JSON.parse(await runCheckGroundingTool({ bundle: fx.input.bundle, source_text: text }, { ...deps, terminology: failingTerminology }));
    assert.equal(failed.error.code, "GROUNDING_FAILED");
    assert.ok(!JSON.stringify(failed).includes(SENTINEL));
    // Malformed JSON body: V8's parse error quotes the body; the final handler must not log it.
    const app = express();
    app.use(express.json({ limit: "4mb" }));
    app.post("/tools/:name", (_req, res) => void res.json({ ok: true }));
    app.use(finalErrorHandler);
    const server = app.listen(0);
    try {
      const port = (server.address() as AddressInfo).port;
      const r = await fetch(`http://127.0.0.1:${port}/tools/fhir_check_grounding`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: `{"source_text": "${SENTINEL} \\q broken`,
      });
      httpStatus = r.status;
      httpBody = await r.text();
    } finally {
      server.close();
    }
  });
  configureLogLevel("INFO");
  assert.equal(httpStatus, 400);
  assert.ok(!httpBody.includes(SENTINEL));
  assert.ok(captured.includes(sourceSha256Prefix(text)), "debug log should carry the sha256 prefix");
  assert.ok(captured.includes("request body rejected"));
  assert.ok(!captured.includes(SENTINEL), "record text leaked into logs");
  for (const line of fx.input.source_text.split("\n").map((x: string) => x.trim()).filter((x: string) => x.length >= 6))
    assert.ok(!captured.includes(line), "record text leaked into logs");
});
