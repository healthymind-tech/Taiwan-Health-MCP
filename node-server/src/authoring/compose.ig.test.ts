/**
 * composeResource against a real IG: TW Core 1.0.0 StructureDefinitions read from the local
 * package cache (fhir-code/twcoreig/v1.0.0/package.tgz), terminology (expansions, displays,
 * normalize) and the validator from the local server's read-only tools (POST /tools/<name>).
 *
 * Skipped (never failed) when the package or the server is absent:
 *   TWCORE_TGZ               path of the TW Core package.tgz (default fhir-code/twcoreig/v1.0.0/package.tgz)
 *   FHIR_R4_CORE_DIR         an unpacked hl7.fhir.r4.core#4.0.1/package dir (optional: datatype definitions)
 *   AUTHORING_IG_TEST_SERVER base URL of the MCP server (default http://127.0.0.1:8080); AUTHORING_IG_TEST=0 disables
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { gunzipSync, strFromU8 } from "fflate";
import { composeResource, keyToUrn, type ComposeOutput } from "./compose.js";
import type { ComposeDeps, ExpandedCoding, NormalizeCandidate } from "./deps.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TGZ = process.env.TWCORE_TGZ ?? path.resolve(HERE, "../../../fhir-code/twcoreig/v1.0.0/package.tgz");
const CORE_DIR = process.env.FHIR_R4_CORE_DIR ?? path.join(os.homedir(), ".fhir", "packages", "hl7.fhir.r4.core#4.0.1", "package");
const SERVER = process.env.AUTHORING_IG_TEST_SERVER ?? "http://127.0.0.1:8080";
const PKG = { package_id: "tw.gov.mohw.twcore", version: "1.0.0" };
const TW = "https://twcore.mohw.gov.tw/ig/twcore/StructureDefinition/";
const CORE = "http://hl7.org/fhir/StructureDefinition/";
const LOINC = "http://loinc.org";
const CTX_ID = "a3f1c2d4e5b60718293a4b5c6d7e8f90";

// ---- package reader -------------------------------------------------------------

function untar(buf: Uint8Array): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  let off = 0;
  while (off + 512 <= buf.length) {
    const head = buf.subarray(off, off + 512);
    const name = strFromU8(head.subarray(0, 100)).replace(/\0.*$/s, "");
    if (!name) break;
    const prefix = strFromU8(head.subarray(345, 500)).replace(/\0.*$/s, "");
    const size = parseInt(strFromU8(head.subarray(124, 136)).replace(/\0.*$/s, "").trim() || "0", 8);
    const type = String.fromCharCode(head[156]);
    const full = prefix ? `${prefix}/${name}` : name;
    if (type === "0" || type === "\0") out.set(full, buf.subarray(off + 512, off + 512 + size));
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

interface Pkg {
  byUrl: Map<string, Record<string, any>>;
  byId: Map<string, Record<string, any>>;
}

function loadPackage(): Pkg | null {
  if (!fs.existsSync(TGZ)) return null;
  const files = untar(gunzipSync(new Uint8Array(fs.readFileSync(TGZ))));
  const byUrl = new Map<string, Record<string, any>>();
  const byId = new Map<string, Record<string, any>>();
  for (const [name, data] of files) {
    if (!/^package\/StructureDefinition-[^/]+\.json$/.test(name)) continue;
    try {
      const sd = JSON.parse(strFromU8(data));
      if (sd.resourceType !== "StructureDefinition" || !sd.url) continue;
      byUrl.set(sd.url, sd);
      if (sd.id) byId.set(String(sd.id), sd);
    } catch {
      // not JSON
    }
  }
  return { byUrl, byId };
}

// ---- live server ----------------------------------------------------------------

async function tool<T = any>(name: string, args: Record<string, unknown>): Promise<T> {
  const r = await fetch(`${SERVER}/tools/${name}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(args), signal: AbortSignal.timeout(60_000) });
  const text = await r.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${name}: non-JSON response (${r.status}): ${text.slice(0, 200)}`);
  }
}

async function serverUp(): Promise<boolean> {
  if (process.env.AUTHORING_IG_TEST === "0") return false;
  try {
    const r = await fetch(`${SERVER}/openapi.json`, { signal: AbortSignal.timeout(2500) });
    if (!r.ok) return false;
    const igs = await tool("fhir_list_igs", { compact: true });
    return !!igs?.ok && JSON.stringify(igs.data).includes(`${PKG.package_id}#${PKG.version}`);
  } catch {
    return false;
  }
}

function liveDeps(pkg: Pkg): ComposeDeps {
  const coreCache = new Map<string, Record<string, any> | null>();
  const unversioned = (u: string): string => u.split("|")[0];
  return {
    async resolveProfile(identifier) {
      const url = unversioned(identifier.trim());
      const sd = pkg.byUrl.get(url) ?? pkg.byId.get(url) ?? null;
      return sd ? { sd, canonical: sd.url, id: sd.id ?? null } : null;
    },
    async fetchStructureDefinition(url) {
      const u = unversioned(url);
      const own = pkg.byUrl.get(u);
      if (own) return own;
      if (!u.startsWith(CORE)) return null;
      if (!coreCache.has(u)) {
        const file = path.join(CORE_DIR, `StructureDefinition-${u.slice(CORE.length)}.json`);
        coreCache.set(u, fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null);
      }
      return coreCache.get(u) ?? null;
    },
    async expandValueSet(url, limit) {
      const env = await tool("fhir_expand_valueset", { identifier: unversioned(url), ...PKG, limit });
      if (!env?.ok || !env.data) return null;
      const codings: ExpandedCoding[] = (env.data.codings || []).map((c: any) => ({ system: c.system ?? null, code: String(c.code), display: c.display ?? null }));
      return { codings, total: env.data.total ?? codings.length, truncated: !!env.data.truncated };
    },
    async lookupDisplay(system, code) {
      const env = await tool("fhir_lookup_code", { system, code, ...PKG });
      return env?.ok && env.data?.found && typeof env.data.display === "string" ? env.data.display : null;
    },
    async normalize(text, target, limit) {
      const env = await tool("fhir_normalize_code", { text, value_set: target.valueSet ? unversioned(target.valueSet) : null, system: target.system ? unversioned(target.system) : null, ...PKG, limit });
      const cands: any[] = env?.ok && env.data && Array.isArray(env.data.candidates) ? env.data.candidates : [];
      return cands.filter((c) => c && typeof c.code === "string").map((c): NormalizeCandidate => ({ system: c.system ?? null, code: c.code, display: c.display ?? null, ...(c.exact ? { exact: true } : {}), ...(typeof c.score === "number" ? { score: c.score } : {}) }));
    },
    async valueSetContains(url, system, code) {
      if (!system) return undefined;
      const env = await tool("fhir_validate_code", { system, code, value_set: unversioned(url), ...PKG });
      if (!env?.ok || !env.data) return undefined;
      return env.data.result === "valid" ? true : env.data.result === "invalid" ? false : undefined;
    },
  };
}

function errorIssues(data: any): Array<Record<string, unknown>> {
  return ((data?.issues || []) as Array<Record<string, unknown>>).filter((i) => i.severity === "error" || i.severity === "fatal");
}

function brief(out: ComposeOutput): string {
  return JSON.stringify({ errors: out.errors, missing: out.missing }, null, 1);
}

// ---- the test ----------------------------------------------------------------------

const pkg = loadPackage();
const up = pkg ? await serverUp() : false;
const skip = !pkg ? `TW Core package not found at ${TGZ}` : !up ? `MCP server with ${PKG.package_id}#${PKG.version} not reachable at ${SERVER} (read-only tools)` : false;

test("TW Core 1.0.0: Patient / lab result / blood pressure / MedicationRequest composed from values validate with the real validator", { skip, timeout: 300_000 }, async (t) => {
  const deps = liveDeps(pkg!);
  const ctx = { contextId: CTX_ID, knownKeys: new Set<string>(), timezone: "+08:00" };
  const timings: Record<string, number> = {};
  const composed: Record<string, ComposeOutput> = {};
  const run = async (key: string, profile: string, fields: Record<string, unknown>): Promise<ComposeOutput> => {
    const t0 = performance.now();
    const out = await composeResource({ key, profile, fields }, deps, ctx);
    timings[key] = Math.round(performance.now() - t0);
    composed[key] = out;
    return out;
  };

  await t.test("Patient-twcore", async () => {
    const out = await run("pat", `${TW}Patient-twcore`, {
      "identifier:medicalRecord": { value: "MR-000123", system: "https://hospital.example.tw/mrn" },
      "identifier:idCardNumber": { value: "A123456789" },
      "name:official": { family: "王", given: ["小明"] },
      gender: "male",
      birthDate: "民國79年3月2日",
      telecom: { system: "phone", value: "02-2345-6789" },
      address: { text: "台北市中正區中山南路1號" },
    });
    assert.deepEqual(out.errors, [], brief(out));
    assert.deepEqual(out.missing, [], brief(out));
    const r = out.resource;
    assert.deepEqual(r.meta, { profile: [`${TW}Patient-twcore`] });
    assert.equal(r.birthDate, "1990-03-02");
    assert.equal(r.identifier[0].type.coding[0].code, "MR");
    assert.equal(r.identifier[0].use, "official");
    assert.equal(r.identifier[1].system, "http://www.moi.gov.tw", "the id-card slice's patterned system is supplied");
    assert.equal(r.identifier[1].type.coding[0].code, "NNxxx");
    assert.equal(r.name[0].use, "official");
    assert.equal(r.active, undefined, "Patient.active is optional: never auto-filled (defaults only on required elements)");
    assert.equal(out.provenance["Patient.identifier[1].system"], "fixed");
    assert.equal(out.provenance["Patient.active"], undefined);
    const env = await tool("fhir_validate_resource", { resource: r, profile: `${TW}Patient-twcore`, ...PKG });
    assert.ok(env.ok, JSON.stringify(env).slice(0, 500));
    assert.deepEqual(errorIssues(env.data), [], JSON.stringify(env.data.issues, null, 1));
  });

  await t.test("Observation-laboratoryResult-twcore", async () => {
    const out = await run("glu", `${TW}Observation-laboratoryResult-twcore`, {
      status: "final",
      code: { system: LOINC, code: "2345-7" },
      subject: { ref: "pat" },
      effective: "115/06/15 08:30",
      value: "95 mg/dL",
      referenceRange: { low: "70 mg/dL", high: "100 mg/dL" },
    });
    assert.deepEqual(out.errors, [], brief(out));
    assert.deepEqual(out.missing, [], brief(out));
    const r = out.resource;
    assert.deepEqual(r.category, [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category", code: "laboratory", display: "Laboratory" }] }]);
    assert.equal(out.provenance["Observation.category[0]"], "fixed");
    assert.equal(r.effectiveDateTime, "2026-06-15T08:30:00+08:00");
    assert.deepEqual(r.valueQuantity, { value: 95, unit: "mg/dL", system: "http://unitsofmeasure.org", code: "mg/dL" });
    assert.equal(r.code.coding[0].display, "Glucose [Mass/volume] in Serum or Plasma");
    assert.equal(r.subject.reference, keyToUrn(CTX_ID, "pat"));
    assert.deepEqual(out.refs.pending, ["pat"]);
  });

  await t.test("Observation-bloodPressure-twcore", async () => {
    const out = await run("bp", `${TW}Observation-bloodPressure-twcore`, {
      status: "final",
      subject: { ref: "pat" },
      effective: "2026-06-15T09:00+08:00",
      component: [
        { code: { system: LOINC, code: "8480-6" }, value: "120 mmHg" },
        { code: { system: LOINC, code: "8462-4" }, value: { value: 80, unit: "mmHg" } },
      ],
    });
    assert.deepEqual(out.errors, [], brief(out));
    assert.deepEqual(out.missing, [], brief(out));
    const r = out.resource;
    assert.equal(r.category[0].coding[0].code, "vital-signs");
    assert.equal(r.code.coding[0].code, "85354-9");
    assert.deepEqual(r.component[0].valueQuantity, { value: 120, unit: "mmHg", system: "http://unitsofmeasure.org", code: "mm[Hg]" });
    assert.deepEqual(r.component[1].valueQuantity, { value: 80, unit: "mmHg", system: "http://unitsofmeasure.org", code: "mm[Hg]" });
    assert.equal(r.component[0].code.coding[0].display, "Systolic blood pressure");
  });

  await t.test("MedicationRequest-twcore", async () => {
    const out = await run("rx", `${TW}MedicationRequest-twcore`, {
      status: "active",
      intent: "order",
      medication: { text: "Amoxicillin 500 mg capsule" },
      subject: { ref: "pat" },
      authoredOn: "115/06/15",
      dosageInstruction: { text: "500 mg 口服 每天三次飯後 3天", route: "口服", dose: "500 mg", frequency: "每天三次飯後", period: "3 days" },
    });
    assert.deepEqual(out.errors, [], brief(out));
    assert.deepEqual(out.missing, [], brief(out));
    const r = out.resource;
    assert.deepEqual(r.medicationCodeableConcept, { text: "Amoxicillin 500 mg capsule" });
    const d = r.dosageInstruction[0];
    assert.deepEqual(d.timing.repeat, { frequency: 3, period: 1, periodUnit: "d", when: ["PC"], boundsDuration: { value: 3, unit: "days", system: "http://unitsofmeasure.org", code: "d" } });
    assert.equal(d.timing.code?.coding?.[0]?.code, "TID", "Timing.code from the profile's bound frequency ValueSet");
    assert.deepEqual(d.doseAndRate, [{ doseQuantity: { value: 500, unit: "mg", system: "http://unitsofmeasure.org", code: "mg" } }]);
    assert.deepEqual(d.route, { coding: [{ code: "PO", system: "https://twcore.mohw.gov.tw/ig/twcore/CodeSystem/medication-path-tw", display: "口服" }] }, "the label is a display of the bound route ValueSet → its coding (no redundant text)");
    assert.equal(out.provenance["MedicationRequest.dosageInstruction[0].route.coding[0]"], "lookup");
    assert.equal(r.authoredOn, "2026-06-15");
  });

  await t.test("the four resources assembled with the composer's urns validate as a Bundle: 0 errors", async () => {
    const entries = ["pat", "glu", "bp", "rx"].map((key) => ({ fullUrl: keyToUrn(CTX_ID, key), resource: composed[key].resource }));
    const bundle = { resourceType: "Bundle", type: "collection", entry: entries };
    const env = await tool("fhir_validate_bundle", { bundle, ...PKG, normalize_ids: false });
    assert.ok(env.ok, JSON.stringify(env).slice(0, 500));
    const errors = errorIssues(env.data);
    assert.deepEqual(errors, [], JSON.stringify(errors, null, 1));
    const warnings = (env.data.issues || []).filter((i: any) => i.severity === "warning");
    t.diagnostic(`bundle validation: valid=${env.data.valid} errors=0 warnings=${warnings.length} information=${(env.data.issues || []).length - warnings.length}; compose ms ${JSON.stringify(timings)}`);
  });

  await t.test("the same fields compose identically a second time (warm), under 200 ms", async () => {
    const t0 = performance.now();
    const again = await composeResource({ key: "bp", profile: `${TW}Observation-bloodPressure-twcore`, fields: { status: "final", subject: { ref: "pat" }, effective: "2026-06-15T09:00+08:00", component: [{ code: { system: LOINC, code: "8480-6" }, value: "120 mmHg" }, { code: { system: LOINC, code: "8462-4" }, value: { value: 80, unit: "mmHg" } }] } }, deps, ctx);
    const ms = performance.now() - t0;
    assert.deepEqual(JSON.parse(JSON.stringify(again.resource)), JSON.parse(JSON.stringify(composed.bp.resource)));
    t.diagnostic(`warm compose (live terminology round-trips included): ${ms.toFixed(0)} ms`);
  });
});
