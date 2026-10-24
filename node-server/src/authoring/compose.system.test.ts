/**
 * composeResource v1.2 Coding.system correction (compose.ts `correctSystems`) over a synthetic
 * profile and in-memory collaborators: a ValueSet URL (or its /CodeSystem/ twin) used as a system,
 * and a system URL that resolves to nothing, corrected from the element's bound ValueSets
 * (own binding and additional bindings). Ambiguous / not-found cases are never guessed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { el, sd } from "../fhirTestKit.test.js";
import type { ComposeDeps, ExpandedCoding, SystemResolution } from "./deps.js";
import { composeResource, type ComposeOutput } from "./compose.js";

type El = Record<string, any>;
const EX = "http://example.org/fhir/";
const PROFILE = `${EX}StructureDefinition/SysObs`;
const LOINC = "http://loinc.org";
const CS_A = `${EX}CodeSystem/route-a`;
const CS_C = `${EX}CodeSystem/route-c`;
const CS_D = `${EX}CodeSystem/route-d`;
const VS_DOC = `${EX}ValueSet/doc-types`;
const VS_DOC_FILTER = `${EX}ValueSet/doc-types-filter`;
const VS_METHOD = `${EX}ValueSet/method`;
const VS_METHOD_EXTRA = `${EX}ValueSet/method-extra`;
const VS_AMBIGUOUS = `${EX}ValueSet/ambiguous`;
const VS_SELF = `${EX}ValueSet/self`;
const UNKNOWN = "http://terminology.hl7.org/CodeSystem/route";
const SELF_URL = `${EX}CodeSystem/self-unknown`;
const ADDITIONAL = "http://hl7.org/fhir/tools/StructureDefinition/additional-binding";

const SYS_PROFILE = sd(PROFILE, "Observation", "resource", [
  el("Observation", 0, "*"),
  el("Observation.id", 0, "1", ["string"]),
  el("Observation.status", 1, "1", ["code"]),
  el("Observation.code", 1, "1", ["CodeableConcept"]),
  el("Observation.method", 0, "1", ["CodeableConcept"], {
    binding: { strength: "extensible", valueSet: VS_METHOD },
    extension: [{ url: ADDITIONAL, extension: [{ url: "purpose", valueCode: "candidate" }, { url: "valueSet", valueCanonical: VS_METHOD_EXTRA }] }],
  }),
  el("Observation.bodySite", 0, "1", ["CodeableConcept"], { binding: { strength: "extensible", valueSet: VS_AMBIGUOUS } }),
  el("Observation.interpretation", 0, "*", ["CodeableConcept"], { binding: { strength: "extensible", valueSet: VS_SELF } }),
]);

const EXP: Record<string, ExpandedCoding[]> = {
  [VS_DOC]: [
    { system: LOINC, code: "11488-4", display: "Consult note" },
    { system: LOINC, code: "18842-5", display: "Discharge summary" },
  ],
  [VS_AMBIGUOUS]: [
    { system: CS_A, code: "X1", display: "Site one" },
    { system: CS_C, code: "X1", display: "Site one (C)" },
  ],
  [VS_METHOD]: [
    { system: CS_A, code: "PO", display: "Oral" },
    { system: CS_A, code: "IV", display: "Intravenous" },
  ],
  [VS_METHOD_EXTRA]: [{ system: CS_D, code: "SL", display: "Sublingual" }],
  [VS_SELF]: [{ system: CS_A, code: "PO", display: "Oral" }],
};
const COMPOSE_SYSTEMS: Record<string, string[]> = {
  [VS_DOC_FILTER]: [LOINC],
  [VS_SELF]: [CS_A, SELF_URL],
};
const CODES: Record<string, string[]> = { [LOINC]: ["11488-4", "18842-5", "8480-6"], [CS_A]: ["PO", "IV", "X1"], [CS_C]: ["X1"], [CS_D]: ["SL"] };

function deps(): ComposeDeps {
  return {
    async resolveProfile(id) {
      return id === PROFILE || id === "SysObs" ? { sd: SYS_PROFILE, canonical: PROFILE, id: "SysObs" } : null;
    },
    async expandValueSet(url, limit) {
      const c = EXP[url.split("|")[0]];
      return c ? { codings: c.slice(0, limit), total: c.length, truncated: c.length > limit } : null;
    },
    async valueSetContains(url, system, code) {
      const c = EXP[url.split("|")[0]];
      if (!c) return undefined; // filter-defined: not decidable locally
      return c.some((x) => x.code === code && (system === null || x.system === system));
    },
    async resolveSystem(url): Promise<SystemResolution> {
      if (EXP[url] || COMPOSE_SYSTEMS[url]) return { kind: "valueset", valueSet: url };
      if (url === `${EX}CodeSystem/doc-types`) return { kind: "valueset", valueSet: VS_DOC };
      if (url === UNKNOWN || url === SELF_URL) return { kind: "unknown", codeSystemTwin: null };
      return { kind: "codesystem" };
    },
    async valueSetSystems(url) {
      return COMPOSE_SYSTEMS[url] ?? [...new Set((EXP[url] ?? []).map((c) => c.system!))];
    },
    async codeInSystem(system, code) {
      const c = CODES[system];
      return c ? c.includes(code) : undefined;
    },
  };
}

const CTX = { contextId: "0123456789abcdef0123456789abcdef", knownKeys: new Set<string>() };

async function compose(fields: Record<string, unknown>): Promise<ComposeOutput> {
  return composeResource({ key: "k1", profile: PROFILE, fields: { status: "final", ...fields } }, deps(), CTX);
}

const coding = (out: ComposeOutput, field: string): El => out.resource[field].coding[0];

// --------------------------------------------------------------------------- //
// R1: a ValueSet URL as Coding.system
// --------------------------------------------------------------------------- //

test("R1: a ValueSet URL as system → the code's CodeSystem in that ValueSet (provenance lookup, note)", async () => {
  const out = await compose({ code: { system: VS_DOC, code: "11488-4", display: "Consult note" } });
  assert.deepEqual(out.errors, []);
  assert.deepEqual(coding(out, "code"), { system: LOINC, code: "11488-4", display: "Consult note" });
  assert.equal(out.provenance["Observation.code.coding[0].system"], "lookup");
  assert.deepEqual(out.notes, [`system corrected for code (code.coding[0]): '${VS_DOC}' is a ValueSet; code '11488-4' belongs to ${LOINC}`]);
});

test("R1: the /CodeSystem/ twin of a ValueSet URL is corrected the same way", async () => {
  const out = await compose({ code: { system: `${EX}CodeSystem/doc-types`, code: "18842-5" } });
  assert.equal(coding(out, "code").system, LOINC);
  assert.match(out.notes[0], /is a ValueSet \(its ValueSet twin .*doc-types\); code '18842-5' belongs to http:\/\/loinc\.org/);
});

test("R1: membership not decidable locally (filter ValueSet) → the only compose CodeSystem holding the code", async () => {
  const out = await compose({ code: { system: VS_DOC_FILTER, code: "11488-4" } });
  assert.equal(coding(out, "code").system, LOINC);
  assert.match(out.notes[0], /membership not decidable locally/);
  // a code no CodeSystem of the ValueSet holds is left as written
  const miss = await compose({ code: { system: VS_DOC_FILTER, code: "0000-0" } });
  assert.equal(coding(miss, "code").system, VS_DOC_FILTER);
  assert.deepEqual(miss.notes, []);
});

test("R1: the code under several CodeSystems of the ValueSet → error with candidates, nothing changed", async () => {
  const out = await compose({ code: { system: VS_AMBIGUOUS, code: "X1" } });
  assert.equal(coding(out, "code").system, VS_AMBIGUOUS);
  assert.equal(out.errors.length, 1);
  assert.equal(out.errors[0].path, "Observation.code.coding[0].system");
  assert.equal(out.errors[0].field, "code");
  assert.match(out.errors[0].message, /is a ValueSet.*several CodeSystems/);
  assert.deepEqual(
    (out.errors[0].candidates as El[]).map((c) => c.system),
    [CS_A, CS_C],
  );
  assert.deepEqual(out.notes, []);
});

test("R1: a code that is not in the ValueSet → unchanged (validator reports it with suggestions)", async () => {
  const out = await compose({ code: { system: VS_DOC, code: "8480-6" } });
  assert.deepEqual(coding(out, "code"), { system: VS_DOC, code: "8480-6" });
  assert.deepEqual(out.errors, []);
  assert.deepEqual(out.notes, []);
  assert.equal(out.provenance["Observation.code.coding[0].system"], undefined);
});

// --------------------------------------------------------------------------- //
// R2: a system URL that resolves to nothing
// --------------------------------------------------------------------------- //

test("R2: unknown system URL, code in exactly one CodeSystem of the bound ValueSets → corrected", async () => {
  const out = await compose({ method: { system: UNKNOWN, code: "PO" } });
  assert.deepEqual(coding(out, "method"), { system: CS_A, code: "PO" });
  assert.equal(out.provenance["Observation.method.coding[0].system"], "lookup");
  assert.deepEqual(out.notes, [`system corrected for method (method.coding[0]): '${UNKNOWN}' is not a known CodeSystem or ValueSet; code 'PO' belongs to ${CS_A} (the element's bound ValueSet method)`]);
  // an additional binding's ValueSet counts too
  const extra = await compose({ method: { system: UNKNOWN, code: "SL" } });
  assert.equal(coding(extra, "method").system, CS_D);
  assert.match(extra.notes[0], /bound ValueSet method-extra/);
});

test("R2: case-insensitive code match (unique) and exact display match (unique) are corrected with the real code", async () => {
  const ci = await compose({ method: { system: UNKNOWN, code: "po" } });
  assert.deepEqual(coding(ci, "method"), { system: CS_A, code: "PO" });
  assert.equal(ci.provenance["Observation.method.coding[0].code"], "lookup");
  assert.match(ci.notes[0], /code 'po' is 'PO' of/);
  const byDisplay = await compose({ method: { system: UNKNOWN, code: "oral", display: "Intravenous" } });
  assert.deepEqual(coding(byDisplay, "method"), { system: CS_A, code: "IV", display: "Intravenous" });
  assert.match(byDisplay.notes[0], /display 'Intravenous' is .*#IV/);
  // a display that is not an exact display of the bound ValueSets → unchanged
  const near = await compose({ method: { system: UNKNOWN, code: "oral", display: "Oral route" } });
  assert.equal(coding(near, "method").system, UNKNOWN);
  assert.deepEqual(near.notes, []);
});

test("R2: ambiguous (several CodeSystems hold the code) or not found → unchanged, no error from the composer", async () => {
  const amb = await compose({ bodySite: { system: UNKNOWN, code: "X1" } });
  assert.deepEqual(coding(amb, "bodySite"), { system: UNKNOWN, code: "X1" });
  assert.deepEqual(amb.notes, []);
  assert.deepEqual(amb.errors, []);
  const none = await compose({ method: { system: UNKNOWN, code: "ZZ" } });
  assert.deepEqual(coding(none, "method"), { system: UNKNOWN, code: "ZZ" });
  assert.deepEqual(none.notes, []);
});

test("R2: a binding that draws from the written URL itself, known CodeSystems and pinned codings are left alone", async () => {
  const self = await compose({ interpretation: { system: SELF_URL, code: "PO" } });
  assert.equal(self.resource.interpretation[0].coding[0].system, SELF_URL);
  assert.deepEqual(self.notes, []);
  const known = await compose({ method: { system: CS_C, code: "PO" } });
  assert.equal(coding(known, "method").system, CS_C);
  assert.deepEqual(known.notes, []);
});

test("without resolveSystem the composer changes no system", async () => {
  const d = deps();
  delete d.resolveSystem;
  const out = await composeResource({ key: "k1", profile: PROFILE, fields: { status: "final", code: { system: VS_DOC, code: "11488-4" } } }, d, CTX);
  assert.equal(coding(out, "code").system, VS_DOC);
  assert.deepEqual(out.notes, []);
});
